/**
 * cache/useApiResource.ts — 给「已经自己走缓存层」的资源用的 React 钩子
 *
 * 为什么不复用 useResource：useResource 自己会调 starmapStore.load(key, fetcher)，
 * 而 apiCache 的 fetchX 内部**又**调一次 store.load。soul 泳道并发上限是 1，
 * 于是外层占住唯一槽位、内层在队列里等外层结束 —— 死锁，loading 永远不结束。
 * （read 泳道上限 4，外 1 内 1 挤得下，所以只在 soul 上炸，之前没被发现。）
 *
 * 这个钩子只负责 React 侧的 loading / error / 先画旧值，排队与 TTL 全交给 apiCache 那一层。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { starmapStore } from './apiCache';
import type { ResourceResult } from './resources';

export interface UseApiResourceOptions<T> {
  /** 与 apiCache 里那份资源同一个 key（用于先画旧值）。null = 依赖没就绪，不发请求。 */
  key: string | null;
  /** 直接返回 apiCache 的 ResourceResult；不要在这里再套 store.load。
   *  force=true 表示这次要绕过 TTL 重取（reload() 时传）。 */
  run: (opts: { force: boolean }) => Promise<ResourceResult<T>>;
  enabled?: boolean;
}

export interface UseApiResourceState<T> {
  data?: T;
  error?: Error;
  stale: boolean;
  loading: boolean;
  updatedAt: number;
  reload: () => void;
}

export function useApiResource<T>(opts: UseApiResourceOptions<T>): UseApiResourceState<T> {
  const { key, run, enabled = true } = opts;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<UseApiResourceState<T>, 'reload'>>(() => {
    const hit = key ? starmapStore.peekAny<T>(key) : undefined;
    return { data: hit?.data, error: hit?.error, stale: hit?.stale ?? false, loading: false, updatedAt: hit?.updatedAt ?? 0 };
  });
  const genRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!key || !enabled) return;
    const gen = ++genRef.current;
    const hit = starmapStore.peekAny<T>(key);
    setState((s) => ({
      data: hit?.data ?? s.data,
      stale: hit?.stale ?? true,
      loading: true,
      updatedAt: hit?.updatedAt ?? 0,
      error: hit?.error,
    }));
    void runRef.current({ force: nonce > 0 }).then((res) => {
      if (gen !== genRef.current) return;
      setState({ data: res.data, error: res.error, stale: res.stale, loading: false, updatedAt: res.updatedAt });
    });
  }, [key, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}