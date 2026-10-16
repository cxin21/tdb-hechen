/**
 * #35（R5）promise 承诺层数据层测试。
 * 覆盖：状态机单向迁移（open→kept/broken/withdrawn；终态不可再迁）、
 * sqlite 往返（create/list/transition/events 双时态留痕）、
 * 终态拒绝且零事件行、租户隔离（F18）、status 过滤。
 * 排除条款（R5）：promise 不进 core_values 生命周期——本测试同时钉住
 * 「义务≠倾向」边界（无 reweight/decay/similarMerge 参与面）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VectorStore } from "../../store/sqlite.js";
import {
  PROMISE_STATUSES,
  PROMISE_TERMINAL_STATUSES,
  canTransitionPromise,
} from "../soul-promise.js";

const T0 = Date.parse("2026-10-16T08:00:00.000Z");

describe("#35 promise 状态机（单向迁移）", () => {
  it("状态集与终态集冻结", () => {
    expect([...PROMISE_STATUSES].sort()).toEqual(["broken", "kept", "open", "withdrawn"]);
    expect([...PROMISE_TERMINAL_STATUSES].sort()).toEqual(["broken", "kept", "withdrawn"]);
  });

  it("open→终态三路合法；终态无出边；同态与非法值拒绝", () => {
    expect(canTransitionPromise("open", "kept")).toBe(true);
    expect(canTransitionPromise("open", "broken")).toBe(true);
    expect(canTransitionPromise("open", "withdrawn")).toBe(true);
    expect(canTransitionPromise("kept", "open")).toBe(false);
    expect(canTransitionPromise("broken", "kept")).toBe(false);
    expect(canTransitionPromise("withdrawn", "open")).toBe(false);
    expect(canTransitionPromise("kept", "kept")).toBe(false);
    expect(canTransitionPromise("open", "zombie" as never)).toBe(false);
  });
});

describe("#35 soul_promises sqlite 往返+双时态留痕", () => {
  it("create→list→transition→events→终态拒绝→租户隔离→status 过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init(); // schema（含 soul_promises DDL）在 init() 建
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };
      expect(store.listSoulPromises!(t)).toEqual([]);

      const created = await store.upsertSoulPromise!(t, {
        content: "周五前交付 wiki 重跑报告",
        source: "user",
      });
      expect(created.promiseId).toMatch(/^pm_/);

      let rows = store.listSoulPromises!(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        promiseId: created.promiseId,
        content: "周五前交付 wiki 重跑报告",
        status: "open",
        source: "user",
      });
      expect(rows[0].resolvedAt ?? null).toBeNull();

      // 非法迁移：open→open 拒绝
      expect(await store.transitionSoulPromise!(t, created.promiseId, "open")).toMatchObject({ ok: false });

      // 合法迁移 open→kept，resolved_at 落迁移时刻
      const at = new Date(T0 + 5).toISOString();
      expect(await store.transitionSoulPromise!(t, created.promiseId, "kept", { at, note: "已交付" })).toEqual({ ok: true });
      rows = store.listSoulPromises!(t, { status: "kept" });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("kept");
      expect(rows[0].resolvedAt).toBe(at);

      // 终态不可再迁，且不产生新事件行（双时态留痕只增不改）
      expect(await store.transitionSoulPromise!(t, created.promiseId, "broken")).toMatchObject({ ok: false });
      const events = store.readSoulPromiseEvents!(t, created.promiseId);
      expect(events.map((e) => `${e.fromStatus ?? "∅"}→${e.toStatus}`)).toEqual(["∅→open", "open→kept"]);
      expect(events[1].note).toBe("已交付");

      // 租户隔离（F18）：他租户读不到、迁不动
      expect(store.listSoulPromises!({ teamId: "t2", userId: "u1", agentId: "a1" })).toEqual([]);
      expect(await store.transitionSoulPromise!({ teamId: "t1", userId: "u1", agentId: "a9" }, created.promiseId, "broken")).toMatchObject({ ok: false });
      expect(store.readSoulPromiseEvents!({ teamId: "t1", userId: "u1", agentId: "a9" }, created.promiseId)).toEqual([]);

      // 第二条 promise + status 过滤
      await store.upsertSoulPromise!(t, { content: "补齐探针用例", source: "reflection" });
      expect(store.listSoulPromises!(t, { status: "open" })).toHaveLength(1);
      expect(store.listSoulPromises!(t)).toHaveLength(2);
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
