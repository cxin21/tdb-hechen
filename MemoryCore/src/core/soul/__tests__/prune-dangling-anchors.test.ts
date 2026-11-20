import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// R32-10：清理脚本必须只摘「按命名空间解析不到」的锚，能解析的锚一个都不能动，
// 并且 apply 前要留备份与审计文件（否则等于悄悄改数据）。
const SCRIPT = path.resolve(__dirname, "../../../../scripts/prune-dangling-drift-anchors.mjs");

function buildDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prune-anchors-"));
  const dbPath = path.join(dir, "vectors.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, source_message_ids TEXT)");
  db.exec("CREATE TABLE l1_archive (record_id TEXT PRIMARY KEY, data TEXT)");
  db.exec("CREATE TABLE soul_episodes (episode_id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE soul_persona (item_id TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, agent_id TEXT, meta_json TEXT)");
  db.prepare("INSERT INTO l1_records (record_id, source_message_ids) VALUES (?, ?)").run("msg-keep", JSON.stringify(["msg-src-ok"]));
  db.prepare("INSERT INTO soul_episodes (episode_id) VALUES (?)").run("ep-keep");
  db.prepare("INSERT INTO soul_persona (item_id, team_id, user_id, agent_id, meta_json) VALUES (?,?,?,?,?)").run(
    "identity:test",
    "team-t",
    "usr-t",
    "agt-t",
    JSON.stringify({ lastDrift: { anchorKey: "k", anchorIds: ["msg-keep", "msg-src-ok", "ep-keep", "msg-gone"] } }),
  );
  db.close();
  return dir;
}

function run(dir: string, extra: string[] = []): Record<string, unknown> {
  const out = execFileSync(process.execPath, [SCRIPT, "--db", path.join(dir, "vectors.db"), ...extra], { encoding: "utf8" });
  const lastJson = out.trim().split(/\r?\n/u).filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
  return JSON.parse(lastJson) as Record<string, unknown>;
}

describe("prune-dangling-drift-anchors", () => {
  it("dry-run 只报解析不到的锚，不改数据", () => {
    const dir = buildDb();
    const before = readFileSync(path.join(dir, "vectors.db"));
    const summary = run(dir);
    expect(summary.mode).toBe("dry-run");
    expect(summary.itemsWithDangling).toBe(1);
    expect(summary.danglingIds).toBe(1);
    expect(readFileSync(path.join(dir, "vectors.db")).equals(before)).toBe(true);
  });

  it("apply 只摘悬空锚，保留其余三个，并留备份与审计", () => {
    const dir = buildDb();
    const summary = run(dir, ["--apply"]);
    expect(summary.updated).toBe(1);
    const db = new DatabaseSync(path.join(dir, "vectors.db"), { readOnly: true });
    const row = db.prepare("SELECT meta_json FROM soul_persona WHERE item_id = ?").get("identity:test") as { meta_json: string };
    db.close();
    const meta = JSON.parse(row.meta_json) as { lastDrift: { anchorIds: string[] } };
    expect(meta.lastDrift.anchorIds).toEqual(["msg-keep", "msg-src-ok", "ep-keep"]);
    const backups = readdirSync(path.join(dir, "backups"));
    expect(backups.some((n) => n.startsWith("pre-r32-drift-anchor-prune-"))).toBe(true);
    const auditName = backups.find((n) => n.startsWith("drift-anchor-prune-"));
    expect(auditName).toBeTruthy();
    const audit = JSON.parse(readFileSync(path.join(dir, "backups", String(auditName)), "utf8")) as { items: { removed: string[] }[] };
    expect(audit.items[0].removed).toEqual(["msg-gone"]);
  });
});
