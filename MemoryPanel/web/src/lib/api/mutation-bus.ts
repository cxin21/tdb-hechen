/**
 * lib/api/mutation-bus.ts — 写操作事件总线（S4）
 *
 * 为什么要有这个文件：星图缓存层（starmap/cache）需要「写成功之后立刻失效」，
 * 但 api 层不应该 import starmap（依赖方向反了）。所以 api 层只广播语义作用域，
 * 由缓存层自己订阅。api 层不知道有缓存存在，缓存层崩了也绝不能影响写操作。
 *
 * 作用域是**粗粒度**的：写操作往往只知道自己动了哪类资产，不知道受影响的全部缓存键。
 * 缓存层按前缀整片失效——比漏失效安全，代价是一次跨 agent 的重复取数。
 */

/** 一次写操作影响到的语义作用域。'all' 表示团队/agent 结构变了，什么都不能信。 */
export type MutationScope =
  | 'memory'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'persona'
  | 'team'
  | 'agents'
  | 'all';

type Listener = (scopes: MutationScope[]) => void;

const listeners = new Set<Listener>();

/** 订阅写操作。返回退订函数。主流程只会在缓存层订阅一次。 */
export function onMutation(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 广播一次写操作。调用点应在**写成功之后**才 emit —— 失败不失效，
 * 让缓存继续持有真实数据比拿旧数据当新数据安全。
 */
export function emitMutation(...scopes: MutationScope[]): void {
  const list = Array.from(new Set(scopes.filter(Boolean)));
  if (list.length === 0) return;
  for (const fn of Array.from(listeners)) {
    try {
      fn(list);
    } catch {
      /* 订阅方异常不得冒泡到写路径：缓存只是加速层，坏了也不能拦住写操作 */
    }
  }
}

/** 测试用：清空所有订阅（生产代码不调用）。 */
export function resetMutationBusForTest(): void {
  listeners.clear();
}
