# DSH 特化读面盘点：MemoryPanel + MemoryKnowledge

> 分析轮（task-48），**未改任何 src**。域 `MemoryPanel/`、`MemoryKnowledge/`。每条断言带 path:line；无证据标「未证实」。
> 核实时间 2026-10-31 22:5x，本地 HEAD 17c0582（工作树有大量未提交改动）。

## §0 事实基线：今天谁在跑、谁调谁

- 三服务同时在本机监听：core `127.0.0.1:8420`、panel `0.0.0.0:8123`、knowledge `0.0.0.0:8421`（`netstat -ano | grep LISTENING` 三个 PID 均在）。缺省端口：`MemoryPanel/src/panel/config/panel-config.ts:66`、`MemoryKnowledge/src/server.ts:147`。
- DSH 插件只认 7 个 core 端点，**不经过 Panel/Knowledge 任何一跳**：`dsh-plugin/src/config.ts:197-203`。
- 反向也不成立：`MemoryCore/src` 里 `8421` / `/v3/wiki` 命中 **0**（`grep -rn … | wc -l`）；`MemoryCore/src/core/hooks/auto-recall.ts` 的 52 处 wiki 字样全是 bench 注释（:2090 讲 knowledge-update 打分）。**召回链不读 knowledge**。
- 但 DSH 的召回**已被审计可见**：`D:/TDB/data/logs/recall/recall-journal-dshprobe-dshprobe.jsonl` 15 行，含 `2026-10-31T13:55:08Z` 的 `query:"部署环境"` 与 `perfMs/gates/memoryLines`。写方是 core，读方目前只有 Panel（`routes/chat-memory.ts:3133` `/chat-memory/recall-journal`）。
- 体量（`find | wc -l` 真跑）：Panel 后端 50 文件/9,377 行；Panel web 151 文件/36,266 行；Knowledge 65 文件/13,463 行，合计 ≈ 59,106 行。Panel 后端 17 路由文件 **82** 个 handler 注册（chat-memory 36 注册/23 条路径、knowledge 33、平台面 13）；前端 13 页（ChatMemoryPage 7,119、WikiPage 3,680、SkillsPage 2,319、CodePage 1,308、SoulPage 1,245、Workbench 967、Settings 871、Guide 836、ApiKeys 411、LlmProvider 347、Resource 179、Agents/Members 各 18）。
- **两个域都不在 CI 测试网里**：`.github/workflows/ci.yml` 只有 `panel-format`（:122-139，对 `MemoryPanel/web` 跑 `format:check`），无 Panel/Knowledge 的 vitest job；而本地实际有 Panel 30 个测试文件、Knowledge 32 个（`find … -name '*.test.ts' | wc -l`）。

**一句话定位**：Panel 是「人看/改记忆的控制台」，DSH 特化后仍是刚需但要瘦身；Knowledge 是独立 RAG 产品线（wiki + code graph + 自己的 MCP stdio server `MemoryKnowledge/src/mcp/server.ts:2-10`），与 DSH 零接口，属于「另立门户或冻结」的决策项，不是记忆系统的一部分。

## §1 必须改（DSH 唯一客户端前提下的硬缺口）

1. **Panel 后端整层建在「多实例 + 选实例」上，DSH 只有单一身份三元组。**
   `MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts:33-36`：缺 `x-tdai-service-id` 直接 400 `MISSING_INSTANCE_ID`；`routes/chat-memory.ts:12`、`routes/settings.ts:87`、`routes/llm-providers.ts:7` 全依赖它。DSH 侧身份是 `(teamId, agentId, userId)`（`dsh-plugin/src/config.ts:70-72`，缺省故意留空 :189-191），无实例概念。
   改：Panel 会话把 instance 钉成常量、`meta/instances` 退化只读。**为什么**：这是所有路由的前置中间件，改一处全站收益；否则 DSH 用户得维护一份无意义的「实例选择」状态。

2. **效期三态在读面上完全不可见（#136 落地后的读面欠账）。** core 定义 `ValidityState = "active" | "expired" | "future"`（`MemoryCore/src/core/recall/validity-policy.ts:22`），Panel 侧 `validity_state`/`validityState` grep **0 命中**，SoulSection 只渲染一段 `validityText`（`MemoryPanel/web/src/pages/ChatMemoryPage/components/block-detail/SoulSection.tsx:64-69`）。
   改：列表/详情出三态徽章 + 「expired 降权保留」提示。**为什么**：DSH 特化后用户唯一的记忆审计入口就是这个页面；现在无法解释「旧值为什么还出来」，读面失去审计价值。有现成测试范式：`MemoryPanel/tests/attribute-badges.test.ts`。

3. **召回审计靠扫 core 的磁盘目录，不是 API。** `routes/chat-memory.ts:51-60` 用 `TDAI_RECALL_JOURNAL_DIR > TDAI_DATA_DIR` 解析目录、:3163 拼 `recall-journal-<team>-<agent>`，缺 env 直接 503。**为什么必须改**：召回审计是 DSH 事后 review 的核心资产（上面 DSH probe journal 就是证据），一旦 core 换布局或分片（现在已有 `.1/.2/.3/.4` 滚动文件）读面就静默读空；应改成 core 提供 `/v3/recall/journal/query`，Panel 只消费。
   风险：core 侧新增端点=改 core；短期可先加「目录/文件缺失 vs 真空结果」的显式区分（现在两者都返回空列表）。

4. **接入向导页（GuidePage，836 行）教的是 Proxy 接入。** `MemoryPanel/web/src/pages/GuidePage/index.tsx:1-13` 头注明写「Proxy 地址 / Default-Analyse 模式 / API Key / Skill 脚本两种接入方式 / 逐 IDE 配置文件」，与新定位直接冲突，且是首次使用第一屏。
   改：换成 DSH 安装+自检向导，或先下线（见 §2）。**为什么**：指错路比没有更贵。

5. **团队/多租户口径压在记忆读面上。** chat-memory 的资产模型含 `visibility: team|private`、`allocate（借入 ≤2）`、`patch-scope`、`team-assets`（`routes/chat-memory.ts:20-32` 只列了 12 端点，实测 23 条 `/chat-memory/*` 路径），权限统一 `requireTeamMember`（`routes/knowledge/common.ts:101`）。DSH 记忆是单用户私域，表达不了「借入/切私密」。
   改：读面按 owner 过滤，借入三端点标 deprecated 只读保留。**为什么**：这 36 个 handler 里校验分支最多的一段，DSH 用不上，留着就是维护税。

6. **健康/降级信号没有前移到会话里。** Panel 侧四态已落地（`MemoryPanel/web/src/pages/ChatMemoryPage/utils/health-utils.ts:47`、:97-108，unconfigured 优先于 degraded），但 DSH 里「召回为空」的第一现场是聊天窗口；插件目前只在 `/v3/recall` 422/超时时打一条 warn（`dsh-plugin/src/index.ts:255-277`）。
   改：插件把「本轮回召走 recall 还是 atomic 降级、embedding 是否降级」并入 volatile 块或一次性 debug 摘要。**未证实**：core/read、recall 响应里是否已带 embeddingConfigured（需读 payload 再定，勿凭猜改）。

## §2 可删（三档 + 可达性论证）

**安全删**
- 无。17 个路由文件全部挂在 `MemoryPanel/src/panel/http/app.ts:6-15` 的聚合上；前端 13 页也都在 `MemoryPanel/web/src/routes/index.tsx:22-41`（Workbench 是 index 路由、ResourcePage 是布局壳 `ChatMemoryPage/index.tsx:4/:17`）。没有可白删的孤儿入口。

**需确认（有代码/有数据，DSH 侧零消费）**
- `GuidePage` 836 行：纯前端页（`/guide`），无后端 handler；删只影响 UI。牵连：`resetOnboarding` 与「我的资料→回顾引导」共用入口（`GuidePage/index.tsx:12`）。
- knowledge 33 handler（wiki 18 / code-graph 8 / allocate 5 / callback 1 / list 1）+ WikiPage 3,680 + CodePage 1,308：DSH 零调用（§0 已证）。**但有真实数据**：`D:/TDB/data/knowledge/knowledge.db` 实测 `knowledge_wiki` 3 行（scm-standards 50 页、scm-recipes 686 页、scm-business-analysis `status=failed / "interrupted by restart"`）、`knowledge_code_graph` 0 行、`llm_binding` 0 行。删代码=产品下线，必须用户拍板；DB 73MB 应保留只读。
- `meta/instances` + `config/instance-registry`（多实例切换）：DSH 单实例；但云端 compose 是 5 服务（`deploy/tencent-cloud/docker-compose.yml:10/29/49/63/76` core/proxy/knowledge/panel/caddy）。**未证实**线上是否真多实例，先别删，只把 UI 藏起来。
- `LlmProviderPage` 347 + `routes/llm-providers.ts` 3 handler + `routes/settings.ts` 的 `proxy-pricing`：服务对象是 Proxy 的 provider/计费。牵连：`routes/settings.ts` 同时挂着 `/settings/memory/:action`、`/settings/knowledge/:action`，要按 action 拆，不能整文件删。
- Knowledge 的 MCP stdio server（`MemoryKnowledge/src/mcp/server.ts:2-14`）：没有仓内调用方，但它是**唯一一条 DSH 可复用的知识接入口**（DSH 支持 MCP 连接器）。若 Knowledge 留，应走这条路而不是 Panel UI；若 Knowledge 下线，它一并下线。

**别删**
- `ChatMemoryPage` 7,119 行 + chat-memory 36 handler：DSH 唯一的人看/改记忆入口（§5）。
- `ApiKeysPage` 411 + `/meta/*` 透传：DSH 插件靠 API key 直连 core，凭证生命周期仍要人管。
- `SkillsPage` 2,319 + `skill/proxy`：技能资产归 core（`/v3/skill/*`），DSH 侧暂不读但属记忆系统资产。**未证实** DSH 后续是否消费。
- `WorkbenchPage` 967 + `routes/task.ts`：任务是记忆来源维度（#127 的 `source_type`），删了断 L0 归因。
- Panel 30 个测试文件里的 chat-memory-*（16 个）：删读面端点前它们是唯一的回归网，且**不在 CI**（§0），删了等于裸奔。

## §3 边界与风险

- **数据迁移**：chat-memory 的 team/private 与 allocate 是已落库字段（`routes/chat-memory.ts:20-32`）；删端点不删数据 → 存量 team 资产会变成「面板看不见但仍被召回」的幽灵，必须同时给只读出口或迁移说明。
- **对外合同**：Panel 的 `/api/v1/…` 是给前端与 e2e 脚本用的合同，`MemoryPanel/scripts/e2e-knowledge-authz.sh:3-6`、`e2e-skill-authz.sh:3-6` 硬编码 `:8123`；Knowledge 还有 `openapi.json`/`/docs`（`MemoryKnowledge/src/server.ts:119-122`）。
- **测试夹具牵连**：Panel 30 / Knowledge 32 个测试文件均不在 CI；任何删除都要同步删/改夹具（如 `tests/wiki-source-routes.test.ts`、`tests/chat-memory-recall-journal.test.ts`），否则本地绿、CI 无感、线上炸。
- **治理冲突**：#127 三项 union 已在代码里修好——`MemoryPanel/web/src/lib/api/tasks.ts:9-20`（canonical `manual|external|other` + 归一）、`services/backendStore.ts:69-75`（改 re-export，注释点名「不再重复定义」）、`pages/WorkbenchPage/components/TaskCreateDialog.tsx:22-25`（同样 re-export，创建固定 `manual` :59）；core 侧单一源 `MemoryCore/src/core/store/task-source-type.ts:17`（`["manual","external","other"]`），zod 只用 `z.preprocess + z.enum(TASK_SOURCE_TYPES)` 收口（`MemoryCore/src/gateway/v2-schemas.ts:236-239`），测试 `MemoryCore/src/core/store/task-source-type.test.ts:19`。**票未关，别重复改**。
- **面板读面与 core 口径已对齐的部分**（避免重复排查）：B1 分页硬上限已解除、类型下推已生效（`routes/chat-memory.ts:250-291`，`asset_types:["chat_memory"]` + `FA_PAGE_SIZE=100` 循环到 total）；embedding 四态（`health-utils.ts:47`）；任务来源三值（上条）。

## §4 建议执行顺序

1. **先关 #127**（代码已合，只需核对 core 侧 `v2-schemas.ts:235` 已随包发布）→ 防重复劳动。验证：`MemoryPanel/tests/task-source-type.test.ts`。
2. **Panel 单实例钉死 + 三态徽章**（§1-1/§1-2）：改 `validate-panel-headers.ts:33-36` 与详情组件。验证：`cd MemoryPanel && npx tsc --noEmit` + `npx vitest run`（当前 30 文件本地全绿）+ 新增一条 expired 渲染断言。
3. **召回审计去文件化**（§1-3）：core 加 journal 查询端点，Panel 改消费；先加「目录缺失 vs 空结果」区分做过渡。验证：`tests/chat-memory-recall-journal.test.ts` 加一案（目录不存在 → 503 而非空列表）。
4. **GuidePage 下线 / LlmProvider 摘除**（§2 需确认档）：纯 UI，风险最低但需用户点头。验证：`cd MemoryPanel/web && npm run build` + 手工点一遍剩余 12 页。
5. **Knowledge 冻结**：不再投功能，DB 只读保留 73MB；把 MCP stdio 作为唯一对外口评估，Panel 侧 33 handler 停用。验证：`knowledge.db` 行数不变 + `/api/v1/knowledge/*` 返回 410。
6. **补 CI**（最后但上生产前必做）：`.github/workflows/ci.yml` 加 `MemoryPanel`/`MemoryKnowledge` 的 `vitest run` job（现只有 `panel-format` :122-139）。验证：PR 上看到 30+32 个文件跑起来。

## §5 DSH 真正需要的五个能力（其余都是成本）

1. **会话内注入**：persona（`/v3/core/read`）+ 场景索引（`/v3/scenario/ls`）+ 召回块（`/v3/recall`，失败降级 `atomic/search`）——**已经在插件里**（`dsh-plugin/src/config.ts:197-203`、`index.ts:255-277`），Panel 不参与。
2. **会话后写回**：`conversation/add` + `skill/conversation/add`——插件已有；Panel 无写回路径，不需补。
3. **事后 review（人）**：L0 列表/详情 + **每轮召回决策**（`RecallJournalView` + `/chat-memory/recall-journal`，`routes/chat-memory.ts:3133`）——这是 Panel 唯一不可替代的价值，且只有 DSH 会持续产出这种审计流（DSH probe journal 实证）。
4. **记忆纠错/删除（人）**：`layer-delete` / `clear` / 单行删除（`conversation/delete`，我已在 task-42 用它清 17 行，200/deleted_count=1）。
5. **健康与降级可见**：embedding 四态（`health-utils.ts:47`）+ 插件侧降级提示（§1-6）。

对照之下：团队借入/切私密（allocate/patch-scope/team-assets）、知识库 wiki+code-graph、LLM provider 计费、接入向导、多实例切换——**五类零 DSH 消费**，共约 33（knowledge handler）+13（平台面 handler）+ 约 12k 行前端。

## 附：本轮顺手核到的文档漂移（不在四节内，但会误导下一轮）
- `MemoryPanel/src/panel/http/routes/chat-memory.ts:20-32` 头注仍写「12 endpoints」，实测该文件 23 条 `/chat-memory/*` 路径、36 个 handler 注册——删/改前请以代码为准。
- `MemoryPanel/web/src/services/backendStore.ts:69-75` 的 #127 注释已改成「re-export canonical」，但 `TaskCreateDialog.tsx:59` 创建时固定 `manual`：面板 UI 至今**没有 external 选项**（与 #127 收窄方向一致，别再按「放开 external」改）。
