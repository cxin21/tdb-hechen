/**
 * 呈现层翻修（2026-10-17，用户 m00227/m00265 裁决）——soul-feeling 叙事化。
 *
 * 契约（设计输入：r2-state-and-capabilities.md，「数值留代码层、prompt 写自然语言自述」）：
 * 1. renderStateLine 产出第一人称散文；连续数值与档位括号附注（防伪精度旧形态）
 *    全部退出 prompt——断言无阿拉伯数字、无「当下状态：」键值头。
 * 2. valence 五档/arousal 三档在代码层映射散文短语（本测试钉住词表片段）。
 * 3. 活跃价值折叠进「眼下最想推进的是X」；无 topValue 时省略子句，不硬造
 *    （#52 P2：dirTop 回退删除——topValue 仅状态机显式写入才渲染）。
 * 4. soul-assembler：驱动/审慎清单行（posLine/negLine）从 soul-feeling 删除——
 *    纯去重（identity 逐锚方向标注已含方向语义），不是信息删除（方案约束4）。
 * 5. null/undefined state → ""（逐位现状不变）；moodTier 文案保留样本数聚合语义。
 * 纪律：soulPrefixCache 为模块级跨用例存活——每用例独立租户（soul-cache.test.ts 实录）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";
import { clampState, renderStateLine, type SoulState } from "../soul-state.js";

const mkTenant = (n: string) => ({ teamId: "t1", userId: "u1", agentId: `narr-${n}` });

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  return { readCore: async () => slots, listValues: async () => rows } as never;
}

const row = (o: { value_id: string; label: string; weight?: number; valence?: number | null; node_type?: string; attrs_json?: string }) => ({
  value_id: o.value_id,
  label: o.label,
  weight: o.weight ?? 0.8,
  valence: o.valence === undefined ? 1 : o.valence,
  state: "active",
  node_type: o.node_type ?? "theme",
  attrs_json: o.attrs_json ?? "{}",
});

const SLOTS = [{ slot: "self_identity", content: "我是测试主体" }];

const st = (valence: number, arousal: number, topValue?: string): SoulState => ({
  valence,
  arousal,
  ...(topValue !== undefined ? { topValue } : {}),
});

const feelBlock = (out: string) => out.match(/<soul-feeling>[\s\S]*?<\/soul-feeling>/)?.[0] ?? "";

describe("renderStateLine 叙事化（m00227 终审形态）", () => {
  it("null/undefined → 空串（逐位现状不变）", () => {
    expect(renderStateLine(null)).toBe("");
    expect(renderStateLine(undefined)).toBe("");
  });

  it("正文无任何阿拉伯数字/小数括号（数值全部退出 prompt）", () => {
    const out = renderStateLine(st(0.6, 0.5, "定案"));
    expect(out).not.toMatch(/\d/);
    expect(out).not.toContain("（0.");
    expect(out).not.toContain("当下状态：");
  });

  it("第一人称散文：含「此刻」开头短语且整句句读收尾，不再是键值清单", () => {
    const out = renderStateLine(st(0.6, 0.5, "定案"));
    expect(out).toContain("此刻");
    expect(out.endsWith("。")).toBe(true);
  });

  it("valence 五档映射不同散文短语（词表钉死）", () => {
    expect(renderStateLine(st(0.9, 0.4))).toContain("心里明亮");
    expect(renderStateLine(st(0.3, 0.4))).toContain("心里偏顺遂");
    expect(renderStateLine(st(0.0, 0.4))).toContain("心里平稳");
    expect(renderStateLine(st(-0.3, 0.4))).toContain("有点受阻");
    expect(renderStateLine(st(-0.9, 0.4))).toContain("明显受阻");
  });

  it("arousal 三档映射不同散文短语（词表钉死）", () => {
    expect(renderStateLine(st(0.2, 0.8))).toContain("跃跃欲试");
    expect(renderStateLine(st(0.2, 0.4))).toContain("平稳安定");
    expect(renderStateLine(st(0.2, 0.1))).toContain("平缓");
  });

  it("clampState 防御：越界输入落入最近档位，不炸渲染", () => {
    expect(clampState(st(-2, 3)).valence).toBe(-1);
    expect(renderStateLine(st(-2, 3))).not.toBe("");
  });

  it("活跃价值折叠为「眼下最想推进的是X」（仅显式 topValue；#52 P2 回退参数已删）", () => {
    expect(renderStateLine(st(0.3, 0.4, "定案"))).toContain("眼下最想推进的是定案");
  });

  it("无 topValue（入参与回退皆缺）→ 省略子句不硬造", () => {
    const out = renderStateLine(st(0.3, 0.4));
    expect(out).not.toContain("眼下最想推进的是");
    expect(out).not.toContain("活跃价值");
  });
});

describe("soul-assembler 感受段终审形态（m00227/m00265）", () => {
  it("驱动/审慎清单行不再出现（纯去重：方向语义留在 identity 逐锚标注）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-pos", label: "求实", weight: 0.9, valence: 1, attrs_json: '{"description":"以证据与实证为准绳。"}' }),
        row({ value_id: "v-neg", label: "风险锚", weight: 0.7, valence: -1, attrs_json: '{"description":"发布前必须回滚演练。"}' }),
      ], SLOTS),
      mkTenant("a1"),
      undefined,
      {},
    );
    expect(out).not.toContain("驱动我行动的价值：");
    expect(out).not.toContain("提醒我审慎的价值：");
  });

  it("有 state 时感受段含叙事状态行（#52 P2：topValue 缺省不回退——首要锚在位也不硬造子句）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-top", label: "定案", weight: 0.9, valence: 1, attrs_json: '{"description":"推进关键决策落地。"}' }),
      ], SLOTS),
      mkTenant("a2"),
      undefined,
      { state: { valence: 0.6, arousal: 0.5 } },
    );
    const feel = feelBlock(out);
    expect(feel).toContain("<soul-feeling>");
    expect(feel).toContain("此刻");
    expect(feel).not.toContain("眼下最想推进的是");
    expect(feel).not.toContain("当下状态：");
  });

  it("state.topValue 显式在位 → 「眼下最想推进的是X」子句照常渲染", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-top", label: "定案", weight: 0.9, valence: 1, attrs_json: '{"description":"推进关键决策落地。"}' }),
      ], SLOTS),
      mkTenant("a2b"),
      undefined,
      { state: { valence: 0.6, arousal: 0.5, topValue: "定案" } },
    );
    expect(feelBlock(out)).toContain("眼下最想推进的是定案");
  });

  it("moodTier 单独存在（无任何价值锚）→ 感受段只有基调行，无清单行", async () => {
    const out = await buildSoulPrefix(
      makeStore([], SLOTS),
      mkTenant("a3"),
      undefined,
      { moodTier: { tier: "positive", sampleCount: 20 } },
    );
    const feel = feelBlock(out);
    expect(feel).toContain("近期基调");
    expect(feel).not.toContain("驱动我行动的价值：");
    expect(feel).not.toContain("提醒我审慎的价值：");
  });

  it("无 state/moodTier 且价值锚仅存于 identity 段 → soul-feeling 整块不渲染", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-only", label: "求实", weight: 0.9, valence: 1, attrs_json: '{"description":"以证据与实证为准绳。"}' }),
      ], SLOTS),
      mkTenant("a4"),
      undefined,
      {},
    );
    expect(out).not.toContain("<soul-feeling>");
  });
});
