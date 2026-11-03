import { describe, it, expect } from "vitest";
import {
  getExtractMemoriesSystemPrompt,
  DEFAULT_ATOMIC_MAX_CHARS,
  MIN_ATOMIC_MAX_CHARS,
  MAX_ATOMIC_MAX_CHARS,
  resolveAtomicMaxChars,
} from "./l1-extraction.js";

/**
 * A3-1（2026-11-02）：原子性拆分红线的参数化。
 *
 * 契约：
 *  - 缺省（atomicMaxChars=300 / atomicityRewrite=false）→ prompt 与今天**逐字节相同**
 *    （既有测试钉死 "chat 缺省 === {}"；本文件再钉 "300 字" 仍字面存在）；
 *  - 改阈值 → 两处文案（chat L40 / code 第 8 条）都跟着变；
 *  - atomicityRewrite=true → 约束从"只记一件事"改为"只记一个可验证断言"，关闭时不含；
 *  - 非法值 clamp 120..2000，NaN → 缺省 300（不炸、不产出 "超过 NaN 字"）。
 */
describe("A3-1 原子性阈值参数化（l1-extraction prompt）", () => {
  it("缺省 = 300 字 / 不改写：两处文案保持字面 300，且不含改写措辞", () => {
    expect(DEFAULT_ATOMIC_MAX_CHARS).toBe(300);
    for (const mode of ["chat", "code"] as const) {
      const p = getExtractMemoriesSystemPrompt(mode);
      expect(p).toContain("超过 300 字");
      expect(p).not.toContain("可验证断言");
    }
  });

  it("显式传缺省值 === 不传（逐字节相同，守住既有恒等断言）", () => {
    expect(getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 300, atomicityRewrite: false })).toBe(
      getExtractMemoriesSystemPrompt("chat"),
    );
    expect(getExtractMemoriesSystemPrompt("code", { atomicMaxChars: 300 })).toBe(
      getExtractMemoriesSystemPrompt("code"),
    );
  });

  it("阈值 600：chat 与 code 两种 prompt 的文案都跟着变", () => {
    expect(getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 600 })).toContain("超过 600 字");
    expect(getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 600 })).not.toContain("超过 300 字");
    expect(getExtractMemoriesSystemPrompt("code", { atomicMaxChars: 600 })).toContain("超过 600 字");
    expect(getExtractMemoriesSystemPrompt("code", { atomicMaxChars: 600 })).not.toContain("超过 300 字");
  });

  it("atomicityRewrite=true：并入「一条只记一个可验证断言」，关闭/缺省时不含", () => {
    for (const mode of ["chat", "code"] as const) {
      const on = getExtractMemoriesSystemPrompt(mode, { atomicityRewrite: true });
      expect(on).toContain("可验证断言");
      expect(on).not.toContain("一条记忆只记一件事");
      const off = getExtractMemoriesSystemPrompt(mode, { atomicityRewrite: false });
      expect(off).not.toContain("可验证断言");
      expect(off).toContain("一条记忆只记一件事");
    }
  });

  it("阈值 + 改写同时开：两处改动叠加，仍保留原子性条款本体", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 600, atomicityRewrite: true });
    expect(p).toContain("超过 600 字");
    expect(p).toContain("可验证断言");
    // 拆分要求本体不能丢
    expect(p).toContain("必须拆分为多条");
  });

  it("非法值 clamp：0 → 120，-5 → 120，99999 → 2000，NaN/undefined → 300", () => {
    expect(MIN_ATOMIC_MAX_CHARS).toBe(120);
    expect(MAX_ATOMIC_MAX_CHARS).toBe(2000);
    expect(resolveAtomicMaxChars(0)).toBe(120);
    expect(resolveAtomicMaxChars(-5)).toBe(120);
    expect(resolveAtomicMaxChars(99999)).toBe(2000);
    expect(resolveAtomicMaxChars(Number.NaN)).toBe(300);
    expect(resolveAtomicMaxChars(undefined)).toBe(300);
    expect(getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 0 })).toContain("超过 120 字");
    expect(getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: Number.NaN })).toContain("超过 300 字");
  });

  it("空/自定义 memoryPrompt 场景由调用方合成，本函数不受影响（回归：仍以 FINAL_FORMAT_SENTENCE 收尾）", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { atomicMaxChars: 600, atomicityRewrite: true });
    expect(p.trimEnd().endsWith("或解释文本。")).toBe(true);
  });
});
