/**
 * P0-T4 同形验证：recall_count 恒 1（H-B1）—— reconsolidation 统计必须真实累加。
 *
 * 红线背景（H-B1）：memory-search.ts reconsolidation 块从召回 item 读 `r.metadata`
 * 计算 prevCount（read-then-write），但 `MemorySearchResultItem`（memory-search.ts:23-46）
 * 无 metadata 字段，三条召回映射（native-hybrid/:175-197、fts/:229-248、vec/:270-292）
 * 均不带 metadata_json → prevCount 恒 0 → recall_count 恒 1 →
 * 遗忘侧 `min(c,5)*0.02` 的"+2% 封顶 +10%"抗遗忘 boost 在生产不可达。
 * （审计 verify-lifecycle 的 +0.06/+0.10 断言是手工 fixture 喂 scoreFor，绕过了
 *   search 侧读不到 metadata 的事实 —— R5 验证形状失配模式。）
 *
 * 修复（P0-T4）：新增 store 方法 `bumpRecallCount(id, now?)`——SQL 原子自增
 *（json_set + json_extract，不读回），调用点 feature-detect 改用它；
 * bumpRecallCount 缺失时（tcvdb 后端）回退旧 read-then-write 路径并 warn 一次
 *（F7 家族，行为降级如实登记）。
 *
 * C1 同步更新（2026-09-10，绊线自身契约"接口若已加 metadata 字段，本验证需同步
 * 更新"）：灵魂记忆 C1 为 coreRefs 消费给 MemorySearchResultItem 加了 metadata
 * 字段（三条召回映射带 metadata_json 读回）——read-then-write 回退路径的
 * prevCount 自此可读真值（后端返回 metadata_json 时）。[A] 断言反转：
 * 接口**应含** metadata；H-B1 修复存在性（bumpRecallCount feature-detect）不变。
 *
 * 三部分证据（同 verify-p0-t2/t3 的分段结构）：
 *   [A] 静态证据（C1 同步更新）：MemorySearchResultItem 接口**含** metadata 字段
 *       （C1 为 coreRefs 消费而加；H-B1 当年"读不到 metadata"的根因已随字段补齐
 *       消失，read-then-write 回退自此可读真值）；且调用点已改用 bumpRecallCount
 *       （修复存在性，RED 阶段此处为 FAIL）。
 *   [B] 真实链路：临时 sqlite 库（VectorStore dimensions=64）+ 真实
 *       executeMemorySearch + mock embeddingService（hashEmbed 确定性向量，
 *       参照 scripts/audit-fix-verify-edges.ts:20-35）走向量路径 ——
 *       T2 白名单门 `certainty !== "observed" → continue` 要求召回 item 的
 *       certainty 可见，FTS 行恒 undefined 会被跳过，故必须向量路径（接口裁决 1）。
 *       连续 3 次 executeMemorySearch（同一 query）→ 读回该行 metadata_json：
 *       断言① recall_count === 3（RED 阶段恒 1 —— H-B1 复现）；
 *       断言② last_recalled_at 单调不减（每次快照读回）。
 *   [C] boost 真实可达：生产 scorer.scoreFor（import 自
 *       src/core/lifecycle/forgetting/scorer.js）对该行（带读回的 metadata）
 *       与无 metadata 对照行求差 = min(3,5)*0.02 = 0.06（3 次回忆的 boost 分量；
 *       无 metadata 时该分量恒 0 —— H-B1 的生产后果）。
 *
 * 【Task 7 后会变】W1 把 certainty 加入 FTS 列后，FTS 命中的 observed 记忆
 * 也会恢复重巩固；本验证走向量路径的裁决不变（确定性可控）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p0-t4.ts
 *
 * 只用自建临时数据，不连任何线上资源（接口裁决 2：不碰 D:/tdai-data）；
 * 跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { scoreFor } from "../src/core/lifecycle/forgetting/scorer.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// ── 唯一关键词：保证向量/FTS 命中且不受分词干扰（ASCII 词 jieba 原样保留）──
const KEYWORD = "T4PINBD7";

/** 确定性 embedding：单字+双字 滑窗 → 伪向量（共享词→高余弦）。参照 audit-fix-verify-edges.ts:20-35。 */
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

// ── fixture（import 生产类型定义；生产加字段此处编译报错）──
// certainty="observed"：必须能过 T2 白名单门（inferred/undefined 均被 continue 跳过）
const memObserved: MemoryRecord = {
  id: "m_obs_vec",
  // fixture 形态（探针实测，缺一不可）：
  //   1. 关键词嵌在更长 ASCII 串内（HXT4PINBD7YZ）→ jieba 整 token 索引 ≠ 查询词
  //      "T4PINBD7" → FTS 0 命中 → strategy=embedding（纯向量，见下条）。
  //      若走 hybrid，RRF 合并时 FTS item（certainty 恒 undefined，W1 未修）先入
  //      map 会覆盖向量 item 的 "observed" → T2 门全跳过 —— 那是 W1 的坑，不是本任务。
  //   2. 关键词落在内容偶数字符索引（前缀"编号HX"恰 4 字符 → "T4" 起于 index 4 偶数
  //      → hashEmbed 2-gram 滑窗与查询共享 T4/PI/NB/D7 四个 bucket）→ cosine≈0.61 >
  //      scoreThreshold 0.3（错位或长内容稀释会得 0/0.12，探针实测）。
  content: `编号HXT4PINBD7YZ：用户偏好本地部署（实见其一）`,
  type: "episodic",
  priority: 70,
  scene_name: "verify-p0-t4",
  source_message_ids: [],
  metadata: {},
  timestamps: ["2026-09-01T00:00:00Z"],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  version: 0,
  sessionKey: "k",
  sessionId: "verify-p0-t4",
  certainty: "observed",
} as MemoryRecord;

// ── [A] 静态证据 ──────────────────────────────────────────────────
console.log("=".repeat(72));
console.log("[A] 静态证据：MemorySearchResultItem 含 metadata（C1 coreRefs 消费）+ 调用点已用 bumpRecallCount");
console.log("=".repeat(72));

const searchSrc = fs.readFileSync(
  new URL("../src/core/tools/memory-search.ts", import.meta.url),
  "utf8",
);
// 提取 MemorySearchResultItem 接口体（到首个顶格 `}`）
const ifaceMatch = searchSrc.match(
  /export interface MemorySearchResultItem \{([\s\S]*?)\n\}/,
);
const ifaceBody = ifaceMatch?.[1] ?? "(未找到)";
// C1 同步更新（绊线自身契约）：接口现已**应含** metadata 字段（coreRefs 消费载体）；
// 当年 H-B1 根因（item 读不到 metadata）随字段补齐消失。
const ifaceHasMetadata = /\bmetadata\s*\??\s*:/.test(ifaceBody);
console.log(`MemorySearchResultItem 接口含 metadata 字段：${ifaceHasMetadata}`);

// 修复存在性：调用点 feature-detect bumpRecallCount（RED 阶段为 false → 总体 FAIL）
const bumpCallPresent =
  /typeof\s+store\.bumpRecallCount\s*===\s*"function"/.test(searchSrc) ||
  /store\.bumpRecallCount\?\.\(/.test(searchSrc);
const fallbackWarnPresent = searchSrc.includes("recall_count 依赖召回 item 的 metadata");
console.log(`调用点已 feature-detect bumpRecallCount：${bumpCallPresent}`);
console.log(`fallback warn（降级如实登记）存在：${fallbackWarnPresent}`);

const aPass = ifaceMatch !== null && ifaceHasMetadata && bumpCallPresent && fallbackWarnPresent;
console.log(
  aPass
    ? "[A] PASS: 召回 item 携带 metadata（C1 coreRefs 消费载体；read-then-write 回退可读真值），" +
        "调用点已改用 SQL 原子自增 bumpRecallCount，tcvdb 回退路径有如实 warn"
    : "[A] FAIL: " + (!bumpCallPresent || !fallbackWarnPresent
        ? "调用点尚未改用 bumpRecallCount（RED 阶段预期失败）"
        : "静态证据不符（接口 metadata 字段若被移除，reconsolidation 回退将退回恒 1）"),
);

// ── [B] 真实链路：临时库 + mock embeddingService 走向量路径，连续 3 次搜索 ──
console.log("");
console.log("=".repeat(72));
console.log(
  "[B] 真实链路：临时 sqlite 库（dimensions=64）+ executeMemorySearch（mock embeddingService，向量路径）×3",
);
console.log("=".repeat(72));

// 行读取辅助：sqlite 的 queryL1Records 不消费 recordIds，取全表后按 record_id 定位
type Row = { record_id: string; certainty?: string; metadata_json?: string };
const metaOf = (row: Row | undefined): Record<string, unknown> => {
  try {
    return (JSON.parse(row?.metadata_json ?? "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p0-t4-"));
const dbPath = path.join(tmpDir, "vectors.db");
let bPass = false;
let cPass = false;
let exitCode = 1;

try {
  const store = new VectorStore(dbPath, 64);
  const initRes = store.init();
  if (store.isDegraded()) {
    console.log(`[B] FAIL: 临时库初始化降级（环境问题，非行为断言）：${initRes.reason}`);
  } else {
    store.upsertL1(memObserved, hashEmbed(memObserved.content));
    console.log(`临时库：${dbPath}（dimensions=64），已写入 m_obs_vec(certainty=observed, 带确定性向量)`);

    const rowById = (id: string): Row | undefined =>
      (store.queryL1Records() as Row[]).find((r) => r.record_id === id);

    // 落库前置检查：certainty 列与 metadata 初始态必须是预期
    const before = rowById("m_obs_vec");
    const beforeMeta = metaOf(before);
    if (before?.certainty !== "observed" || beforeMeta.recall_count !== undefined) {
      console.log(
        `[B] FAIL: 落库前置检查不符（fixture/写入链路问题，非门行为）：` +
          `certainty=${JSON.stringify(before?.certainty)}, recall_count=${JSON.stringify(beforeMeta.recall_count)}`,
      );
    } else {
      console.log("落库前置检查：certainty=observed，metadata 初始无 recall_count");

      // 连续 3 次真实 executeMemorySearch（同一 query，向量路径，默认 scoreThreshold=0.3 门）
      const lastRecalledSeq: Array<string | undefined> = [];
      let hitObservedItem: { id: string; certainty?: string; score: number } | undefined;
      let strategySeen = "";
      for (let i = 1; i <= 3; i++) {
        const res = await executeMemorySearch({
          query: KEYWORD,
          limit: 5,
          scoreThreshold: 0.3,
          vectorStore: store,
          embeddingService: embedding,
          logger: {
            info: () => {},
            warn: (m: string) => console.log(`  [search:warn] ${m}`),
            debug: () => {},
          } as never,
        });
        strategySeen = res.strategy;
        const hit = res.results.find((r) => r.id === "m_obs_vec");
        if (hit) {
          hitObservedItem = { id: hit.id, certainty: hit.certainty, score: hit.score };
        }
        console.log(
          `第 ${i} 次：strategy=${res.strategy}，命中 ${res.total} 条，` +
            `m_obs_vec item.certainty=${JSON.stringify(hit?.certainty)}（向量路径可见 → 过 T2 白名单门）`,
        );
        // fire-and-forget（void Promise...），留出写盘时序余量后快照 last_recalled_at
        await new Promise((r) => setTimeout(r, 250));
        lastRecalledSeq.push(metaOf(rowById("m_obs_vec")).last_recalled_at as string | undefined);
      }

      const finalMeta = metaOf(rowById("m_obs_vec"));
      console.log(
        `最终读回 metadata_json：recall_count=${JSON.stringify(finalMeta.recall_count)}（断言 3），` +
          `last_recalled_at=${JSON.stringify(finalMeta.last_recalled_at)}`,
      );
      console.log(`last_recalled_at 快照序列：${JSON.stringify(lastRecalledSeq)}`);
      console.log(`门可见性：item.certainty=${JSON.stringify(hitObservedItem?.certainty)}（断言 "observed"），strategy=${strategySeen}`);

      // 断言①：recall_count === 3（RED 阶段恒 1 —— H-B1 复现）
      // 断言②：last_recalled_at 单调不减（每次回忆都刷新）。
      // 语义说明（审查 Minor）：断言的是"单调不减"而非"严格递增" ——
      // 两次召回落在同一毫秒时 ISO 时间戳相等，`t >= prev` 判定可通过，
      // 这是单调不减语义下的合法通过项，不视为断言漏洞；如需严格递增
      // 须改用序号型字段（超出本门范围）。
      // 断言③：门可见性 —— 命中 item certainty="observed"（证明走的是能过门的向量路径）
      const countOk = finalMeta.recall_count === 3;
      const monotonicOk = lastRecalledSeq.every(
        (t, i) =>
          i === 0 ||
          (typeof t === "string" && typeof lastRecalledSeq[i - 1] === "string" &&
            (t as string) >= (lastRecalledSeq[i - 1] as string)),
      );
      const gateVisibleOk = hitObservedItem?.certainty === "observed";
      bPass = countOk && monotonicOk && gateVisibleOk;

      if (bPass) {
        console.log(
          "[B] PASS: 连续 3 次回忆后 recall_count===3（真实累加），last_recalled_at 单调不减，" +
            "observed 经向量路径命中持续过门",
        );
      } else if (finalMeta.recall_count === 1) {
        console.log(
          `[B] FAIL: 连续 3 次回忆后 recall_count=${JSON.stringify(finalMeta.recall_count)} —— ` +
            "prevCount 恒 0（召回 item 无 metadata），recall_count 恒 1，H-B1 复现（RED 预期失败）",
        );
      } else {
        console.log(
          `[B] FAIL: 其他断言不符：count=${JSON.stringify(finalMeta.recall_count)}（期望 3），` +
            `monotonic=${monotonicOk}，gateVisible=${gateVisibleOk}`,
        );
      }

      // ── [C] boost 真实可达：生产 scorer.scoreFor 含 0.06 分量 ──
      // Δ 归因假设（审查 Minor，钉死）：本段把 Δ=withMeta-withoutMeta 全部归因于
      // scoreFor 对 metadata.recall_count 的消费 —— 该前提仅在"scoreFor 当前
      // 仅消费 recall_count（min(c,5)*0.02）这一 metadata 分量"时成立。
      // 若 scorer 变更（增删任何其他消费 metadata 的分量），0.06 断言与归因
      // 前提即失效，须同步更新本脚本。
      console.log("");
      console.log("-".repeat(72));
      console.log("[C] 生产 scorer：scoreFor（带读回 metadata）- scoreFor（无 metadata 对照）=== 0.06（min(3,5)*0.02）");
      const mkRecallable = (meta: Record<string, unknown>): MemoryRecord =>
        ({
          id: "m_obs_vec",
          content: memObserved.content,
          type: "episodic",
          priority: 70,
          scene_name: "verify-p0-t4",
          source_message_ids: [],
          metadata: meta,
          timestamps: ["2026-09-01T00:00:00Z"],
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-01T00:00:00Z",
          version: 0,
          sessionKey: "verify-p0-t4",
          sessionId: "verify-p0-t4",
          occurred_at: "2026-09-01T00:00:00Z",
          certainty: "observed",
        }) as MemoryRecord;
      const withMeta = scoreFor(mkRecallable(finalMeta));
      const withoutMeta = scoreFor(mkRecallable({}));
      const delta = withMeta - withoutMeta;
      // 浮点容差：3 * 0.02 = 0.06
      const deltaOk = Math.abs(delta - 0.06) < 1e-9;
      cPass = deltaOk && withoutMeta >= 0;
      console.log(
        `scoreFor(带 metadata)=${withMeta.toFixed(6)}，scoreFor(无 metadata)=${withoutMeta.toFixed(6)}，` +
          `Δ=${delta.toFixed(6)}（断言 0.06）→ ` +
          (cPass
            ? "PASS: 抗遗忘 boost 经真实 recall_count 链路生产可达（H-B1 修复生效）"
            : "FAIL: boost 分量不可达/数值不符（无 metadata 时该分量恒 0 —— H-B1 的生产后果）"),
      );
    }
    store.close();
  }
  exitCode = aPass && bPass && cPass ? 0 : 1;
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
  }
}

console.log("");
console.log(
  `总体：${exitCode === 0 ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}, C=${cPass ? "PASS" : "FAIL"}）`,
);
process.exit(exitCode);
