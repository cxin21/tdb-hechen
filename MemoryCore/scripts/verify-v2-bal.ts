/**
 * verify-v2-bal：召回 v2 引擎三 注意力平衡 + R-v2.1 精排轻档验收（DS-RECALL-V2-THREE-ENGINES-001 §E3）。
 *
 * [A] 共享纯函数单元（两排序点单一源）：isStructuralChannel/applyCompositeRerank（三因子/
 *     分层不越层/关断恒等）/applyExploreSlot（末位替换/中位数/窗口含合格候选不动/池不超窗退化）。
 * [B] 工具路真链路（临时 sqlite 库）：探索位（PPR 候选占末席 + [explore] 标注）/
 *     exploreSlot=false 关断/组合分精排三因子（significance/occurred_at/coreRefs）/全 0 关断。
 * [C] auto-recall 路（searchHybrid）：同层对齐（探索位 + 精排同断言）。
 * [D] 结论层放宽（E3.2，真库 + performAutoRecall）：分析型判定边界（有标记/无标记/长度）/
 *     significance top-5 durative 结论浮出（无需命中）/searchL1ByType 缺失通道退出/
 *     conclusionRelaxedForAnalytical=false 关断。
 * [E] config 解析：exploreSlot/conclusionRelaxedForAnalytical/rerankWeights 默认与 clamp。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-v2-bal.ts
 *
 * 只用自建临时数据，不连任何线上资源；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyCompositeRerank,
  applyExploreSlot,
  isStructuralChannel,
  DEFAULT_COMPOSITE_WEIGHTS,
} from "../src/core/tools/memory-search.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { isAnalyticalQuery, performAutoRecall, searchHybrid } from "../src/core/hooks/auto-recall.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { IMemoryStore, L1SearchResult } from "../src/core/store/types.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import { ZERO_RANK_SIGNALS } from "../src/core/tools/recall-signals.js";

const KW = "V2BAL";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] 共享纯函数单元（两排序点单一源）");
console.log("=".repeat(72));
{
  check("A1 isStructuralChannel：graph:/value:/scene: 前缀；主检索缺省否",
    isStructuralChannel("graph:ppr:causal") && isStructuralChannel("value:锚") && isStructuralChannel("scene:s") &&
    !isStructuralChannel(undefined) && !isStructuralChannel("explore"));

  const now = new Date("2026-09-11T00:00:00Z");
  const items = [
    { id: "a", f: { relevance: 0.5, occurredAt: "2026-09-10T00:00:00Z", significance: 0.1, coreRefCount: 0, isWorkFact: false } },
    { id: "b", f: { relevance: 0.3, occurredAt: "2026-09-10T00:00:00Z", significance: 0.1, coreRefCount: 3, isWorkFact: false } },
    { id: "wf", f: { relevance: 0.1, occurredAt: "2026-09-10T00:00:00Z", significance: 0.2, coreRefCount: 0, isWorkFact: true } },
  ];
  const reranked = applyCompositeRerank(items, (it) => it.f, DEFAULT_COMPOSITE_WEIGHTS, now);
  // RV2-2：relevance 主因子（a relNorm=1.0 → 0.7）压过 b 的 coreRef 命中（0.6×0.7+0.05=0.47）
  check("A2 精排：相关度主导组合分降序 + work_fact 分层恒在前",
    JSON.stringify(reranked.map((r) => r.id)) === JSON.stringify(["wf", "a", "b"]),
    JSON.stringify(reranked.map((r) => r.id)));
  const noRel = applyCompositeRerank(items, (it) => it.f, { relevance: 0, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }, now);
  check("A2b relevance=0 → 退化纯时间/显著排序（预期行为变更登记，brief RV2-2）",
    JSON.stringify(noRel.map((r) => r.id)) === JSON.stringify(["wf", "b", "a"]),
    JSON.stringify(noRel.map((r) => r.id)));
  const stable = applyCompositeRerank(items, (it) => it.f, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 }, now);
  // I1 裁定（V2 批 2）："全 0 = 基线逐位"恒等声明限定为权重信号；work_fact 分层是
  // R-A1 之前的既有展示层不变式，不属 v2 权重信号——全 0 时分层仍生效（wf 恒在前，
  // 即使其组合分因子最弱），登记而非改行为。
  check("A3 全 0 权重 = 权重信号关断恒等（work_fact 分层保留——既有展示层不变式，不属 v2 关断范围）",
    JSON.stringify(stable.map((r) => r.id)) === JSON.stringify(["wf", "a", "b"]));
  check("A4 权重默认相关度主导 0.7/0.15/0.1/0.05（RV2-2 契约：relevance ≥70%、结构合计 ≤30%）",
    JSON.stringify(DEFAULT_COMPOSITE_WEIGHTS) === JSON.stringify({ relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }));

  const pool = [
    { id: "a", channel: undefined, rc: 10 },
    { id: "b", channel: undefined, rc: 10 },
    { id: "c", channel: undefined, rc: 10 },
    { id: "n", channel: "graph:ppr:causal", rc: 0 },
  ];
  const replaced = applyExploreSlot(pool, 3, (p) => ({ channel: p.channel, recallCount: p.rc }), (p) => ({ ...p, marked: true }));
  check("A5 探索位：末位替换为最低 recall_count 结构命中 + 标注",
    replaced.map((p) => p.id).join(",") === "a,b,n" && (replaced[2] as { marked?: boolean }).marked === true);
  const intact = applyExploreSlot(pool.slice(0, 3), 3, (p) => ({ channel: p.channel, recallCount: p.rc }), (p) => p);
  check("A6 池不超窗 → 原排序退化", intact.map((p) => p.id).join(",") === "a,b,c");
  const pool2 = [
    { id: "a", channel: "value:v", rc: 0 },
    { id: "b", channel: undefined, rc: 10 },
    { id: "c", channel: undefined, rc: 10 },
    { id: "n", channel: "graph:ppr:causal", rc: 1 },
  ];
  const untouched = applyExploreSlot(pool2, 3, (p) => ({ channel: p.channel, recallCount: p.rc }), (p) => p);
  check("A7 窗口内已有合格低频结构命中 → 不动（E3.1 触发条件不成立）",
    untouched.map((p) => p.id).join(",") === "a,b,c,n");

  // E3.2 分析型判定边界
  check("A8 分析型：有标记且 >8 字",
    isAnalyticalQuery("怎么提高召回的全面性和准确性") && isAnalyticalQuery("请评估当前系统的整体状况") &&
    isAnalyticalQuery("对比两个方案的差异"));
  check("A9 非分析：无标记 / 有标记但 ≤8 字 / 空串",
    !isAnalyticalQuery("123456789") && !isAnalyticalQuery("怎么召回") && !isAnalyticalQuery(""));
}

// ══════════════════════════════════════════════════════════
const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 验证条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-v2-bal",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-11T00:00:00Z"],
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-v2-bal",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-bal-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

const ALL_OFF = {
  coreRefBoost: 0, timeBoost: 0, recencyBoost: 0, sigWeight: 0, inferredPenalty: 0,
  reinforcementWeight: 0, moodBoost: 0, graphDiscount: 0, sceneBoost: 0,
} as const;

async function toolSearch(store: VectorStore, params: Record<string, unknown> = {}) {
  return executeMemorySearch({
    query: KW, limit: 10, vectorStore: store, ...ALL_OFF, ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
}

console.log("");
console.log("=".repeat(72));
console.log("[B] 工具路真链路（临时 sqlite 库，每场景 fresh）");
console.log("=".repeat(72));
{
  // 探索位：5 条主命中（recall_count=10）+ 1 个 PPR 图候选（recall_count=0）→ 末席替换
  const { store, dir } = makeStore([
    ...["a", "b", "c", "d", "e"].map((id) => mk(id, { content: `${KW} 主条目 ${id}`, metadata: { recall_count: 10 } })),
    mk("n1", { content: "图邻居条目（不含关键词）" }),
  ]);
  try {
    store.addLink("a", "n1", "causal", 0.9);
    const res = await toolSearch(store, { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 3 });
    check("B1 探索位：低频结构命中占末席 + graph:ppr:causal:explore 标注",
      res.results.map((r) => r.id).join(",") === "a,b,n1" && res.results[2]?.recall_channel === "graph:ppr:causal:explore",
      `ids=[${res.results.map((r) => r.id).join(", ")}], ch=${res.results[2]?.recall_channel}`);

    const off = await toolSearch(store, { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 3, exploreSlot: false });
    check("B2 exploreSlot=false → 通道退出（原排序逐位）",
      off.results.map((r) => r.id).join(",") === "a,b,c",
      `ids=[${off.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }

  // 精排三因子（真库）：b significance 0.9 → 前移；关断 → 基线
  const s2 = makeStore([
    mk("a", { content: `${KW} 平淡条目`, metadata: { recall_count: 5 } }),
    mk("b", { content: `${KW} 高显著条目`, significance: 0.9 }),
  ]);
  try {
    const on = await toolSearch(s2.store, { rerankWeights: { relevance: 0, timeProx: 0, significance: 1, coreRef: 0 } });
    check("B3 精排 significance 因子：高显著前移", on.results.map((r) => r.id).join(",") === "b,a",
      `ids=[${on.results.map((r) => r.id).join(", ")}]`);
    const off = await toolSearch(s2.store, { rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 } });
    check("B4 全 0 权重 → 关断恒等（BM25 基线序）", off.results.map((r) => r.id).join(",") === "a,b",
      `ids=[${off.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { s2.store.close(); fs.rmSync(s2.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] auto-recall 路（searchHybrid）：同层对齐");
console.log("=".repeat(72));
{
  const vecHit = (id: string, over: Partial<L1SearchResult> = {}): L1SearchResult => ({
    record_id: id, content: `${KW} 记忆条目 ${id}`, type: "episodic", priority: 0, scene_name: "",
    score: 0.5, timestamp_str: "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "", ...over,
  });
  const vectorStore = {
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Vector: async () => ["a", "b", "c", "d", "e"].map((id) => vecHit(id, { metadata_json: JSON.stringify({ recall_count: 10 }) })),
    getNeighbors: () => [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
    getL1ByIdsWithArchive: (ids: string[]) => ids.map((id) => vecHit(id, { score: 0 })),
  } as unknown as IMemoryStore;
  const emb = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  const rank = {
    boost: 0, firedLabels: [] as string[], moodSign: 0, timeWindow: null,
    signals: ZERO_RANK_SIGNALS, now: new Date(), graph: { minStrength: 0.5, discount: 0.6 },
  };
  const on = await searchHybrid(`${KW} 探索位探针`, "", 3, 0.3, vectorStore, emb, undefined, undefined, rank, 0, undefined, undefined, true);
  check("C1 auto-recall 同层探索位：n1 占末席 + [graph:ppr:causal:explore] 标注",
    on.lines.length === 3 && on.lines[2]?.includes("条目 n1") && on.lines[2]?.includes("graph:ppr:causal:explore"),
    `lines=${JSON.stringify(on.lines)}`);
  const off = await searchHybrid(`${KW} 探索位探针`, "", 3, 0.3, vectorStore, emb, undefined, undefined, rank, 0, undefined, undefined, false);
  check("C2 auto-recall exploreSlot=false → 退出（与工具路同参数语义）",
    off.lines.length === 3 && !off.lines[2]?.includes("explore"));
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] 结论层放宽（E3.2，真库 + performAutoRecall 真链路）");
console.log("=".repeat(72));
{
  const WF_ROWS = [
    mk("wf-a", { type: "work_fact", content: "红牌诊断结论条目甲", significance: 0.9 }),
    mk("wf-b", { type: "work_fact", content: "利用率矩阵结论条目乙", significance: 0.7 }),
    mk("wf-c", { type: "work_fact", content: "全面性基线结论条目丙", significance: 0.1 }),
    mk("anchor", { content: `${KW} 锚点：召回质量问题记录` }),
  ];
  const ANALYTICAL_Q = "请帮我分析一下当前的召回质量改进方向";

  const recall = async (store: VectorStore, userText: string, sessionKey: string, cfgOverrides: Record<string, unknown> = {}, withTypeMethod = true) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-bal-profile-"));
    try {
      return await performAutoRecall({
        userText, actorId: "verify", sessionKey,
        cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 5, ...cfgOverrides } }),
        pluginDataDir: dataDir,
        vectorStore: (withTypeMethod ? store : Object.assign(Object.create(Object.getPrototypeOf(store)), store, { searchL1ByType: undefined })) as unknown as IMemoryStore,
      });
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  };

  let store: VectorStore | undefined;
  let dir = "";
  try {
    const made = makeStore(WF_ROWS);
    store = made.store; dir = made.dir;
    const on = await recall(store, ANALYTICAL_Q, "sk-v2bal-d-on");
    const ctx = on?.prependContext ?? "";
    const iA = ctx.indexOf("结论条目甲");
    const iB = ctx.indexOf("结论条目乙");
    const iC = ctx.indexOf("结论条目丙");
    check("D1 分析型 query：significance 降序 durative 结论无需命中浮出（top-5 内全出）",
      iA >= 0 && iB >= 0 && iC >= 0 && iA < iB && iB < iC,
      `idx=[${iA},${iB},${iC}]`);

    const nonAnalytical = await recall(store, "随便聊聊今天的天气", "sk-v2bal-d-na");
    check("D2 非分析型 query：无命中不出结论（现状逐位）",
      !(nonAnalytical?.prependContext ?? "").includes("[结论"));

    const switchOff = await recall(store, ANALYTICAL_Q, "sk-v2bal-d-off", { conclusionRelaxedForAnalytical: false });
    check("D3 conclusionRelaxedForAnalytical=false → 关断",
      !(switchOff?.prependContext ?? "").includes("结论条目甲"));

    const noMethod = await recall(store, ANALYTICAL_Q, "sk-v2bal-d-nomethod", {}, false);
    check("D4 searchL1ByType 缺失 → 通道退出（feature-detect 降级，不炸不报错）",
      noMethod !== undefined && noMethod.error === undefined,
      `error=${JSON.stringify(noMethod?.error ?? null)}`);
    check("D4b 无方法时结论块不含放宽结论",
      !(noMethod?.prependContext ?? "").includes("结论条目甲"));
  } finally {
    if (store) { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[E] config 解析：exploreSlot / conclusionRelaxedForAnalytical / rerankWeights");
console.log("=".repeat(72));
{
  const def = parseConfig({}).recall;
  check("[E] 缺省：exploreSlot=true / conclusionRelaxedForAnalytical=true / 相关度主导 0.7/0.15/0.1/0.05",
    def.exploreSlot === true && def.conclusionRelaxedForAnalytical === true &&
    JSON.stringify(def.rerankWeights) === JSON.stringify({ relevance: 0.7, timeProx: 0.15, significance: 0.1, coreRef: 0.05 }),
    JSON.stringify({ exploreSlot: def.exploreSlot, conclusionRelaxedForAnalytical: def.conclusionRelaxedForAnalytical, rerankWeights: def.rerankWeights }));
  const clamped = parseConfig({ recall: { rerankWeights: { relevance: -2, timeProx: 3, significance: 0, coreRef: 0 } } }).recall;
  check("[E] clamp：负值 → 0 / 正值原样 / 0 可设（关断矩阵）",
    clamped.rerankWeights.relevance === 0 && clamped.rerankWeights.timeProx === 3 && clamped.rerankWeights.significance === 0 && clamped.rerankWeights.coreRef === 0,
    JSON.stringify(clamped.rerankWeights));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
