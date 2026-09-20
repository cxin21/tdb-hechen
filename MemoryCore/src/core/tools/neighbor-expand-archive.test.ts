/**
 * 拍板①（P0-F2 处置 C：归档不回流）：
 * neighborExpand 邻居解析改 getL1ByIds（仅 l1_records 活跃表）——归档=软删（遗忘语义），
 * 图扩展不得复活已遗忘记忆；仅旧 store 无 getL1ByIds 时回退 WithArchive（行为逐位兼容）。
 * RED：当前 resolveByIds 优先 WithArchive → 归档邻居被复活进结果。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../store/sqlite.js";
import { executeMemorySearch } from "./memory-search.js";
import type { MemoryRecord } from "../store/types.js";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

async function makeStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "p0f2c-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), 0);
  await s.init();
  return s;
}
function mk(id: string, content: string): MemoryRecord {
  return {
    id, content, type: "episodic", priority: 0.5, certainty: "observed", scene_name: "s",
    source_message_ids: [], metadata: {}, timestamps: ["2026-09-17T00:00:00Z"],
    createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
    occurred_at: "2026-09-17T00:00:00Z", version: 0,
    sessionKey: "k", sessionId: "s", teamId: "t", userId: "u", agentId: "a",
  } as unknown as MemoryRecord;
}

describe("拍板① neighborExpand 归档不回流", () => {
  it("归档邻居不出现在图扩展结果（遗忘语义；RED：当前 WithArchive 优先会复活归档记录）", async () => {
    const s = await makeStore();
    expect(s.upsertL1(mk("a1", "项目复盘会议记录与结论"), undefined)).toBe(true);
    expect(s.upsertL1(mk("b2", "已遗忘的旧部署琐事记录"), undefined)).toBe(true);
    expect(s.addLink("a1", "b2", "similar", 0.9)).toBe(true);
    expect(s.archiveL1("b2", "forgetting")).toBe(true);
    const res = await executeMemorySearch({
      query: "项目复盘",
      limit: 5,
      vectorStore: s,
      filter: { teamId: "t", userId: "u", agentId: "a" },
      neighborExpand: { enabled: true, maxHop: 1, maxAdd: 3 },
    });
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("b2");
  });

  it("活跃邻居照常扩展（能力保留，回归控制）", async () => {
    const s = await makeStore();
    expect(s.upsertL1(mk("a1", "项目复盘会议记录与结论"), undefined)).toBe(true);
    expect(s.upsertL1(mk("c3", "复盘衍生的行动清单明细"), undefined)).toBe(true);
    expect(s.addLink("a1", "c3", "similar", 0.9)).toBe(true);
    const res = await executeMemorySearch({
      query: "项目复盘",
      limit: 5,
      vectorStore: s,
      filter: { teamId: "t", userId: "u", agentId: "a" },
      neighborExpand: { enabled: true, maxHop: 1, maxAdd: 3 },
    });
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain("c3");
  });
});
