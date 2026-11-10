/**
 * P5 心境层落表（真实临时库）：按租户一行的当前态 + append-only 变化账本。
 *
 * 三件必须成立的事：半衰期写/读都夹在 36–168、默认 48（旧库手改行也不放过）、
 * 账本按 id 幂等（同一 tick 重放不翻倍）、租户之间互不可见。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t2", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-mood-store-")), "vectors.db");
}

function makeStore(): VectorStore {
  const store = new VectorStore(tmpDb(), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级：" + res.reason);
  return store;
}

function moodState(store: VectorStore, tenant = TENANT) {
  return store.readSoulMoodState(tenant);
}

describe("soul_mood_state：按租户一行，半衰期夹在 36–168（默认 48）", () => {
  it("没写过就是 null（「还没积过」≠「心境为零」）", () => {
    expect(moodState(makeStore())).toBeNull();
  });

  it("写进去的 24h 被夹成 36，48h 原样保留，108h 也在区间内", () => {
    const store = makeStore();
    store.writeSoulMoodState(TENANT, {
      label: "恼火",
      valence: -0.4,
      arousal: 0.6,
      intensity: 0.5,
      half_life_hours: 24,
      cause_event_ids_json: JSON.stringify(["ep-1"]),
      updated_at: "2026-11-10T00:00:00.000Z",
    });
    const row = moodState(store);
    expect(row?.half_life_hours).toBe(36);
    expect(row?.label).toBe("恼火");
    expect(row?.cause_event_ids_json).toBe(JSON.stringify(["ep-1"]));

    store.writeSoulMoodState(TENANT, {
      label: "踏实",
      valence: 0.2,
      arousal: 0.3,
      intensity: 0.2,
      half_life_hours: 108,
      cause_event_ids_json: "[]",
      updated_at: "2026-11-10T01:00:00.000Z",
    });
    const next = moodState(store);
    expect(next?.half_life_hours).toBe(108);
    expect(next?.valence).toBeCloseTo(0.2, 6);
    expect(next?.updated_at).toBe("2026-11-10T01:00:00.000Z");
  });

  it("租户之间互不可见", () => {
    const store = makeStore();
    store.writeSoulMoodState(TENANT, {
      label: "平静",
      valence: 0,
      arousal: 0.3,
      intensity: 0,
      half_life_hours: 48,
      cause_event_ids_json: "[]",
      updated_at: "2026-11-10T00:00:00.000Z",
    });
    expect(moodState(store, OTHER)).toBeNull();
  });
});

describe("soul_mood_events：append-only、按 id 幂等", () => {
  it("同一批行重放两次只进一次，按时间倒序列出", () => {
    const store = makeStore();
    const rows = [
      {
        id: "mood-a",
        at: "2026-11-10T00:00:00.000Z",
        kind: "appraisal" as const,
        label: "恼火",
        delta_valence: -0.3,
        delta_arousal: 0.2,
        delta_intensity: 0.4,
        cause_event_ids_json: JSON.stringify(["ep-1"]),
        note: "按 1 条事件积分",
      },
      {
        id: "mood-b",
        at: "2026-11-10T02:00:00.000Z",
        kind: "decay" as const,
        label: null,
        delta_valence: 0.15,
        delta_arousal: -0.1,
        delta_intensity: 0,
        cause_event_ids_json: "[]",
        note: "无新事件，按半衰期衰减",
      },
    ];
    expect(store.commitSoulMoodEvents(TENANT, rows).inserted).toBe(2);
    expect(store.commitSoulMoodEvents(TENANT, rows).inserted).toBe(0);

    const listed = store.listSoulMoodEvents(TENANT);
    expect(listed.map((r) => r.id)).toEqual(["mood-b", "mood-a"]);
    expect(listed[0].label).toBeNull();
    expect(listed[1].cause_event_ids_json).toBe(JSON.stringify(["ep-1"]));
    expect(store.listSoulMoodEvents(TENANT, { kind: "appraisal" }).map((r) => r.id)).toEqual(["mood-a"]);
    expect(store.listSoulMoodEvents(OTHER)).toHaveLength(0);
  });

  it("kind 只收 appraisal/regulation/decay 三值：越界被库层 CHECK 拒绝，失败只降级", () => {
    const store = makeStore();
    const res = store.commitSoulMoodEvents(TENANT, [
      {
        id: "mood-bad",
        at: "2026-11-10T00:00:00.000Z",
        kind: "mood" as never,
        label: null,
        delta_valence: 0,
        delta_arousal: 0,
        delta_intensity: 0,
        cause_event_ids_json: "[]",
        note: "非法 kind",
      },
    ]);
    // 账本写失败不连累整轮 tick：inserted=0、不落行（事务已回滚），错误只进日志。
    expect(res.inserted).toBe(0);
    expect(store.listSoulMoodEvents(TENANT)).toHaveLength(0);
  });
});
