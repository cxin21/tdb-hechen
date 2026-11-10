/**
 * P5 心境层（spec §4.7）的读写收口：soul_mood_state + soul_mood_events。
 *
 * 与 soul-person-state-store / soul-goal-store 同一取舍：纯函数文件，入参出参一律用
 * soul-event-types.ts 的 Row/InsertOf，不定义第二份字段表，租户只从参数来。
 *
 * 三条硬约定：
 *  - 心境是「按租户一行」的当前态，upsert 是整行覆盖（读旧行由调用方负责合并）。
 *  - 变化账本 append-only：按 id INSERT OR IGNORE，同一 tick 重放不翻倍。
 *  - half_life_hours 一律先过 normalizeMoodHalfLife（36–168，默认 48）再落库：
 *    写侧存 24h 会让读侧的衰减与验收口径直接打架。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulMoodEventInsert,
  SoulMoodEventRow,
  SoulMoodStateInsert,
  SoulMoodStateRow,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";
import { normalizeMoodHalfLife } from "../soul/emotion.js";

/** 账本默认上限：心境变化是低频事件（一天几条），500 条足够回放一个月。 */
export const SOUL_MOOD_EVENT_LIST_DEFAULT_LIMIT = 500;

function parseEventIds(json: unknown): string[] {
  if (typeof json !== "string" || json.trim() === "") return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mapSoulMoodStateRow(row: Record<string, unknown>): SoulMoodStateRow {
  return {
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    label: String(row.label ?? "平静"),
    valence: Number(row.valence ?? 0),
    arousal: Number(row.arousal ?? 0),
    intensity: Number(row.intensity ?? 0),
    // 旧行/手改行可能绕过写侧夹取，读侧再夹一次（读出来的半衰期必须落在 36–168）。
    half_life_hours: normalizeMoodHalfLife(Number(row.half_life_hours ?? 48)),
    cause_event_ids_json: String(row.cause_event_ids_json ?? "[]"),
    updated_at: String(row.updated_at ?? ""),
  };
}

function mapSoulMoodEventRow(row: Record<string, unknown>): SoulMoodEventRow {
  return {
    id: String(row.id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    at: String(row.at ?? ""),
    kind: String(row.kind ?? "appraisal") as SoulMoodEventRow["kind"],
    label: row.label === null || row.label === undefined ? null : String(row.label),
    delta_valence: Number(row.delta_valence ?? 0),
    delta_arousal: Number(row.delta_arousal ?? 0),
    delta_intensity: Number(row.delta_intensity ?? 0),
    cause_event_ids_json: String(row.cause_event_ids_json ?? "[]"),
    note: String(row.note ?? ""),
  };
}

/** 读当前心境；没有行返回 null（「还没积过」≠「心境为零」）。 */
export function getSoulMoodState(db: DatabaseSync, tenant: CoreTenant | undefined): SoulMoodStateRow | null {
  const t = normalizeCoreTenant(tenant);
  const row = db
    .prepare("SELECT * FROM soul_mood_state WHERE team_id = ? AND user_id = ? AND agent_id = ?")
    .get(t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapSoulMoodStateRow(row) : null;
}

/**
 * 写当前心境（整行覆盖）。半衰期在这里夹到 36–168（默认 48），
 * 调用方传 24/500 也不会让库里的读侧口径和验收口径打架。
 */
export function upsertSoulMoodState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  insert: SoulMoodStateInsert,
): SoulMoodStateRow {
  const t = normalizeCoreTenant(tenant);
  const state: SoulMoodStateRow = {
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    label: insert.label ?? "平静",
    valence: insert.valence ?? 0,
    arousal: insert.arousal ?? 0,
    intensity: insert.intensity ?? 0,
    half_life_hours: normalizeMoodHalfLife(insert.half_life_hours),
    cause_event_ids_json: JSON.stringify(parseEventIds(insert.cause_event_ids_json)),
    updated_at: insert.updated_at ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO soul_mood_state
      (team_id, user_id, agent_id, label, valence, arousal, intensity, half_life_hours, cause_event_ids_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id, agent_id) DO UPDATE SET
       label = excluded.label,
       valence = excluded.valence,
       arousal = excluded.arousal,
       intensity = excluded.intensity,
       half_life_hours = excluded.half_life_hours,
       cause_event_ids_json = excluded.cause_event_ids_json,
       updated_at = excluded.updated_at`,
  ).run(
    state.team_id,
    state.user_id,
    state.agent_id,
    state.label,
    state.valence,
    state.arousal,
    state.intensity,
    state.half_life_hours,
    state.cause_event_ids_json,
    state.updated_at,
  );
  return state;
}

/**
 * 追加心境变化账本。同一 id 再来一次算重复（INSERT OR IGNORE），
 * 返回真正写进去的行数——「跑过」与「写过」是两件事。
 *
 * present 是「这批 id 本来就在库里」的行数。调用方要判断「这一批有没有着落」，
 * 必须看 inserted + present：写 0 行可能是上一轮已写过（重试），也可能是被拒（真缺口），
 * 只看 inserted 会把两者混成一件事——前者会让人永远以为账本缺行，后者会让缺口被当成完成。
 */
export function commitSoulMoodEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  rows: SoulMoodEventInsert[],
): { inserted: number; present: number } {
  const t = normalizeCoreTenant(tenant);
  if (rows.length === 0) return { inserted: 0, present: 0 };
  let inserted = 0;
  let present = 0;
  const exists = db.prepare(
    "SELECT 1 AS hit FROM soul_mood_events WHERE id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
  );
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO soul_mood_events
      (id, team_id, user_id, agent_id, at, kind, label, delta_valence, delta_arousal, delta_intensity, cause_event_ids_json, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      if (exists.get(row.id, t.teamId, t.userId, t.agentId)) {
        present += 1;
        continue;
      }
      const res = stmt.run(
        row.id,
        t.teamId,
        t.userId,
        t.agentId,
        row.at,
        row.kind,
        row.label ?? null,
        row.delta_valence ?? 0,
        row.delta_arousal ?? 0,
        row.delta_intensity ?? 0,
        JSON.stringify(parseEventIds(row.cause_event_ids_json)),
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
  return { inserted, present };
}

/** 按时间倒序回放心境变化（面板曲线 / 校准用）。 */
export function listSoulMoodEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { limit?: number; kind?: SoulMoodEventRow["kind"] },
): SoulMoodEventRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? SOUL_MOOD_EVENT_LIST_DEFAULT_LIMIT)));
  const where = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  args.push(limit);
  const rows = db
    .prepare(`SELECT * FROM soul_mood_events WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...(args as Array<string | number>)) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapSoulMoodEventRow);
}
