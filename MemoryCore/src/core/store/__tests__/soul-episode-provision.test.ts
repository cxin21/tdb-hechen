/**
 * P6 / t20：episode 的确定性补事件（store 层）。
 *
 * 这里守的是三条底线：
 *  - 只把 L0 里**已经存在**的原话补成事件，event_id = episodeId（与双写同口径，幂等）；
 *  - 唯一命中才建：零命中/多命中/work/没有可匹配原文一律不建，且账上能看到原因；
 *  - 不越租户、不超每 tick 上限，重放 created=0。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { EPISODE_PROVISION_MAX_PER_TICK } from "../../soul/episode-provision.js";
import type { SoulEpisode } from "../../soul/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t2", userId: "u2", agentId: "a2" };
const AT = "2026-10-12T03:00:00.000Z";

function makeStore(): VectorStore {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-ep-provision-")), "vectors.db");
  const store = new VectorStore(file, 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return store;
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

function seedL0(store: VectorStore, id: string, text: string, tenant = TENANT, role = "user"): void {
  const ok = store.upsertL0(
    {
      id,
      sessionKey: "s1",
      sessionId: "s1",
      teamId: tenant.teamId,
      userId: tenant.userId,
      agentId: tenant.agentId,
      role,
      messageText: text,
      recordedAt: AT,
      timestamp: Date.parse(AT),
    },
    undefined,
  );
  if (!ok) throw new Error("L0 写入失败：" + id);
}

/** 模拟老库：episode 在、事件没有（commitSoulEpisodes 会双写，所以先删掉）。 */
function seedOldEpisode(store: VectorStore, episode: SoulEpisode, tenant = TENANT): void {
  store.commitSoulEpisodes(tenant, [episode]);
  const db = dbOf(store);
  db.prepare("DELETE FROM soul_event_evidence WHERE event_id = ?").run(episode.episodeId);
  db.prepare("DELETE FROM soul_events WHERE event_id = ?").run(episode.episodeId);
}

function ep(partial: Partial<SoulEpisode> & { episodeId: string }): SoulEpisode {
  return {
    at: AT,
    day: AT.slice(0, 10),
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

function eventsOf(store: VectorStore, eventId: string) {
  return dbOf(store).prepare("SELECT * FROM soul_events WHERE event_id = ?").all(eventId) as unknown as Array<
    Record<string, unknown>
  >;
}
function evidenceOf(store: VectorStore, eventId: string) {
  return dbOf(store)
    .prepare("SELECT * FROM soul_event_evidence WHERE event_id = ? ORDER BY record_id ASC")
    .all(eventId) as unknown as Array<Record<string, unknown>>;
}

describe("t20：episode 确定性补事件", () => {
  it("唯一命中补一条 chat 事件：event_id=episodeId、证据回到 L0、重放 created=0", () => {
    const store = makeStore();
    seedL0(store, "l0-fix", "召回排序这里不对，你改一下");
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-fix",
        userStance: "召回排序这里不对，你改一下",
        quote: { text: "召回排序这里不对，你改一下", role: "user", recordId: "l0-fix", at: AT },
        evidenceIds: ["l0-fix"],
      }),
    );

    const first = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(first.scanned).toBe(1);
    expect(first.created).toBe(1);
    expect(first.skippedUnprovisionable).toBe(0);

    const rows = eventsOf(store, "ep-fix");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].source_kind)).toBe("chat");
    expect(String(rows[0].source_ref)).toBe("l0-fix");
    expect(String(rows[0].dedupe_key)).toContain("soul-episode:ep-fix");
    const evidence = evidenceOf(store, "ep-fix");
    expect(evidence.map((e) => String(e.record_id))).toEqual(["l0-fix"]);
    expect(String(evidence[0].role)).toBe("user");
    expect(String(evidence[0].quote)).toBe("召回排序这里不对，你改一下");

    const again = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(again.scanned).toBe(0);
    expect(again.created).toBe(0);
    expect(eventsOf(store, "ep-fix")).toHaveLength(1);
    store.close();
  });

  it("零命中不建事件：计入 notFound 并留示例，episode 仍然没有事件", () => {
    const store = makeStore();
    seedL0(store, "l0-other", "今天先把注入预算压下来");
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-gone",
        quote: { text: "这句话在 L0 里根本不存在", role: "user", recordId: "m-gone", at: AT },
        evidenceIds: ["m-gone"],
      }),
    );

    const res = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(res.created).toBe(0);
    expect(res.notFound).toBe(1);
    expect(res.skippedUnprovisionable).toBe(1);
    expect(res.exampleEpisodeId).toBe("ep-gone");
    expect(res.exampleReason).toBe("not_found");
    expect(eventsOf(store, "ep-gone")).toHaveLength(0);
    store.close();
  });

  it("多命中不猜：两条 L0 都含引文 → ambiguous、不建事件", () => {
    const store = makeStore();
    seedL0(store, "l0-a", "独立评审后由 Lead 验收。");
    seedL0(store, "l0-b", "上次也是独立评审后由 Lead 验收的");
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-amb",
        quote: { text: "独立评审后由 Lead 验收", role: "user", recordId: "", at: AT },
        evidenceIds: [],
      }),
    );

    const res = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(res.created).toBe(0);
    expect(res.ambiguous).toBe(1);
    expect(res.exampleReason).toBe("ambiguous");
    expect(eventsOf(store, "ep-amb")).toHaveLength(0);
    store.close();
  });

  it("精确多条但引文自带 recordId：用它消歧，不判多命中", () => {
    const store = makeStore();
    const text = "这格又漏了";
    seedL0(store, "l0-x", text);
    seedL0(store, "l0-y", text);
    seedOldEpisode(
      store,
      ep({ episodeId: "ep-pin", quote: { text, role: "user", recordId: "l0-y", at: AT }, evidenceIds: ["l0-y"] }),
    );

    const res = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(res.created).toBe(1);
    const [row] = eventsOf(store, "ep-pin");
    expect(String(row.source_ref)).toBe("l0-y");
    store.close();
  });

  it("work 类不造 chat 事件；没有可匹配原文记 no_source", () => {
    const store = makeStore();
    seedL0(store, "l0-work", "跑下全量测试");
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-work",
        kind: "work",
        userStance: "跑下全量测试",
        quote: { text: "跑下全量测试", role: "user", recordId: "l0-work", at: AT },
        evidenceIds: ["l0-work"],
      }),
    );
    seedOldEpisode(
      store,
      ep({ episodeId: "ep-empty", kind: "decision", quote: null, userStance: "", evidenceIds: [] }),
    );

    const res = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(res.created).toBe(0);
    expect(res.skippedWork).toBe(1);
    expect(res.noSource).toBe(1);
    expect(res.skippedUnprovisionable).toBe(2);
    expect(eventsOf(store, "ep-work")).toHaveLength(0);
    expect(eventsOf(store, "ep-empty")).toHaveLength(0);
    store.close();
  });

  it("每 tick 上限：limit=1 时只补一条，其余下轮继续；默认上限是 50", () => {
    const store = makeStore();
    expect(EPISODE_PROVISION_MAX_PER_TICK).toBe(50);
    for (const id of ["a", "b"]) {
      seedL0(store, "l0-" + id, "第 " + id + " 条原话");
      seedOldEpisode(
        store,
        ep({
          episodeId: "ep-" + id,
          quote: { text: "第 " + id + " 条原话", role: "user", recordId: "l0-" + id, at: AT },
          evidenceIds: ["l0-" + id],
        }),
      );
    }
    const first = store.provisionSoulEpisodeEvents!(TENANT, { now: AT, limit: 1 });
    expect(first.scanned).toBe(2);
    expect(first.created).toBe(1);
    expect(first.limitReached).toBe(true);
    const second = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(second.created).toBe(1);
    const third = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(third.created).toBe(0);
    store.close();
  });

  it("租户隔离：别人的 L0 不算命中", () => {
    const store = makeStore();
    seedL0(store, "l0-t2", "这条原话属于另一个租户", OTHER);
    seedOldEpisode(
      store,
      ep({
        episodeId: "ep-iso",
        quote: { text: "这条原话属于另一个租户", role: "user", recordId: "l0-t2", at: AT },
        evidenceIds: ["l0-t2"],
      }),
    );
    const res = store.provisionSoulEpisodeEvents!(TENANT, { now: AT });
    expect(res.created).toBe(0);
    expect(res.notFound).toBe(1);
    expect(eventsOf(store, "ep-iso")).toHaveLength(0);
    store.close();
  });
});
