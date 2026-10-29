/**
 * W3（issue #134）：结论层接入召回——结论卡（work_fact）离线蒸馏 + 磁盘缓存。
 *
 * 数据流：灌库前按 case 把会话语料蒸馏成 2-4 张结论卡（sourceTurnIds 指向源证据 turn），
 * 卡以 L1 record（type=work_fact）写入 + part_of 链（卡 → 证据 turn）。
 * 召回侧既有通道（R7-1 结论层 FTS / V2-3 分析型放宽 / #78 smallToBig 证据回捞）据此
 * 把结论卡与源证据带进注入块——bench 里 conclusionCount 从 0 变正的主路径。
 *
 * 纪律：卡必须可回溯到源 turn（normalizeConclusionCards 丢弃无证据卡）。
 *
 * #139 技术债收敛：缓存 → cache.mjs、429 退避 → retry.mjs、token 计量 → tokens.mjs
 * （命中缓存也带回 usage，见 facts.mjs 同款纪律）。
 */
import { cacheFileOf, readCache, writeCache } from "./cache.mjs";
import { isRetriableHttpError, withRateLimitRetry } from "./retry.mjs";
import { estimateMessagesTokens, estimateTokens, normalizeUsage } from "./tokens.mjs";

export const CONCLUSIONS_PROMPT_VERSION = "concl-v1";

const SYSTEM_PROMPT_BODY = [
  "You distill a conversation corpus into durable conclusion cards for a memory system.",
  "Rules:",
  "1. Each card is ONE self-contained statement about the user: a durable fact, preference, ongoing situation, or key event. Preserve numbers, dates, names and units verbatim.",
  "2. Cards must be supported ONLY by the listed turns. Cite the exact bracketed turn ids in sourceTurnIds.",
  "3. Prefer cards that aggregate or summarize across several turns; skip greetings, filler, and pure questions.",
  "4. At most {{MAX_CARDS}} cards. If nothing durable is stated, return an empty array.",
  '5. Output JSON only, no prose: {"cards":[{"content":"...","sourceTurnIds":["<turn id>"]}]}',
];

export function conclusionsCachePath(cacheDir, caseId) {
  return cacheFileOf(cacheDir, "conclusions", caseId);
}

const reportedInvalid = new Set();
/** 失效只报一次（同一原因不刷屏），但仍能一眼看出「这一档在重抽而不是命中」。 */
function reportInvalidOnce(reason, file) {
  const key = String(reason ?? "validate");
  if (reportedInvalid.has(key)) return;
  reportedInvalid.add(key);
  console.warn("[bench] 结论卡缓存失效（" + key + "），将重新蒸馏：" + file);
}

export function readConclusionsCacheFile(cacheDir, caseId, model) {
  const hit = readCache(
    cacheDir,
    "conclusions",
    caseId,
    (j) => {
      if (j?.promptVersion !== CONCLUSIONS_PROMPT_VERSION) return { ok: false, reason: "promptVersion " + j?.promptVersion + "≠" + CONCLUSIONS_PROMPT_VERSION };
      // 跨模型口径：--fact-model 换了模型就必须重蒸（与 loadCachedFacts 同纪律）
      if (model !== undefined && j?.model !== model) return { ok: false, reason: "model " + j?.model + "≠" + model };
      if (!Array.isArray(j?.cards)) return { ok: false, reason: "payload-shape" };
      return { ok: true };
    },
    undefined,
    reportInvalidOnce,
  );
  return hit ? hit.payload : null;
}

export function saveConclusionsCache(cacheDir, caseId, payload) {
  return writeCache(cacheDir, "conclusions", caseId, payload);
}

/** 蒸馏批的消息体（estimate 与真实调用共用——估算可复现）。 */
function buildDistillMessages(caseObj, { maxCards = 4, maxCharsPerTurn = 800, maxTotalChars = 24000 } = {}) {
  const turns = [];
  for (const g of caseObj.groups || []) for (const t of g.turns || []) turns.push(t);
  const lines = [];
  let used = 0;
  for (const t of turns) {
    const text = String(t.text ?? "").slice(0, maxCharsPerTurn);
    const line = "[" + t.id + "] " + (t.speaker || t.role || "?") + ": " + text;
    if (used + line.length > maxTotalChars) break;
    used += line.length;
    lines.push(line);
  }
  const userPrompt = ["Turns:", "", ...lines, "", 'Return JSON {"cards":[...]} with sourceTurnIds referencing the bracketed ids.'].join("\n");
  const system = SYSTEM_PROMPT_BODY.join("\n").replace("{{MAX_CARDS}}", String(maxCards));
  return {
    turns,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  };
}

/** 蒸馏一个 case 的结论卡（不走缓存）。 */
export async function distillConclusionsForCase({ caseObj, llm, maxCards = 4, maxCharsPerTurn = 800, maxTotalChars = 24000, logger = console }) {
  const { turns, messages } = buildDistillMessages(caseObj, { maxCards, maxCharsPerTurn, maxTotalChars });
  // 429 长退避（retry.mjs 单一源；端点 Token Plan 速率限制）
  const callJson = llm.jsonWithUsage ?? ((m, o) => llm.json(m, o).then((data) => ({ data, usage: null })));
  // 重试所有权在本层：llm 调用 retry:false 只单次尝试，避免与外层长退避双层叠加。
  const out = await withRateLimitRetry(() => callJson(messages, { maxTokens: 0, retry: false }), {
    attempts: 4,
    jitter: 0.2,
    isEmpty: (v) => !v?.data,
    emptyMessage: "empty/unparsable response",
    isRetryable: isRetriableHttpError,
  });
  const raw = out?.data ?? null;
  if (!raw) throw new Error("conclusion distillation failed");
  const { normalizeConclusionCards } = await import("../../../src/core/record/conclusion-card.ts");
  const knownTurnIds = new Set(turns.map((t) => t.id));
  const cards = normalizeConclusionCards(raw, { knownTurnIds, maxCards });
  const usage = normalizeUsage(out?.usage, { completionText: JSON.stringify({ cards }) });
  if (usage.estimated) usage.prompt = estimateMessagesTokens(messages);
  return { cards, usage };
}

/** 缓存命中时的 token 证据重建（确定性；见 facts.mjs estimateExtractionUsage 同款）。 */
export function estimateDistillationUsage({ caseObj, cards, maxCards = 4 }) {
  const { messages } = buildDistillMessages(caseObj, { maxCards });
  return { prompt: estimateMessagesTokens(messages), completion: estimateTokens(JSON.stringify({ cards: cards ?? [] })) };
}

/**
 * 缓存优先的结论卡获取。
 * @returns {{cards: Array, cacheHit: boolean, ms: number, usage?: {prompt:number,completion:number}, usageSource: "live"|"cache"|"estimated-cache"|"none", failed?: boolean}}
 */
export async function conclusionsForCase({ caseObj, cacheDir, llm, model, maxCards = 4, logger = console }) {
  if (cacheDir) {
    const hit = readConclusionsCacheFile(cacheDir, caseObj.caseId, model);
    if (hit && (hit.maxCards ?? 0) >= maxCards) {
      const stored = hit.usage ?? null;
      const hasStored = (stored?.prompt ?? 0) > 0 || (stored?.completion ?? 0) > 0;
      const usage = hasStored
        ? { prompt: Number(stored.prompt) || 0, completion: Number(stored.completion) || 0 }
        : estimateDistillationUsage({ caseObj, cards: hit.cards, maxCards: hit.maxCards ?? maxCards });
      return { cards: hit.cards, cacheHit: true, ms: 0, usage, usageSource: hasStored ? "cache" : "estimated-cache" };
    }
  }
  if (!llm) throw new Error("结论卡蒸馏需要 LLM 客户端（--conclusion-cards）");
  const t0 = Date.now();
  let out;
  try {
    out = await distillConclusionsForCase({ caseObj, llm, maxCards, logger });
  } catch (e) {
    // 软失败纪律（与 facts 同）：单 case 蒸馏失败不打断整档，返回空卡并留痕。
    logger?.warn?.(`[bench:conclusions] case ${caseObj.caseId} 蒸馏失败: ${e?.message ?? e}`);
    return { cards: [], cacheHit: false, ms: Date.now() - t0, failed: true, usage: { prompt: 0, completion: 0 }, usageSource: "none" };
  }
  if (cacheDir) {
    // 缓存是旁路：落盘失败不能让已成功的蒸馏整档崩掉。
    try {
      saveConclusionsCache(cacheDir, caseObj.caseId, {
        promptVersion: CONCLUSIONS_PROMPT_VERSION,
        model: model ?? null,
        caseId: caseObj.caseId,
        maxCards,
        generatedAt: new Date().toISOString(),
        usage: out.usage ?? null,
        cards: out.cards,
      });
    } catch (e) {
      logger?.warn?.(`[bench:conclusions] 缓存写入失败（不影响本档结果）: ${e?.message ?? e}`);
    }
  }
  // 估算参与的档位必须自报家门（estimated 由 normalizeUsage 置位），不能记成 live。
  const usage = out.usage ?? { prompt: 0, completion: 0 };
  const usageSource = usage.estimated ? "estimated-live" : (usage.prompt ?? 0) > 0 || (usage.completion ?? 0) > 0 ? "live" : "none";
  return {
    cards: out.cards,
    cacheHit: false,
    ms: Date.now() - t0,
    usage,
    usageSource,
  };
}
