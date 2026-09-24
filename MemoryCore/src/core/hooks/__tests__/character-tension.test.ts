/**
 * M2-P2（S-CHAR-2）：character-tension.ts 单一源纯函数契约（RED 先行）。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §2.2/§7.2 + character-tension-m2-plan P2。
 *   - T2 证据分裂：同锚（label）支撑证据 valence 方向分裂（正负各 ≥ minInstances）
 *   - T1 演化反向：self_identity 修订前后同价值域极性对照（极性词表确定性匹配，零 LLM）
 *   - 确定性：同输入逐字节同输出（纯函数、零随机、零时间依赖）
 */
import { describe, expect, it } from "vitest";
import { detectEvidenceSplit, detectEvolutionReversal } from "../character-tension.js";

const ev = (label: string, valence: number, recordId?: string) => ({ label, valence, recordId });

describe("M2-P2 T2 detectEvidenceSplit（证据分裂检测）", () => {
  it("① minInstances 边界：neg=1 < 2 不张力；neg=2 达标即张力", () => {
    const pos2neg1 = [ev("诚实", 0.5, "r1"), ev("诚实", 0.3, "r2"), ev("诚实", -0.4, "r3")];
    const a = detectEvidenceSplit("诚实", pos2neg1, 2);
    expect(a.tension).toBe(false);
    expect(a.tensionRefs).toBeNull();
    const b = detectEvidenceSplit("诚实", [...pos2neg1, ev("诚实", -0.6, "r4")], 2);
    expect(b.tension).toBe(true);
  });

  it("② minInstances=1：正负各 1 条即张力（参数化边界）", () => {
    const r = detectEvidenceSplit("诚实", [ev("诚实", 0.5, "r1"), ev("诚实", -0.5, "r2")], 1);
    expect(r.tension).toBe(true);
    expect(r.pos).toBe(1);
    expect(r.neg).toBe(1);
  });

  it("③ 全正不张力 / 全负不张力（单方向证据不构成分裂）", () => {
    const allPos = detectEvidenceSplit("诚实", [ev("诚实", 0.5), ev("诚实", 0.8), ev("诚实", 0.2)], 2);
    expect(allPos.tension).toBe(false);
    expect(allPos.pos).toBe(3);
    expect(allPos.neg).toBe(0);
    const allNeg = detectEvidenceSplit("诚实", [ev("诚实", -0.5), ev("诚实", -0.8)], 2);
    expect(allNeg.tension).toBe(false);
    expect(allNeg.neg).toBe(2);
    expect(allNeg.pos).toBe(0);
  });

  it("④ 空输入与 label 不匹配：静默 false（宁缺毋滥）", () => {
    const empty = detectEvidenceSplit("诚实", [], 2);
    expect(empty).toEqual({ tension: false, pos: 0, neg: 0, tensionRefs: null });
    const other = detectEvidenceSplit("诚实", [ev("数据隐私", 0.5), ev("数据隐私", -0.5)], 1);
    expect(other.tension).toBe(false);
    expect(other.pos).toBe(0);
    expect(other.neg).toBe(0);
  });

  it("⑤ 分裂命中：tensionRefs 非空且带 recordId；pos/neg 计数正确", () => {
    const r = detectEvidenceSplit(
      "诚实",
      [ev("诚实", 0.5, "r1"), ev("诚实", 0.2, "r2"), ev("诚实", -0.4, "r3"), ev("诚实", -0.6, "r4"), ev("数据隐私", 0.9, "rx")],
      2,
    );
    expect(r.tension).toBe(true);
    expect(r.pos).toBe(2);
    expect(r.neg).toBe(2);
    expect(r.tensionRefs).not.toBeNull();
    expect(r.tensionRefs!.map((x) => x.recordId).sort()).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("⑥ valence=0 中性不计入 pos/neg；非有限值跳过", () => {
    const r = detectEvidenceSplit("诚实", [ev("诚实", 0), ev("诚实", Number.NaN), ev("诚实", 0.5, "r1")], 1);
    expect(r.pos).toBe(1);
    expect(r.neg).toBe(0);
    expect(r.tension).toBe(false);
  });

  it("⑦ 确定性：同输入两次调用逐字节同输出（纯函数零随机）", () => {
    const input = [ev("诚实", 0.5, "r1"), ev("诚实", -0.5, "r2"), ev("诚实", 0.3, "r3"), ev("诚实", -0.2, "r4")];
    const a = JSON.stringify(detectEvidenceSplit("诚实", input, 2));
    const b = JSON.stringify(detectEvidenceSplit("诚实", input, 2));
    expect(a).toBe(b);
  });
});

describe("M2-P2 T1 detectEvolutionReversal（演化反向检测）", () => {
  it("⑧ 正向对照：「不做 X」→「做 X」判反向", () => {
    const r = detectEvolutionReversal("我不做数据隐私保护", "我现在做数据隐私保护", ["数据隐私"]);
    expect(r.tension).toBe(true);
    expect(r.reversed).toEqual(["数据隐私"]);
  });

  it("⑨ 反向对照：「做 X」→「不再做 X」判反向", () => {
    const r = detectEvolutionReversal("我一直做诚实沟通", "我不再做诚实沟通", ["诚实"]);
    expect(r.tension).toBe(true);
    expect(r.reversed).toEqual(["诚实"]);
  });

  it("⑩ 同向不张力：前后均正向 / 前后均负向", () => {
    const same = detectEvolutionReversal("我做诚实沟通", "我坚持做诚实沟通", ["诚实"]);
    expect(same.tension).toBe(false);
    expect(same.reversed).toBeNull();
    const sameNeg = detectEvolutionReversal("我不做数据隐私保护", "我仍然拒绝做数据隐私保护", ["数据隐私"]);
    expect(sameNeg.tension).toBe(false);
  });

  it("⑪ 极性词表命中：拒绝/避免/放弃等变体识别为负极性", () => {
    for (const negWord of ["拒绝", "避免", "放弃", "反对"]) {
      const r = detectEvolutionReversal(`我${negWord}做代码评审`, "我开始做代码评审", ["代码评审"]);
      expect(r.tension, `极性词「${negWord}」应识别为负极性`).toBe(true);
    }
  });

  it("⑫ label 未在前后文出现：不判反向（宁缺毋滥）", () => {
    const r = detectEvolutionReversal("今天天气不错", "明天继续推进", ["诚实"]);
    expect(r.tension).toBe(false);
    expect(r.reversed).toBeNull();
  });

  it("⑬ 确定性：同输入两次调用逐字节同输出", () => {
    const a = JSON.stringify(detectEvolutionReversal("我不做数据隐私保护", "我现在做数据隐私保护", ["数据隐私"]));
    const b = JSON.stringify(detectEvolutionReversal("我不做数据隐私保护", "我现在做数据隐私保护", ["数据隐私"]));
    expect(a).toBe(b);
  });
});
