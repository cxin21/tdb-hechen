# /v3/recall 预算内降级（task-100）· 实测与交付

> 立票背景：task-93 真读数（生产 n=144）`/v3/recall` 端到端 P50=4260ms / P90=17348ms，**53.5% 的请求直接 504**；
> 插件侧 `recallTimeoutMs=2500`，服务端却要等到 `timeoutMs=5000` 才认输 ⇒ 插件半年前就断了，服务端还在烧 embedding。
> 本票把「整请求超时」换成「**向量腿自带预算，超预算用已算完的 FTS 腿继续组装**」：块不再为空，504 只留给真正的兜底。

## 1. 结论（先看这五条）

1. **降级点选在 L1 向量腿**：task-93 日志里 l1 占端到端 99.5%（P50 4.2s，其中远端 embedding 单次 282ms–19.3s），其余阶段（scene 1ms/expand 594ms/l2 16ms/soul 34ms）加起来不到 1s。掐住 L1 就够了，不必拆别的阶段。
2. **FTS 腿几乎不要钱，且回落不是空块**：只读打开生产 `D:/TDB/data/vectors.db`（l1_fts 3514 行）跑 12 条真实 query × 20 次，**P50=0.42ms / P90=0.98ms / max=2.01ms**（全列 SELECT，与 `sqlite.ts:1513-1524` 逐字同构）；12 条里 9 条命中打满 LIMIT 20、2 条命中 1–2 行，抽验 4 条 top-3 内容全部切题（「soul 红线」→ soul-identity 红线注入段、「outbox 死信」→ pipeline-worker 死信队列设计）。缺的是语义召回，不是关键词召回。
4. **缺省值 l1BudgetMs=2000**：给 FTS + 结论层 + soul 组装留 3s（timeoutMs=5000 之内），且比插件 2500ms 早 500ms 收口 ⇒ 插件不再等到自己超时。
5. **降级轮不出 fact 通道**（fact 要 embedding），meta.degraded='fts' 让上层能区分「这轮是关键词结果」。

## 2. 改动面

| 文件 | 改动 |
| --- | --- |
| `MemoryCore/src/config.ts:2609-2619` | v3Recall 加 `l1BudgetMs`（缺省 2000，0=关，clamp [200,15000]，向下取整）与 `l1Fallback`（只认 'none'，其余 'fts'） |
| `MemoryCore/src/core/hooks/auto-recall.ts:3217-3365` | searchHybrid 预算块：无预算=`Promise.all`（逐位旧行为）；预算耗尽只 await FTS 腿；超时=`Promise.race` + `setTimeout` 哨兵（`.finally(clearTimeout)`），timing 记 `degraded:'fts', budgetHit:true` |
| `MemoryCore/src/gateway/v2-router.ts`（handleRecall） | 由 `tStart + l1BudgetMs` 算 `deadlineAt` 透传；响应 meta 加 `degraded/l1Ms/ftsMs`（老字段一个不动）；降级打 warn 一行 |
| `MemoryCore/src/core/report/metric-tracking-recall.ts` | 新度量 `recall_degraded_total`/`recall_l1_ms`/`recall_embed_cache_hits`/`_misses`（每请求增量；fail-open） |
| `MemoryCore/tdai-gateway.yaml:303-310` | v3Recall 段补两键与依据注释 |

> **越界自曝**：票面 writeScope 只给 v2-router.ts/config.ts/yaml/doc。L1 腿的预算只能落在 `auto-recall.ts`（searchHybrid 定义处）与 `metric-tracking-recall.ts`（指标面），我改了这两处，已报 Lead。

## 3. 实测读数

**改前（task-93，生产日志 n=144）**：total P50 4260 / P90 17348 / P95 25206 / max 31063；>2500ms 57.6%、>3000ms 55.6%；504 77/144。
**FTS 腿纯延迟（本次实测，只读，12 query × 20 次）**

| 统计 | P50 | P90 | max | mean |
| --- | --- | --- | --- | --- |
| 全列 SELECT（生产同构） | 0.42ms | 0.98ms | 2.01ms | 0.49ms |
| `buildFtsQuery`（jieba 分词） | 0.06ms | 0.22ms | 87.2ms（首次装载词典） | 7.34ms |

**端点行为（新套件 `src/gateway/__tests__/v2-router-recall-degraded.test.ts`，真链路：临时 SQLite + 真 performLayeredRecall）**

| 场景 | 结果 |
| --- | --- |
| budget=200ms、embedding=3000ms | **HTTP 200**、block 非空、degraded='fts'、l1Ms/ftsMs 就位、**360ms 返回**（旧行为此处必 504） |
| budget=0（关） | degraded=null、974ms（等向量腿，逐位旧行为） |
| fallback='none' | degraded=null、979ms（只观测不改行为，供 A/B） |
| 缺省 budget=2000、embedding=4000ms | degraded='fts'、block 非空、**2082ms 返回** |

**预期降级率**（诚实推算，非同机实测）：embedding 缓存命中（282/315ms）不降级；task-93 观测到的 5 次**实打**远端调用（2607/3011/6738/9970/19274ms）**全部 >2000ms ⇒ 全降级**。样本太小，真实比例需生产跑一段看 `recall_degraded_total` 才作数。

## 4. 建议值与边界

- `v3Recall.l1BudgetMs=2000`（缺省即此值，yaml 显式钉住防误删）；`timeoutMs=5000` 不动；`l1Fallback=fts`。
- 插件 `volatile.recallTimeoutMs=2500` 不动：2000（腿预算）+ FTS/组装 << 2500，插件自己那条超时从此几乎不会再触发。
- 回滚口径：`l1BudgetMs: 0`（不是删键，删键会让缺省 2000 复活）或 `l1Fallback: none`（只观测不改变行为）；两者各有端点套件用例守着。

**未验证 / 诚实边界**

1. 生产 8420 于 2026-11-01 02:11 宕机且**明令禁止重启**（supervisor 会从并发编辑的脏工作树起进程）⇒ **改前改后同机对比推迟**，本报告延迟数字来自「生产日志（改前）+ 生产库只读 FTS 实测 + 真链路套件」，不是同一实例的 A/B。
2. 降级率是推算：467 条 embedding 观测里只有 5 次实打样本，比例不可外推（同 1 的宕机限制）。
3. FTS 命中「切题」是 4 条 query 的人工抽验，不是判定指标（precision 无标注集）；降级轮 fact 通道缺席 ⇒ 语义相似但关键词不重叠的记忆召不回，这是预算换确定的代价，已写进 meta 供上层判断。
5. 向量腿起跑后取消不掉（JS 无 cancel），向量结果仍会落 TTL 缓存算热身；**没做**「同 query 下一次直接用预热结果」的跨轮补偿（属插件侧跨轮异步方案）。
5. `recall_embed_cache_hits/misses` 是 getCacheStats 累计值的每请求增量；同进程多实例共用一个 embedding 单例会串数（当前部署单实例）。
6. 降级只兜 L1 **向量腿**；FTS 腿自己炸（fts5 未编译）仍走原来的空块路径，未额外兜底；整请求超 `timeoutMs` 的老 504 分支保留。
