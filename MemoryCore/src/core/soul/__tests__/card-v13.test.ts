import { describe, expect, it } from "vitest";
import {
  CARD_V13_ANCHOR_MAX_CHARS,
  CARD_V13_BLOCK_ORDER,
  CARD_V13_IDENTITY_MAX_CHARS,
  CARD_V13_MAX_CHARS,
  buildCardSegmentsV13,
  calibrationLinesFromRows,
  renderPersonaCardV13,
  type SoulCardV13Input,
} from "../card-v13.js";
import type { SoulCalibrationOutcome, SoulCalibrationRow } from "../../store/soul-event-types.js";
import { CARD_READER_NOTE } from "../traits.js";

/**
 * t26 / P4：卡面用 soul_calibration 的原始行写「按域把握度」。
 *
 * 三条硬口径：
 *  - 有校准：句里的次数、把握档位、偏差都能由行复算，memory 块 confidence 由残差推出；
 *  - 无校准：整块不写把握，也不写死 high/medium 冒充；
 *  - 全错：把握档位不升反降（0.8 预测全失败 → low）。
 * 另锁 hash 只跟正文走、四档预算不破。
 */

function bodyOf(text: string): string {
  const stripped = text.split("\n\n<!-- persona-card")[0] ?? "";
  const prefix = `${CARD_READER_NOTE}\n\n`;
  return stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
}

function blockText(text: string, title: string): string | null {
  for (const chunk of bodyOf(text).split("\n\n")) {
    if (chunk.startsWith(`${title}\n`)) return chunk.slice(title.length + 1);
  }
  return null;
}

function long(chars: number, seed: string): string {
  let out = "";
  while (out.length < chars) out += seed;
  return out.slice(0, chars);
}

function cal(
  domain: string,
  predicted: number,
  outcome: SoulCalibrationOutcome,
  index: number,
): SoulCalibrationRow {
  return {
    id: `cal-${domain}-${index}`,
    team_id: "team-1",
    user_id: "user-1",
    agent_id: "agent-1",
    domain,
    predicted_confidence: predicted,
    actual_outcome: outcome,
    event_id: `ev-${index}`,
    at: "2026-11-10T00:00:00.000Z",
    error: null,
    note: "",
  };
}

function calRows(domain: string, predicted: number, outcome: SoulCalibrationOutcome, count: number): SoulCalibrationRow[] {
  return Array.from({ length: count }, (_, i) => cal(domain, predicted, outcome, i + 1));
}

function baseInput(over: Partial<SoulCardV13Input> = {}): SoulCardV13Input {
  return {
    profile: {
      name: "小满",
      pronoun: "我",
      selfImage: "我是小满。白天写文档，晚上去江边跑步。",
      voice: "说话像聊天，一句一句来，不用 Markdown。",
      purpose: "把复杂的东西讲清楚。",
      redlines: [{ text: "不假装知道没验证过的事实", active: true }],
    },
    lines: {
      human: [{ text: "身份：生产人物档案链路的拍板决策人" }],
      relationship: [{ text: "你上次说别替你猜", evidenceIds: ["ev-r1"] }],
      identity: [{ text: "我把「先验后报」当成底线", evidenceIds: ["ev-i1"] }],
      values: [{ text: "我宁可说没看过，也不虚报一个已经绿了" }],
      boundary: [{ text: "不属于我写域的模块就不动手" }],
      voice: [{ text: "我认错不绕弯" }],
      self: [{ text: "我答应自己：每句话都能指回出处" }],
      narrative: [{ text: "我原先站在审查位，后来走到动手改" }],
    },
    mood: {
      valence: -0.3,
      arousal: 0.5,
      baselineValence: 0,
      baselineArousal: 0.3,
      emotionLabel: "憋着",
      emotionObject: "那张没关的票",
    },
    version: 1,
    ...over,
  };
}

function blockById(card: ReturnType<typeof renderPersonaCardV13>, id: string) {
  return card.blocks.find((block) => block.id === id);
}

describe("有校准数据：按域写可复算的把握与次数", () => {
  it("测试域 3 次成功、predicted 0.5 → 半成把握 + 3 次成了 3 次，confidence=low", () => {
    const card = renderPersonaCardV13(baseInput({ calibration: calRows("测试", 0.5, "success", 3) }));
    const memory = blockText(card.text, "记得") ?? "";
    expect(memory).toContain("在测试上，我给自己半成把握，3 次里成了 3 次。");
    expect(memory).toContain("报得比实际低约 0.50。");
    expect(blockById(card, "memory")?.confidence).toBe("low");
    expect(blockById(card, "memory")?.source).toBe("observed");
    // 证据能回指到校准行的事件，不是卡自己编的 id。
    expect(blockById(card, "memory")?.evidenceIds).toEqual(["ev-1", "ev-2", "ev-3"]);
  });

  it("predicted 0.9 且 3 次成功 → 八成把握、残差小，confidence=high", () => {
    const card = renderPersonaCardV13(baseInput({ calibration: calRows("测试", 0.9, "success", 3) }));
    // 把握度只落五档（0.8 起就是「八成」），不写百分数；0.9 与 0.8 同档，靠结果与残差区分。
    expect(blockText(card.text, "记得") ?? "").toContain("在测试上，我给自己八成把握，3 次里成了 3 次。");
    expect(blockById(card, "memory")?.confidence).toBe("high");
  });

  it("同一域内多于两个域时只写前两个（按样本数、再按域名），并给出截断告警", () => {
    const rows = [
      ...calRows("测试", 0.5, "success", 3),
      ...calRows("召回", 0.6, "partial", 2),
      ...calRows("配置", 0.7, "fail", 1),
    ];
    const warnings: string[] = [];
    const lines = calibrationLinesFromRows(rows, { warnings });
    expect(lines.map((line) => line.text.split("上，我")[0])).toEqual(["在测试", "在召回"]);
    expect(warnings.some((w) => w.startsWith("calibration_domains_truncated"))).toBe(true);

    const card = renderPersonaCardV13(baseInput({ calibration: rows }));
    const memory = blockText(card.text, "记得") ?? "";
    expect(memory).toContain("在测试上");
    expect(memory).toContain("在召回上");
    expect(memory).not.toContain("在配置上");
  });
});

describe("无校准数据：不写把握，也不冒充 high/medium", () => {
  it("记得块里没有「把握」，confidence 由证据推出（无证据→low）", () => {
    const card = renderPersonaCardV13(baseInput());
    const memory = blockText(card.text, "记得") ?? "";
    expect(memory).not.toContain("把握");
    expect(memory).not.toContain("报得比实际");
    expect(blockById(card, "memory")?.confidence).toBe("low");
    expect(card.warnings.some((w) => w.includes("calibration"))).toBe(false);
  });

  it("声明块 high、观察块按证据给 medium/low、derived 的现在=low，不再写死一张表", () => {
    const card = renderPersonaCardV13(baseInput());
    const sourceOf = Object.fromEntries(card.blocks.map((block) => [block.id, block.source]));
    expect(sourceOf).toEqual({
      firstLook: "declared",
      life: "declared",
      character: "observed",
      voice: "declared",
      us: "observed",
      now: "derived",
      memory: "observed",
      boundaries: "declared",
      recent: "observed",
    });
    const confidenceOf = Object.fromEntries(card.blocks.map((block) => [block.id, block.confidence]));
    expect(confidenceOf.firstLook).toBe("high");
    expect(confidenceOf.life).toBe("high");
    expect(confidenceOf.voice).toBe("high");
    expect(confidenceOf.boundaries).toBe("high");
    expect(confidenceOf.now).toBe("low");
    // character 的锚来自带 evidenceIds 的 identity 行 → 有据可查，medium；
    // memory 只有 self 行且没证据 → low。不是一张写死的表。
    expect(confidenceOf.character).toBe("medium");
    expect(confidenceOf.memory).toBe("low");
  });
});

describe("校准全错：把握度往下走，不因数据多就升", () => {
  it("predicted 0.8 全失败 → 没成 3 次 + 报得比实际高约 0.80，confidence=low", () => {
    const bad = renderPersonaCardV13(baseInput({ calibration: calRows("部署", 0.8, "fail", 3) }));
    const text = blockText(bad.text, "记得") ?? "";
    expect(text).toContain("在部署上，我给自己八成把握，3 次里没成 3 次。");
    expect(text).toContain("报得比实际高约 0.80。");
    expect(blockById(bad, "memory")?.confidence).toBe("low");
  });

  it("同样 3 次成功但 predicted 0.9 比全错的高档：残差决定，不看次数", () => {
    const good = renderPersonaCardV13(baseInput({ calibration: calRows("部署", 0.9, "success", 3) }));
    expect(blockById(good, "memory")?.confidence).toBe("high");
    const bad = renderPersonaCardV13(baseInput({ calibration: calRows("部署", 0.8, "fail", 3) }));
    expect(blockById(bad, "memory")?.confidence).toBe("low");
  });
});

describe("hash 与预算", () => {
  it("同数据两次渲染 hash 逐字节相同；新校准行出现才变", () => {
    const rows = calRows("测试", 0.5, "success", 3);
    const first = renderPersonaCardV13(baseInput({ calibration: rows }));
    const second = renderPersonaCardV13(baseInput({ calibration: [...rows] }));
    expect(second.hash).toBe(first.hash);
    expect(second.text).toBe(first.text);

    const withNew = renderPersonaCardV13(baseInput({ calibration: [...rows, cal("测试", 0.5, "success", 4)] }));
    expect(withNew.hash).not.toBe(first.hash);
  });

  it("整卡 ≤2400、身份段 ≤1000、末尾锚 ≤460，超预算先丢最近的变化与生活", () => {
    // 12 条 120 字红线（受保护、不参与单块裁剪）把整卡顶过 2400；
    // 这正是 spec §8 的让位场景：先丢块，再减行，红线一条不丢。
    const redlines = Array.from({ length: 13 }, (_, i) => ({
      text: ("红线" + (i + 1) + "：" + "不虚报进度与结论".repeat(20)).slice(0, 120),
      active: true as const,
      createdAt: "2026-11-10T00:00:00.000Z",
    }));
    const card = renderPersonaCardV13({
      profile: {
        name: "小满",
        selfImage:
          "我是小满。" +
          long(118, "住杭州养一只橘猫，白天写文档，晚上去江边跑步，周末去菜场。") +
          "。" +
          long(118, "周末顺路给邻居带份菜，回来把当天的记录整理成一句一句的话。") +
          "。",
        voice: long(200, "说话一句一句来。"),
        redlines,
      },
      lines: {
        human: [
          { text: "喜欢：" + long(120, "用第一性原理把问题拆到底再动手。") },
          { text: "近况：" + long(120, "关注人格卡是否像个真人，而不是记账工具。") },
          ...Array.from({ length: 3 }, (_, i) => ({ text: `身份第${i + 1}条：` + long(240, "生产人物档案链路的拍板决策人") })),
        ],
        relationship: Array.from({ length: 3 }, (_, i) => ({ text: `你对我的要求第${i + 1}条：` + long(240, "先把证据摆出来") })),
        identity: Array.from({ length: 5 }, (_, i) => ({ text: `行为锚第${i + 1}条：` + long(200, "先复验再改口") })),
        boundary: Array.from({ length: 2 }, (_, i) => ({ text: `边界第${i + 1}条：` + long(200, "不属于我写域就不动手") })),
        self: Array.from({ length: 3 }, (_, i) => ({ text: `我没守住第${i + 1}件：` + long(200, "把没跑过的门禁说成了绿") })),
        narrative: Array.from({ length: 2 }, (_, i) => ({ text: `我放弃的是第${i + 1}件：` + long(200, "站在外面点评的安全感") })),
      },
      calibration: calRows("测试", 0.5, "success", 3),
      version: 1,
    });
    expect(bodyOf(card.text).length).toBeLessThanOrEqual(CARD_V13_MAX_CHARS);
    const segments = buildCardSegmentsV13({
      ...baseInput({ calibration: calRows("测试", 0.5, "success", 3) }),
      profile: {
        name: "小满",
        selfImage: "我是小满。" + long(1200, "住杭州养一只橘猫，白天写文档晚上跑步。"),
        voice: long(200, "说话一句一句来。"),
        redlines: [{ text: "不假装知道没验证过的事实", active: true }],
      },
      lines: {
        human: Array.from({ length: 3 }, (_, i) => ({ text: `身份第${i + 1}条：` + long(240, "生产人物档案链路的拍板决策人") })),
        identity: Array.from({ length: 5 }, (_, i) => ({ text: `行为锚第${i + 1}条：` + long(200, "先复验再改口") })),
        self: Array.from({ length: 3 }, (_, i) => ({ text: `我没守住第${i + 1}件：` + long(200, "把没跑过的门禁说成了绿") })),
        narrative: Array.from({ length: 2 }, (_, i) => ({ text: `我放弃的是第${i + 1}件：` + long(200, "站在外面点评的安全感") })),
      },
    });
    expect(segments.identity.text.length).toBeLessThanOrEqual(CARD_V13_IDENTITY_MAX_CHARS);
    expect(segments.anchor.text.length).toBeLessThanOrEqual(CARD_V13_ANCHOR_MAX_CHARS);

    expect(card.warnings.some((w) => w.includes("丢掉块：最近的变化"))).toBe(true);
    expect(card.warnings.some((w) => w.includes("丢掉块：生活"))).toBe(true);
    // 永不丢：第一眼、性格、边界。
    expect(blockById(card, "firstLook")?.chars).toBeGreaterThan(0);
    expect(blockById(card, "character")?.chars).toBeGreaterThan(0);
    expect(blockById(card, "boundaries")?.chars).toBeGreaterThan(0);
    expect(card.blocks.map((block) => block.id)).toEqual([...CARD_V13_BLOCK_ORDER]);
  });
});
