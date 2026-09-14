/**
 * BACKFILL 同形验证：存量记忆 coreRef 回填（甲路线，task-backfill-brief 验收契约）。
 *
 * 被测：scripts/backfill-core-refs.ts 的 runBackfill（可注入 llmRunner 的核心循环）。
 *
 * 断言组（临时库 + mock LLM，全链 RED→GREEN）：
 *   1. 判定→写入→读回：mock 决策带 coreRefs → 防幻觉过滤（C1 parseCoreRefs 复用）
 *      → metadata.coreRefs 落库；同条记录既有 metadata 其他键（recall_count/foo）不被覆盖
 *   2. 空判不写键（宁缺毋滥，C1 同语义）
 *   3. dry-run 默认：判定发生（LLM 被调用、stats.judged>0）但零写库（metadata_json 逐字节不变）
 *   4. 幂等：--write 二次运行 candidates=0、LLM 零调用、零写入
 *   5. 损坏 metadata 不覆盖：metadata_json 损坏行被跳过（loud 计数），字节不动
 *   6. LLM 失败/垃圾输出 → 整批跳过 + loud 统计（skipBatches），批内零写入
 *   7. 无价值锚租户 → 不发 LLM 调用（noAnchorRecords 计数）
 *   8. 分批 30：35 条 → 2 批（30+5），批大小不越界
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-backfill.ts
 *
 * 纯本地验证（临时库 + mock LLM），不连任何线上资源、不碰 D:/tdai-data 生产数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../src/core/store/sqlite.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// BACKFILL 新导出（未实现前动态导入失败 → RED）
const backfillMod: typeof import("./backfill-core-refs.js") = await import("./backfill-core-refs.js");
const runBackfill = backfillMod.runBackfill;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── harness（与 verify-c2 同源）────────────────────────────────────

async function withTempStore(
  label: string,
  fn: (store: VectorStore, dbPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-backfill-${label}-`));
  const dbPath = path.join(tmpDir, "vectors.db");
  const store = new VectorStore(dbPath, 64, console as never);
  await store.init();
  try {
    if (store.isDegraded?.()) {
      check(`[${label}] 前置`, false, "临时库初始化降级（环境问题，非行为断言）");
      return;
    }
    await fn(store, dbPath);
  } finally {
    try { store.close(); } catch { /* Windows 句柄时序 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

const VALUES = [
  { id: "v_correct", label: "正确", weight: 0.6 },
  { id: "v_reliable", label: "可靠", weight: 0.6 },
  { id: "v_risk", label: "风险", weight: 0.5 },
];

function mkRow(id: string, content: string, metadata: Record<string, unknown>, teamId?: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-backfill",
    source_message_ids: [],
    metadata,
    timestamps: [now],
    occurred_at: now,
    certainty: "observed",
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: "k",
    sessionId: "verify-backfill",
    ...(teamId ? { teamId } : {}),
  } as unknown as MemoryRecord;
}

function metaOf(store: VectorStore, id: string): Record<string, unknown> {
  const row = store.getRawDb().prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?").get(id) as { metadata_json?: string } | undefined;
  try { return row?.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {}; } catch { return { __corrupt: row?.metadata_json }; }
}
function rawMetaOf(store: VectorStore, id: string): string | undefined {
  const row = store.getRawDb().prepare("SELECT metadata_json FROM l1_records WHERE record_id = ?").get(id) as { metadata_json?: string } | undefined;
  return row?.metadata_json;
}

/**
 * mock LLM：从 prompt 的「待判断的新记忆」段提取 record_id，按内容标记返回判定。
 *  - 含「部署流程已固化」→ coreRefs ["正确","不存在的价值"]（含幻觉 label，测过滤）
 *  - 含「性能问题复盘」 → coreRefs []（空判）
 *  - 其余 → coreRefs []
 */
function mockBackfillLlm(opts: { throwOnCall?: boolean } = {}): LLMRunner & { calls: () => number; prompts: () => string[] } {
  let n = 0;
  const prompts: string[] = [];
  return {
    run: async (params: { prompt?: string }) => {
      n++;
      const prompt = params.prompt ?? "";
      prompts.push(prompt);
      if (opts.throwOnCall) throw new Error("mock LLM down");
      const ids = [...prompt.matchAll(/"record_id":\s*"([^"]+)"/g)].map((m) => m[1]);
      const decisions = ids.map((id) => {
        void id;
        return {
          record_id: "",
          action: "store",
          target_ids: [],
          coreRefs: [],
        };
      });
      // 按内容标记赋 coreRefs（id 与内容的映射在 prompt 里逐条出现，按顺序解析）
      const blocks = prompt.split(/### 第 \d+ 条新记忆/).slice(1);
      return JSON.stringify(
        blocks.map((b) => {
          const idm = b.match(/"record_id":\s*"([^"]+)"/);
          const id = idm?.[1] ?? "";
          const refs = b.includes("部署流程已固化") ? ["正确", "不存在的价值"] : [];
          return { record_id: id, action: "store", target_ids: [], coreRefs: refs };
        }).concat(decisions.slice(blocks.length)),
      );
    },
    calls: () => n,
    prompts: () => prompts,
  } as never;
}

function seed(store: VectorStore, ...rows: MemoryRecord[]): void {
  for (const r of rows) store.upsertL1(r, undefined);
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("BACKFILL 同形验证：存量 coreRef 回填（复用 C1 判定 / 幻觉过滤 / 幂等 / dry-run 默认）");
  console.log("=".repeat(72));

  // ── 断言组 1+2：判定→写入→读回 + 合并不覆盖 + 空判不写 ─────────────
  console.log("\n[1] 写入链：mock 决策 → 防幻觉过滤 → metadata.coreRefs 落库 + 合并不覆盖其他键");
  {
    await withTempStore("write", async (store) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      seed(store,
        mkRow("m_hit", "部署流程已固化到脚本，回滚需人工确认", { recall_count: 3, foo: "bar" }),
        mkRow("m_empty", "性能问题复盘会议纪要", {}),
      );
      const llm = mockBackfillLlm();
      const stats = await runBackfill({ dbPath: ":memory-x-unused", store, write: true, llmRunner: llm });

      const hit = metaOf(store, "m_hit");
      check("1a 判定→写入：coreRefs 落库 === ['正确']（幻觉被滤）",
        JSON.stringify(hit.coreRefs) === JSON.stringify(["正确"]), `coreRefs=${JSON.stringify(hit.coreRefs)}`);
      check("1b 合并不覆盖：recall_count 保留", hit.recall_count === 3, `recall_count=${String(hit.recall_count)}`);
      check("1c 合并不覆盖：foo 保留", hit.foo === "bar", `foo=${String(hit.foo)}`);
      const empty = metaOf(store, "m_empty");
      check("1d 空判不写键：m_empty 无 coreRefs（宁缺毋滥）", !("coreRefs" in empty), `meta=${JSON.stringify(empty)}`);
      check("1e stats：judged=1 emptyJudge=1", stats.judged === 1 && stats.emptyJudge === 1,
        `judged=${stats.judged} emptyJudge=${stats.emptyJudge}`);
      check("1f stats：written=1", stats.written === 1, `written=${stats.written}`);
      check("1g C1 prompt 复用：LLM 收到价值锚候选清单", llm.prompts().some((p) => p.includes("价值锚候选清单")));
    });
  }

  // ── 断言组 3：dry-run 默认零写库 ──────────────────────────────────
  console.log("\n[3] dry-run 默认：判定发生但零写库（metadata_json 逐字节不变）");
  {
    await withTempStore("dryrun", async (store, dbPath) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      seed(store, mkRow("m_dry", "部署流程已固化到脚本，回滚需人工确认", {}));
      const before = rawMetaOf(store, "m_dry");
      const llm = mockBackfillLlm();
      const stats = await runBackfill({ dbPath, store, write: false, llmRunner: llm });
      check("3a 判定发生：LLM 被调用", llm.calls() >= 1, `calls=${llm.calls()}`);
      check("3b 判定发生：judged=1", stats.judged === 1, `judged=${stats.judged}`);
      check("3c 零写库：written=0", stats.written === 0, `written=${stats.written}`);
      check("3d 零写库：metadata_json 字节不变", rawMetaOf(store, "m_dry") === before,
        `before=${JSON.stringify(before)} after=${JSON.stringify(rawMetaOf(store, "m_dry"))}`);
      check("3e dry-run 样本输出：samples 含首条判定", stats.samples.length >= 1 &&
        stats.samples[0].recordId === "m_dry" && JSON.stringify(stats.samples[0].refs) === JSON.stringify(["正确"]),
        `samples=${JSON.stringify(stats.samples)}`);
    });
  }

  // ── 断言组 4：幂等（二次运行零处理）────────────────────────────────
  console.log("\n[4] 幂等：--write 二次运行 candidates=0 / LLM 零调用 / 零写入");
  {
    await withTempStore("idempotent", async (store, dbPath) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      seed(store, mkRow("m_idem", "部署流程已固化到脚本，回滚需人工确认", {}));
      const llm = mockBackfillLlm();
      const r1 = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      const callsAfter1 = llm.calls();
      const r2 = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      check("4a 首轮 written=1", r1.written === 1, `written=${r1.written}`);
      check("4b 二轮 candidates=0", r2.candidates === 0, `candidates=${r2.candidates}`);
      check("4c 二轮 LLM 零调用", llm.calls() === callsAfter1, `calls=${llm.calls()} (after r1=${callsAfter1})`);
      check("4d 二轮 written=0", r2.written === 0, `written=${r2.written}`);
      check("4e 二轮后 coreRefs 仍在且唯一", JSON.stringify(metaOf(store, "m_idem").coreRefs) === JSON.stringify(["正确"]));
    });
  }

  // ── 断言组 5：损坏 metadata 不覆盖 ─────────────────────────────────
  console.log("\n[5] 损坏 metadata：跳过（loud 计数），metadata_json 字节不动");
  {
    await withTempStore("corrupt", async (store, dbPath) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      seed(store, mkRow("m_bad", "部署流程已固化到脚本，回滚需人工确认", {}));
      store.getRawDb().prepare("UPDATE l1_records SET metadata_json = ? WHERE record_id = ?").run("{{{corrupt", "m_bad");
      const before = rawMetaOf(store, "m_bad");
      const llm = mockBackfillLlm();
      const stats = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      check("5a 损坏行不进候选：candidates=0", stats.candidates === 0, `candidates=${stats.candidates}`);
      check("5b 损坏行 loud 计数：skipCorrupt=1", stats.skipCorrupt === 1, `skipCorrupt=${stats.skipCorrupt}`);
      check("5c 损坏行字节不动", rawMetaOf(store, "m_bad") === before);
      check("5d 损坏行不发 LLM", llm.calls() === 0, `calls=${llm.calls()}`);
    });
  }

  // ── 断言组 6：LLM 失败 → 整批跳过 + loud ───────────────────────────
  console.log("\n[6] LLM 失败：整批跳过（skipBatches），批内零写入，进程不崩");
  {
    await withTempStore("llmfail", async (store, dbPath) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      seed(store, mkRow("m_fail", "部署流程已固化到脚本，回滚需人工确认", {}));
      const before = rawMetaOf(store, "m_fail");
      const llm = mockBackfillLlm({ throwOnCall: true });
      const stats = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      check("6a skipBatches=1", stats.skipBatches === 1, `skipBatches=${stats.skipBatches}`);
      check("6b 批内零写入", stats.written === 0 && rawMetaOf(store, "m_fail") === before);
      check("6c 候选仍在（可重试）", stats.candidates === 1, `candidates=${stats.candidates}`);
    });
  }

  // ── 断言组 7：无价值锚租户 → 不发 LLM ──────────────────────────────
  console.log("\n[7] 无价值锚：整租户跳过（noAnchorRecords），LLM 零调用");
  {
    await withTempStore("noanchor", async (store, dbPath) => {
      seed(store, mkRow("m_na", "部署流程已固化到脚本，回滚需人工确认", {}));
      const llm = mockBackfillLlm();
      const stats = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      check("7a LLM 零调用", llm.calls() === 0, `calls=${llm.calls()}`);
      check("7b noAnchorRecords=1", stats.noAnchorRecords === 1, `noAnchor=${stats.noAnchorRecords}`);
      check("7c 零写入", stats.written === 0 && !("coreRefs" in metaOf(store, "m_na")));
    });
  }

  // ── 断言组 8：分批 30 ─────────────────────────────────────────────
  console.log("\n[8] 分批：35 条 → 2 批（30+5），批大小不越界");
  {
    await withTempStore("batch", async (store, dbPath) => {
      for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
      const rows: MemoryRecord[] = [];
      for (let i = 0; i < 35; i++) rows.push(mkRow(`m_b${i}`, `部署流程已固化到脚本 批量条目 ${i}`, {}));
      seed(store, ...rows);
      const llm = mockBackfillLlm();
      const stats = await runBackfill({ dbPath, store, write: true, llmRunner: llm });
      check("8a 批数=2", stats.batches === 2, `batches=${stats.batches}`);
      check("8b 首批 ≤30 条", (llm.prompts()[0]?.match(/"record_id":/g) ?? []).length === 30,
        `first batch ids=${(llm.prompts()[0]?.match(/"record_id":/g) ?? []).length}`);
      check("8c 次批 5 条", (llm.prompts()[1]?.match(/"record_id":/g) ?? []).length === 5,
        `second batch ids=${(llm.prompts()[1]?.match(/"record_id":/g) ?? []).length}`);
      check("8d 全部判定 judged=35", stats.judged === 35, `judged=${stats.judged}`);
      check("8e 全部落库 written=35", stats.written === 35, `written=${stats.written}`);
    });
  }

  console.log("=".repeat(72));
  console.log(`结果：pass=${pass} fail=${fail}`);
  console.log("=".repeat(72));
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`verify-backfill 未捕获异常: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
