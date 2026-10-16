/**
 * #41（ADR0003-P3 实施票 C，2026-10-16）：promise 提案门 —— (c) LLM 提议通道（#27 范式镜像）。
 *
 * 合同（#41 票面 + ADR0003 D8「LLM 提议走 #27 提案门→pending→采纳，禁 LLM 直改」）：
 * 1. 提案目标仅限终态（open→kept/broken/withdrawn；PROMISE_TERMINAL_STATUSES 单一源）；
 *    目标 promise 必须存在且 status=open（终态 promise 不得被提案再迁移）。
 * 2. reason 安全阀：非空 ≤200 字（沿 REFLECTION_PROPOSAL_MAX_CHARS）且禁逐字包含 L1
 *    片段（句级 ≥12 字，空白归一——直接复用 #27 findVerbatimL1Fragment，禁第二实现）。
 * 3. vet 纯裁决零副作用：产出提案对象 ≠ 状态变更——LLM 输出在本仓内不存在任何直写
 *    promise 状态的代码路径；唯一写入口 = applyAdoptedPromiseTransition（人工采纳侧调用），
 *    恒 stamp source="proposal"（soul_promise_events.source 溯源）。
 * 4. 重复/竞态：store 返回 {ok:false}（已被证据通道先行迁移等）→ 透传不抛错（幂等收尾）。
 * 门 off 由上游（#27 提案调度面）承载；本模块为纯裁决 + 采纳 applier，无调度无 IO 例外。
 */
import { PROMISE_TERMINAL_STATUSES } from "./soul-promise.js";
import { findVerbatimL1Fragment, normalizeProposalText } from "../lifecycle/soul-reflection-proposals.js";

/** 提案 reason 安全阀（沿 #27 REFLECTION_PROPOSAL_MAX_CHARS 同值）。 */
export const PROMISE_PROPOSAL_MAX_REASON_CHARS = 200;

/** 提案可指向的终态（= PROMISE_TERMINAL_STATUSES 同集合，类型层收敛）。 */
export type PromiseTerminalTarget = (typeof PROMISE_TERMINAL_STATUSES)[number];

export interface PromiseTransitionProposal {
  promiseId: string;
  to: PromiseTerminalTarget;
  reason: string;
  attrs: { origin: "proposal"; refKey?: string };
}

export type PromiseProposalVerdict =
  | { ok: true; proposal: PromiseTransitionProposal }
  | { ok: false; reason: string };

/**
 * 单条提案全链裁决（确定性，按序短路）：
 * 目标终态 → promiseId 非空 → promise 存在且 open → reason 非空/长度 → 去 L1 逐字。
 */
export function vetPromiseTransitionProposal(
  input: { promiseId: string; to: string; reason: string },
  openPromises: readonly { promiseId: string; status: string; refKey?: string }[],
  l1Contents?: readonly (string | null | undefined)[],
): PromiseProposalVerdict {
  if (!(PROMISE_TERMINAL_STATUSES as readonly string[]).includes(input.to)) {
    return { ok: false, reason: `target-not-terminal:${input.to}` };
  }
  const promiseId = normalizeProposalText(input.promiseId);
  if (!promiseId) return { ok: false, reason: "empty-promise-id" };
  const target = openPromises.find((p) => p.promiseId === promiseId);
  if (!target || target.status !== "open") {
    return { ok: false, reason: `promise-not-open:${promiseId}` };
  }
  const reason = normalizeProposalText(input.reason);
  if (!reason) return { ok: false, reason: "empty-reason" };
  if (reason.length > PROMISE_PROPOSAL_MAX_REASON_CHARS) return { ok: false, reason: "reason-too-long" };
  if (l1Contents && l1Contents.length > 0) {
    const frag = findVerbatimL1Fragment(reason, l1Contents);
    if (frag) return { ok: false, reason: `verbatim-l1:${frag}` };
  }
  return {
    ok: true,
    proposal: {
      promiseId,
      to: input.to as PromiseTerminalTarget,
      reason,
      // 溯源 refKey 取自 store 行（不采信 LLM 输入的关联键——确定性来源）。
      attrs: { origin: "proposal", ...(target.refKey ? { refKey: target.refKey } : {}) },
    },
  };
}

/** 采纳侧最小结构面（与 IMemoryStore 可选方法同形）。 */
export interface PromiseAdoptionStoreFace {
  transitionSoulPromise?(tenant: unknown, promiseId: string, to: string, opts?: { at?: string; note?: string; source?: string }): unknown;
}

/**
 * 采纳 applier（人工采纳后唯一写入口）：transitionSoulPromise（source="proposal"，
 * note=[proposal] reason）。store 缺实现 → {ok:false, reason:"store-unsupported"}；
 * 业务拒绝透传 {ok:false}（竞态已被证据通道迁移等，幂等收尾不抛错）。
 */
export async function applyAdoptedPromiseTransition(
  store: PromiseAdoptionStoreFace | undefined,
  tenant: unknown,
  proposal: PromiseTransitionProposal,
): Promise<{ ok: boolean; promiseId: string; to: PromiseTerminalTarget; reason?: string }> {
  if (!store?.transitionSoulPromise) {
    return { ok: false, promiseId: proposal.promiseId, to: proposal.to, reason: "store-unsupported" };
  }
  const r = (await Promise.resolve(
    store.transitionSoulPromise(tenant, proposal.promiseId, proposal.to, {
      source: "proposal",
      note: `[proposal] ${proposal.reason}`,
    }),
  )) as { ok?: boolean; reason?: string } | undefined;
  if (r?.ok === true) return { ok: true, promiseId: proposal.promiseId, to: proposal.to };
  return { ok: false, promiseId: proposal.promiseId, to: proposal.to, reason: r?.reason ?? "transition-rejected" };
}
