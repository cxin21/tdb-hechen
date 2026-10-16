/**
 * #35（R5）：promise 承诺层——义务不是倾向（R4 立票、R5 对抗审查定稿）。
 *
 * 排除条款（防复用泛化，评审锚）：promise 不进 core_values 生命周期——
 * 无 reweight / decay / similarMerge / anchor-growth / 感受段渲染参与；
 * 承诺创设义务，锚描述倾向，二者不可互相替代。
 *
 * 状态机单向：open → kept | broken | withdrawn；终态无出边，同态迁移拒绝。
 * 判定权（谁宣布兑现/撤销：用户手动 or LLM 检测）= #33 D8 语义拍板，不在本层。
 * 双时态留痕：soul_promise_events 逐迁移 append（含创建事件 ∅→open），只增不改。
 *
 * 存储面：IMemoryStore 可选方法 upsertSoulPromise / transitionSoulPromise /
 * listSoulPromises / readSoulPromiseEvents（soul_promises + soul_promise_events，
 * F18 三元组隔离；sqlite 实现见 store/sqlite.ts）。
 * 本会话交付=数据层（表+API+状态机）；O13 提案入口复用、#37 变化时注入、
 * Panel 确认流 UI 为后续票（R5 拆票决定）。
 */
import type { SoulPromiseStatus } from "../store/types.js";

export const PROMISE_STATUSES = ["open", "kept", "broken", "withdrawn"] as const;

/** 终态集：离开 open 即定型，不可再迁（单向状态机的"不可逆"承诺语义）。 */
export const PROMISE_TERMINAL_STATUSES = ["kept", "broken", "withdrawn"] as const;

const PROMISE_EDGES: Readonly<Record<SoulPromiseStatus, readonly string[]>> = {
  open: PROMISE_TERMINAL_STATUSES,
  kept: [],
  broken: [],
  withdrawn: [],
};

/** 单向迁移判定：未知 from/to 一律 false（容错非法值，不抛）。 */
export function canTransitionPromise(from: SoulPromiseStatus, to: SoulPromiseStatus): boolean {
  return (PROMISE_EDGES[from] ?? []).includes(to);
}
