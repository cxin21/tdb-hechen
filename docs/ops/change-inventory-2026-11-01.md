# 交付变更清单 — 2026-11-01（基线 HEAD 17c0582）

> 采集方式：只读 git（`git status --porcelain -uall`、`git diff --numstat`、`git diff -U0 <file>`），逐文件读过 diff 后写说明。**本轮没有执行任何 git 写操作**（未 add/commit/stash/checkout），所有改动仍在工作树里等你 review。
> 口径：**M** = 已跟踪文件被修改；**新** = 未被 git 跟踪的新文件（untracked）；**脏** = 历史遗留临时物（不在本轮交付内）。

## 0. 总览

| 域 | M（已跟踪） | 新（untracked） | 增行 | 删行 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| MemoryCore（主干） | 54 | 50（另有 9 个历史临时物，见 §3） | +2102 | −255 | 写/读面缺省对齐生产最优档、#155 证据键统一、#152 能力位守卫、skill 入口去重、#123 嵌入判活、bench 门禁与 CI |
| MemoryProxy | 9 | 5 | +434 | −94 | dsh v0.2 Anthropic 双协议（form 帧/分类器/路由显式注册/thinking 占位）、guide 单一源 re-export |
| MemoryPanel | 17 | 7 | +343 | −63 | 分页过滤下推、TaskSourceType 三值收敛、健康面板嵌入四态、#124 键盘/拖拽修复 |
| deploy | 4 | 2 | +172 | −87 | `--render-only/--dry-run` 可验证配置、云端 yaml supersession 翻转（#153） |
| agents / skills | 3 | 0 | +91 | −42 | dsh 双协议状态如实化、setup-proxy ≥v0.2 改测 `/v1/messages` |
| docs（含 ADR） | 4 | 25（ops 13 / specs 8 / audit 2 / 长会话 bench 1 / ADR-0018 1） | +52 | −16 | 口径更新 + 巡检补齐；新增 ops/specs/audit 文档 |
| CI / 仓库元 | 3 | 0 | +51 | 0 | memorycore-gates job、CHANGELOG 2026-10-31、ADR-0018 登记 |
| **dsh-plugin/（整目录新）** | 0 | **44** | — | — | 独立 npm 包（src 14 / test 15 + fixture 1 + helpers 3 / scripts 5 / 根文件 6），见 §2 |
| **合计** | **94** | **522**（untracked 全量文件数，含 dsh-plugin 44 / 根 scratch 379） | **+3245** | **−557** | `git diff --stat` 尾部读数 |

补充事实：
- 没有任何**删除**（`git status` 无 ` D ` 行）；无 submodule 变化。
- 4 个文件出现 **CRLF→LF** 警告：`CHANGELOG.md`、`MemoryCore/src/core/lifecycle/evolution-worker.ts`、`MemoryCore/src/core/lifecycle/reflection.ts`、`MemoryCore/src/gateway/memory-health.test.ts`（行尾归一化，diff 里会看到整段变化，review 时按“内容未变”跳过）。
- `dsh-plugin/` 整体 untracked ⇒ 里面队友的改动 git diff 看不到，只能按文件读（§2 已按文件列职责）。

## 1. 按域明细

### 1.1 MemoryCore · 记录管线与生命周期（写面）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/src/core/prompts/l1-extraction.ts` | M +1/−1 | #156：:71 的“不应该提取的内容”由「AI助手自身的行为或输出」改为「助手对用户的一次性寒暄、确认或空泛回复」，消掉与 `AGENT_ACT_BLOCK` 的正面矛盾（agent 自述行为只在一处定义） |
| `MemoryCore/src/core/lifecycle/consolidation/consolidation-worker.ts` | M +21/−2 | #155 写面：evidence_ids 改为累积去重双写（:221-230）；`addLink(...,"part_of")` 补 await 并逐边 soft-fail（:233-244） |
| `MemoryCore/src/core/lifecycle/evolution-worker.ts` | M +3/−1 | :275 证据键改用 `withEvidenceIds` 双写（与 consolidation 同源） |
| `MemoryCore/src/core/lifecycle/reflection.ts` | M +9/−1 | :403 反思卡 metadata 改 `withEvidenceIds({reflection,question,subject}, pr.evidence)`，canonical `evidence_ids` 与兼容 `evidence_record_ids` 同值 |
| `MemoryCore/src/core/lifecycle/evidence-ids.ts` | 新 5.8K | 新模块：键名常量、`normalizeEvidenceIds`、`readEvidenceIds`（两键合并去重、canonical 优先）、`withEvidenceIds` |
| `MemoryCore/src/core/lifecycle/auto-adopt-gate.ts` | M +67/−6 | #92 M1：自动采纳门②改用 `listRejectedSelfIdentityPending` 全量查询（缺实现即 WARN 并拒绝）；M2：槽写与 pending 落账单事务提交 |
| `MemoryCore/src/core/record/l1-writer.ts` | M +13/−5 | `[vec-dual-write]` 日志恒打 factKey 与 keyMode；`ensureL1FactVec` 改能力位守卫（#152 ①，替换 typeof 探测） |
| `MemoryCore/src/core/record/write-policy.ts` | M +17/−2 | `DEFAULT_WRITE_POLICY.supersession.enabled=true`（:101，附长会话 bench 读数与回滚阀门）；factRows 显式关，不再靠键缺失 |
| `MemoryCore/src/core/store/capability-guard.ts` + 同名 test | 新 3.4K/3.2K | 能力位守卫工具：存储能力未声明时 fail-closed + WARN（供 l1FactVec 用） |

### 1.2 MemoryCore · 召回 / 读面

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/src/core/hooks/auto-recall.ts` | M +209/−39 | 内联 MEMORY_TOOLS_GUIDE 正文删除改 re-export 单一源（:344-350）；`validityPolicyOf` 三态替代旧 mode 判断（:1013）；#155 证据三计（s2bWithLinks / s2bFromMetadata / s2bWithoutEvidence）与 metadata 回退；证据包上限 6 会话 |
| `MemoryCore/src/core/recall/validity-policy.ts` | M +73/−1 | 新增 `ValidityPolicy = "off" / "hard" / "soft"` 与 `validityPolicyOf(mode,flag)`（#174：显式关优先于 mode，旧实现 soft 盖住 false） |
| `MemoryCore/src/core/recall/inject-wrapper.ts` | 新 5.6K | 注入包裹语三档（calibrated 缺省 / neutral / legacy），`injectWrapperHeadOf`/`injectWrapperModeOf` |
| `MemoryCore/src/core/recall/evidence-pack.ts` | 新 6.4K | #169 证据包邻接行装配（同 session 相邻行 + 窗口/上限），只展示不设门禁 |
| `MemoryCore/src/core/recall/recall-journal.ts` | M +27/−0 | 观测块增 evidenceFromLinks / evidenceFromMetadata / cardsWithoutEvidence 与 evidencePack 计数 |
| `MemoryCore/src/core/tools/memory-search.ts` | M +163/−21 | fusion 权重 / soft validity 刻度 / factChannel 归一化接入，与钩子路同乘子（修工具路与钩子路的排序分叉） |
| `MemoryCore/src/core/tdai-core.ts` | M +6/−0 | :496 透传 fusion / validitySoftPenalty，与工具路对齐 |
| `MemoryCore/src/core/prompts/memory-tools-guide.ts` | 新 3.2K | guide 单一源（正文 + 版本号），两处诱导拒答措辞按 bench tuned 改写 |
| `MemoryCore/src/core/prompts/answer-guidance.ts` | 新 3.7K | 答案口径段（币值判定 + 建议类口径），逐字对齐 `scripts/lib/bench/llm.mjs` 的 prod-block-v2-currency+pref |

### 1.3 MemoryCore · store / metadata

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/src/core/store/embedding.ts` | M +26/−0 | #123：NOOP_EMBEDDING_PROVIDER="noop" + `hasClientEmbedding()`，供 health 判活 |
| `MemoryCore/src/core/store/sqlite.ts` | M +89/−4 | 新增 `listRejectedSelfIdentityPending`（:3368-3440，零 LIMIT，供 #92 门②） |
| `MemoryCore/src/core/store/types.ts` | M +24/−1 | StoreCapabilities.l1FactVec 能力位 + MaybePromise 契约注释 |
| `MemoryCore/src/core/store/tcvdb.ts` | M +3/−0 | 显式声明 l1FactVec:false（能力位对齐） |
| `MemoryCore/src/core/store/factory.ts` / `store-pool.ts` | M +2 / +8 | 能力位注入点与判活口径注释 |
| `MemoryCore/src/core/store/task-source-type.ts` + 3 处测试 | 新 3.4K | #127 taskSourceType 三值 manual / external / other 归一（历史 github/tapd → external） |
| `MemoryCore/src/metadata/{types.ts,store/sqlite-adapter.ts,store/mongodb-adapter.ts}` | M +7/+11/+22 | #127 读写归一：两种后端写前归一、读后兼容旧值 |
| `MemoryCore/src/metadata/router/v3-meta-schemas.ts` | M +10/−1 | zod preprocess 归一三值，非法值不再 400 |

### 1.4 MemoryCore · skill 会话管线（去重）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/src/core/skill/conversation-add/add-handler.ts` | M +100/−40 | 接入 dedupe.ts：(session,role,content) 指纹窗口幂等，全重复时仍返回 ok（不新增枚举），阈值只计唯一消息 |
| `MemoryCore/src/core/skill/conversation-add/dedupe.ts` | 新 4.7K | 指纹环实现：dedupeMessages / messageFingerprint，窗口 10min / 200 条 |
| `MemoryCore/src/core/skill/conversation-add/buffer-storage.ts` | M +23/−0 | SessionMeta.recent_fingerprints（:56-63）；updateMeta 改读改写保留未知字段（:230-244） |
| `.../conversation-add/index.ts` / `.../wire.ts` | M +10 / +11 | 导出与依赖透传 dedupeWindowMs / dedupeMaxEntries |
| `MemoryCore/src/gateway/skill-handlers.ts` | M +6/−7 | force-archive 改 updateMeta（保留指纹环） |

### 1.5 MemoryCore · 配置 / 网关

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/src/config.ts` | M +160/−22 | 实质 3 处：recall.maxResults 缺省 5→10（:2138）、recall.supersession.enabled 缺省 true（:2099）、新增 recall.evidencePack 块（:544）+ recall.injectWrapper（:527，缺省 calibrated）+ validity.softPenalty/hardOnPresentIntent（:307）；其余为 #173-A 休眠键台账注释 |
| `MemoryCore/src/gateway/server.ts` | M +163/−19 | #123 health 增 embeddingProvider / embeddingConfigured / 最近成功写入时刻，degraded 标 noop-embedder；另含 #175 等 |
| `MemoryCore/src/gateway/v2-router.ts` | M +7/−0 | `/v3/atomic/search` 透传 fusion / validitySoftPenalty / factChannel |
| `MemoryCore/src/gateway/v2-schemas.ts` / `generated/{schemas,types}.ts` | M +11/−2、+4/−1、+3/−2 | #127 三值 schema + 手写生成物同步 |

### 1.6 MemoryCore · bench 脚本 / CI / 包元

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryCore/scripts/eval-memory-bench.mjs` | M +184/−15 | 接入 effective-config / judging-stats / cost / offline-embedding；新增 --offline-embedding（读数明确“不是检索质量”） |
| `MemoryCore/scripts/lib/bench/inject-attribution.mjs` | M +49/−11 | #169 ADJACENCY_BADGE="·[邻]" 与 adjacent 归因，邻接行与 seed 行分开计 |
| `MemoryCore/scripts/lib/bench/store.mjs` | M +17/−2 | prepareBenchYaml 支持 evidencePack 覆盖；effectiveExcludeInvalidated 改“显式 false 优先于 mode”（#174） |
| `MemoryCore/scripts/{bench-gates,bench-report,bench-bucket-paired}.mjs` | M +19 / +15−2 / +11 | 证据包只展示不门禁；M8 enforceJudgeGate（判分覆盖不足即报告 invalid，--allow-unjudged 例外） |
| `MemoryCore/scripts/run-r141-factorial.sh` | M +4/−3 | EXPECT_W2_OFF 同步 #174 定序修正 |
| `MemoryCore/package.json` | M +5/−0 | 新增 typecheck:gate / typecheck:baseline / format / format:check，devDep 加 prettier ^3.9.10 |
| `.github/workflows/ci.yml` | M +37/−0 | 新 job memorycore-gates：typecheck 基线门禁（只允许不增加）+ 仅对改动文件的 prettier 门禁 |
| `MemoryCore/openclaw-plugin/src/format.ts` | M +14/−16 | 改 import prompt-context 镜像；formatL1Memories 由裸块改为 包裹语 + 记忆行 + 口径段 |
| `MemoryCore/openclaw-plugin/src/prompt-context.ts` | 新 3.0K | 跨包镜像（独立包不能引用 MemoryCore/src），逐字一致性由 parity 测试守 |

### 1.7 MemoryProxy

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryProxy/src/agent-adapters/dsh.ts` | M +75/−17 | v0.2 Anthropic Messages 双协议实测口径（system 在 body.system、user content 是 block array、tool_result 在 role:user；classifyRequest 三重信号；extractUserText 认两种形状） |
| `MemoryProxy/src/session/dsh/form.ts` | M +196/−13 | form 帧双协议 builder：Anthropic 六事件 tool_use SSE（message_start→…→message_stop）+ OpenAI v0.1.x 三 chunk 兼容 |
| `MemoryProxy/src/anthropicHandler.ts` | M +18/−0 | #175 session-init form 帧必须带合法 thinking 字段，否则下游 SSE 修复流解读失败 |
| `MemoryProxy/src/server.ts` | M +13/−4 | #175 显式注册 `/:agent/:spaceId/v1/messages`（此前靠通配隐式命中，端点缺失难排查） |
| `MemoryProxy/src/session/index.ts` | M +4/−0 | handleSessionInit 透传 protocol（漏传会让 v0.2 收到 chat.completion 帧而断链） |
| `MemoryProxy/src/session/codebuddy/cleaner.ts` | M +91/−1 | stripInitArtifacts 增 anthropic block 形态（tool_use/tool_result）清理 |
| `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` | M +14/−56 | 删本文件内联 MEMORY_TOOLS_GUIDE 正文，改 re-export 单一源 |
| `MemoryProxy/src/injection/injectors/tdai-tools-injector.ts` | M +12/−0 | 新增 listRegisteredToolNames()，保证“提示词讲的工具”== “块里注册的工具” |
| `MemoryProxy/src/tdai/pending-writes.ts` | M +11/−3 | 注释按实测改写：去重责任在各链路入口，不假设下游管线幂等（引 docs/ops/skill-feed-dedupe-evidence.md） |
| `MemoryProxy/src/injection/injectors/memory-tools-guide.proxy.ts` + parity 测试 | 新 2.3K | proxy 侧 guide 适配版（工具名改本代理注册名）+ 与 core 单一源逐字对照测试 |

### 1.8 MemoryPanel

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `MemoryPanel/src/panel/config/panel-config.ts` | M +17/−5 | env() 空串/纯空白视为未设置回落 fallback（此前 ?? 会把空的 KNOWLEDGE_AUTH_TOKEN 当有效值） |
| `MemoryPanel/src/panel/http/routes/chat-memory.ts` | M +20/−23 | list 的类型过滤下推到 store，不再“取一页再内存过滤”导致分页窗口错位 |
| `MemoryPanel/web/src/lib/api/tasks.ts` + types.ts + backendStore.ts + TaskCreateDialog.tsx | M +25/−1、+3/−1、+12/−2、+6/−1 | #127 TaskSourceType 三值收敛为单一定义，删掉三份副本改 import / re-export |
| `MemoryPanel/web/src/lib/useResizable.ts` | M +29/−8 | #124-B4：拖拽前快照 body 内联 cursor/user-select，结束后恢复 |
| `MemoryPanel/web/src/layouts/TabBar/index.tsx` | M +7/−1 | #124-B3：keydown 只响应 tab 自身（e.target===e.currentTarget），关闭按钮按 Enter 不再误激活 |
| `MemoryPanel/web/src/pages/ChatMemoryPage/utils/health-utils.ts` | M +41/−2 | #123 嵌入四态：embeddingProvider/embeddingConfigured，unconfigured 与 degraded 分档 |
| `MemoryPanel/web/src/pages/ChatMemoryPage/hooks/useChatMemory.ts` | M +45/−6 | options.keepList 静默重取（刷新不再闪空列表） |
| `.../ChatMemoryPage/components/{ChatMemoryPanel,BlockDetail}.tsx` + css | M +24/−5、+31/−6、+7 | “嵌入未配置”独立样式与 title；详情增手动刷新与单侧起止时间 |
| `MemoryPanel/web/src/i18n/{zh-CN,en-US}.ts` | M +3 / +3 | 新增 tabbar.close、memory.health.embeddingUnconfigured、memory.detail.refresh |
| `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx` | M +4/−2 | OpenClaw/Hermes 的 spaceId 不再写死 /default，改当前实例 id |

### 1.9 deploy / agents / docs / 仓库元

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `deploy/global-images/start-memory-core.sh` | M +101/−78 | 新增 --render-only / --dry-run（只渲染配置不启动），落实“配置真源可验证” |
| `deploy/global-images/_lib.sh` | M +7/−1 | 新增 TDAI_SKIP_DOCKER_PROBE=1，供 --render-only / CI 无 docker 环境渲染 |
| `deploy/global-images/.env.example` | M +17/−0 | 补 MEMORY_PROMPT_MODE=chat 与 embedding 段说明（不配 = provider none、混合检索降级） |
| `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | M +47/−8 | #153 裁决：翻转 supersession，附三臂读数（B 臂 0%/100%/1.0 vs A 臂 33.3%/100%/7.67）、cardinalityGate 护栏、回滚动作指向 docs/ops/production-profile.md |
| `deploy/global-images/{tdai-gateway.base.yaml,check-config-consistency.mjs}` | 新 20.6K/7.4K | 云端渲染基座 + 一致性校验脚本 |
| `agents/README.md` / `agents/dsh/README.md` / `agents/skills/setup-proxy/SKILL.md` | M +10/−4、+64/−35、+17/−3 | dsh 双协议（v0.1 OpenAI / v0.2 Anthropic）状态如实化；dsh ≥ v0.2 改测 /v1/messages |
| `docs/optimization-results.md` | M +15/−13 | 三处口径：只钉有实测作用的键、W2 supersession 缺省翻转、写/读面门控指向 write-policy.ts / validity-policy.ts |
| `docs/research/2026-10-25-92-observation-window-log.md` | M +29/−1 | 补 10-26~10-31 每日巡检拍数（全 0、新提案 0/12） |
| `docs/superpowers/evals/behavior-golden/shadow/README.md` | M +6/−2 | live 实跑 3 次；日历下限改 2026-11-10 |
| `docs/adr/0010-双状态属性契约与软失效.md` | M +2/−0 | 补 supersession 缺省翻转注记 |
| `CHANGELOG.md` | M +13/−0 | 2026-10-31 条目（MemoryKnowledge ingest-v2 落盘越界、drizzle+sync_error、SERVICE_KEY、openapi 对齐、H-15 失败信号） |
| `CONTEXT.md` | M +1/−0 | 登记 ADR-0018 |
| `docs/adr/0018-上游同步边界.md` | 新 6.6K | 新增 ADR：上游同步五条铁律与两条红线 |


### 1.10 MemoryCore 新增文件（untracked，未在上面按域列出的部分）

| 文件 | 职责 |
| --- | --- |
| `MemoryCore/scripts/typecheck-gate.mjs` | 门禁脚本：读 typecheck-baseline.json，错误数不得增加，--update 重写基线 |
| `MemoryCore/scripts/format-changed.mjs` | 只对 git 改动文件跑 prettier（存量 545+ 文件不格式化） |
| `MemoryCore/scripts/archive-bench-reports.mjs` | M7 配套：把历史 bench 报告按 `<stem>-<时间戳>-<配置指纹sha8>.json` 归档（缺省 dry-run），救回被同名重跑覆盖的判分行 |
| `MemoryCore/scripts/gen-long-session-bench.mjs` | #168 长会话退化基准：场景生成 + 三臂跑法（默认 dry-run 不触网，复用 supersession 同一实现，零 LLM） |
| `MemoryCore/scripts/run-r169-evidence-pack.sh` | #169 证据包四档扫参（+0/+1/+2/+3 邻接行），pack 行只进注入块、不进候选集 |
| `MemoryCore/scripts/skill-buffer-clean.mjs` | skill buffer 运维清理（只删 session 级 buffer 目录，不动 `_tasks.json`／库／已归档 L2） |
| `MemoryCore/scripts/verify-core-live.ts` | task-39 隔离实例活体验证：起第二实例（8499 端口 + 临时 baseDir），真 HTTP 断言 413 可诊断、skill/L0 二次投递幂等 |
| `MemoryCore/scripts/verify-payload-limit-413.ts` | task-36/CR-7：真 socket + curl 对修前（reject+resume+destroy）与修后两种实现跑 413 对照 |
| `MemoryCore/scripts/lib/bench/cost.mjs` | #170/M6 成本与延迟口径段：latency=召回端到端、stages=检索子阶段、rerank 记 null、tokens 用估算器并标注 |
| `MemoryCore/scripts/lib/bench/effective-config.ts` | M6 生效配置快照：用 core 的 `loadGatewayConfig()` 取最终值，并逐键标 default / file / cli 来源 |
| `MemoryCore/scripts/lib/bench/long-session-corpus.mjs` / `long-session-metrics.mjs` | #168 纯函数：前者生成 30-50 条同实体多值序列（确定性 ground truth），后者算 currentHitRate / staleInjectionRate / historyHitRate / dupActiveRowsPerAttr / blockChars |
| `MemoryCore/scripts/lib/bench/offline-embedding.mjs` | 离线 hash 向量（字符/双字 n-gram FNV + L2），只验管线，报告里必须声明「不是检索质量」 |
| `MemoryCore/scripts/lib/bench/report.mjs` | M8 判分可信度门禁：`enforceJudgeGate`/`judgeCoverage`（覆盖率低于阈值或 judge 字段缺失 ⇒ invalid，非 0 退出） |
| `MemoryCore/__tests__/bench-report-gate.test.ts` | M8 门禁测试：判分覆盖不足 → 报告 invalid；--allow-unjudged 例外 |
| `MemoryCore/__tests__/long-session-bench.test.ts` | 长会话 bench 语料/指标口径测试 |
| `MemoryCore/__tests__/openclaw-format-parity.test.ts` | openclaw 注入格式与 core 单一源逐字 parity（7 例） |
| `MemoryCore/src/config/__tests__/config.recall-defaults.test.ts` | recall 缺省档快照（injectWrapper=calibrated、maxResults=10、evidencePack 缺省关） |
| `MemoryCore/src/core/hooks/__tests__/auto-recall-config-defaults.test.ts` | 钩子路缺省档与 config 一致（防两处漂移） |
| `MemoryCore/src/core/hooks/__tests__/auto-recall-evidence-pack.test.ts` | #169 证据包注入与邻接行装配 |
| `MemoryCore/src/core/recall/__tests__/evidence-pack.test.ts` | 证据包窗口/上限/session 数（6） |
| `MemoryCore/src/core/recall/__tests__/inject-wrapper.test.ts` | 三档包裹语正文与回滚 |
| `MemoryCore/src/core/prompts/answer-guidance.parity.test.ts` | 答案口径与 bench tuned 逐字 parity（8 例） |
| `MemoryCore/src/core/prompts/l1-extraction.single-source.test.ts` | #156 提示词单源（:71 不再禁 assistant 行为 + gating） |
| `MemoryCore/src/core/record/l1-extractor.assistant-act.test.ts` | #156 e2e：assistant 自述行为抽出 persona/instruction 并落库；空寒暄不抽 |
| `MemoryCore/src/core/record/l1-writer.capability-warn.test.ts` | #152 ①：能力位缺失时 fail-closed + WARN |
| `MemoryCore/src/core/store/capability-guard.test.ts` | 能力位守卫单测 |
| `MemoryCore/src/core/store/embedding.has-client-embedding.test.ts` | #123 hasClientEmbedding 判据 |
| `MemoryCore/src/core/store/task-source-type.test.ts` | #127 三值归一（github/tapd→external） |
| `MemoryCore/src/core/tools/__tests__/fact-channel-capability-warn.test.ts` | #152 ① 工具路事实通道能力位告警 |
| `MemoryCore/src/core/tools/__tests__/memory-search-normalized-validity.test.ts` | 工具路与钩子路同乘子（fusion/softPenalty 归一） |
| `MemoryCore/src/gateway/__tests__/payload-too-large-413.test.ts` | 超限 413 回调链路 |
| `MemoryCore/src/gateway/__tests__/v2-router-task-source-type.test.ts` | #127 路由层三值透传 |
| `MemoryCore/src/metadata/router/task-source-type.schema.test.ts` | #127 zod preprocess 归一 |
| `MemoryCore/src/core/skill/__tests__/force-archive-meta.test.ts` | force-archive 走 updateMeta 保留指纹环 |
| `MemoryCore/src/core/skill/conversation-add/add-handler.dedupe.test.ts` | task-26：重复投递不重复计数、全重复仍 ok、窗口/条数边界 |
| `MemoryCore/src/core/lifecycle/__tests__/evidence-ids-parity.test.ts` | #155：consolidation 卡与 reflection 卡证据键集合一致 + 同一读函数可取 |
| `MemoryCore/src/core/lifecycle/consolidation/consolidation-worker.write-side.test.ts` | #155 写面：addLink await 与 evidence_ids 累积 |

## 2. dsh-plugin/（整目录 untracked，44 个文件）

> 独立 npm 包 `@tdb/agemem-dsh`，自成一套构建/测试/部署链。`.gitignore`（46 字节）已含 node_modules/ dist/ .deploy/ artifacts/ *.tgz。

### 2.1 源码 `src/`（14）

| 文件 | 字节 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 39426 | 插件入口：systemPrompt 注入段（answer-guidance / head-pack）、volatile 记忆块、writeback 装配、recall 工具、prewarm、compaction 监听、dispose |
| `src/memory-client.ts` | 36060 | v3 契约客户端（core/read、atomic/search、scenario/ls、conversation/add、conversation/delete、health），fail-soft + 401 回调 |
| `src/writeback.ts` | 19089 | 宿主事件 → 回合记录：user 原文抓取、assistant 文本、tool call/result、usage，agent/turn-stopping 定型后入 outbox |
| `src/config.ts` | 15202 | 配置面与归一（unknown 键 warn、类型分流、身份缺省为空、apiKey / apiKeyRef 解析顺序） |
| `src/volatile.ts` | 12106 | 每轮 pre-step 注入（append-only、两级去重、800 字符上限、source.kind 自持） |
| `src/wire-limits.ts` | 9415 | 与 core 的线上限额对齐（单条内容、条数、整批字节） |
| `src/head-pack.ts` | 7846 | persona head pack：结构化压缩（Scene Index 一行一场景）+ 预算截断 + fail-open |
| `src/guidance.ts` | 7301 | 答案口径段（currency / preference / tools guide）装配 |
| `src/recall-source.ts` | 7141 | 召回数据源（L1 记忆 / searchAtomic 两腿 + 失败降级） |
| `src/recall-cache.ts` | 4924 | 召回结果短 TTL 缓存（同轮去重） |
| `src/outbox.ts` | 14806 | 本地 JSONL 队列：退避重试、maxAttempts 后移 outbox.dead.jsonl（零删）、requeueDead 人工回灌 |
| `src/tools.ts` | 3728 | memory_recall 工具定义（懒 import 宿主 tools 服务） |
| `src/types.ts` | 2226 | 共享类型（宿主事件、payload、config 形状） |
| `src/ids.ts` | 1534 | sessionKey / agentKey / turnId 生成（agent.session.id，退化 WeakMap + 计数器） |

### 2.2 测试 `test/`（15 个 test + 1 fixture + 3 helpers）

| 文件 | 字节 | 覆盖 |
| --- | --- | --- |
| `test/index.test.ts` | 39507 | 入口装配：注入段顺序、inert 身份不触网、api key 优先级、401 warn-once、compaction 仅真事件刷新、写回 [user,assistant]、不写回自身注入块、dispose |
| `test/memory-client.test.ts` | 26580 | 五端点契约、信封 / code!==0、超时、role / 空 content 过滤、isolation 并入 body |
| `test/writeback.test.ts` | 17207 | 事件收集、去重、pending user 暂存、turn-stopping 定型、payload 形状 |
| `test/turn-pipeline.integration.test.ts` | 14336 | 端到端：pre-step 注入 → 回合 → outbox 投递 |
| `test/volatile.test.ts` | 12307 | append-only、同轮去重、近 3 轮同文本、800 上限、注入块不计入 user 文本 |
| `test/config.test.ts` | 11047 | 缺省值、身份为空、密钥不进配置面、未知键 warn |
| `test/guidance.test.ts` | 9297 | 口径段逐字、作为 system prompt 段而非 volatile |
| `test/head-pack.test.ts` | 9181 | 结构化压缩、fail-open 分支、clamp 边界、幂等 |
| `test/outbox.test.ts` | 9048 | 重试 / 退避 / 死信 / 回灌 / 并发 latch |
| `test/wire-limits.test.ts` | 6701 | 限额裁剪与标记 |
| `test/recall-source.test.ts / recall-cache.test.ts` | 5697 / 3782 | 两腿合并与降级；TTL 缓存命中 / 失效 |
| `test/patch-util.test.ts` | 4702 | cordis.patch.yml 读写（部署脚本用） |
| `test/tools.test.ts / ids.test.ts` | 4386 / 823 | 工具 schema 与错误文案；id 生成 |
| `test/fixtures/persona-sample.md` | 6.8K | 真实 persona 样本（叙事 3766 字 + 14 场景节） |
| `test/helpers/{core-fixtures,fake-ctx,messages}.ts` | — | 假宿主 ctx、v3 响应夹具、消息构造器；test/stubs/ 为空目录 |

### 2.3 部署与运维 `scripts/`（5）+ 根文件（6）

| 文件 | 字节 | 职责 |
| --- | --- | --- |
| `scripts/deploy.sh` | 13032 | 打包 tarball → 备份三文件 → dsh plugin add → 渲染 patch entry → 失败回滚 → 写 .deploy/last |
| `scripts/rollback.sh` | 5038 | 还原三文件 → plugin remove → 清 node_modules → 断言插件 id 不再出现 |
| `scripts/drill-patch-layer.sh` | 4726 | patch 层演练（隔离 profile 验证 loader 合并语义） |
| `scripts/patch-util.mjs` | 6337 | cordis.patch.yml 增删改工具（被 deploy / rollback 复用） |
| `scripts/smoke-v3.mjs` | 10803 | 五步活体冒烟（read / ls / search / add / delete），失败 exit 1 |
| `package.json` | 770 | 包元（@tdb/agemem-dsh，无运行时依赖） |
| `tsconfig.json / vitest.config.ts` | 456 / 181 | 构建与测试配置 |
| `README.md` | 24198 | 安装 / 配置 / 运维 / 已知边界 |
| `.gitignore` | 46 | node_modules/ dist/ .deploy/ artifacts/ *.tgz |
| `.tmp-inspect.cjs` | 441 (10-31 21:39) | 本轮调试用的一次性检视脚本，**建议提交前删除**（见 §3） |

## 3. 历史遗留临时物（建议 commit 前清理，均**不是**本轮产物）

| 路径 | 大小 | mtime | 说明 |
| --- | --- | --- | --- |
| `.dsh-vision-router/artifacts/e3-review-30.html-4fb6bd69-shot-1280x900.png` | 81007 | 2026-10-29 01:06 | vision-router 截图产物 |
| `MemoryCore/.tmp_distill.md` | 13374 | 2026-10-29 06:00 | 蒸馏临时稿 |
| `MemoryCore/.distill_len_check.md` | 5 | 2026-10-29 05:06 | 长度检查残留 |
| `MemoryCore/__distilled_block__` | 16854 | 2026-10-29 14:06 | 蒸馏块草稿 |
| `MemoryCore/scratch/scene_block_distilled.md` | 17646 | 2026-10-29 01:32 | 场景块蒸馏草稿 |
| `MemoryCore/scratch/peek-arm.cjs` | — | 2026-10-29 12:50 | 档位探针 |
| `MemoryCore/scratch/pr-body-integ-recall-opt.md` | — | 2026-10-29 14:04 | 旧 PR 正文草稿 |
| `MemoryCore/scratch/pr163-close.md` | — | 2026-10-29 14:08 | 旧 PR 关闭说明草稿 |
| `MemoryCore/scratch/probe-turnid.mts` | — | 2026-10-30 09:33 | turnId 探针 |
| `MemoryCore/scratch/repro-recall.mjs` | — | 2026-10-30 08:41 | 召回复现脚本 |
| `dsh-plugin/.tmp-inspect.cjs` | 441 | 2026-10-31 21:39 | 本轮调试残留（唯一一条本轮时间戳的垃圾），dsh-plugin 入库前删掉即可 |

对照：本轮产物 mtime 全部 ≥ 2026-10-31 19:2x（如 `MemoryCore/typecheck-baseline.json` 20:02、`.prettierrc` 19:40、`scripts/typecheck-gate.mjs` 19:38）⇒ **不要**把上表之外的东西当垃圾清掉。`scratch/`（仓库根，10-31 22:15）与 `MemoryCore/scratch/` 不同：前者是本轮探针/评审产出（probe-*.mjs、iss.json、issue-*、e2e/ 等），如需入库请单独决策，别和上表混。

## 4. 建议 commit 批次（3–6，未执行）

1. **写面与证据键统一（P0 修复，可独立回归）** — `MemoryCore/src/core/lifecycle/{reflection,evolution-worker,consolidation/consolidation-worker,evidence-ids}.ts` + `prompts/l1-extraction.ts` + `record/{write-policy,l1-writer}.ts` + `core/store/{capability-guard,embedding,sqlite,types,tcvdb,factory,store-pool}.ts` + `auto-adopt-gate.ts` + 对应测试（含 evidence-ids-parity、consolidation-worker.write-side、l1-extraction.single-source、l1-extractor.assistant-act、capability-guard、l1-writer.capability-warn）。
2. **读面口径与默认档（含 config 与 guide 单一源）** — `MemoryCore/src/config.ts` + `core/hooks/auto-recall.ts` + `core/recall/{validity-policy,inject-wrapper,evidence-pack,recall-journal}.ts` + `core/prompts/{memory-tools-guide,answer-guidance}.ts` + `core/tools/memory-search.ts` + `tdai-core.ts` + `gateway/{v2-router,v2-schemas,server,skill-handlers,generated/*}` + `metadata/*` + 测试。
3. **skill 会话去重（独立议题，便于单独回滚）** — `MemoryCore/src/core/skill/conversation-add/{dedupe,add-handler,buffer-storage,index,wire}.ts` + `add-handler.dedupe.test.ts` + gateway/skill-handlers.ts 的 force-archive 片段。
4. **MemoryProxy dsh v0.2 双协议 + guide 单一源** — `MemoryProxy/src/**`（9 改 + 5 新）与 `agents/dsh/README.md`、`agents/skills/setup-proxy/SKILL.md`（文档与实现同批）。
5. **MemoryPanel 面板修复** — `MemoryPanel/src/**` + `MemoryPanel/web/**` + `MemoryPanel/tests/*`。
6. **工程基建与文档** — `MemoryCore/package.json`、`scripts/{typecheck-gate,format-changed,archive-bench-reports,gen-long-session-bench,skill-buffer-clean,run-r169-evidence-pack.sh,verify-*}`、`scripts/lib/bench/*`、`bench-*.mjs`、`MemoryCore/.prettierrc / .prettierignore / typecheck-baseline.json`、`.github/workflows/ci.yml`、`deploy/**`、`docs/**`、`CHANGELOG.md`、`CONTEXT.md`。

> `dsh-plugin/` 是整目录新增（44 文件），建议**单独一个 commit**（先不含它，避免与本仓主干耦合）；`docs/ops/`（13 份，含本清单）与 `docs/specs/`（8 份）也建议并入这批或单独一批文档 commit。

## 5. 如何自查

```bash
git status --porcelain | wc -l        # 171
git diff --stat | tail -1             # 94 files changed, 3245 insertions(+), 557 deletions(-)
git status --porcelain dsh-plugin | wc -l   # 44
```

- 171 = 94 个已跟踪改动 + 77 条 untracked 顶层条目（`git status --porcelain -uall` 展开成 522 个文件；其中 `dsh-plugin/` 44、根 `scratch/` 379、MemoryCore 59（含 9 个历史临时物）、docs 25）。
- 未跟踪不代表可丢：`dsh-plugin/`、`docs/ops/`、`docs/specs/`、新增 `__tests__/*` 都是本轮交付的一部分；第 3 节的表才是建议清理项。
