# 召回插桩读数审计（LME 90 题）

- 审计对象：`MemoryCore/.eval-data/bench/lme90-*.json`（共 56 份，含 4 份主报告）
- 主口径 **A** = `lme90-r146-r146v2-deep-rj.json`（k=5，90 题，strategy=hybrid，rerank=local，candidateK=32，rerankFilterRule=floor，minScore=-10.5）
- 对比口径：**WIDE** `lme90-r146-r146c-wide-rj.json`（k=10）、**BEST** `lme90-r146-r146c-best-rj.json`（k=10+币值+建议口径）、**FACT** `lme90-r146-r146v2-deep-factrows-v4-rj.json`（事实行+遮蔽）
- 只读：未改任何源码；未重跑 bench；临时脚本全部落在 `MemoryCore/.eval-data/bench/`（已被 .gitignore 覆盖，`git status` 干净）。

## 0. 一句话结论

**整条召回链事实上只有一层在工作：`raw-turn`（BM25+向量融合 → rerank 分数地板 → k 截断）。**
结论层、layered 分层、importance 惩罚、事实通道、去重、父 turn 展开 —— 90 题 × 56 份报告里 **0 次生效**；
其中 4 项是**写入/配置侧根本没接线**（结论卡写入 0 条、事实通道无向量、去重与展开是 bench 诊断 flag），
不是"这次刚好没触发"。

## 0.1 先读：字段真实语义（否则后面数字会误读）

| 字段 | 真实语义（读源码确认） | 出处 |
| --- | --- | --- |
| `unresolved` | 前 k 行里 **turn id 解析失败**的行数（`top.length - ids.length`），不是"召回没解决" | `MemoryCore/scripts/lib/bench/metrics.mjs:52` |
| `hasEvidence` | **数据集**是否有 evidence 标注（`evSessions.length>0 \|\| evTurns.length>0`），与召回结果无关 | `MemoryCore/scripts/lib/bench/metrics.mjs:113` |
| `dupTurnHits` | 只在 bench 传 `--dedupe-hits-by-turn` 时才计数，否则恒 0（0 = 未开 flag，不是无重复） | `MemoryCore/scripts/eval-memory-bench.mjs:1053-1067, 1169` |
| `expandedHits` | 只在 bench 传 `--expand-parent-turn` 时才计数，否则恒 0 | `MemoryCore/scripts/eval-memory-bench.mjs:1109-1121, 1171` |
| `injectedLines` | 实际注入行数 = `hits.length`（不是 k 的切片） | `MemoryCore/scripts/lib/bench/metrics.mjs:114` |
| `blockChars` | 生产 injector 注入块**字符数**（与 b1 证据块口径不同） | 报告 `config.fieldSemantics.blockChars` |
| `gates.rerank.dropped` | **不是**精排丢弃数，恒等于 `passCount - kept`（90/90 逐题核对成立） | 见 §8 `audit-verify.mjs` |
| `gates.importancePenalty.penalized` | 被 importance 乘子**实际罚过**的行数 | `MemoryCore/src/core/tools/recall-signals*` |

> 关键：`unresolved` 与 `hasEvidence` 是本审计里最容易被当成"召回未解"报警信号的两个字段，
> 但它们在 90 题里**结构上不可能触发**。真正的缺口指标见 §6。

---

## 1. 各层触发率（按 90 题聚合）

### 1.1 四档对照

| 机制 / 读数 | A（k=5） | WIDE（k=10） | BEST（k=10） | FACT（k=5） |
| --- | --- | --- | --- | --- |
| `importancePenalty.penalized>0` 的题 | **0/90（0.0%）** | 0/90 | 0/90 | 0/90 |
| 被罚行数 / 候选行总数 | **0 / 1644** | 0 / 1643 | 0 / 1641 | 0 / 2551 |
| `importancePenalty.topChanged=true` | **0/90** | 0/90 | 0/90 | 0/90 |
| `rerank.dropped>0`（k 截断真的起作用） | 71/90（78.9%） | 45/90（50.0%） | 45/90（50.0%） | 69/90（76.7%） |
| `rerank.dropped=0`（**精排没起过滤作用**） | **19/90（21.1%）** | 45/90（50.0%） | 45/90（50.0%） | 21/90（23.3%） |
| `rerank.kept=k`（被填满到 k） | 78/90（86.7%） | 50/90（55.6%） | 51/90（56.7%） | 72/90（80.0%） |
| `rerank.passCount` 中位（分母 32） | 10.5 | 10.5 | 10.5 | 10 |
| 阈值通过率 `pass/32` | 34.6% | 34.6% | 34.5% | 32.5% |
| `conclusionCount>0` | **0/90（0.0%）** | 0/90 | 0/90 | 0/90 |
| `experienceCount>0` | **90/90（100%）** | 90/90 | 90/90 | 90/90 |
| `layered=true` | **0/90（0.0%）** | 0/90 | 0/90 | 0/90 |

### 1.2 rerank 三量分布（A，k=5，分母 candidateK=32）

| 量 | min | 中位 | max | 均值 / 总和 |
| --- | --- | --- | --- | --- |
| `kept` | 2 | 5 | 5 | 均值 4.71（**424** 行 / 90 题） |
| `dropped` | 0 | 5.5 | 21 | 总和 **572** |
| `passCount` | 2 | 10.5 | 26 | 均值 11.07（总和 **996** / 2880 候选 = 34.6%） |
| `threshold01` | — | — | — | **90 题只有 1 个取值**：2.7535691114583473e-05（= sigmoid(-10.5)） |

### 1.3 逐条结论

- **importance 惩罚：0/90 题罚中，0/1644 行被罚。** 所以这一层在本基线里**没有任何有效载荷**：1644 个候选全部以 `topRaw == topPenalized` 进出（90/90 题成立），乘子等于 1 —— 配置写了 `penalty=0.3`，实际乘的是 1.0（`enabled` 缺省 false，见 `MemoryCore/src/config.ts:2127-`；缺省关闭 = 零行为变化）。
- **精排的主滤镜不是"阈值"，是 32→passCount 那次地板切割（32→11，砍 65.4%）。** 所以这一层"看起来在工作"，但它砍的是**长尾底分**，不是"差一点就该丢"的边界样本。
- **`threshold01` 90 题只有一个值（2.75e-05）**：`minScore=-10.5` 换算成概率后是同一个常数门。所以这一层**没有逐题自适应能力**，任何"阈值调优"在本架构下都等价于调一个全局常数。
- **`dropped=0` 的 19/90 题（21.1%）**：passCount ≤ k，候选全进、**精排的 k 截断一步都没走**。所以这一层在这 21% 的题上贡献严格为零 —— 分数再怎么排，进块的集合都不变。
- **`kept=k` 的 78/90 题（86.7%）** 说明 k=5 的槽位是**被填满**的：所以限制召回的不是"没东西可给"，而是"被 pass 的 11 条里只能留 5 条"，这正是 §6 覆盖率缺口的直接来源。
- **结论层 `conclusionCount>0` = 0/90，且 `ingest.conclusionsWritten=0`、`conclusionLinks=0`（每份 r146 报告都如此）。** 所以这一层**根本没有数据**：库里一张结论卡都没写，不是路由把它挡掉了（`auto-recall.ts:1094-1104` 的 assistantRecall 跳过只是第二重原因）。
- **经验层 `experienceCount>0` = 90/90（259 行，中位 2/题）**：所以真正在供货的只有经验层（=raw-turn 记忆行），链路是单层的。
- **`layered=true` = 0/90。** `layered` 定义是 `r7InjectedConclusions > 0`（`MemoryCore/src/core/hooks/auto-recall.ts:1917`）。所以这个布尔字段永远 false —— 它是结论层的影子指标，结论层零产 → 它必然零。
- **读数之外的提示**：BEST 与 WIDE 的检索读数逐位相同（sessionCovInjected 93.2%、turnCovInjected 79.3%、mrr 0.6897/0.6895），但 `genCorrect` 从 66.7% → 73.3%。所以当前 90 题上的增益已**不在召回层**，而在作答/判分口径。

---

## 2. lineTypeStats 分布（注入行按类型）

| 类型 | A 行数 | 行占比 | 出现题数 | gold 行 | WIDE 行数 | BEST 行数 | FACT 行数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `raw-turn` | **259** | **100.0%** | **90/90** | 90 | 406 | 402 | 264 |
| `conclusion` | **0** | 0.0% | 0/90 | 0 | 0 | 0 | 0 |
| `evidence-recall` | **0** | 0.0% | 0/90 | 0 | 0 | 0 | 0 |
| `unknown` | **0** | 0.0% | 0/90 | 0 | 0 | 0 | 0 |

| 一阶归因（A 全 90 题均值） | 抽掉该类型后的 turnCov | sessionCov | 剩余注入行 |
| --- | --- | --- | --- |
| `coverageWithout.raw-turn` | **0.00** | **0.00** | **0** |
| `firstOrderDrop.raw-turn`（该类型独占的贡献） | **0.70** | **0.89** | — |

- **`raw-turn` 占 259/259 = 100% 的行、90/90 的 gold 行。** 所以这一层就是整条链路：其余三类的行数为 0，连"偶尔掺一点"都没有。
- **抽掉 `raw-turn` 后覆盖率归零（turnCov 0.00 / sessionCov 0.00 / 注入行 0）。** 所以不存在"备用通道兜底"：主通道一关就是全黑。
- **`firstOrderDrop.raw-turn` 的 turnCov 0.70 对总 turnCov 0.728 ≈ 96%。** 所以其余类型的边际贡献是 **4% 以内**，而且观测值为 0 —— 90/90 题里没有任何一题因为"抽掉 conclusion / evidence-recall / unknown"而改变覆盖率。
- **结论行 0 行与 §1 的 `conclusionCount=0` 是同一件事的两种记法。** 所以"结论层贡献"这个问题的答案不是"小"，是"未上线"。

---

## 3. 各阶段耗时占比（A，以 4 段合计为分母）

| 阶段 | 中位 ms | 均值 ms | P90 ms | 总量 | 占总时长 |
| --- | --- | --- | --- | --- | --- |
| `embeddingMs` | **167.44** | **182.74** | 243.09 | 16446.91 ms | **94.81%** |
| `ftsMs` | 9.12 | 9.86 | 13.62 | 887.69 ms | 5.12% |
| `factMs` | **0.118** | **0.131** | 0.182 | 11.83 ms | **0.07%** |
| `expandMs` | **0** | **0** | 0 | 0 ms | **0.00%** |
| 四段合计 | 179.09 | 192.74 | — | 17346.42 ms | 100% |
| `rerank.ms`（不在四段内） | 473.25 | 809.43 | — | — | 端到端 p50 727.5 的 **65.0%**；均值维度 **78.2%** |

- **`embeddingMs` 占四段总时长的 94.81%（中位 167 ms）。** 所以这一层是召回侧唯一的重成本：BM25 只有 9 ms，二者差 18 倍。
- **`factMs` 中位 0.118 ms、最大 0.39 ms（A）/ 3.80 ms（BEST），且 `factHits=0` 在 90/90 题成立。** 所以事实通道**确实在被调用，但库中没有事实通道向量 → 每次都空查**（`MemoryCore/src/core/hooks/auto-recall.ts:3089-3098` 计时的是这次空查；`MemoryCore/src/utils/pipeline-factory.ts:109` 正是这条"读侧开了写侧不是 channel 模式 → 通道只会空查"的护栏文案）。
- **`expandMs` 在 90/90 题为 0。** 所以展开通道一次都没跑（bench 未开 `--expand-parent-turn`）。
- **`rerank.ms` 中位 473 ms，占端到端 p50 的 65%，占均值 78%。** 所以"召回慢"这个问题的答案不在 embedding，在本地精排；WIDE 更甚（中位 733 ms，占 p50 的 76%）。
- **四段合计中位 179 ms，端到端中位 727 ms。** 所以 75% 的耗时发生在四段检索**之外**（精排 + 组装注入块）。

---

## 4. 去重 / 扩展通道

| 读数（A） | 值 |
| --- | --- |
| `dupTurnHits>0` 的题 | **0/90（0.0%）**，总和 0 |
| `expandedHits>0` 的题 | **0/90（0.0%）**，总和 0 |
| `expandMs>0` 的题 | **0/90** |
| 二者任一 >0 的题 | **0/90** |
| `hits > 0` 的题 | 90/90（每题至少 2 条） |

- **基线档里 `dupTurnHits`、`expandedHits` 恒 0，因为 bench 没传 `--dedupe-hits-by-turn` / `--expand-parent-turn`（`config.dedupeHitsByTurn=false`、`config.expandParentTurn=false`）。** 所以这两个 0 **不代表"没有重复、不需要展开"**，只代表"仪器没接在产线上"。
- **交叉核对：把 flag 打开后两通道都高频工作。** `lme90-r146-r146-b1off-factrows-dedupe10.json` 的 `dupTurnHits>0` 为 **31/90（34.4%）**；`lme90-r146x-e1.json` / `e1gen` 的 `expandedHits>0` 为 **77/90（85.6%）**；`lme90-r146s-expand.json` 为 81/90。所以这两条通道**不是死代码，是默认没开**。
- **真实的同 turn 塌缩确实在发生，只是没被 `dupTurnHits` 记到：** A 里 `kept > hits` 的题 **73/90（81.1%）**，`kept - hits` 均值 **1.83**、中位 **2**（5 条候选塌成约 3 条 turn），`hits == injectedLines` **90/90**。所以"32→11→5→2.9 行"这条链上，**文档级→turn 级的折叠是第 4 道真实的过滤器，但它不在任何插桩字段里**（WIDE 同样 71/90，塌缩 3.52）。

---

## 5. 注入预算（blockChars）

| 读数 | A（k=5） | WIDE（k=10） | BEST（k=10） | FACT（k=5） |
| --- | --- | --- | --- | --- |
| `blockChars` min | 469 | 469 | 469 | 469 |
| 中位 | **2953.5** | 4128.5 | 4128.5 | 3087 |
| 均值 | 3276.9 | 5412.5 | 5363.7 | 3276.9 |
| P90 | 6047 | 10810 | 10797 | 5974 |
| max | **9394** | **20280** | **20280** | 9575 |
| >5000 字符的题 | 16/90（17.8%） | 36/90（40.0%） | 36/90 | 17/90（18.9%） |
| >6000 字符的题 | 10/90（11.1%） | 30/90（33.3%） | 30/90 | 9/90（10.0%） |
| `injectedLines` 总和 / min / 中位 / max | 259 / 2 / 2 / **5** | 406 / 2 / 3 / **10** | 402 / 2 / 3 / **10** | 264 / 2 / 2.5 / **5** |
| `injectedLines == k` 的题 | **11/90（12.2%）** | 7/90（7.8%） | 6/90（6.7%） | 12/90（13.3%） |
| 每行平均字符 | 1144 | 1195 | — | — |
| **触及 `maxTotalRecallChars` 上限的题** | **0/90** | **0/90** | **0/90** | **0/90** |

- **`maxTotalRecallChars` 在这 4 份报告里都没有配置（缺省 0 = 不封顶，`MemoryCore/src/config.ts:2104`；`auto-recall.ts:4011` 无预算时直接跳过收口）。** 所以"有几题触到上限"的答案是 **0，因为上限不存在** —— 这不是"没触到"，是"没设"。
- **若按 6000 字符设上限：A 会有 10/90（11.1%）题被截，WIDE 会有 30/90（33.3%）题被截。** 所以 k=10 档的预算已经在失控边缘（max 20280 字符 ≈ k=5 档最大值的 2.2 倍）。
- **注入行中位 2 行、只有 11/90 题（12.2%）填满 k=5。** 所以 `blockChars` 的肥瘦主要由**单行长度**（均值 1144 字符/行，smallToBig 最多 +4 行）驱动，而不是行数；预算话题应当量"每行字符"而不是"槽位数"。
- **A 与 FACT 的 `blockChars` 均值几乎相同（3276.9 vs 3276.9），但 FACT 的 `injectedLines` 中位 2.5 > A 的 2。** 所以事实行/遮蔽档多塞了行、同时压短了行，净载荷不变 —— 该档改的是"行的形态"，不是"预算"。

---

## 6. 召回未解（真实缺口 vs 两个死表）

| 读数（A） | 值 | 说明 |
| --- | --- | --- |
| `unresolved>0` 的题 | **0/90** | 56 份报告全为 0：所有命中行都带 `turnId`，解析链健康 |
| `hasEvidence=false` 的题 | **0/90** | 56 份报告全为 true：LME oracle 每题都有证据标注 |
| `hits=0` 的题 | **0/90** | 每题至少 2 条命中，不存在空块 |
| `turnCovInjected < 1` 的题 | **90/90** | 均值 **72.8%** → gold turn 有 27.2% 没进块 |
| `sessionCovInjected` | **89.3%** | 10.7% 的题连 gold session 都没捞全 |
| `evidenceSufficiency.score == 0` | **18/90（20.0%）** | 注入块里**一个字都没覆盖 gold 答案 token** |
| `evidenceSufficiency.score < 0.5` | **40/90（44.4%）** | 近乎无证据 |
| `evidenceSufficiency.score` 中位 | 0.631 | 有一半题证据覆盖率不到 63% |

- **`unresolved` 与 `hasEvidence` 在结构上不可能报警（0/90 与 0/90，56 份报告一致）。** 所以这两个字段**不能当召回健康度告警项**；拿它们做看板会长期显示"一切正常"。
- **真正的未解缺口是 `turnCovInjected`：90/90 题都 <1，均值 72.8%。** 所以"召回没解"发生在 **27.2% 的 gold turn 上**，而不是 0。
- **`evidenceSufficiency.score==0` 的 18 题（20%）才是"硬未解"** —— 块里有字，但没有一个 gold token；另有 22 题（24.4%）覆盖 <50%。所以约 **44% 的题处在"有块无据"区间**，这与 A 的 `refused=31.1%`、`genCorrect=62.2%` 同一量级，佐证瓶颈在证据覆盖而非排序。
- **`hits` 中位 2（WIDE 3）**：所以注入的行数远小于 k —— 收紧的不是"取多少"，而是"能取到多少不重复的 turn"。

---

## 7. 几乎从不触发的机制（触发率从低到高）

排序规则：按 A（k=5 基线）触发率升序；同率者按"是否有写入/接线证据"再按"开启后的实测触发率"排。

| # | 机制 | 触发率（A，90 题） | 一句话 | 性质 |
| --- | --- | --- | --- | --- |
| 1 | **结论层注入**（`conclusionCount>0` / `conclusion` 行） | **0.0%**（0/90 题、0/259 行） | 库里 `conclusionsWritten=0`，不是本次没命中 | 写入侧未接线 |
| 2 | **layered 分层**（`layered=true`） | **0.0%**（0/90） | 定义即"结论行>0"，是 #1 的影子字段 | 派生指标，必然 0 |
| 3 | **importance 惩罚**（`penalized>0`） | **0.0%**（0/90 题、0/1644 行） | 乘子恒 1，`topRaw==topPenalized` 90/90 | 配置缺省关闭 |
| 4 | **事实通道命中**（`factHits>0`） | **0.0%**（0/90） | 通道被调用但空查，耗时 0.118 ms（0.07%） | 写入侧未走 channel |
| 5 | **去重通道**（`dupTurnHits>0`） | **0.0%**（0/90） | bench flag 未开；开启档实测 34.4%（31/90） | 默认未接产线 |
| 6 | **父 turn 展开**（`expandedHits>0`） | **0.0%**（0/90；`expandMs` 全 0） | bench flag 未开；开启档实测 85.6%（77/90） | 默认未接产线 |
| 7 | **`evidence-recall` 行** | **0.0%**（0 行） | 4 类行里 3 类为 0，链路无备用通道 | 未产出行 |
| 8 | **`unknown` 行** | **0.0%**（0 行） | 归因器没产出未分类行（说明分类链是干净的，不是没用） | 结构性 0（正常） |
| 9 | **`injectedLines` 填满 k** | **12.2%**（11/90） | 靠 turn 级塌缩省槽（kept 5 → 注入中位 2） | 受限于可去重 turn 数 |
| 10 | **rerank 的 k 截断真正生效**（`dropped>0`） | **78.9%**（71/90） | 21.1% 的题 passCount≤k，精排白跑 | 半有效 |
| 11 | **`raw-turn` 行** | **100.0%**（259/259） | 唯一在工作的一层 | 全部产出 |

补充两条"看起来在工作、其实没在工作"的：

- **rerank 的分数地板是常数**：`threshold01` 90 题只有 1 个值（2.7535691114583473e-05）。所以它是"全局常数门"，不是逐题自适应门 —— 任何"调阈值"实验都等价于调这一个数。
- **`unresolved` / `hasEvidence` 永远不报警**（见 §6）。所以任何基于这两个字段的健康度看板都应当撤掉，换 `turnCovInjected` 与 `evidenceSufficiency.score`。

---

## 8. 复现命令

脚本全在 `MemoryCore/.eval-data/bench/`（.gitignore 覆盖，不入库）：

```bash
cd D:/TDB/td-agemem

# 1) 4 份主报告 × 6 组指标的完整 JSON（§1-§6 全部原始读数）
node MemoryCore/.eval-data/bench/audit-instrumentation.mjs

# 2) kept/hits 塌缩、耗时占比、firstOrderDrop 分解
node MemoryCore/.eval-data/bench/audit-extras.mjs

# 3) 56 份报告逐份对照（证明结论层/importance/unresolved 是结构性 0，不是单次偶然）
node MemoryCore/.eval-data/bench/audit-crosscheck.mjs

# 4) rerank 恒等式核对：dropped == passCount - kept、kept == min(passCount, k)
node MemoryCore/.eval-data/bench/audit-verify.mjs

# 5) 文中引用的取整数字（trigger 率、blockChars 分布、sufficiency 计数）
node MemoryCore/.eval-data/bench/audit-final.mjs

# 6) conclusionsWritten / factExtraction / factChannel 逐份核对
node MemoryCore/.eval-data/bench/audit-ingest.mjs
```

单点抽查（不写文件）：

```bash
# 某题的全部插桩字段
node -e "const j=require('D:/TDB/td-agemem/MemoryCore/.eval-data/bench/lme90-r146-r146v2-deep-rj.json');const r=j.rows[0];console.log(JSON.stringify({strategy:r.strategy,layered:r.layered,conclusionCount:r.conclusionCount,experienceCount:r.experienceCount,searchTiming:r.searchTiming,gates:r.gates,lineTypeStats:r.lineTypeStats.byType,dupTurnHits:r.dupTurnHits,expandedHits:r.expandedHits,blockChars:r.blockChars,injectedLines:r.injectedLines},null,1))"

# conclusionsWritten 是否真的全是 0
node -e "const fs=require('fs'),p='D:/TDB/td-agemem/MemoryCore/.eval-data/bench/';console.log(fs.readdirSync(p).filter(f=>/^lme90-.*json$/.test(f)).map(f=>{try{const j=JSON.parse(fs.readFileSync(p+f,'utf8'));return (j.config&&j.config.tag)+':'+((j.config&&j.config.ingest&&j.config.ingest.conclusionsWritten))}catch(e){return false}}).filter(Boolean).join(' '))"
```

---

_审计口径：全部数字取自报告内已落盘的逐题插桩字段，未发起任何模型调用；如需重算，用 §8 的 6 条命令即可逐位复现。_
