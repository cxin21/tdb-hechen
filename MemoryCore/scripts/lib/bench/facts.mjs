/**
 * W1/W2（issue #134）：事实抽取离线批处理 + 磁盘缓存。
 *
 * 抽取器 = 基准 harness 的配置模型（凭据经 readLlmCredential 单一读取器，
 * 由调用方传入 makeLlm 客户端）——"小模型离线批处理"的 bench 落点：
 * 灌库前按 case 批量抽取，结果落 <cacheDir>/facts/<caseId>.json，跨档复用零重复外呼。
 *
 * 输出形状（by turn id）：
 *   { phrases: string[], triples: [{ subject, predicate, value }] }
 * phrases 进 embedding 键（W1，原文仍是落库载荷）；triples 供写时 supersession（W2）。
 *
 * 纪律：抽取 prompt 明令"只抽该 turn 明说的内容，不推断不补充"；抽不准的噪声由
 * 抽样验收门（scripts/fact-extract-gate.mjs）在启用前拦下——文档 B3 警告：
 * 抽不好的噪声事实是负收益。
 *
 * #139 技术债收敛：
 *  - 缓存路径/读/原子写 → cache.mjs（三件套唯一实现）；
 *  - 429 长退避 → retry.mjs（末次不白等）；
 *  - token 计量：provider 不报 usage 时按 tokens.mjs 估算并标注 estimated；
 *    缓存命中也带回 usage（缓存档终于能进 bench-gates 门禁3）。
 */
import { cacheFileOf, readCache, writeCache } from "./cache.mjs";
import { isRetriableHttpError, withRateLimitRetry } from "./retry.mjs";
import { estimateMessagesTokens, estimateTokens, normalizeUsage } from "./tokens.mjs";

export const FACTS_PROMPT_VERSION = "facts-v3";

const SYSTEM_PROMPT = [
  "You extract concise fact phrases from conversation turns for a memory retrieval index.",
  "Rules:",
  "1. Only extract facts explicitly stated in the turn. Never infer, guess, or add outside knowledge.",
  "2. Facts must be about the USER's own life, preferences, plans, records or events (first-person statements). Do NOT record generic world knowledge, advice, definitions or product descriptions.",
  "3. Each fact must be a short self-contained phrase (<= 24 words) preserving exact names, numbers, dates and units as written. At most 4 facts per turn.",
  "4. Skip greetings, questions with no stated fact, filler, and meta talk. Returning an empty array for such turns is correct.",
  "5. For each fact also give cardinality: \"single\" when the predicate holds at most one value at a time for that subject (current city, phone number, price, count, status, job title, home address), \"multi\" when multiple values can hold at the same time (likes/dislikes, plans, considering, symptoms, friends, skills). Omit cardinality when unsure.",
  "6. Output JSON only, no prose:",
  '{"results":[{"id":"<turn id>","facts":[{"subject":"...","predicate":"...","value":"...","phrase":"...","cardinality":"single|multi"}]}]}',
].join("\n");

/**
 * 严格归一 cardinality（#146 事实级双时态）：只认 single/multi，其它值/空值一律 undefined。
 * 抽取器是外部模型，写错（"Single"、"many"、空串）不能带进下游——下游 fact-key 只接受严格值，
 * 这里先把它清掉，等于"模型拿不准就当没给"，由 classifyCardinality 自行判断。
 */
export function normalizeFactCardinality(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "single" || v === "multi" ? v : undefined;
}

/** 缓存文件路径。 */
export function factsCachePath(cacheDir, caseId) {
  return cacheFileOf(cacheDir, "facts", caseId);
}

/** 直读缓存文件（只校验 prompt 版本，不校验模型——验收门禁跨模型审计用）。 */
export function readFactsCacheFile(cacheDir, caseId) {
  const hit = readCache(cacheDir, "facts", caseId, (j) => j?.promptVersion === FACTS_PROMPT_VERSION && j?.byTurn && typeof j.byTurn === "object");
  return hit ? hit.payload : null;
}

const reportedInvalid = new Set();
/** 失效只报一次（同一原因不刷屏），但能看出这一档在重抽而不是命中。 */
function reportInvalidOnce(reason, file) {
  const key = String(reason ?? "validate");
  if (reportedInvalid.has(key)) return;
  reportedInvalid.add(key);
  console.warn("[bench] 事实缓存失效（" + key + "），将重新抽取：" + file);
}

/** 读缓存（版本/模型不符 → null，重新抽取）。 */
export function loadCachedFacts(cacheDir, caseId, model) {
  const hit = readCache(
    cacheDir,
    "facts",
    caseId,
    (j) => {
      if (j?.promptVersion !== FACTS_PROMPT_VERSION) return { ok: false, reason: "promptVersion " + j?.promptVersion + "≠" + FACTS_PROMPT_VERSION };
      if (j?.model !== model) return { ok: false, reason: "model " + j?.model + "≠" + model };
      if (!j?.byTurn || typeof j.byTurn !== "object") return { ok: false, reason: "payload-shape" };
      return { ok: true };
    },
    undefined,
    reportInvalidOnce,
  );
  return hit ? hit.payload : null;
}

/** 写缓存（原子替换：cache.mjs 统一 tmp+rename，并发写不互踩）。 */
export function saveCachedFacts(cacheDir, caseId, payload) {
  return writeCache(cacheDir, "facts", caseId, payload);
}

/** 把一个 case 的全部 turn 摊平为 [{ turn, sessionId }]。 */
function flattenTurns(caseObj) {
  const out = [];
  for (const g of caseObj.groups || []) for (const t of g.turns || []) out.push({ turn: t, sessionId: g.sessionId });
  return out;
}

/** 抽取批的消息体（estimate 与真实调用共用同一实现——估算才可复现）。 */
function buildBatchMessages(batch) {
  const lines = batch.map(({ turn }, i) => `[${i + 1}] id=${turn.id} speaker=${turn.speaker || turn.role || "?"}\n${turn.text}`);
  const userPrompt = ["Extract facts from these turns:", "", ...lines, "", 'Return JSON {"results":[...]} for every listed id.'].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

/** 单批抽取：一次 LLM 调用处理 batchSize 个 turn。失败抛错（由调用方决定降级）。 */
async function extractBatch(llm, batch) {
  const messages = buildBatchMessages(batch);
  // maxTokens: 0 = 不传上限——MiniMax-M3.1 等 reasoning 模型 thinking 无上界，
  // 小额帽（1600 实测）会被 thinking 吃光后返回空 content（2026-10-27 血泪实证）。
  // 429 是端点级速率限制（Token Plan），退避要足够长：5s/15s/30s 三次重试（retry.mjs 单一源）。
  const callJson = llm.jsonWithUsage ?? ((m, o) => llm.json(m, o).then((data) => ({ data, usage: null })));
  // 重试所有权在本层（长退避 5s/15s/30s）：llm 调用带 retry:false 只做单次尝试，
  // 避免内层 0.8s/1.6s 套进来形成双层叠加（单批最坏 12 次 HTTP、sleep≈157s）。
  const out = await withRateLimitRetry(() => callJson(messages, { maxTokens: 0, retry: false }), {
    attempts: 4,
    // 8 路并发的批量抽取：齐步重试会撞出新的 429 尖峰，必须抖动。
    jitter: 0.2,
    isEmpty: (v) => !v?.data,
    emptyMessage: "empty/unparsable response",
    isRetryable: isRetriableHttpError,
  });
  const res = out?.data ?? null;
  if (!res) throw new Error("facts extraction failed");
  const results = Array.isArray(res?.results) ? res.results : [];
  const byId = new Map();
  for (const r of results) {
    if (!r || typeof r.id !== "string" || !Array.isArray(r.facts)) continue;
    const phrases = [];
    const triples = [];
    for (const f of r.facts) {
      if (!f || typeof f !== "object") continue;
      const phrase = String(f.phrase ?? "").trim();
      if (!phrase) continue;
      phrases.push(phrase);
      const subject = String(f.subject ?? "").trim();
      const predicate = String(f.predicate ?? "").trim();
      const value = String(f.value ?? "").trim();
      // cardinality 只挂在有主谓的三元组上（phrases 不进它：embedding 键口径不变）。
      const cardinality = normalizeFactCardinality(f.cardinality);
      if (subject && predicate) triples.push(cardinality ? { subject, predicate, value, cardinality } : { subject, predicate, value });
    }
    byId.set(r.id, { phrases, triples });
  }
  // token 计量：provider 报了就用真值；没报（本机内网中转部分档位不返 usage）用估算，
  // 显式标 estimated，绝不把 0 当成"花了 0 token"（否则预算门禁永远 SKIP）。
  const usage = normalizeUsage(out?.usage, { completionText: JSON.stringify(res) });
  if (usage.estimated) usage.prompt = estimateMessagesTokens(messages);
  return { byId, usage };
}

/**
 * 抽取一个 case 的全部事实（不走缓存）。
 * @returns {{byTurn: object, usage:{prompt:number,completion:number}, usageSources:{reported:number,estimated:number}, turns:number, ms:number, failedBatches:number}}
 */
export async function extractFactsForCase({ caseObj, llm, batchSize = 20, concurrency = 2, logger = console, roles = ["user"] }) {
  // 只抽用户侧发言：assistant 轮多为泛化知识/建议（实测抽出"H&M 有会员计划"类世界知识，
  // 进 embedding 键只会稀释语义）；assistant 轮的键保持原文（零损失）。
  const flat = flattenTurns(caseObj).filter(({ turn }) => roles.includes(turn.role));
  const batches = [];
  for (let i = 0; i < flat.length; i += batchSize) batches.push(flat.slice(i, i + batchSize));
  const t0 = Date.now();
  const byTurn = {};
  const usage = { prompt: 0, completion: 0 };
  const usageSources = { reported: 0, estimated: 0 };
  let failedBatches = 0;
  await runWithConcurrency(batches, concurrency, async (batch) => {
    try {
      const { byId, usage: u } = await extractBatch(llm, batch);
      if (u) {
        usage.prompt += u.prompt ?? 0;
        usage.completion += u.completion ?? 0;
        if (u.reported) usageSources.reported++;
        else if (u.estimated) usageSources.estimated++;
      }
      for (const { turn } of batch) {
        const got = byId.get(turn.id);
        byTurn[turn.id] = got ?? { phrases: [], triples: [] };
      }
    } catch (e) {
      failedBatches++;
      logger?.warn?.(`[bench:facts] batch 抽取失败（${batch.length} turn）: ${e?.message ?? e}`);
      for (const { turn } of batch) byTurn[turn.id] = { phrases: [], triples: [] };
    }
  });
  return { byTurn, usage, usageSources, turns: flat.length, ms: Date.now() - t0, failedBatches };
}

async function runWithConcurrency(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * 缓存命中时的 token 证据重建（#139 第4项）。
 *
 * 旧缓存 payload 的 usage 可能是 {prompt:0,completion:0}（provider 未报）。直接把 0
 * 当证据会让预算门禁永远 SKIP；这里用**同一套 prompt 构造**重算估算值，标注 estimated。
 * 确定性：只依赖 case 语料 + 缓存里的 byTurn，不取时钟/随机。
 */
export function estimateExtractionUsage({ caseObj, byTurn, batchSize = 20, roles = ["user"] }) {
  const flat = flattenTurns(caseObj).filter(({ turn }) => roles.includes(turn.role));
  const batches = [];
  for (let i = 0; i < flat.length; i += batchSize) batches.push(flat.slice(i, i + batchSize));
  let prompt = 0;
  let completion = 0;
  const usage = { prompt: 0, completion: 0 };
  for (const batch of batches) {
    prompt += estimateMessagesTokens(buildBatchMessages(batch));
    const results = batch.map(({ turn }) => {
      const got = byTurn?.[turn.id] ?? { phrases: [], triples: [] };
      return {
        id: turn.id,
        facts: (got.phrases ?? []).map((phrase) => ({ subject: "", predicate: "", value: "", phrase })),
      };
    });
    // 注：facts-v3 起真实回包还带 cardinality；这里不重建（不知道真实取值，乱填会虚增估算）。
    // 缓存档 completion 估算因此偏低几个 token，属已知口径，不影响 prompt 侧证据。
    completion += estimateTokens(JSON.stringify({ results }));
  }
  usage.prompt = prompt;
  usage.completion = completion;
  return usage;
}

/**
 * 缓存优先的事实获取：命中缓存零外呼；未命中 → 抽取并落盘。
 *
 * 命中时也带回 usage（#139 第4项：缓存档 token 可测）：
 *  - payload.usage 有正数 → usageSource="cache"（真值）；
 *  - payload.usage 缺失/全 0 → 用 estimateExtractionUsage 重建 → usageSource="estimated-cache"。
 *
 * @returns {{facts:{byTurn:object}, cacheHit:boolean, ms:number, usage:{prompt:number,completion:number}, usageSource:"live"|"cache"|"estimated-cache"|"none", turns:number, failedBatches:number, coverage:object}}
 */
export async function factsForCase({ caseObj, cacheDir, llm, model, batchSize = 20, concurrency = 2, logger = console, roles }) {
  const effectiveRoles = roles ?? ["user"];
  if (cacheDir) {
    const hit = loadCachedFacts(cacheDir, caseObj.caseId, model);
    if (hit) {
      const stored = hit.usage ?? null;
      const hasStored = (stored?.prompt ?? 0) > 0 || (stored?.completion ?? 0) > 0;
      const usage = hasStored
        ? { prompt: Number(stored.prompt) || 0, completion: Number(stored.completion) || 0 }
        : estimateExtractionUsage({ caseObj, byTurn: hit.byTurn, batchSize: hit.batchSize ?? batchSize, roles: effectiveRoles });
      return {
        facts: { byTurn: hit.byTurn },
        cacheHit: true,
        ms: 0,
        usage,
        usageSource: hasStored ? "cache" : "estimated-cache",
        turns: hit.turns ?? Object.keys(hit.byTurn).length,
        failedBatches: 0,
        coverage: factsCoverage(hit.byTurn),
      };
    }
  }
  if (!llm) throw new Error("事实抽取需要 LLM 客户端（--fact-extract / --fact-dual-write / --fact-channel / --fact-rows）");
  const t0 = Date.now();
  const out = await extractFactsForCase({ caseObj, llm, batchSize, concurrency, logger, roles: effectiveRoles });
  if (cacheDir && out.failedBatches === 0) {
    // 缓存是旁路：落盘失败不能让已成功的抽取整档崩掉（与 withEmbedCache 同纪律）。
    try {
      saveCachedFacts(cacheDir, caseObj.caseId, {
        promptVersion: FACTS_PROMPT_VERSION,
        model: model ?? null,
        caseId: caseObj.caseId,
        generatedAt: new Date().toISOString(),
        turns: out.turns,
        batchSize,
        usage: out.usage,
        usageSources: out.usageSources,
        byTurn: out.byTurn,
      });
    } catch (e) {
      logger?.warn?.(`[bench:facts] 缓存写入失败（不影响本档结果）: ${e?.message ?? e}`);
    }
  }
  // 来源判定看「有多少批走的是估算」，不能看 total>0——估算值本身就 >0，
  // 用总量判断会把估算全记成 live，门禁「（估算口径）」标记永远不亮。
  const est = out.usageSources?.estimated ?? 0;
  const rep = out.usageSources?.reported ?? 0;
  const usageSource = rep > 0 && est === 0 ? "live" : est > 0 && rep === 0 ? "estimated-live" : rep > 0 && est > 0 ? "mixed" : "none";
  return {
    facts: { byTurn: out.byTurn },
    cacheHit: false,
    ms: Date.now() - t0,
    usage: out.usage,
    usageSource,
    usageSources: out.usageSources,
    turns: out.turns,
    failedBatches: out.failedBatches,
    coverage: factsCoverage(out.byTurn),
  };
}

/** 该 case 的事实覆盖统计（抽取质量旁证：多少 turn 有事实、平均短语数）。 */
export function factsCoverage(factsByTurn) {
  const ids = Object.keys(factsByTurn || {});
  let withFacts = 0;
  let phrases = 0;
  for (const id of ids) {
    const f = factsByTurn[id];
    if (f?.phrases?.length) withFacts++;
    phrases += f?.phrases?.length ?? 0;
  }
  return { turns: ids.length, turnsWithFacts: withFacts, phrases, avgPhrasesPerFactTurn: withFacts ? phrases / withFacts : 0 };
}
