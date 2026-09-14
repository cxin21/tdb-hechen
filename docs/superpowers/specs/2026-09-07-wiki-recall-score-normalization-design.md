# 设计补充：wiki 召回/检索的分数、排序与归一化优化

> 日期：2026-09-07
> 模块：MemoryKnowledge（wiki 引擎 `manager.ts` searchInternal）+ MemoryProxy（WikiRecallInjector 消费端）
> **状态：设计中**（作为 2026-09-07-wiki-auto-recall-design.md 的配套优化文档）
> 触发：真实调用 `/v3/wiki/search` 暴露分数失真问题

## 1. 复现与根因（基于真实数据 + 源码）

### 1.1 真实调用现象

对 Coding-WiKi 查询「应收暂估回冲怎么处理」返回（按 RRF 排序后的前 5）：

| # | title | type | score | snippet 信息量 |
|---|---|---|---|---|
| 1 | ARIncomeFor32Action | entity | **20.09** | 差（半句） |
| 2 | 发票拆行改价…缺陷 | concept | **19.33** | 好 |
| 3 | 签收途损（4353） | entity | **19.10** | 差（半句） |
| 4 | 暂估应收回冲机制 | concept | **2.27** | 好（正是想找的机制说明） |
| 5 | 暂估应收 | concept | **2.27** | 好 |

**悖论**：真正语义相关、snippet 信息量充足的「暂估应收回冲机制」score 只有 2.27，排在信息量几乎为零的实体页（20.09）后面;而 top1 的实体页 snippet 只有半句话。**排序与分数严重背离用户真实意图**。

### 1.2 源码根因（确认）

`manager.ts searchInternal`（L1019-1027）：

> 注释原文：`RRF 仅用于最终排序；score 字段保留原始信号尺度（FTS 命中→BM25，向量独有→distance 派生），避免把 RRF 小尺度(~1/k≈0.016)数值暴露为结果 score`

三个信号来源，**量纲完全不可比**：
- FTS/BM25：无界正数（`ARIncomeFor32Action` 标题命中 query 字面词 → 20+）
- 向量：`1/distance`（`distance→0` → 分无上界，且方向与 cos 相反）
- RRF：`1/(k+rank)`，k=60，std 值 ≈ 0.016（用于排序，但被刻意不暴露）

**结论**：
1. **排序路径正确**（RRF, rank-based, k=60），top 排名是 FTS+向量融合后的合理结果。
2. **返回给调用方(LLM/recall)的 `score` 字段失真**——它既不反映 RRF 融合序，也不是归一化的相关性，而是「原始 BM25 或 1/distance」，跨源不可比，对 LLM 判断可信度无意义甚至误导。
3. **snippet 信息密度不均**是第二个独立问题（缺 frontmatter description 时取正文开头，可能是表头/噪声）。

## 2. 理论依据（网上实践）

混合检索分数融合的经典问题与解法：

| 问题 | 经典解法 | 出处 |
|---|---|---|
| BM25 无界 + cosine 有界，直接加权会让 BM25 永远主导 | **RRF**（rank-based，不看分数，规避量纲问题） | [Digital Applied](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)、[serghei.pl](https://blog.serghei.pl/posts/reciprocal-rank-fusion-explained/) |
| 排序正确但需归一化分数供调用方 | **min-max / z-score 归一化**（OpenSearch 支持）；但注意 min-max 会被单个离群值压扁 | [OpenSearch 混合检索最佳实践](https://opensearch.org/blog/building-effective-hybrid-search-in-opensearch-techniques-and-best-practices/) |
| RRF 的 k 值调优 | k=60 是通用基线;文档少(<100)时降 k(如 10)可提升区分度 | [MariaDB RRF 优化](https://mariadb.com/docs/server/reference/sql-structure/vectors/optimizing-hybrid-search-query-with-reciprocal-rank-fusion-rrf)、[GoPenAI](https://blog.gopenai.com/hybrid-search-in-rag-dense-sparse-bm25-splade-reciprocal-rank-fusion-and-when-to-use-which-fafe4fd6156e) |
| 召回 + 精排两阶段 | 检索(recall, 宽) → rerank(精排, 窄) 的 two-stage 范式;RAG 中 top-k 后接交叉编码器/LLM re-ranker | [Pinecone Re-Rankers](https://www.pinecone.io/learn/series/rag/rerankers/)、[Adnan Masood](https://medium.com/@adnanmasood/re-ranking-mechanisms-in-retrieval-augmented-generation-pipelines-an-overview-8e24303ee789) |

**与本项目的映射**：
- 本项目「排序」已在 RRF 正确;「分数暴露」缺失归一化——应补 min-max 归一化到 **[0,1]** 或直接暴露 **RRF 分**。
- 本项目本质已是 **two-stage**：wiki `/search`(召回+RRF排序) → recall 注入片段 / LLM 用 read_page(精读)。无需再加重排器,先修分数。

## 3. 优化方案（分层）

### 3.1 方案核心原则：**查询与召回统一信号源**

「召回查询逻辑应该和检索相同」——正确。自动召回（`WikiRecallInjector`）和 LLM 手动搜索（`knowledge_tools wiki search`）**本就调用同一个 `/v3/wiki/search`**，检索逻辑天然一致。**不一致的只是暴露出来的 score 字段**。因此核心优化是：**在 wiki 引擎侧产出统一、归一化、可比的 score，让查询与召回看到同一个可信分数**。

### 3.2 改动 A（wiki 引擎侧，正向/推荐）：归一化 score 输出

在 `searchInternal` 产出 results 后，对 `score` 字段做处理，使其成为跨源可比、反映融合序的归一化分：

1. **归一化**：对 top-k 命中集的 score 做 **per-query min-max 归一化到 [0,1]**（在最终 review 结果集上算 min/max，而非全量），避免跨源量纲混杂。
   - 或更稳：直接暴露 **RRF 分** `s_rank = Σ 1/(k+rank)`（已排序,天然可比、反映融合序），再归一化到 [0,1]。**推荐**:暴露归一化 RRF 分,因为它同时正确反映 FTS+向量融合序。
2. **不破坏 FTS/图行走**：`rawSeeds`（BM25 尺度）仍供 `graphMultiHopSearch` 的 minScore 门槛使用——**归一化只应用在输出 results 的 score 字段,内部 seed/图行走逻辑不动**,零风险。
3. 向量分 `1/distance` 同样在归一化后统一,不再让 LLM 被 20 vs 2 误导。

### 3.3 改动 B（消费端 recall,配套）：不再把 score 当排序依据

`WikiRecallInjector` 消费 `/search` 结果时：
1. **排序以服务端返回顺序为准**(改 A 后服务端顺序即融合序归一化序),**不做 rescores**。
2. `score` 仅作为**归一化后的 [0,1] 参考值**展示给 LLM(`score=0.87`),若要阈值用归一化阈值。
3. 若暂不改 A(测试版先行),则消费端**不把原始 score 用于 min 阈值过滤**——改用「注入条数预算 + hop 策略」控制,避免被失真分误导。

### 3.4 改动 C（长期,可选）：rerank 精排

若归一化后仍发现「分高但 snippet 弱」的页面挤占,增加 **two-stage 精排**:召回 top-N → 用轻量 LLM/交叉编码对候选重排 → 取 top-k 注入。**测试版不做**,作为收敛期增强。

### 3.5 改动 D（snippet 信息密度,独立优化）

- `makeSnippet` 缺 description 时取正文开头——补**关键段抽取**(含 query 关键词的段落优先)或**前后文摘要**。
- 测试版先接受,但把此条记为高优先项(见主 spec §6)。

## 4. 对齐网上理论与实践小结

| 我们的问题 | 理论 | 落地 |
|---|---|---|
| BM25/向量分数不可比 | RRF 规避量纲 | 已做(排序)✅ |
| 分数暴露失真 | min-max 归一化 [0,1] 或 RRF 分 | 改 A:归一化 score 字段 |
| 排序该否再精排 | two-stage rerank | 长选项,测试版不做 |
| 召回与检索一致 | 同源同一 search 接口 | 天然一致✅(只修分数) |

**结论**:查询与召回逻辑本已统一(同一 `/search`),**唯一需要修的是「score 字段的可比性与语义」**——用归一化(改 A)即可让 LLM 和 recall 都看到可信分数,无需改排序算法、无需重排器,最小改动、可回退。

## 5. 风险与验证

- 改 A 仅影响 `searchInternal` 的 `results[].score` 字段;`related`/`links`/`count`/内部 seed 不变。
- 需 spike 确认:归一化在返回前对当前查询的 top-k 集合做,不引入全局统计;与 FTS-only 降级路径兼容(无向量时纯 BM25 归一化)。
- 测试:单测归一化(含离群值场景)、跨源 compare、recall 端不再误用 score;回归:排序不变(归一化不改变序)、FTS 降级不变。