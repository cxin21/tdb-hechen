/**
 * #41（ADR0003-P3 实施票 C，D8 提案门）· (c) LLM 提议通道测试（#27 范式镜像）。
 *
 * 合同（#41 票面验收 + ADR0003 D8）：
 * - 提案目标仅限终态（open→kept/broken/withdrawn）；open→open 拒绝；非法值拒绝；
 * - 目标 promise 必须存在且 status=open；
 * - reason 非空 ≤200 字（沿 REFLECTION_PROPOSAL_MAX_CHARS 安全阀）且禁逐字包含 L1
 *   片段（句级 ≥12 字，空白归一——复用 #27 findVerbatimL1Fragment）；
 * - vet 纯裁决零副作用：产出提案对象 ≠ 状态变更（LLM 直改路径结构性不存在）；
 * - 采纳侧唯一写路径 = applyAdoptedPromiseTransition，恒 stamp source="proposal"。
 */
import { describe, expect, it, vi } from "vitest";
import {
  PROMISE_PROPOSAL_MAX_REASON_CHARS,
  vetPromiseTransitionProposal,
  applyAdoptedPromiseTransition,
  vetPromiseCreationProposal,
  PROMISE_CREATION_MAX_CONTENT_CHARS,
} from "../soul-promise-proposal.js";

const openPromise = { promiseId: "pm_1", status: "open", refKey: "task-9" };

describe("#41 · vetPromiseTransitionProposal（纯裁决门）", () => {
  it("合法提案放行：目标终态 + open promise + reason 合规", () => {
    const v = vetPromiseTransitionProposal(
      { promiseId: "pm_1", to: "kept", reason: "证据链完整，工具回执确认交付" },
      [openPromise],
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.proposal).toMatchObject({ promiseId: "pm_1", to: "kept", attrs: { origin: "proposal", refKey: "task-9" } });
    }
  });

  it("目标非法：open→open / 非法值 / 空 promiseId 拒绝", () => {
    expect(vetPromiseTransitionProposal({ promiseId: "pm_1", to: "open", reason: "r" }, [openPromise]).ok).toBe(false);
    expect(vetPromiseTransitionProposal({ promiseId: "pm_1", to: "zombie", reason: "r" }, [openPromise]).ok).toBe(false);
    expect(vetPromiseTransitionProposal({ promiseId: "", to: "kept", reason: "r" }, [openPromise]).ok).toBe(false);
  });

  it("promise 缺失或非 open 拒绝（终态 promise 不得被提案再迁移）", () => {
    expect(vetPromiseTransitionProposal({ promiseId: "pm_x", to: "kept", reason: "r" }, [openPromise]).ok).toBe(false);
    expect(
      vetPromiseTransitionProposal({ promiseId: "pm_1", to: "broken", reason: "r" }, [
        { promiseId: "pm_1", status: "kept" },
      ]).ok,
    ).toBe(false);
    expect(vetPromiseTransitionProposal({ promiseId: "pm_1", to: "kept", reason: "r" }, []).ok).toBe(false);
  });

  it("reason 安全阀：空 / 超 200 字拒绝", () => {
    expect(vetPromiseTransitionProposal({ promiseId: "pm_1", to: "kept", reason: "   " }, [openPromise]).ok).toBe(false);
    expect(
      vetPromiseTransitionProposal({ promiseId: "pm_1", to: "kept", reason: "x".repeat(PROMISE_PROPOSAL_MAX_REASON_CHARS + 1) }, [openPromise]).ok,
    ).toBe(false);
  });

  it("reason 禁逐字 L1 片段（≥12 字句级碎片命中拒绝；短公共短语不误杀）", () => {
    const l1 = ["周五前必须交付 wiki 重跑报告并且附上全部探针用例"];
    expect(
      vetPromiseTransitionProposal(
        { promiseId: "pm_1", to: "kept", reason: "结论：周五前必须交付 wiki 重跑报告并且附上全部探针用例" },
        [openPromise],
        l1,
      ).ok,
    ).toBe(false);
    expect(
      vetPromiseTransitionProposal({ promiseId: "pm_1", to: "kept", reason: "工具回执显示任务已完成，验收通过" }, [openPromise], l1).ok,
    ).toBe(true);
  });
});

describe("#41 · 采纳侧唯一写路径（applyAdoptedPromiseTransition）", () => {
  it("恒 stamp source=proposal + note=[proposal] reason；store 结果透传", async () => {
    const transition = vi.fn(() => ({ ok: true }));
    const store = { transitionSoulPromise: transition };
    const result = await applyAdoptedPromiseTransition(store as never, { teamId: "t" }, {
      promiseId: "pm_1",
      to: "kept",
      reason: "人工采纳",
      attrs: { origin: "proposal" },
    });
    expect(result).toMatchObject({ ok: true, promiseId: "pm_1", to: "kept" });
    expect(transition).toHaveBeenCalledWith(
      { teamId: "t" },
      "pm_1",
      "kept",
      expect.objectContaining({ source: "proposal", note: expect.stringContaining("[proposal]") }),
    );
  });

  it("store 拒绝（竞态/非法迁移）→ ok:false 透传不抛错；store 缺实现 → store-unsupported", async () => {
    const result = await applyAdoptedPromiseTransition(
      { transitionSoulPromise: () => ({ ok: false, reason: "invalid-transition:kept->broken" }) } as never,
      {},
      { promiseId: "pm_1", to: "kept", reason: "r", attrs: { origin: "proposal" } },
    );
    expect(result).toMatchObject({ ok: false });
    const missing = await applyAdoptedPromiseTransition({} as never, {}, {
      promiseId: "pm_1",
      to: "kept",
      reason: "r",
      attrs: { origin: "proposal" },
    });
    expect(missing).toMatchObject({ ok: false, reason: "store-unsupported" });
  });
});

/**
 * D8 创建通道（2026-10-17）· vetPromiseCreationProposal（纯裁决门，镜像 vetPromiseTransitionProposal）。
 *
 * 合同（ADR0003 D8 + 实施票 ②）：
 * - content 非空且 ≤120 字（trim 后，PROMISE_CREATION_MAX_CONTENT_CHARS 安全阀）；
 * - 逐字门：content 与任一样本内容空白归一公共串 ≥12 字 → 拒（防提示注入持久化，#27/#44 同理据；
 *   12-gram 窗口精确判定——中段截取的逐字串同样命中，比句级 includes 更严）；
 * - 去重：与现有 open promise 内容全等或 pending promise_create 行内容全等（空白归一）→ 拒；
 * - 不设 refKey（创建不带关联；证据迁移通道按 refKey 严格相等工作，宁缺毋滥）；
 * - vet 纯裁决零副作用：返回 {ok:true, proposal:{content}} | {ok:false, reason}。
 */
describe("D8 创建通道 · vetPromiseCreationProposal（纯裁决门）", () => {
  const SAMPLES = ["推进顺利，本周继续联调"];

  it("合法创建过门：非空 ≤120、无逐字命中、无重复 → proposal.content 归一化且不带 refKey", () => {
    const v = vetPromiseCreationProposal(
      { content: "  下次先跑测试再合并  " },
      SAMPLES,
      [{ content: "我会交付报告" }],
      [{ slot: "promise_transition", state: "pending", content: "后续确认完成" }],
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.proposal.content).toBe("下次先跑测试再合并");
      expect("refKey" in v.proposal).toBe(false);
    }
  });

  it("content 安全阀：空白 / 空 / 超 120 字（trim 后）拒绝", () => {
    expect(vetPromiseCreationProposal({ content: "" }, SAMPLES, [], []).ok).toBe(false);
    expect(vetPromiseCreationProposal({ content: "   " }, SAMPLES, [], []).ok).toBe(false);
    expect(
      vetPromiseCreationProposal(
        { content: `前缀${"x".repeat(PROMISE_CREATION_MAX_CONTENT_CHARS)}` },
        SAMPLES,
        [],
        [],
      ).ok,
    ).toBe(false);
  });

  it("逐字门：与样本公共串 ≥12 字拒绝；短公共短语（<12 字）不误杀", () => {
    const sample = ["周五前必须交付 wiki 重跑报告并且附上全部探针用例"];
    expect(
      vetPromiseCreationProposal(
        { content: "已确认承诺：周五前必须交付 wiki 重跑报告并且附上全部探针用例" },
        sample,
        [],
        [],
      ).ok,
    ).toBe(false);
    // 「必须交付 wiki」= 9 字，未达 12 字阈值 → 放行
    expect(vetPromiseCreationProposal({ content: "必须交付 wiki 的清单" }, sample, [], []).ok).toBe(true);
  });

  it("逐字门（12-gram 精确判定）：中段截取 ≥12 字公共串命中，句级 includes 会漏判", () => {
    const sample = ["这是一段足够长的原始记忆内容用于逐字检测判定"];
    // content 不包含完整样本句（句级 includes 不命中），但中段公共串「段足够长的原始记忆内容用于逐字检测」= 17 字 ≥12
    expect(
      vetPromiseCreationProposal({ content: "结论：段足够长的原始记忆内容用于逐字检测" }, sample, [], []).ok,
    ).toBe(false);
  });

  it("去重：与 open promise 内容全等拒绝；与 pending promise_create 行内容全等拒绝（空白归一）", () => {
    expect(vetPromiseCreationProposal({ content: "我会交付报告" }, SAMPLES, [{ content: "我会交付报告" }], []).ok).toBe(false);
    expect(
      vetPromiseCreationProposal({ content: "我会交付报告" }, SAMPLES, [], [
        { slot: "promise_create", state: "pending", content: " 我会交付报告 " },
      ]).ok,
    ).toBe(false);
    // 去重只针对 pending promise_create 行：同内容的 pending promise_transition 行不拦截
    expect(
      vetPromiseCreationProposal({ content: "我会交付报告" }, SAMPLES, [], [
        { slot: "promise_transition", state: "pending", content: "我会交付报告" },
      ]).ok,
    ).toBe(true);
  });
});
