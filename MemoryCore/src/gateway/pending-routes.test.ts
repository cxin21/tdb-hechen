/**
 * P2 Task 6（spec §7 O13）：/v3 pending 路由 handler——list（租户透传）+ decide
 * （adopt：strict_rule → validateCoreWrite+escapeXmlTags+upsertCore('panel-adopt')；
 *   core_value → upsertValue(growthValueId(content),…,'panel-adopt','manual')；幂等 404）。
 */
import { describe, it, expect, vi } from "vitest";
import { handleCoreMemoryPendingList, handleCoreMemoryPendingDecide } from "./v2-router.js";

const ISO_A = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "s1" };
const AUTH = {} as never;

const CFG = { memory: { coreMemory: { writeEnabled: true, allowedSlots: ["identity", "self_identity", "strict_rule"], maxContentLength: 2000 } } };

function depsFor(store: unknown, iso: typeof ISO_A | undefined = ISO_A, cfg: unknown = CFG) {
  return { getStore: () => store, logger: { debug() {}, info() {}, warn() {}, error() {} }, requestIsolation: iso, config: cfg } as never;
}

describe("POST /core-memory/pending/list", () => {
  it("透传租户与 include_decided 到 store.listPendingCore", async () => {
    const listPendingCore = vi.fn(() => [{ pending_id: "pd-1", slot: "strict_rule", content: "x", evidence: 1, state: "pending", created_at: "t", decided_at: null }]);
    const res = await handleCoreMemoryPendingList({ include_decided: true }, AUTH, "r1", depsFor({ listPendingCore }));
    expect(res.code).toBe(0);
    expect(listPendingCore).toHaveBeenCalledWith(expect.objectContaining({ teamId: "teamA", userId: "userA", agentId: "agentA" }), { includeDecided: true });
  });
  it("无 store / 不支持 → 503", async () => {
    expect((await handleCoreMemoryPendingList({}, AUTH, "r2", depsFor(undefined))).code).toBe(503);
    expect((await handleCoreMemoryPendingList({}, AUTH, "r3", depsFor({}))).code).toBe(503);
  });
});

describe("POST /core-memory/pending/decide", () => {
  function storeWith(slot: string, existing?: string, cv?: { label: string; description: string }) {
    return {
      decidePendingCore: vi.fn((_pid: string, _d: string, _t?: unknown) => ({ slot, content: "绝不泄露用户隐私数据", label: cv?.label, description: cv?.description })),
      upsertCore: vi.fn((_slot: string, _content: string, _by: string, _t?: unknown) => true),
      // V12-ADJ：readCore 供采纳合并语义（既有行保留+新行追加）
      readCore: vi.fn(() => (existing ? [{ slot, content: existing }] : [])),
      upsertValue: vi.fn((_id: string, _label: string, _w: number, _by: string, _t?: unknown, _v?: number, _o?: string, _nt?: string, _attrs?: { description?: string }) => true),
    };
  }
  it("adopt strict_rule → 合并语义：既有红线保留+采纳行追加（V12-ADJ）", async () => {
    const store = storeWith("strict_rule", "- 既有红线甲");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "adopted" }, AUTH, "r4", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.decidePendingCore).toHaveBeenCalledWith("pd-1", "adopted", expect.objectContaining({ teamId: "teamA" }));
    expect(store.upsertCore).toHaveBeenCalledWith("strict_rule", "- 既有红线甲\n- 绝不泄露用户隐私数据", "panel-adopt", expect.objectContaining({ teamId: "teamA" }));
    expect(store.upsertValue).not.toHaveBeenCalled();
  });
  it("adopt core_value → V12-CV 转换层：label 落锚+theme 池+description attrs", async () => {
    const store = storeWith("core_value", undefined, { label: "取证先行", description: "任何结论必须有证据支撑" });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r5", depsFor(store));
    expect(res.code).toBe(0);
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[0]).toMatch(/^auto-/);
    expect(call[1]).toBe("取证先行");
    expect(call[2]).toBe(0.5);
    expect(call[3]).toBe("panel-adopt");
    expect(call[6]).toBe("manual");
    expect(call[7]).toBe("theme");
    expect(call[8]).toEqual({ description: "任何结论必须有证据支撑" });
    expect(store.upsertCore).not.toHaveBeenCalled();
  });
  it("adopt core_value 无 label（旧格式提案）→ 422 门拦截，不落锚不暗箱裁决（V12-CV）", async () => {
    const store = storeWith("core_value");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2b", decision: "adopted" }, AUTH, "r5b", depsFor(store));
    expect(res.code).toBe(422);
    expect(store.upsertValue).not.toHaveBeenCalled();
  });
  it("reject → 只标记，不写任何核心对象", async () => {
    const store = storeWith("strict_rule");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-3", decision: "rejected" }, AUTH, "r6", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.upsertCore).not.toHaveBeenCalled();
    expect(store.upsertValue).not.toHaveBeenCalled();
  });
  it("decide null（不存在/已决）→ 404 不伪成功", async () => {
    const store = { decidePendingCore: vi.fn(() => null) };
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-x", decision: "adopted" }, AUTH, "r7", depsFor(store));
    expect(res.code).toBe(404);
  });
  it("缺 pending_id / 非法 decision → 400 不触达 store", async () => {
    const store = storeWith("strict_rule");
    expect((await handleCoreMemoryPendingDecide({ decision: "adopted" }, AUTH, "r8", depsFor(store))).code).toBe(400);
    expect((await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "maybe" }, AUTH, "r9", depsFor(store))).code).toBe(400);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });
  it("无 store / 不支持 → 503", async () => {
    expect((await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "adopted", }, AUTH, "r10", depsFor(undefined))).code).toBe(503);
    expect((await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "adopted", }, AUTH, "r11", depsFor({}))).code).toBe(503);
  });
});

describe("#12 T6：pending 采纳同名冲突（缺省安全优先，不静默覆盖）", () => {
  const existingActive = {
    value_id: "auto-exist12345", label: "取证先行", weight: 0.62, created_by: "auto-growth",
    valence: 1 as number | null, origin: "auto", pinned: 1, state: "active", node_type: "theme",
    attrs_json: null as string | null,
  };

  function cvStore(existing?: typeof existingActive, pendingDesc: string | null = "任何结论必须有证据支撑") {
    return {
      decidePendingCore: vi.fn(() => ({ slot: "core_value", content: "任何结论必须有证据支撑", label: "取证先行", description: pendingDesc })),
      upsertValue: vi.fn((..._a: unknown[]) => true),
      listPendingCore: vi.fn(() => [{ pending_id: "pd-2", slot: "core_value", content: "任何结论必须有证据支撑", label: "取证先行", description: pendingDesc, evidence: 3, state: "pending", created_at: "t" }]),
      listValuesAnyState: vi.fn(async () => (existing ? [{ ...existing }] : [])),
    };
  }
  const DATA = (res: { code: number }) => (res as unknown as { data?: Record<string, unknown> }).data ?? {};

  it("同名 active + pending 有 desc + existing 无 desc → 安全合并（保 weight/valence/node_type，仅补 desc）+ merged:true", async () => {
    const store = cvStore({ ...existingActive, attrs_json: null });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r20", depsFor(store));
    expect(res.code).toBe(0);
    expect(DATA(res).merged).toBe(true);
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[0]).toBe("auto-exist12345"); // 既有行原 id（不新建）
    expect(call[1]).toBe("取证先行");
    expect(call[2]).toBe(0.62);              // 既有 weight 不被 0.5 覆盖
    expect(call[5]).toBe(1);                 // 既有 valence 保留
    expect(call[6]).toBe("manual");
    expect(call[7]).toBe("theme");
    expect(call[8]).toEqual({ description: "任何结论必须有证据支撑" }); // 只补 desc
  });

  it("同名 active 且 existing 已有 desc → 409 + conflict 明细 + pending 保持 pending（裁决权不吞）", async () => {
    const store = cvStore({ ...existingActive, attrs_json: JSON.stringify({ description: "既有描述" }) }, "新描述");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r21", depsFor(store));
    expect(res.code).toBe(409);
    expect((res as unknown as { data?: { conflict?: unknown } }).data?.conflict).toBeTruthy();
    expect(store.decidePendingCore).not.toHaveBeenCalled();
    expect(store.upsertValue).not.toHaveBeenCalled();
  });

  it("同名 active 且 pending desc 消毒后为空（超长无句末标点）→ 409（无内容可安全合并）", async () => {
    const longNoPunct = "这是一个没有句末标点的超长提案内容".repeat(8);
    const store = {
      decidePendingCore: vi.fn(() => ({ slot: "core_value", content: longNoPunct, label: "取证先行", description: null })),
      upsertValue: vi.fn(() => true),
      listPendingCore: vi.fn(() => [{ pending_id: "pd-2", slot: "core_value", content: longNoPunct, label: "取证先行", description: null, evidence: 3, state: "pending", created_at: "t" }]),
      listValuesAnyState: vi.fn(async () => [{ ...existingActive, attrs_json: null }]),
    };
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r22", depsFor(store));
    expect(res.code).toBe(409);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("allow_overwrite:true → 显式覆盖（现行为）+ overwritten:true", async () => {
    const store = cvStore({ ...existingActive, attrs_json: JSON.stringify({ description: "既有描述" }) }, "新描述");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted", allow_overwrite: true }, AUTH, "r23", depsFor(store));
    expect(res.code).toBe(0);
    expect(DATA(res).overwritten).toBe(true);
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[2]).toBe(0.5); // 覆盖语义 = 现行为（新 weight）
    expect(call[8]).toEqual({ description: "新描述" });
  });

  // 评审 C1：冲突域=全态——retired/vetoed 同名行不得被 ON CONFLICT 静默复活
  it("同名 retired 锚 → 409 带 state=retired 明细（不静默复活）+ allow_overwrite:true 才显式复活采纳", async () => {
    const store = cvStore({ ...existingActive, state: "retired" });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r25", depsFor(store));
    expect(res.code).toBe(409);
    const conflict = DATA(res).conflict as { state?: string; hint?: string };
    expect(conflict.state).toBe("retired");
    expect(String(conflict.hint)).toContain("allow_overwrite");
    expect(store.decidePendingCore).not.toHaveBeenCalled();
    expect(store.upsertValue).not.toHaveBeenCalled();
    // 显式复活：allow_overwrite:true → 走直采路径（pending 被消费）
    const res2 = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted", allow_overwrite: true }, AUTH, "r26", depsFor(store));
    expect(res2.code).toBe(0);
    expect(DATA(res2).overwritten).toBe(true);
    expect(store.decidePendingCore).toHaveBeenCalledTimes(1);
  });

  it("同名 vetoed 锚 → 409 带 state=vetoed，且 allow_overwrite:true 也不得直采（永久否决）", async () => {
    const store = cvStore({ ...existingActive, state: "vetoed" });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted", allow_overwrite: true }, AUTH, "r27", depsFor(store));
    expect(res.code).toBe(409);
    const conflict = DATA(res).conflict as { state?: string; hint?: string };
    expect(conflict.state).toBe("vetoed");
    expect(String(conflict.hint)).toContain("veto");
    expect(store.decidePendingCore).not.toHaveBeenCalled();
    expect(store.upsertValue).not.toHaveBeenCalled();
  });

  // 评审 I1+I2：合并分支 attrs 先读后合并 + created_by 沿用既有行（auto-growth 不退出维护环）
  it("安全合并保留既有 attrs（aliases/descSource/lastDescRefreshEvidence）与 created_by", async () => {
    const store = cvStore({
      ...existingActive,
      created_by: "auto-growth",
      attrs_json: JSON.stringify({ aliases: ["取證"], descSource: "auto-refresh", lastDescRefreshEvidence: 7 }),
    });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r28", depsFor(store));
    expect(res.code).toBe(0);
    expect(DATA(res).merged).toBe(true);
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[3]).toBe("auto-growth"); // created_by 不被 panel-adopt 改写（I2）
    expect(call[8]).toEqual({
      aliases: ["取證"],
      descSource: "auto-refresh",
      lastDescRefreshEvidence: 7,
      description: "任何结论必须有证据支撑", // 仅补 desc（I1）
    });
  });

  it("无同名冲突 → 现行为不变（新建 0.5 manual）", async () => {
    const store = cvStore(undefined);
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r24", depsFor(store));
    expect(res.code).toBe(0);
    expect(DATA(res).merged).toBeUndefined();
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[2]).toBe(0.5);
  });
});

describe("#12 T6：pending list 冲突标记（conflict 徽标数据源）", () => {
  it("core_value 提案 label 与 active 锚同名 → conflict:true；否则 false", async () => {
    const existing = { value_id: "auto-exist12345", label: "取证先行", weight: 0.62, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "active", node_type: "theme", attrs_json: null };
    const store = {
      listPendingCore: vi.fn(() => [
        { pending_id: "pd-2", slot: "core_value", content: "c1", label: "取证先行", description: "d", evidence: 3, state: "pending", created_at: "t" },
        { pending_id: "pd-3", slot: "core_value", content: "c2", label: "别的主题", description: "d", evidence: 3, state: "pending", created_at: "t" },
        { pending_id: "pd-4", slot: "strict_rule", content: "c3", evidence: 1, state: "pending", created_at: "t" },
      ]),
      listValuesAnyState: vi.fn(async () => [existing]),
    };
    const res = await handleCoreMemoryPendingList({}, AUTH, "r30", depsFor(store));
    expect(res.code).toBe(0);
    const rows = (res as unknown as { data: { pending: Array<{ pending_id: string; conflict?: boolean }> } }).data.pending;
    expect(rows.find((r) => r.pending_id === "pd-2")?.conflict).toBe(true);
    expect(rows.find((r) => r.pending_id === "pd-3")?.conflict).toBe(false);
    expect(rows.find((r) => r.pending_id === "pd-4")?.conflict).toBe(false);
  });
  it("评审 C1 口径统一：retired/vetoed 同名同样标记 conflict（与 decide 预检同域=全态）", async () => {
    const store = {
      listPendingCore: vi.fn(() => [
        { pending_id: "pd-2", slot: "core_value", content: "c1", label: "取证先行", description: "d", evidence: 3, state: "pending", created_at: "t" },
      ]),
      listValuesAnyState: vi.fn(async () => [
        { value_id: "auto-r1", label: "取证先行", weight: 0.4, created_by: "auto-growth", valence: null, origin: "auto", pinned: 0, state: "retired", node_type: "theme", attrs_json: null },
        { value_id: "auto-v1", label: "另一 vetoed", weight: 0.4, created_by: "manual", valence: null, origin: "manual", pinned: 0, state: "vetoed", node_type: "theme", attrs_json: null },
      ]),
    };
    const res = await handleCoreMemoryPendingList({}, AUTH, "r30b", depsFor(store));
    const rows = (res as unknown as { data: { pending: Array<{ conflict?: boolean }> } }).data.pending;
    expect(rows[0]?.conflict).toBe(true); // retired 同名 → 徽标亮
  });
  it("store 无 listValuesAnyState（特性探测）→ conflict 全 false", async () => {
    const store = { listPendingCore: vi.fn(() => [{ pending_id: "pd-2", slot: "core_value", content: "c", label: "取证先行", evidence: 3, state: "pending", created_at: "t" }]) };
    const res = await handleCoreMemoryPendingList({}, AUTH, "r31", depsFor(store));
    const rows = (res as unknown as { data: { pending: Array<{ conflict?: boolean }> } }).data.pending;
    expect(rows[0]?.conflict).toBe(false);
  });
});
