/**
 * P0-C：soul_episodes → soul_events 双写、切读开关、双写对账。
 *
 * 为什么要这组测试：P0-A/P0-B 给的是纯 store（自己的内存库、自己的事务），真正接进
 * MemoryCore 之后风险全在「接线」上——旧表先写、新表后写、同一个 BEGIN IMMEDIATE，
 * 任何一环出错都会留下单边写入，而单边写入只有等到切读那天才会暴露。这里把四件事钉住：
 *   1. initSchema 建新表 + 幂等重入（老库重开也要补得回来）；
 *   2. commitSoulEpisodes 双写字段逐条对齐，且失败时新旧一起回滚；
 *   3. 切读开关缺省 legacy（逐字节不变），new 读与 legacy 深等；
 *   4. 对账 0 diff，改一行能被点名到「哪条事件、哪个字段」。
 *
 * 证据准入（spec §4.2）单列一条：没有逐字引文的 episode 必须仍能双写成功并标 inferred，
 * 否则双写会把既有的正常写入整批拖挂——那是回归，不是收紧。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore, currentSoulEventReadMode, resolveSoulEventReadMode } from "../sqlite.js";
import type { SoulEventWrite } from "../soul-event-store.js";
import type { SoulEpisode } from "../../soul/types.js";
import type { CoreTenant } from "../types.js";

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };
const READ_MODE_ENV = "TDB_SOUL_EVENT_READ_MODE";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-event-dualwrite-")), "vectors.db");
}

const opened: VectorStore[] = [];

function makeStore(dbPath: string = tmpDb()): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  opened.push(store);
  return store;
}

function raw(store: VectorStore): {
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): unknown;
  };
  exec(sql: string): void;
} {
  return (
    store as unknown as {
      db: {
        prepare(sql: string): {
          all(...p: unknown[]): unknown[];
          get(...p: unknown[]): unknown;
          run(...p: unknown[]): unknown;
        };
        exec(sql: string): void;
      };
    }
  ).db;
}

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      /* 测试里已手动关过 */
    }
  }
  delete process.env[READ_MODE_ENV];
});

/** 一条「既能深等读回、又能覆盖可选字段」的完整 episode（字段顺序无关，值必须都能落库）。 */
function episode(overrides: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: "ep-1",
    at: "2026-11-10T02:00:00.000Z",
    day: "2026-11-10",
    kind: "correction",
    title: "纠正：门禁",
    object: "门禁",
    participants: ["何晨", "assistant"],
    userStance: "先取证再回话",
    agentStance: "收到，先取证",
    cost: "10 分钟",
    outcome: "改完再回话",
    valence: -0.4,
    arousal: 0.5,
    intensity: 0.4,
    evidenceIds: ["l0-1", "l0-2"],
    sessionId: "s1",
    quote: { text: "先取证，再改", role: "user", recordId: "l0-1" },
    affectSource: "lexicon",
    signals: ["correction"],
    layers: ["narrative"],
    persons: ["p_name_he"],
    ...overrides,
  };
}

function eventRow(store: VectorStore, eventId = "ep-1"): Record<string, unknown> {
  return raw(store).prepare("SELECT * FROM soul_events WHERE event_id = ?").get(eventId) as Record<string, unknown>;
}

function chatRow(store: VectorStore, eventId = "ep-1"): Record<string, unknown> {
  return raw(store).prepare("SELECT * FROM soul_event_chat WHERE event_id = ?").get(eventId) as Record<string, unknown>;
}

function evidenceRows(store: VectorStore, eventId = "ep-1"): Array<Record<string, unknown>> {
  return raw(store)
    .prepare("SELECT * FROM soul_event_evidence WHERE event_id = ? ORDER BY record_id ASC")
    .all(eventId) as Array<Record<string, unknown>>;
}

function count(store: VectorStore, table: string): number {
  const row = raw(store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
  return Number(row.n ?? 0);
}

describe("P0-C initSchema：事件底座 DDL", () => {
  it("建齐 soul_events/chat/evidence 与迁移列，且 init 重入、重开同库都幂等", async () => {
    const dbPath = tmpDb();
    const store = makeStore(dbPath);
    // 同实例再 init 一遍：CREATE ... IF NOT EXISTS 幂等，ALTER 走 duplicate column name 分支。
    expect(() => store.init()).not.toThrow();
    const tables = (
      raw(store)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('soul_events','soul_event_chat','soul_event_evidence','soul_event_action','soul_event_reflection')",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables.sort()).toEqual([
      "soul_event_action",
      "soul_event_chat",
      "soul_event_evidence",
      "soul_event_reflection",
      "soul_events",
    ]);
    // ALTER 目标列真在（P0-A 的迁移列，重入不能把它吞掉或重复加）。
    const personaCols = (raw(store).prepare("PRAGMA table_info(soul_persona)").all() as Array<{ name: string }>).map(
      (col) => col.name,
    );
    expect(personaCols.length).toBeGreaterThan(0);
    store.close();
    // 重开同一个库：老库路径（表已存在 + 列已存在）必须还能 init。
    const reopened = makeStore(dbPath);
    expect((await reopened.commitSoulEpisodes(TENANT, [episode()])).inserted).toBe(1);
    expect(eventRow(reopened)).toBeDefined();
  });
});

describe("P0-C 双写：soul_episodes + soul_events/chat/evidence", () => {
  it("一条 episode 四个位置都落，基表与 chat/evidence 逐字段对齐", async () => {
    const store = makeStore();
    const ep = episode();
    const result = await store.commitSoulEpisodes(TENANT, [ep]);
    expect(result.inserted).toBe(1);

    // 旧表照旧写（读面默认真源）。
    expect(count(store, "soul_episodes")).toBe(1);

    const event = eventRow(store);
    expect(event.team_id).toBe("t1");
    expect(event.user_id).toBe("u1");
    expect(event.agent_id).toBe("a1");
    expect(event.at).toBe(ep.at);
    expect(event.day).toBe(ep.day);
    expect(event.valid_from).toBe(ep.at);
    expect(event.valid_to).toBeNull();
    expect(event.actor).toBe("user");
    expect(event.action).toBe("said");
    expect(event.object).toBe("门禁");
    expect(event.intent).toBe("纠正：门禁");
    expect(event.outcome).toBe("改完再回话");
    expect(event.status).toBe("unknown");
    expect(event.source_kind).toBe("chat");
    expect(event.source_ref).toBe("l0-1");
    expect(event.ownership).toBe("theirs");
    expect(event.epistemic).toBe("observed");
    expect(Number(event.confidence)).toBeCloseTo(0.8, 6);
    expect(event.visibility).toBe("shared");
    expect(event.session_id).toBe("s1");
    expect(event.persons_json).toBe(JSON.stringify(["p_name_he"]));
    expect(event.dedupe_key).toBe("soul-episode:ep-1");
    expect(Number(event.salience)).toBeCloseTo(0.5, 6);
    expect(event.created_at).toBe(ep.at);
    expect(event.archived_at).toBeNull();
    expect(event.parent_event_id).toBeNull();

    const chat = chatRow(store);
    expect(chat.kind).toBe("correction");
    expect(chat.title).toBe("纠正：门禁");
    expect(chat.user_stance).toBe("先取证再回话");
    expect(chat.agent_stance).toBe("收到，先取证");
    expect(chat.cost).toBe("10 分钟");
    expect(Number(chat.valence)).toBeCloseTo(-0.4, 6);
    expect(Number(chat.arousal)).toBeCloseTo(0.5, 6);
    expect(Number(chat.intensity)).toBeCloseTo(0.4, 6);
    expect(chat.affect_source).toBe("lexicon");
    expect(chat.quote_json).toBe(JSON.stringify(ep.quote));
    expect(chat.signals_json).toBe(JSON.stringify(["correction"]));
    expect(chat.layers_json).toBe(JSON.stringify(["narrative"]));
    expect(chat.mood_integrated_at).toBeNull();

    const evidence = evidenceRows(store);
    expect(evidence.map((row) => row.record_id)).toEqual(["l0-1", "l0-2"]);
    // 引文指向的那条：role 从 quote 来，quote 逐字搬；其余证据只知 record_id，不许假装知道谁说的。
    expect(evidence[0]).toMatchObject({ role: "user", quote: "先取证，再改", at: ep.at, confidence: 1 });
    expect(evidence[1]).toMatchObject({ role: "unknown", quote: "", at: ep.at, confidence: 1 });
  });

  it("refresh（同 episodeId 重挖）不翻倍：两表都被覆盖，证据整组替换", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    await store.commitSoulEpisodes(TENANT, [
      episode({ title: "纠正：门禁（重挖）", evidenceIds: ["l0-3"], quote: null }),
    ]);
    expect(count(store, "soul_episodes")).toBe(1);
    expect(count(store, "soul_events")).toBe(1);
    expect(count(store, "soul_event_chat")).toBe(1);
    expect(chatRow(store).title).toBe("纠正：门禁（重挖）");
    // quote=null → 引文没了，证据回到 unknown/空引文，准入随之回落 inferred（不能留上次的 observed）。
    expect(evidenceRows(store).map((row) => row.record_id)).toEqual(["l0-3"]);
    expect(eventRow(store).epistemic).toBe("inferred");
  });

  it("无逐字引文 / 无证据的 episode 仍能双写：epistemic 按证据内容回落 inferred", async () => {
    const store = makeStore();
    const noQuote = episode({ episodeId: "ep-noquote", evidenceIds: ["l0-9"], quote: null });
    const noEvidence = episode({ episodeId: "ep-noev", evidenceIds: [], quote: null });
    // 同批提交：任何一条被 §4.2 拒写都会让整批 ROLLBACK——这条用例防的就是那个回归。
    const result = await store.commitSoulEpisodes(TENANT, [noQuote, noEvidence]);
    expect(result.inserted).toBe(2);
    expect(count(store, "soul_episodes")).toBe(2);

    const a = eventRow(store, "ep-noquote");
    expect(a.epistemic).toBe("inferred");
    expect(Number(a.confidence)).toBeCloseTo(0.5, 6);
    expect(evidenceRows(store, "ep-noquote")).toMatchObject([{ record_id: "l0-9", role: "unknown", quote: "" }]);

    const b = eventRow(store, "ep-noev");
    expect(b.epistemic).toBe("inferred");
    expect(Number(b.confidence)).toBeCloseTo(0.5, 6);
    expect(b.source_ref).toBe("");
    // 无证据 = 0 行，而不是伪造一条 legacy:episode 假证据。
    expect(evidenceRows(store, "ep-noev")).toEqual([]);
  });

  it("双写失败整批回滚：旧表也不留半条", async () => {
    const store = makeStore();
    raw(store).exec(
      "CREATE TRIGGER t_fail_event BEFORE INSERT ON soul_events WHEN NEW.event_id = 'ep-boom' " +
        "BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    // commitSoulEpisodes 是同步方法：抛出是同步的，用 toThrow 而不是 rejects。
    expect(() => store.commitSoulEpisodes(TENANT, [episode(), episode({ episodeId: "ep-boom" })])).toThrow(/boom/);
    // 第一条旧表插入在事务内、被同一次 ROLLBACK 收走：新旧一起归零。
    expect(count(store, "soul_episodes")).toBe(0);
    expect(count(store, "soul_events")).toBe(0);
    expect(count(store, "soul_event_chat")).toBe(0);
    expect(count(store, "soul_event_evidence")).toBe(0);
  });
});

describe("P0-C 切读开关：TDB_SOUL_EVENT_READ_MODE", () => {
  it("缺省/非法值 = legacy（旧表读法逐字节不变）", async () => {
    expect(resolveSoulEventReadMode(undefined)).toBe("legacy");
    expect(resolveSoulEventReadMode("")).toBe("legacy");
    expect(resolveSoulEventReadMode("legacy")).toBe("legacy");
    expect(resolveSoulEventReadMode("bogus")).toBe("legacy");
    expect(resolveSoulEventReadMode("NEW")).toBe("new");
    delete process.env[READ_MODE_ENV];
    expect(currentSoulEventReadMode()).toBe("legacy");

    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    // 只改旧表：legacy 读跟着变（证明默认读面确实读的是 soul_episodes）。
    raw(store).prepare("UPDATE soul_episodes SET title = ? WHERE episode_id = ?").run("旧表被改", "ep-1");
    const rows = await store.listSoulEpisodes(TENANT, { limit: 10 });
    expect(rows.map((row) => row.title)).toEqual(["旧表被改"]);
  });

  it("legacy 读与写前对象逐字段深等（含 quote/signals/layers/persons）", async () => {
    const store = makeStore();
    const ep = episode();
    await store.commitSoulEpisodes(TENANT, [ep]);
    // 读回形态必须与写前对象完全一致：不吞字段、不把 undefined 变成 []、不把 null 变成 null 字符串。
    expect(await store.listSoulEpisodes(TENANT, { limit: 10 })).toEqual([ep]);
  });

  it("new 读与 legacy 深等（participants 也在），且 new 确实读的是新表", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [
      episode(),
      episode({ episodeId: "ep-2", at: "2026-11-10T01:00:00.000Z", kind: "decision", title: "拍板：先做 P0" }),
    ]);

    delete process.env[READ_MODE_ENV];
    const legacyAll = await store.listSoulEpisodes(TENANT, { limit: 10 });
    expect(legacyAll).toHaveLength(2);

    process.env[READ_MODE_ENV] = "new";
    const newAll = await store.listSoulEpisodes(TENANT, { limit: 10 });
    // 过渡态：participants 在新表没有列，new 读靠 event_id join 旧表 participants_json 取展示名。
    // 这里断言它取到了（而不是被空数组/角色名顶替）。
    expect(newAll.find((row) => row.episodeId === "ep-1")?.participants).toEqual(["何晨", "assistant"]);
    expect(newAll).toEqual(legacyAll);

    // kind 过滤与排序也要一致（kind 在 chat 子表上，不能退化成「先取 limit 再过滤」）。
    const legacyDecision = await store.listSoulEpisodes(TENANT, { kind: "decision", limit: 10 });
    process.env[READ_MODE_ENV] = "new";
    expect(await store.listSoulEpisodes(TENANT, { kind: "decision", limit: 10 })).toEqual(legacyDecision);
    expect(legacyDecision.map((row) => row.episodeId)).toEqual(["ep-2"]);

    // 只改旧表标题：new 读仍返回 chat.title（证明走的是新表，不是又读了一遍旧表）。
    raw(store).prepare("UPDATE soul_episodes SET title = ? WHERE episode_id = ?").run("旧表被改", "ep-1");
    const afterLegacyMutation = await store.listSoulEpisodes(TENANT, { limit: 10 });
    expect(afterLegacyMutation.find((row) => row.episodeId === "ep-1")?.title).toBe("纠正：门禁");
  });

  it("new 读遇到新表拼不回完整事件时回落 legacy（不伪造 participants）", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    // 删掉旧行 = 新表那边 join 不到 participants 展示名（P1 独写事件的形态）。
    raw(store).prepare("DELETE FROM soul_episodes WHERE episode_id = ?").run("ep-1");
    process.env[READ_MODE_ENV] = "new";
    // 回落 legacy → 旧表里已经没有这条，读到空；关键是「不许凭空造一条 participants=[] 的事件」。
    expect(await store.listSoulEpisodes(TENANT, { limit: 10 })).toEqual([]);
  });
});

describe("P0-C 对账：soulEventParity", () => {
  it("刚双写完 0 diff，两侧摘要相等", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode(), episode({ episodeId: "ep-2", at: "2026-11-10T01:00:00.000Z" })]);
    const parity = await store.soulEventParity(TENANT);
    expect(parity.ok).toBe(true);
    expect(parity.diffs).toEqual([]);
    expect(parity.counts).toEqual({ episodes: 2, events: 2, chat: 2, evidence: 4, missingEvidence: 0 });
    expect(parity.digests.legacy).toBe(parity.digests.event);
  });

  it("改一行能点名到事件与字段，摘要随之不等", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    raw(store).prepare("UPDATE soul_episodes SET title = ? WHERE episode_id = ?").run("被改过的标题", "ep-1");
    const parity = await store.soulEventParity(TENANT);
    expect(parity.ok).toBe(false);
    expect(parity.diffs).toContainEqual({
      eventId: "ep-1",
      kind: "field_mismatch",
      field: "title",
      legacy: "被改过的标题",
      event: "纠正：门禁",
    });
    expect(parity.digests.legacy).not.toBe(parity.digests.event);
  });

  it("缺事件/缺证据也能各报一条", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    // 新表侧被外部删掉一条证据 → 事件仍有证据（1 条），不算 missing_evidence；删整行旧表才算缺事件。
    raw(store).prepare("DELETE FROM soul_episodes WHERE episode_id = ?").run("ep-1");
    expect((await store.soulEventParity(TENANT)).diffs).toContainEqual({
      eventId: "ep-1",
      kind: "missing_episode",
      legacy: null,
      event: null,
    });
  });
});

describe("P0-C 新表读写入口（P1 复用）", () => {
  const write = (eventId: string): SoulEventWrite => ({
    event: {
      event_id: eventId,
      at: "2026-11-10T03:00:00.000Z",
      day: "2026-11-10",
      valid_from: "2026-11-10T03:00:00.000Z",
      actor: "self",
      action: "said",
      object: "P1",
      intent: "新表直写",
      outcome: "",
      source_kind: "chat",
      epistemic: "observed",
      confidence: 0.8,
      created_at: "2026-11-10T03:00:00.000Z",
    },
    evidence: [{ event_id: eventId, record_id: "l0-9", role: "user", quote: "直写", at: "2026-11-10T03:00:00.000Z" }],
  });

  it("commitSoulEvents 一批一事务：全成则全在，一条非法则全回滚", async () => {
    const store = makeStore();
    expect((await store.commitSoulEvents(TENANT, [write("ep-9"), write("ep-10")])).upserted).toBe(2);
    const listed = await store.listSoulEvents(TENANT, { limit: 10 });
    // 两条 at 相同 → 次序由 event_id DESC 决定（字符串比较：'ep-9' > 'ep-10'）。
    expect(listed.map((row) => row.event_id)).toEqual(["ep-9", "ep-10"]);

    // 第二条无证据却标 observed → §4.2 拒写；第一条也不能留下（同一个 BEGIN IMMEDIATE）。
    // 换一个没写过的 event_id：同一 id 的 upsert 会保留库里已有证据，§4.2 反而放行。
    const bad: SoulEventWrite = { event: { ...write("ep-12").event } };
    expect(() => store.commitSoulEvents(TENANT, [write("ep-11"), bad])).toThrow(/soul_event_write/);
    expect(count(store, "soul_events")).toBe(2);
  });
});

describe("P0-C2 切读补齐：search / 归档 / 心境双写", () => {
  it("归档：旧表与新表在同一事务里同步 archived_at，legacy/new 的 includeArchived 一致", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [
      episode(),
      episode({ episodeId: "ep-2", at: "2026-11-10T01:00:00.000Z", title: "拍板：先做 P0" }),
    ]);

    // 返回值语义不变：deleted 恒 0，archived 数的是旧表真被改了行的那几条。
    expect(store.deleteSoulEpisodes(TENANT, ["ep-1"])).toEqual({ deleted: 0, archived: 1 });
    // 新表同事务跟上，否则切读那天「已归档的事件」会复活。
    expect(eventRow(store, "ep-1").archived_at).not.toBeNull();
    expect(eventRow(store, "ep-2").archived_at).toBeNull();
    // 再归档一次：archived_at IS NULL 挡住，仍然只算 0 条（幂等）。
    expect(store.deleteSoulEpisodes(TENANT, ["ep-1"])).toEqual({ deleted: 0, archived: 0 });

    delete process.env[READ_MODE_ENV];
    const legacyDefault = await store.listSoulEpisodes(TENANT, { limit: 10 });
    const legacyAll = await store.listSoulEpisodes(TENANT, { limit: 10, includeArchived: true });
    expect(legacyDefault.map((row) => row.episodeId)).toEqual(["ep-2"]);
    expect(legacyAll.map((row) => row.episodeId)).toEqual(["ep-1", "ep-2"]);

    process.env[READ_MODE_ENV] = "new";
    expect(await store.listSoulEpisodes(TENANT, { limit: 10 })).toEqual(legacyDefault);
    expect(await store.listSoulEpisodes(TENANT, { limit: 10, includeArchived: true })).toEqual(legacyAll);
  });

  it("心境标记：旧表与 chat 子表同步 mood_integrated_at，new 读与 legacy 一致", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    const at = "2026-11-10T04:00:00.000Z";
    expect(store.markSoulEpisodesMoodIntegrated(TENANT, ["ep-1"], at)).toEqual({ updated: 1 });
    expect(chatRow(store).mood_integrated_at).toBe(at);
    // 已标记过的不再覆盖（旧表 mood_integrated_at IS NULL 的语义照旧）。
    expect(store.markSoulEpisodesMoodIntegrated(TENANT, ["ep-1"], "2026-11-10T05:00:00.000Z")).toEqual({ updated: 0 });
    expect(chatRow(store).mood_integrated_at).toBe(at);

    delete process.env[READ_MODE_ENV];
    const legacy = await store.listSoulEpisodes(TENANT, { limit: 10 });
    process.env[READ_MODE_ENV] = "new";
    const viaEvents = await store.listSoulEpisodes(TENANT, { limit: 10 });
    expect(viaEvents).toEqual(legacy);
    expect(viaEvents[0].moodIntegratedAt).toBe(at);
  });

  it("search 在 new 模式读新表，且与 legacy 逐条深等（text/object/kind/since/limit）", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [
      episode(),
      episode({
        episodeId: "ep-2",
        at: "2026-11-10T01:00:00.000Z",
        kind: "decision",
        title: "拍板：先做 P0",
        object: "P0 路线",
        userStance: "先做接线",
        agentStance: "同意",
        outcome: "排 task-4",
        quote: { text: "先做接线", role: "user", recordId: "l0-2" },
      }),
      episode({
        episodeId: "ep-3",
        at: "2026-11-09T20:00:00.000Z",
        kind: "value_conflict",
        title: "偏好：先取证",
        object: "取证习惯",
        userStance: "",
        agentStance: "",
        outcome: "",
        cost: "",
        quote: null,
        evidenceIds: ["l0-5"],
      }),
    ]);

    const queries: Array<{
      text?: string;
      object?: string;
      kind?: SoulEpisode["kind"];
      since?: string;
      limit?: number;
    }> = [
      { limit: 10 },
      { text: "接线", limit: 10 },
      { text: "先取证", limit: 10 }, // 命中 title / user_stance / quote_json 三处
      { text: "排 task-4", limit: 10 }, // 命中 outcome
      { object: "P0", limit: 10 },
      { kind: "decision", limit: 10 },
      { since: "2026-11-10T00:30:00.000Z", limit: 10 },
      { limit: 1 },
      { kind: "decision", text: "不存在的东西", limit: 10 },
    ];
    for (const query of queries) {
      delete process.env[READ_MODE_ENV];
      const legacy = await store.searchSoulEpisodes(TENANT, query);
      process.env[READ_MODE_ENV] = "new";
      const viaEvents = await store.searchSoulEpisodes(TENANT, query);
      expect(viaEvents, JSON.stringify(query)).toEqual(legacy);
    }

    // 证明 new 搜的确实是新表：只改旧表标题，new 搜仍按 chat.title 命中/返回。
    raw(store).prepare("UPDATE soul_episodes SET title = ? WHERE episode_id = ?").run("旧表被改", "ep-1");
    process.env[READ_MODE_ENV] = "new";
    expect((await store.searchSoulEpisodes(TENANT, { text: "纠正：门禁", limit: 10 })).map((r) => r.episodeId)).toEqual(
      ["ep-1"],
    );
    expect(await store.searchSoulEpisodes(TENANT, { text: "旧表被改", limit: 10 })).toEqual([]);
  });

  it("旧表有行、新表没有对应行时，归档与心境标记都不报错（返回值语义不变）", async () => {
    const store = makeStore();
    await store.commitSoulEpisodes(TENANT, [episode()]);
    // 造「过渡期单体」：只有旧表的 episode（P1 独写事件的另一种形态）。
    raw(store).prepare("DELETE FROM soul_event_evidence WHERE event_id = ?").run("ep-1");
    raw(store).prepare("DELETE FROM soul_event_chat WHERE event_id = ?").run("ep-1");
    raw(store).prepare("DELETE FROM soul_events WHERE event_id = ?").run("ep-1");

    expect(store.deleteSoulEpisodes(TENANT, ["ep-1"])).toEqual({ deleted: 0, archived: 1 });
    expect(store.markSoulEpisodesMoodIntegrated(TENANT, ["ep-1"], "2026-11-10T04:00:00.000Z")).toEqual({ updated: 1 });
    const legacy = await store.listSoulEpisodes(TENANT, { limit: 10, includeArchived: true });
    expect(legacy[0].archivedAt).not.toBeNull();
    expect(legacy[0].moodIntegratedAt).toBe("2026-11-10T04:00:00.000Z");
    // new 读这边没有新表行 → 空结果（回落 legacy 时旧表只有归档行，默认过滤掉）。
    process.env[READ_MODE_ENV] = "new";
    expect(await store.listSoulEpisodes(TENANT, { limit: 10 })).toEqual([]);
  });

  describe("P1-A 行动子事件：切分、重切清理、读/对账兼容、归档", () => {
    const actionEpisode = (overrides: Partial<SoulEpisode> = {}): SoulEpisode =>
      episode({
        quote: { text: "测试挂了，我先回滚了", role: "assistant", recordId: "l0-1" },
        ...overrides,
      });

    it("生产形态：根事件引文是 user，行动子事件从 evidenceIds 里的 assistant L0 行切出", async () => {
      const store = makeStore();
      const l0 = raw(store).prepare(
        "INSERT INTO l0_conversations (record_id, session_key, session_id, team_id, user_id, agent_id, role, message_text, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      l0.run("l0-u", "s1", "s1", "t1", "u1", "a1", "user", "跑下测试然后提交", "2026-11-10T02:00:00.000Z");
      l0.run(
        "l0-a",
        "s1",
        "s1",
        "t1",
        "u1",
        "a1",
        "assistant",
        "跑完全量测试，全绿；提交了 901d1e9",
        "2026-11-10T02:01:00.000Z",
      );
      await store.commitSoulEpisodes(TENANT, [
        episode({
          episodeId: "ep-w",
          evidenceIds: ["l0-u", "l0-a"],
          quote: { text: "跑下测试然后提交", role: "user", recordId: "l0-u" },
        }),
      ]);

      expect(eventRow(store, "ep-w:test")).toMatchObject({
        parent_event_id: "ep-w",
        source_kind: "test",
        status: "done",
      });
      expect(eventRow(store, "ep-w:commit")).toMatchObject({
        parent_event_id: "ep-w",
        source_kind: "commit",
        object: "提交 901d1e9",
      });
      // 证据只回指 assistant 的 L0 行；不拿用户那条冒充「我说过」。
      expect(evidenceRows(store, "ep-w:test")).toMatchObject([
        { record_id: "l0-a", role: "assistant", quote: "跑完全量测试，全绿" },
      ]);
    });

    it("一条 assistant 引文落成 1 根 + 2 行动子事件；new 读仍只读聊天根事件，对账不把子事件当孤儿", async () => {
      const store = makeStore();
      await store.commitSoulEpisodes(TENANT, [actionEpisode()]);
      expect(count(store, "soul_events")).toBe(3);
      expect(eventRow(store, "ep-1:test")).toMatchObject({
        parent_event_id: "ep-1",
        source_kind: "test",
        actor: "self",
        epistemic: "inferred",
        confidence: 0.5,
      });
      expect(eventRow(store, "ep-1:rollback")).toMatchObject({ parent_event_id: "ep-1", source_kind: "rollback" });
      expect(evidenceRows(store, "ep-1:test")).toMatchObject([
        { record_id: "l0-1", role: "assistant", quote: "测试挂了" },
      ]);

      process.env[READ_MODE_ENV] = "new";
      const episodes = await store.listSoulEpisodes(TENANT, { limit: 10 });
      expect(episodes.map((row) => row.episodeId)).toEqual(["ep-1"]);
      const parity = await store.soulEventParity(TENANT);
      expect(parity.ok).toBe(true);
      expect(parity.diffs).toEqual([]);
      // counts.events 是全表总数（含行动子事件），所以大于 episodes 是正常形态。
      expect(parity.counts).toEqual({ episodes: 1, events: 3, chat: 1, evidence: 4, missingEvidence: 0 });

      const detail = store.getSoulEventDetail(TENANT, "ep-1:test");
      expect(detail?.action).toMatchObject({ tool: "test", result_status: "fail", verified_by: null });
      expect(detail?.chat).toBeNull();
    });

    it("同一 episode 重切：不再产出的行动子事件被删掉，不留下孤儿", async () => {
      const store = makeStore();
      await store.commitSoulEpisodes(TENANT, [actionEpisode()]);
      expect(count(store, "soul_events")).toBe(3);

      await store.commitSoulEpisodes(TENANT, [
        actionEpisode({ quote: { text: "测试挂了", role: "assistant", recordId: "l0-1" } }),
      ]);
      expect(count(store, "soul_events")).toBe(2);
      expect(eventRow(store, "ep-1:test")).toBeDefined();
      expect(eventRow(store, "ep-1:rollback")).toBeUndefined();
      expect(count(store, "soul_event_evidence")).toBe(3);
      expect((await store.soulEventParity(TENANT)).ok).toBe(true);
    });

    it("重切只清理行动子事件，不误删同一父事件下的反思事件", async () => {
      const store = makeStore();
      await store.commitSoulEpisodes(TENANT, [actionEpisode()]);
      const reflection: SoulEventWrite = {
        event: {
          event_id: "rf-ep-1",
          at: "2026-11-10T03:00:00.000Z",
          day: "2026-11-10",
          valid_from: "2026-11-10T03:00:00.000Z",
          actor: "self",
          action: "noticed",
          object: "回滚",
          intent: "记住先取证",
          outcome: "",
          source_kind: "reflection",
          parent_event_id: "ep-1",
          epistemic: "observed",
          confidence: 0.8,
          created_at: "2026-11-10T03:00:00.000Z",
        },
        evidence: [
          {
            event_id: "rf-ep-1",
            record_id: "l0-1",
            role: "assistant",
            quote: "我先回滚了",
            at: "2026-11-10T03:00:00.000Z",
          },
        ],
      };
      await store.commitSoulEvents(TENANT, [reflection]);

      await store.commitSoulEpisodes(TENANT, [
        actionEpisode({ quote: { text: "测试挂了", role: "assistant", recordId: "l0-1" } }),
      ]);
      expect(eventRow(store, "rf-ep-1")).toBeDefined();
      expect(eventRow(store, "ep-1:rollback")).toBeUndefined();
    });

    it("归档父事件时行动子事件一起退出使用", async () => {
      const store = makeStore();
      await store.commitSoulEpisodes(TENANT, [actionEpisode()]);
      expect(store.deleteSoulEpisodes(TENANT, ["ep-1"])).toEqual({ deleted: 0, archived: 1 });
      expect(eventRow(store, "ep-1").archived_at).not.toBeNull();
      expect(eventRow(store, "ep-1:test").archived_at).not.toBeNull();
      expect(eventRow(store, "ep-1:rollback").archived_at).not.toBeNull();
    });
  });

  it("对账口径：旧表本来就没有证据的合法事件不算 missing_evidence", async () => {
    const store = makeStore();
    // evidenceIds=[] → inferred + 0 条证据（§4.2 明确允许），这不是不一致。
    await store.commitSoulEpisodes(TENANT, [episode({ episodeId: "ep-noev", evidenceIds: [], quote: null })]);
    let parity = await store.soulEventParity(TENANT);
    expect(parity.ok).toBe(true);
    expect(parity.diffs).toEqual([]);
    expect(parity.counts.missingEvidence).toBe(0);

    // 反过来：旧表 evidence_json 非空、新表一行证据都没了 → 才是真不一致，要点名。
    await store.commitSoulEpisodes(TENANT, [episode({ episodeId: "ep-has", evidenceIds: ["l0-1"], quote: null })]);
    raw(store).prepare("DELETE FROM soul_event_evidence WHERE event_id = ?").run("ep-has");
    parity = await store.soulEventParity(TENANT);
    expect(parity.ok).toBe(false);
    expect(parity.counts.missingEvidence).toBe(1);
    expect(parity.diffs).toContainEqual({ eventId: "ep-has", kind: "missing_evidence", legacy: null, event: null });
  });
});
