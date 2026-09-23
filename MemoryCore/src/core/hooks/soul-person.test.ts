/**
 * P2 Task 7（spec §2.7）：灵魂渲染 person 分流——「重要的人」行（role·dir，weight DESC cap 5，
 * 数据驱动空则省略）+ 价值锚/感受段过滤 node_type==='person'（undefined → theme 旧库兼容）。
 */
import { describe, it, expect } from "vitest";
import { buildSoulPrefix } from "./soul-assembler.js";

const TENANT = { teamId: "t", userId: "u", agentId: "a" };

type VRow = { label: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string };

function makeStore(slots: Array<{ slot: string; content: string }> = [], values: VRow[] = []) {
  return { readCore: async () => slots, listValues: async () => values } as never;
}
function person(label: string, weight: number, valence: number | null, role?: string, aliases: string[] = []): VRow {
  return { label, weight, valence, state: "active", node_type: "person", attrs_json: JSON.stringify({ role, aliases }) };
}

describe("灵魂渲染 person 行（P2 §2.7）", () => {
  it("重要的人 行：role·dir 形态、weight DESC cap 5、位于价值锚行之后", async () => {
    const values: VRow[] = [
      { label: "诚实", weight: 0.9, valence: 1, state: "active" },
      person("女儿", 0.8, 1, "家人"),
      person("老周", 0.7, 0, "棋友"),
      person("张三", 0.6, -1, "同事"),
      person("李四", 0.5, 1, "朋友"),
      person("王五", 0.4, 1, "朋友"),
      person("赵六", 0.95, 1, "朋友"), // 最重 → 第一
    ];
    const out = await buildSoulPrefix(makeStore([{ slot: "identity", content: "x" }], values) as never, TENANT);
    expect(out).toContain("重要的人：");
    // weight DESC：赵六(0.95) 首位，王五(0.4) 被 cap 掉
    const line = out.split("\n").find((l) => l.startsWith("重要的人："))!;
    expect(line).toContain("赵六(朋友·趋近)");
    expect(line).toContain("女儿(家人·趋近)");
    expect(line).toContain("老周(棋友·中性)");
    expect(line).toContain("张三(同事·回避)");
    expect(line).not.toContain("王五");
    // 顺序：重要的人 行在 价值锚 行后
    expect(out.indexOf("价值锚：")).toBeLessThan(out.indexOf("重要的人："));
  });

  it("person 不进 价值锚/感受段：人物回避不与价值审慎混淆", async () => {
    const values: VRow[] = [
      { label: "诚实", weight: 0.9, valence: -1, state: "active" },
      person("张三", 0.8, -1, "同事"),
    ];
    const out = await buildSoulPrefix(makeStore([], values) as never, TENANT);
    expect(out).toContain("重要的人：");
    expect(out).not.toContain("价值锚：张三");
    expect(out).toContain("价值锚：诚实");
    expect(out).toContain("提醒我审慎的价值：诚实");
    expect(out).not.toContain("提醒我审慎的价值：诚实、张三");
  });

  it("无 person 行 → 无 重要的人 行（theme 渲染逐位现状）", async () => {
    const values: VRow[] = [{ label: "诚实", weight: 0.9, valence: 1, state: "active" }];
    const out = await buildSoulPrefix(makeStore([{ slot: "identity", content: "x" }], values) as never, TENANT);
    expect(out).not.toContain("重要的人：");
    expect(out).toContain("价值锚：诚实(趋近·w0.9)"); // V6-1b：weight 显示（合法波及更新）
  });

  it("node_type undefined → theme（旧库行兼容，不误入重要的人）", async () => {
    const values: VRow[] = [{ label: "旧库锚", weight: 0.9, valence: null, state: "active" }];
    const out = await buildSoulPrefix(makeStore([], values) as never, TENANT);
    expect(out).toContain("价值锚：旧库锚");
    expect(out).not.toContain("重要的人：");
  });
});

describe("F17 maxRelationLines（审计补齐：spec 要求行数上限 config 化，缺省 5=逐位现状）", () => {
  const mk = () => [
    person("甲", 0.9, 1, "家人"), person("乙", 0.85, 1, "朋友"), person("丙", 0.8, -1, "同事"),
    person("丁", 0.75, 0, "棋友"), person("戊", 0.7, 1, "朋友"), person("己", 0.65, 1, "朋友"),
  ];
  it("opts.maxRelationLines=2 → 只渲染 weight 前二", async () => {
    const out = await buildSoulPrefix(makeStore([], mk()) as never, TENANT, undefined, { maxRelationLines: 2 });
    const line = out.split("\n").find((l) => l.startsWith("重要的人："))!;
    expect(line).toContain("甲(家人·趋近)");
    expect(line).toContain("乙(朋友·趋近)");
    expect(line).not.toContain("丙");
  });
  it("缺省不传 → cap 5（原行为不变）", async () => {
    const out = await buildSoulPrefix(makeStore([], mk()) as never, TENANT);
    const line = out.split("\n").find((l) => l.startsWith("重要的人："))!;
    // 立项②：排序改 value_id 稳定序——top-5 取舍仍按 weight，渲染序不按 weight
      expect(line).toContain("重要的人：");
    expect(line).not.toContain("己");
  });
});
