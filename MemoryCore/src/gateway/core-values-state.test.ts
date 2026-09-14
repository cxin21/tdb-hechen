/**
 * Task GROW RED 套件：钉住/退休/恢复 API + read include_retired（v2-router handler）。
 *
 * 契约（task-grow-brief §2 + 报告 §0.1）：
 *   - POST /core-memory/values/pin    {value_id, pinned: bool}
 *   - POST /core-memory/values/retire {value_id}
 *   - POST /core-memory/values/restore {value_id}（Panel 退休区[恢复]的显式端点）
 *   - handler 形态照抄 S1 values/delete：guard → store(tenant) → false=404 不伪成功（M-1）
 *   - /v3/core-memory/read 增可选 include_retired（默认 false，Panel 退休区用）
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleCoreMemoryValuesPin,
  handleCoreMemoryValuesRetire,
  handleCoreMemoryValuesRestore,
  handleCoreMemoryRead,
} from "./v2-router.js";

const ISO_A = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "s1" };
const AUTH = {} as never;

function mockStore(overrides: Record<string, unknown> = {}) {
  return {
    readCore: vi.fn(async () => []),
    listValues: vi.fn(async () => []),
    setValuePinned: vi.fn(async () => true),
    retireValue: vi.fn(async () => true),
    restoreValue: vi.fn(async () => true),
    ...overrides,
  };
}

function depsFor(store: unknown, iso: typeof ISO_A | undefined = ISO_A) {
  return {
    getStore: () => store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    requestIsolation: iso,
  } as never;
}

describe("POST /core-memory/values/pin", () => {
  it("透传 {value_id, pinned} 到 store.setValuePinned（按请求租户）", async () => {
    const store = mockStore();
    const res = await handleCoreMemoryValuesPin({ value_id: "candor", pinned: true }, AUTH, "req-pin-1", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.setValuePinned).toHaveBeenCalledWith("candor", true, expect.objectContaining({ teamId: "teamA", userId: "userA", agentId: "agentA" }));
  });

  it("缺 value_id → 400；pinned 非布尔 → 400；不触达 store", async () => {
    const store = mockStore();
    const res1 = await handleCoreMemoryValuesPin({ pinned: true }, AUTH, "req-pin-2", depsFor(store));
    expect(res1.code).toBe(400);
    const res2 = await handleCoreMemoryValuesPin({ value_id: "x", pinned: "yes" }, AUTH, "req-pin-3", depsFor(store));
    expect(res2.code).toBe(400);
    expect(store.setValuePinned).not.toHaveBeenCalled();
  });

  it("store false（不存在/vetoed/SQL 失败）→ 404 不伪成功（M-1）", async () => {
    const store = mockStore({ setValuePinned: vi.fn(async () => false) });
    const res = await handleCoreMemoryValuesPin({ value_id: "ghost", pinned: false }, AUTH, "req-pin-4", depsFor(store));
    expect(res.code).toBe(404);
  });

  it("无 store → 503；store 不支持 → 503", async () => {
    const res = await handleCoreMemoryValuesPin({ value_id: "x", pinned: true }, AUTH, "req-pin-5", depsFor(undefined));
    expect(res.code).toBe(503);
    const res2 = await handleCoreMemoryValuesPin({ value_id: "x", pinned: true }, AUTH, "req-pin-6", depsFor({}));
    expect(res2.code).toBe(503);
  });
});

describe("POST /core-memory/values/retire 与 /restore", () => {
  it("retire 透传 value_id（按请求租户）；false → 404", async () => {
    const store = mockStore();
    const res = await handleCoreMemoryValuesRetire({ value_id: "old-topic" }, AUTH, "req-ret-1", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.retireValue).toHaveBeenCalledWith("old-topic", expect.objectContaining({ teamId: "teamA" }));

    const store2 = mockStore({ retireValue: vi.fn(async () => false) });
    const res2 = await handleCoreMemoryValuesRetire({ value_id: "ghost" }, AUTH, "req-ret-2", depsFor(store2));
    expect(res2.code).toBe(404);
  });

  it("restore 透传 value_id；false → 404；缺 value_id → 400", async () => {
    const store = mockStore();
    const res = await handleCoreMemoryValuesRestore({ value_id: "old-topic" }, AUTH, "req-res-1", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.restoreValue).toHaveBeenCalledWith("old-topic", expect.objectContaining({ teamId: "teamA" }));

    const store2 = mockStore({ restoreValue: vi.fn(async () => false) });
    const res2 = await handleCoreMemoryValuesRestore({ value_id: "ghost" }, AUTH, "req-res-2", depsFor(store2));
    expect(res2.code).toBe(404);

    const res3 = await handleCoreMemoryValuesRestore({}, AUTH, "req-res-3", depsFor(store));
    expect(res3.code).toBe(400);
  });

  it("无 store / 不支持 → 503", async () => {
    expect((await handleCoreMemoryValuesRetire({ value_id: "x" }, AUTH, "req-ret-3", depsFor(undefined))).code).toBe(503);
    expect((await handleCoreMemoryValuesRetire({ value_id: "x" }, AUTH, "req-ret-4", depsFor({}))).code).toBe(503);
    expect((await handleCoreMemoryValuesRestore({ value_id: "x" }, AUTH, "req-res-4", depsFor({}))).code).toBe(503);
  });
});

describe("GET 读面 /core-memory/read include_retired（Panel 退休区）", () => {
  it("include_retired=true → listValues(tenant, {includeRetired:true})；默认 → {includeRetired:false}", async () => {
    const store = mockStore();
    await handleCoreMemoryRead({ include_retired: true }, AUTH, "req-read-1", depsFor(store));
    expect(store.listValues).toHaveBeenCalledWith(expect.objectContaining({ teamId: "teamA" }), { includeRetired: true });
    await handleCoreMemoryRead({}, AUTH, "req-read-2", depsFor(store));
    expect(store.listValues).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: "teamA" }), { includeRetired: false });
  });
});
