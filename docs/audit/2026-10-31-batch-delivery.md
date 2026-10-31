# 2026-10-31 本批交付台账（WP1–WP10）

> **本文件是索引，不是判定。** 每张票的根因分析、第一性原理推演、处置取舍见 `docs/audit/2026-10-31-open-issues-first-principles.md`；本文件只回答三个问题：**这批改了什么（文件:行）／怎么复验／哪些还没做完**。

**快照信息**

- 采集时刻：2026-10-31 19:5x（Asia/Shanghai），工作树未提交，HEAD = `17c0582`（= main 基线）。

- 工作树规模：`git status --porcelain` 104 条 = 64 files changed（+2371/−240）+ 44 未跟踪。本批所有内容都在工作树里，**没有 commit**。

- **所有行号是上述快照的瞬时值**，并行改动会让它漂移。用法：按「文件 + 锚点文本」grep，不要死认行号。行号只用来缩小 grep 范围。

- 任务板：task-1..task-10（WP1–WP10）。采集时 task-1（WP1）与 task-8（WP8）仍是 `in_progress`；采集后 task-8 已 `completed`（rev4），**task-1 仍是 `in_progress`**，故 §1 里 WP1 的四票按「代码已在树」记。task-11（本文件）不在板面上，故无 claim 记录。

---

## §0 先说结论：本批不构成生产放行的理由

按严重度排序。**第 1 条最重要，读到这里就够了。**

| # | 理由 | 证据 |

|---|---|---|
| 1 | **bench 用本地全开档，生产跑全关档。** 本批所有召回读数（82.2%/78.8%/94.0%、84.4%/79.3%/92.9%、matched +6.44pp 等）都来自 `MemoryCore/tdai-gateway.yaml` 这份 **gitignored 的本地开发档**（`.gitignore:142`）；而 `deploy/global-images/start-memory-core.sh:60-105` 每次启动用 `MEMORY_*` env **重写** yaml，内容不含本批任何一个键 ⇒ global-images 生产落点 = **代码缺省**（写侧 factKey/supersession 全关、`validity.mode` = hard、`rerank.enabled` 缺省 false）。云模板 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:61-63`（factKey false）/`:74-75`（supersession false）/`:153-154`（factChannel false）/`:210-211`（validity hard）同为关/hard。 | `docs/ops/config-default-ledger.md` §0；`docs/optimization-results.md:1761`/`:1767` |
| 2 | **写侧增强在生产默认不启用。** #168（写侧事实键）与 #149（观测窗）都以「写侧开」为前提，但生产三套真源（云模板 / global-images 生成档 / 代码缺省）里写侧全是关。#149 演练单因此只能演练「关回退」，不能证明「开」在生产可用。 | `docs/ops/rollback-drill.md` §2；`deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:61-63` |
| 3 | **生产启动仍无 `config.effective` 快照。** M6 只把 `effectiveRecallSnapshot` 落进 **bench 报告**（`MemoryCore/scripts/eval-memory-bench.mjs:706`），网关启动路径没有等价输出 ⇒ 生产上「配置到底生效了哪一档」只能靠 yaml 原文 + `config-override.json` 内容 + bench 报告 config 段 + journal 门四者交叉推。 | `eval-memory-bench.mjs:706`/`:723`/`:1263-1327`；`docs/ops/rollback-drill.md` §1.4 |
| 4 | **验收只到单测级。** #174/#148/#155/#151/#156/#172/#92/#123 的证据是单测（本机 187 例通过 = 133 + 32 + 22，见 §4），**没有一张有 LME90 或生产 journal 的复跑读数**。#168 只有 offline-hash 冒烟（3 cases / 147 轮 / 23 更新 / 6 题，`docs/long-session-bench.md:126` 明写「真实 embedding 下的读数：未验证」）。 | §4 测试清单；`docs/long-session-bench.md` §6 |
| 5 | **判分尺只对新报告生效。** M8 的把关（judge = 空/超时/% 低于 95% ⇒ exit 3）在 `bench-report.mjs:16`、`bench-bucket-paired.mjs:37`，只作用于**新生成**的报告；历史库里 `judged=0` 的旧报告仍在，A/B 对照时不能直接引用。 | `MemoryCore/scripts/lib/bench/report.mjs:2`/`:78` |
| 6 | **#66 观察窗未到期。** 三次 live 实跑（10-25 / 10-27 / 10-28）只积到 MiniMax 窗 2/10 个有效点，日历下限已后移到 **不早于 2026-11-10**；10-26 缺测、10-29/10-30 配额拒绝（402 insufficient_balance_error 2067）。 | `docs/superpowers/evals/behavior-golden/shadow/README.md:5-7`/`:43` |

## §1 逐票台账

状态口径：**已落地** = 代码在树、单测在树并通过；**半成品** = 只落了一部分，或落了但缺读数；**治理项** = 门禁/文档类，无运行时行为。

| 票 | WP | 状态 | 关键落点（文件:行） | 自动化依据 |

|---|---|---|---|---|
| #174 三态判定序 | 1 | 半成品（代码已落地，bench 断言未同步） | `MemoryCore/src/core/recall/validity-policy.ts:39`（注释「定序 = 显式退出优先于 mode」）/`:44` `excludeInvalidatedFor`/`:59` `validityPolicyOf`/`:147` `shouldHardDropValidity`/`:180` `demoteSoftValidity`/`:197` `selectByValidity`；唯一消费点 `core/hooks/auto-recall.ts:1021`+`:2833`；结论层同源时间 `:1028` | `src/core/recall/__tests__/validity-policy.test.ts`、`src/core/tools/__tests__/memory-search-normalized-validity.test.ts` |
| #148 soft 沉底+降权 | 1 | 已落地 | `MemoryCore/src/config.ts:2199-2207`（解析块）、`:2204` `softPenalty`（clamp[0,1]，缺省 0.5）、`:2205` `hardOnPresentIntent`（缺省 true）；乘子唯一解析点 `validity-policy.ts:99`/`:105`；工具路 `core/tools/memory-search.ts:1187`（裁断前）、`:1601`、`:1797`（注释：改主序必须早于精排） | `src/core/tools/__tests__/memory-search-normalized-validity.test.ts`、`src/core/hooks/__tests__/inject-order.test.ts`（同 §4 第 1 组） |
| #155 读面证据计数 / 写面键名 | 1+2 | 已落地（无生产 journal 数据） | 读面 `core/hooks/auto-recall.ts:1445-1467`（三计：图边 / 旧键回退 / 零证据）+ canonical `evidence_ids` 优先、旧键 `evidence_record_ids` 兼容回退；journal 门 `core/recall/recall-journal.ts:142-146`。写面 `consolidation/consolidation-worker.ts:221`（注释）+`:233`（`addLink` await，签名 `MaybePromise<boolean>`） | §4 中 `consolidation-worker.write-side` 等 |
| #151 融合单源化 | 1 | 已落地 | `core/recall/fusion.ts` 函数级单源：`RRF_IDENTITY_WEIGHTS:31`、`WEIGHTED_DEFAULT_WEIGHTS:34`、`NORMALIZED_DEFAULT_WEIGHTS:43`、`factChannelWeightOf:76`、`fusionWeightsOf:88`、`normalizedFusionEnabled:101`、`cosineNormOf:109`、`minMaxNormOf:119`、`normalizedRelevanceOf:132`、`recencyHalfLifeDaysOf:146`、`recencyNormOf:158`、`validityNormOf:176`；工具路 `memory-search.ts:117`/`:215`/`:221`/`:229`/`:250`（通道观测 + normalized 主序）/`:979`；钩子路 `tdai-core.ts:496`/`:499`；两路同源断言 `gateway/v2-router.ts:1704-1706` | `src/core/tools/__tests__/memory-search-normalized-validity.test.ts`、`src/core/recall/__tests__/inject-wrapper.test.ts`（§4 第 1 组） |
| #156 自述记忆过度提取 | 2 | 已落地 | `MemoryCore/src/core/prompts/l1-extraction.ts:71` 禁提项由「AI助手自身的行为或输出」收窄为「助手对用户的一次性寒暄、确认或空泛回复」；自述块 `:429` `AGENT_ACT_BLOCK`、`:440` `selfIdentityEnabled`、`:453` 拼接条件（`mode !== "code"` 才追加） | `src/core/prompts/l1-extraction.single-source.test.ts`、`src/core/record/l1-extractor.assistant-act.test.ts` |
| #172-② 注入文案档位 | 1 | 半成品（**缺省未翻**） | `MemoryCore/src/config.ts:518-522`（类型）、`:2253`（解析：`"neutral" / "calibrated"` 才认，其余一律 `"legacy"` ⇒ 缺省 legacy）；`core/recall/inject-wrapper.ts:14`/`:21`（文案「以下是与问题相关的历史记忆，请据此回答；若信息不足再说明。」）/`:26`；注入点 `auto-recall.ts:102`/`:2181` | `core/recall/__tests__/inject-wrapper.test.ts`、`inject-order.test.ts` |
| #173-A 休眠面标注 | 1 | 半成品（**可删集合为空**，仅加注释） | `MemoryCore/src/config.ts:144-153` 的 `@evidence` 块，逐项标注 nativeMinRRF / coreRefBoost / graphDiscount / sceneBoost / ppr* / maxCharsPerMemory / maxTotalRecallChars / rerank.minScore / importancePenalty 为「按后端/按档休眠，非死码」；B 组拆票未做 | 无（纯注释） |
| #124-B1 面板类型下推 | 3 | 已落地 | `MemoryPanel/src/panel/http/routes/chat-memory.ts:247-294`（`asset_types: ["chat_memory"]` 下推 `:272`、`FA_PAGE_SIZE = 100`、按 `total` 收敛、去掉 500 条硬上限） | `MemoryPanel/tests/chat-memory-agent-fixed.test.ts` |
| #124-B2 刷新时序 | 3 | 已落地（**web 无自动化**） | `MemoryPanel/web/src/pages/ChatMemoryPage/hooks/useChatMemory.ts:154`（`refreshNonce`）/`:237`（依赖注入）/`:321` | 无测试文件（`MemoryPanel/web/src` 下 `*.test.*` 为 0）⇒ 只能人工 |
| #124-B3 TabBar 键盘/无障碍 | 3 | 已落地（**web 无自动化**） | `MemoryPanel/web/src/layouts/TabBar/index.tsx:32-33`（`tabIndex={0}` / `aria-selected`）、`:55`（关闭按钮 `aria-label` 走 i18n `tabbar.close`） | 无 |
| #124-B4 拖拽残留样式 | 3 | 已落地（**web 无自动化**） | `MemoryPanel/web/src/lib/useResizable.ts:24`（`prevBodyStyles` useRef 快照）/`:31`/`:34`（还原并清空） | 无 |
| #125-B6 端点 URL 写死 | 3 | 已落地 | `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx:311`（`iid = auth?.instance_id ?? "[instance-id]"`）、`:332-335`（OpenClaw/Hermes 由写死 `/default` 改为 `base + /openclaw/ + iid`） | 无（web 侧） |
| #125-B7 env 空串 | 3 | 已落地 | `MemoryPanel/src/panel/config/panel-config.ts:11-16`（`env()`：`trim()` 后空串视为未设、回落 fallback） | `MemoryPanel/tests/panel-config-env.test.ts` |
| M12 手工记忆来源 | 3 | 已落地 | `MemoryPanel/src/panel/http/routes/chat-memory.ts:492`（`source_type: "manual"`，原硬写 `"uploaded"`） | `MemoryPanel/tests/chat-memory-agent-fixed.test.ts` |
| #123 四态健康 | 3+5 | 已落地 | 内核：`MemoryCore/src/core/store/embedding.ts:720`/`:750`/`:754-758` `hasClientEmbedding`（noop ⇒ false）；`gateway/server.ts:68`（import）/`:157`（判定注释）/`:188`+`:374`（降档归因 not-configured / noop-embedder / probe-failed）/`:964-975`（同一杆秤）；注入点 `core/store/store-pool.ts:363`/`:402`、`core/storage/factory.ts:88`；面板：`MemoryPanel/web/src/pages/ChatMemoryPage/utils/health-utils.ts:42-108`（ok / degraded / unconfigured / unknown，`configured` 优先） | `src/core/store/embedding.has-client-embedding.test.ts`、`src/gateway/memory-health.test.ts`、`MemoryPanel/tests/chat-memory-health.test.ts` |
| #152-① 能力位守卫 | 5 | 已落地 | `core/store/capability-guard.ts:25` `ensureCapability`（WARN-once，key = capability 与 impact 拼接去重）、`:44` `ensureL1FactVec`、`:56` 能力位名 `l1FactVec`；能力位声明 `core/store/types.ts:350`；tcvdb 侧 `core/store/tcvdb.ts:767`（零实现）；启动审计 `gateway/server.ts:746` | `src/core/store/capability-guard.test.ts` |
| #92 自动采纳三门 | 5 | 已落地（无生产数据） | `core/store/sqlite.ts:3368` `listRejectedSelfIdentityPending`（门② 全量、无 LIMIT）、`:3390` `commitAutoAdoptCore`（事务）、`:3312`（区块注释）；`core/selfidentity/auto-adopt-gate.ts:45`/`:47`/`:68`/`:74`/`:77`/`:120`（读失败回落 + WARN）；类型 `core/types.ts:826`/`:833`/`:836` | `src/core/lifecycle/auto-adopt-gate.test.ts`（§4 第 1 组） |
| M6 effective 快照 | 4 | 已落地（仅 bench） | `MemoryCore/scripts/eval-memory-bench.mjs:706` `effectiveRecallSnapshot`、`:707` 逐键 log、`:723` `assertExpectedConfig`（失配 exit 2）、`:1263-1327` `effectiveConfig`/`effectiveConfigSources`/指纹；`scripts/lib/bench/effective-config.ts:57`（`recall.excludeInvalidated.effective`） | `MemoryCore/__tests__/bench-report-gate.test.ts` |
| M7 报告只追加/归档 | 4 | 已落地 | `eval-memory-bench.mjs:1426`（只追加）；`scripts/archive-bench-reports.mjs` | 同上 |
| M8 判分门禁 | 4 | 已落地 | `scripts/lib/bench/report.mjs:2`/`:78`；`scripts/bench-report.mjs:16`（exit 3）；`scripts/bench-bucket-paired.mjs:37`（judged/total < 95% ⇒ exit 3）；`eval-memory-bench.mjs:1444`（把判分实况写进报告） | `MemoryCore/__tests__/bench-report-gate.test.ts` |
| #170 成本段 | 4 | 已落地 | `scripts/lib/bench/cost.mjs`；报告写入点 `eval-memory-bench.mjs:1446`；召回分段计时 `:1181` | 同上 |
| #168 长会话 harness | 4 | 半成品（**无真实读数**） | `scripts/gen-long-session-bench.mjs`、`scripts/lib/bench/long-session-corpus.mjs`、`scripts/lib/bench/long-session-metrics.mjs`、`docs/long-session-bench.md` | `MemoryCore/__tests__/long-session-bench.test.ts`；读数只有 offline-hash 冒烟 |
| #107 typecheck 基线 | 6 | 治理项（**基线待重锁**） | `MemoryCore/typecheck-baseline.json`、`MemoryCore/scripts/typecheck-gate.mjs`、`.github/workflows/ci.yml:65-102`（job `memorycore-gates`）、`MemoryCore/package.json`（`typecheck:gate` / `typecheck:baseline`） | 见 §2.5 |
| #108 prettier 门禁 | 6 | 治理项 | `MemoryCore/.prettierrc`（YAML 带注释，printWidth 120）、`.prettierignore`（含 `src/gateway/generated/`）、`scripts/format-changed.mjs`（两档：新增硬门 / 改动告警，`FORMAT_STRICT_MODIFIED=1` 转硬门）、`ci.yml:65-102`、`package.json`（`format` / `format:check` + devDep `prettier ^3.9.10`） | 见 §2.8 |
| #129 上游同步边界 | 6 | 治理项 | `docs/adr/0018-上游同步边界.md`（铁律 1-4 + 铁律 5 改写 + 两条红线 + 体量实测 8112/7059/3568/4312） | 文档 |
| #130 CHANGELOG | 6 | 治理项 | `CHANGELOG.md:1-13`（新增 `## 2026-10-31`，12 条，含两条欠账明写） | 文档 |
| #66 shadow 观察窗 | 6 | 治理项（**未到期**） | `docs/superpowers/evals/behavior-golden/shadow/README.md:5-7`（模型窗 + ε 同模型 ≥10 点 + 3 次 live 实跑 + 下限 ≥2026-11-10）、`:43`（配额拒绝订正） | 文档 + nightly 干跑（`probes-nightly.yml:73`/`:88`） |
| #149 回滚演练单 | 10 | 治理项（**演练记录空表**） | `docs/ops/rollback-drill.md`（§0 A/B 读数、§1 生效链、§2 八键回滚开关表、§3 S0–S8 命令、§4 八条陷阱、§6 空记录表） | 文档 |
| #154 缺省登记表 | 10 | 治理项（只登记不裁决） | `docs/ops/config-default-ledger.md`（§0 三套真源、§1 已登记五项、§2 不进模板两项、§3 待登记六项） | 文档 |
| #127 任务来源 canonical | 9 | 已落地 | `MemoryPanel/web/src/lib/api/tasks.ts:11`（`"manual" / "external" / "other"`）、`services/backendStore.ts:71`（re-export）/`:259`（不再折叠）、`pages/WorkbenchPage/components/TaskCreateDialog.tsx:23`；内核单源 `MemoryCore/src/core/store/types.ts:459`、`gateway/v2-schemas.ts:260-264`、`gateway/generated/types.ts:1180` | `MemoryPanel/tests/task-source-type.test.ts` |
| #175 dsh anthropic 协议 | 8 | 已落地（task-8 采集后已 complete；快照时仍在改） | `MemoryProxy/src/session/dsh/form.ts:157-164`（`protocol?: "openai" / "anthropic"`）/`:289-301`（anthropic 分支）/`:435-510`（空 thinking 占位 + stream 六事件）；路由 `MemoryProxy/src/server.ts:329`（显式注册 `/dsh/:spaceId/v1/messages`）；流尾 `anthropicHandler.ts:861`；双 wire shape `agent-adapters/dsh.ts` | `MemoryProxy/src/session/__tests__/dsh-form-protocol.test.ts`、`MemoryProxy/src/session/__tests__/dsh-anthropic-answer.test.ts`、`MemoryProxy/src/agent-adapters/__tests__/dsh.test.ts` |
| WP7 evidence 键名单源 | 7 | 已落地 | `MemoryCore/src/core/lifecycle/evidence-ids.ts:20`（`EVIDENCE_IDS_KEY = "evidence_ids"`）/`:22`（`LEGACY_EVIDENCE_IDS_KEY`）/`:53-54`（双读）；双写点 `reflection.ts:403`、`evolution-worker.ts:275` | `src/core/lifecycle/__tests__/evidence-ids-parity.test.ts` |

## §2 半成品与未完成（逐条带处置建议）

**2.1 #172-② calibrated 档缺省未翻。** `config.ts:2253` 仍回落 `legacy`。文案与解析都已就位，只差把缺省改成 `calibrated` 的决策 + 一次 A/B（现在没有任何 calibrated 对 legacy 的读数）。**拍板点**：是否本批翻？翻了就是生产行为变化，需先有读数。

**2.2 #173 可删集合为空。** 逐项核完发现 `config.ts:144-153` 列的键全部「按后端/按档休眠」，没有一个是死码 ⇒ 本批只加 `@evidence` 注释，B 组拆票未做。**结论**：这张票的「删代码」目标在当前代码上不成立，建议改判为「标注完成」。

**2.3 #168 无真实读数。** harness 齐了，只有 offline-hash 冒烟（3 cases / 147 轮 / 23 更新 / 6 题）。`docs/long-session-bench.md:126` 自己写着「真实 embedding 下的读数：未验证」。**处置**：等 write 侧在生产可用（§0-1 解决）后再跑，否则跑的是全关档。

**2.4 #149 演练记录空表。** `docs/ops/rollback-drill.md` §6 是空表，缺一次真跑。另：bench 没有「关写侧事实键」的旋钮，写侧回滚只能靠改 yaml + `--expect-config` 断言 + `--store` 新库重灌（§3 已写明）。

**2.5 #107 基线待重锁。** 采集时实跑：`cd MemoryCore && node scripts/typecheck-gate.mjs` → 打印「当前 243 errors / 44 files；基线 245 errors / 45 files；Δ=-2」，但**按组判 FAIL、exit 1**，唯一新增组是 `src/gateway/generated/schemas.ts` TS2552 3→5（`:1350` `ListWikiError`、`:1352` `wikiListRequestSchema` / `ListWikiMutationRequest`、`:1354` `ListWikiMutationResponse`、`:1363` `CreateWiki200`，全部 `Cannot find name ... Did you mean 'ListSkill*'?`）。根因：基线是在「并行成员改到一半」的瞬时态锁的（245/45），而当前工作树的 `generated/schemas.ts` 已回落到 HEAD 版本（243/44），组内结构从 TS2304×48/TS2552×3 变回 TS2304×46/TS2552×5 ⇒ 总数降了、组却变了。**处置（Lead 已定）**：不 `--update` 吞错、不改基线文件；全员收工后由 Lead 统一 `node scripts/typecheck-gate.mjs --update` 重锁并把退出码验成 0。另注：`generated/schemas.ts` 那 51 个错误应**重生成**而非手改（已进 `.prettierignore`）。

**2.6 #66 观察窗未到期。** 见 §0-6。日历下限 **不早于 2026-11-10**，旧的「2026-11-02」作废；10-26 缺测、10-29/10-30 是配额拒绝，均不补跑、继续缺日顺延。

**2.7 run-r141-factorial.sh 的 bench 断言未随 #174 同步（本批新发现，未修）。** `MemoryCore/scripts/run-r141-factorial.sh:81` 的 `EXPECT_W2_OFF` 仍写 `recall.excludeInvalidated.effective=soft`，而 `store.mjs:989-992` 已改成 flag 优先，实测 `effectiveExcludeInvalidated("soft", false) === false` ⇒ 用 `W2_OFF` 的 5 个臂（b0 / w1 / w3 / w3legacy / w1w3）跑 `--expect-config` 会**失配并 exit 2**。文件自己的 `:79-80` 注释还写着「等 #174 修了定序，本行要改成 effective=false」。**处置**：改用这些臂之前必须先改这一行（不属本批 scope，故只登记）。

**2.8 格式门禁的两个语义坑（用之前必须知道）。** ① 本地未提交改动**不进** `git diff base...HEAD`，所以默认跑 `format:check` 会打印「本次没有改到 MemoryCore/src 下的 .ts，跳过」并 exit 0 —— 这是对的（CI 看的是 commit），但别误读成「我的改动格式没问题」。② 显式文件参数一律按**新增硬门**处理，拿它去验一个存量已改动文件会直接红（存量 547/646 本就不符 `printWidth 120`）⇒ 显式参数只适合验**新增**文件。CI 走的是 diff 分档：新增 .ts 硬门、改动到的存量 .ts 只告警（`FORMAT_STRICT_MODIFIED=1` 才转硬门），理由写在 `format-changed.mjs` 头注与 `ci.yml:65-102` 的注释里：单一硬门会让所有在飞 PR 一起变红、逼人顺手 reformat，与 #108「格式变更必须独立 commit」相悖。

**2.9 MemoryPanel/web 无测试运行器。** `MemoryPanel/web/src` 下 `*.test.*` 为 **0 个文件** ⇒ B2（刷新时序）、B3（TabBar 键盘/无障碍）、B4（拖拽残留样式）、B6（端点 URL）**没有任何自动化**，本批验收只到「代码在树 + 类型通过」。要补得先给 web 侧接 vitest，不属本批。

**2.10 CONTEXT.md 的 ADR 索引。** 已补 0018 一行（`CONTEXT.md:48`）。其余 ADR（0001–0017）索引状况未复核，不在本批 scope。

## §3 与票面/审计的偏差（本批实测订正，供后续引用时以本节为准）

| 位置 | 票面/审计原文 | 实测 |

|---|---|---|
| #129 铁律 5 | 「上游 `start-memory-core.sh` 缺省 code，本仓 chat，语义翻转」 | **不成立**。`deploy/global-images/start-memory-core.sh:81-86` 与 `.local/upstream-sync/v201/deploy/global-images/start-memory-core.sh:75-78` **逐字同文**，两边都是 `promptMode: ${MEMORY_PROMPT_MODE:-chat}`。ADR-0018 已把铁律 5 改写为「本仓与上游同为 chat，差异在别处」。 |
| #129 体量 | 5 handler 8171 / sqlite 6755 / tcvdb 3566 / auto-recall 3256 行 | 5 handler **8112**（`MemoryProxy/src/{anthropic,codex,handler,workbuddy,auxiliary}Handler.ts`，注意在 `src/` 根、不在 `src/session/`）；sqlite 7059（复测 7134）、tcvdb 3568（3571）、auto-recall 4312（4365）。ADR-0018 已改用审计口径并写明数字会漂移。 |
| validity 缺省 | `docs/optimization-results.md:1761`（§21.3 台账）记「云模板 soft / 代码缺省 soft」 | 云模板 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:210-211` = `mode: "hard"`；代码缺省 `MemoryCore/src/config.ts:2199-2207`（`:2202` `str(vg,"mode")==="soft" ? "soft" : "hard"`）⇒ **hard**。只有 `MemoryCore/tdai-gateway.yaml:221-222` 是 soft。**已于 2026-10-31 订正该行**，并在 `:1767-1768` 补「三套真源」交叉引用。 |
| validity 缺省（第二处） | 同上一度记在 §24.9 | §24.9（`:2351-2356`「生产落点（全部 config 门）」）**没有 validity 行**；真正提到缺省的是 §25.2（`:2413`）与 §25.5 C（`:2500`），两处原文本就写 hard，已补「已订正 + 交叉引用」。 |
| STORE_MODE 位置 | 审计记 `server.ts:2262-2264` | 实测 `MemoryCore/src/gateway/server.ts:2355-2356`（`process.env.STORE_MODE === "sqlite"` 或 `=== "tcvdb"` 二者之一，注释 `:2353`）。ADR-0018 已改用新行号并声明「本 ADR 行号均为 2026-10-31 快照」。 |
| #129 红线 2 依据 | 「上游 `server.ts` 无 `/v3/recall`」 | 本仓快照里 `server.ts` **没有** `/v3/recall` 字面量；实证是 `gateway/v2-router.ts:1893` 的关闭文案「/v3/recall is disabled: memory.recall.v3Recall.enabled is false (code default)」+ 引用点 `:135`/`:301`/`:303`/`:584`/`:1839`。ADR-0018 已按此写。 |

## §4 复验命令（可直接粘贴）

全部在 `D:/TDB/td-agemem` 下执行。**只跑与本批相关的文件，不要跑全量**（`npm test` 由 Lead 统一跑）。

```bash
# 1) MemoryCore：14 个测试文件，本机实测 133 passed
cd MemoryCore && npx vitest run \
  src/core/recall/__tests__/validity-policy.test.ts \
  src/core/tools/__tests__/memory-search-normalized-validity.test.ts \
  src/core/recall/__tests__/inject-wrapper.test.ts \
  src/core/hooks/__tests__/inject-order.test.ts \
  src/core/lifecycle/__tests__/evidence-ids-parity.test.ts \
  src/core/lifecycle/consolidation/consolidation-worker.write-side.test.ts \
  src/core/store/capability-guard.test.ts \
  src/core/store/embedding.has-client-embedding.test.ts \
  src/core/lifecycle/auto-adopt-gate.test.ts \
  src/gateway/memory-health.test.ts \
  src/core/prompts/l1-extraction.single-source.test.ts \
  src/core/record/l1-extractor.assistant-act.test.ts \
  __tests__/bench-report-gate.test.ts \
  __tests__/long-session-bench.test.ts

# 2) MemoryPanel：4 个测试文件，本机实测 32 passed（vitest v2.1.9）
cd MemoryPanel && npx vitest run tests/task-source-type.test.ts tests/chat-memory-agent-fixed.test.ts tests/panel-config-env.test.ts tests/chat-memory-health.test.ts

# 3) MemoryProxy：3 个测试文件，本机实测 22 passed（vitest v3.2.7）
cd MemoryProxy && npx vitest run src/session/__tests__/dsh-form-protocol.test.ts src/session/__tests__/dsh-anthropic-answer.test.ts src/agent-adapters/__tests__/dsh.test.ts

# 4) typecheck 门禁（当前预期 exit 1：基线待重锁，见 §2.5）
cd MemoryCore && node scripts/typecheck-gate.mjs

# 5) 格式门禁（CI 语义：比 origin/main...HEAD 的 diff；本地未提交改动会跳过，见 §2.8）
cd MemoryCore && PRETTIER_BIN=$PWD/../MemoryPanel/web/node_modules/prettier/bin/prettier.cjs \
  GATE_BASE=origin/main node scripts/format-changed.mjs

# 6) 三套真源对照（判断「生产跑哪一档」）
grep -n "factKey\|supersession\|validity\|factChannel\|candidateK\|fusion\|presentTemporal\|smallToBig\|rerank" \
  MemoryCore/tdai-gateway.yaml deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml
sed -n "60,105p" deploy/global-images/start-memory-core.sh
```

## §5 归属与共存说明

- 本批所有内容都在**未提交的工作树**里。`git status` 看到的 104 条里，64 改 + 44 新增，跨 10 个 WP；本文件不承担 commit 边界规划。

- `docs/research/2026-10-25-92-observation-window-log.md` 与 `docs/superpowers/evals/behavior-golden/shadow/README.md` 的改动包含**前序成员**未提交内容；本轮只在 shadow README 上做增量补充（模型窗/存量/下限三条），未回退他人改动。

- WP1（task-1）在采集时仍 `in_progress`：那四票（#174/#148/#155 读面/#151）按「代码已在树」记，合并前可能还有变动，验收以 Lead 的最终 diff 为准。WP8 采集后已 complete。

- 行号会漂移。复验时按「文件 + 锚点文本」grep，别死认行号。
