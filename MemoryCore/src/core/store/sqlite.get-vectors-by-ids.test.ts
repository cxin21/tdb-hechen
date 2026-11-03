/**
 * B1 修正（2026-11-02）：VectorStore.getL1VectorsByIds —— 按 id 批量读已入库向量。
 * 合同：返回 id→Float32Array（值逐个相等）；未知/未入库 id 不在 Map 里；空入参 → 空 Map；
 * 重复 id 去重；未就绪/degraded → 空 Map 且不抛。纯本地 sqlite（临时目录 + dims=8）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "./types.js";

const DIM = 8;
const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(dims = DIM): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "vec-by-ids-"));
  dirs.push(dir);
  const s = new VectorStore(join(dir, "v.db"), dims);
  stores.push(s);
  s.init();
  if (s.isDegraded()) throw new Error("临时库初始化降级（环境问题）");
  return s;
}

function rec(id: string): MemoryRecord {
  return {
    id,
    content: `内容-${id}`,
    type: "episodic",
    priority: 0.5,
    certainty: "observed",
    scene_name: "vec-by-ids",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-02T00:00:00Z"],
    createdAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    occurred_at: null,
    valid_start: null,
    valid_end: null,
    certainty_source: undefined,
    source: undefined,
    valence: null,
    arousal: null,
    significance: null,
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: "t",
    userId: "u",
    agentId: "a",
  } as unknown as MemoryRecord;
}

function vec(seed: number): Float32Array {
  return new Float32Array(Array.from({ length: DIM }, (_, i) => seed + i / 10));
}

describe("VectorStore.getL1VectorsByIds", () => {
  it("回读已入库向量，逐元素相等", () => {
    const s = makeStore();
    const v1 = vec(1);
    const v2 = vec(2);
    s.upsertL1(rec("r1"), v1);
    s.upsertL1(rec("r2"), v2);

    const got = s.getL1VectorsByIds(["r1", "r2"]);
    expect(got.size).toBe(2);
    expect(Array.from(got.get("r1")!)).toEqual(Array.from(v1));
    expect(Array.from(got.get("r2")!)).toEqual(Array.from(v2));
  });

  it("未知 id 不在 Map 里（不抛、不造零向量）", () => {
    const s = makeStore();
    s.upsertL1(rec("r1"), vec(1));
    const got = s.getL1VectorsByIds(["r1", "ghost"]);
    expect(Array.from(got.keys())).toEqual(["r1"]);
  });

  it("空入参与重复 id：空 Map / 去重后一条", () => {
    const s = makeStore();
    s.upsertL1(rec("r1"), vec(3));
    expect(s.getL1VectorsByIds([]).size).toBe(0);
    const got = s.getL1VectorsByIds(["r1", "r1", "r1"]);
    expect(got.size).toBe(1);
    expect(Array.from(got.get("r1")!)).toEqual(Array.from(vec(3)));
  });

  it("分片路径：跨 400 条边界仍全部命中", () => {
    const s = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 410; i++) {
      const id = `c${i}`;
      ids.push(id);
      s.upsertL1(rec(id), vec(i % 7));
    }
    const got = s.getL1VectorsByIds(ids);
    expect(got.size).toBe(410);
    expect(got.has("c409")).toBe(true);
  });
});
