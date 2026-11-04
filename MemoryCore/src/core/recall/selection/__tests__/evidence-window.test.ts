import { describe, expect, it } from "vitest";
import { buildEvidenceWindow, queryTerms, splitTailAnchors } from "../evidence-window.js";

const ANCHOR = " ·(活动时间: 2026-05-02 10:00:00) ·soul[发生 2026-05-02 · 实见]";

function longAssistantTurn(body: string): string {
  return `- [assistant_turn] ${body}${ANCHOR}`;
}

describe("证据窗：只在整行绝对装不下时出手", () => {
  it("行装得下 → 返回 null（逐位现状，绝不动短行）", () => {
    const line = longAssistantTurn("我今天买到一张 25 美元的跳蚤药。");
    expect(buildEvidenceWindow(line, "跳蚤药多少钱", line.length)).toBeNull();
    expect(buildEvidenceWindow(line, "跳蚤药多少钱", 320)).toBeNull();
  });

  it("预算非法 → 返回 null（宁可不窗）", () => {
    const line = longAssistantTurn("x".repeat(2000));
    expect(buildEvidenceWindow(line, "x", 0)).toBeNull();
    expect(buildEvidenceWindow(line, "x", Number.NaN)).toBeNull();
  });

  it("长行 + 词面命中 → 窗口包含命中段，且装进预算", () => {
    const filler = "然后我们聊了很多别的事情，天气、通勤和午饭。".repeat(14);
    const answer = "诊费是 50 美元，医生还给它开了跳蚤药。";
    const body = `${filler}${answer}${filler}`;
    const line = longAssistantTurn(body);
    const out = buildEvidenceWindow(line, "跳蚤药花了多少", 400)!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("跳蚤药");
    expect(out).toContain("…（节选）");
  });

  it("长行 + 无词面命中 → 头尾三明治（事实常在首尾），不返回 null", () => {
    const line = longAssistantTurn("开头是用户的问题。".repeat(20) + "结尾是助手的结论。".repeat(20));
    const out = buildEvidenceWindow(line, "zzz 不存在的词", 300)!;
    expect(out).not.toBeNull();
    expect(out).toContain("开头是用户的问题");
    expect(out).toContain("结尾是助手的结论");
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it("时间与 soul 锚必须保留（语境不能丢）", () => {
    const line = longAssistantTurn("正文".repeat(400));
    const out = buildEvidenceWindow(line, "正文", 500)!;
    expect(out).toContain("活动时间: 2026-05-02");
    expect(out).toContain("soul[");
  });

  it("尾部锚解析：有锚拆锚，无锚原样", () => {
    const withAnchor = splitTailAnchors(`- [x] 正文${ANCHOR}`);
    expect(withAnchor.body).toBe("- [x] 正文");
    expect(withAnchor.anchors).toContain("活动时间");
    const plain = splitTailAnchors("- [x] 没有锚的正文");
    expect(plain.anchors).toBe("");
    expect(plain.body).toBe("- [x] 没有锚的正文");
  });

  it("查询词面：拉丁词去停用词，中文取 2-gram 去脏词", () => {
    const terms = queryTerms("你的跳蚤药花了多少 money");
    expect(terms).toContain("money");
    expect(terms).toContain("跳蚤");
    expect(terms).not.toContain("什么");
  });
});

describe("命中段向外扩到中段预算（2026-11-04）", () => {
  it("命中句后面紧邻的上下文句要并进来，别让窗远小于预算", () => {
    const q = "第二首歌副歌的和弦进行是什么";
    const body = [
      "Verse 1: A B C D",
      "副歌和弦进行是 C D E F G A B A G F E D C",
      "然后是一些铺垫词句，用来撑长上下文。",
      "再来一句紧邻的后续内容，也应当进来。",
      "最后是收尾的一句无关内容。",
    ].join("\n");
    const line = longAssistantTurn(body.repeat(24));
    const small = buildEvidenceWindow(line, q, 300)!;
    const big = buildEvidenceWindow(line, q, 900)!;
    // 预算放大后窗口必须真的变长（旧实现命中段一停就收尾，762 预算只出 374）
    expect(big.length).toBeGreaterThan(small.length);
    expect(big.length).toBeGreaterThan(600);
    expect(big).toContain("副歌和弦进行是 C D E F G A B A G F E D C");
  });
});

// 2026-11-03：轻度超预算连续窗（80/20、60/40）两臂实测均低于基线，已回退，
// 证据窗保持「头 35% + 命中窗 40% + 尾 25%」单一策略；重度超预算用例仍守住三段窗。
