/**
 * S19（#57）：锚 shadow 数据分析 CLI（薄壳，只读）。
 *
 * 用法：pnpm analyze:anchor-shadow <soul-anchor-shadow.jsonl>
 * 生产文件：/data/tdai-memory/logs/soul-anchor-shadow.jsonl（anchorSelect.shadowSink）。
 * 输出：agree 率 / 锚频率 Top / 分数分位数 / threshold 曲线 —— 供 D9 定标与 #59 auto 档证据。
 */
import { readFileSync } from "node:fs";
import { analyzeAnchorShadowRows, type AnchorShadowRowLike } from "../src/core/hooks/anchor-shadow-stats.js";

const file = process.argv[2];
if (!file) {
  console.error("用法: pnpm analyze:anchor-shadow <soul-anchor-shadow.jsonl>");
  process.exit(1);
}

let parseBad = 0;
const rows: AnchorShadowRowLike[] = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t) continue;
  try {
    rows.push(JSON.parse(t) as AnchorShadowRowLike);
  } catch {
    parseBad += 1;
  }
}

const s = analyzeAnchorShadowRows(rows);
console.log("file:", file);
console.log("jsonl 行:", rows.length + parseBad, "(解析失败 " + parseBad + ")");
console.log("有效行:", s.totalLines, "坏行:", s.badLines);
console.log("agree 率:", s.agreeCount + "/" + (s.agreeCount > 0 || s.agreeRate > 0 ? Math.round(s.agreeCount / (s.agreeRate || 1)) : 0), "=", s.agreeRate.toFixed(3));
console.log("分数分位数:", JSON.stringify(Object.fromEntries(Object.entries(s.scoreQuantiles).map(([k, v]) => [k, Number(v.toFixed(4))]))));
console.log("锚频率 Top10 (wouldSelect desc):");
for (const f of s.anchorFrequency.slice(0, 10)) {
  console.log("  " + f.valueId + "\t would=" + f.wouldSelectCount + " actual=" + f.actuallySelectedCount + " scored=" + f.scoredCount);
}
console.log("threshold 曲线:");
for (const t of s.thresholdCurve) {
  console.log("  >=" + t.threshold.toFixed(1) + "\t avgSelected=" + t.avgSelected.toFixed(3) + "\t passRate=" + t.passRate.toFixed(3));
}