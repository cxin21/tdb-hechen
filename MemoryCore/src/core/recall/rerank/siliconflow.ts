/**
 * P1 召回质量（spec §4.2，task-1）：siliconflow rerank adapter（M1 首发）。
 * schema 已对官方文档核实（Cohere/Jina 兼容）：
 * POST {baseUrl}/v1/rerank，body {model, query, documents, top_n}
 * → {results: [{index, relevance_score}]}（按 relevance_score 降序）。
 * 默认模型 Qwen/Qwen3-Reranker-0.6B（spec §4.2 缺省推荐档）；默认端点
 * https://api.siliconflow.cn。失败合同见 ./http.ts：一律 null，单次尝试。
 */
import { normalizeRerankResults, postJsonWithTimeout } from "./http.js";
import type { CloudRerankerOptions, MemoryReranker, RerankResult } from "./types.js";

export const DEFAULT_SILICONFLOW_RERANK_BASE_URL = "https://api.siliconflow.cn";
export const DEFAULT_SILICONFLOW_RERANK_MODEL = "Qwen/Qwen3-Reranker-0.6B";
const DEFAULT_TIMEOUT_MS = 800;

export class SiliconflowReranker implements MemoryReranker {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudRerankerOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_SILICONFLOW_RERANK_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model || DEFAULT_SILICONFLOW_RERANK_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async rerank(query: string, docs: string[]): Promise<RerankResult[] | null> {
    if (docs.length === 0) return [];
    const raw = await postJsonWithTimeout(
      `${this.baseUrl}/v1/rerank`,
      { model: this.model, query, documents: docs, top_n: docs.length },
      { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      this.timeoutMs,
      this.fetchImpl,
    );
    if (raw === null) return null;
    const results = (raw as { results?: unknown }).results;
    return normalizeRerankResults(results, docs.length);
  }
}
