/**
 * 探针：bge-reranker-base 在真实 bench 问题×全部轮文本上的 logit 分布。
 * 目的：验证「rerank minScore=-2.0（logit 刻度）门是不是召回池饿死的主嫌疑」。
 * 零 embedding / 零 LLM API 调用——精排器本地 ONNX。
 * 用法：cd MemoryCore && node --import tsx .eval-data/bench/probe-rerank.mjs
 */
import fs from "node:fs";
import { getSharedLocalReranker } from "../../src/core/recall/rerank/local.ts";

const RAW = "D:/TDB/td-agemem/.eval-data/longmemeval_oracle.json";
const REPORT = ".eval-data/bench/longmemeval-oracle-2026-10-26T14-57-58.json";
const MODEL_DIR = "D:/TDB/data/models/reranker/Xenova/bge-reranker-base";
const MIN_SCORE = -2.0; // 生产 yaml memory.recall.rerank.minScore（bench 沿用）

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
const byCase = new Map(raw.map((it) => [it.question_id, it]));

// 取样：每个 hits 桶各 2 题 + 2 题「hits 满 5 但 turnCov<1」（排序失败样本）
const picked = [];
const seenBucket = new Map();
for (const b of [1, 2, 3, 4, 5]) seenBucket.set(b, 0);
const missFull = [];
for (const row of report.rows) {
  if (row.hits >= 5 && (row.turnCov ?? 1) < 1 && missFull.length < 2) missFull.push(row);
  const n = seenBucket.get(row.hits) ?? 99;
  if (n < 2) { picked.push(row); seenBucket.set(row.hits, n + 1); }
}
const rows = [...picked, ...missFull];

const rr = getSharedLocalReranker({ modelDir: MODEL_DIR, allowAutoDownload: false, idleUnloadMs: 0 });

console.log("caseId\thits\tturnCov\tturns\ttop\tmedian\tmin\tpass(>%.1f)\ttop8 logits" % MIN_SCORE);
let passSum = 0, turnsSum = 0;
for (const row of rows) {
  const it = byCase.get(row.caseId);
  if (!it) { console.log(row.caseId, "NOT-IN-RAW"); continue; }
  const turns = (it.haystack_sessions || []).flat().map((m) => String(m.content ?? ""));
  const res = (await rr.rerank(row.question, turns)) || [];
  const logits = res.map((r) => r.score).sort((a, b) => b - a);
  const pass = logits.filter((l) => l > MIN_SCORE).length;
  passSum += pass; turnsSum += turns.length;
  const med = logits.length ? logits[Math.floor(logits.length / 2)] : NaN;
  console.log(
    `${row.caseId}\t${row.hits}\t${row.turnCov ?? "-"}\t${turns.length}\t` +
    `${logits[0]?.toFixed(2)}\t${med?.toFixed(2)}\t${logits[logits.length - 1]?.toFixed(2)}\t` +
    `${pass}/${turns.length}\t${logits.slice(0, 8).map((x) => x.toFixed(1)).join(",")}`,
  );
}
console.log(`\nSUMMARY: pass ${(passSum / turnsSum * 100).toFixed(1)}% (${passSum}/${turnsSum}) at minScore=${MIN_SCORE}`);
await rr.dispose();
