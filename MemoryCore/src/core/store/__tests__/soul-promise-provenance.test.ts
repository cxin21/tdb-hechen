/**
 * #41（ADR0003-P3 实施票 C，D8 事件溯源）· soul_promises 溯源字段测试。
 *
 * 合同（#41 票面验收：全链审计 soul_promise_events 记录判定来源 manual/evidence/proposal）：
 * - soul_promises 增 ref_key 关联列（缺省 ''）；soul_promise_events 增 source 列（缺省 'manual'）；
 * - 创建事件 source='manual'（沿用 `created via ${source}` note 惯例）；
 * - transition opts.source 显式落列（evidence/proposal）；缺省 manual；
 * - 迁移拒绝时零写入（#35 双时态留痕不变式回归）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";

const T0 = Date.parse("2026-10-16T09:00:00.000Z");

describe("#41 · soul promise 溯源字段（ref_key + events.source）", () => {
  it("refKey 往返：upsert 带 refKey → list 返回；缺省 ''", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-prov-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };

      const withRef = await store.upsertSoulPromise!(t, {
        content: "周五前交付报告",
        source: "user",
        refKey: "task-9",
      });
      const rows = store.listSoulPromises!(t);
      expect(rows.find((r) => r.promiseId === withRef.promiseId)?.refKey).toBe("task-9");

      await store.upsertSoulPromise!(t, { content: "无关联承诺", source: "user" });
      const bare = store.listSoulPromises!(t).find((r) => r.refKey === "");
      expect(bare).toBeTruthy();
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("事件 source 溯源：创建=manual；迁移缺省=manual；显式 evidence/proposal 落列", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-prov-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };

      const p1 = await store.upsertSoulPromise!(t, { content: "p1", source: "user" });
      const p2 = await store.upsertSoulPromise!(t, { content: "p2", source: "reflection" });
      const p3 = await store.upsertSoulPromise!(t, { content: "p3", source: "user" });
      const at = new Date(T0).toISOString();

      expect(await store.transitionSoulPromise!(t, p1.promiseId, "kept", { at })).toEqual({ ok: true });
      expect(await store.transitionSoulPromise!(t, p2.promiseId, "broken", { at, source: "evidence" })).toEqual({ ok: true });
      expect(await store.transitionSoulPromise!(t, p3.promiseId, "withdrawn", { at, source: "proposal" })).toEqual({ ok: true });

      const e1 = store.readSoulPromiseEvents!(t, p1.promiseId);
      expect(e1.map((e) => e.source)).toEqual(["manual", "manual"]);
      const e2 = store.readSoulPromiseEvents!(t, p2.promiseId);
      expect(e2.map((e) => e.source)).toEqual(["manual", "evidence"]);
      const e3 = store.readSoulPromiseEvents!(t, p3.promiseId);
      expect(e3.map((e) => e.source)).toEqual(["manual", "proposal"]);
      expect(e1[0].note).toBe("created via user");
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("迁移拒绝零写入（#35 不变式回归：非法迁移不产生事件行）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-prov-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };
      const p = await store.upsertSoulPromise!(t, { content: "p", source: "user", refKey: "task-1" });

      expect(await store.transitionSoulPromise!(t, p.promiseId, "open", { source: "evidence" })).toMatchObject({ ok: false });
      const before = store.readSoulPromiseEvents!(t, p.promiseId).length;
      expect(before).toBe(1); // 仅创建事件
      expect(await store.transitionSoulPromise!(t, p.promiseId, "kept")).toEqual({ ok: true });
      expect(store.readSoulPromiseEvents!(t, p.promiseId).length).toBe(2);
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("旧库增量迁移：#35 形状库 → init 幂等 ALTER 补列 → 存量行回读缺省值 + 新写路径可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-prov-"));
    const dbPath = join(dir, "vectors.db");
    // 手工建 #35 时代旧形状库（soul_promises 无 ref_key；soul_promise_events 无 source）+ 一条存量行
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE soul_promises (
        promise_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL, resolved_at TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE soul_promise_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, promise_id TEXT NOT NULL, team_id TEXT NOT NULL,
        user_id TEXT NOT NULL, agent_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        at TEXT NOT NULL, note TEXT);
      INSERT INTO soul_promises (promise_id, team_id, user_id, agent_id, content, status, source, created_at, resolved_at, updated_at)
        VALUES ('pm_legacy', 't1', 'u1', 'a1', '旧库存量承诺', 'open', 'user', '2026-10-15T00:00:00.000Z', NULL, '2026-10-15T00:00:00.000Z');
    `);
    legacy.close();
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(dbPath, 0);
      await store.init(); // 幂等 try/ALTER 补 ref_key + source 两列
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };

      // 存量行读回：ref_key 列补齐后缺省 ''（NOT NULL DEFAULT 回填）
      const legacyRow = store.listSoulPromises!(t).find((r) => r.promiseId === "pm_legacy");
      expect(legacyRow?.refKey).toBe("");

      // 迁移后新写路径：refKey 落列 + transition source 落列
      const p = await store.upsertSoulPromise!(t, { content: "迁移后新承诺", source: "user", refKey: "task-m" });
      expect(
        await store.transitionSoulPromise!(t, p.promiseId, "kept", { source: "evidence", note: "[evidence:confirmation:kept]" }),
      ).toEqual({ ok: true });
      expect(store.readSoulPromiseEvents!(t, p.promiseId).map((e) => e.source)).toEqual(["manual", "evidence"]);
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
