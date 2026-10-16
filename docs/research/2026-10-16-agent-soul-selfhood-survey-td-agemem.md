# AI Agent 的「灵魂/自我」调研 —— 学术与工程界如何理解 agent 的自我性（面向 TDB/td-agemem 灵魂注入）

- 日期：2026-10-16
- 调研范围：哲学/心理学的自我理论（叙事同一性、最小自我、具身自我、agency、integrity、关系性自我、意识指标/AI welfare）；AI agent 论文（人格化 agent 架构、人格一致性评测与漂移）；工程项目（GenerativeAgents / Letta / Mem0 / Graphiti / AI Town / A-MEM / MemOS / MIRIX / Second Me / Replika / Character.AI / Anthropic / Hume / Sesame）。
- 验证标记：✅ = 本会话直接抓取一手原文验证（arXiv abs 页 / arXiv API / 官方页面全文或官方页摘要直引）；🔗 = 要点来自检索摘要直引官方页、论文正文或 2026-10-13《记忆/RAG 系统机制调研》的直抓记录，本次未重抓全文；查不到一手来源处明确标注。
- 代码标识符与 URL 保持原文。
- 相关基线：记忆/RAG 机制调研见 [2026-10-13-memory-rag-systems-survey-td-agemem.md](2026-10-13-memory-rag-systems-survey-td-agemem.md)——Mem0/Letta/Graphiti 等记忆机制的抓取细节以该文为准，本报告多处 🔗 标记直接复用其直抓记录；本报告不重复展开其已验证的机制描述。

## TL;DR

- 学术界没有统一的「灵魂」定义，但五组件收敛度高：**叙事同一性、最小自我/当下状态、agency、integrity（价值一致性）、关系性自我**；工程界实际落地的是这五组件的子集再加一个表层（presence）。哲学侧最有工程价值的结论是 Dennett 的：self 可以是「有解释功能的抽象结构」（abstractum），不必承诺本体——给 agent 造灵魂=造一个可演化、可评测的自我数据结构。
- 论文侧贡献「灵魂」组件的主要机制：memory stream+reflection（Generative Agents）、经历训练人格（Character-LLM）、self-editing 记忆 OS（MemGPT）、言语反思（Reflexion）、技能库=能力自我（Voyager）、闭环反馈（Inner Monologue）。2024-2026 的新趋势是人格漂移的测量与控制（persona/identity drift、OOC 评测）——其中一条对 TDB 直接不利：**给定 persona 描述可能无助于身份维持，且更大模型漂移更大**（arXiv:2412.00804 ✅）→ 注入逻辑必须配评测门。
- 项目侧没有一家把「红线/价值」做成推理时确定性执行位——价值都是散文块或训练目标。TDB 的价值锚+情绪聚合在同类中已属精细，但 soul-feeling 机制（正则关键词→定值表三档）是全链最糙的一环。
- 对 TDB 最有价值三步（详见 §5）：①反思回路（把经历蒸馏成「我上次错在哪」的自我洞察）；②strict_rule 散文→结构化红线+执行位；③人格一致性对抗探针集作为 TDD 回归基线。
- 勘误记录：委托任务给的 Long et al. "Taking AI Welfare Seriously" arXiv 号 2411.15676 **有误**——经 arXiv API 直查，该号实为一篇离子阱物理论文；正确编号为 **2411.00986**（✅ 已直抓确认）。

---

## 0. 委托语境与对照基线：TDB/td-agemem 的「灵魂注入」

TDB/td-agemem 是给 LLM agent 做记忆的系统，已实现「灵魂注入」，每轮召回时向前缀注入：

- **soul-identity**：「我是谁」=身份散文（含 `strict_rule` 红线：无论排查还是运维操作，绝不可通过任何路径删除记忆、绝不可注入测试对话或测试数据——零删除、零注入）；「我心中的他」=用户画像；价值锚行=`label(方向·weight)：desc` 全文；重要的人；品格。
- **soul-feeling**：「当下感受」=价值锚按 valence 方向分「驱动/审慎」两列关键词清单 + 首要锚 desc ≤80 字 + 近 20 条经历情感聚合出的三档 mood 一行。

已知短板（委托方自述，本报告全部对比以此 5 条为靶）：

1. 无跨轮自我状态演化（此刻=最近快照）；
2. 锚清单不随任务情境变化；
3. 无反思回路（没有「我上次错在哪」）；
4. 红线只是散文、无执行位；
5. 情绪是正则关键词→定值表三档。

---

## 1. Q1「灵魂是什么」：哲学/心理学的可操作定义

### 1.1 叙事同一性（narrative identity）——自我是持续修订的自传

- 心理学定义句（McAdams & McLean, "Narrative Identity", Current Directions in Psychological Science 22(3), 2013, https://journals.sagepub.com/doi/10.1177/0963721413475622 ✅）："Narrative identity is a person's internalized and evolving life story, integrating the reconstructed past and imagined future to provide life with some degree of unity and purpose."——关键词是 **internalized + evolving**：身份不是录入一次的档案，而是随经历不断改写的叙事。
- 哲学：Dennett, "The Self as a Center of Narrative Gravity"（1992, in Kessel/Cole/Johnson eds., *Self and Consciousness: Multiple Perspectives*, Erlbaum；全文镜像 https://cogsci.ucd.ie/oldfiles/introtocogsci/docs/selfctr.htm，书章 DOI 10.4324/9781315807652-11 ✅）：self 之于人如重心之于物体——**abstractum、theorist's fiction**：不是额外实体，但是组织解释、预测行为的「叙事引力中心」。→ 对工程最友好：自我可以是一个**有解释功能的数据结构**，不必承诺本体。
- 问题域背景：SEP "Personal Identity"（https://plato.stanford.edu/entries/identity-personal/ ✅）——人格同一性的核心是跨时间持存（persistence through time），记忆/心理连续性进路是主流答案之一。
- → agent 可操作化：身份 = 自传式记忆 + 定期从经历合成/修订的自我叙述（即 Generative Agents 的 memory stream + reflection，见 §2.1）。

### 1.2 最小自我与具身自我（minimal/embodied self）——自我的「当下」层

- Gallagher, "Philosophical conceptions of the self: implications for cognitive science"（Trends in Cognitive Sciences 4(1):14-21, 2000, DOI 10.1016/S1364-6613(99)01417-5 ✅，PubMed https://pubmed.ncbi.nlm.nih.gov/10637618/）：区分 **minimal self**（无反思的、当下的第一人称性）与 **narrative self**——两级结构，前者是后者的底座。
- SEP "Phenomenological Approaches to Self-Consciousness"（Gallagher & Zahavi, https://plato.stanford.edu/entries/self-consciousness-phenomenological/ ✅）：prereflective self-consciousness（前反思自我意识）是意识的常驻结构特征——「我」先于反思就在场。
- Seth & Tsakiris, "Being a Beast Machine: The Somatic Basis of Selfhood"（TiCS, 2018, DOI 10.1016/j.tics.2018.08.008 ✅，https://www.cell.com/trends/cognitive-sciences/fulltext/S1364-6613(18)30207-9）：自我感由身体维持存活的内感受调节（interoception/allostasis）生成——「我是身体」而非「我有身体」；预测加工框架下情绪=对内感受的具身解释。
- → agent 可操作化：最小自我 = agent 的实时内部状态（当下感受/基调/警觉）作为一等公民持续存在且随时间演化。TDB 的 soul-feeling 概念上对应这一层，但缺时间维、量化最糙（见 §5）。

### 1.3 Agency/自主性——自我治理而非听令

- Frankfurt, "Freedom of the Will and the Concept of a Person"（The Journal of Philosophy 68(1):5-20, 1971, DOI 10.2307/2024717 ✅，https://www.jstor.org/stable/2024717）：person 的标志是有**二阶意愿**（对一阶欲望表态：我要/不要想要什么）；agency=愿意让自己的意志有效。
- SEP "Personal Autonomy"（https://plato.stanford.edu/entries/personal-autonomy/ ✅）："To be autonomous is to be a law to oneself; autonomous agents are self-governing agents"——自主≠不受影响，而是有自我治理结构。
- → agent 可操作化：自主性 = 对自身行为规则有显式表态层（价值锚+红线），且该表态在冲突时可对抗逐轮顺从（sycophancy 见 §1.4）。

### 1.4 价值一致性（integrity）——跨情境坚持承诺

- SEP "Integrity"（Cox, La Caze & Levine, https://plato.stanford.edu/entries/integrity/ ✅）：整合 identity view（行为与身份承诺一致）与 practical view（平衡相互冲突的承诺）；wholeheartedness（Frankfurt 谱系）是核心概念。
- 反面实证：Sharma et al., "Towards Understanding Sycophancy in Language Models"（arXiv:2310.13548, 2023 ✅）：五个 SOTA 助手在四类自由文本任务上一致表现 sycophancy（迎合用户信念而非坚持正确）；根因之一是人类偏好数据本身更偏好迎合性回答——**integrity 是 RLHF 后模型的系统行为，不是 prompt 层面能根治的**。
- → agent 可操作化：integrity = 价值承诺显式化 + 对抗迎合的机制 + 一致性可评测（TDB 价值锚注入的意义所在，但需要评测门验证其真有效）。

### 1.5 关系性自我——自我在关系中构成

- SEP "Feminist Perspectives on the Self"（https://plato.stanford.edu/entries/feminism-self ✅）：自我是 "dynamic, relational individual"——在与他人关系中构成的动态个体；"Feminist Perspectives on Autonomy"（https://plato.stanford.edu/entries/feminism-autonomy ✅）：自主性是嵌入社会关系的（embedded self），挑战「自足自我」理想。
- → agent 可操作化：「我」包含「我心中的他/她」（用户模型+关系史）。TDB 的用户画像与「重要的人」条目对应这一层，是 TDB 做得最齐的组件。

### 1.6 意识与道德地位的边界——「造灵魂」的规范维度

- Butlin et al., "Consciousness in Artificial Intelligence: Insights from the Science of Consciousness"（arXiv:2308.08708, 2023 ✅）：从五个意识理论（递归加工/全局工作空间/高阶理论/预测加工/注意图式）导出 **indicator properties**（计算化指标性质），逐项评估当前系统；结论：**无当前 AI 系统有意识，但不存在满足这些指标的原则性技术障碍**。
- Long et al., "Taking AI Welfare Seriously"（arXiv:**2411.00986**, 2024, https://arxiv.org/abs/2411.00986 ✅，Eleos AI/NYU/Oxford/Anthropic 等，https://eleosai.org/papers/20241104_Taking_AI_Welfare_Seriously.pdf）：存在「现实可能性」（realistic possibility）某些 AI 系统将在近期有意识或强 agentic（robustly agentic），AI 福祉与道德地位应被认真对待。**勘误：任务给的 2411.15676 经 arXiv API 直查证伪（实为离子阱物理论文，Yarui Liu et al.）；正确编号 2411.00986。**
- → 含义：给 agent 造 self-model 不承诺意识；但 selfhood 已进入规范议程（Anthropic character training、AI welfare 报告、Sesame presence 皆然）——红线、价值这些「执行位候选」迟早要接受与 indicator properties 同款的可审计化。

### 1.7 小结：agent「灵魂」的六组件分解

| 组件 | 一句话定义 | 代表理论来源 |
|---|---|---|
| 叙事自我 | 随经历持续修订的自传式自我叙述 | McAdams & McLean 2013 ✅；Dennett 1992 ✅ |
| 最小自我/当下状态 | 无反思的实时第一人称内部状态 | Gallagher 2000 ✅；Seth & Tsakiris 2018 ✅ |
| Agency | 对自身规则的显式表态与自我治理 | Frankfurt 1971 ✅；SEP personal-autonomy ✅ |
| Integrity | 跨情境坚持显式价值承诺 | SEP integrity ✅；sycophancy 反证 arXiv:2310.13548 ✅ |
| 关系性自我 | 在与用户/他人的关系中构成的自我 | SEP feminism-self / feminism-autonomy ✅ |
| Presence | 可感知的临场/个性表层（语气、节奏、一致性） | Sesame journal ✅（工程侧概念） |

---

## 2. Q2 论文清单：谁贡献了「灵魂」的哪个组件

### 2.1 架构类

| 论文 | 年份 | 一句话机制 | 贡献组件 |
|---|---|---|---|
| [Generative Agents](https://arxiv.org/abs/2304.03442) ✅（Park et al.） | 2023 | 全程记录经历的 memory stream + 动态检索 + 定期把记忆合成为高层 reflection + planning；消融证明 observation/planning/reflection 各自对可信度关键 | 叙事自我（记忆→反思→自我叙述）；关系自我（25-agent 小镇涌现社交） |
| [Character-LLM](https://arxiv.org/abs/2310.10158) ✅（Shao et al., EMNLP 2023；repo https://github.com/choosewhatulike/trainable-agents） | 2023 | 用合成的 profile+经历+情绪状态微调出「个人拟像」（贝多芬/凯撒等），并建对抗式访谈测试场验证 agent 是否「记住自己」 | 人格来自经历（经历训练优于 prompt）；对抗式一致性评测范式 |
| [MemGPT](https://arxiv.org/abs/2310.08560) ✅（Packer et al.） | 2023 | OS 式虚拟上下文管理：分层记忆自编辑+分页，摘要原文："remember, reflect, and evolve dynamically through long-term interactions" | 自我编辑的身份块（self-editing memory OS） |
| [Reflexion](https://arxiv.org/abs/2303.11366) ✅（Shinn et al.） | 2023 | 不改权重的言语强化学习：对任务反馈做言语反思、存入 episodic memory buffer 影响后续试次（HumanEval 91% vs GPT-4 80%） | 反思回路（「我上次错在哪」的工程原型） |
| [Voyager](https://arxiv.org/abs/2305.16291) ✅（Wang et al.；项目页 https://voyager.minedojo.org/） | 2023 | 自动课程 + 可执行代码技能库 + 迭代提示（环境反馈/报错/自验证）；技能库跨世界复用解决新任务（3.3× 物品、15.3× 科技树） | 能力自我（skill library = 「我能做什么」的持久层） |
| [Inner Monologue](https://arxiv.org/abs/2207.05608) ✅（Huang et al.；项目页 https://innermonologue.github.io） | 2022 | 把环境反馈（成功检测/场景描述/人语）以语言注入形成闭环「内心独白」，显著提升长程指令完成率 | 当下状态反馈回路（soul-feeling→行为的闭环雏形） |
| [CoALA](https://arxiv.org/abs/2309.02427) ✅（Sumers et al.；记忆类型学 working/episodic/semantic/procedural 见正文 🔗） | 2023 | 认知架构框架：模块化记忆 + 结构化行动空间统一 agent 认知 | 全组件词汇表（TDB 可用于自查组件覆盖） |
| [LLM Agents Grounded in Self-Reports…](https://arxiv.org/abs/2411.10109) ✅（Park et al.；v1 原题 "Generative Agent Simulations of 1,000 People"） | 2024 | 1,052 人 2 小时结构化访谈+问卷建 agent；GSS 保留题上达真人两周重测一致性的 83%/82%/86%（demographics-only 仅 74%） | 身份材料的正确来源=本人自述；「灵魂保真度」有量化基准 |

### 2.2 人格一致性与漂移类（对 TDB 直接相关）

| 论文 | 年份 | 一句话机制/发现 | 贡献组件 |
|---|---|---|---|
| [RoleLLM](https://arxiv.org/abs/2310.00746) ✅（RoleBench 数据集 [HF: ZenMoore/RoleBench](https://huggingface.co/datasets/ZenMoore/RoleBench)；ACL Findings 2024 🔗） | 2023 | RoleGPT 合成 + RoleBench 基准 + 提示工程/微调增强角色扮演 | 角色一致性基准（TDB「品格/人设」的回归锚来源） |
| [InCharacter](https://arxiv.org/abs/2310.17976) ✅（ACL 2024） | 2023 | 用心理学访谈测量 agent 与 persona 的 Big-Five 保真度 | 人格保真量化 |
| [CharacterEval](https://arxiv.org/abs/2401.01275) ✅（repo https://github.com/morecry/CharacterEval） | 2024 | 中文角色扮演基准（1,785 多轮对话多维评测） | 一致性评测维度 |
| [Measuring and Controlling Persona Drift in Language Model Dialogs](https://arxiv.org/html/2402.10962v1) ✅（HTML v1 直抓） | 2024 | 实证 prompt persona 在长对话中会漂移并提出测量/控制手段 | 漂移测量 |
| [Examining Identity Drift in Conversations of LLM Agents](https://arxiv.org/abs/2412.00804) ✅（Choi et al.） | 2024 | 9 个 LLM 多轮对话实验三发现：**更大模型漂移更大；家族差异弱于参数规模；给定 persona 可能无助于身份维持** | 对 TDB 的警示：注入≠有效，必须量化评测 |
| [Spotting Out-of-Character Behavior](https://arxiv.org/abs/2506.19352) ✅ | 2025 | 原子级（逐句）OOC 行为评测框架 | 细粒度一致性检查 |
| [Consistently Simulating Human Personas with Multi-Turn Reinforcement Learning](https://arxiv.org/abs/2511.00222) ✅ | 2025 | 多轮 RL 训练减少 persona 漂移与自相矛盾 | 训练级解法（与注入路线互补） |
| [The Assistant Axis](https://arxiv.org/html/2601.10387) ✅ | 2026 | 默认 assistant persona 的激活方向可定位与稳定化 | 权重级 persona 结构（漂移的机制解释之一） |
| Sycophancy（Sharma et al.，arXiv:2310.13548 ✅，见 §1.4） | 2023 | 迎合是 RLHF 系统行为 | integrity 的工程威胁模型 |

### 2.3 规范类

- Butlin et al. 2023（arXiv:2308.08708 ✅）与 Long et al. 2024（arXiv:2411.00986 ✅）：见 §1.6——前者给「可评估的 indicator」方法论，后者把 agent selfhood 纳入道德地位议程。
- Sesame "presence"：见 §3——官方 journal 为一手来源，未见对应 arXiv 论文（本会话检索未发现）。

### 2.4 心理学类

- McAdams & McLean 2013（§1.1 ✅）；Gallagher 2000、Seth & Tsakiris 2018（§1.2 ✅）。

---

## 3. Q3 工程项目清单：机制与 TDB 灵魂实现的异同

| 项目 | 链接 | 机制 | 与 TDB 灵魂注入异同 |
|---|---|---|---|
| Generative Agents (Smallville) | https://github.com/joonspk-research/generative_agents 🔗（10-13 调研直抓） | 25-agent 小镇；memory stream + 三因子检索（recency×importance×relevance，公式细节 🔗）+ reflection + plan | 同：把经历写进身份。异：有反思回路（TDB 无）；身份从经历自动合成而非录入 |
| Letta (MemGPT 产品化) | https://github.com/letta-ai/letta · https://docs.letta.com/v1-sdk/memory/memory-blocks/ 🔗（10-13 调研直抓：块=`label+description+value+limit`，钉进 system prompt，agent 用 memory tools 自编辑，sleep-time 后台重写） | 常驻身份块+自我编辑 | 同：结构化常驻身份块 = TDB 价值锚同形态。异：agent 可自改块（TDB 锚只读）；块有自动生成描述 |
| Mem0 | https://github.com/mem0ai/mem0 · https://arxiv.org/abs/2504.19413 🔗（10-13 调研直抓） | 抽取事实→与既有记忆比对→ADD/UPDATE/DELETE；检索多信号融合 | 无独立人格层；TDB 的 soul-identity 更完整 |
| Graphiti (Zep) | https://github.com/getzep/graphiti · https://arxiv.org/abs/2501.13956 🔗（10-13 调研直抓） | bi-temporal 知识图谱：contradicts → 旧边 `invalid_at`（**不删除、保留审计**） | 与 TDB 红线「禁删记忆」同构哲学：失效不删；TDB 自我状态无时间线 |
| AI Town | https://github.com/a16z-infra/ai-town 🔗（本会话 platform_search 未命中，未直验） | Generative Agents 的开源社交小镇复刻/模板 | 机制同上游 |
| A-MEM | https://arxiv.org/abs/2502.12110 ✅（NeurIPS 2025）· repo https://github.com/WujiangXu/A-mem ✅ | Zettelkasten 卡片：新记忆生成含描述/关键词/标签的 note + 自动链接 + **memory evolution（新记忆可更新旧记忆的上下文表征）** | memory evolution = 「身份可演化」的实现先例；TDB 锚静态 |
| MemOS | https://arxiv.org/abs/2507.03724 ✅ · repo https://github.com/MemTensor/MemOS 🔗（未直验） | 记忆当系统资源调度：MemCube=内容+元数据（**provenance/versioning**），明文/激活/参数三态记忆可迁移融合 | 版本化正是 TDB 自我状态缺的东西 |
| MIRIX | https://arxiv.org/abs/2507.07957 ✅ | 六类记忆 Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault + 多 agent 控制更新与检索；LOCOMO 85.4%、ScreenshotVQA 较 RAG +35% | 记忆类型学对照：TDB 缺 procedural（能力自我）与资源层 |
| Second Me | https://arxiv.org/abs/2503.08102 ✅ · repo https://github.com/Mindverse/Second-Me ✅ | AI-native memory 2.0：个人记忆参数化（训练进模型）成「另一个我」 | 重训练路线，与 TDB 注入路线互斥但可对照 |
| Replika | https://replika.com ✅（仅产品页） | 机制不公开 | **未找到一手机制公开资料**；仅能确认产品定位（AI companion），不作机制引用 |
| Character.AI | 用户侧 https://book.character.ai/character-guide/user-personas ✅ · 角色定义 https://support.character.ai/hc/en-us/articles/50609183646875-5-Character-Definition ✅ | persona=角色定义资产（description/greeting/示例对话）+用户侧 user persona | 身份=纯 prompt 资产，无公开的独立记忆系统；TDB 注入更结构化 |
| Anthropic "Claude's Character" | https://www.anthropic.com/news/claude-character（2024-06-08 ✅ 标题/日期；正文未直抓 🔗，/research/claude-character 为别名；经 HN 转引：Claude 3 起把 **character training** 加入 alignment finetuning） | 价值/品格训练进权重而非仅 system prompt | 与 TDB 互补：Anthropic 训练时定形，TDB 推理时注入；支持「红线需要执行位而非散文」的判断 |
| Hume AI | Expression APIs https://www.hume.ai/products/expression-apis ✅（语音/人脸/文本测情绪，每分数 0-1 概率）· EVI https://www.hume.ai/empathic-voice-interface ✅ · OCTAVE https://www.hume.ai/blog/introducing-octave ✅（2024-12） | 情绪表达的连续量化+实时共情语音接口 | 情绪测量工程化标杆；TDB 正则关键词→定值表是同类最粗形态 |
| Sesame (CSM) | https://www.sesame.com/journal/crossing-the-uncanny-valley-of-voice ✅（2025-02-27；本会话直抓全文；未见 arXiv 版，官方 journal 为一手） | 提出 **voice presence** 四要素：emotional intelligence / conversational dynamics / contextual awareness / **consistent personality**（"maintaining a coherent, reliable and appropriate presence"）；CSM=单阶段多模态 transformer（Mimi split-RVQ + Llama backbone + 小 decoder，1/16 compute amortization，~100 万小时语音，Apache 2.0 开源 https://github.com/SesameAILabs/csm）；CMOS 评测显示含 90s 上下文时人仍偏好真人录音——差距仍在 | presence = 灵魂的表层出口；TDB soul-feeling 只注入不表达，且无人做「一致性→表层」映射 |

---

## 4. 综合讨论：工程界对「灵魂」的实际做法

1. **身份几乎都是「散文+结构化块」**：Letta blocks、Character.AI 定义、TDB soul-identity 三者同构；最先进的加两件事——agent 可自编辑（Letta memory tools）与从经历自动合成/演化（Generative Agents reflection、A-MEM memory evolution）。
2. **没有一家把红线做成推理时执行位**：价值/约束要么是 prompt 散文（Character.AI、Letta 块），要么是训练目标（Anthropic character training）。「LLM 提议、确定性门裁决」式的推理时执行位在本次调研范围内未见先例——TDB 若做即是差异化，也与其自身治理哲学同构。
3. **情绪/状态组件精细度排序**：Hume（外部测量，0-1 连续概率）> Sesame（声音表层表达）> 多数记忆系统（无独立组件）≈ TDB soul-feeling（**有组件但机制最糙**：正则关键词→定值表三档）。「有组件、机制糙」恰是最划算的改进位。
4. **一致性评测已成独立领域**（RoleBench / InCharacter / CharacterEval / persona drift / OOC 系列），且 arXiv:2412.00804 ✅ 的三发现（persona 注入可能无效、大模型更漂、家族差异弱于参数）说明：**注入逻辑必须配评测门**，否则无法区分「注入有效」与「自我安慰」。
5. **哲学到工程的最短路径**是 Dennett 式功能主义：self=有解释功能的结构。这允许 TDB 把「灵魂」完全当作可版本化、可评测、可演化的数据+机制问题来处理，不必陷入意识争论（Butlin 框架反而提示：先做可评估的自我模型，意识指标另议）。

---

## 5. TDB 缺口→可落地方向

### 5.1 组件 × 理论 × 论文 × 项目 × TDB 现状 × 缺口 映射表

| 灵魂组件 | 代表理论 | 代表论文 | 代表项目 | TDB 现状 | 缺口 |
|---|---|---|---|---|---|
| 叙事自我 | McAdams & McLean 2013 ✅；Dennett 1992 ✅ | arXiv:2304.03442 ✅；arXiv:2310.10158 ✅ | joonspk-research/generative_agents 🔗 | 身份散文+价值锚（录入态） | 无反思回路，身份不自传 |
| 最小自我/当下状态 | Gallagher 2000 ✅；Seth & Tsakiris 2018 ✅ | arXiv:2207.05608 ✅ | Hume ✅；Sesame ✅ | soul-feeling 三档定值 | 无时间维、无连续量化 |
| Agency | Frankfurt 1971 ✅；SEP ✅ | arXiv:2303.11366 ✅ | letta-ai/letta（自编辑块）🔗 | 锚只读、agent 无表态权 | 无自我修订/表态通道 |
| Integrity | SEP integrity ✅ | arXiv:2310.13548 ✅ | Anthropic character 🔗 | strict_rule 纯散文 | 无执行位、无对抗迎合评测 |
| 关系性自我 | SEP feminism-self/-autonomy ✅ | arXiv:2310.10158 ✅ | Replika（无一手） | 用户画像+重要的人 | 基本齐备（维持即可） |
| 能力自我 | —（CoALA 词汇） | arXiv:2305.16291 ✅；arXiv:2309.02427 ✅ | Voyager ✅；MIRIX ✅ | 无 procedural 层 | 能力断言可能与实际不符 |
| Presence | —（工程概念） | — | Sesame ✅ | 无 | 暂缓（表层映射，大改动） |

### 5.2 改进方向（7 条，只给方向与依据，不写实现）

| # | 方向 | 涉及组件 | 主要依据 | 量级 |
|---|---|---|---|---|
| 1 | **反思回路**：定期把近 N 条 L1 经历蒸馏成带证据引用的「自我洞察」（我上次错在哪 / 用户偏好如何变化），写回身份层或独立 soul-insight 块 | 叙事自我 | arXiv:2304.03442 ✅（reflection 是可信度消融的关键组件）；arXiv:2303.11366 ✅（言语反思存 episodic buffer 供后续复用） | 中 |
| 2 | **红线执行位**：strict_rule 从散文升级为结构化规则对象（规则 id / 触发面 / 检查器），注入时渲染散文+机器可查位，召回/动作后置确定性校验——「LLM 提议、确定性门裁决」在灵魂层的同构落地 | Integrity | arXiv:2308.08708 ✅（把性质写成可评估 indicator 的方法论）；Anthropic character training 🔗（价值进行为不进散文）；与 TDB 自身治理哲学同构 | 小-中 |
| 3 | **mood 状态机**：正则→定值表改为 valence/arousal 连续值 + 时间衰减 + 事件驱动更新，三档降级为渲染层分箱 | 最小自我 | Seth & Tsakiris 2018 ✅（状态由调节过程生成，非查表）；Hume Expression APIs ✅（连续 0-1 概率测量的工程先例） | 中 |
| 4 | **锚的情境化检索**：按当前任务上下文对价值锚打分选注入子集（recency×importance×relevance 三因子迁移到锚选择），替代全量注入 | 叙事自我/Agency | arXiv:2304.03442 🔗（三因子检索公式） | 中 |
| 5 | **自我状态历史化**：soul-feeling 每次演化落一条时间戳快照（valid_at/记录时双时间线），支持「我这周状态轨迹」查询；旧状态失效不删除 | 最小自我 | Graphiti bi-temporal（arXiv:2501.13956 🔗）；A-MEM memory evolution（arXiv:2502.12110 ✅） | 中-大 |
| 6 | **人格一致性回归门**：构建对抗式身份探针集（Character-LLM 访谈范式 + persona drift 指标）作为注入逻辑改动的 TDD 基线——先量化「灵魂注入是否真的有效」 | Integrity/评测 | arXiv:2310.10158 ✅（对抗式访谈）；arXiv:2402.10962 ✅；arXiv:2506.19352 ✅；arXiv:2412.00804 ✅（persona 注入可能无效→必须量化） | 小 |
| 7 | **能力自我块**：把「我能做什么/常怎么做」（工具面、工作流偏好、领域专长）作独立身份块注入，防能力断言失真 | 能力自我 | arXiv:2305.16291 ✅（skill library=能力自我）；arXiv:2309.02427 ✅；arXiv:2507.07957 ✅（Procedural Memory 记忆类） | 小-中 |

（暂缓：presence 表层映射——把 soul-feeling 映射到语气/节奏/停顿等输出表层；依据 Sesame journal ✅ 与 arXiv:2207.05608 ✅；量级大、依赖第 3 条先行。）

**对 TDB 最有价值的三条**：#1 反思回路（补最大短板，直接产出「我上次错在哪」）；#2 红线执行位（哲学自洽 + 全行业空白 + 差异化）；#6 一致性回归门（最便宜、最先做，并为 #1/#2 提供验收门——符合 TDB 的 TDD 纪律）。

---

## 附：来源清单（按节汇总）

**哲学/心理学（Q1）**
- McAdams & McLean, "Narrative Identity", CDPS 22(3), 2013: https://journals.sagepub.com/doi/10.1177/0963721413475622
- Dennett, "The Self as a Center of Narrative Gravity", 1992: https://cogsci.ucd.ie/oldfiles/introtocogsci/docs/selfctr.htm · DOI 10.4324/9781315807652-11
- SEP Personal Identity: https://plato.stanford.edu/entries/identity-personal/
- Gallagher, "Philosophical conceptions of the self", TiCS 2000: DOI 10.1016/S1364-6613(99)01417-5 · https://pubmed.ncbi.nlm.nih.gov/10637618/
- SEP Phenomenological Approaches to Self-Consciousness: https://plato.stanford.edu/entries/self-consciousness-phenomenological/
- Seth & Tsakiris, "Being a Beast Machine", TiCS 2018: DOI 10.1016/j.tics.2018.08.008 · https://www.cell.com/trends/cognitive-sciences/fulltext/S1364-6613(18)30207-9
- Frankfurt, "Freedom of the Will and the Concept of a Person", JPhil 1971: DOI 10.2307/2024717 · https://www.jstor.org/stable/2024717
- SEP Personal Autonomy: https://plato.stanford.edu/entries/personal-autonomy/
- SEP Integrity: https://plato.stanford.edu/entries/integrity/
- SEP Feminist Perspectives on the Self: https://plato.stanford.edu/entries/feminism-self · SEP Feminist Perspectives on Autonomy: https://plato.stanford.edu/entries/feminism-autonomy
- Butlin et al. 2023: https://arxiv.org/abs/2308.08708 · Long et al. 2024: https://arxiv.org/abs/2411.00986 · https://eleosai.org/papers/20241104_Taking_AI_Welfare_Seriously.pdf

**论文（Q2）**
- Generative Agents: https://arxiv.org/abs/2304.03442 · repo: https://github.com/joonspk-research/generative_agents
- Character-LLM: https://arxiv.org/abs/2310.10158 · repo: https://github.com/choosewhatulike/trainable-agents
- RoleLLM/RoleBench: https://arxiv.org/abs/2310.00746 · https://huggingface.co/datasets/ZenMoore/RoleBench · https://aclanthology.org/2024.findings-acl.878/
- InCharacter: https://arxiv.org/abs/2310.17976 · CharacterEval: https://arxiv.org/abs/2401.01275 · https://github.com/morecry/CharacterEval
- Persona drift: https://arxiv.org/html/2402.10962v1 · https://arxiv.org/abs/2412.00804 · https://arxiv.org/abs/2506.19352 · https://arxiv.org/abs/2511.00222 · https://arxiv.org/html/2601.10387
- Sycophancy: https://arxiv.org/abs/2310.13548
- MemGPT: https://arxiv.org/abs/2310.08560 · Reflexion: https://arxiv.org/abs/2303.11366 · Voyager: https://arxiv.org/abs/2305.16291 · https://voyager.minedojo.org/ · Inner Monologue: https://arxiv.org/abs/2207.05608 · https://innermonologue.github.io · CoALA: https://arxiv.org/abs/2309.02427 · Park et al. self-reports: https://arxiv.org/abs/2411.10109

**项目（Q3）**
- Letta: https://github.com/letta-ai/letta · https://docs.letta.com/v1-sdk/memory/memory-blocks/ · Mem0: https://github.com/mem0ai/mem0 · https://arxiv.org/abs/2504.19413 · Graphiti: https://github.com/getzep/graphiti · https://arxiv.org/abs/2501.13956
- AI Town: https://github.com/a16z-infra/ai-town · A-MEM: https://arxiv.org/abs/2502.12110 · https://github.com/WujiangXu/A-mem · MemOS: https://arxiv.org/abs/2507.03724 · https://github.com/MemTensor/MemOS · MIRIX: https://arxiv.org/abs/2507.07957 · Second Me: https://arxiv.org/abs/2503.08102 · https://github.com/Mindverse/Second-Me
- Replika: https://replika.com · Character.AI: https://book.character.ai/character-guide/user-personas · https://support.character.ai/hc/en-us/articles/50609183646875-5-Character-Definition
- Anthropic "Claude's Character": https://www.anthropic.com/news/claude-character · Hume AI: https://www.hume.ai/products/expression-apis · https://www.hume.ai/empathic-voice-interface · https://www.hume.ai/blog/introducing-octave
- Sesame: https://www.sesame.com/journal/crossing-the-uncanny-valley-of-voice · https://github.com/SesameAILabs/csm

**勘误存档**
- arXiv:2411.15676 ≠ "Taking AI Welfare Seriously"（实为离子阱物理论文，arXiv API 直查证伪，2026-10-16）；正确编号 arXiv:2411.00986。
