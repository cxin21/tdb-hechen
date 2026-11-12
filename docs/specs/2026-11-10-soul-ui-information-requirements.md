# 灵魂层 UI 信息需求（只读调研）

- 日期：2026-11-10
- 范围：td-agemem 灵魂层（人格卡 / 事件 / 关系 / 情绪 / 目标 / 叙事 / 运行健康）在面板上「应该展示哪些信息、每条信息从哪来」
- 性质：只读调研产出。不含视觉方案（配色、布局、组件选型）、不含工期、不含代码改动
- 取证基线：MemoryCore 源码 + MemoryPanel 源码 + docs/specs 下 v13 / event-model / v4 / profile-distill 四份规格 + ADR-0028

## 0. 这份文档解决什么问题

人格站现在有五个面（人格卡 / 特质 / 情绪 / 人物关系 / 注入），能看的东西不少，但读者仍然回答不了三个最基本的问题：**它现在到底处在什么状态、它对某个人此刻怎么看、上周到底发生过什么**。人格卡是一段被预算裁过的注入文本，回答不了「为什么这么写」；人物档案展示的是九字段画像与几条静态关系边，回答不了「信任变了没有、因为哪件事变的」；情绪页是行列表，回答不了「这些情绪最后沉淀成了什么心境」。

根因不是数据库里没有数据。P0（2026-11-07）已经落了一整套事件底座——soul_events、证据、行动、反思、关系状态、目标、自我模型、校准、心境、叙事、价值、gate、两难、工作记忆，共 21 张表（`MemoryCore/src/core/store/soul-event-ddl.ts:510-551` 的建表清单）。真正的问题在人格卡 v13 草案 §1 已经写明的那句话：**不是表不够，是前台没接后台**——card-service 的 store port 只有七个方法（`MemoryCore/src/core/soul/card-service.ts:104`），读的是 persona / trait / snapshot / state / promise，P0 建的关系状态、心境、目标、工作记忆一个都没读。

本文把「能展示什么」按信息层与区块逐条钉到表列和接口字段上，并明确哪些东西**没有**读面（需新增）、哪些东西**不该**展示。它是一次信息盘点，不是一次界面设计。

## 1. 三条硬结论

**结论 A：可展示的物理上限远大于现网读面。**
现网 soul 读面一共 7 条 GET + 1 条 POST 自省：

| 接口 | 位置 | 读的表 |
| --- | --- | --- |
| GET /v3/soul/card | `MemoryCore/src/gateway/soul-card-endpoint.ts:160` | soul_persona / soul_trait_state / soul_trait_label / soul_state / soul_promises / soul_snapshots |
| GET /v3/soul/turn | `MemoryCore/src/gateway/soul-card-endpoint.ts:161` | 同上（只取 openLoops 与末尾锚） |
| GET /v3/soul/trait-state | `MemoryCore/src/gateway/soul-card-endpoint.ts:254` | soul_trait_state + soul_trait_label |
| GET /v3/soul/emotions | `MemoryCore/src/gateway/soul-emotions-endpoint.ts:59` | soul_emotions |
| GET /v3/soul/persons | `MemoryCore/src/gateway/soul-person-endpoint.ts:161` | soul_person + soul_person_relation |
| GET /v3/soul/person | `MemoryCore/src/gateway/soul-person-endpoint.ts:262` | soul_person + soul_person_relation + soul_persona(human 层) |
| GET /v3/soul/person/search | `MemoryCore/src/gateway/soul-person-endpoint.ts`（handleSoulPersonSearchRoute） | soul_person + soul_person_relation + soul_persona(human 层)：按 q 归一化后匹配 key/显示名/别名，返回 match/matchedOn |
| GET /v3/soul/injection/stats | `MemoryCore/src/gateway/soul-injection-stats-endpoint.ts:31` | 不读表，聚合 recall journal |
| POST /v3/soul/introspect | `MemoryCore/src/gateway/soul-introspect-endpoint.ts:104` | soul_snapshots（零写入，强制 snapshotsEnabled=false） |

写面两条：POST /v3/soul/event（事件上报，`MemoryCore/src/gateway/soul-event-endpoint.ts:50`）、POST /v3/soul/injection（注入回执，`MemoryCore/src/gateway/soul-injection-endpoint.ts:19`）。

**结论 B：事件底座整族没有读面。**
soul_events / soul_event_evidence / soul_event_chat / soul_event_action / soul_event_reflection 五张表，以及依赖它们的 soul_person_state(_events)、soul_goals(_events/_deps)、soul_self_model、soul_calibration、soul_mood_state(_events)、soul_narrative(_evidence)、soul_values、soul_gate_log、soul_dilemma、soul_working_state，在 gateway 里没有任何 GET 路由。全局检索网关路由只能命中上面 8 条（`MemoryCore/src/gateway/server.ts:1296-1360`）。所以「事件流」「目标」「自我模型」「叙事」「心境曲线」这几层今天在 UI 上无法展示——不是选择不展示，是无面可读。

**结论 C：可信度今天只有两个半粒度。**
卡级有 sources（字段→declared/observed/derived，`MemoryCore/src/core/soul/card-service.ts:43-46`），事件级有 epistemic + confidence（`soul_event-ddl.ts:64-67`），关系边有 confidence（`soul-event-ddl.ts:568`）。但**块级**来源与置信（v13 §9 的 blocks[*].source/confidence/evidenceIds）还没实施，所以 UI 现在只能说「这张卡里哪些字段是声明的」，说不了「这一段是推测的」。

## 2. 信息分层

七层，每层回答一类疑问。层级之间不重叠：越往上越稳定，越往下越即时、越需要证据。

| 层 | 回答用户的什么疑问 | 主载体 | 现网可得 |
| --- | --- | --- | --- |
| L1 稳定人格（卡） | 它是个什么样的存在、说话什么调、红线在哪 | `GET /v3/soul/card`；soul_persona、soul_trait_label | 有（v12 卡文本） |
| L2 当下状态（turn） | 它这一刻什么心情、什么底色、手上还欠着什么 | `GET /v3/soul/turn`；soul_state、soul_mood_state、soul_working_state | turn 有接口，面板**没接**；mood/working 无读面 |
| L3 事件流 | 最近发生了什么、它做过什么、做成没做成 | soul_events + soul_event_evidence(_chat/_action/_reflection) | **无读面** |
| L4 人物与关系 | 它认识谁、对谁什么态度、这态度怎么变的 | soul_person、soul_person_relation、soul_person_state(_events) | 人物+边有；五维与变化史**无读面** |
| L5 情绪与心境 | 什么让它起情绪、情绪沉淀成什么底子 | soul_emotions、soul_mood_state、soul_mood_events | 快情绪有；心境状态/曲线**无读面** |
| L6 目标与叙事 | 它在追什么、答应过什么、这段经历怎么被讲述 | soul_goals(_events/_deps)、soul_promises、soul_narrative(_evidence) | 承诺有（卡内 openLoops）；目标/叙事**无读面** |
| L7 运行健康 | 注入成功没有、卡是不是旧版、gate 拦了什么 | 注入统计、soul_gate_stats、soul_gate_log、soul_ledger、soul_snapshots | 注入统计有；gate/ledger **无读面** |

## 3. 区块逐条

约定：**S** 列 = 可信度标注方式；**E** 列 = 空态与降级；**F** 列 = 刷新频率；**P** 列 = 是否敏感需脱敏。

### B1 人格卡全文

**回答**：它现在被注入给模型的那段「自我」到底是什么字？改了没有？

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 卡正文 | `GET /v3/soul/card` → `data.text`（`card-service.ts:60` SoulCardAssembly.text） | string | 无（正文内已按区块组织） | 「没有拿到人格卡」+ 检查绑定/Core 读面的提示 | 300s（`PERSONA_CARD_REVALIDATE_MS=300000`，ADR-0028 D4） | 否，但含关系与事件原文需按 visibility 过滤 |
| 版本 | `data.version`（CARD_SCHEMA_VERSION） | number | — | 未取到即整块空 | 同上 | 否 |
| hash / chars | `data.hash`、`data.chars` | string / number | — | 同上 | 同上 | 否 |
| 标签 | `data.labels[]`：label / act / gloss（`soul_trait_label.label/gloss` + `soul_trait_state.axis_json` 投影） | array | observed（标签由行为证据攒出来，四闸准入） | 无标签不渲染该行 | 同上 | 否 |
| 字段级来源 | `data.sources`：字段名 → declared/observed/derived（`card-service.ts:46` CARD_FIELD_SOURCES） | Record | **这是今天唯一可展示的可信度** | 缺键即不标注，不猜 | 同上 | 否 |
| 警告 | `data.warnings[]`（truncated / dirty 相关） | string[] | — | 空数组不渲染 | 同上 | 否 |
| 脏标记 / 种子卡 | `data.dirty`、`data.seeded` | boolean | — | false 也照实显示 | 同上 | 否 |

**S 的当下能力与缺口**：只能做「字段级」标注——name/image/voice/purpose/redlines 是 declared，traits/autobiography 是 derived，human/relationship/selfHistory/openLoops 是 observed（`card-service.ts:46`）。段落级来源（哪一段是推测）需等 v13 blocks（§9），现在没有。

**E**：卡文本为空或请求失败必须原样显示错误 message，不得用示例卡填充。现网 `SoulStation.tsx:188` 已经是这个口径。

**P**：卡正文含真实关系原文与事件原话，展示面要对 `visibility=private` 的事件做剔除（`soul-event-ddl.ts:68-69` 的 visibility 枚举；spec §4.1 规定 private 不进对用户的卡）。

### B2 当下状态（turn + 心境 + 工作记忆）

**回答**：它这一刻是什么心情、底色离基线多远、手上还欠着什么没做完。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 每轮结尾段文本 | `GET /v3/soul/turn` → `data.text`（`SoulTurnAssembly.text`，`card-service.ts`） | string | derived（ADR-0028 §14：只有「现在」允许推导） | 空文本不渲染该块 | 每轮（volatile 段，≤400 字，单条 ≤360） | 否 |
| 未完成的事 | `data.openLoops[]`（来源 soul_promises.status='open'，`sqlite.ts:1385`） | array | observed（承诺是事实行） | 无 open 承诺即不渲染 | 每轮 | 否 |
| 效价 / 唤醒 / 支配 | `soul_state.valence/arousal/dominance`（`sqlite.ts:1142` + 补列 :1154-1165） | REAL | observed（由事件评估写入） | 无行则整块声明「还没有状态行」 | 每轮或每次 tick | 否 |
| 基线 | `soul_state.baseline_valence/baseline_arousal/baseline_dominance` + `sample_count` | REAL / int | derived（EMA α=0.02） | 缺基线不出「与基线差值」，只出绝对值 | 同上 | 否 |
| 情绪标签 / 对象 | `soul_state.emotion_label/emotion_object/emotion_intensity/emotion_at` | TEXT/REAL | observed | 无标签写「无情绪」而非「平静」 | 同上 | 否 |
| 慢心境 | `soul_mood_state.label/valence/arousal/intensity/half_life_hours`（`soul-event-ddl.ts:348-360`） | TEXT/REAL | observed | **无读面**；缺行时不得用 soul_state 冒充心境 | 每轮 | 否 |
| 当下焦点 | `soul_working_state.current_focus`（`:479-490`） | TEXT | observed | **无读面** | 每会话 | 否 |
| 当前目标 | `soul_working_state.current_goal_id` → soul_goals.title | TEXT | observed | 无读面；目标 id 悬空时显示「目标已不在」 | 每会话 | 否 |

**要点**：turn 是唯一面向「现在」的读面，但 MemoryPanel 里没有它的 BFF 路由——`grep` 全仓库只能找到 card / trait-state / emotions / persons / person / injection-stats 六条（`MemoryPanel/src/panel/http/routes/chat-memory-soul.ts:428,519,586,671,745` 与 `soul-persons.ts:291,339`）。这是最便宜的一个缺口：接口已经在，缺一层转发。

### B3 特质与漂移

**回答**：设定里的「你」和现在的「它」差了多少，哪几轴在漂。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 六轴标签 | `GET /v3/soul/trait-state` → `traits[].label`（soul_trait_label.label） | string | observed | 无行则「还没有特质状态」 | 随 tick | 否 |
| 设定值 / 当前值 | `traits[].seedWeight` / `nowWeight`（soul_trait_state.seed_state_json / axis_json，`sqlite.ts:1203`） | number | declared / observed（同一行两种语义，必须分开标） | null 就显示 null，不补 0（BFF 已按此收窄，`chat-memory-soul.ts:583-585`） | 同上 | 否 |
| 是否漂移 | `traits[].drifted` | boolean | derived（α=0.02、单 tick ≤0.05、Σ≤0.5，ADR-0028 D3） | false 照实 | 同上 | 否 |
| 状态落库时间 | `updatedAt` | string\|null | — | null 显示「还没长出来」 | 同上 | 否 |
| 标签证据数 | `soul_trait_label.evidence` | number | observed | — | **无读面**（trait-state 只回 label/权重/漂移） | 否 |

### B4 情绪（快）

**回答**：什么事件让它起了情绪、强度多大、有没有归到某个人身上。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 时间 / 对象 / 标签 | `GET /v3/soul/emotions` → `rows[].at/object/label`（soul_emotions.at/object/label，`sqlite.ts:1344`） | string | observed | 无行 →「还没有情绪行」 | 打开时 + 手动刷新；limit 默认受 BFF 约束（`chat-memory-soul.ts:740-743`） | 对象可能含人名 |
| 三维 + 强度 | `rows[].valence/arousal/dominance/intensity` | number | observed | 缺列 null 不补 0 | 同上 | 否 |
| 衰减后强度 | `rows[].decayedIntensity`（读侧按模板半衰期算） | number | derived | 缺则退回 intensity 并注明 | 同上 | 否 |
| 归因 | `rows[].agency` | string | observed | null 显示「不明」 | 同上 | 否 |
| 对象人物 | `rows[].objectPerson`（soul_emotions.object_person 补列） | string | observed | 无则不显示 | 同上 | 人名 |
| 置信度 | `rows[].confidence`（补列） | number | observed | null 不显示 | 同上 | 否 |
| 漏斗六档 | `data.funnel`：emotion:candidate / object_ok / appraised / anchor_hit / intensity_ok / committed | Record | — | 上游没给就写「没有漏斗，不伪造数字」（现网 `SoulStation.tsx:228` 口径） | 同上 | 否 |

### B5 人物与关系

**回答**：它认识谁、对每个人的判断是什么、哪条判断有原话支撑、这判断最近变没变。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 人物键 / 显示名 / 别名 | `GET /v3/soul/persons` → `persons[].key/displayName/aliases`（soul_person，`soul-person-ddl.ts:14`） | string[] | observed | 无人物 →「还没有登记的人物」 | 打开时 | 显示名与平台 id 可识别真人 |
| 平台 / 平台 id | `persons[].platform/platformId` | string | observed | 空平台不显示 | 同上 | **敏感**（可外链到具体账号） |
| 字段数 / 关系数 | `persons[].fieldCount/relationCount` | number | derived（计数） | 0 照实显示 | 同上 | 否 |
| 九字段画像 | `GET /v3/soul/person` → `fields[].field/label/text`（顺序 alias/role/style/likes/dislikes/focus/story/promise/handle，`MemoryCore/src/core/person/profile.ts:88-119`） | array | observed（来自对话原话提炼） | 无字段 →「还没有提炼字段」（`SoulStation.tsx:366-367`） | 打开时 | **敏感**：原话可能含隐私 |
| 字段证据 | `fields[].evidence[]`：recordId / at / quote（`soul-person-endpoint.ts:57-64`） | array | observed | 无证据字段不渲染引文行 | 同上 | **敏感**，引文需可脱敏 |
| 字段是否过期 | `fields[].stale`（按字段 TTL，profile.ts:111-119） | boolean | derived | false 不显示 | 同上 | 否 |
| 关系边 | `relations[].pred/objName/direction/quote/recordId/validFrom`（soul_person_relation，`soul-person-ddl.ts:47`） | array | observed（每条边带 quote+record_id，NOT NULL） | 无边不渲染关系段 | 同上 | **敏感**，quote 是 L0 原文 |
| 全员关系边 | `GET /v3/soul/persons` → `edges[]`：relId/subjKey/subjName/pred/objKey/objName/direction/quote/recordId/validFrom | array | observed | 空数组 → 关系图不渲染 | 同上 | 同上 |
| 关系状态五维 | `soul_person_state.trust/affinity/respect/obligation`（0..1，`soul-event-ddl.ts:203-219`） | REAL | observed | **无读面**；缺行时按 v13 §14 只写关系事实、不写五维 | 随评估 | 否 |
| 关系状态变化史 | `soul_person_state_events`：field/old_value/new_value/reason/at（`:226-238`） | rows | observed | **无读面** | 变化时 | reason 可能含原话 |
| 边界条款 / 对方模型 | `soul_person_state.boundaries_json/model_json` | JSON | observed | 空对象不渲染 | 同上 | 可能敏感 |
| 关系置信度 / 时效 | `soul_person_relation.confidence/status/tense/valid_to`（补列 `:565-570`） | REAL/TEXT | observed | 缺列不显示 | 同上 | 否 |

**可信度红线**：关系边唯一合法的可信度依据是 quote + record_id 能回指到 L0 原文。spec §10 决策 8 已定：event_id 为 NULL 的边按 quote 在 L0 确定性回指，零命中或不唯一要标 status=unverifiable、保留事实但不进卡。UI 必须能显示这个状态，否则等于把未验证的关系边当事实。

### B6 事件流

**回答**：最近发生了什么、它做过什么、承诺兑现了没有、失败的尝试是哪些。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 事件 id / 时间 / 归属 | `soul_events.event_id/at/day/valid_from/valid_to`（`soul-event-ddl.ts:42-78`） | TEXT | — | **无读面** | 事件写面已通（P1-A 生产 122 条），读面缺 | 否 |
| actor | `actor`：self/user/third/tool/system | enum | observed | — | 同上 | 否 |
| 动作 / 客体 / 意图 / 结果 | `action/object/intent/outcome/status`（status: open/done/failed/partial/unknown） | TEXT | observed | — | 同上 | outcome 可能含原文 |
| 来源类型 | `source_kind`：chat/tool/test/commit/rollback/observation/reflection/system | enum | — | — | 同上 | 否 |
| 认知来源 / 置信 | `epistemic`：observed/inferred/assumed；`confidence` 0..1 | enum/REAL | **主可信度字段** | — | 同上 | 否 |
| 可见性 | `visibility`：shared/private/relationship | enum | — | private **必须不进任何对用户的面** | 同上 | **必过滤** |
| 显著性 | `salience` 0..1 | REAL | derived | — | 同上 | 否 |
| 证据 | `soul_event_evidence.role/quote/at/confidence`（`:122-132`） | rows | observed | 无证据的行只能按 inferred 呈现 | 同上 | quote 是原文，需脱敏 |
| 聊天事件补充 | `soul_event_chat.kind/title/user_stance/agent_stance/cost/valence/arousal/intensity`（`:147-163`） | TEXT/REAL | observed | — | 同上 | 立场文本可能敏感 |
| 行动事件补充 | `soul_event_action.tool/result_status/duration_ms/artifact_ref/error_code/environment/verified_by`（`:169-182`） | TEXT | observed | — | 同上 | 只存 args_digest，**不展示原始参数** |
| 反思 | `soul_event_reflection.lesson/behavior_change/verified_at/confidence`（`:185-194`） | TEXT | observed | — | 同上 | 否 |

**这一层是整份文档最大的洞**：写面已经在跑（`/v3/soul/event` 生产 122 条事件、345 条证据，spec §6 P1-A 实测），读面一条都没有。

### B7 目标与承诺

**回答**：它自己在追什么、答应了谁什么、卡在哪。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 目标 | `soul_goals`：owner(self/user/joint)/kind(desire/commitment/plan/project)/title/why/status/priority/progress/due_at/blocked_reason/abandon_reason/success_criteria（`:251-275`） | mixed | observed | **无读面** | 变化时 | why/blocked_reason 可能含原话 |
| 目标状态史 | `soul_goal_events`：change/from_status/to_status/note/at（`:278-287`） | rows | observed | **无读面** | 变化时 | 否 |
| 目标依赖 | `soul_goal_deps`：goal_id/depends_on_goal_id/kind（`:290-295`） | rows | observed | **无读面** | 同上 | 否 |
| 承诺 | `soul_promises.content/status/source/ref_key/created_at/resolved_at`（`sqlite.ts:1385`） | TEXT | observed | 现网只在卡末尾锚「未完的事」出现（≤2 条） | 每轮 | 否 |
| 承诺状态史 | `soul_promise_events.from_status/to_status/at/note`（`sqlite.ts:1401`） | rows | observed | **无读面** | 变化时 | 否 |

v13 §6 P3 已定口径：working 只放 top1 目标 / top2 到期承诺 / top1 阻塞，≤300 字。UI 上「目标」区块同理——列全部目标会退化成待办清单，spec §4.5 明确说过这一点。

### B8 自我模型与校准

**回答**：它怎么评价自己、这个自评被证伪过没有、它是不是过度自信。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 自我陈述 | `soul_self_model`：kind(capability/error_pattern/calibration/preference/boundary)/scope/statement/confidence/status(active/probation/retired)/last_confirmed_at（`:304-320`） | mixed | observed | **无读面** | 变化时 | 否 |
| 反例 | `soul_self_model.counterexample_event_ids_json` | JSON | observed | 空数组明确显示「没有反例」而不是省略 | 同上 | 否 |
| 校准记录 | `soul_calibration`：domain/predicted_confidence/actual_outcome/error/at（`:326-339`） | rows | observed + derived(error 读侧算) | **无读面** | 累计 | 否 |

spec §6 P4 的口径在这里是硬要求：低置信必须显示「推测 / 没验过」。这一层是唯一能让「它敢说没验过」这件事被用户看见的地方（§8 验收第 5 条）。

### B9 叙事章节

**回答**：这段经历被它自己讲成了什么故事、每章有什么证据、有没有旧版本。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 章节 | `soul_narrative`：period_start/period_end/title/summary/turning_points_json/lessons_json/version/status(active/superseded)/supersedes_id（`:389-406`） | mixed | **derived**（叙事是推导，不是事实） | **无读面** | 月度 | 否 |
| 章节证据 | `soul_narrative_evidence`：chapter_id/event_id/role（`:409-414`） | rows | — | 无证据的章节**不该展示**（spec §6 P6：每章 1–3 条证据） | 同上 | 否 |
| 当前叙事预览 | `POST /v3/soul/introspect` → `data.rendered`（≤4000 字，截断须注明，`chat-memory-soul.ts:65-66`） | string | derived | 空则不渲染 | 打开时 | 否 |

### B10 运行健康

**回答**：注入有没有生效、卡是不是旧的、gate 拦过什么、哪次维护失败。

| 字段 | 来源 | 类型 | S | E | F | P |
| --- | --- | --- | --- | --- | --- | --- |
| 窗口内注入轮数 / 最近注入 | `GET /v3/soul/injection/stats` → `rows/lastAt` | number/string | — | journal 关闭 → 200 全零 + note='journal_disabled'，必须显示 note | 打开时 | 否 |
| 最近卡 / 每轮段 | `lastCard{version,hash,chars}`、`lastVolatile{chars,hash,skipped}` | object\|null | — | null = 窗口内无上报，**不得显示 0**（`soul-injection-stats-endpoint.ts:31` 合同） | 同上 | 否 |
| 失败原因分布 | `failReasons{http_status,timeout,empty,parse}` | object\|null | — | null =「暂无失败上报」，不是「0 次失败」 | 同上 | 否 |
| 服务端只渲染未回报 | `serverRenderOnly` | number | — | 0 照实 | 同上 | 否 |
| 对账 | `pairs{matched,charMismatch}` + `pairStrategy` | object | — | — | 同上 | 否 |
| 注入回执明细 | POST /v3/soul/injection 写入 journal 的 kind='injection' 行（只收长度与指纹，`soul-injection-endpoint.ts:10-14`） | — | — | 无 journal 即无此块 | 同上 | **永不展示正文**（隐私边界） |
| 快照版本链 | `POST /v3/soul/introspect` → `snapshots[]`：ts/content_hash/trigger/version?/parent_hash?/reason_code?/reason_detail?/lineDiff/slotDiff | rows | — | 旧快照无 version/parent 时**不补造序号**，按「旧快照」降级（`chat-memory-soul.ts:22-25`） | 打开时 | 否 |
| gate 统计 | `soul_gate_stats`：day/code/layer/count/last_at（`sqlite.ts:1263`） | rows | — | **无读面** | 每日 | 否 |
| gate 拦截日志 | `soul_gate_log`：stage/action_digest/rule_id/decision/reason/confidence（`soul-event-ddl.ts:443-456`） | rows | — | **无读面**；只展示 digest，不展示被拦原文 | 事件时 | **敏感**（被拦内容可能含密钥） |
| 账本 | `soul_ledger`：action/layer/item_id/reason/evidence_json/gates_json（`sqlite.ts:1233`） | rows | — | **无读面** | 变化时 | 否 |

### B11 版本链（现网已有，口径需统一）

**回答**：卡是什么时候因为什么变的。

数据来源只有 `POST /v3/soul/introspect`（`data.snapshots`）与 `soul_snapshots`（`sqlite.ts:1098`：ts/content_hash/payload_json/trigger/version/parent_hash/reason_detail/slots_json）。`payload_json` 是整段人设原文，**BFF 明确不外传**（`chat-memory-soul.ts:17`「不透传 payload_json」）——这条边界必须保留。

## 4. 数据可得性矩阵

图例：✅ 有表且已有读面；🟡 有表无读面（需新增接口，UI 才能用）；⚠️ 有读面但字段被收窄。

| 信息 | 表 / 接口 | 状态 | 缺口 |
| --- | --- | --- | --- |
| 卡正文 / 版本 / hash / 标签 / 警告 / 字段来源 | card-service → GET /v3/soul/card | ✅ | 无 |
| 卡块级来源与置信 | v13 §9 blocks | 🟡 | 需实施 v13（CARD_SCHEMA_VERSION 13） |
| 每轮结尾段 + 未完的事 | GET /v3/soul/turn | 🟡 | 接口有，**面板无 BFF**，需新增 GET /api/v1/chat-memory/soul-turn |
| 心境状态 | soul_mood_state | 🟡 | 需新增 GET /v3/soul/mood |
| 心境变化曲线 | soul_mood_events | 🟡 | 需新增（可与上合并，返回 events） |
| 工作记忆 | soul_working_state | 🟡 | 需新增 GET /v3/soul/working |
| 六轴 + 漂移 | GET /v3/soul/trait-state | ✅ | 无；标签证据数 evidence 被收窄 |
| 快情绪 + 漏斗 | GET /v3/soul/emotions | ✅ | 无 |
| 人物列表 + 关系边 | GET /v3/soul/persons | ✅ | 无 |
| 单人九字段 + 关系 | GET /v3/soul/person | ✅ | 关系边的 evidence_json 未外传（只给第一条 quote） |
| 关系五维状态 | soul_person_state | 🟡 | 需新增 GET /v3/soul/person-state |
| 关系变化史 | soul_person_state_events | 🟡 | 需新增 |
| 事件基表 | soul_events | 🟡 | 需新增 GET /v3/soul/events（带 limit/kind/since/actor/visibility 过滤） |
| 事件证据 | soul_event_evidence | 🟡 | 需随事件一并返回 evidence[] |
| 行动/聊天/反思补充 | soul_event_chat/_action/_reflection | 🟡 | 需在事件读面里按 kind 合并 |
| 目标 | soul_goals | 🟡 | 需新增 GET /v3/soul/goals |
| 目标状态史 / 依赖 | soul_goal_events / soul_goal_deps | 🟡 | 需新增（可并入 goals） |
| 承诺（全部） | soul_promises | ⚠️ | 现网只经卡 openLoops 露 2 条；需新增 GET /v3/soul/promises |
| 自我模型 | soul_self_model | 🟡 | 需新增 GET /v3/soul/self-model |
| 校准 | soul_calibration | 🟡 | 需新增 |
| 叙事章节 + 证据 | soul_narrative / _evidence | 🟡 | 需新增 GET /v3/soul/narrative |
| 价值 | soul_values | 🟡 | 需新增（低频，可合并进 self-model） |
| 两难 | soul_dilemma | 🟡 | 需新增（P7 前可能是空的） |
| gate 统计 | soul_gate_stats | 🟡 | 需新增 GET /v3/soul/gate/stats |
| gate 拦截日志 | soul_gate_log | 🟡 | 需新增 |
| 账本 | soul_ledger | 🟡 | 需新增 |
| 注入健康 | GET /v3/soul/injection/stats | ✅ | 无 |
| 快照版本链 | POST /v3/soul/introspect | ✅ | 旧快照缺 version/parent，按降级呈现 |
| 事件可见性过滤 | soul_events.visibility | 🟡 | 读面必须实现，不能交给前端过滤 |
| 关系可验证性 | soul_person_relation.status/confidence | ⚠️ | 回指校验结果未外传，UI 无法标 unverifiable |

## 5. 明确不展示什么，以及为什么

1. **visibility=private 的事件与关系边。** spec §4.1 已定：private 只进本人/代理自我，不进对用户的卡。展示它等于把私密上下文搬到面板。
2. **confidence 过低的推断当事实展示。** 无证据事件只能是 inferred 且 confidence≤0.5（`soul-event-ddl.ts:117-121` 注释即准入判据），必须以「推测」字样出现；工具类证据置信上限 0.9，不能标成 1.0。
3. **未回指成功的关系边。** spec §10 决策 8：零命中/不唯一的边标 unverifiable，「保留事实但不进卡」。UI 同样不该把它当已确认的关系展示。
4. **原始语料全文。** soul_event_action 只存 args_digest 而不存原始参数（`:166-168`），soul_gate_log 只存 action_digest（`:439-441`），注入回执只收长度与指纹（`soul-injection-endpoint.ts:10-14`）。UI 不得为了「看得清」去补原文——这三条是刻意的隐私边界。
5. **soul_snapshots.payload_json。** 整段人设原文，BFF 已明确不外传（`chat-memory-soul.ts:17`）。
6. **没有证据的叙事章节。** spec §6 P6：每章 1–3 条证据；没有证据的章节是心理戏，不该出现。
7. **空态里的合成数据。** 现网已有硬口径：failReasons 为 null 不说「0 次失败」（`chat-memory-soul.ts:668-669`）、trait 缺行不补 0（:583-585）、漏斗缺失不伪造（`SoulStation.tsx:228`）、关系图无数据不造假节点（`MemoryPanel/web/src/starmap/data/graph.ts:7`）。这些口径要在新读面上继续成立。
8. **他人平台的账号 id 明文。** soul_person.platform_id 能外链到具体账号，展示前需按人脱敏或折叠。

## 6. 场景走查

### 场景 1：我想知道它最近怎么看我

1. 人物与关系 → 人物列表：显示名、字段数、关系数、最近更新（`persons[]`）。
2. 点进去 → 九字段画像（称呼/身份/说话方式/喜欢/反感/近况/经历/约定/相处），每条带一条引文与「过期」标记（`fields[].stale`）。
3. 关系段 → 谓词 + 方向 + 原文（`relations[].pred/direction/quote`）；若有五维（需新增读面），显示信任/亲近/尊重/亏欠四个 0..1 数值与最近一次变化的原因。
4. 若五维缺失 → 明确写「只有关系事实，没有连续状态」，不显示 0.5 默认值（v13 §14 口径）。

### 场景 2：我想知道上周发生了什么

1. 事件流（需新增读面）：按天分组，每条显示 actor、action、object、outcome、status、epistemic、来源类型。
2. 点开一条 → 证据列表（role/quote/at），能回到对应的 L0 记录。
3. 同一天的聊天事件折叠成一条「对话」，行动事件单列（tool/test/commit/rollback），失败事件带 error_code。
4. 若某天只有 inferred 事件 → 整段标「推测，无引文」。
5. 空周 → 「这段时间没有留下事件」，不回填日目录节点。

### 场景 3：我想确认它记住的那件事是不是真的

1. 从人格卡某段或某条关系边进入 → 看该条有没有 record_id 与 quote。
2. 有 → 显示引文与时间，可点开原始记录。
3. 没有（unverifiable）→ 显示「未回指到原始记录」，不给「已验证」字样。
4. 若这条来自 narrative 章节 → 显示章节证据条数，0 条则整节不展示。

### 场景 4：我想知道它现在心情怎么样、为什么

1. 当下状态（需新增 turn BFF）：效价/唤醒/支配现值 + 与基线差值（derived 标注）+ 情绪标签与对象。
2. 慢心境（需新增读面）：label、intensity、half_life_hours、cause_event_ids。
3. 下钻 → 最近三条情绪行（现网已有）与支撑它的聊天事件（需新增读面）。
4. 若 soul_mood_state 没有行 → 显示「心境还没有形成」，不拿 soul_state 的值冒充。

### 场景 5：我想知道注入有没有真的生效

1. 运行健康 → 窗口内注入轮数、最近注入时间、最近卡版本与字符数、每轮段字符数。
2. 失败分布 + 服务端只渲染未回报数 + 对账匹配数。
3. journal 关闭 → 显示 note，不说「0 次失败」。
4. 版本链 → 最近若干次卡变更，含 trigger 与 lineDiff/slotDiff；旧快照标降级。

## 7. 需新增读面清单（按优先级）

1. **GET /v3/soul/events**（+ evidence 合并）——事件流是唯一能回答「上周发生了什么」的层，写面已在产数据。
2. **GET /api/v1/chat-memory/soul-turn**（BFF 转发，接口已在）——成本最低，直接补齐「现在」。
3. **GET /v3/soul/person-state**（+ state_events）——关系从「静态事实」升级为「连续状态 + 变化原因」。
4. **GET /v3/soul/goals**（+ goal_events）与 **GET /v3/soul/promises**——承诺与目标是「它答应了什么」的唯一来源。
5. **GET /v3/soul/mood**（mood_state + mood_events）——心境与快情绪必须分开，否则半衰期与基线不可解释。
6. **GET /v3/soul/self-model**（+ calibration）与 **GET /v3/soul/narrative**（+ evidence）——「它怎么评价自己」「这段经历怎么被讲述」。
7. **GET /v3/soul/gate/stats** 与 gate 日志、soul_ledger —— 运维可解释性。
8. 卡块级来源（v13 §9）——决定 UI 能否从「字段级可信度」升级到「段落级可信度」。

## 8. 附：本文引用的关键位置

- 事件底座建表：`MemoryCore/src/core/store/soul-event-ddl.ts:42-78`（soul_events）、`:122-132`（证据）、`:147-163`（聊天）、`:169-182`（行动）、`:185-194`（反思）、`:203-219`（关系状态）、`:226-238`（关系变化史）、`:251-275`（目标）、`:304-320`（自我模型）、`:326-339`（校准）、`:348-360`（心境）、`:363-376`（心境事件）、`:389-406`（叙事）、`:443-456`（gate 日志）、`:479-490`（工作记忆）
- 旧表：`MemoryCore/src/core/store/sqlite.ts:1098`（快照）、`:1142`（状态）、`:1175`（人格条目）、`:1203`（六轴）、`:1215`（标签）、`:1233`（账本）、`:1263`（gate 统计）、`:1280`（episodes）、`:1344`（情绪）、`:1385`（承诺）、`:1401`（承诺事件）
- 人物：`MemoryCore/src/core/store/soul-person-ddl.ts:14`（soul_person）、`:47`（soul_person_relation）、`:84-88`（补列）
- 九字段口径：`MemoryCore/src/core/person/profile.ts:88-119`
- 卡组装与字段来源：`MemoryCore/src/core/soul/card-service.ts:43-46,60,104`
- 规格：`docs/specs/2026-11-10-persona-card-v13-performance-layer.md`（§1、§5、§8、§9、§14）、`docs/specs/2026-11-10-soul-event-model-full-optimization.md`（§4.1、§4.2、§6、§8、§10）、`docs/adr/0028-persona-card-v3-declared-observed.md`（D2–D6）
