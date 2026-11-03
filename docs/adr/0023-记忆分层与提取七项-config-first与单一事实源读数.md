# ADR-0023 记忆分层与提取优化七项：config-first + 离线复放定值 + 单一事实源读数

- **状态**：已接受（2026-11-02；来源：用户令「记忆分层与提取全链优化 P1–P7 全覆盖 → 生产运行态」，任务书 m00002）
- **关联**：研究底稿 `docs/research/2026-11-02-memory-layering-extraction-optimization.md`（192 行，只读取证已完成）；读数协议 `docs/ops/2026-11-02-layering-observation.md`；指标口径 `docs/ops/memory-metrics.md`
- **域词典**：`CONTEXT.md` → L1/L2/L3、注入面、候选池 vs 注入行、巩固（consolidation）、双时态

## 背景

七处病灶都在“同样的 token 花了两次、同样的判断信了一个不可靠的代理”，且全部**无法从代码或单次读数判断好坏**：

- A1：L2 每次调度都跑（24h 实测入队 1180 次），但多数轮只产出很少；
- A2：`extraction.facts.enabled=true` 却在付 token，写侧 `write.factKey`/factRows 全关、factTriples=0，没有任何消费者；
- A3：L1 把多条断言合并成一条（红线 300 字符是硬编码），且 AI 自述混进用户事实；
- B1：L3 用 `metadata.subject` 整串相等归组，同实体的不同属性各成一张卡、同主题反思被拆散或并成巨卡；
- B2：写侧 supersession 判定只改新行，旧行 `valid_end` 不置，读侧不过滤 → 被取代的事实仍在注入面；
- B3：L2 每轮整篇重写整块，输出 token 与块体积随轮次线性涨；
- B4：dedup 每批先请 LLM 判重（均值 2 次/批），而绝大多数候选对根本不相似。

## 决定

1. **七项全部 config-first，缺省 = 逐位今天的行为。** 每个新键缺省关闭，关闭态必须与改动前逐字节/逐位等价（prompt 文本、归组键、日志行、journal 字段都不变）。生产切换只改 `D:/TDB/data/config-override.json`，改前备份、改后读回断言。
2. **数字只由离线复放与生产读数定，不拍脑袋。** 阈值（`atomicMaxChars=600`、`dedupPrefilter.minCos=0.90`、`attributeGrouping.minCos=0.82`、`l2Gate.minPendingL1=30/minIntervalHours=6`、`l2Form.maxBlockBytes=4096`）来自 `memory:metrics` / `memory:observe` 的实测与离线复放校准；观察窗内若与判据冲突，先回滚再重试，不在生产上调参试错。
3. **读数的单一事实源写死**：注入面只认 journal 的 `selection.kept` / `injectedChars`，**禁止**拿 `memoryLines`（候选池）冒充注入行；零批不得读成“省了”（`meanLlmCallsPerBatch` 零批返 null）。
4. **A1 的门不许自己推后自己**（本次自曝缺陷）：`pipeline-manager.runL2` 原先在**任何** skip 分支都把 `l2_last_extraction_time` 重打成 now，门的时间条件被自己不断重置，生产退化成纯条数门。现由纯函数 `decideL2PostRun` 裁决：门拦下 → 不写时间戳、不清 pending；legacy 首轮 skip → 只清 pending；跑完 → 才刷新时间戳并推进 cursor。
5. **A2 不动（原判被推翻，2026-11-02 15:45 更正）**：底稿“付 token 无消费者”与部署现状不符——`tdai-gateway.yaml` 的 `write.factKey`（enabled/channel/includeTriples）与 `recall.factChannel`（enabled / weight 0.6）都是开着的，库内 471 行带 facts、417 条事实向量、journal `factHits` 有 60+ 轮 ≥1 命中。原计划“关抽取侧止血”会掐掉活跃通道的事实源却仍付双写 embedding，已回滚为 `extraction.facts.enabled=true`。教训：**override 缺省 ≠ 生效值，config-first 的“缺省”必须以 yaml 实际值为准**。
6. **A3 自述标注与过滤分离**：写侧只打 `metadata.actor="agent"`（`extraction.actorTagging`），读侧过滤（`recall.selfNarration.enabled`）由部署方决定；**查询自指**（“你刚才说了什么”）不过滤。生产库当前 `actor='agent'` 为 0 行 ⇒ 该开关此刻是空操作，不得宣称“已过滤 N 条”。
7. **B1 换键不删卡**：幂等键从 subject 整串改为 `(entity, attribute)` 归一 + embedding cos 兜底；旧卡带旧键仍可读、不删（零删除红线），但换键后旧卡不参与源池。防大卡上限 50 条/卡，超出切卡。
8. **B2 双时态两侧对称**：写侧 supersession 真正置旧行 `valid_end`；读侧注入前过滤并接线 journal `gates.validity`（`validEndFiltered` = 被效期丢掉的行数）。过滤档位（off/soft/hard）沿用 `recall.excludeInvalidated`。
9. **B3 形态换结构不换读路径**：scene 块 = 摘要/主张+heat/append-only 事件段，单块 ≤ `maxBlockBytes`；`META` 四字段保留 ⇒ 14 行索引与召回读路径零改动；legacy 块走升级路径兼容读。
10. **每项都留回滚键**（见 ops 文档第 6 节），回滚 = 翻一个键 + 重启，不改代码。
11. **B1 换键后暴露的两个缺陷按"接线缺失"修，不动阈值**（2026-11-02，ops 文档 §3.6）：修前 `selectGroups` 对池内每条记录逐条重嵌（1904 条 → 88 次 429/分钟、tick 卡死 10 分钟），修后先批量复用库内向量（`IMemoryStore.getL1VectorsByIds`）、只对有上限的缺失补齐（`attributeGrouping.maxPoolEmbeds` 缺省 64），`loadVectors` 失败则本轮不补齐。巩固 LLM 的 `maxTokens` 原**根本没接线**（构造 `StandaloneLLMRunner` 漏传 → 恒 4096 → `finishReason=length` 正文 0 字符 → 丢卡），现传 `effective.maxTokens`；`summarizer` 超时从写死 30s 抬到可配缺省 180s（实测同组 89.1s）。判据不接受"降 minCos / 减 minCount"这类把问题藏进阈值的做法。
12. **巩固按"源集合指纹"幂等，而不是按 tick 幂等**：组身份 + 组内源 id 集合的 sha1 落卡 `metadata.source_fingerprint`，指纹不变就跳过重算。理由：属性归组把组数抬到 20+ 后，每 tick 全量重算 = 20×30–90s > tick 间隔，必然互斥跳轮并把 LLM 成本与 `l1_archive` churn 成倍放大；而源集合不变时卡片内容**没有**信息增量。代价：卡片刷新时点是"新证据到达"而非"下一次 tick"，读侧会看到更旧的卡（可接受，卡只在有新增证据时才有新内容）。首轮实测：20 组全落卡（修复前 17/20）、次轮 `skippedUnchanged=20` 零 LLM 调用。

13. **F1：L3 持续态出生即过期的根因在写侧，故只修写侧**（2026-11-02 F 批）。`summarizer` 原把卡片的 `valid_end` 设成组内最新源的 `occurred_at`（= 过去），`consolidation-worker` 原样落库 ⇒ 每张新卡一出生就「已失效」，被 `excludeInvalidated=hard` 的读侧直接丢。改为开区间（`valid_end` 留空 + `metadata.activity_end_time` 记录窗口末）。**形态已实测校正（2026-11-03）**：写侧传 `undefined`，但落到列上的是**空串 `''`** 而非 NULL —— `sqlite.ts:143-144 soulBindValues` 把 `src[name] ?? SOUL_FIELD_DEFAULTS[name]` 兜成 `''`（`SOUL_FIELD_DEFAULTS.valid_end = ""`，:125-134）；生产只读实测 35/35 张 consolidated 卡 `valid_end=''`、全库 3964 行 `''` / 122 行有时间戳 / 0 行 NULL。读侧 `validity-policy.ts:128-141` 与失效守卫 `sqlite.ts:4630` 的 `(valid_end IS NULL OR valid_end = '')` 两形态同判，故行为无差；但任何新写的 SQL 谓词必须写双形态，只判 NULL 会漏掉全部存量开区间行，并一次性修正存量 40 行（30 + 4 + 6，均有备份 JSON）。**否决**了「在读侧给 `scene_name=consolidated` 豁免」：那会把同类写入 bug 藏进读路径，且新卡仍然带着一个错的 `valid_end` 语义。
14. **F2：L2 节流是「全局两道门」，且必须在 `await l2Runner` 之前**（2026-11-02 F 批）。`maxRunsPerHour`（小时滚动窗）+ `maxSessionsPerRound`（60s 滚动桶）双限，任一超限即拦；`0 = 不记账`，两键都为 0 时逐位等于加门前。拦截分支**完全不动 session state**（pending / 两个时间戳 / cursor 逐位不变），只重挂内存定时器。`bootRecoveryWarnSessions` 只影响 boot 时的 WARN 阈值。**否决**了「只在入队处限流」：`enqueued` 是定时器行为，不是 L2 真跑次数（§3.6.4 的重启风暴就是这个差），把门放在执行前才能同时压住锁冲突与 LLM 成本。
15. **F3：批大小是配置事实，不是常量事实**（2026-11-02 F 批）。生产网关 `Embeddings API input limit exceeded: max 10, got 15` 说明上游接口上限与代码里的 256 不是一回事；`embedding.maxBatchSize` 配置化（缺省 256 保持旧行为，生产配 10），并对 `400 + input limit exceeded` 做折半重试（失败回落到 FTS 而不是静默 catch）。**否决**了「把常量改成 10」：那是把当前供应商的限制焊进代码，换模型就再炸一次。
16. **F4：前置门槛用实测空窗校准，不用相对名次口径**（2026-11-02 F 批）。330 条 L1 向量 NN 分布 p95=0.721，0.9 的绝对值门槛等于恒空转；实测可合并对 0.8587–0.9918、无关对 ≤0.3630、硬负例 ≤0.8568 ⇒ 取 **0.82** 落在空窗内（报告 `docs/ops/2026-11-02-f4-dedup-prefilter-calibration.md`）。**否决**了「top-k 名次门槛」：名次永远有 top-k，会把无关候选送进 LLM，等于取消门槛。
17. **F5：自述判定只许有一套实现**（2026-11-02 F 批）。`record/agent-narration.ts` 是唯一判定（第一人称 + 第三人称 AI/助手/模型 主语 + 动作词/状语 gap），`metrics/memory-metrics.ts` 删除自己的第二套正则改为复用；单测锁 200 行逐行对拍。已知覆盖边界：AI 开头 534 行仍有 340 行未命中（多为「AI 给出的…」这类非动作词起始），按宁缺毋滥留后续批次，**不许**为了数字好看把判定放宽到「含 AI 即算」。
18. **F6：八项指标的分母必须自证**（2026-11-02 F 批）。`churn` 改同期比率（分子分母同窗口，窗口起点显式记录）；`recall` 只统计 `selection != null` 的轮并单列 `coverage`；`ANCHOR_PATTERN` 去掉裸数字（只认日期/时刻/`file:line`/含字母短哈希）；重复率随机采样（mulberry32 + seed）并用 `compared` 统一分母；`atomicMaxChars` 从配置读且 CLI 缺省跟随。旧的 `churnRatio=1.67`、`zeroInjectionRate=97%`、`precisionProxy=94.9%` 都是**量纲错**（分子全表/分母采样、分母掺无 selection 轮、裸数字虚高），修后读数下降不是质量回退。
19. **F7：效期计数必须在最终注入集上算，且不能对幸存集求 stats**（2026-11-02 F 批）。三层口径 `pool`（截断前全池，诊断）/ `top`（截断后）/ `injected`（真正少注入的行数）。实现坑：`injected` 第一版对 `visibleTop` 求 `validityStatsOf`，但幸存集按定义没有失效行 ⇒ `dropped` 恒为 0；正确做法是统计**被移出 top 的行**（`top.filter(!visibleIds)`）。端点路 `/v3/recall` 与钩子路走同一出口函数，journal 因此都带 `validity`。
20. **F8：卫生项也要有判据**（2026-11-02 F 批）。`heat` 上界 10 由 `clampHeat` 单独实现（**不能**合进 `normalizeHeat`：后者同时当非负整数解析器用于 `maxBlockBytes`，加上界会把 4096 压成 10）；事件流去重用「规范化哈希」（小写 + 去空白/标点）而不是相似度阈值（宁可留两条，也不把部署失败并进部署完成）；「无任何门时 `gates` 不含该键」要用显式断言；折行噪声用「归一文本不变」为不变式机械还原，剩余 hunk 与语义混在一块的如实披露、留到提交时拆两个 commit（本批零提交）。

21. **持久化 L2 额度账本，让「重启」不再等于「额度清零」**（2026-11-03，本批）。根因：`scene/l2-admission.ts` 的 `runTimestamps` 是进程内模块级数组，重启即清零——生产同一小时里重启 3 次就等于把 12 次/小时的上限变成 36 次（实测 23:22:14 重启后 `boot recovery re-armed 293 session(s)` 立刻吃满首个窗口）。改为**只持久化真实运行时间戳**（`{version:1, runTimestamps:[ms]}`，原子写 `.<pid>.tmp` + rename，路径 `TDAI_L2_ADMISSION_FILE` > `$TDAI_DATA_DIR/l2-admission.json`），`inFlight`/`roundAdmitted` 不落盘（进程死掉 inFlight 恒 0，但窗口内已耗额度必须保留）。门关（两 limit 都 ≤0）时**一次磁盘调用都不发生**，行为逐位等于今天；解析失败只 WARN 并当首部署（绝不抛，不能因为一个读不懂的账本文件把召回卡死）。**否决**了「把账本写进 vectors.db」：那是业务库，额度是运维面数据，混在一起会让备份/迁移互相牵连。
22. **L2 两套账本合并为一套，退避口径收敛到 `planL2RetryAtMs`**（2026-11-03，本批）。生产里 `createStatefulPipelineManager` 不含 `l2Gate`、也从不 start（`tdai-core.ts` 用已 resolve 的 promise 顶掉 start），manager 侧节流长期是**死代码**且已与 worker 漂移（`roundRemaining` 判定条件不同）。处理：不删分支（`createPipelineManager` 仍被 CLI/seed 消费），而是让 manager 与 worker **共用同一份 `l2-admission` 单例**，退避统一由纯函数 `planL2RetryAtMs({decision, nowMs, sessionKey})` 决定：`now+1s` 为基点，轮次耗尽取 `max(基点, roundStartedAt+60s)`，窗口耗尽取 `max(基点, nextSlotAtMs ?? now+60s) + FNV1a(sessionKey)%30s`（抖动必须**可复现**，所以用稳定哈希不用 `Math.random`）。**否决**了「保持两套实现各自修」：同一语义两份代码，下一次一定再漂。**已知残留**：`roundAdmitted` 独占时仍会齐醒（加抖动会破既有「逐轮 60s 步进」契约），要根治需 per-session 轮次退避，另立票。
23. **同一份语义只许有一处缺省**（2026-11-03，本批）。`dedupPrefilter.minCos` 曾有双缺省（`config.ts` 0.9 / `l1-dedup.ts` `DEFAULT_PREFILTER_MIN_COS=0.82`）：只翻 `enabled` 不配 `minCos` 就得到 0.9，门在实测分布里恒空转（可合并对 0.8587–0.9918 全被挡）。改为 `config.ts` 缺省同步 0.82，并用用例把两处钉成同一个数（**不**用 import 拉平：`config.ts` 是被 store 链依赖的轻量解析器，反向 import 会把 sqlite 拖进配置解析）。`atomicMaxChars` 同批从 300 校准到 600（ADR 决定 2 的校准值），生产 override 本就显式 600 故线上读数不变，变的是「只开开关也会拿到正确缺省」。
24. **结论层候选按类型收窄，否则「结论卡可达」是假的**（2026-11-03，本批）。实测：目标卡（`dur_1793607817329_rd33kd`，consolidated/work_fact，6219 字符）对自己主题的 query 在 50 条 FTS 命中里排 #37（`r7HalfLimit*2=16` 的 cap 之外），按 `type='work_fact'` 收窄后 9 条命中里排 #5（进 cap）；「M1 reranker」#45→#6、「reranker 选型」#25→#6。根因是 `buildFtsQuery` 生成 OR 语义（`"里程" OR "里程碑" OR "M1" OR "reranker"`），高频词把 episodic 正文顶到前面。修法：`searchL1Fts(..., {type})` 走独立 prepared statement（`WHERE l1_fts MATCH ? AND type = ? ORDER BY rank ASC LIMIT ?`），**先过滤再 LIMIT**（否则 LIMIT 在前等于没修）；不传 `opts` 时走原语句、逐位不变。**否决**了「把结论卡的 cap 调大」：那是在用 token 买排名，同类挤占换个 query 还会复现。
25. **空池轮也要留观测，指标分母不许静默缩水**（2026-11-03，本批）。`journal` 原先仅在 `injectionObservation` 存在时写 `selection`，于是「三路全空、选线段没跑」的轮什么都不写，`zeroInjectionRate` 的分母只统计「有池子的轮」（生产实测 coverage 仅 18%），指标系统性偏好。改为空池也写零观测 + `selection.emptyPool=true`，并把两种病拆成两个数：`zeroInjectionRate`（分母含空池 = 「用户这轮到底拿到记忆没有」）与 `zeroInjectionRateNonEmpty`（分母只算非空池 = 「召回到了东西时选线是否全砍」）。
26. **场景块的热度是尺度问题，不是阀门问题**（2026-11-03，本批）。生产 14/14 个块 `heat` 恒等于 10：`clampHeat` 的 `Math.min(10, v)` 把 74 这种十进制尺度直接拍平，热度信号退化成常数。改为**十进制逐位折算**（`while (v > 10) v = floor(v/10)`：74→7、100→10、315→3、11→1），保留 `clampHeat` 与 `normalizeHeat` 的分工（后者兼作 `maxBlockBytes` 的非负整数解析器，把上界合进去会把 4096 折成 409）。同批：`## 主张` 段 14/14 全空（渲染/解析未对齐）→ 空段时按「段摘要 → META summary → 最后一条事件」派生 1–3 条并保证 `parse(render(x))` 幂等；同时间戳事件重复 23/190 → 精确规范化键去重之外，同时间戳且 `charBigramDice ≥ 0.6`（生产 40 对标定：真同源改写 ≥0.649、同主题不同事实 ≤0.449）判同源改写、留信息更全长者，输出按时间升序。**否决**了「相似度 0.6 就合并」：决定 20 的「宁可留两条」仍然优先，这里的阈值只用于**同时间戳**这一强约束下的改写去重。
27. **巩固的两类幽灵卡：缩容回收 + 指纹带版本**（2026-11-03，本批）。① `grouping.ts` 分块产生 `#1/#2/#3` 后缀卡，组从 110 条缩到 60 条后旧 `#3` 无人写、`valid_end` 仍空 → 持续注入过期摘要。修法：落卡后对本轮**未参与、仍开区间、序号 ≥ 本轮块数**的同 series 后缀卡调 `invalidateL1`（不 DELETE，零删除红线），`maxPerRun` 保守门截断时整轮不回收（宁可留过期卡也不误伤）。② 源集合指纹（决定 12）不含摘要实现版本，改 prompt / `maxTokens` / 模型都不会重算，已落卡永远停在旧实现上。修法：指纹计入 `CONSOLIDATION_SUMMARY_VERSION` 与 model id；代价是**版本一升 = 存量卡全量重算一轮**（生产 34 张 consolidated 卡 ≈ 34 次 LLM 调用，按单卡 30–90s 摊到多个 tick），升级必须人工确认成本后再 +1。

## 后果

- **好的**：七项都能独立开关、独立回滚；缺省态与旧行为逐位一致，任何一项出问题不会牵连其他项；读数有唯一口径，跨轮可比。
- **代价**：新增两套只读 CLI（`memory:metrics` / `memory:observe`）与对应纯函数层，需长期维护；`atomicMaxChars` 等阈值是“当前生产分布下的最优点”，数据形态变化后需重跑校准。
- **已知风险**：换键后存量旧卡无法命中（会新建卡，卡数短期上涨）；structured 形态对读侧是“兼容而非透明”，legacy 升级只在首次写时发生；A1 门若 `minIntervalHours` 设得过大，可能出现“有 L1 但长时间不跑 L2”的空窗——由 6h 缺省与手动强制口兜底。

## 被否决的方案

- **只做骨架/开关就绪**：任务书明确禁止，且观察窗无法区分“没开”与“开了没用”。
- **全量重抽历史 L1**：动生产数据、不可逆、且与“零删除”红线冲突。
- **A2 直接开 channel 上线**：token 节省与召回增量均未实测，等于用生产做实验。
- **B1 把 862 条反思结论合成一张卡**：看起来“整洁”，实际摧毁按属性检索的能力（任务书点名禁止）。
- **靠调小 minCount/minCos 压住 429 与丢卡**：把资源问题伪装成阈值问题，换键语义会被稀释，且丢卡依旧发生（真正的因是逐条重嵌与 maxTokens 未接线）。