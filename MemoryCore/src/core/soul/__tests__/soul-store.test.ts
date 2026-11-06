/**
 * 自维护人格层（m00527）单测 B：真实 SqliteMemoryStore 往返。
 *
 * 只碰临时目录里的临时 SQLite（禁用生产库）：验证
 *  1) soul_persona 幂等 upsert（同 itemId 不产生第二行，状态/权重/别名字段整体覆盖）；
 *  2) soul_ledger 追加与 entryId 幂等（INSERT OR IGNORE，不覆盖历史）；
 *  3) 三元组隔离（他租户读不到）；
 *  4) JSON 字段（aliases/meta/driftHistory/evidence）往返不丢型。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../config.js";
import { createStoreBundle } from "../../store/factory.js";
import type { L0Record } from "../../store/types.js";
import type { PersonaItem, SoulEpisode, SoulLedgerEntry } from "../types.js";

let dataDir: string;
let bundle: Awaited<ReturnType<typeof createStoreBundle>>;

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const OTHER = { teamId: "t1", userId: "u1", agentId: "a2" };

function item(over: Partial<PersonaItem> = {}): PersonaItem {
  return {
    itemId: "values:abc123",
    layer: "values",
    text: "宁可慢交付，也不交付没验证过的结论",
    state: "active",
    weight: 0.6,
    evidenceIds: ["r1", "r2"],
    evidenceDays: ["2026-11-01", "2026-11-02"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    lastEvidenceAt: "2026-11-02T00:00:00.000Z",
    aliases: ["宁可慢一点"],
    driftHistory: [0.71, 0.66],
    contradictions: 1,
    meta: { scope: "universal", triggerExample: "评审被打回时" },
    ...over,
  };
}

function ledger(id: string, over: Partial<SoulLedgerEntry> = {}): SoulLedgerEntry {
  return {
    entryId: id,
    at: "2026-11-05T00:00:00.000Z",
    trigger: "lifecycle",
    layer: "values",
    itemId: "values:abc123",
    action: "admit",
    afterHash: "h1",
    gates: ["ok"],
    reason: "准入",
    evidenceIds: ["r1"],
    ...over,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tdai-soul-store-"));
  bundle = createStoreBundle(parseConfig({}), { dataDir });
  // 工厂只构造不建表（宿主启动时调 init）：测试必须显式 init，否则表不存在。
  (bundle.store as unknown as { init?: () => unknown }).init?.();
});

afterEach(async () => {
  await bundle.store.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

describe("soul_persona / soul_ledger 存储往返", () => {
  it("upsert 幂等：同 itemId 只留一行，字段整体覆盖（含 JSON 列）", async () => {
    const store = bundle.store;
    const a = item();
    const r1 = await store.commitSoulPersona!(TENANT, { upsert: [a], ledger: [] });
    expect(r1.upserted).toBe(1);

    const b = item({ state: "degraded", weight: 0.42, aliases: ["宁可慢一点", "宁可慢些"], meta: { scope: "project" } });
    const r2 = await store.commitSoulPersona!(TENANT, { upsert: [b], ledger: [] });
    expect(r2.upserted).toBe(1);

    const rows = await store.listSoulPersona!(TENANT);
    expect(rows).toHaveLength(1);
    const got = rows[0];
    expect(got.itemId).toBe("values:abc123");
    expect(got.state).toBe("degraded");
    expect(got.weight).toBeCloseTo(0.42, 3);
    // JSON 列往返不丢型
    expect(got.aliases).toEqual(["宁可慢一点", "宁可慢些"]);
    expect(got.driftHistory).toEqual([0.71, 0.66]);
    expect(got.evidenceIds).toEqual(["r1", "r2"]);
    expect(got.evidenceDays).toEqual(["2026-11-01", "2026-11-02"]);
    expect(got.evidenceOrigins).toEqual(["l1"]);
    expect(got.contradictions).toBe(1);
    expect(got.meta).toMatchObject({ scope: "project" });
  });

  it("账本追加 + entryId 幂等（重复 id 不覆盖历史，ledgered 只数新行）", async () => {
    const store = bundle.store;
    const first = await store.commitSoulPersona!(TENANT, { upsert: [item()], ledger: [ledger("led-1")] });
    expect(first.ledgered).toBe(1);
    const dup = await store.commitSoulPersona!(TENANT, {
      upsert: [],
      ledger: [ledger("led-1", { reason: "被覆盖？" }), ledger("led-2", { action: "update", at: "2026-11-05T01:00:00.000Z" })],
    });
    expect(dup.ledgered).toBe(1); // 只有 led-2 是新的
    const list = await store.listSoulLedger!(TENANT, 10);
    expect(list).toHaveLength(2);
    expect(list[0].entryId).toBe("led-2"); // at DESC
    expect(list.find((e) => e.entryId === "led-1")!.reason).toBe("准入"); // 历史未被覆盖
  });

  it("三元组隔离：他 agent 读不到本 agent 的人格与账本", async () => {
    const store = bundle.store;
    await store.commitSoulPersona!(TENANT, { upsert: [item()], ledger: [ledger("led-1")] });
    expect(await store.listSoulPersona!(OTHER)).toEqual([]);
    expect(await store.listSoulLedger!(OTHER, 10)).toEqual([]);
  });

  it("事务性：一条 SQL 失败时整批回滚（不留半截人格、不留半截账本）", async () => {
    const store = bundle.store;
    const good = item();
    // layer 非枚举值在表里是 TEXT，不会失败；用「同批里重复但状态非法」造失败：
    // 这里改用把 itemId 设为超长? 更稳的做法是传一个非对象 meta 触发 JSON 序列化抛错。
    const bad = item({ itemId: "values:bad", meta: { deep: 1n as unknown as number } });
    await expect(store.commitSoulPersona!(TENANT, { upsert: [good, bad], ledger: [ledger("led-x")] })).rejects.toBeTruthy();
    expect(await store.listSoulPersona!(TENANT)).toEqual([]);
    expect(await store.listSoulLedger!(TENANT, 10)).toEqual([]);
  });
});
/* —— 事件层（soul_episodes）与拒绝可观测：这三条支撑「人格有出处」+「拒绝理由可查」 —— */
function episode(over: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: "ep-a1b2c3",
    at: "2026-11-03T08:00:00.000Z",
    day: "2026-11-03",
    kind: "correction",
    title: "他把我的「已修复」打回：假绿不算修好",
    object: "假绿",
    participants: ["user", "assistant"],
    userStance: "测试没跑就说修好了？",
    agentStance: "我先跑全量再回你",
    cost: "宁可少做一点，也要一手证据",
    outcome: "全量跑完再回话",
    valence: -0.5,
    arousal: 0.6,
    intensity: 0.7,
    evidenceIds: ["r1", "r2"],
    sessionId: "s1",
    quote: { text: "你亲眼看到它绿了吗", role: "user", recordId: "r1" },
    affectSource: "lexicon",
    ...over,
  };
}

describe("soul_episodes / 拒绝统计 / L0 取证窗口", () => {
  it("episode 幂等入库：重复 episodeId 只留一行；重挖时按当前判据刷新立场与原话", async () => {
    const store = bundle.store;
    expect((await store.commitSoulEpisodes!(TENANT, [episode()])).inserted).toBe(1);
    // 早期挖掘把助手自己的话写进 user_stance 后不能永远洗不掉：同一 record 重挖即刷新。
    expect((await store.commitSoulEpisodes!(TENANT, [
      episode({
        title: "被覆盖？",
        userStance: "测试没跑就说修好了？",
        agentStance: "已按原话重跑全量",
        quote: { text: "测试没跑就说修好了？", role: "user", recordId: "r1" },
      }),
    ])).inserted).toBe(0);
    const rows = await store.listSoulEpisodes!(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("被覆盖？");
    expect(rows[0].agentStance).toBe("已按原话重跑全量");
    expect(rows[0].quote).toEqual({ text: "测试没跑就说修好了？", role: "user", recordId: "r1" });
    expect(rows[0].evidenceIds).toEqual(["r1", "r2"]);
    expect(rows[0].kind).toBe("correction");
  });

  it("四类新情绪事件读回来仍是原 kind，不会被降级成 decision", async () => {
    const store = bundle.store;
    await store.commitSoulEpisodes!(TENANT, [
      episode({ episodeId: "ep-praise", kind: "praise", object: "复用的组件" }),
      episode({ episodeId: "ep-complaint", kind: "complaint", object: "菜单和按钮" }),
      episode({ episodeId: "ep-pressure", kind: "pressure", object: "今晚要" }),
      episode({ episodeId: "ep-resign", kind: "resignation", object: "随你" }),
    ]);
    const kinds = (await store.listSoulEpisodes!(TENANT)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["complaint", "praise", "pressure", "resignation"]);
  });

  it("删除噪声事件只删点名的那几条，真实事件与他人租户不受影响", async () => {
    const store = bundle.store;
    await store.commitSoulEpisodes!(TENANT, [
      episode(),
      episode({ episodeId: "ep-noise", kind: "value_conflict", object: "先A再B", userStance: "# 云文库二期：接口补调研", quote: { text: "# 云文库二期：接口补调研", role: "user", recordId: "r9" } }),
      episode({ episodeId: "ep-other", kind: "decision", object: "拍板" }),
    ]);
    expect((await store.deleteSoulEpisodes!(TENANT, ["ep-noise"])).deleted).toBe(1);
    expect((await store.listSoulEpisodes!(TENANT)).map((e) => e.episodeId).sort()).toEqual(["ep-a1b2c3", "ep-other"]);
    expect((await store.deleteSoulEpisodes!(OTHER, ["ep-other"])).deleted).toBe(0);
  });

  it("检索：按对象/关键词/kind 都能找回「上次因为什么、对谁」，且三元组隔离", async () => {
    const store = bundle.store;
    await store.commitSoulEpisodes!(TENANT, [
      episode(),
      episode({ episodeId: "ep-d4e5f6", at: "2026-11-04T08:00:00.000Z", day: "2026-11-04", kind: "divergence", object: "取证顺序", title: "他要先看现场，我要先复现", userStance: "直接去现场", agentStance: "先复现" }),
    ]);
    expect((await store.searchSoulEpisodes!(TENANT, { object: "假绿" })).map((e) => e.episodeId)).toEqual(["ep-a1b2c3"]);
    expect((await store.searchSoulEpisodes!(TENANT, { text: "现场" })).map((e) => e.episodeId)).toEqual(["ep-d4e5f6"]);
    expect((await store.listSoulEpisodes!(TENANT, { kind: "divergence" })).map((e) => e.episodeId)).toEqual(["ep-d4e5f6"]);
    expect(await store.listSoulEpisodes!(OTHER)).toEqual([]);
    expect(await store.searchSoulEpisodes!(OTHER, { text: "现场" })).toEqual([]);
  });

  it("拒绝可观测：soulRejectionStats 聚合近 N 天 reject 账本的 gates", async () => {
    const store = bundle.store;
    const now = new Date().toISOString();
    await store.commitSoulPersona!(TENANT, {
      upsert: [],
      ledger: [
        ledger("rej-1", { action: "reject", at: now, gates: ["cost_missing", "episode_missing"] }),
        ledger("rej-2", { action: "reject", at: now, gates: ["episode_missing"] }),
        ledger("adm-1", { action: "admit", at: now, gates: ["cost_missing"] }),
      ],
    });
    const stats = await store.soulRejectionStats!(TENANT, { sinceDays: 7 });
    expect(stats[0]).toMatchObject({ code: "episode_missing", count: 2 });
    expect(stats.find((s) => s.code === "cost_missing")!.count).toBe(1);
    expect(await store.soulRejectionStats!(OTHER, { sinceDays: 7 })).toEqual([]);
  });

  it("recentL0Messages：窗口内按时间正序、只取本租户、空文本不返回", async () => {
    const store = bundle.store;
    const mk = (id: string, text: string, atMs: number, tenant = TENANT): L0Record => ({
      id,
      sessionKey: "s1",
      sessionId: "s1",
      taskId: "t",
      role: "user",
      messageText: text,
      recordedAt: new Date(atMs).toISOString(),
      timestamp: atMs,
      teamId: tenant.teamId,
      userId: tenant.userId,
      agentId: tenant.agentId,
    });
    const now = Date.now();
    await store.upsertL0(mk("l0-1", "第一条", now - 3000), undefined);
    await store.upsertL0(mk("l0-2", "第二条", now - 1000), undefined);
    await store.upsertL0(mk("l0-3", "", now - 500), undefined);
    await store.upsertL0(mk("l0-x", "他租户", now - 1000, OTHER), undefined);
    const rows = await store.recentL0Messages!(TENANT, { sinceDays: 1, maxMessages: 10 });
    expect(rows.map((r) => r.record_id)).toEqual(["l0-1", "l0-2"]);
    expect(rows[1].message_text).toBe("第二条");
  });
});
describe("情绪史 soul_emotions（2026-11-06）：按「事件 × 模板版本」留档，可回放", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    episodeId: "ep-1",
    at: "2026-11-05T10:00:00.000Z",
    object: "假绿",
    label: "愧疚",
    valence: -0.6,
    arousal: 0.5,
    dominance: 0.3,
    intensity: 0.72,
    appraisal: { goalRelevance: 0.9, agency: "self" },
    templateVersion: "et-abcdef12",
    appraisedAt: "2026-11-05T10:05:00.000Z",
    ...over,
  });

  it("写入幂等（同事件同版本只一行），换模板版本会多一行而不是覆盖旧判定", async () => {
    const store = bundle.store;
    const first = await store.commitSoulEmotions!(TENANT, [row()]);
    expect(first.inserted).toBe(1);
    const dup = await store.commitSoulEmotions!(TENANT, [row()]);
    expect(dup.inserted).toBe(0);
    const rejudged = await store.commitSoulEmotions!(TENANT, [row({ label: "委屈", templateVersion: "et-99999999" })]);
    expect(rejudged.inserted).toBe(1);
    const rows = await store.listSoulEmotions!(TENANT, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.label))).toEqual(new Set(["愧疚", "委屈"]));
  });

  it("读回来带对象/强度/支配感/评价向量，且三元组隔离", async () => {
    const store = bundle.store;
    await store.commitSoulEmotions!(TENANT, [row()]);
    const [got] = await store.listSoulEmotions!(TENANT, { object: "假绿" });
    expect(got.episodeId).toBe("ep-1");
    expect(got.intensity).toBeCloseTo(0.72, 3);
    expect(got.dominance).toBeCloseTo(0.3, 3);
    expect(got.templateVersion).toBe("et-abcdef12");
    expect(got.appraisal).toMatchObject({ agency: "self" });
    expect(await store.listSoulEmotions!(OTHER, { limit: 10 })).toHaveLength(0);
  });
});
