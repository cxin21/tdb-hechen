/**
 * #44（ADR0003 D8 · (c) LLM 提议通道调度面，2026-10-17）：reflection → promise 提案桥。
 *
 * 合同（D-44-1/D-44-2，#27 范式镜像）：
 * 1. 调度单一源：promiseProposals.enabled=true 时，同一 LLM 调用（reflection-l3）产出
 *    结论卡可附 promiseTransitions[]（promiseId/to/reason）——零新增 LLM 调用；
 *    prompt 仅当 gate on 且存在 open promise 时追加「在途承诺」段；gate off=提示词逐位现状，
 *    LLM 即便输出 promiseTransitions 也被忽略（零提案零写入）。
 * 2. 确定性门（复用 #41 vetPromiseTransitionProposal，禁第二实现）：目标终态白名单、
 *    promise 存在且 open（幻觉 id 拒）、reason 非空 ≤200、去 L1 逐字（防提示注入持久化）。
 * 3. 重复抑制：同 promiseId+to 已在途（listPendingCore slot=promise_transition attrs 匹配）→ 拒推。
 * 4. 提案落 pending 轨 slot="promise_transition"，attrs={promiseId,to,refKey?,origin:"reflection-promise"}；
 *    采纳侧（v2-router decide）唯一写入口，LLM 永不直写 promise 状态。
 * 5. store 缺 listSoulPromises（特性探测失败）→ 优雅跳过，反思主路径零影响。
 */
import { describe, expect, it, vi } from "vitest";
import { runReflection } from "../reflection.js";
import type { Logger } from "../../types.js";

const LOG = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

const NOW = "2026-09-18T00:00:00.000Z";
const rec = (id: string, content: string, significance: number): Record<string, unknown> => ({
  id,
  content,
  type: "observation",
  significance,
  createdAt: NOW,
  updatedAt: NOW,
  teamId: "t1",
  userId: "u1",
  agentId: "a1",
});

const TRIPLE = { teamId: "t1", userId: "u1", agentId: "a1" };

function mkStore(over: Record<string, unknown> = {}) {
  return {
    upsertL1: vi.fn(() => true),
    upsertPendingCore: vi.fn(() => true),
    listPendingCore: vi.fn(async () => [] as Array<Record<string, unknown>>),
    listSoulPromises: vi.fn(async () => [{ promiseId: "pm_1", content: "我会交付报告", status: "open", refKey: "t-9" }]),
    ...over,
  };
}

/** 卡片 JSON：带一条 promiseTransitions 提议。 */
const cardWithTransition = (reason: string) =>
  JSON.stringify([
    { question: "q", conclusion: "结论甲", evidence: ["r1"], promiseTransitions: [{ promiseId: "pm_1", to: "kept", reason }] },
  ]);

describe("#44 · reflection → promise 提案桥（D-44-1 调度面）", () => {
  it("gate on + open promise：prompt 含在途承诺段；提议过门→pending 落 promise_transition 轨；返回 promiseProposalsPushed=1", async () => {
    const store = mkStore();
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.triggered).toBe(1);
    expect(res.promiseProposalsPushed).toBe(1);
    expect(store.listSoulPromises).toHaveBeenCalledWith(TRIPLE, { status: "open" });
    const prompt = String((llmRunner.run.mock.calls[0] as unknown[])[0] !== undefined ? ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt: string }).prompt : "");
    expect(prompt).toContain("在途承诺");
    expect(prompt).toContain("pm_1");
    expect(store.upsertPendingCore).toHaveBeenCalledWith(
      "promise_transition",
      "后续对话确认报告已交付完成",
      1,
      TRIPLE,
      { attrs: { promiseId: "pm_1", to: "kept", refKey: "t-9", origin: "reflection-promise" } },
    );
  });

  it("gate off（缺省）：prompt 无在途承诺段；LLM 输出 promiseTransitions 被忽略（零写入零调用）", async () => {
    const store = mkStore();
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2 },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.cardsWritten).toBe(1);
    expect(res.promiseProposalsPushed).toBe(0);
    expect(store.listSoulPromises).not.toHaveBeenCalled();
    const prompt = String((llmRunner.run.mock.calls[0] as unknown[])[0] !== undefined ? ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt: string }).prompt : "");
    expect(prompt).not.toContain("在途承诺");
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("幻觉 promiseId（不在 open 清单）→ vet 拒，不落轨", async () => {
    const store = mkStore();
    const llmRunner = {
      run: vi.fn(async () =>
        JSON.stringify([
          { question: "q", conclusion: "结论乙", evidence: ["r1"], promiseTransitions: [{ promiseId: "pm_404", to: "kept", reason: "后续对话确认完成" }] },
        ]),
      ),
    };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("reason 逐字包含 L1 片段（提示注入面）→ 拒推", async () => {
    const store = mkStore();
    const llmRunner = { run: vi.fn(async () => cardWithTransition("这是一段足够长的原始记忆内容用于逐字检测判定")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "这是一段足够长的原始记忆内容用于逐字检测判定", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("重复抑制：同 promiseId+to 已在途 → 拒推", async () => {
    const store = mkStore({
      listPendingCore: vi.fn(async () => [
        { pending_id: "pd-1", slot: "promise_transition", content: "旧提案", state: "pending", attrs_json: JSON.stringify({ promiseId: "pm_1", to: "kept" }) },
      ]),
    });
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("store 缺 listSoulPromises（特性探测失败）→ 优雅跳过，反思主路径零影响", async () => {
    const store = mkStore({ listSoulPromises: undefined });
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.cardsWritten).toBe(1);
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });
});
