/**
 * P2 Task 3（spec §2.6/§5 F11/F12/F15/F19）：anchor-growth person 双池。
 * theme 路径字节不动（既有 27 用例回归保障）；person 池同一 worker 内策略化分叉：
 * p- 前缀跨类命名空间 / 别名维度去重 / QUOTA 分池 / GROW-MAINT personEv 口径 / enabled=false 逐位现状。
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth, growthValueId } from "./anchor-growth.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

type AnyRow = { value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type?: "theme" | "person"; attrs_json?: string };

function row(value_id: string, label: string, opts: Partial<AnyRow> = {}): AnyRow {
  return { value_id, label, weight: 0.5, created_by: "verify", valence: null, origin: "manual", pinned: 0, state: "active", node_type: "theme", attrs_json: "{}", ...opts };
}

function corpusRow(id: string, content: string, valence: number | null = null) {
  return {
    record_id: id, content, type: "episodic", priority: 0.5, scene_name: "", session_key: "",
    session_id: "s1", team_id: "default", task_id: "", user_id: "default", agent_id: "default",
    version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z",
    created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}", valence,
  };
}

function makeStore(opts: { rows?: unknown[]; anyState?: AnyRow[] } = {}) {
  const values = (opts.anyState ?? []).map((r) => ({ ...r }));
  return {
    rows: opts.rows ?? [],
    queryL1Records: vi.fn(async () => opts.rows ?? []),
    listValuesAnyState: vi.fn(async () => values.map((r) => ({ ...r }))),
    upsertValue: vi.fn(async (valueId: string, label: string, weight: number, createdBy?: string, _t?: unknown, valence?: number | null, origin?: string, nodeType?: string, attrs?: unknown) => {
      const i = values.findIndex((v) => v.value_id === valueId);
      const rec: AnyRow = { value_id: valueId, label, weight, created_by: createdBy ?? "verify", valence: valence ?? null, origin: (origin as AnyRow["origin"]) ?? "auto", pinned: 0, state: "active", node_type: (nodeType as AnyRow["node_type"]) ?? "theme", attrs_json: attrs ? JSON.stringify(attrs) : "{}" };
      if (i >= 0) values[i] = rec; else values.push(rec);
      return true;
    }),
    retireValue: vi.fn(async (valueId: string) => {
      const v = values.find((x) => x.value_id === valueId);
      if (v) v.state = "retired";
      return true;
    }),
    getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
    setAnchorGrowthState: vi.fn(),
    backfillMemoryRef: vi.fn((_rid: string, _key: string, _label: string) => true),
  };
}

/** 按 taskId 分发应答（theme → core-values-discover-growth；person → person-discover-growth）。 */
function makeRunnerByTask(replies: Record<string, string>) {
  const calls: Array<{ taskId: string; prompt: string; systemPrompt?: string }> = [];
  return {
    calls,
    run: vi.fn(async (p: { taskId: string; prompt: string; systemPrompt?: string }) => {
      calls.push({ taskId: p.taskId, prompt: p.prompt, systemPrompt: p.systemPrompt });
      return replies[p.taskId] ?? "[]";
    }),
  };
}

describe("growthValueId 跨类命名空间", () => {
  it("person 域 p- 前缀；theme 域保持旧逻辑（字节不变）", () => {
    expect(growthValueId("coffee", "person")).toBe("p-coffee");
    expect(growthValueId("coffee")).toBe("coffee");
    expect(growthValueId("coffee", "theme")).toBe("coffee");
    expect(growthValueId("女儿", "person")).toMatch(/^p-auto-[0-9a-f]{10}$/);
    expect(growthValueId("女儿")).toMatch(/^auto-[0-9a-f]{10}$/);
  });
});

describe("person 池采纳（happy path）", () => {
  it("p- id + role/aliases attrs + F12 valence 符号 + personRefs 回填", async () => {
    const rows = [
      corpusRow("r1", "女儿今天月考", 0.5),
      corpusRow("r2", "闺女要去图书馆", 0.1),
      corpusRow("r3", "女儿的房间"),
      corpusRow("r4", "女儿喜欢看书"),
      corpusRow("r5", "陪闺女散步"),
    ];
    const store = makeStore({ rows });
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": '[{"label":"女儿","role":"家人","aliases":["闺女"]}]',
    });
    const res = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { person: { enabled: true, minEvidence: 3, maxPerPass: 1, maxTotal: 8 } },
    });
    expect(res.adopted).toBe(1);
    const up = store.upsertValue.mock.calls.find((c) => c[1] === "女儿")!;
    expect(up).toBeTruthy();
    expect(up[0]).toMatch(/^p-auto-[0-9a-f]{10}$/);
    expect(up[7]).toBe("person");
    expect(up[8]).toEqual({ role: "家人", aliases: ["闺女"] });
    expect(up[5]).toBe(1); // mean(0.5,0.1)=0.3 ≥0.2 → 趋近
    const refs = store.backfillMemoryRef.mock.calls.filter((c) => c[1] === "personRefs");
    expect(refs.length).toBeGreaterThanOrEqual(4);
  });
});

describe("别名维度去重（F19）", () => {
  it("提案 alias 命中既有 person label/alias → 拒", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => corpusRow(`r${i}`, `小女第${i}次出现`));
    const store = makeStore({
      rows,
      anyState: [row("p-nver", "女儿", { origin: "auto", created_by: "auto-growth", node_type: "person", attrs_json: '{"aliases":["闺女"]}' })],
    });
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": '[{"label":"小女","role":"家人","aliases":["女儿"]}]',
    });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: () => NOW, config: { person: { enabled: true, minEvidence: 3, maxPerPass: 2, maxTotal: 8 } } });
    expect(res.adopted).toBe(0);
    expect(store.upsertValue).not.toHaveBeenCalled();
  });
});

describe("跨类命名空间互不挡", () => {
  it("theme 已有咖啡不挡 person 咖啡（p- 前缀独立 id）", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => corpusRow(`r${i}`, `咖啡第${i}次提及`));
    const store = makeStore({
      rows,
      anyState: [row("coffee", "咖啡", { origin: "auto", created_by: "auto-growth" })],
    });
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": '[{"label":"咖啡","role":"朋友","aliases":[]}]',
    });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: () => NOW, config: { person: { enabled: true, minEvidence: 3, maxPerPass: 2, maxTotal: 8 } } });
    expect(res.adopted).toBe(1);
    const up = store.upsertValue.mock.calls.find((c) => String(c[0]).startsWith("p-") && c[7] === "person")!;
    expect(up).toBeTruthy();
    expect(up[7]).toBe("person");
  });
});

describe("QUOTA 分池（F15）", () => {
  it("person 满 maxTotal 时挤出在 person 域内进行；theme 满不挤 person", async () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, i) => corpusRow(`za${i}`, `张阿姨第${i}次出现`)),
      ...Array.from({ length: 3 }, (_, i) => corpusRow(`lw${i}`, `老王第${i}次出现`)),
      ...Array.from({ length: 5 }, (_, i) => corpusRow(`ne${i}`, `女儿第${i}次出现`)),
    ];
    const store = makeStore({
      rows,
      anyState: [
        row("p-a", "张阿姨", { origin: "auto", created_by: "auto-growth", weight: 0.4, node_type: "person" }),
        row("p-b", "老王", { origin: "auto", created_by: "auto-growth", weight: 0.9, node_type: "person" }),
        row("t1", "主题锚甲", { origin: "auto", weight: 0.4 }),
      ],
    });
    const runner = makeRunnerByTask({
      "core-values-discover-growth": "[]",
      "person-discover-growth": '[{"label":"女儿","role":"家人","aliases":[]}]',
    });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: () => NOW, config: { person: { enabled: true, minEvidence: 2, maxPerPass: 2, maxTotal: 2 } } });
    // 张阿姨(reweight 后 0.2×2=0.4) 弱于 老王(0.3×3=0.9)；女儿候选 0.5×5=2.5 > 0.4 → 挤出张阿姨
    expect(res.displaced).toBe(1);
    const retired = store.retireValue.mock.calls.map((c) => c[0]);
    expect(retired).toContain("p-a");
    expect(retired).not.toContain("t1"); // t1 是 manual（默认 created_by）——maint/QUOTA 双豁免，theme 域不被波及
  });
});

describe("GROW-MAINT personEv 口径（F15）", () => {
  it("alias 独立支撑的 person 锚不误退场；reweight 保留 attrs", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => corpusRow(`r${i}`, `闺女第${i}次出现`));
    const store = makeStore({
      rows,
      anyState: [row("p-nver", "女儿", { origin: "auto", created_by: "auto-growth", weight: 0.3, node_type: "person", attrs_json: '{"role":"家人","aliases":["闺女"]}' })],
    });
    const runner = makeRunnerByTask({ "core-values-discover-growth": "[]", "person-discover-growth": "[]" });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: () => NOW, config: { person: { enabled: true, minEvidence: 3, maxPerPass: 1, maxTotal: 8 } } });
    expect(res.retired).toBe(0); // theme 口径 recount("女儿")=0 会误退；personEv=6 保住
    const up = store.upsertValue.mock.calls.find((c) => c[0] === "p-nver")!;
    expect(up).toBeTruthy(); // reweight 发生
    expect(JSON.parse(JSON.stringify(up[8]))).toEqual({ role: "家人", aliases: ["闺女"] }); // attrs 保留
    expect(up[7]).toBe("person");
  });
});

describe("person.enabled=false（缺省）逐位现状", () => {
  it("零 person LLM 调用；person 行不参与 maint/QUOTA；theme 照常", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => corpusRow(`r${i}`, `关于独学的第${i}条`));
    const store = makeStore({
      rows,
      anyState: [row("p-x", "孤锚", { origin: "auto", created_by: "auto-growth", weight: 0.9, node_type: "person" })],
    });
    const runner = makeRunnerByTask({ "core-values-discover-growth": "[]" });
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now: () => NOW });
    expect(runner.calls.filter((c) => c.taskId === "person-discover-growth").length).toBe(0);
    expect(res.adopted).toBe(0);
    expect(res.retired).toBe(0); // 孤锚（零语料命中）不被 theme 口径误退
  });
});
