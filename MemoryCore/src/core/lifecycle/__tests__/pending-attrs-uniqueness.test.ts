/**
 * #49（pending_id 碰撞，2026-10-17）：upsertPendingCore 派生纳入 attrs 唯一性。
 *
 * 合同（#49 票面 + sqlite.ts upsertPendingCore 契约）：
 * 1. 同 slot|content|tenant、attrs 不同（如 promise 提案 attrs 含不同 promiseId）的两条提案
 *    → 两个不同 pending_id，互不覆盖。修复前：同 id → ON CONFLICT DO UPDATE 就地覆盖
 *    attrs_json → 后推顶掉先推，先推提案静默丢失（跨周期可乒乓）。
 * 2. 同 attrs 重推 → 同 id 幂等（不新增行；upsert 语义保持）。
 * 3. 不带 attrs 的旧派生逐位不变（旧数据兼容：不迁移旧行 id，仅影响新派生）。
 * 4. 重提案通道（reproposalOf）派生不变——其唯一性已由 `-r<代数>` 后缀承载，且该通道
 *    attrs 含非确定性时间戳（reproposed_at），纳入派生会破坏 #19 T12「同代幂等」合同。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../../store/sqlite.js";

/** 同 reason 文本（碰撞源：两个不同 promise 产出相同提案文案）。 */
const SAME_REASON = "样本证据显示该承诺已兑现，建议迁移至 kept 终态";

type PendingRow = { pending_id: string; slot: string; content: string; state: string; attrs_json?: string | null };
type StoreFace = {
  upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: Record<string, string>, extra?: { attrs?: Record<string, unknown>; reproposalOf?: string; reproposalGen?: number }) => boolean;
  listPendingCore: (tenant?: Record<string, string>) => PendingRow[];
};

describe("#49 · upsertPendingCore attrs 参与派生唯一性（真实 sqlite 合同）", () => {
  let store: InstanceType<typeof VectorStore>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tdb-pending-49-"));
    store = new VectorStore(join(dir, "v.db"), 0);
    await store.init();
  });
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  const s = (): StoreFace => store as unknown as StoreFace;

  it("同 slot 同 content 异 attrs（promiseId 不同）→ 两个 pending_id，attrs 各自保留（RED：现状静默覆盖丢失）", () => {
    const st = s();
    const t = { teamId: "t49a", userId: "u49", agentId: "a49" };
    expect(st.upsertPendingCore("promise_transition", SAME_REASON, 2, t, { attrs: { promiseId: "pm_A", to: "kept", origin: "reflection-promise" } })).toBe(true);
    expect(st.upsertPendingCore("promise_transition", SAME_REASON, 2, t, { attrs: { promiseId: "pm_B", to: "kept", origin: "reflection-promise" } })).toBe(true);
    const rows = st.listPendingCore(t).filter((r) => r.slot === "promise_transition" && r.content === SAME_REASON);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.pending_id)).size).toBe(2);
    const promiseIds = rows
      .map((r) => (JSON.parse(String(r.attrs_json ?? "{}")) as { promiseId?: string }).promiseId)
      .sort();
    expect(promiseIds).toEqual(["pm_A", "pm_B"]);
  });

  it("同 attrs 重推 → 幂等（同 id upsert，不新增行）", () => {
    const st = s();
    const t = { teamId: "t49b", userId: "u49", agentId: "a49" };
    const extra = { attrs: { promiseId: "pm_C", to: "kept", origin: "reflection-promise" } };
    expect(st.upsertPendingCore("promise_transition", SAME_REASON, 2, t, extra)).toBe(true);
    expect(st.upsertPendingCore("promise_transition", SAME_REASON, 5, t, extra)).toBe(true);
    const rows = st.listPendingCore(t).filter((r) => r.slot === "promise_transition" && r.content === SAME_REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe("pending");
  });

  it("无 attrs 旧派生不变：同 slot|content|tenant 幂等一行（旧数据兼容锚）", () => {
    const st = s();
    const t = { teamId: "t49c", userId: "u49", agentId: "a49" };
    expect(st.upsertPendingCore("core_value", "诚实优先于效率", 1, t)).toBe(true);
    expect(st.upsertPendingCore("core_value", "诚实优先于效率", 3, t)).toBe(true);
    const rows = st.listPendingCore(t).filter((r) => r.content === "诚实优先于效率");
    expect(rows.length).toBe(1);
    expect(rows[0]!.pending_id).toMatch(/^pd-[0-9a-f]{16}$/);
  });

  it("重提案通道派生不变：reproposalOf 同代重推（attrs 含非确定性时间戳）仍幂等一行（#19 T12 同代幂等锚）", () => {
    const st = s();
    const t = { teamId: "t49d", userId: "u49", agentId: "a49" };
    expect(st.upsertPendingCore("core_value", "取证先行：任何结论必须有证据支撑", 6, t, {
      attrs: { reproposed: true, supersedes: "pd-base", generation: 1, reproposed_at: "2026-10-17T00:00:00.000Z", evidence_threshold: 6 },
      reproposalOf: "pd-base",
      reproposalGen: 1,
    })).toBe(true);
    expect(st.upsertPendingCore("core_value", "取证先行：任何结论必须有证据支撑", 7, t, {
      attrs: { reproposed: true, supersedes: "pd-base", generation: 1, reproposed_at: "2026-10-17T09:30:00.000Z", evidence_threshold: 6 },
      reproposalOf: "pd-base",
      reproposalGen: 1,
    })).toBe(true);
    const rows = st.listPendingCore(t).filter((r) => r.content === "取证先行：任何结论必须有证据支撑");
    expect(rows.length).toBe(1);
  });
});
