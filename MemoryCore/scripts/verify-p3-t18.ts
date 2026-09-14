/**
 * P3-T18 同形验证：durative significance 真值（H-B8/K6）。
 *
 * 背景：
 *   summarizer 的 durative significance 读 priority/100 而非 P2a 顶层 significance 字段
 *   （与二轮 A2 同款错误模式）；叠加 worker 恒 priority:80 → 所有 durative significance
 *   恒 0.8 常量 → M 反漂移三门（≥0.7/≥2/observed）对 H 产物结构性恒过。
 *   T17.5 已让 scheduler 行映射带真 metadata/顶层字段——真值可达，summarizer 只差读对字段。
 *
 * 修法（T18-A）：读组内顶层 significance 真实 max（P2a 权威字段）；
 *   半数以上缺值才退中性 0.5（P-D：拿不到真值不造假值，但也不放弃真实信息）。
 *
 * 断言组（验收契约，同形）：
 *   1. 组 sig=[0.3,0.9,0.6] → durative significance=0.9（RED 先行：修复前恒 0.8）
 *   2. 半数缺值（3 条中 2 条无 significance 字段）→ 0.5 中性
 *   3. 全缺 → 0.5
 *   4. 混 inferred 组 → 不巩固（T1.1 既有行为回归确认，P0-T1 sourceMemories 过滤）
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p3-t18.ts
 *
 * 纯逻辑 mock（LLMRunner 返回固定 JSON），不连任何线上资源、不碰生产库。
 */
import { buildDurativeSummary } from "../src/core/lifecycle/consolidation/summarizer.js";
import { runConsolidation } from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import type { LLMRunner } from "../src/core/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { ConsolidationGroup } from "../src/core/lifecycle/consolidation/grouping.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 正常 LLM mock：返回合法持续态 JSON。 */
function okLLM(): LLMRunner {
  return { run: async () => JSON.stringify({ content: "持续态摘要内容", certainty: "observed" }) } as never;
}

/** 构造 fixture：priority 恒 80（复刻 worker 恒定值），significance 顶层可选，metadata.subject 语义归组键。 */
function mk(id: string, day: string, content: string, opts: { significance?: number; certainty?: "observed" | "inferred"; subject?: string } = {}): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 80,
    scene_name: "s",
    source_message_ids: [],
    metadata: opts.subject ? { subject: opts.subject } : {},
    timestamps: [`${day}T00:00:00Z`],
    createdAt: `${day}T00:00:00Z`,
    updatedAt: `${day}T00:00:00Z`,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p3-t18",
    certainty: opts.certainty ?? "observed",
    ...(opts.significance !== undefined ? { significance: opts.significance } : {}),
  } as unknown as MemoryRecord;
}

function groupOf(memories: MemoryRecord[], subject = "本地部署偏好"): ConsolidationGroup {
  const ts = memories.map((m) => new Date((m.timestamps?.[0] ?? "2026-09-01T00:00:00Z")).getTime());
  return {
    subject,
    memories,
    earliestTs: Math.min(...ts),
    latestTs: Math.max(...ts),
  };
}

console.log("=".repeat(72));
console.log("P3-T18 同形验证：durative significance 真值（H-B8/K6）");
console.log("=".repeat(72));

// ── 断言组 1：真值 max（RED 先行：修复前恒 0.8）────────────────
console.log("\n[1] 组 sig=[0.3,0.9,0.6]（priority 恒 80）→ durative significance=0.9（修复前恒 0.8）");
{
  const g = groupOf([
    mk("m1", "2026-09-01", "用户喜欢本地部署：省成本", { significance: 0.3 }),
    mk("m2", "2026-09-04", "用户偏好本地部署：安全", { significance: 0.9 }),
    mk("m3", "2026-09-07", "用户爱用本地部署：低时延", { significance: 0.6 }),
  ]);
  const d = await buildDurativeSummary(g, { llmRunner: okLLM() });
  check("[1] significance=0.9（真值 max，非 priority/100=0.8 常量）", d?.significance === 0.9, `got=${String(d?.significance)}`);
}

// ── 断言组 2：半数缺值 → 0.5 中性 ───────────────────────────────
console.log("\n[2] 半数缺值（3 条中 2 条无 significance）→ 0.5 中性（不造假值）");
{
  const g = groupOf([
    mk("m1", "2026-09-01", "用户喜欢本地部署：省成本", { significance: 0.9 }),
    mk("m2", "2026-09-04", "用户偏好本地部署：安全"),
    mk("m3", "2026-09-07", "用户爱用本地部署：低时延"),
  ]);
  const d = await buildDurativeSummary(g, { llmRunner: okLLM() });
  check("[2] significance=0.5（sigs 1 条 < ceil(3/2)=2，半数规则退中性）", d?.significance === 0.5, `got=${String(d?.significance)}`);
}

// ── 断言组 3：全缺 → 0.5 ────────────────────────────────────────
console.log("\n[3] 全缺（3 条均无 significance）→ 0.5 中性");
{
  const g = groupOf([
    mk("m1", "2026-09-01", "用户喜欢本地部署：省成本"),
    mk("m2", "2026-09-04", "用户偏好本地部署：安全"),
    mk("m3", "2026-09-07", "用户爱用本地部署：低时延"),
  ]);
  const d = await buildDurativeSummary(g, { llmRunner: okLLM() });
  check("[3] significance=0.5", d?.significance === 0.5, `got=${String(d?.significance)}`);
}

// ── 断言组 4：混 inferred 组 → 不巩固（T1.1 回归确认）──────────
console.log("\n[4] 混 inferred 组 → 不巩固（T1.1 sourceMemories 过滤 inferred，回归确认）");
{
  // 4a：全 inferred（3 条同主题）→ 组不成 / 不巩固，LLM 零调用
  let llmCalls = 0;
  const spyLLM: LLMRunner = { run: async () => { llmCalls++; return JSON.stringify({ content: "x", certainty: "observed" }); } } as never;
  const r4a = await runConsolidation({
    queryL1: async () => [
      mk("i1", "2026-09-01", "用户喜欢本地部署：省成本", { certainty: "inferred" }),
      mk("i2", "2026-09-04", "用户偏好本地部署：安全", { certainty: "inferred" }),
      mk("i3", "2026-09-07", "用户爱用本地部署：低时延", { certainty: "inferred" }),
    ],
    llmRunner: spyLLM,
    config: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20, persist: false },
  });
  check("[4a] 全 inferred 组不巩固（summaries=0）", r4a.summaries.length === 0, `got=${r4a.summaries.length}`);
  check("[4a] LLM 零调用（inferred 在进组前被滤）", llmCalls === 0, `got=${llmCalls}`);

  // 4b：混 inferred（2 observed + 2 inferred 同主题）→ 只按 observed 3 条以下不巩固；
  //     observed 3 条 + inferred 2 条 → 巩固只数 observed（observedCount=3）
  const r4b = await runConsolidation({
    queryL1: async () => [
      mk("o1", "2026-09-01", "用户喜欢本地部署：省成本", { significance: 0.4, subject: "本地部署偏好" }),
      mk("o2", "2026-09-04", "用户偏好本地部署：安全", { significance: 0.8, subject: "本地部署偏好" }),
      mk("o3", "2026-09-07", "用户爱用本地部署：低时延", { significance: 0.6, subject: "本地部署偏好" }),
      mk("i1", "2026-09-05", "用户喜欢本地部署：省成本", { certainty: "inferred", subject: "本地部署偏好" }),
      mk("i2", "2026-09-06", "用户偏好本地部署：安全", { certainty: "inferred", subject: "本地部署偏好" }),
    ],
    llmRunner: okLLM(),
    config: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20, persist: false },
  });
  check("[4b] 混组仍巩固但只基于 observed", r4b.summaries.length === 1, `got=${r4b.summaries.length}`);
  check("[4b] observedCount=3（inferred 不进组）", r4b.summaries[0]?.durative.observedCount === 3, `got=${String(r4b.summaries[0]?.durative.observedCount)}`);
  check("[4b] significance=0.8（observed 真值 max，非恒 0.8 巧合：0.4/0.8/0.6 → 0.8）", r4b.summaries[0]?.durative.significance === 0.8, `got=${String(r4b.summaries[0]?.durative.significance)}`);
}

console.log("\n" + "=".repeat(72));
console.log(`结果: pass=${pass} fail=${fail}`);
console.log("=".repeat(72));
process.exit(fail > 0 ? 1 : 0);
