import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth } from "./anchor-growth.js";

const TENANT = { teamId: "t-decouple", userId: "u-decouple", agentId: "a-decouple" };

function hoursAgoISO(h: number, nowMs: number): string {
  return new Date(nowMs - h * 3600_000).toISOString();
}

/** 17 auto theme 锚（2 弱 ev=5 / 15 强 ev=10），maxTotal=15 → 超限 2；证据行权重与 F5 曲线一致（零 reweight 噪声）。 */
function buildStore(opts: { nowMs: number; lastAdoptedH?: number; lastAttemptH?: number; lastMaintH?: number | null; corpusGrew?: boolean }) {
  const anchors: Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: string; pinned: 0 | 1; state: string; node_type?: string; attrs_json?: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 17; i++) {
    const label = `锚D${String(i).padStart(2, "0")}`;
    const ev = i <= 2 ? 5 : 10;
    const weight = Math.min(0.8, Math.max(0.3, (3 + (5 * Math.min(ev, 50)) / 50) / 10));
    anchors.push({ value_id: `vid-${i}`, label, weight, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "active", node_type: "theme", attrs_json: "{}" });
    for (let j = 0; j < ev; j++) rows.push({ record_id: `r-${i}-${j}`, content: `内容包含 ${label} 的证据记录 ${i}-${j}`, team_id: TENANT.teamId, user_id: TENANT.userId, agent_id: TENANT.agentId });
  }
  if (opts.corpusGrew) rows.push({ record_id: "r-new", content: "新增语料行", team_id: TENANT.teamId, user_id: TENANT.userId, agent_id: TENANT.agentId });
  const lastCorpusCount = opts.corpusGrew ? rows.length - 1 : rows.length;
  // lastAttemptH 缺省 2h：显式在场（避免 D-R5-5 legacy 兜底把 lastDiscoveryAt 视作 lastAdopted——
  // 该兜底对「存量行」是设计内保守行为，测试需显式区分「新语义行」与「存量行」）。
  const lastAttemptH = opts.lastAttemptH === undefined ? 2 : opts.lastAttemptH;
  const state: Record<string, unknown> = {
    lastDiscoveryAt: hoursAgoISO(2, opts.nowMs),
    lastCorpusCount,
    lastAttemptAt: hoursAgoISO(lastAttemptH, opts.nowMs),
    lastAdoptedAt: opts.lastAdoptedH === undefined ? undefined : hoursAgoISO(opts.lastAdoptedH, opts.nowMs),
    lastMaintAt: opts.lastMaintH === undefined ? undefined : opts.lastMaintH === null ? null : hoursAgoISO(opts.lastMaintH, opts.nowMs),
  };
  const written: Array<Record<string, unknown>> = [];
  const store: Record<string, unknown> = {
    listL1TenantTriplets: () => [TENANT],
    countL1: () => rows.length,
    queryL1Records: () => rows,
    listValuesAnyState: () => anchors.map((a) => ({ ...a })),
    upsertValue: (valueId: string, label: string, weight: number, createdBy?: string, _t?: unknown, valence?: number | null, origin?: string, nodeType?: string) => {
      const a = anchors.find((x) => x.value_id === valueId);
      if (a) { a.weight = weight; a.state = "active"; }
      else anchors.push({ value_id: valueId, label, weight, created_by: createdBy ?? "auto-growth", valence: valence ?? null, origin: origin ?? "auto", pinned: 0, state: "active", node_type: nodeType ?? "theme", attrs_json: "{}" });
      return true;
    },
    retireValue: (valueId: string) => {
      const a = anchors.find((x) => x.value_id === valueId);
      if (!a) return false;
      a.state = "retired";
      return true;
    },
    getAnchorGrowthState: () => ({ ...state }),
    setAnchorGrowthState: (s: Record<string, unknown>) => { written.push({ ...s }); Object.assign(state, s); },
    readCore: () => [],
  };
  return { store, anchors, rows, written, state };
}

const BASE_CFG = { enabled: true, maxTotal: 15, maintainIntervalHours: 6, identityMaintain: { enabled: false } };

function run(env: { store: unknown }, nowMs: number, llm: { run: (p: unknown) => Promise<string> }, cfg: Record<string, unknown> = BASE_CFG) {
  return runAnchorGrowth({ store: env.store as never, llmRunner: llm as never, config: cfg as never, now: () => new Date(nowMs) });
}

describe("V10-MAINT-DECOUPLE：GROW-MAINT/QUOTA 与采纳门解耦（2026-09-25 何晨拍板）", () => {
  it("采纳门拦截（interval）但维护到期 → 维护面独立运行：quotaEvict 回归名额 17→15，零 LLM 调用，写 lastMaintAt 不写 lastAdoptedAt", async () => {
    const nowMs = 1_800_000_000_000;
    const env = buildStore({ nowMs, lastAdoptedH: 1 });
    const llm = { run: vi.fn(async () => "[]") };
    const res = await run(env, nowMs, llm);
    expect(res.ran).toBe(true);
    expect(res.retired).toBe(2);
    expect(env.anchors.filter((a) => a.state === "active").length).toBe(15);
    expect(env.anchors.find((a) => a.value_id === "vid-1")?.state).toBe("retired");
    expect(env.anchors.find((a) => a.value_id === "vid-2")?.state).toBe("retired");
    expect(env.anchors.find((a) => a.value_id === "vid-3")?.state).toBe("active");
    expect(llm.run).not.toHaveBeenCalled();
    expect(env.written.some((w) => typeof w.lastMaintAt === "string")).toBe(true);
    expect(env.written.some((w) => "lastAdoptedAt" in w)).toBe(false);
  });

  it("维护未到期（lastMaintAt 1h ago < 6h）且采纳门拦截 → 双跳过：ran=false reason=interval，逐位现状", async () => {
    const nowMs = 1_800_000_000_000;
    const env = buildStore({ nowMs, lastAdoptedH: 1, lastMaintH: 1 });
    const llm = { run: vi.fn(async () => "[]") };
    const res = await run(env, nowMs, llm);
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("interval");
    expect(res.retired).toBe(0);
    expect(env.anchors.filter((a) => a.state === "active").length).toBe(17);
    expect(llm.run).not.toHaveBeenCalled();
  });

  it("维护+采纳双到期 → 两面都跑：维护裁超额 + LLM 发现被调用", async () => {
    const nowMs = 1_800_000_000_000;
    const env = buildStore({ nowMs, corpusGrew: true });
    const llm = { run: vi.fn(async () => "[]") };
    const res = await run(env, nowMs, llm);
    expect(res.ran).toBe(true);
    expect(res.retired).toBe(2);
    expect(llm.run).toHaveBeenCalled();
    expect(env.anchors.filter((a) => a.state === "active").length).toBe(15);
    expect(env.written.some((w) => "lastAdoptedAt" in w)).toBe(false);
  });

  it("A/B 同种子 ×10：旧语义等价（lastMaintAt 新鲜=维护被门饿死）retired=0/17 active vs 解耦 retired=2/15 active", async () => {
    for (let s = 1; s <= 10; s++) {
      const nowMs = 1_800_000_000_000 + s * 7;
      const oldEnv = buildStore({ nowMs, lastAdoptedH: 1, lastMaintH: 0 });
      const oldLlm = { run: vi.fn(async () => "[]") };
      const oldRes = await run(oldEnv, nowMs, oldLlm, { ...BASE_CFG, maintainIntervalHours: 168 });
      expect(oldRes.retired).toBe(0);
      expect(oldEnv.anchors.filter((a) => a.state === "active").length).toBe(17);
      expect(oldLlm.run).not.toHaveBeenCalled();
      const newEnv = buildStore({ nowMs, lastAdoptedH: 1 });
      const newLlm = { run: vi.fn(async () => "[]") };
      const newRes = await run(newEnv, nowMs, newLlm);
      expect(newRes.retired).toBe(2);
      expect(newEnv.anchors.filter((a) => a.state === "active").length).toBe(15);
      expect(newLlm.run).not.toHaveBeenCalled();
    }
  });
});
