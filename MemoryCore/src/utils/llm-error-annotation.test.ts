/**
 * D-7（2026-11-01）· LLM 失败错误的结构化标注 RED 套件。
 *
 * 缺陷现场（docs/ops/verify-task58-review.md §3 实测）：生产 402 的 `err.message`
 * 只有供应商中文（"当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)"），
 * HTTP 状态码只在日志里 —— 上层分类器落 unknown（可重试）→ 3 次退避（5s/15s/45s）
 * 才死信，期间没人知道这是配额故障。
 *
 * 归零后预期（本套件锁死）：
 *   · 状态码/供应商码挂到**原错误对象**上（不包装，name/message/stack 不变）；
 *   · 供应商业务码即使只有文案尾巴 `(2067)` 也能取到；
 *   · 取不到结构化信息时对象原样返回（零副作用）。
 */
import { describe, expect, it } from "vitest";

import { annotateLlmError, extractHttpStatus, extractProviderCode } from "./llm-error-annotation.js";

/** 读取标注字段（TS 的 Record 断言在 Error 上不重叠，统一走一次 unknown）。 */
function bag(err: unknown): Record<string, unknown> {
  return err as unknown as Record<string, unknown>;
}

/** AI SDK APICallError 的最小形状（statusCode + responseBody + message）。 */
function apiCallError(
  statusCode: number,
  responseBody: string,
  message: string,
): Error & { statusCode: number; responseBody: string } {
  return Object.assign(new Error(message), { statusCode, responseBody });
}

describe("D-7 · extractHttpStatus", () => {
  it("优先读 statusCode（APICallError 形状）", () => {
    expect(extractHttpStatus(apiCallError(402, "{}", "quota"))).toBe(402);
  });

  it("兼容 fetch 风格 status 与嵌套 response.status", () => {
    expect(extractHttpStatus({ status: 503 })).toBe(503);
    expect(extractHttpStatus({ response: { status: 429 } })).toBe(429);
  });

  it("文本兜底：message 里的 status=NNN", () => {
    expect(extractHttpStatus(new Error("call failed (status=502, url=x)"))).toBe(502);
  });

  it("既无字段也无文本 → undefined（不瞎猜）", () => {
    expect(extractHttpStatus(new Error("当前已达到 Token Plan 用量上限 (2067)"))).toBeUndefined();
  });
});

describe("D-7 · extractProviderCode", () => {
  it("从 responseBody 的 JSON code 取（Ark 形状 code=2067）", () => {
    const err = apiCallError(402, JSON.stringify({ code: 2067, message: "额度不足" }), "quota");
    expect(extractProviderCode(err)).toBe("2067");
  });

  it("兼容 error.code = insufficient_quota 与字符串码", () => {
    expect(extractProviderCode({ responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }) }))
      .toBe("insufficient_quota");
  });

  it("responseBody 不是 JSON 时退到文案尾部 (2067)", () => {
    const err = apiCallError(402, "<html>bad gateway</html>", "当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)");
    expect(extractProviderCode(err)).toBe("2067");
  });

  it("文案里没有括号码 → undefined", () => {
    expect(extractProviderCode(new Error("boom"))).toBeUndefined();
  });
});

describe("D-7 · annotateLlmError", () => {
  it("原地标注：同一个对象、message/name 不变，新增 statusCode/providerCode", () => {
    const err = apiCallError(402, JSON.stringify({ code: 2067 }), "当前已达到 Token Plan 用量上限 (2067)");
    const out = annotateLlmError(err);
    expect(out).toBe(err);                       // 不包装
    expect(out.message).toBe(err.message);       // 文案原样
    expect(bag(out).statusCode).toBe(402);
    expect(bag(out).providerCode).toBe("2067");
  });

  it("AbortError 的 name 不被改写（超时判定依赖它）", () => {
    const ac = new Error("This operation was aborted");
    ac.name = "AbortError";
    const out = annotateLlmError(Object.assign(ac, { statusCode: 504 }));
    expect(out.name).toBe("AbortError");
    expect(bag(out).statusCode).toBe(504);
  });

  it("取不到结构化信息 → 原样返回（不新增字段、零副作用）", () => {
    const err = new Error("something weird happened");
    expect(annotateLlmError(err)).toBe(err);
    expect(Object.keys(err)).not.toContain("statusCode");
    expect(Object.keys(err)).not.toContain("providerCode");
  });

  it("对象不可写（frozen）时退化为带 cause 的包装，并保留原 name/stack", () => {
    // frozen 且本身没有结构化字段（需要标注）→ 只能包装一层
    const frozen = Object.freeze(new Error("frozen boom (status=402)"));
    const out = annotateLlmError(frozen) as unknown as Error & { cause?: unknown; statusCode?: number };
    expect(out).not.toBe(frozen);
    expect(out.cause).toBe(frozen);
    expect(out.message).toBe("frozen boom (status=402)");
    expect(out.statusCode).toBe(402);
  });

  it("已有 statusCode 不覆盖（尊重更接近源头的值）", () => {
    const err = Object.assign(new Error("keep"), { statusCode: 429, providerCode: "keep-code" });
    const out = annotateLlmError(err) as unknown as Record<string, unknown>;
    expect(out.statusCode).toBe(429);
    expect(out.providerCode).toBe("keep-code");
  });
});
