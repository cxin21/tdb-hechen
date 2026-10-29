/**
 * 记忆系统基准数据集适配器：LongMemEval / LoCoMo → 统一的 bench case 结构。
 *
 * 统一结构（下游 ingest/runner 只认这一个形状）：
 *   Case = {
 *     caseId,            // 全局唯一，用作 tenant 的 user_id（每 case 一套租户 = 天然隔离）
 *     tenant: { team_id, user_id, agent_id },
 *     groups: [ { sessionId, dateISO, turns: [ { id, role, speaker, text, tsISO } ] } ],
 *     question, questionDateISO, goldAnswer,
 *     questionType,      // LongMemEval 的 question_type / LoCoMo 的 category 文案
 *     evidenceSessionIds: Set<string>  // 证据所在 session 的 sessionId
 *     evidenceTurnIds: Set<string>     // 证据 turn 的 id（LoCoMo 精确到 dia_id；LME 无 turn 级标注=空）
 *     meta: {...}        // 数据集原始元信息（溯源用）
 *   }
 *
 * 纪律：本模块只读数据集文件，零写盘、零网络。
 */
import fs from "node:fs";

/** 归一化文本：去空白/标点，用于证据模糊匹配（辅口径）。 */
export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]()【】、：:，,。；;·'"|?!！？—-]/g, "");
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error("数据集文件缺失: " + file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ── 日期解析 ────────────────────────────────────────────────────────────────

/** "2023/04/10 (Mon) 17:50" → "2023-04-10T17:50:00"（无时区，按本地墙钟语义） */
export function parseLmeDate(s) {
  const m = String(s ?? "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(?:\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00"] = m;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mi)}:00`;
}

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** "1:56 pm on 8 May, 2023" → "2023-05-08T13:56:00" */
export function parseLocomoDate(s) {
  const m = String(s ?? "").match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})/i,
  );
  if (!m) {
    // 兜底：只有日期没有时刻
    const m2 = String(s ?? "").match(/(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})/);
    if (!m2) return null;
    const mo = MONTHS[m2[2].toLowerCase()];
    if (!mo) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${m2[3]}-${p(mo)}-${p(m2[1])}T00:00:00`;
  }
  const [, hh, mi, ap, d, monName, y] = m;
  const mo = MONTHS[monName.toLowerCase()];
  if (!mo) return null;
  let h = Number(hh) % 12;
  if (ap.toLowerCase() === "pm") h += 12;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${mi}:00`;
}

// ── LongMemEval ─────────────────────────────────────────────────────────────

/**
 * LongMemEval（oracle 变体：haystack_sessions = 每题的证据会话集合）。
 * 官方仓库 xiaowu0162/LongMemEval；oracle 文件每题只带相关 session，
 * 故本口径测的是「给定相关会话能否召回并答对」，非长上下文挤压（s/m 变体）。
 */
export function loadLongMemEval(file) {
  const raw = readJson(file);
  const teamId = "bench-lme";
  const cases = raw.map((it, qi) => {
    const sessionIds = it.haystack_session_ids || [];
    // 会话坐标统一为 session_<位置序号>（与 turn id 的 -s<N>- 段同源），
    // 原始 session id 留在 meta.rawSessionIds 供溯源——否则证据 session 永远对不上号。
    const idxByRawId = new Map();
    sessionIds.forEach((sid, si) => idxByRawId.set(sid, si + 1));
    const groups = (it.haystack_sessions || []).map((turns, si) => {
      const sessionId = sessionIds[si] || `s${si + 1}`;
      const dateISO = parseLmeDate((it.haystack_dates || [])[si]);
      return {
        sessionId,
        dateISO,
        turns: (turns || []).map((m, ti) => ({
          id: `lme-${it.question_id}-s${si + 1}-t${ti + 1}`,
          role: m.role === "assistant" ? "assistant" : "user",
          speaker: m.role === "assistant" ? "Assistant" : "User",
          text: String(m.content ?? ""),
          tsISO: dateISO,
        })),
      };
    });
    const evidenceSessionIds = new Set();
    for (const raw of it.answer_session_ids || []) {
      const idx = idxByRawId.get(raw);
      if (idx) evidenceSessionIds.add(`session_${idx}`);
    }
    // 证据 turn：LME 只有 has_answer 标志（无官方 turn 级标注），保留作辅口径。
    const evidenceTurnIds = new Set();
    (it.haystack_sessions || []).forEach((turns, si) => {
      const rawId = sessionIds[si] || `s${si + 1}`;
      if (!(it.answer_session_ids || []).includes(rawId)) return;
      (turns || []).forEach((m, ti) => {
        if (m.has_answer) evidenceTurnIds.add(`lme-${it.question_id}-s${si + 1}-t${ti + 1}`);
      });
    });
    return {
      caseId: it.question_id,
      // groupKey = 记忆语料身份：同组共用一个库/一个租户，避免重复灌库
      groupKey: it.question_id,
      tenant: { team_id: teamId, user_id: it.question_id, agent_id: "bench-agt" },
      groups,
      question: it.question,
      questionDateISO: parseLmeDate(it.question_date),
      goldAnswer: it.answer,
      questionType: it.question_type,
      evidenceSessionIds,
      evidenceTurnIds,
      meta: {
        question_id: it.question_id,
        question_date: it.question_date,
        sessions: groups.length,
        rawSessionIds: sessionIds,
      },
    };
  });
  return { name: "longmemeval-oracle", file, cases };
}

// ── LoCoMo ──────────────────────────────────────────────────────────────────

const LOCOMO_CATEGORY = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

/**
 * LoCoMo（snap-research/locomo，data/locomo10.json）：10 段极长期对话，
 * 每段 19–32 个 session、约 200–600 轮，QA 共 1986 条（category 1–5）。
 * 证据按 dia_id（"D1:3" = session 1 第 3 轮）精确到轮。
 */
export function loadLoCoMo(file, opts = {}) {
  const raw = readJson(file);
  const sampleLimit = opts.samples && opts.samples > 0 ? opts.samples : raw.length;
  const teamId = "bench-lc";
  const cases = [];
  for (let si = 0; si < Math.min(sampleLimit, raw.length); si++) {
    const sample = raw[si];
    const sampleId = sample.sample_id || `sample_${si}`;
    const conv = sample.conversation || {};
    const sessKeys = Object.keys(conv)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    // dia_id 前缀 D<n> ↔ session_<n>（会话序号一一对应）
    const groups = sessKeys.map((k) => {
      const n = Number(k.slice(8));
      const dateISO = parseLocomoDate(conv[`${k}_date_time`]);
      const turns = (conv[k] || []).map((t, ti) => ({
        id: `lc-${sampleId}-s${n}-t${ti + 1}`,
        role: "user",
        speaker: String(t.speaker ?? ""),
        text: String(t.text ?? ""),
        tsISO: dateISO,
        diaId: t.dia_id,
      }));
      // 以 dia_id 为权威坐标（数据集自带 1-based 轮号，缺失时退回顺序号）
      for (const t of turns) {
        const m = String(t.diaId ?? "").match(/^D(\d+):(\d+)$/);
        if (m) t.id = `lc-${sampleId}-s${Number(m[1])}-t${Number(m[2])}`;
      }
      return { sessionId: `session_${n}`, dateISO, turns };
    });
    const idByDia = new Map();
    for (const g of groups) for (const t of g.turns) if (t.diaId) idByDia.set(t.diaId, t.id);

    (sample.qa || []).forEach((qa, qi) => {
      const evidence = qa.evidence || [];
      const evidenceTurnIds = new Set();
      const evidenceSessionIds = new Set();
      for (const dia of evidence) {
        const id = idByDia.get(dia);
        if (id) evidenceTurnIds.add(id);
        const m = String(dia).match(/^D(\d+):/);
        if (m) evidenceSessionIds.add(`session_${Number(m[1])}`);
      }
      cases.push({
        caseId: `${sampleId}-q${qi + 1}`,
        // 同一段对话（sample）的多个 QA 共用一个租户/一份记忆库：真实语义 = 同一用户的历史
        groupKey: sampleId,
        tenant: { team_id: teamId, user_id: sampleId, agent_id: "bench-agt" },
        groups,
        question: qa.question,
        questionDateISO: null,
        goldAnswer: qa.answer ?? qa.adversarial_answer ?? "",
        questionType: LOCOMO_CATEGORY[qa.category] || `cat${qa.category}`,
        evidenceSessionIds,
        evidenceTurnIds,
        meta: { sample_id: sampleId, category: qa.category, evidence, qa_index: qi, sessions: groups.length },
      });
    });
  }
  return { name: "locomo", file, cases };
}

/** 统一入口：按名字加载。 */
export function loadDataset(name, file, opts = {}) {
  const key = String(name).toLowerCase();
  if (key === "longmemeval" || key === "lme") return loadLongMemEval(file);
  if (key === "locomo" || key === "lc") return loadLoCoMo(file, opts);
  throw new Error(`未知数据集: ${name}（支持 longmemeval | locomo）`);
}

/** 数据集概览（runner 报告头用）。 */
export function summarizeDataset(ds) {
  const byType = {};
  let turns = 0;
  for (const c of ds.cases) {
    byType[c.questionType] = (byType[c.questionType] || 0) + 1;
    for (const g of c.groups) turns += g.turns.length;
  }
  return { name: ds.name, cases: ds.cases.length, turns, byType };
}