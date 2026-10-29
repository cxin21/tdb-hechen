# 上游 TencentDB-Agent-Memory 深度对比与同步路线（2026-10）

> 对象：上游 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 分支 `feat/server_team` @ `65730e979a5a590c54adc181ba8a375055410b84`（2026-10-26）
> 对照：本仓 `cxin21/tdb-hechen` `main` @ 日常开发 HEAD（557 commits）
> 票单：[#113](https://github.com/cxin21/tdb-hechen/issues/113) 及其子票 #114–#131

## TL;DR

1. **两条演化线已经分叉，且分叉是结构性的**。上游走向**平台化**：MongoDB 后端、Pi / opencode / dsh 多客户端、可插拔决策服务（JEV）、外部源导入（TAPD / 代码 / Wiki-iWiki）、ClickHouse Analytics、OAuth2/OA 登录、会话轨迹 `/v3/session/add`、skill 按需选择。本仓走向**记忆语义与治理**：分层召回与结论层（`auto-recall.ts` 3256 行 vs 上游 1019 行）、灵魂六属性与身份叙事、价值锚、红线、自动采纳门、BM25 归一、LLM 凭据 SoT。**本仓 ADR-0001..0008 的落体在上游 grep 全零命中**（`conclusionLayer`/`minBm25RelRatio`/`renderIdentityNarrative`/`soulPrefixCache`/`valueAnchor`/`halfLife` 等）。
2. **不要整体跟上游**。160 条冲突里真正需要人判断的 L1 冲突约 40 条，其余是治理差异（CHANGELOG/README/lock）与路径级误报（pi-plugin 9 条伪新增、store 目录化）。
3. **可摘的是三类**：①上游修好而本仓仍存在的真缺陷（本轮筛出 20 余条，多为 S 级纯增行）；②deploy / agents 的纯本地缺陷（与上游定制无关）；③个别独立能力（analytics 端点、code-graph build、session-add、skill 版本清理）。
4. **本仓有 3 处真实安全缺陷是本轮最该先做的**：知识服务零入站鉴权（#115）、asset 读越权（#116）、ingest-v2 落盘可越界（#114）。

---

## 1 方法与可信度

`git fetch` 在本机不可用（codeload 限速 ~39KB/s，5MB 后停滞；`raw.githubusercontent.com` 直连 `curl: (28)`）。改用 **GitHub API 拉 Git blobs**：`gh api` 逐 blob 下载，10 并发，**1225 个非 assets 文件 / 15MB，逐个 blob sha 比对 0 失败 0 偏差**。快照落 `D:/TDB/tdam-upstream/`（只读取材），分析中间产物在 `.local/upstream-sync/`。

两仓**无共同祖先**（本仓根 commit `d32930c` 为 "chore: initial import"），因此全部结论走**内容级对齐**（blob sha 比对），不做 git 谱系比较。

### 1.1 基线校正（最重要的一条口径）

本仓 initial import `d32930c`（2026-09-15）**不等于** 上游 `v2.0.1`（`a5dcbe6e`，2026-08-25），而是上游 main 在 **2026-08-27 ~ 09-06** 区间的快照。证据：

- `5299c00a`（Pi adapter，#1126，08-27）的 11 个文件 **100% 存在于本仓**；
- `220af622`（v2.0.2-beta.1 release，09-07）新增的 106 个文件在本仓 **0/106 存在**。

后果：以 `tree-v201` 为基线算出的 A 清单含 **9 条伪新增**（本仓早已具备、内容逐字节相同）：`MemoryCore/pi-plugin/{.gitignore,index.ts,package.json,README.md,tsconfig.json,vitest.config.ts}`、`MemoryProxy/src/agent-adapters/pi.ts`、`MemoryProxy/src/injection/agents/pi/{index.ts,profile.ts}`。

**校正后：真实能力缺口 = 278 条（A & clean）**，而非 287。

### 1.2 CONFLICT 的定义

`CONFLICT` = **双方都相对基线改过该路径**，与 diff 行数无关。曾出现「`openapi.yaml` 标 CONFLICT 但上游改动仅 +2/−17」的疑义，核实为口径正确（本仓也改过）。

---

## 2 三向规模矩阵

| 维度 | 上游 v2.0.1 → HEAD | 本仓 vs v2.0.1 |
|---|---|---|
| 变更路径 | 579（8.15MB，不含 assets） | A 866 / M 255 / D 14 |
| 其中新增 | A 287 | — |
| 其中修改 | M 292 | — |
| 其中删除 | D 11 | — |
| 双边都改（冲突面） | — | **160** |

| 目录 | delta 条数 | A/M/D | 冲突 | 字节 |
|---|---|---|---|---|
| MemoryCore | 174 | 76/93/5 | 39 | 3.25MB |
| MemoryProxy | 180 | 108/67/5 | 38 | 2.31MB |
| MemoryPanel | 137 | 59/77/1 | 57 | 1.46MB |
| MemoryKnowledge | 59 | 36/23/0 | 16 | 0.41MB |
| deploy | 13 | 1/12/0 | 2 | — |
| root | 10 | 0/10/0 | 8 | — |
| sdk | 5 | — | 5 | — |
| agents | 7 | 2/5/0 | — | — |
| adapters | 5 | 5/0/0 | — | 本仓无该目录 |

上游 HEAD 树：1259 blob / 44.3MB（assets 占 32.2MB，未下载）；本仓 1835 blob（含 docs/ 大树）。

---

## 3 上游版本演进（引用证据时用 PR 级 commit）

| 版本段 | commits | PR 级 | release 提交 | PR 触达文件 | release 触达 | 热点 |
|---|---|---|---|---|---|---|
| v2.0.1 → v2.0.2-beta.1 | 11 | 10 | `220af622` | 30 | 288 | Proxy 18 / Core 8 |
| beta.1 → beta.2 | 13 | 13 | — | 26 | 0 | deploy 7 / Knowledge 5 / adapters 4 |
| beta.2 → beta.3 | 4 | 4 | — | 5 | 0 | — |
| beta.3 → v2.0.2 | 8 | 7 | `99a1a2c2` | 13 | 265 | — |
| v2.0.2 → v2.0.3-beta.1 | 6 | 5 | `badbd217` | 7 | 130 | — |
| v2.0.3-beta.1 → HEAD | 11 | 11 | — | 15 | 0 | Panel 6 / deploy 5 |

**判读**：上游 release 提交是 `dev → main` 的**大 squash**（130~300 文件），不能当作「一次改动」引用；引用证据优先用 PR 级 commit sha8（如 `445d5ef7`、`e9a82935`、`a1098109`）。

上游 CHANGELOG（11KB）三条主线：**2.0.2-beta.1** MongoDB（`STORE_MODE=mongodb`/mongot FTS/切换不迁移数据）、技能体验、OAuth2 OA 登录、ClickHouse 数据分析；**2.0.2** MongoDB 补齐、OpenCode adapter 包、dsh 桌面端、Pi 客户端、外部源导入、skill strict 批量抽取；**2.0.3-beta.1** 可插拔决策服务（provider 默认 jev、默认不调用）、skill 按需选择、会话轨迹 `/v3/session/add`、代码知识库 SSH 克隆、`/health` 增 `ftsAvailable`。

本仓 CHANGELOG（119KB）逐项登记定制，但关键词核对：MongoDB / ClickHouse / 决策服务 / 会话轨迹 / OAuth / TAPD / SSH / 外部源 / 召回为空 / 历史消息重复 / 工具结果污染 **全部 0 命中** ⇒ 上游 2.0.2 / 2.0.3 两条能力线本仓**完全未跟**（这是有意的，见 §8 铁律）。

---

## 4 冲突分层（160 条）

| 层 | 内容 | 数量级 | 处置 |
|---|---|---|---|
| **L1 真冲突** | config 系（`MemoryCore/src/config.ts` 2221 vs 872 行、`gateway/config.ts`、`utils/env-config.ts`、Proxy/Panel/Knowledge 各自 config）、store 目录化、`auto-recall.ts`、`v2-router.ts`、`server.ts`（Core 152291B / Proxy 27238B） | ~40 | 逐 hunk 手合，禁止整文件取上游 |
| **L2 治理差异** | CHANGELOG / README* / INSTALL* / .gitignore / lock 文件 | ~90 | 保持本仓；仅 .gitignore 取并集 |
| **L3 路径级误报** | pi-plugin 9 条伪新增、上游新增 `store/sqlite/`、`store/tcvdb/`、`store/mongodb/` 与本仓同族不同路径 | ~30 | 不合并，登记即可 |

---

## 5 受保护资产风险登记册（实读 diff，非推测）

| # | 文件 | 本仓 | 上游 | 风险 |
|---|---|---|---|---|
| R1 | `MemoryCore/src/core/store/sqlite.ts` | 341237B 单体，含 `SOUL_COLUMNS`/`SOUL_SELECT_FRAGMENT`（`sqlite.ts:63`/`:434`） | 拆 `sqlite/{memory-store 153804B, skill-store 30521B}`；`mongodb/memory-store.ts` 55016B **完全不知 soul-columns** | 采纳 mongo 后端 = 灵魂/召回静默降级 |
| R2 | `MemoryCore/src/core/hooks/auto-recall.ts` | 3256 行（+2360/−123），独有 `foldNearDuplicates`/`isAnalyticalQuery`/`R7LayeredContext`/`RecallRankSignal`/`createRerankBreaker`/`buildSoulAnchorSelectRuntime`/`performLayeredRecall` | 1019 行，无对应 export | 无法机械合并；上游 `nativeBm25Search` 快路径在结论层之前 return，直接采纳绕过 ADR-0008 |
| R3 | `MemoryCore/src/config.ts` | 2221 行（+1456/−107），新增 RecallRerank/SceneGovernance/MemoryLinks/Evolution/Lifecycle/RecallJournal/NeighborExpand | 872 行，新增 PersonaJevConfig/`PersonaTriggerMode`/`JevDiagnosticsMode` | L1 真冲突主战场 |
| R4 | `MemoryCore/src/gateway/config.ts`（ADR-0006 同文件） | 1026 行（+114/−317） | 1229 行，新增 FileStoreMode/FileStoreOthersMode/resolveBackendResolverFlag/GatewayTaskSourceConfig | 同上 |
| R5 | `MemoryCore/src/utils/env-config.ts` | 212 行，含 ADR-0006 的 `resolveApiKey`（deprecated env 通道）、`resolveMemoryLogLevel` | 208 行，含 MongoEnvConfig/`readMongoEnvConfig` | 凭据真源冲突 |
| R6 | `skill-config.ts` | 290 行（+2/−10） | 298 行 | 差异极小 |
| R7 | `MemoryProxy/src/config.ts` | 828 行 | 889 行（+239/−300，新增 `readKeyFile`/`buildSelectionConfig`/`buildSkillSelectionConfig`） | 中 |
| R8 | `MemoryKnowledge/src/config.ts` | 226 行（+52/−23，新增 EmbeddingConfig/RerankConfig） | 197 行 | 中 |
| R9 | `MemoryPanel/src/panel/config/panel-config.ts` | **78 行**（+10/−208） | 276 行（PanelClickHouseConfig/PanelAuthConfig） | 结构分歧最大 |
| R10 | Knowledge ingest-v2 落盘 | `slug.ts:84-87` 无白名单、`ingest-v2/index.ts:231-232` 无根目录校验 | `safe-path.ts:17 isInsideRoot`、`slug.ts:87-96` `Object.hasOwn`+SAFE_TYPE_RE、`index.ts:236-247` 读前拦截 | **上游修的正是本仓真缺陷** → #114 |

---

## 6 五模块结论（详版见 `.local/upstream-sync/modules/*.md`）

### 6.1 MemoryCore（①7 / ②6 / ③11）

关键前提：上游对本仓四大资产 grep **全零命中** ⇒ 冲突是「接缝冲突」而非「两版实现」。

**可摘（全部 [建议采纳]，CHANGELOG 零命中）**

| 票 | 内容 | 证据 | 量 |
|---|---|---|---|
| #116 | asset 读越权 | `v3-meta-router.ts:245` 丢弃 caller vs 上游 `:279`/`:286` + `metadata-service.ts:1234`/`:1251` | M |
| #121 | L0 msg id 12-hex 截断（生日碰撞静默覆盖） | `v2-router.ts:843` vs 上游 `:722` | S |
| #121 | LLM 失败日志无 status/url/body | `llm-runner.ts:546-549` vs 上游 `:441-457` | S |
| #121 | offload 槽不可用即硬禁全部 hook | `offload/index.ts:1231-1232`/`:1264-1265`/`:1009` | S |
| #123 | embedder 把 Noop 当可用 | `auto-recall.ts:1868`/`:1884`、`l1-dedup.ts:176` vs 上游 `embedding.ts:109-119` | M |
| #122 | l1-extractor 缺 think 剥离 + 无空因 | `l1-extractor.ts`（已 CONFLICT，按 hunk 落） | S/M |

**②-5 / ②-3 的实测校正**（本轮补证，已写入 `MemoryCore.md` §5）：

- **Noop 向量实测**取两形态：`dims=0`（生产默认 `store-pool.ts:387`）时 `vecTablesReady=false`、`searchL1Vector` 首行即 `return []` 且**只有 debug 无 warn** ⇒ hybrid 的向量腿**静默空转**（FTS 正常，`getCapabilities().vectorSearch=false` 本可判但 auto-recall 未读）；`dims>0`+Noop 时读侧每次抛错被 `sqlite.ts:4041-4046` catch 成 warn（可观测），写侧因空数组 `.every()` 恒真而 `skipVec`、`upsert` 仍回 true（仅 debug）。`l1-dedup` 不受影响（用 `countL1VectorRows` 判据 → Tier2 FTS）。⇒ 修的价值在**可观测性**，严重度「中」。
- **offload 硬禁分支当前不可达**：全仓 `plugins.slots.contextEngine` 零配置，`deploy/**` 与两个 yaml 无 `offload:` 段，`enabled` 缺省 false（`config.ts:1208`）⇒ 降为「启用 offload 后必然触发」的潜在缺陷，S 级仍建议做（移植时 `reclaim scheduler` 启动须移出该分支）。

**不跟（③）**：store 目录化（承载 `upsertValue`/`valuesCache`/`listValues`/记忆图/R7 结论层 SQL）、`auto-recall.ts` 整文件、persona-generator 三态化、scene-extractor diff 派生、l1-dedup 统一 RRF、JEV 凭据通道、`server.ts` 整文件（上游**无** `/v3/recall`，整取即丢 DS-RECALL-MERGE-001）。

### 6.2 MemoryProxy（①13 / ②2 + 3 收敛项 / ③13）

- **#118 AGENTS.md 静默丢弃**：`injection/adapters/anthropic.ts:60-61` 按 `role!=='system'` 过滤；上游用 `TOP_LEVEL_SYSTEM` metadata 标记 + 引用排除（`445d5ef7`/`#1459`，+9/−4，带测试）。
- **#117 dsh aux 恒 404**：`routes/whitelist.ts:175` 的 `AGENT_PREFIX_RE` 有 pi、缺 dsh；`normalizeWhitelistRequestPath`（`:245-257`）唯一前缀剥离靠它，`matchWhitelistEndpoint` 只做精确后缀匹配 ⇒ `/dsh/<space>/v1/embeddings` 白名单不命中 → `auxiliaryHandler.ts:171` 404。而 `server.ts:326-327`/`:361-362` 已注册该路由 ⇒ **有路由无匹配**；主链路有 `?? protocol` 兜底故长期不发现。已实读确认，置信度高。
- **3 条收敛项（勿反向对齐）**：header-identity `presetIdentity`、task-optional memory（`session/preset.ts:115`）、DSH runtime-context 入 L0（`common/user-query-extractor.ts:84/:86/:106` + `tdai/recorder.ts` 的 `isExtractableUserInput`/`stripDshAcpTags`，**本仓独有**）。
- **③ 铁律**：不跟 pipeline 重构（上游 `stages×30 / runners×7` 删除本仓 5 个 handler，共 8171 行）。`tdai-profile-memory-injector.ts`（371 vs 249）合并易丢 narrative format 与 tenant 分桶 ⇒ ADR-0005 静默退化。`credit-reporter.ts`（343 vs 463）+ `pricing.ts`（161 vs 252）几乎完全不同，单独立项。
- 裁决：task-draft 的 env 覆盖 **拒绝**（ADR-0006 单源）；TaskSourceType 在 Proxy **无消费方**（`meta/client.ts:82/:97` 纯 string、`:358` 原样透传）。

### 6.3 MemoryPanel（A11 / B9 / C15）

- 53 条可 diff 冲突中：**17 条纯 prettier**（C13，直接取上游：`LoginGate.tsx`、`TabBar/index.tsx`、`GlobalHeader/index.tsx`、`lib/api/auth.ts`、`lib/useResizable.ts`、`main.tsx`、`ApiKeyPanel.tsx`、`useChatMemory.ts`、`backendStore.ts` 等）、**11 条 ours 归一差 ≤16 字符 ≈ 未改**（C14）、趋同项 0。
- **#124**：B1 固定资产 tab `FA_PAGE_HARD_LIMIT=500` 截断（`chat-memory.ts:250-292`/`:263`，线上 case 519 skill + 1 chat_memory → tab 空白；本仓 core 已支持 `asset_types` 下推 `v3-meta-schemas.ts:303`）；B2 无手动刷新且刷新不重置时间筛选（`useChatMemory.ts:52/:226/:299`、`BlockDetail.tsx:637-640`）；B3 TabBar 键盘守卫；B4 `useResizable` 丢 body 原样式。
- **#125**：B7 `env()` 空串被当有效值（`panel-config.ts:6-7` → `:31/:39/:70`）；B5 `USER_CREATE_FAILED` 未登记致误报「key 无效」；B6 `ApiKeyPanel.tsx:332-333` 写死 `/default`；A11 来源元数据。
- **#127**：TaskSourceType 收窄在本模块**有消费方**（`tasks.ts:9`、`backendStore.ts:69`/`:253` 唯一字面值分支、`TaskCreateDialog.tsx:21`/`:54`）⇒ TS 编译错 + 来源标签错。
- **硬冲突（#128）**：Wiki provider registry（本仓自研 Git 源 `knowledge-client-port.ts:43/:66/:198-209`、`wiki-routes.ts:64/:76/:101/:138/:181/:193`）；`knowledge/common.ts:392 requireWikiWritable` 把写放开给同 team 成员（唯一越权风险点）；`chat-memory.ts` 本仓 +38257 vs 上游 −271（必须手工重放）；`chat-memory-panel.css` 本仓 +15273（不可取上游）。

### 6.4 MemoryKnowledge（①9 / ②5 / ③11）

- **#114 ingest-v2 落盘（已复现）**：`dirForType("__proto__")` → `[object Object]`、`"constructor"` → `function Object()…`、`".."` → `..`、`"a/b"` → `a/b`；越界文件会被读进 merge prompt。
- **#115 服务间鉴权**：`src/middleware/` 只有 `error-handler.ts`+`response-envelope.ts`，`KNOWLEDGE_SERVICE_KEY` 零引用 ⇒ 写/管理面零入站鉴权，且 `/internal/llm-binding` 可读；暴露面已核（`deploy/panel-knowledge-combined/README.md:59` `-p 8424:8424`）。
- **P2（#131）**：`/v3/analytics` 5 端点（`analytics-routes.ts:106-107`/`:116`；本仓 `clickhouse-telemetry.ts` 与上游逐字节相同 ⇒ CH 数据已兼容，缺查询端点与看板）、`POST /code-graph/build` 本地目录重建（`routes/code-graph.ts:299-336`、`store/code-graph-service.ts:261-303`、`module.ts:376`）。
- **[参考借鉴]** 拉取失败与抽取失败解耦（本仓 `wiki-service.ts:1126-1136` 把 git 失败也写 `sync_error="failed"`）；页面身份从 title 迁到源相对路径。
- **[不适用-已分叉]** 私有仓 / 外部 wiki 整套（凭据表 base64 非加密、per-user SSH 私钥、iWiki MCP）—— 与 ADR-0006 形成两条真源。
- **治理发现**：本仓 CHANGELOG 对 MemoryKnowledge 内部实现**零登记**（`ingest`/`drizzle`/`sync_error`/`openapi`/`SERVICE_KEY` 全零命中）⇒ 见 #130。

### 6.5 平台面（sdk + deploy + agents + adapters + root，①7 / ②9 / ③8）

- **#119 三条 deploy 缺陷**：7 处 `$VAR` 紧跟全角标点未加 brace（bash 3.2 多字节 locale 下 unbound）；`start-memory-core.sh:169/:189` `${KEY:+-H "…"}` 未加外层引号 → word splitting 4 token → 配 `MEMORY_CORE_GATEWAY_API_KEY` 时两处 curl 必失败；一键部署缺 `knowledge:` 段（注册判据 `injection/index.ts:628-634` 需 `enabled && serviceToken`）⇒ `<knowledge_tools>` 永不注册（静默功能缺失）。
- **#120 asset-import**：`asset-import.ts:468-470`/`:845` 裸 `JSON.parse`，遇 JSONC（`~/.workbuddy/argv.json`）整批导入中断。
- **#126 文档**：`agents/dsh/README.md:19/:38` 的「尾巴不要加 `/v1`」在 dsh v0.2（Anthropic Messages `/v1/messages`）已失效；`agents/hermes/README.md:19/:103` `extra_headers` → `default_headers`；`agents/README.md:189` 抓包目录应落 `MemoryProxy/docs/`；`README.docker.md:52/:76` 续行失效（本仓自伤）；`MemoryKnowledge/src/openapi.yaml` 缺自己代码已输出的 `source_type`/`source_url`。
- **[不适用]** MongoDB 部署链（本仓 `server.ts:2260-2263` 后端枚举无 mongodb）、JEV 部署变量、私有仓 SSH 克隆部署。

---

## 7 采纳路线

**P0（本周可做，全部 S，纯局部）**：#114 #115 #116 #117 #118 #120 #121 #122 #124 #125 #126
**P1（需裁决后再动）**：#123（H-15 语义）、#127（是否收窄）、#128（provider 抽象 + 权限面 + 凭据面）、#129（合并铁律确认）
**P2（能力缺口，择机票化）**：#131
**治理**：#130

建议的第一个批次：#121 + #122 + #117 + #118（全是「已定位、有上游现成修法、零冲突」的 S 级），一个 PR 一个模块。

---

## 8 合并铁律（已提请 #129 固化）

1. **不跟 MemoryProxy pipeline 重构**（stages/runners 删本仓 5 个 handler / 8171 行）。
2. **不跟 store 目录化**（`sqlite.ts` / `tcvdb.ts` 是本仓定制本体，整取上游 = 编译通过但行为静默退化）。
3. **不引入第二套凭据真源**（ADR-0006）：JEV `apiKeyEnv`、task-draft env 覆盖、`knowledge_source_credential` 均不采纳。
4. **不跟 MongoDB 后端**（后端枚举无 mongodb；mongo memory-store 不知 soul-columns）。
5. **拒绝式合并 `promptMode` 缺省 `chat → code`**（语义翻转，只吸注释）。

另加两条「禁止整文件取上游」红线：`auto-recall.ts`（会绕过 ADR-0008 全部刻度门）、`gateway/server.ts`（上游无 `/v3/recall`）。

---

## 9 未决问题（需维护者拍板）

1. **H-15 fail-fast**（`configMissingEmbedding` 抛出）是刻意 fail-loud 还是要降级？见 #123。
2. **TaskSourceType** 是否跟随上游收窄？见 #127。
3. **Wiki 外部来源**抽象方向（provider registry 还是维持 Git 源唯一实现）与**权限面**是否放开给同 team 成员？见 #128。
4. **profile-scope 抽取主键稳定性**（须验 `profile:v1:<sha256>`）。
5. **合并铁律**是否落 ADR-0009？见 #129。
6. **交易/计价**面：上游 `credit-reporter`/`pricing` 几乎重写（涉钱），是否单独立项评估。

---

## 附录 A 资产清单（`.local/upstream-sync/`，只读）

`tree-head.json`（1259 blob）、`tree-v201.json`（983 blob）、`local-tree.txt`（1835 blob）、`analysis.json`（headMap/baseMap/localMap）、`commits-head.tsv`（71 commit）、`commit-files.tsv`（1930 行）、`modules/_delta-<模块>.tsv`、`modules/_ours-<模块>.tsv`、`modules/_conflicts.tsv`（160）、`version-windows.md`、`BRIEF.md`、`modules/{MemoryCore,MemoryProxy,MemoryPanel,MemoryKnowledge,平台面…}.md`、`probes/noop-embedding-probe.ts`、`v201/`（39 个冲突文件的 v2.0.1 版）、`diffs/*.diff`。

上游快照：`D:/TDB/tdam-upstream/`（1225 个非 assets 文件，逐个 `git hash-object` 与树 sha 校验，0 missing 0 mismatch）。

## 附录 B 票索引

| 票 | 标题 | 判定 |
|---|---|---|
| [#113](https://github.com/cxin21/tdb-hechen/issues/113) | [map] 上游同步路线图 | map |
| [#114](https://github.com/cxin21/tdb-hechen/issues/114) | ingest-v2 落盘越界/原型链污染 | bug · P0 |
| [#115](https://github.com/cxin21/tdb-hechen/issues/115) | 知识服务鉴权缺失 | bug · P0 |
| [#116](https://github.com/cxin21/tdb-hechen/issues/116) | asset 读越权 | bug · P0 |
| [#117](https://github.com/cxin21/tdb-hechen/issues/117) | dsh aux 404 | bug · P0 |
| [#118](https://github.com/cxin21/tdb-hechen/issues/118) | AGENTS.md 丢弃 | bug · P0 |
| [#119](https://github.com/cxin21/tdb-hechen/issues/119) | deploy 三处脚本缺陷 | bug · P0 |
| [#120](https://github.com/cxin21/tdb-hechen/issues/120) | asset-import JSONC 崩溃 | bug · P0 |
| [#121](https://github.com/cxin21/tdb-hechen/issues/121) | 内核三小修 | bug · P0 |
| [#122](https://github.com/cxin21/tdb-hechen/issues/122) | l1-extractor think/空因 | bug · P0 |
| [#123](https://github.com/cxin21/tdb-hechen/issues/123) | embedder Noop + H-15 | bug · P1 |
| [#124](https://github.com/cxin21/tdb-hechen/issues/124) | Panel B1–B4 | bug · P0 |
| [#125](https://github.com/cxin21/tdb-hechen/issues/125) | Panel B5/B6/B7/A11 | bug · P0 |
| [#126](https://github.com/cxin21/tdb-hechen/issues/126) | 文档五处 | docs · P0 |
| [#127](https://github.com/cxin21/tdb-hechen/issues/127) | TaskSourceType 收窄 | bug · P1 |
| [#128](https://github.com/cxin21/tdb-hechen/issues/128) | Wiki provider 抽象裁决 | 裁决 · P1 |
| [#129](https://github.com/cxin21/tdb-hechen/issues/129) | 合并铁律固化 | 裁决 · P1 |
| [#130](https://github.com/cxin21/tdb-hechen/issues/130) | CHANGELOG 台账缺口 | 治理 |
| [#131](https://github.com/cxin21/tdb-hechen/issues/131) | 上游能力缺口盘点 | P2 |
