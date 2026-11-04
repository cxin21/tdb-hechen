import { describe, expect, it } from "vitest";

import {
  applyInjectionSelection,
  type InjectionBudgetByIntent,
  type InjectionRulerConfig,
} from "../injection-stage.js";

function line(tag: string, body: string): string {
  return `- [${tag}] ${body}`;
}

function unitVec(seed: number): Float32Array {
  return new Float32Array([Math.cos(seed), Math.sin(seed)]);
}

function fakeEmbed(sims: number[]): (texts: string[]) => Promise<Float32Array[]> {
  const q = new Float32Array([1, 0]);
  return async (texts: string[]) =>
    texts.map((_, i) => (i === 0 ? q : unitVec(Math.acos(Math.max(-1, Math.min(1, sims[i - 1]))))));
}

const NO_BUDGET: InjectionBudgetByIntent = { empty: null, continuation: null, self: null, info: null };
const ENFORCE: InjectionRulerConfig = { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 };
const FILLER = "我们那天还聊了别的琐事，天气、通勤、午饭和地铁。";

// 2026-11-03 LME90 归因（830ce83f 型）：名次尺按 rankScore 贪心装填，遇到「整行装不下」就
// 整条丢，剩余预算空着不用——金标轮已经在检索结果里却 0 字进块。回填把被字符预算丢弃的候选
// 裁到剩余预算再注入（标准行为、无配置键、mode=off 零影响）。
describe("残预算回填：被字符预算丢弃的候选，用证据窗补进剩余预算", () => {
  // 第 1 行 1200 字（无答案）先装下；第 2 行 1500 字装不下（剩 800），答案在它中段。
  const first = line("work_fact", FILLER.repeat(48));
  const hidden = `${FILLER.repeat(28)}那台定焦镜头的到货日期是11月2日。${FILLER.repeat(30)}`;
  const second = line("episodic|bench", hidden);

  it("RED→GREEN：装不下的行被丢掉后，剩余预算回填出答案句", async () => {
    const out = await applyInjectionSelection({
      lines: [first, second],
      query: "定焦镜头什么时候到货",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8]),
      maxChars: 2000,
    });
    expect(out.selection.injectedChars).toBeLessThanOrEqual(2000);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toBe(first);
    expect(out.lines[1]).toContain("11月2日");
    // 回填行是节选，不是原文：硬预算未被突破，也不假装是完整轮次
    expect(out.lines[1]).toContain("…（节选）");
    expect(out.selection.injected).toBe(2);
  });

  it("剩余预算 < 200 → 不回填（宁可不塞碎片，与现状一致）", async () => {
    const out = await applyInjectionSelection({
      lines: [first, second],
      query: "定焦镜头什么时候到货",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8]),
      maxChars: 1350,
    });
    expect(out.lines).toEqual([first]);
    expect(out.selection.droppedBy.chars).toBe(1);
  });

  it("mode=off 逐位一致：off 下不回填、不裁行", async () => {
    const out = await applyInjectionSelection({
      lines: [first, second],
      query: "定焦镜头什么时候到货",
      ruler: { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 2000,
    });
    expect(out.lines).toEqual([first, second]);
    expect(out.selection.droppedBy.chars).toBe(0);
  });

  it("总量守恒：kept + droppedBy 各项 = 候选总数（回填不得凭空造行/丢行）", async () => {
    const out = await applyInjectionSelection({
      lines: [first, second],
      query: "定焦镜头什么时候到货",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8]),
      maxChars: 2000,
    });
    const d = out.selection.droppedBy;
    const sum = out.selection.kept + d.rank + d.floor + d.margin + d.dup + d.budget + d.chars + d.fold;
    expect(sum).toBe(2);
    expect(out.selection.kept).toBe(2);
  });

  it("回填行也受单行上限约束：窗后仍 cap，不突破 maxLineChars", async () => {
    const out = await applyInjectionSelection({
      lines: [first, second],
      query: "定焦镜头什么时候到货",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8]),
      maxChars: 2000,
      maxLineChars: 120,
    });
    expect(out.lines.every((l) => l.length <= 120)).toBe(true);
    expect(out.selection.injectedChars).toBeLessThanOrEqual(2000);
  });
});
