/**
 * P7 §4.9 价值与 gate 的读写收口：soul_values + soul_gate_log + soul_dilemma。
 *
 * 与 soul-mood-store / soul-goal-store 同一取舍：纯函数文件，入参出参一律用
 * soul-event-types.ts 的 Row/InsertOf，不定义第二份字段表，租户只从参数来。
 *
 * 三条硬约定：
 *  - gate_log 是「判定审计」（decision = 判了什么），不是「执行审计」。
 *    shadow 期实际一律放行，这件事写在 reason 前缀里（[shadow] …）；宿主 pre-tool 落地后
 *    改走强制路径时，写日志的调用点不带这个前缀，于是同一张表能分开统计
 *    「判过什么」与「拦过什么」——不需要新增配置键。
 *  - 日志不存原文：action_digest 只存 sha256 前 16 位；命中的敏感字面量绝不落库。
 *  - 同一 id INSERT OR IGNORE：同一 tick / 同一请求重放不翻倍。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulDilemmaInsert,
  SoulDilemmaRow,
  SoulGateDecision,
  SoulGateLogInsert,
  SoulGateLogRow,
  SoulGateStage,
  SoulValueInsert,
  SoulValueRow,
  SoulValueSource,
  SoulValueStatus,
} from "./soul-event-types.js";
import { SOUL_GATE_DECISIONS } from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

/** 价值条目默认上限：一个人的取舍不会上千条，200 条够注入与面板。 */
export const SOUL_VALUE_LIST_DEFAULT_LIMIT = 200;
/** gate 审计默认上限：一次判定一行，200 行够看最近一轮。 */
export const SOUL_GATE_LOG_LIST_DEFAULT_LIMIT = 200;
/** 两难默认上限。 */
export const SOUL_DILEMMA_LIST_DEFAULT_LIMIT = 200;
/** 单批日志上限：防止一次误传把库写满。 */
export const SOUL_GATE_LOG_MAX_BATCH = 500;
/** shadow 行前缀：唯一区分「判定」与「执行」的标记，不占列。 */
export const SOUL_GATE_SHADOW_PREFIX = "[shadow]";

function clamp01(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function parseEventIds(json: unknown): string[] {
  if (typeof json !== "string" || json.trim() === "") return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mapSoulValueRow(row: Record<string, unknown>): SoulValueRow {
  return {
    value_id: String(row.value_id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    statement: String(row.statement ?? ""),
    priority: clamp01(row.priority),
    source: String(row.source ?? "derived") as SoulValueSource,
    evidence_event_ids_json: String(row.evidence_event_ids_json ?? "[]"),
    status: String(row.status ?? "active") as SoulValueStatus,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function mapSoulGateLogRow(row: Record<string, unknown>): SoulGateLogRow {
  return {
    id: String(row.id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    at: String(row.at ?? ""),
    stage: String(row.stage ?? "output") as SoulGateStage,
    action_digest: String(row.action_digest ?? ""),
    rule_id: row.rule_id === null || row.rule_id === undefined ? null : String(row.rule_id),
    decision: String(row.decision ?? "allow") as SoulGateDecision,
    reason: String(row.reason ?? ""),
    event_id: row.event_id === null || row.event_id === undefined ? null : String(row.event_id),
    confidence: clamp01(row.confidence),
  };
}

export function mapSoulDilemmaRow(row: Record<string, unknown>): SoulDilemmaRow {
  return {
    id: String(row.id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    at: String(row.at ?? ""),
    conflict_json: String(row.conflict_json ?? "{}"),
    choice: String(row.choice ?? ""),
    reason: String(row.reason ?? ""),
    regret: clamp01(row.regret),
    outcome_event_id:
      row.outcome_event_id === null || row.outcome_event_id === undefined ? null : String(row.outcome_event_id),
    review_at: row.review_at === null || row.review_at === undefined ? null : String(row.review_at),
  };
}

/**
 * 写价值条目（按 value_id upsert）。
 * created_at 只在新行上生效：同一句话被重新观察到时改的是 updated_at 与证据，不许刷新「诞生时刻」。
 */
export function upsertSoulValue(db: DatabaseSync, tenant: CoreTenant | undefined, insert: SoulValueInsert): SoulValueRow {
  const t = normalizeCoreTenant(tenant);
  const row: SoulValueRow = {
    value_id: insert.value_id,
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    statement: String(insert.statement ?? ""),
    priority: clamp01(insert.priority),
    source: (insert.source ?? "derived") as SoulValueSource,
    evidence_event_ids_json: JSON.stringify(parseEventIds(insert.evidence_event_ids_json)),
    status: (insert.status ?? "active") as SoulValueStatus,
    created_at: insert.created_at ?? new Date().toISOString(),
    updated_at: insert.updated_at ?? insert.created_at ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO soul_values
       (value_id, team_id, user_id, agent_id, statement, priority, source, evidence_event_ids_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(value_id) DO UPDATE SET
       statement = excluded.statement,
       priority = excluded.priority,
       source = excluded.source,
       evidence_event_ids_json = excluded.evidence_event_ids_json,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(
    row.value_id,
    row.team_id,
    row.user_id,
    row.agent_id,
    row.statement,
    row.priority,
    row.source,
    row.evidence_event_ids_json,
    row.status,
    row.created_at,
    row.updated_at,
  );
  // 回读而不是回传内存里的对象：created_at 在冲突分支上不更新，
  // 若直接返回入参，调用方会以为「诞生时刻」被刷新了（读到的事实必须是库里的事实）。
  const stored = db
    .prepare("SELECT * FROM soul_values WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(row.value_id, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return stored ? mapSoulValueRow(stored) : row;
}

/** 退休一条价值：只改 status 与 updated_at（行不删——「不再拿它做取舍」不等于「没这么想过」）。 */
export function retireSoulValue(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  valueId: string,
  at?: string,
): boolean {
  const t = normalizeCoreTenant(tenant);
  const res = db
    .prepare(
      "UPDATE soul_values SET status = 'retired', updated_at = ? WHERE value_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    )
    .run(at ?? new Date().toISOString(), valueId, t.teamId, t.userId, t.agentId);
  return Number(res.changes ?? 0) > 0;
}

export function listSoulValues(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { status?: SoulValueStatus; source?: SoulValueSource; limit?: number },
): SoulValueRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? SOUL_VALUE_LIST_DEFAULT_LIMIT)));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts?.source) {
    where.push("source = ?");
    args.push(opts.source);
  }
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM soul_values WHERE ${where.join(" AND ")} ORDER BY priority DESC, created_at DESC, value_id ASC LIMIT ?`,
    )
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulValueRow);
}

/** 追加 gate 判定审计。同 id 再来一次算重复（INSERT OR IGNORE），返回真正写进去的行数。 */
export function insertSoulGateLog(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  rows: SoulGateLogInsert[],
): { inserted: number } {
  const t = normalizeCoreTenant(tenant);
  if (rows.length === 0) return { inserted: 0 };
  const batch = rows.slice(0, SOUL_GATE_LOG_MAX_BATCH);
  let inserted = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO soul_gate_log
       (id, team_id, user_id, agent_id, at, stage, action_digest, rule_id, decision, reason, event_id, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of batch) {
      const res = stmt.run(
        row.id,
        t.teamId,
        t.userId,
        t.agentId,
        row.at,
        row.stage,
        row.action_digest,
        row.rule_id ?? null,
        row.decision,
        row.reason ?? "",
        row.event_id ?? null,
        clamp01(row.confidence),
      );
      inserted += Number(res.changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已在回滚态 */
    }
    throw err;
  }
  return { inserted };
}

/** 按时间倒序回放判定（面板/抽检用）。 */
export function listSoulGateLog(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: {
    decision?: SoulGateDecision;
    stage?: SoulGateStage;
    ruleId?: string;
    sinceIso?: string;
    /** true 只看 shadow 行（reason 前缀），false 只看非 shadow 行，undefined 全看。 */
    shadowOnly?: boolean;
    limit?: number;
    offset?: number;
  },
): SoulGateLogRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? SOUL_GATE_LOG_LIST_DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.decision) {
    where.push("decision = ?");
    args.push(opts.decision);
  }
  if (opts?.stage) {
    where.push("stage = ?");
    args.push(opts.stage);
  }
  if (opts?.ruleId) {
    where.push("rule_id = ?");
    args.push(opts.ruleId);
  }
  if (opts?.sinceIso) {
    where.push("at >= ?");
    args.push(opts.sinceIso);
  }
  if (opts?.shadowOnly === true) where.push("reason LIKE '[shadow]%'");
  if (opts?.shadowOnly === false) where.push("reason NOT LIKE '[shadow]%'");
  args.push(limit, offset);
  const rows = db
    .prepare(`SELECT * FROM soul_gate_log WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulGateLogRow);
}

/** 一条规则的判定分布（误杀口径的最小读面）。 */
export interface SoulGateRuleStat {
  ruleId: string;
  total: number;
  /** 判定会拦（deny/rewrite/ask）的行数。shadow 期这些行当场都没拦。 */
  wouldBlock: number;
  allow: number;
  deny: number;
  rewrite: number;
  ask: number;
}

export interface SoulGateLogStats {
  total: number;
  /** 其中 shadow 行数（reason 以 [shadow] 开头）。 */
  shadow: number;
  /** 真正按判定执行过的行数（非 shadow）。强制路径落地前应恒为 0。 */
  enforced: number;
  /** 判定会拦的行数（含 shadow 与 enforced）。 */
  wouldBlock: number;
  /** 线上误杀代理指标：wouldBlock / total（分母含放行判定，否则恒为 100%）。 */
  wouldBlockRate: number;
  byDecision: Record<SoulGateDecision, number>;
  byRule: SoulGateRuleStat[];
  /** 至少命中一条规则的判定行数（规则命中率，不是拦截率）。 */
  hitRows: number;
}

/**
 * 汇总判定分布。
 *
 * 口径（写进交付回报，别混用）：
 *  - 线上：wouldBlockRate = 判定会拦的行数 / 判定总行数（按 rule 分组看 byRule）。
 *    它只是「疑似误杀」的代理——shadow 期没有任何一次真的改变输出，所以拦了也不等于杀错。
 *  - 真值：带标注语料回归（value-gate.ts 的 evaluateGateCalibration），
 *    falsePositiveRate = 规则命中合法样本数 / 合法样本总数。两个数不可互相替代。
 */
export function summarizeSoulGateLog(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { sinceIso?: string },
): SoulGateLogStats {
  const t = normalizeCoreTenant(tenant);
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.sinceIso) {
    where.push("at >= ?");
    args.push(opts.sinceIso);
  }
  const rows = db
    .prepare(`SELECT decision, rule_id, reason FROM soul_gate_log WHERE ${where.join(" AND ")}`)
    .all(...(args as Array<string | number>)) as unknown as Array<{
    decision?: string;
    rule_id?: string | null;
    reason?: string | null;
  }>;
  const byDecision = Object.fromEntries(SOUL_GATE_DECISIONS.map((d) => [d, 0])) as Record<SoulGateDecision, number>;
  const rules = new Map<string, SoulGateRuleStat>();
  let shadow = 0;
  let enforced = 0;
  let hitRows = 0;
  for (const row of rows ?? []) {
    const decision = String(row.decision ?? "allow") as SoulGateDecision;
    byDecision[decision] = (byDecision[decision] ?? 0) + 1;
    const isShadow = String(row.reason ?? "").startsWith(SOUL_GATE_SHADOW_PREFIX);
    if (isShadow) shadow += 1;
    else enforced += 1;
    const ruleId = row.rule_id === null || row.rule_id === undefined ? "" : String(row.rule_id);
    if (ruleId !== "") hitRows += 1;
    const key = ruleId === "" ? "" : ruleId;
    if (key === "") continue;
    const stat =
      rules.get(key) ??
      ({ ruleId: key, total: 0, wouldBlock: 0, allow: 0, deny: 0, rewrite: 0, ask: 0 } satisfies SoulGateRuleStat);
    stat.total += 1;
    if (decision !== "allow") stat.wouldBlock += 1;
    stat[decision] += 1;
    rules.set(key, stat);
  }
  const total = rows?.length ?? 0;
  const wouldBlock = byDecision.deny + byDecision.rewrite + byDecision.ask;
  return {
    total,
    shadow,
    enforced,
    wouldBlock,
    wouldBlockRate: total === 0 ? 0 : wouldBlock / total,
    byDecision,
    byRule: [...rules.values()].sort((a, b) => b.total - a.total || a.ruleId.localeCompare(b.ruleId)),
    hitRows,
  };
}

/**
 * 记一次两难（冲突结构 + 选择 + 当时的理由）。同 id 幂等（重放返回已有行）。
 * 返回写入/命中的行：调用方要拿 id 与 review_at 去面板上「一周后回看」。
 */
export function insertSoulDilemma(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  insert: SoulDilemmaInsert,
): SoulDilemmaRow | null {
  const t = normalizeCoreTenant(tenant);
  db.prepare(
    `INSERT OR IGNORE INTO soul_dilemma
       (id, team_id, user_id, agent_id, at, conflict_json, choice, reason, regret, outcome_event_id, review_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    insert.id,
    t.teamId,
    t.userId,
    t.agentId,
    insert.at,
    insert.conflict_json,
    insert.choice,
    insert.reason ?? "",
    clamp01(insert.regret),
    insert.outcome_event_id ?? null,
    insert.review_at ?? null,
  );
  const row = db
    .prepare("SELECT * FROM soul_dilemma WHERE id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(insert.id, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapSoulDilemmaRow(row) : null;
}
export function listSoulDilemmas(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { limit?: number; /** 只看到了回看时点且还没记后悔的 */ dueBefore?: string },
): SoulDilemmaRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? SOUL_DILEMMA_LIST_DEFAULT_LIMIT)));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.dueBefore) {
    where.push("review_at IS NOT NULL", "review_at <= ?");
    args.push(opts.dueBefore);
  }
  args.push(limit);
  const rows = db
    .prepare(`SELECT * FROM soul_dilemma WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulDilemmaRow);
}

/**
 * 事后回看：记下「后悔/不后悔」与其后果事件。
 * 后悔度是 0..1 的强度（不是概率）：0 = 不后悔，1 = 非常后悔。
 * 只改这一行的 regret / outcome_event_id / review_at——两难本身（当时的两侧理由）是一等事实，不许改写。
 */
export function reviewSoulDilemma(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  id: string,
  patch: { regret?: number; outcomeEventId?: string | null; reviewAt?: string },
): SoulDilemmaRow | null {
  const t = normalizeCoreTenant(tenant);
  const existing = db
    .prepare("SELECT * FROM soul_dilemma WHERE id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(id, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  if (!existing) return null;
  const current = mapSoulDilemmaRow(existing);
  const regret = patch.regret === undefined ? current.regret : clamp01(patch.regret);
  const outcomeEventId = patch.outcomeEventId === undefined ? current.outcome_event_id : patch.outcomeEventId;
  const reviewAt = patch.reviewAt ?? new Date().toISOString();
  db.prepare(
    "UPDATE soul_dilemma SET regret = ?, outcome_event_id = ?, review_at = ? WHERE id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
  ).run(regret, outcomeEventId ?? null, reviewAt, id, t.teamId, t.userId, t.agentId);
  return { ...current, regret, outcome_event_id: outcomeEventId ?? null, review_at: reviewAt };
}
