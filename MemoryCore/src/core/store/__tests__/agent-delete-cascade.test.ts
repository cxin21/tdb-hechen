/**
 * 删 agent 的级联（2026-11-09）：清记忆内容必须连派生行一起清。
 *
 * 为什么在这里锁：硬删 agent 走 metadata-service.deleteAgents，它调
 * clearChatMemoryContent，最终落到 store.clearMemoryContent。以前这条只清
 * L0/L1，soul_persona / soul_episodes / soul_emotions 这些按 agent_id 读的行
 * 会留下来，下一次 tick 还能读到已删 agent 的人格和情绪。
 *
 * 同时锁两件不该被连带的：soul_trait_label 按 team 存（写侧只用 teamId），
 * 清一个 agent 不能误删同队其它人的标签；embedding_meta 的 episodeWatermark
 * 是全库一份，动它会让别的 agent 把旧对话重抽一遍。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const TEAM = "team-del";
const AGENT = "agt-del";
const OTHER = "agt-keep";

function makeStore(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-delete-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(res)}`);
  return store;
}

function seed(store: VectorStore): void {
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
  const persona = db.prepare(
    "INSERT INTO soul_persona (item_id, team_id, user_id, agent_id, layer, text, created_at, updated_at, last_evidence_at) VALUES (?, ?, 'user-a', ?, 'voice', 'x', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z')",
  );
  persona.run("p-del", TEAM, AGENT);
  persona.run("p-keep", TEAM, OTHER);
  db.prepare(
    "INSERT INTO soul_episodes (episode_id, team_id, user_id, agent_id, at, day, kind) VALUES ('ep-del', ?, 'user-a', ?, '2026-11-09T00:00:00Z', '2026-11-09', 'work')",
  ).run(TEAM, AGENT);
  db.prepare(
    "INSERT INTO soul_trait_label (tenant_id, label, first_seen, last_seen) VALUES (?, '稳', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z')",
  ).run(TEAM);
  db.prepare(
    "INSERT INTO embedding_meta (key, value) VALUES ('soul.episodeWatermark', '2026-11-07T06:42:15.634Z')",
  ).run();
}

function seedP0Graph(store: VectorStore): void {
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
  const at = "2026-11-09T00:00:00Z";
  const event = db.prepare(
    "INSERT INTO soul_events (event_id, team_id, user_id, agent_id, at, day, valid_from, actor, action, source_kind, created_at) VALUES (?, ?, 'user-a', ?, ?, '2026-11-09', ?, 'user', 'said', 'chat', ?)",
  );
  for (const [id, agent] of [
    ["ev-del", AGENT],
    ["ev-keep", OTHER],
  ] as const) {
    event.run(id, TEAM, agent, at, at, at);
    db.prepare("INSERT INTO soul_event_chat (event_id, kind) VALUES (?, 'work')").run(id);
    db.prepare("INSERT INTO soul_event_evidence (event_id, record_id, role, at) VALUES (?, ?, 'user', ?)").run(
      id,
      "l0-" + id,
      at,
    );
    db.prepare("INSERT INTO soul_event_action (event_id, tool) VALUES (?, 'test')").run(id);
    db.prepare("INSERT INTO soul_event_reflection (event_id, lesson) VALUES (?, 'lesson')").run(id);
  }
  const goal = db.prepare(
    "INSERT INTO soul_goals (goal_id, team_id, user_id, agent_id, owner, kind, title, valid_from, created_at, updated_at) VALUES (?, ?, 'user-a', ?, 'self', 'plan', ?, ?, ?, ?)",
  );
  for (const [id, agent] of [
    ["g-del", AGENT],
    ["g-keep", OTHER],
  ] as const) {
    goal.run(id, TEAM, agent, "title", at, at, at);
    db.prepare("INSERT INTO soul_goal_events (goal_id, event_id, change, at) VALUES (?, ?, 'progress', ?)").run(
      id,
      "ev-" + id,
      at,
    );
  }
  db.prepare("INSERT INTO soul_goal_deps (goal_id, depends_on_goal_id) VALUES ('g-del', 'g-keep')").run();
  const narrative = db.prepare(
    "INSERT INTO soul_narrative (chapter_id, team_id, user_id, agent_id, period_start, period_end, title, summary, hash, created_at) VALUES (?, ?, 'user-a', ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [id, agent] of [
    ["n-del", AGENT],
    ["n-keep", OTHER],
  ] as const) {
    narrative.run(id, TEAM, agent, "2026-11-01", "2026-11-09", "chapter", "summary", "hash-" + id, at);
    db.prepare("INSERT INTO soul_narrative_evidence (chapter_id, event_id) VALUES (?, ?)").run(id, "ev-" + id);
  }
  db.prepare(
    "INSERT INTO soul_person_state (person_key, team_id, user_id, agent_id, updated_at) VALUES (?, ?, 'user-a', ?, ?)",
  ).run("person-del", TEAM, AGENT, at);
  db.prepare(
    "INSERT INTO soul_person_state (person_key, team_id, user_id, agent_id, updated_at) VALUES (?, ?, 'user-a', ?, ?)",
  ).run("person-keep", TEAM, OTHER, at);
}

function count(store: VectorStore, sql: string, ...params: unknown[]): number {
  const db = (store as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => { c: number } } } }).db;
  return Number(db.prepare(sql).get(...params).c);
}

describe("clearMemoryContent 连派生行一起清", () => {
  it("清掉目标 agent 的人格和事件，留下同队另一个 agent 的行", () => {
    const store = makeStore();
    seed(store);

    const result = store.clearMemoryContent({ teamId: TEAM, agentId: AGENT });

    expect(result.l0Deleted).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_persona WHERE agent_id = ?", AGENT)).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_episodes WHERE agent_id = ?", AGENT)).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_persona WHERE agent_id = ?", OTHER)).toBe(1);
  });

  it("没有 L0/L1 也要清派生行，不能因为内容为空就早退", () => {
    const store = makeStore();
    seed(store);
    expect(count(store, "SELECT count(*) AS c FROM l0_conversations WHERE agent_id = ?", AGENT)).toBe(0);

    store.clearMemoryContent({ teamId: TEAM, agentId: AGENT });

    expect(count(store, "SELECT count(*) AS c FROM soul_persona WHERE agent_id = ?", AGENT)).toBe(0);
  });

  it("不清 team 级标签，也不动全库水位", () => {
    const store = makeStore();
    seed(store);

    store.clearMemoryContent({ teamId: TEAM, agentId: AGENT });

    expect(count(store, "SELECT count(*) AS c FROM soul_trait_label WHERE tenant_id = ?", TEAM)).toBe(1);
    const db = (store as unknown as { db: { prepare: (sql: string) => { get: () => { value: string } } } }).db;
    expect(db.prepare("SELECT value FROM embedding_meta WHERE key = 'soul.episodeWatermark'").get().value).toBe(
      "2026-11-07T06:42:15.634Z",
    );
  });

  it("清掉 P0 事件底座与结构化派生行，子表不留孤儿", () => {
    const store = makeStore();
    seed(store);
    seedP0Graph(store);

    store.clearMemoryContent({ teamId: TEAM, agentId: AGENT });

    expect(count(store, "SELECT count(*) AS c FROM soul_events WHERE agent_id = ?", AGENT)).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_events WHERE agent_id = ?", OTHER)).toBe(1);
    for (const table of ["soul_event_chat", "soul_event_evidence", "soul_event_action", "soul_event_reflection"]) {
      expect(count(store, "SELECT count(*) AS c FROM " + table + " WHERE event_id = 'ev-del'")).toBe(0);
      expect(count(store, "SELECT count(*) AS c FROM " + table + " WHERE event_id = 'ev-keep'")).toBe(1);
    }
    expect(count(store, "SELECT count(*) AS c FROM soul_goals WHERE agent_id = ?", AGENT)).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_goal_events WHERE goal_id = 'g-del'")).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_goal_deps WHERE goal_id = 'g-del'")).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_goals WHERE agent_id = ?", OTHER)).toBe(1);
    expect(count(store, "SELECT count(*) AS c FROM soul_goal_events WHERE goal_id = 'g-keep'")).toBe(1);
    expect(count(store, "SELECT count(*) AS c FROM soul_narrative WHERE agent_id = ?", AGENT)).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_narrative_evidence WHERE chapter_id = 'n-del'")).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_narrative WHERE agent_id = ?", OTHER)).toBe(1);
    expect(count(store, "SELECT count(*) AS c FROM soul_narrative_evidence WHERE chapter_id = 'n-keep'")).toBe(1);
    expect(count(store, "SELECT count(*) AS c FROM soul_person_state WHERE person_key = 'person-del'")).toBe(0);
    expect(count(store, "SELECT count(*) AS c FROM soul_person_state WHERE person_key = 'person-keep'")).toBe(1);
  });
});
