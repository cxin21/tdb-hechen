/**
 * M2-P4（S-CHAR-2）：identity-discovery characterProposal 提案链（RED 先行）。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §2.2/§7.2 + character-tension-m2-plan P4。
 *   - worker prompt 增张力候选段 + 第三产出字段 characterProposal（IF-3 宽松读取：旧输出无字段=逐位现状）
 *   - 确定性门：tensionRefs 实例须命中真实候选 ≥ minInstances + F19 护栏四件（ev≥minEvidence/
 *     per-pass cap/(node_type,label) 复合去重/veto·retired 永不重提）+ F15 character 池配额
 *   - IF-4：characterProposal 不入 proposal-dedup 比对域（蒸馏提案与身份事实去重是两个语义）
 *   - R-C：品格张力不产生 identityRefs（蒸馏物非事实）
 *   - T1 挂点：identity/self_identity 采纳（version++）时对「旧槽内容 vs 新事实」极性对照
 */
import { describe, expect, it, vi } from "vitest";
import { runIdentityDiscovery } from "../identity-discovery.js";
import { recordTensionCandidates } from "../../hooks/character-tension.js";

const TENANT = { teamId: "ft", userId: "m2", agentId: "agent-char" };
const CT = { enabled: true, minInstances: 2, maxCandidatesPerPass: 2 };
const POOL = { enabled: true, minEvidence: 1, maxPerPass: 2, maxTotal: 8 };

function makeFakeStore(opts: {
  existing?: Array<{ slot: string; content: string }>;
  charAnchors?: Array<{ label: string; state?: string; pinned?: 0 | 1 }>;
  valueLabels?: string[];
} = {}) {
  const coreUpserts: Array<{ slot: string; content: string; createdBy: string }> = [];
  const valueUpserts: Array<{ valueId: string; label: string; weight: number; createdBy: string; valence: unknown; origin: unknown; nodeType: unknown; attrs: unknown }> = [];
  const pendingUpserts: Array<{ slot: string; content: string }> = [];
  const refBackfills: Array<{ recordId: string; key: string; label: string }> = [];
  const charRows = (opts.charAnchors ?? []).map((c, i) => ({
    value_id: `char-${i}`,
    label: c.label,
    weight: 0.5,
    created_by: "auto-growth",
    valence: null,
    origin: "auto",
    pinned: c.pinned ?? 0,
    state: c.state ?? "active",
    node_type: "character" as const,
    attrs_json: "{}",
  }));
  return {
    coreUpserts, valueUpserts, pendingUpserts, refBackfills,
    queryL1Records: () => [
      { record_id: "r1", content: "我在这个团队负责技术评审与交付把关", significance: 0.9, updated_time: "2026-09-24T09:00:00Z" },
      { record_id: "r2", content: "我在这个团队负责技术评审与交付把关（续）", significance: 0.9, updated_time: "2026-09-24T09:30:00Z" },
    ],
    countL1: () => 2,
    readCore: () => opts.existing ?? [],
    upsertCore: (slot: string, content: string, createdBy: string) => {
      coreUpserts.push({ slot, content, createdBy });
      return true;
    },
    listValuesAnyState: () => charRows,
    listValues: () => (opts.valueLabels ?? []).map((l) => ({ value_id: l, label: l, weight: 0.5, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "active", node_type: "theme", attrs_json: "{}" })),
    upsertValue: (valueId: string, label: string, weight: number, createdBy: string, _t: unknown, valence: unknown, origin: unknown, nodeType: unknown, attrs: unknown) => {
      valueUpserts.push({ valueId, label, weight, createdBy, valence, origin, nodeType, attrs });
      return true;
    },
    upsertPendingCore: (slot: string, content: string) => {
      pendingUpserts.push({ slot, content });
      return true;
    },
    backfillMemoryRef: (recordId: string, key: string, label: string) => {
      refBackfills.push({ recordId, key, label });
      return true;
    },
    getIdentityDiscoveryState: () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: () => {},
    listL1TenantTriplets: () => [TENANT],
  } as never;
}

const LLM_BASE = JSON.stringify([
  { slot: "identity", content: "我在这个团队负责技术评审与交付把关", rationale: "多源一致" },
]);

async function run(store: unknown, llmRaw: string, deps: Record<string, unknown> = {}) {
  const runFn = vi.fn().mockResolvedValue(llmRaw);
  const res = await runIdentityDiscovery({
    store: store as never,
    llmRunner: { run: runFn },
    config: { intervalHours: 24 },
    characterTension: CT,
    characterPool: POOL,
    logger: undefined,
    now: () => new Date("2026-09-24T10:00:00Z"),
    ...deps,
  } as never);
  return { res, runFn };
}

describe("M2-P4 characterProposal 提案链", () => {
  it("① characterTension 缺省关断：character 提案静默丢弃（逐位现状：无 upsertValue、无 pending）", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] }]);
    const { res, runFn } = await run(store, llm, { characterTension: undefined });
    expect(runFn.mock.calls[0][0].prompt).not.toContain("品格张力候选");
    const s = store as never as { valueUpserts: unknown[]; pendingUpserts: unknown[] };
    expect(s.valueUpserts).toEqual([]);
    expect(res.adopted).toBe(1);
  });

  it("② 合格张力提案：确定性门通过 → upsertValue(node_type=character, createdBy=auto-growth, attrs.source=character_tension)", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "证据分裂", tensionRefs: [{ recordId: "r1", valence: 0.5 }, { recordId: "r2", valence: -0.4 }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "承诺反复被践行与违背", tensionRefs: ["r1", "r2"] }]);
    const { runFn } = await run(store, llm);
    expect(runFn.mock.calls[0][0].prompt).toContain("品格张力候选");
    const s = store as never as { valueUpserts: Array<{ nodeType: unknown; attrs: Record<string, unknown> }>; pendingUpserts: unknown[] };
    expect(s.valueUpserts).toHaveLength(1);
    expect(s.valueUpserts[0].nodeType).toBe("character");
    expect((s.valueUpserts[0].attrs as { source?: string }).source).toBe("character_tension");
  });

  it("③ tensionRefs 数 < minInstances → 拒（LLM 不可越过确定性门）", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1"] }]);
    await run(store, llm);
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toEqual([]);
  });

  it("④ 编造 label（无真实候选）→ 拒；编造 ref id → 只认命中真实候选的实例", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([
      ...JSON.parse(LLM_BASE),
      { slot: "character", label: "虚构品格", rationale: "r", tensionRefs: ["r1", "r2"] },
      { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["fake-a", "fake-b"] },
    ]);
    await run(store, llm);
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toEqual([]);
  });

  it("⑤ (node_type,label) 复合去重：retired 同 label 也永不重提（F19 全态去重）", async () => {
    const store = makeFakeStore({
      existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }],
      charAnchors: [{ label: "守诺", state: "retired" }],
    });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] }]);
    await run(store, llm);
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toEqual([]);
  });

  it("⑥ F15 池配额：名额满 → 拒（诚实留痕不挤出）", async () => {
    const store = makeFakeStore({
      existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }],
      charAnchors: [{ label: "坦诚" }, { label: "复盘" }],
    });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] }]);
    await run(store, llm, { characterPool: { ...POOL, maxTotal: 2 } });
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toEqual([]);
  });

  it("⑦ per-pass cap：maxCandidatesPerPass=1 → 两个合格提案只采纳 1 个", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [
      { source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" },
      { source: "T2", label: "复盘", rationale: "y", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" },
    ]);
    const llm = JSON.stringify([
      ...JSON.parse(LLM_BASE),
      { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] },
      { slot: "character", label: "复盘", rationale: "r", tensionRefs: ["r1", "r2"] },
    ]);
    await run(store, llm, { characterTension: { ...CT, maxCandidatesPerPass: 1 } });
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toHaveLength(1);
  });

  it("⑧ ev 门：self_identity 槽空 → characterEvidenceCount=0 < minEvidence → 拒", async () => {
    const store = makeFakeStore({ existing: [] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] }]);
    await run(store, llm, { characterPool: { ...POOL, minEvidence: 2 } });
    expect((store as never as { valueUpserts: unknown[] }).valueUpserts).toEqual([]);
  });

  it("⑨ IF-4：character 提案不进 proposal-dedup 比对域——与 pending 红线内容雷同仍走张力门", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([
      ...JSON.parse(LLM_BASE),
      { slot: "core_value", content: "守诺是我在这个团队负责技术评审与交付把关", rationale: "r" },
      { slot: "character", label: "守诺", rationale: "守诺是我在这个团队负责技术评审与交付把关", tensionRefs: ["r1", "r2"] },
    ]);
    await run(store, llm);
    const s = store as never as { valueUpserts: unknown[] };
    expect(s.valueUpserts).toHaveLength(1); // character 提案不被红线去重误拦
  });

  it("⑩ R-C：品格提案采纳路径零 identityRefs 回填", async () => {
    const store = makeFakeStore({ existing: [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }] });
    recordTensionCandidates(TENANT, [{ source: "T2", label: "守诺", rationale: "x", tensionRefs: [{ recordId: "r1" }, { recordId: "r2" }], detectedAt: "t" }]);
    const llm = JSON.stringify([...JSON.parse(LLM_BASE), { slot: "character", label: "守诺", rationale: "r", tensionRefs: ["r1", "r2"] }]);
    await run(store, llm);
    const s = store as never as { valueUpserts: unknown[]; refBackfills: Array<{ key: string; label: string }> };
    expect(s.valueUpserts).toHaveLength(1); // 品格锚已采纳
    // R-C 精确口径：identity 提案自身的 identityRefs 回填是现状；品格 label（蒸馏物）绝不产生 identityRefs
    expect(s.refBackfills.filter((b) => b.key === "identityRefs" && b.label === "守诺")).toEqual([]);
  });

  it("⑪ T1 挂点：identity 采纳且新旧极性翻转 → 注册表产出 T1 候选（下一轮消费）", async () => {
    const store = makeFakeStore({ existing: [{ slot: "identity", content: "- 我不做代码评审" }], valueLabels: ["代码评审"] });
    const llm = JSON.stringify([{ slot: "identity", content: "我开始做代码评审", rationale: "演化" }]);
    await run(store, llm);
    const { drainTensionCandidates } = await import("../../hooks/character-tension.js");
    const drained = drainTensionCandidates(TENANT);
    const t1 = drained.filter((c) => c.source === "T1");
    expect(t1.length).toBeGreaterThanOrEqual(1);
    expect(t1.some((c) => c.label === "代码评审")).toBe(true);
  });
});
