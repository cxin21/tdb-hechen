/**
 * 灵魂事件底座建表语句（P0-A，单一事实源）。
 *
 * 为什么单独一个文件：和 `soul-person-ddl.ts` 同一个理由——建表有两个消费者
 * （`VectorStore.init()` 与迁移/对账脚本），两处手抄 DDL 必然漂移（列名/默认值一边改一边忘），
 * 所以只留一份，双方 import。本文件不 import 任何运行时依赖，可被脚本安全加载（不触发 sqlite-vec）。
 *
 * 设计文档：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.1–§4.10。
 * 本文件只建表、加列、建索引；不写数据、不做迁移映射（§5 的旧数据搬运在写入侧脚本里）。
 *
 * SQLite 事实（本机 node:sqlite / SQLite 3.51.2 内存库实测，见 __tests__/soul-event-ddl.test.ts）：
 *  1. `CREATE TABLE` 里的 FOREIGN KEY 只在 `PRAGMA foreign_keys=ON` 时生效；默认 OFF 时
 *     ON DELETE CASCADE 是死约束——建表不报错、删父行不级联。写入侧必须显式开（测试里显式开）。
 *  2. `ALTER TABLE ... ADD COLUMN` 允许带 `NOT NULL DEFAULT <常量>` 与 CHECK（本驱动可执行）；
 *     不允许 PRIMARY KEY / UNIQUE，默认值也不允许 CURRENT_TIMESTAMP 或括号表达式。
 *  3. `ALTER TABLE ... ADD COLUMN ... REFERENCES`（带外键）要求该列默认为 NULL；写成
 *     `NOT NULL DEFAULT ''` 时任何插入都会因 '' 不是父表有效键而 FOREIGN KEY constraint failed。
 *     所以本文件 ALTER 出来的 event_id / goal_id 一律不带 REFERENCES——它们是软引用，
 *     是否指向真实事件由写入层校验（delete 时需显式清理孤儿）。
 *  4. 重复 ADD COLUMN 报 `duplicate column name`；执行侧只吞这一种（sqlite.ts 既有惯例），
 *     其它错误必须冒泡——把真错当「已迁移」会让水位静默不落。
 *  5. 索引统一 `CREATE ... INDEX IF NOT EXISTS`，与建表一起幂等重入。
 *
 * 约定：`*_json` 列一律存 JSON 文本（数组/对象），读侧 JSON.parse；空集合存 '[]' / '{}' 而不是 NULL，
 * 只有「这个维度当时不存在」才写 NULL（例如 soul_episodes.persons_json 的既有语义）。
 */

// ─────────────────────────────── §4.1 事件基表 ───────────────────────────────

/**
 * 所有事件的公共事实。actor/status/source_kind/ownership/epistemic/visibility 的枚举写在
 * CHECK 里——类型不变量靠表约束表达，不靠一层层 if。
 *
 * 特殊约定（spec §4.1）：
 *  - event_id 对聊天事件沿用 episode_id，旧引用不断；新行动事件用 `evt-` 前缀。
 *  - 一条消息可产生多个事件，子事件用 parent_event_id 挂到消息级事件（本列不加 FK：
 *    消息级事件与子事件在同一次写入里落库，自引用 FK 会让写入顺序变成强约束）。
 *  - source_ref 存 L0 record_id / tool_call_id / commit sha。
 *  - actor_person_key 只对 user/third 有效，self 不填。
 *  - visibility=private 的事件只进本人/代理自我，不进对用户的卡。
 */
export const SOUL_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_events (
  event_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('self','user','third','tool','system')),
  actor_person_key TEXT,
  action TEXT NOT NULL,
  object TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('open','done','failed','partial','unknown')),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('chat','tool','test','commit','rollback','observation','reflection','system')),
  source_ref TEXT NOT NULL DEFAULT '',
  ownership TEXT NOT NULL DEFAULT 'observed'
    CHECK (ownership IN ('mine','theirs','joint','observed')),
  epistemic TEXT NOT NULL DEFAULT 'observed'
    CHECK (epistemic IN ('observed','inferred','assumed')),
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  visibility TEXT NOT NULL DEFAULT 'shared'
    CHECK (visibility IN ('shared','private','relationship')),
  session_id TEXT NOT NULL DEFAULT '',
  persons_json TEXT,
  parent_event_id TEXT,
  dedupe_key TEXT,
  salience REAL NOT NULL DEFAULT 0.5
    CHECK (salience >= 0 AND salience <= 1),
  created_at TEXT NOT NULL,
  archived_at TEXT
)`;

/**
 * 按租户+时间扫事件：卡与面板的「最近发生了什么」都走这条。
 * 本仓库的 tenant = (team_id, user_id, agent_id) 三元组（与 soul_episodes / soul_persona 一致），
 * spec 里的「tenant+at」按这个三元组落列。
 */
export const SOUL_EVENTS_TENANT_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_events_tenant_at ON soul_events(team_id, user_id, agent_id, at)";

/** 「我做过什么 / 用户说过什么」：按 actor 过滤再按时间排序。 */
export const SOUL_EVENTS_TENANT_ACTOR_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_events_tenant_actor_at ON soul_events(team_id, user_id, agent_id, actor, at)";

/** 「最近的行动事件」：action 是开放集合（said/asked/committed…），索引只为收窄扫描。 */
export const SOUL_EVENTS_TENANT_ACTION_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_events_tenant_action_at ON soul_events(team_id, user_id, agent_id, action, at)";

/** 「最近的测试/提交/回滚」：行动证据按 source_kind 分类读。 */
export const SOUL_EVENTS_TENANT_SOURCE_KIND_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_events_tenant_source_kind_at ON soul_events(team_id, user_id, agent_id, source_kind, at)";

/** 「没做完的目标」「失败的尝试」：按 status 收未闭合事件。 */
export const SOUL_EVENTS_TENANT_STATUS_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_events_tenant_status_at ON soul_events(team_id, user_id, agent_id, status, at)";

/**
 * 去重键 partial 唯一索引（spec §4.1「dedupe_key 唯一（非空时）」）。两个条件缺一不可：
 *  ① IS NOT NULL —— SQL 里 NULL != NULL，无去重键的事件（行动事件常常没有）必须能共存；
 *  ② <> '' —— 本仓库空串是「没填」的写法（TEXT NOT NULL DEFAULT ''），空串不是键。
 * 注意：唯一性是全表级的（按 spec），所以写入方必须把租户拼进 dedupe_key（如 `${team}:${hash}`），
 * 否则两个租户的同内容事件会撞索引。
 */
export const SOUL_EVENTS_DEDUPE_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_soul_events_dedupe_key
  ON soul_events(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND dedupe_key <> ''`;

// ─────────────────────────────── §4.2 证据表 ───────────────────────────────

/**
 * 事件与 L0/工具结果的证据关系。每条事件至少一条证据；没有证据的事件只能标
 * epistemic=inferred 且 confidence<=0.5，并在卡上显示「推测」——这条是写入层的准入判据，
 * 表结构只保证「证据行长得对」。
 */
export const SOUL_EVENT_EVIDENCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_event_evidence (
  event_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system','unknown')),
  quote TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (event_id, record_id, role),
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
)`;

/** 反向查：「这条 L0 记录被哪些事件引用」，删 L0 前要看它撑着哪些事实。 */
export const SOUL_EVENT_EVIDENCE_RECORD_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_event_evidence_record ON soul_event_evidence(record_id)";

// spec §4.2 还列了「event_id」索引：证据表主键最左列就是 event_id，按 event_id 查走 PK 前缀，
// 单独再建一条同前缀索引只会多一份写放大（实测 PRAGMA index_list 里两者等价），故不建。

// ─────────────────────────────── §4.3 类型子表 ───────────────────────────────

/**
 * 聊天事件专用字段。kind 沿用 episode 的开放词表（不在 CHECK 里锁死：旧数据是模型给的开放集合），
 * 情绪三项是「这件事当时把我推到哪」，mood_integrated_at 是心境积分水位（迟到事件不被永久饿死）。
 */
export const SOUL_EVENT_CHAT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_event_chat (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  user_stance TEXT NOT NULL DEFAULT '',
  agent_stance TEXT NOT NULL DEFAULT '',
  cost TEXT NOT NULL DEFAULT '',
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  intensity REAL NOT NULL DEFAULT 0,
  affect_source TEXT NOT NULL DEFAULT 'lexicon',
  quote_json TEXT,
  signals_json TEXT,
  layers_json TEXT,
  mood_integrated_at TEXT,
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
)`;

/**
 * 行动事件专用字段。只存 args_digest，不存原始参数——密钥/隐私不许进事件表；
 * 测试、提交、回滚用 soul_events.source_kind 区分，artifact_ref 指向报告/提交/文件。
 */
export const SOUL_EVENT_ACTION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_event_action (
  event_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  tool_call_id TEXT,
  args_digest TEXT,
  result_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (result_status IN ('success','fail','partial','unknown')),
  duration_ms INTEGER,
  artifact_ref TEXT,
  error_code TEXT,
  environment TEXT,
  verified_by TEXT,
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
)`;

/** 反思事件专用字段：about_event_ids_json 指着它反思的那些事件，lesson 是结论本身。 */
export const SOUL_EVENT_REFLECTION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_event_reflection (
  event_id TEXT PRIMARY KEY,
  about_event_ids_json TEXT NOT NULL DEFAULT '[]',
  lesson TEXT NOT NULL,
  behavior_change TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
)`;

// ─────────────────────────────── §4.4 关系 ───────────────────────────────

/**
 * 连续关系状态：「我对某人此刻的信任/亲近/尊重/亏欠」。事实（谁—谓词—谁）在
 * soul_person_relation，连续状态在这里，两者不混。
 * boundaries_json / model_json 是开放结构（边界条款、对方模型），空对象默认，不塞 NULL。
 */
export const SOUL_PERSON_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_person_state (
  person_key TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  trust REAL NOT NULL DEFAULT 0.5 CHECK (trust >= 0 AND trust <= 1),
  affinity REAL NOT NULL DEFAULT 0.5 CHECK (affinity >= 0 AND affinity <= 1),
  respect REAL NOT NULL DEFAULT 0.5 CHECK (respect >= 0 AND respect <= 1),
  obligation REAL NOT NULL DEFAULT 0.5 CHECK (obligation >= 0 AND obligation <= 1),
  boundaries_json TEXT NOT NULL DEFAULT '{}',
  model_json TEXT NOT NULL DEFAULT '{}',
  last_interaction_at TEXT,
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_key, team_id, user_id, agent_id)
)`;

/**
 * 状态变化审计：每次 trust/affinity/... 变化都留旧值、新值、原因。
 * old_value/new_value 用 REAL 而不是 JSON——这一层只审计数值轴；
 * 边界条款/model 的变化走 soul_event_reflection 或 soul_ledger。
 */
export const SOUL_PERSON_STATE_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_person_state_events (
  id TEXT PRIMARY KEY,
  person_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  event_id TEXT,
  field TEXT NOT NULL,
  old_value REAL,
  new_value REAL,
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
)`;

/** 按人查变化史（面板「我和他这段时间怎么变的」）。 */
export const SOUL_PERSON_STATE_EVENTS_PERSON_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_person_state_events_person ON soul_person_state_events(person_key, team_id, user_id, agent_id, at)";

// ─────────────────────────────── §4.5 目标 ───────────────────────────────

/**
 * 目标。owner 必须区分「用户要求(user)」「我答应(joint/self)」「我自己想做(self)」——
 * 没有这个区分，目标就退化成待办列表（spec §4.5 的结论）。
 * progress 与 priority 都是 0..1 的连续量；due_at 只对 commitment/plan 有意义，可为 NULL。
 */
export const SOUL_GOALS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_goals (
  goal_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  owner TEXT NOT NULL CHECK (owner IN ('self','user','joint')),
  kind TEXT NOT NULL CHECK (kind IN ('desire','commitment','plan','project')),
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','blocked','done','abandoned')),
  priority REAL NOT NULL DEFAULT 0.5 CHECK (priority >= 0 AND priority <= 1),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  due_at TEXT,
  parent_goal_id TEXT,
  source_event_id TEXT,
  success_criteria TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  abandon_reason TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** 目标状态机账本：每次变化留 from_status/to_status 与原因。 */
export const SOUL_GOAL_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_goal_events (
  goal_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  change TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (goal_id, event_id, change)
)`;

/** 目标依赖：depends_on_goal_id 没做完，goal_id 就卡着。kind 默认 'blocks'。 */
export const SOUL_GOAL_DEPS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_goal_deps (
  goal_id TEXT NOT NULL,
  depends_on_goal_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (goal_id, depends_on_goal_id)
)`;

// ─────────────────────────────── §4.6 自我模型与校准 ───────────────────────────────

/**
 * 自我模型。statement 不是「我很严谨」这种自我表扬，而是可证伪的结构句：
 * 「我在 X 类任务上容易漏 Y，证据是 N 次失败；我现在的把握度是 0.6」。
 * counterexample_event_ids_json 必须留——只存支持证据的自我模型永远不会被推翻。
 */
export const SOUL_SELF_MODEL_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_self_model (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL CHECK (kind IN ('capability','error_pattern','calibration','preference','boundary')),
  scope TEXT NOT NULL DEFAULT 'global',
  statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  counterexample_event_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','probation','retired')),
  last_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/**
 * 校准：预测把握度 vs 实际结果。error 由读侧算（predicted − 实际），不在写入时拍；
 * 留着才有「过不过度自信」这个可计算的量。
 */
export const SOUL_CALIBRATION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_calibration (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  predicted_confidence REAL NOT NULL,
  actual_outcome TEXT NOT NULL
    CHECK (actual_outcome IN ('success','fail','partial','unknown')),
  event_id TEXT,
  at TEXT NOT NULL,
  error REAL,
  note TEXT NOT NULL DEFAULT ''
)`;

// ─────────────────────────────── §4.7 情绪与心境 ───────────────────────────────

/**
 * 慢心境：当前状态一行（按租户）。快情绪仍按事件一行在 soul_emotions；
 * 心境影响召回和判断，但不改写事实——重评要留原事件和重评事件两条。
 * half_life_hours 默认 48（ADR 口径）：两天回到基线一半，读侧按它算衰减，不在写侧改 intensity。
 */
export const SOUL_MOOD_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_mood_state (
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  label TEXT NOT NULL DEFAULT '平静',
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  intensity REAL NOT NULL DEFAULT 0,
  half_life_hours REAL NOT NULL DEFAULT 48,
  cause_event_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id, agent_id)
)`;

/** 心境变化审计：appraisal（重评）/regulation（自我调节）/decay（衰减）三类都要能回放。 */
export const SOUL_MOOD_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_mood_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('appraisal','regulation','decay')),
  label TEXT,
  delta_valence REAL NOT NULL DEFAULT 0,
  delta_arousal REAL NOT NULL DEFAULT 0,
  delta_intensity REAL NOT NULL DEFAULT 0,
  cause_event_ids_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT ''
)`;

/** 心境变化按租户+时间回放（面板曲线）。 */
export const SOUL_MOOD_EVENTS_TENANT_AT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_mood_events_tenant_at ON soul_mood_events(team_id, user_id, agent_id, at)";

// ─────────────────────────────── §4.8 叙事 ───────────────────────────────

/**
 * 自传不是事件列表，是章节。每章必须有证据（soul_narrative_evidence），不能补心理戏；
 * 同一时间段可以有多个版本：旧版本 status=superseded + supersedes_id 指向前一版，不覆盖。
 * hash 供「同一批重跑不产生新版本」的幂等判定。
 */
export const SOUL_NARRATIVE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_narrative (
  -- chapter_id 是全局主键（不是 per-tenant）：写侧必须带租户前缀（narrativeTenantTag），
  -- 否则同一周第二个租户的 INSERT OR IGNORE 会静默丢章，证据跟着一起丢。
  chapter_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  turning_points_json TEXT NOT NULL DEFAULT '[]',
  lessons_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  hash TEXT NOT NULL,
  supersedes_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded')),
  created_at TEXT NOT NULL,
  -- P6（2026-11-10）：显著度是写侧按证据算的底分，衰减在读侧按 period_end 算；
  -- access 只记「被注入取用过几次」，是唯一的记忆强化信号（没有强化就只有遗忘）。
  salience REAL NOT NULL DEFAULT 0.3,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  updated_at TEXT
)`;

/** 章节的证据关系。role 默认 'evidence'（可扩 counter_evidence 等）。 */
export const SOUL_NARRATIVE_EVIDENCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_narrative_evidence (
  chapter_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'evidence',
  PRIMARY KEY (chapter_id, event_id, role)
)`;

/**
 * 同一租户同一时段最多一条 active 章节（P6 验收的「同一时段不出现互相矛盾的 active 章节」）。
 *
 * 为什么不是只靠写入层：写入层的事务能保证同一次 tick 内不写两版，但挡不住重放/并发/手写
 * INSERT。这里用部分唯一索引把「同一时段两条 active」变成数据库层不可能——冲突时抛
 * UNIQUE constraint failed，写者再把旧版标 superseded 后重试。
 *
 * 存量库可能有重复 active（P6 之前没人写过这些行，生产实测 0 行）：建索引放在
 * VectorStore.init() 的 try/catch 里，失败只 warn，不让一条历史脏行搞崩进程。
 */
export const SOUL_NARRATIVE_ACTIVE_PERIOD_UNIQUE_INDEX_DDL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_soul_narrative_active_period ON soul_narrative(team_id, user_id, agent_id, period_start) WHERE status = 'active'";

// ─────────────────────────────── §4.9 价值与 gate ───────────────────────────────

/**
 * 价值：source 区分「我说过的(declared)」「做出来被看到的(observed)」「推出来的(derived)」——
 * 三者可信度不同，混在一起就会把推断当自述。退休用 status=retired，不删行。
 */
export const SOUL_VALUES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_values (
  value_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  statement TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.5 CHECK (priority >= 0 AND priority <= 1),
  source TEXT NOT NULL DEFAULT 'observed'
    CHECK (source IN ('declared','observed','derived')),
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/**
 * 红线 gate 审计：stage 分生成/行动/输出三段，decision 四态。
 * action_digest 存摘要不存原文（同 soul_event_action.args_digest）——审计要能对齐，
 * 但不把被拦下来的内容（可能含密钥）再抄一份进库。
 */
export const SOUL_GATE_LOG_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_gate_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('generation','action','output')),
  action_digest TEXT NOT NULL,
  rule_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','rewrite','ask')),
  reason TEXT NOT NULL DEFAULT '',
  event_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
)`;

/** 两难：冲突结构 + 当时的选择 + 理由 + 后悔度，review_at 是回看「选对了没」的时点。 */
export const SOUL_DILEMMA_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_dilemma (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  conflict_json TEXT NOT NULL,
  choice TEXT NOT NULL,
  reason TEXT NOT NULL,
  regret REAL NOT NULL DEFAULT 0 CHECK (regret >= 0 AND regret <= 1),
  outcome_event_id TEXT,
  review_at TEXT
)`;

// ─────────────────────────────── §4.10 投影与迁移元数据 ───────────────────────────────

/**
 * 每轮 working 锚：当前目标 / 当下焦点 / 没答完的问题。按会话一行，expires_at 过期即可丢。
 * 这张表是「短期工作记忆」，不承担任何事实职责——事实在 soul_events 与结构化表里。
 */
export const SOUL_WORKING_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_working_state (
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL DEFAULT '',
  current_goal_id TEXT,
  current_focus TEXT NOT NULL DEFAULT '',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (team_id, user_id, agent_id, session_id)
)`;

/**
 * 迁移元数据：已应用的 schema 版本 + checksum。checksum 让「DDL 与库里实际结构不一致」可发现，
 * 而不是等某条写入报错才发现。只由迁移执行器写，业务代码只读。
 */
export const SOUL_SCHEMA_MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
)`;

// ─────────────────────────────── 汇总 ───────────────────────────────

/**
 * 按顺序执行即可（基表 → 证据 → 类型子表 → 结构化表 → 索引）。
 * 顺序有讲究：证据/子表的 FK 指向 soul_events，SQLite 建表时不校验父表是否存在，
 * 但把父表放前面能让「建到一半失败」时的库仍可用（父表在、子表缺）。
 */
export const SOUL_EVENT_DDL: readonly string[] = [
  // §4.1
  SOUL_EVENTS_TABLE_DDL,
  SOUL_EVENTS_TENANT_AT_INDEX_DDL,
  SOUL_EVENTS_TENANT_ACTOR_AT_INDEX_DDL,
  SOUL_EVENTS_TENANT_ACTION_AT_INDEX_DDL,
  SOUL_EVENTS_TENANT_SOURCE_KIND_AT_INDEX_DDL,
  SOUL_EVENTS_TENANT_STATUS_AT_INDEX_DDL,
  SOUL_EVENTS_DEDUPE_INDEX_DDL,
  // §4.2
  SOUL_EVENT_EVIDENCE_TABLE_DDL,
  SOUL_EVENT_EVIDENCE_RECORD_INDEX_DDL,
  // §4.3
  SOUL_EVENT_CHAT_TABLE_DDL,
  SOUL_EVENT_ACTION_TABLE_DDL,
  SOUL_EVENT_REFLECTION_TABLE_DDL,
  // §4.4
  SOUL_PERSON_STATE_TABLE_DDL,
  SOUL_PERSON_STATE_EVENTS_TABLE_DDL,
  SOUL_PERSON_STATE_EVENTS_PERSON_INDEX_DDL,
  // §4.5
  SOUL_GOALS_TABLE_DDL,
  SOUL_GOAL_EVENTS_TABLE_DDL,
  SOUL_GOAL_DEPS_TABLE_DDL,
  // §4.6
  SOUL_SELF_MODEL_TABLE_DDL,
  SOUL_CALIBRATION_TABLE_DDL,
  // §4.7
  SOUL_MOOD_STATE_TABLE_DDL,
  SOUL_MOOD_EVENTS_TABLE_DDL,
  SOUL_MOOD_EVENTS_TENANT_AT_INDEX_DDL,
  // §4.8
  SOUL_NARRATIVE_TABLE_DDL,
  SOUL_NARRATIVE_EVIDENCE_TABLE_DDL,
  // §4.9
  SOUL_VALUES_TABLE_DDL,
  SOUL_GATE_LOG_TABLE_DDL,
  SOUL_DILEMMA_TABLE_DDL,
  // §4.10
  SOUL_WORKING_STATE_TABLE_DDL,
  SOUL_SCHEMA_MIGRATIONS_TABLE_DDL,
];

/**
 * 旧表加列（幂等迁移）。已存在的表不会因为 `CREATE TABLE IF NOT EXISTS` 补列，所以必须单独 ALTER；
 * 执行侧对「duplicate column name」按幂等吞掉，其它错误仍要冒泡（soul-person-ddl.ts 同一惯例）。
 *
 * ALTER 加列的 SQLite 限制（本机 3.51.2 内存库实测，见 __tests__/soul-event-ddl.test.ts）：
 *  - 可带 NOT NULL DEFAULT <常量> 与 CHECK，本驱动能执行；
 *  - 不能带 REFERENCES：加外键列要求默认值为 NULL，而这里的关系列要么有默认值要么会被写入层当软引用，
 *    所以 event_id / goal_id 都按软引用处理（写入层校验，孤儿由清理任务按租户扫）。
 *  - 带 CHECK 的加列不会回头校验存量行（存量行读到的是默认值，必然满足 CHECK）。
 */
export const SOUL_EVENT_MIGRATION_DDL: readonly string[] = [
  // §4.4 关系事实：谁—谓词—谁，带有效期和证据。event_id 指向产生这条边的那个事件。
  "ALTER TABLE soul_person_relation ADD COLUMN event_id TEXT",
  // P2（spec §10.8）：回指零命中/不唯一要标 unverifiable——四值。存量库的 CHECK 由
  // VectorStore.init() 里的 migrateSoulPersonRelationStatusEnum() 轻量重建扩容（SQLite 不能 ALTER CHECK）。
  "ALTER TABLE soul_person_relation ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','disputed','unverifiable'))",
  "ALTER TABLE soul_person_relation ADD COLUMN tense TEXT NOT NULL DEFAULT 'present' CHECK (tense IN ('present','past'))",
  "ALTER TABLE soul_person_relation ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5",
  "ALTER TABLE soul_person_relation ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'",
  "ALTER TABLE soul_person_relation ADD COLUMN ended_by_event_id TEXT",
  // §4.5 承诺是 goal 的一种：给旧表加外键，不复制一份。
  "ALTER TABLE soul_promises ADD COLUMN goal_id TEXT",
  // §4.7 快情绪：episode_id 逐步迁到 event_id，并挂目标。
  "ALTER TABLE soul_emotions ADD COLUMN event_id TEXT",
  "ALTER TABLE soul_emotions ADD COLUMN goal_id TEXT",
  "ALTER TABLE soul_emotions ADD COLUMN dimensions_json TEXT",
  // §4.10 soul_persona 退成只读投影：带置信度、认知来源、源事件与有效期。
  "ALTER TABLE soul_persona ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5",
  "ALTER TABLE soul_persona ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'inferred'",
  "ALTER TABLE soul_persona ADD COLUMN source_event_ids_json TEXT",
  "ALTER TABLE soul_persona ADD COLUMN projection_version TEXT",
  "ALTER TABLE soul_persona ADD COLUMN valid_from TEXT",
  "ALTER TABLE soul_persona ADD COLUMN valid_to TEXT",
  // §4.8 叙事：P6 补显著度/取用/更新时间。存量行 salience 取默认 0.3（低于注入门 0.35），
  // 即「老章不自动进注入口」——要进得靠新写的一版把证据与显著度一起算出来。
  "ALTER TABLE soul_narrative ADD COLUMN salience REAL NOT NULL DEFAULT 0.3",
  "ALTER TABLE soul_narrative ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE soul_narrative ADD COLUMN last_accessed_at TEXT",
  "ALTER TABLE soul_narrative ADD COLUMN updated_at TEXT",
];
