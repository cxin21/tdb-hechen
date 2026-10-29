/**
 * #141 因子设计（≥8 格）与「1+1>2」判定的单测——纯 fixture，不跑 bench、不联网。
 *
 * 覆盖票面验收口径：
 *  - 两臂同题配对：Δ 判对率与 CI 方向正确（不再拿组合档比基座）；
 *  - 单档最好：single 臂里判对率最高者被选为 singleBest；
 *  - 判定线：组合臂 Δ 的 95%CI 下界 > 0 才 combination-wins，否则 keep-single；
 *  - 判分器不一致：judge.ok=false + note 非空，CLI 退出码 3（--allow-cross-judge 可出数）；
 *  - 分题型门禁：temporal turnCov 低于基线 → perTypeGate.ok=false 且有 failure 明细；
 *  - 退化：空交集 / 单 case / 空 arms 都不抛错，原因写进 reasons。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFactorial, formatFactorialMarkdown } from "../scripts/lib/bench/factorial.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JUDGE = { judgeModel: "MiniMax-M3.1-Flash", judgePromptVersion: "lme-v2", judgeHost: "judge.example" };

type Row = Record<string, unknown>;

/** n 条 fixture 行：caseId 稳定（c0…c(n-1)），判对/覆盖率由回调给。 */
function rowsOf(
  n: number,
  opts: {
    type?: string;
    caseIdPrefix?: string;
    correct?: (i: number) => number;
    turnCov?: (i: number) => number;
    turnCovInjected?: number;
    injectedLines?: number;
    refused?: (i: number) => number;
  } = {},
): Row[] {
  const type = opts.type ?? "single-session-user";
  const prefix = opts.caseIdPrefix ?? "c";
  return Array.from({ length: n }, (_, i) => ({
    caseId: `${prefix}${i}`,
    questionType: type,
    question: `q${i}`,
    gold: `g${i}`,
    answer: `a${i}`,
    latencyMs: 100,
    genCorrect: opts.correct ? opts.correct(i) : 0,
    refused: opts.refused ? opts.refused(i) : 0,
    "turnCov@5": opts.turnCov ? opts.turnCov(i) : 1,
    turnCovInjected: opts.turnCovInjected ?? 1,
    turnCov: opts.turnCov ? opts.turnCov(i) : 1,
    injectedLines: opts.injectedLines ?? 7,
  }));
}

/** 最小可用报告：只放判定要用的字段（judge 身份 + rows）。 */
function mkReport(tag: string, rows: Row[], cfg: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-10-28T00:00:00.000Z",
    repoCommit: "deadbeef",
    dataset: { name: "longmemeval" },
    config: { tag, ...JUDGE, ...cfg },
    rows,
  };
}

const effectOf = (result: any, tag: string, metric = "genAccuracy") =>
  result.effects.win.find((w: any) => w.b === tag && w.metric === metric);

describe("factorial / 两臂同题配对", () => {
  it("Δ 判对率与 95%CI 方向正确（5/10 → 10/10，Δ=+50pp，CI 下界 > 0）", () => {
    const base = mkReport("r141-b0", rowsOf(10, { correct: (i) => i % 2 }));
    const w1 = mkReport("r141-w1", rowsOf(10, { correct: () => 1 }));
    const r = buildFactorial(
      [
        { tag: "r141-b0", report: base },
        { tag: "r141-w1", report: w1 },
      ],
      { baseTag: "r141-b0" },
    );

    const baseCell = r.cells.find((c: any) => c.tag === "r141-b0");
    const w1Cell = r.cells.find((c: any) => c.tag === "r141-w1");
    expect(baseCell.genAccuracy).toBeCloseTo(0.5, 10);
    expect(w1Cell.genAccuracy).toBeCloseTo(1, 10);
    expect(w1Cell.n).toBe(10);

    const e = effectOf(r, "r141-w1");
    expect(e).toBeTruthy();
    expect(e.dEval).toBeCloseTo(0.5, 10); // 原单位：+50pp
    expect(e.pp).toBeCloseTo(50, 10);
    expect(e.ciLow).toBeGreaterThan(0);
    expect(e.ciHigh).toBeLessThanOrEqual(1);
    expect(e.p).toBeCloseTo(0.0625, 10); // McNemar b=5,c=0：2*0.5^5
    expect(e.verdict).toBe("win");
    // 基线自己不出效应行
    expect(effectOf(r, "r141-b0")).toBeUndefined();
  });

  it("配对只取 caseId 交集，缺一侧的题不参与", () => {
    const base = mkReport("b0", rowsOf(10, { correct: () => 0 }));
    // 只有前 6 条同题；其余 caseId 不同
    const armRows = [...rowsOf(6, { correct: () => 1 }), ...rowsOf(4, { caseIdPrefix: "x", correct: () => 0 })];
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: mkReport("w1", armRows) },
      ],
      { baseTag: "b0" },
    );
    expect(effectOf(r, "w1").n).toBe(6);
    expect(effectOf(r, "w1").dEval).toBeCloseTo(1, 10);
  });
});

describe("factorial / 单档最好与判定线", () => {
  const armsFor = (comboCorrect: (i: number) => number, corrects: { w1?: (i: number) => number; w2h?: (i: number) => number } = {}) => [
    { tag: "b0", report: mkReport("b0", rowsOf(10, { correct: () => 0 })) },
    { tag: "w1", report: mkReport("w1", rowsOf(10, { correct: corrects.w1 ?? ((i) => (i < 5 ? 1 : 0)) })) },
    { tag: "w2h", report: mkReport("w2h", rowsOf(10, { correct: corrects.w2h ?? ((i) => (i < 8 ? 1 : 0)) })) },
    { tag: "w2s", report: mkReport("w2s", rowsOf(10, { correct: (i) => (i < 3 ? 1 : 0) })) },
    { tag: "w1w3", report: mkReport("w1w3", rowsOf(10, { correct: comboCorrect })) },
  ];

  it("singleBest 取 single 臂里判对率最高者（w2h 8/10）", () => {
    const r = buildFactorial(armsFor(() => 1), {
      baseTag: "b0",
      singleTags: ["w1", "w2h", "w2s"],
      comboTags: ["w1w3"],
    });
    expect(r.singleBest.tag).toBe("w2h");
    expect(r.singleBest.genAccuracy).toBeCloseTo(0.8, 10);
  });

  it("组合与单档最好持平（Δ=0）→ CI 下界 ≤ 0 → keep-single", () => {
    const r = buildFactorial(armsFor((i) => (i < 8 ? 1 : 0)), {
      baseTag: "b0",
      singleTags: ["w1", "w2h", "w2s"],
      comboTags: ["w1w3"],
    });
    expect(r.combo.tag).toBe("w1w3");
    expect(r.combo.bestTag).toBe("w2h");
    expect(r.combo.dVsBest).toBeCloseTo(0, 10);
    expect(r.combo.ciLow).toBe(0);
    expect(r.combo.pass).toBe(false);
    expect(r.verdict).toBe("keep-single");
  });

  it("组合显著优于单档最好（10/10 vs 5/10）→ CI 下界 > 0 → combination-wins", () => {
    // 单档最好压到 5/10（discordant 对足够多，bootstrap 2.5% 分位才会离开 0）
    const r = buildFactorial(armsFor(() => 1, { w2h: (i) => (i < 5 ? 1 : 0) }), {
      baseTag: "b0",
      singleTags: ["w1", "w2h", "w2s"],
      comboTags: ["w1w3"],
    });
    expect(r.singleBest.tag).toBe("w1"); // w1 与 w2h 同为 5/10，取靠前的那一格
    expect(r.combo.dVsBest).toBeCloseTo(0.5, 10);
    expect(r.combo.ciLow).toBeGreaterThan(0);
    expect(r.combo.pass).toBe(true);
    expect(r.verdict).toBe("combination-wins");
  });

  it("缺 singleTags / 缺 combo 臂 → insufficient，不抛错", () => {
    const r = buildFactorial(armsFor(() => 1), { baseTag: "b0" });
    expect(r.verdict).toBe("insufficient");
    expect(r.singleBest).toBeNull();
    expect(r.combo).toBeNull();
    expect(r.reasons.join(" ")).toContain("singleTags");
  });
});

describe("factorial / 判分器一致性", () => {
  it("跨 judge → judge.ok=false、note 非空、判对 Δ 标不可归因、verdict=insufficient", () => {
    const base = mkReport("b0", rowsOf(10, { correct: () => 0 }));
    const w1 = mkReport("w1", rowsOf(10, { correct: (i) => (i < 5 ? 1 : 0) }));
    const w1w3 = mkReport("w1w3", rowsOf(10, { correct: () => 1 }), { judgeModel: "scm-flash" });
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: w1 },
        { tag: "w1w3", report: w1w3 },
      ],
      { baseTag: "b0", singleTags: ["w1"], comboTags: ["w1w3"] },
    );
    expect(r.judge.ok).toBe(false);
    expect(typeof r.judge.note).toBe("string");
    expect(r.judge.note.length).toBeGreaterThan(0);
    expect(r.judge.note).toContain("判分器");
    expect(r.judge.mismatched.map((m: any) => m.tag)).toContain("w1w3");
    expect(effectOf(r, "w1w3").judgedComparable).toBe(false);
    expect(effectOf(r, "w1").judgedComparable).toBe(true);
    expect(r.verdict).toBe("insufficient");
    expect(r.combo.pass).toBe(false);
  });

  it("同 judge → judge.ok=true 且给出共同身份", () => {
    const r = buildFactorial(
      [
        { tag: "b0", report: mkReport("b0", rowsOf(6, { correct: () => 0 })) },
        { tag: "w1", report: mkReport("w1", rowsOf(6, { correct: () => 1 })) },
      ],
      { baseTag: "b0" },
    );
    expect(r.judge.ok).toBe(true);
    expect(r.judge.identity.fingerprint).toBe("MiniMax-M3.1-Flash@lme-v2");
    expect(r.judge.note).toContain("一致");
  });
});

describe("factorial / 分题型门禁", () => {
  it("某臂 temporal turnCov 低于基线 → ok=false 且 failures 有明细", () => {
    const base = mkReport("b0", [
      ...rowsOf(4, { type: "temporal-reasoning", turnCov: () => 1 }),
      ...rowsOf(4, { type: "single-session-user", turnCov: () => 1 }),
    ]);
    const w1 = mkReport("w1", [
      ...rowsOf(4, { type: "temporal-reasoning", turnCov: () => 0.5 }),
      ...rowsOf(4, { type: "single-session-user", turnCov: () => 1 }),
    ]);
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: w1 },
      ],
      { baseTag: "b0" },
    );
    expect(r.perTypeGate.ok).toBe(false);
    const f = r.perTypeGate.failures.find((x: any) => x.tag === "w1");
    expect(f).toBeTruthy();
    expect(f.type).toBe("temporal-reasoning");
    expect(f.metric).toBe("turnCov");
    expect(f.value).toBeCloseTo(0.5, 10);
    expect(f.floor).toBeCloseTo(1, 10);
    expect(r.reasons.join(" ")).toContain("分题型门禁");
  });

  it("门禁容差 pp 可放宽（--floor temporal-reasoning=turnCov=100 时 0.5 不再算掉线）", () => {
    const base = mkReport("b0", rowsOf(4, { type: "temporal-reasoning", turnCov: () => 1 }));
    const w1 = mkReport("w1", rowsOf(4, { type: "temporal-reasoning", turnCov: () => 0.5 }));
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: w1 },
      ],
      { baseTag: "b0", floor: { "temporal-reasoning": { metric: "turnCov", pp: 50 } } },
    );
    expect(r.perTypeGate.ok).toBe(true);
    expect(r.perTypeGate.failures).toEqual([]);
  });

  it("无 temporal 桶时门禁不误报（跳过并记 reason）", () => {
    const base = mkReport("b0", rowsOf(4, { type: "multi-session" }));
    const w1 = mkReport("w1", rowsOf(4, { type: "multi-session" }));
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: w1 },
      ],
      { baseTag: "b0" },
    );
    expect(r.perTypeGate.ok).toBe(true);
    expect(r.reasons.join(" ")).toContain("分题型门禁跳过");
  });
});

describe("factorial / 退化输入", () => {
  it("caseId 交集为空 → 跳过该配对并记 reason，不抛错", () => {
    const base = mkReport("b0", rowsOf(10));
    const other = mkReport("w1", rowsOf(10, { caseIdPrefix: "z" }));
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: other },
      ],
      { baseTag: "b0" },
    );
    expect(effectOf(r, "w1")).toBeUndefined();
    expect(r.reasons.join(" ")).toContain("配对跳过");
    expect(r.reasons.join(" ")).toContain("w1");
  });

  it("交集仅 1 条（n<2）→ 同样跳过，不抛错", () => {
    const base = mkReport("b0", rowsOf(10));
    const one = mkReport("w1", rowsOf(1, { correct: () => 1 }));
    const r = buildFactorial(
      [
        { tag: "b0", report: base },
        { tag: "w1", report: one },
      ],
      { baseTag: "b0" },
    );
    expect(effectOf(r, "w1")).toBeUndefined();
    expect(r.reasons.join(" ")).toContain("交集 1 条");
  });

  it("空 arms → insufficient，不抛错", () => {
    const r = buildFactorial([], {});
    expect(r.verdict).toBe("insufficient");
    expect(r.cells).toEqual([]);
    expect(r.judge.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("臂可以是 {tag, file}：就地读 JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factorial-lib-"));
    try {
      const b = path.join(dir, "b0.json");
      const w = path.join(dir, "w1.json");
      fs.writeFileSync(b, JSON.stringify(mkReport("b0", rowsOf(6, { correct: () => 0 }))));
      fs.writeFileSync(w, JSON.stringify(mkReport("w1", rowsOf(6, { correct: () => 1 }))));
      const r = buildFactorial(
        [
          { tag: "b0", file: b },
          { tag: "w1", file: w },
        ],
        { baseTag: "b0" },
      );
      expect(effectOf(r, "w1").dEval).toBeCloseTo(1, 10);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("factorial / markdown 渲染", () => {
  it("包含 cells 表、effects 表、判定结论与门禁明细", () => {
    const r = buildFactorial(
      [
        { tag: "b0", report: mkReport("b0", rowsOf(10, { correct: () => 0 })) },
        { tag: "w1", report: mkReport("w1", rowsOf(10, { correct: (i) => (i < 5 ? 1 : 0) })) },
        { tag: "w1w3", report: mkReport("w1w3", rowsOf(10, { correct: () => 1 })) },
      ],
      { baseTag: "b0", singleTags: ["w1"], comboTags: ["w1w3"] },
    );
    const md = formatFactorialMarkdown(r);
    expect(md).toContain("各格结果");
    expect(md).toContain("| 臂 |");
    expect(md).toContain("每臂 vs 基线");
    expect(md).toContain("1+1>2 判定");
    expect(md).toContain("combination-wins");
    expect(md).toContain("分题型门禁");
  });

  it("跨 judge 时标 * 并给脚注", () => {
    const r = buildFactorial(
      [
        { tag: "b0", report: mkReport("b0", rowsOf(6, { correct: () => 0 })) },
        { tag: "w1", report: mkReport("w1", rowsOf(6, { correct: () => 1 }), { judgeModel: "scm-flash" }) },
      ],
      { baseTag: "b0", singleTags: ["w1"], comboTags: ["w1"] },
    );
    const md = formatFactorialMarkdown(r);
    expect(md).toContain("*");
    expect(md).toContain("insufficient");
  });
});

describe("factorial CLI / 退出码与输出", () => {
  let tmp: string;
  let baseFile: string;
  let sameJudge: string;
  let crossJudge: string;

  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e: any) {
      return {
        code: typeof e?.status === "number" ? e.status : -1,
        out: String(e?.stdout ?? "") + String(e?.stderr ?? ""),
      };
    }
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-factorial-cli-"));
    baseFile = path.join(tmp, "r141-b0.json");
    sameJudge = path.join(tmp, "r141-w1w3.json");
    crossJudge = path.join(tmp, "r141-w1w3-scm.json");
    fs.writeFileSync(baseFile, JSON.stringify(mkReport("r141-b0", rowsOf(10, { correct: () => 0 }))));
    fs.writeFileSync(
      sameJudge,
      JSON.stringify(mkReport("r141-w1w3", rowsOf(10, { correct: () => 1 }))),
    );
    fs.writeFileSync(
      crossJudge,
      JSON.stringify(mkReport("r141-w1w3", rowsOf(10, { correct: () => 1 }), { judgeModel: "scm-flash" })),
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("同 judge → exit 0，输出中文 markdown 表", () => {
    const r = run(["--import", "tsx", "scripts/bench-factorial.mjs", "--base", baseFile, "--single", `r141-w1=${sameJudge}`, "--combo", `r141-w1w3=${sameJudge}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1+1>2 判定");
    expect(r.out).toContain("判分器");
  });

  it("跨 judge → exit 3、标 *、提示对齐路径；--allow-cross-judge → exit 0", () => {
    const cross = run(["--import", "tsx", "scripts/bench-factorial.mjs", "--base", baseFile, "--single", `r141-w1=${crossJudge}`, "--combo", `r141-w1w3=${crossJudge}`]);
    expect(cross.code).toBe(3);
    expect(cross.out).toContain("*");
    expect(cross.out).toContain("bench-rejudge.mjs");

    const allow = run(["--import", "tsx", "scripts/bench-factorial.mjs", "--base", baseFile, "--single", `r141-w1=${crossJudge}`, "--combo", `r141-w1w3=${crossJudge}`, "--allow-cross-judge"]);
    expect(allow.code).toBe(0);
    expect(allow.out).toContain("豁免");
  });

  it("缺 --base / 缺文件 → exit 2 并打印用法", () => {
    const noBase = run(["--import", "tsx", "scripts/bench-factorial.mjs", "--single", `r141-w1=${sameJudge}`]);
    expect(noBase.code).toBe(2);
    expect(noBase.out).toContain("用法");

    const missing = run(["--import", "tsx", "scripts/bench-factorial.mjs", "--base", path.join(tmp, "nope.json"), "--single", `r141-w1=${sameJudge}`]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("找不到报告文件");
  });

  it("--floor 与 --json：写出结构化结果，门禁按容差判定", () => {
    const out = path.join(tmp, "result.json");
    const midFile = path.join(tmp, "r141-w1.json");
    fs.writeFileSync(midFile, JSON.stringify(mkReport("r141-w1", rowsOf(10, { correct: (i) => (i < 5 ? 1 : 0) }))));
    const r = run([
      "--import",
      "tsx",
      "scripts/bench-factorial.mjs",
      "--base",
      baseFile,
      "--single",
      `r141-w1=${midFile}`,
      "--combo",
      `r141-w1w3=${sameJudge}`,
      "--floor",
      "temporal-reasoning=turnCov=0",
      "--json",
      out,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(parsed.verdict).toBe("combination-wins");
    expect(parsed.judge.ok).toBe(true);
  });
});
