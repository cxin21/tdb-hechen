import { test, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initIndexDb, loadVecExtension } from "../src/engines/wiki/index-db.js";

test("loadVecExtension loads on better-sqlite3", () => {
  const db = new Database(":memory:");
  const ok = loadVecExtension(db);
  expect(ok).toBe(true);
  db.exec("CREATE VIRTUAL TABLE t USING vec0(embedding float[3])");
  expect(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='t'").get().c).toBe(1);
  db.close();
});

/** 读 wiki_vec 表维度（从 sqlite_master.sql 提取 float[N]）；表不存在 → null。 */
function wikiVecDim(wikiDir: string): number | null {
  const db = new Database(join(wikiDir, "index.db"));
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_vec'").get() as
      | { sql: string }
      | undefined;
    if (!row) return null;
    const m = /float\[(\d+)\]/.exec(row.sql);
    return m ? Number(m[1]) : null;
  } finally {
    db.close();
  }
}

/** 读 wiki_vec 建表 sql（从 sqlite_master）；表不存在 → null。 */
function wikiVecSql(wikiDir: string): string | null {
  const db = new Database(join(wikiDir, "index.db"));
  try {
    return (
      (db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_vec'")
        .get() as { sql: string } | undefined)?.sql ?? null
    );
  } finally {
    db.close();
  }
}

/** 临时 wiki 目录（跨平台：node:os/path/fs，无硬编码分隔符）。 */
function tempWikiDir(): string {
  return mkdtempSync(join(tmpdir(), "wikivec-"));
}

test("initIndexDb without dimensions leaves wiki_vec absent", () => {
  const dir = tempWikiDir();
  try {
    initIndexDb(dir); // dimensions 默认 0 → 不建向量表（与未配置 embedding 时一致）
    expect(wikiVecDim(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initIndexDb with dimensions>0 creates wiki_vec", () => {
  const dir = tempWikiDir();
  try {
    initIndexDb(dir, 4);
    expect(wikiVecDim(dir)).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initIndexDb rebuilds wiki_vec when content_sha column missing", () => {
  const dir = tempWikiDir();
  try {
    // 模拟"旧 schema"：手工建一张无 content_sha 的 wiki_vec（vec0 表不支持 ALTER ADD COLUMN）
    const db = new Database(join(dir, "index.db"));
    loadVecExtension(db);
    db.exec(
      `CREATE VIRTUAL TABLE wiki_vec USING vec0(
        page_id TEXT PRIMARY KEY,
        embedding float[4] distance_metric=cosine,
        updated_time TEXT DEFAULT ''
      )`,
    );
    db.close();
    expect(wikiVecSql(dir)).not.toContain("content_sha");

    // 缺 content_sha → 应 DROP 重建为含 content_sha 的新 schema
    initIndexDb(dir, 4);
    expect(wikiVecSql(dir)).toContain("content_sha");
    expect(wikiVecDim(dir)).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initIndexDb rebuilds wiki_vec when dimension changes", () => {
  const dir = tempWikiDir();
  try {
    initIndexDb(dir, 4);
    expect(wikiVecDim(dir)).toBe(4);
    initIndexDb(dir, 8); // 维度变更 → 应 DROP 重建为 float[8]
    expect(wikiVecDim(dir)).toBe(8);
    initIndexDb(dir, 8); // 维度未变 → 幂等，保持 float[8]
    expect(wikiVecDim(dir)).toBe(8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});