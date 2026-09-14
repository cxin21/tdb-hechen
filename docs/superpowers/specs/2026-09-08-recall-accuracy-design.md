# 召回/检索准确度提升设计（无新模型 + 可插拔 LLM 复核）

日期：2026-09-08
状态：**已部分实现并部署**（wiki 召回侧落地：三类门控+定域；L1 侧待办；LLM 开关D已撤回）
范围：两套召回系统（MemoryCore auto-recall L1 + 知识库 wiki 召回）共用同一设计骨架

> **实现实录（见 §8）**：wiki 召回侧已实现 类型降权 + 绝对门控 + 跨库软定域 并部署（config B），经 golden 实测 Recall 0.63→0.79；检索引擎仅加回传 `absScore` 字段、不改其排序行为。L1 门控待办；**复用 LLM 候选粗筛（开关D）曾尝试、因上游 new-api 拒直接裸调且不必要，已撤回**。
>
> **勘误注（2026-09-09 fix1）**：上文（含 §8.1）"0.63→0.79"归因**不得**归给跨库
> 软定域（domainRouter）——v1 评测脚本 router 键名错位恒 no-op（审计 W1b②），v2
> 隔离实验实证：B(0.66) 与 tw09+rel0.6 无 router 镜像完全相同，router 单变量在
> 部署工作点对 posRecall 贡献=0、negInjected 恒 +2（rel0.7 镜像对 +1~+2 但同样
> +2 噪音）。增益实来自 typeWeights/relGate 参数；router 存废/权重作为独立调参
> 变量另行归档后再议。详见 `docs/superpowers/evals/recall-golden/README.md` fix1 小节。

---

## 1. 问题背景与病根

### 1.1 症状（活标本）
用户在多轮对话中反复观察到"不需要召回的内容也被召回"：

- 问"recall 检索设计"，召回 Standards 的"复合语义模型/报表语义模型"。
- 问"找最优方案"，召回跨库的"复合语义模型"（0.97）、"Agent 后台/任务路由"。
- 多个实体/概念命中常带 **`score=1.00`（硬编码满分）** 排进榜首。

### 1.2 根因（有代码依据）
1. **排名即注入**：`auto-recall.ts` 的 `searchHybrid` 中 `_threshold` 参数（下划线前缀）**被忽略**，RRF 只看名次、丢弃实分，只需排进 top-K 就整体注入，即使真实 cosine 只有 ~0.05。
2. **RRF 丢弃实分**：融合分是 `1/(k+名次)` 的纯排名分，非相关分，无法用作"语义门槛"。
3. **entity/概念硬编码满分**：wiki 侧条目标签命中直接给 1.00，把"节点存在/撞词"当成了"满分相关"。
4. **无元数据过滤**：跨知识库（Coding/Standards/AgentSkill）候选一视同仁，同库/异库不加区分。
5. **TCVDB 原生融合只回排名分**：`tcvdb.ts` 服务端 `rerank:{method:"rrf",k:60}` 后 `_parseL1SearchResults` 只返融合结果，拿不到两通道原始分。

### 1.3 引擎现状核查（2026-09-08 读码确认，修正"两套同构、一处改全改"假设）

两个系统**不是同一套**，是"**共享引擎 + 多点分叉**"：

| 路径 | 融合算法 | 相关度门控 | entity 降级 |
|---|---|---|---|
| wiki 检索 `hop=0`（正常检索默认，`manager.ts:weightedFuse`） | ✅ **已是凸组合**（min-max 归一化 + α=0.6 语义/0.4 字面） | ❌ 无——`fusedRank.slice(0,limit)` 直接取前 N | ❌ 无（title boost 5.0 → 实体标题精确命中 ~1.0） |
| wiki 召回 `hop>0`（图多跳扩展） | ⚠️ **纯 RRF** `rrfMerge` + BM25 尺度 seed | ⚠️ 仅图 seed 有 minScore，**最终列表不按相关度门控** | ❌ 无 |
| 记忆召回 L1 `auto-recall.ts` | ⚠️ **纯 rank-RRF**，忽略阈值 | ❌ 无 | — |

- **wiki 引擎 hop=0 融合已凸组合**，融合不用再改；缺"门控 + entity 降级"。
- **自动召回 `tdai_recalled_wiki` 的实际噪音源是 hop>0（RRF+图扩展）分支**。
- **记忆 L1 是另一套引擎**，与 wiki 完全不共享，需单独改。
- **跨库合并**在外部召回注入层（不在本 repo 内）。

**改动分布**（非一刀切）：
- wiki `hop=0`：补门控 + entity/type 降级（小改）。
- wiki `hop>0`：融合门控 + entity 降级 + minScore 校准（得分=1.0 噪音区）。
- 记忆 L1 `auto-recall.ts`：融合门控 + 阈值（独立）。
- 跨库合并（外部）：库过滤（②）；引擎侧宜内置 `type/api` 过滤能力供上层用。

---

## 2. 设计目标与成功标准

- **目标**：把"召回按名次发奖"改为"按 0~1 实分过线才注入"；压掉跨库与撞词 over-recall；两套系统共用一套机制。
- **成功标准（量化）**：基于 golden 评测集测量，
  - 注入池中**相关比（Precision@k）** 较改造前明显提升；
  - **over-recall 项**（跨库/撞词/硬编码 1.00 的无关命中）显著下降；
  - 不显著牺牲**召回率（Recall@k）**（软过滤须防 under-recall）。
- **不可破坏**：既有 keyword/embedding/hybrid 三种 strategy 语义；LM 记忆工具主通道。

---

## 3. 总体架构

```
推理管道（两套系统共用）：
  用户Query
    ↓ [A] 元数据软过滤（定域：该信哪些库/类型/场景）
    ↓ [B] 客户端双检索（dense + sparse，各带实分）
    ↓ [B] 带实分融合（rrf(k) ↔ convex(α)），输出 0~1 混合分
    ↓ [C] entity/概念标签降级（名称精确命中保留 / 泛撞字重降）
    ↓ [B] 单一门槛 gating：score ≥ threshold 才注入
    ↓ [D] LLM 复核/改写（开关，默认关，复用现有 LLM）
    ↓ 注入
```

- **A 与 D 边界**：A 是机械执行层（按元数据执行加/降权）；D 是聪明决策层（定域/改写/粗筛，复用现有 gateway LLM）。D 关闭时 A 用规则定域；D 开启时 A 用 D 喂回的判定执行。
- **组件独立性**：每段可独立开关/测试；输入输出均为"候选列表（含 id/文本/元数据/两通道实分）"结构。

---

## 4. 各项设计

### 4.1 [A] 元数据软过滤（跨库/跨场景降噪）

- **原料**：wk 侧自带 `[wiki:KB名]` + `[concept]/[entity]` + `path`；记忆侧 L1 带 `type` + `scene_name`。
- **做法**：**query 感知的软过滤/加权**，不做静态硬删。
  - 定域：推断 query 该关心的 KB/类型/场景（D 关闭时用规则：默认信 Coding/AgentSkill，出现规范/术语词倾向 Standards；D 开启时由 LLM 判域）。
  - 执行：命中目标域的候选**加权**；明显异域且仅 token 撞词的候选**降权/丢弃**。
- **不做什么**：不做"非允许库全删"（防 under-recall，避免杀跨库真相关）。
- **依赖**：一个 `query→KB/场景` 定域逻辑（规则起步，可切到 [D]）。

### 4.2 [B] 绝对相关门控（核心：挡"排名即注入"）

**正确性修正（读码后）**：
- **wiki 引擎 hop=0 已是凸组合**（`weightedFuse`，α=0.6），**融合不是主要缺口**；仅 hop>0（召回）与记忆 L1 是纯 RRF。
- **关键陷阱：min-max 归一化（weightedFuse）与 RRF 的分数都是"池内相对"——候选池第一名恒 ~1.0**；因此**不能拿融合分设绝对门槛**（否则永远挡不掉顶部的无关候选，如"多层嵌套循环复杂度"=1.00 正是此因）。门控必须用**绝对相关信号**。

- **做法（各分支都做）**：
  1. 门控在**绝对相关信号**上：取向量的**原始相似度/相关分**（如 cosine 或 `1-distance` 的原始尺度）作注入判据 `absRel ≥ threshold`。
  2. 归一化/RRF 融合分只用于**过线候选的内部排序**，不用于门槛。
  3. 全不过线 → **返回空、不硬塞**（对齐生产实践：[towardsai: RAG gating](https://pub.towardsai.net/rag-is-not-enough-when-retrieval-augmented-generation-fails-in-production-9dd2a7aa92c1)）。
  4. **召回注入尤其控制 hop>0（图扩展）**：图走邻居是 score=1.00 噪音主源；默认仅在 query 明显指向某概念时才启用 hop>0，或对扩展节点设更高/绝对门槛（甚至不注入纯图扩展节点）。
- **待实现确认**：wiki `searchVector` 目前返 `1/distance`，需回传**原始尺度**供绝对门控；TCVDB/L1 同理取原始 cosine。

- **融合（仅对纯 RRF 路径：hop>0 召回、记忆 L1；hop=0 已 convex）**：
  - 保持可配置 `mode: rrf(k) ↔ convex(α)`，默认值由 4.5 golden 集实测决定（[文献分裂](https://www.pinecone.io/research/an-analysis-of-fusion-functions-for-hybrid-retrieval/)，不预设谁赢）。

### 4.3 [C] entity/概念降级（命中 ≠ 相关）

- **问题（代码依据）**：实体/概念是"命名/索引"节点，FTS 里 `title_tok` 权重 ×5（`manager.ts:ftsSearch` `bm25(wiki_fts, 5.0, 1.0)`），标题精确命中即冲到 ~1.0；易被"撞词顶格"（本会话"多层嵌套循环复杂度/复合语义模型"=1.00 均此类）。
- **做法**：
  1. **命中证据分级**：`query 精确含该概念名/近义词` = 强命中（保留）；`仅泛撞 token 或图邻居` = 重度降权/丢弃。
  2. **按 type 分层折扣**：entity/concept/other/source 各自可配系数（如 entity ×0.6）。
  3. **exception 保真**：用户明确问该概念（名精确命中）走快路径保留。
- **配合 4.2**：被降权的标签若仍低于**绝对相关门槛**则剔除（而非靠融合相对分）。

### 4.4 [D] 复用现有 LLM 复核/改写（配置开关，默认关）

- **开关**：`recall.llmRefine.enabled`（默认 false）。
- **开启时职责**（全部复用现有 gateway LLM，**非新增模型**）：
  1. **定域**：判定 query 该信哪些 KB/场景（喂给 [A]）。
  2. **query 改写**：把口语化/复合 query 改写为利于检索的形态（可废弃）。
  3. **候选粗筛**：对 [C] 后的候选，让 LLM 判"是否真相关"，过滤噪音。
- **成本/边界**：消耗现有 LLM token + 增加延迟；因此默认关闭。
- **熔断**：LLM 调用失败/超时 → 静默回退到 D 关闭时的纯算法路径。

### 4.5 跨切：golden 评测集（实证校准）

- 建小集：几十条 `(query → 应召回条目标注)`，覆盖三库、含撞词与跨库负例。
- 指标：Precision@k / Recall@k / MRR。
- 用途：离线调 `α`/`k`（仅纯 RRF 路径：hop>0、L1）、**绝对相关阈值**、entity 折扣；回归验证改动不退化。
- 归属：作为本设计的配套校验资产，不做成对外功能。

### 4.6 算法设计要点（哪些环节需显式设计算法）

| 环节 | 要设计的算法 | 设计要点 |
|---|---|---|
| **④ 融合** | 归一化 + 凸组合(α)/RRF(k) | 候选池内对两通道分做 min-max/稳健归一化 → `s=α·s_dense+(1−α)·s_sparse`；α/k 用 4.5 网格搜索（如 0.05~0.95 步进）+ nDCG@k/Precision@k 选优 |
| **① 门控阈值** | 阈值选择 | golden 相关/不相关分分布下扫阈值，取注入最相关的 F1 最优点；宁缺毋滥 |
| **② 定域/路由** | query→KB/场景判定 | 起步规则/gazetteer（库名+类型+领域词典加权）；[D] 开启时换 LLM 分域打分；输出 softmax 权重供候选加权 |
| **③ entity 判别** | 精确命中 vs 泛撞词 | 归一化 query 与候选名：名称包含/高 Dice 系数→保留；仅低 ngram 重叠→重降；重叠阈值由 golden 调 |
| **⑤ golden 集** | 采样+标注+指标 | 三库各抽 query，含"应召回"正例与跨库/撞词负例；Precision@k/Recall@k/MRR 作回归门 |
| **④[D] LLM 粗筛** | 提示词/结构化输出 | 批量 prompt：query+候选(库/类型/片段)，LLM 输出相关子集/二进制标签（默认关） |

> **索引侧大杠杆（本版不做，标记为可选后续）**：Anthropic Contextual Retrieval 在基准上是最突出的赢点（检索失败最多降 67%，[Atlan 综述](https://atlan.com/know/advanced-rag-techniques/)）。它属于索引期+潜在重嵌+token 成本，故不进本版；若后续追求彻底，优先追加此项而非继续在融合上调参。另注意：[“强 reranker 之后增强手段收益递减”研究](https://arxiv.org/html/2606.28367v1)反向说明——我们当前**没有** reranker，故融合/门控/过滤这些增强手段确实能带来实质提升，值得先做。

---

## 5. 配置面（已部署部分为该节最右侧实际生效值）

> 已实现并部署（`MemoryProxy/config.yaml` + 代码默认）的召回侧配置：
> ```yaml
> wikiRecall:
>   minInjectNormScore: 0.6      # 相对门控（归一后 <0.6 不注入）
>   minInjectAbsScore: 1.5       # 绝对门控 absScore（校准：相关~2.0+，噪音~1.44-）
>   typeWeights: { entity: 0.6, concept: 0.9 }   # 命名节点降权
>   domainRouter:                # 跨库软定域：query 命中领域词→boasted，仅加权不删除
>     boost: 1.5
>     keywords:
>       Coding-WiKi: [结算, 金额, 冲回, 暂估, 合同, 订单, 出库, 尾差, 精度, 双口径, 临时表, 跨模块, 分录, 差量]
>       Standards-WiKi: [规范, 异常, 并发, 线程, 事务, 边界, 命名, 接口, 性能, 约束]
>       AgentSkill-WiKi: [查询, 报表, 权限, 范式, 交互, 脚本, 保存, 编辑, 列表, 卡片, N+1]
> ```

**以下为未实现项（设计草案，切勿误当已上线）**：
```yaml
recall:
  gate: { enabled: true, threshold: 0.3 }        # 草案数值，未按此实现
  fusion: { mode: "rrf", alpha: 0.6, k: 60 }     # 未实现；wiki hop=0 本已凸组合
  metadataFilter: { enabled: true, defaultDomains: [...] }  # 未实现（domainRouter 是软定域轻量版）
  llmRefine: { enabled: false }                  # 未实现（开关预留）
```

> 说明：本设计早期(§2-7)融合/门控铺排较全，**实际收敛到"检索侧不动 + 注入侧三类门控 + 软定域"**——见 §8 实现实录。未实现项仅作后续方向。

---

## 6. 影响面与实施要点

**实际改动文件（已提交）**：
- `MemoryKnowledge/src/engines/wiki/{manager,types}.ts` —— 检索结果加回传 `absScore`（未归一化向量相关分），不改排序。
- `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts` —— 类型降权 + 绝对门控 + 相对门控 + 跨库软定域。
- `MemoryProxy/src/knowledge/wiki-retrieve-client.ts` —— `absScore` 透传。
- `MemoryProxy/src/{config,types}.ts` + `injection/index.ts`（默认值）+ `config.yaml`（生产生效，gitignore）。
- 单测：注入器 19、引擎 47 全绿；golden 复跑 `replay.mjs` 调参。

**未动**：`MemoryCore/…/auto-recall.ts`（L1 侧留待后续）；检索融合算法保持现状（wiki hop=0 本已凸组合）。

**可实验安全/回退**：所有门控与定域均可独立关闭（config 数值 <=0 / 删段即退），不破坏既有检索路径。

---

## 7. 明确不做（非目标）

- 不引入新的 cross-encoder 重排模型（本机 torch 损坏、无确认 GPU、内部资料不宜送第三方云）。
- 不做"静态硬过滤·非允许库全删"。
- 不做父子分块/上下文语境化（索引侧，列为未来）。
- 不用 LLM 的全面改写当默认路径（默认关）。

---

## 8. 实现实录（2026-09-08，与真实代码对齐）

### 8.1 实际落地（已部署、已测）
| 项 | 落点 | 说明 |
|---|---|---|
| 类型降权 | `MemoryProxy/…/wiki-recall-injector.ts` | `typeWeights{entity:.6,concept:.9}`，跨库并池前乘系数 |
| 绝对门控 | 注入器 + 引擎回传 `absScore` | `minInjectAbsScore=1.5`；引擎 `manager.ts` 加 `absScore` 字段（不改排序） |
| 相对门控 | 注入器 | `minInjectNormScore=0.6`（宁缺毋滥） |
| 跨库软定域 | 注入器 `domainRouter` | 仅 boost 不删除，未命中=现状 |

**检索引擎**：`/wiki/search` 排序行为**不变**（仍是 `weightedFuse` 凸组合，同库 Recall≈0.95），仅加回传 `absScore` 供注入侧门控 —— 检索召回导向、注入注入门控，各司其职。

**Golden 实测**：`td-agemem/docs/superpowers/evals/recall-golden/replay.mjs` 用线上引擎数据复跑 19 条，扫参选优 → 部署 config B：posRecall **0.63→0.79**，neg 噪音 9→10（固有取舍，见 §8.3）。

**服务**：knowledge 引擎(8421) + MemoryProxy 已重启生效。

### 8.2 明确未做
- **复用现有 LLM 候选粗筛（开关 D）** —— 曾实现尝试，因上游 new-api 中转**拒直接裸调**（`scm-flash` 经 its 计算要 alias 到规范 id，直连 400），且规则版已够用，**已撤回**。若未来要做，应走 proxy 模型别名解析 + 独立 LLM 客户端。
- **L1 记忆门控**（`MemoryCore/…/auto-recall.ts`）——独立引擎、独立绝对分校准，留作后续。
- **父子分块 / 上下文语境化**（索引侧，未来大杠杆）。

### 8.3 固有取舍（诚实边界）
合并 3 库 + 门控下，最优 Recall 0.79 < 库内基线 0.95、噪音非 0。这是"召回导向检索 vs 宁缺毋滥注入"的本质取舍，不是缺陷。持续打磨靠 golden 回归调整 `concept`/`minInjectNormScore`/`domainRouter`。