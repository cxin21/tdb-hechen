/**
 * §5 P3-E：GET /v3/soul/emotions 的合同测试（假 store，不连库）。
 *
 * 这条读面只解决一件事：面板要能看到「最近的情绪行 + 今天的漏斗」。
 * 因此测试盯四个点——信封字段齐、limit 有上限、since 真的传到 store、
 * store 缺读方法时降级成 503 而不是 500。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import {
  SOUL_EMOTIONS_LIMIT_DEFAULT,
  SOUL_EMOTIONS_LIMIT_MAX,
  handleSoulEmotionsRoute,
} from "../soul-emotions-endpoint.js";

const res = {} as ServerResponse;
const NOW = "2026-11-08T12:00:00.000Z";
const DAY = NOW.slice(0, 10);

type Row = Record<string, unknown>;

function makeStore(rows: Row[] = [], stats: Row[] = []) {
  const calls = { list: [] as unknown[], stats: [] as unknown[] };
  const store = {
    listSoulEmotions: async (tenant: unknown, opts: unknown) => {
      calls.list.push({ tenant, opts });
      return rows;
    },
    listSoulGateStats: async (tenant: unknown, opts: unknown) => {
      calls.stats.push({ tenant, opts });
      return stats;
    },
  };
  return { store, calls };
}

async function call(
  url: string,
  opts: { method?: string; store?: unknown; now?: string } = {},
) {
  const sendJson = vi.fn();
  const handled = await handleSoulEmotionsRoute(
    new URL(url, "http://localhost"),
    opts.method ?? "GET",
    sendJson,
    res,
    { getStore: () => (opts.store ?? {}) as never, now: () => opts.now ?? NOW },
  );
  const [, status, payload] = (sendJson.mock.calls[0] ?? []) as [unknown, number, unknown];
  return { handled, sendJson, status, payload: payload as { code: number; data: Record<string, unknown> } };
}

describe("GET /v3/soul/emotions（§5 P3-E）", () => {
  it("只认 GET + /v3/soul/emotions，其余交回 dispatch", async () => {
    expect((await call("/v3/soul/emotions", { method: "POST" })).handled).toBe(false);
    expect((await call("/v3/soul/other")).handled).toBe(false);
  });

  it("200：明细字段齐（含 decayedIntensity 现算）与漏斗六键", async () => {
    const { store } = makeStore(
      [
        {
          episodeId: "ep-1",
          at: "2026-11-08T00:00:00.000Z",
          object: "假绿",
          objectPerson: null,
          label: "开心",
          valence: 0.7,
          arousal: 0.55,
          dominance: 0.7,
          intensity: 0.4,
          appraisal: { goalRelevance: 0.5 },
          templateVersion: "et-e9a10bb3",
          appraisedAt: "2026-11-08T00:00:00.000Z",
          agency: "other",
          confidence: 0.5,
        },
      ],
      [
        { day: DAY, code: "emotion:candidate", layer: "emotion", count: 3 },
        { day: DAY, code: "emotion:committed", layer: "emotion", count: 1 },
        // 别的层/别的日同 code 不该被加进来
        { day: DAY, code: "emotion:candidate", layer: "mood", count: 99 },
        { day: "2026-11-07", code: "emotion:candidate", layer: "emotion", count: 42 },
      ],
    );
    const { handled, status, payload } = await call(
      "/v3/soul/emotions?team=t1&user=u1&agent=a1",
      { store },
    );
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload.code).toBe(0);

    const rows = payload.data.rows as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: "2026-11-08T00:00:00.000Z",
      object: "假绿",
      objectPerson: null,
      label: "开心",
      valence: 0.7,
      arousal: 0.55,
      dominance: 0.7,
      intensity: 0.4,
      agency: "other",
      confidence: 0.5,
      templateVersion: "et-e9a10bb3",
    });
    // 0.4 的「开心」半衰期 2h，12h 后 = 0.4·2^-6 = 0.00625（读侧只衰一次）
    expect(rows[0].decayedIntensity).toBeCloseTo(0.4 * Math.pow(2, -6), 6);

    const funnel = payload.data.funnel as Record<string, number>;
    expect(Object.keys(funnel).sort()).toEqual(
      [
        "emotion:anchor_hit",
        "emotion:appraised",
        "emotion:candidate",
        "emotion:committed",
        "emotion:intensity_ok",
        "emotion:object_ok",
      ].sort(),
    );
    expect(funnel["emotion:candidate"]).toBe(3); // 只算当日 + emotion 层
    expect(funnel["emotion:committed"]).toBe(1);
    expect(funnel["emotion:anchor_hit"]).toBe(0); // 没行就是 0，不编造
  });

  it("limit 默认 50、超过上限夹到 200、非法值回落默认", async () => {
    for (const [query, expected] of [
      ["", SOUL_EMOTIONS_LIMIT_DEFAULT],
      ["?limit=5000", SOUL_EMOTIONS_LIMIT_MAX],
      ["?limit=0", 1],
      ["?limit=abc", SOUL_EMOTIONS_LIMIT_DEFAULT],
    ] as const) {
      const { store, calls } = makeStore();
      await call(`/v3/soul/emotions${query}`, { store });
      expect((calls.list[0] as { opts: { limit: number } }).opts.limit).toBe(expected);
      expect(expected).toBeLessThanOrEqual(SOUL_EMOTIONS_LIMIT_MAX);
    }
  });

  it("since 透传给 store；非法 since 丢弃", async () => {
    const since = "2026-11-01T00:00:00.000Z";
    const first = makeStore();
    await call(`/v3/soul/emotions?since=${encodeURIComponent(since)}`, { store: first.store });
    expect((first.calls.list[0] as { opts: { since?: string } }).opts.since).toBe(since);

    const second = makeStore();
    await call("/v3/soul/emotions?since=not-a-date", { store: second.store });
    expect((second.calls.list[0] as { opts: { since?: string } }).opts.since).toBeUndefined();
  });

  it("store 未就绪或缺 listSoulEmotions → 503 soul_emotions_unavailable（面板降级）", async () => {
    for (const store of [null, {}, { listSoulEmotions: "nope" }]) {
      const { handled, status, payload } = await call("/v3/soul/emotions", { store });
      expect(handled).toBe(true);
      expect(status).toBe(503);
      expect(payload).toMatchObject({ code: 503, message: "soul_emotions_unavailable" });
    }
  });
});
