import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CHAT_COLUMNS,
  EVIDENCE_COLUMNS,
  EVENT_COLUMNS,
  GOAL_COLUMNS,
  LEGACY_EVIDENCE_PLACEHOLDER_DELETE,
  applyPlan,
  buildLegacyRecordResolver,
  classifyStoredDiff,
  collectParity,
  countPlaceholderEvidence,
  isEmptyStoredValue,
  mapEpisodeRow,
  migrationExitCode,
  planMigration,
  repairDerivedDrift,
  summarizeMigrationRun,
} from "./soul-event-migration.mjs";

/**
 * F5（t21）：旧 episode 的 evidence_json 只有 record_id，迁移早先把它们写成
 * role='unknown' + quote=''（生产 248 条）。record_id 能回查 l0_conversations，
 * 所以这不是「无从修的历史数据」——解析器补 role/quote，取不到才退回 unknown。
 */

/** 只实现 resolver 需要的两条查询：sqlite_master 探测 + l0_conversations 按 record_id 取行。 */
function fakeDb(l0Rows) {
  return {
    prepare(sql) {
      if (/sqlite_master/u.test(sql)) return { get: () => ({ ok: 1 }) };
      if (/FROM l0_conversations WHERE record_id/u.test(sql)) {
        return { get: (id) => l0Rows[id] };
      }
      throw new Error("unexpected sql: " + sql);
    },
  };
}

function episodeRow(evidenceIds) {
  return {
    episode_id: "ep-1",
    team_id: "team-1",
    user_id: "usr-1",
    agent_id: "agt-1",
    at: "2026-11-10T03:00:00.000Z",
    day: "2026-11-10",
    object: "门禁",
    title: "把没跑过的门禁说成绿",
    outcome: "",
    session_id: "s-1",
    quote_json: null,
    evidence_json: JSON.stringify(evidenceIds),
  };
}

test("没有解析器时保持旧口径：role=unknown、quote 为空", () => {
  const mapped = mapEpisodeRow(episodeRow(["msg-a"]));
  assert.deepEqual(mapped.evidence, [
    { event_id: "ep-1", record_id: "msg-a", role: "unknown", quote: "", at: "2026-11-10T03:00:00.000Z", confidence: 0.5 },
  ]);
});

test("有解析器时按 L0 原话补齐 role/quote，置信度随引文升到 1", () => {
  const db = fakeDb({ "msg-a": { role: "user", message_text: "  门禁根本没跑就说通过了 \n", recorded_at: "2026-11-10T03:00:01.000Z" } });
  const mapped = mapEpisodeRow(episodeRow(["msg-a"]), buildLegacyRecordResolver(db));
  assert.deepEqual(mapped.evidence, [
    { event_id: "ep-1", record_id: "msg-a", role: "user", quote: "门禁根本没跑就说通过了", at: "2026-11-10T03:00:01.000Z", confidence: 1 },
  ]);
});

test("L0 查不到该 record_id：退回 unknown，不编引文", () => {
  const db = fakeDb({});
  const mapped = mapEpisodeRow(episodeRow(["msg-ghost"]), buildLegacyRecordResolver(db));
  assert.equal(mapped.evidence[0].role, "unknown");
  assert.equal(mapped.evidence[0].quote, "");
  assert.equal(mapped.evidence[0].confidence, 0.5);
});

test("超长 L0 正文只留 300 字做定位，不把整段记录搬进证据", () => {
  const db = fakeDb({ "msg-long": { role: "assistant", message_text: "甲".repeat(500), recorded_at: "" } });
  const mapped = mapEpisodeRow(episodeRow(["msg-long"]), buildLegacyRecordResolver(db));
  assert.equal(mapped.evidence[0].quote.length, 301);
  assert.ok(mapped.evidence[0].quote.endsWith("…"));
});

test("l0_conversations 不存在时没有解析器，映射不炸", () => {
  const db = { prepare: (sql) => (/sqlite_master/u.test(sql) ? { get: () => undefined } : { get: () => undefined }) };
  assert.equal(buildLegacyRecordResolver(db), null);
  const mapped = mapEpisodeRow(episodeRow(["msg-a"]), null);
  assert.equal(mapped.evidence[0].role, "unknown");
});

test("占位清理只针对 role=unknown 且 quote 为空的那一种形态", () => {
  assert.match(LEGACY_EVIDENCE_PLACEHOLDER_DELETE, /role = 'unknown' AND quote = ''/u);
  assert.match(LEGACY_EVIDENCE_PLACEHOLDER_DELETE, /WHERE event_id = \? AND record_id = \?/u);
});


// ───────────── t22：对账口径（存量回填缺口 ≠ 写错值） ─────────────

/**
 * 一个能跑完整 plan → apply → parity 的内存库。
 * 目标表按迁移自身的列清单建（PRIMARY KEY 与真实 DDL 对齐，INSERT OR IGNORE 才有意义），
 * 这样测试不依赖 .ts 的 DDL 加载器（node --test 里没有 tsx loader）。
 */
function migrationDb(evidenceIds = ["msg-a"]) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE soul_episodes (" +
      "episode_id TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, agent_id TEXT, at TEXT, title TEXT, " +
      "object TEXT, outcome TEXT, session_id TEXT, quote_json TEXT, evidence_json TEXT, persons_json TEXT, " +
      "archived_at TEXT, kind TEXT, user_stance TEXT, agent_stance TEXT, cost TEXT, valence REAL, arousal REAL, " +
      "intensity REAL, affect_source TEXT, signals_json TEXT, layers_json TEXT, mood_integrated_at TEXT)",
  );
  db.exec("CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, role TEXT, message_text TEXT, recorded_at TEXT)");
  db.exec(
    "CREATE TABLE soul_events (" +
      EVENT_COLUMNS.map((c) => (c === "event_id" ? "event_id TEXT PRIMARY KEY" : c + " TEXT")).join(", ") +
      ")",
  );
  db.exec(
    "CREATE TABLE soul_event_chat (" +
      CHAT_COLUMNS.map((c) => (c === "event_id" ? "event_id TEXT PRIMARY KEY" : c + " TEXT")).join(", ") +
      ")",
  );
  db.exec(
    "CREATE TABLE soul_event_evidence (" +
      EVIDENCE_COLUMNS.map((c) =>
        c === "confidence" ? "confidence REAL" : c + " TEXT",
      ).join(", ") +
      ", PRIMARY KEY (event_id, record_id, role))",
  );
  db.exec(
    "CREATE TABLE soul_goals (" +
      GOAL_COLUMNS.map((c) => (c === "goal_id" ? "goal_id TEXT PRIMARY KEY" : c + " TEXT")).join(", ") +
      ")",
  );
  db.prepare(
    "INSERT INTO soul_episodes (episode_id, team_id, user_id, agent_id, at, title, object, outcome, session_id, quote_json, evidence_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "ep-1",
    "team-1",
    "usr-1",
    "agt-1",
    "2026-11-10T03:00:00.000Z",
    "把没跑过的门禁说成绿",
    "门禁",
    "",
    "s-1",
    null,
    JSON.stringify(evidenceIds),
  );
  const l0 = db.prepare("INSERT INTO l0_conversations (record_id, role, message_text, recorded_at) VALUES (?, ?, ?, ?)");
  for (const [i, id] of evidenceIds.entries()) {
    const text = i === 0 ? "门禁根本没跑就说通过了" : "门禁根本没跑就说通过了 " + id;
    l0.run(id, i % 2 === 0 ? "user" : "assistant", text, "2026-11-10T03:00:0" + (i + 1) + ".000Z");
  }
  return db;
}

function migrate(db) {
  const plan = planMigration(db);
  const applied = applyPlan(db, plan);
  return { plan, applied };
}

test("classifyStoredDiff 的空判定要窄：'0' / 'false' / 'unknown' 都算有值", () => {
  assert.equal(isEmptyStoredValue(""), true);
  assert.equal(isEmptyStoredValue("   "), true);
  assert.equal(isEmptyStoredValue(null), true);
  assert.equal(isEmptyStoredValue(0), false);
  assert.equal(isEmptyStoredValue("0"), false);
  assert.equal(isEmptyStoredValue("false"), false);
  assert.equal(isEmptyStoredValue("unknown"), false);
  assert.equal(classifyStoredDiff("门禁", ""), "backfill");
  assert.equal(classifyStoredDiff("门禁", null), "backfill");
  assert.equal(classifyStoredDiff("门禁", "别的"), "mismatch");
  assert.equal(classifyStoredDiff("门禁", ""), "backfill");
  assert.equal(classifyStoredDiff(0.8, 0), "mismatch");
  assert.equal(classifyStoredDiff("门禁", "门禁"), "equal");
});

test("新插入行逐字段一致：无缺口、无 mismatch、exit 0", () => {
  const db = migrationDb();
  const { applied } = migrate(db);
  assert.equal(applied.ok, true);
  const parity = collectParity(db);
  assert.equal(parity.ok, true);
  assert.deepEqual(parity.totals.backfillGaps, {});
  assert.equal(parity.totals.backfillGapEvents, 0);
  assert.equal(parity.tenants[0].field.mismatchEvents, 0);
  assert.equal(migrationExitCode({ apply: true, applied, parity }), 0);
});

test("存量行 intent 为空、期望非空：记 backfillGap，不失败（exit 0）", () => {
  const db = migrationDb();
  const { applied } = migrate(db);
  // 模拟生产：事件行写在前、intent 后加，INSERT OR IGNORE 再也覆盖不到这一列。
  db.exec("UPDATE soul_events SET intent = '' WHERE event_id = 'ep-1'");

  const parity = collectParity(db);
  assert.equal(parity.ok, true, "缺口不是写错值，不能把 ok 打成 false");
  assert.equal(parity.totals.backfillGaps["event.intent"], 1);
  assert.equal(parity.totals.backfillGapEvents, 1);
  assert.equal(parity.tenants[0].field.mismatchEvents, 0);
  assert.equal(migrationExitCode({ apply: true, applied, parity }), 0);

  const summary = summarizeMigrationRun({ applied, parity, placeholderStats: { rows: 0, events: 0 } });
  assert.match(summary.lines[2], /event\.intent 1 条/u);
  assert.equal(summary.hasBackfillGaps, true);
  assert.equal(summary.exitCode, 0);
});

test("存量行 intent 写成别的非空值：仍是真 mismatch，exit 非 0", () => {
  const db = migrationDb();
  const { applied } = migrate(db);
  db.exec("UPDATE soul_events SET intent = '别的说法' WHERE event_id = 'ep-1'");

  const parity = collectParity(db);
  assert.equal(parity.ok, false);
  assert.equal(parity.totals.backfillGaps["event.intent"] ?? 0, 0);
  assert.equal(parity.tenants[0].field.mismatchEvents, 1);
  assert.deepEqual(parity.tenants[0].mismatches[0].fields, ["event.intent"]);
  assert.equal(migrationExitCode({ apply: true, applied, parity }), 1);
});

test("占位证据修复后同 (event, record) 只剩一行", () => {
  const db = migrationDb();
  const plan = planMigration(db);
  // 上一轮迁移写下的占位形态：role=unknown 且 quote 为空。
  db.prepare("INSERT INTO soul_event_evidence VALUES (?, ?, ?, ?, ?, ?)").run(
    "ep-1",
    "msg-a",
    "unknown",
    "",
    "2026-11-10T03:00:00.000Z",
    0.5,
  );
  const applied = applyPlan(db, plan);

  const rows = db
    .prepare("SELECT role, quote FROM soul_event_evidence WHERE event_id = 'ep-1' AND record_id = 'msg-a'")
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "user");
  assert.equal(rows[0].quote, "门禁根本没跑就说通过了");
  assert.equal(applied.totals.placeholderEvidenceFixed, 1);

  // 重跑：占位已不存在，修复数归零，行数不变。
  const again = applyPlan(db, planMigration(db));
  assert.equal(again.totals.placeholderEvidenceFixed, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM soul_event_evidence WHERE event_id = 'ep-1'").get().n,
    1,
  );
});



// ───────────── t23：对账范围 = 迁移派生事件（source_kind='chat' 且 id=episode_id） ─────────────

/** 事件模型自己产出的事件：带 :tool / :test / :rollback 后缀，不属于迁移对象。 */
function insertNativeEvent(db, eventId, sourceKind) {
  db.prepare(
    "INSERT INTO soul_events (event_id, team_id, user_id, agent_id, source_kind) VALUES (?, ?, ?, ?, ?)",
  ).run(eventId, "team-1", "usr-1", "agt-1", sourceKind);
}

test("非 chat 事件（:tool/:test 后缀）不进对账，也不产生 mismatch", () => {
  const db = migrationDb();
  const { applied } = migrate(db);
  insertNativeEvent(db, "ep-1:tool", "tool");
  insertNativeEvent(db, "ep-1:test:2", "test");
  // 事件模型自己的 chat 行也不能把「chat 行数」抬上去。
  db.prepare("INSERT INTO soul_event_chat (event_id, kind) VALUES (?, ?)").run("ep-1:tool", "decision");

  const parity = collectParity(db);
  assert.equal(parity.ok, true, "范围外事件不该让对账变红：" + JSON.stringify(parity.tenants[0].diffs));
  assert.equal(parity.totals.events, 1, "事件数只算迁移派生事件");
  assert.equal(parity.totals.chat, 1, "chat 对比基数是派生事件数，不是全部事件数");
  assert.equal(parity.totals.outOfScopeEvents, 2);
  assert.deepEqual(parity.totals.outOfScopeByKind, { test: 1, tool: 1 });
  assert.equal(parity.tenants[0].field.mismatchEvents, 0);
  assert.equal(migrationExitCode({ apply: true, applied, parity }), 0);
});

test("范围外事件单独一行计数，且不进 DIFF 文案", () => {
  const db = migrationDb();
  migrate(db);
  insertNativeEvent(db, "ep-1:rollback", "rollback");
  const parity = collectParity(db);
  assert.equal(parity.outOfScope.total, 1);
  assert.deepEqual(parity.outOfScope.bySourceKind, { rollback: 1 });
  assert.equal(parity.tenants[0].diffs.length, 0);
  // 事件模型的事件如果被误算，这条会红；保持绿即为收窄生效。
  assert.equal(parity.ok, true);
});

test("占位修复同时报行数与事件数（2 行 / 1 事件）", () => {
  const db = migrationDb(["msg-a", "msg-b"]);
  const plan = planMigration(db);
  const placeholder = db.prepare("INSERT INTO soul_event_evidence VALUES (?, ?, ?, ?, ?, ?)");
  placeholder.run("ep-1", "msg-a", "unknown", "", "2026-11-10T03:00:00.000Z", 0.5);
  placeholder.run("ep-1", "msg-b", "unknown", "", "2026-11-10T03:00:00.000Z", 0.5);

  const applied = applyPlan(db, plan);
  assert.equal(applied.totals.placeholderEvidenceFixed, 2, "行数");
  assert.equal(applied.totals.placeholderEvidenceFixedEvents, 1, "涉及事件数");

  const stats = countPlaceholderEvidence(db);
  assert.deepEqual(stats, { rows: 0, events: 0 });

  const parity = collectParity(db);
  const summary = summarizeMigrationRun({ applied, parity, placeholderStats: stats });
  assert.match(summary.lines[1], /本次修复 2 行（涉 1 事件）/u);
  assert.match(summary.lines[1], /还剩 0 行（涉 0 事件）/u);
});


// ───────────── --repair：把早期映射写错的值修回期望值 ─────────────

test("早期映射把 title 冒充 object：--repair 修回，第二轮幂等", () => {
  const db = migrationDb();
  migrate(db);
  // 复现 90 天库里那一行：episode.object 是空，旧映射拿 title 兜底把'拍板'写进了事件 object。
  db.exec("UPDATE soul_episodes SET object = '' WHERE episode_id = 'ep-1'");
  db.exec("UPDATE soul_events SET object = '拍板' WHERE event_id = 'ep-1'");

  const before = collectParity(db);
  assert.equal(before.ok, false, "写错的值必须让对账变红");
  assert.ok(before.tenants[0].mismatches[0].fields.includes("event.object"));

  const repaired = repairDerivedDrift(db);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.totals.events, 1);
  assert.equal(repaired.totals.columns, 1);
  assert.deepEqual(repaired.totals.byColumn, { "event.object": 1 });
  assert.deepEqual(repaired.repaired, [{ eventId: "ep-1", fields: ["event.object"] }]);

  const after = collectParity(db);
  assert.equal(after.ok, true, "修完对账必须回到一致：" + JSON.stringify(after.tenants[0].diffs));
  assert.equal(migrationExitCode({ apply: true, applied: null, parity: after }), 0);

  const second = repairDerivedDrift(db);
  assert.equal(second.totals.columns, 0, "修好之后第二轮必须 0 列");
  assert.equal(second.totals.events, 0);
});

test("--repair 只修 mismatch，不填存量缺口（库空、期望有值）", () => {
  const db = migrationDb();
  migrate(db);
  db.exec("UPDATE soul_events SET intent = '' WHERE event_id = 'ep-1'");

  const repaired = repairDerivedDrift(db);
  assert.equal(repaired.totals.columns, 0, "缺口不是写错值，--repair 不该动它");

  const parity = collectParity(db);
  assert.equal(parity.totals.backfillGaps["event.intent"], 1, "缺口仍在，由人决定是否回填");
  assert.equal(migrationExitCode({ apply: true, applied: null, parity }), 0);
});

test("--repair 跳过非 chat 事件：事件模型自产的行没有旧行可比", () => {
  const db = migrationDb();
  migrate(db);
  // 同 id 但 source_kind=tool：不管是历史脏数据还是 id 撞车，都不许按旧行覆盖。
  db.exec("UPDATE soul_events SET source_kind = 'tool', object = '自产' WHERE event_id = 'ep-1'");
  const repaired = repairDerivedDrift(db);
  assert.equal(repaired.totals.skippedOutOfScope, 1);
  assert.equal(repaired.totals.events, 0);
  const stored = db.prepare("SELECT object FROM soul_events WHERE event_id = 'ep-1'").get();
  assert.equal(stored.object, "自产");
});
