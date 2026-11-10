/**
 * P6 端到端（真实临时库 + 真实 tick 路径）：
 *   soul_episodes/soul_events（已结束月份）→ 巩固成章节（soul_narrative + 证据）
 *   → 证据能回到事件、卡面「最近」块带上章节与事件 id
 *   → 低显著的旧章停止注入但仍在库里可查（遗忘不是删行）
 *   → 同一时段内容变了只升版（旧版 superseded），数据库层挡住第二条 active。
 *
 * 只用注入的时间戳与真实 tick：不 sleep、不读真实语义，重放两次必须同结果。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { assembleSoulCard } from "../card-service.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";
import { NARRATIVE_INJECT_MIN_SALIENCE, narrativeDecayedSalience } from "../narrative.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-p6-e2e-")), "vectors.db");
}

function makeStore(): VectorStore {
  const store = new VectorStore(tmpDb(), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return store;
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

type Row = Record<string, unknown>;

function rows(db: ReturnType<typeof dbOf>, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as unknown as Row[];
}

/** n 个月前那个已结束的自然月：[月初, 次月初, 月中事件时刻, YYYY-MM]。 */
function monthAgo(n: number) {
  const base = new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - n, 1, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0));
  const at = (day: number) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day, 3, 0, 0)).toISOString();
  return { start: start.toISOString(), end: end.toISOString(), at, month: start.toISOString().slice(0, 7) };
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "work",
    title: "一次推进",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0.4,
    intensity: 0.5,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...partial,
  };
}

function tick(store: VectorStore) {
  return runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
}
describe("P6 端到端：叙事章节落到真实 tick", () => {
  it("自传有章节且证据回指事件；低显著旧章不注入但可查；同月只留一条 active", async () => {
    const store = makeStore();
    const db = dbOf(store);
    const recent = monthAgo(1);
    const old = monthAgo(3);

    store.commitSoulEpisodes(TENANT, [
      ep({ episodeId: "ep-fix", at: recent.at(10), kind: "correction", title: "召回排序的错位被指出来", userStance: "这里不对", agentStance: "改完重排了", outcome: "改完重跑全绿", intensity: 0.9 }),
      ep({ episodeId: "ep-work", at: recent.at(12), kind: "work", title: "把注入预算压到两百字", userStance: "先按这个走", outcome: "预算落地", intensity: 0.6 }),
      ep({ episodeId: "ep-decide", at: recent.at(15), kind: "decision", title: "拍板不做全量回灌", userStance: "不做全量回灌", intensity: 0.7 }),
      ep({ episodeId: "ep-old", at: old.at(10), kind: "work", title: "一次很轻的日常推进", intensity: 0.2 }),
    ]);

    const summary = await tick(store);

    // 1) 两个已结束月份各成一章；只有一条 active。
    const chapters = store.listSoulNarrativeChapters!(TENANT, { status: "active" });
    expect(chapters).toHaveLength(2);
    const recentChapter = chapters.find((c) => c.period_start === recent.start)!;
    const oldChapter = chapters.find((c) => c.period_start === old.start)!;
    expect(recentChapter).toBeTruthy();
    expect(oldChapter).toBeTruthy();
    expect(recentChapter.status).toBe("active");
    expect(recentChapter.version).toBe(1);
    expect(String(recentChapter.title)).toContain(recent.month + "：");
    expect(String(recentChapter.summary)).toContain("你说「");

    // 2) 每章 1–3 条证据，且每条都能回到 soul_events 的真实事件。
    const recentEvidence = store.listSoulNarrativeEvidence!(TENANT, recentChapter.chapter_id);
    expect(recentEvidence).toHaveLength(3);
    const eventIds = new Set(rows(db, "soul_events").map((r) => String(r.event_id)));
    for (const ev of recentEvidence) expect(eventIds.has(String(ev.event_id))).toBe(true);
    expect(recentEvidence.map((ev) => String(ev.event_id)).sort()).toEqual(["ep-decide", "ep-fix", "ep-work"]);
    const oldEvidence = store.listSoulNarrativeEvidence!(TENANT, oldChapter.chapter_id);
    expect(oldEvidence).toHaveLength(1);
    expect(String(oldEvidence[0].event_id)).toBe("ep-old");

    // 3) 回执：巩固了两个月、成章 2、证据 4，不是静默。
    expect(summary.narrative?.months ?? 0).toBeGreaterThanOrEqual(2);
    expect(summary.narrative?.created).toBe(2);
    expect(summary.narrative?.evidence).toBe(4);

    // 4) 卡面：新章进「最近」块并带事件 id；三个月前的轻事件衰减到注入门下，不注入。
    expect(narrativeDecayedSalience(oldChapter)).toBeLessThan(NARRATIVE_INJECT_MIN_SALIENCE);
    const card = await assembleSoulCard({ store, tenant: TENANT, persist: false });
    expect(card.text).toContain(String(recentChapter.title));
    expect(card.text).not.toContain(String(oldChapter.title));
    const recentBlock = card.blocks.find((b) => b.id === "recent");
    expect(recentBlock?.evidenceIds ?? []).toEqual(expect.arrayContaining(["ep-fix", "ep-work", "ep-decide"]));

    // 5) 遗忘不是删行：低显著章仍在库里、仍能按 chapterId 查到正文与证据。
    expect(store.getSoulNarrativeChapter!(TENANT, oldChapter.chapter_id)?.chapter_id).toBe(oldChapter.chapter_id);
    expect(String(store.getSoulNarrativeChapter!(TENANT, oldChapter.chapter_id)?.summary).length).toBeGreaterThan(0);

    // 6) 同一时段内容变了：出新版本、旧版 superseded，active 仍只有一条。
    // 前置：把事件全归档——「遗忘」只是停止注入、行还在；章节证据必须仍回得到这些事件，
    // 否则巩固会把「已经淡出的事件」当成不存在，自传就断了根。
    db.prepare("UPDATE soul_events SET archived_at = ?").run(new Date().toISOString());
    expect(Number((db.prepare("SELECT COUNT(*) AS n FROM soul_events WHERE archived_at IS NOT NULL").get() as { n?: number }).n)).toBeGreaterThanOrEqual(4);
    store.commitSoulEpisodes(TENANT, [
      ep({ episodeId: "ep-fix", at: recent.at(10), kind: "correction", title: "召回排序的错位被指出来", userStance: "这里不对，我又核了一遍", agentStance: "改完重排了", outcome: "改完重跑全绿", intensity: 0.9 }),
    ]);
    const summary2 = await tick(store);
    const versions = rows(db, "soul_narrative").filter(
      (r) => r.period_start === recent.start && String(r.status) === "active",
    );
    expect(versions).toHaveLength(1);
    expect(Number(versions[0].version)).toBe(2);
    expect(String(versions[0].supersedes_id)).toBe(recentChapter.chapter_id);
    const superseded = rows(db, "soul_narrative").filter(
      (r) => String(r.chapter_id) === recentChapter.chapter_id,
    );
    expect(String(superseded[0].status)).toBe("superseded");
    expect(summary2.narrative?.superseded ?? 0).toBeGreaterThanOrEqual(1);
    const v2Evidence = store.listSoulNarrativeEvidence!(TENANT, String(versions[0].chapter_id));
    expect(v2Evidence).toHaveLength(3);
    expect(v2Evidence.map((ev) => String(ev.event_id)).sort()).toEqual(["ep-decide", "ep-fix", "ep-work"]);

    // 7) 数据库层兜底：绕过写者插第二条 active，直接撞部分唯一索引。
    expect(() =>
      db
        .prepare(
          "INSERT INTO soul_narrative (chapter_id, team_id, user_id, agent_id, period_start, period_end, title, summary, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("narr-manual", TENANT.teamId, TENANT.userId, TENANT.agentId, recent.start, recent.end, "手写第二版", "同一时段另一条 active", "h-manual", new Date().toISOString()),
    ).toThrow(/UNIQUE constraint failed/);

    // 8) 重放：同一批事实再 tick 一次，不新增章、不新增证据行。
    const chapterRowsBefore = rows(db, "soul_narrative").length;
    const evidenceRowsBefore = rows(db, "soul_narrative_evidence").length;
    const summary3 = await tick(store);
    expect(rows(db, "soul_narrative")).toHaveLength(chapterRowsBefore);
    expect(rows(db, "soul_narrative_evidence")).toHaveLength(evidenceRowsBefore);
    expect(summary3.narrative?.created).toBe(0);
    expect(summary3.narrative?.reasserted ?? 0).toBeGreaterThanOrEqual(2);
  });
});