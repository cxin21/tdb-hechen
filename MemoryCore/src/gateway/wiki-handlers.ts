/**
 * task-73（core wiki 薄转发）· /v3/wiki/{list,search}
 *
 * 为什么在 core 加这一层（不是让插件直连 8421）：
 *   1. 8421 的 /list 只按 **caller 自称的** team_id 过滤、/search 完全不校验 team
 *      （MemoryKnowledge/src/routes/wiki.ts:244-256 / :712-757）——team 归属校验只有
 *      core 能做（metadata 是唯一权威：meta_teams / meta_team_members）；
 *   2. core 知识注册表（/v3/knowledge/list）在实际部署里是漏的（现网只有 1 条），
 *      发现面必须打 8421 全量，失败再回落注册表；
 *   3. 一次检索要跨多个 wiki 并发 + 按 absScore 合并，插件侧重复实现会各自漂移。
 *
 * 语义要点：
 *   - 只读：两条路由都是 POST + 只读语义，无任何写/同步副作用。
 *   - 单 wiki 故障隔离：单个 wiki 超时/500 只进 meta.failed[]，请求整体仍 200。
 *   - 不可读的 wiki（镜像 8421 wikiCanServeReads）进 meta.skipped[]，不静默丢弃。
 *   - absScore 是唯一合并刻度：8421 的 score 是「每 wiki 归一」的，跨 wiki 不可比；
 *     实测两 wiki 的 score=0.6 但 absScore 分别为 1.31 / 0.42。阈值 minScore 也按 absScore 判。
 */
import { z } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { WikiForwardConfig } from "../config.js";
import { resolveWikiForwardConfig } from "./wiki-config.js";
import {
  WikiForwardClient,
  WikiUpstreamError,
  isWikiReadable,
  type WikiDiscoveryItem,
  type WikiFetchLike,
  type WikiSearchHit,
} from "./wiki-client.js";

const TAG = "[wiki-forward]";

// ── Request schemas ──

export const wikiListRequestSchema = z.object({
  team_id: z.string().min(1).max(128),
  /** 可选：给出后走「用户↔team 成员关系」校验（缺省时退化为 team 存在性校验）。 */
  user_id: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(16).optional(),
  offset: z.number().int().min(0).optional(),
});

export const wikiSearchRequestSchema = z.object({
  query: z.string().min(1).max(1024),
  team_id: z.string().min(1).max(128),
  /** 只检索这些 wiki（缺省=发现面全量中可读的）。上限 16 与 maxWikis 同刻度。 */
  wiki_ids: z.array(z.string().min(1)).max(16).optional(),
  top_k: z.number().int().min(1).max(20).optional(),
  per_wiki_limit: z.number().int().min(1).max(20).optional(),
  min_score: z.number().min(0).max(10).optional(),
  user_id: z.string().min(1).max(128).optional(),
});

// ── Deps / factory options ──

type LoggerLike = {
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
};

/** metadata 服务的最小结构（只用到这两个只读方法，避免把整个 MetadataService 拖进类型面）。 */
type MetadataLookupLike = {
  listTeamsByUser?: (userId: string) => Promise<{ items?: Array<{ team_id?: string }> } | unknown> | unknown;
  getTeamById?: (teamId: string) => Promise<unknown | null> | unknown | null;
};

type EntityStoreLike = {
  listKnowledge?: (input: { team_id: string; type?: "wiki" | "code-graph"; limit?: number; offset?: number }) =>
    | { items?: unknown[]; total?: number }
    | Promise<{ items?: unknown[]; total?: number }>;
};

/** v2-router 把 deps 原样转发；wiki 只读这几个字段。 */
export interface WikiRouterDeps {
  logger?: LoggerLike;
  getStore?: () => unknown;
  getMetadataService?: (instanceId: string) => Promise<MetadataLookupLike | undefined>;
  /** 本次请求的入站头（server.ts 在构造 extraRoutes 时注入，用于团队/用户佐证）。 */
  wikiHeaders?: Record<string, string | string[] | undefined>;
}

export interface WikiRouteTableOptions {
  /** 每次请求现取配置（yaml 热改/override 生效后不必重启）。 */
  getConfig?: () => Partial<WikiForwardConfig> | undefined;
  /** 测试注入点；生产走全局 fetch。 */
  fetchImpl?: WikiFetchLike;
  /** 测试注入点：时间源（deadline 计算）。 */
  now?: () => number;
}

export type WikiRouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

// ── Response shapes ──

export interface WikiListItem {
  wikiId: string;
  name: string;
  serviceUrl: string;
  pageCount: number | null;
  status: string;
  internalStatus: string | null;
  ready: boolean;
  lastSyncAt: string | null;
  syncError: string | null;
  sourceType: string | null;
  summary: string | null;
}

export interface WikiListData {
  serviceId: string;
  teamId: string;
  total: number;
  wikis: WikiListItem[];
  meta: {
    source: "knowledge" | "core_registry";
    tookMs: number;
    failed: Array<{ stage: string; error: string }>;
    skipped: Array<{ wikiId: string; reason: string }>;
  };
}

export interface WikiSearchData {
  query: string;
  results: WikiSearchHit[];
  meta: {
    serviceId: string;
    teamId: string;
    wikisConsidered: number;
    wikisQueried: number;
    wikisFailed: number;
    failed: Array<{ wikiId: string; name: string; error: string }>;
    skipped: Array<{ wikiId: string; reason: string }>;
    topK: number;
    perWikiLimit: number;
    minScore: number;
    tookMs: number;
    deadlineHit: boolean;
  };
}

// ── Team 归属校验 ──

type TeamVerdict = "ok" | "forbidden" | "unknown" | "unavailable" | "no_identity";

const warnedOnce = new Set<string>();
const WARN_ONCE_LIMIT = 256;

/** WARN-once（同 (mode,team,user) 只记一次），避免灰度期日志被刷爆。 */
function warnOnce(logger: LoggerLike | undefined, key: string, msg: string): void {
  if (warnedOnce.has(key)) return;
  if (warnedOnce.size >= WARN_ONCE_LIMIT) warnedOnce.clear();
  warnedOnce.add(key);
  logger?.warn?.(msg);
}

/** 测试用：清掉 warn-once 状态。 */
export function __resetWikiWarnOnceForTests(): void {
  warnedOnce.clear();
}

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function verifyTeam(args: {
  mode: WikiForwardConfig["teamVerify"];
  teamId: string;
  userId?: string;
  deps: WikiRouterDeps;
  serviceId: string;
  logger?: LoggerLike;
}): Promise<{ verdict: TeamVerdict; detail?: string }> {
  const { mode, teamId, userId, deps, serviceId, logger } = args;
  if (mode === "off") return { verdict: "ok" };

  const failOpen = (verdict: TeamVerdict, detail: string): { verdict: TeamVerdict; detail: string } => {
    warnOnce(
      logger,
      `${mode}:${teamId}:${userId ?? "-"}:${verdict}`,
      `${TAG} team verify ${verdict} (mode=${mode}, team=${teamId}, user=${userId ?? "<none>"}): ${detail} — fail-open`,
    );
    return { verdict, detail };
  };

  let svc: MetadataLookupLike | undefined;
  try {
    svc = await deps.getMetadataService?.(serviceId);
  } catch (err) {
    return failOpen("unavailable", `metadata service error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!svc) return failOpen("unavailable", "metadata service not configured");

  if (userId) {
    if (typeof svc.listTeamsByUser !== "function") return failOpen("unavailable", "metadata service lacks listTeamsByUser");
    let teams: Array<{ team_id?: string }> = [];
    try {
      const res = (await svc.listTeamsByUser(userId)) as { items?: Array<{ team_id?: string }> } | undefined;
      teams = Array.isArray(res?.items) ? res!.items! : [];
    } catch (err) {
      return failOpen("unavailable", `listTeamsByUser error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 空集合 = 该用户在 metadata 里没登记（新用户/空库）→ 不能当成"不属于"，否则误杀。
    if (teams.length === 0) return failOpen("unknown", "user has no team membership rows");
    const ok = teams.some((t) => t?.team_id === teamId);
    return ok ? { verdict: "ok" } : { verdict: "forbidden", detail: `user ${userId} is not a member of team ${teamId}` };
  }

  // 无 user 上下文（服务端调用）：只判 lower bound —— team 是否在 metadata 里存在。
  if (typeof svc.getTeamById !== "function") return failOpen("no_identity", "no user_id and metadata lacks getTeamById");
  try {
    const team = await svc.getTeamById(teamId);
    if (team) return { verdict: "ok" };
    return failOpen("unknown", `team ${teamId} not found in metadata`);
  } catch (err) {
    return failOpen("unavailable", `getTeamById error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 工具 ──

function toListItem(w: WikiDiscoveryItem): WikiListItem {
  return {
    wikiId: w.wikiId,
    name: w.name,
    serviceUrl: w.serviceUrl,
    pageCount: w.pageCount,
    status: w.status,
    internalStatus: w.internalStatus,
    ready: w.ready,
    lastSyncAt: w.lastSyncAt,
    syncError: w.syncError,
    sourceType: w.sourceType,
    summary: w.summary,
  };
}

function toDiscoveryFromRegistry(raw: unknown): WikiDiscoveryItem | null {
  const r = raw as { knowledge_id?: unknown; name?: unknown; service_url?: unknown; summary?: unknown };
  const id = typeof r?.knowledge_id === "string" ? r.knowledge_id : null;
  if (!id) return null;
  return {
    wikiId: id,
    name: typeof r.name === "string" && r.name ? r.name : id,
    serviceUrl: typeof r.service_url === "string" ? r.service_url : "",
    pageCount: null,
    // 注册表没有同步状态：按「未知」处理，但不因未知就判死——有 service_url 就值得打一发。
    status: "unknown",
    internalStatus: null,
    lastSyncAt: null,
    syncError: null,
    sourceType: "registry",
    summary: typeof r.summary === "string" ? r.summary : null,
    ready: true,
  };
}

async function discover(args: {
  deps: WikiRouterDeps;
  cfg: WikiForwardConfig;
  client: WikiForwardClient;
  teamId: string;
  limit: number;
  deadlineMs: number;
  serviceId: string;
}): Promise<{
  items: WikiDiscoveryItem[];
  total: number;
  source: "knowledge" | "core_registry";
  failed: Array<{ stage: string; error: string }>;
}> {
  const { deps, client, teamId, limit, deadlineMs } = args;
  try {
    const res = await client.list(teamId, { limit, timeoutMs: Math.max(100, deadlineMs) });
    return { items: res.items, total: res.total, source: "knowledge", failed: [] };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.(`${TAG} discovery via 8421 failed (team=${teamId}): ${detail} — falling back to core knowledge registry`);
    const failed = [{ stage: "discovery", error: detail }];
    // 回落：core 注册表（可能为空 —— 现网只有 1 条，所以这不是主路径）
    const store = deps.getStore?.() as EntityStoreLike | undefined;
    if (!store?.listKnowledge) return { items: [], total: 0, source: "core_registry", failed };
    try {
      const res = await store.listKnowledge({ team_id: teamId, type: "wiki", limit, offset: 0 });
      const items = (res?.items ?? [])
        .map(toDiscoveryFromRegistry)
        .filter((w): w is WikiDiscoveryItem => w !== null);
      return { items, total: typeof res?.total === "number" ? res.total : items.length, source: "core_registry", failed };
    } catch (err2) {
      failed.push({ stage: "discovery_registry", error: err2 instanceof Error ? err2.message : String(err2) });
      return { items: [], total: 0, source: "core_registry", failed };
    }
  }
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function mergeHits(hits: WikiSearchHit[], minScore: number, topK: number): WikiSearchHit[] {
  const byKey = new Map<string, WikiSearchHit>();
  for (const h of hits) {
    if (!Number.isFinite(h.absScore) || h.absScore < minScore) continue;
    const key = `${h.wikiId}\u0000${h.path}`;
    const prev = byKey.get(key);
    if (!prev || h.absScore > prev.absScore) byKey.set(key, h);
  }
  return [...byKey.values()]
    .sort((a, b) => (b.absScore - a.absScore) || (b.score - a.score) || a.path.localeCompare(b.path))
    .slice(0, topK);
}

// ── Handlers ──

function disabledEnvelope(cfg: WikiForwardConfig, requestId: string): ApiResponseEnvelope {
  return errorEnvelope(403, "wiki forwarding disabled (memory.wiki.enabled=false)", requestId, {
    code: "WIKI_FORWARDING_DISABLED",
    enabled: cfg.enabled,
  });
}

function forbiddenEnvelope(verdict: TeamVerdict, detail: string | undefined, cfg: WikiForwardConfig, teamId: string, requestId: string): ApiResponseEnvelope {
  return errorEnvelope(403, `team ownership check failed: ${detail ?? verdict}`, requestId, {
    code: "WIKI_TEAM_FORBIDDEN",
    verdict,
    team_id: teamId,
    mode: cfg.teamVerify,
  });
}

/** 统一入口：解析配置 + team 校验；返回 null 表示已可继续。 */
async function preflight(args: {
  body: { team_id: string; user_id?: string };
  auth: V2AuthContext;
  requestId: string;
  depsRaw: unknown;
  opts: WikiRouteTableOptions;
  cfg: WikiForwardConfig;
}): Promise<{ deps: WikiRouterDeps; client: WikiForwardClient; teamId: string; userId?: string; error: ApiResponseEnvelope | null }> {
  const deps = (args.depsRaw ?? {}) as WikiRouterDeps;
  const cfg = args.cfg;
  const teamId = args.body.team_id;
  const headerTeam = headerValue(deps.wikiHeaders, "x-tdai-team-id");
  const userId = args.body.user_id ?? headerValue(deps.wikiHeaders, "x-tdai-user-id");
  const client = new WikiForwardClient({ baseUrl: cfg.baseUrl, serviceId: cfg.serviceId, fetchImpl: args.opts.fetchImpl });

  if (headerTeam && headerTeam !== teamId) {
    return {
      deps, client, teamId, userId,
      error: errorEnvelope(400, `team_id mismatch: body=${teamId} header=${headerTeam}`, args.requestId, {
        code: "WIKI_TEAM_MISMATCH",
      }),
    };
  }

  const check = await verifyTeam({
    mode: cfg.teamVerify, teamId, userId, deps, serviceId: args.auth.serviceId, logger: deps.logger,
  });
  if (check.verdict === "forbidden") {
    if (cfg.teamVerify === "enforce") {
      return { deps, client, teamId, userId, error: forbiddenEnvelope(check.verdict, check.detail, cfg, teamId, args.requestId) };
    }
    // warn 档：灰度期只记一次，照常放行（便于先收计数、再切 enforce）。
    warnOnce(
      deps.logger,
      `${cfg.teamVerify}:${teamId}:${userId ?? "-"}:forbidden`,
      `${TAG} team verify forbidden (mode=${cfg.teamVerify}, team=${teamId}, user=${userId ?? "<none>"}): ${check.detail ?? "not a member"} — fail-open (warn-only)`,
    );
  }
  return { deps, client, teamId, userId, error: null };
}

async function handleWikiList(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  depsRaw: unknown,
  opts: WikiRouteTableOptions,
): Promise<ApiResponseEnvelope> {
  const cfg = resolveWikiForwardConfig(opts.getConfig?.());
  if (!cfg.enabled) return disabledEnvelope(cfg, requestId);

  const parsed = wikiListRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), requestId);
  }
  const pre = await preflight({ body: parsed.data, auth, requestId, depsRaw, opts, cfg });
  if (pre.error) return pre.error;

  const started = (opts.now ?? Date.now)();
  const res = await discover({
    deps: pre.deps,
    cfg,
    client: pre.client,
    teamId: pre.teamId,
    limit: parsed.data.limit ?? cfg.maxWikis,
    deadlineMs: cfg.timeoutMs,
    serviceId: auth.serviceId,
  });
  const data: WikiListData = {
    serviceId: cfg.serviceId,
    teamId: pre.teamId,
    total: res.total,
    wikis: res.items.map(toListItem),
    meta: { source: res.source, tookMs: Math.max(0, (opts.now ?? Date.now)() - started), failed: res.failed, skipped: [] },
  };
  return successEnvelope<WikiListData>(data, requestId);
}

async function handleWikiSearch(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  depsRaw: unknown,
  opts: WikiRouteTableOptions,
): Promise<ApiResponseEnvelope> {
  const cfg = resolveWikiForwardConfig(opts.getConfig?.());
  if (!cfg.enabled) return disabledEnvelope(cfg, requestId);

  const parsed = wikiSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), requestId);
  }
  const pre = await preflight({ body: parsed.data, auth, requestId, depsRaw, opts, cfg });
  if (pre.error) return pre.error;

  const now = opts.now ?? Date.now;
  const started = now();
  const deadlineAt = started + cfg.timeoutMs;
  const topK = parsed.data.top_k ?? cfg.topK;
  const perWikiLimit = parsed.data.per_wiki_limit ?? cfg.perWikiLimit;
  const minScore = parsed.data.min_score ?? cfg.minScore;
  const wanted = parsed.data.wiki_ids ? new Set(parsed.data.wiki_ids) : null;

  const discovery = await discover({
    deps: pre.deps,
    cfg,
    client: pre.client,
    teamId: pre.teamId,
    limit: cfg.maxWikis,
    deadlineMs: Math.max(100, deadlineAt - now()),
    serviceId: auth.serviceId,
  });

  const skipped: Array<{ wikiId: string; reason: string }> = [];
  const candidates: WikiDiscoveryItem[] = [];
  for (const w of discovery.items) {
    if (wanted && !wanted.has(w.wikiId)) continue;
    if (candidates.length >= cfg.maxWikis) {
      skipped.push({ wikiId: w.wikiId, reason: "max_wikis" });
      continue;
    }
    if (!w.ready || !isWikiReadable(w.status, w.lastSyncAt)) {
      skipped.push({ wikiId: w.wikiId, reason: `not_readable(${w.status})` });
      continue;
    }
    candidates.push(w);
  }

  const failed: Array<{ wikiId: string; name: string; error: string }> = [];
  let deadlineHit = false;

  const perWiki: WikiSearchHit[][] = await runPool(candidates, cfg.concurrency, async (w) => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      deadlineHit = true;
      skipped.push({ wikiId: w.wikiId, reason: "deadline" });
      return [];
    }
    try {
      return await pre.client.search({
        wiki: w,
        query: parsed.data.query,
        limit: perWikiLimit,
        timeoutMs: Math.min(cfg.perWikiTimeoutMs, remaining),
      });
    } catch (err) {
      const detail = err instanceof WikiUpstreamError ? err.message : err instanceof Error ? err.message : String(err);
      failed.push({ wikiId: w.wikiId, name: w.name, error: detail });
      pre.deps.logger?.warn?.(`${TAG} search failed (wiki=${w.wikiId}): ${detail}`);
      return [];
    }
  });

  const results = mergeHits(perWiki.flat(), minScore, topK);
  const data: WikiSearchData = {
    query: parsed.data.query,
    results,
    meta: {
      serviceId: cfg.serviceId,
      teamId: pre.teamId,
      wikisConsidered: discovery.items.length,
      wikisQueried: candidates.length,
      wikisFailed: failed.length,
      failed: [...failed, ...discovery.failed.map((f) => ({ wikiId: "*", name: f.stage, error: f.error }))],
      skipped,
      topK,
      perWikiLimit,
      minScore,
      tookMs: Math.max(0, now() - started),
      deadlineHit,
    },
  };
  return successEnvelope<WikiSearchData>(data, requestId);
}

/**
 * /v3/wiki/{list,search} 路由表。
 * 注意：调用方必须在 v2-router 的 isV3Extra 前缀白名单里登记 /v3/wiki/，
 * 否则会被 L0–L3 封闭清单拦成 404（见 v2-router.ts isV3Extra）。
 */
export function makeWikiRouteTable(opts: WikiRouteTableOptions = {}): Record<string, WikiRouteHandler> {
  return {
    "/v3/wiki/list": (body, auth, requestId, deps) => handleWikiList(body, auth, requestId, deps, opts),
    "/v3/wiki/search": (body, auth, requestId, deps) => handleWikiSearch(body, auth, requestId, deps, opts),
  };
}
