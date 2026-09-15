/**
 * GROW-EVO P1 RED 套件：bumpRecallCount touchUpdatedTime 选项。
 * 契约（DS-MEMORY-EVO-001 §6.2 债务②）：钩子路只加计数、不刷 updated_time——
 * 防扰动 ORDER BY updated_time 的既有排序；缺省（不传 opts）= 逐位现状。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-bump-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir };
}

const mkRecord = (id: string): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
  }) as MemoryRecord;

function readRow(store: VectorStore, id: string): { metadata_json: string; updated_time: string } {
  const row = (store as unknown as { queryL1Records: () => Array<{ record_id: string; metadata_json: string; updated_time: string }> })
    .queryL1Records()
    .find((r) => r.record_id === id);
  if (!row) throw new Error(`row missing: ${id}`);
  return row;
}

describe("GROW-EVO P1 bumpRecallCount touchUpdatedTime 选项", () => {
  it("缺省（不传 opts）= 逐位现状：计数 +1 且 updated_time 刷新", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r1"), undefined);
    const before = readRow(store, "r1").updated_time;
    expect(store.bumpRecallCount("r1", "2026-09-15T00:00:00.000Z")).toBe(true);
    const after = readRow(store, "r1");
    expect(JSON.parse(after.metadata_json).recall_count).toBe(1);
    expect(after.updated_time).not.toBe(before);
  });

  it("touchUpdatedTime:false 只加计数、不刷 updated_time", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r2"), undefined);
    const before = readRow(store, "r2").updated_time;
    expect(store.bumpRecallCount("r2", "2026-09-15T00:00:00.000Z", { touchUpdatedTime: false })).toBe(true);
    const after = readRow(store, "r2");
    expect(JSON.parse(after.metadata_json).recall_count).toBe(1);
    expect(JSON.parse(after.metadata_json).last_recalled_at).toBe("2026-09-15T00:00:00.000Z");
    expect(after.updated_time).toBe(before); // 关键断言
  });

  it("连续 false 两次：recall_count 累加到 2，updated_time 仍不动", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r3"), undefined);
    const before = readRow(store, "r3").updated_time;
    store.bumpRecallCount("r3", "2026-09-15T00:00:01.000Z", { touchUpdatedTime: false });
    store.bumpRecallCount("r3", "2026-09-15T00:00:02.000Z", { touchUpdatedTime: false });
    const after = readRow(store, "r3");
    expect(JSON.parse(after.metadata_json).recall_count).toBe(2);
    expect(after.updated_time).toBe(before);
  });
});