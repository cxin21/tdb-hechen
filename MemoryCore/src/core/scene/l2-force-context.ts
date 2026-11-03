/**
 * A1 · L2 强制触发上下文（task-4）。
 *
 * 触发门（persona.l2Gate）默认会拦掉增量太小的 L2 轮次；但服务端手动触发
 * （运维排障、验收演练、强制重抽）必须能绕过它。force 不能靠参数一路透传
 * ——`core.runL2WithStore` 与 scheduler 的 L2Runner 签名不在本票改范围内，
 * 所以用 AsyncLocalStorage 表达「本轮是强制触发」：调用方在发起 L2 的
 * async 上下文里包一层 withL2Force，runner 内部同步读取即可。
 *
 * 范式与 `src/api-trace/api-request-context.ts` 一致（Node 内置模块，无新依赖）。
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface L2ForceContext {
  force: true;
}

const l2ForceStorage = new AsyncLocalStorage<L2ForceContext>();

/**
 * 在强制上下文中执行 fn：其内部发起的任意 L2 runner 调用都会绕过触发门。
 * 返回 fn 的 Promise，执行结束后上下文自动复原（不泄漏到并发轮次）。
 */
export function withL2Force<T>(fn: () => Promise<T>): Promise<T> {
  return l2ForceStorage.run({ force: true }, fn);
}

/** 当前 async 上下文是否处于强制触发（缺省 false = 按门决策）。 */
export function isL2ForceRequested(): boolean {
  return l2ForceStorage.getStore()?.force === true;
}
