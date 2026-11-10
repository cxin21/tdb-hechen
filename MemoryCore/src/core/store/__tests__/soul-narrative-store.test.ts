/**
 * P6 叙事层存储（spec §4.8）：soul_narrative + soul_narrative_evidence。
 *
 * 三条硬约定：
 *  - 章节是「按周期（自然周）一版」的：同一租户同一 period_start 最多一条 active（部分唯一索引兜底），
 *    换版本走 supersedes_id 链，旧行 status=superseded 保留，绝不覆盖。
 *  - 章节与证据同一个事务：章进去了证据没进去 = 自传在补心理戏，宁可整章不落。
 *  - 遗忘是读侧的事（salience 按 period_end 衰减 + 注入门），这里不删行、不改 status。
 */

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SOUL_EVENT_DDL,
  SOUL_EVENT_MIGRATION_DDL,
  SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL,
} from "../soul-event-ddl.js";
import {
  commitSoulNarrativeChapter,
  getSoulNarrativeChapter,
  listSoulNarrativeChapters,
  listSoulNarrativeEvidenceRows,
  touchSoulNarrativeAccess,
} from "../soul-narrative-store.js";
import type { SoulNarrativeInsert } from "../soul-event-types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t2", userId: "u2", agentId: "a2" };
const NOW = "2026-11-10T09:00:00.000Z";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const ddl of SOUL_EVENT_DDL) db.exec(ddl);
  db.exec(SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL);
  return db;
}

function chapter(overrides: Partial<SoulNarrativeInsert> & { chapter_id: string }): SoulNarrativeInsert {
  return {
    period_start: "2026-09-01T00:00:00.000Z",
    period_end: "2026-10-01T00:00:00.000Z",
    title: "2026-09：纠错 3",
    summary: "09-03：一次纠错，你说「这里不对」，我回「改」。",
    hash: "h1",
    created_at: NOW,
    salience: 0.62,
    ...overrides,
  };
}

function evidence(chapterId: string, eventIds: string[]) {
  return eventIds.map((event_id) => ({ chapter_id: chapterId, event_id }));
}

describe("soul-narrative-store：章节 + 证据", () => {
  it("写一章与 1–3 条证据：读回来字段齐（salience/access/status），证据按章可查", () => {
    const db = makeDb();
    const res = commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({ chapter_id: "narr-2026-09-v1" }),
      evidence: evidence("narr-2026-09-v1", ["e1", "e2"]),
    });
    expect(res).toEqual({ inserted: true, superseded: 0 });

    const row = getSoulNarrativeChapter(db, TENANT, "narr-2026-09-v1");
    expect(row).not.toBeNull();
    expect(row!.title).toBe("2026-09：纠错 3");
    expect(row!.salience).toBeCloseTo(0.62, 5);
    expect(row!.access_count).toBe(0);
    expect(row!.last_accessed_at).toBeNull();
    expect(row!.status).toBe("active");
    expect(row!.version).toBe(1);

    expect(
      listSoulNarrativeEvidenceRows(db, TENANT, "narr-2026-09-v1").map((e) => e.event_id).sort(),
    ).toEqual(["e1", "e2"]);
    db.close();
  });

  it("同一期第二版：旧行被 superseded（保留）+ 新行 active，同期只剩一条 active", () => {
    const db = makeDb();
    commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({ chapter_id: "narr-2026-09-v1", version: 1 }),
      evidence: evidence("narr-2026-09-v1", ["e1"]),
    });
    const res = commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({
        chapter_id: "narr-2026-09-v2",
        version: 2,
        hash: "h2",
        summary: "09-05：改完了，你说「这次对了」。",
        supersedes_id: "narr-2026-09-v1",
      }),
      evidence: evidence("narr-2026-09-v2", ["e2"]),
      supersedeIds: ["narr-2026-09-v1"],
    });
    expect(res).toEqual({ inserted: true, superseded: 1 });

    const old = getSoulNarrativeChapter(db, TENANT, "narr-2026-09-v1");
    expect(old!.status).toBe("superseded");
    const active = listSoulNarrativeChapters(db, TENANT, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]!.chapter_id).toBe("narr-2026-09-v2");
    expect(active[0]!.supersedes_id).toBe("narr-2026-09-v1");
    // 旧版本不删诗：证据也还在（审计能回到当时那版引了哪几条）。
    expect(listSoulNarrativeEvidenceRows(db, TENANT, "narr-2026-09-v1")).toHaveLength(1);
    db.close();
  });

  it("矛盾章节拦截：绕过写者直接插第二条同期 active 会被唯一索引拒绝", () => {
    const db = makeDb();
    commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({ chapter_id: "narr-a" }),
      evidence: evidence("narr-a", ["e1"]),
    });
    const insert = db.prepare(
      `INSERT INTO soul_narrative
        (chapter_id, team_id, user_id, agent_id, period_start, period_end, title, summary, hash, status, created_at, salience)
       VALUES (?, 't1', 'u1', 'a1', ?, ?, 't', 's', 'h', 'active', ?, 0.5)`,
    );
    expect(() =>
      insert.run("narr-b", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", NOW),
    ).toThrow(/UNIQUE constraint failed/);
    // 不同租户同一 period 不冲突（索引带租户三列）。
    expect(() =>
      insert.run("narr-c", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", NOW),
    ).toThrow(); // 同租户仍冲突
    db.close();
  });

  it("同 chapter_id 重放：写入为 false、证据不翻倍", () => {
    const db = makeDb();
    const input = {
      chapter: chapter({ chapter_id: "narr-1" }),
      evidence: evidence("narr-1", ["e1", "e2"]),
    };
    expect(commitSoulNarrativeChapter(db, TENANT, input)).toEqual({ inserted: true, superseded: 0 });
    expect(commitSoulNarrativeChapter(db, TENANT, input)).toEqual({ inserted: false, superseded: 0 });
    expect(listSoulNarrativeEvidenceRows(db, TENANT, "narr-1")).toHaveLength(2);
    db.close();
  });

  it("租户隔离：list/get/证据都按租户三列收口", () => {
    const db = makeDb();
    commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({ chapter_id: "narr-t1" }),
      evidence: evidence("narr-t1", ["e1"]),
    });
    expect(listSoulNarrativeChapters(db, OTHER)).toHaveLength(0);
    expect(getSoulNarrativeChapter(db, OTHER, "narr-t1")).toBeNull();
    expect(listSoulNarrativeEvidenceRows(db, OTHER, "narr-t1")).toHaveLength(0);
    db.close();
  });

  it("access：注入取用才计数（access_count/ last_accessed_at），别的租户不动", () => {
    const db = makeDb();
    commitSoulNarrativeChapter(db, TENANT, {
      chapter: chapter({ chapter_id: "narr-1" }),
      evidence: evidence("narr-1", ["e1"]),
    });
    expect(touchSoulNarrativeAccess(db, TENANT, ["narr-1"], { now: NOW })).toEqual({ updated: 1 });
    expect(touchSoulNarrativeAccess(db, TENANT, ["narr-1"], { now: "2026-11-11T00:00:00.000Z" })).toEqual({
      updated: 1,
    });
    const row = getSoulNarrativeChapter(db, TENANT, "narr-1");
    expect(row!.access_count).toBe(2);
    expect(row!.last_accessed_at).toBe("2026-11-11T00:00:00.000Z");
    expect(touchSoulNarrativeAccess(db, OTHER, ["narr-1"], { now: NOW })).toEqual({ updated: 0 });
    db.close();
  });

  it("旧库（P6 前的表）跑迁移：新列补上、默认值正确、再跑一次幂等", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE soul_narrative (
      chapter_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      turning_points_json TEXT NOT NULL DEFAULT '[]',
      lessons_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      supersedes_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      created_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO soul_narrative (chapter_id, period_start, period_end, title, summary, hash, created_at)
      VALUES ('old-1', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '旧章', '旧摘要', 'h', '2026-09-01T00:00:00.000Z')`);
    for (let pass = 0; pass < 2; pass += 1) {
      // 只跑本表相关的那几条 ADD COLUMN：内存库没有其它 soul_* 表，全量跑会先撞「no such table」。
      for (const ddl of SOUL_EVENT_MIGRATION_DDL.filter((d) => d.includes("soul_narrative ADD COLUMN"))) {
        try {
          db.exec(ddl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/duplicate column name/i.test(msg)) throw err;
        }
      }
    }
    const cols = (
      db.prepare("PRAGMA table_info(soul_narrative)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    for (const col of ["salience", "access_count", "last_accessed_at", "updated_at"]) expect(cols).toContain(col);
    const row = db
      .prepare("SELECT salience, access_count, last_accessed_at FROM soul_narrative WHERE chapter_id = 'old-1'")
      .get() as unknown as { salience: number; access_count: number; last_accessed_at: string | null };
    expect(row.salience).toBeCloseTo(0.3, 5);
    expect(row.access_count).toBe(0);
    expect(row.last_accessed_at).toBeNull();
    db.exec(SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL);
    db.close();
  });
});
