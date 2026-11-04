import { describe, expect, it } from "vitest";

import {
  applyInjectionSelection,
  hashLines,
  type InjectionBudgetByIntent,
  type InjectionRulerConfig,
} from "../injection-stage.js";
import { buildEvidenceWindow, splitTailAnchors } from "../evidence-window.js";

function line(tag: string, body: string): string {
  return `- [${tag}] ${body}`;
}

function fakeEmbed(sims: number[]): (texts: string[]) => Promise<Float32Array[]> {
  const q = new Float32Array([1, 0]);
  return async (texts: string[]) =>
    texts.map((_, i) => {
      if (i === 0) return q;
      const s = Math.max(-1, Math.min(1, sims[i - 1]!));
      return new Float32Array([Math.cos(Math.acos(s)), Math.sin(Math.acos(s))]);
    });
}

const ENFORCE: InjectionRulerConfig = { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: null };
// 地板 0.9 让唯一候选必然被判 floor 丢弃 → 触发零行保护（这才是"折叠打回零行"的前提）
const ENFORCE_FLOOR: InjectionRulerConfig = { ...ENFORCE, floor: 0.9 };
const NO_BUDGET: InjectionBudgetByIntent = { empty: null, continuation: null, self: null, info: null };

describe("证据窗 · 锚保真（对抗审查 P1）", () => {
  it("行中锚不被头/尾切片截断，节选后锚完整保留", () => {
    const anchor = "·(活动时间: 2024-11-03 10:20)";
    const filler = "背景补充说明".repeat(40);
    const body = `用户说他上周买了三本书。${anchor} 其中一本是讲分布式系统的，另外两本是小说。${filler}`;
    const out = buildEvidenceWindow(line("work_fact", body), "分布式系统 书", 300);
    expect(out).not.toBeNull();
    expect(out!).toContain(anchor);
    // 不得出现被拦腰截断的残片
    expect(out!).not.toMatch(/活动时间:\s*$/);
    expect(out!.length).toBeLessThanOrEqual(300);
  });

  it("同一锚出现两次时只保留一份", () => {
    const { anchors } = splitTailAnchors(`正文 ·soul[实见] 再说一句 ·soul[实见]`);
    expect(anchors).toBe("·soul[实见]");
  });

  it("命中窗从首句开始时不重复首句（对抗审查 P2）", () => {
    const body = "语义召回依赖向量维度 2048 的嵌入。" + "补充说明".repeat(30);
    const out = buildEvidenceWindow(line("work_fact", body), "语义召回 向量维度", 120);
    expect(out).not.toBeNull();
    const first = "语义召回依赖向量维度 2048 的嵌入。";
    expect(out!.split(first).length - 1).toBe(1);
  });
});

describe("零行保护 × 折叠（对抗审查 P1）", () => {
  it("已注入过的同一行被折叠后，保护行仍留下 1 行（空块比重复更糟）", async () => {
    const lines = [line("work_fact", "长".repeat(2800))];
    const first = await applyInjectionSelection({
      lines,
      query: "我们上次讨论的向量维度是多少",
      ruler: ENFORCE_FLOOR,
      maxChars: 600,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.4]),
    });
    expect(first.lines).toHaveLength(1);
    // 第二轮：同样的行 + 同样的 previousHash → 折叠本想删空，但保护行必须是唯一例外
    const second = await applyInjectionSelection({
      lines,
      query: "我们上次讨论的向量维度是多少",
      ruler: ENFORCE_FLOOR,
      maxChars: 600,
      foldIdentical: true,
      previousHash: first.foldHash,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.4]),
    });
    expect(second.selection.rescued).toBe(1);
    expect(second.lines.length).toBe(1);
    expect(second.selection.droppedBy.fold).toBe(0);
  });
});
