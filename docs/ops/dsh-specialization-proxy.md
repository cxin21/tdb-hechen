# DSH 特化盘点：MemoryProxy + 其他客户端接入面

- 日期：2026-10-31 22:50+ / 基线 main@17c0582 / **只分析未改码**
- 口径：唯一正式客户端 = DSH 桌面插件（已装 desktop profile，等宿主重启）；本文件只回答「proxy 还有没有存在价值、删它的代价」。
- 证据标准：每条断言给 `path:line` 或真跑计数；给不出的标**未证实**。

## §0 结论（先看这 10 行）

1. **MemoryProxy 现在零 LLM 流量**：`MemoryProxy/logs/proxy.log` 最后一次 `injection.hook.start` = `2026-10-29T06:37:14Z`（本地 14:37）；今天（10-31）该文件只有 24 行，全是 20:33 重启时的 `server.starting/listening`。8096 仍在监听（netstat PID 35184），空转。
2. **插件不经过 proxy**：`dsh-plugin/src/config.ts:105` 缺省 baseUrl = `http://127.0.0.1:8420`（MemoryCore），`memory-client.ts` 全部打 `/v3/*`；这些端点在 core 自己的路由表里（`MemoryCore/src/gateway/v2-router.ts:210` atomic/search、`:236` scenario/ls、`:241` core/read、`:545` handler 表；`skill-handlers.ts:1154` skill/conversation/add）。
3. 因此先前审计的前提**失效**：`docs/specs/2026-10-31-dsh-specialization-audit/README.md:16`「插件只能认识一个地址 ⇒ 控制面留在 MemoryProxy」。插件认识的那一个地址**就是 core 8420**，proxy 不在链路上。
4. proxy 只剩三类**活**依赖：panel 两个 admin 页透传（`MemoryPanel/src/panel/config/panel-config.ts:82,86`）、panel 启动给 knowledge 写 LLM binding（`ensure-knowledge-llm-binding.ts:31-32`，sync 缺省 true）、core 两个脚本直接 import proxy 源码（`MemoryCore/scripts/backfill-l0-classification.ts:19`、`verify-c2.ts:46`）。
5. proxy 的**独有能力**只有两条：多协议 LLM 兼容（Anthropic/OpenAI/Codex/WorkBuddy）+ 观测计费（ClickHouse/Langfuse/Opik/credit）。DSH-only 语义下这两条都没有验收口径 —— 没有客户端、没有流量、没有读数。
6. 结论：**MemoryProxy 应从「默认组件」降级为「legacy 客户端可选网关」**，代码保留到用户拍板删除；删除收益 ≈ 53.4k 行实现 + 63 个测试文件 + 1 个 CI job + 1 个 docker 镜像；删除代价见 §3。
7. 唯一**现在还没有读数**的地方不是 proxy，而是插件写面：`~/.dsh/agemem/outbox.dead.jsonl` 曾有的 2 条 401 死信是 task-31 e2e **故意用错 key** 做的可观测性取证，**不是线上缺陷**（`docs/ops/dsh-plugin-e2e-report-2.md` 第 ⑦ 项；留档 `scratch/e2e/evidence/outbox-dead-2026-10-31.txt`）。桌面插件 22:49:41 安装时用的是从 `MemoryCore/tdai-gateway.yaml` 读取的 64 位 core key，宿主未重启 ⇒ 桌面侧至今**零真实写面读数**，既不能判 401，也不能判正常。

## §1 必须改（DSH 特化缺口）

| # | 位置 | 现状 | 改成什么 | 为什么 |
| --- | --- | --- | --- | --- |
| 1 | `~/.dsh/profiles/desktop/cordis.patch.yml:16-31` | 仍定义 `provider: tdb` → `baseURL: http://127.0.0.1:8096/dsh/default`（带 models scm-flash/scm-pro、`apiKeyEnv: TDB_API_KEY`）。全文件其余位置（`:87,:99-104` 视觉、`:113` 邮件）都不引用 tdb | 删除该 provider，或改名 `tdb-legacy` 并加注释「依赖已停服的 MemoryProxy」 | 模型下拉一旦切到 tdb，LLM 流量重新进 proxy，而过代理的注入链已无人验收（core 侧 injectWrapper/head-pack 与之不同源），会静默回到旧注入且不可观测 |
| 2 | `MemoryPanel/src/panel/config/panel-config.ts:82,86`；`http/routes/settings.ts:136`；`http/routes/llm-providers.ts:33` | panel 的「LLM Provider 自服务页」与「计费/定价页」把请求透传到 `proxyBaseUrl/v3/admin/llm-providers`、`/v3/admin/credit-pricing`（缺省 8096） | 改成 core 的 `/v3/admin/*`（core 已有 `gateway/admin-settings.ts` + `rerank-model-admin.ts` 同一 routeTable 范式），或明确标记这两页为 legacy | proxy 停服后这两页 100% 502；不是「可选功能缺失」而是死链 |
| 3 | `MemoryPanel/src/panel/startup/ensure-knowledge-llm-binding.ts:31-32,100,155`（`index.ts:26-36` 调用，`sync` 缺省 true） | panel 启动时把 `proxy_base_url=8096` 写进 MemoryKnowledge 的 `llm_binding` | 改为写 core 地址 / 直连 upstream；或把 `KNOWLEDGE_LLM_BINDING_SYNC` 缺省改 false 并写清手工步骤 | 生产实测 `D:/TDB/data/knowledge/knowledge.db` 的 `llm_binding` **0 行** ⇒ 该链路当前没生效，但一旦某次 panel 重启成功写入，Knowledge 的 wiki/codegen 模型就会指向已死的 8096 |
| 4 | `MemoryCore/scripts/backfill-l0-classification.ts:19`（`import ... from "../../MemoryProxy/src/common/intent-classifier.js"`）、`verify-c2.ts:46`（`knowledge/current-feeling.js`） | core 的运维脚本**跨包 import proxy 源码** | 把 `intent-classifier` / `current-feeling` 挪进 core（或 `MemoryCore/src/core/...`）后再删 proxy | 删 proxy 目录当天这两个脚本编译失败；这是「删 MemoryProxy」唯一的**硬**代码依赖，必须先进 core 再删 |
| 5 | `docs/ops/dsh-plugin-e2e-report-2.md` 第 ⑦ 项；留档 `scratch/e2e/evidence/outbox-dead-2026-10-31.txt` | 那 2 条 `/v3/conversation/add`、`/v3/skill/conversation/add` 的 `status:401` 死信（deadAt 2026-10-31T14:24:23Z）是 task-31 e2e **故意用错 key** 造的可观测性取证，跑完即清空（lead 已留档并清 dead 文件，避免 `verify-installed.mjs --hours 6` 误报 FAIL） | **不需改码**；等宿主重启后拿一轮真实写回读数再判 | 桌面插件用的 key 来自 `MemoryCore/tdai-gateway.yaml`（64 位 core key），不是 MemoryProxy 那把 6 字符 key；当前「装了但没跑」⇒ 写面既无缺陷证据也无健康证据 |
| 6 | `MemoryCore/src/gateway/llm-resolver.ts:51-95`（`provider=proxy` → `${base}/proxy/:instanceId/v1`） | core 保留「LLM 走 proxy」分支 | 生产未使用（`D:/TDB/data/config-override.json` 的 `llm.baseUrl` 直连 `api.minimax.cn/v1`）；建议在 DSH-only 定案后标注 deprecated | 是纯配置死路，留着会让人误以为 core 仍需要 proxy 才能跑 LLM |
| 7 | `MemoryProxy/src/server.ts:132,137,144`（`/skill-bridge/*`、`/memory-bridge/*`、`/v3/instance/proxy-destroy`） | 三条桥接/销毁端点 | 清点调用方后再决定；**未证实**有外部调用 | 若无人调用，它们就是「proxy 保留论」里最难证明价值的部分 |

## §2 可删清单（三分：安全删 / 需确认 / 别删）

规模基线：`MemoryProxy/src` 实现 **53,428 行** / 测试 **9,167 行** / 测试文件 **63 个**；根目录 handler 家族按字节：`handler.ts` 115,024、`anthropicHandler.ts` 102,731、`codexHandler.ts` 64,240、`workbuddyHandler.ts` 62,082、`clickhouse.ts` 49,543、`types.ts` 46,104、`config.ts` 39,101。

| 模块（行数） | 入口可达性 | 判定 | 依据 |
| --- | --- | --- | --- |
| `src/handler.ts` + `anthropicHandler` + `codexHandler` + `workbuddyHandler` + `auxiliaryHandler`（≈400KB） | `server.ts:191-199`（`/v1/messages`、`/v1/embeddings`…）、`:252-301`（`/codex/*`、`/workbuddy/*`）、catch-all `POST /*` | **安全删**（前提：legacy 客户端模式一并下架） | 最后一次真实 LLM 请求 2026-10-29T06:37Z；DSH 走插件后这四条协议无客户端 |
| `src/injection/`（9,247 行，16 个 injector 文件） | `server.ts` 注入管线（`injection.pipeline.start` 4,000 次历史命中，今天 0） | **需确认** | 注入能力已被 core hooks（`auto-recall.ts`）+ 插件（head-pack/volatile/guidance）覆盖，但 soul/red-line/current-feeling 三件在 core 侧是否逐位等价**未证实**（core 有 `hooks/soul-assembler.ts`、`identity-narrative.ts`，契约注释互指，未跑等价测试） |
| `src/session/`（11,352 行，6 套客户端会话抽取：claude-code/codex/opencode/workbuddy/dsh） | 仅被 handler 家族调用 | **安全删** | 会话抽取在 DSH 语义下由插件自带（`dsh-plugin/src/writeback.ts`）；`agent-adapters/dsh.ts:1-30` 的 header 指纹解析只服务代理路 |
| `src/skill/`（2,491 行）+ `server.ts:132 /skill-bridge/*` | 代理路 skill 转发 | **安全删** | 插件直连 core `/v3/skill/conversation/add`（`MemoryCore/src/gateway/skill-handlers.ts:1154`）；core 侧已有去重（task-26 起幂等指纹） |
| `src/tdai/`（1,380 行：client/pending-writes/recorder） | 代理路写 core 的通道 | **安全删** | 插件用 `memory-client.ts` 直写 core；proxy 的 `pending-writes.ts` 只在代理路被调 |
| `src/clickhouse.ts` + `langfuse.ts` + `opik.ts` + `credit-reporter.ts` + `pricing.ts` + `rate-limit/` + `report/`（≈1,900 行 + 49.5KB 单文件） | `index.ts:59-63` 启动即初始化 | **需确认** | 它们观测/计费的对象就是「过代理的 LLM 流量」——DSH-only 下没有该流量。风险：ClickHouse 里是否有长期留存报表、是否有人按月取数（**未证实**） |
| `src/mem-command/`（2,285 行，CLI：parser/pre-intercept/response-builder/task-draft-generator） | 独立命令入口（`package.json` scripts 无 bin 声明，直接 `src/mem-command/index.ts`） | **需确认** | 这是人手动入口，可能被 aliases/运维脚本调用；本机未找到引用（**未证实**） |
| `src/routes/`（2,187 行）、`src/knowledge/`（711）、`src/meta/`（646）、`src/memory/`（653） | `/v3/admin/*`、`/v3/instance/*`、panel 透传目标 | **别删（先搬）** | panel 的两页与 knowledge binding 依赖 `routes/llm-providers.ts`、`routes/credit-pricing`；§1-2/§1-3 完成前删掉会连带打死 panel |
| `src/common/` `src/db/` `src/storage/` `src/types/` `src/config.ts` `src/logger.ts` `src/server.ts` | 骨架 | **别删** | 删 proxy 时最后一起删；跨包 import（§1-4）先解耦 |
| `MemoryProxy/src/prompts/memory-tools-guide.proxy.ts`、`injection/injectors/memory-tools-guide.proxy.ts` | 代理注入器的文案镜像 | **可删**（随注入器） | DSH 侧不依赖：`dsh-plugin/src/guidance.ts:5-7` 只指向 `MemoryCore/src/core/prompts/memory-tools-guide.ts`；插件全仓零 `import` proxy（grep 仅注释 2 处：`config.ts:64,131`） |
| `agents/`（8 个客户端 README + `setup-proxy.sh` 46,355B + `skills/setup-proxy/SKILL.md`） | 文档 + 一次性配置脚本 | **降级为 legacy**（不删） | 本机实测：`~/.claude`/`~/.codex`/`~/.cursor`/`~/.opencode`/`~/.hermes` 都不存在；`~/.codebuddy`、`~/.workbuddy` 存在但内部无 8096 配置（grep 命中全是第三方库巧合数字）⇒ 当前**零客户端**在用 |
| `MemoryCore/openclaw-plugin/`（`@tencentdb-agent-memory/memory-tencentdb-v2@1.0.0-beta.1`） | 独立 npm 包 | **需确认** | 若已发布/有人在用则不能删；与 proxy 无关（它是 core 的另一个客户端），DSH 特化后属于「非 DSH 客户端」清单里唯一**有代码**的一个 |
| `sdk/python` + `sdk/typescript`（memory-core SDK，v2/v3 客户端） | 对外 SDK | **别删** | 与流量路径无关，是 core 的正式对外合同；删了等于宣布没有 API 用户 |
| `.github/workflows/ci.yml:103-120`（job `memoryproxy-test`：tsc + vitest 63 文件）、`probes-nightly.yml:42-45`、`deploy/dockerhub/publish.sh:159-165`（`memory-proxy` 镜像） | CI / 发布 | **随删** | 删 proxy 当天这三处必红；顺序见 §4 |

### 对「删除 MemoryProxy」的代价清单

- **谁会用不了**：claude-code / codebuddy / codex / opencode / workbuddy / hermes / openclaw 七端的「LLM 流量顺带注入记忆」接入方式（`agents/*/README.md` 均在教用户把 baseURL 指到 8096）。将来若要接回任一客户端，需要重写 ≈400KB 协议适配（Anthropic / Codex Responses / WorkBuddy 三套）。
- **什么数据没人写**：① 代理路 L0 原始抓取（`dsh-l0-*` 日志族，历史 3,075 次 turn-v2 / 3,072 次 finalize，最后一次 2026-10-25）；② `D:/TDB/data/proxy/proxy.db`（仅 1 张 `proxy_kv` 表）里的会话状态；③ ClickHouse / Langfuse / Opik 的 LLM 观测。**L0/L1 主库（`D:/TDB/data/vectors.db`）不依赖 proxy** —— proxy 只经 `client.ts` 转调 core。
- **删之前必须先拿到的读数**：L0 写面在桌面侧**尚无任何真实数据**（插件 22:49 装、宿主未重启）。删 proxy 前应先完成一轮真实写回验证 —— `~/.dsh/agemem/outbox.jsonl` 积压归零、core L0 行数增长。注意：`outbox.dead.jsonl` 历史那 2 条 401 是 e2e 取证，**不构成缺陷证据**（§1-5）。
- **对外合同**：`/v1/messages`、`/v1/responses`、`/:agent/:spaceId/v1/chat/completions` 是 OpenAI/Anthropic 兼容面；删掉即放弃「任意客户端可接」这一卖点（若产品不再需要，则无代价）。

## §3 边界与风险

1. **数据迁移**：proxy 不持有记忆主数据（`vectors.db` 在 core）；删 proxy 无需数据迁移。需要确认的是 `proxy.db` 的 `proxy_kv` 是否需要导出（未证实有非缓存内容）。
2. **已落库数据**：`D:/TDB/data/skill_buffer/`（175 个 session 目录）由 core 侧 buffer 写，不随 proxy 删；history 里的 skill 归档同样在 core。
3. **测试夹具**：63 个测试文件 / 9,167 行；其中 `src/injection/__tests__`（4,574 行）与 `src/tdai/__tests__`（762 行）与核心契约强绑（soul 渲染逐位等价）。删 proxy 必须同步删这些契约测试，否则会留下「测一个不存在的服务」的绿测试。
4. **部署与镜像**：`deploy/dockerhub/publish.sh` 对外发布 `agentmemory/memory-proxy`；`deploy/global-images/start-proxy.sh` + `.env` 的 `PROXY_*` 组（`_lib.sh:378-404`）都在教人配 proxy。删代码不删这些脚本 = 文档与脚本漂移。
5. **误删红线**：`src/injection/injectors/soul-redline-render.ts` 与 core `hooks/soul-assembler.ts:20` 有「MemoryProxy 侧逐位镜像 + 契约测试钉等价」的注释互指；删 proxy 前必须确认 core 侧是**唯一实现**（未证实）。

## §4 建议执行顺序（每步带验证方式）

| 步 | 动作 | 验证 | 回滚 |
| --- | --- | --- | --- |
| 1 | 断开 proxy 流量：删 desktop `provider: tdb`（§1-1） | `MemoryProxy/logs/proxy.log` 24h 内零 `injection.pipeline.start`；DSH 模型仍可用 | 恢复 patch 块 |
| 2 | 宿主重启后验证插件写面首轮真实写回（§1-5；无码可改） | `~/.dsh/agemem/outbox.jsonl` 积压为 0、`outbox.dead.jsonl` 不再新增；core L0 行数增长；`verify-installed.mjs --hours 6` 不报 FAIL | 无（只读验证） |
| 3 | panel 两页 + knowledge binding 改指 core（§1-2/§1-3） | panel 「LLM Provider」页 200 且能读 core `/v3/admin/llm-providers`；`knowledge.db` 的 `llm_binding` 行非空或显式关闭 sync | 改回环境变量 |
| 4 | 把 `intent-classifier` / `current-feeling` 搬进 core（§1-4） | `npx tsc -p tsconfig.typecheck.json --noEmit` 不新增错误；两个脚本可跑 | 保留 proxy 源码 |
| 5 | 删 handler 家族 + session/skill/tdai/agent-adapters，保留 server 骨架与 admin 路由 | `cd MemoryProxy && npx vitest run`（剩余测试全绿）+ core 全量测试 | git 恢复 |
| 6 | 最后删整个 MemoryProxy + CI job + dockerhub 目标 + `start-proxy.sh` | `MemoryCore` 测试/typecheck 门禁；`dsh-plugin` vitest；daemon 起来后 8096 不再监听 | 分支级回滚（proxy 独占目录，删除可整体 revert） |

## §5 未证实清单（不要当结论用）

1. `injection/` 的 soul/red-line/current-feeling 与 core `hooks/soul-*` 是否逐位等价 —— 只有注释互指，没有等价测试读数。
2. `/skill-bridge/*`、`/memory-bridge/*`、`/v3/instance/proxy-destroy` 是否有外部（脚本/别的仓库/用户机器）调用。
3. `src/mem-command/` CLI 是否仍有人手动用（本机无 alias/脚本引用，但用户机器未盘点）。
4. ClickHouse 是否有存量报表需求（本地 `clickhouse:"disabled"`，无法从本机证伪）。
5. `openclaw-plugin`（`@tencentdb-agent-memory/memory-tencentdb-v2`）是否已发布/有人在用 —— 需查 npm registry。
6. Knowledge 的 `llm_binding` 是否为「从未写入」还是「写入后被清空」—— 当前 0 行，原因未证实。
