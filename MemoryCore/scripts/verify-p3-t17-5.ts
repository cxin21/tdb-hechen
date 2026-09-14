/**
 * P3-T17.5 同形验证：scheduler 行映射根治（R5 第四实例源头修复）+ T17 防御退化复核。
 *
 * 背景（task-17-5-brief.md）：
 *   lifecycle-scheduler 的 queryL1 行映射不映射 id（record_id 丢失）、metadata 只填
 *   activity_start_time/occurred_at 两个派生值（丢弃 metadata_json 全部内容）、且派生空串
 *   ?? "" 会盖真值（F-2）。T17 已在 consolidation-worker 入口打 normalizeRowMetadata 止血
 *   （保留为防御）；本任务在源头根治，并让 forgetting 链路（scorer 的
 *   significance/valence/recall_count 兜底）真实生效。
 *
 * 断言组（验收契约，同形）：
 *   A1. 行形状契约：裸行（record_id/metadata_json，无 id/metadata——生产 L1RecordRow 形状）
 *       → 走 scheduler 映射 → 行有 id === record_id；metadata 含 metadata_json 原有字段。
 *   A2. forgetting 加成链路激活：metadata_json 含 significance=0.9、recall_count=2 的行
 *       → scorer.scoreFor 对映射后行输出真 significance 分量（≠0.5 常数路径）与 boost 0.04。
 *   A3. F-2：派生空串不盖真值——metadata_json 真值在 timestamp_start 为空串时保留。
 *   A4. 容忍：metadata_json 非法 JSON → 不抛、解析为 {}，id 仍兜底。
 *   B.  T17.5-B 双保险：normalizeRowMetadata 合并方向修正——metadata 字段里的空串派生值
 *       不再盖 metadata_json 真值（模拟 tcvdb 等非 scheduler 来源的防御场景）。
 *   C.  forgetting-worker 消费同一映射：scheduler 映射后的行直接喂 runForgetting——
 *       boost 真实救回临界行（无 boost 会归档）、低分行归档且候选 id 取自映射后的 id。
 *
 * 先跑 RED（修复前：id=undefined / metadata 无 significance / boost=0 / 空串盖真值）
 * 证明根治必要，修复后全 PASS。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p3-t17-5.ts
 *
 * 纯逻辑验证（不连库、不碰 D:/tdai-data）。
 */
import * as schedulerModule from "../src/core/lifecycle/lifecycle-scheduler.js";
import * as consolidationModule from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import { classify, scoreFor, recallCountBoost, DEFAULT_FORGETTING_CONFIG } from "../src/core/lifecycle/forgetting/scorer.js";
import { runForgetting } from "../src/core/lifecycle/forgetting/forgetting-worker.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// ── fixture：生产 L1RecordRow 裸行形状（无 id、无 metadata、无 occurred_at）────────
const NOW = Date.parse("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

interface BareRowOpts {
  priority?: number;
  daysOld?: number;
  meta?: Record<string, unknown>;
  metadataJson?: string;
}
function bareRow(recordId: string, opts: BareRowOpts = {}): Record<string, unknown> {
  const ts = opts.daysOld !== undefined ? daysAgo(opts.daysOld) : daysAgo(1);
  return {
    record_id: recordId,
    content: `bare-row-${recordId}`,
    type: "episodic",
    priority: opts.priority ?? 60,
    scene_name: "verify-p3-t17-5",
    session_key: "k",
    session_id: "sid",
    team_id: "",
    task_id: "",
    user_id: "",
    agent_id: "",
    version: 1,
    timestamp_str: ts,
    timestamp_start: ts,
    timestamp_end: "",
    created_time: ts,
    updated_time: ts,
    metadata_json: opts.metadataJson ?? JSON.stringify(opts.meta ?? {}),
    // 故意不含：id / metadata / occurred_at —— 生产 L1RecordRow 就没有这些字段
  };
}

console.log("=".repeat(72));
console.log("P3-T17.5 同形验证：scheduler 行映射根治 + forgetting 加成链路激活断言");
console.log("=".repeat(72));

// 可选导入：修复前函数未导出 → 断言以显式 FAIL 呈现（RED），不让脚本崩溃
const mapL1RowToRecord = (schedulerModule as unknown as {
  mapL1RowToRecord?: (r: Record<string, unknown>) => Record<string, unknown>;
}).mapL1RowToRecord;
const normalizeRowMetadata = (consolidationModule as unknown as {
  normalizeRowMetadata?: (m: unknown) => Record<string, unknown>;
}).normalizeRowMetadata;

const FORGET_CFG = { ...DEFAULT_FORGETTING_CONFIG }; // enabled/λ0.01/low0.12/minAge30/max100

// ── 断言组 A1：行形状契约（裸行 → scheduler 映射）────────────────
console.log("\n[A1] 裸行（record_id/metadata_json，无 id/metadata）→ scheduler 映射 → id 与完整 metadata");
{
  if (!mapL1RowToRecord) {
    check("[A1] mapL1RowToRecord 已导出（T17.5-A 根治落地）", false, "RED：映射函数未导出");
  } else {
    const row = bareRow("row_a1", { meta: { subject: "本地部署偏好", significance: 0.9, recall_count: 2 } });
    const mapped = mapL1RowToRecord(row) as Record<string, unknown>;
    check("[A1] 行有 id === record_id（根治点 1：消费方 archiveL1/幂等都靠它）", mapped.id === "row_a1", `id=${String(mapped.id)}`);
    const meta = (mapped.metadata ?? {}) as Record<string, unknown>;
    check("[A1] metadata 含 metadata_json 原有字段（significance）", meta.significance === 0.9, `significance=${String(meta.significance)}`);
    check("[A1] metadata 含 metadata_json 原有字段（recall_count）", meta.recall_count === 2, `recall_count=${String(meta.recall_count)}`);
    check("[A1] metadata 含 metadata_json 原有字段（subject）", meta.subject === "本地部署偏好", `subject=${String(meta.subject)}`);
    check("[A1] 真值派生值仍在（timestamp_start → activity_start_time）", typeof meta.activity_start_time === "string" && (meta.activity_start_time as string).length > 0);
    check("[A1] 映射不丢既有字段（record_id 仍在行上）", mapped.record_id === "row_a1");
  }
}

// ── 断言组 A2：forgetting 加成链路激活（真 significance 分量 + boost 0.04）────────
console.log("\n[A2] metadata_json 含 significance=0.9 / recall_count=2 → scoreFor 真 significance 分量 + boost 0.04");
{
  if (!mapL1RowToRecord) {
    check("[A2] 依赖 A1 映射", false, "RED：映射函数未导出");
  } else {
    // age=40d（timestamp_start=40 天前 → derived.activity_start_time → ageDaysOf 取到）
    // 期望（真 significance 0.9，priority 60 → 0.6）：
    //   score = min(1, 0.9*0.6*exp(-0.01*40) + min(2,5)*0.02) ≈ 0.402
    // 0.5 常数路径对照：0.5*0.6*exp(-0.4) ≈ 0.201（无 boost）——两者可区分
    const row = bareRow("row_a2", { daysOld: 40, meta: { significance: 0.9, recall_count: 2 } });
    const mapped = mapL1RowToRecord(row) as never;
    const expectedReal = Math.min(1, 0.9 * 0.6 * Math.exp(-0.01 * 40) + 0.04);
    const expectedConst = 0.5 * 0.6 * Math.exp(-0.01 * 40);
    const score = scoreFor(mapped, FORGET_CFG, NOW);
    check("[A2] scoreFor = 0.9×priority×decay + 0.04（真 significance 分量，非 0.5 常数路径）", near(score, expectedReal), `score=${score.toFixed(6)} expected=${expectedReal.toFixed(6)}`);
    check("[A2] 与 0.5 常数路径可区分", score > expectedConst + 0.1, `constPath=${expectedConst.toFixed(6)}`);
    check("[A2] recallCountBoost = 2×0.02 = 0.04", near(recallCountBoost(mapped), 0.04), `boost=${recallCountBoost(mapped).toFixed(4)}`);
    // 对照组：metadata_json 无 significance/recall_count → 退回 0.5 常数路径、boost 0
    const ctrl = mapL1RowToRecord(bareRow("row_a2_ctrl", { daysOld: 40 })) as never;
    check("[A2] 对照：无 json 字段仍走 0.5 常数路径 + boost 0（存量兼容）",
      near(scoreFor(ctrl, FORGET_CFG, NOW), expectedConst) && near(recallCountBoost(ctrl), 0),
      `ctrl=${scoreFor(ctrl, FORGET_CFG, NOW).toFixed(6)}`);
  }
}

// ── 断言组 A3：F-2 空串不盖真值 ─────────────────────────────────
console.log("\n[A3] F-2：timestamp_start 空串时 metadata_json 真值不被派生空串覆盖");
{
  if (!mapL1RowToRecord) {
    check("[A3] 依赖 A1 映射", false, "RED：映射函数未导出");
  } else {
    const row = bareRow("row_a3", {
      meta: { activity_start_time: "2026-01-01T00:00:00Z", occurred_at: "2026-01-01T00:00:00Z" },
    });
    (row as { timestamp_start: string }).timestamp_start = ""; // 派生源为空串
    const mapped = mapL1RowToRecord(row) as Record<string, unknown>;
    const meta = (mapped.metadata ?? {}) as Record<string, unknown>;
    check("[A3] metadata_json 的 activity_start_time 真值保留", meta.activity_start_time === "2026-01-01T00:00:00Z", `got=${String(meta.activity_start_time)}`);
    check("[A3] metadata_json 的 occurred_at 真值保留", meta.occurred_at === "2026-01-01T00:00:00Z", `got=${String(meta.occurred_at)}`);
    const emptyDerived = Object.entries(meta).filter(([, v]) => v === "");
    check("[A3] metadata 无空串派生值（?? \"\" 不再入 metadata）", emptyDerived.length === 0, `empties=${JSON.stringify(emptyDerived)}`);
  }
}

// ── 断言组 A4：metadata_json 非法 JSON 容忍 ─────────────────────
console.log("\n[A4] metadata_json 非法 JSON → 不抛、解析为 {}，id 仍兜底");
{
  if (!mapL1RowToRecord) {
    check("[A4] 依赖 A1 映射", false, "RED：映射函数未导出");
  } else {
    let threw = false;
    let mapped: Record<string, unknown> = {};
    try {
      mapped = mapL1RowToRecord(bareRow("row_a4", { metadataJson: "not-json{{" })) as Record<string, unknown>;
    } catch { threw = true; }
    check("[A4] 不抛异常", !threw);
    check("[A4] id 仍兜底为 record_id", mapped.id === "row_a4");
    const meta = (mapped.metadata ?? {}) as Record<string, unknown>;
    // 解析失败容忍指 parsedMeta={}（不造假值），合法真值派生字段（activity_start_time 等）仍在；
    // 断言无任何 json 来源残留字段（派生白名单之外应为空）。
    const residual = Object.keys(meta).filter((k) => k !== "activity_start_time" && k !== "occurred_at");
    check("[A4] 解析失败容忍为 {}（无 json 造假值，仅剩合法派生字段）", residual.length === 0, `residual=${JSON.stringify(residual)}`);
  }
}

// ── 断言组 B：T17.5-B normalizeRowMetadata 空串不盖真值（双保险）──
console.log("\n[B] normalizeRowMetadata（T17 防御）：metadata 字段空串派生值不再盖 metadata_json 真值");
{
  if (!normalizeRowMetadata) {
    check("[B] normalizeRowMetadata 已导出（T17.5-B 双保险落地）", false, "RED：防御函数未导出");
  } else {
    // 模拟非 scheduler 来源（tcvdb/单测）：行带 metadata 字段含旧式派生空串 + metadata_json 真值
    const m = {
      record_id: "row_b",
      metadata: { occurred_at: "", activity_start_time: "" },
      metadata_json: JSON.stringify({ occurred_at: "2026-01-01T00:00:00Z", significance: 0.8 }),
    };
    const out = normalizeRowMetadata(m);
    check("[B] record_id 兜底为 id（T17 防御保留）", out.id === "row_b", `id=${String(out.id)}`);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    check("[B] metadata_json 的 occurred_at 真值保留（空串不再覆盖）", meta.occurred_at === "2026-01-01T00:00:00Z", `got=${String(meta.occurred_at)}`);
    check("[B] metadata_json 的 significance 仍在", meta.significance === 0.8);
  }
}

// ── 断言组 C：forgetting-worker 消费同一映射（boost 真实救回 + 候选 id）─────────
console.log("\n[C] runForgetting 吃 scheduler 映射后的行：boost 真实生效（临界行被救回）、候选 id 真实");
{
  if (!mapL1RowToRecord) {
    check("[C] 依赖 A1 映射", false, "RED：映射函数未导出");
  } else {
    // 临界行：significance=0.25, priority=60, age=40d → base=0.25*0.6*exp(-0.4)≈0.1005 < 0.12（无 boost 会归档）
    //         +boost 0.04 → 0.1405 ≥ 0.12 → keep（boost 真实生效）
    const marginal = mapL1RowToRecord(bareRow("row_marginal", { daysOld: 40, meta: { significance: 0.25, recall_count: 2 } })) as never;
    check("[C] 临界行无 boost 会归档（前提成立）", classify(mapL1RowToRecord(bareRow("row_marginal_nb", { daysOld: 40, meta: { significance: 0.25 } })) as never, FORGET_CFG, NOW) === "archive");
    check("[C] 临界行有 boost → keep（reconsolidation 抗遗忘真实生效）", classify(marginal, FORGET_CFG, NOW) === "keep");
    check("[C] 临界行 score = base+0.04", near(scoreFor(marginal, FORGET_CFG, NOW), 0.25 * 0.6 * Math.exp(-0.4) + 0.04), `score=${scoreFor(marginal, FORGET_CFG, NOW).toFixed(6)}`);

    // 低分行：significance=0.1, priority=10, age=100d → 0.1*0.1*exp(-1)≈0.0037 → archive，候选 id 取映射后 id
    const low = mapL1RowToRecord(bareRow("row_low", { priority: 10, daysOld: 100, meta: { significance: 0.1 } })) as never;
    const res = await runForgetting({
      queryL1: async () => [marginal, low],
      config: FORGET_CFG,
      logger: { info: () => {}, warn: () => {}, debug: () => {} } as never,
    });
    check("[C] 低分行判出且候选 id === record_id（映射后行有 id）", res.candidates.length === 1 && res.candidates[0] === "row_low", `candidates=${JSON.stringify(res.candidates)}`);
    check("[C] 临界行不被归档（宁漏勿多方向不变）", !res.candidates.includes("row_marginal"));
    check("[C] archived=0（未提供 store，仅判定）", res.archived === 0);
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
console.log(`总体：${fail === 0 ? "ALL PASS" : "FAIL"}（${pass} pass, ${fail} fail）`);
process.exit(fail === 0 ? 0 : 1);
