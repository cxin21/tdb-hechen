/**
 * 灵魂注入去重轮（2026-10-18，生产实测驱动）：buildSoulPrefix 渲染门测试。
 * 合同：SoulRenderOptions.strictRuleDedup / anchorDedup 缺省（undefined/off）=渲染逐位现状；
 * 显式 enabled=true 时红线近重复行（soul-dedupe 三通道）与价值锚 label 包含对（完整句优先
 * 择优）在注入面收敛，kept 行体逐字保留（选择而非改写）；winner 原位替换不重排（value_id
 * 声明序不抖动）；去重门进 prefix cacheKey（同租户同数据不同门配置必须换缓存，旧渲染串不复活）；
 * 不进 soulVersion（ADR0003 批次纪律：布局变更不翻 sv，soulVersion 只由数据驱动）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "tdd", userId: "u1", agentId: "a1" };

function makeStore(slots: Array<Record<string, string>>, rows: Array<Record<string, unknown>>) {
  return {
    readCore: async () => slots,
    listValues: async () => rows,
  } as never;
}

const baseOpts = { selfIdentityEnabled: true };

const ruleSlot = (content: string) => ({ slot: "strict_rule", content });
const anchorRow = (valueId: string, label: string, desc: string) => ({
  value_id: valueId,
  label,
  weight: 0.9,
  valence: 1,
  state: "active",
  node_type: "theme",
  attrs_json: JSON.stringify({ description: desc }),
});

describe("去重轮 strictRuleDedup：红线近重复行收敛", () => {
  const dupSlot = ruleSlot("绝不可删除记忆。\n绝不可删除记忆。");
  it("enabled=true：归一全同行去重，kept 行体逐字保留（选择而非改写）", async () => {
    const out = await buildSoulPrefix(makeStore([dupSlot], []), TENANT, undefined, {
      ...baseOpts,
      strictRuleDedup: { enabled: true },
    });
    expect(out).toContain("## 不可逾越（红线）");
    expect(out).toContain("- [strict_rule] 绝不可删除记忆。");
    expect(out.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(1);
  });
  it("缺省 off=逐位现状：两行照旧渲染", async () => {
    const out = await buildSoulPrefix(makeStore([dupSlot], []), TENANT, undefined, { ...baseOpts });
    expect(out.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(2);
  });
  it("enabled=true：Jaccard 近重复对（标定区间内）收敛为更长行", async () => {
    const slot = ruleSlot("解决问题必须先定位根因。\n解决问题必须先定位根本原因并根治。");
    const out = await buildSoulPrefix(makeStore([slot], []), TENANT, undefined, {
      ...baseOpts,
      strictRuleDedup: { enabled: true },
    });
    expect(out).toContain("- [strict_rule] 解决问题必须先定位根本原因并根治。");
    expect(out).not.toContain("- [strict_rule] 解决问题必须先定位根因。");
  });
  it("enabled=true：语义异行不误伤（零误删）", async () => {
    const slot = ruleSlot("每日提交代码前必须运行测试。\n每周复盘一次记忆系统的召回质量。");
    const out = await buildSoulPrefix(makeStore([slot], []), TENANT, undefined, {
      ...baseOpts,
      strictRuleDedup: { enabled: true },
    });
    expect(out).toContain("- [strict_rule] 每日提交代码前必须运行测试。");
    expect(out).toContain("- [strict_rule] 每周复盘一次记忆系统的召回质量。");
  });
});

describe("去重轮 anchorDedup：价值锚 label 包含对择优", () => {
  const rows = [
    // 生产实锚镜像：根因=事故叙事（非完整句）vs 根因优先=完整原则句 → 完整句胜
    anchorRow("v01", "根因", "当时排查花了很久，把每一个怀疑点都试了一遍才定位"),
    anchorRow("v02", "根因优先", "解决问题必须从第一性原理出发，先定位根本原因并从根源根治。"),
  ];
  it("enabled=true：包含对收敛为 winner（完整句），winner 原位替换不重排", async () => {
    const out = await buildSoulPrefix(makeStore([], rows), TENANT, undefined, {
      ...baseOpts,
      anchorDedup: { enabled: true },
    });
    const anchorLines = out.split("\n").filter((l) => l.startsWith("- 根因"));
    expect(anchorLines.length).toBe(1);
    expect(anchorLines[0].startsWith("- 根因优先")).toBe(true); // winner 原位（value_id 首位）
    expect(out).toContain("解决问题必须从第一性原理出发");
    expect(out).not.toContain("把每一个怀疑点都试了一遍才定位");
  });
  it("缺省 off=逐位现状：两个锚行都在", async () => {
    const out = await buildSoulPrefix(makeStore([], rows), TENANT, undefined, { ...baseOpts });
    expect(out).toContain("把每一个怀疑点都试了一遍才定位");
    expect(out).toContain("解决问题必须从第一性原理出发");
  });
  it("enabled=true：label 无包含关系的异锚不误伤", async () => {
    const distinct = [
      anchorRow("v01", "严谨", "先验证再下结论。"),
      anchorRow("v02", "自律", "约束先于自由，规则之内行事。"),
    ];
    const out = await buildSoulPrefix(makeStore([], distinct), TENANT, undefined, {
      ...baseOpts,
      anchorDedup: { enabled: true },
    });
    expect(out).toContain("严谨");
    expect(out).toContain("自律");
  });
});

describe("去重轮 cacheKey：门配置进键段（旧渲染串不复活）", () => {
  const slots = [ruleSlot("绝不可删除记忆。\n绝不可删除记忆。")];
  const rows = [
    anchorRow("v01", "根因", "当时排查花了很久，把每一个怀疑点都试了一遍才定位"),
    anchorRow("v02", "根因优先", "解决问题必须从第一性原理出发，先定位根本原因并从根源根治。"),
  ];
  it("同租户同数据：先开门渲染（收敛）→ 再关门渲染必须回到全量（srd/ad 换键）", async () => {
    const deduped = await buildSoulPrefix(makeStore(slots, rows), TENANT, undefined, {
      ...baseOpts,
      strictRuleDedup: { enabled: true },
      anchorDedup: { enabled: true },
    });
    expect(deduped.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(1);
    expect(deduped.split("\n").filter((l) => l.startsWith("- 根因")).length).toBe(1);
    const full = await buildSoulPrefix(makeStore(slots, rows), TENANT, undefined, { ...baseOpts });
    expect(full.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(2);
    expect(full.split("\n").filter((l) => l.startsWith("- 根因")).length).toBe(2);
  });
  it("同租户同数据：先关门（全量）→ 再开门（收敛）同样成立", async () => {
    const full = await buildSoulPrefix(makeStore(slots, rows), TENANT, undefined, { ...baseOpts });
    expect(full.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(2);
    const deduped = await buildSoulPrefix(makeStore(slots, rows), TENANT, undefined, {
      ...baseOpts,
      strictRuleDedup: { enabled: true },
      anchorDedup: { enabled: true },
    });
    expect(deduped.split("- [strict_rule] 绝不可删除记忆。").length - 1).toBe(1);
  });
});