/**
 * 向量绑定必须尊重 Float32Array 的 byteOffset/byteLength（视图，而非整块 backing buffer）。
 *
 * 病灶（2026-11-03 审查发现）：7 处调用 `Buffer.from(x.buffer)` 只取 backing ArrayBuffer，
 * 当调用方传入 subarray()/slice 视图时，交给 sqlite-vec 的字节数 = 整个 backing 的长度，
 * 于是 vec0 报 `Dimension mismatch for query vector ... Expected N dimensions but received M`
 * 并被 store 的 try/catch 静默吞掉 → 检索返回空（写入则整行脏向量/失败）。
 * 正确写法是三元形式 `Buffer.from(x.buffer, x.byteOffset, x.byteLength)`（fact 通道 :4283 已是）。
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

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "vec-view-"));
  dirs.push(dir);
  const s = new VectorStore(join(dir, "v.db"), DIM);
  stores.push(s);
  const res = s.init();
  if (s.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return s;
}

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

/** 把 basis(i) 放进一个更大的 backing buffer 的尾部，返回长度恰为 DIM 的视图（byteOffset≠0）。 */
function viewOf(i: number, pad = DIM): Float32Array {
  const backing = new Float32Array(DIM + pad);
  backing.fill(99, 0, pad);
  backing.set(basis(i), pad);
  return backing.subarray(pad, pad + DIM);
}

function mkRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "work_fact",
    priority: 0.5,
    certainty: "observed",
    scene_name: "vec-view",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-03T00:00:00Z"],
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
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

describe("向量绑定尊重 byteOffset/byteLength（Float32Array 视图）", () => {
  it("查询视图与等值整块数组结果逐位一致（不得静默返回空）", () => {
    const s = makeStore();
    // 写入用普通数组（无偏移）建立基线
    expect(s.upsertL1(mkRecord("r0", "基向量 e0"), basis(0))).toBe(true);
    expect(s.upsertL1(mkRecord("r2", "基向量 e2"), basis(2))).toBe(true);

    const plain = s.searchL1Vector(basis(0), 5);
    expect(plain.map((h) => h.record_id)).toContain("r0");

    const viaView = s.searchL1Vector(viewOf(0), 5);
    // 病灶下这里是 []（dimension mismatch 被 catch 吞掉）
    expect(viaView.map((h) => h.record_id)).toEqual(plain.map((h) => h.record_id));
    expect(viaView[0].score).toBeCloseTo(plain[0].score, 6);
  });

  it("写入视图后可按同一向量检索到该行（写入侧同样不得错绑）", () => {
    const s = makeStore();
    expect(s.upsertL1(mkRecord("v1", "视图写入行"), viewOf(3))).toBe(true);
    const hits = s.searchL1Vector(viewOf(3), 5);
    expect(hits.map((h) => h.record_id)).toContain("v1");
    expect(s.countL1VectorRows()).toBe(1);
  });
});
