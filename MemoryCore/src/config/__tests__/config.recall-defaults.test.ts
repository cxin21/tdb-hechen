import { describe, it, expect, vi, afterEach } from "vitest";
import { parseConfig, __resetConfigWarningsForTests } from "../../config.js";

/**
 * WP1b（#173-B + 缺省对齐）配置面契约：
 *  ① 三通道删键安全：删 yaml 行 ≡ 显式 0（缺省必须等于生产值，关档不得靠 delete）；
 *  ② 缺省档 = 生产最优档（validity soft / maxResults 10 / injectWrapper calibrated）；
 *  ③ evidencePack 保持关但键/解析在（等 run-r169 读数，不是否决）。
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe("config: recall 缺省档（WP1b）", () => {
  it("① 删键安全：recall 段为空 ≡ 三键显式 0（整段逐位相同）", () => {
    const deleted = parseConfig({ recall: {} }).recall;
    const explicit = parseConfig({ recall: { coreRefBoost: 0, graphDiscount: 0, sceneBoost: 0 } }).recall;
    expect(deleted.coreRefBoost).toBe(0);
    expect(deleted.graphDiscount).toBe(0);
    expect(deleted.sceneBoost).toBe(0);
    // 全字段对拍：删行不是「另一种行为」，就是显式 0 这一种行为
    expect(explicit).toEqual(deleted);
  });

  it("② 显式开仍生效（缺省翻转不改可配性）", () => {
    const c = parseConfig({
      recall: { coreRefBoost: 0.05, graphDiscount: 0.6, sceneBoost: 0.04, graphMinStrength: 0.4 },
    }).recall;
    expect(c.coreRefBoost).toBe(0.05);
    expect(c.graphDiscount).toBe(0.6);
    expect(c.sceneBoost).toBe(0.04);
    expect(c.graphMinStrength).toBe(0.4);
    // 负值仍 clamp 到 0（关）
    expect(parseConfig({ recall: { graphDiscount: -1, sceneBoost: -0.2 } }).recall.graphDiscount).toBe(0);
    expect(parseConfig({ recall: { sceneBoost: -0.2 } }).recall.sceneBoost).toBe(0);
  });

  it("③ validity.mode 缺省 soft；显式 hard 可回滚；未知值落缺省 soft", () => {
    expect(parseConfig({}).recall.validity.mode).toBe("soft");
    expect(parseConfig({ recall: { validity: { mode: "hard" } } }).recall.validity.mode).toBe("hard");
    expect(parseConfig({ recall: { validity: { mode: "bogus" } } }).recall.validity.mode).toBe("soft");
    // #148 两旋钮缺省不变（softPenalty 0.5 与旧硬编码同乘子、presentIntent 仍硬丢）
    expect(parseConfig({}).recall.validity).toMatchObject({ softPenalty: 0.5, hardOnPresentIntent: true });
  });

  it("③b 显式非法 validity.mode 落回 soft 且告警一次（不静默）", () => {
    __resetConfigWarningsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseConfig({ recall: { validity: { mode: "hardened" } } }).recall.validity.mode).toBe("soft");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("recall.validity.mode 取值非法");
      // 同值重复解析不再刷屏；合法值不出声
      parseConfig({ recall: { validity: { mode: "hardened" } } });
      parseConfig({ recall: { validity: { mode: "hard" } } });
      parseConfig({});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("④ maxResults 缺省 10；显式值仍生效", () => {
    expect(parseConfig({}).recall.maxResults).toBe(10);
    expect(parseConfig({ recall: { maxResults: 5 } }).recall.maxResults).toBe(5);
  });

  it("⑤ injectWrapper 缺省 calibrated；legacy/neutral 可显式回滚；未知值落缺省", () => {
    expect(parseConfig({}).recall.injectWrapper).toBe("calibrated");
    expect(parseConfig({ recall: { injectWrapper: "legacy" } }).recall.injectWrapper).toBe("legacy");
    expect(parseConfig({ recall: { injectWrapper: "neutral" } }).recall.injectWrapper).toBe("neutral");
    expect(parseConfig({ recall: { injectWrapper: "bogus" } }).recall.injectWrapper).toBe("calibrated");
  });

  it("⑥ evidencePack 键在、缺省关、字段齐全（等 #169 读数后翻转）", () => {
    expect(parseConfig({}).recall.evidencePack).toEqual({
      enabled: false,
      adjacent: 1,
      windowMinutes: 30,
      maxExtraLines: 6,
      maxSessionRows: 400,
    });
    const on = parseConfig({ recall: { evidencePack: { enabled: true, adjacent: 3 } } }).recall.evidencePack;
    expect(on.enabled).toBe(true);
    expect(on.adjacent).toBe(3);
  });
});
