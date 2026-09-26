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
