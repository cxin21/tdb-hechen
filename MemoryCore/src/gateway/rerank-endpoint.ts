/**
 * POST /v1/rerank —— 网关精排资源端点（additive，S2S）。
 *
 * 背景（2026-10-16 wiki 召回重排 R1 定案）：wiki 侧 KS 无 rerank 能力；内部 MaaS
 * 无 /v1/rerank（503 实测）；云端 provider 需外部网络/key。core 进程已载
 * MemoryCore + local reranker 单例池（auto-recall 同源配置），故由 core 以 HTTP
 * 暴露 rerank 资源，KS 侧薄客户端调用——单模型实例、无源码依赖、provider 演进
 * 与 KS 解耦（core 侧配置决定 siliconflow/dashscope/local）。
 *
 * 线协议与云端 rerank adapter（dashscope.ts/siliconflow.ts）同形：
 *   请求  { query: string, documents: string[], top_n?: number }
 *   200   { results: [{ index, score }] }   —— score 降序；index=入参 documents 原始下标
 *   400   { code: 400, message }            —— 请求体校验失败
 *   503   { code: 503, message }            —— rerank 不可用（未配置 / 降级 null / 调用失败 / 超时）
 *
 * 核心逻辑在 handleRerankCore（纯函数，HTTP 无关，可测）；
 * handleRerankRoute 是 server.ts dispatch 用的薄适配（与 handleV3MetaRoute 同构）。
 */
import type * as http from "node:http";
import type { MemoryReranker } from "../core/recall/rerank/types.js";

/** 请求限额（防本地模型被超大 batch 打爆；召回场景 candidates≈12，64 留足余量）。 */
export const RERANK_LIMITS = {
  maxQueryChars: 2000,
  maxDocs: 64,
  maxDocChars: 20000,
  /** 外层兜底超时毫秒（provider 内部已有各自超时；此层防无内建超时的注入实现悬挂）。 */
  defaultTimeoutMs: 30000,
} as const;

export type RerankCoreResult =
  | { status: 200; payload: { results: { index: number; score: number }[] } }
  | { status: 400 | 503; payload: { code: number; message: string } };

export interface RerankCoreDeps {
  /** 返回 undefined/null = 未配置或不可用 → 503。 */
  getReranker: () => MemoryReranker | null | undefined;
  timeoutMs?: number;
}

/** 防御性整形（与 applyRecallRerank 同语义）：合法下标保留、重复首见保留、score 降序。 */
export function normalizeRerankResults(
  raw: { index: number; score: number }[] | null | undefined,
  docCount: number,
): { index: number; score: number }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: { index: number; score: number }[] = [];
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

export async function handleRerankCore(body: unknown, deps: RerankCoreDeps): Promise<RerankCoreResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, payload: { code: 400, message: "request body must be a JSON object" } };
  }
  const b = body as Record<string, unknown>;
  const query = b.query;
  if (typeof query !== "string" || query.length === 0) {
    return { status: 400, payload: { code: 400, message: "field 'query' must be a non-empty string" } };
  }
  if (query.length > RERANK_LIMITS.maxQueryChars) {
    return {
      status: 400,
      payload: { code: 400, message: `field 'query' exceeds ${RERANK_LIMITS.maxQueryChars} chars` },
    };
  }
  const documents = b.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    return { status: 400, payload: { code: 400, message: "field 'documents' must be a non-empty array of strings" } };
  }
  if (documents.length > RERANK_LIMITS.maxDocs) {
    return {
      status: 400,
      payload: { code: 400, message: `field 'documents' exceeds ${RERANK_LIMITS.maxDocs} items` },
    };
  }
  for (const d of documents) {
    if (typeof d !== "string") {
      return { status: 400, payload: { code: 400, message: "field 'documents' must contain only strings" } };
    }
    if (d.length > RERANK_LIMITS.maxDocChars) {
      return {
        status: 400,
        payload: { code: 400, message: `each document must be <= ${RERANK_LIMITS.maxDocChars} chars` },
      };
    }
  }
  let topN: number | undefined;
  if (b.top_n !== undefined && b.top_n !== null) {
    if (typeof b.top_n !== "number" || !Number.isInteger(b.top_n) || b.top_n < 1) {
      return { status: 400, payload: { code: 400, message: "field 'top_n' must be a positive integer" } };
    }
    topN = Math.min(b.top_n, documents.length);
  }

  const reranker = deps.getReranker();
  if (!reranker || typeof reranker.rerank !== "function") {
    return { status: 503, payload: { code: 503, message: "rerank_unavailable" } };
  }

  const timeoutMs = typeof deps.timeoutMs === "number" && deps.timeoutMs > 0 ? deps.timeoutMs : RERANK_LIMITS.defaultTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const scored = await Promise.race([
      reranker.rerank(query, documents as string[]),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (scored === null) {
      return { status: 503, payload: { code: 503, message: "rerank_unavailable" } };
    }
    const results = normalizeRerankResults(scored, documents.length);
    return { status: 200, payload: { results: topN !== undefined ? results.slice(0, topN) : results } };
  } catch {
    return { status: 503, payload: { code: 503, message: "rerank_failed" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── HTTP 薄适配（server.ts dispatch 用；与 handleV3MetaRoute 同构） ── */

export interface RerankRouteDeps {
  getReranker: () => MemoryReranker | null | undefined;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}

/**
 * 处理 POST /v1/rerank。命中并处理完毕返回 true；路径/方法不匹配返回 false
 * （由调用方继续后续 dispatch）。Bearer 鉴权由 server.ts dispatch 层先行
 * （与 /v2/instance/destroy 同级 v1 门禁），本函数不做鉴权。
 */
export async function handleRerankRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: (req: http.IncomingMessage, limitBytes?: number) => Promise<unknown>,
  sendJson: (res: http.ServerResponse, status: number, payload: unknown) => void,
  deps: RerankRouteDeps,
): Promise<boolean> {
  if (method !== "POST" || pathname !== "/v1/rerank") return false;
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, { code: 400, message: "invalid JSON body" });
    return true;
  }
  const result = await handleRerankCore(body, { getReranker: deps.getReranker });
  if (result.status >= 500 && "message" in result.payload) {
    deps.logger?.warn?.(`[rerank-endpoint] ${result.status} ${result.payload.message}`);
  }
  sendJson(res, result.status, result.payload);
  return true;
}
