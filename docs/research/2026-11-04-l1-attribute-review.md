# L1 属性全景 review：写点 / 生命周期生效面 / 面板可见可操作面

- 日期：2026-11-04
- 范围：L1 的 14 个属性（10 个 soul/属性字段 + type/priority/scene_name/task_id）与两个时钟（updated_time/created_time）
- 判据（用户两原则）：**① 面板 UI 可见；② 在记忆生命周期中发挥作用，不能只用来看**
- 方法：3 个只读审查员（生命周期 / 面板 / 写点）+ Lead 抽验源码 + Lead 生产库只读探针（`D:/TDB/data/vectors.db` readOnly，2026-11-04 17:2x）
- 生产配置以 `MemoryCore/tdai-gateway.yaml` 为准（`config-override.json` 不在仓内，见 §6）

## 1. 判定口径

- **生效**：存在影响召回 / 注入 / 归档 / 反思 / 巩固 / 隔离分支的决策读点，且生产配置开启。
- **局部生效**：只在显式传参或某个写侧环节生效（如 task_id 仅 filter 声明时隔离）。
- **只写不读**：无任何生命周期决策读点（展示 / API 出参不算）。
- **通道关断**：代码通道存在、生产权重为 0（有 A/B 依据，属现状而非缺陷）。

## 2. 属性矩阵（生产口径）

| 属性 | 写入点（path:line） | 生命周期决策读点（path:line） | 生产开关 | 面板可见 / 可操作 | 判定 |
|---|---|---|---|---|---|
| importance 1-10 | `core/record/l1-extractor.ts:457,1128`；`l1-writer.ts:392`；`gateway/v2-router.ts:1581-1588` | `core/tools/recall-signals.ts:185-189` 乘子；`core/hooks/auto-recall.ts:4159-4168` rrfScore × mult（≤4 行乘 0.7，真实降权），同分由 `:4496` mult 兜底；`memory-search.ts:1125-1127` 工具路恒 0；遗忘面零读 | yaml:181-183 enabled=true/penalty=0.3 | 仅弹窗一行（`AttributesSection.tsx:296`）；可调级 `:434-478`；无徽章/筛选 | **生效（极窄）** |
| significance 0-1 | `l1-extractor.ts:453,1124`；`l1-writer.ts:387`；`consolidation/summarizer.ts:120-134` | 遗忘乘子 `forgetting/scorer.ts:69-82,141-149`；反思触发 `reflection.ts:328-335`；巩固聚合 `consolidation-worker.ts:324`；画像门 `persona-evolution.ts:42` | 生产 rRef=2（yaml:596）；sigWeight=0（yaml:204） | 卡片仪表 `SoulSection.tsx:116-126`；图节点大小 `MemoryGraphView.tsx:90-98`；不可编辑 | **生效** |
| valence -1..1 | `l1-extractor.ts:451-453,1122`；`l1-writer.ts:385` | 记忆选择链无（`emotionSalienceWeight`/`moodBoost` 生产 0，yaml:207/246）；**人格链生效**：`core/hooks/mood-line.ts:43-58` + `auto-recall.ts:2537-2548` 注入基调；`soul-state-machine` 消费 | moodLine enabled=true（yaml:439-440） | 双色条 `SoulSection.tsx:97-104`；图色相；不可编辑 | **局部生效（人格/表达链）** |
| arousal 0-1 | `l1-extractor.ts:452,1123`；`l1-writer.ts:386` | 遗忘衰减 `scorer.ts:97-104,141-142` effectiveLambda（λ 最多降 27%）；排序通道关断 | arousalRetention=0.3（yaml:592） | 仪表 `SoulSection.tsx:108-115`；≥0.7 徽章 `attribute-badges.ts:45` | **生效（弱）** |
| certainty | `l1-extractor.ts:449,1118`（非 inferred 一律 observed）；`l1-writer.ts:383` | 6 处硬门：EVOLVE 边仅 observed `l1-extractor.ts:1416`；失效旧值 `:1433`；`grouping.ts:31-32`；`forgetting-worker.ts:118` inferred 永不自动归档；重巩固白名单 `memory-search.ts:199-202`；bumpRecallCount 仅 observed `auto-recall.ts:5035-5036` | inferredPenalty=0.1（yaml:206；已降为平局旗标） | chip `SoulSection.tsx:74-81`（实见/推断）；不可编辑 | **生效（最广）** |
| sensitivity | `l1-extractor.ts:455`；`l1-writer.ts:389,263-272` 只升不降；`sqlite.ts:1374-1380` 单向棘轮 | 注入门 `core/recall/sensitivity-policy.ts:124-134,209-239` → `auto-recall.ts:4937-4980`、`memory-search.ts:1917-1934` | 提取门开（yaml:52-53 `extractionEnabled: true`）；注入门恒开 | chip `SoulSection.tsx:84-95`（**正文是字面量 x**）；仅「解除→none」`AttributesSection.tsx:481-519` | **生效（单点）** |
| occurred_at | `l1-extractor.ts:443,1114`；`l1-writer.ts:380,415` | 时间窗 `memory-search.ts:1575`；版本新序 `evolution-worker.ts:203-207`；反思增量 `reflection.ts:317`；衰减**不用**它（`scorer.ts:112-139` 用 created_time） | timeBoost=0（yaml:202） | chip `SoulSection.tsx:60-64`；日分组 `BlockDetail.tsx:365-378`；不可编辑 | **生效（窗口/版本序）** |
| valid_start | `l1-extractor.ts:447`（仅 durative）；`l1-writer.ts:509,673` | future 硬丢 `validity-policy.ts:135-160`；`filter-invalidated.ts:22-32` | validity mode=soft（yaml:244-246） | 有效期 chip `SoulSection.tsx:65-72`；不可编辑 | **生效** |
| valid_end | 提取侧永不写（`l1-extractor.ts:448`）；`l1-writer.ts:501-527,670-700`；`v2-router.ts:1783` | expired 降权 0.5 沉底 `validity-policy.ts:249-288`；`evolution-worker.ts:207`；`consolidation-worker.ts:266-269` | soft + excludeInvalidated | chip + 失效行样式；仅 invalidate(now)/restore `AttributesSection.tsx:521-565` | **生效** |
| source_message_ids | `l1-extractor.ts:434,1085`；`l1-writer.ts:239-252,399`；`sqlite.ts:1383` COALESCE | **无决策读**；仅出参/溯源（`atomic-query-fields.ts:72`、`chat-memory.ts:3090`） | — | 弹窗「N 条」+ 原话抽屉 `AttributesSection.tsx:398-433` | **只写不读（溯源定位）**；字段 2026-11-04 才落库，历史行全空（见 §2.1） |
| task_id | `l1-extractor.ts:643,570`；`l1-writer.ts:372`；`sqlite.ts:1352` | 隔离 `isolation.ts:144,168`（仅调用方显式传 taskId；召回三入口命中 0）；写侧去重 `l1-extractor.ts:570` | 可选作用域 | 仅弹窗原始键 `AttributesSection.tsx:282`（`attr-labels.ts` 未登记） | **写了但生产零命中**（4331/4331 全空，见 §2.1） |
| type | `l1-extractor.ts:432,1072`；`l1-writer.ts:361` | work_fact 分层 `memory-search.ts:1712`、`auto-recall.ts:4498-4503`；type 硬过滤；巩固/反思排除 | 恒开 | 弹窗展示；列表类型过滤**已实现未接线** | **生效** |
| priority | `l1-extractor.ts:433,1084`；`/atomic/update` | 遗忘乘子 `scorer.ts:62-67`；priority=-1 永不归档 `:154-155,173`；两路平局首键 | 恒开 | 弹窗展示；不可编辑 | **生效** |
| scene_name | `l1-extractor.ts:441`；`consolidation-worker.ts:300` | 巩固自排除 `consolidation-worker.ts:98-101,157`；L2 结论命中 `recall-layered.ts:275-276`；sceneBoost 0 | sceneBoost=0（yaml:211） | 弹窗展示 | **局部生效** |
| updated_time | upsert；`bumpRecallCount` 显式 `touchUpdatedTime:false`（`auto-recall.ts:5035-5036`） | 反思增量窗口 `reflection.ts:317-327` | 恒开 | 弹窗 `updated_at` | **生效（单点）** |
| created_time | 建行时刻 | 遗忘年龄唯一权威时钟 `scorer.ts:112-139` | 恒开 | 弹窗 | **生效** |

## 2.1 生产库现值（只读探针）

数据源：`D:/TDB/data/vectors.db`，`new DatabaseSync(path, { readOnly: true })`，2026-11-04 17:2x 采样，`l1_records` 共 **4331 行**（type：episodic 2341 / work_fact 1124 / instruction 539 / persona 310 / work_method 12 / work_task 5）。

| 属性 | 生产分布 | 对「生命周期生效」的含义 |
|---|---|---|
| importance | 3334 有值 / 997 NULL；**≤4 仅 70 行（1.6%）** | 0.3 降权真实作用于 hook 路 rrfScore，但命中面只有 1.6% 行；工具路恒 0 |
| significance | 3466 有值 / 865 NULL；0.6-0.8 1665、≥0.8 1587、<0.4 仅 2 | 遗忘/反思/巩固的主区分量，真实发力 |
| valence | 正 2906 / 负 271 / 0 245 / NULL 909 | 人格基调可算；记忆选择链不读 |
| arousal | 0 40 / 0-0.7 3309 / **≥0.7 仅 73（1.7%）** / NULL 909 | 闪光灯调制命中面极小 |
| certainty | inferred 159（3.7%）/ observed 其余 | 6 处硬门实际约束面 3.7% |
| sensitivity | 非 none **仅 5 行**（finance 2 / relationship 3） | 注入门真实拦截面 5 行 |
| valid_start / valid_end | 1027 非空（23.7%）/ 136 非空（3.1%） | 双时态与失效面真实存在但稀疏 |
| occurred_at | 空 306（7.1%） | 较历史 85.6% 空已大幅改善 |
| source_message_ids | 全库 94/4331；**今日新增 106 行中 94 有值（88.7%）**；work_fact 10/10 空 | 字段今日才落库，历史行空属时点问题；派生事实无原话属合理 |
| task_id | **4331/4331 全空** | 生产从未使用任务轴，「局部生效」实际零命中 |

由此修正三条判定：importance 的「生效（极窄）」在生产数据上接近零影响面；task_id 从「局部生效」降为「写了但生产零命中」；source_message_ids 的溯源能力只对今日之后的新行有效，且 work_fact 类永远无原话（面板抽屉应显示「该类型无原话」而非空白）。

## 3. 两个原则下的结论

**双原则满足（可见 + 生命周期决策）**：significance、certainty、sensitivity、valid_start、valid_end、occurred_at、type、priority、created_time、updated_time。

结合 §2.1 的生产分布，真正同时满足两原则且**有实际约束力**的是 significance（80% 行有值、驱动遗忘/反思/巩固）、certainty（3.7% 行触发 6 处硬门）、valid_start/valid_end（23.7%/3.1% 行进入双时态门）、occurred_at（92.9% 有值）、priority、type；sensitivity 通道正确但生产仅 5 行命中。

**面板可见、生命周期弱或偏人格链**：
- `importance`：面板可调，但只在 hook 路对 **≤4 分** 的行乘 0.7（真实降权，非仅平局）、遗忘面零读、工具路恒 0；生产 ≤4 仅 70 行（1.6%），实际影响面接近零。
- `arousal`：只把遗忘 λ 最多降 27%，无召回优先；面板有三个展示点。
- `valence`：记忆选择链零行为；只在 moodLine / soul-state 的人格表达链生效（生产 enabled）。
- `source_message_ids`：无决策读，属溯源字段（ADR-0025 D1 设计使然）。面板可看原话，但**不能跳回 L0**。

**生命周期生效、面板偏弱**：significance / arousal / certainty / occurred_at 仅展示（可接受：提取产物，无人工改语义）；valid_start 不可编辑；importance 只在弹窗。

## 4. 缺口清单（按优先级）

### P0 · 一致性与事实缺陷（建议立即修）

1. **敏感度 chip 只渲染字面量 `x`** — `SoulSection.tsx:93`（label 在 `:84` 判定后被丢弃，CSS 无 `::after`）。影响：列表无法区分 health/finance/relationship，注入门的判据在浏览态不可读。
2. **复制 JSON 缺 `sensitivity`** — `AttributesSection.tsx:327-354` 无该键，而 `:294` 展示、`:323-325` 注释要求保留原始字段名。影响：机读出口与展示/注释不一致，下游拿不到降敏判据。
3. **C 项译名未推广到注入链路** — `auto-recall.ts:5198` 把 significance 渲染成 `重要度 0.72`，与 importance(1-10) 的显示名撞车；面板已改「显著性」，注入文本未改。影响：LLM 侧仍看到两个「重要度」，且 0-1 与 1-10 混淆。
4. **soft 效期下过期行无「已失效」标注** — `auto-recall.ts:5194-5213` 只标「自 X 起」，过期行仍可进注入；而面板徽章 tooltip 声称「两路召回均排除」（`utils/attribute-badges.ts:75-89`），与 `validity-policy.ts:104-107,147-159` 的 soft 降权保留（×0.5 沉底）及生产 `validity.mode: soft` 相矛盾。影响：LLM 把过期事实当现行；面板说明失真。

### P1 · 治理与可用性（建议本轮修）

5. **importance 生命周期几乎不发力** — 遗忘面零读（`scorer.ts:141-149`）；hook 路只对 ≤4 分行乘 0.7（`auto-recall.ts:4166`），工具路恒 0（`memory-search.ts:1125-1127`）；生产 ≤4 仅 70/4331 行（1.6%）。面板可调级但调了几乎无感（违反原则 2）。
6. **敏感度只能降不能升** — UI 唯一写点 `AttributesSection.tsx:246` 固定 `'none'`；BFF `chat-memory.ts:2747` 已支持四值。无法人工标 health/finance/relationship。
7. **无属性筛选/排序** — 只时间范围 `BlockDetail.tsx:875-895`，BFF 只透传 time_start/end（`chat-memory.ts:1255-1262`）。无法筛「带敏感标记」「importance≤4」「已失效」。
8. **importance / 失效表单无 owner 门** — `AttributesSection.tsx:434-478`、`:520-565` 无 canEdit 判定（sensitivity 有 `:208-216`）。非 owner 看到必败入口，点了落 BFF 403（`chat-memory.ts:2698-2699`）。
9. **task_id 展示弱且生产零使用** — 仅弹窗原始键 `AttributesSection.tsx:282`，`attr-labels.ts:14-25` 未登记；无任务视图/筛选；生产 4331 行全空（§2.1），当前等于死字段。
10. **邻接记忆属性被 UI 丢弃** — BFF 已返回 occurred_at/certainty/valence/significance（`chat-memory.ts:571-574`），`RelatedSection.tsx:36-38,129-145` 不渲染。

### P2 · 设计增强（需拍板，不建议本轮直接改）

11. **significance 与 importance 双轨不通**：遗忘读前者、注入降权读后者，互不派生；同一条可 significance=1 而 importance=NULL。
12. **valence 在记忆选择链零行为**：`emotionSalienceWeight`/`moodBoost` 生产 0；只有人格链生效。若要「情绪影响记忆」，须走预注册 A/B（yaml:246 明写「未过 A/B 不得置正」）。
13. **arousal 只调衰减速率**，无召回优先；「闪光灯记忆」仅换来 ≤27% 衰减减速。
14. **valid_* 只有二值软门**：`fusion.ts:43` validity 权重 0 → 刚过期与一年前过期打分等价（都只 ×0.5 沉底）。
15. **significance 无回流**：命中只 bump recall_count（`auto-recall.ts:5027-5041`），价值一次定终身。
16. **updated_time 被排除在强化信号外**（`touchUpdatedTime:false`）→ 无「久未触达淡出」。
17. **source_message_ids 无决策读**：按 ADR-0025 D1 属溯源字段，建议保留只展示，但补「跳回 L0 时间轴」闭环（面板 G11）；且生产仅今日新行有值（94/106），work_fact 永远无原话，面板需区分「无原话（派生事实）」与「未采集」。
18. **选线/注入层对属性零读取**（`selection/injection-stage.ts:103-109` 层名取自渲染文本前缀）→ 目前无法按 importance/significance 控注入预算。
19. **task_id 召回/生命周期零分桶**：召回三入口 0 命中；`consolidation-worker.ts:345,353` 只写卡不分桶。多任务并行会串味。
20. **通道关断属生产调优现状**：sigWeight/sceneBoost/timeBoost/emotionSalience/moodBoost 均 0，有 A/B 依据（yaml:202-211,246；yaml:9 声明 override 优先）。建议记录，不擅自重开。

## 5. 推荐动作

**若只做一轮**：P0 四条 + P1 第 5/6/8 条（importance 生效面、敏感度升档、owner 门）。这五条都能用现有端点/字段完成，不改写检索架构，风险最低且直接改善两个原则。

**若做完整闭环**：加 P1 第 7/9/10 条（属性筛选、task_id 视图、邻接属性渲染）与 P2 第 17 条（溯源跳 L0）——面板侧可一次做完；P2 第 11-16、18-19 条涉及排序/遗忘/巩固语义，须先定 A/B 判据再动。

## 6. 诚实边界

- **未验证**：结论来自静态源码 + grep + 生产库只读分布（§2.1），**未跑运行时行为/召回日志采样**；未启动面板做浏览器取证；「生产生效」是按 yaml 键与代码分支推导，分布只证明「有多少行可能受影响」，不证明该行实际被命中。
- **未覆盖**：`config-override.json` 实际值（不在仓内；yaml:9 声明其优先）；`/v3/atomic/query` 内核排序能力（只能证 UI/BFF 无控件）；TCVDB/native-hybrid 路；MemoryKnowledge 全量；面板 dist 构建产物。
- **依赖假设**：yaml 即生产配置载体（override 未覆盖 memory.* 等键）；`SOUL_SELECT_FRAGMENT`（`soul-columns.ts:27`）拼进 FTS SELECT；`selection/**` 零属性读取是设计现状而非漏读；只读探针与 tdai-core 共享同一 `vectors.db` 文件、无写入，采样时点 17:2x。
- **已知不修（本轮只 review）**：上述 P0-P2 未改一行代码；`memory-search.ts:199-202` 陈旧注释（l1_fts 已含 certainty）、`reflection.ts:2` 命名漂移、persona 路 certainty 双源（`pipeline-factory.ts:1453-1457`）只记录。
