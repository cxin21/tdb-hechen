/**
 * #138 结论层↔经验层「槽位竞争」取证（只读）：从 bench 各档 JSON 里还原每题注入行的组成，
 * 回答 maxExtraLines 定档的两个前提——
 *  ① 结论行把经验层挤到几行（零和槽位竞争的实测强度）；
 *  ② 各桶（尤其 single-session-assistant / preference）的 cov 与判对代价是否随挤占同步变化。
 *
 * 用法：node scripts/audit/r138-slot-competition.mjs [--bench .eval-data/bench] [--arms tag=file,...]
 * 只读：只读 bench 结果 JSON，不重跑、不外呼。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../.."); // MemoryCore/

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const benchDir = path.resolve(process.cwd(), String(arg("bench", path.join(REPO_ROOT, ".eval-data", "bench"))));
const BUCKETS = [
  "knowledge-update",
  "multi-session",
  "single-session-assistant",
  "single-session-preference",
  "single-session-user",
  "temporal-reasoning",
];

// 缺省档：基线 / W3×2 / W3×4 / #137 精排修复(blend0.9) / #137 全开-rerank-off
const DEFAULT_ARMS = [
  "b1off-mm=longmemeval-oracle-2026-10-27T05-35-29.json",
  "w3x2=longmemeval-oracle-2026-10-27T04-33-21.json",
  "w3x4=longmemeval-oracle-2026-10-27T04-55-56.json",
  "r137fix=longmemeval-oracle-2026-10-27T23-58-21.json",
  "r137norerank=longmemeval-oracle-2026-10-27T14-36-26.json",
];
const armsArg = String(arg("arms", ""));
// #138 自动发现：tag 以 r138- 开头的档（跑批产物名带时间戳，逐次不同，不写死文件名）
const DISCOVER_PREFIX = String(arg("discover", "r138-"));
function discoverArms(prefix) {
  const found = [];
  if (!fs.existsSync(benchDir)) return found;
  for (const f of fs.readdirSync(benchDir).filter((x) => /^longmemeval-oracle-.*\.json$/.test(x))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(benchDir, f), "utf8"));
      const tag = j?.config?.tag;
      if (typeof tag === "string" && tag.startsWith(prefix) && Array.isArray(j.rows) && j.rows.length >= 80) {
        found.push({ tag, file: f, at: String(j.generatedAt ?? "") });
      }
    } catch { /* 坏文件跳过 */ }
  }
  // 同 tag 可能重跑多次 → 取最新一个
  const latest = new Map();
  for (const a of found.sort((x, y) => x.at.localeCompare(y.at))) latest.set(a.tag, a);
  return [...latest.values()];
}
const armSpecs = armsArg
  ? armsArg.split(",").map((s) => {
      const [tag, file] = s.includes("=") ? s.split("=") : [s, s];
      return { tag, file };
    })
  : [...DEFAULT_ARMS.map((s) => {
      const [tag, file] = s.split("=");
      return { tag, file };
    }), ...discoverArms(DISCOVER_PREFIX).map(({ tag, file }) => ({ tag, file }))];

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor((s.length - 1) / 2)] * 100) / 100;
};

const lines = [];
for (const { tag, file } of armSpecs) {
  const p = path.join(benchDir, path.basename(file));
  if (!fs.existsSync(p)) { lines.push({ tag, error: "missing " + p }); continue; }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const rows = j.rows ?? [];
  const per = rows.map((r) => {
    const ev = String(r.evidence ?? "");
    const ctxN = (ev.match(/\[上下文/g) ?? []).length;
    return {
      type: r.questionType,
      cc: Number(r.conclusionCount ?? 0),
      ec: Number(r.experienceCount ?? 0),
      ctxN,
      total: Number(r.conclusionCount ?? 0) + Number(r.experienceCount ?? 0),
      cov5: r["turnCov@5"] ?? null,
      // genCorrect 在不同档里可能是 boolean 或 0/1（历史产物口径不一）——统一归一
      gen: r.genCorrect === true || r.genCorrect === 1 ? 1 : r.genCorrect === false || r.genCorrect === 0 ? 0 : null,
      refused: r.refused === true ? 1 : 0,
      kept: r.gates?.rerank?.kept,
      blend: r.gates?.rerank?.blend,
    };
  });
  const arm = {
    tag,
    file: path.basename(file),
    n: rows.length,
    config: {
      conclusionCards: j.config?.conclusionCards ?? null,
      rerankBlend: j.config?.rerankOverride?.blend ?? null,
      candidateK: j.config?.candidateK ?? null,
    },
    overall: {
      turnCov5: pct(per.reduce((a, r) => a + (r.cov5 ?? 0), 0), per.length),
      gen: pct(per.filter((r) => r.gen === 1).length, per.filter((r) => r.gen !== null).length),
      refused: pct(per.reduce((a, r) => a + r.refused, 0), per.length),
      meanConclusion: mean(per.map((r) => r.cc)),
      meanExperience: mean(per.map((r) => r.ec)),
      meanContext: mean(per.map((r) => r.ctxN)),
      meanTotal: mean(per.map((r) => r.total)),
      hardCapRate: pct(per.filter((r) => r.total >= 5).length, per.length),
      starvedRate: pct(per.filter((r) => r.ec <= 1).length, per.length),
      ctxTriggerRate: pct(per.filter((r) => r.ctxN > 0).length, per.length),
      kept1Rate: pct(per.filter((r) => typeof r.kept === "number" && r.kept <= 1).length, per.filter((r) => typeof r.kept === "number").length),
    },
    buckets: Object.fromEntries(
      BUCKETS.map((b) => {
        const br = per.filter((r) => r.type === b);
        return [
          b,
          {
            n: br.length,
            turnCov5: pct(br.reduce((a, r) => a + (r.cov5 ?? 0), 0), br.length),
            gen: pct(br.filter((r) => r.gen === 1).length, br.filter((r) => r.gen !== null).length),
            meanExperience: mean(br.map((r) => r.ec)),
            starvedRate: pct(br.filter((r) => r.ec <= 1).length, br.length),
          },
        ];
      }),
    ),
  };
  lines.push(arm);
}

const ok = lines.filter((a) => !a.error);
const base = ok.find((a) => a.tag === "b1off-mm") ?? ok[0];

console.log("# #138 结论层↔经验层槽位竞争取证（bench 只读）");
console.log("");
console.log("| 档 | 结论行/题 | 上下文行/题 | 经验行/题 | 总行/题 | 触帽率 | 经验≤1 行率 | kept≤1 | turnCov@5 | 判对 | 拒答 |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const a of ok) {
  const o = a.overall;
  console.log(`| ${a.tag} | ${o.meanConclusion} | ${o.meanContext} | ${o.meanExperience} | ${o.meanTotal} | ${o.hardCapRate}% | ${o.starvedRate}% | ${o.kept1Rate ?? "-"}% | ${o.turnCov5}% | ${o.gen ?? "-"}% | ${o.refused}% |`);
}
console.log("");
console.log("## 分桶判对（gen，逐桶 15 题：±1 题 = ±6.7pp，只看方向）");
console.log("");
console.log("| 桶 | " + ok.map((a) => a.tag).join(" | ") + " |");
console.log("|---|" + ok.map(() => "---").join("|") + "|");
for (const b of BUCKETS) {
  const cells = ok.map((a) => {
    const x = a.buckets[b];
    return `${x.gen ?? "-"}% (cov ${x.turnCov5}%)`;
  });
  console.log(`| ${b} | ` + cells.join(" | ") + " |");
}
console.log("");
console.log("> cov@5 口径注意：additive 档注入行数可达 maxResults+maxExtraLines（≈7 行），turnCov@5 只数前 5 行，");
console.log("> 对 additive 档系统性不利——定档以「判对」为主、cov 作形状参考。");
console.log("");
console.log("## 分桶（经验行被挤占 vs cov）");
console.log("");
console.log("| 桶 | " + ok.map((a) => a.tag).join(" | ") + " |");
console.log("|---|" + ok.map(() => "---").join("|") + "|");
for (const b of BUCKETS) {
  const cells = ok.map((a) => {
    const x = a.buckets[b];
    return `exp ${x.meanExperience} / cov ${x.turnCov5}% / 判对 ${x.gen ?? "-"}%`;
  });
  console.log(`| ${b} | ` + cells.join(" | ") + " |");
}
console.log("");
if (base) {
  console.log("## 相对基线（" + base.tag + "）的 Δ");
  console.log("");
  console.log("| 档 | ΔturnCov@5 | Δ判对 | 桶方向（cov Δ） |");
  console.log("|---|---|---|---|");
  for (const a of ok) {
    if (a === base) continue;
    const dCov = Math.round((a.overall.turnCov5 - base.overall.turnCov5) * 10) / 10;
    const dGen = a.overall.gen !== null && base.overall.gen !== null ? Math.round((a.overall.gen - base.overall.gen) * 10) / 10 : "-";
    const dirs = BUCKETS.map((b) => {
      const d = Math.round((a.buckets[b].turnCov5 - base.buckets[b].turnCov5) * 10) / 10;
      return (d > 0 ? "+" : "") + d;
    }).join(" / ");
    console.log(`| ${a.tag} | ${dCov > 0 ? "+" : ""}${dCov}pp | ${dGen === "-" ? "-" : (dGen > 0 ? "+" : "") + dGen + "pp"} | ${dirs} |`);
  }
  console.log("");
  console.log("桶顺序: " + BUCKETS.join(" / "));
}
const json = process.argv.includes("--json");
if (json) console.log(JSON.stringify(lines, null, 1));
