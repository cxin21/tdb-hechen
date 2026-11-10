/**
 * TDAI Memory Gateway — v2 REST Router.
 *
 * Implements POST routes defined in `01-api-spec.yaml`:
 *
 *   L0 Conversation: add / query / search / delete
 *   L1 Atomic:       update / query / search / delete
 *   L2 Scenario:     ls / read / write / rm
 *   L3 Core:         read / write
 *
 * All data-plane routes are prefixed with `/v3/`（DSH 特化后 /v2 前缀已下线）。
 * Authentication: Authorization Bearer + x-tdai-service-id.
 * Request validation: Zod v4 safeParse → 400 on failure.
 * Response envelope: { code, message, request_id, data }.
 */

import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { classifyError } from "./error-handler.js";
import {
  UNKNOWN_PRINCIPAL,
  decideUnknownPrincipal,
  decideUserBinding,
  type AuthBindingConfig,
  type PrincipalLookup,
} from "./auth-binding.js";
// task-68：team 归属闸（缺省 off；warn 只记；enforce ⇒ 403 TEAM_NOT_OWNED）。
import {
  TEAM_NOT_OWNED,
  decideTeamOwnership,
  recordTeamOwnershipMetric,
  teamOwnershipNeedsLookup,
  type TeamOwnershipConfig,
  type TeamOwnershipLookup,
} from "./team-ownership.js";
import type { IMemoryStore, L0Record, ProfileSyncRecord } from "../core/store/types.js";
import { DEFAULT_ISOLATION_ID, type CoreTenant } from "../core/store/types.js";
// P1-T7：handleAtomicUpdate/Importance 的 soul 拷贝改用 L1SearchResult 原生窄类型
// （getL1ByIds 读回行），不再经 SoulColumnsOf 宽断言——string|number|null 联合
// 是那批 TS2322 的根因，且窄类型让 sensitivity/importance 补拷在类型层面可见。
import type { EmbeddingService } from "../core/store/embedding.js";
// S-FEEL-1（M1）：近期情绪基调聚合单一源（mood-line.ts；R-A：mood 不参与召回排序）。
import { computeMoodTier } from "../core/hooks/mood-line.js";
// #67（R3 身份叙事层，2026-10-19）：identity/self_identity 两槽确定性叙事组装单一源
//（/v3/core-memory/read format=narrative 主路；模板常量+事实句逐字，无 LLM/随机/时钟）。
import { IDENTITY_NARRATIVE_SLOT, renderIdentityNarrative } from "../core/hooks/identity-narrative.js";
import { createScopedStorageAdapter, type StorageAdapter } from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";
import type { Logger } from "../core/types.js";
import type { IStateBackend } from "../core/state/types.js";
import type { PipelineWorker } from "../services/pipeline-worker.js";
import { executeMemorySearch } from "../core/tools/memory-search.js";
import { excludeInvalidatedFor } from "../core/recall/validity-policy.js";
import type { RecallFactChannelConfig, RecallFusionConfig } from "../core/recall/fusion.js";
import { executeConversationSearch } from "../core/tools/conversation-search.js";
// 2026-11-07：价值锚写 API（upsert/delete/pin/retire/restore/derive/discover）与其数据表一并退场，
// 现无任何进程内写者；Panel 的 values/list 只读面仍消费 /v3/core-memory/read（本文件 handler 保留）。
import type { MemoryRecord } from "../core/record/l1-writer.js";
import { reportRecallMetrics } from "../core/report/metric-tracking-recall.js";
import {
  currentInjectionGuardMode,
  isPluginDeclared,
  scanInjectedBlocks,
  type InjectionGuardMode,
} from "./injection-guard.js";

// ── Zod schemas (validated types + defaults) ──
import {
  conversationAddRequestSchema,
  conversationQueryRequestSchema,
  conversationSearchRequestSchema,
  conversationDeleteRequestSchema,
  conversationCountRequestSchema,
  atomicUpdateRequestSchema,
  atomicQueryRequestSchema,
  atomicSearchRequestSchema,
  atomicDeleteRequestSchema,
  atomicCountRequestSchema,
  scenarioListRequestSchema,
  scenarioReadRequestSchema,
  scenarioWriteRequestSchema,
  scenarioRmRequestSchema,
  scenarioCountRequestSchema,
  coreWriteRequestSchema,
  coreCountRequestSchema,
  teamCreateRequestSchema,
  teamGetRequestSchema,
  teamUpdateRequestSchema,
  teamBatchDeleteRequestSchema,
  userCreateRequestSchema,
  userGetRequestSchema,
  userUpdateRequestSchema,
  userBatchDeleteRequestSchema,
  agentCreateRequestSchema,
  agentGetRequestSchema,
  agentUpdateRequestSchema,
  agentBatchDeleteRequestSchema,
  taskCreateRequestSchema,
  taskGetRequestSchema,
  taskUpdateRequestSchema,
  taskBatchDeleteRequestSchema,
  formatZodError,
  resolveIsolation,
  type ApiResponseEnvelope,
  type V2AuthContext,
  type ConversationItem,
  type ConversationSearchHit,
  type ConversationAddData,
  type ConversationQueryData,
  type ConversationSearchData,
  type ConversationDeleteData,
  type CountData,
  type AtomicDetail,
  type AtomicUpdateData,
  type AtomicQueryData,
  type AtomicSearchData,
  type AtomicSearchHit,
  type AtomicDeleteData,
  type ScenarioEntry,
  type ScenarioFile,
  type ScenarioWriteData,
  type CoreFile,
  type CoreWriteData,
  type BatchDeleteResult,
  type TeamData,
  type UserData,
  type AgentData,
  type TaskData,
} from "./v2-schemas.js";
import { stripSceneNavigation } from "../core/scene/scene-navigation.js";
// D-0（2026-09-21）：/v3/atomic/query 出参映射单一源——7 字段补齐 + 既有字段逐位。
import { handleAtomicQueryShape, handleAtomicSearchShape } from "./atomic-query-fields.js";
import { handleAtomicByIds } from "./atomic-by-ids.js";
// ADR-0025 行级溯源：L1.source_message_ids → L0 原话批量回读（面板「查看原话」数据端）。
import { handleConversationByIds } from "./conversation-by-ids.js";
import { escapeXmlTags } from "../utils/sanitize.js";
// #82：self_identity 采纳落槽（merge-on-adopt）唯一合并源——与 worker 演化语义同构，互不复制。
import { mergeIdentityFacts } from "../core/lifecycle/identity-discovery.js";
// P0-1A（issue #1）：description 质量门单一源（core/hooks，gateway→core 引用方向合法）
import { anchorDescriptionAttr, existingDescription } from "../core/hooks/anchor-desc.js";
import { buildProfileIsolationScope, buildProfileStableId, DEFAULT_PROFILE_SCOPE } from "../core/profile/profile-sync.js";
// DS-RECALL-MERGE-001（合并召回 · 核心单点）：/v3/recall 与 auto-recall 钩子共用的分层组装路径
import { performLayeredRecall } from "../core/hooks/auto-recall.js";
import { appendRecallJournal, type RecallJournalPerfMs } from "../core/recall/recall-journal.js";
import { collectSoulJournalFields } from "../core/soul/observation.js";
// #74（Batch A，2026-10-20）：端点路查询两级剥噪（sanitizeText/sanitizeRecallQuery 单一源在 utils/sanitize.ts）。
import { sanitizeRecallQuery } from "../utils/sanitize.js";

const TAG = "[tdai-gateway][v3]";

/**
 * /v3 是 L0–L3 数据面接口的"严格 isolation 版本"：
 *
 *   - 必填 team_id + agent_id + user_id（缺一即 422）
 *   - session_id 可选：传入则按 session 收敛；不传则按 (team, agent, user) 维度聚合
 *     —— 满足"agent 跨 session 聚合视图"（如治理面板的 L0/L1 总数）和
 *     "L2/L3 团队级聚合"（profile scope 公式忽略 session）两类场景
 *   - 不接受 legacy_compat_mode 退化
 *
 * DSH 特化（2026-11-01）：本网关唯一接入方是 DeepSeek Harness 插件（HTTP 直连），
 * 原先"同一 handler 双挂 /v2 + /v3"的孪生展开、16 条 @deprecated v2 entity 路由
 * （team/user/agent/task）与 /v2/pipeline/status 已整体下线；管理面元数据统一走
 * `/v3/meta/*`（metadata/router/v3-meta-router.ts）。`x-tdai-service-id` 必需校验保留
 * 在 parseV2Auth 内（v2 前缀没了，但 service-id 仍是 DSH 的调用身份来源）。
 */
const V3_PREFIX = "/v3";

/**
 * /v3 严格 isolation 必填字段。从 request body 或 x-tdai-* header 任一来源取到即可。
 *
 * v3 全部 L0–L3 接口仅强制 team + agent + user 三元组。
 * session_id 一律可选：
 *   - L0 conversation/* 与 L1 atomic/*：传 session 走 session 内收敛；不传按
 *     (team, agent, user) 跨 session 聚合（便于"agent 维度全量视图"，如
 *     team-memory-control 治理面的 layer-counts 展示总量）
 *   - L2 scenario/* 与 L3 core/*：原本就是 team+agent 级 profile 聚合，session 忽略
 *
 * 返回缺失字段列表（空数组表示全齐）。
 */
function collectV3Missing(
  _subpath: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const headerStr = (k: string): string | undefined => {
    const raw = headers[k] ?? headers[k.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === "string" ? raw : undefined;
  };
  const get = (bodyKey: string, headerKey: string): string => {
    const v = (body?.[bodyKey] as string | undefined) ?? headerStr(headerKey) ?? "";
    return typeof v === "string" ? v.trim() : "";
  };
  const missing: string[] = [];
  if (!get("team_id", "x-tdai-team-id")) missing.push("team_id");
  if (!get("agent_id", "x-tdai-agent-id")) missing.push("agent_id");
  if (!get("user_id", "x-tdai-user-id")) missing.push("user_id");
  // session_id 不再强制：底层 handler 在缺 session 时按 (team,agent,user) 聚合查询。
  return missing;
}

/**
 * task-68：做 team 归属校验的 /v3 子路径（写 + 读各一处，票面指定）。
 * 其余路径不动：off 档本来零查询；enforce 的灰度也只在这两处先开。
 */
const TEAM_OWNERSHIP_GATED_PATHS = new Set<string>(["/conversation/add", "/core/read"]);

/** /v3 强 isolation 覆盖的 L0–L3 子路径（去掉前缀后的 path）。 */
const V3_ALLOWED_SUBPATHS = new Set<string>([
  "/conversation/add",
  "/conversation/query",
  // ADR-0025 行级溯源：按 L0 record_id 批量回读原话（面板证据抽屉）。
  "/conversation/by-ids",
  "/conversation/search",
  "/conversation/delete",
  "/conversation/count",
  "/atomic/update",
  // P1 task-7：人工重要度调整。**补登**：handler 早就在 DATAPLANE_HANDLERS 里注册，
  // 但封闭清单一直漏了这一条 → /v3/atomic/importance 实际 404（面板滑杆调级线上不可用）。
  // A 项（2026-11-04）核对新端点时发现，一并修掉（只加清单项，语义零改动）。
  "/atomic/importance",
  // A 项（ADR-0025 决定 10）：显式降敏（Panel 记忆详情「解除敏感标记」上游）
  "/atomic/sensitivity",
  // P1 task-8：记忆软失效/撤销失效（bi-temporal 补口；handleAtomicUpdate valid_end 写路的语义化薄封装）
  "/atomic/invalidate",
  "/atomic/query",
  "/atomic/neighbors",
  // C6（graph 设计 §4 / spec §6.4 #1）：两节点间 BFS 最短路径（requestIsolation 消费同 neighbors）
  "/atomic/path",
  "/atomic/search",
  "/atomic/by-ids",
  // DS-RECALL-MERGE-001（合并召回 · 核心单点）：组装好的注入块返回端点（v3-only，不挂 /v2 孪生）
  "/recall",
  "/atomic/archive/list",
  "/atomic/archive/restore",
  "/core-memory/read",
  // S-FEEL-1（M1/S6）：近期情绪基调只读端点（Panel BFF /chat-memory/mood 上游；enabled=false 返回 tier:null）
  "/memory/mood",
  // O13（P2）：红线类提案人工采纳落点（v3-only；422/401 由 v3 dispatch 层统一执行）
  "/atomic/delete",
  "/atomic/count",
  "/scenario/ls",
  "/scenario/read",
  "/scenario/write",
  "/scenario/rm",
  "/scenario/count",
  "/core/read",
  "/core/write",
  "/core/count",
]);

/**
 * 写一条审计事件到 store.appendAudit。失败不阻塞主请求（容忍 audit 丢失）。
 *
 * 调用约定（per user 决策）：
 *   - 原始 L0/L1/L2/L3 表完全不动，本函数只追加事件
 *   - team/agent/user/task 来自外部请求 IdFields（resolveIsolation 后的 ctx）
 *   - L0 不参与（不可变流水）
 *   - 5 个 mutation handler 各调一次：
 *     atomic/update + atomic/delete + scenario/write + scenario/rm + core/write
 */
async function recordAudit(
  store: IMemoryStore | undefined,
  args: {
    record_id: string;
    layer: "L1" | "L2" | "L3";
    /** 'sensitivity'（A 项）：显式降敏——安全相关的人工动作，必须与 update/delete 同等留痕。 */
    action: "update" | "delete" | "sensitivity";
    iso?: { teamId?: string; userId?: string; agentId?: string; sessionId?: string; taskId?: string };
    version: number;
    requestId: string;
    logger?: { warn?: (msg: string) => void };
  },
): Promise<void> {
  if (!store?.appendAudit) return; // store 不支持 audit → 跳过
  try {
    await store.appendAudit({
      audit_id: `audit-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      record_id: args.record_id,
      layer: args.layer,
      action: args.action,
      team_id: args.iso?.teamId,
      agent_id: args.iso?.agentId,
      user_id: args.iso?.userId,
      task_id: args.iso?.taskId,
      version: args.version,
      updated_at_ms: Date.now(),
      request_id: args.requestId,
    });
  } catch (err) {
    args.logger?.warn?.(
      `${TAG} audit append failed (${args.layer}/${args.action} record=${args.record_id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================
// Dependencies injected at mount time
// ============================

export interface V2RouterDeps {
  /** Get the default IMemoryStore (standalone fallback). */
  getStore: () => IMemoryStore | undefined;
  /** Get the default EmbeddingService (standalone fallback). */
  getEmbedding: () => EmbeddingService | undefined;
  /** Get the default StorageAdapter (standalone fallback). */
  getStorage: () => StorageAdapter | undefined;
  /**
   * DS-RECALL-MERGE-001（合并召回）：core 数据根目录 getter（/v3/recall 组装路径的
   * scene index / profile scope 基底，与 TdaiCore 的 pluginDataDir 同源——server.ts 接线
   * `() => this.config.data.baseDir`）。仅 /v3/recall 消费；缺失 → 端点 503（loud，不静默）。
   */
  getDataDir?: () => string;
  /** Gateway config（J：memory.search.neighborExpand 从这里读；可选，缺省=功能关）。 */
  config?: { memory?: { search?: { neighborExpand?: { enabled?: boolean; maxHop?: number; maxAdd?: number } }; coreMemory?: import("../config.js").MemoryCoreMemoryConfig } };
  logger: Logger;

  /**
   * Deploy mode of the gateway. Controls behaviors that diverge between
   * single-node open-source ("standalone") and cloud multi-tenant ("service"):
   *   - standalone: mirror v2 conversation/add L0 to <dataDir>/conversations/<date>.jsonl
   *                 (parity with v1 capture path; useful for human inspection / seed verify)
   *   - service:    skip the JSONL mirror — service stores authoritative L0 in TCVDB +
   *                 COS via its own pathway; mirroring to local FS would write to
   *                 ephemeral pod disk and is operationally meaningless.
   */
  deployMode: "standalone" | "service";

  // ── Service-mode per-instance resolvers (optional) ──
  // When provided, v2 handlers resolve store/storage per-request using
  // auth.serviceId as the instanceId key, falling back to the static getters above.

  /** Resolve IMemoryStore + EmbeddingService for a given instanceId (service mode). */
  resolveStore?: (instanceId: string) => Promise<{ store: IMemoryStore; embedding: EmbeddingService | undefined }>;
  /** Resolve per-instance StorageAdapter for a given instanceId (service mode). */
  resolveStorage?: (instanceId: string) => Promise<StorageAdapter | undefined>;

  /**
   * Notify pipeline that new L0 messages were added for a session.
   * Triggers async L1 extraction via state-backend Buffer → Scanner → Worker.
   *
   * Wired in both modes:
   *   - service mode: remote state backend
   *   - standalone: LocalStateBackend (single-process, default)
   * When absent (misconfiguration), v2 add writes L0 only — pipeline is not triggered.
   */
  notifyPipeline?: (instanceId: string, sessionId: string, messageCount: number, teamId?: string, agentId?: string) => Promise<void>;

  /** Quota manager for memory/credit limit checks and usage reporting (service mode). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;

  /**
   * 拿到 (per instance) 的 MetadataService。仅当 `/v2/conversation/add` 首次
   * 写入某 (team, agent) 时用来自动登记 chat_memory 资产并绑定到 agent。
   * 未注入时该功能优雅降级：conversation 依旧正常写入，只是资产不会被自动
   * 创建 —— 老部署完全兼容。
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;

  /**
   * State backend handle（listQueuedTasks 为可选实现）。原 /v2/pipeline/status 已随
   * DSH 特化下线；本字段保留，server.ts 仍按既有路径注入。
   */
  stateBackend?: IStateBackend;

  /**
   * Pipeline worker handle。原 /v2/pipeline/status 已下线；字段保留（server.ts 仍注入）。
   */
  pipelineWorker?: PipelineWorker;

  // ── Tenancy isolation (three-dim) ──
  //
  // `isolationConfig` is set once at gateway start.  `requestIsolation` and
  // `requestIsolationMissing` are filled per-request by dispatchV2Request so
  // each handler can persist (user_id, agent_id, session_id) on writes
  // without changing handler signatures.

  /** Static config for isolation enforcement (set at gateway start). */
  isolationConfig?: {
    enforce: boolean;
    legacyCompatMode: boolean;
    legacyPlaceholder: string;
  };
  /**
   * Whether `/v3` L0–L3 enforces the team+agent+user triple.
   * Undefined defaults to strict to preserve direct router unit-test semantics;
   * server.ts injects the env-backed value, whose runtime default is OFF.
   * `/v3/skill/*` is always exempt.
   */
  v3StrictIsolation?: boolean;
  /**
   * #红队②（task-60）：数据面归属校验开关。**未注入 ⇒ 完全不走新分支**，
   * 行为与今天逐位相同（服务级信任：Bearer 通过即认请求声明的 user_id）。
   * server.ts 注入 resolveAuthBindingConfig()，其缺省值为三项全关。
   */
  authBinding?: AuthBindingConfig;
  /**
   * #红队②（task-60）：写侧主体存在性查询（entity_teams / entity_users /
   * entity_agents）。**未注入 ⇒ 写侧校验整体 no-op**。返回 null 表示本次
   * 查不了（不拦）；某维度 true/false 才参与 unknownPrincipalPolicy 判定。
   */
  lookupPrincipal?: (ids: { teamId?: string; agentId: string; userId: string }) => Promise<PrincipalLookup | null>;
  /**
   * task-68：team 归属查询（x-tdai-user-key → userId，再查 team→member 关系）。
   * 由 server.ts 注入 gateway/team-ownership-resolver.ts 的 LRU 版本；
   * 未注入 ⇒ 归属闸恒 fail-open（只 warn + 计数 metadata_error）。
   */
  checkTeamOwnership?: (input: {
    instanceId: string;
    teamId: string;
    userKey: string;
  }) => Promise<TeamOwnershipLookup>;
  /** Resolved isolation context for the current request (set by dispatch). */
  requestIsolation?: { teamId?: string; userId: string; agentId: string; sessionId: string; taskId?: string };
  /** When isolation could not be resolved AND legacy_compat_mode is off, the missing fields. */
  requestIsolationMissing?: string[];

  /**
   * D-8（2026-10-31）：注入块处置档位（allow/skip/reject）。未注入 ⇒ 读环境变量
   * TDB_INJECTION_GUARD_MODE，仍为空则 skip（见 gateway/injection-guard.ts 顶部论证）。
   */
  injectionGuardMode?: InjectionGuardMode;
  /**
   * D-8：写侧自我声明的来源种类（请求头 x-tdai-source-kind，如
   * `plugin:tdb-agemem-dsh`）。与注入标记同时命中才允许 reject 档位升级为 400。
   */
  requestSourceKind?: string;

  /**
   * C2（spec §3.2）：动机方向（valence）LLM 判定用 runner 的 getter（server.ts 惰性构造
   * + 进程级缓存后注入）。类型与 store.deriveValueValences 的 llmRunner 参数同形（结构化
   * 最小面，store 不依赖 core/types，避免环）。未注入 / LLM 未配置 → resolve 为 undefined：
   *   - /core-memory/values/derive → 503（R3：降级可见）；
   *   - values/upsert 的 fire-and-forget 钩子 → 安静跳过（值保持 NULL，渲染不输出方向行）。
   */
  getValueValenceLlmRunner?: () => Promise<
    { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number }): Promise<string> } | undefined
  >;
}

// ============================
// Envelope helpers
// ============================

export function makeRequestId(): string {
  return `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** 优先使用上游 x-request-id / x-qcloud-transaction-id，否则本地生成。 */
export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers["x-qcloud-transaction-id"] ?? headers["x-request-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === "string" && id.trim()) return id.trim();
  return makeRequestId();
}

export function successEnvelope<T>(data: T, requestId: string): ApiResponseEnvelope<T> {
  return { code: 0, message: "ok", request_id: requestId, data };
}

export function errorEnvelope(code: number, message: string, requestId: string, extra?: Record<string, unknown>): ApiResponseEnvelope {
  return { code, message, request_id: requestId, ...(extra ? { data: extra } : {}) };
}

// ============================
// Auth middleware
// ============================

export function parseV2Auth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  sendJsonFn: (res: http.ServerResponse, status: number, body: unknown) => void,
): V2AuthContext | null {
  const authHeader = req.headers["authorization"] ?? "";
  const serviceId = (req.headers["x-tdai-service-id"] as string) ?? "";

  if (!authHeader.startsWith("Bearer ") || !authHeader.slice(7).trim()) {
    sendJsonFn(res, 401, errorEnvelope(401, "Missing or invalid Authorization header. Expected: Bearer {api_key}", requestId));
    return null;
  }
  if (!serviceId.trim()) {
    sendJsonFn(res, 401, errorEnvelope(401, "Missing x-tdai-service-id header", requestId));
    return null;
  }

  return Object.fromEntries([
    ["apiKey", authHeader.slice(7).trim()],
    ["serviceId", serviceId.trim()],
  ]) as V2AuthContext;
}

// ============================
// Per-request resolution helpers
// ============================

/** Resolve store + embedding for a v2 request. Service mode → per-instance; standalone → core singleton. */
async function resolveStoreForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<{ store: IMemoryStore | undefined; embedding: EmbeddingService | undefined }> {
  if (deps.resolveStore) {
    // Service mode: per-instance VDB store is mandatory. Do NOT fallback to local SQLite.
    return await deps.resolveStore(auth.serviceId);
  }
  // Standalone mode: use core singleton store
  return { store: deps.getStore(), embedding: deps.getEmbedding() };
}

/** Resolve storage adapter for a v2 request. Service mode → per-instance COS; standalone → core local. */
async function resolveStorageForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<StorageAdapter | undefined> {
  if (deps.resolveStorage) {
    // Service mode: per-instance COS storage is mandatory. Do NOT fallback to local filesystem.
    return await deps.resolveStorage(auth.serviceId);
  }
  // Standalone mode: use core local storage
  return deps.getStorage();
}

// ============================
// Route table
// ============================

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
) => Promise<ApiResponseEnvelope>;

/**
 * L0–L3 数据面 handler 映射（子路径 → handler）。DSH 特化后一律只挂 `/v3/*`
 * （/v2 孪生展开已下线），全部走严格 isolation 校验。
 */
const DATAPLANE_HANDLERS: Record<string, RouteHandler> = {
  "/conversation/add": handleConversationAdd,
  "/conversation/query": handleConversationQuery,
  // ADR-0025 行级溯源（同 /atomic/by-ids 先例）：按 id 批量回读 L0 原话。
  "/conversation/by-ids": handleConversationByIds,
  "/conversation/search": handleConversationSearch,
  "/conversation/delete": handleConversationDelete,
  "/conversation/count": handleConversationCount,
  "/atomic/update": handleAtomicUpdate,
  // P1 task-7：人工重要度调整（Panel 记忆详情）
  "/atomic/importance": handleAtomicImportance,
  // A 项（ADR-0025 决定 10）：显式降敏（sensitivity 单向棘轮下限的唯一写路）
  "/atomic/sensitivity": handleAtomicSensitivity,
  // P1 task-8：记忆软失效/撤销失效（Panel 记忆详情「标记失效/撤销失效」上游）
  "/atomic/invalidate": handleAtomicInvalidate,
  "/atomic/query": handleAtomicQuery,
  "/atomic/neighbors": handleAtomicNeighbors,
  "/atomic/path": handleAtomicPath,
  "/atomic/search": handleAtomicSearch,
  "/atomic/by-ids": handleAtomicByIds,
  "/atomic/archive/list": handleArchiveList,
  "/atomic/archive/restore": handleArchiveRestore,
  "/core-memory/read": handleCoreMemoryRead,
  // S1（K7/M-5）：原子记忆读写路由
  "/atomic/delete": handleAtomicDelete,
  "/atomic/count": handleAtomicCount,
  "/scenario/ls": handleScenarioLs,
  "/scenario/read": handleScenarioRead,
  "/scenario/write": handleScenarioWrite,
  "/scenario/rm": handleScenarioRm,
  "/scenario/count": handleScenarioCount,
  "/core/read": handleCoreRead,
  "/core/write": handleCoreWrite,
  "/core/count": handleCoreCount,
};

const routeTable: Record<string, RouteHandler> = {
  // L0–L3 数据面：DSH 特化后只保留 /v3 入口（/v2 孪生展开已于 2026-11-01 下线）。
  ...Object.fromEntries(
    Object.entries(DATAPLANE_HANDLERS).map(([sub, h]) => [`${V3_PREFIX}${sub}`, h] as const),
  ),
  // DS-RECALL-MERGE-001（合并召回 · 核心单点）：/v3/recall 仅挂 v3 入口（严格 isolation 家族；
  // 不进 DATAPLANE_HANDLERS，因为它不是 L0–L3 单层端点而是分层组装入口）。
  [`${V3_PREFIX}/recall`]: handleRecall,
  // S-FEEL-1（M1/S6）：近期情绪基调只读端点——Panel BFF /chat-memory/mood 上游（不要求完整召回；
  // enabled=false 时返回 {tier:null}，逐位现状语义）。
  [`${V3_PREFIX}/memory/mood`]: handleMemoryMood,
};

export async function handleV2Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V2RouterDeps,
  /**
   * Optional: extra routes contributed by other modules (e.g.
   * /v3/skill/* from `makeSkillRouteTable()`). Looked up only when the
   * built-in `routeTable` doesn't contain the pathname, so module-level
   * routes always win on collision. Supports `/v3/*` (L0–L3
   * data-plane + extraRouteTable for /v3/skill/*, /v3/knowledge/*,
   * /v3/wiki/*, /v3/chat-memory/*, /v3/admin/*).
   *
   * The handler's `deps` parameter is intentionally typed `unknown` here:
   * extra modules (skill/*, future namespaces) declare their own deps
   * shape (e.g. `SkillRouterDeps`). The caller is responsible for passing
   * a `deps` object that satisfies the union of every handler set's
   * requirements; v2-router just forwards it verbatim.
   */
  extraRouteTable?: Record<
    string,
    (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>
  >,
): Promise<boolean> {
  // DSH 特化（2026-11-01）：/v3/memory-prompt/* 与 /v3/memory-generation-log/* 已整包下线
  // （dsh-plugin 与 MemoryPanel 双向 grep 均 0 客户端），原先为它们开的 GET 放行例外一并删除。
  if (method !== "POST") return false;
  const isV3 = pathname.startsWith(`${V3_PREFIX}/`);
  // Management-plane modules are provided by extraRouteTable, not by the
  // built-in V3 data-plane list. They bypass strict L0-L3 isolation because
  // each module validates its own target semantics.
  const isV3Extra = !!extraRouteTable && (
    pathname.startsWith("/v3/skill/") ||
    pathname.startsWith("/v3/knowledge/") ||
    // task-73：core wiki 薄转发（/v3/wiki/list、/v3/wiki/search）走 extraRouteTable，
    // 不登记前缀会被下面的 V3_ALLOWED_SUBPATHS 封闭清单拦成 404。
    pathname.startsWith("/v3/wiki/") ||
    pathname.startsWith("/v3/chat-memory/") ||
    // spec §3.2：admin settings 路由经 extraRouteTable 分发，必须放行前缀，
    // 否则 isV3 && !isV3Extra 走 V3_ALLOWED_SUBPATHS 封闭清单 → 永远 404。
    pathname.startsWith("/v3/admin/")
  );
  if (!isV3) return false;

  // /v3 暴露 L0–L3 数据面 14 条（V3_ALLOWED_SUBPATHS）+ /v3/skill/* + /v3/knowledge/*（extraRouteTable）；
  // 其他 /v3 子路径直接走 404
  if (isV3 && !isV3Extra) {
    const sub = pathname.slice(V3_PREFIX.length);
    if (!V3_ALLOWED_SUBPATHS.has(sub)) return false;
  }

  const handler = routeTable[pathname];
  const extra = extraRouteTable?.[pathname];
  if (!handler && !extra) return false;

  const requestId = makeRequestId();
  // [skill-perf 2026-07-21] 只对 /v3/skill/ 打分段耗时，避免污染其他链路 log。
  // T0 从 server.ts socket-level 埋点取；没有则用 dispatch 进入时刻兜底。
  const isSkillPerf = pathname.startsWith("/v3/skill/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perfT0 = isSkillPerf ? ((req as any).__skillPerfT0 as number | undefined) ?? Date.now() : 0;
  // 把 request_id 挂到 res 上，让 server.ts 的 res.on('finish') 也能带上
  if (isSkillPerf) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).__skillReqId = requestId;
    deps.logger.info(
      `[skill-perf] dispatch.enter req_id=${requestId} path=${pathname} t=${Date.now()} t0_offset=${Date.now() - perfT0}ms`,
    );
  }
  const perfMark = (phase: string, extraFields?: string) => {
    if (!isSkillPerf) return;
    const now = Date.now();
    deps.logger.info(
      `[skill-perf] phase=${phase} req_id=${requestId} elapsed=${now - perfT0}ms${extraFields ? " " + extraFields : ""}`,
    );
  };

  const authStart = Date.now();
  const auth = parseV2Auth(req, res, requestId, sendJson);
  if (isSkillPerf) {
    perfMark("parseAuth", `dur=${Date.now() - authStart}ms ok=${auth ? "true" : "false"}`);
  }
  if (!auth) return true;

  try {
    // Pre-resolve per-request store/storage (service mode → per-instance, standalone → core singleton)
    const resolveStart = Date.now();
    const resolved = await resolveStoreForRequest(auth, deps);
    const resolvedStorage = await resolveStorageForRequest(auth, deps);
    perfMark("resolveStoreAndStorage", `dur=${Date.now() - resolveStart}ms serviceId=${auth.serviceId}`);

    // Wrap deps so handlers use the resolved per-instance resources
    const resolvedDeps: V2RouterDeps = {
      ...deps,
      getStore: () => resolved.store,
      getEmbedding: () => resolved.embedding,
      getStorage: () => resolvedStorage,
    };

    const bodyStart = Date.now();
    // dispatch 门已把非 POST 全部拒掉（原 GET 放行只服务 memory-prompt /
    // memory-generation-log 两族读接口，DSH 特化后已下线）⇒ 这里恒走 JSON body。
    const body = await parseJsonBody(req);
    perfMark("parseJsonBody", `dur=${Date.now() - bodyStart}ms len=${req.headers["content-length"] ?? "?"}`);

    // Tenancy isolation — pulled from body (preferred) or x-tdai-* headers
    // and attached to the per-request deps so handlers can persist
    // (user_id, agent_id, session_id) on every L0/L1 write without
    // changing every handler signature.
    //
    // We only attempt resolution; whether missing fields are fatal is up
    // to each handler. See resolveIsolation() in v2-schemas.
    //
    // /v3 走严格校验：必须同时提供 team_id + agent_id + user_id + session_id，
    // 缺任意一个直接 422，且不走 legacyCompatMode 退化（/v2 已下线，恒 false）。
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const isoLegacyCompat = false;
    const isoResolved = resolveIsolation(body as Record<string, unknown> | undefined, headers, {
      legacyCompatMode: isoLegacyCompat,
      legacyPlaceholder: deps.isolationConfig?.legacyPlaceholder,
    });

    // /v3 strict isolation is for L0–L3 memory data-plane only.
    // Skill and knowledge endpoints are team-scoped management-plane
    // and must not be blocked by per-agent memory isolation.
    // Runtime default comes from server.ts/env and is OFF;
    // undefined keeps strict in direct router tests for backward compatibility.
    const v3StrictEnabled = deps.v3StrictIsolation ?? true;
    if (isV3 && !isV3Extra && v3StrictEnabled) {
      const v3Subpath = pathname.slice(V3_PREFIX.length);
      const v3Missing = collectV3Missing(v3Subpath, body as Record<string, unknown> | undefined, headers);
      if (v3Missing.length > 0) {
        sendJson(res, 422, errorEnvelope(
          422,
          `/v3 requires strict isolation: missing ${v3Missing.join(", ")}. ` +
          `Provide via request body or x-tdai-{team-id,agent-id,user-id,session-id} headers.`,
          requestId,
        ));
        return true;
      }
    }

    // ── #红队②（task-60）：数据面归属校验（缺省全关 ⇒ 逐位现状） ──
    // 红队实测：单凭 Bearer 可用任意 user_id 读甚至删 L0。但直接要求
    // user_id = 凭据主体会把现有 DSH 插件 / MemoryProxy（共享密钥 + 三 header
    // 身份模型）全部打挂，所以做成可配开关，缺省保持服务级信任。
    const authBinding = deps.authBinding;
    if (isV3 && !isV3Extra && authBinding) {
      const headerOne = (k: string): string => {
        const raw = headers[k] ?? headers[k.toLowerCase()];
        const v = Array.isArray(raw) ? raw[0] : raw;
        return typeof v === "string" ? v.trim() : "";
      };
      if (authBinding.requireUserBinding) {
        // ② 凭据主体与请求声明的 user_id 必须一致（body 优先，其次 x-tdai-user-id）
        const claimedUserId = String(
          (body as Record<string, unknown> | undefined)?.user_id ?? headerOne("x-tdai-user-id"),
        ).trim();
        const binding = decideUserBinding({
          config: authBinding,
          requestUserId: claimedUserId,
          userKey: headerOne("x-tdai-user-key"),
          userType: headerOne("x-tdai-user-type"),
          adminBypass: headerOne("x-tdai-admin-bypass"),
        });
        if (!binding.allow) {
          deps.logger.warn(
            `${TAG} [${pathname}] ${binding.code} uid=${claimedUserId || "<empty>"} req_id=${requestId}`,
          );
          sendJson(res, 403, errorEnvelope(403, `${binding.code}: ${binding.reason}`, requestId, { code: binding.code }));
          return true;
        }
        // ④ admin 显式旁路：放行但留痕（审计可查谁绕过）
        if (binding.bypassed) {
          deps.logger.warn(
            `${TAG} [${pathname}] USER_BINDING_ADMIN_BYPASS uid=${claimedUserId || "<empty>"} req_id=${requestId}`,
          );
        }
      }
      // ③ 未知主体：off ⇒ 不查；warn ⇒ 记日志放行；reject ⇒ 400。
      // 判据是 method === "POST"，而 /v3 的读端点（conversation/query 等）同样是 POST
      // ⇒ **读面同样生效**（2026-11-01 隔离实例实测；旧注释「只对写生效、读面不拦」已证伪，
      // 见 docs/ops/core-auth-binding.md §2 ③）。
      if (method === "POST" && authBinding.unknownPrincipalPolicy !== "off" && deps.lookupPrincipal) {
        try {
          // teamId 不在 resolveIsolation 的返回类型里（运行时才有），与 user_id 同口径现取
          const lookupTeamId = String(
            (body as Record<string, unknown> | undefined)?.team_id ?? headerOne("x-tdai-team-id"),
          ).trim() || undefined;
          const lookup = await deps.lookupPrincipal({
            teamId: lookupTeamId,
            agentId: isoResolved.ctx.agentId,
            userId: isoResolved.ctx.userId,
          });
          const principal = decideUnknownPrincipal(authBinding.unknownPrincipalPolicy, lookup);
          if (principal.action === "reject") {
            deps.logger.warn(
              `${TAG} [${pathname}] ${UNKNOWN_PRINCIPAL} unknown=${principal.unknown.join(",")} req_id=${requestId}`,
            );
            sendJson(res, 400, errorEnvelope(
              400,
              `${UNKNOWN_PRINCIPAL}: unknown ${principal.unknown.join(", ")} for team=${lookupTeamId ?? ""} agent=${isoResolved.ctx.agentId} user=${isoResolved.ctx.userId}`,
              requestId,
              { code: UNKNOWN_PRINCIPAL, unknown: principal.unknown },
            ));
            return true;
          }
          if (principal.action === "warn") {
            deps.logger.warn(
              `${TAG} [${pathname}] ${UNKNOWN_PRINCIPAL} (warn-only) unknown=${principal.unknown.join(",")} req_id=${requestId}`,
            );
          }
        } catch (err) {
          // 查询失败不拦写（软失败），但必须留痕，避免静默降级
          deps.logger.warn(
            `${TAG} [${pathname}] principal lookup failed (soft) req_id=${requestId}: ${(err as Error)?.message ?? String(err)}`,
          );
        }
      }
    }

    // ── task-68（#137 跟进）：team 归属闸（缺省 off ⇒ 逐位现状）──
    //
    // 缺口：collectV3Missing 只校验三 ID **非空**，任意 team_id 都能开自己的
    // 命名空间。这里补的正是「这个 team 属不属于本调用方」。
    // 灰度口径（Lead 拍板）：默认 off；warn 只记审计与计数；enforce 才 403。
    // enforce 用 403 TEAM_NOT_OWNED 而不是 401/404：调用方身份本身可能是合法的，
    // 缺的是这一对 (team, user) 的归属，语义上属于「禁止」而不是「未认证」。
    if (isV3 && !isV3Extra && deps.authBinding && TEAM_OWNERSHIP_GATED_PATHS.has(pathname.slice(V3_PREFIX.length))) {
      // 显式映射，不把 AuthBindingConfig 当 TeamOwnershipConfig 用（字段同名但语义独立）：
      // 归属判定只需要 mode + whitelist 两项。
      const teamOwnership: TeamOwnershipConfig = {
        mode: deps.authBinding.requireTeamOwnership,
        whitelist: deps.authBinding.teamOwnershipWhitelist ?? [],
      };
      if (teamOwnership.mode !== "off") {
        const headerRaw = (k: string): string => {
          const raw = headers[k] ?? headers[k.toLowerCase()];
          const v = Array.isArray(raw) ? raw[0] : raw;
          return typeof v === "string" ? v.trim() : "";
        };
        // team 只从 body / header 取（IsolationContext 里没有 teamId：team 是
        // 数据面作用域而不是请求身份的一部分）。两者都空 ⇒ teamId="" ⇒
        // decideTeamOwnership 按 lookup_unavailable 放行，不因缺 team 打死调用方。
        const teamId = String(
          (body as Record<string, unknown> | undefined)?.team_id ?? headerRaw("x-tdai-team-id") ?? "",
        ).trim();
        const userKey = headerRaw("x-tdai-user-key");
        const needsLookup = teamOwnershipNeedsLookup({ config: teamOwnership, teamId, userKey });
        let lookup: TeamOwnershipLookup | null = null;
        if (needsLookup && deps.checkTeamOwnership) {
          try {
            lookup = await deps.checkTeamOwnership({ instanceId: auth.serviceId, teamId, userKey });
          } catch (err) {
            // metadata 抖动不挡写：fail-open，但必须留痕（resolver 已 warn-once，这里计数）
            lookup = null;
            deps.logger.warn(
              `${TAG} [${pathname}] team ownership lookup failed (fail-open) req_id=${requestId}: ` +
                `${(err as Error)?.message ?? String(err)}`,
            );
          }
        }
        const decision = decideTeamOwnership({ config: teamOwnership, teamId, userKey, lookup });
        recordTeamOwnershipMetric(decision.metric);
        const claimedUserId = String(
          (body as Record<string, unknown> | undefined)?.user_id ?? headerRaw("x-tdai-user-id") ?? "",
        ).trim() || (lookup?.callerUserId ?? "");
        const metricLine =
          `${TAG} [${pathname}] authz.team_ownership.${decision.metric} ` +
          `mode=${teamOwnership.mode} why=${decision.why} ` +
          `team=${teamId || "<empty>"} user=${claimedUserId || "<empty>"} ` +
          `caller=${lookup?.callerUserId ?? "<none>"} req_id=${requestId}`;
        if (decision.allow) {
          if (decision.warn) deps.logger.warn(metricLine);
          else deps.logger.debug?.(metricLine);
        } else {
          deps.logger.warn(metricLine);
          sendJson(res, 403, errorEnvelope(
            403,
            `${TEAM_NOT_OWNED}: ${decision.reason}`,
            requestId,
            {
              code: TEAM_NOT_OWNED,
              team_id: teamId,
              user_id: claimedUserId,
              hint: "x-tdai-user-key must belong to an active member of the requested team; " +
                "or configure memory.auth.teamOwnershipWhitelist for legacy teams",
            },
          ));
          return true;
        }
      }
    }

    const depsWithIsolation: V2RouterDeps = {
      ...resolvedDeps,
      // /v3 路径强制覆盖 isolationConfig.enforce，确保 handler 内部一致地走严格分支
      isolationConfig: isV3
        ? { enforce: true, legacyCompatMode: false, legacyPlaceholder: resolvedDeps.isolationConfig?.legacyPlaceholder ?? "" }
        : resolvedDeps.isolationConfig,
      requestIsolation: isoResolved.ctx,
      // D-8：把写侧自我声明的来源种类带进 handler（注入守卫用它区分「插件自注」
      // 与「用户引用」，只有两者同时成立才允许 reject 升级为 400）。
      requestSourceKind: (() => {
        const raw = headers["x-tdai-source-kind"] ?? headers["x-tdai-source-kind".toUpperCase()];
        const v = Array.isArray(raw) ? raw[0] : raw;
        return typeof v === "string" ? v.trim() : undefined;
      })(),
      // resolveIsolation always returns { ok: true } — missing fields are filled with defaults.
      // requestIsolationMissing is only set when the caller explicitly needs to reject incomplete
      // isolation (e.g. /v3 strict mode), which is handled separately above via collectV3Missing.
      requestIsolationMissing: undefined,
    };

    const handlerStart = Date.now();
    const envelope = handler
      ? await handler(body, auth, requestId, depsWithIsolation)
      : await extra!(body, auth, requestId, depsWithIsolation as unknown);
    perfMark("handler", `dur=${Date.now() - handlerStart}ms envelope_code=${envelope.code}`);
    const httpStatus = envelope.code === 0 ? 200 : envelope.code >= 400 && envelope.code < 600 ? envelope.code : 200;
    const sendStart = Date.now();
    sendJson(res, httpStatus, envelope);
    perfMark("sendJson", `dur=${Date.now() - sendStart}ms status=${httpStatus}`);
  } catch (err) {
    // H-13: use classifyError so 5xx leaves no err.message leak; PayloadTooLargeError
    // and RecallFailure already carry safe messages but go through the same path for uniformity.
    const classified = classifyError(err);
    if (classified.status >= 500) {
      deps.logger.error(`${TAG} [${pathname}] ${classified.logLine}`);
    } else {
      deps.logger.warn(`${TAG} [${pathname}] ${classified.logLine}`);
    }
    sendJson(res, classified.status, {
      ...errorEnvelope(classified.client.code, classified.client.message, requestId),
      trace_id: classified.client.trace_id,
      retryable: classified.client.retryable,
    });
  }

  return true;
}

// ============================
// L0 Conversation Handlers
// ============================

async function handleConversationAdd(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationAddRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, messages } = parsed.data;

  // Enforce three-dim isolation. user_id / agent_id come from request body
  // or x-tdai-* headers (resolved in dispatchV2Request).  When the gateway's
  // isolationConfig.enforce is on AND legacy_compat_mode is off, missing
  // fields are a 422.
  if (deps.isolationConfig?.enforce && deps.requestIsolationMissing && deps.requestIsolationMissing.length > 0) {
    return errorEnvelope(
      422,
      `Tenancy isolation required: missing ${deps.requestIsolationMissing.join(", ")}. ` +
      `Provide via request body or x-tdai-{user-id,agent-id,session-id} headers.`,
      requestId,
    );
  }
  const iso = deps.requestIsolation;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Quota check: memory limit
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, messages.length);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  // 自动登记 chat_memory 资产（team+agent 粒度）并绑定到 agent。首次触发
  // 会 create asset + append 绑定；后续同 (team, agent) 走进程内 LRU 短路。
  // 失败降级：只打 warn，不阻塞 conversation 写入 —— 记忆数据的可用性优先
  // 于资产登记的一致性（asset 登记失败时下次调用会自动重试）。
  if (deps.getMetadataService && iso?.teamId && iso?.agentId) {
    try {
      const metaSvc = await deps.getMetadataService(auth.serviceId);
      await metaSvc.ensureChatMemoryAsset({
        team_id: iso.teamId,
        agent_id: iso.agentId,
      });
    } catch (err) {
      deps.logger.warn(
        `${TAG} ensureChatMemoryAsset failed (team=${iso.teamId} agent=${iso.agentId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── D-8（2026-10-31）：注入块服务端守卫 ──
  //
  // 探针实测：整段 `【agemem 记忆提示】…` 作为 ordinary user 消息 POST 到这里，
  // 旧实现 200 收下并落 L0 → 之后每次召回都把它当「用户说过的话」再喂回模型
  // （自我中毒）。识别规则与三档处置见 gateway/injection-guard.ts 顶部注释。
  // 识别是窄的（行首标记表），处置缺省 skip：只丢命中的那几条，同批真实发言
  // 照常落库 —— 不用 400，是因为一次 POST 最多 100 条，硬失败会连带丢掉用户数据。
  const guardMode = deps.injectionGuardMode ?? currentInjectionGuardMode();
  const injectedFindings = guardMode === "allow" ? [] : scanInjectedBlocks(messages);
  const pluginDeclared = isPluginDeclared(deps.requestSourceKind);
  if (guardMode === "reject" && pluginDeclared && injectedFindings.length > 0) {
    // 只有「标记命中 + 插件自我声明」双证据才升级为硬失败：单凭文本标记就 400，
    // 会把用户复制粘贴的一句话变成整批写入失败。
    deps.logger.warn(
      `${TAG} [D-8] injected block rejected: count=${injectedFindings.length} ` +
        `plugin_kind=${deps.requestSourceKind} session=${session_id} marker=${injectedFindings[0].marker}`,
    );
    return errorEnvelope(
      400,
      `Injected memory block must not be persisted as conversation: ${injectedFindings.length} message(s) start with a registered injection marker`,
      requestId,
      { code: "INJECTED_BLOCK", count: injectedFindings.length, markers: [...new Set(injectedFindings.map((f) => f.marker))] },
    );
  }
  if (injectedFindings.length > 0) {
    // journal 记一次（整批一条，不逐条刷屏）：谁在自注、注入几条、怎么处置的。
    deps.logger.warn(
      `${TAG} [D-8] injected block(s) detected: count=${injectedFindings.length} mode=${guardMode} ` +
        `plugin_kind=${deps.requestSourceKind ?? "<none>"} session=${session_id} ` +
        `marker=${injectedFindings[0].marker} preview="${injectedFindings[0].preview}"`,
    );
  }
  const injectedIndexes = new Set(injectedFindings.map((f) => f.index));
  let injectedSkipped = 0;

  const embedding = deps.getEmbedding();
  const acceptedIds: string[] = [];
  const acceptedRecords: L0Record[] = [];
  const ingestBaseMs = Date.now();
  let dedupSkipped = 0; // F-DUP-1：窗口内重复跳过计数（journal 留痕，响应契约不动）

  // B（2026-10-26 降调用量）：本段改为「先收集 → 一次 embedBatch → 逐条落库」。
  // 原实现每行一次 embed = 单请求 N 次 provider 调用；多会话并发即撞 Ark coding
  // 端点的突发并发上限（约 4~5 在飞）→ 429。批量化后单请求只打 1 次。
  const pendingL0: L0Record[] = [];
  const seenInBatch = new Set<string>();
  for (const [index, msg] of messages.entries()) {
    // D-8：命中的注入块不进 L0（也不进 embedBatch —— 省一次向量调用）。
    if (injectedIndexes.has(index)) {
      injectedSkipped++;
      continue;
    }
    // #121 8.1：不截断 UUID——12 hex 只剩 48 bit 命名空间，生日界下约 2e7 条即有一半概率
    // 碰撞，1e8 条量级预期撞掉约 18 条（upsert 静默覆盖，取证链断号）。上游保留全 32 hex。
    const id = `msg-${randomUUID().replace(/-/g, "")}`;
    const ingestRecordedAtMs = ingestBaseMs + index;
    const recordedAtMs = msg.recorded_at
      ? new Date(msg.recorded_at).getTime()
      : ingestRecordedAtMs;
    const record: L0Record = {
      id,
      sessionKey: session_id,
      sessionId: session_id,
      taskId: iso?.taskId,
      // Tenancy isolation: resolveIsolation() defaults missing fields to the default bucket.
      teamId: iso?.teamId,
      userId: iso?.userId,
      agentId: iso?.agentId,
      role: msg.role,
      messageText: msg.content,
      // #83 入口单点定源：行级分类标签随流落库（schema 可选；未传=unclassified）
      classification: msg.classification,
      recordedAt: new Date(recordedAtMs).toISOString(),
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : recordedAtMs,
    };

    // F-DUP-1（任务5，2026-09-25）：入口幂等——同 session+role+content 在 10min 窗口内
    // 重复提交跳过（根因=DSH 插件按每轮 LLM 调用重复提交同条用户消息：一次「继续」存 12 条、
    // 20-30s 间隔跨约 5 分钟）。窗口 10min=单回合连发上限×2 余量、远小于真实重发间隔
    // （隔小时级照存）；store 缺实现=现状逐条照收（feature-detect）。响应契约不动
    // （gateway/generated/types.ts 为 Kubb 生成禁手改），跳过以 journal info 留痕。
    if (typeof (store as { hasRecentL0Duplicate?: unknown }).hasRecentL0Duplicate === "function") {
      const isDup = await Promise.resolve(
        (store as { hasRecentL0Duplicate: (sk: string, r: string, c: string, w: number) => boolean | Promise<boolean> })
          .hasRecentL0Duplicate(session_id, msg.role, msg.content, 600000),
      );
      if (isDup) {
        dedupSkipped++;
        deps.logger.info(
          `${TAG} [F-DUP-1] duplicate skipped (session=${session_id}, role=${msg.role}, window=10min): ${msg.content.slice(0, 40)}`,
        );
        continue;
      }
    }
    // B（2026-10-26）：批内同文本也按重复挡。原实现靠「上一条已落库」被
    // store 的 hasRecentL0Duplicate 挡下；落库延后到批次末尾后必须显式去重。
    const batchKey = `${msg.role}\u0000${msg.content}`;
    if (seenInBatch.has(batchKey)) {
      dedupSkipped++;
      deps.logger.info(
        `${TAG} [F-DUP-1] duplicate skipped (session=${session_id}, role=${msg.role}, window=10min): ${msg.content.slice(0, 40)}`,
      );
      continue;
    }
    seenInBatch.add(batchKey);
    pendingL0.push(record);
  }

  // B（2026-10-26 降调用量）：整轮一次 embedBatch（原逐条 embed）。配置缺失或
  // 调用失败 → 该批按无向量落库，与逐条版失败时单行无向量的语义一致。
  const l0Vectors: Array<Float32Array | undefined> = pendingL0.map(() => undefined);
  if (embedding && pendingL0.length > 0) {
    try {
      const vectors = await embedding.embedBatch(pendingL0.map((r) => r.messageText));
      for (let i = 0; i < pendingL0.length && i < vectors.length; i++) l0Vectors[i] = vectors[i];
    } catch (e) {
      console.warn(`[v2-router] L0 embedding failed (batch=${pendingL0.length}):`, e);
    }
  }
  for (let i = 0; i < pendingL0.length; i++) {
    await store.upsertL0(pendingL0[i], l0Vectors[i]);
    acceptedIds.push(pendingL0[i].id);
    acceptedRecords.push(pendingL0[i]);
  }

  if (dedupSkipped > 0) {
    deps.logger.info(
      `${TAG} [F-DUP-1] ${session_id}: ${dedupSkipped} duplicate(s) skipped, ${acceptedIds.length} accepted (window=10min)`,
    );
  }

  // Notify pipeline: trigger async L1 extraction (service mode).
  // Each role=user message counts as one conversation round for threshold/timer logic.
  // teamId/agentId 透传给 captureAtomic 决定 hash slot 与锁粒度。
  // D-8：rounds 只数**真正落库**的 user 消息 —— 被守卫丢弃的注入块不算一轮对话，
  // 否则「只收到注入块」的批次也会触发一次 L1 提取（零真实语料的空跑）。
  if (deps.notifyPipeline) {
    const rounds = pendingL0.filter((r) => r.role === "user").length;
    if (rounds > 0) {
      try {
        await deps.notifyPipeline(auth.serviceId, session_id, rounds, iso?.teamId, iso?.agentId);
      } catch (err) {
        // Non-fatal: L0 is already persisted, pipeline will catch up later
        deps.logger.warn(`${TAG} Pipeline notify failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Standalone-only: mirror L0 to <dataDir>/conversations/<date>.jsonl.
  // Parity with v1 /capture (l0-recorder) path — gives humans a grep-able audit
  // log alongside SQLite. Service mode skips: COS is the authoritative store,
  // and writing to local FS in a multi-replica pod would be ephemeral + useless.
  // Failure is non-fatal: SQLite is the source of truth.
  if (deps.deployMode === "standalone") {
    const storage = deps.getStorage();
    if (storage) {
      try {
        const linesByRecordKey = new Map<string, string[]>();
        for (const record of acceptedRecords) {
          const recordKey = StoragePaths.conversation(formatLocalDateForJsonl(new Date(record.recordedAt)));
          const lines = linesByRecordKey.get(recordKey) ?? [];
          lines.push(JSON.stringify({
            id: record.id,
            sessionKey: record.sessionKey,
            sessionId: record.sessionId,
            taskId: record.taskId,
            teamId: record.teamId,
            userId: record.userId,
            agentId: record.agentId,
            role: record.role,
            content: record.messageText,
            recordedAt: record.recordedAt,
            timestamp: record.timestamp,
          }));
          linesByRecordKey.set(recordKey, lines);
        }
        for (const [recordKey, lines] of linesByRecordKey) {
          await storage.appendFile(recordKey, `${lines.join("\n")}\n`);
        }
      } catch (err) {
        deps.logger.warn(`${TAG} JSONL mirror failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Report memory usage (non-fatal)
  if (deps.quotaManager && acceptedIds.length > 0) {
    deps.quotaManager.reportMemoryAdded(auth.serviceId, acceptedIds.length).catch(() => {});
  }

  if (injectedSkipped > 0) {
    deps.logger.info(
      `${TAG} [D-8] ${session_id}: ${injectedSkipped} injected block(s) skipped, ` +
        `${acceptedIds.length} message(s) accepted (mode=${guardMode})`,
    );
  }

  // D-8：`skipped` 是**新增可选字段**（generated/types.ts 是 Kubb 生成禁手改，
  // 这里用交叉类型补上，响应契约对旧调用方向后兼容：不读它 = 逐位现状）。
  return successEnvelope<ConversationAddData & { skipped?: number }>(
    {
      accepted_ids: acceptedIds,
      accepted_versions: acceptedIds.map(() => "v1"),
      total_count: acceptedIds.length,
      ...(injectedSkipped > 0 ? { skipped: injectedSkipped } : {}),
    },
    requestId,
  );
}

async function handleConversationQuery(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationQueryRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Tenancy isolation — narrow the query when caller supplied user_id /
  // agent_id (via body or headers). session_id, if present, comes from the
  // request body and is already in `session_id`.
  const iso = deps.requestIsolation;

  // Use paginated query if available (AR-3), else fallback
  if (store.queryL0Paginated) {
    const result = await store.queryL0Paginated({
      sessionId: session_id,
      teamId: iso?.teamId,
      userId: iso?.userId,
      agentId: iso?.agentId,
      taskId: iso?.taskId,
      timeStartMs: time_start ? new Date(time_start).getTime() : undefined,
      timeEndMs: time_end ? new Date(time_end).getTime() : undefined,
      limit,
      offset,
    });

    const messages: ConversationItem[] = result.rows.map((r) => ({
      id: r.record_id,
      session_id: r.session_id,
      team_id: r.team_id,
      user_id: r.user_id,
      agent_id: r.agent_id,
      task_id: r.task_id,
      role: r.role as ConversationItem["role"],
      content: r.message_text,
      timestamp: r.recorded_at,
    }));

    return successEnvelope<ConversationQueryData>({ messages, total: result.total }, requestId);
  }

  // Fallback: legacy path (capped at 1000 for safety)
  const allRows = await store.queryL0ForL1(session_id ?? "", undefined, 1000);
  let filtered = session_id ? allRows.filter((r) => r.session_key === session_id || r.session_id === session_id) : allRows;
  // Tenancy isolation post-filter for the legacy path.
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId) filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  if (time_start) { const ms = new Date(time_start).getTime(); filtered = filtered.filter((r) => r.timestamp >= ms); }
  if (time_end) { const ms = new Date(time_end).getTime(); filtered = filtered.filter((r) => r.timestamp <= ms); }
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const messages: ConversationItem[] = page.map((r) => ({
    id: r.record_id,
    session_id: r.session_id,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    role: r.role as ConversationItem["role"],
    content: r.message_text,
    timestamp: r.recorded_at,
  }));

  return successEnvelope<ConversationQueryData>({ messages, total }, requestId);
}

async function handleConversationCount(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationCountRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, time_start, time_end } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const iso = deps.requestIsolation;

  const countFilter = {
    sessionId: session_id,
    teamId: iso?.teamId,
    userId: iso?.userId,
    agentId: iso?.agentId,
    taskId: iso?.taskId,
    timeStartMs: time_start ? new Date(time_start).getTime() : undefined,
    timeEndMs: time_end ? new Date(time_end).getTime() : undefined,
  };
  const total = await store.countL0(countFilter);
  return successEnvelope<CountData>({ total }, requestId);

  const allRows = await store.queryL0ForL1(session_id ?? "", undefined, 10000);
  let filtered = session_id ? allRows.filter((r) => r.session_key === session_id || r.session_id === session_id) : allRows;
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId) filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  if (time_start) { const ms = new Date(time_start).getTime(); filtered = filtered.filter((r) => r.timestamp >= ms); }
  if (time_end) { const ms = new Date(time_end).getTime(); filtered = filtered.filter((r) => r.timestamp <= ms); }
  return successEnvelope<CountData>({ total: filtered.length }, requestId);
}

async function handleConversationSearch(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationSearchRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, session_id, time_start: convStart, time_end: convEnd } = parsed.data;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  // 搜索场景：只使用显式传入的 isolation 维度作为 filter，避免默认 sessionId="default" 错误过滤真实 session 数据。
  // 当请求未传 session_id 时，搜索应跨 session；当传了 session_id 时，由 sessionKey 参数单独过滤。
  const iso = deps.requestIsolation;
  const searchFilter = iso ? {
    ...(iso.teamId ? { teamId: iso.teamId } : {}),
    ...(iso.userId ? { userId: iso.userId } : {}),
    ...(iso.agentId ? { agentId: iso.agentId } : {}),
    ...(iso.taskId ? { taskId: iso.taskId } : {}),
    // 不传 sessionId：全局搜索不应被默认 sessionId 限制
  } : undefined;
  const result = await executeConversationSearch({
    query,
    limit,
    sessionKey: session_id,
    filter: searchFilter,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
  });
  const recallLatencyMs = performance.now() - tStart;

  // GROW-EVO P2.1（§2.4）：schema 死参数激活——recorded_at 时间后过滤
  //（L0 无 soul 列，业务时间 = recorded_at；非法 recorded_at 行在过滤激活时不命中）。
  let convResults = result.results;
  if (convStart || convEnd) {
    convResults = convResults.filter((r) => {
      const t = r.recorded_at ? Date.parse(r.recorded_at) : NaN;
      if (!Number.isFinite(t)) return false;
      if (convStart && t < Date.parse(convStart)) return false;
      if (convEnd && t > Date.parse(convEnd)) return false;
      return true;
    });
  }

  // 非侵入式上报召回指标（service 模式，静默失败，绝不影响业务返回）
  // L0 conversation search 同样属于"召回"行为，strategy 映射逻辑与 L1 相同
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: convResults.map((r) => ({ content: r.content, score: r.score, type: "conversation" })),
      recallStrategy: result.strategy === "fts" ? "keyword" : result.strategy === "none" ? "skipped" : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默失败
  }

  const messages: ConversationSearchHit[] = convResults.map((r) => ({
    id: r.id, role: r.role as ConversationSearchHit["role"], content: r.content, timestamp: r.recorded_at, score: r.score,
  }));

  return successEnvelope<ConversationSearchData>({ messages }, requestId);
}

async function handleConversationDelete(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationDeleteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  // schema 已归一：message_ids / session_ids 都是去重后的数组（单数 session_id 已合并进来）。
  const { message_ids, session_ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // 删除的作用域是 (team, user, agent)，**不含 session**。
  // /v3 严格 isolation 要求请求头带 session_id，但删除语义是"删指定的
  // message / session"，若把 requestIsolation.sessionId 也塞进 filter，
  // 就只能删当前会话 —— 批量删多个 session 会被静默过滤成 0 条。
  const iso = deps.requestIsolation;
  const scope = iso
    ? { teamId: iso.teamId, userId: iso.userId, agentId: iso.agentId, taskId: iso.taskId }
    : undefined;

  // message_ids 与 session_ids 可同时给出；两条路径都跑，用 id 集合去重避免
  // 同一条消息被session 路径重复计数。
  const deletedRecordIds = new Set<string>();

  for (const id of message_ids) {
    const ok = await store.deleteL0(id, scope);
    if (ok) deletedRecordIds.add(id);
  }

  let sessionDeletedCount = 0;
  for (const sessionId of session_ids) {
    if (store.deleteL0BySession) {
      sessionDeletedCount += await store.deleteL0BySession(sessionId, scope);
      continue;
    }
    // Fallback：store 未实现按 session 删除时逐条删。
    const rows = await store.queryL0ForL1(sessionId, undefined, 10000);
    const sessionRows = rows.filter((r) => r.session_key === sessionId || r.session_id === sessionId);
    for (const row of sessionRows) {
      if (deletedRecordIds.has(row.record_id)) continue;
      const ok = await store.deleteL0(row.record_id, scope);
      if (ok) deletedRecordIds.add(row.record_id);
    }
  }

  // deleteL0BySession 只回行数（无法回id），所以两条路径的计数相加。
  // 同一批请求里message_ids 与 session_ids 重叠时可能轻微重复计数，
  // 这是 store 接口的既有限制，不影响实际删除的正确性。
  const deletedCount = deletedRecordIds.size + sessionDeletedCount;

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager.reportMemoryDeleted(auth.serviceId, deletedCount).catch(() => {});
  }

  return successEnvelope<ConversationDeleteData>({ deleted_count: deletedCount }, requestId);
}

async function handleAtomicUpdate(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicUpdateRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { id, content, background } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Read existing record by primary key
  // GROW-EVO P2.1 修复：queryL1Records 不支持 recordIds 过滤（静默返回全表）——
  // 旧行取错 → 归属 403 误判 + 跨行篡改风险（流程测试实测逮到的预存量缺陷）。
  // 改用 getL1ByIds 精确取行。
  const existing = (await store.getL1ByIds?.([id])) ?? [];
  if (!existing || existing.length === 0) {
    return errorEnvelope(404, `Atomic note not found: ${id}`, requestId);
  }
  if (!existing || existing.length === 0) {
    return errorEnvelope(404, `Atomic note not found: ${id}`, requestId);
  }

  const now = new Date().toISOString();
  const record = existing[0];

  // Build update: content is always overwritten; background (scene_name) only if provided.
  // user_id / agent_id are preserved from the existing row — updates don't
  // re-derive them. If the caller supplied an isolation triple that does NOT
  // match the existing row, we treat it as a permission denial.
  const iso = deps.requestIsolation;
  if (iso?.userId && record.user_id && record.user_id !== iso.userId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different user`, requestId);
  }
  if (iso?.agentId && record.agent_id && record.agent_id !== iso.agentId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different agent`, requestId);
  }
  const updatedVersion = (record.version ?? 0) + 1;
  // P0-T3（E1）：updated 必须携带既有行的 soul 字段全量。
  // upsertL1 的 ON CONFLICT 对这些列全部 excluded.* 覆盖，updated 漏拷 = 编辑一次
  // 把时间锚刷成 ""（遗忘引擎 ageDaysOf 恒 0，永不归档）、情感清零、inferred 被静默
  // 晋升成 observed。缺省透传 undefined：upsertL1 soulBindValues 对 undefined/null
  // 统一回填 SOUL_FIELD_DEFAULTS，与旧 `?? null` 写法在绑定层逐位等价（P1-T7 类型修正）。
  const updated: MemoryRecord = {
    id,
    content,
    type: record.type as any,
    priority: record.priority ?? 50,
    scene_name: background !== undefined ? background : (record.scene_name ?? ""),
    // P0：行级原话溯源从既有行原样透传——upsertL1 的 excluded.* 整行覆盖，
    // 漏拷 = 编辑/调分/失效恢复一次即把该行的 source_message_ids 刷成 []。
    source_message_ids: record.source_message_ids ?? [],
    metadata: parseMetadataJson(record.metadata_json),
    timestamps: record.timestamp_str ? [record.timestamp_str] : [],
    createdAt: record.created_time || record.timestamp_str || now,
    updatedAt: now,
    version: updatedVersion,
    sessionKey: record.session_key ?? "",
    sessionId: record.session_id ?? iso?.sessionId ?? "",
    taskId: record.task_id ?? iso?.taskId,
    teamId: record.team_id ?? iso?.teamId,
    userId: record.user_id ?? iso?.userId,
    agentId: record.agent_id ?? iso?.agentId,
    // 灵魂记忆字段：从既有行原样透传（L1SearchResult 已带窄类型，无需断言）。
    // P1-T7：sensitivity 补拷——关闭 D-3 已知缺口（此前编辑一次即把敏感性刷回默认）。
    occurred_at: record.occurred_at,
    valid_start: record.valid_start,
    valid_end: record.valid_end,
    certainty: record.certainty as MemoryRecord["certainty"],
    valence: record.valence,
    arousal: record.arousal,
    significance: record.significance,
    sensitivity: record.sensitivity,
    importance: record.importance ?? undefined,
  };

  const embedding = deps.getEmbedding();
  let emb: Float32Array | undefined;
  if (embedding) { try { emb = await embedding.embed(content); } catch (e) { console.warn(`[v2-router] L1 embedding failed:`, e); } }

  await store.upsertL1(updated, emb);

  // GROW-EVO P2（§2.4）：显式失效——raw body 的 valid_end（ISO）→ invalidateL1。
  // 必须在 upsertL1 之后（update 的 soul 回写会原样写回 valid_end，先失效会被清掉）。
  // zod schema 为生成文件——raw body 旁路 + 手动 ISO 校验。
  const rawValidEnd = (body as { valid_end?: unknown } | null)?.valid_end;
  let invalidatedAt: string | undefined;
  if (typeof rawValidEnd === "string" && rawValidEnd.trim()) {
    if (!Number.isFinite(Date.parse(rawValidEnd))) {
      return errorEnvelope(400, `valid_end 不是合法 ISO 时间: ${rawValidEnd}`, requestId);
    }
    const ok = store.invalidateL1?.(id, rawValidEnd);
    if (!ok) return errorEnvelope(500, `失效写入失败（行不存在或已失效不覆盖）: ${id}`, requestId);
    invalidatedAt = rawValidEnd;
  }

  // 审计：L1 update — 用外部请求的 IdFields 而非 record 原值（per user 决策）
  await recordAudit(store, {
    record_id: id,
    layer: "L1",
    action: "update",
    iso,
    version: updatedVersion,
    requestId,
    logger: deps.logger,
  });

  const updateData: AtomicUpdateData = { id, version: `v${updatedVersion}`, updated_at: now };
  if (invalidatedAt) (updateData as { invalidated_at?: string }).invalidated_at = invalidatedAt;
  return successEnvelope<AtomicUpdateData>(updateData, requestId);
}

/**
 * P1 Task 7：POST /atomic/importance — 人工重要度调整（Panel 记忆详情滑杆）。
 * 合同：
 * - 覆写 l1_records.importance（1-10 整数），metadata.importance_source='manual'；
 * - 追加语义：手动原因写 metadata.importance_manual_reason，绝不改写 LLM 的
 *   metadata.importance_reason（两代判定共存，UI 分源展示）；
 * - content 不变 → embedding 不重算（upsertL1 传 undefined = metadata-only 写）；
 * - 全量 soul 拷贝（P0-T3：upsert excluded.* 覆盖，漏拷 = 调整一次刷空 soul）。
 */
export async function handleAtomicImportance(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { id?: unknown; importance?: unknown; reason?: unknown };
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : undefined;
  if (!id) return errorEnvelope(400, "id 必须是非空字符串", requestId);
  const importance = b.importance;
  if (typeof importance !== "number" || !Number.isInteger(importance) || importance < 1 || importance > 10) {
    return errorEnvelope(400, "importance 必须是 1-10 的整数", requestId);
  }
  if (b.reason !== undefined && typeof b.reason !== "string") {
    return errorEnvelope(400, "reason 必须是字符串", requestId);
  }
  const reason = (b.reason as string | undefined)?.trim() || undefined;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const records = (await store.getL1ByIds?.([id])) ?? [];
  const record = records[0];
  if (!record) return errorEnvelope(404, `Atomic note ${id} not found`, requestId);
  const iso = deps.requestIsolation;
  if (iso?.teamId && record.team_id && record.team_id !== iso.teamId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different team`, requestId);
  }
  if (iso?.userId && record.user_id && record.user_id !== iso.userId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different user`, requestId);
  }
  if (iso?.agentId && record.agent_id && record.agent_id !== iso.agentId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different agent`, requestId);
  }

  const updatedVersion = (record.version ?? 0) + 1;
  const metadata = parseMetadataJson(record.metadata_json) as Record<string, unknown>;
  // 追加语义：LLM 的 importance_reason 原样保留；手动判定另开键（两代判定共存）
  metadata.importance_source = "manual";
  if (reason) metadata.importance_manual_reason = reason;

  const updated: MemoryRecord = {
    id,
    content: record.content,
    type: record.type as any,
    priority: record.priority ?? 50,
    scene_name: record.scene_name ?? "",
    // P0：行级原话溯源从既有行原样透传——upsertL1 的 excluded.* 整行覆盖，
    // 漏拷 = 编辑/调分/失效恢复一次即把该行的 source_message_ids 刷成 []。
    source_message_ids: record.source_message_ids ?? [],
    metadata,
    timestamps: record.timestamp_str ? [record.timestamp_str] : [],
    createdAt: record.created_time || record.timestamp_str || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: updatedVersion,
    sessionKey: record.session_key ?? "",
    sessionId: record.session_id ?? iso?.sessionId ?? "",
    taskId: record.task_id ?? iso?.taskId,
    teamId: record.team_id ?? iso?.teamId,
    userId: record.user_id ?? iso?.userId,
    agentId: record.agent_id ?? iso?.agentId,
    // P0-T3：soul 字段从既有行原样透传（缺省 undefined → upsertL1 soulBindValues 回填
    // SOUL_FIELD_DEFAULTS，与旧 `?? null` 在绑定层逐位等价）；importance 同拷防编辑刷空。
    occurred_at: record.occurred_at,
    valid_start: record.valid_start,
    valid_end: record.valid_end,
    certainty: record.certainty as MemoryRecord["certainty"],
    valence: record.valence,
    arousal: record.arousal,
    significance: record.significance,
    importance,
    sensitivity: record.sensitivity,
  };

  // content 不变 → 不重算 embedding（undefined = metadata-only upsert）
  await store.upsertL1(updated, undefined);

  await recordAudit(store, {
    record_id: id,
    layer: "L1",
    action: "update",
    iso,
    version: updatedVersion,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope(
    { id, version: `v${updatedVersion}`, importance, importance_source: "manual" },
    requestId,
  );
}

/** 可写 sensitivity 白名单（ADR-0025 决定 10）：'unclassified' 是脏值归一结果，不是可写值。 */
const WRITABLE_SENSITIVITY = new Set(["none", "health", "finance", "relationship"]);

/**
 * A 项（ADR-0025 决定 10，2026-11-04）：POST /atomic/sensitivity — 显式降敏。
 *
 * 为什么必须是独立端点（而不是复用 /atomic/update）：upsertL1 的 sensitivity 是**粘性列**
 * （sqlite.ts:1364-1370：新值 'none'/''/NULL 等于「本次未判定」→ 保留库中旧值），
 * 整行重写链永远无法把已分类行降回 none。这正是「单向棘轮」的存储层表达：
 * 自动路径只升不降，降敏只能由人显式发起、单条 UPDATE、且带 CAS。
 *
 * 合同：
 * - body { id, sensitivity, expect, reason? }；
 *   - sensitivity 必须是 none|health|finance|relationship（'unclassified' → 400）；
 *   - **expect 必填**（body 里显式给出当前值）：SQL 条件 AND sensitivity = expect，
 *     changes===0 → 409。并发改写/值不符/行被删三者不区分（不泄漏行存在性）。
 *     不带 expect = 盲覆盖 → 400（拒绝）。
 * - 未知行 404 / 跨租户三轴 403 / store 无 setL1Sensitivity → 501（fail-loud，不静默成功）。
 * - 成功后写 memory_audit（action='sensitivity'）；不 bump version、不改正文
 *   （只是标注位 + updated_time，见 store.setL1Sensitivity）。
 * - 不做「取值必须更低」的方向校验：网关保持通用写能力（health→finance 这类重分类将来
 *   可能有用），**保守约束放在 UI**——面板只提供「解除敏感标记 → none」这一步。
 */
export async function handleAtomicSensitivity(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { id?: unknown; sensitivity?: unknown; expect?: unknown; reason?: unknown };
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : undefined;
  if (!id) return errorEnvelope(400, "id 必须是非空字符串", requestId);
  if (typeof b.sensitivity !== "string" || !WRITABLE_SENSITIVITY.has(b.sensitivity)) {
    return errorEnvelope(400, "sensitivity 必须是 none/health/finance/relationship 之一", requestId);
  }
  if (typeof b.expect !== "string" || !WRITABLE_SENSITIVITY.has(b.expect)) {
    return errorEnvelope(400, "expect 必须显式提供且是 none/health/finance/relationship 之一（CAS 条件）", requestId);
  }
  if (b.reason !== undefined && typeof b.reason !== "string") {
    return errorEnvelope(400, "reason 必须是字符串", requestId);
  }
  const sensitivity = b.sensitivity;
  const expect = b.expect;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (typeof store.setL1Sensitivity !== "function") {
    // fail-loud：后端没实现 = 降敏不可用，绝不当成功回执（否则面板以为解除了、召回仍拦截）
    return errorEnvelope(501, "后端不支持显式降敏（setL1Sensitivity 未实现）", requestId);
  }
  const records = (await store.getL1ByIds?.([id])) ?? [];
  const record = records[0];
  if (!record) return errorEnvelope(404, `Atomic note ${id} not found`, requestId);

  const iso = deps.requestIsolation;
  if (iso?.teamId && record.team_id && record.team_id !== iso.teamId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different team`, requestId);
  }
  if (iso?.userId && record.user_id && record.user_id !== iso.userId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different user`, requestId);
  }
  if (iso?.agentId && record.agent_id && record.agent_id !== iso.agentId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different agent`, requestId);
  }

  // 失败二分（对抗评审 P1）：false = 纯 CAS 未命中 → 409；抛错 = degraded/SQL 失败 → 503。
  // 混成一个 409 会让客户端按并发冲突重试（而值其实已改），且丢审计、语义错位。
  let ok: boolean;
  try {
    ok = await store.setL1Sensitivity(id, sensitivity, expect);
  } catch (err) {
    deps.logger?.warn?.(
      `[atomic-sensitivity] store write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return errorEnvelope(
      503,
      `sensitivity 写入失败（store 不可用或底层错误）: ${err instanceof Error ? err.message : String(err)}`,
      requestId,
    );
  }
  if (!ok) {
    return errorEnvelope(
      409,
      `sensitivity CAS 未命中（expect=${expect} 与库中当前值不符或行已被并发修改）: ${id}`,
      requestId,
    );
  }

  // 降敏不改正文/版本：audit 记当前版本（version 未 bump，与 update 语义区分靠 action 位）。
  await recordAudit(store, {
    record_id: id,
    layer: "L1",
    action: "sensitivity",
    iso,
    version: record.version ?? 0,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope(
    { id, sensitivity, previous: expect, version: `v${record.version ?? 0}`, sensitivity_source: "manual" },
    requestId,
  );
}

/**
 * P1 Task 8（bi-temporal 补口，M4 #6）：POST /atomic/invalidate — 记忆软失效/撤销失效。
 * 合同：
 * - body {record_id, valid_end?, mode?: "invalidate"|"restore"}，mode 缺省 invalidate；
 * - invalidate = handleAtomicUpdate 既有 valid_end 写路（store.invalidateL1）的语义化薄封装：
 *   valid_end 缺省 now（ISO），显式提供必须是非空可解析 ISO 串（同款措辞 400）；必须
 *   upsertL1 先、invalidateL1 后（soul 回写会原样写回 valid_end，序反 = 失效被抹回）；
 *   已失效行/行不存在 → invalidateL1 false → 500（既有语义原样沿用，已失效不覆盖）；
 * - restore = upsertL1 清空 valid_end（软失效可逆；仅本 handler 内部路径放开 soul 拷贝对
 *   valid_end 的回写限制，handleAtomicUpdate 公开语义不变；body.valid_end 忽略；幂等）；
 *   upsertL1 统一写路径自动同步 l1_fts 副本；
 * - 不造第三条失效写路：除 restore 的清空外，不新增失效存储方法；红线 = 不删记忆；
 * - /v3 严格隔离（team_id+user_id+agent_id+session_id 缺一 422）由 dispatch 层
 *   collectV3Missing 统一执行，本 handler 只做租户三轴（team/user/agent）归属校验。
 */
export async function handleAtomicInvalidate(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { record_id?: unknown; valid_end?: unknown; mode?: unknown };
  const id = typeof b.record_id === "string" && b.record_id.trim() ? b.record_id.trim() : undefined;
  if (!id) return errorEnvelope(400, "record_id 必须是非空字符串", requestId);

  const mode = b.mode ?? "invalidate";
  if (mode !== "invalidate" && mode !== "restore") {
    return errorEnvelope(400, "mode 必须是 \"invalidate\" 或 \"restore\"", requestId);
  }

  // invalidate：valid_end 缺省 now；显式提供必须是非空可解析 ISO 串（handleAtomicUpdate 同款措辞）
  let validEnd: string | undefined;
  if (mode === "invalidate") {
    if (b.valid_end === undefined) {
      validEnd = new Date().toISOString();
    } else if (typeof b.valid_end !== "string" || !b.valid_end.trim() || !Number.isFinite(Date.parse(b.valid_end))) {
      return errorEnvelope(400, `valid_end 不是合法 ISO 时间: ${String(b.valid_end)}`, requestId);
    } else {
      validEnd = b.valid_end;
    }
  }

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const records = (await store.getL1ByIds?.([id])) ?? [];
  const record = records[0];
  if (!record) return errorEnvelope(404, `Atomic note ${id} not found`, requestId);

  // 租户三轴校验（handleAtomicImportance 同款 idiom；403）
  const iso = deps.requestIsolation;
  if (iso?.teamId && record.team_id && record.team_id !== iso.teamId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different team`, requestId);
  }
  if (iso?.userId && record.user_id && record.user_id !== iso.userId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different user`, requestId);
  }
  if (iso?.agentId && record.agent_id && record.agent_id !== iso.agentId) {
    return errorEnvelope(403, `Atomic note ${id} belongs to a different agent`, requestId);
  }

  const updatedVersion = (record.version ?? 0) + 1;
  const metadata = parseMetadataJson(record.metadata_json) as Record<string, unknown>;

  const updated: MemoryRecord = {
    id,
    content: record.content,
    type: record.type as any,
    priority: record.priority ?? 50,
    scene_name: record.scene_name ?? "",
    // P0：行级原话溯源从既有行原样透传——upsertL1 的 excluded.* 整行覆盖，
    // 漏拷 = 编辑/调分/失效恢复一次即把该行的 source_message_ids 刷成 []。
    source_message_ids: record.source_message_ids ?? [],
    metadata,
    timestamps: record.timestamp_str ? [record.timestamp_str] : [],
    createdAt: record.created_time || record.timestamp_str || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: updatedVersion,
    sessionKey: record.session_key ?? "",
    sessionId: record.session_id ?? iso?.sessionId ?? "",
    taskId: record.task_id ?? iso?.taskId,
    teamId: record.team_id ?? iso?.teamId,
    userId: record.user_id ?? iso?.userId,
    agentId: record.agent_id ?? iso?.agentId,
    // P0-T3：soul 字段从既有行原样透传（缺省 undefined → upsertL1 soulBindValues 回填
    // SOUL_FIELD_DEFAULTS）；restore 时 valid_end 清空（"" 随统一写路径同步 l1_fts 副本）。
    occurred_at: record.occurred_at,
    valid_start: record.valid_start,
    valid_end: mode === "restore" ? "" : record.valid_end,
    certainty: record.certainty as MemoryRecord["certainty"],
    valence: record.valence,
    arousal: record.arousal,
    significance: record.significance,
    importance: record.importance,
    sensitivity: record.sensitivity,
  };

  // content 不变 → 不重算 embedding（undefined = metadata-only upsert）
  await store.upsertL1(updated, undefined);

  let effectiveValidEnd = "";
  if (mode === "invalidate" && validEnd !== undefined) {
    // 薄封装：复用 handleAtomicUpdate 的既有失效写路（行不存在/已失效不覆盖 → false → 500）
    const ok = await store.invalidateL1?.(id, validEnd);
    if (!ok) return errorEnvelope(500, `失效写入失败（行不存在或已失效不覆盖）: ${id}`, requestId);
    effectiveValidEnd = validEnd;
  }

  // 审计：L1 update（invalidate/restore 都是 L1 行变更）
  await recordAudit(store, {
    record_id: id,
    layer: "L1",
    action: "update",
    iso,
    version: updatedVersion,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope({ id, version: `v${updatedVersion}`, valid_end: effectiveValidEnd }, requestId);
}

async function handleAtomicQuery(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicQueryRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { type, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Tenancy isolation — narrow the query by user_id / agent_id when supplied.
  const iso = deps.requestIsolation;

  // Use paginated query if available
  if (store.queryL1Paginated) {
    const result = await store.queryL1Paginated({
      type, timeStart: time_start, timeEnd: time_end, limit, offset,
      teamId: iso?.teamId, userId: iso?.userId, agentId: iso?.agentId, taskId: iso?.taskId,
    });
    // D-0：映射抽单一源 atomic-query-fields.ts（7 字段补齐 + 既有字段逐位），
    // legacy fallback 同款共用（消双份内联映射漂移面）。
    const items = result.rows.map((r) =>
      handleAtomicQueryShape(r as unknown as Record<string, unknown>),
    ) as unknown as AtomicDetail[];
    return successEnvelope<AtomicQueryData>({ items, total: result.total }, requestId);
  }

  // Fallback: legacy
  const allRecords = await store.queryL1Records();
  let filtered = allRecords;
  if (type) filtered = filtered.filter((r) => r.type === type);
  if (iso?.teamId) filtered = filtered.filter((r) => r.team_id === iso.teamId);
  if (iso?.userId) filtered = filtered.filter((r) => r.user_id === iso.userId);
  if (iso?.agentId) filtered = filtered.filter((r) => r.agent_id === iso.agentId);
  if (iso?.taskId) filtered = filtered.filter((r) => r.task_id === iso.taskId);
  // TIMEFIX-v2 对齐（P1 债务③，2026-09-15）：快慢路同键——业务时间 occurred_at；
  // occurred_at 为空串的行在过滤激活时不命中（同 fast path 语义，宁缺毋滥）。
  if (time_start) filtered = filtered.filter((r) => ((r as { occurred_at?: string }).occurred_at || "") !== "" && (r as { occurred_at?: string }).occurred_at! >= time_start);
  if (time_end) filtered = filtered.filter((r) => ((r as { occurred_at?: string }).occurred_at || "") !== "" && (r as { occurred_at?: string }).occurred_at! <= time_end);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  // D-0：legacy fallback 映射同走单一源（同 7 字段补齐，快慢路同契约）。
  const items = page.map((r) =>
    handleAtomicQueryShape(r as unknown as Record<string, unknown>),
  ) as unknown as AtomicDetail[];

  return successEnvelope<AtomicQueryData>({ items, total }, requestId);
}

async function handleAtomicCount(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicCountRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { type, time_start, time_end } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const iso = deps.requestIsolation;

  const total = await store.countL1({
    type,
    timeStart: time_start,
    timeEnd: time_end,
    teamId: iso?.teamId,
    userId: iso?.userId,
    agentId: iso?.agentId,
    taskId: iso?.taskId,
  });
  return successEnvelope<CountData>({ total }, requestId);
}

export async function handleArchiveList(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { limit?: number; offset?: number };
  const limit = typeof b.limit === "number" && b.limit > 0 ? Math.min(Math.floor(b.limit), 500) : 100;
  const offset = typeof b.offset === "number" && b.offset >= 0 ? Math.floor(b.offset) : 0;
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.listArchived) return errorEnvelope(503, "archive not supported", requestId);
  // SEC-1（安全级，补 T12 漏网）：归档列表租户过滤——不再实例级全量出。
  // 用 coreTenantFromIsolation（T12 模式，三元组缺省兜 default 桶）：/v3 严格模式
  // 三元组闸门已保证齐全；/v2 匿名 → default 桶，与存量回填（拍板⑤）语义自洽。
  // 出参带 team_id/user_id/agent_id（面板归属徽标消费，additive 兼容旧面板）。
  const tenant = coreTenantFromIsolation(deps.requestIsolation);
  const items = await store.listArchived(limit, offset, tenant);
  return successEnvelope<{ items: typeof items; total: number }>({ items, total: items.length }, requestId);
}

export async function handleArchiveRestore(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { id?: string };
  if (!b.id || typeof b.id !== "string") return errorEnvelope(400, "id (string) required", requestId);
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.restoreL1) return errorEnvelope(503, "archive restore not supported", requestId);
  // SEC-1（安全级）：restore 属主校验——归档行租户 ≠ 请求租户 → 拒绝。404 而非 403：
  // 不向调用方泄漏跨租户归档行的存在性（宁严勿滥）。
  const tenant = coreTenantFromIsolation(deps.requestIsolation);
  const ok = await store.restoreL1(b.id.trim(), tenant);
  if (!ok) return errorEnvelope(404, "archived record not found or restore failed", requestId);
  // 审计：恢复也是一次 data-plane mutation（L1 restore）。失败不阻塞。
  void recordAudit(store, {
    record_id: b.id.trim(),
    layer: "L1" as const,
    action: "update" as const,
    version: 0,
    requestId,
    logger: deps.logger,
    iso: deps.requestIsolation,
  });
  return successEnvelope<{ ok: boolean; id: string }>({ ok: true, id: b.id.trim() }, requestId);
}

async function handleAtomicSearch(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicSearchRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, type, time_start: explicitStart, time_end: explicitEnd } = parsed.data;
  // A5（REG-REMAINING-001）：time_point 时间旅行贯通（generated schema 不动——从原始 body 读取）
  const tpRaw = (body as { time_point?: string }).time_point;
  const validityNow = tpRaw && !Number.isNaN(Date.parse(tpRaw)) ? new Date(tpRaw) : undefined;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  // L1 召回为 agent 维度（跨 session）：filter 只取 team/user/agent/task，
  // **不带 sessionId**，否则会把其它 session 写入的 L1 记忆过滤掉，导致
  // 新会话里召不回历史记忆（与 conversation/search 的处理保持一致）。
  const iso = deps.requestIsolation;
  const searchFilter = iso ? {
    ...(iso.teamId ? { teamId: iso.teamId } : {}),
    ...(iso.userId ? { userId: iso.userId } : {}),
    ...(iso.agentId ? { agentId: iso.agentId } : {}),
    ...(iso.taskId ? { taskId: iso.taskId } : {}),
    // 不传 sessionId：L1 召回应跨 session（agent 维度）
  } : undefined;
  const result = await executeMemorySearch({
    query, limit, type,
    filter: searchFilter,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
    // 重构式回忆（J）：图邻居扩展，配置门（默认关，宁缺毋滥；按配置 memory.search.neighborExpand.enabled 开启）
    neighborExpand: (deps as { config?: { memory?: { search?: { neighborExpand?: { enabled?: boolean; maxHop?: number; maxAdd?: number } } } } }).config?.memory?.search?.neighborExpand,
    // GROW-EVO P2（§2.4）：schema 死参数激活——显式时间窗（occurred_at 语义，TIMEFIX-v2 同键）
    timeWindow: explicitStart || explicitEnd
      ? { start: explicitStart ?? "1970-01-01T00:00:00.000Z", end: explicitEnd ?? "9999-12-31T23:59:59.999Z", label: "explicit" }
      : "auto",
    // GROW-EVO P2（§2.3）：失效排除开关（cfg 透传——缺省 true）；
    // #136：recall.validity.mode=soft 时映射成 "soft"（只丢 future，保留失效行）——单一映射点
    excludeInvalidated: excludeInvalidatedFor(
      (deps as { config?: { memory?: { recall?: { validity?: { mode?: "hard" | "soft" } } } } }).config?.memory?.recall?.validity?.mode,
      (deps as { config?: { memory?: { recall?: { excludeInvalidated?: boolean } } } }).config?.memory?.recall?.excludeInvalidated,
    ),
    // #151/#148/#150：HTTP 路与钩子路**同配置源**——缺这三行，/v3/atomic/search 会静默
    // 忽略 recall.fusion（normalized 档）、recall.validity.softPenalty 与 recall.factChannel，
    // 同一条生产配置在两条召回路上给出不同排序（审计 §4.1 #151「工具路无 normalized」）。
    fusion: (deps as { config?: { memory?: { recall?: { fusion?: RecallFusionConfig } } } }).config?.memory?.recall?.fusion,
    validitySoftPenalty: (deps as { config?: { memory?: { recall?: { validity?: { softPenalty?: number } } } } }).config?.memory?.recall?.validity?.softPenalty,
    factChannel: (deps as { config?: { memory?: { recall?: { factChannel?: RecallFactChannelConfig } } } }).config?.memory?.recall?.factChannel,
    // §28（2026-11-05）：余弦门槛同源透传（缺省 0 = rank-only）——此前该路吃函数缺省 0.3，
    // 与钩子路候选池不一致（#151 同款「同配置两路分叉」）。
    scoreThreshold: (deps as { config?: { memory?: { recall?: { scoreThreshold?: number } } } }).config?.memory?.recall?.scoreThreshold,
    // A5：time_point 时间旅行（handleRecall 同款语义）
    validityNow,
    // GROW-EVO P3 R10（§3.2）：情感显著度权重（cfg 透传——缺省 0 = 恒等）
    emotionSalienceWeight: (deps as { config?: { memory?: { recall?: { emotionSalienceWeight?: number } } } }).config?.memory?.recall?.emotionSalienceWeight,
    // Batch C C-b（#77 伴生，2026-10-20 · survey F6b）：检索期重算衰减乘子/时间锚回退
    //（cfg 透传——缺省关 = 逐位现状；只乘 timeProx 因子，floor 0.05 never-a-filter）
    ageDecay: (deps as { config?: { memory?: { recall?: { ageDecay?: { enabled?: boolean; halfLifeDays?: number } } } } }).config?.memory?.recall?.ageDecay?.enabled === true
      ? { halfLifeDays: (deps as { config?: { memory?: { recall?: { ageDecay?: { halfLifeDays?: number } } } } }).config!.memory!.recall!.ageDecay!.halfLifeDays ?? 30 }
      : undefined,
    timeProxFallbackEnabled: (deps as { config?: { memory?: { recall?: { timeProxFallbackEnabled?: boolean } } } }).config?.memory?.recall?.timeProxFallbackEnabled === true,
    // 重构式回忆（J 设计§3）：query 时间锚自动解析（今天/上周/N天前等→时间窗过滤；解析不出不过滤）
    // C1 + R-A1：coreRef 与排序层结构信号配置透传（缺省由 executeMemorySearch 内部
    // 回落 spec §2 默认值；价值锚来源已退场，coreRef 加成不再有候选可命中）
    ...(() => {
      // V2 批 2（I2 修补）：cast 扩到 exploreSlot/rerankWeights/queryExpansion + 顶层 llm
      //（gateway config.memory 经 parseConfig 全量解析，queryExpansion 默认在；llm 为
      // 顶层 TDAI_LLM_*/yaml 解析后 splice 到 memory.llm 的同一份——与 auto-recall cfg.llm 同源）。
      const gwCfg = (deps as {
        config?: {
          memory?: {
            recall?: {
              coreRefBoost?: number;
              timeBoost?: number;
              recencyBoost?: number;
              sigWeight?: number;
              inferredPenalty?: number;
              reinforcementWeight?: number;
              moodBoost?: number;
              graphMinStrength?: number;
              graphDiscount?: number;
              pprDamping?: number;
              pprTopK?: number;
              pprIterations?: number;
              sceneBoost?: number;
              exploreSlot?: boolean;
              // P1-T7（2026-11-04 定案）：importance≤4 降权——工具路与 hook 同参，
              // 配置形状沿用 yaml 的 {enabled, penalty}（见 config.ts 解析）。
              importancePenalty?: { enabled?: boolean; penalty?: number } | number;
              // P0-2（issue #2）：native RRF 共识门槛（0/缺省=关=逐位现状）
              nativeMinRRF?: number;
              // RV2-2：精排重设计四因子（relevance/timeProx/significance/coreRef，相关度主导）
              rerankWeights?: { relevance: number; timeProx: number; significance: number; coreRef: number };
              queryExpansion?: { enabled?: boolean; maxTerms?: number; ttlMs?: number; timeoutMs?: number };
            };
            llm?: unknown;
          };
        };
      }).config;
      const recallCfg = gwCfg?.memory?.recall;
      const qe = recallCfg?.queryExpansion;
      return {
        coreRefBoost: recallCfg?.coreRefBoost,
        timeBoost: recallCfg?.timeBoost,
        recencyBoost: recallCfg?.recencyBoost,
        sigWeight: recallCfg?.sigWeight,
        inferredPenalty: recallCfg?.inferredPenalty,
        reinforcementWeight: recallCfg?.reinforcementWeight,
        moodBoost: recallCfg?.moodBoost,
        // R-A2：候选池通道开关透传（graphDiscount=0 = 图通道完全退出）
        // V2-1：PPR 三旋钮透传（缺省 undefined → executeMemorySearch 回落默认——
        // 若缺此透传，config 覆写会被工具路静默忽略，登记的计划外接线）
        graphMinStrength: recallCfg?.graphMinStrength,
        graphDiscount: recallCfg?.graphDiscount,
        pprDamping: recallCfg?.pprDamping,
        pprTopK: recallCfg?.pprTopK,
        pprIterations: recallCfg?.pprIterations,
        sceneBoost: recallCfg?.sceneBoost,
        // P1-T7：importance 降权同参透传（hook 路 auto-recall.ts:2136-2149 同源配置）——
        // 未传 = 0 = 逐位现状；不再由工具路硬编码 DEFAULT(0) 静默忽略生产开关。
        importancePenalty: (() => {
          const imp = recallCfg?.importancePenalty;
          if (typeof imp === "number") return imp;
          return imp?.enabled === true ? (imp.penalty ?? 0) : 0;
        })(),
        // P0-2（issue #2）：native RRF 共识门槛透传（缺省 undefined → executeMemorySearch 0=关）
        nativeMinRRF: recallCfg?.nativeMinRRF,
        // V2 批 2（I2 修补）：引擎三 exploreSlot/rerankWeights + 引擎一 queryExpansion
        // 透传——关断矩阵在工具路成立；runner 由 executeMemorySearch 惰性构造（C1 同源）
        exploreSlot: recallCfg?.exploreSlot,
        rerankWeights: recallCfg?.rerankWeights,
        queryExpansion: qe
          ? { ...qe, llm: gwCfg?.memory?.llm as import("../core/recall/query-expand.js").QueryExpansionLlmConfig | undefined }
          : undefined,
      };
    })(),
  });
  const recallLatencyMs = performance.now() - tStart;

  // 非侵入式上报召回指标（service 模式，静默失败，绝不影响业务返回）
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: result.results.map((r) => ({ content: r.content, score: r.score, type: r.type })),
      recallStrategy: result.strategy === "fts" ? "keyword" : result.strategy === "none" ? "skipped" : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默失败
  }

  // D-0：search 映射同走单一源（scene_name/priority 补齐；session/timestamp×3
  // 属查询路七字段，搜索行类型不含——诚实缺列）。
  const items = result.results.map((r) =>
    handleAtomicSearchShape(r as unknown as Record<string, unknown>),
  ) as unknown as AtomicSearchHit[];

  return successEnvelope<AtomicSearchData>({ items }, requestId);
}

/**
 * DS-RECALL-MERGE-001（合并召回 · 核心单点 /v3/recall + 代理瘦传输）。
 *
 * spec：docs/superpowers/specs/2026-09-12-recall-merge-design.md（裁决权威）。
 * 请求：query + maxResults?（body）+ 会话标识（body session_id 或 x-tdai-session-id 头
 * ——v3 隔离头族既有先例，body 优先，由 dispatch 的 resolveIsolation 统一解析）+
 * 三元组隔离头（/v3 严格隔离闸门已强制）。
 * 处理：内部复用 auto-recall 钩子的同一条组装路径 performLayeredRecall（searchMemories +
 * R7 分层 + 预算 + 幂等结论层 + CAL C1 截断），产出与钩子注入完全同形的文本块。
 * 响应：{ block, meta: { conclusionCount, experienceCount, sessionReused, layered } }。
 *
 * 关断矩阵（spec §5 验收 1）：v3Recall.enabled 缺省 false → 404 + 明确错误信息
 * （逐位现状：端点不暴露，代理自动降级旧路 /v3/atomic/search）。
 * 检索租户收窄：与 handleAtomicSearch 同形 (team,user,agent[,task]) 不含 session
 * （L1 召回跨 session）；钩子路（performLayeredRecall 不传 filter）行为零变化。
 * 超时：v3Recall.timeoutMs（缺省 5000）→ 504（代理降级旧路）。
 * 无命中：block="" + meta 全零（语义 = 本轮无可注入，非失败——代理零注入不降级）。
 */
// S-FEEL-1（M1/S6）：近期情绪基调只读端点。三元组头取租户（/v3 严格 isolation 闸门 422 同族）→
// store.recentAffectSignals（可选方法，缺实现=宁缺毋滥返回 tier:null）→ computeMoodTier（单一源）。
// 红线 R-A：本端点只读零写库、不参与任何召回排序/加权；不出连续值（防伪精度）。
async function handleMemoryMood(_body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const gwCfg = (deps as { config?: { memory?: import("../config.js").MemoryTdaiConfig } }).config;
  const moodCfg = gwCfg?.memory?.coreMemory?.moodLine;
  if (!moodCfg?.enabled) return successEnvelope({ tier: null, sampleCount: 0, enabled: false }, requestId);
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (typeof store.recentAffectSignals !== "function") return successEnvelope({ tier: null, sampleCount: 0, enabled: true }, requestId);
  const iso = deps.requestIsolation;
  try {
    const samples = await Promise.resolve(store.recentAffectSignals(
      { teamId: iso?.teamId ?? "default", userId: iso?.userId ?? "default", agentId: iso?.agentId ?? "default" },
      { windowHours: moodCfg.windowHours, maxSamples: moodCfg.maxSamples },
    ));
    const r = computeMoodTier(samples, {
      minSamples: moodCfg.minSamples,
      maxSamples: moodCfg.maxSamples,
      posThreshold: moodCfg.posThreshold,
      negThreshold: moodCfg.negThreshold,
      halfLifeHours: moodCfg.halfLifeHours,
      nowMs: Date.now(),
    });
    return successEnvelope({ tier: r.tier, sampleCount: r.sampleCount, enabled: true, windowHours: moodCfg.windowHours, maxSamples: moodCfg.maxSamples, minSamples: moodCfg.minSamples, posThreshold: moodCfg.posThreshold, negThreshold: moodCfg.negThreshold, halfLifeHours: moodCfg.halfLifeHours }, requestId);
  } catch (err) {
    return errorEnvelope(500, `mood compute failed: ${err instanceof Error ? err.message : String(err)}`, requestId);
  }
}

// task-100：embedding 进程内缓存是**累计**计数器（MemoryCore/src/core/store/embedding.ts:558
// getCacheStats），指标要的是增量 ⇒ 这里保留上次快照，只上报 delta。首轮快照为 undefined
// ⇒ 不报（不把「进程启动至今」的累计值当成一次召回的量）。
let lastEmbedCacheSnapshot: { hits: number; misses: number } | undefined;

async function handleRecall(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const gwCfg = (deps as { config?: { memory?: import("../config.js").MemoryTdaiConfig } }).config;
  const v3Recall = gwCfg?.memory?.recall?.v3Recall;
  if (!v3Recall?.enabled) {
    return errorEnvelope(
      404,
      "/v3/recall is disabled: memory.recall.v3Recall.enabled is false (code default). " +
      "Set memory.recall.v3Recall.enabled=true in tdai-gateway.yaml to enable the merged-recall endpoint.",
      requestId,
    );
  }
  const b = (body ?? {}) as { query?: unknown; maxResults?: unknown; time_point?: unknown };
  if (typeof b.query !== "string" || b.query.trim().length === 0) {
    return errorEnvelope(400, "query (non-empty string) required", requestId);
  }
  let maxResultsOverride: number | undefined;
  if (b.maxResults !== undefined && b.maxResults !== null) {
    const n = typeof b.maxResults === "number" ? b.maxResults : Number(b.maxResults);
    if (!Number.isFinite(n) || Math.floor(n) < 1) {
      return errorEnvelope(400, "maxResults must be a positive integer", requestId);
    }
    maxResultsOverride = Math.floor(n);
  }
  // GROW-EVO P2.1（§2.4 时间旅行）：time_point（ISO）——失效排除与时间窗解析以该时点
  // 为"当前"（当时有效语义）；缺省 = 现在。同时旁路会话复用缓存（不同时点不可复用）。
  let validityNow: Date | undefined;
  if (b.time_point !== undefined && b.time_point !== null && b.time_point !== "") {
    if (typeof b.time_point !== "string" || !Number.isFinite(Date.parse(b.time_point))) {
      return errorEnvelope(400, `time_point 不是合法 ISO 时间: ${String(b.time_point)}`, requestId);
    }
    validityNow = new Date(b.time_point);
  }
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const dataDir = deps.getDataDir?.() ?? "";
  if (!dataDir) return errorEnvelope(503, "recall endpoint misconfigured: getDataDir dep unavailable", requestId);
  const cfgBase = gwCfg?.memory;
  if (!cfgBase) return errorEnvelope(503, "memory config not available", requestId);
  // maxResults 覆写（可选）：缺省 = cfg.recall.maxResults（与钩子同形的前提）。
  const cfg: import("../config.js").MemoryTdaiConfig = maxResultsOverride !== undefined
    ? { ...cfgBase, recall: { ...cfgBase.recall, maxResults: maxResultsOverride } }
    : cfgBase;

  const iso = deps.requestIsolation;
  // 会话标识（结论层幂等缓存 / 会话复用缓存的 sessionKey）：body session_id 或
  // x-tdai-session-id 头（resolveIsolation 已统一解析）。【F-EV12-2-b 修正】未传时
  // resolveIsolation 会把 sessionId 缺省填充为 "default"（v2-schemas.ts:393），
  // 并非本注释此前宣称的空串——缓存共享面由缓存键侧的租户三元组并入防御
  // （auto-recall reuseCacheKey / conclusionCacheKey，REG-REMAINING-006 A-2）。
  const sessionKey = iso?.sessionId ?? "";
  // 检索租户收窄：与 handleAtomicSearch 同形——(team,user,agent,task) 不含 session
  // （L1 召回跨 session，agent 维度）。三元组缺失已在 /v3 闸门 422（严格模式）；
  // 非严格部署缺省 → default 家族桶（与既有 v3 行为连续）。
  const searchFilter = iso
    ? {
        ...(iso.teamId ? { teamId: iso.teamId } : {}),
        ...(iso.userId ? { userId: iso.userId } : {}),
        ...(iso.agentId ? { agentId: iso.agentId } : {}),
        ...(iso.taskId ? { taskId: iso.taskId } : {}),
      }
    : undefined;
  // profile scope（scene index / L2 结论层 scene_block 通道基底）：team+agent 粒度（与
  // 钩子路 performAutoRecallCore 缺省派生同式）。
  // R4-5（A6 召回级）：L2/L3 profile scope 三元组化——userId 必须随行，否则同 team+agent
  // 的跨 user 场景块互串（ev10 Q 租户实证）。缺省 user:default（钩子无租户路径同桶）。
  const profileIsolation = { teamId: iso?.teamId || "default", userId: iso?.userId || "default", agentId: iso?.agentId || "default" };

  const tStart = performance.now();
  const timeoutMs = v3Recall.timeoutMs ?? 5000;
  // ── task-100（预算内降级，2026-11-01）──────────────────────────────────────
  // 真日志读数（task-93，n=144）：recall 端到端 P50=4260ms / P90=17348ms，l1 占 99.5%，
  // 时间全花在远端 query embedding（单次 282ms–19.3s）。旧行为下只有两种结局：等到
  // timeoutMs 拿完整结果，或 504 拿空。这里给向量腿一个**绝对**截止时刻：tStart +
  // l1BudgetMs（scene/L2/expand 已花的自然被扣掉），超了就只用已算完的 FTS 腿继续组装
  // ——块照样回，只是少召回，并在 meta 上标 degraded。
  // l1BudgetMs=0 ⇒ 关（逐位旧行为）；l1Fallback='none' ⇒ 也不降级（只观测不改变行为）。
  const l1BudgetMs = v3Recall.l1BudgetMs ?? 2000;
  const l1Fallback = v3Recall.l1Fallback ?? "fts";
  const l1Budget = l1BudgetMs > 0 && l1Fallback === "fts"
    ? { deadlineAt: tStart + l1BudgetMs, fallback: "fts" as const }
    : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT_SENTINEL = "__recall_timeout__";

  // ── #74（Batch A · 两级剥噪，2026-10-20）：端点路查询剥噪，与钩子路（auto-recall
  // 对 userText 的 sanitizeText 剥壳）对齐。一级：#88 修订后 skip 当且仅当剥噪残留=0（MIN_QUERY_RESIDUAL_CHARS 降级档位标记）
  // 字符 = 纯脚手架查询 → 整条跳过（零检索零注入零指标上报），journal 以
  // skipReason="scaffold-query" 注记——skip 路是独立语义入口，不经 performLayeredRecall
  // 采集点（该采集点单一源禁第二份），租户推导与目录形态镜像 auto-recall.ts journal
  // 落库；二级：清洗后检索（P6 活体证据：压缩区段查询剥壳后仍可能携带有效语义行，
  // 不一刀切丢弃）。
  const sq = sanitizeRecallQuery(b.query);
  if (sq.skipped) {
    const skipPerfMs: RecallJournalPerfMs = {
      total: Math.round(performance.now() - tStart),
      scene: 0,
      expand: 0,
      l2: 0,
      l1: 0,
      soul: 0,
    };
    // best-effort：journal 失败零影响 skip 响应（与钩子路同纪律）。
    try {
      const journalCfg = cfg.recallJournal ?? { enabled: false, rotationSizeMB: 5, maxFiles: 5 };
      if (journalCfg.enabled) {
        // S8 D10：skip 行也带 soul 观测（新会话首次调用即可回答「用的哪版卡」）。
        const soulFields = await collectSoulJournalFields(
          store,
          {
            teamId: searchFilter?.teamId ?? profileIsolation.teamId ?? "default",
            userId: searchFilter?.userId ?? profileIsolation.userId ?? "default",
            agentId: searchFilter?.agentId ?? profileIsolation.agentId ?? "default",
          },
          { sessionReused: false },
        );
        appendRecallJournal(
          path.join(dataDir, "logs", "recall"),
          {
            teamId: searchFilter?.teamId ?? profileIsolation.teamId ?? "default",
            agentId: searchFilter?.agentId ?? profileIsolation.agentId ?? "default",
          },
          {
            ts: new Date().toISOString(),
            query: sq.text,
            strategy: "scaffold-skip",
            teamId: searchFilter?.teamId ?? profileIsolation.teamId ?? "default",
            userId: searchFilter?.userId,
            agentId: searchFilter?.agentId ?? profileIsolation.agentId ?? "default",
            sessionKey,
            sessionReused: false,
            layered: false,
            conclusionCount: 0,
            experienceCount: 0,
            searchTiming: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 },
            skipReason: "scaffold-query",
            // #88 R9：skip 行双留痕——原文截断 + 长度 + hash8 + 残差（闸门失明定界用）。
            rawQuery: b.query.slice(0, 120),
            rawLen: b.query.length,
            rawHash8: createHash("sha256").update(b.query, "utf8").digest("hex").slice(0, 8),
            residualChars: sq.residualChars,
            memoryLines: [],
            perfMs: skipPerfMs,
            ...(soulFields ? { soul: soulFields } : {}),
          },
          journalCfg,
        );
      }
    } catch {
      /* 兜底：writer 已吞错，此处再兜一层 */
    }
    return successEnvelope<{
      block: string;
      meta: { conclusionCount: number; experienceCount: number; sessionReused: boolean; layered: boolean; skipReason: string; perfMs: RecallJournalPerfMs };
    }>(
      {
        block: "",
        meta: {
          conclusionCount: 0,
          experienceCount: 0,
          sessionReused: false,
          layered: false,
          skipReason: "scaffold-query",
          perfMs: skipPerfMs,
        },
      },
      requestId,
    );
  }

  const outcome = await Promise.race([
    performLayeredRecall({
      userText: sq.text,
      sessionKey,
      cfg,
      pluginDataDir: dataDir,
      logger: deps.logger,
      vectorStore: store,
      embeddingService: deps.getEmbedding(),
      storage: deps.getStorage(),
      profileIsolation,
      isolationFilter: searchFilter,
      validityNow,
      l1Budget,
    }).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    }),
  ]);
  if (outcome === TIMEOUT_SENTINEL) {
    deps.logger.warn(`${TAG} [/v3/recall] recall timed out after ${timeoutMs}ms (instance=${auth.serviceId})`);
    return errorEnvelope(504, `/v3/recall timed out after ${timeoutMs}ms`, requestId);
  }

  const recallLatencyMs = performance.now() - tStart;
  // ── task-100：降级留痕 ────────────────────────────────────────────────────
  // degraded='fts' ⇒ 本轮只用了 FTS 腿（少召回但块非空）；degraded=null ⇒ 全量。
  const degraded: "fts" | null = outcome.searchTiming?.degraded ?? null;
  const l1Ms = Math.round(outcome.perfMs?.l1 ?? 0);
  const ftsMs = Math.round(outcome.searchTiming?.ftsMs ?? 0);
  if (degraded === "fts") {
    deps.logger.warn(
      `${TAG} [/v3/recall] l1 degraded to fts (budget=${l1BudgetMs}ms, l1Ms=${l1Ms}ms, ftsMs=${ftsMs}ms, ` +
      `ftsHits=${outcome.searchTiming?.ftsHits ?? 0}, budgetHit=${outcome.searchTiming?.budgetHit === true}, ` +
      `latency=${Math.round(recallLatencyMs)}ms, instance=${auth.serviceId})`,
    );
  }
  // embedding 缓存增量（每请求 delta，不是累计值）
  let embedCacheDelta: { hits: number; misses: number } | undefined;
  try {
    const emb = deps.getEmbedding();
    const withStats = emb as unknown as { getCacheStats?: () => { hits: number; misses: number } };
    const stats = typeof withStats?.getCacheStats === "function" ? withStats.getCacheStats() : undefined;
    if (stats && lastEmbedCacheSnapshot) {
      embedCacheDelta = {
        hits: Math.max(0, stats.hits - lastEmbedCacheSnapshot.hits),
        misses: Math.max(0, stats.misses - lastEmbedCacheSnapshot.misses),
      };
    }
    if (stats) lastEmbedCacheSnapshot = { hits: stats.hits, misses: stats.misses };
  } catch {
    // 缓存统计是观测面，取不到就不报（绝不影响召回返回）
  }
  // 非侵入式上报召回指标（与 handleAtomicSearch 同款，静默失败，绝不影响业务返回）
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: outcome.recalledL1Memories,
      recallStrategy: outcome.effectiveStrategy === "fts" ? "keyword" : outcome.effectiveStrategy,
      recallLatencyMs,
      hasError: false,
      // task-100 新增（可选字段：老调用方不传即不报，逐位旧行为）
      degraded,
      l1Ms,
      embedCache: embedCacheDelta,
    });
  } catch {
    // 静默失败
  }

  return successEnvelope<{
    block: string;
    meta: {
      conclusionCount: number; experienceCount: number; sessionReused: boolean; layered: boolean;
      soulVersion?: string; mood?: string; perfMs: RecallJournalPerfMs;
      // task-100（新增，老字段一个不动）：向量腿降级标记与分段耗时
      degraded: "fts" | null; l1Ms: number; ftsMs: number;
    };
  }>(
    {
      block: outcome.block ?? "",
      meta: {
        conclusionCount: outcome.conclusionCount,
        experienceCount: outcome.experienceCount,
        sessionReused: outcome.sessionReused,
        layered: outcome.layered,
        soulVersion: outcome.soulVersion,
        // task-100：降级标记 + L1 实际耗时 + FTS 腿耗时（毫秒整数）
        degraded,
        l1Ms,
        ftsMs,
        // S-FEEL-1（M1）：enabled=false/样本不足时 outcome.mood=undefined → 条件展开不出键（逐位现状）。
        ...(outcome.mood !== undefined ? { mood: outcome.mood } : {}),
        // #61（2026-10-18）：分段计时观测（毫秒）——超时黑洞定位（journal perfMs 同源）。
        perfMs: outcome.perfMs,
      },
    },
    requestId,
  );
}

async function handleAtomicNeighbors(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { id?: string; types?: string[]; maxHop?: number; maxN?: number };
  if (!b.id || typeof b.id !== "string") return errorEnvelope(400, "id (string) required", requestId);
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.getNeighbors || (!store.getL1ByIds && !store.getL1ByIdsWithArchive)) return successEnvelope({ id: b.id, neighbors: [] }, requestId);
  const maxHop = Math.max(1, Math.min(b.maxHop ?? 1, 3));
  // P2-T14（G2）：neighbors 消费租户隔离——知道任意 record_id 也不能跨租户枚举
  // 邻居+内容。作用域与删除/更新 handler 同形：(team, user, agent, task)，不含 session
  // （图是跨会话的关系事实）。requestIsolation 缺省（直连测试/旧调用方）→ undefined = 旧行为。
  const iso = deps.requestIsolation;
  const scope = iso
    ? { teamId: iso.teamId, userId: iso.userId, agentId: iso.agentId, taskId: iso.taskId }
    : undefined;
  const links = await store.getNeighbors(b.id, b.types, maxHop, scope) as Array<{ id: string; type: string; strength: number; hop: number }>;
  // P2-T14（G8）：maxN 上限 clamp——BFF 透传 10^6 也不会让稠密图 BFS 无护栏；
  // 终审 F-2：下界也 clamp——负数会让 slice 语义反转（从尾部取），绕过上限护栏
  const maxN = Math.max(1, Math.min(b.maxN ?? 20, 50));
  const take = links.slice(0, maxN);
  // fix1 I-4：getL1ByIds/WithArchive 放宽为 MaybePromise（tcvdb 异步取行）→ 统一 await
  // （sqlite 同步路径 await 数组零语义变化；不 await 则 tcvdb 后端拿到的是 Promise，内容全 undefined）。
  const records = await (store.getL1ByIdsWithArchive ? store.getL1ByIdsWithArchive(take.map((n) => n.id)) : store.getL1ByIds!(take.map((n) => n.id)));
  const byId = new Map(records.map((rec) => [rec.record_id, rec]));
  const neighbors = take.map((n) => {
    const rec = byId.get(n.id);
    return {
      id: n.id, type: n.type, strength: n.strength, hop: n.hop,
      content: rec?.content,
      occurred_at: rec?.occurred_at, valid_start: rec?.valid_start, valid_end: rec?.valid_end,
      certainty: rec?.certainty, valence: rec?.valence, arousal: rec?.arousal, significance: rec?.significance,
    };
  });
  return successEnvelope<{ id: string; neighbors: typeof neighbors }>({ id: b.id, neighbors }, requestId);
}

/**
 * C6（graph 设计 §4 / spec §6.4 #1）：/v3/atomic/path —— 两节点间 BFS 最短路径。
 * requestIsolation 消费照抄 neighbors（作用域 (team,user,agent,task) 不含 session——
 * 图是跨会话的关系事实；requestIsolation 缺省（直连测试/旧调用方）→ undefined = 旧行为）。
 * maxHop clamp [1,3]（同 neighbors 护栏）。store 未实现 getPath（tcvdb 可选方法，
 * F7 家族先例）→ path: null（如实缺省，不伪成功也不 500）。
 * MemoryPanel 消费不在 S5（登记后续）。
 */
export async function handleAtomicPath(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const b = (body ?? {}) as { startId?: string; endId?: string; maxHop?: number; types?: string[] };
  if (!b.startId || typeof b.startId !== "string") return errorEnvelope(400, "startId (string) required", requestId);
  if (!b.endId || typeof b.endId !== "string") return errorEnvelope(400, "endId (string) required", requestId);
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.getPath) return successEnvelope<{ startId: string; endId: string; path: null }>({ startId: b.startId, endId: b.endId, path: null }, requestId);
  const maxHop = Math.max(1, Math.min(b.maxHop ?? 3, 3));
  // 租户隔离：作用域与 neighbors 同形（T14 教训——新图接口从第一天就带 isolation）
  const iso = deps.requestIsolation;
  const scope = iso
    ? { teamId: iso.teamId, userId: iso.userId, agentId: iso.agentId, taskId: iso.taskId }
    : undefined;
  const raw = await store.getPath(b.startId, b.endId, maxHop, b.types, scope);
  const pathNodes = raw ?? null;
  // 内容增强（与 neighbors 同形）：路径节点批量取行补 content + 灵魂字段
  let path: Array<{ id: string; type: string; strength: number; hop: number; content?: string; occurred_at?: string; certainty?: string; valence?: number; significance?: number }> | null = pathNodes;
  if (pathNodes && pathNodes.length > 0 && (store.getL1ByIdsWithArchive || store.getL1ByIds)) {
    const records = await (store.getL1ByIdsWithArchive
      ? store.getL1ByIdsWithArchive(pathNodes.map((n) => n.id))
      : store.getL1ByIds!(pathNodes.map((n) => n.id)));
    const byId = new Map(records.map((rec) => [rec.record_id, rec]));
    path = pathNodes.map((n) => {
      const rec = byId.get(n.id);
      return {
        id: n.id, type: n.type, strength: n.strength, hop: n.hop,
        content: rec?.content,
        occurred_at: rec?.occurred_at, certainty: rec?.certainty,
        valence: rec?.valence, significance: rec?.significance,
      };
    });
  }
  return successEnvelope<{ startId: string; endId: string; path: typeof path }>({ startId: b.startId, endId: b.endId, path }, requestId);
}

/**
 * P2-T12（K1）：从 requestIsolation 派生 core 租户三元组（缺维度 → default 桶）。
 * - /v3 严格模式：三元组缺失已在闸门 422，到这里必然齐全；
 * - /v2 匿名：resolveIsolation 已填 default 家族 → default 桶，与存量回填值
 *   （拍板⑤ = DEFAULT_ISOLATION_ID）自洽，匿名路径读到迁移前原数据，行为连续。
 * - requestIsolation 整体缺省（直连测试/旧调用方）→ default 桶（core 是身份层
 *   信任边界，不允许"缺省=跨租户读"；与 T14 neighbors 的 undefined=旧行为不同）。
 */
function coreTenantFromIsolation(iso?: { teamId?: string; userId?: string; agentId?: string }): CoreTenant {
  return {
    teamId: iso?.teamId || DEFAULT_ISOLATION_ID,
    userId: iso?.userId || DEFAULT_ISOLATION_ID,
    agentId: iso?.agentId || DEFAULT_ISOLATION_ID,
  };
}

async function handleCoreMemoryRead(_body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  // GROW：可选 include_retired（Panel 退休区用；默认 false = active-only 匹配面不变）
  const b = (_body ?? {}) as { include_retired?: unknown; format?: unknown };
  const includeRetired = b.include_retired === true;
  // P2-T12（K1）：core 按租户过滤。S8（2026-11-07）：价值锚整表已删除，响应不再带 values。
  const tenant = coreTenantFromIsolation(deps.requestIsolation);
  const core = (await store.readCore?.(tenant)) ?? [];
  void includeRetired;
  // #67（R3 身份叙事层，2026-10-19）：format="narrative"（且 config 门开）——identity /
  // self_identity 两槽折叠为一条 identity_narrative 叙事槽（renderIdentityNarrative 单一源：
  // 模板常量+事实句逐字，无 LLM/随机/时钟；soul 会话头辅路同源双路）。Park 2411.10109
  // 口径：条目存储 + 叙事渲染并存——只改响应形态，存储合同（identity-discovery 提案门 /
  // version++）不动；门关 / 格式缺席 / 生成闸违例 / 无身份内容 → 原条目形态（逐位现状，
  // proxy 兼容旧响应）。非身份槽（strict_rule / core_value…）原样保留；narrSlot 的
  // version/updated_at 取身份行聚合（max version / 最新 updated_at，合成槽可审计溯源）。
  const cfg = deps.config?.memory?.coreMemory;
  const narrEnabled = cfg?.soulRender?.identityNarrative?.enabled === true;
  let slotsOut: typeof core = core;
  if (narrEnabled && b.format === "narrative") {
    const narr = renderIdentityNarrative(core, {
      budgetChars: (cfg?.soulRender?.budgetSelfChars ?? 600) + (cfg?.soulRender?.budgetIdentityChars ?? 900),
    });
    if (narr) {
      const isId = (s: { slot: string }) => s.slot === "self_identity" || s.slot === "identity";
      const idRows = core.filter(isId);
      const narrSlot = {
        slot: IDENTITY_NARRATIVE_SLOT,
        content: narr,
        source: "narrative",
        version: Math.max(0, ...idRows.map((s) => s.version)),
        updated_at: idRows.map((s) => s.updated_at).sort().at(-1) ?? "",
      };
      slotsOut = [];
      let placed = false;
      for (const s of core) {
        if (isId(s)) {
          if (!placed) {
            slotsOut.push(narrSlot); // 首个身份行的位置承载叙事槽（身份内容位置不丢）
            placed = true;
          }
          continue;
        }
        slotsOut.push(s);
      }
    }
  }
  return successEnvelope<{ slots: typeof core }>({ slots: slotsOut }, requestId);
}

// 2026-11-07（task-20）：core-memory 写入口已退役 —— 该 handler 与 trust-boundary guard
// （src/core/core-memory/guard.ts，validateCoreWrite）一并删除，理由是零调用方：Panel 只读
// /v3/core-memory/read，插件不写核心槽；core_memory 槽现无任何进程内写者，读面（含
// format=narrative 叙事渲染）原样保留。

async function handleAtomicDelete(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicDeleteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // deleteL1Batch returns bool, but we need actual count
  // Fall back to per-id deletion for accurate counting
  // 按 id 删除时，只使用显式传入的 isolation 维度作为 filter。
  // 避免默认 sessionId="default" 导致真实 session 下的 L1 记录无法删除。
  const iso = deps.requestIsolation;
  const deleteFilter = iso ? {
    ...(iso.teamId ? { teamId: iso.teamId } : {}),
    ...(iso.userId ? { userId: iso.userId } : {}),
    ...(iso.agentId ? { agentId: iso.agentId } : {}),
    ...(iso.taskId ? { taskId: iso.taskId } : {}),
    // 不传 sessionId：按 id 删除不应被默认 sessionId 限制
  } : undefined;
  let deletedCount = 0;
  const deletedIds: string[] = [];
  for (const id of ids) {
    const ok = await store.deleteL1(id, deleteFilter);
    if (ok) {
      deletedCount++;
      deletedIds.push(id);
    }
  }

  // 审计：L1 delete — 每条删除一行 audit
  for (const id of deletedIds) {
    await recordAudit(store, {
      record_id: id,
      layer: "L1",
      action: "delete",
      iso: deps.requestIsolation,
      version: 0, // 已删除，无新版本
      requestId,
      logger: deps.logger,
    });
  }

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager.reportMemoryDeleted(auth.serviceId, deletedCount).catch(() => {});
  }

  return successEnvelope<AtomicDeleteData>({ deleted_count: deletedCount }, requestId);
}

// ============================
// L2/L3 Profile Sync Helpers (write-through to VDB)
// ============================

type RequestIsolation = { teamId?: string; userId: string; agentId: string; sessionId: string; taskId?: string };

function buildIsolationScope(isolation?: RequestIsolation): string {
  return isolation ? buildProfileIsolationScope(isolation) : DEFAULT_PROFILE_SCOPE;
}

function buildIsolationStoragePrefix(isolation: RequestIsolation): string {
  return `profiles/${encodeURIComponent(buildIsolationScope(isolation))}/`;
}

function scopedProfileStorage(storage: StorageAdapter, isolation?: RequestIsolation): StorageAdapter {
  // Direct unit callers may not go through handleV2Route and therefore do not
  // have requestIsolation attached. Keep that legacy path at root; real HTTP
  // requests always resolve to either explicit ids or the `default` bucket.
  if (!isolation) return storage;
  return createScopedStorageAdapter(storage, buildIsolationStoragePrefix(isolation));
}

function md5Hex(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function parseMetadataJson(raw: string | undefined): MemoryRecord["metadata"] {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as MemoryRecord["metadata"] : {};
  } catch {
    return {};
  }
}

async function getProfileVersion(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filename: string,
  isolation?: RequestIsolation,
): Promise<number> {
  if (!store) return 0;
  const scope = buildIsolationScope(isolation);
  const id = buildProfileStableId(scope, type, filename);
  try {
    // 优先使用轻量按 id 查询，避免全量 pullProfiles()
    if (typeof store.queryProfilesByIds === "function") {
      const results = await store.queryProfilesByIds([id]);
      return results[0]?.version ?? 0;
    }
    if (typeof store.pullProfiles === "function") {
      const existing = (await store.pullProfiles()).find((r) => r.id === id);
      return existing?.version ?? 0;
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * 批量获取多个 profile 的 version，一次查询。
 * 优先使用 queryProfilesByIds（轻量），fallback 到 pullProfiles（全量）。
 */
async function getProfileVersionBatch(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filenames: string[],
  isolation?: RequestIsolation,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!store || filenames.length === 0) return result;
  const scope = buildIsolationScope(isolation);
  const ids = filenames.map((fn) => buildProfileStableId(scope, type, fn));
  try {
    if (typeof store.queryProfilesByIds === "function") {
      const records = await store.queryProfilesByIds(ids);
      const versionMap = new Map(records.map((r) => [r.id, r.version]));
      for (let i = 0; i < filenames.length; i++) {
        result.set(filenames[i], versionMap.get(ids[i]) ?? 0);
      }
      return result;
    }
    if (typeof store.pullProfiles === "function") {
      const all = await store.pullProfiles();
      const versionMap = new Map(all.map((r) => [r.id, r.version]));
      for (let i = 0; i < filenames.length; i++) {
        result.set(filenames[i], versionMap.get(ids[i]) ?? 0);
      }
      return result;
    }
  } catch {
    // fall through
  }
  return result;
}

/** Best-effort write-through L2/L3 profile to VDB. Failure is logged but does not break the API. */
async function syncProfileToVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filename: string,
  content: string,
  logger: Logger,
  createdAtOverride?: number,
  isolation?: RequestIsolation,
): Promise<number> {
  if (!store || typeof store.syncProfiles !== "function") return 0;
  try {
    const now = Date.now();

    // Try to extract created time from META in content
    let createdAtMs = createdAtOverride ?? 0;
    if (!createdAtMs) {
      const metaMatch = content.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----/);
      if (metaMatch) {
        for (const line of metaMatch[1].split("\n")) {
          if (line.startsWith("created: ")) {
            const ts = Date.parse(line.slice(9));
            if (!isNaN(ts)) createdAtMs = ts;
            break;
          }
        }
      }
    }
    if (!createdAtMs) createdAtMs = now;

    const scope = buildIsolationScope(isolation);
    const id = buildProfileStableId(scope, type, filename);

    // Probe current VDB version to satisfy the optimistic-lock check in
    // TcvdbMemoryStore.syncProfiles (which compares baselineVersion against
    // the remote version). Without this, the second and subsequent writes
    // to the same profile would be silently skipped as a version conflict.
    // Best-effort: if queryProfilesByIds/pullProfiles is unavailable or fails,
    // fall back to undefined and let syncProfiles decide (insert if remote missing,
    // otherwise log + skip — which preserves the previous behaviour).
    let baselineVersion: number | undefined;
    let currentMd5: string | undefined;
    try {
      if (typeof store.queryProfilesByIds === "function") {
        const results = await store.queryProfilesByIds([id]);
        const existing = results[0];
        if (existing) {
          baselineVersion = existing.version;
          currentMd5 = existing.contentMd5;
        }
      } else if (typeof store.pullProfiles === "function") {
        const remote = await store.pullProfiles();
        const existing = remote.find((r) => r.id === id);
        if (existing) {
          baselineVersion = existing.version;
          currentMd5 = existing.contentMd5;
        }
      }
    } catch (err) {
      logger.warn(`${TAG} [profile-sync] probe failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const contentMd5 = md5Hex(content);
    const nextVersion = currentMd5 === contentMd5
      ? (baselineVersion ?? 0)
      : (baselineVersion === undefined ? 0 : baselineVersion + 1);

    const record: ProfileSyncRecord = {
      id,
      type,
      filename,
      content,
      contentMd5,
      version: nextVersion,
      createdAtMs,
      updatedAtMs: now,
      baselineVersion,
      teamId: isolation?.teamId,
      userId: isolation?.userId,
      agentId: isolation?.agentId,
      // L2/L3 profiles are team+agent scoped; session_id/task_id are intentionally not written.
      sessionId: undefined,
    };
    await store.syncProfiles([record]);
    logger.debug?.(`${TAG} [profile-sync] ${type} upserted to VDB: ${filename} (baselineVersion=${baselineVersion ?? "new"}, version=${nextVersion})`);
    return nextVersion;
  } catch (err) {
    logger.warn(`${TAG} [profile-sync] FAILED to sync ${type} profile ${filename} to VDB: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Best-effort delete L2 profiles from VDB. */
async function deleteProfilesFromVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filenames: string[],
  logger: Logger,
  isolation?: RequestIsolation,
): Promise<void> {
  if (!store || typeof store.deleteProfiles !== "function" || filenames.length === 0) return;
  try {
    const scope = buildIsolationScope(isolation);
    const ids = filenames.map((fn) => buildProfileStableId(scope, type, fn));
    await store.deleteProfiles(ids);
    logger.debug?.(`${TAG} [profile-sync] ${type} deleted from VDB: ${filenames.length} files`);
  } catch (err) {
    logger.warn(`${TAG} [profile-sync] FAILED to delete ${type} profiles from VDB: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Best-effort refresh scene_index.json so pipeline sees the user-written L2 files. */
async function refreshSceneIndex(storage: StorageAdapter, logger: Logger): Promise<void> {
  try {
    const { syncSceneIndex } = await import("../core/scene/scene-index.js");
    // Pass empty dataDir; we only use storage in service mode.
    await syncSceneIndex("", storage);
  } catch (err) {
    logger.warn(`${TAG} [scene-index] FAILED to refresh scene index: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================
// L2 Scenario Handlers
// ============================

async function handleScenarioLs(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioListRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path_prefix } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const prefix = path_prefix
    ? `${StoragePaths.sceneBlocksDir}${path_prefix}`
    : StoragePaths.sceneBlocksDir;

  deps.logger.debug?.(`${TAG} [scenario/ls] storage.type=${storage.type}, prefix="${prefix}"`);

  // One-shot full listing (no pagination; marker-based pagination planned for phase 2)
  const backend = storage.getBackend();
  const result = await backend.listObjects(prefix, { recursive: true });
  deps.logger.debug?.(`${TAG} [scenario/ls] listObjects returned ${result.entries.length} entries`);
  const allEntries = result.entries;

  // Read scene_index.json for summary + created/updated lookup
  const { readSceneIndex } = await import("../core/scene/scene-index.js");
  const sceneIndex = await readSceneIndex("", storage);
  const indexMap = new Map(sceneIndex.map((e) => [e.filename, e]));

  // 批量获取所有 L2 文件的 profile version（一次查询，避免 N+1）
  const l2Filenames = allEntries.filter((e) => !e.isDirectory).map((e) => {
    return e.key.startsWith(StoragePaths.sceneBlocksDir)
      ? e.key.slice(StoragePaths.sceneBlocksDir.length)
      : e.key;
  });
  const versionMap = await getProfileVersionBatch(deps.getStore(), "l2", l2Filenames, deps.requestIsolation);

  const entries: ScenarioEntry[] = allEntries.map((e) => {
    const externalPath = e.key.startsWith(StoragePaths.sceneBlocksDir)
      ? e.key.slice(StoragePaths.sceneBlocksDir.length)
      : e.key;
    const displayPath = e.isDirectory && !externalPath.endsWith("/") ? `${externalPath}/` : externalPath;
    const indexEntry = indexMap.get(externalPath);
    const fallbackTime = e.lastModified.toISOString();
    return {
      path: displayPath,
      summary: indexEntry?.summary || undefined,
      version: e.isDirectory ? 0 : (versionMap.get(externalPath) ?? 0),
      team_id: deps.requestIsolation?.teamId,
      agent_id: deps.requestIsolation?.agentId,
      created_at: indexEntry?.created || fallbackTime,
      updated_at: indexEntry?.updated || fallbackTime,
    };
  });

  return successEnvelope({ entries, total: entries.length }, requestId);
}

async function handleScenarioCount(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioCountRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path_prefix } = parsed.data;

  const store = deps.getStore();
  if (typeof store?.countProfiles === "function") {
    const total = await store.countProfiles({
      type: "l2",
      pathPrefix: path_prefix,
      teamId: deps.requestIsolation?.teamId,
      userId: deps.requestIsolation?.teamId ? undefined : deps.requestIsolation?.userId,
      agentId: deps.requestIsolation?.agentId,
    });
    return successEnvelope<CountData>({ total }, requestId);
  }

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);
  const prefix = path_prefix
    ? `${StoragePaths.sceneBlocksDir}${path_prefix}`
    : StoragePaths.sceneBlocksDir;
  const result = await storage.getBackend().listObjects(prefix, { recursive: true });
  const total = result.entries.filter((e) => !e.isDirectory).length;
  return successEnvelope<CountData>({ total }, requestId);
}

async function handleScenarioRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioReadRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  const content = await storage.readFile(key);

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<ScenarioFile>({
      path,
      content: null as unknown as string,
      created_at: null as unknown as string,
      updated_at: null as unknown as string,
    }, requestId);
  }

  // Parse META for created/updated
  const now = new Date().toISOString();
  let createdAt = now;
  let updatedAt = now;

  const metaMatch = content.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----/);
  if (metaMatch) {
    for (const line of metaMatch[1].split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        const k = line.slice(0, idx);
        const v = line.slice(idx + 2);
        if (k === "created") createdAt = v;
        if (k === "updated") updatedAt = v;
      }
    }
  } else {
    // Fallback: try scene_index
    const { readSceneIndex } = await import("../core/scene/scene-index.js");
    const sceneIndex = await readSceneIndex("", storage);
    const entry = sceneIndex.find((e) => e.filename === path);
    if (entry) {
      createdAt = entry.created || now;
      updatedAt = entry.updated || now;
    } else {
      const stat = await storage.stat(key);
      if (stat) {
        createdAt = new Date(stat.lastModified).toISOString();
        updatedAt = createdAt;
      }
    }
  }

  return successEnvelope<ScenarioFile>({
    path, content,
    version: await getProfileVersion(deps.getStore(), "l2", path, deps.requestIsolation),
    team_id: deps.requestIsolation?.teamId,
    agent_id: deps.requestIsolation?.agentId,
    created_at: createdAt,
    updated_at: updatedAt,
  }, requestId);
}

async function handleScenarioWrite(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioWriteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path, content, summary } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;

  // Existence check: path must already exist (no upsert/create)
  const existing = await storage.readFile(key);
  if (existing === null) return errorEnvelope(404, `Scenario file not found: ${path}`, requestId);

  // Parse existing META to preserve created + update updated/summary
  const now = new Date().toISOString();
  let finalContent: string;

  const metaMatch = existing.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----\n?/);
  if (metaMatch) {
    // Parse existing META fields
    const metaBlock = metaMatch[1];
    const metaFields: Record<string, string> = {};
    for (const line of metaBlock.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) metaFields[line.slice(0, idx)] = line.slice(idx + 2);
    }

    // Update fields
    metaFields["updated"] = now;
    if (summary !== undefined) metaFields["summary"] = summary;

    const newMeta = Object.entries(metaFields).map(([k, v]) => `${k}: ${v}`).join("\n");
    finalContent = `-----META-START-----\n${newMeta}\n-----META-END-----\n\n${content}`;
  } else {
    // META missing or corrupted — rebuild
    const metaLines = [
      `created: ${now}`,
      `updated: ${now}`,
    ];
    if (summary !== undefined) metaLines.push(`summary: ${summary}`);
    finalContent = `-----META-START-----\n${metaLines.join("\n")}\n-----META-END-----\n\n${content}`;
  }

  await storage.writeFile(key, finalContent);

  // Sync L2 to VDB profiles + refresh scene index (best-effort)
  const store = deps.getStore();
  const version = await syncProfileToVdb(store, "l2", path, finalContent, deps.logger, undefined, deps.requestIsolation);
  await refreshSceneIndex(storage, deps.logger);

  // 审计：L2 update — record_id 用 path（L2 主键 = 文件路径）
  await recordAudit(store, {
    record_id: path,
    layer: "L2",
    action: "update",
    iso: deps.requestIsolation,
    version,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope<ScenarioWriteData>({
    path,
    updated_at: now,
    version,
    team_id: deps.requestIsolation?.teamId,
    agent_id: deps.requestIsolation?.agentId,
  }, requestId);
}

async function handleScenarioRm(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioRmRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  // Collect filenames to delete from VDB (single file or all files under a directory)
  let removedFilenames: string[] = [];
  if (path.endsWith("/")) {
    try {
      const names = await storage.readdirNames(key, ".md");
      removedFilenames = names.map((name) => `${path}${name}`);
    } catch { /* ignore */ }
    await storage.rmdir(key);
  } else {
    removedFilenames = [path];
    await storage.unlink(key);
  }

  // Delete L2 profiles from VDB (best-effort)
  const store = deps.getStore();
  await deleteProfilesFromVdb(store, "l2", removedFilenames, deps.logger, deps.requestIsolation);
  await refreshSceneIndex(storage, deps.logger);

  // 审计：L2 delete — 每个被删的 path 一行
  for (const fname of removedFilenames) {
    await recordAudit(store, {
      record_id: fname,
      layer: "L2",
      action: "delete",
      iso: deps.requestIsolation,
      version: 0,
      requestId,
      logger: deps.logger,
    });
  }

  return successEnvelope(undefined, requestId);
}

// ============================
// L3 Core Handlers
// ============================

async function handleCoreRead(_body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  deps.logger.debug?.(`${TAG} [core/read] storage.type=${storage.type}, key="${StoragePaths.persona}"`);
  const content = await storage.readFile(StoragePaths.persona);
  deps.logger.debug?.(`${TAG} [core/read] readFile result: ${content === null ? "null (not found)" : `${content.length} chars`}`);

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<CoreFile>({
      content: null as unknown as string,
      created_at: null as unknown as string,
      updated_at: null as unknown as string,
    }, requestId);
  }

  const stat = await storage.stat(StoragePaths.persona);
  const now = new Date().toISOString();

  return successEnvelope<CoreFile>({
    content,
    version: await getProfileVersion(deps.getStore(), "l3", StoragePaths.persona, deps.requestIsolation),
    team_id: deps.requestIsolation?.teamId,
    agent_id: deps.requestIsolation?.agentId,
    created_at: stat ? new Date(stat.createdAt).toISOString() : now,
    updated_at: stat ? new Date(stat.lastModified).toISOString() : now,
  }, requestId);
}

async function handleCoreCount(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = coreCountRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const store = deps.getStore();
  if (typeof store?.countProfiles === "function") {
    const total = await store.countProfiles({
      type: "l3",
      teamId: deps.requestIsolation?.teamId,
      userId: deps.requestIsolation?.teamId ? undefined : deps.requestIsolation?.userId,
      agentId: deps.requestIsolation?.agentId,
    });
    return successEnvelope<CountData>({ total }, requestId);
  }

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);
  const content = await storage.readFile(StoragePaths.persona);
  return successEnvelope<CountData>({ total: content ? 1 : 0 }, requestId);
}

async function handleCoreWrite(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = coreWriteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { content } = parsed.data;

  const baseStorage = deps.getStorage();
  if (!baseStorage) return errorEnvelope(503, "Storage not available", requestId);
  const storage = scopedProfileStorage(baseStorage, deps.requestIsolation);

  // I-2（P2-T11+13 复核修补）：落盘前对 content 调 escapeXmlTags（写入路径单点消毒，
  // 所有读端天然安全）。
  // L3 persona 注入边界 `<l3_core_memory>` / `<agent …>` 已在 escape 名单，
  // 毒化内容无法越块逃逸进 system 注入区。
  // Normalize before persistence: persona body must NOT contain Scene Navigation
  // (a derived section rebuilt from scene_index.json) or stray surrounding
  // whitespace. Both COS and VDB get the *exact* same bytes so md5(content) is
  // a stable identity across stores. Without this, /v2/core/write callers that
  // post the raw round-tripped body (which includes the navigation footer and
  // a trailing newline appended by refreshPersonaNavigation) would write a
  // mismatched copy to each store, and pullProfilesToLocal would later treat
  // the persona as corrupted and delete the COS copy.
  const personaBody = escapeXmlTags(stripSceneNavigation(content).trim());

  await storage.writeFile(StoragePaths.persona, personaBody);

  // Sync L3 persona to VDB profiles (best-effort)
  const store = deps.getStore();
  const version = await syncProfileToVdb(store, "l3", StoragePaths.persona, personaBody, deps.logger, undefined, deps.requestIsolation);

  // 审计：L3 update — record_id 用 persona 的 storage path
  await recordAudit(store, {
    record_id: StoragePaths.persona,
    layer: "L3",
    action: "update",
    iso: deps.requestIsolation,
    version,
    requestId,
    logger: deps.logger,
  });

  return successEnvelope<CoreWriteData>({
    updated_at: new Date().toISOString(),
    version,
    team_id: deps.requestIsolation?.teamId,
    agent_id: deps.requestIsolation?.agentId,
  }, requestId);
}

// ============================
// Helpers
// ============================

/**
 * Format a Date as YYYY-MM-DD in local timezone, matching the convention used by
 * v1 l0-recorder and l1-writer for daily JSONL shard names. Local copy to keep
 * v2-router self-contained (avoids exporting a util just for one call site).
 */
function formatLocalDateForJsonl(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ============================
// Exported for testing
// ============================

export {
  handleConversationAdd,
  handleConversationQuery,
  handleConversationSearch,
  handleConversationDelete,
  handleConversationCount,
  handleAtomicUpdate,
  handleAtomicQuery,
  handleAtomicSearch,
  handleAtomicNeighbors,
  handleAtomicDelete,
  handleAtomicCount,
  // 核心记忆唯一对外面：只读 handler（Panel 的 core-memory 只读视图消费；写入口已退役）
  handleCoreMemoryRead,
  // 2026-11-07（task-20）：core-memory 写 handler 导出已删（写路由退役，原 handler 位置留有墓碑说明）。
  // 2026-11-07（T1）：core_values 写 API handler 已删（见文件头注释），读面 handleCoreMemoryRead 保留。
  handleScenarioLs,
  handleScenarioRead,
  handleScenarioWrite,
  handleScenarioRm,
  handleScenarioCount,
  handleCoreRead,
  handleCoreWrite,
  handleCoreCount,
};
