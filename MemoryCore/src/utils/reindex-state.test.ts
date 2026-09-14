// src/utils/reindex-state.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getReindexState, setReindexState, scheduleReindex, __resetReindexStateForTests } from "./reindex-state.js";

beforeEach(() => __resetReindexStateForTests());

describe("reindex-state", () => {
  it("初始 idle", () => expect(getReindexState().status).toBe("idle"));
  it("scheduleReindex 成功 → running → done 并写 counts", async () => {
    const store = { reindexAll: vi.fn(async () => ({ l1Count: 3, l0Count: 7 })) };
    const embedding = { embed: vi.fn(async () => new Float32Array(8)) };
    scheduleReindex(store as any, embedding as any, console);
    expect(getReindexState().status).toBe("running");
    await vi.waitFor(() => expect(getReindexState().status).toBe("done"));
    expect(getReindexState().l1Count).toBe(3);
    expect(getReindexState().l0Count).toBe(7);
  });
  it("失败 → failed + reason 可见", async () => {
    const store = { reindexAll: vi.fn(async () => { throw new Error("boom"); }) };
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    await vi.waitFor(() => expect(getReindexState().status).toBe("failed"));
    expect(getReindexState().reason).toContain("boom");
  });
  it("running 期间重复调度被拒", async () => {
    const store = { reindexAll: vi.fn(() => new Promise<{ l1Count: number; l0Count: number }>(() => {})) }; // 永不 resolve
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    // F5 后 reindexAll 延后至微任务（Promise.resolve().then），flush 后再断言只被调用一次
    await vi.waitFor(() => expect(store.reindexAll).toHaveBeenCalledTimes(1));
    expect(getReindexState().status).toBe("running"); // 第二次调度被守卫拒绝，状态未被破坏
    setReindexState({ status: "idle" });
  });
  it("reindexAll 同步 throw → 状态 failed 而非 running 卡死（F5 同步兜底）", async () => {
    const store = { reindexAll: vi.fn(() => { throw new Error("sync boom"); }) };
    expect(() => scheduleReindex(store as any, { embed: vi.fn() } as any, console)).not.toThrow();
    expect(getReindexState().status).toBe("running");
    await vi.waitFor(() => expect(getReindexState().status).toBe("failed"));
    expect(getReindexState().reason).toContain("sync boom");
  });
});
