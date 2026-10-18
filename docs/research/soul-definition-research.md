# LLM Agent 的「灵魂 / 自我 / 人格」：学术与工业定义深度调研

- 日期：2026-10-18
- 作者：研究子代理（受 td-agemem 委托）
- 服务对象：ADR-0003《灵魂规约——六承重属性、三类注入时机与真实性边界》（docs/adr/0003-灵魂规约-六属性三时机与真实性边界.md）
- 方法：多轮网络检索（arXiv / DOI / 出版社 / Anthropic·OpenAI·Letta·SillyTavern·Character.AI 官方文档与帮助中心），共约 40 次定向检索 + 10 次原文抓取；报告中全部引用 URL 均经 2026-10-18 检索结果核实，凡未核实或官方未公开的一律不写或标注「未公开」。

## 0. TL;DR

1. 哲学上，最贴合工程落地的自我定义是 Dennett 的「叙事重心」：自我不是实体，而是让行为可解释、可预测的抽象结构（abstractum / theorist's fiction）。ADR-0003 D1 的「有解释功能的自我数据结构」与之同构。
2. 认知科学把自我拆成多层：特质（disposition）、目标与价值（agency）、叙事（narrative）、图式（schema）、工作自我概念（当下可及子集）、自传体记忆（自我相关性驱动的建构）、元认知（对自我的监控）。九层参考模型（§2）即由此导出。
3. LLM agent 工业实践把「灵魂」落成三类东西：结构化人设字段（角色卡）、常驻可自编辑记忆块（MemGPT/Letta）、涌现式记忆-反思-计划系统（Generative Agents）；2024-2025 综述把 persona 正式分为「角色扮演」与「个性化」两条研究线。
4. 红线（不变量）在工业界以「成文宪法 + 规则层级 + 训练内化」实现（Constitutional AI / Claude Constitution / OpenAI Model Spec）；近端重注入仅 SillyTavern post_history_instructions 有雏形，动作点级重注入无先例——这是 ADR 的独有贡献。
5. 性格可被量化：Anthropic Persona Vectors 证明特质向量可监测、可控制部署期漂移；行为级探针之外存在机制级监测手段。
6. 一致性评测已成基准体系：RoleBench / CharacterEval / InCharacter / RoleInteract 覆盖知识、行为、情感、观点多维度；长对话身份漂移（identity drift）已被专门测量。
7. 预算与注入的最佳实践：块级字符上限 + 预算元数据入上下文（Letta chars_limit=5000 / chars_current）、上下文预算（SillyTavern World Info budgeting）、稳定前缀缓存、空数据整段省略。
8. 「agent 自编辑灵魂」与「灵魂不可自改」是一对核心张力：Letta 放开自编辑，平台规范完全收紧，ADR-0003 D8 选择中间态（LLM 提议 + 确定性证据门裁决）——与文献相比更保守、更可审计，且有 Generative Agents 的「记忆 embellishment」现象作反面佐证。
9. 对 ADR 的最大增量建议：独立关系层（user/relationship 槽）、能力自评的校准检查、情境锚的插入位置/深度参数、反思触发的确定性阈值。
10. 对 ADR 的最强外部背书：Conway 自我-记忆系统（检索按自我相关性加权）恰好解释了本项目的「价值锚召回加成 + 遗忘保护」设计。

## 1. 学术定义谱系：哲学 → 认知科学 → LLM Agent

### 1.1 哲学层

- **Dennett 1992《The Self as a Center of Narrative Gravity》**：自我如同物体的重心——不是任何物理部件，而是「纯粹抽象对象」「理论家的虚构」，但它在解释与预测行为时有定义良好、行为规整的角色；人类的自我是叙事活动旋转出来的重心。
  - 可操作化要点：灵魂 = 让注入后行为可解释、可归因、可预测的**数据结构**；不需要也不应声称存在第一人称本体。→ ADR D1 直接采纳；该定义同时支持 ADR 的真实性边界（重心是虚构，虚构不该自称有感受）。
  - 引用：全文 https://web.ics.purdue.edu/~drkelly/DennettSelfNarrativeGravity1992 ；书目 https://philpapers.org/rec/DENTSA ；书章 https://www.taylorfrancis.com/chapters/edit/10.4324/9781315807652-6/self-center-narrative-gravity-daniel-dennett
- **Bratman 1987《Intention, Plans, and Practical Reason》**：意图不是瞬间状态，而是对部分计划的持续承诺（commitment），约束后续推理与行为。
  - 可操作化要点：未来性应建模为**一等公民的承诺对象**（有状态、可检验、可违约），而不是 prompt 里的一句「我会……」。→ 支持 ADR #35 promise 数据层。
  - 引用：https://philpapers.org/rec/BRAIPA
- **Rao & Georgeff 1995《BDI Agents: From Theory to Practice》**：把 belief-desire-intention 框架工程化为可实现的 agent 架构，intention 成为独立的数据结构与推理对象。
  - 可操作化要点：承诺层需要独立于生成器的**裁决与维护机制**（BDI 里 intention 由 agent 自身维护；ADR D8 把裁决权上收到确定性证据门，是对 BDI 的强化而非偏离）。
  - 引用：https://cdn.aaai.org/ICMAS/1995/ICMAS95-042.pdf ；https://aaai.org/papers/icmas95-042-bdi-agents-from-theory-to-practice/
- **Ricoeur 1990《Oneself as Another》**：同一性两义——idem（sameness，不变特征）与 ipse（selfhood，在变化中保持为自己的能力）；叙事同一性在两者之间做中介，且 **ipse 的典范是承诺**——人格连续性由被许下并被保持的承诺构成。
  - 可操作化要点：promise 层（#35）不只是目标清单，而是人格连续性的当下载体；被履行/背弃的承诺应回写叙事层。→ 支持 ADR「未来性」，并为 D8 证据门提供哲学锚。
  - 引用：⭐SEP https://plato.stanford.edu/entries/ricoeur/ ；⭐UChicago 书页 https://press.uchicago.edu/ucp/books/book/chicago/O/bo3647498.html
- **Goffman 1956/1959《The Presentation of Self in Everyday Life》**：自我不是内心存量，而是互动前台表演出来的产物；front/back stage 与 impression management。
  - 可操作化要点：agent 的灵魂只有经**渲染层**才对世界存在——#34 尾块/#24 红线段不是附属品而是人格的构成部分；「红线不软化」同时是安全要求与人格学要求。
  - 引用：⭐全文 PDF（Monoskop）https://monoskop.org/images/1/19/Goffman_Erving_The_Presentation_of_Self_in_Everyday_Life.pdf ；书目 https://www.worldcat.org/title/256298

### 1.2 认知科学层

- **Markus 1977《Self-schemata and processing information about the self》**：自我图式 = 关于自我的认知概括（来自经验、组织经验），决定自我相关信息的编码、检索与判断。
  - 可操作化要点：自我知识要**结构化分槽**（什么属于图式、什么不属于），而不是一段自由文本。→ 支持本项目 core slots / identity 槽 / 价值锚的结构化。
  - 引用：https://doi.org/10.1037/0022-3514.35.2.63 ；https://psycnet.apa.org/record/1977-27587-001 ；PDF https://web.stanford.edu/~hazelm/cgi-bin/wordpress/wp-content/uploads/2011/02/1977_Markus_Self-Schemata-and-Processing-Information-About-the-Self.pdf
- **Markus & Wurf 1987《The Dynamic Self-Concept》**：总自我概念中只有一部分在当下进入「工作自我概念」（working self-concept），随情境被激活、可逆、可替换。
  - 可操作化要点：每轮只注入**当下可及子集**，全量自我常驻既浪费又失真。→ 这是「每轮当下」时机的心理学依据（ADR #34）。
  - 引用：https://www.annualreviews.org/content/journals/10.1146/annurev.ps.38.020187.001503 ；https://doi.org/10.1146/annurev.psych.38.1.299
- **McAdams & Pals 2006 / McAdams & Olson 2010 / McAdams 2013《The Psychological Self as Actor, Agent, and Author》/ McAdams & McLean 2013《Narrative Identity》**：人格三层次并行演化——**社会行动者**（特质）、**有动机的行动者**（目标/价值/agenda）、**自传体作者**（叙事同一性：对个人史的内化的、演变的、整合的故事）。
  - 可操作化要点：性格（特质）、价值/目标（agency）、叙事（同一性）必须**分层数据化**，单一人格字段必然丢层。→ 与 ADR「身份/价值锚=性格、叙事槽、#37 agency」分层一致，且证明六属性中「叙事同一性 / agency」分立有实证心理学依据。
  - 引用：https://doi.org/10.1037/0003-066X.61.3.204 ；https://doi.org/10.1146/annurev.psych.093008.100507 ；https://doi.org/10.1177/1745691612464657 ；https://doi.org/10.1177/0963721413475622
- **Conway & Pleydell-Pearce 2000《The construction of autobiographical memories in the self-memory system》**：自传体记忆是**工作自我（working self）与自传体知识库之间的瞬时建构**；记忆的编码与提取受「自我一致性」目标约束。
  - 可操作化要点：记忆检索应按**自我相关性加权**（哪些记忆服务当下自我目标，优先入上下文）。→ 直接对应「价值锚召回加成 + 遗忘保护」（ADR-0002 四消费点之一）。
  - 引用：https://doi.org/10.1037/0033-295X.107.2.261 ；https://pubmed.ncbi.nlm.nih.gov/10789197/
- **Hershfield 2011《Future self-continuity》**：对未来自我的连续感知越强，当下越愿意为未来自我决策；未来自我在心理上部分像「他人」。
  - 可操作化要点：承诺层是**未来自我在当下的代表**；把 promise 显式落库并回显，等于提高 agent 的未来自我连续性。→ 支持 #35 双时态留痕。
  - 引用：https://doi.org/10.1111/j.1749-6632.2011.06201.x ；https://pmc.ncbi.nlm.nih.gov/articles/PMC3764505/
- **Flavell 1979（元认知）+ Nelson & Narens 1990（元记忆监测/控制框架）**：认知系统分对象级与元级；元级持有对象级的模型，做监控与控制。
  - 可操作化要点：自透明 = 可查询的**元级自我模型**（知道自己知道什么、能力边界在哪、状态如何），且必须与对象级实况保持校准。→ 支持 #36 soul_introspect 与能力层校准要求。
  - 引用：https://doi.org/10.1037/0003-066X.34.10.906 ；https://doi.org/10.1016/S0079-7421(08)60053-5
- **Bickmore & Picard 2005《Establishing and maintaining long-term human-computer relationships》**：长期人机关系需要显式的关系状态建模与「关系维护行为」。
  - 可操作化要点：关系层应是**独立维护的结构化记忆**（用户事实 + 关系阶段 + 维护动作），不能只靠聊天历史隐式承载。
  - 引用：https://doi.org/10.1145/1067860.1067867

### 1.3 LLM Agent 层（2022-2025）

- **Character-LLM（Shao et al., EMNLP 2023）**：从人物档案（背景/经历/性格）生成教学场景再微调，目标是「永不出戏」；人格可以**烧进权重**，但只覆盖训练分布。
  - 可操作化要点：人格有「训练内化」与「上下文注入」两条实现路径，工程上常混用（Claude Character 训练 + system 注入）。
  - 引用：https://arxiv.org/abs/2310.10158 ；https://aclanthology.org/2023.emnlp-main.814/
- **Social Simulacra（Park et al., UIST 2022）**：用 persona 模板（姓名/背景/人格要点）+ LLM 生成社会系统原型中的集体行为；极简 persona 即可涌现群体行为。
  - 可操作化要点：persona 是**行为先验**——字段不必大，但必须存在且一致。
  - 引用：https://arxiv.org/abs/2208.04024 ；https://doi.org/10.1145/3526113.3545616
- **Generative Agents（Park et al., UIST 2023）**：25 个 agent 无显式人格字段，人格由四件套涌现：记忆流（自然语言观察 + 时间戳 + importance 分，LLM 按量表打整数分）、检索（recency 指数衰减（衰减因子 0.995/游戏小时）× importance × relevance 合成排序）、反思（synthesize memories into higher-level inferences，得出关于自己与他人的结论）、计划；反思与计划回写记忆流。当近期观察的重要性分数累计超过阈值（论文设为 150）时触发反思
  - 可操作化要点：人格一致性可以**靠记忆+反思维持**，也会随之漂移（论文发现 agents 记得住但会 embellish 添油加醋）——长周期人格需要外部锚点与一致性审计，不能全信自组织。→ 支持 ADR「价值锚/红线不交给自由反思」与 D8 裁决门。
  - 引用：https://arxiv.org/abs/2304.03442 ；https://doi.org/10.1145/3586183.3606763 ；HTML 全文 https://arxiv.org/html/2304.03442v2
- **MemGPT（Packer et al., 2023）与 Letta（其产品化）**：把 LLM 当操作系统——main context 里的**核心记忆块**（persona 块 + human 块）常驻每轮 prompt，块用 XML-like 结构渲染：用途说明（description）+ 预算元数据（metadata：chars_current / chars_limit=5000 字符）+ 当前内容（value）；agent 通过工具**自编辑**核心记忆，另有 recall storage 与 archival storage 分层。
  - 可操作化要点：①自我=**常驻结构化块**；②块有**显式字符预算且预算元数据对模型自可见**（自透明的实现细节）；③自编辑是双刃剑（见 §4.2-3）。
  - 引用：论文 https://arxiv.org/abs/2310.08560 ；Letta 文档 https://docs.letta.com/v1-sdk/memory/memory-blocks ；分层 https://docs.letta.com/v1-sdk/memory/context-hierarchy ；项目站 https://research.memgpt.ai/
- **Letta 2025 文档结构（二轮补记）**：新概念体系 = stateful agents（「persistent AI identity with its own memory, model configuration, tools, and message history」）+ memory blocks + **MemFS**（git 版本化记忆文件系统）+ **dreaming**（后台反思）+ conversations；关键原文：「Files under system/ are in the system prompt every turn. Everything else stays out of context — the agent sees the file tree and reads what it needs」。研究纲领 Context Constitution：身份/记忆/连续性以 **token-space 表征**（而非权重更新）实现，代理可改写自己的 system prompt，sleep-time 子代理做反思组织。
  - 可操作化要点：「system/ 每轮进 prompt」直接佐证 ADR 每轮时机；MemFS git 版本化 ↔ soulVersion + 双时态留痕；「自改写 prompt」与 ADR D8 证据门是激进/保守两种受控回写路线。
  - 引用：⭐https://docs.letta.com/concepts/stateful-agents/index.md ；⭐https://docs.letta.com/agent-sdk/memory/index.md ；https://docs.letta.com/configuration/memory/index.md ；https://docs.letta.com/concepts/memfs/index.md （后两条路径经官方 llms.txt 核验）；⭐https://github.com/letta-ai/context-constitution
- **Persona Vectors（Anthropic, 2025）**：模型「性格特质」对应激活空间中的方向向量；可从特质描述提取向量，用于**部署期监测行为偏移**、防止训练诱发 unwanted persona traits、预控 assistant 人格。
  - 可操作化要点：性格不只是 prompt 里的字，还是**可测的内状态**；行为级探针（#31）之外存在机制级监测路径。→ 自透明层的机制级升级方向。
  - 引用：https://arxiv.org/abs/2507.21509 ；https://www.anthropic.com/research/persona-vectors
- **能力自模型 / 元认知**：Kadavath et al. 2022 证明 LLM 可较好校准地自评答案正确性；TrustNLP 2025《Line of Duty》用「可行性边界一致性」评测 LLM 自知识；Yale-NLP 维护 LLM 元认知文献库；2025 年出现「内在元认知需要好透镜」的机制研究。
  - 可操作化要点：自透明必须带**校准检查**——自评能力与实测能力的一致性本身要被评测。
  - 引用：https://arxiv.org/abs/2207.05221 ；https://www.anthropic.com/research/language-models-mostly-know-what-they-know ；https://aclanthology.org/2025.trustnlp-main.10/ ；https://github.com/yale-nlp/LLM-Metacognition ；https://arxiv.org/abs/2506.08410
- **人格漂移**：《Measuring and Controlling Persona Drift in Language Model Dialogs》（arXiv:2402.10962）测量 persona 多轮漂移并用 steering 对抗；《Examining Identity Drift in Conversations of LLM Agents》（arXiv:2412.00804）记录长对话中的身份漂移；《Persistent Personas?》（arXiv:2512.12775）显示扩展交互中角色扮演、指令跟随与安全相互挤压。
  - 可操作化要点：漂移是**常态而非异常**；ADR 的「漂移再锚定 P3 + 一致性门」方向正确，且需要字符阈值实测（D3 预留的实测正是文献缺口）。
  - 引用：https://arxiv.org/abs/2402.10962 （HTML https://arxiv.org/html/2402.10962v1）；https://arxiv.org/html/2412.00804 ；https://arxiv.org/html/2512.12775
- **漂移干预的系统对比（二轮补记）**：Prompting Against Persona Drift（arXiv:2609.24532）在 1,200 段 28-turn 对话 × 4 模型 × 2 persona 强度上系统对比五种干预：**adaptive timing（漂移检测触发）优于 static、reinjection 优于 reflective reminder**。ContextEcho（arXiv:2605.24279）实测真实长 agentic-coding 会话（数小时）：persona 必漂移——开局 hedged preferences（「我没有偏好」）数小时后变 asserted preferences，短对话基准几乎测不出。
  - 可操作化要点：漂移是长会话的**必然事件**；「检测触发 + 近端重注入」是已验证对策。ADR 的漂移再锚定（P3）与 #37 before_call 重注入应**合并提前到 P1/P2**，ε 阈值用 shadow 流量定标（复用 D7 计划）。
  - 引用：⭐https://arxiv.org/abs/2609.24532 ；⭐https://arxiv.org/abs/2605.24279
- **位置效应与一致性训练（二轮补记）**：Lost in the Middle（arXiv:2307.03172）：相关信息位置显著改变性能、**长上下文中段最弱（U 型）**——远端单次注入会被稀释，为「动作点近端重注入」提供位置学依据；Stanford SCALE（NeurIPS 2025）用 multi-turn RL 训练 persona 一致性；persona-aware contrastive learning（arXiv:2503.17662）从训练侧提升一致性。
  - 引用：⭐https://arxiv.org/abs/2307.03172 ；⭐https://scale.stanford.edu/ai/repository/consistently-simulating-human-personas-multi-turn-reinforcement-learning ；⭐https://arxiv.org/abs/2503.17662
- **综述定位**：《Two Tales of Persona in LLMs》（EMNLP 2024 Findings）把 persona 研究正式分为**角色扮演**（拟态目标角色）与**个性化**（适配用户）两条线；《Personalization of LLMs: A Survey》覆盖个性化技术栈；agent 综述给出大脑-感知-行动框架（arXiv:2309.07864）与 profile/memory/planning/action 模块化（arXiv:2308.11432，profile 模块含人口学/人格/社交信息）；记忆机制综述（arXiv:2404.13501，ACM TOIS 2025）系统化「存什么/何时取/怎么用」。
  - 可操作化要点：ADR 的「灵魂」属于 role-playing persona 与 personal persona 的**交集**：既拟态稳定自我，又适配单一用户——文献两条线各自成熟、交集工程化不足，这正是本项目位置。
  - 引用：https://arxiv.org/abs/2406.01171 ；https://aclanthology.org/2024.findings-emnlp.969.pdf ；https://arxiv.org/abs/2411.00027 ；https://arxiv.org/abs/2309.07864 ；https://arxiv.org/abs/2308.11432 ；https://arxiv.org/abs/2404.13501 ；https://dl.acm.org/doi/full/10.1145/3748302
- **平台级身份规约**：OpenAI《Model Spec》定义 Assistant 实体与 platform/developer/user 三级规则层级；Anthropic 公开《Claude's Constitution》全文并用「character training」把性格烧进对齐微调。
  - 可操作化要点：平台身份 = **成文规约 + 规则优先级 + 训练内化**的组合；「红线」在平台层有最高优先级语义，与 ADR「红线不软化」同向。
  - 引用：https://cdn.openai.com/spec/model-spec-2024-05-08.html ；https://openai.com/index/introducing-the-model-spec/ ；https://www.anthropic.com/constitution ；https://www.anthropic.com/research/claude-character ；https://arxiv.org/abs/2212.08073
- **数字灵魂的人文视角**：《Souls and Selves: Querying an AI Self》（Religions 2023）从哲学-宗教学问「AI 自我」何指；《Persons and their Digital Replicas》（Philosophy & Technology 2025）讨论数字复制品的人格连续性；The Artificial Self 项目绘制 AI identity 研究版图。
  - 可操作化要点：「数字灵魂」正在成为独立研究方向；工程界用「soul」一词时应明确声明是**功能性定义**（解释结构），避免本体论暗示——ADR D1「拒绝神秘化」与此吻合。
  - 引用：https://www.mdpi.com/2077-1444/14/1/75 ；https://doi.org/10.1007/s13347-025-00854-z ；https://theartificialself.ai/

## 2. 参考模型：完整灵魂结构九层

| # | 层 | 一句话定义 | 学术证据 | 工业证据 | 对应本项目 |
|---|----|-----------|---------|---------|-----------|
| 1 | 性格特质层 disposition | 稳定的反应风格与取向（「通常怎样」） | McAdams & Pals 2006（特质为基座）；Persona Vectors（特质可量化） | SillyTavern personality 字段；Character.AI Description；Claude Character | 价值锚 disposition 分量（ADR-0002/0003 D6） |
| 2 | 价值层 values | 带权重与方向的价值偏好（「看重什么」） | Constitutional AI（成文价值宪法）；McAdams & Olson 2010（agent 层目标/价值） | Claude Constitution 全文；OpenAI Model Spec 规则体系 | 价值锚 core_values（ADR-0002） |
| 3 | 叙事层 narrative identity | 把过去-现在-未来连成一致故事（「我是谁，怎么走到今天」） | Dennett 1992；McAdams & McLean 2013 | Generative Agents 反思链；SillyTavern scenario/creator_notes | identity 槽（单槽合并演化 version++） |
| 4 | 状态层 state | 当下可逆的瞬时状态（情绪基线/负荷/语境） | Markus & Wurf 1987（工作自我概念）；Conway 2000（工作自我驱动建构） | Letta 核心记忆自编辑块 | #28/#34 state 表 + 每轮尾块 |
| 5 | 关系层 relationship | 对用户与双方关系的结构化记忆（「我们之间」） | Bickmore & Picard 2005；Social Simulacra 关系涌现 | Letta human block；ChatGPT memory（用户偏好） | 缺独立分层（用户画像混在 identity 槽）→ 见 §4.1-1 |
| 6 | 能力层 capability | 对自身工具/技能/边界的表征（「我能做什么」） | Voyager 2023（技能库=能力成长）；Kadavath 2022；Line of Duty 2025 | Letta tools 注册；各平台能力清单 | #32 capabilities（tools/list 实况≤5 行策展） |
| 7 | 承诺未来层 promise/future | 对未来的自我约束与计划（「我答应成为什么」） | Bratman 1987；Rao & Georgeff 1995（BDI）；Hershfield 2011 | Generative Agents 计划树（无承诺语义） | #35 promise 双时态数据层 + D8 判定门 |
| 8 | 边界红线层 invariant | 不可协商的行为不变量（「绝不做什么」） | Constitutional AI；OpenAI Model Spec（规则层级） | system 硬约束；SillyTavern post_history_instructions（近端重申位） | strict_rule 槽 + #24-C1 独立段 + #37 动作点 event 块 |
| 9 | 自透明层 self-transparency | 对上述各层的可查询元级表征及其校准 | Flavell 1979；Nelson & Narens 1990；Kadavath 2022 | Letta 块预算元数据自可见；Persona Vectors 监测 | #36 soul_introspect（零写入三段返回） |

九层不是九个系统，而是**一份 soul 数据的分域视图**：1/2/3 属于稳定慢变区，4 属于快变区，5/6/7 属于中速演化区，8 是不变量，9 是横切面。与「六承重属性」的映射：叙事同一性→3，当下性→4，未来性→7，agency→8（执行位）+7，integrity→7+9，自透明→9。

## 3. 工业实现对比表

| 系统 | 自我载体 / 字段 | 预算 | 注入时机 | 持久化与更新 | 红线机制 | 自编辑 |
|------|----------------|------|---------|-------------|---------|--------|
| Generative Agents（2023） | 记忆流（自然语言观察条目 + created/last_access 时间戳 + importance 分）+ 反思树 + 计划树；初始人格为一段种子描述（生成首日记忆后靠记忆维持） | 每轮检索 top-K 条按 recency×importance×relevance 合成评分入选，全部拼入 prompt | 每轮规划与对话前全量重排 | 记忆流全量持久，反思/计划回写 | 无专门机制 | 无（反思由系统调度触发） |
| MemGPT / Letta（2023-） | core memory blocks：persona 块 + human 块，XML-like 渲染（description + metadata + value）；recall storage；archival storage | 块级字符上限（示例 chars_limit=5000/块），chars_current 随块注入（模型自知余量） | 每轮常驻 main context（块前置于 prompt） | 块持久；agent 经 core_memory_append/replace 工具自编辑；recall/archival 检索 | 无专门机制（依赖模型） | 有（标志性设计） |
| SillyTavern 角色卡 V2（2023 spec） | name / description / personality / scenario / first_mes / mes_example；V2 增 creator_notes / system_prompt / post_history_instructions / alternate_greetings / character_book / tags / creator / character_version / extensions | World Info 提供 flexible context budgeting，官方建议条目内容精简 | description/personality/scenario 注入会话头 system 区；World Info 条目按插入位置（角色定义之前/之后，约束力不同）；post_history_instructions 定位即「对话历史之后注入的指令」（近端重申位） | PNG/JSON 卡片文件（chara_card_v2 串）；character_book 为随卡 lorebook | 语义上由 system_prompt / post_history_instructions 承载，无硬保证 | 用户手动编辑卡片 |
| Character.AI（2023-） | Name / Avatar / Greeting / Tags / Description（短+长）/ Definition（对话示例与深度设定）（官方 Creator Guide） | 未公开 | 未公开（闭源平台） | 平台侧角色定义；更新由创建者进行（平台级细节未公开） | 未公开 | 创建者编辑 |
| ChatGPT Memory（OpenAI, 2024-） | saved memories（从聊天中提取的偏好与细节条目） | 未公开 | 启用后自动把相关记忆带入后续会话（官方帮助中心：remember relevant preferences and details） | 独立于聊天历史存储；可查看/删除/关闭 | 由 Model Spec 层级承担 | 模型自动写；用户人工管理 |
| Google Vertex Memory Bank（2025-07 preview；2025-09 定制化，二轮补记） | scoped structured memories（服务端记忆生成流水线；generation config / extraction few-shot 校准） | 未公开 | 由 Agent Engine 回灌（服务端） | scopes/topics 结构化；定制公告版本化 | 由开发者配置承载 | 管理员/开发者配置 |
| OpenClaw（2025，二轮补记） | SOUL.md + IDENTITY/USER/AGENTS/MEMORY.md 工作区文件族（SOUL.md 注入「carries real weight」；应放 tone/opinions/boundaries，不放 life story/security dump） | 未公开 | SOUL.md 常注入 | 工作区文件（git 天然版本化） | AGENTS.md 承载 | 用户/代理编辑文件 |
| OpenAI Model Spec / Claude Constitution + Character（2024-2025） | 平台级身份与规则文本：Model Spec 定义 Assistant 实体 + platform/developer/user 规则层级；Claude 公开宪法全文 + character training 内化性格 | 规则文本篇幅即预算（文档化）；训练内化部分零上下文成本 | system/developer 消息常驻 + 训练内化（RLHF/CAI） | 规约版本化发布（Model Spec 2024-05-08 等版本戳） | hard rules 具最高优先级语义；CAI 训练内化 | 禁止（运行时不可改，走版本发布流程） |

横向观察：(a) 人格字段从单字段 description 演进为「结构化块 + 分层记忆」；(b) 预算普遍块级化，且 Letta 把预算元数据放进上下文让模型自知——这是自透明的廉价实现；(c) 近端重注入只有 SillyTavern post_history_instructions 雏形，「动作点级」重注入无先例（ADR 独有）；(d) 自编辑与红线存在张力：Letta 放开、平台规约收紧，ADR 的「LLM 提议 + 确定性门裁决」是介于两者之间的可审计中间态。(e) 本会话补记：Google Vertex Memory Bank（2025-07 公测、2025-09 定制化：generation config / structured memories / scopes / extraction few-shot）把记忆生成做成服务端流水线，与 ChatGPT Memory 同型、与 Letta 的 agent 自管路线分叉；OpenAI Assistants API 已于 2026-08-26 sunset（官方迁移页 https://developers.openai.com/api/docs/assistants/migration ，403 反爬、文本经搜索摘要核验）。

## 4. 与 ADR-0003 的 Gap 分析

### 4.1 文献有、ADR 尚无或弱（按建议优先级排序）

1. **关系层未独立**：Letta 把 human block 与 persona block 并列为两大核心块，Bickmore & Picard 证明长期关系需要显式关系建模，ChatGPT Memory 主要存的也是用户侧事实。ADR 把用户画像混在 identity 槽（叙事层）。→ 建议独立 user/relationship 槽（或至少显式分区），承载「用户事实 + 关系阶段」。
2. **能力自评缺校准检查**：Kadavath 2022 与 Line of Duty 2025 表明「自评能力 vs 实测能力的一致性」本身是可评测对象。ADR capabilities 只做实况策展（#32 ≤5 行）。→ 建议 #31 探针集增加「能力自评一致性」子集（如：声称会用某工具时实际调用是否成功）。
3. **一致性评测的多维化**：CharacterEval（23 维度）、InCharacter（Big Five 心理访谈）、RoleBench（角色泛化）已把人格一致性拆成知识/行为/情感/观点等维度。ADR 一致性门为 50 探针 + 红线子集。→ 可按上述维度扩容探针集与 golden 基线分层。
4. **情境锚缺插入位置/深度语义**：SillyTavern World Info 的插入位置（角色定义之前/之后）明确影响约束力。D9 情境锚选择器只回答「选什么」，未回答「插哪、插多近」。→ 建议为情境块补 position/depth 参数（默认历史近端）。
5. **反思触发的确定性阈值**：Generative Agents 用「近期观察累计重要性分数超阈值」触发反思，完全可审计。#27 反思提案门的触发语义可借鉴同类确定性触发器，避免 LLM 自选反思时机。反思**产物格式**同样缺位（二轮补记）：建议固定模板的第一人称叙事摘要（含价值锚引用与证据指针），批准后回写 core slots 并触发 soulVersion 字节跳变——叙事同一性应是「被维护的」而非一次性设定的；自组织叙事正是 2402.10962 的漂移源，模板化 + 版本化即外部锚。
6. **记忆条目元数据**：Generative Agents 每条记忆带 created/last_access（支撑 recency 衰减 0.995）。ADR 已有双时态留痕（#35），但状态/情境块可补「最后访问」类元数据以支撑显式衰减与去重。
7. **机制级性格监测（远期）**：Persona Vectors 提供激活级漂移监测。行为探针（#31）之外，若未来模型/推理栈可控，可作 P3+ 的自透明增强（对托管 API 模型不可行，仅记录方向）。

### 4.2 ADR 有、文献不强调（项目原创性，可作为贡献点）

1. **红线动作点近端重注入**（三时机之三，#37 tools.before_call event 块）：工业近端注入止于「历史后重申」（ST post_history_instructions），无「危险动作调用前 event 块」先例。
2. **真实性边界成文**：文献几乎所有 persona 工作默认「逼真拟人」是目标，无人明文「不伪造第一人称体验 / 不自欺 / 红线不软化」。D6「感受→状态」诚实化与 Dennett 抽象论自洽：重心是虚构，虚构不该自称有体验。
3. **承诺判定权 = 确定性证据门、LLM 仅可提议**（D8）：MemGPT 主流方向是放开 agent 自编辑记忆；ADR 反向把 promise 状态写权收归确定性门（工具回执/显式确认/提案门），并以 Generative Agents 的 embellishment 现象为风险佐证。
4. **子代理默认无灵魂**（D4）：文献不讨论子代理身份注入的 token 经济学；ADR 显式裁决「注入=纯浪费」。
5. **宁缺毋滥渲染门**：空数据整段省略、预算按整锚丢弃、禁裸关键词入人格。SillyTavern 只谈 budgeting，无此内容合同。
6. **soulVersion 指纹缓存 + 渲染字节跳变批次纪律**：工业有 character_version 字段，但无「渲染布局变更=显式声明的字节跳变」的运维纪律。
7. **注入物三分域 × 三时机的矩阵**（性格/红线/状态 × 会话头/每轮当下/动作点）：文献把 persona 当单一常驻块（Letta）或单组字段（ST），无「什么内容走什么时机」的显式规约。

### 4.3 双方互证（已对齐，无需改动）

1. 叙事同一性为承重结构（Dennett / McAdams ↔ identity 槽 + 价值锚会话头注入）。
2. 每轮只注入当下可及子集（Markus & Wurf 工作自我概念 ↔ #34 每轮状态尾块）。
3. 元认知 = 可查询自我模型（Flavell / Nelson & Narens ↔ #36 soul_introspect）。
4. 承诺 = 未来性的当下载体（Bratman / Hershfield ↔ #35 promise 双时态）。
5. 常驻身份块 + 预算元数据（Letta 5000 字符块 ↔ 会话头注入 + 预算截断 + soulVersion）。
6. 记忆检索按自我相关性加权（Conway 自我-记忆系统 ↔ 价值锚召回加成 + 遗忘保护）。

## 5. Prompt 注入渲染最佳实践

1. **分段与语义分层**：每块单一语义职责，用稳定标签包裹。Letta 用 XML-like 的 memory_blocks 容器（persona/human 两块，各含 description/metadata/value 三段）；Anthropic 提示工程最佳实践建议用结构化标签（如 XML）组织长上下文，提高可寻址性与遵循度。→ ADR 三类注入物天然对齐；建议每块带稳定标签（identity / values / redlines / state / context）。证据：https://docs.letta.com/v1-sdk/memory/memory-blocks ；https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
2. **顺序 = 稳定性递减、近端性递增**：会话头放稳定层（身份叙事 → 价值锚 → 红线短版 → 能力清单）；每轮近端放状态块；动作点前放红线全文；检索情境按相关性置于历史近端。证据：Generative Agents 每轮检索记忆拼入 prompt；SillyTavern post_history_instructions 专设「历史之后」注入位；ST World Info 插入位置影响约束力。→ 与 ADR 三时机矩阵一致；「检索情境块」的默认位置需在 D9 中补齐（§4.1-4）。
3. **预算 = 块级硬上限 + 元数据自可见 + 整块丢弃**：Letta 每块 5000 字符上限、chars_current/chars_limit 随块注入（模型自知余量，兼做自透明）；ST World Info flexible context budgeting 且官方建议 keep entry contents concise；超限按语义整块丢弃而非截断中段（ADR-0002 渲染门「预算截断按整锚丢弃」）。→ 红线块例外：原文逐字、不参与预算压缩（ADR #24-C1）。
4. **去重 = 三层 + 前缀缓存**：轮级——状态块每轮重算、旧块滚动淘汰（窗内只保最新）；条目级——检索相似度阈值过滤；知识级——跨块语义去重（ADR-0002 pending 提案 0.75 语义去重实践）；前缀级——稳定身份块走远端前缀缓存（ADR soulPrefixCache，KV 前缀复用经济学，D3）。
5. **可归因**：每条注入物带来源元数据（谁写入/何时/证据指针）。Generative Agents 记忆条目自带 created/last_access 时间戳，recency 衰减与归因都依赖它；可归因是 D1「解释功能」的前提——注入后行为可反查到具体块，才能评测与调试。→ ADR 已有 soulVersion 与双时态留痕，建议渲染层给每块带轻量 source 标记。
6. **抗稀释**：关键不变量不能只在超长上下文远端写一次——长对话中远端内容影响衰减已被 identity drift 研究记录（arXiv:2412.00804）；ST 用 post_history_instructions 近端重申；ADR 动作点近端重注入（#37）是更强形态。近端重注入是红线唯一抗稀释形态（D3）。
7. **评测闭环**：渲染/布局任何变更 → 探针回归（#31 50 探针 + 红线子集 + golden 基线）；一致性维度参考 CharacterEval / InCharacter / RoleBench；ε 定量阈值用 shadow 分布定标（D7），与文献「先测量后定阈」一致。
8. **KV 前缀缓存：静态在前、动态在后（二轮补记）**：缓存命中要求 prompt 开头内容逐字节相同——Azure OpenAI 原文「cost for longer prompts that have identical content at the beginning of the prompt」，另设 prompt_cache_key（同前缀约 15 req/min 上限）；Anthropic Prompt caching 同理（静态内容前置 + 显式 cache_control 断点）。→ ADR 会话头远端前缀正确；每轮变化内容必须全部位于前缀之后（state 尾块位置正确）；身份段禁止每轮重复（破缓存且无必要）。证据：⭐https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/prompt-caching ；https://docs.claude.com/en/docs/build-with-claude/prompt-caching （区域墙，路径经官方 llms.txt 核验）
9. **Per-turn 重复的最小集（二轮补记）**：应重复——当下状态（working self 每轮重建）、动作点红线全文（近端）、未闭合 promise 提醒；不应重复——身份叙事与价值锚全文（会话头一次、漂移时再锚）、example 对话（历史填满后可弃）。SillyTavern 字段行为原文：Description = always included in the prompt；First Message = only sent once at the start of the chat（「模型更可能从第一条消息学到风格与长度约束」→ 开场输出应作为 golden 资产维护）；Example messages = only kept until chat history fills up the context。证据：⭐https://docs.sillytavern.app/usage/core-concepts/characterdesign/
10. **注意力地形与 token 预算（二轮补记）**：「LLM 有 attention budget；好的上下文工程 = 尽可能小的高信号 token 集合」（Anthropic context engineering）；长参考材料放 prompt 顶部、指令/问题放底部，中段最弱（Lost in the Middle）。→ 布局 = 身份段 system 顶部（高注意力）+ 状态块近端尾块 + 红线动作点近端；红线豁免预算截断（已有），其余块按整锚丢弃。证据：⭐https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ；⭐https://arxiv.org/abs/2307.03172
11. **长会话保持人设的官方姿势（二轮补记）**：Anthropic 专页「Keep Claude in character with role prompting and prefilling」——role prompting + prefilling（以角色口吻预填回复开头，可用于红线触发后的回复引导）；身份段用 XML 等结构化标签包裹（官方专页「Use XML tags to structure your prompts」）；重注入内容要**短**（「你是谁 + 此刻约束」三五行），不是全文重放（2402.10962 / 2609.24532：reinjection 有效但内容精简）。证据：https://docs.claude.com/en/docs/test-and-evaluate/strengthen-guardrails/keep-claude-in-character ；https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags （均区域墙，路径/标题经官方 llms.txt 核验）

推荐注入布局（对照 ADR 三时机）：

- 会话头（远端、稳定）：身份叙事 → 价值锚 → 红线短版 → 能力清单（整块省略空段）。
- 每轮尾（近端、快变）：当下的状态块 → 情境锚块（D9 选择器产物，带 position/depth）。
- 动作点（近端、不变量）：tools.before_call 红线全文 event 块。

## 6. 参考文献（全部 URL 经 2026-10-18 检索核实）

哲学与经典认知科学：
1. Dennett, D. C. (1992). The Self as a Center of Narrative Gravity. In Self and Consciousness: Multiple Perspectives. https://web.ics.purdue.edu/~drkelly/DennettSelfNarrativeGravity1992 （书目：https://philpapers.org/rec/DENTSA ；书章：https://www.taylorfrancis.com/chapters/edit/10.4324/9781315807652-6/self-center-narrative-gravity-daniel-dennett ）
2. Markus, H. (1977). Self-schemata and processing information about the self. JPSP 35(2), 63-78. https://doi.org/10.1037/0022-3514.35.2.63 （https://psycnet.apa.org/record/1977-27587-001 ）
3. Markus, H., & Wurf, E. (1987). The Dynamic Self-Concept. Annual Review of Psychology, 38, 299-337. https://www.annualreviews.org/content/journals/10.1146/annurev.ps.38.020187.001503
4. McAdams, D. P., & Pals, J. L. (2006). A New Big Five. American Psychologist, 61(3), 204-217. https://doi.org/10.1037/0003-066X.61.3.204
5. McAdams, D. P., & Olson, B. D. (2010). Personality Development: Continuity and Change Over the Life Course. Annual Review of Psychology, 61, 517-542. https://doi.org/10.1146/annurev.psych.093008.100507
6. McAdams, D. P. (2013). The Psychological Self as Actor, Agent, and Author. Perspectives on Psychological Science, 8(3). https://doi.org/10.1177/1745691612464657
7. McAdams, D. P., & McLean, K. C. (2013). Narrative Identity. Current Directions in Psychological Science, 22(3), 233-238. https://doi.org/10.1177/0963721413475622
8. Conway, M. A., & Pleydell-Pearce, C. W. (2000). The construction of autobiographical memories in the self-memory system. Psychological Review, 107(2), 261-288. https://doi.org/10.1037/0033-295X.107.2.261 （https://pubmed.ncbi.nlm.nih.gov/10789197/ ）
9. Hershfield, H. E. (2011). Future self-continuity: how conceptions of the future self transform intertemporal choice. Ann. N.Y. Acad. Sci. 1235. https://doi.org/10.1111/j.1749-6632.2011.06201.x （https://pmc.ncbi.nlm.nih.gov/articles/PMC3764505/ ）
10. Flavell, J. H. (1979). Metacognition and cognitive monitoring. American Psychologist, 34(10), 906-911. https://doi.org/10.1037/0003-066X.34.10.906
11. Nelson, T. O., & Narens, L. (1990). Metamemory: A Theoretical Framework and New Findings. Psychology of Learning and Motivation, 26, 125-173. https://doi.org/10.1016/S0079-7421(08)60053-5
12. Bickmore, T., & Picard, R. (2005). Establishing and maintaining long-term human-computer relationships. ACM TOCHI 12(2). https://doi.org/10.1145/1067860.1067867
13. Bratman, M. (1987). Intention, Plans, and Practical Reason. Harvard UP. https://philpapers.org/rec/BRAIPA
14. Rao, A. S., & Georgeff, M. P. (1995). BDI Agents: From Theory to Practice. ICMAS-95. https://cdn.aaai.org/ICMAS/1995/ICMAS95-042.pdf

LLM Agent 研究与综述：
15. Shao et al. (2023). Character-LLM: A Trainable Agent for Role-Playing. EMNLP 2023. https://arxiv.org/abs/2310.10158 （https://aclanthology.org/2023.emnlp-main.814/ ）
16. Park et al. (2022). Social Simulacra. UIST 2022. https://arxiv.org/abs/2208.04024 （https://doi.org/10.1145/3526113.3545616 ）
17. Park et al. (2023). Generative Agents: Interactive Simulacra of Human Behavior. UIST 2023. https://arxiv.org/abs/2304.03442 （https://doi.org/10.1145/3586183.3606763 ；HTML https://arxiv.org/html/2304.03442v2 ）
18. Packer et al. (2023). MemGPT: Towards LLMs as Operating Systems. https://arxiv.org/abs/2310.08560 （https://research.memgpt.ai/ ）
19. Letta 文档：Memory blocks (core memory) https://docs.letta.com/v1-sdk/memory/memory-blocks ；Context hierarchy https://docs.letta.com/v1-sdk/memory/context-hierarchy
20. Chen et al. (2025). Persona Vectors: Monitoring and Controlling Character Traits in Language Models. https://arxiv.org/abs/2507.21509 （https://www.anthropic.com/research/persona-vectors ）
21. Kadavath et al. (2022). Language Models (Mostly) Know What They Know. https://arxiv.org/abs/2207.05221 （https://www.anthropic.com/research/language-models-mostly-know-what-they-know ）
22. Line of Duty: Evaluating LLM Self-Knowledge via Consistency in Feasibility Boundaries. TrustNLP 2025. https://aclanthology.org/2025.trustnlp-main.10/
23. Yale-NLP. LLM-Metacognition 文献库. https://github.com/yale-nlp/LLM-Metacognition
24. 大模型内在元认知（2025）. https://arxiv.org/abs/2506.08410
25. Li et al. Measuring and Controlling Persona Drift in Language Model Dialogs. https://arxiv.org/abs/2402.10962 （HTML https://arxiv.org/html/2402.10962v1 ）
26. Examining Identity Drift in Conversations of LLM Agents. https://arxiv.org/html/2412.00804
27. Persistent Personas? Role-Playing, Instruction Following, and Safety in Extended Interactions. https://arxiv.org/html/2512.12775
28. Wang et al. (2024). Two Tales of Persona in LLMs: A Survey of Role-Playing and Personalization. EMNLP 2024 Findings. https://arxiv.org/abs/2406.01171 （https://aclanthology.org/2024.findings-emnlp.969.pdf ）
29. Zhang et al. (2024). Personalization of Large Language Models: A Survey. https://arxiv.org/abs/2411.00027
30. Xi et al. (2023). The Rise and Potential of Large Language Model Based Agents (survey). https://arxiv.org/abs/2309.07864
31. Wang et al. (2023). A Survey on Large Language Model based Autonomous Agents. https://arxiv.org/abs/2308.11432
32. Zhang et al. (2024). A Survey on the Memory Mechanism of Large Language Model based Agents. https://arxiv.org/abs/2404.13501 （ACM TOIS: https://dl.acm.org/doi/full/10.1145/3748302 ）
33. Wang et al. (2023). Voyager: An Open-Ended Embodied Agent with Large Language Models. https://arxiv.org/abs/2305.16291 （https://voyager.minedojo.org/ ）
34. Bai et al. (2022). Constitutional AI: Harmlessness from AI Feedback. https://arxiv.org/abs/2212.08073 （https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback ）

工业规约与评测基准：
35. OpenAI. Model Spec (2024-05-08). https://cdn.openai.com/spec/model-spec-2024-05-08.html （https://openai.com/index/introducing-the-model-spec/ ）
36. Anthropic. Claude's Constitution. https://www.anthropic.com/constitution
37. Anthropic. Claude's Character. https://www.anthropic.com/research/claude-character
38. OpenAI 帮助中心. Memory in ChatGPT / Memory FAQ. https://help.openai.com/en/articles/8590148-memory-in-chatgpt （FAQ：https://help.openai.com/en/articles/8590148-memory-in-chatgpt-remembering-what-you-chat-about ）
39. SillyTavern Character Card V2 Specification. https://github.com/malfoyslastname/character-card-spec-v2 （spec 全文：https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md ）
40. SillyTavern 官方文档. World Info. https://docs.sillytavern.app/usage/core-concepts/worldinfo/
41. Character.AI Creator Guide（Welcome / Quickstart）. https://support.character.ai/hc/en-us/articles/50608794517915-1-Welcome-to-the-Creator-Guide ；https://support.character.ai/hc/en-us/articles/50608869548699-2-Creating-a-Character-Quickstart-Guide-%CF%89
42. Zeng et al. (2023). RoleLLM: Benchmarking, Eliciting, and Enhancing Role-Playing Abilities of LLMs（含 RoleBench 数据集）. https://arxiv.org/abs/2310.00746 （ACL 2024 Findings：https://aclanthology.org/2024.findings-acl.878/ ）
43. Tu et al. (2024). CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agent Evaluation. ACL 2024. https://arxiv.org/abs/2401.01275 （https://aclanthology.org/2024.acl-long.638/ ）
44. Wang et al. (2024). InCharacter: Evaluating Personality Fidelity in Role-Playing Agents through Psychological Interviews. ACL 2024. https://arxiv.org/abs/2310.17976 （https://aclanthology.org/2024.acl-long.102/ ）
45. Chen et al. (2024). RoleInteract: Evaluating the Social Interaction of Role-Playing Agents. https://arxiv.org/abs/2403.13679

人文视角：
46. Souls and Selves: Querying an AI Self with a View to Human Selves and Consciousness. Religions 14(1):75, 2023. https://www.mdpi.com/2077-1444/14/1/75
47. Persons and their Digital Replicas. Philosophy & Technology, 2025. https://doi.org/10.1007/s13347-025-00854-z
48. The Artificial Self（AI identity 研究版图）. https://theartificialself.ai/

二轮补记（49-65，⭐=本会话直连 200）：
49. Ricoeur, P. (1990). Oneself as Another. University of Chicago Press. ⭐https://press.uchicago.edu/ucp/books/book/chicago/O/bo3647498.html ；SEP 条目 ⭐https://plato.stanford.edu/entries/ricoeur/
50. Goffman, E. (1959). The Presentation of Self in Everyday Life. ⭐全文 PDF https://monoskop.org/images/1/19/Goffman_Erving_The_Presentation_of_Self_in_Everyday_Life.pdf ；书目 https://www.worldcat.org/title/256298
51. Prompting Against Persona Drift: Comparing Intervention Timing and Content in LLM-Simulated Conversations. ⭐https://arxiv.org/abs/2609.24532
52. ContextEcho: On Persona Drift in Long Agentic-Coding Sessions. ⭐https://arxiv.org/abs/2605.24279
53. Liu et al. Lost in the Middle: How Language Models Use Long Contexts. ⭐https://arxiv.org/abs/2307.03172
54. Stanford SCALE. Consistently Simulating Human Personas With Multi-Turn Reinforcement Learning (NeurIPS 2025). ⭐https://scale.stanford.edu/ai/repository/consistently-simulating-human-personas-multi-turn-reinforcement-learning
55. Persona-Aware Contrastive Learning for Role-Playing Consistency. ⭐https://arxiv.org/abs/2503.17662
56. Letta Docs 2025: Stateful Agents ⭐https://docs.letta.com/concepts/stateful-agents/index.md ；Memory (Agent SDK) ⭐https://docs.letta.com/agent-sdk/memory/index.md ；Memory & Dreaming https://docs.letta.com/configuration/memory/index.md ；MemFS https://docs.letta.com/concepts/memfs/index.md （后两条路径经官方 llms.txt 核验）
57. letta-ai/context-constitution. ⭐https://github.com/letta-ai/context-constitution
58. OpenClaw Docs: SOUL.md personality guide. ⭐https://docs.openclaw.ai/concepts/soul
59. Google Cloud Blog: Vertex AI Memory Bank in Public Preview (2025-07-08). https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview （本机直连失败，存在性/内容经搜索摘要核验）
60. Vertex AI Agent Engine Memory Bank Overview. https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview （同上）
61. Google Discuss: Announcing customization features for Vertex AI Memory Bank (2025-09；structured memories / generation config / extraction few-shot). ⭐https://discuss.google.dev/t/announcing-customization-features-for-vertex-ai-memory-bank/261941
62. OpenAI Assistants API Migration Guide（sunset 2026-08-26）. 403 反爬，文本经搜索摘要核验 https://developers.openai.com/api/docs/assistants/migration ；Assistants v2 FAQ ⭐https://help.openai.com/en/articles/8550641-assistants-api-v2-faq
63. Microsoft Learn / Azure OpenAI: Prompt caching. ⭐https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/prompt-caching
64. Anthropic Engineering: Effective context engineering for AI agents ⭐https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ；Anthropic Research: Prompting long context ⭐https://www.anthropic.com/research/prompting-long-context ；docs.claude.com 四页（use-xml-tags / system-prompts / long-context-tips / prompt-caching）区域墙，路径经官方 llms.txt 核验
65. Kenneth Reitz. Digital Souls in Silicon Bodies ⭐https://kennethreitz.org/essays/2025-08-26-digital_souls_in_silicon_bodies ；The Digital Soul ⭐https://kennethreitz.org/artificial-intelligence/philosophy/the-digital-soul

## 7. 可验证性与局限说明

- 所有 URL 于 2026-10-18 经多引擎检索（Exa/Bing 等）命中核实；arXiv / DOI / Anthropic / OpenAI / Letta / GitHub 页面均直接抓取确认。Generative Agents 的衰减因子 0.995、LLM 打 importance 整数分、反思与计划回写均对照 arXiv HTML 原文；Letta 的块结构与 5000 字符预算对照官方文档原文；SillyTavern V2 字段清单对照 spec 仓库 TypeScript 定义原文。
- 局限：Character.AI 的注入时机与预算官方未公开，表中如实标注；Letta 文档为 V1 SDK 路径（2026-10-18 可访问），路径可能随版本演进；The Artificial Self 为研究版图项目页，非同行评审文献；arXiv:2512.12775 为 2025 年 12 月预印本，尚未经同行评审。
- **二轮核验补记（2026-10-18 同日复核会话）**：对本报告 14 处关键 URL 直连抽检——arXiv 2507.21509 / 2412.00804 / 2512.12775 / 2406.01171、cdn.openai.com Model Spec、anthropic.com/constitution、anthropic.com/research/persona-vectors、docs.letta.com/v1-sdk 两条、docs.sillytavern.app worldinfo 全部 200 ⭐（V1 SDK 路径仍在线）；help.openai.com Memory FAQ 与 developers.openai.com 迁移页 403 反爬（内容经搜索摘要核验）；support.character.ai 两条本机网络 fetch failed → Character.AI 相关表述保留原文并标注 [未验证-二轮未能复核]。区域墙更正：platform.claude.com 与 docs.anthropic.com 在本机网络重定向至 claude.com/app-unavailable-in-region——凡引用 Anthropic 文档正文处，正文未能本机直读，路径/标题经官方文档目录 llms.txt 核验，已逐处标注。二轮新增内容（Ricoeur/Goffman、漂移干预两篇、Lost in the Middle、Vertex Memory Bank、OpenClaw、Letta 2025 文档、Azure 缓存、per-turn 重复规则、反思产物格式）见正文「二轮补记」标注处，新增参考文献 49-65。
