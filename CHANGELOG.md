# Changelog

本文件记录 **TencentDB Agent Memory** 的显著变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/)。

覆盖仓库全部开源模块：`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。

---

## [Unreleased] — 2026-09-09

### 💗 P3 情感维度激活（GROW-EVO Phase 3，2026-09-15）

- **arousal 遗忘调制（§3.1 闪光灯记忆）**：`effectiveλ = λ×(1-k×arousal)`——高唤醒记忆
  衰减更慢。`memory.lifecycle.forgetting.arousalRetention` 缺省 0 = 逐位现状；生产显式 0.3；
  config 解析层 clamp [0, 0.9]。**归档率漂移观察条款**：`forgetting ran: archiveCandidates=N`
  为观察点，漂移超基线 ±30% → k 回 0 重评（significance 与 arousal LLM 打分正相关，
  乘法公式有情感记忆囤积双重加成风险）。
- **R10 emotionSalience 实验轨（§3.2）**：`|valence|×arousal` 纯函数
  （`emotionSalienceOf`，recall-signals.ts）+ 双链平局接线（工具侧 secondaryOf 五元组 +
  钩子侧 compareLex 项）。`memory.recall.emotionSalienceWeight` 缺省 0 = 可证恒等
  （全 0 项比较）；进预注册 A/B 队列，未过 A/B 不得置正——判官/抽取器同源偏差，
  永不单独放行排序变更。
- **债务清偿**：yaml inferredPenalty 注释修正（三刀后实为平局组内旗标）；valence 同名
  异义已于 P1 口径对照表覆盖。
- **升级须知**：`ForgettingConfig.arousalRetention` / `RankSignals.emotionSalienceWeight`
  / `RecallConfig.emotionSalienceWeight` 新增（缺省值 = 逐位现状）；RankSignals 构造点
  需补字段（DEFAULT/ZERO 已带）。

### 🔄 P2 失效语义闭环（GROW-EVO Phase 2，2026-09-15）

- **写入三口**：① dedup conflict 自动失效（方向性守卫：仅新记忆 observed 才失效旧记忆，
  inferred 只记边——`invalidateL1` 新 store 方法，不覆盖已失效行）；② durative 效期提取
  （prompt 第 6 条判定 + `memory.extraction.durativeEnabled` 缺省 false、生产显式 true——
  持续状态写 valid_start，valid_end 提取侧永不写）；③ `/v3/atomic/update` 显式失效
  （raw body valid_end，ISO 校验，upsertL1 之后写防 soul 回写清除）。
- **读侧排除**：`filterInvalidated` 纯函数 + `memory.recall.excludeInvalidated`（缺省 true，
  spec 拍板①——现存库无失效行 = 逐位不变）三消费点（工具路两裁剪点 + 钩子路 hybrid tail，
  失效记忆连 recall_count 都不积累）；解析失败保留（宁缺毋滥）。
- **API**：`/v3/atomic/search` 的 `time_start/end` schema 死参数激活（显式时间窗，occurred_at
  语义）；`timeWindow:"auto"` 与显式窗共存（无显式参数回落 auto）。
- **Lane 2 转绿**：update 探针判据改为"old 被失效排除、new 在列"（P1 known-FAIL 基线闭环）；
  新增 invalidationExclusion 不变量（预失效噪声记录必须被排除）。
- **升级须知**：`ExtractionConfig.durativeEnabled` / `RecallConfig.excludeInvalidated` 新增
  （缺省值 = 逐位现状）；`invalidateL1` 为 IMemoryStore 可选方法（旧后端安静跳过）；
  `/v3/recall` time_point 时间旅行推迟至 P2.1（三层管道成本，失效数据已可经 atomic/query
  时间窗查询）——相对 A/B 与判官软轨不受影响。

### 🧪 P1 验收底座 + 口径还债（GROW-EVO Phase 1，2026-09-15）

- **背景**：DS-MEMORY-EVO-001 v3——本地 golden 语料丢失，人工标注退出；验收转为三信号分层
  （构造式真值 + 不变量断言硬门，LLM 判官软参考轨）。
- **Lane 2 能力道上线**：`scripts/eval-capabilities-fixture.mjs`（hermetic fixture 36 条×双主题包
  可轮换，BM25-only 确定性）+ `scripts/eval-capabilities.mjs`（临时网关 8423，四能力探针：
  时间推理/多会话/知识更新 known-FAIL 基线/弃答（域外零交集 query 实测选型 + ABSTAIN_FLOOR=0.5）
  + 不变量（确定性双跑/租户封闭）），归档 `docs/superpowers/evals/capabilities/`（runs 不入库）。
- **口径还债**：① `handleAtomicQuery` legacy fallback 时间过滤对齐 occurred_at（快慢路统一，
  soul 列 cast 访问）；② `bumpRecallCount` 增 `touchUpdatedTime` 选项（缺省 true = 逐位现状），
  auto-recall 钩子路补 recall_count 计数（top-3 observed，只加计数不刷 updated_time——R8 复开
  数据前提成立）；③ 维度口径对照表 `MemoryCore/docs/memory-dimensions-dict.md`（时间三代/
  valence 同名异义/硬编码常数判定）；④ RRF_K=60 协议常数注释化。
- **升级须知**：钩子路 recall_count 开始积累属预期行为变化（遗忘 recallCountBoost 数据源），
  排序语义零变更；重锚纪律——排序代码未变，无需重锚。

### 🧪 三信号 Lane2 能力道评估脚本（P1 Task 2，2026-09-15）

- 新增 `MemoryCore/scripts/eval-capabilities.mjs`：四能力探针（时间推理 / 多会话 / 知识更新 /
  弃答）+ 不变量组（确定性 / 租户封闭），走临时网关 :8423 + hermetic 临时库（BM25-only 确定性道）
  的 `/v3/atomic/search` 生产同构链路；fixture 语料复用 `eval-capabilities-fixture.mjs`
  （multiSession 时间公式改全局唯一日——P1 Task 2 裁定 Minor①，36 条结构不变，Task 1 冒烟复跑通过）。
- 执行顺序：boot 网关建 schema → 停 → seedStore 直写 temp DB（租户三元组注入）→ 再 boot →
  HTTP 探针 → 归档 → 自停；生产 yaml 全程只读，临时 yaml/dataDir os.tmpdir 自清理。
- 基线（runs/2026-09-14T23-47-44.capabilities.json；runs/ 不入库）：time / session /
  determinism / tenantClosure PASS；update known-FAIL（old 0.895 > new 0.843，P1 无失效语义，
  P2 `excludeInvalidated` 目标翻绿）；abstain FAIL 0/5（真实 query top1 P50=0.811 vs 噪声
  query top1 0.890–0.912——brief 弃答探针与 fixture 噪声 query 语义错位：短词面精确命中在
  bm25RankToScore 下恒 ~0.9，P50 相对门结构上不可过，待弃答探针重设计）。
- exit code 契约：全过=0；仅 expectedRed 失败=0（baseline:true）；意外失败=1。
- 临时 yaml 偏离生产（归档 deviations 登记）：结伴生四开关 + queryExpansion（确定性）+
  exploreSlot（recall_count 跨 pass 漂移）关断。

### 🌱 价值锚纯自发现 + 自维护（GROW-MAINT，2026-09-15）

- **拍板**：取消预制种子——价值锚（标签与权重）全部 LLM 自发现 + 自维护，不再灌 `seedValues`/扇出 default 锚。
- **自维护**：每轮 GROW 对 auto 锚（`created_by='auto-growth'`）按**全量语料**重算证据：
  `< minEvidence` → retire（pinned/manual 豁免）；权重 = suggestAnchorWeight(证据, 全量语料条数)，
  |Δw|≥0.05 才落库；标签不原地改写（coreRefs/dedup 身份锚点），主题演化 = 退场 + 新标签再入。
- **证据重算语料口径 v3**：候选证据重算从 50 采样窗改为全量语料（消除"支撑记忆老化出
  recent 窗 → 证据假衰减 → 误退场"）；LLM prompt 仍为 50×200 字预算。
- **冷却分级**：有采纳 intervalHours（24h）/ 0 采纳 1h（`lastAttemptAt`/`lastAdoptedAt` 落
  `anchor_growth_state` kv 四键；存量 `lastDiscoveryAt` 兼容映射为采纳时刻，保守等价旧行为）。
  语料增长期发现节奏跟随语料（最密 1h 一试），锚稳后回到 24h。
- **可观测**：`[anchor-growth] ran:` 汇总行带 adopted/retired/reweighted；per-agent 明细
  （corpus/candidates/retired/reweighted）上 info/debug。
- **配置**：生产 yaml 删 `seedValues`，`anchorDiscovery.minEvidence` 显式 3；存量 default 桶
  6 行 seed **物理删除**（不用 veto——dedup 查全态清单，veto 会"永不重提"误杀同 label 新提案）。
- **升级须知**：老部署无需动作；fork 部署若 default 桶仍有 seed 行，须**先删行再重启**（顺序反了
  会被构造期扇出复制进 agent 桶）。store 接口 get/setAnchorGrowthState 签名扩展（可选字段，向后兼容）。

### 📄 README 重写为 fork 导向（2026-09-14）

- 原上游英文版 README 移至 `docs/upstream/README.en.md`（README_CN.md 保留为原仓库中文文档）；
  新 `README.md` 声明基线（上游 v2.0.1）、四模块职责、fork 增量总表与同步上游协议。
- 对比基线实测（diff -rq，排除 node_modules/运行时配置）：新增 131 文件 / 修改 937 文件 / 删除 0 文件。

### 💰 Credit 上报总开关（creditReport.enabled，2026-09-14）

- **背景**：云端部署 upstream 非 TokenHub，`computeCreditDelta` 恒 0，上报链路只产噪音
  （每轮 CREDIT_REPORT ERROR + usage_raw 失败审计行）且无记账价值。
- **变更**：`CreditReportConfig` 新增 `enabled?: boolean`（config-first；缺省 true = 逐位现状）；
  `tryReportCreditFromPath` 入口在 `enabled === false` 时短路返回 `{attempted:false, ok:false}`，
  不 fetch、不写 usage_raw、不设 `x-credit-report-error`、不打 pipe.error。
- **升级须知**：老配置无该字段 = 行为不变；生产 `/opt/tdai/etc/proxy-config.yaml` 显式
  `enabled: false`。重新启用 = 置 true（或删字段）并把 url 指向可达端点。

### 🔀 合并召回 · 核心单点 /v3/recall + 代理瘦传输（DS-RECALL-MERGE-001，2026-09-12）

- **MemoryCore 新增 `/v3/recall` 端点**：与 auto-recall 钩子共用同一条提取出的组装路径
  `performLayeredRecall`（九通道检索 + R7 分层 + 预算切分 + 幂等结论层 + CAL C1 截断），
  返回 `{ block, meta: { conclusionCount, experienceCount, sessionReused, layered } }`——
  block 与钩子同 query 同会话产出**逐位一致**（同形验证为自动化验收）。请求 = query +
  maxResults? + 会话标识（body `session_id` 或 `x-tdai-session-id` 头，v3 隔离头族先例）+
  三元组隔离头（严格隔离闸门继承，缺失 422）；检索按 (team,user,agent[,task]) 收窄
  （与 `/v3/atomic/search` 同形）。钩子路径行为逐位不变（提取只搬编排）。
- **配置**：`memory.recall.v3Recall { enabled（代码缺省 false = 逐位现状，端点 404）,
  timeoutMs（缺省 5000，超时 504） }`；生产 `tdai-gateway.yaml` 已显式开启。
- **MemoryProxy TdaiL1RecallInjector 瘦传输**：改调 `/v3/recall` 拿现成块直接前插
  （借入 agent 块前置 `[from <agent>]` 标注）；**降级路**——端点 404/5xx/超时 → 退回
  `/v3/atomic/search` 自行组装 + loud 日志（防静默降级）；`recallL1` 开关语义不变
  （false = 唯一代理注入链零注入，不降级）；`<relevant-memories>` 标记防重保留为冗余保险。
  升级须知：MemoryCore 与 MemoryProxy 需同批升级（老 Proxy + 新 Core = Proxy 继续走旧路，
  行为不变；新 Proxy + 老 Core = 端点 404 自动降级旧路 + loud，均向后兼容）。

### 🔐 记忆可信性修复 M3（信任边界门禁，P2-T11+T13，拍板③）

### ⚠️ 升级须知（行为变更，无兼容期）— 升级后必须配置 API Key，否则记忆功能 401

- **网关鉴权必填**：MemoryCore 网关不再"无 key 放行"。`server.apiKey`（env
  `TDAI_GATEWAY_API_KEY` 或 yaml）未配置时，网关启动会生成一把随机临时密钥
  （crypto.randomBytes 32 字节 → 64 hex，本进程有效，**重启更换**）并 loud 打印
  一次；所有请求（除 `GET /health`）必须带 `Authorization: Bearer <key>`。
- **跨进程调用方必须配置同一把 key**（否则一律 401）：
  - MemoryProxy：env `TDAI_GATEWAY_APIKEY`，或 `config.yaml` 的 `tdai.apiKey`
    （复核修补 I-1 后，skill / knowledge / meta 三链路的 Bearer 也走该兜底，
    不再只读各自 `serviceToken`）
  - MemoryPanel：env `TDAI_GATEWAY_APIKEY`（覆盖全部实例），或
    `config/metadata-instances.json` 每实例 `api_key`
  - openclaw：默认 `Bearer local`（本机无鉴网关遗留默认）——接入鉴权网关后
    必须改为真实 key，否则 401
  - hermes：默认 `Bearer local`（同上）
  - curl / 探针脚本：请求头加 `Authorization: Bearer <key>`
- **`V3_STRICT_ISOLATION` 默认 OFF → ON**：`/v3` L0–L3 数据面现在强制
  team+agent+user 三元组（缺失 422）。本机联调需要旧行为时显式设
  `V3_STRICT_ISOLATION=0` 回退；未知取值 fail-secure 视为开启。
- **升级步骤**：① 先在各组件 env/yaml 配好同一把 `TDAI_GATEWAY_APIKEY` →
  ② 网关 `tdai-gateway.yaml` 的 `server.apiKey` 写入固定 key → ③ 重启网关与各组件。

#### 回滚预案（数据库迁移）

- **T12 core 租户化迁移不可单方面 revert**：revert 后旧代码的 `upsertCore`
  仍走 `ON CONFLICT(slot)`（不含新增三列的冲突目标），对租户化后的新表
  结构报错，core 写入挂。回滚必须二选一：① 先重建旧 slot-PK 表结构
  （迁移回退 DDL）再切回旧代码；② 接受 core 写入降级（读不受影响）。
- **T7 FTS 迁移可单独回退**：旧代码对新 25 列表结构只读列兼容，直接
  切回旧版本即可，无需 DDL。

### 修复内容

- **I-1 · 复核修补（skill/knowledge/meta env 兜底）**：MemoryProxy 三链路
  （skill core-client / knowledge core-client / meta client / skill-bridge
  反代）原先只读各自 `serviceToken`（默认空），不在 `TDAI_GATEWAY_APIKEY`
  透传范围内——鉴权翻转后静默 401 断供。现统一走 `resolveBearerToken`
  （`TDAI_GATEWAY_APIKEY` env → `tdai.apiKey` 配置 → 原 serviceToken）
- **I-2 · 复核修补（L3 persona 消毒接线）**：`escapeXmlTags` 名单追加
  `l3_core_memory|agent` 注入边界标签；`/v2/core/write`（handleCoreWrite）
  落盘前对 content 调 `escapeXmlTags`（与 core-memory write 同模式）
- **T11 · core 写入消毒（守卫在咽喉）**：`escapeXmlTags` 边界名单追加
  `core_memory|identity|strict_rule|core_value|user`；`/v3/core-memory/write`
  handler 在 guard 校验通过后、落库前对 content 统一转义——含 `</core_memory>` /
  `</system>` 的毒化内容无法越块逃逸进 system 注入区，所有读端天然安全
- **T13 · 门禁收口**：`resolveApiKey(config)` 纯函数收编"缺失即生成"逻辑；
  `verifyAuth` 语义收紧为"恒校验"（key 由启动期保证恒有值）
- 同形验证脚本：`MemoryCore/scripts/verify-p2-t11-13.ts`（33 断言全过，
  含临时 server :8421 端到端 401/200 与写入消毒回读）；MemoryProxy 新增
  env 透传单测（`src/tdai/__tests__/client.apikey.test.ts`）

### ✨ 记忆系统第三档首批（C1-C4：价值信号全链流动 + router 退役，2026-09-10）

> 设计与召回影响矩阵：`docs/superpowers/specs/2026-09-10-soul-memory-c1c4-semantic-recall-design.md`
> 纪律：**检索层（向量/FTS 打分、绝对门槛）零改动**——价值信号只在排序/展示/遗忘三层生效

- **【C1】coreRef（记忆→价值锚引用）**：dedup LLM 调用顺带判定记忆触动
  哪些价值锚（候选清单注入 + 幻觉 id 过滤），落 `metadata.coreRefs`；
  召回排序加成（当前查询触动的价值 ∧ 记忆 coreRefs → +0.05 tiebreak，
  `memory.recall.coreRefBoost` 可配）；回忆片段带 `·触[价值]` 尾注；
  遗忘 salience 优先读 coreRefs（子串匹配降为兜底，缓解 K-B5 否定失明）
- **【C2】动机方向（LLM 总结初值 + 用户微调）**：core_values 加
  `valence` 列（可空=未判定）；LLM 批量总结方向初值（三值枚举，
  不确定给 0）；用户经 values/upsert 微调**永远优先**（derive 带
  `valence IS NULL` SQL 守卫 + apply-after-success 快照恢复，并发窗口
  不覆盖微调）；`/v3/core-memory/values/derive` 重判入口；current_feeling
  块按方向输出"围绕【X】推进 / 对【X】保持审慎"（NULL/0 不输出）
- **【C3】router 默认退役**：跨库软定域 router 经隔离实验证伪归因
  （recall 贡献 0、噪音 +2）后退出生产路径（代码默认层 + 本机镜像双退役，
  能力保留可重开）；退役前后锚点归档（negInjected -2 实证）
- **【C4】策略统一**：summarizer significance 补 metadata 双兜底
  （与 scorer 一致，legacy 行真值可见）
- **已知限制**（C2 报告 concern 3/4 登记）：`/v3/core-memory/values/derive`
  当前为同步阻塞实现（30s LLM 超时窗口内请求挂起），异步任务态留待后续；
  LLM 配置热更后 valence runner 不感知，新配置需重启进程才生效
- 同形验证：`verify-c4`(5)/`verify-c1`(21)/`verify-c2`(51)/`verify-c3` 锚点×2、
  MemoryCore+MemoryProxy 全量回归绿- **【阶段五】Memory hub UI 视觉重构（"有灵魂的记忆"可视化）**：BlockDetail
  拆分（SoulSection 灵魂区/RelatedSection 关联区+getPath 链路）、记忆卡片
  增强（valence 双色条/coreRef chips/recall 火苗/归档徽标）、记忆图语义
  通道（金色=挂价值锚/valence 色相/evolve·conflict 箭头）、价值锚管理面板
  （列表/微调/derive）、健康条进度环、wiki 源管理样式统一；Sigma 边 type
  误传业务类型致渲染崩溃修复（f53b173）；atomic/query|search 出参透传
  metadata（896ee5d）——数据零后端新增，纯 UI 工程
- 同形验证：panel vitest 94+ 用例全绿、web build exit 0、BFF 层全测、
  浏览器渲染层人工验收清单（web 无组件测试基建，已登记）- **【阶段七】R7 渐进式披露分层召回**：召回升级两层——L2 持续态结论常驻
  注入（幂等，借团队防重模式）+ L1 经验按预算折叠（scene_name 反查
  part_of 证据链 + coreRef 辅助）；九通道保留 L1 层；无 L2 命中与现状
  逐位一致（退化安全）；golden 双锚实证 P@5 逐位同值（分层不改 L1 排序）
- 同形验证：MemoryCore vitest 275/275 + golden 双锚（runs/12-41-28 前锚、
  13-09-41 后锚）
- **【阶段六】结构感知召回（R1-R6/R8/R9 九通道 + E1-E3 性能速赢）**：时间窗+
  时近性/significance/置信度分层/图一跳扩展(折扣+标注)/价值反查补池/场景
  路由/强化闭环(recall_count log 缩放——T4→C1→排序闭环最后一块)/mood
  congruent 弱偏置(默认关)；query embedding 60s TTL 缓存/values 租户级
  缓存(五写路径失效穷举)/会话级复用；关断矩阵逐通道 0=与基线逐位一致；
  spec：structure-aware-recall-design.md（utilization 矩阵 30%→100%）
- 同形验证：verify-ra1(22)/ra2(14)/ra3(16) + 全量回归绿；golden 系 wiki 设施，
  记忆召回以关断矩阵替代（spec 已更正）

- **【阶段四】TCVDB 后端七项缺口补全（伴生 SQLite 模式）**：score 刻度实证
  文档化（RRF 融合分 ≤0.0328——切 tcvdb 前须真机复验门槛语义）/图全套/
  归档桶/core 表 CRUD 全套（辅助表 DDL/SQL 委托 sqlite 单一实现，
  零第二份手写 SQL）/updateL1Metadata/bumpRecallCount/countL1VectorRows/
  native-hybrid 补 reconsolidation/restoreL1 degraded 守卫/prune fail-safe/
  getL1ByIds(WithArchive) 实现+消费侧 await 接线；契约测试 verify-t1/t2
  （真机实证留部署时，已登记）

### 🔧 收尾与补全（阶段一~三，2026-09-10）

- **阶段一（bug）**：T13 验证链 7 断言修复——根因：CWD 真实
  `tdai-gateway.yaml` 经 override 合并穿透临时 server（测试密钥与实例
  不同源）；修法 `TDAI_GATEWAY_CONFIG` 隔离 + `resolvedApiKey` getter
  同源取值。config 解析失败 loud 化（console.error，静默 catch 语义保留，
  verify-s1 端到端断言钉死）
- **阶段二（小扫除八项）**：env 双名兼容（`TDAI_GATEWAY_APIKEY` 主用 /
  `TDAI_GATEWAY_API_KEY` 兼容）、summarizer significance clamp、wiki
  结构页附尾 cap≤3、探针词拼时间戳、/health 注释、verify-s1 头注释、
  finally try/catch、derive 30s 与 LLM 热更登记
- **阶段三**：coreRef 排序加成延伸 auto-recall（复用 C1 同源常量与
  appraise；多租户 default 桶限制如实登记）；`getPath(a,b,maxHop)` 图
  查询接口 + `/v3|/v2 atomic/path` 路由（BFS 最短路径/租户过滤内置/
  环路安全；消费方=0，待 MemoryPanel 接入）
- 同形验证：`verify-s3`(10)/`verify-s5`(22)、回归全绿

### 🔧 记忆可信性修复 M3 续（T14 租户隔离，P2-T14）

- **neighbors 租户过滤（G2 封堵）**：`/v3|/v2 atomic/neighbors` 按
  isolation 过滤邻居与内容——跨租户枚举封堵；maxN clamp ≤50。
  **行为变更**：/v2 匿名调用（无租户头）由"返回全部邻居"收窄到 default
  桶——与 atomic/search|delete 同族语义对齐
- **巩固/遗忘租户隔离（H-B2）**：`memory.lifecycle.filter` 可配
  （team/user/agent/task，缺省 undefined=单机旧行为）；混租户同前缀组
  整组丢弃+warn（数据级双保险）；持续态落库补全租户字段
- **已知限制**：neighbors 无 filter 兼容路径下稠密图 BFS 全量遍历仍在
  （仅输出面 clamp）；`agent` 标签转义不覆盖带属性打开标签（逃逸面是
  闭合标签，已覆盖）；迁移期旧记录空租户与新记录混排会被判混租户丢弃
  （保险方向，有 warn）

### 🔧 记忆可信性修复 M3 续（core 租户化，P2-T12）

- **core 两表加归属列（K1）**：`core_memory` / `core_values` 增加
  `team_id` / `user_id` / `agent_id` 三列；CRUD（upsertCore / readCore /
  upsertValue / listValues）全链按租户过滤——身份小本本不再全 agent 共享。
  唯一性由复合唯一索引 `(slot|value_id, team_id, user_id, agent_id)` 保证，
  同 slot 不同租户可并存
- **handler 消费 isolation**：`/v3|/v2 core-memory/read|write` 按
  requestIsolation 过滤（照抄 T14 模式）；/v2 匿名 → default 桶（与回填
  自洽，行为连续）；顺手修 K9：core 写审计的 version 取刚写槽（按租户定位），
  不再误取 readCore 排序首行
- **MemoryProxy 四元组 + 缓存租户键（K-B4）**：`listCoreMemories` /
  `listCoreValues` 透传当前会话 identity 三元组（不再 hardcode default）；
  injector 的 core slots/values 模块级缓存改 `Map<tenantKey, …>` 分桶——
  双租户交替注入不再互相泄漏身份块。**行为变更**：core 注入读从"全局
  同一份"变为"各租户各一份"；多租户实例升级后各租户首次注入为空
  （属预期——各自的 core 各自维护）
- **⚠️ 升级须知（拍板⑤存量回填）**：存量库 core 行（生产 1+6 行）init 时
  自动幂等迁移：补三列 + 回填归属 `<default/default/default>` 并 loud 打印；
  如需变更归属请直接 `UPDATE core_memory/core_values SET team_id/user_id/agent_id`。
  回填 default 与 /v2 匿名桶对齐，匿名读写迁移前原数据不受影响
- 同形验证：`MemoryCore/scripts/verify-p2-t12.ts`（26 断言：全新库隔离 /
  存量迁移回填 / handler 链路 / upsert 冲突目标）；MemoryProxy 单测

### 🔧 记忆可信性修复 第二档（S1/S2 小件清零，2026-09-10）

- **【S1】similar 边门槛配置化**：`memory.links.minSimilarity`（默认 0.3，
  clamp [0,1]）——硬编码转 config-first（T9 裁决待办兑现）
- **【S1】core_values 写 API**：新增 `/v3/core-memory/values/upsert|delete`
  （租户隔离 + label 消毒 + 审计 + 失败 5xx/404）——"agent 可维护价值锚"
  成立；非 default 租户不再恒空（T12 审计 M-5 补齐）
- **【S1】yaml 编码根治**：`tdai-gateway.yaml` 历史上为 UTF-16 LE，
  CWD 加载路径 `readFileSync(utf-8)` 解析抛错被**静默 catch**——配置全量
  落默认值 + 临时密钥（09-10 上午登录断供的真正根因）。已规范为 UTF-8
  （无 BOM），并用网关同款 YAML 解析器验证；**已知限制**：静默 catch 保留
  （文件可选语义），已由 `verify-s1` 端到端断言钉死，loud 化登记后续
- **【S2】缓存键碰撞收敛**：knowledge/meta/skill 三 client 共 6 处
  `${a}:${b}` / `::` 拼接键改 `JSON.stringify([…])` 数组序列化（与
  coreTenantCacheKey 同模式）——分隔符歧义与 ids 逗号歧义（K2）消除
- 同形验证：`MemoryCore/scripts/verify-s1.ts`（41 断言，含真实 yaml 文件
  端到端——文件加载段覆盖）、MemoryProxy vitest 140+ 全过
- **下一轮设计大件**（层级边/coreRef/动机方向/TCVDB 实证/router 调参）：
  待讨论清单见 `docs/superpowers/specs/2026-09-10-soul-memory-next-round-backlog.md`
  （client identity 透传 + injector 缓存租户分桶）

### 🔧 wiki 召回 domainRouter 默认退役（C3，先归档后翻转，2026-09-10）

- **退役依据（隔离实验第三次复现）**：部署工作点（tw09/rel0.6/absGate1.5）
  router 对 posRecall 单变量贡献=0（on/off 同为 0.66, 19/29）、negInjected 恒 +2
  （13 vs 11；复跑 14 vs 12）——锚点
  `docs/superpowers/evals/recall-golden/runs/2026-09-10T04-07-38.json`（翻默认前）
  与 `runs/2026-09-10T04-09-17.json`（默认态复跑），replay 新增配置 E
  （= B minus router，同语料快照成对对照）
- **代码默认层显式退役**：`defaultWikiRecallConfig.domainRouter = { boost: 1.5,
  keywords: {} }`（keywords 空表 = injector 跨库软定域恒 no-op，能力形状保留）；
  注意代码默认此前即"缺省=关"（domainRouter 本就无 enabled 开关），本次是
  把退役状态**显式钉死 + 注释重开协议**，防静默复活
- **config.yaml（gitignore 部署镜像）同步整段注释退役**：本 injector 不读
  `enabled` 字段（只判 keywords 非空），写 `enabled: false` 是静默 no-op——
  退役 = 注释整段，关键词表留档于注释
- **⚠️ W4（boost→归一→注入门耦合）随退役消失**：boost 作用于归一前分数、
  直接受注入门放大。**重开 router 前必须**：(a) 先归档 router-on 实验；
  (b) 先解耦 W4（独立任务）
- 行为变更：升级后未显式配置 domainRouter keywords 的部署不再有跨库 boost
  （对 recall 无影响、噪音 -2）；显式配置 keywords 的部署行为不变（能力保留）
- 测试：`wiki-recall-injector.test.ts` 两条 C3 钉死用例（TDD RED→GREEN）；
  MemoryProxy vitest 全量 149 过

### 🔧 记忆可信性修复 M4（语义补全，P3-T17/T17.5/T15/T16）

- **subject 语义归组（拍板④）**：dedup LLM 调用顺带抽取归一化主题词
  （零额外调用），巩固分组从"前缀 24 字符字符串匹配"升级为
  `llm（默认）→ 词法兜底` 两档策略门（embedding 档登记待做）
  （`memory.consolidation.subjectStrategy`）——
  同义不同表述的记忆现在能归入同组触发巩固（此前结构性不可能）
- **scheduler 行映射根治（⚠️ 遗忘行为变更）**：行映射补全 id 与
  metadata_json 内容（空派生值不再盖真值）。**行为变更**：soul 列为空的
  存量记忆此前按常数 significance=0.5 打分，现在按 metadata_json 真值
  打分——**significance<0.5 的存量记忆归档风险上升、>0.5 更受保护**；
  recall_count 抗遗忘 boost 在真实调度链路真实生效（此前恒死）；
  F4 幂等与 evidence_ids 证据链在真实链路恢复（此前 fixture 验证掩盖）
- **向量健康三件套**：dedup 向量可用性判据改数向量行（元数据行会误导）；
  /health 增 memory 子对象（vectorCoverage/探活/lastVecWriteAt，探针
  embed-only 不写业务表）；召回降级时注入块带
  `[degraded: fts-only]` 标注（两义措辞：向量层降级或相关度门滤除）
- **current_feeling 解冻**：感受块从 session_init 冻结缓存拆出为独立
  每轮注入器（cacheStrategy=none，动态区）——"每轮派生当前感受"首次
  真实生效；core_memory 稳定块保留缓存（cache 友好不变）；补
  chat_memory 资产门控与 identity=null 用例
- **durative 真值**：持续态 significance 从 priority 派生常量 0.8 改为
  组内顶层 significance 真实 max（半数缺值退 0.5 中性）；含 inferred 组
  不巩固（T1 洗白门双保险）
- **结构页降权**：wiki 召回 log/index/schema/purpose/overview/other 页
  权重 0.3 且无 absScore 结构页排尾+`[structural]` 标注（实际排尾集合
  5 类：log/index/schema/purpose/overview；overview 权重项已被排尾
  取代）——log.md 不再以 rank 1-4
  挤占注入位（**部署须知**：MemoryProxy config.yaml 不进 git，换机部署
  需手动同步 typeWeights 4 项；重启 MemoryProxy 后生效）

### 🔧 记忆可信性修复 M1（数据止血，P0）

第五轮对抗性审查（`docs/superpowers/reviews/2026-09-09-soul-memory-fifth-round-audit.md`）
发现的一批数据正确性问题，本批先行修复：

- **H 侧洗白门**：巩固分组入口接 `isObservable`——inferred（推断）记忆不再
  被熬成 certainty="observed" 的持续态（此前凑满同前缀 3 条即可洗白并进画像）
- **C 侧重巩固门收紧**：只放行 certainty="observed"——FTS 路径 certainty 不可见
  时宁缺毋滥整体跳过（此前黑名单式判断放行 undefined，inferred 经 FTS 命中也吃
  抗遗忘 boost）
- **编辑即失忆修复**：`/v3/atomic/update` 现在保留既有行的 soul 8 字段
  （时间锚/情感/可信度，null 透传）——此前编辑一次即被 upsert 刷空，时间锚
  消失导致该记忆永不归档；顺带堵住"编辑 inferred 被静默晋升 observed"的洗白变体
- **recall_count 原子自增**：新增 `bumpRecallCount`（SQL json_set 自增），
  修复"每次回忆计数恒 1、抗遗忘封顶 +10% 永不可达"；损坏 JSON 行显式失败 +
  告警去重，不再静默半写
- **嵌入服务切换**：嵌入套餐额度耗尽导致向量层死亡（09-08 起零向量），
  已切换至新套餐端点并验证恢复（向量重建 + 记忆图边恢复落库）
- **【M2】FTS soul 列迁移**：`l1_fts` 17→25 列（soul 8 字段从主表回填，
  init 幂等自动迁移）——FTS 命中的记忆现在带时间锚/情感/可信度，J 时间窗、
  回忆片段情感标注、auto-recall soul 尾注全通道恢复
- **【M2】边强度真实化**：dedup 路径 similar 边不再使用常量 0.8/0.5，
  透传真实 cosine；FTS-only 不再建假强度边；同批新记忆不再互建边；
  **行为变更**：similar 边新增最低相似度门槛 0.3（与检索门槛对齐），
  strength=0 的假关系不再入库；恢复 FTS 重建补分词（恢复的记忆可被搜到）
- **【M2】生产假边清理**：历史 0.8 假边 227 条已清除（清理前备份于
  `D:/tdai-data/backup/`）；`scripts/clean-fake-edges.ts` 留档（dry-run 默认）
- 全部修复带"同形验证"脚本（`MemoryCore/scripts/verify-p0-t1..t4.ts`，
  测试数据走生产同一条数据流）；行为无破坏性变更，接口签名不变

---

## [2.0.1] — 2026-08-25

### 🚀 支持更多 Agent 客户端

现在无论你用哪款 coding agent，都能直接挂上团队记忆：

- 新增 **OpenCode** 客户端接入
- 新增 **DeepSeek Harness (dsh)** 接入 —— DeepSeek 官方 agent harness 的
  Web UI 会话可直接接入 Proxy，自动获得团队记忆 / skill / 知识注入
- 新增 **Codex CLI** 接入
- 新增 **WorkBuddy** 客户端接入，开箱即用
- 多款客户端的首次引导与重置体验保持一致，切换更顺畅

### 🤖 会话内直接下指令

不用切到面板，在对话里就能完成常用操作：

- 会话中途一键重置绑定（换团队 / 换 Agent / 换任务）
- 对话内直接创建 / 更新任务
- 指令响应更快，减少等待

### 🧠 冷启动开箱即用

- 创建团队或用户即自动生成默认 Agent，无需手工配置
- 管理员可自定义默认 Agent 模板，新用户冷启动自动套用
- 支持从 IDE 里已有的 Agent 一键导入资产，快速起步
- 接入后默认绑定任务，即开即用

### 🔄 会话绑定更稳定

- 会话绑定持久化保存，重启不丢失
- 切换 Agent 后记忆与技能正确跟随切换，不再串场
- 修复部分客户端历史回放被误判的问题

### 🧰 技能（Skill）体验升级

- 会话里新建的技能立即可被检索到，不再有"搜索盲区"
- 恢复技能 ID 的展示与一键复制
- 技能支持在线编辑
- 新增接入向导技能：跟着引导一步步配置，或一条命令自动完成 Proxy 接入

### 🎛️ Memory Hub 面板

- 全新登录页，加入点阵波纹动效
- 团队编辑 / 删除入口整合到团队切换器，操作更顺手、修复切换异常
- 管理员创建账号时可自定义 User_Key
- 新增对话记忆搜索：跨会话的语义与关键字检索，按权限精确控制可见范围；
  支持对单层记忆直接覆盖修改
- 资产 ID 直接展示并可复制；列表完整加载，修复分页截断显示不全的问题

### ⚙️ 一键部署增强

- 启动脚本支持交互式配置，自动预检 LLM 通路与端口占用，避免部署踩坑
- 客户端接入地址一键复制，单机部署下自动解析为宿主机地址，外部客户端可直接连接

### ⚡ 性能优化

- 知识库列表加载提速，常用路径更快响应
- Wiki 页面并发构建，单页失败自动重试，大批量文档导入时间大幅缩短

### 📚 文档

- 按客户端拆分独立接入文档，各 agent 各有一份清晰的接入指南
- 新增面板与 API 使用文档
- 补充英文面板截图与 README 更新

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效、资产较多时记忆 tab 丢失的问题
- 修复导入历史会话时间错乱，恢复原始时间线
- 修复编辑场景时部分内容被重复展开的问题
- 修复 macOS 下部署脚本的兼容性问题
- 修复依赖缺失导致的安装报错
- 修复部分客户端首次引导表单在老版本上的兼容性问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 冷启动开箱即用 · 默认 Agent + 预置 Skill

- 创建团队/用户即自动生成默认 Agent，无需手工配置
- 客户端接入地址一键复制，支持指向 Memory Proxy
- 单机部署下接入地址自动解析为宿主机地址，外部客户端可直接连接

### ⚡ Wiki 生成加速

- 优化 Wiki 生成，页面并发构建，大幅缩短大批量文档导入时间
- 单页失败自动重试，不再拖停整个批次
- 生成进度与单页状态实时可见

### 🧰 Skill 生态

- 新增 Skill 导出功能
- 优化 Skill 检索，私有 Skill 可被检索到，结果更精准
- 优化 Skill 提取能力，捕获范围更广

### 🔀 Memory Proxy · 新增客户端接入

- 新增 Codex CLI 接入
- 新增 WorkBuddy 客户端接入
- 新增 DeepSeek Harness (dsh) 接入 —— DeepSeek 官方 agent harness 的 Web UI 会话
  可直接接入 Proxy,拿到团队记忆 / skill / knowledge 注入;支持 aux 请求短路
  (compaction / title-gen) 与 CLI headless bypass
- 优化 code-graph 资源与工作区的关联

### 🎛️ Memory Hub 面板

- 重构首次使用引导流程，新增 Agent 绑定步骤
- 优化面板交互、加载骨架屏与过渡动效
- 优化 Task 页用户展示名解析
- 优化资产页面布局与归属/共享规则说明
- 修复资产较多时记忆 tab 丢失的问题

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效的问题
- 导入的历史会话保留原始时间，时间线不再错乱
- 修复某些场景下记忆丢失的问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.0] — 2026-08-03

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。新增 Skill 强制归档功能。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。新增定时自动同步代码库功能。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建
- 管理员（System Admin）现在也可使用资产管理功能
- 面板全面支持中英文切换；统一页面设计风格，优化列表交互和分页体验

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性
- Cost Guard 支持为不同 Agent 配置不同模型以降低成本

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 文档

- 新增 CodeBuddy / Hermes / OpenClaw 接入指南
- 更新安装指南中的角色权限说明

---

## [2.0.0-beta.1] — 2026-07-21

首次公开发布。SemVer 从 `2.0.0-beta.1` 起步（npm 包名迁移到 `-v2` 后缀：
`@tencentdb-agent-memory/memory-tencentdb-v2`、`memory-sdk-ts-v2`）。
Docker 镜像 tag 独立于 npm 版本，本次镜像发的是 `:1.0.0-beta.1`。

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```
