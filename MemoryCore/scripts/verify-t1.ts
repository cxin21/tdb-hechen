/**
 * Task T1 同形验证（阶段四第一波·TCVDB 缺口小四项）：
 *   T1-A score 刻度实证（代码级文档化——静态断言）
 *   T1-B tcvdb updateL1Metadata + bumpRecallCount（契约测试）
 *   T1-C tcvdb countL1VectorRows（契约测试）
 *   T1-D native-hybrid 路径补 reconsolidation（行为断言，修复前 FAIL）
 *
 * 验证约束（brief）：无 tcvdb 本地实例 —— 同形验证 = mock/契约测试。
 * B/C 段用**真实 TcvdbMemoryStore** + 注入 FakeTcvdbClient（内存文档表，形状对齐
 * sqlite 语义与 TcvdbClient HTTP 契约：query/upsert/count），驱动的是生产实现代码，
 * 不是测试替身自身的影子断言。真机实证（score 刻度、retrieveVector 回读形态、
 * embedding 集合 upsert 行为）登记为部署时任务（spec §6.4 先例）。
 *
 * 三部分证据：
 *   [A] T1-A 静态证据：docs/tcvdb-score-semantics.md 存在且含关键结论；
 *       tcvdb.ts searchL1Vector 处有权威注释块（T1-A 标记）。
 *   [B] T1-B/T1-C 契约测试：metadata 合并 / 损坏 JSON 防护（对齐 sqlite 语义：
 *       updateL1Metadata 损坏→{}合并、bumpRecallCount 损坏/非对象→拒绝写入）/
 *       bump 幂等语义（无值从 0 起、原值 +1、保留其它字段）/ 计数容错。
 *   [D] T1-D 行为：executeMemorySearch native-hybrid 路径（mock store
 *       getCapabilities().nativeHybridSearch=true）命中 observed → bumpRecallCount
 *       递增（修复前早退跳过 reconsolidation → FAIL）；T2 门（inferred 不重巩固）
 *       与 feature-detect 回退（仅 updateL1Metadata）在 native-hybrid 路径同样生效。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-t1.ts
 *
 * 只用自建内存 fake，不连任何线上资源（不碰 D:/tdai-data）。
 */
import fs from "node:fs";

import { TcvdbMemoryStore } from "../src/core/store/tcvdb.js";
import type { TcvdbClient } from "../src/core/store/tcvdb-client.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import type { MemorySearchResultItem } from "../src/core/tools/memory-search.js";
import type { L1SearchResult } from "../src/core/store/types.js";
import type { Logger } from "../src/types.js";

// ── FakeTcvdbClient：内存文档表，只实现被测路径用到的 query/upsert/count ──
class FakeTcvdbClient {
  /** collection → (id → doc) */
  readonly collections = new Map<string, Map<string, Record<string, unknown>>>();
  failQuery = false;
  failUpsert = false;
  failCount = false;
  upsertCalls: Array<{ collection: string; docs: Array<Record<string, unknown>> }> = [];
  queryCalls: Array<Record<string, unknown>> = [];

  collectionOf(name: string): Map<string, Record<string, unknown>> {
    let m = this.collections.get(name);
    if (!m) {
      m = new Map();
      this.collections.set(name, m);
    }
    return m;
  }

  seed(collection: string, doc: Record<string, unknown>): void {
    this.collectionOf(collection).set(String(doc.id), { ...doc });
  }

  doc(collection: string, id: string): Record<string, unknown> | undefined {
    const d = this.collectionOf(collection).get(id);
    return d ? { ...d } : undefined;
  }

  /**
   * 注意：fake 实现的是 **TcvdbClient 的方法级契约**（注入边界），不是 HTTP 信封——
   * 真实 TcvdbClient 在 request() 里拆信封（upsert 无返回值、count 返回 number、
   * query 返回 {documents}）。store.client 被替换后调用直达 fake，拆封层不在链上。
   */
  async upsert(collection: string, documents: Array<Record<string, unknown>>): Promise<void> {
    if (this.failUpsert) throw new Error("fake upsert failure");
    this.upsertCalls.push({ collection, docs: documents });
    const m = this.collectionOf(collection);
    for (const doc of documents) m.set(String(doc.id), { ...doc });
  }

  async query(collection: string, params: Record<string, unknown>): Promise<{ documents: Array<Record<string, unknown>> }> {
    if (this.failQuery) throw new Error("fake query failure");
    this.queryCalls.push(params);
    const m = this.collectionOf(collection);
    let docs = [...m.values()];
    const ids = params.documentIds as string[] | undefined;
    if (ids) docs = docs.filter((d) => ids.includes(String(d.id)));
    // retrieveVector=false 时不回 vector 字段（对齐 TcvdbClient 调用形态）
    const retrieveVector = params.retrieveVector === true;
    const outFields = params.outputFields as string[] | undefined;
    docs = docs.map((d) => {
      const copy: Record<string, unknown> = { ...d };
      if (!retrieveVector) delete copy.vector;
      if (outFields) {
        const filtered: Record<string, unknown> = {};
        for (const f of outFields) if (f in copy) filtered[f] = copy[f];
        // vector 字段不在 outputFields 里，retrieveVector=true 时单独携带
        if (retrieveVector && "vector" in copy) filtered.vector = copy.vector;
        return filtered;
      }
      return copy;
    });
    return { documents: docs };
  }

  async count(collection: string): Promise<number> {
    if (this.failCount) throw new Error("fake count failure");
    return this.collectionOf(collection).size;
  }
}

/** 用真实 TcvdbMemoryStore + 注入 fake client 构造被测实例（绕过 HTTP init）。 */
function makeStore(
  fake: FakeTcvdbClient,
  opts: { embeddingEnabled?: boolean } = {},
): TcvdbMemoryStore {
  const store = new TcvdbMemoryStore({
    url: "http://127.0.0.1:1",
    username: "root",
    apiKey: "verify-t1",
    database: "verify_t1",
    embeddingModel: "verify-model",
    timeout: 100,
    embeddingEnabled: opts.embeddingEnabled ?? true,
  });
  const inner = store as unknown as { client: unknown; _initPromise: unknown };
  inner.client = fake as unknown as TcvdbClient;
  inner._initPromise = Promise.resolve();
  return store;
}

const L1_COLLECTION = "verify_t1_l1_memories";
const NOW_SEED_MS = Date.parse("2026-09-10T00:00:00Z");

function seedDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m_t1_seed",
    text: "T1 契约测试种子记录",
    type: "episodic",
    priority: 70,
    scene_name: "verify-t1",
    team_id: "",
    user_id: "",
    agent_id: "",
    version: 0,
    session_key: "k",
    session_id: "verify-t1",
    task_id: "",
    timestamp_str: "2026-09-01T00:00:00Z",
    timestamp_start: "2026-09-01T00:00:00Z",
    timestamp_end: "2026-09-01T00:00:00Z",
    created_time_ms: NOW_SEED_MS,
    updated_time_ms: NOW_SEED_MS,
    metadata_json: "{}",
    memory_type: "default",
    occurred_at: "",
    valid_start: "",
    valid_end: "",
    certainty: "observed",
    source: "",
    valence: null,
    arousal: null,
    significance: null,
    vector: [0.1, 0.2, 0.3],
    ...over,
  };
}

const parseJson = (s: unknown): Record<string, unknown> => {
  try {
    const v = JSON.parse(String(s ?? "{}")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const normalizeObj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return parseJson(v);
};

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(normalizeObj(a)) === JSON.stringify(normalizeObj(b));

// ── [D] 段 mock store：native-hybrid 路径（不触 tcvdb，纯内存对象）──
interface NativeMockCalls {
  bump: Array<{ id: string; now?: string }>;
  update: Array<{ id: string; patch: Record<string, unknown> }>;
}

function makeNativeHybridMock(opts: {
  certainty?: string;
  metadataJson?: string;
  withBump: boolean;
}): { store: never; calls: NativeMockCalls } {
  const calls: NativeMockCalls = { bump: [], update: [] };
  const item: Partial<L1SearchResult> = {
    record_id: "m_native_obs",
    content: "native-hybrid 命中",
    type: "episodic",
    priority: 70,
    scene_name: "verify-t1",
    score: 0.02, // TCVDB RRF 融合分刻度（≤0.0328）
    timestamp_str: "2026-09-01T00:00:00Z",
    timestamp_start: "2026-09-01T00:00:00Z",
    timestamp_end: "2026-09-01T00:00:00Z",
    session_key: "k",
    session_id: "verify-t1",
    team_id: "",
    task_id: "",
    user_id: "",
    agent_id: "",
    version: 0,
    metadata_json: opts.metadataJson ?? "{}",
    certainty: opts.certainty,
  };
  const store: Record<string, unknown> = {
    isFtsAvailable: () => true,
    isDegraded: () => false,
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: true,
      nativeHybridSearch: true,
      sparseVectors: true,
    }),
    searchL1Hybrid: async () => [item as L1SearchResult],
    updateL1Metadata: (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch });
      return true;
    },
  };
  if (opts.withBump) {
    store.bumpRecallCount = (id: string, now?: string) => {
      calls.bump.push({ id, now });
      return true;
    };
  }
  return { store: store as never, calls };
}

const quietLogger = {
  info: () => {},
  warn: (m: string) => console.log(`  [search:warn] ${m}`),
  debug: () => {},
} as never as Logger;

const tick = () => new Promise((r) => setTimeout(r, 30));

// ═══════════════════════════════════════════════════════════════
// [A] T1-A 静态证据
// ═══════════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] T1-A 静态证据：score 语义文档 + searchL1Vector 权威注释块");
console.log("=".repeat(72));

let aPass = false;
{
  const docPath = new URL("../docs/tcvdb-score-semantics.md", import.meta.url);
  const docExists = fs.existsSync(docPath);
  const docText = docExists ? fs.readFileSync(docPath, "utf8") : "";
  const docHasRRF = docText.includes("RRF");
  const docHasScale = docText.includes("0.0328");
  const docHasSqliteRef = docText.includes("1 - distance") || docText.includes("1-distance");
  const docHasReverify = docText.includes("真机复验");
  console.log(`docs/tcvdb-score-semantics.md 存在：${docExists}`);
  console.log(`  含 RRF 结论：${docHasRRF}；含 RRF 上限 0.0328：${docHasScale}；含 sqlite 1-distance 对照：${docHasSqliteRef}；含真机复验：${docHasReverify}`);

  const tcvdbSrc = fs.readFileSync(new URL("../src/core/store/tcvdb.ts", import.meta.url), "utf8");
  const commentInPlace = tcvdbSrc.includes("T1-A") && tcvdbSrc.includes("score 语义");
  const minSimCovered = tcvdbSrc.includes("MIN_SIMILAR_STRENGTH");
  console.log(`tcvdb.ts 权威注释块在位（T1-A 标记 + score 语义）：${commentInPlace}；覆盖 MIN_SIMILAR_STRENGTH 影响：${minSimCovered}`);

  aPass = docExists && docHasRRF && docHasScale && docHasSqliteRef && docHasReverify && commentInPlace && minSimCovered;
  console.log(aPass ? "[A] PASS" : "[A] FAIL（RED 阶段预期：文档/注释未落地）");
}

// ═══════════════════════════════════════════════════════════════
// [B] T1-B 契约测试 + [C] T1-C countL1VectorRows
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] T1-B 契约测试：tcvdb updateL1Metadata / bumpRecallCount（对齐 sqlite 语义）");
console.log("=".repeat(72));

let bPass = false;
const bFailures: string[] = [];
const bCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) bFailures.push(name);
};

try {
  const hasNewMethods = (() => {
    const s = makeStore(new FakeTcvdbClient());
    return (
      typeof (s as unknown as Record<string, unknown>).updateL1Metadata === "function" &&
      typeof (s as unknown as Record<string, unknown>).bumpRecallCount === "function" &&
      typeof (s as unknown as Record<string, unknown>).countL1VectorRows === "function"
    );
  })();

  if (!hasNewMethods) {
    console.log("  FAIL: TcvdbMemoryStore 缺 updateL1Metadata / bumpRecallCount / countL1VectorRows（RED 阶段预期）");
    bFailures.push("方法未实现");
  } else {
    // ── B1 updateL1Metadata：合并 patch，保留其它字段，touch updated_time ──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: JSON.stringify({ a: 1, keep: "x" }) }));
      const store = makeStore(fake);
      const ok = await store.updateL1Metadata("m_t1_seed", { b: 2 });
      const after = fake.doc(L1_COLLECTION, "m_t1_seed");
      bCheck("updateL1Metadata 返回 true", ok === true, `got ${String(ok)}`);
      bCheck(
        "metadata 合并 {a:1,keep:x}+{b:2}",
        after !== undefined && sameJson(after.metadata_json, { a: 1, keep: "x", b: 2 }),
        `got ${String(after?.metadata_json)}`,
      );
      bCheck(
        "updated_time_ms 被刷新",
        after !== undefined && Number(after.updated_time_ms) > NOW_SEED_MS,
        `got ${String(after?.updated_time_ms)}`,
      );
      bCheck(
        "content/text 未被重写",
        after?.text === "T1 契约测试种子记录" && after?.certainty === "observed",
      );
      bCheck(
        "向量字段保留（retrieveVector 读回后随写回携带）",
        after !== undefined && Array.isArray(after.vector),
        `got ${String(after?.vector)}`,
      );
    }

    // ── B2 updateL1Metadata：损坏 JSON → {} 合并（sqlite :2555 catch→{} 同语义）──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "{bad json" }));
      const store = makeStore(fake);
      const ok = await store.updateL1Metadata("m_t1_seed", { recall_count: 1 });
      const after = fake.doc(L1_COLLECTION, "m_t1_seed");
      bCheck("updateL1Metadata 损坏 JSON 仍成功（宽容合并）", ok === true, `got ${String(ok)}`);
      bCheck(
        "损坏 JSON 合并结果 = patch（meta 视为 {}）",
        after !== undefined && sameJson(after.metadata_json, { recall_count: 1 }),
        `got ${String(after?.metadata_json)}`,
      );
    }

    // ── B3 updateL1Metadata：行不存在 → false ──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc());
      const store = makeStore(fake);
      const ok = await store.updateL1Metadata("m_missing", { b: 2 });
      bCheck("updateL1Metadata 行不存在 → false", ok === false, `got ${String(ok)}`);
      bCheck("行不存在时不触发 upsert", fake.upsertCalls.length === 0);
    }

    // ── B4 updateL1Metadata：查询失败 → false（不抛）──
    {
      const fake = new FakeTcvdbClient();
      fake.failQuery = true;
      const store = makeStore(fake);
      const ok = await store.updateL1Metadata("m_t1_seed", { b: 2 });
      bCheck("updateL1Metadata 查询失败 → false（容错不抛）", ok === false, `got ${String(ok)}`);
    }

    // ── B5 bumpRecallCount：原值 +1，保留其它字段，写 last_recalled_at ──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: JSON.stringify({ recall_count: 2, other: "v" }) }));
      const store = makeStore(fake);
      const ok = await store.bumpRecallCount("m_t1_seed", "2026-09-10T12:00:00Z");
      const after = fake.doc(L1_COLLECTION, "m_t1_seed");
      const meta = parseJson(after?.metadata_json);
      bCheck("bumpRecallCount 返回 true", ok === true, `got ${String(ok)}`);
      bCheck("recall_count 2→3（真实累加）", meta.recall_count === 3, `got ${String(meta.recall_count)}`);
      bCheck("last_recalled_at = 入参 now", meta.last_recalled_at === "2026-09-10T12:00:00Z", `got ${String(meta.last_recalled_at)}`);
      bCheck("其它 metadata 字段保留（other=v）", meta.other === "v");
    }

    // ── B6 bumpRecallCount：无 recall_count → 从 0 起得 1（sqlite COALESCE 同语义）──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "{}" }));
      const store = makeStore(fake);
      const ok = await store.bumpRecallCount("m_t1_seed");
      const meta = parseJson(fake.doc(L1_COLLECTION, "m_t1_seed")?.metadata_json);
      bCheck("bumpRecallCount 无值 → 1", ok === true && meta.recall_count === 1, `ok=${String(ok)} count=${String(meta.recall_count)}`);
    }

    // ── B7 bumpRecallCount：损坏 JSON → 拒绝写入（sqlite json_valid 防护同语义）──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "{bad json" }));
      const store = makeStore(fake);
      const ok = await store.bumpRecallCount("m_t1_seed");
      bCheck("bumpRecallCount 损坏 JSON → false（拒绝半写）", ok === false, `got ${String(ok)}`);
      bCheck("损坏 JSON 不触发 upsert（无半写）", fake.upsertCalls.length === 0);
    }

    // ── B8 bumpRecallCount：合法但非对象态（'[]'）→ 显式拒绝（sqlite json_type 同语义）──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "[]" }));
      const store = makeStore(fake);
      const ok = await store.bumpRecallCount("m_t1_seed");
      bCheck("bumpRecallCount 非对象态 → false", ok === false, `got ${String(ok)}`);
      bCheck("非对象态不触发 upsert", fake.upsertCalls.length === 0);
    }

    // ── B9 bumpRecallCount：行不存在 → false ──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc());
      const store = makeStore(fake);
      const ok = await store.bumpRecallCount("m_missing");
      bCheck("bumpRecallCount 行不存在 → false", ok === false, `got ${String(ok)}`);
    }

    // ── B10 upsert 失败 → false（不抛）──
    {
      const fake = new FakeTcvdbClient();
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "{}" }));
      fake.failUpsert = true;
      const store = makeStore(fake);
      const okUpd = await store.updateL1Metadata("m_t1_seed", { b: 2 });
      const okBump = await store.bumpRecallCount("m_t1_seed");
      bCheck("upsert 失败：updateL1Metadata/bumpRecallCount → false", okUpd === false && okBump === false, `upd=${String(okUpd)} bump=${String(okBump)}`);
    }

    // ── B11 非 embedding 集合：读-改-写回填占位向量 [1]（与 upsertL1 同形态）──
    {
      const fake = new FakeTcvdbClient();
      // 非 embedding 集合的 query 不回 vector（模拟 retrieveVector 拿不到向量形态）
      fake.seed(L1_COLLECTION, seedDoc({ metadata_json: "{}", vector: undefined }));
      const store = makeStore(fake, { embeddingEnabled: false });
      const ok = await store.updateL1Metadata("m_t1_seed", { b: 2 });
      const after = fake.doc(L1_COLLECTION, "m_t1_seed");
      bCheck(
        "非 embedding 集合写回占位 vector=[1]",
        ok === true && Array.isArray(after?.vector) && (after?.vector as number[]).length === 1,
        `got ${String(after?.vector)}`,
      );
    }
  }

  bPass = bFailures.length === 0;
  console.log(bPass ? "[B] PASS" : `[B] FAIL（${bFailures.length} 项）`);
} catch (err) {
  console.log(`[B] FAIL（异常，RED 阶段典型）: ${err instanceof Error ? err.message : String(err)}`);
  bFailures.push("exception");
}

console.log("");
console.log("=".repeat(72));
console.log("[C] T1-C 契约测试：tcvdb countL1VectorRows");
console.log("=".repeat(72));

let cPass = false;
const cFailures: string[] = [];
const cCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) cFailures.push(name);
};

try {
  const fake = new FakeTcvdbClient();
  fake.seed(L1_COLLECTION, seedDoc({ id: "a" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "b" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "c" }));
  const store = makeStore(fake);
  const n = await store.countL1VectorRows();
  cCheck("countL1VectorRows 返回 collection 文档数（TCVDB 文档即向量行）", n === 3, `got ${String(n)}`);

  const emptyStore = makeStore(new FakeTcvdbClient());
  const zero = await emptyStore.countL1VectorRows();
  cCheck("空集合 → 0", zero === 0, `got ${String(zero)}`);

  const failFake = new FakeTcvdbClient();
  failFake.failCount = true;
  const failStore = makeStore(failFake);
  const errN = await failStore.countL1VectorRows();
  cCheck("count 失败 → 0（非致命容错，对齐 sqlite）", errN === 0, `got ${String(errN)}`);

  cPass = cFailures.length === 0;
  console.log(cPass ? "[C] PASS" : `[C] FAIL（${cFailures.length} 项）`);
} catch (err) {
  console.log(`[C] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  cFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// [D] T1-D 行为断言：native-hybrid 路径 reconsolidation
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] T1-D：executeMemorySearch native-hybrid 路径补 reconsolidation");
console.log("=".repeat(72));

let dPass = false;
const dFailures: string[] = [];
const dCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) dFailures.push(name);
};

try {
  // D1：observed 命中 → bumpRecallCount 被调（修复前早退跳过 → FAIL/RED）
  {
    const { store, calls } = makeNativeHybridMock({ certainty: "observed", withBump: true });
    const res = await executeMemorySearch({
      query: "native hybrid probe",
      limit: 5,
      vectorStore: store,
      logger: quietLogger,
    });
    await tick();
    dCheck("native-hybrid 命中返回结果", res.results.length === 1 && res.results[0]?.id === "m_native_obs", `total=${res.total}`);
    dCheck(
      "observed 命中 → bumpRecallCount 调用 1 次（RED 阶段为 0）",
      calls.bump.length === 1 && calls.bump[0]?.id === "m_native_obs",
      `calls=${JSON.stringify(calls.bump)}`,
    );
  }

  // D2：T2 门 —— inferred 不重巩固
  {
    const { store, calls } = makeNativeHybridMock({ certainty: "inferred", withBump: true });
    await executeMemorySearch({
      query: "native hybrid probe",
      limit: 5,
      vectorStore: store,
      logger: quietLogger,
    });
    await tick();
    dCheck("T2 门：inferred 不触发 bumpRecallCount", calls.bump.length === 0, `calls=${JSON.stringify(calls.bump)}`);
  }

  // D3：feature-detect 回退（仅 updateL1Metadata）在 native-hybrid 路径同样生效，
  //     且 prevCount 从召回 item 的 metadata 读真值（C1 起 metadata_json 读回）。
  {
    const { store, calls } = makeNativeHybridMock({
      certainty: "observed",
      withBump: false,
      metadataJson: JSON.stringify({ recall_count: 4 }),
    });
    await executeMemorySearch({
      query: "native hybrid probe",
      limit: 5,
      vectorStore: store,
      logger: quietLogger,
    });
    await tick();
    const upd = calls.update[0];
    dCheck(
      "回退路径 updateL1Metadata 以 prevCount+1 调用（4→5）",
      calls.update.length === 1 && upd?.id === "m_native_obs" && upd.patch.recall_count === 5,
      `calls=${JSON.stringify(calls.update)}`,
    );
  }

  dPass = dFailures.length === 0;
  console.log(dPass ? "[D] PASS" : `[D] FAIL（${dFailures.length} 项；RED 阶段预期 D1/D3 FAIL）`);
} catch (err) {
  console.log(`[D] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  dFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// 总裁决
// ═══════════════════════════════════════════════════════════════
const allPass = aPass && bPass && cPass && dPass;
console.log("");
console.log(
  `总体：${allPass ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}, C=${cPass ? "PASS" : "FAIL"}, D=${dPass ? "PASS" : "FAIL"}）`,
);
process.exit(allPass ? 0 : 1);

// 引用占位（保证 MemorySearchResultItem 类型参与编译期检查：mock 形状漂移编译报错）
export type { MemorySearchResultItem };
