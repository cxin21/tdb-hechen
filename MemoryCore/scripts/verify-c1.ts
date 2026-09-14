/**
 * C1 同形验证：coreRef 全链（写入 → 排序 → 展示 → 遗忘）。
 *
 * 背景（spec §2 / plan Task C1）：
 *   价值信号全链流动——写入时标注（dedup LLM 顺带判定 coreRefs，防幻觉过滤）、
 *   召回时被看见（executeMemorySearch 排序 tiebreak + formatSearchResponse 尾注）、
 *   遗忘时受保护（salienceBoost 优先读 coreRefs，子串匹配降为兜底）。
 *   检索层冻结：向量/FTS 打分、绝对门槛、rrfMerge 语义零改动——coreRefBoost
 *   只加在 executeMemorySearch 排序 tiebreak 处（score + priority*1e-6 同位置）。
 *
 * 断言组（验收契约，同形）：
 *   1. 写入端到端：临时库 + 真实价值锚（upsertValue）+ mock LLM（dedup 决策带
 *      coreRefs ["正确","不存在的价值"]）→ 真实 extractL1Memories →
 *      metadata.coreRefs 落库 === ["正确"]（幻觉 id 被过滤，P-D）；
 *      且 dedup prompt 注入了价值锚候选清单
 *   2. 排序加成：executeMemorySearch 内部取租户价值锚（listValues）→ query 命中
 *      价值 ∧ 记忆 metadata.coreRefs 含该价值 → 排序翻到第 1；coreRefBoost=0 时
 *      回到原位（加成是排序位次差异的唯一来源——两行内容相同、cosine/RRF 分相同）；
 *      score 字段本身零改动（检索层冻结）；门槛冻结：低相关记忆带 coreRefs 仍被
 *      绝对门槛滤除（tiebreak 不越过门槛）
 *   3. 展示尾注：touched_core_refs（coreRefs ∩ 本轮 appraisal 命中）非空 →
 *      片段行出现 `·触[正确]`；无交集 → 不出现（宁缺毋滥：不是所有 coreRefs 都显示）
 *   4. 遗忘 salience：metadata.coreRefs 命中 fired 价值 → boost>0（content 不含
 *      子串也命中——coreRefs 优先）；无 coreRefs → 子串匹配兜底（行为不变）；
 *      coreRefs 与 fired 无交集 → 0
 *   5. config：memory.recall.coreRefBoost 解析（默认 0.05；0=关；负值 clamp 0）
 *   6. 回归（审查 #1）：firedLabels 为空（无价值锚=生产最常见路径）时排序仍无条件
 *      执行——同分不同 priority → priority 高者靠前（基线 priority*1e-6 tieback 不丢）
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-c1.ts
 *
 * 只用自建临时库（hashEmbed + 真实 VectorStore 64 维，参照 verify-p3-t17），
 * 不连任何线上资源、不碰生产库；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { executeMemorySearch, formatSearchResponse } from "../src/core/tools/memory-search.js";
import type { MemorySearchResult } from "../src/core/tools/memory-search.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { parseConfig } from "../src/config.js";
import { salienceBoost } from "../src/core/lifecycle/feeling/appraisal.js";

// C1 新增导出（未实现前动态导入失败 → RED）
const appraisalMod: typeof import("../src/core/lifecycle/feeling/appraisal.js") = await import(
  "../src/core/lifecycle/feeling/appraisal.js"
);
const salienceBoostWithRefs = (appraisalMod as { salienceBoostWithRefs?: typeof salienceBoost }).salienceBoostWithRefs;

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

const VALUES = [
  { id: "v_correct", label: "正确", weight: 0.6 },
  { id: "v_reliable", label: "可靠", weight: 0.6 },
  { id: "v_risk", label: "风险", weight: 0.5 },
];

function mkRow(id: string, content: string, metadata: Record<string, unknown>): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-c1",
    source_message_ids: [],
    metadata,
    timestamps: [now],
    occurred_at: now,
    certainty: "observed",
    createdAt: now,
    updatedAt: now,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-c1",
  } as unknown as MemoryRecord;
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("C1 同形验证：coreRef 全链（写入 → 排序 → 展示 → 遗忘）");
  console.log("=".repeat(72));

  // ── 断言组 1：写入端到端（dedup 顺带判定 + 防幻觉过滤 + 落库）──
  console.log("\n[1] 写入端到端：mock dedup 决策带 coreRefs → 防幻觉过滤 → metadata.coreRefs 落库");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-c1-write-"));
    try {
      const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
      await store.init();
      if (store.isDegraded?.()) {
        check("[1] 前置", false, "临时库初始化降级（环境问题，非行为断言）");
      } else {
        // 真实价值锚（default 租户桶——与测试调用不带 teamId/userId/agentId 对齐）
        for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);

        // 预置 1 条旧记忆 → dedup 候选召回非空 → LLM 判定被真实调用
        const now = new Date().toISOString();
        store.upsertL1({
          id: "old-c1-seed", content: "本地部署方案的技术评审记录", type: "episodic", priority: 60,
          scene_name: "verify-c1", source_message_ids: [], metadata: {}, timestamps: [now],
          occurred_at: now, certainty: "observed", createdAt: now, updatedAt: now, version: 1,
          sessionKey: "k", sessionId: "sid-old",
        } as unknown as MemoryRecord, hashEmbed("本地部署方案的技术评审记录"));

        const extractionMemories = [
          { content: "用户强调本地部署方案必须正确可靠", type: "episodic", priority: 70, source_message_ids: [1],
            occurred_at: "2026-09-10T00:00:00Z", certainty: "observed", source: "extraction", valence: 0, arousal: 0, significance: 0.5 },
        ];

        let dedupPrompt = "";
        let sawValueCandidates = false;
        const llmRunner: LLMRunner = {
          run: async (params: { prompt?: string }) => {
            const prompt = params.prompt ?? "";
            if (prompt.includes("统一候选记忆池") || prompt.includes("价值锚")) {
              if (!dedupPrompt) {
                dedupPrompt = prompt;
                sawValueCandidates = prompt.includes("正确") && prompt.includes("价值锚");
              }
              const ids = [...prompt.matchAll(/"record_id"\s*:\s*"(m_[0-9a-z_]+)"/g)].map((m) => m[1]);
              if (ids.length > 0) {
                return JSON.stringify(ids.map((record_id) => ({
                  record_id, action: "store", target_ids: [],
                  subject: "本地部署偏好",
                  coreRefs: ["正确", "不存在的价值"],
                })));
              }
            }
            return JSON.stringify([{ scene_name: "对话情境", message_ids: [1], memories: extractionMemories }]);
          },
        } as never;

        const result = await extractL1Memories({
          messages: [{ role: "user", content: "记录一下本地部署方案的讨论", timestamp: Date.now() } as never],
          sessionKey: "k-c1", sessionId: "sid-c1", baseDir: path.join(tmpDir, "base"),
          config: {},
          options: {
            enableDedup: true, enableMemoryLinks: false, maxMemoriesPerSession: 10,
            vectorStore: store, embeddingService: embedding, llmRunner,
          },
          logger: console as never,
        });

        check("[1a] dedup prompt 注入价值锚候选清单", sawValueCandidates);
        check("[1b] 提取成功 1 条", result.storedCount === 1, `stored=${result.storedCount}`);
        const meta = (result.records[0]?.metadata ?? {}) as Record<string, unknown>;
        const refs = meta.coreRefs;
        check("[1c] metadata.coreRefs 落库 === ['正确']（幻觉被过滤）",
          Array.isArray(refs) && refs.length === 1 && refs[0] === "正确",
          `coreRefs=${JSON.stringify(refs)}`);
        check("[1d] subject 同款顺风车不回归", meta.subject === "本地部署偏好", `subject=${String(meta.subject)}`);

        // 落库事实钉死：从 store 读回 metadata_json
        const rows = store.queryL1Records() as unknown as Array<{ record_id: string; metadata_json: string; content: string }>;
        const written = rows.find((r) => r.content.includes("正确可靠"));
        const writtenMeta = (() => { try { return JSON.parse(written?.metadata_json ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
        check("[1e] 库行 metadata_json.coreRefs === ['正确']",
          Array.isArray(writtenMeta.coreRefs) && writtenMeta.coreRefs.length === 1 && writtenMeta.coreRefs[0] === "正确",
          `metadata_json.coreRefs=${JSON.stringify(writtenMeta.coreRefs)}`);
      }
      store.close();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
    }
  }

  // ── 断言组 2：排序加成（咽喉 tiebreak，检索层冻结）──
  console.log("\n[2] 排序加成：coreRef 命中翻位（boost=0 回原位）；score 字段零改动；绝对门槛不越过");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-c1-rank-"));
    try {
      const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
      await store.init();
      if (store.isDegraded?.()) {
        check("[2] 前置", false, "临时库初始化降级（环境问题，非行为断言）");
      } else {
        for (const v of VALUES) store.upsertValue(v.id, v.label, v.weight);
        const same = "本地部署方案必须正确可靠";
        // 先插无 coreRef 行（决定 boost=0 时的基线位次：同分稳定序 = 插入序）
        store.upsertL1(mkRow("m_plain", same, {}), hashEmbed(same));
        store.upsertL1(mkRow("m_ref", same, { coreRefs: ["正确"] }), hashEmbed(same));
        // 低相关行带 coreRefs：验证绝对门槛不被 tiebreak 越过
        store.upsertL1(mkRow("m_far", "zz qq xx 完全不同的内容", { coreRefs: ["正确"] }), hashEmbed("zz qq xx 完全不同的内容"));

        const query = "本地部署方案要正确";
        // FIX3 测试层隔离（零生产行为变化；语义来源见 task-fix3-report.md）：
        //  - queryExpansion.enabled=false —— ②V2-2（869e868）查询扩展在本单测退出
        //    （扩展断言归 verify-v2-qe 专测，brief 推荐的"隔离无关变量"做法）；
        //  - rerankWeights 全 0 —— 组合分精排（4ce97ea 引入、RV2-2 重设计为相关度主导
        //    四因子；本脚本直调 executeMemorySearch 不带 config → 缺省权重 0.7/0.15/0.1/0.05）
        //    关断恒等（生产注释明示"全 0 = 关断恒等"）。其 coreRefCount 因子与 coreRefBoost
        //    无关，不关断会混淆 [2a]/[2c] 的 boost on/off 对照（C1 契约：加成是位次差异唯一来源）；
        //  - limit 10→4 —— R5 价值反查补池触发口径 mainCount*2 < limit（2*2=4 → 退出）：
        //    m_far 的向量分实测 0.1581（< 门槛 0.3，本就被向量门槛滤除），原先经 R5 以
        //    score=0 + [value:正确] 通道回池再被组合分翻到第 1（brief"0.3 边界"前提失实，
        //    实证见报告）。关断后 [2d] 回到"绝对门槛冻结"的本义。
        const isolate = {
          queryExpansion: { enabled: false },
          rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 },
        } as const;
        const boosted = await executeMemorySearch({
          query, limit: 4, ...isolate,
          vectorStore: store, embeddingService: embedding, logger: console as never,
        });
        const idsOn = boosted.results.map((r) => r.id);
        console.log(`  boost 默认位次：${idsOn.join(", ")}`);
        check("[2a] coreRef 命中行排第 1", idsOn[0] === "m_ref", `first=${idsOn[0]}`);
        check("[2b] score 字段本身零改动（平分仍平分）",
          boosted.results.filter((r) => r.id !== "m_far").every((r) => r.score === boosted.results[0].score));

        const off = await executeMemorySearch({
          query, limit: 4, coreRefBoost: 0, ...isolate,
          vectorStore: store, embeddingService: embedding, logger: console as never,
        });
        const idsOff = off.results.map((r) => r.id);
        console.log(`  boost=0 位次：${idsOff.join(", ")}`);
        check("[2c] coreRefBoost=0 → 加成关闭回原位（基线序=插入序）", idsOff[0] === "m_plain", `first=${idsOff[0]}`);

        check("[2d] 绝对门槛冻结：低相关行带 coreRefs 仍被滤除（rankKey 不越过门槛）",
          !idsOn.includes("m_far"), `results=${idsOn.join(", ")}`);

        // 展示标注（经真实 executeMemorySearch 链路）：touched_core_refs 只含本轮 fired
        const first = boosted.results.find((r) => r.id === "m_ref");
        const touches = (first as { touched_core_refs?: string[] } | undefined)?.touched_core_refs;
        check("[2e] 结果项带 touched_core_refs=['正确']（coreRefs ∩ fired）",
          Array.isArray(touches) && touches.length === 1 && touches[0] === "正确",
          `touched=${JSON.stringify(touches)}`);
      }
      store.close();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
    }
  }

  // ── 断言组 3：展示尾注（宁缺毋滥：只显示本轮相关的 coreRefs）──
  console.log("\n[3] 展示尾注：·触[正确] 出现；无交集不出现");
  {
    const mkResult = (touched?: string[]): MemorySearchResult => ({
      results: [
        {
          id: "m_x", content: "内容甲", type: "episodic", priority: 70, scene_name: "s",
          score: 0.8, version: 0, created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
          ...(touched ? { touched_core_refs: touched } : {}),
        } as never,
      ],
      total: 1,
      strategy: "embedding",
    });
    const withTouch = formatSearchResponse(mkResult(["正确"]));
    check("[3a] 有交集 → 尾注 ·触[正确]", withTouch.includes("·触[正确]"));
    const withoutTouch = formatSearchResponse(mkResult(undefined));
    check("[3b] 无标注 → 不出现尾注", !withoutTouch.includes("·触["));
  }

  // ── 断言组 4：遗忘 salience（coreRefs 优先，子串兜底）──
  console.log("\n[4] 遗忘 salience：coreRefs 命中优先；缺失时子串兜底；无交集 0");
  {
    const values = VALUES.map((v) => ({ id: v.id, label: v.label, weight: v.weight }));
    const cfg = { enabled: true, firedThreshold: 0.4 };
    // coreRefs 优先：content 不含"正确"子串，但 metadata.coreRefs 命中 fired 价值 → boost>0
    const refOnly = salienceBoostWithRefs?.(
      { content: "部署流程已固化到脚本", metadata: { coreRefs: ["正确"] } } as never,
      values, cfg,
    );
    check("[4a] coreRefs 命中（content 无子串）→ boost>0", typeof refOnly === "number" && refOnly > 0, `boost=${refOnly}`);
    // 兜底：无 coreRefs → 与旧 salienceBoost 同值（行为逐位不变）
    const content = "性能问题 需要优化";
    const vals = [{ id: "v_p", label: "性能", weight: 0.8 }];
    const fallback = salienceBoostWithRefs?.({ content, metadata: {} } as never, vals, cfg);
    const legacy = salienceBoost(content, vals, cfg);
    check("[4b] 无 coreRefs → 子串匹配兜底（与 salienceBoost 同值）", fallback === legacy, `fallback=${fallback}, legacy=${legacy}`);
    // 无交集：coreRefs 存在但与 fired 无交集 → 0（coreRefs 在场时不走子串）
    const noInter = salienceBoostWithRefs?.(
      { content: "部署流程已固化到脚本 性能问题", metadata: { coreRefs: ["风险"] } } as never,
      [{ id: "v_p", label: "性能", weight: 0.8 }], cfg,
    );
    check("[4c] coreRefs 在场但无交集 → 0（不走子串兜底）", noInter === 0, `boost=${noInter}`);
    if (refOnly === undefined || fallback === undefined || noInter === undefined) {
      check("[4*] salienceBoostWithRefs 已导出", false, "导出缺失（RED）");
    }
  }

  // ── 断言组 5：config 解析 ──
  console.log("\n[5] config：memory.recall.coreRefBoost 解析（默认 0.05；0=关；负值 clamp 0）");
  {
    const dflt = parseConfig({}).recall.coreRefBoost;
    check("[5a] 默认 0.05", dflt === 0.05, `got=${dflt}`);
    const custom = parseConfig({ recall: { coreRefBoost: 0.1 } }).recall.coreRefBoost;
    check("[5b] 显式配置生效", custom === 0.1, `got=${custom}`);
    const off = parseConfig({ recall: { coreRefBoost: 0 } }).recall.coreRefBoost;
    check("[5c] 0=关闭", off === 0, `got=${off}`);
    const neg = parseConfig({ recall: { coreRefBoost: -1 } }).recall.coreRefBoost;
    check("[5d] 负值 clamp 0", neg === 0, `got=${neg}`);
  }

  // ── 断言组 6：回归（审查 #1）——firedLabels 为空时 priority tieback 不丢 ──
  console.log("\n[6] 回归（审查 #1）：无价值锚（firedLabels=[]）→ 排序仍无条件执行，同分按 priority 靠前");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-c1-fix1-"));
    try {
      const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
      await store.init();
      if (store.isDegraded?.()) {
        check("[6] 前置", false, "临时库初始化降级（环境问题，非行为断言）");
      } else {
        // 不 upsertValue：租户无价值锚 → firedLabels=[]（早退分支触发路径）
        const same = "优先级排序回归验证内容";
        // 插入序：50 在前、90 在后（早退时返回插入序 → 50 靠前 = FAIL）
        store.upsertL1(({ ...mkRow("m_p50", same, {}), priority: 50 }) as unknown as MemoryRecord, hashEmbed(same));
        store.upsertL1(({ ...mkRow("m_p90", same, {}), priority: 90 }) as unknown as MemoryRecord, hashEmbed(same));

        const res = await executeMemorySearch({
          query: "优先级排序回归验证内容", limit: 10, vectorStore: store, embeddingService: embedding, logger: console as never,
        });
        const ids = res.results.map((r) => r.id);
        console.log(`  firedLabels=[] 位次：${ids.join(", ")}`);
        check("[6a] 同分不同 priority（90/50）+ 无价值命中（firedLabels=[]）→ priority 90 靠前",
          ids[0] === "m_p90", `first=${ids[0]}`);
        check("[6b] score 字段本身零改动（平分仍平分）",
          res.results.length === 2 && res.results[0].score === res.results[1].score);
      }
      store.close();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
    }
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
