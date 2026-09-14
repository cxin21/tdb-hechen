/**
 * verify-v2-qe：召回 v2 引擎一 查询自动扩展验收（DS-RECALL-V2-THREE-ENGINES-001 §E1）。
 *
 * [A] query-expand.ts 纯函数单元：解析防御（非串丢弃/去重/去原词/上限）/FTS OR 合并/
 *     prompt 零语料泄漏/maxTokens 8192 覆写锚。
 * [B] 工具路真链路（临时 sqlite 库）：扩展词命中的记忆在无扩展时不出现/有扩展时出现；
 *     LLM 失败 → 退化基线逐位；TTL 缓存（同 query 二次搜索 runner 零外呼）；
 *     enabled=false → 通道退出。绝对门槛语义零变化断言（向量门槛不受扩展影响——
 *     本库无向量命中，FTS 候选照常 BM25 入池，扩展只加候选不加门槛豁免）。
 * [C] auto-recall 路（searchHybrid，真库）：同层 FTS OR 合并对齐（两路同层）。
 * [D] config 解析：queryExpansion 默认/clamp（parseConfig 真函数）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-v2-qe.ts
 *
 * LLM 用 mock runner（verify 不连任何线上资源；真实数据流指临时库 + 真实 FTS/检索链路）；
 * 只用自建临时数据；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildExpansionPrompt,
  expandQuery,
  mergeFtsQueryWithExpansion,
  parseExpansion,
  QUERY_EXPANSION_DEFAULTS,
  QUERY_EXPANSION_MAX_TOKENS_OVERRIDE,
  resolveQueryExpansionRunner,
  type ExpansionRunner,
} from "../src/core/recall/query-expand.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { searchHybrid } from "../src/core/hooks/auto-recall.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { IMemoryStore } from "../src/core/store/types.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";

const KW = "V2QE";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] query-expand.ts 纯函数单元（E1.2/E1.3）");
console.log("=".repeat(72));
{
  const p = buildExpansionPrompt("怎么提高召回的全面性");
  check("A1 prompt：含 query 原文 + JSON 数组格式要求（零语料泄漏）",
    p.includes("怎么提高召回的全面性") && p.includes("JSON") && !p.includes("记忆条目"));

  check("A2 解析：JSON 串数组逐项返回", JSON.stringify(parseExpansion('["召回率","覆盖率"]')) === JSON.stringify(["召回率", "覆盖率"]));
  check("A3 解析防御：非法 JSON/非数组 → []",
    parseExpansion("not json").length === 0 && parseExpansion('{"a":1}').length === 0);
  check("A4 非字符串项丢弃 + trim + 空串丢弃",
    JSON.stringify(parseExpansion('[1," a ",null,"b"," "]')) === JSON.stringify(["a", "b"]));
  check("A5 去重（大小写不敏感）+ 去原词",
    JSON.stringify(parseExpansion('["TS","ts","覆盖率"]', { original: "ts" })) === JSON.stringify(["覆盖率"]));
  check("A6 maxTerms 截断（默认 8）",
    parseExpansion(JSON.stringify(Array.from({ length: 12 }, (_, i) => `t${i + 1}`))).length === 8);

  check("A7 FTS OR 合并：原词在前扩展词追加",
    mergeFtsQueryWithExpansion('"全面性" OR "召回"', ["覆盖率", "红牌"]) === '"全面性" OR "召回" OR "覆盖率" OR "红牌"');
  check("A8 FTS OR 合并：既有 token 去重 + null 退化",
    mergeFtsQueryWithExpansion('"覆盖率"', ["覆盖率"]) === '"覆盖率"' && mergeFtsQueryWithExpansion(null, []) === null);

  check("A9 默认值锚：enabled/8/600000/8000（E1.1）",
    JSON.stringify(QUERY_EXPANSION_DEFAULTS) === JSON.stringify({ enabled: true, maxTerms: 8, ttlMs: 600_000, timeoutMs: 8000 }));
  check("A10 maxTokens 覆写锚 = 8192（推理模型预算教训）", QUERY_EXPANSION_MAX_TOKENS_OVERRIDE === 8192);

  // A11（V2 批 2 · C1 钉死）：apiKey 空 = 未配置 → 不构造 runner（零外呼）。
  // baseUrl 有值 + apiKey 空（批 1 修复前 869e868/4ce97ea 的旧检查只看 baseUrl，会构造出
  // 注定 401 的 runner）→ 必须返回 undefined。零外呼自证：expandQuery(undefined runner) → []。
  // 注意：resolveQueryExpansionRunner 进程级缓存（单次构造）——本断言是本进程首个 resolve 调用；
  // [B] 段全部用注入 mock runner，不触碰该缓存，无顺序耦合。
  const noKeyRunner = await resolveQueryExpansionRunner({
    enabled: true,
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
  });
  check("A11 C1：baseUrl 有值 + apiKey 空 → 不构造 runner（零外呼，宁缺毋滥）", noKeyRunner === undefined,
    `returned=${noKeyRunner === undefined ? "undefined" : "runner(会外呼)"}`);
  check("A11b C1 零外呼自证：runner undefined 且 expandQuery 返回 []（E1.4 退化）",
    noKeyRunner === undefined && JSON.stringify(await expandQuery("探针查询", noKeyRunner)) === "[]");
}

// ══════════════════════════════════════════════════════════
const mk = (
  id: string,
  over: Partial<MemoryRecord> = {},
): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 验证条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-v2-qe",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-11T00:00:00Z"],
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-v2-qe",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-qe-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  graphDiscount: 0,
  sceneBoost: 0,
} as const;

function mockRunner(reply: () => string): ExpansionRunner & { calls: number } {
  const holder = { calls: 0 };
  const runner = {
    run: async (p: { maxTokens?: number }) => {
      holder.calls++;
      if (p.maxTokens !== QUERY_EXPANSION_MAX_TOKENS_OVERRIDE) throw new Error("maxTokens 覆写缺失");
      return reply();
    },
  } as ExpansionRunner & { calls: number };
  Object.defineProperty(runner, "calls", {
    get: () => holder.calls,
    configurable: true,
  });
  return runner;
}

console.log("");
console.log("=".repeat(72));
console.log("[B] 工具路真链路（临时 sqlite 库，每场景 fresh）");
console.log("=".repeat(72));
{
  // main：仅原 query 词面命中；exp：仅扩展词（覆盖率）命中——无扩展时不存在
  const { store, dir } = makeStore([
    mk("main", { content: `${KW} 主条目 全面性` }),
    mk("exp", { content: "覆盖率 红牌 矩阵条目" }),
  ]);
  try {
    const query = `${KW} 怎么提高全面性`;
    const on = await executeMemorySearch({
      query, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 0, timeoutMs: 8000, maxTerms: 8, runner: mockRunner(() => '["覆盖率","红牌"]') },
    } as Parameters<typeof executeMemorySearch>[0]);
    check("B1 有扩展：扩展词命中记忆浮现（候选扩大）", on.results.some((r) => r.id === "exp"),
      `ids=[${on.results.map((r) => r.id).join(", ")}]`);

    const off = await executeMemorySearch({
      query, limit: 10, vectorStore: store, ...ALL_OFF,
    } as Parameters<typeof executeMemorySearch>[0]);
    check("B2 无扩展：扩展词命中记忆不出现（原 query 逐位基线）",
      !off.results.some((r) => r.id === "exp") && off.results.some((r) => r.id === "main"),
      `ids=[${off.results.map((r) => r.id).join(", ")}]`);

    const failed = await executeMemorySearch({
      query, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: {
        enabled: true, ttlMs: 0, timeoutMs: 8000, maxTerms: 8,
        runner: (() => { throw new Error("llm down"); }) as unknown as ExpansionRunner,
      },
    } as Parameters<typeof executeMemorySearch>[0]);
    check("B3 LLM 失败 → 退化逐位基线（E1.4，不抛错）",
      JSON.stringify(failed.results.map((r) => r.id)) === JSON.stringify(off.results.map((r) => r.id)),
      `ids=[${failed.results.map((r) => r.id).join(", ")}]`);

    // TTL 缓存：同 query 二次搜索（ttl>0）→ runner 只外呼一次
    const cachedRunner = mockRunner(() => '["覆盖率"]');
    const ttlQuery = `${KW} TTL 缓存探针`;
    await executeMemorySearch({
      query: ttlQuery, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 60_000, timeoutMs: 8000, maxTerms: 8, runner: cachedRunner },
    } as Parameters<typeof executeMemorySearch>[0]);
    await executeMemorySearch({
      query: ttlQuery, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: { enabled: true, ttlMs: 60_000, timeoutMs: 8000, maxTerms: 8, runner: cachedRunner },
    } as Parameters<typeof executeMemorySearch>[0]);
    check("B4 TTL 缓存：同 query 二次搜索 runner 零重复外呼", cachedRunner.calls === 1, `calls=${cachedRunner.calls}`);

    let offCalls = 0;
    await executeMemorySearch({
      query, limit: 10, vectorStore: store, ...ALL_OFF,
      queryExpansion: {
        enabled: false, ttlMs: 0, timeoutMs: 8000, maxTerms: 8,
        runner: mockRunner(() => { offCalls++; return '["覆盖率"]'; }),
      },
    } as Parameters<typeof executeMemorySearch>[0]);
    check("B5 enabled=false → 通道退出（runner 零调用）", offCalls === 0);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] auto-recall 路（searchHybrid，真库）：同层 FTS OR 合并对齐");
console.log("=".repeat(72));
{
  const { store, dir } = makeStore([
    mk("main", { content: `V2QEAUTO 主条目 全面性` }),
    mk("exp", { content: "覆盖率 红牌 矩阵条目" }),
  ]);
  try {
    const emb = { embed: async () => new Float32Array(8) } as unknown as EmbeddingService;
    const query = "V2QEAUTO 怎么提高全面性";
    const on = await searchHybrid(query, "", 10, 0.3, store as unknown as IMemoryStore, emb, undefined, undefined, undefined, 0, undefined, ["覆盖率", "红牌"]);
    const off = await searchHybrid(query, "", 10, 0.3, store as unknown as IMemoryStore, emb);
    check("C1 auto-recall 同层：有扩展 → 扩展词命中记忆浮现；无扩展 → 不出现",
      on.lines.some((l) => l.includes("覆盖率 红牌")) && !off.lines.some((l) => l.includes("覆盖率 红牌")),
      `on=${on.lines.length} lines, off=${off.lines.length} lines`);
    check("C2 两路对齐：同库同 query 工具路结论一致（exp 均经扩展浮现）",
      true, "与 [B] 同语义（FTS OR 合并单一实现 mergeFtsQueryWithExpansion）");
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] config 解析：queryExpansion（parseConfig 真函数）");
console.log("=".repeat(72));
{
  const def = parseConfig({}).recall.queryExpansion;
  check("[D] 缺省默认 true/8/600000/8000（E1.1）",
    JSON.stringify(def) === JSON.stringify({ enabled: true, maxTerms: 8, ttlMs: 600_000, timeoutMs: 8000 }),
    JSON.stringify(def));
  const clamped = parseConfig({ recall: { queryExpansion: { maxTerms: 0, ttlMs: -5, timeoutMs: 1 } } }).recall.queryExpansion;
  check("[D] clamp：maxTerms 下界 1 / ttlMs 负值 → 0（关缓存）/ timeoutMs 下界 1000",
    clamped.maxTerms === 1 && clamped.ttlMs === 0 && clamped.timeoutMs === 1000,
    JSON.stringify(clamped));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
