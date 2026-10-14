// #19 T12（2026-10-14 拍板）：rejected 拦截域证据升级重提通道。
// V12-REPRO 基线：rejected 域命中一律静默拦截（reproposal.enabled=false 缺省=逐位现状）。
// 通道开启时：①证据 ≥2×minEvidence 才允许重提（相对门槛，证据没涨不复活）；
// ②每轮重提 ≤maxPerPass（按证据降序）；③同内容重提被拒 ≥maxRejectsBeforeCold 次 → 长冷
// （自动通道关闭，人工通道不受限）；④重提案带溯源 attrs {reproposed, supersedes, generation}
// + 新 pending_id 后缀 -rN（rejected 行不可复活=V12 语义保持）。
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, pendingBaseId } from "./identity-discovery.js";

const TENANT = { teamId: "rt", userId: "ru", agentId: "ra" };
const CONTENT_A = "排查期间绝不可通过任何路径删除记忆";
const CONTENT_B = "生产语料严禁注入测试对话污染";
const CONTENT_C = "结论必须附证据与链路位置";
const BASE_A = pendingBaseId("core_value", CONTENT_A, TENANT);

const RULE = "排查期间绝不注入测试对话";
const CORPUS_ROWS = Array.from({ length: 6 }, (_, i) => ({
  record_id: `r${i}`,
  content: `会话${i}记录：${CONTENT_A}；${CONTENT_B}；${CONTENT_C}；${RULE}（多源一致）`,
  significance: 0.9,
  updated_time: `2026-10-14T08:0${i}:00Z`,
}));

interface PendingRow { pending_id: string; slot: string; content: string; evidence?: number; state: string; attrs_json?: string | null; label?: string | null; description?: string | null }
interface PendingCall { slot: string; content: string; evidence: number; extra?: { label?: string; description?: string; attrs?: Record<string, unknown>; reproposalOf?: string; reproposalGen?: number } }

function makeStore(pendingRows: PendingRow[]) {
  const pendingCalls: PendingCall[] = [];
  return {
    pendingCalls,
    queryL1Records: () => CORPUS_ROWS,
    countL1: () => CORPUS_ROWS.length,
    listL1TenantTriplets: () => [TENANT], // per-agent 化（PA）：让发现跑在测试租户桶上
    readCore: () => [], // 同步——生产 sqlite store 的 readCore 为同步方法（v2 实证教训）
    upsertCore: () => true,
    listPendingCore: (_t?: unknown, _o?: unknown) => pendingRows,
    upsertPendingCore: (slot: string, content: string, evidence: number, _t?: unknown, extra?: PendingCall["extra"]) => {
      pendingCalls.push({ slot, content, evidence, extra });
      return true;
    },
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

function proposal(content: string, slot = "core_value") {
  return slot === "core_value"
    ? { slot, content, label: "禁删记忆", description: "记忆是不可再生的生产资产", rationale: "多源一致" }
    : { slot, content, rationale: "红线" };
}

async function run(store: never, proposals: unknown[], config: Record<string, unknown>) {
  const runFn = vi.fn().mockResolvedValue(JSON.stringify(proposals));
  const res = await runIdentityDiscovery({
    store, llmRunner: { run: runFn }, logger: undefined,
    config: config as never, selfIdentity: { enabled: false, maxPerPass: 2 },
    now: () => new Date("2026-10-14T10:00:00Z"),
  });
  return res as { ran: boolean; pending: number };
}

const REPRO = { intervalHours: 24, reproposal: { enabled: true, minEvidenceMultiple: 2, maxPerPass: 2, maxRejectsBeforeCold: 2 } };
const NOW_NOW = () => new Date("2026-10-14T10:00:00Z");
void NOW_NOW;
const baseRow = (state: string, attrs_json?: string | null, pid = BASE_A): PendingRow => ({ pending_id: pid, slot: "core_value", content: CONTENT_A, evidence: 1, state, attrs_json, label: "禁删记忆", description: null });

describe("#19 T12：rejected 域证据升级重提通道", () => {
  it("enabled + 证据 ≥2×minEvidence → 重提案落库（attrs 溯源 + reproposalOf/Gen + pending 计数）", async () => {
    const store = makeStore([baseRow("rejected")]) as never as { pendingCalls: PendingCall[] };
    const res = await run(store as never, [proposal(CONTENT_A)], REPRO);
    expect(res.pending).toBe(1);
    expect(store.pendingCalls).toHaveLength(1);
    const c = store.pendingCalls[0]!;
    expect(c.slot).toBe("core_value");
    expect(c.content).toBe(CONTENT_A);
    expect(c.evidence).toBe(6); // 6 行语料全命中 ≥ 2×3
    expect(c.extra?.reproposalOf).toBe(BASE_A);
    expect(c.extra?.reproposalGen).toBe(1);
    expect(c.extra?.attrs?.reproposed).toBe(true);
    expect(c.extra?.attrs?.supersedes).toBe(BASE_A);
    expect(c.extra?.attrs?.generation).toBe(1);
    expect(typeof c.extra?.attrs?.reproposed_at).toBe("string");
  });

  it("缺省（无 reproposal 配置）→ V12-REPRO 逐位现状：rejected 域命中静默拦截", async () => {
    const store = makeStore([baseRow("rejected")]) as never as { pendingCalls: PendingCall[] };
    const res = await run(store as never, [proposal(CONTENT_A)], { intervalHours: 24 });
    expect(res.pending).toBe(0);
    expect(store.pendingCalls).toHaveLength(0);
  });

  it("enabled 但证据 <2×minEvidence → 不复活（相对门槛）", async () => {
    const store = makeStore([baseRow("rejected")]) as never as { pendingCalls: PendingCall[] };
    await run(store as never, [proposal(CONTENT_A)], { ...REPRO, reproposal: { ...REPRO.reproposal, minEvidenceMultiple: 5 } });
    expect(store.pendingCalls).toHaveLength(0);
  });

  it("重提 1 次被拒 → gen2 可再提；重提 2 次被拒 → 长冷不再自动重提", async () => {
    const gen1 = baseRow("rejected", JSON.stringify({ reproposed: true, supersedes: BASE_A, generation: 1 }), `${BASE_A}-r1`);
    const store1 = makeStore([baseRow("rejected"), gen1]) as never as { pendingCalls: PendingCall[] };
    await run(store1 as never, [proposal(CONTENT_A)], REPRO);
    expect(store1.pendingCalls).toHaveLength(1);
    expect(store1.pendingCalls[0]!.extra?.reproposalGen).toBe(2);
    expect((store1.pendingCalls[0]!.extra?.attrs as Record<string, unknown>).generation).toBe(2);

    const gen2 = baseRow("rejected", JSON.stringify({ reproposed: true, supersedes: BASE_A, generation: 2 }), `${BASE_A}-r2`);
    const store2 = makeStore([baseRow("rejected"), gen1, gen2]) as never as { pendingCalls: PendingCall[] };
    await run(store2 as never, [proposal(CONTENT_A)], REPRO);
    expect(store2.pendingCalls).toHaveLength(0);
  });

  it("每轮重提 ≤maxPerPass（按证据降序，多候选截断）", async () => {
    const rows: PendingRow[] = [
      baseRow("rejected", null, pendingBaseId("core_value", CONTENT_A, TENANT)),
      { ...baseRow("rejected", null, pendingBaseId("core_value", CONTENT_B, TENANT)), content: CONTENT_B },
      { ...baseRow("rejected", null, pendingBaseId("core_value", CONTENT_C, TENANT)), content: CONTENT_C },
    ];
    const store = makeStore(rows) as never as { pendingCalls: PendingCall[] };
    const res = await run(store as never, [proposal(CONTENT_A), proposal(CONTENT_B), proposal(CONTENT_C)], REPRO);
    expect(res.pending).toBe(2);
    expect(store.pendingCalls).toHaveLength(2);
    const contents = store.pendingCalls.map((c) => c.content);
    expect(contents).toContain(CONTENT_A);
    expect(contents).toContain(CONTENT_B);
    expect(contents).not.toContain(CONTENT_C);
  });

  it("pending 在裁域命中（state=pending）→ 静默跳过（现状不变，不重提）", async () => {
    const store = makeStore([baseRow("pending")]) as never as { pendingCalls: PendingCall[] };
    const res = await run(store as never, [proposal(CONTENT_A)], REPRO);
    expect(res.pending).toBe(0);
    expect(store.pendingCalls).toHaveLength(0);
  });

  it("strict_rule 槽走同一通道（红线类 pending-only 语义不变）", async () => {
    const RULE = "排查期间绝不注入测试对话";
    const ruleBase = pendingBaseId("strict_rule", RULE, TENANT);
    const rows: PendingRow[] = [{ pending_id: ruleBase, slot: "strict_rule", content: RULE, evidence: 1, state: "rejected", attrs_json: null }];
    const store = makeStore(rows) as never as { pendingCalls: PendingCall[] };
    const res = await run(store as never, [proposal(RULE, "strict_rule")], REPRO);
    expect(res.pending).toBe(1);
    expect(store.pendingCalls).toHaveLength(1);
    expect(store.pendingCalls[0]!.slot).toBe("strict_rule");
    expect(store.pendingCalls[0]!.extra?.attrs?.supersedes).toBe(ruleBase);
  });
});
