/**
 * #144：rerank floor 校准的离线分析器。
 *
 * 输入：bench 侧 --dump-rerank-scores 落下的 JSONL（每题一行，**全量候选**原始分数 + 最终保留序），
 *      可选一份同配置 result JSON（提供「非经验层结构行前缀」，让 turnCov@5 更贴近真实注入口径）。
 * 输出：floor → (kept 比例, 误滤 gold 比例, turnCov@5) 表；外加标度稳健规则的对照
 *      （概率阈值 / top-margin / 分位裁剪），最后给生产建议要的数值。
 *
 * 为什么能离线重算：filter 模式 = 保原序只剔除不达线行 → 任意 floor 的保留集完全由
 * （候选原序 + 各候选分数 + cap）决定，无需重跑精排。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataset } from "./lib/bench/datasets.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

/** 数据集缺省路径（同 bench：仓库根 .eval-data/ 优先，其次 MemoryCore/.eval-data/）。 */
function defaultDataPath(name) {
  const names = { longmemeval: ["longmemeval_oracle.json", "longmemeval_s.json"], locomo: ["locomo10.json"] }[name] || [];
  const roots = [path.resolve(repo, ".."), repo];
  for (const r of roots) for (const n of names) {
    const c = path.join(r, ".eval-data", n);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const dumpPath = String(arg("dump", ""));
if (!dumpPath || !fs.existsSync(dumpPath)) {
  console.error("用法: node scripts/analyze-r144-rerank-floor.mjs --dump <rerank-scores.jsonl> [--result <arm.json>] [--data <path>] [--floors ...]");
  process.exit(2);
}
const datasetName = String(arg("dataset", "longmemeval"));
const dataPath = String(arg("data", defaultDataPath(datasetName)));
if (!dataPath) {
  console.error("找不到数据集文件，请用 --data 指定");
  process.exit(2);
}
const resultPath = arg("result", undefined);
const result = typeof resultPath === "string" ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : null;

const ds = loadDataset(datasetName, dataPath, { samples: 0 });
const cases = new Map(ds.cases.map((c) => [c.caseId, c]));

// ── 召回行 → 落库 turn id（与 bench metrics 同一口径）──
// 为什么不用 recordId：sqlite fallback 路 metas 为空，转储里的 rec 恒 null；
// 生产 bench 也从不依赖 metas，而是「stripMemoryLineMeta 剥标注 + 全文 normHead 比对」。
const { stripMemoryLineMeta } = await import("../src/core/hooks/memory-line-meta.ts");
// 题内相对尺子（margin/quantile）与生产共用同一实现：见 ADR-0013。
const { DEFAULT_RERANK_FILTER_RULER, relativeKeepIdxSet } = await import(
  "../src/core/recall/rerank/filter-ruler.ts"
);
const normHead = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanLine = (t) => stripMemoryLineMeta(String(t ?? "")).replace(/^-\s+/, "").trim();
const contentIndex = new Map();
for (const c of ds.cases) {
  for (const g of c.groups) {
    for (const t of g.turns) {
      const ts = t.tsISO || c.questionDateISO || "";
      const body = ts
        ? `[${ts.replace("T", " ")}] ${t.speaker}: ${t.text}`
        : `${t.speaker}: ${t.text}`;
      contentIndex.set(normHead(body), t.id);
    }
  }
}
const resolveTurn = (line) => contentIndex.get(normHead(cleanLine(line))) ?? null;

// ── 读转储，按题聚合 ──
const CASE_RE = /^lme-(.+)-s\d+-t\d+$/;
const byCase = new Map();
const unresolved = { rows: 0, total: 0 };
const raw = fs.readFileSync(dumpPath, "utf8").split("\n").filter((l) => l.trim());
for (const line of raw) {
  const rec = JSON.parse(line);
  // 用召回行文本反查 turn id，再补进 order（离线分析全部按 rec 工作）。
  for (const o of rec.order) {
    unresolved.total++;
    if (!o.rec) o.rec = resolveTurn(o.text ?? "");
    if (o.rec) unresolved.rows++;
  }
  let caseId = null;
  for (const o of rec.order) {
    const m = typeof o.rec === "string" ? o.rec.match(CASE_RE) : null;
    if (m) { caseId = m[1]; break; }
  }
  if (!caseId) continue;
  if (!byCase.has(caseId)) byCase.set(caseId, rec);
}

const rowsByCase = new Map();
if (result) for (const r of result.rows) rowsByCase.set(r.caseId, r);

const logitOfP = (p) => Math.log(p / (1 - p));

/**
 * 用一条规则生成「保留的候选 id 序列」。
 * rule: {type:"floor", value} | {type:"prob", value} | {type:"margin", m} | {type:"quantile", q}
 *
 * margin/quantile 走 `relativeKeepIdxSet`（生产同一实现，ADR-0013）——离线调参与线上判定
 * 必须是同一把尺子，否则「按离线曲线选的参数」在生产上不成立。
 */
function keepIds(rec, rule) {
  const scored = new Map(rec.scored.map((s) => [s.i, s.score]));
  const clean = rec.scored.map((s) => ({ index: s.i, score: s.score }));
  let passSet;
  if (rule.type === "floor" || rule.type === "prob") {
    const floor = rule.type === "floor" ? rule.value : logitOfP(rule.value);
    passSet = new Set(clean.filter((c) => c.score >= floor).map((c) => c.index));
  } else if (rule.type === "margin") {
    passSet = relativeKeepIdxSet(clean, { ...DEFAULT_RERANK_FILTER_RULER, rule: "margin", marginTop: rule.m });
  } else if (rule.type === "quantile") {
    passSet = relativeKeepIdxSet(clean, { ...DEFAULT_RERANK_FILTER_RULER, rule: "quantile", keepRatio: rule.q });
  } else {
    throw new Error("unknown rule type: " + rule.type);
  }
  // 未评分（provider 截断）的行无条件保留；保留序 = 候选原序（filter 语义）
  const kept = rec.order.filter((o) => scored.get(o.i) === undefined || passSet.has(o.i)).map((o) => o.i);
  return kept.map((i) => rec.order[i].rec).filter((x) => typeof x === "string").slice(0, Math.max(rec.cap, 0));
}

/** filter 语义下「被 floor 误滤的 gold」：候选池里出现过、但被规则剔掉的证据 turn。 */
function goldStats(rec, caseId, keptIds) {
  const caseObj = cases.get(caseId);
  const ev = caseObj ? [...caseObj.evidenceTurnIds] : [];
  if (!ev.length) return null;
  const candIds = new Set(rec.order.map((o) => o.rec).filter(Boolean));
  const inPool = ev.filter((t) => candIds.has(t));
  const keptSet = new Set(keptIds);
  const dropped = inPool.filter((t) => !keptSet.has(t));
  return { inPool: inPool.length, dropped: dropped.length };
}

/**
 * 结构行（结论/事实/锚行）在注入口径里占位但**解析不出 turn id**（metrics 只数 resolve 成功的行）。
 * 于是：结构行数 = 该题注入行数 − 可解析 id 数；重放时用同数量 null 占位，才能复现「结构行挤掉
 * 一个 top-5 名额」的真实效果（上一版忽略这点，把 turnCov@5 系统性高估约 7pp）。
 */
function structuralCount(caseId) {
  const row = rowsByCase.get(caseId);
  if (!row) return 0;
  return Math.max(0, (row.injectedLines ?? 0) - (row.retrieved ?? []).length);
}

function turnCov(ids, caseId, k) {
  const caseObj = cases.get(caseId);
  const ev = caseObj ? [...caseObj.evidenceTurnIds] : [];
  if (!ev.length) return null;
  // 与 metrics 一致：**先截位置**（结构行占位），再只数能解析的 id——顺序反过来会把 turnCov 高估约 7pp
  const top = new Set(ids.slice(0, k).filter(Boolean));
  return ev.filter((t) => top.has(t)).length / ev.length;
}

function evaluate(rule, label) {
  let candTotal = 0, keptTotal = 0;
  let goldInPool = 0, goldDropped = 0;
  let qWithGoldDropped = 0, qTotal = 0;
  let cov5Sum = 0, cov5N = 0, covAllSum = 0, covAllN = 0;
  let noiseDropped = 0;
  for (const [caseId, rec] of byCase) {
    const kept = keepIds(rec, rule);
    candTotal += rec.order.length;
    keptTotal += kept.length;
    const gs = goldStats(rec, caseId, kept);
    if (gs) {
      qTotal++;
      goldInPool += gs.inPool;
      goldDropped += gs.dropped;
      if (gs.dropped > 0) qWithGoldDropped++;
      noiseDropped += rec.order.length - kept.length - gs.dropped;
    }
    const injected = [...Array(structuralCount(caseId)).fill(null), ...kept];
    const c5 = turnCov(injected, caseId, 5);
    if (c5 !== null) { cov5Sum += c5; cov5N++; }
    const ca = turnCov(injected, caseId, injected.length);
    if (ca !== null) { covAllSum += ca; covAllN++; }
  }
  return {
    label,
    keptRatio: candTotal ? keptTotal / candTotal : null,
    goldFalseFilter: goldInPool ? goldDropped / goldInPool : null,
    goldDropped,
    goldInPool,
    qWithGoldDropped,
    qTotal,
    noiseDropped,
    turnCov5: cov5N ? cov5Sum / cov5N : null,
    turnCovInjected: covAllN ? covAllSum / covAllN : null,
  };
}

// ── 分数可判别性：gold 行 vs 噪声行的 provider 分数分布（AUC）──
// 若两者分布高度重叠，任何「绝对 floor」都只能按比例误杀——这就是本票要回答的机制问题。
function scoreDiscrimination() {
  const gold = [], noise = [];
  const perQuerySpread = [];
  for (const [caseId, rec] of byCase) {
    const caseObj = cases.get(caseId);
    if (!caseObj) continue;
    const ev = new Set(caseObj.evidenceTurnIds);
    const scores = rec.scored.map((s) => s.score);
    if (scores.length > 1) {
      const top = Math.max(...scores);
      const bottom = Math.min(...scores);
      perQuerySpread.push({ spread: top - bottom, q: caseId });
    }
    for (const s of rec.scored) {
      const id = rec.order[s.i]?.rec;
      (id && ev.has(id) ? gold : noise).push(s.score);
    }
  }
  const q = (arr, p) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  };
  // AUC = P(gold 分 > noise 分)（并列计 0.5）
  let win = 0, tie = 0, pairs = 0;
  for (const g of gold) for (const n of noise) { pairs++; if (g > n) win++; else if (g === n) tie++; }
  const spreads = perQuerySpread.map((x) => x.spread);
  return {
    nGold: gold.length, nNoise: noise.length,
    gold: { median: q(gold, 0.5), p25: q(gold, 0.25), p75: q(gold, 0.75), max: q(gold, 1), min: q(gold, 0) },
    noise: { median: q(noise, 0.5), p25: q(noise, 0.25), p75: q(noise, 0.75), max: q(noise, 1), min: q(noise, 0) },
    auc: pairs ? (win + tie * 0.5) / pairs : null,
    spread: { median: q(spreads, 0.5), p10: q(spreads, 0.1), p90: q(spreads, 0.9) },
  };
}

const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");

const floorsArg = arg("floors", undefined);
const floors = typeof floorsArg === "string"
  ? floorsArg.split(",").map(Number).filter(Number.isFinite)
  : [-20, -14, -12, -10.5, -9, -8.5, -7.5, -7, -6, -5, -4, -3, -2, -1, 0];

const out = {
  dump: path.basename(dumpPath),
  result: typeof resultPath === "string" ? path.basename(resultPath) : null,
  questions: byCase.size,
  floor: [],
  prob: [],
  margin: [],
  quantile: [],
};

for (const f of floors) out.floor.push(evaluate({ type: "floor", value: f }, String(f)));
for (const p of [0.1, 0.2, 0.3, 0.5, 0.7]) out.prob.push(evaluate({ type: "prob", value: p }, "p=" + p + "（logit " + logitOfP(p).toFixed(2) + "）"));
for (const m of [2, 3, 4, 5, 6, 8]) out.margin.push(evaluate({ type: "margin", m }, "top-" + m));
for (const q of [0.25, 0.33, 0.5, 0.75, 1.0]) out.quantile.push(evaluate({ type: "quantile", q }, "top " + Math.round(q * 100) + "%"));

const table = (rows, head) => {
  const L = ["| " + head + " | kept 比例 | 误滤 gold | 误滤 gold 题数 | 丢弃噪声行 | turnCov@5 | turnCov(注入) |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    L.push(`| ${r.label} | ${pct(r.keptRatio)} | ${pct(r.goldFalseFilter)}（${r.goldDropped}/${r.goldInPool}） | ${r.qWithGoldDropped}/${r.qTotal} | ${r.noiseDropped} | ${pct(r.turnCov5)} | ${pct(r.turnCovInjected)} |`);
  }
  return L.join("\n");
};

console.log("# #144 rerank floor 校准（离线重算，filter 语义：保原序只剔除）\n");
console.log("- 转储：" + out.dump + (out.result ? "；结构行前缀取自：" + out.result : "；（未给 --result，turnCov@5 只按经验行计）"));
console.log(`- 召回行→turn id 解析率：${(unresolved.rows / Math.max(unresolved.total, 1) * 100).toFixed(1)}%（${unresolved.rows}/${unresolved.total}；未解析行不参与 gold 统计）`);
console.log("- 题数：" + out.questions + "；候选总数：" + [...byCase.values()].reduce((a, r) => a + r.order.length, 0) + "\n");
const disc = scoreDiscrimination();
out.discrimination = disc;
const f3 = (v) => (v === null || v === undefined ? "-" : Number(v).toFixed(3));
console.log("## 分数可判别性（gold vs 噪声，同一 provider 原始分量纲）\n");
console.log(`- 样本：gold ${disc.nGold} 行 / 噪声 ${disc.nNoise} 行；**AUC=${f3(disc.auc)}**（0.5=毫无判别力，1=完美可分）`);
console.log(`- gold 分数：min ${f3(disc.gold.min)} / p25 ${f3(disc.gold.p25)} / 中位 ${f3(disc.gold.median)} / p75 ${f3(disc.gold.p75)} / max ${f3(disc.gold.max)}`);
console.log(`- 噪声分数：min ${f3(disc.noise.min)} / p25 ${f3(disc.noise.p25)} / 中位 ${f3(disc.noise.median)} / p75 ${f3(disc.noise.p75)} / max ${f3(disc.noise.max)}`);
console.log(`- 题内分差（top1−bottom）：p10 ${f3(disc.spread.p10)} / 中位 ${f3(disc.spread.median)} / p90 ${f3(disc.spread.p90)}\n`);
console.log(table(out.floor, "floor"));
console.log("\n## sigmoid 校准概率阈值（p → logit 等价 floor）\n");
console.log(table(out.prob, "阈值"));
console.log("\n## 标度稳健规则 A：相对 top-1 的 margin\n");
console.log(table(out.margin, "margin"));
console.log("\n## 标度稳健规则 B：按题内分位裁剪\n");
console.log(table(out.quantile, "分位"));

const outPath = String(arg("out", "")).trim() || path.join(path.dirname(dumpPath), path.basename(dumpPath, ".jsonl") + "-floor-calibration.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("\n[json] " + outPath);