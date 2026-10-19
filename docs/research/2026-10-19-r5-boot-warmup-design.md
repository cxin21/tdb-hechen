# R5 boot 暖机化调研：全量重启首召回 504 尖峰的冷点分析与方案设计

> 调研日期：2026-10-19 ｜ 关联：issue cxin21/tdb-hechen#65 评语（R5 残留）、#61（超时调 8000）、#63（query-expand 黑洞治理）、#64（offline rerank warmup）、ADR-0004
> 性质：只调研 + 设计，不改代码。

---

## 1. 冷点实测分析（代码级：文件+行号+首次成本估计）

### 1.1 复现背景（#65 评语证据）

全量重启（杀四服务 → supervisor 拉起，core 22004 / proxy 34988 / knowledge 9088 / panel 10488）后：

- `[rerank] startup warmup done in 8520ms (scores=1)`（09:28:21）
- 首批 E2E /v3/recall 自 09:29:49 起：**3 发 504 → 第 4 发 4877ms http=200 → 第 5 发 92ms**。
- 关键时序注记：首请求晚于 rerank warmup 完成 **88 秒**——即现有预热已跑完，首召回仍然 504。说明尖峰主体**不是** rerank worker 冷加载（已暖），而是「残余冷点叠加 + 连发放大」（见 1.4）。
- core-only 单服务重启（同代码第四轮 E2E）cold=3849ms http=200 PASS，不出现尖峰。

### 1.2 boot 时序（MemoryCore/src/gateway/server.ts `start()`）

```
start()
 ├─ resolveApiKey / initDataDirectories / metadata 校验
 ├─ await ensureMetadataStorePool()        (server.ts:618)   ← metadata 池启动即建，暖
 ├─ initObservabilityBackend / initOTelSDK（失败非致命）
 ├─ await core.initialize()                (server.ts:705)
 │    └─ this.storeReady = this.initStores()   (tdai-core.ts:249)  ← fire-and-forget，不 await
 │         └─ pipeline-factory.initStores → vectorStore.init（sqlite-vec 扩展 + schema + FTS 建表）
 ├─ startIntegratedServices()（service 模式注入 COS；standalone 走 LocalStorageBackend 兜底）
 ├─ ensureSkillModuleWired()
 ├─ http.createServer + listen             (server.ts:794-802)
 ├─ startEmbeddingProbe()                  (server.ts:805)   ← 启动即 embed 探针一次
 └─ startRerankWarmup()                    (server.ts:807)   ← 仅 provider=local 生效
```

`/health`（GET，server.ts:1399 → handleHealth :1745-1765）：恒 200，status=ok/degraded 按 `core.getVectorStore()` 有无（storeReady 未完成期=degraded），含 version/uptime/stores/services/memory。**无 warmup 状态段**。

### 1.3 冷点清单（逐个：冷在哪、第一发付多少）

| # | 冷点 | 位置 | 触发时机 | 第一发成本估计 |
|---|------|------|----------|----------------|
| C1 | **jieba FTS 字典** | `getJieba()` sqlite.ts:251-263 模块级懒单例；查询侧 `buildFtsQuery` sqlite.ts:297、索引侧 `tokenizeForFts` sqlite.ts:352-365 | boot 不触发（initSchema 仅建表；migrateFtsSchema sqlite.ts:5840 仅版本漂移才 rebuild）。首次 /v3/recall 在 L2 结论收集（auto-recall.ts:681 `parseFtsTokens(buildFtsQuery(...))`）与 L1 FTS 查询时撞上 | 同步 `require("@node-rs/jieba")` + `require("@node-rs/jieba/dict")` + `Jieba.withDict`，native 加载+词典解析 **~50-100ms**（阻塞事件循环） |
| C2 | **query-expand / ark LLM 冷链** | `resolveQueryExpansionRunner` query-expand.ts:271-301：模块级惰性 `expansionRunnerState`，首次动态 `import llm-runner.js / llm-provider-resolver.js`（:282-283）+ `new StandaloneLLMRunner`；随后 `expandQuery` 首次真实 LLM 外呼 | 首次 /v3/recall 的 keyword 路（auto-recall.ts:1657）与 hybrid-fallback 路（:1716 `await awaitExpansionTerms()`）；LLM origin 的 undici keepalive 连接池为进程私有，重启即冷 | 动态 import + 构造 ~10-50ms；**LLM RTT 实测 2.2-2.4s**（#63 journal 实锤）。#63 治理后热路等待帽 `hotPathTimeoutMs=1500`（config.ts:1661；auto-recall.ts:1648-1652 raceWithTimeoutCap）帽内未回则本轮无扩展词，**但 LLM 请求照发**（迟到结果写 TTL/负缓存） |
| C3 | ark embedding origin | `startEmbeddingProbe` server.ts:837-845，listen 后启动即 `emb.embed(探针词)`（:867） | **已预热 ✓**（DNS/TLS 首连已付）；探针 5min 周期 | 0（已暖） |
| C4 | **rerank 真实档位批量推理**（provider=local，部署环境已启用） | worker spawn + 模型加载 3-5s 由 `startRerankWarmup`（server.ts:817-831）预热 ✓；但 warmup 仅 **1 query × 1 doc**（:825 dummy），真实召回 candidates 缺省 **12**（config.ts:1763） | 首次真实 /v3/recall 精排段 | worker 已暖；**首批 12-doc 批量 CPU 推理冷**（bge-reranker-base，transformers.js 首 batch：tokenize + ORT session 暖机），云主机量级 **数百 ms ~ 数秒**（#65 实测 warmup 本身 8520ms 含模型加载，说明该环境 CPU 慢） |
| C5 | **store 就绪窗口** | `storeReady = initStores()` fire-and-forget（tdai-core.ts:249）；`deps.getStore() = core.getVectorStore()`（server.ts:1222-1224）；未就绪 → v2-router.ts:1884 **503 "Store not available"** | boot 后 ~1s 内到达的请求 | SQLite 路 initStores 通常 <1s；窗口小但存在，产生的是 503 而非慢（与 504 尖峰无直接叠加，属附带冷点） |
| C6 | soul 渲染冷缓存 | `soulPrefixCache` 进程内存态（soul-assembler.ts:282，读 :378 写 :912-939），重启必冷；锚预嵌 `embedAnchorCached`（MMR selectAnchorRowsMmr，软预算 1200ms 并行，ADR-0004 决策 #2/#3） | 首次带 soul 渲染的 recall | ADR-0004 治理后 **~百 ms 级**（soul 段 12s→20ms 的历史已修；锚预嵌 origin 已被 C3 探针暖） |
| C7 | **504 哨兵放大器** | v2-router.ts:1918-1946：`Promise.race([performLayeredRecall, timeout sentinel])`，`timeoutMs = v3Recall.timeoutMs ?? 5000`（:1919），sentinel 胜出 → `errorEnvelope(504, ...)`（:1945）。**race 输后底层召回不 abort，继续后台跑完** | 连发探测时，3 个冷召回并发互耗（LLM×3 并发、embed×3、rerank×3、SQLite 争抢） | 把 ~5s 的单发冷成本拉长为 **~15s 的饱和窗口**——与「3 发连续 504 后自愈」的观测形态吻合 |

### 1.4 根因综合（与 #65 评语因果的校正）

#65 评语把尖峰归因「jieba 冷字典 + reranker 首批真实推理 + ark 冷连接叠加」。代码级复核后：

1. **rerank worker 冷加载已被现有 warmup 覆盖**（#65 时序 warmup done 早于首请求 88s），残余的是 **12-doc 真实档位批量推理**（C4）——warmup 只热了 1 doc。
2. **ark 冷连接中 embedding origin 已被探针预热**（C3 ✓），真正没暖的是 **LLM origin + query-expand runner 动态 import 链**（C2），首发展开词外呼 2.2-2.4s（热路帽内只等 1500ms，不致命但首批真实推理预算被吃掉一半）。
3. jieba（C1）单发 ~50-100ms，量级最小但真实存在。
4. 四项叠加 + 首批 soul 冷渲染（C6）+ **非 abort race 的连发放大**（C7）→ 单发总冷成本顶穿预算，连发期间互相挤压持续超时。
5. **core-only 重启不出现的解释**（复合因素，诚实标注为推断）：a) proxy/knowledge 未重启，首请求到达更晚、更稀疏；b) 无四服务同启的 CPU/IO 争抢；c) core-only 场景的 E2E 在 warmup 完成后才发首请求（#61 口径 cold=3849ms 本身已含部分冷点）。全量重启时首请求提前 + 资源争抢 → 冷点全额暴露。**第 1 发冷成本的精确分布需 E2E 分段日志（meta.perfMs）定量**，这也是验收证据的一部分。

---

## 2. 现有预热盘点（startRerankWarmup 覆盖/未覆盖）

### 2.1 startRerankWarmup（server.ts:817-831）

- **实现**：`enabled && provider === "local"` 才动（:819）；fire-and-forget IIFE：`createReranker(rc, {dataDir})` → `reranker.rerank("[warmup] 部署后首次召回预热", [1 条 dummy 文档])`（:825）→ 成功打 `[rerank] startup warmup done in Xms (scores=N)`（:826），失败仅 warn 非致命（:828）。
- **调用点**：listen 之后（:807），不阻塞。
- **共池正确性 ✓**：走 `getSharedLocalReranker`（rerank/local.ts:360-367，进程级 `sharedPool` Map，key=path.resolve(modelDir)），与 recall 同一单例——预热加载的 worker 就是首召回用的 worker。
- **注释已记录痛点**（server.ts:810-816）：#64 的 offline warmup 脚本只热「模型文件+独立进程实例」，救不了「新进程首召回」。

### 2.2 覆盖 / 未覆盖

| 项 | 状态 |
|----|------|
| worker spawn + 模型加载（3-5s / #65 实测 8.5s） | ✅ 覆盖 |
| 单条推理全链（tokenize→score） | ✅ 覆盖（1 doc） |
| **真实档位批量推理**（candidates=12，config.ts:1763） | ❌ 未覆盖——warmup 1 doc vs 真实 12 doc，首批批量推理仍冷 |
| cloud rerank provider（siliconflow/dashscope） | ❌ 零预热（:819 非 local 直接 return）——HTTP origin/路由冷 |
| 模型未下载场景 | ⚠️ warmup 触发 fire-and-forget 下载后本次返回 null（local.ts:125-127），下载完成后的冷载未被预热（可接受，下载本身是显式运维动作） |
| jieba 字典（C1） | ❌ 未覆盖 |
| query-expand runner + ark LLM origin（C2） | ❌ 未覆盖 |
| soul 渲染链（C6） | ❌ 未覆盖（量级小，见 3.2 S4 裁决） |
| store 就绪窗口（C5） | ❌ 未管理（503 窗口无界等待感知） |
| embedding origin（C3） | ✅ 已由 startEmbeddingProbe 覆盖（不同函数，但同属 boot 预热族） |

---

## 3. 最优方案

### 3.1 设计原则（硬约束映射）

1. **不阻塞 /health**：一切预热 fire-and-forget；唯一例外 S0（<150ms 的同步字典加载，发生在 listen 前，/health 本来就不存在，不构成「降低可用性」）。
2. **非致命合同**：任何预热失败只 `warn`，服务照常起，行为=现状（降级即现状本身）。
3. **与生产同路径预热**：必须走与 recall 完全相同的函数与单例（`getSharedLocalReranker`、`resolveQueryExpansionRunner`、`buildFtsQuery`），防「预热了一副冷路径」。
4. **观测先行**：每步计时日志 + /health warmup 段，验收以日志与 perfMs 为准。

### 3.2 暖机步骤清单（`startBootWarmup()`，server.ts）

| 步 | 内容 | 时机 | 预期成本 | 失败处理 |
|----|------|------|----------|----------|
| **S0** | **jieba 直载**：调用已导出的 `tokenizeForFts("R5 预热查询样本")`（sqlite.ts:352）触发 `getJieba()` 字典加载 | **listen 前**（同步，确定性） | ~50-100ms | try/catch，失败 warn（回退 Unicode-regex 切分语义本就存在，sqlite.ts:251-263） |
| **S1** | **store 就绪有界等待**：`await` storeReady（需在 server/tdai-core 透出一个 `storeReady` promise 访问器，如 `core.waitForStores(timeoutMs)`），上限 5s | listen 后、S2 前 | SQLite 路 <1s 等待 | 超时降级（不再等），503 窗口从「无界」变「有界」 |
| **S2** | **query-expand / ark LLM 预热**：`resolveQueryExpansionRunner(cfg.llm, instanceId, logger)`（query-expand.ts:271）+ 一次极小真实 `expandQuery("[warmup] 查询扩展预热", runner, { maxTerms: 1, timeoutMs: 10_000 })`——付动态 import + runner 构造 + ark LLM origin DNS/TLS 首连 + 首个 LLM 往返 | listen 后，S1 完成即跑（fire-and-forget） | ~2.2-2.4s（后台） | **1 次尝试、无重试**（recall 侧已有负缓存 30s + 热路帽 + 降级链，预热失败只是把现状延后一次）；warn 非致命。成本：每 boot 1 次 LLM 调用（可忽略） |
| **S3** | **rerank 真实档位预热**（改造现有 startRerankWarmup）：a) doc 数 1 → `candidates` 档（读 cfg.recall.rerank.candidates，缺省 12），文档用真实长度的中文样本文本（50-200 字/条）；b) **兼容 cloud provider**：非 local 时改为 1 query × 1 doc dummy rerank 一次（暖 HTTP origin + 鉴权路由），失败 warn | listen 后（与 S2 并行或紧随） | local：批量推理 ~数百 ms-数秒（后台）；cloud：一次 HTTP RTT | 复用 reranker 内部超时（loadTimeoutMs/inferTimeoutMs，local.ts:47-58）；失败 warn 非致命（现状合同） |
| **S4** | soul 渲染链 | **不做**（裁决记录：渲染依赖真实 profile/mood/state，无低成本无副作用预热；量级 ~百 ms 级且 ADR-0004 已治理；若 E2E 后首发送仍逼近预算再单列） | — | — |

执行顺序裁决：S0（listen 前）→ listen → S1 → S2 → S3 **串行**（Node 单线程；S3 是 CPU 密集，若与 S2 并行会在 LLM 等待期挤占事件循环，串行使日志分段清晰、总量差 <1s）。总后台时长 ~ LLM 2.4s + rerank 3-8s ≈ **10s 内完成**，远短于 #65 观测中首请求到达时刻（listen 后 ~90s）。

### 3.3 readiness 门控取舍

**结论：不加硬门控（不 gate /health / listen）。**

- 部署形态是 supervisor（`MemoryCore/hermes-plugin/memory/memory_tencentdb/supervisor.py`）拉起四服务，**没有 readiness probe 消费方**；K8s 三分法中 readiness 的价值是「失败摘流量不重启」（kubernetes.io 文档语义），无消费方时硬门只把首请求从「撞冷点 5s」变成「撞 503/拒连」，用户侧无改善。
- 硬约束「不降 /health 可用性」：/health 保持恒 200。
- 504 哨兵本身已是优雅降级设计（空上下文、不落坏数据）；暖机化把冷成本移出首请求后，哨兵退回纯兜底角色。
- **但增强 /health 观测**：payload 增 `warmup` 段——
  ```jsonc
  "warmup": {
    "status": "warming" | "done" | "failed",   // 任一步失败 → failed（但服务照常）
    "steps": { "jiebaMs": 62, "storeReadyMs": 340, "queryExpandMs": 2413, "rerankMs": 5120 },
    "totalMs": 7900
  }
  ```
  只加字段不改旧字段（旧消费方零影响）。supervisor/E2E/人可读。若未来接入 K8s/Nomad 等消费方，再评估独立 `/readyz`（storeReady + warmup done 才 200）——本期只列选项不实现。

### 3.4 观测

- 启动分段计时日志（新）：`[warmup] jieba done in Xms`、`[warmup] store ready in Xms`、`[warmup] query-expand done in Xms`、扩展既有 `[rerank] startup warmup done in Xms (scores=N, docs=12)`、汇总 `[warmup] boot warmup total=Xms (status=done)`。
- 运行期沿用 `[recall-perf]` + 响应 `meta.perfMs={scene,l2,l1,soul}`（#61 口径，yaml:174-175）——E2E 断言与冷成本分布定量的证据源。
- /health warmup 段（3.3）。

### 3.5 对重启 SOP（supervisor 四服务拉起）的影响

- supervisor.py **零改动**：/health 仍恒 200、拉起顺序与 restartsUsed 预算不变。
- 行为变化仅两条：boot 后 ~10s 内 core 多 1 次 LLM 调用 + 1 次 12-doc 批量 rerank（后台）；四服务同启的 CPU 争抢窗口从「首请求时刻」前移到「boot 时刻」并被预热提前消化。
- 部署环境 config-override（rerank provider=local）下每次重启多 ~2-6s 后台 CPU——可接受；若观测到与 knowledge 首启争抢，S2/S3 可错峰（先 S3 后 S2），日志可判。

---

## 4. 落地路径

### 4.1 动哪些文件

| 文件 | 改动 |
|------|------|
| `MemoryCore/src/gateway/server.ts` | ① 新增 `startBootWarmup()`（S0-S3 编排 + 分段计时日志 + warmup 状态机）；② `start()` 中 S0 前置到 listen 前、S1-S3 替换/收编现有 `startRerankWarmup` 调用点（:805-807）；③ `handleHealth`（:1745-1765）payload 增 `warmup` 段 + HealthResponse 类型扩展；④ startRerankWarmup 档位改造（1 doc → candidates 档 + cloud provider dummy） |
| `MemoryCore/src/core/tdai-core.ts` | 透出 `storeReady` promise 访问器（如 `waitForStores(timeoutMs): Promise<boolean>`），供 S1 有界等待（initialize :244-290 处已持有 promise，纯透出） |
| `MemoryCore/src/core/store/sqlite.ts` | **无需改**（`tokenizeForFts` :352 已导出，S0 直接 import 调用；可选一行包装 `preloadJieba()` 提升语义显式性） |
| `MemoryCore/src/core/recall/query-expand.ts` | **无需改**（`resolveQueryExpansionRunner` :271 / `expandQuery` 已导出；预热查询写缓存 keyed by query，只命中自身，无污染） |
| 测试 | ① 单测：warmup 幂等（仅 boot 调用一次）、逐步失败注入（mock LLM/rerank 抛错 → status=failed、服务照常、/health 仍 200）、jieba 预载后 `buildFtsQuery` 无二次加载（用现有 reset sqlite.ts:368）；② E2E 脚本见 4.2 |

### 4.2 E2E 验证设计：「全量重启后第 1 发 < 预算」

**前置**（部署环境或本地全四服务，config-override 使冷点真实存在）：`v3Recall.enabled=true`、`recall.rerank.enabled=true provider=local`、`recall.queryExpansion.enabled=true`、`llm.baseUrl=`真实网关（否则 S2 预热退化为 no-op，测的是假冷启动）。

**步骤**：

1. 复刻 #65 SOP 全量重启：杀四进程 → supervisor 拉起四服务。
2. 轮询 core `/health` 至 200（现状 ~35s 拉齐），记录 `warmup.status` 变化（warming→done）。
3. `warmup.status=done` 后**立即**（10s 内）以固定真实 query 连发 `/v3/recall` ×5（间隔 500ms，模拟连发探测），记录每发 http code + 墙钟耗时。
4. **断言**：
   - 第 1 发 `http=200` 且耗时 `< v3Recall.timeoutMs`（生产 8000ms / 本地缺省 5000ms）；
   - 第 2-5 发全部 200，第 5 发 < 1s；全程无 504；
   - core log 五段 `[warmup]` 计时齐全且 total < 15s；
   - 第 1 发响应含 `meta.perfMs` 四段 + journal `[recall-perf]`（供冷成本分布定量）。
5. **对照实验**：a) 改动前同流程重跑（预期复现 3×504，证明归因）；b) core-only 单服务重启（预期不劣于现状 #61 口径 cold≈3849ms，回归验证）；c) **失败注入**：llm.baseUrl 指向不可达地址重启——断言服务照常起、/health 恒 200、`warmup.status=failed`（queryExpand 步）、首召回行为=现状（无扩展词、热路帽生效），证明非致命合同。
6. 证据归档：连发表格 + core log warmup 段文本 + 第 1 发 perfMs，贴回 issue。

**判定口径**：硬标准 = 第 1 发 200 且 < 预算；软标准 = 第 1 发 perfMs.l1 中 expand 段 ≈ 0（扩展词预热生效的旁证）。

---

## 5. GitHub 票面草稿

**标题**：`R5: core 启动暖机化——jieba 预载 + rerank 真实档位预热 + query-expand/ark 预连，消除全量重启首召回 504 尖峰`

**Labels**：`ready-for-agent` + `research`（或 `task`，按 triage 流程）

**正文**：

> ### 背景
> #65 评语记录：全量重启（四服务同杀）后首批 /v3/recall 一次性暖机尖峰——实测 3 发 504 → 第 4 发 4877ms 200 → 第 5 发 92ms；core-only 单服务重启不出现。504 = v2-router 超时哨兵（v2-router.ts:1918-1946，race 输后底层召回不 abort，连发放大）。
> 调研（docs/research/2026-10-19-r5-boot-warmup-design.md）复核根因：现有 startRerankWarmup 只热 1 doc（真实召回 12 doc，config.ts:1763）；embedding origin 已被探针预热；未预热的是 jieba 字典（sqlite.ts:251-263）、query-expand runner+LLM origin（query-expand.ts:271-301，LLM RTT 2.2-2.4s）、首批批量 rerank 推理；#65 时序证明 rerank worker 加载已暖（warmup done 早于首请求 88s 仍 504）。
>
> ### 方案（startBootWarmup）
> - S0 jieba 直载：listen 前调 `tokenizeForFts`（~50-100ms，同步）；
> - S1 store 就绪有界等待（≤5s，消 503 无界窗口）；
> - S2 query-expand 预热：resolveQueryExpansionRunner + 1 次极小真实 LLM 调用（动态 import + ark origin 首连移出关键路径；1 次尝试无重试，失败 warn）；
> - S3 rerank 真实档位预热：doc 1 → candidates 档（12），兼容 cloud provider（dummy 1×1）；
> - S4 soul 链：不做（量级小，见调研 §3.2 裁决）；
> - /health 增 `warmup` 段（warming/done/failed + 每步耗时），不 gate；
> - 非致命合同：任一步失败 → 服务照常起，行为=现状。
>
> ### 验收标准
> - [ ] 全量重启（#65 SOP）后第 1 发 /v3/recall（真实 query）http=200 且 < v3Recall.timeoutMs（生产 8000 / 本地 5000），连发 ×5 无 504；
> - [ ] core 启动日志含 [warmup] 分段计时（jieba/storeReady/queryExpand/rerank）与 total；
> - [ ] /health 含 warmup 段且全程恒 200（旧字段不变）；
> - [ ] 失败注入（LLM 网关不可达）：服务照常起、warmup=failed、首召回行为=现状；
> - [ ] rerank warmup 使用 candidates 档文档；cloud provider 也有 dummy 预热；
> - [ ] core-only 重启回归不劣于现状（#61 口径）；
> - [ ] 门禁 MemoryCore / MemoryProxy 全绿。
>
> ### 证据要求
> - 改动前后同 SOP 全量重启的 E2E 连发记录（http code + 耗时表）；
> - core log [warmup] 分段计时全文；
> - 第 1 发响应 meta.perfMs + journal [recall-perf]；
> - 失败注入实验记录。
>
> ### 不做（明确出票理由）
> - readiness 硬门控（supervisor 场景无 probe 消费方 + 不降 /health 硬约束）；
> - 504 race 改 abort（迟到结果写缓存有正向价值，单列讨论）；
> - soul 链预热（S4）。

---

## 6. 工作量与风险

### 6.1 工作量

| 项 | 估计 |
|----|------|
| core 改动（server.ts warmup 编排 + health 字段 + rerank 档位 + tdai-core storeReady 透出） | 0.5-1 天 |
| 单测 + E2E 脚本 + 部署环境实测（含对照与失败注入） | 0.5 天 |
| **合计** | **1-1.5 天** |

### 6.2 风险

| 风险 | 评估与缓解 |
|------|------------|
| 每 boot 多 1 次 LLM 调用 + boot 后 CPU 尖峰（后台） | 成本可忽略；四服务同启争抢可能延长 warmup total——total 日志可观测，必要时 S2/S3 错峰 |
| 预热查询污染 expansionCache / 负缓存 | 缓存 keyed by query（query-expand.ts:112,144,172），只命中预热词自身，对真实查询零影响 |
| 预热失败让服务起不来 | 合同禁止：全部 try/catch + fire-and-forget，失败仅 warn + status=failed（失败注入 E2E 证明） |
| /health 字段兼容性 | 只加不改，旧消费方零影响 |
| 预热了「另一副路径」 | 已用同路径原则规避：共池 reranker、同 runner、同 tokenizeForFts（§3.1 原则 3） |
| 残余冷点（soul 首渲染 ~百 ms 级）未预热 | E2E 第 1 发 perfMs 定量；若逼近预算再单列 S4 或 504 race abort 语义变更（本期不做） |
| cloud yaml rerank 实际未启用时 S3 为空转 | warmup 尊重 config 门（同现状 :819），enabled=false 时仅 S0/S1/S2 生效，无副作用 |
