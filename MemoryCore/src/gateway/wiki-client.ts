/**
 * task-73（core wiki 薄转发）· MemoryKnowledge（8421）客户端
 *
 * 只做「发现 + 检索」两条只读调用，不写、不同步、不留状态：
 *   POST {baseUrl}/v3/wiki/list    body {team_id, limit, offset}   → {items,total}
 *   POST {serviceUrl}/wiki/search  body {wiki_id, query, limit}    → {results,links,count}
 *
 * service_url 的形态由 8421 自己写库（实测 "http://127.0.0.1:8421/v3"，见
 * MemoryKnowledge/src/routes/wiki.ts:38 注释「should already include the API prefix」），
 * 因此这里按「已含 /v3」与「未含」两态拼 URL，避免出现 /v3/v3/wiki/search。
 *
 * 错误语义：**一次失败只影响一个 wiki**。客户端只抛 WikiUpstreamError（带 stage / status /
 * wikiId），由 handler 汇成 meta.failed[]，绝不把单 wiki 故障升级成整个请求 5xx。
 */
import { createHash } from "node:crypto";

/** 8421 的 WikiDetail（只取 core 需要的字段，其余保留在 raw 里备查）。 */
export interface WikiDiscoveryItem {
  wikiId: string;
  name: string;
  serviceUrl: string;
  pageCount: number | null;
  status: string;
  internalStatus: string | null;
  lastSyncAt: string | null;
  syncError: string | null;
  sourceType: string | null;
  summary: string | null;
  /** 镜像 8421 wikiCanServeReads（MemoryKnowledge/src/store/wiki-service.ts:229-234）。 */
  ready: boolean;
}

export interface WikiSearchHit {
  wikiId: string;
  wikiName: string;
  path: string;
  title: string;
  snippet: string | null;
  type: string | null;
  /** 8421 的原始分（0..1 的归一值）。 */
  score: number;
  /** 跨 wiki 唯一可比刻度（8421 absScore = score × 语料权重）；合并/阈值只用它。 */
  absScore: number;
  hop: number | null;
}

export type WikiUpstreamStage = "discovery" | "search";

export class WikiUpstreamError extends Error {
  readonly stage: WikiUpstreamStage;
  readonly status: number | null;
  readonly wikiId: string | null;
  readonly detail: string | null;

  constructor(
    stage: WikiUpstreamStage,
    message: string,
    opts: { status?: number | null; wikiId?: string | null; detail?: string | null } = {},
  ) {
    super(message);
    this.name = "WikiUpstreamError";
    this.stage = stage;
    this.status = opts.status ?? null;
    this.wikiId = opts.wikiId ?? null;
    this.detail = opts.detail ?? null;
  }
}

/** 结构化的最小 fetch 形状（既能吃全局 fetch，也能吃测试替身）。 */
export interface WikiFetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type WikiFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<WikiFetchResponseLike>;

export interface WikiClientOptions {
  baseUrl: string;
  serviceId: string;
  fetchImpl?: WikiFetchLike;
  /** 请求去重的稳定 id（仅用于 8421 侧日志关联；缺省本地生成）。 */
  requestId?: string;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** 8421 检索面 URL：service_url 已含 /v3 → 只加 /wiki/search；否则补 /v3/wiki/search。 */
export function buildWikiSearchUrl(serviceUrl: string, baseUrl: string): string {
  const base = trimSlash(serviceUrl || baseUrl);
  if (!base) return "";
  return base.endsWith("/v3") || base.endsWith("/v3/") ? `${trimSlash(base)}/wiki/search` : `${base}/v3/wiki/search`;
}

export function buildWikiListUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/v3/wiki/list`;
}

/** 镜像 wikiCanServeReads：ready 可读；draft 必读不到；pending/processing/failed 看有无旧索引。 */
export function isWikiReadable(status: string | null | undefined, lastSyncAt: string | null | undefined): boolean {
  const s = status ?? "";
  if (s === "ready") return true;
  if (s === "draft") return false;
  return lastSyncAt != null;
}

interface RawWikiDetail {
  wiki_id?: unknown;
  name?: unknown;
  service_url?: unknown;
  page_count?: unknown;
  status?: unknown;
  internal_status?: unknown;
  last_sync_at?: unknown;
  sync_error?: unknown;
  source_type?: unknown;
  summary?: unknown;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function normalizeWiki(raw: RawWikiDetail): WikiDiscoveryItem | null {
  const wikiId = asString(raw.wiki_id);
  if (!wikiId) return null;
  const status = asString(raw.status) ?? "unknown";
  const lastSyncAt = asString(raw.last_sync_at);
  return {
    wikiId,
    name: asString(raw.name) ?? wikiId,
    serviceUrl: asString(raw.service_url) ?? "",
    pageCount: typeof raw.page_count === "number" ? raw.page_count : null,
    status,
    internalStatus: asString(raw.internal_status),
    lastSyncAt,
    syncError: asString(raw.sync_error),
    sourceType: asString(raw.source_type),
    summary: asString(raw.summary),
    ready: isWikiReadable(status, lastSyncAt),
  };
}

export class WikiForwardClient {
  private readonly baseUrl: string;
  private readonly serviceId: string;
  private readonly fetchImpl: WikiFetchLike;
  private readonly requestId: string;

  constructor(opts: WikiClientOptions) {
    this.baseUrl = trimSlash(opts.baseUrl);
    this.serviceId = opts.serviceId;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as WikiFetchLike);
    this.requestId =
      opts.requestId ?? createHash("sha1").update(String(process.hrtime.bigint())).digest("hex").slice(0, 12);
  }

  /** 发现面：按 team 拉全量 wiki（8421 侧按 caller 自称 team 过滤，team 归属由 handler 先校验）。 */
  async list(teamId: string, opts: { limit: number; offset?: number; timeoutMs: number; signal?: AbortSignal }): Promise<{
    items: WikiDiscoveryItem[];
    total: number;
  }> {
    const url = buildWikiListUrl(this.baseUrl);
    const data = await this.postJson(
      url,
      { team_id: teamId, limit: opts.limit, offset: opts.offset ?? 0 },
      { stage: "discovery", timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    const obj = (data ?? {}) as { items?: unknown; total?: unknown };
    const rawItems = Array.isArray(obj.items) ? (obj.items as RawWikiDetail[]) : [];
    const items = rawItems.map(normalizeWiki).filter((w): w is WikiDiscoveryItem => w !== null);
    const total = typeof obj.total === "number" ? obj.total : items.length;
    return { items, total };
  }

  /** 检索面：单 wiki 一次；失败由调用方记 meta.failed[]。 */
  async search(params: {
    wiki: Pick<WikiDiscoveryItem, "wikiId" | "name" | "serviceUrl">;
    query: string;
    limit: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<WikiSearchHit[]> {
    const url = buildWikiSearchUrl(params.wiki.serviceUrl, this.baseUrl);
    const data = await this.postJson(
      url,
      { wiki_id: params.wiki.wikiId, query: params.query, limit: params.limit },
      { stage: "search", timeoutMs: params.timeoutMs, signal: params.signal, wikiId: params.wiki.wikiId },
    );
    const obj = (data ?? {}) as { results?: unknown };
    const rawResults = Array.isArray(obj.results) ? (obj.results as Record<string, unknown>[]) : [];
    const hits: WikiSearchHit[] = [];
    for (const r of rawResults) {
      const path = asString(r.path);
      if (!path) continue;
      const score = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
      const absScoreRaw = typeof r.absScore === "number" && Number.isFinite(r.absScore) ? r.absScore : undefined;
      hits.push({
        wikiId: params.wiki.wikiId,
        wikiName: params.wiki.name,
        path,
        title: asString(r.title) ?? path,
        snippet: asString(r.snippet),
        type: asString(r.type),
        score,
        // 老版本 8421 无 absScore 时退化为 score，保持「同一刻度可比」的下界语义。
        absScore: absScoreRaw ?? score,
        hop: typeof r.hop === "number" ? r.hop : null,
      });
    }
    return hits;
  }

  private async postJson(
    url: string,
    body: Record<string, unknown>,
    opts: { stage: WikiUpstreamStage; timeoutMs: number; signal?: AbortSignal; wikiId?: string },
  ): Promise<unknown> {
    if (!url) {
      throw new WikiUpstreamError(opts.stage, "wiki upstream url is empty", { wikiId: opts.wikiId ?? null });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("wiki upstream timeout")), Math.max(1, opts.timeoutMs));
    const onOuterAbort = (): void => controller.abort(new Error("wiki request deadline"));
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tdai-service-id": this.serviceId,
          "x-request-id": this.requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new WikiUpstreamError(opts.stage, `wiki upstream HTTP ${resp.status}`, {
          status: resp.status,
          wikiId: opts.wikiId ?? null,
          detail: text.slice(0, 300),
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new WikiUpstreamError(opts.stage, "wiki upstream returned non-JSON body", {
          status: resp.status,
          wikiId: opts.wikiId ?? null,
          detail: text.slice(0, 300),
        });
      }
      const env = parsed as { code?: unknown; message?: unknown; data?: unknown };
      if (typeof env.code === "number" && env.code !== 0) {
        throw new WikiUpstreamError(
          opts.stage,
          `wiki upstream code=${env.code}: ${typeof env.message === "string" ? env.message : "unknown"}`,
          { status: resp.status, wikiId: opts.wikiId ?? null },
        );
      }
      return env.data;
    } catch (err) {
      if (err instanceof WikiUpstreamError) throw err;
      // 以 abort 信号为准（而不是异常 name）：真实 fetch 抛 AbortError，但测试替身/中间层
      // 可能抛普通 Error("aborted")——两者都是超时，报文必须一致。
      const aborted = controller.signal.aborted || (err as { name?: string } | null)?.name === "AbortError";
      throw new WikiUpstreamError(
        opts.stage,
        aborted ? `wiki upstream timeout after ${opts.timeoutMs}ms` : `wiki upstream error: ${(err as Error)?.message ?? String(err)}`,
        { wikiId: opts.wikiId ?? null },
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}
