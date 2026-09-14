/**
 * R-A3 同形验证（性能速赢 E1/E2/E3，spec §4：性能优化不碰检索语义）。
 * 真实 sqlite 临时库链路：
 *   [A] E1 query embedding TTL 缓存：真库 + 计数 embedding 服务——同 query 二次搜索免外呼、
 *       TTL 过期重新外呼、ttl=0 通道关、命中结果内容逐位一致；
 *   [B] E2 listValues 租户级缓存：miss/hit 计数 + 五写路径失效点穷举逐一断言；
 *   [C] E3 同 session 同 query 注入块复用：全等复用 / query 变化失效 / ttl=0 关；
 *   [D] config 解析：三 TTL 开关（缺省默认开，<=0 关，负值 clamp 0）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-ra3.ts   （或 node tsx-cli scripts/verify-ra3.ts）
 *
 * 只用自建临时数据，不连任何线上资源；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { performAutoRecall } from "../src/core/hooks/auto-recall.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";

const KW = "RA3PIN";

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 性能速赢验证条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-ra3",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-ra3",
    ...over,
  }) as MemoryRecord;

/** 计数 embedding 服务（E1/E3 外呼计数探针；维度 4 的确定性假向量）。 */
function countingEmbeddingService(): { service: EmbeddingService; calls: () => number } {
  let n = 0;
  const service = {
    embed: async () => {
      n++;
      return new Float32Array([0.1, 0.2, 0.3, 0.4]);
    },
  } as unknown as EmbeddingService;
  return { service, calls: () => n };
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] E1 query embedding TTL 缓存（真库真链路）");
console.log("=".repeat(72));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ra3-e1-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  store.init();
  store.upsertL1(mk("a"), undefined);
  const { service, calls } = countingEmbeddingService();
  try {
    const p = {
      query: `${KW} E1 复用查询`,
      limit: 5,
      vectorStore: store,
      embeddingService: service,
      queryEmbeddingCacheTtlMs: 60_000,
      scoreThreshold: 0,
    } as Parameters<typeof executeMemorySearch>[0];
    const r1 = await executeMemorySearch(p);
    const r2 = await executeMemorySearch(p);
    const a1 = calls() === 1 && JSON.stringify(r1.results.map((r) => r.id)) === JSON.stringify(r2.results.map((r) => r.id));
    check("E1：TTL 内同 query 二次搜索免外呼且结果逐位一致", a1, `embedCalls=${calls()}`);

    await executeMemorySearch({ ...p, query: `${KW} E1 另一查询` } as Parameters<typeof executeMemorySearch>[0]);
    check("E1：不同 query → 各自外呼", calls() === 2, `embedCalls=${calls()}`);

    const offP = { ...p, query: `${KW} E1 关断查询`, queryEmbeddingCacheTtlMs: 0 } as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(offP);
    await executeMemorySearch(offP);
    check("E1：ttl=0 → 通道关（每次外呼）", calls() === 4, `embedCalls=${calls()}`);

    const expP = { ...p, query: `${KW} E1 过期查询`, queryEmbeddingCacheTtlMs: 30 } as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(expP);
    await new Promise((r) => setTimeout(r, 50));
    await executeMemorySearch(expP);
    check("E1：TTL 过期 → 重新外呼", calls() === 6, `embedCalls=${calls()}`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] E2 listValues 租户级缓存 + 五写路径失效点穷举（真库）");
console.log("=".repeat(72));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ra3-e2-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  store.init();
  try {
    // 读两次一次 DB
    store.upsertValue("v1", "正确性", 0.8, "verify", undefined, 1);
    store.listValues();
    store.listValues();
    const b0 = store.valuesCacheMisses === 1 && store.valuesCacheHits === 1;
    check("E2：读两次一次 DB（miss=1, hit=1）", b0, `miss=${store.valuesCacheMisses}, hit=${store.valuesCacheHits}`);

    // 失效点 1/5 upsertValue
    store.upsertValue("v2", "诚实", 0.7, "verify", undefined, -1);
    const b1 = store.listValues().some((v) => v.label === "诚实");
    check("E2 失效 1/5 upsertValue：写后立即可见", b1 && store.valuesCacheMisses === 2);

    // 失效点 2/5 deleteValue
    store.deleteValue("v2");
    const b2 = !store.listValues().some((v) => v.label === "诚实");
    check("E2 失效 2/5 deleteValue：删除立即可见", b2 && store.valuesCacheMisses === 3);

    // 失效点 3/5 deriveValueValences
    store.upsertValue("v3", "可靠", 0.6, "verify", undefined);
    store.listValues();
    const runner = { run: async () => JSON.stringify({ valences: [{ value_id: "v3", valence: 1 }] }) };
    const { derived } = await store.deriveValueValences(undefined, runner);
    const b3 = derived === 1 && store.listValues()[0]?.valence === 1;
    check("E2 失效 3/5 deriveValueValences：LLM 判定值立即可见", b3 && store.valuesCacheMisses === 5);

    // 失效点 4/5 resetValueValences
    const snapshot = store.resetValueValences();
    const b4 = snapshot.length >= 1 && store.listValues().every((v) => v.valence === null);
    check("E2 失效 4/5 resetValueValences：置 NULL 立即可见", b4);

    // 失效点 5/5 restoreValueValences
    store.restoreValueValences(undefined, snapshot);
    const b5 = store.listValues().some((v) => v.valence === 1);
    check("E2 失效 5/5 restoreValueValences：快照恢复值立即可见", b5);

    // TTL=0 关
    store.setValuesCacheTtlMs(0);
    store.listValues();
    store.listValues();
    check("E2：setValuesCacheTtlMs(0) → 缓存关（每次查 DB）", store.valuesCacheHits === 1,
      `hits=${store.valuesCacheHits}, misses=${store.valuesCacheMisses}`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] E3 同 session 同 query 注入块复用（真库真链路 performAutoRecall）");
console.log("=".repeat(72));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ra3-e3-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  store.init();
  store.upsertL1(mk("a"), undefined);
  const { service, calls } = countingEmbeddingService();
  const cfg = parseConfig({
    recall: {
      strategy: "hybrid",
      coreRefBoost: 0,
      timeBoost: 0, recencyBoost: 0, sigWeight: 0, inferredPenalty: 0, reinforcementWeight: 0, moodBoost: 0,
      graphDiscount: 0, sceneBoost: 0,
      queryEmbeddingCacheTtlMs: 0, // 隔离 E1：embed 计数变化只能来自 E3 复用
      sessionReuseTtlMs: 300_000,
    },
    embedding: { provider: "none", enabled: false },
  });
  try {
    const base = {
      actorId: "verify-ra3",
      sessionKey: "verify-ra3-e3",
      cfg,
      pluginDataDir: dir,
      vectorStore: store,
      embeddingService: service,
    };
    const r1 = await performAutoRecall({ ...base, userText: `${KW} E3 复用查询` });
    const r2 = await performAutoRecall({ ...base, userText: `${KW} E3 复用查询` });
    const c1 = calls() === 1 && r1?.prependContext === r2?.prependContext;
    check("E3：同 session 同 query → 复用（embed 仅 1 次，注入块一致）", c1, `embedCalls=${calls()}`);

    await performAutoRecall({ ...base, userText: `${KW} E3 变化查询` });
    check("E3：query 变化 → 不复用", calls() === 2, `embedCalls=${calls()}`);

    const cfgOff = parseConfig({
      recall: {
        strategy: "hybrid", coreRefBoost: 0,
        timeBoost: 0, recencyBoost: 0, sigWeight: 0, inferredPenalty: 0, reinforcementWeight: 0, moodBoost: 0,
        graphDiscount: 0, sceneBoost: 0, queryEmbeddingCacheTtlMs: 0, sessionReuseTtlMs: 0,
      },
      embedding: { provider: "none", enabled: false },
    });
    await performAutoRecall({ ...base, cfg: cfgOff, userText: `${KW} E3 关断查询` });
    await performAutoRecall({ ...base, cfg: cfgOff, userText: `${KW} E3 关断查询` });
    check("E3：sessionReuseTtlMs=0 → 通道关", calls() === 4, `embedCalls=${calls()}`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] config 解析：三 TTL 开关（parseConfig 真函数）");
console.log("=".repeat(72));
{
  const cfg = parseConfig({ recall: { queryEmbeddingCacheTtlMs: -5, valuesCacheTtlMs: 0, sessionReuseTtlMs: 120_000 } });
  const d1 = cfg.recall.queryEmbeddingCacheTtlMs === 0 && cfg.recall.valuesCacheTtlMs === 0 && cfg.recall.sessionReuseTtlMs === 120_000;
  check("[D] 负值/0 → 关；显式值生效", d1, JSON.stringify({
    queryEmbeddingCacheTtlMs: cfg.recall.queryEmbeddingCacheTtlMs,
    valuesCacheTtlMs: cfg.recall.valuesCacheTtlMs,
    sessionReuseTtlMs: cfg.recall.sessionReuseTtlMs,
  }));
  const def = parseConfig({}).recall;
  const d2 = def.queryEmbeddingCacheTtlMs === 60_000 && def.valuesCacheTtlMs === 60_000 && def.sessionReuseTtlMs === 300_000;
  check("[D] 缺省默认 60s / 60s / 5min（spec §4）", d2, JSON.stringify({
    queryEmbeddingCacheTtlMs: def.queryEmbeddingCacheTtlMs,
    valuesCacheTtlMs: def.valuesCacheTtlMs,
    sessionReuseTtlMs: def.sessionReuseTtlMs,
  }));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
