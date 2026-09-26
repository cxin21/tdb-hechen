/**
 * V12-CV：core_pending label/description 列（幂等 ALTER，T12 模式）——存读闭环。
 * 旧式无 extra 入队 → 两列为 NULL（逐位现状）；extra 重复入队 → ON CONFLICT 更新。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";

const T_A = { teamId: "teamA", userId: "userA", agentId: "agentA" };

describe("core_pending label/description 存读（V12-CV）", () => {
  let store: InstanceType<typeof VectorStore>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tdb-pending-label-"));
    store = new VectorStore(join(dir, "v.db"), 0);
    await store.init();
  });
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("upsertPendingCore 带 extra → list/decide 读回 label/description", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A, extra?: { label?: string; description?: string }) => boolean;
      listPendingCore: (tenant?: typeof T_A) => Array<{ pending_id: string; content: string; label?: string | null; description?: string | null }>;
      decidePendingCore: (pid: string, d: "adopted", tenant?: typeof T_A) => { slot: string; content: string; label?: string | null; description?: string | null } | null;
    };
    expect(s.upsertPendingCore("core_value", "取证先行：任何结论必须有证据支撑", 2, T_A, { label: "取证先行", description: "任何结论必须有证据支撑后才能下" })).toBe(true);
    const row = s.listPendingCore(T_A).find((r) => r.content.startsWith("取证先行"))!;
    expect(row.label).toBe("取证先行");
    expect(row.description).toBe("任何结论必须有证据支撑后才能下");
    const decided = s.decidePendingCore(row.pending_id!, "adopted", T_A);
    expect(decided).not.toBeNull();
    expect(decided!.label).toBe("取证先行");
    expect(decided!.description).toBe("任何结论必须有证据支撑后才能下");
  });

  it("旧式无 extra 入队 → label/description 为 NULL（逐位现状）", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A) => boolean;
      listPendingCore: (tenant?: typeof T_A) => Array<{ content: string; label?: string | null; description?: string | null }>;
    };
    s.upsertPendingCore("strict_rule", "绝不派发子代理执行开发任务", 1, T_A);
    const row = s.listPendingCore(T_A).find((r) => r.content === "绝不派发子代理执行开发任务")!;
    expect(row.label ?? null).toBeNull();
    expect(row.description ?? null).toBeNull();
  });

  it("extra 更新：同提案重复入队 → label/description 随 ON CONFLICT 更新", () => {
    const s = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: typeof T_A, extra?: { label?: string; description?: string }) => boolean;
      listPendingCore: (tenant?: typeof T_A) => Array<{ content: string; label?: string | null; description?: string | null }>;
    };
    s.upsertPendingCore("core_value", "闭环：每个批次都要四态收口", 3, T_A, { label: "闭环", description: "旧描述" });
    s.upsertPendingCore("core_value", "闭环：每个批次都要四态收口", 4, T_A, { label: "闭环", description: "新描述" });
    const row = s.listPendingCore(T_A).find((r) => r.content === "闭环：每个批次都要四态收口")!;
    expect(row.description).toBe("新描述");
  });
});
