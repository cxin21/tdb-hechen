/**
 * P6 叙事层（spec §4.8）的读写收口：soul_narrative + soul_narrative_evidence。
 *
 * 与 soul-person-state-store / soul-goal-store / soul-mood-store 同一取舍：纯函数文件，
 * 入参出参一律用 soul-event-types.ts 的 Row/InsertOf，不定义第二份字段表，租户只从参数来。
 *
 * 三条硬约定：
 *  - 章节是「按周期（自然周）一版」的：同一租户同一 period_start 最多一条 active（部分唯一索引兜底），
 *    换版本走 supersedes_id 链，旧行 status=superseded 保留，绝不覆盖。
 *  - 章节与证据同一个事务：章进去了证据没进去 = 自传在补心理戏，宁可整章不落。
 *  - 遗忘是读侧的事（salience 按 period_end 衰减 + 注入门），这里不删行、不改 status。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  SoulNarrativeEvidenceInsert,
  SoulNarrativeEvidenceRow,
  SoulNarrativeInsert,
  SoulNarrativeRow,
  SoulNarrativeStatus,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

/** 章节默认列数上限：一次 tick 最多写 7 章，读侧 200 足够回看两年。 */
export const SOUL_NARRATIVE_LIST_DEFAULT_LIMIT = 200;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function mapSoulNarrativeRow(row: Record<string, unknown>): SoulNarrativeRow {
  const status = String(row.status ?? "active");
  return {
    chapter_id: String(row.chapter_id ?? ""),
    team_id: String(row.team_id ?? "default"),
    user_id: String(row.user_id ?? "default"),
    agent_id: String(row.agent_id ?? "default"),
    period_start: String(row.period_start ?? ""),
    period_end: String(row.period_end ?? ""),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    turning_points_json: String(row.turning_points_json ?? "[]"),
    lessons_json: String(row.lessons_json ?? "[]"),
    version: Number(row.version ?? 1),
    hash: String(row.hash ?? ""),
    supersedes_id: row.supersedes_id === null || row.supersedes_id === undefined ? null : String(row.supersedes_id),
    // 旧行/手改行可能绕过写侧，读侧只认两个合法值：其它一律当 active 会让读面出现「第三条状态」。
    status: (status === "superseded" ? "superseded" : "active") as SoulNarrativeStatus,
    created_at: String(row.created_at ?? ""),
    // 读侧再夹一次 0..1：显著度参与排序与注入门，负数/NaN 会把排序搞乱。
    salience: clamp01(Number(row.salience ?? 0.3)),
    access_count: Math.max(0, Math.trunc(Number(row.access_count ?? 0))),
    last_accessed_at:
      row.last_accessed_at === null || row.last_accessed_at === undefined ? null : String(row.last_accessed_at),
    updated_at: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
  };
}

export interface SoulNarrativeListFilter {
  status?: SoulNarrativeStatus;
  /** 时间方向，默认 desc（最新月份在前）。 */
  order?: "asc" | "desc";
  /** 页大小，默认 200，上限 500。 */
  limit?: number;
  offset?: number;
}

/** 按租户列章节；不过滤显著度——「遗忘是停止注入，不是删行」（低显著的行照样读得到）。 */
export function listSoulNarrativeChapters(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  filter: SoulNarrativeListFilter = {},
): SoulNarrativeRow[] {
  const t = normalizeCoreTenant(tenant);
  const clauses = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const params: Array<string | number> = [t.teamId, t.userId, t.agentId];
  if (filter.status !== undefined) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const dir = filter.order === "asc" ? "ASC" : "DESC";
  const limitRaw = filter.limit ?? SOUL_NARRATIVE_LIST_DEFAULT_LIMIT;
  const limit = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(limitRaw) ? limitRaw : 200)));
  const offsetRaw = filter.offset ?? 0;
  const offset = Math.max(0, Math.trunc(Number.isFinite(offsetRaw) ? offsetRaw : 0));
  const rows = db
    .prepare(
      "SELECT * FROM soul_narrative WHERE " +
        clauses.join(" AND ") +
        " ORDER BY period_start " + dir + ", version " + dir + ", chapter_id " + dir + " LIMIT ? OFFSET ?",
    )
    .all(...params, limit, offset) as unknown as Record<string, unknown>[];
  return rows.map(mapSoulNarrativeRow);
}

export function getSoulNarrativeChapter(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  chapterId: string,
): SoulNarrativeRow | null {
  const t = normalizeCoreTenant(tenant);
  const row = db
    .prepare("SELECT * FROM soul_narrative WHERE chapter_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(chapterId, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown> | undefined;
  return row ? mapSoulNarrativeRow(row) : null;
}

/** 章节的证据（按 event_id 稳定排序；租户通过章节收口，证据表本身没有租户列）。 */
export function listSoulNarrativeEvidenceRows(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  chapterId: string,
): SoulNarrativeEvidenceRow[] {
  const t = normalizeCoreTenant(tenant);
  const rows = db
    .prepare(
      "SELECT e.chapter_id, e.event_id, e.role FROM soul_narrative_evidence e " +
        "JOIN soul_narrative n ON n.chapter_id = e.chapter_id " +
        "WHERE e.chapter_id = ? AND n.team_id = ? AND n.user_id = ? AND n.agent_id = ? " +
        "ORDER BY e.event_id ASC, e.role ASC",
    )
    .all(chapterId, t.teamId, t.userId, t.agentId) as unknown as Record<string, unknown>[];
  return rows.map((row) => ({
    chapter_id: String(row.chapter_id ?? ""),
    event_id: String(row.event_id ?? ""),
    role: String(row.role ?? "evidence"),
  }));
}

export interface SoulNarrativeCommitInput {
  chapter: SoulNarrativeInsert;
  /** 1–3 条证据；event_id 即 soul_events.event_id（= episode id）。 */
  evidence: Array<Pick<SoulNarrativeEvidenceInsert, "event_id"> & { role?: string }>;
  /** 这一版取代的旧 active 章节（同租户同期），事务内标 superseded。 */
  supersedeIds?: string[];
}

export interface SoulNarrativeCommitResult {
  /** 这一行是新写进去的（false = 同 chapter_id 已存在，重放）。 */
  inserted: boolean;
  /** 被标成 superseded 的旧章节数。 */
  superseded: number;
}

/**
 * 写一章 + 证据（同一事务）。
 *
 * 顺序是先标旧版 superseded 再插新版：部分唯一索引只允许一条 active，
 * 反过来的话 INSERT 会先撞索引。同一 chapter_id 重放走 INSERT OR IGNORE，
 * 证据同样 OR IGNORE（主键 chapter_id+event_id+role），不翻倍。
 */
export function commitSoulNarrativeChapter(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  input: SoulNarrativeCommitInput,
): SoulNarrativeCommitResult {
  const t = normalizeCoreTenant(tenant);
  const row = input.chapter;
  const chapterId = String(row.chapter_id ?? "");
  if (chapterId === "") throw new Error("commitSoulNarrativeChapter: chapter_id 不能为空");
  const now = String(row.created_at ?? new Date().toISOString());
  const supersedeIds = Array.from(new Set((input.supersedeIds ?? []).filter((id) => id !== "" && id !== chapterId)));
  let inserted = false;
  let superseded = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const oldId of supersedeIds) {
      const info = db
        .prepare(
          "UPDATE soul_narrative SET status = 'superseded', updated_at = ? " +
            "WHERE chapter_id = ? AND team_id = ? AND user_id = ? AND agent_id = ? AND status = 'active'",
        )
        .run(now, oldId, t.teamId, t.userId, t.agentId);
      superseded += Number(info.changes ?? 0) > 0 ? 1 : 0;
    }
    const info = db
      .prepare(
        "INSERT OR IGNORE INTO soul_narrative (chapter_id, team_id, user_id, agent_id, period_start, period_end, " +
          "title, summary, turning_points_json, lessons_json, version, hash, supersedes_id, status, created_at, " +
          "salience, access_count, last_accessed_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        chapterId,
        t.teamId,
        t.userId,
        t.agentId,
        String(row.period_start ?? ""),
        String(row.period_end ?? ""),
        String(row.title ?? ""),
        String(row.summary ?? ""),
        String(row.turning_points_json ?? "[]"),
        String(row.lessons_json ?? "[]"),
        Number(row.version ?? 1),
        String(row.hash ?? ""),
        row.supersedes_id ?? null,
        String(row.status ?? "active"),
        now,
        clamp01(Number(row.salience ?? 0.3)),
        Math.max(0, Math.trunc(Number(row.access_count ?? 0))),
        row.last_accessed_at ?? null,
        row.updated_at ?? null,
      );
    inserted = Number(info.changes ?? 0) > 0;
    if (inserted) {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO soul_narrative_evidence (chapter_id, event_id, role) VALUES (?, ?, ?)",
      );
      for (const ev of input.evidence ?? []) {
        const eventId = String(ev.event_id ?? "");
        if (eventId === "") continue;
        stmt.run(chapterId, eventId, String(ev.role ?? "evidence"));
      }
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
  return { inserted, superseded };
}

/**
 * 记忆强化：章节被注入取用一次才 +1（access_count/last_accessed_at）。
 *
 * 只在读面（卡注入）调用；不传 chapterIds 时什么都不做——「读了整个列表」不等于
 * 「每条都被用过」，那会把 access 变成噪声。
 */
export function touchSoulNarrativeAccess(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  chapterIds: string[],
  opts: { now?: string } = {},
): { updated: number } {
  const t = normalizeCoreTenant(tenant);
  const ids = Array.from(new Set((chapterIds ?? []).filter((id) => typeof id === "string" && id !== "")));
  if (ids.length === 0) return { updated: 0 };
  const now = opts.now ?? new Date().toISOString();
  const stmt = db.prepare(
    "UPDATE soul_narrative SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ? " +
      "WHERE chapter_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
  );
  let updated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      const info = stmt.run(now, now, id, t.teamId, t.userId, t.agentId);
      updated += Number(info.changes ?? 0) > 0 ? 1 : 0;
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
  return { updated };
}
