/**
 * Configuration surface for @tdb/agemem-dsh.
 *
 * Discipline: every switch has a default, nothing secret is ever stored here,
 * and unknown keys are ignored with a warning instead of failing the plugin.
 * The API key is referenced by name (`server.apiKeyRef`) and resolved through
 * the dsh credentials seam (or the launching environment) at call time.
 *
 * API key resolution (see index.ts) is: explicit `server.apiKey` → credentials
 * ref `server.apiKeyRef` → env[apiKeyRef]. An inline key exists because a
 * desktop profile may have no credentials store wired; an explicit config value
 * MUST win over the seam/env, otherwise configuring it would silently do nothing.
 * The ref is for environments that can rotate the key.
 *
 * Identity defaults are EMPTY on purpose: teamId / agentId / userId select
 * whose memory the plugin reads and writes, so shipping this machine's values
 * would make every install write into the author's account (cross-account
 * contamination — far worse than doing nothing). Identity must be supplied
 * explicitly by the profile patch config (or the launching environment /
 * credentials seam); the plugin never guesses it. While any of the three is
 * empty the client stays inert: it logs and skips the request instead of
 * erroring, so a bare install is a no-op rather than a misdirected writer.
 * `baseUrl` keeps its localhost default because local standalone MemoryCore is
 * the standard deployment; point it at the cloud origin in the patch.
 */

import { clampMaxResponseBytes } from './http-capped.js';
import {
  CORE_MAX_MESSAGE_CHARS,
  CORE_MAX_MESSAGES_PER_REQUEST,
  CORE_MAX_REQUEST_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
} from './wire-limits.js';

export interface AgememPaths {
  coreRead: string;
  atomicSearch: string;
  scenarioLs: string;
  conversationAdd: string;
  conversationDelete: string;
  /**
   * The SECOND write pipeline (skill buffer → threshold archive → extractor →
   * L2 scene_blocks). Not interchangeable with conversationAdd: the two feed
   * different distillation pipelines and take different payloads.
   */
  skillConversationAdd: string;
  /**
   * The merged recall endpoint (DS-RECALL-MERGE-001). Server-side opt-in:
   * `v3Recall.enabled` defaults to false, so a real deployment can answer 404
   * — the volatile block falls back to atomic/search in that case.
   */
  recall: string;
  health: string;
  /**
   * Metadata routes used to resolve the WHOLE identity from a single user key
   * (task-51). They are public-read endpoints: auth/verify needs no
   * x-tdai-user-key, the two list routes do (401 "missing_user_key").
   */
  metaAuthVerify: string;
  metaTeamList: string;
  metaAgentList: string;
}

export interface ServerConfig {
  baseUrl: string;
  /**
   * Inline API key for the desktop profile (empty by default — never shipped).
   * Wins over the credentials ref so a configured key actually takes effect.
   */
  apiKey: string;
  /**
   * Credentials reference name (never a value). Defaults to the core gateway
   * key, NOT the proxy key: MemoryProxy (8096) and MemoryCore (8420) use
   * different keys, and reusing the proxy's makes every core call a silent 401.
   */
  apiKeyRef: string;
  /** Sent as `x-tdai-service-id`. */
  serviceId: string;
  /**
   * The user key that resolves the identity (task-51): verify → list teams →
   * list agents, then pick one. It authenticates the USER against the metadata
   * service; it is NOT the core API key (that stays on apiKey/apiKeyRef for the
   * Authorization header) and it is never written into a prompt.
   */
  userKey: string;
  /** Credentials/env reference for userKey, mirroring apiKeyRef. */
  userKeyRef: string;
  teamId: string;
  agentId: string;
  userId: string;
  requestTimeoutMs: number;
  /**
   * Byte cap for ONE response body (task-100). The plugin runs inside the host
   * GUI process, so a single unbounded response — a proxy error page, a URL
   * pointing at a file server — can exhaust that process's memory and take the
   * user's session with it. Default 2 MiB, clamped to [1, 16 MiB]; 0/absent in
   * the patch means "use the default", never "unlimited".
   */
  maxResponseBytes: number;
}

export interface HeadPackConfig {
  enabled: boolean;
  /** Added to the host's DEPLOYMENT_PERSONA_SUFFIX order (10200 in this build). */
  orderOffset: number;
  maxChars: number;
  timeoutMs: number;
  /** How long a fetched head pack stays fresh before the next prefetch. */
  refreshMs: number;
  /** Injected when no head pack has ever been fetched; empty means fail-open. */
  fallbackText: string;
  /**
   * Render the L2 scene index (`/v3/scenario/ls`, `src/segments/l2.ts`) into
   * the head pack. Off = the model is told the persona only, with no way to
   * know which `scene_blocks/` files exist.
   */
  includeScenarioIndex: boolean;
  /**
   * Legacy ceiling for `composeHeadPack`'s bare path list. The persona no longer
   * appends one (task-103: the L2 segment owns the index), so this only bounds
   * the compose helper's own behaviour.
   */
  maxScenarioEntries: number;
  /**
   * Character cap for the L2 scene-index segment. Clamped to [0, 3000]: 3000 is
   * also `L2_MAX_CHARS`, the ceiling that segment registers with, so a larger
   * number would be cut there anyway and two ceilings that disagree are worse
   * than one. Budget is per line — a line that does not fit is dropped whole.
   */
  l2Chars: number;
}

/** The distilled persona fragments (/v3/recall `<soul-*>` tags). */
export interface VolatileSoulConfig {
  /** Inject the soul fragments ahead of the memory entries. */
  enabled: boolean;
  /** Ceiling for the rendered soul block (tags included), clamped to [100, 3000]. */
  maxChars: number;
  /** Keep `<soul-feeling>` (the mood line) alongside `<soul-identity>`. */
  includeFeeling: boolean;
}

export interface VolatileConfig {
  enabled: boolean;
  /** Per-turn ceiling for the injected block (chars), soul included. */
  maxChars: number;
  /** Soul (persona) part of that ceiling. */
  soul: VolatileSoulConfig;
  /** Wall-clock budget for the whole block fetch (fallback legs included). */
  timeoutMs: number;
  /** Use /v3/recall first; false forces the atomic/search path. */
  recall: boolean;
  /**
   * maxResults handed to /v3/recall. Measured: 1 -> one 450-char entry,
   * 2 -> two entries (1214 chars), 3 -> still two (the core decides). Asking
   * for 3 costs no extra embedding (l1 embeds the query once), and after
   * per-entry clipping (ENTRY_MAX_CHARS=360) the budget can fit 2-3 entries
   * instead of one.
   */
  recallMaxResults: number;
  /**
   * Budget for the /v3/recall call alone, enforced by AbortController (we cancel
   * the fetch; we do not merely stop waiting for it).
   *
   * Measured distribution (live core, one real turn text per round — every turn
   * sends a NEW text, so the core embedding cache never hits): 1250 / 1396 /
   * 1467 / 1540 / 2002 / 2147 / 2255ms, L1 embedding (perfMs.l1) at 97%+ of it;
   * cold start 5067ms. Earlier 95-119ms readings were the SAME query hitting the
   * core cache and are not a budget basis.
   *
   * 2500ms covers that distribution up to roughly the 90th percentile. The tail
   * and the cold start fail open into atomic/search, which is why the fallback
   * keeps 500ms of the 3000ms volatile budget: cutting recall at 1500ms made the
   * turn pay for recall AND the fallback (measured: slower and worse).
   */
  recallTimeoutMs: number;
  /** `<team-wiki>` segment derived from this turn (task-74). */
  wiki: VolatileWikiConfig;
  /** `<knowledge_tools>` segment derived from this turn (task-97). */
  knowledge: VolatileKnowledgeConfig;
}

/**
 * Wiki segment. Defaults mirror `dsh-plugin/src/wiki-segment.ts`
 * (`resolveWikiSegmentConfig` re-clamps whatever we pass), but the OFF
 * default is ours: `/v3/wiki/search` has never answered on the 8420 build
 * (probe: 404 on every call), so enabling it by default buys one failed
 * request per turn. Flip it on when the core route ships; the segment is
 * fail-open either way (`fail=http_404` in the debug line).
 */
export interface VolatileWikiConfig {
  enabled: boolean;
  /** Merged hits kept in the block (1..20). */
  topK: number;
  /** Per-wiki fan-out asked from the core (1..20). */
  perWikiLimit: number;
  /** Relevance floor handed to the core (0..10); never re-gated here. */
  minScore: number;
  /** Own ceiling for the block, in characters; further clamped by the block budget. */
  maxChars: number;
  /** Per-call round-trip budget. */
  timeoutMs: number;
}

/** Team knowledge resources (`/v3/knowledge/list`) listed to the model. */
export interface VolatileKnowledgeConfig {
  enabled: boolean;
  /** Own ceiling for the block, in characters; 0 injects nothing. */
  maxChars: number;
  /** How many resources may be rendered (1..32). */
  maxResources: number;
  /** Per-call round-trip budget. */
  timeoutMs: number;
}

export interface WritebackConfig {
  enabled: boolean;
  /**
   * Also feed the L2 skill pipeline on each completed turn (default true: L2
   * scenes stop growing without it). Set false when the SAME identity is
   * already fed by MemoryProxy, otherwise both writers share one skill buffer
   * and the extractor sees every exchange twice.
   */
  skillFeed: boolean;
  /** Empty means $DSH_HOME/agemem/outbox.jsonl (see outbox.ts). */
  outboxPath: string;
  maxAttempts: number;
  retryMs: number;
  /**
   * Per-message content cap. Configurable, but the core rejects a longer block
   * with a 400 for the whole batch (schema max 8192), so the value is clamped
   * to [1, 8192] below — a config typo must not resurrect that failure mode.
   */
  maxMessageChars: number;
  /**
   * Messages per request. `/v3/conversation/add` caps a batch at 100
   * (v2-schemas.ts:120) and rejects the entire turn when exceeded, so longer
   * turns are sharded in order; clamp keeps it within the core limit.
   */
  maxMessagesPerRequest: number;
  /**
   * Byte budget for ONE request body (the JSON actually put on the wire).
   * The core destroys an oversized socket before it can answer with a 413, so
   * the caller sees ECONNRESET and the turn is lost; measured 0.9 MB passes,
   * 1.05 MB (L0) and 3.75 MB (skill) always reset. Default 700000 bytes,
   * clamped to [1, 1000000].
   */
  maxRequestBytes: number;
  /**
   * Capacity guard for the local outbox. A profile that cannot reach the core
   * (wrong URL on another host, dead gateway, revoked key) would otherwise
   * append every turn to the JSONL forever and grow without bound. Once either
   * bound is crossed the OLDEST queued turns are dropped and a single warn
   * reports the cumulative count. Dead letters are never trimmed by this.
   */
  maxOutboxEntries: number;
  /** Byte bound for the outbox file as a whole; see maxOutboxEntries. */
  maxOutboxBytes: number;
}

export interface ToolsConfig {
  enabled: boolean;
  recall: boolean;
  recallTopK: number;
}

/** 资产反思段（task-82）：DSH 侧的 asset_reflection 等价实现。 */
export interface AssetReflectionConfig {
  /** 总开关：关掉后连 section 都不注册，提示词零改动。 */
  enabled: boolean;
  /** 触发 token：当轮用户文本出现**独立** token 时注入（缺省 /analyse）。 */
  triggerToken: string;
  /** 评测会话用：不认 token，每轮都注入（缺省 false）。 */
  alwaysOn: boolean;
  /** 反思块字符上限（超了按整行裁，保留闭合标签）。 */
  maxChars: number;
}

/**
 * 技能面（task-72）：把 core 的 `/v3/skill/*` 接成 head pack 段 + 模型工具。
 *
 * Why the read/write split: the core's own injector ships ten tools but its six
 * write tools never send `expected_version`, so they always answer 40001. The
 * plugin fixes that internally (skill-client.ts) and hides the repair behind
 * `allowLlmWrite`, which stays OFF by default: creating and deleting shared
 * team skills is a destructive capability, not a read.
 */
export interface SkillConfig {
  /** Master switch for the skill surface (head pack segment + tools). */
  enabled: boolean;
  /** Expose the six WRITE tools to the model (off = read-only). */
  allowLlmWrite: boolean;
  /** Character cap for the `<available_skills>` head-pack segment. */
  headPackChars: number;
  /** Default top_k for skill_search. */
  searchTopK: number;
  /** Cap for text handed back by one tool result (skill_view is 30K+). */
  maxResultChars: number;
  /** Per-call budget for /v3/skill/* requests. */
  timeoutMs: number;
}

export interface AgememConfig {
  enabled: boolean;
  server: ServerConfig;
  paths: AgememPaths;
  headPack: HeadPackConfig;
  volatile: VolatileConfig;
  writeback: WritebackConfig;
  tools: ToolsConfig;
  skill: SkillConfig;
  assetReflection: AssetReflectionConfig;
  debug: boolean;
  /**
   * Debug file mirror; empty means DSH_HOME/agemem/agemem.log. Written only
   * when `debug` is true, capped at 5 MB and rotated to `<path>.1`. A desktop
   * host has no readable stderr, so this file is the only observable channel
   * for what the plugin actually did in a GUI session.
   */
  debugLogFile: string;
}

export const DEFAULT_CONFIG: AgememConfig = {
  enabled: true,
  server: {
    baseUrl: 'http://127.0.0.1:8420',
    // Empty: the key is supplied by the profile patch or the credentials seam.
    apiKey: '',
    // The core's own key ref — deliberately not the proxy's TDB_API_KEY.
    apiKeyRef: 'TDAI_GATEWAY_APIKEY',
    serviceId: 'default',
    // Empty: resolution runs only when the profile supplies one.
    userKey: '',
    userKeyRef: 'TDAI_USER_KEY',
    // Empty on purpose: an install must never inherit the author's identity.
    // Supply these in the profile patch; empty makes the client inert.
    teamId: '',
    agentId: '',
    userId: '',
    // The core's first atomic/search after an idle period measured ~6.4s
    // (cold embedding model), so the default read/write budget must clear it.
    requestTimeoutMs: 10000,
    // 2 MiB: every real v3 envelope measured so far is far below this (a 100-row
    // atomic/search is tens of KB); 16 MiB is the hard ceiling, not the default.
    maxResponseBytes: 2 * 1024 * 1024,
  },
  paths: {
    coreRead: '/v3/core/read',
    atomicSearch: '/v3/atomic/search',
    scenarioLs: '/v3/scenario/ls',
    conversationAdd: '/v3/conversation/add',
    conversationDelete: '/v3/conversation/delete',
    skillConversationAdd: '/v3/skill/conversation/add',
    recall: '/v3/recall',
    health: '/health',
    metaAuthVerify: '/v3/meta/auth/verify',
    metaTeamList: '/v3/meta/team/list',
    metaAgentList: '/v3/meta/agent/list',
  },
  headPack: {
    enabled: true,
    orderOffset: 100,
    // Total budget for the whole stable prefix. One injection per session (the
    // section text is frozen; only compaction invalidates it), so 20000 is safe.
    // Per-segment caps live in src/segments/*: coreMemory 3000, L2 scene index
    // 3000, skills 8000, knowledge 3000, wiki 2000, persona = whatever is left.
    maxChars: 20000,
    timeoutMs: 10000,
    refreshMs: 300000,
    fallbackText: '',
    includeScenarioIndex: true,
    maxScenarioEntries: 20,
    // 3000: the measured 14-scene index renders ~2400 chars with summaries.
    l2Chars: 3000,
  },
  volatile: {
    enabled: true,
    // 1500 chars per turn = 600 soul + ~900 memory. Measured recall payloads:
    // 1 entry = 450 chars, 2 entries = 1214 chars; entries are clipped to 360
    // chars before budgeting. The old 1200 was all memory: the soul fragments
    // (identity 3343-3388 chars, feeling 36-40) never fit and were dropped
    // outright by recallBlockText, so the plugin injected memories without the
    // persona the proxy path always had.
    maxChars: 1500,
    soul: {
      enabled: true,
      // 600 chars: a trimmed persona brief, not the full 3.3K identity (which
      // would crowd out every memory entry). 100 floor / 3000 ceiling.
      maxChars: 600,
      includeFeeling: true,
    },
    // Deliberately below the core's cold-start cost: the volatile block rides in
    // pre-step, so losing one turn's injection beats stalling the step.
    timeoutMs: 3000,
    recall: true,
    recallMaxResults: 3,
    // Covers the measured 1250-2255ms distribution (~90th percentile); the tail
    // and the 5s cold start fail open into atomic/search, leaving 500ms of the
    // 3000ms volatile budget for that fallback (agent/created prewarm exists to
    // make the cold start rare).
    recallTimeoutMs: 2500,
    wiki: {
      // Off by default: see VolatileWikiConfig. Fail-open makes enabling it
      // safe, but a route that 404s is still one request per turn.
      enabled: false,
      topK: 3,
      perWikiLimit: 4,
      minScore: 0.02,
      maxChars: 800,
      timeoutMs: 2500,
    },
    knowledge: {
      // ON by default: `/v3/knowledge/list` answered 200 in 7ms on 8420
      // (measured 2026-11-01 02:05, 1 resource). The block is budget-bound,
      // so an empty team costs one cheap list call per turn.
      enabled: true,
      maxChars: 3000,
      maxResources: 8,
      timeoutMs: 2500,
    },
  },
  writeback: {
    enabled: true,
    // L2 would go dark without it; opt out explicitly for a shared identity.
    skillFeed: true,
    outboxPath: '',
    maxAttempts: 8,
    retryMs: 30000,
    // Core hard limits (see wire-limits.ts); the outbox used to write 20000-char
    // blocks, which the core answered with a 400 on every retry until the turn
    // dead-lettered and both sides of the exchange were lost.
    maxMessageChars: 8192,
    maxMessagesPerRequest: 100,
    // Below the measured 0.9 MB success point, well under the 1 MiB wall.
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    // 500 turns is days of a busy session; 20 MB keeps the JSONL cheap to read
    // and to rewrite on every flush.
    maxOutboxEntries: 500,
    maxOutboxBytes: 20 * 1024 * 1024,
  },
  tools: {
    enabled: true,
    recall: true,
    recallTopK: 8,
  },
  skill: {
    enabled: true,
    // Destructive (create/patch/delete on shared team skills): opt-in.
    allowLlmWrite: false,
    // 8000 chars is the core's default listing budget and renders ~90 skills.
    headPackChars: 8000,
    searchTopK: 10,
    // skill_view measured 30318 chars for one real head; 20000 keeps a whole
    // procedure in context while leaving the rest reachable via skill_files_read.
    maxResultChars: 20000,
    timeoutMs: 2500,
  },
  assetReflection: {
    // 注册成本为零（section 的 text 是函数，未触发时返回空串），所以缺省开；
    // 关掉它需要显式写 false（eval 对照组）。
    enabled: true,
    // 与 proxy 的 URL marker 同名，两侧口径可直接对照（见 parity 报告）。
    triggerToken: '/analyse',
    alwaysOn: false,
    // 600 字符：块本身约 400 字符，留出余量给长 token/技能名；再大就是抢
    // volatile 的 token 预算。
    maxChars: 600,
  },
  debug: false,
  // Empty: derived from DSH_HOME at mount (see debug-log.ts).
  debugLogFile: '',
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Floor for anything that becomes a timeout or an interval. pickNumber clamps
 * at 0, and 0ms of patience means "never wait": the request is aborted before
 * the socket is written, so a config typo silently disables recall/writes
 * instead of showing up as an error.
 */
const TIME_FLOOR_MS = 100;
/** Soul slot bounds: below 100 the tag overhead alone eats it; 3000 is the
 * point where the soul is the whole turn budget. */
const SOUL_MIN_CHARS = 100;
const SOUL_MAX_CHARS = 3000;
/** 反思块边界：低于 120 连标记行都放不下；4000 已超过任何合理提示词预算。 */
const REFLECTION_MIN_CHARS = 120;
const REFLECTION_MAX_CHARS = 4000;

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function mergeSection<T extends Record<string, any>>(
  defaults: T,
  raw: unknown,
  warnings: string[],
  label: string,
): T {
  if (!isRecord(raw)) return { ...defaults };
  const out: Record<string, any> = { ...defaults };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in defaults)) {
      warnings.push(`unknown config key ${label}${key}`);
      continue;
    }
    switch (typeof defaults[key]) {
      case 'boolean':
        out[key] = pickBool(value, defaults[key] as boolean);
        break;
      case 'number':
        out[key] = pickNumber(value, defaults[key] as number, 0, 10_000_000);
        break;
      case 'string':
        out[key] = pickString(value, defaults[key] as string);
        break;
      case 'object':
        out[key] = mergeSection(defaults[key] as Record<string, any>, value, warnings, `${label}${key}.`);
        break;
      default:
        break;
    }
  }
  return out as T;
}

function cloneDefaults(): AgememConfig {
  return {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server },
    paths: { ...DEFAULT_CONFIG.paths },
    headPack: { ...DEFAULT_CONFIG.headPack },
    volatile: {
      ...DEFAULT_CONFIG.volatile,
      soul: { ...DEFAULT_CONFIG.volatile.soul },
      wiki: { ...DEFAULT_CONFIG.volatile.wiki },
      knowledge: { ...DEFAULT_CONFIG.volatile.knowledge },
    },
    writeback: { ...DEFAULT_CONFIG.writeback },
    tools: { ...DEFAULT_CONFIG.tools },
    skill: { ...DEFAULT_CONFIG.skill },
    assetReflection: { ...DEFAULT_CONFIG.assetReflection },
  };
}

export interface NormalizedConfig {
  config: AgememConfig;
  warnings: string[];
}

/**
 * `AGEMEM_DEBUG=1` turns on the verbose path — the plugin may be mounted in a
 * GUI host whose log is the only way to see what it did.
 */
export function debugFromEnv(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const raw = env.AGEMEM_DEBUG;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '') return false;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return true;
}

/** Normalize raw plugin config into a complete, validated configuration. */
export function normalizeConfig(raw: unknown, env: Record<string, string | undefined> = process.env): NormalizedConfig {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) warnings.push('plugin config is not an object; using defaults');
    return { config: cloneDefaults(), warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key ${key}`);
  }
  const server = mergeSection(DEFAULT_CONFIG.server, raw.server, warnings, 'server.');
  server.baseUrl = pickString(server.baseUrl, DEFAULT_CONFIG.server.baseUrl).replace(/\/+$/, '');
  // Keep an empty key empty (pickString would fall back to the default, which is
  // also empty, so nothing to do) and never normalize a partial secret.
  server.apiKey = typeof server.apiKey === 'string' ? server.apiKey.trim() : '';
  server.userKey = typeof server.userKey === 'string' ? server.userKey.trim() : '';
  server.requestTimeoutMs = pickNumber(server.requestTimeoutMs, DEFAULT_CONFIG.server.requestTimeoutMs, 100, 120_000);
  server.maxResponseBytes = clampMaxResponseBytes(server.maxResponseBytes);
  const writeback = mergeSection(DEFAULT_CONFIG.writeback, raw.writeback, warnings, 'writeback.');
  const headPack = mergeSection(DEFAULT_CONFIG.headPack, raw.headPack, warnings, 'headPack.');
  const volatile = mergeSection(DEFAULT_CONFIG.volatile, raw.volatile, warnings, 'volatile.');
  const assetReflection = mergeSection(
    DEFAULT_CONFIG.assetReflection,
    raw.assetReflection,
    warnings,
    'assetReflection.',
  );
  // Time budgets get a >0 floor after merging, so nested values are covered too.
  server.requestTimeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(server.requestTimeoutMs));
  headPack.timeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(headPack.timeoutMs));
  headPack.refreshMs = Math.max(TIME_FLOOR_MS, Math.floor(headPack.refreshMs));
  // A negative or absurd L2 budget would either render nothing while the
  // switch is on, or ask for more than the segment registers with.
  headPack.l2Chars = Math.floor(pickNumber(headPack.l2Chars, DEFAULT_CONFIG.headPack.l2Chars, 0, 3000));
  volatile.timeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(volatile.timeoutMs));
  volatile.recallTimeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(volatile.recallTimeoutMs));
  // The soul slot is a SLICE of volatile.maxChars, not an addition: clamping it
  // to [100, 3000] keeps a typo (0 or 100000) from erasing the memories or the
  // whole turn budget.
  volatile.soul.maxChars = Math.floor(pickNumber(
    volatile.soul.maxChars,
    DEFAULT_CONFIG.volatile.soul.maxChars,
    SOUL_MIN_CHARS,
    SOUL_MAX_CHARS,
  ));
  // Wiki/knowledge segment ceilings: clamped so a typo cannot starve the memory
  // block (both share `volatile.maxChars` through the remainder).
  const wiki = volatile.wiki;
  wiki.topK = Math.floor(pickNumber(wiki.topK, DEFAULT_CONFIG.volatile.wiki.topK, 1, 20));
  wiki.perWikiLimit = Math.floor(pickNumber(wiki.perWikiLimit, DEFAULT_CONFIG.volatile.wiki.perWikiLimit, 1, 20));
  wiki.minScore = pickNumber(wiki.minScore, DEFAULT_CONFIG.volatile.wiki.minScore, 0, 10);
  wiki.maxChars = Math.floor(pickNumber(wiki.maxChars, DEFAULT_CONFIG.volatile.wiki.maxChars, 0, 2000));
  wiki.timeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(wiki.timeoutMs));
  const knowledge = volatile.knowledge;
  knowledge.maxChars = Math.floor(pickNumber(knowledge.maxChars, DEFAULT_CONFIG.volatile.knowledge.maxChars, 0, 3000));
  knowledge.maxResources = Math.floor(pickNumber(knowledge.maxResources, DEFAULT_CONFIG.volatile.knowledge.maxResources, 1, 32));
  knowledge.timeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(knowledge.timeoutMs));
  // A whitespace-only token would match every turn; EMPTY is equally unusable
  // (hasTriggerToken returns false for it), so both fall back to the default
  // instead of silently disabling the section.
  const reflectionToken = assetReflection.triggerToken.trim();
  assetReflection.triggerToken = reflectionToken === ''
    ? DEFAULT_CONFIG.assetReflection.triggerToken
    : reflectionToken;
  assetReflection.maxChars = Math.floor(pickNumber(
    assetReflection.maxChars,
    DEFAULT_CONFIG.assetReflection.maxChars,
    REFLECTION_MIN_CHARS,
    REFLECTION_MAX_CHARS,
  ));
  const skill = mergeSection(DEFAULT_CONFIG.skill, raw.skill, warnings, 'skill.');
  skill.headPackChars = Math.floor(pickNumber(skill.headPackChars, DEFAULT_CONFIG.skill.headPackChars, 0, 64000));
  skill.searchTopK = Math.floor(pickNumber(skill.searchTopK, DEFAULT_CONFIG.skill.searchTopK, 1, 50));
  skill.maxResultChars = Math.floor(pickNumber(skill.maxResultChars, DEFAULT_CONFIG.skill.maxResultChars, 1000, 60000));
  skill.timeoutMs = Math.max(TIME_FLOOR_MS, Math.floor(skill.timeoutMs));
  writeback.retryMs = Math.max(TIME_FLOOR_MS, Math.floor(writeback.retryMs));
  // Hard caps, not just defaults: exceeding either one makes the core reject the
  // whole batch, which is exactly the failure this config exists to prevent.
  writeback.maxMessageChars = pickNumber(
    writeback.maxMessageChars,
    DEFAULT_CONFIG.writeback.maxMessageChars,
    1,
    CORE_MAX_MESSAGE_CHARS,
  );
  writeback.maxMessagesPerRequest = pickNumber(
    writeback.maxMessagesPerRequest,
    DEFAULT_CONFIG.writeback.maxMessagesPerRequest,
    1,
    CORE_MAX_MESSAGES_PER_REQUEST,
  );
  writeback.maxRequestBytes = Math.floor(pickNumber(
    writeback.maxRequestBytes,
    DEFAULT_CONFIG.writeback.maxRequestBytes,
    1,
    CORE_MAX_REQUEST_BYTES,
  ));
  // Local disk guard, deliberately generous: at least one turn must fit, and a
  // 1 GB ceiling keeps the file readable by the recovery path.
  writeback.maxOutboxEntries = Math.floor(pickNumber(
    writeback.maxOutboxEntries,
    DEFAULT_CONFIG.writeback.maxOutboxEntries,
    1,
    100_000,
  ));
  writeback.maxOutboxBytes = Math.floor(pickNumber(
    writeback.maxOutboxBytes,
    DEFAULT_CONFIG.writeback.maxOutboxBytes,
    1024,
    1_000_000_000,
  ));
  const config: AgememConfig = {
    enabled: pickBool(raw.enabled, DEFAULT_CONFIG.enabled),
    server,
    paths: mergeSection(DEFAULT_CONFIG.paths, raw.paths, warnings, 'paths.'),
    headPack,
    volatile,
    writeback,
    tools: mergeSection(DEFAULT_CONFIG.tools, raw.tools, warnings, 'tools.'),
    skill,
    assetReflection,
    // Explicit config wins; otherwise AGEMEM_DEBUG decides.
    debug: typeof raw.debug === 'boolean' ? raw.debug : (debugFromEnv(env) ?? DEFAULT_CONFIG.debug),
    // Empty is meaningful here (derive from DSH_HOME), so do not run it through
    // pickString, which turns an empty string into the fallback.
    debugLogFile: typeof raw.debugLogFile === 'string' ? raw.debugLogFile.trim() : DEFAULT_CONFIG.debugLogFile,
  };
  return { config, warnings };
}
