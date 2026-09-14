/**
 * P3-T15 同形验证：向量健康三件套。
 *
 * G1 生产实锤（09-09）：向量写入静默死亡 36+ 小时，l1_vec_rowids 104 行 vs
 * l1_records 203+ 行；旧判据 l1-dedup `countL1()` 数的是元数据行 → 误判"向量可用"
 * → 坚持走 Tier1 向量召回（空转，0 候选）→ 永不降级 FTS → 建边/dedup 全线静默死。
 *
 * 三件套：
 *   T15-A 判据修正：countL1VectorRows()（vec0 shadow 表 l1_vec_rowids 真实行数）
 *         替换 countL1()；覆盖率 vecRows/metaRows < 0.9（部分死亡）仍走 Tier1 但
 *         warn 一次/进程"vector coverage low (x/y)"。
 *   T15-B /health 探活：buildMemoryHealth(stats) 纯函数 → memory 子对象
 *         { vectorCoverage, vecRows, metaRows, embedding: ok|degraded,
 *           degradedSince, lastVecWriteAt }；探针 embed-only 不写哨兵行（简化裁决）。
 *   T15-C 降级标注：executeMemorySearch FTS-only + embedding 已配置 →
 *         degraded=true + formatSearchResponse 含 [degraded: fts-only] 前缀 +
 *         两义措辞（向量层降级或相关度门滤除，审查 I-1）；向量路径无标注。
 *   [6] /health 接线断言（审查 I-2）：handleHealth 生产的 memory 子对象
 *         === buildMemoryHealth(collectMemoryHealthStats 输出)，
 *         钉死"生产 /health 消费 buildMemoryHealth"防未来改回旧构造。
 *
 * 五组同形验收（brief §验收）：
 *   [1] 判据修正：3 条元数据+0 向量 + embeddingService 存在 → batchDedup 走 FTS Tier
 *       （修复前旧判据 countL1>0 误判可用 → Tier1 空转 —— RED 断言）
 *   [2] 覆盖率 warn：10 条元数据+2 向量 → coverage 0.2 < 0.9 → warn 触发且只触发一次
 *   [3] health 字段：buildMemoryHealth 纯函数 → 字段齐全、degraded 翻转
 *   [4] 注入标注：FTS-only + embedding 配置存在 → degraded 标注；向量路径无标注
 *   [5] 旧后端回退：无 countL1VectorRows 的 mock store → 走 countL1 回退 + warn 一次
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p3-t15.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { batchDedup } from "../src/core/record/l1-dedup.js";
import { executeMemorySearch, formatSearchResponse } from "../src/core/tools/memory-search.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { Logger } from "../src/core/types.js";

const DIMS = 64;
const TAG_OK = "\x1b[32mPASS\x1b[0m";
const TAG_FAIL = "\x1b[31mFAIL\x1b[0m";

// ── 共享 fixture ─────────────────────────────────────────────

/** 确定性 64 维向量（所有调用返回同一向量 → 查询向量与已存向量 cosine=1）。 */
function fakeVector(): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(i + 1) * 0.5;
  return v;
}

/** 假 embeddingService：embed/embedBatch 恒返回同一确定性向量（不依赖文本）。 */
function fakeEmbeddingService(): EmbeddingService {
  return {
    embed: async () => fakeVector(),
    embedBatch: async (texts: string[]) => texts.map(() => fakeVector()),
  } as unknown as EmbeddingService;
}

/** 假 LLMRunner：dedup 判定恒返回 "[]"（全部 store），不外呼任何 LLM。 */
function fakeLlmRunner(): { run: (p: unknown) => Promise<string> } {
  return { run: async () => "[]" };
}

function makeRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-p3-t15",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-09T00:00:00Z"],
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p3-t15",
  } as MemoryRecord;
}

/** logger spy：收集 debug/warn/info 行，供分级行为断言。 */
function makeLoggerSpy(): { logger: Logger; debug: string[]; warn: string[]; info: string[] } {
  const debug: string[] = [];
  const warn: string[] = [];
  const info: string[] = [];
  const logger = {
    debug: (m: string) => debug.push(String(m)),
    warn: (m: string) => warn.push(String(m)),
    info: (m: string) => info.push(String(m)),
  } as unknown as Logger;
  return { logger, debug, warn, info };
}

const section = (title: string): void => {
  console.log("");
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
};

const results: Array<{ id: string; name: string; pass: boolean; note: string }> = [];
const record = (id: string, name: string, pass: boolean, note: string): void => {
  results.push({ id, name, pass, note });
  console.log(`[${id}] ${pass ? TAG_OK : TAG_FAIL}: ${name} — ${note}`);
};

// 唯一 ASCII 关键词：保证 FTS 命中且不受分词干扰
const KW = "T15PINZQ7X";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p3-t15-"));

try {
  // ── [1] 判据修正：3 元数据 + 0 向量 + embeddingService 存在 → 必须走 FTS Tier ──
  section("[1] 判据修正（G1）：3 条元数据 + 0 向量 + embeddingService 存在 → batchDedup 走 FTS Tier");
  {
    const dbPath = path.join(tmpDir, "t1.db");
    const store = new VectorStore(dbPath, DIMS);
    store.init();
    if (store.isDegraded()) {
      record("1", "判据修正", false, `临时库初始化降级（环境问题）：${dbPath}`);
    } else {
      // 写 3 条元数据（无 embedding → 0 向量行）
      for (let i = 0; i < 3; i++) {
        store.upsertL1(makeRecord(`meta-${i}`, `${KW} 收款账户配置说明 第${i}条`), undefined);
      }
      const metaRows = store.countL1();
      // T15-A 新方法：countL1VectorRows 必须存在且返回 0（修复前方法缺失 → 断言失败）
      const hasMethod = typeof (store as { countL1VectorRows?: unknown }).countL1VectorRows === "function";
      const vecRows = hasMethod ? (store as unknown as { countL1VectorRows(): number }).countL1VectorRows() : -1;

      // batchDedup：embeddingService 存在（旧判据 countL1>0 会误判向量可用 → Tier1 空转）
      const spy = makeLoggerSpy();
      await batchDedup({
        memories: [
          {
            content: `${KW} 收款账户配置补充说明（新记忆）`,
            type: "episodic",
            priority: 70,
            source_message_ids: [],
            metadata: {},
            scene_name: "verify-p3-t15",
            record_id: "new-1",
          },
        ],
        config: {},
        vectorStore: store,
        embeddingService: fakeEmbeddingService(),
        logger: spy.logger,
        llmRunner: fakeLlmRunner() as never,
      });

      const debugAll = spy.debug.join("\n");
      const wentFts = debugAll.includes("FTS keyword recall mode");
      const wentVector = debugAll.includes("vector recall mode");

      const pass = hasMethod && vecRows === 0 && metaRows === 3 && wentFts && !wentVector;
      record(
        "1",
        "判据修正",
        pass,
        `countL1VectorRows 存在=${hasMethod}, vecRows=${vecRows}, metaRows=${metaRows}, ` +
          `wentFts=${wentFts}, wentVector=${wentVector}` +
          (pass ? "" : "（修复前：旧判据 countL1>0 误判可用 → Tier1 空转）"),
      );
    }
    store.close();
  }

  // ── [2] 覆盖率 warn：10 元数据 + 2 向量 → coverage 0.2 < 0.9 → warn 一次（去重）──
  section("[2] 覆盖率分级 warn：vecRows/metaRows=0.2 < 0.9 → 'vector coverage low' 只 warn 一次");
  {
    const dbPath = path.join(tmpDir, "t2.db");
    const store = new VectorStore(dbPath, DIMS);
    store.init();
    if (store.isDegraded()) {
      record("2", "覆盖率 warn", false, `临时库初始化降级（环境问题）：${dbPath}`);
    } else {
      // 10 条元数据：8 条无向量 + 2 条带向量 → coverage = 2/10 = 0.2
      for (let i = 0; i < 8; i++) {
        store.upsertL1(makeRecord(`cov-meta-${i}`, `${KW} 覆盖率测试元数据 第${i}条`), undefined);
      }
      for (let i = 0; i < 2; i++) {
        store.upsertL1(makeRecord(`cov-vec-${i}`, `${KW} 覆盖率测试带向量 第${i}条`), fakeVector());
      }
      const metaRows = store.countL1();
      const hasMethod = typeof (store as { countL1VectorRows?: unknown }).countL1VectorRows === "function";
      const vecRows = hasMethod ? (store as unknown as { countL1VectorRows(): number }).countL1VectorRows() : -1;

      const spy = makeLoggerSpy();
      // 跑两次 batchDedup：warn-once/进程 → 断言 warn 总数 === 1（去重断言）
      for (let round = 0; round < 2; round++) {
        await batchDedup({
          memories: [
            {
              content: `${KW} 覆盖率测试新记忆 第${round}轮`,
              type: "episodic",
              priority: 70,
              source_message_ids: [],
              metadata: {},
              scene_name: "verify-p3-t15",
              record_id: `cov-new-${round}`,
            },
          ],
          config: {},
          vectorStore: store,
          embeddingService: fakeEmbeddingService(),
          logger: spy.logger,
          llmRunner: fakeLlmRunner() as never,
        });
      }
      const coverageWarns = spy.warn.filter((m) => m.includes("vector coverage low"));
      const pass =
        hasMethod && vecRows === 2 && metaRows === 10 && coverageWarns.length === 1 &&
        coverageWarns[0]?.includes("(2/10)");
      record(
        "2",
        "覆盖率 warn",
        pass,
        `countL1VectorRows 存在=${hasMethod}, vecRows=${vecRows}, metaRows=${metaRows}, coverageWarns=${coverageWarns.length}` +
          (coverageWarns.length > 0 ? `，内容="${coverageWarns[0]}"` : ""),
      );
    }
    store.close();
  }

  // ── [3] health 字段：buildMemoryHealth 纯函数 → 字段齐全、degraded 翻转 ──
  section("[3] /health memory 子对象：buildMemoryHealth(stats) 字段齐全 + degraded 翻转");
  {
    try {
      const { buildMemoryHealth } = (await import("../src/gateway/server.js")) as {
        buildMemoryHealth: (s: unknown) => Record<string, unknown>;
      };
      const okState = buildMemoryHealth({
        vecRows: 104,
        metaRows: 203,
        embeddingStatus: "ok",
        degradedSince: null,
        lastVecWriteAt: "2026-09-09T08:00:00Z",
      });
      const degradedState = buildMemoryHealth({
        vecRows: 104,
        metaRows: 203,
        embeddingStatus: "degraded",
        degradedSince: "2026-09-09T09:00:00Z",
        lastVecWriteAt: null,
      });
      const fields = ["vectorCoverage", "vecRows", "metaRows", "embedding", "degradedSince", "lastVecWriteAt"];
      const fieldsOk = fields.every((f) => f in okState);
      const coverageOk = typeof okState.vectorCoverage === "number" && Math.abs((okState.vectorCoverage as number) - 104 / 203) < 1e-9;
      const flipOk = okState.embedding === "ok" && degradedState.embedding === "degraded" &&
        okState.degradedSince === null && degradedState.degradedSince === "2026-09-09T09:00:00Z";
      const pass = fieldsOk && coverageOk && flipOk;
      record(
        "3",
        "health 字段",
        pass,
        `fields=${fieldsOk}, vectorCoverage=${String(okState.vectorCoverage)}（期望≈${(104 / 203).toFixed(4)}）, ` +
          `flip ok→degraded=${flipOk}`,
      );
    } catch (err) {
      record("3", "health 字段", false, `buildMemoryHealth 导入/调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── [4] 注入标注：FTS-only + embedding 配置存在 → degraded 标注；向量路径无标注 ──
  section("[4] 注入降级标注：executeMemorySearch degraded=true + [degraded: fts-only] / 向量路径无标注");
  {
    // [4a] FTS-only + embedding 已配置：向量层 0 行 → strategy=fts → degraded
    const dbFts = path.join(tmpDir, "t4a.db");
    const storeFts = new VectorStore(dbFts, DIMS);
    storeFts.init();
    if (storeFts.isDegraded()) {
      record("4", "注入标注", false, `临时库初始化降级（环境问题）：${dbFts}`);
    } else {
      for (let i = 0; i < 3; i++) {
        storeFts.upsertL1(makeRecord(`fts-meta-${i}`, `${KW} 标注测试元数据 第${i}条`), undefined);
      }
      const resFts = await executeMemorySearch({
        query: `${KW} 标注测试`,
        limit: 5,
        vectorStore: storeFts,
        embeddingService: fakeEmbeddingService(),
      });
      const formattedFts = formatSearchResponse(resFts);
      // I-1 两义措辞断言：新文案必须在（向量层降级或相关度门滤除），
      // 旧单因断言文案"向量召回不可用"必须绝迹（防回归到假警报措辞）。
      const a = resFts.strategy === "fts" && resFts.degraded === true &&
        formattedFts.includes("[degraded: fts-only]") &&
        formattedFts.includes("向量召回无贡献（向量层降级或相关度门滤除）") &&
        !formattedFts.includes("向量召回不可用");

      // [4b] 向量路径（hybrid）：向量行存在且 cosine=1 ≥ 阈值 → 无 degraded 标注
      const dbVec = path.join(tmpDir, "t4b.db");
      const storeVec = new VectorStore(dbVec, DIMS);
      storeVec.init();
      let b = false;
      if (!storeVec.isDegraded()) {
        for (let i = 0; i < 2; i++) {
          storeVec.upsertL1(makeRecord(`vec-meta-${i}`, `${KW} 向量路径标注测试 第${i}条`), fakeVector());
        }
        const resVec = await executeMemorySearch({
          query: `${KW} 向量路径`,
          limit: 5,
          vectorStore: storeVec,
          embeddingService: fakeEmbeddingService(),
        });
        const formattedVec = formatSearchResponse(resVec);
        // T15 复审（S6 第 8 项）：负断言收紧为前缀级——降级标注是行首 "[degraded…"
        // 标记，子串级 includes("degraded") 会把未来正文里偶然出现的英文 "degraded"
        // 一并误报为"有标注"。逐行 trimStart 后按 "[degraded" 前缀判定。
        const hasDegradedMarker = formattedVec.split("\n").some((l) => l.trimStart().startsWith("[degraded"));
        b = resVec.strategy === "hybrid" && !resVec.degraded && !hasDegradedMarker;
      }
      storeVec.close();

      const pass = a && b;
      record(
        "4",
        "注入标注",
        pass,
        `FTS-only: strategy=${resFts.strategy}, degraded=${String(resFts.degraded)}, ` +
          `标注出现=${formattedFts.includes("[degraded: fts-only]")}; 向量路径无标注=${b}`,
      );
    }
    storeFts.close();
  }

  // ── [5] 旧后端回退：无 countL1VectorRows 的 mock store → countL1 回退 + warn 一次 ──
  section("[5] 旧后端回退：无 countL1VectorRows 的 store → 走 countL1 回退 + warn 一次（去重）");
  {
    const legacyStore = {
      countL1: async () => 5,
      isFtsAvailable: () => true,
      searchL1Vector: async () => [],
      searchL1Fts: async () => [],
      getCapabilities: () => ({ vectorSearch: true, fts: true }),
    };
    const spy = makeLoggerSpy();
    for (let round = 0; round < 2; round++) {
      await batchDedup({
        memories: [
          {
            content: `${KW} 旧后端回退测试 第${round}轮`,
            type: "episodic",
            priority: 70,
            source_message_ids: [],
            metadata: {},
            scene_name: "verify-p3-t15",
            record_id: `legacy-new-${round}`,
          },
        ],
        config: {},
        vectorStore: legacyStore as never,
        embeddingService: fakeEmbeddingService(),
        logger: spy.logger,
        llmRunner: fakeLlmRunner() as never,
      });
    }
    const legacyWarns = spy.warn.filter((m) => m.includes("countL1VectorRows"));
    const pass = legacyWarns.length === 1;
    record(
      "5",
      "旧后端回退",
      pass,
      `legacyWarns=${legacyWarns.length}` + (legacyWarns.length > 0 ? `，内容="${legacyWarns[0]}"` : ""),
    );
  }

  // ── [6] /health 接线断言（审查 I-2）：handleHealth → collectMemoryHealthStats →
  //        buildMemoryHealth，钉死"生产 /health 消费 buildMemoryHealth"防改回旧构造 ──
  section("[6] /health 接线：handleHealth 生产的 memory 子对象 === buildMemoryHealth(collectMemoryHealthStats 输出)");
  {
    try {
      const { buildMemoryHealth, TdaiGateway } = (await import("../src/gateway/server.js")) as unknown as {
        buildMemoryHealth: (s: unknown) => Record<string, unknown>;
        TdaiGateway: { prototype: object };
      };
      // 原型级 mock：不实例化 TdaiGateway（构造器重、会建真实 core/adapter），
      // 只在原型派生对象上挂 handleHealth / collectMemoryHealthStats 实际读到的字段。
      const gw = Object.create(TdaiGateway.prototype) as {
        handleHealth: (res: unknown) => Promise<void>;
        [k: string]: unknown;
      };
      const mockStore = {
        countL1VectorRows: () => 7,
        countL1: async () => 10,
        getLastVecWriteAt: () => "2026-09-09T08:00:00Z",
      };
      const spy = makeLoggerSpy();
      gw.core = {
        getVectorStore: () => mockStore,
        getEmbeddingService: () => ({}),
      };
      gw.logger = spy.logger;
      gw.embeddingProbe = { status: "ok", since: null };
      gw.memoryHealthStatsCache = null;
      gw.startTime = Date.now();

      const captured: { status?: number; body?: string } = {};
      const fakeRes = {
        writeHead: (status: number) => { captured.status = status; },
        end: (body: string) => { captured.body = body; },
      };
      await gw.handleHealth(fakeRes);
      const parsed = JSON.parse(captured.body ?? "{}") as {
        status?: string;
        memory?: Record<string, unknown>;
      };
      const expected = buildMemoryHealth({
        vecRows: 7,
        metaRows: 10,
        embeddingStatus: "ok",
        degradedSince: null,
        lastVecWriteAt: "2026-09-09T08:00:00Z",
      });
      const wired =
        captured.status === 200 &&
        parsed.status === "ok" &&
        parsed.memory !== undefined &&
        JSON.stringify(parsed.memory) === JSON.stringify(expected) &&
        parsed.memory.vectorCoverage === 0.7;
      record(
        "6",
        "/health 接线",
        wired,
        `handleHealth().memory === buildMemoryHealth({vecRows:7, metaRows:10, embedding:ok}) → ${wired}; ` +
          `memory=${JSON.stringify(parsed.memory)}` +
          (wired ? "" : "（修复预期：若 handleHealth 改回旧内联构造/绕过 buildMemoryHealth，此断言即失败）"),
      );
    } catch (err) {
      record("6", "/health 接线", false, `handleHealth mock 调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
  }
}

// ── 汇总 ─────────────────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
const allPass = results.every((r) => r.pass);
for (const r of results) {
  console.log(`  [${r.id}] ${r.pass ? TAG_OK : TAG_FAIL} ${r.name}`);
}
console.log(`总体：${allPass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 组通过）`);
console.log("=".repeat(72));
process.exit(allPass ? 0 : 1);
