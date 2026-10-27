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
 */
import fs from "node:fs";
import path from "node:path";

export const FACTS_PROMPT_VERSION = "facts-v2";

const SYSTEM_PROMPT = [
  "You extract concise fact phrases from conversation turns for a memory retrieval index.",
  "Rules:",
  "1. Only extract facts explicitly stated in the turn. Never infer, guess, or add outside knowledge.",
  "2. Facts must be about the USER's own life, preferences, plans, records or events (first-person statements). Do NOT record generic world knowledge, advice, definitions or product descriptions.",
  "3. Each fact must be a short self-contained phrase (<= 24 words) preserving exact names, numbers, dates and units as written. At most 4 facts per turn.",
  "4. Skip greetings, questions with no stated fact, filler, and meta talk. Returning an empty array for such turns is correct.",
  "5. Output JSON only, no prose:",
  '{"results":[{"id":"<turn id>","facts":[{"subject":"...","predicate":"...","value":"...","phrase":"..."}]}]}',
].join("\n");

/** 缓存文件路径。 */
export function factsCachePath(cacheDir, caseId) {
  return path.join(cacheDir, "facts", String(caseId).replace(/[^\w.-]+/g, "_") + ".json");
}

/** 直读缓存文件（只校验 prompt 版本，不校验模型——验收门禁跨模型审计用）。 */
export function readFactsCacheFile(cacheDir, caseId) {
  const file = factsCachePath(cacheDir, caseId);
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j?.promptVersion !== FACTS_PROMPT_VERSION) return null;
    if (!j.byTurn || typeof j.byTurn !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

/** 读缓存（版本/模型不符 → null，重新抽取）。 */
export function loadCachedFacts(cacheDir, caseId, model) {
  const file = factsCachePath(cacheDir, caseId);
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j?.promptVersion !== FACTS_PROMPT_VERSION || j?.model !== model) return null;
    if (!j.byTurn || typeof j.byTurn !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

/** 写缓存（原子替换：先写临时文件再 rename，避免中断留下半截 JSON）。 */
export function saveCachedFacts(cacheDir, caseId, payload) {
  const file = factsCachePath(cacheDir, caseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 把一个 case 的全部 turn 摊平为 [{ turn, sessionId }]。 */
function flattenTurns(caseObj) {
  const out = [];
  for (const g of caseObj.groups || []) for (const t of g.turns || []) out.push({ turn: t, sessionId: g.sessionId });
  return out;
}

/** 单批抽取：一次 LLM 调用处理 batchSize 个 turn。失败抛错（由调用方决定降级）。 */
async function extractBatch(llm, batch) {
  const lines = batch.map(({ turn }, i) => `[${i + 1}] id=${turn.id} speaker=${turn.speaker || turn.role || "?"}\n${turn.text}`);
  const userPrompt = ["Extract facts from these turns:", "", ...lines, "", 'Return JSON {"results":[...]} for every listed id.'].join("\n");
  // maxTokens: 0 = 不传上限——MiniMax-M3.1 等 reasoning 模型 thinking 无上界，
  // 小额帽（1600 实测）会被 thinking 吃光后返回空 content（2026-10-27 血泪实证）。
  // 429 是端点级速率限制（Token Plan），退避要足够长：5s/15s/30s 三次重试。
  let res = null;
  let usage = null;
  let lastErr = null;
  const callJson = llm.jsonWithUsage ?? ((m, o) => llm.json(m, o).then((data) => ({ data, usage: null })));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await callJson([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ], { maxTokens: 0 });
      res = out?.data ?? null;
      usage = out?.usage ?? null;
      if (res) break;
      lastErr = new Error("empty/unparsable response");
    } catch (e) {
      lastErr = e;
      if (!/429|rate.?limit/i.test(String(e?.message ?? e))) throw e;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt] ?? 30000));
  }
  if (!res) throw lastErr ?? new Error("facts extraction failed");
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
      if (subject && predicate) triples.push({ subject, predicate, value });
    }
    byId.set(r.id, { phrases, triples });
  }
  return { byId, usage };
}

/**
 * 抽取一个 case 的全部事实（不走缓存）。
 * @returns {{byTurn: Record<string,{phrases:string[],triples:Array}>, usage:{prompt:number,completion:number}, turns:number, ms:number, failedBatches:number}}
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
  let failedBatches = 0;
  await runWithConcurrency(batches, concurrency, async (batch) => {
    try {
      const { byId, usage: u } = await extractBatch(llm, batch);
      if (u) {
        usage.prompt += Number(u.prompt_tokens ?? 0);
        usage.completion += Number(u.completion_tokens ?? 0);
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
  return { byTurn, usage, turns: flat.length, ms: Date.now() - t0, failedBatches };
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
 * 缓存优先的事实获取：命中缓存零外呼；未命中 → 抽取并落盘。
 * @returns {{facts: {byTurn: Record<string,{phrases:string[],triples:Array}>}, cacheHit: boolean, ms: number, usage?: object, turns?: number, failedBatches?: number}}
 */
export async function factsForCase({ caseObj, cacheDir, llm, model, batchSize = 20, concurrency = 2, logger = console, roles }) {
  if (cacheDir) {
    const hit = loadCachedFacts(cacheDir, caseObj.caseId, model);
    if (hit) return { facts: { byTurn: hit.byTurn }, cacheHit: true, ms: 0 };
  }
  if (!llm) throw new Error("事实抽取需要 LLM 客户端（--fact-extract / --fact-dual-write）");
  const t0 = Date.now();
  const out = await extractFactsForCase({ caseObj, llm, batchSize, concurrency, logger, ...(roles ? { roles } : {}) });
  if (cacheDir && out.failedBatches === 0) {
    saveCachedFacts(cacheDir, caseObj.caseId, {
      promptVersion: FACTS_PROMPT_VERSION,
      model: model ?? null,
      caseId: caseObj.caseId,
      generatedAt: new Date().toISOString(),
      turns: out.turns,
      usage: out.usage,
      byTurn: out.byTurn,
    });
  }
  return { facts: { byTurn: out.byTurn }, cacheHit: false, ms: Date.now() - t0, usage: out.usage, turns: out.turns, failedBatches: out.failedBatches };
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
