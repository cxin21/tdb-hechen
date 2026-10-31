# MemoryPanel 专项审计：LLM 流量不过代理之后

- 日期：2026-10-31
- 前提：`docs/specs/2026-10-31-dsh-native-memory-plugin-spec.md`（dsh 插件 + 服务端记忆控制面）；边界裁决见本目录 `README.md` §0/§3（控制面留在原 MemoryProxy，内部保留最小 LLM 网关 M1）。
- 口径：**D 删** = 唯一存在理由是「LLM 流量经过我们 / 多端协议适配 / 未鉴权就地转发」；**M 改** = 逻辑仍有价值但入口或契约变了；**K 留** = 与流量路径无关。
- 范围实测（`ls MemoryPanel/web/src/pages` + 逐目录 `wc -l`）：13 个页面目录，ts/tsx **22,755** 行 + css **6,771** 行；后端 `MemoryPanel/src/panel` **9,377** 行。Knowledge 侧结论见 `knowledge.md`（由 injection-analyst 负责），本卷不重复。

## 1 结论

Panel 的删改账**极小**：13 个页面里只有 1 个 D（LlmProviderPage，347+52 行），4 个 M（GuidePage、ApiKeysPage、SkillsPage、CodePage），其余 8 个 K。后端 `src/panel` 里真正要动的也只有 3 条透传和一个启动副作用，合计约 460 行。

关键在于：**Panel 从来没有「代理运维台」这一类页面**。会话初始化日志、注入排查、cost-guard、限流、按请求 token 看板——grep 全仓后确认**这五类页面不存在**。限流与计费只在 `MemoryProxy/src/routes/rate-limits.ts`(151)、`credit-pricing.ts`(119)；Panel 只保留了「计费价目表」透传页签。所以「删面板页」不是主要工作，**主要工作是身份契约换血 + 接入向导从 7 端砍到 1 端**。

第二个发现：Panel 与后端的耦合只有两种，**没有任何直读 proxy 的 ClickHouse 表或共享库**——全 `MemoryPanel/src` grep `clickhouse|redis|sqlite|postgres` 只命中 1 处注释（`chat-memory.ts:491`）。唯一「共享存储」是直读 core 的 recall journal 日志目录（`chat-memory.ts:51-70`），这条是跨机后第一个炸的点。

## 2 页面清单（`ls` + `wc -l` 实测，逐个 D/M/K）

路由表：`MemoryPanel/web/src/routes/index.tsx:22-41`（createHashRouter）。

| 页面目录 | ts/tsx | css | 存在理由 | D/M/K | 依据（路径:行号） |
|---|---|---|---|---|---|
| ChatMemoryPage | 7,119 | 2,858 | 记忆浏览：3-tab（资产/数据/待办） | **K**（M：召回日志字段） | 数据全走 `/api/v1/chat-memory/*`；直读日志 `chat-memory.ts:51-70,3132-3208` |
| WikiPage | 3,680 | 729 | 资产：wiki 源管理/原文/页面 | **K**（M：身份头） | `http-knowledge-client.ts:94-190` |
| SkillsPage | 2,319 | 456 | 资产：团队 skill | **M** | 后端 `skill/proxy.ts`(52) 透传 proxy；spec 删 `/skill-bridge/*` |
| CodePage | 1,308 | 128 | 资产：服务端 code-graph | **M** | 依赖 knowledge `/v3/code-graph/*`；若服务端 code-graph 退役则随之下线 |
| SoulPage | 1,245 | 958 | 画像/人格面 | **K** | 无 proxy 依赖 |
| WorkbenchPage | 967 | 416 | 任务板 | **K** | `/api/v1/task/*` |
| SettingsPage | 871 | 0 | 设置（knowledge/memory/rerank/pricing 4 页签） | **K**（M：pricing 语义） | `:848-868` 页签；`:375-409` 三真源；pricing `:850-853` |
| GuidePage | 836 | 919 | 接入向导（实例与引导页） | **M** | `:26` 7 端 id、`:51`、模板 `:80,89,98,107,116,125`、`:303` 缺省 8096 |
| ApiKeysPage | 411 | 77 | user_key 生命周期 | **M** | `ApiKeyPanel.tsx:330` 自述与 proxy 会话初始化 + `mem:` 命令族耦合 |
| LlmProviderPage | 347 | 52 | 成员自定义 LLM Provider | **D** | `LlmProviderPanel.tsx:5-12` 自述「归属校验在 proxy」；数据 `llm-providers.ts:42` |
| ResourcePage | 179 | 178 | 资源/引用浏览 | **K** | 无 proxy 依赖 |
| MembersPage | 18 | 0 | 薄壳重定向 | **K** | — |
| AgentsPage | 18 | 0 | 薄壳重定向 | **K** | — |

**逐个回答你点名的九类页面**：

| 你点名的能力 | 现状 | 判定 |
|---|---|---|
| 会话初始化日志 | **不存在**（grep 无页面；会话初始化在 proxy，见 `MemoryProxy` 卷） | 无需删；跨机后由「会话/回合」新页替代（§5） |
| 注入排查 | **不存在**（注入日志在 proxy 内核，Panel 无对应页） | 同上，新页 2 承接 |
| cost-guard | **不存在**；策略在 `MemoryProxy/src/routes/credit-pricing.ts`(119) | 无需删页面 |
| 限流 | **不存在**；只在 `MemoryProxy/src/routes/rate-limits.ts`(151)；web 仅 i18n 文案 `web/src/i18n/zh-CN.ts:1556`、`lib/error-message.ts:67` | 无需删页面 |
| LLM provider 设置 | **LlmProviderPage**（347+52）+ 后端 `llm-providers.ts`(111) | **D**（成员自服务语义消失；M1 下若留凭据 SoT 则降级为管理员页 → M，见 §6） |
| 按请求 token 看板 | **不存在**；Panel 只有 pricing 价目表页签（`SettingsPage/index.tsx:850-853` → `settings.ts:127-141`） | 价目表 **K**（M1 保留计费）；按请求用量看板是**新增**（§5 页 4） |
| 实例与引导页（8096） | GuidePage：7 端模板写 baseURL 指向 8096 | **M**：只留 dsh，模板从「填 baseURL」改为「装插件 + handshake token」；8096 兜底 `:303` 改控制面域名 |
| 记忆浏览 | ChatMemoryPage（7,119+2,858） | **K** |
| 资产与团队管理 | WikiPage / CodePage / SkillsPage / SoulPage / ResourcePage / MembersPage / AgentsPage | Wiki/Soul/Resource/Members/Agents **K**；Code/Skills **M** |

## 3 后端 `src/panel` 清单与存储读取

挂载序（`http/app.ts:26-42`，`API_PREFIX=/api/v1` 见 `:17`）：meta-instances → meta/proxy → skill/proxy → chat-memory → task → agent-overview → agent-lifecycle → knowledge → llm-providers → settings。

| 文件 | 行数 | 职责 | D/M/K |
|---|---|---|---|
| `http/routes/chat-memory.ts` | 3,471 | 记忆 3-tab 业务路由（12 端点） | **K**（M：`:51-70` 日志直读） |
| `http/routes/knowledge/common.ts` | 618 | knowledge 路由共用（身份/信封/任务登记） | **K**（M：身份换 token） |
| `http/routes/meta/proxy.ts` | 514 | core `/v3/meta/*` 透传 + 白名单/501/查重/模板文件 | **K** |
| `http/routes/knowledge/wiki-routes.ts` | 379 | wiki 控制面代理 | **K** |
| `http/routes/agent-overview.ts` | 369 | Agent 概览聚合 | **K** |
| `http/routes/knowledge/allocate-routes.ts` | 273 | wiki 分配 | **K** |
| `http/routes/knowledge/callback-routes.ts` | 256 | 承接 KS 的 ingest 进度/状态回调 | **K** |
| `http/routes/meta/default-skills.ts` | 236 | 默认 skill 资产复制 | **K** |
| `kernel/ports/knowledge-client-port.ts` | 235 | knowledge 端口契约 | **K** |
| `kernel/transport-fetch.ts` | 232 | 信封式内核调用 | **K** |
| `kernel/adapters/http-knowledge-client.ts` | 227 | 调 KS `/v3/wiki/*`、`/v3/code-graph/*` | **K**（M：serviceId 来源） |
| `http/routes/knowledge/code-graph-routes.ts` | 211 | code-graph 代理 | **M** |
| `startup/ensure-knowledge-llm-binding.ts` | 195 | 启动时向 KS 推 per-instance LLM binding + 建隐藏计费用户 | **K**（M1 改指内部网关） |
| `http/routes/task.ts` | 162 | 任务聚合 | **K** |
| `http/routes/agent-lifecycle.ts` | 162 | agent 删除级联 | **K** |
| `state/ingest-progress-store.ts` | 161 | ingest 进度缓存 | **K** |
| `http/routes/settings.ts` | 142 | knowledge / memory / rerank / proxy-pricing 四路透传 | **K/M**（pricing 段 M） |
| `config/instance-registry.ts` | 124 | 实例注册表 | **K** |
| `http/routes/llm-providers.ts` | 111 | proxy `/v3/admin/llm-providers` 纯透传 | **D** |
| `domain/chat-memory-governance.ts` | 107 | 记忆治理 | **K** |
| `api/meta-actions.ts` | 102 | meta action 白名单 | **K** |
| `config/panel-config.ts` | 89 | env 装配（含两条 proxyBaseUrl） | **M** |
| `skill/proxy.ts` | 52 | skill 数据面透传 proxy | **M** |

**是否直读 proxy 的 ClickHouse/共享存储：不读。** 证据：`grep -rn 'clickhouse|redis|sqlite|postgres' MemoryPanel/src` → 仅 `chat-memory.ts:491` 一条注释（提到 core 的 `store/sqlite-adapter.ts:1020` 缺省 manual）。所有数据面都是 HTTP：`meta/proxy.ts:204`（`deps.metaKernel.invoke`）、`settings.ts:92,102,124,137`、`http-knowledge-client.ts:63`。

唯一非 HTTP 耦合：**直读 core 日志目录**（`chat-memory.ts:51-70`：解析序 `TDAI_RECALL_JOURNAL_DIR` > `TDAI_DATA_DIR`，缺失抛 `RECALL_JOURNAL_DIR_UNRESOLVED`；`:3163` stem、`:3166` 5 份轮转、`:3180` 倒序、`:3181-3183` 以 `skipReason` 判 skip）。前端 `web/src/pages/ChatMemoryPage/components/RecallJournalView.tsx`（285 行，`:9` 自述「零改内核」）、`web/src/lib/api/chat-memory.ts:356`。

## 4 `meta/proxy.ts` 的透传职责（K 的边界，别误删）

| 职责 | 位置 | 说明 |
|---|---|---|
| 白名单 | `meta/proxy.ts:149-219`，`ALLOWED_PANEL_ACTIONS` | 只放行登记过的 `action`，其余 404 |
| 越界拒绝 | 同段 `isNotInScopeAction` | 越界 action 返 501 `NOT_IN_SCOPE` |
| 创建查重 | `:58-99`（`DUP_CHECK_MAP`） | create 类先查重，查重失败放行（`:141-143`） |
| 默认 Agent 模板 | `:186-202` | **直读写本地文件**（`config.agentTemplateDir`），不经内核 |
| 成员默认资产 | `:204-210` 后 `cloneDefaultAgentForNewMember` | best-effort 异步 |
| 隐藏内部用户 | `:24-34` `hideKnowledgeServiceUser` | 从 `user/list` 抹掉 `knowledge-service`（与 `ensure-knowledge-llm-binding.ts:24` 的常量同源），M1 下必须保留 |
| 身份上下文 | `:168-175` `MetaCallContext` | `instanceId/gatewayEndpoint/gatewayApiKey/userKey` 由 header 校验中间件注入（`middleware/validate-panel-headers.ts` 63 行） |

结论：这层是「控制面 HTTP 契约」而不是「LLM 转发」，**整层 K**；只有 `:24-34` 的隐藏用户逻辑随 M1 的计费存废而动。

## 5 两条透传改直连怎么改

三处外部事实（已核）：`config/panel-config.ts:82` `knowledgeLlmBinding.proxyBaseUrl`（`KNOWLEDGE_LLM_PROXY_BASE_URL`，缺省 `http://127.0.0.1:8096`）、`:86` `llmProvider.proxyBaseUrl`（`LLM_PROVIDER_PROXY_BASE_URL`，同缺省）、`startup/ensure-knowledge-llm-binding.ts:98,153` 用的是 `proxyBaseUrl`。

| 链路 | 现状 | 改法（推荐 M1） | 影响面 |
|---|---|---|---|
| KS 的 LLM 出口 | Panel 启动时 `/v3/internal/llm-binding/set` 推 `{mode:'proxy', proxy_base_url: 8096}`（`ensure-knowledge-llm-binding.ts:98,153`） | **不改协议，只改地址**：`knowledgeLlmBinding.proxyBaseUrl` 指向内部最小网关（回环新端口或 8096 保留网关前缀），并把 `mode` 语义文档改为 `internal-gateway` | KS `store/llm-binding-store.ts:138` 的 baseUrl 拼装（`{proxy_base_url}/proxy/{service_id}/v1`）不动；隐藏计费用户 `knowledge-service` 保留 |
| 成员自定义 Provider | `llm-providers.ts:9,42` 透传 `{llmProvider.proxyBaseUrl}/v3/admin/llm-providers` | 两选：**(a) D** 整条删（含 `LlmProviderPage` 347+52）——dsh 用本地模型配置；**(b) M** 改直连内部网关的 `/v3/admin/llm-providers`，仅系统管理员可见 | (a) 删 `app.ts:39` 一行注册 + 页面 + `web/src/lib/api/llm-providers.ts`(99)；若还有非 dsh 成员用自有模型，(b) 才安全 |
| 计费价目表 | `settings.ts:127-141` 把 POST 翻成 GET/PUT 打 `{proxyBaseUrl}/v3/admin/credit-pricing`，`:130` 注释「上游为内网信任模型，无需注入鉴权头」 | **M**：M1 保留计费则只把 baseUrl 换成内部网关，并补鉴权头（内网信任模型在跨机后不成立） | `SettingsPage` pricing 页签 + `web/src/lib/api/settings.ts:216` |
| rerank 设置 | `settings.ts:109-124` → core `/v3/admin/rerank-model/*` | **K**（与 LLM 流量无关） | — |
| knowledge/memory 设置 | `settings.ts:84-102` → KS / core `/v3/admin/settings/*` | **K**（M：KS 侧鉴权收紧） | `SettingsPage` knowledge/memory 页签 |

## 6 字段来源变化 → 要改的组件

| 字段/契约 | 旧来源 | 新来源 | 受影响组件 |
|---|---|---|---|
| 实例身份 `instanceId`→`x-tdai-service-id` | `panel-deps.ts:40-46` 用 `instanceId` 当 serviceId | 控制面按 token 绑定的 `spaceId` | `http-knowledge-client.ts:62`、`knowledge/common.ts`(618)、全部 knowledge 代理路由 |
| 面板请求身 | header 注入 `MetaCallContext`（`validate-panel-headers.ts` 63） | 登录态不变（Panel 仍是人用的控制台） | **K**，无需改 |
| 接入 baseURL/端口 | GuidePage 模板 `:80-125`、8096 兜底 `:303` | 控制面域名 + `/v3/dsh/handshake` token | GuidePage（836+919） |
| user_key | proxy 会话初始化的 `mem:` key（`ApiKeyPanel.tsx:330`） | 设备/会话 token（`tm_*`，TTL 30min，epoch 可 bump） | ApiKeysPage（411+77）、`web/src/lib/api/*` |
| 召回日志行 | core `gateway/v2-router.ts:138,2019,2036` 注入路径写入；skip 判据 `skipReason` | `/context` 装配路径写入 | `chat-memory.ts:3152-3192`、`RecallJournalView.tsx` 的 strategy/query label |
| 计费/用量 | proxy 按请求计费 | `/turn/end` 自报 usage（`source=client_reported`） | 现无页面承接 → 新增（§7 页 4） |

> （已更正，见 spec 头部「实测更正」节）：v0 无 `/v3/dsh/handshake` 与 `/turn/end`——身份由 apiKey + `team_id/agent_id/user_id` 三元组给定，usage 真源是 `session/event` 的 `assistant/message.data.usage`（见 spec 头部「实测更正」#2/#4）。

## 7 跨机后需新增的最小页面（4 个 + 1 可选）

| # | 页面 | 最小内容 | 数据来源 |
|---|---|---|---|
| 1 | 设备与会话 | 设备列表、active session、`(spaceId,userId,epoch)`、撤销（触发 40901） | `/v3/dsh/handshake` 记录 |
| 2 | 上下文装配诊断（承接旧「注入排查」诉求） | 单次 `/context` 的块清单、耗时（700ms 预算）、fail-open 次数 | `/context` 审计 |
| 3 | Outbox 与回写 | 客户端 outbox 积压、`/turn/end` 幂等键命中、失败补偿 | `/turn/end` 记录 |
| 4 | 回合与用量 | 按 `sessionId+turnId` 的回合、usage（标注 `source=client_reported`） | `/turn/end` 落表 |
| 5（可选） | 知识可见性 | `space → wiki/code-graph` 绑定 | KS 租户维度 |

现有 13 页**一页都不用删**来给这 5 页腾位置：接入向导（GuidePage）砍到 1 端后会空出约 700 行模板代码，可原地改造成页 1 的「设备接入」向导。

## 8 不确定清单

1. **LlmProviderPage 是 D 还是 M**：取决于 M1 是否保留 `/v3/admin/llm-providers` 作为凭据单一真源（README §3 的 M1/M2 尚未签字）。若保留，本页降级为管理员页（M）。
2. **`ensure-knowledge-llm-binding.ts` 的隐藏计费用户**是否还建：M1 保留计费则保留；否则要同时改 `meta/proxy.ts:24-34` 的隐藏逻辑（否则列表里冒出 `knowledge-service`）。
3. **Panel 与 Core/Knowledge 是否永远同机**：`chat-memory.ts:51-70` 直读日志目录的假设，只在同机成立；跨机部署 Panel 需改 HTTP（core 现有日志读取接口是否覆盖 counts/filter 未核）。
4. **`/skill-bridge/*` 删除后 SkillsPage 走哪条链路**（`skill/proxy.ts` 52 行）：需 proxy 卷结论，本卷只能说「必须改」。
5. **portfolio 级用量看板是否要保留团队维度**：`/turn/end` 自报 usage 的 teamId 由 token 绑定，跨 team 汇总口径需产品确认。
6. **pricing 页签在 M1 下是否仍对成员可见**：`:130` 的「内网信任、不注入鉴权头」在控制面公网化后不成立，需补鉴权，具体鉴权形态依赖 M1 网关设计。
