/**
 * P4 自我模型与校准（spec §4.5/§4.6）的读写收口：soul_self_model + soul_calibration。
 *
 * 与 soul-mood-store / soul-goal-store 同一取舍：纯函数文件，字段一律用
 * soul-event-types.ts 的 Row/InsertOf，不定义第二份字段表，租户只从参数来。
 *
 * 三条硬约定：
 *  - 自我模型必须带反例（counterexample_event_ids_json 不是装饰）：只存支持证据的
 *    自我模型永远不会被推翻，等于把「我很严谨」写成事实。
 *  - 校准的 error 不在这里拍：写入只存 predicted_confidence 与 actual_outcome，
 *    误差由读侧（summarizeCalibration）按「预测 − 实际」算，才可复核。
 *  - 校准只给按领域分组的分，不提供全局分：全局分会把「测试老失手」和「文档从不出错」
 *    平均成一句没有行动指向的「70 分」。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulCalibrationInsert,
  SoulCalibrationRow,
  SoulSelfModelInsert,
  SoulSelfModelRow,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

/** 单次读上限：自我模型是低频结构（一人几条到几十条），200 条足够审计。 */
export const SOUL_SELF_MODEL_LIST_DEFAULT_LIMIT = 200;
export const SOUL_CALIBRATION_LIST_DEFAULT_LIMIT = 500;

function parseIds(json: unknown): string[] {
  if (typeof json !== "string" || json.trim() === "") return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

function mapSoulSelfModelRow(row: Record<string, unknown>): SoulSelfModelRow {
  return {
    id: String(row.id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    kind: String(row.kind ?? "capability") as SoulSelfModelRow["kind"],
    scope: String(row.scope ?? "global"),
    statement: String(row.statement ?? ""),
    confidence: Number(row.confidence ?? 0.5),
    evidence_event_ids_json: String(row.evidence_event_ids_json ?? "[]"),
    counterexample_event_ids_json: String(row.counterexample_event_ids_json ?? "[]"),
    status: String(row.status ?? "active") as SoulSelfModelRow["status"],
    last_confirmed_at: row.last_confirmed_at === null || row.last_confirmed_at === undefined ? null : String(row.last_confirmed_at),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function mapSoulCalibrationRow(row: Record<string, unknown>): SoulCalibrationRow {
  return {
    id: String(row.id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    domain: String(row.domain ?? "通用"),
    predicted_confidence: Number(row.predicted_confidence ?? 0),
    actual_outcome: String(row.actual_outcome ?? "unknown") as SoulCalibrationRow["actual_outcome"],
    event_id: row.event_id === null || row.event_id === undefined ? null : String(row.event_id),
    at: String(row.at ?? ""),
    error: row.error === null || row.error === undefined ? null : Number(row.error),
    note: String(row.note ?? ""),
  };
}

/** 自我模型的稳定 id：同一 (kind, scope) 只该有一行，重跑 tick 不制造第二条。 */
export function selfModelId(kind: SoulSelfModelRow["kind"], scope: string): string {
  const slug = scope
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `sm:${kind}:${slug === "" ? "global" : slug}`;
}

/** 单条读（派生时需要旧行做合并：反例只增不减）。 */
export function getSoulSelfModel(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  id: string,
): SoulSelfModelRow | null {
  const t = normalizeCoreTenant(tenant);
  const row = db
    .prepare("SELECT * FROM soul_self_model WHERE id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(id, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapSoulSelfModelRow(row) : null;
}

/**
 * 整行 upsert（调用方负责读旧行合并反例）。status/confidence 由派生侧算好，
 * 这里不替它做判断，只保证字段齐全、时间戳有值。
 */
export function upsertSoulSelfModel(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  insert: SoulSelfModelInsert,
): SoulSelfModelRow {
  const t = normalizeCoreTenant(tenant);
  const row: SoulSelfModelRow = {
    id: insert.id,
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    kind: insert.kind,
    scope: insert.scope ?? "global",
    statement: insert.statement,
    confidence: Math.max(0, Math.min(1, insert.confidence ?? 0.5)),
    evidence_event_ids_json: JSON.stringify(parseIds(insert.evidence_event_ids_json)),
    counterexample_event_ids_json: JSON.stringify(parseIds(insert.counterexample_event_ids_json)),
    status: insert.status ?? "active",
    last_confirmed_at: insert.last_confirmed_at ?? null,
    created_at: insert.created_at ?? new Date().toISOString(),
    updated_at: insert.updated_at ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO soul_self_model
      (id, team_id, user_id, agent_id, kind, scope, statement, confidence,
       evidence_event_ids_json, counterexample_event_ids_json, status,
       last_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       scope = excluded.scope,
       statement = excluded.statement,
       confidence = excluded.confidence,
       evidence_event_ids_json = excluded.evidence_event_ids_json,
       counterexample_event_ids_json = excluded.counterexample_event_ids_json,
       status = excluded.status,
       last_confirmed_at = excluded.last_confirmed_at,
       updated_at = excluded.updated_at`,
  ).run(
    row.id,
    row.team_id,
    row.user_id,
    row.agent_id,
    row.kind,
    row.scope,
    row.statement,
    row.confidence,
    row.evidence_event_ids_json,
    row.counterexample_event_ids_json,
    row.status,
    row.last_confirmed_at,
    row.created_at,
    row.updated_at,
  );
  return row;
}

/** 读自我模型（默认按更新时间倒序）；按 kind/status 过滤给卡面与面板用。 */
export function listSoulSelfModel(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { limit?: number; kinds?: SoulSelfModelRow["kind"][]; statuses?: SoulSelfModelRow["status"][] },
): SoulSelfModelRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? SOUL_SELF_MODEL_LIST_DEFAULT_LIMIT)));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.kinds && opts.kinds.length > 0) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  if (opts?.statuses && opts.statuses.length > 0) {
    where.push(`status IN (${opts.statuses.map(() => "?").join(", ")})`);
    args.push(...opts.statuses);
  }
  args.push(limit);
  const rows = db
    .prepare(`SELECT * FROM soul_self_model WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulSelfModelRow);
}

/**
 * 追加校准行（按 id INSERT OR IGNORE）：同一事件重跑 tick 不重复入账。
 * 一批一个事务，「跑过」与「写过」分开报。
 */
export function commitSoulCalibration(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  rows: SoulCalibrationInsert[],
): { inserted: number } {
  const t = normalizeCoreTenant(tenant);
  if (rows.length === 0) return { inserted: 0 };
  let inserted = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO soul_calibration
      (id, team_id, user_id, agent_id, domain, predicted_confidence, actual_outcome, event_id, at, error, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const res = stmt.run(
        row.id,
        t.teamId,
        t.userId,
        t.agentId,
        row.domain,
        Math.max(0, Math.min(1, row.predicted_confidence)),
        row.actual_outcome,
        row.event_id ?? null,
        row.at,
        row.error ?? null,
        row.note ?? "",
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

/** 读校准行（按时间倒序）；domain 过滤给「领域分」。 */
export function listSoulCalibration(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { limit?: number; domain?: string },
): SoulCalibrationRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? SOUL_CALIBRATION_LIST_DEFAULT_LIMIT)));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.domain !== undefined && opts.domain !== "") {
    where.push("domain = ?");
    args.push(opts.domain);
  }
  args.push(limit);
  const rows = db
    .prepare(`SELECT * FROM soul_calibration WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulCalibrationRow);
}

/** 实际结果的数值化：success=1 / fail=0 / partial=0.5 / unknown 不计入误差。 */
export function outcomeScore(outcome: SoulCalibrationRow["actual_outcome"]): number | null {
  if (outcome === "success") return 1;
  if (outcome === "fail") return 0;
  if (outcome === "partial") return 0.5;
  return null;
}

export interface DomainCalibration {
  domain: string;
  /** 可算误差的样本数（unknown 不算）。 */
  samples: number;
  /** 还没验证过的预测条数（unknown）。 */
  unknown: number;
  meanPredicted: number;
  meanActual: number;
  /** 平均误差（带符号：正 = 报得比实际高，过度自信）。 */
  bias: number;
  /** 平均绝对误差：比 bias 更能说明「准不准」。 */
  mae: number;
  eventIds: string[];
}

/**
 * 按领域聚合校准；**不返回全局分**——全局分会把不同领域的把握平均成一个
 * 没有行动指向的数字。只给样本数、均值、带符号误差与 MAE。
 */
export function summarizeCalibration(rows: readonly SoulCalibrationRow[]): DomainCalibration[] {
  const byDomain = new Map<string, { predicted: number[]; actual: number[]; ids: string[]; unknown: number }>();
  for (const row of rows) {
    const domain = row.domain.trim() === "" ? "通用" : row.domain;
    const bucket = byDomain.get(domain) ?? { predicted: [], actual: [], ids: [], unknown: 0 };
    const actual = outcomeScore(row.actual_outcome);
    if (actual === null) {
      bucket.unknown += 1;
    } else {
      bucket.predicted.push(row.predicted_confidence);
      bucket.actual.push(actual);
    }
    if (row.event_id) bucket.ids.push(row.event_id);
    byDomain.set(domain, bucket);
  }
  const out: DomainCalibration[] = [];
  for (const [domain, bucket] of byDomain) {
    const n = bucket.predicted.length;
    if (n === 0) {
      out.push({
        domain,
        samples: 0,
        unknown: bucket.unknown,
        meanPredicted: 0,
        meanActual: 0,
        bias: 0,
        mae: 0,
        eventIds: bucket.ids,
      });
      continue;
    }
    let sumPredicted = 0;
    let sumActual = 0;
    let sumAbs = 0;
    for (let i = 0; i < n; i += 1) {
      const diff = bucket.predicted[i] - bucket.actual[i];
      sumPredicted += bucket.predicted[i];
      sumActual += bucket.actual[i];
      sumAbs += Math.abs(diff);
    }
    out.push({
      domain,
      samples: n,
      unknown: bucket.unknown,
      meanPredicted: sumPredicted / n,
      meanActual: sumActual / n,
      bias: (sumPredicted - sumActual) / n,
      mae: sumAbs / n,
      eventIds: bucket.ids,
    });
  }
  out.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return out;
}
