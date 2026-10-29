/**
 * #137（W1 双通道）：事实键平行召回通道 + 通道内归一化融合的端到端单测。
 *
 * 铁律（本票红线）：
 *  - 事实通道**只扩召回**：原文主索引 l1_vec 与它算出的主序不动；
 *  - 通道关闭 / store 未实现 / 无事实向量 → 与改动前逐位一致（关断矩阵）；
 *  - normalized 模式才把「通道内归一化分」当主序（rrf 模式仍按 RRF 值排序）。
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { searchHybrid } from "../auto-recall.js";
import { VectorStore } from "../../store/sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { EmbeddingService } from "../../store/embedding.js";

const DIMS = 8;
/** 单位向量：idx 位置 1，其余 0。 */
const unit = (idx: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[idx] = 1;
  return v;
};

const mk = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "fact-channel",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-10-20T00:00:00Z"],
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "fact-channel",
    occurred_at: "2026-10-20T00:00:00Z",
    certainty: "observed",
    valence: 0,
    arousal: 0,
    significance: 0.5,
    ...over,
  }) as MemoryRecord;

/** 只做「返回固定 query 向量」的 embedding stub（检索路不关心文本）。 */
const stubEmbedding = (queryVec: Float32Array): EmbeddingService =>
  ({
    embed: async () => queryVec,
    embedBatch: async (texts: string[]) => texts.map(() => queryVec),
    getDimensions: () => DIMS,
    getProviderInfo: () => ({ provider: "stub", model: "stub" }),
    isReady: () => true,
    startWarmup: () => undefined,
  }) as unknown as EmbeddingService;

const dirs: Array<{ store: VectorStore; dir: string }> = [];
afterEach(() => {
  for (const { store, dir } of dirs.splice(0)) {
    try { store.close(); } catch { /* noop */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/**
 * 建库：A 原文与 query 同向（主索引强命中）；B 原文与 query 正交（低于阈值），
 * 但 B 的**事实键**与 query 同向——只有事实通道能把它捞回来。
 */
function seed(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-channel-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
  const init = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${init.reason}`);
  dirs.push({ store, dir });

  const a = mk("m_a", "A：用户名字叫王小明");
  const b = mk("m_b", "B：用户是浙大毕业的", { type: "episodic" });
  store.upsertL1(a, unit(0));
  store.upsertL1(b, unit(2));
  store.upsertL1FactVector!(a.id, unit(3), a.updatedAt);
  store.upsertL1FactVector!(b.id, unit(0), b.updatedAt);
  return store;
}

async function run(
  store: VectorStore,
  opts: { fusion?: Parameters<typeof searchHybrid>[20]; factChannel?: Parameters<typeof searchHybrid>[21] } = {},
) {
  return await searchHybrid(
    "zzz-no-fts-match", // 关键词路无命中：只留向量/事实两路，断言可确定
    "",
    5,
    0.3,
    store,
    stubEmbedding(unit(0)),
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    false, // exploreSlot：关（探索位会重新排序，非本测试关注点）
    undefined,
    undefined,
    false, // excludeInvalidated：关（B 无失效字段，保持最小面）
    undefined,
    undefined,
    undefined,
    undefined,
    opts.fusion,
    opts.factChannel,
  );
}

const contents = (lines: string[]) => lines.map((l) => l.replace(/^.*?\]\s*/, ""));

describe("#137 事实键平行召回通道", () => {
  it("通道关闭：只有原文主索引命中（逐位现状）", async () => {
    const store = seed();
    const out = await run(store);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("A：用户名字叫王小明");
    expect(out.lines[0]).not.toContain("[fact]");
    expect(out.timing.factMs).toBeUndefined();
  });

  it("通道开启（rrf 模式）：事实候选并入池、带 [fact] 标注，但主序仍由原文相关度裁决", async () => {
    const store = seed();
    const out = await run(store, { factChannel: { enabled: true, weight: 0.6 } });
    expect(contents(out.lines)).toHaveLength(2);
    // A 原文命中 rank1（RRF 1/61）> B 只靠事实通道（0.6/61）
    expect(out.lines[0]).toContain("A：用户名字叫王小明");
    expect(out.lines[1]).toContain("B：用户是浙大毕业的");
    expect(out.lines[1]).toContain("·[fact]");
    // A 的事实向量与 query 正交（余弦 0 < 默认门槛) → 通道只回 B 一条
    expect(out.timing.factHits).toBe(1);
  });

  it("normalized 模式：通道内归一化分作主序（事实权重压过原文时 B 反超）", async () => {
    const store = seed();
    const out = await run(store, {
      fusion: { mode: "normalized", dense: 0.05, bm25: 0, fact: 1 },
      factChannel: { enabled: true, weight: 1 },
    });
    expect(out.lines[0]).toContain("B：用户是浙大毕业的");
    expect(out.lines[1]).toContain("A：用户名字叫王小明");
  });

  it("minScore 门控：事实通道余弦低于门槛的候选不进池", async () => {
    const store = seed();
    const out = await run(store, { factChannel: { enabled: true, weight: 0.6, minScore: 1.01 } });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("A：用户名字叫王小明");
  });

  it("onlyForTypes 门控：类型不在名单的记录不走事实通道", async () => {
    const store = seed();
    const out = await run(store, {
      factChannel: { enabled: true, weight: 0.6, onlyForTypes: ["work_fact"] },
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("A：用户名字叫王小明");
  });

  it("双命中不加分：原文 rank20 且事实 rank1 的记录不得反超原文 rank1（只扩召回红线）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-channel-dual-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    const init = store.init();
    if (store.isDegraded()) throw new Error(`临时库初始化降级：${init.reason}`);
    dirs.push({ store, dir });
    // 21 条原文按余弦递减：k0 最相关（θ=0），k20 最不相关
    const rows: Array<{ id: string; cos: number }> = [];
    for (let i = 0; i <= 20; i++) {
      const theta = (i * Math.PI) / 60; // 0..~63°，余弦单调递减
      const v = new Float32Array(DIMS);
      v[0] = Math.cos(theta);
      v[1] = Math.sin(theta);
      const rec = mk(`m_k${i}`, `K 条目 ${i}`, { occurred_at: "2026-10-20T00:00:00Z" });
      store.upsertL1(rec, v);
      if (i === 20) store.upsertL1FactVector!(rec.id, unit(0), rec.updatedAt); // 事实 rank1
      rows.push({ id: rec.id, cos: Math.cos(theta) });
    }
    const baseline = await run(store);
    const baselineIds = contents(baseline.lines);
    expect(contents(baseline.lines)[0]).toContain("K 条目 0");
    const idxBefore = baselineIds.findIndex((c) => c.includes("K 条目 20"));

    const withFact = await run(store, { factChannel: { enabled: true, weight: 0.6 } });
    const withFactIds = contents(withFact.lines);
    // 20 条原文候选占满 limit=5？——用 maxResults=5 时 rank20 本就不在 top5，
    // 这里断言「事实命中没有把它提上来」= top5 与基线一致。
    expect(withFactIds.slice(0, 5)).toEqual(baselineIds.slice(0, 5));
    expect(withFactIds.findIndex((c) => c.includes("K 条目 20"))).toBe(idxBefore);
  });

  it("store 未实现 searchL1FactVector（如 tcvdb）：通道静默退出，不抛错", async () => {
    const store = seed();
    const patched = Object.create(store) as VectorStore;
    // 原型上有实现，用 defineProperty 把实例上的可选方法显式遮成 undefined → 走 feature-detect 缺失分支
    Object.defineProperty(patched, "searchL1FactVector", { value: undefined, enumerable: true });
    const out = await run(patched, { factChannel: { enabled: true, weight: 0.6 } });
    expect(out.lines).toHaveLength(1);
  });
});
