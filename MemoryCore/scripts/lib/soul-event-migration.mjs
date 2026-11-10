/**
 * 灵魂事件底座（P0-D）迁移与对账的共享实现。
 *
 * 为什么单独一个 lib：迁移脚本与对账脚本必须用**同一份映射代码**。若两边各写一次
 * 「episode → 事件」的推导，对账就变成「我抄的映射 vs 我写的映射」，永远 0 diff，
 * 等于什么都没验。所以这里只留一份 mapEpisodeRow()：
 *   - 迁移脚本把它写进新表；
 *   - 对账脚本把同一份推导结果和库里真实行逐字段比。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §5.1（映射）、
 * §5.3（验收：幂等 / 覆盖 / 字段 hash / 0 孤儿）、§4.1–§4.5（列与词表）。
 *
 * 安全边界：本模块不打开也不写任何库——db 句柄由 CLI 传入；写入口只有 applyPlan()，
 * 且 CLI 只在 --apply 时才调用。本模块不打印任何行内容（引文可能含隐私），只打印计数与 id。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TAG = "[soul-event-migration]";

/** 生产库（唯一禁止直接写入的目标）。 */
export const PRODUCTION_DB = "D:/TDB/data/vectors.db";

/**
 * 写入列清单（单一事实源）：INSERT 语句与对账读取都从这里生成。
 * 手抄第二份列名是本仓库反复踩过的坑（列加了没写 / 写了没读）。
 */
export const EVENT_COLUMNS = [
  "event_id", "team_id", "user_id", "agent_id", "at", "day", "valid_from", "valid_to",
  "actor", "actor_person_key", "action", "object", "intent", "outcome", "status",
  "source_kind", "source_ref", "ownership", "epistemic", "confidence", "visibility",
  "session_id", "persons_json", "parent_event_id", "dedupe_key", "salience",
  "created_at", "archived_at",
];

export const CHAT_COLUMNS = [
  "event_id", "kind", "title", "user_stance", "agent_stance", "cost", "valence",
  "arousal", "intensity", "affect_source", "quote_json", "signals_json", "layers_json",
  "mood_integrated_at",
];

export const EVIDENCE_COLUMNS = ["event_id", "record_id", "role", "quote", "at", "confidence"];

/**
 * 旧迁移写下的占位证据（role='unknown' 且 quote=''）在解析出真实 role/quote 后要原位替换：
 * 主键是 (event_id, record_id, role)，role 变了 INSERT OR IGNORE 不会覆盖，会多留一行。
 * 只删这一种精确形态——带引文、或已解析出 role 的行一行不碰；重跑幂等。
 */
export const LEGACY_EVIDENCE_PLACEHOLDER_DELETE =
  "DELETE FROM soul_event_evidence WHERE event_id = ? AND record_id = ? AND role = 'unknown' AND quote = ''";

export const GOAL_COLUMNS = [
  "goal_id", "team_id", "user_id", "agent_id", "owner", "kind", "title", "why",
  "status", "priority", "progress", "due_at", "parent_goal_id", "source_event_id",
  "success_criteria", "blocked_reason", "abandon_reason", "valid_from", "valid_to",
  "confidence", "created_at", "updated_at",
];

/** 证据 role 词表（soul_event_evidence.role 的 CHECK）。 */
const EVIDENCE_ROLES = new Set(["user", "assistant", "tool", "system", "unknown"]);

// ─────────────────────────────── 路径与指纹 ───────────────────────────────

export function normalizeDbPath(p) {
  return path.resolve(String(p)).replace(/\\/gu, "/");
}

/** 生产库判定：解析成绝对路径后按文件全路径比较（大小写不敏感，Windows）。 */
export function isProductionDb(p) {
  return normalizeDbPath(p).toLowerCase() === normalizeDbPath(PRODUCTION_DB).toLowerCase();
}

export function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** 流式 sha256（生产库 560MB，不整文件读进内存）。 */
export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("end", resolve);
    s.on("error", reject);
  });
  return hash.digest("hex");
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

// ─────────────────────────────── 租户口径 ───────────────────────────────

/** 本仓库 tenant = (team_id, user_id, agent_id) 三元组（与 soul_episodes / soul_events 一致）。 */
export function tenantOf(row) {
  return {
    teamId: String(row.team_id ?? "default"),
    userId: String(row.user_id ?? "default"),
    agentId: String(row.agent_id ?? "default"),
  };
}

export function tenantKey(tenant) {
  return tenant.teamId + "\u0000" + tenant.userId + "\u0000" + tenant.agentId;
}

export function formatTenant(tenant) {
  return tenant.teamId + "/" + tenant.userId + "/" + tenant.agentId;
}

/**
 * --tenant 取值：team/user/agent（三者都必须给；用 / 分隔是因为本仓库 id 里
 * 出现过 - 与 _，但从未出现 /）。
 */
export function parseTenantSpec(spec) {
  const parts = String(spec).split("/").map((s) => s.trim());
  if (parts.length !== 3 || parts.some((p) => p === "")) {
    throw new Error("--tenant 格式应为 team/user/agent，收到：" + spec);
  }
  return { teamId: parts[0], userId: parts[1], agentId: parts[2] };
}

// ─────────────────────────────── DDL（只读导入，不手抄） ───────────────────────────────

/**
 * 建表语句唯一一份在 src/core/store/soul-event-ddl.ts。
 * 该文件不 import 任何运行时依赖（可被脚本安全加载，不触发 sqlite-vec），
 * 但它是 .ts，所以调用方必须已由 tsx loader 激活（两个 CLI 都做了自举）。
 */
export async function loadSoulEventDdl() {
  return await import("../../src/core/store/soul-event-ddl.ts");
}

/**
 * 旧 episode 证据的 record_id → L0 原话解析器（F5）。
 *
 * 为什么需要：\`soul_episodes.evidence_json\` 只存 record_id 数组，迁移时没有 role/quote，
 * 于是 248 条证据被写成 role='unknown' + quote=''。这不是「历史脏数据」——record_id
 * 本身就能回查 l0_conversations；不补，这些证据在 observed 判据里永远不算观察，
 * 事件也就永远停在 inferred。
 *
 * 只读：SELECT 一行，不写任何东西；表不存在或行查不到都返回 null（调用方退回 unknown）。
 */
export function buildLegacyRecordResolver(db) {
  if (!tableExists(db, "l0_conversations")) return null;
  const stmt = db.prepare(
    "SELECT role, message_text, recorded_at FROM l0_conversations WHERE record_id = ? LIMIT 1",
  );
  const cache = new Map();
  // 引文只用于「谁说了什么」的定位，不需要整段 L0（压缩段会有几万字）。
  const QUOTE_MAX = 300;
  return (recordId) => {
    if (typeof recordId !== "string" || recordId.trim() === "") return null;
    const key = recordId.trim();
    if (cache.has(key)) return cache.get(key);
    let resolved = null;
    try {
      const row = stmt.get(key);
      if (row) {
        const messageText = text(row.message_text).replace(/\s+/gu, " ").trim();
        resolved = {
          role: text(row.role).trim(),
          quote: messageText.length > QUOTE_MAX ? messageText.slice(0, QUOTE_MAX) + "…" : messageText,
          at: text(row.recorded_at).trim(),
        };
      }
    } catch {
      resolved = null;
    }
    cache.set(key, resolved);
    return resolved;
  };
}

export function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1")
    .get(name);
  return Boolean(row);
}

/**
 * 确保目标表/列就位（只在 --apply 路径调用）。
 * ALTER 的两条纪律沿用仓库惯例：表不存在就跳过（新库只建表不补列）；
 * 只吞 duplicate column name（幂等重入），其它错误必须冒泡。
 */
export async function ensureTargetSchema(db) {
  const mod = await loadSoulEventDdl();
  const created = [];
  for (const ddl of mod.SOUL_EVENT_DDL) {
    db.exec(ddl);
    created.push(ddl);
  }
  const skipped = [];
  for (const ddl of mod.SOUL_EVENT_MIGRATION_DDL) {
    const m = /ALTER\s+TABLE\s+([\w$]+)/iu.exec(ddl);
    const table = m ? m[1] : "";
    if (table !== "" && !tableExists(db, table)) {
      skipped.push(table);
      continue;
    }
    try {
      db.exec(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/iu.test(msg)) throw err;
    }
  }
  return { ddlCount: created.length, skippedTables: [...new Set(skipped)] };
}

// ─────────────────────────────── 值规范化 ───────────────────────────────

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

function text(v) {
  return v === null || v === undefined ? "" : String(v);
}

function nullableText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function parseJson(value) {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseJsonObject(value) {
  const v = parseJson(value);
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function parseStringArray(value) {
  const v = parseJson(value);
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : [];
}

/** JSON 文本归一（只为比较：parse 后 stringify 结果稳定；非法 JSON 原样保留）。 */
export function canonicalJsonText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function roleOf(raw) {
  const r = typeof raw === "string" ? raw.trim() : "";
  return EVIDENCE_ROLES.has(r) ? r : "unknown";
}

function dayOf(row) {
  const day = text(row.day).trim();
  if (day !== "") return day;
  const at = text(row.at);
  return at.length >= 10 ? at.slice(0, 10) : at;
}

// ─────────────────────────────── §5.1 映射（唯一一份） ───────────────────────────────

/**
 * 旧 episode → 事件 + chat + 证据 的期望值。
 *
 * 逐条对齐 spec §5.1：
 *  - event_id = episode_id（旧引用不断）；
 *  - at/day、session_id、persons_json 直接复制；
 *  - actor='user'、action='said'、object 原样复制（空就是空，不拿 title 冒充对象）、intent=title、outcome 复制、status='unknown'；
 *  - source_kind='chat'、source_ref=quote.recordId、ownership='theirs'、
 *    epistemic='observed'、confidence=0.8；
 *  - dedupe_key 与双写同一口径：`soul-episode:<episodeId>`（event_id 本身全局唯一，
 *    partial unique index 不会跨租户撞；不写 NULL，否则重跑对账永远差这一列）；
 *  - 没有可用引文的老行：quote=''、confidence=0.5、epistemic='inferred'（不假装观察到）；
 *  - 聊天字段进 soul_event_chat；evidence 按 evidence_json 展开，引文从 quote_json 取；
 *  - 有证据的事件至少一条证据；evidence_json 与 quote 都空时 evidence=[]，
 *    不落 synthetic 指针（不拿 legacy:episode 冒充 L0 引文；无证据就标 inferred）。
 *
 * 两个 spec 没写死、这里定死并写进报告的口径：
 *  - created_at 取 at：旧行没有独立落库时刻，用事件时刻兜底，保证「重跑逐字段一致」，
 *    否则每跑一次 created_at 都变，对账 hash 永远不稳。
 *  - actor_person_key 留 NULL：从 persons_json 里挑「谁是 user」是推断，不在迁移里猜。
 */
export function mapEpisodeRow(row, resolveRecord = null) {
  const tenant = tenantOf(row);
  const episodeId = text(row.episode_id);
  const at = text(row.at);
  const quote = parseJsonObject(row.quote_json);
  const quoteText = quote && typeof quote.text === "string" ? quote.text : "";
  const quoteRecordId = quote && typeof quote.recordId === "string" ? quote.recordId.trim() : "";
  const usableQuote = quoteText !== "" && quoteRecordId !== "";

  const event = {
    event_id: episodeId,
    team_id: tenant.teamId,
    user_id: tenant.userId,
    agent_id: tenant.agentId,
    at,
    day: dayOf(row),
    valid_from: at,
    valid_to: null,
    actor: "user",
    actor_person_key: null,
    action: "said",
    object: text(row.object),
    intent: text(row.title),
    outcome: text(row.outcome),
    status: "unknown",
    source_kind: "chat",
    source_ref: usableQuote ? quoteRecordId : "",
    ownership: "theirs",
    epistemic: usableQuote ? "observed" : "inferred",
    confidence: usableQuote ? 0.8 : 0.5,
    visibility: "shared",
    session_id: text(row.session_id),
    persons_json: nullableText(row.persons_json),
    parent_event_id: null,
    dedupe_key: `soul-episode:${episodeId}`,
    salience: 0.5,
    created_at: at,
    archived_at: nullableText(row.archived_at),
  };

  const chat = {
    event_id: episodeId,
    kind: text(row.kind) !== "" ? text(row.kind) : "decision",
    title: text(row.title),
    user_stance: text(row.user_stance),
    agent_stance: text(row.agent_stance),
    cost: text(row.cost),
    valence: num(row.valence),
    arousal: num(row.arousal),
    intensity: num(row.intensity),
    affect_source: text(row.affect_source) !== "" ? text(row.affect_source) : "lexicon",
    quote_json: nullableText(row.quote_json),
    signals_json: nullableText(row.signals_json),
    layers_json: nullableText(row.layers_json),
    mood_integrated_at: nullableText(row.mood_integrated_at),
  };

  const evidence = [];
  const seen = new Set();
  const pushEvidence = (item) => {
    const key = item.record_id + "\u0000" + item.role;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push(item);
  };

  if (usableQuote) {
    pushEvidence({
      event_id: episodeId,
      record_id: quoteRecordId,
      role: roleOf(quote.role),
      quote: quoteText,
      at: text(quote.at) !== "" ? text(quote.at) : at,
      confidence: 1,
    });
  }
  for (const recordId of parseStringArray(row.evidence_json)) {
    if (recordId === quoteRecordId) continue;
    // 旧 episode 的 evidence_json 只有 record_id，谁说的、说了什么都在 L0 里。
    // 早先这里一律写 role='unknown' + quote=''（生产 248 条），把「能回查的证据」
    // 写成了「没有引文的证据」。调用方给出解析器时按 L0 原话补齐；
    // 取不到才退回 unknown/''（仍按 inferred 计，不假装观察到）。
    const resolved = typeof resolveRecord === "function" ? resolveRecord(recordId) : null;
    const role = resolved ? roleOf(resolved.role) : "unknown";
    const quoteText = resolved && typeof resolved.quote === "string" ? resolved.quote : "";
    pushEvidence({
      event_id: episodeId,
      record_id: recordId,
      role,
      quote: quoteText,
      at: resolved && text(resolved.at) !== "" ? text(resolved.at) : at,
      confidence: quoteText !== "" ? 1 : 0.5,
    });
  }
  return { tenant, event, chat, evidence };
}

/**
 * 承诺 → 目标（spec §5.1 末条）：kind=commitment，goal_id 由 promise_id 派生（可反查、重跑不变）。
 *
 * owner 三态里：用户提出/用户要求 = joint（我答应了他）；我答应自己 = self。
 * soul_promises.source 在生产里只有 user 与 episode-history 两种（evidence/proposal 只用于
 * 状态流转来源，不是来源列），所以这条判据是确定的，不是猜。
 */
export function mapPromiseRow(row, sourceEventId = null) {
  const tenant = tenantOf(row);
  const promiseId = text(row.promise_id);
  const source = text(row.source);
  const status = text(row.status) === "" ? "open" : text(row.status);
  const createdAt = text(row.created_at);
  const updatedAt = text(row.updated_at) !== "" ? text(row.updated_at) : createdAt;
  const resolvedAt = nullableText(row.resolved_at);
  const refKey = text(row.ref_key).trim();

  const owner = source === "user" ? "joint" : "self";
  const goalStatus = status === "open" ? "active" : status === "kept" ? "done" : "abandoned";

  const whyParts = ["迁移自 soul_promises:" + promiseId];
  if (source !== "") whyParts.push("来源 " + source);
  if (refKey !== "") whyParts.push("关联键 " + refKey);

  return {
    tenant,
    promiseId,
    goal: {
      goal_id: "goal-" + promiseId,
      team_id: tenant.teamId,
      user_id: tenant.userId,
      agent_id: tenant.agentId,
      owner,
      kind: "commitment",
      title: text(row.content),
      why: whyParts.join("；"),
      status: goalStatus,
      priority: 0.5,
      progress: status === "kept" ? 1 : 0,
      due_at: null,
      parent_goal_id: null,
      source_event_id: nullableText(sourceEventId),
      success_criteria: "",
      blocked_reason: "",
      abandon_reason: goalStatus === "abandoned" ? "legacy-promise-status:" + status : "",
      valid_from: createdAt,
      valid_to: goalStatus === "done" || goalStatus === "abandoned" ? (resolvedAt ?? updatedAt) : null,
      confidence: 0.8,
      created_at: createdAt !== "" ? createdAt : updatedAt,
      updated_at: updatedAt,
    },
  };
}

/**
 * 关系 → event_id：spec 说「record_id 通过 evidence 映射到 event_id；找不到就留 NULL，不猜」。
 * 多个事件共用同一条 L0 记录时（一条消息切出两件事），优先取「这条记录就是它引文」的那个事件
 * （source_ref = record_id）——那不是猜，是更强的同一性判据；仍不唯一就留 NULL 并计数。
 */
/**
 * 证据索引：record_id → { event_id → source_ref }，供 relation 的 record_id 反查事件。
 *
 * 为什么不能只查库：迁移是一次性写事件+证据，relation 的 record_id 往往只出现在**本批还没落库**
 * 的证据里。只查库会让 relation 第一批全部映射失败、要跑第二次才对——那不是幂等，是需要跑两遍。
 * 所以索引 = 库里已有的证据 ∪ 本次计划要写的证据（后者 source_ref 来自事件本身）。
 */
export function buildEvidenceIndex(db, tenants = [], planned = []) {
  const index = new Map();
  const add = (recordId, eventId, sourceRef) => {
    const rid = nullableText(recordId);
    const eid = nullableText(eventId);
    if (rid === null || eid === null) return;
    let m = index.get(rid);
    if (!m) {
      m = new Map();
      index.set(rid, m);
    }
    const src = nullableText(sourceRef) ?? "";
    if (!m.has(eid) || (src !== "" && m.get(eid) === "")) m.set(eid, src);
  };

  if (tableExists(db, "soul_event_evidence") && tableExists(db, "soul_events")) {
    const base =
      "SELECT ev.record_id AS record_id, ev.event_id AS event_id, e.source_ref AS source_ref" +
      " FROM soul_event_evidence ev JOIN soul_events e ON e.event_id = ev.event_id";
    if (tenants.length === 0) {
      for (const r of db.prepare(base).all()) add(r.record_id, r.event_id, r.source_ref);
    } else {
      const sql = base + " WHERE e.team_id = ? AND e.user_id = ? AND e.agent_id = ?";
      for (const t of tenants) for (const r of db.prepare(sql).all(t.teamId, t.userId, t.agentId)) add(r.record_id, r.event_id, r.source_ref);
    }
  }
  for (const p of planned) add(p.record_id, p.event_id, p.sourceRef);
  return index;
}

/** 从证据索引里定 event_id：唯一 → 它就是；多个 → 优先 source_ref === record_id 那条；仍不唯一 → NULL。 */
export function resolveFromEvidenceIndex(index, recordId) {
  const rid = nullableText(recordId);
  if (rid === null) return { eventId: null, reason: "empty-record-id" };
  const m = index.get(rid);
  if (!m || m.size === 0) return { eventId: null, reason: "no-evidence-match" };
  if (m.size === 1) return { eventId: [...m.keys()][0], reason: "unique" };
  const self = [...m.entries()].filter(([, src]) => src === rid);
  if (self.length === 1) return { eventId: self[0][0], reason: "source-ref" };
  return { eventId: null, reason: "ambiguous", candidates: m.size };
}

/** 取关系行里的引文：优先 quote 列，其次 evidence_json[0].quote（历史行只有后者）。 */
export function relationQuote(row) {
  const direct = nullableText(row?.quote);
  if (direct !== null) return direct;
  try {
    const parsed = JSON.parse(text(row?.evidence_json) || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) return nullableText(parsed[0]?.quote) ?? "";
  } catch {
    /* 坏 JSON 当没有引文 */
  }
  return "";
}

/**
 * 引文 → L0 record_id → 证据索引 → event_id。
 * 只做精确匹配或唯一子串匹配；多条命中就留 NULL，不猜。
 * 用于 relation 的 record_id 已被清理、但引文仍逐字留在 L0 的情况。
 */
export function resolveEventIdByQuote(db, tenant, quote, index) {
  const q = String(quote ?? "").trim();
  if (q === "") return { eventId: null, reason: "empty-quote" };
  if (!tableExists(db, "l0_conversations")) return { eventId: null, reason: "no-l0-table" };
  const cols = "record_id FROM l0_conversations WHERE team_id = ? AND user_id = ? AND agent_id = ?";
  const args = [tenant.teamId, tenant.userId, tenant.agentId];
  let rows = db.prepare("SELECT " + cols + " AND message_text = ? LIMIT 2").all(...args, q);
  if (rows.length === 0) {
    rows = db.prepare("SELECT " + cols + " AND instr(message_text, ?) > 0 LIMIT 2").all(...args, q);
  }
  if (rows.length === 0) return { eventId: null, reason: "quote-not-in-l0" };
  if (rows.length > 1) return { eventId: null, reason: "quote-ambiguous-l0" };
  const recordId = String(rows[0].record_id);
  const resolved = resolveFromEvidenceIndex(index, recordId);
  if (resolved.eventId === null) return { eventId: null, reason: "quote-" + resolved.reason };
  return { eventId: resolved.eventId, reason: resolved.reason, recordId };
}

/**
 * 只查库的旧入口（保留给对账/单点排查用）。迁移主路径用 buildEvidenceIndex + resolveFromEvidenceIndex，
 * 否则 relation 要跑两遍才对。
 */
export function resolveRelationEventId(db, tenant, recordId) {
  if (recordId === "") return { eventId: null, reason: "empty-record-id" };
  if (!tableExists(db, "soul_event_evidence") || !tableExists(db, "soul_events")) {
    return { eventId: null, reason: "no-event-tables" };
  }
  const rows = db
    .prepare(
      "SELECT DISTINCT e.event_id AS event_id, e.source_ref AS source_ref" +
        " FROM soul_event_evidence ev JOIN soul_events e ON e.event_id = ev.event_id" +
        " WHERE ev.record_id = ? AND e.team_id = ? AND e.user_id = ? AND e.agent_id = ?",
    )
    .all(recordId, tenant.teamId, tenant.userId, tenant.agentId);
  if (rows.length === 0) return { eventId: null, reason: "no-evidence-match" };
  if (rows.length === 1) return { eventId: String(rows[0].event_id), reason: "unique" };
  const self = rows.filter((r) => String(r.source_ref) === recordId);
  if (self.length === 1) return { eventId: String(self[0].event_id), reason: "source-ref" };
  return { eventId: null, reason: "ambiguous", candidates: rows.length };
}

// ─────────────────────────────── 读取旧表 ───────────────────────────────

function filterTenant(rows, tenants) {
  if (!tenants || tenants.length === 0) return rows;
  const wanted = new Set(tenants.map(tenantKey));
  return rows.filter((r) => wanted.has(tenantKey(tenantOf(r))));
}

export function readLegacyEpisodes(db, tenants) {
  if (!tableExists(db, "soul_episodes")) {
    throw new Error("库里没有 soul_episodes（旧事件表）——目标不对，或这是空库");
  }
  return filterTenant(db.prepare("SELECT * FROM soul_episodes ORDER BY episode_id ASC").all(), tenants);
}

export function readLegacyEmotions(db, tenants) {
  if (!tableExists(db, "soul_emotions")) return [];
  return filterTenant(db.prepare("SELECT * FROM soul_emotions").all(), tenants);
}

export function readLegacyRelations(db, tenants) {
  if (!tableExists(db, "soul_person_relation")) return [];
  return filterTenant(db.prepare("SELECT * FROM soul_person_relation").all(), tenants);
}

export function readLegacyPromises(db, tenants) {
  if (!tableExists(db, "soul_promises")) return [];
  return filterTenant(db.prepare("SELECT * FROM soul_promises").all(), tenants);
}

// ─────────────────────────────── 计划（只读） ───────────────────────────────

function insertSql(table, columns) {
  return (
    "INSERT OR IGNORE INTO " + table + " (" + columns.join(", ") + ") VALUES (" +
    columns.map(() => "?").join(", ") + ")"
  );
}

function runInsert(db, table, columns, row) {
  const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
  return Number(db.prepare(insertSql(table, columns)).run(...values).changes ?? 0);
}

/**
 * 生成迁移计划（只读，一个字节都不写）。
 * 按租户分批：计划按 tenant 分组，applyPlan() 每组一个 BEGIN IMMEDIATE/COMMIT。
 */
export function planMigration(db, { tenants = [] } = {}) {
  const episodes = readLegacyEpisodes(db, tenants);
  const emotions = readLegacyEmotions(db, tenants);
  const relations = readLegacyRelations(db, tenants);
  const promises = readLegacyPromises(db, tenants);

  const existingEvents = new Set();
  if (tableExists(db, "soul_events")) {
    for (const r of db.prepare("SELECT event_id FROM soul_events").all()) existingEvents.add(String(r.event_id));
  }

  const groups = new Map();
  const groupOf = (tenant) => {
    const key = tenantKey(tenant);
    let group = groups.get(key);
    if (!group) {
      group = {
        tenant,
        key,
        eventIds: new Set(),
        events: [],
        chat: [],
        evidence: [],
        emotionUpdates: [],
        relationUpdates: [],
        goals: [],
        goalSourceUpdates: [],
        promiseUpdates: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  // 证据的 role/quote 从 L0 回查（F5）：旧 evidence_json 只有 record_id。
  const resolveRecord = buildLegacyRecordResolver(db);
  const plannedEvidence = [];
  for (const row of episodes) {
    const mapped = mapEpisodeRow(row, resolveRecord);
    const group = groupOf(mapped.tenant);
    group.eventIds.add(mapped.event.event_id);
    group.events.push(mapped.event);
    group.chat.push(mapped.chat);
    for (const item of mapped.evidence) {
      group.evidence.push(item);
      plannedEvidence.push({
        event_id: item.event_id,
        record_id: item.record_id,
        sourceRef: mapped.event.source_ref,
      });
    }
  }
  const evidenceIndex = buildEvidenceIndex(db, tenants, plannedEvidence);

  let emotionOrphan = 0;
  for (const row of emotions) {
    if (nullableText(row.event_id) !== null) continue;
    const episodeId = text(row.episode_id);
    if (episodeId === "") continue;
    const tenant = tenantOf(row);
    const group = groups.get(tenantKey(tenant));
    // 目标事件必须存在且同租户：情绪行可能指向已归档/未迁移的 episode（孤儿不进迁移）。
    if (!group || !group.eventIds.has(episodeId)) {
      emotionOrphan += 1;
      continue;
    }
    group.emotionUpdates.push({ episodeId, eventId: episodeId });
  }

  let relationUnmapped = 0;
  let relationAmbiguous = 0;
  for (const row of relations) {
    if (nullableText(row.event_id) !== null) continue;
    const tenant = tenantOf(row);
    if (!groups.has(tenantKey(tenant))) continue;
    let resolved = resolveFromEvidenceIndex(evidenceIndex, row.record_id);
    if (resolved.eventId === null) {
      // record_id 可能已被清理，但引文仍逐字在 L0：按「引文 → L0 → 证据」再定一次；
      // 仍不唯一/找不到就留 NULL，不猜。
      resolved = resolveEventIdByQuote(db, tenant, relationQuote(row), evidenceIndex);
    }
    if (resolved.eventId === null) {
      if (resolved.reason === "ambiguous") relationAmbiguous += 1;
      else relationUnmapped += 1;
      continue;
    }
    groupOf(tenant).relationUpdates.push({ relId: text(row.rel_id), eventId: resolved.eventId });
  }

  let promiseOrphan = 0;
  for (const row of promises) {
    const tenant = tenantOf(row);
    if (!groups.has(tenantKey(tenant))) {
      promiseOrphan += 1;
      continue;
    }
    const refKey = text(row.ref_key).trim();
    const event = refKey === ""
      ? { eventId: null, reason: "empty-ref-key" }
      : resolveEventIdByQuote(db, tenant, refKey, evidenceIndex);
    const mapped = mapPromiseRow(row, event.eventId);
    const group = groupOf(tenant);
    group.goals.push(mapped.goal);
    if (event.eventId !== null) {
      group.goalSourceUpdates.push({ goalId: mapped.goal.goal_id, eventId: event.eventId });
    }
    if (nullableText(row.goal_id) === null) {
      group.promiseUpdates.push({ promiseId: mapped.promiseId, goalId: mapped.goal.goal_id });
    }
  }

  const result = {
    groups: [],
    totals: {
      episodes: episodes.length,
      legacyEmotions: emotions.length,
      legacyRelations: relations.length,
      legacyPromises: promises.length,
      events: 0,
      chat: 0,
      evidence: 0,
      emotionUpdates: 0,
      relationUpdates: 0,
      goals: 0,
      goalSourceUpdates: 0,
      promiseUpdates: 0,
      eventsAlreadyPresent: 0,
      clusters: 0,
    },
    skipped: { emotionOrphan, relationUnmapped, relationAmbiguous, promiseOrphan },
  };

  const allIds = new Set();
  for (const group of groups.values()) for (const id of group.eventIds) allIds.add(id);

  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const already = group.events.filter((r) => existingEvents.has(r.event_id)).length;
    result.totals.events += group.events.length;
    result.totals.chat += group.chat.length;
    result.totals.evidence += group.evidence.length;
    result.totals.emotionUpdates += group.emotionUpdates.length;
    result.totals.relationUpdates += group.relationUpdates.length;
    result.totals.goals += group.goals.length;
    result.totals.goalSourceUpdates += group.goalSourceUpdates.length;
    result.totals.promiseUpdates += group.promiseUpdates.length;
    result.totals.eventsAlreadyPresent += already;
    result.groups.push({
      tenant: group.tenant,
      key: group.key,
      label: formatTenant(group.tenant),
      counts: {
        episodes: group.events.length,
        events: group.events.length,
        chat: group.chat.length,
        evidence: group.evidence.length,
        emotionUpdates: group.emotionUpdates.length,
        relationUpdates: group.relationUpdates.length,
        goals: group.goals.length,
        goalSourceUpdates: group.goalSourceUpdates.length,
        promiseUpdates: group.promiseUpdates.length,
        eventsAlreadyPresent: already,
      },
      rows: group,
    });
  }
  result.totals.clusters = allIds.size;
  return result;
}

/**
 * 落库：逐租户 BEGIN IMMEDIATE/COMMIT（spec §6 P0 的「分批 + 事务」）。
 * 单租户失败只回滚该租户，已提交的租户不回退——迁移可续跑，重跑幂等。
 */
export function applyPlan(db, plan, { now = new Date().toISOString(), logger = console } = {}) {
  const result = {
    tenants: [],
    totals: {
      events: 0,
      chat: 0,
      evidence: 0,
      dedupeKeys: 0,
      emotionUpdates: 0,
      relationUpdates: 0,
      goals: 0,
      goalSourceUpdates: 0,
      promiseUpdates: 0,
      placeholderEvidenceFixed: 0,
      placeholderEvidenceFixedEvents: 0,
      skippedByConflict: 0,
    },
    failed: [],
    ok: true,
    now,
  };

  for (const group of plan.groups) {
    const rows = group.rows;
    const touched =
      rows.events.length + rows.chat.length + rows.evidence.length + rows.goals.length +
      rows.emotionUpdates.length + rows.relationUpdates.length + rows.goalSourceUpdates.length +
      rows.promiseUpdates.length;
    if (touched === 0) continue;

    const counts = {
      tenant: group.label,
      events: 0,
      chat: 0,
      evidence: 0,
      dedupeKeys: 0,
      emotionUpdates: 0,
      relationUpdates: 0,
      goals: 0,
      goalSourceUpdates: 0,
      promiseUpdates: 0,
      placeholderEvidenceFixed: 0,
      placeholderEvidenceFixedEvents: 0,
      skippedByConflict: 0,
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      const dedupeUpd = db.prepare(
        "UPDATE soul_events SET dedupe_key = ? WHERE event_id = ? AND (dedupe_key IS NULL OR dedupe_key = '')",
      );
      const dropLegacyPlaceholder = db.prepare(LEGACY_EVIDENCE_PLACEHOLDER_DELETE);
      // 行数与涉及事件数分开记：一条事件常有多条占位证据（生产 250 行 / 135 事件）。
      const fixedEventIds = new Set();
      for (const row of rows.events) {
        counts.events += runInsert(db, "soul_events", EVENT_COLUMNS, row);
        // 旧迁移写过 NULL 的行在这里补成与双写一致的 dedupe_key；只填空，不覆盖已有非空值。
        counts.dedupeKeys += Number(dedupeUpd.run(row.dedupe_key, row.event_id).changes ?? 0);
      }
      for (const row of rows.chat) counts.chat += runInsert(db, "soul_event_chat", CHAT_COLUMNS, row);
      for (const row of rows.evidence) {
        // 主键是 (event_id, record_id, role)：解析出真实 role 后，旧迁移写下的占位行
        // （role='unknown' 且 quote=''）必须原位删掉，否则重跑会多留一条重复证据。
        // 只删这个精确占位形态，带引文或已解析 role 的行一行不碰。
        if (row.role !== "unknown" || row.quote !== "") {
          // 删掉的正是「上一轮写下的占位」才算修好一条（重跑时这里是 0）。
          const removed = Number(dropLegacyPlaceholder.run(row.event_id, row.record_id).changes ?? 0);
          counts.placeholderEvidenceFixed += removed;
          if (removed > 0) fixedEventIds.add(String(row.event_id));
        }
        counts.evidence += runInsert(db, "soul_event_evidence", EVIDENCE_COLUMNS, row);
      }
      counts.placeholderEvidenceFixedEvents = fixedEventIds.size;
      for (const row of rows.goals) counts.goals += runInsert(db, "soul_goals", GOAL_COLUMNS, row);

      const t = rows.tenant;
      if (rows.goalSourceUpdates.length > 0) {
        const upd = db.prepare(
          "UPDATE soul_goals SET source_event_id = ? WHERE goal_id = ? AND team_id = ? AND user_id = ?" +
            " AND agent_id = ? AND (source_event_id IS NULL OR source_event_id = '')",
        );
        for (const u of rows.goalSourceUpdates) {
          counts.goalSourceUpdates += Number(upd.run(u.eventId, u.goalId, t.teamId, t.userId, t.agentId).changes ?? 0);
        }
      }
      if (rows.emotionUpdates.length > 0) {
        const upd = db.prepare(
          "UPDATE soul_emotions SET event_id = ? WHERE episode_id = ? AND team_id = ? AND user_id = ?" +
            " AND agent_id = ? AND (event_id IS NULL OR event_id = '')",
        );
        for (const u of rows.emotionUpdates) {
          counts.emotionUpdates += Number(upd.run(u.eventId, u.episodeId, t.teamId, t.userId, t.agentId).changes ?? 0);
        }
      }
      if (rows.relationUpdates.length > 0) {
        const upd = db.prepare(
          "UPDATE soul_person_relation SET event_id = ? WHERE rel_id = ? AND team_id = ? AND user_id = ?" +
            " AND agent_id = ? AND (event_id IS NULL OR event_id = '')",
        );
        for (const u of rows.relationUpdates) {
          counts.relationUpdates += Number(upd.run(u.eventId, u.relId, t.teamId, t.userId, t.agentId).changes ?? 0);
        }
      }
      if (rows.promiseUpdates.length > 0) {
        const upd = db.prepare(
          "UPDATE soul_promises SET goal_id = ? WHERE promise_id = ? AND team_id = ? AND user_id = ?" +
            " AND agent_id = ? AND (goal_id IS NULL OR goal_id = '')",
        );
        for (const u of rows.promiseUpdates) {
          counts.promiseUpdates += Number(upd.run(u.goalId, u.promiseId, t.teamId, t.userId, t.agentId).changes ?? 0);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务已不存在 */
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(TAG + " 租户 " + counts.tenant + " 迁移失败，已回滚该租户：" + msg);
      result.failed.push({ tenant: counts.tenant, error: msg });
      continue;
    }

    counts.skippedByConflict =
      rows.events.length + rows.chat.length + rows.evidence.length + rows.goals.length -
      (counts.events + counts.chat + counts.evidence + counts.goals);
    if (counts.skippedByConflict < 0) counts.skippedByConflict = 0;

    const keys = [
      "events", "chat", "evidence", "dedupeKeys", "emotionUpdates", "relationUpdates", "goals",
      "goalSourceUpdates", "promiseUpdates", "placeholderEvidenceFixed", "placeholderEvidenceFixedEvents",
      "skippedByConflict",
    ];
    for (const k of keys) result.totals[k] += counts[k];
    result.tenants.push(counts);
    logger.log(
      TAG + " 租户 " + counts.tenant + " 提交：events +" + counts.events + " chat +" + counts.chat +
        " evidence +" + counts.evidence + " dedupeKeys~" + counts.dedupeKeys + " goals +" + counts.goals +
        " emotions~" + counts.emotionUpdates + " relations~" + counts.relationUpdates +
        " goalSource~" + counts.goalSourceUpdates + " promises~" + counts.promiseUpdates,
    );
  }

  result.ok = result.failed.length === 0;
  return result;
}

// ─────────────────────────────── 对账（只读） ───────────────────────────────

/** 表的列名集合（用于判断旧库是否已跑过 SOUL_EVENT_MIGRATION_DDL）。 */
export function tableColumns(db, name) {
  if (!tableExists(db, name)) return new Set();
  const rows = db.prepare("PRAGMA table_info(" + name + ")").all();
  return new Set(rows.map((r) => String(r.name)));
}

/** 比较「期望值 vs 落库值」：NULL 只等于 NULL；数字按数值；字符串按 JSON 归一后逐字。 */
function sameValue(expected, stored) {
  const eNull = expected === null || expected === undefined;
  const sNull = stored === null || stored === undefined;
  if (eNull || sNull) return eNull && sNull;
  if (typeof expected === "number" || typeof stored === "number") {
    const a = Number(expected);
    const b = Number(stored);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return canonicalJsonText(String(expected)) === canonicalJsonText(String(stored));
}

function hashLine(prefix, row, columns) {
  const parts = [];
  for (const c of columns) {
    const v = row[c];
    const s = v === null || v === undefined ? "\u0000null" : String(canonicalJsonText(v));
    parts.push(prefix + "." + c + "=" + s);
  }
  return parts.join("&");
}

/**
 * 「库里是空、期望有值」与「库里写了别的值」必须分开（t22 口径）。
 *
 * 为什么：迁移是 INSERT OR IGNORE——已经存在的 soul_events 行一个字都不会被覆盖
 * （runInsert 只看 changes）。存量行写在前、字段后加（例如 intent 后补），
 * 它的空值在这套 insert-only 迁移下永远收敛不了；对账把这种「待回填」按写错值
 * 报红，操作者只会看到一堆 exit 1，分不清「证据修好了」和「值写错了」。
 *
 * 空判定要窄，避免把真实值误判成空：只有 null/undefined 与纯空白字符串算空；
 * '0'、'false'、'unknown' 都是值，照旧按真 mismatch 处理。
 */
export function isEmptyStoredValue(v) {
  if (v === null || v === undefined) return true;
  return typeof v === "string" && v.trim() === "";
}

function hasStoredValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  // 数字（含 0）与布尔（含 false）都是「有值」。
  return true;
}

/**
 * 单个字段的判定：equal（一致）/ backfill（库空、期望有值）/ mismatch（库里有值但不是这个值）。
 */
export function classifyStoredDiff(expected, stored) {
  if (sameValue(expected, stored)) return "equal";
  if (isEmptyStoredValue(stored) && hasStoredValue(expected)) return "backfill";
  return "mismatch";
}

/**
 * 对账（spec §5.2）：只读，一个字节都不写。
 *
 * 比什么：
 *  1. 旧 soul_episodes 条数 = 新 soul_events 条数（每租户）——迁移没漏行；
 *  2. soul_event_chat 条数 = 事件数、每条事件都有 chat 行；
 *  3. 每条事件至少一条 soul_event_evidence；
 *  4. 每条旧 episode 现场重算 mapEpisodeRow()，与落库的 events/chat 逐字段比对，
 *     并给每租户一个「字段 hash」（同一份旧数据永远算出同一个 hash，重跑可比）；
 *  5. 0 孤儿 event_id：emotions/relations/evidence/chat 指向的事件必须真实存在；
 *  6. promise → goal 全建、goal_id 全回填。
 *
 * 有任一 diff → ok=false（CLI 据此 exit 1）。
 */
export function collectParity(db, { tenants = [] } = {}) {
  const legacyEpisodes = readLegacyEpisodes(db, tenants);
  const legacyEmotions = readLegacyEmotions(db, tenants);
  const legacyRelations = readLegacyRelations(db, tenants);
  const legacyPromises = readLegacyPromises(db, tenants);

  const hasEvents = tableExists(db, "soul_events");
  const hasChat = tableExists(db, "soul_event_chat");
  const hasEvidence = tableExists(db, "soul_event_evidence");
  const hasGoals = tableExists(db, "soul_goals");
  const emotionCols = tableColumns(db, "soul_emotions");
  const relationCols = tableColumns(db, "soul_person_relation");
  const promiseCols = tableColumns(db, "soul_promises");

  const issues = [];
  if (!hasEvents) issues.push("目标表 soul_events 不存在（尚未迁移）");
  if (!hasChat) issues.push("目标表 soul_event_chat 不存在（尚未迁移）");
  if (!hasEvidence) issues.push("目标表 soul_event_evidence 不存在（尚未迁移）");
  if (!hasGoals) issues.push("目标表 soul_goals 不存在（尚未迁移）");
  if (hasEvents && !emotionCols.has("event_id")) issues.push("soul_emotions.event_id 列不存在（未跑 MIGRATION_DDL）");
  if (!relationCols.has("event_id")) issues.push("soul_person_relation.event_id 列不存在（未跑 MIGRATION_DDL）");
  if (!promiseCols.has("goal_id")) issues.push("soul_promises.goal_id 列不存在（未跑 MIGRATION_DDL）");

  // 全局事件集合：孤儿判定要跨租户看（event_id 是全局主键）。
  const globalEvents = new Set();
  if (hasEvents) for (const r of db.prepare("SELECT event_id FROM soul_events").all()) globalEvents.add(String(r.event_id));

  const eventStmt = hasEvents ? db.prepare("SELECT * FROM soul_events WHERE event_id = ?") : null;
  const chatStmt = hasChat ? db.prepare("SELECT * FROM soul_event_chat WHERE event_id = ?") : null;
  const evidenceCountStmt = hasEvidence
    ? db.prepare("SELECT COUNT(*) AS n FROM soul_event_evidence WHERE event_id = ?")
    : null;
  const goalStmt = hasGoals ? db.prepare("SELECT * FROM soul_goals WHERE goal_id = ?") : null;

  const buckets = new Map();
  const bucketOf = (tenant) => {
    const key = tenantKey(tenant);
    let b = buckets.get(key);
    if (!b) {
      b = {
        tenant,
        key,
        label: formatTenant(tenant),
        legacy: { episodes: 0, emotions: 0, relations: 0, promises: 0 },
        target: {
          events: 0,
          // 迁移范围外的事件（事件模型自身产出：:tool/:test/:rollback 等），只报数不参与对账。
          outOfScopeEvents: 0,
          chat: 0,
          evidence: 0,
          goals: 0,
          emotionsBackfilled: 0,
          relationsBackfilled: 0,
          promisesBackfilled: 0,
          promisesWithGoal: 0,
          missingEvents: 0,
          missingChat: 0,
          missingEvidence: 0,
          orphanEmotionEventIds: 0,
          orphanRelationEventIds: 0,
          orphanEvidenceEventIds: 0,
          orphanChatEventIds: 0,
        },
        field: { compared: 0, mismatchEvents: 0, backfillGapEvents: 0, hash: null },
        // 列名 → 条数：存量行是空、期望有值的字段（INSERT OR IGNORE 不会覆盖，需单独决定是否回填）。
        backfillGaps: {},
        backfillSamples: [],
        outOfScopeByKind: {},
        mismatches: [],
        issues: [],
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const row of legacyEmotions) bucketOf(tenantOf(row)).legacy.emotions += 1;
  for (const row of legacyRelations) bucketOf(tenantOf(row)).legacy.relations += 1;
  for (const row of legacyPromises) bucketOf(tenantOf(row)).legacy.promises += 1;

  // event_id → 租户桶：chat/evidence 没有租户列，只能经事件归属到旧 episode 的租户。
  const episodeTenant = new Map();
  for (const row of legacyEpisodes) {
    const tenant = tenantOf(row);
    const b = bucketOf(tenant);
    b.legacy.episodes += 1;
    const eventId = text(row.episode_id);
    if (eventId === "") {
      b.issues.push("旧 episode 有空的 episode_id，无法判定归属");
      continue;
    }
    episodeTenant.set(eventId, tenantKey(tenant));
  }

  // 对账范围固定为「迁移派生事件」：event_id 恰好等于某个 legacy episode_id 且 source_kind='chat'。
  // 事件模型自己产出的事件（event_id 形如 ep-xxx:tool / :test:2 / :rollback，source_kind 非 chat）
  // 不是迁移对象，算进「事件数 vs episode 数」会让这条对账永远不等（t23 实测生产 144 = 136 chat + 8 自产）。
  const derivedEventIds = new Set();
  if (hasEvents) {
    for (const r of db.prepare("SELECT event_id, source_kind, team_id, user_id, agent_id FROM soul_events").all()) {
      const id = String(r.event_id);
      const key = tenantKey(tenantOf(r));
      const derived = episodeTenant.has(id) && String(r.source_kind ?? "") === "chat";
      if (derived) {
        derivedEventIds.add(id);
        if (buckets.has(key)) buckets.get(key).target.events += 1;
        continue;
      }
      if (buckets.has(key)) {
        const b = buckets.get(key);
        b.target.outOfScopeEvents += 1;
        const kind = String(r.source_kind ?? "") || "unknown";
        b.outOfScopeByKind[kind] = (b.outOfScopeByKind[kind] ?? 0) + 1;
      }
    }
  }
  let orphanChat = 0;
  if (hasChat) {
    for (const r of db.prepare("SELECT event_id FROM soul_event_chat").all()) {
      const id = String(r.event_id);
      // chat 行的对比基数同样是「迁移派生事件数」，不是全部事件数。
      const key = episodeTenant.get(id);
      if (derivedEventIds.has(id) && key && buckets.has(key)) buckets.get(key).target.chat += 1;
      if (!globalEvents.has(id)) orphanChat += 1;
    }
  }
  let orphanEvidence = 0;
  if (hasEvidence) {
    for (const r of db.prepare("SELECT event_id, COUNT(*) AS n FROM soul_event_evidence GROUP BY event_id").all()) {
      const id = String(r.event_id);
      const key = episodeTenant.get(id);
      if (key && buckets.has(key)) buckets.get(key).target.evidence += Number(r.n);
      if (!globalEvents.has(id)) orphanEvidence += Number(r.n);
    }
  }
  if (hasGoals) {
    for (const r of db.prepare("SELECT goal_id, team_id, user_id, agent_id FROM soul_goals").all()) {
      const key = tenantKey(tenantOf(r));
      if (buckets.has(key)) buckets.get(key).target.goals += 1;
    }
  }

  // 逐条：存在性 + 逐字段比对 + 字段 hash
  // 期望值与 apply 走同一个解析器：证据的 role/quote 来自 L0 回查，不是旧占位写法。
  const verifyResolveRecord = buildLegacyRecordResolver(db);
  for (const row of legacyEpisodes) {
    const tenant = tenantOf(row);
    const b = bucketOf(tenant);
    const eventId = text(row.episode_id);
    if (eventId === "") continue;
    const expected = mapEpisodeRow(row, verifyResolveRecord);
    const lines = [];

    const storedEvent = eventStmt ? eventStmt.get(eventId) : undefined;
    if (!storedEvent) {
      b.target.missingEvents += 1;
      continue;
    }
    lines.push(hashLine("event", storedEvent, EVENT_COLUMNS));

    const storedChat = chatStmt ? chatStmt.get(eventId) : undefined;
    if (!storedChat) b.target.missingChat += 1;
    else lines.push(hashLine("chat", storedChat, CHAT_COLUMNS));

    const evidenceCount = evidenceCountStmt ? Number(evidenceCountStmt.get(eventId)?.n ?? 0) : 0;
    // 旧行本来就有证据（evidence_json 或 quote）才要求新表有证据；
    // 无证据旧行按 inferred 落库，允许零证据，不拿合成指针凑数。
    if (expected.evidence.length > 0 && evidenceCount === 0) b.target.missingEvidence += 1;

    b.field.compared += 1;
    const diff = [];
    const gaps = [];
    const classify = (prefix, expectedRow, storedRow) => {
      for (const c of prefix === "event" ? EVENT_COLUMNS : CHAT_COLUMNS) {
        const verdict = classifyStoredDiff(expectedRow[c], storedRow[c]);
        if (verdict === "equal") continue;
        (verdict === "backfill" ? gaps : diff).push(prefix + "." + c);
      }
    };
    classify("event", expected.event, storedEvent);
    if (storedChat) classify("chat", expected.chat, storedChat);
    if (diff.length > 0) {
      b.field.mismatchEvents += 1;
      if (b.mismatches.length < 20) b.mismatches.push({ eventId, fields: diff });
    }
    if (gaps.length > 0) {
      b.field.backfillGapEvents += 1;
      for (const col of gaps) b.backfillGaps[col] = (b.backfillGaps[col] ?? 0) + 1;
      if (b.backfillSamples.length < 10) b.backfillSamples.push({ eventId, fields: gaps });
    }
    b.eventHashes = b.eventHashes || [];
    b.eventHashes.push(sha256Text(lines.join("\n")));
  }

  // emotions / relations 回填与孤儿
  for (const row of legacyEmotions) {
    const b = bucketOf(tenantOf(row));
    const eventId = nullableText(row.event_id);
    if (eventId !== null) {
      b.target.emotionsBackfilled += 1;
      if (!globalEvents.has(eventId)) b.target.orphanEmotionEventIds += 1;
      continue;
    }
    const episodeId = nullableText(row.episode_id);
    // 旧行还没回填：指向的事件存在时，这是「库里是空、期望有值」——和字段缺口同类，
    // 记进 backfillGaps（apply 会补；补不掉也仍是缺口，不是写错值）。
    // 指向已归档/未迁移 episode 的，计划里根本不进迁移，不记。
    if (episodeId !== null && globalEvents.has(episodeId)) {
      const col = "soul_emotions.event_id";
      b.backfillGaps[col] = (b.backfillGaps[col] ?? 0) + 1;
      b.field.backfillGapEvents += 1;
      if (b.backfillSamples.length < 10) b.backfillSamples.push({ eventId: episodeId, fields: [col] });
    }
  }
  for (const row of legacyRelations) {
    const b = bucketOf(tenantOf(row));
    const eventId = nullableText(row.event_id);
    if (eventId === null) continue;
    b.target.relationsBackfilled += 1;
    if (!globalEvents.has(eventId)) b.target.orphanRelationEventIds += 1;
  }
  for (const row of legacyPromises) {
    const b = bucketOf(tenantOf(row));
    const promiseId = text(row.promise_id);
    const goalId = nullableText(row.goal_id);
    if (goalId !== null) b.target.promisesBackfilled += 1;
    if (goalStmt && promiseId !== "") {
      const goal = goalStmt.get("goal-" + promiseId);
      if (goal) b.target.promisesWithGoal += 1;
      else b.issues.push("promise " + promiseId + " 缺 goal（goal-" + promiseId + "）");
    }
  }

  const result = {
    ok: true,
    hasTarget: hasEvents && hasChat && hasEvidence && hasGoals,
    tenants: [],
    totals: {
      legacyEpisodes: 0,
      events: 0,
      chat: 0,
      evidence: 0,
      goals: 0,
      missingEvents: 0,
      missingChat: 0,
      missingEvidence: 0,
      fieldMismatchEvents: 0,
      // 存量回填缺口：库空、期望有值的字段条数（按列见 tenants[].backfillGaps）。
      // 它不进 ok/退出码——INSERT OR IGNORE 本来就不覆盖已有行，这是缺口，不是写错值。
      backfillGapEvents: 0,
      backfillGaps: {},
      outOfScopeEvents: 0,
      outOfScopeByKind: {},
      orphanEventIds: 0,
    },
    issues,
  };

  for (const b of [...buckets.values()].sort((x, y) => x.key.localeCompare(y.key))) {
    b.field.hash = b.eventHashes && b.eventHashes.length > 0
      ? sha256Text([...b.eventHashes].sort().join("\n"))
      : null;
    delete b.eventHashes;

    const t = b.target;
    t.orphanEventIds = t.orphanEmotionEventIds + t.orphanRelationEventIds + t.orphanEvidenceEventIds;
    const diffs = [];
    if (t.events !== b.legacy.episodes) {
      diffs.push("迁移派生事件数 " + t.events + " ≠ 旧 episode 数 " + b.legacy.episodes);
    }
    if (t.chat !== t.events) diffs.push("chat 行 " + t.chat + " ≠ 迁移派生事件数 " + t.events);
    if (t.missingEvents > 0) diffs.push("缺事件 " + t.missingEvents + " 条");
    if (t.missingChat > 0) diffs.push("缺 chat 行 " + t.missingChat + " 条");
    if (t.missingEvidence > 0) diffs.push("缺证据 " + t.missingEvidence + " 条事件");
    if (t.orphanEventIds > 0) diffs.push("孤儿 event_id " + t.orphanEventIds + " 个");
    if (b.field.mismatchEvents > 0) diffs.push("字段不一致 " + b.field.mismatchEvents + " 条事件");
    if (b.issues.length > 0) diffs.push("其它 " + b.issues.length + " 项");
    b.diffs = diffs;
    if (diffs.length > 0) result.ok = false;

    result.totals.legacyEpisodes += b.legacy.episodes;
    result.totals.events += t.events;
    result.totals.chat += t.chat;
    result.totals.evidence += t.evidence;
    result.totals.goals += t.goals;
    result.totals.missingEvents += t.missingEvents;
    result.totals.missingChat += t.missingChat;
    result.totals.missingEvidence += t.missingEvidence;
    result.totals.fieldMismatchEvents += b.field.mismatchEvents;
    result.totals.backfillGapEvents += b.field.backfillGapEvents;
    result.totals.outOfScopeEvents += t.outOfScopeEvents;
    for (const [kind, n] of Object.entries(b.outOfScopeByKind)) {
      result.totals.outOfScopeByKind[kind] = (result.totals.outOfScopeByKind[kind] ?? 0) + n;
    }
    b.backfillGapEvents = b.field.backfillGapEvents;
    for (const [col, n] of Object.entries(b.backfillGaps)) {
      result.totals.backfillGaps[col] = (result.totals.backfillGaps[col] ?? 0) + n;
    }
    result.totals.orphanEventIds += t.orphanEventIds;
    result.tenants.push(b);
  }

  result.outOfScope = {
    total: result.totals.outOfScopeEvents,
    bySourceKind: result.totals.outOfScopeByKind,
  };
  result.totals.orphanChatEventIds = orphanChat;
  result.totals.orphanEvidenceEventIds = orphanEvidence;
  if (orphanChat > 0) {
    issues.push("孤儿 chat 行 " + orphanChat + " 条（event_id 不在 soul_events）");
    result.ok = false;
  }
  if (orphanEvidence > 0) {
    issues.push("孤儿证据 " + orphanEvidence + " 条（event_id 不在 soul_events）");
    result.ok = false;
  }
  if (!result.hasTarget) result.ok = false;
  return result;
}

/**
 * 库里还剩多少条占位证据（role='unknown' 且 quote 为空）。
 * 只读；表不存在时返回 0。
 */
export function countPlaceholderEvidence(db) {
  if (!tableExists(db, "soul_event_evidence")) return { rows: 0, events: 0 };
  const row = db
    .prepare(
      "SELECT COUNT(*) AS rows, COUNT(DISTINCT event_id) AS events FROM soul_event_evidence" +
        " WHERE role = 'unknown' AND quote = ''",
    )
    .get();
  return { rows: Number(row?.rows ?? 0), events: Number(row?.events ?? 0) };
}

/**
 * 把一次 run 的结果压成三行结论（t22）。
 *
 * 为什么单独做：生产迁移的日志有几百行，操作者看完只知道「exit 1」，
 * 分不清「248 条证据到底修好没有」和「存量字段缺口要不要处理」。
 * 所以结论必须自己成段，且退出码要能表达「本次做到了，但存量缺口仍在」。
 */
export function summarizeMigrationRun({ applied = null, parity, placeholderStats = { rows: 0, events: 0 } } = {}) {
  const gapColumns = Object.entries(parity?.totals?.backfillGaps ?? {}).sort((a, b) =>
    a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1,
  );
  const gapTotal = gapColumns.reduce((sum, [, n]) => sum + n, 0);

  const line1 = applied
    ? "本次写入：事件 +" + applied.totals.events + " 行 · 聊天 +" + applied.totals.chat +
      " 行 · 证据 +" + applied.totals.evidence + " 行"
    : "本次未写入（dry-run 只读，一个字节都没写）";

  // 行数与涉及事件数必须同时给：250 行只落在 135 条事件上，只看行数会高估「多少条事件被修好」。
  const fixedRows = applied ? applied.totals.placeholderEvidenceFixed ?? 0 : 0;
  const fixedEvents = applied ? applied.totals.placeholderEvidenceFixedEvents ?? 0 : 0;
  const remainingRows = Number(placeholderStats?.rows ?? 0);
  const remainingEvents = Number(placeholderStats?.events ?? 0);
  const line2 = "占位证据：本次修复 " + fixedRows + " 行（涉 " + fixedEvents + " 事件）；库里还剩 " +
    remainingRows + " 行（涉 " + remainingEvents + " 事件）";

  const line3 = gapTotal === 0
    ? "存量回填缺口：无"
    : "存量回填缺口：" + gapColumns.map(([col, n]) => col + " " + n + " 条").join("、") +
      "（合计 " + gapTotal + " 条；INSERT OR IGNORE 不覆盖已有行，需另行决定是否回填）";

  return {
    lines: [line1, line2, line3],
    hasBackfillGaps: gapTotal > 0,
    backfillGaps: parity?.totals?.backfillGaps ?? {},
    hasMismatch: !(parity ? parity.ok : false),
    exitCode: migrationExitCode({ apply: applied !== null, applied, parity }),
  };
}

/**
 * 退出码语义（t22）：
 *  0 = 本次 run 做到了（写入成功、没有写错值）；存量回填缺口存在也不算失败；
 *  1 = 有真 mismatch / 结构缺行 / 孤儿——写错了值必须红；
 *  3 = 写入本身失败（某租户回滚 / 执行异常）。
 * dry-run 在目标表还不存在时不算失败（没写，谈不上不一致）。
 */
export function migrationExitCode({ apply = false, applied = null, parity } = {}) {
  if (applied && applied.ok === false) return 3;
  if (!parity) return 3;
  if (parity.ok) return 0;
  if (!apply && !parity.hasTarget) return 0;
  return 1;
}



