/**
 * 任务失败分级（D-7，2026-10-31）
 *
 * 背景（docs/ops/fullstack-test-capture-isolation.md §4 D-7）：
 * LLM 供应商 HTTP **402（配额耗尽）** 此前没有被任何分支枚举，落进「兜底 transient」
 * → skill 抽取 worker 每 ~2s 无上限重试、无退避，且 skill-extractor 每轮都重建
 * 注入块（buildRelevantSkillsBlock），把一次配额故障放大成持续打点。
 *
 * 判定顺序（D-7 真修，2026-11-01 复核后）：**结构化字段优先，文本兜底**
 *
 *   1) 错误对象上的 `statusCode` / `httpStatus` / `status` / `cause.statusCode`（LLM 适配器
 *      抛错时挂上去的真状态码）——这一条是本类修复的核心：生产 402 的 message 只有供应商
 *      中文文案，状态码原先只写进日志，于是被当成 unknown 重试 3 次（5s/15s/45s）才死信。
 *   2) `providerCode`（供应商业务码，如 Ark 的 2067 = 配额耗尽）/`code`
 *   3) 文本兜底：`status=NNN` / `http NNN` / `code=NNN` 显式前缀
 *   4) 再兜底：裸 `401/402/403/429`（这几类文案里带码很常见）；**裸 400/422 不认**——
 *      "processed 422 records ok" 这种正常句式曾被误判成 data_schema 并直接死信。
 *      真 400/422 要么来自结构化字段，要么带 `status=` 前缀。
 *
 * 分类表
 *
 *   | 特征                    | class        | retryable | 处理语义                         |
 *   |-------------------------|--------------|-----------|----------------------------------|
 *   | 400 / 422               | data_schema  | 否        | 立即死信（数据/schema 错，重试无意义） |
 *   | 401 / 403               | auth         | 否        | 立即死信（凭据错，不会自愈）        |
 *   | 402                     | quota        | 否        | 立即死信（配额耗尽，重试只会放大）   |
 *   | 429                     | rate_limited | 是        | 退避重试 + 次数上限               |
 *   | 5xx                     | upstream_5xx | 是        | 退避重试 + 次数上限               |
 *   | 网络关键字               | network      | 是        | 退避重试 + 次数上限               |
 *   | AbortError / timeout     | timeout      | 是        | 退避重试 + 次数上限               |
 *   | 其他                     | unknown      | 是        | 按 transient 保守重试（现状）      |
 *
 * 为什么 401/402/403 选「立即死信」而不是 fail-fast 抛给上层：任务体已经被取走，
 * 抛出去只会让调用方也失败一次；把条目落到 DLQ（含 last_error/retry_count）既能
 * 保住数据可重放，又能在配额恢复后人工/重放器捡回。
 */
export type TaskFailureClass =
  | "data_schema"
  | "auth"
  | "quota"
  | "rate_limited"
  | "upstream_5xx"
  | "network"
  | "timeout"
  | "unknown";

export interface TaskFailure {
  cls: TaskFailureClass;
  /** false = 重试不会改变结果（配额/凭据/数据错），应直接进死信。 */
  retryable: boolean;
  /** HTTP 状态码（来自结构化字段优先，文本兜底；没有则 undefined），供日志/观测定位。 */
  httpStatus?: number;
  /** 供应商业务码（如 Ark 的 2067 = 配额耗尽）；仅结构化来源有值。 */
  providerCode?: string;
}

const NETWORK_HINTS = [
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "socket hang up",
  "client network socket disconnected",
  "fetch failed",
  "und_err_",
  "timeout",
  "timed out",
];

/**
 * 供应商业务码里「重试无用」的一类（配额/余额）。
 *
 * 只放**确定代表配额耗尽**的码，宁缺毋滥：误把别的业务码归进 quota 会把可恢复任务
 * 直接送死信。Ark（火山）配额耗尽实测返回 `{"code":2067,"message":"额度不足"}` 且
 * HTTP 402，见 docs/ops/verify-task58-review.md §3。
 */
const PROVIDER_QUOTA_CODES = new Set(["2067", "insufficient_quota", "quota_exceeded", "insufficient_balance"]);

type ErrorLike = {
  message?: unknown;
  name?: unknown;
  statusCode?: unknown;
  httpStatus?: unknown;
  status?: unknown;
  code?: unknown;
  providerCode?: unknown;
  errorCode?: unknown;
  cause?: unknown;
  response?: { status?: unknown; statusCode?: unknown };
};

function asErrorLike(err: unknown): ErrorLike {
  return (typeof err === "object" && err !== null ? err : {}) as ErrorLike;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 599 ? v : undefined;
}

/**
 * 从错误对象上取 HTTP 状态码：**结构化字段优先**。
 *
 * 为什么必须这么做（task-84 / 复核实测）：生产 402 的 `err.message` 只有供应商中文文案
 * （"当前已达到 Token Plan 用量上限…(2067)"），状态码只出现在日志的
 * `formatApiErrorDetail` 里 ⇒ 旧分类器只能落 unknown（可重试），一次配额故障被放大成
 * 3 次重试（5s/15s/45s，64.9s）才死信。适配器现在把状态码挂在错误对象上，这里优先读它。
 */
export function structuredStatusCode(err: unknown): number | undefined {
  const e = asErrorLike(err);
  return numberOrUndefined(e.statusCode)
    ?? numberOrUndefined(e.httpStatus)
    ?? numberOrUndefined(e.status)
    ?? numberOrUndefined(e.response?.status)
    ?? numberOrUndefined(e.response?.statusCode)
    // 包装错误（annotateLlmError 的 frozen 退化分支）才继续往下找；cause 缺失时必须停，
    // 否则 asErrorLike(undefined) 返回空对象 → 无限递归（自测当场炸出 RangeError）。
    ?? (typeof e.cause === "object" && e.cause !== null ? structuredStatusCode(e.cause) : undefined);
}

/** 从错误对象上取供应商业务码（字符串化，便于大小写无关比对）。 */
export function structuredProviderCode(err: unknown): string | undefined {
  const e = asErrorLike(err);
  const raw = e.providerCode ?? e.errorCode ?? e.code;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return typeof e.cause === "object" && e.cause !== null ? structuredProviderCode(e.cause) : undefined;
}

/**
 * 裸 400/422 的严格形态：数字 token 后必须紧跟 HTTP 原因短语才算状态码。
 *
 * 为什么不全放：这两类会走 data_schema（不可重试 → 立即死信），把
 * "processed 422 records ok" 这类正常句子当状态码等于误杀任务；而
 * "400 Bad Request" / "422 Unprocessable Entity" 这种经典文案必须认得。
 */
function bareStrict4xx(msg: string): number | undefined {
  if (/(?:^|[^\d])400\s+bad\s+request(?:[^\d]|$)/i.test(msg)) return 400;
  if (/(?:^|[^\d])422\s+unprocessable\s+entity(?:[^\d]|$)/i.test(msg)) return 422;
  return undefined;
}

/** 独立数字 token 匹配：前后都不能紧邻数字（避免 "14002"/"line 4000" 误判）。 */
function hasStatus(msg: string, code: number): boolean {
  return new RegExp(String.raw`(?:^|[^\d])${code}(?:[^\d]|$)`).test(msg);
}

/** 优先看显式 `status=NNN` / `http 5xx` 形态，取第一个能识别的码。 */
function extractStatus(msg: string): number | undefined {
  const m = msg.match(/(?:status|code|http)(?:=|:|\s)+(\d{3})(?:[^\d]|$)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : undefined;
}

/** 分类一个任务级错误（extract / L1 / L2 通用）。 */
export function classifyTaskFailure(err: unknown): TaskFailure {
  // 既接受 Error，也接受 {message, statusCode, providerCode} 这样的结构化载体
  // （L1ExtractionFailedError 把状态码从适配器一路带下来时就是后者）。
  const like = asErrorLike(err);
  const name = typeof like.name === "string" ? like.name : "";
  const message = typeof like.message === "string" ? like.message : String(err ?? "");
  const msg = `${name} ${message}`.toLowerCase();

  // AbortError（LLM 请求被 signal cancel / timeout）——严格按 timeout 处理。
  if (name === "AbortError") return { cls: "timeout", retryable: true };

  // ① 结构化字段优先（LLM 适配器 / fetch / ai SDK 的错误对象上都可能是这几种形状）
  const structured = structuredStatusCode(err);
  // ② 文本显式前缀
  const explicit = structured ?? extractStatus(message) ?? extractStatus(msg);
  const status = explicit ??
    (hasStatus(msg, 402) ? 402 : undefined) ??
    (hasStatus(msg, 429) ? 429 : undefined) ??
    (hasStatus(msg, 401) ? 401 : undefined) ??
    (hasStatus(msg, 403) ? 403 : undefined) ??
    // 裸 400/422 只在**紧跟 HTTP 原因短语**时才认（"400 Bad Request" 这种经典文案）：
    // 4xx 的 data_schema 判定不可重试（立即死信），把 "processed 422 records ok" 这类
    // 正常句式当状态码会误杀好任务（task-71 复核实测那条路径）。
    // 裸 5xx（无前缀，如 "upstream returned 503"）认：误判代价只是把 unknown 标成
    // upstream_5xx，两者**都可重试**，行为不变、可观测更好。
    // 裸 401/402/403/429 认（沿用既有口径，配套测试 task-failure.test.ts「402 insufficient
    // quota」）：这三类在供应商文案里常以裸码出现，且真实误判面小。
    bareStrict4xx(msg) ??
    (hasStatus(msg, 500) ? 500 : undefined) ??
    (hasStatus(msg, 502) ? 502 : undefined) ??
    (hasStatus(msg, 503) ? 503 : undefined) ??
    (hasStatus(msg, 504) ? 504 : undefined);

  // ③ 供应商业务码（无 HTTP 状态时也能定罪配额）：Ark 2067 等
  const providerCode = structuredProviderCode(err);
  if (providerCode !== undefined && PROVIDER_QUOTA_CODES.has(providerCode.toLowerCase())) {
    return { cls: "quota", retryable: false, httpStatus: status, providerCode };
  }

  if (status !== undefined) {
    if (status === 402) return { cls: "quota", retryable: false, httpStatus: status, providerCode };
    if (status === 401 || status === 403) return { cls: "auth", retryable: false, httpStatus: status, providerCode };
    if (status === 400 || status === 422) return { cls: "data_schema", retryable: false, httpStatus: status, providerCode };
    if (status === 429) return { cls: "rate_limited", retryable: true, httpStatus: status, providerCode };
    if (status >= 500 && status <= 599) return { cls: "upstream_5xx", retryable: true, httpStatus: status, providerCode };
    // 其它 3xx/4xx：按数据错处理（不建议重试）
    if (status >= 400 && status <= 499) return { cls: "data_schema", retryable: false, httpStatus: status, providerCode };
  }

  if (
    msg.includes("json.parse") ||
    msg.includes("unexpected token") ||
    msg.includes("invalid json") ||
    msg.includes("invalid response") ||
    msg.includes("schema") ||
    msg.includes("zod") ||
    msg.includes("validation failed")
  ) {
    return { cls: "data_schema", retryable: false };
  }

  if (NETWORK_HINTS.some((h) => msg.includes(h))) return { cls: "network", retryable: true };

  return { cls: "unknown", retryable: true };
}

/** 一次 LLM 失败的可诊断三元组（message 保留原文供日志，其余为结构化字段）。 */
export interface LlmFailureDetail {
  message: string;
  statusCode?: number;
  providerCode?: string;
}

/**
 * 从任意错误里取出「消息 + 状态码 + 供应商码」。
 *
 * 上游（l1-extractor / extract-worker）在 catch 里统一调它：既保住 detail 文本，
 * 又把适配器挂上的结构化字段一并带出去，避免每一层各写一套提取逻辑。
 */
export function describeLlmFailure(err: unknown): LlmFailureDetail {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return { message, statusCode: structuredStatusCode(err), providerCode: structuredProviderCode(err) };
}

/**
 * LLM 调用失败的分类入口（D-7）：状态码/供应商码来自错误对象的结构化字段，文本只作兜底。
 *
 * 调用方（l1-extractor / skill-extractor / L2）应在 catch 里先把
 * `structuredStatusCode(err)` 与 `structuredProviderCode(err)` 取出来，再连同 detail 传进来；
 * 这样即使供应商文案里没有 "(status=402)"，配额故障也能一次判死信、不浪费退避重试。
 */
export function classifyLlmFailure(
  detail: string,
  statusCode?: number,
  providerCode?: string,
): TaskFailure {
  return classifyTaskFailure({ message: detail, statusCode, providerCode });
}

export interface TaskRetryPlan {
  action: "retry" | "dead_letter";
  delayMs: number;
  failure: TaskFailure;
}

/**
 * 统一重试决策：不可重试 → 立即死信；可重试但已达上限 → 死信；
 * 否则按 base * 3^retryCount 退避（上限 maxDelayMs）。
 * pipeline-worker 与 skill extract-worker 共用同一套语义，避免两处口径漂移。
 */
export function planTaskRetry(
  failure: TaskFailure,
  opts: { retryCount: number; maxRetries: number; baseDelayMs: number; maxDelayMs?: number },
): TaskRetryPlan {
  if (!failure.retryable) return { action: "dead_letter", delayMs: 0, failure };
  if (opts.retryCount >= opts.maxRetries) return { action: "dead_letter", delayMs: 0, failure };
  const cap = opts.maxDelayMs ?? 60_000;
  const raw = opts.baseDelayMs * Math.pow(3, Math.max(0, opts.retryCount));
  return { action: "retry", delayMs: Math.min(raw, cap), failure };
}

/**
 * 供日志/观测用的一行摘要。
 *
 * 带上 `code=`（供应商业务码）——配额故障最常见的形态是「有业务码、无状态码」，
 * 少了它日志里就看不出 (2067) 这类定罪依据。
 */
export function describeTaskFailure(f: TaskFailure): string {
  const parts: string[] = [];
  if (f.httpStatus !== undefined) parts.push(`http=${f.httpStatus}`);
  if (f.providerCode !== undefined) parts.push(`code=${f.providerCode}`);
  return parts.length === 0 ? f.cls : `${f.cls}(${parts.join(",")})`;
}

/**
 * D-6（2026-10-31）：L1 提取失败的 typed error。
 *
 * pipeline-factory 的 runner 契约保持不变（LLM 失败时**不抛**，见已提交的
 * MemoryCore/src/utils/l1-runner-failure.test.ts），由 gateway 的 executeL1 在看到
 * result.failed 时抛这个错，让 pipeline-worker 的通用失败路径接管：
 * 分类 → 退避重试（有上限）或立即死信。错误里带 failure，worker 不必再靠
 * 字符串猜类别（错误消息里也保留了 detail，含供应商状态码）。
 */
export class L1ExtractionFailedError extends Error {
  readonly sessionKey: string;
  readonly storedCount: number;
  readonly failure: TaskFailure;
  /** 结构化状态码（从 LLM 错误对象透传；没有则 undefined）。 */
  readonly statusCode?: number;
  /** 供应商业务码（同上）。 */
  readonly providerCode?: string;

  constructor(
    sessionKey: string,
    detail: string,
    storedCount = 0,
    extra: { statusCode?: number; providerCode?: string } = {},
  ) {
    super(`L1 extraction failed for session ${sessionKey}: ${detail}`);
    this.name = "L1ExtractionFailedError";
    this.sessionKey = sessionKey;
    this.storedCount = storedCount;
    this.statusCode = extra.statusCode;
    this.providerCode = extra.providerCode;
    // 结构化字段透过 message 边界传下来（l1-extractor → pipeline-factory → executor），
    // 分类器据此一次定罪；detail 文本仅作兜底与日志可读性。
    this.failure = classifyTaskFailure({ message: detail, statusCode: extra.statusCode, providerCode: extra.providerCode });
  }
}

/**
 * 取一个错误的失败分级：已知 typed error 用自己的分类，其余走字符串分类。
 * pipeline-worker / extract-worker 共用，保证「一处分类、两处消费」。
 */
export function failureOf(err: unknown): TaskFailure {
  if (err instanceof L1ExtractionFailedError) return err.failure;
  return classifyTaskFailure(err);
}
