/**
 * RelatedSection —— 关联区组件（U-A3，DS-PANEL-UI-VISUAL-001 §2 S2「灵魂解剖面板」拆分）。
 *
 * 职责：单条 L1 的关联记忆视图 = 邻接列表（现状迁移，行为不变）+ 🔗 getPath 两节点
 * 关联链（新数据源接入：/v3/atomic/path 经 BFF /chat-memory/path 透传，C6 生产路由）。
 *
 * 交互：点「🔗 相关记忆」展开邻接列表（现状）；每个邻居行尾有「🔗链」入口 ——
 * 以当前条目为起点、该邻居为终点查 ≤3 跳最短路径，命中即把链上节点按
 * 边类型·强度依次可视化；path=null 如实显示"未找到关联链"（内核 store 未实现
 * getPath 时也是 null，不伪成功）。
 */
import { useState, useEffect, useMemo } from 'react';
import { chatMemoryApi } from '@/lib/teamApi';
import { createPathRequestController } from './path-request';
import type { PathState } from './path-request';

/** Phase 2（拍板③）：边类型着色白名单（与记忆图 EDGE_COLORS 同 hex；未知类型默认灰）。 */
const EDGE_CLS: Record<string, string> = { similar: 'similar', evolve: 'evolve', conflict: 'conflict', derived_from: 'derived_from', part_of: 'part_of', causal: 'causal' };
function edgeCls(t: string): string {
  return EDGE_CLS[t] ?? 'other';
}

export function RelatedSection({ blockId, itemId }: { blockId: string; itemId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [neighbors, setNeighbors] = useState<
    Array<{ id: string; type: string; strength?: number; content?: string }>
  >([]);
  const [path, setPath] = useState<PathState | null>(null);

  // 关联链查询控制器：请求令牌丢弃迟到响应 + 同邻居 toggle 收起（批 1 审查 Important）。
  // 竞态规则实现在 path-request.ts（框架无关），此处只做 React 接线。
  const pathCtrl = useMemo(
    () =>
      createPathRequestController((neighborId) =>
        chatMemoryApi.atomicPath(blockId, itemId, neighborId).then((res) => res.path),
      ),
    [blockId, itemId],
  );
  useEffect(() => pathCtrl.subscribe(setPath), [pathCtrl]);

  useEffect(() => {
    if (!open || neighbors.length > 0) return;
    let cancelled = false;
    setLoading(true);
    chatMemoryApi
      .neighbors(blockId, itemId, { maxN: 8 })
      .then((res) => {
        if (!cancelled) setNeighbors(res.neighbors ?? []);
      })
      .catch(() => {
        if (!cancelled) setNeighbors([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, blockId, itemId, neighbors.length]);

  /** 点「🔗链」：同邻居收起（toggle，loading 中再点即放弃在途请求），否则查关联链。 */
  function handleShowPath(neighborId: string) {
    void pathCtrl.toggle(neighborId);
  }

  return (
    <div className="_memory-detail-atomic-neighbors">
      <button type="button" className="_soul-chip _soul-chip--neighbors" onClick={() => setOpen((v) => !v)}>
        🔗 相关记忆{neighbors.length > 0 ? ` (${neighbors.length})` : ''}
      </button>
      {/* Phase 2：边类型图例（与记忆图配色一致；derived_from 绿为 Phase 2 增补） */}
      {open && (
        <div className="_nb-legend">
          <span><i className="_nb-dot" style={{ background: '#5b6bff' }} />similar</span>
          <span><i className="_nb-dot" style={{ background: '#1a9d63' }} />evolve</span>
          <span><i className="_nb-dot" style={{ background: '#e5484d' }} />conflict</span>
          <span><i className="_nb-dot" style={{ background: '#16a34a' }} />derived_from</span>
          <span><i className="_nb-dot" style={{ background: '#8b5cf6' }} />part_of</span>
        </div>
      )}
      {open && (
        <ul className="_memory-detail-atomic-neighbors-list">
          {loading ? (
            <li className="_nb-muted">加载中…</li>
          ) : neighbors.length === 0 ? (
            <li className="_nb-muted">无关联记忆</li>
          ) : (
            neighbors.map((n) => (
              <li key={n.id} className="_memory-detail-atomic-neighbor">
                <span className={`_nb-edge _nb-edge--${edgeCls(n.type)}`}>{n.type}</span>
                <span className="_nb-content">{n.content ?? n.id}</span>
                {typeof n.strength === 'number' ? (
                  <span className="_nb-strength">{n.strength.toFixed(1)}</span>
                ) : null}
                {/* 🔗链：当前条目 → 该邻居 的 getPath 关联链入口（U-A3 新数据源接入） */}
                <button
                  type="button"
                  className="_nb-pathlink"
                  title="查看两节点间的关联链（≤3 跳）"
                  onClick={() => void handleShowPath(n.id)}
                >
                  🔗链
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {path?.loading && <div className="_nb-muted">关联链查询中…</div>}
      {path && !path.loading && path.failed && <div className="_nb-muted">关联链查询失败</div>}
      {path && !path.loading && !path.failed && path.chain !== null && path.chain.length > 0 && (
        <div className="_nb-path">
          <div className="_nb-path-title">关联链（{path.chain.length} 节点）</div>
          <ol className="_nb-path-list">
            {path.chain.map((node, i) => (
              <li key={`${node.id}-${i}`} className="_nb-path-node">
                <span className={`_nb-edge _nb-edge--${edgeCls(node.type)}`}>
                  {node.type}
                  {typeof node.strength === 'number' ? ` · ${node.strength.toFixed(1)}` : ''}
                </span>
                <span className="_nb-path-content">{node.content ?? node.id}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {path && !path.loading && !path.failed && path.chain === null && (
        <div className="_nb-muted">未找到 ≤3 跳内的关联链</div>
      )}
    </div>
  );
}
