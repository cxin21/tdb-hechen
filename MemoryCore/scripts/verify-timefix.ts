/**
 * TIMEFIX 验证脚本：L1 时间过滤（接口/实现键名与单位一致性 + ISO 边界防御 + 语义查证抽检）。
 *
 * 断言组（brief 验收契约）：
 *   A. 临时库真实数据流（VectorStore 真实 init/upsert/query）：
 *      1) 窗内命中 / 窗外排除（queryL1Paginated）
 *      2) 无窗 = 全量
 *      3) queryL1Paginated.total 与 countL1 同口径（全窗/仅start/仅end）
 *      4) ISO 无效串 = 防御：非法边界被忽略（timeStart 非法不再静默错杀为 0 行）
 *      5) 合法但非 Z 形态（+08:00 / 无毫秒）规范化后过滤正确
 *   B. 生产数据只读探针（对今日备份快照 vectors-*.db，DatabaseSync readonly，零写入）：
 *      - L1 总行数 / updated_time 空串行数 / "今天"窗行数（合理性抽检）
 *      - updated_time 形态异质性抽检（非 UTC-Z 形态样本，语义查证证据）
 *
 * 用法（在 MemoryCore 目录下）：node --import tsx scripts/verify-timefix.ts
 * 只用自建临时库 + 只读打开备份快照；不连线上资源、不碰生产数据目录（不写、不开生产进程的库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

// ── A. 临时库真实数据流 ────────────────────────────────────────────────
const mkRecord = (id: string, updatedAt: string): MemoryRecord =>
  ({
    id,
    content: `时间过滤样本 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    // TIMEFIX-v2：occurred_at（snake_case，MemoryRecord 字段名）为过滤列——测试行必须带业务时间
    occurred_at: updatedAt,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-timefix",
  }) as MemoryRecord;

const D1 = "2026-09-08T10:00:00.000Z"; // 窗前
const D2 = "2026-09-09T12:00:00.000Z"; // 窗内
const D3 = "2026-09-10T10:00:00.000Z"; // 窗后
const WIN_START = "2026-09-09T00:00:00.000Z";
const WIN_END = "2026-09-09T23:59:59.000Z";

function makeTempStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-timefix-"));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  store.upsertL1(mkRecord("t-d1", D1), undefined);
  store.upsertL1(mkRecord("t-d2", D2), undefined);
  store.upsertL1(mkRecord("t-d3", D3), undefined);
  return { store, dir };
}

function sectionTempDb(): void {
  console.log("\n── A. 临时库真实数据流（VectorStore） ──");
  const { store, dir } = makeTempStore();
  try {
    // 1) 窗内命中 / 窗外排除
    const inWin = store.queryL1Paginated({ timeStart: WIN_START, timeEnd: WIN_END, limit: 10, offset: 0 });
    check("1) 窗内命中/窗外排除：仅 t-d2", inWin.rows.length === 1 && inWin.rows[0]?.record_id === "t-d2", JSON.stringify(inWin.rows.map((r) => r.record_id)));

    // 2) 无窗 = 全量
    const noWin = store.queryL1Paginated({ limit: 10, offset: 0 });
    check("2) 无窗=全量（3 条）", noWin.total === 3 && noWin.rows.length === 3, `total=${noWin.total}`);

    // 3) 同口径
    const cFull = store.countL1({ timeStart: WIN_START, timeEnd: WIN_END });
    const pFull = store.queryL1Paginated({ timeStart: WIN_START, timeEnd: WIN_END, limit: 10, offset: 0 }).total;
    const cStart = store.countL1({ timeStart: WIN_START });
    const pStart = store.queryL1Paginated({ timeStart: WIN_START, limit: 10, offset: 0 }).total;
    const cEnd = store.countL1({ timeEnd: WIN_END });
    const pEnd = store.queryL1Paginated({ timeEnd: WIN_END, limit: 10, offset: 0 }).total;
    check("3a) 全窗 total 同口径", cFull === pFull && cFull === 1, `count=${cFull} paginated=${pFull}`);
    check("3b) 仅 start 同口径", cStart === pStart && cStart === 2, `count=${cStart} paginated=${pStart}`);
    check("3c) 仅 end 同口径", cEnd === pEnd && cEnd === 2, `count=${cEnd} paginated=${pEnd}`);

    // 4) 无效 ISO 防御
    const badStart = store.queryL1Paginated({ timeStart: "not-a-date", limit: 10, offset: 0 });
    check("4a) 非法 timeStart 被忽略（不静默错杀为 0）", badStart.total === 3, `total=${badStart.total}`);
    const badEnd = store.queryL1Paginated({ timeEnd: "not-a-date", limit: 10, offset: 0 });
    check("4b) 非法 timeEnd 被忽略", badEnd.total === 3, `total=${badEnd.total}`);
    const mixed = store.queryL1Paginated({ timeStart: WIN_START, timeEnd: "not-a-date", limit: 10, offset: 0 });
    check(
      "4c) 合法+非法混合：合法边界仍生效（t-d2/t-d3）",
      mixed.rows.map((r) => r.record_id).sort().join(",") === "t-d2,t-d3",
      JSON.stringify(mixed.rows.map((r) => r.record_id)),
    );
    check("4d) countL1 非法边界同防御", store.countL1({ timeStart: "not-a-date", timeEnd: "also-bad" }) === 3);

    // 5) 非 Z 形态规范化（+08:00 / 无毫秒 —— BFF 旧客户端可能透传）
    const offsetIso = store.queryL1Paginated({ timeStart: "2026-09-09T08:00:00+08:00", timeEnd: "2026-09-09T23:59:59+08:00", limit: 10, offset: 0 });
    check("5) +08:00 边界规范化后过滤正确（仅 t-d2）", offsetWinOk(offsetIso), JSON.stringify(offsetIso.rows.map((r) => r.record_id)));
    const noMs = store.queryL1Paginated({ timeStart: "2026-09-09T00:00:00Z", timeEnd: "2026-09-09T23:59:59Z", limit: 10, offset: 0 });
    check("5b) 无毫秒 Z 形态过滤正确（仅 t-d2）", noMs.rows.length === 1 && noMs.rows[0]?.record_id === "t-d2", JSON.stringify(noMs.rows.map((r) => r.record_id)));
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}
function offsetWinOk(res: { rows: Array<{ record_id: string }> }): boolean {
  return res.rows.length === 1 && res.rows[0]?.record_id === "t-d2";
}

// ── B. 生产数据只读探针（备份快照，readonly，零写入） ────────────────────
function sectionProdProbe(): void {
  console.log("\n── B. 生产数据只读探针（今日备份快照，readonly） ──");
  const backupDir = "D:/tdai-data/backup";
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(backupDir).filter((f) => /^vectors-\d{8}-\d{6}\.db$/.test(f)).sort();
  } catch { /* 备份目录不可达 → 跳过探针（不失败） */ }
  if (candidates.length === 0) {
    console.log("  ⚠ 无可用备份快照，跳过生产探针（不影响断言）");
    return;
  }
  const snap = path.join(backupDir, candidates[candidates.length - 1]);
  console.log(`  快照：${snap}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(snap, { readOnly: true });
  } catch (e) {
    console.log(`  ⚠ 快照只读打开失败，跳过探针：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as { c: number }).c;
    const emptyTs = (db.prepare("SELECT COUNT(*) AS c FROM l1_records WHERE updated_time = ''").get() as { c: number }).c;

    // 与 queryL1Paginated 修复后等价的"今天"窗（UTC，快照日）语义
    const m = /^vectors-(\d{4})(\d{2})(\d{2})-/.exec(path.basename(snap));
    const day = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
    const todayRow = db
      .prepare("SELECT COUNT(*) AS c FROM l1_records WHERE updated_time >= ? AND updated_time <= ?")
      .get(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as { c: number };

    console.log(`  L1 总行数=${total}，updated_time 空串=${emptyTs}，快照日(${day})窗内=${todayRow.c}`);
    check("B1) 总行数>0（有生产数据）", total > 0, `total=${total}`);
    check("B2) 窗行数 ≤ 总行数（口径合理）", todayRow.c <= total - emptyTs, `today=${todayRow.c} nonEmpty=${total - emptyTs}`);

    // 形态异质性抽检：非 "YYYY-MM-DDTHH:MM:SS.mmmZ" 形态的 updated_time 样本
    const rows = db
      .prepare("SELECT updated_time, COUNT(*) AS c FROM l1_records WHERE updated_time != '' GROUP BY updated_time LIMIT 500")
      .all() as Array<{ updated_time: string; c: number }>;
    const isoZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
    const nonZ = rows.filter((r) => !isoZ.test(r.updated_time));
    console.log(`  抽检 ${rows.length} 个 distinct updated_time，非 UTC-Z 形态=${nonZ.length}${nonZ.length > 0 ? `，样本：${nonZ.slice(0, 5).map((r) => JSON.stringify(r.updated_time)).join(", ")}` : ""}`);
    check("B3) 形态异质性已量化登记（信息性，恒过）", true);
  } finally {
    db.close();
  }
}

sectionTempDb();
sectionProdProbe();

console.log(`\n━━ 结果：${pass} passed, ${fail} failed ━━`);
if (fail > 0) process.exit(1);
