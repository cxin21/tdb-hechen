/**
 * P2（spec §10.8）：存量库里 soul_person_relation.status 的三值 CHECK 必须在 init 时扩成四值，
 * 否则 'unverifiable' 写不进去，回指失败的边只能永远保持 NULL。
 *
 * 这里模拟「改前 schema」：旧三值 CHECK + 两行数据 + 两个索引，再跑 init，断言
 *   ① CHECK 已含 unverifiable ② 行原样保留 ③ 两个索引还在 ④ 现在真的能写 unverifiable。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-relation-status-migrate-")), "vectors.db");
}

const OLD_DDL = `CREATE TABLE soul_person_relation (
  rel_id       TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  subj_key     TEXT NOT NULL,
  pred         TEXT NOT NULL,
  inverse_pred TEXT,
  obj_key      TEXT,
  obj_name     TEXT,
  direction    TEXT NOT NULL DEFAULT 'out',
  quote        TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  event_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','disputed')),
  tense TEXT,
  confidence REAL DEFAULT 0.5,
  visibility TEXT DEFAULT 'shared',
  ended_by_event_id TEXT
)`;

describe("P2 §10.8：关系 status 枚举存量迁移", () => {
  it("旧三值 CHECK → init 后四值，数据与索引都保留", () => {
    const dbPath = tmpDb();
    {
      const db = new DatabaseSync(dbPath);
      db.exec(OLD_DDL);
      db.exec("CREATE INDEX idx_soul_rel_subj ON soul_person_relation(team_id, user_id, agent_id, subj_key)");
      db.exec("CREATE INDEX idx_soul_rel_obj ON soul_person_relation(team_id, user_id, agent_id, obj_key)");
      db.prepare(
        `INSERT INTO soul_person_relation
         (rel_id, team_id, user_id, agent_id, subj_key, pred, obj_key, quote, record_id, valid_from, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run("r-1", TENANT.teamId, TENANT.userId, TENANT.agentId, "p_he", "上级", "p_zhou", "原话", "m_1", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
      db.close();
    }

    const store = new VectorStore(dbPath, 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级：" + initRes.reason);

    const db = (store as unknown as { db: DatabaseSync }).db;
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='soul_person_relation'").get() as { sql?: string }).sql ?? "";
    expect(sql).toContain("'unverifiable'");
    const rows = store.listSoulPersonRelations(TENANT, { includeClosed: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relId).toBe("r-1");
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='soul_person_relation'").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_soul_rel_subj", "idx_soul_rel_obj"]));

    // 迁移后真的能写：直接 UPDATE 成 unverifiable（回指零命中的落点）。
    db.prepare("UPDATE soul_person_relation SET status='unverifiable' WHERE rel_id='r-1'").run();
    expect(store.listSoulPersonRelations(TENANT, { includeClosed: true })[0]!.status).toBe("unverifiable");

    // 幂等：再 init 一次不报错、不丢行。
    store.init();
    expect(store.listSoulPersonRelations(TENANT, { includeClosed: true })).toHaveLength(1);
  });
});
