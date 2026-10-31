#!/usr/bin/env node
/**
 * bench-report —— 把 eval-memory-bench 产出的 .json 报告压成可读的对照表。
 *
 * 用法：
 *   node scripts/bench-report.mjs .eval-data/bench/longmemeval-xxx.json
 *   node scripts/bench-report.mjs .eval-data/bench/*.json      # 多份一起，按数据集分组
 *   node scripts/bench-report.mjs <json> --md                  # 只输出 markdown（贴文档用）
 *
 * 只读：不连库、不调模型、不占 embedding 配额，可以在跑数的同时执行。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { enforceJudgeGate, judgeCoverage } from "./lib/bench/report.mjs";

/** M8：任一报告判分覆盖不足/判分器缺失 ⇒ 渲染后 exit 3（不许静默当正常档贴进文档）。 */
let anyInvalid = false;

/** Wilson 95% 置信区间：小样本比例必须带区间，否则就是自欺欺人。 */
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const pct = (x) => (typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const num = (x, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");
const ms = (x) => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x)}ms` : "—");

function ci(k, n) {
  const w = wilson(k, n);
  return w ? `[${pct(w[0])}–${pct(w[1])}]` : "—";
}

function countOf(rows, key) {
  return rows.filter((r) => r[key] === 1 || r[key] === true).length;
}

function table(rows, label) {
  // 每类：n、any@5、turn_cov@5、MRR、判对率（分母只算判过的）
  const by = new Map();
  for (const r of rows) {
    const t = r.questionType || "unknown";
    if (!by.has(t)) by.set(t, []);
    by.get(t).push(r);
  }
  const out = [];
  out.push(`| ${label} | n | 会话命中@5 | turn 覆盖@5 | MRR | 判对率（n判） |`);
  out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  const emit = (name, list) => {
    const any = list.filter((r) => r.sessionAny === 1).length;
    const judged = list.filter((r) => typeof r.genCorrect === "number");
    const correct = judged.filter((r) => r.genCorrect === 1).length;
    const mrr = list.reduce((a, r) => a + (Number.isFinite(r.mrr) ? r.mrr : 0), 0) / (list.length || 1);
    const tc = list.reduce((a, r) => a + (Number.isFinite(r.turnCov) ? r.turnCov : 0), 0) / (list.length || 1);
    out.push(
      `| ${name} | ${list.length} | ${pct(any / list.length)} ${ci(any, list.length)} | ${pct(tc)} | ${num(mrr)} | ${
        judged.length ? `${pct(correct / judged.length)} ${ci(correct, judged.length)} (${judged.length})` : "—"
      } |`,
    );
  };
  for (const [t, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) emit(t, list);
  emit("**合计**", rows);
  return out.join("\n");
}

function summarize(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const rows = j.rows || [];
  const cfg = j.config || {};
  const ing = cfg.ingest || {};
  const errs = rows.filter((r) => r.error || r.unresolved).length;
  const lines = [];
  const dsName =
    typeof j.dataset === "string" ? j.dataset : j.dataset?.name || j.config?.dataset?.name || basename(file, ".json");
  lines.push(`## ${dsName}  ·  ${basename(file)}`);
  lines.push("");
  lines.push(
    `- 模型：生成 \`${cfg.genModel || "—"}\` / 判分 \`${cfg.judgeModel || "—"}\` / 素材 \`${cfg.embeddingModel || cfg.embedding || "—"}\``,
  );
  lines.push(
    `- 灌库：${ing.groups ?? "—"} 组 / ${ing.turns ?? "—"} 轮，写入 ${ing.written ?? "—"}，向量 ${ing.embedded ?? "—"}，失败 ${ing.embedFailed ?? "—"}，429 重试 ${ing.embedRetries ?? "—"}`,
  );
  const jc = judgeCoverage(j);
  if (enforceJudgeGate(j, { label: basename(file), allowUnjudged }) !== 0) anyInvalid = true;
  lines.push(
    `- 题数：${rows.length}（判分 ${jc.judged}/${jc.total} = ${(jc.coverage * 100).toFixed(1)}%；判分器 ${jc.judgeModel ?? "缺失"}）；异常/未解析行：${errs}`,
  );
  lines.push("");
  lines.push(table(rows, "类别"));
  lines.push("");
  const o = j.overall || {};
  lines.push(
    `延迟：mean ${ms(o.latencyMsMean)} / p50 ${ms(o.latencyMsP50)} / p95 ${ms(o.latencyMsP95)} / max ${ms(o.latencyMsMax)}`,
  );
  return lines.join("\n");
}

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("用法: node scripts/bench-report.mjs <report.json...> [--md] [--allow-unjudged]");
  process.exit(1);
}
const allowUnjudged = args.includes("--allow-unjudged");
const mdOnly = args.includes("--md");
const out = files.map((f) => summarize(f)).join("\n\n---\n\n");
if (mdOnly) {
  process.stdout.write(out + "\n");
} else {
  console.log(out);
}
if (anyInvalid) {
  console.error("[bench:invalid] 存在判分覆盖不足的报告（见上）：不可作为结论引用；补 judge 后重跑，或显式 --allow-unjudged");
  process.exit(3);
}
