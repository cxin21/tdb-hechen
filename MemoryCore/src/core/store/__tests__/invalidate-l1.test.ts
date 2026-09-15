/**
 * GROW-EVO P2 RED 套件：invalidateL1 失效回写（§2.2 写入方·存储层）。
 * 契约：只写 valid_end（失效不删除）；已失效行不覆盖（首次失效时间权威）；
 * 行不存在显式 false（同 bumpRecallCount 纪律）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invalidate-l1-"));
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

function readValidEnd(store: VectorStore, id: string): string | null {
  const row = (store as unknown as { queryL1Records: () => Array<{ record_id: string; valid_end: string | null }> })
    .queryL1Records()
    .find((r) => r.record_id === id);
  if (!row) throw new Error(`row missing: ${id}`);
  return row.valid_end;
}

describe("GROW-EVO P2 invalidateL1 失效回写", () => {
  it("失效后 valid_end 落库；再次 invalidate 不覆盖（返回 false）", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r1"), undefined);
    expect(store.invalidateL1("r1", "2026-09-10T00:00:00.000Z")).toBe(true);
    expect(readValidEnd(store, "r1")).toBe("2026-09-10T00:00:00.000Z");
    // 已失效行：二次失效不覆盖（首次失效时间权威）
    expect(store.invalidateL1("r1", "2026-09-12T00:00:00.000Z")).toBe(false);
    expect(readValidEnd(store, "r1")).toBe("2026-09-10T00:00:00.000Z");
  });

  it("行不存在 → 显式 false（不静默）", () => {
    const { store } = makeStore();
    expect(store.invalidateL1("nope", "2026-09-10T00:00:00.000Z")).toBe(false);
  });

  it("content 不变（失效不删除、不改写正文）", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r2"), undefined);
    store.invalidateL1("r2", "2026-09-10T00:00:00.000Z");
    const row = (store as unknown as { queryL1Records: () => Array<{ record_id: string; content: string }> })
      .queryL1Records().find((r) => r.record_id === "r2");
    expect(row?.content).toBe("条目 r2");
  });
});