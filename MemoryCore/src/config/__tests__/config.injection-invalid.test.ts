import { describe, expect, it } from "vitest";
import { __resetConfigWarningsForTests, parseConfig } from "../../config.js";

/**
 * 2026-11-03 对抗审查 P1：写错的值不得被静默翻译成「不限」。
 *
 * 语义三分：`null` = 不限（显式回滚）；`0` = 彻底不注入（硬零预算）；
 * 负数/非数字 = 配置写错 → 回落标准档并告警。
 */
describe("recall.injection 非法值的处置（写错 ≠ 不限）", () => {
  const raw = (injection: unknown) => ({
    dataDir: "D:/tmp/tdagemem-standard-probe",
    llm: {},
    embedding: {},
    recall: { injection },
  });

  it("maxChars 负数 → 回落标准档 6000 并告警", () => {
    __resetConfigWarningsForTests();
    const cfg = parseConfig(raw({ maxChars: -5 }) as never);
    expect(cfg.recall.injection?.maxChars).toBe(6000);
  });

  it("maxChars 非数字 → 回落标准档 6000", () => {
    __resetConfigWarningsForTests();
    const cfg = parseConfig(raw({ maxChars: "abc" }) as never);
    expect(cfg.recall.injection?.maxChars).toBe(6000);
  });

  it("maxChars 0 → 硬零预算（不是「不限」）", () => {
    __resetConfigWarningsForTests();
    const cfg = parseConfig(raw({ maxChars: 0 }) as never);
    expect(cfg.recall.injection?.maxChars).toBe(0);
  });

  it("budgetByIntent 负数 → 回落该项标准值并告警", () => {
    __resetConfigWarningsForTests();
    const cfg = parseConfig(raw({ budgetByIntent: { self: -1, info: "x", empty: 0 } }) as never);
    expect(cfg.recall.injection?.budgetByIntent).toEqual({
      empty: 0,
      continuation: 1,
      self: null,
      info: null,
    });
  });
});
