/**
 * useResizable 拖拽收尾的回归测试（#124-B4）。
 *
 * 票面 bug：endDrag 把 body.style.cursor / userSelect 直接置空串，会把宿主原有
 * 内联样式（嵌在 iframe / 外部布局里时）一起抹掉；且拖到窗口外松手时 window
 * 收不到 mouseup，拖拽态与样式永久卡住。
 * 本测试锁四件事：
 *   1. 拖拽中 body 样式被改成 col-resize / none；
 *   2. mouseup 后复原为**快照值**（宿主原有 cursor/userSelect），不是空串；
 *   3. window blur 也复原（mouseup 丢失时的兜底）；
 *   4. 卸载时复原并摘掉监听；未拖拽时 mouseup 不动样式。
 *
 * 环境说明：node 环境无 DOM，这里用 tests/helpers/hook-runtime.ts 的极小 hooks
 * 运行时替代 react，并用 vi.stubGlobal 铺一个只含 addEventListener/removeEventListener
 * 的 window 与 { body: { style } } 的 document —— 正好覆盖 hook 用到的全部 DOM 面。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHookRenderer } from './helpers/hook-runtime';

// web/src 里的 `import ... from 'react'` 由 Vite 从 web/node_modules 解析，而测试目录
// 自身解析不到 react —— 所以不能用 vi.mock('react')（键不同，等于没 mock）。
// 这里按 web 侧真实解析路径 doMock，保证 hook 模块拿到的是替身。
const webRequire = createRequire(fileURLToPath(new URL('../web/package.json', import.meta.url)));

type Listener = (event: any) => void;

let listeners: Record<string, Listener[]>;
let bodyStyle: { cursor: string; userSelect: string };
let useResizable: typeof import('../web/src/lib/useResizable').useResizable;

function fire(type: string, event: any = {}) {
  for (const fn of listeners[type] ?? []) fn(event);
}

function listenerCount(type: string) {
  return (listeners[type] ?? []).length;
}

beforeAll(async () => {
  vi.doMock(webRequire.resolve('react'), async () =>
    (await import('./helpers/hook-runtime')).fakeReactHooks,
  );
  ({ useResizable } = await import('../web/src/lib/useResizable'));
});

beforeEach(() => {
  listeners = {};
  bodyStyle = { cursor: 'grab', userSelect: 'text' }; // 宿主原本就有的内联样式
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((x) => x !== fn);
    },
  });
  vi.stubGlobal('document', { body: { style: bodyStyle } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mousedown = (hook: any, clientX: number) =>
  hook.current.onMouseDown({ preventDefault: () => {}, clientX });

describe('useResizable drag cleanup', () => {
  it('注册 mousemove / mouseup / blur 三个监听', () => {
    createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    expect(listenerCount('mousemove')).toBe(1);
    expect(listenerCount('mouseup')).toBe(1);
    expect(listenerCount('blur')).toBe(1);
  });

  it('mouseup 后复原为宿主快照值（不是空串）', () => {
    const r = createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    mousedown(r, 100);
    expect(bodyStyle).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    fire('mousemove', { clientX: 160 });
    expect(r.current.width).toBe(360);
    fire('mouseup');
    expect(bodyStyle).toEqual({ cursor: 'grab', userSelect: 'text' });
  });

  it('宿主样式为空串时复原仍是空串（不残留 col-resize）', () => {
    // 必须原地改（document.body.style 指向的是 beforeEach 里那个对象）
    bodyStyle.cursor = '';
    bodyStyle.userSelect = '';
    const r = createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    mousedown(r, 100);
    expect(bodyStyle.cursor).toBe('col-resize');
    fire('mouseup');
    expect(bodyStyle).toEqual({ cursor: '', userSelect: '' });
  });

  it('window blur（拖到窗口外松手收不到 mouseup）也复原', () => {
    const r = createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    mousedown(r, 100);
    fire('mousemove', { clientX: 120 });
    expect(r.current.width).toBe(320);
    fire('blur');
    expect(bodyStyle).toEqual({ cursor: 'grab', userSelect: 'text' });
    // 复原后继续移动不再改变宽度（拖拽态已结束）
    fire('mousemove', { clientX: 400 });
    expect(r.current.width).toBe(320);
  });

  it('拖拽中卸载也复原并摘掉监听', () => {
    const r = createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    mousedown(r, 100);
    expect(bodyStyle.cursor).toBe('col-resize');
    r.unmount();
    expect(bodyStyle).toEqual({ cursor: 'grab', userSelect: 'text' });
    expect(listenerCount('mousemove')).toBe(0);
    expect(listenerCount('mouseup')).toBe(0);
    expect(listenerCount('blur')).toBe(0);
  });

  it('未拖拽时 mouseup / blur 不动宿主样式', () => {
    createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    fire('mouseup');
    fire('blur');
    expect(bodyStyle).toEqual({ cursor: 'grab', userSelect: 'text' });
  });

  it('宽度按 min/max 夹紧；side=right 时反向', () => {
    const left = createHookRenderer(() => useResizable(300, 200, 500, 'left'));
    mousedown(left, 100);
    fire('mousemove', { clientX: 1000 });
    expect(left.current.width).toBe(500);
    fire('mousemove', { clientX: -500 });
    expect(left.current.width).toBe(200);
    fire('mouseup');

    const right = createHookRenderer(() => useResizable(300, 200, 500, 'right'));
    mousedown(right, 100);
    fire('mousemove', { clientX: 0 }); // 往左拖 = 右侧面板变宽
    expect(right.current.width).toBe(400);
    fire('mouseup');
    expect(bodyStyle).toEqual({ cursor: 'grab', userSelect: 'text' });
  });
});
