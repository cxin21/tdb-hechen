/**
 * #27（R5，2026-10-16）：反思结论 → 身份层提案安全门测试。
 *
 * 合同（r5-27 验收）：
 * - slot 白名单：仅 identity/self_identity 可被提案修订；strict_rule 拒绝（红线不可被反思流程绕过）。
 * - 提案去原文：提案文本禁逐字包含 L1 片段（≥12 字句级；防用户内容经 LLM 诱导持久化注入）。
 * - 证据非空：无证据指针不提案（R4 证据 id 列表双保险）。
 * - 调度单一源：桥接内联 runReflection（F13 触发 + consolidation 节拍兜底），零新调度器。
 * - 重复抑制：与在途 pending / 既有 core 身份行归一化重复 → 拒推。
 * - 门 off（缺省）→ 零提案零落库差异（config-first 逐位现状）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  REFLECTION_PROPOSAL_SLOTS,
  VERBATIM_FRAGMENT_MIN_CHARS,
  findVerbatimL1Fragment,
  isReflectionProposalSlotAllowed,
  l1VerbatimFragments,
  vetReflectionIdentityProposal,
} from "../soul-reflection-proposals.js";
import { runReflection } from "../reflection.js";

const L1_A = "在交付之前我一定会先跑全量测试确认没有回归。这是雷打不动的习惯。";
const L1_B = "用户拍板后 AI 才执行落盘，这是协作分工的约定。";

function mkRows() {
  return [
    { id: "r1", content: L1_A, type: "episodic", significance: 0.6, updatedAt: "2026-10-16T08:00:00Z", teamId: "t", userId: "u", agentId: "a" },
    { id: "r2", content: L1_B, type: "episodic", significance: 0.6, updatedAt: "2026-10-16T08:01:00Z", teamId: "t", userId: "u", agentId: "a" },
    { id: "r3", content: "第三条凑显著度。", type: "episodic", significance: 0.5, updatedAt: "2026-10-16T08:02:00Z", teamId: "t", userId: "u", agentId: "a" },
  ];
}

function mkDeps(over: {
  llmRaw: string;
  store?: Record<string, unknown>;
  soulProposals?: { enabled?: boolean };
}) {
  const upsertPendingCore = vi.fn(async () => true);
  const listPendingCore = vi.fn(async () => (over.store?.pendingRows as unknown[]) ?? []);
  const readCore = vi.fn(async () => (over.store?.coreRows as unknown[]) ?? null);
  const upsertL1 = vi.fn(async () => true);
  const store = {
    upsertL1,
    ...(over.store ?? {}),
    upsertPendingCore: (over.store?.upsertPendingCore as unknown) ?? upsertPendingCore,
    listPendingCore,
    readCore,
  };
  return {
    deps: {
      queryL1: async () => mkRows(),
      config: { enabled: true, rRef: 1, ...(over.soulProposals ? { soulProposals: over.soulProposals } : {}) },
      store,
      llmRunner: { run: async () => over.llmRaw },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
    spies: { upsertPendingCore, upsertL1 },
  };
}

describe("#27 确定性门（纯函数）", () => {
  it("slot 白名单：仅 identity/self_identity 放行；strict_rule 拒绝", () => {
    expect(REFLECTION_PROPOSAL_SLOTS).toEqual(["identity", "self_identity"]);
    expect(isReflectionProposalSlotAllowed("identity")).toBe(true);
    expect(isReflectionProposalSlotAllowed("self_identity")).toBe(true);
    expect(isReflectionProposalSlotAllowed("strict_rule")).toBe(false);
    expect(isReflectionProposalSlotAllowed("personality")).toBe(false);
  });

  it("句级碎片：≥12 字入检查集；空白归一", () => {
    expect(VERBATIM_FRAGMENT_MIN_CHARS).toBe(12);
    const frags = l1VerbatimFragments(`第一句。${L1_A}短句`);
    expect(frags).toContain("在交付之前我一定会先跑全量测试确认没有回归");
    expect(frags).not.toContain("短句");
    expect(frags.some((f) => f.includes("这是雷打不动的习惯"))).toBe(false); // 9 字 < 12 → 不过阈值
  });

  it("去原文：提案逐字包含 ≥12 字 L1 句 → 命中并返回碎片；转述不命中", () => {
    const hit = findVerbatimL1Fragment(
      "我发现他的模式：在交付之前我一定会先跑全量测试确认没有回归。值得内化。",
      [L1_A, L1_B],
    );
    expect(hit).toBe("在交付之前我一定会先跑全量测试确认没有回归");
    expect(findVerbatimL1Fragment("他坚持交付前做全量回归验证，宁慢勿漏。", [L1_A, L1_B])).toBeNull();
  });

  it("vet 全链：白名单→空内容→超长→无证据→去原文，逐层裁决", () => {
    const base = { slot: "self_identity", content: "他坚持先取证再动手。", evidenceRecordIds: ["r1"], evidenceContents: [L1_A] };
    expect(vetReflectionIdentityProposal(base)).toMatchObject({ ok: true });
    expect(vetReflectionIdentityProposal({ ...base, slot: "strict_rule" })).toMatchObject({ ok: false, reason: expect.stringContaining("slot-not-allowed") });
    expect(vetReflectionIdentityProposal({ ...base, content: "   " })).toMatchObject({ ok: false, reason: "empty-content" });
    expect(vetReflectionIdentityProposal({ ...base, content: "长".repeat(201) })).toMatchObject({ ok: false, reason: "content-too-long" });
    expect(vetReflectionIdentityProposal({ ...base, evidenceRecordIds: [] })).toMatchObject({ ok: false, reason: "no-evidence" });
    expect(
      vetReflectionIdentityProposal({ ...base, content: `结论：${L1_A.slice(0, 22)}` }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("verbatim-l1") });
  });
});

describe("#27 桥接（runReflection 集成）", () => {
  const cleanRaw = JSON.stringify([{ question: "协作模式是什么？", conclusion: "他坚持交付前完成全量回归验证，宁慢勿漏。", evidence: ["r1", "r2"] }]);

  it("门 on + 干净结论 → 提案入轨（slot=self_identity，evidence=2，attrs 带 origin+证据指针）", async () => {
    const { deps, spies } = mkDeps({ llmRaw: cleanRaw, soulProposals: { enabled: true } });
    const res = await runReflection(deps as never);
    expect(res.cardsWritten).toBe(1);
    expect(res.proposalsPushed).toBe(1);
    expect(spies.upsertPendingCore).toHaveBeenCalledTimes(1);
    const [slot, content, evidence, tenant, extra] = spies.upsertPendingCore.mock.calls[0] as unknown[];
    expect(slot).toBe("self_identity");
    expect(content).toBe("他坚持交付前完成全量回归验证，宁慢勿漏。");
    expect(evidence).toBe(2);
    expect(tenant).toEqual({ teamId: "t", userId: "u", agentId: "a" });
    expect(extra).toMatchObject({ attrs: { origin: "reflection", evidence_record_ids: ["r1", "r2"] } });
  });

  it("提案逐字复述 L1 → 卡照写（结论卡是记忆）但提案被门拒", async () => {
    const raw = JSON.stringify([{ question: "q", conclusion: `模式记录：${L1_A.slice(0, 22)}，值得内化。`, evidence: ["r1"] }]);
    const { deps, spies } = mkDeps({ llmRaw: raw, soulProposals: { enabled: true } });
    const res = await runReflection(deps as never);
    expect(res.cardsWritten).toBe(1);
    expect(res.proposalsPushed).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("门 off（缺省）→ 零提案（config-first 逐位现状）", async () => {
    const { deps, spies } = mkDeps({ llmRaw: cleanRaw });
    const res = await runReflection(deps as never);
    expect(res.cardsWritten).toBe(1);
    expect(res.proposalsPushed ?? 0).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("重复抑制：在途 pending 同内容 → 拒推", async () => {
    const { deps, spies } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: true },
      store: { pendingRows: [{ pending_id: "p1", slot: "self_identity", content: "他坚持交付前完成全量回归验证，宁慢勿漏。", state: "pending" }] },
    });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed ?? 0).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("重复抑制：core 身份行已有同句 → 拒推", async () => {
    const { deps, spies } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: true },
      store: { coreRows: [{ slot: "self_identity", content: "既有事实。\n他坚持交付前完成全量回归验证，宁慢勿漏。" }] },
    });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed ?? 0).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("证据为空 → 不提案（证据指针双保险）", async () => {
    const raw = JSON.stringify([{ question: "q", conclusion: "无证据的断言不应入轨。", evidence: [] }]);
    const { deps, spies } = mkDeps({ llmRaw: raw, soulProposals: { enabled: true } });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed ?? 0).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });
});
