/**
 * 审计 F5 验证：孤儿边 prune + deleteL1 级联删边 + restoreL1 FTS 重建（真实 sqlite store）。
 * 用法: node --import tsx scripts/audit-fix-verify-f5.ts
 */
import { VectorStore, buildFtsQuery } from "../src/core/store/sqlite.js";

let failed = 0;
function check(cond: boolean, msg: string) {
  if (!cond) { failed++; console.error("  ✗ " + msg); }
  else console.log("  ✓ " + msg);
}

function mkRec(id: string, content: string, occurrence?: string) {
  return {
    id, content, type: "episodic" as const, priority: 70, scene_name: "s",
    source_message_ids: [], metadata: {}, timestamps: [occurrence ?? new Date().toISOString()],
    occurred_at: occurrence, certainty: "observed" as const, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), version: 1, sessionKey: "k", sessionId: "sid",
  };
}

const dbPath = `scripts/.audit-f5-${process.pid}-${Date.now()}.db`;
const fs = await import("node:fs");
for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fs.rmSync(p, { force: true }); } catch {} }
const vs = new VectorStore(dbPath, 2, undefined);
await vs.init();

try {
  console.log("== F5.1 pruneOrphanLinks：删两端都消失的边，保留合法边 ==");
  vs.upsertL1(mkRec("a-1", "记忆A1", "2026-09-01T00:00:00.000Z") as never, undefined);
  vs.upsertL1(mkRec("a-2", "记忆A2", "2026-09-02T00:00:00.000Z") as never, undefined);
  // 孤儿边：ghost-a/ghost-b 不存在于任何表
  vs.addLink("ghost-a", "ghost-b", "similar", 1);
  // 合法边：a-1 -> a-2
  vs.addLink("a-1", "a-2", "evolve", 1);
  // 半孤儿边：a-2 -> ghost-x（target 不存在）→ 应被 prune（getNeighbors 会读到空气）
  vs.addLink("a-2", "ghost-x", "similar", 1);

  const pruned = (vs as unknown as { pruneOrphanLinks(): number }).pruneOrphanLinks();
  check("prune 删除 2 条（全孤儿+半孤儿）", pruned === 2);
  check("合法边保留", vs.getNeighbors("a-1").some((n) => n.id === "a-2"));
  check("半孤儿边已消失", !vs.getNeighbors("a-2").some((n) => n.id === "ghost-x"));
  const prunedAgain = (vs as unknown as { pruneOrphanLinks(): number }).pruneOrphanLinks();
  check("幂等：再 prune 返回 0", prunedAgain === 0);

  console.log("== F5.2 deleteL1 级联删边（硬删路径，图设计§5） ==");
  vs.upsertL1(mkRec("b-1", "记忆B1", "2026-09-03T00:00:00.000Z") as never, undefined);
  vs.upsertL1(mkRec("b-2", "记忆B2", "2026-09-04T00:00:00.000Z") as never, undefined);
  vs.addLink("b-1", "b-2", "similar", 1);
  check("建边成功", vs.getNeighbors("b-1").some((n) => n.id === "b-2"));
  vs.deleteL1("b-2");
  check("硬删 b-2 后边被级联删除", !vs.getNeighbors("b-1").some((n) => n.id === "b-2"));

  console.log("== F5.3 restoreL1 FTS 重建 ==");
  // 先 archive 一条（归档会删 FTS/向量），再 restore，检查 FTS 能搜回来
  const recC = mkRec("c-1", "FTS重建验证独特词 quarkxyz", "2026-09-05T00:00:00.000Z");
  vs.upsertL1(recC as never, undefined);
  const q = () => buildFtsQuery("quarkxyz");
  const run = () => { const f = q(); return f ? (vs as any).searchL1Fts(f, 5) : []; };
  const ftsHitBefore = run();
  vs.archiveL1("c-1", "forgetting-test");
  const ftsHitArchived = run();
  const restored = vs.restoreL1("c-1");
  const ftsHitAfter = run();
  check("restore 成功", restored === true);
  check("restore 后 getL1ByIds 可见", vs.getL1ByIds(["c-1"]).length === 1);
  check("archive 前 FTS 可搜到", Array.isArray(ftsHitBefore) && ftsHitBefore.length === 1);
  check("archive 后 FTS 不可搜到", Array.isArray(ftsHitArchived) && ftsHitArchived.length === 0);
  check("restore 后 FTS 重建可搜到", Array.isArray(ftsHitAfter) && ftsHitAfter.length === 1);
} finally {
  await vs.destroy?.();
  for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fs.rmSync(p, { force: true }); } catch {} }
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);