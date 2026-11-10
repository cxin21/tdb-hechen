import { dirname, join } from 'node:path';
// The host hands `.volatile()` fields over as cosmokit references, not values
// (settings form write-through). `resolvePluginConfig` unwraps them first; calling
// `normalizeConfig` directly drops every volatile path back to its default —
// baseUrl → 8420, debug → false, the config identity triple → empty.
import { resolvePluginConfig } from './config-schema.js';
import { combineLoggers, createDebugLog, resolveDebugLogPath } from './debug-log.js';
// 答案口径段（task-15）：把 MemoryCore 单一源的作答纪律接到 system prompt。
import { GUIDANCE_TEXT, GUIDANCE_VERSION } from './guidance.js';
import { agentKey, sessionKey } from './ids.js';
import { compressHeadPack, HeadPack } from './head-pack.js';
import { applyIdentity, identityStateOf, listCandidates, resolveIdentityFromUserKey } from './identity.js';
import { MemoryClient, type ConversationMessage, type MemoryIdentity, type RecallBlockResult, type TurnEndPayload } from './memory-client.js';
import { defaultOutboxPath, Outbox } from './outbox.js';
import { createInjectionLog, recordInjection } from './injection-log.js';
import { createPersonaCard, type PersonaCardHandle } from './persona-card.js';
import { recallKey, RECALL_INFLIGHT_MAX_ENTRIES, RecallCache, RecallInflight } from './recall-cache.js';
import { clampBlockByLines, recallBlockText } from './recall-source.js';
// One runner for the head pack and one for the volatile block: every segment
// lives in src/segments/*.ts and self-registers (see src/segments/index.ts), so
// this file does not grow when a new data source is added.
import { runHeadPackSegments, runVolatileSegments, segmentSummary, type SegmentDeps } from './segments/index.js';
// The L2 segment owns its own status line (task-103): the mount line and the
// head-pack debug line both quote it, so a scene index that failed reads as
// `l2=fail:http_404` instead of silently emptying half the head pack.
import { l2StatusForDebug, l2StatusSummary } from './segments/l2.js';
// Session-start identity (task-117 v3): the host's own question card, asked from
// agent/pre-step, bound per session and used by every later v3 call.
import { installSessionIdentity, SessionIdentityStore, type UserQuestionsLike } from './session-identity.js';
// TDB service stack: `dsh-tdb-lifecycle` is the only thing that starts/stops it
// (task-26). This plugin keeps a thin same-origin proxy for the settings page.
import { registerLifecycleControl } from './lifecycle-control.js';
import { SESSION_INIT_MODULE, resolveUserSessionInitDecision } from './user-session-init.js';
import { SkillClient } from './skill-client.js';
// Tool surfaces are modules too: src/tools/*.ts self-register, and the loop in
// section 4 registers whatever the config leaves enabled.
import { enabledToolModules } from './tools/index.js';
import type { AgememContext, LoggerLike, ToolDefinitionShape, ToolsService } from './types.js';
import { extractTurnClaim, formatVolatileBlock, installVolatile, type VolatileTurnContext } from './volatile.js';
import { computeScene, formatSceneLine } from './scene.js';
import { toToolEvents } from './tool-events.js';
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
/**
 * The host's question service.
 *
 * Read through `reflect.get(name, false)` and never as a bare property: this
 * plugin declares `inject = ['systemPrompt']`, and the host's context proxy
 * throws `cannot get property "userQuestions" without inject` on a property
 * read of an undeclared service (measured in the task-117 e2e — the direct
 * read killed the picker and the session fell back to `source: skipped`).
 * `strict: false` also returns a service whose provider fiber is not (yet)
 * active, which is what a sibling entry composed later looks like from here.
 */
/**
 * Debug line for an unbound session. Two cases, two meanings — and the old
 * single message lied in the second one:
 *
 *  * a configured triple exists ⇒ this call really does use it (the session
 *    just has not picked an agent yet);
 *  * no triple (identity comes from the user key, which is still resolving, or
 *    failed) ⇒ the call carries NO isolation identity. Saying "using the
 *    configured triple" there sent a live e2e hunting a config bug that did not
 *    exist (measured 2026-11-01 01:52:21, resolution finished at :22.763).
 */
export function unboundIdentityMessage(hasConfiguredTriple: boolean): string {
  return hasConfiguredTriple
    ? 'agemem: session identity not bound yet; using the configured triple for this call'
    : 'agemem: session identity not bound yet and no configured triple; this call carries no isolation identity while the user key resolves';
}

/**
 * 绑定的三元组 → 人格卡的取卡目标。
 *
 * - 返回 identity 字符串：按它调接口取卡，成功后原子覆盖该会话的卡；
 * - 返回 `null`：「明确不关联」，清掉该会话的卡；
 * - 返回 `undefined`：这次没绑成，但也没有「不关联」的意思——保留现状。
 *
 * 三者必须分开。把「没绑成」并在「不关联」里，就会在切换人设的那一轮先清卡、
 * 等下一次绑定才补上，那一轮提示词里没有任何人格（2026-11-08 02:14 现场：
 * 02:14:15.990 清卡、02:14:23.491 才绑上 374 字符）。
 */
export function personaBindTarget(binding: {
  teamId: string;
  userId?: string;
  agentId?: string;
  associate?: boolean;
}): string | undefined | null {
  if (binding.associate === false) return null;
  if (binding.teamId === '') return undefined;
  return binding.teamId + '/' + (binding.userId ?? '') + '/' + (binding.agentId ?? '');
}

function questionService(ctx: AgememContext): UserQuestionsLike | undefined {
  try {
    const found = (ctx.reflect as { get?: (name: string, strict?: boolean) => unknown } | undefined)
      ?.get?.('userQuestions', false) as UserQuestionsLike | undefined;
    return found !== undefined && typeof found.ask === 'function' ? found : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Where the per-session bindings live. Next to the outbox by default: both are
 * this plugin's own state under DSH_HOME, and keeping them together means one
 * directory to delete when an operator wants a clean slate.
 */
function sessionStatePathFor(configured: string, outboxPath: string): string {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit !== '') return explicit;
  const outbox = typeof outboxPath === 'string' && outboxPath.trim() !== '' ? outboxPath.trim() : defaultOutboxPath();
  return join(dirname(outbox), 'session-identity.json');
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
  const { config, warnings } = resolvePluginConfig(rawConfig);
  // A desktop/GUI host has no readable stderr, so a debug install mirrors every
  // line into a file as well (see debug-log.ts). Constructed only when debug is
  // on: a plain install must not create files or directories.
  const debugLog = config.debug
    ? createDebugLog({ filePath: resolveDebugLogPath(config.debugLogFile, process.env) })
    : undefined;
  const log: LoggerLike | undefined = combineLoggers(ctx.logger, debugLog?.logger);
  // 端到端证据日志：常驻（不吃 config.debug）。记录「卡/轮次块到底注入了多少字节」，
  // 是 L2 证据；写失败只会让它自己静默，不影响注入（fail-open）。
  const injectionLog = createInjectionLog({
    onError: (error) => log?.warn?.('agemem: injection log disabled after a write failure', error),
  });
  log?.debug?.('agemem: persona injection log -> ' + injectionLog.path);
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
    // P1-B W3 观测面：一条工具事件被 Core 拒（形状/置信度/鉴权）时只报一次。
    'soul.event.failed': false,
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
  /** Every listener/effect this mount owns; drained on dispose (and by tests). */
  const disposers: Array<() => void> = [];
  // Session bindings live here (not in the box above): a binding overrides the
  // configured triple for ONE session and must never leak into the fallback
  // every other session relies on.
  /**
   * 这一次取卡该用哪个身份（task-32）。会话已有绑定就用绑定，否则退回挂载三元组
   * ——与 `identityFor` 完全同一口径，避免「记忆按 A 队取、卡按 B 队取」。
   * 空 teamId（显式「不关联」）返回 undefined，调用方据此清卡。
   */
  const cardIdentityOf = (sessionId: string): string | undefined => {
    const bound = identityStore.get(sessionId);
    const triple = bound ?? identity;
    if (triple.teamId === '') return undefined;
    return triple.teamId + '/' + (triple.userId ?? '') + '/' + (triple.agentId ?? '');
  };

  const identityStore = new SessionIdentityStore({
    statePath: config.identity.rememberSession ? sessionStatePathFor(config.identity.statePath, config.writeback.outboxPath) : undefined,
    log,
  });
  let warnedUnbound = false;
  let warnedNoIdentity = false;
  const client = new MemoryClient({
    baseUrl: config.server.baseUrl,
    maxRequestBytes: config.writeback.maxRequestBytes,
    maxResponseBytes: config.server.maxResponseBytes,
    apiKey: config.server.apiKey,
    apiKeyRef: config.server.apiKeyRef,
    identity,
    // Synchronous and IO-free by contract: this runs inside headers() on every
    // request. A miss is silent (debug once) and means "use the triple above".
    identityFor: (sessionId?: string) => {
      const bound = identityStore.get(sessionId);
      if (bound !== undefined) {
        // taskId is the optional fourth scope axis: absent (not '') when the
        // session did not pick a work item, so headers() omits the header.
        return {
          serviceId: identity.serviceId,
          teamId: bound.teamId,
          agentId: bound.agentId,
          userId: bound.userId,
          ...(bound.taskId !== undefined ? { taskId: bound.taskId } : {}),
        };
      }
      // Two different cases used to share one line, and the misleading one led a
      // live e2e down the wrong path: on a mount whose identity comes from the
      // user key there is no configured triple at all, yet the old text claimed we
      // were "using the configured triple" — the box was still empty and the call
      // carried no isolation headers.
      const hasConfiguredTriple = identity.teamId !== '' || identity.agentId !== '' || identity.userId !== '';
      if (hasConfiguredTriple) {
        if (!warnedUnbound && config.identity.askAtSessionStart) {
          warnedUnbound = true;
          log?.debug?.(unboundIdentityMessage(true));
        }
      } else if (!warnedNoIdentity) {
        warnedNoIdentity = true;
        log?.debug?.(unboundIdentityMessage(false));
      }
      return undefined;
    },
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
  /**
   * P1-B W3：把这一轮的工具调用逐条写成 soul 事件（tool / test / commit / rollback）。
   *
   * 三条纪律：
   *  1. 只在这一轮的 L0 写回**成功之后**发（见下面 Outbox deliver）：对话正文都没落地时，
   *     「我跑过这条命令」单独出现在记忆里会前后不搭。
   *  2. fire-and-forget：不 await、不重投、不塞 Outbox。事件自带 dedupe_key，重复投递
   *     只会被判 duplicate；而观测面的失败绝不该让 turn 变慢或失败。
   *  3. 单条 try/catch + warnOnce('soul.event.failed')：一轮几十次工具调用全被拒时只报一行。
   */
  const reportToolEvents = (payload: TurnEndPayload): void => {
    let batch: ReturnType<typeof toToolEvents>;
    try {
      batch = toToolEvents(payload.toolCalls, payload.sessionId);
    } catch (error) {
      // 纯函数不该抛；真抛了也只是少一批事件，不影响回合。
      log?.debug?.('agemem: tool events not built', error);
      return;
    }
    if (batch.skipped > 0) {
      // 只计数不发：没有 result 的调用没有证据（见 tool-events.ts 的跳过说明）。
      log?.debug?.('agemem: tool calls not reported (no result / callId / sessionId)', { skipped: batch.skipped });
    }
    if (batch.events.length === 0) return;
    void (async () => {
      for (const event of batch.events) {
        try {
          await client.postSoulEvent(event, payload.sessionId);
        } catch (error) {
          warnOnce(
            'soul.event.failed',
            'agemem: soul tool event rejected by the core ('
            + (error instanceof Error ? error.message : String(error))
            + ' on /v3/soul/event); not retried — the payload carries a dedupe_key, so a replay '
            + 'would only be answered as a duplicate',
          );
        }
      }
    })();
  };

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
  // 3d. The user-level session_init config decides whether a card appears at
  //     all (the picker reads it at the first pre-step) AND — before any session
  //     exists — whether background reads may touch team-scoped data at all.
  //     Mount reads it once, like MemoryProxy does at its own ask stage
  //     (MemoryProxy/src/session/init.ts:943-953), and hands that value to the
  //     FIRST session that asks for it: a one-session run costs exactly one
  //     read, while a second session still sees a config change (no TTL cache
  //     that would silently pin a stale preference for the process lifetime).
  let sessionInitHandoff: { userId: string; value: Record<string, string> | null } | undefined;
  const readSessionInit = async (input: { userKey: string; userId: string; timeoutMs?: number }): Promise<Record<string, string> | null> => {
    if (sessionInitHandoff !== undefined && sessionInitHandoff.userId === input.userId) {
      const { value } = sessionInitHandoff;
      sessionInitHandoff = undefined;
      return value;
    }
    return client.getUserSessionInit(input.userId, SESSION_INIT_MODULE, { userKey: input.userKey, timeoutMs: input.timeoutMs });
  };
  // Background warmup (embedding prewarm + the mount-time head pack) reads
  // team-scoped data BEFORE the user answered anything. A user whose config says
  // default_associate=0 (bypass) asked for exactly the opposite, so keep those
  // reads out of the process entirely. Anything else — including a failed read —
  // fails OPEN: losing the warmup costs one cold turn, losing team data for
  // someone who opted out cannot be undone.
  let warmupGate: Promise<boolean> | undefined;
  const warmupAllowed = (): Promise<boolean> => {
    if (warmupGate === undefined) warmupGate = computeWarmupAllowed();
    return warmupGate;
  };
  const computeWarmupAllowed = async (): Promise<boolean> => {
    if (!config.identity.followUserSessionInit) return true;
    const userId = identity.userId.trim();
    if (userId === '') return true;
    const userKey = mountUserKey ?? (await resolveUserKey()) ?? '';
    let values: Record<string, string> | null = null;
    try {
      values = await client.getUserSessionInit(userId, SESSION_INIT_MODULE, { userKey, timeoutMs: IDENTITY_RESOLUTION_BUDGET_MS });
    } catch {
      values = null;
    }
    sessionInitHandoff = { userId, value: values };
    if (resolveUserSessionInitDecision(values).kind !== 'bypass') return true;
    log?.debug?.('agemem: background warmup skipped, the user config says default_associate=0 (bypass)');
    return false;
  };
  // 3c. Session-start identity (task-117 v3).
  //
  //     Registered BEFORE the volatile block, and both listeners use
  //     {prepend:true}. Do NOT rely on that ordering: the host may unshift
  //     prepended listeners (later registration runs first), and nothing in
  //     the event API promises a fixed rank. Two properties make the order
  //     irrelevant instead: the picker de-dupes per session (inFlight) and
  //     volatile awaits sessionIdentity.ensureBound() before asking for the
  //     recall block. So whichever runs first, there is at most one card, and
  //     the block of the step that follows a pick already carries the new
  //     identity; a step that raced the card falls back to the configured
  //     triple for that one step only.
  /**
   * 人格卡（task-32）：每会话一份，绑定即取卡，不落盘、不预热。
   *
   * 会话键必须是 picker 绑定时用的那一个（ids.ts 的 agentKey 取
   * `agent.session.id`）——这里先查 pre-step 登记过的映射，再依次探测
   * agent.session.id / agent.sessionId / agent.id，并把命中的字段写进
   * section-read 的 sidField，第一轮真实运行就能看出宿主给的是哪个。
   * 拿不到 agent 就返回 undefined：persona-card 会记 sidSource:'none' 并注入空串。
   * 这里没有、也不允许有「最近绑定会话」的兜底——并发会话下那就是串卡的来源。
   */
  /**
   * 会话键（task-32）。宿主自己强制了这个不变量，不是猜的：
   * `@deepseek-ai/dsh-agent/lib/types/index.js:242-245` 的 AgentRegistry.enter() 里
   *   `const id = agent.id; if (id !== agent.session.id) throw ...`；
   * 且 section 的 text 由 `assembleContextFor(agent, signal)` 以
   * `{ agent, scope: agent, signal }` 调用，所以 `context.agent` 就是那个
   * Agent，`agent.id === sessionId`。取不到只可能是宿主换了 API：记 none。
   */
  const sessionIdOf = (agent: unknown): string | undefined => {
    const candidate = agent as { id?: unknown; session?: { id?: unknown } } | undefined;
    const byAgent = typeof candidate?.id === 'string' && candidate.id !== '' ? candidate.id : undefined;
    if (byAgent !== undefined) return byAgent;
    const bySession = typeof candidate?.session?.id === 'string' && candidate.session.id !== '' ? candidate.session.id : undefined;
    return bySession;
  };
  const resolveSession = (context: unknown): { sessionId: string; source: 'context-agent'; field: string } | undefined => {
    const agent = (context as { agent?: unknown } | undefined)?.agent;
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return undefined;
    const field = (agent as { id?: unknown } | undefined)?.id === sessionId ? 'agent.id' : 'agent.session.id';
    return { sessionId, source: 'context-agent', field };
  };
  /** 绑定触发的取卡：onBound 只登记，这里等它完成（失败也算完成）。 */
  const pendingBinds = new Map<string, Promise<void>>();
  /**
   * P2-C：把 Core 说的「这张卡过滤到谁」记进会话绑定。
   *
   * 只在**恰好一个人**时写：0 个（不过滤/只剩全局行）或多于 1 个（多人同场）
   * 都清空 —— 与 Core 侧 human 行的裁决同一口径，不猜。写的是 Core 回显的
   * person_key，不是插件推导的名字。
   */
  const recordPersonKey = (sessionId: string, persons: readonly string[] | undefined): void => {
    const binding = identityStore.get(sessionId);
    if (binding === undefined) return;
    const key = persons !== undefined && persons.length === 1 ? persons[0] : undefined;
    if (binding.personKey === key) return;
    try {
      identityStore.set(sessionId, { ...binding, ...(key === undefined ? { personKey: undefined } : { personKey: key }) });
    } catch {
      // 会话绑定的持久化是 fail-open 的：写盘失败不能影响这一轮对话。
    }
  };
  /**
   * 触发一次取卡并登记，供 ensureIdentity 等待（task-32）。
   *
   * bind() 自己 fail-open；这里 `catch` 只是不让意外异常冒到 picker 上。
   * 同一会话只保留最后一次的 promise（新的覆盖旧的），等待方拿到的永远是最新一次。
   */
  const trackBind = (sessionId: string, identity: string | undefined): Promise<void> => {
    const task = personaCard.bind(sessionId, identity).then((outcome) => {
      // P2-C：绑定成功才有「这张卡过滤到谁」这个事实；失败保留旧绑定不动。
      if (outcome.ok) recordPersonKey(sessionId, outcome.persons);
    }, () => {});
    pendingBinds.set(sessionId, task);
    void task.finally(() => {
      if (pendingBinds.get(sessionId) === task) pendingBinds.delete(sessionId);
    });
    return task;
  };

  const sessionIdentity = installSessionIdentity(ctx, {
    settings: {
      askAtSessionStart: config.identity.askAtSessionStart,
      followUserSessionInit: config.identity.followUserSessionInit,
      askTimeoutMs: config.identity.askTimeoutMs,
      rememberSession: config.identity.rememberSession,
      skipDefault: config.identity.skipDefault,
      // The proxy's third question (task_select): the answer becomes the
      // optional x-tdai-task-id scope. Off = never ask, never send it.
      askForTask: config.identity.askForTask,
      statePath: config.identity.rememberSession ? sessionStatePathFor(config.identity.statePath, config.writeback.outboxPath) : '',
    },
    base: identity,
    resolveUserKey,
    candidates: (input) => listCandidates({
      client,
      userKey: input.userKey,
      teamId: input.teamId,
      timeoutMs: input.timeoutMs,
      log,
    }),
    // Same source the proxy's init reads (spec §5): the per-user session_init
    // module. Failures are null and the picker turns them into 'ask'.
    getUserSessionInit: (input) => readSessionInit(input),
    store: identityStore,
    getQuestions: () => questionService(ctx),
    // Same budget the mount-time resolution uses: three metadata calls, bounded.
    timeoutMs: Math.min(config.server.requestTimeoutMs, IDENTITY_RESOLUTION_BUDGET_MS),
    log,
    onSessionSeen: (sessionId) => {
      latestSessionId = sessionId;
      // 会话第一次出现就取一次卡（task-32）。picker 未配置 userKey 时是惰性的
      // ——ensureBound 直接返回、onBound 永远不触发；没有这一支，这类部署的
      // 每个会话都会没有卡。已经有卡的会话不再重取（覆盖只发生在重新绑定）。
      if (personaCard.snapshot(sessionId) === undefined && !pendingBinds.has(sessionId)) {
        trackBind(sessionId, cardIdentityOf(sessionId));
      }
    },
    onBound: (sessionId, binding) => {
      // The head pack is frozen once fetched; it was built with the mount triple,
      // so a session that just got bound must refetch instead of serving the
      // wrong team's persona/scene index for the rest of the session.
      headPack.invalidate();
      void headPack.refresh();
      // 人格卡（task-32）：绑定完成的这一刻取卡，并**覆盖**该会话上一份。
      // 三种结果见 personaBindTarget 的注释：取卡 / 清卡 / 保留现状。
      const target = personaBindTarget(binding);
      if (target === undefined) {
        log?.debug?.('agemem: binding skipped, keeping the session card', {
          sessionId,
          source: binding.source,
          reason: binding.reason,
        });
        return;
      }
      trackBind(sessionId, target ?? undefined);
    },
  });
  disposers.push(() => sessionIdentity.dispose());
  // The settings page's "TDB 服务栈" reads `/tdb-lifecycle/*` on this origin; the
  // proxy forwards it to the lifecycle bundle's loopback control plane. Nothing
  // here spawns, probes or stops a service.
  registerLifecycleControl(ctx, log);
  // Transport for the skill surface (src/skill-client.ts): the same v3 seam as
  // every other call, so identity headers, envelope unwrapping and the API key
  // have exactly one implementation.
  const skillClient = new SkillClient({
    call: (path, body, options) => client.v3(path, body, options),
    timeoutMs: config.skill.timeoutMs,
    // Skill reads/writes run inside a turn, so they travel with the identity
    // that turn's session was bound to (falls back inside the client).
    sessionId: () => latestSessionId,
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
    // An opted-out user (session_init default_associate=0) must cause no
    // team-scoped read at all -- not at mount, not on turn/start, not from the
    // section render. One gate inside the pack covers every one of those paths.
    allowFetch: warmupAllowed,
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
    // A session deliberately without an identity triple — the user picked
    // "否，本次不关联" or their session_init config says default_associate=0 —
    // did not fail: /v3/recall was skipped on purpose, so nothing is broken and
    // nothing should be injected. Keep it at debug so a bypass user does not see
    // an error-looking warn on every launch.
    if (typeof result.reason === 'string' && result.reason.startsWith('identity missing')) {
      log?.debug?.('agemem: /v3/recall skipped, this session associates no assets (' + result.reason + ')');
      return;
    }
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
        // Opted-out users (session_init default_associate=0) never get here: the
        // warmup itself is a team-scoped read.
        if (!(await warmupAllowed())) return;
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
  // 2a. 人格卡（spec v3.7 §2，S2）：通道 A 整卡进稳定前缀，通道 B 每轮尾部
  // 追加心境 + 未完的事。两条都是只读、fail-open：Core 读不到时保持上一版文本
  // （冷启动就是空串），不阻断会话。
  //
  // 冻结语义（task-32）：每个会话各自一份卡，写入时刻只有两个——会话绑定
  // agent（onBound）与压缩后重取；其余时间 section getter 只读那一份，所以
  // 同一会话内 system prompt 的前缀字节不变（判据 3）。不同会话各自的卡互不
  // 影响，也互不共用。
  const personaCard: PersonaCardHandle = createPersonaCard({
    enabled: true,
    // task-11：走留因版读卡——失败要能区分「Core 没设定人格卡」（empty）与
    // 「取卡坏了」（http_status/timeout/parse），否则排障时两者是同一条日志。
    fetchCard: async (sessionId?: string) => {
      const result = await client.soulCardDetailed({
        timeoutMs: Math.min(2000, config.server.requestTimeoutMs),
        sessionId,
      });
      if (!result.ok) return { reason: result.reason, status: result.status };
      return result.card;
    },
    // P2-C：带会话键取卡 —— Core 用 session 反查该会话最近一条事件的
    // `persons_json`，把 `human` 层过滤到真正在场的人。participants 不传：
    // 插件没有可靠的 person_key 来源，猜名字的代价是把卡切错或清空。
    fetchCardWithParams: async (params: { sessionId?: string; participants?: string[] }) => {
      const result = await client.soulCardDetailed({
        timeoutMs: Math.min(2000, config.server.requestTimeoutMs),
        sessionId: params.sessionId,
        participants: params.participants,
      });
      if (!result.ok) return { reason: result.reason, status: result.status };
      return result.card;
    },
    fetchTurn: (sessionId?: string) => client.soulTurn({
      timeoutMs: Math.min(800, config.server.requestTimeoutMs),
      sessionId,
    }),
    timeoutMs: Math.min(2000, config.server.requestTimeoutMs),
    // task-13：卡真进了前缀才回报（只带 version/hash/chars）。不 await——
    // 回报是观测面，不能拖慢会话初始化，也不能因失败影响注入。
    reportInjection: (payload) => {
      void client.reportSoulInjection({ ...payload, phase: 'card' });
    },
    injectionLog,
    // task-32：section getter 靠它把卡落到**当前**会话上（宿主拼提示词时
    // 传进来的 agent）。取不到会话键就注入空串——没有「最近绑定会话」兜底。
    resolveSession,
    log,
  });
  try {
    const base = ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? DEPLOYMENT_PERSONA_SUFFIX_ORDER;
    // P1-2：installSection 内部注册**两个** section —— 身份段固定 order 110
    // （PERSONA_IDENTITY_ORDER，靠前），末尾锚沿用这里的尾部 order
    // （base + orderOffset + 2，历史之后仍要保留的提醒）。返回值是组合 disposer。
    disposers.push(personaCard.installSection(ctx, base + config.headPack.orderOffset + 2));
    // task-32：这里**不**取卡。取卡的唯一时机是「会话选好 agent、绑定完成」，
    // 由 onBound 触发；启动时预热会拿到上一次会话/挂载三元组的卡，正是串卡来源。
  } catch (error) {
    log?.warn?.('agemem: persona card section registration failed; continuing without it', error);
  }
  /**
   * 会话身份与卡的唯一解析时机：`agent/created`（task-34，规范形态）。
   *
   * 宿主的 system prompt 是「先同步求值每个 section，再进 waterfall」
   * （@deepseek-ai/dsh-system-prompt/lib/index.js:384-398）。选 agent 的弹窗原先挂在
   * `agent/pre-step`，那是 step1 的提示词已经定稿之后 —— 2026-11-08 18:14 的证据：
   * `section-read chars=0 reason=no-card boundCount=0`，31ms 后才 `card-bound`。
   *
   * `agent/created` 在 turn 之前触发（@deepseek-ai/dsh-agent/lib/index.js:581
   * `announce()`），且实测能在 turn 之外弹窗并等到人的选择（18:35:04 那条
   * `bind-probe ms=12127`）。卡因此在**第一次 assemble 之前**就进了 map，section
   * getter 成为唯一渲染者 —— 不再需要任何「事后补写提示词」的路径。
   *
   * 四种走法，都是现取、都不读缓存：
   *   - 已经有卡：不动（同一会话的后续 turn 不会二次取卡）；
   *   - 已有绑定（重启后恢复的会话）：按绑定取卡，不再问人；
   *   - 子会话（fork/压缩产生，`parentSession`）：继承父会话的绑定，不问人；
   *   - 其余（真正的用户新会话）：走 ensureBound 弹窗，取卡由 onBound → trackBind 完成。
   */
  const bindAtCreated = async (agent: unknown, signal: unknown): Promise<string> => {
    const sid = sessionIdOf(agent);
    if (sid === undefined) return 'no-session-id';
    if (personaCard.currentFor(sid) !== '') return 'already-held';
    const header = (agent as { session?: { header?: { parentSession?: unknown } } } | undefined)?.session?.header;
    const parentSid = typeof header?.parentSession === 'string' ? header.parentSession : undefined;
    if (parentSid !== undefined) {
      // 分支（fork/压缩）：静默继承父会话 —— 不弹窗、也不重取一张别的卡。
      //
      // 1) 身份：把父绑定原样写进子会话，记忆捕获与召回因此仍落在同一个
      //    team/user/agent 池里（同一段对话，同一套身份）。父绑定若带
      //    associate:false，子会话跟着不捕获 —— 与父会话保持一致。
      // 2) 卡：优先直接复制父会话那份冻结字节（零网络、逐字节相同）；父会话
      //    这份卡不在内存时（父会话来自上一次进程）按父身份重取一张，仍是
      //    「继承身份」，只是补字节，不问人。
      const parentBinding = identityStore.get(parentSid);
      if (parentBinding !== undefined) {
        identityStore.set(sid, { ...parentBinding, source: 'inherited', reason: 'branch of ' + parentSid, at: Date.now() });
      }
      if (personaCard.inheritFrom(parentSid, sid)) return `inherited-bytes`;
      const inherited = cardIdentityOf(parentSid);
      if (inherited === undefined) return 'child-without-identity';
      const outcome = await personaCard.bind(sid, inherited);
      if (outcome.ok) recordPersonKey(sid, outcome.persons);
      return outcome.ok ? 'inherited-from-parent' : 'inherited-failed:' + outcome.reason;
    }
    if (identityStore.get(sid) !== undefined) {
      const outcome = await personaCard.bind(sid, cardIdentityOf(sid));
      if (outcome.ok) recordPersonKey(sid, outcome.persons);
      return outcome.ok ? 'restored' : 'restored-failed:' + outcome.reason;
    }
    await sessionIdentity.ensureBound(agent, signal);
    const pending = pendingBinds.get(sid);
    if (pending !== undefined) await settleWithin(pending, config.server.requestTimeoutMs);
    return 'picked';
  };
  try {
    disposers.push(ctx.on('agent/created', (payload: { agent?: unknown; signal?: unknown } | undefined) => {
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return;
      const sid = sessionIdOf(agent);
      const startedAt = Date.now();
      void (async () => {
        let reason: string;
        try {
          reason = await bindAtCreated(agent, payload?.signal);
        } catch (error) {
          reason = 'threw:' + (error instanceof Error ? error.message : String(error));
        }
        let chars = 0;
        try {
          chars = sid === undefined ? 0 : personaCard.currentFor(sid).length;
        } catch {
          // 只是诊断读数，读失败不影响绑定结果。
        }
        recordInjection(injectionLog, {
          event: 'bind-probe',
          sessionId: sid,
          chars,
          reason,
          ms: Date.now() - startedAt,
        });
      })();
    }));
  } catch (error) {
    log?.warn?.('agemem: agent/created bind unavailable; personas will only bind at pre-step', error);
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
      // The pack itself refuses the fetch for an opted-out user (see allowFetch).
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
  /** Per-turn ceiling for the memory slice. The 6000 total also pays for the
   * capability segments and the persona turn block, so the memories keep their
   * historical 1500 budget instead of silently growing into that space. */
  const MEMORY_CEILING_CHARS = 1500;
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
  /**
   * 阶段 4 / P4-B：场合氛围的接线（按轮变化，所以进 volatile 尾部，不进稳定前缀）。
   *
   * 为什么不用 `systemPrompt.context`：插件侧 SDK 里它的签名是
   * `context?(options: {name, order, text: string})`（`src/types.ts:38`），只有静态
   * 文本、没有按轮求值的入口；而 volatile 本来就是「每轮追加在尾部」的通道，
   * 还带预算、去重与注入量回报。把这一行放进 volatile 不用新开通道，也不动前缀。
   *
   * TTL 600s：同一会话 10 分钟内话术不变（spec §6 P4-B），避免每轮重算与日志噪音；
   * 超过 TTL 或本轮明显更「收」/更「松」时才重算——重算判据只看档位，不看分数。
   */
  const sceneMemo = new Map<string, { at: number; tone: string; line: string }>();
  const sceneRecent = new Map<string, { at: number; texts: string[] }>();
  const SCENE_MEMO_TTL_MS = 600_000;

  const sceneLineFor = (sessionId: string, turnText: string): string => {
    try {
      const now = Date.now();
      const prev = sceneRecent.get(sessionId);
      const gapMs = prev === undefined ? undefined : now - prev.at;
      const recentUserTexts = prev?.texts ?? [];
      const result = computeScene({ lastUserText: turnText, recentUserTexts, gapMs });
      const texts = [...recentUserTexts, turnText].slice(-5);
      sceneRecent.set(sessionId, { at: now, texts });
      const memo = sceneMemo.get(sessionId);
      if (memo !== undefined && now - memo.at < SCENE_MEMO_TTL_MS && memo.tone === result.tone) {
        return memo.line;
      }
      sceneMemo.set(sessionId, { at: now, tone: result.tone, line: formatSceneLine(result) });
      log?.debug?.('agemem: scene', { tone: result.tone, chars: result.line.length, score: result.signals.score });
      return formatSceneLine(result);
    } catch {
      // 场合行是锦上添花：算不出来就不注入，绝不影响本轮。
      return '';
    }
  };

  const fetchBlock = async (turnText: string, context: VolatileTurnContext): Promise<VolatileBlock> => {
    const started = Date.now();
    let base: VolatileBlock = { text: '', source: 'none', entriesKept: 0 };
    // 通道 B（spec §2 / 判据 4）：心境 + 未完的事，≤400 字符，追加在块尾。
    // 先取它才能给记忆留出预算，否则一段长记忆会把这一轮的心境挤掉。
    const personaTurn = await personaCard.turnText(context.sessionId);
    // 阶段 4：场合行同样要在预算里先占位（它是固定 ≤60 字的一道指令）。
    const sceneLine = sceneLineFor(context.sessionId, turnText);
    const turnSlot = (personaTurn === '' ? 0 : personaTurn.length + 2) + (sceneLine === '' ? 0 : sceneLine.length + 2);
    if (config.volatile.recall && Date.now() >= recallUnavailableUntil) {
      const result = await client.recallBlock(turnText, {
        maxResults: config.volatile.recallMaxResults,
        sessionId: context.sessionId,
        timeoutMs: config.volatile.recallTimeoutMs,
      });
      if (result.ok) {
        // Memories keep their own ceiling: the persona card rides in the system
        // prompt, so the volatile block is memories and segments only.
        const memoryCeiling = Math.min(config.volatile.maxChars, MEMORY_CEILING_CHARS);
        const memoryBudget = Math.max(0, memoryCeiling - turnSlot);
        const memories = recallBlockText(result.block, memoryBudget);
        const text = memories;
        if (text !== '') {
          base = {
            text,
            source: 'recall',
            entriesKept: countEntries(memories),
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
        context.sessionId,
      );
      const text = formatVolatileBlock(recalled.hits, Math.max(0, config.volatile.maxChars - turnSlot));
      base = { text, source: text === '' ? 'none' : 'atomic', entriesKept: countEntries(text) };
    }
    const composed = await appendCapabilitySegments(base, turnText, started);
    // 阶段 4：场合行紧贴 persona 行之前（先定「怎么接」，再说「此刻心境」）。
    // 只在块里已经有东西时才附上：单独一条「场合」指令既没用（没有可接的内容），
    // 又会让 bypass 用户在本该零注入的回合收到一条消息（task-51 的判据）。
    const withScene =
      sceneLine === '' || composed.text === ''
        ? composed
        : {
            ...composed,
            text: composed.text + String.fromCharCode(10, 10) + sceneLine,
          };
    if (personaTurn === '') return withScene;
    // append-only：只在尾部加，绝不改写已有内容（判据 4）。整块仍受 volatile.maxChars
    // 约束，所以极端情况下裁掉的只会是尾部（最后一条记忆/片段），不会切断前缀。
    const joined = withScene.text === '' ? personaTurn : withScene.text + String.fromCharCode(10, 10) + personaTurn;
    return { ...withScene, text: clampBlockByLines(joined, config.volatile.maxChars) };
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
        // task-13：把本 step 真实 append 的字符数回报给 Core（跳过 = chars 0）。
        // fire-and-forget：catch 在 memory-client 内侧吞掉，这里不 await，不拖慢 pre-step。
        reportInjection: (payload) => {
          void client.reportSoulInjection({ ...payload, phase: 'volatile' });
        },
        injectionLog,
        // Second line of defence (task-117): the picker listener is registered
        // first, but a step that raced it must not recall with the mount triple.
        // task-32：绑定完成之后，人格卡要先就位——本会话第一个 turn 的
        // system prompt 必须已经是这张卡。ensureBound 之后等这次 bind 结束
        // （失败也算结束），最多等到 requestTimeoutMs，绝不退回启动时预热。
        ensureIdentity: async (agent, signal) => {
          const sid = sessionIdOf(agent);
          await sessionIdentity.ensureBound(agent, signal);
          const pending = sid === undefined ? undefined : pendingBinds.get(sid);
          if (pending !== undefined) await settleWithin(pending, config.server.requestTimeoutMs);
        },
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
            ...(block.extrasChars === undefined ? {} : { extrasChars: block.extrasChars }),
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
                // P1-B W3：对话正文落地之后，同一轮的工具调用才作为独立事件上报。
                // 不 await：事件面失败绝不影响 outbox 的投递结果与后面的 turn。
                reportToolEvents(payload);
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
          // 压缩会重建上下文：卡在这个点之后按**同一会话**重取（不换身份），
          // 新版本才可能进下一段前缀。
          if (latestSessionId !== undefined) void personaCard.refresh(latestSessionId);
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
    // off(config) is the explicit opt-out reading; bound(...)/inert(...) say what
    // the picker actually did in this process.
    + ', sessionIdentity=' + sessionIdentity.status()
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
