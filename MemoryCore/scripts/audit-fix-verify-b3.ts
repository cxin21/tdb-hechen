/* 审计修复对抗性自审用 · B3 证据链回溯（sqlite store）——带逐步诊断 */
import { VectorStore } from "../src/core/store/sqlite.js";

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

const dbPath = `scripts/.audit-b3-${process.pid}-${Date.now()}.db`;
try { require("node:fs").rmSync(dbPath, { force: true }); require("node:fs").rmSync(dbPath + "-wal", { force: true }); require("node:fs").rmSync(dbPath + "-shm", { force: true }); } catch {}
const vs = new VectorStore(dbPath, 2, undefined);
await vs.init();

const old = mkRec("old-1", "旧证据：性能基线 2026-09-01 记录", "2026-09-01T00:00:00.000Z");
const nu = mkRec("new-1", "新结论：性能已优化 10 倍", "2026-09-05T00:00:00.000Z");

console.log("upsert old:", vs.upsertL1(old as any, undefined));
console.log("getL1 old:", vs.getL1ByIds(["old-1"]).length);
console.log("upsert new:", vs.upsertL1(nu as any, undefined));
console.log("addLink new->old:", vs.addLink("new-1", "old-1", "evolve", 1));
const arch = vs.archiveL1("old-1", "dedup-update");
console.log("archive old:", arch);
const withArc = vs.getL1ByIdsWithArchive(["old-1"]);
console.log("withArchive len:", withArc.length, "sample:", withArc[0]?.content);

check(!!vs.getL1ByIdsWithArchive, "getL1ByIdsWithArchive 存在");
check(arch === true, "archive 旧证据");
check(vs.getNeighbors("new-1")?.some((n) => n.id === "old-1"), "getNeighbors(new) 仍能通过边看到 old-1");
check(!vs.getL1ByIds(["old-1"]).length, "getL1ByIds(不含 archive) 查不到归档 old-1");
check(withArc.length === 1, "getL1ByIdsWithArchive 能从归档读回 old-1");
check(withArc[0]?.content.includes("性能基线"), "归档证据内容完整读回");

await vs.destroy?.();
try { require("node:fs").rmSync(dbPath, { force: true }); require("node:fs").rmSync(dbPath + "-wal", { force: true }); require("node:fs").rmSync(dbPath + "-shm", { force: true }); } catch {}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);