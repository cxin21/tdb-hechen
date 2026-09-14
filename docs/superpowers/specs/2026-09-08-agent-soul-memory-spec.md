# TDB Agent 灵魂记忆系统 · 设计与规格（受控）

> 文档标识：DS-AGENT-SOUL-MEMORY-001
> 版本：v1.0-draft
> 状态：**草稿（待团队评审）** —— 未开始实现
> 作者 / 日期：hechenk 团队 · 2026-09-08
> 继承输入：`2026-09-08-agent-memory-foundation.md`（方面总览）、`2026-09-08-agent-memory-design.md`（设计收敛）；本文为其**正式受控汇总稿**，后续以本文为准。
> 修订历史：v1.0-draft 初次成稿。

---

## 0. 摘要

把 TDB 的记忆从"检索文档/按需取件"升级为**一套真正的灵魂记忆**——
**记忆（认知）+ 感受（情绪）双轮**,共同长成会演化的自我。核心主张：

> **灵魂 = 此刻的你（状态/价值）+ 过去的记忆（认知）+ 当下的感受（情绪）→ 下一刻的你。**
> 记忆让 agent"记得"；感受让 agent"在乎"。两者都有，才有灵魂。

---

## 1. 背景与动机

- 现状：TDB 有 L0–L3 分层 + priority + Skill，但记忆是"**点状记录 + 按需检索**"，L1 无关联、无时间衰减遗忘、无情感；且当前自动召回拉的是"wiki 业务内容"而非真记忆（用户在思辨轮反复被塞 ERP 业务）。
- 团队共识（讨论收敛）：记忆要"会巩固、会关联、会遗忘、会长成自我"；并补上**感受/情绪**这一半。
- 范围：MemoryCore（L0–L3 存储/生命周期）+ MemoryProxy（注入/召回）+ 记忆工具。wiki 召回相关门控单独跟踪（本文不含，另在 wiki 召回 spec）。

## 2. 目标与非目标

**目标**
1. 记忆带时空性 + 关联性 + 巩固 + 遗忘 + 重构式回忆。
2. 记忆带情感色调 + 核心价值锚 + 当前感受（功能忠实的情绪层）。
3. 长成可演化的自我模型（persona + agent 可维护 core）。
4. 利用层宁缺毋滥、入口真实、保 cache。

**非目标（诚实边界）**
- **不声称 AI 有主观体验/真能苦乐**——情绪层是"功能忠实"（做情绪该做的事），不是假装有心跳。
- 不推翻既有 L0–L3/Skill；在它之上加"记忆网络/情感/生命周期"。
- 不做纯玄学判定。

## 3. 灵魂模型

```
灵魂 = 记忆（认知：时空 / 关联 / 巩固 / 遗忘）
     + 感受（情绪：核心价值锚 / 情感色调 / 当前 appraisal / 动机方向）
     + 当下状态
     → 下一刻的你
```
三条不可妥协红线（评审守则）：
1. **入口真实**：进上下文的记忆须来源可信 + 过绝对相关门槛 + 消毒（防投毒/污染）。
2. **会巩固也会忘**：无时间衰减遗忘 = 不是记忆。
3. **召回是重构不是取件**：宁缺毋滥，且组装上情境与时间。

## 4. 记忆层设计（认知半）

### 4.1 时空性
- 每条记忆：`occurred_at` + `valid_range` + `scene_id(L2)`。
- 同一主题多点状 → 巩固成"持续态摘要"（TSM），非孤点。

### 4.2 关联性（记忆图）
- L1↔L1 显式边（type：因果/相似/冲突/演化；强度 + 时间），写入即关联（A-MEM 式）。
- 层级边 L1→L2→L3 构成"经验→情境→身份"树。
- 邻居召回：沿图组装，非孤儿 top-k。

### 4.3 巩固
- 离线/睡眠式：L1→L2→L3 周期重聚合 + **回忆即重巩固（reconsolidation）**，仅作用于 `observed` 层（见 5.4 约束）。

### 4.4 遗忘
- `重要性 × 时间衰减` → 归档桶（软删、可恢复）> 覆盖合并 > 丢弃。归档优先于删除。

### 4.5 重构式回忆
- 沿时空轴 + 关联网组装"相关记忆 + 场景 + 时间线"；门控宁缺毋滥；只有可信、过门槛的进上下文。

## 5. 感受 / 情绪层设计（情感半）

### 5.1 四个功能职责
| 职责 | 说明 |
|---|---|
| 定重要性 salience | 情绪强度当记忆的"红笔"：高情绪 → 更易进 L2/L3、更难忘 |
| 上情感色调 | 记忆带 `valence`/`arousal`/`significance`；回忆带回"多重要、什么滋味" |
| 当前叠加 appraisal | 每轮由"当下语境 vs 核心价值锚"派生轻量当前状态信号 |
| 动机方向 | 看重/看轻、趋近/回避的方向性，不冷处理一切 |

### 5.2 核心价值锚（core value anchors）
- 一小撮"这个 agent / 用户真正在意什么"的值表，置于 core memory，是**情绪参照系**。
- 无价值锚 → 情绪无从谈起。

### 5.3 情感接入生命周期
写入判情感 → 巩固 `显著性×重要性×时间衰减` → 回忆带情感色调 → 当前感受影响注入 "看重程度"。

### 5.4 诚实约束（防滑坡）
- **reconsolidation 只允许在 `observed` 层**；`inferred` 层锁死不自动重写，防"越回忆越信自己的编造"。
- 情绪层是功能模型，不宣称主观体验。

## 6. 身份 / 自我模型

- persona 由巩固持续喂、随经验演化（不是建完即死）。
- 一小块 **agent 可维护 core memory**（身份/关键偏好/严格规则）锚进 session_init 稳定区（保 cache）。
- 跨会话一致：用得上"我确实喜欢 X"的真记忆，而非重新认识。

## 6.1 实现补遗（2026-09-08 自审 + P0–P5 修订后）

| 项 | 状态 |
|---|---|
| **R1 读回** | ✅ 已实现：`L1SearchResult` 扩字段 + `stmtGetMeta` SELECT 带出新列 + searchL1Vector/queryL1Paginated 映射。G/M/H/I/J 可取 `occurred_at/certainty/情感` |
| **R2 tcvdb 透传** | ✅ 已实现：`L1_OUTPUT_FIELDS` + upsert/upsertBatch doc + `_parseL1SearchResults` 全带出新字段（与 sqlite 一致）|
| **R3 wiki `[overview]` 类型权重** | ✅ 已实现：`typeWeights{overview:0.6}` |
| **R4 端到端实证** | ✅ 已实测：查询 `l1QueryCols`/`queryL1Paginated` 补 soul 列后，atomic/query 真返回 `occurred_at/certainty/valence`；并验证写入补全 |
| **P0 soul 字段 100% 合标**（§7 必填） | ✅ `writeMemory` 终值兜底：`occurred_at?提取时刻` / `source?'extraction'` / `valence?0` / `arousal?0` / `significance?0.5` → 每条新记忆满列（commit `8d2da8a`，实测例外） |
| **P1 K 地基**（core-values §2/§3） | ✅ `core_memory`(identity/core_value/strict_rule)+`core_values` 表 + CRUD(version 留痕) + `/v3/core-memory/read\|write`（agent 可维护）（`9711de2`）。写入口信任边界已接（第三轮 F2：slot 白名单+字长+开关+审计，见 §6.2） |
| **P2 遗忘归档桶**（forgetting §3/§5） | ✅ `l1_archive` 表（整行 JSON + archived_at + reason）+ archiveL1/restoreL1/listArchived + worker 真归档 + **仅 observed 自动归档**（`332005e`）。**待办**：恢复 API/persona 待人工 |
| **P3 重构式回忆·回忆片段**（recollection §2/§3/§4） | ✅ `formatSearchResponse` → 持续态(work_fact)优先 + 时间线分组 + 每条带确定性/情感/重要度（`998de26`）。**待办**：query 时间锚按窗过滤、scene 附着 |
| **P4 G 边补全**（graph §3/§5） | ✅ dedup 支持 `conflict` action + prompt 冲突语义 + 建 `conflict` 边（矛盾双方保留）；evolve/causal **observed-only 门**（`780b5b2`）。**待办**：causal 边、no-dedup top-1 similar |
| **P5 M 演化留痕**（persona §4） | ✅ persona 落盘追加 `<!-- persona-evolution -->` 痕（`513f280`）。**待办**：L2 重聚合、演化痕 ref 结构化、sync core |
| **时空网络/记忆图 UI** | ✅ `l1_links` 邻居口 `getNeighbors` + `/v3/atomic/neighbors` + 面板 L1 灵魂徽章/持续态角标/相关记忆/记忆图（Sigma 力导向、时间 X 播种）；H 巩固持久化建 `part_of` 证据链边 |
| **偏离（已文档化）** | `links` 用独立 `l1_links` 表而非 L1 行内字段（graph 设计一致）；`valid_range`/`scene_id` 仅持续态/待 L2 |

> 评审红线段：reconsolidation 仅 observed、入口真实、归档优先于删除 —— 均已进入 G–M 实现。

## 6.2 第三轮审计（2026-09-09）F2–F7 修复与生产实证

> 对抗审查第二轮发现"修复在纸面、生产零输出"（报告：`reviews/2026-09-09-soul-memory-third-round-audit.md`）；本轮逐项闭环。

| 项 | 状态 | 事实 |
|---|---|---|
| **F0 审计修复入库** | ✅ commit `7565fa0` | 第二轮 A1/A2/A3/B1(遗忘侧)/B3/B4/C 修复 17 文件此前仅在工作区未提交，现已入库 |
| **F2 core 写入口信任边界**（K §4/§5 红线） | ✅ | `core/core-memory/guard.ts` 纯函数校验（slot 白名单 identity/core_value/strict_rule + 2000 字长 + writeEnabled 总开关，config-first `memory.coreMemory`）；handler 拒绝路径 400 + 审计留痕 recordAudit；17 断言全过（`scripts/audit-fix-verify-f2.ts`） |
| **F3 存量 soul 回填** | ✅ 生产已应用 | `scripts/backfill-soul-fields.ts`（确定性 content-soul + created_time 兜底；dry-run→--apply）：生产 124 行回填后 soul 覆盖 182/182=100%（此前 71% 记忆被遗忘引擎忽略——occurred_at 空串恒 age=0） |
| **F4 巩固幂等+租户继承** | ✅ | 同 subject 持续态复用 record_id 版本递增（metadata.subject 幂等键，修"每 10min tick 无限增殖"）；durative 继承源记忆 team/user/agent（修"巩固产物挂默认租户、隔离查询召不回"）；work_fact 不再作源记忆（防摘要自我 reinforce）；13 断言全过（`audit-fix-verify-f4.ts`） |
| **F5 图边生命周期 + restoreL1** | ✅ | 新增 `pruneOrphanLinks()`（清两端均消失的边）；deleteL1/Batch 硬删级联删边（图设计§5 落地）；**抓到存量 bug：restoreL1 INSERT 26 列 27 个 ? 占位符失配 → 恢复恒失败**，已修并补 FTS 重建；11 断言全过（`audit-fix-verify-f5.ts`）；生产 9 条孤儿边已清零 |
| **F6 价值锚单源**（B1 收口） | ✅ | 裁定 **core_values 表为单一源**（K §2 agent 可维护本意）；MemoryCore 启动种子 `memory.coreMemory.seedValues`（表空才灌，幂等，yaml 已配 6 值与 proxy config 对齐）；MemoryProxy L 注入改 `TdaiClient.listCoreValues()`（/v3/core-memory/read，30s TTL）→ 空 fallback config.yaml；**MemoryCore vitest 不可跑，但 MemoryProxy vitest 79/79 全过** |
| **F7 后端边界如实登记** → **T2 已补全（伴生 SQLite 模式）** | ✅（T2，2026-09-10） | G/H/I/K 辅助表（l1_links/l1_archive/core_memory/core_values）TCVDB 后端补全：伴生 SQLite（`tcvdb-aux.db`，dims=0 VectorStore 委托实例），DDL/CRUD **逐字复用 sqlite.ts 既有实现**（单一事实源，零第二份手写 SQL）；图全套（addLink/getNeighbors(filter)/getPath/deleteLinksFor/pruneOrphanLinks）+ 归档桶（archiveL1=删 tcvdb 向量/doc+留归档行、restoreL1、listArchived）+ core 全 CRUD（租户/唯一索引/valence 三方语义）；l1-writer archive 兜底回退硬删分支降为防御（F7 收官，触达即 loud warn）。契约测试 `scripts/verify-t2.ts`（mock tcvdb client + 真实伴生 sqlite + sqlite 后端差分对齐）；**真机实证留部署时**（tcvdb 无本地实例） |
| **遗留（明确不做/待拍板）** | ⏳ | causal 边（dedup 决策无因果语义输入，无生成源；保持待办）；恢复 UI 页（API 已有） |

## 6.3 第四轮：生命周期设计缺口全量补齐（2026-09-09，L1–L3 系列 commit）

> 用户拍板"设计中写了但代码没实现的全部实现并打开"。至此**生命周期六阶段全部闭环**：

| 项 | 设计出处 | 实现 | 验证 |
|---|---|---|---|
| **A core_memory 稳定块注入** | K §3 | `TdaiClient.listCoreMemories` + injector `<core_memory>` identity/strict_rule 块（session_init 稳定区，60s TTL，宁缺毋滥） | proxy 79/79 |
| **B 归档恢复 API** | forgetting §3/§5 | `/v3/atomic/archive/list` + `/v3/atomic/archive/restore`（400 校验 + recordAudit 留痕） | 真机 200/400 实测 |
| **C reconsolidation 正向机制**（B2 拍板项） | H §4 / spec §4.3 | `store.updateL1Metadata`（仅 metadata 合并，**不重写 content** 防"越回忆越信自己的编造"）+ search 命中后更新 recall_count（**仅 observed** 红线）+ 遗忘侧 `recallCountBoost`（每次回忆 +2% 封顶 +10%，临界记忆被回忆救回，防"本该忘的硬顶回"） | 18 断言（verify-lifecycle） |
| **D query 时间锚窗过滤** | recollection §3 | `content-time-window.ts` 纯函数（今天/昨天/前天/N天前/周/月/年/X月解析，解析不出→不过滤宁缺毋滥）+ `timeWindow:"auto"` 接入 atomic/search | 8 断言 |
| **E 片段长度预算** | recollection §7 | `formatSearchResponse(result, maxChars)` 按行贪心截断 + 截断提示 | 含于 18 断言 |
| **F 双召回线统一** | recollection §5 | auto-recall hybrid 排序改持续态(work_fact)优先，对齐工具侧 formatSearchResponse | 含于 18 断言 |
| **G no-dedup top-1 similar 边** | graph §3 | storeAllDirectly 写入后向量召回 top-1 旧记忆建 similar 边（仅 observed，best-effort） | tsx 模块加载 |

> **生命周期闭环总览（六阶段全通）**：捕获 L0 → 写入 L1（soul 满列+建边）→ 巩固 H（幂等持续态+证据链）→ 遗忘 I（打分+归档+**回忆抗遗忘 boost**）→ 重构回忆 J（门槛+图扩展+**时间窗**+持续态优先）→ 使用注入（persona/L2 索引/**core_memory 稳定块**/价值锚/当前感受）。自我模型 M/K 随巩固演化且 core 可由 agent 维护（写入口白名单+审计）。
> 唯一保持待办：causal 边（无生成语义输入）、恢复 UI 页（API 已可用）。H→L2 供料为隐式闭环（work_fact 作为 L1 进 L2 提取池）。

> 生产实证（D:/tdai-data/vectors.db，2026-09-09）：soul 覆盖 100%（182/182）；l1_links 0 孤儿边；core_values 待网关重启后种子灌入；H 巩固在生产仍零输出（真实数据未满足 minCount≥3+跨期≥1d 的同主题分组，属触发条件未达而非代码缺陷——幂等与租户修复后一旦触发即安全）。

## 6.4 已知未实现项与行为耦合登记（第五轮审查，2026-09-09）

> 第五轮对抗性审查（`reviews/2026-09-09-soul-memory-fifth-round-audit.md`，P4-16）拍板"spec 偏离清单补登记"。本表由 P4-T21 逐条核对：每项先引设计原句出处，再给代码 grep 实证（基线 `9f1074f`，不凭记忆），最后给处置。本轮**只登记不实现**；除 #6 为行为耦合登记外，其余处置均为待拍板。

| # | 条目 | 设计出处（原句） | 现状（代码证据） | 处置 |
|---|---|---|---|---|
| 1 | `getPath(a,b,maxHop)` 图路径查询 | memory-graph 设计 §4：「`getPath(a, b, maxHop)`：供 J 重构式回忆用（组装相关记忆时找关联路径）。」 | 未实现：MemoryCore 全仓 grep `getPath` 0 命中（第五轮 G6） | 待拍板（P3-14 "登记或实现"；J 邻居扩展已用 `getNeighbors` 覆盖主需求） |
| 2 | `coreRef: valueId[]`（记忆→价值锚引用） | 本 spec §7 数据模型：`valence: -1..1 \| arousal: 0..1 \| significance: 0..1 \| coreRef: valueId[]` | 零实现：MemoryCore 全仓 grep `coreRef` 0 命中 | 待拍板 |
| 3 | L1→L2→L3 层级边（"经验→情境→身份"树） | 本 spec §4.2：「层级边 L1→L2→L3 构成"经验→情境→身份"树。」 | 零实现：现存 `part_of` 边是 H 持续态→其证据的记忆图证据链（`consolidation-worker.ts:209-211`），并非 L1/L2/L3 层级边 | 待拍板 |
| 4 | 动机方向（motivational charge） | agent-memory 设计 §3b.3 职责4：「**动机与方向（motivational charge）**：给行为一个"看重/看轻、趋近/回避"的方向性——不是冷处理所有请求都一视同仁。」（本 spec §5.1 表第四行同） | 零实现：MemoryCore 全仓 grep `motivational\|动机方向\|charge` 0 命中 | 待拍板 |
| 5 | TCVDB native-hybrid 分支提前 return，跳过 reconsolidation（F7 同族，第五轮 P4-16 登记） | 无设计出处（审计登记项） | `memory-search.ts:177-221` native-hybrid 短路分支在 reconsolidation 块（:427-461）之前 `return`——tcvdb 后端 hybrid 检索命中不触发"回忆即重巩固"；同分支也跳过时间窗过滤/邻居扩展/priority tiebreak | 待拍板（跨后端一致性：native-hybrid 分支补 reconsolidation 收尾，或抽公共收尾段） |
| 6 | `updateL1Metadata` 刷 `updated_time` 被 TTL cleanup"回忆续命"（行为耦合，审计 H-B12） | 行为耦合，无设计出处 | 重巩固更新 `updated_time`（`sqlite.ts:2307`）；L1 TTL 清理按 `updated_time < cutoff` 删行（`deleteExpired`，`sqlite.ts:2399-2426`）——每次被回忆，TTL 顺延一次 | 不做（本轮仅文档化登记：与"回忆即强化"抗遗忘 boost 同向，方向或合理；如需修复须给 TTL 独立判据，待拍板） |
| 7 | `memory.links.minSimilarity` config-first 化 | `l1-dedup.ts:49-56` 注释（T9 裁决原文）：「config-first 化（memory.links.minSimilarity）登记为待办，当前硬编码是裁决（见队长 ledger）」 | `MIN_SIMILAR_STRENGTH = 0.3` 硬编码（`l1-dedup.ts:56`） | 待办（维持 T9 裁决；config-first 化列入后续） |
| 8 | core_values 无删除/更新 API（K7） | core-values 设计 §1：「**agent 可维护**（Letta 式）：agent 能按约定读/改自己的 core（受信任边界约束）」 | 网关对 values 只读（`/v3/core-memory/read` 返回 values，`v2-router.ts:1435`），无 value 写/删路由；`upsertValue` 仅 server 启动种子内部调用（`server.ts:2086-2105`）——"agent 可维护"对价值锚不成立 | 待拍板（T12 已明确"登记为后续"） |
| 9 | 非 default 租户 core_values 恒空（T12 审计 M-5，与 #8 关联） | 无设计出处（T12 审计登记项） | 种子调用不带租户 → 落 default 桶（`server.ts:2092-2096` 直调 `listValues()`/`upsertValue(...)`，`sqlite.ts:1949/1964` normalize 缺省=default）；`listValues(tenant)` 按租户三元组过滤（`sqlite.ts:1968`）→ 其它租户恒读空 | 待拍板（修法：种子按租户扇出或读时 fallback default；与 #8 一并裁定） |
| 10 | knowledge/meta/skill 缓存键 `:`/`::` 分隔符同类碰撞面（T12 fix1/I-1 复审登记） | 无设计出处（I-1 修补时复审登记的同类面） | `knowledge/core-client.ts:152/223/256`（`list:${teamId}:…`、`listByIds:${teamId}:${sortedIds}:…`）、`knowledge-tools-injector.ts:354-373`（`agent:${agentId}` scope 拼进 cacheKey）、注入去重键 `c:${type}::${content}`（`injection/pipeline.ts:524`）——插值段含分隔符即可碰撞。core 租户缓存键已用 JSON 数组序列化根治（T12 fix1），上述其余未动 | 待拍板（同族防护：统一 JSON 键格式；现网身份段受控，实际风险低） |
| 11 | forgetting 链路 metadata 兜底对 soul 列为空的 legacy 行不可见（T17.5 审计 M-4，与 scorer 双兜底策略不一致） | 无设计出处（T17.5 审计登记项） | scorer 时间锚 `??` 兜底链（`scorer.ts:72-76`）被 legacy 行 soul 列默认空串 `''`（非 nullish）短路——`top.occurred_at ?? meta.activity_start_time ?? …` 永走不到 metadata 兜底 → age=0 恒 keep（与第五轮 H-B5 同根）；生产被 F3 回填 100% 掩盖，新库/回滚/兜底遗漏行即复发 | 待拍板（修法：时间锚链空串归一 nullish，或改 truthy 判定） |
| 12 | tcvdb 后端 `searchL1Vector` 的 score 刻度未实证（终审 F-6） | 无设计出处（终审登记项） | sqlite 后端 score = `1 - cosine distance`（0..1 可比）；tcvdb 后端同函数返回的 score 刻度（是否同刻度可比）未实证——影响 `MIN_SIMILAR_STRENGTH = 0.3` 门槛在 tcvdb 后端的语义（门槛可能过松或过紧） | 待拍板（切换 tcvdb 前必须实证 score 刻度是否与 sqlite 的 1-cosine distance 可比；T1 已代码级文档化 `docs/tcvdb-score-semantics.md`） |
| 13 | TCVDB 后端 G/H/I/K 辅助表能力缺失（F7 同族，第五轮审计登记） | 无设计出处（审计登记项） | 收尾计划阶段四 T2 已补全（伴生 SQLite 模式，见 §6.2 F7 行）：图全套/归档桶/core 表全部落伴生 `tcvdb-aux.db`（sqlite.ts 单源委托），l1-writer 硬删 fallback 降为防御分支；契约测试 `verify-t2.ts`（mock tcvdb client + 真实伴生 sqlite + 差分对齐） | 已补全（T2）；真机实证（伴生库落盘路径/权限、embedding 集合 restore 向量重嵌形态）留部署时 |

### 6.4.1 状态刷新（2026-09-10，第三档首批 C1-C4 + 收尾与补全计划后）

> 上表 13 项在本轮批次后的最新状态。源头修复与拍板记录见 `plans/2026-09-10-soul-memory-c1c4-plan.md`、`plans/2026-09-10-soul-memory-remaining-work-plan.md` 与账本。

| # | 状态刷新 |
|---|---|
| 1 getPath | ✅ **已实现**（收尾计划阶段三 C6）：`sqlite.ts getPath(a,b,maxHop,types?,filter?)` BFS 最短路径 + `/v3\|/v2 atomic/path` 路由（租户过滤内置/环路安全/maxHop clamp）；消费方=0（MemoryPanel 接入为后续 UI 项） |
| 2 coreRef | ✅ **已实现**（第三档 C1）：metadata.coreRefs 形态（dedup LLM 顺带判定→防幻觉过滤→落库；召回排序加成 `memory.recall.coreRefBoost` 默认 0.05/展示尾注/遗忘 salience 优先读）。**登记差异**：§7 原设计为顶层列，实现为 metadata_json 形态（数组不适合 SQLite 列；T17.5 修复后 metadata 全链真实可达） |
| 3 层级边 | 🔒 **裁决：不建物理边**（用户拍板"全按推荐"）：scene_name 已隐式表达 L1→L2 归属（一对一关系用边表是冗余）；"情境下探经验"由 L2 索引注入覆盖；"经验熬成情境结论"由 H 巩固覆盖。重开条件：出现多对多归属的真实需求 |
| 4 动机方向 | ✅ **轻量版已实现**（C2）：valence 列（LLM 总结初值+用户微调优先，见下）+ current_feeling 三态方向行。**重机制（影响工具选择/回答结构）维持非目标**——无法同形验证且越过功能性诚实边界 |
| 5 native-hybrid 跳过重巩固 | ✅ **已修**（T1-D）：reconsolidation 块提取为 `triggerReconsolidation` 函数，native-hybrid 早退前同样执行（契约测试钉死）；certainty 门照常适用 |
| 6 updated_time 耦合 | 维持"不做"（文档化登记）——与抗遗忘 boost 同向 |
| 7 minSimilarity | ✅ **已配置化**（S1）：`memory.links.minSimilarity`（默认 0.3，clamp [0,1]），数据流 yaml→parseConfig→pipeline-factory→extractor→两消费点全链贯通 |
| 8 core_values 写 API | ✅ **已实现**（S1）：`/v3\|/v2 core-memory/values/upsert\|delete`（租户隔离+label 消毒+审计+失败 5xx/404） |
| 9 非 default 租户恒空 | ✅ **缓解**（S1 写 API：各租户可自建价值锚）；**预灌种子**（按租户扇出）仍待办（已列入小扫除批） |
| 10 缓存键碰撞面 | ✅ **已收敛**（S2）：knowledge/meta/skill 6 处拼接键改 JSON.stringify 数组序列化（含 K2 ids 逗号歧义二阶发现）；残留：`:`/`::` 同类键的个别低危点已在 S2 报告登记 |
| 11 forgetting legacy 短路 | ✅ **已根治**（T17.5）：scheduler 行映射源头修复（mapL1RowToRecord：id/metadata_json 补全+空串不盖真值）；C4 双兜底统一（summarizer 与 scorer 同构） |
| 12 tcvdb score 刻度 | ✅ **代码级文档化**（T1-A）：`docs/tcvdb-score-semantics.md`——RRF 融合分 ≤0.0328 推演（0.3 门槛会全滤），**真机复验留部署时** |
| 13 辅助表缺失 | ✅ **已补全**（T2，见上表） |

**刷新后仍开放的项**：#9 预灌种子（小扫除批清）、#12/#13 真机实证（部署时）、gateway auxPath 接线（切 tcvdb 模式时一行）、#2 coreRef 列形态 vs metadata 形态的差异如需收敛另立任务。

## 7. 数据模型（字段级，供实现参考）

```
L1 memory {
  id, content, type(persona|episodic|instruction|work_*)
  priority: -1..100
  certainty: observed|inferred | source: string
  occurred_at: ts | valid_range?: [ts,ts] | scene_id?: string
  links: [{ targetId, type: causal|similar|conflict|evolve, strength, ts }]
  valence: -1..1 | arousal: 0..1 | significance: 0..1 | coreRef: valueId[]
  timestamps, version
}
core memory { identity, coreValues: valueId[], strictRules: [] }  # 稳定锚定
```
- 遗忘归档表、记忆图（L1↔L1）、持续态摘要表、核心价值锚表。

## 8. 生命周期

`写入(理解+情感+关联) → 巩固(点→持续态/Q2→Q3) → 遗忘(显著性×时间→归档) → 回忆(重构+重巩固·限observed) → 使用(注入/门控)`

## 9. 利用层（召回/注入/门控/信任）

- 稳定（persona/instruction/core）→ session_init 稳定块（cache 友好）；动态 episodic → on-demand 工具。
- L1 检索：修掉 `_threshold` 无门控，改绝对相关度 + priority 加权 + 类型降权（复用 wiki 召回 teach-out）。
- 宁缺毋滥 + 信任边界：只有 `certainty/source` 可信且过门槛的进上下文。

## 10. 实施阶段

| 阶段 | 内容 | 规模 |
|---|---|---|
| **P1** | 利用层收尾：L1 绝对门控 + priority 加权；`[overview]` 等类型降权；稳定 persona/instruction 锚定 | 小，可立刻 |
| **P2** | 记忆网络 + 时空 + 巩固 + 遗忘（归档桶）+ 情感上色 + 重构式回忆 | 中，核心 |
| **P3** | 自我模型：agent 可维护 core + 反思驱动画像演化 + 跨会话一致评测 | 中 |

## 11. 安全 / 信任边界

- 写入：`observed vs inferred` + `source` 分层；一次随口话不升级成铁律。
- 注入：过滤投毒/污染，长度上限。
- 情绪层冻结 `inferred` 重写；不引入不可信外部记忆进 core。

## 12. 验收与评测

- golden 评测集（记忆版）：Recall@k、Precision@k、跨会话一致、不污染/不投毒样例。
- 指标：记忆网络密度、巩固正确率、遗忘不误删（归档可恢复）、情感显著性与 recall 一致。
- 回归门：既有记忆行为不退化、L0–L3 不丢。

## 13. 待决问题（评审要拍板）

1. reconsolidation 仅 `observed` 层的约束是否够（够则进 v1.1-rc）。
2. 遗忘：先做归档桶（软删）是否可接受为 v1 提交。
3. 感受层到"回答语气/看重程度"的程度——最保守做到哪。
4. P1 是否与 P2 并行、还是串行先在 P2 打通"写入即理解"最小闭环。

## 14. 参考

- 上层文档：foundation.md、design.md（本文汇总）。
- 论文：TSM、Zep(temporal KG)、A-MEM(agentic graph)、MemGPT/Letta(core/archival)、Mem0、睡眠巩固、"Procedural Memory Is Not All You Need"、RMM。
- 开源工程：mem0ai/mem0、letta-ai/letta、WujiangXu/A-mem、aexy-io/graphzep(Zep TS 实现)。