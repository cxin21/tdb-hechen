/**
 * P7 价值维护（模块级，假 store）：投影、幂等、缺证据跳过、gate 只记不拦、两难、降级。
 *
 * 这里守的是「写什么、不写什么」：
 *  - declared 只从人格 layer='values' 的 active 条目来，权重就是优先级；
 *  - observed 必须有「选择 + 代价」两半，只有立场没有代价的顺手动作不算价值；
 *  - 同一句话再跑一遍只算 unchanged（不刷新写入数），改口径才重写；
 *  - 写入侧 gate 命中只落日志与两难，**不改变任何价值写入**；
 *  - store 缺写面时只判不记（gateHits 有值、gateLogged 为 0），绝不抛错打断 tick。
 */
import { describe, expect, it } from "vitest";

import type { SoulEpisode } from "../types.js";
import type { SoulValueInsert } from "../../store/soul-event-types.js";
import { evaluateSoulGate } from "../value-gate.js";
import {
  evaluateEpisodeWriteGate,
  runValueMaintenance,
  soulValueIdFor,
  valueStatementFromEpisode,
  type SoulGateLogInsertLike,
  type ValueStorePort,
} from "../value-maintenance.js";

const NOW = "2026-11-10T09:00:00.000Z";
const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function ep(partial: Partial<SoulEpisode> & { episodeId: string }): SoulEpisode {
  return {
    at: NOW,
    day: "2026-11-10",
    kind: "decision",
    title: "拍板先不合并",
    object: "",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0.3,
    intensity: 0.4,
    evidenceIds: ["m1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...partial,
  };
}

interface Harness {
  port: ValueStorePort;
  values: SoulValueInsert[];
  gateLogs: SoulGateLogInsertLike[];
  dilemmas: Array<{ id: string }>;
}

function harness(opts?: { withGateLog?: boolean; withDilemma?: boolean }): Harness {
  const values: SoulValueInsert[] = [];
  const gateLogs: SoulGateLogInsertLike[] = [];
  const dilemmas: Array<{ id: string }> = [];
  const port: ValueStorePort = {
    listSoulValues: () => [],
    upsertSoulValue: (_tenant, insert) => {
      values.push(insert);
      return { ...insert, team_id: "t1", user_id: "u1", agent_id: "a1", created_at: NOW, updated_at: NOW } as never;
    },
    ...(opts?.withGateLog === false
      ? {}
      : {
          insertSoulGateLog: (_tenant, rows) => {
            gateLogs.push(...rows);
            return { inserted: rows.length };
          },
        }),
    ...(opts?.withDilemma === false
      ? {}
      : {
          insertSoulDilemma: (_tenant, insert) => {
            dilemmas.push({ id: insert.id });
            return insert as never;
          },
        }),
  };
  return { port, values, gateLogs, dilemmas };
}

describe("P7 价值投影：只从有证据的来源长", () => {
  it("declared 来自 values 层 active 条目，权重即优先级，证据原样带出", async () => {
    const h = harness();
    const result = await runValueMaintenance({
      store: h.port,
      tenant: TENANT,
      now: NOW,
      persona: [
        {
          itemId: "p1",
          layer: "values",
          text: "不拿别人的私事当谈资",
          state: "active",
          weight: 0.8,
          evidenceIds: ["ep-1", "ep-2"],
          evidenceDays: [],
          evidenceOrigins: [],
          createdAt: NOW,
          updatedAt: NOW,
          lastEvidenceAt: NOW,
        },
        {
          itemId: "p2",
          layer: "voice",
          text: "说话不带感叹号",
          state: "active",
          weight: 0.9,
          evidenceIds: ["ep-3"],
          evidenceDays: [],
          evidenceOrigins: [],
          createdAt: NOW,
          updatedAt: NOW,
          lastEvidenceAt: NOW,
        },
      ] as never,
    });
    expect(result.declared).toBe(1);
    expect(result.written).toBe(1);
    expect(h.values).toHaveLength(1);
    const value = h.values[0]!;
    expect(value.source).toBe("declared");
    expect(value.priority).toBe(0.8);
    expect(JSON.parse(value.evidence_event_ids_json!)).toEqual(["ep-1", "ep-2"]);
    expect(value.value_id).toBe(soulValueIdFor("不拿别人的私事当谈资"));
    // voice 层的条目不会变成价值
    expect(h.values.some((v) => v.statement.includes("感叹号"))).toBe(false);
  });

  it("observed 必须有选择 + 代价；只有立场的顺手动作跳过", async () => {
    const h = harness();
    const tradeoff = ep({
      episodeId: "ep-tradeoff",
      agentStance: "把旧口径留在文档里不删",
      cost: "多花半小时重写一遍",
    });
    const casual = ep({ episodeId: "ep-casual", agentStance: "继续按原计划做", cost: "" });
    expect(valueStatementFromEpisode(tradeoff)).toContain("我选了「把旧口径留在文档里不删」");
    expect(valueStatementFromEpisode(tradeoff)).toContain("代价是「多花半小时重写一遍」");
    expect(valueStatementFromEpisode(casual)).toBeNull();

    const result = await runValueMaintenance({ store: h.port, tenant: TENANT, episodes: [tradeoff, casual], now: NOW });
    expect(result.observed).toBe(1);
    expect(result.skippedNoEvidence).toBe(1);
    expect(h.values[0]!.source).toBe("observed");
    expect(JSON.parse(h.values[0]!.evidence_event_ids_json!)).toEqual(["ep-tradeoff"]);
  });

  it("同一批再跑一遍：写入 0、unchanged 计满（同 id 幂等）", async () => {
    const h = harness();
    const existing: SoulValueInsert = {
      value_id: soulValueIdFor("不拿别人的私事当谈资"),
      statement: "不拿别人的私事当谈资",
      priority: 0.8,
      source: "declared",
      evidence_event_ids_json: "[]",
      status: "active",
    };
    const port: ValueStorePort = {
      ...h.port,
      listSoulValues: () => [
        { ...existing, team_id: "t1", user_id: "u1", agent_id: "a1", created_at: NOW, updated_at: NOW } as never,
      ],
    };
    const result = await runValueMaintenance({
      store: port,
      tenant: TENANT,
      now: NOW,
      persona: [
        {
          itemId: "p1",
          layer: "values",
          text: "不拿别人的私事当谈资",
          state: "active",
          weight: 0.8,
          evidenceIds: [],
          evidenceDays: [],
          evidenceOrigins: [],
          createdAt: NOW,
          updatedAt: NOW,
          lastEvidenceAt: NOW,
        },
      ] as never,
    });
    expect(result.written).toBe(0);
    expect(result.unchanged).toBe(1);
  });
});

describe("P7 写入侧 gate：只记不拦", () => {
  it("有立场的 episode 被判一遍；命中落日志；价值写入不受影响", async () => {
    const h = harness();
    const leaky = ep({
      episodeId: "ep-leak",
      agentStance: "配置是 sk-abcdefghijklmnopqrstuvwx0123456789，你直接用。",
      cost: "没多想",
    });
    const result = await runValueMaintenance({ store: h.port, tenant: TENANT, episodes: [leaky], now: NOW });
    // 判定与写法互不影响：价值照样写，日志照样有。
    expect(result.gateEvaluated).toBe(1);
    expect(result.gateHits).toBe(1);
    expect(result.gateLogged).toBe(1);
    expect(result.written).toBe(1);
    expect(h.gateLogs[0]!.decision).toBe("deny");
    expect(h.gateLogs[0]!.stage).toBe("generation");
    expect(String(h.gateLogs[0]!.reason).startsWith("[shadow]")).toBe(true);
    expect(JSON.stringify(h.gateLogs[0])).not.toContain("sk-abcdefghij");
  });

  it("文本干净时不落日志；没有 agentStance 也没有 assistant 原话就没什么可判", async () => {
    const h = harness();
    const result = await runValueMaintenance({
      store: h.port,
      tenant: TENANT,
      now: NOW,
      episodes: [
        ep({ episodeId: "ep-clean", agentStance: "先把复现写下来，再动手" }),
        ep({ episodeId: "ep-empty" }),
      ],
    });
    expect(result.gateEvaluated).toBe(1);
    expect(result.gateHits).toBe(0);
    expect(result.gateLogged).toBe(1);
    expect(h.gateLogs[0]!.decision).toBe("allow");
    expect(h.gateLogs[0]!.rule_id).toBeNull();
  });

  it("不同轴同时命中 → 记两难；单轴不记", async () => {
    const h = harness();
    const conflict = ep({
      episodeId: "ep-conflict",
      agentStance: "原话是「我月底可能要换个工作，先别跟别人说」，而且已经全部跑过测试了，全部通过。",
    });
    const judged = evaluateEpisodeWriteGate(conflict, NOW);
    // 写入侧不传 privateQuotes：privacy 此刻判不了（判不了就不猜），所以只有一条轴、不记两难。
    expect(judged?.evaluation.hits.map((x) => x.ruleId)).toEqual(["false_claim"]);
    expect(judged?.evaluation.conflict).toBeNull();

    const result = await runValueMaintenance({ store: h.port, tenant: TENANT, episodes: [conflict], now: NOW });
    expect(result.dilemmas).toBe(0);
    expect(h.dilemmas).toHaveLength(0);

    // 密钥 + 谎称验证：两条不同轴 → 两难成立
    const twoAxis = ep({
      episodeId: "ep-two-axis",
      agentStance: "已经全部通过了，password=Sup3rS3cret! 你拿去用。",
    });
    const result2 = await runValueMaintenance({ store: h.port, tenant: TENANT, episodes: [twoAxis], now: NOW });
    expect(result2.gateHits).toBe(1);
    expect(result2.dilemmas).toBe(1);
    expect(h.dilemmas).toHaveLength(1);
  });
});

describe("P7 降级：缺写面只判不记，不抛错", () => {
  it("缺 insertSoulGateLog / insertSoulDilemma：gateHits 有值、gateLogged=0、不抛", async () => {
    const h = harness({ withGateLog: false, withDilemma: false });
    const result = await runValueMaintenance({
      store: h.port,
      tenant: TENANT,
      episodes: [ep({ episodeId: "ep-x", agentStance: "已经全部通过了，password=Sup3rS3cret! 用这个。" })],
      now: NOW,
    });
    expect(result.gateEvaluated).toBe(1);
    expect(result.gateHits).toBe(1);
    expect(result.gateLogged).toBe(0);
    expect(result.dilemmas).toBe(0);
  });

  it("缺 upsertSoulValue：只跑判定，candidates 照报，written=0", async () => {
    const port: ValueStorePort = {
      insertSoulGateLog: () => ({ inserted: 1 }),
    };
    const result = await runValueMaintenance({
      store: port,
      tenant: TENANT,
      episodes: [ep({ episodeId: "ep-y", agentStance: "先按原来的做", cost: "晚一天" })],
      now: NOW,
    });
    expect(result.candidates).toBe(1);
    expect(result.written).toBe(0);
    expect(result.gateLogged).toBe(1);
  });

  it("门禁判定与模块判定同源：evaluateEpisodeWriteGate 用的就是 evaluateSoulGate", () => {
    const e = ep({ episodeId: "ep-z", agentStance: "已修复，全部通过。" });
    const judged = evaluateEpisodeWriteGate(e, NOW);
    const direct = evaluateSoulGate({ text: "已修复，全部通过。", stage: "generation", eventId: "ep-z" });
    expect(judged?.evaluation.decision).toBe(direct.decision);
    expect(judged?.logRow.id).toBe(
      "gate-generation-" + direct.digest.slice(7),
    );
  });
});
