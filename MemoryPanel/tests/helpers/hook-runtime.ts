/**
 * 极小 hooks 运行时（仅测试用）——web 组件/hook 的直测基线。
 *
 * 为什么自建、而不是装 jsdom + react-dom：
 *   - `MemoryPanel/web/package.json` 没有任何测试依赖（无 jsdom / happy-dom /
 *     @testing-library），仓内 `web/node_modules/.pnpm` 也找不到 DOM 实现；
 *   - 交付纪律禁止 `npm install`，因此无法引入渲染器。
 * 结论：用本文件的运行时直接调用 hook 函数（等价于「手工渲染」），验证 hook 自身的
 * 状态迁移 / effect 失效 / 监听与样式收尾；不覆盖 JSX 渲染与 DOM 事件系统。
 *
 * 用法（react 的 mock 必须按 web 侧真实解析出的绝对路径 doMock）：
 *   const webRequire = createRequire(fileURLToPath(new URL('../web/package.json', import.meta.url)));
 *   vi.doMock(webRequire.resolve('react'), async () => (await import('./helpers/hook-runtime')).fakeReactHooks);
 *   const { useMyHook } = await import('../web/src/.../useMyHook');
 *   const r = createHookRenderer(() => useMyHook(...));
 *   r.current.handleRefresh();
 *
 * 两个必须知道的 mock 坑（踩过，别重复）：
 *   1. `vi.mock('react')` / `vi.mock('@/...')` 在这里**无效**：测试文件位于
 *      `MemoryPanel/tests/`，自身解析不到 react 等依赖，而 `web/src` 的 import 由 Vite
 *      从 `MemoryPanel/web/node_modules` 解析 —— 键不同，等于没 mock。必须用
 *      `vi.doMock(绝对路径)`（react 用 `webRequire.resolve('react')`；web 内部模块用
 *      `fileURLToPath(new URL('../web/src/xxx.ts', import.meta.url))`），并在
 *      `beforeAll` 里、`await import` hook 之前调用（doMock 不 hoist）。
 *   2. `react-i18next` 的 require 入口是 `dist/commonjs`，而 Vite 走 `dist/es`：
 *      `webRequire.resolve('react-i18next')` mock 不上。要 mock
 *      `realpathSync(web/node_modules/react-i18next/dist/es/index.js)`；否则
 *      `useTranslation()` 真跑，报 `Cannot read properties of null (reading 'useContext')`。
 *      （同类：i18n 模块顶层读 `localStorage` / `navigator`，直测 web 模块前先 `vi.stubGlobal`，
 *      navigator 要给 `userAgent: 'node'`。）
 *
 * 语义约定（与 React 对齐的部分）：
 *   - 同一渲染内按调用顺序分配 slot，hook 调用顺序必须稳定（React 规则）；
 *   - setState 用 Object.is 判等，相同值不触发重渲染；
 *   - setState 同步 flush：调用方返回时视图已是最新（比 React 更严格，测试更好写）；
 *   - 一轮 effect 批（提交阶段）内触发的 setState 只标脏、不重入渲染，由外层 flush 循环
 *     再跑一轮 —— 与 React 的批处理一致，也避免「过期渲染的 effect 被重放」；
 *   - useEffect 按 deps 浅比较，重跑前先跑上一个 cleanup，unmount 时统一 cleanup；
 *   - deps 省略（undefined）= 每次渲染后都跑（与 React 一致）。
 * 不对齐的部分：没有并发/批处理/StrictMode 双调用，也没有 hooks 顺序变更检测。
 */

type Deps = readonly unknown[] | undefined;

interface MemoSlot {
  kind: string;
  deps: Deps;
  value: unknown;
}

interface EffectSlot {
  deps: Deps;
  cleanup?: () => void;
}

const MAX_RENDER_PASSES = 200;

class Runtime {
  private states: unknown[] = [];

  private refs: { current: unknown }[] = [];

  private memos: MemoSlot[] = [];

  private effectSlots: EffectSlot[] = [];

  private pendingEffects: { index: number; run: () => void | (() => void); deps: Deps }[] = [];

  private idx = 0;

  pending = false;

  private rendering = false;

  /** 正在跑 effect 批（提交阶段）。此时 setState 只标脏，不再重入 flush——
   *  否则外层批会继续跑「过期渲染」的 effect（React 里不存在这种重放）。 */
  private committing = false;

  private unmounted = false;

  result: unknown = undefined;

  constructor(private readonly useHook: () => unknown) {}

  // ── React API 子集 ──

  useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
    const i = this.idx++;
    if (!(i in this.states)) {
      this.states[i] = typeof initial === 'function' ? (initial as () => S)() : initial;
    }
    const setState = (next: S | ((prev: S) => S)) => {
      const value = typeof next === 'function' ? (next as (prev: S) => S)(this.states[i] as S) : next;
      if (Object.is(value, this.states[i])) return;
      this.states[i] = value;
      this.schedule();
    };
    return [this.states[i] as S, setState];
  }

  useRef<T>(initial: T): { current: T } {
    const i = this.idx++;
    if (!(i in this.refs)) this.refs[i] = { current: initial };
    return this.refs[i] as { current: T };
  }

  useMemo<T>(factory: () => T, deps: Deps): T {
    return this.memo('useMemo', factory, deps) as T;
  }

  useCallback<T>(fn: T, deps: Deps): T {
    return this.memo('useCallback', () => fn, deps) as T;
  }

  useEffect(run: () => void | (() => void), deps?: Deps): void {
    const i = this.idx++;
    const slot = this.effectSlots[i];
    // 只在 deps 浅比较相等时跳过；注意不能要求数组同一引用（每次渲染都是新数组字面量）。
    if (slot !== undefined && sameDeps(slot.deps, deps)) return;
    this.pendingEffects.push({ index: i, run, deps });
  }

  private memo(kind: string, factory: () => unknown, deps: Deps) {
    const i = this.idx++;
    const slot = this.memos[i];
    if (slot && slot.kind === kind && sameDeps(slot.deps, deps)) return slot.value;
    const value = factory();
    this.memos[i] = { kind, deps, value };
    return value;
  }

  // ── 渲染 / 收尾 ──

  private schedule(): void {
    this.pending = true;
    // 渲染中 / 提交 effect 中触发的更新，都交给外层 flush 循环续跑（与 React 的批处理对齐）。
    if (this.rendering || this.committing) return;
    this.flush();
  }

  flush(): void {
    let passes = 0;
    while (this.pending && !this.unmounted) {
      if (++passes > MAX_RENDER_PASSES) {
        throw new Error(
          'hook-runtime: 渲染 ' + MAX_RENDER_PASSES +
            ' 轮仍未收敛（effect 依赖可能每轮都变，检查 mock 是否返回了不稳定引用）',
        );
      }
      this.pending = false;
      this.renderOnce();
      this.runPendingEffects();
    }
  }

  private renderOnce(): void {
    this.idx = 0;
    this.pendingEffects = [];
    const prevActive = activeRuntime;
    activeRuntime = this;
    this.rendering = true;
    try {
      this.result = this.useHook();
    } finally {
      this.rendering = false;
      activeRuntime = prevActive;
    }
  }

  private runPendingEffects(): void {
    const batch = this.pendingEffects;
    this.pendingEffects = [];
    this.committing = true;
    try {
      for (const item of batch) {
        const slot = (this.effectSlots[item.index] ??= { deps: item.deps });
        if (slot.cleanup) slot.cleanup();
        const cleanup = item.run();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        slot.deps = item.deps;
      }
    } finally {
      this.committing = false;
    }
  }

  unmount(): void {
    this.unmounted = true;
    // effectSlots 是稀疏数组（只有真正用过 effect 的下标才有槽位），必须判空。
    for (let i = 0; i < this.effectSlots.length; i++) {
      const slot = this.effectSlots[i];
      if (slot?.cleanup) slot.cleanup();
      if (slot) slot.cleanup = undefined;
    }
  }
}

function sameDeps(a: Deps, b: Deps): boolean {
  if (a === b) return true; // 含两者皆 undefined 的情形
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

let activeRuntime: Runtime | null = null;

function requireRuntime(method: string): Runtime {
  if (!activeRuntime) {
    throw new Error('hook-runtime: ' + method + ' 只能在 createHookRenderer 的渲染过程中调用');
  }
  return activeRuntime;
}

export interface HookRenderer<T> {
  /** 最近一次渲染返回的 hook 结果 */
  readonly current: T;
  /** 强制重渲染（验证依赖不变时的行为） */
  rerender(): void;
  /** 卸载：跑所有 effect cleanup（验证监听/样式收尾） */
  unmount(): void;
}

export function createHookRenderer<T>(useHook: () => T): HookRenderer<T> {
  const runtime = new Runtime(useHook as () => unknown);
  runtime.pending = true;
  runtime.flush();
  return {
    get current() {
      return runtime.result as T;
    },
    rerender() {
      runtime.pending = true;
      runtime.flush();
    },
    unmount() {
      runtime.unmount();
    },
  };
}

/** 交给 vi.mock('react', () => fakeReactHooks) 的替身模块。 */
export const fakeReactHooks = {
  useState: <S>(initial: S | (() => S)) => requireRuntime('useState').useState(initial),
  useRef: <T>(initial: T) => requireRuntime('useRef').useRef(initial),
  useMemo: <T>(factory: () => T, deps: Deps) => requireRuntime('useMemo').useMemo(factory, deps),
  useCallback: <T>(fn: T, deps: Deps) => requireRuntime('useCallback').useCallback(fn, deps),
  useEffect: (run: () => void | (() => void), deps?: Deps) =>
    requireRuntime('useEffect').useEffect(run, deps),
};