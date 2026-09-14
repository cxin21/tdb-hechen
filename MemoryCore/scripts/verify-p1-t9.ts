/**
 * P1-T9 同形验证：边强度真实化 + 假边清理（G5/G4 + 拍板②）。
 *
 * 背景：
 *   G5：attachTopCandidates 的边强度是常量 hasVectorScores ? 0.8 : 0.5——向量召回
 *       的真实 cosine 在映射 MemoryRecord 时被丢弃，生产首条边 strength=0.8 即假值。
 *       修复：CandidateMatch 携带 topScore（top-1 候选的真实 cosine，语义与 no-dedup
 *       路径 searchL1Vector 的 score=1-distance 一致），attachTopCandidates clamp 透传；
 *       FTS 分（bm25 rank）与 cosine 不可比 → 不附 top_candidate（宁缺毋滥，不建假边）。
 *   G4：storeAllDirectly 的 top-1 搜索只排自身不排同批 → 同批新记忆互当"最相关旧记忆"。
 *       修复：batchIds 排除整个同批，topK 扩容 3+批大小防挤出。
 *   拍板②：历史假强度 similar 边（0.8/0.5）由 clean-fake-edges.ts 清理。
 *
 * 断言组（验收契约）：
 *   1. 真强度：dedup 路径 store 决策的 similar 边 strength == 手算 cosine（±1e-6）且 ≠ 0.8
 *      （修复前 FAIL：恒 0.8 常量）
 *   2. FTS-only 不建假边：无 embeddingService（Tier 2）→ store 决策零 similar 边
 *      （修复前 FAIL：建 0.5 假边）
 *   3. 同批排除：一批 3 条相似新记忆 + 1 条旧记忆 → 批内零互边、边指向旧记忆
 *      （修复前 FAIL：同批互相当 top-1）
 *   4. no-dedup 回归：storeAllDirectly 单条 top-1 边仍真 cosine（原有行为不回归）
 *   5. clean-fake-edges：dry-run 零删除、--apply 恰好删 2 条假边、合法边（strength=1 等）保留
 *   6. 相似度门槛（审查 I-1 修补）：新记忆与旧记忆余弦≈0（不共享 2-gram）→
 *      不建 similar 边（修复前：clamp 后建 strength=0 假关系边，dedup 与 no-dedup 两路径都验）
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p1-t9.ts
 *
 * 只用自建临时库（hashEmbed + 真实 VectorStore 64 维，参照 audit-fix-verify-edges.ts），
 * 不连任何线上资源、不碰生产库；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { MIN_SIMILAR_STRENGTH } from "../src/core/record/l1-dedup.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { cleanFakeEdges } from "./clean-fake-edges.js";

const TOLERANCE = 1e-6;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 确定性 embedding：单字+双字 滑窗 → 伪向量（共享词→高余弦）。与 audit-fix-verify-edges.ts 同源。 */
function hashEmbed(text: string, dims = 64): Float32Array {
  const vec = new Float32Array(dims);
  const tokens = [...(text.matchAll(/.{1,2}/g) ?? [])].map((m) => m[0]);
  for (const tk of tokens) {
    const h = parseInt(createHash("md5").update(tk).digest("hex").slice(0, 8), 16);
    vec[h % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

/** 手算期望 cosine（f64 累加 f32 分量——与 sqlite-vec 存储的 f32 向量同源）。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const embedding: EmbeddingService = {
  embed: async (t: string) => hashEmbed(t),
  embedBatch: async (ts: string[]) => ts.map((t) => hashEmbed(t)),
} as never;

/**
 * mock LLM：第一次调用 = L1 提取（scenes 数组 schema，含 soul 字段 → 跳过 enrich 补全）；
 * 后续调用 = dedup 判定：record_id 留空 → parseBatchResult 跳过 → 默认全 store（目标路径）。
 */
function mockLlm(extractionMemories: Array<Record<string, unknown>>): LLMRunner {
  let call = 0;
  return {
    run: async () => {
      call++;
      if (call === 1) {
        return JSON.stringify([
          { scene_name: "对话情境", message_ids: [1], memories: extractionMemories },
        ]);
      }
      return JSON.stringify([{ record_id: "", action: "store", target_ids: [] }]);
    },
  } as never;
}

interface LinkRow { source_id: string; target_id: string; type: string; strength: number }
function linksOf(store: VectorStore): LinkRow[] {
  return store.getRawDb().prepare("SELECT source_id, target_id, type, strength FROM l1_links").all() as unknown as LinkRow[];
}

function mkOldRecord(id: string, content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id, content, type: "episodic", priority: 60, scene_name: "verify-p1-t9",
    source_message_ids: [], metadata: {}, timestamps: [now], occurred_at: now,
    certainty: "observed", createdAt: now, updatedAt: now, version: 1,
    sessionKey: "k", sessionId: "sid-old",
  } as unknown as MemoryRecord;
}

interface ExtractOptions {
  enableDedup: boolean;
  vectorStore: VectorStore;
  embeddingService?: EmbeddingService;
}
async function runExtract(
  store: VectorStore,
  baseDir: string,
  userText: string,
  memories: Array<Record<string, unknown>>,
  opts: ExtractOptions,
): Promise<{ storedCount: number; records: MemoryRecord[] }> {
  const result = await extractL1Memories({
    messages: [{ role: "user", content: userText, timestamp: Date.now() } as never],
    sessionKey: "k-t9",
    sessionId: "sid-new",
    baseDir,
    config: {},
    options: {
      enableDedup: opts.enableDedup,
      enableMemoryLinks: true,
      maxMemoriesPerSession: 10,
      vectorStore: opts.vectorStore,
      embeddingService: opts.embeddingService,
      llmRunner: mockLlm(memories),
    },
    logger: console as never,
  });
  return { storedCount: result.storedCount, records: result.records ?? [] };
}

async function withTempStore(
  label: string,
  fn: (store: VectorStore, tmpDir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-p1-t9-${label}-`));
  const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
  await store.init();
  try {
    if (store.isDegraded?.()) {
      check(`[${label}] 前置`, false, "临时库初始化降级（环境问题，非行为断言）");
      return;
    }
    await fn(store, tmpDir);
  } finally {
    try { store.close(); } catch { /* Windows 句柄时序 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

console.log("=".repeat(72));
console.log("P1-T9 同形验证：边强度真实化 + 假边清理");
console.log("=".repeat(72));

// ── 断言组 1：真强度（dedup 路径 store 决策）─────────────────────
console.log("\n[1] 真强度：dedup 路径 similar 边 strength == 手算 cosine（±1e-6）且 ≠ 0.8");
{
  const oldContent = "用户偏好青竹本地部署大模型推理方案";
  const newContent = "用户坚持青竹本地部署推理的技术路线不动摇";
  const expected = cosine(hashEmbed(newContent), hashEmbed(oldContent));
  check("[1] 前置：期望 cosine 可控", Math.abs(expected - 0.8) > 1e-3, `expected=${expected.toFixed(6)}（须远离 0.8）`);
  await withTempStore("g1", async (store, tmpDir) => {
    store.upsertL1(mkOldRecord("old-t9-real", oldContent), hashEmbed(oldContent));
    const { storedCount, records } = await runExtract(store, path.join(tmpDir, "base"), "我们继续用青竹本地部署推理", [
      { content: newContent, type: "episodic", priority: 60, source_message_ids: [1], certainty: "observed", occurred_at: new Date().toISOString() },
    ], { enableDedup: true, vectorStore: store, embeddingService: embedding });
    const links = linksOf(store).filter((l) => l.type === "similar");
    const edge = links.find((l) => l.target_id === "old-t9-real");
    console.log(`  stored=${storedCount} similarEdges=${JSON.stringify(links)}`);
    check("[1] 提取成功 1 条", storedCount === 1);
    check("[1] 存在指向旧记忆的 similar 边", edge !== undefined);
    if (edge) {
      const realOk = Math.abs(edge.strength - expected) <= TOLERANCE;
      check("[1] strength == 手算 cosine（±1e-6）", realOk, `got=${edge.strength.toFixed(8)} expected=${expected.toFixed(8)} diff=${Math.abs(edge.strength - expected).toExponential(2)}`);
      check("[1] strength ≠ 0.8（非伪造常量）", Math.abs(edge.strength - 0.8) > TOLERANCE);
      check("[1] 边 source == 新记录 id", records[0] ? edge.source_id === records[0].id : false);
    }
  });
}

// ── 断言组 2：FTS-only 不建假边 ─────────────────────────────────
console.log("\n[2] FTS-only：无 embeddingService（Tier 2）→ store 决策零 similar 边（旧行为是 0.5 假边）");
{
  const oldContent = "项目青竹采用本地部署方案已经落地";
  const newContent = "我们继续推进青竹项目的本地部署改造";
  await withTempStore("g2", async (store, tmpDir) => {
    // 预置旧记忆但不带向量（metadata-only）→ countL1>0 走 FTS Tier
    store.upsertL1(mkOldRecord("old-t9-fts", oldContent), undefined);
    const { storedCount } = await runExtract(store, path.join(tmpDir, "base"), "青竹项目本周进展同步", [
      { content: newContent, type: "episodic", priority: 60, source_message_ids: [1], certainty: "observed", occurred_at: new Date().toISOString() },
    ], { enableDedup: true, vectorStore: store });
    const links = linksOf(store).filter((l) => l.type === "similar");
    console.log(`  stored=${storedCount} similarEdges=${JSON.stringify(links)}`);
    check("[2] 提取成功 1 条", storedCount === 1);
    check("[2] 零 similar 边（宁缺毋滥，不建 0.5 假边）", links.length === 0, `similar 边数=${links.length}`);
  });
}

// ── 断言组 3：同批排除（G4，no-dedup 批量路径）──────────────────
// I-1 修补后数据校准：原批内容对旧记忆余弦 0/0.12（正是 I-1 实锤的 strength=0 假边），
// 门槛之下已不建边。换用对旧记忆 0.78~0.89、批内互相似 0.89+ 的数据，
// 使"批内排除 + 边指向旧记忆"的链路覆盖在门槛生效后依然成立。
console.log("\n[3] 同批排除：3 条相似新记忆 + 1 条旧记忆 → 批内零互边、边指向旧记忆");
{
  const oldContent = "团队知识库向量化混合检索方案已上线";
  const batchContents = [
    "团队知识库向量化混合检索方案上线运行",
    "团队知识库向量化混合检索方案上线稳定",
    "团队知识库向量化混合检索方案上线告捷",
  ];
  const batchExpected = batchContents.map((c) => cosine(hashEmbed(c), hashEmbed(oldContent)));
  check("[3] 前置：批内各条对旧记忆余弦 > 门槛", batchExpected.every((c) => c > MIN_SIMILAR_STRENGTH), `cos=[${batchExpected.map((c) => c.toFixed(3)).join(",")}]`);
  await withTempStore("g3", async (store, tmpDir) => {
    store.upsertL1(mkOldRecord("old-t9-batch", oldContent), hashEmbed(oldContent));
    const { storedCount, records } = await runExtract(store, path.join(tmpDir, "base"), "汇报本周记忆图修复进展", batchContents.map((content) => ({
      content, type: "episodic", priority: 60, source_message_ids: [1], certainty: "observed", occurred_at: new Date().toISOString(),
    })), { enableDedup: false, vectorStore: store, embeddingService: embedding });
    const batchIds = new Set(records.map((r) => r.id));
    const links = linksOf(store).filter((l) => l.type === "similar");
    console.log(`  stored=${storedCount} batchIds=${[...batchIds].join(",")} similarEdges=${JSON.stringify(links)}`);
    check("[3] 提取成功 3 条", storedCount === 3 && batchIds.size === 3);
    check("[3] 至少建了 similar 边（链路通）", links.length >= 1);
    const crossEdges = links.filter((l) => batchIds.has(l.source_id) && batchIds.has(l.target_id));
    check("[3] 批内零互边", crossEdges.length === 0, crossEdges.length > 0 ? `互边=${JSON.stringify(crossEdges)}` : "");
    const wrongTargets = links.filter((l) => batchIds.has(l.source_id) && l.target_id !== "old-t9-batch");
    check("[3] 批内记忆的边全部指向旧记忆", wrongTargets.length === 0, wrongTargets.length > 0 ? `错指向=${JSON.stringify(wrongTargets)}` : "");
  });
}

// ── 断言组 4：no-dedup 单条回归 ─────────────────────────────────
console.log("\n[4] no-dedup 回归：storeAllDirectly 单条 top-1 边仍真 cosine（原有行为不回归）");
{
  const oldContent = "记忆检索渐进叠加BM25之上再叠向量";
  const newContent = "检索策略继续渐进叠加不推翻旧机制";
  const expected = cosine(hashEmbed(newContent), hashEmbed(oldContent));
  await withTempStore("g4", async (store, tmpDir) => {
    store.upsertL1(mkOldRecord("old-t9-nodedup", oldContent), hashEmbed(oldContent));
    const { storedCount } = await runExtract(store, path.join(tmpDir, "base"), "聊聊检索架构演进", [
      { content: newContent, type: "episodic", priority: 60, source_message_ids: [1], certainty: "observed", occurred_at: new Date().toISOString() },
    ], { enableDedup: false, vectorStore: store, embeddingService: embedding });
    const links = linksOf(store).filter((l) => l.type === "similar");
    const edge = links.find((l) => l.target_id === "old-t9-nodedup");
    console.log(`  stored=${storedCount} similarEdges=${JSON.stringify(links)}`);
    check("[4] 提取成功 1 条", storedCount === 1);
    check("[4] 存在指向旧记忆的 similar 边", edge !== undefined);
    if (edge) {
      check("[4] strength == 手算 cosine（±1e-6，真值非 0.5 兜底）", Math.abs(edge.strength - expected) <= TOLERANCE, `got=${edge.strength.toFixed(8)} expected=${expected.toFixed(8)}`);
    }
  });
}

// ── 断言组 5：clean-fake-edges（拍板②）─────────────────────────
console.log("\n[5] clean-fake-edges：dry-run 零删除；--apply 恰好删 2 条假边；合法边保留");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t9-g5-"));
  try {
    const dbPath = path.join(tmpDir, "vectors.db");
    const store = new VectorStore(dbPath, 0, console as never);
    store.init();
    const raw = store.getRawDb();
    // 合法边：merge similar（strength=1 语义保留）、conflict（strength=1）、真 cosine（0.62）
    raw.prepare("INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?,?,?,?,?)")
      .run("a", "b", "similar", 1, "2026-09-01T00:00:00Z");
    raw.prepare("INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?,?,?,?,?)")
      .run("a", "c", "conflict", 1, "2026-09-01T00:00:00Z");
    raw.prepare("INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?,?,?,?,?)")
      .run("d", "e", "similar", 0.62, "2026-09-01T00:00:00Z");
    // 假边：旧常量 0.8 / 0.5
    raw.prepare("INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?,?,?,?,?)")
      .run("f1", "f2", "similar", 0.8, "2026-09-01T00:00:00Z");
    raw.prepare("INSERT INTO l1_links (source_id, target_id, type, strength, created_at) VALUES (?,?,?,?,?)")
      .run("f3", "f4", "similar", 0.5, "2026-09-01T00:00:00Z");
    store.close();

    const dry = cleanFakeEdges(dbPath, false);
    check("[5] dry-run 命中 2 条", dry.matched === 2 && dry.hits.length === 2, `matched=${dry.matched}`);
    check("[5] dry-run 零删除（applied=false）", dry.applied === false && dry.deleted === 0);

    const apply = cleanFakeEdges(dbPath, true);
    check("[5] --apply 删除计数 = 2", apply.applied === true && apply.deleted === 2);

    const store2 = new VectorStore(dbPath, 0, console as never);
    store2.init();
    const rest = store2.getRawDb().prepare("SELECT source_id, target_id, type, strength FROM l1_links").all() as unknown as LinkRow[];
    store2.close();
    check("[5] 剩余 3 条（合法边全保留）", rest.length === 3, `rest=${JSON.stringify(rest)}`);
    check("[5] 假边已消失", !rest.some((l) => (Math.abs(l.strength - 0.8) < 1e-9 || Math.abs(l.strength - 0.5) < 1e-9) && l.type === "similar"));
    check("[5] strength=1 merge/conflict 边与真 cosine 边仍在",
      rest.some((l) => l.source_id === "a" && l.target_id === "b" && l.strength === 1) &&
      rest.some((l) => l.source_id === "a" && l.target_id === "c" && l.type === "conflict") &&
      rest.some((l) => l.source_id === "d" && l.target_id === "e" && Math.abs(l.strength - 0.62) < 1e-9));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

// ── 断言组 6：相似度门槛（审查 I-1 修补）─────────────────────────
console.log("\n[6] 最低相似度门槛：余弦≈0 的新旧记忆对不建 similar 边（宁缺毋滥，两条路径都验）");
{
  // hashEmbed 按 2 字滑窗分桶：两组文本零共享 2-gram → 余弦≈0（桶哈希碰撞使
  // 实测略高于 0，量级 ~0.1，远低于门槛即可；先自证前置）
  const oldContent = "用户偏好青竹本地部署大模型推理方案";
  const newContent = "今天天气晴朗适合出门散步放松心情";
  const expectCos = cosine(hashEmbed(newContent), hashEmbed(oldContent));
  check("[6] 前置：新旧文本余弦低于门槛", expectCos < MIN_SIMILAR_STRENGTH, `cos=${expectCos.toFixed(6)} < ${MIN_SIMILAR_STRENGTH}`);
  const mem = [{
    content: newContent, type: "episodic", priority: 60, source_message_ids: [1], certainty: "observed", occurred_at: new Date().toISOString(),
  }];

  // 6a. dedup 路径：attachTopCandidates 门槛之下不附 top_candidate → 无 similar 边
  await withTempStore("g6-dedup", async (store, tmpDir) => {
    store.upsertL1(mkOldRecord("old-t9-zero-dedup", oldContent), hashEmbed(oldContent));
    const { storedCount } = await runExtract(store, path.join(tmpDir, "base"), "聊聊散步的心情", mem,
      { enableDedup: true, vectorStore: store, embeddingService: embedding });
    const links = linksOf(store).filter((l) => l.type === "similar");
    console.log(`  [dedup] stored=${storedCount} similarEdges=${JSON.stringify(links)}`);
    check("[6a] 提取成功 1 条", storedCount === 1);
    check("[6a] 余弦≈0 不建边（修复前：strength=0 假边）", links.length === 0, `similar 边数=${links.length}`);
  });

  // 6b. no-dedup 路径：storeAllDirectly top-1 门槛之下不建边
  await withTempStore("g6-nodedup", async (store, tmpDir) => {
    store.upsertL1(mkOldRecord("old-t9-zero-nodedup", oldContent), hashEmbed(oldContent));
    const { storedCount } = await runExtract(store, path.join(tmpDir, "base"), "聊聊散步的心情", mem,
      { enableDedup: false, vectorStore: store, embeddingService: embedding });
    const links = linksOf(store).filter((l) => l.type === "similar");
    console.log(`  [no-dedup] stored=${storedCount} similarEdges=${JSON.stringify(links)}`);
    check("[6b] 提取成功 1 条", storedCount === 1);
    check("[6b] 余弦≈0 不建边（修复前：strength=0 假边）", links.length === 0, `similar 边数=${links.length}`);
  });
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
console.log(`总体：${fail === 0 ? "ALL PASS" : "FAIL"}（${pass} pass, ${fail} fail）`);
process.exit(fail === 0 ? 0 : 1);
