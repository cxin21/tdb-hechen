/**
 * 灌库前的「事实抽取 + 结论卡蒸馏」阶段（issue #139 第2项去重）。
 *
 * 背景：eval-memory-bench.mjs 的灌库主循环与 --store 分阶段写入分支各抄了一份
 * 「抓 facts + 抓 conclusions + 累加计数」约 35 行，且两处语义已经漂移：
 *  - 主循环只在非缓存命中时累加 extractMs/usage；
 *  - 分阶段分支**完全没累加 conclusionStats.ms**（票面第2项点名的漏记）。
 *
 * 收敛契约（本模块是唯一实现）：
 *  1. 取数：wantFacts / wantConclusions 决定跑哪段，未启用则对应字段为 null（零外呼）；
 *  2. 计数：mergeStageStats 对缓存命中与实抽一律累加 usage（#139 第4项：缓存档 token 可测），
 *     并按 usageSource（live/cache/estimated-cache/none）分桶留痕，绝不把估算当真值；
 *  3. 耗时：conclusion 蒸馏耗时无论命中与否都累加（命中即 0），两条分支行为一致。
 */

import { factsForCase } from "./facts.mjs";
import { conclusionsForCase } from "./conclusions.mjs";

/** 两段统计的初始形状（报告 config.factExtraction.stats / conclusionCards.stats 直接用）。 */
export function createStageStats() {
  return {
    facts: {
      groups: 0,
      cacheHits: 0,
      turns: 0,
      turnsWithFacts: 0,
      phrases: 0,
      extractMs: 0,
      failedBatches: 0,
      usage: { prompt: 0, completion: 0 },
      usageBySource: {},
    },
    conclusions: {
      groups: 0,
      cacheHits: 0,
      cards: 0,
      ms: 0,
      failed: 0,
      usage: { prompt: 0, completion: 0 },
      usageBySource: {},
    },
  };
}

/** 把一次取数的 usage 记账（总账 + 来源分桶）。 */
function addUsage(stat, usage, source) {
  if (!usage) return;
  const prompt = Number(usage.prompt) || 0;
  const completion = Number(usage.completion) || 0;
  stat.usage.prompt += prompt;
  stat.usage.completion += completion;
  const src = source || "none";
  const bucket = (stat.usageBySource[src] ??= { calls: 0, prompt: 0, completion: 0 });
  bucket.calls++;
  bucket.prompt += prompt;
  bucket.completion += completion;
}

/**
 * 抓一个语料组的事实与结论卡（缓存优先；未启用段返回 null）。
 *
 * @param {object} p
 * @param {object} p.caseObj 语料组（含 groups/turns/caseId/tenant）
 * @param {string} [p.factCacheDir] 缓存根目录（facts/ 与 conclusions/ 子目录）
 * @param {object} [p.llm] makeLlm 客户端（缓存未命中时才需要）
 * @param {string} [p.model] 抽取/蒸馏模型（缓存口径键）
 * @param {boolean} [p.wantFacts] 是否抽事实
 * @param {boolean} [p.wantConclusions] 是否蒸结论卡
 * @param {number} [p.factBatchSize=20]
 * @param {number} [p.factConcurrency=8]
 * @param {number} [p.conclusionMax=4]
 * @param {{warn?:Function}} [p.logger]
 * @returns {Promise<{facts: object|null, conclusions: object|null, ms: number}>}
 */
export async function fetchFactsAndConclusions({
  caseObj,
  factCacheDir,
  llm,
  model,
  wantFacts = false,
  wantConclusions = false,
  factBatchSize = 20,
  factConcurrency = 8,
  conclusionMax = 4,
  logger,
}) {
  const t0 = Date.now();
  const out = { facts: null, conclusions: null, ms: 0 };
  if (wantFacts) {
    out.facts = await factsForCase({
      caseObj,
      cacheDir: factCacheDir,
      llm,
      model,
      batchSize: factBatchSize,
      concurrency: factConcurrency,
      logger,
    });
  }
  if (wantConclusions) {
    out.conclusions = await conclusionsForCase({
      caseObj,
      cacheDir: factCacheDir,
      llm,
      model,
      maxCards: conclusionMax,
      logger,
    });
  }
  out.ms = Date.now() - t0;
  return out;
}

/**
 * 把一次取数结果并进统计（缓存命中与实抽同一口径）。
 * @param {object} stats createStageStats() 的产物
 * @param {{facts?: object|null, conclusions?: object|null}} fetched
 * @returns {object} stats（原地更新并返回）
 */
export function mergeStageStats(stats, { facts = null, conclusions = null } = {}) {
  if (facts) {
    const s = stats.facts;
    s.groups++;
    if (facts.cacheHit) s.cacheHits++;
    s.extractMs += facts.ms ?? 0;
    if (facts.failedBatches) s.failedBatches += facts.failedBatches;
    // #139 第4项：缓存档也带 usage（estimated-cache 或 cache），一律入账。
    addUsage(s, facts.usage, facts.usageSource);
    const cov = facts.coverage ?? { turns: 0, turnsWithFacts: 0, phrases: 0 };
    s.turns += cov.turns ?? 0;
    s.turnsWithFacts += cov.turnsWithFacts ?? 0;
    s.phrases += cov.phrases ?? 0;
  }
  if (conclusions) {
    const s = stats.conclusions;
    s.groups++;
    if (conclusions.cacheHit) s.cacheHits++;
    s.cards += conclusions.cards?.length ?? 0;
    // 耗时无论是否命中都累加（命中 0）——旧分阶段分支漏记此项。
    s.ms += conclusions.ms ?? 0;
    if (conclusions.failed) s.failed++;
    addUsage(s, conclusions.usage, conclusions.usageSource);
  }
  return stats;
}

/**
 * 门禁3 的 token 预算判定（#139 第4项）。
 *
 * 判定与展示必须分离：估算只该影响展示后缀「（估算口径）」，绝不能改变 verdict
 * ——否则 "FAIL（估算口径）" !== "FAIL"，failed 不累加 → 门禁 exit 0 假绿。
 * @returns {{verdict:"PASS"|"FAIL"|"SKIP", perTurn:number}}
 */
export function judgeTokenBudget({ tokens, turns, budgetTokensPerTurn }) {
  const total = Number(tokens);
  if (!(total > 0)) return { verdict: "SKIP", perTurn: 0 };
  // turns=0 却报出 token：统计缺失（旧报告 / 分阶段字段没补），此时除零退化成
  // perTurn=tokens 会把本该 SKIP 的档判成 FAIL（假红）。显式 SKIP 并让调用方告警。
  if (!(Number(turns) > 0)) return { verdict: "SKIP", perTurn: 0, reason: "turns-missing" };
  const perTurn = total / Number(turns);
  return { verdict: perTurn <= budgetTokensPerTurn ? "PASS" : "FAIL", perTurn };
}

/** 报告用：token 总量与"有估算参与"标记（门禁据此区分真值与估算）。 */
export function tokenEvidence(stat) {
  const prompt = stat?.usage?.prompt ?? 0;
  const completion = stat?.usage?.completion ?? 0;
  const total = prompt + completion;
  const bySource = stat?.usageBySource ?? {};
  // 任何来源名里带 estimated 的桶都算估算（estimated-cache / estimated-live），
  // 外加 mixed = 同一档里部分批 reported、部分批 estimated（facts.mjs 新增）——
  // mixed 若两边都不计，门禁会把「估算冒充计费事实」，故保守计入 estimatedCalls。
  const sum = (pred) =>
    Object.keys(bySource)
      .filter(pred)
      .reduce((n, k) => n + (bySource[k]?.calls ?? 0), 0);
  const mixedCalls = bySource["mixed"]?.calls ?? 0;
  const estimatedCalls = sum((k) => k.includes("estimated")) + mixedCalls;
  const liveCalls = bySource["live"]?.calls ?? 0;
  const cacheCalls = bySource["cache"]?.calls ?? 0;
  return { prompt, completion, total, estimatedCalls, mixedCalls, liveCalls, cacheCalls, hasEstimated: estimatedCalls > 0 };
}
