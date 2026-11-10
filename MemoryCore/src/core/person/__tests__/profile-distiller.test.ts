/**
 * P2-H §9 测试 3/4/5/7 + A1/A5/A8 —— 人物档案提炼的落库半边。
 *
 * 全部用 mkdtemp 临时 sqlite + LLM 桩：不碰生产库、不跑真实模型。
 * 守住的四件事：
 *  1. 一次提炼写出 human 行与关系边，meta 里带得上证据原话，重复跑行数不变（A3 幂等）；
 *  2. 水位只在成功时写：模型报错 / 解析失败都不写，下一轮还会重试（A8）；
 *  3. 反向边只留一行，证据并进去（A5）；
 *  4. store 侧的两个选人查询只在租户内、按 ≥3 条筛（A1）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../../store/sqlite.js";
import { writeMemory } from "../../record/l1-writer.js";
import { resolvePerson } from "../resolve.js";
import {
  pickPersonProfileTargets,
  personProfileMaxPerTick,
  runPersonProfileDistill,
  type PersonProfileReport,
} from "../profile-distiller.js";
import type { PersonaItem } from "../../soul/types.js";
import type { LLMRunner } from "../../types.js";

const TENANT = { teamId: "team-pp", userId: "usr-pp", agentId: "agt-pp" };
/** 固定「未来」时间：L1 的 created_time 是真实时钟，now 必须排在它之后才能验证防抖。 */
const NOW = "2027-01-01T00:00:00.000Z";
/** 比所有 L1 都早的水位：用来制造「有新记忆且已过 6h」。 */
const OLD_WATERMARK = "2026-01-01T00:00:00.000Z";

const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): { store: VectorStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "person-profile-"));
  dirs.push(dir);
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  stores.push(store);
  store.init();
  return { store, dir };
}

const ME_HINT = { platform: "cli", platformId: TENANT.userId, displayName: "何晨" };
const BOSS_HINT = { platform: "cli", platformId: "u-boss", displayName: "老板" };

async function seed(
  store: VectorStore,
  dir: string,
  rows: Array<{ id: string; content: string; participants?: unknown[]; mentioned?: unknown[]; userId: string }>,
): Promise<void> {
  for (const row of rows) {
    await writeMemory({
      memory: {
        content: row.content,
        type: "episodic",
        priority: 3,
        source_message_ids: [`msg-${row.id}`],
        // MemoryRecord["metadata"] 是 EpisodicMetadata | Record<string, never>：
        // 带人线索的对象字面量过不了它的索引签名，测试里显式收窄。
        metadata: {
          participants: row.participants ?? [ME_HINT],
          ...(row.mentioned ? { mentioned: row.mentioned } : {}),
        } as never,
        scene_name: "unit",
      },
      decision: { record_id: row.id, action: "store", target_ids: [] },
      baseDir: dir,
      sessionKey: "sess-pp",
      sessionId: "sess-pp",
      teamId: TENANT.teamId,
      userId: row.userId,
      agentId: TENANT.agentId,
      vectorStore: store,
    });
  }
}

function stubRunner(payload: unknown): LLMRunner & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const runner = {
    calls,
    run: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      if (payload instanceof Error) throw payload;
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    }),
  } as unknown as LLMRunner & { calls: Array<Record<string, unknown>> };
  return runner;
}

function profileRows(store: VectorStore, personKey: string): PersonaItem[] {
  const items = (store.listSoulPersona!(TENANT) as PersonaItem[]) ?? [];
  return items.filter((it) => {
    const meta = it.meta as { source?: string; person?: { key?: string } } | undefined;
    return it.layer === "human" && meta?.source === "person-profile" && meta.person?.key === personKey;
  });
}

async function setupPair(): Promise<{ store: VectorStore; dir: string; meKey: string; bossKey: string }> {
  const { store, dir } = makeStore();
  const me = await resolvePerson(store, TENANT, ME_HINT);
  const boss = await resolvePerson(store, TENANT, BOSS_HINT);
  await seed(store, dir, [
    { id: "m1", content: "我负责发布流程，主要盯灰度和全量两段", userId: TENANT.userId },
    { id: "m2", content: "我习惯先灰度再全量，别跳过", userId: TENANT.userId },
    {
      id: "m3",
      content: "老板是我的上级，我向他汇报发布进度",
      mentioned: [BOSS_HINT],
      userId: TENANT.userId,
    },
  ]);
  return { store, dir, meKey: me.personKey, bossKey: boss.personKey };
}

function goodOutput(bossKey: string): unknown {
  return {
    fields: [
      { field: "role", text: "负责发布流程", recordId: "m1", quote: "我负责发布流程", op: "add" },
      { field: "style", text: "先灰度再全量", recordId: "m2", quote: "先灰度再全量", op: "add" },
    ],
    relations: [{ pred: "上级", obj: { key: bossKey }, recordId: "m3", quote: "老板是我的上级", op: "add" }],
  };
}

describe("§9-3 一次提炼：写 human 行 + 关系边，证据原话留在 meta 里", () => {
  it("两条字段落成两条 human 行，itemId 稳定前缀，meta.person.key 正确", async () => {
    const { store, meKey, bossKey } = await setupPair();
    const report = await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });

    expect(report.attempted).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.fields).toBe(2);
    expect(report.relations).toBe(1);

    const rows = profileRows(store, meKey);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.itemId.startsWith("human:pp-")).toBe(true);

    const role = rows.find((r) => (r.meta as { profileField?: string }).profileField === "role")!;
    expect(role.text).toBe("身份：负责发布流程");
    expect(role.weight).toBe(0.8);
    expect(role.evidenceIds).toEqual(["m1"]);
    const meta = role.meta as {
      source: string;
      person: { key: string; displayName: string };
      profileVersion: string;
      evidence: Array<{ recordId: string; quote: string }>;
    };
    expect(meta.source).toBe("person-profile");
    expect(meta.person.key).toBe(meKey);
    expect(meta.person.displayName).toBe("何晨");
    expect(meta.profileVersion).toBe("pp-v1");
    expect(meta.evidence[0]).toMatchObject({ recordId: "m1", quote: "我负责发布流程" });

    const edges = store.listSoulPersonRelations!(TENANT, { subjKey: meKey });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ pred: "上级", objKey: bossKey, direction: "out", quote: "老板是我的上级" });
    expect(edges[0]!.evidence).toHaveLength(1);
  });

  it("§9-4 outdated：旧行写 validTo 但行还在，新行另建（不删旧行）", async () => {
    const { store, meKey, bossKey } = await setupPair();
    await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });

    const oldRole = profileRows(store, meKey).find(
      (r) => (r.meta as { profileField?: string }).profileField === "role",
    )!;
    // 造出「有新记忆且已过 6h」，否则水位会挡掉这一轮。
    store.markSoulPersonProfileAt!(TENANT, meKey, OLD_WATERMARK);

    const second = await runPersonProfileDistill(
      stubRunner({
        fields: [
          {
            field: "role",
            text: "负责发布流程",
            recordId: "m1",
            quote: "我负责发布流程",
            op: "outdated",
            targetRowId: oldRole.itemId,
          },
          { field: "role", text: "负责发布与回归", recordId: "m2", quote: "先灰度再全量", op: "add" },
        ],
        relations: [],
      }),
      { store, tenant: TENANT, now: NOW, maxPersons: 6, trigger: "test" },
    );
    expect(second.attempted).toBe(1);
    expect(second.outdated).toBe(1);

    const all = store.listSoulPersona!(TENANT, { includeSuperseded: true }) as PersonaItem[];
    const roles = all.filter(
      (it) => (it.meta as { profileField?: string } | undefined)?.profileField === "role" && it.layer === "human",
    );
    expect(roles.length).toBe(2);
    const closed = roles.find((r) => r.itemId === oldRole.itemId)!;
    expect(closed.validTo).toBeTruthy();
    const fresh = roles.find((r) => r.itemId !== oldRole.itemId)!;
    expect(fresh.itemId.startsWith(`${oldRole.itemId}-`)).toBe(true);
    expect(fresh.validTo).toBeUndefined();
    expect(fresh.text).toBe("身份：负责发布与回归");
  });
});

describe("§9-3 幂等：同一批内容再跑一次，human 行数不增", () => {
  it("有新记忆且过 6h → 会重跑，但 add 落到既有 itemId，行数仍是 2", async () => {
    const { store, meKey, bossKey } = await setupPair();
    await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(profileRows(store, meKey)).toHaveLength(2);

    store.markSoulPersonProfileAt!(TENANT, meKey, OLD_WATERMARK);
    const again = await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(again.attempted).toBe(1);
    expect(profileRows(store, meKey)).toHaveLength(2);
  });

  it("没新记忆时不重跑（水位挡掉，attempted=0）", async () => {
    const { store, bossKey } = await setupPair();
    await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    const again = await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: "2027-01-02T00:00:00.000Z",
      maxPersons: 6,
      trigger: "test",
    });
    expect(again.attempted).toBe(0);
    expect(again.deferred).toBe(0);
  });
});

describe("§9-7 水位只在成功时写", () => {
  it("模型报错 → failed=1、profile_at 仍为空、下一轮还会重试", async () => {
    const { store, meKey, bossKey } = await setupPair();
    const failedReport = await runPersonProfileDistill(stubRunner(new Error("boom")), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(failedReport.failed).toBe(1);
    expect(failedReport.completed).toBe(0);
    expect(failedReport.persons[0]!.error).toContain("boom");
    const marks = store.listSoulPersonProfileWatermarks!(TENANT);
    expect(marks.find((m) => m.personKey === meKey)?.profileAt ?? null).toBeNull();
    expect(profileRows(store, meKey)).toHaveLength(0);

    const retry = await runPersonProfileDistill(stubRunner(goodOutput(bossKey)), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(retry.completed).toBe(1);
    expect(store.listSoulPersonProfileWatermarks!(TENANT).find((m) => m.personKey === meKey)?.profileAt).toBe(NOW);
  });

  it("解析失败（不是 JSON）也只记失败，不写水位", async () => {
    const { store, meKey } = await setupPair();
    const report = await runPersonProfileDistill(stubRunner("模型今天不想说话"), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(report.failed).toBe(1);
    expect(report.persons[0]!.error).toContain("parse");
    expect(
      store.listSoulPersonProfileWatermarks!(TENANT).find((m) => m.personKey === meKey)?.profileAt ?? null,
    ).toBeNull();
  });
});

describe("A5 反向边只留一行、证据并进去", () => {
  it("库里已有 (老板→何晨, 下属)，模型又给 (何晨→老板, 上级)：边数仍是 1，证据变 2 条", async () => {
    const { store, meKey, bossKey } = await setupPair();
    await store.commitSoulPersonRelations!(TENANT, {
      insert: [
        {
          relId: "rel-boss-me",
          subjKey: bossKey,
          pred: "下属",
          inversePred: "上级",
          objKey: meKey,
          objName: null,
          direction: "out",
          quote: "何晨是我下属",
          recordId: "m3",
          validFrom: "2026-11-01T00:00:00.000Z",
          evidence: [{ recordId: "m3", at: "2026-11-01T00:00:00.000Z", quote: "何晨是我下属" }],
          validTo: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });

    const report = await runPersonProfileDistill(
      stubRunner({
        fields: [],
        relations: [
          { pred: "上级", inverse: "下属", obj: { key: bossKey }, recordId: "m3", quote: "老板是我的上级", op: "add" },
        ],
      }),
      { store, tenant: TENANT, now: NOW, maxPersons: 6, trigger: "test" },
    );
    expect(report.relations).toBe(1);

    const mine = store.listSoulPersonRelations!(TENANT, { subjKey: meKey });
    const theirs = store.listSoulPersonRelations!(TENANT, { objKey: meKey });
    expect(mine).toHaveLength(0); // 没插新边
    expect(theirs).toHaveLength(1); // 还是老板那条
    expect(theirs[0]!.evidence.length).toBe(2);
  });

  it("同一对边插两次只留一行（rel_id 幂等，A4）", async () => {
    const { store, meKey, bossKey } = await setupPair();
    const row = {
      relId: "rel-dup",
      subjKey: meKey,
      pred: "上级" as const,
      objKey: bossKey,
      objName: null,
      direction: "out" as const,
      quote: "老板是我的上级",
      recordId: "m3",
      validFrom: "2026-11-01T00:00:00.000Z",
      evidence: [{ recordId: "m3", at: "2026-11-01T00:00:00.000Z", quote: "老板是我的上级" }],
      validTo: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    await store.commitSoulPersonRelations!(TENANT, { insert: [row] });
    await store.commitSoulPersonRelations!(TENANT, { insert: [row] });
    expect(store.listSoulPersonRelations!(TENANT, { subjKey: meKey })).toHaveLength(1);
  });
});

describe("§7 dislikes 需 ≥2 条证据才落库", () => {
  it("只给 1 条证据：不写该字段，但计入 dropped/byReason（禁止静默）", async () => {
    const { store, meKey } = await setupPair();
    const report = await runPersonProfileDistill(
      stubRunner({
        fields: [
          { field: "dislikes", text: "讨厌被叫老师", recordId: "m1", quote: "我负责发布流程", op: "add" },
        ],
        relations: [],
      }),
      { store, tenant: TENANT, now: NOW, maxPersons: 6, trigger: "test" },
    );
    const rows = await store.listSoulPersona!(TENANT);
    expect(rows.filter((it) => it.layer === "human")).toHaveLength(0);
    expect(report.dropped).toBe(1);
    expect(report.byReason.insufficient_evidence).toBe(1);
  });
});

describe("A1 store 侧两个选人查询", () => {
  it("listL1ByPerson：只回租户内提到他的记忆，限量，跨租户查不到", async () => {
    const { store, meKey } = await setupPair();
    const all = store.listL1ByPerson!(TENANT, meKey, 40);
    expect(all.map((r) => r.recordId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(all.every((r) => r.roleInRecord === "subject" || r.roleInRecord === "speaker")).toBe(true);
    expect(store.listL1ByPerson!(TENANT, meKey, 2)).toHaveLength(2);
    expect(store.listL1ByPerson!({ ...TENANT, teamId: "team-other" }, meKey, 40)).toHaveLength(0);
  });

  it("listPersonProfileStats：只回 ≥3 条的人；mentioned 不算候选", async () => {
    const { store, meKey } = await setupPair();
    const stats = store.listPersonProfileStats!(TENANT);
    expect(stats.map((s) => s.personKey)).toEqual([meKey]);
    expect(stats[0]!.memories).toBe(3);
    expect(typeof stats[0]!.lastAt).toBe("string");
    expect(stats[0]!.lastAt.length).toBeGreaterThan(10);
  });
});

describe("A12 每 tick 人数与 deferred", () => {
  it("personProfileMaxPerTick = min(8, 2*maxUpdatedPerCycle)", () => {
    expect(personProfileMaxPerTick(0)).toBe(0);
    expect(personProfileMaxPerTick(3)).toBe(6);
    expect(personProfileMaxPerTick(10)).toBe(8);
  });

  it("人多于上限时只跑前 N 个，其余记 deferred", () => {
    const persons = Array.from({ length: 5 }, (_, i) => ({
      personKey: `p_${i}`,
      teamId: "t",
      userId: "u",
      agentId: "a",
      platform: "cli",
      platformId: null,
      displayName: `人${i}`,
      aliases: [],
      mergedInto: null,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const stats = persons.map((p) => ({
      personKey: p.personKey,
      memories: 3,
      lastAt: "2026-11-07T00:00:00.000Z",
    }));
    const pick = pickPersonProfileTargets({
      persons,
      stats,
      watermarks: persons.map((p) => ({ personKey: p.personKey, profileAt: null })),
      now: NOW,
      maxPersons: 2,
    });
    expect(pick.selected).toHaveLength(2);
    expect(pick.deferred).toBe(3);
    expect(pick.candidates).toBe(5);
  });

  it("6h 防抖：距上次不足 6h 不跑；过了 6h 且新记忆更晚才跑", () => {
    const persons = [
      {
        personKey: "p_a",
        teamId: "t",
        userId: "u",
        agentId: "a",
        platform: "cli",
        platformId: null,
        displayName: "甲",
        aliases: [],
        mergedInto: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const stats = [{ personKey: "p_a", memories: 3, lastAt: "2026-11-08T05:00:00.000Z" }];
    const soon = pickPersonProfileTargets({
      persons,
      stats,
      watermarks: [{ personKey: "p_a", profileAt: "2026-11-08T04:00:00.000Z" }],
      now: NOW,
      maxPersons: 6,
    });
    // now 与 profileAt 相差远超 6h，但 lastAt 之后没有新记忆之前先测「6h 内」用闭合时间窗
    expect(soon.selected).toHaveLength(1);
    const withinGap = pickPersonProfileTargets({
      persons,
      stats: [{ personKey: "p_a", memories: 3, lastAt: "2026-11-08T05:00:00.000Z" }],
      watermarks: [{ personKey: "p_a", profileAt: "2026-11-08T04:00:00.000Z" }],
      now: "2026-11-08T08:00:00.000Z",
      maxPersons: 6,
    });
    expect(withinGap.selected).toHaveLength(0);
    const noNew = pickPersonProfileTargets({
      persons,
      stats: [{ personKey: "p_a", memories: 3, lastAt: "2026-11-08T03:00:00.000Z" }],
      watermarks: [{ personKey: "p_a", profileAt: "2026-11-08T04:00:00.000Z" }],
      now: NOW,
      maxPersons: 6,
    });
    expect(noNew.selected).toHaveLength(0);
  });
});

describe("报告形状（§6.5）", () => {
  it("没有候选时不抛、计数全 0", async () => {
    const { store } = makeStore();
    const report: PersonProfileReport = await runPersonProfileDistill(stubRunner(goodOutput("p_x")), {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 6,
      trigger: "test",
    });
    expect(report).toMatchObject({ candidates: 0, attempted: 0, deferred: 0, completed: 0, failed: 0 });
    expect(report.persons).toEqual([]);
  });
});
