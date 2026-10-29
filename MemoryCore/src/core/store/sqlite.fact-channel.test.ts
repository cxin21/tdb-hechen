/**
 * #137 W1/C：事实键平行召回通道（sqlite）单测。
 *
 * 契约（IMemoryStore 可选方法，sqlite 实现）：
 *   - upsertL1FactVector(recordId, embedding, updatedTime?) → 写入/覆盖 l1_fact_vec 一行；
 *     零向量 / 空向量 / 维度不符 / 未就绪 / degraded → false（不写、不抛）。
 *   - searchL1FactVector(queryEmbedding, topK?, filter?) → 与 searchL1Vector 同形
 *     （score = 1 - cosine distance，metadata 从 l1_records 读，租户 filter 两步过滤）。
 *   - 原文主索引 l1_vec 完全不动：写 fact 通道不影响 searchL1Vector 结果。
 *   - deleteL1 / archiveL1 同步清事实通道（不留孤儿行）。
 *
 * 铁律：纯本地 sqlite（临时目录 + dims=8），离线可跑。
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

// Windows EBUSY：sqlite 句柄未关即 rmSync 会锁临时文件——afterEach 先 close 再删目录
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(dims = DIM): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "fact-channel-"));
  dirs.push(dir);
  const s = new VectorStore(join(dir, "v.db"), dims);
  stores.push(s);
  const res = s.init();
  if (s.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return s;
}

function mkRecord(
  id: string,
  content: string,
  tenant: { teamId?: string; userId?: string; agentId?: string } = {},
): MemoryRecord {
  return {
    id,
    content,
    type: "work_fact",
    priority: 0.5,
    certainty: "observed",
    scene_name: "fact-channel",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-10-27T00:00:00Z"],
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
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
    teamId: tenant.teamId ?? "t",
    userId: tenant.userId ?? "u",
    agentId: tenant.agentId ?? "a",
  } as unknown as MemoryRecord;
}

/** 8 维正交基向量（e_i），保证 cosine 有解析解：相同=1、正交=0。 */
const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

describe("#137 事实键平行向量通道（l1_fact_vec / sqlite）", () => {
  it("T1 写入 fact 向量后按事实键命中该行，score≈1；主索引 l1_vec 不受影响", () => {
    const s = makeStore();
    // 主向量与事实键向量刻意不同源：主索引继续用原文 embedding，fact 通道独立。
    expect(s.upsertL1(mkRecord("r1", "原文一"), basis(2))).toBe(true);
    expect(s.upsertL1(mkRecord("r2", "原文二"), basis(3))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(true);
    expect(s.upsertL1FactVector("r2", basis(1))).toBe(true);

    const hits = s.searchL1FactVector!(basis(0), 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record_id).toBe("r1");
    expect(hits[0].score).toBeCloseTo(1, 5);
    // 行形状与 searchL1Vector 一致：metadata 从 l1_records 读回
    expect(hits[0].content).toBe("原文一");
    expect(hits[0].type).toBe("work_fact");
    expect(hits[0].session_key).toBe("k");
    expect(hits[0].team_id).toBe("t");
    // 正交事实键排在其后（且 score 明显低）
    const r2 = hits.find((h) => h.record_id === "r2");
    if (r2) expect(r2.score).toBeLessThan(0.5);

    // 主索引无恙：原文向量检索仍按 l1_vec 命中 r1/r2 自身
    const main = s.searchL1Vector(basis(2), 5);
    expect(main.map((h) => h.record_id)).toContain("r1");
    expect(s.countL1VectorRows()).toBe(2);
  });

  it("T2 零向量 → upsert 返回 false 且检索不到该行", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("r1", "有事实键"), basis(2))).toBe(true);
    expect(s.upsertL1(mkRecord("r3", "零向量行"), basis(3))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(true);

    const zero = new Float32Array(DIM);
    expect(s.upsertL1FactVector("r3", zero)).toBe(false);
    // 空向量同样拒写
    expect(s.upsertL1FactVector("r3", new Float32Array(0))).toBe(false);
    // 维度不符同样拒写（防脏向量入库）
    expect(s.upsertL1FactVector("r3", new Float32Array(DIM - 1))).toBe(false);

    const ids = s.searchL1FactVector!(basis(0), 10).map((h) => h.record_id);
    expect(ids).toContain("r1");
    expect(ids).not.toContain("r3");
  });

  it("T3 deleteL1 后事实通道不再返回该行", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("r1", "待删"), basis(2))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(true);
    expect(s.searchL1FactVector!(basis(0), 5).map((h) => h.record_id)).toContain("r1");

    expect(s.deleteL1("r1")).toBe(true);

    expect(s.searchL1FactVector!(basis(0), 5).map((h) => h.record_id)).not.toContain("r1");
  });

  it("T4 archiveL1 后事实通道不再返回该行", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("r1", "待归档"), basis(2))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(true);

    expect(s.archiveL1("r1", "forgetting")).toBe(true);

    expect(s.searchL1FactVector!(basis(0), 5).map((h) => h.record_id)).not.toContain("r1");
  });

  it("T5 隔离 filter 生效：他租户行被过滤", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("ra", "A 租户", { teamId: "tenant-A" }), basis(2))).toBe(true);
    expect(s.upsertL1(mkRecord("rb", "B 租户", { teamId: "tenant-B" }), basis(3))).toBe(true);
    expect(s.upsertL1FactVector("ra", basis(0))).toBe(true);
    expect(s.upsertL1FactVector("rb", basis(0))).toBe(true);

    const all = s.searchL1FactVector!(basis(0), 10).map((h) => h.record_id);
    expect(all).toEqual(expect.arrayContaining(["ra", "rb"]));

    const onlyA = s.searchL1FactVector!(basis(0), 10, { teamId: "tenant-A" });
    expect(onlyA.map((h) => h.record_id)).toEqual(["ra"]);
    expect(onlyA.every((h) => h.team_id === "tenant-A")).toBe(true);
  });

  it("T6 dims=0（vec 表未就绪）时通道静默关闭：写 false、搜 []", () => {
    const s = makeStore(0);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(false);
    expect(s.searchL1FactVector!(basis(0), 5)).toEqual([]);
  });

  it("T7 覆盖写：同一 recordId 重复 upsert 只保留最新事实键向量", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("r1", "覆盖"), basis(2))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(0))).toBe(true);
    expect(s.upsertL1FactVector("r1", basis(1), "2026-10-28T00:00:00Z")).toBe(true);

    const oldKey = s.searchL1FactVector!(basis(0), 5).find((h) => h.record_id === "r1");
    const newKey = s.searchL1FactVector!(basis(1), 5).find((h) => h.record_id === "r1");
    // 覆盖后：新事实键 score≈1（正相交），旧事实键已正交（score≈0）——
    // vec0 的 KNN 恒返 k 个邻居，故旧键仍作为远邻出现（score 0），不再贴合。
    expect(newKey?.score).toBeCloseTo(1, 5);
    expect(oldKey?.score ?? 0).toBeLessThan(0.5);
  });
});
