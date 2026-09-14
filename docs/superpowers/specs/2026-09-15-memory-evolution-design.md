# 记忆维度利用与自进化 · 总纲设计（GROW-EVO）

> 文档标识：DS-MEMORY-EVO-001
> 日期：2026-09-15
> 状态：设计稿（分节评审通过，待 user 终审）
> 承接：DS-AGENT-SOUL-MEMORY-001（灵魂记忆）、DS-RECALL-MERGE-001（合并召回）、DS-P5-REANCHOR-001（重锚协议）、GROW-MAINT（价值锚纯自发现，2026-09-15 已上线）
> 依据：维度×消费者全量审计（23 维度×13 消费者，file:line 报告 2026-09-15）+ AGI 记忆系统调研（MemGPT/Letta、HippoRAG 1/2、Mem0、Zep/Graphiti、Generative Agents、MemoryBank、A-MEM、CoALA、SCM、TSM、LongMemEval）

## 0. 问题定义与自治边界

维度写入侧已达论文水准（五灵魂字段 93/93 全量落库），但消费侧大面积空转：`arousal`/`source`/`created_time`/`valid_start/end`（0/93）/`l1_links.created_at`/`metadata.evidence_ids` 零决策消费；九通道与 RV2-2 精排全部 golden A/B 裁决关断；查询 API "存了但查不了"（significance/valence/certainty/scene/priority 均无过滤参数，`time_start/end` 是 schema 死参数）。

**自治边界（拍板 2026-09-15）：受控正文演化**——派生层（失效标记、强度/权重演化、退场归档）全自动；正文合并/改写在高置信条件下自动执行；每次演化必留审计边；原始事实经失效态永久可溯。

**五条红线（全程不变式）**：
1. 【2026-09-15 v3 修订·三信号分层】本地 golden 语料（1246 条）随本地环境丢失（全盘扫描确认找不回），人工标注退出流程。验收 = **信号层 1 构造式真值**（hermetic fixture，答案由构造已知，fixture 生成器程序化演化随语料生长自扩展）+ **信号层 2 不变量断言**（确定性双跑/租户封闭/弃答/时间窗封闭——零标注零循环）两道**硬门** + **信号层 3 LLM 判官标注**（盲评起草 + 对抗复核 + recall_count/conflict 结局使用反馈交叉校验，背离整批作废）**软参考轨**——判官与抽取器同源偏差，永不单独放行排序变更。排序语义变更一律预注册 A/B（相对 on/off 同语料对比；绝对线随判官语料换代不可比，历史 0.345 线退役归档）的纪律不变。
2. 失效不删除：被推翻记忆以失效态保留，历史可溯
3. 演化必留审计边（l1_links type 扩展或 metadata.evolution_log）
4. 租户隔离不回退；auto-recall 钩子路无隔离的口径分裂借机收敛
5. 配置判定原则：运维可调/可开关/经验参数 → yaml；协议不变量、学术常数、安全 clamp、作废 golden 锚点的 → 硬编码+文档注明

**背景债务登记**（审计转来，各期偿还）：时间字段三代同堂口径碎片化、`time_start/end` schema 死参数 ×2、快慢路时间过滤列不一致、R8 数据缺口（钩子路不写 recall_count）、yaml:71 注释过时、valence 同名异义（core_values 枚举 vs l1_records 连续）、硬编码阈值约 10 处、searchL1ByCoreRefs LIKE 全表扫描（R5 复开前置优化）。

## 1. 分期总览（方案一：地基先行）

| Phase | 轨道 | 交付 | 依赖 |
|---|---|---|---|
| P1 | E·验收底座 + 口径还债 | LongMemEval 五能力对齐 golden；快慢路对齐；R8 数据缺口补齐 | 无 |
| P2 | A·失效语义 | conflict→valid_end + durative 效期 + 死参数激活 + valid 区间感知过滤 | P1（知识更新语料） |
| P3 | B·情感维度 | arousal 遗忘调制 + R10 情感显著度实验登记 + 债务清偿 | 无硬依赖（可搭 P2 车） |
| P4 | D·受控正文演化 | evolution-worker（离线重写 + 审计边） | P2（失效设施）+ conflict 频率观察期 |
| P5 | C·排序校准合成 | 离线校准工具产出 yaml 权重 | 触发门槛：L1 ≥ 500 + P1 扩展 golden + 重锚完成 |

并行原则：各 Phase 独立子 spec + plan；P2/P3 可并行；P4/P5 串行在后。

## 2. Phase 2 · 失效语义（A 轨）

### 2.1 数据模型（零新增列）
`valid_start/valid_end`（l1_records 已有列）对齐 Graphiti bi-temporal 语义：valid 区间 = 事实在现实世界成立的区间；`valid_end` 非空 = 已被取代/过期。**失效 ≠ 归档**：归档是遗忘（软删不可见），失效是知识更新（可见、标注"已被取代@date"、默认不进召回）。

### 2.2 写入方（三个）
1. **conflict 自动失效**：l1-dedup 判 conflict 且 action=store → 被推翻旧记忆写 `valid_end = 新记忆.occurred_at`。现状只建 conflict 边（l1-extractor.ts:842 附近）不落失效列——补"边→失效"落库。只失效、不改正文（正文合并归 P4）。**方向性守卫（自审 v1.1）**：仅当新记忆 `certainty='observed'` 才自动失效旧记忆；新记忆为 `inferred` → 只记 conflict 边、不动 valid_end（推断不许冒充事实）。守卫为协议硬编码。
2. **durative 效期提取**：l1-extraction prompt 增加判定——持续型事实（状态而非事件，如"用户用 X 仓库"）标 `durative: true`，`valid_start = occurred_at`，`valid_end` 留空（开放区间）。一次性事件不填（宁缺毋滥）。
3. **手动失效**：`/v3/atomic/update` 支持显式 `valid_end`（agent/人主动纠错），过租户校验。

### 2.3 读取语义（关键决策：进过滤层不进排序层）
- 召回默认：排除已失效（`valid_end IS NULL OR valid_end > now`），**/health 暴露 excluded 计数**（误排除必须是可观测事件，不是无声行为）
- 时间旅行：查询时间窗与 valid 区间**相交**（`window ∩ [valid_start, valid_end) ≠ ∅`）→ 包含失效行（复用 content-time-window 解析）
- R1 valid 区间相交信号（recall-signals.ts:104，已实现 gated）**保持关断**——基线语料无失效行时过滤层逐位不变，零 golden 风险
- 修语义分裂：工具路 `inTimeWindow`（content-time-window.ts:100-107）从只看 occurred_at 升级为 valid 区间感知

### 2.4 API
激活 `/v3/atomic/search` 与 `/v3/conversation/search` 的 `time_start/end` 死参数（v2-router.ts:1356、1001）；`/v3/recall` 增可选 `time_point`；`/v3/atomic/update` 支持 `valid_end`。

### 2.5 配置判定
| 项 | 落点 |
|---|---|
| 失效过滤总开关 `memory.recall.excludeInvalidated` | yaml（缺省 true；false = 逐位现状） |
| durative 提取开关 | yaml（`memory.extraction.durativeEnabled`，缺省 false） |
| 失效判定本身（conflict→valid_end 落库） | 硬编码（协议：失效是 conflict 的确定后效，无调参意义） |
| 时间旅行窗口解析 | 硬编码（content-time-window 纯函数族） |

### 2.6 验收
单测（conflict→失效、durative 提取、过滤语义、时间旅行、租户校验）+ golden 回归（逐位不变证明）+ LongMemEval"知识更新"语料（P1 备好）+ 产出 conflict 边频率数据（供 P4 观察期）。

## 3. Phase 3 · 情感维度（B 轨）

### 3.1 arousal → 遗忘调制（闪光灯记忆）
`effectiveλ = λ × (1 - k × arousal)`，k = `memory.lifecycle.forgetting.arousalRetention`（yaml，**缺省 0 = 逐位现状**；生产建议 0.3）。不对称衰减（|valence|×arousal 联合）留可选项暂不做。
**漂移观察条款（自审 v1.1）**：significance 与 arousal 在 LLM 打分时天然正相关，乘法公式存在双重加成的"情感记忆囤积"风险——上线后观察遗忘候选归档率，漂移超出基线 ±30% 即回 k=0 重新评估。
配置判定：k → yaml；调制公式 → 硬编码。

### 3.2 R10 emotionSalience 实验登记（不开启）
新实现 valence 绝对值 × arousal 的显著度信号通道，weight 缺省 0；进 P1 预注册 A/B 队列，语料过漂移线后与其它候选统一实测（R9 mood-congruent 的教训：手工加权已证伪，情感检索只能走 C 轨校准框架）。

### 3.3 债务清偿（搭车）
yaml:71 inferredPenalty 注释修正（三刀后实为平局组内旗标）；valence 同名异义对照文档 + Panel 文案区分。

### 3.4 验收
遗忘场景单测（k=0 恒等 / k>0 调制方向）；golden 不触碰。

## 4. Phase 4 · 受控正文演化（D 轨）

### 4.1 形态：离线 worker，不进写入链
lifecycle scheduler 新增 `evolution-worker`（与巩固/遗忘/anchor-growth 同款挂钩）；ingestion 路径逐位不变。

### 4.2 高置信门（五条件全过）
① conflict 边存在且 dedup LLM 给了 rationale；② 双方 certainty='observed'；③ metadata.subject 一致；④ 新.occurred_at 晚于旧；⑤ 双方未被 pin/veto。

### 4.3 演化动作
LLM 单次重写（输入双方全文+灵魂字段+rationale → 合并单条）；新记录 `created_by='evolution'`、`metadata.evolution={from,reason}`；两条旧记录写 `valid_end`（复用 P2 设施）；l1_links 萨 `evolved_from` 审计边。失败/低置信 → 只留 conflict 边（宁缺毋滥）；LLM 不可用 → 安静跳过。

### 4.4 配置判定
| 项 | 落点 |
|---|---|
| `memory.evolution.enabled`（缺省 false = 逐位现状）、`maxRewrites`（缺省 3）、调度间隔 | yaml |
| 五条件门、审计边协议、evolved_from 边类型 | 硬编码（协议不变量） |

### 4.5 前置：conflict 频率观察期
P2 上线后观察两周：conflict 边 < 5 条 → 先修 dedup conflict 判定召回率（判定太保守），**不放宽演化门**。观察期遥测按**门条件逐项计数**（五条件各拦多少），将来若放宽有数据依据。此决策点预登记。

### 4.6 验收
单测（五条件门、重写流程、审计边、上限护栏、回滚）+ golden（离线新增记录不改 golden 快照 sha）+ Panel 演化链渲染（graph 加 evolved_from 边类型）。

## 5. Phase 5 · 排序校准合成（C 轨）

### 5.1 形态：离线校准工具，运行时零新组件
`scripts/calibrate-recall-weights.ts`：特征向量（RRF 名次、BM25、cosine、occurred_at 时近、significance、certainty、PPR、coreRef、valence×arousal、recall_count、valid 命中、type 匹配——全部已有实现）× golden 逐 query 相关性标签 → 离线逻辑回归拟合 → **产出写入 yaml**（rerankWeights + 通道旋钮）。服务仍跑现有 RankSignals 管线。

### 5.2 触发门槛（硬性）
L1 语料 ≥ **1200**（对齐自家 A/B 实证先例的语料量级：结构信号 1168 / 三刀复测 1246）且 P1 扩展 golden 就绪且重锚协议完成。触发前只交付脚本（合成语料验证工具正确性，不投产权重——合成分布过拟合风险）。

### 5.3 护栏
预注册 A/B（§4.1 判据）；权重冻结期（两次重锚之间不改）；不做 per-query 动态权重；先修 searchL1ByCoreRefs LIKE 全表扫描（R5 复开前置）。

### 5.4 配置判定
特征抽取器 = 硬编码（协议）；权重 = yaml（校准产物，取代 DEFAULT_COMPOSITE_WEIGHTS 0.7/0.15/0.1/0.05 硬编码）；RRF_K=60 = 硬编码 + 注明（学术常数）。

## 6. Phase 1 · 验收底座（E 轨）

### 6.1 三信号分层验收体系（v3，LongMemEval 五能力映射）
> 【2026-09-15 v3】本地 golden 语料丢失 → 人工标注退出；验收层本身自生长自维护。

| 信号层 | 性质 | 覆盖能力 | 维护方式 |
|---|---|---|---|
| L1 构造式真值（fixture） | **硬门** | 信息抽取、多会话推理、时间推理、知识更新（P1 known-FAIL → P2 GREEN） | fixture 生成器主题包轮换（程序化演化） |
| L2 不变量断言 | **硬门** | 弃答、确定性、租户封闭、（P2 起）失效排除 | 随能力加入自动扩展 |
| L3 LLM 判官 + 使用反馈 | 软参考 | 相关性 P@5 近似（相对 A/B 用） | 漂移越线自动起草；对抗复核；recall_count/conflict 结局回填校验 |

Lane 2 承载：fixture 语料（时间散布 12 条跨 8 个月、冲突对 3 组、多会话 8 条跨 4 session、噪声 10 条）经 store.upsertL1 播种进 hermetic 临时库（BM25-only，确定性）；评估探针 = 四能力断言 + 不变量组；归档 runs/<ts>.capabilities.json。

### 6.2 口径还债（小修）
1. `handleAtomicQuery` legacy fallback 时间过滤列对齐 occurred_at（快慢路统一）
2. 钩子路补 recall_count 计数——**只加计数不刷 updated_time**（拆开写，防扰动 ORDER BY updated_time 排序）；补齐后 R8 复开数据前提成立
3. 时间三代同堂出口径对照表（timestamp_str/start/end 一代 → metadata.activity_* 二代 → occurred_at/valid_* 三代；展示混用、过滤只用三代、遗忘兜底横跨三代——文档化，行为不变）
4. RRF_K 等硬编码常数注释化（文档，不改行为）

## 7. 自审记录（2026-09-15）

1. 不整体换用 Graphiti/Mem0/Letta：四模块+租户+注入管线是实证积累，替换成本 >> 机制搬运；golden 纪律更严。
2. C 不提前用合成语料校准：过拟合 fixture 分布；且校准依赖情感/冲突信号的真实分布（P2-P4 产出）。
3. B 只做遗忘侧：R9 教训（mood-congruent 手工加权小语料实测有害）；情感检索只能进 C 校准框架。
4. D 五条件门可能过严 → 预登记 conflict 频率观察期（§4.5）。
5. 遗漏排查：跨 agent 共享（已拍板 per-agent 排除）；skill/procedural 一致性（out of scope 登记）；注入展示变化影响 KV cache（设计避开）；失效行空间增长（远期物理清理策略登记）。
6. 结论：结构维持，吸收两修正——C=离线工具产出 yaml（非新运行时组件）；D 增加 conflict 频率观察期。

### 7.1 拍板点复审（自审 v1.1，2026-09-15，用户授权"取最优方案"）
1. `excludeInvalidated` 缺省 true：**维持**（升级安全：新旧库均无失效行；false 会造成"写状态读不理"的静默陷阱）+ 新增失效排除计数遥测（§2.3）。
2. `arousalRetention` 0.3：**维持** + 新增归档率漂移观察条款（±30% 带宽，§3.1）——significance 与 arousal 的 LLM 打分正相关，乘法公式有"情感记忆囤积"双重加成风险。
3. P4 严门：**维持**（错误不对称：门严=不触发，良性；门松=错误改写正文，污染难恢复）+ 观察期遥测按门条件逐项计数（§4.5）。
4. P5 触发门槛 500 → **修正为 1200**（对齐自家 A/B 先例语料量级 1168/1246；500 无先例支撑）。
5. 新修正（P2）：conflict 自动失效增加 certainty 方向性守卫（新 inferred 不失效旧 observed，§2.2）；时间旅行语义精确化（窗口与 valid 区间相交，§2.3）。

## 8. 与前沿项目的映射备查

| 机制 | 来源项目 | 本设计落点 |
|---|---|---|
| bi-temporal + edge invalidation | getzep/graphiti | P2 §2 |
| 强度衰减 + 提取强化 | MemoryBank / generative_agents | 已有（decay + recallCountBoost） |
| PPR 图传播 | osu-nlp-group/hipporag | 已有（graph:ppr 通道），C 轨纳入校准 |
| 睡眠期离线整理 | letta-ai/letta sleep-time compute | lifecycle scheduler（P4 evolution-worker 同款承载） |
| 记忆演化（邻居改写） | agiresearch/A-mem + mem0ai/mem0 ops | P4 受控正文演化 |
| 多因子合成 | joonspk-research/generative_agents | P5 校准合成 |
| 五能力验收 | syr-cn/LongMemEval | P1 底座 |
| 情感记忆 | 空白区（2026） | P3 差异化 |
