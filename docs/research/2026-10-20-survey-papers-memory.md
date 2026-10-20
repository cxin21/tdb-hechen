# 召回精度外部调研 · 长程记忆系统论文域（papers-memory）

- 日期：2026-10-20
- 作者：papers-memory（td-agemem 召回精度调研团队 member-1；Lead=lead；并行成员：papers-rag（RAG 检索域）、repos-bench（开源仓库+基准域））
- 任务来源：2026-10-20 用户拍板「外部调研先行」（skill: tdai-recall-precision-survey-kickoff）。本文件为 Phase 1 论文域产出，只调研不实施；方案取舍一律待用户拍板。
- 唯一写入文件：docs/research/2026-10-20-survey-papers-memory.md。零代码/配置/测试改动；零 git/gh；零记忆库接触。
- 方法纪律：英文定向检索 + arXiv 直查（domain_search engine=arxiv、advanced_search timeRange、web_search、platform_search github、ar5iv 原文比对）。禁中文泛搜通道。
- 可信度标注约定：【正文级】= 原文比对或高置信通识（锚点给出）；【摘要级】= 仅基于 abstract/检索快照。所有实施级细节一律以 repos-bench 源码域复核为准。

---

## 0. 一页速览

### 0.1 最重要发现：本仓底座比病灶描述更完整，多数论文机制是「补差」不是「新建」

2026-10-20 现场只读核实（行号一手）发现，brief 中三类病灶对应的论文机制大多已有落点，缺口是精确且小的 delta：

1. 时效性：bi-temporal 读面已存在（valid_start/valid_end 两路排除 + as-of，见 MemoryCore/src/core/recall/__tests__/bitemporal-two-path.test.ts:1-11），invalidate/restore 写面 API 已有（gateway/__tests__/atomic-invalidate.test.ts）——病灶②缺的只是「写侧自动失效」与「召回排序的内容年龄衰减项」。
2. 衰减：离线遗忘归档门已存在（MemoryCore/src/core/lifecycle/forgetting/scorer.ts:2 公式 significance×priority×decay(age)，λ=0.01，minAgeDays=30）——但只作用于 30 天后的归档决策，对「4 天级过时仍高分召回」无影响。
3. 图结构：l1_links 表已建（MemoryCore/src/core/store/sqlite.ts:823-831）且有写入位点（sqlite.ts:1797）——A-Mem/HippoRAG 类机制的图底座现成。
4. 检索强化记账：recall_count + last_recalled_at 已在召回时回写（MemoryCore/src/core/tools/memory-search.ts:159）——ACT-R 类「频率×近因」衰减口径的两个输入字段现成。
5. 原子化：L1 MemoryType 已有 work_fact/work_task/work_method/work_artifact 细分类型（MemoryCore/src/core/record/l1-writer.ts:32-39），update/merge/skip 操作齐备——Mem0 式管线的容器已就位，缺的是抽取与更新策略。
6. 截断：注入端截断位点已定位且可配置（MemoryCore/src/core/hooks/recall-layered.ts:229，maxCharsPerMemory 缺省 2000 字符/块，config.ts:248-251/1705）——密度问题有现成的改动锚点。
7. 相关性：native hybrid（TCVDB 服务端 RRF k=60，config.ts:128）+ jieba FTS + 本地 reranker（candidates=12，MemoryCore/src/core/recall/rerank/local.ts:360-367）+ query-expand（ark LLM，RTT 2.2-2.4s）已在位——纯「相关性」类的论文药方多数已覆盖，边际收益有限。
8. 评测：golden 集已存在（docs/superpowers/evals/memory-recall-golden/，labels.jsonl + calibration/reanchor JSON）——任何机制落地前可先在该集上量基线。

### 0.2 病灶 × 机制 × 工作量速览

| # | 机制 | 一句话 | 病灶 | 药方类型 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| M1 | Mem0 原子事实抽取+更新操作 | 一条结论拆成 N 条原子事实，矛盾时 ADD/UPDATE/DELETE | ①② | 粒度/密度 | M→L |
| M2 | SeCom 段级记忆构建 | 抽取粒度选「段」而非「整会话」 | ① | 粒度/密度 | S-M |
| M3 | FActScore 原子事实分解 | 事实单元的最小自包含定义 + 评测口径 | ① | 粒度/密度 | S |
| M4 | A-Mem 笔记链接与演化 | 新记忆自动链接旧记忆并触发邻居演化 | ① | 粒度/密度 | M |
| M5 | HippoRAG 1/2 PPR 图检索 | 实体图上 Personalized PageRank 多跳扩展 | ①相关性 | 相关性+粒度 | L |
| M6 | Generative Agents 三因子检索 | recency(0.995/h)×importance×relevance 加权 | ② | 新鲜度 | S-M |
| M7 | MemoryBank 遗忘曲线 | R=e^(-t/S)，检索强化抬升 S | ② | 新鲜度 | S-M |
| M8 | Zep/Graphiti bi-temporal 边失效 | 新旧矛盾事实 → 旧边标失效（不删） | ② | 新鲜度 | M |
| M9 | ACT-R/Oblivion 激活衰减簇 | 频率×近因双因子激活，可衰减可复活 | ② | 新鲜度 | S-M |
| M10 | Letta sleep-time compute | 空闲期离线整理：原子化重写+批量失效 | ①② | 粒度+新鲜度 | M-L |
| M11 | MemOS 生命周期调度 | 记忆状态机：写入→激活→降级→归档 | ② | 新鲜度 | M（概念借鉴） |
| M12 | LangMem 热/后台双路抽取+整合 | 热路径即时抽、后台批量整合 | ①③ | 粒度+表达保真 | M |
| M13 | Memobase profile 型记忆 | 易变状态并入结构化画像而非堆新条目 | ① | 粒度/密度 | M |
| M14 | 2025H2-2026 新工作 roundup | MIRIX/MEM1/Memp/Memory-R1/Hindsight + 综述 | ①② | 参考 | — |

### 0.3 Top 机制清单（贴合度×工作量，详见第 5 节）

快赢层（S / S-M）：

1. 【③】查询入口确定性剥噪（S，无论文依赖的工程项，相邻锚 M12/2606.24322）
2. 【②】内容年龄衰减进 RankSignals（S-M，Generative Agents M6 简化版）
3. 【①】CAL C1 密度优先截断（S-M，recall-layered.ts:229 现位点改策略）
4. 【②】ACT-R 频率×近因衰减口径（S-M，M9，记账字段已就绪）

主攻层（M / L）：

5. 【②】supersession 写侧自动失效 → valid_end（M，M8；读面/API 已就绪，纯补写侧）
6. 【①】Mem0 式原子事实抽取管线（M→L，M1；病灶①主药，分两期）
7. 【①②】Letta sleep-time 离线整理 job（M-L，M10；6 的执行时机）
8. 【①】l1_links 演化（M4，M）/ HippoRAG PPR（M5，L，远期）

---

## 1. 病灶定义与诊断框架

### 1.1 两类失败（诊断 heuristic 的操作化）

用户反馈「召回不沾边」在活体样本（5 条仅 1 条高价值，有效信息率 1/5）中的主因不是主题相关性失败，而是「命中了也用不上」。本文把两类失败分开，每个机制标注其药方类型：

- 相关性失败：检索候选与查询意图/主题不匹配。药方=「相关性药」（改检索算法、query 改写、图扩展）。本仓 hybrid+rerank+query-expand 已覆盖大半，新论文的相关性药边际收益有限。
- 粒度/密度失败：候选主题命中但整条内容是数千字任务打包摘要，注入端头部截断后只剩元信息流水账，模型拿到的是「目录」不是「答案」。药方=「粒度/密度药」（改检索单元、抽取粒度、注入截断策略）。
- 新鲜度失败（病灶②特化）：主题命中、粒度尚可，但内容是过时状态（过时 4 天仍高分）。药方=「新鲜度药」（时间衰减、失效标记、supersession）。

### 1.2 与四类病灶 taxonomy 的对齐

taxonomy skill（tdai-recall-precision-pathology-taxonomy）四类：①检索单元粒度错配；②注入端截断放大低密度；③时效无衰减；④查询侧污染。本 brief 的三类病灶与之映射：brief①=taxonomy①+②（粒度错配是根因，注入端截断是放大器）；brief②=taxonomy③；brief③=taxonomy④。

### 1.3 本仓召回链路现场快照（2026-10-20 只读核实）

链路：入口 MemoryCore/src/gateway/v2-router.ts:1838 handleRecall → query-expand（MemoryCore/src/core/recall/query-expand.ts:271-301 resolveQueryExpansionRunner，ark LLM，RTT 2.2-2.4s；热路等待帽 config.ts:229，R71-C fts-only 降级帽 config.ts:306）→ jieba FTS + dense 混合召回（native hybrid=TCVDB 服务端 RRF k=60，config.ts:128；FTS=jieba cutForSearch OR 连接，sqlite.ts:251-263/297/352）→ 本地 reranker（MemoryCore/src/core/recall/rerank/local.ts:360-367，候选池 candidates=12，config.ts:1763）→ 打分信号加权（MemoryCore/src/core/tools/recall-signals.ts:376）→ MMR 锚选择（MemoryCore/src/core/hooks/soul-anchor-scorer.ts:185）→ 分层注入（钩子路 MemoryCore/src/core/hooks/auto-recall.ts + 工具路 MemoryCore/src/core/tools/memory-search.ts）→ proxy 侧 JIT 注入（MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:267-272）。

路径修正（对 taxonomy 快照的勘误）：query-expand 实际位于 MemoryCore/src/core/recall/query-expand.ts，taxonomy 写的 MemoryCore/src/gateway/query-expand.ts 不准；其余 taxonomy 行号与现场一致。

关键数据面（行号一手）：

- l1_records schema：MemoryCore/src/core/store/sqlite.ts:759-806（content/type/priority 0-100（-1=绝不归档）/scene_name/租户三列/version/timestamp_str,timestamp_start,timestamp_end/metadata_json；soul 幂等 ALTER 列 794-806：occurred_at/valid_start/valid_end/certainty('observed')/source/valence/arousal/significance/sensitivity/importance TINYINT，NULL=未评分=召回降权门不命中）。
- 打分信号：MemoryCore/src/core/tools/recall-signals.ts——:53/:73 DEFAULT_RANK_SIGNALS recencyBoost=0.03；:138 recencySignalOf 仅当 metadata.last_recalled_at 距 now<24h 给 boost（这是「最近被召回→前移」的强化信号，不是内容陈旧衰减）；其余 timeBoost/sigWeight/inferredPenalty/reinforcementWeight/moodBoost/emotionSalienceWeight/sensitivity；importance 乘法门（recall-signals-importance.test.ts:75-78：importance=2→mult 0.7）；接线 memory-search.ts:848/922/941；开关=memory.recall.*（auto-recall.ts:228）。
- 强化记账：recall_count+1 与 last_recalled_at=now 回写在 MemoryCore/src/core/tools/memory-search.ts:159 与 tcvdb.ts:1240（native 路）。
- bi-temporal：读面两路排除+as-of（bitemporal-two-path.test.ts:1-11）；写面 invalidate/restore（gateway/__tests__/atomic-invalidate.test.ts）。缺口=无自动写 valid_end 的 supersession。
- 遗忘归档：MemoryCore/src/core/lifecycle/forgetting/scorer.ts:2 公式 significance×priority×decay(age)；默认 enabled=true λ=0.01、lowThreshold=0.12、minAgeDays=30、maxPerRun=100（:33-43）；执行=forgetting-worker.ts；archiveL1(reason="forgetting")=sqlite.ts:2031/tcvdb.ts:1644 软删。召回排序无内容年龄衰减项。
- L1 写入：MemoryCore/src/core/record/l1-writer.ts:1-17（JSONL 按日分片 append-only+SQLite 主检索；store/update/merge/skip；update/merge 实时删旧向量）；MemoryType=:32-39 persona|episodic|instruction|work_fact|work_task|work_method|work_artifact。
- 反思产物形态（病灶①源头）：MemoryCore/src/core/lifecycle/lifecycle-embed.test.ts:33 llmRunner 返回 [{question, conclusion, evidence}]——整包「结论」条目由此产生。
- 注入端截断（病灶①放大器）：MemoryCore/src/core/hooks/recall-layered.ts:141 selectL2Conclusions；:229 Task CAL C1 截断（maxCharsPerMemory 缺省 2000 字符/块，0=关，尾部 …[截断:原文N字]）；config.ts:248-251/1705；调用点 auto-recall.ts:766。
- 图：l1_links=sqlite.ts:823-831；写入=sqlite.ts:1797。
- 评测：docs/superpowers/evals/memory-recall-golden/{README.md, labels.jsonl, calibration-2026-09-12T02-29-01.json, reanchor-2026-09-12T04-26-51.json}。

---

## 2. 逐机制调研

每节五要素：机制定义 → 针对病灶（药方类型）→ 本仓适配点（文件级）→ 工作量（S<1 天 / M=1-3 天 / L>3 天，按本机 CPU 节流环境保守估）→ 锚点。

### M1 Mem0：原子事实抽取 + 记忆更新操作管线

- 机制定义【正文级，更新操作细节建议 repos-bench 在源码复核】：两阶段写侧管线。抽取阶段：LLM 从近期对话增量抽取候选原子记忆（一条事实一条候选）；更新阶段：对每条候选，取向量近邻的既有记忆作上下文，LLM 以函数调用式决策四操作——ADD（新增）/UPDATE（更新既有）/DELETE（矛盾删除）/NOOP，而非无脑追加。另有 Mem0g 图变体（实体-关系图）。抽象价值：检索单元=原子事实，与「整任务打包摘要」相对。
- 针对病灶：①（主，粒度/密度药——抽取粒度直接决定检索单元密度）＋②（次，UPDATE/DELETE 即 supersession 语义）。
- 本仓适配点：(a) 抽取段——反思管线产出形态 [{question, conclusion, evidence}]（MemoryCore/src/core/lifecycle/lifecycle-embed.test.ts:33）改为「一 conclusion→N 原子事实」的输出契约，落 l1-writer 的多次 store；work_fact 类型已有（l1-writer.ts:32-39）；metadata_json 存 source_message_ids 与 parent_conclusion_id 保留溯源。(b) 更新段——l1-writer 的 update/merge/skip（l1-writer.ts:13-17）即 ADD/UPDATE/DELETE 的容器，delta 是「相似既有记忆作上下文→LLM 决策」的决策器；软删管线已有（update/merge 实时删旧向量），DELETE 优先映射为 M8 的 invalidate 而非物理删（记忆禁删红线下的等价语义）。
- 工作量：抽取段 M；更新段 L（LLM 决策器+回归）。合计 M→L，建议分两期。
- 锚点：论文 https://arxiv.org/abs/2504.19413 ；仓库 https://github.com/mem0ai/mem0 （由 repos-bench 域核源码）。

### M2 SeCom：记忆构建粒度（段级 vs 会话级）

- 机制定义【摘要级】：ICLR 2025 论文，系统研究个性化对话代理的记忆库构建粒度——segment（段）级 vs conversation（会话）级两种构建方式，以及查询-记忆匹配方式，结论指向粒度选择与查询加权对长期个性化质量影响显著。
- 针对病灶：①（粒度/密度药）——为「L0→L1 抽取单元该多大」提供论文依据。
- 本仓适配点：与 M1 组合。现状反思产物=整任务包（conclusion 全文），SeCom 支持把抽取单元缩到段级；query-expand 已有（MemoryCore/src/core/recall/query-expand.ts:271-301），可叠加查询词加权。
- 工作量：S-M（若并入 M1 一期，仅为抽取 prompt 的粒度参数）。
- 锚点：https://arxiv.org/abs/2502.05589 （v3，On Memory Construction and Retrieval for Personalized Conversational Agents）。

### M3 FActScore：原子事实分解（输出契约 + 评测口径）

- 机制定义【正文级】：把长文本生成拆解为 atomic facts——最小、自包含、可独立判真的命题单元，再逐条评价。本文用途不在事实核查本身，而在两点：事实单元的定义范式（写抽取 prompt 的输出契约），与评测口径（把「有效信息率」下放到 fact 级衡量）。
- 针对病灶：①（粒度/密度药——契约与度量）。
- 本仓适配点：(a) M1 抽取 prompt 的输出契约直接采用其 atomic fact 定义；(b) 评测——golden 集（docs/superpowers/evals/memory-recall-golden/labels.jsonl）可加 fact 级标注列，使「召回命中且可用」可量化。
- 工作量：S（契约引用 + 评测列）。
- 锚点：https://arxiv.org/abs/2305.14251 

### M4 A-Mem：笔记链接构建与记忆演化

- 机制定义【摘要级】：Zettelkasten 式原子笔记记忆。三步：note construction（LLM 为新记忆生成关键词/标签/上下文描述）→ link generation（新笔记与既有笔记按语义建立链接）→ memory evolution（新笔记入网后触发邻居笔记的描述聚合与更新，记忆网络动态演化）。
- 针对病灶：①（粒度/密度药——链接让「整包摘要」可被拆解引用与关联，演化让旧记忆描述随新证据更新）。
- 本仓适配点：l1_links 表已建（sqlite.ts:823-831，source_id/target_id/type/strength）且有写入位点（sqlite.ts:1797）——delta 是(a) 写侧自动链接生成（新 L1 落库时 embedding 相似度超阈值即建边）；(b) 演化 job 放入已有生命周期目录（MemoryCore/src/core/lifecycle/consolidation/ 与 anchor-growth.ts 同层）。注意：演化重写元数据时保留原 content（禁删红线下的 append-only 修订）。
- 工作量：M。
- 锚点：https://arxiv.org/abs/2502.12110 

### M5 HippoRAG 1/2：海马体索引 + PPR 图检索

- 机制定义【摘要级】：HippoRAG 仿海马体记忆索引——离线用 LLM 对语料做 OpenIE 抽实体/关系建 KG（新皮层=LLM，海马体=KG）；在线把查询命名实体作 seed 节点跑 Personalized PageRank 单步多跳扩展，得关联段落排序。HippoRAG 2（From RAG to Memory）把段落节点并入图、PPR 与 dense 检索融合，强调连续学习与抗「单跳过拟合」。
- 针对病灶：相关性为主（跨条目多跳），兼 ①（图节点=细粒度实体，天然原子化）。
- 本仓适配点：图底座=l1_links；检索扩展轮加在候选池之后（MemoryCore/src/core/tools/memory-search.ts 的 rerank 前扩展重排）。成本高：OpenIE 管线+图遍历+PPR。建议远期，且先由 repos-bench 在多跳基准上验证收益再立项。
- 工作量：L。
- 锚点：https://arxiv.org/abs/2405.14831 ；https://arxiv.org/abs/2502.14802 

### M6 Generative Agents：recency×importance×relevance 三因子检索

- 机制定义【正文级】：记忆流检索分 = α·recency + β·importance + γ·relevance。recency=0.995^(距上次被检索的小时数)——原文直核：ar5iv 全文「...was last retrieved. Our decay factor is 0.995」；importance=LLM 对记忆打 1-10 poignancy 分；relevance=embedding 余弦；三因子各自归一后加权合成（实现缺省 α=β=γ=1）。
- 针对病灶：②（新鲜度药）——内容年龄进排序的教科书方案。
- 本仓适配点：关键区分——本仓已有 recencyBoost 是「最近被召回→前移」的强化信号（recall-signals.ts:138，last_recalled_at<24h），不是内容年龄衰减。delta：在 MemoryCore/src/core/tools/recall-signals.ts 的 RankSignals 增加 stalenessDecay 项，用 occurred_at/timestamp_start（schema 已有，sqlite.ts:794-796）算内容年龄，e^(-λ·Δt_hours)，仅作用于过程性/状态类条目（work_task/episodic 类；persona/规范类不衰减）；λ config-first 缺省 0=关。importance 列已在 schema（sqlite.ts:806）且乘法门已有（recall-signals-importance.test.ts:75）——Generative Agents 的 importance 因子可把该门从「降权」扩到「正向加权」，同一开关内参数化。
- 工作量：S-M（单信号项+开关+golden 基线对比）。
- 锚点：https://arxiv.org/abs/2304.03442 （全文经 https://ar5iv.labs.arxiv.org/html/2304.03442 核对 decay factor 0.995）。

### M7 MemoryBank：Ebbinghaus 遗忘曲线

- 机制定义【摘要级】：记忆保持率 R=e^(-t/S)，S（记忆强度）随检索/复述事件增大——被反复召回的记忆衰减更慢。主打「silicon friend」人格长期陪伴，含记忆追加/合并/检索强化操作。
- 针对病灶：②（新鲜度药）——衰减与强化统一建模。
- 本仓适配点：与 M6 同一落点（recall-signals.ts 加衰减项），但强度公式换 R=e^(-t/S)，S=f(recall_count)——recall_count 与 last_recalled_at 两个记账字段现成（memory-search.ts:159）。可表述为 M6 的替代公式，A/B 由 golden 基线裁决。
- 工作量：S-M（并入 M6 的信号项内做公式变体）。
- 锚点：https://arxiv.org/abs/2305.10250 

### M8 Zep/Graphiti：bi-temporal 知识图谱与边失效

- 机制定义【摘要级】：时序知识图谱，双时间轴分离——事实有效时间（t_valid/t_invalid，事件实际发生/失效）与系统摄入时间（t_created，事务）。新事实与图内旧事实矛盾时，LLM 判定冲突并使旧边失效（edge invalidation，标 t_invalid 而非删除），无需重算全图；检索为 BM25+向量+图的混合。
- 针对病灶：②（新鲜度药——过时的正解是「失效标记」，不是无限衰减）。
- 本仓适配点：本仓 bi-temporal 读面与写面 API 全部就绪（bitemporal-two-path.test.ts:1-11 两路排除+as-of；invalidate/restore 已有），schema 列现成（valid_start/valid_end，sqlite.ts:795-796）——缺的只是「写侧自动失效」：在反思/consolidation 管线加 supersession 检测（新结论 vs 向量近邻的既有 process/status 条目，LLM 判定矛盾→调 invalidate 置 valid_end），软失效可逆（restore 可恢复），完全符合记忆禁删红线。这是病灶②的正解级方案，与 M6/M9 的衰减项互补（衰减=软排序，失效=硬排除）。
- 工作量：M（supersession 检测器+失效写侧+回归）。
- 锚点：论文 https://arxiv.org/abs/2501.13956 ；产品 https://www.getzep.com ；图引擎 https://github.com/getzep/graphiti （示例仓 getzep/zep，源码细节由 repos-bench 复核）。

### M9 2025H2-2026 衰减/遗忘机制簇（Oblivion / ACT-R / SF-AMS 等）

- 机制定义：
  - Oblivion（Decay-Driven Activation）【摘要级】：指出「always-on 检索」是记忆系统通病——所有记忆永远可达；主张激活度随时间衰减、可被使用/强化复活，由激活度自适应控制记忆是否参与检索。与病灶②病根同构。
  - ACT-R base-level activation（ACM Human-Like Remembering and Forgetting）【通识级】：激活 B=ln(Σ_k t_k^-d)——每条记忆的每次使用时刻 t_k（距今越远贡献越小）与使用频率共同决定激活度；频率×近因双因子，比朴素指数衰减更贴合「常用不衰减、久不用则衰」。
  - SF-AMS（Strategic Forgetting）/ Novel Memory Forgetting Techniques【摘要级】：按相关性×效率平衡的战略性遗忘策略集，供口径参考。
- 针对病灶：②（新鲜度药）。
- 本仓适配点：ACT-R 口径最优——本仓已记账 recall_count（=使用次数）与 last_recalled_at（=最近使用时刻，memory-search.ts:159/tcvdb.ts:1240），公式可直落 RankSignals（recall-signals.ts）替代/并列 M6 的指数衰减；Oblivion 的「激活门控」对应本仓 importance 降权门（recall-signals-importance.test.ts:75）的扩展方向。落地前核对 ACT-R 原典公式细节。
- 工作量：S-M（字段齐全，纯信号项+开关）。
- 锚点：https://arxiv.org/abs/2604.00131 （Oblivion）；https://dl.acm.org/doi/10.1145/3765766.3765803 （ACT-R 簇）；https://arxiv.org/abs/2607.22562 （SF-AMS）；https://arxiv.org/abs/2604.02280 

### M10 MemGPT/Letta + Sleep-time Compute：分页记忆与离线整理

- 机制定义：
  - MemGPT【正文级】：OS 分页隐喻——main context（系统提示内可控区：core memory blocks + recall 检索结果）与 external context（archival storage）之间按需换页；self-editing memory（LLM 函数调用自改记忆）；记忆中断机制提示何时入档。Letta=MemGPT 产品化（memory blocks/archival）。
  - Sleep-time Compute【摘要级】：把推理挪到空闲期——agent 在等待用户时预推理（重组记忆、预答可能问题），降低响应延迟、提升跨轮质量；Letta 以 sleep-time agent 形态落地（空闲期自改 memory blocks）。
- 针对病灶：①②（离线整理=原子化重写与批量失效的执行时机；粒度+新鲜度双药）。
- 本仓适配点：本仓已有后台生命周期骨架（MemoryCore/src/core/lifecycle/ 下 consolidation/、anchor-growth.ts、forgetting-worker.ts）——delta 是新增一个 sleep-time job：空闲期对「整包摘要」型 L1 条目执行 M1 的原子化重写 + 对 superseded 条目批量执行 M8 的 invalidate。JIT 注入侧已有（MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts）。本机 CPU 节流环境注意 job 预算与幂等。
- 工作量：M-L。
- 锚点：https://arxiv.org/abs/2310.08560 （MemGPT）；https://arxiv.org/abs/2504.13171 （Sleep-time Compute，注意不是 2504.10371）；https://www.letta.com ；https://github.com/letta-ai/letta 

### M11 MemOS：记忆生命周期调度（概念借鉴）

- 机制定义【摘要级】：把记忆当作 OS 一等资源——MemCube 统一三类记忆载体（参数记忆/明文记忆/激活 KV 记忆），MemScheduler 按策略调度记忆页的载入/换出/转换，含记忆生命周期管理。有前后两版论文（2505.22101 MAG 前版；2507.03724 正式版，标题经 arXiv abs 页核实为「MemOS: A Memory OS for AI System」）。
- 针对病灶：②（新鲜度药——生命周期视角）；①（弱）。
- 本仓适配点：本仓为 SQLite 单机，无需 KV 载体调度；可借「调度策略」概念把 L1/L2 生命周期显式化（写入→激活→降级→归档的状态机雏形已有：forgetting-worker+archive 桶+l1-writer 版本字段）。收益不确定，优先级低，建议仅在 M8/M10 落地后作为整理框架回顾。
- 工作量：M（若实施）。
- 锚点：https://arxiv.org/abs/2507.03724 ；https://arxiv.org/abs/2505.22101 

### M12 LangMem：热/后台双路抽取 + 语义整合

- 机制定义【摘要级】：LangChain 官方记忆 SDK 的模式集：热路径（对话中即时抽取显式偏好/事实）vs 后台（异步批量整理）；语义整合（semantic consolidation——把语义相关的既有记忆与新信息合并成更新后的语义记忆）；episodic/semantic/procedural 分型组织。
- 针对病灶：①（粒度药）＋③（表达保真药——捕获侧结构化抽取天然把 harness 脚手架挡在记忆库外）。
- 本仓适配点：reflection 管线双模化——热路只抽显式偏好（instruction/persona），后台再跑整合 job（同主题碎片结论合并、密度提升）；整合语义可先在现有 lifecycle-embed 管线内实现（MemoryCore/src/core/lifecycle/）。
- 工作量：M。
- 锚点：https://langchain-ai.github.io/langmem/ ；https://github.com/langchain-ai/langmem 

### M13 Memobase：profile 型用户记忆

- 机制定义【README 级，正文未读】：维护结构化用户画像（主题/子主题的 JSON profile）逐轮增量更新，而非无限堆积事件条目；事件历史与画像双路检索。开源仓库已核实存在。
- 针对病灶：①（粒度/密度药——「易变状态」进画像而非新条目，从源头减少过程性 L1 堆积）。
- 本仓适配点：本仓 L3 persona 与 core memory slots 已是 profile 型（injector :258-277 loadCoreMemorySlots，60s TTL）——delta 是把「易变状态类信息」路由进 profile 更新通道（core slots）而非新建 L1 条目；与 M8 互补（画像=最新态单例，L1=历史轨迹）。
- 工作量：M。
- 锚点：https://github.com/memodb-io/memobase （另 memobase-playground）。

### M14 2025H2-2026 新工作 roundup（广度参考）

- MIRIX（2507.07957）【摘要级】：六类记忆组件（core/episodic/semantic/procedural/resource/knowledge vault）+多 agent 协同管理。对本仓=分层完备性参照（本仓 L0-L3+价值锚+soul 已覆盖多数）。
- MEM1（2506.15841）【摘要级】：RL 训练「每轮把状态收敛为内部记忆」，代理上下文长度恒定。远期参考：把「整包摘要压缩」变成可学习动作。
- Memp（2508.06433）【摘要级】：程序性记忆的 build/curate/retrieve。与 work_method 类条目相关，优先级低。
- Memory-R1（2508.19828）【摘要级】：RL 训练记忆管理操作（与 M1 更新操作同方向，供 repos-bench 对照）。
- Hindsight is 20/20（2512.12818）【摘要级】：retain/recall/reflect 三操作+时间-实体感知记忆层。口径参考。
- 综述簇（Lead 延伸阅读）：2505.00675（记忆原子操作口径——本仓 schema 已覆盖大半操作）；2512.13564（Memory in the Age of AI Agents: A Survey—Forms, Functions and Dynamics）；2602.06052（A Survey of Agent Memory in the Second Half——与 brief「补 2025 下半年新工作」最对口）；2504.15965（From Human Memory to AI Memory，3D-8Q 分类）；ACM TOIS 10.1145/3748302（=2404.13501 刊版）；2509.18868（Memory in LLMs: Mechanisms, Evaluation and Evolution）；2502.06975（Position: Episodic Memory is the Missing Piece——支持「结论条目应向 episodic 原子化」的立场）。
- 相邻（不展开）：2606.24322 记忆投毒防御（non-malleable origin-bound 权限思想可借给病灶③：来源标记帮助识别 harness 脚手架）；2610.17673 用户画像去噪（RALI@iKAT 2026，属 L3 域）。

---

## 3. 病灶③ 查询侧污染：三层药方专节

病灶③：harness 噪音（<acp> 标签、时间戳脚手架等非用户语义文本）直入 FTS/embedding（2026-10-16 reflection 实锤，未修）。论文域没有「剥 <acp> 标签」的直接一手论文（这是 harness 特有工程问题），但有三层可组合的药方：

1. 查询侧入口剥噪（治标，S，最快收益）：在召回入口（MemoryCore/src/gateway/v2-router.ts handleRecall 与工具路 memory-search 入口）加确定性 strip——维护脚手架 pattern 表（<acp ...> 标签、时间戳行、会话元信息行），regex 剥离后再进 query-expand/FTS/embedding。零模型依赖、可单测、可 config-first 关闭。相邻锚：M12（LangMem 抽取只取语义内容的纪律）；2606.24322 的 origin-bound 思想（给文本段打来源标记，区分用户语义与脚手架）。
2. 捕获侧结构化抽取（治本，M，随 M1/M12 落地）：reflection 抽取只输出原子事实（M3 契约），脚手架天然不进 L1——存量噪音随 M10 sleep-time 整理清洗。
3. 查询表达增强（可选，S-M）：HyDE（https://arxiv.org/abs/2212.10496 ）——LLM 生成「假设性记忆文档」再 embed 检索，替代/叠加现 query-expand（ark，RTT 2.2-2.4s，query-expand.ts:271-301）。成本更高，建议仅在 fts-only 降级路（config.ts:306 帽内）或小模型下启用，先量 golden 基线再定。

---

## 4. 病灶 × 机制映射矩阵

| 机制 | 病灶① 粒度/密度 | 病灶② 时效 | 病灶③ 污染 | 药方类型 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| M1 Mem0 | ●主 | ○次 | ○（随抽取治本） | 粒度/密度 | M→L |
| M2 SeCom | ● |  |  | 粒度/密度 | S-M |
| M3 FActScore | ●（契约/度量） |  | ○ | 粒度/密度 | S |
| M4 A-Mem | ● |  |  | 粒度/密度 | M |
| M5 HippoRAG | ○ |  |  | 相关性+粒度 | L |
| M6 Generative Agents |  | ● |  | 新鲜度 | S-M |
| M7 MemoryBank |  | ● |  | 新鲜度 | S-M |
| M8 Zep/Graphiti |  | ●正解 |  | 新鲜度 | M |
| M9 ACT-R/Oblivion |  | ● |  | 新鲜度 | S-M |
| M10 Letta sleep-time | ● | ● |  | 粒度+新鲜度 | M-L |
| M11 MemOS |  | ○ |  | 新鲜度 | M |
| M12 LangMem | ● |  | ● | 粒度+表达保真 | M |
| M13 Memobase | ● |  |  | 粒度/密度 | M |
| ③剥噪（工程项） |  |  | ●主 | 表达保真 | S |
| HyDE |  |  | ○ | 相关性 | S-M |

注：●=主要收益；○=次要收益。

---

## 5. Top 机制清单（按 病灶贴合度×工作量 排序）

### 快赢层（S / S-M，建议先做，全部可 config-first + golden 基线护栏）

1. 【③·S】查询入口确定性剥噪：v2-router handleRecall + memory-search 入口加脚手架 strip（pattern 表 config-first）。直击病灶③，零模型依赖，当天可出。落点：MemoryCore/src/gateway/v2-router.ts、MemoryCore/src/core/tools/memory-search.ts。
2. 【②·S-M】内容年龄衰减进 RankSignals：recall-signals.ts 加 stalenessDecay（e^(-λ·Δt_hours)，λ 缺省 0=关；仅 process/status 类条目）。公式取 M6（Generative Agents 0.995/h）或 M9（ACT-R 频率×近因，recall_count/last_recalled_at 已记账）二选一，golden 基线裁决。
3. 【①·S-M】CAL C1 密度优先截断：recall-layered.ts:229 现为「头部 2000 字符」截断（config.ts:248-251 缺省值）——改为密度优先（保完整事实单元/句子边界+时间戳，或优先保留含数值/结论句），治标但立刻改善注入密度。
4. 【②·S-M】importance 门扩展：把 recall-signals-importance.test.ts:75 的乘法门从纯降权扩为「正负双向加权」，承接 M6 importance 因子。

### 主攻层（M / L）

5. 【②·M】supersession 写侧自动失效（M8 Zep/Graphiti 口径）：reflection/consolidation 管线加矛盾检测→invalidate 置 valid_end。读面（bitemporal-two-path.test.ts:1-11）与 API（atomic-invalidate）已就绪，纯补写侧；软失效可逆，符合记忆禁删红线。这是病灶②的正解，与衰减项互补（衰减=软排序，失效=硬排除）。
6. 【①·M→L】Mem0 式原子事实抽取（M1 一期=抽取段：lifecycle-embed 反思输出契约改「一 conclusion→N 原子事实」，work_fact 类型已有；二期=更新段：ADD/UPDATE/DELETE 决策器，DELETE 映射 invalidate）。病灶①主药。
7. 【①②·M-L】Letta sleep-time 离线整理 job（M10）：lifecycle 下新增空闲期 job——存量整包条目原子化重写（6 的一期对存量跑）+ superseded 批量失效（5 的批量执行）。
8. 【①·M/L 远期】记忆图演化：l1_links 自动链接+邻居演化（M4 A-Mem，M）；HippoRAG PPR 多跳检索（M5，L）——建议 repos-bench 在多跳基准上先证收益再立项。

---

## 6. 域边界与交叉引用

- 属 papers-rag 域（本文不展开，仅交叉引用）：RAPTOR（2401.18059，层级摘要树——与病灶①的分层组织相关）；动态数据集递归摘要（2410.01736）；chunk 粒度/small-to-big/上下文压缩（RECOMP/LLMLingua 类）。注：RAPTOR 与 M1 的组合（树状摘要+原子事实双层）值得 Lead 在汇总时关注。
- 属 repos-bench 域：mem0ai/mem0、letta-ai/letta、getzep/graphiti、langchain-ai/langmem、memodb-io/memobase 源码细节核对；基准评测（LongMemEval/LoCoMo/MemBench 等）与各机制的实证收益。
- 本仓已有衔接文档：docs/research/2026-10-19-r71-recall-relevance-design.md（R71 召回相关性设计；其 R71-C fts-only 降级帽已在 config.ts:306 现场证实存在）——本文机制落地时应在 R71 框架内扩展而非另起炉灶。

---

## 7. 诚实边界

1. Mem-α：两轮检索均未命中一手页面，未纳入本文。
2. Generative Agents：arXiv ID 2304.03442 沿 brief/kickoff 先验（arXiv 引擎标题检索两次失败，改经 ar5iv 全文直核 decay factor 0.995 成功）；三因子归一化细节未逐项复核，落地前以原文/letta 源码复核。
3. MemGPT 的「recency 指数衰减」是 brief 先验：本文未在 MemGPT 论文文本中独立定位该断言，已按 Generative Agents 口径覆盖（M6），MemGPT 节（M10）不作此断言。
4. Memobase：仓库存在已核实（github.com/memodb-io/memobase），机制描述为 README 级，正文细节未读。
5. 【摘要级】机制（M2/M4/M5/M7/M8/M9/M11/M12/M13/M14）仅基于 abstract/检索快照与通识，实施前一律由 repos-bench 源码/正文复核；Mem0 更新操作集（ADD/UPDATE/DELETE/NOOP）为论文+源码通识级。
6. ACT-R 公式为认知科学通识，落地前核对原典（Anderson 等）。
7. 基准评测域（LongMemEval/LoCoMo/MemBench 等）属 repos-bench，本文未展开——本文工作量估计未含基准适配成本。
8. 本仓适配点基于 2026-10-20 现场快照（行号一手），实施前以现场为准；taxonomy 快照的 query-expand 路径已修正（gateway/ → core/recall/）。
9. 本文为 Phase 1 调研，所有方案不实施；取舍与优先级待用户拍板（Lead 汇总后提交）。

---

## 8. 参考锚点汇总

论文（arXiv abs 页）：

- MemGPT 2310.08560 · Mem0 2504.19413 · A-Mem 2502.12110 · HippoRAG 2405.14831 · HippoRAG 2 2502.14802 · Zep 2501.13956 · MemOS 2507.03724（前版 2505.22101）· MemoryBank 2305.10250 · Generative Agents 2304.03442 · FActScore 2305.14251 · SeCom 2502.05589 · Sleep-time Compute 2504.13171 · MIRIX 2507.07957 · Memory-R1 2508.19828 · Memp 2508.06433 · MEM1 2506.15841 · HyDE 2212.10496
- 衰减/遗忘簇：Oblivion 2604.00131 · SF-AMS 2607.22562 · Forgetting Techniques 2604.02280 · Hindsight 2512.12818 · CraniMem 2603.15642 · StatePlane 2603.13644
- 综述：2505.00675 · 2512.13564 · 2602.06052 · 2504.15965 · 2509.18868 · 2502.06975 · ACM TOIS 10.1145/3748302（2404.13501）
- 相邻：记忆投毒防御 2606.24322 · 画像去噪 2610.17673 · 动态数据集递归摘要 2410.01736

仓库/产品：

- https://github.com/mem0ai/mem0 · https://github.com/letta-ai/letta · https://www.letta.com · https://github.com/getzep/graphiti · https://www.getzep.com · https://langchain-ai.github.io/langmem/ · https://github.com/langchain-ai/langmem · https://github.com/memodb-io/memobase

本仓（2026-10-20 现场行号，详见 1.3）：MemoryCore/src/gateway/v2-router.ts · MemoryCore/src/core/recall/query-expand.ts · MemoryCore/src/core/store/sqlite.ts · MemoryCore/src/core/tools/recall-signals.ts · MemoryCore/src/core/tools/memory-search.ts · MemoryCore/src/core/hooks/recall-layered.ts · MemoryCore/src/core/hooks/auto-recall.ts · MemoryCore/src/core/record/l1-writer.ts · MemoryCore/src/core/lifecycle/forgetting/scorer.ts · MemoryCore/src/core/recall/__tests__/bitemporal-two-path.test.ts · MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts · docs/superpowers/evals/memory-recall-golden/

（完）