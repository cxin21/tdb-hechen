/**
 * Task PA RED 套件：自生长 per-agent 化（runAnchorGrowth 遍历 distinct agent 三元组）。
 *
 * 契约（task-pa-brief 第 3 步）：
 *   - 发现循环从"default 单桶"改为遍历有记忆的 distinct agent 三元组（listL1TenantTriplets），
 *     逐 agent：采样 = 该 agent 自己的记忆；候选去重对照 = 该 agent 自己的全态锚；
 *     护栏独立计数（证据 ≥5 agent 语料内 / 每轮 +2 / 总量 15 agent 桶内 / 挤出该 agent 的自生长锚）。
 *   - 双门 per-agent：interval / 语料基线按 agent 独立（per-tenant growth state）。
 *   - listL1TenantTriplets 缺失的旧 store → 回退 default 单桶（旧行为，feature-detect 家族先例）。
 *   - LLM 成本 = agent 数 × 发现循环（每 agent 至多一次）。
 */
import { describe, expect, it, vi } from "vitest";
import { runAnchorGrowth } from "./anchor-growth.js";
import type { CoreTenant } from "../store/types.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const now = () => NOW;
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const T_A: CoreTenant = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const T_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };

type AnyRow = { value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" };

function row(value_id: string, label: string, opts: Partial<AnyRow> = {}): AnyRow {
  return { value_id, label, weight: 0.5, created_by: "verify", valence: null, origin: "manual", pinned: 0, state: "active", ...opts };
}

function corpusRow(id: string, content: string, agent: string, updated = "2026-09-09T00:00:00Z") {
  return {
    record_id: id, content, type: "episodic", priority: 0.5, scene_name: "", session_key: "",
    session_id: "s1", team_id: `team${agent}`, task_id: "", user_id: `user${agent}`, agent_id: agent,
    version: 1, timestamp_str: updated, timestamp_start: updated, timestamp_end: updated,
    created_time: updated, updated_time: updated, metadata_json: "{}",
  };
}

/** per-agent mock store：语料/锚/状态全部按 tenant 分桶。 */
function makePerAgentStore(opts: {
  triplets?: CoreTenant[];
  corpus?: Partial<Record<"A" | "B", string[]>>; // agentId → 语料 label 列表（每 label 一条）
  anchors?: Partial<Record<"A" | "B", AnyRow[]>>;
  states?: Partial<Record<"A" | "B", { lastDiscoveryAt: string | null; lastCorpusCount: number | null }>>;
} = {}) {
  const tenants = opts.triplets ?? [T_A, T_B];
  const setGrowth = vi.fn();
  const store = {
    listL1TenantTriplets: vi.fn(async () => tenants),
    queryL1Records: vi.fn(async (filter?: { agentId?: string }) => {
      const agent = filter?.agentId === "agentA" ? "A" : filter?.agentId === "agentB" ? "B" : "";
      const labels = opts.corpus?.[agent as "A" | "B"] ?? [];
      return labels.map((label, i) => corpusRow(`${agent}${i}`, `第${i}条 关于${label}的记忆`, agent));
    }),
    countL1: vi.fn(async (filter?: { agentId?: string }) => {
      const agent = filter?.agentId === "agentA" ? "A" : filter?.agentId === "agentB" ? "B" : "";
      return (opts.corpus?.[agent as "A" | "B"] ?? []).length;
    }),
    listValuesAnyState: vi.fn(async (tenant?: CoreTenant) => opts.anchors?.[tenant?.agentId === "agentA" ? "A" : "B"] ?? []),
    upsertValue: vi.fn(async () => true),
    retireValue: vi.fn(async () => true),
    getAnchorGrowthState: vi.fn(async (tenant?: CoreTenant) =>
      opts.states?.[tenant?.agentId === "agentA" ? "A" : "B"] ?? { lastDiscoveryAt: null, lastCorpusCount: null }),
    setAnchorGrowthState: setGrowth,
  };
  return store;
}

function makeRunner(reply: string | ((prompt: string) => string)) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    run: async (params: Record<string, unknown>) => {
      calls.push(params);
      return typeof reply === "function" ? reply(String(params.prompt)) : reply;
    },
    calls,
  };
}

const HOURS48 = new Date(NOW.getTime() - 48 * 3600_000).toISOString();

describe("runAnchorGrowth per-agent 化（PA）", () => {
  it("遍历 distinct 三元组：A/B 各跑一轮发现（LLM 每 agent 一次），状态按 agent 持久化", async () => {
    const store = makePerAgentStore({
      corpus: { A: ["A主题"], B: ["B主题"] },
    });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(runner.calls).toHaveLength(2); // agent 数 × 发现循环
    // 状态 per-agent 写入：A、B 各一次，且带各自 tenant
    expect(store.setAnchorGrowthState).toHaveBeenCalledTimes(2);
    const calls = store.setAnchorGrowthState.mock.calls as unknown as Array<Array<unknown>>;
    const tenantsCalled = calls.map((c) => c[1]);
    expect(tenantsCalled).toEqual([T_A, T_B]);
    // 语料基线 per-agent：A=1、B=1
    expect(calls.map((c) => (c[0] as { lastCorpusCount: number }).lastCorpusCount)).toEqual([1, 1]);
  });

  it("发现采样隔离：A 的 prompt 只含 A 的语料，不含 B 的记忆（防跨 agent 蒸馏）", async () => {
    const store = makePerAgentStore({
      corpus: { A: ["A专属主题"], B: ["B专属主题"] },
    });
    const runner = makeRunner((prompt) => (prompt.includes("B专属主题") ? "BAD" : "[]"));
    await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(runner.calls).toHaveLength(2);
    expect(String(runner.calls[0]!.prompt)).toContain("A专属主题");
    expect(String(runner.calls[0]!.prompt)).not.toContain("B专属主题");
    expect(String(runner.calls[1]!.prompt)).toContain("B专属主题");
    expect(String(runner.calls[1]!.prompt)).not.toContain("A专属主题");
  });

  it("A 长锚不影响 B 的桶：提案只在有证据的 agent 桶采纳", async () => {
    const store = makePerAgentStore({
      corpus: { A: ["共享风格", "共享风格", "共享风格", "共享风格", "共享风格"], B: ["别的主题"] },
    });
    const runner = makeRunner(JSON.stringify([{ label: "共享风格", rationale: "r" }]));
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(res.adopted).toBe(1); // 只有 A 有 5 条证据
    const upsertCalls = store.upsertValue.mock.calls as unknown as Array<Array<unknown>>;
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]![4]).toEqual(T_A); // 落 A 桶；B 桶零写入
  });

  it("per-agent interval 门：A 到点、B 未到点 → 只跑 A（LLM 1 次）", async () => {
    const store = makePerAgentStore({
      corpus: { A: ["A主题"], B: ["B主题"] },
      states: { B: { lastDiscoveryAt: new Date(NOW.getTime() - 1 * 3600_000).toISOString(), lastCorpusCount: 1 } },
    });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(String(runner.calls[0]!.prompt)).toContain("A主题");
  });

  it("per-agent 语料基线门：A 无新增、B 有新增 → 只跑 B", async () => {
    const store = makePerAgentStore({
      corpus: { A: ["A主题"], B: ["B主题"] },
      states: { A: { lastDiscoveryAt: HOURS48, lastCorpusCount: 1 } },
    });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(String(runner.calls[0]!.prompt)).toContain("B主题");
  });

  it("去重对照 = 该 agent 自己的全态锚：vetoed label 在 A 桶拦下、B 桶照常采纳", async () => {
    const reply = JSON.stringify([{ label: "同款主题", rationale: "r" }]);
    const store = makePerAgentStore({
      corpus: { A: ["同款主题", "同款主题", "同款主题", "同款主题", "同款主题"], B: ["同款主题", "同款主题", "同款主题", "同款主题", "同款主题"] },
      anchors: { A: [row("v1", "同款主题", { state: "vetoed" })] },
    });
    const runner = makeRunner(reply);
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(res.adopted).toBe(1); // A 被 veto 拦下；B 照常采纳
    const upsertCalls = store.upsertValue.mock.calls as unknown as Array<Array<unknown>>;
    expect(upsertCalls[0]![4]).toEqual(T_B);
  });

  it("listL1TenantTriplets 缺失的旧 store → 回退 default 单桶（旧行为，不炸）", async () => {
    const store = {
      queryL1Records: vi.fn(async () => [corpusRow("d0", "第0条 关于旧主题的记忆", "default")]),
      listValuesAnyState: vi.fn(async () => []),
      upsertValue: vi.fn(async () => true),
      retireValue: vi.fn(async () => true),
      getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null, lastMaintAt: NOW.toISOString() })),
      setAnchorGrowthState: vi.fn(),
    };
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(store.setAnchorGrowthState).toHaveBeenCalledWith({ lastDiscoveryAt: NOW.toISOString(), lastCorpusCount: 1, lastAttemptAt: NOW.toISOString() }); // 旧调用形状（无 tenant）
  });

  it("无任何有记忆的 agent（三元组空）→ 不跑（no-corpus），零 LLM", async () => {
    const store = makePerAgentStore({ triplets: [] });
    const runner = makeRunner("[]");
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
    expect(res).toMatchObject({ ran: false, reason: "no-corpus" });
    expect(runner.calls).toHaveLength(0);
  });
});
