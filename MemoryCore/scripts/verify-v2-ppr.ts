/**
 * verify-v2-ppr：召回 v2 引擎二 PPR 全图扩散验收（DS-RECALL-V2-THREE-ENGINES-001 §E2）。
 *
 * [A] ppr.ts 纯函数单元：多跳扩散（A→B→C 一步到位）/确定性/空图/种子归一化/topK 上限/
 *     无向遍历/自环安全/阻尼 0 退化/主导边类型（累积扩散量）/
 *     A1-ORACLE 手算 PPR 数值 fixture（30 轮 pprNorm，容差 1e-9，I-1 收口）/
 *     A1-CONV 收敛轮数断言（raw delta<1e-6 首达轮 = 86，手算一致；默认 30 轮未收敛实证登记）。
 * [B] 工具路真链路（临时 sqlite 库）：A→B→C 链 seeds={A} → B 与 C 都浮现且 C<B
 *     ——一跳 BFS 做不到的多跳一步到位（RED 断言核心）；分数天花板 = maxHitScore×discount；
 *     graphDiscount=0 → 零图候选（关断）；T14 跨租户不入池。
 * [C] auto-recall 路（searchHybrid mock）：同层多跳对齐（两排序点单一源消费）。
 * [D] config 解析：pprDamping/pprTopK/pprIterations clamp/默认（parseConfig 真函数）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-v2-ppr.ts
 *
 * 只用自建临时数据，不连任何线上资源；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPPRDetail, type PPREdge } from "../src/core/recall/ppr.js";
import { executeMemorySearch, formatSearchResponse } from "../src/core/tools/memory-search.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { searchHybrid } from "../src/core/hooks/auto-recall.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../src/core/store/types.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../src/core/tools/recall-signals.js";

const KW = "V2PPR"; // 唯一 ASCII 关键词（jieba 原样保留，FTS 稳定命中）

/** 基线参数 = 候选池通道关 + R-A1 六信号全 0。 */
const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  graphDiscount: 0,
  sceneBoost: 0,
} as const;

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};
const mapEq = (a: Map<string, number>, b: Map<string, number>): boolean =>
  a.size === b.size && [...a.entries()].every(([k, v]) => b.get(k) === v);

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] ppr.ts 纯函数单元（E2.1 算法规格）");
console.log("=".repeat(72));
{
  // A1 多跳扩散：A→B→C 链 seeds={A} → B 与 C 都浮现且 C < B（一跳 BFS 做不到）
  const chain: PPREdge[] = [
    { src: "a", tgt: "b", strength: 0.9, kind: "causal" },
    { src: "b", tgt: "c", strength: 0.9, kind: "evolve" },
  ];
  const d1 = runPPRDetail(new Map([["a", 1]]), chain, {});
  const hasB = d1.pprNorm.get("b") ?? 0;
  const hasC = d1.pprNorm.get("c") ?? 0;
  check("A1 多跳一步到位：B、C 都浮现且 C<B", hasB > 0 && hasC > 0 && hasC < hasB,
    `pprNorm(b)=${hasB.toFixed(6)}, pprNorm(c)=${hasC.toFixed(6)}`);
  check("A1b 归一化天花板：pprNorm(max非种子)=1", Math.abs(Math.max(...d1.pprNorm.values()) - 1) < 1e-12);
  check("A1c 主导边类型（累积扩散量）：b=causal, c=evolve",
    d1.kinds.get("b") === "causal" && d1.kinds.get("c") === "evolve",
    `kinds=${JSON.stringify([...d1.kinds.entries()])}`);

  // A1-ORACLE（V2 收口 · I-1）：A→B→C 链手算 PPR 数值 fixture（容差 1e-9）。
  // 手算（精确有理数迭代，BigInt 校验）：边 a-b(0.9, causal)、b-c(0.9, evolve)（无向）；
  // deg(a)=deg(c)=0.9, deg(b)=1.8；seeds={a:1} → p={a:1}；d=0.85。
  //   递推：a' = 3/20 + (17/40)·b ; b' = (17/20)·(a + c) ; c' = (17/40)·b
  //   r¹ = {a:3/20, b:17/20, c:0}；r² = {a:409/800, b:51/400, c:289/800}
  //   r³⁰ = {a:0.347023…, b:0.455953…, c:0.197023…} → pprNorm = {b:1, c:0.432112728143708}
  const d30 = runPPRDetail(new Map([["a", 1]]), chain, { maxIterations: 30 });
  check("A1-ORACLE 手算 fixture：30 轮 pprNorm = {b:1, c:0.432112728143708}（容差 1e-9）",
    Math.abs((d30.pprNorm.get("b") ?? 0) - 1) < 1e-9 &&
    Math.abs((d30.pprNorm.get("c") ?? 0) - 0.432112728143708) < 1e-9,
    `c=${(d30.pprNorm.get("c") ?? 0).toFixed(15)}`);
  check("A1-ORACLE 迭代语义：1 轮 → 只 b 浮现（pprNorm={b:1}）；2 轮 → pprNorm={b:6/17, c:1}",
    (() => {
      const d1it = runPPRDetail(new Map([["a", 1]]), chain, { maxIterations: 1 });
      const d2it = runPPRDetail(new Map([["a", 1]]), chain, { maxIterations: 2 });
      return d1it.pprNorm.size === 1 && Math.abs((d1it.pprNorm.get("b") ?? 0) - 1) < 1e-9 &&
        d2it.pprNorm.size === 2 && Math.abs((d2it.pprNorm.get("c") ?? 0) - 1) < 1e-9 &&
        Math.abs((d2it.pprNorm.get("b") ?? 0) - 6 / 17) < 1e-9;
    })());

  // A1-CONV（V2 收口 · I-1）收敛轮数断言。手算（精确有理数）：max|r'−r| < 1e-6 首达轮 = 86
  //（pprCore 收敛 break 条件，r₈₆ = {b:0.4594590683711728, c:0.1952704658144136}，
  // pprNorm₈₆ = {b:1, c:0.4250007873534120}）；分布自此冻结 → pprNorm 扫描在 t=87 首次检出
  // delta=0（= 手算收敛轮 86 + 检出滞后 1）。
  // 同时登记：默认 30 轮在 A→B→C 链远未收敛（delta₃₀≈2.7e-3）——生产深链以 30 轮截断值
  // 参与排序（位次序不变，绝对值非不动点），这是设计 §E2.1 "或 30 次迭代" 的真实边界，
  // 实证登记而非缺陷。
  const pnAt = (t: number): [number, number] => {
    const d = runPPRDetail(new Map([["a", 1]]), chain, { maxIterations: t });
    return [d.pprNorm.get("b") ?? 0, d.pprNorm.get("c") ?? 0];
  };
  let convRound = 0;
  for (let t = 2; t <= 120; t++) {
    const prev = pnAt(t - 1);
    const cur = pnAt(t);
    if (Math.max(Math.abs(cur[0] - prev[0]), Math.abs(cur[1] - prev[1])) < 1e-6) { convRound = t; break; }
  }
  check("A1-CONV 收敛轮数：raw delta<1e-6 手算首达轮 = 86 → pprNorm 扫描检出 = 87（86+1）",
    convRound === 87, `convRound=${convRound}`);
  check("A1-CONV 收敛点数值：86 轮 pprNorm = {b:1, c:0.4250007873534120}（手算，容差 1e-9）",
    Math.abs((pnAt(86)[1]) - 0.425000787353412) < 1e-9,
    `c=${pnAt(86)[1].toFixed(16)}`);
  check("A1-CONV 输出冻结：收敛后（≥86 轮）pprNorm 逐位不变（86 vs 120 轮）",
    pnAt(86)[0] === pnAt(120)[0] && pnAt(86)[1] === pnAt(120)[1]);
  check("A1-CONV 登记：默认 30 轮未收敛（30 vs 60 轮 pprNorm 差 > 1e-4）",
    (() => {
      const a30 = pnAt(30);
      const a60 = pnAt(60);
      return Math.max(Math.abs(a30[0] - a60[0]), Math.abs(a30[1] - a60[1])) > 1e-4;
    })());

  // A2 确定性：同图同种子同结果（逐位）
  const d2 = runPPRDetail(new Map([["a", 1]]), chain, {});
  check("A2 确定性：两次运行逐位一致", mapEq(d1.pprNorm, d2.pprNorm) && d1.kinds.get("b") === d2.kinds.get("b"));

  // A3 空图 → 零输出（现状退化）
  const d3 = runPPRDetail(new Map([["a", 1]]), [], {});
  check("A3 空图 → 空 pprNorm（零图候选）", d3.pprNorm.size === 0);

  // A4 种子归一化：权重整体缩放不变（score/Σscore）
  const d4a = runPPRDetail(new Map([["a", 2], ["b", 1]]), chain, {});
  const d4b = runPPRDetail(new Map([["a", 20], ["b", 10]]), chain, {});
  check("A4 种子权重归一化：等比缩放输出逐位一致", mapEq(d4a.pprNorm, d4b.pprNorm));

  // A5 topK 上限：5 个合格邻居只出 topK=3
  const star: PPREdge[] = Array.from({ length: 5 }, (_, i) => ({ src: "a", tgt: `n${i}`, strength: 0.9, kind: "causal" }));
  const d5 = runPPRDetail(new Map([["a", 1]]), star, { topK: 3 });
  check("A5 topK 上限：5 邻居只出 3", d5.pprNorm.size === 3, `size=${d5.pprNorm.size}`);

  // A6 阻尼 0 → r=p，无非种子质量 → 空（0 可设 = 通道退化关断）
  const d6 = runPPRDetail(new Map([["a", 1]]), chain, { damping: 0 });
  check("A6 damping=0 → 零非种子输出", d6.pprNorm.size === 0);

  // A7 无向遍历：仅存 a→b 一条有向边，seeds={b} → a 浮现（召回语义对称）
  const d7 = runPPRDetail(new Map([["b", 1]]), [{ src: "a", tgt: "b", strength: 0.9, kind: "causal" }], {});
  check("A7 无向遍历：反向端浮现", (d7.pprNorm.get("a") ?? 0) > 0);

  // A8 自环安全：自环边不炸、不入输出
  const d8 = runPPRDetail(new Map([["a", 1]]), [{ src: "a", tgt: "a", strength: 0.9, kind: "causal" }], {});
  check("A8 自环安全", d8.pprNorm.size === 0);
}

// ══════════════════════════════════════════════════════════
const mk = (
  id: string,
  over: Partial<MemoryRecord> = {},
): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} PPR 验证条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-v2-ppr",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-11T00:00:00Z"],
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-v2-ppr",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-ppr-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

async function search(
  store: VectorStore,
  params: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof executeMemorySearch>>> {
  return executeMemorySearch({
    query: KW,
    limit: 10,
    vectorStore: store,
    ...ALL_OFF,
    ...params,
  } as Parameters<typeof executeMemorySearch>[0]);
}

console.log("");
console.log("=".repeat(72));
console.log("[B] 工具路真链路：PPR 多跳扩散（临时 sqlite 库，每场景 fresh）");
console.log("=".repeat(72));
{
  // B1 链式多跳：a（KW 命中）→b→c；b、c 只能经图通道入池
  const { store, dir } = makeStore([
    mk("a"),
    mk("b", { content: "链中继条目（不含关键词）" }),
    mk("c", { content: "链末端条目（不含关键词）" }),
  ]);
  try {
    store.addLink("a", "b", "causal", 0.9);
    store.addLink("b", "c", "evolve", 0.9);
    const on = await search(store, { graphDiscount: 0.6, graphMinStrength: 0.5 });
    const a = on.results.find((r) => r.id === "a");
    const b = on.results.find((r) => r.id === "b");
    const c = on.results.find((r) => r.id === "c");
    const b1 = !!a && !!b && !!c && c.score < b.score;
    check("B1 多跳一步到位：A→B→C 链 seeds={A} → B 与 C 都浮现且 C<B", b1,
      `ids=[${on.results.map((r) => r.id).join(", ")}]`);
    check("B1b 标注自证：b=[graph:ppr:causal], c=[graph:ppr:evolve]",
      b?.recall_channel === "graph:ppr:causal" && c?.recall_channel === "graph:ppr:evolve",
      `b=${b?.recall_channel}, c=${c?.recall_channel}`);
    check("B1c 折扣语义保持：非种子天花板 = maxHitScore×graphDiscount（b 为最大非种子）",
      !!a && !!b && Math.abs(b.score - a.score * 0.6) < 1e-9,
      `a=${a?.score.toFixed(6)}, b=${b?.score.toFixed(6)}`);
    const text = formatSearchResponse(on);
    check("B1d 响应文本可见 [graph:ppr:*]", text.includes("[graph:ppr:causal]"));

    // 关断矩阵：graphDiscount=0 → 零图候选（b、c 均不出现）
    const off = await search(store);
    check("B2 graphDiscount=0 → 零图候选（关断矩阵）",
      !off.results.some((r) => r.id === "b" || r.id === "c"),
      `ids=[${off.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }

  // B3 strength 门槛：a→b 0.4 < 0.5 → b 不入池；b→c 再强也不经弱边扩散
  const s2 = makeStore([
    mk("a"),
    mk("b", { content: "弱边中继（不含关键词）" }),
    mk("c", { content: "弱边末端（不含关键词）" }),
  ]);
  try {
    s2.store.addLink("a", "b", "causal", 0.4);
    s2.store.addLink("b", "c", "evolve", 0.9);
    const res = await search(s2.store, { graphDiscount: 0.6, graphMinStrength: 0.5 });
    check("B3 边强度门槛：0.4<0.5 弱边不入图（宁缺毋滥，下游不扩散）",
      !res.results.some((r) => r.id === "b" || r.id === "c"),
      `ids=[${res.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { s2.store.close(); fs.rmSync(s2.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }

  // B4 T14 租户过滤：跨租户邻居不入图
  const s3 = makeStore([mk("a")]);
  try {
    s3.store.upsertL1(mk("alien", { content: "跨租户邻居", teamId: "other-team", userId: "ou", agentId: "oa" }), undefined);
    s3.store.addLink("a", "alien", "causal", 0.9);
    const filter: IsolationFilter = { teamId: "default", userId: "default", agentId: "default" };
    const res = await search(s3.store, { graphDiscount: 0.6, graphMinStrength: 0.5, filter });
    check("B4 T14 租户过滤照常：跨租户邻居不入池",
      !res.results.some((r) => r.id === "alien"),
      `ids=[${res.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { s3.store.close(); fs.rmSync(s3.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }

  // B5 pprTopK=0（config 0 可设）→ 零图候选
  const s4 = makeStore([mk("a"), mk("n1", { content: "邻居条目（不含关键词）" })]);
  try {
    s4.store.addLink("a", "n1", "causal", 0.9);
    const res = await search(s4.store, {
      graphDiscount: 0.6, graphMinStrength: 0.5, pprTopK: 0,
    });
    check("B5 pprTopK=0 → 零图候选（0 可设）",
      !res.results.some((r) => r.id === "n1"),
      `ids=[${res.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { s4.store.close(); fs.rmSync(s4.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] auto-recall 路（searchHybrid mock）：同层多跳对齐");
console.log("=".repeat(72));
{
  const vecHit = (id: string, over: Partial<L1SearchResult> = {}): L1SearchResult => ({
    record_id: id,
    content: `V2PPR auto-recall 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.5,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  });
  const NB_BY_ID: Record<string, Array<{ id: string; type: string; strength: number; hop: number }>> = {
    a: [{ id: "b", type: "causal", strength: 0.9, hop: 1 }],
    b: [{ id: "a", type: "causal", strength: 0.9, hop: 1 }, { id: "c", type: "evolve", strength: 0.9, hop: 1 }],
    c: [{ id: "b", type: "evolve", strength: 0.9, hop: 1 }],
  };
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => [vecHit("a")],
    getNeighbors: (id: string) => NB_BY_ID[id] ?? [],
    getL1ByIdsWithArchive: (ids: string[]) => ids.map((id) => vecHit(id, { score: 0 })),
  } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  const signals: RankSignals = ZERO_RANK_SIGNALS;
  const res = await searchHybrid("V2PPR 查询", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals,
    now: new Date(),
    graph: { minStrength: 0.5, discount: 0.6 },
  });
  const bLine = res.lines.find((l) => l.includes("条目 b"));
  const cLine = res.lines.find((l) => l.includes("条目 c"));
  check("C1 auto-recall 同层多跳：B 与 C 都浮现（注入行）", !!bLine && !!cLine,
    `lines=${res.lines.length}`);
  check("C2 auto-recall 标注自证：[graph:ppr:causal] / [graph:ppr:evolve]",
    bLine?.includes("[graph:ppr:causal]") === true && cLine?.includes("[graph:ppr:evolve]") === true);
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] config 解析：pprDamping/pprTopK/pprIterations（parseConfig 真函数）");
console.log("=".repeat(72));
{
  const cfg = parseConfig({ recall: { pprDamping: 2, pprTopK: -5, pprIterations: 500 } });
  const d1 = cfg.recall.pprDamping === 1 && cfg.recall.pprTopK === 0 && cfg.recall.pprIterations === 100;
  check("[D] clamp：damping 上界 1 / topK 负值→0 / iterations 上界 100", d1,
    JSON.stringify({ pprDamping: cfg.recall.pprDamping, pprTopK: cfg.recall.pprTopK, pprIterations: cfg.recall.pprIterations }));
  const def = parseConfig({}).recall;
  const d2 = def.pprDamping === 0.85 && def.pprTopK === 10 && def.pprIterations === 30;
  check("[D] 缺省默认 0.85 / 10 / 30（E2.1）", d2,
    JSON.stringify({ pprDamping: def.pprDamping, pprTopK: def.pprTopK, pprIterations: def.pprIterations }));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
