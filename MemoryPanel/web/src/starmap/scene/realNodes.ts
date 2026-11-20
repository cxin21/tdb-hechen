/**
 * starmap/scene/realNodes.ts — 画布上「真实小块」的取数
 *
 * 用户 m04975 明确要求：背景不许有假星点，只剩真星点构成星河。
 * 于是每朵云里每个资产（wiki 库 / 代码图）都要把自己真实的页/节点取回来，
 * 否则一个库就只剩一颗锚点星，画不出一条臂。
 *
 * 约束：
 *   - 只认缓存层的取数函数（同 key 命中，切回智能体不重打）。
 *   - 每个资产有上限，超了如实截断（左栏构成卡会标「已截断」）。
 *   - 任一个资产失败不阻断其余资产：失败的库就是没有块，不编。
 */
import { fetchCodeStructure, fetchWikiGraph } from '../cache/apiCache';
import type { CloudPoint } from '../data/overview';

/** 单个 wiki 库最多取多少页（真实块） */
export const WIKI_ASSET_CAP = 320;
/** 单张代码图最多取多少节点 */
export const CODE_ASSET_CAP = 420;

export type AssetPage = { id: string; label: string };
export type WikiWeb = { wikiId: string; pages: AssetPage[]; edges: [number, number][] };
export type CodeNodeLite = { id: string; label: string; kind: string };

const usable = (p: CloudPoint) => p.status === undefined || p.status === 'ready';

/** 每个 wiki 库的真实页 + 页间边（边来自 wiki graph，拿不到就只画页） */
export async function loadWikiWebs(points: CloudPoint[], force = false): Promise<Record<string, WikiWeb>> {
  const out: Record<string, WikiWeb> = {};
  for (const pt of points) {
    if (!usable(pt) || (pt.count ?? 0) <= 0) continue;
    const r = await fetchWikiGraph({ wikiId: pt.id, limit: WIKI_ASSET_CAP, offset: 0 }, { force });
    const g = r.data;
    if (!g) continue;
    const nodes = (g.nodes ?? []).slice(0, WIKI_ASSET_CAP);
    const idx = new Map<string, number>();
    const pages: AssetPage[] = nodes.map((n, i) => {
      idx.set(n.id, i);
      const label = (n.label || '').trim();
      return { id: n.id, label: label && label !== pt.label ? label : n.path || label || n.id };
    });
    const edges: [number, number][] = [];
    for (const e of g.edges ?? []) {
      const a = idx.get(e.source);
      const b = idx.get(e.target);
      if (a === undefined || b === undefined) continue;
      edges.push([a, b]);
      if (edges.length >= 1400) break;
    }
    out[pt.id] = { wikiId: pt.id, pages, edges };
  }
  return out;
}

/** 每张代码图的真实节点（文件/类/函数/方法） */
export async function loadCodeNodes(points: CloudPoint[], force = false): Promise<Record<string, CodeNodeLite[]>> {
  const out: Record<string, CodeNodeLite[]> = {};
  for (const pt of points) {
    if (!usable(pt) || (pt.count ?? 0) <= 0) continue;
    const r = await fetchCodeStructure({ codeGraphId: pt.id, kinds: [], limit: CODE_ASSET_CAP, offset: 0 }, { force });
    const g = r.data;
    if (!g) continue;
    out[pt.id] = (g.nodes ?? []).slice(0, CODE_ASSET_CAP).map((n) => ({
      id: n.id,
      label: n.name || n.qualifiedName || n.id,
      kind: n.kind,
    }));
  }
  return out;
}
