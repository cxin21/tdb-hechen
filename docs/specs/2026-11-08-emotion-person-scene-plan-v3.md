# 情绪层 · 人物档案 · 场合氛围：v3 完整设计

- 状态：**设计定稿**（契约已定，无待拍板项）；实施分四阶段，每阶段带仿真验收
- 追踪：GitHub issue [#180](https://github.com/cxin21/tdb-hechen/issues/180)
- 上一版：`docs/specs/2026-11-08-emotion-person-scene-plan.md`（v2，历史保留）
- 依据：`docs/research/2026-11-08-emotion-models.md`、`2026-11-08-person-profile-memory.md`、`2026-11-08-scene-atmosphere.md`、`2026-11-08-persona-dynamics-evidence.md`
- 本版修正 v2 四处硬错并吸收子代理审计的 8 条必改（逐条处置见 §0.2）

## 0. 结论

### 0.1 一句话

把「谁」（人物）、「此刻什么感受」（情绪）、「现在是什么场合」（氛围）接进同一条数据流，三者都**只影响渲染、只在有证据时写**；情绪从「24 选 1」改为「PAD 三维为真相 + 标签是投影」；人物从「human 合并块」改为「per-person 行 + 身份表」；场合只存在于插件拼的运行时上下文里，物理上无法污染人格写入。

### 0.2 v2 的错与本版处置

| # | v2 写的 | 实际 | 本版处置 |
|---|---|---|---|
| 1 | 改 `emotionHalfLifeHours` 3→1.5 让情绪更快归零 | `emotion.ts:199-201`、`:386-394` 只读 `templateHalfLifeHours`，模板自带值，配置键对已落库标签零效果 | 改**模板值**（24 条统一乘 0.5），新增全局倍率 `EMOTION_HALF_LIFE_SCALE`（默认 1），升 `EMOTION_TEMPLATE_VERSION` |
| 2 | `label` 允许 NULL | `sqlite.ts:1317` `label TEXT NOT NULL`；`commitSoulEmotions`（`:3835-3861`）固定 14 列 INSERT | **不改可空**：`label=''` 表示未命中锚点；新增 `agency TEXT`、`confidence REAL`、`object_person TEXT` 三列 |
| 3 | human 层「一条 = 一个人的卡」 | `card.ts:283` human 是 ≤12 行合并块；`/v3/soul/card` 只吃 team/user/agent（`card-service.ts` 无 sessionId/participants） | 扩契约（§4 已定），human 改为「按 person_key 过滤的块」，全局共性保留 `meta.person` 为空 |
| 4 | `soul_persona` 14 行 / 标签 22 条 | 实测 **17 行**（identity 3 / relationship 6 / self 4 / values 2 / voice 2，human 0）；`EMOTION_TEMPLATES` **24 条**（`emotion.ts:164-189`） | 基线按 17 行/24 条；判据不得引用 14/22 |
| 5 | `l1_records` 未挂人 | `metadata_json.personRefs` 已有 **569 行**：`["Lead"]` 189、`["用户"]` 181、`["何晨"]` 176、`["wlp"]` 7、`["lead"]` 5、`["用户","lead"]` 4，其余 7 行 | 迁移为 `persons`（§5.1），否则两套归属并存 |
| 6 | `soul_emotion_funnel` 新表 | `soul_gate_stats` PK 已含 `layer` | 复用 `soul_gate_stats`，`code` 取 `emotion:*`，不新建表 |
| 7 | 场合用 `order:10500` 排在卡之后 | `systemPrompt.context` 与 `section` 分开渲染，order 只在各自集合内排序 | 删掉跨集合先后断言；只断言「context 内可见、与 section 不冲突」 |
| 8 | 渲染共用 `decayedIntensity` | 与 `decayedStoredIntensity` 冲突，会二次衰减 | 统一 `decayedStoredIntensity`（只衰一次，从 `asOf` 起算） |

### 0.3 子代理审计的处置

采纳并改：E2 改错对象、label 迁移不存在、P2/P5 契约缺口、P3 忽略 personRefs、基线数字过期、E3 阶段定义与判据错、S2 order 语义错、E4 口径冲突 —— 全部已改入本版。

修正子代理一处：它称身份段 order「实为 130」，源码是 `dsh-plugin/src/persona-card.ts:86 PERSONA_IDENTITY_ORDER = 1`（`:661` 用在 `install`），130 是上一版。

## 1. 完整形态：五层一条线

层与载体（写者 → 读者）：

1. **会话与在场**：`soul_episodes.participants_json`（已有）为权威源；`soul_episodes.user_stance`（49/49 非空）是用户原话。
2. **人物身份**：新表 `soul_person`；`l1_records.metadata_json.persons[]`；`soul_persona.meta_json.person`。
3. **经历与判据**：事件 → appraisal（`soul_emotions.appraisal_json` 已有 `goalRelevance/expectationViolation/control/normCompatibility/agency/socialExposure`）→ 情绪行（PAD + 可选 label）。
4. **人格状态**：`soul_persona` 八层；`identity/voice/boundary/values` 全局，`human/relationship/self` 带 `person_key`。
5. **渲染与注入**：Core 组装卡（identity 段 / anchor 段 / per-person 段）→ 插件两段 section + 运行时 context（场合）。

五条不变式：

- 只有第 1、2、3 层有证据，第 4 层才写；第 5 层永远只读。
- per-person 内容必须能追到 `person_key` + `quote` + `message_id`。
- 场合不进 Core，任何 Core 表都不出现「正式/私聊」这类字段。
- 交锋只走一条写者：`worker.ts` 的 `commitSoulPersona`。
- 新增字段一律可空或带默认，旧行语义不变。

## 2. 记忆联动矩阵

| 面 | 全局作用域 | per-person 作用域 | 现状态 |
|---|---|---|---|
| 写入 | `l1_records.metadata_json.persons[]` 记主体/说话人/被提到 | 每条记忆最多 3 人，`role: subject/speaker/mentioned` | personRefs 569 行未迁移 |
| 召回 | 现有 hybrid 召回不变 | 会话召回追加 `personFilter: persons[].key ∈ 本会话在场者` | 无 |
| 遗忘 | 引用保护按 persona `meta.object` | 每人档案不被「他人遗忘」带走：`soul_person` 常驻，档案标 `stale` | 无 |
| 预算 | 卡 2000 / identity 1600 / anchor 400 | human per-person ≤6 行、关系 ≤3 行/人 | human 12 行合并块 |
| 承诺 | `soul_promises`（当前 0 行） | `meta.person` 指向被承诺人 | 无 person 维度 |
| 情绪对象 | `soul_emotions.object` 字符串 | 命中 person alias 时写 `object_person` | 无 |
| 观测 | `soul_gate_stats` 的 `layer` 维度 | 漏斗 code 加 `person:` 前缀 | 无 |

## 3. 四项改动（字段级）

### A 情绪层

- **A1 列**：`soul_emotions` 加 `agency TEXT`、`confidence REAL`、`object_person TEXT`；三条 `ALTER TABLE ... ADD COLUMN`，各自 try/catch 幂等。
- **A2 衰减**：24 条模板 `halfLifeHours` 统一乘 **0.5**（当前多为 3/4/6/8/12 → 1.5/2/3/4/6），并在 `decayedStoredIntensity` 增加可选 `scale` 参数（新常量 `EMOTION_HALF_LIFE_SCALE = 1`，由调用方传入）；`EMOTION_TEMPLATE_VERSION` 提升一版；历史行不改写，读侧按新规则重算，快照里 `templateVersion` 保留旧值。
- **A3 写入**：`emotionFromSignal` 返回 `{valence, arousal, dominance, agency, confidence, label}`；`label` 由 PAD 到 24 锚点的余弦最近邻决定，新常量 `EMOTION_LABEL_MIN_COS = 0.6`，低于阈值写 `''`；`confidence` 取 appraisal 的 `control×normCompatibility` 归一值（无输入时 0）。
- **A4 漏斗**：复用 `soul_gate_stats`，`code ∈ {emotion:candidate, emotion:object_ok, emotion:appraised, emotion:anchor_hit, emotion:intensity_ok, emotion:committed}`；`label_null` 与 `committed` 分别成比率，**不要求严格单调**；埋点位置：`worker.ts` 的 appraisal 循环（candidate/object_ok/appraised）、`emotionFromSignal` 返回后（anchor_hit）、强度门（intensity_ok）、`commitSoulEmotions` 返回值（committed）。
- **A5 读面**：`GET /v3/soul/emotions?team&user&agent&limit&since`，返回 `{rows:[{at,object,objectPerson,label,valence,arousal,dominance,intensity,decayedIntensity,agency,confidence,templateVersion}], funnel:{...}}`；GET-only、503 `soul_emotions_unavailable`，鉴权照 `server.ts` 的 `checkAuth`。
- **A6 面板**：`SoulEmotionPanel`（逐条表 + 漏斗条）；`SoulFeelingBar` 不动。

### B 人物档案

- **B1 表**：`soul_person(person_key TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, agent_id TEXT, platform TEXT NOT NULL DEFAULT '', platform_id TEXT, display_name TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]', merged_into TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`；partial 唯一索引 `(team_id,user_id,agent_id,platform,platform_id) WHERE merged_into IS NULL AND platform_id IS NOT NULL`；`person_key` 生成规则 `p_<sha1(team|user|agent|platform|platform_id).slice(0,12)>`，无 platform_id 时用 `p_name_<sha1(归一化名).slice(0,12)>`。
- **B2 记忆挂人**：`l1_records.metadata_json.persons=[{key,role}]`；写入在抽取之后、落库之前；兼容层：读取时若 `persons` 缺失则回退 `personRefs` 并打 `person_refs_fallback` 计数。
- **B3 迁移 569 行**：名字映射 `{"Lead":"p_lead","lead":"p_lead","何晨":"p_hechen","用户":"p_user","wlp":"p_wlp"}`，大小写归一，多值拆条。
- **B4 档案字段**：`soul_persona` `layer='human'` ≤6 行/人（称呼/职责/偏好/雷区/当前项目/相处方式）、`layer='relationship'` ≤3 行/人；`meta_json.person={key,platform,platform_id,display_name}`；`evidence_json` 存 `{text,quote,message_id,at,author_id}`。
- **B5 建档门槛**：该人 ≥3 条非群聊非转述记忆；每 tick 最多重建 **2** 人（不绕过 `worker.ts:1605` 单次 LLM 预算与 `lifecycle-scheduler.ts:440-449` 单飞）；模型只读该人最近 40 条。
- **B6 隔离**：依赖 §4 契约，`participants` 里的 person_key 决定 human/relationship 过滤。

### C 场合氛围

- **S1 取值**：三档「松/常/收」，由句长、标点密度、emoji 占比、礼貌词（请/麻烦/谢谢/辛苦了）、Markdown/代码块密度、称呼与敬称、交互节奏（上一条与本次间隔）七信号加权，确定性。
- **S2 载体**：插件 `ctx.systemPrompt.context({name:'tdb-agemem:scene', order:0, text})`，一行 ≤60 字；进程内 Map TTL 10 分钟；不落库、不进 Core。
- **S3 措辞**：只写渲染参数（「对方在等你交付，先给结论」），不写角色指令；按 `arXiv:2404.13208` 当低优先级上下文。

### D 契约（已定，见 §4）

## 4. 契约（定稿）

**采用 A：扩 `/v3/soul/card`，向后兼容。**

- 新增可选查询参数 `session`（会话 id）与 `participants`（逗号分隔 person_key，最多 8 个）。
- 两者缺省时行为与现在**逐字节一致**（判据：同一 agent 扩参前后 `text`/`identity.hash`/`anchor.hash` 不变）。
- 给了 `participants` 时：`human` 与 `relationship` 块只渲染 `meta_json.person.key ∈ participants` 的行；`participants` 给空串表示「无在场者」，只渲染 `meta.person` 为空的行。
- Core 侧新增 `resolveParticipants(store, tenant, {session, participants})`：显式 `participants` 优先，否则由 `session` 查 `soul_episodes.participants_json` 最近一条非空，都没有返回 `[]`。
- 插件侧：`cardSegments` 调用时带 `session`；`participants` 从 `identityStore` 的 `personKey`（新字段，可空）取。
- 不新增端点，不保留两套读面。

## 5. 迁移与回滚

### 5.1 personRefs → persons（569 行）

1. 备份 `vectors.db`、`-wal`、`-shm`，记录 `select count(*) from l1_records`。
2. 建 `soul_person` 与 partial 索引；插入映射表里的 5 个 person（Lead/用户/何晨/wlp + 归一 lead→Lead）。
3. 逐行 `UPDATE l1_records SET metadata_json = json_set(metadata_json,'$.persons',?)`，保留 `personRefs` 原字段 30 天。
4. 核对：`select count(*) from l1_records where metadata_json like '%personRefs%' and json_extract(metadata_json,'$.persons') is null` = **0**。
5. 回滚：恢复备份文件；不做反向 UPDATE。

### 5.2 情绪三列

三条 `ALTER TABLE ADD COLUMN`，各自幂等；回滚用 `DROP COLUMN`（SQLite ≥3.35）。

### 5.3 human 层拆分

先写新行（`meta.person` 非空），旧合并行保留 `meta.person` 为空 = 全局共性；契约生效后再决定是否折叠。回滚：`UPDATE soul_persona SET state='retired' WHERE meta_json LIKE '%"person"%'`。

## 6. 阶段计划（实施顺序，每阶段独立可回滚）

### 阶段 1：人物身份与记忆挂人（B1/B2/B3 + 迁移）

- 改动：`MemoryCore/src/core/store/sqlite.ts`（建表、索引、person CRUD、迁移方法）、`MemoryCore/src/core/person/`（新目录：`resolve.ts` 的 `resolvePerson`、`link.ts` 的 `linkMemoryToPersons`）、`MemoryCore/src/core/record/l1-*.ts`（落库时写 `persons`）、`scripts/migrate-person-refs.mjs`（dry-run 缺省）。
- 仿真：`MemoryCore/scripts/sim-person-link.mjs`——临时 sqlite，灌 2 人 × 3 记忆 × 2 会话，断言 `soul_person` 2 行、`persons` 6 条、`personRefs` 回退计数 0；再灌一条转述记忆，断言不入档。
- 验收：临时库三条断言全绿；生产 dry-run 输出「569 行待迁移 / 映射 5 人」；`--apply` 后 §5.1 第 4 步 = 0。
- 回滚：恢复备份。

### 阶段 2：per-person 卡与契约（§4 + B4/B6）

- 改动：`MemoryCore/src/core/soul/card.ts`（human/relationship 按 person 过滤）、`card-service.ts`（传 participants）、`gateway/soul-card-endpoint.ts`（解析 query）、`dsh-plugin/src/persona-card.ts` 与 `memory-client.ts`（带 `session`）、`dsh-plugin/src/session-identity.ts`（存 `personKey`）。
- 仿真：`scripts/sim-card-persons.mjs`——临时库两人生成卡，断言 A 卡 0 次出现 B 的事实；扩参前后同 agent `text` 字节相同。
- 验收：仿真两条断言；生产 `curl` 缺省/带参与改前字节对比；面板不回归（tsc + build）。
- 回滚：恢复备份 + 插件 dist 回滚上一版。

### 阶段 3：情绪层（A1–A6）

- 改动：`sqlite.ts`（三列、读回）、`emotion.ts`（模板半衰期 ×0.5、`scale` 参数、`EMOTION_LABEL_MIN_COS`）、`worker.ts`（埋点与写入）、`gateway/soul-emotions-endpoint.ts`（新）、`MemoryPanel`（`SoulEmotionPanel` + BFF）。
- 仿真：`scripts/sim-emotion.mjs`——临时库 3 对象 × 3 appraisal，断言行数、`label=''` 比率、两 tick 幂等、`decayedIntensity` 与手算差 ≤1e-3。
- 验收：仿真四条断言；生产重启后 `soul_emotions` 增加且次 tick 不增；`funnel` 五档有行；`GET /v3/soul/emotions` 200 且字段齐。
- 回滚：`DROP COLUMN` ×3 + 恢复 `EMOTION_TEMPLATE_VERSION`。

### 阶段 4：场合氛围（S1–S3）

- 改动：`dsh-plugin/src/scene.ts`（新，七信号 → 三档 + 一行）、`index.ts`（注册 context）。
- 仿真：`scripts/sim-scene.mjs`——两组伪造输入，断言档位与 ≤60 字；TTL 内两次一致。
- 验收：插件日志每轮一行 `scene=`；Core 全部表 `grep -c scene` = 0；prompt 快照里出现该 context 段。
- 回滚：删 context 注册（`effects` 自动摘）。

## 7. 判据（可证伪）

1. 情绪衰减：一条 `intensity=0.4` 的行，手算 `0.4*0.5^((now-at)/newHalfLife)` 与 `GET /v3/soul/emotions` 的 `decayedIntensity` 差 ≤1e-3。
2. 情绪落行：重启后首个 tick `soul_emotions` 严格增加；次 tick 不增加。
3. 漏斗：`select code,sum(count) from soul_gate_stats where code like 'emotion:%' group by code` 五档都有行；`committed ≤ appraised`。
4. 人物表：`select count(*) from soul_person` ≥ 5；`persons` 为空的 personRefs 行 = 0。
5. 隔离：A/B 两人各 3 记忆，`participants=A` 的卡里 B 的事实出现 **0** 次（SQL + 文本双断言）。
6. 场合：Core 表 `scene` 命中 0；插件日志每轮一行 `scene=`；TTL 内不重复计算（计入日志）。
7. 反例有效：把 `EMOTION_LABEL_MIN_COS` 设为 2.0，`anchor_hit` 归零而 `committed` 仍 >0。

## 8. 不做

- 不做 24 标签之外的标签集扩张（`arXiv:2311.10054`）。
- 不把 PAD 反推标签当读面（`label=''` 合法）。
- 不在 Core 存场合（物理隔离）。
- 不做「每轮必注入」补偿（`arXiv:2402.10962` 未证明重注入是解药）。
- 不按用户满意当漂移奖励（`arXiv:2310.13548`）。
- 不把 voiceRate 当上线门槛（现状 0/54，模型行为，只观测）。
- 不做群成员表（无数据源；在场者只认「本轮说过话的人」）。

## 9. 未采集

- 群聊多用户同 agent 的真实会话样本（当前全是单人会话）。
- 24 条模板新半衰期在真实对话上的消退曲线（需 24h 观测）。
- 插件 `ctx.systemPrompt.context` 在本宿主版本的运行时行为（源码 0 次调用，只有 asar 静态证据）。
- `/v3/soul/card` 扩参后 MemoryPanel 记忆块的兼容表现（它走 `/v3/core-memory/read`）。
