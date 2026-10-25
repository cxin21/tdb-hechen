/**
 * #92 stage 2（2026-10-25 拍板四项：N₂/T₂=4/72h · 0.60/0.75 · 快照+版本守卫回滚 · 面板跟进票）
 * self_identity 确定性自动采纳门——三重门高置信自动采纳，人转审计员。
 *
 * 覆盖合同（设计稿 docs/research/2026-10-25-92-stage2-autoadopt-design.md §5）：
 *   R1 flag off golden：autoAdopt 缺省 → 门整体旁路（现状逐位，零调用）；
 *   R2 三重门过 → 采纳链逐位镜像 #82 人审 merge-on-adopt（readCore → escapeXmlTags 按行 →
 *      mergeIdentityFacts 单一源 → 幂等跳过 → upsertCore source="auto-adopt-gate" →
 *      state='auto_adopted' + attrs 审计四字段）；
 *   R3 rejected 矛盾（proposalSimilarity ≥ contradictionThreshold）→ 不采纳（state 留 pending）；
 *   R4 槽内重复（≥ dupThreshold）→ skip 零写；
 *   R5 回滚：版本相等 → prev_slot_content 恢复 + state='rejected'；版本漂移 → 拒绝；
 *      prev 槽不存在（采纳时创建）→ 回滚删除槽行；
 *   R6 槽行守恒/多租户隔离：合并走 mergeIdentityFacts 单一源，租户互不串；
 *   R7 config 接线三态 → config.selfidentity-gate.test.ts；路由分支 → pending-routes.test.ts。
 *
 * 测试数据一律临时 SQLite（mkdtempSync），零生产触碰。
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../store/sqlite.js";
import { runSelfIdentityAutoAdopt } from "./auto-adopt-gate.js";
import { proposalSimilarity } from "./proposal-dedup.js";

const T1 = { teamId: "t92a", userId: "u92a", agentId: "a92a" };
const T2 = { teamId: "t92b", userId: "u92b", agentId: "a92b" };
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const CONTENT_A = "用户偏好先结论后细节的汇报方式";
const A_TWIN = "用户偏好先结论后细节的汇报方式与格式";
const UNRELATED = "周末全家聚餐，用户是家里的首席厨师";

const dirs: string[] = [];
async function mkStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "tdb-autoadopt-92-"));
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

type Tenant = { teamId: string; userId: string; agentId: string };

/** 播种一条计票行：votes 次投票、相邻 spanH 小时（count=votes、跨度=(votes-1)*spanH）。 */
async function seedReadyRow(st: VectorStore, tenant: Tenant, content: string, votes = 4, spanH = 72): Promise<string> {
  await st.upsertPendingCore("self_identity", content, 1, tenant);
  const rows = st.listPendingCore(tenant, { includeDecided: true });
  const hit = rows.find((r) => r.content === content);
  if (!hit) throw new Error("seed row not found: " + content);
  const pid = hit.pending_id;
  const impl = st as unknown as { updatePendingRecurrence: (pid: string, ep: { ts?: string }, opts?: { tenant?: Tenant }) => unknown };
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  for (let i = 0; i < votes; i++) {
    impl.updatePendingRecurrence(pid, { ts: new Date(t0 + i * spanH * 3_600_000).toISOString() }, { tenant });
  }
  return pid;
}

/** 方法存在性断言 + 绑定 this 的委托 facade（vi.fn 包裹可断言调用）。 */
function facade(st: VectorStore) {
  const anySt = st as unknown as Record<string, unknown>;
  for (const m of ["listReadySelfIdentityPending", "decidePendingCoreAuto", "rollbackAutoAdoptedPending", "getPendingCoreState"]) {
    expect(typeof anySt[m]).toBe("function");
  }
  return {
    listReadySelfIdentityPending: vi.fn((t?: Tenant, o?: { votesN?: number; spanHours?: number }) => st.listReadySelfIdentityPending(t, o)),
    decidePendingCoreAuto: vi.fn((pid: string, t?: Tenant, audit?: unknown) => st.decidePendingCoreAuto(pid, t, audit as never)),
    rollbackAutoAdoptedPending: vi.fn((pid: string, t?: Tenant) => st.rollbackAutoAdoptedPending(pid, t)),
    getPendingCoreState: vi.fn((pid: string) => st.getPendingCoreState(pid)),
    readCore: vi.fn((t?: Tenant) => st.readCore(t)),
    upsertCore: vi.fn((slot: string, content: string, source: string, t?: Tenant) => st.upsertCore(slot, content, source, t)),
    listPendingCore: vi.fn((t?: Tenant, o?: { includeDecided?: boolean }) => st.listPendingCore(t, o)),
  };
}

function attrsOf(st: VectorStore, pid: string): Record<string, unknown> {
  const rows = st.listPendingCore(T1, { includeDecided: true });
  const row = rows.find((r) => r.pending_id === pid) as unknown as { attrs_json?: string | null };
  try { return JSON.parse(row?.attrs_json ?? "{}") as Record<string, unknown>; } catch { return {}; }
}

// ───────────────────────── Part A：store 层（真实 SQLite 临时目录）─────────────────────────

describe("#92 store · 自动采纳三方法", () => {
  it("A1 方法存在；listReadySelfIdentityPending 按 count≥votesN ∧ 跨度≥spanHours 过滤", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    expect(st.listReadySelfIdentityPending(T1, { votesN: 4, spanHours: 72 }).map((r) => r.pending_id)).toContain(pid);
    expect(st.listReadySelfIdentityPending(T1, { votesN: 5, spanHours: 72 })).toHaveLength(0);   // count 不足
    expect(st.listReadySelfIdentityPending(T1, { votesN: 4, spanHours: 300 })).toHaveLength(0);  // 跨度不足
  });

  it("A2 租户逐字段精确限定；缺省=全租户（R1 先例）", async () => {
    const st = await mkStore();
    await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    expect(st.listReadySelfIdentityPending(T2, { votesN: 4, spanHours: 72 })).toHaveLength(0);
    expect(st.listReadySelfIdentityPending(undefined, { votesN: 4, spanHours: 72 })).toHaveLength(1);
  });

  it("A3 decidePendingCoreAuto：state 翻 auto_adopted + attrs 审计四字段；非 pending 行拒绝", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    st.upsertCore("self_identity", "- 旧事实甲", "test", T1);
    const ok = st.decidePendingCoreAuto(pid, T1, {
      prev_slot_content: "- 旧事实甲", prev_slot_version: 1, prev_slot_existed: true, post_slot_version: 2,
      gate: { votes: 4, spanHours: 72, contradictionThreshold: 0.6, dupThreshold: 0.75 },
    });
    expect(ok).toBe(true);
    const row = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.pending_id === pid) as unknown as { state: string };
    expect(row.state).toBe("auto_adopted");
    const aa = attrsOf(st, pid).auto_adopt as Record<string, unknown>;
    expect(aa.prev_slot_content).toBe("- 旧事实甲");
    expect(aa.prev_slot_version).toBe(1);
    expect(aa.prev_slot_existed).toBe(true);
    expect(aa.post_slot_version).toBe(2);
    expect((aa.gate as Record<string, unknown>).votes).toBe(4);
    expect(st.decidePendingCoreAuto(pid, T1, {})).toBe(false); // 非 pending 再采纳 → false
  });

  it("A4 回滚：版本相等 → 恢复 prev_slot_content + state='rejected'（recurrence 证据零删除）", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    st.upsertCore("self_identity", "- 旧事实甲", "test", T1); // v1（prev）
    st.upsertCore("self_identity", "- 旧事实甲\n- " + CONTENT_A, "auto-adopt-gate", T1); // v2（采纳合并写，post=2）
    st.decidePendingCoreAuto(pid, T1, { prev_slot_content: "- 旧事实甲", prev_slot_version: 1, prev_slot_existed: true, post_slot_version: 2, gate: { votes: 4, spanHours: 72, contradictionThreshold: 0.6, dupThreshold: 0.75 } });
    const rb = st.rollbackAutoAdoptedPending(pid, T1);
    expect(rb.restored).toBe(true);
    const slot = st.readCore(T1).find((s) => s.slot === "self_identity");
    expect(slot?.content).toBe("- 旧事实甲");
    const row = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.pending_id === pid) as unknown as { state: string; recurrence_json: string | null };
    expect(row.state).toBe("rejected");
    expect(row.recurrence_json).not.toBeNull(); // 证据全留
  });

  it("A4b 回滚版本漂移 → 拒绝（state 不变）", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    st.upsertCore("self_identity", "- 旧事实甲", "test", T1); // v1
    st.upsertCore("self_identity", "- 旧事实甲\n- " + CONTENT_A, "auto-adopt-gate", T1); // v2（采纳写，post=2）
    st.decidePendingCoreAuto(pid, T1, { prev_slot_content: "- 旧事实甲", prev_slot_version: 1, prev_slot_existed: true, post_slot_version: 2, gate: { votes: 4, spanHours: 72, contradictionThreshold: 0.6, dupThreshold: 0.75 } });
    st.upsertCore("self_identity", "- 旧事实甲\n- 人工后补", "panel-adopt", T1); // v3 漂移 ≠ post 2
    const rb = st.rollbackAutoAdoptedPending(pid, T1);
    expect(rb.restored).toBe(false);
    expect(String(rb.reason)).toContain("slot-version-changed");
    const row = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.pending_id === pid) as unknown as { state: string };
    expect(row.state).toBe("auto_adopted");
  });

  it("A4c 采纳时创建的槽 → 回滚删除槽行（prev_slot_existed=false）", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T2, UNRELATED, 4, 72);
    expect(st.readCore(T2).some((s) => s.slot === "self_identity")).toBe(false);
    st.decidePendingCoreAuto(pid, T2, { prev_slot_content: "", prev_slot_version: 0, prev_slot_existed: false, post_slot_version: 1, gate: { votes: 4, spanHours: 72, contradictionThreshold: 0.6, dupThreshold: 0.75 } });
    st.upsertCore("self_identity", "- " + UNRELATED, "auto-adopt-gate", T2);
    const rb = st.rollbackAutoAdoptedPending(pid, T2);
    expect(rb.restored).toBe(true);
    expect(st.readCore(T2).some((s) => s.slot === "self_identity")).toBe(false); // 槽行还原为无
  });

  it("A4d 非 auto_adopted 行回滚 → 拒绝；A5 getPendingCoreState 单行读", async () => {
    const st = await mkStore();
    const pid = await seedReadyRow(st, T1, CONTENT_A, 1, 72);
    expect(st.rollbackAutoAdoptedPending(pid, T1)).toMatchObject({ restored: false, reason: "not-auto-adopted" });
    expect(st.getPendingCoreState(pid)).toBe("pending");
    expect(st.getPendingCoreState("pd-not-exist")).toBeNull();
  });
});

// ───────────────────────── Part B：门（runSelfIdentityAutoAdopt）─────────────────────────

describe("#92 门 · runSelfIdentityAutoAdopt", () => {
  it("B1 R1 flag off golden：缺省/未启用 → 门整体旁路零调用（现状逐位）", async () => {
    const st = await mkStore();
    const f = facade(st);
    await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    const off = await runSelfIdentityAutoAdopt({ store: f, config: {}, logger: LOG });
    expect(off).toEqual({ ran: false, adopted: 0, blocked: 0, skipped: 0 });
    const off2 = await runSelfIdentityAutoAdopt({ store: f, config: { enabled: false, votes: 4 }, logger: LOG });
    expect(off2.ran).toBe(false);
    expect(f.upsertCore).not.toHaveBeenCalled();
    expect(f.decidePendingCoreAuto).not.toHaveBeenCalled();
  });

  it("B2 R2 三重门过 → 采纳链逐位（mergeIdentityFacts 合并 + source=auto-adopt-gate + auto_adopted + 审计字段）", async () => {
    const st = await mkStore();
    const f = facade(st);
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    st.upsertCore("self_identity", "- 旧事实甲", "test", T1);
    const res = await runSelfIdentityAutoAdopt({ store: f, config: { enabled: true, votes: 4, spanHours: 72 }, logger: LOG });
    expect(res).toEqual({ ran: true, adopted: 1, blocked: 0, skipped: 0 });
    expect(f.upsertCore).toHaveBeenCalledTimes(1);
    const [slot, content, source] = (f.upsertCore as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(slot).toBe("self_identity");
    expect(String(content)).toContain("旧事实甲");
    expect(String(content)).toContain(CONTENT_A);
    expect(source).toBe("auto-adopt-gate");
    const row = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.pending_id === pid) as unknown as { state: string };
    expect(row.state).toBe("auto_adopted");
    const aa = attrsOf(st, pid).auto_adopt as Record<string, unknown>;
    expect(aa.prev_slot_content).toBe("- 旧事实甲");
    expect((aa.gate as Record<string, unknown>).dupThreshold).toBe(0.75);
  });

  it("B3 R3 同主题 rejected 矛盾 → 不采纳（state 留 pending，stage-1 晋升语义不受影响）", async () => {
    const st = await mkStore();
    const f = facade(st);
    const pid = await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    await st.upsertPendingCore("self_identity", A_TWIN, 1, T1);
    const twinPid = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.content === A_TWIN)!.pending_id;
    st.decidePendingCore(twinPid, "rejected", T1); // 同主题 rejected 在案
    expect(proposalSimilarity(CONTENT_A, A_TWIN)).toBeGreaterThanOrEqual(0.6);
    const res = await runSelfIdentityAutoAdopt({ store: f, config: { enabled: true, votes: 4, spanHours: 72 }, logger: LOG });
    expect(res).toEqual({ ran: true, adopted: 0, blocked: 1, skipped: 0 });
    expect(f.upsertCore).not.toHaveBeenCalled();
    const row = st.listPendingCore(T1, { includeDecided: true }).find((r) => r.pending_id === pid) as unknown as { state: string };
    expect(row.state).toBe("pending");
  });

  it("B4 R4 槽内重复 → skip 零写", async () => {
    const st = await mkStore();
    const f = facade(st);
    await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    st.upsertCore("self_identity", "- " + A_TWIN, "test", T1); // 槽内已有同主题行（sim 0.82 ≥ 0.75）
    const res = await runSelfIdentityAutoAdopt({ store: f, config: { enabled: true, votes: 4, spanHours: 72 }, logger: LOG });
    expect(res).toEqual({ ran: true, adopted: 0, blocked: 0, skipped: 1 });
    expect(f.upsertCore).not.toHaveBeenCalled();
  });

  it("B5 R6 多租户隔离：T1 采纳合并进 T1 槽；T2 无槽 → 创建（prev_slot_existed=false 路径）", async () => {
    const st = await mkStore();
    const f = facade(st);
    await seedReadyRow(st, T1, CONTENT_A, 4, 72);
    await seedReadyRow(st, T2, UNRELATED, 4, 72);
    st.upsertCore("self_identity", "- 旧事实甲", "test", T1);
    const res = await runSelfIdentityAutoAdopt({ store: f, config: { enabled: true, votes: 4, spanHours: 72 }, logger: LOG });
    expect(res.adopted).toBe(2);
    const t1Slot = st.readCore(T1).find((s) => s.slot === "self_identity");
    const t2Slot = st.readCore(T2).find((s) => s.slot === "self_identity");
    expect(t1Slot?.content).toContain("旧事实甲");
    expect(t1Slot?.content).toContain(CONTENT_A);
    expect(t2Slot?.content).toContain(UNRELATED);
    expect(t2Slot?.content).not.toContain("旧事实甲");
  });

  it("B6 旧 store 旁路：缺 listReadySelfIdentityPending → ran:false 零调用", async () => {
    const res = await runSelfIdentityAutoAdopt({ store: { readCore: () => [] }, config: { enabled: true }, logger: LOG });
    expect(res.ran).toBe(false);
  });
});
