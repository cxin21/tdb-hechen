/**
 * D-7（2026-10-31）：任务失败分级表回归。
 *
 * 缺陷起源：LLM 供应商 **HTTP 402（配额耗尽）** 不在任何分支枚举里，落进
 * 「兜底 transient」→ skill 抽取 worker 每 ~2s 无上限重试、无退避，每轮还会
 * 重建注入块，把一次配额故障放大成持续打点（docs/ops/fullstack-test-capture-isolation.md §4 D-7）。
 *
 * 本文件锁死三件事：
 *  ① 分类表逐行（含**窄匹配**：14002 / line 4000 不能被当成 402 / 400）；
 *  ② 重试决策（不可重试 = 一次死信；可重试 = 退避 + 上限）；
 *  ③ typed error 自带分类，worker 不必再靠字符串猜。
 */
import { describe, expect, it } from "vitest";

import {
  L1ExtractionFailedError,
  classifyLlmFailure,
  classifyTaskFailure,
  describeLlmFailure,
  describeTaskFailure,
  failureOf,
  planTaskRetry,
} from "./task-failure.js";

describe("D-7 · classifyTaskFailure 分类表", () => {
  it("402 = quota，不可重试（本次事故主角）", () => {
    const f = classifyTaskFailure(new Error("LLM request failed: status=402 insufficient quota"));
    expect(f.cls).toBe("quota");
    expect(f.retryable).toBe(false);
    expect(f.httpStatus).toBe(402);
    expect(describeTaskFailure(f)).toBe("quota(http=402)");
  });

  it("401 / 403 = auth，不可重试（凭据错不会自愈）", () => {
    expect(classifyTaskFailure(new Error("401 Unauthorized")).cls).toBe("auth");
    expect(classifyTaskFailure(new Error("HTTP 403 Forbidden")).cls).toBe("auth");
    expect(classifyTaskFailure(new Error("HTTP 403 Forbidden")).retryable).toBe(false);
  });

  it("400 / 422 = data_schema，不可重试", () => {
    expect(classifyTaskFailure(new Error("400 Bad Request")).cls).toBe("data_schema");
    expect(classifyTaskFailure(new Error("422 Unprocessable Entity")).cls).toBe("data_schema");
  });

  it("429 = rate_limited，可重试", () => {
    const f = classifyTaskFailure(new Error("429 Too Many Requests"));
    expect(f.cls).toBe("rate_limited");
    expect(f.retryable).toBe(true);
  });

  it("5xx = upstream_5xx，可重试", () => {
    expect(classifyTaskFailure(new Error("upstream returned 503")).cls).toBe("upstream_5xx");
    expect(classifyTaskFailure(new Error("HTTP 500 internal")).retryable).toBe(true);
  });

  it("AbortError = timeout，可重试", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "AbortError";
    const f = classifyTaskFailure(err);
    expect(f.cls).toBe("timeout");
    expect(f.retryable).toBe(true);
  });

  it("网络错误关键字 = network，可重试", () => {
    expect(classifyTaskFailure(new Error("fetch failed")).cls).toBe("network");
    expect(classifyTaskFailure(new Error("connect ECONNREFUSED 10.0.0.1:443")).cls).toBe("network");
  });

  it("JSON/schema 错 = data_schema，不可重试", () => {
    expect(classifyTaskFailure(new Error("Unexpected token < in JSON at position 0")).cls).toBe("data_schema");
    expect(classifyTaskFailure(new Error("zod validation failed")).cls).toBe("data_schema");
  });

  it("识别不出的错误按 unknown 保守重试（不丢数据）", () => {
    const f = classifyTaskFailure(new Error("something weird happened"));
    expect(f.cls).toBe("unknown");
    expect(f.retryable).toBe(true);
  });

  it("窄匹配：数字不是独立 token 时不得误判", () => {
    // "14002" 里含 402、"line 4000" 里含 400 —— 都不能当状态码
    expect(classifyTaskFailure(new Error("request id 14002 rejected by peer")).cls).toBe("unknown");
    expect(classifyTaskFailure(new Error("failed at line 4000")).cls).toBe("unknown");
    // 但独立出现时必须认
    expect(classifyTaskFailure(new Error("status: 402")).cls).toBe("quota");
    expect(classifyTaskFailure(new Error("code=400")).cls).toBe("data_schema");
  });
});

describe("D-7 · planTaskRetry 重试决策", () => {
  const base = { maxRetries: 3, baseDelayMs: 5_000 };

  it("不可重试类别：一次即死信（不重试、不退避）", () => {
    const f = classifyTaskFailure(new Error("402 insufficient quota"));
    expect(planTaskRetry(f, { ...base, retryCount: 0 }).action).toBe("dead_letter");
    expect(planTaskRetry(f, { ...base, retryCount: 0 }).delayMs).toBe(0);
  });

  it("可重试类别：按 base*3^n 退避，达上限转死信", () => {
    const f = classifyTaskFailure(new Error("503 upstream"));
    expect(planTaskRetry(f, { ...base, retryCount: 0 }).delayMs).toBe(5_000);
    expect(planTaskRetry(f, { ...base, retryCount: 1 }).delayMs).toBe(15_000);
    expect(planTaskRetry(f, { ...base, retryCount: 2 }).delayMs).toBe(45_000);
    expect(planTaskRetry(f, { ...base, retryCount: 3 }).action).toBe("dead_letter");
  });

  it("退避有上限（maxDelayMs，缺省 60s）", () => {
    const f = classifyTaskFailure(new Error("503 upstream"));
    expect(planTaskRetry(f, { ...base, maxRetries: 10, retryCount: 6 }).delayMs).toBe(60_000);
    expect(planTaskRetry(f, { ...base, maxRetries: 10, retryCount: 6, maxDelayMs: 7_000 }).delayMs).toBe(7_000);
  });
});

describe("D-7 · L1ExtractionFailedError 携带分类", () => {
  it("detail 里的 402 被翻成 quota/不可重试", () => {
    const err = new L1ExtractionFailedError("sess-1", "llm call failed: HTTP 402 quota exceeded", 0);
    expect(err.name).toBe("L1ExtractionFailedError");
    expect(err.sessionKey).toBe("sess-1");
    expect(err.failure.cls).toBe("quota");
    expect(err.failure.retryable).toBe(false);
    // 消息里保留原文，日志可追
    expect(err.message).toContain("HTTP 402");
  });

  it("failureOf：typed error 用自己的分类，普通错误走字符串分类", () => {
    const typed = new L1ExtractionFailedError("sess-2", "429 slow down", 3);
    expect(failureOf(typed).cls).toBe("rate_limited");
    expect(failureOf(new Error("429 slow down")).cls).toBe("rate_limited");
    expect(failureOf("not an error object").cls).toBe("unknown");
  });
});

describe("D-7 · 结构化字段优先（llm-runner 标注路径）", () => {
  // 生产原样文案：状态码只在 HTTP 层，err.message 里没有 "status=402"
  const VENDOR_MSG = "当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)";

  it("文案无状态码但对象带 statusCode=402 → quota/不可重试（本次真修的核心）", () => {
    const f = classifyTaskFailure(Object.assign(new Error(VENDOR_MSG), { statusCode: 402 }));
    expect(f.cls).toBe("quota");
    expect(f.retryable).toBe(false);
    expect(f.httpStatus).toBe(402);
  });

  it("供应商码 2067 单独就足以判 quota（即使没有 HTTP 码）", () => {
    const f = classifyTaskFailure({ message: VENDOR_MSG, providerCode: "2067" });
    expect(f.cls).toBe("quota");
    expect(f.retryable).toBe(false);
    expect(f.providerCode).toBe("2067");
  });

  it("describeTaskFailure 同时带 http 与 code，日志可区分供应商", () => {
    const f = classifyTaskFailure({ message: VENDOR_MSG, statusCode: 402, providerCode: "2067" });
    expect(describeTaskFailure(f)).toBe("quota(http=402,code=2067)");
  });

  it("纯对象也能分类（structuredStatusCode 不要求 Error 实例）", () => {
    const f = classifyTaskFailure({ message: "validation failed", statusCode: 422 });
    expect(f.cls).toBe("data_schema");
    expect(f.retryable).toBe(false);
  });

  it("正常句式里的数字不误判：'processed 422 records ok' → unknown/可重试", () => {
    const f = classifyTaskFailure(new Error("processed 422 records ok"));
    expect(f.cls).toBe("unknown");
    expect(f.retryable).toBe(true);
  });

  it("经典文案仍认：'400 Bad Request' → data_schema", () => {
    expect(classifyTaskFailure(new Error("400 Bad Request")).cls).toBe("data_schema");
    expect(classifyTaskFailure(new Error("422 Unprocessable Entity")).cls).toBe("data_schema");
  });

  it("L1ExtractionFailedError 可用 extra 携带结构化状态码（detail 里没有 402）", () => {
    const err = new L1ExtractionFailedError("sess-9", VENDOR_MSG, 0, { statusCode: 402, providerCode: "2067" });
    expect(err.failure.cls).toBe("quota");
    expect(err.failure.retryable).toBe(false);
    expect(err.failure.httpStatus).toBe(402);
    expect(err.failure.providerCode).toBe("2067");
    expect(err.message).toContain("Token Plan");
  });

  it("describeLlmFailure / classifyLlmFailure：从原始错误取结构化字段", () => {
    const err = Object.assign(new Error(VENDOR_MSG), { statusCode: 402, providerCode: "2067" });
    const detail = describeLlmFailure(err);
    expect(detail.statusCode).toBe(402);
    expect(detail.providerCode).toBe("2067");
    const f = classifyLlmFailure(detail.message, detail.statusCode, detail.providerCode);
    expect(f.cls).toBe("quota");
  });
});

