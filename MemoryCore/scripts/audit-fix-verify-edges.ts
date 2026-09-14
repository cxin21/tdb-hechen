/**
 * E2E：store 决策也建 top-1 similar 边（dedup 主路径）。
 * mock LLM（提取→1条记忆; dedup→store）+ 确定性 embedding（相似文本→近向量）。
 * 预置旧记忆 → extractL1Memories 写入新记忆 → 断言 l1_links 出现 similar 边。
 * 用法: node --import tsx scripts/audit-fix-verify-edges.ts
 */
import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { LLMRunner } from "../src/types.js";
import { createHash } from "node:crypto";
import { rmSync, mkdirSync } from "node:fs";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

/** 确定性 embedding：单字+双字 滑窗 → 伪向量（共享词→高余弦）。 */
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
const embedding: EmbeddingService = {
  embed: async (t: string) => hashEmbed(t),
  embedBatch: async (ts: string[]) => ts.map((t) => hashEmbed(t)),
} as never;

let call = 0;
const llmRunner: LLMRunner = {
  run: async (p: { prompt: string }) => {
    call++;
    // 第一次调用 = L1 提取（scenes 数组 schema）；第二次 = dedup 判定
    if (call === 1) {
      return JSON.stringify([
        {
          scene_name: "对话情境",
          message_ids: [1],
          memories: [
            { content: "用户坚持对抗性审查风格，重视第一性原理分析", type: "episodic", priority: 60, source_message_ids: [1] },
          ],
        },
      ]);
    }
    // dedup 判定：store（无需合并）。record_id 留空 → parseBatchResult 跳过 → 默认 store（我们的目标路径）
    return JSON.stringify([{ record_id: "", action: "store", target_ids: [] }]);
  },
} as never;

const fsMod = await import("node:fs");
const dbPath = `scripts/.edges-e2e-${process.pid}.db`;
const baseDir = `scripts/.edges-e2e-base-${process.pid}`;
for (const x of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fsMod.rmSync(x, { force: true }); } catch {} }
try { fsMod.rmSync(baseDir, { recursive: true, force: true }); } catch {}
mkdirSync(baseDir, { recursive: true });

const vs = new VectorStore(dbPath, 64, console);
await vs.init();

// 预置旧记忆（与将提取的内容语义相近 → top-1 候选应命中它）。必须带向量（否则 searchL1Vector 搜不到）。
const now = new Date().toISOString();
vs.upsertL1({
  id: "old-edge-target", content: "用户重视对抗性审查与第一性原理分析", type: "episodic", priority: 60,
  scene_name: "s", source_message_ids: [], metadata: {}, timestamps: [now], occurred_at: now,
  certainty: "observed", createdAt: now, updatedAt: now, version: 1, sessionKey: "k", sessionId: "sid-old",
} as never, hashEmbed("用户重视对抗性审查与第一性原理分析"));

const result = await extractL1Memories({
  messages: [{ role: "user", content: "我们继续用对抗性审查的方式推进", timestamp: Date.now() } as never],
  sessionKey: "k-e2e",
  sessionId: "sid-new",
  baseDir,
  config: {},
  options: {
    enableDedup: true,
    enableMemoryLinks: true,
    maxMemoriesPerSession: 5,
    vectorStore: vs,
    embeddingService: embedding,
    llmRunner,
  },
  logger: console as never,
});

console.log(`extracted=${result.extractedCount} stored=${result.storedCount}`);
const links = (vs as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT source_id, target_id, type, strength FROM l1_links").all();
console.log("l1_links:", JSON.stringify(links));

check("提取成功 1 条", result.storedCount === 1);
check("l1_links 至少 1 条", links.length >= 1);
check("存在 similar 边指向旧记忆", links.some((l) => l.type === "similar" && l.target_id === "old-edge-target"));

await vs.destroy?.();
for (const x of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fsMod.rmSync(x, { force: true }); } catch {} }
try { fsMod.rmSync(baseDir, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);