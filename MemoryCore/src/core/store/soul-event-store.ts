/**
 * 灵魂事件底座的读写收口（P0-B）：soul_events + soul_event_evidence + 三张类型子表。
 *
 * 为什么是一个「纯 store」文件而不是 sqlite.ts 上的方法：
 *  1. 事件层是 P1–P7 所有闭环的底座，写入点会散落在 worker / 迁移脚本 / 双写路径上；
 *     把它做成「db 句柄进、行进出」的纯函数，调用方不必持有 VectorStore 实例，也不必为了写一条事件
 *     把 sqlite-vec 拉起来（与 soul-event-ddl.ts 头部的取舍同一个理由）。
 *  2. 出参/入参一律用 soul-event-types.ts 的 Row / InsertOf，本文件不定义第二份字段表——
 *     字段漂移有一处发生就够，不要两处。
 *  3. 事务边界显式：insertSoulEvent 自己 BEGIN/COMMIT；insertSoulEventInTransaction 不碰事务，
 *     专供「已经在一个事务里」的调用方（sqlite.ts 的 commitSoulEpisodes 双写就是这样）。
 *
 * 三条硬约定：
 *  - 租户只从参数来。insert 载荷里若带了与 tenant 不同的 team_id/user_id/agent_id，直接抛错，
 *    不静默改写：跨租户写错是审计事故，静默纠偏会让它永远查不出来。
 *  - store 不伪造证据。证据为空的唯一合法形态是 epistemic=inferred 且 confidence<=0.5（spec §4.2），
 *    违反就抛错；不会替调用方补一条假 evidence 让「每条事件至少一条证据」看起来成立。
 *  - deleteSoulEvent 显式删子表，不依赖 ON DELETE CASCADE。原因写在 soul-event-ddl.ts 头部事实 1：
 *    PRAGMA foreign_keys 默认 OFF，CASCADE 在生产是死约束，靠它删会留下孤儿 event_id。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.1–§4.3、§5.2。
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type {
  SoulEventActionInsert,
  SoulEventActionResultRow,
  SoulEventActor,
  SoulEventChatInsert,
  SoulEventChatRow,
  SoulEventEvidenceInsert,
  SoulEventEvidenceRow,
  SoulEventInsert,
  SoulEventReflectionInsert,
  SoulEventReflectionRow,
  SoulEventRow,
  SoulEventSourceKind,
  SoulEventStatus,
} from "./soul-event-types.js";
import type { CoreTenant } from "./types.js";
import { normalizeCoreTenant } from "./types.js";

// ─────────────────────────────── 常量与错误 ───────────────────────────────

/**
 * 列表默认页大小。50 是「一屏够看、成本可控」的折中：卡与面板要的是最近发生了什么，
 * 不是全量导表；全量走 countSoulEvents + 分页 offset 自己翻。
 */
export const SOUL_EVENT_LIST_DEFAULT_LIMIT = 50;

/**
 * 列表硬上限。超过就截断而不是抛错——上限存在的目的是防「忘传 limit 时拉全表」，
 * 让调用方为这个防御性参数去 catch 只会换来他把 500 抄进代码。
 */
export const SOUL_EVENT_LIST_MAX_LIMIT = 500;

/**
 * 写入侧的准入错误（规则违反，不是 SQLite 约束错误）。
 * 独立成类是为了让调用方能区分「我的输入不合法，改输入」与「库里的约束不让写，先修数据结构」。
 */
export class SoulEventWriteError extends Error {
  constructor(message: string) {
    super(`soul_event_write: ${message}`);
    this.name = "SoulEventWriteError";
  }
}

// ─────────────────────────────── 列清单（唯一事实源） ───────────────────────────────

/**
 * 五组列清单与 soul-event-types.ts 的 Row 接口用 satisfies 绑定：
 * 有人往 Row 里加列却没加进来（或打错字）时，这里先编译失败，而不是等运行期少写一列。
 * 顺序 = DDL 顺序，便于和建表语句逐列对照。
 */
const EVENT_COLUMNS = [
  "event_id",
  "team_id",
  "user_id",
  "agent_id",
  "at",
  "day",
  "valid_from",
  "valid_to",
  "actor",
  "actor_person_key",
  "action",
  "object",
  "intent",
  "outcome",
  "status",
  "source_kind",
  "source_ref",
  "ownership",
  "epistemic",
  "confidence",
  "visibility",
  "session_id",
  "persons_json",
  "parent_event_id",
  "dedupe_key",
  "salience",
  "created_at",
  "archived_at",
] as const satisfies readonly (keyof SoulEventRow)[];

const EVIDENCE_COLUMNS = [
  "event_id",
  "record_id",
  "role",
  "quote",
  "at",
  "confidence",
] as const satisfies readonly (keyof SoulEventEvidenceRow)[];

const CHAT_COLUMNS = [
  "event_id",
  "kind",
  "title",
  "user_stance",
  "agent_stance",
  "cost",
  "valence",
  "arousal",
  "intensity",
  "affect_source",
  "quote_json",
  "signals_json",
  "layers_json",
  "mood_integrated_at",
] as const satisfies readonly (keyof SoulEventChatRow)[];

const ACTION_COLUMNS = [
  "event_id",
  "tool",
  "tool_call_id",
  "args_digest",
  "result_status",
  "duration_ms",
  "artifact_ref",
  "error_code",
  "environment",
  "verified_by",
] as const satisfies readonly (keyof SoulEventActionResultRow)[];

const REFLECTION_COLUMNS = [
  "event_id",
  "about_event_ids_json",
  "lesson",
  "behavior_change",
  "verified_at",
  "confidence",
] as const satisfies readonly (keyof SoulEventReflectionRow)[];

// ─────────────────────────────── 默认值物化 ───────────────────────────────
// 下面四个 materialize* 把 InsertOf（可省）补齐成完整行，省略值一律抄 DDL 的 DEFAULT。
// 抄默认值这件事有漂移风险，所以 __tests__ 里有一条「最小写入 → 逐字段读回默认值」的用例
// 把 DDL 与这里钉在一起：谁改了 DDL 默认值而忘记改这里，测试立刻红。
// 另一重保险是上面的 satisfies：往 Row 加列时这里会编译失败，不会静默漏写。

/** 基表：租户取参数三元组，其余省略值按 DDL DEFAULT 补。 */
function materializeEvent(t: CoreTenant, e: SoulEventInsert): SoulEventRow {
  return {
    event_id: e.event_id,
    team_id: t.teamId,
    user_id: t.userId,
    agent_id: t.agentId,
    at: e.at,
    day: e.day,
    valid_from: e.valid_from,
    valid_to: e.valid_to ?? null,
    actor: e.actor,
    actor_person_key: e.actor_person_key ?? null,
    action: e.action,
    object: e.object ?? "",
    intent: e.intent ?? "",
    outcome: e.outcome ?? "",
    status: e.status ?? "unknown",
    source_kind: e.source_kind,
    source_ref: e.source_ref ?? "",
    ownership: e.ownership ?? "observed",
    epistemic: e.epistemic ?? "observed",
    confidence: e.confidence ?? 0.5,
    visibility: e.visibility ?? "shared",
    session_id: e.session_id ?? "",
    persons_json: e.persons_json ?? null,
    parent_event_id: e.parent_event_id ?? null,
    dedupe_key: e.dedupe_key ?? null,
    salience: e.salience ?? 0.5,
    created_at: e.created_at,
    archived_at: e.archived_at ?? null,
  };
}

function materializeEvidence(eventId: string, e: SoulEventEvidenceInsert): SoulEventEvidenceRow {
  return {
    event_id: eventId,
    record_id: e.record_id,
    role: e.role,
    quote: e.quote ?? "",
    at: e.at,
    confidence: e.confidence ?? 1.0,
  };
}

function materializeChat(e: SoulEventChatInsert): SoulEventChatRow {
  return {
    event_id: e.event_id,
    kind: e.kind,
    title: e.title ?? "",
    user_stance: e.user_stance ?? "",
    agent_stance: e.agent_stance ?? "",
    cost: e.cost ?? "",
    valence: e.valence ?? 0,
    arousal: e.arousal ?? 0,
    intensity: e.intensity ?? 0,
    affect_source: e.affect_source ?? "lexicon",
    quote_json: e.quote_json ?? null,
    signals_json: e.signals_json ?? null,
    layers_json: e.layers_json ?? null,
    mood_integrated_at: e.mood_integrated_at ?? null,
  };
}

function materializeAction(e: SoulEventActionInsert): SoulEventActionResultRow {
  return {
    event_id: e.event_id,
    tool: e.tool,
    tool_call_id: e.tool_call_id ?? null,
    args_digest: e.args_digest ?? null,
    result_status: e.result_status ?? "unknown",
    duration_ms: e.duration_ms ?? null,
    artifact_ref: e.artifact_ref ?? null,
    error_code: e.error_code ?? null,
    environment: e.environment ?? null,
    verified_by: e.verified_by ?? null,
  };
}

function materializeReflection(e: SoulEventReflectionInsert): SoulEventReflectionRow {
  return {
    event_id: e.event_id,
    about_event_ids_json: e.about_event_ids_json ?? "[]",
    lesson: e.lesson,
    behavior_change: e.behavior_change ?? "",
    verified_at: e.verified_at ?? null,
    confidence: e.confidence ?? 0.5,
  };
}

// ─────────────────────────────── SQL 小工具 ───────────────────────────────

/** 一条 INSERT（列清单由上方常量给出，全部参数化）。 */
function insertRow(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
  values: readonly SQLInputValue[],
): void {
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...values,
  );
}

/**
 * 一条 upsert：冲突键是 event_id（三张子表的主键）。
 * 语义是整行覆盖，不是打补丁——省略的字段会回到 DDL 默认值。这样调用方永远只有一种读回形态，
 * 不会出现「这次更新的字段是旧值、上次的是新值」的半新行。
 */
function upsertRow(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
  values: readonly SQLInputValue[],
): void {
  const updates = columns
    .filter((c) => c !== "event_id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
     ON CONFLICT(event_id) DO UPDATE SET ${updates}`,
  ).run(...values);
}

function eventRowValues(row: SoulEventRow): SQLInputValue[] {
  return EVENT_COLUMNS.map((c) => row[c]);
}

function evidenceRowValues(row: SoulEventEvidenceRow): SQLInputValue[] {
  return EVIDENCE_COLUMNS.map((c) => row[c]);
}

function chatRowValues(row: SoulEventChatRow): SQLInputValue[] {
  return CHAT_COLUMNS.map((c) => row[c]);
}

function actionRowValues(row: SoulEventActionResultRow): SQLInputValue[] {
  return ACTION_COLUMNS.map((c) => row[c]);
}

function reflectionRowValues(row: SoulEventReflectionRow): SQLInputValue[] {
  return REFLECTION_COLUMNS.map((c) => row[c]);
}

/** 截断到上限区间：非有限/<=0 → 默认页大小；超上限 → 上限。 */
function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return SOUL_EVENT_LIST_DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n <= 0) return SOUL_EVENT_LIST_DEFAULT_LIMIT;
  return Math.min(n, SOUL_EVENT_LIST_MAX_LIMIT);
}

// ─────────────────────────────── 写入前校验 ───────────────────────────────

/**
 * 租户一致性：载荷里显式带了的租户字段必须与参数一致。
 * 只查「带了且不等」——带了相等是合法的（迁移脚本原样传行很方便），没带就由参数决定。
 */
function assertTenantFields(t: CoreTenant, e: SoulEventInsert): void {
  const pairs: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["team_id", e.team_id, t.teamId],
    ["user_id", e.user_id, t.userId],
    ["agent_id", e.agent_id, t.agentId],
  ];
  for (const [field, given, expected] of pairs) {
    if (given !== undefined && given !== expected) {
      throw new SoulEventWriteError(
        `事件 ${e.event_id} 的 ${field}="${given}" 与 tenant 的 "${expected}" 不一致；` +
          "租户只从 tenant 参数来，拒绝跨租户写入。",
      );
    }
  }
}

/**
 * 子表行的 event_id 必须等于本次写入的事件 id。
 * 类型上 event_id 是必填的（子表主键），调用处很容易复制粘贴忘改——在这里拦，
 * 比等 FK 在 PRAGMA foreign_keys=ON 时才报错可靠（默认 OFF 时它根本不报）。
 */
function assertChildEventIds(eventId: string, write: SoulEventWrite): void {
  const children: Array<readonly [string, { event_id: string } | undefined]> = [
    ["soul_event_chat", write.chat],
    ["soul_event_action", write.action],
    ["soul_event_reflection", write.reflection],
  ];
  (write.evidence ?? []).forEach((row, i) => {
    children.push([`soul_event_evidence[${i}]`, row]);
  });
  for (const [label, row] of children) {
    if (row && row.event_id !== eventId) {
      throw new SoulEventWriteError(
        `${label} 的 event_id="${row.event_id}" 与事件 "${eventId}" 不一致；子表行必须挂在同一次写入的事件上。`,
      );
    }
  }
}

/**
 * 工具类来源（P1-B §4.2 第 4 条）：这些事件由工具/门禁自报，不是人确认，
 * 「观察到了」只能由工具自己的输出背书，且不给满分。
 */
export const SOUL_TOOL_BACKED_SOURCE_KINDS: ReadonlySet<SoulEventSourceKind> = new Set<SoulEventSourceKind>([
  "tool",
  "test",
  "commit",
  "rollback",
]);

/** 工具类事件的 observed 置信上限（spec §4.2 第 4 条）：剩下 0.1 留给人工验收。 */
export const SOUL_TOOL_EVIDENCE_MAX_CONFIDENCE = 0.9;

/**
 * 「工具证据」= role=tool + quote 非空 + record_id 非空。
 * record_id 记的是 **tool_call_id**（不是 L0 record_id）：工具事件没有对应的 L0 记忆行，
 * 拿 L0 id 冒充会把「我跑过这条命令」变成查不到源头的断言。
 */
function isToolEvidence(row: SoulEventEvidenceRow): boolean {
  return row.role === "tool" && row.quote.trim() !== "" && row.record_id.trim() !== "";
}

function hasToolEvidence(evidence: readonly SoulEventEvidenceRow[]): boolean {
  return evidence.some(isToolEvidence);
}

/**
 * spec §4.2 写入层准入（表结构只管「证据行长得对」，准入门槛在这里）：
 *  1. 每条事件至少一条证据；没有证据的事件只能标 epistemic=inferred 且 confidence<=0.5，
 *     并在卡上显示「推测」。
 *  2. P1-B 第 4 条：工具类来源（tool/test/commit/rollback）带工具证据（role=tool、quote 非空、
 *     record_id=tool_call_id）时允许 epistemic=observed，但 confidence 上限 0.9——
 *     工具自报的「观察到了」不该和人工验收同权。
 * 第 2 条与「有证据即放行」是**叠加**关系，不收紧既有写入路径（chat/observation/… 与老调用方
 * 不受影响）；它只对工具类事件的 observed 额外压一条上限，超限即拒并说明是哪条证据在背书。
 * 判的是物化后的默认值（与 DDL DEFAULT 一致），所以「什么都不传」= observed + 0.5 → 被拒。
 */
function assertEvidenceRule(event: SoulEventRow, evidence: readonly SoulEventEvidenceRow[]): void {
  if (evidence.length > 0) {
    if (
      event.epistemic === "observed" &&
      event.confidence > SOUL_TOOL_EVIDENCE_MAX_CONFIDENCE &&
      SOUL_TOOL_BACKED_SOURCE_KINDS.has(event.source_kind) &&
      hasToolEvidence(evidence)
    ) {
      throw new SoulEventWriteError(
        `工具类事件 ${event.event_id}（source_kind=${event.source_kind}）带工具证据只允许 confidence<=` +
          `${SOUL_TOOL_EVIDENCE_MAX_CONFIDENCE}，当前 confidence=${event.confidence}（spec §4.2 第 4 条）：` +
          "工具自报的 observed 不占满分，剩下的置信留给人工验收。",
      );
    }
    return;
  }
  if (event.epistemic === "inferred" && event.confidence <= 0.5) return;
  throw new SoulEventWriteError(
    `事件 ${event.event_id} 没有任何证据，只有 epistemic=inferred 且 confidence<=0.5 才能落库（spec §4.2）；` +
      `当前 epistemic=${event.epistemic} confidence=${event.confidence}。store 不会替调用方伪造证据行。`,
  );
}

/** 子表 upsert 的前置：事件必须存在（可选再校验它属于该租户），不留孤儿 event_id。 */
function assertEventExists(db: DatabaseSync, eventId: string, table: string, tenant?: CoreTenant): void {
  const t = tenant === undefined ? undefined : normalizeCoreTenant(tenant);
  const row = (
    t === undefined
      ? db.prepare("SELECT 1 AS one FROM soul_events WHERE event_id = ?").get(eventId)
      : db
          .prepare(
            "SELECT 1 AS one FROM soul_events WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
          )
          .get(eventId, t.teamId, t.userId, t.agentId)
  ) as { one?: number } | undefined;
  if (!row) {
    const scope = t === undefined ? "" : `（租户 ${t.teamId}/${t.userId}/${t.agentId}）`;
    throw new SoulEventWriteError(`${table} 指向的事件 ${eventId} 不存在${scope}；先写基表再写子表。`);
  }
}

// ─────────────────────────────── 写入 ───────────────────────────────

/**
 * 一次事件写入的完整载荷：基表一行 + 证据若干（可为空，受 §4.2 规则约束）+ 至多一张类型子表。
 *
 * 类型子表与 source_kind 的对应关系（chat 对 chat、action 对 tool/test/commit/rollback、
 * reflection 对 reflection）不在 store 里强制：迁移与重放会把老数据原样搬过来，
 * 这里多一条硬校验就多一批搬不动的行。想校验的调用方自己判 source_kind。
 */
export interface SoulEventWrite {
  event: SoulEventInsert;
  /** 证据（至少一条，或按 §4.2 走 inferred 例外）。 */
  evidence?: readonly SoulEventEvidenceInsert[];
  chat?: SoulEventChatInsert;
  action?: SoulEventActionInsert;
  reflection?: SoulEventReflectionInsert;
}

/**
 * 在调用方已有的事务里写一条事件（本函数不 BEGIN / 不 COMMIT）。
 *
 * 写给 sqlite.ts 的 commitSoulEpisodes：它包着一个 BEGIN IMMEDIATE 做双写，
 * 双写里若再 BEGIN 会撞 "cannot start a transaction within a transaction"。
 * 同一条写入逻辑只此一份，insertSoulEvent 只是给它套了层事务。
 *
 * 返回物化后的基表行（即刚写进去的样子）；要看库里的权威形态用 getSoulEvent。
 */
export function insertSoulEventInTransaction(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  write: SoulEventWrite,
): SoulEventRow {
  const t = normalizeCoreTenant(tenant);
  assertTenantFields(t, write.event);

  const event = materializeEvent(t, write.event);
  const evidence = (write.evidence ?? []).map((row) => materializeEvidence(event.event_id, row));
  assertChildEventIds(event.event_id, write);
  assertEvidenceRule(event, evidence);

  insertRow(db, "soul_events", EVENT_COLUMNS, eventRowValues(event));
  if (write.chat) insertRow(db, "soul_event_chat", CHAT_COLUMNS, chatRowValues(materializeChat(write.chat)));
  if (write.action) {
    insertRow(db, "soul_event_action", ACTION_COLUMNS, actionRowValues(materializeAction(write.action)));
  }
  if (write.reflection) {
    insertRow(
      db,
      "soul_event_reflection",
      REFLECTION_COLUMNS,
      reflectionRowValues(materializeReflection(write.reflection)),
    );
  }
  for (const row of evidence) insertRow(db, "soul_event_evidence", EVIDENCE_COLUMNS, evidenceRowValues(row));

  return event;
}

/**
 * 写一条事件：基表 + 类型子表 + 证据，一个事务里全落或全不落。
 *
 * 不做「已存在就跳过」：重复 event_id 走 PK 冲突抛错并整笔回滚。
 * 幂等是调用方的事（迁移/重派需要 ignore 时，先 getSoulEvent 判断，别让这里静默吞掉
 * 「同一件事写了两遍」——那正是审计想看见的信号）。
 * 也正因为本函数自带事务，它只能作为最外层调用：已在事务里请用 insertSoulEventInTransaction。
 */
export function insertSoulEvent(db: DatabaseSync, tenant: CoreTenant | undefined, write: SoulEventWrite): SoulEventRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = insertSoulEventInTransaction(db, tenant, write);
    db.exec("COMMIT");
    return row;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已在回滚态 */
    }
    throw err;
  }
}

/** dedupe_key 的租户分隔符（U+001F，不会出现在租户 id 或幂等键里）。 */
const DEDUPE_KEY_SEPARATOR = "\u001f";

/**
 * 把租户拼进幂等键：`idx_soul_events_dedupe_key` 是全表级 UNIQUE（soul-event-ddl.ts:105-113），
 * 不同租户各自用 "turn-1" 这样的短键会互相顶掉。写入方必须走这里，别自己拼字符串。
 * 读侧用 findSoulEventIdByDedupeKey，同样按租户+键查，两端口径只有这一份。
 */
export function composeSoulEventDedupeKey(tenant: CoreTenant | undefined, dedupeKey: string): string {
  const t = normalizeCoreTenant(tenant);
  return [t.teamId, t.userId, t.agentId, dedupeKey].join(DEDUPE_KEY_SEPARATOR);
}

/**
 * 幂等查询：这个租户的这条 dedupe_key 是否已经落过？命中返回 event_id，否则 null。
 * 只查基表（子表由 event_id 关联），也不做「查不到就写入」——查与写之间要给调用方留
 * 「先查后插 + 唯一冲突兜底」的两段式，唯一索引才是最终裁决者。
 */
export function findSoulEventIdByDedupeKey(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  dedupeKey: string,
): string | null {
  const t = normalizeCoreTenant(tenant);
  const row = db
    .prepare(
      "SELECT event_id FROM soul_events WHERE dedupe_key = ? AND team_id = ? AND user_id = ? AND agent_id = ?",
    )
    .get(dedupeKey, t.teamId, t.userId, t.agentId) as { event_id?: string } | undefined;
  return row?.event_id ?? null;
}

/**
 * 双写/重放用的 upsert：已存在就改、不存在就插（不 BEGIN / 不 COMMIT）。
 *
 * 为什么需要它：commitSoulEpisodes 对已存在的 episode 走 refresh（旧行该更新而不是报错），
 * 而 deleteSoulEvent 自带 BEGIN，在那个事务里调用会撞「cannot start a transaction within a transaction」；
 * 于是 refresh 路径统一走这里。
 *
 * 子表保留策略（与 insert 的差别，务必看清）：
 *  - 基表：整行覆盖——省略字段回到 DDL 默认值（与三张子表 upsert 同一语义），
 *    但租户三列只由 tenant 决定，不进 SET。
 *  - evidence：write.evidence 给了就整组替换（先删后插）；没给就保留库里原有证据。
 *    没给=保留，是给 commitSoulEpisodes 用的：refresh 一条老 episode 时它未必带证据，
 *    这里若清空会让「每条事件至少一条证据」瞬间破功。
 *  - chat / action / reflection：给了就覆盖该行，没给就完全不碰（原行与其它子表都保留）。
 *
 * 证据准入在写完后再判一次（替换后的总数）：write.evidence=[] 显式清空会被 §4.2 拦住，
 * 而「没给证据 + 原本就有证据」照常放行。
 *
 * 不存在时直接转 insertSoulEventInTransaction（复用同一套插入逻辑，不复制一遍）。
 * 已存在但属于别的租户 → 抛错：event_id 是全局主键，静默改写等于把别人的行搬到我名下。
 *
 * 注意：本函数不自带事务，中途失败留下的半截写入由调用方的 ROLLBACK 收拾——
 * 双写的调用方本来就握着那个事务，它才是原子性的责任人。
 */
export function upsertSoulEventInTransaction(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  write: SoulEventWrite,
): SoulEventRow {
  const t = normalizeCoreTenant(tenant);
  assertTenantFields(t, write.event);
  const eventId = write.event.event_id;
  assertChildEventIds(eventId, write);

  const exists = db.prepare("SELECT 1 AS one FROM soul_events WHERE event_id = ?").get(eventId) as
    { one?: number } | undefined;
  if (!exists) return insertSoulEventInTransaction(db, t, write);

  const owned = db
    .prepare("SELECT 1 AS one FROM soul_events WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(eventId, t.teamId, t.userId, t.agentId) as { one?: number } | undefined;
  if (!owned) {
    throw new SoulEventWriteError(
      `事件 ${eventId} 已存在于别的租户（${t.teamId}/${t.userId}/${t.agentId} 名下没有它）；` +
        "upsert 不会把别的事件挪到当前租户。",
    );
  }

  const event = materializeEvent(t, write.event);
  // 租户三列由 tenant 决定并写进 WHERE，不进 SET：即便这里被改也不会搬租户。
  const setColumns = EVENT_COLUMNS.filter(
    (c) => c !== "event_id" && c !== "team_id" && c !== "user_id" && c !== "agent_id",
  );
  db.prepare(
    `UPDATE soul_events SET ${setColumns.map((c) => `${c} = ?`).join(", ")}
     WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?`,
  ).run(...setColumns.map((c) => event[c]), eventId, t.teamId, t.userId, t.agentId);

  if (write.evidence !== undefined) {
    db.prepare("DELETE FROM soul_event_evidence WHERE event_id = ?").run(eventId);
    for (const row of write.evidence) {
      insertRow(db, "soul_event_evidence", EVIDENCE_COLUMNS, evidenceRowValues(materializeEvidence(eventId, row)));
    }
  }
  if (write.chat) upsertRow(db, "soul_event_chat", CHAT_COLUMNS, chatRowValues(materializeChat(write.chat)));
  if (write.action) {
    upsertRow(db, "soul_event_action", ACTION_COLUMNS, actionRowValues(materializeAction(write.action)));
  }
  if (write.reflection) {
    upsertRow(
      db,
      "soul_event_reflection",
      REFLECTION_COLUMNS,
      reflectionRowValues(materializeReflection(write.reflection)),
    );
  }

  // 判的是替换后的证据集合本身（不是条数）：第 4 条要看 role/quote/record_id 三件套。
  assertEvidenceRule(event, listSoulEventEvidence(db, eventId));
  return event;
}

/**
 * 子表 upsert 的公共流程：先证明事件存在（不留孤儿），再整行覆盖，回一条改写计数。
 * 计数恒为 1（SQLite 对 upsert 报 1）；给成对象是为了和本仓库其它写方法
 * 返回 { upserted } 的形态一致，将来要区分 insert/update 时不必改签名。
 */
function runChildUpsert(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  table: string,
  columns: readonly string[],
  row: { event_id: string },
  values: readonly SQLInputValue[],
): { upserted: number } {
  assertEventExists(db, row.event_id, table, tenant);
  upsertRow(db, table, columns, values);
  return { upserted: 1 };
}

/**
 * 聊天子表 upsert（整行覆盖）。典型用途：挖掘判据收紧后重写立场/情绪三项，
 * 而不是新增第二条 chat 行（event_id 是主键，一条事件只有一份聊天面）。
 * tenant 可选：给了就顺带校验事件属于该租户，不给只校验事件存在。
 */
export function upsertSoulEventChat(
  db: DatabaseSync,
  chat: SoulEventChatInsert,
  tenant?: CoreTenant,
): { upserted: number } {
  const row = materializeChat(chat);
  return runChildUpsert(db, tenant, "soul_event_chat", CHAT_COLUMNS, row, chatRowValues(row));
}

/** 行动子表 upsert（整行覆盖）。只存 args_digest，不存原始参数——密钥不进事件表。 */
export function upsertSoulEventAction(
  db: DatabaseSync,
  action: SoulEventActionInsert,
  tenant?: CoreTenant,
): { upserted: number } {
  const row = materializeAction(action);
  return runChildUpsert(db, tenant, "soul_event_action", ACTION_COLUMNS, row, actionRowValues(row));
}

/** 反思子表 upsert（整行覆盖）。verified_at 为 NULL 表示「只有认识、还没验证过」。 */
export function upsertSoulEventReflection(
  db: DatabaseSync,
  reflection: SoulEventReflectionInsert,
  tenant?: CoreTenant,
): { upserted: number } {
  const row = materializeReflection(reflection);
  return runChildUpsert(db, tenant, "soul_event_reflection", REFLECTION_COLUMNS, row, reflectionRowValues(row));
}

/**
 * 物理删除一条事件及其全部子行（证据 + 三张类型子表）。
 *
 * 为什么显式删子表而不靠 CASCADE：PRAGMA foreign_keys 默认 OFF（soul-event-ddl.ts 头部事实 1），
 * 靠 CASCADE 在生产会留下孤儿 event_id，正是 spec §5.3「0 孤儿」要拦的东西。
 * 先删子行再删父行在 FK ON 时同样合法，所以两条路径一套代码。
 *
 * 租户不对 → 一行不动（返回 deleted:0），并且不去删子行：
 * event_id 是全局主键，允许「别的事件的子行」被当前租户的删除动作带走才是真事故。
 */
export function deleteSoulEvent(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  eventId: string,
): { deleted: number } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = deleteSoulEventInTransaction(db, tenant, eventId);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已在回滚态 */
    }
    throw err;
  }
}

/**
 * 事务内的物理删除：不自带 BEGIN，供 commitSoulEpisodes 清理重切后不再存在的行动子事件。
 *
 * 语义与 deleteSoulEvent 完全一致（先证明归属、再删四张子表、最后删基表）；
 * 拆出来只是为了让调用方复用它已经握着的事务，而不是在事务里再开一层。
 */
export function deleteSoulEventInTransaction(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  eventId: string,
): { deleted: number } {
  const t = normalizeCoreTenant(tenant);
  const owned = db
    .prepare("SELECT 1 AS one FROM soul_events WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(eventId, t.teamId, t.userId, t.agentId) as { one?: number } | undefined;
  if (!owned) return { deleted: 0 };
  for (const table of ["soul_event_evidence", "soul_event_chat", "soul_event_action", "soul_event_reflection"]) {
    db.prepare(`DELETE FROM ${table} WHERE event_id = ?`).run(eventId);
  }
  const info = db
    .prepare("DELETE FROM soul_events WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .run(eventId, t.teamId, t.userId, t.agentId);
  return { deleted: Number(info.changes ?? 0) };
}

// ─────────────────────────────── 读 ───────────────────────────────

/**
 * 列表过滤条件。at 区间是左闭右开（at >= atFrom 且 at < atTo）：
 * 按天翻页时 atTo 直接用下一天零点，不会出现两条时间戳相等的行跨页重复。
 *
 * 两个「按人」的过滤语义不同，别混：
 *  - personKey → actor_person_key：谁做的这件事（user/third 才有值，self 不填）。
 *  - presentPersonKey → persons_json：谁在场（在场自然人名单，包含即命中）。
 */
export interface SoulEventListFilter {
  /** at >= 该时刻。 */
  atFrom?: string;
  /** at < 该时刻。 */
  atTo?: string;
  /** 动作词（said/asked/committed…，开放集合）。 */
  action?: string;
  actor?: SoulEventActor | readonly SoulEventActor[];
  status?: SoulEventStatus | readonly SoulEventStatus[];
  sourceKind?: SoulEventSourceKind | readonly SoulEventSourceKind[];
  /** 谁做的（actor_person_key 精确匹配）。 */
  personKey?: string;
  /** 谁在场（persons_json 里包含该 person_key）。 */
  presentPersonKey?: string;
  sessionId?: string;
  /** 只取某条消息级事件的子事件。 */
  parentEventId?: string;
  /** 是否连已归档的一起读（默认不读归档）。 */
  includeArchived?: boolean;
  /** 时间方向，默认 desc（最新在前）。 */
  order?: "asc" | "desc";
  /** 页大小，默认 50，上限 500。 */
  limit?: number;
  offset?: number;
}

/** 计数用的过滤条件：limit/offset/order 对计数无意义，单独标出来免得调用方以为能分页计数。 */
export type SoulEventFilterCountable = Omit<SoulEventListFilter, "limit" | "offset" | "order">;

/** 拼 WHERE：全部参数化；数组型过滤为空时用 matchesNothing 短路成「零结果」，不生成非法 IN ()。 */
function buildEventWhere(
  t: CoreTenant,
  filter: SoulEventListFilter = {},
): { where: string; params: SQLInputValue[]; matchesNothing: boolean } {
  const clauses: string[] = ["team_id = ?", "user_id = ?", "agent_id = ?"];
  const params: SQLInputValue[] = [t.teamId, t.userId, t.agentId];

  if (filter.atFrom !== undefined) {
    clauses.push("at >= ?");
    params.push(filter.atFrom);
  }
  if (filter.atTo !== undefined) {
    clauses.push("at < ?");
    params.push(filter.atTo);
  }
  if (filter.action !== undefined) {
    clauses.push("action = ?");
    params.push(filter.action);
  }
  if (filter.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.parentEventId !== undefined) {
    clauses.push("parent_event_id = ?");
    params.push(filter.parentEventId);
  }
  if (filter.personKey !== undefined) {
    clauses.push("actor_person_key = ?");
    params.push(filter.personKey);
  }
  if (filter.presentPersonKey !== undefined) {
    // JSON1 的 json_each 是 SQLite 3.38+ 内置；persons_json 为 NULL 时 EXISTS 自然为假。
    clauses.push("EXISTS (SELECT 1 FROM json_each(soul_events.persons_json) WHERE value = ?)");
    params.push(filter.presentPersonKey);
  }
  if (filter.includeArchived !== true) clauses.push("archived_at IS NULL");

  const groups: ReadonlyArray<readonly [string, string | readonly string[] | undefined]> = [
    ["actor", filter.actor],
    ["status", filter.status],
    ["source_kind", filter.sourceKind],
  ];
  for (const [column, value] of groups) {
    if (value === undefined) continue;
    const list: readonly string[] = Array.isArray(value) ? (value as readonly string[]) : [value as string];
    if (list.length === 0) return { where: "", params: [], matchesNothing: true };
    clauses.push(`${column} IN (${list.map(() => "?").join(", ")})`);
    params.push(...list);
  }

  return { where: clauses.join(" AND "), params, matchesNothing: false };
}

/**
 * 读一条事件（基表行，租户内）。找不到或租户不符都返回 null——
 * 「不是你的」和「不存在」在调用方眼里应当同形，否则一个 id 就能拿来探测别的租户有没有这条事件。
 */
export function getSoulEvent(db: DatabaseSync, tenant: CoreTenant | undefined, eventId: string): SoulEventRow | null {
  const t = normalizeCoreTenant(tenant);
  const row = db
    .prepare("SELECT * FROM soul_events WHERE event_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?")
    .get(eventId, t.teamId, t.userId, t.agentId) as unknown as SoulEventRow | undefined;
  return row ?? null;
}

/** 一条事件的完整投影：基表 + 三张子表（各至多一行）+ 全部证据。 */
export interface SoulEventDetail {
  event: SoulEventRow;
  chat: SoulEventChatRow | null;
  action: SoulEventActionResultRow | null;
  reflection: SoulEventReflectionRow | null;
  evidence: SoulEventEvidenceRow[];
}

/**
 * 读一条事件连同它的子表与证据。
 * 与 getSoulEvent 分开的理由：列表/计数只要基表行（多三条 SELECT 是白付），卡与详情页才需要拼装。
 */
export function getSoulEventDetail(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  eventId: string,
): SoulEventDetail | null {
  const event = getSoulEvent(db, tenant, eventId);
  if (!event) return null;
  const chat = db.prepare("SELECT * FROM soul_event_chat WHERE event_id = ?").get(eventId) as unknown as
    SoulEventChatRow | undefined;
  const action = db.prepare("SELECT * FROM soul_event_action WHERE event_id = ?").get(eventId) as unknown as
    SoulEventActionResultRow | undefined;
  const reflection = db.prepare("SELECT * FROM soul_event_reflection WHERE event_id = ?").get(eventId) as unknown as
    SoulEventReflectionRow | undefined;
  return {
    event,
    chat: chat ?? null,
    action: action ?? null,
    reflection: reflection ?? null,
    evidence: listSoulEventEvidence(db, eventId),
  };
}

/** 按租户+条件列事件，最新在前（同 at 用 event_id 兜底排序，保证分页稳定）。 */
export function listSoulEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  filter?: SoulEventListFilter,
): SoulEventRow[] {
  const t = normalizeCoreTenant(tenant);
  const { where, params, matchesNothing } = buildEventWhere(t, filter);
  if (matchesNothing) return [];
  const dir = filter?.order === "asc" ? "ASC" : "DESC";
  const offsetRaw = filter?.offset ?? 0;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
  const rows = db
    .prepare(`SELECT * FROM soul_events WHERE ${where} ORDER BY at ${dir}, event_id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, clampLimit(filter?.limit), offset) as unknown as SoulEventRow[];
  return rows;
}

/** 同 listSoulEvents 的条件计数（忽略 limit/offset/order）。 */
export function countSoulEvents(
  db: DatabaseSync,
  tenant: CoreTenant | undefined,
  filter?: SoulEventFilterCountable,
): number {
  const t = normalizeCoreTenant(tenant);
  const { where, params, matchesNothing } = buildEventWhere(t, filter);
  if (matchesNothing) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM soul_events WHERE ${where}`).get(...params) as
    { n?: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 一条事件的证据（按 at、record_id、role 排序，稳定可 diff）。
 * 事件最多挂几十条证据，故默认不分页；需要截断时传 limit（同样受 500 上限约束）。
 */
export function listSoulEventEvidence(
  db: DatabaseSync,
  eventId: string,
  opts?: { limit?: number },
): SoulEventEvidenceRow[] {
  const base = "SELECT * FROM soul_event_evidence WHERE event_id = ? ORDER BY at ASC, record_id ASC, role ASC";
  if (opts?.limit === undefined) {
    return db.prepare(base).all(eventId) as unknown as SoulEventEvidenceRow[];
  }
  return db.prepare(`${base} LIMIT ?`).all(eventId, clampLimit(opts.limit)) as unknown as SoulEventEvidenceRow[];
}
