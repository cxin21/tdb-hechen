/**
 * P2 Task 6（spec §7 O13）：core_pending 落点——红线类提案的人工采纳闭环。
 * 状态机：pending → adopted/rejected（单向）；同 (slot,content,tenant) 幂等（更新 evidence 不重复插）；
 * adopted/rejected 不复活（UPsert WHERE state='pending'）；租户隔离。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";

const T_A = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const T_B = { teamId: "teamB", userId: "userB", agentId: "agentB" };

describe("core_pending store 方法（O13）", () => {
  let store: InstanceType<typeof VectorStore>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tdb-pending-"));
    store = new VectorStore(join(dir, "v.db"), 0);
    await store.init();
  });
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("upsert 幂等：同 (slot,content,tenant) 只一行，evidence 更新", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A) => boolean;
      listPendingCore: (tenant?: typeof T_A, opts?: { includeDecided?: boolean }) => Array<{ pending_id: string; evidence: number; state: string }>;
    };
    expect(s.upsertPendingCore("strict_rule", "绝不泄露用户隐私数据", 2, T_A)).toBe(true);
    expect(s.upsertPendingCore("strict_rule", "绝不泄露用户隐私数据", 5, T_A)).toBe(true);
    const list = s.listPendingCore(T_A);
    expect(list.length).toBe(1);
    expect(list[0]!.evidence).toBe(5);
    expect(list[0]!.state).toBe("pending");
    expect(list[0]!.pending_id).toMatch(/^pd-/);
  });

  it("租户隔离：B 看不到 A 的 pending", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A) => boolean;
      listPendingCore: (tenant?: typeof T_A) => Array<{ content: string }>;
    };
    s.upsertPendingCore("core_value", "诚实优先于效率", 1, T_A);
    const listB = (store as unknown as { listPendingCore: (t?: typeof T_B) => Array<{ content: string }> }).listPendingCore(T_B);
    expect(listB.some((r) => r.content === "诚实优先于效率")).toBe(false);
    expect(s.listPendingCore(T_A).some((r) => r.content === "诚实优先于效率")).toBe(true);
  });

  it("状态机单向：decide adopted → 默认列表消失；再次 decide → null（幂等）；upsert 不复活", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A) => boolean;
      listPendingCore: (tenant?: typeof T_A, opts?: { includeDecided?: boolean }) => Array<{ pending_id: string; content: string; state: string }>;
      decidePendingCore: (pid: string, d: "adopted" | "rejected", tenant?: typeof T_A) => { slot: string; content: string } | null;
    };
    s.upsertPendingCore("strict_rule", "必须先给结论再给细节", 3, T_A);
    const row = s.listPendingCore(T_A).find((r) => r.content === "必须先给结论再给细节")!;
    const decided = s.decidePendingCore(row.pending_id, "adopted", T_A);
    expect(decided).toEqual({ slot: "strict_rule", content: "必须先给结论再给细节" });
    expect(s.listPendingCore(T_A).some((r) => r.content === "必须先给结论再给细节")).toBe(false);
    // includeDecided 可见 adopted
    const all = s.listPendingCore(T_A, { includeDecided: true });
    expect(all.find((r) => r.content === "必须先给结论再给细节")?.state).toBe("adopted");
    // 幂等：再次 decide → null
    expect(s.decidePendingCore(row.pending_id, "rejected", T_A)).toBe(null);
    // 不复活：同内容再 upsert → 不产生新 pending 行
    s.upsertPendingCore("strict_rule", "必须先给结论再给细节", 3, T_A);
    expect(s.listPendingCore(T_A).some((r) => r.content === "必须先给结论再给细节")).toBe(false);
  });

  it("decide rejected 正常落状态；陌生 pending_id → null", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A) => boolean;
      listPendingCore: (tenant?: typeof T_A, opts?: { includeDecided?: boolean }) => Array<{ pending_id: string; content: string; state: string }>;
      decidePendingCore: (pid: string, d: "adopted" | "rejected", tenant?: typeof T_A) => { slot: string; content: string } | null;
    };
    s.upsertPendingCore("core_value", "透明优先", 0, T_A);
    const row = s.listPendingCore(T_A).find((r) => r.content === "透明优先")!;
    expect(s.decidePendingCore(row.pending_id, "rejected", T_A)).toEqual({ slot: "core_value", content: "透明优先" });
    expect(s.listPendingCore(T_A, { includeDecided: true }).find((r) => r.content === "透明优先")?.state).toBe("rejected");
    expect(s.decidePendingCore("pd-nonexistent", "adopted", T_A)).toBe(null);
  });
});
