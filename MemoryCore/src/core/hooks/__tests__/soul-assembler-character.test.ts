/**
 * M2-P5（S-CHAR-2）：品格行渲染迁移（RED 先行）。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §2.3 + character-tension-m2-plan P5。
 *   - opts.characterTensionEnabled=true（M2 渲染门，缺省关断=逐位现状）：
 *     价值锚行排除 character（与感受段 theme-only filter 对齐）+「我是谁」小节尾部「我的品格：」行
 *   - 关断时品格锚保持现状（混渲染于价值锚行）
 *   - R-B：品格不入感受段（两种模式都不得出现）
 * 注：buildSoulPrefix 有指纹→文本缓存（同租户同数据命中缓存）——每个调用用独立租户键隔离。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

let tenantSeq = 0;
const nextTenant = () => ({ teamId: "ft", userId: "m2", agentId: `agent-render-${++tenantSeq}` });

function makeFakeStore(values: Array<Record<string, unknown>>) {
  return {
    readCore: () => [{ slot: "self_identity", content: "- 我在这个团队负责技术评审与交付把关" }],
    listValues: () => values,
  } as never;
}

const BASE_VALUES: Array<Record<string, unknown>> = [
  { value_id: "v-theme", label: "诚实", weight: 0.5, valence: 1, state: "active", node_type: "theme", attrs_json: "{}", created_by: "seed", origin: "seed", pinned: 0 },
  { value_id: "v-person", label: "女儿", weight: 0.8, valence: 1, state: "active", node_type: "person", attrs_json: '{"role":"家人"}', created_by: "auto-growth", origin: "auto", pinned: 0 },
  { value_id: "v-char", label: "守诺", weight: 0.6, valence: 1, state: "active", node_type: "character", attrs_json: '{"description":"承诺必兑现"}', created_by: "auto-growth", origin: "auto", pinned: 0 },
];

describe("M2-P5 品格行渲染迁移", () => {
  it("① 渲染门关断（缺省）：品格锚保持现状混渲染于价值锚行，无「我的品格」行", async () => {
    const text = await buildSoulPrefix(makeFakeStore(BASE_VALUES), nextTenant(), undefined, {} as never);
    expect(text).not.toContain("我的品格");
    const valueRow = text.split("\n").find((l) => l.startsWith("价值锚："));
    expect(valueRow).toContain("守诺");
  });

  it("② 渲染门开启：价值锚行排除 character，「我的品格：label(方向·w)：描述」行在场；指纹=数据决定两模式一致", async () => {
    const meta1: { soulVersion?: string } = {};
    const meta2: { soulVersion?: string } = {};
    const off = await buildSoulPrefix(makeFakeStore(BASE_VALUES), nextTenant(), undefined, {} as never, meta1);
    const on = await buildSoulPrefix(makeFakeStore(BASE_VALUES), nextTenant(), undefined, { characterTensionEnabled: true } as never, meta2);
    const valueRow = on.split("\n").find((l) => l.startsWith("价值锚："));
    expect(valueRow).toContain("诚实");
    expect(valueRow).not.toContain("守诺");
    const charRow = on.split("\n").find((l) => l.startsWith("我的品格："));
    expect(charRow).toBeDefined();
    expect(charRow).toContain("守诺(");
    expect(charRow).toContain("承诺必兑现");
    expect(meta1.soulVersion).toBe(meta2.soulVersion);
    expect(on).not.toBe(off);
  });

  it("③ 渲染门开启但无品格锚：逐字节等于关断输出（宁缺毋滥零噪声）", async () => {
    const themeOnly = BASE_VALUES.filter((v) => v.node_type !== "character");
    const off = await buildSoulPrefix(makeFakeStore(themeOnly), nextTenant(), undefined, {} as never);
    const on = await buildSoulPrefix(makeFakeStore(themeOnly), nextTenant(), undefined, { characterTensionEnabled: true } as never);
    expect(on).toBe(off);
  });

  it("④ R-B 红线：品格锚 valence=±1 也不入感受段（两种模式）", async () => {
    for (const opts of [{}, { characterTensionEnabled: true }]) {
      const text = await buildSoulPrefix(makeFakeStore(BASE_VALUES), nextTenant(), undefined, opts as never);
      const feelBlock = text.split("<soul-feeling>")[1]?.split("</soul-feeling>")[0] ?? "";
      expect(feelBlock).not.toContain("守诺");
      expect(feelBlock).toContain("诚实"); // theme ±1 锚照常在感受段
    }
  });
});
