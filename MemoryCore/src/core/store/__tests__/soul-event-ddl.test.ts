/**
 * 灵魂事件底座 DDL 的契约测试（P0-A）。
 *
 * 守七条：
 *  1. 幂等 —— SOUL_EVENT_DDL 与 SOUL_EVENT_MIGRATION_DDL 各跑两遍，表/列/索引不增不减、不报错；
 *  2. 覆盖 —— §4 的 21 张表全部建出，soul_events 的列与 spec §4.1 逐列对齐；
 *  3. 枚举 —— 类型层常量数组里的每个值都被 CHECK 接受，数组外的值一律被拒（类型与约束不许漂移）；
 *  4. 不信 —— 删父行必须级联掉子表行（且只在 PRAGMA foreign_keys=ON 时成立，这一条要显式钉住）；
 *  5. 去重 —— dedupe_key 非空唯一，NULL 与空串不互撞；
 *  6. 加列 —— ALTER 出来的列在存量行上读到默认值，重复执行只吞 duplicate column name；
 *  7. 硬边界 —— 迁移 DDL 在缺旧表时抛错，证明「幂等」不是无差别吞错。
 *
 * 铁律：纯内存库（DatabaseSync(':memory:')），不碰 D:/TDB/data 下的任何库。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { SOUL_EVENT_DDL, SOUL_EVENT_MIGRATION_DDL } from "../soul-event-ddl.js";
import {
  SOUL_EVENT_ACTORS,
  SOUL_EVENT_SOURCE_KINDS,
  SOUL_EVENT_STATUSES,
  SOUL_ACTION_STATUSES,
  SOUL_EVIDENCE_ROLES,
  SOUL_GOAL_KINDS,
  SOUL_GOAL_OWNERS,
  SOUL_GATE_DECISIONS,
  SOUL_GATE_STAGES,
  SOUL_MOOD_EVENT_KINDS,
  SOUL_RELATION_STATUSES,
  SOUL_RELATION_TENSES,
} from "../soul-event-types.js";

/**
 * 测试夹具：ALTER 目标表的最小骨架。
 *
 * 为什么要有它：§4.4/§4.5/§4.7/§4.10 是对**既有表**加列，而本测试不 import sqlite.ts
 * （P0-A 只交付 DDL 与类型，不碰 store）。这里只声明 ALTER 必需的那几列，
 * 不是产品 DDL——生产 DDL 的真源在 sqlite.ts，禁止拿这份夹具去“对齐”生产表。
 */
const LEGACY_STUB_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS soul_person_relation (
    rel_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    subj_key TEXT NOT NULL,
    pred TEXT NOT NULL,
    quote TEXT NOT NULL,
    record_id TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS soul_emotions (
    episode_id TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT NOT NULL DEFAULT 'default',
    at TEXT NOT NULL,
    label TEXT NOT NULL,
    template_version TEXT NOT NULL DEFAULT '',
    appraised_at TEXT NOT NULL,
    PRIMARY KEY (episode_id, team_id, user_id, agent_id, template_version)
  )`,
  `CREATE TABLE IF NOT EXISTS soul_persona (
    item_id TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT NOT NULL DEFAULT 'default',
    layer TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_id, team_id, user_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS soul_promises (
    promise_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT NOT NULL DEFAULT 'default',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

/** 夹具里的旧表（只用于 ALTER，不是本文件建的）。 */
const LEGACY_STUB_TABLES: readonly string[] = [
  "soul_person_relation",
  "soul_emotions",
  "soul_persona",
  "soul_promises",
];

/** §4 要建的全部表（顺序即 SOUL_EVENT_DDL 的落表顺序）。 */
const EXPECTED_TABLES: readonly string[] = [
  "soul_events",
  "soul_event_evidence",
  "soul_event_chat",
  "soul_event_action",
  "soul_event_reflection",
  "soul_person_state",
  "soul_person_state_events",
  "soul_goals",
  "soul_goal_events",
  "soul_goal_deps",
  "soul_self_model",
  "soul_calibration",
  "soul_mood_state",
  "soul_mood_events",
  "soul_narrative",
  "soul_narrative_evidence",
  "soul_values",
  "soul_gate_log",
  "soul_dilemma",
  "soul_working_state",
  "soul_schema_migrations",
];

/** spec §4.1 的 27 列，顺序与 DDL 一致。 */
const SOUL_EVENTS_COLUMNS: readonly string[] = [
  "event_id",
  "team_id",
  "user_id",
  "agent_id",
  "at",
  "day",
  "valid_from",
  "valid_to",
  "actor",
  "actor_person_key",
  "action",
  "object",
  "intent",
  "outcome",
  "status",
  "source_kind",
  "source_ref",
  "ownership",
  "epistemic",
  "confidence",
  "visibility",
  "session_id",
  "persons_json",
  "parent_event_id",
  "dedupe_key",
  "salience",
  "created_at",
  "archived_at",
];

function makeDb(opts: { foreignKeys?: boolean; withLegacy?: boolean } = {}): DatabaseSync {
  const { foreignKeys = true, withLegacy = true } = opts;
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  if (withLegacy) for (const ddl of LEGACY_STUB_DDL) db.exec(ddl);
  return db;
}

/** 与 sqlite.ts 同一惯例：只吞「列已存在」，其它错误冒泡。 */
function applyMigrations(db: DatabaseSync): void {
  for (const ddl of SOUL_EVENT_MIGRATION_DDL) {
    try {
      db.exec(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
}

function applyEventSchema(db: DatabaseSync): void {
  for (const ddl of SOUL_EVENT_DDL) db.exec(ddl);
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'soul\_%' ESCAPE '\\' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare("SELECT name FROM pragma_index_list(?)").all(table) as Array<{ name: string }>;
  // sqlite_autoindex_* 是主键/唯一约束的隐式索引，不是本文件建的，断言里排除。
  return rows
    .map((r) => r.name)
    .filter((name) => !name.startsWith("sqlite_autoindex_"))
    .sort();
}

function foreignKeysOn(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  return Number(row.foreign_keys);
}

function insertRow(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...cols.map((c) => row[c] as SQLInputValue));
}

/** 一条最小合法事件（只给无默认值的列）。 */
function insertEvent(db: DatabaseSync, overrides: Record<string, SQLInputValue> = {}): void {
  insertRow(db, "soul_events", {
    event_id: "evt-1",
    at: "2026-11-10T01:00:00Z",
    day: "2026-11-10",
    valid_from: "2026-11-10T01:00:00Z",
    actor: "self",
    action: "committed",
    source_kind: "commit",
    created_at: "2026-11-10T01:00:00Z",
    ...overrides,
  });
}

const NOW = "2026-11-10T01:00:00Z";

describe("soul_events 底座：建表与幂等", () => {
  it("SOUL_EVENT_DDL 两遍应用：不报错、表集合不变", () => {
    const db = makeDb();
    applyEventSchema(db);
    const first = tableNames(db);
    expect(() => applyEventSchema(db)).not.toThrow();
    expect(tableNames(db)).toEqual(first);
    // 建出的 soul_* 表 = §4 的 21 张 + 夹具里的 4 张旧表，一张不多一张不少。
    expect(first.filter((name) => EXPECTED_TABLES.includes(name))).toEqual([...EXPECTED_TABLES].sort());
    expect(first.filter((name) => !EXPECTED_TABLES.includes(name) && !LEGACY_STUB_TABLES.includes(name))).toEqual([]);
    db.close();
  });

  it("soul_events 的列与 spec §4.1 逐列对齐", () => {
    const db = makeDb();
    applyEventSchema(db);
    expect(columns(db, "soul_events")).toEqual([...SOUL_EVENTS_COLUMNS]);
    db.close();
  });

  it("类型子表与结构化表的关键列都在", () => {
    const db = makeDb();
    applyEventSchema(db);
    const expectations: Record<string, string[]> = {
      soul_event_evidence: ["event_id", "record_id", "role", "quote", "at", "confidence"],
      soul_event_chat: [
        "event_id",
        "kind",
        "title",
        "user_stance",
        "agent_stance",
        "cost",
        "valence",
        "arousal",
        "intensity",
        "affect_source",
        "quote_json",
        "signals_json",
        "layers_json",
        "mood_integrated_at",
      ],
      soul_event_action: [
        "event_id",
        "tool",
        "tool_call_id",
        "args_digest",
        "result_status",
        "duration_ms",
        "artifact_ref",
        "error_code",
        "environment",
        "verified_by",
      ],
      soul_event_reflection: [
        "event_id",
        "about_event_ids_json",
        "lesson",
        "behavior_change",
        "verified_at",
        "confidence",
      ],
      soul_person_state: [
        "person_key",
        "team_id",
        "user_id",
        "agent_id",
        "trust",
        "affinity",
        "respect",
        "obligation",
        "boundaries_json",
        "model_json",
        "last_interaction_at",
        "evidence_event_ids_json",
        "confidence",
        "updated_at",
      ],
      soul_goals: [
        "goal_id",
        "owner",
        "kind",
        "title",
        "why",
        "status",
        "priority",
        "progress",
        "due_at",
        "parent_goal_id",
        "source_event_id",
        "success_criteria",
        "blocked_reason",
        "abandon_reason",
        "valid_from",
        "valid_to",
        "confidence",
        "created_at",
        "updated_at",
      ],
      soul_self_model: [
        "id",
        "kind",
        "scope",
        "statement",
        "confidence",
        "evidence_event_ids_json",
        "counterexample_event_ids_json",
        "status",
        "last_confirmed_at",
        "created_at",
        "updated_at",
      ],
      soul_mood_state: [
        "team_id",
        "user_id",
        "agent_id",
        "label",
        "valence",
        "arousal",
        "intensity",
        "half_life_hours",
        "cause_event_ids_json",
        "updated_at",
      ],
      soul_narrative: [
        "chapter_id",
        "period_start",
        "period_end",
        "title",
        "summary",
        "turning_points_json",
        "lessons_json",
        "version",
        "hash",
        "supersedes_id",
        "status",
        "created_at",
      ],
      soul_working_state: [
        "team_id",
        "user_id",
        "agent_id",
        "session_id",
        "current_goal_id",
        "current_focus",
        "open_questions_json",
        "updated_at",
        "expires_at",
      ],
      soul_schema_migrations: ["version", "name", "applied_at", "checksum"],
    };
    for (const [table, cols] of Object.entries(expectations)) {
      const actual = columns(db, table);
      for (const col of cols) expect(actual, `${table}.${col}`).toContain(col);
    }
    db.close();
  });

  it("§4.1/§4.2 的索引按名建出", () => {
    const db = makeDb();
    applyEventSchema(db);
    expect(indexNames(db, "soul_events")).toEqual(
      [
        "idx_soul_events_tenant_at",
        "idx_soul_events_tenant_actor_at",
        "idx_soul_events_tenant_action_at",
        "idx_soul_events_tenant_source_kind_at",
        "idx_soul_events_tenant_status_at",
        "idx_soul_events_dedupe_key",
      ].sort(),
    );
    // spec §4.2 的 event_id 索引不单独建（PK 最左列已是 event_id），record_id 反向查才需要。
    expect(indexNames(db, "soul_event_evidence")).toContain("idx_soul_event_evidence_record");
    db.close();
  });
});

describe("soul_events 底座：枚举与数值域由 CHECK 守", () => {
  it("actor / status / source_kind：常量数组内全接受，数组外全拒", () => {
    const db = makeDb();
    applyEventSchema(db);
    for (const actor of SOUL_EVENT_ACTORS) {
      expect(() => insertEvent(db, { event_id: `evt-actor-${actor}`, actor })).not.toThrow();
    }
    for (const status of SOUL_EVENT_STATUSES) {
      expect(() => insertEvent(db, { event_id: `evt-status-${status}`, status })).not.toThrow();
    }
    for (const kind of SOUL_EVENT_SOURCE_KINDS) {
      expect(() => insertEvent(db, { event_id: `evt-kind-${kind}`, source_kind: kind })).not.toThrow();
    }
    expect(() => insertEvent(db, { event_id: "evt-bad-actor", actor: "nobody" })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent(db, { event_id: "evt-bad-status", status: "in_progress" })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertEvent(db, { event_id: "evt-bad-kind", source_kind: "imagination" })).toThrow(
      /CHECK constraint failed/,
    );
    db.close();
  });

  it("confidence / salience 越界被拒（0..1 闭区间）", () => {
    const db = makeDb();
    applyEventSchema(db);
    expect(() => insertEvent(db, { event_id: "evt-c0", confidence: 0 })).not.toThrow();
    expect(() => insertEvent(db, { event_id: "evt-c1", confidence: 1 })).not.toThrow();
    expect(() => insertEvent(db, { event_id: "evt-c15", confidence: 1.5 })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent(db, { event_id: "evt-cneg", confidence: -0.1 })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent(db, { event_id: "evt-sneg", salience: -1 })).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("ownership / epistemic / visibility 的枚举由 CHECK 锁死", () => {
    const db = makeDb();
    applyEventSchema(db);
    for (const ownership of ["mine", "theirs", "joint", "observed"]) {
      expect(() => insertEvent(db, { event_id: `evt-o-${ownership}`, ownership })).not.toThrow();
    }
    for (const epistemic of ["observed", "inferred", "assumed"]) {
      expect(() => insertEvent(db, { event_id: `evt-e-${epistemic}`, epistemic })).not.toThrow();
    }
    for (const visibility of ["shared", "private", "relationship"]) {
      expect(() => insertEvent(db, { event_id: `evt-v-${visibility}`, visibility })).not.toThrow();
    }
    expect(() => insertEvent(db, { event_id: "evt-bad-o", ownership: "shared" })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent(db, { event_id: "evt-bad-e", epistemic: "believed" })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent(db, { event_id: "evt-bad-v", visibility: "public" })).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("子表的枚举与主键：evidence.role / action.result_status / 同 (event,record,role) 不重复", () => {
    const db = makeDb();
    applyEventSchema(db);
    insertEvent(db);
    for (const role of SOUL_EVIDENCE_ROLES) {
      const row = { event_id: "evt-1", record_id: `rec-${role}`, role, at: NOW };
      expect(() => insertRow(db, "soul_event_evidence", row)).not.toThrow();
    }
    expect(() =>
      insertRow(db, "soul_event_evidence", { event_id: "evt-1", record_id: "rec-x", role: "narrator", at: NOW }),
    ).toThrow(/CHECK constraint failed/);
    // confidence 默认 1.0
    const ev = db.prepare("SELECT confidence FROM soul_event_evidence WHERE record_id = 'rec-user'").get() as {
      confidence: number;
    };
    expect(ev.confidence).toBe(1);

    for (const st of SOUL_ACTION_STATUSES) {
      insertEvent(db, { event_id: `evt-act-${st}`, source_kind: "tool", action: "ran" });
      expect(() =>
        insertRow(db, "soul_event_action", { event_id: `evt-act-${st}`, tool: "bash", result_status: st }),
      ).not.toThrow();
    }
    insertEvent(db, { event_id: "evt-act-bad", source_kind: "tool", action: "ran" });
    expect(() =>
      insertRow(db, "soul_event_action", { event_id: "evt-act-bad", tool: "bash", result_status: "ok" }),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("结构化表：goal.owner/kind、relation 迁列、gate、mood、narrative 的枚举同样由 CHECK 守", () => {
    const db = makeDb();
    applyEventSchema(db);
    applyMigrations(db);
    for (const owner of SOUL_GOAL_OWNERS) {
      for (const kind of SOUL_GOAL_KINDS) {
        expect(() =>
          insertRow(db, "soul_goals", {
            goal_id: `goal-${owner}-${kind}`,
            owner,
            kind,
            title: "t",
            valid_from: NOW,
            created_at: NOW,
            updated_at: NOW,
          }),
        ).not.toThrow();
      }
    }
    expect(() =>
      insertRow(db, "soul_goals", {
        goal_id: "goal-bad",
        owner: "team",
        kind: "desire",
        title: "t",
        valid_from: NOW,
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertRow(db, "soul_goals", {
        goal_id: "goal-bad2",
        owner: "self",
        kind: "wish",
        title: "t",
        valid_from: NOW,
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toThrow(/CHECK constraint failed/);

    for (const stage of SOUL_GATE_STAGES) {
      for (const decision of SOUL_GATE_DECISIONS) {
        expect(() =>
          insertRow(db, "soul_gate_log", {
            id: `gate-${stage}-${decision}`,
            at: NOW,
            stage,
            action_digest: "sha256:abc",
            decision,
          }),
        ).not.toThrow();
      }
    }
    expect(() =>
      insertRow(db, "soul_gate_log", {
        id: "gate-bad",
        at: NOW,
        stage: "thinking",
        action_digest: "d",
        decision: "allow",
      }),
    ).toThrow(/CHECK constraint failed/);

    for (const kind of SOUL_MOOD_EVENT_KINDS) {
      expect(() => insertRow(db, "soul_mood_events", { id: `mood-${kind}`, at: NOW, kind })).not.toThrow();
    }
    expect(() => insertRow(db, "soul_mood_events", { id: "mood-bad", at: NOW, kind: "reset" })).toThrow(
      /CHECK constraint failed/,
    );

    expect(() =>
      insertRow(db, "soul_narrative", {
        chapter_id: "ch-1",
        period_start: NOW,
        period_end: NOW,
        title: "t",
        summary: "s",
        hash: "h",
        status: "superseded",
        created_at: NOW,
      }),
    ).not.toThrow();
    expect(() =>
      insertRow(db, "soul_narrative", {
        chapter_id: "ch-bad",
        period_start: NOW,
        period_end: NOW,
        title: "t",
        summary: "s",
        hash: "h",
        status: "draft",
        created_at: NOW,
      }),
    ).toThrow(/CHECK constraint failed/);

    db.close();
  });
});

describe("soul_events 底座：外键级联与去重", () => {
  it("删除事件级联删掉 evidence / chat / action / reflection（需 foreign_keys=ON）", () => {
    const db = makeDb();
    expect(foreignKeysOn(db)).toBe(1);
    applyEventSchema(db);
    insertEvent(db);
    insertRow(db, "soul_event_evidence", { event_id: "evt-1", record_id: "rec-1", role: "user", at: NOW });
    insertRow(db, "soul_event_chat", { event_id: "evt-1", kind: "collaboration" });
    insertRow(db, "soul_event_action", { event_id: "evt-1", tool: "bash" });
    insertRow(db, "soul_event_reflection", { event_id: "evt-1", lesson: "先取证再动手" });

    db.exec("DELETE FROM soul_events WHERE event_id = 'evt-1'");
    for (const table of ["soul_event_evidence", "soul_event_chat", "soul_event_action", "soul_event_reflection"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(Number(row.n), table).toBe(0);
    }
    db.close();
  });

  it("子行不许指向不存在的事件（FK 生效）", () => {
    const db = makeDb();
    applyEventSchema(db);
    expect(() => insertRow(db, "soul_event_chat", { event_id: "evt-missing", kind: "chat" })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });

  it("契约：foreign_keys=OFF 时不级联（这条钉住『写入侧必须显式开 PRAGMA』）", () => {
    const db = makeDb({ foreignKeys: false });
    expect(foreignKeysOn(db)).toBe(0);
    applyEventSchema(db);
    insertEvent(db);
    insertRow(db, "soul_event_chat", { event_id: "evt-1", kind: "chat" });
    db.exec("DELETE FROM soul_events WHERE event_id = 'evt-1'");
    const row = db.prepare("SELECT COUNT(*) AS n FROM soul_event_chat").get() as { n: number };
    expect(Number(row.n)).toBe(1);
    db.close();
  });

  it("dedupe_key 非空唯一：NULL 与空串可共存，非空重复被拒", () => {
    const db = makeDb();
    applyEventSchema(db);
    insertEvent(db, { event_id: "evt-null-1" });
    insertEvent(db, { event_id: "evt-null-2" });
    insertEvent(db, { event_id: "evt-empty-1", dedupe_key: "" });
    insertEvent(db, { event_id: "evt-empty-2", dedupe_key: "" });
    insertEvent(db, { event_id: "evt-dup-1", dedupe_key: "team:chat:sha256-1" });
    expect(() => insertEvent(db, { event_id: "evt-dup-2", dedupe_key: "team:chat:sha256-1" })).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });
});

describe("SOUL_EVENT_MIGRATION_DDL：加列幂等与默认值", () => {
  it("两遍应用幂等：只吞 duplicate column name，列不重复", () => {
    const db = makeDb();
    applyEventSchema(db);
    expect(() => applyMigrations(db)).not.toThrow();
    const snapshot = {
      relation: columns(db, "soul_person_relation"),
      emotions: columns(db, "soul_emotions"),
      persona: columns(db, "soul_persona"),
      promises: columns(db, "soul_promises"),
    };
    expect(() => applyMigrations(db)).not.toThrow();
    expect(columns(db, "soul_person_relation")).toEqual(snapshot.relation);
    expect(columns(db, "soul_emotions")).toEqual(snapshot.emotions);
    expect(columns(db, "soul_persona")).toEqual(snapshot.persona);
    expect(columns(db, "soul_promises")).toEqual(snapshot.promises);
    db.close();
  });

  it("§4.4/§4.5/§4.7/§4.10 的列都加上了", () => {
    const db = makeDb();
    applyEventSchema(db);
    applyMigrations(db);
    for (const col of ["event_id", "status", "tense", "confidence", "visibility", "ended_by_event_id"]) {
      expect(columns(db, "soul_person_relation"), col).toContain(col);
    }
    expect(columns(db, "soul_promises")).toContain("goal_id");
    for (const col of ["event_id", "goal_id", "dimensions_json"]) {
      expect(columns(db, "soul_emotions"), col).toContain(col);
    }
    for (const col of [
      "confidence",
      "epistemic",
      "source_event_ids_json",
      "projection_version",
      "valid_from",
      "valid_to",
    ]) {
      expect(columns(db, "soul_persona"), col).toContain(col);
    }
    db.close();
  });

  it("存量行读到新增列的默认值（NOT NULL DEFAULT 语义）", () => {
    const db = makeDb();
    db.prepare("INSERT INTO soul_persona (item_id, layer, text, created_at, updated_at) VALUES (?,?,?,?,?)").run(
      "item-1",
      "identity",
      "旧行",
      NOW,
      NOW,
    );
    db.prepare(
      "INSERT INTO soul_person_relation (rel_id, team_id, user_id, agent_id, subj_key, pred, quote, record_id, valid_from, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("rel-1", "t", "u", "a", "p_self", "尊重", "q", "rec-1", NOW, NOW, NOW);
    applyEventSchema(db);
    applyMigrations(db);

    const persona = db
      .prepare("SELECT confidence, epistemic, projection_version FROM soul_persona WHERE item_id = 'item-1'")
      .get() as { confidence: number; epistemic: string; projection_version: string | null };
    expect(persona.confidence).toBe(0.5);
    expect(persona.epistemic).toBe("inferred");
    expect(persona.projection_version).toBeNull();

    const rel = db
      .prepare("SELECT status, tense, confidence, visibility FROM soul_person_relation WHERE rel_id = 'rel-1'")
      .get() as { status: string; tense: string; confidence: number; visibility: string };
    expect(rel).toEqual({ status: "active", tense: "present", confidence: 0.5, visibility: "shared" });
    db.close();
  });

  it("新增列上的 CHECK 生效：非法 relation.status / tense 被拒", () => {
    const db = makeDb();
    applyEventSchema(db);
    applyMigrations(db);
    const insertRel = (id: string, status: string, tense: string) =>
      db
        .prepare(
          "INSERT INTO soul_person_relation (rel_id, team_id, user_id, agent_id, subj_key, pred, quote, record_id, valid_from, created_at, updated_at, status, tense) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(id, "t", "u", "a", "p_x", "p", "q", "r", NOW, NOW, NOW, status, tense);
    for (const status of SOUL_RELATION_STATUSES) {
      expect(() => insertRel(`rel-${status}`, status, "present")).not.toThrow();
    }
    for (const tense of SOUL_RELATION_TENSES) {
      expect(() => insertRel(`rel-tense-${tense}`, "active", tense)).not.toThrow();
    }
    expect(() => insertRel("rel-bad-status", "unknown", "present")).toThrow(/CHECK constraint failed/);
    expect(() => insertRel("rel-bad-tense", "active", "future")).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("迁移不是无差别吞错：缺旧表时抛 no such table", () => {
    const db = makeDb({ withLegacy: false });
    applyEventSchema(db);
    expect(() => applyMigrations(db)).toThrow(/no such table/i);
    db.close();
  });
});
