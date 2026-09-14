# 设计文档：wiki 知识库自动召回（跟随记忆范式，内容注入）

> 日期：2026-09-07
> 模块：MemoryProxy（proxy 注入管线）—— 新增 `WikiRecallInjector`
> **状态：设计中**（三个关键决策已确认，待用户 review spec）

## 1. 背景与问题

### 1.1 现状：两条召回在"不同层面"运转

| | 记忆 (L1) | 知识库 wiki |
|---|---|---|
| 触发 | **自动**：`tdai-l1-recall-injector.ts`（`user.before` 点）在每轮 LLM 前按用户消息检索并注入 `<tdai_recalled_l1_memories>` 块 | **被动**：`knowledge-tools-injector.ts`（`system.before_tools` 点）只注入 `<knowledge_tools>` 资源清单 + curl 用法，明确要求「Wiki：何时调」（by LLM 决策） |
| 内容 | 片段直接进上下文，无需 LLM 决策 | 仅在 LLM 主动 `tools/call wiki search` 后才返回 |
| 检索 | TDai `/atomic/search`（服务端 hybrid） | Knowledge 服务 `/v3/wiki/search`（FTS5 BM25 + 向量 RRF，已在后端就绪） |

**问题**：知识库的检索能力（wiki `/search` 已在后端就绪）就绪，但 wiki 停留在「等模型主动调工具」这一层。当模型判断不出该查 wiki、或漏查，团队沉淀的设计文档就召不回。

**目标**：让 wiki 也像记忆一样**每轮自动检索并注入命中片段**到上下文，同时**保留** `<knowledge_tools>` 供模型按需点开读全文。这是一条**叠加能力**，不动现有 FTS/向量/工具链路。

### 1.2 可行性结论（基于源码事实）

- proxy 注入管线已有成熟的 `user.before` 动态召回范式（`tdai-l1-recall-injector.ts`），直接同构扩展即可。
- 绑定的 wiki 资源清单（含 `service_url`、`knowledge_id`、`summary`）已由 `KnowledgeToolsInjector`（复用 `CoreKnowledgeClient` 的 per-agent 绑定解析）注入，无需重复解析。
- Knowledge 服务的 `/v3/wiki/search` 已返回结构化结果 `SearchResult{path,title,snippet,score,type,hop,related}`，其中 `title` + `snippet` 正适合作为注入片段。
- RRF 混合检索已在后端完成，自动召回侧零算法改动。

**结论：可行，落点在 proxy 注入管线，改动集中、可逆、兼容。**

## 2. 关键决策（已确认）

1. **触发策略**：**方向 B 测试版**——每轮都自动检索并注入（不做意图门控）。**定位为可逆试验**：先跑通、采集实测数据，后续再对比方向 A（稳定摘要索引直注 system）/ C（意图门控）收敛。不做意图门控。
2. **内容粒度**：注入检索片段（`title` + `snippet` + `score`），**不拉整页正文**；同时**保留** `<knowledge_tools>` 供模型主动 `tools/call` 读全文（分层递进）。
3. **注入位置**：动态检索片段放 **`user.before`**（进 user message 前缀，每轮变化）；绑定的 wiki 资源清单（stable）仍由现有 `knowledge-tools-injector` 在 system 端负责。二者自然拼成「stable 进 system + dynamic 进 user」的记忆范式。

> **⚠️ 已知权衡（方向 B 的代价，必须记录）**：本项目的记忆侧**曾主动下线** `tdai-l1-recall-injector`（每轮注入动态内容到 user prompt），理由是**破坏 KV/prompt cache**（见 `injection/index.ts` L347-351、`tdai-tools-injector.ts` L22-23）。方向 B 会复刻这一行为。之所以仍选 B 作为**测试版**：KV cache 代价是**理论推算**，而自动召回的**命中收益是实测**——只有跑起来才能用数据判断「收益 > 代价」是否成立。测试期目标就是量化这两点（见 §6 观测），据此决定收敛到 A / B / C。

> **对比：为何不直接选方向 A**（稳定摘要索引直注 system）：A 注入的是**固定**摘要索引（页面清单 + summary），内容**不随具体 query 变化**，对「这一轮、这个问题」无针对性；用户需要的是「每轮针对当前问题召回」，故先以 B 验证动态召回的增量价值。

## 3. 架构设计

### 3.1 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| **`WikiRecallInjector`**（新增） | `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts` | `user.before` 点，按干净 user query 对绑定 wiki 并行 `/v3/wiki/search`，过滤/预算后渲染 `<tdai_recalled_wiki>` 块 |
| **`WikiRetrieveClient`**（新增，轻量） | `MemoryProxy/src/knowledge/wiki-retrieve-client.ts` | 封装对 `{service_url}/wiki/search` 的 HTTP 调用（body `{wiki_id, query, limit, minScore}`；header `x-tdai-service-id` + 遥测头） |
| **绑定解析（复用）** | `knowledge/core-client.ts` | `listAgentKnowledgeIds` + `listKnowledgeByIds` 已在 `KnowledgeToolsInjector` 使用；`WikiRecallInjector` 复用同一 client 解析当前 agent 绑定的 `type==="wiki"` 资源 |
| **预算/格式化（新增纯函数）** | 同文件 | `applyWikiRecallBudget`（maxCharsPerHit / maxTotalChars / maxHits）、`renderWikiRecallBlock`（渲染 wiki 名 + type + score + title + path + snippet；hop>0 标注 `[图展开]`，排除 related） |

### 3.2 数据流

```
user message 到达注入管线
  └─ user.before 点（priority 与 MEMORY 同区；TdaiL1RecallInjector 已下线，此处由 WikiRecallInjector 占据动态召回位）
      └─ WikiRecallInjector（新增）
          1. 解析当前 (team, agent, userKey, spaceId) identity（复用 getTdaiIdentity）
          2. 取干净 user query = extractUserQueryText(last user message)（复用 recorder）
          3. 用 CoreKnowledgeClient 解析绑定 wiki 资源（type==="wiki"，filter capabilities）
          4. 对每个绑定 wiki 并行：WikiRetrieveClient.search({wiki_id, query, limit:perWikiLimit, minScore})
              租户 serviceId = 会话 spaceId（与 listBoundWiki 同源；修复前误用 config.knowledge.serviceId → 404）
          5. 合并所有命中 → normalizeScores（min-max 归一化到 0~1）
              按 normScore 降序排序 → 过滤 normScore < minInjectNormScore → 取 globalTopK
              （务必"先排序再截断"：normalizeScores 不重排，直接 slice 会让先绑定的库挤掉后库高分命中）
          6. 套 <tdai_recalled_wiki> 块（每条含 score + [wiki 名] title + snippet）→ 截断到预算
          7. 空/失败/全部低于门槛 → 返回 []（graceful degradation，宁缺毋滥）
```

> **实现修正（2026-09-07 排障）**：多 wiki 召回曾出现"Coding 高分精准页被 Standards 挤掉 / 召回块只剩一个 wiki"。两处修正已落地——
> ① 检索租户用**会话 spaceId**（此前 404）；② 合并后**先按 normScore 排序再 slice**（避免绑定顺序挤压），并加 **minInjectNormScore 注入门槛**过滤低分泛条目。

### 3.3 召回内容：该包含/排除哪些字段

**原则**：注入的内容要让 LLM 能**独立判断这条片段是否可信、是否值得深入读全文**，同时**最小化 token**。基于 `SearchResult{path,title,snippet,score,type,hop,via,related}` 逐字段决策：

| 字段 | 是否注入 | 理由 |
|---|---|---|
| `title` | ✅ | 页面标题，主题识别的基本锚点 |
| `snippet` | ✅ | 页面概述（静态预生成：frontmatter description 或正文前 N 字，**不随 query 动态高亮**）——段落参考价值的核心 |
| `score` | ✅ | 相关度分，LLM 判断可信度/排序依据 |
| `type` | ✅ | **新增**：`entity/concept/methodology/comparison...`，LLM 据此瞬间判断"这是定义还是做法"，比光看标题准 |
| `path` | ✅ | **新增**：页面定位句柄，LLM 想读全文时可直接去 `page/read` 该页，构成"片段→定位→读全文"无缝衔接（与保留 knowledge_tools 方案配套） |
| `hop` | ⚠️ 语义处理 | `hop>0` = 经 wikilink 图展开走到的**间接命中**（正文不直接命中 query）——标注 `[图展开]` 或靠后排序，避免 LLM 误当直接答案。`via` 可注明"经 xxx 关联" |
| `related` | ❌ 排除 | wikilink 邻居数组，是 read_page 全文导航用的，对自动召回片段无直接价值，注入纯增 token |

**注入块格式（user.before 文本）**：

```
<tdai_recalled_wiki>
以下是当前轮用户问题自动召回的团队 wiki 片段（按相关度排序）；每条前的 [wiki:xxx] 标注其来源知识库（如 Coding-WiKi / Standards-WiKi / AgentSkill-WiKi），多 wiki 命中时据此区分来源。
仅辅助回答当前这一轮；若需完整正文，请用 <knowledge_tools> 里的 tools/call wiki read_page（path 见下）。

1. [wiki:Coding-WiKi] [concept] score=0.41 — 应收暂估回冲
   path: entities/应收暂估回冲.md
   应收暂估指发票未达时按...（snippet）...
2. [wiki:Coding-WiKi] [methodology] score=0.38 [图展开] — 四层架构
   path: methodology/四层架构.md
   分层职责为 controller/service/...（snippet）...
</tdai_recalled_wiki>
```

要点：
- 每条含 **wiki 名 + `type` + `score` + `title` + `path` + `snippet`**，LLM 可独立判断可信度与是否深读。
- `hop>0` 的命中标注 `[图展开]`（外加 `via` 若可注明），明确其为间接相关。
- 明确标注「片段仅供参考」，引导 LLM 需全文时走 `<knowledge_tools>` read_page（path 可直接定位）。
- 与 `<tdai_recalled_l1_memories>` 视觉同构，降低 LLM 解析成本。

> **局限（记录）**：`snippet` 是静态页面概述、不针对单轮 query。测试版接受此静态片段（零改后端），若实测"片段贴不上具体 query"则把 **query-aware snippet**（后端 search 按 query 动态截取命中片段）记为收敛期优化项。

### 3.4 配置与预算（与记忆召回对齐）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `perWikiLimit` | 8 | 每个 wiki 取前几命中 |
| `globalTopK` | 5 | 合并后保留条数 |
| `minScore` | 0.02 | 后端检索相关度下限（放宽，让低分语义页进候选池） |
| `minInjectNormScore` | 0.6 | **注入门槛**：归一化后 normScore（0~1，最高=1.0）低于此值的候选不注入；`<=0` 或缺失 = 不启用。避免把明显低于"这批最高分"的泛条目不必要地塞进上下文 |
| `hop` / `decay` | 0 / 0.5 | 图展开 hop（V3 实测默认不开启）；hop>0 时随请求下发 decay |
| `maxCharsPerHit` | 0（不限制） | 单条片段截断 |
| `maxTotalChars` | 0（不限制） | 整块总字符预算 |
| `timeoutMs` | 3000 | 每次 search 超时（召回非关键，必须快） |

**排序与门槛（排障后修正，2026-09-07）**：
- **必须先按 `normScore` 降序排序再取 topK**：`normalizeScores` 保持数组原顺序不重排，若直接 `slice(0, topK)` 会按"绑定的 wiki 顺序拼接"截取，导致排在前面的知识库（如 Standards）挤掉后面知识库（如 Coding）的高分精准命中——实测"采购合同变更主键"的精准页 norm=1.0 曾被 Standards 0.5- 挤掉。修复为 `sort(desc) → slice(topK)`。
- **注入门槛 `minInjectNormScore`**：过滤 `normScore` 低于阈值的候选；过滤后为空 → 不注入（`[]`）。

降级规范：
- 某 wiki search 抛错/超时 → 跳过该 wiki，不中断整体。
- 全空/全失败 → 返回 `[]`，零注入，行为与记忆召回完全一致。
- 全部候选低于 `minInjectNormScore` → 返回 `[]`，宁缺毋滥。

## 4. 与现有机制的关系

- **不替代** `<knowledge_tools>`：知识工具块继续注入，模型仍可 `tools/call` 读全文。自动召回是「把片段先塞进上下文」的叠加层。
- **不修改** `KnowledgeToolsInjector`（stable 段不用动）。
- **不动** MemoryCore / MemoryKnowledge / 检索算法（RRF 已在后端）。
- **隔离**：按 (team, agent, userKey) identity 解析绑定 wiki，天然租户隔离（复用 `CoreKnowledgeClient` 现有 per-agent 绑定评估）。

## 5. 边界与一致性

1. 无绑定 wiki / agent 解析不到 → 返回 `[]`，零影响。
2. `service_url` 不可达 / search 失败 → 跳过该 wiki，整体降级。
3. 片段截断：按 code point 截断（对齐记忆 `truncateRecallLine` 的 surrogate-pair 安全逻辑）。
4. 分数阈值为 0 → 不注入噪声（向量/BM25 低分片段）。
5. 与 L1 记忆块共存：两段独立渲染、独立预算，不互相影响。
6. 超时兜底：整体召回 ≤ 单个 wiki 超时 × 并发（并发执行，实际近单次耗时），保证不卡注入管线。

## 6. 测试版观测与收敛路径（核心：用数据决定 A/B/C）

**测试版的目的**：量化「方向 B 的 KV cache 代价」与「自动召回的命中收益」，据此收敛到 A / B / C。

### 6.1 观测指标（通过 pipeline 既有 `InjectionObserver` + hook 日志）

| 维度 | 指标 | 采集点 |
|---|---|---|
| 命中收益 | 每轮是否注入、注入条数、avg/max score、命中 wiki 数 | injector execute 返回的 blocks metadata |
| KV cache 代价 | 每轮注入字符数（≈动态 token）、动态部分在 user prompt 的变化幅度 | `maxTotalChars` + block content 长度 |
| 延迟 | `WikiRetrieveClient.search` 耗时（timeout 内）、整体 injector duration | observer 已记录 durationMs |
| 退化 | search 失败/超时次数、降级零注入次数 | injector 日志 |

### 6.2 收敛判定（测试期结束据此决策）

- **若注入显著提升回答质量、且 KV cache 代价可接受** → 维持 B（可加 `enabled`/`maxTotalChars` 调优）。
- **若 KV cache 代价成为明显痛点（每轮 miss）** → 收敛到 **C（意图门控）**：只对命中强 wiki 主题的 query 才检索注入，其余零注入（保持自动 + 降 cache 破坏）。
- **若命中收益有限、或「页面清单能解决认知」** → 收敛到 **A（稳定摘要索引直注 system + 工具按需读全文）**：注入 `<knowledge_tools>` 旁的稳定页面摘要索引，cache 友好，语义随页面稳定、不随单轮 query 波动。
- **若命中但片段"贴不上具体 query"（静态 snippet 局限显现）** → 增加 **query-aware snippet** 优化项（后端 `/search` 按 query 动态截取命中片段），作为 B 的增强而非替代。
- **若收益与代价均不显著** → 直接关闭（`enabled: false`），退化为现状（知识工具按需调用），零残留。

### 6.3 前置验证（spike）

- 确认 proxy 侧可直接对 `{service_url}/wiki/search` 发起 HTTP（`service_url` 是否含 `/v3` 前缀、是否需要额外鉴权/遥测头）——复用 `knowledge-tools-injector` 里的 curl 头字段即可，风险低。
- 确认绑定的 wiki 资源里 `type==="wiki"` 的 `service_url` 均为同一 Knowledge 服务端点，还是可能多端点（若是多端点需按端点点分组并发，逻辑不变，仅实现细节）。
- 引入的并发 HTTP 请求数量 = 绑定 wiki 数（≤ 记忆召回量级），可接受。

## 7. 测试

- 单元：`WikiRetrieveClient.search` 请求/响应解析；`applyWikiRecallBudget` 截断/预算；`renderWikiRecallBlock` 格式（score/wiki 名/snippet）。
- 集成（mock WikiRetrieveClient）：多 wiki 并发 → 合并按 score 排序 → topK；某 wiki 失败 → 跳过不中断；全空 → `[]`。
- 回归：未配置 wiki / agent 无绑定 → 零注入；与 L1 记忆块共存不冲突。

## 8. 兼容性

- 仅 `MemoryProxy` 新增 injector + client，不动既有注入器、不动 backend、不动 memory/knowledge 服务。
- **测试期可随时回退**：`wiki-recall-injector` 由独立 `enabled` 配置 gate；置 `false` 即完全退化到现状（仅 `<knowledge_tools>` 按需调用），零残留。
- 配置缺省关闭对新部署无影响（`enabled` 默认 true，但无绑定 wiki 时自然零注入）。