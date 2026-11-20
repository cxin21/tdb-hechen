import { describe, expect, it } from 'vitest';
import { ResourceStore } from '../resources';

function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('ResourceStore', () => {
  it('ttl 内命中不重取，过期后重取一次', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };

    expect((await store.load('k', fetcher, { ttl: 100 })).data).toBe(1);
    c.advance(50);
    expect((await store.load('k', fetcher, { ttl: 100 })).data).toBe(1);
    expect(calls).toBe(1);

    c.advance(100);
    expect((await store.load('k', fetcher, { ttl: 100 })).data).toBe(2);
    expect(calls).toBe(2);
  });

  it('同 key 并发只发一次（单飞），三个调用拿到同一份数据', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now });
    let calls = 0;
    let release: (v: number) => void = () => {};
    const fetcher = () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const all = Promise.all([
      store.load('k', fetcher, { ttl: 1000 }),
      store.load('k', fetcher, { ttl: 1000 }),
      store.load('k', fetcher, { ttl: 1000 }),
    ]);
    await Promise.resolve();
    expect(calls).toBe(1);
    release(7);
    const results = await all;
    expect(results.map((r) => r.data)).toEqual([7, 7, 7]);
    expect(calls).toBe(1);
  });

  it('按 tag 失效后必须重取（正确性不靠 ttl）', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };

    await store.load('memory:a', fetcher, { ttl: 60_000, tags: ['memory:agent:a'] });
    await store.load('skills:a', fetcher, { ttl: 60_000, tags: ['skills:agent:a'] });
    expect(calls).toBe(2);

    expect(store.invalidate('memory:agent:a')).toBe(1);
    await store.load('memory:a', fetcher, { ttl: 60_000, tags: ['memory:agent:a'] });
    expect(calls).toBe(3);
    // 无关 tag 的条目不能被误伤
    await store.load('skills:a', fetcher, { ttl: 60_000, tags: ['skills:agent:a'] });
    expect(calls).toBe(3);
  });

  it('超出上限按最近使用淘汰，且不淘汰在途条目', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now, maxEntries: 2 });
    const fetch = (v: number) => async () => {
      c.advance(1);
      return v;
    };

    await store.load('k1', fetch(1), { ttl: 60_000 });
    await store.load('k2', fetch(2), { ttl: 60_000 });
    store.peek('k1', 60_000); // 让 k1 变成「最近使用」
    c.advance(1);
    await store.load('k3', fetch(3), { ttl: 60_000 });

    expect(store.snapshot().size).toBe(2);
    expect(store.peek('k1', 60_000)?.data).toBe(1);
    expect(store.peek('k2', 60_000)).toBeUndefined();
    expect(store.peek('k3', 60_000)?.data).toBe(3);
    expect(store.snapshot().evictions).toBe(1);
  });

  it('失败不清旧值：返回 stale 数据 + 错误', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now });
    await store.load('k', async () => 'good', { ttl: 10 });
    c.advance(100);

    const res = await store.load(
      'k',
      async () => {
        throw new Error('boom');
      },
      { ttl: 10 },
    );
    expect(res.data).toBe('good');
    expect(res.stale).toBe(true);
    expect(res.error?.message).toBe('boom');
    expect(store.peekAny('k')?.data).toBe('good');
  });

  it('从未成功过的失败只给错误，不伪造空数据', async () => {
    const store = new ResourceStore();
    const res = await store.load(
      'k',
      async () => {
        throw new Error('nope');
      },
      { ttl: 10 },
    );
    expect(res.data).toBeUndefined();
    expect(res.stale).toBe(false);
    expect(res.updatedAt).toBe(0);
    expect(res.error?.message).toBe('nope');
  });

  it('soul 泳道串行（并发恒为 1），read 泳道不超过 4', async () => {
    const store = new ResourceStore();
    let soulActive = 0;
    let soulMax = 0;
    const soulFetcher = () =>
      new Promise<void>((resolve) => {
        soulActive += 1;
        soulMax = Math.max(soulMax, soulActive);
        setTimeout(() => {
          soulActive -= 1;
          resolve();
        }, 1);
      });

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.load('s' + i, soulFetcher, { ttl: 1, lane: 'soul' })),
    );
    expect(soulMax).toBe(1);

    let readActive = 0;
    let readMax = 0;
    const readFetcher = () =>
      new Promise<void>((resolve) => {
        readActive += 1;
        readMax = Math.max(readMax, readActive);
        setTimeout(() => {
          readActive -= 1;
          resolve();
        }, 1);
      });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.load('r' + i, readFetcher, { ttl: 1, lane: 'read' })),
    );
    expect(readMax).toBe(4);
  });

  it('force 跳过 ttl；clear 清空', async () => {
    const c = clock();
    const store = new ResourceStore({ now: c.now });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };
    await store.load('k', fetcher, { ttl: 60_000 });
    await store.load('k', fetcher, { ttl: 60_000, force: true });
    expect(calls).toBe(2);

    store.clear();
    expect(store.snapshot().size).toBe(0);
    expect(store.peek('k', 60_000)).toBeUndefined();
  });

  /** S4：前缀失效给写操作总线用，必须只删命中的族，不误伤同前缀外的键。 */
  it('invalidatePrefix 只删前缀命中项', async () => {
    let t = 0;
    const store = new ResourceStore({ now: () => t });
    t = 1;
    const fetcher = async () => 1;
    await store.load('sc:u1:memory.layer:a', fetcher, { ttl: 60_000 });
    await store.load('sc:u1:memory.item:b', fetcher, { ttl: 60_000 });
    await store.load('sc:u1:wiki.graph:c', fetcher, { ttl: 60_000 });
    expect(store.snapshot().size).toBe(3);

    expect(store.invalidatePrefix('sc:u1:memory')).toBe(2);
    expect(store.snapshot().size).toBe(1);
    expect(store.peek('sc:u1:wiki.graph:c', 60_000)?.data).toBe(1);
    // 别的用户同一族不能被删
    await store.load('sc:u2:memory.layer:a', fetcher, { ttl: 60_000 });
    expect(store.invalidatePrefix('sc:u1:memory')).toBe(0);
    expect(store.snapshot().size).toBe(2);
  });
});
