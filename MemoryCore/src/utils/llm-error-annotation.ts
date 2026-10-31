/**
 * LLM 失败错误的结构化标注（D-7 真修，2026-11-01）
 *
 * 问题（docs/ops/verify-task58-review.md §3 实测）：
 *   生产 402 的 `err.message` 只有供应商文案（"当前已达到 Token Plan 用量上限…(2067)"），
 *   状态码仅出现在日志的 `formatApiErrorDetail` 里。上层 classifyTaskFailure 只能按文本
 *   分类 → 落 unknown（可重试）→ 一次配额故障被放大成 3 次退避（5s/15s/45s，实测 64.9s）
 *   才死信，期间无人知道这是配额问题。
 *
 * 做法：适配器在 throw 之前调用 `annotateLlmError`，把 `statusCode`/`providerCode` 挂到
 * **同一个错误对象**上（不包装，name/message/stack 全保留）。上层 `classifyTaskFailure`
 * 优先读这两个字段，文本仅作兜底。
 *
 * 本模块刻意不 import `ai`（也不 import 任何带副作用的模块）：duck-typing 取字段，
 * 既能被 llm-runner 直接用，也能被单测廉价地直接调用。
 */

function numberInRange(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 599 ? v : undefined;
}

type ErrLike = {
  message?: unknown;
  statusCode?: unknown;
  status?: unknown;
  response?: { status?: unknown };
  responseBody?: unknown;
};

function asLike(err: unknown): ErrLike {
  return (typeof err === "object" && err !== null ? err : {}) as ErrLike;
}

/** 从错误对象上取 HTTP 状态码；取不到再看 message 里的 `status=NNN`。 */
export function extractHttpStatus(err: unknown): number | undefined {
  const e = asLike(err);
  const direct = numberInRange(e.statusCode) ?? numberInRange(e.status) ?? numberInRange(e.response?.status);
  if (direct !== undefined) return direct;
  const message = typeof e.message === "string" ? e.message : "";
  const m = /status=(\d{3})/.exec(message);
  return m ? numberInRange(Number(m[1])) : undefined;
}

/**
 * 从响应体/文案里取供应商业务码。
 *
 * 优先 `responseBody` 的 JSON `code`（AI SDK 的 APICallError 会带原始响应体），
 * 再退到供应商文案尾部的 `(2067)` 形态（Ark 配额耗尽就是这样）。
 */
export function extractProviderCode(err: unknown): string | undefined {
  const e = asLike(err);
  if (typeof e.responseBody === "string" && e.responseBody.length > 0) {
    try {
      const parsed = JSON.parse(e.responseBody) as { code?: unknown; error?: { code?: unknown } };
      const raw = parsed?.code ?? parsed?.error?.code;
      if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
      if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    } catch {
      // responseBody 不是 JSON：继续走文案兜底
    }
  }
  const message = typeof e.message === "string" ? e.message : "";
  const m = /\((\d{3,6})\)\s*$/.exec(message);
  return m ? m[1] : undefined;
}

/**
 * 把结构化失败信息挂到要抛出的错误对象上（原地标注，不包装）。
 *
 * 对象不可写（frozen / 只读代理）时才退化为带 `cause` 的包装，并沿用原 name 与 stack，
 * 保证 `err.name === "AbortError"` 这类判定不被破坏。
 */
export function annotateLlmError<T>(err: T): T {
  const statusCode = extractHttpStatus(err);
  const providerCode = extractProviderCode(err);
  if (statusCode === undefined && providerCode === undefined) return err;
  try {
    const target = err as unknown as Record<string, unknown>;
    if (statusCode !== undefined && target.statusCode === undefined) target.statusCode = statusCode;
    if (providerCode !== undefined && target.providerCode === undefined) target.providerCode = providerCode;
    return err;
  } catch {
    const original = err instanceof Error ? err : undefined;
    const wrapped = new Error(original?.message ?? String(err), { cause: err });
    if (original?.name) wrapped.name = original.name;
    if (original?.stack) wrapped.stack = original.stack;
    const target = wrapped as unknown as Record<string, unknown>;
    if (statusCode !== undefined) target.statusCode = statusCode;
    if (providerCode !== undefined) target.providerCode = providerCode;
    return wrapped as unknown as T;
  }
}
