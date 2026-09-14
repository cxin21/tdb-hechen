/**
 * R-A2 同形验证（结构感知召回 spec §5 验收②真数据流）+ V2-1 行为变更更新：临时 sqlite 库真链路——
 * 候选池三通道 V2-1 PPR 图扩散（替换 R4 一跳，预期行为变更已登记）/ R5 价值反查补池 / R6 场景路由 的
 * 单开/关断 三态断言 + 不变式核对（T2 门 / T14 租户过滤 / 标注自证身份）。
 *
 * [A] 前置证据（数据形状实证，落库读回）：
 *     A1 addLink 建边 → getNeighbors 真实读回（T14 filter 生效前提）；
 *     A2 metadata coreRefs 落库 → searchL1ByCoreRefs 真库反查命中。
 * [B] 真实 executeMemorySearch（临时库，dimensions=0 无向量行 → FTS-only 策略）：
 *     每场景独立 fresh 库（重巩固 fire-and-forget 不串场）。PPR/R5/R6 通道断言 +
 *     关断（graphDiscount=0 / coreRefBoost=0 / sceneBoost=0）= 基线。
 * [C] T2 门照常：图入池 inferred 邻居不吃重巩固（recall_count 不增），observed 种子吃。
 * [D] T14 租户过滤照常：跨租户邻居不入池。
 * [E] config 解析：graphMinStrength/graphDiscount/sceneBoost/pprDamping/pprTopK/pprIterations
 *     clamp/默认（parseConfig 真函数）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-ra2.ts   （或 node tsx-cli scripts/verify-ra2.ts）
 *
 * 只用自建临时数据，不连任何线上资源；不碰 D:/tdai-data/ 生产进程；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeMemorySearch, formatSearchResponse } from "../src/core/tools/memory-search.js";
import { parseConfig } from "../src/config.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { IsolationFilter } from "../src/core/store/types.js";

const KW = "RA2PIN"; // 唯一 ASCII 关键词（jieba 原样保留，FTS 稳定命中）

/** 基线参数 = 三通道全关 + R-A1 六信号全 0。 */
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

const mk = (
  id: string,
  over: Partial<MemoryRecord> = {},
): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 结构感知召回验证条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-ra2",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-ra2",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ra2-"));
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

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] 前置证据：addLink/getNeighbors 读回；coreRefs 落库 + searchL1ByCoreRefs 反查");
console.log("=".repeat(72));
{
  const { store, dir } = makeStore([mk("a"), mk("n1")]);
  try {
    store.addLink("a", "n1", "causal", 0.9);
    const nb = store.getNeighbors("a");
    const a1 = nb.length === 1 && nb[0].id === "n1" && nb[0].type === "causal" && nb[0].strength === 0.9;
    console.log(`A1 getNeighbors 读回：${JSON.stringify(nb)}`);

    store.upsertL1(mk("v-mem", { content: "价值条目", metadata: { coreRefs: ["正确性"] } }), undefined);
    const backfill = store.searchL1ByCoreRefs(["正确性"], 10);
    const a2 = backfill.length === 1 && backfill[0].record_id === "v-mem";
    console.log(`A2 searchL1ByCoreRefs 反查：${JSON.stringify(backfill.map((r) => r.record_id))}`);
    check("[A] 数据形状前置证据", a1 && a2, `getNeighbors=${nb.length}, backfill=${backfill.length}`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] 真实链路：V2-1 PPR 图扩散（替换 R4 一跳）/ R5 价值反查补池 / R6 场景路由（每场景 fresh 库）");
console.log("=".repeat(72));
{
  // ── V2-1 PPR 图扩散（原 R4 图一跳；预期行为变更登记：一跳→多跳扩散，标注 graph:ppr:kind）──
  {
    // 邻居记录 content 不含 KW——保证其只能经图通道入池（不被 FTS 主检索命中）
    const { store, dir } = makeStore([mk("a"), mk("n1", { content: "邻居条目一（不含关键词）" })]);
    try {
      store.addLink("a", "n1", "causal", 0.9);
      const on = await search(store, { graphDiscount: 0.6, graphMinStrength: 0.5 });
      const a = on.results.find((r) => r.id === "a");
      const n1 = on.results.find((r) => r.id === "n1");
      // V2-1：单邻居 = PPR 非种子最大者 → pprNorm=1 → 分数天花板 = a.score×0.6（折扣语义保持）
      const b1 = !!n1 && !!a && Math.abs(n1.score - a.score * 0.6) < 1e-9 && n1.recall_channel === "graph:ppr:causal";
      const text = formatSearchResponse(on);
      check("R4→PPR：唯一邻居以 0.6×命中分入池（pprNorm=1）+ [graph:ppr:causal] 标注（文本可见）", b1 && text.includes("[graph:ppr:causal]"),
        `a.score=${a?.score.toFixed(4)}, n1.score=${n1?.score.toFixed(4)}, channel=${n1?.recall_channel}`);

      const off = await search(store);
      check("R4→PPR：graphDiscount=0 → 通道退出（n1 不在结果）", !off.results.some((r) => r.id === "n1"),
        `ids=[${off.results.map((r) => r.id).join(", ")}]`);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }

    // strength 门槛
    const s2 = makeStore([mk("a"), mk("n2", { content: "邻居条目二（不含关键词）" })]);
    try {
      s2.store.addLink("a", "n2", "similar", 0.4);
      const res = await search(s2.store, { graphDiscount: 0.6, graphMinStrength: 0.5 });
      check("R4：strength 0.4 < 0.5 → 不入池（宁缺毋滥）", !res.results.some((r) => r.id === "n2"),
        `ids=[${res.results.map((r) => r.id).join(", ")}]`);
    } finally {
      try { s2.store.close(); fs.rmSync(s2.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }

    // 环安全 + 上限
    const s3 = makeStore([mk("a"), ...Array.from({ length: 12 }, (_, i) => mk(`n${i + 1}`, { content: `邻居环条目 ${i + 1}（不含关键词）` }))]);
    try {
      s3.store.addLink("a", "a", "similar", 0.9); // 自环
      for (let i = 1; i <= 12; i++) {
        s3.store.addLink("a", `n${i}`, "causal", 0.9);
        s3.store.addLink(`n${i}`, "a", "causal", 0.9); // 反向成环
      }
      const res = await search(s3.store, { graphDiscount: 0.6, graphMinStrength: 0.5, limit: 20 });
      const ids = res.results.map((r) => r.id);
      const unique = new Set(ids).size === ids.length;
      const graphCount = res.results.filter((r) => r.recall_channel?.startsWith("graph:ppr:")).length;
      check("R4→PPR：自环/反向环安全（id 唯一）+ 候选上限 topK=10", unique && graphCount === 10, `graph=${graphCount}, total=${ids.length}`);
    } finally {
      try { s3.store.close(); fs.rmSync(s3.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  }

  // ── R5 价值反查补池 ──
  {
    // 触发态：主检索 1 条（v-mem 内容不含 KW）→ 1*2 < limit 4
    const { store, dir } = makeStore([
      mk("a"),
      mk("v-mem", { content: "价值锚相关记忆条目", metadata: { coreRefs: ["正确性"] } }),
    ]);
    try {
      store.upsertValue("v-c", "正确性", 0.8, "verify", undefined, 1);
      const on = await search(store, { query: `${KW} 正确性`, limit: 4, coreRefBoost: 0.05 });
      const vm = on.results.find((r) => r.id === "v-mem");
      const b2 = !!vm && vm.recall_channel === "value:正确性" && vm.score === 0 &&
        Array.isArray(vm.touched_core_refs) && vm.touched_core_refs.includes("正确性");
      check("R5：结果 < limit 一半 → 反查补池 + [value:锚] 标注（score=0 不伪装修.seed 分）", b2,
        `vm=${vm ? `ch=${vm.recall_channel}, score=${vm.score}` : "MISSING"}`);

      // 关断态：coreRefBoost=0 → 值通道整体退出（含反查）
      const off = await search(store, { query: `${KW} 正确性`, limit: 4, coreRefBoost: 0 });
      check("R5：coreRefBoost=0 → 值通道退出（v-mem 不在结果）", !off.results.some((r) => r.id === "v-mem"));
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }

    // 不触发态：主检索 2 条（2*2 = 4 不小于 4）
    const s2 = makeStore([
      mk("a"), mk("b"),
      mk("v-mem", { content: "价值锚相关记忆条目", metadata: { coreRefs: ["正确性"] } }),
    ]);
    try {
      s2.store.upsertValue("v-c", "正确性", 0.8, "verify", undefined, 1);
      const res = await search(s2.store, { query: `${KW} 正确性`, limit: 4, coreRefBoost: 0.05 });
      check("R5：结果 ≥ limit 一半 → 不触发反查", !res.results.some((r) => r.id === "v-mem"));
    } finally {
      try { s2.store.close(); fs.rmSync(s2.dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  }

  // ── R6 场景路由 ──
  {
    const { store, dir } = makeStore([mk("a"), mk("b", { scene_name: "项目重构" })]);
    try {
      const on = await search(store, { query: `${KW} 项目重构 的进展`, sceneBoost: 0.04 });
      check("R6：query 含场景名 → b 前移至首位", on.results[0]?.id === "b", `ids=[${on.results.map((r) => r.id).join(", ")}]`);
      const off = await search(store, { query: `${KW} 项目重构 的进展` });
      check("R6：sceneBoost=0 → 基线序", off.results.map((r) => r.id).join(",") === "a,b");
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] T2 门照常：图入池 inferred 邻居不吃重巩固（白名单只放行 observed）");
console.log("=".repeat(72));
{
  const { store, dir } = makeStore([
    mk("a", { certainty: "observed" } as Partial<MemoryRecord>),
    mk("n1", { certainty: "inferred" } as Partial<MemoryRecord>),
  ]);
  try {
    store.addLink("a", "n1", "causal", 0.9);
    // 三次召回：observed 种子 recall_count 应累加到 3；inferred 邻居应恒缺
    for (let i = 0; i < 3; i++) await search(store, { graphDiscount: 0.6, graphMinStrength: 0.5 });
    const rows = store.queryL1Records() as Array<{ record_id: string; metadata_json?: string }>;
    const countOf = (id: string): number => {
      const row = rows.find((r) => r.record_id === id);
      try { return Number(JSON.parse(row?.metadata_json ?? "{}").recall_count ?? 0); } catch { return 0; }
    };
    const c1 = countOf("a") === 3 && countOf("n1") === 0;
    check("[C] T2 门照常：observed 种子 recall_count=3，图入池 inferred 邻居恒 0", c1,
      `a=${countOf("a")}, n1=${countOf("n1")}`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] T14 租户过滤照常：跨租户邻居不入池");
console.log("=".repeat(72));
{
  const { store, dir } = makeStore([mk("a")]);
  try {
    store.upsertL1(mk("alien", { content: `${KW} 邻居条目 alien`, teamId: "other-team", userId: "ou", agentId: "oa" }), undefined);
    store.addLink("a", "alien", "causal", 0.9);
    const filter: IsolationFilter = { teamId: "default", userId: "default", agentId: "default" };
    const res = await search(store, { graphDiscount: 0.6, graphMinStrength: 0.5, filter });
    check("[D] 跨租户邻居被 T14 filter 排除", !res.results.some((r) => r.id === "alien"),
      `ids=[${res.results.map((r) => r.id).join(", ")}]`);
  } finally {
    try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

// ══════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[E] config 解析：graphMinStrength/graphDiscount/sceneBoost + V2-1 PPR 三旋钮（parseConfig 真函数）");
console.log("=".repeat(72));
{
  const cfg = parseConfig({ recall: { graphMinStrength: 2, graphDiscount: -1, sceneBoost: 0.07, pprDamping: 2, pprTopK: -5, pprIterations: 500 } });
  const e1 = cfg.recall.graphMinStrength === 1 && cfg.recall.graphDiscount === 0 && cfg.recall.sceneBoost === 0.07 &&
    cfg.recall.pprDamping === 1 && cfg.recall.pprTopK === 0 && cfg.recall.pprIterations === 100;
  check("[E] clamp（比值上界 1）/ 负值 clamp 0 / 默认值 / PPR 三旋钮 clamp", e1, JSON.stringify({
    graphMinStrength: cfg.recall.graphMinStrength,
    graphDiscount: cfg.recall.graphDiscount,
    sceneBoost: cfg.recall.sceneBoost,
    pprDamping: cfg.recall.pprDamping,
    pprTopK: cfg.recall.pprTopK,
    pprIterations: cfg.recall.pprIterations,
  }));
  const def = parseConfig({}).recall;
  const e2 = def.graphMinStrength === 0.5 && def.graphDiscount === 0.6 && def.sceneBoost === 0.04 &&
    def.pprDamping === 0.85 && def.pprTopK === 10 && def.pprIterations === 30;
  check("[E] 缺省默认 0.5 / 0.6 / 0.04 + PPR 0.85 / 10 / 30（spec §2 / E2.1）", e2, JSON.stringify({
    graphMinStrength: def.graphMinStrength, graphDiscount: def.graphDiscount, sceneBoost: def.sceneBoost,
    pprDamping: def.pprDamping, pprTopK: def.pprTopK, pprIterations: def.pprIterations,
  }));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
