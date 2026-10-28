#!/usr/bin/env node
/**
 * 基线登记表 CLI（issue #140 目标②）。
 *
 * 用法：
 *   node scripts/bench-baseline.mjs list   [--registry <lme-baselines.json>]
 *   node scripts/bench-baseline.mjs register <report.json...> [--registry <path>] [--tag <name>] [--gate-baseline]
 *   node scripts/bench-baseline.mjs resolve --judge <model> [--manifest <path>] [--dataset <name>]
 *   node scripts/bench-baseline.mjs check <trial.json> [--registry <path>]
 *   node scripts/bench-baseline.mjs stale [<trial.json>] --judge <model> [--commands] [--registry <path>]
 *
 * 为什么需要它：报告名只有时间戳，同一个档位名在不同 judge 下有两份（scm-flash 70.0% /
 * MiniMax 77.8%）。门禁要的是「同 judge 的基线」，靠人记不住，靠文件名也推不出来。
 *
 * 退出码：0 = ok；2 = 用法/读文件错误；3 = 找不到同 judge 基线（judge-changed / missing）。
 */
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MANIFEST,
  entryFromReport,
  findGateBaseline,
  markGateBaseline,
  judgeBaselineAudit,
  loadRegistry,
  registryPathForManifest,
  saveRegistry,
  summarizeRegistryLines,
  upsertEntry,
} from "./lib/bench/baseline.mjs";
import { judgeIdentity, normalizeText } from "./lib/bench/judge.mjs";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return undefined;
  return argv[i + 1];
}
const BOOL_FLAGS = ["--gate-baseline"];
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL_FLAGS.includes(argv[i - 1])),
);
const cmd = positional[0];

const manifestFor = (report) => report?.config?.manifest ?? DEFAULT_MANIFEST;
const registryFor = (manifest) => arg("registry") ?? registryPathForManifest(manifest ?? DEFAULT_MANIFEST);

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`读取报告失败: ${file}（${e?.message ?? e}）`);
    process.exit(2);
  }
}

function usage() {
  console.error("用法: node scripts/bench-baseline.mjs <list|register|resolve|check|stale> ... （见文件头注释）");
  process.exit(2);
}

if (!cmd) usage();

if (cmd === "list") {
  const regPath = registryFor(arg("manifest"));
  const reg = loadRegistry(regPath);
  console.log(`登记表: ${regPath}${reg.reason ? `（${reg.reason}）` : ""}`);
  console.log(summarizeRegistryLines(reg).join("\n"));
  process.exit(0);
}

if (cmd === "register") {
  const files = positional.slice(1);
  if (!files.length) usage();
  let total = 0;
  for (const file of files) {
    const report = readReport(file);
    const regPath = registryFor(manifestFor(report));
    const entry = entryFromReport(report, { file, tag: arg("tag") });
    const prev = loadRegistry(regPath);
    const { registry: rawReg, replaced } = upsertEntry(prev, entry);
    const registry = {
      ...rawReg,
      note:
        rawReg.note ??
        "报告 JSON 是本机 .eval-data 下的评测产物（不入库）；本表只记录它们的 judge 身份、commit 与路径，供门禁解析同 judge 基线。",
    };
    const gate = argv.includes("--gate-baseline");
    saveRegistry(regPath, gate ? markGateBaseline(registry, entry) : registry);
    const id = judgeIdentity(report);
    console.log(
      `登记 ${entry.tag}: judge=${id.label} commit=${(entry.repoCommit ?? "").slice(0, 7) || "-"} n=${entry.n} ` +
        `判对=${entry.genJudged ? (entry.genCorrect * 100).toFixed(1) + "%" : "-（无判分行）"} → ${regPath}${replaced ? "（覆盖同槽位）" : ""}${gate ? " [门禁基线⭐]" : ""}`,
    );
    total += 1;
  }
  console.log(`完成: ${total} 份报告已登记。`);
  process.exit(0);
}

if (cmd === "resolve") {
  const judge = arg("judge");
  if (!judge) {
    console.error("resolve 需要 --judge <model>（例如 --judge MiniMax-M3.1-Flash；retrieval-only 档请直接用报告路径）");
    process.exit(2);
  }
  const manifest = arg("manifest") ?? DEFAULT_MANIFEST;
  const dataset = arg("dataset") ?? null;
  const regPath = registryFor(manifest);
  const reg = loadRegistry(regPath);
  const hit = findGateBaseline(reg, { judgeModel: judge, manifest, dataset });
  if (!hit) {
    const sameManifest = (reg.baselines ?? []).filter((e) => !manifest || path.basename(e.manifest ?? "") === path.basename(manifest));
    const stale = [...new Set(sameManifest.map((e) => e.judgeModel ?? "（未记录）"))];
    console.error(`没有 ${judge} 判分的同 manifest 基线（登记表 ${regPath}）。`);
    if (stale.length) console.error(`登记表里现有基线的判分器: ${stale.join(", ")}——判分器变更后必须重跑/重判基线。`);
    console.error("登记基线: node scripts/bench-baseline.mjs register <报告.json>");
    console.error("重判旧报告: node --import tsx scripts/bench-rejudge.mjs <旧报告.json> --register");
    process.exit(3);
  }
  console.log(`同 judge 基线: ${hit.tag}（judge=${hit.judgeModel}，commit=${(hit.repoCommit ?? "").slice(0, 7) || "-"}）`);
  console.log(`报告: ${hit.report}`);
  console.log(`判对=${hit.genJudged ? (hit.genCorrect * 100).toFixed(1) + "%" : "-"}  turnCov@5=${hit.turnCov5 == null ? "-" : (hit.turnCov5 * 100).toFixed(1) + "%"}  n=${hit.n}`);
  console.log(`配对: node scripts/bench-compare.mjs ${hit.report} <trial.json>`);
  console.log(`门禁: node --import tsx scripts/bench-gates.mjs ${hit.report} <trial.json>`);
  process.exit(0);
}

if (cmd === "check") {
  const file = positional[1];
  if (!file) usage();
  const report = readReport(file);
  const manifest = manifestFor(report);
  const regPath = registryFor(manifest);
  const audit = judgeBaselineAudit(loadRegistry(regPath), report);
  const id = judgeIdentity(report);
  console.log(`trial: ${file}（judge=${id.label}，manifest=${path.basename(manifest)}）`);
  console.log(`登记表: ${regPath}`);
  if (audit.verdict === "ok") {
    console.log(`OK: 同 judge 基线 ${audit.baseline.tag}（judge=${audit.baseline.judgeModel}）可直接配对。`);
    process.exit(0);
  }
  if (audit.verdict === "judge-changed") {
    console.error(`REFUSED: 判分器已换成 ${audit.judge ?? "（未记录）"}，登记表里只有 ${audit.staleJudges.join(", ")} 判分的基线。`);
    console.error("→ 重跑基线，或用 bench-rejudge.mjs 把旧基线按当前 judge 重判。");
  } else {
    console.error(`REFUSED: 登记表里没有这个 manifest 的基线（judge=${audit.judge ?? "（未记录）"}）。`);
    console.error("→ node scripts/bench-baseline.mjs register <基线报告.json>");
  }
  process.exit(3);
}

if (cmd === "stale") {
  const reportFile = positional[1];
  const report = reportFile ? readReport(reportFile) : null;
  const manifest = arg("manifest") ?? manifestFor(report) ?? DEFAULT_MANIFEST;
  const regPath = registryFor(manifest);
  const reg = loadRegistry(regPath);
  const currentJudge = normalizeText(arg("judge")) ?? judgeIdentity(report ?? {}).model;
  if (!currentJudge) {
    console.error("stale 需要 --judge <model>，或给一份当前判分器的报告让它自己报判分器");
    process.exit(2);
  }
  const sameManifest = (reg.baselines ?? []).filter(
    (e) => path.basename(e.manifest ?? "") === path.basename(manifest),
  );
  const stale = sameManifest.filter((e) => (e.judgeModel ?? null) !== currentJudge);
  const onlyCommands = argv.includes("--commands");
  if (!onlyCommands) {
    console.log(`判分器: ${currentJudge}（manifest=${path.basename(manifest)}）`);
    console.log(`登记表: ${regPath}`);
  }
  if (!sameManifest.length) {
    if (!onlyCommands) console.error(`REFUSED: 登记表里没有 ${path.basename(manifest)} 的基线——先 register 一份。`);
    process.exit(3);
  }
  if (!stale.length) {
    if (!onlyCommands) console.log(`OK: 登记的 ${sameManifest.length} 条基线都是 ${currentJudge} 判分，无需重跑。`);
    process.exit(0);
  }
  if (!onlyCommands) {
    console.error(
      `STALE: ${stale.length}/${sameManifest.length} 条基线不是 ${currentJudge} 判的——它们与本判分器的新报告不可配对（#140）。`,
    );
    for (const e of stale) {
      console.error(
        `  - ${e.tag}: judge=${e.judgeModel ?? "（未记录）"} commit=${(e.repoCommit ?? "").slice(0, 7) || "-"} ` +
          `判对=${e.genJudged ? (e.genCorrect * 100).toFixed(1) + "%" : "-"} 报告=${e.report ?? "（未记录）"}`,
      );
    }
    console.error("修复（重判只花判分调用、不重跑召回；重跑整档见 scripts/run-mm-baselines.sh 先例）:");
  }
  for (const e of stale) {
    if (!e.report) continue;
    console.log(`node --import tsx scripts/bench-rejudge.mjs ${e.report} --register --gate-baseline`);
  }
  if (!onlyCommands) console.error("（--commands 只打印命令，便于脚本执行/CI 断言）");
  process.exit(3);
}
usage();
