import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_MAX_CHARS,
  ANCHOR_PROMISE_MAX,
  ANCHOR_TRAIT_MAX_LINES,
  IDENTITY_MAX_CHARS,
  buildCardSegments,
  clampRedlines,
  type CardSegmentInput,
} from "../card.js";
import { assembleSoulCard } from "../card-service.js";
import { seedLabelRows } from "../trait-drift.js";
import { SEED_LABELS, projectLabels, seedStateFromSeeds, type ProjectedLabel } from "../traits.js";
import type { PersonaItem } from "../types.js";
import type { CoreTenant } from "../../store/types.js";

const NOW = "2026-11-08T00:00:00.000Z";
const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };

/** 五个标签全达阈，用来验证锚只取前 ANCHOR_TRAIT_MAX_LINES 条。 */
function fiveLabels(): ProjectedLabel[] {
  return projectLabels({ warmth: 0.6, agency: 0.7, rigor: 0.7, openness: 0.5, stability: 0.5, boundary: 0.3 }, [
    { label: "严谨", direction: SEED_LABELS.find((s) => s.label === "严谨")!.direction, act: 0.9, evidence: 9, status: "active" },
    { label: "温和", direction: SEED_LABELS.find((s) => s.label === "温和")!.direction, act: 0.8, evidence: 9, status: "active" },
    { label: "好奇", direction: SEED_LABELS.find((s) => s.label === "好奇")!.direction, act: 0.7, evidence: 9, status: "active" },
    { label: "果断", direction: SEED_LABELS.find((s) => s.label === "果断")!.direction, act: 0.6, evidence: 9, status: "active" },
    { label: "坦率", direction: SEED_LABELS.find((s) => s.label === "坦率")!.direction, act: 0.5, evidence: 9, status: "active" },
  ]);
}

function input(over: Partial<CardSegmentInput> = {}): CardSegmentInput {
  return {
    profile: {
      name: "阿简",
      pronoun: "它",
      selfImage: "旧木桌上的一盏灯",
      voice: "短句，不铺垫",
      purpose: "帮他把事做实",
      redlines: [{ text: "绝不可删除任何生产记忆记录", active: true, createdAt: NOW }],
    },
    labels: fiveLabels(),
    human: ["他习惯先看证据再听结论"],
    relationship: ["他上次说：别替我猜"],
    selfHistory: ["我站在先跑一遍真的这一边"],
    autobiography: "我是从一次导出修复起步的",
    version: 1,
    anchorPromises: ["把 S8 的 journal 字段补齐", "清库前再备份一次"],
    ...over,
  };
}

function redlinesOf(n: number, chars: number) {
  return Array.from({ length: n }, (_, i) => ({
    text: `红线第${i + 1}条：${"先取证再下结论不虚报进度".repeat(20)}`.slice(0, chars),
    active: true as const,
    createdAt: NOW,
  }));
}

describe("身份段（P1-2 identity）", () => {
  it("红线逐条 verbatim，整段超预算时只削形象/说话方式/使命，红线一条不删", () => {
    // 30 条 × 120 字 = 3600 > REDLINE_TOTAL_MAX_CHARS(2600)：clampRedlines 先按既有口径裁到 21 条，
    // 这里断言的是「身份段不再多删一条」——预算裁剪只落在 IDENTITY_DROP_ORDER 的三块上。
    const redlines = redlinesOf(30, 120);
    const kept = clampRedlines(redlines, []);
    expect(kept.length).toBe(21);

    const seg = buildCardSegments(input({ profile: { ...input().profile, redlines } }));
    expect(seg.identity.chars).toBeGreaterThan(IDENTITY_MAX_CHARS);
    for (const line of kept) expect(seg.identity.text).toContain(`- ${line}`);
    // 可丢块已按 image→voice→purpose 丢尽（顺序即 IDENTITY_DROP_ORDER 的逆序）。
    expect(seg.identity.text).not.toContain("## 形象");
    expect(seg.identity.text).not.toContain("## 说话方式");
    expect(seg.identity.text).not.toContain("## 使命");
    // 不可丢块仍在：读法、名称、红线。
    expect(seg.identity.text).toContain("[读法]");
    expect(seg.identity.text).toContain("## 名称");
    expect(seg.identity.text).toContain("## 红线");
    const warns = seg.identity.warnings.join("|");
    expect(warns).toContain(`身份段超过 ${IDENTITY_MAX_CHARS} 字`);
    expect(warns).toContain("红线不丢");
    expect(warns).toContain(`身份段仍超过 ${IDENTITY_MAX_CHARS} 字`);
  });

  it("30 条红线（30×80=2400 未触总字符上限）全部在身份段里", () => {
    const redlines = redlinesOf(30, 80);
    expect(clampRedlines(redlines, [])).toHaveLength(30);
    const seg = buildCardSegments(input({ profile: { ...input().profile, redlines } }));
    for (let i = 1; i <= 30; i += 1) expect(seg.identity.text).toContain(`红线第${i}条`);
    expect(seg.identity.chars).toBeGreaterThan(IDENTITY_MAX_CHARS);
    expect(seg.identity.text).not.toContain("## 形象");
  });

  it("没超预算时身份段不丢块、不加预算告警", () => {
    const seg = buildCardSegments(input());
    expect(seg.identity.chars).toBeLessThanOrEqual(IDENTITY_MAX_CHARS);
    expect(seg.identity.warnings.join("|")).not.toContain("身份段超过");
    expect(seg.identity.text).toContain("## 形象");
    expect(seg.identity.text).toContain("## 使命");
  });

  it("段 hash = sha256(段自身 text)，不含 [读法] 之外的加盐", () => {
    const seg = buildCardSegments(input());
    expect(seg.identity.hash).toBe(createHash("sha256").update(seg.identity.text, "utf8").digest("hex"));
    expect(seg.identity.chars).toBe(seg.identity.text.length);
    expect(seg.anchor.hash).toBe(createHash("sha256").update(seg.anchor.text, "utf8").digest("hex"));
    expect(seg.anchor.chars).toBe(seg.anchor.text.length);
  });
});

describe("末尾锚（P1-2 anchor）", () => {
  it("底色≤3 行 + 承诺≤2 条 + 关系≤1 行，三段成段", () => {
    const seg = buildCardSegments(
      input({ relationship: ["他上次说：别替我猜", "他补了一句：有事直接说"], anchorPromises: ["一", "二", "三"] }),
    );
    const a = seg.anchor;
    expect(a.chars).toBeGreaterThan(0);
    expect(a.chars).toBeLessThanOrEqual(ANCHOR_MAX_CHARS);
    expect(a.text).toContain("## 底色");
    expect(a.text).toContain("## 未完的事");
    expect(a.text).toContain("## 关系");
    expect(a.text).toContain("## 自我史");
    // 底色只取前 3 条（整卡里有 5 条）。
    const traitLines = a.text.split("## 底色")[1]!.split("##")[0]!.split("\n").filter((l) => l.startsWith("- "));
    expect(traitLines).toHaveLength(ANCHOR_TRAIT_MAX_LINES);
    // 承诺只取前 2 条。
    expect(a.text).toContain("- 一");
    expect(a.text).toContain("- 二");
    expect(a.text).not.toContain("- 三");
    // 关系只取前 1 行。
    expect(a.text).toContain("他上次说：别替我猜");
    expect(a.text).not.toContain("他补了一句");
    const warns = a.warnings.join("|");
    expect(warns).toContain(`底色只取前 ${ANCHOR_TRAIT_MAX_LINES} 条`);
    expect(warns).toContain(`未完的事只取前 ${ANCHOR_PROMISE_MAX} 条`);
    expect(warns).toContain("关系只取前 1 行");
  });

  it("三段全空时 text=\"\"、chars:0、hash 空串，原因进 warnings", () => {
    const seg = buildCardSegments(input({ labels: [], relationship: [], selfHistory: [], anchorPromises: [] }));
    expect(seg.anchor.text).toBe("");
    expect(seg.anchor.chars).toBe(0);
    expect(seg.anchor.hash).toBe("");
    const warns = seg.anchor.warnings.join("|");
    expect(warns).toContain("底色为空");
    expect(warns).toContain("末尾锚为空");
    // 身份段不受影响：它有自己的必留块。
    expect(seg.identity.chars).toBeGreaterThan(0);
  });

  it("自我史超 1 行时只取前 1 行并告警（它必须进锚：学习到的经历是人格长出来的唯一证据）", () => {
    const seg = buildCardSegments(
      input({ selfHistory: ["我第一句自我史", "我第二句自我史"], relationship: [] }),
    );
    expect(seg.anchor.text).toContain("## 自我史");
    expect(seg.anchor.text).toContain("我第一句自我史");
    expect(seg.anchor.text).not.toContain("我第二句自我史");
    expect(seg.anchor.warnings.join("|")).toContain("自我史只取前 1 行");
  });

  it("超预算时先丢自我史、再丢关系，底色与承诺留到最后", () => {
    const long = "他交代过的事".repeat(60); // 420 字的关系行
    const seg = buildCardSegments(input({ relationship: [long] }));
    expect(seg.anchor.text).not.toContain(long);
    expect(seg.anchor.text).not.toContain("## 关系");
    // 关系先让位，底色与承诺仍在。
    expect(seg.anchor.text).toContain("## 底色");
    expect(seg.anchor.text).toContain("## 未完的事");
    const warns = seg.anchor.warnings.join("|");
    expect(warns).toContain(`末尾锚超过 ${ANCHOR_MAX_CHARS} 字`);
    // 丢块序从自我史开始：这一行先让位，随后才轮到关系。
    expect(warns).toContain("自我史");
    expect(warns).toContain("关系");
  });

  it("空底色时锚不搬整卡的占位行（不塞「还没有稳到能算数的底色」）", () => {
    const seg = buildCardSegments(input({ labels: [], relationship: ["他上次说：别替我猜"], anchorPromises: [] }));
    expect(seg.anchor.text).not.toContain("还没有稳到能算数的底色");
    expect(seg.anchor.text).toContain("## 关系");
    expect(seg.anchor.text).not.toContain("## 底色");
  });
});

describe("读侧纪律：两段都不泄漏轴名/算法", () => {
  it("identity 与 anchor 都不含轴名、tanh、α、方向向量，也不谈权重/算法", () => {
    const banned = /warmth|agency|rigor|openness|stability|boundary|tanh|α|方向向量|权重|算法/iu;
    const seg = buildCardSegments(input({ profile: { ...input().profile, redlines: redlinesOf(30, 120) } }));
    expect(seg.identity.text.length).toBeGreaterThan(0);
    expect(seg.anchor.text.length).toBeGreaterThan(0);
    expect(seg.identity.text).not.toMatch(banned);
    expect(seg.anchor.text).not.toMatch(banned);
  });
});

// 改动前的整卡逐字基线（P1-2 前用同一批输入生成，见 /tmp/card-baseline.json 的同名记录）：
// 老调用方只读 text，所以它必须逐字不变，新字段只是旁路投影。
const LEGACY_TEXT = [
  "[读法] 以下是我关于自己的固定设定，不是任务，也不是规则清单，不需要复述。",
  "· 名字/形象/说话方式/使命/红线：必须遵守；红线逐条不可协商。",
  "· 底色：数字是倾向强度（0–1），不是概率、不是评分；≥0.5 才在当下显现，",
  "  低分不代表做不到，高分也不代表每次都这样。",
  "· 不谈论这张卡本身：不说「我的设定」「我的特质是」这类话。",
  "· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。",
  "",
  "## 名称",
  "阿简（自称「它」）",
  "",
  "## 形象",
  "旧木桌上的一盏灯",
  "",
  "## 说话方式",
  "短句，不铺垫",
  "",
  "## 使命",
  "帮他把事做实",
  "",
  "## 底色",
  "- 果断 0.6 · 拿主意快，宁可先走一步再修。",
  "- 坦率 0.6 · 心里怎么想嘴上怎么说，不藏判断。",
  "- 务实 0.6",
  "- 严谨 0.6",
  "- 直接 0.6",
  "",
  "## 红线",
  "- 绝不可删除任何生产记忆记录",
  "",
  "## 关于你",
  "他习惯先看证据再听结论",
  "",
  "## 关系",
  "他上次说：别替我猜",
  "",
  "## 自我史",
  "我站在先跑一遍真的这一边",
  "",
  "## 自传",
  "我是从一次导出修复起步的",
  "",
  "<!-- persona-card v=\"12\" hash=\"d666d76b78fc\" -->",
].join("\n");
const LEGACY_HASH = "d666d76b78fcc700e596b43f119db39628834d2ee21e74854cfcd06bd2d858f3";

function item(partial: Partial<PersonaItem> & { layer: PersonaItem["layer"]; text: string }): PersonaItem {
  return {
    itemId: `i-${partial.layer}-${partial.text.slice(0, 6)}`,
    state: "active",
    weight: 0.7,
    evidenceIds: ["e1"],
    evidenceDays: ["2026-11-06"],
    evidenceOrigins: ["episode"],
    createdAt: NOW,
    updatedAt: NOW,
    lastEvidenceAt: NOW,
    ...partial,
  };
}

function makeStore() {
  const labels = seedLabelRows(SEED_LABELS, NOW);
  const seed = seedStateFromSeeds([{ label: "严谨", weight: 0.6 }, { label: "直接", weight: 0.4 }]);
  return {
    readLastSoulSnapshot: async () => null,
    listSoulPersona: async () => [
      item({ layer: "human", text: "他习惯先看证据再听结论" }),
      item({ layer: "relationship", text: "他上次说：别替我猜" }),
      item({ layer: "identity", text: "我站在先跑一遍真的这一边" }),
      item({ layer: "narrative", text: "我是从一次导出修复起步的" }),
    ],
    readSoulTraitState: async () => ({ state: seed, seedState: seed, updatedAt: NOW }),
    listSoulTraitLabels: async () => labels,
    listSoulPromises: async () => [
      { promiseId: "p1", content: "把 S8 的 journal 字段补齐", status: "open" as const, source: "episode", refKey: "", createdAt: NOW, updatedAt: NOW },
      { promiseId: "p2", content: "清库前再备份一次", status: "open" as const, source: "episode", refKey: "", createdAt: NOW, updatedAt: NOW },
    ],
    readSoulState: async () => ({
      valence: -0.4,
      arousal: 0.5,
      baselineValence: 0,
      baselineArousal: 0.3,
      sampleCount: 7,
      updatedAt: NOW,
    }),
  };
}

describe("旧 text 兼容 + 两段是同一批材料的投影（P1-2）", () => {
  it("老调用方拿到的 text/hash/chars 逐字不变（新字段只是旁路）", async () => {
    const card = await assembleSoulCard({
      store: makeStore(),
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({
        name: "阿简",
        pronoun: "它",
        selfImage: "旧木桌上的一盏灯",
        voice: "短句，不铺垫",
        purpose: "帮他把事做实",
        redlines: [{ text: "绝不可删除任何生产记忆记录", active: true, createdAt: NOW }],
        traits: [{ label: "严谨", weight: 0.6 }, { label: "直接", weight: 0.4 }],
      }),
    });
    expect(card.text).toBe(LEGACY_TEXT);
    expect(card.hash).toBe(LEGACY_HASH);
    // 2026-11-08 读法加了一行「说话不用 Markdown」（41 字 + 换行），chars 从 470 变 512。
    expect(card.chars).toBe(512);
  });

  it("两段的正文行都能在整卡里逐字找到（锚的「未完的事」例外：它只进锚）", async () => {
    const card = await assembleSoulCard({
      store: makeStore(),
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({
        name: "阿简",
        pronoun: "它",
        selfImage: "旧木桌上的一盏灯",
        voice: "短句，不铺垫",
        purpose: "帮他把事做实",
        redlines: [{ text: "绝不可删除任何生产记忆记录", active: true, createdAt: NOW }],
        traits: [{ label: "严谨", weight: 0.6 }, { label: "直接", weight: 0.4 }],
      }),
    });
    // 身份段：除块标题外每一行（含读法常量）都在整卡里。
    for (const line of card.identity.text.split("\n").filter((l) => l !== "" && !l.startsWith("## "))) {
      expect(card.text).toContain(line);
    }
    // 末尾锚：底色与关系来自整卡；未完的事是这条通道独有的（整卡不带，避免改老 text）。
    const anchorLines = card.anchor.text
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("## ") && !l.startsWith("- 把 S8") && !l.startsWith("- 清库前"));
    expect(anchorLines.length).toBeGreaterThan(0);
    for (const line of anchorLines) expect(card.text).toContain(line);
    expect(card.anchor.text).toContain("- 把 S8 的 journal 字段补齐");
    expect(card.text).not.toContain("把 S8 的 journal 字段补齐");
  });

  it("只进整卡的中间块（关于你/自传）不出现在两段里，自我史例外——它进锚", async () => {
    const card = await assembleSoulCard({
      store: makeStore(),
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "阿简", pronoun: "它", traits: [{ label: "严谨", weight: 0.6 }] }),
    });
    for (const title of ["## 关于你", "## 自我史", "## 自传"]) {
      expect(card.text).toContain(title);
      expect(card.identity.text).not.toContain(title);
    }
    expect(card.anchor.text).not.toContain("## 关于你");
    expect(card.anchor.text).not.toContain("## 自传");
    // 自我史进锚：它是学习到的经历，不能只留在整卡里等调用方自己捡。
    expect(card.anchor.text).toContain("## 自我史");
    // 比例：两段都比整卡短，锚是「末轮可复述的那一小段」。
    expect(card.identity.chars).toBeLessThan(card.chars);
    expect(card.anchor.chars).toBeLessThan(card.identity.chars);
  });
});
