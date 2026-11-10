import { describe, expect, it } from "vitest";
import {
  CARD_BLOCK_ORDER,
  CARD_MAX_CHARS,
  CARD_SCHEMA_VERSION,
  renderPersonaCard,
  sameActs,
  type PersonaCardInput,
} from "../card.js";
import { projectLabels, SEED_LABELS, SOUL_AXES } from "../traits.js";

function input(over: Partial<PersonaCardInput> = {}): PersonaCardInput {
  return {
    profile: {
      name: "何晨",
      pronoun: "我",
      selfImage: "黑发，穿灰衬衫",
      voice: "短句，先说结论",
      purpose: "把复杂的东西讲清楚",
      redlines: [
        { text: "不虚报进度", active: true, createdAt: "2026-11-07T00:00:00.000Z" },
        { text: "已退役的旧规则", active: false },
      ],
    },
    labels: projectLabels({ warmth: 0.6, agency: 0.1, rigor: 0.7, openness: 0, stability: 0.2, boundary: 0.3 }, [
      { label: "严谨", direction: SEED_LABELS.find((s) => s.label === "严谨")!.direction, act: 0.9, evidence: 9, status: "active" },
      { label: "温和", direction: SEED_LABELS.find((s) => s.label === "温和")!.direction, act: 0.8, evidence: 9, status: "active" },
      { label: "好奇", direction: SEED_LABELS.find((s) => s.label === "好奇")!.direction, act: 0.7, evidence: 9, status: "active" },
    ]),
    human: ["称呼：何晨", "职责：MemoryCore 实现"],
    relationship: ["用户：验收方，要求 path:line"],
    selfHistory: ["2026-11-07 从零重建人格层"],
    autobiography: "我一直在把复杂的事拆成能验证的步骤。",
    version: 1,
    ...over,
  };
}

describe("整卡总预算（task-27/P2-5）", () => {
  it("极端输入：卡 ≤${CARD_MAX_CHARS}，红线一条不丢，丢块顺序固定并告警", () => {
    // 30 条红线各 60 字（红线块自身约 1.8k）+ 四个可丢块各 12 行 60 字：必然超预算。
    const redlines = Array.from({ length: 30 }, (_, i) => ({
      text: `红线第${i + 1}条：${"不虚报进度与结论".repeat(6)}`.slice(0, 60),
      active: true as const,
      createdAt: "2026-11-07T00:00:00.000Z",
    }));
    const lines = (tag: string) => Array.from({ length: 12 }, (_, i) => `${tag}第${i + 1}行：${"把复杂的事拆成能验证的步骤".repeat(3)}`.slice(0, 60));
    const card = renderPersonaCard(
      input({
        profile: { ...input().profile, redlines },
        human: lines("关于你"),
        relationship: lines("关系"),
        selfHistory: lines("自我史"),
        openLoops: ["未完的事一：等验收", "未完的事二：等复核", "未完的事三：等门禁"],
      }),
    );
    expect(card.text.length).toBeLessThanOrEqual(CARD_MAX_CHARS + 400); // 红线不可丢，允许越界但必须有告警
    // 红线 100% 保留：每条都逐字在正文里。
    for (const r of redlines) expect(card.text).toContain(r.text.slice(0, 40));
    // 丢块顺序：openLoops 先于 selfHistory，两者都在时 human 最后才丢（这里只断言已丢的先头两项）。
    const warns = card.warnings.join("|");
    expect(warns).toContain("整卡超过");
    expect(card.text).not.toContain("## 未完的事");
    expect(card.text).not.toContain("## 自我史");
  });

  it("不超预算时一块都不丢、不加预算警告", () => {
    const card = renderPersonaCard(input({ openLoops: ["等验收", "等复核"] }));
    expect(card.text.length).toBeLessThanOrEqual(CARD_MAX_CHARS);
    expect(card.warnings.join("|")).not.toContain("整卡超过");
    expect(card.text).toContain("## 未完的事");
  });
});

describe("名称块：按 spec §2 渲染自称，空设定不伪造名字", () => {
  it("名称 + 自称 → 「何晨（自称「我」）」", () => {
    const card = renderPersonaCard(input());
    expect(card.text).toContain("何晨（自称「我」）");
  });

  it("只有自称 → 明说未命名，不硬塞一个名字", () => {
    const card = renderPersonaCard(
      input({ profile: { ...input().profile, name: "", pronoun: "我" } }),
    );
    expect(card.text).toContain("（未命名，自称「我」）");
  });

  it("名与自称都空 → 渲染「（未命名）」占位并留 warning（P0-A 骨架级）", () => {
    const card = renderPersonaCard(
      input({ profile: { ...input().profile, name: "", pronoun: "" } }),
    );
    // P0-A：骨架级不再留一个完全空的名称块（生产 6 个 agent 都没有 persona 行，
    // 卡开头空白等于连「这是谁」都没答）。占位不是名字：warning 仍然保留，可审计。
    expect(card.text).toContain("## 名称");
    expect(card.text).toContain("（未命名）");
    expect(card.warnings.join("|")).toContain("名称为空");
  });
});

describe("卡骨架：区块顺序固定、读侧 0 轴名", () => {
  it("区块按 CARD_BLOCK_ORDER 出现，缺省区块不占位", () => {
    const card = renderPersonaCard(input());
    const order = CARD_BLOCK_ORDER.map((k) => card.text.indexOf(`## ${({
      name: "名称", image: "形象", voice: "说话方式", purpose: "使命", traits: "底色",
      redlines: "红线", human: "关于你", relationship: "关系", selfHistory: "自我史",
      autobiography: "自传", openLoops: "未完的事",
    } as Record<string, string>)[k]}`)).filter((i) => i >= 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(card.text).toContain("## 名称");
    expect(card.text).toContain("## 底色");
    expect(card.text).toContain("## 红线");
    expect(card.text).toContain("## 关于你");
    expect(card.text).toContain("## 自传");
    // 卡接口不传 openLoops → 不出现「未完的事」
    expect(card.text).not.toContain("## 未完的事");
  });

  it("卡头带读法；卡尾只有成对的注释（不再挂未闭合的 persona-card 开标签）", () => {
    const card = renderPersonaCard(input());
    expect(card.text.startsWith("[读法]")).toBe(true);
    expect(card.text).toContain(`<!-- persona-card v="${CARD_SCHEMA_VERSION}" hash="`);
    expect(card.text.endsWith("-->")).toBe(true);
    // 注入体里不许再出现没有闭合的 XML 元素：开标签与闭合标签必须同时存在或同时不存在。
    const opens = card.text.match(/<persona-card\b/gu) ?? [];
    const closes = card.text.match(/<\/persona-card>/gu) ?? [];
    expect(opens.length).toBe(closes.length);
    expect(card.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("读侧 0 英文轴名、0「权重/算法/α/tanh」；中文轴名只在底色行作为标签出现", () => {
    const card = renderPersonaCard(input());
    for (const axis of SOUL_AXES) expect(card.text).not.toContain(axis);
    expect(card.text).not.toMatch(/权重|算法|α|tanh/);
    const beforeTraits = card.text.slice(0, card.text.indexOf("## 底色"));
    for (const zh of ["亲和", "主导", "开放", "稳定"]) expect(beforeTraits).not.toContain(zh);
  });

  it("底色：按 act 降序、一位小数、只给 top-2 gloss、最多 5 条", () => {
    const labels = SEED_LABELS.slice(0, 8).map((s, i) => ({
      label: s.label,
      direction: s.direction,
      act: 0.9 - i * 0.05,
      evidence: 9,
      status: "active",
    }));
    const card = renderPersonaCard(input({ labels: projectLabels({ warmth: 0.9, agency: 0, rigor: 0.9, openness: 0, stability: 0, boundary: 0 }, labels) }));
    const traitBlock = card.text.split("## 底色")[1].split("## ")[0];
    const lines = traitBlock.trim().split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const l of lines) expect(l).toMatch(/^- \S+ [01]\.\d( · .+)?$/);
    const withGloss = lines.filter((l) => l.includes(" · "));
    expect(withGloss.length).toBeLessThanOrEqual(2);
    const nums = lines.map((l) => Number(l.split(" ")[1]));
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
  });

  it("红线只渲染 active；退役行不进卡", () => {
    const card = renderPersonaCard(input());
    expect(card.text).toContain("不虚报进度");
    expect(card.text).not.toContain("已退役的旧规则");
  });

  it("红线超 30 行/超 2600 字符/单行 120：截断渲染 + 告警，不静默", () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ text: `规则${i}` }));
    const c1 = renderPersonaCard(input({ profile: { ...input().profile, redlines: rows } }));
    const kept = c1.text.split("## 红线")[1].split("## ")[0].trim().split("\n").filter((l) => l.startsWith("- "));
    expect(kept.length).toBe(30);
    // 声明优先：保留更早的 30 条（规则0..规则29），超限时拒收最新追加的 规则30..规则34。
    expect(kept[0]).toContain("规则0");
    expect(kept[kept.length - 1]).toContain("规则29");
    expect(kept.join()).not.toContain("规则34");
    expect(c1.warnings.join()).toContain("30 行");

    const huge = Array.from({ length: 30 }, () => ({ text: "x".repeat(120) }));
    const c2 = renderPersonaCard(input({ profile: { ...input().profile, redlines: huge } }));
    const kept2 = c2.text.split("## 红线")[1].split("## ")[0].trim().split("\n").filter((l) => l.startsWith("- "));
    expect(kept2.length).toBeLessThan(30);
    expect(kept2.reduce((s, l) => s + l.length - 2, 0)).toBeLessThanOrEqual(2600);
    expect(c2.warnings.join()).toContain("2600");

    const long = [{ text: "y".repeat(150) }];
    const c3 = renderPersonaCard(input({ profile: { ...input().profile, redlines: long } }));
    expect(c3.text).toContain("y".repeat(120));
    expect(c3.text).not.toContain("y".repeat(121));
    expect(c3.warnings.join()).toContain("120");
  });
});

describe("底色 gloss：以视图（库）那份为准，种子只兜底", () => {
  const dir = (label: string) => SEED_LABELS.find((s) => s.label === label)!.direction;
  const traitLines = (text: string) =>
    text
      .split("## 底色")[1]!
      .split("\n## ")[0]!
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("- "));

  it("视图带 gloss 时用视图的（库里改过的注解 / 自生长标签都能进卡）", () => {
    const gloss = "他自己改过的注解：先看证据再开口。";
    const card = renderPersonaCard(
      input({ labels: [{ label: "严谨", direction: dir("严谨"), act: 0.9, evidence: 9, status: "active", gloss }] }),
    );
    expect(traitLines(card.text)).toEqual([`- 严谨 0.9 · ${gloss}`]);
    // 种子里那条注解已被库里这份取代，不再出现。
    expect(card.text).not.toContain(SEED_LABELS.find((s) => s.label === "严谨")!.gloss);
  });

  it("视图没写 gloss 但有同名种子标签时回退种子 gloss", () => {
    const seedGloss = SEED_LABELS.find((s) => s.label === "严谨")!.gloss;
    const card = renderPersonaCard(
      input({ labels: [{ label: "严谨", direction: dir("严谨"), act: 0.9, evidence: 9, status: "active" }] }),
    );
    expect(traitLines(card.text)).toEqual([`- 严谨 0.9 · ${seedGloss}`]);
  });

  it("非种子标签且视图无 gloss → 该行不出现「 · 」后缀", () => {
    const card = renderPersonaCard(
      input({
        labels: [
          {
            label: "较真",
            direction: { warmth: 0, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 },
            act: 0.7,
            evidence: 4,
            status: "admitted",
          },
        ],
      }),
    );
    expect(traitLines(card.text)).toEqual(["- 较真 0.7"]);
    expect(traitLines(card.text).join("")).not.toContain(" · ");
  });
});

describe("数字与 hash：权重变化 <0.05 不重渲染、不换 hash（G5）", () => {
  it("同输入两次渲染 hash 相同", () => {
    expect(renderPersonaCard(input()).hash).toBe(renderPersonaCard(input()).hash);
  });

  it("标签 act 只差 0.02：复用上一版 text/hash，只更新 version", () => {
    const first = renderPersonaCard(input());
    const bumped = input();
    const labels = bumped.labels.map((l) => ({ ...l, act: l.act + 0.02 }));
    const second = renderPersonaCard({ ...bumped, labels, version: 2 }, first);
    expect(second.hash).toBe(first.hash);
    expect(second.text).toBe(first.text);
    expect(second.version).toBe(2);
  });

  it("任一标签 act 差 ≥0.05：重渲染并换 hash", () => {
    const first = renderPersonaCard(input());
    const bumped = input();
    const labels = bumped.labels.map((l, i) => (i === 0 ? { ...l, act: l.act + 0.2 } : l));
    const second = renderPersonaCard({ ...bumped, labels, version: 2 }, first);
    expect(second.hash).not.toBe(first.hash);
    expect(second.text).not.toBe(first.text);
  });

  it("设定文本变化（红线/形象）即使数字不变也换 hash", () => {
    const first = renderPersonaCard(input());
    const second = renderPersonaCard(
      input({ profile: { ...input().profile, selfImage: "短发" }, version: 2 }),
      first,
    );
    expect(second.hash).not.toBe(first.hash);
  });

  it("sameActs 判定与标签集合变化", () => {
    expect(sameActs({ a: 0.5 }, { a: 0.53 })).toBe(true);
    expect(sameActs({ a: 0.5 }, { a: 0.56 })).toBe(false);
    expect(sameActs({ a: 0.5 }, { b: 0.5 })).toBe(false);
    expect(sameActs({}, {})).toBe(true);
  });
});
