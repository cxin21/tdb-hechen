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
