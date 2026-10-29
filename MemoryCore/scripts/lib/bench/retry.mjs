/**
 * 429 退避单一源（issue #139 第1项）。
 *
 * 背景：facts.mjs / conclusions.mjs / fact-extract-gate.mjs / llm.mjs 各自抄了一份
 * 退避循环，且三处语义互不一致：
 *  - facts/conclusions：attempt<3 才 sleep（末次不白等），但只在 catch 里判 429；
 *  - fact-extract-gate：**无条件** sleep（第 4 次失败后仍白等 30s）；
 *  - llm.mjs：状态码判定 + 800ms 短退避（与 5s/15s/30s 完全不同刻度）。
 *
 * 收敛契约（本模块是唯一实现）：
 *  1. 只有「还有下一次尝试」才 sleep——末次立即抛，绝不空耗；
 *  2. 可重试判定可注入（429 / 5xx / 空响应各自语义不同）；
 *  3. 不可重试的错误立即抛，绝不被退避吞掉；
 *  4. 每次重试都回调 onRetry（日志/计量用），不打印。
 */

/** 缺省退避（毫秒）：与历史 facts/conclusions 完全一致，避免行为漂移。 */
export const RATE_LIMIT_DELAYS_MS = [5000, 15000, 30000];

/** 429 / 限流文案判定（历史三处正则统一到这里）。 */
export function isRateLimitError(err) {
  return /429|rate.?limit|too many requests/i.test(String(err?.message ?? err));
}

/** 从错误对象上取 HTTP 状态码（llm.mjs 的 call 会挂 e.status）。 */
export function statusOf(err) {
  const st = err?.status ?? err?.statusCode ?? err?.response?.status;
  return typeof st === "number" ? st : undefined;
}

/** 429 或 5xx：与 llm.mjs 原判定等价（4xx 除 429 永不重试）。 */
export function isRetriableHttpError(err) {
  const st = statusOf(err);
  if (st !== undefined) return st === 429 || st >= 500;
  return isRateLimitError(err);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带退避的重试执行器。
 *
 * @param {(attempt:number)=>Promise<any>} fn 每次尝试调用一次（attempt 从 0 开始）。
 * @param {object} [opts]
 * @param {number} [opts.attempts=4] 总尝试次数（含首次）。
 * @param {number[]} [opts.delays] 第 n 次失败后等待毫秒；短于尝试数时末位复用。
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 可注入（测试用）。
 * @param {(err:any)=>boolean} [opts.isRetryable] 可重试判定。
 * @param {(value:any)=>boolean} [opts.isEmpty] 成功但结果视作失败（空响应）时返回 true。
 * @param {string} [opts.emptyMessage] 空响应耗尽时的错误文案。
 * @param {(info:{attempt:number,delay:number,error:Error,empty?:boolean})=>void} [opts.onRetry]
 * @returns {Promise<any>} fn 的返回值。
 */
export async function withRateLimitRetry(fn, opts = {}) {
  if (typeof fn !== "function") throw new TypeError("withRateLimitRetry: fn 必须是函数");
  const attempts = opts.attempts ?? 4;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("withRateLimitRetry: attempts 必须是 ≥1 的整数");
  }
  const delays = Array.isArray(opts.delays) && opts.delays.length ? opts.delays : RATE_LIMIT_DELAYS_MS;
  // 抖动（±jitter 比例）：抽取默认 8 路并发，齐步重试会把退避变成新的尖峰。
  // 缺省 0 = 确定性（单测断言精确毫秒）；并发调用方显式开 jitter。
  const jitter = typeof opts.jitter === "number" && opts.jitter > 0 ? Math.min(opts.jitter, 0.9) : 0;
  const sleep = opts.sleep ?? defaultSleep;
  const isRetryable = opts.isRetryable ?? isRateLimitError;
  const isEmpty = opts.isEmpty;
  const emptyMessage = opts.emptyMessage ?? "empty response";
  const onRetry = opts.onRetry;

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = attempt === attempts - 1;
    let value;
    let retryError = null;
    try {
      value = await fn(attempt);
      if (isEmpty && isEmpty(value)) {
        retryError = new Error(emptyMessage);
      } else {
        return value;
      }
    } catch (err) {
      if (!isRetryable(err)) throw err;
      retryError = err;
    }
    lastErr = retryError;
    // 末次尝试失败：立即抛，不再 sleep（issue #139「末次不再白等」）。
    if (last) break;
    const baseDelay = delays[attempt] ?? delays[delays.length - 1] ?? 0;
    const delay = jitter && baseDelay > 0 ? Math.round(baseDelay * (1 + (Math.random() * 2 - 1) * jitter)) : baseDelay;
    if (onRetry) onRetry({ attempt, delay, error: retryError, empty: retryError.message === emptyMessage });
    if (delay > 0) await sleep(delay);
  }
  throw lastErr ?? new Error("retry exhausted");
}
