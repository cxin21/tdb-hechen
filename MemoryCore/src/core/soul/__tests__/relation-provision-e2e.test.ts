/**
 * t13 / P2 §10.8 端到端（真实 tick + 真实临时库）：
 *   runSoulMaintenanceTick → worker 补事件 → 同 tick 回指 → 关系 event_id 非空
 *   → assembleSoulCard(persons=…) 关系段四行里能看到补出来的三行。
 *
 * 场景对齐生产：关系边是 distiller 早先写的（只有 quote+record_id），引文是 L0 逐字原话，
 * 但当时没建事件；其中一条引文在 L0 命中两条（多命中，必须留 unverifiable）。
 * 只建 L0 里已经存在的原话——不调模型、不生成内容。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import { assembleSoulCard } from "../card-service.js";
import { resolveSoulConfig } from "../types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const HE = "p_he";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-relation-provision-e2e-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + initRes.reason);
  return store;
}

function seedL0(store: VectorStore, id: string, text: string): void {
  const at = "2026-10-01T00:00:00.000Z"; // 事件窗之外：本 tick 不会把这些 L0 再挖成事件
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

describe("t13 端到端：tick 补事件 → 回指 → 卡上看见", () => {
  it("三条唯一命中补上事件并进卡；多命中那条保留事实、标 unverifiable、不进卡", async () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    for (const [key, name] of [
      ["p_zhou", "周衡"],
      ["p_zhao", "赵宁"],
      ["p_chen", "陈屿"],
      ["p_lin", "林夏"],
      ["p_lead", "Lead"],
    ] as const) {
      store.upsertSoulPerson(TENANT, { personKey: key, displayName: name });
    }
    seedL0(store, "l0-zhou", "周衡是我直属上级，我进用友就是他带的");
    seedL0(store, "l0-zhao", "赵宁跟我一个组，纯同事，不是上下级关系");
    seedL0(store, "l0-chen", "陈屿是对接的客户方负责人，不是我们公司的人，合同归他那边签");
    seedL0(store, "l0-lin", "她刚进来那半年我给她当师父");
    // 多命中：两条都不是精确等于 quote，子串命中 2 条 → 不唯一。
    seedL0(store, "l0-lead-a", "独立评审后由 Lead 验收。");
    seedL0(store, "l0-lead-b", "上次也是独立评审后由 Lead 验收的");

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
          relId: "r-lead",
          pred: "上级",
          objKey: "p_lead",
          objName: null,
          inversePred: null,
          quote: "独立评审后由 Lead 验收",
          recordId: "m_lead",
        },
      ],
    });

    const summary = await runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
    expect(summary.tenants).toBe(1);
    expect(summary.relationProvision).toEqual({ scanned: 5, created: 4, ambiguous: 1, skipped: 0 });
    expect(summary.relationBackfill).toEqual({ scanned: 5, linked: 4, unverifiable: 1 });

    const rels = store.listSoulPersonRelations(TENANT, { includeClosed: true });
    const byId = new Map(rels.map((r) => [r.relId, r]));
    for (const relId of ["r-zhou", "r-zhao", "r-chen", "r-lin"]) {
      expect(byId.get(relId)!.eventId).toBe("ev-rel-" + relId);
      expect(byId.get(relId)!.status).toBe("active");
    }
    expect(byId.get("r-lead")!.eventId).toBeNull();
    expect(byId.get("r-lead")!.status).toBe("unverifiable");

    // 三行关系都进卡；多命中那条不进卡；0 个角色词。
    const cardHe = await assembleSoulCard({ store, tenant: TENANT, persons: [HE], persist: false });
    expect(cardHe.text).toContain("你与周衡：上级");
    expect(cardHe.text).toContain("你与赵宁：同事");
    expect(cardHe.text).toContain("你与陈屿：客户");
    expect(cardHe.text).toContain("你与林夏：徒弟");
    expect(cardHe.text).not.toContain("你与Lead");
    expect(cardHe.text).not.toContain("用户");
    // 别人的卡不出现何晨的关系。
    const cardOther = await assembleSoulCard({ store, tenant: TENANT, persons: ["p_other"], persist: false });
    expect(cardOther.text).not.toContain("周衡");

    // 同一路径再跑一次：不补不链（幂等）。
    const again = await runSoulMaintenanceTick({ store, filter: TENANT, config: resolveSoulConfig({}) });
    expect(again.relationProvision).toEqual({ scanned: 0, created: 0, ambiguous: 0, skipped: 0 });
    expect(again.relationBackfill).toEqual({ scanned: 0, linked: 0, unverifiable: 0 });
  });
});
