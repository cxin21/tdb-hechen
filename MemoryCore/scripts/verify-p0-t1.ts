/**
 * P0-T1 同形验证：H 侧洗白门 —— sourceMemories 必须接 isObservable
 * （inferred 源记忆不再被熬成 certainty="observed" 的持续态）。
 *
 * 两部分证据：
 *   [A] 纯逻辑基准：2 条 observed + 1 条 inferred 同前缀 → isObservable 过滤 → groupBySubject
 *       断言组不触发；附「不过滤」对照组（应触发 1 组），钉死过滤是必要条件。
 *   [B] 真实 worker 链路：临时 sqlite 库（VectorStore dimensions=0 metadata/FTS-only 模式）
 *       + 真实 store.queryL1Records()（复刻 lifecycle-scheduler 的行映射）
 *       → runConsolidation（真实 grouping/worker 代码）+ mock LLMRunner + 真实 upsertL1 持久化。
 *       断言：inferred 不进组、不出现在 LLM prompt 输入、不产出 observed 持续态。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p0-t1.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runConsolidation } from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import { groupBySubject, isObservable } from "../src/core/lifecycle/consolidation/grouping.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { VectorStore } from "../src/core/store/sqlite.js";

// ── 共享 fixture（import 生产类型定义；生产加字段此处编译报错）──
// 注意：groupBySubject 同时要求跨期 minSpanDays≥1 —— fixture 的 occurred 时间必须拉开，
// 否则组根本不触发（脚本自身验证不了洗白门，与 worker 无关）。
const mk = (id: string, day: string, content: string, certainty: string): MemoryRecord =>
  ({
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [day], // occurredTs 的第一优先来源；拉开天数以跨过 minSpanDays
    createdAt: day,
    updatedAt: day,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p0-t1",
    certainty,
  }) as MemoryRecord;

// 构造：2 条 observed + 1 条 inferred，同前缀（subjectOf 取"："前命中同组），
// 时间跨度 2026-09-01 → 2026-09-07（跨过 minSpanDays=1），
// 且 inferred 记忆时间最新——若被洗白，持续态 valid_end 会由它定义。
const group = [
  mk("m_obs_1", "2026-09-01T00:00:00Z", "用户偏好本地部署：原因一", "observed"),
  mk("m_obs_2", "2026-09-04T00:00:00Z", "用户偏好本地部署：原因二", "observed"),
  mk("m_inf_1", "2026-09-07T00:00:00Z", "用户偏好本地部署：推断其一", "inferred"), // 若不过滤，凑满 3 条会触发巩固
];

// ── [A] 纯逻辑基准 ──────────────────────────────────────────────
console.log("=".repeat(72));
console.log("[A] 纯逻辑基准：groupBySubject × isObservable 过滤");
console.log("=".repeat(72));

const unfiltered = groupBySubject(group);
console.log(
  `未过滤对照：${group.length} 条同前缀 → ${unfiltered.length} 个组（预期 1：inferred 凑数即触发巩固）`,
);

const sources = group.filter(isObservable);
const groups = groupBySubject(sources);
console.log(`isObservable 过滤后：${sources.length} 条（inferred 被排除）→ ${groups.length} 个组`);

const aPass = unfiltered.length === 1 && groups.length === 0 && sources.length === 2;
console.log(
  aPass
    ? "[A] PASS: inferred 被排除，组未触发（未过滤对照组确认过滤必要）"
    : "[A] FAIL: 断言不符",
);

// ── [B] 真实 worker 链路 ────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
console.log(
  "[B] 真实 worker 链路：临时 sqlite 库 + queryL1Records → runConsolidation（真实 grouping/worker 代码）+ mock LLMRunner",
);
console.log("=".repeat(72));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p0-t1-"));
const dbPath = path.join(tmpDir, "vectors.db");
let bPass = false;
let exitCode = 1;
try {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) {
    console.log(`[B] FAIL: 临时库初始化降级（环境问题，非行为断言）：${initRes.reason}`);
  } else {
    for (const m of group) store.upsertL1(m, undefined);
    console.log(
      `临时库：${dbPath}（dimensions=0 metadata/FTS-only 模式），已写入 ${group.length} 条源记忆`,
    );

    const llmPrompts: string[] = [];
    const llmRunner = {
      run: async (params: { prompt?: string; systemPrompt?: string }) => {
        llmPrompts.push(`${params.systemPrompt ?? ""}\n${params.prompt ?? ""}`);
        return JSON.stringify({
          content: "（mock 持续态摘要）用户持续偏好本地部署。",
          certainty: "observed",
        });
      },
    };

    // 复刻 lifecycle-scheduler 的真实查询路径：store.queryL1Records() → 行映射（补 timestamps/metadata）
    const queryL1 = async () => {
      const rows = store.queryL1Records();
      return rows.map((r) => ({
        ...(r as object),
        timestamps: [
          (r as { timestamp_start?: string }).timestamp_start ??
            (r as { timestamp_str?: string }).timestamp_str ??
            "",
        ].filter(Boolean),
        metadata: {
          ...((r as { metadata?: object }).metadata ?? {}),
          activity_start_time: (r as { timestamp_start?: string }).timestamp_start ?? "",
          occurred_at: (r as { occurred_at?: string }).occurred_at ?? "",
        },
      })) as unknown as MemoryRecord[];
    };

    const res = await runConsolidation({
      queryL1,
      llmRunner: llmRunner as never,
      config: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20 },
      store, // 真实持久化：洗白链条最后一步（inferred 证据被熬成 observed 持续态落库）也要被验证
      logger: {
        info: (m: string) => console.log(`  [worker] ${m}`),
        warn: (m: string) => console.log(`  [worker:warn] ${m}`),
        debug: () => {},
      } as never,
    });

    // 查回 DB：是否有持续态行（type=work_fact && scene_name=consolidated）
    const after = store
      .queryL1Records()
      .filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
    const promptHit = llmPrompts.some((p) => p.includes("推断其一"));
    const inferredId = "m_inf_1";
    const evidenceHasInferred = after.some((r) => {
      try {
        const meta = JSON.parse(r.metadata_json ?? "{}") as { evidence_ids?: string[] };
        return (meta.evidence_ids ?? []).includes(inferredId);
      } catch {
        return false;
      }
    });

    console.log(
      `runConsolidation 结果：groupsFound=${res.groupsFound}, summaries=${res.summaries.length}, persisted=${res.persisted}`,
    );
    console.log(`LLM 调用次数=${llmPrompts.length}，prompt 输入含 inferred 内容=${promptHit}`);
    console.log(
      `DB 中持续态行=${after.length}${evidenceHasInferred ? "（evidence_ids 含 inferred 记忆——洗白实证）" : ""}`,
    );

    // PASS 判据（目标行为）：inferred 不进组、不触发 LLM、不产持续态
    bPass =
      res.groupsFound === 0 &&
      res.summaries.length === 0 &&
      res.persisted === 0 &&
      llmPrompts.length === 0 &&
      after.length === 0;
    if (bPass) {
      console.log(
        "[B] PASS: inferred 未进组、未出现在 LLM prompt 输入、未产出 observed 持续态 —— 洗白门已堵",
      );
    } else {
      console.log(
        "[B] FAIL: inferred 被放行进组" +
          (promptHit ? "并出现在 LLM prompt 输入" : "") +
          (after.length > 0 ? "，且已被熬成 observed 持续态（洗白实证）" : ""),
      );
    }
    store.close();
  }
  exitCode = aPass && bPass ? 0 : 1;
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
  }
}

console.log("");
console.log(
  `总体：${exitCode === 0 ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}）`,
);
process.exit(exitCode);
