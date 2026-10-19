#!/usr/bin/env node
/**
 * R2（#66）行为级人格回归评测 · 主 CLI（生产实跑入口）。
 *
 * 用法:
 *   node --import tsx scripts/persona-eval/run-persona-eval.ts --config tdai-gateway.yaml \
 *        [--soul <file>] [--no-soul] [--subset smoke|full] [--drift 8] [--max-calls 90] \
 *        [--baseline <compare.json>] [--out <jsonl>] [--summary <json>] [--no-llm] [--limit N] [--timeout-ms 120000] \
 *        [--replay <fixtures/golden-samples.json>]
 *
 * 编排: parseConfig(yaml) → StandaloneLLMRunner（同 #62 run-behavior-judge 管线）→
 *       （可选）soul 注入 → selectProbes(subset) → CallBudget(--max-calls 硬帽) →
 *       runPersonaProbes 两跳（static node 内评 / semantic 单跳批量 judge）→
 *       （--drift）八轮自聊漂移（每轮重注入 soul）→ summarize →
 *       （--baseline）ADR-0003 D7 对比（红线 100% 硬门 / ε=max(3σ,P5)）→
 *       （--replay）golden replay（static 零成本回放）。
 * 退出码: 0=全 pass；1=存在真 fail（含 capHit 截断/golden mismatch）；2=LLM/配置不可用；
 *         3=网络/参数校验错（config 解析、CLI 参数、语料 schema）；4=baseline 回归。
 * --no-llm: 零成本确定性干跑（校验语料/golden static/基线格式；不调 LLM；漂移不跑）。
 * config llm.maxTokens=0（不限制）→ 两跳输出帽禁用（reasoning 模型思考即烧 token，1024 帽会截成空响应）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CallBudget,
  DIMENSIONS,
  DRIFT_ROUNDS_DEFAULT,
  compareWithBaseline,
  loadProbesFromDir,
  planCalls,
  replayGolden,
  runDriftSession,
  runPersonaProbes,
  selectProbes,
  summarizeByDimension,
  validateCorpus,
  type BaselineFile,
  type DriftSessionResult,
  type EvalSummary,
  type GoldenCase,
  type PersonaProbeResult,
  type Regression,
  type Scorecard,
  type Subset,
} from "./lib.js";
import type { JudgeRunnerLike } from "../../src/core/hooks/behavior-judge.js";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes("--" + name);
}

function numArg(name: string, fallback: number): number | string {
  const raw = argOf(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "--" + name + " 必须是非负有限数，得 " + JSON.stringify(raw);
  return Math.floor(n);
}

/** EvalSummary + 漂移结果 → Scorecard（baseline 对比输入；samples=逐探针维度加权分）。 */
function buildScorecard(results: readonly PersonaProbeResult[], summary: EvalSummary, drift?: DriftSessionResult): Scorecard {
  const dimensionScores: Scorecard["dimensionScores"] = {};
  for (const d of DIMENSIONS) {
    const probeResults = results.filter((r) => r.dimension === d && !r.skipped);
    if (probeResults.length === 0) continue;
    const samples = probeResults.map((r) => {
      const tw = r.results.reduce((s, a) => s + a.weight, 0);
      return tw > 0 ? r.results.reduce((s, a) => s + a.weight * (a.pass ? 1 : 0), 0) / tw : 0;
    });
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    dimensionScores[d] = { mean, samples };
  }
  const redlinePassRate = summary.redline.total > 0 ? summary.redline.passed / summary.redline.total : 1;
  const scorecard: Scorecard = { dimensionScores, redlinePassRate };
  if (drift) {
    scorecard.drift = { curve: drift.curve, round8Pass: drift.round8Pass, monotone: drift.monotone, redlineViolations: drift.redlineViolations };
  }
  return scorecard;
}

function baselineShapeErrors(baseline: unknown): string[] {
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    return ["baseline JSON 必须是 object"];
  }
  const errors: string[] = [];
  const b = baseline as Partial<BaselineFile>;
  if (b.dimensionScores === undefined || typeof b.dimensionScores !== "object" || b.dimensionScores === null) {
    errors.push("baseline.dimensionScores 必须是 object（维度 → {mean, samples?}）");
  } else {
    for (const [k, v] of Object.entries(b.dimensionScores)) {
      if (!(DIMENSIONS as readonly string[]).includes(k)) {
        errors.push("baseline.dimensionScores 含未知维度 " + k + "（合法: " + DIMENSIONS.join("/") + "）");
      }
      const vv = v as { mean?: unknown } | undefined;
      if (!vv || typeof vv.mean !== "number") errors.push("baseline.dimensionScores." + k + ".mean 必须是 number");
    }
  }
  if (typeof b.redlinePassRate !== "number" || b.redlinePassRate < 0 || b.redlinePassRate > 1) {
    errors.push("baseline.redlinePassRate 必须是 [0,1] number");
  }
  if (b.thresholds !== undefined && (typeof b.thresholds !== "object" || b.thresholds === null)) {
    errors.push("baseline.thresholds 必须是 object");
  }
  if (b.drift !== undefined) {
    const d = b.drift as Partial<{ curve: unknown; round8Pass: unknown; monotone: unknown }>;
    if (!Array.isArray(d.curve)) errors.push("baseline.drift.curve 必须是数组");
    if (typeof d.round8Pass !== "boolean") errors.push("baseline.drift.round8Pass 必须是 boolean");
    if (typeof d.monotone !== "boolean") errors.push("baseline.drift.monotone 必须是 boolean");
  }
  return errors;
}

/** 拉取网关 soul 渲染结果（node:http 原生请求——undici fetch 对本机网关存在
 *  Authorization 头丢失/变形问题，见 2026-10-19 R1 E2E 教训；网关 Bearer 同 key
 *  走 node:http 可通过）。租户可经 TDAI_PERSONA_SOUL_TEAM_ID / USER_ID / AGENT_ID
 *  指定（introspect 的租户来自 body 而非隔离头；缺省 default 租户）。地址可用
 *  TDAI_GATEWAY_HOST / TDAI_GATEWAY_PORT 覆盖（缺省 127.0.0.1:8420）。 */
async function fetchSoulIntrospect(): Promise<string> {
  const body = JSON.stringify({
    ...(process.env.TDAI_PERSONA_SOUL_TEAM_ID ? { teamId: process.env.TDAI_PERSONA_SOUL_TEAM_ID } : {}),
    ...(process.env.TDAI_PERSONA_SOUL_USER_ID ? { userId: process.env.TDAI_PERSONA_SOUL_USER_ID } : {}),
    ...(process.env.TDAI_PERSONA_SOUL_AGENT_ID ? { agentId: process.env.TDAI_PERSONA_SOUL_AGENT_ID } : {}),
  });
  const host = process.env.TDAI_GATEWAY_HOST ?? "127.0.0.1";
  const port = Number(process.env.TDAI_GATEWAY_PORT ?? 8420);
  const rendered = await new Promise<string | undefined>((resolve, reject) => {
    const req = http.request(
      { host, port, path: "/v3/soul/introspect", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
          authorization: "Bearer " + (process.env.TDAI_GATEWAY_API_KEY ?? "") } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200) { reject(new Error("HTTP " + res.statusCode)); return; }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: { rendered?: string } };
            resolve(parsed.data?.rendered);
          } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
        });
      });
    req.setTimeout(10_000, () => req.destroy(new Error("introspect timeout(10s)")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return rendered ?? "";
}

async function main(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = argOf("config") ?? "tdai-gateway.yaml";
  const outPath = argOf("out");
  const summaryPath = argOf("summary");
  const soulPath = argOf("soul");
  const baselinePath = argOf("baseline");
  const replayPath = argOf("replay");
  const noSoul = hasFlag("no-soul");
  const noLlm = hasFlag("no-llm");
  const subsetRaw = argOf("subset") ?? "full";
  if (subsetRaw !== "smoke" && subsetRaw !== "full") {
    console.error("[persona-eval] --subset 只接受 smoke|full，得 " + JSON.stringify(subsetRaw));
    return 3;
  }
  const subset: Subset = subsetRaw;
  const limitRaw = argOf("limit");
  const limit = limitRaw != null ? Math.max(1, Math.floor(Number(limitRaw) || Number.MAX_SAFE_INTEGER)) : undefined;
  const driftArg = numArg("drift", subset === "full" ? DRIFT_ROUNDS_DEFAULT : 0);
  if (typeof driftArg === "string") { console.error("[persona-eval] " + driftArg); return 3; }
  const driftRounds = driftArg;
  const maxCallsArg = numArg("max-calls", 90);
  if (typeof maxCallsArg === "string") { console.error("[persona-eval] " + maxCallsArg); return 3; }
  const maxCalls = Math.max(1, maxCallsArg);
  const callTimeoutMs = Math.max(1000, numArg("timeout-ms", 120_000));

  // ── 语料加载 + schema 校验（--no-llm 与实跑共用；schema 违规恒退出码 3）──
  const probesDir = resolve(here, "probes");
  const { probes: allProbes } = loadProbesFromDir(probesDir);
  const { issues } = validateCorpus(allProbes);
  if (issues.length > 0) {
    for (const i of issues) console.error("[persona-eval] CORPUS ISSUE " + i);
    console.error("[persona-eval] 语料校验 fail（" + issues.length + " issue）— exit 3（先跑 validate-corpus.ts 修语料）");
    return 3;
  }

  // ── baseline 读取与格式校验 ──
  let baseline: BaselineFile | undefined;
  if (baselinePath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
      const shapeErrors = baselineShapeErrors(parsed);
      if (shapeErrors.length > 0) {
        for (const e of shapeErrors) console.error("[persona-eval] BASELINE FORMAT " + e);
        return 3;
      }
      baseline = parsed as BaselineFile;
    } catch (err) {
      console.error("[persona-eval] baseline 读取/解析失败:", err instanceof Error ? err.message : String(err));
      return 3;
    }
  }

  // ── golden 读取（--replay）──
  let golden: GoldenCase[] | undefined;
  if (replayPath) {
    try {
      const parsed = JSON.parse(readFileSync(replayPath, "utf8")) as { cases?: unknown };
      if (!Array.isArray(parsed.cases)) {
        console.error("[persona-eval] --replay 文件缺 cases 数组");
        return 3;
      }
      golden = parsed.cases as GoldenCase[];
    } catch (err) {
      console.error("[persona-eval] golden 读取/解析失败:", err instanceof Error ? err.message : String(err));
      return 3;
    }
  }

  // ── --no-llm 零成本干跑：schema 已过 + golden static 回放 + 计划输出 ──
  if (noLlm) {
    const { probes, truncatedBySubset } = selectProbes(allProbes, subset, limit);
    const planned = planCalls(probes, driftRounds);
    console.error("[persona-eval] no-llm dry run: probes=" + probes.length + "/" + allProbes.length +
      " subset=" + subset + " plannedCalls=" + planned + " maxCalls=" + maxCalls +
      " drift=" + driftRounds + (truncatedBySubset ? " (smoke truncated>10)" : ""));
    let goldenFail = false;
    if (golden) {
      const budget = new CallBudget(maxCalls);
      const replay = await replayGolden(golden, allProbes, undefined, budget);
      for (const r of replay) {
        if (r.unknownAssertionIds.length > 0) {
          console.error("[persona-eval] GOLDEN unknown assertionIds " + r.probeId + ": " + r.unknownAssertionIds.join(","));
          goldenFail = true;
        }
        if (r.mismatches.length > 0) {
          for (const m of r.mismatches) {
            console.error("[persona-eval] GOLDEN MISMATCH " + r.probeId + "#" + r.caseIndex + " " + m.assertionId + " expected=" + m.expected + " actual=" + m.actual);
          }
          goldenFail = true;
        }
      }
      console.error("[persona-eval] golden replay(static only): cases=" + replay.length + " " + (goldenFail ? "FAIL" : "PASS"));
    }
    if (summaryPath) {
      writeFileSync(summaryPath, JSON.stringify({
        schemaVersion: 1, ts: new Date().toISOString(), mode: "no-llm", subset, driftRounds, maxCalls,
        plannedCalls: planned, capHit: false, probes: probes.length, totalProbes: allProbes.length,
        goldenReplay: golden ? { cases: golden.length, fail: goldenFail } : undefined,
        verdict: goldenFail ? "fail" : "pass",
      }, null, 2) + "\n", "utf8");
    }
    return goldenFail ? 1 : 0;
  }

  // ── 配置 → LLM runner（与 #62 run-behavior-judge 同构）──
  let rawConfig: Record<string, unknown>;
  try {
    const yamlMod = (await import("yaml")) as { parse?: (s: string) => unknown; default?: { parse?: (s: string) => unknown } };
    const parseYaml = yamlMod.parse ?? yamlMod.default?.parse;
    if (!parseYaml) throw new Error("yaml package has no parse export");
    rawConfig = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error("[persona-eval] config read/parse failed:", err instanceof Error ? err.message : String(err));
    return 3;
  }
  const cfgMod = (await import("../../src/config.js")) as { parseConfig: (raw: Record<string, unknown>) => { llm?: unknown } };
  const cfg = cfgMod.parseConfig(rawConfig);
  let runner: JudgeRunnerLike | undefined = undefined;
  let unlimitedOutput = false;
  try {
    const { StandaloneLLMRunner } = await import("../../src/adapters/standalone/llm-runner.js");
    const { resolveStandaloneLlmForRuntime } = await import("../../src/adapters/standalone/llm-provider-resolver.js");
    const llm = cfg.llm as { baseUrl?: string; apiKey?: string } | undefined;
    if (llm?.baseUrl && llm?.apiKey) {
      const effective = resolveStandaloneLlmForRuntime(llm as never, "default");
      runner = new StandaloneLLMRunner({
        config: {
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          model: effective.model ?? "default",
          maxTokens: effective.maxTokens,
          timeoutMs: effective.timeoutMs ?? 120_000,
          stream: effective.stream ?? false,
        },
      }) as unknown as JudgeRunnerLike;
    unlimitedOutput = effective.maxTokens === 0;
    }
  } catch (err) {
    console.error("[persona-eval] llm runner unavailable:", err instanceof Error ? err.message : String(err));
  }
  if (!runner) {
    console.error("[persona-eval] no llm runner (check memory.llm.baseUrl/apiKey) — exit 2");
    return 2;
  }

  // ── soul 注入（同 #62：--soul 文件 / gateway introspect / --no-soul 裸基线）──
  let soulRendered: string | undefined;
  if (!noSoul) {
    if (soulPath) {
      soulRendered = readFileSync(soulPath, "utf8");
    } else {
      try {
        soulRendered = await fetchSoulIntrospect();
      } catch (err) {
        // introspect 不可用 → 裸基线对照；失败原因要可见（ bare 会让 soul-dependent 探针全 skip）
        console.error("[persona-eval] soul introspect failed: " + (err instanceof Error ? err.message : String(err)));
      }
      if (!soulRendered) console.error("[persona-eval] soul introspect unavailable — running bare baseline");
    }
  }

  // ── 选样 + 预算 + 预演 ──
  const { probes, truncatedBySubset } = selectProbes(allProbes, subset, limit);
  const budget = new CallBudget(maxCalls);
  const planned = planCalls(probes, driftRounds);
  console.error("[persona-eval] probes=" + probes.length + "/" + allProbes.length + " subset=" + subset +
    " plannedCalls=" + planned + " maxCalls=" + maxCalls + " drift=" + driftRounds +
    " soul=" + (soulRendered ? "injected(" + soulRendered.length + " chars)" : "bare") +
    " timeoutMs=" + callTimeoutMs +
    (truncatedBySubset ? " (smoke truncated>10)" : ""));
  if (planned > maxCalls) {
    console.error("[persona-eval] WARN: 计划调用 " + planned + " > 硬帽 " + maxCalls + "，超出部分将 skip（宁缺毋滥不伪造）");
  }

  // ── 探针两跳 + 汇总 ──
  const hopCaps = unlimitedOutput ? { agentMaxTokens: 0, judgeMaxTokens: 0 } : {};
  const results = await runPersonaProbes(probes, runner, { soulRendered, budget, timeoutMs: callTimeoutMs, ...hopCaps });
  const summary = summarizeByDimension(results);

  // ── 漂移（每轮重注入 soul；redline forbid pattern 零成本扫描）──
  let drift: DriftSessionResult | undefined;
  if (driftRounds > 0) {
    const redlinePatterns = allProbes.flatMap((p) =>
      p.assertions
        .filter((a) => a.kind === "static" && a.severity === "redline" && a.expect === "forbid" && a.regex)
        .map((a) => ({ id: a.id, regex: a.regex! })),
    );
    const topics = allProbes.filter((p) => p.driftEligible).map((p) => p.title);
    drift = await runDriftSession({ runner, soulRendered, rounds: driftRounds, budget, topics, redlinePatterns, timeoutMs: callTimeoutMs, ...hopCaps });
  }

  // ── golden replay（可选；共享预算，static 零成本）──
  let goldenReplay: Awaited<ReturnType<typeof replayGolden>> | undefined;
  let goldenFail = false;
  if (golden) {
    goldenReplay = await replayGolden(golden, allProbes, runner, budget, callTimeoutMs, unlimitedOutput ? 0 : undefined);
    for (const r of goldenReplay) {
      if (r.unknownAssertionIds.length > 0 || r.mismatches.length > 0) goldenFail = true;
    }
  }

  // ── 汇总 JSONL 输出 ──
  const lines: string[] = [];
  for (const r of results) lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "probe", ...r }));
  if (drift) for (const rd of drift.rounds) lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "drift-round", ...rd }));
  if (goldenReplay) for (const g of goldenReplay) lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "golden-replay", ...g }));
  if (outPath) {
    writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.error("[persona-eval] report written: " + outPath);
  } else {
    console.log(lines.join("\n"));
  }

  // ── Scorecard + baseline 对比 ──
  const scorecard = buildScorecard(results, summary, drift);
  let regressions: Regression[] = [];
  if (baseline) {
    regressions = compareWithBaseline(scorecard, baseline);
    for (const reg of regressions) console.error("[persona-eval] REGRESSION [" + reg.type + (reg.dimension ? "/" + reg.dimension : "") + "] " + reg.detail);
  }

  // ── 退出码判定 ──
  const realFails = results.filter((r) => !r.skipped && r.results.length > 0 && r.results.some((a) => !a.pass));
  const driftFail = drift !== undefined && (!drift.round8Pass || !drift.monotone || drift.redlineViolations.length > 0);
  const capHit = budget.capHit;
  for (const f of realFails) {
    const bad = f.results.filter((a) => !a.pass).map((a) => a.id + "(" + a.reason.slice(0, 120) + ")");
    console.error("[persona-eval] FAIL " + f.id + ": " + bad.join("; "));
  }
  if (capHit) console.error("[persona-eval] CAP HIT: calls used " + budget.used + "/" + budget.limit + " — 结果被截断，exit 1（summary.capHit=true）");

  let exitCode: number;
  if (regressions.length > 0) exitCode = 4;
  else if (realFails.length > 0 || driftFail || goldenFail || capHit) exitCode = 1;
  else exitCode = 0;

  if (summaryPath) {
    const summaryOut = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      mode: "live",
      subset,
      limit: limit ?? null,
      driftRounds,
      maxCalls,
      callsUsed: budget.used,
      plannedCalls: planned,
      capHit,
      soulInjected: soulRendered != null,
      probes: { selected: probes.length, evaluated: summary.evaluatedProbes, skipped: summary.skippedProbes },
      summary,
      scorecard,
      drift: drift ? { curve: drift.curve, round8Pass: drift.round8Pass, monotone: drift.monotone, redlineViolations: drift.redlineViolations, truncated: drift.truncated } : undefined,
      baseline: baseline ? { path: baselinePath, regressions } : undefined,
      golden: goldenReplay ? { path: replayPath, cases: goldenReplay.length, fail: goldenFail } : undefined,
      verdict: exitCode === 0 ? "pass" : "fail",
      exitCode,
    };
    writeFileSync(summaryPath, JSON.stringify(summaryOut, null, 2) + "\n", "utf8");
    console.error("[persona-eval] summary written: " + summaryPath);
  }
  console.error("[persona-eval] verdict=" + (exitCode === 0 ? "PASS" : "FAIL(" + exitCode + ")") +
    " probes=" + summary.evaluatedProbes + "/" + probes.length + " redline=" + summary.redline.passed + "/" + summary.redline.total +
    (drift ? " driftCurve=[" + drift.curve.join(",") + "]" : "") +
    " calls=" + budget.used + "/" + budget.limit);
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("[persona-eval] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(3);
});