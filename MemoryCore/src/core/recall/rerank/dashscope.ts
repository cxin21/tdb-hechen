/**
 * P1 召回质量（spec §4.2，task-1）：dashscope rerank adapter。
 * schema 已对官网核实（help.aliyun.com/zh/model-studio/text-rerank-api，2026-10-13 抓取）：
 * POST {baseUrl}/api/v1/services/rerank/text-rerank/text-rerank
 * body {model, input:{query, documents}, parameters:{top_n, return_documents}}
 * → {output:{results:[{index, relevance_score}]}}（按 relevance_score 降序）。
 * 默认端点 https://dashscope.aliyuncs.com（经典 DashScope 域；业务空间专属域
 * {WorkspaceId}.cn-beijing.maas.aliyuncs.com 经 baseUrl 显式覆盖）。
 * 默认模型 qwen3-rerank——gte-rerank v1 2026-05-30 下线（官网公告），不得选。
 * 失败合同见 ./http.ts：一律 null，单次尝试；HTTP 200 错误信封（code/message 无
 * output）同走"results 缺失 → null"路径。
 */
import { normalizeRerankResults, postJsonWithTimeout } from "./http.js";
import type { CloudRerankerOptions, MemoryReranker, RerankResult } from "./types.js";

export const DEFAULT_DASHSCOPE_RERANK_BASE_URL = "https://dashscope.aliyuncs.com";
export const DEFAULT_DASHSCOPE_RERANK_MODEL = "qwen3-rerank";
const DEFAULT_TIMEOUT_MS = 800;

export class DashscopeReranker implements MemoryReranker {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudRerankerOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_DASHSCOPE_RERANK_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model || DEFAULT_DASHSCOPE_RERANK_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async rerank(query: string, docs: string[]): Promise<RerankResult[] | null> {
    if (docs.length === 0) return [];
    const raw = await postJsonWithTimeout(
      `${this.baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`,
      {
        model: this.model,
        input: { query, documents: docs },
        parameters: { top_n: docs.length, return_documents: false },
      },
      { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      this.timeoutMs,
      this.fetchImpl,
    );
    if (raw === null) return null;
    const results = (raw as { output?: { results?: unknown } }).output?.results;
    return normalizeRerankResults(results, docs.length);
  }
}
