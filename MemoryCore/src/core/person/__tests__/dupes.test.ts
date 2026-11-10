/**
 * 同名人物检测（docs/specs/2026-11-10-soul-person-dedupe-spec.md §2.2）。
 *
 * 这里只验「判据与墓碑健康」，不验合并本身：合并按 spec §4 人工执行，本文没有写路径。
 */
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSoulPersonDupes } from "../dupes.js";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "soul-dupes-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "vectors.db"));
  dbs.push(db);
  db.exec(`CREATE TABLE soul_person (
    person_key TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, agent_id TEXT,
    platform TEXT NOT NULL DEFAULT '', platform_id TEXT,
    display_name TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]',
    merged_into TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  return db;
}

function insertPerson(
  db: DatabaseSync,
  row: { key: string; name: string; tenant?: [string, string, string]; platform?: string; pid?: string | null; aliases?: string[]; mergedInto?: string | null },
): void {
  const [team, user, agent] = row.tenant ?? ["t", "u", "a"];
  db.prepare(
    "INSERT INTO soul_person (person_key, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    row.key,
    team,
    user,
    agent,
    row.platform ?? "",
    row.pid ?? null,
    row.name,
    JSON.stringify(row.aliases ?? []),
    row.mergedInto ?? null,
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
  );
}

describe("同名人物检测", () => {
  it("都无 platform_id 的同名两行判 B 级", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_name_a", name: "何晨" });
    insertPerson(db, { key: "p_name_b", name: " 何晨 " });
    const scan = scanSoulPersonDupes(db);
    expect(scan.alive).toBe(2);
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]!.level).toBe("B");
    expect(scan.groups[0]!.rows.map((r) => r.personKey).sort()).toEqual(["p_name_a", "p_name_b"]);
  });

  it("两个不同 platform_id 判 C 级（不自动合并）", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_x", name: "何晨", pid: "wx-1" });
    insertPerson(db, { key: "p_y", name: "何晨", pid: "wx-2" });
    const scan = scanSoulPersonDupes(db);
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]!.level).toBe("C");
    expect(scan.groups[0]!.reason).toContain("不同的 platform_id");
  });

  it("一方 aliases 登记了对方名字时进别名候选（display_name 不同也报）", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_x", name: "何晨", pid: "wx-1" });
    insertPerson(db, { key: "p_y", name: "何晨（企业微信）", aliases: ["何晨"] });
    const scan = scanSoulPersonDupes(db);
    expect(scan.groups).toHaveLength(0);
    expect(scan.aliasCandidates).toHaveLength(1);
    expect(scan.aliasCandidates[0]).toMatchObject({ fromKey: "p_y", alias: "何晨", targetKey: "p_x" });
  });

  it("同 platform + 同 platform_id 判 A 级", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_x", name: "何晨", platform: "wecom", pid: "wx-1" });
    insertPerson(db, { key: "p_y", name: "何晨", platform: "wecom", pid: "wx-1" });
    const scan = scanSoulPersonDupes(db);
    expect(scan.groups[0]!.level).toBe("A");
  });

  it("跨租户同名不算重复", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_a", name: "何晨", tenant: ["t", "u", "a1"] });
    insertPerson(db, { key: "p_b", name: "何晨", tenant: ["t", "u", "a2"] });
    const scan = scanSoulPersonDupes(db);
    expect(scan.groups).toHaveLength(0);
  });

  it("墓碑上残留关系/状态/事件归属会被计数", () => {
    const db = makeDb();
    insertPerson(db, { key: "p_old", name: "何晨", mergedInto: "p_new" });
    db.exec(`CREATE TABLE soul_person_relation (
      rel_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      subj_key TEXT NOT NULL, pred TEXT NOT NULL, obj_key TEXT, valid_to TEXT
    )`);
    db.exec(`CREATE TABLE soul_person_state (
      person_key TEXT NOT NULL, team_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      PRIMARY KEY (person_key, team_id, user_id, agent_id)
    )`);
    db.exec(`CREATE TABLE soul_episodes (
      episode_id TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, agent_id TEXT, persons_json TEXT
    )`);
    db.prepare(
      "INSERT INTO soul_person_relation (rel_id, team_id, user_id, agent_id, subj_key, pred) VALUES ('r1','t','u','a','p_old','knows')",
    ).run();
    db.prepare("INSERT INTO soul_person_state (person_key, team_id, user_id, agent_id) VALUES ('p_old','t','u','a')").run();
    db.prepare(
      "INSERT INTO soul_episodes (episode_id, team_id, user_id, agent_id, persons_json) VALUES ('ep1','t','u','a','[\"p_old\",\"p_x\"]')",
    ).run();
    const scan = scanSoulPersonDupes(db);
    expect(scan.tombstones).toBe(1);
    const health = scan.tombstoneHealth[0]!;
    expect(health.mergedInto).toBe("p_new");
    expect(health.relSubj).toBe(1);
    expect(health.state).toBe(1);
    expect(health.episodes).toBe(1);
    expect(scan.leakedTotal).toBe(3);
  });

  it("表不存在时返回空扫描而不抛", () => {
    const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "soul-dupes-empty-")), "empty.db"));
    dirs.push("");
    dbs.push(db);
    const scan = scanSoulPersonDupes(db);
    expect(scan.persons).toBe(0);
    expect(scan.groups).toHaveLength(0);
    expect(scan.leakedTotal).toBe(0);
  });
});
