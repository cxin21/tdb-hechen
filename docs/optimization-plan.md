# 记忆系统评测报告与优化路线（v2）

> **版本**：2026-10-26 深夜全量复核版（v2）。本版对 v1 做了逐条亲手复核 + 精排闸门实证（新增探针），勘误清单见 §10.3。
> **用途**：交给新会话逐步执行。§7 是执行清单；每一步都带位点、命令、验收、回滚。
> **上游文档**：[`benchmarks.md`](./benchmarks.md)（怎么跑+怎么读数）、`docs/research/benchmarks-and-optimizations.md`（11 基准+15 优化，逐条带 arXiv 表号）、`docs/research/systems-deep-dive.md`（9 系统深挖）、`docs/research/2026-10-20-recall-precision-final-plan.md`（生产召回精度路线 F1–F10）。
> **目标函数**：turn_cov@5 与 answer-correct 先涨；延迟与写入面风险受约束。

---

## 0. TL;DR

**一句话结论：读侧裸 + 精排闸门误杀 + 检索粒度不对口径，三处叠加；其中精排闸门误杀是今天新实证的头号可修项，读侧三件套是性价比最高项。**

| 批 | 改什么 | 证据强度 | 成本 | 预期 |
|---|---|---|---|---|
| **B0 校尺** | 报告透出 gates/timing/answerModel、加 turn_cov@10、分层抽样固定 | 一手 harness 缺口 | 0.5 天 | 后续每步可归因 |
| **B2-a 精排闸门** | minScore −2.0（logit 刻度）重新标定 + 池 12→32 | **今日实证：闸门通过率仅 14.2%**（§3.3） | 0.5–1 天，config-first | avgHits 2.63→4+，turn_cov 直接受益 |
| **B1 读侧三件套** | CoN+JSON、时间戳打包、拒答出口（+prompt 语言修正） | LME 论文 +10 绝对点（§5.5）；另发现 19/20 中文答英文题（§3.4） | 1 天，零写入面 | answer-correct 直涨 |
| **B2-b 检索杂项** | MMR 去冗余、validityNow=题目日期 | 一手确认（§4 D6） | 1 天 | 排序质量 |
| **B3 索引** | K=V+fact 文档扩展 + 结论层接入 bench | 论文 +9.4% recall；反例 K=summary 崩（Table 3） | 3–5 天 | 最大单项 |
| **B4 时间** | 只做排序/降权，时间窗扩展先测后开 | 论文 Table 4（弱抽取器反噬） | 2 天 | 谨慎加分项 |
| **B5 不做** | RAPTOR 树 / 图扩展 / 微调 / RL | 存储成本差两个量级（Mem0 7k vs Zep 600k tokens） | — | — |

---

## 1. 先把尺子校准（不校准等于白测）

1. **设定不可横比**：LME `oracle`（只给证据 session，我们跑的等价设定=每题独立租户）/ `_s`（≈115k tokens）/ `_m`（≈1.5M）。论文实测 oracle→`_s` 掉 **30–60%**（arXiv:2410.10813 §4.2）。社区报的 71.2%（Zep）/71.4%（Mem0）都是 `_s`，**不能与我们 oracle 设定的数字直接比**。LoCoMo 同理：社区 72.9–75.8 是 LLM-judge QA 分，我们目前只有检索侧指标。
2. **必须双报**：recall 指标 + answer accuracy。反例（Table 3）：摘要键 recall@5 只掉 13pp，QA Top-10 却 0.676→0.252。
3. **必须报 @5 和 @10**：@5→@10 差异最大 12.4pp（Table 9）。我们目前只有 @5 —— B0 补。
4. **样本量纪律**：500 题 95% CI ±4.0pp、100 题 ±9.0pp、50 题 ±12.7pp。我们 LME100/LoCoMo60 的单点读数只能看方向，**提升判定必须同题配对（McNemar / paired bootstrap）**。
5. **judge 纪律**：温度 0；abstention/preference 两类一致性最差（0.90，Table 6）→ 抽检 ≥30 条。
6. **配额纪律**（429 实测教训）：embedding API 有限流，跑批必须**串行单进程 + pace 150ms**（`run-sequence.sh` 模式），并发多进程会触发 429 风暴拖慢全部任务。

---

## 2. 实测基线（本版全部数字已亲手复核）

### 2.1 环境

- 被测：td-agemem 记忆召回链（bench 路径=SQLite fallback hybrid + 本地 bge-reranker-base 精排；doubao embedding 2048d；BM25=on）。
- bench 配置 = 生产 yaml 改 `data.baseDir` + 关闭 capture/extraction/lifecycle/evolution/recallJournal + v3Recall on（`MemoryCore/scripts/lib/bench/store.mjs:35-56`）；`config-override.json` 从生产 `D:/TDB/data` 复制（`:88-94`）。生产 override 的 rerank 段只有 `{provider:local, enabled:true, local.idleUnloadMs:0}`，**未设 minScore/candidates** → 生效值=生产 yaml `tdai-gateway.yaml:242-247`：`candidates:12`、`minScore:-2.0`。
- judge 模型：scm-flash @ 10.16.235.171:50003（override 凭据）；回答模型同凭据，但**报告未记录 answerModel（harness 缺口，B0 修）**。

### 2.2 四份报告（都在 `MemoryCore/.eval-data/bench/`）

| 报告 | 行数 | any@5 | sessionCov | turnCov@5 | MRR | nDCG | avgHits(k=5) | latP50 |
|---|---|---|---|---|---|---|---|---|
| LME100 检索（longmemeval-oracle-2026-10-26T14-57-58.json） | 100 | **100%** | 64.8% | **46.6%** | 0.598 | 0.456 | **2.63** | 2667ms |
| LoCoMo60 检索（locomo-2026-10-26T15-12-16.json） | 60 | **74.1%** | 61.0% | **47.7%** | 0.431 | — | 2.62 | 2045ms |
| LME20+生成判分（longmemeval-oracle-2026-10-26T15-31-39.json） | 20 | 100% | — | 50.0% | 0.550 | — | 2.70 | ~2.7s |

生成判分（LME20）：**LLM 判对率 5%（1/20）**、tokenF1 0.078。失败形态不是"答错"而是"不答"：**19/20 拒答式**（"无法确定"类）、**19/20 用中文回答英文题**（f1 跨语言无意义）；唯一判对 = 直接抄记忆原文的「White Adidas sneakers」。

LME100 hits 分布 `{1:12, 2:51, 3:13, 4:10, 5:14}` —— 86/100 行没填满 k=5；`conclusionCount=0`（100/100 行）。

### 2.3 turn_cov 的结构拆分（LME100）

- 按覆盖分桶：全覆盖 23 行 / 部分覆盖 52 行 / 零命中 24 行 / 无标注 1 行（该行 turnCov=null）。
- **天花板核查**：对 99 个有标注题，turn_cov@5 的理论上限均值 = **99.3%**（每题证据轮数多为 1–3；全 500 题里证据轮数 >5 的仅 6 题）→ **46.6% 不是指标口径天花板，是真实差距**。
- 76/99 题未达上限；典型失败形态：证据轮 n=2 只命中 1。
- 分题型（样本只有两类）：temporal-reasoning 60 题 turn **54.2%**；multi-session 40 题 turn **34.0%**（any 都是 100%）。全 500 题型分布 temporal 133 / multi-session 133 / knowledge-update 78 / single-session-assistant 56 / user 70 / preference 30 → **当前样本缺 4 类，代表性有缺口**（B0 分层抽样解决）。

### 2.4 位置判断

- LME：我们跑 oracle 设定，社区报 `_s`，**两边不可比** → LME 只做"我们自己的相对改进"标尺。
- LoCoMo：社区 72.9（Mem0）/75.7（Zep）/75.8（Memobase）是 judge QA 分；我们 74.1% 是检索侧 session_any@5，**不是同一把尺**。定档需要补 judge 分（B1 后跑）。

---

## 3. 第一性原理分析

### 3.1 功能分解：记忆问答系统的失败面只有六处

```
写入/抽取 → 索引(粒度+键) → 检索(通道+融合) → 精排(闸门+排序) → 注入/读侧(打包+提示) → 生成/判分
```

任何"分数低"都必须归因到这六级之一（或多级叠加），且每级都可以用受控实验单独证伪。下面逐级过。

### 3.2 逐级归因

| 级 | 现象 | 归因 | 证据 |
|---|---|---|---|
| 写入/抽取 | bench 关闭写侧管线（设计如此，测的是纯检索） | 非本案失败面 | store.mjs:35-56 |
| 索引 | LME 论文粒度×键正交实验：Round 粒度 recall 天然低于 Session（0.582 vs 0.706），但 QA 打平；**K=summary 键=已知崩法**（QA 0.676→0.252）；正确姿势 K=V+fact（+9.4% recall） | 我们把 turn 当检索条目=Round 粒度 → 部分解释 turn_cov，但不解释 avgHits<5 | Table 3/9 |
| 检索 | 向量通道 cosine≥0.3 才进 RRF（auto-recall.ts:2366）；FTS 通道无门槛 top36（candidateK=maxResults×3，:2274）；RRF k=60（:2416） | 部分题检索池本身薄（见 §3.3 尾注） | 一手锚点 |
| **精排** | **bge-reranker-base logit 天然极低（中位≈−9，下限截断 −10.18），而闸门 minScore=−2.0 → sigmoid 闸门只放行 14.2%** | **头号可修项（§3.3 实证）** | 今日探针 |
| 注入/读侧 | 编号直塞、按分数排序非时间序、无 CoN、无拒答出口；且注入块带生产包裹「仅作为参考」+ 中文指令「片段不足直接说无法确定」 | answer 侧 5% 判对率的直接推手（§3.4） | llm.mjs:95-113 |
| 生成/判分 | 19/20 拒答、19/20 中文答英文；judge 规则 3 会把拒答判 false（llm.mjs:146）——判定本身没错，但暴露 prompt 诱导拒答 | f1 跨语言无意义 → 指标污染 | LME20 报告 |

### 3.3 精排闸门实证（2026-10-26 深夜新增，可复跑）

脚本：`MemoryCore/.eval-data/bench/probe-rerank.mjs`（零 API 调用——本地 ONNX 精排器）。
方法：从 LME100 报告抽样 12 题（hits 1–5 每桶 2 题 + 2 题"hits 满 5 但 turn 未全覆盖"），对每题用**该题全部轮文本**（24–36 条）跑 bge-reranker-base，看 logit 分布与 minScore=−2.0 的通过率。

```
caseId          hits  turns  topLogit  median  pass(>-2.0)
gpt4_2655b836   2     36     -2.99     -8.69   0/36   ← top 都不过门 → 全灭降级
gpt4_2487a7cb   2     24      3.61     -9.21   5/24
gpt4_2312f94c   3     24      5.33    -10.16   7/24
0bb5a684        5     24      6.23     -6.82   6/24
08f4fc43        4     22     -1.64    -10.13   2/22
2a1811e2        3     24      0.22     -8.80   1/24
gpt4_70e84552   4     24     -1.03    -10.18   3/24
982b5123        1     24      0.15    -10.18   1/24
b9cfe692        5     36      6.49     -8.95   8/36
gpt4_2c50253f   1     24     -1.20    -10.18   1/24
gpt4_7de946e7   5     24      1.17     -7.27   4/24
─────────────────────────────────────────────────────
SUMMARY: pass 14.2% (44/310) at minScore=-2.0
```

**三点结论：**
1. **通过率 14.2% 与实测 avgHits 2.63/5、86% 行未填满严丝合缝**——精排 sigmoid 闸门是召回池饿死的主嫌疑（logit 刻度 vs 固定阈值，必翻车；这正是内部 #99/F3 已踩过的坑：`auto-recall.ts:543-548` 记录了 topScore −2.82 < −1.0 全杀 12 条的真实案例）。
2. bge-reranker-base 的 logit **不是 0–1 相关度**：中位≈−9、下限截断 −10.18，分布双峰（相关对 >0，无关对 ≈−10）→ 阈值必须按 logit 分布标定，不能用"直觉分数"。
3. 部分 hits 桶与探针不完全对应（如 gpt4_2655b836 探针 0/36 过门但实测 hits=2）——因为真实管线只把 RRF top-12（不是全部轮）送精排；这说明**部分题在检索池阶段就已经薄**（向量通道 0.3 过滤 + FTS 稀疏）。两级都可能饿池，逐题归因要靠 B0 的 gates/timing 透出（见 B0-1）。

### 3.4 生成侧缺陷（与检索无关，但同样压分）

`buildAnswerPrompt`（`MemoryCore/scripts/lib/bench/llm.mjs:95-113`）：中文指令 + 注入块自带生产包裹「以下是当前对话召回的相关记忆…仅作为参考」+「片段不足以回答时直接说明无法确定」→ 在证据本就只有 2.63 条的背景下，模型理性选择拒答 → 19/20 拒答、判对率 5%。**answer-correct 的基线必须先修 prompt 再解读**，否则 B1/B2 的 QA 收益会被拒答倾向吃掉。

---

## 4. 瓶颈清单（每条带置信度）

| # | 瓶颈 | 关键数字 | 机制锚点 | 置信度 |
|---|---|---|---|---|
| D1 | **精排闸门误杀**：sigmoid(minScore −2.0)=0.119 只放行 14.2% 候选对 | avgHits 2.63/5；86% 行未填满 | yaml:247 + auto-recall.ts:551-563 | **高**（今日实证） |
| D2 | turn_cov 真实差距：46.6% vs 上限 99.3% | 24 行零命中 + 52 行部分覆盖 | metrics.mjs:35-93 | 高 |
| D3 | 粒度/键：Round 粒度 recall 先天低；结论层没上场（conclusionCount=0×100） | Table 3 | datasets.mjs 载荷=turn 原文 | 高 |
| D4 | 读侧裸：无 CoN/无时间序/无拒答出口 | +10 绝对点量级（论文） | llm.mjs:95-113 | 高（论文级） |
| D5 | 检索池部分题先天薄：向量 0.3 过滤 + FTS 稀疏 | §3.3 结论 3 | auto-recall.ts:2366/:2286 | 中（待 B0 归因） |
| D6 | bench 时钟错位：validityNow=new Date()（拿 2026 视角看 2023 的事，触发失效排除） | store.mjs:267 | 一手确认 | 高（单点必修） |
| D7 | 生成 prompt 诱导拒答 + 跨语言污染 f1 | 19/20 拒答 | llm.mjs:95-113/:146 | 高 |

---

## 5. 行业标配对照（9 系统逐个核过，`research/systems-deep-dive.md` §10）

| 标配（≥3 家独立实现） | 覆盖 | 我们现状 | 缺不缺 |
|---|---|---|---|
| LLM 抽取**语义单元**而非只存原文 | 7/9 | 有 scene/fact/结论层，但 bench 召回没接（D3） | **缺"接线"**，不缺机制 |
| 向量相似度作第一跳召回 | 9/9 | 有（doubao 2048d + BM25 hybrid） | 不缺 |
| 分层/多粒度存储 | 6/9 | L1 turn / L2 结论 / scene_block / memory_summary 都在 | 不缺（但没打通） |
| 原始 episode 与派生语义并存、可回溯 | 4/9 | turn 原文 + 派生层并存 | 不缺 |
| 时间只进元数据/排序权重，**不做查询时过滤** | 5/9 | 已有 bi-temporal 失效（Zep 式，少数派优势） | 别退化成"时间窗过滤" |
| 写时冲突解决（四决策） | 1/9（仅 Mem0） | 有 F5 supersession 规划 | 方向正确，非短板 |
| rerank / MMR 系统化 | 1/9（仅 Zep） | **我们已有 local rerank** | 是优势——但**闸门标定错了**（D1），优势没兑现 |

→ 一句话：**我们不缺机制，缺的是"把已有机制接对线"和"读侧把结果讲清楚"。**

---

## 6. 优化路线（每条：做什么/位点/验收/回滚）

### B0 校尺（0.5 天，零风险，最先做）

1. **bench 行透出归因字段**：`makeRecall` 的 `outcome.timing`（ftsMs/embeddingMs/**ftsHits/embeddingHits**）与 `outcome.gates`（精排 kept/dropped/top/degraded、nativeMinRRF）目前被 bench 丢弃——写进报告每行。验收：任抽一行能看到"检索池 N 条→精排后 M 条"。这是 D1/D5 逐题归因的唯一手段。
2. 报告加 `turn_cov@10` / `recall@10`；config 记录补 `answerModel` 字段。
3. 分层抽样 manifest（seed=20261026，LME 7 题型×15=105 迭代用、×40=280 定稿用），**抽样只做一次，后续复用**——解决 §2.3 的"缺 4 类"问题。
4. judge 固定温度 0 + 记录 prompt 版本；abstention/preference 抽检 ≥30 条。
5. A/B 纪律：一次一变量、同题配对（McNemar / paired bootstrap）。

### B2-a 精排闸门重标定（0.5–1 天，config-first，证据最硬）

1. **minScore 按探针分布重标**：bge logit 双峰（相关 >0 / 无关 ≈−10）。候选档：`-2.0`（现状）→ `0`（只留正相关对）→ `-10.5`（近关=只挡全无关）→ 关闸（依赖 RRF 序）+ 池 `candidates 12→32`。每档跑 LME105（B0 抽样），看 avgHits 与 turn_cov 配对变化。
2. 顺带把 sigmoid 闸门的语义改对：阈值比较应在 **logit 域**做并按分布标定（现状 sigmoid(minScore) 数值上等价，但可读性差、易再配错）。
3. 回滚：yaml 两个数值，秒回。
4. 预期：avgHits 2.63→4+；若 turn_cov 不动则说明排序（而非池子）是下一瓶颈 → 进 B2-b/B3。

### B1 读侧三件套 + prompt 修正（1 天，零写入面）

| 改动 | 具体 | 证据 |
|---|---|---|
| CoN + JSON | 每条证据 `{id, timestamp, content}`；先写 2–4 条 evidence note（带 `[i]` 引用）再作答 | 2410.10813 §5.5 +10 绝对点；JSON 单独用不赚 |
| 时间戳打包 | 注入块按时间排序（非分数序），最相关避开正中 | LME 官方做法；2307.03172 §4 位置效应 >20% |
| 拒答出口 | 无证据输出 `NOT_ENOUGH_INFO` 纳入判分 | abstention 是 7 类之一 |
| **prompt 语言修正**（D7） | 回答指令改英文/双语；注入块包裹语改中性（去掉"仅作为参考"的贬抑）；f1 判分加跨语言归一（或只报 judge 分） | 一手：19/20 中文答英文、19/20 拒答 |

位点：`MemoryCore/scripts/lib/bench/llm.mjs` 的 `buildAnswerPrompt`（生产侧同逻辑在 injector 注入块渲染——bench 先行验证，生产另开票）。

### B2-b 检索杂项（1 天）

1. **MMR（λ=0.7）去近重复**：同 session 多 turn 挤占 5 槽是 hits 高而 cov 低的直接原因之一。
2. **validityNow=题目日期**（D6，`store.mjs:267` 一行改动）：拿 2026 视角看 2023 会触发不该触发的失效排除。
3. 阈值 A/B 顺带跑：向量通道 cosine 0.3 → 0.15/关（D5 归因后决定）。

### B3 索引层（3–5 天，最大单项，有硬反例护栏）

- **做**：写入时离线抽取事实短语，**拼接**进 embedding 文本：`K = 原文 + 事实`；原文仍是命中载荷，回答回链原文。
- **不许做**：摘要/要点作为唯一 key（Table 3：QA 0.676→0.252 崩法）。
- 顺带把结论层接进 bench 召回（D3 后半：`conclusionCount=0`×100），让 work_fact 参与而不是空转。
- 抽取器：小模型离线批处理；抽不好的噪声事实是负收益，抽样验收。

### B4 时间（2 天，先测再开）

1. **做**：时间作乘性降权因子（内部 F6b，`0.5^(Δt/30d)`，never-a-filter）——与行业 5/9 主流一致。
2. **先测后开**：时间感知查询扩展（"上周/去年"→时间窗）。强抽取器 temporal recall@5 +11.3%/+6.8%，弱抽取器 **0.421→0.384 反噬**（Table 4）。开闸条件：时间窗抽取准确率 ≥80% 且 temporal 子集净收益为正。
3. **保留**：bi-temporal 失效是 Zep 式少数派优势，不退化成时间窗硬过滤。

### B5 明确不做（现阶段）

| 项 | 理由 |
|---|---|
| RAPTOR/递归摘要树 | 要递归聚类+增量重建（2410.10813 §2）；对话"文档边界"不清晰 |
| 图扩展（HippoRAG/Graphiti） | Zep 图 ~60 万 tokens vs 原文 2.6 万；Mem0 graph 变体 marginal drop |
| embedding 微调/换模型 | 全量重嵌入成本；收益需 A/B 证明 |
| 端到端 RL | 样本量与成本都不成立 |

---

## 7. 新会话执行清单（按序，每步独立可验收）

> 前置状态：`MemoryCore/.eval-data/bench/run-sequence.sh` 是跑批模板（串行+pace 150，防 429）；报告落在 `MemoryCore/.eval-data/bench/*.json|.md`；读数用 `MemoryCore/scripts/bench-report.mjs`，诊断用 `MemoryCore/scripts/bench-diagnose.mjs`。

| 步 | 任务 | 命令/位点 | 验收 |
|---|---|---|---|
| 0 | 环境自检：`gh` 可用、judge 凭据通、embedding 配额在 | 复跑 `probe-rerank.mjs`（应复现 14.2%±2pp） | 探针可跑 |
| 1 | B0：gates/timing/answerModel/turn_cov@10 透出 + 分层抽样 manifest | bench runner + metrics.mjs | 报告行含 gates 字段；manifest 文件生成 |
| 2 | B0：LME105 基线（新抽样上重测检索+生成） | run-sequence 模式，串行 | 新基线报告落盘，CI ±9pp 内 |
| 3 | B2-a：minScore 三档 + 池 32 的 A/B（一次一档） | yaml:246-247 | avgHits 显著↑且 turn_cov 配对不降 → 定档 |
| 4 | B1：读侧四件套（含 prompt 语言） | llm.mjs:95-113 | LME105 answer-correct 配对↑；拒答率 <20% |
| 5 | B2-b：MMR + validityNow=题目日期 | store.mjs:267 + 精排后处理 | turn_cov@5 配对↑（预期 +3–8pp） |
| 6 | B3：K=V+fact 离线抽取 + 结论层接入 | 写入管线 + datasets 载荷 | recall/QA 双升；**K=summary 反例不出现** |
| 7 | B4：时间降权 A/B | F6b 接线 | temporal 子集净收益为正才保留 |
| 8 | 收口：LoCoMo 全量 + LME 500 定稿，judge 分 + 30 题人工抽检 | run-sequence | 与社区口径对话（`_s` 小样本补跑一次，拍板项 D4） |

**停止条件**：连续两批提升 <3pt（CI ±9pp 内视为无变化）→ 停止堆机制，转错例归因（按 D1–D7 打标）。

---

## 8. 预期与验收

| 指标 | 现状 | B2-a 后 | B1 后 | B3 后 | 验收方式 |
|---|---|---|---|---|---|
| LME105 turn_cov@5 | ~46%（待新基线） | ≥52% | ≥56% | ≥65% | 同 harness、配对检验 |
| avgHits / k=5 | 2.63 | ≥4 | ≥4 | ≥4 | 报告字段 |
| LME105 answer-correct | 5%（D7 污染，先修 prompt） | — | ≥35% | ≥45% | judge+人工抽检 |
| LoCoMo60 any@5 | 74.1% | ≥78% | — | ≥85% | 配对检验 |
| latP50 | 2.7s | 不升 | 不升 | +离线成本 | latencyMs |

---

## 9. 与内部既有定案（F1–F10）的关系

`docs/research/2026-10-20-recall-precision-final-plan.md` 是**生产召回精度**路线（有效信息率 40% 目标）；本方案是**基准问答**路线。对应关系：

| 本方案 | 内部票 | 关系 |
|---|---|---|
| B2-a 闸门标定 | **F3/#99（已实证的坑）** | 同一根因，本方案有探针数据支持立即修 |
| B2-b MMR | F8 剥噪 | 同族 |
| B3 K=V+fact | F1 拆条 / F4 small-to-big | 同族，注意"不许只用摘要键" |
| B4 时间 | F6a/F6b | F6a 填 occurred_at 是前提 |
| B1 读侧 | 新增（基准问答才暴露） | — |
| — | F5 supersession | 与本方案不冲突，可并行（A4 阶段用 §10.1 的 Zep 式） |

---

## 10. 附录

### 10.1 值得抄的三个机制（9 系统深挖，`research/systems-deep-dive.md`）

| 机制 | 出处 | 为什么值得抄 | 何时做 |
|---|---|---|---|
| **四时间戳 + 失效标记**（`t_valid/t_invalid` + `t'_created/t'_expired`，失效规则 `t_invalid := 新边 t_valid`） | Zep arXiv:2501.13956 | 保留"当时为真"的历史，与零删除红线天然一致 | A4（supersession 落地时） |
| **三因子 heat 分层晋升/淘汰**（`Heat=α·N_visit+β·L_interaction+γ·R_recency`，μ=1e7、τ=5，晋升后清零 `L_interaction`） | MemoryOS arXiv:2506.06326 | 唯一可直接抄成代码的淘汰公式 | 记忆量起来之后 |
| **两段式链接**：embedding 粗筛 + LLM 精判；link generation 主力、memory evolution 精修（multi-hop F1 24.55→31.24→45.85） | A-Mem arXiv:2502.12110 Table 2 | 建链接比改旧条目值钱；链接不参与检索打分 | 若做跨会话关联 |

工程结论：Mem0 存储 7k tok/对话、Zep >600k（原文 26k 的 20 倍）——**图/多层结构 token 成本差两个数量级**；Mem0"抽取只依赖已就绪摘要 + 最近 m 条、摘要异步刷新"可照搬解耦写路径。

### 10.2 证据索引

- LongMemEval = **arXiv:2410.10813**（§4.2 设定差异、§5.2–5.5 粒度/键/CoN、Table 3/4/6/9）
- Lost in the Middle = arXiv:2307.03172（§4 位置效应）
- Mem0 = arXiv:2504.19413；Zep = arXiv:2501.13956；LoCoMo = arXiv:2402.17753
- 完整清单与"未核项"：`docs/research/benchmarks-and-optimizations.md`

### 10.3 v1→v2 勘误记录（本版已修正）

| v1 表述 | 复核后事实 |
|---|---|
| 「77 行证据轮完全未注入」 | 实为 **76/99 有标注题未达上限**（24 行零命中 + 52 行部分覆盖；另有 1 行无标注）；全覆盖 23 行 |
| avgHits=2.5 | 实为 **2.63**（LME100）；LoCoMo60 为 2.62 |
| LoCoMo60 any 60% / turn 40% | 实为 **74.1% / 47.7%**（MRR 0.431） |
| LME100 turn 46.1% | 实为 **46.6%**（0.4656） |
| 「生产 override minScore=−1.0」 | 生产 override **未设 minScore/candidates**，生效值=生产 yaml **−2.0 / 12**（`tdai-gateway.yaml:242-247`） |
| D1 两道门"嫌疑" | 已实证：**精排闸门通过率 14.2%**（§3.3 探针）；向量 0.3 门为次嫌疑，待 B0 归因 |

### 10.4 关键文件与命令速查

```
# 跑批（串行防 429）
cd D:/TDB/td-agemem/MemoryCore
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval --limit 100 --gen-limit 0 --pace 150
node --import tsx scripts/eval-memory-bench.mjs --dataset locomo --limit 60 --gen-limit 0 --pace 150

# 精排探针（零 API 配额）
node --import tsx .eval-data/bench/probe-rerank.mjs

# 池子诊断 / 报告生成
node --import tsx scripts/bench-diagnose.mjs <report.json>
node --import tsx scripts/bench-report.mjs <report.json>

# 关键代码锚点
MemoryCore/src/core/hooks/auto-recall.ts:2274   # candidateK = maxResults*3
MemoryCore/src/core/hooks/auto-recall.ts:2366   # 向量通道 cosine>=0.3 过滤
MemoryCore/src/core/hooks/auto-recall.ts:551-563 # sigmoid 精排闸门 + 全灭降级
MemoryCore/scripts/lib/bench/store.mjs:267      # validityNow（D6 待修）
MemoryCore/scripts/lib/bench/llm.mjs:95-113     # 回答 prompt（D7 待修）
D:/TDB/td-agemem/.eval-data/longmemeval_oracle.json  # LME 原始数据集
```
