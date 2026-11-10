import { describe, expect, it, vi } from "vitest";
import {
  CARD_FIELD_SOURCES,
  assembleSoulCard,
  assembleSoulTurn,
  cardLinesFromItems,
  parsePreviousCard,
} from "../card-service.js";
import { seedLabelRows } from "../trait-drift.js";
import { SEED_LABELS, emptyAxisVector, seedStateFromSeeds } from "../traits.js";
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
      item({ layer: "identity", text: "我站在先跑一遍真的这一边" }),
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

describe("soul card service (S2)", () => {
  it("字段来源：表单=declared、观察层=observed、底色/自传=derived", async () => {
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
    expect(card.sources.name).toBe("declared");
    expect(card.sources.traits).toBe("derived");
    expect(card.sources.human).toBe("observed");
    expect(card.sources.autobiography).toBe("derived");
    expect(card.sources).toEqual(CARD_FIELD_SOURCES);
    expect(card.seeded).toBe(true);
    expect(card.text).toContain("## 名称");
    expect(card.text).toContain("阿简");
    expect(card.text).toContain("## 红线");
    expect(card.text).toContain("绝不可删除任何生产记忆记录");
    // 读侧禁词（判据 12）：卡里不出现轴名、不出现算法词。
    for (const banned of ["权重", "算法", "tanh", "α", "warmth", "rigor", "openness"]) {
      expect(card.text).not.toContain(banned);
    }
    // 卡本体不带「未完的事」（那是通道 B）。
    expect(card.text).not.toContain("## 未完的事");
  });

    // 判据「卡完整性 = 底色非空」：表单里设定的特质在没有任何漂移证据时也必须进卡。
  // 生产实测的坏状态：soul_trait_label 全是 status='seed'、evidence=0，旧口径 evidence≥3
  // 让用户在表单里选好的 4 个特质一条都显示不出来，底色恒为「还没有稳到能算数的底色」。
  it("表单声明的特质不需要证据：evidence=0 也进底色（state 已存在）", async () => {
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
    expect(card.text).toContain("## 底色");
    const traitLines = card.text.split("## 底色")[1]!.split("\n## ")[0]!.split("\n").filter((l) => /^- .+ 0\.\d/u.test(l));
    expect(traitLines.length).toBeGreaterThanOrEqual(2);
    expect(card.text).not.toContain("还没有稳到能算数的底色");
    // 读侧仍不许出现轴名与算法词。
    for (const banned of ["严谨轴", "rigor", "warmth", "tanh", "权重"]) expect(card.text).not.toContain(banned);
  });

  it("库里还没有标签行时，声明的特质用种子方向合成视图，底色仍非空", async () => {
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
    expect(card.text).toContain("## 底色");
    expect(card.text).not.toContain("还没有稳到能算数的底色");
  });

  // P1-3：gloss 的唯一数据源是库行（`soul_trait_label.gloss`），不是种子词表。
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
    expect(card.text).toContain("· 库里改过的注解：先验再信。");
    // 「较真」不在种子词表里：这一行能带注解，只可能来自库行。
    expect(card.text).toContain("· 对细节反复核对，不肯放过。");
    expect(card.text).not.toContain(SEED_LABELS.find((s) => s.label === "严谨")!.gloss);
  });

  it("非声明的自生长标签仍被证据门拦住（evidence<3 不进卡）", async () => {
    const rows = seedLabelRows(SEED_LABELS, NOW, { declared: ["严谨"] }).map((r) =>
      r.label === "严谨" ? { ...r, evidence: 0 } : r,
    );
    // 冷淡 是非声明标签：evidence=0，act 再高也不许出现。
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
    expect(card.text).toContain("严谨");
    expect(card.text).not.toContain("冷淡");
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
    // 库内快照行数仍为 1，且其版本就是 second.version（没有凭空多出的一版）。
    expect(again.writes).toHaveLength(0);
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
    expect(card.text).toContain("## 关于你");
    // 表单没给特质时退回 seedState（严谨+直接），底色仍非空——判据 10 的载体不能空。
    expect(card.seeded).toBe(true);
  });

  it("表单特质在无漂移状态时也进底色（D3 左栏）", async () => {
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
