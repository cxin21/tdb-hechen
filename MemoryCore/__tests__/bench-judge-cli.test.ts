/**
 * #140 三工具的 CLI 级验收（对应票面「人为拿 scm-flash 报告配 MiniMax 报告 → 三个工具都拒绝/警示」）：
 *  - bench-compare / bench-gates / bench-ranking 跨 judge 时非 0 退出并给出修复路径；
 *  - 同 judge 正常输出；--allow-cross-judge 显式豁免并标注；
 *  - bench-gates --base auto 从登记表解析同 judge 基线，判分器变更时拒判；
 *  - bench-ranking 的「判分模型」列取 judgeModel（历史 bug：取的是 answerModel）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[]) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e?.status === "number" ? e.status : -1, out: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
  }
}

function mkReport(judgeModel: string | null, tag: string, opts: { answerModel?: string; manifest?: string } = {}) {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    caseId: `c${i}`,
    questionType: i % 2 ? "single-session-user" : "multi-session",
    question: `q${i}`,
    gold: `g${i}`,
    answer: `a${i}`,
    latencyMs: 100 + i,
    "turnCov@5": i % 3 === 0 ? 0.5 : 1,
    "sessionCov@5": 1,
    "mrr@5": 1,
    genCorrect: i % 2,
    refused: 0,
  }));
  return {
    generatedAt: "2026-10-27T00:00:00.000Z",
    repoCommit: "abc1234def",
    dataset: { name: "longmemeval" },
    config: {
      tag,
      manifest: opts.manifest ?? path.join(os.tmpdir(), "lme-manifest.json"),
      judgeModel,
      judgePromptVersion: "lme-v2",
      judgeHost: "judge.example",
      answerModel: opts.answerModel ?? "answer-x",
    },
    rows,
    overall: { genAccuracy: 0.5, genJudged: rows.length },
  };
}

describe("bench CLI 判分器门禁", () => {
  let tmp: string;
  let mm: string;
  let scm: string;
  let manifest: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-judge-cli-"));
    manifest = path.join(tmp, "lme-manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, caseIds: [] }));
    mm = path.join(tmp, "mm.json");
    scm = path.join(tmp, "scm.json");
    fs.writeFileSync(mm, JSON.stringify(mkReport("MiniMax-M3.1-Flash", "b1off-mm", { manifest })));
    fs.writeFileSync(scm, JSON.stringify(mkReport("scm-flash", "b1-off", { manifest })));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("compare: 跨 judge → exit 3 + REFUSED + 修复路径；同 judge → exit 0", () => {
    const cross = run(["scripts/bench-compare.mjs", scm, mm]);
    expect(cross.code).toBe(3);
    expect(cross.out).toContain("REFUSED");
    expect(cross.out).toContain("bench-baseline.mjs");
    expect(cross.out).toContain("bench-rejudge.mjs");

    const same = run(["scripts/bench-compare.mjs", mm, mm]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("一致");
  });

  it("compare --allow-cross-judge: 放行但显式标注豁免", () => {
    const r = run(["scripts/bench-compare.mjs", scm, mm, "--allow-cross-judge"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--allow-cross-judge");
    expect(r.out).toContain("参考");
  });

  it("gates: 跨 judge → exit 3（拒判）；同 judge → 正常判定（非 3）", () => {
    const cross = run(["--import", "tsx", "scripts/bench-gates.mjs", scm, mm]);
    expect(cross.code).toBe(3);
    expect(cross.out).toContain("拒绝判定");

    const same = run(["--import", "tsx", "scripts/bench-gates.mjs", mm, mm]);
    expect(same.code).not.toBe(3);
    expect(same.out).toContain("判分器");
  });

  it("gates --base auto: 从登记表取同 judge 基线；判分器变更 → exit 3", () => {
    const regPath = path.join(tmp, "lme-baselines.json");
    fs.writeFileSync(
      regPath,
      JSON.stringify({
        version: 1,
        baselines: [
          { tag: "b1off-mm", judgeModel: "MiniMax-M3.1-Flash", manifest, dataset: "longmemeval", report: mm, n: 12, genJudged: 12, genCorrect: 0.5, gateBaseline: true },
          { tag: "b1-off", judgeModel: "scm-flash", manifest, dataset: "longmemeval", report: scm, n: 12, genJudged: 12, genCorrect: 0.5 },
        ],
      }),
    );
    const ok = run(["--import", "tsx", "scripts/bench-gates.mjs", "auto", mm]);
    expect(ok.code).not.toBe(3);
    expect(ok.out).toContain("基线来源: 登记表 b1off-mm");

    // 只有 scm-flash 基线时，拿 MiniMax 报告去 auto = 判分器变更 → 必须拒判
    fs.writeFileSync(
      regPath,
      JSON.stringify({ version: 1, baselines: [{ tag: "b1-off", judgeModel: "scm-flash", manifest, dataset: "longmemeval", report: scm }] }),
    );
    const changed = run(["--import", "tsx", "scripts/bench-gates.mjs", "auto", mm]);
    expect(changed.code).toBe(3);
    expect(changed.out).toContain("判分器已换成");
  });

  it("ranking: 跨 judge 档位判对列不出数 + exit 3；--allow-cross-judge 标 *", () => {
    const cross = run(["scripts/bench-ranking.mjs", "--base", mm, scm]);
    expect(cross.code).toBe(3);
    expect(cross.out).toContain("跨 judge");
    expect(cross.out).toContain("—（跨 judge）");

    const allow = run(["scripts/bench-ranking.mjs", "--base", mm, scm, "--allow-cross-judge"]);
    expect(allow.code).toBe(0);
    expect(allow.out).toContain("*");
  });

  it("ranking: 「判分模型」列取 judgeModel，而不是 answerModel", () => {
    const r = run(["scripts/bench-ranking.mjs", "--base", mm, mm]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("MiniMax-M3.1-Flash");
    expect(r.out).not.toContain("| answer-x |");
  });

  /** 变体：判对全开/全关，用于验证「被抑制的判对数不参与排名」。 */
  function mkVariant(judgeModel: string, tag: string, correct: number, manifest: string) {
    const r = mkReport(judgeModel, tag, { manifest });
    r.rows = r.rows.map((row) => ({ ...row, genCorrect: correct }));
    return r;
  }

  it("gates: 只给一份报告 → 默认取登记表的同 judge 基线（不用手写 auto）", () => {
    const regPath = path.join(tmp, "lme-baselines.json");
    fs.writeFileSync(
      regPath,
      JSON.stringify({
        version: 1,
        baselines: [
          { tag: "b1off-mm", judgeModel: "MiniMax-M3.1-Flash", manifest, dataset: "longmemeval", report: mm, n: 12, genJudged: 12, genCorrect: 0.5, gateBaseline: true },
        ],
      }),
    );
    const r = run(["--import", "tsx", "scripts/bench-gates.mjs", mm]);
    expect(r.code).not.toBe(2);
    expect(r.out).toContain("基线来源: 登记表 b1off-mm");
  });

  it("ranking: 跨 judge 档即使判对更高也排在合法同 judge 档之后", () => {
    const scmHigh = path.join(tmp, "scm-high.json");
    const mmLow = path.join(tmp, "mm-low.json");
    fs.writeFileSync(scmHigh, JSON.stringify(mkVariant("scm-flash", "cross-highacc", 1, manifest)));
    fs.writeFileSync(mmLow, JSON.stringify(mkVariant("MiniMax-M3.1-Flash", "same-lowacc", 0, manifest)));
    const r = run(["scripts/bench-ranking.mjs", "--base", mm, scmHigh, mmLow]);
    expect(r.code).toBe(3); // 表内含跨 judge 档 → 整体拒判（门禁不认这份排名）
    // 用表格行定位（档位名在头部声明行里也会出现，不能用裸名字定位）
    const iSame = r.out.indexOf("| same-lowacc |");
    const iCross = r.out.indexOf("| cross-highacc |");
    expect(iSame).toBeGreaterThan(0);
    expect(iCross).toBeGreaterThan(iSame); // 跨 judge 档不得靠被抑制的判对数抢占名次
  });

  it("bench-baseline stale: 判分器换了 → 列出受影响基线 + 可执行重判命令（exit 3）", () => {
    const reg = path.join(tmp, "lme-baselines.json");
    const regOut = run(["scripts/bench-baseline.mjs", "register", scm, "--registry", reg, "--gate-baseline"]);
    expect(regOut.code).toBe(0);
    const stale = run(["scripts/bench-baseline.mjs", "stale", "--judge", "MiniMax-M3.1-Flash", "--manifest", manifest, "--registry", reg]);
    expect(stale.code).toBe(3);
    expect(stale.out).toContain("STALE: 1/1");
    expect(stale.out).toContain("bench-rejudge.mjs");
    const ok = run(["scripts/bench-baseline.mjs", "stale", "--judge", "scm-flash", "--manifest", manifest, "--registry", reg]);
    expect(ok.code).toBe(0);
    const cmds = run(["scripts/bench-baseline.mjs", "stale", "--judge", "MiniMax-M3.1-Flash", "--manifest", manifest, "--registry", reg, "--commands"]);
    expect(cmds.code).toBe(3);
    expect(cmds.out.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
  it("fit-fusion-weights: 两侧都无判分行（retrieval-only 档）→ 放行并按 E2 算检索 Δ", () => {
    const retrieval = (tag: string, cov: number) => {
      const rep = mkReport(null, tag, { manifest });
      rep.rows = rep.rows.map((row) => {
        const next: Record<string, unknown> = { ...row, "turnCov@5": cov };
        delete next.genCorrect;
        delete next.refused;
        return next;
      });
      return rep;
    };
    const basePath = path.join(tmp, "retr-base.json");
    const armPath = path.join(tmp, "retr-arm.json");
    fs.writeFileSync(basePath, JSON.stringify(retrieval("retr-base", 0.5)));
    fs.writeFileSync(armPath, JSON.stringify(retrieval("retr-arm", 1)));
    const r = run(["scripts/fit-fusion-weights.mjs", "--base", basePath, "--arm", "arm=" + armPath]);
    expect(r.code).not.toBe(3);
    expect(r.out).toContain("检索档");
  });

  it("fit-fusion-weights: 跨 judge 不配对只并列展示 + exit 3；同 judge 配对；豁免标注参考", () => {
    const cross = run(["scripts/fit-fusion-weights.mjs", "--base", scm, "--arm", "trial=" + mm]);
    expect(cross.code).toBe(3);
    expect(cross.out).toContain("未配对：判分器与基线不一致");
    expect(cross.out).toContain("并列展示");
    expect(cross.out).toContain("bench-rejudge.mjs");

    const same = run(["scripts/fit-fusion-weights.mjs", "--base", mm, "--arm", "trial=" + mm]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("同 judge");
    expect(same.out).toContain("E2 门禁");

    const allow = run(["scripts/fit-fusion-weights.mjs", "--base", scm, "--arm", "trial=" + mm, "--allow-cross-judge"]);
    expect(allow.code).toBe(0);
    expect(allow.out).toContain("跨判分器参考值");
    expect(allow.out).toContain("门禁不认");
  });
});
