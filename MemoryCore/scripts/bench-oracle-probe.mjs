#!/usr/bin/env node
/**
 * 证据补全探针（#146 算法重判）：把 gold 证据轮**直接补进已构造的 block**，再重新作答+判分，
 * 用来把「检索没给到证据」和「模型给了证据也答不成」这两类损失分开。
 *
 * 这不是提分手段（gold 注入不可上线），是**上限口径**：转换率高 ⇒ 瓶颈在召回/排序；
 * 转换率低 ⇒ 瓶颈在作答聚合，读侧提示词翻不动。
 *
 * 用法: node --import tsx scripts/bench-oracle-probe.mjs --report <json> [--out <json>]
 *        [--scope fails|multi|pref|all] [--limit N] [--data <longmemeval_oracle.json>] [--config <yaml>]
 */
import fs from "node:fs";
import path from "node:path";
import { readLlmCredential } from "./lib/read-llm-credential.ts";
import { makeLlm, buildAnswerPrompt, buildJudgePrompt } from "./lib/bench/llm.mjs";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? undefined : argv[i + 1]; };

const reportPath = arg("report");
if (!reportPath) { console.error("缺 --report"); process.exit(2); }
const scope = arg("scope") ?? "fails";
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const dataPath = arg("data") ?? path.resolve(process.cwd(), "..", ".eval-data", "longmemeval_oracle.json");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const dataset = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const byId = new Map(dataset.map((d) => [d.question_id, d]));

const cred = readLlmCredential(arg("config") ? { yamlPath: arg("config") } : {});
if (!cred) { console.error("读不到 LLM 凭据"); process.exit(2); }
const llm = makeLlm(cred);

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** gold 证据轮：answer_session_ids 里 has_answer=true 的轮，附带会话日期。 */
function goldTurns(entry) {
  const out = [];
  (entry.answer_session_ids || []).forEach((rawId) => {
    const si = (entry.haystack_session_ids || []).indexOf(rawId);
    if (si < 0) return;
    const date = (entry.haystack_dates || [])[si] ?? "";
    ((entry.haystack_sessions || [])[si] || []).forEach((m) => {
      if (m?.has_answer) out.push({ date, role: m.role, content: String(m.content ?? "") });
    });
  });
  return out;
}

function select(rows) {
  return rows.filter((r) => {
    if (scope === "all") return true;
    if (r.genCorrect === 1) return false;
    if (scope === "multi") return r.questionType === "multi-session";
    if (scope === "pref") return r.questionType === "single-session-preference";
    return true;
  });
}

const rows = select(report.rows).slice(0, limit);
console.log("探针: " + path.basename(reportPath) + " scope=" + scope + " 题数=" + rows.length + " judge=" + cred.model);

const results = [];
let converted = 0;
let injectedTotal = 0;
const t0 = Date.now();
for (const row of rows) {
  const entry = byId.get(row.caseId);
  if (!entry) { results.push({ caseId: row.caseId, skipped: "no-dataset-entry" }); continue; }
  const golds = goldTurns(entry);
  const blockNorm = norm(row.block);
  const missing = golds.filter((g) => {
    const key = norm(g.content).slice(0, 80);
    return key.length > 20 && !blockNorm.includes(key);
  });
  const extra = missing.map((g) => "- [" + String(g.date).slice(0, 10) + "] " + g.content).join("\n");
  const block = extra ? row.block + "\n" + extra : row.block;
  injectedTotal += missing.length;

  let answer = "";
  let verdict = null;
  try {
    answer = await llm.text([
      { role: "user", content: buildAnswerPrompt({ question: row.question, block, questionDate: entry.question_date, datasetName: "longmemeval" }) },
    ], { maxTokens: cred?.maxTokens && cred.maxTokens > 0 ? cred.maxTokens : 1024 });
    verdict = await llm.json([
      { role: "user", content: buildJudgePrompt({ question: row.question, gold: row.gold, answer, questionType: row.questionType, datasetName: "longmemeval" }) },
    ], { maxTokens: 512 });
  } catch (e) {
    results.push({ caseId: row.caseId, error: String(e?.message ?? e) });
    continue;
  }
  const correct = verdict?.correct === true ? 1 : 0;
  if (correct) converted += 1;
  results.push({
    caseId: row.caseId,
    questionType: row.questionType,
    wasCorrect: row.genCorrect === 1,
    turnCov5: row["turnCov@5"],
    injected: missing.length,
    correct,
    refused: verdict?.refused === true ? 1 : 0,
    reason: verdict?.reason ?? (verdict ? "" : "judge-parse-failed"),
    answer: answer.slice(0, 400),
  });
  process.stderr.write("  " + (results.length) + "/" + rows.length + " " + row.caseId + " cov5=" + row["turnCov@5"] + " inj=" + missing.length + " correct=" + correct + "\n");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = arg("out") ?? path.join(path.dirname(reportPath), "oracle-probe-" + scope + "-" + stamp + ".json");
fs.writeFileSync(outPath, JSON.stringify({ source: reportPath, scope, model: cred.model, rows: results }, null, 2) + "\n", "utf8");

const byType = {};
for (const r of results) {
  if (r.error || r.skipped) continue;
  const t = (byType[r.questionType] ??= { n: 0, ok: 0, wasOk: 0 });
  t.n += 1;
  t.ok += r.correct;
  t.wasOk += r.wasCorrect ? 1 : 0;
}
console.log("=== 证据补全后（上限口径） ===");
for (const [t, v] of Object.entries(byType)) {
  console.log(t.padEnd(26), "原判对 " + v.wasOk + "/" + v.n + " → 补全后 " + v.ok + "/" + v.n);
}
console.log("合计: 原 " + results.filter((r) => r.wasCorrect).length + "/" + results.length + " → 补全后 " + converted + "/" + results.length + "，注入 gold 轮 " + injectedTotal + " 条，" + ((Date.now() - t0) / 1000).toFixed(0) + "s");
console.log("输出: " + outPath);
