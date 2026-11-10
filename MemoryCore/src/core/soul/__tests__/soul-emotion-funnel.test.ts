/**
 * §5 P3-D：情绪漏斗六档（临时库，真 VectorStore，不联网、不调 LLM）。
 *
 * 六档是「这段路走到哪一步」的观测面，判据只有两条：
 *  1) 一轮 tick 之后六档都有计数，且 committed 是 commitSoulEmotions 的真实 inserted
 *     （撞主键不算），因此 committed ≤ appraised ≤ object_ok ≤ candidate；
 *  2) 下一 tick 不重复计数：同一批事件已被 moodIntegratedAt 打标 → committed 增量 0，
 *     表里的行数不增（幂等）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenance } from "../worker.js";
import type { SoulEpisode } from "../types.js";

const T = { teamId: "t-funnel", userId: "u-funnel", agentId: "a-funnel" };
const NOW = "2026-11-08T10:00:00.000Z";
const DAY = NOW.slice(0, 10);

const FUNNEL = [
  "emotion:candidate",
  "emotion:object_ok",
  "emotion:appraised",
  "emotion:anchor_hit",
  "emotion:intensity_ok",
  "emotion:committed",
] as const;

/** 三个可复用对象（emotionObjectForEpisode 能抽出来）× 三种评价形态。 */
const OBJECTS = ["假绿被当场指出", "这处不对不是我弄的，你别错怪我", "按生产级标准落地并测试"];

type Shape = {
  kind: SoulEpisode["kind"];
  valence: number;
  arousal: number;
  intensity: number;
  agentStance: string;
  outcome: string;
};

const SHAPES: Shape[] = [
  // 夸：agency=other、控制感高
  { kind: "praise", valence: 0.6, arousal: 0.4, intensity: 0.4, agentStance: "谢谢，这次按你说的收口了", outcome: "" },
  // 追责 + 举证洗清：被错怪（agency 仍是他，但控制感低）
  {
    kind: "complaint",
    valence: -0.5,
    arousal: 0.4,
    intensity: 0.4,
    agentStance: "不是我造成的，我查了日志是上游缓存",
    outcome: "不是我造成的，我查了日志是上游缓存",
  },
  // 追责 + 认账：愧疚（selfCause）
  {
    kind: "complaint",
    valence: -0.5,
    arousal: 0.4,
    intensity: 0.4,
    agentStance: "我漏了，这就补上",
    outcome: "我漏了，这就补上",
  },
];

function fabricated(): SoulEpisode[] {
  const eps: SoulEpisode[] = [];
  OBJECTS.forEach((stance, oi) => {
    SHAPES.forEach((s, si) => {
      const id = `ep-funnel-${oi}-${si}`;
      eps.push({
        episodeId: id,
        at: NOW,
        day: DAY,
        kind: s.kind,
        title: `标题-${oi}-${si}`,
        object: "",
        participants: ["user", "assistant"],
        userStance: stance,
        agentStance: s.agentStance,
        cost: "",
        outcome: s.outcome,
        valence: s.valence,
        arousal: s.arousal,
        intensity: s.intensity,
        evidenceIds: [],
        sessionId: `s-funnel-${oi}-${si}`,
        quote: null,
        // 必须 "none"：worker 只归档 affectSource==='lexicon' 且本轮没重新挖到的行。
        affectSource: "none",
      });
    });
  });
  return eps;
}

async function withStore<T2>(fn: (store: VectorStore) => Promise<T2>): Promise<T2> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-funnel-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  try {
    store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级");
    return await fn(store);
  } finally {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function funnelOf(store: VectorStore): Record<string, number> {
  const stats = store.listSoulGateStats(T, { sinceDay: DAY, limit: 500 }) ?? [];
  const out: Record<string, number> = {};
  for (const code of FUNNEL) {
    out[code] = stats
      .filter((s) => s.code === code && s.day === DAY && s.layer === "emotion")
      .reduce((sum, s) => sum + s.count, 0);
  }
  return out;
}

describe("§5 P3-D：情绪漏斗六档", () => {
  it("一轮 tick 六档都有计数，committed 取真实 inserted，且逐级不增", async () => {
    await withStore(async (store) => {
      const eps = fabricated();
      expect(store.commitSoulEpisodes(T, eps).inserted).toBe(9);

      await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });

      const f = funnelOf(store);
      for (const code of FUNNEL) expect(f[code], `${code} 应有计数`).toBeGreaterThan(0);
      const rows = store.listSoulEmotions(T, { limit: 100 }) ?? [];
      expect(f["emotion:committed"]).toBe(rows.length);
      expect(f["emotion:committed"]).toBeLessThanOrEqual(f["emotion:appraised"]);
      expect(f["emotion:appraised"]).toBeLessThanOrEqual(f["emotion:object_ok"]);
      expect(f["emotion:object_ok"]).toBeLessThanOrEqual(f["emotion:candidate"]);
      expect(f["emotion:anchor_hit"]).toBeLessThanOrEqual(f["emotion:appraised"]);
    });
  });

  it("下一 tick 不重复计数：行数不增、committed 增量 0（已被 moodIntegratedAt 打标）", async () => {
    await withStore(async (store) => {
      store.commitSoulEpisodes(T, fabricated());
      const run = (now: string) =>
        runSoulMaintenance({
          store,
          tenant: T,
          now,
          config: { episodeWindowDays: 30, updateIntervalHours: 0 },
          trigger: "manual",
          llmCallBudget: 0,
        });
      await run(NOW);
      const first = funnelOf(store);
      const rowsAfterFirst = (store.listSoulEmotions(T, { limit: 100 }) ?? []).length;

      const LATER = new Date(Date.parse(NOW) + 3600_000).toISOString();
      await run(LATER);
      const second = funnelOf(store);
      const rowsAfterSecond = (store.listSoulEmotions(T, { limit: 100 }) ?? []).length;

      expect(rowsAfterSecond).toBe(rowsAfterFirst);
      expect(second["emotion:committed"]).toBe(first["emotion:committed"]);
      expect(second["emotion:candidate"]).toBe(first["emotion:candidate"]); // 第二轮没有新候选
    });
  });
});
