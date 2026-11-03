/**
 * FTS 候选检索的"类型收窄"（2026-11-03）：结论层只需要 work_fact，却与全库
 * episodic（短、词频高）在同一张池子里按 bm25 竞争 top-N —— 长文 consolidated 卡
 * 被长度归一化系统性压到榜尾（生产实测：目标卡在 4021 行里 #37/50，按 type 收窄后 #5/9）。
 *
 * 契约：searchL1Fts(q, limit, filter?, opts?) 的 opts.type 在 **SQL 层**先过滤再 LIMIT，
 *      不能是"先取 limit 行再在 JS 里筛"（那样照样饿死候选）。
 *      不传 opts 时逐位等于旧行为（同一 SQL、同一结果）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore, buildFtsQuery } from "./sqlite.js";
import type { MemoryRecord } from "./types.js";

const DIM = 8;
const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "fts-type-scope-"));
  dirs.push(dir);
  const s = new VectorStore(join(dir, "v.db"), DIM);
  stores.push(s);
  const res = s.init();
  if (s.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return s;
}

const vec = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1;
  return v;
};

function rec(id: string, content: string, type: string, sceneName = "s"): MemoryRecord {
  return {
    id,
    content,
    type,
    priority: 0.5,
    certainty: "observed",
    scene_name: sceneName,
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

/** 20 条短 episodic（query 词各出现 4 次，bm25 词频占优）抢满 top-5；1 条 work_fact 只出现 1 次 → 榜外。 */
function seed(s: VectorStore) {
  for (let i = 0; i < 20; i++) {
    expect(s.upsertL1(rec(`e${i}`, "alpha alpha alpha alpha", "episodic"), vec(i))).toBe(true);
  }
  expect(s.upsertL1(rec("card1", "alpha", "work_fact", "consolidated"), vec(7))).toBe(true);
}

describe("searchL1Fts 类型收窄（先过滤再 LIMIT）", () => {
  it("全局 top-5 被词频占优的短行占满、work_fact 缺席；opts.type='work_fact' 时能拿到", () => {
    const s = makeStore();
    seed(s);
    const q = buildFtsQuery("alpha beta gamma 里程碑")!;

    const global = s.searchL1Fts(q, 5);
    expect(global.length).toBe(5);
    expect(global.map((r) => r.record_id)).not.toContain("card1");

    const scoped = s.searchL1Fts(q, 5, undefined, { type: "work_fact" });
    expect(scoped.map((r) => r.record_id)).toContain("card1");
    expect(scoped.every((r) => r.type === "work_fact")).toBe(true);
  });

  it("不传 opts 时逐位等于旧行为（同一 query/limit 结果一致）", () => {
    const s = makeStore();
    seed(s);
    const q = buildFtsQuery("alpha")!;
    const a = s.searchL1Fts(q, 5).map((r) => r.record_id);
    const b = s.searchL1Fts(q, 5, undefined, {}).map((r) => r.record_id);
    expect(b).toEqual(a);
  });

  it("类型收窄仍尊重 isolation filter（不得跨租户泄漏）", () => {
    const s = makeStore();
    seed(s);
    const q = buildFtsQuery("alpha")!;
    const scoped = s.searchL1Fts(q, 5, { teamId: "other-team" }, { type: "work_fact" });
    expect(scoped).toEqual([]);
  });
});
