/**
 * 关系状态层（P2 §4.4）的读写收口：soul_person_state + soul_person_state_events。
 *
 * 为什么是纯函数文件（与 soul-event-store.ts 同一取舍）：
 *  - 写入者是维护 tick 里的派生步骤，读面是卡/面板；两边都不该为了读写这两张表去拼 SQL。
 *  - 出参/入参一律用 soul-event-types.ts 的 Row/InsertOf，本文件不定义第二份字段表。
 *  - 字段语义分开：事实（谁—谓词—谁）在 soul_person_relation；连续状态（信任/亲近/尊重/亏欠）
 *    在这里；每次数值轴变化写一条 state_events（旧值→新值+原因）。
 *
 * 三条硬约定：
 *  - 租户只从参数来；载荷里带 team/user/agent 一律忽略并以参数为准。
 *  - upsert 是「读旧行再合并」的整行写：未给的轴沿用旧值，**不**用默认值覆盖已有状态。
 *  - state_events 按 id INSERT OR IGNORE：同一 tick 重放（或同一事件二次派生）不翻倍。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.4。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulPersonStateEventInsert,
  SoulPersonStateEventRow,
  SoulPersonStateInsert,
  SoulPersonStateRow,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

/** 列表默认上限：面板与维护 tick 都只需要「最近这些人」，全量导出走分页。 */
export const SOUL_PERSON_STATE_LIST_DEFAULT_LIMIT = 200;
export const SOUL_PERSON_STATE_EVENT_LIST_DEFAULT_LIMIT = 500;

function mapStateRow(row: Record<string, unknown>): SoulPersonStateRow {
  return {
    person_key: String(row.person_key ?? ""),
    team_id: String(row.team_id ?? ""),
    user_id: String(row.user_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    trust: Number(row.trust ?? 0.5),
    affinity: Number(row.affinity ?? 0.5),
    respect: Number(row.respect ?? 0.5),
    obligation: Number(row.obligation ?? 0.5),
    boundaries_json: String(row.boundaries_json ?? "{}"),
    model_json: String(row.model_json ?? "{}"),
    last_interaction_at: typeof row.last_interaction_at === "string" && row.last_interaction_at !== "" ? row.last_interaction_at : null,
    evidence_event_ids_json: String(row.evidence_event_ids_json ?? "[]"),
    confidence: Number(row.confidence ?? 0.5),
    updated_at: String(row.updated_at ?? ""),
  };
}

function mapEventRow(row: Record<string, unknown>): SoulPersonStateEventRow {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : v === null || v === undefined ? null : Number(v));
  return {
    id: String(row.id ?? ""),
    person_key: String(row.person_key ?? ""),
    team_id: String(row.team_id ?? ""),
    user_id: String(row.user_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    event_id: typeof row.event_id === "string" && row.event_id !== "" ? row.event_id : null,
    field: String(row.field ?? ""),
    old_value: num(row.old_value),
    new_value: num(row.new_value),
    reason: String(row.reason ?? ""),
    at: String(row.at ?? ""),
  };
}

/** 读一个人的连续状态；没有行返回 null（不编默认值的假行）。 */
export function getSoulPersonState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  personKey: string,
): SoulPersonStateRow | null {
  const t = normalizeCoreTenant(tenant);
  const key = typeof personKey === "string" ? personKey.trim() : "";
  if (key === "") return null;
  const row = db
    .prepare(
      "SELECT * FROM soul_person_state WHERE person_key = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    )
    .get(key, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapStateRow(row) : null;
}

/** 列出租户内全部状态行（宁缺毋滥：读失败返回空，不抛给卡渲染）。 */
export function listSoulPersonStates(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { limit?: number },
): SoulPersonStateRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(SOUL_PERSON_STATE_LIST_DEFAULT_LIMIT, Math.floor(opts?.limit ?? SOUL_PERSON_STATE_LIST_DEFAULT_LIMIT)));
  const rows = db
    .prepare(
      "SELECT * FROM soul_person_state WHERE team_id = ? AND user_id = ? AND agent_id = ? ORDER BY updated_at DESC, person_key ASC LIMIT ?",
    )
    .all(t.teamId, t.userId, t.agentId, limit) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapStateRow);
}

/**
 * 整行 upsert：未给的轴沿用旧值（没有旧行才用 0.5 默认）。
 * 返回落库后的完整行，避免调用方再读一次库。
 */
export function upsertSoulPersonState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  insert: SoulPersonStateInsert,
): SoulPersonStateRow {
  const t = normalizeCoreTenant(tenant);
  const personKey = String(insert.person_key ?? "").trim();
  if (personKey === "") throw new Error("soul_person_state: person_key 不能为空");
  const existing = getSoulPersonState(db, t, personKey);
  const pick = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const merged: SoulPersonStateRow = {
    person_key: personKey,
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    trust: pick(insert.trust, existing?.trust ?? 0.5),
    affinity: pick(insert.affinity, existing?.affinity ?? 0.5),
    respect: pick(insert.respect, existing?.respect ?? 0.5),
    obligation: pick(insert.obligation, existing?.obligation ?? 0.5),
    boundaries_json: insert.boundaries_json ?? existing?.boundaries_json ?? "{}",
    model_json: insert.model_json ?? existing?.model_json ?? "{}",
    last_interaction_at:
      insert.last_interaction_at !== undefined ? insert.last_interaction_at : (existing?.last_interaction_at ?? null),
    evidence_event_ids_json: insert.evidence_event_ids_json ?? existing?.evidence_event_ids_json ?? "[]",
    confidence: pick(insert.confidence, existing?.confidence ?? 0.5),
    updated_at: insert.updated_at ?? new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO soul_person_state (person_key, team_id, user_id, agent_id, trust, affinity, respect, obligation, boundaries_json, model_json, last_interaction_at, evidence_event_ids_json, confidence, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(person_key, team_id, user_id, agent_id) DO UPDATE SET trust = excluded.trust, affinity = excluded.affinity, respect = excluded.respect, obligation = excluded.obligation, boundaries_json = excluded.boundaries_json, model_json = excluded.model_json, last_interaction_at = excluded.last_interaction_at, evidence_event_ids_json = excluded.evidence_event_ids_json, confidence = excluded.confidence, updated_at = excluded.updated_at",
  ).run(
    merged.person_key,
    merged.team_id,
    merged.user_id,
    merged.agent_id,
    merged.trust,
    merged.affinity,
    merged.respect,
    merged.obligation,
    merged.boundaries_json,
    merged.model_json,
    merged.last_interaction_at,
    merged.evidence_event_ids_json,
    merged.confidence,
    merged.updated_at,
  );
  return merged;
}

/** 变化审计：id 幂等；返回实际新增行数。租户列只认参数。 */
export function insertSoulPersonStateEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  events: SoulPersonStateEventInsert[],
): { inserted: number } {
  const t = normalizeCoreTenant(tenant);
  if (!Array.isArray(events) || events.length === 0) return { inserted: 0 };
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO soul_person_state_events (id, person_key, team_id, user_id, agent_id, event_id, field, old_value, new_value, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const e of events) {
    const id = String(e.id ?? "").trim();
    const personKey = String(e.person_key ?? "").trim();
    if (id === "" || personKey === "") continue;
    const info = stmt.run(
      id,
      personKey,
      t.teamId,
      t.userId,
      t.agentId,
      e.event_id ?? null,
      e.field,
      e.old_value ?? null,
      e.new_value ?? null,
      e.reason ?? "",
      e.at,
    );
    if (Number(info.changes ?? 0) > 0) inserted += 1;
  }
  return { inserted };
}

/** 变化史：按 at 倒序（同一时刻按 id 稳定排序）。 */
export function listSoulPersonStateEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { personKey?: string; limit?: number },
): SoulPersonStateEventRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(SOUL_PERSON_STATE_EVENT_LIST_DEFAULT_LIMIT, Math.floor(opts?.limit ?? SOUL_PERSON_STATE_EVENT_LIST_DEFAULT_LIMIT)));
  const key = typeof opts?.personKey === "string" ? opts.personKey.trim() : "";
  const conds = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (key !== "") {
    conds.push("person_key = ?");
    args.push(key);
  }
  args.push(limit);
  const rows = db
    .prepare(
      "SELECT * FROM soul_person_state_events WHERE " + conds.join(" AND ") + " ORDER BY at DESC, id ASC LIMIT ?",
    )
    .all(...args) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapEventRow);
}
