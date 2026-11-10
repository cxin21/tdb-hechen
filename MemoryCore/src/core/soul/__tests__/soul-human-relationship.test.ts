/**
 * S7 验收：human 层「关于你」从对话原文长出（允许项目名，禁止推测），
 * 关系层按人 ≤3 行，正向来源记 trust 事实。
 */
import { describe, expect, it, vi } from "vitest";

import { runSoulMaintenance, trustMetaFromEpisodes } from "../worker.js";
import { resolveSoulConfig, type PersonaItem, type SoulEpisode } from "../types.js";
import { renderPersonaCard } from "../card.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function rel(text: string, i: number): PersonaItem {
  return {
    itemId: `rel-${i}`,
    layer: "relationship",
    text,
    state: "active",
    weight: 0.7,
    evidenceIds: [`r${i}`],
    evidenceDays: ["2026-11-07"],
    evidenceOrigins: ["episode"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastEvidenceAt: "2026-11-06T00:00:00.000Z",
  };
}

function makeStore(existing: PersonaItem[] = []) {
  const commits: Array<{ plan: { upsert: PersonaItem[]; ledger: unknown[] } }> = [];
  const store = {
    listSoulPersona: vi.fn(async () => existing),
    commitSoulPersona: vi.fn(async (_t: unknown, plan: { upsert: PersonaItem[]; ledger: unknown[] }) => {
      commits.push({ plan });
      return { upserted: plan.upsert.length, ledgered: plan.ledger.length };
    }),
    readSoulState: vi.fn(async () => null),
    writeSoulState: vi.fn(async () => undefined),
    recentAffectSignals: vi.fn(async () => []),
    listSoulLedger: vi.fn(async () => []),
    commitSoulEpisodes: vi.fn(async () => ({ inserted: 0 })),
    listSoulEpisodes: vi.fn(async () => []),
    recentL0Messages: vi.fn(async () => []),
    readSoulTraitState: vi.fn(async () => null),
    writeSoulTraitState: vi.fn(async () => undefined),
    listSoulTraitLabels: vi.fn(async () => []),
    commitSoulTraitLabels: vi.fn(async () => ({ upserted: 0 })),
  } as unknown as IMemoryStore;
  return { store, commits };
}

const RECORDS = [
  { id: "r1", content: "我叫何晨，负责 TDB 记忆系统的版本发布与回归验证", at: "2026-11-07T00:00:00.000Z" },
  { id: "r2", content: "发版前必须先跑全量回归，别再漏了", at: "2026-11-07T00:01:00.000Z" },
  { id: "r3", content: "记住我不喜欢别人替我改配置", at: "2026-11-07T00:02:00.000Z" },
];

describe("S7 human 层与关系对象化", () => {
  it("human 层不再由改写产线写：同样输入产 0 行，且每条都记下 human_writer_removed", async () => {
    const { store, commits } = makeStore();
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      recentRecords: async () => RECORDS,
      rewriter: async () => [
        {
          layer: "human",
          text: "他叫何晨，负责「TDB 记忆系统的版本发布与回归验证」",
          evidenceIds: ["r1", "r2", "r3"],
        },
        {
          layer: "human",
          text: "他这个人做事很靠谱",
          evidenceIds: ["r1", "r2", "r3"],
        },
      ],
    });
    // 单写者（2026-11-08）：human 只由 core/person/profile-distiller.ts 写，
    // 改写产线连「写得对不对」都不判——先在门上就拒，避免两条产线抢同一格。
    const human = commits.flatMap((c) => c.plan.upsert).filter((i) => i.layer === "human");
    expect(human).toHaveLength(0);
    const rejected = rep.rejections.filter((r) => r.layer === "human");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => r.codes.includes("human_writer_removed"))).toBe(true);
    // 卡侧不受影响：human 段由提炼器写入的行填充，这里给空数组时该段消失而不报错。
    const card = renderPersonaCard({
      profile: { name: "小纪" },
      labels: [],
      human: [],
      version: 1,
    });
    expect(card.text).not.toContain("## 关于你");
  });

  it("关系层按人 ≤3 行：已有 3 行时第 4 条被拒且写出理由", async () => {
    const existing = [rel("他会在夜里改需求", 1), rel("他信我盯着回归", 2), rel("他讨厌被催", 3)];
    const { store } = makeStore(existing);
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      trigger: "lifecycle",
      config: { ...resolveSoulConfig({}) },
      recentRecords: async () => RECORDS,
      rewriter: async () => [
        { layer: "relationship", text: "他说「发版前必须先跑全量回归」是底线", evidenceIds: ["r1", "r2", "r3"] },
      ],
    });
    const cap = rep.rejections.find((r) => r.codes.includes("relationship_person_cap"));
    expect(cap).toBeDefined();
    expect(cap?.detail).toContain("上限 3");
  });

  it("正向来源才记 trust 事实：outcome 解决/用户认可 → up；负面 → null", () => {
    const base: SoulEpisode = {
      episodeId: "ep-1",
      at: "2026-11-07T00:00:00.000Z",
      day: "2026-11-07",
      kind: "correction",
      title: "t",
      object: "回归",
      participants: ["user", "assistant"],
      userStance: "",
      agentStance: "",
      cost: "",
      outcome: "",
      valence: 0,
      arousal: 0,
      intensity: 0,
      evidenceIds: [],
      sessionId: "s",
      quote: null,
      affectSource: "none",
    };
    expect(trustMetaFromEpisodes([{ ...base, outcome: "已解决，回归通过" }], "now")).toMatchObject({
      trust: true,
      direction: "up",
      positiveSource: "user_ack_or_resolved",
    });
    expect(trustMetaFromEpisodes([{ ...base, userStance: "这次做得不错，谢谢" }], "now")).toMatchObject({ direction: "up" });
    expect(trustMetaFromEpisodes([{ ...base, outcome: "还是失败了", userStance: "不对，重来" }], "now")).toBeNull();
  });
});
