/**
 * 灵魂注入质量轮（2026-10-04 何晨令「禁止无意义、不明确的内容和仅有关键词无说明的锚点注入」）：
 * ① desc 空/空白锚 → 整条跳过（宁缺毋滥禁裸关键词形态）；全部锚无 desc → 价值锚行省略；
 * ② desc 尾悬空（以，、, 结尾）→ 句边界清洗（截到最后句末标点。！？；；无句末标点=按空处理）；
 * ③ 品格行同构。RED 先行。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  return {
    readCore: async () => slots,
    listValues: async () => rows,
  } as never;
}

const row = (o: { value_id: string; label: string; weight?: number; valence?: number | null; node_type?: string; attrs_json?: string }) => ({
  value_id: o.value_id,
  label: o.label,
  weight: o.weight ?? 0.5,
  valence: o.valence ?? 1,
  state: "active",
  node_type: o.node_type ?? "theme",
  attrs_json: o.attrs_json ?? "{}",
});

describe("价值锚行 desc 门（宁缺毋滥禁裸关键词/半句）", () => {
  it("无 desc 锚整条跳过；有 desc 锚照常渲染（防收窄回归）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "a-1", label: "拍板" }), // 无 desc = 存量 96/130 NoDesc 形态
        row({ value_id: "b-2", label: "根因", attrs_json: '{"description":"所有结论须以真实代码与测试取证背书"}' }),
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    const m = out.match(/价值锚：([^\n]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("根因(趋近·w0.5)：所有结论须以真实代码与测试取证背书");
    expect(m![1]).not.toContain("拍板"); // 裸关键词形态整条消失
    expect(m![1]).not.toContain("拍板(趋近·w0.5)");
  });

  it("全部锚无 desc → 价值锚行省略（不造空行/裸串）", async () => {
    const out = await buildSoulPrefix(
      makeStore([row({ value_id: "a-1", label: "拍板" }), row({ value_id: "b-2", label: "收口" })]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    expect(out).not.toContain("价值锚：");
    expect(out).not.toContain("拍板(趋近·w0.5)");
  });

  it("desc 尾悬空（顿号结尾）含句末标点 → 清洗到最后句末标点", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "c-3", label: "实证", attrs_json: '{"description":"换路绕行是实证沉淀。同一交互连续两次失败即触发换路绕行，多次实证均成功、"}' }),
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    const m = out.match(/价值锚：([^\n]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("实证(趋近·w0.5)：换路绕行是实证沉淀。"); // 截到最后句末标点
    expect(m![1]).not.toContain("成功、"); // 半句尾巴消失
  });

  it("desc 尾悬空且无任何句末标点 → 按空处理整条跳过", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "d-4", label: "半句锚", attrs_json: '{"description":"A-5 达 GRE、"}' }),
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    expect(out).not.toContain("价值锚："); // 价值锚行整行省略（感受段方向行=设计内形态不在此断言面）
  });

  it("品格行同构：无 desc 品格锚不入行（渲染门开启态）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "ch-1", label: "审慎", node_type: "character" }), // 无 desc 品格锚
        row({ value_id: "ch-2", label: "诚实", node_type: "character", attrs_json: '{"description":"诚实呈现证据与遗留，不粉饰"}' }),
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, characterTensionEnabled: true },
    );
    const m = out.match(/我的品格：([^\n]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("诚实");
    expect(m![1]).not.toContain("审慎");
  });

  it("R2 episode 门：desc 为具体事件叙述（commit hash/编号/HTTP）→ 锚不入行（灵魂禁混记忆内容）", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        row({ value_id: "e-1", label: "闭环", attrs_json: '{"description":"用户需求被转化为可验证任务并闭环收口：关键位置加日志的要求落实为任务，以提交 b1ea2e5"}' }),
        row({ value_id: "e-2", label: "审计", attrs_json: '{"description":"遗留工作依主指令落入台账 REG-REMAINING-006 按序推进"}' }),
        row({ value_id: "e-3", label: "根因优先", attrs_json: '{"description":"解决问题必须从第一性原理出发，先定位根本原因并从根源根治，拒绝临时补丁式修复。"}' }),
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    const m = out.match(/价值锚：([^\n]+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("根因优先"); // 合格价值观锚照常
    expect(m![1]).not.toContain("闭环"); // 混事件锚（commit hash）整条消失
    expect(m![1]).not.toContain("审计"); // 混事件锚（登记号）整条消失
    expect(m![1]).not.toContain("b1ea2e5");
    expect(m![1]).not.toContain("REG-REMAINING");
  });
});
