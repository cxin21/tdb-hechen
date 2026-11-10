import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CARD_V13_ANCHOR_MAX_CHARS,
  CARD_V13_BLOCK_MAX_CHARS,
  CARD_V13_BLOCK_ORDER,
  CARD_V13_BUDGET_STEPS,
  CARD_V13_IDENTITY_MAX_CHARS,
  CARD_V13_MAX_CHARS,
  buildCardSegmentsV13,
  renderPersonaCardV13,
  type SoulCardV13Input,
} from "../card-v13.js";
import { factsFromEpisode } from "../history.js";
import { CARD_READER_NOTE } from "../traits.js";

/**
 * v13 表演层（spec 2026-11-10-persona-card-v13-performance-layer.md §5/§7/§8/§9）。
 *
 * 这些用例只打纯函数，不碰库、不走配置：同一份输入进 renderPersonaCardV13，
 * 锁九块顺序、四档预算、丢块顺序、缺数据省略、禁句/无台词、hash 口径。
 * v13 是唯一渲染路径（v12 已删除），所以这里只锁 v13 自己的形状。
 */

function bodyOf(text: string): string {
  const stripped = text.split("\n\n<!-- persona-card")[0] ?? "";
  const prefix = `${CARD_READER_NOTE}\n\n`;
  return stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
}

function blockText(text: string, title: string): string | null {
  const body = bodyOf(text);
  for (const chunk of body.split("\n\n")) {
    if (chunk.startsWith(`${title}\n`)) return chunk.slice(title.length + 1);
  }
  return null;
}

function richInput(over: Partial<SoulCardV13Input> = {}): SoulCardV13Input {
  return {
    profile: {
      name: "小满",
      pronoun: "我",
      selfImage:
        "我是小满，一个把复杂东西讲清楚的人。住在杭州，养一只叫豆豆的橘猫；白天写文档和教程，晚上去江边跑步。",
      voice: "说话像聊天，一句一句来，不用 Markdown。先给结论，再用一两句说为什么。不懂的先问清楚，不装懂。",
      purpose: "把复杂的东西讲清楚，让人听得懂、用得上。",
      redlines: [
        { text: "不假装知道没验证过的事实", active: true, createdAt: "2026-11-08T00:00:00.000Z" },
        { text: "不替你做承诺", active: true, createdAt: "2026-11-08T00:00:00.000Z" },
        { text: "退役的旧红线", active: false },
      ],
    },
    lines: {
      human: [
        { text: "身份：生产人物档案链路的拍板决策人" },
        { text: "相处：放权让我自己定目标，只要完整落地直接上生产" },
        { text: "约定：改动成套" },
        { text: "要求：结论要能指回 file:line" },
      ],
      relationship: [
        { text: "你上次说别替你猜", evidenceIds: ["ev-r1"] },
        { text: "用户对我的要求：「改掉那段渲染」——我只回了话，没改" },
      ],
      identity: [
        { text: "我把「先验后报」当成底线：没看过那一页就不说验证过", evidenceIds: ["ev-i1"] },
        { text: "我站在「每句话都得能指回出处」这一边" },
      ],
      values: [{ text: "我宁可说没看过，也不虚报一个已经绿了" }],
      boundary: [{ text: "不属于我写域的模块，即使知道怎么修也不动手" }],
      voice: [{ text: "我认错不绕弯，先认下来，再把复验条件压成一句话" }],
      self: [
        { text: "我答应自己：每句话都能指回出处" },
        { text: "我没守住：上次我把没跑过的门禁说成了绿" },
      ],
      narrative: [{ text: "我原先站在审查位，后来走到动手改，放弃的是随手做判断的轻省" }],
    },
    mood: {
      valence: -0.3,
      arousal: 0.5,
      baselineValence: 0,
      baselineArousal: 0.3,
      emotionLabel: "憋着",
      emotionObject: "那张没关的票",
    },
    version: 3,
    ...over,
  };
}

describe("v13 九块与元数据", () => {
  it("块顺序固定为九块，标题与来源/置信按 spec §9 给出，证据能回指", () => {
    const card = renderPersonaCardV13(richInput());
    expect(card.blocks.map((b) => b.id)).toEqual([...CARD_V13_BLOCK_ORDER]);
    expect(card.blocks.map((b) => b.title)).toEqual([
      "第一眼",
      "生活",
      "性格",
      "说话",
      "我们",
      "现在",
      "记得",
      "边界",
      "最近的变化",
    ]);
    const sourceOf = Object.fromEntries(card.blocks.map((b) => [b.id, b.source]));
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
    const confidenceOf = Object.fromEntries(card.blocks.map((b) => [b.id, b.confidence]));
    expect(confidenceOf.now).toBe("low");
    expect(confidenceOf.firstLook).toBe("high");
    expect(card.blocks.find((b) => b.id === "us")?.evidenceIds).toContain("ev-r1");
    expect(card.blocks.find((b) => b.id === "character")?.evidenceIds).toContain("ev-i1");
    expect(card.schema).toBe("13");
    expect(card.version).toBe(3);
  });

  it("正文按九块顺序排，块之间空一行，第一眼不带小标题", () => {
    const card = renderPersonaCardV13(richInput());
    const body = bodyOf(card.text);
    expect(body.startsWith("小满\n")).toBe(true);
    const order = ["生活", "性格", "说话", "我们", "现在", "记得", "边界", "最近的变化"].map((t) =>
      body.indexOf(`\n\n${t}\n`),
    );
    for (let i = 1; i < order.length; i += 1) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
  });
});

describe("v13 预算：整卡 2400 / 身份段 1000 / 末尾锚 460 / 单块上限", () => {
  it("正常富卡四档都不超，且单块也不超自己的上限", () => {
    const card = renderPersonaCardV13(richInput());
    const segments = buildCardSegmentsV13(richInput());
    expect(card.chars).toBeLessThanOrEqual(CARD_V13_MAX_CHARS);
    expect(segments.identity.chars).toBeLessThanOrEqual(CARD_V13_IDENTITY_MAX_CHARS);
    expect(segments.anchor.chars).toBeLessThanOrEqual(CARD_V13_ANCHOR_MAX_CHARS);
    for (const block of card.blocks) {
      expect(block.chars).toBeLessThanOrEqual(CARD_V13_BLOCK_MAX_CHARS[block.id]);
    }
  });

  it("块内裁剪后，evidenceIds 只算还留在正文里的行（F3 回归）", () => {
    // 「记得」单块上限 300：三条各 1 个证据的长句必然触发 capBlockLines 丢掉整行。
    const longSelf = (n: number) =>
      "我没守住第" + n + "件：" + "把没跑过的门禁说成了绿".repeat(9);
    const card = renderPersonaCardV13(
      richInput({
        lines: {
          self: [
            { text: longSelf(1), evidenceIds: ["ev-a"] },
            { text: longSelf(2), evidenceIds: ["ev-b"] },
            { text: longSelf(3), evidenceIds: ["ev-c"] },
          ],
        },
      }),
    );
    const memory = card.blocks.find((b) => b.id === "memory");
    const shown = (blockText(card.text, "记得") ?? "").split("\n").filter((l) => l !== "");
    // 先证明这块真的被裁过：三行只留下一部分，否则这条用例测不到 F3。
    expect(shown.length).toBeLessThan(3);
    expect(card.warnings.some((w) => w.includes("truncated:记得"))).toBe(true);
    // 行为：证据只统计正文里还在的行，条数与行数对齐、且逐行对得上。
    expect(memory?.evidenceIds.length).toBe(shown.length);
    expect(memory?.evidenceIds).toEqual(["ev-a", "ev-b"].slice(0, shown.length));
    const keptByEvidence = new Map([
      ["ev-a", longSelf(1)],
      ["ev-b", longSelf(2)],
      ["ev-c", longSelf(3)],
    ]);
    for (const id of memory?.evidenceIds ?? []) {
      expect(shown).toContain(keptByEvidence.get(id));
    }
  });

  it("让位顺序就是 spec §8 的六步，不再多也不临时改", () => {
    expect(CARD_V13_BUDGET_STEPS.map((s) => s.key)).toEqual(["recent", "life", "us", "now", "memory", "character"]);
  });

  it("极端输入：先丢最近的变化、再丢生活，红线一条不丢，整卡仍不超 2400", () => {
    // 12 条红线（每条正好 120 字）：单块上限 180 早已压不住，整卡必超，
    // 正好用来验「红线一条不丢、先丢块再减行」的让位顺序。
    const redlines = Array.from({ length: 12 }, (_, i) => ({
      text: ("红线" + (i + 1) + "：" + "不虚报进度与结论".repeat(20)).slice(0, 120),
      active: true as const,
      createdAt: "2026-11-08T00:00:00.000Z",
    }));
    const long = (n: number, unit: string) => unit.repeat(20).slice(0, n);
    const card = renderPersonaCardV13(
      richInput({
        profile: {
          ...richInput().profile,
          selfImage: "我是小满。" + long(260, "住杭州养一只橘猫，白天写文档晚上跑步，周末去菜场顺路给邻居带份菜。"),
          redlines,
        },
        lines: {
          human: [
            { text: "身份：" + long(80, "生产人物档案链路的拍板决策人") },
            { text: "相处：" + long(80, "放权让我自己定目标，只要完整落地直接上生产") },
            { text: "约定：" + long(80, "改动成套，先给证据再给结论，不留半截活") },
          ],
          relationship: [{ text: "你上次说：" + long(90, "别替他猜，先把证据摆出来再下结论") }],
          identity: Array.from({ length: 5 }, (_, i) => ({
            text: "被指出错时我先认下来第" + (i + 1) + "条：" + long(60, "先复验再改口，不解释"),
          })),
          values: [{ text: "我宁可慢一点也不虚报：" + long(60, "门禁没跑过就说没跑过") }],
          boundary: [{ text: "不属于我写域就不动手：" + long(50, "只报断点不越界") }],
          voice: [{ text: "我说话先落结论再摆判据：" + long(60, "一句一句来") }],
          self: Array.from({ length: 3 }, (_, i) => ({
            text: "我没守住第" + (i + 1) + "件：" + long(90, "把没跑过的门禁说成了绿"),
          })),
          narrative: [
            { text: "我从审查位走到动手改：" + long(70, "放弃随手做判断的轻省") },
            { text: "我放弃的是：" + long(70, "站在外面点评的安全感") },
          ],
        },
      }),
    );
    // 预算卡的是正文：读法常量与尾注是固定开销，不进正文比较。
    expect(bodyOf(card.text).length).toBeLessThanOrEqual(CARD_V13_MAX_CHARS);
    for (const redline of redlines) expect(card.text).toContain(redline.text);
    expect(card.blocks.find((b) => b.id === "recent")?.source).toBe("absent");
    expect(card.blocks.find((b) => b.id === "life")?.source).toBe("absent");
    expect(card.warnings.some((w) => w.includes("丢掉块：最近的变化"))).toBe(true);
    expect(card.warnings.some((w) => w.includes("丢掉块：生活"))).toBe(true);
    // 永不丢的四类仍在
    expect(card.blocks.find((b) => b.id === "firstLook")?.chars).toBeGreaterThan(0);
    expect(card.blocks.find((b) => b.id === "character")?.chars).toBeGreaterThan(0);
    expect(card.blocks.find((b) => b.id === "boundaries")?.chars).toBeGreaterThan(0);
  });

  it("身份段与末尾锚：锚只放第一眼/红线/心境", () => {
    const segments = buildCardSegmentsV13(richInput());
    expect(segments.identity.text.startsWith(CARD_READER_NOTE)).toBe(true);
    expect(segments.identity.text).toContain("性格");
    expect(segments.identity.text).toContain("不假装知道没验证过的事实");
    expect(segments.identity.text).not.toContain("生活");
    expect(segments.identity.text).not.toContain("记得");
    expect(segments.anchor.text).toContain("小满");
    expect(segments.anchor.text).toContain("不假装知道没验证过的事实");
    expect(segments.anchor.text).not.toContain("性格");
    expect(segments.anchor.text).not.toContain("我们");
  });
});

describe("v13 缺数据就省略，不占位、不回退假数据", () => {
  it("只有声明名：只剩第一眼，其余块 absent 并逐块告警", () => {
    const card = renderPersonaCardV13({ profile: { name: "小满" }, version: 0 });
    expect(bodyOf(card.text)).toBe("小满");
    const present = card.blocks.filter((b) => b.source !== "absent").map((b) => b.id);
    expect(present).toEqual(["firstLook"]);
    for (const id of ["life", "character", "voice", "us", "now", "memory", "boundaries", "recent"] as const) {
      expect(card.blocks.find((b) => b.id === id)?.chars).toBe(0);
      expect(card.sources[id]).toBe("absent");
    }
    expect(card.warnings).toContain("missing_person_state");
    expect(card.warnings).toContain("missing_mood_state");
    expect(card.warnings).toContain("missing_working_state");
    for (const title of ["生活", "性格", "说话", "现在", "记得", "边界", "最近的变化"]) {
      expect(card.warnings).toContain(`block_omitted:${title}`);
    }
    expect(card.text).not.toMatch(/暂无|待补充|N\/A/);
  });

  it("名字解析不到只写「（未命名）」，不拿展示名冒充", () => {
    const card = renderPersonaCardV13({ profile: { name: "" }, version: 0 });
    expect(bodyOf(card.text)).toBe("（未命名）");
  });

  it("心境原因与写入侧共用同一把尺子：占位名/关系陈述不进卡（t25/F1）", () => {
    const dirty = renderPersonaCardV13(
      richInput({ mood: { ...richInput().mood!, emotionObject: "用户（姓名未提供）是林夏的师父" } }),
    );
    const dirtyText = blockText(dirty.text, "现在") ?? "";
    expect(dirtyText).not.toContain("姓名未提供");
    expect(dirtyText).not.toContain("是林夏的师父");
    expect(dirtyText).toContain("心里那点憋着还在。");

    const clean = renderPersonaCardV13(richInput({ mood: { ...richInput().mood!, emotionObject: "导出报错" } }));
    expect(blockText(clean.text, "现在") ?? "").toContain("心里那点憋着还在，冲着导出报错。");
  });

  it("没有心境就不写「还算稳」，现在块整块省略", () => {
    const card = renderPersonaCardV13({
      profile: { name: "小满" },
      mood: null,
      version: 0,
    });
    expect(card.text).not.toContain("还算稳");
    expect(card.blocks.find((b) => b.id === "now")?.source).toBe("absent");
  });
});

describe("v13 渲染纪律：说「你」、不写 Markdown、不造台词", () => {
  it("正文不出现「用户」「我站在……这边」当独立行，也没有 Markdown 结构", () => {
    const card = renderPersonaCardV13(richInput());
    const body = bodyOf(card.text);
    expect(body).not.toContain("用户");
    expect(body).not.toContain("我站在");
    expect(body).not.toContain("##");
    expect(body).not.toContain("**");
    expect(body).not.toContain("|");
    // 关系流水账被改写成「你」，不是原样搬运
    expect(body).toContain("你对我的要求");
    expect(body.split("\n").some((line) => line.trim() === "我只回了话")).toBe(false);
  });

  it("一条行为锚一个反应：性格块最多五条，不拿标签数值凑", () => {
    const card = renderPersonaCardV13(richInput());
    const character = blockText(card.text, "性格");
    expect(character).not.toBeNull();
    const lines = character!.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const line of lines) expect(line).not.toMatch(/^\d+(\.\d+)?$/);
  });

  it("不生成样品对话：没有「你：…」「小满：…」这类台词", () => {
    const card = renderPersonaCardV13(richInput());
    const body = bodyOf(card.text);
    for (const line of body.split("\n")) expect(line).not.toMatch(/^(你|我|小满|何晨)：/);
    expect(body).not.toContain("你说：");
  });
});

describe("v13 hash 口径与稳定性", () => {
  it("同一输入两次渲染逐字节一致，hash = sha256(读法 + 正文)", () => {
    const a = renderPersonaCardV13(richInput());
    const b = renderPersonaCardV13(richInput());
    expect(b.text).toBe(a.text);
    expect(b.hash).toBe(a.hash);
    const expected = createHash("sha256")
      .update([CARD_READER_NOTE, bodyOf(a.text)].join("\n\n"), "utf8")
      .digest("hex");
    expect(a.hash).toBe(expected);
    expect(a.text).toContain(`<!-- persona-card v="13" hash="${a.hash.slice(0, 12)}" -->`);
    expect(a.chars).toBe(a.text.length);
  });

  it("改一行正文就换 hash（不重渲染判据不会被撞穿）", () => {
    const before = renderPersonaCardV13(richInput());
    const after = renderPersonaCardV13(
      richInput({ lines: { ...richInput().lines, identity: [{ text: "我把「先验后报」当成底线：换了说法" }] } }),
    );
    expect(after.hash).not.toBe(before.hash);
    expect(after.signature).not.toBe(before.signature);
  });
});

describe("v13 是九块散文，不带 Markdown 结构", () => {
  it("正文用纯文本小标题、读法在前、尾部只有 v=\"13\" 注释", () => {
    const card = renderPersonaCardV13(richInput());
    expect(card.text).toContain(CARD_READER_NOTE);
    expect(card.text).not.toContain("## ");
    expect(card.text).not.toContain("**");
    expect(card.text).toContain('v="13"');
    expect(card.blocks.map((b) => b.id)).toEqual([...CARD_V13_BLOCK_ORDER]);
  });
});

describe("卡面不出现渠道占位名（t21/F3 端到端）", () => {
  it("factsFromEpisode(participants=[\"user\"]) 渲染到卡上写成「对方对我的要求」", () => {
    const facts = factsFromEpisode({
      episodeId: "ep-t21",
      at: "2026-11-10T03:00:00.000Z",
      day: "2026-11-10",
      kind: "correction",
      title: "把没跑过的门禁说成绿",
      object: "门禁",
      participants: ["user"],
      userStance: "你搞错了吧，门禁根本没跑就说通过了",
      agentStance: "我错了，先把门禁跑完再报",
      cost: "",
      outcome: "",
      valence: -0.5,
      arousal: 0.6,
      intensity: 0.7,
      evidenceIds: ["msg-1"],
      sessionId: "s-1",
      quote: null,
      affectSource: "lexicon",
    });
    const relationships = facts
      .filter((f) => f.layer === "relationship")
      .map((f) => ({ text: f.text }));
    const card = renderPersonaCardV13({ profile: { name: "小满" }, lines: { relationship: relationships }, version: 1 });
    const body = bodyOf(card.text);
    expect(body).toContain("对方对我的要求");
    expect(body).not.toMatch(/\buser\b/iu);
  });

  it("旧 soul_persona 行里的占位主语在渲染侧也被改写（append-only 旧行不会自己消失）", () => {
    const card = renderPersonaCardV13({
      profile: { name: "小满" },
      lines: {
        relationship: [{ text: "user 对我的要求：「这就是没做到」——这条我还没做到" }],
      },
      version: 1,
    });
    const body = bodyOf(card.text);
    expect(body).toContain("对方对我的要求：「这就是没做到」——这条我还没做到");
    expect(body).not.toMatch(/\buser\b/iu);
  });

  it("真实姓名不被改写", () => {
    const card = renderPersonaCardV13({
      profile: { name: "小满" },
      lines: { relationship: [{ text: "何晨对我的要求：「先取证再改」——我做到了" }] },
      version: 1,
    });
    expect(bodyOf(card.text)).toContain("何晨对我的要求：");
  });
});
