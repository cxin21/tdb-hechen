import { describe, expect, it } from "vitest";
import {
  CARD_V13_BLOCK_MAX_CHARS,
  CARD_V13_MAX_CHARS,
  renderPersonaCardV13,
  type SoulCardV13Input,
} from "../card-v13.js";
import { assembleSoulCard, buildStructuredRelationshipFacts, readStructuredCardFacts } from "../card-service.js";
import { CARD_READER_NOTE, seedStateFromSeeds, SEED_LABELS } from "../traits.js";
import { seedLabelRows } from "../trait-drift.js";
import type { PersonaItem } from "../types.js";
import type { CoreTenant } from "../../store/types.js";

/**
 * 阶段 2：v13 接结构化层（soul_person_relation / soul_person_state / soul_mood_state /
 * soul_working_state / soul_goals）。原则：有数据才写、缺数据整块省略并给 missing_*，
 * 正文事实必须能回指 evidenceIds，整卡仍受 2400 硬顶。
 */

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const NOW = "2026-11-10T12:00:00.000Z";

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

function baseInput(over: Partial<SoulCardV13Input> = {}): SoulCardV13Input {
  return {
    profile: {
      name: "小满",
      selfImage: "我是小满，一个把复杂东西讲清楚的人。",
      voice: "先给结论，再补一句为什么。",
      purpose: "把事讲清楚。",
      redlines: [{ text: "不假装知道没验证过的事实", active: true, createdAt: NOW }],
    },
    lines: {},
    version: 1,
    ...over,
  };
}

function personState(over: Record<string, unknown> = {}) {
  return {
    personKey: "p_lin",
    name: "林夏",
    trust: 0.8,
    affinity: 0.8,
    respect: 0.8,
    obligation: 0.8,
    evidenceIds: ["ev-st1", "ev-st2"],
    ...over,
  };
}

function item(layer: PersonaItem["layer"], text: string, extra: Partial<PersonaItem> = {}): PersonaItem {
  return {
    itemId: `i-${layer}-${text.slice(0, 6)}`,
    layer,
    text,
    state: "active",
    weight: 0.7,
    evidenceIds: ["e1"],
    evidenceDays: ["2026-11-09"],
    evidenceOrigins: ["episode"],
    createdAt: NOW,
    updatedAt: NOW,
    lastEvidenceAt: NOW,
    ...extra,
  };
}

describe("v13 结构化层：我们", () => {
  it("关系事实与四轴状态进入「我们」，来源标 structured，正文事实带证据", () => {
    const card = renderPersonaCardV13(
      baseInput({
        lines: {
          human: [{ text: "身份：这条路是我在拍板" }],
          // personScoped 时这条流水账不该出现在卡上。
          relationship: [{ text: "用户对我的要求：「改掉那段渲染」——我只回了话，没改" }],
        },
        structured: {
          personScoped: true,
          relations: [{ text: "你与林夏：师父", evidenceIds: ["ev-rel"] }],
          personStates: [personState({ obligation: 0.2, respect: 0.2 })],
        },
      }),
    );
    const us = card.blocks.find((b) => b.id === "us");
    expect(us?.source).toBe("structured");
    expect(us?.confidence).toBe("medium");
    const text = blockText(card.text, "我们") ?? "";
    expect(text).toContain("你是这条路是我在拍板");
    expect(text).toContain("你与林夏：师父");
    expect(text).toContain("我信林夏，答应过的事会兑现。");
    expect(text).toContain("和林夏说话，我不用端着。");
    expect(text).not.toContain("用户对我的要求");
    expect(us?.evidenceIds).toEqual(expect.arrayContaining(["ev-rel", "ev-st1"]));
  });

  it("human 占满三行时，四条已回指的关系仍全部在「我们」里（t16 回归）", () => {
    const relations = [
      { text: "你与周衡：上级", evidenceIds: ["ev-zhou"] },
      { text: "你与林夏：徒弟", evidenceIds: ["ev-lin"] },
      { text: "你与赵宁：同事", evidenceIds: ["ev-zhao"] },
      { text: "你与陈屿：客户", evidenceIds: ["ev-chen"] },
    ];
    const card = renderPersonaCardV13(
      baseInput({
        lines: {
          human: [
            { text: "身份：在用友做产品经理" },
            { text: "相处：放权让人自己定目标" },
            { text: "约定：先给证据再下结论" },
          ],
        },
        structured: { personScoped: true, relations },
      }),
    );
    const text = blockText(card.text, "我们") ?? "";
    for (const r of relations) expect(text).toContain(r.text);
    const us = card.blocks.find((b) => b.id === "us");
    // 关系 4 行 + human 3 行 = 7 行，既不丢关系也不越块上限。
    expect(text.split("\n")).toHaveLength(7);
    expect(us?.chars).toBeLessThanOrEqual(CARD_V13_BLOCK_MAX_CHARS.us);
    expect(card.text).not.toContain("用户");
  });

  it("对象名字解析不到就省略该行并给 person_unresolved，不回退展示名", () => {
    const card = renderPersonaCardV13(
      baseInput({
        structured: {
          personScoped: true,
          personStates: [personState({ name: "" })],
        },
      }),
    );
    expect(card.warnings).toContain("person_unresolved:p_lin");
    expect(card.blocks.find((b) => b.id === "us")?.source).toBe("absent");
    expect(card.warnings).toContain("missing_person_state");
  });

  it("没有任何关系数据就整块省略，不写「我们是搭子」这种没来源的关系类型", () => {
    const card = renderPersonaCardV13(baseInput({ structured: { personScoped: true } }));
    expect(card.blocks.find((b) => b.id === "us")?.source).toBe("absent");
    expect(card.warnings).toContain("missing_person_state");
  });
});

describe("v13 结构化层：现在", () => {
  it("慢心境跟基线比只写方向不写数字，证据取 cause_event_ids", () => {
    const card = renderPersonaCardV13(
      baseInput({
        mood: { valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3 },
        structured: {
          mood: { label: "憋着", valence: -0.35, arousal: 0.55, intensity: 0.6, causeEventIds: ["ev-m1"] },
        },
      }),
    );
    const now = card.blocks.find((b) => b.id === "now");
    expect(now?.source).toBe("structured");
    const text = blockText(card.text, "现在") ?? "";
    expect(text).toContain("比基线偏沉，更活一点。");
    expect(text).toContain("心里那点憋着还在。");
    expect(text).not.toMatch(/[0-9]/u);
    expect(now?.evidenceIds).toEqual(["ev-m1"]);
  });

  it("工作锚写「在做/欠着/下一步」，卡住的目标带原因", () => {
    const card = renderPersonaCardV13(
      baseInput({
        structured: {
          working: {
            currentFocus: "把 v13 阶段 2 接完",
            openQuestions: ["缺 mood_state 的读面"],
            currentGoalId: "g2",
          },
          goals: [
            { goalId: "g2", title: "人格卡 v13 阶段 2", status: "active", evidenceIds: ["ev-g2"] },
            { goalId: "g3", title: "门禁收口", status: "blocked", blockedReason: "等用户拍板" },
          ],
        },
      }),
    );
    const text = blockText(card.text, "现在") ?? "";
    expect(text).toContain("手上在做：把 v13 阶段 2 接完");
    expect(text).toContain("还欠着：缺 mood_state 的读面");
    expect(text).toContain("下一步：人格卡 v13 阶段 2");
    expect(card.blocks.find((b) => b.id === "now")?.source).toBe("structured");

    const blockedOnly = renderPersonaCardV13(
      baseInput({
        structured: {
          goals: [{ goalId: "g3", title: "门禁收口", status: "blocked", blockedReason: "等用户拍板" }],
        },
      }),
    );
    const blockedText = blockText(blockedOnly.text, "现在") ?? "";
    expect(blockedText).toContain("卡在：门禁收口（等用户拍板）");
    expect(blockedOnly.warnings).toContain("missing_working_state");
  });

  it("工作锚缺行时只给 missing_working_state，不写「暂无目标」占位", () => {
    const card = renderPersonaCardV13(
      baseInput({ mood: { valence: 0.2, arousal: 0.35, baselineValence: 0, baselineArousal: 0.3 } }),
    );
    expect(card.warnings).toContain("missing_working_state");
    const text = blockText(card.text, "现在") ?? "";
    expect(text).not.toContain("暂无");
    expect(text).not.toContain("没有目标");
  });
});

describe("v13 结构化层：预算与确定性", () => {
  it("结构化数据再多，整卡仍不超过 2400 字，九块顺序不变", () => {
    const input = baseInput({
      lines: {
        human: Array.from({ length: 8 }, (_, i) => ({ text: `要求：第 ${i} 条要求必须逐条落地` })),
        self: Array.from({ length: 6 }, (_, i) => ({ text: `我答应自己：第 ${i} 件事要留住` })),
      },
      structured: {
        personScoped: true,
        relations: Array.from({ length: 10 }, (_, i) => ({
          text: `你与林夏：第 ${i} 段关系事实`,
          evidenceIds: [`ev-rel-${i}`],
        })),
        personStates: [personState(), personState({ personKey: "p_zhou", name: "周野" })],
        mood: { label: "憋着", valence: -0.3, arousal: 0.5, intensity: 0.7 },
        working: {
          currentFocus: "把结构化层接进卡",
          openQuestions: Array.from({ length: 6 }, (_, i) => `第 ${i} 个还没答的问题`),
        },
        goals: Array.from({ length: 4 }, (_, i) => ({
          goalId: `g${i}`,
          title: `目标 ${i}`,
          status: "active" as const,
        })),
      },
    });
    const card = renderPersonaCardV13(input);
    expect(card.chars).toBeLessThanOrEqual(CARD_V13_MAX_CHARS);
    expect(card.blocks.map((b) => b.id)).toEqual([
      "firstLook",
      "life",
      "character",
      "voice",
      "us",
      "now",
      "memory",
      "boundaries",
      "recent",
    ]);
    expect(card.text).not.toContain("undefined");
  });
});

describe("v13 结构化层：组装接线", () => {
  function makeStore(rows: Record<string, unknown> = {}) {
    const seed = seedStateFromSeeds([{ label: "严谨", weight: 0.6 }]);
    const labels = seedLabelRows(SEED_LABELS, NOW);
    return {
      readLastSoulSnapshot: async () => null,
      listSoulPersona: async () => [
        item("identity", "我把「先验后报」当成底线：没看过就不说验证过"),
        item("narrative", "我原先站在审查位，后来走到动手改"),
      ],
      readSoulTraitState: async () => ({ state: seed, seedState: seed, updatedAt: NOW }),
      listSoulTraitLabels: async () => labels,
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 9,
        updatedAt: NOW,
      }),
      listSoulPromises: async () => [],
      listSoulPersons: async () => [{ personKey: "p_lin", displayName: "林夏" }],
      listSoulPersonRelations: async () => [
        {
          relId: "r1",
          subjKey: "p_lin",
          pred: "师父",
          objKey: "p_lin",
          objName: "林夏",
          direction: "out",
          validFrom: NOW,
          validTo: null,
          status: "active",
          eventId: "ev-rel",
        },
      ],
      listSoulPersonStates: async () => [
        {
          person_key: "p_lin",
          trust: 0.8,
          affinity: 0.8,
          respect: 0.8,
          obligation: 0.2,
          evidence_event_ids_json: '["ev-st1","ev-st2"]',
          updated_at: NOW,
        },
      ],
      readSoulMoodState: async () => ({
        label: "憋着",
        valence: -0.3,
        arousal: 0.5,
        intensity: 0.6,
        half_life_hours: 48,
        cause_event_ids_json: '["ev-m1"]',
        updated_at: NOW,
      }),
      getSoulWorkingState: async () => ({
        current_focus: "把结构化层接进卡",
        open_questions_json: '["缺 mood 读面"]',
        current_goal_id: "g2",
        updated_at: NOW,
        expires_at: "2026-11-11T00:00:00.000Z",
      }),
      listSoulGoals: async () => [
        { goal_id: "g2", title: "人格卡 v13 阶段 2", status: "active", priority: 0.8, source_event_id: "ev-g2", updated_at: NOW },
      ],
      ...rows,
    };
  }

  it("生产形状的 current_focus 自带「在做：」前缀，卡面只出现一次（t25/F2）", () => {
    const card = renderPersonaCardV13(
      baseInput({
        structured: {
          working: { currentFocus: "在做：把结构化层接进卡（11-07 到期）", openQuestions: [] },
        },
      }),
    );
    const text = blockText(card.text, "现在") ?? "";
    expect(text).toContain("手上在做：把结构化层接进卡（11-07 到期）");
    expect(text).not.toContain("在做：在做：");
    expect(text.split("手上在做：").length - 1).toBe(1);

    // 复合锚（goals.ts 的「在做；欠着；卡住」）里的另外两段有自己的落点，
    // 不塞进「手上在做」这一行冒充注意力。
    const composite = renderPersonaCardV13(
      baseInput({
        structured: {
          working: { currentFocus: "在做：把 A 做完；欠着：B、C；卡住：D（等拍板）", openQuestions: [] },
        },
      }),
    );
    const compositeText = blockText(composite.text, "现在") ?? "";
    expect(compositeText).toContain("手上在做：把 A 做完");
    expect(compositeText).not.toContain("欠着：B、C");
  });

  it("只读组装时把结构化行接进「我们」与「现在」，来源与证据落进 blocks", async () => {
    const card = await assembleSoulCard({
      store: makeStore() as never,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "小满", voice: "先给结论。" }),
      persons: ["p_lin"],
    });
    const us = card.blocks?.find((b) => b.id === "us");
    const now = card.blocks?.find((b) => b.id === "now");
    expect(us?.source).toBe("structured");
    expect(us?.evidenceIds).toEqual(expect.arrayContaining(["ev-rel", "ev-st1"]));
    expect(now?.source).toBe("structured");
    expect(now?.evidenceIds).toEqual(expect.arrayContaining(["ev-m1", "ev-g2"]));
    expect(card.text).toContain("你与林夏：师父");
    expect(card.text).toContain("我信林夏");
    expect(card.text).toContain("手上在做：把结构化层接进卡");
    expect(card.text).toContain("比基线");
    expect(card.warnings).not.toContain("missing_person_state");
    expect(card.warnings).not.toContain("missing_working_state");
  });

  it("生产形状：human 三行 + 四条关系，assembleSoulCard(persons=[p_he]) 四行齐全且无角色词", async () => {
    const rel = (relId: string, pred: string, objKey: string) => ({
      relId,
      subjKey: "p_he",
      pred,
      objKey,
      objName: null,
      direction: "out" as const,
      validFrom: NOW,
      validTo: null,
      status: "active" as const,
      eventId: null,
    });
    const card = await assembleSoulCard({
      store: makeStore({
        listSoulPersons: async () => [
          { personKey: "p_he", displayName: "何晨" },
          { personKey: "p_zhou", displayName: "周衡" },
          { personKey: "p_lin", displayName: "林夏" },
          { personKey: "p_zhao", displayName: "赵宁" },
          { personKey: "p_chen", displayName: "陈屿" },
        ],
        listSoulPersonRelations: async () => [
          rel("rel-zhou", "上级", "p_zhou"),
          rel("rel-lin", "徒弟", "p_lin"),
          rel("rel-zhao", "同事", "p_zhao"),
          rel("rel-chen", "客户", "p_chen"),
        ],
        listSoulPersonStates: async () => [],
        listSoulPersona: async () => [
          item("human", "身份：在用友做产品经理"),
          item("human", "相处：放权让人自己定目标"),
          item("human", "约定：先给证据再下结论"),
        ],
      }) as never,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "小满", voice: "先给结论。" }),
      persons: ["p_he"],
    });
    for (const line of [
      "你与周衡：上级",
      "你与林夏：徒弟",
      "你与赵宁：同事",
      "你与陈屿：客户",
    ]) {
      expect(card.text).toContain(line);
    }
    expect(card.text).not.toContain("用户");
    expect(card.blocks?.find((b) => b.id === "us")?.chars).toBeLessThanOrEqual(CARD_V13_BLOCK_MAX_CHARS.us);
  });

  it("store 没有结构化读面时省略并给 missing_*，不回退占位数据", async () => {
    const card = await assembleSoulCard({
      store: makeStore({
        listSoulPersons: undefined,
        listSoulPersonRelations: undefined,
        listSoulPersonStates: undefined,
        readSoulMoodState: undefined,
        getSoulWorkingState: undefined,
        listSoulGoals: undefined,
      }) as never,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "小满", voice: "先给结论。" }),
      persons: ["p_lin"],
    });
    expect(card.blocks?.find((b) => b.id === "us")?.source).toBe("absent");
    expect(card.blocks?.find((b) => b.id === "now")?.source).toBe("derived");
    expect(card.warnings).toContain("missing_person_state");
    expect(card.warnings).toContain("missing_working_state");
    expect(card.text).not.toContain("暂无");
  });
});

describe("结构化事实读取", () => {
  it("关系事实带 eventId 证据，personState 只收在场者且名字不回退 obj_name", async () => {
    const facts = buildStructuredRelationshipFacts({
      relations: [
        { relId: "r1", subjKey: "p_lin", pred: "师父", objKey: "p_lin", objName: "林夏", direction: "out", validTo: null, eventId: "ev-rel" },
      ],
      personNames: new Map([["p_lin", "林夏"]]),
      persons: ["p_lin"],
    });
    expect(facts.facts).toEqual([{ text: "你与林夏：师父", evidenceIds: ["ev-rel"] }]);
    const read = await readStructuredCardFacts(
      {
        listSoulPersona: async () => [],
        listSoulPersonRelations: async () => [],
        listSoulPersons: async () => [{ personKey: "p_x", displayName: "" }],
        listSoulPersonStates: async () => [
          { person_key: "p_x", trust: 0.9, affinity: 0.5, respect: 0.5, obligation: 0.5, evidence_event_ids_json: "[]" },
          { person_key: "p_other", trust: 0.9, affinity: 0.5, respect: 0.5, obligation: 0.5, evidence_event_ids_json: "[]" },
        ],
      } as never,
      TENANT,
      ["p_x"],
    );
    expect(read?.personStates.map((s) => s.personKey)).toEqual(["p_x"]);
    expect(read?.personStates[0]?.name).toBe("");
  });
});
