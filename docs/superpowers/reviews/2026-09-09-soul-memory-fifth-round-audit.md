# 灵魂记忆系统 · 第五轮对抗性审查报告（六路合并终局）

> 日期：2026-09-09
> 对象：`td-agemem/docs/superpowers/specs/2026-09-08-agent-soul-memory-spec.md`（v1.0-draft）及 G–M 七子设计 + P0–P5 落地；副线 wiki 召回精度设计。
> 基线：git HEAD `230b84c`；生产库 `D:/tdai-data/vectors.db`；生产网关（本轮 10:18:54 重启）。
> 方法：六路并行对抗审查（G 记忆图 / H·I·reconsolidation·调度 / L1 写入·提取·J 重构回忆·门槛 / K·L·M·注入·配置链 / wiki-recall / 生产实证）+ 队长生产只读探针交叉核伪。全程只读纪律（未写库、未改代码；唯一工作区变更为用户要求的 `tdai-gateway.yaml` 嵌入配置切换）。
> 继承：第二轮 `2026-09-08-soul-memory-adversarial-audit.md`、第三轮 `2026-09-09-soul-memory-third-round-audit.md`、第四轮 `2026-09-09-soul-memory-fourth-round-audit.md`。前三轮的"✅ 已修"在本轮全部作为**待核实对象**而非事实复述。

---

## 0. 一句话总结论

**代码骨架与前三轮的修复声称基本属实（无纸面造假），但"设计闭环"此前只存在于 mock 环境——生产上向量层死亡（嵌入套餐额度耗尽）使记忆图/巩固触发/门槛/邻居召回全线静默归零，而系统每一层都选择了优雅降级、没有一层喊疼。** 本轮已修复嵌入配置并验证恢复（向量 +3、首批 similar 边落库、reconsolidation 首次生产留痕），但暴露 16+ 个 high+ 问题待按序修复（见 §5 优先级）。

---

## 1. 核实为真的声称清单（六路交叉复核 + 队长逐项抽查）

### 1.1 前三轮修复声称逐项属实（抽样全对，无纸面造假）

| 声称 | 证据（文件:行） |
|---|---|
| F2 guard 白名单/2000字/总开关/400 拒绝 | `core/core-memory/guard.ts:38-58`、`gateway/v2-router.ts:1389-1394` |
| F3 soul 覆盖 100%（生产 182/182→现 219/219） | 生产探针 `soul_fields` 查询 |
| F4 幂等（metadata.subject 复用 id+version 递增）+ 四维修租户 | `consolidation-worker.ts:43-49,54,71,87-100`、验证脚本 `audit-fix-verify-f4.ts:57-62` |
| F5 restoreL1 26列↔26占位符修复 + FTS 重建 + pruneOrphanLinks/deleteL1 级联 | `sqlite.ts:1666-1700`（逐个数过）、`:1605-1619`、`:2014-2015/2054-2055` |
| F6 价值锚单源：表空才灌 + ON CONFLICT 收敛 + 30s TTL→fallback + 两 yaml 6 值一致 + 生产 6 行 | `server.ts:1906-1925`、`sqlite.ts:1744-1745`、`injector:206-235`、生产探针 |
| A1 config-first 复活（8 段全进 parseConfig，无新丢段） | `config.ts:626-681,785-788`、`tdai-gateway.yaml:71-100` |
| A 项 core_memory 稳定块注入（位置/TTL/宁缺毋滥/三槽） | `tdai-profile-memory-injector.ts:132-152,212-213` |
| B 项归档恢复 API（list/restore+400+审计）+ 真机 200/400 | `V3_ALLOWED_SUBPATHS`、真机实测 |
| C 项 updateL1Metadata 仅合并不重写 + fire-and-forget + 异常不外泄 | `sqlite.ts:2086-2101`、`memory-search.ts:416-429` |
| D 时间窗解析（跨年/宁缺毋滥）| `content-time-window.ts` 8 断言 |
| G 链路：l1_links DDL/幂等建边/conflict 边/observed 门/级联删边/part_of 同源/BFF 鉴权/UI 枚举对齐 | `sqlite.ts:685-695,1536-1550`、`l1-extractor.ts:786-817`、`consolidation-worker.ts:131-136`、`chat-memory.ts:1713-1723` |
| 81d4b30 CRITICAL 同步修复无残留 | `l1-extractor.ts:551/559` 全仓唯一调用点 |
| P0 三条写入路径全汇入 writeMemory + 六字段兜底 | `l1-writer.ts:276-302` |
| R1/R2 sqlite/tcvdb 八列读回 | `stmtGetMeta`、`L1_OUTPUT_FIELDS` |
| Task1/Task2 向量腿绝对门槛 | `searchHybrid`、`memory-search.ts:304` |
| switch-D revert 干净（-211 行含测试，零残留） | wiki 线 A7 |
| sort-before-slice / spaceId 租户修复（带回归测试） | wiki 线 A5/A6 |
| reconsolidation 单一咽喉覆盖完整 | Proxy L1 自动注入器已下线（`injection/index.ts:387-389`），工具/bridge/注入器全部汇入 `/v3/atomic/search → executeMemorySearch`（修正队长 v1.0 误判） |
| 23+20 个引用 commit 全部存在且 message 与 diff 相符 | 六路 git show 逐一核对 |

### 1.2 本轮新增的生产实证（修复验证）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 向量覆盖 | l1_vec_rowids 104 vs l1_records 203；按天 09-07 57/57 → 09-08 31/77 → 09-09 **0/29** | 换嵌入配置（ark coding/v3，dims=2048 实测）重启后 **+3 恢复增长** |
| l1_links | **0 行**（修复 commit 230b84c 后重启再写 16+ 条仍零边） | **2 条**（10:35:59 首条 similar 边） |
| reconsolidation 痕迹 | 0 条 recall_count | 3 条 observed 记忆 `recall_count:1`（合并语义正确——与 activity_start_time 共存） |
| /v3/atomic/search | — | HTTP 200 功能正常 |

---

## 2. 事件复盘：向量层死亡三幕剧（本轮最重要的系统性发现）

**第一幕 · 悄悄断粮**（09-08 起，根因：嵌入套餐额度耗尽，用户确认）。
每条新记忆写入时 embed 失败，代码走 best-effort 降级：只写元数据+FTS，跳过向量（`l1-writer.ts:399-406`，`sqlite.ts:1423` skipVec）。**库还在长，记忆没有"语义指纹"。**

**第二幕 · 连锁瘫痪（全部静默）**：
- **记忆图零建边**：230b84c "零关联双根因修复" 的 E2E 用 mock embedding 跑通（`audit-fix-verify-edges.ts:20-35` hashEmbed+mock LLM），生产重启后写入 16+ 条**依然 0 边**。根因 `l1-dedup.ts:90`：`countL1()` 数的是 `l1_records` **元数据行**而非向量行——元数据活着→代码以为向量可用→坚持 Tier1 向量召回→**永不降级到还活着的 FTS 通道**→候选恒空→`attachTopCandidates`（:133）之前的早退（:126-129）→建边分支永不可达。
- **绝对门槛旁路**：`score>=0.3` 只过滤向量腿（`memory-search.ts:304`）；FTS-only 降级时零门槛。本轮对话自动注入的 wiki 片段（SCM 发货清单 score=1.00）与审查主题零相关——"排名即注入"的现场活体演示，整场审查出现 5 次以上。
- **J 时间窗/情感标注/inferred 判定失效**：FTS 源头无 soul 列（W1，见 §3）。

**第三幕 · 修复与复活**：见 §1.2。**教训（建议写进团队纪律）：best-effort 降级本身没错，错在降级不可见。健康信号（向量覆盖率/降级计数/注入块降级标注）必须是一等公民，否则"优雅降级"就是"优雅地烂掉"。**

---

## 3. 问题清单（六路合并，severity 分级，全带文件:行证据）

### 3.1 Blocker/High（数据正确性 + 信任边界）

| # | 问题 | 代码事实 | 影响 |
|---|---|---|---|
| **W1** | **FTS 层无 soul 列（虚表 17 列/SELECT/接口三层全缺）** | `stmtL1FtsInsert`（sqlite.ts:1188-1193）、`stmtL1FtsSearch`（:1197-1207）、`FtsSearchResult`（:325-344）均无 occurred_at/certainty/valence/arousal/significance/source | f39191c"FTS 路径补 soul 透传"只改映射层——**水管修了，水厂没水**。FTS 命中的记忆：J 时间窗恒不过滤（inTimeWindow(undefined)=true）、回忆片段无情感标注、auto-recall 无 soul 尾注 |
| **E1** | **atomic/update 直写刷掉 soul 8 列** | `handleAtomicUpdate`（v2-router.ts:1086-1104）构造 updated 漏拷 soul 字段，upsert `excluded.*` 写 NULL | 任何一次记忆编辑=时间锚消失（**遗忘引擎 age 恒 0 永不归档**，复刻 F3 修过的老病灶）+情感清零+certainty 退化 observed（推断冒充事实，违 §5.4） |
| **E2** | **inferred 锁被 FTS 绕过** | `memory-search.ts:420-421` `certainty==="inferred"→continue`；FTS 行 certainty 恒 undefined→门放行 | inferred 经 FTS 命中也吃 recall_count 抗遗忘 boost——"越回忆越信自己的编造"防线在 FTS 路径失效 |
| **H-B1** | **recall_count 恒 1，抗遗忘封顶机制生产不可达** | `memory-search.ts:422-423` 读 `r.metadata`，但 `MemorySearchResultItem`（:23-46）无 metadata 字段，三条召回映射（:175-197/:229-248/:270-292）均不带 → prevCount 恒 0 | `min(c,5)*0.02` 恒 0.02，"+2% 封顶 +10%"（verify-lifecycle 的 +0.06/+0.10 断言是手工 fixture 喂 scoreFor，绕过 search 侧读不到 metadata 的事实）生产不可达 |
| **H-B3** | **H 侧 inferred 门失守：inferred 可被熬成 observed 持续态** | `grouping.ts:25-27` 定义 `isObservable` 但 `groupBySubject`（:65-93）**从不调用**；`sourceMemories`（consolidation-worker.ts:37-40）只排 work_fact，不排 inferred；产物 `durativeToMemoryRecord` 恒 `certainty:"observed"`（summarizer.ts:16） | inferred 记忆凑满同前缀 3 条+跨期即可洗成 observed 持续态、挂 part_of 证据边、进 M 画像（画像侧拦 metadata.certainty 而产物已标 observed）——**"推断不冒充"红线在 H 侧失守** |
| **H-B2** | **巩固分组零租户隔离，且配置层无法配置** | server.ts:1894-1899 调 startLifecycleScheduler 不传 filter；`MemoryLifecycleConfig`（config.ts:134-156）**无 filter 字段**；consolidation-worker.ts:121 自注"跨租户组取首条归属" | 跨租户同前缀 subject 串组：B 租户内容进 A 租户的 LLM 摘要 prompt + evidence_ids/part_of 边。生产单租户掩盖；F4 修的是"产出归属"没修"输入隔离" |
| **G1** | **countL1 数错行 → FTS 降级通道不可达** | `l1-dedup.ts:90` 数元数据行；向量行在 sqlite.ts:1423 静默 skip | 最高频故障模式（向量死+元数据活）下代码以为向量可用，永不走 FTS Tier → dedup 决策/建边全线静默死（§2 第二幕的机制根源） |
| **K1+K2** | **core 投毒链**：core 两表 DDL 无租户列（生产 DDL 实查：`slot PRIMARY KEY` 无 team/user/agent）+ `server.apiKey` 未配=verifyAuth 直接 ok（server.ts:1120）+ `escapeXmlTags` 白名单（sanitize.ts:288-294）不含 core_memory/identity/strict_rule 边界标签 + v3 严格隔离默认 OFF + /v2 孪生路径 | 本机任意进程可改 identity/strict_rule 槽→毒化内容越块逃逸进 system 区→全 agent 共享身份层。**F2 守住了写入口格式，没守住"谁能写"和"写进来怎么渲染"** |
| **K3** | **current_feeling 架构性冻结** | prewarm 只选 session_init 策略（prewarm.ts:63-66）→ `createPrewarmAgentContext` 硬编 `messages:[]`（injector:189-204）→ `q=""` → 感受块恒空随缓存落库；兜底路径（cache miss）注入的也是**首问感受**且冻结整会话 | feeling 设计 §3"每轮派生当前感受"在主流程**架构上不可能发生**；块内"当前问题触及"文案成为不诚实陈述。与向量无关（appraisal 是纯子串匹配，current-feeling.ts:24） |
| **W1b** | **golden eval 三处诚实性折扣** | ① 今日实跑 replay.mjs：A=0.21/B=0.26 vs README 记录 0.63→0.79 **不可复现**（未归档逐 query 快照/语料快照，49cbf5e 只提交 14 行表格）；② `replay.mjs:6` 库名无 `-WiKi` 后缀 vs `:60-64` router 键带后缀→**router 在评测脚本恒 no-op**（生产注入器按 `w.name`="Coding-WiKi" 匹配生效）——"router 带来提升"的归因不被已提交脚本支撑；③ absGate fail-open（injector:194-196 `undefined || >=`）因向量死**静默空转** | "golden 回归门"现在跑即失败但无任何报警机制；"三道门"实为一道半且无人知道 |

> **勘误注（2026-09-09 fix1，I-1）**：W1b② 的归因判断已被隔离实验定量证实并精确化——
> router on/off 三对镜像配置实跑：B(0.66) = tw09+rel0.6 无 router 镜像（B 相对 A 的
> 差值全部来自 tw08→tw09 + rel0.7→0.6 参数差）；router 单变量在部署工作点（rel0.6）
> posRecall 贡献=0，negInjected 恒 +2（rel0.7 镜像对 +1~+2 但同样 +2 噪音）。router
> 存废/权重作为独立调参变量另行归档后再议。详见 `recall-golden/README.md` fix1 小节。

### 3.2 Medium（语义偏差 + 隐性失效）

| # | 问题 | 代码事实 | 影响 |
|---|---|---|---|
| **H1** | **H 巩固分组键无语义能力** | `subjectOf`（grouping.ts:50-59）= 取首个"："/":"/" — "前 ≤24 字符，否则前 4-24 字符**前缀字符串匹配** | LLM 自由文本前缀完全一致概率≈0 → minCount≥3 **结构性难触发**。第四轮"生产零输出属触发条件未达非缺陷"定性过浅——**代码正确但算法到不了设计意图**（设计 §3.4"按主体/实体聚合"被实现为字面量前缀） |
| **G5** | **边强度常量伪造** | `attachTopCandidates`（l1-dedup.ts:432）：`hasVectorScores ? 0.8 : 0.5` **两个分支都是常量**；真 cosine 在 findCandidatesByVector 映射 MemoryRecord 时被丢弃（:236-252 无 score）；注释自称"cosine 可信"却不用（:416）。生产首条边 strength=0.8 即假值 | 图边强度失真（UI 边粗细按 strength 渲染 MemoryGraphView.tsx:58）。三条 similar 路径唯一真值：no-dedup top-1（l1-extractor.ts:885 真 cosine clamp） |
| **G4** | 同批互建边 | storeAllDirectly 只排自身不排同批（l1-extractor.ts:882 `find(c => c.record_id !== record.id)`），对照 dedup 路径有 newRecordIds 过滤（l1-dedup.ts:218,237） | 同批新记忆互当对方 top-1，真旧记忆被挤出 top-3 |
| **K6+H-B8** | **M 反漂移三门对 H 产物结构性恒过** | H 产物 significance=priority/100 派生常量 0.8（summarizer.ts:63 读 priority 非顶层 significance；worker 恒 priority:80 :57）≥0.7；observedCount 恒≥3≥2；certainty 硬编 observed | 三道门全过→防漂移实际单点依赖 consolidation 阈值（而它又被 H1 废了）。H-B8 同时违设计 §3"significance=组内 max" |
| **G2** | `/v3/atomic/neighbors` 零租户过滤 | handler（v2-router.ts:1357-1367）无 requestIsolation；getNeighbors（sqlite.ts:1555）签名无 filter；v3 严格校验只验形参不使用 | 知道任意 record_id 即可跨租户枚举邻居+内容（返回含 content/certainty 等 :1369-1377）——违 "never crosses tenants" |
| **H-B5** | **空串短路 fallback 链** | scheduler 派生 `occurred_at ?? ""`（lifecycle-scheduler.ts:39）→ 空串非 nullish → scorer 的 `??` 链（scorer.ts:72-76）第一环就停 → age 恒 0 恒 keep | occurred_at 空串行永不归档（F3 回填 100% 掩盖；新库/回滚/兜底遗漏行即复发）。grouping occurredTs 同病 |
| **H-B6** | 持续态归档后幂等键消失→复活新建 | existingDurativeOf 只查 l1_records（consolidation-worker.ts:43-49）；归档后行移出（sqlite.ts:1636） | 归档与巩固每 tick 拉锯（低分场景成立）；幂等键应含 l1_archive 回查 |
| **W4** | router "boost-only 不删除"声称不成立 | boost 乘在归一化**前**（injector:168-173→:207 min-max→:210 relGate 删）→ 抬高一库=压低他库 normScore→被门删除 | 数值例：池{A:0.9→boost1.8, B:0.8}→B norm=0 被删（无 boost 时 B 是第一）——软定域防 under-recall 被耦合抵消 |
| **W5** | 结构页/other 三门共同盲区 | log/index/schema/purpose 永不向量化（manager.ts:184-193）→永无 absScore→absGate 结构性无效；typeWeights 无 other/log 权重 | 本轮注入块实况：`[other] Index score=1.00`、`[schema] 0.87`、`[other] Ingest Log 0.81/0.71` 反复穿门——每次 batch-ingest 都在制造噪音 |
| **W7** | absGate 零测试 | 3b257fe message "unit-tested" 但 diff 无测试文件；全仓 absScore 测试零命中 | 最警惕的静默失效类恰在测试盲区（今日实况即失效） |
| **K7/K8** | core_values 无删除/更新 API；duratives provider `queryL1Records()` 无租户 filter | injector 只 read；pipeline-factory.ts:1028 全库查询 | "agent 可维护"对价值锚不成立；多租户画像供料越租户 |
| **G6** | getPath 未实现且未登记 | 全仓 0 命中；graph 设计 §4 承诺"供 J 重构式回忆用"；spec 偏离清单未收录 | 违反"如实登记"纪律 |
| **W6** | golden harness 与 golden 文件不一致 | replay.mjs GOLDEN 18 条漏 p6；正例相关集裁剪（19 vs queries.jsonl 29）；should_not_recall 从不读取；子串匹配误伤 | 复现口径与声称不一致 |

### 3.3 Low（登记即可）

G7 merge 边类型语义稀释（同主体 merge 也建 similar，l1-extractor.ts:792-793）；G8 neighbors maxN 无上限 clamp+稠密图 BFS 无护栏（v2-router.ts:1365-1366）；G9 part_of 方向语义与设计枚举外（持续态→证据 vs "part_of"自然语义，consolidation-worker.ts:136）；G10 best-effort 日志误报"写入失败"（记录已 push 后 embed 失败走外层 catch，l1-extractor.ts:877-897）；G11 邻居返回无排序（BFS 发现序，截断可能截掉高强度边）；H-B9 restoreL1 FTS 重建不分词（sqlite.ts:1680 传原文 vs 写入侧 :1490 tokenizeForFts——恢复的记忆 FTS 大概率搜不到）；H-B10 tick 无重入锁（并发双写破幂等，lifecycle-scheduler.ts:73）；H-B11 LLM 失败无退避（每 10min×每组反复打）；H-B12 updateL1Metadata 刷 updated_time 被 TTL cleanup "回忆续命"（未登记耦合）；H-B13 pickArchiveCandidates 潜伏不过滤 certainty；H-B14 调度器 stop 未保存（unref 兜底）；H-B15 时间窗本地时区 vs UTC 部署；H-B16 f4 脚本未断言 taskId 继承；K9 拒绝路径无审计+成功审计 version 取 readCore()[0]（≠刚写槽）；K10 报告数字漂移（f2 实 14 断言非 17；403/400 注释错；seedValues id 语义错位 require→本地）；K11 forgetting 侧 appraisal 开关不可配（lifecycle-scheduler.ts:59 不传）；W8 Precision@k/MRR 未实现（spec §2 定义）；W9 minScore hop=0 恒惰性；W10 注入日志噪音+一处字符串拼接 bug（injector:220）；W11 queries.jsonl 反斜杠混排+q5 空缺；W12 注入块 `score=` 标签是相对归一分非绝对分（语义误导）；W13 replay.mjs 硬编码会话头。

---

## 4. 设计完整性缺口（第一性原理层：设计写了、代码没有、连登记都没有）

| 设计条目 | 出处 | 状态 |
|---|---|---|
| `coreRef: valueId[]`（记忆→价值锚引用） | spec §7 | **零实现、零登记** |
| L1→L2→L3 层级边（"经验→情境→身份"树） | spec §4.2 / design C2 | **零实现、零登记**（part_of 是 H 证据链非层级边） |
| `getPath(a,b,maxHop)` 查询接口 | graph 设计 §4 | 未实现（G6，未登记） |
| 情绪定重要性"高情绪→更易进 L2/L3" | spec §5.1 salience | 写入→遗忘侧通了（salienceBoost）；"进 L2/L3 优先"方向无管道 |
| 动机方向（motivational charge） | design §3b.3 职责4 | **完全无代码、无登记** |
| 记忆版 golden 评测（Recall@k/Precision@k/跨会话一致/不污染） | spec §12 验收 | **未建**；wiki golden 本身有三处折扣（W1b） |
| "当前感受影响注入看重程度" | feeling §3 | 被 K3 架构冻结 |

诚实登记确认：causal 边、恢复 UI、P5 K-sync、L2 重聚合四处缺口 spec 里如实登记 ✓（不计缺陷）。

---

## 5. 元裁定：对三轮既有审查报告

1. **修复真实性：属实**。F0-F7/A-G 代码声称经六路交叉复核+队长逐项抽查全部对上代码。
2. **方法论盲点**：三轮"生产实证"查了 soul 覆盖/孤儿边/core_values——**没有一项查向量覆盖率**。`countL1` 数错行与审计"没想到查向量行数"是同一认知盲区的两个面。
3. **"fixture 形状 ≠ 生产形状"——本项目三次踩同一个坑**：
   - 二轮 A2：significance 测试放 metadata、落库在顶层列 →"打分生效"实为恒 0.5
   - 本次 H-B1：verify fixture 自带 metadata、生产 search item 不带 →"封顶机制"实为恒 1
   - 本次 W1：映射层有 soul 字段、FTS 源头无列 →"透传已修"实为恒 undefined
   **元结论：每条 verify 断言必须用生产同形状的数据流端到端喂出来。建议写进团队验证纪律。**
4. **E2E 的证明力边界**：MemoryCore vitest 不可跑，全部验证靠 tsx+mock embedding/LLM——E2E 证明"依赖齐全时代码通"，永远证明不了"生产依赖活着"。本轮 G1/W1b 正是此盲区两次变现。
5. **第四轮"触发条件未达非缺陷"定性过浅**：H1 证明分组键无语义能力——"数据没到"实为"算法到不了"。

---

## 6. 本轮生产修复记录（已完成，待 commit）

1. 诊断：向量层死亡根因=嵌入套餐额度耗尽（用户确认）
2. 修复：`tdai-gateway.yaml` 嵌入配置 → `https://ark.cn-beijing.volces.com/api/coding/v3` + 新 apiKey（curl 实测 HTTP 200 + dims=2048 与 vec0 表定长匹配后写入）
3. 重启：网关 10:18:54 加载新配置
4. 验证：向量 104→107（+3 增长）、l1_links 0→2（10:35:59 首条 similar 边）、reconsolidation 首次生产留痕（3 条 observed recall_count:1）、/v3/atomic/search 200
5. ⚠️ 该 yaml 改动**尚未 commit**（G 线 B12 登记）——建议尽快入库注明"嵌入套餐切换"

> 注意：首条边 strength=0.8 是 G5 常量假值（向量分支），且 H-B1 使 recall_count 封顶机制即使触发也只到 1——**"恢复"只是管道重新过水，水质问题仍待 §7 修复**。

---

## 7. 修复优先级（六路合并收敛）

**P0 · 数据正确性（一行/一 commit 级）**
1. H-B3：sourceMemories 加 isObservable 过滤（一行，堵 H 侧洗白红线）
2. E2：inferred 门收紧 `!== "observed" → skip`（一行，堵 C 侧 FTS 绕过）
3. E1：handleAtomicUpdate 补拷 soul 8 字段（堵"编辑即失忆"）
4. H-B1：recall_count 改 SQL 自增 `COALESCE(json_extract(metadata_json,'$.recall_count'),0)+1` 或 item 带 metadata（堵"恒 1"）

**P1 · FTS/图数据链（一个 commit 收口）**
5. W1(+B15/H-B4 连带)：FTS 加 soul 列（DDL+rebuild+insert 或 handler 按 record_id 回查主表）——同修时间窗/情感标注/inferred 判定三处
6. G5：attachTopCandidates 透传真分（前置确认 CandidateMatch 是否携带 score——全审查唯一未查项）
7. H-B9：restoreL1 FTS 重建补 tokenize

**P2 · 信任边界**
8. K2→K1→K-B4：escape 名单加 core_memory → core 表加租户列+handler 消费 isolation+apiKey 必填 → 模块级缓存加租户键
9. G2：neighbors 补 isolation filter
10. H-B2：parseConfig 增 lifecycle.filter 字段 + server 按实例传入

**P3 · 架构语义（让降级可见、让算法到得了）**
11. G1：countL1 降级判据改向量行计数 + 降级 warn 告警 + 注入块降级标注
12. K3：current_feeling 脱离 session_init 冻结（独立 hook 或 hybrid 策略）
13. H1：subjectOf 语义化（嵌入聚合或 LLM 抽 subject）——否则 H 巩固在生产结构性不触发
14. G4/G6/H-B6：同批互建边过滤、getPath 登记或实现、幂等键含 archive

**P4 · 诚实性**
15. W1b：修 harness router 键名 + 归档逐 query 快照 + absGate 补测试（含 undefined fail-open 用例）
16. spec 偏离清单补登记：getPath/coreRef/层级边/动机方向/TCVDB native-hybrid 跳过 reconsolidation/updated_time 耦合

---

## 8. 无问题确认（六路查证过，防误伤）

l1_links DDL 与设计逐字段一致；并发建边无竞态（better-sqlite3 单连接+ON CONFLICT）；边类型全小写与 UI 枚举对齐；causal 零创建点=诚实待办；归档不删边（关系事实语义）+getL1ByIdsWithArchive 可回溯；getNeighbors 环路安全；230b84c 去 sessionId 后 team/user/agent/task 四维隔离完整；conflict 双方保留全链一致；observed 门把空值当 observed 可接受（P0 已保证满列）；no-dedup top-1 边真 cosine+双端 inferred 校验（比承诺更严）；BFF 走资产读鉴权；图 UI 数据源自洽；restoreL1 向量不重建已诚实注释；幂等机制本体/租户继承四维/observed_count 链路/part_of 同源/I 公式参数/价值锚单源/仅 observed 自动归档红线/调度器接线/9ee129a 派生/upsertL1 26列26? 全部属实；reconsolidation 触发点覆盖完整（修正：Proxy L1 注入器已下线，单一咽喉成立）；生产零归档零巩固符合"宁漏勿多"预期；typeWeights 三角一致（代码默认 injection/index.ts:555 / 部署 config / spec 校准）；switch-D 撤回干净；sort-before-slice 与 spaceId 修复带回归测试；检索引擎排序行为未被触碰；absScore/score 未混用口径；单 wiki 故障隔离有测试；hop>0 图扩展默认关。

---

*审查执行：6 路并行 subagent（G 线/H 线/KLM 线/写入召回线/wiki 线/生产实证线，其中 H 线超时由队长补位自查 grouping/scorer/scheduler，后于终局前交付）+ 队长生产只读探针 15+ 次。全部结论附文件:行证据，可复核。*
