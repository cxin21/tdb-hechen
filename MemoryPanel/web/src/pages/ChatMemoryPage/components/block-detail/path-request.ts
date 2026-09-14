/**
 * path-request —— 关联链查询的竞态控制核心（批 1 审查 Important 修补）。
 *
 * 抽成框架无关模块的原因：Panel vitest 是 node 环境（无 jsdom / testing-library），
 * 无法直接挂载组件做交互断言；把「请求令牌 + toggle 收起」逻辑放在纯模块里，
 * 组件消费它，测试驱动它 —— 测的是真实生产逻辑而非复制品。
 *
 * 竞态规则：
 * 1. 请求令牌（seq）：每次发起新查询令牌 +1；响应回来若令牌已不是自己的（期间
 *    又点了别的邻居 / 已收起），直接丢弃，禁止迟到响应覆盖最新 UI 状态。
 * 2. toggle 收起：同邻居 loading 中再点 → 收起（置 null 并令牌 +1 使在途响应作废），
 *    不再重复发请求；同邻居已出结果再点 → 收起（既有语义保留）。
 */
import type { PathNode } from './path-types';

/** 单条关联链查询态：正在查哪条邻居、链结果、失败标记。 */
export interface PathState {
  neighborId: string;
  loading: boolean;
  chain: PathNode[] | null;
  failed: boolean;
}

/** 底层查询：入参邻居 id，出参链节点数组（链不存在时为 null，如实缺省）。 */
export type PathFetcher = (neighborId: string) => Promise<PathNode[] | null>;

export function createPathRequestController(fetchPath: PathFetcher) {
  /** 请求令牌：只增不减；任何使在途响应失效的动作都令其 +1。 */
  let seq = 0;
  let state: PathState | null = null;
  const listeners = new Set<(s: PathState | null) => void>();

  function setState(next: PathState | null) {
    state = next;
    listeners.forEach((l) => l(next));
  }

  function collapse() {
    seq += 1; // 在途响应（若有）令牌失配 → 迟到被丢弃
    setState(null);
  }

  /** 点「🔗链」的统一入口：同邻居收起（toggle），否则发起新查询。 */
  async function toggle(neighborId: string) {
    if (state?.neighborId === neighborId) {
      collapse(); // loading 中收起 = 放弃在途请求；已出结果收起 = 既有 toggle 语义
      return;
    }
    const my = ++seq;
    setState({ neighborId, loading: true, chain: null, failed: false });
    try {
      const chain = await fetchPath(neighborId);
      if (my !== seq) return; // 迟到响应：期间已有更新查询/收起，丢弃
      setState({ neighborId, loading: false, chain, failed: false });
    } catch {
      if (my !== seq) return; // 迟到的失败同样丢弃
      setState({ neighborId, loading: false, chain: null, failed: true });
    }
  }

  return {
    /** 当前状态（供 UI 渲染 / 测试断言）。 */
    get state() {
      return state;
    },
    toggle,
    /** 订阅状态变化，返回退订函数（组件用 useEffect 接 React state）。 */
    subscribe(listener: (s: PathState | null) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
