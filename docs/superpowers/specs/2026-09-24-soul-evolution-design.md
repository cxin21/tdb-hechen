# 灵魂演化层设计（DS-SOUL-EVOLUTION-001）——2026-09-17-soul-memory-design.md 补充

- 日期：2026-09-24
- 状态：设计定稿 v2（v1=2026-09-24 对话直出授权；v2=用户令「设计需结合已有的设计和实现，重点注意明确怎么提取、怎么维护、怎么生长、怎么使用、怎么召回、怎么展示」——逐机制补六链矩阵（§1.7/§2.7/§3.7）+既有实现接线清单（§7）+反耦合红线（§8）；全部机制缺省关断，启用逐期经 A/B 验收后呈报）
- 关联：`2026-09-17-soul-memory-design.md`（本设计的母 spec；本补充修订其 O14 裁决的适用边界，见 §3.4）、`2026-09-15-soul-pipeline-design.md`、v7 工作流 B/C
- 调研输入：Sentipolis（arXiv 2601.18027，PAD 三维情绪状态）、How Emotion Shapes the Behavior of LLMs and Agents（arXiv 2604.00005，情绪状态显著改变推理行为的机制实证）、Emergence of Self-Identity in AI（arXiv 2411.18530，自我同一性量化）、Emotional Memory for LLM Agents / AFT（2022-2026 综述）、Cognee/Zep/Mem0/Letta 2026 格式对比

---

## 0. 动机与设计原则

### 0.1 动机（对既有设计的三处第一性审视）

母 spec §1.1 定义灵魂公式：下一刻的你 = f(此刻的你, 过去的记忆, 当下的感受)。以功能判据（是否决定下一刻行动）审计现有实现，发现三处「声明与机制」的差距：

| # | 缺口 | 现状 | 差距 |
|---|---|---|---|
| G1 | 感受段的「当下」名实错位 | 感受段=主题锚 valence 静态聚合（锚为长期聚合结构，注入数周稳定不变） | 真正的「当下」应由近期经历的情感色调驱动；业界已将情绪做成 agent 状态变量（Sentipolis PAD），且机制实证情绪显著改变推理行为 |
| G2 | 品格缺「代价」维度 | P3 品格锚池已实现但零数据（休眠）；identity 记录承诺但不记录价值冲突下的抉择 | 品格只在两难抉择中显现；系统对「同价值反向行为」的张力实例无感知 |
| G3 | 身份缺「叙事」粘合 | self_identity=bulleted 事实清单；演化留痕仅 logger.info | 身份心理学的核心是叙事同一性（如何变成这样），事实枚举不构成连续的自我故事 |

### 0.2 设计原则（沿用母 spec 铁律，逐条适用）

1. config-first：三个机制全部缺省关断（enabled=false=逐位现状），启用=A/B 验收通过后呈报拍板；
2. 单一源：mood 聚合、张力检测、蒸馏门各只允许一份实现；
3. LLM 只提议、确定性门裁决：三机制中 LLM 仅在 §2.3 提案与 §3.2 叙事提议两处出现，落库全部经确定性门；
4. 主语三层法逐机制标注（§1.5/§2.5/§3.5）；
5. 宁缺毋滥：燃料不足则机制不启用（§2.4 止损条款）；
6. 行为变更硬标准：每期同种子 A/B ≥10 组，负增益诚实登记并回退。

### 0.3 概念立场（诚实边界）

本设计在功能层面处理"情绪/品格/叙事"——即「塑造下一刻行动的状态变量」。系统不宣称这些状态等同于人类的主观体验；注入文本对 LLM 的作用机制由 arXiv 2604.00005 的实证支撑（情绪状语显著改变推理分布），这是功能等价的依据，也是验收的对象。

---

## 1. S-FEEL-1 近期情绪基调行（感受段 v3 子行）

### 1.1 定义

近期基调 = agent 最近经历的确定性情感聚合，作为 soul-feeling 段的时间性补充行。它回答「此刻的我被最近的经历带向何种状态」，与价值锚行（长期取向）正交互补。

### 1.2 数据源与公式（单一源：mood-line.ts 新模块，MemoryCore/src/core/hooks/）

- 输入：L1 记忆 `valence`、`arousal` 列（已有，无 schema 变更），租户三元组硬隔离。
- 样本窗：occurred_at ≥ now − windowHours（缺省 72h），按 occurred_at 降序取 ≤ maxSamples（缺省 20）；样本数 < minSamples（缺省 5）→ 基调行省略（宁缺毋滥）。
- 加权聚合：`w_i = 2^(-age_hours_i / halfLifeHours)`（缺省半衰期 48h）；`mood_valence = clamp(Σ(valence_i·w_i)/Σw_i, -1, 1)`；【2026-09-25 勘误（v10 会话 A 深查，实锚 mood-line.ts MoodResult={tier,sampleCount}）：M1 实现仅覆盖 valence 轴聚合——arousal 轴聚合无消费方（渲染 §1.3 仅出 valence 档位），按「不允许预留逻辑/宁缺毋滥」裁定不实现；MoodSample.arousal 字段保留（与 store recentAffectSignals 返回结构对称，非活跃预留），PAD 全量状态机触发条件出现再立项（§5 同步勘误）。】
- 档位映射（三值化——天然低频翻转，控 KV 前缀抖动）：mood_valence ≥ posThreshold（缺省 +0.15）→ `偏积极`；≤ negThreshold（缺省 −0.15）→ `偏承压`；否则 `平稳`。
- 确定性：同输入逐字节同输出（纯函数，零 LLM、零随机）。

### 1.3 渲染

- 注入（soul-assembler 感受段尾新行，enabled=false 时逐字节不出现）：
  `<近期基调：偏承压（近 20 条经历的情感聚合）>` —— 档位+样本数，不出连续值（防伪精度）。
- UI（SoulFeelingBar 分区卡，S-UI 适配）：两列下方新增全宽「近期基调」副行，档位徽标（三态配色：积极=绿/平稳=灰/承压=橙）+ 样本数 + 阈值与窗口 tooltip（信息完整性：判定依据可见）。
- soulVersion：**纳入 mood 档位**（computeSoulVersion 输入扩展）——档位翻转=真状态变化=立即重注入，正是 soulVersion 的设计意图；三值化保证翻转频率可控。

### 1.4 配置（铁律 1）

`memory.coreMemory.moodLine.{enabled=false, windowHours=72, maxSamples=20, minSamples=5, posThreshold=0.15, negThreshold=-0.15, halfLifeHours=48}`

### 1.5 主语标注

所=agent（三元组库）；内=近期经历的 valence 聚合（信号多来自用户表达与交互事件——与锚聚合同源同性质）；功=agent（下一刻行动的状态输入）。注入行不带"我感到"字样，仅陈述聚合事实（防主语越界为拟人化断言）。

### 1.6 验收（M1）

- RED：mood-line.ts 纯函数单测（窗口边界/半衰期加权/三档映射/样本不足省略/clamp 极值对抗 ≥8 用例）+ soul-assembler 渲染守卫（enabled=false 逐字节不变）。
- A/B：构造三态语料（偏正/偏负/中性各 ≥3 组 + 边界组 ≥1）×同种子新旧对照 ≥10 组；负增益（含 KV 前缀抖动评估：档位翻转频率实测）诚实登记并回退。
- 降级：样本不足省略；valence 全 NULL 省略。

---

## 2. S-CHAR-2 品格张力检测（激活休眠 character 池）

### 2.1 定义

品格 = 在价值冲突的抉择中被反复选择的稳定倾向。张力实例 = 同一价值域在经历中出现方向相反的行为证据。本机制检测张力实例并经既有护栏产出品格提案——**给休眠的 character 池接上它等待的燃料**。

### 2.2 检测算法（确定性，单一源：character-tension.ts）

张力信号两类（满足其一即候选）：

- T1 演化反向：self_identity 演化史中同一价值域出现方向相反的修订（版本 diff 中「不做 X」→「做 X」类；实现=upsertCore 时对修订前后内容做价值域 label 匹配 + 极性词/行为短语对照）。
- T2 证据分裂：GROW-MAINT 证据重算时，同一锚（label）的支撑证据中 valence 方向分裂（正负证据各 ≥ minInstances 条，缺省 2）。

候选 → LLM 提议（复用 identity-discovery 双视角 worker，prompt 增第三产出字段 characterProposal：{label, rationale, tensionRefs}）→ 确定性门：tensionRefs 实例数 ≥ minInstances、护栏四件（F19）、QUOTA 分池（F15 character 池）→ character 锚落库。

### 2.3 渲染

- 注入：品格锚**不入感受段**（F-EV12-5③ 维持）；「我是谁」小节尾部新行 `我的品格：label(方向·w)：描述`（enabled/存在时；宁缺毋滥）。
- UI：三池锚面板品格池 tab 已在场（vtab 品格 1/8），零新增——展示链已在位。

### 2.4 止损条款（宁缺毋滥的硬边界）

**Spike 先行**：实施前在生产租户实测张力实例基数（T1 演化反向 + T2 证据分裂各多少）。若真实张力 < 2 例 → 本机制不启用（登记燃料不足，待经历积累后重测）。**禁止为激活机制而硬造张力。**

### 2.5 主语标注

所=agent；内=agent 自身在价值冲突中的抉择轨迹；功=agent（品格参照）。这是三层法中罕见的所=内=功=agent 全同机制——品格是灵魂中唯一纯粹属于 agent 的层。

### 2.6 验收（M2，spike 通过后）

spike 报告（张力基数+实例明细）呈拍板 → RED（tension 检测单测 + 护栏复用守卫）→ A/B 同种子 ≥10 组。

---

## 3. S-NARR-3 身份叙事行

### 3.1 定义

自我叙事 = 一句 ≤120 字的第一人称陈述，回答「我怎么变成这样」，作为 self_identity 槽内容的固定尾部行。它把事实清单粘合成连续的自我故事。

### 3.2 蒸馏机制（LLM 只提议、确定性门裁决）

- 时机：self_identity 采纳修订（version++）时，identity-discovery 双视角 prompt 增第三产出字段 `narrative`（要求：第一人称、≤120 字、须引用演化方向而非罗列事实）。
- 确定性门：长度 ≤ maxChars、第一人称校验（「我」字存在且无「用户」主语开头）、F10 状态残留剥离同款扫描、与既有槽内容尾部 narrative 行替换（幂等）。
- 落库：并入 self_identity 槽内容尾部（`- 我如何到这里：…`）——零新表、零 schema 变更、走既有 upsertCore 与分级门。

### 3.3 渲染

「我是谁」小节随槽内容自然携带（无独立渲染改动）；UI 身份双槽卡随内容展示（行高 1.75/渐隐折叠既有机制承载）。

### 3.4 对母 spec O14 裁决的边界修订

O14 裁决「不建 history 表（旧文 logger.info 留痕）」**维持不变**——本设计不建史表、不解析日志；叙事蒸馏的输入=当前槽内容+本次修订方向（identity-discovery 样本窗已有），历史材料仍以日志形态留痕。若未来叙事质量受限于无结构化史，另立设计呈报（不在本补充范围）。

### 3.5 主语标注

所=agent；内=agent（第一人称自我叙事）；功=agent。换用户测试扩展判据：两 agent 的 narrative 行必须实质不同（分化），完全相同=失败——沿用母 spec §8.3 双测试纪律。

### 3.6 配置与验收（M3）

`memory.coreMemory.selfIdentity.narrative.{enabled=false, maxChars=120}`；验收：RED（门校验 5 用例）+ 换用户/换 agent 扩展测试 + A/B ≥10 组（M1/M2 数据积累后实施——无前两步本步无料，顺序依赖明示）。

---

## 4. 分期与依赖

| 期 | 机制 | 依赖 | 可启动条件 |
|---|---|---|---|
| M1 | S-FEEL-1 近期基调 | 无（数据源已全在场） | 立即可做（设计已定稿） |
| M2 | S-CHAR-2 张力检测 | spike（燃料实测） | spike 报告呈报后 |
| M3 | S-NARR-3 叙事行 | M1/M2 数据积累 | 依赖明示，不提前 |

三机制与任务 2（R-arousal 召回新信号）共享 valence/arousal 数据源：M1 的聚合实现须与 R10 权重实现互不复制（单一源纪律——mood-line.ts 导出聚合函数供 R10 复用或反向）。

## 5. 演进边界（明确不做与触发条件）

| 项 | 触发条件 | 去向 |
|---|---|---|
| 连续值 mood 注入 | 三档粒度被证明不足的实证 | 另立设计（伪精度风险先行评估） |
| PAD 三维全量状态机 | arousal/dominance 出现消费方 | 另立设计（【2026-09-25 勘误（v10 会话 A 深查）】遗忘闪光灯调制 arousalRetention=0.3 已生产启用（tdai-gateway.yaml forgetting 段实锚）=arousal 已有独立生产消费方；近期基调聚合仍仅 valence 轴——§1.2 勘误同源） |
| 结构化 identity_history 表 | O14 边界修订的独立拍板 | 另立设计 |
| 情绪调节策略仿真（ACM 3789692） | 社会仿真场景需求实证 | 超出 TDB 范围 |

## 6. 风险登记

- L1 valence 打分噪声（LLM 归档评价）→ 三档化+条数下限+加权衰减三重降噪；噪声实证（分布审查）入 M1 验收。
- 情绪污染（单一强事件拉偏）→ 半衰期加权+minSamples 双门。
- KV 前缀抖动 → 三值化+档位翻转频率实测入 A/B 观察项；实测超阈值（>3 次/日）回退登记。
- 主语越界（拟人化断言）→ 渲染格式硬约束（§1.5）+存量快照断言守卫。
---

## 7. 六链矩阵（v2 增补：提取→维护→生长→使用→召回→展示，逐机制钉死到既有实现锚点）

锚点基线=HEAD 2df2d39。六链纪律是母 spec「四链生产级」（获取→评分→使用→展示）的完整展开：维护与召回两环在 v1 中未逐条钉死，本节补齐。**六链任一环缺失即整体不启用（与四链同判据：用户看不到/用不到=没做）。**

### 7.1 S-FEEL-1 近期情绪基调行——六链

| 链 | 机制 | 实现锚点（既有/新增） |
|---|---|---|
| 提取 | 零新增提取工序：复用 L1 既有 valence/arousal 列（l1-extractor 提取时 LLM 归档+确定性校验，normalizeSensitivity 同族门） | 既有：l1-extractor.ts；新增：store 只读查询 `recentAffectSignals(tenant, windowHours, maxSamples)`（l1_records WHERE valence IS NOT NULL AND occurred_at ≥ 窗口 ORDER BY occurred_at DESC LIMIT maxSamples） |
| 维护 | 无状态导出量：每次 /v3/recall 组装时确定性重算（O(maxSamples) 纯内存，零写库零新表）；数据质量由既有提取门负责，本机制不重复校验 | 新增：mood-line.ts 纯函数（单一源） |
| 生长 | 无累积结构；时间窗自滚动=自生长的无状态形式（样本随经历自然进出）；档位翻转频率为 A/B 观察项（>3 次/日回退登记） | 既有：occurred_at 时间列 |
| 使用 | soul-feeling 段尾新行 `<近期基调：…>`；soulVersion 纳入 mood 档位（档位翻转=立即重注入） | 既有：soul-assembler.ts 感受段（topDescSeg 同函数族）、computeSoulVersion（输入扩展） |
| 召回 | **红线：mood 不参与任何召回排序/加权**（F14-bis 同族——情绪不得喂自身：基调承压→召回偏负→更承压的自增强回路必须封死）；仅与 R10 共享 valence 数据源（单一源：mood-line.ts 导出聚合函数，R10 复用或反向，禁第二份实现） | 既有：R10 情感显著度权重（召回排序）、RankSignalItem（已扩 arousal） |
| 展示 | SoulFeelingBar 分区卡「近期基调」副行（三态徽标+样本数+阈值/窗口 tooltip）；/v3/recall 出参 meta.mood（插件层可消费） | 既有：SoulFeelingBar.tsx v2 分区卡；新增：出参 meta 扩展（soulVersion 同位） |

### 7.2 S-CHAR-2 品格张力检测——六链

| 链 | 机制 | 实现锚点（既有/新增） |
|---|---|---|
| 提取 | 双检测器（确定性）：T1 演化反向=upsertCore version++ 时对修订前后内容做价值域 label 匹配+极性对照；T2 证据分裂=GROW-MAINT recountEvidence 时同锚 valence 方向分裂统计。LLM 仅将候选张力实例提炼为品格提案（identity-discovery worker 第三产出字段） | 既有：identity-discovery.ts 双视角 worker（提案 JSON 格式行 49-79）、recountEvidence（F9）、upsertCore version++ 旧文留痕；新增：character-tension.ts（单一源） |
| 维护 | 品格锚落 core_values（node_type='character'）→ 进入既有 GROW-MAINT 全量证据重算循环（ev<min→retire、\|Δw\|≥0.05→reweight）；状态键族用独立前缀 anchor_char_*（沿用 person 池 anchor_person_* 分键先例，防共用键族互清） | 既有：anchor-growth.ts GROW-MAINT（:237-247 维护退场）、anchor_growth_state 键族 |
| 生长 | 护栏四件 F19（ev≥minEvidence/maxPerPass/maxTotal 分池/全态去重 (node_type,label) 复合键）+张力实例数只增不减；weight 按 F5 证据饱和生长；品格池配置**已在代码缺省在场**（anchor-growth.ts:71/85 `character:{enabled:false,minEvidence:2,maxPerPass:1,maxTotal:8}`——第三池是「启用」非「新建」）；设计值 maxTotal=6 经 yaml 配置覆盖（不改代码缺省） | 既有：F19/F5/F15 分池制（maxTotalTheme=15/maxTotalPerson=8 先例）、growthValueId |
| 使用 | 「我是谁」小节尾部新行 `我的品格：label(方向·w)：描述`（enabled+存在时；宁缺毋滥）；**不入感受段**（F-EV12-5③ 维持）；soulVersion 纳入（新行出现=指纹变化） | 既有：soul-assembler.ts 身份小节渲染、escapeXmlTags 消毒 |
| 召回 | 品格锚证据链走 coreRefs 同款双向回填（characterRef）；记忆召回侧 searchL1ByCoreRefs 同款反查扩展；F14 遗忘保护扩展：指向 active character 锚的记忆受保护（重验 refs 有效性同款——防永生记忆条款不变） | 既有：coreRefs backfill（重算精确一致 7/7 先例）、searchL1ByCoreRefs、F14 保护钩子 |
| 展示 | 三池锚面板品格池 tab（已在场：vtab 品格 1/8 实锚）+分池配额显示+「查看关联记忆」复用；出参 attrs/labels 自动带出（列扩展已在场） | 既有：ValueAnchorsPanel vtab 三池、node_type='character' 类型徽标位、mapLayerItem |

### 7.3 S-NARR-3 身份叙事行——六链

| 链 | 机制 | 实现锚点（既有/新增） |
|---|---|---|
| 提取 | identity-discovery 双视角 worker prompt 增第三产出字段 narrative（样本窗=既有 selectSampleRows：updated 降序+高显著 cap 50）；触发时机=self_identity 采纳修订（version++）时 | 既有：identity-discovery.ts selectSampleRows/双视角 prompt/分级门 |
| 维护 | 确定性门（单一源 narr-gate.ts）：长度≤maxChars、第一人称校验、「我」在场且非「用户」主语开头、F10 状态残留剥离同款扫描、槽尾 narrative 行幂等替换；落库走既有 upsertCore+allowedSlots 信任边界（self_identity 已在白名单） | 既有：upsertCore（version++/旧文 logger.info 留痕）、config.ts:872 allowedSlots、F10 剥离单一源 |
| 生长 | 叙事随每次 self_identity 修订重蒸馏（生长=叙事随身份演化更新）；无独立累积结构（O14 边界维持：不建史表不解析日志） | 既有：version++ 演化链 |
| 使用 | self_identity 槽尾固定行 `- 我如何到这里：…`→「我是谁」小节自然携带；soulVersion 纳入（槽内容变化已计入） | 既有：soul-assembler.ts 身份小节、F17 槽预算（900 字符内） |
| 召回 | **红线：narrative 行不产生 identityRefs**——蒸馏物非事实，防蒸馏叙事被当行为证据反查/受遗忘保护（防叙事自我强化）；identityRefs 证据链只挂事实行 | 既有：identityRefs 回填与 GROW-MAINT 重算 |
| 展示 | Panel 身份双槽卡随槽内容展示（行高 1.75/渐隐折叠既有机制承载）；可选：narrative 行加「叙事」小徽标与事实行诚实区分（实施期决定，不阻塞） | 既有：ChatMemoryPage 身份双槽卡（渐隐折叠/展开全文） |

## 8. 反耦合红线（三机制×既有系统的隔离边界——每条都有事故原型）

| 红线 | 理由（事故原型） |
|---|---|
| R-A：mood 不参与召回排序/加权 | 回音室变体：情绪喂自身（承压→负向召回→更承压）。F14-bis 是身份版防线，R-A 是情绪版同构 |
| R-B：character 不入感受段 | F-EV12-5③ 既有拍板维持；品格是「我是谁」的属性不是「此刻的感受」——混入即重蹈 G1 名实错位 |
| R-C：narrative 不产生 identityRefs | 蒸馏物当事实=叙事自我强化+遗忘保护误伤真事实（F14 保护判据输入被污染） |
| R-D：三机制全部走既有确定性门族（F10/F15/F19/分级门），不新造第二套门 | 单一源铁律：第二套门=口径分叉（O12/G13 事故族） |

## 9. v2 后的启用路径（不变，重申依赖）

M1（S-FEEL-1）数据源全在场可立即开工（RED→门禁→A/B ≥10 组→呈报启用）；M2（S-CHAR-2）须先跑张力燃料 spike（T1+T2 基数实测，<2 例则不启用——止损条款 §2.4）；M3（S-NARR-3）依赖 M1/M2 数据积累。三机制的 store 层新查询/新键族全部走 config 缺省关断，yaml 未开启前运行时逐位现状。


---

## 10. 融合面影响清单（v3 增补：与当前实现的真实接缝——用户问「和当前的设计实现融合了么」现场取证后补）

取证基线=HEAD 0f286d39 前后同日实锚（anchor-growth.ts:71/85、soul-assembler.ts:83-89、store/types.ts:727、identity-discovery.ts:376）。**结论：文档/设计层已融合（六链逐环钉既有锚点+主 spec 交叉引用+既有裁决显式衔接）；实现层刻意零融合（设计先行，全缺省关断，一行未写）。**下列四条是 v2 未点明的真实接缝，M1 开工时按此计改动面：

| # | 接缝 | 机制 | 融合方式（先例手法） | 影响面 |
|---|---|---|---|---|
| IF-1 | IMemoryStore 接口扩展：`recentAffectSignals?(tenant, opts)` 可选方法（只读查询） | S-FEEL-1 | 可选签名先例（ILogBackend debug?/listValues opts 同款）——不破坏既有实现面，缺方法时基调行静默省略（宁缺毋滥） | store/types.ts 签名+sqlite 实现+测试 fake store 各 1 处 |
| IF-2 | computeSoulVersion 签名扩展：增可选第三参 moodTier（缺省 undefined=指纹逐位不变） | S-FEEL-1 | 可选参数先例（buildSoulPrefix 增可选 metaOut 同款）——enabled=false 时不传参，指纹与现状逐位一致 | soul-assembler.ts 签名+调用点 1 处+快照断言波及 |
| IF-3 | identity-discovery 提案解析扩字段：narrative / characterProposal（宽松读取，feature-detect） | S-NARR-3 / S-CHAR-2 | 宽松读取先例（sigMeta 局部宽松读取同款）——旧 LLM 输出无新字段时逐位现状 | 解析函数+prompt 2 处 |
| IF-4 | P1 语义去重比对域边界：narrative 行与 characterProposal **不入** proposal-dedup 比对域（比对域维持 pending∪已采纳红线 slot）——蒸馏物/品格提案与身份事实去重是两个语义，混入会误拦 | S-NARR-3 / S-CHAR-2 | 比对域显式白名单化（现状=slot in {core_value, strict_rule}，行为不变，仅文档钉死） | proposal-dedup.ts 注释+守卫用例 1 处 |

勘正记录：v2 §7.2 曾把 S-CHAR-2 的融合写成「沿用分池制先例」而未点明接缝——现场取证发现 character 池配置**已在代码缺省在场**（第三池是启用非新建），融合深度低于 v2 评估，§7.2 已同步修正。本清单本身即「自生长自维护」的执行样例：设计文档在自己的融合面被问及时现场取证并自我修正。

