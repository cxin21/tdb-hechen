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
  function storeWith(slot: string, existing?: string) {
    return {
      decidePendingCore: vi.fn((_pid: string, _d: string, _t?: unknown) => ({ slot, content: "绝不泄露用户隐私数据" })),
      upsertCore: vi.fn((_slot: string, _content: string, _by: string, _t?: unknown) => true),
      // V12-ADJ：readCore 供采纳合并语义（既有行保留+新行追加）
      readCore: vi.fn(() => (existing ? [{ slot, content: existing }] : [])),
      upsertValue: vi.fn((_id: string, _label: string, _w: number, _by: string, _t?: unknown, _v?: number, _o?: string) => true),
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
  it("adopt core_value → upsertValue(growthValueId, content, 0.5, 'panel-adopt', tenant, undefined, 'manual')", async () => {
    const store = storeWith("core_value");
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-2", decision: "adopted" }, AUTH, "r5", depsFor(store));
    expect(res.code).toBe(0);
    const call = store.upsertValue.mock.calls[0]!;
    expect(call[1]).toBe("绝不泄露用户隐私数据");
    expect(call[2]).toBe(0.5);
    expect(call[3]).toBe("panel-adopt");
    expect(call[6]).toBe("manual");
    expect(store.upsertCore).not.toHaveBeenCalled();
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
    expect((await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "adopted" }, AUTH, "r10", depsFor(undefined))).code).toBe(503);
    expect((await handleCoreMemoryPendingDecide({ pending_id: "pd-1", decision: "adopted" }, AUTH, "r11", depsFor({}))).code).toBe(503);
  });
});
