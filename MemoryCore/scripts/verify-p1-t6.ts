/**
 * P1-T6 同形验证：SOUL_COLUMNS 单一事实源（R1 根治，P-A 原则）。
 *
 * 背景：soul 8 字段（occurred_at/valid_start/valid_end/certainty/source/valence/
 * arousal/significance）在 l1_records 定义一次，但 FTS 虚表 / FTS SELECT /
 * FtsSearchResult / handler 内联类型各持一份人工手抄清单——W1（FTS 漏 8 列）
 * 正是手抄漏抄的产物。本任务把字段清单收敛为单一常量模块
 * src/core/store/soul-columns.ts，并做一处示范接线（v2-router handleAtomicUpdate
 * 删除 Task 3 的内联 type SoulColumnsOf，改为 import，语义不变）。
 *
 * 四部分证据：
 *   [A] 模块自洽：SOUL_COL_NAMES = SOUL_COLUMNS 的 name 展开；长度 8；
 *       SOUL_SELECT_FRAGMENT = 8 名逗号连接（Task 7 FTS SELECT 将直接消费）。
 *   [B] Schema 对齐：对临时库建表后 PRAGMA table_info(l1_records) 的 soul 列，
 *       名称与顺序必须与 SOUL_COL_NAMES 完全一致，声明类型必须与 sqlType 一致
 *       （新增字段只改 soul-columns.ts 一处，漏改 schema = 这里红）。
 *   [C] 类型可用（编译期验证 + 运行时占位断言）：SoulColumnsOf 可承接
 *       Task 3 旧内联形态（互赋方向：旧 → 新），v2-router 接线后语义不变。
 *   [D]（回归）verify-p0-t3.ts 复跑由执行方单独执行——它消费 handleAtomicUpdate，
 *       受本任务类型替换影响。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p1-t6.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SOUL_COLUMNS,
  SOUL_COL_NAMES,
  SOUL_SELECT_FRAGMENT,
  type SoulColumnsOf,
} from "../src/core/store/soul-columns.js";
import { VectorStore } from "../src/core/store/sqlite.js";

// ── [A] 模块自洽 ──────────────────────────────────────────────────
console.log("=".repeat(72));
console.log("[A] 模块自洽：SOUL_COL_NAMES / SOUL_SELECT_FRAGMENT 展开");
console.log("=".repeat(72));

const namesFromConst = SOUL_COLUMNS.map((c) => c.name as string);
console.log(`SOUL_COLUMNS   : ${SOUL_COLUMNS.length} 列 → ${namesFromConst.join(", ")}`);
console.log(`SOUL_COL_NAMES : ${SOUL_COL_NAMES.join(", ")}`);
console.log(`SOUL_SELECT_FRAGMENT : ${SOUL_SELECT_FRAGMENT}`);
const fragmentExpected = namesFromConst.join(", ");
const aPass =
  SOUL_COLUMNS.length === 8 &&
  SOUL_COL_NAMES.length === 8 &&
  JSON.stringify(namesFromConst) === JSON.stringify(SOUL_COL_NAMES) &&
  SOUL_SELECT_FRAGMENT === fragmentExpected;
console.log(
  aPass
    ? "[A] PASS: SOUL_COL_NAMES 与 SOUL_COLUMNS 展开一致（8 列），SOUL_SELECT_FRAGMENT = 8 名逗号连接"
    : "[A] FAIL: 模块自洽破坏（SOUL_COLUMNS 长度/展开/片段不一致）",
);

// ── [B] Schema 对齐（临时库 PRAGMA table_info）────────────────────
console.log("");
console.log("=".repeat(72));
console.log("[B] Schema 对齐：PRAGMA table_info(l1_records) 的 soul 列 vs SOUL_COL_NAMES");
console.log("=".repeat(72));

// 编译期验证：Task 3 旧内联形态必须仍可赋给新 SoulColumnsOf（接线语义不变的类型证据）。
// 方向只能是 旧 → 新：新类型用 string|number|null 并集放宽，反向收紧不允许。
type LegacySoulColumnsOf = {
  occurred_at?: string | null; valid_start?: string | null; valid_end?: string | null;
  certainty?: string | null; source?: string | null;
  valence?: number | null; arousal?: number | null; significance?: number | null;
};
const _legacyToNew: SoulColumnsOf = {} as LegacySoulColumnsOf;
void _legacyToNew;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t6-"));
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
    // 灵魂记忆字段为幂等 ALTER 追加列，位于建表语句末尾 —— 顺序即追加顺序
    const tableInfo = store.getRawDb().prepare("PRAGMA table_info(l1_records)").all() as Array<{
      name: string;
      type: string;
    }>;
    const soulPragma = tableInfo.filter((c) =>
      (SOUL_COL_NAMES as string[]).includes(c.name),
    );
    const pragmaNames = soulPragma.map((c) => c.name);
    const typeMismatches = SOUL_COLUMNS.filter((col) => {
      const found = soulPragma.find((c) => c.name === col.name);
      return !found || found.type.toUpperCase() !== col.sqlType;
    });
    console.log(`PRAGMA soul 列（表内顺序）：${pragmaNames.join(", ")}`);
    console.log(`SOUL_COL_NAMES        ：${SOUL_COL_NAMES.join(", ")}`);
    if (typeMismatches.length > 0) {
      console.log(
        `[B] 类型不符：${typeMismatches.map((c) => `${c.name} 期望 ${c.sqlType}`).join("; ")}`,
      );
    }
    const orderOk = JSON.stringify(pragmaNames) === JSON.stringify(SOUL_COL_NAMES);
    bPass = orderOk && typeMismatches.length === 0 && soulPragma.length === 8;
    console.log(
      bPass
        ? "[B] PASS: PRAGMA soul 列与 SOUL_COL_NAMES 名称/顺序/类型完全一致（单一事实源钉住 schema）"
        : "[B] FAIL: " + (orderOk
            ? "名称顺序一致但列数/类型不符（schema 与 soul-columns.ts 漂移）"
            : `顺序/集合不一致（PRAGMA=${pragmaNames.join(",")}）—— schema 手抄漂移，正是 R1 要根治的形态`),
    );

    // ── [C] SoulColumnsOf 类型可用（运行时占位断言）───────────────
    console.log("");
    const soulView: SoulColumnsOf = {
      occurred_at: "2026-01-01T00:00:00Z",
      certainty: "observed",
      valence: 0.7,
      significance: null,
    };
    const soulRows: Array<{ record_id: string } & SoulColumnsOf> =
      store
        .getRawDb()
        .prepare("SELECT record_id, " + SOUL_SELECT_FRAGMENT + " FROM l1_records")
        .all() as Array<{ record_id: string } & SoulColumnsOf>;
    cPass =
      typeof soulView.occurred_at === "string" &&
      soulView.significance === null &&
      Array.isArray(soulRows) &&
      soulRows.length === 0;
    console.log(
      `[C] SoulColumnsOf 编译期可用（旧内联形态可赋值）+ 运行时占位断言通过（占位对象/` +
        `SOUL_SELECT_FRAGMENT 直接拼 SELECT FROM l1_records 可执行，空表 0 行）→ ` +
        (cPass ? "PASS" : "FAIL"),
    );
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
  `总体：${exitCode === 0 ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}, C=${cPass ? "PASS" : "FAIL"}；回归 [D]=verify-p0-t3.ts 复跑由执行方单独执行）`,
);
process.exit(exitCode);
