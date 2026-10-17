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

/**
 * #50（2026-10-17）：桥块 vet 证据集与快照新鲜度。
 * ③ verbatim 门证据集须含 promise 内容——LLM 可逐字抄 open promise 内容（≥12 字句级碎片）
 * 进 reason 绕过去 L1 拒推（与 #27 提示注入持久化同理据）；证据集 = sample L1 内容 ∪ promise 内容。
 * ④ openPromises 快照先于 LLM 调用拉取——调用期间 promise 被迁移 → vet 过期快照放行 →
 * 死 pending → 采纳 409；vet 前须重取 open 快照（重取缺实现/失败回退旧快照，不放大失败面）。
 */
describe("#50 · 桥块 vet 证据集与快照新鲜度", () => {
  it("③ reason 逐字含 open promise 内容片段（≥12 字）→ 拒推（RED：证据集缺 promise 内容时放行）", async () => {
    // promise 内容单句 20 字（≥VERBATIM_FRAGMENT_MIN_CHARS=12）；sample L1 内容 4 字（无句级碎片，
    // 不可能触发逐字门）——拒推只能来自证据集含 promise 内容。
    const PROMISE_CONTENT = "周五前交付灰度发布演练报告并回传验收结论";
    const store = mkStore({
      listSoulPromises: vi.fn(async () => [{ promiseId: "pm_1", content: PROMISE_CONTENT, status: "open", refKey: "t-9" }]),
    });
    const llmRunner = { run: vi.fn(async () => cardWithTransition(`已兑现：${PROMISE_CONTENT}`)) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "推进顺利", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("④ LLM 调用期间 promise 被迁移 → vet 前重取快照后拒推（RED：过期快照放行）", async () => {
    // 第 1 次调用（LLM 前快照）：pm_1 open；第 2 次调用（vet 前重取）：open 集已空（已被迁移）。
    const store = mkStore({
      listSoulPromises: vi
        .fn()
        .mockResolvedValueOnce([{ promiseId: "pm_1", content: "我会交付报告", status: "open", refKey: "t-9" }])
        .mockResolvedValueOnce([] as Array<Record<string, unknown>>),
    });
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "推进顺利", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(store.listSoulPromises).toHaveBeenCalledTimes(2);
    expect(res.promiseProposalsPushed).toBe(0);
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_transition");
  });

  it("④ 重取快照仍 open → 正常放行（防过杀回归锚）", async () => {
    // 每次调用都返回同一 open 集合（重取=仍 open）→ 提案正常入轨。
    const store = mkStore();
    const llmRunner = { run: vi.fn(async () => cardWithTransition("后续对话确认报告已交付完成")) };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "推进顺利", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseProposalsPushed).toBe(1);
    expect(store.upsertPendingCore).toHaveBeenCalledWith(
      "promise_transition",
      "后续对话确认报告已交付完成",
      1,
      TRIPLE,
      { attrs: { promiseId: "pm_1", to: "kept", refKey: "t-9", origin: "reflection-promise" } },
    );
  });
});

/**
 * D8 创建通道（2026-10-17）：reflection → promise_create 提案桥。
 *
 * 合同（ADR0003 D8 + 实施票 ③）：
 * - 同一 LLM 调用产出结论卡可附 promiseCreations[]（{content}）——零新增 LLM 调用；
 *   prompt 仅当 gate on 时追加创建指引段，且【不要求 open promise 存在】——第一条承诺就是从无到有；
 * - 确定性门（复用 vetPromiseCreationProposal，禁第二实现）：非空 ≤120、逐字 ≥12 拒、
 *   与 open promise / pending promise_create 全等拒（宁缺毋滥）；
 * - 提案落 pending 轨 slot="promise_create"，attrs={origin:"reflection-promise"}（创建不带 refKey）；
 *   返回新增 promiseCreationsPushed 计数；
 * - gate off=提示词无创建指引，LLM 即便输出 promiseCreations 也被忽略（零调用零写入）。
 */
describe("D8 创建通道 · reflection → promise_create 提案桥", () => {
  it("gate on + LLM 输出 promiseCreations → pending 落 promise_create 轨 + promiseCreationsPushed=1", async () => {
    const store = mkStore();
    const llmRunner = {
      run: vi.fn(async () =>
        JSON.stringify([{ question: "q", conclusion: "结论丙", evidence: ["r1"], promiseCreations: [{ content: "下次先跑测试再合并" }] }]),
      ),
    };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseCreationsPushed).toBe(1);
    expect(store.upsertPendingCore).toHaveBeenCalledWith(
      "promise_create",
      "下次先跑测试再合并",
      1,
      TRIPLE,
      { attrs: { origin: "reflection-promise" } },
    );
  });

  it("创建分支不要求 open promise 存在（第一条承诺从无到有）：openPromises=[] 仍入轨；prompt 有创建指引、无在途承诺段", async () => {
    const store = mkStore({ listSoulPromises: vi.fn(async () => [] as Array<Record<string, unknown>>) });
    const llmRunner = {
      run: vi.fn(async () =>
        JSON.stringify([{ question: "q", conclusion: "结论丁", evidence: ["r1"], promiseCreations: [{ content: "我会修复构建告警" }] }]),
      ),
    };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2, promiseProposals: { enabled: true } },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseCreationsPushed).toBe(1);
    const prompt = String(
      (llmRunner.run.mock.calls[0] as unknown[])[0] !== undefined
        ? ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt: string }).prompt
        : "",
    );
    expect(prompt).toContain("promiseCreations");
    expect(prompt).not.toContain("在途承诺");
  });

  it("gate off（缺省）：prompt 无创建指引；LLM 输出 promiseCreations 被忽略（零调用零写入）", async () => {
    const store = mkStore();
    const llmRunner = {
      run: vi.fn(async () =>
        JSON.stringify([{ question: "q", conclusion: "结论戊", evidence: ["r1"], promiseCreations: [{ content: "下次先跑测试再合并" }] }]),
      ),
    };
    const res = await runReflection({
      queryL1: async () => [rec("r1", "用户说周五要交付报告", 3)],
      config: { enabled: true, rRef: 2 },
      store: store as never,
      llmRunner,
      logger: LOG,
    });
    expect(res.promiseCreationsPushed).toBe(0);
    expect(store.listPendingCore).not.toHaveBeenCalled();
    const prompt = String(
      (llmRunner.run.mock.calls[0] as unknown[])[0] !== undefined
        ? ((llmRunner.run.mock.calls[0] as unknown[])[0] as { prompt: string }).prompt
        : "",
    );
    expect(prompt).not.toContain("promiseCreations");
    const slots = store.upsertPendingCore.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(slots).not.toContain("promise_create");
  });
});
