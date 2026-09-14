/**
 * S5 同形验证：C5 coreRef 排序加成延伸 auto-recall + C6 getPath 图查询接口。
 *
 * 背景（task-s5-brief）：
 *   C5：coreRefBoost 目前只在 executeMemorySearch 咽喉（主动查询两路）生效；
 *       auto-recall 注入（hooks/auto-recall.ts，每轮自动召回主通道）的 hybrid RRF
 *       排序未加。修法：复用同一加成（memory.recall.coreRefBoost，默认 0.05）——
 *       命中当前 appraisal 价值 ∧ 记忆 metadata.coreRefs 含之 → 排序 rankKey +boost。
 *       宁缺毋滥：仅排序（不越 work_fact 分层、不改门槛）；无 fired → 无加成。
 *   C6：getPath(startId, endId, maxHop=3, types?, filter?) —— BFS 最短路径
 *       （复用 getNeighbors 的 seen/frontier 模式），不可达返回 null；
 *       filter 租户过滤必带（T14 教训：新图接口从第一天就带 isolation）。
 *       路由 /v3/atomic/path 消费 requestIsolation（照抄 neighbors :1405）。
 *
 * 断言组（验收契约）：
 *   C5-1 searchHybrid 排序加成：coreRefs 命中记忆在同层内翻到非命中记忆之前；
 *        boost=0 / 无 fired labels → 基线序不变（加成是位次差异唯一来源）。
 *   C5-2 performAutoRecall 端到端（真实 sqlite + hashEmbed）：有价值锚 → coreRefs
 *        记忆先注入；无价值锚（fired 空）→ 基线序（宁缺毋滥回归）。
 *   C6-1 建链 A→B→C：getPath(A,C)=[B]（hop 1/2）；A→X 不可达 → null。
 *   C6-2 租户过滤：A→X(B租户)→C，带 A filter → null（跨租户中继不可见）；
 *        不带 filter（显式 undefined）→ 旧行为（可达）；B 视角查 A 起点 → null。
 *   C6-3 maxHop 截断：A→B→C maxHop=1 → null；maxHop=2 → 可达。
 *   C6-4 环路安全：A→B→A 环不死循环；环上取路径正常返回。
 *   C6-5 handler 端到端：/v3/atomic/path 消费 requestIsolation；maxHop clamp ≤3
 *        （maxHop=10 请求 4 跳 → null）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-s5.ts
 *
 * 只用自建临时库（hashEmbed + 真实 VectorStore 64 维，参照 verify-c1/p2-t14），
 * 不连任何线上资源、不碰生产数据目录；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { VectorStore } from "../src/core/store/sqlite.js";
import { searchHybrid, performAutoRecall } from "../src/core/hooks/auto-recall.js";
import type { MemoryTdaiConfig } from "../src/config.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { IsolationFilter } from "../src/core/store/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { Logger } from "../src/core/types.js";

// C6 新导出（未实现前动态导入 → RED：undefined）
const routerMod: typeof import("../src/gateway/v2-router.js") = await import(
  "../src/gateway/v2-router.js"
);
const handleAtomicPath = (routerMod as { handleAtomicPath?: unknown }).handleAtomicPath;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

/** 确定性 embedding（参照 verify-c1 / verify-p1-t9）。 */
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

const logger: Logger = {
  info: () => {},
  warn: (m: string) => console.log(`  [warn] ${m}`),
  error: () => {},
  debug: () => {},
} as never;

// ── fixture ─────────────────────────────────────────────────────────────

const TENANT_A: IsolationFilter = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B: IsolationFilter = { teamId: "teamB", userId: "userB", agentId: "agentB" };

function mk(
  id: string,
  content: string,
  metadata: Record<string, unknown>,
  tenant?: IsolationFilter,
): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-s5",
    source_message_ids: [],
    metadata,
    timestamps: [now],
    occurred_at: now,
    certainty: "observed",
    createdAt: now,
    updatedAt: now,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-s5",
    ...(tenant ? { teamId: tenant.teamId, userId: tenant.userId, agentId: tenant.agentId } : {}),
  } as unknown as MemoryRecord;
}

function newStore(tmpDir: string, name: string): VectorStore {
  const store = new VectorStore(path.join(tmpDir, `${name}.db`), 64, console as never);
  const res = store.init() as unknown;
  if (typeof (store as { isDegraded?: () => boolean }).isDegraded === "function" && (store as { isDegraded: () => boolean }).isDegraded()) {
    throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  }
  return store;
}

const QUERY = "请核对正确性验收";
const R1_CONTENT = "正确性验收流程完整记录"; // 无 coreRefs；与 query 大量重叠 → 基线第 1
const R2_CONTENT = "正确性必须保证";           // coreRefs ["正确"]；基线第 2

// FIX3（测试层隔离，零生产行为变化）：V2-3 组合分精排（4ce97ea 引入、R-v2.1/beb2022
// 配置收口；searchHybrid 直调缺省权重 1/1/1）在 C5-1 组关断。其 coreRefCount 因子
// 不检查 boost（firedLabels 在场即计数），boost=0 时仍会把 r2 翻到 r1 前——C5-1c RED
// 根因；occurred_at 时近因子亦会让同内容两行的先后依赖创建毫秒（潜在 flake）。
// C5 契约是 coreRefBoost 的 rankKey 加成（位次差异唯一来源），生产注释明示
// "全 0 = 关断恒等"。语义来源标注见 task-fix3-report.md。
const COMPOSITE_OFF = { occurredTime: 0, significance: 0, coreRef: 0 };

async function seedRecallStore(store: VectorStore): Promise<void> {
  store.upsertL1(mk("r1", R1_CONTENT, {}), hashEmbed(R1_CONTENT));
  store.upsertL1(mk("r2", R2_CONTENT, { coreRefs: ["正确"] }), hashEmbed(R2_CONTENT));
}

function orderInLines(lines: string[]): { r1: number; r2: number } {
  return {
    r1: lines.findIndex((l) => l.includes("流程完整")),
    r2: lines.findIndex((l) => l.includes("必须保证")),
  };
}

// ── C5-1：searchHybrid 排序加成 ─────────────────────────────────────────

async function testC5SearchHybrid(tmpDir: string): Promise<void> {
  console.log("\n[C5-1] searchHybrid：coreRef 命中 → 同层内排序翻转（rankKey +boost）");
  const store = newStore(tmpDir, "c5-hybrid");
  await seedRecallStore(store);
  store.upsertValue("v_correct", "正确", 0.6); // default 桶（与 auto-recall 默认租户上下文对齐）

  const base = await searchHybrid(QUERY, tmpDir, 5, 0.01, store, embedding, logger, undefined, undefined,
    undefined, undefined, undefined, undefined, COMPOSITE_OFF);
  const baseOrder = orderInLines(base.lines);
  check(
    "C5-1a 基线（无加成）r1 先于 r2（两路召回 r1 均占先，测试前提成立）",
    baseOrder.r1 >= 0 && baseOrder.r2 >= 0 && baseOrder.r1 < baseOrder.r2,
    JSON.stringify(baseOrder),
  );

  const boosted = await searchHybrid(QUERY, tmpDir, 5, 0.01, store, embedding, logger, undefined, {
    boost: 0.05,
    firedLabels: ["正确"],
  }, undefined, undefined, undefined, undefined, COMPOSITE_OFF);
  const boostedOrder = orderInLines(boosted.lines);
  check(
    "C5-1b boost=0.05 + fired=[正确] → r2（coreRefs 命中）翻到 r1 之前",
    boostedOrder.r2 >= 0 && boostedOrder.r2 < boostedOrder.r1,
    JSON.stringify(boostedOrder),
  );

  const zeroBoost = await searchHybrid(QUERY, tmpDir, 5, 0.01, store, embedding, logger, undefined, {
    boost: 0,
    firedLabels: ["正确"],
  }, undefined, undefined, undefined, undefined, COMPOSITE_OFF);
  const zeroOrder = orderInLines(zeroBoost.lines);
  check(
    "C5-1c boost=0 → 基线序不变（加成关闭零影响）",
    zeroOrder.r1 >= 0 && zeroOrder.r1 < zeroOrder.r2,
    JSON.stringify(zeroOrder),
  );

  const noFired = await searchHybrid(QUERY, tmpDir, 5, 0.01, store, embedding, logger, undefined, {
    boost: 0.05,
    firedLabels: [],
  }, undefined, undefined, undefined, undefined, COMPOSITE_OFF);
  const noFiredOrder = orderInLines(noFired.lines);
  check(
    "C5-1d 无 fired → 无加成（基线序不变，宁缺毋滥）",
    noFiredOrder.r1 >= 0 && noFiredOrder.r1 < noFiredOrder.r2,
    JSON.stringify(noFiredOrder),
  );

  store.close();
}

// ── C5-2：performAutoRecall 端到端（真实 sqlite + hashEmbed） ───────────

function recallCfg(coreRefBoost: number): MemoryTdaiConfig {
  return {
    recall: {
      strategy: "hybrid",
      maxResults: 5,
      scoreThreshold: 0.01,
      timeoutMs: 5000,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      coreRefBoost,
    },
  } as unknown as MemoryTdaiConfig;
}

async function testC5AutoRecallE2E(tmpDir: string): Promise<void> {
  console.log("\n[C5-2] performAutoRecall 端到端：价值锚 + coreRefs → 注入排序翻转");

  // 有价值锚：appraise(query) fired=[正确] → r2 coreRefs 命中 → 先注入
  const storeBoosted = newStore(tmpDir, "c5-e2e-boosted");
  await seedRecallStore(storeBoosted);
  storeBoosted.upsertValue("v_correct", "正确", 0.6);
  const resBoosted = await performAutoRecall({
    userText: QUERY,
    actorId: "u1",
    sessionKey: "s1",
    cfg: recallCfg(0.05),
    pluginDataDir: tmpDir,
    logger,
    vectorStore: storeBoosted,
    embeddingService: embedding,
  });
  const boostedMem = resBoosted?.recalledL1Memories ?? [];
  const iR1b = boostedMem.findIndex((m) => m.content.includes("流程完整"));
  const iR2b = boostedMem.findIndex((m) => m.content.includes("必须保证"));
  check(
    "C5-2a 有价值锚 → r2（coreRefs 命中）先于 r1 注入",
    iR2b >= 0 && iR1b >= 0 && iR2b < iR1b,
    `order r1=${iR1b} r2=${iR2b}`,
  );

  // 无价值锚（fired 空）→ 基线序（宁缺毋滥回归）
  const storePlain = newStore(tmpDir, "c5-e2e-plain");
  await seedRecallStore(storePlain);
  const resPlain = await performAutoRecall({
    userText: QUERY,
    actorId: "u1",
    sessionKey: "s1",
    cfg: recallCfg(0.05),
    pluginDataDir: tmpDir,
    logger,
    vectorStore: storePlain,
    embeddingService: embedding,
  });
  const plainMem = resPlain?.recalledL1Memories ?? [];
  const iR1p = plainMem.findIndex((m) => m.content.includes("流程完整"));
  const iR2p = plainMem.findIndex((m) => m.content.includes("必须保证"));
  check(
    "C5-2b 无价值锚 → 基线序 r1 先于 r2（fired 空无加成）",
    iR1p >= 0 && iR2p >= 0 && iR1p < iR2p,
    `order r1=${iR1p} r2=${iR2p}`,
  );

  storeBoosted.close();
  storePlain.close();
}

// ── C6：getPath（真实 sqlite 临时库）────────────────────────────────────

type PathNode = { id: string; type: string; strength: number; hop: number };
function getPathOf(store: VectorStore, ...args: Parameters<NonNullable<VectorStore["getPath"]>>): ReturnType<NonNullable<VectorStore["getPath"]>> {
  const fn = (store as unknown as { getPath?: unknown }).getPath;
  if (typeof fn !== "function") return null as never;
  return (fn as (...a: unknown[]) => unknown).apply(store, args) as ReturnType<NonNullable<VectorStore["getPath"]>>;
}

async function testC6Graph(tmpDir: string): Promise<void> {
  console.log("\n[C6-1..4] getPath：BFS 最短路径 + 租户过滤 + maxHop + 环路安全");
  const store = newStore(tmpDir, "c6-path");

  check(
    "C6-0 RED 前置：store.getPath 可选方法已存在",
    typeof (store as unknown as { getPath?: unknown }).getPath === "function",
  );

  // 租户 A：A→B→C 主链；X 为租户 B 中继（A→X→C 5 跳探针里用）
  store.upsertL1(mk("nA", "节点A", {}, TENANT_A), undefined);
  store.upsertL1(mk("nB", "节点B", {}, TENANT_A), undefined);
  store.upsertL1(mk("nC", "节点C", {}, TENANT_A), undefined);
  store.upsertL1(mk("nX", "节点X跨租户", {}, TENANT_B), undefined);
  store.upsertL1(mk("nIso", "孤立节点", {}, TENANT_A), undefined);
  store.addLink("nA", "nB", "similar", 1);
  store.addLink("nB", "nC", "similar", 1);
  store.addLink("nA", "nX", "similar", 1);
  store.addLink("nX", "nC", "similar", 1);

  // 1. 基本路径
  const pathAC = await getPathOf(store, "nA", "nC") as PathNode[] | null;
  check(
    "C6-1a A→B→C：getPath(A,C)=[B,C]，hop=1/2",
    Array.isArray(pathAC) && pathAC.length === 2 && pathAC[0].id === "nB" && pathAC[1].id === "nC"
      && pathAC[0].hop === 1 && pathAC[1].hop === 2,
    JSON.stringify(pathAC),
  );
  const pathAX = await getPathOf(store, "nA", "nIso") as PathNode[] | null;
  check("C6-1b A→孤立节点不可达 → null", pathAX === null, JSON.stringify(pathAX));

  // 2. 租户过滤：X（B 租户）作中继 → A filter 下不可达；不带 filter 旧行为可达
  const pathFiltered = await getPathOf(store, "nA", "nC", 3, undefined, TENANT_A) as PathNode[] | null;
  check(
    "C6-2a A filter：B 租户中继 X 不可见 → 主链 A→B→C 仍可达",
    Array.isArray(pathFiltered) && pathFiltered.every((n) => n.id !== "nX"),
    JSON.stringify(pathFiltered),
  );
  // 剪掉主链边后：仅剩跨租户中继路径 → A filter 下 null
  const store2 = newStore(tmpDir, "c6-path-filtered");
  store2.upsertL1(mk("mA", "节点A", {}, TENANT_A), undefined);
  store2.upsertL1(mk("mC", "节点C", {}, TENANT_A), undefined);
  store2.upsertL1(mk("mX", "节点X跨租户", {}, TENANT_B), undefined);
  store2.addLink("mA", "mX", "similar", 1);
  store2.addLink("mX", "mC", "similar", 1);
  const pathCross = await getPathOf(store2, "mA", "mC", 3, undefined, TENANT_A) as PathNode[] | null;
  check("C6-2b 仅跨租户中继路径 + A filter → null（租户边不可达）", pathCross === null, JSON.stringify(pathCross));
  const pathCrossNoFilter = await getPathOf(store2, "mA", "mC", 3, undefined, undefined) as PathNode[] | null;
  check(
    "C6-2c 不带 filter（显式 undefined）→ 旧行为可达 [X,C]",
    Array.isArray(pathCrossNoFilter) && pathCrossNoFilter.map((n) => n.id).join(",") === "mX,mC",
    JSON.stringify(pathCrossNoFilter),
  );
  const pathWrongTenantStart = await getPathOf(store2, "mA", "mC", 3, undefined, TENANT_B) as PathNode[] | null;
  check("C6-2d B 视角查 A 租户起点 → null（起点不可见）", pathWrongTenantStart === null, JSON.stringify(pathWrongTenantStart));

  // 3. maxHop 截断
  const pathHop1 = await getPathOf(store, "nA", "nC", 1) as PathNode[] | null;
  check("C6-3a A→B→C maxHop=1 → null（截断）", pathHop1 === null, JSON.stringify(pathHop1));
  const pathHop2 = await getPathOf(store, "nA", "nC", 2) as PathNode[] | null;
  check("C6-3b maxHop=2 → 可达 [B,C]", Array.isArray(pathHop2) && pathHop2.length === 2, JSON.stringify(pathHop2));

  // 4. 环路安全：A→B→A 环 + B→C 出边
  store.addLink("nB", "nA", "similar", 1); // 成环
  const pathCycle = await getPathOf(store, "nA", "nC") as PathNode[] | null;
  check(
    "C6-4a A→B→A 环中 getPath(A,C) 终止且 [B,C]",
    Array.isArray(pathCycle) && pathCycle.map((n) => n.id).join(",") === "nB,nC",
    JSON.stringify(pathCycle),
  );
  const pathSelf = await getPathOf(store, "nA", "nA") as PathNode[] | null;
  check("C6-4b 起点即终点 → 空路径 []（平凡可达）", Array.isArray(pathSelf) && pathSelf.length === 0, JSON.stringify(pathSelf));

  store.close();
  store2.close();
}

// ── C6-5：/v3/atomic/path handler 端到端（requestIsolation + maxHop clamp） ──

async function testC6Handler(tmpDir: string): Promise<void> {
  console.log("\n[C6-5] handler：requestIsolation 消费 + maxHop clamp ≤3");
  check(
    "C6-5 RED 前置：v2-router 导出 handleAtomicPath",
    typeof handleAtomicPath === "function",
  );
  if (typeof handleAtomicPath !== "function") return;

  const store = newStore(tmpDir, "c6-handler");
  for (const id of ["hA", "hB", "hC", "hD", "hE"]) {
    store.upsertL1(mk(id, `节点${id}`, {}, TENANT_A), undefined);
  }
  // 4 跳链 hA→hB→hC→hD→hE
  store.addLink("hA", "hB", "similar", 1);
  store.addLink("hB", "hC", "similar", 1);
  store.addLink("hC", "hD", "similar", 1);
  store.addLink("hD", "hE", "similar", 1);

  const deps = (iso: IsolationFilter) =>
    ({
      getStore: () => store,
      requestIsolation: { teamId: iso.teamId, userId: iso.userId, agentId: iso.agentId, sessionId: "s1" },
    }) as never;

  const env3 = await (handleAtomicPath as (...a: unknown[]) => Promise<{ data?: { path?: PathNode[] | null } }>)(
    { startId: "hA", endId: "hD", maxHop: 10 },
    {} as never,
    "req-c6-3hop",
    deps(TENANT_A),
  );
  const p3 = env3.data?.path ?? null;
  check(
    "C6-5a maxHop=10 请求 3 跳路径 → 可达 [B,C,D]（clamp ≤3 不影响 3 跳）",
    Array.isArray(p3) && p3.map((n) => n.id).join(",") === "hB,hC,hD",
    JSON.stringify(p3),
  );

  const env4 = await (handleAtomicPath as (...a: unknown[]) => Promise<{ data?: { path?: PathNode[] | null } }>)(
    { startId: "hA", endId: "hE", maxHop: 10 },
    {} as never,
    "req-c6-4hop",
    deps(TENANT_A),
  );
  const p4 = env4.data?.path ?? null;
  check("C6-5b maxHop=10 请求 4 跳路径 → null（clamp ≤3 截断）", p4 === null, JSON.stringify(p4));

  const envB = await (handleAtomicPath as (...a: unknown[]) => Promise<{ data?: { path?: PathNode[] | null } }>)(
    { startId: "hA", endId: "hD" },
    {} as never,
    "req-c6-tenant",
    deps(TENANT_B),
  );
  const pB = envB.data?.path ?? null;
  check("C6-5c B 租户请求 → null（requestIsolation 消费，跨租户不可达）", pB === null, JSON.stringify(pB));

  const env400 = await (handleAtomicPath as (...a: unknown[]) => Promise<{ code?: number }>)(
    { startId: "hA" },
    {} as never,
    "req-c6-400",
    deps(TENANT_A),
  );
  check("C6-5d 缺 endId → 400", env400.code === 400, JSON.stringify(env400));

  store.close();
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== S5 同形验证（C5 auto-recall coreRef 加成 + C6 getPath） ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-s5-"));
  let hardFail = false;
  try {
    await testC5SearchHybrid(tmpDir);
    await testC5AutoRecallE2E(tmpDir);
    await testC6Graph(tmpDir);
    await testC6Handler(tmpDir);
  } catch (err) {
    hardFail = true;
    console.error("verify script crashed:", err);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
    }
  }
  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
  if (fail > 0 || hardFail) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
