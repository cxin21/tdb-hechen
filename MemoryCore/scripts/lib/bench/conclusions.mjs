/**
 * W3（issue #134）：结论层接入召回——结论卡（work_fact）离线蒸馏 + 磁盘缓存。
 *
 * 数据流：灌库前按 case 把会话语料蒸馏成 2-4 张结论卡（sourceTurnIds 指向源证据 turn），
 * 卡以 L1 record（type=work_fact）写入 + part_of 链（卡 → 证据 turn）。
 * 召回侧既有通道（R7-1 结论层 FTS / V2-3 分析型放宽 / #78 smallToBig 证据回捞）据此
 * 把结论卡与源证据带进注入块——bench 里 conclusionCount 从 0 变正的主路径。
 *
 * 纪律：卡必须可回溯到源 turn（normalizeConclusionCards 丢弃无证据卡）。
 */
import fs from "node:fs";
import path from "node:path";

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
  return path.join(cacheDir, "conclusions", String(caseId).replace(/[^\w.-]+/g, "_") + ".json");
}

export function readConclusionsCacheFile(cacheDir, caseId, model) {
  const file = conclusionsCachePath(cacheDir, caseId);
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j?.promptVersion !== CONCLUSIONS_PROMPT_VERSION) return null;
    // 跨模型口径：--fact-model 换了模型就必须重蒸（与 loadCachedFacts 同纪律）
    if (model !== undefined && j?.model !== model) return null;
    if (!Array.isArray(j.cards)) return null;
    return j;
  } catch {
    return null;
  }
}

export function saveConclusionsCache(cacheDir, caseId, payload) {
  const file = conclusionsCachePath(cacheDir, caseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 蒸馏一个 case 的结论卡（不走缓存）。 */
export async function distillConclusionsForCase({ caseObj, llm, maxCards = 4, maxCharsPerTurn = 800, maxTotalChars = 24000, logger = console }) {
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
  // 429 长退避（与 facts.mjs 同纪律；端点 Token Plan 速率限制）
  let raw = null;
  let usage = null;
  let lastErr = null;
  const callJson = llm.jsonWithUsage ?? ((m, o) => llm.json(m, o).then((data) => ({ data, usage: null })));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await callJson([
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ], { maxTokens: 0 });
      raw = out?.data ?? null;
      usage = out?.usage ?? null;
      if (raw) break;
      lastErr = new Error("empty/unparsable response");
    } catch (e) {
      lastErr = e;
      if (!/429|rate.?limit/i.test(String(e?.message ?? e))) throw e;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt] ?? 30000));
  }
  if (!raw) throw lastErr ?? new Error("conclusion distillation failed");
  const { normalizeConclusionCards } = await import("../../../src/core/record/conclusion-card.ts");
  const knownTurnIds = new Set(turns.map((t) => t.id));
  return { cards: normalizeConclusionCards(raw, { knownTurnIds, maxCards }), usage };
}

/**
 * 缓存优先的结论卡获取。
 * @returns {{cards: Array<{content:string,sourceTurnIds:string[]}>, cacheHit: boolean, ms: number}}
 */
export async function conclusionsForCase({ caseObj, cacheDir, llm, model, maxCards = 4, logger = console }) {
  if (cacheDir) {
    const hit = readConclusionsCacheFile(cacheDir, caseObj.caseId, model);
    if (hit && (hit.maxCards ?? 0) >= maxCards) return { cards: hit.cards, cacheHit: true, ms: 0 };
  }
  if (!llm) throw new Error("结论卡蒸馏需要 LLM 客户端（--conclusion-cards）");
  const t0 = Date.now();
  let out;
  try {
    out = await distillConclusionsForCase({ caseObj, llm, maxCards, logger });
  } catch (e) {
    // 软失败纪律（与 facts 同）：单 case 蒸馏失败不打断整档，返回空卡并留痕。
    logger?.warn?.(`[bench:conclusions] case ${caseObj.caseId} 蒸馏失败: ${e?.message ?? e}`);
    return { cards: [], cacheHit: false, ms: Date.now() - t0, failed: true };
  }
  if (cacheDir) {
    saveConclusionsCache(cacheDir, caseObj.caseId, {
      promptVersion: CONCLUSIONS_PROMPT_VERSION,
      model: model ?? null,
      caseId: caseObj.caseId,
      maxCards,
      generatedAt: new Date().toISOString(),
      usage: out.usage ?? null,
      cards: out.cards,
    });
  }
  return { cards: out.cards, cacheHit: false, ms: Date.now() - t0, usage: out.usage ?? null };
}
