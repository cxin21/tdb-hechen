/**
 * #140 判分器一致性门禁的叶模块单测：
 *  - judge.mjs：判分器身份抽取、配对判定（同 judge / 跨 judge / 未记录）、头部渲染、配置差异、修复提示；
 *  - baseline.mjs：基线登记表（baselineTag + judgeModel + commit）读写与「同 judge 基线」解析；
 *  - rejudge.mjs：拿旧报告里已存的答案按当前 judge 重判（判分器变更的治本路径，无需重跑召回）。
 *
 * 这些断言直接对应票面验收：
 *  - 「人为拿 scm-flash 报告配 MiniMax 报告 → 三个工具都拒绝/警示」→ decidePairing 非 0；
 *  - 「同 judge 配对正常通过」→ status=same、allowed=true；
 *  - 「门禁默认引用同 judge 基线」→ findBaseline / judgeBaselineAudit；
 *  - 判分器变更不再只能「关掉开关/重跑全档」→ regradeReport 用旧答案重判。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CROSS_JUDGE_EXIT_CODE,
  configDiff,
  configDiffLine,
  decidePairing,
  judgeHeaderLines,
  judgeIdentity,
  judgeRepairHint,
  pairJudges,
} from "../scripts/lib/bench/judge.mjs";
import {
  BASELINE_REGISTRY_VERSION,
  entryFromReport,
  findBaseline,
  judgeBaselineAudit,
  loadRegistry,
  registryPathForManifest,
  saveRegistry,
  summarizeRegistryLines,
  upsertEntry,
} from "../scripts/lib/bench/baseline.mjs";
import { answersOf, regradeReport } from "../scripts/lib/bench/rejudge.mjs";

const MANIFEST = ".eval-data/bench/lme-manifest.json";

/** 最小可用报告：config 只放判定相关字段，rows 只放判定用到的列。 */
function report(over = {}) {
  const base = {
    generatedAt: "2026-10-27T05:35:29.000Z",
    repoCommit: "deadbeefcafe1234",
    dataset: { name: "longmemeval" },
    config: {
      tag: "b1off-mm",
      manifest: MANIFEST,
      judgeModel: "MiniMax-M3.1-Flash",
      judgeHost: "api.minimax.cn",
      judgePromptVersion: "lme-v2",
      judgeTemperature: 0,
    },
    rows: [
      { caseId: "c1", questionType: "single-session-user", question: "q1", gold: "g1", answer: "a1", genCorrect: 1, refused: 0, "turnCov@5": 1 },
      { caseId: "c2", questionType: "multi-session", question: "q2", gold: "g2", answer: "a2", genCorrect: 0, refused: 1, "turnCov@5": 0.5 },
    ],
    overall: { genAccuracy: 0.5, genJudged: 2, turnCov: 0.75 },
  };
  return { ...base, ...over, config: { ...base.config, ...(over.config ?? {}) } };
}

/** 只有检索指标、没有判分行（--gen-limit 0 档）。 */
function retrievalOnly(over = {}) {
  return report({
    config: { judgeModel: null, judgeHost: null, tag: "ret-only" },
    rows: [
      { caseId: "c1", questionType: "single-session-user", "turnCov@5": 1 },
      { caseId: "c2", questionType: "multi-session", "turnCov@5": 0.5 },
    ],
    overall: { genAccuracy: null, genJudged: 0 },
    ...over,
  });
}

describe("judge.mjs / judgeIdentity", () => {
  it("有 judgeModel 时给出已知身份与标签", () => {
    const id = judgeIdentity(report());
    expect(id.known).toBe(true);
    expect(id.model).toBe("MiniMax-M3.1-Flash");
    expect(id.label).toContain("MiniMax-M3.1-Flash");
    expect(id.fingerprint).toBe("MiniMax-M3.1-Flash@lme-v2");
  });

  it("缺 judgeModel 时标为未知，不伪造身份", () => {
    const id = judgeIdentity(retrievalOnly());
    expect(id.known).toBe(false);
    expect(id.model).toBeNull();
    expect(id.label).toContain("未记录");
  });

  it("空串/空白 judgeModel 也算未知（防止 config 里写了空值就当真）", () => {
    expect(judgeIdentity(report({ config: { judgeModel: "   " } })).known).toBe(false);
  });
});

describe("judge.mjs / pairJudges", () => {
  it("同 judge 同提示词 → same，判对指标可配对", () => {
    const p = pairJudges(report(), report({ config: { tag: "deep105" } }));
    expect(p.status).toBe("same");
    expect(p.judgedComparable).toBe(true);
    expect(p.reasons).toEqual([]);
  });

  it("跨 judge → cross，判对指标不可配对，理由点名两侧模型", () => {
    const p = pairJudges(report({ config: { judgeModel: "scm-flash", tag: "b1-off" } }), report());
    expect(p.status).toBe("cross");
    expect(p.judgedComparable).toBe(false);
    expect(p.reasons.join(" ")).toContain("scm-flash");
    expect(p.reasons.join(" ")).toContain("MiniMax-M3.1-Flash");
  });

  it("同模型但判分提示版本不同 → 也算跨判分器（提示词漂移会改变判定口径）", () => {
    const p = pairJudges(report(), report({ config: { judgePromptVersion: "lme-v3" } }));
    expect(p.status).toBe("cross");
    expect(p.reasons.join(" ")).toContain("lme-v3");
  });

  it("两侧都没记录 judgeModel 且都无判分行 → unknown 但无判分指标可污染", () => {
    const p = pairJudges(retrievalOnly(), retrievalOnly({ config: { tag: "ret2" } }));
    expect(p.status).toBe("unknown");
    expect(p.judgedMetricsPresent).toBe(false);
    expect(p.judgedComparable).toBe(false);
  });

  it("缺 judgeModel 却有判分行 → unknown 且 judgedMetricsPresent=true（身份不可证）", () => {
    const p = pairJudges(report({ config: { judgeModel: null } }), report());
    expect(p.status).toBe("unknown");
    expect(p.judgedMetricsPresent).toBe(true);
  });

  it("两侧都缺 judgeModel 但有判分行 → unknown 且 judgedMetricsPresent=true", () => {
    const p = pairJudges(report({ config: { judgeModel: null } }), report({ config: { judgeModel: null } }));
    expect(p.status).toBe("unknown");
    expect(p.judgedMetricsPresent).toBe(true);
  });
});

  it("单侧缺判分提示版本 → unknown（不让修复产物自证同一把尺子）", () => {
    const half = report({ config: { judgePromptVersion: undefined } });
    const p = pairJudges(half, report());
    expect(p.status).toBe("unknown");
    expect(p.judgedComparable).toBe(false);
    // 两侧都缺版本、只剩模型 → 仍按模型判 same（历史报告没有版本字段，不因此判死）
    const both = report({ config: { judgePromptVersion: undefined } });
    expect(pairJudges(both, both).status).toBe("same");
  });
describe("judge.mjs / decidePairing", () => {
  it("跨 judge 且无豁免 → 拒绝，非 0 退出码，并给出两条修复路径", () => {
    const d = decidePairing({
      baseReport: report({ config: { judgeModel: "scm-flash" } }),
      trialReport: report(),
    });
    expect(d.allowed).toBe(false);
    expect(d.exitCode).toBe(CROSS_JUDGE_EXIT_CODE);
    const text = d.lines.join("\n");
    expect(text).toContain("REFUSED");
    expect(text).toContain("--allow-cross-judge");
    // 修复路径必须是「对齐基线」或「重判旧报告」，而不是让人放弃比较
    expect(text).toContain("bench-baseline.mjs");
    expect(text).toContain("bench-rejudge.mjs");
  });

  it("跨 judge + --allow-cross-judge → 放行，但头部显式标注豁免", () => {
    const d = decidePairing({
      baseReport: report({ config: { judgeModel: "scm-flash" } }),
      trialReport: report(),
      allowCrossJudge: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.exitCode).toBe(0);
    expect(d.lines.join("\n")).toContain("--allow-cross-judge");
    expect(d.lines.join("\n")).toMatch(/跨\s*judge/);
  });

  it("缺 judgeModel 但有判分行 → 同样拒绝（身份不可证 = 不能算方法收益）", () => {
    const d = decidePairing({
      baseReport: report({ config: { judgeModel: null } }),
      trialReport: report(),
    });
    expect(d.allowed).toBe(false);
    expect(d.exitCode).toBe(CROSS_JUDGE_EXIT_CODE);
  });

  it("retrieval-only 档缺 judgeModel → 放行（判分器不参与这份比较）", () => {
    const d = decidePairing({ baseReport: retrievalOnly(), trialReport: retrievalOnly({ config: { tag: "ret2" } }) });
    expect(d.allowed).toBe(true);
    expect(d.exitCode).toBe(0);
    expect(d.lines.join("\n")).toContain("未记录");
  });

  it("同 judge → 放行、exit 0、头部写一致", () => {
    const d = decidePairing({ baseReport: report(), trialReport: report({ config: { tag: "deep105" } }) });
    expect(d.allowed).toBe(true);
    expect(d.exitCode).toBe(0);
    expect(d.lines.join("\n")).toContain("可配对");
  });
});

describe("judge.mjs / header + config diff + repair hint", () => {
  it("judgeHeaderLines 在两侧都已知时打印两侧模型与结论", () => {
    const lines = judgeHeaderLines(pairJudges(report(), report()), {});
    const text = lines.join("\n");
    expect(text).toContain("MiniMax-M3.1-Flash");
    expect(text).toContain("判分器");
  });

  it("configDiff 只报差异键，值原样给出（含实验旋钮）", () => {
    const a = report({ config: { fusion: { mode: "off" }, candidateK: 12, rerankOverride: null } });
    const b = report({ config: { fusion: { mode: "on" }, candidateK: 32, rerankOverride: null } });
    const diff = configDiff(a, b);
    expect(diff.map((d) => d.key)).toEqual(expect.arrayContaining(["fusion", "candidateK"]));
    expect(diff.map((d) => d.key)).not.toContain("rerankOverride");
    expect(diff.find((d) => d.key === "candidateK").a).toBe(12);
    expect(diff.find((d) => d.key === "candidateK").b).toBe(32);
  });

  it("configDiffLine 无差异时也要说明「无」，不能静默省略", () => {
    expect(configDiffLine([])).toContain("无差异");
    expect(configDiffLine(configDiff(report({ config: { candidateK: 12 } }), report({ config: { candidateK: 32 } })))).toContain("candidateK");
  });

  it("judgeRepairHint 给出可执行的 registry 解析与重判命令", () => {
    const lines = judgeRepairHint({ trialJudge: "MiniMax-M3.1-Flash" }).join("\n");
    expect(lines).toContain("bench-baseline.mjs resolve");
    expect(lines).toContain("bench-rejudge.mjs");
  });
});

describe("baseline.mjs / 登记表", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-baseline-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("登记表与被登记 manifest 同级", () => {
    expect(registryPathForManifest(path.join("a", "b", "lme-manifest.json"))).toBe(path.join("a", "b", "lme-baselines.json"));
  });

  it("entryFromReport 抽出 baselineTag/judgeModel/commit/口径与判对率（从 rows 重算，不信任 overall）", () => {
    const e = entryFromReport(report({ overall: { genAccuracy: 0.99, genJudged: 2 } }), { file: ".eval-data/bench/x.json" });
    expect(e.tag).toBe("b1off-mm");
    expect(e.judgeModel).toBe("MiniMax-M3.1-Flash");
    expect(e.repoCommit).toBe("deadbeefcafe1234");
    expect(e.manifest).toBe(MANIFEST);
    expect(e.n).toBe(2);
    expect(e.genJudged).toBe(2);
    expect(e.genCorrect).toBeCloseTo(0.5, 5);
    expect(e.turnCov5).toBeCloseTo(0.75, 5);
    expect(e.report).toBe(".eval-data/bench/x.json");
  });

  it("upsertEntry 同 tag 幂等覆盖、不同 tag 追加", () => {
    let reg = { version: BASELINE_REGISTRY_VERSION, baselines: [] };
    const e1 = entryFromReport(report(), { file: "a.json" });
    const r1 = upsertEntry(reg, e1);
    expect(r1.replaced).toBe(false);
    reg = r1.registry;
    expect(reg.baselines).toHaveLength(1);
    const e1b = entryFromReport(report({ config: { judgeModel: "scm-flash" } }), { file: "a2.json" });
    const r2 = upsertEntry(reg, e1b);
    expect(r2.replaced).toBe(true);
    expect(r2.registry.baselines).toHaveLength(1);
    expect(r2.registry.baselines[0].judgeModel).toBe("scm-flash");
    const r3 = upsertEntry(r2.registry, entryFromReport(report({ config: { tag: "b0base-mm" } }), { file: "b.json" }));
    expect(r3.registry.baselines).toHaveLength(2);
  });

  it("findBaseline 按 judge + manifest（只看 basename）+ dataset 解析同 judge 基线", () => {
    const reg = upsertEntry(
      { version: 1, baselines: [] },
      entryFromReport(report({ config: { tag: "b1off-mm" } }), { file: "a.json" }),
    ).registry;
    const hit = findBaseline(reg, { judgeModel: "MiniMax-M3.1-Flash", manifest: "C:/elsewhere/lme-manifest.json", dataset: "longmemeval" });
    expect(hit?.tag).toBe("b1off-mm");
    expect(findBaseline(reg, { judgeModel: "scm-flash", manifest: MANIFEST, dataset: "longmemeval" })).toBeNull();
  });

  it("judgeBaselineAudit：判分器变更时点名过期基线，而不是静默取一份不同 judge 的基线", () => {
    let reg = { version: 1, baselines: [] };
    reg = upsertEntry(
      reg,
      entryFromReport(report({ config: { tag: "b1off-scms", judgeModel: "scm-flash" } }), { file: "old.json" }),
    ).registry;
    const audit = judgeBaselineAudit(reg, report({ config: { judgeModel: "MiniMax-M3.1-Flash" } }));
    expect(audit.verdict).toBe("judge-changed");
    expect(audit.baseline).toBeNull();
    expect(audit.staleJudges).toEqual(["scm-flash"]);
  });

  it("judgeBaselineAudit：有同 judge 基线 → ok", () => {
    const reg = upsertEntry({ version: 1, baselines: [] }, entryFromReport(report(), { file: "a.json" })).registry;
    const audit = judgeBaselineAudit(reg, report({ config: { tag: "deep105" } }));
    expect(audit.verdict).toBe("ok");
    expect(audit.baseline?.tag).toBe("b1off-mm");
  });

  it("loadRegistry 缺失文件返回空登记表；save/load 往返不丢字段", () => {
    const p = path.join(tmp, "reg.json");
    expect(loadRegistry(p).baselines).toEqual([]);
    const reg = upsertEntry(loadRegistry(p), entryFromReport(report(), { file: "a.json" })).registry;
    saveRegistry(p, reg);
    expect(loadRegistry(p).baselines[0].judgeModel).toBe("MiniMax-M3.1-Flash");
    expect(loadRegistry(p).version).toBe(BASELINE_REGISTRY_VERSION);
  });

  it("summarizeRegistryLines 输出 markdown 表，含 judge 列", () => {
    const reg = upsertEntry({ version: 1, baselines: [] }, entryFromReport(report(), { file: "a.json" })).registry;
    const text = summarizeRegistryLines(reg).join("\n");
    expect(text).toContain("| 基线 |");
    expect(text).toContain("MiniMax-M3.1-Flash");
    expect(text).toContain("b1off-mm");
  });
});

describe("rejudge.mjs / 旧报告按当前 judge 重判", () => {
  it("answersOf 优先 answerFinal（B1 档的抽取答案），退化到 answer", () => {
    expect(answersOf({ answer: "raw", answerFinal: "final" })).toBe("final");
    expect(answersOf({ answer: "raw" })).toBe("raw");
    expect(answersOf({})).toBe("");
  });

  it("regradeReport 用旧答案重判：更新判分字段、写入 judge 身份与来源溯踪、重算总体", async () => {
    const src = report({ config: { judgeModel: "scm-flash" } });
    const fakeLlm = {
      info: { model: "MiniMax-M3.1-Flash", baseUrlHost: "api.minimax.cn", apiKeySource: "yaml" },
      json: async () => ({ correct: true, refused: false, reason: "重判：一致" }),
    };
    const out = await regradeReport({ report: src, llm: fakeLlm, buildJudgePrompt: () => "prompt" });
    expect(out.stats.regraded).toBe(2);
    expect(out.report.config.judgeModel).toBe("MiniMax-M3.1-Flash");
    expect(out.report.config.rejudgedFrom.judgeModel).toBe("scm-flash");
    expect(out.report.config.rejudgedFrom.judgePromptVersion).toBe("lme-v2");
    expect(out.report.rows.every((r) => r.genCorrect === 1 && r.judgeReason === "重判：一致")).toBe(true);
    expect(out.report.overall.genAccuracy).toBe(1);
  });

  it("regradeReport 不把「没有答案」误判为错：跳过并计入 skipped", async () => {
    const src = report({
      rows: [
        { caseId: "c1", questionType: "single-session-user", question: "q1", gold: "g1", answer: "", genCorrect: 0, refused: 1 },
        { caseId: "c2", questionType: "multi-session", question: "q2", gold: "g2", answer: "a2", genCorrect: 0, refused: 1 },
      ],
    });
    const fakeLlm = { info: { model: "MiniMax-M3.1-Flash" }, json: async () => ({ correct: true, refused: false, reason: "ok" }) };
    const out = await regradeReport({ report: src, llm: fakeLlm, buildJudgePrompt: () => "prompt" });
    expect(out.stats.regraded).toBe(1);
    expect(out.stats.skipped).toBe(1);
    expect(out.report.rows[0].genCorrect).toBe(0);
    expect(out.report.rows[0].rejudgeSkipped).toBe("no-answer");
  });

  it("regradeReport 的 limit 只重判前 N 条判分题（省钱验证用）", async () => {
    const fakeLlm = { info: { model: "MiniMax-M3.1-Flash" }, json: async () => ({ correct: true, refused: false, reason: "ok" }) };
    const out = await regradeReport({ report: report(), llm: fakeLlm, buildJudgePrompt: () => "prompt", limit: 1 });
    expect(out.stats.regraded).toBe(1);
    expect(out.stats.remaining).toBe(1);
  });

  it("regradeReport 写当前判分提示版本", async () => {
    const src = report({ config: { judgeModel: "scm-flash", judgePromptVersion: "lme-v1" } });
    const fakeLlm = { info: { model: "MiniMax-M3.1-Flash" }, json: async () => ({ correct: true, refused: false }) };
    const noVersion = await regradeReport({ report: src, llm: fakeLlm, buildJudgePrompt: () => "p" });
    expect(noVersion.report.config.judgePromptVersion).toBe("lme-v1");
    const withVersion = await regradeReport({ report: src, llm: fakeLlm, buildJudgePrompt: () => "p", judgePromptVersion: "lme-v2" });
    expect(withVersion.report.config.judgePromptVersion).toBe("lme-v2");
    expect(withVersion.report.config.rejudgedFrom.judgePromptVersion).toBe("lme-v1");
  });
  it("regradeReport 保留原报告不可变（返回新对象，不原地改）", async () => {
    const src = report();
    const before = JSON.stringify(src);
    const fakeLlm = { info: { model: "MiniMax-M3.1-Flash" }, json: async () => ({ correct: false, refused: false, reason: "x" }) };
    await regradeReport({ report: src, llm: fakeLlm, buildJudgePrompt: () => "prompt" });
    expect(JSON.stringify(src)).toBe(before);
  });
});
