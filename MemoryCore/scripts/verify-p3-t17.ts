/**
 * P3-T17 同形验证：subjectOf 语义化（H1，拍板④：llm 顺带标注）。
 *
 * 背景：
 *   grouping.ts 的 subjectOf 是字面量前缀匹配（首个"：/:"/" — "前 ≤24 字符）——
 *   LLM 自由文本前缀完全一致概率≈0 → minCount≥3 结构性难触发（生产 H 巩固零输出根因）。
 *   修复（渐进叠加，不推翻）：
 *     T17-A：dedup LLM 顺带抽 subject（零额外 LLM 成本）→ 决策带 subject →
 *            extractor 写入前 attach 到源记忆 metadata.subject（归组键）；
 *     T17-B：grouping 策略门 subjectOfLlm + groupBySubject(strategy: "llm"|"lexical"，默认 llm)
 *            —— llm = subjectOfLlm(m) ?? subjectOf(m)（存量无 subject 仍词法兜底）。
 *
 * 断言组（验收契约，同形）：
 *   1. llm 模式归组：三条同义不同前缀（metadata.subject 全="本地部署偏好"）+ 跨期≥1d
 *      → strategy=llm 归入同组（修复前 lexical 0 组——先跑 RED 对照，断言组内含词法对照）
 *   2. 词法兜底：无 metadata.subject 的记忆 → 词法前缀归组行为不变（存量兼容）
 *   3. lexical 模式：显式 strategy=lexical → 即使有 metadata.subject 也走词法（策略门真实生效）
 *   4. 端到端：mock LLMRunner 返回带 subject 的 dedup 决策 → 真实 extractL1Memories 链路
 *      → 源记忆 metadata.subject 落库 → 真实 runConsolidation → 持续态产出且
 *      metadata.subject 幂等键正常（F4 不回归：二次巩固同 id 版本递增，不增殖）
 *
 * 命名决策（登记）：源记忆的 metadata.subject = 归组键（dedup LLM 抽的语义主题）；
 * durative 的 metadata.subject = 幂等键（existingDurativeOf 读的是 scene_name=consolidated
 * 的 work_fact 行）。同名不同行，消费方互不冲突——沿用 subject 名因为语义就是主题。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p3-t17.ts
 *
 * 只用自建临时库（hashEmbed + 真实 VectorStore 64 维，参照 verify-p1-t9），
 * 不连任何线上资源、不碰生产库；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { groupBySubject } from "../src/core/lifecycle/consolidation/grouping.js";
import { runConsolidation } from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 确定性 embedding（参照 verify-p1-t9）。 */
function hashEmbed(text: string, dims = 64): Float32Array {
  const vec = new Float32Array(dims);
  const tokens = [...(text.matchAll(/.{1,2}/g) ?? [])].map((m) => m[0]);
  for (const tk of tokens) {
    const h = parseInt(createHash("md5").update(tk).digest("hex").slice(0, 8), 16);
    vec[h % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

const embedding: EmbeddingService = {
  embed: async (t: string) => hashEmbed(t),
  embedBatch: async (ts: string[]) => ts.map((t) => hashEmbed(t)),
} as never;

const CFG = { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20 };

/** 构造纯逻辑 fixture：时间拉开跨期≥1d，metadata 可选带 subject。 */
function mk(id: string, day: string, content: string, metadata: Record<string, unknown> = {}): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "s",
    source_message_ids: [],
    metadata,
    timestamps: [`${day}T00:00:00Z`],
    createdAt: `${day}T00:00:00Z`,
    updatedAt: `${day}T00:00:00Z`,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p3-t17",
    certainty: "observed",
  } as unknown as MemoryRecord;
}

console.log("=".repeat(72));
console.log("P3-T17 同形验证：subjectOf 语义化（T17-A dedup 顺带抽取 / T17-B 策略门）");
console.log("=".repeat(72));

// ── 断言组 1：llm 模式归组（含词法 RED 对照）────────────────────
console.log("\n[1] llm 模式归组：三条同义不同前缀 + metadata.subject 全同 → 同组（修复前词法 0 组）");
{
  // 三条内容前缀互不相同（词法 subjectOf 必然拆成 3 个键），
  // 但 dedup LLM 顺带抽取的语义 subject 全 = "本地部署偏好"。
  const mems = [
    mk("m_llm_1", "2026-09-01", "用户喜欢本地部署：省成本可控数据", { subject: "本地部署偏好" }),
    mk("m_llm_2", "2026-09-04", "用户偏好本地部署：私有化安全诉求", { subject: "本地部署偏好" }),
    mk("m_llm_3", "2026-09-07", "用户爱用本地部署：推理时延更低", { subject: "本地部署偏好" }),
  ];
  const lexical = groupBySubject(mems, CFG, undefined, "lexical");
  console.log(`  词法对照（strategy=lexical）：${mems.length} 条不同前缀 → ${lexical.length} 组`);
  check("[1] RED 对照：词法模式 0 组（前缀互异，结构性难触发）", lexical.length === 0);
  const llm = groupBySubject(mems, CFG, undefined, "llm");
  console.log(`  llm 模式（strategy=llm）→ ${llm.length} 组`);
  check("[1] llm 模式归入 1 组", llm.length === 1);
  check("[1] 组 subject = LLM 语义主题", llm.length === 1 && llm[0].subject === "本地部署偏好", llm.length === 1 ? `subject="${llm[0].subject}"` : "");
  check("[1] 组内 3 条且按时间升序", llm.length === 1 && llm[0].memories.length === 3 && llm[0].memories[0].id === "m_llm_1");
}

// ── 断言组 2：词法兜底（存量兼容）───────────────────────────────
console.log("\n[2] 词法兜底：无 metadata.subject 的记忆 → llm 模式仍按词法前缀归组（行为不变）");
{
  const mems = [
    mk("m_lex_1", "2026-09-01", "用户偏好本地部署：原因一"),
    mk("m_lex_2", "2026-09-04", "用户偏好本地部署：原因二"),
    mk("m_lex_3", "2026-09-07", "用户偏好本地部署：原因三"),
  ];
  const groups = groupBySubject(mems, CFG, undefined, "llm");
  console.log(`  llm 模式（无 subject，走词法兜底）→ ${groups.length} 组`);
  check("[2] 归入 1 组（subjectOf 兜底生效）", groups.length === 1);
  check("[2] 组 subject = 词法前缀", groups.length === 1 && groups[0].subject === "用户偏好本地部署", groups.length === 1 ? `subject="${groups[0].subject}"` : "");
}

// ── 断言组 3：lexical 模式策略门真实生效 ────────────────────────
console.log("\n[3] lexical 模式：显式 strategy=lexical → 即使有 metadata.subject 也走词法");
{
  const mems = [
    mk("m_gate_1", "2026-09-01", "用户喜欢本地部署：一", { subject: "本地部署偏好" }),
    mk("m_gate_2", "2026-09-04", "用户偏好本地部署：二", { subject: "本地部署偏好" }),
    mk("m_gate_3", "2026-09-07", "用户爱用本地部署：三", { subject: "本地部署偏好" }),
  ];
  const groups = groupBySubject(mems, CFG, undefined, "lexical");
  console.log(`  strategy=lexical（有 subject 也不用）→ ${groups.length} 组`);
  check("[3] 0 组（策略门生效，metadata.subject 被忽略）", groups.length === 0);
}

// ── 断言组 4：端到端（dedup 带 subject → 真实链路 → 持续态幂等）──
console.log("\n[4] 端到端：mock dedup 决策带 subject → extractL1Memories 落库 → runConsolidation 持续态（F4 幂等）");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p3-t17-e2e-"));
  let ok = true;
  try {
    const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
    await store.init();
    if (store.isDegraded?.()) {
      check("[4] 前置", false, "临时库初始化降级（环境问题，非行为断言）");
      ok = false;
    } else {
      // 预置 1 条旧记忆（带向量）→ dedup 候选召回非空 → LLM 判定被真实调用
      const now = new Date().toISOString();
      store.upsertL1({
        id: "old-e2e-seed", content: "团队记忆巩固方案设计评审通过", type: "episodic", priority: 60,
        scene_name: "verify-p3-t17", source_message_ids: [], metadata: {}, timestamps: [now],
        occurred_at: now, certainty: "observed", createdAt: now, updatedAt: now, version: 1,
        sessionKey: "k", sessionId: "sid-old",
      } as unknown as MemoryRecord, hashEmbed("团队记忆巩固方案设计评审通过"));

      const extractionMemories = [
        { content: "用户喜欢本地部署：省成本可控数据", type: "episodic", priority: 70, source_message_ids: [1],
          occurred_at: "2026-09-01T00:00:00Z", certainty: "observed", source: "extraction", valence: 0, arousal: 0, significance: 0.5 },
        { content: "用户偏好本地部署：私有化安全诉求", type: "episodic", priority: 70, source_message_ids: [1],
          occurred_at: "2026-09-04T00:00:00Z", certainty: "observed", source: "extraction", valence: 0, arousal: 0, significance: 0.5 },
        { content: "用户爱用本地部署：推理时延更低", type: "episodic", priority: 70, source_message_ids: [1],
          occurred_at: "2026-09-07T00:00:00Z", certainty: "observed", source: "extraction", valence: 0, arousal: 0, significance: 0.5 },
      ];

      // mock LLM：call1 = L1 提取（soul 字段齐全 → 跳过 enrich）；call2 = dedup 判定——
      // 从 prompt 里解析本批 record_id，逐条返回带 subject 的 store 决策（模拟 LLM 遵循新 schema）。
      let call = 0;
      let dedupSubjectSeen = false;
      const llmRunner: LLMRunner = {
        run: async (params: { prompt?: string }) => {
          call++;
          if (call === 1) {
            return JSON.stringify([{ scene_name: "对话情境", message_ids: [1], memories: extractionMemories }]);
          }
          const prompt = params.prompt ?? "";
          const ids = [...prompt.matchAll(/"record_id"\s*:\s*"(m_[0-9a-z_]+)"/g)].map((m) => m[1]);
          dedupSubjectSeen = ids.length > 0;
          return JSON.stringify(ids.map((record_id) => ({
            record_id, action: "store", target_ids: [], subject: "本地部署偏好",
          })));
        },
      } as never;

      const result = await extractL1Memories({
        messages: [{ role: "user", content: "记录一下这周关于本地部署偏好的几次讨论", timestamp: Date.now() } as never],
        sessionKey: "k-t17", sessionId: "sid-t17", baseDir: path.join(tmpDir, "base"),
        config: {},
        options: {
          enableDedup: true, enableMemoryLinks: true, maxMemoriesPerSession: 10,
          vectorStore: store, embeddingService: embedding, llmRunner,
        },
        logger: console as never,
      });

      check("[4] dedup LLM 判定被调用（候选召回非空）", dedupSubjectSeen);
      check("[4] 提取成功 3 条", result.storedCount === 3, `stored=${result.storedCount}`);
      const withSubject = result.records.filter((r) => (r.metadata as Record<string, unknown> | undefined)?.subject === "本地部署偏好");
      check("[4] 源记忆 metadata.subject 全部落库（T17-A attach 生效）", result.records.length === 3 && withSubject.length === 3, `withSubject=${withSubject.length}`);

      // 模拟跨日捕获：把 3 条源记忆的 timestamps 重写为各自的 occurred_at（生产里会话
      // 跨天自然拉开 timestamp_start；本测试同秒完成抽取，需显式拉开以过 minSpanDays=1）。
      // metadata.subject 原样保留（落库事实已由上一断言钉死）。
      for (const rec of result.records) {
        const day = rec.occurred_at || rec.createdAt;
        store.upsertL1({ ...rec, timestamps: [day], createdAt: day, updatedAt: day }, undefined);
      }

      // 真实 worker 链路：复刻 lifecycle-scheduler 的行映射（参照 verify-p0-t1）
      const queryL1 = async (): Promise<MemoryRecord[]> => {
        const rows = store.queryL1Records() as unknown as Array<Record<string, unknown>>;
        return rows.map((r) => ({
          ...r,
          timestamps: [((r.timestamp_start as string) ?? (r.timestamp_str as string) ?? "")].filter(Boolean),
          metadata: {
            ...((r.metadata as Record<string, unknown>) ?? {}),
            activity_start_time: (r.timestamp_start as string) ?? "",
            occurred_at: (r.occurred_at as string) ?? "",
          },
        })) as unknown as MemoryRecord[];
      };
      const summarizeLlm = {
        run: async () => JSON.stringify({ content: "（mock 持续态摘要）用户持续偏好本地部署。", certainty: "observed" }),
      };
      const consCfg = { ...CFG, persist: true, subjectStrategy: "llm" as const };
      const res1 = await runConsolidation({
        queryL1, llmRunner: summarizeLlm as never, config: consCfg, store,
        logger: { info: () => {}, warn: (m: string) => console.log(`  [worker:warn] ${m}`), debug: () => {} } as never,
      });
      console.log(`  runConsolidation#1: groups=${res1.groupsFound} summaries=${res1.summaries.length} persisted=${res1.persisted}`);
      check("[4] llm 策略归出 1 组", res1.groupsFound === 1);
      check("[4] 持续态产出并持久化", res1.summaries.length === 1 && res1.persisted === 1);
      check("[4] 持续态 subject = 语义主题", res1.summaries.length === 1 && res1.summaries[0].subject === "本地部署偏好");

      const duratives = () => (store.queryL1Records() as unknown as Array<Record<string, unknown>>)
        .filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
      const after1 = duratives();
      const meta1 = after1.length === 1 ? (JSON.parse((after1[0].metadata_json as string) ?? "{}") as Record<string, unknown>) : {};
      check("[4] 库中恰 1 条持续态", after1.length === 1);
      check("[4] 持续态 metadata.subject 幂等键正常", meta1.subject === "本地部署偏好", `subject=${String(meta1.subject)}`);
      const evidence = (meta1.evidence_ids as string[] | undefined) ?? [];
      check("[4] 证据链含 3 条源记忆", evidence.length === 3, `evidence=${evidence.length}`);

      // F4 幂等回归：同一 subject 二次巩固 → 复用同 id 版本递增，不增殖
      const res2 = await runConsolidation({
        queryL1, llmRunner: summarizeLlm as never, config: consCfg, store,
        logger: { info: () => {}, warn: () => {}, debug: () => {} } as never,
      });
      const after2 = duratives();
      console.log(`  runConsolidation#2: groups=${res2.groupsFound} persisted=${res2.persisted} durativeRows=${after2.length}`);
      check("[4] 二次巩固仍恰 1 条持续态（不增殖）", after2.length === 1);
      // F-1 修正（P3-T17.5）：L1RecordRow 无 id 字段——旧断言 after2[0].id === after1[0].id
      // 恒为 undefined === undefined（无区分力）；改用 record_id 才真正钉死 F4 幂等复用。
      check("[4] 复用同 id + 版本递增（F4 幂等键）",
        after2.length === 1 && after1.length === 1 &&
        after2[0].record_id === after1[0].record_id && (after2[0].version as number) === (after1[0].version as number) + 1,
        after2.length === 1 && after1.length === 1 ? `id=${String(after1[0].record_id)} v${String(after1[0].version)}→v${String(after2[0].version)}` : "");
      store.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
  if (!ok) fail++;
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
console.log(`总体：${fail === 0 ? "ALL PASS" : "FAIL"}（${pass} pass, ${fail} fail）`);
process.exit(fail === 0 ? 0 : 1);
