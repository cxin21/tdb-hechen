#!/usr/bin/env node
/**
 * B0（bench/recall-opt）：LongMemEval 分层抽样 manifest 生成器。
 *
 * 规则（可复现，禁止“手挑”）：
 *   - 按题型分层：全量题型 × 每型 N 题（缺省 15）；
 *   - 每层内 caseId 字典序 → mulberry32(seed) 洗牌 → 取前 N；
 *   - 输出 MemoryCore/.eval-data/bench/lme-manifest.json（caseIds 顺序即运行序，
 *     按题型分块排列，便于按题型切片读数）。
 *
 * 用法：node scripts/bench-manifest.mjs [--per-type 15] [--seed 20261027] [--out <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { loadDataset, summarizeDataset } from "./lib/bench/datasets.mjs";
import { repoRoot } from "./lib/bench/store.mjs";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const perType = Number(arg("per-type", 15));
const seed = Number(arg("seed", 20261027));
const repo = repoRoot();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultDataPath() {
  for (const root of [path.resolve(repo, ".."), repo]) {
    for (const n of ["longmemeval_oracle.json", "longmemeval_s.json"]) {
      const p = path.join(root, ".eval-data", n);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("找不到 longmemeval 数据文件，请用 --data 指定");
}

const dataPath = String(arg("data", defaultDataPath()));
const ds = loadDataset("longmemeval", dataPath);

/** 分层：型内 caseId 字典序固定底序，seed 洗牌取前 perType（不足全取）。 */
const byType = {};
for (const c of ds.cases) (byType[c.questionType] ||= []).push(c.caseId);
const types = Object.keys(byType).sort();
const rand = mulberry32(seed);
const caseIds = [];
const perTypeCounts = {};
for (const t of types) {
  const pool = byType[t].sort();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const pick = pool.slice(0, perType);
  perTypeCounts[t] = pick.length;
  caseIds.push(...pick);
}

const manifest = {
  name: "lme-bench-sample",
  version: 1,
  dataset: "longmemeval",
  dataFile: path.basename(dataPath),
  generatedAt: new Date().toISOString(),
  seed,
  perType,
  perTypeCounts,
  total: caseIds.length,
  rule: "型内 caseId 字典序 + mulberry32(seed) 洗牌取前 N；顺序=运行序（按题型分块）",
  caseIds,
};

const out = String(arg("out", path.join(repo, ".eval-data", "bench", "lme-manifest.json")));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[manifest] ${out}: ${manifest.total} 题（${types.length} 型 × ${perType}）seed=${seed}`);
console.log(`[manifest] 全量分布: ${JSON.stringify(summarizeDataset(ds).byType)}`);
console.log(`[manifest] 抽样分布: ${JSON.stringify(perTypeCounts)}`);
