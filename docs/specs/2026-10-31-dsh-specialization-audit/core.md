# MemoryCore 专项审计：插件化后的删 / 改 / 留

- 审计对象：`MemoryCore/`（557 文件 165,998 行非测试；`src/gateway` 18,677｜`src/core` 66,432｜`src/metadata` 10,210｜`src/offload*` 16,522｜`src/adapters` 1,256｜`src/api-trace` 470｜`src/services` 1,222｜`src/cli` 341｜`openclaw-plugin` 989）
- 口径：行数为 `wc -l`（排除 `*.test.ts`）；每条结论都附 `路径:行号`，端点级结论均做过「MemoryProxy/src + MemoryPanel/src + sdk + MemoryCore 自身」四向 grep 交叉验证。
- 判定标准：**D = 唯一存在理由是「LLM 流量经过我们 / 多端协议适配 / 未鉴权就地转发」**；**M = 逻辑有价值但入口或契约变了**；**K = 与流量路径无关**。

## 0. 一句话结论

MemoryCore 的**数据面几乎全是 K 或 M**——它本来就是「记忆内容的真源」，不是协议中间人。真正的删除量集中在**三个入口层产物**上：① `/v2` 双前缀孪生与已废弃的 v2 entity 路由（零调用方）；② 由「代理每请求注入 header / 自报身份」推导出的身份与分类字段（`x-tdai-*` 兜底、`classification`）；③ 由「每轮 LLM 调用」驱动而不该由「每回合」驱动的 `/v3/skill/conversation/*` buffer 链。**唯一必须整体搬迁而不只是改契约的模块是 proxy 的会话状态机（`MemoryProxy/src/session/form.ts` 1,202 行 + 六端 form/init），它目前不在 core 里**。

## 1. gateway 端点全清单 + 调用方交叉验证

core 的 HTTP 面由 6 张 route table 组成，注册点如下（均在 `MemoryCore/src/`）：

| 路由族 | 注册处 | 条数 | 外部调用方（grep 证据） | 结论 |
|---|---|---|---|---|
| L0–L3 数据面（`DATAPLANE_HANDLERS`） | `gateway/v2-router.ts:504-549`，双前缀在 `550-566` 展开 | 41 子路径 × 2 前缀 | Proxy `tdai/client.ts:154,195,336,367,398`；Panel `chat-memory.ts:593,1253,1376,1417,2620,3069,2832,2963` 等 | 路由 **K**，`/v2` 孪生 **D** |
| `/v3/recall`（唯一装配好的注入块） | `v2-router.ts:587` + handler `:1894` | 1 | **只有一个消费者**：Proxy `injection/injectors/tdai-l1-recall-injector.ts:215`（`:25` 注明降级回 `/v3/atomic/search`） | **M**（实现体直接变成 `/v3/dsh/context`） |
| `/v3/memory/mood` | `v2-router.ts:590` | 1 | Panel `chat-memory.ts:1763` | K |
| @deprecated v2 entity（team/user/agent/task） | `v2-router.ts:560-583`（16 条） | 16 | **全仓 0 命中**（注释已写「确认无外部调用方后整体删除」） | **D** |
| `/v3/skill/*` | `gateway/skill-handlers.ts:1138-1157` | 17 | Proxy `skill/core-client.ts:259,266,280,291,308,321`、`skill/skill-bridge.ts:585`（files/read）；Panel `skill/proxy.ts:21` → `kernel/adapters/fetch-skill-kernel-adapter.ts:20`（`/v3/skill/${action}`，动态拼路径，字面量 grep 会漏）；sdk `skill-client.ts:310-332` | 路由 K；`conversation/add`+`force-archive` **M** |
| `/v3/knowledge/*` | `gateway/knowledge-handlers.ts:144-154` | 5 | Panel `knowledge/callback-routes.ts:202`、`knowledge/common.ts:208` | K |
| `/v3/chat-memory/clear` | `gateway/chat-memory-handlers.ts:472` | 1 | Panel 治理面 | K |
| `/v3/meta/*` | `metadata/router/v3-meta-router.ts:84-317` 声明 55 接口 | 55 | Proxy `meta/client.ts:275,292,317,326,334,339,361,374,393,429,450,478`、`auth.ts:100`；Panel `meta/proxy.ts` | K/M |
| `/v3/internal/meta/*` | `metadata/router/internal-meta-router.ts:31` | — | 运维/无 user-key 通道（`server.ts:1330`） | K |
| `/v1/rerank` | `gateway/server.ts:1233` | 1 | MemoryKnowledge `rerank/client.ts:2-4`（内部服务调用） | K |
| `/v3/soul/introspect` | `gateway/server.ts:1248` | 1 | **panel/proxy/sdk/openclaw-plugin 全仓 0 命中** | **D 候选**（见 §6） |
| `/v3/admin/settings/*` | `gateway/admin-settings.ts` | — | Panel `settings.ts:92,102` | K |
| `/v2/offload/{ingest,query-mmd,compact}` | `offload_server/router.ts:35-88` | 3 | 只有 `offload-client/offload-api-client.ts:48,87,129`（用户机上的插件） | **M/D** |
| `/v2/cos/secret`（STS） | **本仓未实现**（`cos.ts:154` 拼的是平台侧端点；core 与 proxy 的 route table 均 0 命中） | 0 | sdk `cos.ts:154` ← `openclaw-plugin/src/tools/read-cos.ts` | **K（不是 core 的账）**，但 dsh 插件若保留 `read-cos` 工具，需另议平台端点 |
| `/v3/instance/destroy`、`/health`、`/whoami` | `server.ts:1224,1543` | — | `MemoryProxy/src/routes/instance-destroy.ts:2-5`（契约对齐） | K |

注：任务里点名的 `/v3/meta/listTeams|listAgents|listTasks` 在本仓**不存在**（现名 `/v3/meta/team/list`、`agent/list`、`task/list`，`v3-meta-router.ts:143,173,200`），无需删。

## 2. 只为「代理式接入」存在的逻辑（D 的主体）

| # | 位置 | 行数 | 为什么必须删 | 删除连带 |
|---|---|---|---|---|
| D1 | `gateway/v2-router.ts:550-566`（`/v2` + `/v3` 双前缀展开） | ~17 | 双前缀的唯一理由是「老客户端只认 /v2」。四向 grep：Panel / Proxy / Knowledge / sdk / openclaw-plugin / adapters **全部只用 /v3**，无一处 `/v2/` 数据面调用 | 无测试依赖双前缀的调用方（`v2-router` 系列测试需同步改）；`v2-schemas.ts` 复用不删 |
| D2 | `gateway/v2-router.ts:560-583`（16 条 deprecated entity 路由） | ~24 | 代码自己标注「仅为兼容现网保留，计划确认无外部调用方后整体删除」，现网调用方 = 0 | `handleTeam*/User*/Agent*/Task*` 16 个 handler + `entity_teams/users/agents/tasks` 四表（`core/store/sqlite.ts:1277-1334`）可随之退役 |
| D3 | **proxy 侧** `common/intent-classifier.ts` 产出的 `classification` 字段写入路径（core 侧接收口 `gateway/v2-schemas.ts:117-120`、落库 `core/store/sqlite.ts:1157,1205`、读回 `1249-1252`） | ~15（core 侧） | 该字段是「代理读懂了 LLM 请求体」才能算出来的行级标签（real/artifact/echo/scaffold/dup），生产者只有 proxy（`intent-classifier.ts:202`）；客户端直连模型后**没人能算** | 删则 L1 抽取失去结构性挡噪（`sqlite.ts:1249` 注释）；建议 M 而非 D：改为插件在 `/turn/end` 上报，缺省 `unclassified` 保持兼容 |
| D4 | `x-tdai-*` header 身份兜底 + `legacyCompatMode`（`gateway/v2-router.ts:155,172-197,378,716`；`core/store/isolation.ts:54-93`） | ~60 | header 身份是「代理替用户盖章」的产物；新方案身份由 token 盖章，不再信任调用方自报 | 需保留 `collectV3Missing` 的**校验语义**迁到控制面；`legacyPalindrome` 退化分支可删，但 `ensureChatMemoryAsset`（`v2-router.ts:826-835`）等副作用要保留 |
| D5 | `/v3/skill/conversation/add` 的「每轮 LLM 调用即追加」语义（`skill-handlers.ts:908-1025` + `core/skill/conversation-add/` 3,459 行） | ~3,459 | buffer 的写入节奏被「一次用户输入 → N 次 LLM 调用」放大（`v2-router.ts:874-876` 记录了 DSH 一次「继续」存 12 条的现场） | **不删机制，改驱动**：buffer/threshold/archive 全部保留，写入入口换成 `/v3/dsh/turn/end`（M6） |

## 3. api-trace / adapters / offload 三块到底是什么

| 模块 | 行数 | 是什么（读代码，不凭名字） | 与代理路径耦合度 | 结论 |
|---|---|---|---|---|
| `src/api-trace` | 470 | **不是 HTTP 抓包**。是对 `MetadataService` / `IMetadataStore` 的 Proxy 包装式调用追踪（`api-traced-proxy.ts:1-4,47+`，导出 `wrapApiServiceForTrace`/`wrapApiStoreForTrace`，`index.ts:35`），配 `runWithApiRequestContext`（`api-request-context.ts:23`）与脱敏 `sanitizeApiPayload`（`api-sanitize.ts`） | 零。与 LLM 流量无关，只看元数据服务调用 | **K** |
| `src/adapters` | 1,256 | **宿主 LLM 调用适配层**：把 openclaw（`adapters/openclaw/llm-runner.ts` 104 行，走 `runEmbeddedPiAgent`）与 standalone（`adapters/standalone/llm-runner.ts` 642 行，注释 `:1-25` 明确「Hermes Gateway 独立 sidecar，Vercel AI SDK 直连」）抽象成 core 的 `LLMRunner` | 中：这是 **core 自己调 LLM 做 L1/L2/L3 抽取**，不是被代理的用户流量；但存在反向依赖——`gateway/llm-resolver.ts:91` 在 `llm.provider=proxy` 时把抽取调用指向 proxy 的 `/proxy/<iid>/v1`（消费点 `core/tdai-core.ts:636,987,1037,1082`） | **K，但删转发前必须先解掉 `provider=proxy`**（否则删 proxy 会连带打死 core 的抽取） |
| `src/offload`（10,455） | 10,455 | openclaw 插件内的**上下文卸载/压缩**实现：`hooks/after-tool-call.ts`(594)、`hooks/before-prompt-build.ts`(276)、`hooks/llm-input-l3.ts`(1,412) 的压缩级联、`pipelines/l2-mermaid.ts`(286)、`storage.ts`(664) | 低（与 LLM 转发无关），但**与 openclaw 宿主钩子强耦合** | **M**：dsh 有对应的 `agent/pre-step`，压缩级联可重接；否则 D |
| `src/offload_server`（4,904） | 4,904 | 服务端三端点 `/v2/offload/{ingest,query-mmd,compact}`（`router.ts:35-88`）+ `compact/compressor.ts`(1,194) 压缩实现 + `offload-task-executor.ts`(745) | 中：**它就是「客户端在用户机、服务端在 core」的既有先例**，形状与新方案同构 | **K/M**：`/v2/offload/*` 前缀是旧协议面（D 候选），但 executor/compressor 是资产；可以整体收编为 `/v3/dsh/*` 的一个能力 |
| `src/offload-client`（1,163） | 1,163 | 用户机侧瘦客户端：`offload-api-client.ts`(177) + `context-engine.ts`(526)，注册 `after_tool_call`/`agent_end`/`gateway_stop` 钩子（`index.ts:31-60`） | 中：同上，是新方案的**参考实现** | **M**（改造成 dsh 插件的一部分）或 D（若 dsh 插件不接管上下文压缩） |
| `src/services`（1,222） | 1,222 | `pipeline-worker.ts`(843) 异步 L1 抽取 worker + `timer-scanner.ts`(281) + `worker-permit-pool.ts`(98) | 零 | **K** |

## 4. 控制面落 core 还是 proxy，以及最省改动的暴露入口

**结论：控制面必须落 core（`MemoryCore/src/gateway`），proxy 只留一个转发壳。** 三条硬理由：① 待删层不能承载新契约；② `/v3/*` 的鉴权（`parseV2Auth` + `authenticateV3`）、隔离（`resolveIsolation`）、存储（`getStore`）全部在 core 的 `V2RouterDeps`（`v2-router.ts:294-340`）里；③ 装配注入块的能力只在 core（proxy 的 injector 是「调用方」，`tdai-l1-recall-injector.ts:215`）。

可复用入口（直接挂 `/v3/dsh/*`，不必重写）：

> （已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）。下表按目标态保留；v0 插件不挂新前缀，直连同义的现有 `/v3/*` 端点。

| 控制面端点 | 复用入口（路径:行号） | 说明 |
|---|---|---|
| `/v3/dsh/context`（回合头） | `gateway/v2-router.ts:1894` `handleRecall` | `/v3/recall` 已经产出「组装好的注入块」，改签名为接受 `turnId/historyMeta/budgetChars` 即可 |
| L1 召回 | `core/hooks/auto-recall.ts:455` `performAutoRecall` | 意图去重、同会话抑制已在此 |
| 分层召回 / L2/L3 画像 | `core/hooks/auto-recall.ts:984` `performLayeredRecall`；混合检索 `:3040` `searchHybrid` | 预算与 evidence pack 在 `core/recall/layered-budget.ts`、`evidence-pack.ts` |
| `/v3/dsh/turn/end`（回写） | `gateway/v2-router.ts:789` `handleConversationAdd` + `core/conversation/l0-recorder.ts:93` `recordConversation` | 复用其 batch embed（`:905-917`）与 dedupe（`:874-902`），替换成 `(sessionId, turnId)` 幂等 |
| `/v3/dsh/handshake`（身份） | `metadata/router/v3-meta-router.ts:301` + `metadata/service/metadata-service.ts:665` `verifyAuthForCaller` | user_key 校验语义原样复用，签发短时 token |
| `/v3/dsh/tools/*` | `skill-handlers.ts:1138-1157`、`knowledge-handlers.ts:144-154`、`v2-router.ts:504-549` | 只是「改名 + token 鉴权 + 薄封装」，handler 体不动 |
| 会话状态机 / FormSpec | **不在 core**：`MemoryProxy/src/session/form.ts`(1,202)、`session/{codex,dsh,workbuddy,opencode}/form.ts` | 唯一必须**搬迁**的模块；语义与文案常量逐字保留，输出改 JSON |
| L2/L3 画像文件读写 | `core/profile/profile-sync.ts:145,270,466,497` | 客户端拉取上下文时的画像来源 |

## 5. 数据层：谁唯一写、以及 `/v3/conversation/add` 无幂等键的现实影响

| 表 / 字段 | 定义处 | 现状唯一写入者 | 结论 |
|---|---|---|---|
| `l0_conversations`（11 列） | `core/store/sqlite.ts:1128-1141` | 每回合由 proxy 调 `/v3/conversation/add`；Panel 只在「导入补录」时写（`chat-memory.ts:593`） | **M**：加 `client_turn_id` 列 + `UNIQUE(session_key, client_turn_id)` |
| `record_id` | `v2-router.ts:852` `msg-${randomUUID()}` | **服务端生成**，客户端无法预置 | 这是「无幂等键」的根因：重试必产生新 id |
| `classification` | `sqlite.ts:1157`（迁移）、`:1205`（写） | **只有 proxy**（`intent-classifier.ts:202`） | D/M，见 §2-D3 |
| `session_key` / `session_id` | `sqlite.ts:1128-1131` | proxy 从 header 指纹推（`MemoryProxy/src/session/store.ts` 828 行） | **M**：sessionId 改由 handshake 分配 |
| `task_id` | `sqlite.ts:1133` | proxy 解析表单后回填 | **M**：改由 `/v3/dsh/session/answer` 回填 |

**无幂等键的现实影响（两个方向都错）**：
1. **漏**：同一条消息在 10 分钟内重发会被**静默吞掉**（`v2-router.ts:874-902`，窗口硬编码 `600000`ms，判据是 `session+role+content`）。用户真说两次「继续」→ 只存一条。这是已经为「代理重复提交」打的补丁，但它用「内容相同」近似「同一条」。
2. **重**：超过 10 分钟的重试/乱序补发 → 全部落成新行（新 UUID），取证链断号（`v2-router.ts:843-846` 注释记录了同类事故：#121 曾把 UUID 截成 12 hex 导致 upsert 静默覆盖）。
3. **不可判定**：去重是 `feature-detect`（`hasRecentL0Duplicate` 仅在 `core/store/sqlite.ts:5590` 实现，`core/store/types.ts:1018` 为可选方法）——换 store（TCVDB）时**去重整个消失**而响应不变。

## 6. 不确定清单（需要人或运行期证据）

1. `/v3/soul/introspect`（`server.ts:1248`，`soul-introspect-endpoint.ts` 115 行）判为 D 候选，依据是 panel/proxy/sdk/openclaw-plugin 四向 0 命中。但仓库里还有 `agents/`、`hermes-plugin/`（0 行 ts）、`deploy/` 可能以脚本/配置方式调用，**未验证**。
2. `/v2` 双前缀是否真无外部调用方：我 grep 了仓内 6 个消费者目录；仓外（老版本 openclaw 插件、客户自建脚本）无法证明。D1 的删除需要一条「线上 7 天无 /v2 数据面请求」的运行期证据。
3. `classification` 删还是改：取决于 L1 抽取对它的实际依赖强度（`core/record/l1-writer.ts:62` 只提到 importance 来源）。需要看 L1 批次在无 classification 时的抽取质量基线。
4. offload 三块是 K 还是 M 取决于一个产品决策：**dsh 插件是否接管上下文压缩**。若不接管，`offload_server`(4,904)+offload(10,455) 共 15,359 行整体 D；若接管，只需替换钩子层。
5. `llm.provider=proxy`（`gateway/llm-resolver.ts:91` → `core/tdai-core.ts:636,987,1037,1082`）这条反向依赖：lead 已确认存在，我未逐行复核消费点；删 proxy 前必须实测 core 抽取在 `provider` 改为直连后是否仍能跑通（embedding 与 chat 模型是两套配置）。
6. `/v3/skill/*` 的 14 个 action 里哪些有真实流量：Panel 走的是 `/api/v1/skill/${action}` 动态拼路径，静态 grep 无法给出逐 action 命中；需要一次运行期访问日志。
7. `/v3/knowledge/*` 与 `/v3/chat-memory/clear` 的调用方我按 Panel 静态调用计为 K，但 MemoryKnowledge 服务是否也直连 core 未验证（`MemoryKnowledge/src` 只 grep 到 `/v1/rerank`）。
