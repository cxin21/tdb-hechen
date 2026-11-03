import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readChurnWindow } from "../churn-window.js";

/** 临时 SQLite（红线：测试只碰临时库，绝不碰 D:/TDB/data）。 */
function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "churn-window-"));
  const db = new DatabaseSync(join(dir, "vectors.db"));
  db.exec(`
    CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, created_time TEXT);
    CREATE TABLE l1_archive (record_id TEXT PRIMARY KEY, archived_at TEXT);
  `);
  return db;
}

function seed(
  db: DatabaseSync,
  liveIn: string[],
  liveOut: string[],
  archivedIn: string[],
  archivedOut: string[],
): void {
  const live = db.prepare("INSERT INTO l1_records (record_id, created_time) VALUES (?, ?)");
  [...liveIn, ...liveOut].forEach((ts, i) => live.run(`r${i}`, ts));
  const archived = db.prepare("INSERT INTO l1_archive (record_id, archived_at) VALUES (?, ?)");
  [...archivedIn, ...archivedOut].forEach((ts, i) => archived.run(`a${i}`, ts));
}

describe("readChurnWindow：churn 分子分母必须同一窗口（A）", () => {
  it("--since 给定时，archived 与 live 都只数 >= 窗口起点的行（边界含）", () => {
    const db = makeDb();
    try {
      seed(
        db,
        ["2026-10-23T00:00:00Z", "2026-10-25T00:00:00Z"],
        ["2026-10-22T23:59:59Z"],
        ["2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z"],
        ["2026-10-01T00:00:00Z"],
      );
      const r = readChurnWindow(db, [], "2026-10-23T00:00:00Z");
      expect(r).toEqual({ archived: 2, live: 2, windowFrom: "2026-10-23T00:00:00Z" });
    } finally {
      db.close();
    }
  });

  it("无 --since 时窗口 = 采样最老行 createdAt；live 是全表 COUNT，不随采样条数缩水", () => {
    const db = makeDb();
    try {
      seed(
        db,
        ["2026-10-24T00:00:00Z", "2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z"],
        ["2026-10-20T00:00:00Z"],
        ["2026-10-24T12:00:00Z"],
        ["2026-10-20T00:00:00Z"],
      );
      // rows 只模拟 --limit 1 的采样（1 行，最老 = 10-24），live 仍必须是同窗口全表 3 行
      const r = readChurnWindow(db, [{ createdAt: "2026-10-24T00:00:00Z" }]);
      expect(r).toEqual({ archived: 1, live: 3, windowFrom: "2026-10-24T00:00:00Z" });
    } finally {
      db.close();
    }
  });

  it("窗口起点取不到（空采样且无 --since）→ live=null，交给纯函数层把 ratio 标 null", () => {
    const db = makeDb();
    try {
      seed(db, ["2026-10-24T00:00:00Z"], [], ["2026-10-24T00:00:00Z"], []);
      expect(readChurnWindow(db, [])).toEqual({ archived: 0, live: null, windowFrom: null });
    } finally {
      db.close();
    }
  });

  it("空库 + --since → 两侧都 0，ratio 由纯函数层算成 0（不产 NaN）", () => {
    const db = makeDb();
    try {
      expect(readChurnWindow(db, [], "2026-10-23T00:00:00Z")).toEqual({
        archived: 0,
        live: 0,
        windowFrom: "2026-10-23T00:00:00Z",
      });
    } finally {
      db.close();
    }
  });
});
