/**
 * MemoryGraphView —— 记忆图（G）视图，复用团队 wiki 图谱同款组件栈：
 * Sigma (@react-sigma/core) + graphology + forceAtlas2（引用组件约定, 与 KnowledgeGraph 一致）。
 * 节点 = L1 记忆（size 随邻接数/重要度），边 = l1_links（颜色按边类型、粗细按 strength）。
 *
 * U-B1 语义通道（DS-PANEL-UI-VISUAL-001 §2 S3）：
 *   - 金色节点 = metadata.coreRefs 非空（挂着价值观锚）
 *   - 节点色相偏移 = valence（正偏绿 / 负偏红，最大 ±30°，见 memory-graph-semantic）
 *   - evolve / conflict 边带方向箭头（sigma v3 内置 'arrow' 程序，可用性已由
 *     tests/memory-graph-semantic.test.ts 对实际安装包做运行时断言）
 *   - 详情卡补 coreRefs chips / valence 双色条+方向 / recall_count（复用 soul-utils）
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Graph from 'graphology';
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { chatMemoryApi } from '@/lib/teamApi';
import type { AtomicItem } from '../constants/types';
import { buildSoulView } from './block-detail/soul-utils';
import { directedEdgeType, isDirectedKind, nodeSemanticColor, GOLD_CORE_REF_COLOR } from './memory-graph-semantic';

interface MemNode {
  id: string; label: string; type: string; linkCount: number; community: number; significance?: number; t: number;
  /** U-B1 语义通道：valence（色相偏移）与是否挂价值锚（金色） */
  valence?: number; hasCoreRefs: boolean;
}
interface MemEdge { source: string; target: string; weight: number; kind: string; }

const EDGE_KIND_COLOR: Record<string, string> = {
  similar: '#5b6bff', evolve: '#1a9d63', conflict: '#e5484d', causal: '#e8872a', part_of: '#8b5cf6',
};
function readTeaColor(token: string): string {
  try { return getComputedStyle(document.documentElement).getPropertyValue(token).trim(); } catch { return ''; }
}
function memNodeColor(isDurative: boolean): string {
  if (isDurative) return readTeaColor('--tea-color-bg-brand-default') || '#4f7cff';
  return readTeaColor('--tea-color-bg-warning-default') || '#5b6bff';
}

function ForceLayouter({ nodes, edges, onNodeClick, highlightNode }: {
  nodes: MemNode[]; edges: MemEdge[]; onNodeClick?: (n: string) => void; highlightNode?: string | null;
}) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const [hovered, setHovered] = useState<{ node: string; neighbors: Set<string> } | null>(null);

  useEffect(() => {
    const g = new Graph();
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1);
    const maxSig = Math.max(...nodes.map((n) => n.significance ?? 0), 0.1);
    for (const n of nodes) {
      const isDur = n.type === 'work_fact';
      const sig = (n.significance ?? 0.5) / maxSig;
      g.addNode(n.id, {
        // 时空网络：X 由 occurred_at 播种（时间从左→右流过），Y 交给力导向展开
        x: 12 + n.t * 76,
        y: 20 + Math.random() * 60,
        size: 6 + sig * 12 + Math.pow(n.linkCount / maxLinks, 0.6) * 5,
        color: memNodeColor(isDur),
        label: n.label,
        // U-B1 语义通道原始数据（nodeReducer 里再着色，hover 灰化仍可覆盖）
        valence: n.valence ?? null,
        hasCoreRefs: n.hasCoreRefs,
      });
    }
    for (const e of edges) {
      if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
      // 第二层无向去重（双保险）。M-6 双向异类边登记见 useMemo edgeList 处注释。
      const key = `${e.source}->${e.target}`;
      if (!g.hasEdge(key) && !g.hasEdge(`${e.target}->${e.source}`)) {
        // Sigma 的 type 是渲染程序选择器，只能传注册程序名——'line'/'arrow' 均为
        // sigma v3 内置注册（f53b173 教训：业务类型串 "similar" 等会抛 "could not
        // find a suitable program" 崩整图）。evolve/conflict 用内置 arrow（方向
        // 语义：邻接源头 → 邻接目标），其余语义仍由 EDGE_KIND_COLOR 颜色通道承载。
        g.addEdgeWithKey(key, e.source, e.target, {
          size: 0.5 + Math.min(e.weight, 1) * 1.6,
          color: EDGE_KIND_COLOR[e.kind] ?? '#8b8b98',
          type: directedEdgeType(e.kind),
        });
      }
    }
    const settings = forceAtlas2.inferSettings(g);
    forceAtlas2.assign(g, { iterations: 46, settings: { ...settings, gravity: 0.6, scalingRatio: 1.4, strongGravityMode: false } });
    loadGraph(g);
    sigma.refresh();
  }, [nodes, edges, loadGraph, sigma]);

  useEffect(() => {
    registerEvents({
      enterNode: (e) => { const g = sigma.getGraph(); setHovered({ node: e.node, neighbors: new Set(g.neighbors(e.node)) }); const c = sigma.getContainer(); if (c) c.style.cursor = 'pointer'; },
      leaveNode: () => { setHovered(null); const c = sigma.getContainer(); if (c) c.style.cursor = 'default'; },
      clickNode: (e) => onNodeClick?.(e.node),
    });
  }, [registerEvents, sigma, nodes, onNodeClick]);

  useEffect(() => {
    sigma.setSetting('nodeReducer', (node, data) => {
      const res = { ...data };
      // U-B1 语义着色：coreRefs 非空 → 金色；否则 valence 色相偏移（正绿/负红 ±30°）。
      // hover 灰化在后覆盖（语义色让位于焦点态）。
      res.color = nodeSemanticColor(data.color, {
        valence: typeof data.valence === 'number' ? data.valence : null,
        hasCoreRefs: !!data.hasCoreRefs,
      });
      if (highlightNode && node === highlightNode) { res.highlighted = true; res.zIndex = 2; }
      if (hovered) {
        if (node === hovered.node) { res.highlighted = true; res.zIndex = 2; res.size = (data.size || 7) * 1.3; }
        else if (hovered.neighbors.has(node)) { res.zIndex = 1; }
        else { res.color = '#d6d6de'; res.label = ''; res.zIndex = 0; }
      }
      return res;
    });
    sigma.refresh();
  }, [hovered, highlightNode, sigma]);

  return null;
}

function MemGraphControls() {
  const sigma = useSigma();
  const cls = "h-7 w-7 bg-card/90 hover:bg-card border border-border text-muted-foreground shadow-md rounded-md flex items-center justify-center transition-colors text-[12px] backdrop-blur";
  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
      <button type="button" aria-label="+" className={cls} onClick={() => sigma.getCamera().animatedZoom({ duration: 200 })}>+</button>
      <button type="button" aria-label="-" className={cls} onClick={() => sigma.getCamera().animatedUnzoom({ duration: 200 })}>−</button>
      <button type="button" aria-label="reset" className={cls} onClick={() => sigma.getCamera().animatedReset({ duration: 300 })}>⊙</button>
    </div>
  );
}

export function MemoryGraphView({ blockId, items }: { blockId?: string; items: AtomicItem[] }) {
  const [selected, setSelected] = useState<AtomicItem | null>(null);
  const [adj, setAdj] = useState<Record<string, Array<{ id: string; type: string; strength?: number; content?: string }>>>({});

  useEffect(() => {
    if (!blockId || items.length === 0) return;
    let cancelled = false;
    const nodes = items.slice(0, 60);
    Promise.all(
      nodes.map((n) => chatMemoryApi.neighbors(blockId, n.id, { maxN: 24 }).catch(() => ({ id: n.id, neighbors: [] as Array<{ id: string; type: string; strength?: number }> }))),
    ).then((res) => {
      if (cancelled) return;
      const m: Record<string, Array<{ id: string; type: string; strength?: number; content?: string }>> = {};
      res.forEach((r, i) => { m[nodes[i].id] = r.neighbors ?? []; });
      setAdj(m);
    });
    return () => { cancelled = true; };
  }, [blockId, items]);

  const { nodes, edges } = useMemo(() => {
    const visible = items.slice(0, 60);
    const ids = new Set(visible.map((it) => it.id));
    // 时间轴：以 occurred_at ?? valid_start ?? created_at 归一化到 [0,1]，供时空网络 X 播种
    const times = visible
      .map((it) => it.occurred_at ?? it.valid_start ?? it.created_at ?? '')
      .filter(Boolean)
      .map((s) => new Date(s).getTime())
      .filter((t) => !Number.isNaN(t));
    const tMin = times.length ? Math.min(...times) : 0;
    const tMax = times.length ? Math.max(...times) : 0;
    const tSpan = tMax > tMin ? tMax - tMin : 0;
    const nodeList: MemNode[] = visible.map((it) => {
      const ts = new Date(it.occurred_at ?? it.valid_start ?? it.created_at ?? '').getTime();
      const t = !Number.isNaN(ts) && tSpan > 0 ? (ts - tMin) / tSpan : 0.5;
      // U-B1 语义通道数据：soul-utils 同一套宽松解析（coreRefs 损坏/缺失 → []）
      const soul = buildSoulView(it);
      return {
        id: it.id,
        label: (it.body || it.title || it.id).slice(0, 36),
        type: it.title || 'episodic',
        linkCount: (adj[it.id] ?? []).length,
        community: 0,
        significance: it.significance,
        t,
        valence: soul.valence ?? undefined,
        hasCoreRefs: soul.coreRefs.length > 0,
      };
    });
    const edgeList: MemEdge[] = [];
    const seen = new Set<string>();
    Object.entries(adj).forEach(([src, nbs]) => {
      nbs.forEach((nb) => {
        if (!ids.has(nb.id)) return;
        // 批 2 审查 M-6（S7 第 7 项登记）：无向键去重——同对节点双向异类边（A→B similar
        // 先见、B→A evolve 后到）只保留先到方向，对向 evolve 箭头暂不渲染。
        // Sigma 行为已实证（S7）：graphology mixed 非多图可容纳双向两条边（size=2、均
        // directed），但双直线端点全重叠、后画者遮前画者——无曲线程序（@sigma/curve
        // 网络不可安装）下"双向各留一条"会引入同等的视觉丢失，故按宁缺毋滥取最小方案：
        // 不改渲染行为，图例注明（见下方 legend）。多实例部署解禁网络后随曲线程序一并重审。
        const k = [src, nb.id].sort().join('|');
        if (seen.has(k)) return;
        seen.add(k);
        edgeList.push({ source: src, target: nb.id, weight: nb.strength ?? 0.5, kind: nb.type });
      });
    });
    return { nodes: nodeList, edges: edgeList };
  }, [items, adj]);

  const bg = readTeaColor('--tea-color-bg-primary-default') || '#fff';
  const gridBg: CSSProperties = {
    background: bg,
    backgroundImage: 'linear-gradient(#eee 1px, transparent 1px), linear-gradient(90deg, #eee 1px, transparent 1px)',
    backgroundSize: '32px 32px',
  };

  return (
    <div className="relative flex flex-col overflow-hidden border border-border rounded-lg" style={{ background: bg, minHeight: 420 }}>
      <div className="flex-1 min-h-0 relative" style={gridBg}>
        <SigmaContainer
          style={{ width: '100%', height: 380, background: 'transparent' }}
          settings={{ allowInvalidContainer: true, renderLabels: true, labelFont: 'system-ui', labelSize: 12, defaultEdgeType: 'line', minCameraRatio: 0.06, maxCameraRatio: 4 }}
        >
          <ForceLayouter nodes={nodes} edges={edges} onNodeClick={(id) => setSelected(items.find((it) => it.id === id) ?? null)} highlightNode={selected?.id} />
          <MemGraphControls />
        </SigmaContainer>
      </div>
      {/* 图例（U-B1 扩展：金描边 / valence 色相 / 方向箭头） */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">节点色：蓝=点状 · 品牌色=持续态(work_fact) · <i className="inline-block w-2.5 h-2.5 rounded-full align-middle" style={{ background: GOLD_CORE_REF_COLOR }} /> 金=挂价值锚 · <i className="inline-block w-2.5 h-2.5 rounded-full align-middle" style={{ background: PERSON_REF_COLOR }} /> 青=人物关联 · 情感色相：<i className="inline-block w-2.5 h-2.5 rounded-full align-middle" style={{ background: nodeSemanticColor('#8b8b98', { valence: 1, hasCoreRefs: false }) }} />正偏绿 / <i className="inline-block w-2.5 h-2.5 rounded-full align-middle" style={{ background: nodeSemanticColor('#8b8b98', { valence: -1, hasCoreRefs: false }) }} />负偏红；边色：</span>
        {Object.entries(EDGE_KIND_COLOR).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1 text-xs text-muted-foreground">
            <i className="inline-block w-3 h-0.5 rounded" style={{ background: c }} />{k}{isDirectedKind(k) && <span title="evolve/conflict 边带方向箭头（源头 → 目标）">→</span>}
          </span>
        ))}
        <span className="text-xs text-muted-foreground/60">时间→  左早右晚（节点 X 按 occurred_at 播种）</span>
        <span className="text-xs text-muted-foreground/60" title="同对节点双向异类边仅渲染先到方向（对向箭头暂不渲染，M-6 登记）">双向异类边仅示先到方向</span>
        <span className="ml-auto text-xs text-muted-foreground">{nodes.length} 节点 · {edges.length} 边</span>
      </div>
      {selected && (() => {
        // U-B1 详情卡扩展：coreRefs 价值 chips / valence 双色条+方向 / recall_count
        //（soul-utils 同一套宽松解析，宁缺毋滥）
        const soul = buildSoulView(selected);
        const directionLabel =
          soul.valencePolarity === 'positive' ? '推进' : soul.valencePolarity === 'negative' ? '审慎' : '中性';
        return (
          <div className="_graph-detail">
            <div className="_graph-detail-close" onClick={() => setSelected(null)}>✕</div>
            <div className="_graph-detail-title">{selected.title}</div>
            <div className="_graph-detail-content">{selected.body}</div>
            <div className="_graph-detail-meta">
              {selected.occurred_at && <span>⏱ {selected.occurred_at}</span>}
              {selected.certainty && <span>{selected.certainty === 'inferred' ? '推断' : '实见'}</span>}
              {selected.significance != null && <span>重要 {selected.significance.toFixed(2)}</span>}
              {soul.valencePct !== null && (
                <span title={`情感方向：${directionLabel}`}>
                  <span className="_soul-valbar" aria-hidden>
                    <span className="_soul-valbar-mark" style={{ left: `${soul.valencePct}%` }} />
                  </span>
                  {(soul.valence ?? 0).toFixed(1)} · {directionLabel}
                </span>
              )}
              {soul.recallCount !== null && <span title="被回忆次数（重巩固统计）">🔥 {soul.recallCount} 次</span>}
            </div>
            {soul.coreRefs.length > 0 && (
              <div className="_graph-detail-meta">
                {soul.coreRefs.map((label) => (
                  <span key={label} title={`价值锚：${label}`} style={{ background: GOLD_CORE_REF_COLOR + '2e', borderColor: GOLD_CORE_REF_COLOR + '80' }}>
                    🎯 #{label}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}