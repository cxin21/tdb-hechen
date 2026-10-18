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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  soulProposals?: {
    enabled?: boolean;
    shadowCalibration?: { enabled?: boolean; file?: string };
    cardContract?: { enabled?: boolean };
  };
}) {
  const upsertPendingCore = vi.fn(async () => true);
  const warn = vi.fn();
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
      logger: { info: vi.fn(), warn, debug: vi.fn() },
    },
    spies: { upsertPendingCore, upsertL1, warn },
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

describe("ε shadow 定标（shadow calibration，ADR0003 D7）", () => {
  // 行为零变化：shadow 只是被判定提案的旁路 JSONL 记录（best verbatim overlap，供 ε 定量阈值定标）。
  const cleanRaw = JSON.stringify([{ question: "协作模式是什么？", conclusion: "他坚持交付前完成全量回归验证，宁慢勿漏。", evidence: ["r1", "r2"] }]);
  const verbatimRaw = JSON.stringify([{ question: "q", conclusion: `模式记录：${L1_A.slice(0, 22)}，值得内化。`, evidence: ["r1"] }]);

  function mkShadowDir(): string {
    return mkdtempSync(join(tmpdir(), "soul-shadow-"));
  }

  it("shadow on + 逐字重叠 → 追加一行 rejected（bestLen>0，缺失目录自动创建）", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "nested", "deeper", "shadow.jsonl"); // 父目录不存在 → 需 mkdir -p
    const { deps, spies } = mkDeps({
      llmRaw: verbatimRaw,
      soulProposals: { enabled: true, shadowCalibration: { enabled: true, file } },
    });
    try {
      const res = await runReflection(deps as never);
      expect(res.cardsWritten).toBe(1);
      expect(res.proposalsPushed).toBe(0); // 门仍拒绝：shadow 不改变判定
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(row.slot).toBe("self_identity");
      expect(row.verdict).toBe("rejected");
      expect(row.bestLen).toBeGreaterThanOrEqual(VERBATIM_FRAGMENT_MIN_CHARS);
      expect(row.verbatimGate).toBe(VERBATIM_FRAGMENT_MIN_CHARS);
      expect(Number.isNaN(Date.parse(String(row.ts)))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shadow on + 干净结论 → 追加 accepted 行且 bestLen=0", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "shadow.jsonl");
    const { deps } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: true, shadowCalibration: { enabled: true, file } },
    });
    try {
      await runReflection(deps as never);
      expect(existsSync(file)).toBe(true);
      const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]) as Record<string, unknown>;
      expect(row.verdict).toBe("accepted");
      expect(row.bestLen).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shadow enabled=false → 不产生文件（零旁路）", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "shadow.jsonl");
    const { deps, spies } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: true, shadowCalibration: { enabled: false, file } },
    });
    try {
      await runReflection(deps as never);
      expect(existsSync(file)).toBe(false);
      expect(spies.upsertPendingCore).toHaveBeenCalledTimes(1); // 门行为不受影响
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shadowCalibration.file 给了但 enabled 缺省 → 不产生文件", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "shadow.jsonl");
    const { deps } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: true, shadowCalibration: { file } },
    });
    try {
      await runReflection(deps as never);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("门 off（soulProposals.enabled=false）+ shadowCalibration.enabled=true → 零文件零提案", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "shadow.jsonl");
    const { deps, spies } = mkDeps({
      llmRaw: cleanRaw,
      soulProposals: { enabled: false, shadowCalibration: { enabled: true, file } },
    });
    try {
      await runReflection(deps as never);
      expect(existsSync(file)).toBe(false);
      expect(spies.upsertPendingCore).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shadow 开关不影响门判定（同输入 on/off 结果逐位一致）", async () => {
    const run = async (shadow: boolean) => {
      const dir = mkShadowDir();
      const file = join(dir, "shadow.jsonl");
      const { deps, spies } = mkDeps({
        llmRaw: verbatimRaw,
        soulProposals: { enabled: true, ...(shadow ? { shadowCalibration: { enabled: true, file } } : {}) },
      });
      try {
        const res = await runReflection(deps as never);
        const pendingCalls = spies.upsertPendingCore.mock.calls.length;
        const pendingContent = pendingCalls > 0 ? String((spies.upsertPendingCore.mock.calls[0] as unknown[])[1]) : "";
        return { cardsWritten: res.cardsWritten, proposalsPushed: res.proposalsPushed ?? 0, pendingCalls, pendingContent };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toEqual(off);
  });

  it("写失败（目标目录被同名文件占据）→ 流程不抛、提案照常入轨、每路径恰 warn 一次", async () => {
    const dir = mkShadowDir();
    const file = join(dir, "blocker", "shadow.jsonl");
    writeFileSync(join(dir, "blocker"), "occupied", "utf8"); // 该路径是文件不是目录 → mkdir 必失败
    const raw = JSON.stringify([
      { question: "q1", conclusion: "他坚持交付前完成全量回归验证，宁慢勿漏。", evidence: ["r1"] },
      { question: "q2", conclusion: "他宁可慢一点也不省掉全量回归。", evidence: ["r2"] },
    ]);
    const { deps, spies } = mkDeps({
      llmRaw: raw,
      soulProposals: { enabled: true, shadowCalibration: { enabled: true, file } },
    });
    const res = await runReflection(deps as never); // 不抛
    expect(res.proposalsPushed).toBe(2);
    expect(spies.upsertPendingCore).toHaveBeenCalledTimes(2);
    expect(spies.warn).toHaveBeenCalledTimes(1); // 同一文件路径只 warn 一次，随后静默降级
  });
});
describe("#60 产物契约门（cardContract，config-first 缺省关）", () => {
  const narrativeRaw = JSON.stringify([
    { question: "协作模式是什么？", conclusion: "我信奉根因优先：动手前先定位根因，再决定怎么修。", evidence: ["r1", "r2"] },
  ]);
  const fabricatedRaw = JSON.stringify([
    { question: "q", conclusion: "经过这轮排查，我现在感到整体链路已经稳定。", evidence: ["r1", "r2"] },
  ]);
  const noAnchorRaw = JSON.stringify([
    { question: "q", conclusion: "我宁可慢一点也不省掉全量回归。", evidence: ["r1", "r2"] },
  ]);

  it("契约 on + 伪造当下体验 → 拒推（卡照写，D6 机械门）", async () => {
    const { deps, spies } = mkDeps({ llmRaw: fabricatedRaw, soulProposals: { enabled: true, cardContract: { enabled: true } } });
    const res = await runReflection(deps as never);
    expect(res.cardsWritten).toBe(1);
    expect(res.proposalsPushed).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("契约 on + 合格叙事 + 锚引用 → 推进且 attrs.anchor_refs 命中 core_value label", async () => {
    const { deps, spies } = mkDeps({
      llmRaw: narrativeRaw,
      soulProposals: { enabled: true, cardContract: { enabled: true } },
      store: { coreRows: [{ slot: "core_value", content: "根因优先：先定位根因再动手。" }] },
    });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed).toBe(1);
    expect(spies.upsertPendingCore).toHaveBeenCalledTimes(1);
    const extra = (spies.upsertPendingCore.mock.calls[0] as unknown[])[4] as { attrs?: Record<string, unknown> };
    expect(extra.attrs).toMatchObject({ origin: "reflection", anchor_refs: ["根因优先"] });
  });

  it("契约 on + 合格叙事 + 锚集非空零引用 → no-anchor-ref 拒推", async () => {
    const { deps, spies } = mkDeps({
      llmRaw: noAnchorRaw,
      soulProposals: { enabled: true, cardContract: { enabled: true } },
      store: { coreRows: [{ slot: "core_value", content: "根因优先：先定位根因再动手。" }] },
    });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed).toBe(0);
    expect(spies.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("契约 on + 锚集缺失（readCore 空）→ 降级过，anchor_refs=[]", async () => {
    const { deps, spies } = mkDeps({ llmRaw: narrativeRaw, soulProposals: { enabled: true, cardContract: { enabled: true } } });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed).toBe(1);
    const extra = (spies.upsertPendingCore.mock.calls[0] as unknown[])[4] as { attrs?: Record<string, unknown> };
    expect(extra.attrs).toMatchObject({ anchor_refs: [] });
  });

  it("契约 off（缺省无 cardContract 键）+ 伪造当下体验 → 现状推（逐位现状）", async () => {
    const { deps, spies } = mkDeps({ llmRaw: fabricatedRaw, soulProposals: { enabled: true } });
    const res = await runReflection(deps as never);
    expect(res.proposalsPushed).toBe(1);
    expect(spies.upsertPendingCore).toHaveBeenCalledTimes(1);
  });
});
