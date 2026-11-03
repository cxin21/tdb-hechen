# 记忆分层与提取算法：现状诊断与优化方案

> 2026-11-02 · 只读取证（零代码/零配置改动）· 数据源：`D:/TDB/data/vectors.db`、`D:/TDB/data/instances/default/memory-generation-logs/v1`、`D:/TDB/data/profiles/.../scene_blocks/`、仓库 HEAD `b8ba3e0`
> 关联：#179（召回选线，已上线）、#146/#137/#134（写面策略）、#79（subject 抽取）

## 0. 摘要

1. **层级本身没有错**：L0 转录 → L1 情景记忆 → L2 场景叙事 → L3 结论卡，与 Mem0/Zep/Letta 的"工作上下文 → 结构化持久层 → episode 归档"三段式同构。问题不在分层，在**每层的写入粒度与消费面不匹配**。
2. **最大成本项是 L2 而非 L1**：L2 今日 99 次 agentic 重写 × p50 74 秒 ≈ **2.0 小时 LLM 墙钟/天**，14 个块（188,850 字节）全天被反复整篇重写；而消费面只有 **14 行 summary**（系统提示里的"场景索引"）+ 9 次/全史的 L3 与 persona 生成。
3. **L3 不是被调度器饿着，是被 subject 键饿着**：调度每 10 分钟一轮、`minCount=3`，但 2,647 条有 subject 的记录里 **1,587 个 subject 只出现 1 次**（distinct 1,662），全史只产出 10 张卡。分组的键是"整句字符串相等"，粒度天然不可复用。
4. **三条常见假设被实测证伪**（见 §4）：① 语义冗余不是问题；② 提取得不是太多而是太薄；③ L1 延迟已经不是瓶颈。
5. **一个"半成品成本"**：抽取侧 `extraction.facts.enabled: true` 已为 420 条记录多输出 2–5 条事实短语，但写侧 `factKey.enabled: false`、`factRows: false`（#146/#149 实测负收益后显式关），factTriples 输出 **0 条** —— 付了 token，没有一个消费者。

**如果只做一件事**：先给 L2 装触发门（A1），把 2 小时/天降到 30 分钟/天；再决定 facts 通道的生死（A2）。这两项都是"减少已付款但无回报的开销"，不需要新数据、不改检索行为。

## 1. 方法与证据边界

- **库读数**：`node:sqlite`（`DatabaseSync`，readOnly）直读生产 `vectors.db`；sqlite3 CLI 与 better-sqlite3 在本机不可用。
- **日志读数**：`memory-generation-logs/v1`，每 run 两文件（meta + body），按 `generation_id` 去重后统计延迟/体积；L2 的 `prompt_text`/`raw_output` 记 0（不落盘），因此 L2 的 token 成本只能按墙钟时间与块体积估算。
- **语义冗余**：复用 `.scratch/emb-cache.json` 已缓存的 2048 维向量（sha256 内容寻址），命中 330 条 L1 记录，两两余弦。
- **同类调研**：新增 8 个系统的一手来源取证（arXiv 全文 / GitHub 文件 / 官方文档），叠加仓库既有 `docs/research/systems-deep-dive.md`、`docs/research/benchmarks-and-optimizations.md`；**跨论文数字不可比**，本文只引用机制，不排名。
- **未做**：没有改任何 prompt / 配置 / 代码；没有做人工标注；`precision` 类结论沿用 #179 的代理口径（注入行中 high+mid 占比）。

## 2. 现状读数

### 2.1 量级

| 层 | 载体 | 量 | 说明 |
|---|---|---|---|
| L0 | `l0_conversations` | 13,780 轮 | 今日 187 轮 / 8 会话 |
| L1 | `l1_records` 存活 | 3,807 | 写入总量 10,333 → **63%（6,526）被归档** |
| L2 | `scene_blocks/*.md` | 14 块 / 188,850 字节 | 单块 8,618–20,490，全部块 mtime 均在今日 |
| L3 | `type=work_fact & scene_name='consolidated'` | 10 张 | 另有 reflection 卡（`scene_name='reflection'`）861 条 work_fact |

L1 类型：episodic 2,087 / work_fact 1,026 / instruction 396 / persona 281 / work_method 12 / work_task 5。
长度：p50 **170** 字符、p90 361、p99 548、max 1,283 —— **每条记忆是一个句子，不是一件事的完整语义单位**。
确定性：observed 3,661 / inferred 146；source：extraction 2,936 / null 871。
边：derived_from 23,551 / similar 9,612 / evolve 730 / part_of 670 / **conflict 91**。
实体层：`entity_knowledge` 1 行，`entity_users/agents/tasks/teams` **全 0**。

### 2.2 成本与延迟

| 层 | 全史 runs | p50 | p95 | 11-02 当天 |
|---|---|---|---|---|
| L1 | 2,763 | 207,845ms | 287,874ms | 52 runs，**p50 10.9s** |
| L2 | 1,353 | 203,205ms | **1,093,777ms** | 99 runs，p50 74,422ms |
| L3 | **9** | 29,412ms | — | 1–2 runs |

L1 prompt p50 11,967 字符 / 输出 p50 3,189 字符；avgIn 5.4 条 L0、avgOut 3.2 条 L1。
**延迟趋势是反转的**：10-14…10-25 每天 p50 都在 190–228 秒，10-27 起 91s/58s/114s，11-02 降到 10.9s —— 历史"3.5 分钟/批"的瓶颈已消失，现在不是慢，是结构。

### 2.3 消费面（谁在读）

- 召回注入：L1 候选行（经 #179 选线，生产 `maxChars=600`、`floor=0.30`、`keepRatio=0.67`）+ **14 行场景 summary**（`auto-recall.ts:1102,1202`）；L2 正文不注入。
- L2 正文：只被 L3 巩固与 persona 生成读（`pipeline-factory.ts:1347-1450` 的 `input_refs`、`persona-generator.ts:108-129`）。
- L3 卡：作为 L1 行参与召回（`recall-layered.ts:187` 把 work_fact 候选称为"L2 结论层"，与存储层编号不同义）。

## 3. 结构性问题（每条：现象 → 证据 → 锚点 → 影响）

### P1 语义单位错位：L1 是"句子"而不是"事实"或"事件"
- 证据：p50 170 字符；episodic 中 >300 字 539 条；每类都有"合并后超过 300 字必须拆"的硬规则。
- 锚点：`MemoryCore/src/core/prompts/l1-extraction.ts:40`、`:216`（拆分红线 300 字）。
- 影响：一条"决定先做前端再谈分摊算法"被拆成 3–5 行；召回时预算 600 字符只能装 2–3 行，**同一件事的碎片互相竞争**，且任一碎片单独看都缺主语/时间。

### P2 主语污染：三分之一的记忆在说 AI 自己
- 证据：945 / 2,946（32.1%）非 reflection 存活行的主语是"AI/我/我在/我的"，均长 174；样例：`我在任务被环境阻塞时执行红线…`、`我长期承担每日07:00…推送…`。
- 锚点：`l1-extraction.ts:429-435` 的 `AGENT_ACT_BLOCK`（"以第一人称提取为独立记忆"）与 `:39`"提取主体必须以用户或 AI 为核心"——**规则自洽但产品意图不明**：注入预算只有 600 字符时，AI 自述与用户事实直接竞争。
- 影响：注入精度代理 50%（#179），这意味着约一半注入行不是"用户需要知道的上下文"。

### P3 没有事实结构：答不了"现在是什么/什么时候变的"
- 证据：`valid_end` 3,807 行全是空串（样本 `2026-10-14T02:08:56.559Z//`）；`conflict` 边仅 91；实体表空转；`metadata.facts` 420 行但 `factTriples` 0 行。
- 锚点：`src/core/record/write-policy.ts:91-103`（`factKey.enabled=false`、`factRows.enabled=false`、`supersession.enabled=true`）；`config.ts:1235-1243`（#146/#149 的负收益结论）。
- 影响：supersession 开着，但读侧没有时间过滤、写侧没把旧行 `valid_end` 置位 —— "知识更新"类查询只能靠 embedding 撞运气。

### P4 写-归档 churn：每批 2 次 LLM，63% 产物被归档
- 证据：写入 10,333 / 存活 3,807；每批 extraction 一次 + dedup 一次（`l1-extractor.ts:511,534-536`）。
- 锚点：`src/core/record/l1-writer.ts:420-421,470`（update/merge 的旧行 archive，级联清向量与 FTS）。
- 影响：每次归档都是"旧行 + 新行"的全量成本；且归档栈（6,526 行）不参与检索，是纯审计库存。

### P5 L2 是"每天重写 14 篇文档"的 agentic 循环
- 证据：今日 99 runs × p50 74s；14 块 mtime 全在今日 13:18–14:43；p95 单次 18 分钟。
- 锚点：`src/core/scene/scene-extractor.ts:206-330`（带 read/write/edit 工具的 LLM）；`prompts/scene-extraction.ts:49-155`（"默认 UPDATE 不是 CREATE""禁止简单追加列表"）。
- 影响：成本最高、消费最少的一层。99 次/天换 14 行索引，且**每次重写都可能改写已经稳定的叙事**（回归风险）。

### P6 L3 分组键不可复用，巩固层近乎休眠
- 证据：全史 9 runs / 10 张卡；subject distinct 1,662，其中 1,587 单例、24 个 ≥3、仅 7 个"≥3 且跨度 ≥1 天"、6 个全 observed；最大桶是"反思结论"862 条（reflection 共用一个 subject）。
- 锚点：`consolidation-worker.ts:100-106`（`existingDurativeOf` 以 `metadata.subject` 字符串相等做幂等键）；`consolidation/grouping.ts`（`subjectStrategy: "llm"`）。
- 影响：**这不是调度问题**。想让 L3 产出，必须先把"同一个实体同一属性"的语义归一，否则 minCount=3 永远只有那一个 862 条的大桶够格。

### P7 没有内禀质量门
- 证据：golden 只覆盖召回选线（10 轮 37 行，#179）；提取质量、冲突处理、成本都无指标、无回归门；配置改动只能靠线上观察。
- 影响：本报告的所有判断都只能靠一次性取证，下次改动无法证明"没变坏"，与用户要求的"先做测试再下结论"不兼容。

## 4. 三条被证伪的假设（诚实记录）

| 假设 | 实测 | 结论 |
|---|---|---|
| L1 大量语义重复 | 330 条缓存向量两两余弦：**≥0.85 的 0 对**，NN p50 0.595 / p95 0.721；字面二元组 Jaccard ≥0.6 也是 0 | **证伪**：没有冗余，dedup 在干活；真问题是"薄"（信息密度） |
| L1 提取太多 | 今日 307 行，其中 34 行是从 10-14/10-17/10-22 的旧对话补抽的 backlog；3,807 条存活对应 13,780 轮 L0 ≈ 0.28 条/轮 | **部分证伪**：条数不算失控，"多"来自同一批长回答被拆碎（P1）与 AI 自述（P2） |
| L1 太慢（3.5 分钟/批） | 11-02 p50 10.9s；历史 208s 是 10 月下旬的记录 | **证伪**：延迟已不是问题；L2 的 18 分钟 p95 才是 |

> 注意 NN p50 0.595 的含义务：这个领域的记忆天然共享大量词汇（td-agemem、用户、召回），**0.6 已经是"不同事"的常态**。这解释了 #179 为什么必须用相对尺子而不是绝对阈值。

## 5. 同类系统对照（只取机制，不排名）

| 机制 | 出处 | 对本仓的直接含义 |
|---|---|---|
| 相似度只召回候选、LLM 才决议 | Mem0（arXiv:2504.19413，"Rather than using a separate classifier, we leverage the LLM's reasoning capabilities"；s=10 仅取候选） | 本仓 #179 的 floor/ruler 已同向；**写侧 dedup 也应改成"阈值只决定是否进 LLM"** |
| 补全与矛盾分开；加法式优先 | Mem0 2026 平台（"additive … without silently rewriting the old one"）；Zep 用 `invalid_at` 保留历史（arXiv:2501.13956） | 本仓 supersession 开、`valid_end` 空 → 语义上是"改写但没留痕"，应二选一落地 |
| 双时间轴 | Zep：`t_valid/t_invalid/t'_created/t'_expired` | 本仓 `valid_start/valid_end` 列已有，缺写侧置位与读侧过滤 |
| provenance 回指 episode | Graphiti"Everything traces back to episodes"；A-MEM 演化因缺此层丢原始表述（arXiv:2502.12110） | 本仓 `derived_from` 23,551 条已具备，L3/L2 该消费它 |
| 重要性写入时打分 | Generative Agents（arXiv:2304.03442，1–10 分原文） | 本仓 `priority`/`importance` 已有，但**未进召回排序**（#179 只用相似度+层级） |
| 分级摘要要有可复算触发 | GenAgents：重要性累计 >150 触发反思 | 本仓 L2 无触发门（P5）、L3 有门但键不可用（P6） |
| 抽取挪出热路径 | Letta Dreaming（arXiv:2504.13171，test-time compute 降约 5×） | 本仓 L1 已异步；L2 应该在夜间跑 |
| 淘汰用热度公式 | MemoryOS（arXiv:2506.06326，Heat=α·N_visit+β·L_interaction+γ·exp(−Δt/μ)，μ=1e7s，τ=5） | 本仓 forgetting 用固定 `lowThreshold=0.12` + 30 天，可换热度 |
| 粒度是显式旋钮 | LangMem（"over-extracts → reduced precision；under-extracts → low recall"） | 本仓 300 字拆分线写死在 prompt 里，应提升为配置 |
| 多类型分库收益来自"先产 topic + 路由" | MIRIX（arXiv:2507.07957，六类 + Meta Manager） | 本仓已有 7 个 type，但没有路由；分表不解决召回 |

**评测口径警告**：同 LoCoMo，Mem0 报 F1 38.72、A-MEM 原表报 F1 3.45、MIRIX 报 85.4%（聚合口径未说明）。跨论文数字禁止横比；本仓若要自证，应按"抽取准确率（人工标注子集）/ 冲突处理正确率（构造矛盾对）/ 检索命中率（top-k）"三档分报。

## 6. 优化方案（三档，按"证据强度 × 成本"排序）

### A 档：一周内可上线（配置/小改，不动检索行为）

**A1 · 给 L2 装触发门（最高性价比）**
- 改法：`pipeline-factory.ts:1107` 前加门：新增未处理 L1 ≥ 30 条 **或** 距上次 L2 ≥ 6 小时才跑；默认把 L2 排到夜间窗口。保留 `triggerEveryN=50` 作为对话条数上限。
- 预期：99 runs/天 → ≤25，LLM 墙钟 2.0h → ≤0.5h。
- 判据：L2 runs/天；14 行索引变化率；golden 召回读数不降。
- 风险：新记忆的场景覆盖变慢（最长 6h），对"当天就要用"的场景不利 → 可给手动触发口。

**A2 · 决定 facts 通道的生死（消除半成品成本）**
- 现状：抽取侧开（420 行有 `metadata.facts`），写侧 `factKey/factRows` 全关，`factTriples` 0 条 —— 付费无消费者。
- 二选一：① 接读侧：`write.factKey.enabled=true, mode="channel"`，只对 `work_fact/episodic`，召回侧仅扩召回不裁决（`injection-wiring` 已有接缝）；② 关抽取侧：`extraction.facts.enabled=false`，省输出 token。
- 建议：先做 ②（立刻省钱），① 作为 B 档实验。
- 判据：#179 golden 的 highRecall/precision 不降；每批输出 token 下降。

**A3 · L1 提取两处校准**
- 改法：① 拆分红线 300 → 600 字符，并把"一条只记一件事"改成"一条只记一个可验证断言"；② AI 自述默认不进 `persona/instruction`（`AGENT_ACT_BLOCK` 默认关闭），仅当用户明确要求"记住你（AI）的行为"时开启。
- 预期：行长 p50 170 → 250–350；selfNarration 32.1% → ≤5%。
- 判据：随机 100 条人工标注（主语是否正确 / 是否单一断言）；注入精度代理。

### B 档：2–4 周（结构改，需离线复放验证）

**B1 · L3 换分组键**：`metadata.subject` 字符串 → `(entity, attribute)` 归一（实体从 `work_object`/`coreRefs` 抽，属性从谓词抽）+ embedding 聚类（cos ≥0.82）兜底；幂等键改属性键，而不是整句。
- 判据：每周 ≥5 张卡被写、≥3 张 `recall_count>0`（当前 10 张/全史）。

**B2 · 读取侧双时态**：注入前过滤 `valid_end` 非空行；写侧 supersession 真正置 `valid_end`。当前 `supersession.enabled=true` 但没有落位与过滤，等于"开着但无效果"。
- 判据：构造 10 组"旧值→新值"查询，注入不含旧值。

**B3 · L2 形态改造**：整篇重写 → 结构化卡（`summary/claims/heat`）+ append-only 事件流 + 定期 compact；单块上限 4KB；`heat` 驱动裁剪（Mem0/Zep 都不做整篇重写）。
- 判据：单次 L2 输出 token 下降 ≥50%；14 行索引覆盖不降。

**B4 · dedup 前置门槛**：先 embedding 筛（≥0.90 才进 LLM 判重），把每批 2 次 LLM 降到 1.x。
- 判据：LLM 调用/批；人工抽验 50 对判重正确率。

### C 档：实验（需先建指标）

- **C1 离线复放提取 A/B**：用已有 13,780 轮 L0 抽 200 批，跑旧/新 prompt，比行长、条数、主语、facts 覆盖率；无需新数据。
- **C2 冲突对测试**：现有 `conflict` 边 91 条太少，构造 50 组矛盾对（同一属性不同值），测 supersession 正确率。
- **C3 遗忘改热度**：MemoryOS 公式替换 `lowThreshold`，用 `recall_count/last_recalled_at` 已有字段。

### 明确不建议

- **引入图数据库 / 实体图谱**：本仓 `conflict` 边 91、实体表空转，图上没有可查的东西；先补键（B1）再谈图。
- **RL 训练记忆策略（Memory-R1 类）**：需要 QA 标注集，本仓没有；成本远超收益。
- **全量重抽历史 L1**：13,780 轮重跑一遍 L1 ≈ 2,700 批，按当前 p50 10.9s 约 8 小时 LLM，但会重建全部 3,807 行并让所有 journal 历史对比失效。

## 7. 验证方案（与用户"先做测试再下结论"对齐）

1. **内禀指标**（新增 `docs/ops/` 指标表）：`selfNarrationRate`、`atomicityRate`（人工 100 条）、`semanticDupRate@0.85`、`avgLen`、`factsCoverage`、`llmCallsPerBatch`、`churnRatio`（archive/新增）、`recallPrecisionProxy`。
2. **离线复放器**：`MemoryCore/.scratch/` 已有 `selection-offline-replay.ts`（召回侧）先例；提取侧新建同构脚本，输入 L0 批次、输出结构化对比。
3. **灰度顺序**：`shadow`（新参数只写 journal，不改注入）→ 单 group `enforce` → 全量；每步保留回滚键（`mode: off` 逐位回到今天行为）。
4. **门**：`npm test`（当前 350 文件 / 3,466 用例）+ `typecheck:gate`（`Δ=0`，基线 202 errors/30 files）。

## 8. 待拍板项

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | L2 是否装触发门 | 装 / 不装 | 装（成本 4×↓，代价是新场景覆盖延迟 ≤6h） |
| D2 | facts 通道 | 关抽取 / 接读侧 / 维持 | 先关抽取，接读侧作为 B 档实验 |
| D3 | AI 自述是否入记忆 | 默认关 / 维持开 | 默认关（32.1% 与用户事实竞争 600 字符预算） |
| D4 | L1 拆分红线 | 300 / 600 / 配置化 | 600 + 配置化 |
| D5 | L3 是否重做分组键 | 做 / 暂缓 | 做（否则巩固层永远 10 张卡） |
| D6 | 是否全量重抽 | 否 / 是 | 否 |

## 9. 诚实边界

- 本报告的数字来自**单机单实例、单一 agent 分组**的生产库；跨团队/跨用户的泛化未验证。
- 语义冗余结论基于 **330 条已缓存向量**（非随机抽样，偏向被 #179 与 golden 触碰过的行），95% 置信区间未算；若需定论应按 type 分层随机抽 500 条重测。
- L2 的 token 成本是估算（日志不落 prompt），实际以 LLM 侧账单为准。
- `recall_count`/`last_recalled_at` 只反映本实例的召回，跨实例共享档案时会计漏。
- 所有权重与阈值（cos ≥0.82 聚类、≥0.90 dedup 前置、30 条/6h 触发门）都是**初值**，必须按 §7 的离线复放校准后才能上线。
