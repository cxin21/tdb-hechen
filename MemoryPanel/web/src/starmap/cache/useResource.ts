/**
 * starmap/cache/useResource.ts — 把 `ResourceStore` 接到 React（S2b）
 *
 * 组件只描述「我要哪个 key、多久算新鲜、失败了旧值还能不能留」，
 * 不再自己写 `let alive = true` / `req++` 那套防竞态代码：key 一变就丢旧响应。
 * 先画旧值（peekAny）再刷新：宁可显示过期数据并在 UI 标「未刷新」，也不让页面闪成空白。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { starmapStore } from './apiCache';
import type { Lane } from './resources';

export interface UseResourceOptions<T> {
  /** null = 依赖还没就绪，不发请求。 */
  key: string | null;
  /** 取数函数。同一 key 的并发由 store 单飞，这里不会重复打。 */
  fetcher: () => Promise<T>;
  ttl: number;
  lane?: Lane;
  tags?: string[];
  enabled?: boolean;
}

export interface UseResourceState<T> {
  data?: T;
  error?: Error;
  /** true＝当前展示的是超过 ttl 的旧值（刷新失败时保留，UI 应标「未刷新」）。 */
  stale: boolean;
  loading: boolean;
  /** 上次成功写入的时间戳；0 = 从未成功。 */
  updatedAt: number;
  /** 手动重取（「重新读取」按钮）。 */
  reload: () => void;
}

export function useResource<T>(opts: UseResourceOptions<T>): UseResourceState<T> {
  const { key, fetcher, ttl, lane = 'read', tags, enabled = true } = opts;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<UseResourceState<T>, 'reload'>>(() => {
    const hit = key ? starmapStore.peekAny<T>(key) : undefined;
    return {
      data: hit?.data,
      error: hit?.error,
      stale: hit?.stale ?? false,
      loading: false,
      updatedAt: hit?.updatedAt ?? 0,
    };
  });
  const genRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

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
    void starmapStore
      .load<T>(key, () => fetcherRef.current(), { ttl, lane, tags: tagsRef.current, force: nonce > 0 })
      .then((res) => {
        if (gen !== genRef.current) return;
        setState({ data: res.data, error: res.error, stale: res.stale, loading: false, updatedAt: res.updatedAt });
      });
  }, [key, ttl, lane, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, reload };
}
