# TDB 灵魂渲染层调研｜2025-2026 前沿论文与工程实践

> 日期：2026-10-19 ｜ 调研人：研究 subagent（ac811af3）经 lead 落盘
> 方法：advanced_search(exa/bing) 检索 12 组关键词，web_fetch 核对 10+ 原文摘要；每条附 URL。
> 关联：docs/research/2026-10-16-agent-soul-selfhood-survey-td-agemem.md（第一性原理基线）；
> 本轮针对「渲染层为何显得像半成品」做增量调研（身份格式/情绪呈现/红线/评测/反思回路/去重多样性）。

## 一、自我建模/身份渲染格式（Q1）

- **ID-RAG（2025.09）**：把 persona 做成「动态结构化身份模型」（核心信念/特质/价值观的知识图），在决策循环中按需检索身份上下文注入，直接缓解长程身份漂移、无视既有信念、幻觉传染——身份不是一次性塞清单，而是「图+按情境检索」。 https://arxiv.org/abs/2509.25299
- **Park et al. 千人 agent（arXiv 2411.10109, v3 2026）**：以 2 小时叙事访谈构建的 agent，在 GSS 问卷外推上达本人两周重测一致性的 83%，纯结构化问卷 82%，合并 86%——第一人称叙事自述 ≥ 条目化结构化数据，是身份证据的最优单源。 https://arxiv.org/abs/2411.10109
- **渲染格式本身是变量**：FormatSpread 显示格式选择可造成最高 76 个百分点的性能差距 https://arxiv.org/abs/2310.11324 ；强制 JSON/XML 输出格式会牺牲推理质量（XML 较 JSON 温和） https://arxiv.org/abs/2408.02442 。工程惯例：Anthropic 官方用 XML 标签划分语义区块 https://academy.claude.com/courses/building-with-the-claude-api/structure-with-xml-tags
- **空白点**：未找到 2025 年直接对照「清单式 vs 叙事式 persona 注入」的论文；最接近的证据链 = 访谈叙事>问卷条目（2411.10109）+ 图式身份按需检索（2509.25299），方向都指向叙事自述+结构化检索，而非纯清单。
- **警示**：The Personality Illusion（2025.09）发现 LLM 自我报告人格与实际行为脱节——身份块里写的「品格/承诺」不必然兑现为行为，必须配行为层校验。 https://arxiv.org/abs/2509.03730

## 二、情绪/心境建模（Q2）

- **2026 新证据**：第一人称情绪前缀对数学/医学等客观任务准确率通常只是小幅扰动，不是可靠的通用杠杆；但社交推理等情境化任务上效应更不均匀，且要自适应挑选情绪框架（EmotionRL）才有收益——情绪该为「行为一致性」服务而非当性能开关。 https://arxiv.org/abs/2604.02236
- **先驱 EmotionPrompt（2023）**报情绪刺激句提升表现 https://arxiv.org/abs/2307.11760 ，但 2026 复检显示静态情绪前缀效应量小且任务依赖（同上 2604.02236）。
- **长对话中模型难以维持稳定情绪轨迹、难以进入极端情绪、难以随情境切换（2025.03）**——聚合标签（mood: positive）表达不了「当下」，情绪行必须情境化生成。 https://arxiv.org/abs/2503.02457
- **2025 起情绪被当一等公民建模**：EvoEmo 用进化搜索优化谈判 agent 的情绪策略 https://arxiv.org/abs/2509.04310 ；RLVER 用可验证情绪奖励训练共情 agent https://arxiv.org/abs/2507.03112 ；社交模拟引入欲望驱动的情绪认知框架 https://arxiv.org/abs/2510.13195
- **倾向结论**：渲染层用「情境化第一人称感受+行为倾向」（如「我现在有点急躁，倾向快下结论」），third-person 聚合标签只适合存储/统计层。

## 三、红线/硬约束最佳实践（Q3）

- **措辞**：否定式禁令「比看起来弱」——把注意力激活到被禁事物上且不给替代路径；只留给真正的 hard stop，其余一律正向行为框架。 https://contextpatterns.com/patterns/negative-constraints/
- **指令层级不可靠**：六个 SOTA 模型难以一致执行 system>user 优先级且对特定约束有系统性偏差（Control Illusion, 2025.02）——红线写在 system prompt ≠ 会被执行，需评测兜底。 https://arxiv.org/abs/2502.15851
- **位置/结构**：厂商实践（Azure 安全 system message 分步指南 https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/system-message ；Google 安全 system instructions https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/safety-system-instructions ）均要求具体、分场景、关键约束前置；长 prompt 中部最易被忽略、system prompt 位置本身即偏差源 https://arxiv.org/abs/2505.21091
- **条数无学术定论**；工程模式（GO4 S5）：少量 hard stop 单独成块、可枚举、可审计，与正向人格原则分开存放。 https://jlldavies.github.io/go4-llm-design-patterns/patterns/S5-Constraint-Framing.html
- **否定跟随能力**：Jang et al. 显示被否定改写的指令常被误读（ICML 2023） https://proceedings.mlr.press/v203/jang23a/jang23a.pdf ；polarity-bench 在前沿 Claude 上得到两个预注册 null（否定与肯定跟随无显著差异） https://github.com/justuseapen/polarity-bench ——前沿模型并非听不懂禁令，但压缩+正向改写仍是稳妥默认。

## 四、人格一致性回归评测（Q4）

- **PersonaGym（EMNLP 2025 Findings）**：首个动态 persona agent 评测框架，六维=Action Justification / Expected Action / Linguistic Habits / Persona Consistency / Theory of Mind / Environment Use，可直接借作 TDB 回归维度。 https://aclanthology.org/2025.findings-emnlp.368/ ｜ https://arxiv.org/abs/2407.18416
- **漂移可量化**：双 agent 自聊 8 轮即测出显著指令漂移，归因注意力衰减并给 split-softmax 缓解（COLM 2024）——TDB 需要「N 轮自聊回归」而非一次性静态检查。 https://arxiv.org/abs/2402.10962
- **原子级保真**：ACL 2025 Findings 把 OOC（out-of-character）行为拆成可定位的原子错误类型，适合做回归断言。 https://doi.org/10.18653/v1/2025.findings-acl.1349
- **配套证据**：SIGDIAL 2025 指出「过于简单的 persona 表示」限制角色一致对话 https://aclanthology.org/2025.sigdial-1.31/ ；NeurIPS 2025 用多轮 RL 维持 persona 一致 https://proceedings.neurips.cc/paper_files/paper/2025/file/4c91443877f8388d8190c938ac5a4d4d-Paper-Conference.pdf ；身份漂移类型学 https://arxiv.org/abs/2412.00804

## 五、Generative Agents 之后的反思/记忆回路（Q5）

- **ID-RAG 是 Park 路线的直系修正**：身份/信念知识图+检索进决策环（同上 2509.25299）。
- **记忆工业化三件套**：A-MEM（NeurIPS 2025）按 Zettelkasten 给每条记忆生成结构化笔记并动态链接/演化 https://arxiv.org/abs/2502.12110 ；Mem0 生产级「抽取-整合-检索」，更新阶段对语义重叠记忆做合并/更新裁决 https://arxiv.org/abs/2504.19413 ；MemOS 把记忆当 OS 资源统一调度 https://arxiv.org/abs/2507.03724
- **反思回路趋势**：从固定频率反思转向「写入时联动+检索时组织」（A-MEM 链接生成、MemOS 调度），并用可验证奖励替代人工反思（RLVER，2507.03112）。
- **千人访谈 agent 提示**：身份一致性的关键投入在「高质量第一人称叙事语料」，而非更复杂的反思规则（2411.10109）。

## 六、语义去重/多样性（Q6）

- **MMR 是检索侧标配**（λ 平衡相关性与多样性）：Elastic 工程解读 https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results ；LangChain/LlamaIndex 内置 MMR retriever https://reference.langchain.com/javascript/langchain-core/vectorstores/MaxMarginalRelevanceSearchOptions
- **入库侧近重复控制是共识**：嵌入相似度阈值+入库查重 https://unrag.dev/docs/rag/04-retrieval/06-diversity-and-deduplication ；Mem0 在写入时用 LLM 裁决合并/更新语义重叠记忆（2504.19413）。
- **多样性不是免费的**：受控注入近重复实验显示，干净候选池上多样化反而伤害相关性与答案质量；仅当「候选池冗余高+查询需多证据」时有益，并给出 query-adaptive 规则（top-k 有效文档数 < 证据需求才启用）。 https://arxiv.org/abs/2610.09412
- **结论**：TDB 锚扎堆本质是「入库冗余」，先在写入端去重合并，渲染端只在检出冗余时启用 MMR。

## 对 TDB 的启示（5 条）

1. **soul-identity 改双层**：3-5 句第一人称叙事自述（从访谈式记忆生成，2411.10109）+ 信念/品格/承诺图式索引按情境检索注入（ID-RAG 模式，2509.25299），全量清单不再整块进 prompt。
2. **红线压缩到 ≤5 条 hard stop**：正向改写+给替代行为，与软原则分开成块并前置（contextpatterns/GO4 S5）；每次改动跑 8 轮自聊漂移回归（2402.10962）。
3. **soul-feeling 渲染为情境化第一人称「感受+行为倾向+触发事件」一行**，聚合标签只留存储层；评估口径是行为一致性而非任务分（2604.02236/2503.02457）。
4. **锚扎堆在入库端解决**：相似度阈值查重 + Mem0 式 UPDATE 合并；渲染端仅当 top-k 有效文档数不足时才启用 MMR（2610.09412）。
5. **借 PersonaGym 六维建人格一致性回归套件**，把「自我报告 vs 实际行为」的落差（2509.03730）列为重点回归项。

## 本轮落地映射（2026-10-19 质量轮）

- 启示 4 的渲染端半步已落地：soul-assembler 锚管线 embedding 语义去重通道（adEmb 阈值 0.85）+ 红线/价值锚跨段抑制（suppressAnchorOverlap）——入库端查重属后续 issue（Mem0 式 UPDATE 合并）。
- 启示 2 的条数治理已落地：strictRuleDedup.maxLines 渲染面硬上限（缺省关，config-first）；正向改写属内容治理（人工裁决面），不自动改写（真实性边界：原文直出）。
- 启示 3 的「聚合标签只留存储层」已落地：moodTier 行去实现细节括号（「近期基调：偏积极。」）。
- 启示 1/5（双层叙事身份 + PersonaGym 回归套件）为后续大项，不在本轮渲染修复范围（见缺口报告 §roadmap）。
