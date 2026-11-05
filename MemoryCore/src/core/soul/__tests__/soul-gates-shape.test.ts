/**
 * 自维护人格层（m00527）单测 D：形态门（task_specific）与回放校准器。
 *
 * 验收：
 *  1) 带任务锚的长叙事（commit/issue/路径/工具名/比例/枚举）即便含「宁可…也不…」也只进 method；
 *  2) 长度按层分档（identity 90、values/relationship 110、boundary 120、narrative 160…），超档即 task_specific；
 *  3) 存量导入（legacy=true）豁免形态门——用户写进槽里的原话就是最高级证据；
 *  4) replayCalibration 能把「事件报告」判非人格、把「取舍句」判人格，并给出可核对的证据率。
 */
import { describe, expect, it } from "vitest";
import { classifyLine, evaluateCandidate, personaShape, PERSONA_SHAPE_MAX_CHARS } from "../gates.js";
import { replayCalibration, summarizeReplay } from "../replay.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG } from "../types.js";

describe("personaShape：分层长度档", () => {
  it("每层档位与实现一致（identity 90、values 110、relationship 110、boundary 120、narrative 160、voice 120）", () => {
    expect(PERSONA_SHAPE_MAX_CHARS.identity).toBe(90);
    expect(PERSONA_SHAPE_MAX_CHARS.values).toBe(110);
    expect(PERSONA_SHAPE_MAX_CHARS.boundary).toBe(120);
    expect(PERSONA_SHAPE_MAX_CHARS.relationship).toBe(110);
    expect(PERSONA_SHAPE_MAX_CHARS.narrative).toBe(160);
    expect(PERSONA_SHAPE_MAX_CHARS.method).toBe(Number.POSITIVE_INFINITY);
  });

  it("超档 → pass=false 且 detail 报出档位", () => {
    const r = personaShape("我".repeat(95), "identity");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("90");
  });

  it("带任务锚（文件扩展名/commit/比例）→ pass=false 并报命中物", () => {
    const r = personaShape("我在 v2-router.ts 里修了 8 处后，宁可重写也不打补丁", "values");
    expect(r.pass).toBe(false);
    expect(r.matched).toBeTruthy();
  });

  it("干净的取舍句 → pass=true", () => {
    const r = personaShape("宁可慢交付，也不交付没验证过的结论", "values");
    expect(r.pass).toBe(true);
  });
});

describe("classifyLine：形态门先于「像不像」", () => {
  it("任务叙事含「宁可…也不…」→ 只进 method（不进 values）", () => {
    const c = classifyLine("我在 #179 复审中宁可重跑三次也不采信单次结果，最终把 floor 阈值定在 p50=0.3126");
    expect(c.layer).toBe("method");
    // 先被事件门（「我在…中」）拦下；形态门是第二道，两道都指向 method。
    expect(c.reports.some((r) => r.code === "event_sentence" || r.code === "task_specific")).toBe(true);
  });

  it("长红线叙事（>120 字，讲过程而非禁令）→ 只进 method", () => {
    const long = "数据完整优先红线：" + "删除与提交这类写操作一律改挂自建单据执行，确保存量真实单据零接触，".repeat(4);
    const c = classifyLine(long);
    expect(c.layer).toBe("method");
    expect(c.reports.some((r) => r.code === "task_specific")).toBe(true);
  });

  it("已知校准地板：73 字的「原则+举例」红线仍判 boundary（不追求 100%，只追求可解释）", () => {
    // 生产回放 582 条里这类是残余 10 条误收的主体：它们既像原则又带例子。
    // 与其把门调紧到误杀真红线，不如承认这条地板并在报告里逐条列出。
    const c = classifyLine(
      "数据完整优先红线：删除/提交/转单等写操作一律改挂自建单据执行，确保存量真实单据零接触；case 标注与单据实际状态不符时，以核实后的实际状态为准",
    );
    expect(c.layer).toBe("boundary");
  });

  it("短红线（禁令 + 场景）→ boundary", () => {
    const c = classifyLine("绝不把情绪数据喂进召回排序");
    expect(c.layer).toBe("boundary");
  });

  it("存量导入（legacy=true）豁免形态门：用户原话即便带细节也照收", () => {
    const text = "数据完整优先红线：删除/提交/转单等写操作一律改挂自建单据执行，确保存量真实单据零接触；case 标注与单据实际状态不符时，以核实后的实际状态为准";
    expect(classifyLine(text, true).layer).not.toBe("method");
  });

  it("存量导入也拦事件句（legacy 只放宽形态与两难，不放宽事件）", () => {
    const c = classifyLine("我完成 commit b8ba3e0 并推送，tests 全绿", true);
    expect(c.layer).toBe("method");
    expect(c.reports.some((r) => r.code === "event_sentence")).toBe(true);
  });
});

describe("evaluateCandidate：字数门只约束新候选，不吞存量原话", () => {
  const cfg = {
    ...DEFAULT_SOUL_MAINTENANCE_CONFIG,
    maxItemChars: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.maxItemChars, boundary: 120 },
  };
  // 生产 strict_rule 里 124~144 字那 4 条同形态：长禁令 + 多个场景。
  const longRedline =
    "绝不" +
    "通过任何脚本、数据库维护或测试清理删除用户记忆，任何路径都不允许".repeat(4);
  const base = { layer: "boundary" as const, now: "2026-11-05T00:00:00.000Z", existing: [], config: cfg };

  it("新候选超 120 字 → too_long（长度门对新增仍然有效）", () => {
    const codes = evaluateCandidate(longRedline, base).filter((r) => !r.pass).map((r) => r.code);
    expect(codes).toContain("too_long");
  });

  it("legacy=true → 不因超字数被丢弃（用户亲手写的红线原话优先于字数档）", () => {
    const codes = evaluateCandidate(longRedline, { ...base, legacy: true }).filter((r) => !r.pass).map((r) => r.code);
    expect(codes).not.toContain("too_long");
  });

  it("legacy 只放宽长度，事件句仍是硬门（存量导入也不许把会过期的话搬进人格层）", () => {
    const codes = evaluateCandidate("我完成 commit b8ba3e0 并推送，tests 全绿", {
      ...base,
      legacy: true,
      layer: "identity",
    })
      .filter((r) => !r.pass)
      .map((r) => r.code);
    expect(codes).toContain("event_sentence");
  });
});

describe("replayCalibration：回放判据", () => {
  const cases = [
    { id: "a", text: "我完成 commit b8ba3e0 并推送，tests 全绿", state: "rejected" as const },
    { id: "b", text: "数据完整优先红线：删除/提交/转单等写操作一律改挂自建单据执行，确保存量真实单据零接触；case 标注与单据实际状态不符时，以核实后的实际状态为准", state: "rejected" as const },
    { id: "c", text: "宁可慢交付，也不交付没验证过的结论", state: "adopted" as const },
    { id: "d", text: "绝不把情绪数据喂进召回排序", state: "adopted" as const },
  ];

  it("事件句判非人格、取舍/禁令句判人格，并给出 catchRate", () => {
    const r = replayCalibration(cases);
    expect(r.total).toBe(4);
    expect(r.cases.find((c) => c.id === "a")!.verdict).toBe("non_persona");
    expect(r.cases.find((c) => c.id === "c")!.verdict).toBe("persona");
    expect(r.cases.find((c) => c.id === "d")!.verdict).toBe("persona");
    expect(r.rejectionCatchRate).toBeGreaterThan(0);
    expect(r.falseAdmits.map((c) => c.id)).toContain("b");
    expect(summarizeReplay(r)).toContain("catchRate=");
  });

  it("同一条判定可重复（确定性：无时间/无随机）", () => {
    const a = replayCalibration(cases).cases.map((c) => c.verdict);
    const b = replayCalibration(cases).cases.map((c) => c.verdict);
    expect(a).toEqual(b);
  });

  it("空输入不抛错、不给假分数", () => {
    const r = replayCalibration([]);
    expect(r.total).toBe(0);
    expect(Number.isFinite(r.rejectionCatchRate)).toBe(true);
  });

  it("配置可收紧形态门（redlineMaxChars 是收紧旋钮，不是放宽旋钮）", () => {
    const text = "绝不" + "把未经核实的东西当成结论".repeat(6); // 80 字红线
    const dflt = replayCalibration([{ id: "x", text, state: "rejected" }], DEFAULT_SOUL_MAINTENANCE_CONFIG);
    const tight = replayCalibration([{ id: "x", text, state: "rejected" }], {
      ...DEFAULT_SOUL_MAINTENANCE_CONFIG,
      redlineMaxChars: 60,
    });
    expect(dflt.cases[0]!.verdict).toBe("persona");
    expect(tight.cases[0]!.verdict).toBe("non_persona");
    expect(tight.cases[0]!.codes).toContain("task_specific");
  });
});
