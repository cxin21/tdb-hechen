#!/usr/bin/env node
/**
 * 判分器对齐：用旧报告里已存的答案，按**当前**判分器重判（issue #140 的治本路径）。
 *
 * 为什么需要：判分器一换，历史报告的 genCorrect 与新报告就不是同一把尺子量的。
 * 重跑基线（召回+生成+判分）很贵，但报告行本来就存了 answer / answerFinal 与 gold，
 * 所以可以只花 N 次判分调用把旧数据搬到新尺子下——这不是「关掉门禁」，是让跨 judge 的
 * 历史对比重新可比。
 *
 * 用法：
 *   node --import tsx scripts/bench-rejudge.mjs <report.json> [--out <path>] [--limit N]
 *       [--dry-run] [--register [--gate-baseline]] [--registry <path>] [--config <gateway.yaml>]
 *
 * 退出码：0 = 成功（含 dry-run）；2 = 参数/读文件/凭据错误。
 */
import fs from "node:fs";
import path from "node:path";

import { readLlmCredential } from "./lib/read-llm-credential.ts";
import { makeLlm, buildJudgePrompt } from "./lib/bench/llm.mjs";
import { judgeIdentity } from "./lib/bench/judge.mjs";
import { answersOf, regradeReport } from "./lib/bench/rejudge.mjs";
import {
  DEFAULT_MANIFEST,
  entryFromReport,
  markGateBaseline,
  registryPathForManifest,
  loadRegistry,
  sameSlot,
  saveRegistry,
  upsertEntry,
} from "./lib/bench/baseline.mjs";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return undefined;
  return argv[i + 1];
}
const BOOL = ["--dry-run", "--register", "--gate-baseline"];
const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL.includes(argv[i - 1])));
const src = files[0];
if (!src) {
  console.error("用法: node --import tsx scripts/bench-rejudge.mjs <report.json> [--out <path>] [--limit N] [--dry-run] [--register]");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(src, "utf8"));
} catch (e) {
  console.error("读取报告失败: " + src + "（" + (e?.message ?? e) + "）");
  process.exit(2);
}

const from = judgeIdentity(report);
const rows = Array.isArray(report.rows) ? report.rows : [];
const judged = rows.filter((r) => typeof r?.genCorrect === "number");
const withAnswer = rows.filter((r) => answersOf(r)).length;
const limitArg = arg("limit");
const limit = limitArg === undefined ? Infinity : Number(limitArg);

const cred = readLlmCredential(arg("config") ? { yamlPath: arg("config") } : {});
if (!cred) {
  console.error("读不到 LLM 凭据（config-override.json 的 llm 段 / tdai-gateway.yaml / TDAI_LLM_* env 均不齐）");
  process.exit(2);
}

const header = [
  "源报告: " + src,
  "原判分器: " + from.label + (from.promptVersion ? "（" + from.promptVersion + "）" : ""),
  "当前判分器: " + cred.model + "（" + new URL(cred.baseUrl).host + "，key 来源 " + cred.apiKeySource + "）",
  "题数: " + rows.length + "（有判分行 " + judged.length + "，可重判 " + withAnswer + "）",
].join("\n");
console.log(header);

if (argv.includes("--dry-run")) {
  const n = limit === Infinity ? withAnswer : Math.min(limit, withAnswer);
  console.log("dry-run: 将重判 " + n + " 条（每条 1 次判分调用，不重跑召回/生成）。");
  process.exit(0);
}

const llm = makeLlm(cred);
const { report: out, stats } = await regradeReport({
  report,
  llm,
  buildJudgePrompt,
  limit,
  onProgress: ({ done, total }) => {
    if (done % 20 === 0 || done === total) process.stderr.write("  重判 " + done + "/" + total + "\n");
  },
});

const before = judged.length ? judged.filter((r) => r.genCorrect === 1).length / judged.length : null;
const afterRows = out.rows.filter((r) => typeof r.genCorrect === "number");
const afterAcc = afterRows.length ? afterRows.filter((r) => r.genCorrect === 1).length / afterRows.length : null;
const pctS = (v) => (v === null ? "-" : (v * 100).toFixed(1) + "%");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = String(cred.model).replace(/[^\w.-]+/g, "-");
const outPath =
  arg("out") ?? path.join(path.dirname(src), path.basename(src, ".json") + "-rejudged-" + slug + "-" + stamp + ".json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log("重判完成: regraded=" + stats.regraded + " skipped=" + stats.skipped + " remaining=" + stats.remaining);
console.log("判对: 原 " + pctS(before) + "（" + from.label + "）→ 新 " + pctS(afterAcc) + "（" + cred.model + "）");
console.log("输出: " + outPath);

if (argv.includes("--register")) {
  const manifest = out.config?.manifest ?? DEFAULT_MANIFEST;
  const regPath = arg("registry") ?? registryPathForManifest(manifest);
  const reg = loadRegistry(regPath);
  const entry = entryFromReport(out, { file: outPath, tag: arg("tag") ?? out.config?.tag });
  const sourceSlot = (reg.baselines ?? []).find((e) => sameSlot(e, entry));
  const { registry } = upsertEntry(reg, entry);
  const keepGate = argv.includes("--gate-baseline") || sourceSlot?.gateBaseline === true;
  saveRegistry(regPath, keepGate ? markGateBaseline(registry, entry) : registry);
  console.log("已登记到 " + regPath + ": " + entry.tag + "（judge=" + entry.judgeModel + "，判对=" + pctS(entry.genCorrect) + "）" + (keepGate ? " [门禁基线]" : ""));
}
