import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";

/**
 * 2026-11-03（LME90 标定）：注入口径的「标准行为」钉死用例。
 *
 * 用户口径：最优召回不是可配置项，而是标准——所以「没写配置」等于「按标准走」，
 * 不是「不限」。实测同一 90 题（同 judge、同库，只改注入预算）：
 *   600 → genCorrect 0.400 / refused 52.2%
 *   1200 → 0.667 / 25.6%
 *   1600 → 0.744 / 16.7% / 2400 → 0.778（2026-11-03，回填与证据窗填满之前）
 * 2026-11-04 重标定（回填 + 证据窗填满 + 会话份额落地之后）：2400 档 74–76/90，
 *   6000 档 genCorrect 0.922 / refused 5.6% ⇒ 标准档由 2400 抬到 6000。
 *   旧 3600 → 0.789 的边际点结论作废：窗填不满时加预算买不到覆盖。
 * 自指预算 self:1 会让 13 道自指题在超长首行上撞成空块（实测 13/13 拒答）。
 *
 * 这三条断言是「标准」的单一事实源：谁把缺省改回去，这里就会红。
 */
describe("recall.injection 标准档（无配置即标准，不是不限）", () => {
  // parseConfig 读的是顶层 recall 组（不是 memory.recall）
  const raw = () => ({ dataDir: "D:/tmp/tdagemem-standard-probe", llm: {}, embedding: {}, recall: {} });

  it("未配 injection：maxChars 落标准档 6000", () => {
    const cfg = parseConfig(raw());
    expect(cfg.recall.injection?.maxChars).toBe(6000);
  });

  it("未配 budgetByIntent：empty 0 / continuation 1 / self 不限 / info 不限", () => {
    const cfg = parseConfig(raw());
    expect(cfg.recall.injection?.budgetByIntent).toEqual({
      empty: 0,
      continuation: 1,
      self: null,
      info: null,
    });
  });

  it("显式写 null 才表示该维度不限（回滚通道）", () => {
    const r = raw();
    r.recall = { injection: { maxChars: null, budgetByIntent: { self: 1 } } } as never;
    const cfg = parseConfig(r);
    expect(cfg.recall.injection?.maxChars).toBeNull();
    // 只覆盖了 self 一项，其余仍落标准档
    expect(cfg.recall.injection?.budgetByIntent).toEqual({
      empty: 0,
      continuation: 1,
      self: 1,
      info: null,
    });
  });
});
