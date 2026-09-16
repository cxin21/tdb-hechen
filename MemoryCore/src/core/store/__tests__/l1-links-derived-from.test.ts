/**
 * P4a-P2 层级边（REG-REMAINING-002 #1）：derived_from 跨层边 + 沿边反查。
 * 契约：addLink 幂等（ON CONFLICT 更新）；getLinksByTarget/getLinksBySource 对偶；
 * type 过滤互不串扰；invalidateL1 后沿边可定位受影响 scene block（精确失效传播）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-links-"));
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

const BLOCK_A = "profile:v1:aaaaaaaa";
const BLOCK_B = "profile:v1:bbbbbbbb";

describe("P4a-P2 derived_from 层级边", () => {
  it("建边后沿边反查：getLinksByTarget 命中 source 端（scene block）", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r1"), undefined);
    store.upsertL1(mkRecord("r2"), undefined);
    expect(store.addLink(BLOCK_A, "r1", "derived_from", 1)).toBe(true);
    expect(store.addLink(BLOCK_A, "r2", "derived_from", 1)).toBe(true);
    const back = store.getLinksByTarget("r1", "derived_from");
    expect(back).toHaveLength(1);
    expect(back[0].sourceId).toBe(BLOCK_A);
    expect(back[0].type).toBe("derived_from");
  });

  it("getLinksBySource 对偶：scene block 身世查询（由哪些 L1 蒸馏而来）", () => {
    const { store } = makeStore();
    store.addLink(BLOCK_B, "r9", "derived_from", 1);
    const out = store.getLinksBySource(BLOCK_B, "derived_from");
    expect(out.map((e) => e.targetId)).toEqual(["r9"]);
  });

  it("type 过滤互不串扰；同 (s,t,type) 幂等（重复建边不翻倍）", () => {
    const { store } = makeStore();
    store.addLink(BLOCK_A, "r1", "derived_from", 1);
    store.addLink("r2", "r1", "similar", 0.9);
    expect(store.getLinksByTarget("r1", "derived_from")).toHaveLength(1);
    expect(store.getLinksByTarget("r1", "similar")).toHaveLength(1);
    store.addLink(BLOCK_A, "r1", "derived_from", 1);
    expect(store.getLinksByTarget("r1", "derived_from")).toHaveLength(1);
  });

  it("失效传播定位：invalidateL1(r) 后 getLinksByTarget(r,'derived_from') 指向受影响块", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("r1"), undefined);
    store.addLink(BLOCK_A, "r1", "derived_from", 1);
    store.addLink(BLOCK_B, "r1", "derived_from", 1);
    expect(store.invalidateL1("r1", "2026-09-10T00:00:00.000Z")).toBe(true);
    const affected = store.getLinksByTarget("r1", "derived_from").map((e) => e.sourceId).sort();
    expect(affected).toEqual([BLOCK_A, BLOCK_B].sort());
  });

  it("行不存在时反查返回空数组（不抛错）", () => {
    const { store } = makeStore();
    expect(store.getLinksByTarget("ghost", "derived_from")).toEqual([]);
    expect(store.getLinksBySource("ghost")).toEqual([]);
  });
});
