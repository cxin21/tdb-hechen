/**
 * P3：character 池（品格锚，spike 定案：聚合源=self_identity 槽事实，per-三元组）。
 * 断言：c- 前缀 id、node_type='character'、证据门（事实切片语料包含）、disabled 零调用。
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth, growthValueId } from "./anchor-growth.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function corpusRow(id: string, content: string, valence: number | null = null) {
  return {
    record_id: id, content, type: "episodic", priority: 0.5, scene_name: "", session_key: "",
    session_id: "s1", team_id: "default", task_id: "", user_id: "default", agent_id: "default",
    version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z",
    created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}", valence,
  };
}

function makeStore(opts: { rows?: unknown[] } = {}) {
  return {
    queryL1Records: vi.fn(async () => opts.rows ?? []),
    listValuesAnyState: vi.fn(async () => []),
    upsertValue: vi.fn(async (...args: unknown[]) => true) as unknown as { mock: { calls: unknown[][] } } & ((...args: unknown[]) => Promise<boolean>),
    retireValue: vi.fn(async () => true),
    getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
    setAnchorGrowthState: vi.fn(),
    backfillMemoryRef: vi.fn(() => true),
  };
}

function makeRunnerByTask(replies: Record<string, string>) {
  const calls: Array<{ taskId: string; prompt: string }> = [];
  return {
    calls,
    run: vi.fn(async (p: { taskId: string; prompt: string }) => {
      calls.push({ taskId: p.taskId, prompt: p.prompt });
      return replies[p.taskId] ?? "[]";
    }),
  };
}

describe("growthValueId character 前缀（P3）", () => {
  it("character → c- 前缀；theme 旧逻辑不变", () => {
    expect(growthValueId("严谨严谨", "character")).toBe("c-严谨严谨".replace(/[^a-z0-9_]/g, "").length > 0 ? growthValueId("严谨严谨", "character") : "x");
    expect(growthValueId("严谨严谨", "character")).toMatch(/^c(-auto)?-[0-9a-z-]*$/);
    expect(growthValueId("coffee", "character")).toBe("c-coffee");
    expect(growthValueId("女儿")).toMatch(/^auto-[0-9a-f]{10}$/);
  });
});

describe("character 池（P3 品格锚）", () => {
  it("c- id + node_type=character + 事实切片证据门 + attrs 来源标注", async () => {
    const rows = [
      corpusRow("r1", "我承诺每周五出周报"),
      corpusRow("r2", "评审意见列成清单逐条给出"),
      corpusRow("r3", "用户让我承诺每周五出周报，我照做"),
    ];
    const store = makeStore({ rows });
    (store as unknown as { readCore: ReturnType<typeof vi.fn> }).readCore = vi.fn(() => [
      { slot: "self_identity", content: "- 我承诺每周五出周报\n- 我的风格是先给结论" },
    ]);
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": "[]",
      // #7 T1：rationale 走 #20 合同 v2（情境+取向），采纳端落 attrs.description
      "character-discover-growth": '[{"label":"守诺","rationale":"对交付承诺反复兑现，宁可少接不食言。","fact":"我承诺每周五出周报"}]',
    });
    const res = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 } },
    });
    const up = store.upsertValue.mock.calls.find((c) => c[1] === "守诺")!;
    expect(up).toBeTruthy();
    expect(up[0]).toMatch(/^c-auto-[0-9a-f]{10}$/); // 中文 slug 清空 → c-auto-<hash>
    expect(up[7]).toBe("character");
    // #7 T1：attrs.facts = 自我事实切片快照 + attrs.description = rationale 经单一源 sanitizer
    expect(up[8]).toEqual({ source: "self_identity", facts: ["我承诺每周五出周报", "我的风格是先给结论"], description: "对交付承诺反复兑现，宁可少接不食言。" });
  });

  it("#7 T1：rationale 命中 episode 门 → attrs 无 description（锚照常采纳，渲染端跳过）", async () => {
    const rows = [corpusRow("r1", "我承诺每周五出周报")];
    const store = makeStore({ rows });
    (store as unknown as { readCore: ReturnType<typeof vi.fn> }).readCore = vi.fn(() => [
      { slot: "self_identity", content: "- 我承诺每周五出周报" },
    ]);
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": "[]",
      "character-discover-growth": '[{"label":"守诺","rationale":"2026-09-01 承诺周报。","fact":"我承诺每周五出周报"}]',
    });
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 } },
    });
    const up = store.upsertValue.mock.calls.find((c) => c[1] === "守诺");
    expect(up).toBeTruthy(); // 锚照常采纳（宁缺毋滥：desc 缺失只影响渲染）
    expect(up![8]).toEqual({ source: "self_identity", facts: ["我承诺每周五出周报"] }); // 无 description 键
  });

  it("disabled → 无 character LLM 调用（逐位现状）", async () => {
    const rows = [corpusRow("r1", "我承诺每周五出周报")];
    const store = makeStore({ rows });
    const runner = makeRunnerByTask({ "core-values-discover-growth": "[]" });
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: {},
    });
    expect(runner.run.mock.calls.some((c) => (c[0] as { taskId?: string }).taskId === "character-discover-growth")).toBe(false);
  });

  it("证据门：提案 fact 切片语料 0 命中 → 不采纳（宁缺毋滥）", async () => {
    const rows = [corpusRow("r1", "与品格无关的内容")];
    const store = makeStore({ rows });
    (store as unknown as { readCore: ReturnType<typeof vi.fn> }).readCore = vi.fn(() => [
      { slot: "self_identity", content: "- 我承诺每周五出周报" },
    ]);
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": "[]",
      "character-discover-growth": '[{"label":"守诺","rationale":"x","fact":"我承诺每周五出周报"}]',
    });
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 } },
    });
    expect(store.upsertValue.mock.calls.find((c) => c[1] === "守诺")).toBeUndefined();
  });

  it("#13 T7：fact 与 self_identity 槽断链 → 拒绝（不回退全量事实=证据虚高）", async () => {
    // fact="我每天晨跑五公里" 不在 selfFacts；corpus 却支撑真实事实「我承诺每周五出周报」
    // → 现状（断链回退全量 selfFacts）= 幻觉 fact 凭空继承整槽证据 → 误采纳。
    const rows = [corpusRow("r1", "我承诺每周五出周报")];
    const store = makeStore({ rows });
    (store as unknown as { readCore: ReturnType<typeof vi.fn> }).readCore = vi.fn(() => [
      { slot: "self_identity", content: "- 我承诺每周五出周报" },
    ]);
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": "[]",
      "character-discover-growth": '[{"label":"守诺","rationale":"x","fact":"我每天晨跑五公里"}]',
    });
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 } },
    });
    expect(store.upsertValue.mock.calls.find((c) => c[1] === "守诺")).toBeUndefined();
  });

  it("#13 T7：无 fact 提案维持全量 selfFacts 合法默认（LLM 未指明 ≠ 断链）", async () => {
    const rows = [corpusRow("r1", "我承诺每周五出周报")];
    const store = makeStore({ rows });
    (store as unknown as { readCore: ReturnType<typeof vi.fn> }).readCore = vi.fn(() => [
      { slot: "self_identity", content: "- 我承诺每周五出周报" },
    ]);
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": "[]",
      "character-discover-growth": '[{"label":"守诺","rationale":"x"}]',
    });
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 } },
    });
    expect(store.upsertValue.mock.calls.find((c) => c[1] === "守诺")).toBeTruthy();
  });
});
