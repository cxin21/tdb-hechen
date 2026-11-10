/**
 * P6 叙事派生（spec §4.8）：事件 → 自传章节。
 *
 * 纪律（都是可断言的）：
 *  - 只按月巩固「已结束的自然月」：月份没走完就写章节，等于边写边改同一章，幂等也就没了。
 *  - 每章 1–3 条证据，且证据必须是 soul_events 里真实存在的事件（回不去事件的章不写）。
 *  - 只写事件支持的内容：summary 的每句都带那天的原话或结果，不补心理戏。
 *  - 同一 period 只有一条 active：换版本走 version + supersedes_id，旧行留给审计。
 *  - 显著度 salience 按 period_end 起算衰减，低于注入门的章停止注入但不删行（可查）。
 */

import { describe, expect, it } from "vitest";
import {
  NARRATIVE_INJECT_MAX_LINES,
  NARRATIVE_INJECT_MIN_SALIENCE,
  NARRATIVE_MAX_CHAPTERS,
  NARRATIVE_MAX_EVIDENCE,
  deriveNarrativeChapters,
  narrativeDecayedSalience,
  narrativeInjectionLines,
} from "../narrative.js";
import type { SoulNarrativeRow } from "../../store/soul-event-types.js";
import type { SoulEpisode } from "../types.js";

const NOW = "2026-11-10T09:00:00.000Z";

/** 造一个 n 个月前的已结束月份：返回 [period_start, period_end, 事件时刻]。 */
function monthAgo(n: number): { start: string; end: string; at: string } {
  const base = new Date(NOW);
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - n, 1, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0));
  const at = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 10, 3, 0, 0)).toISOString();
  return { start: start.toISOString(), end: end.toISOString(), at };
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "correction",
    title: "一次纠错",
    object: "召回排序",
    participants: ["何晨", "assistant"],
    userStance: "这里不对",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: -0.2,
    arousal: 0.5,
    intensity: 0.6,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...partial,
  };
}

function row(partial: Partial<SoulNarrativeRow> & { chapter_id: string }): SoulNarrativeRow {
  return {
    team_id: "t1",
    user_id: "u1",
    agent_id: "a1",
    period_start: monthAgo(1).start,
    period_end: monthAgo(1).end,
    title: "2026-10：纠错 1",
    summary: "10-10：一次纠错，你说「这里不对」。",
    turning_points_json: "[]",
    lessons_json: "[]",
    version: 1,
    hash: "h1",
    supersedes_id: null,
    status: "active",
    created_at: NOW,
    salience: 0.6,
    access_count: 0,
    last_accessed_at: null,
    updated_at: null,
    ...partial,
  };
}

describe("叙事派生：按月成章", () => {
  it("已结束的月份才成章，最多 7 章（月度 3–7 章的上限口径）", () => {
    const episodes: SoulEpisode[] = [];
    const eventIds = new Set<string>();
    for (let n = 1; n <= 10; n += 1) {
      const m = monthAgo(n);
      const e = ep({ episodeId: "ep-m" + n, at: m.at });
      episodes.push(e);
      eventIds.add(e.episodeId);
    }
    // 当月（未结束）的事件：不产章。
    const current = ep({ episodeId: "ep-current", at: NOW });
    episodes.push(current);
    eventIds.add(current.episodeId);

    const out = deriveNarrativeChapters({ episodes, eventIds, now: NOW });
    expect(NARRATIVE_MAX_CHAPTERS).toBe(7);
    expect(out.chapters).toHaveLength(NARRATIVE_MAX_CHAPTERS);
    expect(out.skippedUnclosed).toBe(1);
    const starts = out.chapters.map((c) => c.chapter.period_start).sort();
    expect(starts).toEqual(Array.from({ length: 7 }, (_, i) => monthAgo(i + 1).start).sort());
    expect(starts).not.toContain(monthAgo(0).start);
  });

  it("每章 1–3 条证据：6 条事件取 3 条，1 条事件就 1 条", () => {
    const m1 = monthAgo(1);
    const m2 = monthAgo(2);
    const many = Array.from({ length: 6 }, (_, i) =>
      ep({
        episodeId: "ep-a" + i,
        at: new Date(Date.parse(m1.at) + i * 3600_000).toISOString(),
        intensity: 0.4 + i * 0.05,
      }),
    );
    const one = ep({ episodeId: "ep-b0", at: m2.at });
    const out = deriveNarrativeChapters({
      episodes: [...many, one],
      eventIds: new Set([...many.map((e) => e.episodeId), one.episodeId]),
      now: NOW,
    });
    const sep = out.chapters.find((c) => c.chapter.period_start === m1.start)!;
    const aug = out.chapters.find((c) => c.chapter.period_start === m2.start)!;
    expect(sep.evidence).toHaveLength(NARRATIVE_MAX_EVIDENCE);
    expect(aug.evidence).toHaveLength(1);
    expect(sep.evidence.map((e) => e.event_id)).toEqual(["ep-a5", "ep-a4", "ep-a3"]);
    for (const c of out.chapters) {
      expect(c.evidence.length).toBeGreaterThanOrEqual(1);
      expect(c.evidence.length).toBeLessThanOrEqual(3);
    }
  });

  it("证据回不到事件就不成章：episode 在，soul_events 里没有 → skippedNoEvidence", () => {
    const m = monthAgo(1);
    const e = ep({ episodeId: "ep-ghost", at: m.at });
    const out = deriveNarrativeChapters({ episodes: [e], eventIds: new Set(), now: NOW });
    expect(out.chapters).toHaveLength(0);
    expect(out.skippedNoEvidence).toBe(1);
  });

  it("只写事件支持的内容：summary 带原话/结果，不补心理戏", () => {
    const m = monthAgo(1);
    const e = ep({
      episodeId: "ep-1",
      at: m.at,
      title: "排序口径被当场纠正",
      userStance: "精度处理应该在 SCOrder 里",
      agentStance: "我改到 util 了",
      outcome: "改回来并补了用例",
    });
    const out = deriveNarrativeChapters({ episodes: [e], eventIds: new Set(["ep-1"]), now: NOW });
    const summary = out.chapters[0]!.chapter.summary;
    expect(summary).toContain("排序口径被当场纠正");
    expect(summary).toContain("精度处理应该在 SCOrder 里");
    expect(summary).toContain("我改到 util 了");
    expect(summary).toContain("改回来并补了用例");
    for (const invented of ["我觉得", "大概", "也许是", "心里想"]) expect(summary).not.toContain(invented);
    expect(out.chapters[0]!.chapter.title).toContain(m.start.slice(0, 7));
  });

  it("显著度：证据多、情绪强、有转折的月份分更高，且落在 0..1", () => {
    const strong = monthAgo(1);
    const weak = monthAgo(2);
    const strongEps = [
      ep({ episodeId: "s1", at: strong.at, intensity: 0.9, kind: "value_conflict" }),
      ep({
        episodeId: "s2",
        at: new Date(Date.parse(strong.at) + 3600_000).toISOString(),
        intensity: 0.9,
        kind: "decision",
      }),
      ep({
        episodeId: "s3",
        at: new Date(Date.parse(strong.at) + 7200_000).toISOString(),
        intensity: 0.9,
        kind: "praise",
      }),
    ];
    const weakEps = [ep({ episodeId: "w1", at: weak.at, intensity: 0.05, kind: "work" })];
    const out = deriveNarrativeChapters({
      episodes: [...strongEps, ...weakEps],
      eventIds: new Set(["s1", "s2", "s3", "w1"]),
      now: NOW,
    });
    const strongRow = out.chapters.find((c) => c.chapter.period_start === strong.start)!.chapter;
    const weakRow = out.chapters.find((c) => c.chapter.period_start === weak.start)!.chapter;
    expect(Number(strongRow.salience)).toBeGreaterThan(Number(weakRow.salience));
    for (const r of [strongRow, weakRow]) {
      expect(r.salience).toBeGreaterThan(0);
      expect(r.salience).toBeLessThanOrEqual(1);
    }
    expect(JSON.parse(String(strongRow.turning_points_json)).length).toBeGreaterThanOrEqual(1);
  });

  it("同 hash 重放：不产新章（reasserted），不产生新版本", () => {
    const m = monthAgo(1);
    const e = ep({ episodeId: "ep-1", at: m.at });
    const first = deriveNarrativeChapters({ episodes: [e], eventIds: new Set(["ep-1"]), now: NOW });
    const prev = row({
      chapter_id: "narr-2026-10-v1",
      period_start: m.start,
      period_end: m.end,
      hash: first.chapters[0]!.chapter.hash,
    });
    const second = deriveNarrativeChapters({
      episodes: [e],
      eventIds: new Set(["ep-1"]),
      previous: [prev],
      now: NOW,
    });
    expect(second.chapters).toHaveLength(0);
    expect(second.reasserted).toBe(1);
  });

  it("同一时段不出现互相矛盾的 active 章节：内容变了就出新版本并把旧版标 superseded", () => {
    const m = monthAgo(1);
    const e = ep({ episodeId: "ep-1", at: m.at });
    const v2Episode = ep({
      episodeId: "ep-2",
      at: new Date(Date.parse(m.at) + 86400_000).toISOString(),
      title: "改完了",
      userStance: "这次对了",
      agentStance: "按你说的改回来了",
      outcome: "12 例全绿",
      kind: "praise",
    });
    const prev = row({
      chapter_id: "narr-2026-10-v1",
      period_start: m.start,
      period_end: m.end,
      hash: "old-hash",
      version: 1,
      status: "active",
    });
    const out = deriveNarrativeChapters({
      episodes: [e, v2Episode],
      eventIds: new Set(["ep-1", "ep-2"]),
      previous: [prev],
      now: NOW,
    });
    expect(out.chapters).toHaveLength(1);
    const plan = out.chapters[0]!;
    expect(plan.chapter.version).toBe(2);
    expect(plan.chapter.supersedes_id).toBe("narr-2026-10-v1");
    expect(plan.supersedesIds).toEqual(["narr-2026-10-v1"]);
    expect(plan.chapter.chapter_id).not.toBe("narr-2026-10-v1");
    expect(plan.evidence.length).toBeGreaterThanOrEqual(1);
  });
});

describe("叙事巩固：显著度衰减、注入门与遗忘", () => {
  it("显著度按 period_end 衰减：半年减半、一年剩下四分之一，access 有上限加成", () => {
    const r = row({ chapter_id: "n1", salience: 0.6, period_end: "2026-05-01T00:00:00.000Z", access_count: 0 });
    const atEnd = narrativeDecayedSalience(r, "2026-05-01T00:00:00.000Z");
    expect(atEnd).toBeCloseTo(0.6, 5);
    const halfYear = narrativeDecayedSalience(r, "2026-11-01T00:00:00.000Z");
    expect(halfYear).toBeGreaterThan(0.29);
    expect(halfYear).toBeLessThan(0.32);
    const oneYear = narrativeDecayedSalience(r, "2027-05-01T00:00:00.000Z");
    expect(oneYear).toBeGreaterThan(0.14);
    expect(oneYear).toBeLessThan(0.16);
    const reused = narrativeDecayedSalience({ ...r, access_count: 50 }, "2026-11-01T00:00:00.000Z");
    expect(reused).toBeLessThanOrEqual(0.32 * 1.4 + 1e-9);
    expect(reused).toBeGreaterThan(halfYear);
  });

  it("低显著旧章停止注入但仍在库里可查；active 且过门的最多注入 2 条，按显著度降序", () => {
    const recent = row({ chapter_id: "n-recent", salience: 0.9, period_end: monthAgo(1).end });
    const oldWeak = row({ chapter_id: "n-old", salience: 0.4, period_end: monthAgo(8).end });
    const superseded = row({
      chapter_id: "n-super",
      salience: 0.95,
      period_end: monthAgo(1).end,
      status: "superseded",
    });
    const second = row({ chapter_id: "n-2", salience: 0.7, period_end: monthAgo(2).end });
    const third = row({ chapter_id: "n-3", salience: 0.6, period_end: monthAgo(3).end });
    const lines = narrativeInjectionLines([recent, second, third, oldWeak, superseded], { now: NOW });
    expect(lines).toHaveLength(NARRATIVE_INJECT_MAX_LINES);
    expect(lines.map((l) => l.chapterId)).toEqual(["n-recent", "n-2"]);
    expect(NARRATIVE_INJECT_MIN_SALIENCE).toBeCloseTo(0.35, 5);
    expect(narrativeDecayedSalience(oldWeak, NOW)).toBeLessThan(NARRATIVE_INJECT_MIN_SALIENCE);
    expect(oldWeak.status).toBe("active");
  });

  it("注入行带章节标题与首句，且不超过单行上限（不含换行）", () => {
    const r = row({
      chapter_id: "n1",
      title: "2026-10：纠错 2 · 拍板 1",
      summary: "10-03：一次纠错，你说「这里不对」，我回「改」。\n10-05：拍板了。",
      salience: 0.8,
      period_end: monthAgo(1).end,
    });
    const [line] = narrativeInjectionLines([r], { now: NOW });
    expect(line!.text).toContain("2026-10：纠错 2 · 拍板 1");
    expect(line!.text).toContain("10-03");
    expect(line!.text).not.toContain("\n");
    expect(line!.text.length).toBeLessThanOrEqual(140);
    expect(line!.evidenceIds).toEqual([]);
  });
});
