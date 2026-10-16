/**
 * #28 state 状态机测试（S5-state/R5，2026-10-16）
 *
 * 覆盖：指数衰减 golden（48h 半衰期）/ taxonomy 冲量+clamp / 观测直设 /
 * 会话 rollup（排序+空态）/ 统一抽取扩展门读取 / R-A 回归锚（recall-signals
 * 零新增字段冻结清单）/ soul_state sqlite 往返+租户隔离。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_HALF_LIFE_HOURS,
  STATE_IMPULSES,
  applyObservation,
  decayState,
  evaluateStateEvent,
  extractionExtensionsEnabled,
  rollupStateFromRecords,
} from "../soul-state-machine.js";
import { DEFAULT_RANK_SIGNALS, ZERO_RANK_SIGNALS, emotionSalienceOf } from "../../tools/recall-signals.js";
import { VectorStore } from "../../store/sqlite.js";

const T0 = Date.parse("2026-10-16T08:00:00.000Z");
const H = 3_600_000;

describe("#28 state machine", () => {
  it("指数衰减 golden：48h 半衰期（-0.4 → 24h -0.2 → 48h -0.1）", () => {
    const s0: Parameters<typeof decayState>[0] = { valence: -0.4, arousal: 0.5, at: new Date(T0).toISOString() };
    expect(STATE_HALF_LIFE_HOURS).toBe(48);
    const s24 = decayState(s0, T0 + 24 * H);
    expect(s24.valence).toBeCloseTo(-0.282843, 5); // 0.5^(24/48)=√½
    const s48 = decayState(s24, T0 + 72 * H);
    expect(s48.valence).toBeCloseTo(-0.141421, 5); // 再半衰 48h
  });

  it("衰减锚缺失（at 非法）→ 原样返回防漂移", () => {
    const s = decayState({ valence: -0.4, arousal: 0.5 }, T0);
    expect(s.valence).toBe(-0.4);
  });

  it("taxonomy 冲量加性+clamp（tool_failure 中性起步；user_correction 连击夹紧）", () => {
    const s1 = evaluateStateEvent(null, { kind: "tool_failure", at: new Date(T0).toISOString() }, T0);
    expect(s1.valence).toBeCloseTo(-0.3, 6);
    expect(s1.arousal).toBeCloseTo(0.4, 6);
    expect(s1.turnSeq).toBe(1);
    let st = { valence: -0.5, arousal: 0.2, at: new Date(T0).toISOString() } as const;
    for (let i = 0; i < 3; i++) st = evaluateStateEvent(st, { kind: "user_correction", at: new Date(T0 + 1).toISOString() }, T0 + 1) as typeof st;
    expect(st.valence).toBe(-1);
    expect(st.arousal).toBeLessThanOrEqual(1);
  });

  it("显式 event.valence/arousal 覆盖冲量表", () => {
    const s = evaluateStateEvent(null, { kind: "task_switch", valence: 0.9, arousal: 0.05, at: new Date(T0).toISOString() }, T0);
    expect(s.valence).toBeCloseTo(0.9, 6);
    expect(s.arousal).toBeCloseTo(0.05, 6);
  });

  it("观测直设：给定维覆盖、未给维保留衰减值", () => {
    const prev = decayState({ valence: -0.4, arousal: 0.8, at: new Date(T0).toISOString() }, T0 + 48 * H);
    expect(prev.valence).toBeCloseTo(-0.2, 6); // 恰一个半衰期：×0.5
    const obs = applyObservation(prev, { valence: 0.6, at: new Date(T0 + 48 * H).toISOString() }, T0 + 48 * H);
    expect(obs.valence).toBeCloseTo(0.6, 6);
    expect(obs.arousal).toBeCloseTo(0.4, 6);
  });

  it("会话 rollup：occurred_at 升序折叠+末态衰减到 now；无观测→null", () => {
    const records = [
      { valence: -0.4, arousal: null, occurred_at: new Date(T0 + 24 * H).toISOString() },
      { content: "no soul fields" },
      { valence: 0.6, arousal: 0.3, occurred_at: new Date(T0 + 48 * H).toISOString() }, // 时间上更晚→终态以它为准
    ];
    const out = rollupStateFromRecords(null, records, T0 + 49 * H);
    expect(out).not.toBeNull();
    expect(out!.valence).toBeCloseTo(0.6 * Math.pow(0.5, 1 / 48), 5);
    expect(out!.arousal).toBeCloseTo(0.3 * Math.pow(0.5, 1 / 48), 5);
    expect(rollupStateFromRecords(null, [{ content: "x" }], T0)).toBeNull();
  });

  it("统一抽取扩展门读取：缺省 false（config-first）", () => {
    expect(extractionExtensionsEnabled(undefined)).toBe(false);
    expect(extractionExtensionsEnabled({})).toBe(false);
    expect(extractionExtensionsEnabled({ extractionExtensions: { enabled: false } })).toBe(false);
    expect(extractionExtensionsEnabled({ extractionExtensions: { enabled: true } })).toBe(true);
  });
});

describe("#28 R-A 回归锚：recall-signals 零新增字段", () => {
  /** 冻结清单（R-A：情绪禁入召回排序是既有裁决；新增信号必须显式改本清单+过 A/B）。 */
  const FROZEN = [
    "emotionSalienceWeight",
    "importancePenalty",
    "inferredPenalty",
    "moodBoost",
    "recencyBoost",
    "reinforcementWeight",
    "sensitivityPenalty",
    "sigWeight",
    "timeBoost",
  ].sort();

  it("DEFAULT_RANK_SIGNALS / ZERO_RANK_SIGNALS 键集冻结", () => {
    expect(Object.keys(DEFAULT_RANK_SIGNALS).sort()).toEqual(FROZEN);
    expect(Object.keys(ZERO_RANK_SIGNALS).sort()).toEqual(FROZEN);
  });

  it("emotionSalience 仍只消费 {valence, arousal}（soul state 不入信号）", () => {
    expect(emotionSalienceOf({ valence: 0.5, arousal: 0.8 })).toBeGreaterThan(0);
    expect(emotionSalienceOf(undefined)).toBe(0);
  });
});

describe("#28 soul_state sqlite 往返", () => {
  it("upsert/read + 租户隔离（F18）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-state-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init(); // schema（含 soul_state DDL）在 init() 建，ctor 不建表
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };
      expect(store.readSoulState!(t)).toBeNull();
      store.writeSoulState!(t, { valence: -0.35, arousal: 0.55, topValue: "根因", turnSeq: 3, updatedAt: new Date(T0).toISOString() });
      const got = store.readSoulState!(t)!;
      expect(got.valence).toBeCloseTo(-0.35, 6);
      expect(got.arousal).toBeCloseTo(0.55, 6);
      expect(got.topValue).toBe("根因");
      expect(got.turnSeq).toBe(3);
      store.writeSoulState!(t, { valence: 0.2, arousal: 0.1, updatedAt: new Date(T0 + 1).toISOString() });
      expect(store.readSoulState!(t)!.valence).toBeCloseTo(0.2, 6);
      expect(store.readSoulState!({ teamId: "t1", userId: "u1", agentId: "a2" })).toBeNull();
      expect(store.readSoulState!({ teamId: "t2", userId: "u1", agentId: "a1" })).toBeNull();
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
