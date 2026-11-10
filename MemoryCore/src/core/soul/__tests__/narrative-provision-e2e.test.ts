/**
 * P6 / t20 端到端（真实临时库 + 真实 tick）：
 *   老库型事实（episode 在、soul_events 一条都没有）→ tick 先确定性补事件
 *   → 叙事按「证据必须回指 soul_events」的规则正常成章，证据能回到事件；
 *   → 多命中/work 类不建事件，但账上有原因与示例（0 章不再静默）；
 *   → 重放 created=0，章节不翻倍。
 *
 * 不调模型、不 sleep：引文全部是 L0 里已存在的原话。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { assembleSoulCard } from "../card-service.js";
import { resolveSoulConfig, type SoulEpisode } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-p6-provision-e2e-")), "vectors.db");
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
function rows(store: VectorStore, table: string): Row[] {
  return dbOf(store).prepare("SELECT * FROM " + table).all() as unknown as Row[];
}

function monthAgo(n: number) {
  const base = new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - n, 1, 0, 0, 0));
  const at = (day: number) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day, 3, 0, 0)).toISOString();
  return { start: start.toISOString(), at, month: start.toISOString().slice(0, 7) };
}

function seedL0(store: VectorStore, id: string, text: string, recordedAt: string): void {
  const ok = store.upsertL0(
    {
      id,
      sessionKey: "s1",
      sessionId: "s1",
      teamId: TENANT.teamId,
      userId: TENANT.userId,
      agentId: TENANT.agentId,
      role: "user",
      messageText: text,
      recordedAt,
      timestamp: Date.parse(recordedAt),
    },
    undefined,
  );
  if (!ok) throw new Error("L0 写入失败：" + id);
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string; at: string }): SoulEpisode {
  return {
    day: partial.at.slice(0, 10),
    kind: "correction",
    title: "一次纠错",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0.4,
    intensity: 0.6,
    evidenceIds: [],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...partial,
  };
}

/** 造一条「老库」episode：commitSoulEpisodes 会双写事件，删掉事件才算旧库形态。 */
function seedOldEpisode(store: VectorStore, episode: SoulEpisode): void {
  store.commitSoulEpisodes(TENANT, [episode]);
  const db = dbOf(store);
  db.prepare("DELETE FROM soul_event_evidence WHERE event_id = ?").run(episode.episodeId);
  db.prepare("DELETE FROM soul_events WHERE event_id = ?").run(episode.episodeId);
}

function tick(store: VectorStore) {
  return runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
}

describe("P6 / t20 端到端：老库 0 章 → 补事件 → 成章", () => {
  it("补事件后自传成章且证据回到事件；多命中/work 不编造但账上有原因；重放幂等", async () => {
    const store = makeStore();
    const recent = monthAgo(3);
    const ambMonth = monthAgo(4);
    // 两个 L0 都刻意放到 3 个月前的已结束月份：本 tick 的事件挖掘窗口读不到它们，
    // 这样「成章」只可能来自补事件，不会和挖掘出来的新 episode 混在一起。

    seedL0(store, "l0-fix", "召回排序这里不对，你改一下", recent.at(10));
    seedL0(store, "l0-decide", "不做全量回灌，先跑小样本", recent.at(15));
    seedL0(store, "l0-work", "跑下全量测试", recent.at(18));
    seedL0(store, "l0-lead-a", "独立评审后由 Lead 验收。", ambMonth.at(5));
    seedL0(store, "l0-lead-b", "上次也是独立评审后由 Lead 验收的", ambMonth.at(6));

    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-fix",
        at: recent.at(10),
        kind: "correction",
        title: "召回排序的错位被指出来",
        userStance: "召回排序这里不对，你改一下",
        quote: { text: "召回排序这里不对，你改一下", role: "user", recordId: "l0-fix", at: recent.at(10) },
        evidenceIds: ["l0-fix"],
        intensity: 0.9,
      }),
    );
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-decide",
        at: recent.at(15),
        kind: "decision",
        title: "拍板不做全量回灌",
        userStance: "不做全量回灌，先跑小样本",
        quote: { text: "不做全量回灌，先跑小样本", role: "user", recordId: "l0-decide", at: recent.at(15) },
        evidenceIds: ["l0-decide"],
        intensity: 0.7,
      }),
    );
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-work",
        at: recent.at(18),
        kind: "work",
        title: "跑全量测试",
        userStance: "跑下全量测试",
        quote: { text: "跑下全量测试", role: "user", recordId: "l0-work", at: recent.at(18) },
        evidenceIds: ["l0-work"],
      }),
    );
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-amb",
        at: ambMonth.at(5),
        kind: "correction",
        title: "验收的事又提了一次",
        userStance: "独立评审后由 Lead 验收",
        // 引文不带 recordId：两条 L0 都含这句话 → 多命中，必须不猜。
        quote: { text: "独立评审后由 Lead 验收", role: "user", recordId: "", at: ambMonth.at(5) },
        evidenceIds: [],
      }),
    );

    // 补前：一条事件都没有（老库形态）。
    expect(rows(store, "soul_events")).toHaveLength(0);

    const summary = await tick(store);

    // 1) 只有唯一命中的两条被补成事件；work/多命中不建。
    const provision = summary.episodeProvision!;
    expect(provision).toBeTruthy();
    expect(provision.created).toBe(2);
    expect(provision.skippedWork).toBe(1);
    expect(provision.ambiguous).toBe(1);
    expect(provision.skippedUnprovisionable).toBe(2);
    expect(provision.exampleEpisodeId).toBe("ep-amb");
    expect(provision.exampleReason).toBe("ambiguous");
    const eventIds = new Set(rows(store, "soul_events").map((r) => String(r.event_id)));
    expect([...eventIds].sort()).toEqual(["ep-decide", "ep-fix"]);

    // 2) 叙事按原规则成章：只有证据能回指事件的那个月成章。
    const chapters = store.listSoulNarrativeChapters!(TENANT, { status: "active" });
    expect(chapters).toHaveLength(1);
    const chapter = chapters[0];
    expect(String(chapter.period_start)).toBe(recent.start);
    const evidence = store.listSoulNarrativeEvidence!(TENANT, chapter.chapter_id);
    expect(evidence).toHaveLength(2);
    for (const ev of evidence) expect(eventIds.has(String(ev.event_id))).toBe(true);
    expect(evidence.map((ev) => String(ev.event_id)).sort()).toEqual(["ep-decide", "ep-fix"]);

    // 3) 回执不静默：成章 1，另一个月无证据被记下来（不是「没有内容」而是「回不到事件」）。
    expect(summary.narrative?.created).toBe(1);
    expect(summary.narrative?.skippedNoEvidence ?? 0).toBeGreaterThanOrEqual(1);
    expect(summary.narrative?.evidence).toBe(2);

    // 4) 卡面能读到这段自传，且「最近」块带事件 id。
    const card = await assembleSoulCard({ store, tenant: TENANT, persist: false });
    expect(card.text).toContain(String(chapter.title));
    const recentBlock = card.blocks.find((b) => b.id === "recent");
    expect(recentBlock?.evidenceIds ?? []).toEqual(expect.arrayContaining(["ep-fix", "ep-decide"]));

    // 5) 重放：补事件 created=0，章节与证据行数不变；补不了的仍然记账（不静默）。
    const chapterRows = rows(store, "soul_narrative").length;
    const evidenceRows = rows(store, "soul_narrative_evidence").length;
    const again = await tick(store);
    expect(again.episodeProvision?.created).toBe(0);
    expect(again.episodeProvision?.scanned).toBe(2);
    expect(again.episodeProvision?.skippedUnprovisionable).toBe(2);
    expect(again.episodeProvision?.exampleEpisodeId).toBe("ep-amb");
    expect(again.narrative?.created).toBe(0);
    expect(rows(store, "soul_narrative")).toHaveLength(chapterRows);
    expect(rows(store, "soul_narrative_evidence")).toHaveLength(evidenceRows);

    store.close();
  });
});
