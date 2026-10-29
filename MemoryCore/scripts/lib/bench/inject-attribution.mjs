/**
 * bench 注入行类型归因 + 证据充分性度量（#141 / #158 遗留项）。
 *
 * 背景：bench 现有一阶指标（turnCov/sessionCov@k）只看「证据在不在注入集里」，
 * 回答不了两个问题：
 *   1. 哪一类注入行（结论层 / 上下文行 / 原始 turn）在为覆盖率买单？去掉某一类会掉多少？
 *   2. 给作答模型的编号证据块，字面上到底覆盖了多少 gold 答案？（judge 之外的廉价近似）
 * 本模块只做纯计算：不读库、不发请求、不写文件，输入输出全为普通 JS 值，
 * 便于 bench 主流程按需拼装（Lead 侧集成口径可换，函数签名保持稳定）。
 *
 * 行类型口径（与生产 formatMemoryLine / MEMORY_LINE_RE 同构）：
 *   - [结论|场景] 内容     → conclusion      （recall-layered 的 L2 结论层）
 *   - [上下文|场景] 内容   → evidence-recall （smallToBig 的 part_of 证据行）
 *   - [episodic|...] 内容  → raw-turn        （L1 经验层等其它召回行）
 *   - 无 type 且无已知前缀 → unknown         （仍计入总覆盖率，单列观察）
 */

/** 四类注入行（顺序即报告列顺序，勿随意调整）。 */
export const INJECT_LINE_TYPES = ["conclusion", "evidence-recall", "raw-turn", "unknown"];

/** 英文停用词：证据块与 gold 里都大量出现，计入分母只会稀释信号。 */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "to", "in", "on", "at", "for", "and", "or",
  "but", "i", "me", "my", "you", "your", "it", "its", "that", "this", "with", "as", "by", "from", "do", "did",
  "does", "have", "has", "had", "not", "no", "if", "then", "than", "so", "we", "they", "he", "she", "them",
  "his", "her", "what", "which", "who", "when", "where", "how", "s", "t",
]);

// ── 行解析 / 分类 ────────────────────────────────────────────────────────────

/**
 * 注入行解析（仅用于 memoryLines 形态的兜底；生产 hits 已自带 type/clean）。
 * 与 MEMORY_LINE_RE 同构：`- [tag] body`，tag 可能带 `|场景名`。
 */
const LINE_RE = /^-\s+\[([^\]]+)\]\s+([\s\S]*)$/;

function parseInjectedLine(line) {
  const s = String(line ?? "");
  const m = s.match(LINE_RE);
  if (!m) return { content: s, clean: s, type: "" };
  const type = String(m[1]).split("|")[0].trim();
  // 剥系统标注（活动时间 / soul 徽章），供 resolve 对齐落库 turn；正文本体保留。
  const clean = m[2].replace(/\s*·?\(活动时间:[^)]*\)/g, "").replace(/\s*·\([^)]*\)/g, "").trim();
  return { content: s, clean, type };
}

/**
 * 单行分类。
 * @param {{content?: string, clean?: string, type?: string}|string} hit
 * @returns {"conclusion"|"evidence-recall"|"raw-turn"|"unknown"}
 */
export function classifyInjectedLine(hit) {
  const h = typeof hit === "string" ? parseInjectedLine(hit) : hit || {};
  const type = typeof h.type === "string" ? h.type.trim() : "";
  if (type) {
    if (type.startsWith("结论")) return "conclusion";
    if (type.startsWith("上下文")) return "evidence-recall";
    return "raw-turn";
  }
  const content = typeof h.content === "string" ? h.content : typeof h.clean === "string" ? h.clean : "";
  const s = content.trimStart();
  if (s.startsWith("- [结论")) return "conclusion";
  if (s.startsWith("- [上下文")) return "evidence-recall";
  return "unknown";
}

/** 缺省 session 归属：turnId 里 `::` 或 `#` 之前的前缀；都没有则整串。 */
function defaultSessionOf(turnId) {
  const s = String(turnId ?? "");
  const i = s.search(/::|#/);
  return i >= 0 ? s.slice(0, i) : s;
}

function toSet(v) {
  if (v == null) return new Set();
  if (v instanceof Set) return new Set(v);
  if (Array.isArray(v)) return new Set(v);
  if (typeof v[Symbol.iterator] === "function") return new Set(v);
  return new Set([v]);
}

function diffOrNull(a, b) {
  return typeof a === "number" && typeof b === "number" ? a - b : null;
}

// ── 注入集归因 ──────────────────────────────────────────────────────────────

/**
 * 注入集按类型归因 + 一阶贡献（去掉该类型后覆盖率掉多少）。
 *
 * @param {object} p
 * @param {Array<{content?: string, clean?: string, type?: string}|string>} p.hits 顺序即注入顺序
 * @param {(cleanText: string) => (string|null)} p.resolve clean 文本 → 落库 turn id（metrics.mjs 的 makeIdResolver）
 * @param {string[]|Set<string>} p.goldTurnIds 该题 gold turn id
 * @param {(turnId: string) => string} [p.sessionOf] turnId → session；缺省按 `::` / `#` 前缀
 * @param {string[]|Set<string>} [p.goldSessionIds] 缺省由 goldTurnIds 经 sessionOf 推导
 * @returns {{
 *   injectedLines: number, turnCov: number|null, sessionCov: number|null,
 *   byType: Record<string, {lines: number, goldLines: number, sessions: number}>,
 *   coverageWithout: Record<string, {turnCov: number|null, sessionCov: number|null, injectedLines: number}>,
 *   firstOrderDrop: Record<string, {turnCov: number|null, sessionCov: number|null}>,
 * }}
 */
export function attributeInjectedLines({ hits, resolve, goldTurnIds, sessionOf, goldSessionIds } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const goldTurns = toSet(goldTurnIds);
  const sess = typeof sessionOf === "function" ? sessionOf : defaultSessionOf;
  const goldSessions =
    goldSessionIds == null
      ? new Set([...goldTurns].map((id) => sess(id)).filter((s) => s != null && s !== ""))
      : toSet(goldSessionIds);
  const resolveFn = typeof resolve === "function" ? resolve : () => null;

  // 每行一次对齐：resolve 可能抛（脏数据/索引缺项），归因度量不能因此中断整轮 bench。
  const rows = list.map((hit) => {
    const h = typeof hit === "string" ? parseInjectedLine(hit) : hit || {};
    const type = classifyInjectedLine(h);
    const clean = typeof h.clean === "string" ? h.clean : typeof h.content === "string" ? h.content : "";
    let turnId = null;
    try {
      turnId = resolveFn(clean);
    } catch {
      turnId = null;
    }
    turnId = turnId == null ? null : String(turnId);
    return { type, turnId, sessionId: turnId == null ? null : String(sess(turnId)) };
  });

  const coverage = (subset) => {
    const turns = new Set();
    const sessions = new Set();
    for (const r of subset) {
      if (!r.turnId) continue;
      turns.add(r.turnId);
      if (r.sessionId) sessions.add(r.sessionId);
    }
    const hitTurns = [...turns].filter((t) => goldTurns.has(t)).length;
    const hitSessions = [...sessions].filter((s) => goldSessions.has(s)).length;
    return {
      injectedLines: subset.length,
      turnCov: goldTurns.size ? hitTurns / goldTurns.size : null,
      sessionCov: goldSessions.size ? hitSessions / goldSessions.size : null,
    };
  };

  const byType = {};
  for (const t of INJECT_LINE_TYPES) {
    const sub = rows.filter((r) => r.type === t);
    const goldRows = sub.filter((r) => r.turnId && goldTurns.has(r.turnId));
    byType[t] = {
      lines: sub.length,
      goldLines: goldRows.length,
      sessions: new Set(goldRows.map((r) => r.sessionId).filter(Boolean)).size,
    };
  }

  // 空注入：口径显式返回 null（0 行没有任何覆盖证据，写 0 会被误读成「全漏」）。
  if (list.length === 0) {
    const base = { injectedLines: 0, turnCov: null, sessionCov: null };
    const coverageWithout = {};
    const firstOrderDrop = {};
    for (const t of INJECT_LINE_TYPES) {
      coverageWithout[t] = { turnCov: null, sessionCov: null, injectedLines: 0 };
      firstOrderDrop[t] = { turnCov: null, sessionCov: null };
    }
    return { ...base, byType, coverageWithout, firstOrderDrop };
  }

  const base = coverage(rows);
  const coverageWithout = {};
  const firstOrderDrop = {};
  for (const t of INJECT_LINE_TYPES) {
    const c = coverage(rows.filter((r) => r.type !== t));
    coverageWithout[t] = { turnCov: c.turnCov, sessionCov: c.sessionCov, injectedLines: c.injectedLines };
    firstOrderDrop[t] = {
      turnCov: diffOrNull(base.turnCov, c.turnCov),
      sessionCov: diffOrNull(base.sessionCov, c.sessionCov),
    };
  }

  return {
    injectedLines: list.length,
    turnCov: base.turnCov,
    sessionCov: base.sessionCov,
    byType,
    coverageWithout,
    firstOrderDrop,
  };
}

// ── 证据充分性 ──────────────────────────────────────────────────────────────

/**
 * 分词：小写化；英文/数字按 /[a-z0-9]+/ 取长度≥2 且非停用词；中文按连续汉字取 2-gram（单字段保留）。
 * @param {string} text
 * @returns {string[]} 保序、可重复
 */
function tokenize(text) {
  const s = String(text ?? "").toLowerCase();
  const out = [];
  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length >= 2 && !STOPWORDS.has(t)) out.push(t);
  }
  for (const m of s.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function uniqueTokens(list) {
  return [...new Set(list)];
}

/**
 * 证据充分性（token 级近似，将来可换 judge）。
 * 口径：score = 命中的 distinct gold token 数 / distinct gold token 数。
 * @param {{evidence?: string, goldAnswer?: string|string[]}} p
 * @returns {{score: number|null, goldTokens: number, coveredTokens: number, missing: string[]}}
 */
export function evidenceSufficiency({ evidence, goldAnswer } = {}) {
  const goldText = Array.isArray(goldAnswer) ? goldAnswer.join(" ") : goldAnswer == null ? "" : String(goldAnswer);
  const goldTokens = uniqueTokens(tokenize(goldText));
  const evTokens = new Set(tokenize(evidence == null ? "" : String(evidence)));
  const covered = goldTokens.filter((t) => evTokens.has(t));
  const missing = goldTokens.filter((t) => !evTokens.has(t)).slice(0, 20);
  const score = goldTokens.length === 0 || evTokens.size === 0 ? null : covered.length / goldTokens.length;
  return { score, goldTokens: goldTokens.length, coveredTokens: covered.length, missing };
}

// ── 行级便捷封装（Lead 可能改用别的集成方式，这里保持简单、无副作用） ─────────

/** 从 row 里取原始注入行；生产 row 只落 hits 计数，故也接受 memoryLines/rawHits 形态。 */
function extractHits(row) {
  if (!row) return [];
  for (const key of ["rawHits", "hitList", "hits"]) {
    if (Array.isArray(row[key])) return row[key];
  }
  if (Array.isArray(row.memoryLines)) return row.memoryLines;
  if (Array.isArray(row.recallLines)) return row.recallLines;
  return [];
}

function pickGold(goldByCaseId, caseId) {
  if (goldByCaseId instanceof Map) {
    const v = goldByCaseId.get(caseId);
    return normalizeGold(v);
  }
  if (goldByCaseId && typeof goldByCaseId === "object" && !Array.isArray(goldByCaseId)) {
    return normalizeGold(goldByCaseId[caseId]);
  }
  return normalizeGold(goldByCaseId);
}

function normalizeGold(v) {
  if (v == null) return { turnIds: [], sessionIds: undefined, answer: "" };
  if (Array.isArray(v) || v instanceof Set) return { turnIds: [...toSet(v)], sessionIds: undefined, answer: "" };
  return {
    turnIds: v.turnIds ?? v.evidenceTurnIds ?? [],
    sessionIds: v.sessionIds ?? v.evidenceSessionIds ?? undefined,
    answer: v.answer ?? v.goldAnswer ?? "",
  };
}

function pickResolve(resolveByCaseId, caseId) {
  if (typeof resolveByCaseId === "function") {
    const v = resolveByCaseId(caseId);
    return typeof v === "function" ? v : null;
  }
  if (resolveByCaseId instanceof Map) return resolveByCaseId.get(caseId) ?? null;
  if (resolveByCaseId && typeof resolveByCaseId === "object") return resolveByCaseId[caseId] ?? null;
  return null;
}

function evidenceTextOf(row) {
  if (!row) return "";
  if (typeof row.evidence === "string") return row.evidence;
  if (Array.isArray(row.evidenceLines)) return row.evidenceLines.map((l, i) => `[${i + 1}] ${l}`).join("\n");
  if (Array.isArray(row.hits) && row.hits.length) {
    // 与 llm.mjs buildEvidenceBlock 同形（[n] 内容），但不排序、不截断：归因只看字面覆盖。
    return row.hits.map((h, i) => `[${i + 1}] ${String(h?.content ?? "").replace(/\s+/g, " ").trim()}`).join("\n");
  }
  return "";
}

/**
 * 行级便捷封装：对每条 row 计算注入归因与证据充分性，并跨题汇总分桶行数。
 * @param {Array<object>} rows
 * @param {object} [opts]
 * @param {Record<string, any>|Map<string, any>} [opts.goldByCaseId] 每题 gold（turnIds/evidenceTurnIds）
 * @param {Record<string, Function>|Map<string, Function>|((caseId: string) => Function|null)} [opts.resolveByCaseId]
 * @param {(turnId: string) => string} [opts.sessionOf]
 * @returns {{rows: Array<{caseId: string, lineTypeStats: object, evidenceSufficiency: object}>,
 *            byCaseId: Map<string, {lineTypeStats: object, evidenceSufficiency: object}>,
 *            byTypeTotal: Record<string, {lines: number, goldLines: number, sessions: number}>}}
 */
export function attributeRows(rows, { goldByCaseId, resolveByCaseId, sessionOf } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const byTypeTotal = {};
  for (const t of INJECT_LINE_TYPES) byTypeTotal[t] = { lines: 0, goldLines: 0, sessions: 0 };
  const byCaseId = new Map();
  const out = [];

  for (const row of list) {
    const caseId = String(row?.caseId ?? "");
    const gold = pickGold(goldByCaseId, caseId);
    const lineTypeStats = attributeInjectedLines({
      hits: extractHits(row),
      resolve: pickResolve(resolveByCaseId, caseId) ?? (() => null),
      goldTurnIds: gold.turnIds,
      sessionOf,
      goldSessionIds: gold.sessionIds,
    });
    const sufficiency = evidenceSufficiency({
      evidence: evidenceTextOf(row),
      goldAnswer: row?.gold ?? row?.goldAnswer ?? gold.answer ?? "",
    });
    const entry = { caseId, lineTypeStats, evidenceSufficiency: sufficiency };
    byCaseId.set(caseId, { lineTypeStats, evidenceSufficiency: sufficiency });
    out.push(entry);
    for (const t of INJECT_LINE_TYPES) {
      // 跨题聚合：sessions 按题求和（同名 session 在不同题里会各计一次，口径见报告）。
      byTypeTotal[t].lines += lineTypeStats.byType[t].lines;
      byTypeTotal[t].goldLines += lineTypeStats.byType[t].goldLines;
      byTypeTotal[t].sessions += lineTypeStats.byType[t].sessions;
    }
  }

  return { rows: out, byCaseId, byTypeTotal };
}
