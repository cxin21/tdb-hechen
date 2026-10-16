/**
 * KS → core /v1/rerank 薄客户端（wiki 召回重排 R1，2026-10-16）。
 *
 * 背景：内部 MaaS 无 rerank 能力（/v1/rerank → 503 实测）；云端 provider 需外部
 * 网络/key；KS 独立打包不得源码依赖 MemoryCore。故 core 网关以 HTTP 暴露 rerank
 * 资源（Bearer 门禁），KS 侧用本薄客户端调用——单模型实例、无源码依赖、
 * provider 演进（siliconflow/dashscope/local）由 core 侧配置决定。
 *
 * 线协议（与 core src/gateway/rerank-endpoint.ts 同形）：
 *   请求  POST {url}  {"query": string, "documents": string[]}
 *         headers: Content-Type: application/json [+ Authorization: Bearer <key>]
 *   200   {"results":[{"index":number,"score":number},...]}  —— score 降序，index=documents 下标
 *   4xx/5xx/超时/形状错 → null（调用方降级原序，绝不阻断检索）
 */
export interface RerankScore {
  index: number;
  score: number;
}

/** KS 侧 reranker 最小契约（结构与 MemoryCore MemoryReranker 同形，无源码依赖）。 */
export interface WikiReranker {
  rerank(query: string, docs: string[]): Promise<RerankScore[] | null>;
}

export interface HttpRerankerOptions {
  /** core 网关 rerank 端点完整 URL（如 http://127.0.0.1:8420/v1/rerank）。 */
  url: string;
  /** Bearer token（core 侧 TDAI_GATEWAY_APIKEY）。缺省不带 Authorization 头。 */
  apiKey?: string;
  /** 单次调用超时毫秒（缺省 800，与 MemoryCore 云端 rerank adapter 同默认）。 */
  timeoutMs?: number;
  /** fetch 注入（测试用）；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 防御性整形（与 core normalizeRerankResults 同语义）：非法下标/非有限分剔除、
 * 重复 index 首见保留、按 score 降序。manager 注入缝与 HTTP client 共用。
 */
export function normalizeRerankResults(
  raw: RerankScore[] | null | undefined,
  docCount: number,
): RerankScore[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: RerankScore[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { index, score } = r as { index?: unknown; score?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 0 || index >= docCount) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    out.push({ index, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function createHttpReranker(opts: HttpRerankerOptions): WikiReranker {
  const url = opts.url;
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 800;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async rerank(query: string, docs: string[]): Promise<RerankScore[] | null> {
      if (!docs || docs.length === 0) return null;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, documents: docs }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return null; // 网络/超时 → 降级
      }
      if (!res.ok) return null;
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return null; // 非法 JSON → 降级
      }
      const results = (payload as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) return null; // 形状错 → 降级
      return normalizeRerankResults(results as RerankScore[], docs.length);
    },
  };
}
