/**
 * verify-rv2：召回修正批 RV2 验收（brief 裁决三任务）。
 *
 * [A] 精排组合分纯函数单元（RV2-2）：relevance 主导（≥70% 契约）/ relevanceNorm 池内 max
 *     归一（两类候选同尺度）/ coreRefHit 0/1 口径 / 权重可配 / 全 0 关断恒等 /
 *     relevance=0 退化纯时间·显著排序（预期行为变更，登记）/ 纯相关度权重 = 分数序（关断矩阵）。
 * [B] 图候选的 relevance 派生（真链路，memory-mock store）：PPR 图候选以派生分
 *     maxHitScore×graphDiscount×pprNorm 入池（E2.1：派生分即相关度折扣分），relevance-only
 *     权重下恒排在直击命中之后（同尺度 + 折扣语义）；默认权重下结构因子不得翻越相关度差。
 * [C] 绝对门槛不越（真向量路）：精排只重排门槛后候选——低于 scoreThreshold 的候选带
 *     coreRefs/权重在场也绝不回池。
 * [D] yaml grep 断言（RV2-1）：结构权重全部 ≤0.001（÷170 校准，无 0.03/0.05 残留）/
 *     graphDiscount 0.15 已在位 / rerankWeights 四键新默认。
 * [E] config 解析：rerankWeights 新四键缺省 + clamp。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-rv2.ts
 *
 * 只用自建临时数据与只读 yaml，不连任何线上资源；不碰 D:/tdai-data/ 生产进程。
 */
import fs from "node:fs";

import {
  applyCompositeRerank,
  compositeScoreOf,
  DEFAULT_COMPOSITE_WEIGHTS,
  executeMemorySearch,
  type CompositeFactors,
} from "../src/core/tools/memory-search.js";
import { parseConfig } from "../src/config.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../src/core/store/types.js";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

const NOW = new Date("2026-09-11T00:00:00Z");

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] 精排组合分纯函数单元（RV2-2 相关度主导）");
console.log("=".repeat(72));
{
  // A1 relevance 主导：满额结构因子（timeProx=1 + sig=1 + coreRef=1）合计 0.3 < 满额相关度 0.7
  const maxStruct = compositeScoreOf(
    { relevance: 0, occurredAt: NOW.toISOString(), significance: 1, coreRefCount: 1, isWorkFact: false },
    DEFAULT_COMPOSITE_WEIGHTS, NOW, 1,
  );
  const fullRel = compositeScoreOf(
    { relevance: 1, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false },
    DEFAULT_COMPOSITE_WEIGHTS, NOW, 1,
  );
  check("A1 relevance 主导契约：结构因子满额 0.3 < 相关度满额 0.7（≥70%）",
    Math.abs(maxStruct - 0.3) < 1e-12 && Math.abs(fullRel - 0.7) < 1e-12,
    `struct=${maxStruct} rel=${fullRel}`);

  // A2 relevanceNorm = f.relevance / 池内 maxRelevance（两类候选同尺度归一口径）
  const half = compositeScoreOf({ relevance: 0.25, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false }, DEFAULT_COMPOSITE_WEIGHTS, NOW, 0.5);
  check("A2 relevanceNorm 池内 max 归一：0.25/max0.5 → 0.7×0.5=0.35",
    Math.abs(half - 0.35) < 1e-12, `score=${half}`);

  // A3 coreRefHit 0/1 口径（brief 公式）：命中数 3 仍是 0.05，不按计数放大
  const core3 = compositeScoreOf({ relevance: 0, occurredAt: null, significance: 0, coreRefCount: 3, isWorkFact: false }, DEFAULT_COMPOSITE_WEIGHTS, NOW, 1);
  check("A3 coreRefHit 0/1：coreRefCount=3 → 0.05（二值，非计数归一）",
    Math.abs(core3 - 0.05) < 1e-12, `score=${core3}`);

  // A4 权重可配：自定义权重（timeProx 主导）翻转 relevance 序
  const items: Array<{ id: string; f: CompositeFactors }> = [
    { id: "hi", f: { relevance: 1, occurredAt: null, significance: 0, coreRefCount: 0, isWorkFact: false } },
    { id: "lo", f: { relevance: 0.4, occurredAt: NOW.toISOString(), significance: 0, coreRefCount: 0, isWorkFact: false } },
  ];
  const relFirst = applyCompositeRerank(items, (it) => it.f, DEFAULT_COMPOSITE_WEIGHTS, NOW);
  const timeFirst = applyCompositeRerank(items, (it) => it.f, { relevance: 0, timeProx: 1, significance: 0, coreRef: 0 }, NOW);
  check("A4 权重可配：默认权重 hi 先；timeProx 主导权重 lo 先",
    relFirst.map((r) => r.id).join(",") === "hi,lo" && timeFirst.map((r) => r.id).join(",") === "lo,hi",
    `default=[${relFirst.map((r) => r.id)}] custom=[${timeFirst.map((r) => r.id)}]`);

  // A5 全 0 关断恒等 + relevance=0 预期行为变更
  const stable = applyCompositeRerank(items, (it) => it.f, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 }, NOW);
  check("A5 全 0 权重 = 稳定排序逐位基线（关断恒等）", stable.map((r) => r.id).join(",") === "hi,lo");
  const noRel = applyCompositeRerank(items, (it) => it.f, { relevance: 0, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }, NOW);
  check("A5b relevance=0 → 退化纯时间/显著排序（预期行为变更登记，不再是基线恒等）",
    noRel.map((r) => r.id).join(",") === "lo,hi", `[${noRel.map((r) => r.id)}]`);

  // A6 关断矩阵：relevance 之外因子全 0 → 纯相关度排序 = 分数降序（基线序，归一单调）
  const pool = [0.9, 0.5, 0.3, 0.1].map((score, i) => ({ id: `r${i}`, f: { relevance: score, occurredAt: null, significance: i === 2 ? 0.99 : 0, coreRefCount: 0, isWorkFact: false } as CompositeFactors }));
  const relOnly = applyCompositeRerank(pool, (it) => it.f, { relevance: 0.7, timeProx: 0, significance: 0, coreRef: 0 }, NOW);
  check("A6 纯相关度权重序 = relevance 分数降序（0.99 显著因子在场也不越）",
    relOnly.map((r) => r.id).join(",") === "r0,r1,r2,r3", `[${relOnly.map((r) => r.id)}]`);
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] 图候选的 relevance 派生（PPR 派生分 = 相关度折扣分，真链路）");
console.log("=".repeat(72));
{
  const KW = "RV2CHK";
  const ftsRow = (id: string, over: Partial<L1FtsResult> = {}): L1FtsResult => ({
    record_id: id, content: `${KW} 记忆条目 ${id}`, type: "episodic", priority: 0, scene_name: "",
    score: 0.5, timestamp_str: "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: JSON.stringify({ recall_count: 10 }), ...over,
  });
  const vecRow = (id: string, over: Partial<L1SearchResult> = {}): L1SearchResult => ({
    record_id: id, content: `${KW} 邻居条目 ${id}`, type: "episodic", priority: 0, scene_name: "",
    score: 0, timestamp_str: "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "{}", ...over,
  });
  const run = async (rows: L1FtsResult[], params: Record<string, unknown> = {}) =>
    (await executeMemorySearch({
      query: KW, limit: 10,
      vectorStore: {
        isFtsAvailable: () => true,
        getCapabilities: () => ({ nativeHybridSearch: false }),
        searchL1Fts: async () => rows,
        getNeighbors: () => [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
        getL1ByIdsWithArchive: (ids: string[]) => [vecRow("n1")].filter((r) => ids.includes(r.record_id)),
        bumpRecallCount: () => true,
      } as unknown as IMemoryStore,
      exploreSlot: false,
      ...params,
    } as Parameters<typeof executeMemorySearch>[0])).results;

  // B1 relevance-only 权重：图候选（派生分 = 0.9×0.15×pprNorm ≤ 0.135）恒在直击命中之后
  const relOnly = await run(
    [ftsRow("a", { score: 0.9 }), ftsRow("b", { score: 0.5 }), ftsRow("c", { score: 0.3 })],
    { graphDiscount: 0.15, graphMinStrength: 0.5, rerankWeights: { relevance: 0.7, timeProx: 0, significance: 0, coreRef: 0 } },
  );
  check("B1 图候选以派生相关度分入池：relevance-only 权重下排全部直击命中之后（折扣语义保持）",
    relOnly.map((r) => r.id).join(",") === "a,b,c,n1" && relOnly[3]!.recall_channel === "graph:ppr:causal",
    `[${relOnly.map((r) => `${r.id}(${r.recall_channel ?? "hit"})`)}]`);

  // B2 默认权重：b 的满额结构因子（时近 0.15 + 显著 0.1）不得翻越 a-b 相关度差
  //   a: relNorm=1.0 → 0.7；b: relNorm=0.5/0.9? 归一 max=0.9 → 0.389 + 0.15 + 0.1×0.9 ≈ 0.579 < 0.7
  const defW = await run(
    [ftsRow("a", { score: 0.9 }), ftsRow("b", { score: 0.5, significance: 0.9, occurred_at: NOW.toISOString() })],
    { graphDiscount: 0, rerankWeights: DEFAULT_COMPOSITE_WEIGHTS },
  );
  check("B2 默认权重下 relevance 主因子裁决位次（结构因子 ≤30% 不翻越相关度差）",
    defW.map((r) => r.id).join(",") === "a,b", `[${defW.map((r) => r.id)}]`);
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] 绝对门槛不越（精排只重排门槛后候选）");
console.log("=".repeat(72));
{
  const KW = "RV2GATE";
  const vecRow = (id: string, score: number): L1SearchResult => ({
    record_id: id, content: `${KW} ${id}`, type: "episodic", priority: 0, scene_name: "",
    score, timestamp_str: "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: JSON.stringify({ coreRefs: ["正确"], significance: 0.99, occurred_at: NOW.toISOString() }),
  });
  const res = await executeMemorySearch({
    query: `${KW} 正确`, limit: 10,
    vectorStore: {
      isFtsAvailable: () => false,
      getCapabilities: () => ({ nativeHybridSearch: false }),
      searchL1Vector: async () => [vecRow("v_hi", 0.9), vecRow("v_lo", 0.1)],
      bumpRecallCount: () => true,
    } as unknown as IMemoryStore,
    embeddingService: { embed: async () => new Float32Array([1, 0, 0, 0]) } as never,
    // 门槛后精排开到最重结构偏袒 + coreRef 加成在场：v_lo（0.1 < 门槛 0.3）也不得回池
    coreRefBoost: 0.05,
    rerankWeights: { relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 },
  } as Parameters<typeof executeMemorySearch>[0]);
  const ids = res.results.map((r) => r.id);
  check("C 绝对门槛冻结：0.1 分候选（带 coreRefs/高显著/时近）被门槛滤除，精排不越门槛",
    ids.join(",") === "v_hi", `ids=[${ids.join(", ")}]`);
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] yaml grep 断言（RV2-1 权重重校准）");
console.log("=".repeat(72));
{
  const yamlText = fs.readFileSync(new URL("../tdai-gateway.yaml", import.meta.url), "utf8");
  const structKeys = ["timeBoost", "recencyBoost", "sigWeight", "reinforcementWeight", "moodBoost", "coreRefBoost", "sceneBoost"];
  const residuals: string[] = [];
  for (const k of structKeys) {
    const m = new RegExp(`^\\s*${k}:\\s*([0-9.]+)`, "m").exec(yamlText);
    if (!m) { residuals.push(`${k}=MISSING`); continue; }
    const v = parseFloat(m[1]!);
    if (!(v > 0 && v <= 0.001)) residuals.push(`${k}=${v}`);
  }
  check("D1 结构权重全部 ≤0.001（÷170 回 tiebreak 本位，无 0.03/0.05 量级残留）",
    residuals.length === 0, residuals.join(", ") || "全部 ≤0.001");
  const gd = /^\s*graphDiscount:\s*([0-9.]+)/m.exec(yamlText);
  check("D2 graphDiscount=0.15 已在位（上一轮修正保持）",
    gd !== null && parseFloat(gd[1]!) === 0.15, `graphDiscount=${gd?.[1]}`);
  const rw = /^\s*relevance:\s*([0-9.]+)\s*\n\s*timeProx:\s*([0-9.]+)\s*\n\s*significance:\s*([0-9.]+)\s*\n\s*coreRef:\s*([0-9.]+)/m.exec(yamlText);
  check("D3 rerankWeights 四键新默认 0.7/0.15/0.1/0.05（相关度主导精排启用）",
    rw !== null && rw[1] === "0.7" && rw[2] === "0.15" && rw[3] === "0.1" && rw[4] === "0.05",
    rw ? `relevance=${rw[1]} timeProx=${rw[2]} significance=${rw[3]} coreRef=${rw[4]}` : "未匹配");
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[E] config 解析：rerankWeights 新四键");
console.log("=".repeat(72));
{
  const def = parseConfig({}).recall.rerankWeights;
  check("E1 缺省 = 0.7/0.15/0.1/0.05",
    JSON.stringify(def) === JSON.stringify({ relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }),
    JSON.stringify(def));
  const clamped = parseConfig({ recall: { rerankWeights: { relevance: -1, timeProx: 0.2, significance: 0.3, coreRef: 0 } } }).recall.rerankWeights;
  check("E2 负值 clamp 0 / 正值原样 / 0 可设（关断矩阵延续）",
    clamped.relevance === 0 && clamped.timeProx === 0.2 && clamped.significance === 0.3 && clamped.coreRef === 0,
    JSON.stringify(clamped));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
