/**
 * C4 同形验证：summarizer significance 双兜底（策略统一，与 scorer.ts:35-47 同构）。
 *
 * 背景（spec §5 / plan Task C4）：
 *   consolidation-worker 的组内记忆经 lifecycle-scheduler.mapL1RowToRecord（P3-T17.5）
 *   已把 metadata_json 解析并入 metadata —— L1 行的 significance 真值存于 metadata。
 *   summarizer.buildDurativeSummary 旧实现只读顶层 m.significance：顶层缺值的组
 *   （生产常见：行来源无顶层 soul 字段时）退化为半数规则 0.5，丢真值。
 *   修法（渐进叠加，不推翻）：significance 提取改为 顶层 numeric → metadata.significance
 *   → 半数规则 0.5，与 forgetting/scorer.ts significanceOf 双兜底一致。
 *
 * 断言组（验收契约，同形）：
 *   1. RED 对照：组内一条 metadata.significance=0.9（顶层无）→ durative significance=0.9
 *      （修复前：sigs 空 → 半数规则 0.5，FAIL）
 *   2. 顶层优先：顶层 significance=0.7 与 metadata.significance=0.9 并存 → 取顶层 0.7
 *      （P2a 权威字段语义不变）
 *   3. 半数规则不变：组内全部缺值（顶层+metadata 都无）→ 0.5；过半缺值 → 0.5
 *   4. 组内 max 语义不变：两条 metadata.significance 0.3/0.9 → max 0.9
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-c4.ts
 *
 * 纯逻辑验证（mock LLMRunner，不落库、不连任何线上资源）。
 */
import { buildDurativeSummary } from "../src/core/lifecycle/consolidation/summarizer.js";
import type { ConsolidationGroup } from "../src/core/lifecycle/consolidation/grouping.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 构造组内源记忆：顶层 significance 可选，metadata.significance 可选。 */
function mk(id: string, day: string, content: string, opts: { top?: number; metaSig?: number } = {}): MemoryRecord {
  const rec: Record<string, unknown> = {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "s",
    source_message_ids: [],
    metadata: opts.metaSig !== undefined ? { significance: opts.metaSig } : {},
    timestamps: [`${day}T00:00:00Z`],
    createdAt: `${day}T00:00:00Z`,
    updatedAt: `${day}T00:00:00Z`,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-c4",
    certainty: "observed",
  };
  if (opts.top !== undefined) rec.significance = opts.top;
  return rec as unknown as MemoryRecord;
}

function groupOf(memories: MemoryRecord[]): ConsolidationGroup {
  return {
    subject: "验证主题",
    memories,
    earliestTs: memories[0]?.createdAt ?? "2026-09-01T00:00:00Z",
    latestTs: memories[memories.length - 1]?.createdAt ?? "2026-09-07T00:00:00Z",
  } as unknown as ConsolidationGroup;
}

/** mock LLM：只吐固定 content（significance 由 summarizer 自算，不经 LLM）。 */
const llm: LLMRunner = {
  run: async () => JSON.stringify({ content: "（mock 持续态摘要）", certainty: "observed" }),
} as never;

async function sigOf(memories: MemoryRecord[]): Promise<number | null> {
  const rec = await buildDurativeSummary(groupOf(memories), { llmRunner: llm });
  return rec ? rec.significance : null;
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("C4 同形验证：summarizer significance 双兜底（顶层 → metadata → 半数规则 0.5）");
  console.log("=".repeat(72));

  console.log("\n[1] RED 对照：组内一条 metadata.significance=0.9（顶层无）→ durative significance=0.9");
  {
    const s = await sigOf([mk("m_c4_1", "2026-09-01", "用户偏好本地部署：一", { metaSig: 0.9 })]);
    console.log(`  significance = ${s}`);
    check("[1] metadata.significance=0.9 被读取（修复前 0.5）", s === 0.9, `got=${s}`);
  }

  console.log("\n[2] 顶层优先：顶层 0.7 与 metadata 0.9 并存 → 取顶层 0.7（P2a 权威字段语义不变）");
  {
    const s = await sigOf([mk("m_c4_2", "2026-09-01", "用户偏好本地部署：二", { top: 0.7, metaSig: 0.9 })]);
    console.log(`  significance = ${s}`);
    check("[2] 顶层优先于 metadata", s === 0.7, `got=${s}`);
  }

  console.log("\n[3] 半数规则不变：全缺值 → 0.5；过半缺值 → 0.5");
  {
    const sAll = await sigOf([
      mk("m_c4_3a", "2026-09-01", "用户偏好本地部署：三"),
      mk("m_c4_3b", "2026-09-04", "用户偏好本地部署：四"),
    ]);
    check("[3a] 全缺值（顶层+metadata 都无）→ 0.5", sAll === 0.5, `got=${sAll}`);
    // 3 条中 2 条缺值（仅 1 条有）→ 有值数 1 < ceil(3/2)=2 → 半数规则
    const sMaj = await sigOf([
      mk("m_c4_3c", "2026-09-01", "用户偏好本地部署：五", { metaSig: 0.9 }),
      mk("m_c4_3d", "2026-09-04", "用户偏好本地部署：六"),
      mk("m_c4_3e", "2026-09-07", "用户偏好本地部署：七"),
    ]);
    check("[3b] 过半缺值 → 0.5（半数规则语义逐位不变）", sMaj === 0.5, `got=${sMaj}`);
  }

  console.log("\n[4] 组内 max 语义不变：两条 metadata.significance 0.3/0.9 → max 0.9");
  {
    const s = await sigOf([
      mk("m_c4_4a", "2026-09-01", "用户偏好本地部署：八", { metaSig: 0.3 }),
      mk("m_c4_4b", "2026-09-04", "用户偏好本地部署：九", { metaSig: 0.9 }),
    ]);
    check("[4] 取组内 max", s === 0.9, `got=${s}`);
  }

  console.log("");
  console.log("=".repeat(72));
  console.log(`总体：${fail === 0 ? "ALL PASS" : "FAIL"}（${pass} pass, ${fail} fail）`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
