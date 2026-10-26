# 长期记忆系统深挖（写入 / 冲突 / 时间 / 索引 / 检索 / 上下文 / 消融 / 成本）

> 调研范围：Mem0、Zep/Graphiti、Letta/MemGPT、A-Mem、MemoryOS、LangMem、Cognee、Memobase/Supermemory、RAPTOR、HippoRAG、MemoryBank。
> 所有数字均带出处（`arXiv:xxxx.xxxxx` + 表号/节号）。凡本轮未抓到原文或原文未给的，统一写「未取得」，不做推断填充。
> 抓取方式：`arxiv.org/html/<id>v<N>`（HTML 版，剥标签后取正文）+ `fastly.jsdelivr.net/gh/<owner>/<repo>@main/<path>`（GitHub raw 镜像）。本轮实际取到的版本：2504.19413v1、2501.13956v1、2310.08560v2、2502.12110v3、2506.06326v1、2401.18059v1、2405.14831v3、2305.10250v3。
> 时间：2026-10-26。术语保留英文原文（fact / edge invalidation / bi-temporal / PPR / collapsed tree 等）。

---

## 1. Mem0（arXiv:2504.19413v1）

**A. 写入路径**
- 触发粒度：**每条 message pair** `(m_{t-1}, m_t)`（通常 = 一条用户消息 + 一条助手回复）触发一次抽取（§2.1）。
- Prompt 组成 `P = (S, {m_{t-m},…,m_{t-2}}, m_{t-1}, m_t)`：`S` = 从库里读的**会话摘要**，另有**最近 m 条**消息窗口；抽取函数 `φ(P)` 由 LLM 实现，输出候选 fact 集合 `Ω`。
- **异步摘要模块**：会话摘要由独立异步组件周期性刷新，不阻塞主流水线（§2.1）。
- 实验配置：`m = 10` 最近消息、`s = 10` 相似记忆、模型 **GPT-4o-mini**、dense embedding + 向量库（§2.1 末）。
- LLM 调用次数：论文未给总量；结构上 = **1 次抽取** + **每条候选 fact 1 次更新决策**（tool call）。
- `Mem0^g`（图版）：两阶段抽取 —— entity extractor（人/地/物/概念/事件/属性 + type）→ relationship generator（三元组 `(v_s, r, v_d)` + 关系标签）；节点含 entity type、embedding `e_v`、创建时间戳 `t_v`；存储为 Neo4j，LLM 用 GPT-4o-mini + function calling（§2.2）。

**B. 写时合并 / 冲突解决**
- Mem0：**四决策** ADD / UPDATE / DELETE / NOOP。流程：对每条候选 fact 先取 top-`s`(=10) 语义相似记忆，与候选一起交给 LLM，由 LLM 自己（不是独立分类器）用 function calling 选操作（§2.1）。
- `Mem0^g`：**失效标记而非物理删除** —— conflict detection 找出潜在冲突关系，LLM update resolver 判定哪些关系 obsolete，标记为 invalid 以支持时间推理（§2.2）。
- 节点层级还有阈值 `t` 的相似度合并（可能建两个节点 / 只建一个 / 复用已有节点）。

**C. 时间处理**
- `Mem0^g` 节点带 creation timestamp，用于 temporal reasoning；Mem0 本体没有显式时间区间。
- 论文反证：OpenAI 基线因「多数生成记忆没有 timestamps」在 temporal 类任务得分 < 15%（§4.3 Temporal Reasoning）。
- 查询时怎么用：论文只给结论（Mem0^g 在 temporal 显著优于其他方法，验证结构化关系图有效），**没有**给出「按时间过滤」的检索规则。

**D. 索引键与 embedding**
- 稠密向量检索（dense embeddings），**embedding 模型名与维度未给**。
- `Mem0^g` 同时为节点和每个 triplet 的文本编码建 embedding，用于匹配。

**E. 检索路径**
- Mem0：向量相似度选择性检索（论文强调"selective memory retrieval"），k 值未明说（更新阶段 s=10 是相似记忆数，非查询 k）。
- `Mem0^g`：双路 —— ① entity-centric：query 里找关键实体 → 语义相似定位节点 → 遍历进出边构造子图；② semantic triplet：整条 query 编码成向量，与所有 triplet 文本编码算相似度，**超可配置阈值**后按相似度降序返回（§2.2）。
- rerank / MMR：论文未提及。时间过滤：未提及。

**F. 上下文构造**
- Mem0「encodes complete dialogue turns in a natural language representation」——即**自然语言完整对话轮**形式入库（§4.5）。
- 给 LLM 的具体格式（JSON/纯文本/CoN）与 token 预算细则：未取得。

**G. 消融数字**
- **无逐模块消融表**。仅有 Mem0 vs `Mem0^g` 对比（Table 1，报告 single-hop / multi-hop / temporal / open-domain 的 F1 / BLEU-1 / LLM-as-Judge，逐格数值本轮未取）。
- 正文给出的 overall：`Mem0^g` J = **68.44%**，是除 full-context 外最高；full-context（≈26k tokens）J ≈ **73%**（§4.2、§4.4）。
- 相对提升（§5 结论）：single-hop **+5%**、temporal **+11%**、multi-hop **+7%**（相对各类最好方法）；抽象中另给：LLM-as-Judge 相对 OpenAI **+26%**。

**H. 工程代价**
- 搜索延迟：Mem0 **p50 0.148s / p95 0.200s**；`Mem0^g` search **0.476s**（§4.4、Table 2）。
- 端到端：Mem0 total **p50 0.708s / p95 1.440s**；`Mem0^g` **p50 1.091s / p95 2.590s**；full-context **p95 17.117s** → Mem0 −92%、`Mem0^g` −85%（§4.4）。
- 对照同表：A-Mem search p50 0.668s、total p50 1.410s；Zep total p50 1.292s；LangMem search **p50 17.99s / p95 59.82s**（§4.4）。
- 存储放大：Mem0 **7k tokens / 对话**，`Mem0^g` **≈14k**，Zep **>600k**，原始全文 ≈26k（§4.5）。
- 构建时间：Mem0 图构建最坏情况 **< 1 分钟**；并报告 Zep 写入后立即检索常失败、数小时后才正常（异步 LLM 调用 + 后台处理）（§4.5）。

> **对我们最有借鉴价值的 1 个点**：**写路径解耦**——抽取只依赖「已就绪的会话摘要 + 最近 m 条窗口」，摘要由异步模块刷新，于是抽取延迟可预测，同时保留全局主题感知（§2.1）。

---

## 2. Zep / Graphiti（arXiv:2501.13956v1）

**A. 写入路径**
- Episode 摄入：message / text / JSON 三类原始单元（非损失存储），message 粒度为「短文本 + speaker」（§2.1）。
- 实体抽取：用**当前消息 + 前 n=4 条消息**做上下文（= 两个完整对话轮），speaker 自动作为实体；用 reflection 技术降幻觉 + 抽 entity summary（§2.2.1）。
- fact 抽取为 **edge**，同一 fact 可在不同实体间多次抽出 → 用 hyper-edge 建模多实体事实（§2.2.2）。
- community 子图：label propagation（非 Leiden），新节点按邻居多数的社区归属做**动态扩展**，另有周期性全量刷新（§2.3）。
- 落库用**预定义 Cypher 查询**而非 LLM 生成 DB 查询（避免 schema 漂移与幻觉）（§2.2.1）。
- LLM 调用次数：论文未给计数（Mem0 论文描述其为 "multiple asynchronous LLM calls"）。

**B. 写时合并 / 冲突解决**
- 无四决策。核心是 **edge invalidation + 去重**：
  - 实体解析：对已有实体名做 cosine + 全文本双搜找候选 → LLM 判定重复并生成更新后的 name/summary（§2.2.1）。
  - edge 去重：hybrid search **限制在同一实体对之间**的已有边（防止把不同实体对的相似边混起来，并大幅降低搜索空间）（§2.2.2）。
  - 失效：LLM 比较新边与语义相关旧边找矛盾；发现**时间重叠的矛盾**时，把旧边 `t_invalid` 设为新边的 `t_valid`；沿事务时间轴 **总是优先新信息**（§2.2.3）。

**C. 时间处理（最完整的一家）**
- **bi-temporal**：`T` = 事件时序（`t_valid` / `t_invalid`），`T'` = 事务时序（`t'_created` / `t'_expired`），**四个时间戳都存边上**（§2.1、§2.2.3）。
- `t_ref`（消息发送时间）用于把「next Thursday」「in two weeks」「last summer」解析成绝对/相对时间（§2.1、§2.2.3）。
- 查询时：时间主要经由边失效影响检索语义（当前为真的边 vs 已失效边），论文未见显式时间过滤参数。

**D. 索引键**
- 实体名 → **1024 维**向量（§2.2.1）；同时另做实体名与 summary 的 full-text search。
- fact（edge）也生成 embedding 用于去重与检索；community name（含关键词）也 embedding 以支持 cosine 搜索（§2.3）。
- 检索字段明确：`E_s` 搜 fact 字段，`N_s` 搜 entity name，`N_c` 搜 community name（§3.1）。

**E. 检索路径**
- 三路 search：`φ_cos`（cosine）、`φ_bm25`（Okapi BM25）、`φ_bfs`（图上 n-hop BFS，可用 recent episode 作为 seed）（§3.1）。
- rerank：支持 **RRF**、**MMR**，另有自家 **episode-mentions reranker**（按会话内提及频次）、**node distance reranker**（按到 centroid 的图距）、以及最贵的 **cross-encoder**（§3.2）。
- 实验 k：主实验检索 **top 20 edges + entity nodes**（§4）；DMR 子实验 top 10（§4.1）。

**F. 上下文构造**
- 检索结果重组成 **context string**（对齐 Zep memory API 的行为）（§4）。
- ctx 里的模板形如 `FACTS … <FACTS> … ENTITY_NAME: entity summary <ENTITIES>`（§3 前置 prompt 片段）。
- token 预算实测：LongMemEval_s 平均 context **1.6k tokens**，full-context 为 **115k**（Table 2）。

**G. 消融数字**
- **无逐模块消融**（只有 Zep vs full-context vs MemGPT 的对比）。
- DMR（Table 1）：Zep **94.8%**（gpt-4-turbo）、**98.2%**（gpt-4o-mini）；同表 Recursive Summarization 35.3%、Conversation Summaries 78.6%（gpt-4-turbo）。
- LongMemEval_s（Table 2）：gpt-4o-mini full-context **55.4%** → Zep **63.8%**；gpt-4o full-context **60.2%** → Zep **71.2%**。增益集中在 single-session-preference、multi-session、temporal-reasoning（§4.2）。

**H. 工程代价**
- LongMemEval_s 延迟（Table 2）：Zep gpt-4o-mini **3.20s（IQR 1.31s）**，gpt-4o **2.58s（IQR 0.684s）**；full-context 分别 31.3s / 28.9s。
- 存储放大（Mem0 论文 §4.5 的第三方测量）：Zep 图 **>600k tokens**（每个节点缓存完整抽象摘要 + 边上存 fact 导致冗余），约原始全文的 20 倍。

> **对我们最有借鉴价值的 1 个点**：**四时间戳 + 失效标记**：`t_valid/t_invalid`（事实何时为真）+ `t'_created/t'_expired`（系统何时知道），旧边不删只标 `t_invalid = 新边 t_valid`，于是「现在为真」与「当时为真」都能查。

---

## 3. Letta / MemGPT（arXiv:2310.08560v2）

**A. 写入路径**
- **不抽事实**。主上下文 main context = system instructions（只读静态）+ **working context** + **FIFO queue**；外部上下文 = **recall storage**（消息历史）+ **archival storage**（文档）（§2.1–2.3）。
- 写入/检索**完全由 LLM 自主决定**（self-directed editing and retrieval），靠 system instructions 里定义好的 function calls；用 `request_heartbeat=true` 可在返回用户前链式执行多个函数（§1、§2.3）。
- 粒度 = 原始消息 / 文档页；working context 里放 agent 自己挑的关键事实（§2.2、Fig. 4）。

**B. 写时合并 / 冲突解决**
- 无冲突解决、无四决策；只有「编辑上下文」（append / replace）与队列淘汰。
- queue eviction policy：prompt tokens 超过 warning token count（上下文窗口的某个比例）时驱逐 FIFO 头部（§2.2）。检索 API 有分页，防止检索结果撑爆窗口（§2.3）。

**C. 时间处理**
- recall storage 保存对话历史（可搜索）；论文未给时间区间 / 双时间轴 / 查询时间过滤。**未取得**更细的时间机制。

**D. 索引键**
- archival storage 走 **embedding-based ranking**（§4.3 讨论 retriever 噪声容忍）；embedding 模型与维度**未给**。

**E. 检索路径**
- 函数式检索（archival_memory_search / conversation_search 类），带 **pagination**；k 值未给。
- rerank / MMR / 时间过滤：论文未提及。

**F. 上下文构造**
- main context 三段（system instructions / working context / FIFO queue）**拼接成单一字符串**送入 LLM（§2.3）。
- token 预算显式化：system instructions 指导 LLM 感知 token 上限；queue 到阈值就驱逐（§2.2–2.3）。

**G. 消融数字**
- **无逐模块消融**。
- DMR（Table 2）：GPT-3.5 Turbo 38.7% → **+MemGPT 66.9%**（ROUGE-L 0.394→0.629）；GPT-4 32.1% → **92.5%**（0.296→0.814）；GPT-4 Turbo 35.3% → **93.4%**（0.359→0.827）。
- 开场白（Table 3）：SIM-1/3/H 可超过人类写的 opener；论文指出把信息写进 working context 是生成有吸引力 opener 的关键（§3.2）。

**H. 工程代价**
- 论文未给延迟 / token / 成本数字。外部测量：MemoryOS 论文 Table 3 记 MemGPT 每次响应召回 **16,977 tokens、4.3 次 LLM 调用**（arXiv:2506.06326v1, Table 3）。
- 结构性成本：每轮可能多次 LLM 推理（function call 往返），这是「自主记忆管理」的固有代价。

> **对我们最有借鉴价值的 1 个点**：**把 token 预算做成模型可见的一等公民**——警告阈值 + FIFO 驱逐 + 检索分页，让「超预算」是模型可感知、可自处理的常规事件，而不是异常。

---

## 4. A-Mem（arXiv:2502.12110v3）

**A. 写入路径**
- 粒度：**note**（Zettelkasten 原子笔记）。`m_i = {c_i 原始交互, t_i 时间戳, K_i 关键词, G_i 标签, X_i 上下文描述, e_i embedding, L_i 链接集}`（§3.1, Eq.1）。
- LLM 生成 `K_i, G_i, X_i ← LLM(c_i ‖ t_i ‖ P_s1)`，**每条交互 1 次**（§3.1, Eq.2）。
- Link generation：先按 embedding 相似度取 top-k 邻居，再让 LLM 判定要不要建链（§3.2）。
- Memory evolution：对每个邻居 `m_j`，`m_j* ← LLM(m_n ‖ M_near∖m_j ‖ m_j ‖ P_s3)`，判断是否更新其 context/keywords/tags（§3.3, Eq.7）。
- 合计写入 LLM 调用 ≈ **2 + k**（1 次建 note + 1 次建链 + 每邻居 1 次演化）。

**B. 写时合并 / 冲突解决**
- 无四决策、无失效标记；有**倒改旧条目**：演化后的 `m_j*` 直接**替换**原 `m_j`（§3.3）。

**C. 时间处理**
- 每条 note 存 `t_i` 时间戳；论文未给时间区间，也未见检索时的时间过滤。

**D. 索引键**
- **fact-augmented 多字段**：索引向量 = `f_enc[concat(c_i, K_i, G_i, X_i)]`（§3.1, Eq.3）。
- encoder 引 Reimers & Gurevych (2019)（即 Sentence-BERT 系），**维度未给**。

**E. 检索路径**
- 纯 cosine 相似度取 top-k（§3.4, Eq.8–9）；`M_retrieved = {m_i | rank(s_q,i) ≤ k}`。
- **链接结构不参与检索打分**（只用 embedding），这是 A-Mem 的一个明显缝隙。
- 无 rerank、无 MMR、无时间过滤。k 有扫描实验：Figure 3 显示 k 增大收益递减；具体各类别最佳 k 在 Table 5（「Selection of k values in retriever across specific categories and model choices」）——**逐格数值本轮未取**。

**F. 上下文构造**
- top-k 检索到的 notes 组成历史上下文（§3.4）。
- token 用量：**1,200–2,500 tokens**，对比 LoCoMo / MemGPT 的 **16,900**（§4.4）。

**G. 消融数字（Table 2，LoCoMo，GPT-4o-mini 系）**
| 配置 | Single Hop F1/B1 | Multi Hop F1/B1 | Temporal F1/B1 | Open Domain F1/B1 | Adversarial F1/B1 |
|---|---|---|---|---|---|
| w/o LG & ME | 9.65 / 7.09 | 24.55 / 19.48 | 7.77 / 6.70 | 13.28 / 10.30 | 15.32 / 18.02 |
| w/o ME（只留 LG） | 21.35 / 15.13 | 31.24 / 27.31 | 10.13 / 10.85 | 39.17 / 34.70 | 44.16 / 45.33 |
| A-Mem（full） | 27.02 / 20.09 | **45.85 / 36.67** | 12.14 / 12.00 | 44.65 / 37.06 | 50.03 / 49.47 |

（§4.4 Table 2 / §4.5）结论：**LG 贡献大于 ME**（去掉两个模块 multi-hop F1 掉到 24.55，只去 ME 已回到 31.24），ME 是「精修」。

**H. 工程代价**
- 检索上下文 token：1,200–2,500（§4.4）。
- 第三方测量：A-Mem* **13.0 次 LLM 调用/响应、2,712 tokens、avg F1 26.55**（arXiv:2506.06326v1, Table 3）；搜索延迟 **p50 0.668s，total p50 1.410s**（arXiv:2504.19413v1, §4.4）。
- MemoryOS 论文的定性批评：A-Mem 的「heavy, multi-step link generation inflates latency and error accumulation」（arXiv:2506.06326v1, §4.2）。

> **对我们最有借鉴价值的 1 个点**：**embedding 粗筛 + LLM 精判的两段式链接生成**：先用向量 top-k 把候选压到很小集合再让 LLM 判定关系，兼顾可扩展性与语义细度（§3.2）。

---

## 5. MemoryOS（arXiv:2506.06326v1）

**A. 写入路径（OS 式分层）**
- **STM**：以 **dialogue page** 为单元的原始 turn 粒度 `page_i = {Q_i, R_i, T_i}`；每页另建 **dialogue chain**，meta 由 LLM 两步生成（① 判断新页与前页的上下文相关性决定挂链或重置；② 把链上所有页摘要成 `meta_chain`）（§3.2）。
- **MTM**：段页式（segmented paging）。page 与 segment 的匹配分 `F_score = cos(e_s,e_p) + Jaccard(K_s,K_p) > θ`（θ=0.6）即并入该段；**段内容由 LLM 基于段内页摘要生成**（§3.2, Eq.2–3）。
- **LPM**：`heat > τ(=5)` 的段晋升到 LPM，更新 **User Traits**（90 维，三类：basic needs/personality、AI alignment dimensions、content platform interest tags）、**User KB**、**Agent Traits**；后两者各为固定 100 条 FIFO 队列（§3.2）。
- LLM 参与点：chain 相关性判定、chain 摘要、段摘要、关键词、traits/KB 抽取。

**B. 写时合并 / 冲突解决**
- 无四决策。替代机制：**heat 淘汰**（段数超上限时驱逐 heat 最低者）+ **FIFO**（User KB / Agent Traits 100 条）+ 晋升后把 `L_interaction` **重置为 0**，使 heat 回落，从而「持续演化人格而无冗余」（§3.2）。

**C. 时间处理**
- 每页带 `T_i`；`R_recency = exp(−Δt/μ)`，`μ = 1e+7` 秒，Δt = 距上次检索时长（§3.2, Eq.4）。时间只进 heat 公式，**不做查询时过滤**。

**D. 索引键**
- 段 embedding + 段/页的 **LLM 摘要关键词集**（`K_s, K_p` 用于 Jaccard）；embedding 模型与维度**未给**。

**E. 检索路径**
- MTM 两阶段：先 `F_score` 取 **top-m=5 段**，再段内按语义相似取 **top-k 页**（GVD k=5，LoCoMo k=10）（§3.3–3.4、§4.1 实现细节）。
- STM：全部页取回（最近上下文）；LPM：User KB 与 Agent Traits 各取 **top-10**；User/Agent Profile 与 User Traits 全量使用（§3.4）。
- 检索后回写 `N_visit` 与 `R_recency`（在线更新热度）。无 rerank / MMR。

**F. 上下文构造**
- STM + MTM 检索结果 + LPM 检索结果 + query 拼成最终 prompt（§3.5）。
- 实测召回 tokens **3,874**（vs MemGPT 16,977、A-Mem* 2,712、TiM 1,274、MemoryBank 432）（Table 3）。

**G. 消融数字**
- 消融**只有 Figure 2 柱状图，未给数值**：去掉顺序影响为 `-MTM > -LPM > -Chain`，`-MemoryOS`（整个系统）掉幅最大（§4.3）。
- 主结果：LoCoMo（gpt-4o-mini）平均 **F1 +49.11% / BLEU-1 +46.18%**（相对提升）；GVD 上比 SOTA 基线 A-Mem 高 **3.2%** accuracy（§4.2）。
- 效率表（Table 3，tokens / avg LLM calls / avg F1）：MemoryBank 432 / 3.0 / 6.84；TiM 1,274 / 2.6 / 18.01；MemGPT 16,977 / 4.3 / 29.13；A-Mem* 2,712 / 13.0 / 26.55；**MemoryOS 3,874 / 4.9 / 36.23**。

**H. 工程代价**
- LLM 调用 **4.9 次/响应**（A-Mem* 13 次），召回 tokens 3,874（Table 3）；论文称 token 与调用数都优于 Top-2 基线（§4.2）。
- 超参：STM 队列长度 **7**、MTM 段上限 **200**、User KB/Agent Traits **100**、τ=**5**、α=β=γ=**1**、top-m=**5**、k=5/10、θ=**0.6**、μ=**1e+7**（§4.1）。
- 硬件：8×H20 GPU（§4.1）。写入延迟：未给。

> **对我们最有借鉴价值的 1 个点**：**可数值化的分层淘汰公式** `Heat = α·N_visit + β·L_interaction + γ·R_recency`，配合「晋升即清零 L_interaction」，把「哪些记忆该留在热层」变成可调参、可解释的排序问题。

---

## 6. LangMem / LangGraph Memory（官方文档；**无 arXiv 论文**）

来源：`langchain-ai.github.io/langmem/concepts/conceptual_guide/`（2026-10-26 抓取）。
- **A. 写入路径**：统一模式 = 「接对话 + 当前 memory state → prompt LLM 决定如何 expand/consolidate → 返回更新后的 state」。两条执行路径：**hot path**（对话内联）与 **background**（让 agent 在空闲时用工具自主整理记忆，文档小节「Defer Background Memory Processing」）。抽取示例 prompt：「Extract all noteworthy facts, events, and relationships. Indicate their importance.」→ 输出 `ExtractedMemory` 列表。
- **B. 写时合并**：文档明确说 collection 型记忆「must reconcile new information with previous beliefs」；**不固定四决策**，交给 prompt。无失效标记机制描述。
- **C. 时间处理**：文档未给时间戳/区间机制 —— **未取得**。
- **D. 索引键**：LangGraph `BaseStore` + **namespace**（如 user_id / assistant_id、可动态命名空间）；向量检索由 store 提供，embedding 由用户自选。
- **E. 检索路径**：`store.search(namespace, query, limit/offset/filter)` 式 API，k 由调用方指定；无内建 rerank / MMR（**未取得**）。文档有一条重要观点：**recall 应结合 similarity + importance + strength，而不是纯语义相似度**。
- **F. 上下文构造**：语义记忆两种落地形态 —— **collection**（无界知识，运行时搜）与 **profile**（严格 schema，便于按 user/agent 直查）；也支持「直接放进 prompt」。三类记忆：semantic（facts/knowledge）、episodic（past experiences）、procedural（system instructions/行为规则）。
- **G. 消融**：无论文、无消融。
- **H. 工程代价**：文档无数字。第三方实测（arXiv:2504.19413v1, Table 2/§4.4）：LangMem 搜索 **p50 17.99s / p95 59.82s**，论文称「rendering it impractical for interactive applications」。

> **对我们最有借鉴价值的 1 个点**：**hot path / background 的成本分层**——对话内只做便宜且必须即时生效的写入，重整理（去重、合并、重构）延到后台，主动避免把昂贵 LLM 链放进用户等待路径。

---

## 7. Cognee / Memobase / Supermemory

- **Cognee**：仓库存在（topoteretes/cognee），但**未找到 arXiv 论文**；本轮 `fastly.jsdelivr.net/gh/topoteretes/cognee@main/README.md` 抓取失败，**可引用的工程细节未取得**。不下结论。
- **Memobase / Supermemory**：**未找到 arXiv 论文**；工程文档本轮未取得。不下结论。
- 说明：以上三者若后续要写，需要单独一轮抓取（docs 站点 / API 文档 / 仓库代码），本报告不臆测其机制。

---

## 8. 检索结构对照组

### 8.1 RAPTOR（arXiv:2401.18059v1）——树状递归摘要

- **A. 写入路径**：分段为 **100 tokens** 的连续 chunk（§3）；用 SBERT embedding → **UMAP 降维 + GMM 软聚类**（节点可属多簇；用 **BIC** 选簇数，EM 估计参数）→ LLM 逐簇生成摘要 → 递归向上直到根（§3、§3.1）。**不做事实抽取**，是纯递归摘要。
- **B. 合并/冲突**：无（只追加树）。
- **C. 时间**：无时间戳、无时间过滤。
- **D. 索引键**：每个树节点（chunk 或 summary）的 SBERT embedding；多层级 = 多粒度表征。
- **E. 检索路径**：① **tree traversal**：逐层 top-k 下钻（可调 depth `d` 与每层 `k`，§3.2）；② **collapsed tree**：所有层节点一起做 cosine top-k（§3.2）。论文在 QASPER 20 篇上比较：**collapsed tree 更灵活且更好**，故采用（§3.2 + Figure 3）。无 rerank / MMR / 时间过滤。
- **F. 上下文**：检索节点文本进 reader；token 成本随文档长度**线性**（Figure 5）。
- **G. 消融数字**：
  - 聚类机制消融（Table 9，QuALITY，SBERT+UnifiedQA）：**RAPTOR 56.6%** vs **recency-based tree 55.8%**。
  - 有/无 RAPTOR（Table 2，QuALITY / QASPER Answer F1，UnifiedQA-3B）：SBERT 54.9% → **56.6%**；QASPER 36.23% → 36.70%。
  - NarrativeQA（Table 1，UnifiedQA-3B）：SBERT 29.26% ROUGE / 22.56% BLEU-1 → **30.87% / 23.50%**。
  - QuALITY hard subset：GPT-4 + RAPTOR 达 SOTA（Table 7）。
- **H. 工程代价**：token 支出与 build time 均对文档长度线性（Figure 5/6，Apple M1 上测）；平均摘要长度与子节点长度统计在 Table 10（**逐格数值本轮未取**）；无在线检索延迟数字。

> **借鉴点**：**collapsed tree（跨层统一检索）优于逐层下钻**，而且实现更简单 —— 分层结构不必对应分层检索。

### 8.2 HippoRAG（arXiv:2405.14831v3）——图 + Personalized PageRank

- **A. 写入路径**：离线对每个 passage 顺序做 **NER + OpenIE**（默认 **GPT-3.5-turbo-1106**, temperature 0）抽成概念节点与关系边；再加 **synonymy 边 E'**（两个实体 embedding 的 cosine > τ 时连边）；检索器默认 **Contriever** 或 **ColBERTv2**（§2、§3）。
- **B. 合并/冲突**：无冲突解决；实体消解以**加同义边**实现，不合并节点（§3）。
- **C. 时间**：无时间戳、无时间过滤。
- **D. 索引键**：实体名/概念节点的 embedding（用于映射 query 概念）；passage 侧另有独立检索索引。Contriever 维度论文**未给**。
- **E. 检索路径**：query 抽取概念 → 映射为 **query nodes `R_q`**（每个概念取 embedding 最近节点）→ 在 KG 上跑 **Personalized PageRank** → 节点分数按**分数聚合**映射回 passage → top-k（评估 k=2/5，§3、Table 5）。可与 IRCoT 结合做 multi-step（Table 3）。无 rerank / MMR / 时间过滤。
- **F. 上下文**：检索出的 passage 原文进 reader（QA）。
- **G. 消融数字（Table 5，R@2/R@5，Average 列）**
  | 配置 | MuSiQue R@2/R@5 | 2Wiki R@2/R@5 | HotpotQA R@2/R@5 | Average R@2/R@5 |
  |---|---|---|---|---|
  | **HippoRAG** | 40.9 / 51.9 | 70.7 / 89.1 | 60.5 / 77.7 | **57.4 / 72.9** |
  | OpenIE 换 REBEL | 31.7 / 39.6 | 63.1 / 76.5 | 43.9 / 59.2 | 46.2 / 58.4 |
  | OpenIE 换 Llama-3.1-8B-Instruct | 40.8 / 51.9 | 62.5 / 77.5 | 59.9 / 75.1 | 54.4 / 67.8 |
  | OpenIE 换 Llama-3.1-70B-Instruct | 41.8 / 53.7 | 68.8 / 85.3 | 60.8 / 78.6 | 57.1 / 72.5 |
  | PPR 替代：只用 `R_q` 节点（不打散） | 37.1 / 41.0 | 59.1 / 61.4 | 55.9 / 66.2 | 50.7 / 56.2 |
  | PPR 替代：`R_q` 节点 + 邻居 | 25.4 / 38.5 | 53.4 / 74.7 | 47.8 / 64.5 | 42.2 / 59.2 |
  | w/o Node Specificity | 37.6 / 50.2 | 70.1 / 88.8 | 56.3 / 73.7 | 54.7 / 70.9 |
  | w/o Synonymy Edges | 40.2 / 50.2 | 69.2 / 85.6 | 59.1 / 75.7 | 56.2 / 70.5 |

  （另：单步检索基线 BM25 在 Average 上 R@2 = 46.5，Table 2。）
- **H. 工程代价**：索引为一次性离线成本（每 passage 两次 LLM 调用：NER + OpenIE）。KG 规模（Table 1）：MuSiQue 11,656 passages → **91,729 唯一节点 / 21,714 唯一边**。超参：synonymy 阈值 **τ=0.8**、**PPR damping factor = 0.5**（用 MuSiQue 训练集 100 例调出）（§4）。在线延迟**未给**。

> **借鉴点**：**用 PPR 图扩散代替 top-k 相似度**做联想式多跳召回，且「node specificity」（概念节点而非泛化实体）本身贡献显著（去掉后 avg R@2 57.4 → 54.7）。

### 8.3 MemoryBank（arXiv:2305.10250v3）——摘要 + 人格 + Ebbinghaus 遗忘

- **A. 写入路径**：① 逐轮**原始对话**按时间顺序存（带时间戳）；② **Hierarchical Event Summary**：LLM 把冗长对话压成**每日事件摘要**，再合成**全局摘要**（两层）；③ **Dynamic Personality Understanding**：每日人格洞察 → 聚合成全局人格（§2.1）。
- **B. 合并/冲突**：无四决策、无失效标记；只有遗忘（§2.3）。
- **C. 时间处理**：每条记忆带时间戳；`R = e^{−t/S}`，t = 距学习的时间，S = 记忆强度，初始 1；**被回忆时 S += 1 且 t 重置为 0**（间距效应），于是遗忘概率下降（§2.3）。
- **D. 索引键**：每轮对话与事件摘要的 dense 表示（DPR 式**双塔** dense retrieval），**FAISS** 建索引；encoder 可替换，维度**未给**（§2.2）。
- **E. 检索路径**：query 编码后在 FAISS 上取最相关记忆（top-k，k 值未给）；无 rerank / MMR；时间通过存活/衰减影响，不做查询过滤。
- **F. 上下文**：检索到的 memory pieces 进 prompt；无 token 预算数字。
- **G. 消融数字**：**无机制消融**。定量表（Table 2，英文/中文 × 三个 SiliconFriend 变体，Retrieval Acc. / Correctness / Coherence / Ranking）：英文 ChatGPT 0.763 / 0.716 / 0.912 / 0.818；BELLE 0.814 / 0.479 / 0.582 / 0.517；ChatGLM 0.809 / 0.438 / 0.68 / 0.498；中文 BELLE 检索准确率 0.856（§3 结果分析）。
- **H. 工程代价**：论文未给延迟/成本。第三方测量：MemoryBank 召回 tokens **432**、LLM 调用 **3.0**、avg F1 **6.84**（arXiv:2506.06326v1, Table 3）——成本极低但效果最差，被 MemoryOS 论文点名「simply applying memory decay mechanisms is insufficient」（同文 §4.2）。

> **借鉴点**：**把「强度 S + 时间衰减」做成显式遗忘账本**（召回即 S+=1、t=0），用极小成本实现选择性保留——但需注意单靠衰减不足以支撑对话记忆（第三方实测 F1 6.84）。

---

## 9. 对比表（系统 × A–F 浓缩）

| 系统 | A 写入粒度 / LLM 次数 | B 写时合并 | C 时间 | D 索引键 | E 检索 | F 上下文 |
|---|---|---|---|---|---|---|
| **Mem0** (2504.19413) | 每 message pair → **fact**；1 抽取 + 每 fact 1 决策；异步会话摘要 | **四决策 ADD/UPDATE/DELETE/NOOP**（LLM tool call，先取 top-10 相似） | Mem0 无；`Mem0^g` 节点 creation ts | dense embedding（模型/维度未给）；`Mem0^g` 节点+triplet 文本编码 | 向量 top-k；`Mem0^g` 双路（entity-centric 子图 + triplet 相似度阈值） | 自然语言完整对话轮；格式细节未取得；store 7k tok/对话 |
| **Zep/Graphiti** (2501.13956) | Episode → entity + fact edge + community；抽取上下文 n=4；无调用计数 | **edge invalidation**（t_invalid := 新边 t_valid，优先新信息）+ 实体/边去重（同实体对内 hybrid search） | **bi-temporal 四时间戳** t_valid/t_invalid/t'_created/t'_expired + t_ref 解析相对时间 | 实体名 **1024 维** embedding + BM25（entity name/summary/fact/community name） | cosine + BM25 + **BFS** 三路；reranker：**RRF / MMR / episode-mentions / node-distance / cross-encoder**；实验 top-20 | 重组成 context string（FACTS / ENTITIES 模板）；实测 1.6k tok |
| **MemGPT/Letta** (2310.08560) | 不抽事实；原始消息/文档；**LLM 自主 function call**（可 heartbeat 链式） | 无；只有上下文编辑 + FIFO 驱逐（warning token count 触发） | 未取得 | embedding-based ranking（模型/维度未给） | 函数式检索 + **pagination**；k 未给；无 rerank | 三段拼接成单一字符串（instructions + working + FIFO）；显式 token 预算 |
| **A-Mem** (2502.12110) | 每交互 → **note**(c,t,K,G,X,e,L)；≈2+k 次 LLM | 无四决策；**倒改旧条目**（m_j* 替换 m_j） | note 带 t_i；检索不用时间 | **fact-augmented**：concat(c,K,G,X) 的 SBERT embedding（维度未给） | cosine top-k（k 有扫描，Table 5 数值未取）；链接不参与检索；无 rerank | top-k notes；1,200–2,500 tok |
| **MemoryOS** (2506.06326) | page(Q,R,T) → LLM chain meta / 段摘要 / 关键词 / traits；LPM 90 维 traits | 无四决策；**heat 淘汰 + FIFO + 晋升清零 L_interaction** | 页带 T_i；`R_recency=exp(−Δt/μ)`，μ=1e7（只进 heat） | 段 embedding + LLM 关键词集（cos + Jaccard）；模型未给 | 两阶段：top-m=5 段 → top-k(5/10) 页；LPM top-10；STM 全取；无 rerank | STM+MTM+LPM+query 拼接；3,874 tok |
| **LangMem**（文档） | hot path 内联 / **background** 自主整理；模式=expand/consolidate | 文档要求 reconcile（无固定决策）；无失效标记 | 未取得 | LangGraph BaseStore **namespace** + 向量；embedding 自选 | `store.search(namespace, query, limit/offset/filter)`；无内建 rerank | collection（无界，运行时搜）/ profile（严格 schema）/ 直接进 prompt |
| **RAPTOR** (2401.18059) | 100-token chunk → UMAP+GMM 软聚类 → LLM 递归摘要（写入即建树） | 无 | 无 | 每个树节点的 SBERT embedding（多粒度） | **collapsed tree**（全层 cosine top-k）优于 tree traversal；无 rerank | 节点文本进 reader；token 成本线性 |
| **HippoRAG** (2405.14831) | 每 passage NER + OpenIE → 概念节点+边 + synonymy 边（GPT-3.5-turbo, temp 0） | 无（同义边代替合并） | 无 | 概念节点 embedding（Contriever/ColBERTv2，维度未给） | 概念→**PPR（damping 0.5）**→分数聚合到 passage；无 rerank/MMR | passage 原文进 reader |
| **MemoryBank** (2305.10250) | 逐轮原文 + 每日/全局事件摘要 + 每日/全局人格（LLM 摘要） | 无；**Ebbinghaus 遗忘**（R=e^{−t/S}，召回 S+=1, t=0） | 记忆带时间戳，只影响存活/衰减 | 双塔 dense（DPR 式）+ FAISS（维度未给） | dense top-k；无 rerank；无时间过滤 | memory pieces 进 prompt；无 token 数字 |

---

## 10. 哪些机制被 ≥3 个系统独立实现（= 行业标配）

1. **LLM 抽取「语义单元」而非只存原文**（7/9：Mem0 fact、Zep entity+fact edge、A-Mem note、MemoryOS 段摘要/关键词/traits、RAPTOR 递归摘要、HippoRAG 三元组、MemoryBank 事件摘要+人格）。
2. **向量相似度作为第一跳召回**（9/9 全覆盖：Mem0、Zep cosine、MemGPT embedding ranking、A-Mem、MemoryOS 段/页、LangMem store、RAPTOR、HippoRAG 概念映射、MemoryBank FAISS）。
3. **分层 / 多粒度存储**（6/9：Mem0 消息→摘要→图、Zep episode→entity→community、MemGPT working→recall→archival、MemoryOS STM→MTM→LPM、MemoryBank turn→日摘要→全局、RAPTOR chunk→多级摘要）。
4. **原始 episode 与派生语义并存，可回溯引用**（4/9：Zep（episodic subgraph 显式非损失 + 双向索引）、MemGPT（recall storage）、MemoryOS（STM 保留原始页）、MemoryBank（逐轮原文 + 摘要并存））。
5. **时间只进元数据 / 排序权重，不做查询时过滤**（5/9：Mem0^g、A-Mem、MemoryOS（heat 里的 recency）、MemoryBank（R=e^{−t/S}）、HippoRAG/RAPTOR 完全无时间）。**唯一的例外是 Zep**：只有它把时间做成检索语义（bi-temporal + invalidation）。
6. **「写时冲突解决」尚未成为标配**（1/9 明示四决策：只有 Mem0；Zep 是失效标记；其余无）。反而是「**不删、只标失效 / 只降权**」这一弱化形式被 3 家采用（Mem0^g 标 invalid、Zep 设 t_invalid、MemoryOS/Bank 用热度或衰减降权）。
7. **rerank / MMR 在记忆系统论文里是少数派**（1/9：只有 Zep 系统化支持 RRF / MMR / episode-mentions / node-distance / cross-encoder；其余论文未见）。这是和我们现有 pipeline 相比最可能的差异化空间。
8. **在线检索回写热度/访问计数**（2/9 显式：MemoryOS 更新 `N_visit`/`R_recency`、MemoryBank 回忆时 S+=1 且 t=0）——低于 3，未成标配，但两家都是「低成本 + 效果好」的一方。

---

## 11. 「未取得」清单（禁止编造，逐条列出）

| 项 | 状态 |
|---|---|
| Mem0 的 embedding 模型名 / 维度 | 原文未给 |
| Mem0 Table 1 逐格 F1/BLEU-1/J 数值 | 本轮未取（仅取到 overall J 与相对提升） |
| Mem0 上下文给 LLM 的具体格式与 token 预算 | 原文未给 |
| Zep 在图构建阶段的 LLM 调用计数 | 原文未给 |
| Zep 是否有显式时间过滤参数 | 原文未提及 |
| MemGPT 的 embedding 模型/维度、检索 k 值、延迟与成本 | 原文未给 |
| A-Mem 的 SBERT 维度、Table 5 各类别最佳 k 数值 | 原文未给 / 本轮未取 |
| A-Mem 是否有机制级消融之外的超参敏感度数字 | 仅 Figure 3（图，无数值） |
| MemoryOS 消融的具体分数 | 仅 Figure 2（柱状图，无数值） |
| MemoryOS 的 embedding 模型/维度、写入延迟 | 原文未给 |
| LangMem / Cognee / Memobase / Supermemory 的论文 | 未找到 arXiv 论文 |
| Cognee 可引用的工程细节 | 本轮 README 抓取失败（jsdelivr 404/network） |
| RAPTOR Table 10 摘要长度统计数值、在线检索延迟 | 本轮未取 / 原文未给 |
| HippoRAG 的 Contriever 维度、在线延迟 | 原文未给 |
| MemoryBank 的 encoder 维度、检索 k、延迟成本 | 原文未给 |
| 各系统的「每消息 LLM 调用次数」统一口径 | 除 A-Mem（≈2+k）与 MemoryOS（4.9/响应实测）外，多数论文未给 |