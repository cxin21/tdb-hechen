// #85 Q1 FTS 门标定脚本（2026-10-25）——方法学循 #80 先例：「真实数据 → 两类分布 →
// 孤立峰间隙 + 安全边距 → 阈值」（#80: 已知重复对 0.508/0.459 vs 自然新增 0.021~0.098 → 0.4）。
//
// 与 replay.mjs 的关系：replay 扫 (typeWeights×relGate×absGate×router) 选注入工作点；
// 本脚本专门标定**分数门**的阈值刻度：
//   - minInjectFtsScore（纯 FTS 命中，hop=0 weightedFuse 融合分 [0,1] 刻度）；
//   - minInjectAbsScore（双通道命中，1/distance 刻度；复核 1.5 在当前语料上的鸿沟）。
// 数据源：queries.jsonl 真值标注（should_recall / should_not_recall）× 线上引擎实时检索。
// 引擎：env KS_BASE（默认 http://127.0.0.1:8421）/ SERVICE_ID（默认 default）/
//       TEAM_ID（默认 team-2k12lgb650）——必须与被标定部署同一语料。
// 归档：runs/<ISO>-fts-gate.json（gitSha + 语料指纹 + 逐 query 快照 + 分布 + 建议）。
//
// 用法：node docs/superpowers/evals/recall-golden/fts-gate-calib.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = (process.env.KS_BASE ?? "http://127.0.0.1:8421/v3").replace(/\/$/, "");
const SERVICE_ID = process.env.SERVICE_ID ?? "default";
const TEAM_ID = process.env.TEAM_ID ?? "team-2k12lgb650";
const LIMIT = 8;
const HERE = dirname(fileURLToPath(import.meta.url));
const STRUCTURAL = new Set(["index", "schema", "purpose", "overview", "log"]);

const GOLDEN = readFileSync(join(HERE, "queries.jsonl"), "utf8")
  .trim().split(/\r?\n/).map((line) => JSON.parse(line));
const canon = (s) => String(s).toLowerCase().replace(/[-+/_\s]+/g, "");
const matchesAny = (title, terms) => (terms ?? []).some((t) => canon(title).includes(canon(t)));

async function post(path, body) {
  const resp = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tdai-service-id": SERVICE_ID },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok || (j && j.code !== 0)) throw new Error(path + " -> " + resp.status + " " + JSON.stringify(j)?.slice(0, 200));
  return j?.data;
}

async function search(kid, q) {
  try {
    const data = await post("/wiki/search", { wiki_id: kid, query: q, limit: LIMIT });
    return (data?.results ?? []).map((x) => ({
      title: String(x.title ?? ""), type: String(x.type ?? "other"),
      score: Number(x.score ?? 0), absScore: x.absScore == null ? undefined : Number(x.absScore),
    }));
  } catch (e) {
    console.error("search fail", kid, q, String(e).slice(0, 120));
    return [];
  }
}

function dist(scores) {
  if (scores.length === 0) return null;
  const s = [...scores].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

// 孤立峰间隙：若 max(noise) < min(rel)，间隙 = [maxNoise, minRel]，阈值取中点（安全边距=两侧距离）。
function suggestThreshold(relScores, noiseScores) {
  if (relScores.length === 0 || noiseScores.length === 0) {
    return { gap: false, reason: "insufficient labeled data on this corpus/channel" };
  }
  const maxNoise = Math.max(...noiseScores), minRel = Math.min(...relScores);
  if (maxNoise < minRel) {
    const t = Number((((maxNoise + minRel) / 2)).toFixed(2));
    return { gap: true, threshold: t, maxNoise, minRel, marginLow: Number((t - maxNoise).toFixed(3)), marginHigh: Number((minRel - t).toFixed(3)) };
  }
  return { gap: false, reason: "classes overlap on this corpus", maxNoise, minRel };
}

const gitSha = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: join(HERE, "../../..") }).toString().trim(); } catch { return "unknown"; } })();
const corpusHash = createHash("sha256").update(readFileSync(join(HERE, "queries.jsonl"))).digest("hex").slice(0, 12);

const list = await post("/wiki/list", { team_id: TEAM_ID });
const wikis = (list?.items ?? []).filter((w) => w.enabled !== false);
console.log(`corpus: base=${BASE} svc=${SERVICE_ID} team=${TEAM_ID} wikis=${wikis.map((w) => w.name + "(" + w.wiki_id + ", " + w.page_count + "p)").join(", ")}`);
if (wikis.length === 0) { console.error("no enabled wikis — wrong base/service/team?"); process.exit(2); }

const perQuery = [];
const buckets = { ftsBody: { rel: [], neg: [] }, dual: { rel: [], neg: [] }, ftsStructural: { rel: [], neg: [] } };
let relHitCount = 0, relExpect = 0;
for (const g of GOLDEN) {
  const snap = { id: g.id, q: g.query, hits: [] };
  for (const w of wikis) {
    for (const h of await search(w.wiki_id, g.query)) {
      const cls = matchesAny(h.title, g.should_recall) ? "rel" : matchesAny(h.title, g.should_not_recall) ? "neg" : "unlabeled";
      if (cls === "rel") relHitCount++;
      const structural = STRUCTURAL.has(h.type);
      const bucket = h.absScore === undefined ? (structural ? "ftsStructural" : "ftsBody") : "dual";
      if (cls !== "unlabeled") buckets[bucket][cls].push(h.absScore === undefined ? h.score : h.absScore);
      snap.hits.push({ wiki: w.name, ...h, cls, bucket });
    }
  }
  relExpect += (g.should_recall ?? []).length;
  perQuery.push(snap);
}

console.log(`\ncorpus-match: relLabeledHit=${relHitCount}/${relExpect}（0 = 语料与标注不匹配，勿用本次结论）`);
const ftsBodyRel = buckets.ftsBody.rel, ftsBodyNeg = buckets.ftsBody.neg;
const dualRel = buckets.dual.rel, dualNeg = buckets.dual.neg;
console.log("\n== FTS-only 正文命中（minInjectFtsScore 刻度：weightedFuse [0,1]） ==");
console.log("rel :", JSON.stringify(dist(ftsBodyRel)));
console.log("neg :", JSON.stringify(dist(ftsBodyNeg)));
const ftsSug = suggestThreshold(ftsBodyRel, ftsBodyNeg);
console.log("suggestion:", JSON.stringify(ftsSug));
console.log("\n== 双通道命中（minInjectAbsScore 刻度：1/distance；复核 1.5） ==");
console.log("rel :", JSON.stringify(dist(dualRel)));
console.log("neg :", JSON.stringify(dist(dualNeg)));
const absSug = suggestThreshold(dualRel, dualNeg);
console.log("suggestion:", JSON.stringify(absSug));
console.log("\n== FTS-only 结构页（附尾通道，不计分母） ==");
console.log("rel :", JSON.stringify(dist(buckets.ftsStructural.rel)));
console.log("neg :", JSON.stringify(dist(buckets.ftsStructural.neg)));

mkdirSync(join(HERE, "runs"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = {
  script: "fts-gate-calib.mjs (#85 Q1)", at: new Date().toISOString(), gitSha, corpusHash,
  base: BASE, serviceId: SERVICE_ID, teamId: TEAM_ID, wikis: wikis.map((w) => ({ id: w.wiki_id, name: w.name, pages: w.page_count })),
  corpusMatch: { relLabeledHit: relHitCount, relExpect },
  distributions: { ftsBody: { rel: dist(ftsBodyRel), neg: dist(ftsBodyNeg) }, dual: { rel: dist(dualRel), neg: dist(dualNeg) }, ftsStructural: { rel: dist(buckets.ftsStructural.rel), neg: dist(buckets.ftsStructural.neg) } },
  suggestions: { minInjectFtsScore: ftsSug, minInjectAbsScore: absSug },
  perQuery,
};
const out = join(HERE, "runs", `${stamp}-fts-gate.json`);
writeFileSync(out, JSON.stringify(archive, null, 1));
console.log("\narchived:", out);
