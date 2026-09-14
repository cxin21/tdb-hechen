/**
 * 批 1 审查 Important 修补 —— RelatedSection 关联链查询竞态回归测试。
 *
 * 竞态控制实现在 web/src/pages/ChatMemoryPage/components/block-detail/path-request.ts
 * （框架无关模块，组件直接消费），本测试驱动真实生产逻辑：
 *   1. 请求令牌：切换邻居 / 收起后，迟到的旧响应（含失败）必须被丢弃，不覆盖最新状态；
 *   2. toggle 语义：同邻居 loading 中再点 → 收起并作废在途请求，不重复发请求；
 *   3. 用 mock fetch 验证迟到响应在 fetch 层同样被丢弃（含 catch 分支）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPathRequestController } from '../web/src/pages/ChatMemoryPage/components/block-detail/path-request.js';
import type { PathNode } from '../web/src/pages/ChatMemoryPage/components/block-detail/path-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 手工放行的 Promise：模拟慢查询（迟到响应）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function chain(id: string): PathNode[] {
  return [{ id, type: 'relate', strength: 0.5, hop: 0 }];
}

describe('createPathRequestController 竞态规则', () => {
  it('正常流：发起 → 出链 → 再点同邻居收起（既有 toggle 语义）', async () => {
    const d = deferred<PathNode[] | null>();
    const ctrl = createPathRequestController(() => d.promise);

    void ctrl.toggle('a');
    expect(ctrl.state).toEqual({ neighborId: 'a', loading: true, chain: null, failed: false });

    d.resolve(chain('a'));
    await vi.waitFor(() => {
      expect(ctrl.state).toEqual({ neighborId: 'a', loading: false, chain: chain('a'), failed: false });
    });

    void ctrl.toggle('a');
    expect(ctrl.state).toBeNull();
  });

  it('同邻居 loading 中再点 → 立即收起，迟到响应被令牌丢弃（不重复发请求）', async () => {
    const d = deferred<PathNode[] | null>();
    const fetchPath = vi.fn(() => d.promise);
    const ctrl = createPathRequestController(fetchPath);

    void ctrl.toggle('a');
    expect(fetchPath).toHaveBeenCalledTimes(1);

    void ctrl.toggle('a'); // loading 中再点 = 收起，不再发第二次请求
    expect(ctrl.state).toBeNull();
    expect(fetchPath).toHaveBeenCalledTimes(1);

    d.resolve(chain('a')); // 迟到响应
    await d.promise.catch(() => {});
    // 等微任务排空：迟到响应若未被令牌拦截会覆盖 null
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ctrl.state).toBeNull();
  });

  it('快速切换 A→B：A 的迟到成功响应被丢弃，B 的结果生效', async () => {
    const da = deferred<PathNode[] | null>();
    const db = deferred<PathNode[] | null>();
    const byId: Record<string, typeof da | typeof db> = { a: da, b: db };
    const ctrl = createPathRequestController((id) => byId[id]!.promise);

    void ctrl.toggle('a');
    void ctrl.toggle('b');
    expect(ctrl.state?.neighborId).toBe('b');
    expect(ctrl.state?.loading).toBe(true);

    da.resolve(chain('a')); // A 迟到
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ctrl.state?.neighborId).toBe('b');
    expect(ctrl.state?.loading).toBe(true); // 未被 A 覆盖

    db.resolve(chain('b'));
    await vi.waitFor(() => {
      expect(ctrl.state).toEqual({ neighborId: 'b', loading: false, chain: chain('b'), failed: false });
    });
  });

  it('迟到的失败同样被丢弃：A 失败在 B 已发起后到达，不显示失败态', async () => {
    const da = deferred<PathNode[] | null>();
    const db = deferred<PathNode[] | null>();
    const byId: Record<string, typeof da | typeof db> = { a: da, b: db };
    const ctrl = createPathRequestController((id) => byId[id]!.promise);

    void ctrl.toggle('a');
    void ctrl.toggle('b');
    da.reject(new Error('slow-fail'));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ctrl.state?.neighborId).toBe('b');
    expect(ctrl.state?.failed).toBe(false);

    db.resolve(null); // path=null 如实缺省
    await vi.waitFor(() => {
      expect(ctrl.state).toEqual({ neighborId: 'b', loading: false, chain: null, failed: false });
    });
  });

  it('失败正常路径（无切换）：失败态如实展示', async () => {
    const d = deferred<PathNode[] | null>();
    const ctrl = createPathRequestController(() => d.promise);
    void ctrl.toggle('a');
    d.reject(new Error('boom'));
    await vi.waitFor(() => {
      expect(ctrl.state).toEqual({ neighborId: 'a', loading: false, chain: null, failed: true });
    });
  });

  it('mock fetch 端到端：收起后 fetch 层迟到响应同样被丢弃', async () => {
    const d = deferred<Response>();
    const fetchMock = vi.fn(() => d.promise);
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const ctrl = createPathRequestController(async (id) => {
      const res = await fetch(`https://bff.test/chat-memory/path?end=${id}`);
      const body = (await res.json()) as { path: PathNode[] | null };
      return body.path;
    });

    void ctrl.toggle('a');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    void ctrl.toggle('a'); // 收起 → 令牌作废在途请求
    expect(ctrl.state).toBeNull();

    d.resolve(
      new Response(JSON.stringify({ path: chain('a') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ctrl.state).toBeNull(); // fetch 层迟到响应未覆盖收起态
  });
});
