/**
 * P1-T7+T8 同形验证：FTS soul 25 列迁移（W1）+ restoreL1 分词（H-B9）。
 *
 * 背景：
 *   W1：l1_fts 虚表只有 17 列（无 soul 8 字段）→ stmtL1FtsSearch SELECT 无 →
 *       FtsSearchResult / L1FtsResult 无 → memory-search.ts FTS 映射（:229-248，
 *       已写好 occurred_at: r.occurred_at…）恒 undefined。后果：J 时间窗对 FTS
 *       命中恒不拦、回忆片段无情感标注、T2 重巩固门对 FTS 行全量跳过。
 *   H-B9：restoreL1 的 FTS 重建传 d.content 原文（未分词），中文记忆恢复后在
 *       FTS 里是未分词整串，BM25 MATCH 大概率搜不到。
 *
 * 五组断言（验收契约）：
 *   1. 全新临时库 → l1_fts 25 列、末尾 8 列 = 硬编码 soul 锚（PRAGMA 对照）。
 *      —— 锚为【字面量名单】，不从 SOUL_COLUMNS import（T6 审查 Minor-1 裁定：
 *      第三方锚必须独立于被测实现，否则实现抄错锚也跟着错）。
 *   2. 写中文记忆（8 soul 字段全量赋值）→ searchL1Fts 命中 → 8 字段逐项
 *      roundtrip 相等（W1 兑现点：FTS 行带 soul）。
 *   3. 时间窗兑现：inTimeWindow + occurred_at 组合（直接调纯函数，不绕
 *      executeMemorySearch）——occurred_at 落在"上周"窗外 → 被拦；窗内 → 不拦。
 *      附带断言：searchL1Fts 命中行的 occurred_at 能被 inTimeWindow 消费
 *      （J 通道从"恒不拦"到"按值拦截"的兑现）。
 *   4. 旧库迁移：模拟旧 17 列 l1_fts → migrateL1FtsSoul() → 25 列、soul 回填
 *      正确、行数一致、FTS 搜索仍可用、二次调用幂等。
 *   5. T8：归档中文记忆 → restoreL1 → searchL1Fts 用中文关键词命中恢复行
 *      （修复前 FAIL：未分词搜不到）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p1-t7.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTimeWindow, inTimeWindow } from "../src/core/tools/content-time-window.js";
import { VectorStore, buildFtsQuery, tokenizeForFts } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// ── 硬编码第三方锚（T6 审查 Minor-1 裁定：字面量，不 import SOUL_COLUMNS）──
const SOUL_ANCHOR = [
  "occurred_at", "valid_start", "valid_end", "certainty",
  "source", "valence", "arousal", "significance",
] as const;
/** 旧 17 列 l1_fts 基础列（迁移前 schema，字面量） */
const LEGACY_FTS_BASE_COLS = [
  "content", "content_original", "record_id", "type", "priority", "scene_name",
  "session_key", "session_id", "team_id", "task_id", "user_id", "agent_id",
  "version", "timestamp_str", "timestamp_start", "timestamp_end", "metadata_json",
] as const;

const dayMs = 86_400_000;

// ── 共享 fixture（soul 8 字段全量赋值，roundtrip 无默认值歧义）──
const yesterday = new Date(Date.now() - dayMs).toISOString();
const threeDaysAgo = new Date(Date.now() - 3 * dayMs).toISOString();
const SOUL_FIXTURE = {
  occurred_at: yesterday,
  valid_start: "2026-01-01T00:00:00.000Z",
  valid_end: "2027-01-01T00:00:00.000Z",
  certainty: "observed",
  source: "user",
  valence: 0.8,
  arousal: 0.3,
  significance: 0.9,
} as const;

const mk = (id: string, content: string, soul: Record<string, unknown> = SOUL_FIXTURE): MemoryRecord =>
  ({
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-p1-t7",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p1-t7",
    ...soul,
  }) as MemoryRecord;

const results: Array<{ group: string; pass: boolean; detail: string }> = [];
const record = (group: string, pass: boolean, detail: string) => {
  results.push({ group, pass, detail });
  console.log(`  [${group}] ${pass ? "PASS" : "FAIL"}: ${detail}`);
};

console.log("=".repeat(72));
console.log("P1-T7+T8 同形验证：FTS soul 25 列迁移 + restoreL1 分词");
console.log("=".repeat(72));

// ── 断言组 1：全新临时库 l1_fts 25 列 ─────────────────────────────
console.log("\n[1] 全新临时库：l1_fts 列数 = 17 基础 + 8 soul（PRAGMA vs 硬编码锚）");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t7-g1-"));
  try {
    const store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) {
      record("1", false, `临时库初始化降级（环境问题，非行为断言）：${initRes.reason}`);
    } else {
      const cols = (store.getRawDb().prepare("PRAGMA table_info(l1_fts)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      const countOk = cols.length === 25;
      const tailOk =
        cols.length >= 8 &&
        JSON.stringify(cols.slice(-8)) === JSON.stringify(SOUL_ANCHOR.map(String));
      record(
        "1",
        countOk && tailOk,
        countOk && tailOk
          ? `l1_fts ${cols.length} 列，末尾 8 列与硬编码锚逐位一致`
          : `列数=${cols.length}（期望 25），末尾 8 列=[${cols.slice(-8).join(", ")}]（期望 ${SOUL_ANCHOR.join(", ")}）`,
      );
      store.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

// ── 断言组 2：FTS 行 soul roundtrip（W1 兑现点）──────────────────
console.log("\n[2] 写中文记忆（soul 全量）→ searchL1Fts → 8 字段逐项 roundtrip");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t7-g2-"));
  try {
    const store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) {
      record("2", false, `临时库初始化降级：${initRes.reason}`);
    } else {
      const content = "用户偏好本地部署大模型推理（项目代号青竹）";
      store.upsertL1(mk("m_soul_rt", content), undefined);
      const q = buildFtsQuery("青竹");
      const hits = q ? store.searchL1Fts(q, 10) : [];
      const hit = hits.find((r) => r.record_id === "m_soul_rt");
      if (!hit) {
        record("2", false, `searchL1Fts(${JSON.stringify(q)}) 未命中 m_soul_rt（hits=${hits.length}）`);
      } else {
        const mismatches: string[] = [];
        for (const [k, v] of Object.entries(SOUL_FIXTURE)) {
          const got = (hit as unknown as Record<string, unknown>)[k];
          if (got !== v) mismatches.push(`${k}: got=${JSON.stringify(got)} expected=${JSON.stringify(v)}`);
        }
        record(
          "2",
          mismatches.length === 0,
          mismatches.length === 0
            ? "命中且 8 字段逐项 roundtrip 相等（occurred_at/valid_start/valid_end/certainty/source/valence/arousal/significance）"
            : `字段不一致 → ${mismatches.join("; ")}`,
        );
      }
      store.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

// ── 断言组 3：时间窗兑现（inTimeWindow + occurred_at）────────────
console.log("\n[3] 时间窗兑现：occurred_at 落在'上周'窗外被拦 / 窗内不拦（直接调纯函数）");
{
  // "上周"窗随今天星期几而移动；昨天/3天前是否落窗取决于星期几。
  // 因此期望值用独立日历算术推导（不调 inTimeWindow），断言其行为与日历一致 ——
  // 既保留 brief 的"昨天 / 3天前"具体场景，又保证任何一天运行都有判别力。
  const win = parseTimeWindow("上周");
  if (!win) {
    record("3", false, "parseTimeWindow('上周') 返回 null（解析器回归）");
  } else {
    const s = new Date(win.start).getTime();
    const e = new Date(win.end).getTime();
    // 期望值：日历算术独立推导
    const yestIn = new Date(yesterday).getTime() >= s && new Date(yesterday).getTime() < e;
    const threeIn = new Date(threeDaysAgo).getTime() >= s && new Date(threeDaysAgo).getTime() < e;
    // 判别力核心：窗口紧邻两侧各取一点，必然一拦一放（与星期几无关）
    const justInside = new Date(s + 3_600_000).toISOString(); // 上周周一 01:00 → 必在窗内
    const justOutside = new Date(e + 3_600_000).toISOString(); // 本周一 01:00 → 必在窗外
    const pass =
      inTimeWindow(justInside, win) === true &&
      inTimeWindow(justOutside, win) === false &&
      inTimeWindow(yesterday, win) === yestIn &&
      inTimeWindow(threeDaysAgo, win) === threeIn;
    record(
      "3",
      pass,
      pass
        ? `窗 [${win.start} ~ ${win.end})：紧邻窗内点不拦、紧邻窗外点被拦；昨天→${yestIn ? "窗内" : "被拦"}、3天前→${threeIn ? "窗内" : "被拦"}（与日历一致）`
        : `inTimeWindow 行为与日历不符：inside=${inTimeWindow(justInside, win)}(期望true) outside=${inTimeWindow(justOutside, win)}(期望false) yesterday=${inTimeWindow(yesterday, win)}(期望${yestIn}) threeDaysAgo=${inTimeWindow(threeDaysAgo, win)}(期望${threeIn})`,
    );
  }
}

// ── 断言组 4：旧 17 列库迁移（migrateL1FtsSoul）──────────────────
console.log("\n[4] 旧库迁移：17 列 l1_fts → migrateL1FtsSoul() → 25 列 + soul 回填 + 幂等");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t7-g4-"));
  try {
    const store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) {
      record("4", false, `临时库初始化降级：${initRes.reason}`);
    } else if (typeof (store as unknown as Record<string, unknown>).migrateL1FtsSoul !== "function") {
      record("4", false, "migrateL1FtsSoul 未实现（T7-A 迁移入口缺失）");
      store.close();
    } else {
      const raw = store.getRawDb();
      const contentA = "团队决定采用本地部署方案部署推理服务";
      const contentB = "产品评审通过青竹项目二期立项";
      store.upsertL1(mk("m_old_a", contentA), undefined);
      store.upsertL1(mk("m_old_b", contentB, { ...SOUL_FIXTURE, certainty: "inferred", valence: -0.2 }), undefined);

      // 模拟旧库：DROP 新表 → 手工建旧 17 列表 → 手工回插 FTS 行（content 已是分词产物）
      raw.exec("DROP TABLE l1_fts");
      raw.exec(`
        CREATE VIRTUAL TABLE l1_fts USING fts5(
          content,
          ${LEGACY_FTS_BASE_COLS.slice(1).map((c) => `${c} UNINDEXED`).join(",\n          ")}
        )
      `);
      const legacyRows = raw
        .prepare(
          `SELECT ${LEGACY_FTS_BASE_COLS.filter((c) => c !== "content_original").join(", ")} FROM l1_records`,
        )
        .all() as Array<Record<string, unknown>>;
      const insertLegacy = raw.prepare(
        `INSERT INTO l1_fts (${LEGACY_FTS_BASE_COLS.join(", ")}) VALUES (${LEGACY_FTS_BASE_COLS.map(() => "?").join(", ")})`,
      );
      for (const r of legacyRows) {
        insertLegacy.run(
          tokenizeForFts(String(r.content)), String(r.content), String(r.record_id), String(r.type), Number(r.priority),
          String(r.scene_name), String(r.session_key), String(r.session_id), String(r.team_id), String(r.task_id),
          String(r.user_id), String(r.agent_id), Number(r.version), String(r.timestamp_str), String(r.timestamp_start),
          String(r.timestamp_end), String(r.metadata_json),
        );
      }
      const beforeCols = (raw.prepare("PRAGMA table_info(l1_fts)").all() as Array<{ name: string }>).map((c) => c.name);
      if (beforeCols.length !== 17 || beforeCols.some((c) => (SOUL_ANCHOR as readonly string[]).includes(c))) {
        record("4", false, `前置条件不符：模拟旧表列数=${beforeCols.length}（期望 17）`);
      } else {
        // 执行迁移
        let mig: { migrated: boolean; rows: number };
        let migErr: string | null = null;
        try {
          mig = (store as unknown as { migrateL1FtsSoul(): { migrated: boolean; rows: number } }).migrateL1FtsSoul();
        } catch (e) {
          migErr = e instanceof Error ? e.message : String(e);
          mig = { migrated: false, rows: -1 };
        }
        const afterCols = (raw.prepare("PRAGMA table_info(l1_fts)").all() as Array<{ name: string }>).map((c) => c.name);
        const colsOk =
          !migErr && mig.migrated === true &&
          afterCols.length === 25 &&
          JSON.stringify(afterCols.slice(-8)) === JSON.stringify(SOUL_ANCHOR.map(String));
        // soul 回填正确：FTS 行 soul 与 l1_records 主表一致
        let backfillOk = false;
        let backfillDetail = "";
        if (colsOk) {
          const pairs = raw
            .prepare(
              `SELECT f.record_id, f.occurred_at, f.valid_start, f.valid_end, f.certainty, f.source,
                      f.valence, f.arousal, f.significance,
                      r.occurred_at AS r_occurred_at, r.valid_start AS r_valid_start,
                      r.valid_end AS r_valid_end, r.certainty AS r_certainty, r.source AS r_source,
                      r.valence AS r_valence, r.arousal AS r_arousal, r.significance AS r_significance
               FROM l1_fts f LEFT JOIN l1_records r ON f.record_id = r.record_id`,
            )
            .all() as Array<Record<string, unknown>>;
          backfillOk =
            pairs.length === 2 &&
            pairs.every(
              (p) =>
                p.occurred_at === p.r_occurred_at &&
                p.valid_start === p.r_valid_start && p.valid_end === p.r_valid_end &&
                p.certainty === p.r_certainty && p.source === p.r_source &&
                p.valence === p.r_valence && p.arousal === p.r_arousal &&
                p.significance === p.r_significance,
            );
          backfillDetail = `回填校验 ${pairs.length} 行`;
        }
        // 幂等：二次调用 migrated=false
        let idemOk = false;
        if (colsOk) {
          const second = (store as unknown as { migrateL1FtsSoul(): { migrated: boolean; rows: number } }).migrateL1FtsSoul();
          idemOk = second.migrated === false;
        }
        // FTS 搜索仍可用且带 soul
        let searchOk = false;
        if (colsOk && idemOk) {
          const q = buildFtsQuery("青竹");
          const hits = q ? store.searchL1Fts(q, 10) : [];
          const hitB = hits.find((r) => r.record_id === "m_old_b");
          searchOk =
            hits.some((r) => r.record_id === "m_old_a" || r.record_id === "m_old_b") &&
            hitB !== undefined &&
            hitB.certainty === "inferred" &&
            hitB.valence === -0.2;
        }
        record(
          "4",
          colsOk && backfillOk && idemOk && searchOk,
          colsOk
            ? `migrated=${mig.migrated} rows=${mig.rows}，25 列锚对齐；回填${backfillOk ? "一致" : "不一致"}；幂等二次调用=${idemOk ? "migrated=false" : "异常"}；FTS 搜索=${searchOk ? "可用且带 soul" : "异常"}`
            : `迁移失败：${migErr ?? `cols=${afterCols.length} migrated=${mig.migrated}`}`,
        );
      }
      store.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

// ── 断言组 5：T8 restoreL1 分词 ──────────────────────────────────
console.log("\n[5] T8：归档中文记忆 → restoreL1 → 中文关键词 FTS 命中恢复行");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p1-t7-g5-"));
  try {
    const store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) {
      record("5", false, `临时库初始化降级：${initRes.reason}`);
    } else {
      const content = "用户偏好本地部署大模型推理（项目代号青竹）";
      store.upsertL1(mk("m_restore", content), undefined);
      const archived = store.archiveL1("m_restore", "verify-t8");
      const restored = archived ? store.restoreL1("m_restore") : false;
      const q = buildFtsQuery("青竹");
      const hits = restored && q ? store.searchL1Fts(q, 10) : [];
      const hit = hits.find((r) => r.record_id === "m_restore");
      record(
        "5",
        archived && restored && hit !== undefined && hit.certainty === "observed",
        archived && restored
          ? hit !== undefined && hit.certainty === "observed"
            ? "归档→恢复→中文关键词命中恢复行（FTS 行为分词产物，BM25 可搜）"
            : `恢复成功但中文关键词未命中（hits=${hits.length}）—— 未分词整串，正是 H-B9 症状`
          : `archiveL1=${archived} restoreL1=${restored}（链路先坏，非 T8 断言）`,
      );
      store.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log("");
console.log("=".repeat(72));
for (const r of results) console.log(`  ${r.group}: ${r.pass ? "PASS" : "FAIL"}`);
console.log(
  `总体：${failed.length === 0 ? "PASS" : "FAIL"}（${results.length - failed.length}/${results.length} 组通过）`,
);
process.exit(failed.length === 0 ? 0 : 1);
