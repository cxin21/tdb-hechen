/**
 * #91（拍板 2026-10-22）：self_identity 提案洪泛结构治理——复现即投票 + 默认终局。
 *
 * 合同（intercept-and-accumulate + TTL，全部 config-first 缺省关）：
 * 1. core_pending 专列 recurrence_json + embedding_json（幂等 ALTER；attrs 参与 pid 派生故不入 attrs_json）。
 * 2. store.updatePendingRecurrence(pendingId, episode, opts)：读并合并复现状态——init count=1 或 count+1；
 *    evidence_record_ids 并集去重；last_seen 更新；expired 行复活（revived:true，继承计数）；
 *    ready = count>=votesN(3) && span(last_seen-first_seen)>=spanHours(24h)；embedding 首写不覆盖。
 * 3. store.initPendingRecurrenceByContent(slot, content, tenant, episode, opts)：push 支路初始化，
 *    仅 recurrence_json 缺失时初始化（重推不双计）；行缺/状态不符 → null。
 * 4. store.sweepExpiredSelfIdentityPending(tenant, {ttlHours, now})：slot=self_identity ∧ state=pending ∧
 *    (recurrence 缺省视为 count=1 ∧ count=1) ∧ age(first_seen??created_at)>TTL → state='expired'
 *    （软失效可逆：行保留，再命中经 updatePendingRecurrence 复活继承计数）。
 * 5. gate.similarSelfIdentityProposalMatch：返回 {hit, pending?, vector?}——pending 行命中返回该行（计票）；
 *    core 行命中 hit 无 pending（拦不投）；语料含 expired（复活通道）；Match 恒嵌候选（预嵌基建）。
 *    similarSelfIdentityProposalExists 改薄包装（.hit）——#81 合同逐位保持（既有测试回归锚）。
 * 6. runReflection 接线：cfg.selfIdentityGate.recurrence{enabled?(缺省 false), votes?(3), ttlHours?(24)}；
 *    命中→每 run 每 pending_id 计一票（Set 去重同拍双提案）；push→init 带候选向量；返回值加 recurrenceVotes。
 * 7. TTL sweep 挂 lifecycle-scheduler（reflection 块后），recurrence 开才跑——flag 关=现状逐位（scheduler 集成另测）。
 *
 * 测试数据一律临时 SQLite（mkdtempSync），零生产触碰。
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReflection } from "./reflection.js";
import { startLifecycleScheduler } from "./lifecycle-scheduler.js";
import { VectorStore } from "../store/sqlite.js";

const NOW_ISO = "2026-10-22T00:00:00.000Z";
const H48_AGO = "2026-10-20T00:00:00.000Z";
const H25_AGO = "2026-10-20T23:00:00.000Z";
const H24_AGO = "2026-10-21T00:00:00.000Z";
const H1_AGO = "2026-10-21T23:00:00.000Z";
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const T = { teamId: "t91", userId: "u91", agentId: "a91" };
type Tenant = { teamId: string; userId: string; agentId: string };

// 确定性向量（零 LLM，#81 同款）：dup×dupTwin cos=0.90 ≥0.65
const VEC = {
  dup: [1, 0, 0],
  dupTwin: [0.9, 0.436, 0],
  other: [0, 1, 0],
};

function embedder(map: Record<string, number[]>, fallback: number[] = VEC.other) {
  const pick = (t: string): number[] => map[t] ?? fallback;
  return {
    embed: async (t: string) => new Float32Array(pick(t)),
    embedBatch: async (ts: string[]) => ts.map((t) => new Float32Array(pick(t))),
  };
}

const dirs: string[] = [];
async function mkStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "tdb-recurrence-91-"));
  dirs.push(dir);
  const st = new VectorStore(join(dir, "v.db"), 0);
  await st.init();
  return st;
}
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清理尽力而为 */ }
  }
});

async function pidOf(st: VectorStore, content: string): Promise<string> {
  const rows = await st.listPendingCore(T, { includeDecided: true });
  const hit = rows.find((r) => r.content === content);
  if (!hit) throw new Error("row not found: " + content);
  return hit.pending_id;
}

function raw(st: VectorStore, sql: string, ...args: unknown[]): void {
  (st as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db.prepare(sql).run(...args);
}

type RecSnapshot = { count: number; first_seen: string; last_seen: string; ready: boolean; revived: boolean };
type Episode = { ts: string; content: string; evidenceRecordIds?: string[]; embedding?: number[] };
type UpdFn = (pid: string, ep: Episode, opts?: { votesN?: number; spanHours?: number; tenant?: Tenant }) => Promise<RecSnapshot | null>;
type IniFn = (slot: string, content: string, tenant: Tenant, ep: Episode, opts?: { votesN?: number; spanHours?: number }) => Promise<RecSnapshot | null>;
type SweepFn = (tenant?: Tenant, opts?: { ttlHours?: number; now?: string }) => Promise<Array<{ pending_id: string; content: string }>>;

// 方法存在性断言后返回**绑定 this 的闭包**——类方法摘绑裸调会丢 this（严格模式 undefined）。
function updOf(st: VectorStore): UpdFn {
  const anySt = st as unknown as Record<string, unknown>;
  expect(typeof anySt.updatePendingRecurrence).toBe("function");
  const impl = st as unknown as { updatePendingRecurrence: UpdFn };
  return (pid, ep, opts) => impl.updatePendingRecurrence(pid, ep, opts);
}
function iniOf(st: VectorStore): IniFn {
  const anySt = st as unknown as Record<string, unknown>;
  expect(typeof anySt.initPendingRecurrenceByContent).toBe("function");
  const impl = st as unknown as { initPendingRecurrenceByContent: IniFn };
  return (slot, content, tenant, ep, opts) => impl.initPendingRecurrenceByContent(slot, content, tenant, ep, opts);
}
function sweepOf(st: VectorStore): SweepFn {
  const anySt = st as unknown as Record<string, unknown>;
  expect(typeof anySt.sweepExpiredSelfIdentityPending).toBe("function");
  const impl = st as unknown as { sweepExpiredSelfIdentityPending: SweepFn };
  return (tenant, opts) => impl.sweepExpiredSelfIdentityPending(tenant, opts);
}

// ───────────────────────── Part A：store 层（真实 SQLite 临时目录）─────────────────────────

describe("#91 store · recurrence 专列与三方法", () => {
  it("A1 新方法存在；listPendingCore 行带 recurrence_json/embedding_json 列", async () => {
    const st = await mkStore();
    updOf(st); iniOf(st); sweepOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 1, T);
    const rows = await st.listPendingCore(T, { includeDecided: true });
    expect(rows).toHaveLength(1);
    const row = rows[0] as unknown as Record<string, unknown>;
    expect("recurrence_json" in row).toBe(true);
    expect("embedding_json" in row).toBe(true);
  });

  it("A2 命中即计票：不新增行 / count+1 / evidence 并集去重 / last_seen 更新", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 2, T);
    const pid = await pidOf(st, "偏好先结论后细节的汇报方式");
    expect(await upd(pid, { ts: H1_AGO, content: "另一个表述", evidenceRecordIds: ["r1"] }, { tenant: T })).toMatchObject({ count: 1, ready: false, revived: false });
    expect(await upd(pid, { ts: NOW_ISO, content: "又一个表述", evidenceRecordIds: ["r9", "r1"] }, { tenant: T })).toMatchObject({ count: 2, last_seen: NOW_ISO, ready: false });
    const rows = await st.listPendingCore(T, { includeDecided: true });
    expect(rows).toHaveLength(1); // 不新增行
    const rec = JSON.parse((rows[0] as unknown as { recurrence_json: string }).recurrence_json) as { count: number; episodes: unknown[]; evidence_record_ids: string[]; last_seen: string };
    expect(rec.count).toBe(2);
    expect(rec.episodes).toHaveLength(2);
    expect(rec.evidence_record_ids).toEqual(["r1", "r9"]); // 并集去重
    expect(rec.last_seen).toBe(NOW_ISO);
  });

  it("A3 initPendingRecurrenceByContent：按内容定位初始化；重推不双计；行缺 → null", async () => {
    const st = await mkStore();
    const ini = iniOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 2, T);
    const ep = { ts: H1_AGO, content: "偏好先结论后细节的汇报方式", evidenceRecordIds: ["r1"] };
    expect(await ini("self_identity", "偏好先结论后细节的汇报方式", T, ep)).toMatchObject({ count: 1, ready: false, revived: false });
    expect(await ini("self_identity", "偏好先结论后细节的汇报方式", T, { ts: NOW_ISO, content: "偏好先结论后细节的汇报方式", evidenceRecordIds: ["r2"] })).toBeNull(); // 重推不双计
    const rows = await st.listPendingCore(T, { includeDecided: true });
    const rec = JSON.parse((rows[0] as unknown as { recurrence_json: string }).recurrence_json) as { count: number; episodes: unknown[] };
    expect(rec.count).toBe(1);
    expect(rec.episodes).toHaveLength(1);
    expect(await ini("self_identity", "不存在的行", T, ep)).toBeNull();
  });

  it("A3b 阈值晋升：count>=3 且 span>=24h → ready；votesN 可配", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 1, T);
    const pid = await pidOf(st, "偏好先结论后细节的汇报方式");
    expect(await upd(pid, { ts: H48_AGO, content: "第一次出现", evidenceRecordIds: ["r1"] }, { tenant: T })).toMatchObject({ count: 1, ready: false });
    expect(await upd(pid, { ts: H24_AGO, content: "第二次出现", evidenceRecordIds: ["r2"] }, { tenant: T })).toMatchObject({ count: 2, ready: false, revived: false }); // span=24h 但 count<3
    expect(await upd(pid, { ts: NOW_ISO, content: "第三次出现", evidenceRecordIds: ["r3"] }, { tenant: T })).toMatchObject({ count: 3, ready: true }); // span=48h
    // votesN=2：第二票即 ready
    await st.upsertPendingCore("self_identity", "另一条独立偏好", 1, T);
    const pid2 = await pidOf(st, "另一条独立偏好");
    expect(await upd(pid2, { ts: H48_AGO, content: "a", evidenceRecordIds: ["r1"] }, { tenant: T })).toMatchObject({ count: 1, ready: false });
    expect(await upd(pid2, { ts: H24_AGO, content: "b", evidenceRecordIds: ["r2"] }, { tenant: T, votesN: 2 })).toMatchObject({ count: 2, ready: true });
  });

  it("A4 TTL 软过期：仅 count=1 且超 TTL 的 pending/self_identity 行 expired；复活继承计数", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    const sweep = sweepOf(st);
    // 行1：count=1，first_seen=-25h → 应 expired
    await st.upsertPendingCore("self_identity", "孤行一", 1, T);
    const pid1 = await pidOf(st, "孤行一");
    await upd(pid1, { ts: H25_AGO, content: "孤行一", evidenceRecordIds: ["r1"] }, { tenant: T });
    // 行1b：recurrence 缺省（legacy），created_at 老化 → 视为 count=1 → 应 expired
    await st.upsertPendingCore("self_identity", "老遗留行", 1, T);
    const pidLegacy = await pidOf(st, "老遗留行");
    raw(st, "UPDATE core_pending SET created_at = ? WHERE pending_id = ?", H48_AGO, pidLegacy);
    // 行2：count=2（不 sweep）
    await st.upsertPendingCore("self_identity", "双票行", 1, T);
    const pid2 = await pidOf(st, "双票行");
    await upd(pid2, { ts: H48_AGO, content: "双票行", evidenceRecordIds: ["r1"] }, { tenant: T });
    await upd(pid2, { ts: H24_AGO, content: "双票行", evidenceRecordIds: ["r2"] }, { tenant: T });
    // 行3：count=1 但新鲜（不 sweep）
    await st.upsertPendingCore("self_identity", "新鲜行", 1, T);
    const pid3 = await pidOf(st, "新鲜行");
    await upd(pid3, { ts: H1_AGO, content: "新鲜行", evidenceRecordIds: ["r1"] }, { tenant: T });
    // 行4：rejected 行（state 非 pending，不 sweep）
    await st.upsertPendingCore("self_identity", "已否决行", 1, T);
    const pid4 = await pidOf(st, "已否决行");
    await upd(pid4, { ts: H48_AGO, content: "已否决行", evidenceRecordIds: ["r1"] }, { tenant: T });
    await st.decidePendingCore(pid4, "rejected", T);
    // 行5：非 self_identity slot（不 sweep）
    await st.upsertPendingCore("core_value", "无关 slot 行", 1, T);

    const swept = await sweep(T, { ttlHours: 24, now: NOW_ISO });
    const sweptIds = swept.map((s) => s.pending_id).sort();
    expect(sweptIds).toEqual([pid1, pidLegacy].sort());
    const rows = await st.listPendingCore(T, { includeDecided: true });
    expect(rows.find((r) => r.pending_id === pid1)?.state).toBe("expired");
    expect(rows.find((r) => r.pending_id === pidLegacy)?.state).toBe("expired");
    expect(rows.find((r) => r.pending_id === pid2)?.state).toBe("pending");
    expect(rows.find((r) => r.pending_id === pid3)?.state).toBe("pending");
    expect(rows.find((r) => r.pending_id === pid4)?.state).toBe("rejected");
    // 复活：expired 行再命中 → revived，继承计数 1→2，state 回 pending
    expect(await upd(pid1, { ts: NOW_ISO, content: "复现表述", evidenceRecordIds: ["r7"] }, { tenant: T })).toMatchObject({ revived: true, count: 2, ready: false });
    const row1b = (await st.listPendingCore(T, {})).find((r) => r.pending_id === pid1);
    expect(row1b?.state).toBe("pending");
  });

  it("A5 embedding 首写不覆盖；缺省 episode 不动 embedding_json", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 1, T);
    const pid = await pidOf(st, "偏好先结论后细节的汇报方式");
    await upd(pid, { ts: H1_AGO, content: "第一次", evidenceRecordIds: ["r1"], embedding: [1, 0, 0] }, { tenant: T });
    const getEmb = async (): Promise<string | null> => {
      const rows = await st.listPendingCore(T, { includeDecided: true });
      return (rows[0] as unknown as { embedding_json: string | null }).embedding_json;
    };
    expect(await getEmb()).toBe("[1,0,0]");
    await upd(pid, { ts: NOW_ISO, content: "第二次", evidenceRecordIds: ["r2"], embedding: [0, 1, 0] }, { tenant: T });
    expect(await getEmb()).toBe("[1,0,0]"); // 首写不覆盖
    await upd(pid, { ts: NOW_ISO, content: "第三次", evidenceRecordIds: ["r3"] }, { tenant: T });
    expect(await getEmb()).toBe("[1,0,0]"); // 无向量 episode 不动
  });

  it("A6 ON CONFLICT 重推不碰 recurrence_json/embedding_json", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 2, T);
    const pid = await pidOf(st, "偏好先结论后细节的汇报方式");
    await upd(pid, { ts: H1_AGO, content: "第一次", evidenceRecordIds: ["r1"], embedding: [1, 0, 0] }, { tenant: T });
    await st.upsertPendingCore("self_identity", "偏好先结论后细节的汇报方式", 5, T); // 同 pid 重推
    const rows = await st.listPendingCore(T, { includeDecided: true });
    const rec = JSON.parse((rows[0] as unknown as { recurrence_json: string }).recurrence_json) as { count: number };
    expect(rec.count).toBe(1); // 重推覆盖 evidence/created_at 但不动复现状态
    expect((rows[0] as unknown as { embedding_json: string | null }).embedding_json).toBe("[1,0,0]");
  });

  it("A7 防御：行缺/非 self_identity/已裁决 → null", async () => {
    const st = await mkStore();
    const upd = updOf(st);
    expect(await upd("pd-nope", { ts: NOW_ISO, content: "x" }, { tenant: T })).toBeNull();
    await st.upsertPendingCore("core_value", "非身份槽行", 1, T);
    const pidV = await pidOf(st, "非身份槽行");
    expect(await upd(pidV, { ts: NOW_ISO, content: "x" }, { tenant: T })).toBeNull();
    await st.upsertPendingCore("self_identity", "会被否决的行", 1, T);
    const pidR = await pidOf(st, "会被否决的行");
    await st.decidePendingCore(pidR, "rejected", T);
    expect(await upd(pidR, { ts: NOW_ISO, content: "x" }, { tenant: T })).toBeNull();
  });
});

// ───────────────────────── Part B：gate Match（fakeStore）─────────────────────────

type MatchRes = { hit: boolean; pending?: { pending_id: string; content: string; attrs_json?: string | null }; vector?: Float32Array };
type MatchFn = (args: { store?: unknown; tenant?: unknown; content: string; threshold?: number; embeddingService?: unknown; logger?: unknown }) => Promise<MatchRes>;

async function matchFn(): Promise<MatchFn> {
  const mod = (await import("./proposal-sim-gate.js")) as unknown as Record<string, unknown>;
  const fn = mod.similarSelfIdentityProposalMatch as MatchFn | undefined;
  expect(typeof fn).toBe("function");
  return fn as MatchFn;
}

type FakePending = { slot: string; content: string; state?: string; embedding_json?: string | null };
function fakeGate(opts: { pending?: FakePending[]; core?: { slot: string; content: string }[] } = {}) {
  return {
    upsertL1: vi.fn(async () => true),
    upsertPendingCore: vi.fn(async () => true),
    listPendingCore: vi.fn(async () =>
      (opts.pending ?? []).map((p, i) => ({ pending_id: "pd" + i, slot: p.slot, content: p.content, state: p.state ?? "pending", evidence: 1, created_at: NOW_ISO, attrs_json: null, embedding_json: p.embedding_json ?? null })),
    ),
    readCore: vi.fn(async () => opts.core ?? []),
  };
}

const PENDING_A = "用户喜欢先看结论后看细节";
const CONTENT_A = "要求所有报告先给结论再给细节";

describe("#91 gate · similarSelfIdentityProposalMatch", () => {
  it("B1 pending 相似命中 → 返回该行 + 候选向量", async () => {
    const m = await matchFn();
    const st = fakeGate({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await m({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(res.hit).toBe(true);
    expect(res.pending?.pending_id).toBe("pd0");
    expect(res.vector).toBeDefined();
  });

  it("B2 精确重复命中 pending 行 → 返回该行（计票）", async () => {
    const m = await matchFn();
    const st = fakeGate({ pending: [{ slot: "self_identity", content: CONTENT_A }] });
    const res = await m({ store: st, tenant: T, content: CONTENT_A });
    expect(res.hit).toBe(true);
    expect(res.pending?.pending_id).toBe("pd0");
  });

  it("B3 core 行命中 → hit 无 pending（拦不投）", async () => {
    const m = await matchFn();
    const st = fakeGate({ core: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await m({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(res.hit).toBe(true);
    expect(res.pending).toBeUndefined();
  });

  it("B4 无候选 → hit:false，但恒嵌候选（预嵌基建，区别于 Exists 短路）", async () => {
    const m = await matchFn();
    const st = fakeGate({});
    const emb = { embed: vi.fn(), embedBatch: vi.fn(async (ts: string[]) => ts.map(() => new Float32Array(VEC.other))) };
    const res = await m({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(res.hit).toBe(false);
    expect(res.vector).toBeDefined();
    expect(emb.embedBatch).toHaveBeenCalledTimes(1);
  });

  it("B5 行带 embedding_json → 语料向量直读，embedBatch 只嵌候选", async () => {
    const m = await matchFn();
    const st = fakeGate({ pending: [{ slot: "self_identity", content: PENDING_A, embedding_json: JSON.stringify(VEC.dup) }] });
    const emb = { embed: vi.fn(), embedBatch: vi.fn(async (ts: string[]) => ts.map(() => new Float32Array(VEC.dupTwin))) };
    const res = await m({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(res.hit).toBe(true);
    expect(emb.embedBatch).toHaveBeenCalledTimes(1);
    const batchArg = (emb.embedBatch.mock.calls as unknown as string[][][])[0]?.[0];
    expect(batchArg).toEqual([CONTENT_A]);
  });

  it("B6 expired 行留在语料（复活通道）→ 仍命中并返回行", async () => {
    const m = await matchFn();
    const st = fakeGate({ pending: [{ slot: "self_identity", content: PENDING_A, state: "expired" }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await m({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(res.hit).toBe(true);
    expect(res.pending?.pending_id).toBe("pd0");
  });
});

// ───────────────────────── Part C：runReflection 接线（fakeStore91）─────────────────────────

const SECOND_A = "用户要求所有报告先给结论再给"; // r1 内容的 14 字逐字前缀片段（过 vet verbatim 门）

type Store91 = ReturnType<typeof fakeStore91>;
function fakeStore91(opts: { pending?: FakePending[]; core?: { slot: string; content: string }[] } = {}) {
  return {
    ...fakeGate(opts),
    updatePendingRecurrence: vi.fn(async (_pid?: string, _ep?: unknown, _opts?: unknown) => ({ count: 2, first_seen: NOW_ISO, last_seen: NOW_ISO, ready: false, revived: false })),
    initPendingRecurrenceByContent: vi.fn(async (_slot?: string, _content?: string, _tenant?: unknown, _ep?: unknown, _opts?: unknown) => ({ count: 1, first_seen: NOW_ISO, last_seen: NOW_ISO, ready: false, revived: false })),
    sweepExpiredSelfIdentityPending: vi.fn(async (_tenant?: unknown, _opts?: unknown) => [] as Array<{ pending_id: string; content: string }>),
    // scheduler 内部组装 queryL1 = store.queryL1Records（snake_case 行）→ mapL1RowToRecord；
    // selfIdentity/anchorDiscovery/consolidation/forgetting/evolution 全关 → reflection 是唯一 upsert 来源。
    queryL1Records: vi.fn(async () => [
      { record_id: "r1", content: "用户要求所有报告先给结论再给细节", type: "episodic", significance: 0.9, timestamp_str: NOW_ISO, updated_time: NOW_ISO, created_time: NOW_ISO, team_id: "t1", user_id: "u1", agent_id: "a1", metadata: {} },
    ]),
  };
}

function rows91(): Array<Record<string, unknown>> {
  return [{ id: "r1", content: "用户要求所有报告先给结论再给细节", type: "episodic", significance: 0.9, createdAt: NOW_ISO, updatedAt: NOW_ISO, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} }];
}
function llm91(out: string) {
  return { run: vi.fn(async () => out) };
}
const PROPOSAL_A = JSON.stringify([{ question: "q", conclusion: CONTENT_A, evidence: ["r1"] }]);
const baseCfg = { enabled: true, rRef: 0.5, soulProposals: { enabled: true, shadowCalibration: { enabled: false } } };
const recCfg = { ...baseCfg, selfIdentityGate: { recurrence: { enabled: true } } };

function firstCall(fn: { mock: { calls: unknown[][] } }): unknown[] {
  return fn.mock.calls[0] ?? [];
}

describe("#91 runReflection · 复现即投票接线", () => {
  it("C0 golden：recurrence 缺省关 → 现状逐位（拦截但不投票，返回 recurrenceVotes=0）", async () => {
    const st = fakeStore91({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await runReflection({ queryL1: async () => rows91(), config: baseCfg, store: st, llmRunner: llm91(PROPOSAL_A), logger: LOG, filter: T, embeddingService: emb });
    expect(res.simGated).toBe(1);
    expect((res as unknown as { recurrenceVotes?: number }).recurrenceVotes).toBe(0);
    expect(st.updatePendingRecurrence).not.toHaveBeenCalled();
    expect(st.initPendingRecurrenceByContent).not.toHaveBeenCalled();
    expect(st.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("C1 recurrence on + 命中 → 每 pending 一票（不 upsert，simGated=1，recurrenceVotes=1）", async () => {
    const st = fakeStore91({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await runReflection({ queryL1: async () => rows91(), config: recCfg, store: st, llmRunner: llm91(PROPOSAL_A), logger: LOG, filter: T, embeddingService: emb });
    expect(st.upsertPendingCore).not.toHaveBeenCalled();
    expect(st.updatePendingRecurrence).toHaveBeenCalledTimes(1);
    const call = firstCall(st.updatePendingRecurrence);
    expect(call[0]).toBe("pd0");
    expect(call[1]).toMatchObject({ content: CONTENT_A, evidenceRecordIds: ["r1"] });
    expect(call[2]).toMatchObject({ votesN: 3, spanHours: 24 });
    expect(res.simGated).toBe(1);
    expect((res as unknown as { recurrenceVotes?: number }).recurrenceVotes).toBe(1);
  });

  it("C2 同拍双提案命中同一行 → 只计一票（Set 去重），simGated=2", async () => {
    const st = fakeStore91({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin, [SECOND_A]: VEC.dupTwin });
    const two = JSON.stringify([
      { question: "q1", conclusion: CONTENT_A, evidence: ["r1"] },
      { question: "q2", conclusion: SECOND_A, evidence: ["r1"] },
    ]);
    const res = await runReflection({ queryL1: async () => rows91(), config: recCfg, store: st, llmRunner: llm91(two), logger: LOG, filter: T, embeddingService: emb });
    expect(st.updatePendingRecurrence).toHaveBeenCalledTimes(1);
    expect(res.simGated).toBe(2);
    expect((res as unknown as { recurrenceVotes?: number }).recurrenceVotes).toBe(1);
  });

  it("C3 votes 可配透传（votesN=2）", async () => {
    const st = fakeStore91({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const cfg = { ...baseCfg, selfIdentityGate: { recurrence: { enabled: true, votes: 2 } } };
    await runReflection({ queryL1: async () => rows91(), config: cfg, store: st, llmRunner: llm91(PROPOSAL_A), logger: LOG, filter: T, embeddingService: emb });
    const call = firstCall(st.updatePendingRecurrence);
    expect(call[2]).toMatchObject({ votesN: 2 });
  });

  it("C4 push 支路：未命中新落行 → initPendingRecurrenceByContent 带候选向量（预嵌）", async () => {
    const st = fakeStore91({});
    const emb = embedder({ [CONTENT_A]: VEC.dupTwin });
    const res = await runReflection({ queryL1: async () => rows91(), config: recCfg, store: st, llmRunner: llm91(PROPOSAL_A), logger: LOG, filter: T, embeddingService: emb });
    expect(st.upsertPendingCore).toHaveBeenCalledTimes(1);
    expect(st.initPendingRecurrenceByContent).toHaveBeenCalledTimes(1);
    const call = firstCall(st.initPendingRecurrenceByContent);
    expect(call[0]).toBe("self_identity");
    expect(call[1]).toBe(CONTENT_A);
    const ep = call[3] as { content: string; evidenceRecordIds: string[]; embedding?: number[] };
    expect(ep.content).toBe(CONTENT_A);
    expect(ep.evidenceRecordIds).toEqual(["r1"]);
    const embArr = Array.from(ep.embedding ?? []);
    expect(embArr.length).toBe(VEC.dupTwin.length);
    embArr.forEach((v, i) => expect(v).toBeCloseTo(VEC.dupTwin[i]!, 5)); // Float32 精度（0.436→0.435999…）
    expect((res as unknown as { recurrenceVotes?: number }).recurrenceVotes).toBe(0);
  });

  it("C5 旧 store 缺新方法 + recurrence on → 降级不抛（宁漏勿误）", async () => {
    const st = fakeGate({ pending: [{ slot: "self_identity", content: PENDING_A }] }); // 无 updatePendingRecurrence
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const res = await runReflection({ queryL1: async () => rows91(), config: recCfg, store: st, llmRunner: llm91(PROPOSAL_A), logger: LOG, filter: T, embeddingService: emb });
    expect(res.simGated).toBe(1);
    expect((res as unknown as { recurrenceVotes?: number }).recurrenceVotes).toBe(0);
  });
});

// ───────────────────────── Part D：lifecycle-scheduler TTL sweep 节拍接线 ─────────────────────────

function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (cond()) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error("waitUntil timeout")); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}
const grace = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

type SchedulerDeps = Parameters<typeof startLifecycleScheduler>[0];

describe("#91 scheduler · TTL sweep 节拍接线", () => {
  it("D1 recurrence on → reflection 块后 sweep 一次（ttlHours/filter 透传）", async () => {
    const st = fakeStore91({});
    const emb = embedder({ [CONTENT_A]: VEC.dupTwin });
    const cfg = {
      enabled: true, intervalMs: 3_600_000,
      consolidation: { enabled: false }, forgetting: { enabled: false }, anchorDiscovery: { enabled: false },
      reflection: { enabled: true, rRef: 0.5, soulProposals: { enabled: true, shadowCalibration: { enabled: false } }, selfIdentityGate: { recurrence: { enabled: true, ttlHours: 12 } } },
      filter: T,
    };
    const stop = startLifecycleScheduler({ store: st as unknown as SchedulerDeps["store"], llmRunner: llm91(PROPOSAL_A), logger: LOG, embeddingService: emb, config: cfg as unknown as SchedulerDeps["config"] }); // fake cfg 仅触达启用面，子对象非 Partial 嵌套 → cast（同 store 惯例）
    try {
      await waitUntil(() => st.upsertPendingCore.mock.calls.length > 0); // reflection 块完成信号
      await grace();
      expect(st.sweepExpiredSelfIdentityPending).toHaveBeenCalledTimes(1);
      const call = firstCall(st.sweepExpiredSelfIdentityPending);
      expect(call[0]).toMatchObject({ teamId: "t91", userId: "u91", agentId: "a91" });
      expect(call[1]).toMatchObject({ ttlHours: 12 });
    } finally {
      stop();
    }
  });

  it("D2 golden：recurrence 缺省关 → 零 sweep 调用（flag-off 逐位）", async () => {
    const st = fakeStore91({});
    const emb = embedder({ [CONTENT_A]: VEC.dupTwin });
    const cfg = {
      enabled: true, intervalMs: 3_600_000,
      consolidation: { enabled: false }, forgetting: { enabled: false }, anchorDiscovery: { enabled: false },
      reflection: { enabled: true, rRef: 0.5, soulProposals: { enabled: true, shadowCalibration: { enabled: false } } },
      filter: T,
    };
    const stop = startLifecycleScheduler({ store: st as unknown as SchedulerDeps["store"], llmRunner: llm91(PROPOSAL_A), logger: LOG, embeddingService: emb, config: cfg as unknown as SchedulerDeps["config"] }); // fake cfg 仅触达启用面，子对象非 Partial 嵌套 → cast（同 store 惯例）
    try {
      await waitUntil(() => st.upsertPendingCore.mock.calls.length > 0); // reflection 块完成信号
      await grace();
      expect(st.sweepExpiredSelfIdentityPending).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
