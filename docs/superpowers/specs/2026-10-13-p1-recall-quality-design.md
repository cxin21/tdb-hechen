# P1 召回质量与上下文体积优化设计（MemoryReranker / wiki JIT / worthiness / bi-temporal 补口）

- 日期：2026-10-13
- 状态：draft r3（brainstorming 产出，builder-check 修订 + 用户四项拍板已合入，待最终批准；批准前不写产品代码）
- 前置：P0 修复已交付（commit b68d167 + 23d4923，issue cxin21/tdb-hechen #1 #2），本设计是其上的 P1 层。

> **变更记录（2026-10-14，用户拍板）**：M1 rerank 与 M3 importancePenalty 的 **shadowMode 配置项整体移除**——
> 不再提供「只记录不生效」的影子开关：面板无开关、配置面无键（旧载荷携带该键被静默忽略），
> 两门开启即真实生效；journal 观测保留（`gates.rerank` kept/dropped/topScore、
> `gates.importancePenalty` raw/penalized 双分量）。本文 §4/§6 中 shadow-first 相关段落为历史设计记录，
> 以本变更为准。

## 1. 背景与动机

P0 之后剩余两个用户可感知痛点（用户原话确认）：

1. **召回不准确有污染**：现排序只有「相似度」（BM25/向量/RRF/规则加权），没有「与当前对话有用度」；字面共现就能把噪音抬进注入块。
2. **上下文经常爆炸**：每轮注入构成实测——L1 记忆块理论最大 ≈10KB（globalTopK 5 × maxCharsPerMemory 2000，MemoryProxy/src/injection/injectors/tdai-l1-recall-injector.ts:37-44）、wiki 块 ≤1200 chars（本机 etc/proxy-config.yaml:782；仓内对照 deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml）、skill listing 预算 8000 chars（session_init，MemoryProxy/src/skill/core-client.ts:201，不在本设计范围）。

业界参照（调研文件 .scratch/2026-10-13-recall-noise-research.md 与 docs/research/2026-10-13-memory-rag-systems-survey-td-agemem.md）：Mem0（rerank 可选 + 失败降级回原序；本地 cross-encoder 走 Xenova/bge-reranker-base ONNX）、Zep/Graphiti（reranker_min_score 一等公民 + bi-temporal）、Generative Agents（写入时 importance 1-10）、LangMem（记忆须 sufficiently informative in isolation）、HippoRAG 2（结构不得伤 vector 基线）、cuconasu（不相关上下文直接提升幻觉率）。

**本地 spike 已验证**（2026-10-13，资产 D:\TDB\data\spikes\reranker-spike\ 与 D:\TDB\data\models\reranker-spike-local\）：Xenova/bge-reranker-base INT8 = 266.4MB 磁盘 / 冷加载 0.8s / RSS 614MB / 8 对精排 110~170ms（warm 110ms）；金种子矩阵上相关与噪音 logit 间隔 4~9（sigmoid 0.99 vs 0.01），切分余量极大。

## 2. 目标 / 非目标 / 反目标

**Goals**

- G1 精排上线后：相关行置顶、噪音行出局（宁缺毋滥），每轮新增延迟 ≤300ms。
- G2 wiki 注入常态体积从 ≤1200 chars 降到 ≤500 chars（单条「标题+一行摘要」≤100 chars），正文按需 tool 取。
- G3 低价值记忆降权不丢数据：importance 打分进排序，判错代价是「暂时想不起来」而非「永久丢失」。
- G4 失效写面补齐 + 钩子路完整时间区间过滤（bi-temporal 补口，非结构改造）。

**Non-goals**

- 不做硬丢弃（用户拍板：降权存储）。
- 不改 L0→L1 提取管道的抽取逻辑，只追加 importance 字段。
- 不动 skill 注入管线（8KB listing）。
- 不引入 GPU 依赖；不出 Windows/macOS/Linux 之外的运行面假设。
- 不回退 P0 已交付门控。
- validityNow 的 as-of 时间旅行推广到钩子路：**有意收窄**，进 backlog（无产品需求方，见 §7）。

**Anti-goals（出现即失败）**

- 精排让每轮延迟可感知（>500ms 或熔断前每轮都吃超时）。
- JIT 后 agent 无法拿到 wiki 概览（摘要都没了）。
- worthiness 判错导致记忆永久丢失。
- bi-temporal 行为在 sqlite fallback 与 native TCVDB 两条路分叉。

## 3. 已定决策（用户拍板，不再讨论）

1. 四项全部完整设计，MemoryReranker 与 wiki JIT 优先。
2. 记忆原文出域可接受 → 云端 rerank API 为正式路线。
3. panel 必须支持 reranker provider 配置，交互与 embedding 模型配置同款。
4. 未配置 API 且勾选开启 rerank 时 → 自动检测并下载本地模型兜底。
5. 接记忆的 agent 均支持 tool 调用 → JIT 按需取正文可行。
6. worthiness = 降权存储。
7. 全部四项 shadow-first：先只记录不生效，与现网并排对比无误杀再切换（C3 domainRouter 教训）。
8. wiki JIT 放量开关 = **meta 能力位 + panel 管理**（与 llm_wiki.enabled 同款模式；per-team/per-agent 开关，改配置不重启 proxy）。
9. M1/M2「完成」= **交付代码 + 本机验收**（golden 回放 + 种子矩阵 E2E）；生产部署、开 shadow、收集影子数据由用户执行，影子期不占开发排期。
10. 云端 rerank **硅基流动先行**（/v1/rerank Cohere/Jina 兼容通用 schema，Qwen3-Reranker-0.6B 起步）；dashscope adapter 随后补。
11. 生产 /opt/tdai 内存 **4GB 总 / 2.5GB 可用** → 生产强制云端 API；local 兜底仅限开发机（按开发便利标准做内存治理，无 OOM 演练要求）。

## 4. 设计 A：MemoryReranker（召回精排）

### 4.1 接口

```ts
interface MemoryReranker {
  rerank(query: string, docs: string[]): Promise<Array<{ index: number; score: number }> | null>;
}
```

`null` = 不可用/失败，调用方降级回原序（Mem0 模式，永不阻塞召回主链路）。

### 4.2 Provider adapter（与 embedding provider 同构）

| provider | 端点 | 模型（起步默认加粗） | 备注 |
|---|---|---|---|
| `siliconflow` | POST `{baseUrl}/v1/rerank`，Cohere/Jina 兼容 `{model, query, documents, top_n}` | **Qwen/Qwen3-Reranker-0.6B**，可配 4B/8B、BAAI/bge-reranker-v2-m3 | schema 已核实（官方 API 文档）；**M1 首发** |
| `dashscope` | POST `/api/v1/services/rerank/text-rerank/text-rerank`，自有 schema | **qwen3-rerank**、gte-rerank-v2 | gte-rerank v1 2026-05-30 下线，不得选；M1 内随后补 adapter |
| `local` | transformers.js（onnxruntime-node）+ Xenova/bge-reranker-base q8 | 固定起步；worker_threads 内懒加载 | 仅开发机（决策 11） |
| `none` | — | — | 未配置 = 跳过精排，行为 = 现状 |

### 4.3 配置面（panel 与 yaml 同源）

`tdai-gateway.yaml → memory.recall.rerank.*`：

```yaml
enabled: false            # panel 勾选
provider: none            # siliconflow | dashscope | local | none
apiKey: ""                # 云端 provider 必填
baseUrl: ""               # 缺省用 provider 官方端点
model: ""                 # 缺省用 provider 推荐档
timeoutMs: 800
candidates: 12            # 送精排的候选池（原 topK 5 → 精排后取回 5）
minScore: -2.0            # logit/融合分门槛，shadow 校准后定稿
local:
  modelDir: ""            # 缺省 dataDir/models/reranker/Xenova/bge-reranker-base
  idleUnloadMs: 600000    # 空闲卸载，0=常驻
shadowMode: true          # phase-1 只记录不生效
```

panel 表单复用 ValueAnchorsPanel/embedding 配置的交互模式：勾选 enabled → provider 下拉 → 按 provider 显隐 apiKey/baseUrl/model → local 时显示「模型状态：已下载(266MB)/未下载/下载中 xx%」。

### 4.4 自动下载器（provider=local 且模型缺失时触发）

- 文件清单（Xenova/bge-reranker-base）：`config.json`、`tokenizer.json`（17MB）、`tokenizer_config.json`、`special_tokens_map.json`、`onnx/model_quantized.onnx`（266.4MB）。
- 实现：Node fetch 直链 + 浏览器 UA + 指数退避重试 + Range 断点续传（spike 已验证 curl `-C -` 可行；transformers.js 内建下载器会被 hf-mirror 429，**不要用**）。
- 源：主 `https://hf-mirror.com`，备 ModelScope；落盘 `dataDir/models/reranker/`；下载完成校验总大小后置 ready 标记。
- 进度展示：panel **轮询**（沿用 wiki ingest 轮询先例；panel 现无 WebSocket/EventSource 推送通道，不按「已有事件通道」估算）。
- spike 期间已下载的实测资产（266.4MB，位于 `D:\TDB\data\models\reranker-spike-local\`）可被实现直接搬运/复用。

### 4.5 接入点与失败语义（MemoryCore）

- 位置：`performLayeredRecall`（MemoryCore/src/core/hooks/auto-recall.ts:360）内，searchMemories 返回候选后、foldNearDuplicates/applyRecallBudget 之前；候选池 `recall.maxResults` 扩到 `rerank.candidates`(12) 供精排，精排后取回 `maxResults`(5)。
- 结构行（R7 结论层行、灵魂行、锚行）不参与精排，始终保留——精排只作用于 L1 经验候选。
- 失败：超时/429/网络错 → 返回 null → 原序 + 一次 warn；连续 3 次失败熔断 60s（熔断期直接跳过精排，不吃延迟）。
- journal：recall journal 新增 `gates.rerank: { provider, ms, kept, dropped, topScore, shadow }`（复用 P0 的 gates 通道，MemoryCore/src/core/recall/recall-journal.ts:35 同级扩展）。

### 4.6 Shadow-first 与验收

- phase-1 `shadowMode: true`：精排照跑，只把「若生效会怎样」写 journal，不改注入。
- 校准目标（用 golden 回放 + 影子数据）：相关 avg score − 噪音 avg score ≥ 3 logit；minScore 定在分界带内。
- 验收：① shadow 期间无误杀（会杀掉的行人工复核）；② 切换后 golden 全绿 + 本机 E2E 种子矩阵（spike 用例固化进 MemoryCore 测试）；③ P95 延迟增量 ≤300ms、熔断生效。
- 里程碑边界（已拍板，决策 9）：交付 = 代码 + 本机验收；生产部署/开 shadow/影子收集由用户执行，影子期不占开发排期。

## 5. 设计 B：wiki JIT 注入

- 现状：每轮 `<tdai_recalled_wiki>` 注入全文片段 ≤1200 chars（wiki-recall-injector.ts:354-355 applyRecallBudget）。
- 目标形态：单条 = `标题 + 一行摘要(≤80 chars) + [详情: tool wiki_fetch]`，单条 ≤100 chars、整块 ≤500 chars。
- 正文通道（builder-check 定案）：`wiki_fetch` 走 **knowledge tool 面**——knowledge-tools-injector 渲染 KS 8421 的 `/tools/list`、`/tools/call`（wiki 正文在 Knowledge 服务；memory-bridge 面反代的是 MemoryCore，取不到 wiki 正文，故不选；身份/allowlist 语义沿用 knowledge tool 既有模型）。入参 `{ doc_path | title, section? }`——doc_path = KS 页面 path（对应 WikiSearchHit.path；WikiSearchHit 无独立 doc_id 字段）；出参正文（单次 ≤4000 chars 截断）。agent 侧已确认支持 tool。
- 例外：候选原文本身就短（≤160 chars）直接注全文，不强制 JIT。
- 降级：per-agent `jit=false` 回退现行为（为未来不支持 tool 的接入面留门）。
- 灰度（配置载体已拍板，决策 8）：per-team/per-agent 开关走 **meta 能力位**（AssetCapabilityFlags，同 llm_wiki.enabled 模式）+ panel UI 管理，改配置不重启 proxy；journal 记录每次注入 chars 与「若 JIT 会注入 chars」对比。
- 验收：注入体积 P50/P95 下降 ≥60%；tool 往返成功率 ≥99%；摘要行足以让 agent 判断「要不要取详情」（人工抽检）。
- 单轮取文次数：prompt 软指引 ≤3 次（不做 memory-bridge 跨请求硬限流——wiki_fetch 只读、无破坏面，硬限流是独立有状态工程项，收益不成比例）。

## 6. 设计 C：worthiness 降权存储

- 打分：挂在现有 L0→L1 提取的同一 LLM 调用里（Generative Agents importance 1-10 + 一句理由），**零额外 LLM 调用**；产物存 `l1_records.importance TINYINT NULL` + 理由入 metadata（迁移幂等，参考 l1_fts 17→25 列迁移模式）。
- 与既有 `significance` 的分工（builder-check 定案）：significance = 提取时显著度（已生效于 sigWeight、引擎三 `significance DESC` 排序 sqlite.ts:3306、遗忘红线 sig≤0.1），**保持不动**；importance = 写入时普适价值评估（与 query 无关）。合成：importancePenalty 仅对 importance≤4 惩罚、sigWeight 原样；shadow 期间 journal 分别记录两分量贡献，校准时再定是否合并——避免两路权重叠加导致 A/B 无法归因。
- 降权语义：recall-signals 增加 `importancePenalty`；`importance IS NULL`（旧数据、本地无 LLM）→ 不惩罚。
- 无 LLM 环境（本机 TDAI_LLM_API_KEY 占位符）：字段不写，行为 = P0 现状，不报错。
- 不丢弃：任何路径不删记忆；遗忘 worker 既有红线不变（仅 observed 自动归档、identitySlices/价值锚/appraisal 保护）。
- Panel：记忆详情展示 importance + 理由；提供「手动调级」入口（写回 importance，标注来源=manual）。
- 验收：种子会话端到端——寒暄行 importance ≤3、决策行 ≥7；召回 A/B（journal 对比）低分行不出现、高分行保留。

## 7. 设计 D：bi-temporal 补口

代码盘点结论（2026-10-13）：valid_start/valid_end/occurred_at 三时间线 + validityNow 已落地（GROW-EVO P2），仅剩两口（validityNow as-of 推广到钩子路 = 有意收窄进 backlog，非遗漏）：

1. **失效 API 补面**（写路收敛，builder-check 定案）：`/v3/atomic/invalidate { record_id, valid_end?, mode?: "invalidate"|"restore" }`，缺省 invalidate。实现为 v2-router handleAtomicUpdate 既有 valid_end 写路（v2-router.ts:1263-1275 → invalidateL1）的**语义化薄封装**，不造第三条失效写路；`mode:"restore"` = 清空 valid_end（需放开 update soul 回写对既有 valid_end 的拷贝限制，v2-router.ts:1249 一并处理）；panel 记忆详情加「标记失效/撤销失效」（对齐 veto 可逆哲学）。
2. **钩子路区间过滤对齐**：filter-invalidated.ts（MemoryCore/src/core/recall/filter-invalidated.ts:6）当前只查 valid_end；对齐工具路 filterByValidity 的完整 `valid_start ≤ now ≤ valid_end` 区间语义（解析失败保留，宁漏勿错）。

验收：失效/未来生效记忆在钩子路与工具路都不召回（E2E 两路断言）。

## 8. 排期建议

M1 reranker（接口+siliconflow adapter+dashscope adapter+local provider+下载器+shadow journal+panel）→ M2 wiki JIT（knowledge tool+注入瘦身+meta 能力位+panel，可与 M1 并行——M1 在 MemoryCore，M2 在 MemoryProxy/Knowledge/meta）→ M3 worthiness → M4 bi-temporal 补口。每项独立 flag、独立回滚，全部 shadow-first 切换。

## 9. 留给 builder 的决策（已授权自决）

- 精排候选数、minScore、importancePenalty 权重：给可配默认值，shadow 数据出来后校准。
- wiki 摘要行来源：核实 knowledge_item 是否已有 summary 字段；没有就用首段首句截断。
- worker_threads vs 子进程：实现者按 onnxruntime-node 兼容性定，要求 OOM 不连坐主服务。
- dashscope adapter 字段细节以官网文档为准。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| hf-mirror 429 限流（已实测） | 直链+UA+重试+断点续传，备源 ModelScope，模型落盘一次复用 |
| 精排压掉长尾相关行 | 候选池 5→12 缓冲 + shadow 人工复核 + minScore 分界带内取值 |
| JIT 使 tool 调用变多 | 单轮 ≤3 次 prompt 软指引；wiki_fetch 只读，不做跨请求硬限流 |
| 本地模型 614MB RSS | 生产 4GB 总/2.5GB 可用 → 生产强制云端 API（决策 11）；local 仅开发机，idleUnloadMs 空闲卸载照实现 |
| LLM 不可用（本地） | worthiness/rerank 全部可降级，行为=P0 现状 |

## 11. builder-check 勘误记录（2026-10-13 r2）

- recall-journal.ts / filter-invalidated.ts 实际位于 `MemoryCore/src/core/recall/`（初稿误写 core/hooks/，已改；行为断言本身成立）。
- etc/proxy-config.yaml 为本机运行时物化文件不入仓；仓内对照物 = `deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml`。
- panel 无推送通道：下载进度按轮询设计（§4.4 已改）。
- 其余承重断言核实成立：performLayeredRecall 接入点与结构行豁免、gates.rerank 扩展点、memory.recall 命名空间、l1-extractor 单次 LLM 调用可挂 importance、l1_fts 17→25 迁移先例、工具路 filterByValidity 对齐目标存在。
