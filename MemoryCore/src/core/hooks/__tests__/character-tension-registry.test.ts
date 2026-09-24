/**
 * M2-P3（S-CHAR-2）：张力候选内存传递注册表 + T2 候选计算（RED 先行）。
 *
 * 设计依据：character-tension-m2-plan P3——候选张力实例只入内存传递（消费方=identity-discovery
 * worker），不落表（O14 边界）；租户隔离；cap 防膨胀。
 */
import { describe, expect, it } from "vitest";
import {
  recordTensionCandidates,
  drainTensionCandidates,
  computeT2Candidates,
  type TensionCandidate,
} from "../character-tension.js";

const T_A = { teamId: "t1", userId: "u1", agentId: "a1" };
const T_B = { teamId: "t1", userId: "u1", agentId: "a2" };

const cand = (label: string, refs: string[]): TensionCandidate => ({
  source: "T2",
  label,
  rationale: "测试候选",
  tensionRefs: refs.map((r) => ({ recordId: r })),
  detectedAt: "2026-09-24T00:00:00Z",
});

describe("M2-P3 张力候选注册表", () => {
  it("① 租户隔离：A 桶候选 B 桶不可见", () => {
    recordTensionCandidates(T_A, [cand("诚实", ["r1", "r2"])]);
    expect(drainTensionCandidates(T_B)).toEqual([]);
    const drained = drainTensionCandidates(T_A);
    expect(drained).toHaveLength(1);
    expect(drained[0].label).toBe("诚实");
  });

  it("② drain 即消费：二次 drain 为空（内存传递一次性语义）", () => {
    recordTensionCandidates(T_A, [cand("守诺", ["r1"])]);
    expect(drainTensionCandidates(T_A)).toHaveLength(1);
    expect(drainTensionCandidates(T_A)).toEqual([]);
  });

  it("③ cap 防膨胀：超限丢最旧（先进先出）", () => {
    for (const label of ["甲", "乙", "丙", "丁"]) recordTensionCandidates(T_A, [cand(label, ["r1"])], 3);
    const drained = drainTensionCandidates(T_A);
    expect(drained).toHaveLength(3);
    expect(drained.map((c) => c.label)).toEqual(["乙", "丙", "丁"]);
  });
});

describe("M2-P3 computeT2Candidates（证据分裂候选计算）", () => {
  it("④ 只产出张力锚：分裂达标才成候选，refs 带 recordId+valence", () => {
    const valences = [
      { label: "诚实", valence: 0.5, recordId: "r1" },
      { label: "诚实", valence: 0.2, recordId: "r2" },
      { label: "诚实", valence: -0.4, recordId: "r3" },
      { label: "诚实", valence: -0.6, recordId: "r4" },
      { label: "数据隐私", valence: 0.9, recordId: "r5" },
      { label: "数据隐私", valence: 0.8, recordId: "r6" },
    ];
    const out = computeT2Candidates(["诚实", "数据隐私"], valences, 2, "2026-09-24T00:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("T2");
    expect(out[0].label).toBe("诚实");
    expect(out[0].tensionRefs.map((r) => r.recordId).sort()).toEqual(["r1", "r2", "r3", "r4"]);
    expect(out[0].tensionRefs.every((r) => typeof r.valence === "number")).toBe(true);
  });

  it("⑤ 无张力输入返回空（宁缺毋滥）", () => {
    expect(computeT2Candidates([], [], 2, "2026-09-24T00:00:00Z")).toEqual([]);
    expect(
      computeT2Candidates(["诚实"], [{ label: "诚实", valence: 0.5, recordId: "r1" }], 2, "2026-09-24T00:00:00Z"),
    ).toEqual([]);
  });
});
