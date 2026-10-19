/**
 * 呈现层翻修（2026-10-17 用户 m00227 终审）：感受段清单行（驱动/审慎）与首要内联
 * 子句机制退役——方向语义收敛到 identity 价值锚行逐锚标注（趋近/审慎），纯去重非信息
 * 删除（方案约束4）。本文件守卫迁移：
 * S1 三门范式（desc 空/episode 叙述拒入、value_id 稳定序、预算门）迁移到 identity
 * 价值锚行断言（同一 gated 管道，:462 applyAnchorBudget 消费点保留）；
 * S2 机制退役钉（「（首要：」全文件禁现 + SOUL_TOP_DESC_MAX_CHARS 单一源保留）。
 * 纪律：soulPrefixCache 为模块级跨用例存活——每用例独立租户（soul-cache.test.ts 实录）。
 */
import { describe, expect, it } from "vitest";
import * as assembler from "../soul-assembler.js";

const { buildSoulPrefix } = assembler;

const mkTenant = (n: string) => ({ teamId: "t1", userId: "u1", agentId: `s12-${n}` });

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  return { readCore: async () => slots, listValues: async () => rows } as never;
}

const row = (o: { value_id: string; label: string; weight?: number; valence?: number | null; node_type?: string; attrs_json?: string }) => ({
  value_id: o.value_id,
  label: o.label,
  weight: o.weight ?? 0.8,
  valence: o.valence === undefined ? 1 : o.valence,
  state: "active",
  node_type: o.node_type ?? "theme",
  attrs_json: o.attrs_json ?? "{}",
});

const SLOTS = [{ slot: "self_identity", content: "我是测试主体" }];

describe("S1 三门范式迁移：identity 价值锚行（与感受段同门管道）", () => {
  it("①desc 空锚不入 identity 价值锚行（shadow-first 形态消失）；有 desc 锚保留", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-shadow", label: "shadow-first", weight: 0.6, valence: -1, attrs_json: "{}" }),
        row({ value_id: "v-real", label: "数据守护", weight: 0.5, valence: -1, attrs_json: '{"description":"绝不以删除记忆换结论。"}' }),
      ], SLOTS),
      mkTenant("g1"),
      undefined,
      {},
    );
    expect(out).not.toContain("- shadow-first");
    expect(out).toContain("- 数据守护(审慎)：绝不以删除记忆换结论。");
    expect(out).not.toContain("提醒我审慎的价值");
  });

  it("②episode 叙述锚被 R2 门拒（desc 为具体事件叙述）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-ep", label: "事故锚", weight: 0.9, valence: 1, attrs_json: '{"description":"commit abc1234 引入回归后修复"}' }),
        row({ value_id: "v-ok", label: "取证先行", weight: 0.5, valence: 1, attrs_json: '{"description":"先亲跑测试再下结论。"}' }),
      ], SLOTS),
      mkTenant("g2"),
      undefined,
      {},
    );
    expect(out).not.toContain("- 事故锚");
    expect(out).toContain("- 取证先行(趋近)：先亲跑测试再下结论。");
  });

  it("③identity 价值锚行 value_id 稳定序（weight 不承载注入序）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: '{"description":"甲锚详述。"}' }),
        row({ value_id: "a-2", label: "乙", weight: 0.5, attrs_json: '{"description":"乙锚句。"}' }),
        row({ value_id: "m-3", label: "丙", weight: 0.7, attrs_json: '{"description":"丙锚句。"}' }),
      ], SLOTS),
      mkTenant("g3"),
      undefined,
      {},
    );
    expect(out).toContain("- 乙(趋近)：乙锚句。\n- 丙(趋近)：丙锚句。\n- 甲(趋近)：甲锚详述。");
  });

  it("④全滤空且无 moodTier/state → soul-feeling 整段省略；有 moodTier → 仅基调行", async () => {
    const rows = [
      row({ value_id: "v-pe", label: "空描述锚", weight: 0.9, valence: 1, attrs_json: "{}" }),
      row({ value_id: "v-ne", label: "事故锚", weight: 0.8, valence: -1, attrs_json: '{"description":"commit abc1234 引入回归后修复"}' }),
    ];
    const bare = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g4a"), undefined, {});
    expect(bare).not.toContain("## 当下的状态");
    expect(bare).not.toContain("<soul-feeling>");
    const withMood = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g4b"), undefined, { moodTier: { tier: "neutral", sampleCount: 3 } });
    expect(withMood).toContain("## 当下的状态");
    expect(withMood).toContain("近期基调：平稳。"); // 质量轮 2026-10-19：实现细节括号退役
    expect(withMood).not.toContain("驱动我行动的价值");
    expect(withMood).not.toContain("提醒我审慎的价值");
  });

  it("⑤预算门迁移：budgetAnchorChars 由 identity 价值锚行消费（首项例外整项保留，超预算尾丢）", async () => {
    const rows = [
      row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: '{"description":"甲锚详述。"}' }),
      row({ value_id: "a-2", label: "乙", weight: 0.5, attrs_json: '{"description":"乙锚句。"}' }),
      row({ value_id: "m-3", label: "丙", weight: 0.7, attrs_json: '{"description":"丙锚句。"}' }),
    ];
    const budgeted = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g5a"), undefined, { budgetAnchorChars: 2 });
    expect(budgeted).toContain("- 乙(趋近)：乙锚句。");
    expect(budgeted).not.toContain("- 甲(趋近)");
    expect(budgeted).not.toContain("- 丙(趋近)");
    const full = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g5b"), undefined, {});
    expect(full).toContain("- 乙(趋近)：乙锚句。");
    expect(full).toContain("- 甲(趋近)：甲锚详述。");
  });
});

describe("S2 机制退役钉（m00227）", () => {
  it("①首要内联子句与驱动/审慎清单行全文件禁现", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: '{"description":"甲锚详述句。"}' }),
        row({ value_id: "a-2", label: "乙", weight: 0.3, attrs_json: '{"description":"乙锚句。"}' }),
      ], SLOTS),
      mkTenant("g6"),
      undefined,
      {},
    );
    expect(out).not.toContain("（首要：");
    expect(out).not.toContain("驱动我行动的价值：");
    expect(out).not.toContain("提醒我审慎的价值：");
    expect(out).toContain("- 甲(趋近)：甲锚详述句。");
  });

  it("②SOUL_TOP_DESC_MAX_CHARS=80 单一源保留（常量钉）", () => {
    expect((assembler as { SOUL_TOP_DESC_MAX_CHARS?: number }).SOUL_TOP_DESC_MAX_CHARS).toBe(80);
  });
});
