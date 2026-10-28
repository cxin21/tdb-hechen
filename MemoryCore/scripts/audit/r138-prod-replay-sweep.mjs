/**
 * #138 生产语料三档复核（离线重放，只读生产库的副本）：票面验收缺口「灰度窗口内指标表（≥3 档）」的
 * 可执行替代——用生产 journal 里的真实 query 逐条打生产语料库副本，只变 smallToBig.maxExtraLines。
 *
 * 与在线灰度的差别（必须写进结论）：
 *  - 查询来自历史 journal（不是灰度期实时流量），但**同一批 query × 三档 = 配对**，比顺序在线窗口更可比；
 *  - 无 gold 标签 → 只产出结构指标（结论层命中、注入行分布、上下文行占比、经验行分布、延迟、剪枝），
 *    判对仍需 bench（见 docs/optimization-results.md §14.4）。
 *
 * 用法：node scripts/audit/r138-prod-replay-sweep.mjs [--queries 100] [--arms 2,4,6] [--out <json>]
 * 只读：生产 vectors.db 先复制到 .tmp 沙箱再打开；生产库零写入，零外呼给生产网关。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MC = path.resolve(HERE, "../.."); // MemoryCore/
const REPO = path.resolve(MC, "..");
process.chdir(MC);

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const nQueries = Number(arg("queries", 100));
const arms = String(arg("arms", "2,4,6")).split(",").map(Number).filter((x) => Number.isFinite(x));
const outPath = String(arg("out", path.join(MC, ".eval-data", "bench", "r138-prod-replay.json")));
const prodData = "D:/TDB/data";
const logsDir = path.join(prodData, "logs", "recall");
const sandbox = path.join(REPO, ".tmp", "r138-replay");

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const quant = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]);
};

// ── 1) 抽样 query（生产 journal，去重 + 过滤明显非查询的长串/JSON）──
const seen = new Set();
const pool = [];
for (const f of fs.readdirSync(logsDir).filter((x) => x.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(logsDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const q = typeof r.query === "string" ? r.query.trim() : "";
    if (q.length < 8 || q.length > 300) continue;
    if (q.includes("{") || q.includes("}") || q.startsWith("Update the session title")) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ q, tenant: { teamId: r.teamId, userId: r.userId, agentId: r.agentId } });
  }
}
// 确定性抽样：按 sha1 排序取前 N，保证可复现
const queries = pool
  .map((x) => ({ ...x, h: crypto.createHash("sha1").update(x.q).digest("hex") }))
  .sort((a, b) => a.h.localeCompare(b.h))
  .slice(0, nQueries);
const tenant = queries[0]?.tenant ?? { teamId: "default", userId: "", agentId: "default" };
console.log("[replay] 候选 query 池=" + pool.length + "，本次抽样=" + queries.length + "；tenant=" + JSON.stringify(tenant));

// ── 2) 沙箱：复制生产库 + 沙箱 yaml（禁 journal/扩展/生命周期）──
fs.mkdirSync(sandbox, { recursive: true });
const prodDb = path.join(prodData, "vectors.db");
const sandboxDb = path.join(sandbox, "vectors.db");
if (!fs.existsSync(sandboxDb) || fs.statSync(sandboxDb).size !== fs.statSync(prodDb).size) {
  console.log("[replay] 复制生产库 → " + sandboxDb + "（" + Math.round(fs.statSync(prodDb).size / 1048576) + "MB）");
  fs.copyFileSync(prodDb, sandboxDb);
}
const { prepareBenchYaml, loadBenchConfig, openBenchStore, copyOverrideFrom } = await import("../lib/bench/store.mjs");
copyOverrideFrom(prodData, sandbox);
prepareBenchYaml({
  srcYaml: path.join(MC, "tdai-gateway.yaml"),
  storeDir: sandbox,
  smallToBigOverride: { enabled: true, budget: "additive", maxExtraLines: arms[0], relevanceRanked: true },
  conclusionLayerOverride: { routing: "assistantRecall" },
});
const { cfg } = await loadBenchConfig(sandbox);
const { store, embedding } = await openBenchStore(cfg, sandbox);
const { performLayeredRecall } = await import("../../src/core/hooks/auto-recall.ts");

// 精排走子进程（与生产同款本地模型；进程内 onnx 在长跑里会崩）
const { resolveLocalModelDir } = await import("../../src/core/recall/rerank/factory.ts");
const { ChildProcessReranker } = await import("../lib/bench/rerank-child-host.mjs");
const rerankDeps = cfg.recall?.rerank?.enabled && cfg.recall?.rerank?.provider === "local"
  ? {
      reranker: new ChildProcessReranker({
        modelDir: resolveLocalModelDir(cfg.recall.rerank),
        idleUnloadMs: cfg.recall?.rerank?.local?.idleUnloadMs ?? 0,
        timeoutMs: 180_000,
        recycleAfter: 4,
        logger: console,
        filterOnly: false,
        filterFloor: -1e9,
      }),
    }
  : undefined;

const shapeOf = (lines) => {
  const ml = (lines ?? []).map(String);
  const ctx = ml.filter((s) => s.includes("[上下文"));
  const concl = ml.filter((s) => s.startsWith("- [结论") || s.startsWith("- [work_fact"));
  return {
    total: ml.length,
    conclusions: concl.length,
    context: ctx.length,
    experience: Math.max(0, ml.length - concl.length - ctx.length),
  };
};

const results = [];
for (const maxExtra of arms) {
  cfg.recall.smallToBig.maxExtraLines = maxExtra;
  console.log("[replay] arm maxExtraLines=" + maxExtra + " 开始");
  const rows = [];
  for (let i = 0; i < queries.length; i++) {
    const it = queries[i];
    const t0 = performance.now();
    let out;
    try {
      out = await performLayeredRecall({
        userText: it.q,
        sessionKey: "",
        cfg,
        pluginDataDir: sandbox,
        logger: undefined,
        vectorStore: store,
        embeddingService: embedding,
        profileIsolation: { teamId: tenant.teamId, agentId: tenant.agentId },
        isolationFilter: { teamId: it.tenant.teamId ?? tenant.teamId, userId: it.tenant.userId ?? "", agentId: it.tenant.agentId ?? tenant.agentId },
      });
    } catch (e) {
      rows.push({ q: it.q, error: String(e?.message ?? e) });
      continue;
    }
    const shape = shapeOf(out.memoryLines);
    const gates = out.recallGates ?? out.gates ?? null;
    rows.push({
      q: it.q,
      latencyMs: Math.round(performance.now() - t0),
      layered: out.layered === true,
      conclusionCount: out.conclusionCount ?? 0,
      experienceCount: out.experienceCount ?? 0,
      shape,
      rerankKept: gates?.rerank?.kept ?? null,
      rerankDegraded: gates?.rerank?.degraded ?? null,
      s2b: gates?.smallToBig ?? null,
    });
    if ((i + 1) % 20 === 0) console.log("[replay]   " + (i + 1) + "/" + queries.length);
  }
  const ok = rows.filter((r) => !r.error);
  const lat = ok.map((r) => r.latencyMs);
  const kept = ok.map((r) => r.rerankKept).filter((v) => typeof v === "number");
  const arm = {
    maxExtraLines: maxExtra,
    n: ok.length,
    errors: rows.length - ok.length,
    conclusionLayerHitRate: pct(ok.filter((r) => r.shape.conclusions > 0).length, ok.length),
    meanConclusion: mean(ok.map((r) => r.shape.conclusions)),
    meanContext: mean(ok.map((r) => r.shape.context)),
    meanExperience: mean(ok.map((r) => r.shape.experience)),
    meanTotal: mean(ok.map((r) => r.shape.total)),
    experienceLe1Rate: pct(ok.filter((r) => r.shape.experience <= 1).length, ok.length),
    contextTriggerRate: pct(ok.filter((r) => r.shape.context > 0).length, ok.length),
    backfillEligibleRate: pct(ok.filter((r) => (r.s2b?.candidates ?? 0) > 0).length, ok.length),
    rerankKeptLe1Rate: pct(kept.filter((v) => v <= 1).length, kept.length),
    latencyMsP50: quant(lat, 0.5),
    latencyMsP95: quant(lat, 0.95),
  };
  console.log("[replay] arm " + maxExtra + " → " + JSON.stringify(arm));
  results.push({ arm, rows });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), prodData, queries: queries.map((q) => q.q), results }, null, 1), "utf8");
console.log("\n# #138 生产语料三档复核（离线重放，只读）");
console.log("query 抽样: " + queries.length + " 条（生产 journal，配对）；库: " + prodDb + " 副本");
console.log("");
console.log("| maxExtraLines | 结论层命中率 | 结论行/题 | 上下文行/题 | 经验行/题 | 总行/题 | 经验≤1 行率 | 回捞可触发率 | 精排 kept≤1 | 延迟 P50/P95 (ms) |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const { arm: a } of results) {
  console.log(`| ${a.maxExtraLines} | ${a.conclusionLayerHitRate}% | ${a.meanConclusion} | ${a.meanContext} | ${a.meanExperience} | ${a.meanTotal} | ${a.experienceLe1Rate}% | ${a.backfillEligibleRate}% | ${a.rerankKeptLe1Rate}% | ${a.latencyMsP50} / ${a.latencyMsP95} |`);
}
console.log("");
console.log("结果 JSON: " + outPath);
await store.close?.();
process.exit(0);
