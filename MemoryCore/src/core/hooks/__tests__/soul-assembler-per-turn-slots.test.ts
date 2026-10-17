/**
 * #52 D3（双通道 slots 去重）：per-turn 省略身份两行——soul-assembler 渲染门测试。
 * 合同：SoulRenderOptions.perTurnSlots 缺省（undefined/true）=渲染逐位现状；显式 false=
 * dual（selfIdentityEnabled=true）路径跳过（我是谁）[self_identity] 与（我心中的他）[identity]
 * 两行 slots 行；红线段（strict_rule 走红线段）、价值锚行、重要的人、品格行、感受段
 * （含当下状态/近期基调）、capabilities 段照常渲染。legacy（dual=false）不适用。
 * 布局级渲染门：进 prefix cacheKey（false 才进键段，缺省键位逐位现状）；不进 soulVersion
 *（ADR0003 批次纪律：布局变更不翻 sv，soulVer 只由数据驱动）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "tsh", userId: "u1", agentId: "a1" };

function makeStore(slots: Array<Record<string, string>>, rows: Array<Record<string, unknown>>) {
  return {
    readCore: async () => slots,
    listValues: async () => rows,
  } as never;
}

const slots = [
  { slot: "self_identity", content: "我是测试者。" },
  { slot: "identity", content: "用户是系统维护者。" },
  { slot: "strict_rule", content: "绝不可删除记忆。" },
];

const rows = [
  {
    value_id: "v01",
    label: "根因",
    weight: 0.9,
    valence: 1,
    state: "active",
    node_type: "theme",
    attrs_json: '{"description":"先找根因再动手。"}',
  },
  {
    value_id: "v02",
    label: "小明",
    weight: 0.8,
    valence: 1,
    state: "active",
    node_type: "person",
    attrs_json: '{"role":"同事","description":"可靠的合作者。"}',
  },
  {
    value_id: "v03",
    label: "严谨",
    weight: 0.7,
    valence: 1,
    state: "active",
    node_type: "character",
    attrs_json: '{"description":"先验证再下结论。"}',
  },
];

const baseOpts = {
  selfIdentityEnabled: true,
  moodTier: { tier: "positive", sampleCount: 5 } as const,
  characterTensionEnabled: true,
  capabilities: ["可以检索记忆"],
};

describe("#52 D3 perTurnSlots=false：双通道身份两行省略", () => {
  it("① perTurnSlots=false：跳过（我是谁）/（我心中的他）行，红线段/价值锚行/重要的人/品格行/感受段/capabilities 全在", async () => {
    const out = await buildSoulPrefix(
      makeStore(slots, rows),
      TENANT,
      undefined,
      { ...baseOpts, perTurnSlots: false },
    );
    // 身份两行被省略（dual 路径标签+slot 标记均不出现）
    expect(out).not.toContain("（我是谁）");
    expect(out).not.toContain("（我心中的他）");
    expect(out).not.toContain("[self_identity]");
    expect(out).not.toContain("[identity]");
    expect(out).not.toContain("我是测试者。");
    expect(out).not.toContain("用户是系统维护者。");
    // strict_rule 不在身份 slots 位置——仍走红线段（红线行保留 [strict_rule] 标记）
    expect(out).toContain("## 不可逾越（红线）");
    expect(out).toContain("- [strict_rule] 绝不可删除记忆。");
    // 其余段照常
    expect(out).toContain("## 此刻的你");
    expect(out).toContain("绝不可删除记忆。");
    expect(out).toContain("价值锚：");
    expect(out).toContain("根因");
    expect(out).toContain("重要的人：");
    expect(out).toContain("小明");
    expect(out).toContain("我的品格：");
    expect(out).toContain("严谨");
    expect(out).toContain("<soul-feeling>");
    expect(out).toContain("## 当下的状态");
    expect(out).toContain("驱动我行动的价值：");
    expect(out).toContain("近期基调：偏积极（近 5 条经历的情感聚合）");
    expect(out).toContain("## 我能做什么");
    expect(out).toContain("可以检索记忆");
  });

  it("② 缺省（undefined）与 perTurnSlots=true 渲染逐位一致（现状字节不变），身份两行在", async () => {
    const legacy = await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-def" }, undefined, baseOpts);
    const explicit = await buildSoulPrefix(
      makeStore(slots, rows),
      { ...TENANT, userId: "u-true" },
      undefined,
      { ...baseOpts, perTurnSlots: true },
    );
    expect(legacy).toBe(explicit); // 缺省=现状字节逐位不变
    expect(legacy).toContain("（我是谁）");
    expect(legacy).toContain("（我心中的他）");
    expect(legacy).toContain("[self_identity]");
    expect(legacy).toContain("[identity]");
  });

  it("cacheKey 隔离：perTurnSlots=false 与缺省渲染同租户互不串缓存（布局门进键）", async () => {
    // 先缺省（缓存填充），再 false——若 false 不进键则拿到缺省缓存文本（含（我是谁））→ 抓获
    const def1 = await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-ck" }, undefined, baseOpts);
    const off1 = await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-ck" }, undefined, { ...baseOpts, perTurnSlots: false });
    // 反向：再渲染缺省——若串键则拿到 off 文本（缺（我是谁））→ 抓获
    const def2 = await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-ck" }, undefined, baseOpts);
    const off2 = await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-ck" }, undefined, { ...baseOpts, perTurnSlots: false });
    expect(def1).toBe(def2);
    expect(off1).toBe(off2);
    expect(def1).toContain("（我是谁）");
    expect(off1).not.toContain("（我是谁）");
  });

  it("soulVersion 不变：perTurnSlots=false 与缺省渲染同数据同 sv（布局变更不翻 sv 批次纪律）", async () => {
    const meta1: { soulVersion?: string } = {};
    await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-sv" }, undefined, baseOpts, meta1);
    const meta2: { soulVersion?: string } = {};
    await buildSoulPrefix(makeStore(slots, rows), { ...TENANT, userId: "u-sv" }, undefined, { ...baseOpts, perTurnSlots: false }, meta2);
    expect(meta1.soulVersion).toBeTruthy();
    expect(meta2.soulVersion).toBe(meta1.soulVersion);
  });

  it("legacy（dual=false）不受 perTurnSlots 影响：身份行原样保留（唯一身份载体不静默丢失）", async () => {
    const legacyOpts = { moodTier: { tier: "positive" as const, sampleCount: 5 } };
    const out = await buildSoulPrefix(
      makeStore(slots, rows),
      { ...TENANT, userId: "u-lg" },
      undefined,
      { ...legacyOpts, perTurnSlots: false },
    );
    // legacy 路径：身份行无（label）前缀，content 原样在位
    expect(out).toContain("我是测试者。");
    expect(out).toContain("用户是系统维护者。");
  });
});
