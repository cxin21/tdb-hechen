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
import { advanceEvidenceClock, createSoulRewriter, runSoulMaintenance, type SoulEvidenceRecord } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import type { PersonaItem, SoulEpisode, SoulGateStatBump } from "../types.js";
import { factsFromEpisode, historyToItems } from "../history.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(
  opts: {
    items?: PersonaItem[];
    signals?: Array<{ valence: number; arousal: number; occurred_at: string; excerpt?: string | null }>;
    ledger?: Array<Record<string, unknown>>;
    state?: {
      valence: number;
      arousal: number;
      baselineValence: number;
      baselineArousal: number;
      updatedAt: string;
      sampleCount: number;
      emotionObject?: string | null;
      emotionLabel?: string | null;
      emotionIntensity?: number | null;
      emotionAt?: string | null;
    };
    /** 事件池：identity/values 的正向判据必须引用真实 ep-*，测试用固定池代表已挖掘事件。 */
    episodes?: SoulEpisode[];
    l0Messages?: Array<{ recordId: string; role: string; text: string; occurredAt?: string }>;
    /** S10：清库重生水位（undefined＝从未清库）。 */
    watermark?: string;
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
    emotionIntensity?: number | null;
    emotionAt?: string | null;
  }> = [];
  const commits: Array<{ upsert: PersonaItem[]; ledger: unknown[] }> = [];
  // 情绪史落表：worker 用可选方法 commitSoulEmotions，测试里收集调用以便断言「真的写了」。
  const emotionCommits: Array<Array<Record<string, unknown>>> = [];
  // P0-2：门拒计数落 soul_gate_stats（不再进账本），收集每 tick 的聚合结果。
  const gateStatCommits: SoulGateStatBump[][] = [];
  /** S10：recentL0Messages 的实参（断言水位下传）。 */
  const l0Calls: Array<{ sinceDays?: number; maxMessages?: number; sinceIso?: string } | undefined> = [];
  const store = {
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
      emotionIntensity?: number | null;
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
    bumpSoulGateStats: vi.fn(async (_t: unknown, rows: SoulGateStatBump[]) => {
      gateStatCommits.push(rows);
      return { bumped: rows.length };
    }),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => opts.episodes ?? []),
    soulMetaGet: vi.fn(async () => opts.watermark),
    recentL0Messages: vi.fn(async (_t: unknown, o?: { sinceDays?: number; maxMessages?: number; sinceIso?: string }) => {
      l0Calls.push(o);
      return (opts.l0Messages ?? []).map((m) => ({
        record_id: m.recordId,
        session_id: "s1",
        role: m.role,
        message_text: m.text,
        recorded_at: m.occurredAt ?? "2026-11-05T09:00:00.000Z",
      }));
    }),
  } as unknown as IMemoryStore;
  return { store, items, commits, writes, emotionCommits, l0Calls, gateStatCommits };
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


  it("A1 Round19：证据时钟只前进到最新证据时间，回填旧事件不重置年龄", () => {
    expect(advanceEvidenceClock("2026-11-10T00:00:00.000Z", ["2026-11-02T00:00:00.000Z", "2026-11-03T05:00:00.000Z"])).toBe(
      "2026-11-10T00:00:00.000Z",
    );
    expect(advanceEvidenceClock("2026-11-10T00:00:00.000Z", ["2026-11-12T00:00:00.000Z"])).toBe("2026-11-12T00:00:00.000Z");
    expect(advanceEvidenceClock("", ["2026-11-02T00:00:00.000Z"])).toBe("2026-11-02T00:00:00.000Z");
    expect(advanceEvidenceClock(undefined, [])).toBe("");
  });

describe("runSoulMaintenance 编排", () => {
  it("S10：清库水位下传给 L0 派生窗口（水位之后才抽事件）", async () => {
    const { store, l0Calls } = makeStore({
      watermark: "2026-11-07T05:16:35.000Z",
      l0Messages: [{ recordId: "l0-1", role: "user", text: "旧对话" }],
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-07T06:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
    });
    // P0-A：tick 末落卡时还会读一次 L0 取 agent 自述名（无 sinceIso），
    // 所以按「带水位的那个调用」断言，而不是 at(-1)。
    expect(l0Calls.find((c) => c?.sinceIso)?.sinceIso).toBe("2026-11-07T05:16:35.000Z");
  });

  // S10 补洞（2026-11-07）：清库水位必须压住「首次积分回看 30 天」。
  // 生产实测清库重启后首个 tick 把旧 L1 重放成 200 样本、05:47 的旧心境原样复活。
  it("S10：水位之前的 L1 信号不得在首次积分里回放，心境保持空", async () => {
    const { store, writes } = makeStore({
      watermark: "2026-11-07T06:28:13.834Z",
      signals: [
        { valence: 0.9, arousal: 0.8, occurred_at: "2026-11-07T05:47:33.000Z" },
        { valence: 0.7, arousal: 0.6, occurred_at: "2026-11-07T05:00:00.000Z" },
      ],
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-07T06:30:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => [],
    });
    const w = writes.at(-1);
    expect(w?.valence).toBe(0);
    expect(w?.sampleCount ?? 0).toBe(0);
  });

  it("S10：水位之后的新 L1 信号照常进心境", async () => {
    const { store, writes } = makeStore({
      watermark: "2026-11-07T06:28:13.834Z",
      signals: [{ valence: 0.9, arousal: 0.8, occurred_at: "2026-11-07T06:29:00.000Z" }],
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-07T06:30:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => [],
    });
    const w = writes.at(-1);
    expect(w?.valence ?? 0).toBeGreaterThan(0);
    expect(w?.sampleCount ?? 0).toBeGreaterThan(0);
  });

  it("结构上不可能过门的确定性候选按 prefilter 计数，不再冒充闸门拒绝", async () => {
    const { store, gateStatCommits } = makeStore({});
    const repeated = "宁可慢一点，也要一手证据，而不是听别人转述";
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-07T06:30:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => [
        { id: "r1", content: repeated },
        { id: "r2", content: repeated },
        { id: "r3", content: repeated },
      ],
    });
    // values 候选缺 ep-* 事件证据：结构上过不了闸门 → 预过滤，单独计数。
    expect(rep.prefiltered).toEqual([{ layer: "values", code: "prefilter_no_episode", count: 1 }]);
    expect(rep.admitted).toBe(0);
    const bumpRows = gateStatCommits.flat();
    expect(bumpRows.some((b) => b.code === "prefilter_no_episode" && b.layer === "values")).toBe(true);
    expect(bumpRows.some((b) => b.code === "dilemma_missing")).toBe(false);
  });

  it("S10：未清库时不传 sinceIso（沿用常规窗口）", async () => {
    const { store, l0Calls } = makeStore({
      l0Messages: [{ recordId: "l0-1", role: "user", text: "对话" }],
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-07T06:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
    });
    expect(l0Calls.at(-1)?.sinceIso).toBeUndefined();
  });

  it("节流：未到 updateIntervalHours 不调 LLM/漂移，并如实标注（配置不是死配置）", async () => {
    const rewriter = vi.fn(async () => []);
    const { store, commits } = makeStore({
      ledger: [{ action: "cadence", at: "2026-11-05T09:00:00.000Z" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ updateIntervalHours: 6 }),
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
      ledger: [{ action: "cadence", at: "2026-11-05T02:00:00.000Z" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ updateIntervalHours: 6 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rewriter).toHaveBeenCalledTimes(1);
    expect(rep.cadenceSkipped).toBeUndefined();
    const led = commits.at(-1)?.ledger as Array<{ action?: string }>;
    expect(led.filter((e) => e.action === "cadence")).toHaveLength(1);
  });

  it("S9：总闸删除后 lifecycle 触发恒跑（不再有 skipped 早退）", async () => {
    const { store, commits } = makeStore();
    const rep = await runSoulMaintenance({ store, tenant: TENANT, trigger: "lifecycle", config: resolveSoulConfig({}) });
    expect(rep.skipped).toBeUndefined();
    expect(rep.stored).toBe(true);
    expect(commits.length).toBeGreaterThan(0);
  });

  // 2026-11-07（P0-0）：随 core_memory 槽位通道移除，两条「槽导入/换层」用例一并删除——
  // 它们锁的是已不存在的通道（imported/reclassified）；人格来源只剩事件史与证据。

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
          evidenceOrigins: ["l1"] as PersonaItem["evidenceOrigins"],
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
      config: resolveSoulConfig({}),
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
        config: resolveSoulConfig({}),
        // A1 Round9 CP5 修好后：同一批锚不再重复计分，所以每轮必须真的换行为窗口。
        recentRecords: async () => [...RECORDS, { id: `drift-${i}`, content: `第 ${i + 1} 轮复查：召回链路的空结果又核了一遍，先取证再改代码。`, valence: -0.2, arousal: 0.4 }],
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
        config: resolveSoulConfig({}),
        // A1 Round9 CP5 修好后：同一批锚不再重复计分，所以每轮必须真的换行为窗口。
        recentRecords: async () => [...RECORDS, { id: `drift-${i}`, content: `第 ${i + 1} 轮复查：召回链路的空结果又核了一遍，先取证再改代码。`, valence: -0.2, arousal: 0.4 }],
        embed,
        now: `2026-11-0${i + 1}T00:00:00.000Z`,
      });
    }
    const v = voice.items.find((i) => i.itemId === "voice:v")!;
    expect(v.state).not.toBe("frozen"); // 语体可自我复位，不允许冻结
  });
  // A1 Round9 CP5：零新行为时不重复计分。旧实现每 tick 都对同一批锚重新打分并 push，
  // 分数一字未变却能把 trailingBelow 堆到阈值——没有任何新证据，卡也会降级/冻结。
  it("A1 Round9：同一批锚重复投票不再追加分数（无新证据不漂移）", async () => {
    const item: PersonaItem = {
      itemId: "values:repeat",
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
      driftHistory: [0.9, 0.9],
    };
    const { store, items } = makeStore({ items: [item] });
    // 与行为锚同向 → 高分，第一 tick 不迁移（这样第二 tick 才测得到「重复投票被跳过」）。
    const embed = async () => [1, 0];
    const tick = (now: string) =>
      runSoulMaintenance({
        store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: resolveSoulConfig({}),
        recentRecords: async () => RECORDS,
        embed,
        now,
      });
    await tick("2026-11-02T00:00:00.000Z");
    const after1 = items.find((i) => i.itemId === "values:repeat")!;
    const hist1 = [...(after1.driftHistory ?? [])];
    // 第一 tick 是「真有新观测」：0.9/0.9 + 这次高分 → 正常记一笔，不迁移。
    expect(hist1.length).toBe(3);
    const stateAfter1 = after1.state;
    const rep2 = await tick("2026-11-03T00:00:00.000Z");
    const after2 = items.find((i) => i.itemId === "values:repeat")!;
    // 第二 tick 锚没换：不再打分、不再 push、状态不动。
    expect(after2.driftHistory?.length).toBe(3);
    expect(after2.state).toBe(stateAfter1);
    expect(rep2.drift).toEqual([]);
    expect(String(rep2.driftSkipped)).toContain("同一批锚");
  });

  // R24-1：快照 provenance 要能指回「哪条输入」。旧 lastDrift 只有 anchorKey（哈希指纹），
  // 拿不到具体记录；这里要求连同锚的 id 一起落盘（顺序与打分时一致）。
  it("A1 Round24：lastDrift 带上锚的记录 id（快照可回指输入）", async () => {
    const item: PersonaItem = {
      itemId: "values:anchors",
      layer: "values",
      text: "先把证据找齐再动手，不靠印象下判断",
      state: "active",
      weight: 0.8,
      evidenceIds: ["r1"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-01T00:00:00.000Z",
    };
    const { store, items } = makeStore({ items: [item] });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
      embed: async () => [1, 0],
      now: "2026-11-02T00:00:00.000Z",
    });
    const after = items.find((i) => i.itemId === "values:anchors")!;
    const drift = (after.meta as { lastDrift?: { anchorIds?: string[]; anchorKey?: string } } | undefined)?.lastDrift;
    expect(drift?.anchorKey).toMatch(/^[0-9a-f]{16}$/);
    expect(drift?.anchorIds).toEqual(RECORDS.map((r) => r.id));
  });

  // P1-1 残留（P1-2 顺带修）：validTo 非空的行既不进注入，也不该再占漂移预算。
  // 修前只按 state 取候选，被结论合并取代的行仍是 active → 照常被判漂移、降级/冻结并多写账本，
  // 而读侧（orderForRender）根本看不到它：一次读侧看不见的迁移。
  it("漂移：validTo 非空的行不进 drift 候选（不占预算、不写迁移账本）", async () => {
    const mk = (id: string, text: string, over: Partial<PersonaItem> = {}): PersonaItem => ({
      itemId: id,
      layer: "voice",
      text,
      state: "active",
      weight: 0.8,
      evidenceIds: ["r1"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-01T00:00:00.000Z",
      ...over,
    });
    const { store, items, commits } = makeStore({
      items: [
        // 两句措辞不同（否则会先被 planMerge 并成一句，轮不到漂移段）。
        // 被取代这条权重更高：修前一定排在被保留那条前面（漂移按权重降序取前 6）。
        mk("voice:expired", "我说话习惯先给结论，再补一句为什么", {
          weight: 0.9,
          validTo: "2026-11-05T00:00:00.000Z",
          supersededBy: "voice:keep",
          supersededReason: "结论合并",
        }),
        mk("voice:keep", "我宁可慢交付，也不交付没验证过的结论", { weight: 0.5 }),
      ],
      // 语体轨的锚 = 我自己说过的话（assistant 原话）。没有这行时语体轨按设计不判，
      // 这条用例就测不到「validTo 行不占漂移预算」。
      l0Messages: [{ recordId: "l0-a1", role: "assistant", text: "我先给结论，再补一句为什么" }],
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
      now: "2026-11-06T00:00:00.000Z",
    });
    // 只有未失效那条被测量（修前这里会是 ["voice:expired", "voice:keep"]）。
    expect(rep.drift.map((d) => d.itemId)).toEqual(["voice:keep"]);
    // 被取代的行一字未动：状态、权重、漂移史都不该被这次 tick 改写。
    const expired = items.find((i) => i.itemId === "voice:expired")!;
    expect(expired.state).toBe("active");
    expect(expired.weight).toBe(0.9);
    expect(expired.driftHistory).toBeUndefined();
    // 也不该为它写 drift/rollback 账本。
    const ledgerRows = commits.flatMap((c) => c.ledger as Array<Record<string, unknown>>);
    expect(ledgerRows.filter((l) => l.itemId === "voice:expired" && (l.layer === "voice" || l.action === "rollback"))).toEqual(
      [],
    );
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
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
      now: "2026-11-05T01:30:00.000Z",
      recentRecords: async () => RECORDS,
    });
    // P2-2 之后同一句话的情绪对象是人称「他」（不再把姓名写进判据）。
    expect(rep1.mood!.line).toContain("因为「他」");

    const blind = makeStore({
      signals: [{ valence: -0.8, arousal: 0.6, occurred_at: "2026-11-05T01:00:00.000Z" }],
    });
    const rep2 = await runSoulMaintenance({
      store: blind.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(rep.mood!.written).toBe(true);
    expect(writes[0].valence).toBeLessThan(0);
    // A2 Round24：样本数是**累计**吸收过的事件数（7 + 本轮新增 1 = 8）。
    // 生产读到 3823 的旧bug不是「累加」本身，而是每轮把整个事件窗口再放一遍（同一批事件被重复计数）；
    // 现在积分只吸收上次 updatedAt 之后的新信号，所以累加值就是真实事件数。
    // 反过来把样本数写成 events.length 会让「这一轮没事件」被读成「从来没有过样本」，
    // 底子行在「偏沉」与「还没有形成可说的底子」之间每 tick 翻面（r24-a2 CP1）。
    expect(writes[0].sampleCount).toBe(8);
  });

  it("A2 Round24：同一条 L1 信号不会被相邻两轮各吸一次（信号取窗有 now 上界）", async () => {
    const signals = [{ valence: -0.6, arousal: 0.6, occurred_at: "2026-11-05T09:58:00.000Z" }];
    const { store, writes } = makeStore({ signals });
    // makeStore 的 readSoulState 恒返 null（每轮都算「首次积分」），这里让上一轮写下的状态能被读回，
    // 否则根本走不到「增量」分支。
    let persisted: Record<string, unknown> | null = null;
    const writeState = (store as unknown as { writeSoulState: (t: unknown, s: Record<string, unknown>) => Promise<void> }).writeSoulState;
    (store as unknown as { readSoulState: () => Promise<Record<string, unknown> | null> }).readSoulState = async () => persisted;
    (store as unknown as { writeSoulState: (t: unknown, s: Record<string, unknown>) => Promise<void> }).writeSoulState = async (t, s) => {
      persisted = s;
      await writeState(t, s);
    };
    const runAt = (now: string) =>
      runSoulMaintenance({
        store,
        tenant: TENANT,
        trigger: "lifecycle",
        config: resolveSoulConfig({}),
        now,
        recentRecords: async () => RECORDS,
      });

    await runAt("2026-11-05T10:00:00.000Z");
    expect(writes.at(-1)?.sampleCount).toBe(1);

    // 下一轮：同一条信号已经积过（now 上界把它挡在窗口外），样本数不能涨。
    await runAt("2026-11-05T11:00:00.000Z");
    expect(writes.at(-1)?.sampleCount).toBe(1);

    // 未来时刻的信号（at 晚于本轮 now）不提前计入。
    const future = makeStore({ signals: [{ valence: -0.9, arousal: 0.9, occurred_at: "2026-11-05T10:30:00.000Z" }] });
    await runSoulMaintenance({
      store: future.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => RECORDS,
    });
    expect(future.writes.at(-1)?.sampleCount ?? 0).toBe(0);
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
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
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

  it("A1 Round8：复现不带新证据时不刷 lastEvidenceAt（degraded 才能按 30/90 天正常老化）", async () => {
    const before = "我答应自己：没亲手跑过的步骤，不写成已验证";
    const text = "我答应自己：没亲手跑过的步骤，不写成已验证过";
    const degraded: PersonaItem = {
      itemId: "self:v",
      layer: "self",
      text: before,
      state: "degraded",
      weight: 0.42,
      // 含 cited 事件 quote.recordId：候选会把 ep→原话的 recordId 一起并进证据（worker.ts:2156）
      evidenceIds: ["r1", "r2", "r3", "ep-a1b2c3", "ep-d4e5f6", "l0-1", "l0-2"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
      lastEvidenceAt: "2026-11-05T00:00:00.000Z",
    };
    // affectSource 不能是 lexicon：本轮 recentL0 为空 → mined 为空，window 内的 lexicon 事件会被 purge 掉
    const { store, items } = makeStore({
      items: [degraded],
      episodes: TEST_EPISODES.map((ep) => ({ ...ep, affectSource: "none" as const })),
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({}),
      now: "2026-11-10T00:00:00.000Z",
      recentRecords: async () => RECORDS,
      // ep-a1b2c3 带 agentStance（我当时的表态），否则 self 门会判 self_not_owned
      // ep-* 必须先出现在 evidenceIds 里才会被过滤进 episodeIds 池（worker.ts:2152）
      rewriter: async () => [
        {
          layer: "self",
          text,
          // self 层要求 ≥2 个出处事件，且每条都要带 agentStance（我当时的表态）
          evidenceIds: ["r1", "r2", "r3", "ep-a1b2c3", "ep-d4e5f6"],
          episodeIds: ["ep-a1b2c3", "ep-d4e5f6"],
        },
      ],
    });
    // A1 Round10（CP1）：改写正文必须有新证据。候选只换了措辞、证据全是旧的 →
    // 拒绝这次改写（no_new_evidence），正文保持原样、年龄也不刷新。
    expect(rep.rejections).toHaveLength(1);
    expect(rep.rejections[0]).toMatchObject({ layer: "self", codes: ["no_new_evidence"] });
    expect(rep.updated).toBe(0);
    const after = items.find((i) => i.itemId === "self:v")!;
    expect(after.text).toBe(before);
    expect(after.lastEvidenceAt).toBe("2026-11-05T00:00:00.000Z");
    expect(after.state).toBe("degraded");
  });

  it("A1 Round13：同文同证据的重谈不写账本（不再 update/drift 交替翻状态）", async () => {
    const text = "我答应自己：没亲手跑过的步骤，不写成已验证";
    const same: PersonaItem = {
      itemId: "self:same",
      layer: "self",
      text,
      state: "degraded",
      weight: 0.42,
      evidenceIds: ["r1", "r2", "ep-a1b2c3", "ep-d4e5f6", "l0-1"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
      lastEvidenceAt: "2026-11-05T00:00:00.000Z",
    };
    const { store, items } = makeStore({
      items: [same],
      episodes: TEST_EPISODES.map((ep) => ({ ...ep, affectSource: "none" as const })),
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({}),
      now: "2026-11-10T00:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: async () => [
        {
          layer: "self",
          text,
          evidenceIds: ["r1", "r2", "ep-a1b2c3", "ep-d4e5f6"],
          episodeIds: ["ep-a1b2c3", "ep-d4e5f6"],
        },
      ],
    });
    // 旧实现会写一条 update（reason=事件史确定性长出）+ 一次 drift 候选，状态在 degraded/active 之间反复；
    // 现在同文同证据直接跳过：updated=0，账本里没有这一条的 update 行（updatedAt 可能被别的
    // 记账路径碰一下，不能作为「有没有落一行」的判据）。
    expect(rep.updated).toBe(0);
    const after = items.find((i) => i.itemId === "self:same")!;
    expect(after.text).toBe(text);
    // state 另有一条 reconcile 路径（本轮未修，见报告 P1）：这里只钉本次修好的不变量——
    // 不再写 update 行，也不再把「重谈」算成一次改写。
    const ledger = (await store.listSoulLedger?.(TENANT, 200)) ?? [];
    expect(ledger.filter((row) => row.itemId === "self:same" && row.action === "update")).toHaveLength(0);
  });
  it("A1 Round9：旧主张每 tick 被重提也挡不住 30/90 天老化（95 天后冻结）", async () => {
    const text = "我答应自己：没亲手跑过的步骤，不写成已验证";
    const aged: PersonaItem = {
      itemId: "self:aged",
      layer: "self",
      text,
      state: "degraded",
      weight: 0.42,
      evidenceIds: ["r1", "r2", "ep-a1b2c3", "l0-1"],
      evidenceDays: ["2026-01-08"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-01-08T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z",
      lastEvidenceAt: "2026-01-10T00:00:00.000Z",
    };
    const { store, items } = makeStore({
      items: [aged],
      episodes: TEST_EPISODES.map((ep) => ({ ...ep, affectSource: "none" as const })),
    });
    // 95 天后，同一批老证据被原样重提：旧代码这里会把 lastEvidenceAt 刷成 now，
    // 于是年龄永为 0，degraded 永远不会冻到 90 天（生产 voice 13/13 degraded 的成因）。
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({}),
      now: "2026-04-15T00:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: async () => [
        { layer: "self", text, evidenceIds: ["r1", "r2", "ep-a1b2c3", "l0-1"], episodeIds: ["ep-a1b2c3"] },
      ],
    });
    const after = items.find((i) => i.itemId === "self:aged")!;
    expect(after.state).toBe("frozen");
    expect(after.lastEvidenceAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("α 上限：改写幅度超过 alpha → 拒绝 alpha_exceeded，旧文本原样保留", async () => {
    const oldText = "宁可慢交付，也不交付没验证过的结论";
    const { store, items } = makeStore({ items: [mkItem("values:v", "values", oldText)], episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({}),
      now: "2026-11-05T03:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: async () => [{ layer: "values", text: "宁可慢交付，也不交付没过验证的结论", evidenceIds: ["r1", "r2", "r3", ...EP_IDS] }],
    });
    expect(rep.updated).toBe(0);
    expect(rep.rejections.some((r) => r.codes.includes("window_exceeded"))).toBe(true);
    expect(items.find((i) => i.itemId === "values:v")?.text).toBe(oldText);
  });

  it("稀疏情绪告警是 diagnostic：level 走 info，不把每轮常态打成 warn", async () => {
    // 生产 2026-11-07：scheduler 已按 class 降级成 info，但 worker 自己仍用 warn 打同一件事，
    // 同一轮里两条日志级别相反——运维看到的仍是「故障」。
    const infos: string[] = [];
    const warns: string[] = [];
    const logger = {
      debug: () => undefined,
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    };
    const { store } = makeStore({ episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "lifecycle",
      config: resolveSoulConfig({ minEvidence: 2 }),
      recentRecords: async () => RECORDS,
      logger: logger as unknown as Parameters<typeof runSoulMaintenance>[0]["logger"],
    });
    const sparse = rep.alerts?.find((a) => a.code === "emotion_label_sparse");
    expect(sparse?.class).toBe("diagnostic");
    expect(infos.some((m) => m.includes("emotion_label_sparse"))).toBe(true);
    expect(warns.some((m) => m.includes("emotion_label_sparse"))).toBe(false);
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
      config: resolveSoulConfig({ minEvidence: 2 }),
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

  it("A3 Round27：单事件 identity 的指称门必须拿到证据原文（接线回归）", async () => {
    // r27i-a3 反证：把 worker.ts 里任一处 evidenceTexts 传参删掉，80 files / 768 tests 全绿——
    // 因为 identity 候选大多引 2 个事件（have≥2 时指称门不启用），单事件路径只在 gates 单测里覆盖。
    // 这条用例走真实 worker：只引 1 个事件 + 代价 + 引号短语，删掉任一接线都会变成 referent_missing。
    const rewriter = vi.fn(async () => [
      { layer: "identity", text: "我宁可慢一点，也不接受「没真跑就报绿」这种事，放弃速度", evidenceIds: ["ep-a1b2c3"] },
    ]);
    const { store, items } = makeStore({ episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ minEvidence: 1, minEpisodeEvidence: 1 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.admitted).toBe(1);
    expect(items.find((i) => i.layer === "identity")?.text).toContain("没真跑就报绿");
  });

  it("A3 Round27：更新路径的单事件 identity 也要拿到证据原文（:959 接线）", async () => {
    // r27j-a3 反证：把 worker.ts 更新路径那处 evidenceTexts 删掉，全量用例仍全绿。
    // 这里先落一条 identity，再让重写器把同一句改长（同文本会被 sameText 静默跳过，不能当断言）。
    const seedText = "我宁可慢一点，也不接受「没真跑就报绿」这种事；每次都要先跑一遍再说，报告里写清楚哪条过了、哪条没过。";
    const seed = mkItem("identity:r27-upd", "identity", seedText);
    const rewriter = vi.fn(async () => [
      { layer: "identity", text: `${seedText.slice(0, -1)}，放弃速度。`, evidenceIds: ["ep-a1b2c3"] },
    ]);
    const { store, items } = makeStore({ items: [seed], episodes: TEST_EPISODES });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({ minEvidence: 1, minEpisodeEvidence: 1 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections).toEqual([]);
    expect(rep.updated).toBe(1);
    expect(items.find((i) => i.layer === "identity" && i.itemId === "identity:r27-upd")?.text).toContain("放弃速度");
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
      config: resolveSoulConfig({ minEvidence: 2, minEpisodeEvidence: 2 }),
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
        // A2 Round24 r24c-a2：判断轨取窗不再放宽 5 分钟，信号要真的晚于上次积分时刻才作数。
        updatedAt: "2026-11-05T01:30:00.000Z",
        sampleCount: 4,
      },
      signals: [{ valence: -0.8, arousal: 0.7, occurred_at: "2026-11-05T02:00:00.000Z", excerpt: "门禁又红了" }],
      episodes: TEST_EPISODES,
    });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ updateIntervalHours: 0, personName: "何晨" }),
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

  // A2 Round24（r24d-a2）：判断轨的心境取窗要和主路径同口径——只收「上次积分之后、且不晚于此刻」的
  // 信号。旧代码留着 5 分钟重叠带、也没有上界，同一条信号会被相邻两轮各喂一次，未来的信号还会被提前算进来。
  it("A2 Round24：判断轨只喂上次积分之后的信号，未来信号不提前入账", async () => {
    const run = async (occurredAt: string) => {
      let prompt = "";
      const rewriter = createSoulRewriter(
        {
          run: async (req: { prompt: string }) => {
            prompt = req.prompt;
            return "[]";
          },
        },
        { taskId: "t" },
      );
      const { store } = makeStore({
        state: {
          valence: -0.6,
          arousal: 0.6,
          baselineValence: 0,
          baselineArousal: 0.3,
          updatedAt: "2026-11-05T02:00:00.000Z",
          sampleCount: 4,
        },
        signals: [{ valence: -0.8, arousal: 0.7, occurred_at: occurredAt, excerpt: "门禁又红了" }],
        episodes: TEST_EPISODES,
      });
      await runSoulMaintenance({
        store,
        tenant: TENANT,
        trigger: "manual",
        config: resolveSoulConfig({ updateIntervalHours: 0, personName: "何晨" }),
        now: "2026-11-05T02:10:00.000Z",
        recentRecords: async () => RECORDS,
        rewriter,
      });
      return prompt;
    };
    // 上次积分在 02:00，这条 01:58 的信号已经在上一轮被吸收过：不能再喂一次。
    expect(await run("2026-11-05T01:58:00.000Z")).not.toContain("门禁又红了");
    // 02:05 的信号晚于 now（02:10 前就入账？此处 now=02:10，故该条应计入）——用来证明窗口没有把正常信号也挡掉。
    expect(await run("2026-11-05T02:05:00.000Z")).toContain("门禁又红了");
    // 02:20 晚于 now：未来信号不许提前当成「此刻的心情」。
    expect(await run("2026-11-05T02:20:00.000Z")).not.toContain("门禁又红了");
  });

  it("情绪门看最近一次事件是否修复：旧补丁不能给新欠账永久放行", async () => {
    const base = {
      day: "2026-11-05",
      kind: "complaint" as const,
      title: "被当面指出不对",
      object: "被当面指出不对",
      participants: ["他", "我"],
      cost: "",
      outcome: "",
      valence: -0.5,
      arousal: 0.6,
      intensity: 0.6,
      evidenceIds: ["l0-gate"],
      sessionId: "s-gate",
      quote: { recordId: "l0-gate", text: "这处不对", role: "user", at: "2026-11-05T01:00:00.000Z" },
      affectSource: "lexicon" as const,
    };
    const repairedOld: SoulEpisode = {
      ...base,
      episodeId: "ep-gate-old-repaired",
      at: "2026-11-05T01:00:00.000Z",
      userStance: "这处不对，你改坏了",
      agentStance: "我漏了，已经补上了",
    };
    // 旧账修过，但后来同一对象又漏了一次，且这次没修：最近一次 = 未修复，门必须响。
    const reopened: SoulEpisode = {
      ...base,
      episodeId: "ep-gate-new-open",
      at: "2026-11-05T03:00:00.000Z",
      userStance: "这里又不对，你改坏了",
      agentStance: "我先看一下",
      quote: { recordId: "l0-gate-2", text: "这里又不对", role: "user", at: "2026-11-05T03:00:00.000Z" },
    };
    const state = {
      valence: -0.5,
      arousal: 0.6,
      baselineValence: 0,
      baselineArousal: 0.3,
      updatedAt: "2026-11-05T00:00:00.000Z",
      sampleCount: 4,
    };
    const openRun = makeStore({ state, episodes: [repairedOld, reopened] });
    await runSoulMaintenance({
      store: openRun.store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ updateIntervalHours: 0 }),
      now: "2026-11-05T04:00:00.000Z",
      recentRecords: async () => [],
    });
    const openLedger = openRun.commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    const gate = openLedger.find((e) => Array.isArray(e.gates) && (e.gates as string[]).includes("mood_gate"));
    expect(gate).toBeTruthy();
    expect(String(gate!.reason)).toContain("mood_defer_self");
    expect(String(gate!.reason)).toContain("repaired=false");
    expect(String(gate!.reason)).toContain("latest=2026-11-05T03:00:00.000Z");

    // 反向：旧账没修、但最近一次已经修好 → 最近一次是 repaired，门不响（不永久封禁）。
    const latestRepaired: SoulEpisode = {
      ...reopened,
      episodeId: "ep-gate-new-repaired",
      agentStance: "我漏了，已经补上了",
    };
    const doneRun = makeStore({ state, episodes: [{ ...repairedOld, agentStance: "我先看一下" }, latestRepaired] });
    await runSoulMaintenance({
      store: doneRun.store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ updateIntervalHours: 0 }),
      now: "2026-11-05T04:00:00.000Z",
      recentRecords: async () => [],
    });
    const doneLedger = doneRun.commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    expect(doneLedger.some((e) => Array.isArray(e.gates) && (e.gates as string[]).includes("mood_gate"))).toBe(false);
  });

  it("拒绝进 soul_gate_stats、不进账本：说不出出处的人格留下可统计的理由", async () => {
    const { store, commits, gateStatCommits } = makeStore({ episodes: [] });
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
      // 有立场（我认为），但没有任何 ep-* 出处 → 正向判据必须拦下。
      rewriter: async () => [{ layer: "identity", text: "我认为证据比速度重要", evidenceIds: ["r1", "r2", "r3"] }],
    });
    expect(rep.admitted).toBe(0);
    const rej = rep.rejections.find((r) => r.codes.includes("episode_missing"));
    expect(rej).toBeTruthy();
    expect(rej!.detail).toBeTruthy();
    // P0-2：拒绝不再占账本行。
    const ledger = commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    expect(ledger.some((e) => e.action === "reject")).toBe(false);
    // 但仍按 (day, code, layer) 聚合落 soul_gate_stats。
    const stats = gateStatCommits.at(-1) ?? [];
    const hit = stats.find((s) => s.code === "episode_missing" && s.layer === "identity");
    expect(hit).toBeTruthy();
    expect(hit!.count).toBeGreaterThan(0);
    expect(hit!.day).toBe(rep.at.slice(0, 10));
    expect(rep.rejectTop?.find((r) => r.code === "episode_missing")?.count).toBeGreaterThan(0);
  });

  it("A1 Round26：模型引用 L1 记录 id 时走两跳解析，不再因 m_* 被清空事件证据", async () => {
    const eps: SoulEpisode[] = [
      { ...TEST_EPISODES[0], episodeId: "ep-r26a", quote: { recordId: "msg-r26", text: "先取证再动手", role: "user" } },
      { ...TEST_EPISODES[1], episodeId: "ep-r26b", quote: { recordId: "msg-r26", text: "先取证再动手", role: "user" } },
    ];
    const { store, commits } = makeStore({ episodes: eps });
    (store as unknown as { getL1ByIdsWithArchive: (ids: string[]) => Promise<Array<{ record_id: string; source_message_ids: string[] }>> })
      .getL1ByIdsWithArchive = async (ids) => (ids.includes("m_r26") ? [{ record_id: "m_r26", source_message_ids: ["msg-r26"] }] : []);
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ updateIntervalHours: 0 }),
      recentRecords: async () => RECORDS,
      rewriter: async () => [{ layer: "identity", text: "我宁可先跑一遍验证，也不把没验过的写成已验证", evidenceIds: ["m_r26"] }],
    });
    expect(rep.admitted).toBeGreaterThan(0);
    const ledger = commits.at(-1)!.ledger as Array<Record<string, unknown>>;
    const admit = ledger.find((e) => e.action === "admit" && e.layer === "identity");
    expect(admit).toBeTruthy();
    // 事件出处落在条目 meta.episodeIds 上（账本只记 L1/消息出处），两条 ep-* 都要在。
    const item = commits.at(-1)!.upsert.find((i) => i.layer === "identity");
    const meta = JSON.stringify(item?.meta ?? {});
    expect(meta).toContain("ep-r26a");
    expect(meta).toContain("ep-r26b");
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
      config: resolveSoulConfig({}),
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
      config: resolveSoulConfig({ minEvidence: 2 }),
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
      config: resolveSoulConfig({ minEvidence: 2 }),
      recentRecords: async () => RECORDS,
      rewriter,
    });
    expect(rep.rejections.some((r) => r.codes.includes("agent_stance_missing"))).toBe(true);
    expect(rep.admitted).toBe(0);
    expect(items.some((i) => i.layer === "identity")).toBe(false);
  });

  // S5：情绪不再有否决权（mood_gate defer 退场）。同一对象欠账时门仍可观测，
  // 但不能把有证据的候选整轮挡在门外——两种心境下准入结果必须一致。
  it("同一对象欠着修复时情绪门只观测不否决（observed_only）", async () => {
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
      config: resolveSoulConfig({ minEvidence: 2 }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: candidate,
    });
    expect(repOpen.rejections.some((r) => r.codes.includes("mood_defer_self"))).toBe(false);
    expect(repOpen.mood?.gate?.opened).toBe(true);
    expect(repOpen.mood?.gate?.focus).toBe("self");

    // 同一句候选、同一批证据：修复已写在回复里 → 门本就不响；两轮准入结果一致。
    const done = makeStore({ state, episodes: owed("已按原话重跑，补上了") });
    const repDone = await runSoulMaintenance({
      store: done.store,
      tenant: TENANT,
      trigger: "manual",
      config: resolveSoulConfig({ minEvidence: 2 }),
      now: "2026-11-05T02:00:00.000Z",
      recentRecords: async () => RECORDS,
      rewriter: candidate,
    });
    expect(repDone.rejections.some((r) => r.codes.includes("mood_defer_self"))).toBe(false);
    expect(repDone.admitted).toBe(repOpen.admitted);
    expect(repDone.rejected).toBe(repOpen.rejected);
  });

  it("情绪强度过期后仍保留对象锚，只把强度置空（S5）", async () => {
    const state = {
      valence: -0.2,
      arousal: 0.3,
      baselineValence: 0,
      baselineArousal: 0.3,
      updatedAt: "2026-11-01T00:00:00.000Z",
      sampleCount: 3,
      emotionObject: "假绿",
      emotionLabel: "恼火",
      emotionIntensity: 0.8,
      emotionAt: "2026-11-01T00:00:00.000Z",
    };
    const { store, writes } = makeStore({ state, episodes: [], signals: [] });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      now: "2026-11-05T10:00:00.000Z",
      trigger: "manual",
      config: resolveSoulConfig({}),
      recentRecords: async () => [],
      rewriter: async () => [],
    });
    expect(writes.length).toBeGreaterThan(0);
    const last = writes[writes.length - 1]!;
    expect(last.emotionObject).toBe("假绿");
    expect(last.emotionLabel).toBe("恼火");
    expect(last.emotionAt).toBe("2026-11-01T00:00:00.000Z");
    expect(last.emotionIntensity ?? null).toBeNull();
  });

  it("点名回滚在下一轮 tick 执行，没有请求时不碰任何条目", async () => {
    const target = mkItem("self:hx-owed", "self", "我没守住：导出那一格我漏了。");
    const rolled: string[][] = [];
    const { store } = makeStore({
      items: [target],
      ledger: [{
        entryId: "rq-1",
        at: "2026-11-05T09:00:00.000Z",
        trigger: "manual",
        layer: "self",
        itemId: target.itemId,
        action: "rollback",
        gates: ["rollback_requested"],
        reason: "点名撤销",
      }],
    });
    (store as unknown as { rollbackSoulPersona: ReturnType<typeof vi.fn> }).rollbackSoulPersona = vi.fn(
      async (_t: unknown, ids: string[], opts: { gate?: string }) => {
        rolled.push(ids);
        expect(opts.gate).toBe("lifecycle_rollback");
        return { restored: 0, removed: 1, skipped: 0 };
      },
    );
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => [],
      recentL0: async () => [],
    });
    expect(rolled).toEqual([[target.itemId]]);
    expect(rep.alerts?.some((a) => a.code === "rollback_applied")).toBe(true);

    const quiet = makeStore({ items: [target] });
    (quiet.store as unknown as { rollbackSoulPersona: ReturnType<typeof vi.fn> }).rollbackSoulPersona = vi.fn(async () => {
      throw new Error("没有请求不该调用回滚");
    });
    await runSoulMaintenance({
      store: quiet.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => [],
      recentL0: async () => [],
    });
  });

  it("矛盾进账本：同对象更晚的未修复失败让「我补上了」+1，达阈值冻结", async () => {
    const mkEp = (over: Partial<SoulEpisode>): SoulEpisode => ({
      episodeId: "ep-1",
      at: "2026-11-04T09:00:00.000Z",
      day: "2026-11-04",
      kind: "correction",
      title: "",
      object: "列表按钮状态",
      participants: ["何晨"],
      userStance: "列表按钮状态处理不对",
      agentStance: "已按原话重做并对齐",
      cost: "",
      outcome: "",
      valence: -0.5,
      arousal: 0.5,
      intensity: 0.5,
      evidenceIds: ["r1"],
      sessionId: "s1",
      quote: null,
      affectSource: "lexicon",
      signals: [],
      ...over,
    });
    // 条目按生产口径生成：meta.object 与 referent(ep) 是同一口径，测试不自己编锚。
    const seedEp = mkEp({});
    const repairItem = historyToItems(factsFromEpisode(seedEp), "2026-11-04T12:00:00.000Z").find(
      (i) => i.layer === "self" && i.meta?.historyKind === "review",
    );
    expect(repairItem).toBeTruthy();
    const { store, items } = makeStore({
      items: [repairItem as PersonaItem],
      episodes: [
        seedEp,
        mkEp({ episodeId: "ep-2", at: "2026-11-05T09:00:00.000Z", day: "2026-11-05", agentStance: "这个问题我先看一下", intensity: 0.4 }),
      ],
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({ freezeContradictions: 1 }),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => [],
      recentL0: async () => [],
    });
    const after = items.find((i) => i.itemId === repairItem!.itemId);
    expect(after?.contradictions).toBe(1);
    expect(after?.meta?.lastContradictionEpisode).toBe("ep-2");
    expect(after?.state).toBe("frozen");
  });

  it("已经执行过的点名回滚不再执行第二遍", async () => {
    const target = mkItem("self:hx-owed2", "self", "我没守住：导出那一格我漏了。");
    const { store } = makeStore({
      items: [target],
      ledger: [
        { entryId: "rq-2", at: "2026-11-05T09:00:00.000Z", trigger: "manual", layer: "self", itemId: target.itemId, action: "rollback", gates: ["rollback_requested"], reason: "点名撤销" },
        { entryId: "rb-2", at: "2026-11-05T09:10:00.000Z", trigger: "rollback", layer: "self", itemId: target.itemId, action: "rollback", gates: ["lifecycle_rollback"], reason: "已执行" },
      ],
    });
    (store as unknown as { rollbackSoulPersona: ReturnType<typeof vi.fn> }).rollbackSoulPersona = vi.fn(async () => {
      throw new Error("已执行的请求不该再撤一次");
    });
    await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      now: "2026-11-05T10:00:00.000Z",
      recentRecords: async () => [],
      recentL0: async () => [],
    });
  });

  // A1 Round24（r24d-a1）：复活必须在 worker 层被覆盖。纯函数 planRevive 已经有用例，
  // 但 worker 分支若仍写 `...target`，persona 里的 delete 在运行时等于没生效——复活后
  // 下一次 measureDrift 立刻读旧漂移史，相邻 tick 里冻回去。
  it("A1 Round24：复活清掉漂移史，不会在下一 tick 被旧史冻回去", async () => {
    const mkFrozen = (evidenceIds: string[]): PersonaItem => ({
      itemId: "values:revive",
      layer: "values",
      text: "宁可慢交付，也不交付没验证过的结论",
      state: "frozen",
      weight: 0.4,
      evidenceIds,
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-01T00:00:00.000Z",
      validTo: "2026-11-01T00:00:00.000Z",
      driftHistory: [0.02, 0.03, 0.01],
      meta: { lastDrift: { score: 0.02, verdict: "freeze", anchorKey: "stale-anchor" } },
    });
    const cand = { layer: "values" as const, text: "宁可慢交付，也不交付没验证过的结论", evidenceIds: ["r1", "r2", ...EP_IDS] };

    // 情况 A：候选带来没见过的新证据 → 复活，且旧漂移史/失效期都不带进新行。
    const a = makeStore({ items: [mkFrozen(["r-old"])], episodes: TEST_EPISODES });
    await runSoulMaintenance({
      store: a.store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: resolveSoulConfig({}),
      recentRecords: async () => RECORDS,
      rewriter: async () => [cand],
      now: "2026-11-05T00:00:00.000Z",
    });
    const revived = a.items.find((i) => i.itemId === "values:revive")!;
    expect(revived.state).toBe("active");
    expect(revived.driftHistory).toBeUndefined();
    expect(revived.validTo).toBeUndefined();
    expect(a.items.filter((i) => i.itemId === "values:revive")).toHaveLength(1);

  });
});