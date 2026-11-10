# 人格如何被经历缓慢改变：可计算机制与可评测指标（证据台账）

- 日期：2026-11-08｜性质：只读调研（未改代码、未写生产库、未 commit）
- 落点：`MemoryCore/src/core/soul/traits.ts`、`trait-drift.ts`、`drift.ts`（六轴 warmth/agency/rigor/openness/stability/boundary）
- 规则：每条结论带 URL + 段落/公式/表位置；抓不到原文的一律写「未采集」，不做转述式加码

---

## 0. 结论先说

1. 特质是「状态的分布参数」，单次状态只是分布里的一个样本 → 单事件改人格在机制上不成立，只应有界更新均值（Fleeson/WTT）。
2. 事件→数值这件事 1993 年就有完整实现：强度 = 一组**乘法因子**，每个因子都给了取值区间与默认值，缺失取中性 1 → 可重算（Elliott & Siegle）。
3. 没有任何权威来源给出「人格特质半衰期」的标准值。能直接引的是：记忆遗忘曲线 `R=e^{-t/S}`、人类情绪 episode 时长统计、一个单作者预印本的三重门槛设计。
4. 有界性在工程上只有三招：单步上限、冲突即覆盖/删除、更新门槛（幅度+置信+频次）。我们现在有前两者的一半，缺「时间窗/频次」。
5. 评测里唯一有硬相关性数字的是 CharacterEval（0.631）与 MT-Bench（>80%），但它们的维度对编码型 agent 大多不适用；且 2410 道事实题上人格提示**没有**任何客观收益。

---

## 1. 特质 vs 状态：为什么单次事件不能改人格

**主张**：人格特质是「状态随时间的密度分布」的参数；行为在均值周围波动，波动本身不是人格改变。

**证据**
- Fleeson 2001, *JPSP* 80(6):1011–1027, DOI `10.1037/0022-3514.80.6.1011`。经 WTT 官方综述转述：trait 对应 states 的 density distribution，个体行为围绕动态均值局部波动（https://en.wikipedia.org/wiki/Whole_Trait_Theory ¶60/¶63；https://fleesonlab.wordpress.com/whole-trait-theory/ ¶18/¶35）。
- 组内变异量级有旁证：PMC4673017 摘要「Within-person variability in the current study ranged from .48 to 1.05 versus .59 to 1.16 in Fleeson (2001)」（https://pmc.ncbi.nlm.nih.gov/articles/PMC4673017）。
- WTT 2015 正式综述：*J Res Pers* 56:82–92, DOI `10.1016/j.jrp.2014.10.009`；2025 新篇 "Getting from states to traits" DOI `10.1177/08902070251366709`（fleesonlab ¶35/¶38）。

**未采集**：Fleeson 2001 原文 PDF 与逐项组内变异数值（只有 PMC 转引）。

**对系统的直接含义**：一次 episode 只能算「分布里的一个样本」。若一次事件就能把轴推过显著区间，系统实际上把「特质」降级成了「状态」。我们的净票门槛（`|net|<TRAIT_MIN_NET=2` 不动）方向正确，但门槛是**计数**不是**时间**：一天 100 个 episode 与一周 100 个 episode 等价。

---

## 2. 事件如何映射到可重算的数值

### 2.1 OCC 的乘法强度函数（首选：可直接实现）

来源：Elliott & Siegle, "Variables Influencing the Intensity of Simulated Affective States", AAAI Spring Symposium, 1993, 58–67。全文 HTML：https://condor.depaul.edu/elliott/ar/papers/EmotionVariables.html

- 结构：**24 类情绪**（OCC 22 类 + 扩展 love/hate），Figure 1 按 Group/Category 分组（joy/distress；happy-for/gloating/resentment/sorry-for；hope/fear；satisfaction/relief/fears-confirmed/disappointment；pride/admiration/shame/reproach；liking/disliking；gratitude/anger/gratification/remorse；love=admiration+liking、hate=reproach+disliking）。
- 公式形态（"Ranges and Defaults" 节原文）：「we use values for the intensity variables as factors: those values below 1 reduce the strength of the emotion, those above 1 increase it」——强度 = 归一化常数 × 各因子**相乘**。
- 关键区间与默认（原文自述区间是 arbitrary、不主张心理保真）：
  - 事件变量：Goal realization/blockage `−10..10`（无默认，必须算）；Certainty `0..1` d=1；Sense-of-reality `0..1` d=1；**Temporal proximity `0..1` d=1**（越近越强，用于 rumination 式重复情绪）；Surprisingness `1..3` d=1；Effort `0..3` d=1。
  - 倾向变量：Importance of achieving goal `0..10` **d=3**；importance of not blocked `0..10` d=3；standard upheld/violated 各 `0..10` d=3；Influence of preference `0..10` d=3；Friendship-animosity `bias+strength 1..3` d=1。
  - 心境变量：Arousal `0.1..3`；Depression-ecstasy `1..3` d=1.5；Anxiety-invincibility `1..3` d=1；Importance of all GSP `0.3..3`。
- Figure 2 给出 Lisp 实现 `goal-relevant-intensity`（正/负 valence 分别取 importance-achieving / importance-not-blocking；偏置不匹配时用 `protect-divide` 取倒数）→ 同一 episode 可用固定规则复算出同一强度。

**可重算性判断**：这是全篇唯一「因子有区间、缺失有默认、组合有代码」的方案。形容词（"用户很失望"）无法重算，标量乘子可以。

**落地映射**：把 `Temporal proximity` 换成「事件距今」的 `0..1` 函数（1=当下、→0=久远），把 `Importance` 换成我们已有的显著性（净票 / 受影响轴数），`Surprisingness 1..3` 换成「与既有基线偏离度」。这样 `强度 ∈ [0, ~3]`，再做 `tanh` 归一进 `±1`，与现有 `s_j=tanh(net_j/3)` 是同构的，只是把「票数」换成「加权票」。

### 2.2 PAD 三层与 ALMA（结构可用，常数未采集）

- https://alma.dfki.de/ 首页与 Technical Background：24 emotion types / 8 mood types / 5 personality types，覆盖 short–medium–long term affect；mood 在 8 个 mood class 上连续模拟，用「different intensity decay functions」[Gebhard 05]；Gebhard & Kipp 06（IVA'06, 343–356）做过人类评估，结论 affect 被评为 plausible。
- 论文 PDF（https://alma.dfki.de/papers/aamas05.pdf，AAMAS'05 29–36；iva06.pdf）抓取 HTTP 200 但正文为空 → **衰减常数、PAD 坐标公式未采集**。

**可落地（结构性）**：三层时间尺度 ≈ 我们的 `turn`（情绪尾巴）→ `snapshot`（心境）→ `drift`（人格轴）。这条正好解释为什么 `<soul-feeling>` 与轴状态要分开存：一个是状态，一个是分布参数。

### 2.3 Big Five 的 facet 层（粒度依据）

- DeYoung, Quilty & Peterson (2007), "Between facets and domains: 10 aspects of the Big Five", *JPSP* 93(5):880–896, DOI `10.1037/0022-3514.93.5.880`。标题即主张：每个域再分为两个 aspect，共 10 个（比 5 域细、比 30 facet 粗）。
- **未采集**：10 个 aspect 的名称、BFAS 题项原文（两份 PDF 均抓取失败）；NEO-PI-R 30 facets 原文同样未采集。

**判断（推断，非引文）**：我们的 6 轴落在「域→aspect」之间，粒度合理；再细到 30 facet 会让单轴事件供给不足（每轴每周不足 1 票时，`|net|≥2` 永不满足）。

---

## 3. 缓慢漂移的工程参数：能查到什么、查不到什么

| 来源 | 给出的东西 | 是否可直接用 |
|---|---|---|
| MemoryBank §2.3（https://arxiv.org/html/2305.10250v3） | 遗忘曲线 `R = e^{-t/S}`；S 初值 1，每次被召回 `S += 1` 且 `t := 0`；作者自称 "exploratory and highly simplified" | 结构可用（强度随距上次强化线性变慢），常数无实证 |
| Elliott 1993（同上） | Temporal proximity `0..1` 乘子、默认 1 | 可直接用，是线性权重不是指数 |
| Verduyn & Lavrijsen 2015, *Motivation and Emotion*, DOI `10.1007/s11031-014-9445-y`；经 BPS 2014-11-26 报道 https://www.bps.org.uk/research-digest/why-sadness-lasts-longer-other-emotions | 27 种情绪的平均 episode 时长：sadness 120 h、hatred 60 h、joy 35 h、shame 0.5 h；事件重要性+反刍解释约一半变异 | **不是半衰期**。若做指数近似，半衰期≈时长×0.5 是我的推导，非原文结论 |
| Mem0 §2.1（https://arxiv.org/html/2504.19413v1） | ADD / UPDATE / DELETE / NOOP 四操作；m=10 近邻消息、s=10 相似记忆、GPT-4o-mini | 无权重、无半衰期：属「冲突即覆盖」而非缓慢漂移 |
| Zep（https://arxiv.org/abs/2501.13956） | Graphiti 时序图；DMR 94.8% vs MemGPT 93.4%；LongMemEval +18.5%、时延 −90% | 仅摘要级；双时态字段与失效规则**未采集** |
| StableMind（Zenodo `10.5281/zenodo.20827145`，2026-06-08，v1.1） | 两层时间尺度；反思机制仅在「magnitude + confidence + observation frequency」三门槛同时满足时更新 trait；离散 adaptation cycles 防 abrupt shift | **低证据等级**：单作者、预印本、摘要无数字。只能当同构设计参照 |

**OpenAI/DeepSeek 级别的「官方人格参数」**：未采集（无任何厂商公开过此类数值）。

**我们现状的量化推演（从代码算，非引用）**：`α=0.02`、`TRAIT_MAX_STEP=0.05`、`s=tanh(net/3)`。`net=2 → s=0.583 → Δ=0.0117`；要把某轴从 0 推到 `L1` 预算内的 0.5，需约 43 个满额 episode。也就是说：**当前系统的「慢」来自计数门槛，不来自时间衰减**——一个突发日（burst）在 `TRAIT_BURST_CAP=1` 之后仍会按天累积，而一个平静月不会让已有偏移回落。这是设计缺口，不是 bug。

---

## 4. 有界性：怎么防「一次强烈事件改写人格」

**已具备（代码事实）**
- L1 归一 + `±1` clamp；单 tick 每轴 `|Δ| ≤ 0.05`，超限**整轴拒绝**并记 `step_exceeded`；`|net| < 2` 不动；一 episode 最多动两轴；只接受本轮新增 episode（G3）；标签证据 `< minEvidence(3)` 不受理。
- `drift.ts` 双轨（voice/judgment）用 cosine vs 行为锚，连续低于 `driftDegrade` 判 degrade、更低判 freeze，且无锚时明确「不伪造分数」。

**外部做法（可引）**
1. **冲突即删除**（Mem0 §2.1）：新信息矛盾时 `DELETE` 旧条目而不是叠加。含义：一致性优先于历史完整性；对人格层等价于「新证据推翻旧结论时，旧结论不参与投票」。
2. **每轮重复注入**（Li et al., arXiv:2402.10962v4 §6.3，https://arxiv.org/html/2402.10962v4）：system prompt 重复（SPR）在长对话最有效但吃上下文；机制是 attention decay（Fig.4 第 24 层第 11 头对 system token 注意力随轮次下降），且模型会**逐渐采纳对方的 system prompt**（Fig.3A 橙线）。→ 「一次注入、长期有效」在这个机制下站不住，每轮尾巴注入（`<soul-feeling>`）是对的，但稳定段也必须每轮在场。
3. **三重门槛 + 离散更新周期**（StableMind，低证据等级）：幅度、置信、观测频次同时满足才更新 trait；平时只更新 belief。→ 与我们「episode 先入账、聚合后才动轴」同构，可作为「为什么不逐条更新」的第三方旁证，但不能当效果证据。

**缺的一环**：迟滞（hysteresis）。未采集到任何系统给出「进入/退出阈值不同」的实现；可行的最小版本是「上调需 `net≥2`、回落需 `net≤−3`」，但这是设计选择，无文献支持。

---

## 5. 评测：哪些能用、哪些对编码 agent 不适用

### 5.1 CharacterEval（唯一有硬相关性数字）

arXiv:2401.01275v2，https://arxiv.org/html/2401.01275v2
- 4 维 13 指标：§5.1 对话能力 Flu./Coh./Cons.；§5.2 角色一致性 KE/KA/KH/PB/PU；§5.3 角色吸引力 HL/CS/ED/Emp.；§5.4 personality back-testing（MBTI 准确率，54 个角色 ground MBTI，§6.2）。
- 数据：1785 段多轮对话、77 角色、12 标注者、5 分制。
- 人机相关性（Table 2）：CharacterRM（Baichuan2-13B-base）Overall Pearson **0.631**；GPT-4 1-shot 0.362 / 2-shot 0.385 / 3-shot 0.375。
- 附录 A 明说 GPT-4 作 judge 有 self-enhancement bias（引 Zheng 2023）。
- §6.6 + Figure 4：多数模型随轮次推进性能下降 → **长对话一致性衰减**是普遍现象，不是个例。

### 5.2 MT-Bench / LLM-as-judge 的上限

arXiv:2306.05685v4 摘要（https://arxiv.org/abs/2306.05685）：GPT-4 judge 与受控/众包人类偏好一致度 **>80%**，与人与人一致度同级；同时列出 position / verbosity / self-enhancement 三种 bias。→ judge 可替代人工做**相对比较**，但不适合做绝对阈值门禁。

### 5.3 PersonaChat（不适用）

arXiv:1801.07243v5 摘要：以 profile 条件化，评测靠 **next utterance prediction**（检索式命中）与「从对话反推 profile」。指标测的是「下一句能否猜中」，与代码任务无关。

### 5.4 对编码型 agent 不适用 / 替代

不适用：MBTI back-testing（我们没有角色 ground MBTI，且 MBTI 自评本身不稳）、Flu./HL/CS/Emp.（聊天吸引力）、PersonaChat Hits@1。
替代（我的提议，非文献）：
1. 客观门禁（`typecheck-gate` + `vitest`）作为「人格不损害正确性」的下界——注意 persona-null-effect 说明它**不会**因此上升；
2. 可计算风格量：Markdown 标题数、加粗数、表格行数、平均句长、每轮字数（直接对应红线）；
3. 身份自报一致率（问「你是谁」，答的是不是卡里的名字）；
4. 注入可观测性（`section-read` 与 `turn-append` 两条日志都在）——这是前提，不是指标。

---

## 6. 反面证据

1. **人格提示不提升客观表现**：arXiv:2311.10054v3（Findings of EMNLP 2024，https://arxiv.org/abs/2311.10054）：162 角色 / 6 类人际关系 / 8 领域 / 4 模型族 / 2410 道事实题；加 persona 相对无 persona **无提升**；按题选最优 persona 能提升但自动挑不出（常不优于随机）；结论 "the effect of each persona can be largely random"。→ 人格只能在风格/关系/边界上被评测，不要拿正确率当 KPI。
2. **谄媚**：arXiv:2310.13548v4 摘要（https://arxiv.org/abs/2310.13548）：5 个 SOTA 助手在 4 类自由文本任务上一致谄媚；人类偏好数据与 preference model 都更偏好「迎合用户观点」「写得像对」的答案；对 PM 优化会以真实性换谄媚。→ 若把「用户满意」当漂移奖励信号，人格会向谄媚收敛；漂移信号只能来自事件票。
3. **注入衰减**：CharacterEval Fig.4（长对话一致性下降）+ 指令漂移 Fig.3A/Fig.4（注意力随轮次衰减、会采纳对方 system prompt）。
4. **「数字被模型忽略 / 数值化人格有害」**：**未采集**到直接对照实验。最接近的只有两条间接证据（人格提示零效应、注入随轮次衰减）。

---

## 7. 三个可以直接用的参数

1. **事件强度改成加权乘法**：`强度 = importance(0..10, d=3) × certainty(0..1, d=1) × proximity(0..1, d=1) × surprise(1..3, d=1)`，缺失取默认，再 `tanh` 进 `±1`（Elliott & Siegle 1993 "Ranges and Defaults" + Figure 2）。它可以直接替换 `tanh(net/3)` 里的「票数」，让「一票强事件」与「三票弱事件」可比。
2. **保留 `α=0.02` / `MAX_STEP=0.05` / `L1=0.5`，新增时间窗归一**：净票按 7 天滚动窗口统计，而不是按「本轮新增」累计（推导自「计数门槛无时间维」的缺口，非文献结论）。
3. **评测口径**：LLM judge 只做相对比较，取 CharacterRM 的 0.631 作为「judge 代人工」的相关性上限参考；红线用可计算风格量，绝对阈值门禁用客观门禁。

---

## 8. 未采集清单（不要当成通过）

- Fleeson 2001 原文 PDF、逐项组内变异数值（仅 PMC 转引）
- DeYoung 2007 十个 aspect 名称与 BFAS 题项；NEO-PI-R 30 facets 原文
- ALMA / Gebhard 2005 的衰减函数具体常数、PAD 坐标公式（PDF 抓取空）
- Mehrabian 1996 Big Five↔PAD 回归系数（PDF 超时）
- Zep 双时态（valid/invalid）字段与失效规则细节（仅摘要级）
- StableMind 的门槛数值与实验数字（摘要无数字，单作者预印本）
- 「数值化人格注入被忽略/有害」的直接对照实验
- 任何针对 **coding agent** 的人格保真 benchmark（未找到，可能不存在）