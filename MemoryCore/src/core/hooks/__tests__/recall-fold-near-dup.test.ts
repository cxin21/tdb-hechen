/**
 * #162（2026-10-29）：装配层近重折叠口径——同会话免疫 + 跨来源 containment。
 * 验收①（票面 Q2 推荐）：同会话两轮不折 / 同一条记忆重复出现才折 / 跨来源「包含关系」折 /
 * 跨来源主题相近不折。历史口径（A2 Jaccard ≥ 0.25）保留为数字参数（无来源调用方 + 回归对照）。
 * RED 先行：改前同一份 fixture 下「同会话两轮」「跨会话主题相近」两组都会被折成 1 行。
 */
import { describe, it, expect } from "vitest";
import { foldNearDuplicates, formatMemoryLine, vectorResultToFormatable } from "../auto-recall.js";

/** 行 → 来源会话（生产口径：searchResult.lineSessions 建 Map 的同形状）。 */
const sessionOf = (m: Record<string, string>) => (line: string): string | undefined => m[line];

const T1 = "- [episodic|出海项目] 用户说三季度前要把结算链路的对账模块做完，先接通多币种汇率";
const T2 = "- [episodic|出海项目] 用户说三季度前要把结算链路的对账模块搞完，先接通多币种汇率";
const LONG = "- [episodic|合规] 结算链路在 2026-10-30 之前完成资金对账模块，包含多币种汇率同步、失败重试与审计留痕";
const SHORT = "- [episodic|合规] 结算链路完成资金对账模块";
const TOPIC_A = "- [episodic|出海项目] 用户提到三季度结算链路排期很紧，资金对账必须先做";
const TOPIC_B = "- [episodic|出海项目] 用户要求结算链路先做资金对账，三季度排期紧也不能省";

describe("foldNearDuplicates（#162 同会话免疫 + containment）", () => {
  it("同会话两个不同轮次（字面高度重叠）→ 不折，两行都保留", () => {
    const out = foldNearDuplicates([T1, T2], { sessionOf: sessionOf({ [T1]: "s1", [T2]: "s1" }) });
    expect(out).toEqual([T1, T2]);
  });

  it("同一条记忆重复出现（逐字相同，同会话）→ 折成 1 行（去重能力保留）", () => {
    const out = foldNearDuplicates([T1, T1], { sessionOf: sessionOf({ [T1]: "s1" }) });
    expect(out).toEqual([T1]);
  });

  it("跨会话包含关系（一条被另一条完整覆盖）→ 折成 1 行，保留排序靠前者", () => {
    const out = foldNearDuplicates([LONG, SHORT], { sessionOf: sessionOf({ [LONG]: "s1", [SHORT]: "s2" }) });
    expect(out).toEqual([LONG]);
  });

  it("跨会话主题相近但不互相覆盖 → 不折（不再按「主题相似」判定重复）", () => {
    const out = foldNearDuplicates([TOPIC_A, TOPIC_B], { sessionOf: sessionOf({ [TOPIC_A]: "s1", [TOPIC_B]: "s2" }) });
    expect(out).toEqual([TOPIC_A, TOPIC_B]);
  });

  it("跨会话 bigram containment 很高但顺序被打乱（同领域不同事）→ 不折", () => {
    // 实测（离线门槛 gpt4_b4a80587）：短文本仅共享话题词即可把 containment 顶到 0.90+，
    // 故 #162 要求「同序覆盖」（近似子串）。下面这对 containment≈0.93、同序覆盖≈0.22/0.33。
    const SCR_A = "- [episodic|结算] 多币种汇率同步 失败重试 审计留痕 结算链路资金对账模块";
    const SCR_B = "- [episodic|结算] 结算链路资金对账模块 审计留痕 失败重试 多币种汇率同步";
    const out = foldNearDuplicates([SCR_A, SCR_B], { sessionOf: sessionOf({ [SCR_A]: "s1", [SCR_B]: "s2" }) });
    expect(out).toEqual([SCR_A, SCR_B]);
  });

  it("历史口径（传数字 = A2 Jaccard ≥0.25）仍折叠主题相近对——回归对照", () => {
    const out = foldNearDuplicates([TOPIC_A, TOPIC_B], 0.25);
    expect(out).toEqual([TOPIC_A]);
  });

  it("无来源信息（sessionOf 缺省）时按跨来源口径判重——不因缺 session 而失去折叠能力", () => {
    const out = foldNearDuplicates([LONG, SHORT], {});
    expect(out).toEqual([LONG]);
  });

  it("缺省不传参 = A2 历史口径（外部调用方逐位现状不变）", () => {
    expect(foldNearDuplicates([TOPIC_A, TOPIC_B])).toEqual([TOPIC_A]);
  });

  it("vectorResultToFormatable 透传 session_id，且不进注入行文本", () => {
    const m = vectorResultToFormatable({
      record_id: "r1",
      session_id: "session-abc",
      type: "episodic",
      content: "用户确认了三季度排期",
    } as never);
    expect(m.sessionId).toBe("session-abc");
    expect(formatMemoryLine(m)).not.toContain("session-abc");
  });
});
