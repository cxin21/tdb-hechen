/**
 * #29（R5）：情境锚选择 shadow 门测试。
 * 合同（r5-29）：预算内不裁剪（检索式裁剪=身份漂移入口）；触发条件硬编码=
 * 仅 价值锚行数 > soulRender.anchorSelect.maxRows 才（将来会）启用；
 * shadow 先行——选择器未定（tier=#33 D9、打分器=ADR），当前只报告不裁剪，
 * 渲染逐位现状；一致性门（#31 探针）通过后才转正。
 * 锚点：价值锚行 budgeted=applyAnchorBudget(decorated,…)（soul-assembler.ts:345）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "tsh", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>) {
  return {
    readCore: async () => [] as Array<Record<string, string>>,
    listValues: async () => rows,
  } as never;
}

const themed = (i: number) => ({
  value_id: `v${String(i).padStart(2, "0")}`,
  label: `锚${i}`,
  weight: 0.5,
  valence: 1,
  state: "active",
  node_type: "theme",
  attrs_json: `{"description":"第${i}号锚的稳定描述句。"}`,
});

function spyLogger() {
  const warns: string[] = [];
  return { warns, logger: { warn: (m: string) => void warns.push(m) } as never };
}

describe("#29 情境锚选择 shadow 门", () => {
  it("行数 ≤ maxRows → 渲染逐位不变 + 零 shadow 报告", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base" }, undefined, {});
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-lt" }, logger, { anchorSelect: { maxRows: 5 } });
    expect(out).toBe(base);
    expect(warns.filter((w) => w.includes("soul-anchor-select"))).toHaveLength(0);
  });

  it("行数 > maxRows → 渲染仍逐位不变（shadow 不裁剪）+ 报告含行数/阈值/清单", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base2" }, undefined, {});
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-gt" }, logger, { anchorSelect: { maxRows: 5 } });
    expect(out).toBe(base); // shadow 先行：字节级不裁剪
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("rows=8");
    expect(shadow[0]).toContain("maxRows=5");
    expect(shadow[0]).toContain("锚7"); // 清单快照含尾部锚
  });

  it("缺省（未配置 anchorSelect）→ 零报告", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-def" }, logger, {});
    expect(warns.filter((w) => w.includes("soul-anchor-select"))).toHaveLength(0);
  });
});
