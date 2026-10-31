import type { AgememPaths } from './config.js';
import { classifyL2Failure, parseL2Outcome, type L2FetchOutcome } from './head-pack.js';
import type { LoggerLike } from './types.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  clampMaxResponseBytes,
  fetchJsonCapped,
} from './http-capped.js';
import {
  CORE_MAX_MESSAGE_CHARS,
  CORE_MAX_MESSAGES_PER_REQUEST,
  CORE_MAX_REQUEST_BYTES,
  CORE_MAX_SKILL_MESSAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_BYTES,
  chunkByByteBudget,
  fitMessageToByteBudget,
  jsonByteLength,
  truncateForCore,
} from './wire-limits.js';

/**
 * Thin HTTP client over the MemoryCore v3 data plane.
 *
 * Contract (verified live against http://127.0.0.1:8420, see
 * docs/ops/dsh-plugin-probe-report.md — the earlier `/v3/dsh/*` shape in the
 * spec had no implementation and is gone):
 *
 *   POST /v3/core/read          {team_id,agent_id,user_id}                    -> data.content
 *   POST /v3/atomic/search      {team_id,agent_id,user_id,query,limit}        -> data.items[]
 *   POST /v3/scenario/ls        {team_id,agent_id,user_id}                    -> data.entries[].path
 *   POST /v3/conversation/add   {team_id,agent_id,user_id,session_id,messages} -> data.accepted_ids[]
 *   POST /v3/conversation/delete{team_id,agent_id,user_id,session_ids}        -> data
 *   POST /v3/recall             {query,maxResults[,session_id]}              -> data.block (+ data.meta)
 *
 * `/v3/recall` is DS-RECALL-MERGE-001: the core runs the same performLayeredRecall
 * as its auto-recall hook (R7 layering + budget + conclusion layer + CAL C1
 * truncation) and returns one text block. It is **opt-in server-side**
 * (`v3Recall.enabled`, default false ⇒ 404), which is why every recall failure
 * has to fall back to /v3/atomic/search instead of going dark.
 *
 * Envelope is `{code,message,request_id,data}`; `code !== 0` is a failure — the
 * core answers some validation errors with HTTP 200 + `code: 40001`, so a
 * status check alone would report a rejected write as delivered.
 *
 * Isolation: team/agent/user are **headers** on every v3 route
 * (MemoryCore/src/gateway/v2-router.ts:189-193 answers 422 without them). The
 * older write paths also echo them in the body, where the schemas declare them;
 * /v3/recall does not declare them in its body, so it sends headers only.
 * Write paths additionally require `session_id`, `messages[].content` as a
 * plain string, and `messages[].timestamp` as an ISO string — this client
 * normalizes numeric/an offset stamp to UTC ISO before sending, and drops a
 * message whose stamp cannot be parsed instead of 400-ing the whole batch.
 *
 * Every method fails soft: transport errors, non-2xx, bad JSON, a non-zero
 * business code or a missing identity all yield `undefined`/`false` plus a
 * debug log, never a throw — a memory outage must not break a host turn.
 */

export interface RecallHit {
  id?: string;
  text: string;
  score?: number;
  /** Memory layer/type as reported by the core (`work_fact`, `episodic`, ...). */
  layer?: string;
  kind?: string;
}

export interface CoreReadResult {
  content: string;
  updatedAt?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * ISO 8601 string. The core only accepts `z.iso.datetime()` (a numeric epoch
   * or a '+08:00' offset is a 400 for the whole batch); addConversationResult
   * normalizes whatever it is handed and drops unparseable rows.
   */
  timestamp: string;
}

/**
 * Skill (L2) write face. Deliberately NOT the same wire shape as L0:
 * - `timestamp` is epoch **milliseconds** on the wire; the schema accepts an ISO
 *   string too (z.union, verified live), and this client converts to epoch ms;
 * - role also accepts tool_call / tool_result, which must carry
 *   `tool_name` + `tool_call_id` (the core rejects a pair with only one);
 * - the isolation ids must not contain '|' (Redis queue element separator).
 */
export type SkillConversationRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';

export interface SkillConversationMessage {
  role: SkillConversationRole;
  content: string;
  /** Epoch milliseconds on the wire; an ISO string is accepted and converted. */
  timestamp?: number;
  tool_name?: string;
  tool_call_id?: string;
}

/** Diagnosable skill-write result: a rejection keeps its status/reason. */
export interface SkillWriteResult {
  ok: boolean;
  status?: number;
  reason?: string;
  /** Present when the core archived the buffer (threshold reached). */
  archived?: unknown;
  /** Number of requests this write took (the skill batch is capped at 500). */
  chunks?: number;
  /** How many messages were clipped at the 8192-char wire limit. */
  truncated?: number;
  /** Non-zero when the core answered 200 with a business error code. */
  code?: number;
  /** Core message for that business rejection (already truncated for logs). */
  message?: string;
  /** Rows dropped because their timestamp could not be parsed. */
  invalid?: number;
  /**
   * Only true when the request never reached the core (fetch threw / connect
   * timeout) AND nothing was delivered yet. The skill buffer has no server-side
   * dedupe, so a replay after any response — even a 5xx — would double-count the
   * turn; the outbox dead-letters those instead of retrying.
   */
  retryable?: boolean;
}

/**
 * One /v3/recall answer. `block` is the rendered prompt fragment (soul-identity /
 * soul-feeling / relevant-memories); `status`/\`reason\` keep the failure
 * diagnosable (404 = endpoint disabled, 504 = gateway timeout).
 */
export interface RecallBlockResult {
  ok: boolean;
  block?: string;
  status?: number;
  reason?: string;
  /**
   * True when WE cancelled the request at recallTimeoutMs. Distinct from a
   * network failure so the caller can log/dead-letter them differently.
   */
  aborted?: boolean;
  meta?: Record<string, unknown>;
}

/** Outbox payload shape, owned by writeback.ts; the client only consumes it. */
export interface TurnEndPayload {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  turn: number;
  status: 'completed' | 'error';
  /**
   * Ordered conversation history for this turn, collected by writeback.ts
   * (user text filtered on `source.kind === 'user'`, the plugin's own injected
   * block skipped, ISO timestamps). This is the single source for the v3 write
   * face — the client sends it verbatim, it never rebuilds it.
   */
  messages: ConversationMessage[];
  assistantText: string;
  toolCalls: Array<{ name?: string; callId?: string; arguments?: unknown; result?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  endedAt: string;
}

export interface MemoryIdentity {
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
}

/** A rejected API key: the one failure that must be diagnosable, not just absent. */
export interface AuthFailure {
  /** Endpoint path that rejected the key. */
  path: string;
  /** 401 or 403. */
  status: number;
}

export interface MemoryClientDeps {
  /** Core origin, e.g. http://127.0.0.1:8420 (trailing slashes stripped). */
  baseUrl: string;
  /**
   * Inline key (wins over the credentials ref). Empty means "resolve the ref".
   * Kept here rather than only in the ref so a desktop profile without a
   * credentials store can still authenticate.
   */
  apiKey?: string;
  /** Credentials reference name (never the secret itself). */
  apiKeyRef: string;
  identity: MemoryIdentity;
  requestTimeoutMs: number;
  /**
   * Byte budget for one request body. The core destroys an oversized body
   * before answering (no 413 reaches the client), so this is enforced on the
   * payload: default 700000, ceiling 1000000.
   */
  maxRequestBytes?: number;
  /**
   * Byte cap for ONE response body. The plugin runs inside the host process, so
   * an unbounded response (proxy error page, wrong URL) is a host-wide memory
   * hazard; default 2 MiB, ceiling 16 MiB. See src/http-capped.ts.
   */
  maxResponseBytes?: number;
  paths: AgememPaths;
  resolveApiKey: () => Promise<string | undefined>;
  /**
   * Inline user key (task-69). Same precedence rule as apiKey: a non-empty
   * inline value wins, otherwise resolveUserKey is asked. The user key is NOT
   * an authentication secret for the transport — it is the identity the core's
   * ownership check (task-60) keys on, so a missing value must omit the header
   * entirely rather than send an empty one.
   */
  userKey?: string;
  /**
   * Resolves the user key from server.userKeyRef (never the secret itself).
   * Optional so a client built without identity wiring simply sends no
   * x-tdai-user-key header.
   */
  resolveUserKey?: () => Promise<string | undefined>;
  /**
   * Called for every 401/403. The transport still returns `undefined` (fail
   * open) so a bad key degrades to "no memory", but the caller can now say why.
   * Dedupe/warn-once policy belongs to the caller.
   */
  onAuthFailure?: (failure: AuthFailure) => void;
  log?: LoggerLike;
  fetchImpl?: typeof fetch;
}

export interface RecallCombined {
  hits: RecallHit[];
  persona?: string;
  scenarios: string[];
}

export interface RecallCombinedOptions {
  includePersona?: boolean;
  includeScenarios?: boolean;
}

/** One team as the identity flow needs it (metadata listTeamsByUser). */
export interface TeamSummary {
  teamId: string;
  name?: string;
}

/** One agent as the identity flow needs it (metadata listAgentsByOwner). */
export interface AgentSummary {
  agentId: string;
  name?: string;
  teamId?: string;
}

/** Result of POST /v3/meta/auth/verify. */
export interface UserKeyVerification {
  ok: boolean;
  /** false = the core answered, the key is simply not valid. */
  valid?: boolean;
  userId?: string;
  username?: string;
  status?: number;
  reason?: string;
}

/** A paginated metadata list, reduced to the fields the picker shows. */
export interface IdentityListResult<T> {
  ok: boolean;
  items: T[];
  total?: number;
  status?: number;
  reason?: string;
}

/**
 * Options for one v3 POST. An object (not positional booleans) because there
 * are now three independent knobs and a swapped boolean silently weakens a
 * security-relevant path.
 */
interface V3CallOptions {
  timeoutMs?: number;
  /** Extra request headers (e.g. x-tdai-session-id, x-tdai-user-key). */
  extraHeaders?: Record<string, string>;
  /**
   * Whether the body also echoes the isolation triple. The headers are ALWAYS
   * sent (see headers(), the single place that builds them); this only decides
   * the body. /v3/recall's schema lists neither team_id nor agent_id, so it
   * passes false. Never use it to drop the headers — that is what produced the
   * permanent 422 in task-37.
   */
  echoIsolationInBody?: boolean;
  /**
   * Data routes refuse to run without the triple (inert by design). Identity
   * resolution sets false: it exists precisely because the triple is missing.
   */
  requireIdentity?: boolean;
  /**
   * Report 401/403 to onAuthFailure (which warns about the CORE key). Metadata
   * routes set false: their 401 means "bad or missing user key", a different
   * secret, and pointing the operator at the core key would be misleading.
   */
  reportAuthFailure?: boolean;
}

interface Envelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface CoreReadData {
  content?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface AtomicSearchData {
  items?: unknown;
}

interface ScenarioListData {
  entries?: unknown;
}

const DEFAULT_HEADERS = { 'content-type': 'application/json' };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const SKILL_ROLES = new Set<string>(['user', 'assistant', 'tool_call', 'tool_result', 'system']);

/** Metadata pagination ceiling (MemoryCore pagination.ts: limit ∈ [1,100]). */
const META_LIST_LIMIT = 100;

function metaLimit(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return META_LIST_LIMIT;
  return Math.min(META_LIST_LIMIT, Math.max(1, Math.floor(requested)));
}

/**
 * The skill endpoint wants epoch milliseconds. Accept an ISO string too and
 * convert it, but never emit NaN/ISO — an unparseable stamp is simply omitted
 * (the field is optional), because the core rejects the whole batch otherwise.
 */
/**
 * Normalize a message stamp to the ONLY shape the L0 schema accepts,
 * `z.iso.datetime()` (MemoryCore/src/gateway/generated/schemas.ts:89):
 * a number / numeric string is read as epoch milliseconds, any parseable string
 * is re-emitted in UTC ('+08:00' → Z), and an unparseable value is dropped by
 * the caller instead of 400-ing its whole batch.
 */
function isoStamp(value: unknown, now: Date = new Date()): string | undefined {
  if (value === undefined || value === null) return now.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return now.toISOString();
    if (/^-?[0-9]+$/.test(trimmed)) {
      const numeric = new Date(Number(trimmed));
      return Number.isNaN(numeric.getTime()) ? undefined : numeric.toISOString();
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function skillTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseHits(raw: unknown): RecallHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: RecallHit[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() !== '') hits.push({ text: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = nonEmpty(record.content) ?? nonEmpty(record.text);
    if (text === undefined) continue;
    const layer = nonEmpty(record.type) ?? nonEmpty(record.layer);
    hits.push({
      text,
      id: nonEmpty(record.id),
      score: typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : undefined,
      layer,
      kind: nonEmpty(record.kind) ?? layer,
    });
  }
  return hits;
}

function parseScenarios(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') paths.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const path = nonEmpty((entry as Record<string, unknown>).path);
    if (path !== undefined) paths.push(path);
  }
  return paths;
}

/**
 * Failure reason for the rich scenario read, in the same vocabulary as
 * `classifyL2Failure` so the debug line reads `l2=fail:http_404` /
 * `l2=fail:timeout` for both the transport and the payload cases.
 */
function scenarioFailureReason(result: {
  status?: number;
  reason?: string;
  aborted?: boolean;
}): string {
  if (result.aborted === true) return 'timeout';
  if (typeof result.status === 'number' && result.status >= 400) return 'http_' + result.status;
  return classifyL2Failure(new Error(result.reason ?? 'error'));
}

export class MemoryClient {
  private readonly fetchImpl: typeof fetch;
  /** One-shot latch for resolveUserKeyOnce() (see there for why it never retries). */
  private userKeyResolved = false;
  private userKeyValue: string | undefined;

  constructor(private readonly deps: MemoryClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    const base = this.deps.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  /** Isolation triple; missing pieces mean "not configured", not "empty string". */
  private isolation(): Record<string, string> {
    const { teamId, agentId, userId } = this.deps.identity;
    return { team_id: teamId, agent_id: agentId, user_id: userId };
  }

  private missingIdentity(): string | undefined {
    const { teamId, agentId, userId } = this.deps.identity;
    if (nonEmpty(teamId) === undefined) return 'teamId';
    if (nonEmpty(agentId) === undefined) return 'agentId';
    if (nonEmpty(userId) === undefined) return 'userId';
    return undefined;
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...(extra ?? {}) };
    const { serviceId, teamId, agentId, userId } = this.deps.identity;
    const service = nonEmpty(serviceId);
    if (service !== undefined) headers['x-tdai-service-id'] = service;
    // Isolation triple as HEADERS: every v3 route validates them before the
    // handler (v2-router.ts:189-193 → 422 "missing team_id, agent_id, user_id").
    // This is the ONLY place they are attached, so /v3/recall cannot drift from
    // the write routes again — it used to rely on the body echo alone, which
    // this route never reads, and answered 422 on every turn in production.
    const team = nonEmpty(teamId);
    if (team !== undefined) headers['x-tdai-team-id'] = team;
    const agent = nonEmpty(agentId);
    if (agent !== undefined) headers['x-tdai-agent-id'] = agent;
    const user = nonEmpty(userId);
    if (user !== undefined) headers['x-tdai-user-id'] = user;
    // USER KEY as an identity header (task-69). The triple above says WHICH
    // store the request addresses; this says WHOSE memory inside it, which is
    // what the core's ownership check (task-60) needs. Three rules, all
    // deliberate:
    //   • only with the complete triple — the core skips the check without it,
    //     so the header would be noise;
    //   • never empty — a blank header reads as "identity supplied, and empty",
    //     which is worse than absent;
    //   • resolution failures degrade to "header omitted", never to a throw
    //     (this method feeds every call, including ones that need no identity).
    if (headers['x-tdai-user-key'] === undefined) {
      if (team !== undefined && agent !== undefined && user !== undefined) {
        try {
          const inline = nonEmpty(this.deps.userKey);
          const resolved = inline ?? await this.resolveUserKeyOnce();
          if (resolved !== undefined) {
            headers['x-tdai-user-key'] = resolved;
            // Presence only: this line is copied into issue reports, so the key
            // value must never reach it. The silent case (no key configured) is
            // deliberately unlogged — it is the default, not an incident.
            this.deps.log?.debug?.('agemem: x-tdai-user-key attached');
          }
        } catch (error) {
          this.deps.log?.debug?.('agemem: user key resolution failed; x-tdai-user-key omitted', error);
        }
      }
    }
    try {
      const key = nonEmpty(await this.deps.resolveApiKey());
      if (key !== undefined) headers.authorization = `Bearer ${key}`;
    } catch (error) {
      this.deps.log?.debug?.('agemem: credential resolution failed', error);
    }
    return headers;
  }

  /**
   * Resolve the user key at most ONCE per client. The credentials store is an
   * async seam (a keychain round-trip on the desktop host) and headers() runs on
   * every v3 call, so resolving per request would put that hop on the recall
   * path for a value the README already declares process-scoped ("改配置/凭据后
   * 要重启宿主"). A failure is cached too: retrying a missing or misconfigured
   * key on every call is the retry storm the rest of this file exists to avoid.
   */
  private async resolveUserKeyOnce(): Promise<string | undefined> {
    if (!this.userKeyResolved) {
      this.userKeyResolved = true;
      this.userKeyValue = nonEmpty(await this.deps.resolveUserKey?.());
    }
    return this.userKeyValue;
  }

  /** Byte budget per request body, clamped to the core ceiling. */
  private maxRequestBytes(): number {
    const configured = this.deps.maxRequestBytes;
    const value = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_MAX_REQUEST_BYTES;
    return Math.min(CORE_MAX_REQUEST_BYTES, Math.max(1, value));
  }

  /** Byte cap per response body, clamped to the shared ceiling. */
  private maxResponseBytes(): number {
    const configured = this.deps.maxResponseBytes;
    return typeof configured === 'number' && Number.isFinite(configured)
      ? clampMaxResponseBytes(configured)
      : DEFAULT_MAX_RESPONSE_BYTES;
  }

  private timeoutOf(timeoutMs?: number): number {
    const configured = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : this.deps.requestTimeoutMs;
    return Math.min(120_000, Math.max(100, Math.floor(configured)));
  }

  /**
   * POST one v3 call and unwrap the envelope, keeping the failure diagnosable.
   * Never throws.
   */
  private async call<T>(
    path: string,
    body: Record<string, unknown>,
    options: V3CallOptions = {},
  ): Promise<{
    ok: boolean;
    status?: number;
    reason?: string;
    data?: T;
    aborted?: boolean;
    /** Envelope business code (non-zero means rejected even on HTTP 200). */
    code?: number;
    /** Envelope message, truncated for logs. */
    message?: string;
  }> {
    // Data routes stay inert until the identity is complete. Identity RESOLUTION
    // (verify / team list / agent list) is the exception: it runs precisely
    // because the triple is still missing, and those routes do not want it.
    if (options.requireIdentity !== false) {
      const missing = this.missingIdentity();
      if (missing !== undefined) {
        this.deps.log?.debug?.(`agemem: ${path} skipped, identity missing (${missing})`);
        return { ok: false, reason: `identity missing (${missing})` };
      }
    }
    const timeout = this.timeoutOf(options.timeoutMs);
    // An explicit controller, not AbortSignal.timeout: we must know whether the
    // socket died or we cancelled it ourselves — the two have different
    // dead-letter semantics (a timeout is never replayed, a reset may be).
    const controller = new AbortController();
    let abortedByUs = false;
    const timer = setTimeout(() => {
      abortedByUs = true;
      controller.abort();
    }, timeout);
    try {
      // One capped read for every path: the plugin lives in the host process, so
      // an unbounded body would be a host-wide memory hazard. fetchJsonCapped
      // never throws and keeps the SAME observable branches this method had:
      // HTTP status, non-JSON, transport, and our own abort (timeoutMs: 0 — the
      // controller above owns cancellation so aborted-vs-reset stays
      // distinguishable for the outbox).
      const result = await fetchJsonCapped<Envelope<T>>(
        this.url(path),
        {
          method: 'POST',
          headers: await this.headers(options.extraHeaders),
          body: JSON.stringify(options.echoIsolationInBody === false ? body : { ...this.isolation(), ...body }),
          signal: controller.signal,
        },
        { maxBytes: this.maxResponseBytes(), timeoutMs: 0, fetchImpl: this.fetchImpl },
      );
      if (result.kind === 'http') {
        const status = result.status;
        // 401/403 is a configuration bug, not a transport hiccup: surface it so
        // the caller can warn once instead of pretending the core simply has no
        // memory. Every other status stays a silent fail-open.
        if ((status === 401 || status === 403) && options.reportAuthFailure !== false) {
          try {
            this.deps.onAuthFailure?.({ path, status });
          } catch (error) {
            this.deps.log?.debug?.('agemem: auth-failure hook threw', error);
          }
        }
        this.deps.log?.debug?.(`agemem: ${path} -> HTTP ${status}`);
        return { ok: false, status, reason: `HTTP ${status}` };
      }
      if (result.kind === 'too_large') {
        this.deps.log?.debug?.(
          `agemem: response too_large endpoint=${path} declared=${result.declared === undefined ? 'unknown' : String(result.declared)}`,
        );
        return { ok: false, reason: 'response too_large' };
      }
      if (result.kind === 'bad_json') {
        this.deps.log?.debug?.(`agemem: ${path} response was not JSON`, result.reason);
        return { ok: false, reason: 'response was not JSON' };
      }
      if (result.kind !== 'ok') {
        if (result.kind === 'timeout') {
          if (abortedByUs) {
            this.deps.log?.debug?.(`agemem: ${path} aborted after ${timeout}ms`);
            return { ok: false, reason: `timed out after ${timeout}ms`, aborted: true };
          }
          this.deps.log?.debug?.(`agemem: ${path} timed out after ${timeout}ms`);
          return { ok: false, reason: `timed out after ${timeout}ms` };
        }
        this.deps.log?.debug?.(`agemem: ${path} request failed`, result.reason);
        return { ok: false, reason: 'transport failure: ' + result.reason };
      }
      const envelope = result.json as Envelope<T> | undefined;
      if (!envelope || typeof envelope !== 'object') {
        this.deps.log?.debug?.(`agemem: ${path} response was not an envelope`);
        return { ok: false, reason: 'response was not an envelope' };
      }
      if (envelope.code !== 0) {
        const businessCode = typeof envelope.code === 'number' ? envelope.code : Number(envelope.code);
        const summary = typeof envelope.message === 'string' ? envelope.message.trim().slice(0, 200) : '';
        this.deps.log?.debug?.(`agemem: ${path} failed code=${String(envelope.code)} message=${summary}`);
        return {
          ok: false,
          code: Number.isFinite(businessCode) ? businessCode : undefined,
          message: summary === '' ? undefined : summary,
          reason: `code ${String(envelope.code)}` + (summary === '' ? '' : `: ${summary}`),
        };
      }
      const data = envelope.data;
      return { ok: true, data: (data !== null && typeof data === 'object' ? data : {}) as T };
    } catch (error) {
      if (abortedByUs) {
        this.deps.log?.debug?.(`agemem: ${path} aborted after ${timeout}ms`);
        return { ok: false, reason: `timed out after ${timeout}ms`, aborted: true };
      }
      const name = (error as { name?: string } | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        this.deps.log?.debug?.(`agemem: ${path} timed out after ${timeout}ms`);
        return { ok: false, reason: `timed out after ${timeout}ms` };
      }
      this.deps.log?.debug?.(`agemem: ${path} request failed`, error);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'transport failure: ' + detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST one v3 call and unwrap the envelope. Returns the `data` object, or
   * `undefined` for every failure mode (never throws).
   */
  /**
   * Public plumbing seam for feature modules that speak raw v3 routes
   * (src/skill-client.ts runs its reads/writes through this). Same headers,
   * same identity gate, same envelope unwrapping as every method above — one
   * transport, one place to fix. Returns the full result, never throws.
   */
  async v3<T>(
    path: string,
    body: Record<string, unknown>,
    options: { timeoutMs?: number; extraHeaders?: Record<string, string> } = {},
  ): Promise<{
    ok: boolean;
    status?: number;
    reason?: string;
    data?: T;
    aborted?: boolean;
    code?: number;
    message?: string;
  }> {
    return this.call<T>(path, body, {
      timeoutMs: options.timeoutMs,
      extraHeaders: options.extraHeaders,
    });
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T | undefined> {
    const result = await this.call<T>(path, body, { timeoutMs });
    return result.ok ? result.data : undefined;
  }

  /** L3 persona (head pack body). Missing persona reads as an empty string. */
  async readCore(timeoutMs?: number): Promise<CoreReadResult | undefined> {
    const data = await this.post<CoreReadData>(this.deps.paths.coreRead, {}, timeoutMs);
    if (data === undefined) return undefined;
    const updatedAt = nonEmpty(data.updated_at);
    return { content: typeof data.content === 'string' ? data.content : '', updatedAt };
  }

  /** L1 recall: natural-language query over atomic memories. */
  async searchAtomic(query: string, limit: number, timeoutMs?: number): Promise<RecallHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const safeLimit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 5)));
    const data = await this.post<AtomicSearchData>(
      this.deps.paths.atomicSearch,
      { query: trimmed, limit: safeLimit },
      timeoutMs,
    );
    if (data === undefined) return [];
    return parseHits(data.items).slice(0, safeLimit);
  }

  /** L2 scene index: the scenario file paths (may be empty).
   *
   * LEGACY shape for `recallCombined` and its older consumers: a failure is
   * flattened to `[]`, which is indistinguishable from "no scenes". Prompt
   * rendering must use `listScenariosRich()` below — the two states need
   * opposite operator responses.
   */
  async listScenarios(timeoutMs?: number): Promise<string[]> {
    const data = await this.post<ScenarioListData>(this.deps.paths.scenarioLs, {}, timeoutMs);
    if (data === undefined) return [];
    return parseScenarios(data.entries);
  }

  /**
   * L2 scene index WITH provenance (task-103): either the entries
   * (`{path, summary, updated}` — `path` is the bare filename the endpoint
   * returns) or the reason the call failed, never both and never a throw.
   *
   * Directory entries come back as `dir/`; the scene index lists files, so they
   * are dropped here instead of rendering a dangling `- scene_blocks/dir/` line.
   */
  async listScenariosRich(timeoutMs?: number): Promise<L2FetchOutcome> {
    const result = await this.call<ScenarioListData>(this.deps.paths.scenarioLs, {}, { timeoutMs });
    if (!result.ok) return { ok: false, reason: scenarioFailureReason(result) };
    const outcome = parseL2Outcome(result.data);
    if (!outcome.ok) return outcome;
    return { ok: true, entries: outcome.entries.filter((entry) => !entry.path.endsWith('/')) };
  }

  /**
   * The merged recall block (DS-RECALL-MERGE-001). Returns the rendered prompt
   * fragment plus, on failure, a diagnosable status/reason:
   * 404 = the endpoint is disabled server-side (`v3Recall.enabled: false`),
   * 504 = gateway timeout. Every caller falls back to searchAtomic on any
   * failure, so this never throws and never returns a partial block.
   *
   * Named recallBlock (not `recall`) because `recall()` above is the public
   * atomic-search alias the memory_recall tool already uses.
   */
  async recallBlock(
    query: string,
    options: { maxResults?: number; sessionId?: string; timeoutMs?: number } = {},
  ): Promise<RecallBlockResult> {
    const trimmed = query.trim();
    if (trimmed === '') return { ok: false, reason: 'empty query' };
    const requested = options.maxResults;
    const maxResults = Math.min(10, Math.max(1, Math.floor(Number.isFinite(requested as number) ? (requested as number) : 3)));
    const body: Record<string, unknown> = { query: trimmed, maxResults };
    const sessionId = nonEmpty(options.sessionId);
    const headers: Record<string, string> = {};
    if (sessionId !== undefined) {
      body.session_id = sessionId;
      // Session is optional on this route (live probe: body-only, header-only and
      // both all answer 200). Send both so a session-aware core can reuse the
      // idempotent conclusion layer while a stateless one ignores it.
      headers['x-tdai-session-id'] = sessionId;
    }
    // echoIsolationInBody=false: the recall body schema declares only
    // query/maxResults/session_id. The mandatory isolation triple still travels
    // as headers, like every other v3 route.
    const result = await this.call<{ block?: unknown; meta?: unknown }>(
      this.deps.paths.recall,
      body,
      { timeoutMs: options.timeoutMs, extraHeaders: headers, echoIsolationInBody: false },
    );
    if (!result.ok) return { ok: false, status: result.status, reason: result.reason, aborted: result.aborted };
    const raw = result.data?.block;
    const block = typeof raw === 'string' ? raw : '';
    if (block.trim() === '') return { ok: false, reason: 'empty recall block' };
    const meta = result.data?.meta;
    return {
      ok: true,
      block,
      meta: meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined,
    };
  }

  /**
   * The openclaw recall combination: L1 search + L3 persona + L2 scene index,
   * all issued in parallel and settled independently, so one failing leg never
   * removes the others. Mirrors MemoryCore/openclaw-plugin/src/hooks/recall.ts.
   */
  async recallCombined(query: string, limit: number, options: RecallCombinedOptions = {}, timeoutMs?: number): Promise<RecallCombined> {
    const [search, persona, scenarios] = await Promise.allSettled([
      this.searchAtomic(query, limit, timeoutMs),
      options.includePersona === true ? this.readCore(timeoutMs) : Promise.resolve(undefined),
      options.includeScenarios === true ? this.listScenarios(timeoutMs) : Promise.resolve([]),
    ]);
    return {
      hits: search.status === 'fulfilled' ? search.value : [],
      persona: persona.status === 'fulfilled' ? persona.value?.content : undefined,
      scenarios: scenarios.status === 'fulfilled' ? scenarios.value : [],
    };
  }

  /**
   * Backwards-compatible alias used by the recall tool and the volatile block.
   */
  async recall(query: string, topK: number, timeoutMs?: number): Promise<RecallHit[]> {
    return this.searchAtomic(query, topK, timeoutMs);
  }

  /**
   * L0 write: append one session's messages. Returns false (no throw) when the
   * core rejects the batch — e.g. a block array or a numeric timestamp.
   */
  async addConversation(sessionId: string, messages: ConversationMessage[], timeoutMs?: number): Promise<boolean> {
    const result = await this.addConversationResult(sessionId, messages, timeoutMs);
    return result.ok;
  }

  /**
   * Same write, but keeps the failure diagnosable (`status`/`reason`) so the
   * caller can warn once per failure class instead of guessing why a turn was
   * not written back.
   */
  async addConversationResult(
    sessionId: string,
    messages: ConversationMessage[],
    timeoutMs?: number,
  ): Promise<{
    ok: boolean;
    status?: number;
    code?: number;
    message?: string;
    reason?: string;
    chunks?: number;
    truncated?: number;
    invalid?: number;
  }> {
    const session = nonEmpty(sessionId);
    if (session === undefined) {
      this.deps.log?.debug?.('agemem: conversation/add skipped, empty session_id');
      return { ok: false, reason: 'empty session_id' };
    }
    const normalized: Array<{ role: string; content: string; timestamp: string }> = [];
    let truncated = 0;
    let invalid = 0;
    for (const message of messages) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const content = typeof message.content === 'string' ? message.content : '';
      if (content.trim() === '') continue;
      // Defense in depth: writeback already clips, but an outbox row written by
      // an older build (or a caller of this client directly) must not be able to
      // push a 400-inducing block onto the wire.
      const clipped = truncateForCore(content, CORE_MAX_MESSAGE_CHARS);
      if (clipped.truncated) truncated += 1;
      // The schema only accepts z.iso.datetime(): a numeric epoch or a '+08:00'
      // offset stamp 400s the WHOLE batch. writeback's isoOf only protects rows
      // written by this process, so normalize here — and drop one bad row rather
      // than lose the entire turn with it.
      const timestamp = isoStamp(message.timestamp);
      if (timestamp === undefined) {
        invalid += 1;
        continue;
      }
      normalized.push({ role: message.role, content: clipped.text, timestamp });
    }
    if (invalid > 0) {
      this.deps.log?.debug?.(`agemem: conversation/add dropped ${invalid} message(s) with an unparseable timestamp`);
    }
    if (normalized.length === 0) {
      this.deps.log?.debug?.('agemem: conversation/add skipped, nothing to write');
      return { ok: false, reason: 'nothing to write', invalid };
    }
    // Two independent limits: /v3/conversation/add rejects more than 100 messages
    // per request as a whole, and the core drops a body near 1 MiB by destroying
    // the socket (ECONNRESET, no 413). Both are enforced on the payload, so a
    // long turn becomes several ordered requests instead of one lost turn.
    const envelope = { ...this.isolation(), session_id: session };
    const envelopeBytes = jsonByteLength({ ...envelope, messages: [] }) - 2;
    const maxBytes = this.maxRequestBytes();
    const fitted: Array<{ role: string; content: string; timestamp: string }> = [];
    for (const message of normalized) {
      const fit = fitMessageToByteBudget(message, envelopeBytes, maxBytes);
      if (fit.truncated) truncated += 1;
      fitted.push(fit.message);
    }
    const chunks = chunkByByteBudget(fitted, {
      maxCount: CORE_MAX_MESSAGES_PER_REQUEST,
      maxBytes,
      envelopeBytes,
    });
    if (truncated > 0) {
      this.deps.log?.debug?.(
        `agemem: conversation/add clipped ${truncated} message(s) at the ${CORE_MAX_MESSAGE_CHARS}-char / ${maxBytes}-byte wire limits`,
      );
    }
    if (chunks.length > 1) {
      this.deps.log?.debug?.(`agemem: conversation/add sharded into ${chunks.length} requests`);
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await this.call<Record<string, unknown>>(
        this.deps.paths.conversationAdd,
        { session_id: session, messages: chunks[index] },
        { timeoutMs },
      );
      if (!result.ok) {
        const prefix = chunks.length > 1 ? `chunk ${index + 1}/${chunks.length}: ` : '';
        return {
          ok: false,
          status: result.status,
          code: result.code,
          message: result.message,
          reason: prefix + (result.reason ?? 'delivery rejected'),
          chunks: chunks.length,
          truncated,
          invalid,
        };
      }
    }
    return { ok: true, chunks: chunks.length, truncated, invalid };
  }

  /**
   * L2 write: append to the skill buffer (threshold archive → extractor →
   * scene_blocks). This is the SECOND, independent pipeline: L0 feeds L1 facts,
   * skill feeds L2 scenes. The wire shape differs from L0 on purpose —
   * `timestamp` is epoch milliseconds and tool pairs must carry
   * `tool_name` + `tool_call_id`. Rejections stay diagnosable (`status`,
   * `reason`) so the outbox can retry only what is retryable.
   */
  async skillConversationAdd(
    sessionId: string,
    messages: SkillConversationMessage[],
    timeoutMs?: number,
  ): Promise<SkillWriteResult> {
    const session = nonEmpty(sessionId);
    if (session === undefined) {
      this.deps.log?.debug?.('agemem: skill/conversation/add skipped, empty session_id');
      return { ok: false, reason: 'empty session_id' };
    }
    if (session.includes('|')) {
      // '|' is the Redis queue element separator; the core rejects such ids.
      this.deps.log?.debug?.("agemem: skill/conversation/add skipped, session_id contains '|'");
      return { ok: false, reason: "session_id must not contain '|'" };
    }
    for (const [field, value] of Object.entries(this.isolation())) {
      if (value.includes('|')) {
        this.deps.log?.debug?.(`agemem: skill/conversation/add skipped, ${field} contains '|'`);
        return { ok: false, reason: `${field} must not contain '|'` };
      }
    }
    const normalized: SkillConversationMessage[] = [];
    let truncated = 0;
    for (const message of messages) {
      if (!message || typeof message.content !== 'string') continue;
      if (!SKILL_ROLES.has(message.role)) continue;
      const content = message.content;
      if (content.trim() === '') continue;
      // 8192 is a deliberate product cap here, NOT a core limit: the skill schema
      // takes longer content (9000 chars verified live 200), but a bounded L2 input
      // keeps buffer archive + extractor cost predictable.
      const clipped = truncateForCore(content, CORE_MAX_MESSAGE_CHARS);
      if (clipped.truncated) truncated += 1;
      const entry: SkillConversationMessage = { role: message.role, content: clipped.text };
      if (message.role === 'tool_call' || message.role === 'tool_result') {
        const toolName = nonEmpty(message.tool_name);
        const callId = nonEmpty(message.tool_call_id);
        // Never invent a pair: a half-specified tool row would be rejected by
        // the core anyway, and a guessed id would corrupt the extractor.
        if (toolName === undefined || callId === undefined) continue;
        entry.tool_name = toolName;
        entry.tool_call_id = callId;
      }
      const timestamp = skillTimestamp(message.timestamp);
      if (timestamp !== undefined) entry.timestamp = timestamp;
      normalized.push(entry);
    }
    if (normalized.length === 0) {
      this.deps.log?.debug?.('agemem: skill/conversation/add skipped, nothing to write');
      return { ok: false, reason: 'nothing to write' };
    }
    // The skill schema allows 500 messages per request and has NO server-side
    // dedupe, so the batch is sharded at 500 (one request in practice) rather
    // than at the L0 limit: replaying an already-accepted chunk would feed the
    // extractor the same exchange twice and double the L2 buffer. The byte
    // budget applies here too — a 3.75 MB turn was reset by the core's socket
    // guard with no 413, so it never reached the extractor at all.
    const envelope = { ...this.isolation(), session_id: session };
    const envelopeBytes = jsonByteLength({ ...envelope, messages: [] }) - 2;
    const maxBytes = this.maxRequestBytes();
    const fitted: SkillConversationMessage[] = [];
    for (const message of normalized) {
      const fit = fitMessageToByteBudget(message, envelopeBytes, maxBytes);
      if (fit.truncated) truncated += 1;
      fitted.push(fit.message);
    }
    const chunks = chunkByByteBudget(fitted, {
      maxCount: CORE_MAX_SKILL_MESSAGES_PER_REQUEST,
      maxBytes,
      envelopeBytes,
    });
    let archived: unknown;
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await this.call<Record<string, unknown>>(
        this.deps.paths.skillConversationAdd,
        { session_id: session, messages: chunks[index] },
        { timeoutMs },
      );
      if (!result.ok) {
        const prefix = chunks.length > 1 ? `chunk ${index + 1}/${chunks.length}: ` : '';
        // Retrying is only safe when the request never reached the core AND no
        // earlier chunk was accepted. Any HTTP response (even a 502/503) may
        // already have mutated the buffer, so those must not be replayed.
        const retryable = index === 0
          && result.status === undefined
          && (result.reason?.startsWith('transport failure:') === true
            || result.reason?.startsWith('timed out after') === true);
        return {
          ok: false,
          status: result.status,
          code: result.code,
          message: result.message,
          reason: prefix + (result.reason ?? 'delivery rejected'),
          chunks: chunks.length,
          truncated,
          retryable,
        };
      }
      archived = result.data?.archived;
    }
    if (truncated > 0) {
      this.deps.log?.debug?.(
        `agemem: skill/conversation/add clipped ${truncated} message(s) at the ${CORE_MAX_MESSAGE_CHARS}-char wire limit`,
      );
    }
    if (chunks.length > 1) {
      this.deps.log?.debug?.(`agemem: skill/conversation/add sharded into ${chunks.length} requests`);
    }
    if (archived === undefined) return { ok: true, chunks: chunks.length, truncated };
    return { ok: true, archived, chunks: chunks.length, truncated };
  }

  /** L0 delete for one session (used by tests/ops, never on the turn path). */
  async deleteConversation(sessionId: string, timeoutMs?: number): Promise<boolean> {
    const session = nonEmpty(sessionId);
    if (session === undefined) return false;
    const data = await this.post<Record<string, unknown>>(
      this.deps.paths.conversationDelete,
      { session_ids: [session] },
      timeoutMs,
    );
    return data !== undefined;
  }

  // ---------------------------------------------------------------------
  // Identity resolution (task-51): one user key -> user -> teams -> agents.
  // All three are READ-ONLY metadata routes and every failure is fail-open.
  // ---------------------------------------------------------------------

  /**
   * POST /v3/meta/auth/verify { user_key } -> { valid, user }.
   *
   * This route is on the core's no-user-key list (auth.ts: V3_NO_USER_KEY_ROUTES)
   * but still requires the Bearer core key and x-tdai-service-id, which
   * headers() always attaches. A 401 here can only mean the CORE key is wrong,
   * so it is reported through the normal auth-failure hook.
   */
  async verifyUserKey(userKey: string, timeoutMs?: number): Promise<UserKeyVerification> {
    const key = nonEmpty(userKey);
    if (key === undefined) return { ok: false, reason: 'empty user key' };
    const result = await this.call<{ valid?: unknown; user?: unknown }>(
      this.deps.paths.metaAuthVerify,
      { user_key: key },
      { timeoutMs, requireIdentity: false, echoIsolationInBody: false },
    );
    if (!result.ok) return { ok: false, status: result.status, reason: result.reason };
    const data = result.data ?? {};
    const valid = data.valid === true;
    const user = data.user !== null && typeof data.user === 'object'
      ? (data.user as Record<string, unknown>)
      : undefined;
    return {
      ok: true,
      valid,
      userId: valid ? nonEmpty(user?.user_id) : undefined,
      username: valid ? nonEmpty(user?.username) : undefined,
    };
  }

  /** POST /v3/meta/team/list { user_id } — the teams this user belongs to. */
  async listTeams(
    userId: string,
    options: { userKey?: string; timeoutMs?: number; limit?: number } = {},
  ): Promise<IdentityListResult<TeamSummary>> {
    const user = nonEmpty(userId);
    if (user === undefined) return { ok: false, items: [], reason: 'empty user id' };
    return this.metaList<TeamSummary>(
      this.deps.paths.metaTeamList,
      { user_id: user, limit: metaLimit(options.limit) },
      options.userKey,
      (item) => {
        const teamId = nonEmpty(item.team_id);
        if (teamId === undefined) return undefined;
        return { teamId, name: nonEmpty(item.name) };
      },
      options.timeoutMs,
    );
  }

  /**
   * POST /v3/meta/agent/list { team_id, owner_user_id } — the agents this user
   * OWNS inside one team (the handler filters by owner when both are present).
   * Ownership matters: an agent id selects whose memory pool is read/written, so
   * listing somebody else's agent would be the wrong pick by construction.
   */
  async listAgents(
    teamId: string,
    userId: string,
    options: { userKey?: string; timeoutMs?: number; limit?: number } = {},
  ): Promise<IdentityListResult<AgentSummary>> {
    const team = nonEmpty(teamId);
    if (team === undefined) return { ok: false, items: [], reason: 'empty team id' };
    const body: Record<string, unknown> = { team_id: team, limit: metaLimit(options.limit) };
    const owner = nonEmpty(userId);
    if (owner !== undefined) body.owner_user_id = owner;
    return this.metaList<AgentSummary>(this.deps.paths.metaAgentList, body, options.userKey, (item) => {
      const agentId = nonEmpty(item.agent_id);
      if (agentId === undefined) return undefined;
      return { agentId, name: nonEmpty(item.name), teamId: nonEmpty(item.team_id) };
    }, options.timeoutMs);
  }

  /** Shared plumbing for the two metadata list routes. */
  private async metaList<T>(
    path: string,
    body: Record<string, unknown>,
    userKey: string | undefined,
    parse: (item: Record<string, unknown>) => T | undefined,
    timeoutMs?: number,
  ): Promise<IdentityListResult<T>> {
    const key = nonEmpty(userKey);
    const extraHeaders: Record<string, string> = {};
    // Every /v3/meta/* route except auth/verify requires this header outright
    // (live probe: 401 {"message":"unauthorized: missing_user_key"}).
    if (key !== undefined) extraHeaders['x-tdai-user-key'] = key;
    const result = await this.call<{ items?: unknown; total?: unknown }>(path, body, {
      timeoutMs,
      extraHeaders,
      // The metadata schemas are strict objects; the triple is not part of them.
      echoIsolationInBody: false,
      requireIdentity: false,
      // A 401 here is a user-key problem, not a core-key one: do not point the
      // operator at server.apiKey.
      reportAuthFailure: false,
    });
    if (!result.ok) return { ok: false, items: [], status: result.status, reason: result.reason };
    const raw = result.data?.items;
    const items: T[] = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue;
        const parsed = parse(entry as Record<string, unknown>);
        if (parsed !== undefined) items.push(parsed);
      }
    }
    const total = typeof result.data?.total === 'number' ? result.data.total : undefined;
    return { ok: true, items, total };
  }

  /** Liveness probe; `true` when the core answers with a zero-code envelope. */
  async health(timeoutMs?: number): Promise<boolean> {
    const missing = this.missingIdentity();
    if (missing !== undefined) return false;
    try {
      const response = await this.fetchImpl(this.url(this.deps.paths.health), {
        method: 'GET',
        headers: await this.headers(),
        signal: AbortSignal.timeout(this.timeoutOf(timeoutMs)),
      });
      return response.ok;
    } catch (error) {
      this.deps.log?.debug?.('agemem: health check failed', error);
      return false;
    }
  }
}
