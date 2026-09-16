#!/usr/bin/env node
/**
 * D2 校准拟合器（试跑模式，REG-REMAINING-001）：
 * 读判官标注 → 重跑召回取特征 → 逻辑回归拟合 → 输出系数报告（**不部署** yaml）。
 *
 * 特征向量：[intercept, rrfScore, recencyDays, significance, certainty, valence, arousal]
 * 目标：rel ≥ 2（核心相关） vs < 2。
 * 产线替换条件：标注池 ≥ 300 且拟合精度经人工复核（D2 完成定义）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JUDGE_DIR = path.join(ROOT, "..", "docs/superpowers/evals/judge");
const KEY = process.env.TDB_KEY;
const TEAM = "team-kcjjqzkxks", USER = "usr-kfym3ajzme", AGT = "agt-l5ugn6urg4";

// ── 1. 读全部有效标注（去重：queryId+recordId） ──
const labelMap = new Map();
for (const f of fs.readdirSync(JUDGE_DIR).filter((f) => f.startsWith("labels-")).sort()) {
  for (const line of fs.readFileSync(path.join(JUDGE_DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const l = JSON.parse(line);
    if (l.rel < 0) continue;
    const k = `${l.queryId}:${l.recordId}`;
    const prev = labelMap.get(k);
    if (!prev || l.judgedAt > prev.judgedAt) labelMap.set(k, l);
  }
}
const labels = [...labelMap.values()];
console.log(`[calib] 标注: ${labels.length} 条（${new Set(labels.map((l) => l.queryId)).size} 查询）`);
if (labels.length < 30) { console.log("[calib] 标注不足 30，试跑仍继续（结果仅供参考）"); }

// ── 2. 重跑召回取特征 ──
const byQuery = new Map();
for (const l of labels) {
  if (!byQuery.has(l.query)) byQuery.set(l.query, l);
}
const featureRows = [];
for (const [q, first] of byQuery) {
  const res = await fetch("http://127.0.0.1:8420/v3/atomic/search", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: `Bearer ${KEY}`,
      "x-tdai-service-id": "default", "x-tdai-team-id": TEAM,
      "x-tdai-user-id": USER, "x-tdai-agent-id": AGT,
    },
    body: JSON.stringify({ query: q, limit: 5 }),
  });
  const items = (await res.json())?.data?.items ?? [];
  const qLabels = labels.filter((l) => l.query === q);
  for (const it of items) {
    const lbl = qLabels.find((l) => l.recordId === it.id);
    if (!lbl) continue;
    const occ = it.occurred_at ? Date.parse(it.occurred_at) : NaN;
    const recencyDays = Number.isFinite(occ) ? Math.min(365, (Date.now() - occ) / 86400000) : 365;
    featureRows.push({
      features: [1, it.score ?? 0, recencyDays, it.significance ?? 0.5, it.certainty === "observed" ? 1 : 0, it.valence ?? 0, it.arousal ?? 0.5],
      target: lbl.rel >= 2 ? 1 : 0,
    });
  }
}
console.log(`[calib] 特征行: ${featureRows.length}（正例 ${featureRows.filter((r) => r.target === 1).length}）`);

// ── 3. 逻辑回归（梯度下降） ──
const D = featureRows[0].features.length;
let w = new Array(D).fill(0);
const lr = 0.5, iters = 800;
for (let it = 0; it < iters; it++) {
  const grad = new Array(D).fill(0);
  for (const r of featureRows) {
    const z = r.features.reduce((s, f, i) => s + f * w[i], 0);
    const p = 1 / (1 + Math.exp(-z));
    const e = p - r.target;
    for (let i = 0; i < D; i++) grad[i] += e * r.features[i];
  }
  for (let i = 0; i < D; i++) w[i] -= (lr / featureRows.length) * grad[i];
}
// 训练精度
let correct = 0;
for (const r of featureRows) {
  const p = 1 / (1 + Math.exp(-r.features.reduce((s, f, i) => s + f * w[i], 0)));
  if ((p >= 0.5 ? 1 : 0) === r.target) correct++;
}
const names = ["intercept", "rrfScore", "recencyDays", "significance", "certainty", "valence", "arousal"];
console.log(`[calib] 训练精度: ${correct}/${featureRows.length}`);
const report = {
  mode: "pilot（试跑——不部署 yaml）",
  trainedAt: new Date().toISOString(),
  samples: featureRows.length,
  accuracy: `${correct}/${featureRows.length}`,
  coefficients: Object.fromEntries(w.map((v, i) => [names[i], Number(v.toFixed(4))])),
  note: "产线替换条件：标注 ≥300 且人工复核拟合合理性（REG-REMAINING-001 D2）",
};
const outPath = path.join(JUDGE_DIR, `calibration-pilot-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`[calib] 报告 → ${outPath}`);
console.log(JSON.stringify(report.coefficients));