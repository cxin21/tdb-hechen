/**
 * G-SIMMERGE（2026-10-05 何晨令「新增内容和已有内容相似度高时合并做增量更新而非新增」）：
 * 1) isSimilarLabel 纯函数判定矩阵（归一化相等 / 包含关系 / bigram Jaccard 阈值）；
 * 2) 采纳前相似门：候选命中既有 active theme 锚 → 不新建、增量更新命中锚（similarMerged 计数）；
 * 3) config-first：enabled=false（缺省）逐位现状照常新建；非相似候选不受影响。
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth } from "./anchor-growth.js";
import { isSimilarLabel } from "../../gateway/core-values-discover.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const now = () => NOW;
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

function corpusFor(label: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    record_id: `r${i}`, content: `第${i}条 关于${label}的记忆`, type: "episodic", priority: 0.5, scene_name: "",
    session_key: "", session_id: "s1", team_id: "default", task_id: "", user_id: "default", agent_id: "default",
    version: 1, timestamp_str: "2026-10-04T00:00:00Z", timestamp_start: "2026-10-04T00:00:00Z", timestamp_end: "2026-10-04T00:00:00Z",
    created_time: "2026-10-04T00:00:00Z", updated_time: "2026-10-04T00:00:00Z", metadata_json: "{}",
  }));
}

function makeStore(anyState: unknown[], corpusLabel: string) {
  return {
    queryL1Records: vi.fn(async () => corpusFor(corpusLabel, 9)),
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

function themeRow(label: string, weight = 0.5) {
  return { value_id: `auto-${label}`, label, weight, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "active", node_type: "theme", attrs_json: "{}" };
}

const upsertCalls = (store: unknown) =>
  (store as { upsertValue: { mock: { calls: Array<Array<unknown>> } } }).upsertValue.mock.calls;

describe("G-SIMMERGE isSimilarLabel 判定矩阵", () => {
  it("归一化相等命中（大小写/空白）", () => {
    expect(isSimilarLabel("根因优先", " 根因优先 ")).toBe(true);
    expect(isSimilarLabel("Evidence First", "evidence first")).toBe(true);
  });
  it("包含关系命中（生产实锚碎片对：根因⊂根因优先）", () => {
    expect(isSimilarLabel("根因", "根因优先")).toBe(true);
    expect(isSimilarLabel("根因优先", "根因")).toBe(true);
  });
  it("bigram Jaccard 阈值：高重叠命中、低重叠不命中", () => {
    expect(isSimilarLabel("证据先行", "取证先行")).toBe(false); // 共享 bigram 1/5=0.2 < 0.5
    expect(isSimilarLabel("根因优先", "根因第一")).toBe(false); // {根因,因优,优先}∩{根因,因一,第一}=1/5=0.2 < 0.5
    expect(isSimilarLabel("根因优选", "根因优先")).toBe(true);  // {根因,因优,优选}∩{根因,因优,优先}=2/4=0.5 ≥ 0.5
    expect(isSimilarLabel("部署管理", "小猫钓鱼")).toBe(false); // 零共享
  });
  it("空串防护", () => {
    expect(isSimilarLabel("", "根因")).toBe(false);
    expect(isSimilarLabel("根因", "")).toBe(false);
  });
});

describe("G-SIMMERGE 采纳前相似门", () => {
  it("enabled=true：候选『根因』命中既有『根因优先』→ 不新建，增量更新命中锚", async () => {
    const store = makeStore([themeRow("根因优先")], "根因优先");
    const runner = { run: async () => JSON.stringify([{ label: "根因", rationale: "反复出现的主题" }]) };
    const res = await runAnchorGrowth({
      store: store as never, llmRunner: runner as never, logger: LOG, now,
      config: { minEvidence: 3, maxPerPass: 2, maxTotal: 15, intervalHours: 24, similarMerge: { enabled: true, threshold: 0.5 } },
    });
    expect(res.ran).toBe(true);
    expect(res.similarMerged).toBe(1);
    expect(res.adopted).toBe(0); // 碎片锚未新建
    // 增量更新落在既有锚（value_id=label=根因优先），而非新建「根因」
    const calls = upsertCalls(store);
    expect(calls.some((c) => c[0] === "auto-根因优先" && c[1] === "根因优先")).toBe(true);
    expect(calls.some((c) => c[1] === "根因")).toBe(false);
  });

  it("enabled=false（缺省）：逐位现状，同场景照常新建（配置门真生效）", async () => {
    const store = makeStore([themeRow("根因优先")], "根因优先");
    const runner = { run: async () => JSON.stringify([{ label: "根因", rationale: "反复出现的主题" }]) };
    const res = await runAnchorGrowth({
      store: store as never, llmRunner: runner as never, logger: LOG, now,
      config: { minEvidence: 3, maxPerPass: 2, maxTotal: 15, intervalHours: 24 },
    });
    expect(res.adopted).toBe(1);
    expect(res.similarMerged ?? 0).toBe(0);
    expect(upsertCalls(store).some((c) => c[1] === "根因")).toBe(true);
  });

  it("enabled=true：非相似候选不受相似门影响，照常采纳", async () => {
    const store = makeStore([themeRow("根因优先")], "根因优先");
    const runner = { run: async () => JSON.stringify([{ label: "记忆", rationale: "另一主题" }]) };
    const res = await runAnchorGrowth({
      store: store as never, llmRunner: runner as never, logger: LOG, now,
      config: { minEvidence: 3, maxPerPass: 2, maxTotal: 15, intervalHours: 24, similarMerge: { enabled: true, threshold: 0.5 } },
    });
    expect(res.adopted).toBe(1);
    expect(res.similarMerged).toBe(0);
  });

  it("enabled=true：weight 变化 < delta 时命中锚不被重写，但碎片锚仍不新建", async () => {
    const corpus = corpusFor("根因优先", 9);
    // 命中锚 weight 预置为该语料刻度下的重算值 → |Δ|<0.05 无写
    const { suggestAnchorWeight } = await import("../../gateway/core-values-discover.js");
    const tunedW = suggestAnchorWeight(9, 9);
    const store = makeStore([themeRow("根因优先", tunedW)], "根因优先");
    void corpus;
    const runner = { run: async () => JSON.stringify([{ label: "根因", rationale: "反复出现的主题" }]) };
    const res = await runAnchorGrowth({
      store: store as never, llmRunner: runner as never, logger: LOG, now,
      config: { minEvidence: 3, maxPerPass: 2, maxTotal: 15, intervalHours: 24, similarMerge: { enabled: true, threshold: 0.5 } },
    });
    expect(res.similarMerged).toBe(1);
    expect(res.adopted).toBe(0);
    expect(upsertCalls(store).length).toBe(0); // weight 已对齐 → 零写入
  });
});
