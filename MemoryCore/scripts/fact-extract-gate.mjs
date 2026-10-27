/**
 * W1（issue #134）抽样验收门禁：抽取准确率低于阈值 → 整体不启用。
 *
 * 文档 B3 警告：抽不好的噪声事实是负收益。启用双写前，从 facts-cache 里
 * 固定 seed 抽样 N 个 turn，让 judge LLM 逐条判定「该事实是否被 turn 原文明确支持、
 * 有无虚构」，accuracy = 支持条数 / 总条数；低于 --threshold（缺省 0.9）退出码 1。
 *
 * 用法：
 *   node --import tsx scripts/fact-extract-gate.mjs --dataset longmemeval \
 *     --manifest .eval-data/bench/lme-manifest.json \
 *     --cache .eval-data/bench/facts-cache --sample 40 --threshold 0.9 \
 *     --prod-config tdai-gateway.yaml --prod-data ../data
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadDataset } from "./lib/bench/datasets.mjs";
import { makeLlm } from "./lib/bench/llm.mjs";
import { readFactsCacheFile, FACTS_PROMPT_VERSION } from "./lib/bench/facts.mjs";
import { readLlmCredential } from "./lib/read-llm-credential.ts";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let _yaml;
function require_yaml() {
  if (!_yaml) _yaml = createRequire(import.meta.url)("yaml");
  return _yaml;
}

const datasetName = String(arg("dataset", "longmemeval")).toLowerCase();
const cacheDir = String(arg("cache", path.join(repo, ".eval-data", "bench", "facts-cache")));
const sampleN = Number(arg("sample", 40));
const seed = Number(arg("seed", 20261027));
const threshold = Number(arg("threshold", 0.9));
const concurrency = Number(arg("concurrency", 2));
const outDir = String(arg("out", path.join(repo, ".eval-data", "bench")));

function defaultDataPath(name) {
  const names = { longmemeval: ["longmemeval_oracle.json", "longmemeval_s.json"], locomo: ["locomo10.json"] }[name] || [];
  const roots = [path.resolve(repo, ".."), repo];
  for (const r of roots) for (const n of names) {
    const c = path.join(r, ".eval-data", n);
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到数据文件，请用 --data 指定");
}

/** mulberry32：固定 seed 可复现抽样（与 manifest 同纪律）。 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERIFY_PROMPT = [
  "You are auditing auto-extracted facts for a memory index.",
  "For each numbered fact, decide whether the turn text EXPLICITLY supports it.",
  "supported=false if the fact adds information not stated, distorts numbers/dates/names/units, or overgeneralizes.",
  "Output JSON only:",
  '{"verdicts":[{"index":1,"supported":true|false,"reason":"<short>"}]}',
].join("\n");

async function verifyTurn(llm, text, phrases) {
  const lines = phrases.map((p, i) => `${i + 1}. ${p}`);
  // 429 退避重试（端点 Token Plan 速率限制）：5s/15s/30s。
  let res = null;
  let lastErr = null;
  const messages = [
    { role: "system", content: VERIFY_PROMPT },
    { role: "user", content: `Turn text:\n${text}\n\nExtracted facts:\n${lines.join("\n")}\n\nReturn one verdict per fact.` },
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await llm.json(messages, { maxTokens: 0 });
      if (res) break;
      lastErr = new Error("empty/unparsable verdicts");
    } catch (e) {
      lastErr = e;
      if (!/429|rate.?limit/i.test(String(e?.message ?? e))) throw e;
    }
    await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt] ?? 30000));
  }
  if (!res) throw lastErr ?? new Error("verify failed");
  const verdicts = Array.isArray(res?.verdicts) ? res.verdicts : [];
  const byIndex = new Map();
  for (const v of verdicts) {
    if (!v || typeof v.index !== "number") continue;
    byIndex.set(v.index, { supported: v.supported === true, reason: String(v.reason ?? "").slice(0, 200) });
  }
  return phrases.map((p, i) => ({ phrase: p, ...(byIndex.get(i + 1) ?? { supported: null, reason: "verdict-missing" }) }));
}

async function runPool(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const dataPath = String(arg("data", defaultDataPath(datasetName)));
  const ds = loadDataset(datasetName, dataPath, { samples: 0 });
  const manifestArg = arg("manifest", undefined);
  let cases = ds.cases;
  if (manifestArg && manifestArg !== true) {
    const manifest = JSON.parse(fs.readFileSync(String(manifestArg), "utf8"));
    const ids = manifest.caseIds ?? manifest;
    const byId = new Map(ds.cases.map((c) => [c.caseId, c]));
    cases = ids.map((id) => byId.get(id)).filter(Boolean);
  }

  // turnId → { text, caseId }（与抽取器看到的输入一致：turn.text）
  const turnIndex = new Map();
  for (const c of cases) for (const g of c.groups) for (const t of g.turns) turnIndex.set(t.id, { text: t.text, caseId: c.caseId });

  // 抽样：优先抽「有事实」的 turn（验收抽取精度），不足则补空事实 turn 仅作覆盖统计
  const withFacts = [];
  const noFacts = [];
  const cachedCases = [];
  for (const c of cases) {
    const hit = readFactsCacheFile(cacheDir, c.caseId);
    if (!hit) continue;
    cachedCases.push(c.caseId);
    for (const [turnId, f] of Object.entries(hit.byTurn || {})) {
      const t = turnIndex.get(turnId);
      if (!t) continue;
      if (f?.phrases?.length) withFacts.push({ turnId, text: t.text, phrases: f.phrases });
      else noFacts.push({ turnId, text: t.text });
    }
  }
  if (cachedCases.length === 0) throw new Error(`facts-cache 里没有可用样本（cache=${cacheDir}）——先跑 --fact-extract`);

  const rnd = mulberry32(seed);
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const picked = shuffle(withFacts).slice(0, sampleN);

  const prodConfig = String(arg("prod-config", path.join(repo, "tdai-gateway.yaml")));
  // dataDir 解析：--prod-data > yaml data.baseDir > 仓库上级 data/（与 eval-memory-bench 同源）
  let prodDataArg = arg("prod-data", undefined);
  if (typeof prodDataArg !== "string") {
    let yamlBase = null;
    try {
      const y = require_yaml().parse(fs.readFileSync(prodConfig, "utf8")) || {};
      const bd = y?.data?.baseDir;
      if (typeof bd === "string" && bd.trim()) yamlBase = bd.replace(/^~/, process.env.USERPROFILE || process.env.HOME || "~");
    } catch {
      /* yaml 缺失交给 env/override 兜底 */
    }
    prodDataArg = yamlBase ?? path.resolve(repo, "..", "data");
  }
  const cred0 = readLlmCredential({ yamlPath: prodConfig, baseDir: prodDataArg });
  // 审计器模型：--model 覆盖（缺省=生产同款；抽取用小模型时审计仍建议用更强模型）
  const modelArg = arg("model", undefined);
  const cred = typeof modelArg === "string" && modelArg ? { ...cred0, model: modelArg } : cred0;
  const llm = makeLlm(cred);
  console.log("[fact-gate] verify model=" + (cred?.model ?? "?"));

  const results = [];
  await runPool(picked, concurrency, async (s) => {
    try {
      const verdicts = await verifyTurn(llm, s.text, s.phrases);
      results.push({ turnId: s.turnId, text: s.text.slice(0, 300), verdicts });
    } catch (e) {
      results.push({ turnId: s.turnId, text: s.text.slice(0, 300), error: String(e?.message ?? e), verdicts: s.phrases.map((p) => ({ phrase: p, supported: null, reason: "verify-failed" })) });
    }
  });

  let total = 0, supported = 0, unsupported = 0, unknown = 0;
  for (const r of results) for (const v of r.verdicts) {
    total++;
    if (v.supported === true) supported++;
    else if (v.supported === false) unsupported++;
    else unknown++;
  }
  const accuracy = total ? supported / total : 0;
  const pass = accuracy >= threshold && unknown === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    promptVersion: FACTS_PROMPT_VERSION,
    cacheDir,
    seed,
    threshold,
    sampleRequested: sampleN,
    sampleVerified: results.length,
    corpus: { cases: cases.length, cachedCases: cachedCases.length, turnsWithFacts: withFacts.length, turnsWithoutFacts: noFacts.length },
    scored: { total, supported, unsupported, unknown, accuracy },
    pass,
    rows: results.sort((a, b) => String(a.turnId).localeCompare(String(b.turnId))),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(outDir, `fact-gate-${stamp}`);
  fs.writeFileSync(base + ".json", JSON.stringify(report, null, 2), "utf8");
  console.log(`[fact-gate] 样本 ${results.length} turn / ${total} 条事实：支持 ${supported}，不支持 ${unsupported}，未判 ${unknown} → accuracy=${(accuracy * 100).toFixed(1)}%（阈值 ${(threshold * 100).toFixed(0)}%）`);
  console.log(`[fact-gate] 语料覆盖：有事实 turn ${withFacts.length}，无事实 turn ${noFacts.length}（缓存 case ${cachedCases.length}/${cases.length}）`);
  console.log(`[fact-gate] 报告: ${base}.json`);
  if (!pass) {
    console.error(`[fact-gate] 门禁不通过（accuracy<${threshold} 或有未判定事实）→ 抽取质量不达标，双写整体不启用`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[fact-gate] 失败:", e?.message ?? e);
  process.exit(2);
});
