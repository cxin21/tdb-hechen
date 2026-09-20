/**
 * P0-F7（REG-REMAINING v7 审计轮）：searchL1ByCoreRefs 反查键族扩 personRefs。
 * spec §2.6"人物反查记忆（searchL1ByCoreRefs 同款）"+ §6 S6——人物锚证据链反查；
 * 旧实现 SQL/JS 双层只认 coreRefs → personRefs 反查死通道（R5 补池/工具路两消费方失效）。
 * identityRefs 不并入：20 字切片语义非 label，消费方=GROW-MAINT/F14（spec §4 明文）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";
import type { MemoryRecord, CoreTenant } from "./core/store/types.js";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

async function makeStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "p0f7-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), 0);
  await s.init();
  return s;
}
const T: CoreTenant = { teamId: "t", userId: "u", agentId: "a" };
function mkRecord(id: string, content: string): MemoryRecord {
  return {
    id, content, type: "episodic", priority: 0.5, certainty: "observed", scene_name: "s",
    source_message_ids: [], metadata: {}, timestamps: ["2026-09-17T00:00:00Z"],
    createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
    occurred_at: "2026-09-17T00:00:00Z", version: 0,
    sessionKey: "k", sessionId: "s", teamId: "t", userId: "u", agentId: "a",
  } as unknown as MemoryRecord;
}

describe("P0-F7 反查键族扩 personRefs", () => {
  it("personRefs 命中 label → searchL1ByCoreRefs 返回该记录（旧口径仅 coreRefs = RED）", async () => {
    const s = await makeStore();
    expect(s.upsertL1(mkRecord("m1", "导师张三每周指导论文"), undefined)).toBe(true);
    expect(s.backfillMemoryRef?.("m1", "personRefs", "张三", T)).toBe(true);
    const hits = s.searchL1ByCoreRefs(["张三"], 10, undefined);
    expect(hits.map((h) => h.record_id)).toContain("m1");
  });

  it("coreRefs 命中不受影响（回归控制）", async () => {
    const s = await makeStore();
    expect(s.upsertL1(mkRecord("m2", "关于咖啡的品味记录"), undefined)).toBe(true);
    expect(s.backfillMemoryRef?.("m2", "coreRefs", "咖啡", T)).toBe(true);
    const hits = s.searchL1ByCoreRefs(["咖啡"], 10, undefined);
    expect(hits.map((h) => h.record_id)).toContain("m2");
  });
});
