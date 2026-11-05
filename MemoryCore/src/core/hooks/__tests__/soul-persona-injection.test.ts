/**
 * 自维护人格层（m00527）单测 C：注入面接线（buildSoulPrefix）。
 *
 * 验收：
 *  1) soulPersonaEnabled=false（缺省）→ 不查 soul_persona，渲染字节与现状一致（零查询零回归）；
 *  2) 开启 → 输出 <soul-persona> 段，含分层小标题与条目原文；
 *  3) 预算超限 → 省略逐条进 metaOut 报告（可审计，不静默砍）；
 *  4) soulMood 在场 → 用「心境+基线偏移」行取代三档「近期基调」，不出现两套矛盾描述。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";
import { emptyMood, integrateMood } from "../../soul/emotion.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG, resolveSoulConfig, type PersonaItem } from "../../soul/types.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";

const LOG = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as unknown as Logger;
const CT = { teamId: "t1", userId: "u1", agentId: "a1" };

function item(over: Partial<PersonaItem>): PersonaItem {
  const base: PersonaItem = {
    itemId: "values:a",
    layer: "values",
    text: "宁可慢交付，也不交付没验证过的结论",
    state: "active",
    weight: 0.7,
    evidenceIds: ["r1"],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastEvidenceAt: "2026-11-01T00:00:00.000Z",
  };
  return { ...base, ...over };
}

function makeStore(items: PersonaItem[]) {
  return {
    readCore: vi.fn(async () => []),
    listValues: vi.fn(async () => []),
    listSoulPersona: vi.fn(async () => items),
  } as unknown as IMemoryStore;
}

describe("buildSoulPrefix：人格段与心境行接线", () => {
  it("缺省关闭：不查 soul_persona，无人格段（零查询）", async () => {
    const store = makeStore([item({})]);
    const out = await buildSoulPrefix(store, CT, LOG, {});
    expect(vi.mocked(store.listSoulPersona!).mock.calls).toHaveLength(0);
    expect(out).not.toContain("soul-persona");
  });

  it("开启：输出分层人格段（活跃条目前缀 - ）", async () => {
    const store = makeStore([
      item({ itemId: "values:a", layer: "values", text: "宁可慢交付，也不交付没验证过的结论" }),
      item({ itemId: "boundary:b", layer: "boundary", text: "绝不把测试数据写进生产库", weight: 0.9 }),
      item({ itemId: "identity:c", layer: "identity", text: "我是个先取证再下结论的人" }),
    ]);
    const meta: { soulPersonaBudgets?: unknown[] } = {};
    const out = await buildSoulPrefix(
      store,
      CT,
      LOG,
      { soulPersonaEnabled: true, soulMaintenance: resolveSoulConfig({ enabled: true }) },
      meta as never,
    );
    expect(out).toContain("soul-persona");
    expect(out).toContain("我在冲突里站哪边");
    expect(out).toContain("- 宁可慢交付，也不交付没验证过的结论");
    expect(out).toContain("- 绝不把测试数据写进生产库");
    expect(out).toContain("- 我是个先取证再下结论的人");
    expect((meta.soulPersonaBudgets ?? []).length).toBeGreaterThan(0);
  });

  it("预算超限：省略逐条进报告（带 reason），不静默砍", async () => {
    const longText = "这是一条用于测试预算截断的长条目".repeat(8);
    const store = makeStore([
      item({ itemId: "values:a", text: longText, weight: 0.9 }),
      item({ itemId: "values:b", text: "宁可少做，也不做假", weight: 0.8 }),
    ]);
    const meta: { soulPersonaBudgets?: Array<{ omitted: Array<{ reason: string }> }> } = {};
    const out = await buildSoulPrefix(
      store,
      CT,
      LOG,
      {
        soulPersonaEnabled: true,
        soulMaintenance: resolveSoulConfig({
          enabled: true,
          budget: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.budget, values: 40 },
        }),
      },
      meta as never,
    );
    const omitted = (meta.soulPersonaBudgets ?? []).flatMap((r) => r.omitted);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((o) => typeof o.reason === "string")).toBe(true);
    expect(out).toContain("宁可少做");
  });

  it("接管门：人格层有 identity 时旧身份两槽让位，但 strict_rule 仍在红线操作段渲染", async () => {
    const store = {
      readCore: vi.fn(async () => [
        { slot: "self_identity", content: "旧身份行：我是谁的内容不应重复" },
        { slot: "identity", content: "旧画像行：我心中的他不应重复" },
        { slot: "strict_rule", content: "旧红线行：绝不做甲事\n旧红线行：绝不做乙事" },
      ]),
      listValues: vi.fn(async () => []),
      listSoulPersona: vi.fn(async () => [
        item({ itemId: "identity:c", layer: "identity", text: "我是个先取证再下结论的人" }),
        item({ itemId: "boundary:b", layer: "boundary", text: "绝不把测试数据写进生产库", weight: 0.9 }),
      ]),
    } as unknown as IMemoryStore;
    const out = await buildSoulPrefix(
      store,
      CT,
      LOG,
      {
        soulPersonaEnabled: true,
        soulMaintenance: resolveSoulConfig({ enabled: true }),
        selfIdentityEnabled: true,
        perTurnSlots: true,
        // 旧槽叙事段（"我是谁"整块）也必须让位，否则身份出现两遍。
        identityNarrative: true,
      },
      {} as never,
    );
    expect(out).toContain("- 我是个先取证再下结论的人");
    // 人格段自己的标题就是「## 我是谁」，所以这里判叙事段的「我是谁：」前缀。
    expect(out).not.toContain("我是谁：");
    expect(out).not.toContain("旧身份行");
    expect(out).not.toContain("旧画像行");
    // 红线段 = 操作约束，不归人格注入层接管：即使 boundary 已有人格条目也照常渲染。
    expect(out).toContain("- [strict_rule] 旧红线行：绝不做甲事");
    expect(out).toContain("- [strict_rule] 旧红线行：绝不做乙事");
    expect(out).toContain("不可逾越（红线）");
  });

  it("接管门不误伤：人格层为空时旧身份/红线照旧渲染（worker 未跑过不清空身份）", async () => {
    const store = {
      readCore: vi.fn(async () => [
        { slot: "self_identity", content: "旧身份行仍在" },
        { slot: "strict_rule", content: "旧红线行仍在" },
      ]),
      listValues: vi.fn(async () => []),
      listSoulPersona: vi.fn(async () => []),
    } as unknown as IMemoryStore;
    const out = await buildSoulPrefix(
      store,
      CT,
      LOG,
      {
        soulPersonaEnabled: true,
        soulMaintenance: resolveSoulConfig({ enabled: true }),
        selfIdentityEnabled: true,
        identityNarrative: true,
      },
      {} as never,
    );
    expect(out).toContain("旧身份行仍在");
    expect(out).toContain("旧红线行仍在");
    // 无人格层时叙事段照旧（接管门只在人格层有内容时生效，绝不清空身份）。
    expect(out).toContain("我是谁：");
  });

  it("soulMood 在场：用带基线偏移的心境行取代三档「近期基调」", async () => {
    const store = makeStore([]);
    const mood = integrateMood(
      emptyMood("2026-11-05T00:00:00.000Z", { valence: 0, arousal: 0.3 }),
      [
        {
          id: "e1",
          at: "2026-11-05T00:00:00.000Z",
          object: "召回质量",
          label: "悬着",
          valence: -0.6,
          arousal: 0.7,
          intensity: 0.8,
          halfLifeHours: 3,
          appraisal: { goalRelevance: 0.8, expectationViolation: 0.7, control: 0.2, normCompatibility: 0.8, agency: "environment" },
        },
      ],
      "2026-11-05T00:00:00.000Z",
      resolveSoulConfig({ enabled: true }),
    );
    const out = await buildSoulPrefix(store, CT, LOG, {
      soulPersonaEnabled: true,
      soulMaintenance: resolveSoulConfig({ enabled: true }),
      soulMood: mood,
    });
    expect(out).toContain("心境");
    expect(out).not.toContain("近期基调");
  });
});
