/**
 * F1（UR-09，2026-10-02 评审裁定）：GROW-MAINT reweight 不得触碰 attrs_json。
 *
 * 缺陷机制（评审实锚）：anchor-growth.ts:383 旧代码 person reweight 传 attrsOf(a)
 * （只含 role/aliases，丢 description）→ sqlite.ts:2399 attrs!==undefined 时全量替换
 * attrs_json → 生产 person 锚 description 被 GROW-MAINT 静默清空（GAP 复发机制；
 * 生产实锚：p-auto-0d0e1a86b3 / p-auto-016bbd5b90 两行 attrs_json 均含 description
 * 且 origin=auto / created_by=auto-growth=维护射程内）。
 * 修复语义：reweight 一律 attrs=undefined（DO UPDATE 不碰 attrs_json，node_type 不漂）。
 * 本测试用 spy store 断言 upsertValue 收到 attrs===undefined。
 */
import { describe, expect, it, vi } from "vitest";
import { runAnchorGrowth } from "../anchor-growth.js";

const TENANT = { teamId: "t-f1", userId: "u-f1", agentId: "a-f1" };

function makeStore() {
  const valueUpserts: Array<{ valueId: string; label: string; weight: number; createdBy: string; origin: unknown; nodeType: unknown; attrs: unknown }> = [];
  const personRow = {
    value_id: "p-hechen",
    label: "何晨",
    weight: 0.3,
    created_by: "auto-growth",
    valence: null,
    origin: "auto",
    pinned: 0,
    state: "active",
    node_type: "person" as const,
    attrs_json: JSON.stringify({ role: "同事", aliases: ["老何"], description: "TDB 自进化记忆系统负责人，证据裁决者" }),
  };
  const store = {
    queryL1Records: () => Array.from({ length: 8 }, (_, i) => ({ record_id: `r${i}`, content: `何晨 要求第 ${i} 批修复附证据`, significance: 0.9, updated_time: "2026-10-02T09:00:00Z" })),
    countL1: () => 8,
    readCore: () => [{ slot: "self_identity", content: "- 何晨 要求证据裁决" }],
    upsertCore: () => true,
    listValuesAnyState: () => [personRow],
    listValues: () => [personRow],
    upsertValue: (valueId: string, label: string, weight: number, createdBy: string, _t: unknown, _v: unknown, origin: unknown, nodeType: unknown, attrs: unknown) => {
      valueUpserts.push({ valueId, label, weight, createdBy, origin, nodeType, attrs });
      return true;
    },
    retireValue: () => true,
    getAnchorGrowthState: () => ({ lastDiscoveryAt: null, lastCorpusCount: null }),
    setAnchorGrowthState: () => {},
    listL1TenantTriplets: () => [TENANT],
  } as never;
  return { store, valueUpserts };
}

describe("F1：GROW-MAINT reweight 不触碰 attrs_json（description 保留）", () => {
  it("person 锚 reweight → upsertValue 收到 attrs=undefined（原 attrs_json 含 description 原样保留）", async () => {
    const { store, valueUpserts } = makeStore();
    const res = await runAnchorGrowth({
      store,
      llmRunner: { run: vi.fn().mockResolvedValue("not-json") },
      config: { enabled: true, maintainIntervalHours: 0, person: { enabled: true, minEvidence: 5 } },
      now: () => new Date("2026-10-02T10:00:00Z"),
    } as never);
    expect(res.ran).toBe(true);
    // 证据=8（label 命中 8 行）→ suggestAnchorWeight(8)=0.38，|0.38-0.30|=0.08≥0.05 → reweight 触发
    expect(res.reweighted).toBe(1);
    expect(valueUpserts).toHaveLength(1);
    const call = valueUpserts.find((c) => c.valueId === "p-hechen" && c.nodeType === "person");
    expect(call).toBeDefined();
    expect(call!.weight).toBeCloseTo(0.38, 5);
    // 修复断言：attrs 必须 undefined（sqlite DO UPDATE 不碰 attrs_json → description 存活）
    expect(call!.attrs).toBeUndefined();
  });
});
