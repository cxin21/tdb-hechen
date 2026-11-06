/**
 * 自维护人格层（m00527）单测 D：worker 编排（导入 → 生长 → 漂移 → 心境 → 单事务落库）。
 *
 * 用内存假 store 驱动，关注「门与状态迁移」而不重复 persona/gates 的细粒度断言。
 * 关键验收：
 *  1) enabled=false 且非 import → 不写库（skipped 说明原因）；
 *  2) 首次导入：29 条式槽行按判据分层，事件句进拒绝/方法池而非注入层；
 *  3) 漂移：无向量器 → driftSkipped 且不伪造分数；有向量器 + 连续低相似 → 判断轨冻结、语体轨只降不冻；
 *  4) 心境：负向信号积分后写 soul_state（含基线），line 说明偏移而不报绝对值。
 */
import { describe, expect, it, vi } from "vitest";
import { createSoulRewriter, runSoulMaintenance, type SoulEvidenceRecord } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import type { PersonaItem, SoulEpisode } from "../types.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(
  opts: {
    core?: Array<{ slot: string; content: string }>;
    items?: PersonaItem[];
    signals?: Array<{ valence: number; arousal: number; occurred_at: string; excerpt?: string | null }>;
    ledger?: Array<Record<string, unknown>>;
    state?: { valence: number; arousal: number; baselineValence: number; baselineArousal: number; updatedAt: string; sampleCount: number };
    /** 事件池：identity/values 的正向判据必须引用真实 ep-*，测试用固定池代表已挖掘事件。 */
    episodes?: SoulEpisode[];
    l0Messages?: Array<{ recordId: string; role: string; text: string; occurredAt?: string }>;
  } = {},
) {
  const items = [...(opts.items ?? [])];
  const writes: Array<{
    valence: number;
    arousal: number;
    baselineValence?: number | null;
    sampleCount?: number | null;
    emotionObject?: string | null;
    emotionLabel?: string | null;
    emotionAt?: string | null;
  }> = [];
  const commits: Array<{ upsert: PersonaItem[]; ledger: unknown[] }> = [];
  // 情绪史落表：worker 用可选方法 commitSoulEmotions，测试里收集调用以便断言「真的写了」。
  const emotionCommits: Array<Array<Record<string, unknown>>> = [];
  const store = {
    readCore: vi.fn(async () => opts.core ?? []),
    listSoulPersona: vi.fn(async () => items.map((i) => ({ ...i }))),
    commitSoulPersona: vi.fn(async (_t: unknown, plan: { upsert: PersonaItem[]; ledger: unknown[] }) => {
      commits.push({ upsert: plan.upsert, ledger: plan.ledger });
      for (const it of plan.upsert) {
        const idx = items.findIndex((x) => x.itemId === it.itemId);
        if (idx >= 0) items[idx] = it;
        else items.push(it);
      }
      return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
    }),
    readSoulState: vi.fn(async () => opts.state ?? null),
    writeSoulState: vi.fn(async (_t: unknown, state: {
      valence: number;
      arousal: number;
      baselineValence?: number | null;
      sampleCount?: number | null;
      emotionObject?: string | null;
      emotionLabel?: string | null;
      emotionAt?: string | null;
    }) => {
      writes.push(state);
    }),
    commitSoulEmotions: vi.fn(async (_t: unknown, rows: Array<Record<string, unknown>>) => {
      emotionCommits.push(rows);
      return { inserted: rows.length };
    }),
    recentAffectSignals: vi.fn(async () => opts.signals ?? []),
    listSoulLedger: vi.fn(async () => opts.ledger ?? []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => opts.episodes ?? []),
    recentL0Messages: vi.fn(async () =>
      (opts.l0Messages ?? []).map((m) => ({
        record_id: m.recordId,
        session_id: "s1",
        role: m.role,
        message_text: m.text,
        recorded_at: m.occurredAt ?? "2026-11-05T09:00:00.000Z",
      })),
    ),
  } as unknown as IMemoryStore;
  return { store, items, commits, writes, emotionCommits };
}

const TEST_EPISODES: SoulEpisode[] = [
  {
    episodeId: "ep-a1b2c3",
    at: "2026-11-02T02:00:00.000Z",
    day: "2026-11-02",
    kind: "correction",
    title: "绿了但没真跑，被指出假绿",
    object: "假绿",
    participants: [],
    userStance: "不接受没真跑就报绿",
    agentStance: "直接认领并重跑",
    cost: "多花一轮时间",
    outcome: "补齐证据",
    valence: -0.5,
    arousal: 0.6,
    intensity: 0.6,
    evidenceIds: ["l0-1"],
    affectSource: "lexicon",
    sessionId: "s1",
    quote: { recordId: "l0-1", text: "没跑就说绿，这是假绿", role: "user" },
  },
  {
    episodeId: "ep-d4e5f6",
    at: "2026-11-03T05:00:00.000Z",
    day: "2026-11-03",
    kind: "divergence",
    title: "先取证还是先交付",
    object: "取证",
    participants: [],
    userStance: "宁可慢也要一手证据",
    agentStance: "想先交付再补",
    cost: "少交付一个功能",
    outcome: "按他说的先取证",
    valence: -0.3,
    arousal: 0.4,
    intensity: 0.4,
    evidenceIds: ["l0-2"],
    affectSource: "lexicon",
    sessionId: "s1",
    quote: { recordId: "l0-2", text: "宁可慢一点，也要一手证据", role: "user" },
  },
];
const EP_IDS = TEST_EPISODES.map((e) => e.episodeId);

const RECORDS: SoulEvidenceRecord[] = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
];

describe("runSoulMaintenance 编排", () => {
  it("节流：未到 updateIntervalHours 不调 LLM/漂移，并如实标注（配置不是死配置）", async () => {
    const rewriter = vi.fn(async () => []);
    const { store, commits } = makeStore({
      core: [{ slot: "strict_rule", content: "- 绝不删除生产数据" }],
      ledger: [{ action: "cadence", at: "2026-11-05T09:00:00.000Z" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true, updateIntervalHours: 6 }),
      recentRecords: async () => RECORDS,
      rewriter,
      embed: async () => [1, 0],
    });
    expect(rewriter).not.toHaveBeenCalled();
    expect(rep.cadenceSkipped).toContain("1.0h < 6h");
    expect(rep.driftSkipped).toContain("节流");
    // 未到期不得写节流锚点（否则窗口会被每 tick 重置，永远跑不起来）。
    const led = commits.at(-1)?.ledger as Array<{ action?: string }>;
    expect(led.some((e) => e.action === "cadence")).toBe(false);
  });

  it("到期待整合：跑 LLM 并落一条 cadence 锚点，下轮据此节流", async () => {
    const rewriter = vi.fn(async () => []);
    const { store, commits } = makeStore({
      core: [{ slot: "strict_rule", content: "- 绝不删除生产数据" }],
      ledger: [{ action: "cadence", at: "2026-11-05T02:00:00.000Z" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true, updateIntervalHours: 6 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rewriter).toHaveBeenCalledTimes(1);
    expect(rep.cadenceSkipped).toBeUndefined();
    const led = commits.at(-1)?.ledger as Array<{ action?: string }>;
    expect(led.filter((e) => e.action === "cadence")).toHaveLength(1);
  });

  it("enabled=false 且非 import：不写库，如实给 skipped", async () => {
    const { store, commits } = makeStore({ core: [{ slot: "strict_rule", content: "- 绝不删除生产数据" }] });
    const rep = await runSoulMaintenance({ store, tenant: TENANT, trigger: "lifecycle", config: resolveSoulConfig({}) });
    expect(rep.skipped).toBe("soulMaintenance.enabled=false");
    expect(commits).toHaveLength(0);
  });

  it("首次导入：红线行进 boundary，事件句/方法论进 method 或拒绝（不进注入层）", async () => {
    const core = [
      { slot: "strict_rule", content: "- 绝不把测试数据写进生产库\n- 我完成 commit b8ba3e0 并推送" },
      { slot: "self_identity", content: "- 我是个先取证再下结论的人" },
    ];
    const { store, items } = makeStore({ core });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "import",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T00:00:00.000Z",
    });
    expect(rep.imported).toBeGreaterThanOrEqual(3);
    const boundary = items.filter((i) => i.layer === "boundary");
    expect(boundary.some((i) => i.text.includes("绝不把测试数据写进生产库"))).toBe(true);
    // 事件句不得进注入层
    for (const it of items.filter((i) => i.layer !== "method")) {
      expect(it.text).not.toContain("b8ba3e0");
    }
    expect(rep.stored).toBe(true);
  });

  it("跨层同文：分类口径更新后换层而不是并存两份（不新增条目、不计变更率）", async () => {
    const text = "何晨是我锚定的「重要的人」，我对他保留完整上下文而不是每次重新自我介绍";
    const legacy = { ...mkItem("values:v", "values", text), evidenceIds: ["slot:identity"] };
    const { store: s2, items } = makeStore({
      items: [legacy],
      core: [{ slot: "identity", content: `- ${text}` }],
    });
    const rep = await runSoulMaintenance({
      store: s2,
      tenant: TENANT,
      trigger: "import",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T00:00:00.000Z",
    });
    expect(rep.reclassified).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.layer).toBe("relationship");
    expect(rep.admitted).toBe(0);
  });

  it("漂移：无向量器 → driftSkipped，且绝不伪造分数", async () => {
    const { store } = makeStore({
      items: [
        {
          itemId: "values:v",
          layer: "values",
          text: "宁可慢交付，也不交付没验证过的结论",
          state: "active",
          weight: 0.8,
          evidenceIds: ["r1"],
          evidenceDays: ["2026-11-01"],
          evidenceOrigins: ["l1"],
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          lastEvidenceAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      recentRecords: async () => RECORDS,
    });
    expect(rep.drift).toEqual([]);
    expect(rep.driftSkipped).toContain("向量器");
  });

  it("漂移：判断轨连续 3 次低相似 → 冻结；语体轨只降不冻", async () => {
    const mk = (layer: "values" | "voice", id: string): PersonaItem => ({
      itemId: id,
      layer,
      text: "我宁可慢交付，也不交付没验证过的结论",
      state: "active",
      weight: 0.8,
      evidenceIds: ["r1"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-01T00:00:00.000Z",
    });
    const anchorsVec = [1, 0];
    // 条目向量与行为锚正交 → 相似度 0，连 3 轮触发
    const embed = async (text: string) => (text.includes("宁可慢交付") ? [0, 1] : anchorsVec);
    const judge = makeStore({ items: [mk("values", "values:j")] });
    for (let i = 0; i < 3; i++) {
      await runSoulMaintenance({
        store: judge.store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: resolveSoulConfig({ enabled: true }),
        recentRecords: async () => RECORDS,
        embed,
        now: `2026-11-0${i + 1}T00:00:00.000Z`,
      });
    }
    expect(judge.items.find((i) => i.itemId === "values:j")!.state).toBe("frozen");

    const voice = makeStore({ items: [mk("voice", "voice:v")] });
    for (let i = 0; i < 3; i++) {
      await runSoulMaintenance({
        store: voice.store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: resolveSoulConfig({ enabled: true }),
        recentRecords: async () => RECORDS,
        embed,
        now: `2026-11-0${i + 1}T00:00:00.000Z`,
      });
    }
    const v = voice.items.find((i) => i.itemId === "voice:v")!;
    expect(v.state).not.toBe("frozen"); // 语体可自我复位，不允许冻结
  });

  it("心境：负向信号 → soul_state 写入带基线，line 描述偏移而非绝对档", async () => {
    const { store, writes } = makeStore({
      signals: [
        { valence: -0.7, arousal: 0.6, occurred_at: "2026-11-05T00:00:00.000Z" },
        { valence: -0.5, arousal: 0.5, occurred_at: "2026-11-05T01:00:00.000Z" },
      ],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].valence).toBeLessThan(0);
    expect(writes[0].baselineValence).toBeDefined();
    expect(rep.mood).not.toBeNull();
    expect(rep.mood!.line.length).toBeGreaterThan(0);
  });

  it("情绪对象：信号带记录摘要时心境行写明「因为…」，无摘要时不编造原因", async () => {
    const withObject = makeStore({
      signals: [{ valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z", excerpt: "何晨指出我把基线失败当通过。这次必须如实报告。" }],
    });
    const rep1 = await runSoulMaintenance({
      store: withObject.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T01:30:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(rep1.mood!.line).toContain("因为「何晨」");

    const blind = makeStore({
      signals: [{ valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z" }],
    });
    const rep2 = await runSoulMaintenance({
      store: blind.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T01:30:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(rep2.mood!.line).not.toContain("因为");
  });

  it("心境增量积分：只吸收上次积分之后的新信号（不把同一批旧信号每小时重新记功）", async () => {
    const prev = {
      valence: 0.1,
      arousal: 0.3,
      baselineValence: 0.1,
      baselineArousal: 0.3,
      updatedAt: "2026-11-05T01:30:00.000Z",
      sampleCount: 7,
    };
    const { store, writes } = makeStore({
      state: prev,
      signals: [
        { valence: -0.9, arousal: 0.8, occurred_at: "2026-11-05T00:30:00.000Z" }, // 上次积分前 → 不得重复吸收
        { valence: -0.9, arousal: 0.8, occurred_at: "2026-11-05T01:45:00.000Z" }, // 新增 → 只算这一条
      ],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(rep.mood!.written).toBe(true);
    expect(writes[0].valence).toBeLessThan(0);
    // 样本数 = 本轮吸收的事件数，不是历史累加：这一轮只进来 1 条新信号。
    // 旧语义是 base.sampleCount + events.length（7+1=8），生产库因此读到 3823——
    // 那不是样本数，只是「重跑过多少轮」。
    expect(writes[0].sampleCount).toBe(1);
  });

  it("首次积分（sampleCount=0）回放整个事件窗口：历史 episode 不再被 updatedAt 挡在心境之外", async () => {
    const { store, writes } = makeStore({
      state: { valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3, updatedAt: "2026-11-05T10:00:00.000Z", sampleCount: 0 },
      episodes: TEST_EPISODES,
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => RECORDS,
      recentL0: async () => [],
    });
    expect(rep.mood!.written).toBe(true);
    // 11-02/11-03 的纠正与分歧都早于 updatedAt，但首次积分必须吸收它们。
    expect(writes[0].sampleCount).toBeGreaterThanOrEqual(2);
    expect(writes[0].valence).toBeLessThan(0);
  });

  it("情绪史随心境一起落表：一条事件一行，带来源事件 id 与模板版本", async () => {
    const { store, emotionCommits } = makeStore({
      state: { valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3, updatedAt: "2026-11-05T10:00:00.000Z", sampleCount: 0 },
      episodes: TEST_EPISODES,
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => RECORDS,
      recentL0: async () => [],
    });
    const rows = emotionCommits[0] ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.episodeId)).toEqual(expect.arrayContaining(["ep-a1b2c3"]));
    expect(rows.every((r) => typeof r.label === "string" && r.label !== "")).toBe(true);
    expect(rows.every((r) => typeof r.templateVersion === "string" && r.templateVersion.startsWith("et-"))).toBe(true);
    // 写的是事件原值，读侧才敢按半衰期重算（写侧衰减会让「多久消退」不可复算）。
    expect(rows[0].intensity).toBeGreaterThan(0);
  });

  it("原因会过期：窗口里只剩一条早就退场的事件时，不再写原因四列（心境照写）", async () => {
    const stale: SoulEpisode = { ...TEST_EPISODES[0], at: "2026-10-10T02:00:00.000Z", day: "2026-10-10" };
    const { store, writes } = makeStore({
      state: { valence: 0, arousal: 0.3, baselineValence: 0, baselineArousal: 0.3, updatedAt: "2026-11-05T10:00:00.000Z", sampleCount: 0 },
      episodes: [stale],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => RECORDS,
      recentL0: async () => [],
    });
    expect(rep.mood!.written).toBe(true);
    // 26 天前的愧疚（半衰期 8h，6 个半衰期=48h）早已过期：不能继续拿它解释今天。
    expect(writes[0].emotionObject ?? null).toBeNull();
    expect(writes[0].emotionLabel ?? null).toBeNull();
    expect(rep.mood!.line).not.toContain("因为");
  });

  const mkItem = (id: string, layer: PersonaItem["layer"], text: string): PersonaItem => ({
    itemId: id,
    layer,
    text,
    state: "active",
    weight: 0.8,
    evidenceIds: ["r1", "r2", "r3"],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastEvidenceAt: "2026-11-05T00:00:00.000Z",
  });

  it("α 有界改写：同一 itemId 内小步更新文本（不是新增一条并存的旧说法）", async () => {
    const oldText = "宁可慢交付，也不交付没验证过的结论";
    const newText = "宁可慢交付，也不交付没过验证的结论";
    const { store, items } = makeStore({ items: [mkItem("values:v", "values", oldText)], episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [{ layer: "values", text: newText, evidenceIds: ["r1", "r2", "r3", ...EP_IDS] }],
    });
    expect(rep.updated).toBe(1);
    expect(rep.admitted).toBe(0);
    const after = items.find((i) => i.itemId === "values:v");
    expect(after?.text).toBe(newText);
    expect((after?.meta as { lastRewriteAt?: string } | undefined)?.lastRewriteAt).toBeTruthy();
    expect(items.filter((i) => i.layer === "values")).toHaveLength(1);
  });

  it("α 上限：改写幅度超过 alpha → 拒绝 alpha_exceeded，旧文本原样保留", async () => {
    const oldText = "宁可慢交付，也不交付没验证过的结论";
    const { store, items } = makeStore({ items: [mkItem("values:v", "values", oldText)], episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [
        // 相似度够格走「同一 itemId 改写」（≈0.71），但改动幅度 ≈0.26 > α=0.15
        { layer: "values", text: `${oldText}，绝不例外`, evidenceIds: ["r1", "r2", "r3", ...EP_IDS] },
      ],
    });
    expect(rep.updated).toBe(0);
    expect(rep.rejections.some((r) => r.codes.includes("alpha_exceeded"))).toBe(true);
    // 拒绝必须出现在观测面：此前 report.rejected 恒 0（从未赋值），生产日志看不出静默丢失。
    expect(rep.rejected).toBe(rep.rejections.length);
    expect(rep.rejected).toBeGreaterThan(0);
    expect(items.find((i) => i.itemId === "values:v")?.text).toBe(oldText);
  });

  it("变更率窗口：windowDays 内已改写 1 次 → 拒绝 window_exceeded（配置项真接线）", async () => {
    const oldText = "宁可慢交付，也不交付没验证过的结论";
    const { store, items } = makeStore({
      items: [mkItem("values:v", "values", oldText)],
      episodes: TEST_EPISODES,
      ledger: [{ action: "update", layer: "values", at: "2026-11-05T01:00:00.000Z", gates: ["alpha_update"] }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true }),
      now: "2026-11-05T03:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: async () => [{ layer: "values", text: "宁可慢交付，也不交付没过验证的结论", evidenceIds: ["r1", "r2", "r3", ...EP_IDS] }],
    });
    expect(rep.updated).toBe(0);
    expect(rep.rejections.some((r) => r.codes.includes("window_exceeded"))).toBe(true);
    expect(items.find((i) => i.itemId === "values:v")?.text).toBe(oldText);
  });

  it("事件证据计入独立证据：只引 ep-* 的候选不再被 insufficient_evidence 误杀", async () => {
    // 生产实拍缺陷（2026-11-05）：生成源已换成事件层，但 minEvidence 只数 L1 证据，
    // 模型按 prompt 只引 ep-* → 每轮 57 条 insufficient_evidence，identity/voice/narrative 恒 0。
    const rewriter = vi.fn(async () => [
      { layer: "identity", text: "我宁可慢一点也要一手证据，放弃速度", evidenceIds: EP_IDS },
    ]);
    const { store, items } = makeStore({ episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections.some((r) => r.codes.includes("insufficient_evidence"))).toBe(false);
    expect(rep.admitted).toBe(1);
    const item = items.find((i) => i.layer === "identity")!;
    // 出处必须可回查：ep-* 在 evidenceIds 里，事件 id 也在 meta（ep → quote.recordId）。
    expect(item.evidenceIds).toEqual(expect.arrayContaining(EP_IDS));
    // 出处要能一路回查到 L0：被引事件的 quote.recordId 也写进 evidenceIds。
    expect(item.evidenceIds).toEqual(expect.arrayContaining(["l0-1", "l0-2"]));
    expect(item.meta?.episodeIds).toEqual(EP_IDS);
  });

  it("关系必须是史：只引 1 个能说原话的事件，被 relationship_history_missing 拒", async () => {
    const rewriter = vi.fn(async () => [
      {
        layer: "relationship",
        text: "他说过「没跑就说绿，这是假绿」，我们之间的信任就靠这个：我要是没跑就报绿，他会当场打断我。",
        evidenceIds: ["ep-a1b2c3"],
      },
    ]);
    const { store } = makeStore({
      episodes: TEST_EPISODES,
      l0Messages: [{ recordId: "l0-1", role: "user", text: "没跑就说绿，这是假绿" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2, minEpisodeEvidence: 2 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections.some((r) => r.codes.includes("relationship_history_missing"))).toBe(true);
    expect(rep.admitted).toBe(0);
  });

  it("LLM 重写器默认 token 预算够推理模型（800 会 content 空，候选恒 0）", async () => {
    const calls: Array<{ maxTokens?: number }> = [];
    const rw = createSoulRewriter(
      {
        run: async (p: { maxTokens?: number }) => {
          calls.push(p);
          return "[]";
        },
      },
      { taskId: "t" },
    );
    await rw({ existing: [], records: [], maxCandidates: 1 });
    expect(calls[0]?.maxTokens).toBeGreaterThanOrEqual(8192);
  });

  it("推理空响应重试一次，真实故障不重试", async () => {
    let n = 0;
    const flaky = createSoulRewriter(
      {
        run: async () => {
          n += 1;
          if (n === 1) throw new Error("LLM empty response (taskId=t, finishReason=length)");
          return '[{"layer":"identity","text":"我宁可慢也不糊弄"}]';
        },
      },
      { taskId: "t" },
    );
    const out = await flaky({ existing: [], records: [], maxCandidates: 1 });
    expect(n).toBe(2);
    expect(out).toHaveLength(1);

    let m = 0;
    const hard = createSoulRewriter(
      {
        run: async () => {
          m += 1;
          throw new Error("LLM request timeout after 120s");
        },
      },
      { taskId: "t" },
    );
    await expect(hard({ existing: [], records: [], maxCandidates: 1 })).rejects.toThrow(/timeout/u);
    expect(m).toBe(1);
  });

  it("prompt 的证据下限与本轮 minEvidence 对齐，不残留占位符", async () => {
    let sys = "";
    const rw = createSoulRewriter(
      {
        run: async (p: { systemPrompt?: string }) => {
          sys = p.systemPrompt ?? "";
          return "[]";
        },
      },
      { taskId: "t" },
    );
    await rw({ existing: [], records: [], maxCandidates: 1, minEvidence: 5 });
    expect(sys).toContain("≥5 个");
    expect(sys).not.toContain("{{MIN_EVIDENCE}}");
    expect(sys).not.toContain("{{MAX_CANDIDATES}}");
    expect(sys).toContain("占满 1 条");
  });

  it("情绪进入判断：偏沉且有对象时，prompt 收到本次倾向，账本留下 arbitrate 可回放", async () => {
    let prompt = "";
    let sys = "";
    const rewriter = createSoulRewriter(
      {
        run: async (req: { prompt: string; systemPrompt?: string }) => {
          prompt = req.prompt;
          sys = req.systemPrompt ?? "";
          return "[]";
        },
      },
      { taskId: "t" },
    );
    const { store, commits } = makeStore({
      state: {
        valence: -0.6,
        arousal: 0.6,
        baselineValence: 0,
        baselineArousal: 0.3,
        updatedAt: "2026-11-05T02:00:00.000Z",
        sampleCount: 4,
      },
      signals: [{ valence: -0.8, arousal: 0.7, occurred_at: "2026-11-05T02:00:00.000Z", excerpt: "门禁又红了" }],
      episodes: TEST_EPISODES,
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, updateIntervalHours: 0, personName: "何晨" }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(prompt).toContain("此刻的判断倾向");
    expect(prompt).toContain("门禁");
    expect(sys).toContain("何晨");
    expect(sys).not.toContain("{{PERSON}}");
    const ledger = commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    const arb = ledger.find((e) => e.action === "arbitrate");
    expect(arb).toBeTruthy();
    expect(String(arb!.reason)).toContain("门禁");
    expect(rep.mood?.line).toContain("近期心境");
  });

  it("拒绝落账本 + rejectTop：说不出出处的人格不只被丢弃，还留下可统计的理由", async () => {
    const { store, commits } = makeStore({ episodes: [] });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true }),
      recentRecords: async () => RECORDS,
      // 有立场（我认为），但没有任何 ep-* 出处 → 正向判据必须拦下。
      rewriter: async () => [{ layer: "identity", text: "我认为证据比速度重要", evidenceIds: ["r1", "r2", "r3"] }],
    });
    expect(rep.admitted).toBe(0);
    const rej = rep.rejections.find((r) => r.codes.includes("episode_missing"));
    expect(rej).toBeTruthy();
    expect(rej!.detail).toBeTruthy();
    const ledger = commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    const entry = ledger.find((e) => e.action === "reject" && Array.isArray(e.gates) && (e.gates as string[]).includes("episode_missing"));
    expect(entry).toBeTruthy();
    expect(String(entry!.entryId)).toMatch(/^rej-identity-/);
    expect(String(entry!.itemId)).toMatch(/^cand:/);
    expect(rep.rejectTop?.find((r) => r.code === "episode_missing")?.count).toBeGreaterThan(0);
  });

  it("旧 voice 是第三人称用户画像 → 冻结并让位，不再注入「我的说话方式」", async () => {
    const old: PersonaItem = {
      itemId: "voice:old",
      layer: "voice",
      text: "他开口像下工单，先给结论，再补证据。",
      state: "active",
      weight: 1,
      evidenceIds: ["r1", "r2", "r3"],
      evidenceDays: ["2026-11-01", "2026-11-02", "2026-11-03"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-03T00:00:00.000Z",
    };
    const { store, items, commits } = makeStore({ items: [old] });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ enabled: true }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [],
    });
    expect(items.find((i) => i.itemId === "voice:old")?.state).toBe("frozen");
    expect(rep.retired).toBeGreaterThanOrEqual(1);
    const ledger = commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    expect(ledger.some((e) => e.action === "retire" && (e.gates as string[]).includes("voice_self_missing"))).toBe(true);
  });

  it("voice 第一人称 + 助手原话 fewShot：不再拿用户原话冒充我的语体", async () => {
    const l0Messages = [
      { recordId: "l0-a1", role: "assistant", text: "我先把真实错误跑出来，再把证据贴给你。" },
      { recordId: "l0-a2", role: "assistant", text: "我按你的标准重跑一遍，不用旧结论凑数。" },
      { recordId: "l0-u1", role: "user", text: "我宁可慢一点，也要一手证据。" },
    ];
    const rewriter = vi.fn(async () => [
      {
        layer: "voice" as const,
        text: "我说话先给结论，再补证据，不绕弯。",
        evidenceIds: [...EP_IDS],
        fewShot: [
          { quote: "我先把真实错误跑出来，再把证据贴给你", recordId: "l0-a1" },
          { quote: "我按你的标准重跑一遍，不用旧结论凑数", recordId: "l0-a2" },
        ],
      },
    ]);
    const { store, items } = makeStore({ episodes: TEST_EPISODES, l0Messages });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections.some((r) => r.codes.includes("voice_self_missing"))).toBe(false);
    expect(rep.admitted).toBe(1);
    const item = items.find((i) => i.layer === "voice")!;
    expect(item.text.startsWith("我")).toBe(true);
    const shots = item.meta?.fewShot as Array<{ recordId: string }>;
    expect(shots.map((s) => s.recordId)).toEqual(["l0-a1", "l0-a2"]);
    // few-shot 的真实 recordId 也进 evidenceIds：审计时一步回查 L0，不用再猜 meta。
    expect(item.evidenceIds).toEqual(expect.arrayContaining(["l0-a1", "l0-a2"]));
  });

  it("identity/values 只引用户单方事件 → agent_stance_missing（不是我的立场）", async () => {
    const blank = TEST_EPISODES.map((e) => ({ ...e, agentStance: "" }));
    const rewriter = vi.fn(async () => [
      { layer: "identity" as const, text: "我宁可慢一点把账算清，也不拿漂亮的假绿过关。", evidenceIds: EP_IDS },
    ]);
    const { store, items } = makeStore({ episodes: blank });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections.some((r) => r.codes.includes("agent_stance_missing"))).toBe(true);
    expect(rep.admitted).toBe(0);
    expect(items.some((i) => i.layer === "identity")).toBe(false);
  });

  // 情绪改变判断的第二处落点：不是换一句文案，而是决定这一轮「长不长我是谁」。
  // 同一次判断在两种心境下必须给出两种结果——否则情绪就只是一个读数。
  it("还在同一个对象上欠着修复时，情绪为自我向 → 这一轮不重写 identity/values（mood_defer_self）", async () => {
    const owed = (agentStance: string): SoulEpisode[] => [
      { ...TEST_EPISODES[0], episodeId: "ep-x1", object: "假绿", agentStance, at: "2026-11-05T01:00:00.000Z" },
      { ...TEST_EPISODES[0], episodeId: "ep-x2", object: "假绿", agentStance, at: "2026-11-05T01:30:00.000Z" },
    ];
    const state = {
      valence: -0.4,
      arousal: 0.5,
      baselineValence: 0,
      baselineArousal: 0.3,
      updatedAt: "2026-11-05T00:30:00.000Z",
      sampleCount: 3,
    };
    const candidate = async () => [
      { layer: "identity" as const, text: "我宁可慢一点把账算清，也不拿漂亮的假绿过关。", evidenceIds: ["r1", "r2", "ep-x1", "ep-x2"] },
    ];
    const open = makeStore({ state, episodes: owed("直接认领，回头再看") });
    const repOpen = await runSoulMaintenance({
      store: open.store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2 }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: candidate,
    });
    const deferred = repOpen.rejections.find((r) => r.codes.includes("mood_defer_self"));
    expect(deferred).toBeTruthy();
    expect(String(deferred!.detail)).toContain("这一轮先修");

    // 同一句候选、同一批证据：修复已经写在我的回复里 → 不再拦，走正常准入。
    const done = makeStore({ state, episodes: owed("已按原话重跑，补上了") });
    const repDone = await runSoulMaintenance({
      store: done.store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ enabled: true, minEvidence: 2 }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: candidate,
    });
    expect(repDone.rejections.some((r) => r.codes.includes("mood_defer_self"))).toBe(false);
  });
});