/**
 * P1-T9 假边清理（拍板②）：删除历史常量假强度的 similar 边。
 *
 * 背景：T9 修复前，attachTopCandidates 给 store 决策的 similar 边写死 strength
 *（向量召回 0.8 / FTS 召回 0.5）——均为伪造值（P-D：拿不到真值不造假值）。
 * T9 修复后：
 *   - 向量路径写真实 cosine（0..1；恰好等于 0.8/0.5 的概率≈0，如需复核可对照 created_at）
 *   - FTS-only 路径不再建 similar 边（宁缺毋滥）
 * 因此 strength ∈ {0.8, 0.5} 的 similar 边在本修复后不可能再产生，可安全清理。
 * 注意：merge/update/conflict 边的 strength=1（"关系存在"语义）不在清理范围。
 *
 * 判据：type='similar' AND (|strength-0.8|<1e-9 OR |strength-0.5|<1e-9)
 *（写入侧与查询侧同为 IEEE754 double，本可直等；容差仅为防御性）
 *
 * 用法：
 *   node --import tsx scripts/clean-fake-edges.ts [dbPath]            # dry-run（默认，只读打印命中行）
 *   node --import tsx scripts/clean-fake-edges.ts [dbPath] --apply    # 真删，输出删除计数
 * dbPath 缺省 = 生产库 D:/tdai-data/vectors.db（与 backfill-soul-fields.ts 一致）。
 * dry-run 以 readOnly 打开库，绝不写库。生产执行由队长在 M2 收口窗口做。
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB = "D:/tdai-data/vectors.db";
const EPS = 1e-9;

export interface FakeEdgeHit {
  source_id: string;
  target_id: string;
  strength: number;
  created_at: string;
}

export interface CleanResult {
  matched: number;
  deleted: number;
  hits: FakeEdgeHit[];
  applied: boolean;
}

const FAKE_EDGE_SQL =
  `SELECT source_id, target_id, strength, created_at FROM l1_links ` +
  `WHERE type = 'similar' AND (ABS(strength - 0.8) < ${EPS} OR ABS(strength - 0.5) < ${EPS})`;

/**
 * 清理假强度 similar 边。apply=false 时只读 dry-run（readOnly 打开，零写入）；
 * apply=true 时逐行按 (source_id, target_id, type, strength) 精确删除。
 */
export function cleanFakeEdges(dbPath: string, apply: boolean): CleanResult {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: !apply });
  try {
    const hits = db.prepare(FAKE_EDGE_SQL).all() as unknown as FakeEdgeHit[];
    if (!apply) {
      return { matched: hits.length, deleted: 0, hits, applied: false };
    }
    const del = db.prepare(
      `DELETE FROM l1_links WHERE source_id = ? AND target_id = ? AND type = 'similar' AND ABS(strength - ?) < ${EPS}`,
    );
    let deleted = 0;
    for (const h of hits) {
      deleted += Number(del.run(h.source_id, h.target_id, h.strength).changes);
    }
    return { matched: hits.length, deleted, hits, applied: true };
  } finally {
    db.close();
  }
}

function isDirectRun(): boolean {
  const arg = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!arg) return false;
  const self = fileURLToPath(import.meta.url);
  return arg === self || arg.replace(/\\/g, "/").endsWith("clean-fake-edges.ts");
}

if (isDirectRun()) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbArg = args.find((a) => !a.startsWith("--"));
  const dbPath = dbArg ?? DEFAULT_DB;
  console.log(`[clean-fake-edges] db=${dbPath} mode=${apply ? "APPLY（真删）" : "dry-run（只读）"}`);
  const r = cleanFakeEdges(dbPath, apply);
  for (const h of r.hits) {
    console.log(`  fake edge: ${h.source_id} -> ${h.target_id} strength=${h.strength} created_at=${h.created_at}`);
  }
  console.log(`matched=${r.matched} deleted=${r.deleted}`);
  process.exit(0);
}
