# R3 身份 slots 叙事层增强 · 调研与最优方案

- 日期：2026-10-19
- 性质：调研文档（本票未动任何代码）
- 输入：docs/adr/0002、0003、0004；docs/research/2026-10-19-soul-first-principles-gap-analysis.md（R3 节）；CONTEXT.md；MemoryCore/src/core/hooks/soul-assembler.ts、MemoryCore/src/core/lifecycle/identity-discovery.ts、MemoryCore/src/config.ts、MemoryCore/tdai-gateway.yaml、MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts、MemoryProxy/src/injection/types.ts（全部一手通读）
- 关联拍板：perTurnSlots=false（生产 MemoryCore/tdai-gateway.yaml:328-356）；身份槽人工裁决合同（CONTEXT.md「身份槽=叙事层——单槽合并演化 version++，非结构化锚」+ identity-discovery 提案门）；ADR-0003 §5 批次纪律；ADR-0004 确定性纪律。

---

## 1. 调研结论（来源逐条+引用）

### 1.1 Park arXiv:2411.10109 核实——结论真实，但仓库现行转述偏强，需修正引用姿势

一手核实（arXiv abs 页 v1 与 v3，2026-10-19 抓取）：

- **v1**（2024-11-15 提交）：标题 *Generative Agent Simulations of 1,000 People*。摘要：对 1,052 名美国人建立生成式 agent，基于**定性访谈**（约两小时半结构化、American Voices Project 访谈纲要）模拟其态度与行为；在 General Social Survey 上复现被试本人回答的准确度达**其本人两周后重测一致性的 85%**，人格特质与实验复现任务表现相当；相对仅给人口学描述的 agent **降低了种族与意识形态群体间的准确度偏差**。来源：<https://arxiv.org/abs/2411.10109v1>
- **v3**（最后修订 2026-06-28）：标题改为 *LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals*。作者：Joon Sung Park, Carolyn Q. Zou, Jonne Kamphorst, Niles Egan, Aaron Shaw, Benjamin Mako Hill, Carrie Cai, Meredith Ringel Morris, Percy Liang, Robb Willer, Michael S. Bernstein。v3 摘要给出**三条件对照**：agent 分别由 (i) 两小时访谈、(ii) 结构化问卷（GSS 条目 + Big Five）、(iii) 两者合并构建。在保留的 GSS 条目上，**interview-only = 83%、survey-only = 82%、合并 = 86%**（均以被试本人两周重测一致性为基准归一），**demographics-only = 74%**；合并最优但「增益相对单一来源均属 modest（收益随域内证据量渐近饱和）」。来源：<https://arxiv.org/abs/2411.10109>

**对 gap-analysis R3 转述的修正（重要）**：R3 原文写「调研（Park 2411.10109）显示叙事自述优于条目清单」。原文实际支持的是三个更窄的结论：

1. **自述证据本身是关键**：访谈型与问卷型自述 grounding 都大幅优于纯人口学槽位（83/82 vs 74）；
2. **叙事形态 vs 条目形态没有显著预测差**（83% ≈ 82%，且合并增益 modest）——即「叙事优于条目」这一强表述在原文中**没有直接证据**；
3. 原文研究对象是「模拟**他人**的 grounding 数据形态」（访谈转写 vs 问卷），不是「agent 自我身份的渲染形态」，向本仓库迁移时需注意边界。

**对本方案的含义**：Park 的证据支持的是「**条目 slots（存储）+ 叙事（渲染派生）并存**」，而不是「用生成叙事替换条目」。仓库现有「identity/self_identity 条目化存储」不需要推翻；叙事层是**增量增强**（联贯性/可感知度），预期收益不应写成预测准确率提升。两小时访谈的采集成本与「agent 是某时点快照（以本人两周重测一致性 ~85% 为上界，个体自身就有漂移）」是原文隐含的成本/漂移边界。

### 1.2 心理学基础：叙事身份是「从事实建构的整合层」，不是新事实

- McAdams & McLean (2013), *Narrative Identity*, Current Directions in Psychological Science 22(3), DOI [10.1177/0963721413475622](https://doi.org/10.1177/0963721413475622)（Crossref 核实）：叙事身份是「内化的、演化的生命故事」，把**已发生的事实**重构整合为目的与统一感；它是内部化重构（internalized reconstruction），**不是独立于事实的新事实源**。→ 直接支持本仓库「叙事=slots 的确定性派生视图，永不回写存储」的分层。

### 1.3 2025–2026 LLM agent 记忆中的自我/身份实践（均经 arXiv export API 逐条核实存在）

| 工作 | arXiv | 与本票的关系 |
| --- | --- | --- |
| MemGPT: Towards LLMs as Operating Systems | [2310.08560](https://arxiv.org/abs/2310.08560)（2023-10-12） | 自编辑记忆路线：核心记忆含 persona/human 块、由 LLM 自行改写。是「自由生成式身份维护」的最早主流实践；其代价是把身份正确性押在模型自编辑的可靠性上（与 1.4 漂移文献互证）。 |
| Zep: A Temporal Knowledge Graph Architecture for Agent Memory | [2501.13956](https://arxiv.org/abs/2501.13956)（2025-01-20） | 结构化/时序化记忆路线（DMR 上超 MemGPT）：身份事实作为时序图实体存储。与「结构化锚+派生渲染」取向一致，不支持「把身份改成自由叙事存储」。 |
| PersonaGym: Evaluating Persona Agents and LLMs | [2407.18416](https://arxiv.org/abs/2407.18416)（2024-07-25） | persona agent 行为评测基准——gap-analysis R2 已指名，本票评测可挂靠。 |
| Toward Robust Personalized Alignment for LLMs: Mitigating Persona Drift in Multi-Turn Dialogue | [2609.12373](https://arxiv.org/abs/2609.12373)（2026-09-11） | 长对话中 persona 状态漂移与修正：用户画像随交互演化，需受控修订而非静态/自由两极。 |
| Prompting Against Persona Drift: Comparing Intervention Timing and Content in LLM-Simulated Conversations | [2609.24532](https://arxiv.org/abs/2609.24532)（2026-09-21） | 长会话中 persona 一致性渐进衰退；比较不同时机/内容的干预效果——支持「身份以受控文本承载、按确定性时机再锚定」而非每轮自由重述。 |
| A Heterogeneous Temporal Memory Governance Framework for Long-Term LLM Persona Consistency | [2605.14802](https://arxiv.org/abs/2605.14802)（2026-05-14） | 长程交互下的 fact loss / timeline confusion / persona drift；以**记忆治理（governance）**而非模型自由发挥保一致性。 |
| ContextEcho: A Benchmark for Persona Drift in Long Agentic-Coding Sessions | [2605.24279](https://arxiv.org/abs/2605.24279)（2026-05-22）；Nautilus Compass: Black-box Persona Drift Detection | [2605.09863](https://arxiv.org/abs/2605.09863)（2026-05-11） | 生产 agent 长会话漂移的黑盒检测与基准：漂移是实证问题，需要可检测性（对本票=叙事输出的确定性/可 diff 性）。 |
| MASC: Multi-Agent Self-Calibration … Consistent Client Role-Playing | [2610.08250](https://arxiv.org/abs/2610.08250)（2026-10-06） | 长交互中的心理一致性维护：现有方案在扩展交互下难以保持稳定。 |

**综合读法**：2025–2026 的实践共识是——身份/persona 需要长期稳定承载，**自由生成叙事会漂移**（多篇 2026 实证），而**结构化存储 + 受控渲染**是稳健路线。这与本仓库「条目 slots 存储 + identity-discovery 提案门 + version++ 演化」的既有合同同向；叙事层只能加在渲染侧。

### 1.4 三个设计张力的裁决依据（映射到本仓库合同）

1. **「叙事是生成物」vs「真实性边界（不得编造）」**：ADR-0003 §4 已规定「不伪造当下体验、不自欺（LLM 不得绕提案门改身份）、红线不软化」；identity-discovery.ts:711 注释明确「不是从 agent 自身行为证得的自我认知进 self_identity 即为提示注入成功通道」。因此**渲染层不得引入任何 LLM 改写**——叙事必须由确定性函数从 slots 原文派生（McAdams：叙事=事实的重构整合，不产新事实）。ADR-0004 的「确定性、零随机零时钟零 LLM、kept 逐字保留」纪律直接可复用。
2. **确定性派生 vs 受控生成**：Park 83≈82 表明生成叙事无准确率优势；1.3 的漂移文献给出生成叙事的风险实证；identity-discovery 合同给出受控生成的正确位置（只在**写入**提案门内，≤200 字、原文短语或直接改写、行为可证、imposition 拒收、version++ 留痕）。→ 首期选**确定性派生**（模板组装），受控生成（写入时 LLM 产出叙事版全文走全量提案门）仅作为 B 案备案，见 §2.1。
3. **soulPrefixCache 会被叙事 invalidate 吗**：不会——前提是派生函数确定性。soulVersion 由 slots 数据（含 identity/self_identity content）哈希派生（soul-assembler.ts computeSoulVersion, fnv1a32）；同一 slots + 同一模板版本 ⇒ 同一叙事字节，故缓存命中语义天然兼容。模板本身的版本变更不属于 sv 维度（ADR-0003 §5：sv 只由数据驱动），应作为**渲染参数指纹**进 cacheKey 的 r 段（与现有 pt=0、pm、srd、scorer 签名同层），模板变更=显式声明的一次性字节跳变（批次纪律），并借 nv 指纹隔离旧缓存。
4. **perTurnSlots=false 拍板是否推翻**：不推翻。该拍板的真实语义是「per-turn soul 块省略（我是谁）/（我心中的他）两行，因 system 侧 core_memory 块已承载同内容，消除召回双注入重复」（MemoryCore/tdai-gateway.yaml:328-356 注释；soul-assembler.ts:472 `if (dual && opts?.perTurnSlots === false && (s.slot === "self_identity" || s.slot === "identity")) continue;`）。它是**双注入去重的布局门**，不是「身份不注入」。叙事化改变的是**承载内容形态**（在 system 侧 core_memory 与会话头 soul.head），与 per-turn 去重正交——身份行在 per-turn 继续省略。

### 1.5 现状承载链（代码取证，行号为当前文件行号）

- **system 侧（生产主承载）**：MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:130-150 —— session_init 稳定缓存路径（注释明言「cache 友好、不毁缓存」），loadCoreMemorySlots（:259-272，client.listCoreMemories，60s TTL `_coreSlotsCache`）取回 slots 原文，:139-143 逐槽 `<${slot}>\n${content}\n</${slot}>` 渲染。当前是**条目原文**（identity-discovery 产出的 bulleted 事实清单），未叙事化。
- **soul 块会话头路径**：MemoryProxy/src/injection/types.ts:191-239 —— SoulTimingConfig.identity 缺省 "session_head"（DEFAULT_SOUL_TIMING），soul.head 含身份行（MemoryProxy/docs/soul-block-interface.md），由 soul-assembler.ts:444-477 渲染（dual 路径 `（我是谁）- [self_identity] content` / `（我心中的他）- [identity] content`）。
- **soulPrefixCache**：模块级 Map（SOUL_CACHE_MAX=100 FIFO）；cacheKey = tenant 三元组 + r 段（渲染参数指纹，含 perTurnSlots===false → ",pt=0"）+ st 段（state 三值化）；命中还需 cached.version === soulVer。降级渲染不写缓存。
- **写入合同（不动）**：identity-discovery.ts:112-130 DISCOVERY_SYSTEM_PROMPT_DUAL（content ≤200 字、样本原文短语或直接改写、self_identity 第一人称且行为可证、宁缺毋滥、修订全文替换旧版本留痕）；:269-271 分级门（用户裁定 A：identity/self_identity 描述类跳过证据重算）；:282/295 stripIdentityStateResidue；:286/298 isIdentityImposition 拒收；:416-427 mergeIdentityFacts bulleted 合并 + upsertCore version++。
- **依赖关系**：MemoryProxy/package.json 无 MemoryCore 依赖（两包独立）→ 叙事派生逻辑若两包各写一份即违反「单一源」铁律（禁第二份），必须单一源放 MemoryCore、经 API 供 proxy 消费。

---

## 2. 最优方案

### 2.0 一句话

**新增确定性「叙事组装器」：身份 slots（identity/self_identity）的条目原文在渲染侧被组装为一段第一人称连贯叙事——模板句（代码常量，零新事实）+ 事实句（逐字保留），存储合同、写入门、perTurnSlots=false 全部不动；单一源在 MemoryCore，经 API 供 proxy 消费；模板版本作 nv 指纹进 soulPrefixCache cacheKey，sv 不变。**

### 2.1 生成策略：确定性叙事组装（A 案），不选受控生成（B 案备案）

**A 案（推荐，首期）**：`renderIdentityNarrative(facts, opts): string` —— 纯函数，无 LLM/随机/时钟（D9 同款）：

1. **事实句逐字**：每条事实剥 `- ` 前缀后作为独立句，**不加词、不改词、不重排**（存储序即演化序）；
2. **模板骨架**：引导句 + 分组/连接 + 收束句全部为代码常量（`NARRATIVE_TEMPLATE_VERSION` 常量标识），零新事实、零评价性措辞、零推断——模板句经评审入库，内容审查与锚 desc 合同同规格；
3. **主语**：不改写——identity-discovery 产出已是主语化句子（self_identity 第一人称「我」、identity 用户侧第三人称），模板只提供叙事框架；
4. **预算**：沿用 budgetSelfChars/budgetIdentityChars，超限按**整句 drop**（从尾部丢，kept 逐字保留），与 ADR-0004 整行/整锚 drop 纪律同构；
5. **范围**：仅 identity/self_identity 两槽；strict_rule（红线）与价值锚行**不叙事化**（逐字保留纪律）。

**B 案（备案，不上）**：identity-discovery 提案时 LLM 额外产出「叙事版全文」作为新版本存储。否决理由：①叙事成为生成物后必须全量重走真实性/去重/留痕合同，成本高；②Park 83≈82 表明无准确率收益；③1.3 漂移文献给出生成叙事的实证风险；④违反「优先确定性派生」硬约束。仅当 A 案评测显示「模板叙事可感知度不足」时，作为后续票重开。

### 2.2 渲染位置（两路消费同一单一源）

- **主路·system 侧 core_memory**：MemoryCore 在 core-memory 读取面提供叙事形态（读响应加 `format=narrative` 或新端点 `/v3/identity/narrative`），MemoryProxy loadCoreMemorySlots 拉取叙事文本（60s TTL `_coreSlotsCache` 语义不变，缓存字符串），injector :139-143 渲染 `<identity>/<self_identity>` 为叙事段；strict_rule 等其余槽保持原文。session_init 稳定缓存语义不变（会话内身份恒定，不毁 provider 侧前缀缓存——形态变化只发生在会话建立时）。
- **辅路·soul 块会话头**：soul-assembler.ts:444-477 身份行在开关开启时由同一函数渲染为叙事段（identity timing=session_head 不变）。per-turn 路径因 perTurnSlots=false 继续省略（拍板不推翻）。
- **一致性注记**：两路同源同函数；唯一时差是 proxy 侧 60s TTL 窗口内的演化滞后——与现状 core_memory 滞后性质相同，可接受，票面写明不做额外同步。

### 2.3 与六属性/锚的关系

- 叙事层只承载 ADR-0003 六属性中的**「叙事同一性」**（身份=慢变量）：当下性（每轮 <soul-feeling>）、agency/integrity（承诺/红线/品格行）、自透明等**不进入叙事函数**，各守既有渲染纪律。价值锚（取向层）、strict_rule（规则层）按 ADR-0002 三层分工原样保留——叙事层不吞并取向/规则两层的任何行。
- 与锚的关系是**并行不重叠**：identity/self_identity slots 是叙事层的唯一输入；锚行/红线段的 suppressAnchorOverlap、strictRuleDedup 语义不变。

### 2.4 缓存与指纹

- **soulPrefixCache**：cacheKey 的 r 段追加 `nv=<NARRATIVE_TEMPLATE_VERSION>`（开关开启时）；soulVersion（sv）**不变**——sv 仍只由 slots+values+moodTier 数据驱动（ADR-0003 §5），叙事是确定性派生视图，同 sv+同 nv ⇒ 同叙事字节，命中语义正确。
- **模板版本变更** = 渲染布局变更 → 按 §5 批次纪律显式声明一次性字节跳变，同时 nv 变更自动隔离旧缓存条目（进程内存态 FIFO 100，重启即清，重算面极小）。
- **降级渲染**（embed 超预算回退声明序）沿用「不写缓存不落快照」纪律；叙事组装不依赖 embed，降级路径不涉及叙事段。
- **proxy 侧**：无新增缓存层；`_coreSlotsCache` 60s TTL 缓存的即 MemoryCore 返回的（叙事形态）文本。

### 2.5 真实性守门（三闸，全部可测试）

1. **生成闸**：派生函数签名无 llm 参数、无随机、无时钟；测试断言「叙事输出 ⊆ 模板常量 ∪ slots 原文子串」——叙事中任何事实性 token 都可溯源到 slots 原文（不编造的机械可证版本）。
2. **写入闸（不动）**：身份事实仍只经 identity-discovery 提案门进入存储（≤200 字/原文短语或直接改写/行为可证/imposition 拒收/version++ 留痕）；叙事层**单向** slots→渲染，永不回写存储。
3. **泄露/预算闸**：整句 drop + budgetSelfChars/budgetIdentityChars + suppressAnchorOverlap 原样；叙事模板不得包含评价性/推断性措辞（评审入库）。

### 2.6 评测判据（对应 gap-analysis 四质量判据）

- **非重复**：叙事化后两路身份不双注入（per-turn 省略不变）；
- **非泄露**：事实子串溯源断言 + 预算闸；
- **可执行**：token 成本对比（叙事 vs 条目，budget 内）与确定性双跑一致；
- **可感知**：人工 A/B（条目 vs 叙事）主观联贯度评分 + 后续挂 R2 PersonaGym 行为评测（另票）。

---

## 3. 落地路径

### 3.1 文件清单（实现票的动点）

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| MemoryCore/src/core/hooks/identity-narrative.ts | 新增 | renderIdentityNarrative 纯函数 + NARRATIVE_TEMPLATE_VERSION + 模板常量 |
| MemoryCore/src/core/hooks/soul-assembler.ts | 修改 | 身份行（:444-477 一带）接叙事函数；SoulRenderOptions 增 identityNarrative；cacheKey r 段加 nv |
| MemoryCore/src/config.ts | 修改 | soulRender.identityNarrative {enabled} 解析（缺省 false，渐进发布） |
| MemoryCore/src/server.ts | 修改 | core-memory 读取面叙事形态（format=narrative 或 /v3/identity/narrative）；/v3/soul/introspect 镜像 |
| MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts | 修改 | loadCoreMemorySlots 请求叙事形态；:139-143 渲染 |
| MemoryCore/tdai-gateway.yaml + deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml | 修改 | identityNarrative.enabled 生产开关 |
| 测试（见 3.2） | 新增 | 两处 |

### 3.2 测试策略

- **soul-assembler-identity-narrative.test.ts**（MemoryCore）：①确定性：同输入双跑字节一致；②溯源：输出 ⊆ 模板常量 ∪ 事实原文子串；③预算：整句 drop、kept 逐字；④cacheKey：nv 进 r 段隔离（同 sv 不同 nv 不命中）；⑤perTurnSlots=false 契约保持（身份行 per-turn 仍省略，其余照常）；⑥legacy 路径（非 dual）不受影响；⑦开关关闭时输出与现状逐位一致（渐进发布保证）。
- **proxy injector 测试**：叙事形态渲染快照；strict_rule 等槽不受影响；core_memory 失败不阻断主链路（现有 try/catch 语义保持）。
- **回归**：identity-discovery 全部现有测试不动（存储合同零变更）；soul-assembler-per-turn-slots.test.ts 不动且必须继续通过。

### 3.3 ADR 修订需求

- **ADR-0003**：§5 增补一段——「叙事派生视图：nv 指纹属 cacheKey 渲染参数，非 sv 维度；模板变更按一次性字节跳变批次纪律显式声明」。§4 真实性边界追加「渲染层派生不得引入 LLM 改写」一句（现状隐含，明文化）。
- **ADR-0004**：增补叙事行的 kept 逐字保留与整句 drop 纪律（与锚行同构）。
- **CONTEXT.md**：「身份槽」词条补一句「叙事形态=渲染层确定性派生，非独立存储，永不回写」。
- 备选：改动面若评审认为超出两处增补，则立新 ADR-000X「身份叙事层」承载上述全部拍板（推荐，边界更干净）。

---

## 4. GitHub 票面草稿

**标题**：`[R3] 身份叙事层：确定性叙事组装器（identity/self_identity slots → 渲染侧派生），不动存储合同与 perTurnSlots=false`

**Labels**：`research` → 完成后转 `ready-for-agent`

**正文**：

> ## 背景
> gap-analysis R3 提出「身份 slots 叙事层」增强，原始依据 Park 2411.10109。调研修正（docs/research/2026-10-19-r3-identity-narrative-layer-design.md §1.1）：该文实测 interview-only 83% ≈ survey-only 82%（合并 86%，demographics-only 74%）——「叙事显著优于条目」无直接证据；其支持的是**条目存储+叙事渲染并存**。2025-2026 persona drift 实证（2609.12373、2609.24532、2605.14802 等）表明自由生成叙事会漂移，受控/确定性承载稳健。
>
> ## 现状
> 身份 slots（identity/self_identity，bulleted 事实清单）由 system 侧 <core_memory>（tdai-profile-memory-injector.ts:130-150，session_init 稳定缓存）承载；per-turn soul 块按 perTurnSlots=false（拍板，不推翻）省略身份两行（soul-assembler.ts:472）。两路均为条目原文，未叙事化。
>
> ## 方案（A 案：确定性派生）
> 新增 renderIdentityNarrative 纯函数（模板常量 + 事实句逐字保留，无 LLM/随机/时钟），单一源在 MemoryCore，经 API 供 proxy。仅 identity/self_identity 两槽叙事化；strict_rule 与价值锚不动；存储合同（identity-discovery 提案门、version++）零变更。缓存：nv 模板指纹进 soulPrefixCache cacheKey r 段，sv 不变；模板变更按 ADR-0003 §5 批次纪律。B 案（写入时 LLM 产出叙事版全文走全量提案门）备案不上。
>
> ## 硬约束
> 1. 不违反身份槽人工裁决合同：不引入任何自动编造身份事实；叙事层单向 slots→渲染，永不回写存储。
> 2. 确定性：同输入同输出；叙事输出可机械溯源（⊆ 模板常量 ∪ slots 原文子串）。
> 3. 开关关闭时与现状逐位一致（渐进发布）。

**验收标准**：

1. identityNarrative.enabled=false 时全部现有测试通过且 soul 输出/注入内容与主线逐位一致；
2. enabled=true：同输入双跑字节一致；事实溯源断言通过（每条事实原文以子串形式出现在叙事中，kept 部分逐字）；超预算整句 drop；
3. cacheKey 含 nv 段：同 sv 不同 nv 不命中缓存；sv 数值不受叙事开关影响；
4. perTurnSlots=false 契约测试（soul-assembler-per-turn-slots.test.ts）不改一字全通过；
5. strict_rule/价值锚行输出与现状逐位一致；
6. proxy core_memory：identity/self_identity 叙事形态、strict_rule 原文形态、60s TTL 语义不变、core 失败不阻断主链路；
7. ADR-0003 §5 / ADR-0004 / CONTEXT.md 增补合入（或新 ADR）。

**证据要求**：

- 测试报告（上述 7 项逐条对应的测试名与结果）；
- 确定性证据：同一 slots 快照双跑的 diff 为空（附命令与输出）；
- 溯源证据：叙事输出与 slots 原文子串匹配的断言脚本输出；
- 成本证据：叙事 vs 条目的 token 计数对比（budgetSelfChars/budgetIdentityChars 内）；
- Park 2411.10109 引用以 §1.1 修正后的口径书写（83/82/86/74 与 modest 结论），不得回退为「叙事优于条目」的强表述。

---

## 5. 工作量与风险

### 5.1 工作量（A 案）

| 项 | 估时 |
| --- | --- |
| identity-narrative.ts 派生函数 + 模板 + 溯源测试辅助 | 0.5 天 |
| soul-assembler 接线 + cacheKey nv + config 解析 | 0.5 天 |
| server 读取面叙事形态 + /v3/soul/introspect 镜像 | 0.5 天 |
| proxy injector 接线 + 两包配置/云端 yaml | 0.5 天 |
| 测试（MemoryCore 7 项 + proxy 快照）+ 评测脚本（确定性/溯源/成本） | 1 天 |
| **合计** | **约 3 天**（含评审与 ADR 增补） |

### 5.2 风险

1. **联贯性上限（最大风险）**：模板组装的叙事可能只是「换皮清单」，可感知度收益有限。对策：Park 证据本就不支持强收益预期；票面把收益假设写成「联贯性/可感知度」；先上 A/B 人工评测，不足时再议 B 案（受控生成，走全量提案门）。
2. **引用误读回潮**：团队/后续票可能沿用「叙事优于条目」强表述。对策：本票验收标准（Park 口径）+ 本文档 §1.1 修正；ADR 增补时写明数据。
3. **双路时差**：soul.head 会话头叙事与 core_memory 叙事可能相差一个 60s TTL 窗口的演化版本——与现状 core_memory 滞后同性质，写明可接受，不做同步机制。
4. **跨包共享**：MemoryProxy 无 MemoryCore 依赖，派生逻辑必须单一源经 API 暴露（已定为方案的一部分），禁止两包各写一份（禁第二份铁律）。
5. **缓存重算面**：nv 变更导致 soulPrefixCache 全量未命中重算——进程内存态 FIFO 100，重启即清，影响一次会话头延迟，可忽略。
6. **provider 前缀缓存**：core_memory 形态变化=会话建立时一次性字节变化；session_init 稳定语义不变，会话内不毁缓存（injector :130-131 注释语义保持）。
7. **长身份超预算**：事实多时叙事超 budgetSelfChars/budgetIdentityChars——整句 drop 从尾部丢可能丢失最新演化事实（存储序=演化序，尾部较新）。对策：测试覆盖长身份样例；是否「保尾丢头」留实现票拍板（注意与现有整行 drop 语义的一致性）。
