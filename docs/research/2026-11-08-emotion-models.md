# 情绪怎么算：可落地的模型选型（2026-11-08）

范围：为 td-agemem 的 `soul_emotions` / `soul_state` 选一套「底层连续、表面离散」的算法。
方法：论文用 pdftotext 实读；代码用 `gh api` 取源码，快照在 `scratch/research/emotion/`。
标注约定：`[实读]` 读全文；`[仅摘要]` 只读到摘要；`[转载]` 仅经他人论文/配置转述。

## ① 结论

1. 底层用 **PAD 三维连续空间**（pleasure/arousal/dominance，各 −1..1）当唯一的情绪状态表示，24 个标签降级为「锚点投影」——写侧算连续向量，标签只是离它最近的可读名。
2. 24 个标签**已有公开坐标**：ALMA 官方配置里 24 条 `EmotionRelation` 就是 (p,a,d) 三元组，可直接照抄，见 ④。
3. 情绪与心境**必须两套时间常数**：情绪 τ=小时级（实证中位 2h/5h，见 ③），心境 τ=天级；ALMA 的「mood 10 分钟回位」是分钟级，与我们 48h 差两个数量级，两者都不是实证数，选哪个由用途决定。
4. 衰减用**指数**（ALMA `ExponentialDecayFunction` 就是指数），配一个**地板**（`EmotionBaseline threshold`），到地板即视为「已回基线」——这正是我们「<0.05 到期」的同类做法，但我们的 6 个半衰期太长（见 ③ 的算术）。
5. 同一对象重复触发**不要覆盖，要并存实例**：ALMA 与 EMA 都是多条 emotion 实例共存、在渲染/心境层聚合；覆盖会丢掉「复发但未修复」这一信息。
6. 该丢的：**互斥枚举 + 单一 label 必填**。它是「24 标签零实例」最可疑的成因——一个 24 选 1 的字符串字段，任何一次没命中词表就整行丢失，而连续向量没有「词表外」这种失败态。
7. appraisal 变量里，**目标一致性/预期性/责任者/可控性**只能靠 LLM 估；对象、时间、否定、显式情绪词可以确定性抽。LLM 在**连续维度**上可用（EmoBank VAD 回归 PCC 0.764），在**细粒度分类**上不可靠（GoEmotions 27 类 macro-F1 仅 0.375，低于微调 BERT 的 0.521）。
8. 我方 6 轴特质（α=0.02、单步 ≤0.05）与本方案同构：都是「有界惯性 + 目标吸引」。但 α=0.02 时单步最大位移 0.04，`≤0.05` 的钳位**永远不触发**，它现在是装饰性的（见 ⑥）。

## ② 模型对照表

| 模型 | 变量 | 公式/机制（编号参数） | 出处 |
|---|---|---|---|
| OCC (Ortony-Clore-Collins 1988) | 三类世界：目标(goals)/标准(standards)/态度(attitudes)；变量 desirability、praiseworthiness、appealingness、期望偏差、agency | 无连续公式：情绪类型 = 变量取值的**分支判定**（22 类），强度 = 各变量取值的局部强度（全局强度由 OCC 未给出闭式） | 书目 https://doi.org/10.1017/cbo9780511571299 ，2022 二版 https://doi.org/10.1017/9781108934053 ；结构与类型清单经 ALMA/EMA 转载 [转载] |
| PAD / Mehrabian 三维 | pleasure(P)、arousal(A)、dominance(D)，各 −1..1 | 无动力学；给的是「情绪词 ↔ PAD 坐标」的静态映射。Big Five→PAD 线性式：P=0.21E+0.59A+0.19N；A=0.15O+0.30A−0.57N；D=0.25O+0.17C+0.60E−0.32A | ALMA 论文 p.2 与配置 `alma-AffectComputation.aml:68-70`（原文 Mehrabian 1996 未读，[转载]）https://alma.dfki.de/papers/aamas05.pdf ；三维理论原始出处 https://doi.org/10.1016/0092-6566(77)90037-X [转载] |
| ALMA (Gebhard 2005) | 三层：emotion(短)/mood(中, PAD)/personality(长, Big Five)；24 情绪类型、8 mood 类型、5 人格类型 | emotion 强度按可配置 decay 函数自然衰减（linear/exponential/tanh 三种实现）；mood = 所有 active emotion 在 PAD 的加权中心做 pull/push（当前 mood 在原点与中心之间→被拉向中心，越过→被推远）；mood 强度=到原点范数，分 slightly/moderate/fully | 论文 https://alma.dfki.de/papers/aamas05.pdf [实读]；24/8/5 数量 https://alma.dfki.de/ ；源码见 ③ |
| EMA (Marsella & Gratch) | 12 个 appraisal 变量：relevance；desirability；agency；blame/credit；likelihood；unexpectedness；urgency；ego involvement；controllability；changeability；power；adaptability | 强度 = **两个 appraisal 变量的乘积**：Hope=D(p)·L(p)（D>0,L<1）；Joy=D(p)·L(p)（D>0,L=1）；Fear=D(p)·L(p)（D<0,L<1）；Distress=\|D(p)·L(p)\|（D<0,L=1）；Anger=\|D(p)·L(p)\|（D<0 且归因 blameworthy）；Guilt=\|D(q)·L(p)\| | https://people.ict.usc.edu/~gratch/CSCI534/Readings/GratchMarsellaCOGSYS04.pdf ，doi:10.1016/j.cogsys.2004.02.002 [实读]，变量表在其 Table 1、规则在其 Table 3 |
| WASABI (Becker-Asano & Wachsmuth 2008) | primary emotion = PAD 空间中的连续「core affect」；secondary emotion = 对事件做认知推理后落点也在 PAD | **关键机制：先在 PAD 连续推进，之后才归类成离散情绪**；secondary emotion 用 PAD 中的合取义坐标保证 mood-congruent 唤起 | https://doi.org/10.1007/978-3-540-85483-8_2 [仅摘要] |
| Scherer CPM / SEC | 4 个检查序：relevance（novelty/pleasantness/goal relevance）→ implications（causal attribution/possible outcomes/goal conduciveness/urgency）→ coping（controllability/power/coping potential）→ normative（internal/external standards） | 无闭式强度公式；情绪标签与强度 = **SEC 组合模式**，且 SEC 是连续维度不是类别 | https://psu.pb.unizin.org/psych425/chapter/component-process-model-cpm/ （转述 Scherer 2001 p.94）[转载] |

**哪一个最适合「24 标签但底层连续」**：ALMA + WASABI 的组合。理由不是谁更"对"，而是两者恰好把我们要的两层拆开了——WASABI 明确「先连续、后归类」，ALMA 给出 24 个情绪类型在 PAD 里的**现成坐标表**和一套可配置 decay。OCC 留作**标签判定规则**的来源（它给的是变量→类型的分支，不是坐标），EMA 留作**强度公式**的来源（变量乘积，可解释、可单句渲染）。

## ③ 动力学参数表

| 项 | 数值 | 出处或说明 |
|---|---|---|
| 情绪自然衰减形态 | linear / exponential / **tanh** 三种可选，指数实现为 `newIntensity = exp(x·log(0.004)/x_end)·operatingRange + baseline`（即衰减到基准值的 0.4%） | `scratch/research/emotion/alma-ExponentialDecayFunction.java:55,112`；另见 `alma-LinearDecayFunction.java:110`、`alma-TangensHyperbolicusDecayFunction.java:116-117` |
| 情绪衰减到「零」的定义 | 指数式把终点定在 0.4% 残余，即 x_end = decaySteps × (intensity − baseline) | 同上 `:107,112` |
| 地板/基准 | `<EmotionBaseline threshold="0.4"/>`；强度低于 baseline 后不再参与 | `alma.txt:232-238`（论文 AffectML 样例）[实读] |
| 情绪更新周期 | 500ms（`period="500"`） | 同上 |
| 情绪衰减总时长（工程值） | 20000ms=20s（论文样例配置，非人类实证） | 同上 |
| mood 变化时间常数 | 「usual mood change time」=10 分钟；「mood return time」=20 分钟；配置样例 `MoodReturn time="600000"`（=10 分钟） | 论文 p.3 [实读]；配置 `alma-AffectComputation.aml` 之外的样例见 `alma.txt:232-238` |
| **人类情绪持续时间** | 27 种情绪，**首回基线中位 2h / 永久回基线中位 5h**（mean[log duration] 4.12 / 4.33）；最长=sadness，最短=shame、surprise、fear、disgust、boredom、being touched、irritation、relief；事件重要性与反刍解释近一半变异（r=.59/.57；r=.56） | Verduyn et al. 2015, Motiv Emot 39:119-127, https://doi.org/10.1007/s11031-014-9445-y [实读]（逐情绪中位数在 Fig.1，PDF 抽文把图轴压平，未逐条采用） |
| 情绪持续时间（另一组） | 只测 anger/sadness/joy/gratitude；持续时间与事件加工方式相关 | Verduyn et al. 2011, https://doi.org/10.1037/a0021239 [实读摘要与引言] |
| 心境半衰期（人类实证） | **未采集** | 检索未取得可引用的实证半衰期数字；ALMA 的 10/20 分钟与我们的 48h 都是工程选择 |
| 衰减是线性还是指数 | 心理实证未给函数形式；工程上指数更合「先快后慢」，ALMA 默认样例用 `function="linear"` | 论文样例 `alma.txt:232-238`；指数公式见上 |
| 同对象重复触发：叠加 or 覆盖 | **叠加（并存多条实例）**。ALMA 维护 active emotion 集合，mood 用「各 active emotion 强度均值（上限 1.0）作权重的 PAD 加权中心」聚合；EMA 每条情绪是独立实例 | ALMA 论文 p.3 [实读]；EMA §4.3 [实读] |
| 我们现有参数的算术核对 | τ=3h、地板 0.05 → `0.5^(t/3)=0.05` ⇒ t=**12.97h**；若地板抬到 0.1 ⇒ **9.97h**。相对 5h 中位「永久回基线」偏慢约 2.6 倍 | 本报告计算（基于上一行实证值） |

## ④ 24 标签 → 连续坐标的可行方案

**现成坐标（推荐直接用）**：ALMA 官方 `conf/AffectComputation.aml` 的 24 条 `EmotionRelation`，P/A/D 各在 [−1,1]，与 OCC 类型一一对应。快照 `scratch/research/emotion/alma-AffectComputation.aml:41-64`，来源 https://github.com/A-L-M-A/ALMA 。24 个类型的官方名单见 `alma-emotion-alma-occ-category-vocabulary.xml:5-32`（该文件注明：alma-occ 用 disliking 替换 hate、liking 替换 love，love/hate 作为复合情绪）。

注意两个来源有细微分歧：论文样例 AffectML（`alma.txt:236`）写 `Admiration p=0.5 a=0.3 d=-0.2`，而官方仓库配置写 `0.4/0.16/-0.24`。本表取**仓库配置**（新于论文），说明坐标表本身有 ±0.1 量级的漂移，锚点不是唯一真理。

| 标签 | P | A | D | 标签 | P | A | D |
|---|---|---|---|---|---|---|---|
| admiration | 0.40 | 0.16 | −0.24 | liking | 0.40 | −0.16 | −0.24 |
| anger | −0.51 | 0.59 | 0.25 | love | 0.30 | 0.10 | 0.20 |
| disappointment | −0.30 | −0.40 | −0.40 | pity | −0.40 | −0.20 | −0.50 |
| disliking | −0.40 | −0.20 | 0.10 | pride | 0.52 | 0.22 | 0.61 |
| distress | −0.50 | 0.62 | 0.38 | relief | 0.20 | −0.30 | −0.40 |
| fear | −0.64 | 0.60 | 0.43 | remorse | −0.30 | 0.10 | −0.60 |
| fears-confirmed | −0.50 | 0.30 | −0.70 | reproach | −0.30 | −0.30 | 0.30 |
| gloating | 0.30 | −0.30 | 0.10 | resentment | −0.20 | −0.30 | −0.20 |
| gratification | 0.60 | −0.30 | 0.40 | satisfaction | 0.50 | 0.42 | 0.47 |
| gratitude | 0.20 | 0.50 | −0.30 | shame | −0.30 | 0.10 | −0.60 |
| happy-for | 0.40 | −0.20 | −0.20 | hope | 0.20 | 0.20 | −0.10 |
| hate | −0.40 | −0.20 | 0.40 | joy | 0.50 | 0.42 | 0.23 |

**这张表暴露的关键问题：映射不是单射。** `remorse` 与 `shame` 的 PAD 完全相同（−0.30/0.10/−0.60），`anger`(0.25) 与 `hate`(0.40) 只差 D，`disliking`/`hate` 只差 D=0.1。所以：

- **PAD 三维不足以唯一反推 24 标签**，必须再带 1–2 个 appraisal 判别位（OCC 的分家就是 agency/blame：shame 与 remorse 的差别在「谁的责任」，不在情绪色彩）。建议存 `(p,a,d)` + `agency∈{self,other,circumstance}` 四元组；标签 = 最近锚点 + agency 约束。
- 标签应存为「投影结果」而非输入：写侧算连续向量，`label` 是渲染时 `argmax cos(v, anchor)` 的产物，允许为空（这样不会再有"词表外就丢行"）。
- 备用词表（若要做**文本侧**打分）：NRC-VAD（emotion word 级 V/A/D）、EmoBank（句子级 V/A/D 人工标注语料，https://github.com/JULIELab/EmoBank ）。GoEmotions 的 27 类名单可做标签对照（`scratch/research/emotion/goemotions-README.md:16-19`），但它是多标签分类体系、无坐标。
- 我实际**没有拿到 NRC-VAD 数据文件**（下载超时、zip 不完整），所以未做词级坐标核对，见 ⑦。

## ⑤ 输入可得性：确定性 vs LLM

| appraisal 变量 | 纯文本对话里的来源 | 可靠手段 |
|---|---|---|
| 对象 object、时间、是否否定、说话人 | 会话结构、实体、否定词 | **确定性**（正则/结构/事件表） |
| 显式情绪词（"我很烦"） | 词表命中 | **确定性**，但只覆盖显式表达（见下方 LLM 证据） |
| desirability（目标一致性） | 需要知道"我的目标是什么" | **必须 LLM**，或用户显式声明 |
| likelihood / unexpectedness | 需要事件先验与结果 | **必须 LLM**（可给区间） |
| agency / blame（责任者） | 谁做的、谁该被怪 | **必须 LLM**（shame vs remorse 只靠这个分） |
| controllability / changeability | 能不能改变、能不能补救 | **必须 LLM** |
| urgency / ego involvement | 时间压力、涉及自我程度 | **必须 LLM**（弱信号，建议只取粗档） |

LLM 判情绪的可靠性证据（都是实读数字，不是感觉）：

- GPT-4 zero-shot 对人工标注的 **macro-F1：ISEAR 0.739、SemEval 0.511、GoEmotions 0.375**（同设置微调 BERT：0.726 / 0.548 / **0.521**）。**细粒度分类上 LLM 不如微调小模型**。出处 https://arxiv.org/abs/2408.17026 第 5.1 节表格。
- 同一篇：在 **EmoBank 的 VAD 回归**上 GPT-4 **PCC 0.764**（BERT 0.321），MAE 0.645（BERT 0.442）。→ **连续维度比 27 选 1 可靠得多**。
- 人类评审更喜欢 GPT-4 的标注而非人类标注：ISEAR 62.3%、SemEval 68.2%、GoEmotions 71.1%。出处同上。这说明"与人工标注一致率低"不等于"错"，但也说明人工标注本身不是金标准。
- 人类自己的一致性也不高：GoEmotions 里 **94% 样本有 ≥2 名标注者在至少 1 个标签上一致，但只有 31% 有 ≥3 人一致**；83% 样本只拿到 1 个标签。出处 https://arxiv.org/abs/2005.00547 Table 2。
- 有的数据集里**全员一致率低于 10%**；多标签选项会进一步降低一致性。出处 https://arxiv.org/abs/2412.07906 （§II-B）。
- 分布层面：零样本 LLM 与人类标注**分布差异显著**，且"领域内微调、而非模型规模"才能补上这个差；LLM 能抓住带**显式词汇标记**的情绪，在需要语境推断的语用情绪上系统性失败（GoEmotions + EmoBank，64 万条 LLM 响应；后处理校准最多缩小 14% 差距）。出处 https://arxiv.org/abs/2604.27345 [仅摘要]

落到我们：**别让 LLM 直接吐 24 选 1 的标签**（0.375 量级的可靠性）。让它吐 `(valence, arousal, dominance, agency, confidence)` 这类连续/有序值，标签由坐标反查。

## ⑥ 我方最小改法

字段（只加不改，避免迁移）：

- `soul_emotions` 增 `pad_p / pad_a / pad_d REAL`（−1..1）、`agency TEXT`、`appraisal TEXT`（JSON，存 ⑤ 的 6 个变量原始值）、`confidence REAL`；`label` **列保留但允许 NULL**，语义降级为「投影名」。
- 新增 `soul_emotion_funnel(day, gate, cnt)`：记录「候选事件 / 过了对象抽取 / 过了 appraisal / 过了强度门槛 / 实际写入」五档计数。这是**唯一能把「零实例」归因到"没输入"还是"判据太严"的手段**，且不改现有写路径语义。

公式（写侧一次算完，读侧只衰减）：

- 强度衰减：`I(t) = floor + (I0 − floor) · 0.5^(Δt/τ)`，`floor=0.05`，`τ=3h`（提议先维持不动，只把「6 个半衰期」到期改为 **`I(t) < floor` 即到期**，等价于 12.97h；若要与 5h 中位对齐，把 τ 降到 1.5h ⇒ 6.5h 到期）。
- 多实例聚合（替代"同对象复发覆盖"）：`v_mood = Σ w_i·(p_i,a_i,d_i) / Σ w_i`，`w_i = I_i` 且 `min(Σw, 1)`，与 ALMA 的加权中心一致。
- 心境：`mood ← mood + α_mood(v_mood − mood)`，`α_mood` 由半衰期反推 `α = 1 − 0.5^(Δ/τ_mood)`；τ_mood=48h 时，按每轮 1 分钟记账 α≈2.4e−4，按每小时记账 α≈1.4e−2。
- 特质对齐：把 6 轴映射成 PAD 偏移 `trait_pad = M·traits`（M 用 ② 的 Big Five→PAD 系数作初值），渲染时 `affect_render = mood + β·trait_pad`，`β` 取 0.2–0.3 让特质是"色调"不是"内容"。此时情绪与特质**同一套数学**：都是 `x ← x + α(target − x)`，只是 τ 与 target 不同。
- 注意：α=0.02、域 [−1,1] 时单步最大位移 `0.02×2=0.04 < 0.05`，**「单步 ≤0.05」的钳位永不触发**。要么删掉它（承认真正的界是 α），要么把 α 提到 0.03 以上才需要这个守门。

渲染（多维 → 一句可读）：

1. 取 `top1 = argmax cos(affect, anchor_i)`，取 `top2`（若 `cos` 与 top1 差 < 0.1 则并列）；
2. 强度映射到三档词（slightly / moderately / strongly，阈值 0.2 / 0.5，与 ALMA 的 mood 强度三段一致）；
3. 句式：`<对象> 让我 <强度词+标签>` +（若 agency=self）`，因为我自己…`；
4. 24 标签里 `remorse/shame`、`anger/hate` 这类 PAD 重合对，用 `agency` 与 `appraisal.blame` 二选一，规则写死在渲染层，不让 LLM 决定。

## ⑦ 未采集清单

- Mehrabian 1996 原始论文（Big Five→PAD 系数的出处）**未读**：PDF 6.4MB 多次 120s 超时、疑扫描版。系数值来自 ALMA 论文与官方配置 [转载]。
- **NRC-VAD 词表数据未取得**：zip 下载超时、文件不完整（`unzip` 报 End-of-central-directory 错），未做 24 个词在 NRC-VAD 里的坐标核对。
- OCC 1988 原书**未读**：22 类情绪及其触发条件的原文表述未逐条核对，只有 ALMA/EMA 的转载版本。
- Scherer 2001 章节**未读**：SEC 清单引自公开教材对 p.94 的转述。
- WASABI **仅摘要**：其 PAD 动力学与归类阈值的具体参数未取得。
- **心境的实证半衰期未采集**：没有找到可引用的人类 mood 半衰期研究，48h 属工程选择。
- Verduyn 2015 的**逐情绪中位时长**（Fig.1）因 PDF 图轴被抽平，未逐条采用，只用了"最长=sadness、最短=8 类、中位 2h/5h"。

未采集：Mehrabian 1996 原文系数核对、NRC-VAD 词表数据、OCC 1988 原书 22 类触发条件原文、Scherer 2001 SEC 原文、WASABI 全文参数、人类心境实证半衰期、Verduyn 2015 逐情绪中位数。
