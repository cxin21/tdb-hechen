import { describe, expect, it, vi } from "vitest";
import {
  assembleSoulCard,
  assembleSoulTurn,
  cardLinesFromItems,
  nearDuplicateText,
  parsePreviousCard,
  previousAnchorOf,
} from "../card-service.js";
import { seedLabelRows } from "../trait-drift.js";
import { SEED_LABELS, seedStateFromSeeds } from "../traits.js";
import type { PersonaItem } from "../types.js";
import type { CoreTenant } from "../../store/types.js";

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const NOW = "2026-11-07T12:00:00.000Z";

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

function makeStore(over: Record<string, unknown> = {}) {
  const labels = seedLabelRows(SEED_LABELS, NOW);
  const seed = seedStateFromSeeds([{ label: "严谨", weight: 0.6 }, { label: "直接", weight: 0.4 }]);
  const writes: unknown[] = [];
  const store = {
    readLastSoulSnapshot: async () => null,
    listSoulPersona: async () => [
      item({ layer: "human", text: "他习惯先看证据再听结论" }),
      item({ layer: "relationship", text: "他上次说：别替我猜" }),
      item({ layer: "identity", text: "我站在「先跑一遍真的」这边：宁可多跑一遍，也不凭印象" }),
      item({ layer: "narrative", text: "我是从一次导出修复起步的" }),
    ],
    readSoulTraitState: async () => ({ state: seed, seedState: seed, updatedAt: NOW }),
    listSoulTraitLabels: async () => labels,
    writeSoulSnapshot: async (_t: unknown, snap: unknown) => {
      writes.push(snap);
    },
    readSoulState: async () => ({
      valence: -0.4,
      arousal: 0.5,
      baselineValence: 0,
      baselineArousal: 0.3,
      sampleCount: 7,
      updatedAt: NOW,
    }),
    listSoulPromises: async () => [
      { promiseId: "p1", content: "把 S8 的 journal 字段补齐", status: "open" as const, source: "episode", refKey: "", createdAt: NOW, updatedAt: NOW },
      { promiseId: "p2", content: "清库前再备份一次", status: "open" as const, source: "episode", refKey: "", createdAt: NOW, updatedAt: NOW },
    ],
    ...over,
  };
  return { store, writes };
}

describe("soul card service：v13 的实现路径", () => {
  it("块来源：第一眼/边界=declared，性格/我们=observed，现在=derived", async () => {
    const { store } = makeStore();
    const card = await assembleSoulCard({
      store,
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
    expect(card.schema).toBe("13");
    expect(card.sources.firstLook).toBe("declared");
    expect(card.sources.boundaries).toBe("declared");
    expect(card.sources.character).toBe("observed");
    expect(card.sources.us).toBe("observed");
    expect(card.sources.now).toBe("derived");
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
    expect(card.seeded).toBe(true);
    expect(card.text).toContain("阿简");
    expect(card.text).toContain("绝不可删除任何生产记忆记录");
    // 读侧禁词（判据 12）：卡里不出现轴名、不出现算法词。
    for (const banned of ["权重", "算法", "tanh", "α", "warmth", "rigor", "openness"]) {
      expect(card.text).not.toContain(banned);
    }
    expect(card.text).not.toContain("## ");
    // 卡本体不带「未完的事」（那是通道 B）。
    expect(card.text).not.toContain("未完的事");
  });

  // 判据「卡完整性 = 底色非空」：表单里设定的特质在没有任何漂移证据时也必须进卡——
  // v13 里「底色」不再以数字行出现，而是 labels 元数据 + 性格块里的行为锚。
  it("表单声明的特质不需要证据：evidence=0 也进 labels（state 已存在）", async () => {
    const traits = [
      { label: "严谨", weight: 0.4 },
      { label: "迷糊", weight: 0.25 },
      { label: "好奇", weight: 0.2 },
      { label: "守界", weight: 0.15 },
    ];
    const zeroEvidence = seedLabelRows(SEED_LABELS, NOW, { declared: [] }).map((r) => ({ ...r, evidence: 0 }));
    const { store } = makeStore({
      listSoulTraitLabels: async () => zeroEvidence,
      readSoulTraitState: async () => ({
        state: seedStateFromSeeds(traits),
        seedState: seedStateFromSeeds(traits),
        updatedAt: NOW,
      }),
    });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "青禾", traits }),
    });
    expect(card.labels.length).toBeGreaterThanOrEqual(2);
    expect(card.text).not.toContain("还没有稳到能算数的底色");
    // 读侧仍不许出现轴名与算法词；也不把数值写进正文。
    for (const banned of ["严谨轴", "rigor", "warmth", "tanh", "权重", "0.4"]) {
      expect(card.text).not.toContain(banned);
    }
  });

  it("库里还没有标签行时，声明的特质用种子方向合成视图，labels 仍非空", async () => {
    const traits = [{ label: "严谨", weight: 0.6 }, { label: "好奇", weight: 0.4 }];
    const { store } = makeStore({
      listSoulTraitLabels: async () => [],
      readSoulTraitState: async () => null,
    });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "青禾", traits }),
    });
    expect(card.labels.length).toBeGreaterThan(0);
    expect(card.text).not.toContain("还没有稳到能算数的底色");
  });

  // P1-3：gloss 的唯一数据源是库行（`soul_trait_label.gloss`），不是种子词表。
  // v13 起 gloss 只随 labels 元数据出卡（面板 chip），不再写进正文数字行。
  it("底色 gloss 取自标签行：库里改过的注解覆盖种子，自生长标签也能带注解", async () => {
    const template = seedLabelRows(SEED_LABELS, NOW).find((r) => r.label === "严谨")!;
    const labels = [
      { ...template, gloss: "库里改过的注解：先验再信。", status: "admitted" as const, evidence: 9 },
      {
        ...template,
        label: "较真",
        gloss: "对细节反复核对，不肯放过。",
        direction: { warmth: 0, agency: 0, rigor: 1, openness: 0, stability: 0, boundary: 0 },
        status: "admitted" as const,
        evidence: 9,
      },
    ];
    const { store } = makeStore({ listSoulTraitLabels: async () => labels });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "青禾", traits: [{ label: "严谨", weight: 0.6 }] }),
    });
    const glosses = card.labels.map((l) => l.gloss ?? "");
    expect(glosses).toContain("库里改过的注解：先验再信。");
    // 「较真」不在种子词表里：这条注解能出现，只可能来自库行。
    expect(glosses).toContain("对细节反复核对，不肯放过。");
    expect(glosses).not.toContain(SEED_LABELS.find((s) => s.label === "严谨")!.gloss);
  });

  it("非声明的自生长标签仍被证据门拦住（evidence<3 不进 labels）", async () => {
    const rows = seedLabelRows(SEED_LABELS, NOW, { declared: ["严谨"] }).map((r) =>
      r.label === "严谨" ? { ...r, evidence: 0 } : r,
    );
    const { store } = makeStore({
      listSoulTraitLabels: async () => rows.map((r) => (r.label === "冷淡" ? { ...r, evidence: 0 } : r)),
      readSoulTraitState: async () => ({
        state: seedStateFromSeeds([{ label: "严谨", weight: 0.6 }]),
        seedState: seedStateFromSeeds([{ label: "严谨", weight: 0.6 }]),
        updatedAt: NOW,
      }),
    });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ name: "青禾", traits: [{ label: "严谨", weight: 0.6 }] }),
    });
    expect(card.labels.map((l) => l.label)).toContain("严谨");
    expect(card.labels.map((l) => l.label)).not.toContain("冷淡");
  });

  it("纯读不落快照；persist 且内容未变不追加", async () => {
    const { store, writes } = makeStore();
    await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: false });
    expect(writes).toHaveLength(0);

    const first = await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: true });
    expect(writes).toHaveLength(1);
    expect(first.dirty).toBe(true);

    // 第二次：把上一版当已存快照喂回，内容未变 → 不写。
    const payload = (writes[0] as { payloadJson: string }).payloadJson;
    const again = makeStore({
      readLastSoulSnapshot: async () => ({
        ts: NOW,
        content_hash: first.hash,
        payload_json: payload,
        trigger: "soul_tick",
        version: first.version,
      }),
    });
    const second = await assembleSoulCard({ store: again.store, tenant: TENANT, now: NOW, persist: true });
    expect(second.dirty).toBe(false);
    expect(second.hash).toBe(first.hash);
    expect(again.writes).toHaveLength(0);
    // 未写快照就不涨版本：返回的 version 必须与库里那条快照的 version 对齐，
    // 否则调用方拿到 persistedVersion+1、下一次 GET 又退回旧值。
    const persistedVersion = first.version;
    expect(second.version).toBe(persistedVersion);
    expect(writes).toHaveLength(1);
    const written = JSON.parse((writes[0] as { payloadJson: string }).payloadJson) as { version: number };
    expect(written.version).toBe(second.version);
  });

  it("persist=true 且内容未变：不涨版本、不写快照，返回 version 与库内一致", async () => {
    const { store, writes } = makeStore();
    const first = await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: true });
    expect(writes).toHaveLength(1);
    const payload = (writes[0] as { payloadJson: string }).payloadJson;

    // 库里已有一条 version=9 的快照，内容与本轮渲染完全一致。
    const again = makeStore({
      readLastSoulSnapshot: async () => ({
        ts: NOW,
        content_hash: first.hash,
        payload_json: payload,
        trigger: "soul_tick",
        version: 9,
      }),
    });
    const second = await assembleSoulCard({ store: again.store, tenant: TENANT, now: NOW, persist: true });
    expect(second.dirty).toBe(false);
    expect(second.version).toBe(9);
    expect(again.writes).toHaveLength(0);

    // 纯读同样不涨版本。
    const third = await assembleSoulCard({ store: again.store, tenant: TENANT, now: NOW, persist: false });
    expect(third.version).toBe(9);
  });

  it("表单读失败不阻断卡（降级为只有观察层）", async () => {
    const { store } = makeStore();
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => {
        throw new Error("metadata down");
      },
    });
    expect(card.text).toContain("别替我猜");
    // 表单没给特质时退回 seedState（严谨+直接），labels 仍非空——判据 10 的载体不能空。
    expect(card.seeded).toBe(true);
  });

  it("表单特质在无漂移状态时也进 labels（D3 左栏）", async () => {
    const { store } = makeStore({
      readSoulTraitState: async () => null,
    });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      now: NOW,
      readAgentProfile: async () => ({ traits: [{ label: "好奇", weight: 1 }] }),
    });
    expect(card.seeded).toBe(true);
    expect(card.labels.length).toBeGreaterThan(0);
  });

  it("通道 B：心境 + 未完的事 ≤400 字符、≤3 条", async () => {
    const { store } = makeStore();
    const turn = await assembleSoulTurn({ store, tenant: TENANT });
    expect(turn.openLoops).toHaveLength(2);
    expect(turn.text.length).toBeLessThanOrEqual(400);
    expect(turn.text).toContain("近期心境");
    expect(turn.text).toContain("把 S8 的 journal 字段补齐");
    expect(turn.text).not.toContain("权重");
  });

  it("通道 B：没有存活情绪时也有一行底子（判据 10）", async () => {
    const { store } = makeStore({
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 12,
        updatedAt: NOW,
      }),
      listSoulPromises: async () => [],
    });
    const turn = await assembleSoulTurn({ store, tenant: TENANT });
    expect(turn.text).toContain("底子");
    expect(turn.openLoops).toHaveLength(0);
    expect(turn.text).not.toContain("未完的事");
  });

  it("通道 B：情绪强度归零/已过期，不再写「正在消退」（A2）", async () => {
    const { store } = makeStore({
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 12,
        updatedAt: "2026-10-20T00:00:00.000Z",
        emotionLabel: "不安",
        emotionObject: "上线",
        emotionIntensity: null,
        emotionAt: "2026-10-20T00:00:00.000Z",
      }),
      listSoulPromises: async () => [],
    });
    const turn = await assembleSoulTurn({ store, tenant: TENANT, now: NOW });
    expect(turn.text).not.toContain("不安");
    expect(turn.text).not.toContain("正在消退");
  });

  it("通道 B：活着的新情绪仍然进尾巴（A2 的反面）", async () => {
    const { store } = makeStore({
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 12,
        updatedAt: "2026-11-07T11:50:00.000Z",
        emotionLabel: "不安",
        emotionObject: "上线",
        emotionIntensity: 0.8,
        emotionAt: "2026-11-07T11:50:00.000Z",
      }),
      listSoulPromises: async () => [],
    });
    const turn = await assembleSoulTurn({ store, tenant: TENANT, now: NOW });
    // 活着的情绪渲染成「因为「上线」…」，标签只作投影（emotion.ts 的 suffix 规则）。
    expect(turn.text).toContain("上线");
  });

  it("卡：过期即时情绪不进卡（A2）", async () => {
    const { store } = makeStore({
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 12,
        updatedAt: "2026-10-20T00:00:00.000Z",
        emotionLabel: "不安",
        emotionObject: "上线",
        emotionIntensity: 0.8,
        emotionAt: "2026-10-20T00:00:00.000Z",
      }),
    });
    const card = await assembleSoulCard({ store, tenant: TENANT, now: NOW });
    expect(card.text).not.toContain("不安");
  });

  it("层条目：只取 active/degraded，最近的在前，去重并截断 12 行", () => {
    const items: PersonaItem[] = [
      item({ layer: "human", text: "旧偏好", lastEvidenceAt: "2026-11-01T00:00:00.000Z" }),
      item({ layer: "human", text: "旧偏好", lastEvidenceAt: "2026-11-01T00:00:00.000Z" }),
      item({ layer: "human", text: "已冻结的", state: "frozen", lastEvidenceAt: "2026-11-07T11:00:00.000Z" }),
      item({ layer: "human", text: "新偏好", lastEvidenceAt: "2026-11-07T10:00:00.000Z" }),
    ];
    const lines = cardLinesFromItems(items, ["human"]);
    expect(lines).toEqual(["新偏好", "旧偏好"]);
  });

  it("上一版 payload 不是 persona-card 时当作没有上一版", () => {
    expect(previousAnchorOf("随便一段没有锚句的正文")).toBeUndefined();
  expect(previousAnchorOf("比基线偏轻，更活一点。")).toEqual({ tone: "偏轻", energy: "更活一点" });
  expect(previousAnchorOf("比基线还算稳，松紧和平时差不多。")).toEqual({ tone: "还算稳", energy: "松紧和平时差不多" });
  expect(parsePreviousCard({ ts: NOW, content_hash: "h", payload_json: JSON.stringify({ slots: [] }), trigger: "layout" })).toBeNull();
    expect(
      parsePreviousCard({
        ts: NOW,
        content_hash: "h",
        payload_json: JSON.stringify({ kind: "persona-card", version: 3, hash: "abc", text: "t", chars: 1, acts: {}, labels: [], warnings: [], signature: "s" }),
        trigger: "soul_tick",
        version: 3,
      })?.version,
    ).toBe(3);
  });
});

/**
 * task-27/A1（2026-11-07）：名字只认声明。
 * 原来的「观察级」——从 L1 里用 `我叫X / 叫我X / 我的名字是X` 猜 agent 名字——已删除：
 * 生产 agt-bbr29z58s2 把 assistant 解释正则的正文当成自述，卡上凭空出现一个名字。
 * 现在：声明 → declared；没有声明 → 骨架「（未命名）」+ warning，绝不从对话里推断。
 */
describe("名字只认声明（task-27/A1）", () => {
  it("声明级：profile.name 直接渲染，nameSource=declared，不读 L1", async () => {
    const l0 = vi.fn(async () => [{ role: "assistant", message_text: "我叫小何" }]);
    const { store } = makeStore({ recentL0Messages: l0 });
    const card = await assembleSoulCard({
      store,
      tenant: TENANT,
      readAgentProfile: async () => ({ name: "何晨" }),
    });
    expect(card.text).toContain("何晨");
    expect(card.meta.nameSource).toBe("declared");
    expect(card.warnings.join("|")).not.toContain("名称为空");
    expect(l0).not.toHaveBeenCalled();
  });

  it("没有声明时不再从对话猜名字：assistant 说「我的名字是阿墨」也不算", async () => {
    const { store } = makeStore({
      recentL0Messages: async () => [
        { role: "assistant", message_text: "我叫小何，以后就按这个来。" },
        { role: "assistant", message_text: "记得，我的名字是阿墨。" },
      ],
    });
    const card = await assembleSoulCard({ store, tenant: TENANT, readAgentProfile: async () => null });
    // 关键：一条「匹配到正则」的正文不能变成身份。
    expect(card.text).not.toContain("阿墨");
    expect(card.text).not.toContain("小何");
    expect(card.text).toContain("（未命名）");
    expect(card.meta.nameSource).toBe("skeleton");
    expect(card.warnings.join("|")).toContain("名称为空");
  });

  it("骨架级：没有声明 → 渲染「（未命名）」占位，warning 保留", async () => {
    const { store } = makeStore({});
    const card = await assembleSoulCard({ store, tenant: TENANT, readAgentProfile: async () => null });
    expect(card.text).toContain("（未命名）");
    expect(card.meta.nameSource).toBe("skeleton");
    expect(card.warnings.join("|")).toContain("名称为空");
  });

  it("nameSource 写进卡快照 meta（可审计），不进注入正文；只可能是 declared/skeleton", async () => {
    const { store, writes } = makeStore({});
    await assembleSoulCard({ store, tenant: TENANT, readAgentProfile: async () => null, persist: true });
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(String((writes[0] as { payloadJson: string }).payloadJson));
    expect(payload.meta).toEqual({ nameSource: "skeleton" });
    expect(payload.text).not.toContain("nameSource");
  });
});
describe("soul card service：快照要能归因到漂移输入", () => {
  it("persist 落行带 6 轴、标签投影与受控 reasonCode（不是只有卡文本）", async () => {
    const { store, writes } = makeStore();
    await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: true });
    const snap = writes[0] as { reasonCode?: string; payloadJson?: string; slotsJson?: string };
    expect(snap.reasonCode).toBe("render");
    const payload = JSON.parse(String(snap.payloadJson)) as { traits?: Record<string, number>; traitLabels?: unknown[] };
    expect(Object.keys(payload.traits ?? {}).length).toBeGreaterThan(0);
    expect(Array.isArray(payload.traitLabels)).toBe(true);
    const slots = JSON.parse(String(snap.slotsJson)) as { traits?: Record<string, number>; labels?: unknown[] };
    expect(Object.keys(slots.traits ?? {}).length).toBeGreaterThan(0);
    expect(Array.isArray(slots.labels)).toBe(true);
  });

  // R24-1：快照要能指回「哪条输入」。旧 payload 只有 traits/标签投影与按块的 evidenceIds，
  // 追不到「本轮渲染用了哪些人格条目、最近一次漂移拿什么锚投的票」。
  it("payload.provenance 逐条给出 itemId/evidenceIds，并带 lastDrift 的锚 id", async () => {
    const { store, writes } = makeStore({
      listSoulPersona: async () => [
        item({
          layer: "identity",
          text: "我站在「先跑一遍真的」这边：宁可多跑一遍，也不凭印象",
          evidenceIds: ["ep-1", "ep-2"],
          meta: {
            lastDrift: {
              score: 0.42,
              track: "judgment",
              verdict: "watch",
              at: NOW,
              method: "embedding",
              anchorKey: "abc123",
              anchorIds: ["l1-a", "l1-b"],
            },
          },
        }),
        item({ layer: "human", text: "他习惯先看证据再听结论" }),
      ],
    });
    await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: true });
    const payload = JSON.parse(String((writes[0] as { payloadJson: string }).payloadJson)) as {
      provenance?: { render?: Record<string, unknown>; items?: Array<Record<string, unknown>> };
    };
    const prov = payload.provenance;
    expect(typeof prov?.render?.hash).toBe("string");
    expect(prov?.render?.version).toBe(1);
    const rows = prov?.items ?? [];
    const identity = rows.find((r) => r.layer === "identity");
    expect(String(identity?.itemId ?? "")).toMatch(/^identity:|^i-identity-/);
    expect(identity?.evidenceIds).toEqual(["ep-1", "ep-2"]);
    expect((identity?.drift as { anchorIds?: string[] } | undefined)?.anchorIds).toEqual(["l1-a", "l1-b"]);
    // 没有 lastDrift 的行不带 drift 键：不留一个空对象冒充「漂移过」。
    const human = rows.find((r) => r.layer === "human");
    expect(human).toBeTruthy();
    expect(human && "drift" in human).toBe(false);
  });

  // R29：出处超过 5 条时旧代码静默 slice(0,5)，读快照的人会以为这条事实只有 5 个出处
  // （r28c-a1 报「128 条 persona 里 63 条 evidenceIds>5 被静默截断」）。现在把总数显式写出来。
  it("payload.provenance 截断出处时标出总数（不多不少，未截断则不出键）", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `ep-${i + 1}`);
    const { store, writes } = makeStore({
      listSoulPersona: async () => [
        item({ layer: "identity", text: "我站在「先跑一遍真的」这边：宁可多跑一遍，也不凭印象", evidenceIds: many }),
        item({ layer: "human", text: "他习惯先看证据再听结论", evidenceIds: ["ep-a", "ep-b"] }),
      ],
    });
    await assembleSoulCard({ store, tenant: TENANT, now: NOW, persist: true });
    const payload = JSON.parse(String((writes[0] as { payloadJson: string }).payloadJson)) as {
      provenance?: { items?: Array<Record<string, unknown>> };
    };
    const rows = payload.provenance?.items ?? [];
    const identity = rows.find((r) => r.layer === "identity");
    expect((identity?.evidenceIds as string[] | undefined)?.length).toBe(5);
    expect(identity?.evidenceTotal).toBe(8);
    const human = rows.find((r) => r.layer === "human");
    expect(human?.evidenceIds).toEqual(["ep-a", "ep-b"]);
    expect(human && "evidenceTotal" in human).toBe(false);
  });
});

describe("A1 Round7：同族句折叠与窗口稳定（复核 CP4/CP2）", () => {
  it("只换开头几个字的同族句被折叠，不相干的准则不折", () => {
    // 实测（.scratch/metric-probe.mjs）：Jaccard 0.50 / LCS 0.79
    expect(nearDuplicateText("自己跑过才算数，别人的转述不算", "亲跑出来的才算数，别人的转述不算")).toBe(true);
    // Jaccard 0.43 / LCS 0.82：句式改了、后半句照抄
    expect(
      nearDuplicateText("我先给结论或先说边界，把决定权递回去", "我句子短、先摆结论或边界，把决定权递回去"),
    ).toBe(true);
    // Jaccard 0.21 / LCS 0.80 / 10 字：短句靠 LCS 兜住
    expect(nearDuplicateText("不确定就说不确定，别猜", "不确定的事直接说不确定，不猜")).toBe(true);
    // 整体改写（Jaccard 0.08 / LCS 0.33）与不相干句子不折：词面判据抓不到重度改述，写进 docs §5.9 局限
    expect(nearDuplicateText("亲跑出来的才算数，别人的转述不算", "他点的每一处我都亲手跑过才算数")).toBe(false);
    expect(nearDuplicateText("生产库只读，不写", "客户那份文件一行不动")).toBe(false);
    expect(nearDuplicateText("短句", "短句改")).toBe(false);
  });

  it("否定翻转不算近同义：不替人承诺 ≠ 替人承诺（A1 Round19 CP5）", () => {
    expect(nearDuplicateText("不替人承诺", "替人承诺")).toBe(false);
    expect(nearDuplicateText("不替人承诺，不装作已确认", "替人承诺，装作已确认")).toBe(false);
    // 两侧否定标记数相同、只是换说法 → 仍应折叠（否则去重失效）
    expect(nearDuplicateText("不确定就说不确定，别猜", "不确定的事直接说不确定，不猜")).toBe(true);
  });

  it("frozen 的边界行照样进卡：红线不能因为冻结而消失", () => {
    const lines = cardLinesFromItems([item({ layer: "boundary", text: "不替人承诺，不装作已确认", state: "frozen" })], ["boundary"]);
    expect(lines).toEqual(["不替人承诺，不装作已确认"]);
  });

  it("冻结顺手写的 validTo 不能把红线拦掉：仅冻结（无 supersededBy）照样进卡（R32）", () => {
    // 生产实测：boundary 4 行全 state=frozen 且 validTo=冻结时刻（persona.ts 的 freezeItem 会写），
    // 只按 validTo 拦会让 blocks.boundaries 恒为 chars:0 / block_omitted:边界。
    const lines = cardLinesFromItems(
      [
        item({ layer: "boundary", text: "不碰没被点名的原文件", state: "frozen", validTo: "2026-11-11T18:40:53.819Z" }),
        item({ layer: "boundary", text: "不删我看不懂用途的东西", state: "frozen", validTo: "2026-11-17T11:02:45.319Z" }),
      ],
      ["boundary"],
    );
    expect(lines).toEqual(["不碰没被点名的原文件", "不删我看不懂用途的东西"]);
  });

  it("被结论合并取代的红线不进卡：有 supersededBy 就按失效期出局（替补已在卡上）", () => {
    const lines = cardLinesFromItems(
      [
        item({
          layer: "boundary",
          text: "旧红线（已被合并）",
          state: "frozen",
          validTo: "2026-11-11T18:40:53.819Z",
          supersededBy: "boundary:new",
        }),
        item({ layer: "boundary", text: "现行红线" }),
      ],
      ["boundary"],
    );
    expect(lines).toEqual(["现行红线"]);
  });

  it("带 validTo 的历史行不进卡：与 /v3/soul/person 的读侧同口径（A1 Round20）", () => {
    const lines = cardLinesFromItems(
      [
        item({ layer: "human", text: "已失效的近况", validTo: "2026-11-06T00:00:00.000Z" }),
        item({ layer: "human", text: "空失效期当没有", validTo: "  " }),
        item({ layer: "human", text: "现行近况" }),
      ],
      ["human"],
    );
    expect(lines).toEqual(["空失效期当没有", "现行近况"]);
  });

  it("窗口按证据条数排序：新铸一句挤不掉 4 条证据的老准则", () => {
    const lines = cardLinesFromItems(
      [
        item({ layer: "identity", text: "我宁可先跑一遍验证，也不把没验过的写成已验证", evidenceIds: ["e1"], lastEvidenceAt: "2026-11-07T11:00:00.000Z" }),
        item({ layer: "identity", text: "自己跑过才算数，转述不算", evidenceIds: ["e1", "e2", "e3", "e4"], lastEvidenceAt: "2026-10-01T00:00:00.000Z" }),
        item({ layer: "identity", text: "不确定就说不确定，别猜", evidenceIds: ["e1", "e2"], lastEvidenceAt: "2026-11-06T00:00:00.000Z" }),
      ],
      ["identity"],
    );
    expect(lines[0]).toBe("自己跑过才算数，转述不算");
    expect(lines[1]).toBe("不确定就说不确定，别猜");
    expect(lines[2]).toBe("我宁可先跑一遍验证，也不把没验过的写成已验证");
  });
});


