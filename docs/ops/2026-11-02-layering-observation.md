# 记忆分层与提取优化 —— 生产观察窗读数协议与基线

> 目的：A1/A3/A2/B1/B2/B3/B4 七项改动上线后，用同一套只读读数判断“是否真的在生产生效、是否朝判据走”。
> 本文记录 2026-11-02 应用配置并重启当刻的**基线**，以及读数口径、判据阈值、诚实边界、回滚键。
> 命令实现：`MemoryCore/scripts/memory-observation.ts`（`npm run memory:observe`）。

## 1. 命令

```bash
cd MemoryCore
npm run memory:observe                 # 最近 24h，人读
npm run memory:observe -- --hours 6    # 换窗口（1..720）
npm run memory:observe -- --json       # 机读（落盘对比用）
npm run memory:metrics -- --limit 1200 # 另一套：L1 质量指标（见 memory-metrics.md）
```

只读保证：日志按文本读、journal 按 JSONL 读、SQLite 以 `readOnly` 打开，全程不写生产库、不发消息、不触发抽取。

## 2. 每项读数来自哪个事实源

| 项 | 读数 | 事实源 | 口径要点 |
|---|---|---|---|
| A1 | 入队 / 完成 / 真写块 / 候选全失效跳过 / 门拦截 | core 日志行 | `enqueued L2 task` = 调度器要跑一次；`gate-skip` = 新门拦下且**不推后** `l2_last_extraction_time` |
| A3 | 自述门轮次 / 扫过行 / 丢弃行 | recall journal `gates.selfNarration` | 读侧过滤只在 `recall.selfNarration.enabled` 且候选池非空时出现；`skipped:"empty"` 表示池空、门跑了但没行可筛 |
| A2 | —（配置面） | `extraction.facts` + 召回 journal `factChannel` | 本批只做“关抽取侧止血”，通道实验未开，故无读数字段 |
| B1 | 巩固运行次数 / 平均 groups / 平均 sources | core 日志 `[consolidation] ran: ...` | groups 是 (entity, attribute) 归组后的卡数；sources 是本轮进池记录数 |
| B2 | 带 validity 门的轮次 / dropped / validEndFiltered | recall journal `gates.validity` | **只在钩子路**（`auto-recall.searchHybrid`）出现；端点 `/v3/recall` 池空时不发该门 |
| B3 | scene 块文件数 / 总字节 / p50 / max | `data/profiles/*/scene_blocks/*.md` 的 stat | 必须先有 L2 跑一轮新 structured 形态，旧块仍是 legacy 大块 |
| B4 | dedup 批次 / LLM 调用均值 / 候选数 | core 日志 `dedup prefilter: ...` | 标记是新代码发的；批次=0 表示窗口内没有 L1 抽取流量，不代表“省了” |
| 召回 | 轮次 / 零注入率 / 注入字符 p50 / 平均注入行 / precisionProxy | recall journal | 只认 `selection.kept` 与 `injectedChars`，**绝不拿 `memoryLines`（候选池）冒充注入行** |

## 3. 基线（应用配置 + 重启之前的 24h）

窗口：`2026-11-01T07:35:51Z → 2026-11-02T07:35:52Z`；日志覆盖 30 个文件、首尾连续（`2026-11-01T07:35:52Z → 2026-11-02T07:35:52Z`）。

| 项 | 基线读数 |
|---|---|
| A1 | 入队 **1180**（≈49/h）、完成 563、真写块 119、候选全失效跳过 209、门拦截 0（门当刻刚上线 30min） |
| B1 | 巩固 146 次，平均 groups **7.18**，平均 sources **3410.84** |
| B4 | 批次 0、LLM 调用 0（新标记，窗口内无 L1 流量） |
| B2 | 带 validity 门轮次 0（钩子路窗口内无 post-restart 流量） |
| A3 | 带 selfNarration 门轮次 3、扫过 0、丢弃 0（库内 `actor='agent'` 为 0 行） |
| B3 | scene 块 16 个、总 220158B、p50 **13742B**、max 23888B（全 legacy 形态） |
| 召回 | 202 轮、零注入率 78.2%、注入字符 p50 0、平均注入行 3.37、precisionProxy 97.5% |
| 库 | l1_records 3861、l1_archive 6526、valid_end 非空 106、actor=agent 0 |

机读快照：`D:/TDB/data/run/obs-baseline-24h.json`（机器私有，不入库）。

## 3.5 A2 更正：facts 通道不是死成本（2026-11-02 15:45 自曝）

研究底稿 §0.5 的“付 token 无消费者”结论**与部署现状不符**，已被一手取证推翻：

| 证据 | 读数 |
|---|---|
| `MemoryCore/tdai-gateway.yaml:84-93` | `write.factKey.enabled: true` / `mode: channel` / `includeTriples: true`（#137 2026-10-27 全开档） |
| `MemoryCore/tdai-gateway.yaml:170-172` | `recall.factChannel.enabled: true` / `weight: 0.6` —— **读侧也在用** |
| `l1_records` 含 `metadata.facts` | 471 行 |
| `l1_fact_vec_rowids` | 417 行 |
| recall journal `factHits` | 0 命中 142 轮，**≥1 命中 60+ 轮**（最高 18）——通道真在贡献候选 |

因此：
- **A2 的正确动作是“不动”**：写侧与读侧都活着，facts 抽取的 token 有消费者，不存在“关抽取侧止血”的收益。
- 我在 15:27 曾按底稿把 `extraction.facts.enabled` 置 false，15:40 复查日志（`factKey=on` 但 `keyMode=content`、`l1_records` 最后一条带 facts 的记录停在 07:24Z）发现**这会把活跃通道的事实源掐掉、同时仍付双写 embedding**，已于 15:40 回滚为 `true`（备份 `config-override.json.bak-20261102-1540-a2revert`）并重启。
- 底稿的“写侧全关”很可能是把 override 缺省当成了生效值：`config-override.json` 里确实没有 `write` 段，但 **yaml 里的值就是生效值**（override 只在提供时覆盖）。

## 3.6 B1 生产缺陷：换键之后暴露的两个真实故障（2026-11-02 15:40–16:16，均已修）

属性归组把组数从 8 抬到 20+，立刻压出两处**旧代码里看不出来的**故障。两个都不是"配置没开"，是"接线缺失"。

### 3.6.1 池内补齐全量重嵌 → Ark 429 风暴

- 现场：15:40:47 重启后 12 分钟出现 957 条 `rate limited (429)`（稳态 88 次/分钟、零成功）；同一时刻 `[lifecycle] tick` 后 10 分钟打印 `previous tick still in flight, skipping`——巩固 tick 卡死。
- 根因：`MemoryCore/src/core/lifecycle/consolidation/consolidation-worker.ts` 的 `selectGroups` 在属性归组时**对池内每条记录逐条 `await embedForLifecycle`**，无复用、无上限。生产实测池 = 1904/3876（49.1%）：1904 条 × 3 次重试 × ~650ms ≈ 连续 60 分钟 429。
- 修复：①新增 `IMemoryStore.getL1VectorsByIds`（`sqlite.ts`，400 条分片 IN 查询、byteLength 必须 = dimensions×4）复用库内已入库向量；②只对真正缺失的做补齐，且上限 `attributeGrouping.maxPoolEmbeds`（缺省 64）；③`loadVectors` 抛错时本轮**不补齐**（宁可单条成组，不再撞配额）。
- 验证：16:02 回开 B1 后 5 分钟内 429 = **0**（同配置旧代码 15 分钟 1305 条）；`Lock conflict [L2]` = 0；tick 正常收口。

### 3.6.2 巩固 LLM 的 maxTokens 未接线 → 摘要截断丢卡

- 现场：同一 tick `consolidation groups=20 persisted=17`，3 条 `WARN summarize failed ... LLM empty response (finishReason=length, completionTokens=4096)`，另有 `The operation was aborted due to timeout`。
- 根因（离线一手复现，`.probe-summarize.mts`）：`MemoryCore/src/gateway/server.ts` 构造 lifecycle 用的 `StandaloneLLMRunner` 时**没传 `maxTokens`** → `llm-runner.ts` 的 `rawMaxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096` 恒取 4096，`llm.maxTokens=131072` 被绕开（FLOW-E 同款"不接线即死配置"）。同一组（40 成员 / prompt 10312 字符）实测：

  | max_tokens | finish | completion | 正文 | 耗时 |
  |---|---|---|---|---|
  | 4096 | length | 4096 | 0 字符 | 30.9s |
  | 131072 | stop | 16678 | 8053 字符（合法 JSON） | 89.1s |

  第二处硬限：`summarizer.ts` 的 `timeoutMs` 写死 30_000，即便放开 maxTokens 也必然超时（同组 89.1s）。
- 修复：①`server.ts` 传 `maxTokens: effective.maxTokens`；②`SummarizerConfig.timeoutMs` 可配，缺省 `DEFAULT_SUMMARIZE_TIMEOUT_MS = 180_000`（覆盖实测最大组 44 成员 ≈90–120s）；`consolidation.summarizeTimeoutMs` 可覆盖。
- 配套：属性组数变多后每 tick 重算全部组会把互斥锁占满（20 组 × 30–90s > tick 间隔）。新增**指纹跳过**：按「组身份 + 组内源 id 集合」算 sha1 落卡 `metadata.source_fingerprint`，源集合没变的组本轮不重算（增量记忆出现→指纹变→重算；老卡无指纹→首轮重算一次补齐）。台账新增 `skippedUnchanged`。

### 3.6.3 修复上线后的生产读数（2026-11-02 16:16 起，新进程 pid 20256）

| 读数 | 修复前（16:02–16:16 进程） | 修复后（16:16 起） |
|---|---|---|
| 首个 tick | `groups=20 persisted=17` + 3 条 `summarize failed` | `groups=20, summaries=20, persisted=20, skippedUnchanged=0`（16:16:44→16:23:41，约 7 分钟） |
| `summarize failed` | 6 条（含 1 条 30s 超时、多条 `finishReason=length, completionTokens=4096`） | **0 条** |
| `rate limited (429)` | 15 分钟 1305 条 | **0 条**（全程） |
| 第二个 tick（16:26:52） | —— | `groups=20, summaries=0, persisted=0, skippedUnchanged=20`：零 LLM 调用，tick 秒级收口 |
| 巩固卡 | 27 张（无指纹） | 30 张，其中 20 张带 `metadata.source_fingerprint` |
| L2 门 | 无门（每次调度都跑） | `[L2] Gate skipped (l2-gate): pending=3<30, lastExtraction=752758ms<6h` 真在拦 |
| scene 块 | 16 块全 legacy，p50 13742B / max 23888B | **16 块全 structured**（`## 摘要` / `## 主张` / `## 事件流`），p50 **3779B** / max **4070B**（≤ 4096 字节，UTF-8 实测） |

- **读数口径自曝修正**：`scripts/memory-observation.ts` 原只数 `L2 gate-skip:`（`pipeline-manager` 形态），而生产实际打的是 `[L2] Gate skipped (l2-gate):`（`pipeline-factory` 形态）⇒ 首跑读数 `gate-skip=0` 是**假读数**。已把正则扩成两种形态并补用例（`observation-scan.test.ts` 13→14 例），复跑后 `gate-skip=4`。教训：**读数为 0 时先证"计数器认得这条日志"，再谈"没发生"**。
- **B3 的 4096 口径**：`scene-structured.ts` 用 `Buffer.byteLength`（UTF-8 字节）判定，不是字符数；实测 16 个块的整文件字节数（META 头 + 三段正文）最大 4070B，正文段最大 3662B，两条口径都在 4096 内。此前 24h 基线的 13742B/23888B 全是 legacy 整篇重写，**不是**新形态超标。
- **观察期文件读取要避开写入瞬间**：16:31:29 抓到 `TDB-记忆系统增强路线.md` 4688B（body 4235B），几十秒后同一文件重读是 3835B——写入是"整块替换"，中途快照会读出旧版本拼新 META 的假数字。

### 3.6.4 重启会把 242 个会话的 L2 定时器同时拉起（既有机制，非本批引入）

- 现象：16:28:22 一次性 `enqueued L2 task` **242 条**（= 重启恢复的会话数），随后 6 分钟 `Lock conflict [L2]` 稳态 **708 条/分钟**（16:29–16:33），16:34 半分钟内收敛，16:35 起归零。
- 机制：`MemoryCore/src/services/pipeline-worker.ts:300` 的锁键对所有会话归一（`pipeline:{team:_}:{user:_}:{agent:_}` 形态的 `pipeline:{default:_:_}`），**同一时刻只允许一个 pipeline 任务持锁**；抢不到的协程在 `lockTtlMs` 窗口内指数退避重试（200ms→5s 封顶），并把任务以 `id-lrN` 重投（`MAX_LOCK_REQUEUE` 上限）。242 个任务争一把锁 ⇒ 日志风暴 + 10 个 worker 槽位被 sleep 占住约 6 分钟。
- 与本批的关系：**不是本批引入**（14:12 那个进程 24h 内同类日志 47026 条）。但它解释了"A1 的 `enqueued` 数不跟着门下降"——门在 `createL2Runner` 里、**执行期**才判，门拦下的任务已经入队并参与抢锁了。
- 对判据的影响：A1 要看的是 `Task completed: L2` / `scene extraction` 真跑的次数，不是 `enqueued`；把门提到入队前是**下一批**的事（本批不扩范围，已在 §3.6.4 留档）。


### 3.7.1 F1 验收与「探针打错实例」的教训（2026-11-02 17:30 自曝）

- **伪结论**：先前两次 `/v3/recall` 探针 0 命中（`ftsHits=0`、`vec0 returned 0 candidate(s)`、1ms），据此差点判「L3 巩固卡召回不出」。
- **真相**：探针打到了空库。实例路由在 `MemoryCore/src/core/store/store-pool.ts:260-307`：`createSqliteStore(instanceId)` → `getSqlitePath`（`:302`），`instanceId === "default"` 用 `dataDir/vectors.db`，**其他任何 instanceId 用 `dataDir/instances/{instanceId}/vectors.db`**；`instanceId` 来自请求头 **`x-tdai-service-id`**（`MemoryCore/src/gateway/v2-router.ts:1375/:2002/:2305`）。
- 证据：`D:/TDB/data/instances/{probe-layering,probe-svc,team-2k12lgb650}/vectors.db` 全是 **4096 字节空库**；而 `D:/TDB/data/vectors.db` 是 410MB / 3900+ 行。用 `x-tdai-service-id: probe-svc` 探针 ⇒ 对空库做 KNN ⇒ 0 候选，与代码无关。
- 正确姿势：`x-tdai-service-id: default`（`MemoryCore/config/templates/dsh-plugin.yaml:20` 的 `serviceId: "default"`，即面板/插件实际使用的值）。改后立刻 `ftsHits=32 / embeddingHits=32 / factHits=32`。
- **F1 验收通过**（2026-11-02T09:32Z，脚本 `D:/TDB/data/run/probe-f1-accept.cjs`）：query「记忆系统P1四项改进 …M4 双时态，2026-10-14T03:09 收官」的 `data.block` 含 `- [结论|consolidated] …`；query「td-agemem 推送 surgical commit …69ee8fe」同样命中。库侧 `SELECT … WHERE scene_name='consolidated'` 共 32 行，**`valid_end` 全为 `""`**（开区间），`content` 589–1283 字节，`metadata` 带 attribute 键。
- 结论：F1 的**写侧开区间 + 存量 30+4 行修正**在生产真实生效；**不需要**给读侧加 `scene_name='consolidated'` 豁免（根因在写入侧已消除，读侧豁免会掩盖同类 bug）。

### 3.7.2 读数口径第二次修正：节流行与新的巩固收口行（2026-11-02 17:35）

- 生产有三种拦截形态，`observation-scan.ts` 原正则只认得两种：
  1. `[pipeline-factory] [L2] Gate skipped (l2-gate): pending=3<30, …`（每会话门，`pipeline-factory.ts:1100`）
  2. `[pipeline-manager] [session] L2 gate-skip: keep l2_last_extraction_time unchanged …`（`pipeline-manager.ts:1130`）
  3. `[pipeline-manager] [session] L2 gate-skip (reason=l2-throttle): …`（F2 全局节流，`pipeline-manager.ts:1089`）——**旧正则漏计**
- 处置：新增独立计数器 `l2ThrottleSkips`（先判 throttle，命中即不计入 `l2GateSkips`），CLI 报两行分开的读数；`observation-scan.test.ts` 19 例。**两个变异都咬住**：把 throttle 正则改成永不匹配 → 2 例红；把门正则放宽成不带冒号且去掉 `else if` → 2 例红。
- 同时修第二个静默归零：`[consolidation] ran: groups=…, summaries=…, persisted=…, skippedUnchanged=… (sources=…)`（`consolidation-worker.ts:434`）多了 `skippedUnchanged=`，旧正则要求 `persisted=N (sources=` 紧邻 ⇒ **B1 读数会静默变成 0**。改为该段可选，旧日志仍解析且 `skippedUnchanged` 留 `undefined`（不用 0 冒充）。
- 教训（第二次踩同一个坑）：**改日志格式的同一批必须改读数正则**，否则观察窗拿到的是「修复有效 ⇒ 读数为 0」的自证循环。

### 3.7.3 F8① 折行噪声：已机械还原，剩余部分如实披露（2026-11-02 17:45）

- 起点：27 个改动文件 `git diff --stat` = **+2490 / −543**，而 `git diff -w --stat` = **+2319 / −372** ⇒ 约 **171 行纯行内空白**（>545 个文件从未格式化，编辑器/工具重排会引入）。
- 处置（脚本 `D:/TDB/data/run/revert-ws-hunks2.cjs`，不入库）：逐文件取 `git diff -U0` 的 hunk，把「去掉所有空白后 old==new」的 hunk 视为折行噪声，用**整块字符串替换**（要求 new 块在文件中唯一出现）还原成 HEAD 文本；**不变式 = 还原后整文件 `s+` 归一文本与还原前逐字节相同**，不成立就整文件回滚。
- 结果：`auto-recall.ts` 还原 64 处（跳过 4 处不唯一）、`config.ts` 还原 15 处（跳过 1 处）；总量降到 **+2207 / −381**（`-w` +2068 / −242）。残余 139 行空白差异集中在 `auto-recall.ts`（120）、`gateway/config.ts`（10）、`pipeline-manager.ts`（4）、`config.ts`（2）、`grouping.ts`/`l1-dedup.ts`/`package.json`（各 1），这些 hunk **同一块里既有语义改动又有折行**，机械还原会连带改语义，故保留。
- 处置约定：这部分在**提交时**拆两个 commit（先纯格式化、再语义），需要用户授权提交；本批零 commit，故以本节留档替代。验证：还原后对两个大文件跑 `tsc --noEmit` 语法检查（0 个 TS1xxx）+ 全量门（见 §7）。

## 4. 判据（观察窗结束后按此裁决，不另立口径）

- **A1**：真跑次数（`Task completed: L2` + `scene extraction`）从 1180/24h 量级降到 ≤ 300/24h；`gate-skip` > 0 且 `completed` 不塌到 0（门拦下≠不再产出）。`enqueued` **不作为判据**：定时器按会话入队（重启时一次 242 条），门在入队之后才判（见 §3.6.4）；拿 enqueued 会得出"门没生效"的假读数。
- **A3**：`actor='agent'` 行数从 0 变成 >0（写侧 `actorTagging` 需要新入库行），且 `gates.selfNarration.dropped` 出现 >0；查询自指轮次 `skipped:"self-query"` 且未被过滤。
- **A2**：**无动作**（见 §3.5 更正）。读数只做守护：`extraction.facts.enabled=true`、`write.factKey.mode=channel`、journal `factHits` 仍有 >0 轮次；若这三条任一退化才回滚/报警。
- **B1**：平均 groups 从 7.18 **降到 3–5 且不出现 >50 条的巨卡**；卡数下降来自合并非丢弃（sources 不塌）。另守住两条工程指标：单 tick `429` = 0、`summarize failed` = 0，且 `[consolidation] ran ... skippedUnchanged=` 出现 >0（说明指纹跳过在稳态生效，不再每 tick 全量重算）。
- **B2**：出现 `roundsWithValidity > 0` 且 `validEndFiltered` ≈ 库内 valid_end 非空行数（当前 106）；soft 档应为 0。
- **B3**：出现 structured 形态块（含 `## 摘要` / `## 主张` 段）且单块 ≤ 4096B；稳态下每轮增量应远小于旧整篇重写；p50 从 13742B 明显下降。
- **B4**：`meanLlmCallsPerBatch ≤ 1.3`（基线来自研究文档 2 次/批）；`prefiltered` > 0 说明门槛真的在筛。

F 批（2026-11-02 追加，`m01638`）：

- **F1**：`/v3/recall`（**必须 `x-tdai-service-id: default`**）的 `data.block` 出现 `[结论|consolidated]`；`SELECT … WHERE scene_name='consolidated'` 的 `valid_end` 全空。已过（§3.7.1）。
- **F2**：重启后 **≥30 分钟**内 distinct `scene-extract-<ms>` ≤ `maxRunsPerHour`（生产配 1）、`L2 complete` ≥ 1、`Lock conflict` 显著低于 15691/33min 事故基线、出现 `(reason=l2-throttle)` 行与 boot WARN（若 armed 会话数 > `bootRecoveryWarnSessions`）。**`enqueued` 不作判据**（§3.6.4）。
- **F3**：日志 0 条 `input limit exceeded`；`dedup prefilter: prefiltered=` > 0 且 `llmCalls` ≤ 1（15 条候选只发 2 次请求）。
- **F4**：`extraction.dedupPrefilter.minCos=0.82`（实测空窗 0.857→0.992，报告 `docs/ops/2026-11-02-f4-dedup-prefilter-calibration.md`）；10 组应合并对全放行、10 组无关对全拦下的矩阵见该报告。
- **F5**：全库 `selfNarrationRate` 的 AI 主语分项从 0/535 变为 >0（实测 194/534=36.3%）；`metrics` 与 `agent-narration` 同一判定（200 行逐行对拍相等）。
- **F6**：八项读数带分子/分母且口径见 §4.1；`churn` 改同期比例、`zeroInjectionRate` 只统计 `selection != null` 轮次并单列 coverage、`precisionProxy` 只对候选池（`precisionScope="candidate-pool"`）。
- **F7**：`gates.validity` 三层（`pool`/`top`/`injected`）同时出现，且**端点 `/v3/recall` 的 journal 也带 `validity`**（此前只有钩子路有）。边界用例：5 候选含 2 条过期且落在 top 之外 ⇒ `injected.dropped=0`、`top.dropped=2`、注入行数不变。

## 5. 诚实边界（读数不能证明什么）

1. **B4 批次 0 不能读成“LLM 调用降到 0”**——窗口内没有 L1 抽取流量；`meanLlmCallsPerBatch` 在零批时**故意返回 null**（`—`），不把“没跑”读成“跑得省”。
2. **A3 现在开=空操作**：生产库 `json_extract(metadata_json,'$.actor')` 全 null（复查 0 行 / 近 7 天 0 行）。过滤要等写侧打标的新行入库；在此之前任何“已过滤掉 N 条”的说法都是假的。
3. **B2 的 journal 证据只可能来自钩子路**：`gates.validity` 在 `auto-recall.searchHybrid` 里算（`MemoryCore/src/core/hooks/auto-recall.ts:4452-4466`，要求候选池非空），端点探针池空时不会出现。端点探针 0 命中 ≠ 过滤失效。
4. **A1 的 1180 与研究文档“99 runs/天”不同口径**：本工具数的是 `enqueued L2 task` 日志行（每次调度一条），文档那个数是另一种计数。跨口径不可直接比，只与自己的后续读数比。
5. **B3 的字节下降含“还没换形态”成分**：旧块全部是 legacy 整篇重写，structured 生效前 p50 13742B 反映的是旧形态，不是新形态的性能。
6. **召回零注入率 78.2% 含探针/空 query 轮**（与 `memory-metrics.md` 的同名边界一致），不是“该注入却空”的比例。
7. **日志覆盖必须看首尾**：轮转会切掉窗口头部，读数只在 `logCoverage.firstTs → lastTs` 段内成立；本次覆盖整段，故 24h 读数可用。

## 6. 回滚键（逐项独立，改完必须读回断言 + 重启）

配置文件 `D:/TDB/data/config-override.json`，应用前备份 `config-override.json.bak-20261102-1528`。

| 项 | 回滚动作 | 备注 |
|---|---|---|
| A1 | `persona.l2Gate.enabled=false` | 门消失 = 每次调度都跑（逐位旧行为），不过滤、不推后时间戳 |
| A2 | `extraction.facts.enabled`（保持 true）+ `write.factKey` / `recall.factChannel` 保持 yaml 全开 | 通道是活的（journal `factHits` 有命中）；任何一侧被关都要立刻回滚这一侧。回滚备份 `config-override.json.bak-20261102-1540-a2revert` |
| A3 | `recall.selfNarration.enabled=false` + `extraction.atomicMaxChars=300` + `extraction.atomicityRewrite=false` + `extraction.actorTagging=false` | 四个键各自独立可翻；`atomicMaxChars=300` 时 prompt 与旧版逐字节一致 |
| B1 | `lifecycle.consolidation.attributeGrouping.enabled=false` | 回 subject 整串相等键；已落卡带 `attribute_key` 不删（零删除红线），旧键读路径仍兼容。子键：`maxPoolEmbeds`（0 = 本轮不做池内补齐，最省配额）、`consolidation.summarizeTimeoutMs`（缺省 180s）、指纹跳过无独立开关（源集合不变就不重算，属正确性而非口味） |
| B2 | `recall.excludeInvalidated` 已有键，调回原值 | 读侧过滤走原开关，本批只加了计数与写侧边界修正 |
| B3 | `persona.l2Form.structured=false` | 回整篇重写；已写的 structured 块由 legacy 升级路径兼容读 |
| B4 | `extraction.dedupPrefilter.enabled=false` | 回“每批先 LLM 判重” |
| F1 | 无需配置键（写侧 `valid_end` 留空） | 回滚 = 让 `summarizer` 重新产出 `valid_end`，属代码回滚；存量 40 行（30+4+6）已改，回滚需按 `D:/TDB/data/run/f1-consolidated-valid-end-backup.json`、`f1b-…backup/*.json` 恢复 |
| F2 | `persona.l2Gate.maxRunsPerHour=0` + `maxSessionsPerRound=0` | 两者都 0 ⇒ 逐位回到加门前（242 会话一轮全放行）；`bootRecoveryWarnSessions` 只影响 WARN 阈值 |
| F3 | `embedding.maxBatchSize=256` | 回缺省批大小；折半重试随实例值生效，不受开关控制 |
| F4 | `extraction.dedupPrefilter.minCos=0.9` | 回原阈值（实测 0 对命中，等于关掉前置门槛） |
| F5 | `extraction.actorTagging=false` | 写侧不再标 `actor="agent"`；`recall.selfNarration.enabled=false` 关读侧过滤 |

## 7. 变更记录

- 2026-11-02：首版。建立读数命令、七项口径、24h 基线、判据、七条诚实边界与逐项回滚键。
- 2026-11-02 §3.5：A2 更正（facts 通道活着，自曝误判并回滚）。
- 2026-11-02 §3.6：B1 两个生产缺陷与修复（池内补齐 429 风暴 / 巩固 LLM maxTokens 未接线导致的截断丢卡）+ 指纹跳过。
- 2026-11-02 §3.7：F 批（F1–F8）。F1 验收通过并记「探针实例」教训；读数口径第二次修正（throttle / skippedUnchanged）；F8① 折行噪声机械还原 + 残余披露；§4 增 F 批判据；§6 增 F1–F5 回滚键。
- 2026-11-02 §3.6.3：修复上线后的生产读数（20/20 落卡、429=0、次轮全跳过、B3 全 structured）+ 两条读数口径自曝修正（gate-skip 双形态、4096 按 UTF-8 字节）。