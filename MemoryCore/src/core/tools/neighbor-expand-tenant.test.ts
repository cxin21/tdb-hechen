/**
 * P0-F2 硬化（REG-REMAINING v7 审计轮）：neighborExpand 扩展路径租户复核。
 * 旧实现 getNeighbors 未传 isolationFilter + resolveByIds 后无 rowMatchesIsolation 复核——
 * 同租户建边不变量下零行为差；一旦出现跨租户边（任何未来建边面）即泄漏进工具路结果。
 * 归档回流的产品开/关属 gated 拍板项，本修复不改变该语义，只补 T14 两步过滤同款防线。
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
  const dir = mkdtempSync(join(tmpdir(), "p0f2-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), 0);
  await s.init();
  return s;
}
function mk(id: string, content: string, team: string): MemoryRecord {
  return {
    id, content, type: "episodic", priority: 0.5, certainty: "observed", scene_name: "s",
    source_message_ids: [], metadata: {}, timestamps: ["2026-09-17T00:00:00Z"],
    createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
    occurred_at: "2026-09-17T00:00:00Z", version: 0,
    sessionKey: "k", sessionId: "s", teamId: team, userId: "u", agentId: "a",
  } as unknown as MemoryRecord;
}

describe("P0-F2 neighborExpand 租户复核", () => {
  it("跨租户邻居边不泄漏：t1 搜索结果不含 t2 邻居记录（RED：当前无复核）", async () => {
    const s = await makeStore();
    expect(s.upsertL1(mk("a1", "项目复盘会议记录与结论", "t1"), undefined)).toBe(true);
    expect(s.upsertL1(mk("b1", "租户B的私人日程与账目", "t2"), undefined)).toBe(true);
    expect(s.addLink("a1", "b1", "similar", 0.9)).toBe(true);
    const res = await executeMemorySearch({
      query: "项目复盘",
      limit: 5,
      vectorStore: s,
      filter: { teamId: "t1", userId: "u", agentId: "a" },
      neighborExpand: { enabled: true, maxHop: 1, maxAdd: 3 },
    });
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("b1");
  });
});
