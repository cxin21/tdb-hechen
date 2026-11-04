/**
 * A 项（ADR-0025 决定 10）配套迁移：memory_audit.action 的 CHECK 枚举扩容（存量库）。
 *
 * 缺陷实证：本批新增 action='sensitivity' 后，TS union 改了、但老库 DDL 仍是
 * CHECK (action IN ('update','delete'))。写 'sensitivity' 被库级 CHECK 拒绝 →
 * recordAudit 的 catch 只 warn（审计失败不得影响用户写）→ 降敏成功、审计静默丢失。
 * 所以必须有真·存量库用例：先手工建**旧 DDL** 的 memory_audit（含既有行），再跑
 * VectorStore.init()，验证 (1) 旧行不丢 (2) 新 action 可写 (3) CHECK 仍然拦脏值
 * (4) 迁移幂等（二次 init 不重复重建/不丢行）。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../sqlite.js";

const LEGACY_DDL = `
  CREATE TABLE memory_audit (
    audit_id      TEXT PRIMARY KEY,
    record_id     TEXT NOT NULL,
    layer         TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')),
    action        TEXT NOT NULL CHECK (action IN ('update','delete')),
    team_id       TEXT,
    agent_id      TEXT,
    user_id       TEXT,
    task_id       TEXT,
    version       INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    request_id    TEXT
  );
  CREATE INDEX idx_memory_audit_record ON memory_audit(record_id, updated_at_ms);
`;

function makeLegacyDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-legacy-"));
  const dbPath = path.join(dir, "vectors.db");
  const raw = new DatabaseSync(dbPath);
  raw.exec(LEGACY_DDL);
  raw
    .prepare(
      `INSERT INTO memory_audit (audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id, version, updated_at_ms, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("audit-legacy-1", "r-legacy", "L1", "update", "default", "a1", "u1", "", 3, 1000, "rq-old");
  raw.close();
  return { dir, dbPath };
}

function openStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return store;
}

type DbLike = { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } };
const ddlOf = (store: VectorStore): string =>
  (
    (store as unknown as DbLike).db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_audit'")
      .get() as { sql: string }
  ).sql;

describe("memory_audit.action 枚举扩容迁移（A 项）", () => {
  it("旧库升级：既有行不丢 + action='sensitivity' 可写 + CHECK 仍拦脏值", () => {
    const { dir, dbPath } = makeLegacyDb();
    let store: VectorStore | undefined;
    try {
      store = openStore(dbPath);
      // (1) DDL 已扩容
      expect(ddlOf(store)).toContain("'sensitivity'");
      // (2) 旧行原样保留
      const legacy = store.queryAudit({ record_id: "r-legacy" });
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ audit_id: "audit-legacy-1", action: "update", version: 3, request_id: "rq-old" });
      // (3) 新 action 真能落库（这是迁移的唯一目的；TS union 改不动库级 CHECK）
      store.appendAudit({
        audit_id: "audit-new-1",
        record_id: "r-legacy",
        layer: "L1",
        action: "sensitivity",
        team_id: "default",
        agent_id: "a1",
        user_id: "u1",
        version: 3,
        updated_at_ms: 2000,
        request_id: "rq-new",
      });
      const all = store.queryAudit({ record_id: "r-legacy" });
      expect(all.map((a) => a.action).sort()).toEqual(["sensitivity", "update"]);
      // (4) 约束没有被拆掉：脏 action 依旧被库级 CHECK 拦（迁移是扩容，不是放弃守卫）
      expect(() =>
        store!.appendAudit({
          audit_id: "audit-bogus",
          record_id: "r-legacy",
          layer: "L1",
          action: "bogus" as never,
          version: 0,
          updated_at_ms: 3000,
        }),
      ).toThrow();
    } finally {
      store?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等：已迁移库再次 init 不重建、不丢行", () => {
    const { dir, dbPath } = makeLegacyDb();
    let first: VectorStore | undefined;
    let second: VectorStore | undefined;
    try {
      first = openStore(dbPath);
      first.appendAudit({
        audit_id: "audit-new-2",
        record_id: "r-legacy",
        layer: "L1",
        action: "sensitivity",
        version: 3,
        updated_at_ms: 2000,
      });
      first.close();
      first = undefined;

      second = openStore(dbPath); // 第二次 init：DDL 已含 'sensitivity' → 直接跳过
      const rows = second.queryAudit({ record_id: "r-legacy" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.action).sort()).toEqual(["sensitivity", "update"]);
    } finally {
      first?.close();
      second?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
