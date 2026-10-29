# LLM 记忆系统：基准全景、评测口径陷阱与可落地优化清单

> 调研日期：2026-10-26 ｜ 目标仓库：`td-agemem` ｜ 范围：只读调研，不改业务代码、不碰 `.eval-data/`、不跑评测。
> 证据约定：所有数字尽量落到「arXiv ID + 表号/节号」；未取到原文表或仅工程经验的，显式标注 `无公开量化` / `未核` / `本地计算`。
> 本报告对每条优化都标了在本仓库假设架构上的**适配难度**：`原始 turn 存值 + 向量召回 + BM25 + 本地 rerank，k=5`。

---

## 0. TL;DR（给没时间的人）

1. **基准本身不是瓶颈，口径才是。** LongMemEval 同一套 500 题，`oracle`（只给证据 session）、`_s`（115k tokens）、`_m`（500 sessions ≈ 1.5M tokens）三个设定下的分数不可比；论文自报长上下文 LLM 从 oracle 到 `_s` 掉 30%–60%（arXiv:2410.10813 §4.2）。任何"我们涨了 X 分"必须先写清设定。
2. **最便宜的确定性收益在读取侧，不在检索侧。** CoN + JSON 结构化读取在 oracle 检索下最多值 **10 个绝对点**（2410.10813 §5.5 / Fig.6），改的是 prompt + 序列化，几乎零架构成本。
3. **索引侧的性价比之王是 value 粒度 + fact 增强键**，但它有硬反例：**只用压缩键（summary/keyphrase 单独作 key）会崩**（2410.10813 Table 3，session 粒度 `K=summary` 的 QA Top-10 从 0.676 掉到 0.252）。必须 `K = V + fact`（文档扩展式拼接），不能替换。
4. **时间感知查询扩展是"看模型"的优化**：GPT-4o 抽取时间窗时 temporal 子集 recall@5 从 0.421→0.451，而 Llama-3.1-8B 抽取时掉到 **0.384（低于不开的基线）**（2410.10813 Table 4）。弱抽取模型反噬有直接证据。
5. **Top 3 先做**：① CoN+JSON 读取 + 按时间戳排序打包；② hybrid(RRF) 融合 + 现有 local rerank 前移为"融合后重排"；③ value 粒度切到 round/turn 并加 `K=V+fact` 文档扩展（抽取用小模型离线批处理）。

---

# 第一部分：基准全景与方法论

## 1.1 主流基准清单

| 基准 | 论文 | 题数 / 规模 | 题型 | 评什么 | 公开 leaderboard |
|---|---|---|---|---|---|
| **LongMemEval (LME)** | arXiv:2410.10813 | 500 题；`LME_S` ≈115k tokens/题，`LME_M` = 500 sessions ≈1.5M tokens/题 | 7 类：single-session-user / -assistant / -preference、multi-session、knowledge-update、temporal-reasoning、abstention | 5 项能力：信息抽取、跨 session 推理、时序推理、知识更新、拒答 | **无官方榜**；只有论文表格 + 第三方各自复跑（Zep、Mem0、Supermemory 各报自己的数，口径互不可比） |
| **LoCoMo / DMR** | arXiv:2402.17753 | 50 段超长对话，平均 300 turns / 9K tokens / 最多 35 sessions；QA 约 200 题/对话 | 5 类：single-hop、multi-hop、temporal、open-domain(commonsense)、adversarial；另有 event summarization、多模态对话生成 | 长程 recall + 时序/因果 + 拒答 + 摘要 | **无官方榜**；LoCoMo 已成事实标准，被 Mem0/Zep 当作主榜复跑（Mem0 只用其中 10 段 ≈600 dialogues/26k tokens，见 2504.19413 §4.1） |
| **MemoryAgentBench** | arXiv:2507.05257 | 把既有长上下文数据集改造成多轮增量注入 + 自建 `EventQA`、`FactConsolidation` | 按 4 项能力组织：Accurate Retrieval / Test-Time Learning / Long-Range Understanding (≥100k tokens) / Selective Forgetting | 记忆体（memory agent）在增量注入下的检索、在线学习、全局理解、选择性遗忘 | 无官方榜；论文给统一评测框架 |
| **MemBench** | arXiv:2506.21605（ACL 2025） | 事实记忆 + 反思记忆两级；participation / observation 两场景；**全部多选题** | 8 类：sh / mh / comp / agg / pp / ku / ssa / msa（见论文 Table 8/9 图例） | 4 指标：accuracy、recall（检索命中）、capacity（容量拐点）、temporal efficiency（读写耗时） | 无官方榜；GitHub `import-myself/Membench` |
| **MemoryBench** | arXiv:2510.17281 | 11 个公开数据集、3 领域（开放域/法律/学术）、4 种任务形态、2 语言；外挂"用户反馈模拟" | 异构任务（写作、检索、问答…），非纯 QA | **持续学习**：把用户反馈日志转成后续任务上的增益（declarative + procedural memory） | 无官方榜；GitHub `THUIR/MemoryBench` |
| **MemGym** | arXiv:2605.20833 | 5 条 track：包 `τ²-bench`、`SWE-Gym`、`WebArena-Infinity` + 自建 `MemGym-DR`（10K–1M tokens）、`MemGym-CodeQA` | agentic 长程任务（工具对话、多轮检索、编码、电脑操作） | **memory-isolated score**：固定 reasoner，只让 memory 变化，分离"记忆失败"与"推理失败" | 无官方榜；有 project page + 训练数据管线 + `MemRM`（Qwen3-1.7B QLoRA，SWE-Gym IID AUROC 0.985） |
| **HaluMem** | arXiv:2511.03506 | `HaluMem-Medium` / `-Long`：各约 1.5 万 memory points、3.4k+ 题；平均 1.5k / 2.6k turns，上下文 >1M tokens | 3 个**操作级**任务：memory extraction、memory updating、memory QA | 幻觉定位：抽取阶段（accuracy/coverage）、更新阶段（consistency）、QA 阶段（错误引用/编造） | 无官方榜；HF `IAAR-Shanghai/HaluMem` |
| **PerLTQA** | arXiv:2402.16288 | 个人长期记忆数据集：profile + social relationships + events（具体条数未核） | memory classification / retrieval / synthesis 三任务 | 结构化个人记忆的分类、检索与合成 | 无 |
| **MSC (Multi-Session Chat)** | arXiv:2107.07567 | 每段 1–4 sessions（LoCoMo Table 1 对比口径） | 多 session 对话 | 早期长程一致性；现已饱和，只作 baseline 对照 | 无（历史数据集） |
| **PrefEval** | arXiv:2502.09597（ICLR 2025） | 偏好跟随任务集（规模未核） | 从对话中抽取偏好 → 后续任务是否遵守 | 个性化偏好跟随 | 无 |
| **DMR** | MemGPT（arXiv:2310.08560）定义，题取自 LoCoMo 对话 | 子集评测 | 检索式问答 | 深度记忆检索（已被 LME/LoCoMo 取代） | 无；Zep 报 94.8% vs MemGPT 93.4%（2501.13956 Abstract） |

**选型建议（针对我们）**：主榜用 **LME**（题型分层清晰、有 abstention、有 `_s/_m` 两档长度、community 复跑多），副榜用 **LoCoMo**（多 hop 与 temporal 分布更"脏"，抗过拟合），**HaluMem** 只在我们关心"写入期幻觉累积"时接（它的操作级指标能定位到抽取/更新阶段，比端到端 QA 更适合做归因）。MemGym 的成本（Docker/rollout）对当前阶段不划算。

## 1.2 每个基准的一句话定位

- **LME**：唯一把"记忆能力"拆成 5 项且带 abstention 的合成长程对话基准；优势是可自由加长历史（500 sessions），劣势是对话主题多样性低、偏"信息检索+整合"，被 MemoryAgentBench 明确批评 "limited topical diversity and less realistic interaction patterns"（2507.05257 §1）。
- **LoCoMo / DMR**：人类校验过的超长多方对话（人工改了约 15% 的 turn、替换约 19% 的图片，2402.17753 §3.4），事件图驱动，天然含时序与因果；缺点是只有 50 段、统计功效低，且 adversarial 类对长上下文模型极不友好（论文报 adversarial 上比 base 低 83%，§4）。
- **MemoryAgentBench**：把"记忆"与"长上下文"分开——记忆是增量注入 + 压缩表示，长上下文是一次性喂全文；它的 4 项能力里 **Selective Forgetting** 是最容易被我们忽略的（旧事实覆盖）。
- **MemBench**：唯一系统测 **capacity（容量拐点）** 与 **efficiency（读写耗时）** 的；全 MCQ 设计规避了 judge 噪声，但代价是题型偏"可选项判别"。
- **MemoryBench**：把"记忆"从 QA 拉到 **服务期持续学习**（用户反馈 → 后续任务变好），是"记忆有没有用"的最强证据形态，但工程接入成本最高。
- **MemGym**：把 memory 从 reasoner 里剥出来的评测范式（`memory gain`），并证明**不 fictionalize 就会被预训练知识污染**（不做虚构替换时 frontier 模型靠预训练就能答对，`no-memory` 掉不到 0；2605.20833 §C.6）。这条对任何自建评测都是硬警告。
- **HaluMem**：把幻觉拆到"抽取/更新/QA"三段，能证明"抽取期幻觉会向下游传播"（2511.03506 Abstract）。

## 1.3 评测口径陷阱（重点）

### (a) oracle vs `_s` vs `_m` 不是同一道题

- `oracle`：只给证据 session（LME 用它做"上限"分析，§4.2 / Fig.6）。
- `_s`：≈115k tokens 的完整历史（50 sessions）。
- `_m`：500 sessions ≈1.5M tokens。
- 论文实测：从 oracle 到 `_s`，GPT-4o / Llama-3.1 / Phi-3 掉 **30%–60%**，且加不加 CoN 都一样掉（2410.10813 §4.2）。Zep 在 `_s` 上 full-context 只有 55.4%（gpt-4o-mini）/60.2%（gpt-4o），而它的记忆管线是 63.8%/71.2%（2501.13956 Table 2）。
- **纪律**：任何对比必须写 `setting ∈ {oracle, s, m}` + `k` + `reader model` + `judge`。我们的 harness 若默认 `_m`，分数会天然比社区报的 `_s` 低 15–25 点，别误判为"我们更差"。

### (b) 检索指标 ≠ 端到端判对率（两者会背离）

LME Table 3 里最刺眼的一行：`Value=Session, K=summary` 的 recall@5 是 0.572（只比 `K=V` 的 0.706 低 13pp），但 GPT-4o 的 QA **Top-10 从 0.676 崩到 0.252**（2410.10813 Table 3）。原因：摘要键召回的是"主题相近但细节缺失"的条目，retrieval 看着还行，reader 拿不到可回答的证据。
→ **必须双报**：`recall@k`（含 NDCG@k）+ `answer accuracy`；单报 recall 会把"摘要化"这类破坏性改动判成"略有损失"。

### (c) LLM-as-judge 的可靠性有数，但不是万能

- LME：prompt-engineered GPT-4o judge，与人类专家一致率 **>97%**；分工况 meta-eval 平均 **0.98**（GPT-4o 答案）/ **0.97**（Llama-3.1-8B 答案），最低是 `single-session-preference` 0.90 与 `abstention` 0.90（2410.10813 Table 6，每类 30 题）。
- 含义：**偏好类与拒答类是 judge 最不可靠的两类**，恰好也是我们最想优化的两类。这两类要么人工抽检 ≥30 条，要么用规则化（拒答=是否明确说"不知道/未提及"）双判。
- LoCoMo 传统上报 F1 / BLEU-1 / judge 三件套（2402.17753 §4；Mem0 复跑时用 gpt-4o-mini 判 J，2504.19413 Table 1 脚注）。**F1/BLEU 对"同义但正确"的答案惩罚极重**，Mem0 自己也只把 J 当主指标。
- MemBench 干脆全改 MCQ（2506.21605 §4.1），把 judge 噪声换成"选项猜测"噪声——两类噪声不同，别混着比。

### (d) k 的选择能翻转结论

- 同一配置下 `@5 → @10` 的 recall 变化可以很大：`Value=Round, K=V, BM25` 从 0.472 → 0.538（+6.6pp），Stella 从 0.660 → 0.784（+12.4pp）（2410.10813 Table 9）。
- Mem0 的 RAG baseline：`chunk=128, k=1` 的 J=47.77，`k=2` 时 **59.56（+11.8 绝对点）**（2504.19413 Table 2）。也就是说"RAG 不行"这个结论在 k=2 时就不成立了。
- 我们的 k=5 处在中间地带：**必须同时报 `@5` 与 `@10`（或 `@k` 与 `@2k`）**，否则"rerank 有用/没用"会随 k 漂移。

### (e) 题型分布偏差：按文件顺序切片会漏掉什么

实测风险（工程观察，非论文数字）：LME / LoCoMo 的 JSON 通常按 `question_type` 或按对话 id 聚集排列，`head -n 100` 这类切片极易只覆盖 `single-session-*`，于是：

- 漏掉 **multi-session**（唯一需要跨 session 综合的类）→ 系统看起来"已经很好"，实际跨 session 能力为 0；
- 漏掉 **temporal-reasoning** → 时间过滤/时间戳排序类改动无法被验证（收益被低估为 0）；
- 漏掉 **abstention** → 检索"宁滥勿缺"的策略不受惩罚，recall 导向的改动会系统性过评；
- 漏掉 **knowledge-update** → 去重/覆盖策略（新事实替换旧事实）的错误不可见；
- LoCoMo 上漏掉 **adversarial** → 同上，且 adversarial 恰是长上下文模型最差的一类（比 base 低 83%，2402.17753 §4）。

**纪律**：切片必须**按题型分层**，且把"每类实际题数"打进报告头。

### (f) 重复次数与置信区间

- LME 500 题、准确率 p≈0.7 时，95% CI ≈ **±4.0pp**（本地计算：`1.96·sqrt(0.7·0.3/500)`）。
- 换成 100 题切片：**±9.0pp**；50 题：**±12.7pp**；30 题：**±16.4pp**。
- 结论：**<100 题的对比不要声称"提升"**；同一批题上的 A/B 必须用**配对**检验（McNemar 或 paired bootstrap 1000 次），配对能把方差压掉一大截（同一题难度被消掉）。
- LLM 采样温度：judge 温度 0（Mem0 复跑 A-Mem 时明确设 temperature=0，2504.19413 Table 1 脚注）；reader 若必须采样，报 3 次均值 ± 标准差。

## 1.4 分层抽样方案（可直接执行）

目标：在**不跑全量**的前提下，让每个题型的估计误差可控、且改动可归因。

**方案 A（迭代期，~15 分钟/轮）**：LME 按 7 类各取 `n=15` → 105 题；LoCoMo 按 5 类各取 `n=15` → 75 题。
**方案 B（定稿期，报告用）**：LME 7 类各 `n=40` → 280 题（占 56%）；LoCoMo 5 类各 `n=30` → 150 题。
**规则**：
1. 若某类总题数 < 配额 → **全取**，并在报告里注明该类"全量，非抽样"。
2. 固定随机种子 `seed=20261026`，用 `random.Random(seed).sample(sorted(pool), n)`（先按稳定 key 排序再抽，保证跨机器可复现）。
3. 抽样结果落 `manifest.csv`：`bench,setting,question_id,question_type,seed,stratum_n,pool_n`。**manifest 进版本库**，任何分数必须能追到 manifest。
4. abstention 类单独加倍配额（judge 最不稳 + 最能暴露"宁滥勿缺"）。
5. 报告三件套：`per-type n / per-type acc / 总体 acc（按 pool 加权，不按样本加权） + 95% CI + 配对检验 p 值`。
6. 抽样只做一次，**后续所有实验复用同一 manifest**（换 manifest 等于换考题，A/B 失效）。

---

# 第二部分：可落地优化手段清单

## 2.0 我们的基线（假设）

```
写入：原始 turn 逐条落库（不分 session/round 语义）
索引：turn 文本 → embedding（向量）；同一文本 → BM25 倒排
检索：向量 top-N ∪ BM25 top-N → 本地 rerank 模型 → k=5 → 拼 prompt
读取：直接把 5 条 turn 按检索分数顺序塞进 prompt
```

下文的"适配难度"都相对这个基线。

## 2.1 排序总览（改动成本 × 预期收益）

| # | 优化项 | 层 | 预期收益（出处） | 成本 | 风险/反例 | 适配难度 |
|---|---|---|---|---|---|---|
| 1 | CoN + JSON 读取格式 | 读取 | 最多 **+10 绝对点**（2410.10813 §5.5/Fig.6，oracle 设定，GPT-4o） | 极低（prompt） | 无 CoN 时 JSON 反而"不稳定优于 NL"；JSON 会吃 token | 低 |
| 2 | 按时间戳排序打包 + lost-in-the-middle 规避 | 读取 | 位置效应可使准确率相对下降 >20%（2307.03172 §4，20 文档设定） | 极低 | 时间戳缺失时排序无意义；把最新放尾部与"时间序"可能冲突 | 低 |
| 3 | hybrid(RRF) 融合 + rerank 后置 | 检索 | BM25 与 dense 的强弱随粒度反转（2410.10813 Table 9），融合是稳健解；RRF 为无参融合基线（Cormack 2009） | 低（已有两路） | 融合权重不当会拉低 dense 精度；RRF 会稀释头部 | 低 |
| 4 | MMR 去冗余 | 检索后 | 无公开量化（MMR 原始论文是摘要场景，Carbonell & Goldstein 1998）；工程经验：k=5 且同 session 多 turn 命中时收益明显 | 低 | λ 过小会牺牲相关性；k=5 时多样性空间很小 | 低 |
| 5 | 去重/近重复合并 | 写入 | 无公开量化（工程经验）；间接证据：Zep 因"每节点存全量摘要"导致图膨胀到 60 万 tokens（2504.19413 §4.3 对比） | 低 | 过度合并会吃掉"知识更新"所需的旧值 | 低 |
| 6 | value 粒度：session → round/turn | 写入/索引 | round 优于 session 优于 fact（2410.10813 §5.2/Table 3）；round 粒度下 `K=V` recall@5 0.582 vs session 0.706（粒度与键设计耦合，见风险） | 中（要切分+回溯原 session） | 粒度变细 → 条目数暴涨、k 固定时上下文更碎；LME 自己也说 fact 粒度伤整体、只帮 multi-session | 中 |
| 7 | fact-augmented key expansion（`K=V+fact`） | 索引 | 平均 **+9.4% recall@k / +5.4% 最终准确率**（2410.10813 §5.3）；session 粒度 recall@5 0.706→0.732，round 粒度 0.582→0.644（Table 3） | 中（要跑抽取 LLM，离线批处理） | **只用压缩键会崩**：`K=summary` 时 QA Top-10 0.676→0.252（Table 3）；抽取质量差 → 噪声键 | 中 |
| 8 | 时间感知查询扩展 + 时间过滤 | 检索 | temporal 子集 recall@5 **+11.3%（round）/ +6.8%（session）**（2410.10813 §5.4 正文；Table 4 明细） | 中（每题一次 LLM 抽取 + 时间字段索引） | **弱模型反噬**：Llama-3.1-8B 抽取时 round 粒度 recall@5 0.421→**0.384**（Table 4）；幻觉时间窗会误杀正确条目 | 中 |
| 9 | query 改写 / HyDE / multi-query | 检索 | 无公开量化（LME 未测；HyDE 原始论文 2212.10496 报 zero-shot 检索提升，但依赖强生成模型） | 中（延迟×N） | 每题多次 LLM 调用 → p95 延迟爆炸；改写漂移会伤 BM25 | 中 |
| 10 | rerank 家族选择（cross-encoder vs RRF vs MMR vs node-distance vs episode-mentions） | 检索 | Zep 只给**成本排序**：RRF/MMR < episode-mentions/node-distance < cross-encoder（"highest computational cost"），**未给逐项相对增益**（2501.13956 §3.2）→ 标 `无公开量化` | 低-中 | cross-encoder 最贵、最慢；图类 rerank 需要图结构 | 低（cross-encoder 我们已有）/高（图类） |
| 11 | embedding 维度 / 模型选择 | 索引 | 检索器差异在 round 粒度可达 18.8pp recall@5（BM25 0.472 vs Stella 0.660），session 粒度只有 8.6pp（0.634 vs 0.720）（2410.10813 Table 9）→ **粒度越细，embedding 质量越关键** | 低-中 | 换模型要全量重嵌入；维度↑ 存储/延迟↑ | 低 |
| 12 | 量化 / 本地 vs API | 工程 | `无公开量化`（各家用例差异太大）；可参照的量级：Mem0 p95 总延迟 1.44s vs full-context 17s（-92%），代价是 J 67% vs 73%（2504.19413 §4.2/Table 2） | 低 | 量化掉点集中在长尾语义；API 有网络抖动与成本上限 | 低 |
| 13 | 缓存与延迟优化（查询扩展结果缓存、embedding 批处理） | 工程 | `无公开量化`；结构性证据：LangMem 搜索 p50 17.99s/p95 59.82s → 被判"不可用于交互"（2504.19413 §4.2） | 低 | 缓存键设计不当会跨用户串味 | 低 |
| 14 | 分层摘要 / 树状索引（RAPTOR） | 索引 | QuALITY 上 **+20 绝对点**（配 GPT-4，2401.18059 Abstract） | 高（递归聚类+摘要+重建） | **每来一个新 session 就要部分重建索引**（2410.10813 §2/Table 2 讨论明确点出 HippoRAG/RAPTOR/Memwalker 的重建开销）；对话记忆的"文档边界"不清晰，树容易建错 | 高 |
| 15 | 图扩展（HippoRAG / Graphiti） | 索引+检索 | 多跳：MuSiQue/2Wiki 上 **+3 / +20 点**，单步检索比 IRCoT **便宜 10–30×、快 6–13×**（2405.14831 Abstract）；Zep 在 DMR 94.8% vs MemGPT 93.4%、LME `_s` 71.2% vs 60.2%（2501.13956 Abstract/Table 2） | 高（实体抽取+消解+双时态） | 存储爆炸：Zep 图 ~60 万 tokens/对话 vs 原始对话 2.6 万（2504.19413 §4.3）；单跳题上图反而不赚（Mem0 报 graph 变体在 single-hop 上"marginal drop"，2504.19413 §4.2） | 高 |

## 2.2 分层详述

### A. 读取侧（最便宜，先做）

**A1. CoN + JSON 上下文格式**（2410.10813 §5.5）
- 改什么：读取 prompt 改成"先对每条 memory item 抽 evidence note，再基于 notes 作答"；memory item 用 JSON 数组序列化（`{id, timestamp, content}`），而不是自然语言拼接。
- 收益：oracle 检索下，最差读取策略 vs 最好策略差 **10 个绝对点**（GPT-4o）；且 **JSON 单独用不赚，配 CoN 才稳定赚**——论文原文："when CoN is not applied, JSON format does not consistently outperform the natural language format"（§5.5）。
- 风险：token 变多（notes + 原文）；对很小 reader 模型，CoN 的"先抄后答"可能抄错。
- 适配：**低**。只动 prompt 模板与序列化，不动检索。

**A2. context packing 顺序（lost-in-the-middle）**
- 改什么：不要按"检索分数降序"直接拼。LME 的做法是**按时间戳排序**（"the retrieved items are always sorted by their timestamp to help the reader model maintain temporal consistency"，2410.10813 §4 实验设置）；同时避免把最相关的一条放在正中间。
- 收益：位置效应可使准确率相对下降超过 **20%**（2307.03172 §4，20 文档 QA 设定；该数字为"最佳位置 vs 中间位置"的对比量级）。
- 风险：时间序与相关性序冲突时（用户问"最近一次…"），需要"时间倒序"而非正序。
- 适配：**低**。

**A3. 明确拒答出口**
- 改什么：prompt 里给"若 memory 中没有证据，输出 `NOT_ENOUGH_INFO`"，并把该串纳入判分。
- 收益：LME abstention 是 7 类之一，且 judge 在该类一致率最低（0.90，Table 6）→ 不设出口等于白送分。
- 适配：**低**。

### B. 写入 / 索引侧

**B1. value 粒度（LME CP1）**
- 结论链：round > session > fact（整体），但 fact 粒度能提升 multi-session 推理；论文明确"进一步压缩成 user facts 会因信息损失伤整体"（2410.10813 §5.2 正文 + Table 3）。
- 数字：round 粒度 `K=V` recall@5 **0.582**（Table 3）；session 粒度 `K=V` recall@5 **0.706**（Table 3）。**注意这是"粒度 × 键设计"耦合的结果**：session 单条信息量大、天然好召回，但 QA Top-10 上 session 0.676 vs round 0.670 基本打平（GPT-4o，Table 3）——即"召回高不等于答得好"。
- 适配：**中**。我们已经是 turn 级存储（等价于最细粒度），真正的动作是**加一层 session/round 聚合视图**，检索时按需上卷（small-to-big），而不是替换 turn。

**B2. fact-augmented key expansion（LME CP2）**
- 改什么：对每个 value 离线抽 `facts`（"standalone personal facts, minimize coreference"，论文 prompt 见 Fig.12），索引时把 `key = value_text + "\n" + facts` 一起嵌入/建 BM25；**value 本身仍是原文**。
- 收益：平均 **+9.4% recall@k、+5.4% 最终准确率**（§5.3）；session 粒度 recall@5 0.706→**0.732**，round 粒度 0.582→**0.644**（Table 3）。论文还试了"多路检索 + rank merging"，**明显差于索引期键合并**（§E.3 / Table 10）——因为 rank merging 让索引膨胀 n 倍。
- 风险（硬反例）：**压缩键单独用会崩**。session 粒度 `K=summary`：recall@5 0.572、GPT-4o QA Top-10 **0.252**（vs `K=V` 0.676）；round 粒度 `K=fact`：recall 0.530 < `K=V` 0.582；`K=keyphrase` 更差（recall 0.282）（Table 3）。
- 适配：**中**。需要一次性离线抽取（可用本地小模型批量跑，避免在线 LLM 调用）；抽取 prompt 要"最小化指代"，否则 fact 里的 he/she 检索不到。

**B3. 时间戳与事件日期索引（LME CP3 的索引半边）**
- 改什么：每个 turn 存 `session_date` + 抽取出的 `event_date`（"date/event" 二元组，prompt 见 Fig.12 第二段）；建立时间倒排。
- 收益：与 A/查询扩展合用时 temporal 子集 recall@5 +11.3%（round）/ +6.8%（session）（§5.4）。
- 风险：抽取不出日期的事件不该硬造（论文 prompt 明确"若时间无法推断则不抽"）。
- 适配：**低-中**（只要时间字段，不一定要 LLM）。

**B4. 去重 / 近重复合并**
- 改什么：写入前对同 session 内相邻 turn 做近重复检测（MinHash/SimHash 或 embedding 余弦阈值），合并或丢弃高度重叠项。
- 收益：`无公开量化`。间接证据：上下文膨胀的代价是可测量的——Mem0 7k tokens/对话 vs Zep 图 60 万 tokens，而 full-context 26k tokens 就把 p95 拉到 17s（2504.19413 §4.2/§4.3）。
- 风险：把"知识更新"（旧值→新值）当重复合并掉，会直接摧毁 knowledge-update 类。
- 适配：**低**。

### C. 检索侧

**C1. hybrid + RRF**
- 证据：LME Table 9 显示 BM25 与 dense 的相对强弱**随粒度反转**——session 粒度 BM25 recall@5 0.634 vs Stella 0.720（差 8.6pp）；round 粒度 BM25 0.472 vs Stella 0.660（差 18.8pp）。粒度越细，BM25 越吃亏（短文本、词项稀疏），但也越依赖精确词面（人名/地点）。
- 做法：两路各取 top-50 → RRF（k=60）融合 → 取 top-20 进 rerank → k=5。
- 收益：`无单一公开数字`（LME 没测 hybrid，这是它的空白，也是我们的机会）；RRF 作为无参融合基线（Cormack et al., SIGIR 2009）。
- 风险：RRF 对"某一路噪声极大"不鲁棒；需要按路做分数归一或加权。
- 适配：**低**（两路已存在，只加融合层）。

**C2. rerank 家族**
- Zep §3.2 给的家族与成本序：`RRF` / `MMR`（便宜） < `episode-mentions`（按对话内被提及频次）/ `node-distance`（按到质心节点的图距离） < `cross-encoder`（最贵）。**该节没有给逐项相对增益**，只给成本定性 → 我们引用时必须写 `无公开量化`。
- 我们的现实：已有本地 cross-encoder → 保留；把它从"向量单路后置"改成"**RRF 融合后置**"，这才是它该待的位置。
- 风险：cross-encoder 在 k=5 时收益被压缩（候选池太小），先把候选池放到 20–50 再重排。
- 适配：**低**。

**C3. MMR 多样性**
- 改什么：rerank 后做 MMR（`λ·rel - (1-λ)·max_sim`），λ≈0.7。
- 收益：`无公开量化`（MMR 原始场景是摘要，Carbonell & Goldstein 1998）。工程经验：当 top-5 里 3–4 条来自同一 session 的相邻 turn 时，MMR 能显著提高"跨 session 综合"题的可答性。
- 风险：k=5 太小，MMR 容易把唯一正确证据挤掉；建议只在 `k≥8` 或"同 session 命中 >2"时启用。
- 适配：**低**。

**C4. query 改写 / HyDE / multi-query**
- 收益：`无公开量化`（LME 未测；HyDE 2212.10496 的收益依赖强生成模型与 zero-shot 场景）。
- 风险：**每题一次 LLM 调用**会把 p95 延迟推到不可用区间（参照 LangMem p50 17.99s 被判不可用，2504.19413 §4.2）；改写漂移会破坏 BM25 的精确匹配优势（人名、代号）。
- 适配：**中**。若要做，只对"含时间词/指代词"的 query 触发，并缓存（见 E2）。

**C5. 时间感知查询扩展（LME CP3 的查询半边）**
- 改什么：对 time-sensitive query 用 LLM 抽 `{start, end}`，检索时过滤（论文 prompt 明确"若无时间指代则不猜，输出 N/A"，Fig.12 第三段）。
- 收益：temporal 子集 recall@5 **+11.3%（round）/ +6.8%（session）**（§5.4）；Table 4 明细：round `K=V` 0.421→0.451（GPT-4o 抽），`K=V+fact` 0.489→0.526，且 @10 从 0.550→**0.722**。
- 风险（**硬反例**）：用 Llama-3.1-8B 抽时间窗时，round `K=V` recall@5 从 0.421 **掉到 0.384**（Table 4 第三行）；论文原文："Llama 8B struggles to generate accurate time ranges, often hallucinating or missing temporal cues"（§5.4）。
- 判据：**只有当抽取模型 ≥ 某个能力阈值才开**。落地做法：先在 50 题时间子集上测"抽取出的时间窗是否覆盖 gold 证据日期"，命中率 <80% 就别上。
- 适配：**中**。

### D. 结构侧（何时不划算）

**D1. RAPTOR / 分层摘要**
- 收益：QuALITY +20 绝对点（配 GPT-4，2401.18059 Abstract）；collapse tree 2000 tokens ≈ top-20 节点（§5）。
- 不划算的条件（我们的场景基本都命中）：
  1. **增量写入**：每来新 session 要重建部分树；LME 综述明确指出 HippoRAG/RAPTOR/Memwalker "some level of re-indexing is required when a new session is added"（2410.10813 §2）。
  2. **对话没有清晰文档边界**：RAPTOR 为长文档设计，对话的"章节"要靠 topic 聚类猜。
  3. **我们 k=5**：树检索返回的是摘要节点，需要再下钻到原文（small-to-big），否则 CoN 拿不到细节——正好踩 `K=summary` 崩掉的坑（Table 3）。
- 适配：**高**。建议只在"用户问长期偏好/总结类"的少数 query 上按需触发。

**D2. 图扩展（HippoRAG / Graphiti）**
- 收益：多跳 QA +3（MuSiQue）/ +20（2Wiki）点；单步检索比 IRCoT 便宜 10–30×、快 6–13×（2405.14831 Abstract）；Zep 在 LME `_s` 71.2% vs full-context 60.2%（2501.13956 Table 2）。
- 不划算的条件：
  1. **单跳占多数**：Mem0 自报 graph 变体在 single-hop 上"marginal performance drop"（2504.19413 §4.2），收益集中在 temporal/multi-hop。
  2. **存储**：Zep 图 60 万 tokens/对话 vs 原文 2.6 万（2504.19413 §4.3）——20× 膨胀，写入期 LLM 抽取成本也高。
  3. **实体消解质量**：Zep 用 LLM 做 entity resolution + 双时态四时间戳（2501.13956 §2.2），工程复杂度远超我们当前架构。
- 适配：**高**。中期可考虑"轻图"：只抽 `(subject, relation, object, valid_from)` 三元组进 SQLite，不做社区层。

### E. 工程侧

**E1. embedding 维度 / 模型 / 本地 vs API**
- 证据：round 粒度下 BM25 0.472 vs Stella-1.5B 0.660 vs Contriever 0.589（recall@5，2410.10813 Table 9）→ **模型选择在细粒度上值 10+ 点**；session 粒度上只值 8.6 点。结论：粒度越细，越值得换更好的 embedding。
- 维度/量化：`无公开量化`（没有跨系统可比的公开数字）。可操作的只有成本侧：full-context 26k tokens 每题 17s p95 vs 记忆式 1.44s（2504.19413 §4.2）。
- 适配：**低-中**（换模型=全量重嵌入，需要离线任务 + 双写灰度）。

**E2. 缓存与延迟**
- 改什么：① query 归一化后缓存**查询扩展/改写结果**（TTL 1h，按 user 隔离）；② 缓存 embedding（内容 hash 键）；③ 时间过滤、hybrid 融合、MMR 都是纯 CPU，别放进 LLM 调用链。
- 收益：`无公开量化`。风险参照：LangMem p50 17.99s / p95 59.82s 被判不可用（2504.19413 §4.2）；Mem0 p95 1.44s 是其卖点。
- 适配：**低**。

---

## 2.3 排序表：优化项 × 预期收益 × 成本 × 风险（按 ROI 降序）

| 排名 | 优化项 | 预期收益 | 成本 | 主要风险 | 先做？ |
|---|---|---|---|---|---|
| 1 | **CoN + JSON 读取** | +10 绝对点（上限，2410.10813 §5.5） | 极低 | 无 CoN 时 JSON 不赚 | ✅ **Top 1** |
| 2 | **时间戳排序 + 位置规避 + 拒答出口** | 位置效应 >20% 相对（2307.03172 §4）；abstention 直接得分 | 极低 | 时间序 vs 相关性序冲突 | ✅ **Top 2** |
| 3 | **hybrid(RRF) + rerank 后置（候选池 20–50）** | 无单一数字；BM25/dense 强弱随粒度反转（2410.10813 Table 9） | 低 | 融合权重 | ✅ **Top 3** |
| 4 | 去重 / 近重复合并 | 无公开量化 | 低 | 误杀 knowledge-update | ⬜ |
| 5 | MMR（k≥8 时） | 无公开量化 | 低 | 挤掉唯一证据 | ⬜ |
| 6 | 加 session/round 聚合视图（small-to-big） | round vs session 差异见 Table 3 | 中 | 上下文碎片化 | ⬜ |
| 7 | `K=V+fact` 文档扩展 | +9.4% recall@k / +5.4% acc（§5.3） | 中 | 压缩键单独用崩（Table 3） | ⬜ 次批 |
| 8 | 时间感知查询扩展 | +11.3% / +6.8%（§5.4） | 中 | 弱抽取模型反噬（Table 4） | ⬜ 次批（需门槛判据） |
| 9 | embedding 升级 | 细粒度 +10~19pp recall@5（Table 9） | 中 | 全量重嵌入 | ⬜ 次批 |
| 10 | query 改写 / HyDE / multi-query | 无公开量化 | 中 | p95 延迟 | ⬜ 谨慎 |
| 11 | 量化 / 本地化 | 无公开量化 | 低 | 长尾掉点 | ⬜ |
| 12 | 缓存与批处理 | 无公开量化 | 低 | 缓存串味 | ⬜ 随手做 |
| 13 | RAPTOR | +20 绝对点（QuALITY，2401.18059） | 高 | 增量重建、摘要键崩 | ❌ 暂不做 |
| 14 | 图扩展（HippoRAG/Graphiti） | +3/+20 点多跳；10–30× 便宜（2405.14831） | 高 | 20× 存储膨胀（2504.19413 §4.3） | ❌ 暂不做 |

### Top 3 先做（及理由）

1. **CoN + JSON 读取**：唯一"改 prompt 就拿到两位数绝对点"的项，且与索引无关、可立刻 A/B。
2. **打包顺序 + 拒答出口**：同一批改动里的零成本项；abstention 占 LME 一类题，且 judge 在该类最不稳，收益确定。
3. **hybrid(RRF) + rerank 后置**：把已有的两路与已有 reranker 摆到正确位置；这是"结构性修正"而非"加新组件"，风险最低，且为后续 k 调整（5→10）留出空间。

---

## 2.4 验证纪律（避免自欺）

1. **先立口径**：`setting`（oracle/s/m）、`k`、`reader`、`judge`、`manifest hash` 写进结果文件名。
2. **双指标**：`recall@k` + `NDCG@k` + `answer acc`；单看 recall 会把 B2 类破坏性改动判为"小亏"（见 1.3(b)）。
3. **配对检验**：同 manifest 上 McNemar / paired bootstrap（1000×）；报告 95% CI。n<100 不宣称提升。
4. **反例哨兵**：任何"压缩/摘要/改写"类改动，必须单独跑 `knowledge-update` 与 `abstention` 两个子集，它们是这类改动的主要受害者。
5. **延迟同报**：p50/p95（检索 + 总时长），参照 Mem0 Table 2 的口径；否则优化可能把系统做成"准确但不可用"。

---

## 附录：引用索引（arXiv ID + 位置）

| 论文 | ID | 本报告引用的位置 |
|---|---|---|
| LongMemEval | 2410.10813 | §2/Table 2（九系统对比、重索引开销）、§3.2/Table 1（统计）、§4（时间戳排序、Stella V5）、§4.2/Fig.3(b)（30–60% 掉点）、§5.2/Table 3（粒度与键设计）、§5.3（+9.4%/+5.4%）、§5.4/Table 4（+11.3%/+6.8%、8B 反噬）、§5.5/Fig.6（CoN+JSON 10 点）、§A.4/Table 6（judge 一致率）、§E.2/Table 9（BM25/Contriever/Stella）、§E.3/Table 10（rank merging 更差）、Fig.12（抽取 prompt） |
| LoCoMo / DMR | 2402.17753 | Abstract/§3.4/Table 1（50 段、300 turns、9K tokens、35 sessions、人工改 15%/19%）、§4（5 类题型、adversarial -83%） |
| Zep / Graphiti | 2501.13956 | Abstract（DMR 94.8% vs 93.4%；LME +18.5%、延迟 -90%）、§2.2（双时态四时间戳、实体消解）、§3.2（reranker 家族与成本序）、§4.3.2/Table 2（`_s` 63.8/71.2 vs 55.4/60.2；3.20s vs 31.3s；1.6k vs 115k tokens） |
| Mem0 | 2504.19413 | §4.1（LoCoMo 10 段/26k tokens/200 题）、Table 1/§4.2（single-hop graph 微降；J 67% vs RAG 61% vs full-context 73%）、Table 2（chunk 128–8192 × k=1/2；k=1 47.77 → k=2 59.56）、§4.2/§4.3（p95 1.44s/17s；7k vs 60 万 tokens） |
| MemoryAgentBench | 2507.05257 | Abstract（4 项能力）、§1（对 LME 主题多样性的批评）、§3.1（AR/TTL/LRU/SF 数据集；EventQA/FactConsolidation） |
| MemBench | 2506.21605 | Abstract（factual/reflective、participation/observation）、§3.5/Table 2（统计）、§4.1（全 MCQ）、§4.4（capacity）、Table 8/9（题型代码） |
| MemoryBench | 2510.17281 | Abstract/§2（用户反馈模拟、持续学习）、§2.2/§3.1（11 数据集、3 领域、2 语言）、§3.2（LLM-as-judge 合并异构指标） |
| MemGym | 2605.20833 | Abstract/§1（memory-isolated score、memory gain）、§2（5 track）、§3.3（MemRM Qwen3-1.7B AUROC 0.985、18.6K triples/22K tokens）、§C.6（fictionalization 必要性） |
| HaluMem | 2511.03506 | Abstract/§1（3 个操作级任务；15k memory points、3.4k+ 题、1.5k/2.6k turns、>1M tokens；抽取期幻觉向下游传播） |
| RAPTOR | 2401.18059 | Abstract（QuALITY +20 绝对点）、§5（collapsed tree 2000 tokens ≈ top-20 节点） |
| HippoRAG | 2405.14831 | Abstract（+3/+20 点；10–30× 便宜、6–13× 快）、Table 3（与 IRCoT 互补） |
| Lost in the Middle | 2307.03172 | §4（U 形位置效应，20 文档设定下相对下降 >20%） |
| PrefEval | 2502.09597 | ICLR 2025，偏好跟随（规模未核） |
| PerLTQA | 2402.16288 | 个人长期记忆三任务（规模未核） |
| MSC | 2107.07567 | 多 session 对话（1–4 sessions，经 LoCoMo Table 1 对比口径） |
| MMR | Carbonell & Goldstein, SIGIR 1998 | 多样性重排（λ 折中） |
| RRF | Cormack et al., SIGIR 2009 | 无参秩融合（k=60） |
| MemGPT | 2310.08560 | DMR 基准定义（Zep Abstract 引用） |

**未核项清单**（本报告未取到原文表格，数字不可引用）：PrefEval / PerLTQA / MSC 的具体题数；MemBench 各类精确条数；MemoryAgentBench 各子集精确规模；HaluMem 分类型题数。
