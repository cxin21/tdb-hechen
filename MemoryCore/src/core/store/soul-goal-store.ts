/**
 * P3 目标层（spec §4.5）的读写收口：soul_goals + soul_goal_events + soul_goal_deps。
 *
 * 为什么又是纯函数文件（与 soul-event-store / soul-person-state-store 同一取舍）：
 *  - 写入者是维护 tick 里的派生步骤，读面是卡/面板；两边都不该各自拼 SQL。
 *  - 入参/出参一律用 soul-event-types.ts 的 Row/InsertOf，不定义第二份字段表。
 *
 * 四条硬约定：
 *  - 租户只从参数来：目标三表里只有 soul_goals 带 team/user/agent，账本与依赖表没有
 *    租户列，所以读/写都要先按租户校验 goal 归属——否则任何人都能往别人的目标上挂事件。
 *  - 账本 append-only：按 (goal_id, event_id, change) INSERT OR IGNORE，同一 tick 重放不翻倍。
 *  - 状态机单向：done / abandoned 是终态（复活要另立目标与证据），非法跃迁零写入返回原因。
 *  - 放弃/阻塞必须给原因：目标写不出「为什么卡着/为什么不要了」，就退化成待办列表。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.5。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulGoalDepInsert,
  SoulGoalDepRow,
  SoulGoalEventInsert,
  SoulGoalEventRow,
  SoulGoalInsert,
  SoulGoalRow,
  SoulGoalStatus,
  SoulWorkingStateRow,
  SoulWorkingStateUpsert,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

/** 列表默认上限：目标行是「当下还在意的事」，200 条已经远超一个人能同时追的数量。 */
export const SOUL_GOAL_LIST_DEFAULT_LIMIT = 200;
export const SOUL_GOAL_EVENT_LIST_DEFAULT_LIMIT = 500;

/** 终态：不再变（不因为「又说了一次」自动复活）。 */
export const TERMINAL_GOAL_STATUSES: readonly SoulGoalStatus[] = ["done", "abandoned"];

/**
 * 允许的状态跃迁。blocked 能回 active（解阻），done/abandoned 出不去：
 * 复活是「新目标」而不是改旧行——旧行要留着说明「我当时为什么算了」。
 */
export const GOAL_TRANSITIONS: Readonly<Record<SoulGoalStatus, readonly SoulGoalStatus[]>> = {
  active: ["blocked", "done", "abandoned"],
  blocked: ["active", "done", "abandoned"],
  done: [],
  abandoned: [],
};

export function canTransitionGoal(from: SoulGoalStatus, to: SoulGoalStatus): boolean {
  return (GOAL_TRANSITIONS[from] ?? []).includes(to);
}

export type GoalTransitionResult =
  | { ok: true; goal: SoulGoalRow; changed: boolean }
  | { ok: false; reason: string };

export interface GoalTransitionOptions {
  at?: string;
  /** blocked / abandoned 必填：卡在哪、为什么算了。 */
  reason?: string;
  /** 账本行的 event_id（派生路径传 "ep:<episodeId>"；缺省用 "state@<at>" 合成标记）。 */
  eventId?: string;
  /** 账本 note（缺省沿用 reason）。 */
  note?: string;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nstr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function mapGoalRow(row: Record<string, unknown>): SoulGoalRow {
  return {
    goal_id: String(row.goal_id ?? ""),
    team_id: String(row.team_id ?? ""),
    user_id: String(row.user_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    owner: String(row.owner ?? "self") as SoulGoalRow["owner"],
    kind: String(row.kind ?? "commitment") as SoulGoalRow["kind"],
    title: String(row.title ?? ""),
    why: String(row.why ?? ""),
    status: String(row.status ?? "active") as SoulGoalStatus,
    priority: num(row.priority, 0.5),
    progress: num(row.progress, 0),
    due_at: nstr(row.due_at),
    parent_goal_id: nstr(row.parent_goal_id),
    source_event_id: nstr(row.source_event_id),
    success_criteria: String(row.success_criteria ?? ""),
    blocked_reason: String(row.blocked_reason ?? ""),
    abandon_reason: String(row.abandon_reason ?? ""),
    valid_from: String(row.valid_from ?? ""),
    valid_to: nstr(row.valid_to),
    confidence: num(row.confidence, 0.5),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function mapGoalEventRow(row: Record<string, unknown>): SoulGoalEventRow {
  return {
    goal_id: String(row.goal_id ?? ""),
    event_id: String(row.event_id ?? ""),
    change: String(row.change ?? ""),
    from_status: nstr(row.from_status),
    to_status: nstr(row.to_status),
    note: String(row.note ?? ""),
    at: String(row.at ?? ""),
  };
}

/** 读一个目标；没有行返回 null（不编默认值的假目标）。 */
export function getSoulGoal(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  goalId: string,
): SoulGoalRow | null {
  const t = normalizeCoreTenant(tenant);
  const id = typeof goalId === "string" ? goalId.trim() : "";
  if (id === "") return null;
  const row = db
    .prepare(
      "SELECT * FROM soul_goals WHERE goal_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    )
    .get(id, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapGoalRow(row) : null;
}

/** 列出租户内的目标（可按状态/类型/到期过滤）；读失败由调用侧兜底。 */
export function listSoulGoals(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { status?: SoulGoalStatus; kind?: SoulGoalRow["kind"]; owner?: SoulGoalRow["owner"]; dueBefore?: string; limit?: number },
): SoulGoalRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(
    1,
    Math.min(SOUL_GOAL_LIST_DEFAULT_LIMIT, Math.floor(opts?.limit ?? SOUL_GOAL_LIST_DEFAULT_LIMIT)),
  );
  const conds = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (opts?.status) {
    conds.push("status = ?");
    args.push(opts.status);
  }
  if (opts?.kind) {
    conds.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts?.owner) {
    conds.push("owner = ?");
    args.push(opts.owner);
  }
  if (typeof opts?.dueBefore === "string" && opts.dueBefore !== "") {
    conds.push("due_at IS NOT NULL", "due_at <= ?");
    args.push(opts.dueBefore);
  }
  args.push(limit);
  const rows = db
    .prepare(
      "SELECT * FROM soul_goals WHERE " + conds.join(" AND ") + " ORDER BY created_at DESC, goal_id ASC LIMIT ?",
    )
    .all(...args) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapGoalRow);
}

/**
 * 整行写入：新目标 INSERT；已有目标只刷新描述性字段（title/why/due_at/…），
 * **不动** status / progress / valid_to——「又说了一次」不能把 done/abandoned 复活。
 * 返回 created 让调用侧能区分「新建」与「再说一次」（账本 change 不同）。
 */
export function upsertSoulGoal(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  insert: SoulGoalInsert,
): { row: SoulGoalRow; created: boolean } {
  const t = normalizeCoreTenant(tenant);
  const goalId = String(insert.goal_id ?? "").trim();
  if (goalId === "") throw new Error("soul_goals: goal_id 不能为空");
  const title = String(insert.title ?? "").trim();
  if (title === "") throw new Error("soul_goals: title 不能为空");
  const existing = getSoulGoal(db, t, goalId);
  const now = new Date().toISOString();
  if (existing) {
    if (TERMINAL_GOAL_STATUSES.includes(existing.status)) return { row: existing, created: false };
    const merged: SoulGoalRow = {
      ...existing,
      title,
      why: insert.why ?? existing.why,
      priority: num(insert.priority, existing.priority),
      due_at: insert.due_at !== undefined ? insert.due_at : existing.due_at,
      success_criteria: insert.success_criteria ?? existing.success_criteria,
      confidence: num(insert.confidence, existing.confidence),
      updated_at: insert.updated_at ?? now,
    };
    db.prepare(
      "UPDATE soul_goals SET title = ?, why = ?, priority = ?, due_at = ?, success_criteria = ?, confidence = ?, updated_at = ? " +
        "WHERE goal_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    ).run(
      merged.title,
      merged.why,
      merged.priority,
      merged.due_at,
      merged.success_criteria,
      merged.confidence,
      merged.updated_at,
      goalId,
      t.teamId,
      t.userId,
      t.agentId,
    );
    return { row: merged, created: false };
  }
  const row: SoulGoalRow = {
    goal_id: goalId,
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    owner: insert.owner,
    kind: insert.kind,
    title,
    why: insert.why ?? "",
    status: insert.status ?? "active",
    priority: num(insert.priority, 0.5),
    progress: num(insert.progress, 0),
    due_at: insert.due_at ?? null,
    parent_goal_id: insert.parent_goal_id ?? null,
    source_event_id: insert.source_event_id ?? null,
    success_criteria: insert.success_criteria ?? "",
    blocked_reason: insert.blocked_reason ?? "",
    abandon_reason: insert.abandon_reason ?? "",
    valid_from: insert.valid_from,
    valid_to: insert.valid_to ?? null,
    confidence: num(insert.confidence, 0.5),
    created_at: insert.created_at ?? now,
    updated_at: insert.updated_at ?? now,
  };
  db.prepare(
    "INSERT INTO soul_goals (goal_id, team_id, user_id, agent_id, owner, kind, title, why, status, priority, progress, due_at, " +
      "parent_goal_id, source_event_id, success_criteria, blocked_reason, abandon_reason, valid_from, valid_to, confidence, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.goal_id,
    row.team_id,
    row.user_id,
    row.agent_id,
    row.owner,
    row.kind,
    row.title,
    row.why,
    row.status,
    row.priority,
    row.progress,
    row.due_at,
    row.parent_goal_id,
    row.source_event_id,
    row.success_criteria,
    row.blocked_reason,
    row.abandon_reason,
    row.valid_from,
    row.valid_to,
    row.confidence,
    row.created_at,
    row.updated_at,
  );
  return { row, created: true };
}

/**
 * 状态跃迁 + 账本一行（同事务）。规则：
 *  - 非法跃迁零写入返回 reason（调用侧只 warn，不改库）；
 *  - 同状态重复调用返回 changed=false（tick 重放不刷账本）；
 *  - abandoned / blocked 必须带 reason，否则拒绝（目标不能「无声地」消失）。
 */
export function transitionSoulGoal(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  goalId: string,
  to: SoulGoalStatus,
  opts?: GoalTransitionOptions,
): GoalTransitionResult {
  const t = normalizeCoreTenant(tenant);
  const id = typeof goalId === "string" ? goalId.trim() : "";
  const current = id === "" ? null : getSoulGoal(db, t, id);
  if (!current) return { ok: false, reason: "goal-not-found:" + id };
  const from = current.status;
  if (from === to) return { ok: true, goal: current, changed: false };
  if (!canTransitionGoal(from, to)) return { ok: false, reason: "invalid-transition:" + from + "->" + to };
  const at = typeof opts?.at === "string" && opts.at !== "" ? opts.at : new Date().toISOString();
  const reason = typeof opts?.reason === "string" ? opts.reason.trim() : "";
  if (to === "abandoned" && reason === "") return { ok: false, reason: "missing-abandon-reason" };
  if (to === "blocked" && reason === "") return { ok: false, reason: "missing-blocked-reason" };
  const next: SoulGoalRow = { ...current, status: to, updated_at: at };
  if (to === "done") {
    next.progress = 1;
    next.valid_to = at;
    next.blocked_reason = "";
  } else if (to === "abandoned") {
    next.valid_to = at;
    next.abandon_reason = reason;
    next.blocked_reason = "";
  } else if (to === "blocked") {
    next.blocked_reason = reason;
    next.valid_to = null;
  } else if (to === "active") {
    next.blocked_reason = "";
    next.valid_to = null;
  }
  const eventId = typeof opts?.eventId === "string" && opts.eventId.trim() !== "" ? opts.eventId.trim() : "state@" + at;
  const note = typeof opts?.note === "string" && opts.note !== "" ? opts.note : reason;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE soul_goals SET status = ?, progress = ?, blocked_reason = ?, abandon_reason = ?, valid_to = ?, updated_at = ? " +
        "WHERE goal_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    ).run(
      next.status,
      next.progress,
      next.blocked_reason,
      next.abandon_reason,
      next.valid_to,
      next.updated_at,
      id,
      t.teamId,
      t.userId,
      t.agentId,
    );
    db.prepare(
      "INSERT OR IGNORE INTO soul_goal_events (goal_id, event_id, change, from_status, to_status, note, at) " +
        "VALUES (?, ?, 'status_changed', ?, ?, ?, ?)",
    ).run(id, eventId, from, to, note, at);
    db.exec("COMMIT");
  } catch (err) {
    // COMMIT 失败时引擎可能已自动回滚——ROLLBACK 自兜底，不掩蔽原始错误（soul-promise 同款）。
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已不存在 */
    }
    throw err;
  }
  return { ok: true, goal: next, changed: true };
}

/** 账本写入：只给本租户的目标写；返回实际新增行数（幂等命中不计）。 */
export function insertSoulGoalEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  events: SoulGoalEventInsert[],
): { inserted: number } {
  const t = normalizeCoreTenant(tenant);
  if (!Array.isArray(events) || events.length === 0) return { inserted: 0 };
  const owned = new Set(
    (
      db
        .prepare("SELECT goal_id FROM soul_goals WHERE team_id = ? AND user_id = ? AND agent_id = ?")
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<{ goal_id: string }>
    ).map((r) => String(r.goal_id ?? "")),
  );
  if (owned.size === 0) return { inserted: 0 };
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO soul_goal_events (goal_id, event_id, change, from_status, to_status, note, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const e of events) {
    const goalId = String(e.goal_id ?? "").trim();
    const eventId = String(e.event_id ?? "").trim();
    const change = String(e.change ?? "").trim();
    if (goalId === "" || eventId === "" || change === "" || !owned.has(goalId)) continue;
    const info = stmt.run(goalId, eventId, change, e.from_status ?? null, e.to_status ?? null, e.note ?? "", e.at);
    if (Number(info.changes ?? 0) > 0) inserted += 1;
  }
  return { inserted };
}

/** 账本读取：join soul_goals 保证租户边界（账本表自身没有租户列）。 */
export function listSoulGoalEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { goalId?: string; limit?: number },
): SoulGoalEventRow[] {
  const t = normalizeCoreTenant(tenant);
  const limit = Math.max(
    1,
    Math.min(SOUL_GOAL_EVENT_LIST_DEFAULT_LIMIT, Math.floor(opts?.limit ?? SOUL_GOAL_EVENT_LIST_DEFAULT_LIMIT)),
  );
  const conds = ["g.team_id = ?", "g.user_id = ?", "g.agent_id = ?"];
  const args: Array<string | number> = [t.teamId, t.userId, t.agentId];
  const goalId = typeof opts?.goalId === "string" ? opts.goalId.trim() : "";
  if (goalId !== "") {
    conds.push("e.goal_id = ?");
    args.push(goalId);
  }
  args.push(limit);
  const rows = db
    .prepare(
      "SELECT e.goal_id, e.event_id, e.change, e.from_status, e.to_status, e.note, e.at FROM soul_goal_events e " +
        "JOIN soul_goals g ON g.goal_id = e.goal_id WHERE " +
        conds.join(" AND ") +
        " ORDER BY e.at DESC, e.goal_id ASC, e.change ASC LIMIT ?",
    )
    .all(...args) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map(mapGoalEventRow);
}

/** 依赖写入：两边都必须是本租户的目标（依赖表自身没有租户列）。 */
export function insertSoulGoalDep(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  dep: SoulGoalDepInsert,
): { inserted: number } {
  const t = normalizeCoreTenant(tenant);
  const goalId = String(dep.goal_id ?? "").trim();
  const dependsOn = String(dep.depends_on_goal_id ?? "").trim();
  if (goalId === "" || dependsOn === "" || goalId === dependsOn) return { inserted: 0 };
  const owned = new Set(
    (
      db
        .prepare("SELECT goal_id FROM soul_goals WHERE team_id = ? AND user_id = ? AND agent_id = ?")
        .all(t.teamId, t.userId, t.agentId) as unknown as Array<{ goal_id: string }>
    ).map((r) => String(r.goal_id ?? "")),
  );
  if (!owned.has(goalId) || !owned.has(dependsOn)) return { inserted: 0 };
  const info = db
    .prepare("INSERT OR IGNORE INTO soul_goal_deps (goal_id, depends_on_goal_id, kind) VALUES (?, ?, ?)")
    .run(goalId, dependsOn, dep.kind ?? "blocks");
  return { inserted: Number(info.changes ?? 0) > 0 ? 1 : 0 };
}

/** 依赖读取（可按 goalId 过滤；全部依赖用于状态机解阻判定）。 */
export function listSoulGoalDeps(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { goalId?: string },
): SoulGoalDepRow[] {
  const t = normalizeCoreTenant(tenant);
  const conds = ["g.team_id = ?", "g.user_id = ?", "g.agent_id = ?"];
  const args: Array<string> = [t.teamId, t.userId, t.agentId];
  const goalId = typeof opts?.goalId === "string" ? opts.goalId.trim() : "";
  if (goalId !== "") {
    conds.push("d.goal_id = ?");
    args.push(goalId);
  }
  const rows = db
    .prepare(
      "SELECT d.goal_id, d.depends_on_goal_id, d.kind FROM soul_goal_deps d " +
        "JOIN soul_goals g ON g.goal_id = d.goal_id WHERE " +
        conds.join(" AND ") +
        " ORDER BY d.goal_id ASC, d.depends_on_goal_id ASC",
    )
    .all(...args) as unknown as Array<Record<string, unknown>>;
  return (rows ?? []).map((r) => ({
    goal_id: String(r.goal_id ?? ""),
    depends_on_goal_id: String(r.depends_on_goal_id ?? ""),
    kind: String(r.kind ?? "blocks"),
  }));
}

/** working 锚整行 upsert：按 (team,user,agent,session) 一行，会话缺省为 ''（全局锚）。 */
export function upsertSoulWorkingState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  upsert: SoulWorkingStateUpsert,
): SoulWorkingStateRow {
  const t = normalizeCoreTenant(tenant);
  const row: SoulWorkingStateRow = {
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    session_id: typeof upsert.session_id === "string" ? upsert.session_id : "",
    current_goal_id: upsert.current_goal_id ?? null,
    current_focus: String(upsert.current_focus ?? ""),
    open_questions_json: upsert.open_questions_json ?? "[]",
    updated_at: upsert.updated_at,
    expires_at: upsert.expires_at ?? null,
  };
  db.prepare(
    "INSERT INTO soul_working_state (team_id, user_id, agent_id, session_id, current_goal_id, current_focus, " +
      "open_questions_json, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(team_id, user_id, agent_id, session_id) DO UPDATE SET current_goal_id = excluded.current_goal_id, " +
      "current_focus = excluded.current_focus, open_questions_json = excluded.open_questions_json, " +
      "updated_at = excluded.updated_at, expires_at = excluded.expires_at",
  ).run(
    row.team_id,
    row.user_id,
    row.agent_id,
    row.session_id,
    row.current_goal_id,
    row.current_focus,
    row.open_questions_json,
    row.updated_at,
    row.expires_at,
  );
  return row;
}

/** 读 working 锚；没有行（或已过期）返回 null——读侧不拿过期锚当当下。 */
export function getSoulWorkingState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { sessionId?: string; now?: string },
): SoulWorkingStateRow | null {
  const t = normalizeCoreTenant(tenant);
  const sessionId = typeof opts?.sessionId === "string" ? opts.sessionId : "";
  const row = db
    .prepare(
      "SELECT * FROM soul_working_state WHERE team_id = ? AND user_id = ? AND agent_id = ? AND session_id = ?",
    )
    .get(t.teamId, t.userId, t.agentId, sessionId) as unknown as Record<string, unknown> | undefined;
  if (!row) return null;
  const out: SoulWorkingStateRow = {
    team_id: String(row.team_id ?? ""),
    user_id: String(row.user_id ?? ""),
    agent_id: String(row.agent_id ?? ""),
    session_id: String(row.session_id ?? ""),
    current_goal_id: nstr(row.current_goal_id),
    current_focus: String(row.current_focus ?? ""),
    open_questions_json: String(row.open_questions_json ?? "[]"),
    updated_at: String(row.updated_at ?? ""),
    expires_at: nstr(row.expires_at),
  };
  if (typeof opts?.now === "string" && opts.now !== "" && out.expires_at && out.expires_at <= opts.now) return null;
  return out;
}

/** 清 working 锚：没有目标/承诺/阻塞时调用——不留「暂无目标」的占位行。 */
export function clearSoulWorkingState(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  opts?: { sessionId?: string },
): { deleted: number } {
  const t = normalizeCoreTenant(tenant);
  const sessionId = typeof opts?.sessionId === "string" ? opts.sessionId : "";
  const info = db
    .prepare("DELETE FROM soul_working_state WHERE team_id = ? AND user_id = ? AND agent_id = ? AND session_id = ?")
    .run(t.teamId, t.userId, t.agentId, sessionId);
  return { deleted: Number(info.changes ?? 0) };
}
