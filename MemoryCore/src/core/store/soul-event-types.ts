/**
 * 灵魂事件底座的行类型与写入入参类型（与 `soul-event-ddl.ts` 的列一一对应）。
 *
 * 用法：store 层读写都走这里的类型，禁止在调用处再写一遍字面量列名。
 * 字段一律保持 DDL 的 snake_case 命名——多一层 camelCase 映射就多一处漏字段的机会，
 * 而这张底座表的每个字段都是判据输入。
 *
 * 三类约定：
 *  1. `*Id` / `*_id` 是软引用（DDL 里只有子表到 soul_events 有 FK）。指向还不存在的事件是允许的，
 *     但读侧要能容忍 NULL / 悬空——孤儿清理是后台任务的事，不是写入的前置条件。
 *  2. `*_json` 列在类型上是 `string`，存 JSON 文本；解析在 store 层做，不在类型层做。
 *     空集合写 '[]' / '{}'，只有「这个维度当时不存在」才写 NULL。
 *  3. 枚举列（actor/status/source_kind… ）既在 DDL 的 CHECK 里，也在下面的常量数组里。
 *     数组是给写入层与测试用的同一份真源：__tests__ 会拿数组逐个值去撞 CHECK。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.1–§4.10。
 */

/** 行类型 → 写入入参：有默认值的列与可空列都可以省略（省略即由 DDL 默认值/NULL 兜底）。 */
export type InsertOf<Row, OptionalKeys extends keyof Row> = Omit<Row, OptionalKeys> & Partial<Pick<Row, OptionalKeys>>;

// ─────────────────────────────── §4.1 事件基表 ───────────────────────────────

/** actor：谁做的。self=我，user=当前用户，third=第三方，tool=工具自身，system=系统。 */
export const SOUL_EVENT_ACTORS = ["self", "user", "third", "tool", "system"] as const;
export type SoulEventActor = (typeof SOUL_EVENT_ACTORS)[number];

/** status：这件事闭合了没有。unknown 是旧数据迁移过来的默认态（不以 done 假装记得）。 */
export const SOUL_EVENT_STATUSES = ["open", "done", "failed", "partial", "unknown"] as const;
export type SoulEventStatus = (typeof SOUL_EVENT_STATUSES)[number];

/** source_kind：证据从哪来。测试/提交/回滚必须独立分类，否则「我验证过」无法证伪。 */
export const SOUL_EVENT_SOURCE_KINDS = [
  "chat",
  "tool",
  "test",
  "commit",
  "rollback",
  "observation",
  "reflection",
  "system",
] as const;
export type SoulEventSourceKind = (typeof SOUL_EVENT_SOURCE_KINDS)[number];

/** ownership：这件事是我的、对方的、共同的，还是只是被我观察到的。 */
export const SOUL_EVENT_OWNERSHIPS = ["mine", "theirs", "joint", "observed"] as const;
export type SoulEventOwnership = (typeof SOUL_EVENT_OWNERSHIPS)[number];

/** epistemic：观察到的 / 推断的 / 假设的。没有证据的事件只能 inferred 且 confidence<=0.5。 */
export const SOUL_EVENT_EPISTEMICS = ["observed", "inferred", "assumed"] as const;
export type SoulEventEpistemic = (typeof SOUL_EVENT_EPISTEMICS)[number];

/** visibility：private 只进本人/代理自我，不进对用户的卡。 */
export const SOUL_EVENT_VISIBILITIES = ["shared", "private", "relationship"] as const;
export type SoulEventVisibility = (typeof SOUL_EVENT_VISIBILITIES)[number];

/** 表 soul_events：所有事件的公共事实。 */
export interface SoulEventRow {
  event_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  /** 事件发生时刻（ISO 文本）。 */
  at: string;
  /** 事件所属的日（YYYY-MM-DD），按租户时区切，供按天聚合。 */
  day: string;
  valid_from: string;
  valid_to: string | null;
  actor: SoulEventActor;
  /** 只对 actor=user/third 有效；self 不填。 */
  actor_person_key: string | null;
  action: string;
  object: string;
  intent: string;
  outcome: string;
  status: SoulEventStatus;
  source_kind: SoulEventSourceKind;
  /** L0 record_id / tool_call_id / commit sha。 */
  source_ref: string;
  ownership: SoulEventOwnership;
  epistemic: SoulEventEpistemic;
  confidence: number;
  visibility: SoulEventVisibility;
  session_id: string;
  /** 在场自然人 person_key 数组的 JSON 文本；NULL = 这条事件没有可识别的人。 */
  persons_json: string | null;
  /** 一条消息可产生多个事件，子事件挂到消息级事件上。 */
  parent_event_id: string | null;
  /** 去重键（全表唯一，非空时）。写入方必须把租户拼进去。 */
  dedupe_key: string | null;
  salience: number;
  created_at: string;
  archived_at: string | null;
}

export type SoulEventInsert = InsertOf<
  SoulEventRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "valid_to"
  | "actor_person_key"
  | "object"
  | "intent"
  | "outcome"
  | "status"
  | "source_ref"
  | "ownership"
  | "epistemic"
  | "confidence"
  | "visibility"
  | "session_id"
  | "persons_json"
  | "parent_event_id"
  | "dedupe_key"
  | "salience"
  | "archived_at"
>;

// ─────────────────────────────── §4.2 证据表 ───────────────────────────────

/** role：这条证据在原文里是谁说的话。 */
export const SOUL_EVIDENCE_ROLES = ["user", "assistant", "tool", "system", "unknown"] as const;
export type SoulEvidenceRole = (typeof SOUL_EVIDENCE_ROLES)[number];

/** 表 soul_event_evidence：事件与 L0/工具结果的证据关系（一条事件至少一条）。 */
export interface SoulEventEvidenceRow {
  event_id: string;
  record_id: string;
  role: SoulEvidenceRole;
  /** 逐字引文。旧数据没有引文时是空串，此时事件只能标 inferred。 */
  quote: string;
  at: string;
  confidence: number;
}

export type SoulEventEvidenceInsert = InsertOf<SoulEventEvidenceRow, "quote" | "confidence">;

// ─────────────────────────────── §4.3 类型子表 ───────────────────────────────

/** 表 soul_event_chat：聊天事件专用字段（kind 是开放词表，迁移自 episode.kind）。 */
export interface SoulEventChatRow {
  event_id: string;
  /** 开放词表（模型给的类别），不在 CHECK 里锁死。 */
  kind: string;
  title: string;
  user_stance: string;
  agent_stance: string;
  cost: string;
  valence: number;
  arousal: number;
  intensity: number;
  affect_source: string;
  quote_json: string | null;
  signals_json: string | null;
  layers_json: string | null;
  /** 心境积分水位（处理时刻，不是事件时刻——用事件时刻会把迟到事件永久饿死）。 */
  mood_integrated_at: string | null;
}

export type SoulEventChatInsert = InsertOf<
  SoulEventChatRow,
  | "title"
  | "user_stance"
  | "agent_stance"
  | "cost"
  | "valence"
  | "arousal"
  | "intensity"
  | "affect_source"
  | "quote_json"
  | "signals_json"
  | "layers_json"
  | "mood_integrated_at"
>;

/** result_status：行动的结果。unknown 不是 fail——没验证过不等于失败。 */
export const SOUL_ACTION_STATUSES = ["success", "fail", "partial", "unknown"] as const;
export type SoulActionStatus = (typeof SOUL_ACTION_STATUSES)[number];

/** 表 soul_event_action：行动事件专用字段。只存 args_digest，不存原始参数。 */
export interface SoulEventActionResultRow {
  event_id: string;
  tool: string;
  tool_call_id: string | null;
  /** 参数的摘要（不存原文，避免密钥/隐私进事件表）。 */
  args_digest: string | null;
  result_status: SoulActionStatus;
  duration_ms: number | null;
  /** 报告 / 提交 sha / 产出文件路径。 */
  artifact_ref: string | null;
  error_code: string | null;
  environment: string | null;
  /** 谁验的（自查 / 用户 / 门禁作业）。 */
  verified_by: string | null;
}

export type SoulEventActionInsert = InsertOf<
  SoulEventActionResultRow,
  | "tool_call_id"
  | "args_digest"
  | "result_status"
  | "duration_ms"
  | "artifact_ref"
  | "error_code"
  | "environment"
  | "verified_by"
>;

/** 表 soul_event_reflection：反思事件专用字段。 */
export interface SoulEventReflectionRow {
  event_id: string;
  /** 它在反思哪些事件（event_id 数组 JSON）。 */
  about_event_ids_json: string;
  /** 结论本身。 */
  lesson: string;
  /** 行为上要改什么；空串 = 只有认识没有改动。 */
  behavior_change: string;
  /** 改动被验证的时刻；NULL = 还没被验证，只是一句话。 */
  verified_at: string | null;
  confidence: number;
}

export type SoulEventReflectionInsert = InsertOf<
  SoulEventReflectionRow,
  "about_event_ids_json" | "behavior_change" | "verified_at" | "confidence"
>;

// ─────────────────────────────── §4.4 关系 ───────────────────────────────

/** 关系事实状态：active / ended（有效期结束）/ disputed（有反证）。 */
export const SOUL_RELATION_STATUSES = ["active", "ended", "disputed"] as const;
export type SoulRelationStatus = (typeof SOUL_RELATION_STATUSES)[number];

/** 关系事实时态：present=现在还成立，past=曾经。 */
export const SOUL_RELATION_TENSES = ["present", "past"] as const;
export type SoulRelationTense = (typeof SOUL_RELATION_TENSES)[number];

/** §4.4 给既有 soul_person_relation 加的列（ALTER，不是新表）。 */
export interface SoulPersonRelationEventColumns {
  event_id: string | null;
  status: SoulRelationStatus;
  tense: SoulRelationTense;
  confidence: number;
  visibility: string;
  ended_by_event_id: string | null;
}

/** 表 soul_person_state：连续关系状态（我对某人在此刻的四个数值轴 + 两个开放结构）。 */
export interface SoulPersonStateRow {
  person_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  trust: number;
  affinity: number;
  respect: number;
  obligation: number;
  /** 边界条款（JSON 对象）。 */
  boundaries_json: string;
  /** 对方模型（JSON 对象）。 */
  model_json: string;
  last_interaction_at: string | null;
  evidence_event_ids_json: string;
  confidence: number;
  updated_at: string;
}

export type SoulPersonStateInsert = InsertOf<
  SoulPersonStateRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "trust"
  | "affinity"
  | "respect"
  | "obligation"
  | "boundaries_json"
  | "model_json"
  | "last_interaction_at"
  | "evidence_event_ids_json"
  | "confidence"
  | "updated_at"
>;

/** 表 soul_person_state_events：状态变化审计（旧值 → 新值 + 原因）。 */
export interface SoulPersonStateEventRow {
  id: string;
  person_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  event_id: string | null;
  /** 变的是哪一轴：trust / affinity / respect / obligation。 */
  field: string;
  old_value: number | null;
  new_value: number | null;
  reason: string;
  at: string;
}

export type SoulPersonStateEventInsert = InsertOf<
  SoulPersonStateEventRow,
  "event_id" | "old_value" | "new_value" | "reason"
>;

// ─────────────────────────────── §4.5 目标 ───────────────────────────────

/** owner：用户要求(user) / 我答应或共同(joint) / 我自己想做(self)。 */
export const SOUL_GOAL_OWNERS = ["self", "user", "joint"] as const;
export type SoulGoalOwner = (typeof SOUL_GOAL_OWNERS)[number];

/** kind：愿望 / 承诺 / 计划 / 项目。 */
export const SOUL_GOAL_KINDS = ["desire", "commitment", "plan", "project"] as const;
export type SoulGoalKind = (typeof SOUL_GOAL_KINDS)[number];

/** status：active / blocked / done / abandoned（放弃要留 abandon_reason）。 */
export const SOUL_GOAL_STATUSES = ["active", "blocked", "done", "abandoned"] as const;
export type SoulGoalStatus = (typeof SOUL_GOAL_STATUSES)[number];

/** 表 soul_goals：目标（承诺是 goal 的一种，不是第二张表）。 */
export interface SoulGoalRow {
  goal_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  owner: SoulGoalOwner;
  kind: SoulGoalKind;
  title: string;
  /** 为什么有这个目标——没有 why 的目标退化成待办。 */
  why: string;
  status: SoulGoalStatus;
  priority: number;
  progress: number;
  due_at: string | null;
  parent_goal_id: string | null;
  source_event_id: string | null;
  /** 什么算完成（可判定的句子）。 */
  success_criteria: string;
  blocked_reason: string;
  abandon_reason: string;
  valid_from: string;
  valid_to: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export type SoulGoalInsert = InsertOf<
  SoulGoalRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "why"
  | "status"
  | "priority"
  | "progress"
  | "due_at"
  | "parent_goal_id"
  | "source_event_id"
  | "success_criteria"
  | "blocked_reason"
  | "abandon_reason"
  | "valid_to"
  | "confidence"
  | "created_at"
  | "updated_at"
>;

/** 表 soul_goal_events：目标状态机账本。 */
export interface SoulGoalEventRow {
  goal_id: string;
  event_id: string;
  /** created / status_changed / progress / due_changed …（开放词表）。 */
  change: string;
  from_status: string | null;
  to_status: string | null;
  note: string;
  at: string;
}

export type SoulGoalEventInsert = InsertOf<SoulGoalEventRow, "from_status" | "to_status" | "note">;

/** 表 soul_goal_deps：目标依赖（默认 kind='blocks'）。 */
export interface SoulGoalDepRow {
  goal_id: string;
  depends_on_goal_id: string;
  kind: string;
}

export type SoulGoalDepInsert = InsertOf<SoulGoalDepRow, "kind">;

// ─────────────────────────────── §4.6 自我模型与校准 ───────────────────────────────

/** kind：能力 / 错误模式 / 校准 / 偏好 / 边界。 */
export const SOUL_SELF_MODEL_KINDS = ["capability", "error_pattern", "calibration", "preference", "boundary"] as const;
export type SoulSelfModelKind = (typeof SOUL_SELF_MODEL_KINDS)[number];

/** status：active / probation（考察期）/ retired。退休不删行。 */
export const SOUL_SELF_MODEL_STATUSES = ["active", "probation", "retired"] as const;
export type SoulSelfModelStatus = (typeof SOUL_SELF_MODEL_STATUSES)[number];

/** 表 soul_self_model：可证伪的自我认识（必须带反例）。 */
export interface SoulSelfModelRow {
  id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  kind: SoulSelfModelKind;
  /** 作用域：global / task 类目 / 具体工具名。 */
  scope: string;
  statement: string;
  confidence: number;
  evidence_event_ids_json: string;
  counterexample_event_ids_json: string;
  status: SoulSelfModelStatus;
  last_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SoulSelfModelInsert = InsertOf<
  SoulSelfModelRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "scope"
  | "confidence"
  | "evidence_event_ids_json"
  | "counterexample_event_ids_json"
  | "status"
  | "last_confirmed_at"
  | "created_at"
  | "updated_at"
>;

/** 校准结果四态（与 soul_events.status 词表一致，便于对账）。 */
export const SOUL_CALIBRATION_OUTCOMES = ["success", "fail", "partial", "unknown"] as const;
export type SoulCalibrationOutcome = (typeof SOUL_CALIBRATION_OUTCOMES)[number];

/** 表 soul_calibration：预测把握度 vs 实际结果。 */
export interface SoulCalibrationRow {
  id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  /** 领域/任务类目。 */
  domain: string;
  predicted_confidence: number;
  actual_outcome: SoulCalibrationOutcome;
  event_id: string | null;
  at: string;
  /** 预测误差，由读侧算（predicted − 实际），写入时通常为 NULL。 */
  error: number | null;
  note: string;
}

export type SoulCalibrationInsert = InsertOf<
  SoulCalibrationRow,
  "team_id" | "user_id" | "agent_id" | "event_id" | "error" | "note"
>;

// ─────────────────────────────── §4.7 情绪与心境 ───────────────────────────────

/** 心境变化的三种来源：重评 / 自我调节 / 衰减。 */
export const SOUL_MOOD_EVENT_KINDS = ["appraisal", "regulation", "decay"] as const;
export type SoulMoodEventKind = (typeof SOUL_MOOD_EVENT_KINDS)[number];

/** 表 soul_mood_state：慢心境当前状态（按租户一行）。 */
export interface SoulMoodStateRow {
  team_id: string;
  user_id: string;
  agent_id: string;
  label: string;
  valence: number;
  arousal: number;
  intensity: number;
  /** 半衰期（小时），读侧按它算衰减，不在写侧改 intensity。 */
  half_life_hours: number;
  cause_event_ids_json: string;
  updated_at: string;
}

export type SoulMoodStateInsert = InsertOf<
  SoulMoodStateRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "label"
  | "valence"
  | "arousal"
  | "intensity"
  | "half_life_hours"
  | "cause_event_ids_json"
  | "updated_at"
>;

/** 表 soul_mood_events：心境变化审计。 */
export interface SoulMoodEventRow {
  id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  at: string;
  kind: SoulMoodEventKind;
  label: string | null;
  delta_valence: number;
  delta_arousal: number;
  delta_intensity: number;
  cause_event_ids_json: string;
  note: string;
}

export type SoulMoodEventInsert = InsertOf<
  SoulMoodEventRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "label"
  | "delta_valence"
  | "delta_arousal"
  | "delta_intensity"
  | "cause_event_ids_json"
  | "note"
>;

/** §4.7 给既有 soul_emotions 加的列（ALTER）。 */
export interface SoulEmotionEventColumns {
  event_id: string | null;
  goal_id: string | null;
  dimensions_json: string | null;
}

// ─────────────────────────────── §4.8 叙事 ───────────────────────────────

/** 章节状态：active / superseded（旧版本保留，不覆盖）。 */
export const SOUL_NARRATIVE_STATUSES = ["active", "superseded"] as const;
export type SoulNarrativeStatus = (typeof SOUL_NARRATIVE_STATUSES)[number];

/** 表 soul_narrative：自传章节。 */
export interface SoulNarrativeRow {
  chapter_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  period_start: string;
  period_end: string;
  title: string;
  summary: string;
  turning_points_json: string;
  lessons_json: string;
  version: number;
  /** 内容 hash：同一批重跑不产生新版本。 */
  hash: string;
  supersedes_id: string | null;
  status: SoulNarrativeStatus;
  created_at: string;
}

export type SoulNarrativeInsert = InsertOf<
  SoulNarrativeRow,
  "team_id" | "user_id" | "agent_id" | "turning_points_json" | "lessons_json" | "version" | "supersedes_id" | "status"
>;

/** 表 soul_narrative_evidence：章节的证据关系。 */
export interface SoulNarrativeEvidenceRow {
  chapter_id: string;
  event_id: string;
  role: string;
}

export type SoulNarrativeEvidenceInsert = InsertOf<SoulNarrativeEvidenceRow, "role">;

// ─────────────────────────────── §4.9 价值与 gate ───────────────────────────────

/** 价值来源：我说过的 / 做出来被看到的 / 推出来的。 */
export const SOUL_VALUE_SOURCES = ["declared", "observed", "derived"] as const;
export type SoulValueSource = (typeof SOUL_VALUE_SOURCES)[number];

/** 价值状态：active / retired。 */
export const SOUL_VALUE_STATUSES = ["active", "retired"] as const;
export type SoulValueStatus = (typeof SOUL_VALUE_STATUSES)[number];

/** 表 soul_values：价值条目。 */
export interface SoulValueRow {
  value_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  statement: string;
  priority: number;
  source: SoulValueSource;
  evidence_event_ids_json: string;
  status: SoulValueStatus;
  created_at: string;
  updated_at: string;
}

export type SoulValueInsert = InsertOf<
  SoulValueRow,
  | "team_id"
  | "user_id"
  | "agent_id"
  | "priority"
  | "source"
  | "evidence_event_ids_json"
  | "status"
  | "created_at"
  | "updated_at"
>;

/** gate 阶段：生成 / 行动 / 输出。 */
export const SOUL_GATE_STAGES = ["generation", "action", "output"] as const;
export type SoulGateStage = (typeof SOUL_GATE_STAGES)[number];

/** gate 判定：放行 / 拦下 / 改写 / 问人。 */
export const SOUL_GATE_DECISIONS = ["allow", "deny", "rewrite", "ask"] as const;
export type SoulGateDecision = (typeof SOUL_GATE_DECISIONS)[number];

/** 表 soul_gate_log：红线 gate 审计（存摘要不存原文）。 */
export interface SoulGateLogRow {
  id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  at: string;
  stage: SoulGateStage;
  action_digest: string;
  rule_id: string | null;
  decision: SoulGateDecision;
  reason: string;
  event_id: string | null;
  confidence: number;
}

export type SoulGateLogInsert = InsertOf<
  SoulGateLogRow,
  "team_id" | "user_id" | "agent_id" | "rule_id" | "reason" | "event_id" | "confidence"
>;

/** 表 soul_dilemma：两难与事后回看。 */
export interface SoulDilemmaRow {
  id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  at: string;
  /** 冲突结构（JSON：两边各是什么、各让什么）。 */
  conflict_json: string;
  choice: string;
  reason: string;
  regret: number;
  outcome_event_id: string | null;
  /** 回看「选对了没」的时点。 */
  review_at: string | null;
}

export type SoulDilemmaInsert = InsertOf<
  SoulDilemmaRow,
  "team_id" | "user_id" | "agent_id" | "regret" | "outcome_event_id" | "review_at"
>;

// ─────────────────────────────── §4.10 投影与迁移元数据 ───────────────────────────────

/** 表 soul_working_state：每轮 working 锚（短期工作记忆，不是事实源）。 */
export interface SoulWorkingStateRow {
  team_id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  current_goal_id: string | null;
  current_focus: string;
  open_questions_json: string;
  updated_at: string;
  expires_at: string | null;
}

/**
 * 写入型：没有默认值的列（数值/时间）必须给，其余可省。
 * current_goal_id / session_id 都有默认值或可空语义，按需覆盖。
 */
export type SoulWorkingStateUpsert = InsertOf<
  SoulWorkingStateRow,
  "team_id" | "user_id" | "agent_id" | "session_id" | "current_goal_id" | "open_questions_json" | "expires_at"
>;

/** 表 soul_schema_migrations：已应用的 schema 版本（迁移执行器写，业务只读）。 */
export interface SoulSchemaMigrationRow {
  version: number;
  name: string;
  applied_at: string;
  /** DDL 的 checksum，用来发现「库里结构与代码不一致」。 */
  checksum: string;
}

export type SoulSchemaMigrationInsert = SoulSchemaMigrationRow;

/** §4.10 给既有 soul_persona 加的列（让它退成只读投影）。 */
export interface SoulPersonaProjectionColumns {
  confidence: number;
  epistemic: string;
  source_event_ids_json: string | null;
  projection_version: string | null;
  valid_from: string | null;
  valid_to: string | null;
}
