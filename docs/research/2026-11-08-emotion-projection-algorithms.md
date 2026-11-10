# 情绪层算法的一手文献依据：PAD ↔ 离散标签、聚合、衰减

调研日期：2026-11-08
调研范围：ALMA（Gebhard 2005）、WASABI（Becker-Asano 2008）、EMA（Marsella & Gratch 2009）、Cathexis（Velásquez 1997）、Mehrabian PAD 八分区
调研方式：只读。已下载并全文检索的 PDF 见 §附录 A。**未改任何代码、未连数据库、未 commit。**

标记约定：
- 【原话】= 论文原文，可直接引用，附出处。
- 【表格】= 论文中的表/图数值，我照抄。
- 【推断】= 我基于原文的推理，不是论文说的。
- 【未采集】= 查过但没拿到，§9 汇总。

---

## §0 一页结论

**推荐**：离散标签**不要**从 PAD 反推。保持「appraisal 结构 → 标签」（EMA/OCC 式规则表），PAD 只承担 mood 与强度/注入；若确实需要软映射，只允许 **WASABI 式带激活/饱和半径的距离隶属**（每个标签有自己的半径，超出半径返回「无标签」），并且 **dominance 轴权重置 0**、24 个模板的 D 轴按 ALMA 表 2 的极性重新标定（负性情绪必须 D<0）。

**一句话理由**：查到的四篇一手文献里，没有任何一篇用「维度反推标签」来定情绪；方向全是反的——ALMA 是 24 个 OCC 情绪 → PAD 的单向手工表（论文自己说缺的用相似情绪补），WASABI 的 dominance 由认知层（BDI）显式给、论文明确写「从动力学分量原则上推不出来」，EMA 明确写标签只是便利、真正决定应对的是 appraisal 变量的配置，Cathexis 则是并行 proto-specialist 过阈值。我们现在的「余弦 argmax」在文献里没有对应做法。

**最大风险**：标签与 PAD 一旦解耦，库里会出现自相矛盾的行（例如 label=自豪 而 valence 为负、或 label=愧疚 而 dominance=0.6）。任何按「label 与 PAD 一致」假设写的下游（注入文本、面板、排序）都会读到坏数据。所以解耦必须同时落 §7.5 的不变量 I1/I2。

**次大风险**：我们那 24 个中文模板的 D 轴全部 ≥ 0.2（`MemoryCore/src/core/soul/emotion.ts:144-199`），而 ALMA 的 24 个 OCC 情绪 D 值**大多为负**（Fear −0.43、Distress −0.5、Shame −0.6、Remorse −0.6）。这不是「参数没调好」，是模板表本身把「负性情绪 = 高支配」写错了极性。任何映射在这样一张表上都会塌到少数几个标签。

---

## §1 ALMA（Gebhard 2005）：mood 与 emotion 怎么映射、怎么衰减

出处：Patrick Gebhard, *ALMA – A Layered Model of Affect*, AAMAS'05（Utrecht），DOI `10.1145/1082473.1082478`，PDF `https://alma.dfki.de/papers/aamas05.pdf`（已下载全文，`/tmp/alma/alma05.txt`）。OpenAlex：2005，被引 417。

### 1.1 PAD 空间与 mood 的命名：八分区，只看符号

【原话】"The implementation of the PAD mood space uses axes ranges from -1.0 to 1.0 for each dimension."

【原话】"A mood octant stands for a discrete description for a mood, which is defined by three trait values pleasure, arousal, and dominance."

【表格】表 1 的八个 mood octant（P/A/D 符号 → 名字）：

```
+P +A +D  Exuberant
+P +A -D  Dependent
+P -A +D  Relaxed
+P -A -D  Docile
-P -A -D  Bored
-P -A +D  Disdainful
-P +A -D  Anxious
-P +A +D  Hostile
```

**关键点**：ALMA 给 mood 命名用的是**三个轴的符号**，不是最近邻、不是余弦、不是距离。这一点 WASABI 的转述可以交叉验证：【原话，WASABI p.35 引 Gebhard 2005 p.31】"According to Gebhard (2005), eight types of mood can be distinguished and identified with the eight octants of PAD space."

**对我们的直接含义（推断）**：符号法只有 8 个桶，且要求三个轴都能取到正负两侧。我们的数据 dominance 恒在 0.6 附近（正），因此符号法永远只能落进 4 个 octant——这已经从结构上解释了「人人都匹配同一个标签」。

### 1.2 mood 的强度：到原点的范数，除以 3，分三档

【原话】"We define the strength of a current mood by its distance to the zero point of the PAD mood space (algebraically: the norm of the PAD vector). While using a three dimensional space with maximum absolute values of 1.0, the longest distance in a mood octant is 3. To use no numbers for describing strength, we divide the longest distance into three parts and call them: slightly, moderate, and fully."

【原话，举例】mood 值为 0.25 / −0.18 / 0.12 时报告为 "slightly relaxed"。

```
strength = sqrt(P^2 + A^2 + D^2) / 3        # 归一到 [0,1]，3 = sqrt(3) 被近似成 3
档位     = slightly if strength < 1/3
         moderate if strength < 2/3
         fully    otherwise
```

注意论文把 `sqrt(3)≈1.732` 直接写成 3（PAD 各维最大绝对值 1.0 时的最长距离），是论文里的近似；【推断】照抄会让强度整体偏小约 1.73 倍，实现时应显式写明用的是 3 还是 sqrt(3)。

### 1.3 emotion → PAD：单向手工表，没有反推

【原话】"not for all 24 emotion types provided by the EmotionEngine exist a mapping into the PAD space. Those that lack a mapping we carefully provide the missing pleasure, arousal, and dominance values by exploiting similarities to comparable emotion types. Table 2 shows the mapping we currently rely on."

【表格】表 2（OCC emotion → P, A, D），我照抄了全部 24 行，只列实现会用到的：

```
Admiration     0.50   0.30  -0.20
Anger         -0.51   0.59   0.25
Disliking     -0.40   0.20   0.10
Disappointment-0.30   0.10  -0.40
Distress      -0.40  -0.20  -0.50
Fear          -0.64   0.60  -0.43
FearsConfirmed-0.50  -0.30  -0.70
Gloating       0.30  -0.30  -0.10
Gratification  0.60   0.50   0.40
Gratitude      0.40   0.20  -0.30
HappyFor       0.40   0.20   0.20
Hate          -0.60   0.60   0.30
Hope           0.20   0.20  -0.10
Joy            0.40   0.20   0.10
Liking         0.40   0.16  -0.24
Love           0.30   0.10   0.20
Pity          -0.40  -0.20  -0.50
Pride          0.40   0.30   0.30
Relief         0.20  -0.30   0.40
Remorse       -0.30   0.10  -0.60
Reproach      -0.30  -0.10   0.40
Resentment    -0.20  -0.30  -0.20
Satisfaction   0.30  -0.20   0.40
Shame         -0.30   0.10  -0.60
```

【原话】论文自己没有做 PAD → 情绪标签的反向映射。这一点我全文检索确认：只有 "mood octant"（符号命名）与上表的单向映射。

**这张表和我们的模板表对比（关键发现）**：

| 负性情绪 | ALMA 的 D | 我们的 D |
|---|---|---|
| Fear / 不安 | **−0.43** | +0.30 |
| Distress / 失落 | **−0.50** | +0.25 |
| Shame / 愧疚 | **−0.60** | +0.25 |
| Remorse / 悔 | **−0.60** | +0.25（委屈 0.35） |
| Anger / 恼火 | +0.25 | +0.60 |

【推断】我们的模板把「恐惧/羞耻/痛苦」的支配感写成了正值，方向与 ALMA 相反。这不是精度问题：它让所有模板挤在 +D 半边，cosine 在 +D 半边的锥体里几乎无法区分。

### 1.4 多个 active emotion 怎么合成 mood：virtual emotion center + pull/push

【原话】"It first computes the virtual emotion center of all currently active emotions in the PAD space by using the above mapping. The virtual emotion center represents a point in the PAD space and has an intensity that is the average of all active emotions' intensity. Its maximum intensity is 1.0. If no active emotions exist, no virtual emotion center exists and the current mood is not influenced by active emotions."

【原话】"If the current mood position is between the PAD space's zero point and the virtual emotion center, the current mood is attracted towards the virtual emotion center. This is called pull phase. If the current mood is beyond (or at) the virtual emotion center the current mood is pushed away, further into the current mood octant in which the mood is located."

```
# virtual emotion center（ALMA）
C_pad = mean(PAD_i for i in active)          # 位置：平均【推断，见 §9-2】
C_int = mean(intensity_i for i in active)    # 强度：算术平均，上限 1.0（论文原话）
# mood 更新：pull / push
if |M| < |C|  and  M 在原点与 C 之间:  M ← M + k * C_int * (C - M)
else:                                  M ← M + k * C_int * (M - origin 方向)
```

【未采集】论文没有写 virtual emotion center 的位置是否按强度加权（原话只对 "intensity" 说了 average）。见 §9-2。

### 1.5 ALMA 的 decay：配置里是 linear、20000ms、500ms 步进

【原话，图 3 的配置原文】

```xml
<AffectComputation>
  <EmotionDecay time="20000" period="500" function="linear"/>
  <EmotionBaseline threshold="0.4"/>
  <MoodReturn time="600000" period="500"/>
  <MoodRelations>
    <EmotionRelation name="Admiration" p="0.5" a="0.3" d="-0.2"/>
    <EmotionRelation name="Anger" p="-0.51" a="0.59" d="0.25"/>
    ...
  </MoodRelations>
  <PersonalityRelations> ... </PersonalityRelations>
  <RealtimeOutput enable="true" period="500"> ... </RealtimeOutput>
</AffectComputation>
```

【原话】"The intensity of emotions underlies a natural decay, which can be configured by several decay functions."

【原话】"Each appraisal of an action, event or object, lets the EmotionEngine generate an active emotion that once generated, is decayed over a certain amount of time (for example, 1 minute)."

**论文内部矛盾（原样记录，不做调和）**：
1. 正文说情绪衰减 "for example, 1 minute"，配置写 `EmotionDecay time="20000"`（20 秒）。
2. 正文说 "Our character's usual mood change time is 10 minutes."，紧接着说 "We take the longest distance of a mood octant (3) for defining the mood return time. Currently this is 20 minutes."，而配置写 `MoodReturn time="600000"`（10 分钟）。

【未采集】`x_end` 与 `log(0.004)` 这两个常数：**在 AAMAS'05 全文里不存在**。我对 `/tmp/alma/alma05.txt` 做了 `grep -n -E "x_end|0\.004|log\("`，零命中。它们若存在于 ALMA 的 Java 实现（`AffectComputation` / `EmotionDecay` 的实现类）而非论文里，本调研没有取得该源码——见 §9-1，并给出自证方法。

【推断，标注清楚】`0.004` + `log` 的组合在工程上的典型用法是「在 `x_end` 时间内衰减到初值的 0.4%」：

```
intensity(t) = intensity0 * exp( log(0.004) * (t - t0) / x_end )
```

这与「半衰期」是同一族（都是指数），换算关系 `halfLife = x_end * ln(2) / ln(1/0.004) ≈ x_end * 0.1166`。**但这是推断，不是 ALMA 论文说的**；落地前必须去实现源码里核（§9-1 给了检索指令），核不到就当未采集，别写进注释冒充文献。

---

## §2 WASABI（Becker-Asano 2008）：appraisal 怎么落到 PAD 动力学

出处：Christian Becker-Asano, *WASABI: Affect Simulation for Agents with Believable Interactivity*, 博士论文，Universität Bielefeld，2008-03-14 提交。PDF `https://www.becker-asano.de/Becker-Asano_WASABI_Thesis.pdf`（已下载全文 5018035 字节，`/tmp/lit/wasabi.txt`）。OpenAlex：2008，被引 86，无 DOI，落地页 citeseerx `10.1.1.227.56`。实现源码：`https://github.com/CBA2011/WASABIEngine`（未逐行核，只记录存在）。

### 2.1 最重要的一条：WASABI 主动放弃了「连续 dominance」

【原话，p.30 附近】"In this thesis the two dimensions pleasure/valence and arousal/activation are modeled to range from -100 to +100 on a continuous scale. The values for the dominance dimension, however, usually do not significantly differ from zero in Table 2.4 and the interpretation of this dimension's meaning is particularly controversial. Therefore, it is decided to abstain from modeling this dimension on a continuous scale in PAD space."

【原话，p.89-90】"The independent parameter of dominance (or, in the other extreme, submissiveness) cannot be derived from the dynamic component of the emotion module itself. ... It is in principle not possible to derive such information from the dynamic component. The BDI interpreter within the cognitive module of Max, however, is capable of controlling the state of dominance."

**这两句是我们问题的直接文献答案**：dominance 不是从情绪信号里估出来的连续量，而是**由认知/评价层显式给的二值状态**（高支配 / 低支配平面）。WASABI 的 PAD 表里 D 只有 ±100 两个取值（见 2.2 表）。我们现在的 `dominance` 是从模板抄来的连续值、且恒偏正，正是 WASABI 明确说要避免的做法。

### 2.2 emotion → PAD：9 个 primary 是点，secondary 是带强度的多边形区域

【原话，p.82-84，表 4.1】"The seven facial expressions of MAX corresponding to the eight primary emotions and the neutral state 'concentrated' are shown in Figure 4.1. The primary emotion's locations in Figure 4.1 result from the final PAD triples 'PAD final' in Table 4.1 ... These coordinates are derived from the values given in (Russell & Mehrabian 1977, p. 286ff)."

【表格】表 4.1 的 PAD final（−100..100 尺度），共 9 个 primary（happy 占 4 个点）：

```
angry        (-80,  80,  100)
annoyed      (-50,   0,  100)
bored        (  0, -80,  100)
concentrated (  0,   0, -100)  ×2
depressed    (  0, -80, -100)
fearful      (-80,  80, -100)
happy        ( 80,  80,  100)  ┐
happy        ( 50,   0,  100)  │ happy 共占 4 个点
happy        ( 80,  80, -100)  │
happy        ( 50,   0, -100)  ┘
sad          (-50,   0, -100)
surprised    ( 10,  80, -100)  ×2
```

> 【取证说明】PDF 文本层里 `±100` 的负号会被 pdftotext 吃掉（原文出现 `�100` 这种替换符），所以上表的符号位是**用 Listing 6.2 的源码级数值反推校正的**：`fearful -0.8 0.8 -1`、`angry -0.8 0.8 1`、`depressed 0 -0.80 -1`、`happy 0.8 0.8 1 / 0.5 0 1 / 0.8 0.8 -1 / 0.5 0 -1`。也就是说，**表 4.1 的原始符号我没有逐格可信地采到**；本报告只在「D 只有 ±100 两值」这一点上使用表 4.1（这一点在文本与 Listing 6.2 两处一致）。

【原话，p.138-140，初始化文件 Listing 6.2 的行格式】"Each line represents all data necessary for a primary emotion according to the format: `<name> <P-value> <A-value> <D-value> <facialExpr> <saturationThresh> <activationThresh> <baseIntensity> [decayFunction]`"，数值例如：

```
fearful     -0.8  0.8  -1  MOOD_FEARFUL   0.2  0.64  0.25  LINEAR
angry       -0.8  0.8   1  MOOD_ANGRY     0.2  0.64  0.75  LINEAR
sad         -0.5  0.0  -1  MOOD_SAD       0.2  0.64  0.75  LINEAR
happy        0.8  0.8   1  MOOD_FRIENDLY  0.2  0.64  0.75  LINEAR
surprised    0.1  0.8   1  MOOD_SURPRISED 0.3  0.64  0.00  LINEAR
```

（注意这里坐标换成 −1..1，而表 4.1 是 −100..100；论文两种尺度混用，见 §9-3。）

### 2.3 PAD → 标签：距离 + 激活/饱和阈值斜坡（这是文献里唯一的「维度反推标签」做法）

【原话，p.90-91】"In principle the awareness likelihood of a primary emotion `pe` increases the closer the point of reference gets to it. If the point of reference is getting closer than `σ_pe` units to that particular emotion `pe` (see Figure 4.4), the calculation of its awareness likelihood `w_pe` is started according to Equation 4.5 until the distance `d` gets below `ρ_pe` units."

【公式，Equation 4.5】

```
w_pe = 1 - (d - ρ_pe) / (σ_pe - ρ_pe)     对 ρ_pe < d < σ_pe
w_pe = 1                                  对 d <= ρ_pe
w_pe = 0                                  对 d >= σ_pe
```

【原话，p.90】"In Equation 4.5, `σ_pe` can be interpreted as the activation threshold and `ρ_pe` as the saturation threshold, which can be adjusted for every primary emotion `pe` independently."

【原话，p.139】"The two thresholds were set to the same values for each (primary) emotion (`ρ_pe`=0.2 and `σ_pe`=0.64) so far. For the final empirical study ... the saturation threshold for surprise is now set to 0.3."

【原话，p.91】"In case of primary emotions that are represented in PAD space more than once (i.e. concentrated, happy, and surprised) the representation with the minimum distance to the reference point is considered in Equation 4.5."

**这套机制对我们的价值**：它是**带拒绝的隶属函数**，不是一个全局 argmax。`d ≥ σ` 直接给 0（「此刻没有这个情绪」），`d ≤ ρ` 才给满。WASABI 用 `ρ=0.2 / σ=0.64` 在 −1..1 的 PAD 上，也就是**半径 0.2~0.64**——一个有量纲的、每标签可调的球形邻域。

### 2.4 多个情绪同时存在：各自独立，取最大只用于表情

【原话，p.145】"In ... Figure 6.6 two awareness likelihoods are reported simultaneously (i.e. concentrated with a likelihood of 0.255682 and happy with a likelihood of 0.75). So far, however, only the primary emotion with the highest likelihood is driving MAX's facial expressions, although the Emotion-Agent distributes all available information as a vector of emotion/likelihood pairs to the other agents by means of message communication."

【原话，p.160，作者自述局限】"The mood congruency of all elicited emotions is always assured by the emotion dynamics component ... This entails, however, that some plausible mixtures of emotions, such as fear and joy occurring at the same time ... are impossible within the architecture."

→ **WASABI 不做「多情绪聚合成一个数」**：它保留一个 `(label, likelihood)` 向量，只在需要单一表情时取 argmax。这是与 ALMA 最大的工程差异。

### 2.5 WASABI 的衰减：固定 lifetime + 回落到 baseIntensity

【原话，p.140，表 6.6】

```
NONE        : 不衰减；lifetime 到期后强度重置为 <baseIntensity>
LINEAR  f1  : 强度线性下降，直到 lifetime 到期；到期后重置为 <baseIntensity>
EXPONENTIAL f2: 强度指数下降，直到 lifetime 到期；到期后重置为 <baseIntensity>
```

【原话，p.140】"a primary emotion's lifetime is 10.0 by default"；"If this parameter is omitted, the decay function is set to type NONE."

【原话，p.94】"a secondary emotion's lifetime parameter (set to 10.0 by default) together with its decay function (set to linear by default) are used to decrease its intensity over time until the standard intensity is reached again."

```
# WASABI 的衰减：固定寿命，不是半衰期
I(t) = I0 * (1 - (t - t0)/lifetime)             # LINEAR，t0 <= t < t0+lifetime
I(t) = I0 * exp(-k*(t - t0)/lifetime)           # EXPONENTIAL（论文没给 k 的取值 → §9-4）
I(t) = baseIntensity                            # t >= t0 + lifetime
```

**注意一个语义疑点**：primary 情绪的 `baseIntensity` 默认是 0.75（fearful 0.25、surprised 0.0），secondary 情绪默认 0.0。若 `baseIntensity` 是「触发后的起始强度」而非「回落到的最低值」，则「重置为 baseIntensity」意味着情绪不会消失——这与 secondary=0.0 才是我们要的行为。【未采集】论文没写清 baseIntensity 的语义，见 §9-4。

### 2.6 mood 的动力学：质量-弹簧，不是 EMA / 不是指数

【原话，p.87-88】"The implementation of emotion dynamics is based on the assumption that an organism's natural, homeostatic state is characterized by emotional balance ... Therefore, two independent spiral springs are simulated, one for each axis, which create two reset forces Fx and Fy whenever the point of reference is displaced from the origin."

【公式，Equation 4.1】`y' = a · x`（情绪效价 x 作为 mood 效价 y 的变化梯度）

【公式，Equation 4.2】`z(t+1) = z(t) - b`（boredom，在原点 ε 邻域内线性增长，值域 [−1, 0]）

【原话，p.88】"The mass-spring model was chosen based on the heuristics that it better mimics the time course of emotions than linear and exponential functions. This assumption is supported by Reisenzein (1994), who showed that in most cases the intensity of emotions in the two dimensional Pleasure-Arousal theory is not decreasing linearly but more according to a sinus function."

【表格，p.139，Listing 6.1 的实际参数】

```
xTens 50     # 情绪效价的弹簧常数
yTens 10     # mood 效价的弹簧常数（比 xTens 小，因为 mood 变化更慢）
slope 500    # 情绪对 mood 的相互影响系数（= 式 4.1 的 a）
mass  5000   # 参考点的惯性质量
xReg 1 / yReg 1   # boredom 的 ε 邻域
boredom 50   # boredom 的时间因子（= 式 4.2 的 b）
```

【原话，p.86-87】"The variable a in equation 4.1 can be interpreted as a personality-related aspect modeling an agent's temperament. Smaller values of a result in a more lethargic agent and greater values of a lead to a more temperamental agent."

### 2.7 WASABI 与 ALMA 的差异（逐条）

| 维度 | ALMA | WASABI |
|---|---|---|
| dominance | 连续，−1..1 | **不连续，高/低支配二值平面，由 BDI 给** |
| 情绪表示 | 24 个 OCC 情绪的点（手工表） | 9 个 primary 点 + 3 个 secondary 多边形区域 |
| PAD→标签 | **没有反推**；mood 用八分区符号命名 | 有：距离 + `ρ/σ` 斜坡给 awareness likelihood |
| 多情绪 | 聚合为 virtual emotion center | 不聚合，保留向量；argmax 只用于表情 |
| 衰减 | linear / 20000ms（配置） | NONE/LINEAR/EXP，固定 lifetime=10s，回落 baseIntensity |
| mood 动力学 | pull/push 向量 | 双弹簧 + 惯性质量（正弦族，非指数） |

【原话，WASABI p.88，对 ALMA 一类做法的定位】"Most traditional approaches (cf. Chapter 3) start with symbolic reasoning to derive appropriate emotions, calculate their intensities and then solve the problems of concurrently activated, potentially contradicting emotions and the decay of their intensities." —— 这句正好把 ALMA/EMA/Cathexis 归为一类，把 WASABI 自己的「动力学优先」归为另一类。

---

## §3 OCC 与 EMA：标签由 appraisal 结构决定，不是维度反推

出处：Stacy C. Marsella & Jonathan Gratch, *EMA: A process model of appraisal dynamics*, **Cognitive Systems Research 10 (2009) 70–90**，`doi:10.1016/j.cogsys.2008.03.005`（Received 15 Oct 2007 / accepted 31 Mar 2008 / online 5 Jul 2008）。PDF 镜像 `https://people.ict.usc.edu/~gratch/CSCI534/Readings/COGSYS-RS-EMOTION-2008-6.pdf`（已下载全文，`/tmp/lit/ema.txt`，15959 词）。

OCC 原书（Ortony, Clore & Collins 1988）**未采集**（没有合法免费全文）；下文的操作化来自 EMA 表 2，属于二手，已在 §9-5 标注。

### 3.1 结论句：标签是便利，配置才是本体

【原话】"We assign symbolic labels (e.g., hope, joy fear) to appraisal frames, however the label is primarily a convenience (e.g., it facilitates the mapping of appraisal patterns to facial expressions) and it is the specific configuration of appraisal variables determines the agents coping responses."

【原话】"specific emotions are associated with certain configurations of these criteria"（criteria = appraisal 维度）

【原话】"In EMA, we support a two-level notion of emotional state - appraisal and mood."

→ **标签由 appraisal 变量的结构决定，不由连续维度反推。** EMA 里根本没有 PAD 维度。

### 3.2 判定标签的变量表（表 2「Mapping from appraisal pattern to emotion label」）

【表格】逐行照抄（`p` = 命题）：

```
Expectedness(self,p) = low                                   → Surprise
Desirability(self,p) > 0    & Likelihood(self,p) < 1.0       → Hope
Desirability(self,p) > 0    & Likelihood(self,p) = 1.0       → Joy
Desirability(self,p) < 0    & Likelihood(self,p) < 1.0       → Fear
Desirability(self,p) < 0    & Likelihood(self,p) = 1.0       → Sadness
Desirability(self,p) < 0    & Causal attribution(self,p) = other
                            & Controllability(self,p) = low  → Anger
Desirability(other,p) < 0   & Causal attribution(p) = self   → Guilt
```

【原话，脚注 5】EMA 自己说明这套映射已偏离 OCC 原版、把 controllability 并了进来，并指向 Gratch & Marsella 2005 的评测。

**注意这张表与我们的 `pickTemplate` 是同构的**（`MemoryCore/src/core/soul/emotion.ts:412-470`）：都是「几个 appraisal 变量取阈值 / 取极性 → 一个标签」的 if 链。这不是巧合，OCC 家族都是这个形状。我们的问题不在「用规则」，而在**同一时刻既用规则选标签、又用余弦从 PAD 反推标签，两套互相矛盾**。

### 3.3 六个 appraisal 变量的定义（原话）

```
Desirability     : "the value of the proposition to the agent ... can be positive or negative"
Likelihood       : "If the state is in the past or present, this will be zero or one ...
                    If the state is in the future, this indexes the likelihood"
Expectedness     : "the extent to which the truth value of a state could have been predicted"
Causal attribution: "who deserves credit/blame"
Controllability  : "can the outcome be altered by actions under control of the agent"
Changeability    : "can the outcome be altered by some other causal agent"
```

**与我们的字段对照（推断）**：`goalRelevance` ≈ Desirability 的强度，`expectationViolation` ≈ 1 − Expectedness，`agency` ≈ Causal attribution，`control` ≈ Controllability，`normCompatibility` 在 EMA 表 2 里**没有对应变量**（norm 属 OCC 的 standards 分支，EMA 表 2 未操作化）。这条对照关系是推断，不是论文原话。

### 3.4 intensity 与 mood 聚合

【原话，强度】"the intensity of a threat is a function of the likelihood of the threat times the utility of the goal that is threatened"

→ 乘法结构：`intensity ≈ likelihood × goalUtility`。我们现在的 `(0.55*goalRelevance + 0.45*expectationViolation) * normFactor * exposure` 是**加法**结构（`emotion.ts:347-355`）。这是与 EMA 的实质差异，但 EMA 只给了这一句定性描述，没有给出完整公式与常数（【未采集】完整形式，见 §9-6）。

【原话，mood 聚合】"The representation of the mood state is currently represented as a set of emotion labels (e.g., Hope, Joy, Fear, etc.) with an [0..1] intensity that is a function of all appraisal frames with the corresponding type. For example, if EMA has several appraisal frames labeled with hope, the intensity of these frames are added and passed through a sigmoid function to map them into the range of zero to one, and serve as the hope component of the mood state."

```
# EMA 的同类聚合：求和 → sigmoid 压到 [0,1]
mood[c] = sigmoid( Σ_{f : label(f) = c} intensity(f) )
```

→ **累加后压缩**，不是取最大、不是加权平均。论文没给 sigmoid 的具体参数（【未采集】§9-6）。

【原话，mood 反馈】"the mood-adjusted intensity of this frame is X + Mood(hope)"；"EMA applies a mood adjustment to individual appraisal frames"

【原话，焦点选择】"the appraisal frame that determines coping is the most recently accessed appraisal frame with the highest mood-adjusted intensity."

【原话，多 frame 并存】"EMA maintains multiple appraisal frames (one for each proposition in the causal interpretation) each of which are labeled with a specific emotion type and intensity, and each competing to determine the agent's coping response."

【原话，一帧可出多个标签】"In some cases, the same frame might generate multiple emotion labels. For example, an unexpected and beneficial outcome would elicit both joy and surprise."

---

## §4 categorical ↔ dimensional 的双向映射：文献里到底有什么

### 4.1 查到的四种做法（按可操作性排序）

**(a) 单向手工表（ALMA）**：24 个 OCC 情绪 → PAD 点，见 §1.3。**没有反向**。

**(b) 符号八分区（Mehrabian / ALMA mood）**：三个轴取符号 → 8 个桶，见 §1.1。要求三轴都能取到正负。

**(c) 距离 + 激活/饱和半径（WASABI）**：`w = 1 − (d−ρ)/(σ−ρ)`，`d≤ρ` 给 1，`d≥σ` 给 0，逐标签独立半径，见 §2.3。这是文献里唯一一个「给定连续维度 → 给离散标签（还带拒绝）」的可执行方法，并且**同一时刻允许多个标签共存**。

**(d) 显式规则表（EMA / OCC / Cathexis）**：标签完全由 appraisal 结构或阈值触发，不经过连续维度，见 §3.2 与 §5.2。

### 4.2 余弦相似度 argmax：文献里没有

我对 ALMA、WASABI、EMA、Cathexis 四篇全文做了 `grep -i -E "cosine|similarity|angle|nearest neighb"`：
- `cosine`：**四篇零命中**。
- `angle`：零命中。
- `similarity`：只出现在定性语境——Plutchik 的「基本情绪之间的相似度」（WASABI 转述，p.25 附近）、以及 WASABI 自己「缺 PAD 值的情绪按相似性补」（§1.3 同一句）。没有一处是做向量余弦。
- `nearest neighb`：零命中（WASABI 的 `min distance` 表述见 §2.3，用的是距离不是余弦）。

【未采集】我没找到任何一篇把「标签向量与 PAD 向量做余弦、取最大」当作情绪命名方法的论文。

【推断，数学层面的原因】余弦只看方向、丢掉模长。我们的模板 `emotion.ts:144-199` 里 D 全部落在 [0.20, 0.75]、V 落在 [−0.6, 0.7]、A 落在 [0.10, 0.75]，24 个向量全部指向「V 或正或负、A 中高、D 正」的一个窄锥体；把三维向量归一后，这个锥体的张角很小，任意查询点与所有模板的 cos 都在 0.9 以上是必然的。这与你实测的三条一致（0.974 / 0.990 / 0.972）。

把实测三条算一下就能看出「方向无差别」：

```
平静 (0.3,0.4,0.6)   |x|=0.781 归一 → ( 0.384, 0.512, 0.768)
自豪 (0.65,0.5,0.75) |x|=1.111 归一 → ( 0.585, 0.450, 0.675)   cos = 0.974
恼火 (-0.5,0.4,0.6)  |x|=0.877 归一 → (-0.570, 0.456, 0.684)
同情 (-0.3,0.35,0.4) |x|=0.610 归一 → (-0.492, 0.574, 0.656)   cos = 0.990
```

注意「恼火 → 同情」这一对：两者的 V 都是负、A 都在 0.35-0.46、D 都为正，归一后**几乎平行**（cos 0.990）。也就是说，在 D 恒正的子空间里，一个愤怒的点会被告知它「最像同情」——不是因为阈值没调好，而是因为这两个情绪在我们的表里本来就只差在 V 的绝对值和 A 的细微差别上。**这不是阈值 0.6 调不调的问题，是把 D 轴当连续量用的必然结果。**

### 4.3 「dominance 恒偏高、各轴被压缩」时什么映射才不会退化

三条，按证据强度排序：

**第 1 条（有文献直接支持）**：**别让 dominance 当连续特征用**。WASABI 明确不建模连续 dominance，改成由认知层给的高/低支配二值平面（§2.1）。落到我们身上：D 轴从距离里**剔除**（权重 0），或按 `control` 二值化（`control ≥ 0.5 → +`，否则 `−`）。

**第 2 条（有文献直接支持）**：**用逐标签半径 + 拒绝**，不要全局 argmax。WASABI 的 `ρ/σ` 让「不像任何标签」成为合法输出（§2.3）。我们的 `labelFromPad` 现在必定返回一个标签（全零才返回 `''`），结构上不允许「没有情绪」。

**第 3 条（推断，无直接文献）**：**按数据定轴权重 / 各轴 z-score**。WASABI 用的是各轴等权的欧氏距离（在 −1..1 的尺度上），ALMA 的强度用范数（隐含等权）。如果我们的各轴方差差别巨大（dominance 方差≈0），等权距离就等于让 dominance 噪声主导。**没有任何一篇论文讨论「轴方差不均时怎么定权」**——这是工程推断，必须靠 §8 的校准数据定，不能引文献。

**关于「每个类别当带协方差的高斯」**：【未采集】我没找到把类别建成 PAD 上带协方差高斯、并用 Mahalanobis 距离判属的论文。这是常见工程做法，但本调研不能给它挂文献。若要采用，只能标为工程选择，并用 §8 判据证明有效。

### 4.4 一个必须承认的边界

我们的 24 个中文标签（平静、委屈、释然、欣慰…）**不对应任何一篇文献的标签集**：ALMA 是 24 个 OCC 情绪（Admiration/Anger/…），WASABI 是 9 个 primary + 3 个 secondary，EMA 表 2 只有 7 个。所以「我们的 24 个模板的 PAD 坐标从哪来」这个问题，**文献给不出答案**——它只能靠标注数据或心理学量表（如 Russell & Mehrabian 1977 的单词 PAD 常模）来定，而后者我没有取得全文（§9-7）。

---

## §5 多情绪并存与聚合：三套做法、三种取舍

### 5.1 ALMA：聚合成一个 virtual emotion center（位置平均 + 强度平均，上限 1.0）

见 §1.4 原话。摘要：

```
C_pad = mean(PAD_i)                 # 位置【推断：平均，未明说是否加权】
C_int = mean(intensity_i)           # 强度：算术平均
C_int = min(C_int, 1.0)             # 上限 1.0（论文原话 "Its maximum intensity is 1.0"）
mood  ← pull(C_pad) 或 push(C_pad)  # 由 mood 与 C 的相对位置决定
```

**「上限 1.0」是明确的**（原话）。**「取最大 vs 加权中心」：ALMA 取的是中心，不是最大**。

### 5.2 Cathexis（Velásquez 1997）：并行 proto-specialist + 兴奋/抑制增益 + 饱和阈值

出处：Juan Velásquez, *Modeling Emotions and Other Motivations in Synthetic Agents*, **AAAI-97**，AAAI 技术报告/论文集。PDF `https://cdn.aaai.org/AAAI/1997/AAAI97-002.pdf`（已下载，6 页，`/tmp/lit/cathexis.txt`）。

【原话】"All of these emotion proto-specialists run in parallel and are constantly updating their intensities. No particular proto-specialist is in control of the system. In fact, more than one may be active (i.e. have intensity values above zero) at the same time. Nonetheless, when their intensity value goes above the α threshold they may inhibit or excite other proto-specialists."

【原话】"Associated with each proto-specialist are two threshold values. The first threshold, α, controls the activation of the emotion. ... The second threshold, σ, specifies the level of saturation for that emotion proto-specialist. This is consistent with real life emotional systems in which levels of arousal will not exceed certain limits."

（取证说明：AAAI PDF 的 σ 符号在文本层被抽成字母 `a`，正文出现 "The second threshold, a ..."。`σ` 是我按同段后文 "saturation value" 与上下文复原的，标点与词序保持原样。）

【公式，Equation (1)，PDF 排版把符号打散，我按正文说明复原】

```
I_e(t) = ψ_e( I_e(t-1) )
       + Σ_k E_ke                      # 该情绪的各个 elicitor 的贡献
       + Σ_l G_le * I_l(t)             # 其他情绪对它的兴奋增益
       - Σ_m H_me * I_m(t)             # 其他情绪对它的抑制增益
I_e(t) = clamp(I_e(t), 0, σ_e)         # "constrains the intensity of Emotion e between 0 and its saturation value"
```

【原话，逐项定义】"`I_et` is the value of the intensity for Emotion e at time t; `I_e(t-1)` is its value at the previous time step; `ψ_e` is the function that represents how Emotion e decays; `E_ke` is the value of Emotion Elicitor k ... `G_le` is the Excitatory Gain that Emotion l applies to Emotion e ... `H_me` is the Inhibitory Gain ..."

→ **Cathexis 是「同类累加 + 饱和截断」**：同一情绪的多个 elicitor **相加**进同一个 `I_e`，然后夹在 `[0, σ_e]`。不是新实例并存。

【原话，行为选择】"At some point in time, the behavior with the highest value becomes the active behavior."；"The value of a behavior is modeled as the sum of the values of each of all Behavior Releasers relevant to that particular behavior." → **聚合取最大** 只发生在「行为」层，不在「情绪」层。

### 5.3 WASABI：不聚合，保留向量

见 §2.4。多个 `(label, likelihood)` 并存；单值只在表情选择时取 argmax。

### 5.4 我们现在的 `integrateMood`：第四种做法

`MemoryCore/src/core/soul/emotion.ts:586-637` 做的是**强度加权平均**：

```
priorWeight = 2^(-dt / moodHalfLifeHours)
priorValence = baseline + (valence - baseline) * priorWeight
wSum = priorWeight + Σ decayedIntensity(e)
next = (priorValence*priorWeight + Σ e.valence*decayedIntensity(e)) / wSum
```

这是「先验 + 证据的加权平均」，与 ALMA（位置算术平均、强度算术平均）、Cathexis（同类求和截断）、WASABI（不聚合）都不同。**它不是错的**，但要注意两点：
1. 加权平均的**输出会被拉向多数派**：9 条情绪里 8 条略负、1 条强正，mood 仍然是负的。若你想让「强情绪压过多数弱情绪」，加权平均做不到，需要 Cathexis 式取最大或 ALMA 式 pull/push。
2. 它与 `activeEmotions` 的「取最大」读数（`:555-564`、`:543-552`）**并存**，等于同一时刻有两个 mood 口径。这是「单一归属」的红线问题（一条状态、一个来源），建议保留一个。

---

## §6 衰减与叠加：文献里到底怎么做的

### 6.1 衰减形状：四篇里没有一篇用「半衰期」

| 系统 | 衰减形式 | 参数 | 出处 |
|---|---|---|---|
| ALMA | **linear**（配置可换） | `time="20000"` ms，`period="500"` ms，`function="linear"` | 图 3 配置原文 |
| WASABI | NONE / LINEAR / EXPONENTIAL | `lifetime` 默认 10.0 s，到期回落 `baseIntensity` | 表 6.6，p.140 |
| Cathexis | 每情绪一个 `ψ_e()`，形式自定义 | 论文明确说「可以是一个时间常数，也可以是更复杂的函数」 | Eq.(1) 说明 |
| EMA | 论文未给衰减公式 | — | 【未采集】§9-6 |

【原话，Cathexis】"In Cathexis, each emotion proto-specialist has been provided with a built-in decay function that controls the duration of the emotion once it has become active. This function is specific to each emotion proto-specialist which allows for different models of emotion decay. That is, the decay function for an emotion can be implemented as a constant of time or as a more complex function of the different elicitors for that particular emotion."

【原话，Cathexis，对「衰减研究稀缺」的自述】"If the concept of emotion intensity has received little attention, the concept of emotion decay has received much less. Perhaps this is why most previous models of emotion, with the exception of that proposed by Reilly [Reilly, 1996], do not consider this issue. With the current evidence on this matter one can only speculate as to what causes emotions to decay and what are the mechanisms and the systems involved in this process."

→ **「半衰期」不是文献口径**，`2^(-dt/halfLife)`（`emotion.ts:473-484`）是我们自己的工程选择。它与 WASABI 的 EXPONENTIAL 同族，但语义不同：WASABI 是「固定 lifetime 内衰到 baseIntensity 然后停」，我们是「无限期按半衰期衰减」。两者可换算，但不能互相冒充出处。

【转引，形状依据】WASABI p.88 转引 Reisenzein (1994)：情绪强度在 Pleasure-Arousal 二维理论里「不是线性下降，更接近正弦」。**Reisenzein 1994 原文未采集**（§9-8），所以这条只能作为「WASABI 选择弹簧模型的理由」引用，不能作为「正弦衰减是唯一正确形状」的依据。

### 6.2 同一对象短时间重复触发：三种不同答案

**(A) 新实例并存 —— ALMA**

【原话】"Each appraisal of an action, event or object, lets the EmotionEngine generate an active emotion that once generated, is decayed over a certain amount of time (for example, 1 minute)."

→ 每次 appraisal 生成一个**新的** active emotion，各自独立衰减；不是重置计时、不是累加。它靠 virtual emotion center 把多个实例平均掉（§1.4）。

**(B) 累加后截断 —— Cathexis**

【公式】Eq.(1) 的 `Σ_k E_ke` 项：同一情绪的多个 elicitor 直接相加进同一个 `I_e`，再 `clamp(0, σ_e)`。

**(C) 衰减到 baseIntensity / 重置 —— WASABI**

【原话】"The intensity decreases linearly over time until the emotion's lifetime is expired; then the intensity is reset to `<baseIntensity>`."

→ 到期**重置**。但「再次触发时强度设为多少」论文没写（【未采集】§9-4）。

**结论（我们的选择建议）**：
- 若关心「情绪被反复刺激会不会越来越强」：Cathexis 的累加+饱和是唯一有公式的答案。
- 若关心「情绪衰减后残留多少」：WASABI 的 baseIntensity 是唯一有参数名的答案。
- 若关心「同一条消息连说三遍会不会变成三倍」：ALMA 的「新实例并存 + 平均」能自然抑制（三条相同情绪平均后仍是同一个值，只是衰减曲线变成三段）。

**给我们的建议**：【推断，非文献】保留「新实例并存」（与 ALMA 一致、与现实现有 `emotion_events` 表结构一致），但把 mood 聚合从「强度加权平均」改成 ALMA 式「位置算术平均 + 强度算术平均」，因为后者的输出不会随事件数量漂移（平均对重复实例不敏感）。同时给每个 label 一个 `maxInstancesPerWindow`（例如同 label 同 object 同 10 分钟内最多 3 条），防止刷屏把 mood 拉爆——这条是工程约束，不是文献要求。

---

## §7 给我们的落地公式（伪代码级，常数标注出处）

**前提**：以下所有 `path:line` 指向当前工作树。本调研未验证这些行在 HEAD 之后是否漂移。

### 7.1 决策：删除「PAD → 标签」这条路径

```ts
// MemoryCore/src/core/soul/emotion.ts
// 现状：labelFromPad() :253-273 + EMOTION_LABEL_MIN_COS = 0.6 (:222) 在写入路径被调用
// 目标：写入路径只用 pickTemplate()（appraisal 规则表），labelFromPad 不再参与落库
//
// 依据：§1.3（ALMA 无反向映射）、§2.3（WASABI 的距离+半径，不是余弦）、
//      §3.1（EMA：label 只是便利，配置才是本体）

function decideLabel(a: AppraisalVector): { label: string; score: number; evidence: string } {
  // 保持现有 if 链结构（与 EMA 表 2 同构），但返回命中的那条规则名作为 evidence
  // score 用命中规则的强度（例如 goalRelevance * (1 - |expectationViolation - 该规则期望值|)）
  // PAD 不参与
}
```

**为什么要留 `labelFromPad` 但不调用**：面板/调试可能还想看「按 PAD 最像哪个」，但**不能**让它的输出落库。若要彻底删，按「删净主义」把 `:222`、`:253-273`、`:289-303` 与相关测试一并删；若保留，加注释写明「仅调试，禁止写入路径调用」。

### 7.2 dominance 轴：从 appraisal 显式给，不从模板抄

```
# 依据：WASABI p.89-90「dominance 从动力学分量原则上推不出来，由认知层控制」
#       + 表 4.1 的 D 只有 ±100 两值（高/低支配平面）

control = a.control                    # 0..1，已在 appraisal 里
dominance =
    +1.0   if control >= 0.5           # 高支配（有掌控）
    -1.0   otherwise                   # 低支配（被情境支配）

# 若必须连续（为了注入文本的细腻度）：
dominance_continuous = 2*control - 1   # ∈ [-1, 1]，与现有 padUnit 的 [0,1] 换算一致
```

【推断】`2*control-1` 是我选的线性映射，WASABI 只说「BDI 控制 dominance 状态」，没给公式。**这条必须写进注释标为工程选择。**

### 7.3 模板表的 D 轴重标定（这是修「人人都匹配一个标签」的前提）

依据：ALMA 表 2 的极性（§1.3）——负性情绪 D 必须为负。

```
# 规则（不是具体数值，具体数值由 §8 的校准脚本产出）
规则 1：valence < 0 的标签，dominance ∈ [-0.7, -0.1]
        （锚点：ALMA Fear -0.43 / Distress -0.50 / Shame -0.60 / Remorse -0.60 / Disappointment -0.40）
规则 2：valence > 0 且 agency=self 的标签（自豪/欣慰/笃定），dominance ∈ [0.2, 0.5]
        （锚点：ALMA Pride +0.30 / Gratification +0.40 / Satisfaction +0.40）
规则 3：valence < 0 且 agency=other 的标签（恼火/烦躁），dominance ∈ [0.1, 0.4]
        （锚点：ALMA Anger +0.25 / Hate +0.30 / Reproach +0.40）
规则 4：valence ≈ 0 的标签（平静/意外），dominance 可正可负，但不能与规则 1/2 的簇重叠
```

**这条会改动 24 个模板里至少 10 个的 D 值**，且会改 `EMOTION_TEMPLATE_VERSION`（`:320`）。这是必要代价：现在的表让「愧疚」和「自豪」在 D 轴上同号，任何映射都无法分开它们。

### 7.4 若仍要软映射：WASABI 式半径隶属（带拒绝、D 轴剔除）

```
# 依据：WASABI Eq.4.5 + p.90 的 ρ/σ 定义 + p.139 的取值

axisWeight = { v: 1.0, a: 1.0, d: 0.0 }     # D 权重 0：依据 §2.1（WASABI 不建模连续 D）
                                            # 若 §8 校准显示 D 有区分力，再回调到 0.25（现 rankLabelsByPad 的值，:289-303）

d(label, x) = sqrt( w_v*(x.v - t.v)^2 + w_a*(x.a - t.a)^2 + w_d*(x.d - t.d)^2 )

sigma_label = 0.5 * min_{other} d(label, other)   # 每标签的激活半径 = 到最近邻标签距离的一半
rho_label   = 0.4 * sigma_label                   # 饱和半径（WASABI 的 0.2/0.64 ≈ 0.31 比例，四舍五入取 0.4）

membership(label, x) =
    1.0                          if d <= rho_label
    1 - (d - rho)/(sigma - rho)  if rho < d < sigma
    0.0                          if d >= sigma_label

labels = { l : membership(l, x) > 0 }             # 允许为空 = 「没有明显情绪」
```

【推断】`sigma_label` 用「到最近邻距离的一半」是我提的校准规则（保证相邻标签的隶属区不重叠），WASABI 是**所有标签用同一对 0.2/0.64**。我改这个的理由：我们的 24 个模板密度不均，统一半径会让密集区的标签互相吞掉。**这条无文献支持，属工程推断，§8 判据 C 会证伪它。**

### 7.5 不变量（写入前必须过）

```
I1. label 与 PAD 极性一致
    sign(valence) == sign(template(label).valence) 且 |valence| >= 0.05 时不得为 0
    # 依据：§0 最大风险。标签与 PAD 解耦后必须显式校验，否则下游读到自相矛盾的行
I2. 负性标签的 dominance <= 0
    # 依据：ALMA 表 2 的极性与 §7.3 规则 1
I3. 同一 session 内 label 不得在同一毫秒重复落库（幂等键 = session+label+object+minute）
    # 依据：§6.2 的「新实例并存」会把刷屏变成刷量；工程约束
```

### 7.6 intensity：保持乘法中的加法核，但补齐 EMA 的「效用 × 可能性」语义

```
# 现状 emotion.ts:347-355
intensity = clamp01( (0.55*goalRelevance + 0.45*expectationViolation) * normFactor * exposure )

# 依据：EMA 的定性式 "intensity of a threat is a function of the likelihood of the threat
#       times the utility of the goal that is threatened"（§3.4）
# 建议：把加法核换成乘法核，但保留 normFactor 与 exposure 作为调制
intensity = clamp01( goalRelevance * (0.5 + 0.5*expectationViolation) * normFactor * exposure )
```

【推断】`(0.5 + 0.5*EV)` 是我为了让 EV=0（完全预期内）仍有半强度而选的偏置；EMA 只给了 `likelihood × utility` 的定性式，没有常数。**这是工程选择，§8 判据 D 会检查它是否让 intensity 分布塌缩。**

---

## §8 校准与验证方案（含可证伪判据）

**本调研不碰库**，所以下列脚本要由实现方在自己的只读副本上跑。判据全部写成「跑出来是 A 还是 B」，不是「看起来合理」。

### 8.1 轴权重校准（用现有生产行，只读取）

```sql
-- 目的：证明 dominance 轴是常数，从而证明它在距离里应当被剔除
SELECT
  COUNT(*)                              AS n,
  AVG(dominance)                        AS mean_d,
  MIN(dominance)                        AS min_d,
  MAX(dominance)                        AS max_d,
  -- SQLite 没有 stddev，用 E[x^2]-E[x]^2
  SQRT(AVG(dominance*dominance) - AVG(dominance)*AVG(dominance)) AS sd_d
FROM emotion_events
WHERE created_at >= :since;
```

判据 A（可证伪）：`sd_d < 0.05` → dominance 是常数，**必须**把它从距离里剔除（`w_d = 0`）。若 `sd_d >= 0.15`，则 dominance 有区分力，`w_d` 可取 0.25（现值）。**两种结果都改变实现，不存在「都能接受」的中间态。**

### 8.2 阈值校准（`ρ/σ` 用数据定，不用 0.2/0.64 硬套）

```
for each label:
    d_nn = min over other labels of d(label, other)      # 模板间最近邻距离
sigma_label = 0.5 * d_nn
rho_label   = 0.4 * sigma_label
# 全局自检
assert min(sigma_label) > 0.05     # 太小 = 模板挤在一起，先修模板
assert max(sigma_label) < 1.5      # 太大 = 一个标签吞掉半个空间
```

判据 B（可证伪）：若 `min(sigma_label) < 0.05`，说明**模板表本身不可分**，此时任何映射都会退化——必须先做 §7.3 的 D 轴重标定，再回来校准。这条把「映射算法」和「模板表」两个故障源分开了。

### 8.3 退化检测（直接回答「不再人人匹配同一个标签」）

```
inputs : 生产 N 条真实行（N >= 9，建议 N >= 100）
outputs: 每条行的 label

metrics:
  distinct_ratio = |distinct(label)| / N
  top1_share     = max_count(label) / N
  entropy        = -Σ p(label) * log p(label)
```

判据 C（可证伪，三选二即通过）：

```
C1  distinct_ratio >= 0.30         # 至少三成的行给出不同的标签
C2  top1_share     <= 0.50         # 没有任何一个标签占据一半以上
C3  entropy        >= 1.0          # 自然单位，约等于 2.7 个等概率标签
```

**反例（必须记录的基线）**：改之前先用现实现的余弦 argmax 在 9 条生产行上跑一遍同样的三个指标，把 `distinct_ratio / top1_share / entropy` 的数值写进报告。**没有这个基线，「改完不再退化」这句话无法验证**——你只能证明新实现看起来不退化，不能证明它比旧的好。已知的定性事实是：三条样例全部错配（平静→自豪、恼火→同情、笃定→踏实），所以旧实现在「准确率」这个维度上已经是 0/3。

判据 D（可证伪）：**D 轴扰动测试**。

```
for each row:
    label0 = map(x)
    for noise in [-0.1, +0.1]:
        label1 = map(x with d += noise)
    record changed
assert changed_rate <= 0.10
```

若 `changed_rate > 0.10`，说明映射仍依赖 D 轴（而 D 轴对方差≈0 的常数做了噪声放大），判据 A 的结论被推翻，回退。

### 8.4 标签与 PAD 的一致性（往返检验）

```
for each label:
    p = template(label).pad
    labels_back = map(p)
assert label in labels_back                # label → PAD → label 必须回到自己
```

判据 E（可证伪）：`P(label → PAD → label 命中自己) >= 0.90`（24 个里至少 22 个）。**注意这条检验的是「表与映射自洽」，不是「映射正确」**——一个自洽但偏离人类的表也能过。所以要同时跑 §8.5。

### 8.5 与人的判断对齐（唯一能证「有意义」的判据）

需要标注：从生产里抽 50~100 条 episode，人工只标「此刻最像哪个中文标签」（给 24 个选项 + 「都不像」）。

```
判据 F：top1 准确率 >= 0.60，且「都不像」被正确识别的比例 >= 0.50
判据 G：混淆矩阵中，最大的一对混淆（label_a ↔ label_b）占比 <= 0.25
```

判据 F 的 0.60 是工程门槛，**不是文献给的门槛**（文献里没有这个数）。它的作用是让「改完了」这件事可被反驳：达不到 0.60 就说明映射还是不成立，不能靠「看起来合理」放行。

### 8.6 不可证伪的说法（禁止写进验收）

- 「情绪更自然了」——没有判据。
- 「cos 阈值调到 0.5 就好了」——阈值不是根因（§4.2 已算过，方向本身无区分力）。
- 「单测全绿」——单测只证明代码按你写的规则跑，不证明规则对（这是本仓库 AGENTS.md 的既有口径）。

---

## §9 未采集清单

| # | 未采集项 | 我做了什么 | 影响 | 怎么补 |
|---|---|---|---|---|
| 1 | ALMA 的 `x_end` / `log(0.004)` 常数 | 对 AAMAS'05 全文 `grep -nE "x_end\|0\.004\|log\("`，零命中；未取得 ALMA Java 实现源码 | §1.5 的衰减公式只能用论文的 linear/20000ms | 去 ALMA SDK（`AffectComputation` / `EmotionDecay` 实现类）里搜 `0.004`；或问 Gebhard 本人。**核不到就永久标未采集，不要把它写成文献结论** |
| 2 | ALMA 的 virtual emotion center 位置是否强度加权 | 读了 §1.4 的原文两段，只对 intensity 说了 average | §5.1 的 `mean(PAD_i)` 是推断 | 查 `Mood`/`EmotionCenter` 实现类，或 ALMA 后续论文 |
| 3 | WASABI 的 `ρ=0.2 / σ=0.64` 单位 | 论文点坐标用 −1..1（Listing 6.2），表 4.1 用 −100..100，阈值未标单位 | §7.4 的半径不能直接照抄 | 读 `WASABIEngine` 源码里距离的实际计算尺度 |
| 4 | WASABI 的 `baseIntensity` 语义与「再次触发的初值」 | 论文只说到期 reset 到 baseIntensity；primary 默认 0.75 与「情绪会消失」矛盾 | §6.2(C) 与 §7 的回落值不能照抄 | 同上，读源码；或直接采用 secondary 的 0.0 |
| 5 | OCC 原书（Ortony, Clore & Collins 1988）全文 | 未找到合法免费全文 | §3.2 的变量表是 EMA 的操作化，不是 OCC 原版 | 图书馆/出版社；或继续用 EMA 表 2 并标注二手 |
| 6 | EMA 的 intensity 完整公式、sigmoid 参数、衰减公式 | 全文搜过，只有定性句 | §3.4、§6.1 的 EMA 列只能写「未给」 | 查 Gratch & Marsella 2005 的评测论文（EMA 表 2 脚注 5 指向它） |
| 7 | Russell & Mehrabian 1977 的 PAD 单词常模（p.286ff） | 未取得原文；只有 ALMA/WASABI 的转抄 | §4.4 的「24 个中文标签的 PAD 从哪来」无一手依据 | 该文在 *Journal of Research in Personality* 11(3), 1977；或改用 Warriner et al. 2013 的 13,915 词 VAD 常模（也未取得） |
| 8 | Reisenzein 1994（正弦衰减）原文 | 只有 WASABI p.88 的转引 | §6.1 的「正弦」只能作转引 | 查 *Cognition & Emotion* 相关卷 |
| 9 | Cathexis 的 `ψ_e()` 具体形式 | 论文明确说「可以是常数也可以是复杂函数」，即**故意不给** | §6.2(B) 只能给结构不能给参数 | 无解——论文就是没给，属设计留白 |
| 10 | 「类别 = PAD 上带协方差的高斯」的论文出处 | 用 `domain_search openalex` 搜过，返回的三篇都不是；`s2` 引擎 429 | §4.3 第 3 条只能是推断 | 换 Semantic Scholar API 配额后重试，或直接放弃挂文献、标为工程选择 |
| 11 | Cowen & Keltner 的 27 类情绪研究（想用来论证「2-3 维不足以还原类别」） | OpenAlex 关键词搜不到该篇 | §4.2 的「维度不足以还原类别」目前只有我们自己的实测支撑 | 直接搜 DOI `10.1073/pnas.1702247114`（PNAS 2017），未验证是否可访问 |

---

## 附录 A：本次实际下载并全文检索的一手材料

| 材料 | 本地路径 | 字节 | 来源 URL | 元数据 |
|---|---|---|---|---|
| ALMA (Gebhard 2005) | `/tmp/alma/alma05.pdf` → `alma05.txt` | — | `https://alma.dfki.de/papers/aamas05.pdf` | DOI `10.1145/1082473.1082478`，AAMAS'05，OpenAlex 被引 417 |
| WASABI (Becker-Asano 2008) | `/tmp/lit/wasabi.pdf` → `wasabi.txt` | 5018035 / 495432 | `https://www.becker-asano.de/Becker-Asano_WASABI_Thesis.pdf` | 博士论文，2008-03-14，OpenAlex 被引 86，无 DOI |
| EMA (Marsella & Gratch 2009) | `/tmp/lit/ema.pdf` → `ema.txt` | — / 15959 词 | `https://people.ict.usc.edu/~gratch/CSCI534/Readings/COGSYS-RS-EMOTION-2008-6.pdf` | *Cognitive Systems Research* 10:70–90，`doi:10.1016/j.cogsys.2008.03.005` |
| Cathexis (Velásquez 1997) | `/tmp/lit/cathexis.pdf` → `cathexis.txt` | 3462405 / 30055 | `https://cdn.aaai.org/AAAI/1997/AAAI97-002.pdf` | AAAI-97 Proceedings，6 页 |

**取证过程中踩过的坑（供后来者省时间）**：
- `domain_search` 的 `s2` 引擎返回 `HTTP 429 from api.semanticscholar.org`，全程不可用。
- ScienceDirect 直连 403；EMA 改从 `people.ict.usc.edu` 镜像取得。
- MIT DSpace 的 Cathexis bitstream 返回 429（拿到的是 1515 字节 HTML）；改从 `cdn.aaai.org` 取得真 PDF。
- `curl` 在 Windows/schannel 下报 `CRYPT_E_REVOCATION_OFFLINE`，需加 `--ssl-no-revoke`（但本次对 `dspace.cuni.cz` 仍超时，未取得）。
- 用 `ops_bash` 起后台 `curl` 会被工具返回时杀掉，导致 PDF 截断；必须前台 + 长 `timeoutMs` + `curl -C -` 续传。WASABI 就是在被截断到 335872 字节后用续传补到 5018035 字节才可读。
- 中文市场下 `bing` 引擎对英文论文查询多次返回 0 结果并回退；`advanced_search engine=exa` 可用。
