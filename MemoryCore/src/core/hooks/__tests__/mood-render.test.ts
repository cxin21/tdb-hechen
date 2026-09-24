/**
 * M1-S3（S-FEEL-1/IF-2）：mood 行渲染守卫 + soulVersion 指纹扩展守卫。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §1.3/§1.6 + M1 计划 S3：
 *   - 不传 moodTier → 输出与既有渲染逐字节一致（近期基调行不出现；指纹不变）。
 *   - 传 moodTier → soul-feeling 块尾新行「近期基调：档位（近 N 条经历的情感聚合）」；
 *     不出连续值（防伪精度）；文案不含「我感到」（§1.5 主语越界防线）。
 *   - soulVersion 纳入 mood 档位（档位翻转=立即重注入）；undefined 时 payload 逐位一致。
 *   - 指纹只纳入 tier 不纳入 sampleCount（三值化控 KV 抖动——设计 §1.3；count 陈旧性为
 *     已登记取舍：count 文本随任一指纹变化刷新）。
 * 纪律：soulPrefixCache 为模块级跨用例存活——每用例独立租户（soul-cache.test.ts 实录）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix, computeSoulVersion } from "../soul-assembler.js";

const mkTenant = (n: string) => ({ teamId: "t1", userId: "u1", agentId: `mood-${n}` });

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  return {
    readCore: async () => slots,
    listValues: async () => rows,
  } as never;
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
const ROWS = [row({ value_id: "va", label: "文档" })];

describe("M1-S3 mood 行渲染守卫", () => {
  it("守卫①：不传 moodTier → 无近期基调行 + 指纹与 computeSoulVersion(slots, values) 逐位一致", async () => {
    const meta: { soulVersion?: string } = {};
    const out = await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g1"), undefined, {}, meta);
    expect(out).not.toContain("近期基调");
    expect(meta.soulVersion).toBe(computeSoulVersion(SLOTS, ROWS));
  });

  it("守卫②：computeSoulVersion 第三参 undefined → 指纹逐位不变", () => {
    expect(computeSoulVersion(SLOTS, ROWS)).toBe(computeSoulVersion(SLOTS, ROWS, undefined));
  });

  it("渲染③：strained → 「近期基调：偏承压（近 20 条经历的情感聚合）」为 </soul-feeling> 前最后一行", async () => {
    const out = await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g2"), undefined, { moodTier: { tier: "strained", sampleCount: 20 } });
    expect(out).toContain("近期基调：偏承压（近 20 条经历的情感聚合）");
    expect(out).toMatch(/近期基调：[^\n]+\n<\/soul-feeling>/);
    expect(out).not.toContain("我感到");
  });

  it("渲染④：positive→偏积极 / neutral→平稳 映射", async () => {
    const pos = await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g4"), undefined, { moodTier: { tier: "positive", sampleCount: 7 } });
    expect(pos).toContain("近期基调：偏积极（近 7 条经历的情感聚合）");
    const neu = await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g5"), undefined, { moodTier: { tier: "neutral", sampleCount: 5 } });
    expect(neu).toContain("近期基调：平稳（近 5 条经历的情感聚合）");
  });

  it("指纹⑤：传 moodTier（档位）→ 指纹变化；同档位不同样本数 → 指纹不变（三值化控 KV 抖动）", async () => {
    const metaA: { soulVersion?: string } = {};
    const metaB: { soulVersion?: string } = {};
    const metaC: { soulVersion?: string } = {};
    await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g6"), undefined, {}, metaA);
    await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g7"), undefined, { moodTier: { tier: "strained", sampleCount: 20 } }, metaB);
    await buildSoulPrefix(makeStore(ROWS, SLOTS), mkTenant("g8"), undefined, { moodTier: { tier: "strained", sampleCount: 21 } }, metaC);
    expect(metaA.soulVersion).not.toBe(metaB.soulVersion);
    expect(metaB.soulVersion).toBe(metaC.soulVersion);
  });

  it("渲染⑥：仅 mood（无方向锚）→ soul-feeling 块仍在场且只含基调行（宁缺毋滥不造空段）", async () => {
    const out = await buildSoulPrefix(makeStore([row({ value_id: "vz", label: "中锚", valence: 0 })], SLOTS), mkTenant("g9"), undefined, { moodTier: { tier: "neutral", sampleCount: 9 } });
    expect(out).toContain("## 当下的感受");
    expect(out).toContain("近期基调：平稳（近 9 条经历的情感聚合）");
    expect(out).not.toContain("驱动我行动的价值");
    expect(out).not.toContain("提醒我审慎的价值");
  });
});
