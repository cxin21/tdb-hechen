/**
 * P0-T2 同形验证：C 侧 FTS 绕过门 —— reconsolidation 门必须"仅 observed 放行"。
 *
 * 红线背景（E2）：回忆即重巩固——记忆被搜索命中时更新 recall_count 抗遗忘统计，
 * 但只允许 certainty="observed"（实证）记忆享受，防"越回忆越信自己的编造"。
 * 门在 memory-search.ts:421，原写法 `certainty === "inferred" → continue`（黑名单式）。
 * FTS 路径返回的记录 certainty 恒 undefined（l1_fts 表无此列，W1 未修），
 * undefined ≠ "inferred" → 门放行 → inferred 记忆经 FTS 命中也吃抗遗忘 boost，红线被绕过。
 * 修复：黑名单收紧为白名单 `!== "observed" → skip`（计划 Task 2 Step 3 逐字）。
 *
 * 三部分证据（同 verify-p0-t1.ts 的分段结构）：
 *   [A] 静态证据：【P1-T7（W1）后已反转】现行 stmtL1FtsSearch 的 SELECT 列清单
 *       【含 certainty】—— W1 修复（l1_fts 25 列迁移）兑现后 FTS 行带 soul，
 *       T2 门的 FTS 盲区消除，白名单门对 FTS 行真正生效。
 *   [B] 真实 executeMemorySearch FTS-only 链路：临时 sqlite 库（VectorStore dimensions=0，
 *       向量不可用）→ 不传 embeddingService → strategy === "fts"
 *       → 关键断言①：FTS 命中的 inferred 记忆（落库 certainty 列="inferred"）
 *         recall_count 不被更新（持久红线，不得放宽）。
 *       断言②：【W1 已修，T2 报告"待 W1 恢复"对照断言激活】FTS 命中的 observed
 *         记忆现在【必须被写】——FTS 行 certainty 可见（="observed"），白名单门
 *         真正放行 observed 吃抗遗忘 boost（重巩固全通道恢复）。
 *   [C] 机制探针：直接调 store.updateL1Metadata 写 observed 行成功 —— 证明 [B] 中
 *       写入链路本身活着。
 *
 * 【Task 4 后会变】Task 4（H-B1）会把 recall_count 写入从 read-then-write 改为
 * SQL 原子自增 bumpRecallCount——"谁能被写"仍由本门决定，[B] 的断言语义不变。
 * 但注意：Task 4 的验证（连续 3 次 executeMemorySearch → recall_count===3）必须
 * 让记录的 certainty 在返回 item 上可见（走向量/hybrid 路径，或在 W1 之后），
 * 否则本白名单门会跳过全部写入、验证必然失败。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p0-t2.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { SOUL_SELECT_FRAGMENT } from "../src/core/store/soul-columns.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// ── 唯一关键词：保证 FTS 命中且不受分词干扰（ASCII 词 jieba 原样保留）──
const KEYWORD = "T2PINBD7";

// ── 共享 fixture（import 生产类型定义；生产加字段此处编译报错）──
const mk = (id: string, content: string, certainty: string): MemoryRecord =>
  ({
    id,
    content: `${content}（标记词 ${KEYWORD}）`,
    type: "episodic",
    priority: 70,
    scene_name: "verify-p0-t2",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p0-t2",
    certainty,
  }) as MemoryRecord;

const memInferred = mk("m_inf_fts", "用户偏好本地部署：推断其一", "inferred");
const memObserved = mk("m_obs_fts", "用户偏好本地部署：实见其一", "observed");
const group = [memInferred, memObserved];

// ── [A] 静态证据：stmtL1FtsSearch 的 SELECT 列含 certainty（P1-T7 后反转）─────
console.log("=".repeat(72));
console.log("[A] 静态证据：l1_fts 搜索 SELECT 列清单含 certainty（W1 已修，T2 门的 FTS 盲区消除）");
console.log("=".repeat(72));

const sqliteSrc = fs.readFileSync(
  fileURLToPath(new URL("../src/core/store/sqlite.ts", import.meta.url)),
  "utf8",
);
// 提取 stmtL1FtsSearch 初始化语句中 SELECT … FROM l1_fts 之间的列清单
const selectMatch = sqliteSrc.match(
  /stmtL1FtsSearch\s*=\s*this\.db\.prepare\(\s*`\s*SELECT\s+([\s\S]*?)\s+FROM\s+l1_fts\b/,
);
const ftsSelectColumns = selectMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "(未找到)";
const ftsSelectHasCertainty =
  selectMatch !== null && /\bcertainty\b/.test(selectMatch?.[1] ?? "");
const ftsSelectHasSoulFragment =
  selectMatch !== null && /\bSOUL_SELECT_FRAGMENT\b/.test(selectMatch?.[1] ?? "");
// soul 片段展开必须含 certainty（SOUL_COLUMNS 单一事实源展开校验）
const soulFragmentHasCertainty = /\bcertainty\b/.test(SOUL_SELECT_FRAGMENT);

console.log(`stmtL1FtsSearch SELECT 列：${ftsSelectColumns}`);
console.log(`SELECT 内联 SOUL_SELECT_FRAGMENT：${ftsSelectHasSoulFragment}`);

// P1-T7（W1）后断言反转：SELECT 必须带 soul（SOUL_SELECT_FRAGMENT 内联或直接含 certainty）
// —— FTS 行 soul 可见，白名单门对 FTS 行真正生效（此前盲区=certainty 恒 undefined 全量跳过）。
// 静态证据 = 结构（SELECT 含 soul 片段）+ 展开（SOUL_SELECT_FRAGMENT 展开含 certainty）。
const aPass = selectMatch !== null && (ftsSelectHasSoulFragment || ftsSelectHasCertainty) && soulFragmentHasCertainty;
console.log(
  aPass
    ? '[A] PASS: FTS 搜索 SELECT 含 certainty → executeMemorySearch 的 FTS 行 soul 可见，' +
        '白名单门（!== "observed" → skip）对 FTS 行真正生效（W1 已修）'
    : "[A] FAIL: 静态证据不符（SELECT 应含 certainty；若列清单被改回无 soul 列，T2 门盲区复现）",
);

// ── [B] 真实 executeMemorySearch FTS-only 链路 ────────────────────
console.log("");
console.log("=".repeat(72));
console.log(
  "[B] 真实链路：临时 sqlite 库（向量不可用）+ executeMemorySearch（不传 embeddingService）→ FTS-only",
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p0-t2-"));
const dbPath = path.join(tmpDir, "vectors.db");
let bPass = false;
let cPass = false;
let exitCode = 1;
try {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) {
    console.log(`[B] FAIL: 临时库初始化降级（环境问题，非行为断言）：${initRes.reason}`);
  } else {
    for (const m of group) store.upsertL1(m, undefined);
    console.log(
      `临时库：${dbPath}（dimensions=0，无向量行），已写入 ${group.length} 条：` +
        `m_inf_fts(certainty=inferred)、m_obs_fts(certainty=observed)`,
    );

    const rowById = (id: string): Row | undefined =>
      (store.queryL1Records() as Row[]).find((r) => r.record_id === id);

    // 落库前置检查：两行 certainty 列值必须是预期（推断行 "inferred"）
    const beforeInf = rowById("m_inf_fts");
    const beforeObs = rowById("m_obs_fts");
    console.log(
      `落库 certainty 列：m_inf_fts=${JSON.stringify(beforeInf?.certainty)}，m_obs_fts=${JSON.stringify(beforeObs?.certainty)}`,
    );
    const certaintyColumnsOk =
      beforeInf?.certainty === "inferred" && beforeObs?.certainty === "observed";
    if (!certaintyColumnsOk) {
      console.log("[B] FAIL: 落库 certainty 列值不符预期（fixture/写入链路问题，非门行为）");
    } else {
      // 真实 executeMemorySearch：不传 embeddingService → 向量路径不可用 → FTS-only 策略
      const res = await executeMemorySearch({
        query: KEYWORD,
        limit: 5,
        vectorStore: store,
        logger: {
          info: () => {},
          warn: (m: string) => console.log(`  [search:warn] ${m}`),
          debug: () => {},
        } as never,
      });

      console.log(`strategy=${res.strategy}，命中 ${res.total} 条：[${res.results.map((r) => r.id).join(", ")}]`);
      const hitInferred = res.results.find((r) => r.id === "m_inf_fts");
      const hitObserved = res.results.find((r) => r.id === "m_obs_fts");
      console.log(
        `FTS 命中行 item.certainty（W1 已修）：m_inf_fts=${JSON.stringify(hitInferred?.certainty)}，` +
          `m_obs_fts=${JSON.stringify(hitObserved?.certainty)}（FTS 行 soul 可见）`,
      );
      console.log(
        `FTS 命中行 occurred_at（W1 兑现）：m_obs_fts=${JSON.stringify(hitObserved?.occurred_at ?? null)}（不再恒 undefined）`,
      );

      // reconsolidation 是 fire-and-forget（void Promise...），留出写盘时序余量
      await new Promise((r) => setTimeout(r, 250));

      const afterInfMeta = metaOf(rowById("m_inf_fts"));
      const afterObsMeta = metaOf(rowById("m_obs_fts"));
      console.log(
        `recall_count 写入情况：m_inf_fts=${JSON.stringify(afterInfMeta.recall_count)}（断言 undefined，红线），` +
          `m_obs_fts=${JSON.stringify(afterObsMeta.recall_count)}（断言已写入 ≥1 —— W1 已修，observed 恢复吃 boost）`,
      );

      // 关键断言①：FTS 命中的 inferred 记忆不被更新 recall_count（持久红线）
      // 断言②（W1 已修，T2 报告"待 W1 恢复"对照断言激活）：observed 经 FTS 命中
      //   必须被写 —— FTS 行 certainty 可见，白名单门真正放行
      const observedWritten =
        typeof afterObsMeta.recall_count === "number" && afterObsMeta.recall_count >= 1;
      bPass =
        hitInferred !== undefined &&
        hitObserved !== undefined &&
        res.strategy === "fts" &&
        hitObserved?.certainty === "observed" &&
        afterInfMeta.recall_count === undefined &&
        observedWritten;

      if (bPass) {
        console.log(
          "[B] PASS: inferred 经 FTS 命中未被写入 recall_count（红线守住）；" +
            "observed 经 FTS 命中被写入（FTS 行 certainty 可见，重巩固全通道恢复）",
        );
      } else if (afterInfMeta.recall_count !== undefined) {
        console.log(
          `[B] FAIL: inferred 经 FTS 命中被写入了 recall_count=${JSON.stringify(afterInfMeta.recall_count)} ` +
            "—— 白名单门被绕过，红线失守",
        );
      } else if (!observedWritten) {
        console.log(
          `[B] FAIL: observed 经 FTS 命中未写入 recall_count=${JSON.stringify(afterObsMeta.recall_count)} ` +
            "—— W1 已修后 observed 应恢复吃 boost（FTS 行 certainty 必须可见）",
        );
      } else {
        console.log("[B] FAIL: 其他断言不符（FTS 未命中 / strategy 非 fts 等）");
      }

      // ── [C] 机制探针：写入链路本身活着（排除"[B] 没写是链路坏"的替代解释）──
      console.log("");
      console.log("-".repeat(72));
      console.log("[C] 机制探针：直接调 updateL1Metadata 写 observed 行 → 应成功且可读回");
      const probeOk = store.updateL1Metadata("m_obs_fts", { recall_count: 1, last_recalled_at: new Date().toISOString() });
      const probeMeta = metaOf(rowById("m_obs_fts"));
      cPass = probeOk === true && probeMeta.recall_count === 1;
      console.log(
        `updateL1Metadata 返回=${probeOk}，读回 recall_count=${JSON.stringify(probeMeta.recall_count)} → ` +
          (cPass ? "[C] PASS: 写入链路可用，[B] 的不写纯粹是门在拦" : "[C] FAIL: 写入链路异常"),
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
