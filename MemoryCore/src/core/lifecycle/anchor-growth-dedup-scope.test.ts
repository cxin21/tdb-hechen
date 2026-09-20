/**
 * P0-F3（REG-REMAINING v7 审计轮）：theme 候选去重清单收窄 theme 池。
 * spec §2.6 复合键明文：人物"咖啡"与主题"咖啡"可并存（跨类命名空间 p-/c- 前缀已保证
 * value_id 不碰撞）；旧实现 existingLabels=全类型 label → 跨类型同名被误挡（audit #11）。
 * 同类型全态（veto/retired 永不重提）语义保留；person/character 池各有独立去重清单。
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth } from "./anchor-growth.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const now = () => NOW;
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

function corpusFor(label: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    record_id: `r${i}`, content: `第${i}条 关于${label}的记忆`, type: "episodic", priority: 0.5, scene_name: "",
    session_key: "", session_id: "s1", team_id: "default", task_id: "", user_id: "default", agent_id: "default",
    version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z",
    created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}",
  }));
}

function makeStore(anyState: unknown[]) {
  return {
    queryL1Records: vi.fn(async () => corpusFor("咖啡", 9)),
    listValuesAnyState: vi.fn(async () => anyState),
    listValues: vi.fn(async () => anyState.filter((r) => (r as { state?: string }).state === "active")),
    upsertValue: vi.fn(async () => true),
    retireValue: vi.fn(async () => true),
    getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
    setAnchorGrowthState: vi.fn(async () => {}),
    readCore: vi.fn(() => []),
    backfillMemoryRef: vi.fn(() => true),
  };
}

const CFG = { enabled: true, minEvidence: 3, maxPerPass: 2, maxTotal: 15, intervalHours: 24 };

describe("P0-F3 theme 去重清单跨类型收窄", () => {
  it("人物锚『咖啡』在场时，主题提案『咖啡』不再被跨类型去重误挡（spec §2.6 复合键）", async () => {
    const personRow = { value_id: "p-kafei", label: "咖啡", weight: 0.5, created_by: "auto-growth", valence: 1, origin: "auto", pinned: 0, state: "active", node_type: "person", attrs_json: "{}" };
    const store = makeStore([personRow]);
    const runner = { run: async () => JSON.stringify([{ label: "咖啡", rationale: "反复出现的主题" }]) };
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: CFG, logger: LOG, now });
    expect(res.ran).toBe(true);
    expect(res.adopted).toBeGreaterThanOrEqual(1);
    const calls = (store.upsertValue as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    expect(calls.some((c) => c[1] === "咖啡")).toBe(true);
  });

  it("同类型（theme）vetoed 同名锚仍被去重挡（veto 永不重提保留，控制组）", async () => {
    const vetoRow = { value_id: "auto-xxxx", label: "咖啡", weight: 0.5, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "vetoed", node_type: "theme", attrs_json: "{}" };
    const store = makeStore([vetoRow]);
    const runner = { run: async () => JSON.stringify([{ label: "咖啡", rationale: "反复出现的主题" }]) };
    const res = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: CFG, logger: LOG, now });
    expect(res.adopted).toBe(0);
  });
});
