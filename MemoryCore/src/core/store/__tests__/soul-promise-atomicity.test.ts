/**
 * #45（ADR0003 D8 存储加固）· soul promise 写面事务原子性。
 *
 * 合同（#45 票面：soul_promises UPDATE 与 soul_promise_events INSERT 两步必须包事务）：
 * - transitionSoulPromise：events INSERT 中途故障 → UPDATE 必须随整体回滚
 *   （promise 行 status 不变、事件数不变），故障继续向上抛（R5-F5 写面不吞错）；
 * - upsertSoulPromise：创建事件 INSERT 中途故障 → promise INSERT 必须随整体回滚（无半写行）。
 *
 * 故障注入用真实 SQLite 触发器（BEFORE INSERT ... RAISE(ABORT)），零 mock：
 * 中断窗口 = 第一步已落盘、第二步 RAISE——正是票面描述的事件溯源断链现场。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VectorStore } from "../sqlite.js";

const T0 = Date.parse("2026-10-16T09:00:00.000Z");

function dbOf(store: VectorStore): { exec(sql: string): void } {
  return (store as unknown as { db: { exec(sql: string): void } }).db;
}

describe("#45 · soul promise 写面事务原子性（事件写入故障必须整体回滚）", () => {
  it("transitionSoulPromise：events INSERT 失败 → UPDATE 回滚，status 不变、事件数不变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-atomic-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };
      // 故障注入：note='INJECT-FAULT' 的事件行写入即 ABORT（transition 第二步）
      dbOf(store).exec(`
        CREATE TRIGGER soul_promise_events_fault
        BEFORE INSERT ON soul_promise_events
        WHEN NEW.note = 'INJECT-FAULT'
        BEGIN
          SELECT RAISE(ABORT, 'injected fault: events insert failed');
        END;
      `);

      const p = await store.upsertSoulPromise!(t, { content: "p", source: "user" });
      const beforeEvents = store.readSoulPromiseEvents!(t, p.promiseId).length;
      expect(beforeEvents).toBe(1); // 仅创建事件

      let threw = false;
      try {
        await store.transitionSoulPromise!(t, p.promiseId, "kept", {
          at: new Date(T0).toISOString(),
          note: "INJECT-FAULT",
        });
      } catch (e) {
        // R5-F5 + 审查 D-low：只认触发器注入故障——无关原因的提前抛错不得假绿。
        threw = e instanceof Error && /injected fault/.test(e.message);
      }
      expect(threw).toBe(true);

      // 原子性合同：UPDATE 必须随 events INSERT 失败整体回滚
      const row = store.listSoulPromises!(t).find((r) => r.promiseId === p.promiseId);
      expect(row?.status).toBe("open");
      expect(store.readSoulPromiseEvents!(t, p.promiseId).length).toBe(beforeEvents);
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsertSoulPromise：创建事件 INSERT 失败 → promise INSERT 回滚，无半写行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-atomic-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };
      // 故障注入：创建事件 note='created via INJECT-FAULT' 命中触发器（upsert 第二步）
      dbOf(store).exec(`
        CREATE TRIGGER soul_promise_events_fault
        BEFORE INSERT ON soul_promise_events
        WHEN NEW.note = 'created via INJECT-FAULT'
        BEGIN
          SELECT RAISE(ABORT, 'injected fault: events insert failed');
        END;
      `);
      const beforeCount = store.listSoulPromises!(t).length;

      let threw = false;
      try {
        await store.upsertSoulPromise!(t, { content: "half-write?", source: "INJECT-FAULT" });
      } catch (e) {
        // 审查 D-low：只认触发器注入故障（RAISE 消息 'injected fault: ...'），无关抛错不得假绿。
        threw = e instanceof Error && /injected fault/.test(e.message);
      }
      expect(threw).toBe(true);

      // 原子性合同：promise 行必须随创建事件 INSERT 失败整体回滚
      expect(store.listSoulPromises!(t).length).toBe(beforeCount);
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
