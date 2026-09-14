/**
 * Task T2 同形验证（阶段四第二波·TCVDB 大三项：图全套/归档桶/core 表，伴生 SQLite 模式）：
 *   T2-A 图全套：addLink/getNeighbors(filter)/getPath/deleteLinksFor/pruneOrphanLinks（契约测试）
 *   T2-B 归档桶：archiveL1/restoreL1/listArchived（tcvdb 侧删向量/FTS=删 doc；辅助表落伴生 sqlite）
 *   T2-C core 表：双租户隔离/upsert 幂等/valence 三方语义（对齐 verify-p2-t12 断言集）
 *   T2-D F7 收官：tcvdb 模式下 l1-writer update/merge 走 archiveL1，不再回退 deleteL1Batch 硬删
 *   T2-E fix1（审查 I-1/I-2/I-4）：restoreL1 degraded 守卫 / pruneOrphanLinks fail-safe /
 *           getL1ByIds(WithArchive) 接线契约 / 消费方 await 后邻居扩展冒烟
 *
 * 验证约束（brief）：无 tcvdb 本地实例 —— 同形验证 = mock/契约测试。
 * 用**真实 TcvdbMemoryStore** + 注入 FakeTcvdbClient（内存文档表，方法级契约对齐 TcvdbClient）
 * + **真实伴生 sqlite**（临时目录 tcvdb-aux.db，走生产 init() 打开建表）。辅助表 DDL/SQL 全部
 * 复用 sqlite.ts 既有实现（VectorStore dims=0 委托实例）——禁止第二份手写 SQL（R1 铁律）。
 * 关键断言组与 sqlite 后端**差分对齐**（[A12]/[C8]：同一场景跑 sqlite VectorStore 与 tcvdb
 * 后端，输出逐项比对）。真机实证登记为部署时任务（spec §6.4 先例）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-t2.ts
 *
 * 只用自建内存 fake + 临时目录 sqlite，不连任何线上资源（不碰 D:/tdai-data）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TcvdbMemoryStore } from "../src/core/store/tcvdb.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { TcvdbClient } from "../src/core/store/tcvdb-client.js";
import type { IsolationFilter, L1SearchResult } from "../src/core/store/types.js";
import { writeMemory } from "../src/core/record/l1-writer.js";
import type { DedupDecision, ExtractedMemory } from "../src/core/record/l1-writer.js";

// ── FakeTcvdbClient：内存文档表，方法级契约（对齐 verify-t1 形态 + deleteDoc/createDatabase）──
class FakeTcvdbClient {
  /** collection → (id → doc) */
  readonly collections = new Map<string, Map<string, Record<string, unknown>>>();
  failQuery = false;
  failUpsert = false;
  failDelete = false;
  upsertCalls: Array<{ collection: string; docs: Array<Record<string, unknown>> }> = [];
  deleteDocCalls: Array<{ collection: string; documentIds: string[] }> = [];

  collectionOf(name: string): Map<string, Record<string, unknown>> {
    let m = this.collections.get(name);
    if (!m) {
      m = new Map();
      this.collections.set(name, m);
    }
    return m;
  }

  seed(collection: string, doc: Record<string, unknown>): void {
    this.collectionOf(collection).set(String(doc.id), { ...doc });
  }

  doc(collection: string, id: string): Record<string, unknown> | undefined {
    const d = this.collectionOf(collection).get(id);
    return d ? { ...d } : undefined;
  }

  async createDatabase(): Promise<boolean> {
    // false = 已存在 —— 跳过 init 的 5s 等待（真实 TcvdbClient 契约：boolean）
    return false;
  }

  async createCollection(_params: Record<string, unknown>): Promise<void> {
    /* no-op */
  }

  async upsert(collection: string, documents: Array<Record<string, unknown>>): Promise<void> {
    if (this.failUpsert) throw new Error("fake upsert failure");
    this.upsertCalls.push({ collection, docs: documents });
    const m = this.collectionOf(collection);
    for (const doc of documents) m.set(String(doc.id), { ...doc });
  }

  async query(collection: string, params: Record<string, unknown>): Promise<{ documents: Array<Record<string, unknown>> }> {
    if (this.failQuery) throw new Error("fake query failure");
    const m = this.collectionOf(collection);
    let docs = [...m.values()];
    const ids = params.documentIds as string[] | undefined;
    if (ids) docs = docs.filter((d) => ids.includes(String(d.id)));
    const retrieveVector = params.retrieveVector === true;
    const outFields = params.outputFields as string[] | undefined;
    docs = docs.map((d) => {
      const copy: Record<string, unknown> = { ...d };
      if (!retrieveVector) delete copy.vector;
      if (outFields) {
        const filtered: Record<string, unknown> = {};
        for (const f of outFields) if (f in copy) filtered[f] = copy[f];
        if (retrieveVector && "vector" in copy) filtered.vector = copy.vector;
        return filtered;
      }
      return copy;
    });
    return { documents: docs };
  }

  async deleteDoc(collection: string, params: Record<string, unknown>): Promise<number> {
    if (this.failDelete) throw new Error("fake delete failure");
    const q = (params.query ?? {}) as { documentIds?: string[] };
    const ids = q.documentIds ?? [];
    this.deleteDocCalls.push({ collection, documentIds: [...ids] });
    const m = this.collectionOf(collection);
    let deleted = 0;
    for (const id of ids) if (m.delete(String(id))) deleted++;
    return deleted;
  }

  async count(collection: string): Promise<number> {
    return this.collectionOf(collection).size;
  }
}

const NOW_SEED_MS = Date.parse("2026-09-10T00:00:00Z");
const L1_COLLECTION = "verify_t2_l1_memories";

function seedDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m_t2_seed",
    text: "T2 契约测试种子记录",
    type: "episodic",
    priority: 70,
    scene_name: "verify-t2",
    team_id: "",
    user_id: "",
    agent_id: "",
    version: 0,
    session_key: "k",
    session_id: "verify-t2",
    task_id: "",
    timestamp_str: "2026-09-01T00:00:00Z",
    timestamp_start: "2026-09-01T00:00:00Z",
    timestamp_end: "2026-09-01T00:00:00Z",
    created_time_ms: NOW_SEED_MS,
    updated_time_ms: NOW_SEED_MS,
    metadata_json: "{}",
    memory_type: "default",
    occurred_at: "",
    valid_start: "",
    valid_end: "",
    certainty: "observed",
    source: "",
    valence: null,
    arousal: null,
    significance: null,
    vector: [0.1, 0.2, 0.3],
    ...over,
  };
}

/** 临时目录工作台（每段独立，测后清理） */
function makeTmpDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-t2-${tag}-`));
  return dir;
}

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** 用真实 TcvdbMemoryStore + 注入 fake client + 真实伴生 sqlite 构造被测实例（走真实 init）。 */
async function makeStore(
  fake: FakeTcvdbClient,
  opts: { tmpDir: string; embeddingEnabled?: boolean; auxPath?: string } ,
): Promise<TcvdbMemoryStore> {
  const auxPath = opts.auxPath ?? path.join(opts.tmpDir, "tcvdb-aux.db");
  const store = new TcvdbMemoryStore({
    url: "http://127.0.0.1:1",
    username: "root",
    apiKey: "verify-t2",
    database: "verify_t2",
    embeddingModel: "verify-model",
    timeout: 100,
    embeddingEnabled: opts.embeddingEnabled ?? true,
    auxPath,
  });
  const inner = store as unknown as { client: unknown };
  inner.client = fake as unknown as TcvdbClient;
  await store.init();
  return store;
}

/** sqlite 后端对照实例（dims=0：metadata/FTS-only 模式，辅助表语义同源） */
function makeSqliteStore(tmpDir: string): VectorStore {
  const store = new VectorStore(path.join(tmpDir, "sqlite-ref.db"), 0, quietLogger as never);
  store.init();
  return store;
}

const sortedById = (rows: Array<{ id: string }>): Array<{ id: string }> =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const neighborsSig = (rows: Array<{ id: string; type: string; strength: number; hop: number }>): string =>
  JSON.stringify(sortedById(rows.map((r) => ({ id: r.id, type: r.type, strength: r.strength, hop: r.hop }))));

// ═══════════════════════════════════════════════════════════════
// [A] T2-A 图全套
// ═══════════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] T2-A 图全套：addLink/getNeighbors(filter)/getPath/deleteLinksFor/pruneOrphanLinks");
console.log("=".repeat(72));

let aPass = false;
const aFailures: string[] = [];
const aCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) aFailures.push(name);
};

try {
  const tmpDir = makeTmpDir("graph");
  const fake = new FakeTcvdbClient();
  const store = await makeStore(fake, { tmpDir });

  // 租户文档种子（A7/A11 filter 用）：a,c,d ∈ teamA；b ∈ teamB
  fake.seed(L1_COLLECTION, seedDoc({ id: "ga", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "节点a" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "gb", team_id: "teamB", user_id: "uB", agent_id: "agB", text: "节点b" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "gc", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "节点c" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "gd", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "节点d" }));

  // A1 建边（幂等性在 A6 验证）
  aCheck("A1 addLink 返回 true", (await store.addLink!("ga", "gb", "similar", 0.9)) === true
    && (await store.addLink!("ga", "gc", "part_of", 1)) === true
    && (await store.addLink!("gc", "gd", "similar", 0.8)) === true);

  // A2 邻接（双向）：ga → {gb(出), gc(出)}；gc 的入边在 gc 视角
  const nb1 = await store.getNeighbors!("ga", undefined, 1);
  aCheck("A2 getNeighbors(a,1) = {gb, gc}", neighborsSig(nb1) === neighborsSig([
    { id: "gb", type: "similar", strength: 0.9, hop: 1 },
    { id: "gc", type: "part_of", strength: 1, hop: 1 },
  ]), neighborsSig(nb1));

  // A3 BFS maxHop=2：ga → gc → gd
  const nb2 = await store.getNeighbors!("ga", undefined, 2);
  aCheck("A3 getNeighbors(a,2) 含 gd（hop=2）", nb2.some((r) => r.id === "gd" && r.hop === 2), neighborsSig(nb2));

  // A4 types 过滤
  const nbT = await store.getNeighbors!("ga", ["part_of"], 2);
  aCheck("A4 types=[part_of] → 只剩 gc（gd 经 similar 边被滤）", neighborsSig(nbT) === neighborsSig([
    { id: "gc", type: "part_of", strength: 1, hop: 1 },
  ]), neighborsSig(nbT));

  // A5 环路安全：a→b→a 死循环不发生（双向边扩展下 maxHop 大值快速终止）
  await store.addLink!("gb", "ga", "similar", 0.9);
  const t0 = Date.now();
  const nbCycle = await store.getNeighbors!("ga", undefined, 5);
  aCheck("A5 环路安全：maxHop=5 终止且不含重复", Date.now() - t0 < 2000 && nbCycle.filter((r) => r.id === "gb").length === 1, neighborsSig(nbCycle));

  // A6 幂等建边：同 (s,t,type) 重复建边更新强度
  await store.addLink!("ga", "gb", "similar", 0.5);
  const nb6 = await store.getNeighbors!("ga", ["similar"], 1);
  aCheck("A6 幂等：仍一条 similar 边且强度更新为 0.5", nb6.filter((r) => r.id === "gb").length === 1
    && nb6.find((r) => r.id === "gb")?.strength === 0.5, neighborsSig(nb6));

  // A7 租户过滤（T14 两步过滤模式）：teamA 视角只见 gc，gb(teamB) 被剪
  const nbF = await store.getNeighbors!("ga", undefined, 1, { teamId: "teamA", userId: "uA", agentId: "agA" } as IsolationFilter);
  aCheck("A7 filter=teamA → 只见 gc（跨租户 gb 剪枝）", neighborsSig(nbF) === neighborsSig([
    { id: "gc", type: "part_of", strength: 1, hop: 1 },
  ]), neighborsSig(nbF));

  // A8 宁缺毋滥：指向不存在记录的边，filter 传入时丢弃（无 filter 时保留——旧行为）
  await store.addLink!("ga", "gx", "similar", 0.7);
  const nbGhostNoF = await store.getNeighbors!("ga", undefined, 1);
  const nbGhostF = await store.getNeighbors!("ga", undefined, 1, { teamId: "teamA", userId: "uA", agentId: "agA" } as IsolationFilter);
  aCheck("A8 无 filter 含 gx（旧行为兼容）", nbGhostNoF.some((r) => r.id === "gx"));
  aCheck("A8 filter 丢弃 gx（行不存在=租户不可验证）", !nbGhostF.some((r) => r.id === "gx"), neighborsSig(nbGhostF));

  // A9 deleteLinksFor：级联删某节点全部边
  aCheck("A9 deleteLinksFor(gc) 返回 true", (await store.deleteLinksFor!("gc")) === true);
  const nb9 = await store.getNeighbors!("ga", undefined, 2);
  aCheck("A9 删后 ga 邻域无 gc/gd", !nb9.some((r) => r.id === "gc" || r.id === "gd"), neighborsSig(nb9));

  // A10 pruneOrphanLinks：硬删端点的边清掉；归档端点的边保留（归档可解析证据链）
  fake.seed(L1_COLLECTION, seedDoc({ id: "gp", text: "将被硬删的节点" }));
  await store.addLink!("ga", "gp", "similar", 0.6);
  await store.deleteL1("gp"); // 硬删 tcvdb doc（辅助表边仍在）
  const pruned = await store.pruneOrphanLinks!();
  // ga→gx（A8 幽灵边）+ ga→gp 两条孤儿边（sqlite 语义：任一端点消失即孤儿）
  aCheck("A10 硬删端点 → 剪掉孤儿边（返回 changes 数=2）", pruned === 2, `got ${String(pruned)}`);
  const nb10 = await store.getNeighbors!("ga", undefined, 1);
  aCheck("A10 剪后 ga 邻域无 gp", !nb10.some((r) => r.id === "gp"), neighborsSig(nb10));
  // 归档端点的边保留：archive gc 后其边仍可解析（审计 B3 语义）
  fake.seed(L1_COLLECTION, seedDoc({ id: "gc2", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "将归档节点" }));
  await store.addLink!("ga", "gc2", "similar", 0.6);
  await store.archiveL1!("gc2", "test-archive");
  const pruned2 = await store.pruneOrphanLinks!();
  const nb10b = await store.getNeighbors!("ga", undefined, 1);
  aCheck("A10 归档端点边保留（prune 返回 0）", pruned2 === 0 && nb10b.some((r) => r.id === "gc2"), `pruned=${String(pruned2)} nb=${neighborsSig(nb10b)}`);

  // A11 getPath（C6）：直达/两跳/不可达/平凡/租户过滤
  fake.seed(L1_COLLECTION, seedDoc({ id: "pa", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "pa" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "pb", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "pb" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "pd", team_id: "teamA", user_id: "uA", agent_id: "agA", text: "pd" }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "px", team_id: "teamB", user_id: "uB", agent_id: "agB", text: "px" }));
  await store.addLink!("pa", "pb", "similar", 0.9);
  await store.addLink!("pb", "pd", "similar", 0.8);
  await store.addLink!("pb", "px", "similar", 0.7);
  const p2 = await store.getPath!("pa", "pd", 3);
  aCheck("A11 两跳路径 [pb,pd]（hop 1,2）", p2 !== null && JSON.stringify(p2.map((r) => [r.id, r.hop])) === JSON.stringify([["pb", 1], ["pd", 2]]),
    JSON.stringify(p2));
  const p0 = await store.getPath!("pa", "pa", 3);
  aCheck("A11 起点即终点 → []（平凡可达）", Array.isArray(p0) && p0.length === 0, JSON.stringify(p0));
  const pN = await store.getPath!("pd", "pa", 3);
  // sqlite getPath 双向边扩展（source/target UNION）：反向 pd→pb→pa 可达（对齐 sqlite 语义）
  aCheck("A11 反向可达（双向边扩展，对齐 sqlite）路径 [pb,pa]",
    pN !== null && pN.map((r) => r.id).join(",") === "pb,pa", JSON.stringify(pN));
  const pF = await store.getPath!("pa", "pd", 3, undefined, { teamId: "teamA", userId: "uA", agentId: "agA" } as IsolationFilter);
  aCheck("A11 同租户 filter 路径仍通", pF !== null && pF.map((r) => r.id).join(",") === "pb,pd", JSON.stringify(pF));
  // 跨租户中转被剪：pa→pb(teamA)→px(teamB)；target=px 不可达
  const pXF = await store.getPath!("pa", "px", 3, undefined, { teamId: "teamA", userId: "uA", agentId: "agA" } as IsolationFilter);
  aCheck("A11 跨租户终点 filter → null", pXF === null, JSON.stringify(pXF));

  // A12 差分对齐：同一图场景跑 sqlite 后端与 tcvdb 后端，邻接/路径输出逐项一致
  {
    const refDir = makeTmpDir("graph-ref");
    const ref = makeSqliteStore(refDir);
    // sqlite 侧行（供 filter 复核）+ 同款边
    const rec = (id: string, teamId: string, userId: string, agentId: string) => ({
      id, content: `节点${id}`, type: "episodic" as const, priority: 70, scene_name: "verify-t2",
      source_message_ids: [], metadata: {}, timestamps: ["2026-09-01T00:00:00Z"],
      createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", version: 0,
      sessionKey: "k", sessionId: "verify-t2", teamId, userId, agentId,
    });
    ref.upsertL1(rec("ra", "teamA", "uA", "agA") as never);
    ref.upsertL1(rec("rb", "teamB", "uB", "agB") as never);
    ref.upsertL1(rec("rc", "teamA", "uA", "agA") as never);
    ref.addLink("ra", "rb", "similar", 0.9);
    ref.addLink("ra", "rc", "part_of", 1);
    const refNbNoF = ref.getNeighbors("ra", undefined, 1);
    const refNbF = ref.getNeighbors("ra", undefined, 1, { teamId: "teamA", userId: "uA", agentId: "agA" });
    // tcvdb 侧同构场景
    const tDir = makeTmpDir("graph-t");
    const tFake = new FakeTcvdbClient();
    tFake.seed(L1_COLLECTION, seedDoc({ id: "ra", team_id: "teamA", user_id: "uA", agent_id: "agA" }));
    tFake.seed(L1_COLLECTION, seedDoc({ id: "rb", team_id: "teamB", user_id: "uB", agent_id: "agB" }));
    tFake.seed(L1_COLLECTION, seedDoc({ id: "rc", team_id: "teamA", user_id: "uA", agent_id: "agA" }));
    const tStore = await makeStore(tFake, { tmpDir: tDir });
    await tStore.addLink!("ra", "rb", "similar", 0.9);
    await tStore.addLink!("ra", "rc", "part_of", 1);
    const tNbNoF = await tStore.getNeighbors!("ra", undefined, 1);
    const tNbF = await tStore.getNeighbors!("ra", undefined, 1, { teamId: "teamA", userId: "uA", agentId: "agA" } as IsolationFilter);
    aCheck("A12 差分：无 filter 邻接与 sqlite 逐项一致", neighborsSig(tNbNoF) === neighborsSig(refNbNoF),
      `tcvdb=${neighborsSig(tNbNoF)} sqlite=${neighborsSig(refNbNoF)}`);
    aCheck("A12 差分：filter 邻接与 sqlite 逐项一致（T14 两步过滤同语义）", neighborsSig(tNbF) === neighborsSig(refNbF),
      `tcvdb=${neighborsSig(tNbF)} sqlite=${neighborsSig(refNbF)}`);
    ref.close();
    tStore.close();
    for (const d of [refDir, tDir]) fs.rmSync(d, { recursive: true, force: true });
  }

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  aPass = aFailures.length === 0;
  console.log(aPass ? "[A] PASS" : `[A] FAIL（${aFailures.length} 项）`);
} catch (err) {
  console.log(`[A] FAIL（异常，RED 阶段典型）: ${err instanceof Error ? err.message : String(err)}`);
  aFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// [B] T2-B 归档桶
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[B] T2-B 归档桶：archiveL1（删向量/doc，留归档行）/restoreL1/listArchived");
console.log("=".repeat(72));

let bPass = false;
const bFailures: string[] = [];
const bCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) bFailures.push(name);
};

try {
  const tmpDir = makeTmpDir("archive");
  const fake = new FakeTcvdbClient();
  const soul = { occurred_at: "2026-08-01T08:00:00Z", valid_start: "2026-08-01T00:00:00Z", valid_end: "2026-08-02T00:00:00Z", certainty: "observed", source: "msg-42", valence: 0.6, arousal: 0.3, significance: 0.9 };
  const createdMs = NOW_SEED_MS - 86_400_000;
  const updatedMs = NOW_SEED_MS - 3_600_000;
  fake.seed(L1_COLLECTION, seedDoc({
    id: "m1", text: "待归档记忆", metadata_json: JSON.stringify({ recall_count: 2 }),
    created_time_ms: createdMs, updated_time_ms: updatedMs, ...soul,
  }));
  fake.seed(L1_COLLECTION, seedDoc({ id: "m2", text: "邻居记忆" }));
  const store = await makeStore(fake, { tmpDir });

  // B1 archive：返回 true；tcvdb 侧向量/doc 删除（检索面消失）；辅助表归档行在
  bCheck("B1 archiveL1 返回 true", (await store.archiveL1!("m1", "forgetting")) === true);
  bCheck("B1 tcvdb doc 已删（检索面消失）", fake.doc(L1_COLLECTION, "m1") === undefined);
  bCheck("B1 tcvdb 侧 deleteDoc 恰好 1 次（删向量=删 doc）", fake.deleteDocCalls.filter((c) => c.documentIds.includes("m1")).length === 1);
  const archived = await store.listArchived!(10, 0);
  bCheck("B1 listArchived 1 行，content/reason 正确（json_extract 逐字复用）",
    archived.length === 1 && archived[0].record_id === "m1" && archived[0].content === "待归档记忆" && archived[0].reason === "forgetting",
    JSON.stringify(archived));

  // B2 归档不级联删边（审计 B3 语义）：先建边再归档，边仍在
  await store.addLink!("m1", "m2", "similar", 0.7);
  const nbB2 = await store.getNeighbors!("m2", undefined, 1);
  bCheck("B2 归档后边保留（指向归档记录合法）", nbB2.some((r) => r.id === "m1"), neighborsSig(nbB2));

  // B3 archive 不存在的 id → false
  bCheck("B3 archive 不存在 id → false", (await store.archiveL1!("m_missing")) === false);

  // B4 restore：回读 tcvdb（全字段 roundtrip）；归档行清空；重复 restore → false
  fake.seed(L1_COLLECTION, seedDoc({ id: "m1" })); // 清掉再走 restore 流程外无影响；m1 已不在
  fake.collectionOf(L1_COLLECTION).delete("m1");
  bCheck("B4 restoreL1 返回 true", (await store.restoreL1!("m1")) === true);
  const doc = fake.doc(L1_COLLECTION, "m1");
  bCheck("B4 tcvdb doc 回读（content/type/priority）", doc !== undefined && doc.text === "待归档记忆" && doc.type === "episodic" && Number(doc.priority) === 70,
    JSON.stringify(doc ? { text: doc.text, type: doc.type } : null));
  bCheck("B4 created/updated 时间戳 roundtrip", doc !== undefined && Number(doc.created_time_ms) === createdMs && Number(doc.updated_time_ms) === updatedMs,
    `got ${String(doc?.created_time_ms)}/${String(doc?.updated_time_ms)}`);
  bCheck("B4 soul 8 字段 roundtrip", doc !== undefined
    && doc.occurred_at === soul.occurred_at && doc.certainty === soul.certainty && doc.source === soul.source
    && Number(doc.valence) === soul.valence && Number(doc.arousal) === soul.arousal && Number(doc.significance) === soul.significance,
    JSON.stringify(doc ? { occurred_at: doc.occurred_at, valence: doc.valence } : null));
  bCheck("B4 metadata roundtrip（recall_count 保留）", doc !== undefined && String(doc.metadata_json).includes("recall_count"));
  bCheck("B4 归档行已清空", (await store.listArchived!(10, 0)).length === 0);
  bCheck("B4 重复 restore → false（已不在归档）", (await store.restoreL1!("m1")) === false);
  bCheck("B4 restore 后向量/doc 存在（检索面恢复）", fake.doc(L1_COLLECTION, "m1") !== undefined);

  // B5 restore 不存在的 id → false（不抛）
  bCheck("B5 restore 不存在 id → false", (await store.restoreL1!("m_missing")) === false);

  // B6 archive 失败容错：tcvdb 删除失败 → 返回 false 且归档行回滚补偿（不留半态）
  {
    const tmpDir6 = makeTmpDir("archive-fail");
    const fake6 = new FakeTcvdbClient();
    fake6.seed(L1_COLLECTION, seedDoc({ id: "mf", text: "删除会失败的记忆" }));
    const store6 = await makeStore(fake6, { tmpDir: tmpDir6 });
    fake6.failDelete = true;
    const ok6 = await store6.archiveL1!("mf", "forgetting");
    const listed6 = await store6.listArchived!(10, 0);
    bCheck("B6 tcvdb 删除失败 → false", ok6 === false, `got ${String(ok6)}`);
    bCheck("B6 失败后归档桶干净（补偿回滚，不留半态）", listed6.length === 0, JSON.stringify(listed6));
    store6.close();
    fs.rmSync(tmpDir6, { recursive: true, force: true });
  }

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  bPass = bFailures.length === 0;
  console.log(bPass ? "[B] PASS" : `[B] FAIL（${bFailures.length} 项）`);
} catch (err) {
  console.log(`[B] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  bFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// [C] T2-C core 表（双租户/幂等/valence；差分对齐 sqlite）
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[C] T2-C core 表：双租户隔离/upsert 幂等/valence 三方语义（对齐 verify-p2-t12 断言集）");
console.log("=".repeat(72));

let cPass = false;
const cFailures: string[] = [];
const cCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) cFailures.push(name);
};

try {
  const tmpDir = makeTmpDir("core");
  const store = await makeStore(new FakeTcvdbClient(), { tmpDir });
  const tA = { teamId: "teamA", userId: "uA", agentId: "agA" };
  const tB = { teamId: "teamB", userId: "uB", agentId: "agB" };

  // C1 双租户写读隔离（同 slot 并存）
  cCheck("C1 upsertCore teamA true", (await store.upsertCore!("identity", "A 的人格", "agent", tA)) === true);
  cCheck("C1 upsertCore teamB true（同 slot 并存）", (await store.upsertCore!("identity", "B 的人格", "agent", tB)) === true);
  const coreA = await store.readCore!(tA);
  const coreB = await store.readCore!(tB);
  cCheck("C1 teamA 只读自己的 slot/content", coreA.length === 1 && coreA[0].slot === "identity" && coreA[0].content === "A 的人格", JSON.stringify(coreA));
  cCheck("C1 teamB 只读自己的 slot/content", coreB.length === 1 && coreB[0].content === "B 的人格", JSON.stringify(coreB));
  cCheck("C1 缺省=default 桶（读不到 teamA 的行）", (await store.readCore!()).length === 0);

  // C2 upsert 幂等：同 (slot,tenant) version 递增
  await store.upsertCore!("identity", "A 的人格 v2", "agent", tA);
  const coreA2 = await store.readCore!(tA);
  cCheck("C2 同 (slot,tenant) 重写 → version=2、content 更新", coreA2.length === 1 && coreA2[0].version === 2 && coreA2[0].content === "A 的人格 v2", JSON.stringify(coreA2));

  // C3 valence：显式传入写入；clamp [-1,1]；未传冲突不触碰
  cCheck("C3 upsertValue teamA true", (await store.upsertValue!("v1", "正确", 0.8, "agent", tA, 1)) === true);
  cCheck("C3 clamp 上界：valence=5 → 1", (await store.upsertValue!("v2", "越界", 0.5, "agent", tA, 5)) === true
    && (await store.listValues!(tA)).find((v) => v.value_id === "v2")?.valence === 1);
  cCheck("C3 clamp 下界+round：valence=-1.4 → -1", (await store.upsertValue!("v3", "负向", 0.5, "agent", tA, -1.4)) === true
    && (await store.listValues!(tA)).find((v) => v.value_id === "v3")?.valence === -1);
  await store.upsertValue!("v1", "正确", 0.9, "agent", tA); // 未传 valence 的冲突 upsert
  cCheck("C3 冲突未传 valence → 原值保留（微调/LLM 值不被 plain upsert 重置）",
    (await store.listValues!(tA)).find((v) => v.value_id === "v1")?.valence === 1);

  // C4 listValues weight DESC + 租户隔离
  const vals = await store.listValues!(tA);
  cCheck("C4 listValues weight 降序", vals.length === 3 && vals[0].weight >= vals[1].weight && vals[1].weight >= vals[2].weight, JSON.stringify(vals.map((v) => v.weight)));
  cCheck("C4 teamB 读空（租户隔离）", (await store.listValues!(tB)).length === 0);

  // C5 deleteValue：真删一行 true；再删 false；跨租户不受影响
  cCheck("C5 deleteValue teamA v3 → true", (await store.deleteValue!("v3", tA)) === true);
  cCheck("C5 再删 → false（不存在）", (await store.deleteValue!("v3", tA)) === false);
  await store.upsertValue!("v3", "B 的同 id 价值", 0.5, "agent", tB);
  cCheck("C5 teamA 删除不影响 teamB 同 id 行", (await store.listValues!(tB)).some((v) => v.value_id === "v3"));

  // C6 reset/restore valences（apply-after-success 语义）
  const snapshot = await store.resetValueValences!(tA);
  cCheck("C6 reset 返回快照（2 个非 NULL 行）且行置 NULL", snapshot.length === 2
    && (await store.listValues!(tA)).every((v) => v.valence === null), JSON.stringify(snapshot));
  // LLM 窗口内用户微调 v1
  await store.upsertValue!("v1", "正确", 0.9, "agent", tA, -1);
  const restored = await store.restoreValueValences!(tA, snapshot);
  cCheck("C6 restore 恢复未微调行（1 行），微调行 v1 保持 -1（valence IS NULL 守卫）",
    restored === 1 && (await store.listValues!(tA)).find((v) => v.value_id === "v1")?.valence === -1
    && (await store.listValues!(tA)).find((v) => v.value_id === "v2")?.valence === 1,
    `restored=${String(restored)}`);

  // C7 deriveValueValences 委托：只判 NULL 行、写回守卫（C2 语义同源）
  {
    await store.upsertValue!("v9", "安全", 0.5, "agent", tA); // 新建 valence=NULL
    const runner = { run: async () => JSON.stringify({ valences: [{ value_id: "v9", valence: -1 }, { value_id: "v1", valence: 1 }, { value_id: "ghost", valence: 0 }] }) };
    const r = await store.deriveValueValences!(tA, runner);
    const list = await store.listValues!(tA);
    cCheck("C7 derive 只判 NULL 行：v9=-1、微调 v1 不被覆盖、幻觉 id 拒写",
      r.derived === 1 && list.find((v) => v.value_id === "v9")?.valence === -1 && list.find((v) => v.value_id === "v1")?.valence === -1,
      JSON.stringify(r));
  }

  // C8 差分对齐：全新 tcvdb 伴生库与全新 sqlite 后端跑**完全相同**的 core 操作序列，
  // readCore/listValues 输出逐项一致（语义=sqlite 逐字对齐的最终证据）
  {
    const refDir = makeTmpDir("core-ref");
    const tDir8 = makeTmpDir("core-t");
    const ref = makeSqliteStore(refDir);
    const tStore8 = await makeStore(new FakeTcvdbClient(), { tmpDir: tDir8 });
    const ops = async (core: {
      upsertCore(slot: string, content: string, source: string, tenant?: typeof tA | typeof tB): Promise<boolean> | boolean;
      upsertValue(valueId: string, label: string, weight: number, createdBy: string, tenant?: typeof tA | typeof tB, valence?: number): Promise<boolean> | boolean;
    }) => {
      await core.upsertCore("identity", "A 的人格", "agent", tA);
      await core.upsertCore("identity", "A 的人格 v2", "agent", tA);
      await core.upsertCore("identity", "B 的人格", "agent", tB);
      await core.upsertValue("v1", "正确", 0.8, "agent", tA, 1);
      await core.upsertValue("v2", "越界", 0.5, "agent", tA, 5); // clamp → 1
      await core.upsertValue("v2", "越界2", 0.6, "agent", tA);   // 冲突未传 valence → 保留 1
    };
    await ops(ref);
    await ops(tStore8);
    const sigCore = (rows: Array<{ slot: string; content: string; version: number }>) =>
      JSON.stringify([...rows].sort((a, b) => (a.slot < b.slot ? -1 : 1)).map((r) => [r.slot, r.content, r.version]));
    const sigVals = (rows: Array<{ value_id: string; label: string; weight: number; valence: number | null }>) =>
      JSON.stringify([...rows].sort((a, b) => (a.value_id < b.value_id ? -1 : 1)).map((r) => [r.value_id, r.label, r.weight, r.valence]));
    const tCore = await tStore8.readCore!(tA);
    const tVals = await tStore8.listValues!(tA);
    const refCore = ref.readCore(tA);
    const refVals = ref.listValues(tA);
    cCheck("C8 差分：readCore 与 sqlite 逐项一致", sigCore(tCore) === sigCore(refCore), `${sigCore(tCore)} vs ${sigCore(refCore)}`);
    cCheck("C8 差分：listValues（含 valence clamp/保留）与 sqlite 逐项一致", sigVals(tVals) === sigVals(refVals), `${sigVals(tVals)} vs ${sigVals(refVals)}`);
    ref.close();
    tStore8.close();
    fs.rmSync(refDir, { recursive: true, force: true });
    fs.rmSync(tDir8, { recursive: true, force: true });
  }

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  cPass = cFailures.length === 0;
  console.log(cPass ? "[C] PASS" : `[C] FAIL（${cFailures.length} 项）`);
} catch (err) {
  console.log(`[C] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  cFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// [D] T2-D F7 收官：tcvdb 模式下 l1-writer 不再走 deleteL1Batch 硬删 fallback
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[D] T2-D F7 收官：l1-writer update/merge → archiveL1 必然成功，硬删 fallback 不触发");
console.log("=".repeat(72));

let dPass = false;
const dFailures: string[] = [];
const dCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) dFailures.push(name);
};

try {
  const memory: ExtractedMemory = {
    content: "用户偏好简洁回复",
    type: "preference",
    priority: 60,
    source_message_ids: ["msg-1"],
    metadata: {},
    scene_name: "verify-t2",
    certainty: "observed",
  };
  const decision: DedupDecision = {
    record_id: "m_new",
    action: "update",
    target_ids: ["m_target_1", "m_target_2"],
    merged_content: "用户偏好简洁回复（更新版）",
  };
  const baseDir = makeTmpDir("f7");

  // D1：tcvdb 后端（T2 后）——archive 全成功，零硬删
  {
    const tmpDir = makeTmpDir("f7-tcvdb");
    const fake = new FakeTcvdbClient();
    fake.seed(L1_COLLECTION, seedDoc({ id: "m_target_1", text: "旧目标 1", version: 1 }));
    fake.seed(L1_COLLECTION, seedDoc({ id: "m_target_2", text: "旧目标 2", version: 1 }));
    const store = await makeStore(fake, { tmpDir });
    await writeMemory({ memory, decision, baseDir, sessionKey: "k", sessionId: "verify-t2", vectorStore: store as never, logger: quietLogger as never });
    const archived = await store.listArchived!(10, 0);
    dCheck("D1 两个旧目标全部 archive（无 fallback）", archived.length === 2
      && archived.every((r) => r.reason === "dedup-update"), JSON.stringify(archived.map((r) => r.record_id)));
    dCheck("D1 零 deleteL1Batch 硬删（deleteDoc 调用恰为 2 次 archive 删除）",
      fake.deleteDocCalls.length === 2, JSON.stringify(fake.deleteDocCalls));
    dCheck("D1 新记录已 upsert 进 tcvdb", fake.doc(L1_COLLECTION, "m_new") !== undefined
      && fake.doc(L1_COLLECTION, "m_new")?.text === "用户偏好简洁回复（更新版）");
    dCheck("D1 归档行 content 指向旧目标", archived.some((r) => r.record_id === "m_target_1" && r.content === "旧目标 1"));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // D2：负控制——不支持 archive 的旧后端（feature-detect）仍走硬删 fallback（防御分支保留）
  {
    const legacyCalls: string[] = [];
    const legacyStore: Record<string, unknown> = {
      isDegraded: () => false,
      getCapabilities: () => ({ vectorSearch: false, ftsSearch: false }),
      queryL1Records: async (filter: { recordIds?: string[] }) => (filter.recordIds ?? []).map((id) => ({
        record_id: id, content: "旧", type: "episodic", priority: 1, scene_name: "", session_key: "", session_id: "",
        task_id: "", team_id: "", user_id: "", agent_id: "", version: 1, timestamp_str: "", timestamp_start: "",
        timestamp_end: "", created_time: "", updated_time: "", metadata_json: "{}",
      })),
      upsertL1: async () => true,
      deleteL1Batch: async (ids: string[]) => { legacyCalls.push(...ids); return true; },
      // 无 archiveL1 —— 旧后端形态
    };
    await writeMemory({ memory, decision, baseDir, sessionKey: "k", sessionId: "verify-t2", vectorStore: legacyStore as never, logger: quietLogger as never });
    dCheck("D2 负控制：无 archiveL1 的后端仍 fallback 硬删（防御分支保留）",
      legacyCalls.length === 2 && legacyCalls.includes("m_target_1") && legacyCalls.includes("m_target_2"), JSON.stringify(legacyCalls));
  }

  fs.rmSync(baseDir, { recursive: true, force: true });
  dPass = dFailures.length === 0;
  console.log(dPass ? "[D] PASS" : `[D] FAIL（${dFailures.length} 项）`);
} catch (err) {
  console.log(`[D] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  dFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// [E] fix1（审查 I-1/I-2/I-4）：restoreL1 degraded 守卫 / prune fail-safe /
//     getL1ByIds(WithArchive) 契约 / 消费方 await 后邻居扩展冒烟
// ═══════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(72));
console.log("[E] fix1：restoreL1 degraded 守卫 / pruneOrphanLinks fail-safe / getL1ByIds(WithArchive) 契约 / 邻居扩展冒烟");
console.log("=".repeat(72));

let ePass = false;
const eFailures: string[] = [];
const eCheck = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) eFailures.push(name);
};

try {
  // E1 restoreL1 degraded 守卫（I-1）：degraded 下 restore → false 且归档行保留
  // （无守卫时 upsertL1 静默 true ⇒ 消费归档行+删中转行+tcvdb 写入跳过 = 记录双消失）
  {
    const tmpDir = makeTmpDir("fix1-degraded");
    const fake = new FakeTcvdbClient();
    fake.seed(L1_COLLECTION, seedDoc({ id: "dg", text: "degraded 守卫测试记忆" }));
    const store = await makeStore(fake, { tmpDir });
    eCheck("E1 前置 archiveL1 成功", (await store.archiveL1!("dg", "forgetting")) === true);
    (store as unknown as { degraded: boolean }).degraded = true; // 直设内部旗标模拟 init 后故障
    eCheck("E1 degraded 下 restoreL1 → false", (await store.restoreL1!("dg")) === false);
    const stillArchived = await store.listArchived!(10, 0);
    eCheck("E1 归档行保留（未被消费 = 记录不双消失）",
      stillArchived.length === 1 && stillArchived[0].record_id === "dg" && stillArchived[0].content === "degraded 守卫测试记忆",
      JSON.stringify(stillArchived));
    (store as unknown as { degraded: boolean }).degraded = false;
    eCheck("E1 解除 degraded 后 restore → true（守卫只拦 degraded 态）", (await store.restoreL1!("dg")) === true);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // E2 pruneOrphanLinks fail-safe（I-2）：_fetchLiveL1Rows 异常 → -1 放弃本轮，零删边
  {
    const tmpDir = makeTmpDir("fix1-prune");
    const fake = new FakeTcvdbClient();
    fake.seed(L1_COLLECTION, seedDoc({ id: "p1", text: "prune 节点1" }));
    fake.seed(L1_COLLECTION, seedDoc({ id: "p2", text: "prune 节点2" }));
    const store = await makeStore(fake, { tmpDir });
    await store.addLink!("p1", "p2", "similar", 0.9);
    await store.addLink!("p1", "ghost", "similar", 0.5); // 一条真孤儿边（ghost 无行）
    fake.failQuery = true; // 注入实时行解析异常（HTTP query 全挂）
    const pruned = await store.pruneOrphanLinks!();
    eCheck("E2 实时行解析失败 → -1（放弃本轮，绝不全量删）", pruned === -1, `got ${String(pruned)}`);
    const nbDuringFail = await store.getNeighbors!("p1", undefined, 1); // 无 filter 委托 aux BFS，不经 tcvdb query
    eCheck("E2 零删边（故障期间边全部保留）", nbDuringFail.some((r) => r.id === "p2") && nbDuringFail.some((r) => r.id === "ghost"), neighborsSig(nbDuringFail));
    fake.failQuery = false;
    const pruned2 = await store.pruneOrphanLinks!();
    eCheck("E2 恢复后 prune 正常：只剪 ghost 孤儿边（返回 1）", pruned2 === 1, `got ${String(pruned2)}`);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // E3 getL1ByIds / getL1ByIdsWithArchive 契约（I-4）：形状对齐 sqlite，含归档回退
  {
    const tmpDir = makeTmpDir("fix1-byids");
    const fake = new FakeTcvdbClient();
    fake.seed(L1_COLLECTION, seedDoc({ id: "b1", text: "实时行b1", team_id: "tA", occurred_at: "2026-08-01T00:00:00Z", valence: 0.5 }));
    fake.seed(L1_COLLECTION, seedDoc({ id: "b2", text: "实时行b2" }));
    const store = await makeStore(fake, { tmpDir });
    const live = await store.getL1ByIds!(["b1", "b2", "b_missing"]);
    eCheck("E3 getL1ByIds 只回实时行（缺行不报错不编造）",
      live.length === 2 && live.every((r) => r.record_id === "b1" || r.record_id === "b2"), JSON.stringify(live.map((r) => r.record_id)));
    const b1 = live.find((r) => r.record_id === "b1");
    eCheck("E3 行形状对齐 sqlite（content/score=0/team_id/soul 字段）",
      b1 !== undefined && b1.content === "实时行b1" && b1.score === 0 && b1.team_id === "tA" && b1.valence === 0.5 && b1.occurred_at === "2026-08-01T00:00:00Z",
      JSON.stringify(b1));
    eCheck("E3 前置 archiveL1(b2) 成功", (await store.archiveL1!("b2", "evolve")) === true);
    eCheck("E3 归档后 getL1ByIds 查不到 b2（实时面消失）", (await store.getL1ByIds!(["b2"])).length === 0);
    const withArc = await store.getL1ByIdsWithArchive!(["b1", "b2", "b_ghost"]);
    eCheck("E3 WithArchive = 实时(b1) + 归档回退(b2)，ghost 不编造",
      withArc.length === 2 && withArc.some((r) => r.record_id === "b1" && r.content === "实时行b1") && withArc.some((r) => r.record_id === "b2" && r.content === "实时行b2"),
      JSON.stringify(withArc.map((r) => r.record_id)));
    eCheck("E3 空入参 → []", (await store.getL1ByIds!([])).length === 0 && (await store.getL1ByIdsWithArchive!([])).length === 0);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // E4 消费方 await 后 tcvdb 邻居扩展冒烟（I-4）：复刻 memory-search.ts 图邻居扩展
  // 消费形态（feature-detect + await MaybePromise），对 tcvdb 后端跑通全链（含归档回退）。
  {
    const tmpDir = makeTmpDir("fix1-expand");
    const fake = new FakeTcvdbClient();
    fake.seed(L1_COLLECTION, seedDoc({ id: "s1", text: "种子记忆" }));
    fake.seed(L1_COLLECTION, seedDoc({ id: "n1", text: "邻居记忆(实时)" }));
    fake.seed(L1_COLLECTION, seedDoc({ id: "n2", text: "邻居记忆(已归档)" }));
    const store = await makeStore(fake, { tmpDir });
    await store.addLink!("s1", "n1", "similar", 0.9);
    await store.addLink!("s1", "n2", "similar", 0.8);
    await store.archiveL1!("n2", "evolve"); // 演进场景：边保留（B3），内容只经归档可读回
    const extra = new Set<string>();
    for (const sid of ["s1"]) {
      for (const nb of await store.getNeighbors!(sid, undefined, 1) as Array<{ id: string }>) {
        extra.add(nb.id);
      }
    }
    const resolveByIds = (ids: string[]) => store.getL1ByIdsWithArchive!(ids);
    const neighborRecords = await resolveByIds([...extra]);
    eCheck("E4 邻居扩展：await 后可迭代取到 2 个邻居 id",
      extra.size === 2 && extra.has("n1") && extra.has("n2"), JSON.stringify([...extra]));
    eCheck("E4 邻居内容解析：实时 n1 + 归档 n2 全部读回（tcvdb 邻居扩展通电）",
      neighborRecords.length === 2
      && neighborRecords.some((r) => r.record_id === "n1" && r.content === "邻居记忆(实时)")
      && neighborRecords.some((r) => r.record_id === "n2" && r.content === "邻居记忆(已归档)"),
      JSON.stringify(neighborRecords.map((r) => [r.record_id, r.content])));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  ePass = eFailures.length === 0;
  console.log(ePass ? "[E] PASS" : `[E] FAIL（${eFailures.length} 项）`);
} catch (err) {
  console.log(`[E] FAIL（异常）: ${err instanceof Error ? err.message : String(err)}`);
  eFailures.push("exception");
}

// ═══════════════════════════════════════════════════════════════
// 总裁决
// ═══════════════════════════════════════════════════════════════
const allPass = aPass && bPass && cPass && dPass && ePass;
console.log("");
console.log(
  `总体：${allPass ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}, C=${cPass ? "PASS" : "FAIL"}, D=${dPass ? "PASS" : "FAIL"}, E=${ePass ? "PASS" : "FAIL"}）`,
);
process.exit(allPass ? 0 : 1);

// 引用占位（保证类型参与编译期检查）
export type { L1SearchResult, IsolationFilter };
