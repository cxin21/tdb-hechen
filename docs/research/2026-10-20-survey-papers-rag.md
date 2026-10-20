# RAG 检索粒度、压缩与检索算法域调研（papers-rag）

- 日期：2026-10-20
- 作者：member-2 papers-rag（召回精度调研团队；lead=lead，成员 papers-memory / repos-bench 并行）
- 服务对象：td-agemem（TDB 自进化记忆系统，本机 Windows 部署，SQLite 存储）
- 配套域：长程记忆系统论文域见 2026-10-20-survey-papers-memory.md（member-1）；开源仓库+基准域见 2026-10-20-survey-repos-bench.md（member-3）。本文不越界。
- 纪律声明：本文为只读调研产出。全程零代码/配置/测试改动、零 git/gh 操作、未触碰 D:/TDB/data/vectors.db、零删除/零注入任何记忆数据。所有结论带一手来源锚点（arXiv abs 页 / 官方文档 / DOI），先验有误处已如实改写并标注。

## 0. 病灶对照框架与诊断 heuristic

三类病灶（lead 下发，2026-10-20 活体样本 5 条仅 1 条高价值）：

- **病灶① 检索单元粒度错配（最重）**：L1「结论」条目=整任务打包摘要（数千字）整条召回+注入端截断（只留头部元信息流水账），embedding 主题虚高、单条信息密度极低。
- **病灶② 时效无衰减**：过程性状态条目过时 4 天仍照常高分召回，无衰减/失效标记。
- **病灶③ 查询侧污染**：harness 噪音（<acp> 标签、时间戳脚手架）直入 FTS/embedding（2026-10-16 reflection 实锤，未修）。

**诊断 heuristic**（本文所有机制均按此标注）：用户说「不沾边」≠ 主题相关性失败，主因常是「命中了也用不上」。因此每个机制标注两类药方之一：

- **【相关性药方】**：修"该命中的没命中 / 不该命中的命中"——特征是 rerank/改写/过滤/融合层改动。
- **【粒度/密度药方】**：修"命中了也用不上"——特征是检索单元、上下文回填、注入压缩层改动。**rerank 再强也修不了粒度问题**（对整条摘要 rerank，密度问题依旧）——这是本文最重要的分辨结论。

### 0.1 本仓现场快照核实（2026-10-20 只读，与 lead 下发快照的偏差已标注）

| 项 | lead 快照 | 现场核实（2026-10-20） |
| --- | --- | --- |
| 召回入口 | v2-router.ts:1838 handleRecall | **v2-router.ts:1841** handleRecall（v2-router.ts:580 注册 /v3/recall）；另 server.ts:1821 有同名方法 |
| 候选池 | config.ts:1763 candidates=12 | **config.ts:1820** `candidates: Math.max(1, Math.floor(recallSignalBoost(rr,"candidates",12,100)))`，clamp [1,100]（config.ts:1790 注释） |
| 本地 reranker | local.ts:360-367 | local.ts:360-367 是 `getSharedLocalReranker` 进程级单例池；**模型=Xenova/bge-reranker-base（cross-encoder，local.ts:48）**；rerank 合同 local.ts:114（`rerank(query,docs)→[{index,score}]`，null=降级）；模型下载失败冷却 local.ts:322 |
| query-expand | gateway/query-expand.ts:271-301 | **core/recall/query-expand.ts:271-301** `resolveQueryExpansionRunner`（server.ts:68 import）；enabled=false/未配→退化关（E1.4 零影响）；默认 timeoutMs 120s；注释明言"宁缺毋滥，recall 热路径无重试预算" |
| FTS 分词 | sqlite.ts:251-263/297/352 | sqlite.ts:251-263 `getJieba`（@node-rs/jieba，缺位则 regex 兜底）；**sqlite.ts:269-274 ZH_STOP_WORDS 仅滤中文虚词 34 个**；sqlite.ts:297 `buildFtsQuery`：jieba cutForSearch → FTS5 OR-join 短语，BM25 排序 |
| MMR | λ=0.7 | **soul-anchor-scorer.ts:185 selectAnchorRowsMmr**，调用点 soul-assembler.ts:644——MMR 用于 **soul 锚选择**（身份/价值观块组成），不是召回结果去重 |
| 复合打分 | （快照未提） | **memory-search.ts:600-601 DEFAULT_COMPOSITE_WEIGHTS = {relevance:0.7, timeProx:0.15, significance:0.1, coreRef:0.05}**——本仓已有时近性软因子！ |
| L1 时间列 | （快照未提） | content-soul.ts:3 自述"模型常不吐 occurred_at/certainty/valence，导致 l1_records 列空" |
| JIT 注入 | tdai-profile-memory-injector.ts:267-272 | MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts 确认（L2/L3 snapshot session_init 注入、缓存语义、T16 注释：感受块已拆出） |

**现场修正的两条关键认知**：
1. 本仓 reranker **已经是 cross-encoder**（bge-reranker-base），缺的不是 reranker 而是候选池（12 太小，见 §2.7）。
2. 病灶②不是"没有任何时间因子"——timeProx=0.15 已存在但压不住，且 L1 时间列本身常为空（地基缺失）。药方是"填实时间列+失效标记+检索期硬过滤"，不是从零加衰减（§2.6）。

## 1. 检索粒度与压缩（直击病灶①）

### 1.1 Dense X Retrieval：proposition 作为检索单元 ★病灶①最直接学术对照

- **定义**：检索单元（document/passage/sentence/proposition）是被忽视的设计选择，显著影响检索与下游性能。proposition=最小原子命题（每个自足、独立表达一个事实、保留必要上下文），由 LLM 分解器（FactorizingProof 等实现）把文本拆成 proposition 列表，对 proposition 建 embedding 索引；检索命中 proposition，再回查其所属 passage 交给 LLM。EMNLP 2024。
- **药方**：**【粒度/密度药方】**——「原子事实而非任务摘要」的学术原话级对照。
- **本仓适配点**：L1 写入管线（MemoryCore/src/core/lifecycle/consolidation/，打包摘要产生处）写入时把整条摘要拆成原子命题**子行**（facts[]，每行独立 embedding+归属 L1 id）；L1 检索索引切到子行粒度；注入端按命中子行回填父条目上下文（与 §1.2 small-to-big 组合）。旧数据兼容：只对新写入启用，存量软迁移。
- **工作量**：L（写入管线+索引结构+回填链路）。
- **锚点**：arXiv:2312.06648（Dense X Retrieval: What Retrieval Granularity Should We Use?，https://arxiv.org/abs/2312.06648）。

### 1.2 small-to-big / parent-child 检索（LlamaIndex recursive / auto-merging）

- **定义**：索引与注入粒度解耦——embedding 用小块（child，主题聚焦、无噪声），命中后返回其父块（parent，上下文完整）。LlamaIndex 两种实现：RecursiveRetriever（child node 存 parent 引用，检索 child 返回 parent）；AutoMergingRetriever（多命中 child 落在同一父块按层级阈值自动合并升级）。这是「检索小单元、返回大上下文」的代表工程模式。
- **药方**：**【粒度/密度药方】**。
- **本仓适配点**：L1 原子事实行做 child（配合 §1.1 拆分），整条 L1 任务摘要做 parent；或 L2 场景块做 parent、其下 L1 事实做 child（利用现有 L2 路径索引结构）。injector（tdai-profile-memory-injector.ts）按 parent 粒度注入。
- **工作量**：M（依赖 §1.1 的拆分先行）。
- **锚点**：LlamaIndex 官方文档 Recursive retriever（https://developers.llamaindex.ai/python/framework-api-reference/packs/recursive_retriever/）与 Retriever Modules（https://developers.llamaindex.ai/python/framework/module_guides/querying/retriever/retrievers/）；auto-merging 模式见社区教程（enterpriseai.handbook.mihirkjha.com 08-auto-merging-retriever）。

### 1.3 RAPTOR：层级摘要树

- **定义**：递归 embedding→聚类→摘要，自底向上建树，树每层是不同抽象级的摘要；检索可落任一层，兼顾细节（叶）与全局（顶）。 UM-ICLR 系工作，QuALITY/QASPER 长文 QA 提升。
- **药方**：**【粒度/密度药方】**（兼【相关性】：全局问题命中高层摘要更准）。
- **本仓适配点**：L1→L2 consolidation（MemoryCore/src/core/lifecycle/consolidation/）已是天然的「摘要升层」管线，可在 L2 场景块之上叠 RAPTOR 式聚类摘要层；但建树/维护成本高，对单 agent 记忆库规模收益存疑——列为远期，先做 §1.1。
- **工作量**：L。
- **锚点**：arXiv:2401.18059（https://arxiv.org/abs/2401.18059）。

### 1.4 sentence-window 句窗检索

- **定义**：按句（或小段）做 embedding 检索，命中后以窗口（LlamaIndex 默认**两侧各 5 句**）回填上下文再注入；SentenceWindowNodeParser + MetadataReplacementPostprocessor。与 small-to-big 同族，粒度更细。
- **药方**：**【粒度/密度药方】**。
- **本仓适配点**：L1 若暂不拆原子行（§1.1 门槛高），可先按句/段切分同条 L1 建 embedding（child=句），命中句回填整条摘要窗口——是 §1.1 的低成本过渡版。注入端截断（injector 头部截断）替换为「命中句±窗口」。
- **工作量**：M。
- **锚点**：LlamaIndex 官方示例 Metadata Replacement + Node Sentence Window（https://developers.llamaindex.ai/python/examples/node_postprocessor/metadatareplacementdemo/，"By default, the sentence window is 5 sentences on either side of the original sentence"）。

### 1.5 RECOMP：注入端压缩

- **定义**：在检索文档进入 context 前压缩成文本摘要；两种 compressor：**extractive**（从检索文档中选句保留）与 **abstractive**（跨文档合成生成摘要）；两者都以最终端到端任务表现为目标训练。降低推理成本的同时"减轻 LM 在长文档中找相关信息的负担"。
- **药方**：**【粒度/密度药方】**——注入端「只留头部元信息流水账」的截断策略的直接替换项：截断是无信息选择，压缩是有信息选择。
- **本仓适配点**：MemoryProxy 注入端（tdai-profile-memory-injector.ts 截断逻辑处）。**起步版不需要训练**：规则/本地小模型打分选句（句子与 query 的相关度排序保留 top-k）即可获得大部分收益；生成式压缩（ark LLM）只在高价值条目上选择性启用（延迟预算）。
- **工作量**：S-M（抽取式启发版 S；训练生成式 L，不建议）。
- **锚点**：arXiv:2310.04408（RECOMP，https://arxiv.org/abs/2310.04408，摘要原文："We present two compressors -- an extractive compressor which selects useful sentences from retrieved documents and an abstractive compressor which generates summaries by synthesizing information from multiple documents"）。

### 1.6 LLMLingua：token 级提示压缩

- **定义**：coarse-to-fine 两级压缩：budget controller 先按语义完整性分配 token 预算，再用小 LM 困惑度驱动删 token/短语；2-20× 压缩保语义（后续 LLMLingua-2 用 XLM-RoBERTa 级小模型）。
- **药方**：**【粒度/密度药方】**（注入端 token 预算压力场景）。
- **本仓适配点**：注入端最后一步（injector）对超长候选做 token 预算压缩。**本机 CPU 节流约束**：小模型推理延迟需实测，且对本仓"密度低"病灶的收益低于 §1.5（LLMLingua 是保原文的删 token，不是信息重组）——优先级低于 RECOMP 式选句。
- **工作量**：M。
- **锚点**：arXiv:2310.05736（https://arxiv.org/abs/2310.05736）；microsoft/LLMLingua（GitHub）。

### 1.7 Anthropic contextual retrieval：chunk 附上下文再索引

- **定义**：索引前用 LLM 给每个 chunk 生成 50-100 token 的"位置锚定上下文说明"（该 chunk 在整篇文档里的角色），chunk embedding 与 BM25 索引都带这个上下文；配合 rerank 与 top-20 注入。官方数字：**contextual embeddings + contextual BM25 + rerank 把 top-20-chunk 检索失败率降低 67%（5.7% → 1.9%）**；用 prompt caching 把生成成本压低。发布于 2024-09-19（页面 2026-01 仍有更新）。
- **药方**：**【粒度/密度药方】**——「整任务摘要块 embedding 主题虚高」的直接解法：写入期给块附任务角色说明，embedding 就反映"这条记忆讲什么"，而不是被任务标题/元信息带偏。兼【相关性】。
- **本仓适配点**：L1 写入管线在 embed 前给条目附上下文前缀：任务标题+时间+会话主题+本条角色（写入期一次性 LLM 调用，读路径零成本；符合"写入贵、读路径快"）。轻量版：结构化元信息前缀（零 LLM 成本），先跑通再看是否升级 LLM 版。
- **工作量**：M（LLM 版）/ S（结构化前缀版）。
- **锚点**：https://www.anthropic.com/engineering/contextual-retrieval（2024-09-19；正文实测引文："Reranked Contextual Embedding and Contextual BM25 reduced the top-20-chunk retrieval failure rate by 67% (5.7% → 1.9%)"）。

### 1.8 Mix-of-Granularity：粒度混合索引

- **定义**：同一语料多种粒度（句/段/文档级）并存索引，检索时 query 感知地融合不同粒度的证据。COLING 2025。
- **药方**：**【粒度/密度药方】**。
- **本仓适配点**：L0/L1/L2 分层天然是多粒度，缺的是**同一层内**多粒度（L1 内部只有整条摘要一种粒度）。与 §1.1/§1.2 组合后自然达成，不单独立项。
- **工作量**：L（单独做）。
- **锚点**：arXiv:2406.00456（https://arxiv.org/abs/2406.00456）；ACL Anthology 2025.coling-main.384（https://aclanthology.org/2025.coling-main.384/）。

## 2. 检索算法与召回编排

### 2.1 hybrid FTS+dense 与 RRF 融合

- **定义**：BM25（词法）与 dense（语义）双路召回后融合。RRF（Reciprocal Rank Fusion）公式：`RRF(d) = Σ_i 1/(k + rank_i(d))`，k=60；Cormack et al. (SIGIR 2009) 结论：RRF 胜过 Condorcet 组合与单独 rank learning。优点：免分数归一化、免调权、对单路异常鲁棒。
- **本仓现状**：jieba FTS + dense 双路已在（sqlite.ts buildFtsQuery + dense 召回）。**融合方式未现场核实**（sqlite.ts 共 6509 行，只读了 244-301；若是线性加权归一化融合，RRF 是 S 级替换）。
- **药方**：**【相关性药方】**——注意：病灶③的污染词若同时进两路，RRF 只能稳态化融合，不消除污染本身（清洗见 §3）。
- **本仓适配点**：MemoryCore/src/core/store/sqlite.ts 融合打分段。
- **工作量**：S。
- **锚点**：DOI 10.1145/1571941.1572114（https://doi.org/10.1145/1571941.1572114）；PDF https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf。

### 2.2 ColBERT / ColBERTv2 late interaction

- **定义**：query 与 doc 各产出 token 级多向量，相关性 = Σ_token MaxSim(query_tok, doc_toks)；v2 加去噪监督与残差压缩（空间 6-10×）。质量高于单向量 bi-encoder，尤其长文档多主题（token 对齐不受"整条摘要主题平均"拖累）。
- **药方**：**【相关性药方】**（多向量天然缓解病灶①的"主题虚高"，但落地代价大）。
- **本仓适配点**：SQLite 存储上引入 PLAID 式多向量索引=索引架构大改；远期选项，短期不推荐。
- **工作量**：L。
- **锚点**：arXiv:2004.12832（https://arxiv.org/abs/2004.12832）、arXiv:2112.01488（https://arxiv.org/abs/2112.01488）。

### 2.3 cross-encoder reranker（bge-reranker / Qwen3-Reranker / Cohere）

- **定义**：query-doc 拼接进 encoder 出单点相关分，精度显著高于 bi-encoder。两段式检索经典配置：Nogueira & Cho (2019) 用 BM25 top-1000 → BERT rerank → top-10，TREC CAR SOTA——确立"粗召回大池 + cross-encoder 精排"范式。
- **本仓现状（重要）**：reranker **已经是 cross-encoder**（Xenova/bge-reranker-base，local.ts:48），worker_threads 隔离（rerank-worker.mjs），下载失败有冷却降级（local.ts:322，null=降级跳过）。**短板是候选池 candidates=12（config.ts:1820）**——rerank 精修的对象只有 12 条，粗召回第 13-100 名的真命中永远进不了精排。
- **药方**：**【相关性药方】**——明确标注：rerank 修不了粒度（对整条摘要 rerank，"命中了也用不上"依旧）。它是池扩容（§2.7）后兑现收益的一环。
- **本仓适配点**：候选池扩容后现有 bge-reranker-base 直接受益；可选升级 bge-reranker-large / Qwen3-Reranker（2025-06，arXiv:2506.05176）/ Cohere Rerank（API 外呼，本机离线约束下不选）。CPU 延迟门：12→50 约 4× 推理量，需实测（预估 0.5-2s 量级，本机节流 ~30%）。
- **工作量**：S（池扩容）/ M（换模型+延迟优化）。
- **锚点**：arXiv:1901.04085（https://arxiv.org/abs/1901.04085）；HF BAAI/bge-reranker-large（https://huggingface.co/BAAI/bge-reranker-large）；arXiv:2506.05176（Qwen3 Embedding: Advancing Text Embedding and Reranking，2025-06-05，https://arxiv.org/abs/2506.05176）；Cohere Rerank 文档 https://docs.cohere.com/docs/rerank.mdx 与 best practices https://docs.cohere.com/docs/reranking-best-practices.mdx。

### 2.4 GraphRAG / LightRAG

- **定义**：GraphRAG：LLM 抽实体关系建图+社区层次摘要，面向"整个语料库的全局性问题"（QFS）；LightRAG：轻量双层检索（low-level 实体细节 / high-level 主题）+增量更新，去重似 GraphRAG 的完整建图成本。
- **药方**：**【相关性药方】**——针对跨条目关系型问题；对病灶①的粒度/密度无效。
- **本仓适配点**：L2 场景块/价值锚之间有"关系"语义（哪个任务关联哪个偏好），实体图是大工程；当前痛点（单条命中可用性）不是关系型问题。远期选项。
- **工作量**：L。
- **锚点**：arXiv:2404.16130（https://arxiv.org/abs/2404.16130）、arXiv:2410.05779（https://arxiv.org/abs/2410.05779）。

### 2.5 HyDE / query rewrite / step-back（对照本仓 query-expand 现状）

- **定义**：HyDE：让 LLM 零样本生成"假设答案文档"，用假设文档的 embedding 代替 query 去 dense 检索（假设文档与真文档的语义距离比裸 query 更近）；Step-Back Prompting：先从细节实例抽象出高层概念/原则，用抽象 query 检索/推理；query rewrite：口语化/含混 query 改写。
- **本仓现状**：query-expand 已存在（ark LLM，core/recall/query-expand.ts:271-301；RTT 2.2-2.4s@lead 快照；热路径无重试预算、可退化关）。机制上"改写/扩展"一格已占。改进空间：(a) expand **前置确定性清洗**（病灶③，见 §3）——现在污染词会先入 expand 的 LLM prompt；(b) HyDE 式假设文档在延迟预算内只能选择性试点（2.2-2.4s 已是热路径大头，再加一轮生成不现实，除非异步）。
- **药方**：**【相关性药方】**。
- **工作量**：清洗 S；HyDE M（且受延迟预算约束，收益存疑——如实标注）。
- **锚点**：arXiv:2212.10496（https://arxiv.org/abs/2212.10496）、arXiv:2310.06117（https://arxiv.org/abs/2310.06117）。

### 2.6 temporal/metadata filtering + 失效标记（病灶②主药方）

- **定义**：检索期按 metadata（时间/状态/有效期）过滤或加权。Zep（Graphiti）：temporal knowledge graph，事实边带 t_valid/t_invalid，失效做 invalidation 标记而非删除，检索时按时效过滤/区分版本；RAG Meets Temporal Graphs（2025-10）指出：embedding 与常规 KG 都难以区分"同一事实的不同时间版本"，需要显式 time-aware 表征——与本仓"过程性条目过时 4 天仍高分"现象同构。
- **本仓现状（现场修正）**：**已有**复合分时近因子 timeProx=0.15（memory-search.ts:600-601 `DEFAULT_COMPOSITE_WEIGHTS = {relevance:0.7, timeProx:0.15, significance:0.1, coreRef:0.05}`，注释明言相关度主导契约 ≥70%）。但 0.15 软权重压不过 0.7 主导的相关度，且 **l1_records 的 occurred_at/certainty/valence 列常为空**（content-soul.ts:3 自述）——过滤地基缺失。
- **药方**：**【相关性药方】**（含时效维度）：
  1. 写入侧把 occurred_at 填实（LLM 抽取管线补列，含回填校验）——M；
  2. 过程性条目（状态/进度/中间产物）打"有效期/失效"metadata 标记，**检索期硬过滤或大幅降权**——软失效可逆（符合本仓软删哲学，禁删记忆红线不触碰：只标记不过滤存储）——M；
  3. 对"过程性"类目启用时间指数衰减（或抬 timeProx 权重，config-first 翻转需拍板+golden 回归）——S。
- **工作量**：合计 M。
- **锚点**：arXiv:2501.13956（Zep: A Temporal Knowledge Graph Architecture for Agent Memory，https://arxiv.org/abs/2501.13956）；arXiv:2510.13590（RAG Meets Temporal Graphs，2025-10-15，https://arxiv.org/abs/2510.13590）；arXiv:2508.01680（T-GRAG）；SynapticRAG（ACL 2025 Findings，https://aclanthology.org/2025.findings-acl.1048/）。

### 2.7 候选池大小与两段式召回-rerank 依据（candidates=12 的业界对照）★参数专项

- **业界证据链**（全部一手锚点）：
  - Nogueira & Cho 2019：BM25 **top-1000** → BERT rerank → top-10（两段式开创配置，arXiv:1901.04085）。
  - LangChain MMR 默认：**fetch_k=20 → k=4**（5:1，reference 文档实测："fetch_k int Default: 20 ... lambda_mult float Default: 0.5"）。
  - Anthropic contextual retrieval：rerank 后 **top-20** 进 prompt（rerank 前池更大）。
  - Cohere Rerank：top_n 参数独立于输入候选数，官方 best practices 要求足够候选池+文档切片规范（docs.cohere.com/docs/reranking-best-practices.mdx）。
- **本仓现状**：FTS+dense 粗召回 → candidates=12（config.ts:1820，clamp [1,100]）→ bge-reranker-base → MMR（soul 锚）。**12 处于业界下限之外**：业界粗召回普遍 ≥ 最终注入的 5-10 倍，且两段式文献里粗召回 100-1000 是常态。
- **建议区间**（按延迟可行性收敛）：**候选池 50-100**（≥注入锚点 5-10×），落地起步 50；rerank 前池 50，最终注入 5-10 条。理由：12 条时 rerank 只能在粗排前 12 内重排，精修增益被粗排截断误差吞掉；扩到 50 才能让 cross-encoder 发挥"从更大池里捞回真命中"的价值。**延迟门**：bge-reranker-base CPU 推理 50 对（本机节流）需实测，预估 0.5-2s 量级——建议带延迟预算实测门推进（超预算则池 50 → 分段rerank 或换小模型）。
- **工作量**：S（config 默认值翻转，需用户拍板+golden 回归）。
- **锚点**：arXiv:1901.04085；LangChain https://reference.langchain.com/python/langchain-core/vectorstores/base/VectorStore/max_marginal_relevance_search/；Anthropic（§1.7 同源）；Cohere best practices。

### 2.8 去重与 MMR 多样性（λ 惯例）

- **定义**：MMR（Carbonell & Goldstein, SIGIR 1998）：迭代选下一个 d 最大化 `λ·rel(d) − (1−λ)·max_{s∈S} sim(d,s)`；λ=1 纯相关、λ=0 纯多样性。
- **惯例**：LangChain 默认 lambda_mult=0.5（一手核实）；本仓 soul 锚选择 λ=0.7。
- **本仓现状辨析（重要）**：本仓 MMR（selectAnchorRowsMmr，soul-anchor-scorer.ts:185）用于 **soul 块组成**（身份/价值观锚去扎堆），**不是召回结果的去重**。soul 是"每轮注入的稳定身份块"，偏相关（0.7）合理，业界 0.5-0.7 区间内——**维持现状，不是召回精度主战场**。召回侧多条 L1 重复扎堆的问题，根因是整任务打包摘要天然雷同（病灶①），解药是 §1.1 原子化，不是调 λ。
- **工作量**：—（维持）。
- **锚点**：DOI 10.1145/290941.291025（https://doi.org/10.1145/290941.291025）；CMU PDF https://www.cs.cmu.edu/~jgc/publication/MMR_DiversityBased_Reranking_SIGIR_1998.pdf；LangChain reference（§2.7 同源）。注：原论文实验用 λ 具体值未逐页核对（诚实标注），λ 惯例主要依据 LangChain 默认 0.5。

## 3. 查询侧清洗（病灶③专项）

- **现状**：ZH_STOP_WORDS 仅 34 个中文虚词（sqlite.ts:269-274）；<acp> 标签、ISO 时间戳、系统脚手架**原样**进入 FTS query（buildFtsQuery 切词后全成 OR 短语，污染词直接 boost 错误文档）与 embedding 输入（query-expand 也不清洗，污染先入 LLM prompt）。2026-10-16 reflection 实锤，未修。
- **业界对照（诚实说明）**：query cleaning 在学术文献里少有专门论文——HyDE/step-back 等 pipeline 均隐含"query 已干净"假设；工程实践中它属于 query understanding 的前置步骤（LangChain/LlamaIndex 文档以 query preprocessing 实践存在）。故本节锚点=本仓现状代码+下游论文的隐含前提，无单篇"query cleaning"论文可引——如实标注。
- **药方**：**【相关性药方】，S 级**：确定性规则清洗（regex 剥离 <acp>…</acp>、ISO/RFC 时间戳、系统脚手架标记），零 LLM、零延迟成本。落两处：handleRecall 入口清洗一次（v2-router.ts:1841 入参处，FTS 与 embedding 两路共享）；buildFtsQuery 加防御性二次剥离（sqlite.ts:297）。
- **工作量**：S。
- **锚点**：本仓 sqlite.ts:269-297（现场）；arXiv:2212.10496 / arXiv:2310.06117（query 干净假设的下游依据）。

## 4. 2025 H2 新工作补充（时间线，均一手核实编号与标题）

- 2025-06-05 **Qwen3 Embedding/Reranker**（arXiv:2506.05176，qwenlm.github.io/blog/qwen3-embedding）——开源 reranker 新选项（§2.3）。
- 2025-08-03 **T-GRAG**（arXiv:2508.01680）——动态 GraphRAG 解时序冲突与冗余（病灶②线索；标题级核实）。
- 2025-08 **Triplet-Driven RAG**（arXiv:2508.02435）——triplet 作检索单元（病灶①原子化的另一路径；标题级核实）。
- 2025-10-15 **RAG Meets Temporal Graphs**（arXiv:2510.13590）——time-aware 表征+检索（病灶②，摘要已核）。
- COLING 2025 **Mix-of-Granularity**（arXiv:2406.00456 / ACL 2025.coling-main.384）——粒度混合（§1.8）。
- ACL 2025 Findings **SynapticRAG**（2025.findings-acl.1048）——突触机制式时间记忆检索（标题级核实）。

## 5. Top 机制清单（病灶贴合度 × 工作量排序）

| # | 机制 | 病灶 | 药方类 | 工作量 | 贴合度 | 核心锚点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **L1 检索单元原子化（proposition/原子事实行）+ small-to-big 父块回填** | ① | 粒度/密度 | L | ★★★★★ | arXiv:2312.06648 + LlamaIndex recursive |
| 2 | **候选池 12→50-100**（rerank 有米下锅，延迟门实测） | ①②③共通 | 相关性 | S | ★★★★☆ | arXiv:1901.04085 + LangChain fetch_k=20 |
| 3 | **时效失效门**：occurred_at 填实 + 过程性条目失效标记 + 检索期硬过滤/降权 | ② | 相关性（时效） | M | ★★★★☆ | arXiv:2501.13956 + 2510.13590 |
| 4 | **查询清洗**（确定性剥离脚手架，两路共享） | ③ | 相关性 | S | ★★★★☆ | 本仓 sqlite.ts:269 现状 + HyDE 前提 |
| 5 | **contextual retrieval**（写入期附任务上下文再 embed） | ① | 粒度/密度 | S-M | ★★★☆☆ | anthropic.com/engineering/contextual-retrieval |
| 6 | **注入端 RECOMP 式抽取压缩**（替换头部截断为选句） | ① | 粒度/密度 | S-M | ★★★☆☆ | arXiv:2310.04408 |
| 7 | RRF 融合（若现行为线性加权） | ③稳态 | 相关性 | S | ★★☆☆☆ | DOI 10.1145/1571941.1572114 |
| 8 | sentence-window（L1 句级拆分过渡版） | ① | 粒度/密度 | M | ★★☆☆☆ | LlamaIndex metadatareplacementdemo |
| 9 | HyDE/step-back 增强 query-expand | ③ | 相关性 | M | ★★☆☆☆ | arXiv:2212.10496 / 2310.06117 |
| 10 | RAPTOR 层级摘要 / LLMLingua / ColBERT / GraphRAG / LightRAG | 远期 | — | L | ★☆☆☆☆ | 见各节 |

**排序说明**：#1 是唯一同时根治"embedding 主题虚高"与"信息密度低"两个症状的机制（病灶①双症状），但工作量最大、动写入管线；#2/#4 是立竿见影的 S 级止血（池扩容+清洗），不依赖 #1、可先行；#3 补齐病灶②地基（现有 timeProx=0.15 证明方向已认可，缺的是地基与硬门）。#5/#6 是写入侧/注入侧的中等粒度改良，可与 #1 分阶段组合（#6 注入端先行收益快）。

## 6. 诚实边界（未核实/未覆盖项）

1. Mix-of-Granularity、T-GRAG、SynapticRAG、Triplet-Driven 仅标题/摘要级核实，未读全文机制细节。
2. MMR 原论文（Carbonell & Goldstein 1998）实验 λ 具体值未逐页核对（锚点已给 DOI+CMU PDF）；λ 惯例依据 LangChain 默认 lambda_mult=0.5（一手核实）。
3. RRF 的 k=60 为原文推荐值的通行转述，原文 PDF（cormack.uwaterloo.ca）未逐页核对。
4. bge-reranker-large HF 模型卡正文抓取超时，bge 系列细节基于 HF 页存在性+BGE 文档站（bge-model.com），未核对模型卡全文。
5. **本仓 FTS+dense 融合打分的具体实现行号未读**（sqlite.ts 共 6509 行，仅读 244-301）——§2.1"若为线性加权"是待现场确认的假设，RRF 建议落地前先核实融合代码。
6. 候选池扩容的延迟影响只有量级估算（本机 CPU 节流 ~30%），未实测。
7. L1 写入管线只做了文件级定位（core/lifecycle/consolidation/ 等），未读实现——§1.1/§1.2/§1.7 的适配点是管线级方向而非函数级落点。
8. query-expand 的 RTT 2.2-2.4s 沿用 lead 快照数字，未本会话实测。
9. 未覆盖域（按分工不越界）：长程记忆系统论文（member-1）、开源实现拆解与评测基准（member-3）、生产样本标注（lead task-4）。

## 附录：检索执行记录（方法透明）

- arXiv 直查：domain_search engine=arxiv 对本环境返回空（编号与标题两种 query 均空）——改用 web_fetch 逐篇抓 arXiv abs 页（12 篇全部 HTTP 200 一手核实）。
- 泛搜通道教训：advanced_search 默认引擎对 "cross-encoder pool size" 等查询误路由到词典/中文泛噪结果（strict_rule 所述通道问题复现）——改用 engine=exa 英文定向 + 一手页面直抓后恢复质量。
- 一手来源清单：arXiv abs ×12（2401.18059 / 2310.04408 / 2310.05736 / 2212.10496 / 2004.12832 / 2112.01488 / 2404.16130 / 2410.05779 / 2312.06648 / 1901.04085 / 2501.13956 / 2510.13590 + 2406.00456 / 2506.05176）、Anthropic engineering、LlamaIndex docs ×2、LangChain reference、Cohere docs、DOI ×2（RRF/MMR）、CMU PDF、ACL Anthology ×3、exa 定位 bge/Qwen3。
