# L1 记忆属性审计：必要 / 非必要 / 需补充

- 日期：2026-11-04
- 范围：`MemoryCore/src/core/store/sqlite.ts`、`record/l1-writer.ts`、`record/l1-extractor.ts`、`prompts/l1-extraction.ts`、`recall/*`、`hooks/auto-recall.ts`、`lifecycle/forgetting/scorer.ts`、`lifecycle/consolidation/*`、`hooks/soul-assembler.ts`；生产配置 `MemoryCore/tdai-gateway.yaml` + `D:/TDB/data/config-override.json`；生产库 `D:/TDB/data/vectors.db`（只读）
- 口径：**每个属性是否「必要」以生产实际配置为判据，不以代码缺省为判据**（本仓大量开关代码缺省非 0、yaml 却为 0）；主流系统字段来自公开源码审理证据（§5），凭论文未复核的单独标注

---

## 0. 一句话结论

**L1 的属性问题不是「少」，而是「多而窄 + 同一语义多址」**：26 个 DB 列 + 24 个 metadata 键，真正进入生产召回排序的只有 content/隔离三元组/session_key/type/scene/pool 证据/fact 通道/importance(≤4)/recall_count；双时态、置信度、情感、敏感性四族属性「写进去了但读点被权重 0 掐断」——其中 `fusion.mode=normalized` 只给了 `dense/bm25/fact`，**recency 与 validity 权重为 0，于是 #136 软失效（降权保留）在生产是 no-op**，效期只剩注入前 hard 过滤。同时**缺三件主流都有的硬骨头：行级溯源、实体主键、取代指针**。

| 档位 | 数量 | 处置 |
|---|---|---|
| A 必要且在跑 | 13 | 保留，补测试锚 |
| B 必要但半死 | 8 | 接线，或显式从配置面移除 |
| C 冗余/可折叠 | 6 | 停写，不动列（零删除红线） |
| D 缺失待补 | 7 | P0×3 / P1×3 / P2×1 |

---

## 1. L1 属性的三层结构

1. **DB 列（强 schema，26 列）**：`MemoryCore/src/core/store/sqlite.ts:769-816`；灵魂六属性列是幂等 ALTER（:790-812）。索引 :819-848，含 `json_extract(metadata_json,'$.fact_key')` 表达式索引（:839-846，带 `json_valid` 守卫）。
2. **记录对象（写入契约）**：`MemoryCore/src/core/record/l1-writer.ts:77-142` 的 `MemoryRecord`；:307-361 `patchSoulFromContent` 是补全 choke point（`occurred_at ||= createdAt`、`certainty ||= 'observed'`、`source ||= 'extraction'`、`valence/arousal ||= 0`、`significance ||= 0.5`、`sensitivity ||= 'none'`；`importance` 保持 `undefined→NULL` 以区分「未评分」与「低分」）。
3. **metadata 自由字典**：无 schema 约束，生产已出现 24 键，是属性量的真实来源，也是漂移来源（同一语义双址：`sensitivity` 列 5 行 vs `metadata.sensitivity` 4 行；`occurred_at` 列 3919 行 vs `metadata.occurred_at` 35 行）。

> 判据：讨论「某属性是否必要」必须落到**生产配置下的读点**。写入侧由 prompt 硬性要求产出（`prompts/l1-extraction.ts:147` 六字段缺一不可），读侧却可能只被乘一个「配置为 0」的系数。

---

## 2. 生产负载画像（l1_records 4225 行，2026-11-04 实测）

### 2.1 分布

| 维度 | 实测 |
|---|---|
| type | episodic 2286 / work_fact 1114 / instruction 505 / persona 303 / work_method 12 / work_task 5 |
| scene_name | 730 个不同值；`reflection` 924（**全部 type=work_fact**）、`consolidated` 35 |
| version | 0: 2050；1: 1283；2: 266；3: 188；4: 135（>0 全部落在 reflection/consolidated = 巩固卡版本号） |
| l1_archive | 6541 行（**归档量 > 存活量**） |
| 隔离四列 | session_key/session_id/team_id/user_id/agent_id 零空 |
| task_id | **4225/4225 全空** |

### 2.2 空值率 / 覆盖率（判「必要」的硬证据）

| 属性 | 覆盖 | 说明 |
|---|---|---|
| content / scene_name / metadata_json / created_time | 100% | 真必要 |
| occurred_at | 3919/4225（92.8%） | 空 306 行**全部**是 work_fact；`occurred_at == timestamp_str` 仅 667 行 → 84% 是真抽取值 |
| certainty | observed 4067 / inferred 158（3.7%） | 二值，无中间置信度 |
| sensitivity | none 4220 / relationship 3 / finance 2 | 99.88% none |
| valence / arousal | NULL 904 / 904 | 78.6% 有值 |
| significance | NULL 861 | 79.6% 有值 |
| importance | NULL 987（23.4%），其中 **961 是 work_fact 生命周期卡**；非空众数 7(1034)、8(947) | NULL=未评分≠低分，**不可补默认值** |
| valid_start / valid_end | 995 / 136（23.6% / 3.2%） | 双时态稀疏 |
| timestamp_start | **4225/4225 逐位等于 timestamp_str** | 纯重复列 |
| timestamp_end | 仅 632 行 `≠ timestamp_str` | 85% 重复 |
| updated_time | 627 行 `≠ created_time` | 有增量读实现（updatedAfter），但生产零调用方 |

### 2.3 metadata 键频次（>100）

`importance_source` 3238（**取值全为 `llm`**）、`importance_reason` 3238、`coreRefs` 3035（**全部非空数组**）、`subject` 2806（全非空）、`evidence_record_ids` 957、`reflection` 924、`question` 924、`recall_count` 855、`last_recalled_at` 855、`activity_start_time` 747、`facts` 737（全非空）、`activity_end_time` 714、`personRefs` 215、`evidence_ids` 116、`actor` 43（**全为 `agent`**）、`identityRefs` 27、`entity` 25、`attribute_key` 25、`factTriples` 9。
`metadata.created_by` **全空**、`metadata.evolution` **0 行**、`metadata.fact_key` **0 行**（见 §2.5 的解释）。

### 2.4 关系与溯源

- `l1_links` 53964 行：`derived_from` 42051、`similar` 9908、`part_of` 1184、`evolve` 730、`conflict` 91。
- `memory_generation_refs` 9260 行（l1 9138 / l2 64 / l3 58），**可追到 prompt 版本**（`builtin:l1` v1），但仅 3266 行指向存活 L1。
- `memory_audit` 仅 5 行（只有 L2/L3 的 update/delete 审计）。
- `l0_conversations` 14100 条原始消息 —— **原文在，L1 没有指回去的列**（D1）。

### 2.5 生产配置突查（yaml 与 override，判「活/死」的唯一口径）

`MemoryCore/tdai-gateway.yaml`：
- `write.factKey.enabled: true` + `mode: channel`（:83-93）→ 只写 `l1_fact_vec`（682 行），**不写 `metadata.fact_key`**；后者由 `write.factRows` 产出，缺省关（`config.ts:2267`）→ `fact_key` 0 行，事实级失效 `invalidateL1ByFactKey`（`sqlite.ts:4664`）**生产从不触发**。
- `write.supersession.enabled: true` + `cardinalityGate: true`（:94-103）→ 行级 `valid_end` 标记在生产**真的会写**（这就是 136 行 valid_end 的来源）。
- `extraction.facts.enabled: true` + `includeTriples: true`（:110-113）→ `metadata.facts` 737 行是活的，供 fact 通道建键。
- `recall.factChannel.enabled: true, weight 0.6`（:170-172）+ `fusion.mode: "normalized"`，`dense 0.5 / bm25 0.2 / fact 0.3`（:173-177）→ **recency/validity 未给权重 = 0**（`NORMALIZED_DEFAULT_WEIGHTS` 里这两项本就是 0，`fusion.ts:43`）。
- 排序信号（:202-246，配合 override）：`timeBoost 0`、`recencyBoost 0`、`sigWeight 0`、`reinforcementWeight 0`、`moodBoost 0`、`emotionSalienceWeight 0`、`graphDiscount 0`；只有 `inferredPenalty 0.1` 与非 0 的 `importancePenalty 0.3`（override）在跑。

> 由此得到本审计最尖锐的一条：**`occurred_at` / `valid_start` / `valid_end` 三个时间属性同时失去融合读点**（fusion 权重 0 + rankSignal 0），效期只剩 hard 档注入前过滤在管用；`#136` 设计的「降权保留」在生产是空转。

---

## 3. 四档分类

### A. 必要且在跑（13 项，勿动）

| 属性 | 生产读点 | 判定 |
|---|---|---|
| `record_id` / `content` | 全链路；注入行正文 | 必要 |
| `type` | L2 只吃 `work_fact`（`pipeline-factory.ts:1433-1455`）；注入渲染带 type；work_* 四类支撑持续态优先 | 必要，是**分层的唯一分派键** |
| `scene_name` | 结论层聚合、L2 场景块构建、注入渲染（730 值实测） | 必要（但 `sceneBoost=0` → 不参与排序，见 B 档） |
| `session_key`/`session_id`/`team_id`/`user_id`/`agent_id` | 隔离红线；`session_key` 还用于对话检索收敛（`conversation-search.ts:164-165,269-272`） | 必要 |
| `created_time`/`timestamp_str` | 遗忘年龄 `ageDaysOf`（`forgetting/scorer.ts:115-140`）、排序兜底 | 必要 |
| `occurred_at` | 语义上不可替代（事件时间唯一载体，84% 真值）；mood 基线、L2 durative 聚合在用 | **必要但排序没在用**（见 B 档，属接线缺失而非字段冗余） |
| `priority` | 遗忘豁免 `-1 → 1.0 永不归档`（`scorer.ts:65-70`）；注入行渲染 `priority: N`/`(global instruction)`（`memory-search.ts:1750`） | 必要（严格规则分层开关） |
| `significance` | 遗忘主乘子（`scorer.ts:72-85`）、L2 durative 输入 | 必要（遗忘侧唯一活跃情感量） |
| `metadata.coreRefs` | 灵魂锚定证据链：遗忘 refProtection、灵魂装配材料、注入「核心事实」徽章（3035 行全非空） | 必要 |
| `metadata.subject` | 演化/配对 + fact 建键的事实短语来源（2806 行全非空） | 必要 |
| `metadata.facts` + `l1_fact_vec` | fact 通道（737 行 + 682 向量，权重 0.6，`fusion.fact 0.3`） | 必要（生产唯一非零的「新通道」） |
| `metadata.recall_count` / `last_recalled_at` | 遗忘强化 `min(count,5)×0.02`（`scorer.ts:92-97`）；24h 新鲜度信号（`recall-signals.ts:149`，reinforcement 权重 0） | 必要（遗忘侧活、排序侧待接） |
| `l1_links.part_of` / `derived_from` | 结论层证据链（`auto-recall.ts:1560-1620`）、失效沿 derived_from 反向传播（`sqlite.ts:4636-4641`） | 必要（是**证据链与级联失效**，不是图排序） |

### B. 必要但半死（8 项：写满、读点被 0 掐断）

| 属性 | 现状证据 | 判词 |
|---|---|---|
| `certainty` | 二值；只在 `inferredPenalty=0.1` 时乘 0.9（`recall-signals.ts:178-181`、`auto-recall.ts:3849`），3.7% 命中；L2 直接排除 inferred | **语义太弱** → 升级为数值 confidence + 证据计数 |
| `sensitivity` | 99.88% none；`sensitivityPenalty` 未设=0（`recall-signals.ts:188-192`）；遗忘 `sensitivityBias` 未设=0 | **假安全**：红线写着「健康/财务/关系不当外泄」，降权链却是 0 |
| `valence` / `arousal` | valence 只进 mood 基线与 `core-values-discover`（≥+0.2→动机+1）；arousal 只进遗忘 `effectiveλ=λ×(1-k·arousal)`（`scorer.ts:13-15`，k=0.3）；`emotionSalienceWeight=0` | **各剩一条腿**：情感量 2/3 写而不读，且 904 行 NULL |
| `importance` | penalty 0.3 生效但只罚 ≤4（70 行 ≈1.7%），分布右偏（7/8 占 47%，1-3 档 <2%） | 机制对、**标定偏**：先量分布再定阈（与「数值必须实测标定」一致） |
| `valid_start`/`valid_end` | 23.6%/3.2% 覆盖；hard 档注入前过滤生效（`auto-recall.ts:4577-4583`、`validity-policy.ts:59-65` 缺省 hard）；**soft 档靠 fusion.validity 表达，而生产该权重=0** → soft = no-op | **契约与实现脱节**：soft 可配但无效，属配置面失真 |
| `l1_links` 全族（53964 行） | PPR 以 `graphDiscount>0` 为门（`auto-recall.ts:4225`、`memory-search.ts:537-577`），生产 0 → 主召回零调用；`similar/evolve/conflict` 只被 evolution-worker 与 /v3 neighbors 读 | **暗数据**：5.4 万行关系只服务证据链与演化，不参与相关度 |
| `version` | 由巩固写 `(existing?.version ?? 0)+1`（`consolidation-worker.ts:313`），读侧无排序/并发消费 | 名不副实：**派生卡版本号**，非乐观锁 |
| `updated_time` | `updatedAfter` 增量读实现完整，生产零调用方 | 半死：留作 API 面，但当前无人读 |

### C. 冗余 / 可折叠（6 项，停写不动列）

| 属性 | 证据 | 处置 |
|---|---|---|
| `task_id` | 4225/4225 全空，无生产调用方 | 停写 |
| `source` | **零读取**；空串 959 行恰好 = reflection 924 + consolidated 35，信息已被 type+scene_name 表达 | 停写（或仅对 reflection 保留 `'reflection'` 以自解释） |
| `timestamp_start` | **4225/4225 逐位等于 timestamp_str** | 停写，读侧回落 timestamp_str |
| `timestamp_end` | 85% 等于 timestamp_str，仅 632 行有真区间且无读逻辑 | 停写（durative 语义迁移到 `valid_start/valid_end` 已是既成事实） |
| `metadata.importance_source` | 3238 行全为 `llm` | 折叠进 `importance_reason` 前缀或删键 |
| `metadata.created_by` / `metadata.evolution` | 全空 / 0 行 | 从未产出，删键以免误导 |

（`metadata.sensitivity` 键与列重复，仅 4 行 → 收敛到列，删键。）

### D. 缺失待补（7 项）

**D1 行级溯源 `source_message_ids`（P0）**
- 现状：`MemoryRecord.source_message_ids` 存在（`l1-writer.ts:77-142`），prompt 也要求 `message_ids`（`prompts/l1-extraction.ts:50-165`），但 **DDL 无列**；读回 `rowToMemoryRecord` 硬编码空数组（`store/l1-reader.ts:80` 注释 "not stored in SQLite"）。
- 后果：无法「点开一条记忆看原话」→ 审计/抗幻觉/用户质证/人工标注全部退回按时间戳猜。
- 主流：Graphiti `EntityEdge.episodes`（每条事实挂 episode uuid 列表）+ `EpisodicNode.content/source/source_description`；Mem0 用 `hash`。
- 落地：加 `source_message_ids TEXT DEFAULT '[]'`，writer 直落、reader 映射；与 `memory_generation_refs` 互补（消息级 ↔ 生成级）。

**D2 fact 级 confidence + 证据计数（P0）**
- 现状：`certainty` 二值；`metadata.observed_count` 仅 35 行。
- 主流：MemoryBank 用强度随回忆增长；GenAgents 用 importance 单维 + 自然语言理由。
- 落地：`confidence REAL` + `evidence_count INTEGER`（合并 observed_count）；读侧：注入显示、排序替代二值乘子、L2 排除阈值可配。

**D3 actor / 说话人归属（P0，把半成品补完）**
- 现状：`extraction.actorTagging: true` 生产开，但只 43 行且恒 `agent` → 「谁说的」在 L1 层实际不可见；而自述判定、人格归因、尊严红线都依赖它。
- 主流：Mem0 payload `actor_id/role/attributed_to`；Graphiti `EpisodicNode.source`。
- 落地：`actor TEXT`（user/agent/external/system），从 L0 `role` 透传（`l0_conversations.role` 已有确定值），不要交给 LLM 猜。

**D4 实体规范主键（P1）**
- 现状：`metadata.entity` 仅 25 行；无 entity 表；`entity_knowledge` 只有 1 行且是服务注册。
- 主流：Graphiti `EntityNode`（`name_embedding/summary/attributes`）+ `CommunityNode`；Mem0 独立 `_entities` 集合 + `linked_memory_ids`（cos ≥0.95 归并）。
- 落地：`entity`(id,name,type,aliases) + `l1_entity`，与 24 名受控属性（`record/fact-attribute.ts:33-60`）打通——**属性词表已有，缺的是主语**。

**D5 取代指针 `superseded_by`（P1）**
- 现状：行级 supersession 会写 `valid_end`（yaml 开），但缺「旧行 → 新行」正向指针；fact 级失效通道因 `fact_key` 0 行从未生效；`conflict` 边 91 行只被 evolution-worker 读。
- 主流：Graphiti `invalid_at`+`expired_at`+`resolve_edge_contradictions()`。
- 落地：`superseded_by TEXT`，让「为什么这条不再有效」一跳可答，不必 reverse-join 整张 links 表。

**D6 向量/模型版本戳（P1）**
- 现状：`embedding_meta` 表存在，L1 行不带 embed 版本；历史换模造成 2099 行跨模型失真。
- 落地：`embed_model`/`embed_ver`（或统一进 `embedding_meta` 的 generation 概念）。

**D7 locale / lang（P2）**
- 中英混排、BM25 依赖分词，无语言标记 → `lang TEXT`（zh/en/mixed）供分词与渲染策略选择。

---

## 4. 三个根因

1. **写入侧强、读侧弱**：抽取 prompt 硬性六字段（`l1-extraction.ts:147`），但 certainty/sensitivity/valence/arousal/significance 在排序/注入各只被乘一次系数，其中四个系数为 0。
2. **开关默认关 = 属性默认暗**：`fusion` 的 recency/validity=0、rankSignals 七项 0（`tdai-gateway.yaml:202-246`）、`graphDiscount 0`。生产真正生效的只有 `inferredPenalty 0.1`、`importancePenalty 0.3`、遗忘侧 significance、fact 通道 0.6。
3. **同一语义多址**：`occurred_at/sensitivity/certainty/importance` 都有列与 metadata 双址；`timestamp_str/start/end` 三列 100%/85% 重复。多址 = 多处要修 = 漂移。

---

## 5. 与主流记忆系统对标

### 5.1 记忆单元字段清单（公开源码审理证据）

| 系统 | 单元 | 字段（原样） |
|---|---|---|
| **Letta (MemGPT)** | `Block`（~16 字段）/ `ArchivalMemory`(3-4) | Block：`label, value, description, tags`（+limit 等元字段）；三层 core(blocks)/recall(conversation)/archival(向量) + MemFS(git 版 md) |
| **Graphiti (Zep)** | `EntityEdge`(14) / `EntityNode`(8) / `EpisodicNode`(11) | Edge：`uuid, source_node_uuid, target_node_uuid, name, fact, fact_embedding, episodes, created_at, expired_at, valid_at, invalid_at, reference_time, attributes, group_id`；Episodic：`source, source_description, content, valid_at, entity_edges, episode_metadata` |
| **Mem0** | `MemoryItem`(7) + payload | `id, memory, hash, metadata, score, created_at, updated_at`；payload：`user_id, agent_id, run_id, actor_id, role, data, text_lemmatized, attributed_to` |
| **td-agemem L1** | `l1_records`(26 列) + metadata | §1；独有：`scene_name`、`type`(6 值)、`priority`(-1 语义)、`significance/valence/arousal`、`sensitivity`、`valid_start/end`、`metadata.coreRefs` |

### 5.2 三条对标结论

1. **溯源是主流的第一公民，我们是事后补**：Graphiti 把 `episodes` 挂在**每条事实边**上，Mem0 存 `hash`，我们连消息 id 都没落（D1）——本次审计唯一「主流有、我们完全没有」的硬缺口。
2. **双时态主流 5 时间戳全套，我们 6 列但吃一半**：Graphiti 是 `created_at`(入库)/`valid_at`(生效)/`invalid_at`(失效)/`expired_at`(被取代)/`reference_time`(抽取参考点)；我们有 created_time/updated_time/timestamp_str+start+end/occurred_at/valid_start/valid_end——**列比它多，缺 `reference_time`**（「三天前问、今天入库」的先后无法重建），且融合权重为 0 使 soft 档空转。
3. **主流是「少字段 + 强消费」，我们是「多字段 + 弱消费」**：Letta Block 四个语义字段撑起整套人格编辑工具链；Mem0 七个字段但 entity linking 一路打到检索加成；我们 26 列里进主排序的不到 8 列。

### 5.3 图能力（诚实标注）

| 能力 | Graphiti | 本仓 |
|---|---|---|
| 实体节点 + 演进摘要 | `EntityNode.summary` 随事实演进 | 无（D4） |
| 社区/摘要层 | `CommunityNode`/`SagaNode` | L2 场景块 + L3 Persona（**等效但不是图**） |
| 边级双时态 + 矛盾消解 | `resolve_edge_contradictions()` | 行级 valid_end 有；fact 级与自动消解无（D5） |
| 图参与检索 | hybrid：BM25 + cosine + graph traversal | PPR 已实现但 `graphDiscount=0` 关断 |

---

## 6. 与人格系统对标

### 6.1 四条路线

| 路线 | 代表 | 属性哲学 |
|---|---|---|
| 卡片式（静态人设） | Character Card V2 | 一次成型、字段最全：`name, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings, character_book, tags, creator, character_version, extensions` |
| 块式（可编辑块） | Letta `persona`/`human` block | 模型用工具改块：`label/value/description/tags/limit`；强调人设 vs 用户模型分离 |
| 画像式（从记忆归纳） | Mem0 user profile / Zep user summary | 人设是派生，有源头事实 |
| **经由记忆的人格（本仓）** | L1→L2 场景块→L3 Persona Narrative（四层模板 `prompts/persona-generation.ts:43-260`）+ 灵魂六属性（ADR-0003） | 人设必须有证据可回溯；禁伪造当下体验、禁 LLM 直改承诺、红线不软化；宁缺毋滥 |

本仓是四者中**唯一带「真实性边界」契约**的（ADR-0003：解释功能六属性 / 注入三时机 / 真实性三条边界）——这是**领先项**，不是缺口。

### 6.2 人格层现有属性（DB 实测）

| 表 | 字段 | 实测 |
|---|---|---|
| `core_memory` | `slot, content, source, version, updated_at` + 租户 | 仅 4 行：`identity`×2、`self_identity`×1、`strict_rule`×1 |
| `core_values` | `value_id, label, weight, valence, origin, pinned, state, node_type, attrs_json` | 价值锚（带方向与演进态） |
| `soul_state` | `valence, arousal, top_value, turn_seq, updated_at` | 当下态单行 upsert |
| `soul_promises`/`_events` | `content, status, source, ref_key` + 状态事件 | 义务层，独立生命周期 |
| `soul_snapshots` | `ts, content_hash, payload_json, trigger` | append-only 时间旅行 |

### 6.3 人格层四个缺口

| 缺口 | 主流做法 | 本仓现状 | 影响 |
|---|---|---|---|
| **风格样例（few-shot）** | Character Card `mes_example` + `first_mes` | 只有 Layer3「交互协议」文字规则，无一句真实风格样本 | 人格「像不像」靠规则描述而非示范；最便宜的保真度杠杆 |
| **触发式知识条目** | `character_book`（keywords / insertion order / position） | L2 场景块有 META（时间/摘要）但**无触发词**，只能靠语义命中 | 称呼/禁忌/偏好类设定无法「条件必注入」 |
| **人设版本与漂移审计** | `character_version`；Letta 靠 git 版 MemFS | `soul_snapshots` 存全文 payload，无 diff 语义、无版本号、无「为什么改」 | 无法回答「人设何时变、为何变」 |
| **人设 ↔ 事实引用链** | Mem0/Zep 画像可回指源事实 | `metadata.identityRefs` 27 行、`coreRefs` 3035 行，但 `core_memory` 槽无 ref 列 | 画像断言无法逐句证伪，与 ADR-0003「有解释功能」有缝 |

---

## 7. 建议（按成本/收益）

### P0（低成本、补齐主流硬缺口）
1. **`source_message_ids` 落库**：加列(JSON) → writer 直落 → reader 映射 → 注入行按需带前 3 条 id。风险低。
2. **`certainty` → `confidence REAL` + `evidence_count INTEGER`**（合并 observed_count）：排序把二值乘子换成连续权重；L2 排除阈值改配。风险中，需 golden 离线复放对照。
3. **停写冗余**：`task_id`、`source`、`timestamp_start/end`、`metadata.importance_source/created_by/evolution`（零删除：列保留、读侧回落）。

### P1（接线，让已写的属性真生效）
4. **修 soft 档**：给 `fusion` 的 validity 非零权重，或在 soft 档实现「future 硬丢 + expired 确定性后置」，不依赖权重。当前状态是「可配但 no-op」。
5. **`graphDiscount` A/B**：5.4 万条 links 零消费不合理；按 `highLostRounds=0 → highRecall 不降` 判据决定去留，去留都留证据，别留悬空开关。
6. **实体主键最小版**：`entity` + `l1_entity`，只服务「同实体事实聚合」，不追四层图。

### P2（人格系统对齐）
7. **风格样例 3-5 条**进灵魂渲染 few-shot（沿用整行/整锚截断策略）+ **L2 场景块加 `keywords[]`** 触发词 + **`core_memory.version` 接 `soul_snapshots` hash** 形成版本+diff+理由三件套。

---

## 8. 反例与红线

- **不要为对标加字段**：`tokens`/`embed_ver` 若 `embedding_meta` 已能承载就不必进 L1 行。
- **不要删列**（零删除红线）：冗余一律「停写 + 读侧回落」。
- **`importance` NULL 不可补默认值**：987 行 NULL 中 961 是生命周期卡，NULL=未评分≠低分，补 0/5 会误罚。
- **不要把 `actor` 交给 LLM 推断**：`l0_conversations.role` 已有确定值，透传更准更便宜。
- **不要在 normalized 档盲目加 recency 权重**：历史实证 `ageDecay` 乘子在 rank-based RRF 路零差异（`auto-recall.ts:4085-4087` 注释），要么进归一特征、要么别动，且需 golden 复放。

---

## 9. 交叉核对与勘误

- 与 `scratch/l1-attr-audit/field-usage.md`（字段消费审计）对齐后修正两处：①`source` 从「低熵」升级为**零读取 → C 档停写**；②`updated_time` 从「必要」降为 **B 档半死**（updatedAfter 无生产调用方）。
- 本审计前稿曾按「`fusion.mode` 缺省 rrf」推断；实测 yaml 为 `normalized`（`tdai-gateway.yaml:173-177`）。**结论不变**（两种档位下 recency/validity 权重都是 0），但机制表述已按 normalized 改正。
- `docs/audit/2026-10-30-recall-instrumentation.md:62` 的「importance 0/90 罚中」已过期（当时 NULL+关断，现 76.6% 有分且生产开启）。
- 未验证：`l1_vec`/`l1_fact_vec` 的 vec0 精确行数、运行中进程是否加载就是这份 yaml、仓外 UI 是否读 `importance_*`。

---

## 10. 施工定案与版本化勘误（2026-11-04 施工版）

本节是本审计**结论的最终口径**。前文 §2–§7 保留首次取证原貌（审计留痕），凡与本节冲突者以本节为准。

### 10.1 四处事实勘误（只读复核推翻了前文）

| # | 前文说法 | 实测真相 | 影响 |
|---|---|---|---|
| E1 | §3 B 档 `version`：“`v>0` 只在 reflection/consolidated，是派生卡版本号” | v0=2050 / v1=1283 / v2+=892，跨 `episodic/work_fact/instruction/persona/work_method`；11 月新增 178 行。生成点是 `core/record/l1-writer.ts:277-286`（update/merge 时 `max(version)+1`），**是行内容被改写次数**，不是巩固卡版本 | `version` 由「名不副实」改判为**必要**（对外契约号 + 审计字段） |
| E2 | §3 B 档 `arousal`：“`arousalRetention` 缺省 0 ⇒ 恒等” | 生产 `tdai-gateway.yaml:592 arousalRetention: 0.3` ⇒ `effectiveλ=λ×(1−0.3·arousal)`（`lifecycle/forgetting/scorer.ts:144-146`）在跑 | `arousal` 由「只剩一条腿」改判为**遗忘侧活乘子** |
| E3 | §3 B 档 `sensitivity`：“`sensitivityPenalty`/`sensitivityBias` 未设，读侧全 0” | 写侧是**开着**的（`tdai-gateway.yaml:52-53 memory.sensitivity.extractionEnabled: true`），库中 5 行非 none（relationship×3：10-20/10-21；finance×2：11-02） | 不是「写侧也死」，而是**写活、读死** → 重新设计（见 10.2） |
| E4 | §3 B 档 `updated_time`：“updatedAfter 生产零调用方” | 有生产 caller：`src/utils/pipeline-factory.ts:1021-1045`（L2Runner 增量游标）→ `store/sqlite.ts:4970-4979` | `updated_time` 改判为**必要**（L2 增量命脉） |

### 10.2 四档终稿（与 §3 的差异）

- **A 档（必要且在跑）**：`record_id`、`content`、`type`、`scene_name`、`session_*`、`team_id`、`user_id`、`agent_id`、`created_time`、`timestamp_str`、`occurred_at`、`priority`、`significance`、`metadata.coreRefs`、`metadata.subject`、`metadata.facts`+`l1_fact_vec`、`metadata.recall_count`/`last_recalled_at`、`l1_links.part_of`/`derived_from`、**`version`（升 A）**、**`updated_time`（升 A）**、**`valid_start`/`valid_end`（升 A，全链活）**。
- **B 档（必要但半死 → 逐项处置）**：
  | 项 | 终稿 |
  |---|---|
  | `certainty` | **保持**。12 个语义读点里 8 个是「非排序门」（L2 排除 inferred、巩固洗白门、遗忘跳过、演化双 observed、reconsolidation 白名单、recall_count 只对 observed 累加）；`inferredPenalty` 已从跨档乘法降为**平局组内旗标**（`tdai-gateway.yaml:205` 注释自证）。`confidence` 数值化**暂缓**（用户 2026-11-04 决定：等召回优化那条线收口再评估），本仓不新增字段。 |
  | `sensitivity` | **重新设计为「不外泄/不注入」门**，撤销排序降权语义（两个乘子恒 0 且从未验证）→ 见 10.3。 |
  | `valence` | **保持 soul 面**（mood 基线 `hooks/mood-line.ts:17`、`soul-state-machine.ts:90-98`、`lifecycle/identity-discovery.ts:744-749`、`sqlite.ts:2643-2651`）。排序侧 `emotionSalienceWeight=0` 属**按配置关断的能力保留**（同排 timeBoost/recencyBoost/sigWeight/moodBoost/sceneBoost 皆 0），**不删**。 |
  | `arousal` | **保持**（E2：遗忘 λ 调制 + ≥0.7「强烈」徽章）。 |
  | `importance` | 机制对、标定待量（NULL=未评分不可补默认；`importancePenalty` 只罚 ≤4）。 |
  | `valid_start`/`valid_end` | **升 A**。soft 档已从「no-op」修成真沉底（见 10.4）。 |
  | `l1_links` | **保持**。6 个活读点（证据链 smallToBig、场景反查、neighborExpand、conflict 驱动演化、derived_from 级联失效、/v3 neighbors+path）。`graphDiscount=0` 的 PPR 通道是**刻意关断的能力**（`tdai-gateway.yaml:210`：重开前置=修伤害模式后跑 on/off A/B），**不删代码**，因为 `scripts/verify-v2-ppr.ts` 是它唯一的回归证据。 |
  | `version` | **升 A**（E1）；顺带修契约文档：新建行初始 `v0` 而 `gateway/generated/types.ts:360` 写「每次 /atomic/update 自增（初始 v1）」——口径偏差登记待改。 |
  | `updated_time` | **升 A**（E4）。 |
- **C 档（冗余 → 真删或接活）**：`task_id`（**勘误：写读链全通，缺生产者，见 §10.6**；本批保留为可选契约）、`source`（零读点 → 删列）、`timestamp_start`（与 `timestamp_str` 4225/4225 恒等 → 删列 + 删两条死索引，投影改取 `timestamp_str`，对外 `created_at` 值逐位不变）、`timestamp_end`（保留列，语义=事件区间右端；`updated_at` 取自它属既有口径偏差，待 /v3 版本并行）、`metadata.importance_reason`（停写）、`metadata.importance_source`（**保留**：区分 manual/llm，是 /atomic/update 唯一防篡改痕迹）、`metadata.created_by`（删写入）、`metadata.evolution`（**保留**：`auto-recall.ts:4808`「已演化」徽章）。`metadata.sensitivity` 键收敛到列。
- **D 档（缺失待补）**：D1 行级溯源 `source_message_ids` **已落库**（见 10.5）；其余（实体主键最小版、fact 级 confidence、`superseded_by` 指针、locale/lang、embedding 版本戳）仍待补，本批未做。

### 10.3 sensitivity 的终稿语义（替代「降权」）

- 语义：**「这条内容不该出现在第三方可见上下文里」**，不是「相关度低」。
- 实现形态：写侧照旧标注（`none|relationship|finance|health`）；读侧**注入门**——非 none 行只在私有/单聊上下文注入，群聊/团队共享/跨用户请求一律不注入；被拦行可观测计数。
- 撤销：`recall-signals.ts` 的 `sensitivityMultiplierOf` 与 `forgetting/scorer.ts` 的 `sensitivityBias`（两者生产恒 0，从未验证过效果）。
- 保留：注入行「敏感:健康/财务/关系」徽章（`auto-recall.ts:4793-4794`）。

### 10.4 soft 效期档：定案「修」而非「撤」

- 判据：ADR-0010:11 实测 hard 档 `turnCov −10.9pp`（CI[−17.0,−5.7]）；soft 是设计正确的方向，缺陷在**实现没落地**。
- 根因：钩子路用 `sorted.filter(...).map(...)` 从原数组重算，丢弃了 `selectByValidity` 的 `kept` 顺序 ⇒ 过期行原地不动，soft 退化成「只改分数」，而生产精排权重全 0（比较器恒等）⇒ 完全失效。
- 修法：`core/recall/validity-policy.ts:237-243` 新增 `applyKeptOrder(items, kept)`（身份键 Map 排名保序，不在 kept 者剔除），`core/hooks/auto-recall.ts:4494` 起改用它重排；journal 的 `gates.validity` 增 `demoted` 计数（`recall-journal.ts` 接口同步）。`hardOnPresentIntent` 分支**已被单测覆盖且可达**（`recall/__tests__/validity-policy.test.ts:43-69` 三例），生产 0 触发是**数据态**（库级 0 行「同 subject 有效取代」），不是死代码。
- 遗留：`relevanceNorm` 归一顺序（软降权乘在池内 max 归一之前，会把降权行的分母一起拉小 → 权重非 0 时反向升权）由本批一并修。

### 10.5 已落库能力：行级溯源 `source_message_ids`

- DDL：`MemoryCore/src/core/store/sqlite.ts:787-789` `source_message_ids TEXT NOT NULL DEFAULT '[]'` + `:819-821` 幂等 ALTER（老库自动补列）。
- 写：`upsertL1`（`:1065-1066`/`:1092`/`:1810-1812`）、`archiveL1`/`restoreL1`（`:2128`/`:2191-2204`）、`queryL1Paginated`（`:5923`）。
- 读：`store/l1-reader.ts` 统一 `l1-column-coerce.ts` helper 解析；`getL1ByIds` 链路（`sqlite.ts:1104-1111`/`:3714-3728`）与三条编辑重建链（`gateway/v2-router.ts:1495/1609/1720`）全部透传，**编辑不再刷空溯源**。
- 顺带修既有缺陷：`l1QueryCols`（`:1604-1606`）此前漏选 `sensitivity`/`importance`，读侧一直拿不到这两列。
- 测试：`core/store/__tests__/l1-source-message-ids.test.ts`（12 例）+ `gateway/__tests__/atomic-source-message-ids.test.ts`（3 例），含老库补列、非法 JSON、归档往返、编辑往返逐位相等。


### 10.6 待拍板：`task_id` 维度是保留为契约，还是整轴退场

**勘误**：§3-C 与 §10.2 原写「`task_id` 接写入侧」**不成立**——写读链本来就通（逐跳见 ADR-0025 决定 3 的勘误段）。真实缺口不是代码断链，而是**生产者被删**：`iso.taskId` 的上游来源是 TDAI MemoryProxy 的 preset/task 头，而 MemoryProxy 整个包在 DSH 特化波次已删除（272 文件 / 62926 行）；本仓唯一客户端 `dsh-plugin` 构造请求时从不发 `iso.taskId`。于是 14100 条 L0 与 4225 条 L1 的 `task_id` 全空，五处读侧过滤恒不生效，但都「有代码在用」。

**实测可达面（若保留）**：
- 写：`v2-router.ts:1080` → `sqlite.ts:5071`（L0）→ `pipeline-factory.ts:810` → `l1-extractor.ts:606/622/626` → `l1-writer.ts:321` → `sqlite.ts:1800`（L1）。
- 读：`sqlite.ts:4922`（queryL1）、`:5007`（内存过滤）、`:5415`（L0 分页）、`:5833/:5896`（两处列表）、`v2-router.ts:1278/1324/1806`（atomic 系列按 task 收窄）。
- 展示：`MemoryPanel/web/src/pages/ChatMemoryPage/components/block-detail/AttributesSection.tsx:160`。
- **缺**：注入钩子路（`core/hooks/auto-recall.ts`）完全不读 taskId——即便某会话被标了 task，主召回也不会按 task 收窄。这是「保留派」必须补的一环。

**两条路与代价**：

| 方案 | 动作 | 代价 / 风险 | 收益 |
|---|---|---|---|
| A 保留为可选契约（本批默认） | 补往返+收窄测试证明轴可用；CONTEXT.md 写明「可选业务维度，缺省=不限」；**可选**再补钩子路 task 收窄 | 生产继续 0 填充 = 数据层空挂；契约面留着没人用的参数 | 不破坏对外 `iso.taskId`；上游同步零摩擦；将来接 task lens 时零迁移 |
| B 整轴退场 | 删列 + 删索引 `sqlite.ts:834` + 删 `store/isolation.ts:143-146/:160-168/:81-99` 的 task 轴 + 删 5 处过滤 + 删 `v2-router.ts` 15 处 + 删面板展示 + 删 `docs/tdai-v2-technical-ops.md` §8 | 属 **/v3 API 字段删除**（外部调用方传了会被无视而非报错）；与上游同区长期分叉；工作量约 1.5 人日 + 全量门 | 彻底消除「有代码无数据」的第五轴；隔离模型回归四维（team/user/agent/session） |

**定案（2026-11-04）：按 A 收口**（用户既已令「无用即删」，但这里「无用」是**部署事实**而非代码悬空；删的是对外契约字段，属 API 面变更，代价不对称）。若用户要 B，按上表逐项执行并补一条 ADR 勘误说明「task lens 能力随 MemoryProxy 一并退场」。
### 10.7 施工实录（2026-11-04）：每条决定的代码锚点

> 本节只记录**已落地**形态与可核对锚点，不重复 §10.2 的判定理由。所有改动均未提交（工作区含他人在途 WIP，禁 git 写）。

**D1 行级溯源**：`store/sqlite.ts` DDL `:787-789` + 幂等 ALTER `:819-821`；upsert 绑定 `:1859-1861`；archive/restore `:2244`（25 列）/`:2307-2320`；读侧归一 `store/l1-column-coerce.ts:12/17/25`（唯一实现）→ `record/l1-reader.ts:83`；三条编辑链透传 `gateway/v2-router.ts:1495/1609/1720`。**粘性语义**：ON CONFLICT 改 `source_message_ids=COALESCE(NULLIF(excluded.source_message_ids,'[]'), source_message_ids)`（`sqlite.ts:1126`）——「本次没带」与「清空」不可区分，一律按没带处理（只增不减）。

**D2 零读列退场**：`source` 从 `SOUL_COLUMNS`（`store/soul-columns.ts:8-11`）移除 → DDL/幂等 DROP（`sqlite.ts:829-846`）/FTS v6 重建（`migrateFtsTablesIfNeeded` :6775-6794）/archive-restore 25↔25；`timestamp_start` 删列 + 删 `idx_l1_ts_start`/`idx_l1_ts_end`，全部投影改取 `timestamp_str`（`record/l1-reader.ts:69`、`gateway/atomic-query-fields.ts:58`、`tools/memory-search.ts` 7 处 `created_at`）；`metadata.importance_reason` 停写（`record/l1-extractor.ts:1098`）+ prompt 删理由要求（`prompts/l1-extraction.ts:550`）；`metadata.created_by` 删写（`lifecycle/evolution-worker.ts:278`）。
**未做的一处（诚实缺口）**：`metadata.sensitivity` 存量 4 行仍在（写侧已只写列），读侧以列 `sensitivity` 为准、metadata 键无消费点，故不构成双源，留待下次归档批一并清理。

**D3 task_id**：§10.6 已记「写读链通、缺生产者」。本批补 `store/__tests__/l1-task-isolation.test.ts`（7 例）证明 L1/L0 往返 + broad recall + 粘性；并修同族缺陷：`task_id=COALESCE(NULLIF(excluded.task_id,''), task_id)`（`sqlite.ts:1107` L1、`:1254` L0）——先前同 record_id 二次写不带 taskId 会把已存值刷成空串，等于把记忆从隔离桶里抹掉。

**D4 sensitivity 注入门**：纯函数 `recall/sensitivity-policy.ts`（`SENSITIVE_AUDIENCE_ALLOWLIST:81`、`decideSensitivityInjection:164`、`partitionBySensitivity:208`、`audienceOfOwnerScope:251`）；钩子路 `hooks/auto-recall.ts:4639-4675`（计 `gates.sensitivity`），工具路 `tools/memory-search.ts:1874` `gateSensitivityForInjection`（两个 trim 点 `:1236`/`:1715`，计 `result.sensitivity`）；journal 接口 `recall/recall-journal.ts:202-207`。删除死乘子：`tools/recall-signals.ts` `sensitivityMultiplierOf`、`forgetting/scorer.ts` `sensitivityBias` 及两个 config 键（生产 yaml 从未设过，零迁移）。测试 `hooks/__tests__/auto-recall-sensitivity-gate.test.ts`（7 例）+ `tools/__tests__/memory-search-sensitivity-gate.test.ts`（6 例）+ `recall/__tests__/sensitivity-policy.test.ts`（25 例）。

**D5 soft 效期**：`recall/validity-policy.ts:237` `applyKeptOrder`；钩子路 `auto-recall.ts:4526` 按 kept 重排（先前用 `filter+dropped` 丢序）→ 生产 `rerankWeights` 全 0 时沉底仍生效；journal `demoted` 计数 `:4747`。**本次补第二半**：降权前分母 `relevancePreSoft`（`auto-recall.ts:4503-4523` 采集 → `:4570-4576` 传第 6 参），与工具路 `memory-search.ts:809` 的 `relevanceScalePreSoft` 同口径；`compositeScoreOf:764-767` 加 `Math.min(1,…)` 上界钳制防撑破权重。

**D6 certainty**：不动（保持二值），本批仅补 §10.2 的语义说明。

**D7 关断能力不删**：PPR（`tools/memory-search.ts:537-585`、`auto-recall.ts:4198-4217`）与 `emotionSalienceWeight` 排序分支保持关断 + 回归脚本 `scripts/verify-v2-ppr.ts`、`verify-ra1.ts` 作为重开证据；删它们=销毁回归证据。

**D8 人格层两缺口**：见 ADR-0025 决定 8 的锚点段。要点补充：`soul_snapshots` 四列 `sqlite.ts:937` + 幂等 `:973-976`；`writeSoulSnapshot:2829` 幂等不刷版本；受控原因 `hooks/soul-versioning.ts:13/166`；L2 触发词 `scene/scene-keywords.ts`（`normalizeSceneKeywords`/`matchSceneKeywords`）、META 第五行 `scene/scene-format.ts:74-81`、注入 `hooks/recall-layered.ts:253-286`、预算让位 `:312-343`、观测 `hooks/auto-recall.ts:1357-1367` + journal `layeredKeywords`（`recall/recall-journal.ts:411-420`，同一份计数三处留痕同源）。**裁定（Lead 2026-11-04）**：触发词命中**越过** `minUniqRatio` 密度门——显式意图优先于启发式补位；`scene_block` identity 门保留在触发判定之前（含人设回显的块即便命中也不注入）。

### 10.8 门禁与诚实边界（本批终态）

| 项 | 结果 |
|---|---|
| 测试面（hooks + tools + recall + store + scene + lifecycle） | 247 files / 2284 tests 全绿（含本批新增与既有红基线修复）；另 `recall-journal.test.ts` 8 例含新增 `layeredKeywords` 往返 |
| 未提交 | 是（工作区含他人在途 WIP，全程零 git 写） |
| 未验证 | LLM 是否稳定产出 `keywords` 行（只测 prompt 形态/解析/裁剪）；触发词的存量块回填（无回填脚本，靠后续 L2 抽取自然回填） |
| 已知遗留 | `metadata.sensitivity` 存量 4 行；`updated_at` 仍取 `timestamp_end`（改指 `updated_time` 属 /v3 语义变更，需版本并行）；task_id 生产者仍缺（§10.6 待拍板） |

