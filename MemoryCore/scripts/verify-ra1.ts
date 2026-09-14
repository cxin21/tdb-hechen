/**
 * R-A1 同形验证（结构感知召回 spec §5 验收②真数据流）：临时 sqlite 库真链路——
 * 排序层结构信号 R1/R2/R3/R8/R9 每通道 单开/全关 三态断言 + 关断矩阵。
 *
 * [A] 前置证据（数据形状实证，落库读回）：
 *     A1 last_recalled_at 真实存于 metadata_json（R1 时近性/R8 强化信号源）；
 *     A2 core_values valence 列可写可读（R9 moodSign 数据源）。
 * [B] 真实 executeMemorySearch（临时库，dimensions=0 无向量行 → FTS-only 策略，
 *     不传 embeddingService）：每场景独立 fresh 库（重巩固 fire-and-forget 不串场）。
 *     基线序在运行时实测（同内容 → BM25 同分 → 稳定排序），通道开启后断言目标条目
 *     相对基线位次前移/沉底；关断（全 0）序与基线逐位一致。
 * [C] config 解析：memory.recall 六开关 clamp/默认（parseConfig 真函数）。
 * [D] R1 时间窗解析无效输入边界（R-A1 复核 I-1）：有效锚→非空窗；乱串/未来词/空串
 *     → null → buildRankContext 无 timeSignal（宁缺毋滥：无效输入不得产生时间信号）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-ra1.ts
 *
 * 只用自建临时数据，不连任何线上资源；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { MemorySearchResultItem } from "../src/core/tools/memory-search.js";

const KW = "RA1PIN"; // 唯一 ASCII 关键词（jieba 原样保留，FTS 稳定命中）
const NOW = new Date();

/** 全关参数 = 关断矩阵锚点（六信号全 0 + coreRefBoost 0 + RV2 组合分精排全 0）。
 * FIX3（测试层隔离，零生产行为变化）：rerankWeights 全 0 关断组合分精排
 * （4ce97ea 引入、RV2-2 重设计为相关度主导四因子；本脚本直调 executeMemorySearch
 * 不带 config → 缺省权重 0.7/0.15/0.1/0.05）。其 relevance/timeProx/significance
 * 因子与 R-A1 结构信号无关，会污染零态断言（R1-off/R2-off 实测 [d,a,b,c] ≠ 基线——
 * d 的 occurred_at/significance 被组合分加成，非 PA 锚语义；详见 task-fix3-report.md）。
 * 生产注释明示"全 0 = 关断恒等"。 */
const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 },
} as const;

// ── fixture：四条同内容记录（同内容 → BM25 同分 → 基线序 = 稳定排序确定序）──
const CONTENT = `${KW} 结构感知召回验证条目`;
const mk = (id: string, soul: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): MemoryRecord =>
  ({
    id,
    content: CONTENT,
    type: "episodic",
    priority: 0,
    scene_name: "verify-ra1",
    source_message_ids: [],
    metadata,
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-ra1",
    ...soul,
  }) as MemoryRecord;

const IDS = ["a", "b", "c", "d"];

type Fixture = { rows: MemoryRecord[]; values?: Array<{ label: string; weight: number; valence: number }> };

function makeStore(fixture: Fixture): { store: VectorStore; dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ra1-"));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) {
    throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  }
  for (const m of fixture.rows) store.upsertL1(m, undefined);
  if (fixture.values) {
    for (const v of fixture.values) store.upsertValue(`v-${v.label}`, v.label, v.weight, "verify", undefined, v.valence);
  }
  return { store, dbPath, dir };
}

async function searchOrder(fixture: Fixture, params: Record<string, unknown> = {}): Promise<string[]> {
  const { store, dir } = makeStore(fixture);
  try {
    const res = await executeMemorySearch({
      query: KW,
      limit: 10,
      vectorStore: store,
      ...ALL_OFF,
      ...params,
    } as Parameters<typeof executeMemorySearch>[0]);
    return res.results.map((r: MemorySearchResultItem) => r.id);
  } finally {
    try {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows 句柄时序：清理失败无害 */ }
  }
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] 前置证据：last_recalled_at 存于 metadata_json；core_values valence 可读写");
console.log("=".repeat(72));

let aPass = false;
{
  const { store, dir } = makeStore({ rows: [mk("a")] });
  try {
    // A1：updateL1Metadata 写 last_recalled_at → metadata_json 读回
    store.updateL1Metadata("a", { recall_count: 2, last_recalled_at: "2026-09-10T08:00:00.000Z" });
    const row = (store.queryL1Records() as Array<{ record_id: string; metadata_json?: string }>).find((r) => r.record_id === "a");
    const meta = (() => { try { return JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
    const a1 = meta.last_recalled_at === "2026-09-10T08:00:00.000Z" && meta.recall_count === 2;
    console.log(`A1 last_recalled_at/recall_count 经 metadata_json 读回：${JSON.stringify(meta)}`);

    // A2：core_values valence 写读回
    store.upsertValue("v-correct", "正确性", 0.8, "verify", undefined, 1);
    const vals = store.listValues();
    const a2 = vals.length === 1 && vals[0].valence === 1 && vals[0].label === "正确性";
    console.log(`A2 core_values valence 读回：${JSON.stringify(vals.map((v) => ({ label: v.label, valence: v.valence })))}`);

    aPass = a1 && a2;
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}
check("[A] 数据形状前置证据", aPass, "last_recalled_at ∈ metadata_json；valence ∈ core_values");

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] 真实链路三态：每通道 单开/全关（fresh 库隔离重巩固副作用）");
console.log("=".repeat(72));

// 关断矩阵：全 0 → 与基线逐位一致（两次独立 fresh 库 + 确定性）
{
  const plain: Fixture = { rows: IDS.map((id) => mk(id)) };
  const base1 = await searchOrder(plain);
  const base2 = await searchOrder(plain);
  check("关断矩阵·全 0 = 基线（两次独立运行逐位一致）", JSON.stringify(base1) === JSON.stringify(base2), `基线序 [${base1.join(", ")}]`);
  const baseline = base1;

  // C1 legacy 路径 + 六信号全 0 → 仍基线（f53b173 教训：空信号不得跳过排序）
  const coreRefOn = await searchOrder(plain, { coreRefBoost: 0.05 });
  check("关断矩阵·coreRef 活跃 + 六信号全 0 = 基线", JSON.stringify(coreRefOn) === JSON.stringify(baseline), `[${coreRefOn.join(", ")}]`);

  // ── R1 时间窗 ──
  {
    const win = (await import("../src/core/tools/content-time-window.js")).parseTimeWindow(`${KW} 上周`, NOW);
    const occurred = win ? new Date(new Date(win.start).getTime() + 3_600_000).toISOString() : undefined;
    const fx: Fixture = { rows: [mk("a"), mk("b"), mk("c"), mk("d", { occurred_at: occurred })] };
    const on = await searchOrder(fx, { query: `${KW} 上周`, timeBoost: 0.05 });
    check("R1 时间窗：occurred_at ∈『上周』→ d 前移至首位", on[0] === "d", `[${on.join(", ")}]`);
    const off = await searchOrder(fx, { query: `${KW} 上周` });
    check("R1 时间窗：timeBoost=0 → 基线逐位一致", JSON.stringify(off) === JSON.stringify(baseline), `[${off.join(", ")}]`);
  }

  // ── R1 时近性 ──
  {
    const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
    const fx: Fixture = { rows: IDS.map((id) => mk(id, {}, id === "d" ? { last_recalled_at: recent } : {})) };
    const on = await searchOrder(fx, { recencyBoost: 0.03 });
    check("R1 时近性：last_recalled_at < 24h → d 前移至首位", on[0] === "d", `[${on.join(", ")}]`);
    const oldFx: Fixture = { rows: IDS.map((id) => mk(id, {}, id === "d" ? { last_recalled_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() } : {})) };
    const stale = await searchOrder(oldFx, { recencyBoost: 0.03 });
    check("R1 时近性：25h 前 → 无信号（宁缺毋滥）", JSON.stringify(stale) === JSON.stringify(baseline), `[${stale.join(", ")}]`);
  }

  // ── R2 significance ──
  {
    const fx: Fixture = { rows: IDS.map((id) => mk(id, id === "d" ? { significance: 0.9 } : {})) };
    const on = await searchOrder(fx, { sigWeight: 0.03 });
    check("R2 significance：0.9*0.03 加成 → d 前移至首位", on[0] === "d", `[${on.join(", ")}]`);
    const off = await searchOrder(fx);
    check("R2 significance：sigWeight=0 → 基线", JSON.stringify(off) === JSON.stringify(baseline), `[${off.join(", ")}]`);
  }

  // ── R3 inferred 乘法降权 ──
  {
    const fx: Fixture = { rows: [mk("a", { certainty: "inferred" }), mk("b"), mk("c"), mk("d")] };
    const on = await searchOrder(fx, { inferredPenalty: 0.1 });
    check("R3 inferred：rankKey×0.9 → a 沉底", on[on.length - 1] === "a", `[${on.join(", ")}]`);
    const off = await searchOrder(fx);
    check("R3 inferred：penalty=0 → 基线（×1 恒等）", JSON.stringify(off) === JSON.stringify(baseline), `[${off.join(", ")}]`);
  }

  // ── R8 强化闭环 ──
  {
    const fx: Fixture = { rows: IDS.map((id) => mk(id, {}, id === "d" ? { recall_count: 9 } : {})) };
    const on = await searchOrder(fx, { reinforcementWeight: 0.03 });
    check("R8 强化：log10(1+9)*0.03 → d 前移至首位", on[0] === "d", `[${on.join(", ")}]`);
    const off = await searchOrder(fx);
    check("R8 强化：reinforcementWeight=0 → 基线", JSON.stringify(off) === JSON.stringify(baseline), `[${off.join(", ")}]`);
  }

  // ── R9 mood 对称弱偏置（默认关）──
  {
    const fx: Fixture = {
      rows: IDS.map((id) => mk(id, id === "d" ? { valence: 0.6 } : {})),
      values: [{ label: "正确性", weight: 0.8, valence: 1 }],
    };
    const on = await searchOrder(fx, { query: `${KW} 正确性`, moodBoost: 0.03 });
    check("R9 mood：moodSign>0 → 正 valence d 前移至首位", on[0] === "d", `[${on.join(", ")}]`);
    const off = await searchOrder(fx, { query: `${KW} 正确性` });
    check("R9 mood：默认 0（关）→ 基线", JSON.stringify(off) === JSON.stringify(baseline), `[${off.join(", ")}]`);
    const negFx: Fixture = {
      rows: IDS.map((id) => mk(id, id === "d" ? { valence: -0.6 } : {})),
      values: [{ label: "正确性", weight: 0.8, valence: -1 }],
    };
    const neg = await searchOrder(negFx, { query: `${KW} 正确性`, moodBoost: 0.03 });
    check("R9 mood：moodSign<0 → 负 valence d 前移（对称加权）", neg[0] === "d", `[${neg.join(", ")}]`);
    const noFired = await searchOrder(fx, { moodBoost: 0.03 });
    check("R9 mood：fired 为空（query 无 label）→ 无信号", JSON.stringify(noFired) === JSON.stringify(baseline), `[${noFired.join(", ")}]`);
  }

  // ── 全开 ──
  {
    const win = (await import("../src/core/tools/content-time-window.js")).parseTimeWindow(`${KW} 上周`, NOW);
    const occurred = win ? new Date(new Date(win.start).getTime() + 3_600_000).toISOString() : undefined;
    const fx: Fixture = {
      rows: [
        mk("a", { certainty: "inferred" }),
        mk("b"),
        mk("c"),
        mk("d", { occurred_at: occurred, significance: 0.9, valence: 0.6 }, { recall_count: 9, last_recalled_at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      ],
      values: [{ label: "正确性", weight: 0.8, valence: 1 }],
    };
    const allOn = await searchOrder(fx, {
      query: `${KW} 上周 正确性`,
      timeBoost: 0.05,
      recencyBoost: 0.03,
      sigWeight: 0.03,
      inferredPenalty: 0.1,
      reinforcementWeight: 0.03,
      moodBoost: 0.03,
    });
    check("全开：多通道叠加 d 居首、inferred a 沉底", allOn[0] === "d" && allOn[allOn.length - 1] === "a", `[${allOn.join(", ")}]`);
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] config 解析：memory.recall 六开关（parseConfig 真函数）");
console.log("=".repeat(72));
{
  // parseConfig 接收 memory 插件组本体（gateway 在外层包 memory: 键）——recall 直接在顶层
  const cfg = parseConfig({ recall: { timeBoost: -1, inferredPenalty: 5, moodBoost: 0.03 } });
  const c1 =
    cfg.recall.timeBoost === 0 && // 负值 clamp 0
    cfg.recall.inferredPenalty === 1 && // 上界 1
    cfg.recall.moodBoost === 0.03 &&
    cfg.recall.recencyBoost === 0.03 && // 缺省默认
    cfg.recall.sigWeight === 0.03 &&
    cfg.recall.reinforcementWeight === 0.03 &&
    cfg.recall.coreRefBoost === 0.05;
  check("[C] clamp/默认/上界", c1, JSON.stringify({
    timeBoost: cfg.recall.timeBoost,
    recencyBoost: cfg.recall.recencyBoost,
    sigWeight: cfg.recall.sigWeight,
    inferredPenalty: cfg.recall.inferredPenalty,
    reinforcementWeight: cfg.recall.reinforcementWeight,
    moodBoost: cfg.recall.moodBoost,
  }));
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] R1 时间窗解析：无效输入边界（R-A1 复核 I-1，纯函数直调）");
console.log("=".repeat(72));
{
  const { parseTimeWindow } = await import("../src/core/tools/content-time-window.js");
  const { buildRankContext, timeSignalOf, DEFAULT_RANK_SIGNALS } = await import("../src/core/tools/recall-signals.js");

  // D1 对照锚：有效时间锚 → 非空窗（防"解析器退化为恒 null"的假绿）
  const win = parseTimeWindow("上周的修复", NOW);
  const ws = win ? Date.parse(win.start) : NaN;
  const we = win ? Date.parse(win.end) : NaN;
  check("[D] parseTimeWindow('上周的修复') → 非空窗（start/end 有效 ISO 且 start<end）",
    !!win && Number.isFinite(ws) && Number.isFinite(we) && ws < we,
    win ? `label=${win.label} start=${win.start} end=${win.end}` : "null");

  // D2 乱串/未来词 → null；buildRankContext 无 timeSignal（即使条目带 occurred_at 也不产生时间加成）
  const junk = parseTimeWindow("随便说点啥", NOW);
  const future = parseTimeWindow("明天的会议", NOW); // 未来词无匹配锚 → 同边界 null（证据项，并入本断言）
  const ctx = await buildRankContext("随便说点啥", [{ occurred_at: NOW.toISOString() }], { now: NOW });
  const d2 = junk === null && future === null && ctx.timeWindow === null &&
    timeSignalOf({ occurred_at: NOW.toISOString() }, ctx.timeWindow, DEFAULT_RANK_SIGNALS.timeBoost) === 0;
  check("[D] parseTimeWindow('随便说点啥'/'明天的会议') → null；buildRankContext 无 timeSignal（timeSignalOf=0）",
    d2, `junk=${junk} future=${future} ctx.timeWindow=${ctx.timeWindow}`);

  // D3 空串 → null（!query 早退守卫）
  const empty = parseTimeWindow("", NOW);
  check("[D] parseTimeWindow('') → null", empty === null, `parse=${empty}`);
}

// ══════════════════════════════════════════════════════════
const pass = aPass && results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}；B/C/D ${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
