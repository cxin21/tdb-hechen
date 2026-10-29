# 记忆评测基准（LongMemEval / LoCoMo）：口径、结果与差距

> 状态：可跑通、可复现。当前有效结果两份（LME oracle 100 题、LoCoMo 60 题），均为**检索指标**；生成+判分阶段见文末进度。
> 关联入口：`MemoryCore/scripts/eval-memory-bench.mjs`（跑数）、`MemoryCore/scripts/bench-report.mjs`（汇总）、`MemoryCore/scripts/lib/bench/*`（数据集/存储/指标）。

## 1. 为什么要这两个基准

- **LongMemEval**（`arXiv:2410.10813`，ICLR'25）：500 题，七种题型（single-session-user/-assistant/-preference、multi-session、knowledge-update、temporal-reasoning、abstention）。`_s` 约 115k tokens/题，`_m` = 500 sessions ≈ 1.5M tokens。**测的是"跨会话持续交互"**，答案往往是"某轮里的一句话"。
- **LoCoMo**（`arXiv:2402.17753`，ACL'24）：10 个人物长对话（最长 35 sessions / ~400 轮），1986 条 QA，category 1–5（multi-hop / temporal / open-domain / single-hop / adversarial）。

两者互补：LME 偏"抽取 + 多会话推理 + 时间"，LoCoMo 偏"长对话单点事实 + 多跳"。

## 2. 怎么跑

```bash
cd MemoryCore
# 首次需要数据集（存 .eval-data/bench/data/）
node scripts/eval-memory-bench.mjs --dataset longmemeval --limit 100 --gen-limit 0 --pace 150
node scripts/eval-memory-bench.mjs --dataset locomo     --limit 60  --gen-limit 0 --pace 150
# 带生成与判分（花配额，慢）
node scripts/eval-memory-bench.mjs --dataset longmemeval --limit 30 --gen-limit 30 --pace 150
# 汇总任何报告（只读，跑数期间也能用）
node scripts/bench-report.mjs .eval-data/bench/<report>.json
```

关键参数：`--dataset`、`--limit`（题数）、`--gen-limit`（前 N 题做生成+判分，0 = 只测检索）、`--pace`（embedding 请求最小间隔 ms）、`--recall-timeout`（单题召回硬超时）。

**embedding 是硬瓶颈**：doubao-embedding-vision 网关实测吞吐约 **22 次 HTTP/分钟**（429 需退避），灌库 1 万轮约 1 小时。跑数必须串行，并行只会互相 429。

## 3. 我们的结果（生产配置：doubao-embedding-vision 2048d + BM25 + local rerank，k=5）

### 3.1 LongMemEval oracle · 100 题 · 检索

`longmemeval-oracle-2026-10-26T14-57-58.json`｜灌库 100 组 / 3094 轮，写入失败 0，429 重试 1087

| 类别 | n | 会话命中@5 | turn 覆盖@5 | MRR |
| --- | ---: | ---: | ---: | ---: |
| temporal-reasoning | 60 | 100.0% [94.0–100] | 54.2% | 0.58 |
| multi-session | 40 | 100.0% [91.2–100] | 34.0% | 0.63 |
| **合计** | 100 | **100.0%** [96.3–100] | **46.1%** | **0.60** |

延迟 mean 2667ms / p50 2667 / p95 3283 / max 3881。

### 3.2 LoCoMo · 60 题 · 检索

`locomo-2026-10-26T15-12-16.json`｜1 组 / 419 轮，写入失败 0，429 重试 126

| 类别 | n | 会话命中@5 | turn 覆盖@5 | MRR |
| --- | ---: | ---: | ---: | ---: |
| temporal | 28 | 89.3% [72.8–96.3] | 78.6% | 0.73 |
| multi-hop | 23 | 60.9% [40.8–77.8] | 15.9% | 0.20 |
| open-domain | 9 | 44.4% [18.9–73.3] | 16.7% | 0.11 |
| **合计** | 60 | **71.7%** [59.2–81.5] | **45.3%** | **0.43** |

延迟 mean 2188ms / p50 2045 / p95 3236 / max 4537。

### 3.3 LoCoMo · 5 题 · 含生成判分（首批链路验证）

`locomo-2026-10-26T13-43-00.json`｜判分模型 scm-flash

会话命中 40%、turn 覆盖 20%、LLM 判对率 **40%**（2/5）、tokenF1 0.071。**n=5，仅供链路验证，不作结论。**

### 3.4 三个必须说清的口径

1. **oracle ≠ 真实**：LME oracle 是"每题自带 50 会话"的简版 haystack；`_s` 是 ~500 会话共享一个大池，难度完全不同。会话命中 100% 只在 oracle 下成立。
2. **检索 ≠ 答题**：本文所有百分比是召回指标。端到端判对率只有 3.3 那份（n=5）。
3. **题型覆盖不全**：`--limit 100` 按文件顺序切片，实际只覆盖 temporal(60) + multi-session(40)，缺失 knowledge-update / abstention / 三种 single-session。**出正式报告前必须做分层抽样。**

## 4. 与头部系统的差距

### 4.1 公开可比数（LoCoMo，LLM-as-judge）

来自 `arXiv:2504.19413` Table 1（各家同一数据集、同一 judge 口径下重跑）：

| 系统 | single-hop J | multi-hop J | open-domain J | temporal J | 均分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mem0 | 67.13 | 51.15 | 72.93 | 55.51 | 61.68 |
| Mem0^g（+图） | 65.71 | 47.19 | 75.71 | 58.13 | 61.69 |
| Zep | 61.70 | 41.35 | 76.60 | 49.31 | 57.24 |
| LangMem | 62.23 | 47.92 | 71.12 | 23.43 | 51.18 |
| OpenAI Memory | 63.79 | 42.92 | 62.29 | 21.71 | 47.68 |
| A-Mem* | 39.79 | 18.85 | 54.05 | 49.91 | 40.65 |

另有 LongMemEval 侧的公开对照（`arXiv:2501.13956` Table 2，LongMemEval_s）：全上下文 gpt-4o 60.2%/28.9s → Zep 71.2%/2.58s（相对 +18.5%）；gpt-4o-mini 55.4% → 63.8%（+15.2%）。**注意这是"端到端答题准确率"，不是召回。**

### 4.2 我们弱在哪：证据链

| 观测 | 数值 | 指向 |
| --- | --- | --- |
| 会话命中@5 vs turn 覆盖@5（LME） | 100% → 46.1% | 证据会话能定位，**关键轮次排不进 top-5** |
| 会话命中@5 vs turn 覆盖@5（LoCoMo） | 71.7% → 45.3% | 同上，且会话层也掉（419 轮单库更挤） |
| multi-hop / multi-session 的 turn 覆盖 | 15.9% / 34.0% | 跨会话、多跳题：**证据分散在多条 turn，k=5 装不下** |
| temporal 的 turn 覆盖 | 78.6% / 54.2% | 单点+时间型明显更好 |
| 延迟 | p95 3.2–3.3s | 主要花在 LLM 查询扩展，不是向量检索 |

### 4.3 三条机制差距（按"公开证据强度 × 我们的缺口"排序）

**差距 1：写入时不分解、不扩展键（decompose-on-write + key expansion）**

- 头部做法：Mem0 写入即把消息对抽成原子事实，并用 LLM 做 ADD/UPDATE/DELETE/NOOP 四决策（`arXiv:2504.19413` §2.1）；LongMemEval 的 CP2 证明**把 fact 拼接到原 value 上做索引键**可平均 +9.4% recall@k、+5.4% 端到端准确率，而**单独用压缩摘要做键反而崩**（Table 3：K=keyphrase 时 recall@5 从 0.582 → 0.282）。
- 我们的现状：存储是**原始 turn 文本 + 向量 + BM25**，没有事实层，也没做文档扩展。
- 为什么这解释我们的数字：Mem0 的 chunk-size 扫描（Table 2）显示最佳 RAG 块（256 token）J=50.15，而原子事实 67.13 —— **粒度而非检索算法**才是 single-hop 的主要差距来源。我们的 turn 覆盖 46% 正是"粒度太粗 + 键不含语义锚点"的表现。
- 注意反面：LongMemEval §5.2 明确"用摘要/事实**替换**原文会因信息损失掉分"，所以是**共存**不是替换。

**差距 2：没有时间轴，查询扩展不做时间约束**

- 头部做法：Zep 存四个时间戳（`t_valid`/`t_invalid`/`t'_created`/`t'_expired`），新信息矛盾时**只把旧边置为失效而不删**，并把时间区间直接写进 prompt（`arXiv:2501.13956` §2.2.3/§3）；temporal-reasoning 因此 36.5→54.1（+48.2%，gpt-4o-mini）。LongMemEval CP3 用 LLM 抽时间范围做过滤，round 作 value 时 +11.3% recall。
- 我们的现状：有 bitemporal 相关测试（`MemoryCore/src/core/recall/__tests__/bitemporal-two-path.test.ts`），但基准路径走的是纯"向量+FTS+rerank"，**没有把时间区间带入检索或 prompt**；查询扩展只扩语义、不抽时间窗。
- 风险提示（有出处）：CP3 的增益**强依赖抽时间的模型强度**——Llama 8B 抽错时间范围时 recall@5 反而 0.624 < 不扩展 0.639。我们的扩展模型若偏弱，这条要先做 A/B。

**差距 3：读取策略没有 CoN / 结构化上下文**

- 头部做法：LongMemEval CP4，检索项以 JSON 呈现 + Chain-of-Note（先逐条抽信息、再推理）；**oracle 检索下最优与次优读策略差最多 10 个绝对点**（GPT-4o），且"不用 CoN 时 JSON 并不稳定胜过自然语言"。
- 我们的现状：生成阶段把召回内容拼成纯文本喂模型（见 bench harness 的 `buildContext`），没有 CoN 指令、没有 JSON 结构、没有时间字段标注。
- 这条最便宜：不改存储、不改检索，只改 prompt 与上下文序列化。

**关于 k**：multi-session 的 turn 覆盖（34%）低于 temporal（54%）且 MRR 更高（0.63 > 0.58），说明"排序准但装不下"。A-Mem 的超参实验也显示 k 从 10→50 先升后平台甚至略降（噪声增加），所以 k 不是无脑加大，要配合去噪（MMR/rerank）。

### 4.4 我们**不**缺的

- **会话级召回**：oracle 下 100%，LoCoMo 71.7%，说明分块+hybrid+rerank 的骨架是有效的。
- **图结构**：Mem0^g 相对 Mem0 在 single-hop −1.42 J、multi-hop −3.96 J，只在 temporal/open-domain 赚（Table 1）——先把事实层与时间轴做对，再谈图。
- **拒答**：六个系统**无一实现**（Mem0 直接把 adversarial 类从评测剔除，`arXiv:2504.19413` §3.1）。这是全行业的空白，不是我们的短板；LME 的 abstention 题型可以拿来当我们的差异化点。

## 5. 待办

> 诊断与优先级见 [`optimization-plan.md`](./optimization-plan.md)（瓶颈归因 + 分档方案 + 验收门）；口径陷阱与 15 条机制清单见 [`research/benchmarks-and-optimizations.md`](./research/benchmarks-and-optimizations.md)。

- [ ] 分层抽样（七题型各 ~30 题）重跑 LME，消除"只有 temporal+multi-session"的偏差
- [ ] LME 30 题 / LoCoMo 30 题的生成+判分，拿到端到端判对率（进行中）
- [ ] 同 harness 自建两条基线：BM25-only（下界）、full-context（上限），把"水平"锚在自家口径内
- [ ] A/B：k=5→8；CoN+JSON 读策略；fact-augmented key（不改原文，只加索引键）

## 6. 引用清单

- `arXiv:2410.10813` LongMemEval（ICLR'25）— 七题型、四控制点、CP2/CP3/CP4 增益
- `arXiv:2402.17753` LoCoMo（ACL'24）— 长对话 QA 基准
- `arXiv:2504.19413` Mem0 — 抽取+四决策合并、LoCoMo 全表、chunk-size 扫描
- `arXiv:2501.13956` Zep/Graphiti — 双时间轴、边失效、三路检索+rerank、LME_s 结果
- `arXiv:2310.08560` MemGPT — 分层上下文、自编辑、分页
- `arXiv:2502.12110` A-Mem — 原子卡片、链接生成、memory evolution
- `arXiv:2506.06326` MemoryOS — STM/MTM/LPM、Heat 淘汰

**口径陷阱**：同一系统在不同论文里数字差异极大（MemGPT DMR 原文 84.0% vs Zep 论文引作 93.4%），引用必须带论文 ID + 表号；跨 harness 不可横比。
