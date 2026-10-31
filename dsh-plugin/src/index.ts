import { normalizeConfig } from './config.js';
import { combineLoggers, createDebugLog, resolveDebugLogPath } from './debug-log.js';
// 答案口径段（task-15）：把 MemoryCore 单一源的作答纪律接到 system prompt。
import { GUIDANCE_TEXT, GUIDANCE_VERSION } from './guidance.js';
import { sessionKey } from './ids.js';
import { compressHeadPack, HeadPack } from './head-pack.js';
import { applyIdentity, identityStateOf, resolveIdentityFromUserKey } from './identity.js';
import { MemoryClient, type ConversationMessage, type MemoryIdentity, type RecallBlockResult, type TurnEndPayload } from './memory-client.js';
import { Outbox } from './outbox.js';
import { recallKey, RECALL_INFLIGHT_MAX_ENTRIES, RecallCache, RecallInflight } from './recall-cache.js';
import { extractSoul, measureSoul, recallBlockText, renderSoulBlock } from './recall-source.js';
// One runner for the head pack and one for the volatile block: every segment
// lives in src/segments/*.ts and self-registers (see src/segments/index.ts), so
// this file does not grow when a new data source is added.
import { runHeadPackSegments, runVolatileSegments, segmentSummary, type SegmentDeps } from './segments/index.js';
// The L2 segment owns its own status line (task-103): the mount line and the
// head-pack debug line both quote it, so a scene index that failed reads as
// `l2=fail:http_404` instead of silently emptying half the head pack.
import { l2StatusForDebug, l2StatusSummary } from './segments/l2.js';
import { SkillClient } from './skill-client.js';
// Tool surfaces are modules too: src/tools/*.ts self-register, and the loop in
// section 4 registers whatever the config leaves enabled.
import { enabledToolModules } from './tools/index.js';
import type { AgememContext, LoggerLike, ToolDefinitionShape, ToolsService } from './types.js';
import { extractTurnClaim, formatVolatileBlock, installVolatile, type VolatileTurnContext } from './volatile.js';
import { installWriteback, type SkillWritebackPayload } from './writeback.js';

/**
 * dsh native memory plugin (@tdb/agemem-dsh).
 *
 * Scope (v0): three host seams, each fail-open, plus one tool.
 * 1. Session head pack  — a stable system-prompt section, fetched once and
 *    frozen, invalidated on the host's `compaction/start` / `compaction/end`
 *    events (refreshMs is only the fallback). Never blocks prompt assembly.
 * 2. Per-turn volatile  — one appended plugin message per turn (tail only, so
 *    the prompt prefix stays byte-stable for the provider's KV cache).
 * 3. Turn writeback     — collected from session events, queued to a local
 *    outbox on turn close, delivered fire-and-forget (never on the turn path).
 *
 * Canonical host facts behind these choices: docs/ops/dsh-plugin-probe-report.md.
 * Core contract: the v3 data plane (core/read, atomic/search, scenario/ls,
 * conversation/add) — the `/v3/dsh/*` endpoints in the spec have no
 * implementation in MemoryCore and are not used anywhere below.
 */

export const name = 'tdb-agemem-dsh';

/**
 * Only `systemPrompt` is injected: Cordis 4 treats every injected service as
 * required, and headless compositions may not provide `credentials` or
 * `tools`. Those two are read through `ctx.reflect.get`, which never throws.
 */
export const inject = ['systemPrompt'];

/** Host section order for the deployment persona suffix (this build: 10200). */
const DEPLOYMENT_PERSONA_SUFFIX_ORDER = 10200;

/**
 * Mount-time budget for identity resolution (three sequential metadata calls).
 * Mount is one-shot, not a turn, so a short stall is acceptable — but never a
 * long one: an unreachable core would otherwise delay the whole host start.
 */
const IDENTITY_RESOLUTION_BUDGET_MS = 4000;

/** Resolve with a deadline; a stalled promise becomes `undefined`, never a hang. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    // Do not keep the process alive for a deadline that no longer matters.
    (timer as unknown as { unref?: () => void }).unref?.();
    const done = (value: T | undefined): void => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(done, () => done(undefined));
  });
}

// composeHeadPack lives in its own module so the segment modules can use it
// without an import cycle; re-exported here because the tests and the docs
// reference it through the plugin entry.
import { composeHeadPack } from './head-pack-compose.js';
export { composeHeadPack, personaListsPath } from './head-pack-compose.js';
export type { ComposeHeadPackOptions } from './head-pack-compose.js';

/** One volatile-block fetch: the text plus what produced it (for the debug line). */
interface VolatileBlock {
  text: string;
  source: 'recall' | 'atomic' | 'none';
  entriesKept: number;
  /** Chars of `<soul-*>` block inside `text` (0 = no soul this turn). */
  soulChars: number;
  /** Opaque core version of the soul, when the core sent one. */
  soulVersion?: string;
  /** Characters contributed by the capability segments (wiki / knowledge). */
  extrasChars?: number;
}

/**
 * Resolve on `promise` or after `timeoutMs`, whichever comes first. Used for
 * the optional capability segments: their round trips are nice-to-have, and a
 * slow knowledge list must never hold agent/pre-step past the volatile budget
 * (the host would drop the WHOLE block, memories included).
 */
async function withDeadlineMs<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
        // Do not keep the host process alive for a segment deadline.
        if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The core's soul version (`meta.soulVersion`), verbatim, never the soul text. */
function soulVersionOf(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.soulVersion;
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Text blocks in a host message (blocks or a plain string). */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}



function getService<T>(ctx: AgememContext, serviceName: string): T | undefined {
  try {
    const found = ctx.reflect?.get(serviceName);
    return (found as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The credentials seam as this plugin uses it: a ref resolves to its value. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>;
}

/** How long mount waits for a lazily-provided seam, and how often it re-checks. */
const SEAM_WAIT_MS = 800;
const SEAM_POLL_MS = 25;
/**
 * Mount-time wait for the tools service — the same trap as the credentials seam.
 * The entry is composed before sibling services exist, so a single lookup at
 * apply() time found nothing and memory_recall was never registered for the
 * whole life of the process (measured: the tool was missing from every session
 * while no error was logged, because the branch just took the else path).
 */
const TOOLS_WAIT_MS = 800;

/**
 * Wait (briefly) for a seam that a SIBLING entry provides.
 *
 * Resolving `ctx.reflect.get('credentials')` exactly once at mount lost every
 * key on a real composition: the entry exists in the composed config, but its
 * service object is not there yet when a plugin patched in after it runs. The
 * measured symptom was `keySource=none, userKeySource=none` in the ready line at
 * +228ms, while the very same refs resolved to 64- and 6-character values 500ms
 * later. One bounded wait at mount is enough; per-request waits would put this
 * delay on the turn path.
 */
async function waitForService<T>(
  ctx: AgememContext,
  serviceName: string,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = getService<T>(ctx, serviceName);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SEAM_POLL_MS);
      // Never keep the host process alive just for this probe.
      const unref = (timer as unknown as { unref?: () => void }).unref;
      if (typeof unref === 'function') unref.call(timer);
    });
  }
}


/**
 * Dead-letter reason class for a write failure. Auth is its own class because it
 * is a configuration bug (wrong key), not a core outage: retrying it burns
 * attempts and floods the log.
 */
/**
 * Flatten a host schema rejection into its original fields. The host throws
 * HarnessError-like objects whose `violations` array names the exact rule
 * (e.g. "parameters.limit.required must be true when present"); logging the
 * object alone loses them in host-specific formatting.
 */
function describeRegistrationError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const record = error as { code?: unknown; name?: unknown; message?: unknown; violations?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (record.code !== undefined) parts.push('code=' + String(record.code));
  if (record.name !== undefined) parts.push('name=' + String(record.name));
  if (record.message !== undefined) parts.push('message=' + String(record.message));
  if (record.violations !== undefined) {
    const violations = Array.isArray(record.violations) ? record.violations.map(String) : [String(record.violations)];
    parts.push('violations=' + violations.join('; '));
  }
  if (record.cause !== undefined) parts.push('cause=' + String(record.cause));
  // A flat, greppable string beats an object: the desktop log is a text file and
  // host loggers disagree on how they render nested values ([object Object]).
  return parts.length > 0 ? parts.join(' ') : String(error);
}

function classifyWriteFailure(status: number | undefined, family: string): string {
  if (status === 401 || status === 403) return 'auth';
  if (typeof status === 'number') return family + '-http';
  return family + '-transport';
}

export async function apply(ctx: AgememContext, rawConfig?: unknown): Promise<void> {
  const { config, warnings } = normalizeConfig(rawConfig);
  // A desktop/GUI host has no readable stderr, so a debug install mirrors every
  // line into a file as well (see debug-log.ts). Constructed only when debug is
  // on: a plain install must not create files or directories.
  const debugLog = config.debug
    ? createDebugLog({ filePath: resolveDebugLogPath(config.debugLogFile, process.env) })
    : undefined;
  const log: LoggerLike | undefined = combineLoggers(ctx.logger, debugLog?.logger);
  for (const warning of warnings) log?.warn?.('agemem: config ' + warning);
  if (debugLog !== undefined) log?.debug?.('agemem: debug log mirror -> ' + debugLog.path);
  if (!config.enabled) {
    log?.debug?.('agemem: disabled by config');
    return;
  }

  // The seam is looked up PER CALL and waited for once: see waitForService. A
  // single mount-time lookup silently disabled both credential layers on a real
  // composition (the entry was composed, the service object was not there yet).
  let seamWaited = false;
  const resolveCredential = async (ref: string): Promise<string | undefined> => {
    try {
      let service = getService<CredentialsLike>(ctx, 'credentials');
      if (service === undefined && !seamWaited) {
        seamWaited = true;
        service = await waitForService<CredentialsLike>(ctx, 'credentials', SEAM_WAIT_MS);
        if (service === undefined) {
          log?.debug?.('agemem: the credentials seam is not mounted; falling back to the environment for ' + ref);
        }
      }
      const hit = await service?.resolve(ref);
      const value = hit?.value;
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    } catch {
      // Credentials seam unavailable or broken: fall back to the environment.
      return undefined;
    }
  };
  const resolveApiKey = async (): Promise<string | undefined> => {
    // Order: explicit config.apiKey → credentials.resolve(apiKeyRef) → env[apiKeyRef].
    // The inline value wins on purpose: a desktop profile may have no credentials
    // store (or a stale entry), and a configured key that silently lost to the
    // seam would look like "the core has no memory" instead of a bad key.
    const inline = config.server.apiKey.trim();
    if (inline !== '') return inline;
    const ref = config.server.apiKeyRef;
    const fromSeam = await resolveCredential(ref);
    if (fromSeam !== undefined) return fromSeam;
    const fromEnv = process.env[ref];
    return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined;
  };

  /**
   * Same three-step order as the core key: explicit server.userKey →
   * credentials.resolve(userKeyRef) → env[userKeyRef]. The user key only
   * RESOLVES the identity; it is never sent to the core as a Bearer token and
   * never written into a prompt.
   */
  const resolveUserKey = async (): Promise<string | undefined> => {
    const inline = config.server.userKey.trim();
    if (inline !== '') return inline;
    const ref = config.server.userKeyRef;
    const fromSeam = await resolveCredential(ref);
    if (fromSeam !== undefined) return fromSeam;
    const fromEnv = process.env[ref];
    return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined;
  };

  /** Where the USER key would come from — never the value itself. */
  const userKeySource = async (): Promise<string> => {
    if (config.server.userKey.trim() !== '') return 'config';
    const ref = config.server.userKeyRef;
    if (await resolveCredential(ref) !== undefined) return 'credentials:' + ref;
    const fromEnv = process.env[ref];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env:' + ref;
    return 'none';
  };

  // One warning per failure CLASS, not per request: a misconfigured core
  // otherwise floods the log on every recall/head-pack/writeback attempt while
  // still failing open. Everything below stays silent after its first warn.
  const warned = {
    auth: false,
    recall: false,
    // 404 (endpoint disabled), 422 (missing isolation headers — permanent for the
    // process) and 504 (upstream timeout) each warn once and then change the
    // circuit below: a per-turn 422 was invisible for an entire release because
    // every failure looked like "the core has no memory".
    'recall.404': false,
    'recall.422': false,
    'recall.504': false,
    'write.l0': false,
    'write.skill': false,
    'outbox.dead': false,
    identity: false,
  };
  const warnOnce = (flag: keyof typeof warned, message: string, context?: unknown): void => {
    if (warned[flag]) return;
    warned[flag] = true;
    // Never emit a trailing "undefined": some hosts stringify extra args.
    if (context === undefined) log?.warn?.(message);
    else log?.warn?.(message, context);
  };

  // A MUTABLE identity box: the client reads it per request (isolation headers,
  // missingIdentity), so resolving from a user key after construction updates
  // every later call without rebuilding the client.
  const identity: MemoryIdentity = {
    serviceId: config.server.serviceId,
    teamId: config.server.teamId.trim(),
    agentId: config.server.agentId.trim(),
    userId: config.server.userId.trim(),
  };

  const client = new MemoryClient({
    baseUrl: config.server.baseUrl,
    maxRequestBytes: config.writeback.maxRequestBytes,
    maxResponseBytes: config.server.maxResponseBytes,
    apiKey: config.server.apiKey,
    apiKeyRef: config.server.apiKeyRef,
    identity,
    requestTimeoutMs: config.server.requestTimeoutMs,
    paths: config.paths,
    resolveApiKey,
    // The same user key also travels as a request header (task-69): the data
    // routes only carry it once the isolation triple is complete, and the
    // client resolves it once per process (latch), so no keychain round-trip
    // lands on the recall hot path. Inline value first, ref second.
    userKey: config.server.userKey,
    resolveUserKey,
    onAuthFailure: ({ path, status }) => {
      warnOnce(
        'auth',
        'agemem: the core rejected the API key (HTTP ' + status + ' on ' + path + '). '
        + 'Set server.apiKey, or make server.apiKeyRef (' + config.server.apiKeyRef + ') resolve to the '
        + "core's own server.apiKey — the MemoryProxy key is a different secret. "
        + 'Memory stays disabled for this process (fail-open, no retry storm).',
      );
    },
    log,
  });

  // 3b. Identity from one user key (task-51 v2). Mount-time only: a profile with
  //     an explicit triple never makes a metadata round-trip, and a profile that
  //     cannot resolve stays inert (it must not fall back to SOME team — writing
  //     this session into another user's memory pool is worse than silence).
  let identityState = identityStateOf(identity);
  // Kept for the ready line only (never printed): whether this mount already
  // resolved a user key, which is what decides if the header can be sent.
  let mountUserKey: string | undefined;
  if (identityState !== 'configured') {
    const userKey = await resolveUserKey();
    mountUserKey = userKey;
    if (userKey !== undefined) {
      const outcome = await settleWithin(
        resolveIdentityFromUserKey({
          client,
          userKey,
          timeoutMs: Math.min(config.server.requestTimeoutMs, IDENTITY_RESOLUTION_BUDGET_MS),
          log,
        }),
        IDENTITY_RESOLUTION_BUDGET_MS,
      );
      if (outcome === undefined) {
        warnOnce(
          'identity',
          'agemem: identity resolution from server.userKey timed out after '
          + IDENTITY_RESOLUTION_BUDGET_MS + 'ms; memory stays inert for this process. '
          + 'Check the core is reachable, then run scripts/agemem-identity.mjs to set the triple explicitly.',
        );
      } else if (outcome.kind === 'resolved') {
        applyIdentity(identity, outcome);
        identityState = 'resolved(user_key)';
      } else if (outcome.kind === 'invalid-key') {
        warnOnce(
          'identity',
          'agemem: the core rejected server.userKey (' + outcome.reason + '); memory stays inert for this process. '
          + 'Run scripts/agemem-identity.mjs to verify the key.',
        );
      } else if (outcome.kind === 'ambiguous') {
        warnOnce(
          'identity',
          'agemem: server.userKey is valid but not unambiguous (' + outcome.reason + '); memory stays inert for this process. '
          + 'Pick one with scripts/agemem-identity.mjs --team <team-id> --agent <agent-id> (interactive: no flags).',
        );
      } else {
        warnOnce(
          'identity',
          'agemem: identity resolution from server.userKey failed (' + outcome.reason
          + (outcome.status === undefined ? '' : ', HTTP ' + outcome.status)
          + '); memory stays inert for this process. Run scripts/agemem-identity.mjs to set the triple explicitly.',
        );
      }
    }
  }

  // Transport for the skill surface (src/skill-client.ts): the same v3 seam as
  // every other call, so identity headers, envelope unwrapping and the API key
  // have exactly one implementation.
  const skillClient = new SkillClient({
    call: (path, body, options) => client.v3(path, body, options),
    timeoutMs: config.skill.timeoutMs,
    log,
  });

  // The newest session id this process has seen. Only the extract tool needs it
  // (force-archive is session-scoped); everything else takes the session from
  // the event or turn context it is already handling.
  let latestSessionId: string | undefined;
  const segmentDeps: SegmentDeps = {
    client,
    config,
    log,
    skillClient,
    sessionId: () => latestSessionId,
  };

  const headPack = new HeadPack({
    fetchHeadPack: async () => {
      // Segments, not one blob: every provider self-registers in
      // src/segments/*.ts and this runner owns the budget, the truncation and
      // the failure isolation (a dead segment contributes zero characters, it
      // never empties the pack).
      const { text, segments } = await runHeadPackSegments(segmentDeps, config.headPack.maxChars);
      log?.debug?.('agemem: head pack composed', {
        segments: segmentSummary(segments),
        chars: text.length,
        budget: config.headPack.maxChars,
        // Four states, same vocabulary as the mount line: ok(N,chars) / empty /
        // truncated(0,dropped) / fail:<reason>. Absent only when the segment
        // never ran (disabled, or this is the first fetch of the process).
        l2: l2StatusForDebug(),
      });
      return text.trim() === '' ? undefined : text;
    },
    maxChars: config.headPack.maxChars,
    refreshMs: config.headPack.refreshMs,
    fallbackText: config.headPack.fallbackText,
    log,
  });

  // 4. One-shot reachability probe. Started here so it overlaps the rest of the
  // wiring, and awaited only by the ready line (its own 3s cap) — never by a
  // turn. This is the single most useful line for a cross-host deploy: without
  // it "mounted but the core is unreachable" (wrong baseUrl, firewall, gateway
  // down) is indistinguishable from "no memories matched".
  const healthProbe: Promise<string> = (async (): Promise<string> => {
    if (identityStateOf(identity) !== 'configured') {
      return 'skipped(inert)';
    }
    try {
      return (await client.health(3000)) ? 'ok' : 'fail(no-answer)';
    } catch {
      return 'fail(error)';
    }
  })();

  /** Where the key would come from — never the value itself. */
  const keySource = async (): Promise<string> => {
    if (config.server.apiKey.trim() !== '') return 'config';
    const ref = config.server.apiKeyRef;
    if (await resolveCredential(ref) !== undefined) return 'credentials:' + ref;
    const fromEnv = process.env[ref];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env:' + ref;
    return 'none';
  };

  // Circuit breaker. Two different kinds of failure, two different policies:
  //
  //  * 422 is permanent for this process. The live probe (scratch/lead/recall-headers.mjs)
  //    showed /v3/recall requires the isolation triple as HEADERS; a 422 means our
  //    identity/headers are wrong, which no amount of waiting fixes — exactly like a
  //    401. Stop probing until restart, so a misconfigured profile does not burn a
  //    wasted 30ms–2s request on every single turn.
  //  * 404 (v3Recall disabled server-side) and 504 (upstream timeout) are transient
  //    or operator-fixable, so they back off for 10 minutes and then re-probe.
  const RECALL_UNAVAILABLE_MS = 10 * 60 * 1000;
  let recallUnavailableUntil = 0;
  let recallUnavailableStatus: number | undefined;

  // One warn per recall failure class; the actionable hint differs by status.
  const warnRecallFailure = (result: RecallBlockResult): void => {
    const status = result.status;
    const detail = status !== undefined ? 'HTTP ' + status : (result.reason ?? 'no block');
    const hint = status === 404
      ? 'the recall endpoint is disabled server-side (MemoryCore v3Recall.enabled) — '
        + 'falling back to /v3/atomic/search for 10 minutes; enable v3Recall to get the merged block'
      : status === 422
        ? 'the core requires strict isolation ("/v3 requires strict isolation: missing team_id, agent_id, user_id") '
        + 'and reads it from the x-tdai-team-id / x-tdai-agent-id / x-tdai-user-id headers — '
        + 'check that the profile configures all three; /v3/recall is disabled for this process (restart after fixing)'
        : status === 504
          ? '/v3/recall timed out upstream — falling back to /v3/atomic/search for 10 minutes'
          : result.aborted === true
            // We cancelled this one ourselves (recallTimeoutMs), not the network:
            // a different diagnosis than a broken core.
            ? 'cancelled locally after volatile.recallTimeoutMs — falling back to /v3/atomic/search'
            : 'falling back to /v3/atomic/search';
    if (status === 422) {
      recallUnavailableUntil = Number.POSITIVE_INFINITY;
      recallUnavailableStatus = status;
      warnOnce('recall.422', 'agemem: /v3/recall failed (' + detail + '): ' + hint);
      return;
    }
    if (status === 404 || status === 504) {
      recallUnavailableUntil = Date.now() + RECALL_UNAVAILABLE_MS;
      recallUnavailableStatus = status;
      warnOnce(status === 404 ? 'recall.404' : 'recall.504', 'agemem: /v3/recall failed (' + detail + '): ' + hint);
      return;
    }
    warnOnce('recall', 'agemem: /v3/recall failed (' + detail + '): ' + hint);
  };

  const disposers: Array<() => void> = [];

  // 0. Embedding prewarm: the first atomic/search after an idle period measured
  // ~6.4s against the local core (cold embedding model) — past the volatile
  // block's budget, so the first turn after a restart would silently lose its
  // recall. One fire-and-forget query per agent creation pulls the model warm;
  // failures are swallowed and no turn ever waits on it.
  let prewarmed = false;
  const prewarm = (): void => {
    if (prewarmed) return;
    prewarmed = true;
    void (async () => {
      try {
        await Promise.allSettled([
          client.readCore(config.headPack.timeoutMs),
          // Warm the embedding model through the SAME endpoint the volatile
          // block now uses: /v3/recall measured ~5.0s cold, so turn 1 would
          // otherwise lose its block. Silent on failure — prewarm is only an
          // optimisation.
          client.recallBlock('warmup', { maxResults: 1, timeoutMs: config.headPack.timeoutMs }),
        ]);
      } catch (error) {
        log?.debug?.('agemem: prewarm skipped', error);
      }
    })();
  };
  try {
    disposers.push(ctx.on('agent/created', () => prewarm()));
  } catch (error) {
    log?.debug?.('agemem: prewarm watch unavailable', error);
  }

  // 1. Answer-guidance section (task-15): the memory answer discipline the
  // MemoryCore read path already injects (answer-guidance + memory-tools-guide).
  //
  // Placement: its own section with order = head pack offset + 1, i.e. immediately
  // after the head pack, rather than appended to the head-pack text, because
  //   (a) the head pack is a fetched artifact that is empty until the first fetch
  //       succeeds — and stays empty when the core is unreachable. Guidance must
  //       survive exactly those cases;
  //   (b) the head pack is frozen per session and refetched on compaction, while
  //       this text is static, so it needs none of that refresh machinery.
  // It must NOT ride in the volatile block: that block is appended as a durable
  // `user/message` event (src/volatile.ts), and a system-level norm must not become
  // user input history.
  //
  // Registration order vs prompt order: the host sorts sections by `order`, so
  // registration sequence does not affect the rendered prompt. We still register
  // guidance FIRST so the head pack stays the newest registered section, which is
  // what hosts (and our test helper) inspect when they look at the last section.
  try {
    const guidanceBase = ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? DEPLOYMENT_PERSONA_SUFFIX_ORDER;
    disposers.push(
      ctx.systemPrompt.section({
        name: 'tdb-agemem:answer-guidance',
        order: guidanceBase + config.headPack.orderOffset + 1,
        interpolate: false,
        text: GUIDANCE_TEXT,
      }),
    );
  } catch (error) {
    log?.warn?.('agemem: answer-guidance section registration failed; continuing without it', error);
  }

  // 2. Head pack section (stable prefix, frozen within a session).
  if (config.headPack.enabled) {
    try {
      const base = ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? DEPLOYMENT_PERSONA_SUFFIX_ORDER;
      const dispose = ctx.systemPrompt.section({
        name: 'tdb-agemem:head-pack',
        order: base + config.headPack.orderOffset,
        interpolate: false,
        text: () => headPack.current(),
      });
      disposers.push(dispose);
      void headPack.refresh();
    } catch (error) {
      log?.warn?.('agemem: head pack section registration failed; continuing without it', error);
    }
  }

  // 2. Per-turn volatile block (appended at the tail, once per turn).
  //
  // Latency, measured against the local core with one NEW turn text per round:
  // /v3/recall costs 1250-2255ms warm and 5067ms cold, with the L1 embedding
  // (perfMs.l1) at 97%+ of it. The block is awaited inside agent/pre-step, so an
  // unshielded miss is directly user-visible. Three shields — a budget, a cache,
  // and in-flight reuse — each of which only removes wasted work:
  //   - recallTimeoutMs (2500ms) cancels OUR request via AbortController and then
  //     falls back to atomic/search with the 500ms left of the volatile budget;
  //   - a bounded TTL cache answers a repeated question for free (10 min, 50);
  //   - one in-flight request per turn key, shared by the user/message prefetch
  //     and this pre-step await, so a repeated key never pays twice.
  //     Honest caveat: on this host the prefetch does NOT shrink this turn's
  //     latency. session/event user/message is dispatched AFTER agent/pre-step,
  //     so the pre-step has already fetched this exact text; prefetched:false is
  //     the normal reading, and the prefetch only pays off when the same text
  //     comes back later (a retry, a repeated question). Never budget it.
  //     Only a NON-EMPTY block is cached: caching a degraded result for 10
  //     minutes would freeze the fallback in place.
  const recallCache = new RecallCache();
  const inflight = new RecallInflight<VolatileBlock>(RECALL_INFLIGHT_MAX_ENTRIES, log);

  const countEntries = (text: string): number =>
    text === '' ? 0 : text.split('\n').filter((line) => line.startsWith('- [')).length;

  /**
   * Supply order: /v3/recall (merged, R7-layered, budgeted) → the older
   * atomic/search summary. Recall is server-side opt-in and can be disabled
   * (404), slow (504), or cancelled by our own budget (aborted); the block also
   * repeats the answer-guidance preamble, so only its `- [` entries are kept.
   * Never throws: every failure degrades to the fallback or to no block.
   */
  /**
   * Append the optional capability segments (wiki / knowledge) to the memory
   * block. They share the SAME per-turn ceiling: the remainder of
   * `volatile.maxChars` is handed to them in registration order, so a new
   * segment can never push memories out. Fail-open three ways — every module
   * returns '' instead of throwing, the whole leg is capped by what is left of
   * `volatile.timeoutMs` (minus the 500ms the step needs to finish), and a
   * deadline miss simply yields the memory block alone.
   */
  const appendCapabilitySegments = async (base: VolatileBlock, turnText: string, started: number): Promise<VolatileBlock> => {
    if (turnText.trim() === '') return base;
    const separator = base.text === '' ? 0 : 2;
    const budget = Math.max(0, config.volatile.maxChars - base.text.length - separator);
    // Below one tag pair (23 chars) nothing useful fits; skip the round trips.
    if (budget < 60) return base;
    const deadline = config.volatile.timeoutMs - (Date.now() - started) - 500;
    if (deadline < 300) return base;
    const extras = await withDeadlineMs(
      runVolatileSegments({ ...segmentDeps, query: turnText }, budget),
      deadline,
    );
    if (extras === undefined) {
      log?.debug?.('agemem: capability segments missed the volatile deadline', { budget, deadline });
      return base;
    }
    log?.debug?.('agemem: capability segments composed', {
      segments: segmentSummary(extras.segments),
      chars: extras.text.length,
      budget,
    });
    const text = extras.text.trim();
    if (text === '') return base;
    return {
      ...base,
      text: base.text === '' ? text : base.text + String.fromCharCode(10, 10) + text,
      extrasChars: text.length,
    };
  };

  const fetchBlock = async (turnText: string, context: VolatileTurnContext): Promise<VolatileBlock> => {
    const started = Date.now();
    let base: VolatileBlock = { text: '', source: 'none', entriesKept: 0, soulChars: 0 };
    if (config.volatile.recall && Date.now() >= recallUnavailableUntil) {
      const result = await client.recallBlock(turnText, {
        maxResults: config.volatile.recallMaxResults,
        sessionId: context.sessionId,
        timeoutMs: config.volatile.recallTimeoutMs,
      });
      if (result.ok) {
        // The soul is a SLICE of the turn budget, taken before the entries so a
        // long persona can never push memories out of the block; when soul is
        // absent/empty/disabled the memory budget is exactly today's.
        const soulText = config.volatile.soul.enabled
          ? renderSoulBlock(extractSoul(result.block), {
            maxChars: config.volatile.soul.maxChars,
            includeFeeling: config.volatile.soul.includeFeeling,
          })
          : '';
        const soulChars = soulText === '' ? 0 : soulText.length;
        const memoryBudget = Math.max(0, config.volatile.maxChars - (soulChars === 0 ? 0 : soulChars + 1));
        const memories = recallBlockText(result.block, memoryBudget);
        const text = soulText === '' ? memories : (memories === '' ? soulText : soulText + String.fromCharCode(10) + memories);
        if (text !== '') {
          base = {
            text,
            source: 'recall',
            entriesKept: countEntries(memories),
            soulChars,
            soulVersion: soulVersionOf(result.meta),
          };
        } else {
          log?.debug?.('agemem: /v3/recall block carried no memory entries; using atomic/search');
        }
      } else {
        warnRecallFailure(result);
      }
    } else if (config.volatile.recall) {
      // Circuit open: do not burn the step's budget on a request we know fails.
      log?.debug?.('agemem: /v3/recall skipped, circuit open', { status: recallUnavailableStatus });
    }
    // The fallback gets whatever is left of the step's budget: a recall that
    // already burned recallTimeoutMs must not then push the step past its timeout.
    const remaining = config.volatile.timeoutMs - (Date.now() - started);
    if (base.text === '' && remaining >= 300) {
      const recalled = await client.recallCombined(
        turnText,
        config.tools.recallTopK,
        { includePersona: false, includeScenarios: false },
        remaining,
      );
      const text = formatVolatileBlock(recalled.hits, config.volatile.maxChars);
      // The atomic fallback has no soul leg by design: a degraded path must not
      // invent persona text, so soulChars stays 0 and the debug line says so.
      base = { text, source: text === '' ? 'none' : 'atomic', entriesKept: countEntries(text), soulChars: 0 };
    }
    return appendCapabilitySegments(base, turnText, started);
  };

  /**
   * Fire-and-forget prefetch for one turn's user text. Keyed exactly like the
   * pre-step path (same recallKey/`extractTurnClaim`), so a repeated key shares
   * one request.
   *
   * It does NOT hide this turn's RTT: the host dispatches session/event
   * user/message after agent/pre-step, so by the time this runs the step has
   * fetched (or failed) already. It pays off only when the same text reappears
   * inside the cache window — do not count it in any latency budget, and read
   * `prefetched:false` as normal, not as a fault.
   */
  const prefetchBlock = (sessionId: string, turn: unknown, turnText: string): void => {
    if (!config.volatile.enabled || !config.volatile.recall) return;
    if (turnText.trim() === '') return;
    const key = recallKey(sessionId, turn, turnText);
    if (recallCache.get(key) !== undefined) return;
    if (inflight.peek(key) !== undefined) return;
    void inflight
      .take(key, () => fetchBlock(turnText, { turn, sessionId }))
      .then((block) => {
        // Fill the cache here too: a later repeat of this exact text is then free.
        // That (not this turn's latency) is the prefetch's real payoff.
        if (block.text !== '') recallCache.set(key, block.text);
      })
      .catch(() => {
        // Prefetch is an optimisation: the pre-step retries the same key.
      });
  };

  if (config.volatile.enabled) {
    disposers.push(
      installVolatile(ctx, {
        enabled: true,
        maxChars: config.volatile.maxChars,
        timeoutMs: config.volatile.timeoutMs,
        log,
        getBlock: async (turnText: string, context: VolatileTurnContext) => {
          const key = recallKey(context.sessionId, context.turn, turnText);
          const cached = recallCache.get(key);
          if (cached !== undefined) {
            log?.debug?.('agemem: volatile block served from cache', {
              recallMs: 0,
              cacheHit: true,
              source: 'recall',
              injectedChars: cached.length,
              entriesKept: countEntries(cached),
              // The cache stores text only, so the soul size is measured out of
              // the block itself; soulVersion is not cached (it never changes
              // within the cache TTL in practice).
              soulChars: measureSoul(cached),
            });
            return cached;
          }
          const prefetched = inflight.peek(key) !== undefined;
          const started = Date.now();
          const block = await inflight.take(key, () => fetchBlock(turnText, context));
          log?.debug?.('agemem: volatile block ready', {
            recallMs: Date.now() - started,
            cacheHit: false,
            prefetched,
            source: block.source,
            injectedChars: block.text.length,
            entriesKept: block.entriesKept,
            soulChars: block.soulChars,
            ...(block.extrasChars === undefined ? {} : { extrasChars: block.extrasChars }),
            ...(block.soulVersion === undefined ? {} : { soulVersion: block.soulVersion }),
          });
          if (block.text === '') return undefined;
          recallCache.set(key, block.text);
          return block.text;
        },
      }),
    );
  }

  // 4. Turn writeback (local outbox; delivery never blocks the turn).
  if (config.writeback.enabled) {
    try {
      const outbox = new Outbox({
        path: config.writeback.outboxPath,
        // Bounded queue: an unreachable core must not grow the JSONL forever.
        maxEntries: config.writeback.maxOutboxEntries,
        maxBytes: config.writeback.maxOutboxBytes,
        deliver: (entry) => {
          const payload = entry.payload as TurnEndPayload & { kind?: string };
          // One outbox, two pipelines. The key already separates them
          // (<turnId> vs <turnId>:skill); `kind` tells the delivery apart.
          // Rows written before `kind` existed are L0 (fail-open default).
          if (payload?.kind === 'skill') {
            const skill = payload as unknown as SkillWritebackPayload;
            const skillMessages = Array.isArray(skill.messages) ? skill.messages : [];
            const messageLen = skillMessages.reduce(
              (total, message) => total + (typeof message.content === 'string' ? message.content.length : 0),
              0,
            );
            if (skillMessages.length === 0) {
              // Unusable row: dead-letter it instead of retrying forever, but
              // never delete it (zero-delete red line).
              log?.warn?.('agemem: skill outbox entry has no messages; moving it to the dead-letter file');
              return Promise.resolve({
                ok: false,
                retryable: false,
                reasonClass: 'empty-payload',
                endpoint: config.paths.skillConversationAdd,
              });
            }
            return client
              .skillConversationAdd(skill.sessionId, skillMessages, config.server.requestTimeoutMs)
              .then((result) => {
                if (result.ok) {
                  if ((result.chunks ?? 1) > 1 || (result.truncated ?? 0) > 0) {
                    log?.debug?.('agemem: skill write ok', { chunks: result.chunks, truncated: result.truncated });
                  }
                  return { ok: true } as const;
                }
                log?.debug?.('agemem: skill write rejected', {
                  status: result.status,
                  reason: result.reason,
                  retryable: result.retryable,
                });
                // A 200 + code!==0 is the core's business rejection (its skill
                // route maps validation errors to code 40001): treat it as a
                // failed write, not as delivered.
                if (result.code !== undefined) {
                  const detail = 'business code ' + result.code
                    + (result.message !== undefined ? ' (' + result.message + ')' : '');
                  warnOnce(
                    'write.skill',
                    'agemem: skill write rejected by the core (' + detail + ' on '
                    + config.paths.skillConversationAdd + '); not retried and dead-lettered — '
                    + 'the L2 buffer has no dedupe and a replay would double-count the turn',
                  );
                  return {
                    ok: false,
                    status: result.status,
                    reason: result.reason,
                    retryable: false,
                    reasonClass: 'business-rejected',
                    endpoint: config.paths.skillConversationAdd,
                    messageLen,
                  };
                }
                if (typeof result.status === 'number') {
                  warnOnce(
                    'write.skill',
                    'agemem: skill write rejected (HTTP ' + result.status + ' on ' + config.paths.skillConversationAdd
                    + '); not retried on an HTTP response — the L2 buffer has no dedupe and a replay would '
                    + 'double-count the turn; check the core log if this keeps happening',
                  );
                }
                return {
                  ok: false,
                  status: result.status,
                  reason: result.reason,
                  // Only a request that never reached the core may be replayed.
                  retryable: result.retryable === true,
                  reasonClass: classifyWriteFailure(result.status, 'skill-feed'),
                  endpoint: config.paths.skillConversationAdd,
                  messageLen,
                };
              });
          }
          // writeback.ts owns the [user, assistant] collection: it filters on
          // source.kind === 'user', skips the plugin's own injected block and
          // stamps ISO timestamps. Rebuilding the array here used to drop the
          // user text entirely and re-type the timestamps, so the payload's
          // fields were dead code. Consume it verbatim instead.
          const messages: ConversationMessage[] = Array.isArray(payload.messages) ? payload.messages : [];
          const messageLen = messages.reduce(
            (total, message) => total + (typeof message.content === 'string' ? message.content.length : 0),
            0,
          );
          if (messages.length === 0) {
            // Legacy outbox row from before messages existed: nothing can be
            // sent, so dead-letter it for manual requeue instead of retrying a
            // payload that can never succeed (zero-delete red line: the row is
            // kept in outbox.dead.jsonl).
            log?.warn?.('agemem: outbox entry has no messages; moving it to the dead-letter file');
            return Promise.resolve({
              ok: false,
              retryable: false,
              reasonClass: 'empty-payload',
              endpoint: config.paths.conversationAdd,
            });
          }
          return client
            .addConversationResult(payload.sessionId, messages, config.server.requestTimeoutMs)
            .then((result) => {
              if (result.ok) {
                if ((result.chunks ?? 1) > 1 || (result.truncated ?? 0) > 0) {
                  log?.debug?.('agemem: conversation write ok', { chunks: result.chunks, truncated: result.truncated });
                }
                return { ok: true } as const;
              }
              // 200 + code!==0 is a rejection: the core maps some validation
              // errors to a business code, so a status-only check reported a
              // thrown-away payload as delivered (only a debug line survived).
              if (result.code !== undefined) {
                const detail = 'business code ' + result.code
                  + (result.message !== undefined ? ' (' + result.message + ')' : '');
                warnOnce(
                  'write.l0',
                  'agemem: conversation write rejected by the core (' + detail + ' on '
                  + config.paths.conversationAdd + '); not retried — the request was answered, '
                  + 'only its payload shape needs fixing',
                );
                return {
                  ok: false,
                  status: result.status,
                  reason: result.reason,
                  retryable: false,
                  reasonClass: 'business-rejected',
                  endpoint: config.paths.conversationAdd,
                  messageLen,
                };
              }
              if (typeof result.status === 'number') {
                // Retry matrix: 5xx/429 are transient; every other status was
                // answered, so replaying it just burns 8 × 30s of backoff.
                const retryable = result.status === 429 || result.status >= 500;
                warnOnce(
                  'write.l0',
                  'agemem: conversation write rejected (HTTP ' + result.status + ' on ' + config.paths.conversationAdd
                  + '); ' + (retryable ? 'the outbox retries with backoff' : 'not retried on an HTTP response')
                  + ' — check the core log if this keeps happening',
                );
                return {
                  ok: false,
                  status: result.status,
                  reason: result.reason,
                  retryable,
                  reasonClass: classifyWriteFailure(result.status, 'l0'),
                  endpoint: config.paths.conversationAdd,
                  messageLen,
                };
              }
              // No HTTP response at all. A connection reset / failed fetch is
              // worth exactly ONE replay (the body may not have landed); a local
              // timeout means it was probably in flight already, and L0 is
              // idempotent server-side, so replaying adds load for no gain.
              const transportReset = (result.reason ?? '').startsWith('transport failure:');
              const retryOnce = transportReset && entry.attempts < 1;
              if (!retryOnce) {
                warnOnce(
                  'write.l0',
                  'agemem: conversation write never completed (' + (result.reason ?? 'no response') + ' on '
                  + config.paths.conversationAdd + '); not retried — check the core process and the network path',
                );
              }
              return {
                ok: false,
                status: result.status,
                reason: result.reason,
                retryable: retryOnce,
                reasonClass: transportReset ? 'transport-reset' : 'l0-timeout',
                endpoint: config.paths.conversationAdd,
                messageLen,
              };
            });
        },
        maxAttempts: config.writeback.maxAttempts,
        retryMs: config.writeback.retryMs,
        // Dead letter is a permanent data-loss risk signal, not routine noise:
        // surface the first one loudly, keep later ones at debug to stay honest
        // about the count without flooding.
        log: log === undefined ? undefined : {
          debug: (...args: unknown[]) => log.debug?.(...args),
          info: (...args: unknown[]) => log.info?.(...args),
          warn: (...args: unknown[]) => {
            const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
            if (text.includes('dead letter')) {
              // Keep the outbox's structured tail (class/endpoint/status): it is
              // what makes the row actionable, and it carries no ids or text.
              warnOnce('outbox.dead', text + ' — inspect and requeue manually', args.slice(1));
              return;
            }
            log.warn?.(...args);
          },
        },
      });
      disposers.push(
        installWriteback(ctx, {
          outbox,
          workspaceId: process.cwd(),
          skillFeed: config.writeback.skillFeed,
          // Bound every message at the core's schema limit before it is queued,
          // so an oversized turn is clipped (visibly) instead of 400-ing.
          maxMessageChars: config.writeback.maxMessageChars,
          log,
        }),
      );
      disposers.push(outbox.startTimer(config.writeback.retryMs));
    } catch (error) {
      log?.warn?.('agemem: writeback setup failed; turns will not be written back', error);
    }
  }

  // 4. Tools (optional: the composition may not mount a tool service).
  //
  // Every surface is a module (src/tools/*.ts) that self-registers with its own
  // enable predicate; this loop registers whatever the config leaves on. Adding
  // a tool is a module file plus one import in src/tools/index.ts — no change
  // here, which is what keeps the wiring reviewable.
  const toolModules = enabledToolModules(config);
  if (toolModules.length > 0) {
    let tools = getService<ToolsService>(ctx, 'tools');
    if (tools === undefined) tools = await waitForService<ToolsService>(ctx, 'tools', TOOLS_WAIT_MS);
    if (tools && typeof tools.register === 'function') {
      const toolDeps = {
        client,
        config,
        log,
        skillClient,
        sessionId: () => latestSessionId,
      };
      for (const mod of toolModules) {
        let definitions: ToolDefinitionShape[] = [];
        try {
          definitions = mod.build(toolDeps);
        } catch (error) {
          // One broken module must not take the other surfaces down.
          log?.warn?.('agemem: tool module ' + mod.name + ' failed to build; continuing without it', error);
          continue;
        }
        for (const definition of definitions) {
          try {
            disposers.push(tools.register(definition));
            log?.debug?.('agemem: tool registered', {
              module: mod.name,
              tool: definition.name,
              parameters: Object.keys((definition.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
            });
          } catch (error) {
            // The host's rejection names the exact rule it broke; without those
            // fields the only visible symptom was "the tool is missing from the list".
            log?.warn?.('agemem: ' + definition.name + ' registration failed', describeRegistrationError(error));
          }
        }
      }
    } else {
      log?.warn?.('agemem: tools service unavailable; no tools registered');
    }
  }

  // 5. Session events: turn start is a cheap freshness check, the first real user
  //    message warms the cache for a REPEATED text (measured: this event lands
  //    after agent/pre-step, so it cannot help the turn it belongs to), and turn
  //    end drops the in-flight key.
  try {
    disposers.push(
      ctx.on('session/event', (session: unknown, event: { type?: string; data?: any } | undefined) => {
        const type = event?.type;
        if (type === 'turn/start') {
          headPack.ensureFresh();
          return;
        }
        const id = sessionKey((session ?? {}) as { id?: string });
        if (type === 'user/message') {
          const data: any = event?.data ?? {};
          // Same filter as the writeback: real user text only, never an injected
          // block (source.kind === 'plugin:*') and never a non-user role.
          const candidate = data?.message && typeof data.message === 'object' ? data.message : data;
          if (!candidate || typeof candidate !== 'object' || candidate.role !== 'user') return;
          if (candidate.source?.kind !== 'user') return;
          const claim = extractTurnClaim([candidate]);
          prefetchBlock(id, data?.turn, claim.text);
          return;
        }
        if (type === 'turn/end' && config.volatile.enabled) {
          const turn = (event?.data as { turn?: unknown } | undefined)?.turn;
          if (turn !== undefined && turn !== null) inflight.forget(recallKey(id, turn, ''));
        }
      }),
    );
  } catch (error) {
    log?.debug?.('agemem: session/event watch unavailable', error);
  }

  // 6. Compaction invalidation. Verified against app.asar: the host emits
  //    `compaction/start`, `compaction/prune`, `compaction/summary`,
  //    `compaction/end`, `compaction/summary-error`. The older
  //    `session/compacted` / `session/compaction` spellings do not exist in
  //    this build, so watching them was dead code and the head pack stayed
  //    stale for up to refreshMs. Invalidate on start (prompt assembly during
  //    compaction should already use the new pack) and refetch on end.
  for (const event of ['compaction/start', 'compaction/end'] as const) {
    try {
      disposers.push(
        ctx.on(event, () => {
          headPack.invalidate();
          void headPack.refresh();
        }),
      );
    } catch (error) {
      log?.debug?.('agemem: ' + event + ' watch unavailable', error);
    }
  }

  // One mount-time info line: enough to know whether memory is actually wired
  // in this process, without leaking identity ids or the key value. The e2e run
  // had to read the core DB to answer "is the plugin even mounted?" — this line
  // answers it from the host log alone.
  const capabilities = [
    'headPack=' + (config.headPack.enabled ? 'on' : 'off'),
    // The L2 scene index is a segment of the head pack with its own switch and
    // its own failure mode. 'pending' means the first fetch has not landed yet
    // (the mount line races the async refresh on purpose).
    'l2=' + (config.headPack.enabled && config.headPack.includeScenarioIndex
      ? (l2StatusSummary() ?? 'pending')
      : 'off'),
    'volatile=' + (config.volatile.enabled ? (config.volatile.recall ? 'recall' : 'atomic') : 'off'),
    // Soul is a slice of the volatile budget, so the mount line has to say
    // whether that slice is on and how big it is — otherwise 'the persona is
    // missing' is indistinguishable from 'soul is off'. Never the text itself;
    // the per-turn debug line reports the core's soulVersion instead.
    'soul=' + (config.volatile.enabled && config.volatile.soul.enabled
      ? 'on(' + config.volatile.soul.maxChars + (config.volatile.soul.includeFeeling ? ',feeling' : '') + ')'
      : 'off'),
    'writeback=' + (config.writeback.enabled ? 'on' : 'off'),
    'skillFeed=' + (config.writeback.enabled && config.writeback.skillFeed ? 'on' : 'off'),
    'tools=' + (config.tools.enabled && config.tools.recall ? 'on' : 'off'),
    // The skill surface is two separate things: the head-pack listing (read)
    // and the six write tools (destructive, opt-in). Printing one flag would
    // hide exactly the mistake an operator must catch.
    'skill=' + (config.skill.enabled ? 'on' + (config.skill.allowLlmWrite ? '(write)' : '(read)') : 'off'),
    // Per-turn capability segments (they ride the volatile block's remainder).
    'wiki=' + (config.volatile.enabled && config.volatile.wiki.enabled ? 'on(' + config.volatile.wiki.maxChars + ')' : 'off'),
    'knowledge=' + (config.volatile.enabled && config.volatile.knowledge.enabled ? 'on(' + config.volatile.knowledge.maxChars + ')' : 'off'),
  ].join(',');
  // Every budget prints as raw milliseconds. Rounding to seconds (the old
  // 'recallTimeout=2s') hid the difference between 1500 and 2500ms, which is
  // exactly the value an operator has to tune when the core is slow.
  const timeouts = [
    'volatileChars=' + config.volatile.maxChars,
    'recallTimeout=' + config.volatile.recallTimeoutMs + 'ms',
    'volatileTimeout=' + config.volatile.timeoutMs + 'ms',
    'headPackTimeout=' + config.headPack.timeoutMs + 'ms',
    'requestTimeout=' + config.server.requestTimeoutMs + 'ms',
  ].join(',');
  log?.info?.(
    'agemem: ready (endpoint=' + config.server.baseUrl
    + ', serviceId=' + config.server.serviceId
    + ', identity=' + identityState
    + (identityState === 'configured'
      ? ''
      // Only mention the user key when this process had to go find one — and say
      // where it came from, never what it is. A resolved identity still prints
      // its source: "identity=resolved(user_key)" alone hides whether the key
      // came from the config, the credentials store or the environment.
      : ', userKeySource=' + (await userKeySource()))
    + ', keySource=' + (await keySource())
    // Whether the user key actually becomes a request header (task-69): on only
    // when the isolation triple is complete AND a key was resolved at mount —
    // never "on" as a guess. A ref that resolves lazily on the first request
    // reports lazy(<ref>), which is truthful without a keychain round-trip here.
    + ', userKeyHeader=' + (
      identity.serviceId !== '' && identity.teamId !== '' && identity.agentId !== '' && identity.userId !== ''
        ? (config.server.userKey.trim() !== '' || mountUserKey !== undefined
          ? 'on'
          : (config.server.userKeyRef.trim() !== '' ? 'lazy(' + config.server.userKeyRef + ')' : 'off'))
        : 'off'
    )
    + ', health=' + (await healthProbe)
    + ', ' + capabilities
    + ', guidance=' + GUIDANCE_VERSION
    + ', ' + timeouts
    + ', debug=' + (config.debug ? 'on' : 'off')
    + (debugLog !== undefined ? ', logFile=' + debugLog.path : '')
    + ')',
  );

  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Disposal is best-effort; the fiber teardown continues.
      }
    }
  };

  try {
    // Cordis emits 'dispose' when the owning fiber tears down.
    ctx.on('dispose', disposeAll);
  } catch {
    // Older host: event listeners and effects are disposed with the fiber.
  }
}

/**
 * Settings page (档 2): the host reads `Config` off the plugin module namespace
 * (dsh-settings/lib/index.js `schema(entry)` -> `entry.fiber.runtime.Config`) and
 * lists the plugin under Settings -> Plugins only when that schema carries at
 * least one `.volatile()` field. Shape lives in config-schema.ts; the single
 * `@deepseek-ai/schemastery` import lives in config-schema.host.ts.
 */
export { Config } from './config-schema.host.js';
