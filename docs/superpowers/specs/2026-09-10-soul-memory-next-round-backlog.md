# 灵魂记忆系统 · 第三档待讨论清单（设计大件）

> 日期：2026-09-10
> 性质：**待讨论清单，非承诺清单**——每项需要一场设计讨论（spec 先行）后才能进计划。
> 背景：第五轮对抗性审查 + 可信性修复（21 任务）完成后，设计与实现之间剩下的"大件"缺口。
> 事实底座：`reviews/2026-09-09-soul-memory-fifth-round-audit.md`、`specs/2026-09-09-soul-memory-trust-repair-design.md`、spec §6.4 登记表（11 项）。

---

## 1. L1→L2→L3 层级边（"经验→情境→身份"树）

- **设计出处**：soul spec §4.2 / agent-memory-design C2："层级边 L1→L2→L3 构成'经验→情境→身份'树"
- **现状**：零实现（l1_links 只有 L1↔L1 四种边 + part_of；无跨层边类型）
- **开放问题**：①边的方向语义（L1 part_of L2？还是 L2 contains L1？——part_of 的方向争议 G-B9 是前车之鉴）；②L2 场景与 L1 的归属判定靠什么（scene_name 字符串匹配又是词法陷阱？）；③与既有 L2 scene 管道的边界（T17.5 已把 scheduler 行映射修好，供料链路是通的）
- **依赖**：无硬依赖；建议先出方向语义的 spec 再动手

## 2. coreRef（记忆→价值锚引用）

- **设计出处**：soul spec §7 数据模型 `coreRef: valueId[]`
- **现状**：零实现、spec §6.4 已登记
- **开放问题**：①写入时如何判定"触动哪个价值锚"（LLM 提取顺带判定=搭 T17 顺风车？还是检索时动态计算？）；②coreRef 与 salienceBoost（appraisal 侧已有子串匹配）的关系——重复还是互补；③数据形态（l1_records 新列 vs metadata_json）
- **依赖**：S1 的 core_values 写 API（价值锚可维护后才有多租户语义）

## 3. 动机方向（motivational charge）

- **设计出处**：agent-memory-design §3b.3 职责4"给行为一个看重/看轻、趋近/回避的方向性"
- **现状**：零实现、未登记（本轮已补登记）
- **开放问题**：①"功能性诚实"边界——方向性输出到什么程度（注入块一句话？还是影响工具选择/回答结构的系统信号？）；②与 current_feeling 的关系（感受块已解冻每轮注入——动机方向是它的延伸还是独立机制）；③最大的风险是"假装有动机"变成表演——需要先定义可观测的行为差异
- **依赖**：current_feeling 解冻（T16 已完成，感受块每轮真实注入——动机方向可以搭同一注入器）

## 4. TCVDB 后端实证与补全（F7 家族清算）

- **设计出处**：spec §6.2 F7 + 第五轮审计 + T12/T17.5 审计登记
- **现状**：sqlite 全量实现；tcvdb 后端缺失/语义未实证清单——①soul 8 列读写（部分有）②l1_links 全套图能力 ③l1_archive/restore ④core_memory/core_values ⑤updateL1Metadata/bumpRecallCount ⑥searchL1Vector score 刻度与 sqlite `1-distance` 不可比（影响 minSimilarity 门槛语义）⑦native-hybrid 提前 return 跳过 reconsolidation
- **开放问题**：①是否真的要支持 tcvdb（生产在用 sqlite，tcvdb 是"将来时"——若半年内不切，投入是否值得）；②若切，先实证 score 刻度还是先补方法
- **依赖**：无；纯投入产出决策

## 5. router 存废/权重调参

- **设计出处**：wiki-recall 线；T19+20 隔离实验证伪 router 对 recall 的贡献（部署工作点贡献=0、噪音恒+2）
- **现状**：router 代码生效（键名修复后），但归因清白性已破——需要独立变量归档实验后再议
- **开放问题**：①router 直接删（简化）还是降默认权重还是保留现状；②negInjected +2 的噪音值不值得它的（尚未证实的）收益；③golden 集要扩负例覆盖（W6 的负例词表口径问题）
- **依赖**：golden 归档纪律已建立（T19 归档锚点可复用）

## 6. 遗忘链路 legacy 行与 scorer 双兜底策略统一

- **设计出处**：T17.5 审计 M-4 / F-3（forgetting 链路 metadata 兜底在 soul 列为空的 legacy 行不可见）
- **现状**：scorer 顶层→metadata 双兜底；summarizer（T18）只有顶层单兜底——两处策略不一致；soul 列空的 legacy 行在 forgetting 侧真值不可见
- **开放问题**：①统一为哪种策略（顶层→metadata 双兜底，还是与 T18 半数规则对齐）；②存量 legacy 行是否跑一次 metadata 回填（F3 的 soul 版）
- **依赖**：无；小件可并入任一后续批

---

## 讨论时的裁决框架（沿用本批原则）

每个候选先回答三个问题，再决定做不做：
1. **它服务哪条第一性原则**（P-A~P-F）？说不出来源的不做。
2. **触发条件在生产可达吗**（R3 教训：机制不被触发=死代码）？
3. **验证能同形吗**（R5 教训：fixture 形状≠生产形状）？

优先级建议（供讨论起点）：2（coreRef）> 1（层级边）> 6（策略统一，小）> 4（TCVDB，纯决策）> 5（router，纯决策）> 3（动机方向，需先定义边界）。
