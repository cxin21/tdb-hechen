/**
 * P3-F13：反思触发 worker 测试。
 * 断言：触发（累计>rRef→LLM+写卡 work_fact/reflection 带租户）、未触发零调用、
 * disabled 零调用、幂等（反思史即状态——写卡后新记录清零不再触发）。
 */
import { describe, it, expect, vi } from "vitest";
import { runReflection, parseReflectionProposals } from "./reflection.js";

const NOW = "2026-09-18T00:00:00.000Z";
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

type RecOpts = { workFact?: boolean; updatedAt?: string; tenantTriple?: [string, string, string] };

function rec(id: string, content: string, significance: number, opts: RecOpts = {}) {
  const [teamId, userId, agentId] = (opts.tenantTriple ?? ["t1", "u1", "a1"]);
  return {
    id,
    content,
    type: opts.workFact ? "work_fact" : "episodic",
    significance,
    createdAt: NOW,
    updatedAt: opts.updatedAt ?? NOW,
    teamId, userId, agentId,
    metadata: opts.workFact ? { reflection: true } : {},
  };
}

function makeStore() {
  return { upsertL1: vi.fn(async () => true) };
}

describe("F13 反思触发", () => {
  it("触发：累计 significance > rRef → LLM 三问式 → 写 work_fact 结论卡（带租户+证据指针）", async () => {
    const rows: Record<string, unknown>[] = [
      rec("r1", "用户坚持先给结论", 0.9),
      rec("r2", "用户每周五复盘", 0.8),
      rec("r3", "用户偏好清单式评审", 0.7),
    ];
    const store = { upsertL1: vi.fn(async () => true) };
    const llmRunner = { run: vi.fn(async () => '[{"question":"用户的沟通与协作模式是什么","conclusion":"用户偏好结论先行的沟通与结构化复盘","evidence":["r1","r2"]}]') };
    const res = await runReflection({
      queryL1: async () => rows as never,
      config: { enabled: true, rRef: 2 },
      store, llmRunner, logger: LOG,
    });
    expect(res.triggered).toBe(1);
    expect(res.cardsWritten).toBe(1);
    expect(llmRunner.run).toHaveBeenCalled();
    const card = (store.upsertL1.mock.calls[0] as unknown[])[0] as { type?: string; scene_name?: string; metadata?: Record<string, unknown>; teamId?: string; agentId?: string; content?: string };
    expect(card.type).toBe("work_fact");
    expect(card.scene_name).toBe("reflection");
    expect(card.metadata?.reflection).toBe(true);
    expect((card.metadata?.evidence_record_ids as string[])).toEqual(["r1", "r2"]);
    expect(card.teamId).toBe("t1");
    expect(card.agentId).toBe("a1");
    expect(card.content).toContain("结构化");
  });

  it("未触发：累计 <= rRef → 零 LLM 调用", async () => {
    const rows: Record<string, unknown>[] = [rec("r1", "低显著", 0.1)];
    const store = { upsertL1: vi.fn(async () => true) };
    const llmRunner = { run: vi.fn(async () => "[]") };
    const res = await runReflection({
      queryL1: async () => rows as never,
      config: { enabled: true, rRef: 150 },
      store, llmRunner, logger: LOG,
    });
    expect(res.triggered).toBe(0);
    expect(llmRunner.run).not.toHaveBeenCalled();
  });

  it("disabled → 零调用（config-first 逐位现状）", async () => {
    const llmRunner = { run: vi.fn(async () => "[]") };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "x", 0.9)] as never,
      config: { enabled: false, rRef: 150 },
      store: { upsertL1: vi.fn(async () => true) }, llmRunner, logger: LOG,
    });
    expect(res.cardsWritten).toBe(0);
    expect(llmRunner.run).not.toHaveBeenCalled();
  });

  it("幂等：上次反思结论卡的 updatedAt 为阈值 → 新增累计清零不再触发", async () => {
    const rows: Record<string, unknown>[] = [
      rec("r1", "旧事实", 0.9, { updatedAt: "2026-09-10T00:00:00.000Z" }),
      { ...rec("rf0", "上次反思结论", 0, { workFact: true, updatedAt: "2026-09-12T00:00:00.000Z" }), metadata: { reflection: true } } as unknown as typeof rows[0],
      rec("r2", "阈值后低显著", 0.1),
    ];
    const store = { upsertL1: vi.fn(async () => true) };
    const llmRunner = { run: vi.fn(async () => "[]") };
    const res = await runReflection({
      queryL1: async () => rows as never,
      config: { enabled: true, rRef: 150 },
      store, llmRunner, logger: LOG,
    });
    expect(res.triggered).toBe(0);
  });
});

describe("Batch C C-a：反思写卡 occurred_at 合标（#77：340/397 work_fact 空根治）", () => {
  it("写卡 rec.occurred_at 非空 ISO（写链直调 upsertL1 绕过 l1-writer choke point，须就地合标）", async () => {
    const rows: Record<string, unknown>[] = [
      rec("r1", "用户坚持先给结论", 0.9),
      rec("r2", "用户每周五复盘", 0.8),
      rec("r3", "用户偏好清单式评审", 0.7),
    ];
    const store = { upsertL1: vi.fn(async () => true) };
    const llmRunner = { run: vi.fn(async () => '[{"question":"q","conclusion":"用户偏好结论先行的沟通方式","evidence":["r1","r2"]}]') };
    await runReflection({
      queryL1: async () => rows as never,
      config: { enabled: true, rRef: 2 },
      store, llmRunner, logger: LOG,
    });
    expect(store.upsertL1).toHaveBeenCalled();
    const card = (store.upsertL1.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(typeof card.occurred_at).toBe("string");
    expect(String(card.occurred_at).length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(String(card.occurred_at)))).toBe(false);
  });
});

describe("Batch D D-a：结论卡确定性校验门 + few-shot（#77 · survey F1）", () => {
  const triggerRows = (): Record<string, unknown>[] => [
    rec("r1", "用户坚持先给结论", 0.9),
    rec("r2", "用户每周五复盘", 0.8),
    rec("r3", "用户偏好清单式评审", 0.7),
  ];

  it("超 300 字结论卡拒收：upsertL1 只收合格卡（门无条件生效，D8 门只裁决不创作）", async () => {
    const store = makeStore();
    const oversized = "整".repeat(301);
    const llmRunner = { run: vi.fn(async () => `[{"question":"q1","conclusion":"${oversized}","evidence":["r1"]},{"question":"q2","conclusion":"用户偏好结论先行的沟通方式","evidence":["r2"]}]`) };
    const res = await runReflection({
      queryL1: async () => triggerRows() as never,
      config: { enabled: true, rRef: 2 },
      store, llmRunner, logger: LOG,
    });
    expect(store.upsertL1).toHaveBeenCalledTimes(1);
    const card = (store.upsertL1.mock.calls[0] as unknown[])[0] as { content?: unknown };
    expect(card.content).toBe("用户偏好结论先行的沟通方式");
    expect(res.cardsWritten).toBe(1);
  });

  it("few-shot gate on：conclusionContract.enabled=true → prompt 含「一句话一件事」拆条引导", async () => {
    const store = makeStore();
    const llmRunner = { run: vi.fn(async () => "[]") };
    await runReflection({
      queryL1: async () => triggerRows() as never,
      config: { enabled: true, rRef: 2, soulProposals: { conclusionContract: { enabled: true } } },
      store, llmRunner, logger: LOG,
    });
    const prompt = ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt?: string }).prompt ?? "";
    expect(prompt).toContain("一句话一件事");
  });

  it("few-shot gate off（缺省）：prompt 逐位现状不含拆条引导", async () => {
    const store = makeStore();
    const llmRunner = { run: vi.fn(async () => "[]") };
    await runReflection({
      queryL1: async () => triggerRows() as never,
      config: { enabled: true, rRef: 2 },
      store, llmRunner, logger: LOG,
    });
    const prompt = ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt?: string }).prompt ?? "";
    expect(prompt).not.toContain("一句话一件事");
  });
});

describe("parseReflectionProposals", () => {
  it("宽松 JSON 提取 + 非法输入空数组", () => {
    // #44：parse 契约扩展 promiseTransitions（缺省 []，可选提议面）——非 promise 字段逐位不变。
    // D8 创建通道：parse 契约同式扩展 promiseCreations（缺省 []，可选提议面）。
    expect(parseReflectionProposals('[{"question":"q","conclusion":"c","evidence":["r1"]}]')).toEqual([{ question: "q", conclusion: "c", evidence: ["r1"], promiseTransitions: [], promiseCreations: [] }]);
    expect(parseReflectionProposals("not json")).toEqual([]);
  });
});
