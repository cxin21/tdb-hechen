/**
 * S1/S2 渲染批次（#22 感受段同门 + #23 首要=详述清单=其余/常量单一源，R5 定稿 2026-10-16）：
 * RED 先行——新增用例先因「缺陷仍在」失败：desc 空锚/episode 叙述锚混入感受段清单、同锚两现、
 * ≤80 魔法数无单一源。守卫用例（滤后稳定序、无首要子句时锚保留清单）改前改后都必须绿。
 * 形态翻修（2026-10-17 用户裁决「首要悬浮行乱」）：每方向单行、首要锚不除名、以 `label（首要：desc）`
 * 内联后缀呈现在其 value_id 排序位、悬浮「首要 X：」行退役——布局字节跳变一次声明，sv 不变。
 * 批次纪律：本批一次 golden 翻新、0 次 soulVersion 跳变（渲染层变更；指纹只由 slots+values+moodTier
 * 算出，缓存靠重启失效）。
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

const feelBlock = (out: string) => out.match(/<soul-feeling>[\s\S]*?<\/soul-feeling>/)?.[0] ?? "";
const feelLine = (out: string, header: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith(header));
  if (i < 0) return "";
  // 形态翻修（2026-10-17 用户裁决）：首要内联后缀 `label（首要：desc）` 入清单位、悬浮行退役 → 单行断言面
  return lines[i];
};

describe("S1 #22 感受段同门（价值锚行三门范式同构）", () => {
  it("①desc 空锚不入感受段清单（shadow-first 形态消失）；有 desc 锚保留", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-shadow", label: "shadow-first", weight: 0.6, valence: -1, attrs_json: "{}" }),
        row({ value_id: "v-real", label: "数据守护", weight: 0.5, valence: -1, attrs_json: '{"description":"绝不以删除记忆换结论。"}' }),
      ], SLOTS),
      mkTenant("g1"),
      undefined,
      {},
    );
    const feel = feelBlock(out);
    expect(feel).not.toContain("shadow-first");
    expect(feel).toContain("数据守护");
    expect(feel).toContain("提醒我审慎的价值");
  });

  it("②episode 叙述锚被 R2 门拒（与价值锚行同门，desc 为具体事件叙述）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "v-ep", label: "事故锚", weight: 0.9, valence: 1, attrs_json: '{"description":"commit abc1234 引入回归后修复"}' }),
        row({ value_id: "v-ok", label: "取证先行", weight: 0.5, valence: 1, attrs_json: '{"description":"先亲跑测试再下结论。"}' }),
      ], SLOTS),
      mkTenant("g2"),
      undefined,
      {},
    );
    const feel = feelBlock(out);
    expect(feel).not.toContain("事故锚");
    expect(feel).toContain("取证先行");
  });

  it("③滤后仍 value_id 稳定序（首要锚除外；守卫用例改前改后都绿）", async () => {
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
    const line = feelLine(out, "驱动我行动的价值：");
    expect(line).not.toBe("");
    // 形态翻修：首要锚不除名——整行=value_id 序纯 label + 首要锚内联后缀（乙(a-2)→丙(m-3)→甲(z-1)）
    expect(line).toBe("驱动我行动的价值：乙；丙；甲（首要：甲锚详述。）");
  });

  it("④同向全滤 → 该行省略；全部滤空且无 moodTier → soul-feeling 整段省略；有 moodTier → 仅基调行", async () => {
    const rows = [
      row({ value_id: "v-pe", label: "空描述锚", weight: 0.9, valence: 1, attrs_json: "{}" }),
      row({ value_id: "v-ne", label: "事故锚", weight: 0.8, valence: -1, attrs_json: '{"description":"commit abc1234 引入回归后修复"}' }),
    ];
    const bare = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g4a"), undefined, {});
    expect(bare).not.toContain("## 当下的状态");
    expect(bare).not.toContain("<soul-feeling>");
    const withMood = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g4b"), undefined, { moodTier: { tier: "neutral", sampleCount: 3 } });
    expect(withMood).toContain("## 当下的状态");
    expect(withMood).toContain("近期基调：平稳（近 3 条经历的情感聚合）");
    expect(withMood).not.toContain("驱动我行动的价值");
    expect(withMood).not.toContain("提醒我审慎的价值");
  });

  it("⑤预算门（budget>0 才生效）：超预算从尾丢清单锚，首要子句不占清单预算；缺省 0=空操作对照", async () => {
    const rows = [
      row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: '{"description":"甲锚详述。"}' }),
      row({ value_id: "a-2", label: "乙", weight: 0.5, attrs_json: '{"description":"乙锚句。"}' }),
      row({ value_id: "m-3", label: "丙", weight: 0.7, attrs_json: '{"description":"丙锚句。"}' }),
    ];
    const budgeted = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g5a"), undefined, { budgetAnchorChars: 2 });
    const bl = feelLine(budgeted, "驱动我行动的价值：");
    expect(bl).toBe("驱动我行动的价值：乙；甲（首要：甲锚详述。）");
    const full = await buildSoulPrefix(makeStore(rows, SLOTS), mkTenant("g5b"), undefined, {});
    expect(feelLine(full, "驱动我行动的价值：")).toBe("驱动我行动的价值：乙；丙；甲（首要：甲锚详述。）");
  });
});

describe("S2 #23 首要=详述、清单=其余 + 常量单一源", () => {
  it("①首要锚从清单除名（同锚两现消失；逐行字节形态）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: '{"description":"甲锚详述句。"}' }),
        row({ value_id: "a-2", label: "乙", weight: 0.3, attrs_json: '{"description":"乙锚句。"}' }),
      ], SLOTS),
      mkTenant("g6"),
      undefined,
      {},
    );
    expect(feelLine(out, "驱动我行动的价值：")).toBe("驱动我行动的价值：乙；甲（首要：甲锚详述句。）");
  });

  it("②退化形态（R5-23.2 专项 golden 翻新）：单锚承担首要 → 行=label（首要：desc）内联单行、无悬浮行", async () => {
    const pos = await buildSoulPrefix(
      makeStore([row({ value_id: "z-1", label: "甲", weight: 0.8, attrs_json: '{"description":"甲锚详述句。"}' })], SLOTS),
      mkTenant("g7"),
      undefined,
      {},
    );
    expect(feelLine(pos, "驱动我行动的价值：")).toBe("驱动我行动的价值：甲（首要：甲锚详述句。）");
    const neg = await buildSoulPrefix(
      makeStore([row({ value_id: "n-1", label: "风险锚", weight: 0.8, valence: -1, attrs_json: '{"description":"发布前必须回滚演练"}' })], SLOTS),
      mkTenant("g8"),
      undefined,
      {},
    );
    expect(feelLine(neg, "提醒我审慎的价值：")).toBe("提醒我审慎的价值：风险锚（首要：发布前必须回滚演练）");
  });

  it("③首要首句超 80 → 无首要子句且该锚保留在清单（宁缺毋滥不丢成员；守卫用例）", async () => {
    const longNoBound = "锚定描述内容".repeat(20); // 120 字无句界
    const out = await buildSoulPrefix(
      makeStore([row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: `{"description":"${longNoBound}"}` })], SLOTS),
      mkTenant("g9"),
      undefined,
      {},
    );
    expect(feelLine(out, "驱动我行动的价值：")).toBe("驱动我行动的价值：甲");
    expect(out).not.toContain("首要");
  });

  it("④SOUL_TOP_DESC_MAX_CHARS=80 单一源钉字数 + 句界 80/81 边界", async () => {
    expect((assembler as { SOUL_TOP_DESC_MAX_CHARS?: number }).SOUL_TOP_DESC_MAX_CHARS).toBe(80);
    const d80 = "x".repeat(79) + "。"; // 句界含于预算（m.index+1=80）
    const in80 = await buildSoulPrefix(
      makeStore([row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: `{"description":"${d80}"}` })], SLOTS),
      mkTenant("g10"),
      undefined,
      {},
    );
    expect(feelLine(in80, "驱动我行动的价值：")).toBe(`驱动我行动的价值：甲（首要：${d80}）`);
    const d81 = "x".repeat(80) + "。"; // 句界超预算（m.index+1=81）
    const out81 = await buildSoulPrefix(
      makeStore([row({ value_id: "z-1", label: "甲", weight: 0.9, attrs_json: `{"description":"${d81}"}` })], SLOTS),
      mkTenant("g11"),
      undefined,
      {},
    );
    expect(feelLine(out81, "驱动我行动的价值：")).toBe("驱动我行动的价值：甲");
  });
});
