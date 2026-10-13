/**
 * P1 召回质量（spec §4.2，task-1）：云端 rerank adapter 共享 HTTP/解析层。
 *
 * 失败合同：单次尝试（无重试——重试/熔断归 Task 2 接线层策略）；任何失败
 * （网络错误/超时 abort/非 2xx/JSON 解析失败）→ null，绝不向调用方抛异常。
 * 超时：AbortController + setTimeout（沿 embedding.ts _callApi 先例），finally 清定时器。
 * 结果解析防御式：results 非数组 → null；单条 index/score 非法 → 丢弃该条；
 * 非空 docs 得到空 results，或全部条目均畸形被丢弃（可疑响应）→ null（宁降级勿误判全不相关）。
 */
import type { RerankResult } from "./types.js";

/**
 * POST JSON 并解析响应体；返回 unknown（由调用方按 provider schema 取路径）。
 * 任何失败（HTTP 非 ok / 超时 / 网络 / JSON 解析）→ null。
 */
export async function postJsonWithTimeout(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 防御式归一 provider results：合法条 → RerankResult（按 score 降序稳定排序）；
 * results 缺失/非数组，或非空 docs 得到空 results / 全部条目畸形 → null；畸形条目丢弃不致命。
 */
export function normalizeRerankResults(raw: unknown, docCount: number): RerankResult[] | null {
  if (!Array.isArray(raw)) return null;
  if (docCount > 0 && raw.length === 0) return null;
  const out: RerankResult[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const index = (entry as { index?: unknown }).index;
    const score = (entry as { relevance_score?: unknown }).relevance_score;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 0 || index >= docCount) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    out.push({ index, score });
  }
  // 全畸形边缘（review T1 Minor#1）：与「空 results」同语义 → null 降级原序，
  // 不返回 [] 让下游误读为「精排成功：全不相关」。
  if (docCount > 0 && out.length === 0) return null;
  return out.sort((a, b) => b.score - a.score);
}
