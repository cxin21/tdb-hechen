#!/usr/bin/env node
/**
 * #141 因子设计的 CLI 薄壳：只做参数解析 + 读报告 + 调 lib/bench/factorial.mjs + 打印 markdown。
 *
 * 它不跑任何 bench、不发任何网络请求——只吃已有报告 JSON（每个臂一份），
 * 所以「跑批」与「判定」可以分开做：跑批见 scripts/run-r141-factorial.sh。
 *
 * 用法：
 *   node --import tsx scripts/bench-factorial.mjs \
 *     --base <base.json> \
 *     --single <tag>=<file.json>[,<tag>=<file.json>...] \
 *     --combo  <tag>=<file.json>[,<tag>=<file.json>...] \
 *     [--floor <type>=<metric>=<pp>] [--json <out.json>] [--allow-cross-judge]
 *
 * 退出码：
 *   0 = 出数（判分器一致，或已 --allow-cross-judge 显式豁免）
 *   2 = 用法错误 / 缺文件 / 报告读不了（白跑不如早停）
 *   3 = 判分器不一致（与 bench-ranking 同口径：仍打印表格，但判对/拒答列标 *，且不作方法结论）
 */
import fs from "node:fs";
import path from "node:path";
import { buildFactorial, formatFactorialMarkdown } from "./lib/bench/factorial.mjs";
import { CROSS_JUDGE_EXIT_CODE, judgeRepairHint } from "./lib/bench/judge.mjs";

const USAGE = `用法:
  node --import tsx scripts/bench-factorial.mjs --base <base.json> \\
    --single <tag>=<file.json>[,<tag>=<file.json>...] \\
    --combo <tag>=<file.json>[,<tag>=<file.json>...] \\
    [--floor <type>=<metric>=<pp>] [--json <out.json>] [--allow-cross-judge]

说明:
  --base   基线报告（必填）。其余臂都与它同题配对。
  --single 单机制臂，逗号分隔；lib 取其中判对率最高者为 singleBest。
  --combo  组合臂，逗号分隔；取其中判对率最高者与 singleBest 比判定线。
  --floor  分题型门禁容差，形如 temporal=turnCov=0（可重复/逗号分隔；缺省 temporal 容差 0）
  --json   把结构化结果写到该文件
  --allow-cross-judge  判分器不一致时仍出数（标 *，不作方法结论）`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function valuesOf(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--" + name) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`[factorial] --${name} 需要一个值`);
      process.exit(2);
    }
    out.push(v);
  }
  return out;
}
const valueOf = (name) => valuesOf(name)[0];
const allowCrossJudge = argv.includes("--allow-cross-judge");

/** "tag=file,tag2=file2"（可重复）→ [{tag, file}]。 */
function parseArmSpecs(name) {
  const arms = [];
  for (const raw of valuesOf(name)) {
    for (const item of raw.split(",")) {
      const s = item.trim();
      if (!s) continue;
      const eq = s.indexOf("=");
      if (eq <= 0 || eq === s.length - 1) {
        console.error(`[factorial] --${name} 需要 tag=file，收到: ${s}`);
        process.exit(2);
      }
      arms.push({ tag: s.slice(0, eq).trim(), file: s.slice(eq + 1).trim() });
    }
  }
  return arms;
}

/** "temporal=turnCov=0"（可重复/逗号分隔）→ {temporal: {metric, pp}}。 */
const FLOOR_METRICS = new Set(["turnCov", "turnCov@5", "turnCovInjected", "genAccuracy", "refusalRate"]);
function parseFloors() {
  const out = {};
  for (const raw of valuesOf("floor")) {
    for (const item of raw.split(",")) {
      const s = item.trim();
      if (!s) continue;
      const parts = s.split("=");
      if (parts.length !== 3) {
        console.error(`[factorial] --floor 需要 <type>=<metric>=<pp>，收到: ${s}`);
        process.exit(2);
      }
      const [type, metric, ppRaw] = parts.map((x) => x.trim());
      if (!FLOOR_METRICS.has(metric)) {
        console.error(`[factorial] --floor 不认指标 ${metric}（可选: ${[...FLOOR_METRICS].join(" / ")}）`);
        process.exit(2);
      }
      const pp = Number(ppRaw);
      if (!Number.isFinite(pp)) {
        console.error(`[factorial] --floor 的 pp 需要数字，收到: ${ppRaw}`);
        process.exit(2);
      }
      out[type] = { metric, pp };
    }
  }
  return out;
}

const baseFile = valueOf("base");
const singles = parseArmSpecs("single");
const combos = parseArmSpecs("combo");
const floors = parseFloors();
const jsonOut = valueOf("json");

if (!baseFile || (!singles.length && !combos.length)) {
  console.error(USAGE);
  process.exit(2);
}

/** 读报告：路径不存在/JSON 坏了都按「用法/输入错误」退出 2（不静默出空表）。 */
function loadReport(file) {
  if (!fs.existsSync(file)) {
    console.error(`[factorial] 找不到报告文件: ${file}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[factorial] 报告不是合法 JSON: ${file}（${e?.message ?? e}）`);
    process.exit(2);
  }
}

const baseReport = loadReport(baseFile);
const baseTag = baseReport.config?.tag ?? path.basename(baseFile).replace(/\.json$/, "");
const arms = [
  { tag: baseTag, report: baseReport },
  ...singles.map((s) => ({ tag: s.tag, report: loadReport(s.file) })),
  ...combos.map((c) => ({ tag: c.tag, report: loadReport(c.file) })),
];

const result = buildFactorial(arms, {
  baseTag,
  singleTags: singles.map((s) => s.tag),
  comboTags: combos.map((c) => c.tag),
  floor: floors,
  judgeGate: true,
});

console.log(formatFactorialMarkdown(result, { allowCrossJudge }));

if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2), "utf8");
  console.error(`[factorial] 结构化结果: ${jsonOut}`);
}

if (!result.judge.ok && !allowCrossJudge) {
  console.error(`[factorial] 判分器不一致（exit ${CROSS_JUDGE_EXIT_CODE}）：${result.judge.note}`);
  for (const line of judgeRepairHint({ trialJudge: result.judge.mismatched?.[0]?.tag ?? null })) console.error(line);
  process.exit(CROSS_JUDGE_EXIT_CODE);
}
