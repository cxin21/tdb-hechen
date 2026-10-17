/**
 * #44（ADR0003 D8 · (c) 提案通道，2026-10-17）：pending decide → promise 迁移采纳分支。
 *
 * 合同（D-44 单元③）：
 * - pre-decide（listPendingCore 特性探测可用时）：slot=promise_transition 行先验——
 *   store 无 transitionSoulPromise → 503（裁决不发生，pending 保持 pending）；
 *   attrs_json 缺失/坏/非法目标 → 422（不暗箱裁决）。
 * - adopted：applyAdoptedPromiseTransition（#41 唯一写入口，source="proposal"，
 *   note="[proposal] reason"）→ 成功 envelope 加 promiseTransition 字段；
 *   store 竞态 {ok:false} → 409（幂等收尾，pending 已裁决为 adopted——镜像 core_value 422 先例的
 *   post-decide 语义边界）。
 * - rejected：零 promise 写入。
 */
import { describe, expect, it, vi } from "vitest";
import { handleCoreMemoryPendingDecide } from "./v2-router.js";

const ISO_A = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "s1" };
const AUTH = {} as never;

function depsFor(store: unknown, iso: typeof ISO_A | undefined = ISO_A) {
  return { getStore: () => store, logger: { debug() {}, info() {}, warn() {}, error() {} }, requestIsolation: iso, config: { memory: { coreMemory: { writeEnabled: true, allowedSlots: ["identity"], maxContentLength: 2000 } } } } as never;
}

function promiseStore(over: Record<string, unknown> = {}) {
  return {
    decidePendingCore: vi.fn(() => ({ slot: "promise_transition", content: "后续对话确认报告已交付完成", label: null, description: null })),
    listPendingCore: vi.fn(async () => [
      { pending_id: "pd-p1", slot: "promise_transition", content: "后续对话确认报告已交付完成", state: "pending", attrs_json: JSON.stringify({ promiseId: "pm_1", to: "kept", refKey: "t-9" }) },
    ]),
    transitionSoulPromise: vi.fn(() => ({ ok: true })),
    ...over,
  };
}

describe("#44 · pending decide → promise 迁移采纳分支", () => {
  it("adopted → applyAdoptedPromiseTransition（source=proposal，note=[proposal] reason）+ envelope.promiseTransition", async () => {
    const store = promiseStore();
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "adopted" }, AUTH, "rp1", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.transitionSoulPromise).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "teamA", userId: "userA", agentId: "agentA" }),
      "pm_1",
      "kept",
      { source: "proposal", note: "[proposal] 后续对话确认报告已交付完成" },
    );
    expect((res.data as { promiseTransition?: { ok: boolean; promiseId: string; to: string } }).promiseTransition).toEqual({ ok: true, promiseId: "pm_1", to: "kept" });
  });

  it("store 无 transitionSoulPromise → 503 且裁决不发生（decidePendingCore 未调）", async () => {
    const store = promiseStore({ transitionSoulPromise: undefined });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "adopted" }, AUTH, "rp2", depsFor(store));
    expect(res.code).toBe(503);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("attrs_json 缺失 → 422 且裁决不发生", async () => {
    const store = promiseStore({
      listPendingCore: vi.fn(async () => [{ pending_id: "pd-p1", slot: "promise_transition", content: "x", state: "pending" }]),
    });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "adopted" }, AUTH, "rp3", depsFor(store));
    expect(res.code).toBe(422);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
    expect(store.transitionSoulPromise).not.toHaveBeenCalled();
  });

  it("attrs 目标非法（to 非 terminal）→ 422 且裁决不发生", async () => {
    const store = promiseStore({
      listPendingCore: vi.fn(async () => [
        { pending_id: "pd-p1", slot: "promise_transition", content: "x", state: "pending", attrs_json: JSON.stringify({ promiseId: "pm_1", to: "done" }) },
      ]),
    });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "adopted" }, AUTH, "rp4", depsFor(store));
    expect(res.code).toBe(422);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("竞态：store 返回 {ok:false} → 409 幂等收尾", async () => {
    const store = promiseStore({ transitionSoulPromise: vi.fn(() => ({ ok: false, reason: "invalid-transition" })) });
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "adopted" }, AUTH, "rp5", depsFor(store));
    expect(res.code).toBe(409);
  });

  it("rejected → 零 promise 写入", async () => {
    const store = promiseStore();
    const res = await handleCoreMemoryPendingDecide({ pending_id: "pd-p1", decision: "rejected" }, AUTH, "rp6", depsFor(store));
    expect(res.code).toBe(0);
    expect(store.transitionSoulPromise).not.toHaveBeenCalled();
  });
});
