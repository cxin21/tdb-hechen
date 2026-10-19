# R71 召回相关性：混合检索噪声治理设计（A+C 第一期）

- 日期：2026-10-19
- 状态：已定稿（A+C 第一期落地中；二期项见 §6）
- 关联：#71（本票）、#65（批次收口）、R1 闭环（2026-10-19）
- 用户拍板：m01939「A+C 落地，但是最好不要有硬编码词汇比较」+「召回不准不止这一方面，先上网调研 RAG/记忆系统设计」

## 1. 问题定义（生产实证）

用户投诉「召回的记忆很多不沾边」。三组探针（/v3/recall 生产数据，team-2k12lgb650 三元组）：

| query | 相关性 | conclusionCount | experienceCount | 向量路 |
|---|---|---|---|---|
| 今天晚饭吃什么好 | 无关 | 3（词面 吃/什么 命中） | 0（rerank 全灭） | fts-only |
| 量子计算机的错误纠正码率 | 无关 | 3（计算/错误 命中） | 0 | hybrid |
| TDB记忆召回延迟高怎么排查 | 域内 | 3（切题） | 2（切题） | hybrid |

**噪声 100% 来自 R7 结论层**：结论候选（work_fact FTS 词面命中 + scene 命中）经
selectL2Conclusions 的 textHit/sceneHit 选中后**不经任何分数门槛**直入注入块；
经验层早有 rerank+minScore=-2.0 门槛（journal 实证：无关 query 经验 kept=0）。

## 2. 本地实证（门槛定标依据）

### 2.1 bm25 分数分布（MemoryCore/scripts/tmp-fts-score-probe.ts 与 -probe2.ts，l1_fts 950 行，12 query 电池）

- bm25RankToScore=rel/(1+rel) 饱和压缩：rel 3-13 → 0.77-0.93，归一化刻度上无关/域内重叠，**不可作门槛刻度**；
- raw relevance（rel=-rank）有判别力但裕度薄：无关 query top1 5.50-6.72（量子离群 10.86=「计算+错误」常见词共现），域内 9.65-12.97，边界（天气，真命中）7.21；top3-mean 无关 ≤7.55 / 域内 ≥8.67；
- cov/wCov（词面覆盖率）重叠，不可用；
- 结论：bm25 rel 只能做**预地板**（挡明显弱候选），语义级门槛必须 cross-encoder。

### 2.2 结论层 rerank shadow 验证（/v1/rerank 真实回放 journal 结论行）

| query | 结论行 rerank logits | -2.0 门 | -1.0 门 |
|---|---|---|---|
| 今天晚饭（无关） | -10.178 / -10.179 / -10.181 | 0/3 ✓ | 0/3 ✓ |
| 量子（无关） | **-1.784** / -3.624 / -4.270 | 1/3 ✗ | **0/3 ✓** |
| TDB（域内） | +1.206 / -0.804 / -0.829 / -1.821 / -3.704 | 4/5 | 3/5 ✓（掉 -1.821/-3.704 均偏题） |

- 经验层缺省 -2.0 对结论层**太松**（量子 -1.78 险过仍漏）；结论层独立门槛 **-1.0**（logits）三组全对；
- 裕度薄（-1.78 vs -1.0 = 0.78），阈值必须 config 可调 + journal 持续观测校准；
- 本地 reranker warm 延迟 81-438ms/批（≤10 docs），可接受。

## 3. 业界调研印证（2026-10-19 定向检索）

1. **reranker 分数门槛是标准实践**：turnstone/Forge 等开源管线与 RAG 工程指南均用 score thresholding 过滤低相关 chunk（[re-ranking for RAG](https://bthek1.github.io/DL_methods/LLM/RAG/re-ranking.html)、[cross-encoder second pass](https://theneuralbase.com/advanced-rag/learn/beginner/reranking-cross-encoder-second-pass/)）。
2. **绝对门槛必须按模型/刻度定标**：listwise softmax 损失使分数对常数平移不变，0.5 类固定切点跨模型失效（[Cross-Encoder Reranker Score Calibration: Why 0.5 Cutoffs Fail](https://dev.to/ji_ai/cross-encoder-reranker-score-calibration-why-05-cutoffs-fail-1k9b)）；bge-reranker-v2-m3 社区实测 sigmoid 门槛各模型差异大（[HF discussion #25](https://huggingface.co/BAAI/bge-reranker-v2-m3/discussions/25)）；provider 返回概率 vs logits 的刻度歧义是真实生产坑（[hindsight #1727](https://github.com/vectorize-io/hindsight/issues/1727)）。→ **门槛入 config、按 provider 刻度、shadow 数据定标，禁硬编码**——与用户要求一致。
3. **无结果处理**：CRAG（arXiv:2401.15884）retrieval evaluator → correct/incorrect/ambiguous 三态，incorrect 走降级/改写；Self-RAG（arXiv:2310.11511）ISREL 反思 token。现网已有 [degraded: fts-only] 降级标记 ≈ 轻量版；C 帽后无关 query 自然走向「零注入+降级标记」，二期可做查询改写。

## 4. 第一期方案（A+C，本期落地）

### A：结论层相关性双门（纯分数统计，零词表）

- **A1 bm25 rel 预地板**：work_fact 候选携带 raw rel（=-rank，searchL1Fts 行透传 rank），低于 `recall.conclusionLayer.minBm25Rel` 的候选在进选择器前剔除。缺省 0=off；生产 yaml 拟 6.5（2026-10-19 语料定标，语料规模变化需重定标，journal 观测）。rerank 不可用部署（provider off/breaker open）时它是唯一门。
- **A2 rerank 语义门（主门）**：selectL2Conclusions 选中 + V2-3 放宽 + 预算裁剪 + maxChars 截断之后、**幂等指纹缓存写入之前**，对全部选中结论（work_fact+scene）按注入行形态（去 "- " 前缀）统一 rerank，score < `conclusionLayer.rerankGate.minScore`（local logits 缺省 -1.0）者剔除。
  - 模式 `conclusionLayer.rerankGate.mode`: `"off" | "shadow" | "enforce"`，**代码缺省 "shadow"**（shadow-first 约定：只记录不过滤）；生产 yaml 显式 "enforce"（本设计 shadow 验证已完成）。
  - rerank wiring 与经验层同源（resolveRerankWiring + params.rerankDeps）；state 非 active / breaker open → 门自动旁路（不误杀）。
  - journal 增 `gates.conclusionRerank={mode,provider,ms,kept,dropped,topScore?}`。
  - 门在缓存写入前 → 幂等缓存存的是已门控集合；sessionReuse 缓存只缓存经验层 searchResult，不受影响。

### C：fts-only 注入帽

- `recall.ftsOnlyInjectCap`（缺省 2，0=off）：effectiveStrategy==="fts"（向量路死）时，注入块 memoryLines（结论+经验合计）截到帽内。无关 query 在 A 门后通常 0 结论 + rerank 已灭经验 → 注入块只剩降级标记（期望行为）；万一 FTS 恰好命中真相关，帽 2 仍放行最有用的两条。

### 经验层不动

rerank minScore=-2.0 缺省实证有效（量子 -2.01 险过说明 -2.5 会误放），维持不动。

## 5. 验收标准

1. 单测：A1 地板剔除 / A2 enforce 剔除·shadow 只记录·off 恒等·门在指纹缓存前 / C 帽与 0=off / journal 字段 / 缺省配置（shadow）逐位现状回归。
2. 门禁：typecheck 243 守恒 + MemoryCore vitest 全绿 + lint:skill-isolation。
3. 真实数据 E2E（重启 core 后四探针）：晚饭/量子结论噪声消失（或 ≤ 帽且全数切题）、TDB 域内结论经验保留、journal gates.conclusionRerank 记录 shadow/enforce 决策、fts-only 探针注入块 ≤2 行。
4. 规范检查 → 真实数据测试 → push（用户流程）。

## 6. 二期 backlog（本期不做，调研已铺垫）

- dynamicTopK 给 FTS 路补平行 scores（#54 elbow 收缩吃到 keyword 路）；
- RRF 融合权重显式化与断层检测（gap detection）；
- 查询侧 harness 噪音剥离（<acp> 标签/时间戳脚手架直入 FTS/embedding）；
- CRAG 式查询改写与「无结果声明」结构化（现在只有降级标记）；
- 结论层小候选集万词面相对门失效修补（textHitMaxTokenRatio 在候选 ≈5 时失真）；
- rerank 阈值按 provider 刻度分别定标（cloud sigmoid vs local logits）。

## 7. 影响面

- MemoryCore/src/core/hooks/auto-recall.ts（A1/A2/C + journal）
- MemoryCore/src/core/hooks/recall-layered.ts（L2ConclusionCandidate 增 bm25Rel 可选字段）
- MemoryCore/src/core/store/sqlite.ts（searchL1Fts 返回行透传 rank，若缺）
- MemoryCore/src/config.ts（三配置解析 + 形状校验）
- 生产 yaml（gitignored 本地 + deploy/tencent-cloud 云 yaml）：minBm25Rel=6.5、rerankGate.mode=enforce、ftsOnlyInjectCap=2
- 测试：auto-recall 结论层门 / recall-layered 候选字段 / config 解析
