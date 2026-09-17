/**
 * P4b 受控正文演化 golden 套件（GROW-EVO §4，REG-REMAINING-005 #1）。
 *
 * 合并/失效边界 golden（v5 硬要求，session-h 真实叙事模式 fixture）：
 *  - "CMAS→PADI 改意"（归纳合并叙事，新记忆已同条呈现新旧值）→ LLM 判 skip → 零写路径，
 *    且 prompt 必须内置反例指令（防 LLM 系统性推翻 extractor 的合并决定）；
 *  - "新旧值同字段真矛盾"（如计划时间变更）→ rewrite → evolved_from×2 审计边 + 双旧失效。
 * 另覆盖五条件门逐项拦截（含 vectors.db 实测的悬挂边容错）与幂等/护栏。
 */
import { describe, it, expect, vi } from "vitest";
import { runEvolution, DEFAULT_EVOLUTION_CONFIG } from "./evolution-worker.js";

type Edge = { sourceId: string; targetId: string; type: string; strength: number; createdAt: string };

function row(id: string, opts: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    record_id: id,
    content: `content-of-${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "",
    certainty: "observed",
    occurred_at: "2026-09-16T08:00:00.000Z",
    valid_start: "",
    valid_end: "",
    valence: null,
    arousal: null,
    significance: 0.6,
    teamId: "default",
    userId: "default",
    agentId: "agt-flowtest",
    taskId: "",
    metadata: { subject: "默认主题" },
    ...opts,
  };
}

function makeStore(opts: { edges?: Edge[]; evolved?: Edge[] } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const links: Array<{ s: string; t: string; type: string }> = [];
  const invalidated: Array<{ id: string; ve: string }> = [];
  const store = {
    getLinksByType: vi.fn(async (type: string) =>
      type === "conflict" ? (opts.edges ?? []) : type === "evolved_from" ? (opts.evolved ?? []) : []),
    upsertL1: vi.fn((rec: unknown) => { upserts.push(rec as Record<string, unknown>); return true; }),
    addLink: vi.fn((s: string, t: string, type: string) => { links.push({ s, t, type }); return true; }),
    invalidateL1: vi.fn((id: string, ve: string) => { invalidated.push({ id, ve }); return true; }),
  };
  return { store, upserts, links, invalidated };
}

function makeRunner(reply: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    runner: { run: vi.fn(async (params: Record<string, unknown>) => { calls.push(params); return reply; }) },
    calls,
  };
}

const edge = (a: string, b: string): Edge => ({ sourceId: a, targetId: b, type: "conflict", strength: 1, createdAt: "2026-09-16T12:00:00.000Z" });

// ── session-h 真实叙事模式 fixture ──
const CMAS_OLD = row("m_cmas_old", {
  content: "用户正在学 CMAS 潜水证，已完成理论课与泳池训练。",
  occurred_at: "2026-09-16T08:00:00.000Z",
  metadata: { subject: "潜水考证" },
});
const PADI_NEW = row("m_padi_new", {
  content: "用户已从 CMAS 转学 PADI 潜水证，直接考 OW，进度更快。",
  occurred_at: "2026-09-16T12:00:00.000Z",
  metadata: { subject: "潜水考证" },
});

describe("P4b evolution-worker：合并/失效边界 golden（v5 硬要求）", () => {
  it("归纳合并叙事（CMAS→PADI 改意）：LLM 判 skip → 零写路径，且 prompt 内置反例指令", async () => {
    const { store, upserts, links, invalidated } = makeStore({ edges: [edge("m_padi_new", "m_cmas_old")] });
    const { runner, calls } = makeRunner(JSON.stringify({ action: "skip", reason: "新记忆已叙事化包含旧值，属归纳合并" }));
    const res = await runEvolution({
      queryL1: async () => [CMAS_OLD, PADI_NEW],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.ran).toBe(true);
    expect(res.candidates).toBe(1);
    expect(res.rewrites).toBe(0);
    expect(res.gate?.llmSkip).toBe(1);
    // 零写路径：不改写正文、不建审计边、不动 valid_end（extractor 的合并决定不被推翻）
    expect(upserts).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
    // 反例指令必须进 prompt（防 LLM 把归纳合并误判为待消解矛盾）
    const prompt = String(calls[0]?.prompt ?? "");
    const system = String(calls[0]?.systemPrompt ?? "");
    expect(system).toContain("归纳合并");
    expect(system).toContain("skip");
    expect(prompt).toContain("CMAS");
    // GROW-EVO P2.1 裁定：maxTokens/timeoutMs 显式 0（Ark 推理模型 thinking 吃满缺省 4096 返回空文本）
    expect(calls[0]?.maxTokens).toBe(0);
    expect(calls[0]?.timeoutMs).toBe(0);
  });

  it("LLM 若误判 rewrite（对抗：假想模型无视反例指令），golden 只验证零写路径由 skip 决定——此用例验证 rewrite 路径属于真矛盾对", async () => {
    // 真矛盾 fixture：同字段计划时间变更（v5 举例）
    const oldPlan = row("m_plan_old", {
      content: "用户计划 2026-09-19（周六）去千岛湖潜水。",
      occurred_at: "2026-09-16T09:00:00.000Z",
      metadata: { subject: "周末计划" },
    });
    const newPlan = row("m_plan_new", {
      content: "用户计划改为 2026-09-20（周日）去千岛湖潜水，周六有事。",
      occurred_at: "2026-09-19T01:00:00.000Z",
      valid_start: "",
      metadata: { subject: "周末计划" },
    });
    const { store, upserts, links, invalidated } = makeStore({ edges: [edge("m_plan_new", "m_plan_old")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "用户计划 2026-09-20（周日）去千岛湖潜水（原定 09-19，因周六有事改为周日）。", reason: "同字段计划时间真矛盾" }));
    const res = await runEvolution({
      queryL1: async () => [oldPlan, newPlan],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.rewrites).toBe(1);
    // 合并单条：created_by='evolution' + metadata.evolution={from,reason} + source='evolution'
    expect(upserts).toHaveLength(1);
    const rec = upserts[0];
    expect(rec.source).toBe("evolution");
    expect((rec.metadata as Record<string, unknown>).created_by).toBe("evolution");
    expect((rec.metadata as Record<string, unknown>).evolution).toEqual({ from: ["m_plan_old", "m_plan_new"], reason: "同字段计划时间真矛盾" });
    expect(rec.certainty).toBe("observed");
    // bi-temporal：occurred_at 取新值，valid_start 沿用旧值起点
    expect(rec.occurred_at).toBe("2026-09-19T01:00:00.000Z");
    expect(rec.valid_start).toBe("2026-09-16T09:00:00.000Z");
    expect(rec.valid_end).toBe("");
    // 审计边 evolved_from×2（幂等标记的第二用途）
    expect(links.filter((l) => l.type === "evolved_from")).toHaveLength(2);
    // 双旧失效：旧值失效时点=新观察发生时（与 P2 内联一致），新值失效时点=演化发生时
    expect(invalidated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "m_plan_old", ve: "2026-09-19T01:00:00.000Z" }),
        expect.objectContaining({ id: "m_plan_new", ve: expect.any(String) }),
      ]),
    );
  });

  it("similar/merge 边（extractor 归纳合并现场）不进入扫描——只扫 type='conflict'", async () => {
    const { store, upserts } = makeStore({ edges: [] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [CMAS_OLD, PADI_NEW],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.ran).toBe(true);
    expect(res.scanned).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(store.getLinksByType).toHaveBeenCalledWith("conflict");
  });
});

describe("P4b evolution-worker：五条件门逐项拦截 + 护栏", () => {
  const pair = (a: Partial<Record<string, unknown>>, b: Partial<Record<string, unknown>>) => [row("ra", a), row("rb", b)];

  it("config-first：enabled 缺省 false → ran=false skipped=disabled（逐位现状）", async () => {
    const { store } = makeStore({ edges: [edge("a", "b")] });
    const res = await runEvolution({ queryL1: async () => [], llmRunner: makeRunner("{}").runner as never, store: store as never });
    expect(res).toMatchObject({ ran: false, skipped: "disabled" });
  });

  it("LLM runner 缺失 → skipped=no-llm（consolidation 同款门）", async () => {
    const { store } = makeStore({ edges: [edge("a", "b")] });
    const res = await runEvolution({
      queryL1: async () => pair({}, {}),
      llmRunner: null,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res).toMatchObject({ ran: false, skipped: "no-llm" });
  });

  it("悬挂边容错（vectors.db 实测 7 条边 3 条悬挂）：端点缺失 → gate.dangling", async () => {
    const { store, upserts } = makeStore({ edges: [edge("m_gone", "m_here")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [row("m_here")],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.dangling).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it("门② inferred 不演化（推断不许冒充事实，红线对称应用）", async () => {
    const { store, upserts } = makeStore({ edges: [edge("rb", "ra")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => pair({ id: "ra", certainty: "observed" }, { id: "rb", certainty: "inferred" }),
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.certainty).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it("门③ subject 不一致/单侧缺失不放行（danbooru 假阳性边同型；null≠null）", async () => {
    const { store, upserts } = makeStore({ edges: [edge("rb", "ra"), edge("rc", "rd")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [
        row("ra", { metadata: { subject: "网络环境与代理" } }),
        row("rb", { metadata: { subject: "tag向量语义检索" } }),
        row("rc", { metadata: { subject: "同主题" } }),
        row("rd", { metadata: {} }),
      ],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.subject).toBe(2);
    expect(upserts).toHaveLength(0);
  });

  it("门④ occurred_at 缺失或相等 → timeOrder；方向不信任边方向（source=old 也正确判新旧）", async () => {
    const { store } = makeStore({ edges: [edge("ra", "rb"), edge("rc", "rd")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [
        row("ra", { occurred_at: "" }), row("rb", {}),
        row("rc", { occurred_at: "2026-09-16T08:00:00.000Z" }), row("rd", { occurred_at: "2026-09-16T08:00:00.000Z" }),
      ],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.timeOrder).toBe(2);
  });

  it("方向反转：conflict 边 source=old（异常方向）仍按 occurred_at 正确判新旧并重写", async () => {
    const oldR = row("m_old2", { occurred_at: "2026-09-16T08:00:00.000Z", metadata: { subject: "周末计划" } });
    const newR = row("m_new2", { occurred_at: "2026-09-19T01:00:00.000Z", metadata: { subject: "周末计划" } });
    const { store, upserts, invalidated } = makeStore({ edges: [edge("m_old2", "m_new2")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "合并正文", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [oldR, newR],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.rewrites).toBe(1);
    expect(invalidated).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "m_old2", ve: "2026-09-19T01:00:00.000Z" })]),
    );
    expect(upserts[0]?.valid_start).toBe("2026-09-16T08:00:00.000Z");
  });

  it("新值已失效（valid_end 非空）→ newerInvalid：不复活过期叙事", async () => {
    const { store, upserts } = makeStore({ edges: [edge("rb", "ra")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => pair({ id: "ra", occurred_at: "2026-09-16T08:00:00.000Z" }, { id: "rb", occurred_at: "2026-09-19T01:00:00.000Z", valid_end: "2026-09-17T00:00:00.000Z" }),
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.newerInvalid).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it("门⑤ pin/veto 协议位 + evolved_from 幂等（重写过的对不二次演化）", async () => {
    const { store, upserts } = makeStore({
      edges: [edge("rb", "ra"), edge("rd", "rc")],
      evolved: [{ sourceId: "m_evo_x", targetId: "rc", type: "evolved_from", strength: 1, createdAt: "2026-09-16T13:00:00.000Z" }],
    });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => [
        row("ra", { occurred_at: "2026-09-16T08:00:00.000Z", metadata: { subject: "s", pinned: true } }),
        row("rb", { occurred_at: "2026-09-19T01:00:00.000Z", metadata: { subject: "s" } }),
        row("rc", { occurred_at: "2026-09-16T08:00:00.000Z", metadata: { subject: "s2" } }),
        row("rd", { occurred_at: "2026-09-19T01:00:00.000Z", metadata: { subject: "s2" } }),
      ],
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.pin).toBe(1);
    expect(res.gate?.idempotent).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it("maxRewrites 护栏：单轮调用与重写总量上限（LLM 成本护栏）", async () => {
    const rows = ["p1o", "p1n", "p2o", "p2n", "p3o", "p3n", "p4o", "p4n"].map((id, i) =>
      row(id, { occurred_at: i % 2 === 0 ? "2026-09-16T08:00:00.000Z" : "2026-09-19T01:00:00.000Z", metadata: { subject: `主题${Math.floor(i / 2)}` } }));
    const edges = [edge("p1n", "p1o"), edge("p2n", "p2o"), edge("p3n", "p3o"), edge("p4n", "p4o")];
    const { store, upserts } = makeStore({ edges });
    const { runner, calls } = makeRunner(JSON.stringify({ action: "rewrite", content: "合并正文", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => rows,
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, maxRewrites: 3, intervalMs: 0 },
      store: store as never,
    });
    expect(calls).toHaveLength(3);
    expect(upserts).toHaveLength(3);
    expect(res.rewrites).toBe(3);
    expect(res.gate?.maxRewrites).toBe(1);
  });

  it("LLM 回复不可解析/缺 content → llmSkip，零写路径（宁缺毋滥）", async () => {
    const { store, upserts, links, invalidated } = makeStore({ edges: [edge("rb", "ra")] });
    const { runner } = makeRunner("我说不好，这不是 JSON");
    const res = await runEvolution({
      queryL1: async () => pair({ id: "ra", occurred_at: "2026-09-16T08:00:00.000Z" }, { id: "rb", occurred_at: "2026-09-19T01:00:00.000Z" }),
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.llmSkip).toBe(1);
    expect(upserts).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });

  it("跨租户矛盾对不演化（租户隔离纪律）", async () => {
    const { store, upserts } = makeStore({ edges: [edge("rb", "ra")] });
    const { runner } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const res = await runEvolution({
      queryL1: async () => pair({ id: "ra", agentId: "agt-a" }, { id: "rb", agentId: "agt-b" }),
      llmRunner: runner as never,
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 0 },
      store: store as never,
    });
    expect(res.gate?.crossTenant).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it("进程内节流：intervalMs 未到 → skipped=interval（第二轮零 LLM 调用；resetModules 取干净模块实例隔离跨测试状态）", async () => {
    vi.resetModules();
    const { runEvolution: freshRun } = await import("./evolution-worker.js");
    const { store } = makeStore({ edges: [edge("rb", "ra")] });
    const { runner, calls } = makeRunner(JSON.stringify({ action: "rewrite", content: "x", reason: "r" }));
    const rows = [row("ra", { occurred_at: "2026-09-16T08:00:00.000Z" }), row("rb", { occurred_at: "2026-09-19T01:00:00.000Z" })];
    const cfg = { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, intervalMs: 3_600_000 };
    const first = await freshRun({ queryL1: async () => rows, llmRunner: runner as never, config: cfg, store: store as never });
    expect(first.ran).toBe(true);
    const second = await freshRun({ queryL1: async () => rows, llmRunner: runner as never, config: cfg, store: store as never });
    expect(second).toMatchObject({ ran: false, skipped: "interval" });
    expect(calls).toHaveLength(1); // 第二轮零 LLM 调用
  });
});