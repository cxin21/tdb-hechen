/**
 * F-CLUSTER v1（2026-09-26 自主拍板）：召回注入行同源折叠——内容驱动，零排序信号变更。
 *
 * 背景（真数据实锚，2026-09-26 探针）：
 * - 逐字重复簇成员间 similar 边零互通（HOP1_REACH_IN_CLUSTER 0/4）——dedup top-1 建边
 *   跨会话互不可见，边驱动聚簇在现有数据上不可行；
 * - 同 content 多源记忆（如「何晨是负责人」×5）在召回注入中逐行展开=「提取不简洁」的
 *   直接违反面（用户判据：记忆的提取要明确、简洁）。
 *
 * 折叠语义：stripMemoryLineMeta 内容口径逐字相同 → 保留首现行，行尾追加「·同源×n」计数。
 * 信息完整性：被折叠行不删除（源数可见，Panel 二期提供回溯视图）；排序/评分零变更。
 * 编排（调用点 auto-recall.ts 注入块）：先本函数（精确同文）→ 再 foldNearDuplicates
 * （近似 Jaccard，既有 A2 校准行为逐位不变）。
 */
import { stripMemoryLineMeta } from "./memory-line-meta.js";

const SAME_SOURCE_TAG = "·同源×";
const SOURCE_TAG = "·源×";

export function foldSameSourceDuplicates(lines: string[]): string[] {
  const firstIndexOf = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    const key = stripMemoryLineMeta(line);
    if (key === "") {
      // 空 strip 行（空串/纯元数据行）不参与折叠，原样保留（防无语义吞行）。
      out.push(line);
      continue;
    }
    const first = firstIndexOf.get(key);
    if (first === undefined) {
      firstIndexOf.set(key, out.length);
      out.push(line);
      continue;
    }
    const base = out[first] ?? "";
    const m = base.match(new RegExp(`${SAME_SOURCE_TAG}(\\d+)$`));
    if (m) {
      out[first] = base.replace(new RegExp(`${SAME_SOURCE_TAG}\\d+$`), `${SAME_SOURCE_TAG}${Number(m[1]) + 1}`);
    } else {
      out[first] = `${base} ${SAME_SOURCE_TAG}2`;
    }
  }
  return out;
}

/** 行折叠元数据：recordId=该行记忆 id；evidenceIds=该行（持续态）引用的证据源 id 列表。 */
export interface LineFoldMeta {
  recordId?: string;
  evidenceIds?: string[];
}

function appendTag(line: string, tag: string, n: number): string {
  const m = line.match(new RegExp(`${tag}(\\d+)$`));
  if (m) return line.replace(new RegExp(`${tag}\\d+$`), `${tag}${n}`);
  return `${line} ${tag}${n}`;
}

/**
 * v2：持续态优先折叠（数据源=work_fact.metadata_json.evidence_record_ids，生产在产 99.2%）。
 * 批内持续态行吸收其 evidenceIds 指向且同批在场的源行：源行移除，持续态行尾「·源×n」
 * （n=合并记忆总数含自身）。红线：不改行序；引用源不在批内/meta 缺失/自引用一律不折（宁漏勿错杀）。
 */
export function foldByDurative(lines: string[], metas?: (LineFoldMeta | undefined)[]): { lines: string[]; metas: (LineFoldMeta | undefined)[] } {
  if (!metas || metas.length !== lines.length) return { lines: [...lines], metas: metas ? [...metas] : [] };
  const sourceOwner = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    for (const sid of metas[i]?.evidenceIds ?? []) if (!sourceOwner.has(sid)) sourceOwner.set(sid, i);
  }
  const foldedInto = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const rid = metas[i]?.recordId;
    if (!rid) continue;
    const owner = sourceOwner.get(rid);
    if (owner !== undefined && owner !== i) foldedInto.set(i, owner);
  }
  const counts = new Map<number, number>();
  const out: string[] = [];
  const outMetas: (LineFoldMeta | undefined)[] = [];
  const outIndexOf = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const owner = foldedInto.get(i);
    if (owner !== undefined) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      continue;
    }
    outIndexOf.set(i, out.length);
    out.push(lines[i]!);
    outMetas.push(metas[i]);
  }
  for (const [owner, c] of counts) {
    const oi = outIndexOf.get(owner);
    if (oi !== undefined) out[oi] = appendTag(out[oi]!, SOURCE_TAG, c + 1);
  }
  return { lines: out, metas: outMetas };
}

/** 组合入口（调用点）：先持续态吸收（v2）→ 再同文折叠（v1）→ 近似 Jaccard 由调用点既有 foldNearDuplicates 续接。 */
export function foldClusterAware(lines: string[], metas?: (LineFoldMeta | undefined)[]): string[] {
  const dur = foldByDurative(lines, metas);
  return foldSameSourceDuplicates(dur.lines);
}
