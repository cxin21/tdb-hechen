/**
 * P2 端到端（真实 tick 路径 + 真实临时库）：
 *   runSoulMaintenanceTick → runSoulMaintenance → person-state 写者 → soul_person_state 有行
 *   → assembleSoulCard(persons=…) 的关系段能看到结构化关系，且别人的卡看不到。
 *
 * 这是用户拍板的验收口径：只建表/只写单测不算完成，必须「同一路径跑一次 → 表有行 → 卡能看到」。
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
const HE = "p_he";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-person-state-e2e-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + initRes.reason);
  return store;
}

function seedL0(store: VectorStore, id: string, text: string): void {
  const at = "2026-10-01T00:00:00.000Z"; // 事件窗（7 天）之外：本 tick 不会把这些 L0 再挖成第二条事件
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
      recordedAt: at,
      timestamp: Date.parse(at),
    },
    undefined,
  );
  if (!ok) throw new Error("L0 写入失败：" + id);
}

function relationEpisode(id: string, l0Id: string): SoulEpisode {
  return {
    episodeId: id,
    at: "2026-11-10T02:00:00.000Z",
    day: "2026-11-10",
    kind: "work",
    title: "关系原话",
    object: "关系",
    participants: ["何晨", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0,
    intensity: 0,
    evidenceIds: [l0Id],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    persons: [HE],
  };
}

function episode(): SoulEpisode {
  return {
    episodeId: "ep-e2e-1",
    at: "2026-11-10T02:00:00.000Z",
    day: "2026-11-10",
    kind: "correction",
    title: "他把判断权交给我",
    object: "门禁",
    participants: ["何晨", "assistant"],
    userStance: "这个你自己决定",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0.2,
    arousal: 0.4,
    intensity: 0.4,
    evidenceIds: ["l0-trust"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    persons: [HE],
  };
}

describe("P2 端到端：tick 写状态、卡读结构化关系", () => {
  it("真实 tick 跑一次 → state/state_events 有行 → 卡里出现 4 类关系中的这一条；A/B 不互串", async () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    store.upsertSoulPerson(TENANT, { personKey: "p_zhou", displayName: "周衡" });
    store.upsertSoulPerson(TENANT, { personKey: "p_lin", displayName: "林夏" });
    store.upsertSoulPerson(TENANT, { personKey: "p_zhao", displayName: "赵宁" });
    store.upsertSoulPerson(TENANT, { personKey: "p_chen", displayName: "陈屿" });
    // 关系引文的 L0 原话（t2 回指的唯一依据）
    seedL0(store, "l0-trust", "这个你自己决定");
    seedL0(store, "l0-zhou", "周衡是我直属上级，我进用友就是他带的");
    seedL0(store, "l0-lin", "她刚进来那半年我给她当师父");
    seedL0(store, "l0-zhao", "赵宁跟我一个组，纯同事，不是上下级关系");
    seedL0(store, "l0-chen", "陈屿是对接的客户方负责人，不是我们公司的人，合同归他那边签");
    store.commitSoulEpisodes(TENANT, [
      episode(),
      relationEpisode("ep-e2e-zhou", "l0-zhou"),
      relationEpisode("ep-e2e-lin", "l0-lin"),
      relationEpisode("ep-e2e-zhao", "l0-zhao"),
      relationEpisode("ep-e2e-chen", "l0-chen"),
    ]);
    const base = {
      subjKey: HE,
      quote: "",
      recordId: "",
      evidence: [] as Array<{ recordId: string; at: string; quote: string }>,
      validFrom: "2026-11-01T00:00:00.000Z",
      validTo: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      direction: "out" as const,
    };
    store.commitSoulPersonRelations(TENANT, {
      insert: [
        {
          ...base,
          relId: "r-zhou",
          pred: "上级",
          objKey: "p_zhou",
          objName: null,
          inversePred: null,
          quote: "周衡是我直属上级，我进用友就是他带的",
          recordId: "m_zhou",
        },
        {
          ...base,
          relId: "r-lin",
          pred: "徒弟",
          objKey: "p_lin",
          objName: null,
          inversePred: null,
          quote: "她刚进来那半年我给她当师父",
          recordId: "m_lin",
        },
        {
          ...base,
          relId: "r-zhao",
          pred: "同事",
          objKey: "p_zhao",
          objName: null,
          inversePred: null,
          direction: "mutual",
          quote: "赵宁跟我一个组，纯同事，不是上下级关系",
          recordId: "m_zhao",
        },
        {
          ...base,
          relId: "r-chen",
          pred: "客户",
          objKey: "p_chen",
          objName: null,
          inversePred: null,
          quote: "陈屿是对接的客户方负责人，不是我们公司的人，合同归他那边签",
          recordId: "m_chen",
        },
      ],
    });

    const summary = await runSoulMaintenanceTick({
      store,
      filter: TENANT,
      config: resolveSoulConfig({}),
    });
    expect(summary.tenants).toBe(1);
    expect(summary.personState?.persons).toBe(1);
    expect(summary.personState?.updated).toBe(1);
    expect(summary.personState?.events).toBeGreaterThan(0);
    // t2：同一 tick 把 4 条关系的 event_id 唯一回指上（不猜、不回退姓名）。
    expect(summary.relationBackfill).toEqual({ scanned: 4, linked: 4, unverifiable: 0 });
    for (const relId of ["r-zhou", "r-lin", "r-zhao", "r-chen"]) {
      const rel = store.listSoulPersonRelations(TENANT, { includeClosed: true }).find((x) => x.relId === relId)!;
      expect(rel.status).toBe("active");
      expect(rel.eventId).toMatch(/^ep-e2e-/);
    }

    const states = store.listSoulPersonStates(TENANT);
    expect(states).toHaveLength(1);
    expect(states[0]!.person_key).toBe(HE);
    expect(states[0]!.trust).toBeGreaterThan(0.5);
    const events = store.listSoulPersonStateEvents(TENANT, { personKey: HE });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event_id).toBe("ep-e2e-1");

    // 卡：按人过滤后关系段来自 soul_person_relation（4 条都进来，先断言这一条）。
    const cardHe = await assembleSoulCard({ store, tenant: TENANT, persons: [HE], persist: false });
    expect(cardHe.text).toContain("你与周衡：上级");
    expect(cardHe.text).toContain("你与林夏：徒弟");
    expect(cardHe.text).toContain("你与赵宁：同事");
    expect(cardHe.text).toContain("你与陈屿：客户");
    // 0 个角色词：卡里不能出现「用户」当关系对象。
    expect(cardHe.text).not.toContain("用户");

    // B 的卡（另一个人）不能看到何晨的关系。
    const cardOther = await assembleSoulCard({ store, tenant: TENANT, persons: ["p_other"], persist: false });
    expect(cardOther.text).not.toContain("周衡");

    // 同一路径再跑一次：审计行不翻倍（tick 幂等）。
    const before = store.listSoulPersonStateEvents(TENANT, { personKey: HE }).length;
    const again = await runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
    expect(store.listSoulPersonStateEvents(TENANT, { personKey: HE }).length).toBe(before);
    expect(again.relationBackfill).toEqual({ scanned: 0, linked: 0, unverifiable: 0 });
  });
});