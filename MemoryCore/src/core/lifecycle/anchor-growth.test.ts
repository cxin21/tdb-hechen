/**
 * Task GROW RED 套件：自生长流水线 runAnchorGrowth（调度器挂钩核心）。
 *
 * 契约（task-grow-brief §1 + 报告 §0.4）：
 *   - 触发双门：距上次发现 ≥ intervalHours 且语料有新增；任一不过 → 不跑、不更新状态
 *   - 护栏四件：证据 ≥ minEvidence(5) / 每轮 ≤ maxPerPass(2) / 总名额 maxTotal(15) /
 *     去重查全态（veto 永不重提）
 *   - 挤出：名额满时 新候选强度(weight×evidence) > 最弱自生长锚（pinned 豁免）才替换；
 *     被挤出者 retire（state='retired'）
 *   - 复用 DISC 导出（禁第二份）：selectSampleRows/buildDiscoverPrompt/parse/dedup/recount/weight
 *   - 仅 default 桶；状态轮次完成后持久化（lastDiscoveryAt/lastCorpusCount）
 *   - value_id：slug(label)；纯 CJK → auto-<sha256[:10]>（ASCII，pin/retire/delete 路由可用）
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth, DEFAULT_ANCHOR_DISCOVERY_CONFIG, growthValueId } from "./anchor-growth.js";
import { suggestAnchorWeight } from "../../gateway/core-values-discover.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const DEFAULT_TENANT = { teamId: "default", userId: "default", agentId: "default" };

type AnyRow = { value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" };

function row(value_id: string, label: string, opts: Partial<AnyRow> = {}): AnyRow {
  return { value_id, label, weight: 0.5, created_by: "verify", valence: null, origin: "manual", pinned: 0, state: "active", ...opts };
}

function corpusRow(id: string, content: string, updated = "2026-09-09T00:00:00Z") {
  return {
    record_id: id, content, type: "episodic", priority: 0.5, scene_name: "", session_key: "",
    session_id: "s1", team_id: "default", task_id: "", user_id: "default", agent_id: "default",
    version: 1, timestamp_str: updated, timestamp_start: updated, timestamp_end: updated,
    created_time: updated, updated_time: updated, metadata_json: "{}",
  };
}

/** 语料：label 关键词命中 n 条（CJK 整串包含判定，与 recountEvidence 同口径）。 */
function corpusFor(label: string, n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => corpusRow(`r${i}`, `第${i}条 关于${label}的记忆`));
}

function makeStore(opts: {
  rows?: unknown[];
  anyState?: AnyRow[];
  active?: AnyRow[];
  growthState?: { lastDiscoveryAt: string | null; lastCorpusCount: number | null };
} = {}) {
  const setGrowth = vi.fn();
  return {
    queryL1Records: vi.fn(async () => opts.rows ?? []),
    listValuesAnyState: vi.fn(async () => opts.anyState ?? []),
    listValues: vi.fn(async () => opts.active ?? []),
    upsertValue: vi.fn(async () => true),
    retireValue: vi.fn(async () => true),
    getAnchorGrowthState: vi.fn(async () => opts.growthState ?? { lastDiscoveryAt: null, lastCorpusCount: null }),
    setAnchorGrowthState: setGrowth,
  };
}

function makeRunner(reply: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    run: async (params: Record<string, unknown>) => { calls.push(params); return reply; },
    calls,
  };
}

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const now = () => NOW;

describe("runAnchorGrowth 触发双门", () => {
  it("config.enabled=false → 不跑（无 LLM 调用、无状态写）", async () => {
    const store = makeStore();
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: { enabled: false }, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "disabled" });
    expect(runner.calls).toHaveLength(0);
    expect(store.setAnchorGrowthState).not.toHaveBeenCalled();
  });

  it("无 llmRunner → 不跑（consolidation 同款 LLM 门）", async () => {
    const store = makeStore({ rows: corpusFor("增量对账", 9) });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: undefined, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "no-llm" });
  });

  it("interval 未到（上次发现 23h 前 < 24h）→ 不跑；语料/LLM 零触碰", async () => {
    const twentyThreeHAgo = new Date(NOW.getTime() - 23 * 3600_000).toISOString();
    const store = makeStore({ rows: corpusFor("增量对账", 9), growthState: { lastDiscoveryAt: twentyThreeHAgo, lastCorpusCount: 9 } });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "interval" });
    expect(runner.calls).toHaveLength(0);
    expect(store.setAnchorGrowthState).not.toHaveBeenCalled();
    expect(store.queryL1Records).not.toHaveBeenCalled();
  });

  it("interval 已到但语料无新增（count ≤ 基线）→ 不跑；lastDiscoveryAt 不被消费（下 tick 重查）", async () => {
    const twentyFiveHAgo = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
    const state = { lastDiscoveryAt: twentyFiveHAgo, lastCorpusCount: 9 };
    const store = makeStore({ rows: corpusFor("增量对账", 9), growthState: state });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "no-new-corpus" });
    expect(runner.calls).toHaveLength(0);
    expect(store.setAnchorGrowthState).not.toHaveBeenCalled(); // 状态保持，不消费间隔
  });

  it("interval 已到且语料新增 → 跑；状态持久化（lastDiscoveryAt=now / lastCorpusCount=当前条数）", async () => {
    const twentyFiveHAgo = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
    const rows = corpusFor("增量对账", 9);
    const store = makeStore({ rows, growthState: { lastDiscoveryAt: twentyFiveHAgo, lastCorpusCount: 8 } });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(store.setAnchorGrowthState).toHaveBeenCalledWith({ lastDiscoveryAt: NOW.toISOString(), lastCorpusCount: 9, lastAttemptAt: NOW.toISOString() });
  });
});

describe("runAnchorGrowth 护栏四件", () => {
  const GROWTH_STATE = { lastDiscoveryAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString(), lastCorpusCount: 4 };

  it("证据门槛：4 条命中不提（< minEvidence 5）；5 条命中采纳（origin='auto'，default 桶，建议权重）", async () => {
    // 4 条命中语料（corpus count 4 > 基线 3，触发跑）
    const store4 = makeStore({ rows: corpusFor("增量对账", 4), growthState: { ...GROWTH_STATE, lastCorpusCount: 3 } });
    const runner4 = makeRunner(JSON.stringify([{ label: "增量对账", rationale: "r", evidenceCount: 99 }]));
    const res4 = await runAnchorGrowth({ store: store4 as never, llmRunner: runner4 as never, logger: LOG, now });
    expect(res4).toMatchObject({ ran: true, adopted: 0 });
    expect(store4.upsertValue).not.toHaveBeenCalled();

    const rows5 = corpusFor("增量对账", 5);
    const store5 = makeStore({ rows: rows5, growthState: { ...GROWTH_STATE, lastCorpusCount: 4 } });
    const runner5 = makeRunner(JSON.stringify([{ label: "增量对账", rationale: "r", evidenceCount: 1 }]));
    const res5 = await runAnchorGrowth({ store: store5 as never, llmRunner: runner5 as never, logger: LOG, now });
    expect(res5).toMatchObject({ ran: true, adopted: 1 });
    expect(store5.upsertValue).toHaveBeenCalledWith(
      expect.any(String), "增量对账", suggestAnchorWeight(5, 5), "auto-growth", DEFAULT_TENANT, undefined, "auto",
    );
  });

  it("每轮上限：3 个达标候选只采纳 2（maxPerPass）", async () => {
    const rows = [
      ...corpusFor("甲主题", 6), // 每 6 条里 6 命中 → 证据 6
    ];
    // 三个互不重叠主题、各 6 条命中 → 语料 18 条
    const threeTopics = [
      ...corpusFor("甲主题", 6),
      ...corpusFor("乙主题", 6),
      ...corpusFor("丙主题", 6),
    ];
    const store = makeStore({ rows: threeTopics, growthState: { ...GROWTH_STATE, lastCorpusCount: 17 } });
    const runner = makeRunner(JSON.stringify([
      { label: "丙主题", rationale: "r" }, { label: "乙主题", rationale: "r" }, { label: "甲主题", rationale: "r" },
    ]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: true, adopted: 2 });
    expect(store.upsertValue).toHaveBeenCalledTimes(2);
    expect(store.upsertValue.mock.calls.map((c) => (c as unknown[])[1]).sort()).toEqual(["丙主题", "乙主题"]); // 证据并列按稳定序取 LLM 前两名
  });

  it("veto 永不重提：LLM 提案 label 命中 vetoed 行 → 丢弃（dedup 查全态）", async () => {
    const store = makeStore({
      rows: corpusFor("已否决主题", 6),
      anyState: [row("v1", "已否决主题", { state: "vetoed" })],
      growthState: { ...GROWTH_STATE, lastCorpusCount: 5 },
    });
    const runner = makeRunner(JSON.stringify([{ label: "已否决主题", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: true, adopted: 0 });
    expect(store.upsertValue).not.toHaveBeenCalled();
  });

  it("名额未满 → 直接入活跃池（pinned 计入名额）", async () => {
    const store = makeStore({
      rows: corpusFor("新主题", 6),
      anyState: [row("p1", "钉住种子", { origin: "seed", pinned: 1 })],
      growthState: { ...GROWTH_STATE, lastCorpusCount: 5 },
    });
    const runner = makeRunner(JSON.stringify([{ label: "新主题", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    // 名额 15：pinned 1 + autoActive 0 → 有空位
    expect(res).toMatchObject({ ran: true, adopted: 1, displaced: 0 });
    expect(store.retireValue).not.toHaveBeenCalled();
  });
});

describe("runAnchorGrowth 挤出（名额满）", () => {
  const FULL_STATE = { lastDiscoveryAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString(), lastCorpusCount: 5 };

  /** 名额满固定场景：maxTotal=2；pinned 种子 1 + auto 活跃 2（超发？不——用 maxTotal=3）。 */
  function fullStore(autoRows: AnyRow[], opts: { pinned?: AnyRow[]; maxTotal?: number } = {}) {
    return makeStore({
      rows: corpusFor("强候选主题", 8),
      anyState: [
        ...(opts.pinned ?? [row("p1", "钉住种子", { origin: "seed", pinned: 1 })]),
        ...autoRows,
      ],
      growthState: { ...FULL_STATE, lastCorpusCount: 7 },
    });
  }

  it("候选强度 > 最弱 auto 锚（pinned 豁免）→ 挤出最弱（retire）+ 采纳候选", async () => {
    // maxTotal=3：pinned 1 + auto 2 = 满。最弱 auto：弱锚（weight 0.3 × 语料命中 0 = 0）<
    // 候选（0.3+0.5*8/8=0.8 × 8 = 6.4）
    const store = fullStore(
      [
        row("a-strong", "强主题", { origin: "auto", weight: 0.8 }),
        row("a-weak", "弱主题", { origin: "auto", weight: 0.3 }),
      ],
      { maxTotal: 3 },
    );
    const runner = makeRunner(JSON.stringify([{ label: "强候选主题", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now, config: { maxTotal: 3 } });
    expect(res).toMatchObject({ ran: true, adopted: 1, displaced: 1 });
    expect(store.retireValue).toHaveBeenCalledWith("a-weak", DEFAULT_TENANT);
    expect(store.upsertValue).toHaveBeenCalledWith(expect.any(String), "强候选主题", expect.any(Number), "auto-growth", DEFAULT_TENANT, undefined, "auto");
  });

  it("候选强度 ≤ 最弱 auto 锚 → 不挤出不采纳（宁缺毋滥）", async () => {
    // 候选 0.8×8=6.4；最弱锚 a2 0.3×0=0 < 6.4 会被挤出 —— 构造"不大于"场景：
    // a1/a2 label 整串出现在语料（各 8 命中）× weight 0.8 = 6.4；候选 6.4 > 6.4 为 false → 不换
    const store3 = fullStore(
      [
        row("a1", "关于强候选主题的记忆", { origin: "auto", weight: 0.8 }),
        row("a2", "关于强候选主题的记忆", { origin: "auto", weight: 0.8 }),
      ],
      { maxTotal: 3 },
    );
    const runner3 = makeRunner(JSON.stringify([{ label: "强候选主题", rationale: "r" }]));
    const res3 = await runAnchorGrowth({ store: store3 as never, llmRunner: runner3 as never, logger: LOG, now, config: { maxTotal: 3 } });
    expect(res3).toMatchObject({ ran: true, adopted: 0, displaced: 0 });
    expect(store3.retireValue).not.toHaveBeenCalled();
    expect(store3.upsertValue).not.toHaveBeenCalled();
  });

  it("全部 auto 锚被钉住 → pinned 豁免，无挤出目标 → 不采纳", async () => {
    const store = fullStore(
      [
        row("a1", "关于强候选主题的记忆", { origin: "auto", weight: 0.3, pinned: 1 }),
        row("a2", "甲乙丙", { origin: "auto", weight: 0.3, pinned: 1 }),
      ],
      { maxTotal: 3 },
    );
    const runner = makeRunner(JSON.stringify([{ label: "强候选主题", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now, config: { maxTotal: 3 } });
    expect(res).toMatchObject({ ran: true, adopted: 0, displaced: 0 });
    expect(store.retireValue).not.toHaveBeenCalled();
  });
});

describe("runAnchorGrowth 杂项裁定", () => {
  it("value_id：ASCII label → slug；纯 CJK label → auto-<sha256[:10]>（确定性 ASCII）", () => {
    expect(growthValueId("Code Review")).toBe("code-review");
    const cjk = growthValueId("增量对账");
    expect(cjk).toMatch(/^auto-[0-9a-f]{10}$/);
    expect(growthValueId("增量对账")).toBe(cjk);
    expect(growthValueId("  增量对账 ")).toBe(cjk); // 归一化后同 id
  });

  it("LLM 输出 garbage → 跑过（ran:true adopted:0），状态仍持久化（LLM 成功即消费轮次）", async () => {
    const store = makeStore({ rows: corpusFor("增量对账", 6), growthState: { lastDiscoveryAt: null, lastCorpusCount: null } });
    const runner = makeRunner("完全不是 JSON");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: true, adopted: 0 });
    expect(store.setAnchorGrowthState).toHaveBeenCalled();
  });

  it("LLM 抛错 → 不跑成、不消费轮次（状态不更新，下 tick 重试）", async () => {
    const store = makeStore({ rows: corpusFor("增量对账", 6), growthState: { lastDiscoveryAt: null, lastCorpusCount: null } });
    const runner = { run: async () => { throw new Error("llm down"); } };
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "error" });
    expect(store.setAnchorGrowthState).not.toHaveBeenCalled();
  });

  it("store 缺自生长能力（feature-detect）→ 不跑（tcvdb 旧实现等安全跳过）", async () => {
    const res = await runAnchorGrowth({ store: { queryL1Records: async () => [] } as never, llmRunner: makeRunner("[]") as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "store-unsupported" });
  });

  it("prompt 注入全态已有锚清单（veto 主题进 dedup 指令）+ maxTokens 不设限（GROW-EVO P2.1 裁定：0=不限制）", async () => {
    const store = makeStore({
      rows: corpusFor("增量对账", 6),
      anyState: [row("v1", "已否决主题", { state: "vetoed" })],
      growthState: { lastDiscoveryAt: null, lastCorpusCount: null },
    });
    const runner = makeRunner("[]");
    await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(runner.calls).toHaveLength(1);
    expect(String(runner.calls[0]!.maxTokens)).toBe(String(0));
    expect(String(runner.calls[0]!.prompt)).toContain("已否决主题");
    expect(String(runner.calls[0]!.taskId)).toBe("core-values-discover-growth");
  });
});


describe("runAnchorGrowth 自维护与冷却分级（GROW-MAINT）", () => {
  /** 可回写状态的 store：setAnchorGrowthState 合并进 fixture（跨轮冷却测试需要）。 */
  function persistentStore(rows: unknown[], anyState: AnyRow[] = []) {
    const state = { lastDiscoveryAt: null as string | null, lastCorpusCount: null as number | null, lastAttemptAt: null as string | null, lastAdoptedAt: null as string | null };
    const store = makeStore({ rows, anyState, growthState: state });
    (store.setAnchorGrowthState as unknown as { mockImplementation: (f: (s: Record<string, unknown>) => Promise<void>) => void })
      .mockImplementation(async (s: Record<string, unknown>) => { Object.assign(state, s); });
    return { store, state };
  }

  it("0 采纳轮：写 lastAttemptAt、不写 lastAdoptedAt；1h 内重跑被 attempt-cooldown 挡", async () => {
    const { store } = persistentStore(corpusFor("增量对账", 6));
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(res.adopted).toBe(0);
    expect(store.setAnchorGrowthState).toHaveBeenCalledWith({ lastDiscoveryAt: NOW.toISOString(), lastCorpusCount: 6, lastAttemptAt: NOW.toISOString() });
    const now2 = () => new Date(NOW.getTime() + 30 * 60_000);
    const res2 = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: now2 });
    expect(res2).toMatchObject({ ran: false, reason: "attempt-cooldown" });
    expect(runner.calls).toHaveLength(1); // 冷却期内零 LLM
  });

  it("有采纳轮：写 lastAdoptedAt；1h 后 <24h 重跑被 interval 挡（尝试冷却先放行）", async () => {
    const { store } = persistentStore(corpusFor("增量对账", 6));
    const runner = makeRunner(JSON.stringify([{ label: "增量对账", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.adopted).toBe(1);
    expect(store.setAnchorGrowthState).toHaveBeenCalledWith({ lastDiscoveryAt: NOW.toISOString(), lastCorpusCount: 6, lastAttemptAt: NOW.toISOString(), lastAdoptedAt: NOW.toISOString() });
    const now2 = () => new Date(NOW.getTime() + 2 * 3600_000);
    const res2 = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: now2 });
    expect(res2).toMatchObject({ ran: false, reason: "interval" });
  });

  it("自维护退场：低证据 auto-growth 锚 retire；manual 锚与 pinned auto 锚豁免", async () => {
    const store = makeStore({
      rows: corpusFor("别的主题", 6),
      growthState: { lastDiscoveryAt: null, lastCorpusCount: null },
      anyState: [
        row("a-auto", "失效主题", { origin: "auto", created_by: "auto-growth" }),
        row("a-manual", "失效主题", { origin: "manual" }),
        row("a-pin", "失效主题", { origin: "auto", created_by: "auto-growth", pinned: 1 }),
      ],
    });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.retired).toBe(1);
    expect(store.retireValue).toHaveBeenCalledTimes(1);
    expect(store.retireValue).toHaveBeenCalledWith("a-auto", DEFAULT_TENANT);
  });

  it("自维护权重：auto-growth 锚按全量语料证据密度重算（Δ≥0.05 才写；同 id 同标签 origin='auto'）", async () => {
    const store = makeStore({
      rows: corpusFor("增长主题", 6),
      growthState: { lastDiscoveryAt: null, lastCorpusCount: null },
      anyState: [row("a-grow", "增长主题", { origin: "auto", created_by: "auto-growth", weight: 0.5 })],
    });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.reweighted).toBe(1);
    expect(res.retired).toBe(0);
    expect(store.upsertValue).toHaveBeenCalledWith("a-grow", "增长主题", suggestAnchorWeight(6, 6), "auto-growth", DEFAULT_TENANT, undefined, "auto");
  });
});

// ═════════════ GROW-QUOTA 名额回归守卫（REG-REMAINING-004 #9）═════════════
// 第一性原理：maxTotal = soul-feeling 注入预算保护；存量超限（竞态超采/名额下调遗留）
// 必须回归名额——GROW-MAINT 只有证据退场，超限无自愈路径。超出部分按强度升序 retire
//（可恢复）；manual/钉住豁免（信任边界）。名额口径与 free 计算一致：auto 活跃 + 钉住。
describe('runAnchorGrowth GROW-QUOTA 名额回归守卫', () => {
  it('存量超限 → 强度升序 retire 超出部分（manual/钉住豁免）', async () => {
    const anyState = [
      row('v1', '弱主题甲', { origin: 'auto', created_by: 'auto-growth', weight: 0.3 }),
      row('v2', '弱主题乙', { origin: 'auto', created_by: 'auto-growth', weight: 0.35 }),
      row('v3', '弱主题丙', { origin: 'auto', created_by: 'auto-growth', weight: 0.4 }),
      row('v4', '强主题甲', { origin: 'auto', created_by: 'auto-growth', weight: 0.5 }),
      row('v5', '强主题乙', { origin: 'auto', created_by: 'auto-growth', weight: 0.55 }),
      row('vp', '钉住锚', { origin: 'auto', created_by: 'auto-growth', weight: 0.6, pinned: 1 }),
      row('vm', '手工锚', { origin: 'manual', created_by: 'verify', weight: 0.7 }),
    ];
    // 语料：每个 label 恰 1 条命中（ev=1 ≥ minEvidence 1 → 证据退场不触发，隔离名额守卫）
    const rows = ['弱主题甲', '弱主题乙', '弱主题丙', '强主题甲', '强主题乙', '钉住锚', '手工锚']
      .map((label, i) => corpusRow('r' + i, '第' + i + '条 关于' + label + '的记忆'));
    const store = makeStore({ rows, anyState, growthState: { lastDiscoveryAt: '2026-09-01T00:00:00.000Z', lastCorpusCount: 0 } });
    const runner = makeRunner('[]');
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: { minEvidence: 1, maxPerPass: 2, maxTotal: 3, intervalHours: 24 }, logger: LOG, now });
    expect(res.retired).toBe(3);
    const retiredIds = (store.retireValue as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(retiredIds).toEqual(['v1', 'v2', 'v3']); // 强度升序 = weight 升序（同证据）
    expect(retiredIds).not.toContain('vp'); // 钉住豁免
    expect(retiredIds).not.toContain('vm'); // manual 豁免
  });

  it('名额内不触发守卫（retireValue 零调用）', async () => {
    const anyState = [
      row('v1', '主题甲', { origin: 'auto', created_by: 'auto-growth', weight: 0.4 }),
      row('v2', '主题乙', { origin: 'auto', created_by: 'auto-growth', weight: 0.5 }),
    ];
    const rows = ['主题甲', '主题乙'].map((label, i) => corpusRow('r' + i, '第' + i + '条 关于' + label + '的记忆'));
    const store = makeStore({ rows, anyState, growthState: { lastDiscoveryAt: '2026-09-01T00:00:00.000Z', lastCorpusCount: 0 } });
    const runner = makeRunner('[]');
    await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: { minEvidence: 1, maxTotal: 3, intervalHours: 24 }, logger: LOG, now });
    expect(store.retireValue).not.toHaveBeenCalled();
  });
});
