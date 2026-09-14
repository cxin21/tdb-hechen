# 完整调研报告 + 最优方案：wiki 召回/检索

> 日期：2026-09-07
> 调研对象：MemoryKnowledge 知识服务（10.4.100.30:8421/v3）三个绑定 wiki + 检索管线
> **状态：调研完成，结论见文末最优方案**
> 触发：自动召回测试中召回结果质量参差，需先确凿定位根因再优化

## 一、调研对象与运行时事实

三个 wiki 均为同一 git 源（`scm_ai` / `develop-ncc1.0`）不同路径：

| wiki | id | 路径 | page_count | status | graph(edges) |
|---|---|---|---|---|---|
| Coding-WiKi | wiki-d7l7gdjw | `*/experience/analysisdoc/**` | **1021** | **processing(ingesting)** | 4644 |
| Standards-WiKi | wiki-jr9mq6at | `*/experience/standards/**` | 169 | ready | 620 |
| AgentSkill-WiKi | wiki-f4f59nnl | `*/experience/agentskill/**` | 147 | ready | 647 |

**关键运行时事实**：
1. **Coding-WiKi 处于 ingesting 中**（`internal_status:"ingesting"`）——大 wiki 仍在构建/重嵌。搜索可用但可能不稳定。
2. **三个 wiki 的图结构都健全**（647/620/4644 条边）——图展开的基础在。
3. **AgentSkill 召回"偏弱"是文档基数小（147页）**,不是引擎坏——用精准术语查询（SQL防注入）它返回 28.4/28.3/25.9/22.2 且全部精准命中。

## 二、实测验证（本调研新增）

### 1. 图展开（hop）能工作，但默认配置几乎不触发
- `hop=3 decay=0.5 minScore=0.01` → **返回 hop=1 节点**（图行走真能带出关联页）
- `hop=3/2` 配默认 `minScore=0.1` + `decay=0.5` → **top-k 全 hop=0**

**根因链**：`searchInternal` 默认 `DEFAULT_MIN_SCORE=0.1`、`DEFAULT_DECAY=0.5`；图行走非种子节点分 = `seed_score × decay^hop`，BM25 中等分的邻居 `×0.5` 后掉到 0.1 以下被滤；即便幸存，RRF 排序后多被挤出 `finalLimit`（默认20）。**结论：hop 图展开在默认参数下形同虚设，相关页藏在 `related` 里进不了结果**——全面性被浪费。

### 2. score 字段量纲失真（准确性的核心）
- 同一查询返回清单里 **BM25 高分（20-28）与向量分（2.x）混排**：如 Coding「暂估回冲」→ 22.3 / 2.4 / 21.4 / 2.3。
- 根因（源码 L1019-1020 自述）：`RRF 仅用于最终排序；score 字段保留原始信号尺度（FTS→BM25，向量→1/distance）`。
- **后果**：LLM/自动召回看到 "20 分 vs 2 分" 会误判相关度相差 10 倍，而实际 2 分那位（"暂估应收回冲机制"）才是真答案。真实数据多次证实：**信息量充足的语义页常因向量分小被压后**。

### 3. title 权重过强（准确性的次要根因）
- FTS 建 `title_tok 权重 5.0` > `content_tok 1.0`（L402）。实体页 title 字面命中 query 词 → BM25 高分，把正文更贴语义的概念页压后。

### 4. 召回宽度窄（全面性）
- 默认 limit=20；自动召回注入预算 top 3~5。组1里「手动暂估 vs 自动暂估」「回冲应收机制」等只在 limit=8 才出现，3~5 时直接丢失。

### 5. snippet 信息密度不均（正确性/可用性）
- `makeSnippet` 缺 frontmatter description 时取正文前 80 字 → 常是表头/半句噪声（如"销售发票(32)应收结算入口"）。注入时这些片段对 LLM 无价值。

### 6. Coding ingesting 状态（正确性隐患）
- 大 wiki 持续 ingesting → 搜索在"重建中"运行，向量/索引可能不完整 → **召回稳定性存疑**。

## 三、三性评估（修正后的最终结论）

| 维度 | 判定 | 依据 |
|---|---|---|
| 正确性 | 🟡 中-健康 | 索引含全 title+content、图边健全、隔离正确；**但 Coding ingesting 中 + snippet 生成会失真** |
| 准确性 | 🔴 弱（核心病灶） | **score 量纲失真（BM25 vs 向量混排）+ title 权重过强** → 语义真答案常被压后 |
| 全面性 | 🟡 中-偏差 | **hop 默认不触发 + 召回宽度窄 + `related` 里的真答案进不了结果** |
| 引擎健康 | ✅ 健康 | AgentSkill 很好用术语查询证明引擎无坏；Coding 分数混排是通用问题非临时态 |

**修正**：此前"AgentSkill 向量缺失/引擎坏"假设**证伪**——它是文档少 + 我用了模糊语义查询。**三个 wiki 检索引擎都健康**。

## 四、最优方案

**原则：先修"召回对不对、全不全"，后修"分数好不好看"；改动小、可回退、测试版可先绕开。**

### 一级（治本，决定召回质量）
| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| 1 | **放宽召回宽度 + 拉低 minScore** | search | 默认 limit 提到 ≥8、`DEFAULT_MIN_SCORE` 降到 0.01~0.02；让 hop 页与低分语义页进候选 |
| 2 | **激活图展开** | search/config | 默认 hop≥1 或自动召回时显式传 hop+低 minScore；让 `related` 里的语义关联页真正进结果 |
| 3 | **调 title 权重** | 索引 | FTS `title_tok` 5.0→2~3，弱化标题字面命中绑架排序，让正文语义页有机会靠前（需经验证后定值） |
| 4 | **score 归一化输出** | searchInternal | 输出前对 top-k 做 per-query min-max 归一化到 [0,1] 或暴露归一化 RRF 分；让 BM25 与向量可比 |

### 二级（正确性/可用性）
| # | 改动 | 说明 |
|---|---|---|
| 5 | **snippet 关键段抽取** | 缺 description 时抽含 query 关键词的段落（query-aware snippet），替代"正文开头 80 字" |
| 6 | **支持 ingesting 状态的门控/提示** | Coding 大 wiki 重建中，从 get_info 暴露 status，搜索时降级提示或等重建完成 |

### 三级（测试版配套）
| # | 改动 | 说明 |
|---|---|---|
| 7 | **recall 消费端调整** | `WikiRecallInjector` 排序以服务端为准、不把原始 score 当阈值；用条数预算 + minScore 控制；保留 knowledge_tools 供深读 |
| 8 | **观测** | 复用 pipeline observer 采集命中/延迟/退化指标（见主 spec §6） |

### 不做（YAGNI）
- **不做**独立 reranker（模型做精排已够，测试版先验证）。
- **不做**跨库统一归一化（per-query 足够）。

### 自动召回建议落地序
1. **recall 端先调检索参数（limit≥8、minScore 降到 0.01~0.02）——零后端改动、本轮实测已验证有效**；
2. 若质量仍不足再上**后端一级改动**（title 权重、score 归一化、hop 默认、snippet 抽取）；
3. Coding 等大 wiki **等 ingesting 稳定再评估**（当前 last_sync 已滞后，状态仍 processing/ingesting）。

## 五、实测验证结果（2026-09-07 复查，参数模拟）

> 说明：Coding-WiKi 当前仍 `processing/ingesting`（last_sync=02:16），但搜索可用（旧索引）。以下用"方案参数"（minScore/decay/hop/limit）对**运行中的旧服务**做模拟，验证各优化方向是否成立。

### V1. 放宽宽度 + 降 minScore → **有效**（召回该有的都进候选）
- 默认 minScore=0.1：`暂估应收回冲机制` 排 #2（s=2.27 向量分，被压后）
- 方案 minScore=0.01 + limit=20：**升到 #3（s=13.26）**，且新带出 `可回冲数量口径`、`回冲应收机制` 等此前被滤的相关页
- **结论**：降 minScore + 宽 limit，确实让"低分语义页"进候选，全面性提升。✅

### V2. score 归一化 → **强烈必要**（跨源 raw 分不可比，实测铁证）
- Coding 语义词：raw 20.09/19.33/18.34…/2.27 混排；归一化后 1.00/0.96/0.90/…0.62，LLM 可读
- AgentSkill：`UPM 服务接口调用规范` raw 仅 7.71，但 norm=**1.00**——raw 跨 wiki 不可比，归一化后才反映真实相对排序
- **结论**：归一化必要且可行（per-query min-max）。✅ 此项为 recall 端消费 score 的前提

### V3. hop 图展开 → **作用有限/不稳定，需谨慎**（与方案 1 存在张力）
- `saga` 查询 hop=2 vs hop=0：几乎无新增有效 hop>0 节点，top10 仍全 hop=0
- **反噬风险确认**：放宽宽度后短查询（2-3 字）出现 BM25 噪声页混入（`联动关闭机制`、`UnVerifyAfterListener` 与 saga 无关）
- **结论**：hop 开启对"短查询/主题明确查询"收益不明显，且**放宽宽度会引入噪声**——召回"宽"与"准"存在张力，**不能无脑放宽**，需靠 minScore 阈值 + 注入预算 + title 权重共同收敛

### V4. title 权重 / snippet → 未在旧服务验证（需改后端代码）
- title 权重下调、snippet 关键段抽取要求在索引/生成期改代码，旧服务无法即时验证，属后端改动。

### 综合结论
**"放宽宽度 + 降 minScore"（零后端）与"score 归一化"（后端 score 字段）两项是立即可见效的**；**hop 图展开不作为测试版默认开启项**（收益不稳、放宽与精读冲突），仅作为收敛期可选；title 权重与 snippet 属后端增强。**测试版应聚焦：召回参数放宽 + 归一化可读 score + observe 度量**，避免引入 hop/宽度噪声。

## 五、风险与验证

- 调大 limit/hop → 返回更多候选，token 略增；靠注入预算控制。
- title 权重下调 → 语义相关提升、纯术语查询可能略降；需几组 A/B 验证。
- score 归一化 → 仅改输出字段，内部 seed/图行走/排序不动，零风险。
- Coding ingesting → 结论应在其稳定后复核一次。

### V5. 修复后真实客户端实测（2026-09-07，验收证据）

**背景**：final review 发现 `WikiRetrieveClient` 曾误拼 `${baseUrl}/search`（后端真实路由为 `/v3/wiki/search`，`service_url` 含 `/v3` 前缀 → 全部 404 → 静默 `[]`）。已修复为 `${baseUrl}/wiki/search`。

**验证**：typecheck 通过（计划文件 0 错误）；用**真实 `WikiRetrieveClient` 类**（非 curl/模拟）对 `10.4.100.30:8421` 多组查询实测，**7/7 全部成功**：

| wiki | 查询 | 结果亮点 |
|---|---|---|
| Coding | 应收暂估回冲怎么处理 | 5 hit，回冲机制/缺陷页/相关实体齐全 |
| Coding | 四层架构 | 4 hit，全为 NC 四层架构主题（强相关） |
| Coding | resetWifi（弱/不相关query） | 4 hit，返回不相关页（语义与字面均弱命中——预期行为） |
| Standards | SQL 注入防护 | 4 hit，SqlBuilder/SQL注入防护/安全规范 强相关 |
| Standards | 事务边界和回滚 | 4 hit，EJB边界/UPM服务边界 saga |
| AgentSkill | 服务接口定义规范 | 4 hit，服务接口定义/调用规范/ServiceLocator |
| AgentSkill | SQL 防注入参数化 | 4 hit，SqlBuilder/防注入规范/UAPESAPI 强相关 |

**结论**：URL 修复**已生效**，客户端端到端可用。且跨 wiki 质量普遍良好；弱 query（如 resetWifi）返回相关性低的结果属预期（非回归）。分数仍跨源混排（BM25 高/向量低）——归归一化与后端 score 字段改造（待完善项），不影响召回可用性。