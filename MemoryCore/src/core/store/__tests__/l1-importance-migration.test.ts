/**
 * P1 Task 7（worthiness importance，spec §6）：l1_records.importance 存储面 RED 套件。
 * 契约：
 *  - soul-columns 第 10 列 importance（TINYINT，FTS UNINDEXED）——编译期单一源；
 *  - l1_records 在线幂等 ALTER（旧库 TINYINT 无 DEFAULT → 既有行 NULL = 不罚）；
 *  - l1_fts 26 → 27 列重建迁移（migrateL1FtsSoul sentinel 换 importance；幂等 + 行数校验）；
 *  - 写链 NULL 透传：不带 importance 的 upsert → 列 NULL（不伪造默认分，P0 纪律）；
 *    upsert excluded.* 覆盖语义 = 漏拷即刷空（P0-T3 家族合同，v2-router/编辑链必须显式拷）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SOUL_COLUMNS, SOUL_COL_NAMES, SOUL_SELECT_FRAGMENT } from "../soul-columns.js";
import { buildFtsQuery, tokenizeForFts, VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "l1-importance-")), "vectors.db");
}

function makeStore(dbPath?: string): VectorStore {
  const store = new VectorStore(dbPath ?? tmpDb(), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return store;
}

const db = (store: VectorStore) => (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown } } }).db;

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    // overrides LAST（后键胜出；此前放最前导致 base 字段反向覆盖 over）
    ...over,
  }) as MemoryRecord;

describe("P1 Task 7 soul-columns 第 10 列（单一事实源）", () => {
  it("SOUL_COLUMNS 追加 importance TINYINT UNINDEXED；SELECT 片段/列名同步", () => {
    expect(SOUL_COLUMNS.length).toBe(10);
    const imp = SOUL_COLUMNS.find((c) => c.name === "importance");
    expect(imp).toBeDefined();
    expect(imp!.sqlType).toBe("TINYINT");
    expect(imp!.ftsSuffix).toBe("UNINDEXED");
    expect(SOUL_COL_NAMES).toContain("importance");
    expect(SOUL_SELECT_FRAGMENT).toContain("importance");
  });
});

describe("P1 Task 7 l1_records.importance 写链（NULL 透传 + excluded.* 合同）", () => {
  it("upsert 携 importance → 落库可读；不携 → NULL（不伪造默认分）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("imp1", { importance: 3 }), undefined);
    store.upsertL1(mkRecord("imp2"), undefined);
    const rows = await store.getL1ByIds(["imp1", "imp2"]);
    const byId = new Map(rows.map((r) => [r.record_id, r]));
    expect(byId.get("imp1")?.importance).toBe(3);
    expect(byId.get("imp2")?.importance ?? null).toBeNull();
  });

  it("重开库幂等：数据与 importance 值存活", async () => {
    const dbPath = tmpDb();
    const store = makeStore(dbPath);
    store.upsertL1(mkRecord("reopen", { importance: 7 }), undefined);
    const store2 = makeStore(dbPath);
    const rows = await store2.getL1ByIds(["reopen"]);
    expect(rows[0]?.importance).toBe(7);
  });

  it("FTS 通道透传 importance（searchL1Fts 行带 importance）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("fts1", { importance: 2, content: "寒暄问候" }), undefined);
    const hits = await store.searchL1Fts(buildFtsQuery("寒暄") ?? "寒暄", 5);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.record_id === "fts1");
    expect(hit?.importance).toBe(2);
  });

  it("getL1ByIds 回读 soul 完整：sensitivity 不丢（P0-T3 漏拷家族——丢了会把人工调整链的 soul 拷贝刷空）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("sens1", { sensitivity: "health", importance: 5 }), undefined);
    const rows = await store.getL1ByIds(["sens1"]);
    expect(rows[0]?.sensitivity).toBe("health");
  });

  it("PRAGMA：l1_records.importance 列存在；l1_fts 含 importance 列", () => {
    const store = makeStore();
    const l1Cols = db(store).prepare("PRAGMA table_info(l1_records)").all() as Array<{ name: string; type: string }>;
    const imp = l1Cols.find((c) => c.name === "importance");
    expect(imp).toBeDefined();
    expect(imp!.type).toBe("TINYINT");
    const ftsCols = db(store).prepare("PRAGMA table_info(l1_fts)").all() as Array<{ name: string }>;
    expect(ftsCols.map((c) => c.name)).toContain("importance");
  });
});

describe("P1 Task 7 migrateL1FtsSoul：26 → 27 列重建迁移（幂等 + 行数校验）", () => {
  /** 手工搭一个 D-3 时代旧库：l1_records 9 soul 列（无 importance）+ l1_fts 26 列。 */
  function makeLegacyDb(dbPath: string): void {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '', session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default', team_id TEXT DEFAULT 'default', task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0, timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '', timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '', updated_time TEXT DEFAULT '', metadata_json TEXT DEFAULT '{}',
        occurred_at TEXT DEFAULT '', valid_start TEXT DEFAULT '', valid_end TEXT DEFAULT '',
        certainty TEXT DEFAULT 'observed', source TEXT DEFAULT '',
        valence REAL, arousal REAL, significance REAL, sensitivity TEXT DEFAULT 'none'
      );
      CREATE VIRTUAL TABLE l1_fts USING fts5(
        content, content_original UNINDEXED, record_id UNINDEXED, type UNINDEXED, priority UNINDEXED,
        scene_name UNINDEXED, session_key UNINDEXED, session_id UNINDEXED, team_id UNINDEXED,
        task_id UNINDEXED, user_id UNINDEXED, agent_id UNINDEXED, version UNINDEXED,
        timestamp_str UNINDEXED, timestamp_start UNINDEXED, timestamp_end UNINDEXED, metadata_json UNINDEXED,
        occurred_at UNINDEXED, valid_start UNINDEXED, valid_end UNINDEXED, certainty UNINDEXED,
        source UNINDEXED, valence UNINDEXED, arousal UNINDEXED, significance UNINDEXED, sensitivity UNINDEXED
      );
    `);
    raw.prepare(
      `INSERT INTO l1_records (record_id, content, type, occurred_at, certainty, valence, significance, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy1", "寒暄问候旧记录", "episodic", "2026-01-01T00:00:00Z", "observed", 0.5, 0.8, "none");
    raw.prepare(
      `INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name, session_key, session_id,
        team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json,
        occurred_at, valid_start, valid_end, certainty, source, valence, arousal, significance, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      // content 列必须与写入侧同一函数分词（unicode61 依赖空格切 CJK token），
      // 未分词整串 = MATCH 搜不到（与 H-B9 教训同因）。
      tokenizeForFts("寒暄问候旧记录"), "寒暄问候旧记录", "legacy1", "episodic", 50, "", "k", "s",
      "default", "", "default", "default", 0, "2026-01-01T00:00:00Z", "", "", "{}",
      "2026-01-01T00:00:00Z", "", "", "observed", "", 0.5, null, 0.8, "none",
    );
    raw.close();
  }

  it("旧 26 列库 init 后自动重建 27 列；行数守恒；FTS 可查；二次调用幂等", async () => {
    const dbPath = tmpDb();
    makeLegacyDb(dbPath);
    const store = makeStore(dbPath);
    // 迁移已随 init 自动执行：l1_fts 现在 27 列
    const ftsCols = db(store).prepare("PRAGMA table_info(l1_fts)").all() as Array<{ name: string }>;
    expect(ftsCols.map((c) => c.name)).toContain("importance");
    // 旧数据原样存活
    const hits = await store.searchL1Fts("寒暄", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.record_id).toBe("legacy1");
    // 未评分旧行 → importance NULL（不罚语义）
    expect(hits[0]?.importance ?? null).toBeNull();
    // 幂等：再次调用 = 跳过（migrated:false）
    const again = store.migrateL1FtsSoul();
    expect(again).toEqual({ migrated: false, rows: 1 });
  });

  it("迁移保留既有 soul 值（valence/significance 回填自主表）", async () => {
    const dbPath = tmpDb();
    makeLegacyDb(dbPath);
    const store = makeStore(dbPath);
    const hits = await store.searchL1Fts("寒暄", 5);
    expect(hits[0]?.valence).toBeCloseTo(0.5, 12);
    expect(hits[0]?.significance).toBeCloseTo(0.8, 12);
    // sensitivity 不在 FtsSearchResult 映射上（D-3 cast 先例），此处只断言 soul 回填的两列。
  });
});
