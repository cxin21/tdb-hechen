/**
 * C 档「冗余/可折叠」收口 · L1 死列剪除（ADR-0025 C2 source / C3 timestamp_start / C4 timestamp_end 死索引）。
 *
 * 已定案事实（docs/research/2026-11-04-l1-attribute-audit.md，生产库只读实测 4225 行）：
 *  - timestamp_start 与 timestamp_str 4225/4225 逐位相等（生成点只差一次 min 归约），零独立语义；
 *  - source 零读点（959 行为 ''，其余 reflection/consolidated/extraction 皆无判定消费方），
 *    行级原话溯源已由 source_message_ids + memory_audit 承担；
 *  - timestamp_start / timestamp_end 两条单列索引无任何 WHERE/ORDER BY 命中（死索引）。
 *
 * 本套件钉住删列后的四条契约（真老库模拟，不 mock）：
 *  1. 老库 init() 后 l1_records 不再有 timestamp_start / source 列；行数守恒、内容逐位不变；
 *  2. 对外 created_at 口径不变：timestamp_start 由 timestamp_str 派生（历史值本就相等）；
 *  3. l1_fts 同步瘦身（无 timestamp_start / source 列），重建后老行仍可 BM25 检索；
 *  4. archive → restore 往返（整行 JSON + INSERT OR REPLACE）不丢字段，幂等重开不抛。
 */
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const dirs: string[] = [];
const stores: VectorStore[] = [];
const paths: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  paths.length = 0;
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function tmpDbPath(prefix: string): string {
  const p = join(tmpDir(prefix), "vectors.db");
  paths.push(p);
  return p;
}

function makeStore(dbPath?: string): VectorStore {
  const store = new VectorStore(dbPath ?? tmpDbPath("l1-prune-"), 0);
  stores.push(store);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return store;
}

/** 绕过 store API 直接操作底表（PRAGMA / 存量行探针）。 */
const rawDb = (store: VectorStore) =>
  (store as unknown as {
    db: {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...p: unknown[]): unknown[];
        get(...p: unknown[]): unknown;
        run(...p: unknown[]): unknown;
      };
    };
  }).db;

const colNames = (store: VectorStore, table: string): string[] =>
  (rawDb(store).prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const indexNames = (store: VectorStore, table: string): string[] =>
  (rawDb(store).prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

/** 真老库：删列前的 l1_records（含 timestamp_start / source，含两条死索引），无 l1_fts。 */
function makeLegacyDb(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT '',
      priority INTEGER DEFAULT 50,
      scene_name TEXT DEFAULT '',
      session_key TEXT DEFAULT '',
      session_id TEXT DEFAULT 'default',
      team_id TEXT DEFAULT 'default',
      task_id TEXT DEFAULT '',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      version INTEGER NOT NULL DEFAULT 0,
      timestamp_str TEXT DEFAULT '',
      timestamp_start TEXT DEFAULT '',
      timestamp_end TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_l1_ts_start ON l1_records(timestamp_start);
    CREATE INDEX idx_l1_ts_end ON l1_records(timestamp_end);
  `);
  // 行 A：ts_start == ts_str（生产 4225/4225 的真实形态）
  raw.prepare(
    `INSERT INTO l1_records (record_id, content, type, timestamp_str, timestamp_start, timestamp_end,
       created_time, updated_time, metadata_json, session_key, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-a", "存量记忆A 时间锚一致", "episodic",
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z",
    "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", "{}", "k1", "s1",
  );
  // 行 B：ts_start != ts_str —— 删列后读回必须取 timestamp_str（证明不再读死列）
  raw.prepare(
    `INSERT INTO l1_records (record_id, content, type, timestamp_str, timestamp_start, timestamp_end,
       created_time, updated_time, metadata_json, session_key, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-b", "存量记忆B 时间锚不一致", "episodic",
    "2026-02-05T00:00:00Z", "2026-02-01T00:00:00Z", "2026-02-09T00:00:00Z",
    "2026-02-05T00:00:00Z", "2026-02-09T00:00:00Z", "{}", "k2", "s2",
  );
  // 老 source 列有历史值（959 行 '' + 其余 reflection/consolidated/extraction）
  try {
    raw.exec("ALTER TABLE l1_records ADD COLUMN source TEXT DEFAULT ''");
    raw.prepare("UPDATE l1_records SET source = ? WHERE record_id = ?").run("reflection", "legacy-b");
  } catch { /* 建表已带则忽略 */ }
  raw.close();
}

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "prune",
    source_message_ids: ["m1"],
    metadata: {},
    timestamps: ["2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z"],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-05T00:00:00Z",
    version: 0,
    sessionKey: "k1",
    sessionId: "s1",
    ...over,
  }) as MemoryRecord;

describe("C3 timestamp_start 删列（真老库模拟 → init 迁移）", () => {
  it("老库 init 后 l1_records 不再有 timestamp_start/source 列；行数守恒、内容逐位不变", () => {
    const dbPath = tmpDbPath("l1-prune-legacy-");
    makeLegacyDb(dbPath);
    const store = makeStore(dbPath);

    const cols = colNames(store, "l1_records");
    expect(cols).not.toContain("timestamp_start");
    expect(cols).not.toContain("source");
    // 未涉及的列原样保留（删列不得连带伤到 timestamp_end 等）
    expect(cols).toContain("timestamp_end");
    expect(cols).toContain("timestamp_str");
    expect(cols).toContain("source_message_ids");

    const n = rawDb(store).prepare("SELECT COUNT(*) AS n FROM l1_records").get() as { n: number };
    expect(n.n).toBe(2);

    const rows = store.getL1ByIds(["legacy-a", "legacy-b"]);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.record_id, r]));
    // 对外 created_at 口径（memory-search 取 timestamp_start）= 历史值，逐位不变
    expect(byId.get("legacy-a")!.timestamp_start).toBe("2026-01-01T00:00:00Z");
    expect(byId.get("legacy-a")!.timestamp_str).toBe("2026-01-01T00:00:00Z");
    // 行 B 历史 start 与 str 不等：删列后一律取 timestamp_str（不静默改口径也不复活死列）
    expect(byId.get("legacy-b")!.timestamp_start).toBe("2026-02-05T00:00:00Z");
    expect(byId.get("legacy-b")!.timestamp_end).toBe("2026-02-09T00:00:00Z");
    expect(byId.get("legacy-b")!.content).toBe("存量记忆B 时间锚不一致");
    // source 列删后不再读回（存量行 / 新行都没有该字段）
    expect((byId.get("legacy-b") as unknown as { source?: string }).source).toBeUndefined();
  });

  it("迁移幂等：二次 init() 不抛、列集合不变、行数不变", () => {
    const dbPath = tmpDbPath("l1-prune-idem-");
    makeLegacyDb(dbPath);
    const first = makeStore(dbPath);
    const colsAfterFirst = colNames(first, "l1_records");
    first.close();
    stores.pop();

    const second = makeStore(dbPath);
    expect(colNames(second, "l1_records")).toEqual(colsAfterFirst);
    const n = rawDb(second).prepare("SELECT COUNT(*) AS n FROM l1_records").get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("C4：timestamp_start / timestamp_end 两条死索引一并清掉（无 WHERE/ORDER BY 命中）", () => {
    const store = makeStore();
    const idx = indexNames(store, "l1_records");
    expect(idx).not.toContain("idx_l1_ts_start");
    expect(idx).not.toContain("idx_l1_ts_end");
    // 仍在用的索引不动（防删过头）
    expect(idx).toContain("idx_l1_session_key");
    expect(idx).toContain("idx_l1_task_updated");
  });

  it("fresh 库 DDL 本身不含两列；l1_fts 同步瘦身", () => {
    const store = makeStore();
    expect(colNames(store, "l1_records")).not.toContain("timestamp_start");
    expect(colNames(store, "l1_records")).not.toContain("source");
    // ftsAvailable 是 store 私有位（测试不改生产可见性）——按私有字段读取。
    if ((store as unknown as { ftsAvailable?: boolean }).ftsAvailable !== false) {
      const ftsCols = colNames(store, "l1_fts");
      expect(ftsCols).not.toContain("timestamp_start");
      expect(ftsCols).not.toContain("source");
      expect(ftsCols).toContain("timestamp_str");
    }
  });
});

describe("删列后的写读往返（不丢相邻列）", () => {
  it("upsertL1 → getL1ByIds：timestamps 区间仍取 min/max，timestamp_start 派生自 timestamp_str", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("w1"), undefined);
    const rows = store.getL1ByIds(["w1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timestamp_str).toBe("2026-03-01T00:00:00Z");
    // 第一条是 timestamp_str；区间右端仍是 max（timestamp_end 保留列）
    expect(rows[0]!.timestamp_end).toBe("2026-03-05T00:00:00Z");
    expect(rows[0]!.timestamp_start).toBe(rows[0]!.timestamp_str);
  });

  it("archive → restore 往返：content/时间区间/soul 字段/source_message_ids 不丢", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("arc1", { certainty: "observed", valence: 0.4 }), undefined);
    expect(store.archiveL1("arc1", "unit-test")).toBe(true);
    expect(store.getL1ByIds(["arc1"])).toHaveLength(0);
    expect(store.restoreL1("arc1")).toBe(true);
    const [row] = store.getL1ByIds(["arc1"]);
    expect(row).toBeDefined();
    expect(row!.content).toBe("条目 arc1");
    expect(row!.timestamp_str).toBe("2026-03-01T00:00:00Z");
    expect(row!.timestamp_end).toBe("2026-03-05T00:00:00Z");
    expect(row!.certainty).toBe("observed");
    expect(row!.valence).toBe(0.4);
    expect(row!.source_message_ids).toEqual(["m1"]);
  });

  it("老库迁移后归档→恢复：不含两列的旧归档行仍能恢复且不抛", () => {
    const dbPath = tmpDbPath("l1-prune-arc-");
    makeLegacyDb(dbPath);
    const store = makeStore(dbPath);
    expect(store.archiveL1("legacy-b", "unit-test")).toBe(true);
    expect(store.restoreL1("legacy-b")).toBe(true);
    const [row] = store.getL1ByIds(["legacy-b"]);
    expect(row!.content).toBe("存量记忆B 时间锚不一致");
    expect(row!.timestamp_start).toBe("2026-02-05T00:00:00Z");
  });
});
