import type { AgememPaths } from './config.js';
import { classifyL2Failure, parseL2Outcome, type L2FetchOutcome } from './head-pack.js';
import type { LoggerLike } from './types.js';
import {
  PERSONA_STATE_MAX_CHARS,
  PERSONA_STATE_SECTION_HEADER,
  type PersonaCardFailureReason,
  type PersonaTurnRuntimeState,
} from './persona-card.js';
// P7 输出侧（shadow）：路径与限长以 gate-report.ts 为单一事实源，这里只负责传输。
import {
  SOUL_GATE_PATH,
  loggedFromCoreResult,
  type SoulGateOutcome,
  type SoulGateReportPayload,
} from './gate-report.js';
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
 * One /v3/recall answer. `block` is the rendered prompt fragment (the
 * relevant-memories section); `status`/\`reason\` keep the failure
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

/** GET /v3/soul/card 的应答（通道 A 的整卡元数据 + 文本）。 */
export interface PersonaCardRead {
  version: number;
  /** Core 的快照口径（旧 hash），保持向后兼容。 */
  hash: string;
  /** SHA-256(hex) of `text`（A3）；Core 是旧版本时为空串。 */
  textHash: string;
  text: string;
  chars: number;
  dirty: boolean;
  /**
   * P1-2 两段（新版 Core 才有）。缺省 = 旧 Core：插件退化成「整卡进 identity、
   * anchor 空」，老行为不变。
   */
  identity?: SoulCardSegment;
  anchor?: SoulCardSegment;
  /**
   * P2-C：Core 本次实际用于按人过滤的 person_key。三态：字段不存在 = 不过滤；
   * `[]` = 只剩全局共性行；非空 = 过滤到这些人。
   */
  persons?: string[];
}

/** 一段的文本（P1-2）。只带 `text`，原样不裁。 */
export interface SoulCardSegment {
  text: string;
}

/**
 * 段的宽松映射（P1-2）：形状不对、非字符串、纯空白都算「这段没有」→ undefined。
 *
 * **不 trim**：Core 段 hash 是 `sha256(段文本)`，这里 trim 过就和它对不上账了。
 * 旧 Core 不带这两个字段，这里返回 undefined，插件侧走整卡退化路径。
 */
function soulCardSegment(value: unknown): SoulCardSegment | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const text = (value as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return { text };
}

/**
 * `/v3/soul/card` 的 `persons`（P2-C）：Core 本次实际用于过滤的 person_key。
 *
 * 三态必须保住，不能压成 `[]`：
 *  - 字段不存在（不过滤）→ `undefined`；
 *  - `[]`（Core 明确按空名单过滤，只剩全局行）→ `[]`；
 *  - 非字符串项一律丢掉（坏形状不该抛，也不该被当成一个人）。
 */
function soulCardPersons(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * POST /v3/soul/injection 的上报载荷（task-13）。只含元数据：字符数与哈希，
 * 没有正文——正文留在 Core，插件只证「实际注入了多少」。
 */
export interface SoulInjectionReportPayload {
  /** 会话作用域名（= agentKey），与召回请求同一口径。 */
  sessionKey?: string;
  /** 宿主轮号；缺省/未知时上送 null（Core 侧按 sessionKey 归并）。 */
  turn?: number | null;
  /** 稳定段：哪一版人格卡进了 system prompt。 */
  card?: { version: number; hash: string; chars: number };
  /** 每轮段：真正 append 的字符数（跳过时 chars=0, skipped=true）。 */
  volatile?: { chars: number; hash: string; skipped: boolean };
  /**
   * 通道标记：插件一次注入会 POST 两次（取卡 / 每轮），Core 侧对账要按通道
   * 各算各的（卡冻结后每会话只变一次；volatile 每轮一行且可能 skip）。
   */
  phase?: 'card' | 'volatile';
}

/**
 * POST /v3/soul/event 的证据行（P1-B W2 写面）。
 * 工具事件填 role='tool'，record_id 记 **tool_call_id**（不是 L0 record_id）。
 */
export interface SoulEventEvidencePayload {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'unknown';
  /** 证据原文；Core 侧上限 400 字符（超长截断，不拒）。 */
  quote?: string;
  /** 证据指向，<=200。 */
  record_id: string;
}

/** POST /v3/soul/event 的行动段（只有工具类事件才有）。 */
export interface SoulEventActionPayload {
  /** 工具名，<=200。 */
  tool: string;
  tool_call_id?: string;
  /** sha256(JSON.stringify(arguments))：只留指纹，不上送命令正文。 */
  args_digest?: string;
  /**
   * 口径是 Core 的 SOUL_ACTION_STATUSES：success | fail | partial | unknown。
   * **不是 failure**——写 failure 会被整条 400。
   */
  result_status?: 'success' | 'fail' | 'partial' | 'unknown';
  duration_ms?: number;
  error_code?: string;
}

/**
 * POST /v3/soul/event 的一条事件。字段与
 * MemoryCore/src/gateway/soul-event-endpoint.ts 逐条对齐：租户三元组**不在 body 里**
 * （走 x-tdai-* 头，见 call(..., { echoIsolationInBody: false })）。
 */
export interface SoulEventPayload {
  /** 幂等键，<=200；重复投递返回 duplicate=true 而不是再写一行。 */
  dedupe_key: string;
  source_kind: 'chat' | 'tool' | 'test' | 'commit' | 'rollback' | 'observation' | 'reflection' | 'system';
  /** 一句话摘要，<=400。 */
  summary: string;
  session_id?: string;
  occurred_at?: string;
  persons?: string[];
  evidence?: SoulEventEvidencePayload[];
  action?: SoulEventActionPayload;
  epistemic?: 'observed' | 'inferred' | 'assumed';
  /** [0,1]；工具类事件 observed 的上限是 0.9（§4.2 第 4 条）。 */
  confidence?: number;
  actor?: 'self' | 'user' | 'third' | 'tool' | 'system';
  /** 缺省由 action.result_status 派生（success→done / fail→failed / unknown→unknown）。 */
  status?: 'open' | 'done' | 'failed' | 'partial' | 'unknown';
}

/**
 * 取卡失败的归类（task-11）。`read()` 把失败折成 reason 字符串，这里翻译成
 * 插件日志用的四类：http_status（回错码 / 根本没到 Core）、timeout、empty
 * （Core 正常但没有卡正文）、parse（应答不是可用信封/JSON）。
 */
export function classifySoulCardFailure(result: {
  status?: number;
  reason?: string;
}): { reason: PersonaCardFailureReason; status?: number } {
  if (typeof result.status === 'number') return { reason: 'http_status', status: result.status };
  const reason = String(result.reason ?? '');
  if (reason === 'timeout') return { reason: 'timeout' };
  // 没绑定身份 = 没可读的卡，不是故障。
  if (reason === 'identity missing') return { reason: 'empty' };
  // 信封 code!=0：Core 明确拒绝了这个读。
  if (reason.startsWith('code ')) return { reason: 'http_status' };
  // bad_json / too_large / 非信封 / transport failure：应答不可用。
  return { reason: 'parse' };
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
  /**
   * Which WORK ITEM (Task) this session reads/writes, when the user picked one
   * at session start. The core treats it as a fourth, OPTIONAL scope axis
   * (x-tdai-task-id: recall filter + L0/L1 write scope, gateway/server.ts) --
   * empty/absent means "not associated", never "the default task".
   */
  taskId?: string;
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
  /**
   * Per-session identity (task-117). A session bound through the start-of-session
   * picker overrides the configured triple for THAT session's calls; undefined
   * means "use `identity`". MUST be synchronous and IO-free: headers() is not
   * async and runs on every request.
   */
  identityFor?: (sessionId?: string) => MemoryIdentity | undefined;
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

/** One task (work item) as the identity flow needs it (metadata task/list). */
export interface TaskSummary {
  taskId: string;
  title?: string;
  status?: string;
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
  /** Session this call belongs to (selects the per-session identity, task-117). */
  sessionId?: string;
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
  /**
   * 人物读面（/v3/soul/person、/v3/soul/person/search）不发 code 信封，而是
   * `{ ok: true, data }`——Panel 的人物档案读面从一开始就是这么约定的。两套信封
   * 都出现在同一张 v3 路由表上，所以这里两种都声明，由 get() 统一收敛。
   */
  ok?: boolean;
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

/**
 * 身份三元组 → query 参数（soul 层读面用）。
 *
 * Core 的 tenantOf 只读 URL 参数、不读标头；而 undefined 会被 URLSearchParams
 * 序列化成字面量 "undefined"，变成「看起来有 team、其实查不到」的假租户。
 * 所以这里逐项丢弃空值，宁可少一个参数（Core 回 400 team_required，错得明显）。
 */
function identityQuery(identity: { teamId?: string; userId?: string; agentId?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const team = nonEmpty(identity.teamId);
  const user = nonEmpty(identity.userId);
  const agent = nonEmpty(identity.agentId);
  if (team !== undefined) out.team = team;
  if (user !== undefined) out.user = user;
  if (agent !== undefined) out.agent = agent;
  return out;
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

/**
 * §6：只挑插件真正要用的几个字段。状态结构归 Core 所有，插件不复制它的形状——
 * 这样 Core 加字段不用改插件，插件也永远不会把整团状态写进 prompt。
 */
function soulTurnState(raw: unknown): PersonaTurnRuntimeState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  // GET /v3/soul/turn 的 data 就是装配体本身（mood/relation/goals/working/flags/asOf/...），
  // 没有嵌套的 state 键；若调用方/旧版本把整组塞进 state，则以内层为准、外层兜底。
  const nested = record.state;
  const nestedRecord =
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : undefined;
  const pick = (key: string): unknown =>
    nestedRecord?.[key] !== undefined ? nestedRecord[key] : record[key];
  const state =
    nested !== null && typeof nested === 'object'
      ? nested
      : {
          ...(pick('mood') === undefined ? {} : { mood: pick('mood') }),
          ...(pick('relation') === undefined ? {} : { relation: pick('relation') }),
          ...(pick('goals') === undefined ? {} : { goals: pick('goals') }),
          ...(pick('working') === undefined ? {} : { working: pick('working') }),
        };
  const hasState = Object.keys(state as Record<string, unknown>).length > 0;
  const asOfValue = pick('asOf');
  const hashValue = pick('stateHash');
  const dynamicValue = pick('dynamicText');
  const asOf = typeof asOfValue === 'string' ? asOfValue : undefined;
  const stateHash = typeof hashValue === 'string' ? hashValue : undefined;
  const dynamicText = typeof dynamicValue === 'string' ? dynamicValue : undefined;
  return {
    ...(hasState ? { state } : {}),
    ...(pick('flags') === undefined ? {} : { flags: pick('flags') }),
    ...(pick('flagTrace') === undefined ? {} : { flagTrace: pick('flagTrace') }),
    ...(pick('evidenceIds') === undefined ? {} : { evidenceIds: pick('evidenceIds') }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(stateHash === undefined ? {} : { stateHash }),
    ...(dynamicText === undefined ? {} : { dynamicText }),
  };
}


/** 人物按名字查的一行结果（与 MemoryCore /v3/soul/person/search 的摘要一一对应）。 */
export interface SoulPersonHit {
  key: string;
  displayName: string;
  aliases: string[];
  platform: string;
  platformId: string | null;
  fieldCount: number;
  relationCount: number;
  updatedAt: string;
  match: 'key' | 'exact' | 'prefix' | 'contains';
  matchedOn: 'key' | 'display_name' | 'alias';
}


/** 九字段档案的一行（与 /v3/soul/person 的 fields[] 同形）。 */
export interface SoulPersonField {
  field: string;
  label: string;
  text: string;
  updatedAt: string;
  stale: boolean;
}

/** 一条关系边：out = 他指向别人，in = 别人指向他，mutual = 双向。 */
export interface SoulPersonRelation {
  relId: string;
  pred: string;
  direction: 'out' | 'in' | 'mutual';
  counterpartKey: string | null;
  /**
   * 「对方」的名字：core 从 2026-11-12 起对两个方向都按 counterpartKey 解析（in 边同样有），
   * 老 core 只在 out 边回 objName，所以下面映射时保留 objName 兜底。
   */
  counterpartName: string | null;
  quote: string;
  validFrom: string;
}

export interface SoulPersonProfile {
  key: string;
  displayName: string;
  aliases: string[];
  fields: SoulPersonField[];
  relations: SoulPersonRelation[];
}

type SoulPersonProfileOutcome =
  | { ok: true; profile: SoulPersonProfile }
  | { ok: false; status?: number; reason: string };

interface SoulPersonProfileData {
  person?: { key?: unknown; displayName?: unknown; aliases?: unknown };
  fields?: unknown;
  relations?: unknown;
}

/** 名字查的结果：要么命中列表，要么一个可诊断的原因（不把失败折成空列表）。 */
export type SoulPersonSearchOutcome =
  | { ok: true; hits: SoulPersonHit[] }
  | { ok: false; status?: number; reason: string };

interface SoulPersonSearchData {
  persons?: unknown;
}

export class MemoryClient {
  private readonly fetchImpl: typeof fetch;
  /** One-shot latch for resolveUserKeyOnce() (see there for why it never retries). */
  private userKeyResolved = false;
  private userKeyValue: string | undefined;
  /** §6：卡里给出的 person_key（Core 实际过滤用的那个），按会话记住给 /v3/soul/turn 用。 */
  private readonly personBySession = new Map<string, string>();

  constructor(private readonly deps: MemoryClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    const base = this.deps.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  /**
   * The identity ONE call travels with: the session binding first, the configured
   * triple second. Synchronous by contract (see MemoryClientDeps.identityFor) and
   * defensive: a broken seam degrades to the config triple, never to a throw.
   */
  private identityOf(sessionId?: string): MemoryIdentity {
    const resolver = this.deps.identityFor;
    if (resolver !== undefined) {
      try {
        const bound = resolver(sessionId);
        if (bound !== undefined) return bound;
      } catch {
        // Fall through to the configured triple.
      }
    }
    return this.deps.identity;
  }

  /** Isolation triple; missing pieces mean "not configured", not "empty string". */
  private isolation(sessionId?: string): Record<string, string> {
    const { teamId, agentId, userId } = this.identityOf(sessionId);
    return { team_id: teamId, agent_id: agentId, user_id: userId };
  }

  private missingIdentity(sessionId?: string): string | undefined {
    const { teamId, agentId, userId } = this.identityOf(sessionId);
    if (nonEmpty(teamId) === undefined) return 'teamId';
    if (nonEmpty(agentId) === undefined) return 'agentId';
    if (nonEmpty(userId) === undefined) return 'userId';
    return undefined;
  }

  private async headers(extra?: Record<string, string>, sessionId?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...(extra ?? {}) };
    const { serviceId, teamId, agentId, userId } = this.identityOf(sessionId);
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
    // The OPTIONAL fourth scope axis (task-117 follow-up, parity with the proxy's
    // task_select stage): which work item this session belongs to. Attached only
    // when a task was picked — an empty header would read as "task scope
    // supplied, and empty", and the core's isolation filter treats a missing
    // task_id as "no task axis" anyway.
    const task = nonEmpty(this.identityOf(sessionId).taskId);
    if (task !== undefined) headers['x-tdai-task-id'] = task;
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
      const missing = this.missingIdentity(options.sessionId);
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
          headers: await this.headers(options.extraHeaders, options.sessionId),
          body: JSON.stringify(options.echoIsolationInBody === false ? body : { ...this.isolation(options.sessionId), ...body }),
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
    options: { timeoutMs?: number; extraHeaders?: Record<string, string>; sessionId?: string } = {},
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
      sessionId: options.sessionId,
    });
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<T | undefined> {
    const result = await this.call<T>(path, body, { timeoutMs, sessionId });
    return result.ok ? result.data : undefined;
  }


  /**
   * GET one v3 read route and unwrap the envelope — same identity gate, same
   * headers, same capped read as call(); only the verb differs.
   *
   * GET is not a style choice here: /v3/soul/person/search is a pure read with
   * a name in the URL, and keeping it GET means Panel/curl/the agent all use
   * the same address without a body contract.
   */
  private async get<T>(
    path: string,
    query: Record<string, string>,
    options: V3CallOptions = {},
  ): Promise<{ ok: boolean; status?: number; reason?: string; data?: T; aborted?: boolean; code?: number; message?: string }> {
    const missing = this.missingIdentity(options.sessionId);
    if (missing !== undefined) {
      this.deps.log?.debug?.(`agemem: ${path} skipped, identity missing (${missing})`);
      return { ok: false, reason: `identity missing (${missing})` };
    }
    const timeout = this.timeoutOf(options.timeoutMs);
    const controller = new AbortController();
    let abortedByUs = false;
    const timer = setTimeout(() => {
      abortedByUs = true;
      controller.abort();
    }, timeout);
    const search = new URLSearchParams(query).toString();
    const target = this.url(search === '' ? path : `${path}?${search}`);
    try {
      const result = await fetchJsonCapped<Envelope<T>>(
        target,
        {
          method: 'GET',
          headers: await this.headers(options.extraHeaders, options.sessionId),
          signal: controller.signal,
        },
        { maxBytes: this.maxResponseBytes(), timeoutMs: 0, fetchImpl: this.fetchImpl },
      );
      if (result.kind === 'http') {
        const status = result.status;
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
      if (result.kind === 'too_large') return { ok: false, reason: 'response too_large' };
      if (result.kind === 'bad_json') return { ok: false, reason: 'response was not JSON' };
      if (result.kind !== 'ok') {
        if (result.kind === 'timeout') {
          return { ok: false, reason: `timed out after ${timeout}ms`, aborted: abortedByUs };
        }
        return { ok: false, reason: 'transport failure: ' + result.reason };
      }
      const envelope = result.json as Envelope<T> | undefined;
      if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'response was not an envelope' };
      // 两套信封并存（见 Envelope）：读面回 { ok: true, data } 且没有 code；
      // 其它 v3 路由回 { code: 0, data }。只认「成功」的那两种，其余一律拒绝——
      // 宽松到「有 data 就算成功」会把 { ok: false } 的失败体当成空结果。
      if (envelope.code === undefined && envelope.ok === true) {
        return { ok: true, data: envelope.data as T };
      }
      if (envelope.code !== 0) {
        const businessCode = typeof envelope.code === 'number' ? envelope.code : Number(envelope.code);
        const message = typeof envelope.message === 'string' ? envelope.message.slice(0, 200) : undefined;
        return { ok: false, status: 200, reason: `business code ${String(envelope.code)}`, code: businessCode, message };
      }
      return { ok: true, data: envelope.data as T };
    } catch (error) {
      this.deps.log?.debug?.(`agemem: ${path} request failed`, error);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'transport failure: ' + detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /** L3 persona (head pack body). Missing persona reads as an empty string. */
  async readCore(timeoutMs?: number, sessionId?: string): Promise<CoreReadResult | undefined> {
    const data = await this.post<CoreReadData>(this.deps.paths.coreRead, {}, timeoutMs, sessionId);
    if (data === undefined) return undefined;
    const updatedAt = nonEmpty(data.updated_at);
    return { content: typeof data.content === 'string' ? data.content : '', updatedAt };
  }

  /** L1 recall: natural-language query over atomic memories. */
  async searchAtomic(query: string, limit: number, timeoutMs?: number, sessionId?: string): Promise<RecallHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const safeLimit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 5)));
    const data = await this.post<AtomicSearchData>(
      this.deps.paths.atomicSearch,
      { query: trimmed, limit: safeLimit },
      timeoutMs,
      sessionId,
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
  async listScenarios(timeoutMs?: number, sessionId?: string): Promise<string[]> {
    const data = await this.post<ScenarioListData>(this.deps.paths.scenarioLs, {}, timeoutMs, sessionId);
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
  async listScenariosRich(timeoutMs?: number, sessionId?: string): Promise<L2FetchOutcome> {
    const result = await this.call<ScenarioListData>(this.deps.paths.scenarioLs, {}, { timeoutMs, sessionId });
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
      { timeoutMs: options.timeoutMs, sessionId: options.sessionId, extraHeaders: headers, echoIsolationInBody: false },
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
  async recallCombined(query: string, limit: number, options: RecallCombinedOptions = {}, timeoutMs?: number, sessionId?: string): Promise<RecallCombined> {
    const [search, persona, scenarios] = await Promise.allSettled([
      this.searchAtomic(query, limit, timeoutMs, sessionId),
      options.includePersona === true ? this.readCore(timeoutMs, sessionId) : Promise.resolve(undefined),
      options.includeScenarios === true ? this.listScenarios(timeoutMs, sessionId) : Promise.resolve([]),
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
  async recall(query: string, topK: number, timeoutMs?: number, sessionId?: string): Promise<RecallHit[]> {
    return this.searchAtomic(query, topK, timeoutMs, sessionId);
  }


  /**
   * 人物「按名字查」：把用户嘴里的名字变成 person_key。
   *
   * 失败与「没人叫这个名字」必须分开：前者可诊断（status/reason），后者是
   * 正常的空结果——工具层据此决定说「没找到」还是「查不了」。
   */

  /**
   * 单人档案读面。key 必须是 person_key（端点自己会拒绝别的形状），
   * 所以这里不做「猜一个」的兜底：查不到就如实说 404。
   */
  async readSoulPerson(
    key: string,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<SoulPersonProfileOutcome> {
    const trimmed = key.trim();
    if (trimmed === '') return { ok: false, reason: 'empty person key' };
    // 身份三元组必须进 query：Core 侧 tenantOf 只读 URL 参数（不读标头），
    // 少了 team 就是 400 team_required，少了 user/agent 就会退到 "default" 租户查空。
    const { teamId, agentId, userId } = this.identityOf(sessionId);
    const result = await this.get<SoulPersonProfileData>(
      this.deps.paths.soulPerson ?? '/v3/soul/person',
      { ...identityQuery({ teamId, userId, agentId }), key: trimmed },
      { timeoutMs, sessionId },
    );
    if (!result.ok) return { ok: false, status: result.status, reason: result.reason ?? 'request failed' };
    const person = result.data?.person;
    if (!person || typeof person.key !== 'string' || typeof person.displayName !== 'string') {
      return { ok: false, reason: 'response had no person' };
    }
    const fields: SoulPersonField[] = [];
    for (const entry of Array.isArray(result.data?.fields) ? result.data!.fields! : []) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.field !== 'string' || typeof row.text !== 'string') continue;
      fields.push({
        field: row.field,
        label: typeof row.label === 'string' ? row.label : row.field,
        text: row.text,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
        stale: row.stale === true,
      });
    }
    const relations: SoulPersonRelation[] = [];
    for (const entry of Array.isArray(result.data?.relations) ? result.data!.relations! : []) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.pred !== 'string') continue;
      const direction = row.direction === 'in' || row.direction === 'mutual' ? row.direction : 'out';
      relations.push({
        relId: typeof row.relId === 'string' ? row.relId : '',
        pred: row.pred,
        direction,
        counterpartKey: typeof row.counterpartKey === 'string' ? row.counterpartKey : null,
        // in 边的 objName 是「这个人自己」，不能当对方名字用；优先用 core 的 counterpartName。
        counterpartName: typeof row.counterpartName === 'string'
          ? row.counterpartName
          : typeof row.objName === 'string' ? row.objName : null,
        quote: typeof row.quote === 'string' ? row.quote : '',
        validFrom: typeof row.validFrom === 'string' ? row.validFrom : '',
      });
    }
    return {
      ok: true,
      profile: {
        key: person.key,
        displayName: person.displayName,
        aliases: Array.isArray(person.aliases) ? person.aliases.filter((a): a is string => typeof a === 'string') : [],
        fields,
        relations,
      },
    };
  }

  async searchSoulPersons(
    query: string,
    limit: number,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<SoulPersonSearchOutcome> {
    const trimmed = query.trim();
    if (trimmed === '') return { ok: true, hits: [] };
    const safeLimit = Math.min(20, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 10)));
    const { teamId, agentId, userId } = this.identityOf(sessionId);
    const result = await this.get<SoulPersonSearchData>(
      this.deps.paths.soulPersonSearch,
      { ...identityQuery({ teamId, userId, agentId }), q: trimmed, limit: String(safeLimit) },
      { timeoutMs, sessionId },
    );
    if (!result.ok) return { ok: false, status: result.status, reason: result.reason ?? 'request failed' };
    const raw = Array.isArray(result.data?.persons) ? result.data!.persons! : [];
    const hits: SoulPersonHit[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const key = typeof row.key === 'string' ? row.key : '';
      const displayName = typeof row.displayName === 'string' ? row.displayName : '';
      if (key === '' || displayName === '') continue;
      const aliases = Array.isArray(row.aliases) ? row.aliases.filter((a): a is string => typeof a === 'string') : [];
      const match = row.match === 'key' || row.match === 'exact' || row.match === 'prefix' || row.match === 'contains' ? row.match : 'contains';
      const matchedOn = row.matchedOn === 'key' || row.matchedOn === 'alias' ? row.matchedOn : 'display_name';
      hits.push({
        key,
        displayName,
        aliases,
        platform: typeof row.platform === 'string' ? row.platform : '',
        platformId: typeof row.platformId === 'string' ? row.platformId : null,
        fieldCount: typeof row.fieldCount === 'number' ? row.fieldCount : 0,
        relationCount: typeof row.relationCount === 'number' ? row.relationCount : 0,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
        match,
        matchedOn,
      });
    }
    return { ok: true, hits: hits.slice(0, safeLimit) };
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
    const envelope = { ...this.isolation(session), session_id: session };
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
        { timeoutMs, sessionId: session },
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
    for (const [field, value] of Object.entries(this.isolation(session))) {
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
    const envelope = { ...this.isolation(session), session_id: session };
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
        { timeoutMs, sessionId: session },
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

  /**
   * POST /v3/meta/task/list { team_id, status } — the work items a session may
   * be associated with (the proxy's own listTasks call: team + running, so
   * completed work items never show up as a pick).
   *
   * The kernel requires at least one of team_id / creator_user_id; team scope is
   * what the picker needs (the task belongs to the team the user just chose).
   */
  async listTasks(
    teamId: string,
    options: { userKey?: string; timeoutMs?: number; limit?: number; status?: string } = {},
  ): Promise<IdentityListResult<TaskSummary>> {
    const team = nonEmpty(teamId);
    if (team === undefined) return { ok: false, items: [], reason: 'empty team id' };
    const body: Record<string, unknown> = {
      team_id: team,
      status: options.status ?? 'running',
      limit: metaLimit(options.limit),
    };
    return this.metaList<TaskSummary>(this.deps.paths.metaTaskList, body, options.userKey, (item) => {
      const taskId = nonEmpty(item.task_id);
      if (taskId === undefined) return undefined;
      return { taskId, title: nonEmpty(item.title), status: nonEmpty(item.status) };
    }, options.timeoutMs);
  }

  /**
   * POST /v3/meta/config/user/get { user_id, module } -> `{ param_name:
   * effective_value }` (MemoryProxy/src/meta/client.ts:290-300).
   *
   * The kernel's config route forces `assertCallerIsOwner`, so the user key we
   * send must belong to `userId` — callers pass the id resolved from that very
   * key, never one from config. This route needs `x-tdai-user-key` like the
   * other /v3/meta/* routes, and a missing key is a 401 there, not a core-key
   * problem, so auth failures are not reported as such.
   *
   * `null` means "could not read" (timeout, non-200, malformed envelope) and
   * the caller degrades to `{ kind: 'ask' }`: a core that is down must not
   * change how the session starts.
   */
  async getUserSessionInit(
    userId: string,
    module: string,
    options: { userKey?: string; timeoutMs?: number } = {},
  ): Promise<Record<string, string> | null> {
    const user = nonEmpty(userId);
    const mod = nonEmpty(module);
    if (user === undefined || mod === undefined) return null;
    const key = nonEmpty(options.userKey);
    const extraHeaders: Record<string, string> = {};
    if (key !== undefined) extraHeaders['x-tdai-user-key'] = key;
    // Exactly the two fields the kernel schema declares; the identity triple is
    // NOT part of this body.
    const result = await this.call<{ items?: unknown }>(
      this.deps.paths.metaUserConfig,
      { user_id: user, module: mod },
      {
        timeoutMs: options.timeoutMs,
        extraHeaders,
        echoIsolationInBody: false,
        // The user key names the row; a caller with no resolved identity yet is
        // exactly who asks this question.
        requireIdentity: false,
        reportAuthFailure: false,
      },
    );
    if (!result.ok) return null;
    const raw = result.data?.items;
    if (!Array.isArray(raw)) return null;
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const name = nonEmpty(item.param_name);
      const value = item.effective_value;
      if (name === undefined || typeof value !== 'string') continue;
      out[name] = value;
    }
    return out;
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


  /**
   * GET one v3 route and unwrap the envelope. Same headers / identity gate /
   * capped read as call(), but with a query string instead of a body — the two
   * soul read routes (GET /v3/soul/card, GET /v3/soul/turn) are pure reads and
   * address the tenant through query params. Never throws.
   */
  private async read<T>(
    path: string,
    query: Record<string, string | undefined>,
    options: { timeoutMs?: number; sessionId?: string; reportAuthFailure?: boolean } = {},
  ): Promise<{ ok: boolean; status?: number; reason?: string; data?: T }> {
    if (this.missingIdentity(options.sessionId) !== undefined) {
      return { ok: false, reason: 'identity missing' };
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string' && value !== '') params.set(key, value);
    }
    const qs = params.toString();
    const url = this.url(path) + (qs === '' ? '' : '?' + qs);
    const timeout = this.timeoutOf(options.timeoutMs);
    try {
      const result = await fetchJsonCapped<Envelope<T>>(
        url,
        { method: 'GET', headers: await this.headers(undefined, options.sessionId), signal: AbortSignal.timeout(timeout) },
        { maxBytes: this.maxResponseBytes(), timeoutMs: 0, fetchImpl: this.fetchImpl },
      );
      if (result.kind === 'http') {
        if ((result.status === 401 || result.status === 403) && options.reportAuthFailure !== false) {
          try {
            this.deps.onAuthFailure?.({ path, status: result.status });
          } catch {
            // The hook is best-effort; a throwing hook must not break the read.
          }
        }
        this.deps.log?.debug?.('agemem: ' + path + ' -> HTTP ' + String(result.status));
        return { ok: false, status: result.status, reason: 'HTTP ' + String(result.status) };
      }
      if (result.kind !== 'ok') {
        this.deps.log?.debug?.('agemem: ' + path + ' read failed (' + result.kind + ')');
        return { ok: false, reason: result.kind };
      }
      const envelope = result.json as Envelope<T> | undefined;
      if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'response was not an envelope' };
      if (envelope.code !== 0) {
        const summary = typeof envelope.message === 'string' ? envelope.message.trim().slice(0, 200) : '';
        return { ok: false, reason: 'code ' + String(envelope.code) + (summary === '' ? '' : ': ' + summary) };
      }
      const data = envelope.data;
      return { ok: true, data: (data !== null && typeof data === 'object' ? data : {}) as T };
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      this.deps.log?.debug?.(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'agemem: ' + path + ' timed out after ' + String(timeout) + 'ms'
          : 'agemem: ' + path + ' read failed',
        error,
      );
      return { ok: false, reason: 'transport failure' };
    }
  }

  /**
   * `/v3/soul/card` 的 query（P2-C）。
   *
   * 两个新参数的分工，别混：
   *  - `session`：会话键。Core 拿它反查该会话最近一条事件的 `persons_json`
   *    （person_key 数组），这是**唯一**由插件驱动按人取卡的路径 —— 插件不猜人名；
   *  - `participants`：显式名单，只在调用方真的拿到 person_key（`p_` 前缀）时才传。
   *    传展示名的后果是 Core 里查不到就丢弃，而「显式 `participants=`（空串）」
   *    在 Core 的语义是「只剩全局共性行」—— 会把本人 `human` 行静默清空。
   *    所以空数组**不传**（等于不过滤），绝不发一个空串出去。
   */
  private soulCardQuery(options: {
    sessionId?: string;
    participants?: string[];
  }): Record<string, string | undefined> {
    const { teamId, agentId, userId } = this.identityOf(options.sessionId);
    const explicit =
      options.participants !== undefined && options.participants.length > 0
        ? options.participants.join(',')
        : undefined;
    return {
      team: nonEmpty(teamId),
      user: nonEmpty(userId),
      agent: nonEmpty(agentId),
      session: nonEmpty(options.sessionId),
      participants: explicit,
    };
  }

  /**
   * §6：记住 Core 本次实际过滤用的 person_key，供该会话的 /v3/soul/turn 关系段使用。
   * 关系段的口径是「这个人的事」，没有 person 就整段省略（fail-closed），所以这一步决定
   * 生产上关系段到底存不存在。
   */
  private rememberPersons(sessionId: string | undefined, persons: string[] | undefined): void {
    if (sessionId === undefined || persons === undefined) return;
    // persons 为空 = 卡已按「只有全局行」过滤：旧 person 必须清掉，否则尾巴继续讲旧关系。
    if (persons.length === 0) {
      this.personBySession.delete(sessionId);
      return;
    }
    // 多人卡不挑第一个当唯一 person：那等于绕开端点「只有唯一参与者」的 fail-closed，
    // 让整张卡的多个人的关系混给当前这一轮。宁可不带，端点会整段省略。
    if (persons.length !== 1) {
      this.personBySession.delete(sessionId);
      return;
    }
    this.personBySession.set(sessionId, persons[0]!);
  }

  /**
   * GET /v3/soul/card — 通道 A 的整卡（version/hash/text）。纯读、无副作用。
   * 失败一律 undefined，调用方 fail-open 保留上一版。
   *
   * P2-C：带 `sessionId` 时把会话键交给 Core，由它决定这张卡要过滤到谁；
   * 返回的 `persons` 是 Core 本次**实际用于过滤**的 person_key（不过滤时没有该字段）。
   */
  async soulCard(
    options: { timeoutMs?: number; sessionId?: string; participants?: string[] } = {},
  ): Promise<PersonaCardRead | undefined> {
    const result = await this.read<Record<string, unknown>>(
      '/v3/soul/card',
      this.soulCardQuery(options),
      options,
    );
    if (!result.ok) return undefined;
    const data = result.data;
    if (data === undefined) return undefined;
    const text = nonEmpty(data.text);
    if (text === undefined) return undefined;
    const persons = soulCardPersons(data.persons);
    this.rememberPersons(options.sessionId, persons);
    return {
      version: typeof data.version === 'number' ? data.version : 0,
      hash: nonEmpty(data.hash) ?? '',
      textHash: nonEmpty(data.textHash) ?? '',
      text,
      chars: typeof data.chars === 'number' ? data.chars : text.length,
      dirty: data.dirty === true,
      // P1-2：两段原样透传（不 trim），插件侧按段注入。
      identity: soulCardSegment(data.identity),
      anchor: soulCardSegment(data.anchor),
      // P2-C：Core 本次实际用于过滤的 person_key（不过滤时整个字段不出现）。
      persons: soulCardPersons(data.persons),
    };
  }

  /**
   * GET /v3/soul/card 的留因版（task-11）：失败折成四类之一，供插件日志区分
   * 「Core 还没设定人格卡」（empty）与「取卡失败」（http_status/timeout/parse）。
   * 纯读、无副作用、不抛。
   */
  async soulCardDetailed(
    options: { timeoutMs?: number; sessionId?: string; participants?: string[] } = {},
  ): Promise<{ ok: true; card: PersonaCardRead } | { ok: false; reason: PersonaCardFailureReason; status?: number }> {
    const result = await this.read<Record<string, unknown>>(
      '/v3/soul/card',
      this.soulCardQuery(options),
      options,
    );
    if (!result.ok) return { ok: false, ...classifySoulCardFailure(result) };
    const data = result.data;
    if (data === undefined) return { ok: false, reason: 'empty' };
    const text = nonEmpty(data.text);
    if (text === undefined) return { ok: false, reason: 'empty' };
    this.rememberPersons(options.sessionId, soulCardPersons(data.persons));
    return {
      ok: true,
      card: {
        version: typeof data.version === 'number' ? data.version : 0,
        hash: nonEmpty(data.hash) ?? '',
        textHash: nonEmpty(data.textHash) ?? '',
        text,
        chars: typeof data.chars === 'number' ? data.chars : text.length,
        dirty: data.dirty === true,
        // P1-2：两段原样透传（不 trim），插件侧按段注入。
        identity: soulCardSegment(data.identity),
        anchor: soulCardSegment(data.anchor),
        // P2-C：同 soulCard（留因版也要带，否则 session-identity 拿不到 person_key）。
        persons: soulCardPersons(data.persons),
      },
    };
  }

  /**
   * GET /v3/soul/turn — 通道 B：本轮心境 + 未完的事（≤400 字符，Core 已裁）。
   * 失败一律 undefined；空文本意味着本轮没有可说的。
   */
  async soulTurn(
    options: { timeoutMs?: number; sessionId?: string } = {},
  ): Promise<{ text: string; openLoops: string[] } | undefined> {
    const { teamId, agentId, userId } = this.identityOf(options.sessionId);
    // §6：把卡里定下的 person 带上，端点才有关系段可读（不带 = 生产恒空）。
    const person = options.sessionId === undefined ? undefined : this.personBySession.get(options.sessionId);
    const result = await this.read<{ text?: unknown; openLoops?: unknown; state?: unknown }>('/v3/soul/turn', {
      team: nonEmpty(teamId),
      user: nonEmpty(userId),
      agent: nonEmpty(agentId),
      session: options.sessionId,
      person: nonEmpty(person),
      // §8：400 是「标头 + 正文」总预算。把标头占位交给 Core，Core 按这个预算排版，
      // 插件端就不再二次裁掉尾行「优先级：先做」（第三轮评审 MAJOR-1）。
      stateBudget: String(Math.max(0, PERSONA_STATE_MAX_CHARS - PERSONA_STATE_SECTION_HEADER.length)),
    }, options);
    if (!result.ok || result.data === undefined) return undefined;
    const text = typeof result.data.text === 'string' ? result.data.text : '';
    const raw = result.data.openLoops;
    const openLoops = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
    // §6：运行时状态（mood/relation/goals/flags/asOf/stateHash/dynamicText）与 400 字
    // 尾巴分开给。Core 旧版本没有这个字段 → undefined，插件逐字走旧路径。
    // 扁平装配体：状态字段就长在 data 上，不是 data.state（Core 侧没有那层包装）。
    const state = soulTurnState(result.data);
    return { text, openLoops, ...(state === undefined ? {} : { state }) };
  }

  /**
   * POST /v3/soul/injection —— 把「这一轮实际注入的元数据」回报给 Core（task-13），
   * 让召回日志里的注入量等于真实注入，而不是「召回了多少」。
   *
   * 契约：只发身份三元组 + sessionKey + turn + 字符数/哈希。
   * **绝不上送卡正文或注入正文**（Core 只需记账，正文在 Core 侧本来就有）。
   * fire-and-forget：任何失败吞掉、不抛；调用方不需要 await，回报失败不影响回合。
   */
  async reportSoulInjection(
    payload: SoulInjectionReportPayload,
    sessionId?: string,
  ): Promise<void> {
    try {
      const { teamId, agentId, userId } = this.identityOf(sessionId);
      const body: Record<string, unknown> = {
        team: nonEmpty(teamId),
        user: nonEmpty(userId),
        agent: nonEmpty(agentId),
        sessionKey: nonEmpty(payload.sessionKey),
        turn: payload.turn ?? null,
      };
      if (payload.card !== undefined) {
        body.card = {
          version: payload.card.version,
          hash: payload.card.hash,
          chars: payload.card.chars,
        };
      }
      if (payload.phase !== undefined) body.phase = payload.phase;
      if (payload.volatile !== undefined) {
        body.volatile = {
          chars: payload.volatile.chars,
          hash: payload.volatile.hash,
          skipped: payload.volatile.skipped,
        };
      }
      // 契约要求 body 只有 team/user/agent/sessionKey/turn/card|volatile：
      // 全局 echoIsolationInBody 会把 team_id/agent_id/user_id 再插一份（其他
      // v3 路由的既有口径），这条记账路由用不到——身份已由 x-tdai-* 头带上。
      await this.call('/v3/soul/injection', body, {
        timeoutMs: 3000,
        sessionId,
        echoIsolationInBody: false,
      });
    } catch {
      // best-effort 观测面：回报失败绝不外溢到对话回合。
    }
  }

  /**
   * POST /v3/soul/event —— P1-B W3：把一次工具调用写成一条 soul 事件。
   *
   * 与 reportSoulInjection 的差别在错误语义：那条是纯记账（全吞），这条是事实来源
   * （「我跑过这条命令」要能被 dedupe 判重、被人工验收），所以信封 code!==0 必须
   * 抛给调用方，由 index.ts 的 warnOnce 只报一次；duplicate=true 是正常返回，不抛。
   *
   * 租户三元组只走 x-tdai-* 头（core 侧从 header 取，body 里带了反而多一份口径）。
   */
  async postSoulEvent(
    payload: SoulEventPayload,
    sessionId?: string,
  ): Promise<{ eventId?: string; duplicate: boolean }> {
    const result = await this.call<{ event_id?: unknown; duplicate?: unknown }>(
      '/v3/soul/event',
      payload as unknown as Record<string, unknown>,
      { timeoutMs: 3000, sessionId, echoIsolationInBody: false },
    );
    if (!result.ok) {
      throw new Error('soul event rejected: ' + (result.reason ?? 'no response'));
    }
    const eventId = typeof result.data?.event_id === 'string' ? result.data.event_id : undefined;
    return { eventId, duplicate: result.data?.duplicate === true };
  }

  /**
   * POST /v3/soul/gate —— P7 输出侧判定（stage=output）。
   *
   * 与另外两条 soul 写路由的差别：
   *  - reportSoulInjection 是纯记账（全吞、返回值 void）；postSoulEvent 是事实来源（失败抛）。
   *    这条是**观测面**：失败折成 ok:false 交给调用方 warnOnce 一次，不抛、不重投、不进 Outbox。
   *  - body 只有 text / stage（+ 有则带上的 sessionId / eventId）；租户三元组仍只走 x-tdai-* 头。
   *    所以 echoIsolationInBody: false —— 默认路径会把 team_id/agent_id/user_id 再往 body 里插
   *    一份（其他 v3 路由的既有口径），而 gate 路由只从头里取身份。
   *
   * 返回值可以被日志读，但**不得**用来改写本轮输出：shadow 期 Core 恒回 allow
   * （soul-gate-endpoint.ts:269），拿它当「放行/拦截」判断等于伪造了一个没有的闸门。
   */
  async reportSoulGate(
    report: SoulGateReportPayload,
    sessionId?: string,
  ): Promise<SoulGateOutcome> {
    try {
      const body: Record<string, unknown> = {
        text: report.text,
        stage: report.stage,
      };
      // 「有则带、无则省略」：未知字段 Core 不读，空串却会让审计侧以为「带了个空会话」。
      if (report.sessionId !== undefined) body.sessionId = report.sessionId;
      if (report.eventId !== undefined) body.eventId = report.eventId;
      // 会话标识还走规范头（x-tdai-service-id 之外唯一被全网关认识的会话键，
      // recallBlock 同款）：gate 路由当前不读它，但代理/日志侧认这个头。
      const session = sessionId ?? report.sessionId;
      const result = await this.call<Record<string, unknown>>(SOUL_GATE_PATH, body, {
        timeoutMs: 3000,
        sessionId: session,
        ...(session === undefined ? {} : { extraHeaders: { 'x-tdai-session-id': session } }),
        echoIsolationInBody: false,
      });
      if (!result.ok) {
        // 失败折成结果而不是抛出：调用方只负责「报一次」，不需要 try/catch 两种形态。
        return { ok: false, status: result.status, reason: result.reason };
      }
      const data = result.data ?? {};
      // Core 的 logged 是 { inserted: <行数> }，不是布尔：按数值判（t30 F1）。
      const logged = loggedFromCoreResult(data.logged);
      return {
        ok: true,
        decision: typeof data.decision === 'string' ? data.decision : undefined,
        shadow: data.shadow === true,
        logged,
      };
    } catch (error) {
      // call() 声称不抛，但传输层的意外不能把一个观测面变成 turn 的故障点。
      return { ok: false, reason: 'threw: ' + (error instanceof Error ? error.message : String(error)) };
    }
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
