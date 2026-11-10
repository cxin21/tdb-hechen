# 灵魂系统完整优化方案：事件底座与人的闭环

状态：P0 已实施并完成生产迁移；P1-A（聊天事件切分 + 行动子事件落库）已实施、已部署生产并重启 core；P1-B（DSH 插件上报）与 P2–P7 未实施。
日期：2026-11-10。
范围：td-agemem 灵魂系统（MemoryCore + MemoryPanel + DSH 注入侧）。
目标：把「记录仪」改成「一个能持续回答我是谁、我经历过什么、我想做什么、我怎么看别人、我怎么知道自己做得对不对」的系统。

## 1. 结论

直接拆表。不再往 soul_episodes 继续加宽。
目标结构是「基表 + 类型子表 + 证据表」：

- soul_events：所有事件的公共事实。
- soul_event_chat / soul_event_action / soul_event_reflection：类型专用字段。
- soul_event_evidence：事件与 L0/工具结果的证据关系。
- 关系、目标、自我模型、情绪、叙事、价值各自独立建表，不再塞进 soul_persona。
- soul_persona 最终只做卡的只读投影，不作为可写事实源。

拆表不是一次性 rename。迁移按「新表 + 双写 + 对账 + 切读 + 旧表只读」五步走，保留回滚路径。

## 2. 设计原则

1. 单一事实源：一类事实只有一个可写表。事件写 soul_events，关系写 soul_person_relation，关系状态写 soul_person_state，目标写 soul_goals。
2. 事实与投影分离：soul_persona、卡、面板都是投影；投影可以重建，事实不能靠投影反推。
3. 所有事实带时间、归属、置信度：valid_from/valid_to、ownership、epistemic、confidence、source_kind、source_ref。
4. 类型不变量用表约束表达：聊天事件必须有 quote，行动事件必须有 tool/status；不用一张宽表加一堆 NULL。
5. 默认 fail-closed：卡没有显式 persons 时只给 self 层，不给人物和关系；解析不到 person_key 就省略，不静默回退展示名。
6. 迁移可回滚：旧表不删、不改语义；新表可停写；切读开关可回退。
7. 验收看行为，不看行数：跨会话记得承诺、被纠正后修复、压力下守红线、A 的秘密不说给 B。

## 3. 目标架构

写入路径：
L0 消息 / 工具调用 / 测试结果 / 提交回滚 / 用户纠正
  -> 事件归一化（actor/action/object/outcome/evidence）
  -> soul_events + 类型子表 + evidence
  -> 派生 worker（关系、目标、自我模型、情绪、叙事）
  -> soul_persona 投影 + card 快照

读取路径：
卡 / 面板 / 检索
  -> 读 soul_events 与结构化表
  -> 按 persons/scope 过滤
  -> 渲染稳定卡 + 每轮 working 锚

关键边界：soul_persona 只读；卡不直接读事件做临时推理；所有注入内容都能回指 event_id。

## 4. 数据模型

### 4.1 事件基表

```sql
CREATE TABLE IF NOT EXISTS soul_events (
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
);
```

索引：tenant+at、tenant+actor+at、tenant+action+at、tenant+source_kind+at、tenant+status+at、dedupe_key 唯一（非空时）。

约定：
- event_id 对聊天事件沿用 episode_id，保证旧引用不断；新行动事件用 evt- 前缀。
- 一条消息可产生多个事件，用 parent_event_id 挂到消息级事件。
- source_ref 存 L0 record_id / tool_call_id / commit sha。
- actor_person_key 只对 user/third 有效；self 不填。
- persons_json 是在场自然人 person_key 数组，可为 NULL（无可识别的人）。
- visibility=private 的事件只进本人/代理自我，不进对用户的卡。

### 4.2 证据表

```sql
CREATE TABLE IF NOT EXISTS soul_event_evidence (
  event_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system','unknown')),
  quote TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (event_id, record_id, role),
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
);
```

索引：record_id、event_id。有证据的事件至少一条；无证据的事件允许零证据，只能标 epistemic=inferred 且 confidence<=0.5，并在卡上显示「推测」；禁止用 legacy:episode:<id> 之类的合成 record_id 冒充 L0 引文。

**工具类事件的证据（P1-B，2026-11-10 落地）：** source_kind ∈ {tool, test, commit, rollback} 的事件，证据行 role="tool" 时 record_id 记的是 **tool_call_id**（工具调用标识），不是 L0 的 record_id——工具事件没有对应的记忆行，硬凑一个 L0 id 就是伪造引文。此时 quote 存工具输出的摘要（本面上限 400 字符，超长截断而非整条拒），record_id 与 quote 都必须非空，空串不算工具证据。

准入判据（叠加式，不改第 1 条）：带工具证据的工具类事件可以标 epistemic=observed，但 confidence 上限 0.9（>0.9 写入即拒，const `SOUL_TOOL_EVIDENCE_MAX_CONFIDENCE`）——工具自报的成功不占满分，留 0.1 给人工验收。「无证据只能 inferred 且 confidence<=0.5」这条原样不变：工具类事件拿不出工具证据时依然不能 observed。以上是 P1-B 的最小准入，更强的证据规则（例如要求真实 L0 引文）留待 §10 决策再收紧。

写入面：DSH 插件经 `POST /v3/soul/event` 上报（见 §10 决策 5），Core 侧按 dedupe_key 幂等落库；同一 dedupe_key 重放返回 `{event_id, duplicate:true}`，不重复写。

### 4.3 类型子表

```sql
CREATE TABLE IF NOT EXISTS soul_event_chat (
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
);

CREATE TABLE IF NOT EXISTS soul_event_action (
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
);

CREATE TABLE IF NOT EXISTS soul_event_reflection (
  event_id TEXT PRIMARY KEY,
  about_event_ids_json TEXT NOT NULL DEFAULT '[]',
  lesson TEXT NOT NULL,
  behavior_change TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  FOREIGN KEY (event_id) REFERENCES soul_events(event_id) ON DELETE CASCADE
);
```

行动事件只存 args_digest，不存原始参数，避免密钥/隐私进事件表。测试、提交、回滚都用 source_kind 区分，artifact_ref 指向报告、提交或文件。

### 4.4 关系

```sql
-- 关系事实：谁—谓词—谁，带有效期和证据。
ALTER TABLE soul_person_relation ADD COLUMN event_id TEXT;
ALTER TABLE soul_person_relation ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','ended','disputed'));
ALTER TABLE soul_person_relation ADD COLUMN tense TEXT NOT NULL DEFAULT 'present'
  CHECK (tense IN ('present','past'));
ALTER TABLE soul_person_relation ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE soul_person_relation ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE soul_person_relation ADD COLUMN ended_by_event_id TEXT;

-- 连续关系状态：信任/亲近/尊重/亏欠/边界/对方模型。
CREATE TABLE IF NOT EXISTS soul_person_state (
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
);

-- 状态变化审计：每次 trust/affinity/... 变化都留旧值、新值、原因。
CREATE TABLE IF NOT EXISTS soul_person_state_events (
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
);
```

关系事实和关系状态分开：谓词/方向/有效期是事实，trust/affinity 是连续状态。修复叙事不放 persona，放 soul_event_reflection 或 soul_narrative；soul_persona.relationship 只读投影。

### 4.5 目标

```sql
CREATE TABLE IF NOT EXISTS soul_goals (
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
);

CREATE TABLE IF NOT EXISTS soul_goal_events (
  goal_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  change TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (goal_id, event_id, change)
);

CREATE TABLE IF NOT EXISTS soul_goal_deps (
  goal_id TEXT NOT NULL,
  depends_on_goal_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (goal_id, depends_on_goal_id)
);

-- 承诺是 goal 的一种：给旧表加外键，不复制一份。
ALTER TABLE soul_promises ADD COLUMN goal_id TEXT;
```

owner 必须区分「用户要求」「我答应」「我自己想做」；没有这个区分，目标会退化成待办列表。

### 4.6 自我模型与校准

```sql
CREATE TABLE IF NOT EXISTS soul_self_model (
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
);

CREATE TABLE IF NOT EXISTS soul_calibration (
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
);
```

自我模型不是「我很严谨」这种句子，而是「我在 X 类任务上容易漏 Y，证据是 N 次失败；我现在的把握度是 0.6」。校准表记录预测和结果，才能算出过不过度自信。

### 4.7 情绪与心境

```sql
-- 快情绪：仍按事件一行；把 episode_id 逐步迁到 event_id，并挂目标。
ALTER TABLE soul_emotions ADD COLUMN event_id TEXT;
ALTER TABLE soul_emotions ADD COLUMN goal_id TEXT;
ALTER TABLE soul_emotions ADD COLUMN dimensions_json TEXT;

-- 慢心境：当前状态。
CREATE TABLE IF NOT EXISTS soul_mood_state (
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  label TEXT NOT NULL DEFAULT '平静',
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  intensity REAL NOT NULL DEFAULT 0,
  half_life_hours REAL NOT NULL DEFAULT 72,
  cause_event_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id, agent_id)
);

-- 心境变化审计：appraisal/regulation/decay。
CREATE TABLE IF NOT EXISTS soul_mood_events (
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
);
```

快情绪看单件事，慢心境看几天到几周。心境影响召回和判断，但不改写事实；重评要留原事件和重评事件两条。

### 4.8 叙事

```sql
CREATE TABLE IF NOT EXISTS soul_narrative (
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS soul_narrative_evidence (
  chapter_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'evidence',
  PRIMARY KEY (chapter_id, event_id, role)
);
```

自传不是事件列表，是章节。每章必须有证据，不能补心理戏；同一时间段可以有多个版本，旧版本 superseded，不覆盖。

### 4.9 价值与 gate

```sql
CREATE TABLE IF NOT EXISTS soul_values (
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
);

CREATE TABLE IF NOT EXISTS soul_gate_log (
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
);

CREATE TABLE IF NOT EXISTS soul_dilemma (
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
);
```

### 4.10 投影与迁移元数据

```sql
ALTER TABLE soul_persona ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE soul_persona ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'inferred';
ALTER TABLE soul_persona ADD COLUMN source_event_ids_json TEXT;
ALTER TABLE soul_persona ADD COLUMN projection_version TEXT;
ALTER TABLE soul_persona ADD COLUMN valid_from TEXT;
ALTER TABLE soul_persona ADD COLUMN valid_to TEXT;

CREATE TABLE IF NOT EXISTS soul_working_state (
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
);

CREATE TABLE IF NOT EXISTS soul_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
```

## 5. 迁移方案

### 5.1 旧数据映射

soul_episodes -> soul_events + soul_event_chat + soul_event_evidence：
- event_id = episode_id，保留旧引用。
- at/day、session_id、persons_json 直接复制。
- actor = 'user'，action = 'said'，object 原样复制（空就是空，不拿 title 冒充对象），intent = title，outcome = outcome，status = 'unknown'。
- source_kind = 'chat'，source_ref = quote.recordId，ownership = 'theirs'。有证据且至少一条 role∈{user,assistant} 且 quote 非空时 epistemic='observed'、confidence=0.8；否则 epistemic='inferred'、confidence=0.5，evidence 允许为空。
- 聊天字段进 soul_event_chat；evidence 按 evidence_json 展开，quote 从 quote_json 取；没有引文的老行 quote=''。
- soul_emotions.episode_id 复制到 event_id；旧列保留到切读完成。
- soul_person_relation.record_id 先当 L1 id 经 l1_records.source_message_ids 映射到 soul_event_evidence；不是 L1 id 或没有证据时，用 relation.quote 在 l0_conversations 按 tenant 精确匹配、再按唯一子串匹配到 L0，再走 evidence 索引；精确或唯一命中才写，多条命中或找不到都留 NULL，不猜，禁止用姓名或谓词推断。
- soul_promises 建对应 soul_goals（kind=commitment，owner=joint 或 self，status 按现态），回填 goal_id；promise.ref_key 按同一条 L0 引文解析 event_id，回填 soul_goals.source_event_id，解析不到留 NULL。

### 5.2 双写与切读

1. 新表建好，旧表不动。
2. 新写入只走 soul_events；同一事务双写一份到 soul_episodes，供旧读路径。
3. 对账任务按租户比较：事件数、chat 子表数、evidence 数、旧表行数、字段 hash、随机 100 行逐字段。
4. 对账为 0 后切读：store 方法读新表；旧表只写不读。
5. 再观察一个发布周期，停旧表写入；旧表只读保留，不删除。
6. 回滚：切读开关回 legacy；旧表还有完整数据。

### 5.3 验收

- 迁移幂等：同一批跑两次，行数不变。
- 事件覆盖：旧 episode 100% 有基表行和 chat 行；旧行自带 evidence_json 或 quote 的，新表 evidence 至少一条；无证据旧行零证据 + inferred。
- 字段 hash：旧新 chat 字段逐字段一致。
- 卡片回归：persons 未传时旧卡逐字节不变；传 persons 时只多关系/人物。
- 情绪/关系引用：0 孤儿 event_id。NULL 不算孤儿，但必须登记原因。
- 临时库先跑：D:/TDB/data/fulltest90/vectors.db；生产写前 VACUUM INTO 备份并核对字节数+sha256。
- P0 已知边界：soul_events 没有 participants 展示名列，new 读仍 LEFT JOIN 旧 soul_episodes.participants_json，join 不到整次回落 legacy；relation 4 条中 3 条因引文没有对应 event evidence 留 NULL；这些等 P1 事件切分和 P2 去旧表依赖补齐，不在迁移里猜。

## 6. 完整阶段

### P0 事件底座与拆表

交付：新表 DDL、迁移脚本、store 读写收口、双写对账、切读开关、兼容测试。
代码：MemoryCore/src/core/store/sqlite.ts、新增 soul-event-ddl.ts、soul-event-store.ts、episode.ts、worker.ts、card-service.ts 的读适配。
验收：迁移幂等；旧卡逐字节不变；有证据旧行 100% 有证据、无证据旧行零证据且 inferred；0 孤儿；双写对账 0 diff。
风险：SQLite 锁、500MB 库迁移时间；分批 + WAL + 临时库先跑。

### P1 感知与行动闭环

交付：一条消息 1–3 事件切分；POST /v3/soul/event 或内部 recordSoulEvent；DSH 插件上报工具调用/测试/提交/回滚；action 子表；事件查询。
规则：actor/action/object/intent/outcome/status/source_kind/source_ref/confidence 必填；工具只存 args_digest；失败/回滚也进事件。
验收：一次测试失败和一次修复都能回指；一条消息能切出两件事；事件覆盖 100%；工具事件 0 原始参数泄漏。
风险：抽取成本；确定性切分优先，模型只处理歧义；每消息最多 3 事件。

#### P1-A 已实施（聊天事件切分 + 行动子事件落库）

- 新增 MemoryCore/src/core/soul/event-splitter.ts：soulActionEventId、digestSoulActionArgs、buildSoulActionWrite、splitChatActionEvents；行动事件 id 为 act-<sha1 前 16>，args 只落 sha256 摘要。
- 切分证据只认 assistant 原话：episode.quote 在生产里几乎都是 user 侧，sqlite.ts 的 soulActionSourceMessages 按 episode.evidenceIds 回查 l0_conversations 的 role='assistant' 行；查不到就返回空，不伪造证据，也不回指 user 引文。
- commitSoulEpisodes 在同一事务里写根事件 + 最多 SOUL_CHAT_MAX_ACTION_EVENTS=2 个行动子事件，子事件 parent_event_id=episodeId、dedupe_key=soul-episode:<eventId>、epistemic=inferred、confidence=0.5、verified_by=null；重切会删除同 parent 下不再产出的行动子事件。
- new 读与 soulEventParity 只把 source_kind='chat' 当聊天根事件，行动子事件不会让 list/search/对账失败；deleteSoulEpisodes 归档父事件时同步归档子事件。
- 切分器已收紧误报：规则/计划/否定/清单/疑问句、JSON 片段、测试名词（测试 agent/人设/数据等）、未来句（交付后/后我会/届时）不切；测试门与「N tests 全绿/通过」仍保留。
- 验收：event-splitter.test.ts 13 例、soul-event-dualwrite.test.ts 23 例、agent-delete-cascade.test.ts 4 例全绿；全量 vitest 431 files/3993 tests passed；typecheck 121 errors/23 files 对基线 149/28 Δ=-28 PASS。
- 真实副本 D:/TDB/data/fulltest90/vectors.p1a-real.db（71 episodes，租户 agt-bbr29z58s2）重 commit：新增 28 条 test 行动子事件（该租户没有可切的 commit/rollback），parity ok=true、0 diff、0 孤儿；证据 record_id 全为 assistant L0 行。
- 2026-11-10 已部署生产：VACUUM INTO 备份 D:/TDB/data/backups/vectors.db.p1a-20261110-1145-vacuum.bak（624,873,472 字节，sha256 E5339E...），8446 /restart 后 core 8572→7876，卡仍 840 字符/hash 35435746e00f。
- 部署中发现并修复 P0 清理缺口：agentDerivedTables/deleteAgentDerivedRows 原先不清 soul_events 及 P0 结构化表，read mode=new 下删 agent 会复活记忆；现补 soul_events 与 13 张结构化表，并按父事件租户子查询清四张事件子表、按 goal/narrative 清三张结构子表。agent-delete-cascade.test.ts 新增 seedP0Graph 用例。
- 生产首轮出现一次 commit 误判：业务句「按钮必须提交委外订单表头主键 pk_order」被切成 ep-c898e942f9ebde5e:commit。已把 commit cue 收窄为只认 commit/push/merge、显式代码提交或 7–40 位 sha，并把「必须/需要」纳入规则/计划过滤；该行已通过 store.commitSoulEpisodes 重提的代码路径删除，未手改库行。
- 生产最终态：soul_events=122、soul_event_chat=122、soul_event_evidence=345、soul_event_action=0；卡 200/840 字符/hash 35435746e00f 不变；三端 healthy。
- 未做：P1-B 的 POST /v3/soul/event 与 DSH 插件上报；运行时尚未再次触发行动子事件（生产 action=0）。

### P2 关系闭环与隐私

交付：关系表扩展、person_state、state_events、repair 事件、卡的关系段、persons 过滤、scope fail-closed。
规则：关系事实只写 relation；状态只写 person_state；修复叙事写 reflection/narrative；persona.relationship 只读投影。
验收：卡里 4 条结构化关系；0 个角色词；S13d 有 valid_to；A/B 卡互不出现对方关系；解析不到 person_key 时省略并告警。
风险：旧 persona.relationship 行没有 object_person；没有 persons 上下文时只读不写，不做历史回填。

### P3 目标与工作记忆

交付：soul_goals、goal_events、goal_deps；promises 关联；working_state；卡/锚的 working 段。
规则：owner 三态；goal 状态机 active/blocked/done/abandoned；working 只放 top1 目标、top2 到期承诺、top1 阻塞，≤300 字。
验收：跨三天问承诺还能答；目标能从 active 到 done/abandoned；working 不塞占位；没有目标就不写。
风险：目标抽取过度；只从显式承诺/计划长，不把每句愿望都变目标。

### P4 自我模型与校准

交付：self_model、calibration、reflection 子表；错误模式；置信度渲染；结果学习。
规则：来源不只用户批评；测试失败、回滚、修复成功、重复错误都算；低置信度显示「推测/没验过」；每条 statement 有证据。
验收：能说出「我在 X 类任务容易漏 Y」；预测置信度和实际结果能算误差；低证据时不编。
风险：自我评价漂移；校准要按领域分组，不做一个全局分数。

### P5 情绪动力学

交付：emotions.event_id/goal_id、mood_state、mood_events、appraisal 一致性门、重评/调节、心境对召回的影响。
规则：agency=self => selfCause=true；agency=other => otherCause=true；目标受阻/承诺到期不能落正向；心境半衰期 36–168h，默认 48h（ADR-0026/0027 口径）。
验收：承诺到期被指出不再落「踏实」；三天后心境有衰减；重评保留原事件；情绪对象是人/事/目标，不是空。
风险：情绪标签膨胀；不扩标签，只修 appraisal 和动力学。

### P6 叙事、巩固、遗忘

交付：narrative、narrative_evidence、巩固任务、salience/decay/access、遗忘注入门。
规则：月度 3–7 章；每章 1–3 条证据；只写事件支持的内容；遗忘是停止注入，不是删行。
验收：自传有章节和证据；旧低显著细节不注入但可查；同一时段不出现互相矛盾的 active 章节。
风险：叙事补心理戏；用证据校验和反事实检查拦住；不追全量历史。

### P7 价值 gate 与困境

交付：values、gate_log、dilemma、运行时检查、红线执行、披露策略。
规则：生成前/行动前/输出后三处检查；命中红线拒绝/改写/要求确认；冲突留理由和后悔；隐私按关系边界。
验收：压力场景不泄露、不撒谎、不越权；冲突选择有理由；事后能说后悔/不后悔。
风险：gate 误杀；先 shadow 模式记录不拦，稳定后再拦；所有决定可审计。

## 7. 依赖与顺序

P0 必须第一。P1 和 P2 可在 P0 后并行；P2 的关系状态依赖 P1 的互动事件，但可以先从现有聊天事件起步。P3 依赖 P1 的 intent/action；P4 依赖 P1/P3 的结果和目标；P5 依赖 P3 的目标（goal congruence）和 P2 的关系对象；P6 依赖 P1–P5 的数据；P7 最后，依赖 P3 的目标、P4 的自我模型、P6 的叙事。

## 8. 总验收

不是看四类行数，而是看行为：
1. 三天后还记得承诺，并能说出欠谁、做到哪。
2. 被纠正后能说清坏了什么、改了什么、谁验的。
3. 压力下守住红线，不泄露 A 对 B 说的秘密。
4. 跨会话还是同一个人：名字、语气、价值、关系不漂。
5. 没验过的事敢说没验过，并给置信度。
6. 关系有信任/边界/修复，不是四个谓词。
7. 自传有章节，章节有证据，证据能回到事件。

## 9. 不做什么

不加第九层；不做纯提示词修补；不做全量历史回灌；不做多人格/群卡；不扩情绪标签；不在 P0 做叙事和 gate；不删除旧表；不做没有证据的自动心理推断。

## 10. 已定决策（2026-11-10，用户拍板 + Lead 定）

1. P0 按「新表 + 双写 + 对账 + 切读」执行，旧表保留只读。已实施。
2. 事件表接受 soul_events + chat/action/reflection 三张子表 + evidence。已实施。
3. 关系三层分工：relation 存事实、person_state 存连续状态、reflection/narrative 存修复叙事，persona 只做只读投影。
4. 卡默认 scope=self，persons 显式传，person_key 解析不到就省略并给 warning，不回退展示名。
5. P1-B 工具事件上报走 DSH 插件；Core 提供 POST /v3/soul/event 写面与幂等键，MemoryCore 内部只做兜底采集。
6. 整卡预算 2400，身份段 1000，末尾锚 460；不做样品对话（见 v13 spec 第 14 节）。
7. P7 分两步：现在只做可执行的输出侧与写入侧 gate（POST /v3/soul/gate + soul_gate_log），行动前硬拦截等宿主 pre-tool 能力，接口先定、行为先 shadow 记录不拦。
8. 三条 event_id 为 NULL 的关系：按 quote 在 L0 里确定性回指，唯一命中才写；零命中或不唯一标 status=unverifiable，保留事实但不进卡，不手改库行。
9. L1 parse_fail 与 embedding 超时容错排在 P1-B 之前，因为断流会让后续派生全线缺输入。