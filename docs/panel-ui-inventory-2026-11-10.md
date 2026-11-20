# MemoryPanel 现状接口与交互清单（UI 重设计前基线）

取证日期 2026-11-10。取证方式：两路只读子代理逐文件读源码（未运行服务、未打接口、未跑测试），产物 `.scratch/panel-api-server.md`（BFF 面）与 `.scratch/panel-api-web.md`（前端面），本文件是两份合并 + 前置约定 + 我的判断。所有结论带 `path:line`，路径相对 `D:\TDB\td-agemem`。

## 怎么读

- 第一部分是 8123 上 BFF 对外的全部 HTTP 面：每条路由的方法、路径、鉴权档、入参、返回结构、上游映射、错误码。
- 第二部分是 web 端每个模块调哪些接口（参数与返回类型逐字段），以及九个旧页面与七座星图 station 的布局和交互。
- 要重设计，先看「七条前置事实」和「四件必须先拍的事」，再看细表。

## 七条前置事实（决定重设计能怎么动）

1. 信封统一 `{code, message, request_id, data}`，且 `400 ≤ code < 600` 会被直接当作 HTTP 状态码返回（MemoryPanel/src/panel/kernel/envelope.ts:11-15）；未捕获异常回 `{code:500,message:'INTERNAL'}`（http/app.ts:56-65）。前端 409 冲突正是靠信封里的 `data` 分流（web/src/lib/api/base.ts:63-84）。
2. 鉴权四档：H（service-id + user-key）、H+U（换成 userId）、H+T（团队成员）、H+K（资产 ACL）。除 `POST /api/v1/meta/auth/verify`，每条路由都要 `X-Tdai-User-Key`；缺头回 400 `MISSING_INSTANCE_ID`/`MISSING_USER_KEY` 而不是 401（middleware/validate-panel-headers.ts:34-53）。
3. 限速按 user-key 120/min、IP 60/min（http/middleware/rate-limit.ts:47-48），超限 429 + Retry-After。重设计别把一屏做成几十个并发首屏请求。
4. 两条通配代理兜住大头：meta 57 个可用 action、skill 15 个，新增页面多数不需要新 BFF 路由，只需要接对 action。
5. 分页口径三种并存：meta 系 `limit/offset`（META_PAGE_SIZE=100）、chat-memory 与 recall-journal 各有一套（后者 `page/page_size`）、wiki/code 列表干脆不分页全量拉再前端筛。
6. 已存在一层星图新壳：`/` 是 StarmapLayout + 七站抽屉，旧九页整体退到 `/legacy/*`（web/src/routes/index.tsx:32-68）。
7. 前端会话是 sessionStorage 里的 instance_id + user_key，无 Cookie；401 会派发 `auth:unauthorized` 事件清会话（web/src/lib/api/base.ts:88-106）。

## 数字

77 条路由注册（75 条逐条 + 2 条通配）；知识域 34 条最多，chat-memory 28 条，soul 与人物 7 条，设置 3 条，agent-overview 1 条，基础 2 条；meta 展开 57 个可用 action，skill 展开 15 个。前端调用面覆盖 7 个模块、九页 + 七站。

## 四件必须先拍的事（我的判断，供讨论）

1. 一个壳还是两个。现在 `/` 的星图壳没有 GlobalHeader，也就没有登出、语言切换、设置弹窗、使用说明（starmap/StarmapLayout.tsx:112-142），而全仓没有任何链接指向 `/legacy`（grep 'legacy' 只命中路由定义），落 `/` 的用户只能手改 hash 才能登出。重设计第一步应当是把「顶栏该有什么」定死，而不是先画页面。
2. 「挂到智能体」一处四义。Wiki/Code/Memory 是引用（AllocateAssetDialog），Skill 的分配也是引用，Fork 是复制出可写副本，导入是写入并发新版本——按钮长得一样、后果不同（SkillsPanel.tsx:11-16、ForkSkillDialog.tsx:84-121）。
3. 列表与详情的关系有三套现成模式：旧页的整页 subView 替换（Wiki/Code 详情）、可拖 220–480px 的左右分栏（Skills/Memory，宽度落 localStorage）、星图站的抽屉。选哪套直接决定每个页面要重写多少。
4. 空态与失败的呈现没有统一层：全是各页 `tea.notify` + StatusTip/Alert 手写（web/src/pages/**），上游 502/504 原样透出（soul 相关路由），缺头 400 与参数错 400 无法区分。

---

## 一、BFF 接口面（77 条路由，逐条）

> 取证方式：只读源码，逐文件 cat -n / grep。未运行服务、未打接口、未跑测试。
> 仓库：`D:\TDB\td-agemem`。取证提交号：**未采集**（本轮未执行 git 命令）。
> 服务端口 8123：本轮未读监听启动文件，**未采集**。

### 0. 通用约定

#### 0.1 前缀与挂载

| 事实 | 定位 |
|---|---|
| 常量 `API_PREFIX = '/api/v1'` | MemoryPanel/src/panel/http/app.ts:17 |
| 子 app 统一挂载：`app.route(API_PREFIX, api)` | MemoryPanel/src/panel/http/app.ts:54 |
| 注册顺序：meta/instances → meta/proxy → skill/proxy → chat-memory → chat-memory-soul → soul-persons → agent-overview → knowledge → settings | MemoryPanel/src/panel/http/app.ts:40-53 |
| `/health`（无前缀）与 `/api/v1/meta/instances` 由 `registerHealthRoutes` / `registerMetaInstanceRoutes` 分别挂到 app / api | MemoryPanel/src/panel/http/app.ts:37, :40 |
| 静态兜底：非 `/api/` 且非 `/health` 的 GET 回 `index.html`；`/api/` 前缀下落空 → Hono 默认 404（响应体形态**未采集**） | MemoryPanel/src/panel/http/app.ts:68-73 |

#### 0.2 信封与状态码映射

- 成功信封 `{code: 0, message: 'ok', request_id, data}`（`okEnvelope`，MemoryPanel/src/panel/http/routes/knowledge/common.ts:45-47；chat-memory.ts:2960）。
- 控制信封 `{code, message, request_id, data: null}`（MemoryPanel/src/panel/http/envelope.ts:5-16）。
- code → HTTP：`400 ≤ code < 600 → code`；`code === 0 → 200`；其余 → 502（MemoryPanel/src/panel/kernel/envelope.ts:11-15）。**因此 code 503 真回 HTTP 503、code 501 真回 501。**
- 未捕获异常 → `{code:500,message:'INTERNAL',request_id,data:null}` + HTTP 500（MemoryPanel/src/panel/http/app.ts:56-65）。
- `request_id` 取 `c.get('reqId')`（MemoryPanel/src/panel/http/envelope.ts:23）；request-logger.ts 的生成规则本轮未逐行读 → **未采集**。

#### 0.3 鉴权档位（下表代号）

| 代号 | 含义 | 缺失/失败返回 | 定位 |
|---|---|---|---|
| `H` | `validatePanelMetaHeaders`：要 `X-Tdai-Service-Id` + `X-Tdai-User-Key` | 缺 service-id → **400** `MISSING_INSTANCE_ID`；registry 解不出 → **400** `INVALID_INSTANCE`；缺 user-key → **400** `MISSING_USER_KEY` | validate-panel-headers.ts:34-53 |
| `H+U` | H + `requireChatMemoryCaller`（把 header user-key 换成 userId） | 证不出人 → **401** `INVALID_USER_KEY`（先于 body schema） | chat-memory.ts:3006-3015 |
| `H+T` | H + 路由体内 `requireTeamMember` | 无 caller → **401** `INVALID_USER_KEY`；非成员 → **403** `NOT_TEAM_MEMBER` | knowledge/common.ts:101-112 |
| `H+K` | H + `requireKnowledgeRead`（meta asset/get + acl/check） | 无 caller 401；非成员/无 ACL 403 `FORBIDDEN` / `NOT_TEAM_MEMBER`；不存在 404 `KNOWLEDGE_NOT_FOUND` | knowledge/common.ts:338-374 |
| `—` | 无中间件 | — | 见各条 |

要点：`readAction` 只在路径里找 `/meta/`，找不到返回空串（validate-panel-headers.ts:24-29），所以 **除 `auth/verify` 外，每条 `H` 路由（含所有非 meta 路由）都强制要 user-key**；只有 `POST /api/v1/meta/auth/verify` 免 user-key（:49）。

#### 0.4 限速

- 仅作用 `/api/v1/*`（MemoryPanel/src/panel/http/app.ts:34）；`/health` 与静态资源不限。
- 两条腿：同 user-key **120/min**、同客户端 IP **60/min**（rate-limit.ts:47-48）；`options.rateLimit === false` 可整层关闭（仅测试，app.ts:33）。
- 超限 → **429** `RATE_LIMITED` + `Retry-After` 秒（rate-limit.ts:124-127, :133-136）。
- 回环地址与取不到连接信息时不计 IP 维度（rate-limit.ts:50, :86-98）。
- 固定窗口非滑窗；桶表上限 10000，超了先清过期再整表清空（rate-limit.ts:105-115）。

---

### 1. 基础与元信息（2 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `GET /health` | — | 无 | **无信封** `{status:'ok'}` | 本地 | 无（meta/instances.ts:5） |
| `GET /api/v1/meta/instances` | — （**不挂 H**） | 无 | **无信封** `{instances: instanceRegistry.listPublic()}`；listPublic 字段集**未采集** | 本地 | 无（meta/instances.ts:9-10） |

### 2. 通用透传代理（2 条路由，展开 72 个 action）

#### 2.1 `POST /api/v1/meta/*`

| 项 | 内容 |
|---|---|
| 注册 | meta/proxy.ts:157，中间件 `H` |
| 通配解析 | 取路径中 `/meta/` 之后全部片段为 action（meta/proxy.ts:44-49），例 `/api/v1/meta/asset/list → action='asset/list'` |
| 入参 | body 任意 JSON；解析失败当 `{}`（:171-176）；字段校验在内核侧，BFF 不校验 |
| 返回 | 透传内核信封 `{code,message,request_id,data}`，data 形状随 action（:212, :226） |
| 透传 | `deps.metaKernel.invoke(action, body, ctx)` → `POST /v3/meta/{action}`（fetch-meta-kernel-adapter.ts:103-108）；非 `META_LIST_ACTIONS` 的 action 剔除顶层 `limit`/`offset`（:111-116）；`auth/verify` 不带 user_key（:106） |
| 本地改写（非纯透传） | ① `agent/set-default-template`/`get-default-template` 完全本地：读写 `deps.config.agentTemplateDir`，非 system_admin → **403** `permission_denied`，缺 team_id/template → **400** `INVALID_PARAM`（:194-210）。② `user/list` 成功后剔除 `username='knowledge-service'` 并修正 total（:219-221, :32-42）。③ `team-member/add` 成功后异步克隆默认 Agent（best-effort，:215-217, :242-305）。④ 5 个 create 查询重名：`user/create`、`user/create-with-key`、`team/create`、`agent/create`、`task/create` 命中同名 → **409** 中文「已存在同名<实体>「x」，请更换名称后重试。」（:66-152, :188-191），查重自身异常放行 |
| 错误分支 | 空 action → **404** `UNKNOWN_META_ACTION`（:159-161）；`agent-fixed-asset/` 前缀 → **501** `NOT_IN_SCOPE`（:163-165）；不在白名单 → **404** `UNKNOWN_META_ACTION`（:167-169）；其余由内核信封透传 |

- action 白名单 = `META_ACTIONS` 61 条（api/meta-actions.ts:24-86），剔除 `NOT_IN_SCOPE_PREFIXES=['agent-fixed-asset/']`（:97）后 `ALLOWED_PANEL_ACTIONS` = **57 条**（:103-105）。
- 61 条：`user/{create,create-with-key,get,delete,list}`、`user-key/{create,list,get,revoke,update}`、`team/{create,get,update,delete,list}`、`team-member/{add,remove,list,get}`、`agent/{create,get,update,delete,list,archive}`、`agent-persona/{get,save}`、`agent/set-default-template`、`agent/get-default-template`、`task/{create,get,update,delete,list,archive}`、`task-agent/{link,unlink,list}`、`participation-log/{append,list}`、`asset/{create,get,update,delete,list,list-accessible,touch-usage}`、`agent-fixed-asset/{set,list,list-with-detail,summary-by-agents}`、`acl/{grant,revoke,list,check}`、`auth/verify`、`instance-quota/get`、`config/user/{get,set}`。
- `META_LIST_ACTIONS` 13 条（api/meta-actions.ts:7-22）：user/list、user-key/list、team/list、team-member/list、agent/list、task/list、task-agent/list、asset/list、asset/list-accessible、agent-fixed-asset/list、agent-fixed-asset/list-with-detail、acl/list、participation-log/list。

#### 2.2 `POST /api/v1/skill/*`

| 项 | 内容 |
|---|---|
| 注册 | skill/proxy.ts:27，中间件 `H` |
| 通配解析 | 取 `/skill/` 之后全部片段，含二级路径（`files/write` 等）（:13-18） |
| 入参 | body 任意 JSON，解析失败当 `{}`（:33-38）；分页走嵌套 `pagination` 原样透传 |
| 返回 | 透传内核信封与 data（:49-50） |
| 透传 | `deps.skillKernel.invoke(action, body, ctx)` → `POST /v3/skill/{action}`，user_key 始终透传（fetch-skill-kernel-adapter.ts:134-137） |
| 错误分支 | action 不在 `ALLOWED_SKILL_ACTIONS` → **404** `UNKNOWN_SKILL_ACTION`（:29-31）；其余透传 |

- action 白名单 = `SKILL_ACTIONS` **15 条**（api/skill-actions.ts:16-32）：create、update、patch、delete、get、list、search、versions、files/write、files/remove、files/read、listing、extract、export、conversation/add（注释写「14 条」，数组实际 15 项）。列表类 `SKILL_LIST_ACTIONS = list|search|versions`（:14）。

---

### 3. Chat Memory（28 条，全部 POST，均带 `H`）

公共事实：`readJson` 解析失败返 `{}`（chat-memory.ts:2834-2841）；`requiredTeamId`/`requiredBlockId` 只认 trim 后非空字符串（:2844-2852）；资产 id 由 `parseChatMemoryAssetId` 认 `chat_memory-` 前缀 + 末尾 `-agt`（:2814-2820）；caller userId 走 meta `auth/verify`（:2968-2990）；读权限 `authorizeChatMemoryRead` = owner 或（visibility=team 且是团队成员）或借入方（:3050-3087）；`isTeamMember` 走 meta `team-member/get`，异常 fail-closed（:3022-3040）。`MemoryBlockOut` 形状：`{id,title,summary,uploaded_by_user_id,updated_at_ms,layer_counts{L0_messages,L1,L2,L3},scope?,bound_agent_count?,agent_id?}`（:143-153）。

| 方法 + 路径 | 鉴权 | 入参（校验位置） | 返回 data | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /api/v1/chat-memory/team-assets`（:161） | H | `team_id` 必填（:167） | `{items: MemoryBlockOut[], total}` | 本地拼装：meta `asset/list`（visibility=team）分页全量 → isActive 过滤；不算 bound_agent_count（:184-188） | 400 `MISSING_TEAM_ID` |
| `POST /api/v1/chat-memory/agent-fixed`（:215） | H | `agent_id`（:222） | `{items,total}` | 本地：meta `agent/get` → `agent-fixed-asset/list-with-detail`（limit 100 循环）→ 逐条 `asset/get` 补 owner/updated_at | 400 `MISSING_AGENT_ID`；401 `INVALID_USER_KEY`(:225)；404 `AGENT_NOT_FOUND`(:234)；403 `NOT_YOUR_AGENT`(:239) |
| `POST /api/v1/chat-memory/my-agents`（:345） | H | `team_id`（:352） | `{items,total}` | 本地：meta `agent/list`（status=active）→ 按 `owner_user_id===me` 过滤 → 逐 agent `asset/get` 取 visibility | 400(:352)；401(:355) |
| `POST /api/v1/chat-memory/mine`（:414） | H | `team_id`（:418） | `{items,total}` | 本地：meta `asset/list`（owner_user_id=me） | 400(:418)；401(:422) |
| `POST /api/v1/chat-memory/create`（:463） | **H+U**（:466） | `team_id`(:471)、`title` trim 后 1..200(:474 `INVALID_TITLE`)、`scope`('private'|其它→team)、`description?` | `MemoryBlockOut` | 本地 + meta `asset/create`（asset_id 前缀 chat_memory，source_type=manual） | 400 `MISSING_TEAM_ID`/`INVALID_TITLE`；401(:3010) |
| `POST /api/v1/chat-memory/import`（:529） | H | `team_id`(:535)、`agent_id`(:536)、`messages[]` 非空(:538)、≤100(:542)、`session_id?`；全无效 → `NO_VALID_MESSAGES`(:565) | `{imported,block_id,session_id,accepted_count}` | **上游业务**：`POST /v3/conversation/add`（15s），user_id 取 agent.owner | 401(:570)；404(:577)；400 `AGENT_NOT_IN_TEAM`(:582)；403(:584) |
| `POST /api/v1/chat-memory/patch-scope`（:630） | **H+U**（:633） | `block_id`(:638)、`scope` 'private'|'team'(:645) | `{updated,id,scope}` | 本地：meta `asset/get` 预校验 → `asset/update` | 404(:654)；400 `NOT_CHAT_MEMORY`(:659) |
| `POST /api/v1/chat-memory/set-agent-fixed`（:687） | H | `agent_id`(:696)、`team_id`(:697)、`block_ids[]`；超限 `IMPORT_LIMIT_EXCEEDED`(:710) | `{updated,agent_id,block_ids}` | 本地：meta `agent/get` + 逐 id `asset/get` + `agent-fixed-asset/set` | 401(:714)；404(:722,:738)；400(:727,:743,:745)；403(:729,:747) |
| `POST /api/v1/chat-memory/allocate`（:817） | H | `block_id`(:826)、`agent_id`(:827)、`team_id`(:828)；借入满 `IMPORT_LIMIT_EXCEEDED`(:912) | `{allocated,agent_id,block_id}` | 本地：list→append→`agent-fixed-asset/set`；重复分配 **409** 中文「这条记忆已经分配给该 Agent，无需重复分配。」(:369-375) | 404(:837,:855)；400(:842,:845,:860)；401(:866)；403(:868,:871) |
| `POST /api/v1/chat-memory/unbind`（:950） | H | `block_id`(:956)、`agent_id`(:957)、`team_id`(:958)；解绑自身 → 400 `CANNOT_UNBIND_SELF_CHAT_MEMORY`(:963) | `{unbound,agent_id,block_id}` | 本地：`agent-fixed-asset/list-with-detail` → 过滤 → `agent-fixed-asset/set` | 400(:978,:996)；401(:968)；404(:976,:991,:1046)；403(:981) |
| `POST /api/v1/chat-memory/layer`（:1087） | **H+U**（:1090） | `block_id`(:1113)、`layer` L0|L1|L2|L3(:1115)、`limit` 1..200 默认 50、`offset`≥0、`before_ts?`、`time_start?`、`time_end?`、`path?`(L2)；区间过大 `RANGE_TOO_LARGE`(:1223,:1272) | `{layer,items[],total,limit,offset}` | **上游**：L0→`/v3/conversation/query`（跨 session）、L1→`/v3/atomic/query`、L2→`/v3/scenario/ls` 或 `/v3/scenario/read`、L3→`/v3/core/read` | 404(:1145)；400(:1150)；403(:1163)；500 `LAYER_FETCH_ERROR` |
| `POST /api/v1/chat-memory/health`（:1480） | H | 无 body | `{memory}` | **本地直连**：`GET {gatewayEndpoint}/health`，5s，头 `x-tdai-service-id` + `Authorization: Bearer <api_key>` | 401(:1483)；502 `NO_INSTANCE_ENDPOINT`(:1486)；502 `HEALTH_UPSTREAM_INVALID`(:1505)；504 `UPSTREAM_TIMEOUT` / 502 `UPSTREAM_ERROR` |
| `POST /api/v1/chat-memory/archive/list`（:1527） | H | `block_id`(:1534)、`limit` 1..500 默认 100、`offset` | 上游信封原样 | **透传**：`POST /v3/atomic/archive/list`（session_id 固定 'default'） | 401(:1550)；404(:1558)；400(:1563)；403(:1572) |
| `POST /api/v1/chat-memory/archive/restore`（:1601） | H | `block_id`(:1609)、`id`(:1610) | 原样 | **透传**：`POST /v3/atomic/archive/restore` | 400 `NOT_AGENT_MEMORY`(:1613)；401(:1616)；404(:1624)；400(:1629)；403(:1631) |
| `POST /api/v1/chat-memory/mood`（:1658） | H | `block_id`(:1665) | `{mood}`（缺省 `{tier:null,sampleCount:0}`） | **透传**：`POST /v3/memory/mood` | 400(:1668)；401(:1671)；404(:1679)；400(:1684)；403(:1692) |
| `POST /api/v1/chat-memory/identity/read`（:1721） | H | `block_id`(:1728)、`format?`（仅精确 'narrative' 才转发） | `{slots}` | **透传**：`POST /v3/core-memory/read` | 400(:1736)；401(:1739)；404(:1747)；400(:1752)；403(:1760) |
| `POST /api/v1/chat-memory/clear`（:1791） | **H+U**（:1794） | `memory_ids[]` 1..100（:1801,:1813,:1815） | 原样 | **透传**：`POST /v3/chat-memory/clear`（60s），整批前置校验后一次调用 | 404(:1830)；400(:1835)；403(:1838)；500 `CLEAR_FAILED` |
| `POST /api/v1/chat-memory/layer-delete`（:1870） | **H+U**（:1873） | `block_id`(:1881)、`layer` L0|L1(:1883)、`message_ids`≤5000、`session_ids`≤100、`ids`≤5000（:1928,:1931,:1952,:1953） | 原样 | **透传**：L0→`POST /v3/conversation/delete`、L1→`POST /v3/atomic/delete` | 400(:1888,:1904)；401；404(:1899)；403(:1906)；500 `LAYER_DELETE_FAILED` |
| `POST /api/v1/chat-memory/layer-update`（:1979） | H | `block_id`(:1993)、`layer` L1|L2|L3(:1995)、`id?`(L1/L2 必填,:2000)、`content`(:1997)、`summary?`(L2) | 原样 | **透传**：`/v3/atomic/update`、`/v3/scenario/write`（先 stripScenarioMeta）、`/v3/core/write` | 400(:2004,:2020)；401(:2007)；404(:2015)；403(:2022)；500 `LAYER_UPDATE_FAILED` |
| `POST /api/v1/chat-memory/importance`（:2081） | H | `block_id`(:2091)、`id`(:2092)、`importance` 整数 1..10(:2094)、`reason?` | 原样 | **透传**：`/v3/atomic/importance` | 400(:2099,:2115)；401(:2102)；404(:2110)；403(:2117)；500 `IMPORTANCE_UPDATE_FAILED` |
| `POST /api/v1/chat-memory/sensitivity`（:2166） | H | `block_id`(:2179)、`id`(:2180)、`sensitivity`(:2181,:2183)、`expect`(:2185,:2186)；白名单 `WRITABLE_SENSITIVITY={none,health,finance,relationship}` | 原样 | **透传**：`/v3/atomic/sensitivity`（上游 400/403/404/409/501/503 原样） | 400(:2190,:2206)；401(:2193)；404(:2201)；403(:2208)；500 `SENSITIVITY_UPDATE_FAILED` |
| `POST /api/v1/chat-memory/invalidate`（:2246） | H | `block_id`(:2263)、`id`(:2264)、`mode?` 'invalidate'|'restore'（:2265，非法 400 `INVALID_MODE`） | 原样 | **透传**：`/v3/atomic/invalidate`（record_id + mode） | 400(:2269,:2285)；401(:2272)；404(:2280)；403(:2287)；500 `INVALIDATE_UPDATE_FAILED` |
| `POST /api/v1/chat-memory/neighbors`（:2321） | H | `block_id`(:2326)、`id`(:2327)、`types?`、`maxHop`（默认 1，Math.min(3,x)）、`maxN`（默认 20） | `{id,neighbors}` | **透传**：`/v3/atomic/neighbors` | 400(:2343)；401(:2334)；404(:2338)；403(:2346)；500 `NEIGHBORS_FAILED`(:2369) |
| `POST /api/v1/chat-memory/path`（:2382） | H | `block_id`(:2388)、`startId`(:2389)、`endId`(:2390)、`maxHop` 夹取 [1,3]、`types?` | `{startId,endId,path|null}` | **透传**：`/v3/atomic/path` | 400(:2409)；401(:2400)；404(:2404)；403(:2412)；500 `PATH_FAILED`(:2444) |
| `POST /api/v1/chat-memory/evidence-by-ids`（:2460） | H | `block_id`(:2467)、`ids` 1..100(:2468) | `{items}` | **透传**：`/v3/atomic/by-ids` | 400(:2479)；401(:2473)；404(:2476)；403(:2481)；502 `KERNEL_UNAVAILABLE`(:2500) |
| `POST /api/v1/chat-memory/source-messages`（:2513） | H | `block_id`(:2520)、`ids` 1..100(:2521) | `{items}` | **透传**：`/v3/conversation/by-ids` | 同上；502(:2553) |
| `POST /api/v1/chat-memory/search`（:2557） | H | `block_id`(:2573)、`query` 必填(:2574)、`layer?`（'L0'→L0，其余一律 L1）、`limit` 1..100 默认 30、`type?` | `{items,total}`（item 带 score 与灵魂字段透传） | **透传**：L0→`/v3/conversation/search`、L1→`/v3/atomic/search` | 400(:2595)；401(:2582)；404(:2590)；403(:2604)；500 `SEARCH_FAILED` |
| `POST /api/v1/chat-memory/recall-journal`（:2721） | H | `team_id`+`agent_id`（缺 → 400 `MISSING_TENANT`, :2729）、`page` 默认 1、`page_size` 1..100 默认 20、`filter` all|recall|skipped | `{items,total,page,page_size,has_more,filter,counts{all,recall,skipped}}` | **本地读文件**：`{dir}/recall-journal-<team>-<agent>.jsonl` + `.1..5` 分片；dir = `TDAI_RECALL_JOURNAL_DIR` > `TDAI_DATA_DIR/logs/recall`（:63-73），按 ts 倒序、先过滤再切片 | 401(:2732)；503 `RECALL_JOURNAL_DIR_UNRESOLVED`（`err.message`） |

---

### 4. Soul 与人物档案（7 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 data | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /api/v1/chat-memory/soul-versions`（:461） | H+T（:473） | `team_id`(:468)、`agent_id?`、`snapshotLimit` 夹取 1..200 | `{teamId,agentId,userId,soulVersion?,rendered?(≤4000 截断),renderedTruncated,versions[{at,hash,trigger,version?,parentHash?,reasonCode?,reasonDetail?,lineDiff?,slotDiff?}],notes[]}` | **上游**：`POST /v3/soul/introspect`（`snapshotsEnabled=false` 零写入，15s）；`payload_json` 永不出（narrowSnapshot :107-146） | 400 `MISSING_TEAM_ID`；401 `INVALID_USER_KEY`；403 `NOT_TEAM_MEMBER`；502 `UPSTREAM_ERROR`；504 `UPSTREAM_TIMEOUT` |
| `GET /api/v1/chat-memory/soul-card`（:552） | H | query `team`、`user`、`agent`（空/缺省 → 'default'，tenantAxis :130-133） | 卡文本原样（`env.data`） | **上游**：`GET /v3/soul/card`（`persist:false` 纯读，15s，信封） | 502(:575)/504；401/403 原码透出；503 `soul_card_unavailable`/`soul_card_failed` 保留 message |
| `GET /api/v1/chat-memory/soul-trait-state`（:621） | H | query `team`、`user`、`agent` | `{agentId,updatedAt,traits[{label,seedWeight,nowWeight,drifted}]}`；缺字段行整行丢弃（:248-261） | **上游裸对象**：`GET /v3/soul/trait-state`（`kernelHttp.getRaw`，15s） | 504(:642)；502(:643) |
| `GET /api/v1/soul/injection-stats`（:706） | H | query `team` 必填(:713)、`user`、`agent`、`hours` 1..8760（非法 400 `BAD_HOURS`, :729） | `{window{hours,from,to},rows,lastAt,lastCard,lastVolatile,failReasons,serverRenderOnly,pairs{matched,charMismatch},volatileCounts?,note?}`；算不出回 null 不补 0（:357-416） | **上游**：`GET /v3/soul/injection/stats`（信封 15s） | 504/502(:503-511)；`env.code!==0` 原码透出；rows 非数字 → 503 `soul_injection_stats_failed`(:524) |
| `GET /api/v1/soul/emotions`（:780） | H | query `team` 必填(:787)、`limit` 1..200（非法 400 `BAD_LIMIT`, :803）、`since`（ISO 原样透传） | `{rows[{at,object,objectPerson,label,valence,arousal,dominance,intensity,decayedIntensity,agency,confidence,templateVersion}],funnel|null}`（六档 `emotion:candidate→committed` 全给才算，:424-459） | **上游**：`GET /v3/soul/emotions`（信封 15s） | 504/502；rows 非数组 → 503 `soul_emotions_failed`(:600) |
| `GET /api/v1/soul/persons`（:291） | H | query `team` 必填(:294)、`user?`、`agent?` | `{persons[{key,displayName,aliases,platform,platformId,fieldCount,relationCount,updatedAt}],edges[{relId,subjKey,subjName,pred,objKey,objName,direction:'out'|'mutual',quote,recordId,validFrom}]}`；缺 displayName 给占位「未命名·<key 尾 5 位>」（:146,:162-165） | **上游裸对象**：`GET /v3/soul/persons`（`getRaw`，15s，`{ok,data}`） | 400 `MISSING_TEAM_ID`；504(:312)/502(:313)；非 2xx 原码+上游 message（:257-271）；persons 非数组 → 503 `soul_persons_failed`(:323) |
| `GET /api/v1/soul/person`（:339） | H | query `team` 必填(:342)、`key` 必填(:344，形状交 Core 判) | `{person{key,displayName,aliases},fields[{field,label,text,evidence[{recordId,at,quote}],updatedAt,stale}],relations[{relId,pred,objKey,objName,direction:'out'|'in'|'mutual',counterpartKey,quote,recordId,validFrom}]}` | **上游裸对象**：`GET /v3/soul/person` | 400 `person_key_required`；504/502；person.key/displayName 缺 → 503 `soul_person_failed`(:376) |

---

### 5. Agent Overview（1 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 data | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /api/v1/agent-overview/bootstrap`（:159） | H+T（:164） | `team_id` 必填(:163)、`agent_ids?` 数组(:167) | `{assets{skills[],codeGraphs[],wikis[],chatMemories[]}（元素 = toMountable {key,title,group,slug,status}）,counts{agentId:{skills,code_graph,llm_wiki,chat_memory}}}`（:336-367） | **本地拼装**：`Promise.allSettled` 六路——meta `asset/list-accessible` ×4（skill/code_graph/llm_wiki 限 visibility=team；chat_memory 不限）、meta `agent/list`、skillKernel `list`（`filters.status=['active']`，pagination 1000）；counts 走 meta `agent-fixed-asset/summary-by-agents`（:110-154, :303-322） | 401/403（requireTeamMember）；单路失败降级为空数组/零值不报错（:293-302, :311-321） |

---

### 6. Knowledge（34 条）

公共门控：`requireKnowledgeRead`（meta asset/get + `acl/check`，knowledge/common.ts:338-374）；KS 调用失败由 `runKs` 映射——`DomainError → respondControlError(err.httpStatus, err.message||err.code)`，其它 → 502 `UPSTREAM_ERROR`（common.ts:128-141）。KS 上游 baseUrl 不含 `/v3`、路径自带 `/v3` 前缀（http-knowledge-client.ts:1-9）；上游信封 `code!==0` 抛 `CoreUpstreamError(httpStatus = resp.status>=400?resp.status:502)`（:70-77）。

#### 6.1 Wiki（18 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /knowledge/wiki/list`（:37） | H+T | `team_id` 必填；可选 `status`/`limit`/`offset` | KS 列表 | 本地门控 + `POST /v3/wiki/list`；路由标 `@deprecated`（UI 改用 team-assets） | 400 `MISSING_TEAM_ID`；401/403 |
| `POST /knowledge/wiki/create`（:54） | H+T | `team_id`、`name` 必填；`source_type`/`source_url`/`branch`/`path_include`/`path_exclude` 可选 | KS detail | `POST /v3/wiki/create` → `ensureKnowledgeAsset`（asset_id=wiki_id）；`source_type==='git'` 时 fire-and-forget `/v3/wiki/sync`（:98-104） | 400 `MISSING_TEAM_ID`/`MISSING_NAME`；401/403；reg 失败透传其信封 |
| `POST /knowledge/wiki/ingest`（:109） | H+K(write) | `wiki_id` 必填 | KS 结果 | 先 `/v3/wiki/raw/ls` 判空，空 → 400 `WIKI_EMPTY_NO_SOURCES`（raw/ls 失败不阻塞，:118-126）→ `/v3/wiki/ingest` | 400 `MISSING_WIKI_ID`；401/403/404 |
| `POST /knowledge/wiki/sync`（:130） | H+K(write) | `wiki_id` | KS 结果 | `POST /v3/wiki/sync`（非 git 源由 KS 返 400） | 400；401/403/404 |
| `POST /knowledge/wiki/source/update`（:147） | H+K(write) | `wiki_id`；patch 收集 `source_url`/`branch`/`path_include`/`path_exclude`/`enabled`，全空 → 400 `MISSING_SOURCE_FIELDS` | KS detail | `PATCH /v3/wiki/{id}/source`（http-knowledge-client.ts:128-130） | 400；401/403 |
| `POST /knowledge/wiki/source/test`（:172） | H+K(read) | `wiki_id`；`source_url?` | KS 探测结果 | `POST /v3/wiki/{id}/test` | 400；401/403 |
| `POST /knowledge/wiki/source/refetch`（:185） | H+K(write) | `wiki_id` | KS 结果 | `POST /v3/wiki/{id}/refetch`（KS 202 异步；busy **409** 由信封 code 映射，client:137-140） | 400；409；401/403 |
| `POST /knowledge/wiki/get`（:197） | H+K(read) | `wiki_id` | `detail` + `progress`（`status==='processing'` 读 `ingestProgressStore`，否则 null，:205-214） | `/v3/wiki/get` + 本地进度 | 400；401/403/404 |
| `POST /knowledge/wiki/delete`（:218） | H+K(write)×N | `wiki_ids[]` 非空 | KS 结果 | `/v3/wiki/delete` + `deleteKnowledgeCascade`（先 `/v3/knowledge/delete`，再 meta `asset/delete`，common.ts:201-237） | 400 `MISSING_WIKI_ID`；401/403 |
| `POST /knowledge/wiki/graph`（:236） | H+K(read) | `wiki_id` | 图数据 | `/v3/wiki/graph` | 400；401/403 |
| `POST /knowledge/wiki/page/ls`（:248） | H+K(read) | `wiki_id` | `{items}` | `/v3/wiki/page/ls` | 400；401/403 |
| `POST /knowledge/wiki/page/read`（:260） | H+K(read) | `wiki_id`、`refs[]` 非空（否则 400 `MISSING_REFS`） | `{items}` | `/v3/wiki/page/read` | 400；401/403 |
| `POST /knowledge/wiki/page/rm`（:274） | H+K(write) | `wiki_id`、`refs[]`；team_id 取 `gate.asset.team_id`，缺 → 400 `MISSING_TEAM_ID` | KS 结果 | `/v3/wiki/page/rm` | 400；401/403 |
| `POST /knowledge/wiki/search`（:290） | H+K(read) | `wiki_id`、`query` 必填；`limit?` | KS 搜索结果 | `/v3/wiki/search`（limit 默认 20，client:184-186） | 400 `MISSING_WIKI_ID`/`MISSING_QUERY`；401/403 |
| `POST /knowledge/wiki/raw/ls`（:305） | H+K(read) | `wiki_id` | `{items}` | `/v3/wiki/raw/ls` | 400；401/403 |
| `POST /knowledge/wiki/raw/read`（:317） | H+K(read) | `wiki_id`、`filenames[]` 非空（否则 400 `MISSING_FILENAMES`） | `{items}` | `/v3/wiki/raw/read` | 400；401/403 |
| `POST /knowledge/wiki/raw/rm`（:331） | H+K(write) | `wiki_id`、`filenames[]`；`gate.asset.team_id` 缺 → 400 `MISSING_TEAM_ID` | KS 结果 | `/v3/wiki/raw/rm` | 400；401/403 |
| `POST /knowledge/wiki/raw/write`（:351） | H+T | `team_id`+`wiki_id` 必填、`files[]` 非空；上限 `MAX_FILE_SIZE=512*1024`、`MAX_FILES_PER_REQUEST=10`、`MAX_TOTAL_SIZE=5*1024*1024`（:347-373） | KS 结果 | `/v3/wiki/raw/write` | 400 `MISSING_TEAM_ID`/`MISSING_WIKI_ID`/`MISSING_FILES`；**413** `TOO_MANY_FILES`/`FILE_TOO_LARGE`/`TOTAL_TOO_LARGE`；401/403 |

#### 6.2 Code-Graph（8 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /knowledge/code-graph/list`（:31） | H+T | `team_id` 必填；可选 `status`/`limit`/`offset` | KS 列表 | `/v3/code-graph/list`（`@deprecated`） | 400 `MISSING_TEAM_ID`；401/403 |
| `POST /knowledge/code-graph/create`（:48） | H+T | `team_id`、`repo_url` 必填；`branch`/`repo_name` 可选 | KS detail | `/v3/code-graph/create` + 记 `knowledgeTaskRegistry`（owner_user_key 供 S2S 注册） | 400 `MISSING_TEAM_ID`/`MISSING_REPO_URL`；401/403 |
| `POST /knowledge/code-graph/register-meta`（:89） | H+T + H+K(allowInFlightCodeOwner) | `team_id`、`code_graph_id` 必填 | `{registered:true,code_graph_id}` | `/v3/code-graph/get` → `ensureKnowledgeAsset` | 400；**409** `CODE_GRAPH_NOT_READY`；403 `NOT_RESOURCE_OWNER`；401/403/404 |
| `POST /knowledge/code-graph/get`（:135） | H+K(allowInFlightCodeOwner) | `code_graph_id` | KS detail | `/v3/code-graph/get` | 400；401/403/404 |
| `POST /knowledge/code-graph/sync`（:147） | H+K(write) | `code_graph_id` | KS 结果 | `/v3/code-graph/sync` | 400；401/403/404 |
| `POST /knowledge/code-graph/delete`（:159） | H+K(write)×N | `code_graph_ids[]` 非空 | KS 结果 | `/v3/code-graph/delete` + `deleteKnowledgeCascade` | 400 `MISSING_CODE_GRAPH_ID`；401/403 |
| `POST /knowledge/code-graph/search`（:180） | H+K(read) | `code_graph_id`、`query` 必填；`kind`/`limit` 可选 | KS `{text,isError}` 文本块 | `POST /v3/code-graph/search`（client:224-226） | 400 `MISSING_CODE_GRAPH_ID`/`MISSING_QUERY`；401/403 |
| `POST /knowledge/code-graph/explore`（:197） | H+K(read) | 同上 + `maxFiles?` | KS 文本块 | `POST /v3/code-graph/explore` | 同上 |

#### 6.3 回调（1 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /api/v1/knowledge/status-callback`（:117） | **—（无任何中间件，S2S）** | 两种分支：① `ingest_progress`：`wiki_id` + `progress{phase∈extracting|merging|indexing,total,completed,failed,skipped,percent}` 全为 number（:124-138）；② 终态：`knowledge_id`、`type`、`status`、可选 `service_id`（:153-158）；body 解析失败当 `{}`（:47-55） | **恒 200** `{code:0,message:'ok',request_id:'',data:null}`（:254） | **本地**：① 写 `deps.ingestProgressStore.update(wikiId, …)`（:139-150）；② `status==='ready'` 时 `instanceRegistry.resolve(service_id)` → `kc.wikiGet`/`kc.codeGraphGet` → `POST /v3/knowledge/create`（wiki 带 `service_url`/`name`/`summary`；code-graph 带 `repo_url`/`branch`）+ code-graph 额外 `ensureKnowledgeAsset`（用内存 `knowledgeTaskRegistry` 里 stash 的 owner 身份，无 stash 则跳过，:214-244） | 字段不全 → 400（中文 message，:124-138 / :153-158）；无 `service_id` → log error 后**静默 200 跳过**（:179-183）；`status==='failed'` 不写明细/meta（:248-249）；`service_url` 为 null 跳过明细同步（:195-196,:220-221） |

#### 6.4 分配 / 绑定 / 可见性 / 授权（5 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 data | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /knowledge/allocate`（:54） | H+T | `knowledge_id`、`agent_id`、`team_id`（:57-62） | `{allocated:true,agent_id,knowledge_id}` | 本地：meta `asset/get` + `agent/get` + `agent-fixed-asset/list` 全量 → `agent-fixed-asset/set` 全量替换（新项 `injection_mode:'tool', priority:50`，:108-120） | 400 `MISSING_*`/`NOT_KNOWLEDGE_ASSET`/`TEAM_MISMATCH`/`AGENT_NOT_IN_TEAM`；401；403 `NOT_TEAM_MEMBER`；404 `KNOWLEDGE_NOT_FOUND`/`AGENT_NOT_FOUND`；**409** `ALREADY_ALLOCATED`(:104-106) |
| `POST /knowledge/unbind`（:124） | H | `knowledge_id`、`agent_id`（:127-138） | `{unbound:true,agent_id,knowledge_id}` | 本地：全量 list → 过滤 → `agent-fixed-asset/set` | 400；401；403 `NOT_YOUR_AGENT`；404 `AGENT_NOT_FOUND`/`BINDING_NOT_FOUND`(:153-154) |
| `POST /knowledge/agent-fixed`（:175） | H（owner 或团队成员，:179-194） | `agent_id` | `{items[{knowledge_id,asset_type,name,description,status,visibility,agent_id}],total}` | 本地：meta `agent-fixed-asset/list-with-detail` 全量分页；非 owner 时 `apply_visibility_filter=true` 且只留 `visibility==='team'`（:195,:224-226）；过滤 knowledge 类型与非 archived/deprecated/failed | 400 `MISSING_AGENT_ID`；401；403 `NOT_TEAM_MEMBER`；404 `AGENT_NOT_FOUND` |
| `POST /knowledge/set-visibility`（:241） | H | `knowledge_id`；`visibility` ∈ `VALID_VISIBILITY=['private','team','restricted','agent','task']`（:47-48, :244-249） | 透传 meta 信封 | **透传**：meta `asset/update` {asset_id,visibility}（:250-251） | 400 `MISSING_KNOWLEDGE_ID`/`INVALID_VISIBILITY`；401/404 |
| `POST /knowledge/grant`（:255） | H | `knowledge_id`、`subject_type`、`subject_id`、`permission` 全必填（:258-265） | 透传 meta 信封 | **透传**：meta `acl/grant`（:266-271） | 400 `MISSING_KNOWLEDGE_ID`/`MISSING_GRANT_FIELDS`；401 |

#### 6.5 团队资产（2 条，同一段代码循环注册）

| 方法 + 路径 | 鉴权 | 入参 | 返回 data | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /knowledge/wiki/team-assets` | H+T | `team_id` 必填(:36-37) | `{items,total}`（item 见 `KnowledgeAssetListItem`，common.ts:376-407） | 本地：meta `asset/list-accessible`（action=read, visibility=team）全量 → isActive 过滤 → `joinKnowledgeAssetsWithKs`（KS 失败标 `status='missing'`、`ks_missing=true`）→ `mergeWithKsOnlyItems` 补 KS 独有项（`meta_status:'unregistered'`）（list-routes.ts:33 路由体，:62-63 注册） | 400 `MISSING_TEAM_ID`；401 `INVALID_USER_KEY`；403 `NOT_TEAM_MEMBER` |
| `POST /knowledge/code-graph/team-assets` | H+T | 同上 | 同上（asset_type=`code_graph`） | 同上 | 同上 |

---

### 7. Settings（3 条）

| 方法 + 路径 | 鉴权 | 入参 | 返回 | 实现/上游 | 错误分支 |
|---|---|---|---|---|---|
| `POST /api/v1/settings/knowledge/:action`（:96） | H | `:action` ∈ `get|set|revectorize`（:24）；body JSON 原样转 | 上游 body 原样（非 2xx 原样转发上游 status/body，:26-60） | **本地代理**：`{knowledge.baseUrl}/v3/admin/settings/{action}`，头 `x-tdai-service-id` + `Authorization: Bearer <authToken>`（:74-84） | 400 `INVALID_ACTION`；**403** `FORBIDDEN`（非 system_admin，:69-72）；504 `UPSTREAM_TIMEOUT` / 502 `UPSTREAM_ERROR` |
| `POST /api/v1/settings/memory/:action`（:97） | H | 同上；`memory`+`revectorize` → 400 `NOT_SUPPORTED`（:65-68） | 上游 body 原样 | 同上，上游 = `{gatewayEndpoint}/v3/admin/settings/{action}` | 400；403；**502** `NO_INSTANCE_ENDPOINT`（gatewayEndpoint 空，:86-93）；504/502 |
| `POST /api/v1/rerank-model/:action`（:103） | H | `:action` ∈ `status|download`（:105） | 上游 body 原样 | 上游 = `{gatewayEndpoint}/v3/admin/rerank-model/{action}`（:115） | 400 `INVALID_ACTION`；403 `FORBIDDEN`（:107）；502 `NO_INSTANCE_ENDPOINT`（:109）；504/502 |

---

### 8. 错误码 → HTTP 状态总表

| HTTP | 触发条件 | 代表 code | 定位 |
|---|---|---|---|
| 200 | `code:0`；以及 `/health`、`/meta/instances` 的裸对象 | `ok` | kernel/envelope.ts:13 |
| 400 | 缺参/非法枚举/**缺 header** | `MISSING_*`、`INVALID_*`、`MISSING_INSTANCE_ID`、`MISSING_USER_KEY`、`BAD_HOURS`、`BAD_LIMIT` | validate-panel-headers.ts:36,:44,:52；各路由 |
| 401 | header 有 user-key 但内核证不出人 | `INVALID_USER_KEY` | chat-memory.ts:3010；common.ts:102 |
| 403 | 非团队成员 / 非资产 owner / 非 system_admin | `NOT_TEAM_MEMBER`、`NOT_YOUR_AGENT`、`NOT_ASSET_OWNER`、`ASSET_NOT_SHARED`、`FORBIDDEN`、`permission_denied` | common.ts:106；chat-memory.ts:239,:1631,:1838；meta/proxy.ts:197 |
| 404 | 资产/Agent/绑定不存在；未知 action | `BLOCK_NOT_FOUND`、`AGENT_NOT_FOUND`、`BINDING_NOT_FOUND`、`KNOWLEDGE_NOT_FOUND`、`UNKNOWN_META_ACTION`、`UNKNOWN_SKILL_ACTION` | meta/proxy.ts:159,:167；skill/proxy.ts:30 |
| 409 | 重复分配 / 重名 / KS busy | `ALREADY_ALLOCATED`、`CODE_GRAPH_NOT_READY`、重名中文 message | allocate-routes.ts:104-106；code-graph-routes.ts:89+；meta/proxy.ts:188-191 |
| 413 | wiki raw 写入超限 | `TOO_MANY_FILES`/`FILE_TOO_LARGE`/`TOTAL_TOO_LARGE` | wiki-routes.ts:347-373 |
| 429 | 限速 | `RATE_LIMITED` + Retry-After | rate-limit.ts:124-127,:133-136 |
| 500 | 本地未捕获异常；部分写/读失败 | `INTERNAL`、`LAYER_FETCH_ERROR`、`CLEAR_FAILED`、`NEIGHBORS_FAILED`、`PATH_FAILED` | app.ts:56-65；chat-memory.ts:2369,:2444 |
| 501 | 面板显式排除的内核 action | `NOT_IN_SCOPE` | meta/proxy.ts:163-165 |
| 502 | 上游不可达 / 上游信封 code 非 400-599 / 缺 gatewayEndpoint | `UPSTREAM_ERROR`、`KERNEL_UNAVAILABLE`、`NO_INSTANCE_ENDPOINT` | kernel/envelope.ts:14；fetch-kernel-http-adapter.ts:15-27 |
| 503 | 上游形态异常（不伪造空数据）/ 本地目录未配置 | `soul_*_failed`、`RECALL_JOURNAL_DIR_UNRESOLVED` | soul-persons.ts:323,:376；chat-memory.ts:2797 |
| 504 | 上游超时 | `UPSTREAM_TIMEOUT` | fetch-kernel-http-adapter.ts:15-27 |

### 9. 未采集 / 未验证

1. 服务端口 8123 —— 未读启动入口文件。
2. `instanceRegistry.listPublic()` 返回字段集（meta/instances.ts:10 只见调用）。
3. `middleware/request-logger.ts` 的 reqId 生成规则与日志字段。
4. `/api/*` 未匹配路径的 404 响应体（Hono 默认，未打接口验证）。
5. 各 action 在**内核侧**的 body 字段校验细则（BFF 对 `/meta/*`、`/skill/*` 的 body 不做任何字段校验）。
6. 内核列表接口的分页默认值（BFF 侧自身用 `META_LIST_PAGE=100`，common.ts:241）。

### 10. 按用途分组的索引

**探活 / 实例**
- `GET /health`、`GET /api/v1/meta/instances` —— 均无信封、无鉴权。

**通用透传**
- `POST /api/v1/meta/*` —— 57 个 action（user / user-key / team / team-member / agent / agent-persona / task / task-agent / participation-log / asset / acl / auth / instance-quota / config）；其中 `agent/set-default-template`、`user/list`、`team-member/add` 有本地改写。
- `POST /api/v1/skill/*` —— 15 个 action：技能 CRUD、search、versions、files/*、listing、extract、export、conversation/add。

**Chat Memory**
- 团队/我的资产：`team-assets`、`mine`、`my-agents`、`agent-fixed`。
- 记忆块：`create`、`import`、`patch-scope`、`set-agent-fixed`、`allocate`、`unbind`。
- 分层浏览与编辑：`layer`、`layer-update`、`layer-delete`、`search`、`archive/list`、`archive/restore`、`clear`。
- 单条元数据：`importance`、`sensitivity`、`invalidate`、`mood`、`identity/read`。
- 图谱：`neighbors`、`path`、`evidence-by-ids`、`source-messages`。
- 运维：`health`、`recall-journal`。

**Soul**
- `chat-memory/soul-versions`、`chat-memory/soul-card`、`chat-memory/soul-trait-state`、`soul/injection-stats`、`soul/emotions`。

**人物档案**
- `soul/persons`（列表+关系边）、`soul/person`（单人九字段+关系）。

**Agent 编辑页**
- `agent-overview/bootstrap` —— 可挂载资产 + 各 agent 挂载计数。

**Knowledge**
- 资产 CRUD：`wiki/{list,create,get,delete}`、`code-graph/{list,create,get,delete,register-meta}`。
- 摄取同步：`wiki/ingest`、`wiki/sync`、`wiki/source/{update,test,refetch}`、`code-graph/sync`。
- 读内容：`wiki/graph`、`wiki/page/{ls,read,rm}`、`wiki/search`、`wiki/raw/{ls,read,rm,write}`、`code-graph/{search,explore}`。
- 团队资产列表：`knowledge/{wiki,code-graph}/team-assets`。
- 分配授权：`knowledge/allocate`、`unbind`、`agent-fixed`、`set-visibility`、`grant`。
- 服务端回调：`knowledge/status-callback`（唯一无鉴权写入面）。

**管理员设置**
- `settings/knowledge/:action`、`settings/memory/:action`、`rerank-model/:action`（均要求 system_admin）。

## 二、前端调用面与交互设计

取证时间：2026-11-10 23:3x（Asia/Shanghai）
仓库：D:\TDB\td-agemem，根目录 `MemoryPanel/web/src`
方法：逐文件读源码；每条结论带 path:line。未读到的写「未采集」。本轮未改任何源码、未 commit。

---

### 0. 基础设施（所有模块共用）

| 能力 | 位置 | 说明 |
|---|---|---|
| `request<T>(method, path, body?, extraHeaders?)` | MemoryPanel/web/src/lib/api/base.ts:96 | 唯一 fetch 封装；body 存在才加 content-type: application/json；401 广播 `auth:unauthorized` 并抛 ApiError（base.ts:109-112）；204 返回 undefined（base.ts:118） |
| `ApiError` | lib/api/base.ts:28 | 带 `status/statusText/body/code/requestId/rawMessage/data`；`data` 用于 409 conflict 分流（base.ts:32-33） |
| `META_PREFIX = '/api/v1/meta'`、`META_PAGE_SIZE = 100` | lib/api/base.ts:124-125 | meta 全部动作走 `POST /api/v1/meta/{action}` |
| `metaCall<T>(action, body, headers)` | lib/api/base.ts:148 | 解析 `{code,message,request_id,data}`；code!==0 或 data 为 null 都抛错（base.ts:159-172） |
| `metaPost<T>(action, body)` | lib/api/base.ts:176 | 从 panelSession 注入 `X-Tdai-Service-Id` + `X-Tdai-User-Key`（base.ts:181-184） |
| `metaListAll<T>(action, body)` | lib/api/base.ts:196 | limit 恒 100、offset 按 limit 步进（不按 items.length）；注释解释过滤型接口会重复/漏数据（base.ts:186-195） |
| `dedupeInFlight<T>(key, factory)` | lib/api/base.ts:234 | 仅只读接口去重；写操作禁用（base.ts:230-231） |
| `PANEL_CAPABILITIES.assets = false` | lib/api/base.ts:22-24 | 通用资产 UI 能力开关关；调用方不得发起注定 501 的请求 |
| 会话缓存 | lib/panelSession.ts:18-58 | localStorage key `tdai-panel.session`（panelSession.ts:29），存 `instanceId/instanceName/userKey/user`；登出=删本地（panelSession.ts:52-58） |
| 401 事件 | lib/api/base.ts:61-72 `onUnauthorized` | App 层兜底回登录页 |
| 鉴权口径 | lib/api/base.ts:4-11 | 无 Cookie、无状态；auth/verify 只传 Service-Id，user_key 只放 body |

`PublicUser`（lib/api/types.ts:27-43）：`user_id, auth_provider, external_id, username, display_name?, email?, status('active'|'inactive'|'invited'), created_at, updated_at, user_type?('system_admin'|'user'|string)`；注释明确 `user_type==='system_admin'` 是 admin 唯一权威字段（types.ts:37-42）。

---

### 1. 前端调用面

#### 1.1 meta / agents / teams / users / api-keys

##### 登录与实例（选择实例 + 验活）

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `metaInstancesApi.list()` | lib/api/meta-instances.ts:22 | GET | /api/v1/meta/instances | 无（公开、无鉴权、无分页） | `{instances: MetadataInstance[]}` → 取 `.instances` |
| `authVerifyApi.verify(instanceId, userKey)` | lib/api/auth.ts:16 | POST | /api/v1/meta/auth/verify | body `{user_key}`；Header 只有 X-Tdai-Service-Id（auth.ts:17-21） | `{valid: boolean; user?: PublicUser}` |
| `environmentBindingsApi.list()` | lib/api/auth.ts:47 | GET | /api/v1/users/me/environment-bindings | 无 | `EnvironmentBinding[]` |
| `environmentBindingsApi.create(data)` | lib/api/auth.ts:50 | POST | /api/v1/users/me/environment-bindings | `{environment: string; environment_user_id: string}` | `EnvironmentBinding` |
| `environmentBindingsApi.remove(id)` | lib/api/auth.ts:54 | DELETE | /api/v1/users/me/environment-bindings/{id} | path id | `{ok: boolean}` |

`MetadataInstance`（meta-instances.ts:14-18）：`instance_id, name, gateway_endpoint`。
`EnvironmentBinding`（auth.ts:36-43）：`id, user_id, environment, environment_user_id, created_at, updated_at`。
警示：auth.ts:26-27 注释「当前部署未注册 /api/v1/users/* 路由，以下接口可能 404」。

##### Team / Member

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `teamsApi.list()` | lib/api/teams.ts:13 | POST | /api/v1/meta/team/list | `{user_id}`（来自 getCurrentUser；注释：身份只放 header 不够，teams.ts:9-11） | `Team[]`（metaListAll 翻页） |
| `teamsApi.get(teamId)` | lib/api/teams.ts:19 | POST | /api/v1/meta/team/get | `{team_id}` | `Team` |
| `teamsApi.create(data)` | lib/api/teams.ts:22 | POST | /api/v1/meta/team/create | `{name, description?, owner_user_id}` | `Team` |
| `teamsApi.update(teamId, data)` | lib/api/teams.ts:32 | POST | /api/v1/meta/team/update | `{team_id, name?, description?}` | `Team` |
| `teamsApi.delete(teamId)` | lib/api/teams.ts:41 | POST | /api/v1/meta/team/delete | `{team_ids: [teamId]}`（必须复数数组，复数缺失会 400，teams.ts:35-40） | `{ok: boolean}` |
| `membersApi.list(teamId)` | lib/api/teams.ts:46 | POST | /api/v1/meta/team-member/list | `{team_id}` | `TeamMember[]` |
| `membersApi.add(teamId, data)` | lib/api/teams.ts:57 | POST | /api/v1/meta/team-member/add | `{team_id, user_id, role: 'admin'|'member'|'reviewer'}` | `TeamMember` |
| `membersApi.remove(teamId, userId)` | lib/api/teams.ts:65 | POST | /api/v1/meta/team-member/remove | `{team_id, user_id}` | void |

`Team`（lib/api/types.ts:45-54）：`team_id, name, description?, owner_user_id, status('active'|'archived'), created_at, updated_at, metadata_json`。
`TeamMember`（types.ts:56-65）：`id, team_id, user_id, role, joined_at, status('active'|'removed'), username?`。

##### Agent + 固定资产 + 默认模板

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `agentsApi.list(teamId, params?)` | lib/api/agents.ts:44 | POST | /api/v1/meta/agent/list | `{team_id, status:'active', owner_user_id?}` | `Agent[]` |
| `agentsApi.get(agentId)` | lib/api/agents.ts:52 | POST | /api/v1/meta/agent/get | `{agent_id}` | `Agent` |
| `agentsApi.create(teamId, data)` | lib/api/agents.ts:55 | POST | /api/v1/meta/agent/create | `{team_id, owner_user_id, name, description?, visibility?('team' 缺省)}` | `Agent` |
| `agentsApi.update(agentId, data)` | lib/api/agents.ts:75 | POST | /api/v1/meta/agent/update | `{agent_id, name?, description?, visibility?, status?, metadata_json?}` | `Agent` |
| `agentsApi.delete(agentId, teamId?)` | lib/api/agents.ts:97 | POST | /api/v1/meta/agent/archive（前置逐个 skill/delete） | `{agent_id}` | void；先 `skillApi.listByAgent` 再逐个 `skillApi.delete(...,version)`，任一失败抛 `SKILL_DELETE_FAILED agent_id=… deleted=… failed=…`（agents.ts:108-115） |
| `agentsApi.getAssets(agentId, applyVisibilityFilter=true)` | lib/api/agents.ts:130 | POST | /api/v1/meta/agent-fixed-asset/list-with-detail | `{agent_id, apply_visibility_filter, touch_usage:false}` | `AgentAssetView[]`（缺 injection_mode 补 'direct'，agents.ts:153） |
| `agentsApi.getFixedAssets(agentId)` | lib/api/agents.ts:160 | POST | /api/v1/meta/agent-fixed-asset/list | `{agent_id}` | `FixedAssetBinding[]` |
| `agentsApi.setFixedAssets(agentId, bindings)` | lib/api/agents.ts:176 | POST | /api/v1/meta/agent-fixed-asset/set | `{agent_id, bindings:[{asset_id,asset_type,injection_mode='direct',priority=0,created_by}]}` | `{ok}` |
| `agentsApi.getDefaultTemplate(teamId)` | lib/api/agents.ts:194 | POST | /api/v1/meta/agent/get-default-template | `{team_id}`（未配置返回 `{}`，用 `data.name` 判空，agents.ts:190-193） | `AgentTemplateConfig` |
| `agentsApi.setDefaultTemplate(teamId, template)` | lib/api/agents.ts:201 | POST | /api/v1/meta/agent/set-default-template | `{team_id, template}`；仅 system_admin，否则 403（agents.ts:197-200） | `{ok}` |

`Agent`（types.ts:67-79）：`agent_id, team_id, owner_user_id, name, description?, prompt?, visibility('private'|'task'|'agent'|'team'|'restricted'), status, created_at, updated_at, metadata_json`。
`AgentAssetView`（types.ts:108-118）：`asset_id, asset_type, name, description?, status, visibility, injection_mode('direct'|'summary'|'tool'|'reference'), priority, created_at`。
`FixedAssetBinding`（types.ts:120-125）：`asset_id, asset_type, injection_mode?, priority?`。
`AgentTemplateAssetIds`（agents.ts:10-17）：`skills?: string[]; code_graphs?: string[]; wikis?: string[]`。
`AgentTemplateConfig`（agents.ts:26-33）：`name, description?, visibility?, metadata_json?, asset_ids?`。

##### User / API Key / 用户配置

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `usersApi.list(params?)` | lib/api/users.ts:18 | POST | /api/v1/meta/user/list | `{username?, user_ids?}` | `PublicUser[]` |
| `usersApi.get(userId)` | lib/api/users.ts:22 | POST | /api/v1/meta/user/get | `{user_id}` | `PublicUser` |
| `usersApi.create(data)` | lib/api/users.ts:32 | POST | /api/v1/meta/user/create | `{username, auth_provider, external_id, display_name?, email?}` | `CreateUserResult` |
| `usersApi.createWithKey(data)` | lib/api/users.ts:49 | POST | /api/v1/meta/user/create-with-key | `{username, user_key}`；冲突 409 `duplicate_user_key`（users.ts:45） | `CreateUserResult` |
| `usersApi.delete(userId)` | lib/api/users.ts:57 | POST | /api/v1/meta/user/delete | `{user_id}` | `{ok}` |
| `userKeysApi.list()` | lib/api/users.ts:80 | POST | /api/v1/meta/user-key/list | `{}`（dedupeInFlight） | `UserKey[]` |
| `userKeysApi.create(data)` | lib/api/users.ts:83 | POST | /api/v1/meta/user-key/create | `{name?, expires_at?, user_id?}` | `UserKey`（`key_value` 明文仅此一次） |
| `userKeysApi.revoke(keyId)` | lib/api/users.ts:87 | POST | /api/v1/meta/user-key/revoke | `{key_id}` | `{ok}` |
| `userConfigApi.get(userId, module, paramName?)` | lib/api/users.ts:140 | POST | /api/v1/meta/config/user/get | `{user_id, module, param_name?}` | `UserConfigView` |
| `userConfigApi.set(userId, module, params)` | lib/api/users.ts:143 | POST | /api/v1/meta/config/user/set | `{user_id, module, params: Record<string,string>}` | `{ok}` |
| `userConfigApi.getAssetCapabilities()` | lib/api/users.ts:146 | POST | 同上 module='asset_type' | 5 个能力位 | `AssetCapabilityConfig` |
| `userConfigApi.setAssetCapability(key, enabled)` | lib/api/users.ts:158 | POST | 同上，值 '1'/'0'（users.ts:160） | `key, enabled` | `{ok}` |
| `sessionInitApi.get()` | lib/api/users.ts:186 | POST | config/user/get module='session_init' | 无 | `SessionInitConfig` |
| `sessionInitApi.set(params)` | lib/api/users.ts:198 | POST | config/user/set module='session_init' | 部分参数，值均为字符串 | void |

`CreateUserResult`（users.ts:8-14）：`user_id, user_type('normal'|'system_admin'), created_at, default_user_key`。
`UserKey`（users.ts:64-76）：`key_id, user_id?, name?, key_prefix?, key_value?, created_at?, expires_at?, revoked_at?, last_used_at?`。
`AssetCapabilityKey`（users.ts:92-97）：`skill.enabled | llm_wiki.enabled | code_graph.enabled | chat_memory.enabled | wiki_jit.enabled`；缺省值 `wiki_jit=false`、其余 true（users.ts:127-133，理由 shadow-first）。
`UserConfigItem`（users.ts:99-105）：`module, param_name, param_key, description, effective_value`；`UserConfigView`（107-112）：`user_id, module, module_description, items`。
`SessionInitConfig`（users.ts:170-175）：`manual_select, default_associate, default_team_id, default_agent_id`（后两者空串=未指定）。

##### 设置（管理员：knowledge / memory）

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `settingsApi.get(target)` | lib/api/settings.ts:139 | POST | /api/v1/settings/{knowledge|memory}/get | 无 | `SettingsView` |
| `settingsApi.set(target, body)` | lib/api/settings.ts:142 | POST | /api/v1/settings/{target}/set | `Record<string, unknown>`；不传 apiKey=保留原值（settings.ts:141） | `SettingsView & {needsRestart, embeddingChanged}` |
| `settingsApi.revectorize(target)` | lib/api/settings.ts:146 | POST | /api/v1/settings/{target}/revectorize | 无 | `{started: boolean}` |
| `rerankModelApi.status()` | lib/api/settings.ts:175 | POST | /api/v1/rerank-model/status | 无 | `RerankModelStatus` |
| `rerankModelApi.download()` | lib/api/settings.ts:191 | POST | /api/v1/rerank-model/download | `{}` | `RerankModelStatus`（异步触发，进度靠轮询，settings.ts:169-173） |

`SettingsView`（settings.ts:69-96）：`llm, embedding, rerank?, importancePenalty?, worthiness?, extraction?, layerRuler?, injection?, coreMemory?, lifecycle?, capture?, evolution?, sceneGovernance?, links?, bm25?, search?, rebuildStatus?{status,reason?,startedAt?,finishedAt?}, needsRestart?, embeddingChanged?`。
`SettingsLlm`（15-24）：`baseUrl, model, maxTokens?, timeoutMs?, hasApiKey, apiKeyMasked, source('env'|'override'|'yaml')`；`SettingsEmbedding`（26-36）另含 `provider?, dimensions?, sendDimensions?`；`SettingsRerank`（39-53）：`enabled?, provider?, baseUrl?, model?, timeoutMs?, candidates?, minScore?, local?{modelDir?,idleUnloadMs?}, hasApiKey, apiKeyMasked, source, configError?`。
`RerankModelStatus`（152-167）：`state('idle'|'downloading'|'ready'|'failed'), percent, repo, modelDir, files[{rel,state,bytesReceived?,totalBytes?,error?}], error, startedAt, finishedAt`。

##### 资产（asset/*，能力位为 false）

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `assetsApi.list(teamId, params?)` | lib/api/assets.ts:17 | POST | /api/v1/meta/asset/list | `{team_id, asset_type?, status?, owner_user_id?}` | `Asset[]` |
| `assetsApi.get(assetId)` | lib/api/assets.ts:29 | POST | /api/v1/meta/asset/get | `{asset_id}` | `Asset` |
| `assetsApi.create(teamId, data)` | lib/api/assets.ts:32 | POST | /api/v1/meta/asset/create | `{asset_id(前端生成前缀), team_id, asset_type, name, description?, owner_user_id, source_type('uploaded' 缺省), content_ref?, visibility('team' 缺省), metadata_json?, detail?}` | `Asset` |
| `assetsApi.update(assetId, data)` | lib/api/assets.ts:62 | POST | /api/v1/meta/asset/update | `{asset_id, name?, description?, status?, visibility?}` | `Asset` |
| `assetsApi.delete(assetId)` | lib/api/assets.ts:68 | POST | /api/v1/meta/asset/delete | `{asset_ids:[id]}` | void |
| `assetsApi.listAccessible(teamId, params?)` | lib/api/assets.ts:86 | POST | /api/v1/meta/asset/list-accessible | `{user_id, team_id, asset_type?, action('read' 缺省), visibility?}` | `Asset[]`（服务端 visibility×ACL 过滤，assets.ts:72-84） |

`Asset`（types.ts:84-106）：`asset_id, team_id, asset_type('skill'|'llm_wiki'|'code_graph'|'chat_memory'), name, description?, owner_user_id, source_type('uploaded'|'url'|'extracted'|'synced'|'manual'|'auto'), source_ref?, version, visibility, status('draft'|'candidate'|'approved'|'deprecated'|'archived'), confidence?, expires_at?, last_used_at?, usage_count, content_ref?, created_at, updated_at, metadata_json`。
#### 1.2 chat-memory（chat_memory 资产族，前缀 POST /api/v1/chat-memory）

统一调用器 `chatMemoryCall<T>(endpoint, body)⟫（lib/api/chat-memory.ts:153）：注入双 Header，code!==0 抛 ApiError 并把 `envelope.data⟫ 放进 `error.data⟫（chat-memory.ts:170-171，409 conflict 用）。

| 方法 | 位置 | 路径（POST） | 入参 | 返回 |
|---|---|---|---|---|
| `health()⟫ | lib/api/chat-memory.ts:179 | /api/v1/chat-memory/health | {} | `{memory: MemoryHealthInfo}⟫ |
| `teamAssets(teamId)⟫ | :182 | /team-assets | `{team_id}⟫ | `{items: ChatMemoryBlock[]; total}⟫ |
| `agentFixed(agentId)⟫ | :186 | /agent-fixed | `{agent_id}⟫ | `{items: ChatMemoryBlock[]; total}⟫ |
| `myAgents(teamId)⟫ | :192 | /my-agents | `{team_id}⟫ | `{items: ChatMemoryBlock[]}⟫ |
| `evidenceByIds(blockId, ids)⟫ | :197 | /evidence-by-ids | `{blockId, ids}⟫ | `{items: Record<string,unknown>[]}⟫ |
| `sourceMessages(blockId, ids)⟫ | :200 | /source-messages | `{blockId, ids}⟫ | `{items: ChatMemorySourceMessage[]}⟫ |
| `recallJournal(teamId, agentId, page=1, pageSize=20, filter='all')⟫ | :202 | /recall-journal | `{team_id, agent_id, page, page_size, filter}⟫ | `{items: RecallJournalEntry[]; total; page; page_size; has_more; filter; counts:{all,recall,skipped}}⟫ |
| `layer(blockId, l, limit=50, offset=0, path?, beforeTs?, timeStart?, timeEnd?)⟫ | :230 | /layer | `{block_id, layer:'L0'|'L1'|'L2'|'L3', limit, offset, path?, before_ts?, time_start?, time_end?}⟫；L0 游标分页传 before_ts 且 offset 归零（:227-229） | `{layer; items: ChatMemoryLayerItem[]; total; limit; offset}⟫ |
| `setAgentFixed(teamId, agentId, blockIds)⟫ | :259 | /set-agent-fixed | `{team_id, agent_id, block_ids}⟫（后端原子校验借入上限，:258） | `{updated, agent_id, block_ids}⟫ |
| `allocate(teamId, blockId, agentId)⟫ | :267 | /allocate | `{team_id, block_id, agent_id}⟫ | `{allocated, agent_id, block_id}⟫ |
| `unbind(teamId, blockId, agentId)⟫ | :275 | /unbind | `{team_id, block_id, agent_id}⟫ | `{unbound, agent_id, block_id}⟫ |
| `create(teamId, title, scope, description?)⟫ | :283 | /create | `{team_id, title, scope:'team'|'private', description?}⟫ | `ChatMemoryBlock⟫ |
| `patchScope(blockId, scope)⟫ | :287 | /patch-scope | `{block_id, scope}⟫ | `{updated, id, scope}⟫ |
| `import(params)⟫ | :294 | /import | `{team_id, agent_id, messages:[{role,content}], session_id?}⟫ | `{imported, block_id, session_id, accepted_count}⟫ |
| `updateLayer(blockId, layer, params)⟫ | :315 | /layer-update | `{block_id, layer:'L1'|'L2'|'L3', id?, content, summary?}⟫（L1=记录主键；L2=文件路径；L3 只 content，:312-314） | `{id?, path?, version?, updated_at?}⟫ |
| `adjustImportance(blockId, id, importance, reason?)⟫ | :335 | /importance | `{block_id, id, importance, reason?}⟫ | `{id?, importance?, importance_source?, version?}⟫ |
| `setSensitivity(blockId, id, sensitivity, expect?, reason?)⟫ | :353 | /sensitivity | `{block_id, id, sensitivity, expect?, reason?}⟫；可写值仅 none/health/finance/relationship，expect 为 CAS（:348-352） | `{id?, sensitivity?, previous?, version?, sensitivity_source?}⟫ |
| `setInvalidated(blockId, id, mode)⟫ | :377 | /invalidate | `{block_id, id, mode:'invalidate'|'restore'}⟫ | `{id?, version?, valid_end?}⟫ |
| `searchLayer(blockId, layer, query, limit=30, type?)⟫ | :390 | /search | `{block_id, layer:'L0'|'L1', query, limit, type?}⟫ | `{items: ChatMemorySearchHit[]; total}⟫ |
| `neighbors(blockId, id, opts)⟫ | :400 | /neighbors | `{block_id, id, types?, maxHop?, maxN?}⟫ | `{id, neighbors:[{id,type,strength?,hop?,content?,occurred_at?,valid_start?,valid_end?,certainty?,valence?,arousal?,significance?}]}⟫ |
| `atomicPath(blockId, startId, endId, opts)⟫ | :432 | /path | `{block_id, startId, endId, maxHop?}⟫ | `{startId, endId, path: [节点] | null}⟫（节点 id/type/strength/hop/…，path=null 表示不可达，:431） |
| `archiveList(blockId, limit=100, offset=0)⟫ | :455 | /archive/list | `{block_id, limit, offset}⟫ | `{items:[{record_id,archived_at,reason,content,occurred_at?}], total}⟫ |
| `archiveRestore(blockId, id)⟫ | :468 | /archive/restore | `{block_id, id}⟫ | `{ok, id}⟫ |
| `moodRead(blockId)⟫ | :476 | /mood | `{block_id}⟫ | `{mood:{tier:'positive'|'neutral'|'strained'|null, sampleCount, enabled?, windowHours?, maxSamples?, minSamples?, posThreshold?, negThreshold?, halfLifeHours?}}⟫ |
| `identityRead(blockId, opts?)⟫ | :497 | /identity/read | `{block_id, format?:'narrative'}⟫ | `{slots:[{slot,content,version?,source?,updated_at?}]}⟫ |

类型（同文件）：`MemoryHealthInfo⟫（:9-17）vectorCoverage, vecRows, metaRows, embedding('ok'|'degraded'), degradedSince, lastVecWriteAt；`ChatMemoryBlock⟫（:20-33）id, title, summary?, uploaded_by_user_id, updated_at_ms, layer_counts{L0_messages,L1,L2,L3}, bound_agent_count?, agent_id?, scope?('team'|'private')；`ChatMemoryLayerItem⟫（:44-86）id, role?, title, body, tags?, refs?, created_at?, occurred_at?, valid_start?, valid_end?, certainty?, valence?, arousal?, significance?, metadata?, task_id?, team_id?, user_id?, agent_id?, version?, updated_at?, scene_name?, priority?, session_key?, session_id?, timestamp_str?, timestamp_start?, timestamp_end?, sensitivity?, importance?, source_message_ids?；`ChatMemorySearchHit⟫（:89-91）= LayerItem + score?；`ChatMemorySourceMessage⟫（:94-106）id, role, content, timestamp, session_key?, session_id?, team_id?, user_id?, agent_id?, task_id?；`RecallJournalEntry⟫（:111-146）ts, query, strategy, teamId, userId?, agentId?, sessionKey?, sessionReused, layered, conclusionCount, experienceCount, searchTiming?{ftsMs,embeddingMs,ftsHits,embeddingHits}, block?, memoryLines?, skipReason?, rawQuery?, rawLen?, rawHash8?, residualChars?；`RecallJournalFilter⟫（:149）'all'|'recall'|'skipped'。

#### 1.3 soul（人格卡 / 版本链 / 特质 / 注入健康 / 情绪 / 人物档案）

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `fetchSoulCard(query)⟫ | lib/api/chat-memory-soul.ts:149 | GET | /api/v1/chat-memory/soul-card?team&user&agent | `SoulCardQuery{teamId, userId?, agentId?}⟫ | `SoulCardPayload⟫ |
| `fetchSoulVersions(query)⟫ | :177 | POST | /api/v1/chat-memory/soul-versions | `{team_id, agent_id?, snapshotLimit?}⟫（userId 轴由 BFF 从 Header 反查，:176） | `SoulVersionsPayload⟫ |
| `fetchSoulTraitState(query)⟫ | :229 | GET | /api/v1/chat-memory/soul-trait-state?team&user&agent | `SoulTraitStateQuery⟫ | `SoulTraitStatePayload⟫ |
| `fetchSoulInjectionStats(query)⟫ | :327 | GET | /api/v1/soul/injection-stats?team&user&agent&hours | `SoulInjectionStatsQuery{teamId, userId?, agentId?, hours?}⟫ | `SoulInjectionStatsPayload⟫ |
| `fetchSoulEmotions(query)⟫ | :414 | GET | /api/v1/soul/emotions?team&user&agent&limit&since | `SoulEmotionsQuery{teamId, userId?, agentId?, limit?, since?}⟫ | `SoulEmotionsPayload⟫ |
| `fetchSoulPersons(query)⟫ | :531 | GET | /api/v1/soul/persons?team&user&agent | `SoulPersonsQuery⟫ | `SoulPersonsPayload⟫ |
| `fetchSoulPerson(query)⟫ | :560 | GET | /api/v1/soul/person?team&user&agent&key | 同上 + `{key}⟫ | `SoulPersonDetailPayload⟫ |

类型（同文件）：
- `SoulCardPayload⟫（:111-133）version, hash, text, chars, labels:SoulCardLabel[], warnings, sources:Record<string,string>, dirty, seeded, schema?:'13', blocks?:SoulCardBlock[]；`SoulCardLabel⟫（:86-91）label, act, gloss?；`SoulCardBlock⟫（:97-105）id, title, chars, source, confidence, evidenceIds, warnings。
- `SoulVersionsPayload⟫（:57-70）teamId, agentId, userId, soulVersion?, rendered?, renderedTruncated, versions:SoulVersionEntry[], notes[]；`SoulVersionEntry⟫（:38-55）at, hash, trigger, version?, parentHash?, reasonCode?, reasonDetail?, lineDiff?, slotDiff?；`SoulVersionLineDiff⟫（:18-21）added, removed；`SoulVersionSlotDiff⟫（:24-29）added, removed, changed, summary。
- `SoulTraitStatePayload⟫（:214-219）agentId, updatedAt, traits:SoulTraitStateRow[]；行（:206-211）label, seedWeight, nowWeight, drifted。
- `SoulInjectionStatsPayload⟫（:286-308）window{hours,from,to}, rows, lastAt, lastCard{version,hash,chars}|null, lastVolatile{chars,hash,skipped}|null, failReasons{http_status,timeout,empty,parse}|null, serverRenderOnly, pairs{matched,charMismatch}, note?:'journal_disabled', volatileCounts?{injected,skipped}。
- `SoulEmotionsPayload⟫（:389-393）rows:SoulEmotionRow[], funnel:Record<SoulEmotionFunnelCode,number>|null；行（:363-378）at, object, objectPerson, label, valence, arousal, dominance, intensity, decayedIntensity, agency, confidence, templateVersion（除 at 外均可 null）；漏斗码（:381-387）emotion:candidate|object_ok|appraised|anchor_hit|intensity_ok|committed。
- `SoulPersonsPayload⟫（:476-479）persons:SoulPersonRow[], edges:SoulPersonEdge[]；行（:448-457）key, displayName, aliases[], platform, platformId, fieldCount, relationCount, updatedAt；边（:463-474）relId, subjKey, subjName, pred, objKey|null, objName, direction('out'|'mutual'), quote, recordId, validFrom。
- `SoulPersonDetailPayload⟫（:510-514）person{key,displayName,aliases}, fields:SoulProfileField[], relations:SoulProfileRelation[]；字段（:488-495）field, label, text, evidence[]{recordId,at,quote}, updatedAt, stale；关系（:498-508）relId, pred, objKey, objName, direction('out'|'in'|'mutual'), counterpartKey, quote, recordId, validFrom。

#### 1.4 knowledge（wiki + code_graph，前缀 POST /api/v1/knowledge）

调用器 `panelPost<T>(path, body)⟫（lib/api/knowledge-api.ts:45），与 meta 不同：失败抛 `KnowledgeApiError(code,message,requestId)⟫（:29-41），HTTP 非 ok 或 code!==0 都算失败（:68-74）。

| 方法 | 位置 | 路径（POST） | 入参 | 返回 |
|---|---|---|---|---|
| `knowledgeApi.health()⟫ | :364 | /health | 无 | Record<string,unknown>，失败吞成 {ok:true} |
| `knowledgeApi.agentFixed(agentId)⟫ | :367 | /agent-fixed | {agent_id} | KnowledgeFixedItem[] |
| `wiki.create(teamId, name, opts?)⟫ | :373 | /wiki/create | {team_id, name, source_type?, source_url?, branch?, path_include?, path_exclude?} | WikiDetail |
| `wiki.sync(wikiId)⟫ | :395 | /wiki/sync | {wiki_id}（非 git 源 400） | void |
| `wiki.updateSource(wikiId, patch)⟫ | :403 | /wiki/source/update | {wiki_id, source_url?, branch?, path_include?, path_exclude?, enabled?} | WikiDetail |
| `wiki.testSource(wikiId, sourceUrl?)⟫ | :415 | /wiki/source/test | {wiki_id, source_url?} | WikiSourceProbeResult{reachable, branches[], error?} |
| `wiki.refetch(wikiId)⟫ | :422 | /wiki/source/refetch | {wiki_id} | {wiki_id, status}（202 异步） |
| `wiki.list(teamId)⟫（@deprecated） | :426 | /wiki/list | {team_id} | WikiDetail[] |
| `wiki.teamAssets(teamId)⟫ | :434 | /wiki/team-assets | {team_id} | WikiDetail[]（KnowledgeAssetItem 映射，:242-266） |
| `wiki.get(wikiId)⟫ | :440 | /wiki/get | {wiki_id} | WikiDetail |
| `wiki.ingest(wikiId)⟫ | :443 | /wiki/ingest | {wiki_id} | void |
| `wiki.ingestWithPolling(wikiId, callbacks, _teamId)⟫ | :446 | 内部 ingest + 轮询 wiki/get | 回调 IngestStreamCallbacks；409 busy 继续轮询（:462-464）；最多 300 次、首次 800ms 之后 2000ms（:466-468） | void（进度走回调） |
| `wiki.delete(wikiId)⟫ | :508 | /wiki/delete | {wiki_ids:[id]} | void |
| `wiki.graph(wikiId)⟫ | :511 | /wiki/graph | {wiki_id} | GraphData |
| `wiki.pages(wikiId)⟫ | :514 | /wiki/page/ls | {wiki_id} | WikiPage[] |
| `wiki.read(wikiId, path)⟫ | :520 | /wiki/page/read | {wiki_id, refs:[path]} | {content}（not_found 抛错，:525） |
| `wiki.pageDelete(wikiId, refs)⟫ | :530 | /wiki/page/rm | {wiki_id, refs} | void |
| `wiki.search(wikiId, query, limit=20)⟫ | :534 | /wiki/search | {wiki_id, query, limit} | {results:[{path,title,snippet,score,type}]} |
| `wiki.rawList(wikiId)⟫ | :543 | /wiki/raw/ls | {wiki_id} | {files:[{filename,size}]} |
| `wiki.rawRead(wikiId, filenames)⟫ | :554 | /wiki/raw/read | {wiki_id, filenames} | {items:[{filename,content?,not_found?}]} |
| `wiki.rawDelete(wikiId, filenames)⟫ | :561 | /wiki/raw/rm | {wiki_id, filenames} | void |
| `wiki.upload({teamId,wikiId,filename,content})⟫ | :565 | /wiki/raw/write | {team_id, wiki_id, files:[{filename,content}]} | void |
| `wiki.allocate(teamId, wikiId, agentId)⟫ | :577 | /allocate | {team_id, knowledge_id, agent_id}（:306-312） | void |
| `wiki.unbind(wikiId, agentId)⟫ | :580 | /unbind | {knowledge_id, agent_id}（:314-316） | void |
| `wiki.agentFixed(agentId)⟫ | :582 | /agent-fixed | {agent_id} | 过滤 asset_type==='llm_wiki' |
| `code.create({teamId, repoUrl, branch='main', repoName?})⟫ | :592 | /code-graph/create | {team_id, repo_url, branch, repo_name?} | CodeGraphDetail |
| `code.list(teamId)⟫（@deprecated） | :606 | /code-graph/list | {team_id} | CodeGraphDetail[] |
| `code.teamAssets(teamId)⟫ | :614 | /code-graph/team-assets | {team_id} | CodeGraphDetail[] |
| `code.registerMeta(teamId, codeGraphId)⟫ | :620 | /code-graph/register-meta | {team_id, code_graph_id} | void（create 不写 meta，ready 后登记，:619） |
| `code.sync(codeGraphId)⟫ | :624 | /code-graph/sync | {code_graph_id} | void |
| `code.delete(codeGraphId)⟫ | :628 | /code-graph/delete | {code_graph_ids:[id]} | void |
| `code.search({codeGraphId, query, kind?, limit=10})⟫ | :632 | /code-graph/search | {code_graph_id, query, kind?, limit}；kind='any' 不传（:641） | {text, isError} |
| `code.explore(codeGraphId, query)⟫ | :646 | /code-graph/explore | {code_graph_id, query} | {text, isError} |
| `code.get(codeGraphId)⟫ | :650 | /code-graph/get | {code_graph_id} | CodeGraphDetail |
| `code.allocate(teamId, codeGraphId, agentId)⟫ | :653 | /allocate | 同 wiki | void |
| `code.unbind(codeGraphId, agentId)⟫ | :656 | /unbind | 同 wiki | void |
| `code.agentFixed(agentId)⟫ | :659 | /agent-fixed | 同 wiki | 过滤 asset_type==='code_graph' |
| `connectors.pull(name, params)⟫ | :667 | /connectors/pull | {name, ...params} | void |

类型（同文件）：`WikiDetail⟫（:80-103）wiki_id, team_id, name, service_url, source_type, source_url, branch, path_include, path_exclude, enabled?, stale?, summary, status('draft'|'pending'|'processing'|'ready'|'failed'|'missing'), internal_status?, sync_error, version, owner_user_id, page_count, last_sync_at, created_at, updated_at；`CodeGraphDetail⟫（:105-122）code_graph_id, team_id, repo_name, repo_url, branch, commit_hash, service_url, summary, status, sync_error, version, owner_user_id, stats{files,nodes,edges}|null, last_sync_at, created_at, updated_at；`KnowledgeAssetItem⟫（:211-240）meta+KS join 列表项；`KnowledgeFixedItem⟫（:296-304）knowledge_id, asset_type('llm_wiki'|'code_graph'), name, description?, status, visibility, agent_id；`GraphData⟫（:188-192）nodes:GraphNode[], edges:GraphEdge[], communities?（节点 id,label,type,path,linkCount,community）；`WikiPage⟫（:194-201）path,title,type,tags?,created?,updated?；`IngestProgressEvent⟫（:158-166）type('file_start'|'file_done'|'file_error'|'batch_done'), file?, detail?, done?, total?, error?, ts。
进度映射是硬编码：`wikiProgressPercent⟫（:346-361）pending=5 / scanning=20 / ingesting=60 / rebuilding-index=85 / 其他 processing=40 / ready|failed|missing=100；`wikiStageLabel⟫（:327-344）把 internal_status 翻成 i18n 文案。
独立轮询工具：`pollWikiStatus⟫（:675，30×3s）、`pollCodeGraphStatus⟫（:689，30×5s）。

#### 1.5 skill（数据面 /api/v1/skill，15 个动作）

两套并存：
- 低层动作函数 `lib/api/skill-api.ts⟫（`skillCall(action, body, signal)⟫，:106；`stripEmpty⟫ 去空串，:92-104；带 AbortSignal）
- 业务封装 `lib/api/skills.ts⟫ 的 `skillApi⟫ 对象（`skillCall⟫ 走 request()，:70-96；`skillPost⟫ 注入双 Header，:98-107）

| 方法 | 位置 | 路径（POST /api/v1/skill/{action}） | 入参 | 返回 |
|---|---|---|---|---|
| `createSkill(params)⟫ | skill-api.ts:153 | /create | {user_id, team_id, agent_id, task_id?, name, content, resources?:SkillResourcePayload[], metadata?} | SkillSummary |
| `updateSkill(params)⟫ | skill-api.ts:168 | /update | {user_id, team_id, agent_id, skill_id, expected_version, content} | SkillSummary |
| `patchSkill(params)⟫ | skill-api.ts:181 | /patch | {user_id, team_id, agent_id, skill_id, expected_version, old_string, new_string, replace_all?} | SkillSummary |
| `deleteSkillV3(params)⟫ | skill-api.ts:196 | /delete | {user_id, team_id, agent_id, skill_id, expected_version} | {skill_id, archived} |
| `getSkill(params)⟫ | skill-api.ts:217 | /get | {user_id?, team_id?, skill_id, version?, include_content=true, include_manifest=true} | SkillDetail |
| `listSkills(params)⟫ | skill-api.ts:249 | /list | {user_id?, team_id?, agent_id?, filters?:{owner_agent_id?,name_prefix?,status?:string[]}, pagination?:{limit=100,offset=0}} | {items: SkillSummary[], total} |
| `searchSkills(params)⟫ | skill-api.ts:275 | /search | {user_id?, team_id?, agent_id?, query, top_k?, mode?:'bm25'|'embedding'|'hybrid', scope?:'team'} | {items: SkillSearchHit[]} |
| `listSkillVersions(params)⟫ | skill-api.ts:286 | /versions | {user_id?, team_id?, skill_id, pagination?} | {items: SkillSummary[], total} |
| `writeSkillFiles(params)⟫ | skill-api.ts:302 | /files/write | {user_id, team_id, agent_id, skill_id, expected_version, files:SkillResourcePayload[]} | SkillSummary |
| `removeSkillFiles(params)⟫ | skill-api.ts:315 | /files/remove | 同上 + paths:string[] | SkillSummary |
| `readSkillFile(params)⟫ | skill-api.ts:337 | /files/read | {user_id?, team_id?, skill_id, version?, path, encoding?} | ReadFileResult |
| `getSkillListing(params)⟫ | skill-api.ts:363 | /listing | {user_id?, team_id?, agent_id, query?, char_budget?} | {mode:'full'|'search', listing, hits:[{skill_id,version,name}]} |
| `extractSkills(params)⟫ | skill-api.ts:415 | /extract | ExtractParams{user_id,team_id,agent_id,task_id?,session_id?,messages[{role,content,tool_name?,tool_call_id?}],reason?,options?{max_iterations?}} | {ok:true, task_id, archived_at_ms, archive_key}（恒异步，:401-407） |
| `exportSkill(params, signal?)⟫ | skill-api.ts:441 | /export | {user_id?, team_id?, skill_id, version?, format?:'zip'}；30s 超时（:439,445） | ExportSkillResult |

`skillApi⟫（lib/api/skills.ts）业务封装，均自动取 getCurrentUser() 的 user_id：

| 方法 | 位置 | action | 入参 | 返回 |
|---|---|---|---|---|
| `list(teamId, opts?)⟫ | skills.ts:111 | list | {ownerAgentId?, namePrefix?, status?}，limit=100 循环翻页（:118-132） | SkillSummary[] |
| `listByAgent(teamId, agentId)⟫ | :137 | list（ownerAgentId=agentId） | — | SkillSummary[] |
| `get(teamId, skillId)⟫ | :141 | get | include_content/manifest=true | SkillDetail |
| `filesRead(teamId, skillId, path)⟫ | :153 | files/read | — | SkillFileContent |
| `create(teamId, agentId, data)⟫ | :164 | create | {name, content, resources?, metadata?}（agentId=owner） | SkillSummary |
| `delete(teamId, agentId, skillId, expectedVersion)⟫ | :187 | delete | 乐观锁 | {skill_id, archived} |
| `update(teamId, agentId, skillId, expectedVersion, content)⟫ | :204 | update | 乐观锁 | SkillSummary |
| `search(teamId, query, opts?)⟫ | :223 | search | {topK=10, scope='team'} | (SkillSummary & {score, snippet})[] |
| `forkToAgent(teamId, sourceSkillId, targetAgentId)⟫ | :258 | get→files/read→create | 副本沿用原名、metadata 记 forked_from（:255-285）；同 agent 重名后端 42201（:252-253） | SkillSummary |

类型：`SkillSummary⟫（skill-api.ts:41-55 / skills.ts:20-34）skill_id, name, description, version, is_head, status('active'|'archived'), owner_user_id, owner_agent_id, team_id, task_id, created_at_ms, updated_at_ms, metadata?；`SkillDetail⟫（:58-63）加 content, manifest, content_hash?, storage_dir?；`SkillManifestEntry⟫（:65-70）path, size_bytes, mime_type, is_executable；`SkillResourcePayload⟫（:73-79）path, content, encoding('utf-8'|'base64'), mime_type?, is_executable?；`SkillSearchHit⟫（:82-85）SkillSummary & {score, snippet}；`ReadFileResult⟫（:328-335）path, content, encoding, size_bytes, mime_type, version。

#### 1.6 agent-persona（人格六项，meta 动作）

| 方法 | 位置 | HTTP | 路径 | 入参 | 返回 |
|---|---|---|---|---|---|
| `fetchAgentPersona(agentId)⟫ | lib/api/agent-persona.ts:48 | POST | /api/v1/meta/agent-persona/get | {agent_id} | AgentPersonaRecord | null（data:null 合法，:5-10） |
| `saveAgentPersona(agentId, name, draft)⟫ | lib/api/agent-persona.ts:57 | POST | /api/v1/meta/agent-persona/save | buildPersonaSaveBody(agentId, name, draft) | AgentPersonaRecord | null；校验失败回 agent_persona_invalid（:53-55） |

#### 1.7 全局数据层与权限（页面数据的间接入口）

| 能力 | 位置 | 说明 |
|---|---|---|
| `useBackendStore⟫（zustand） | stores/backend.ts:86 | teams / activeTeamId / agentsByTeam / loaded 标记 + in-flight 去重 |
| `fetchTeams⟫ / `refreshTeams⟫ | stores/backend.ts:96 / :103 | 先 teamsApi.list()，再并发 membersApi.list 补成员（:118-125）；失败 toast backend.loadTeamsFailed（:137） |
| `fetchAgents⟫ | stores/backend.ts:147 | agentsApi.list(teamId) → adaptAgent（:160-161） |
| `invalidate⟫ / `invalidateTeam⟫ / `clearAll⟫ | stores/backend.ts:192 / :206 / :218 | invalidate 广播 tdai-memory.backend-refresh（:42,202） |
| `useTeams⟫ / `useAgents⟫ | stores/backend.ts:240 / :281 | 自动触发 fetch，多组件共享状态 |
| `useAuthStore⟫ | stores/auth.ts:34 | checkSession（:54）读缓存；logout（:41）只清本地；storage 跨 tab 同步（:74-89）；全局 401 兜底（:95-99） |
| `isGlobalAdmin⟫ | services/permissions.ts:20 | 仅认 isAdminFlag===true（来自 user_type==='system_admin'）；删掉 username==='admin' 兜底（:13-18） |
| `useCurrentRole⟫ | services/useCurrentRole.ts:20 | 先判全局 admin，再取 active team 成员角色（:25-29） |
| `roleInTeam⟫ | services/backendStore.ts:228 | owner 不在 members 列表时按 'member' 返回（:235-239） |
| `canManageAsset⟫ | services/backendStore.ts:253 | owner 或 team admin；admin 不再有全局特权（:260-262） |
| `adaptTeam⟫ / `adaptMember⟫ / `adaptAgent⟫ | services/backendStore.ts:126 / :137 / :146 | agent 的 icon/accent 存 metadata_json.ui；资产绑定字段恒空数组（:156-163） |
| `writeAgentUiMeta⟫ | services/backendStore.ts:106 | merge 写回 ui namespace，保留其他 namespace |



---

### 2. 交互设计（逐页）

#### 2.1 九页共用的壳件

| 件 | 位置 | 交互事实 |
|---|---|---|
| ResourcePage | pages/ResourcePage/index.tsx:10-12 | 只包一层 div._memory-page-body，无其它逻辑 |
| AssetPageHeader | 调用点 pages/WikiPage/components/WikiSourcesPanel.tsx:268-308、pages/CodePage/components/CodeSourcesPanel.tsx:109-156、pages/SkillsPage/components/SkillsPanel.tsx:102-170、pages/ChatMemoryPage/components/ChatMemoryPanel.tsx:255-300 | 五页统一页头：标题 + 副标题 + scope Segment（团队资产/固定资产）+ 仅 fixed 出现的 agent Select + 右侧 actions |
| AssetSplitLayout | components/asset/AssetSplitLayout.tsx:21-23、40-110 | 左栏 220–480px、默认 280（:21-23）；grid 模板 {w}px 6px 1fr（:87）；鼠标拖拽 mousemove/mouseup（:47-66，拖拽期 body.userSelect=none :59-60）；住手柄是 button，←/→ 各 16px 步进（:95-104）；宽度落 localStorage（:69-76），key 由页面传（memory:assetSplitWidth / skills:assetSplitWidth） |
| AssetListPanel | components/asset/AssetListPanel.tsx:43-72 | 列表壳：loading / count / emptyText 三态；配套 AssetItemName/Id/Badges/Meta/Time（:110-171） |
| AllocateAssetDialog | components/asset/AllocateAssetDialog.tsx:17-108 | 只有「选 agent」一个输入（选项文案 id · name，:88）；agents 空则下拉与提交都禁（:88-103）；失败在本弹窗内 Alert（:94），成功 notify 由调用方做（:46-49） |
| LoginGate | components/LoginGate.tsx:89-254 | 实例下拉 + Input.Password；错误按「实例加载失败/未选实例/空 key/无效 key/无用户」五档文案（:120-151）；会话缓存（:46-51） |
| GlobalHeader | layouts/GlobalHeader/index.tsx:60-150 | 品牌 + TeamSwitcher（:64）+「使用说明」→ navigate('/guide')（:74-81）+ 语言切换（:83）+ 设置弹窗（:85-92）+ 用户下拉：我的资料 / 回顾引导 / 登出（:105-135） |
| TabBar | layouts/TabBar/index.tsx:24-77 | role=tab、tabIndex=0，Enter/Space 激活并守卫内层冒泡（:36-45）；关闭按钮 aria-label + stopPropagation（:53-60）；affix 页无关闭（:52） |
| 全局失败提示惯例 | 各页 tea.notify.* + StatusTip/Alert/Note | 无自建 toast 层 |

#### 2.2 WikiPage（旧壳 /legacy/wiki）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 团队/Agent 的文档资产：列表、建库、改源、同步、编译（ingest）、分配 | WikiSourcesPanel.tsx 全文 |
| 布局 | 页头 + 四格指标 + 工具条 + 卡片/列表双视图；详情为 subView 整页替换（非路由） | WikiSourcesPanel.tsx:260-262、314-319 |
| 筛选/搜索 | 关键字 SearchBox、状态 Segment（全部/就绪/处理中）、视图 Segment（卡片/列表） | WikiSourcesPanel.tsx:320-349 |
| 分页 | 无分页器，全量列表 + 前端筛选 | WikiSourcesPanel.tsx:320-349 |
| 空态 | 三级：骨架 6 张 / 无源 StatusTip / 筛选空 StatusTip | WikiSourcesPanel.tsx:351-373 |
| 写操作-新建 | Modal：名称必填；来源 upload/git；git 额外 url/分支/path_include/path_exclude；url 非法即时 Alert；提交 disabled = submittng 或 canCreate 不成立 | WikiSourcesPanel.tsx:634-726、:178 |
| 写操作-改源 | 只提交真正变化的字段（避免误标 stale）；「测试连接」按候选 url 探测，可达后出现分支 Select 可直接选；底部常驻 Alert 说明改源会触发 stale | WikiSourcesPanel.tsx:531-614、:200-212、:583-611 |
| 写操作-分配 | AllocateAssetDialog，成功后 toast + fetchSources，fixed tab 再 fetchFixedBindings | WikiSourcesPanel.tsx:729-744 |
| 详情 | 面包屑返回（返回时重新 fetch）、头部三动作（添加文档 / 同步 / 编译）、四 tab：概览·图谱·页面·搜索 | wiki-detail-view.tsx:166-224、345-388 |
| 详情-日志流 | 编译中显示逐文件 ingest log（file + ok/error 图标 + 错误文案） | wiki-detail-view.tsx:300-343 |
| 详情-空态 | 选中的 wiki 已不存在 → 面包屑 + StatusTip「notFound」，可一键回列表 | wiki-detail-view.tsx:146-164 |
| 易忽略 | 列表视图 Table 操作列 fixed:right、addons 横向滚动 minWidth 1040；卡片上 stale「待重新拉取」与 enabled=false「已暂停」是两种独立徽标 | WikiSourcesPanel.tsx:431-525、:75-101 |

#### 2.3 CodePage（旧壳 /legacy/code）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 代码仓库资产：登记、索引状态、同步、分配 | CodeSourcesPanel.tsx:101-156 |
| 布局 | 页头 + 四格指标（总数/就绪/处理中/总文件数）+ 工具条 + 卡片/列表；详情 subView 整页替换 | CodeSourcesPanel.tsx:101-103、161-193 |
| 筛选/搜索 | SearchBox、状态 Segment（all/ready/processing/error）、视图 Segment | CodeSourcesPanel.tsx:176-193 |
| 空态 | 三级：6 张骨架 / 无资产 StatusTip（带图标）/ 筛选空纯文案 | CodeSourcesPanel.tsx:199-221 |
| 写操作-登记 | Modal：Git URL 必填 + 分支必填；git@ 前缀给 warning（暂不支持 SSH），非 SSH 且不合法给 error；提交 disabled = submitting 或 分支空 或 url 非法 | CodeSourcesPanel.tsx:466-530、:519 |
| 写操作-同步/删除 | 卡片 actions 区 stopPropagation，避免点按钮触发选中；详情头部也有「同步」按钮 | CodeSourcesPanel.tsx:281-284；code-detail-view.tsx:61 |
| 详情 | 面包屑 + 头部（仓库名/状态/同步）+ sync_error 红 Alert + 三格 stats（文件/节点/边）+ 仓库信息卡 + 「代码搜索」卡 + 「代码探索」卡，两卡都是 SearchBox → AssetMarkdown 结果 | code-detail-view.tsx:36-175 |
| 易忽略 | 卡片标题是独立按钮（stopPropagation 直接进详情），整卡 onClick 只是选中——同一张卡两种点击语义 | CodeSourcesPanel.tsx:239-251 |

#### 2.4 SkillsPage（旧壳 /legacy/skills）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 技能包：团队维度按 name 去重聚合、Agent 维度单 agent 固定资产；导入/分配/Fork/删除、版本历史、文件级编辑 | SkillsPanel.tsx:5-26 |
| 布局 | AssetSplitLayout（左列表 + 右详情），storageKey skills:assetSplitWidth | SkillsPanel.tsx:175-286 |
| 筛选/搜索 | 只有 scope Segment 与 agent Select；无关键字搜索（列表全量） | SkillsPanel.tsx:102-130 |
| 空态 | AssetListPanel 的 emptyText 三态；详情无选中显示「选择左侧技能查看详情」 | SkillsPanel.tsx:175-286；SkillDetailPane.tsx:421-429 |
| 写操作-导入 | 弹窗两种模式 Segment：directory（原生 input webkitdirectory 选整包，读 SKILL.md 与资源清单）与 session（贴 JSON 消息数组）；target 恒 fixed，必须选归属 agent；成功后 800ms 自动刷新 | ImportSkillDialog.tsx:357-481、:310 |
| 写操作-Fork | 仅 team tab：getSkill → listSkills 查重 → readSkillFile → 改写 frontmatter name（原名-fork-<agentId>）→ createSkill；即「复制出独立可写副本」 | ForkSkillDialog.tsx:84-121、:35-41 |
| 写操作-分配 | 与 Wiki/Code/Memory 同一个 AllocateAssetDialog，语义是「引用」（team_to_agent，只读副本，共享 SKILL.md） | SkillsPanel.tsx:11-16 |
| 写操作-删除 | 列表项内删除按钮（仅 owner），tea.confirm 后删 | SkillsPanel.tsx:211-232 |
| 可见性 | fixed && owner 时列表项内嵌共享/私密 Segment；vis 缺失按 private 兜底 | SkillsPanel.tsx:256-267 |
| 详情 | 三段：固定头（名字/id/Copy/描述/编辑·添加文件·版本历史）+ 可滚动中段（frontmatter 全字段 + Markdown 正文）+ 固定底段附属资源树；版本 Modal 列「当前/时间/查看」，可开只读版本视图 | SkillDetailPane.tsx:435-479、504-576、686-800 |
| 易忽略 | 详情收的是原始 selectedSkillId（不是 selectedSkill.skill_id），避免先闪空态；stale 判据 view.skill_id !== skillId 时整段不显示旧内容 | SkillsPanel.tsx:276-278；SkillDetailPane.tsx:189-191 |

#### 2.5 ChatMemoryPage（旧壳 /legacy/memory）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 记忆块资产：块列表 + 四层（L0/L1/L2/L3）浏览、语义检索、编辑、共享/私密、解绑/删除、导入、分配；另有页级「图谱」「回放日志」两档 | ChatMemoryPage/index.tsx:18-45 |
| 页级三档 | memory/graph/journal 用 Segment；memory 常挂载但 display:none 隐藏以保内部选中态，graph/journal 条件挂载（Sigma 需要真实尺寸） | ChatMemoryPage/index.tsx:36-41 |
| 健康条 | 顶部细条：覆盖率 36px 迷你环（阈值 <70 红/70–90 黄/>90 绿）、unconfigured 与 degraded 两种样式、degraded 追加黄条说明；接口失败静默落「未知」 | ChatMemoryPanel.tsx:103-173、:33-35、:114-116 |
| 布局 | AssetSplitLayout（storageKey memory:assetSplitWidth）左列表右 BlockDetail | ChatMemoryPanel.tsx:305-306 |
| 筛选/搜索 | 左栏 scope Segment（默认 fixed）+ fixed 时 agent Select；右栏详情内是「浏览/检索」二选一模式；检索仅 L0/L1，L1 多一个 type 原生 select | ChatMemoryPanel.tsx:255-270；BlockDetail.tsx:855-900、934-970 |
| 分页 | L1/L2/L3 用翻页器；L0 无翻页器，滚到顶部自动加载更早（24px 阈值防链式自动加载），到底显示「已全部加载」 | BlockDetail.tsx:642-645、760-801、1141-1209 |
| 空态 | 检索未搜 → searchPrompt；rangeTooLarge → 提示收窄范围（置于搜索态之后，搜索不受时间范围限制）；L0 无数据分「范围内无」与「全无」 | BlockDetail.tsx:1091-1214 |
| 写操作-共享/私密 | 左栏卡片内 Segment，stopPropagation；切私密前 confirm 说明其他 agent 将不可再用 | ChatMemoryPanel.tsx:361-390；useChatMemory.ts:605-627 |
| 写操作-解绑/删除 | 左栏「解绑」按钮（canUnbind 时替代时间行）；删除块其实是 unbind（confirmThenRun + chatMemoryApi.unbind） | ChatMemoryPanel.tsx:361-372；useChatMemory.ts:559-578 |
| 写操作-编辑 | L1/L2/L3 通用 Modal（名字 + TextArea），保存中 disableEscape；L2 编辑前 stripScenarioMeta 去 META 头，保存后同步搜索结果 | BlockDetail.tsx:1301-1331、:670-686 |
| 写操作-导入/分配 | 页头右「分配到智能体」（未选中或私密且非 owner 时 disabled + tooltip）与「导入」（无 owned agent 时 disabled + tooltip） | ChatMemoryPanel.tsx:273-300 |
| 图谱 | 页级图谱页签：块选择器 + 只读图；节点上限 60，邻接按节点并发 neighbors(maxN 24)；详情卡有 valence 双色条/方向、recall_count、coreRefs 价值 chips；图例注明「时间→左早右晚」「双向异类边仅示先到方向」 | MemoryGraphTab.tsx:1-80；MemoryGraphView.tsx:216-247、249-260、370-381、382-423 |
| 回放日志 | RecallJournalView：PAGE_SIZE 20、上一页/下一页、刷新按钮、无团队/加载中/空/错误四态 | RecallJournalView.tsx:24、137-183、273-279 |
| 易忽略 | 卡片里嵌「解绑」与共享 Segment 两个可点控件，靠 stopPropagation 与整卡选中区分；fixed tab 下别人的私密块整项禁用并打「已撤销」徽标 | ChatMemoryPanel.tsx:316-341 |

#### 2.6 SoulPage（旧壳 /legacy/soul）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 只读人格面：注入健康 / 感受 / 情绪明细 / 人物档案 + 关系图 / 人格卡 / 身份双槽 / 版本链 | SoulPage/index.tsx:114-152 |
| 布局 | 纵向全宽七段；页头六个锚点 pill 平滑滚动定位；右侧 agent Select 只列本人 owner 的 agent | SoulPage/index.tsx:34-41、87-90、98-109、54-57 |
| 自动刷新 | 注入健康与情绪明细各自每 60s 轮询；其它段一次性加载 | InjectionHealthBar.tsx:109-114；SoulEmotionPanel.tsx:99-104 |
| 失败态 | 每段独立 catch，取不到就整段不渲染或显「—」，不伪造 0；人物档案失败给「重试」按钮 | InjectionHealthBar.tsx:93-157、:206-207；PersonArchivePanel.tsx:169-181 |
| 人物段 | 左列表（displayName / 也叫 aliases / N 字段·M 关系）+ 右详情（固定九字段顺序、缺字段「还没有依据」、stale「依据已过期」、evidence 折叠原话）+ 关系列表（可点时跳对方）+ 底部 SVG 关系图（仅 registered 节点可点） | PersonArchivePanel.tsx:189-348；PersonRelationGraph.tsx:115-255、:228 |
| 人格卡 | 原文进 pre 不改写不截断；dirty 时「未落版」chip；details 展开「字段来源与底色」+ 五值图例 | CardView.tsx:112-231 |
| 版本链 | 行 = 时间/版本或「旧快照」/hash/原因 chip/parent/字段 diff；底部可展开当前人设 pre（超长提示仅前 4000 字） | SoulVersionChain.tsx:41、96-171 |
| 身份双槽 | active 时换成叙事视图；灰态双栏（我是谁/我心中的他）；超 12 行或 600 字折叠 | SoulIdentityDual.tsx:92-140 |
| 易忽略 | 注入健康容器 aria-live=polite；无 teamId 直接判 failed 而不是拿别的团队数字 | InjectionHealthBar.tsx:147、:81-85 |

#### 2.7 MembersPage / AgentsPage（旧壳 /legacy/team/*）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 同一 TeamManagementPanel 换 section：成员（含加成员/发 user_key）与智能体（含默认模板、卡片/列表） | pages/MembersPage/index.tsx、pages/AgentsPage/index.tsx（各 18 行，均无 auth 返回 null）；TeamManagementPanel.tsx:82-91 |
| 布局 | TeamHeaderCard（建团队按钮仅 admin）+ 成员区 + 默认 Agent 模板区（仅 admin）+ AgentGrid；四个弹窗在面板底部条件挂载 | TeamManagementPanel.tsx:262-362 |
| 成员 | MemberCard 网格（data-guide="members-list"）；加成员按钮 data-guide="add-member"；AddMemberDialog 可「新建用户并发 key」或「加已有用户」，成功后 CreatedUserKeyModal 展示一次性 user_key（含复制） | MemberSection.tsx:28-104、179-268、300-440、449-500 |
| 智能体 | 工具条：新建（data-guide="create-agent"）+ SearchBox + owner Select（仅能看全员时）+ 卡片/列表 Segment；四格挂载统计 skills/code_graph/llm_wiki/chat_memory | AgentGrid.tsx:170-230、160-167 |
| 空态 | 无团队 → EmptyTeamState（普通用户不显示建团队入口）；无 agent / 筛选空分两套文案 | TeamManagementPanel.tsx:379-389；AgentGrid.tsx:285-295 |
| 角色收敛 | 菜单/按钮按 admin·reviewer·member 收敛（reviewer 看不到成员、settings 仅 admin） | ConsoleLayout.tsx:145-163 |
| 易忽略 | Agent 卡片上名字/整卡两种可点语义同样靠 data-guide 与 stopPropagation 区分 | AgentGrid.tsx:129、:301 |

#### 2.8 ApiKeysPage（旧壳 /legacy/team/api-keys）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 当前用户 User_Key 的创建、撤销 | ApiKeyPanel.tsx:47-105 |
| 布局 | 页头（标题 + 说明 + 新建按钮，admin 隐藏新建）+ Card 内 Table（key_id / key_prefix / 创建时间 / 过期时间 / 操作） | ApiKeyPanel.tsx:171-266 |
| 新建 | Modal 只选过期日期（收集 endOf('day')），不填名称；创建后返回明文只展示一次，复制成功即自动关闭明文 Alert | ApiKeyPanel.tsx:100-124、150-168 |
| 撤销 | tea.confirm（带 key_prefix）→ revoke → 刷新；已撤销行操作按钮 disabled 且过期列显示「已撤销」 | ApiKeyPanel.tsx:126-139、242-263 |
| 易忽略 | 列表本身不展示名称列，因此创建时不再收集名称（代码注释明确） | ApiKeyPanel.tsx:100 |

#### 2.9 SettingsPage（旧壳 /legacy/settings）

| 维度 | 内容 | 证据 |
|---|---|---|
| 职责 | 管理员配置面四档：A 部署与凭据 / B 应急开关 / C 校准阈值 / D 常量清单，外加 Wiki 设置与 Rerank | SettingsPage/index.tsx:639-676 |
| 权限 | 非 admin 直接渲染「仅管理员可访问设置页」文本 | SettingsPage/index.tsx:640-641 |
| Tab | 六个：knowledge（Wiki 设置）/ deploy（A）/ gates（B）/ calibration（C）/ constants（D）/ rerank | SettingsPage/index.tsx:644-673 |
| A 档 | 两组（LLM/Embedding）× 五个字段；API Key 输入框 placeholder 显示尾 4 位掩码且「留空保留原值」；保存后若 embeddingChanged 提示需重启并自动重建向量索引；底部另有「重建向量索引」按钮（仅 knowledge 且状态 failed/done） | SettingsPage/index.tsx:96-126、139-144、149-261 |
| B 档 | 每个开关显示「当前生效」Tag + 配置键路径 + 开启/关掉后的后果文案；按钮文案随改动数变化（「保存 N 项改动」/「无改动」） | ConfigPanels.tsx:169-250 |
| C 档 | 分段表单（重要度 / 值得度 / 选线尺 / 注入预算），边界校验集中在 valid（0–0.9、>0 且 ≤1、50–5000ms 等），非法时保存按钮禁用 | ConfigPanels.tsx:292-347、:303-315、:514-518 |
| D 档 | 只读表格：搜索框（键名/类型/意义）+ 档位 Select + 「共 N 条匹配（当前显示前 X 条）」+ 手工 table（档位/配置键/类型/缺省/意义/解析点），最多渲染 300 行 | ConfigPanels.tsx:525-609、:539 |
| Rerank | 本地模型下载状态 + 七个输入 + 两个底部按钮，保存提示重启生效 | SettingsPage/index.tsx:305-637 |
| 易忽略 | B/C/D 三档写入都走同一条 settingsApi.set('memory', 段)，但每档都自己提示「重启后生效」；D 档明确「只展示不可改，要改走代码评审」 | ConfigPanels.tsx:10-14、:547-549 |

#### 2.10 星图壳七站（新壳 /）— 交互摘要

| 站 | 布局与关键交互 | 证据 |
|---|---|---|
| MemoryStation | 复用 useChatMemory；四层 Seg + 检索（L0 传 L0、其余传 L1）+ 上一页/下一页 + L0「加载更早」；卡片点击展开/收起；右栏块列表、块信息（改可见性/删除）、条目详情（标记失效）、原文证据（失败显 Note） | stations/MemoryStation.tsx:113-362 |
| SoulStation | 只读五段 Seg（人格卡/特质/情绪/人物关系/注入）；并发六路取数，单路失败 settle 成 null；情绪漏斗缺档不伪造数字 | stations/SoulStation.tsx:111-398、:228 |
| KnowledgeStation | wiki 与 code 共用；工具条右「刷新」+ 开关式新建表单；卡片选中/再点取消；右栏资产详情含重新拉取/重新索引/删除 | stations/KnowledgeStation.tsx:27-281 |
| SkillsStation | 先读当前 agent 技能，空则退团队/用户面并标「范围 团队用户」；搜索回车触发；右栏技能信息 + 缺三个轴时删除直接报错 | stations/SkillsStation.tsx:39-231 |
| TeamStation | 三段 Seg 由 pathname 决定，切换即 nav；内嵌 TeamManagementPanel 与 ApiKeysPage | stations/TeamStation.tsx:24-62 |
| SettingsStation | 直接嵌 SettingsPage，Note 明说「换成星图语汇的表单是下一阶段的事」 | stations/SettingsStation.tsx:14-19 |
| 站台抽屉 | .station-veil 点击收起、sheet 内 stopPropagation；Esc 关闭（window keydown）；右上「收起」 | StarmapLayout.tsx:72-78、284-307 |

---

### 3. 新旧两套壳

#### 3.1 路由与组件映射

| 旧路径（/legacy/*） | 组件 | 新路径（/） | 新壳组件 | 是否复用旧页 |
|---|---|---|---|---|
| /legacy/wiki（及 index） | WikiPage（pages/WikiPage/index.tsx:4-9） | /wiki | WikiStation → KnowledgeStation（WikiStation.tsx 6 行） | 否，完全自绘 |
| /legacy/code | CodePage（pages/CodePage/index.tsx:4-9） | /code | CodeStation → KnowledgeStation（CodeStation.tsx 6 行） | 否 |
| /legacy/skills | SkillsPage（pages/SkillsPage/index.tsx:6-15） | /skills | SkillsStation | 否 |
| /legacy/memory | ChatMemoryPage | /memory | MemoryStation（复用 useChatMemory + chatMemoryApi） | 部分：只复用 hook/接口，不复用 BlockDetail |
| /legacy/soul | SoulPage | /soul | SoulStation（只读，自绘） | 否 |
| /legacy/team/members | MembersPage（18 行，section=members） | /team/members | TeamStation | 是：内嵌 TeamManagementPanel |
| /legacy/team/agents | AgentsPage（18 行，section=agents） | /team/agents | TeamStation | 是 |
| /legacy/team/api-keys | ApiKeysPage（5 行） | /team/api-keys | TeamStation | 是：内嵌 ApiKeyPanel |
| /legacy/settings | SettingsPage | /settings | SettingsStation | 是：整页内嵌 |
| 无 | — | / | StarmapLayout（常驻星图画布） | 新增，旧壳无对应物 |

路由定义：routes/index.tsx:32-52（新壳）/ 53-68（旧壳）；两个 RouteObject，无 path:'*' 兜底（routes/index.tsx:32-69）。HashRouter：routes/index.tsx:71-75。

#### 3.2 覆盖差异（哪些能力只有一边有）

| 能力 | 新壳 | 旧壳 | 证据 |
|---|---|---|---|
| 星图背景 + 星点详情 + 关系线 | 有 | 无 | StarmapLayout.tsx:96-109、218-280 |
| 顶栏团队/智能体/记忆块三选择 + 重算星图 | 有 | 无（旧壳用 GlobalHeader + TeamSwitcher + 页内选择） | StarmapLayout.tsx:122-142 |
| 用户菜单（我的资料/回顾引导/登出）、语言切换、设置弹窗、使用说明 | 无 | 有 | GlobalHeader/index.tsx:74-135；StarmapLayout.tsx 全文无 GlobalHeader 引用 |
| Wiki 详情四 tab / 编译日志流 / 改源测试连接 | 无 | 有 | wiki-detail-view.tsx:300-388 |
| Code 详情（代码搜索/代码探索） | 无 | 有 | code-detail-view.tsx:130-175 |
| Skill 版本链 / frontmatter / 文件级增删改 / Fork / 导入整包 | 部分（getSkill + listing，删除） | 有 | SkillDetailPane.tsx:435-800；SkillsStation.tsx:68-89、229-231 |
| 记忆 BlockDetail（时间筛选/检索/L0 聊天流/编辑/图谱） | 部分（四层列表 + 检索 + 失效标记，无时间筛选与编辑） | 有 | BlockDetail.tsx:642-1331；MemoryStation.tsx:113-337 |
| 记忆回放日志（RecallJournal） | 无 | 有 | ChatMemoryPage/index.tsx:18-45 |
| Soul 全部细节（特质/情绪/人物/卡/身份/版本/注入） | 有（只读五段） | 有（七段全宽） | SoulStation.tsx:111-398；SoulPage/index.tsx:114-152 |
| 设置表单 | 有（内嵌旧页） | 有 | SettingsStation.tsx:14-19 |
| 成员/智能体 CRUD、user_key 发放 | 有（内嵌旧组件） | 有 | TeamStation.tsx:52-62 |

#### 3.3 旧壳是否仍可用

| 结论 | 证据 |
|---|---|
| 可用：/legacy 及其九个 child 路由都在路由表里，数据与鉴权链共用（LoginGate/localStorage 会话） | routes/index.tsx:53-68；routes/index.tsx:7-8 注释 |
| 新壳里没有任何指向 /legacy 的链接：全仓 grep 'legacy' 只命中路由定义与无关的版本链 legacy 语义 | routes/index.tsx:7、54；其余命中见 SoulPage/soul-version-view.ts 等（同名不同义） |
| 旧壳兼容更老的 hash 叶子（wiki/code/skill|skills/chat_memory|memory|chat-memory/soul/agents|team_agents/team|members|team_members/api_keys|apikey|api-keys），挂载时 replace 跳到新 path | ConsoleLayout.tsx:40-63、80-85 |
| 已退役页 workbench / workbench_board / guide / llm_provider / llm-provider 一律落到 /wiki | ConsoleLayout.tsx:56-61 |
| 旧壳顶栏「使用说明」指向 /guide，但路由表里没有该路由 → 点击后无匹配路由、整屏空白 | GlobalHeader/index.tsx:74-81 vs routes/index.tsx:32-69 |
| 旧壳侧栏窄屏（<768px）默认折叠成 48px 图标轨；首次引导自动弹、可从用户菜单重放 | ConsoleLayout.tsx:93-95、97-116 |
| RouteGuards（ResourceGuard/MemberManageGuard）定义存在，但当前路由表未使用 | components/RouteGuards.tsx:12-44；routes/index.tsx 无引用 |

---

### 4. 三处最值得重做的交互问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | 新壳是死胡同：没有 GlobalHeader，因此没有登出、语言切换、设置弹窗、使用说明；同时全仓没有任何链接指向 /legacy，用户落在 / 之后只能手改 hash 才能回到能登出/能改语言的界面 | StarmapLayout.tsx:112-142（顶栏只有品牌 + 三个选择 + 重算）；routes/index.tsx:32-52；grep 'legacy' 全仓无引用 |
| 2 | 旧壳顶栏「使用说明」是死链：navigate('/guide')，而路由表只有 '/' 与 '/legacy' 两个根、无 '*' 兜底，点击即空屏 | GlobalHeader/index.tsx:74-81；routes/index.tsx:32-69 |
| 3 | 同一个「挂到智能体」的位置有四种语义：Wiki/Code/Memory 是引用（AllocateAssetDialog），Skill 的分配也是引用、Fork 是复制、导入是写入并发新版本——按钮长一样、后果不同，用户无法从 UI 预判 | SkillsPanel.tsx:11-16、133-170；AllocateAssetDialog.tsx:15-26；ForkSkillDialog.tsx:84-121 |
