# MemoryKnowledge 删改清单（dsh 特化，task-6）

> 范围：`MemoryKnowledge/`（70 文件 / 13,712 非测试行：src/engines 4,945｜src/store 3,425｜src/routes 1,968｜src/mcp 401｜src/rerank 94｜src/db 347｜src/middleware 190｜src/source-fetcher 269）。**只做 knowledge，不含 MemoryPanel**（panel 结论见 core.md / knowledge-panel.md 卷）。
> 判定口径沿用本目录 README §判定：**D 删** = 唯一存在理由是「LLM 流量经过我们 / 多端协议适配 / 未鉴权就地转发」；**M 改** = 逻辑仍有价值但入口或契约变了；**K 留** = 与流量路径无关。
> 行数为 `wc -l` 实测（`find src -name '*.ts' -not -path '*__tests__*' | xargs wc -l` = 13,463，另 249 行为 bin/openapi 等非 src 文件），路径相对 `MemoryKnowledge/`（另有标注者除外）。全部结论来自真实代码阅读，未改任何源码。

## 0. 一句话结论

1. **本体留**：wiki/code-graph 的 store、ingest 引擎、索引、文件协议、source-fetcher 共 ~11k 行与 LLM 流量路径无关（`MemoryKnowledge/src/module.ts:160-204` 装配即全部），dsh 特化后它仍是**独立内容服务**，不因代理消失而失效 → K。
2. **要动的只有三处「为内部多租户 + 代理而存在」的接缝**：MCP stdio 垫片（`src/mcp/*` 401 行，D）；LLM 出口 binding 链（`routes/llm-binding.ts` + `store/llm-binding-store.ts` + `llm_binding` 表，308 行，M/D 取决于是否保留 proxy 内部网关）；鉴权模型（空 key 全开 + 路径白名单，M，**唯一安全项，先做**）。
3. **暴露面**：不需要公网。但 `/v3/wiki/*`、`/v3/code-graph/*`、`/v3/tools/*` 是**agent 直连面**（proxy 服务端只调 `/v3/wiki/search` 一个），所以「KS 必须被开发者机器访问到」——同机会环即可，分机走内网；纯回环 + 直连是推荐拓扑，此时零暴露。

## 1. 规模与模块分布

| 目录 | 行数 | 文件数 | 职责（一句话） |
|---|---|---|---|
| src/（根） | 1,737 | 9 | 装配（module/server）、配置（config/config-override）、跨切面（logger/api-helpers）、可观测（telemetry/clickhouse）、状态回调（callback）、工具名单（codegraph-tool-names） |
| src/engines/wiki/ | 2,438 | 8 | wiki 生命周期管理（manager 1,579）、per-wiki `index.db`（FTS/page_meta/graph_edge）、多跳 BFS、embedding 客户端、git 源过滤拷入 |
| src/engines/wiki/ingest-v2/ | 2,252 | 14 | 两阶段摄取引擎：LLM 抽取 → FILE 块协议解析 → merge/cascade → index 重建；含提示词、模板、分块、frontmatter、slug、log |
| src/engines/code/ | 255 | 3 | `@colbymchenry/codegraph` 原生桥（bridge 200 行）+ 结果归一 |
| src/store/ | 3,425 | 10 | SQLite/Drizzle 多租户存储（sqlite-store 681）、wiki 异步编排（wiki-service 1,254）、code-graph 编排（398）、auto-sync 调度器（375）、binding（191）、队列/ID |
| src/routes/ | 1,968 | 7 | HTTP 面：wiki 21 端点（761）、tools 自发现（576）、code-graph 14 端点（363）、llm-binding 3、admin 3、auto-sync 2、health 1 |
| src/mcp/ | 401 | 3 | **独立 stdio 进程**的 MCP 服务器：12 个只读查询工具 + HTTP 垫片 |
| src/middleware/ | 190 | 3 | 服务鉴权（93）、响应信封（82）、错误处理（15） |
| src/rerank/ | 94 | 1 | core `/v1/rerank` 薄客户端（可选，默认不注入） |
| src/db/ | 347 | 2 | Drizzle schema（158）+ client/迁移（189） |
| src/source-fetcher/ | 269 | 4 | git/local/ftp 协议路由 + 安全校验（SSRF/路径） |

## 2. HTTP 端点全清单与鉴权

装配：`src/server.ts:41-54` 建 module → `:64` health 挂在根（**不在 /v3 前缀、不过鉴权中间件**）→ `:70` 建 `api` 子应用并**先**挂 `createServiceAuthMiddleware(config.auth, config.apiPrefix)` → `:72` telemetry 只挂 `/tools/call` → `:73-109` 依次挂 wiki / code-graph / tools / internal/llm-binding / admin/settings / auto-sync → `:111` `app.route(config.apiPrefix, api)`（默认 `/v3`）→ `:115-126` swagger `/openapi.json`+`/docs` 在前缀外、无鉴权。

**鉴权本体**（`src/middleware/auth.ts:80-92`）：`KNOWLEDGE_SERVICE_KEY` 为空 ⇒ 直接 `next()`（`:26-35`，向后兼容，启动只打一行 warn：`server.ts:143` "Service auth: DISABLED — KNOWLEDGE_SERVICE_KEY is empty, all /v3 endpoints are open"）；非空 ⇒ 白名单外一律要求 `Authorization: Bearer <serviceKey>`，否则 401 `unauthorized: valid service key required`。比较走 `timingSafeEqual`（`:37-45`），Bearer 解析正则 `/^Bearer\s+(\S+)\s*$/i`（`:73-78`）。

**关键事实：`x-tdai-service-id` 不是鉴权**，是租户/路由键，各路由用 `isValidIdSegment` 校验格式后落库查询（例：`routes/wiki.ts:697-703` 的 `getById(service_id, wiki_id)`）。也就是说「谁带了这个头，谁就是那个租户」——由调用方自证。

白名单（`auth.ts:48-60`，**纯路径匹配、不看 body、只支持 POST/GET**）：
- 全部 POST：`/tools/list`、`/tools/call`、`/wiki/{get,list,raw/ls,raw/read,page/ls,page/read,graph,search}`、`/code-graph/{list,get}` + `CODEGRAPH_QUERY_TOOL_NAMES` 展开的 8 个查询端点（来自 `src/codegraph-tool-names.ts:13-15`，单一真源，同时喂动态路由注册 `routes/code-graph.ts:323`、工具名校验 `:353`、本白名单）。
- GET：仅 `/auto-sync/status`。
- 注释明说 `/internal/llm-binding/{status,list}` **故意**不入白名单（`:13-14`：泄露 base_url 与存在性）。

| 组 | 端点 | 文件:行 | 鉴权（key 已设时） | 主要调用方 |
|---|---|---|---|---|
| health | GET /health | routes/health.ts:10 | 无（前缀外） | 部署探活 |
| wiki 资产 | /get /ingest /sync /delete /update-meta /create /list | wiki.ts:63,75,102,122,158,181,244 | 读公开；写需 key | Panel；proxy 无 |
| wiki 源 | PATCH /:id/source、/:id/test、/:id/refetch、DELETE /:id | wiki.ts:270,360,404,430 | 需 key | Panel |
| wiki 文件 | /raw/{ls,read} /page/{ls,read} | wiki.ts:449,464,581,596 | 公开 | Panel + agent |
| wiki 文件写 | /raw/{write,rm} /page/{write,rm} | wiki.ts:495,550,627,666 | 需 key | Panel |
| wiki 派生 | /graph /search | wiki.ts:695,712 | 公开 | **/search 由 proxy 服务端调用**；/graph 由 Panel/agent |
| code-graph CRUD | /create /list /get /update-meta /sync /delete | code-graph.ts:183,219,233,245,266,286 | 读公开；写需 key | Panel |
| code-graph 查询 | /search /explore /callers /callees /impact /node /status /files | code-graph.ts:323-360（for-of 动态注册） | 公开 | agent（curl）/ Panel |
| 工具自发现 | /tools/list、/tools/call | tools.ts:206,259 | 公开 | **agent（curl）** |
| LLM 绑定 | /internal/llm-binding/{set,status,list} | llm-binding.ts:40,95,103 | 需 key（但见 §8-2） | Panel 启动钩子 |
| 设置 | /admin/settings/{get,set,revectorize} | admin-settings.ts:39,50,78 | 需 key | Panel settings 页 |
| 自动同步 | GET /auto-sync/status、POST /auto-sync/trigger | auto-sync.ts:25,38 | 读公开；触发需 key | Panel / 运维 |

合计：`/v3` 下 45 个端点（wiki 21 + code-graph 14 + tools 2 + llm-binding 3 + admin 3 + auto-sync 2），前缀外 3 个（/health、/openapi.json、/docs）。注：`routes/wiki.ts:2` 的注释自称 "15 endpoints"，实际注册 21 个（资产 7 + 源 4 + 文件 8 + 派生 2）——文档已腐。

## 3. 调用方交叉验证（谁能删、谁还在调）

**MemoryProxy（服务端）只调 KS 一个端点**：`/v3/wiki/search`。`src/knowledge/wiki-retrieve-client.ts:57` `POST ${baseUrl}/wiki/search`，`baseUrl` = **core 注册表里该资源的 `service_url`**（已含 `/v3` 前缀，`routes/wiki.ts:38` 注释），仅带 `x-tdai-service-id`（`:61`）、超时 3s（`:35`）、失败/非 0 code 一律返回 `[]`（`:66-91`，注释 "graceful degradation — recall is non-critical"）。调用方是 `injection/injectors/wiki-recall-injector.ts:265`（每个绑定 wiki 各用自己的 service_url 并行检索）。

**proxy 的 knowledge-tools 完全不 HTTP 调 KS**：`injection/injectors/knowledge-tools-injector.ts:139-176` 只是把资源渲染成 `<knowledge_tools>` + **curl 示例**（`-H 'x-tdai-service-id: …'` + 6 个 telemetry 头，`:146-159`），agent 自己执行 curl 打 `{service_url}/tools/list|call`（`:76-79`）。所以 `/v3/tools/*` 与 `/v3/wiki/*`、`/v3/code-graph/*` 的读面**是 agent 侧的网络依赖**，不是 proxy 的。

**proxy 的知识资源注册表走的是 core，不是 KS**：`src/knowledge/core-client.ts:165` `POST ${endpoint}/v3/knowledge/list`、`:232` 按 id 联查、`:266` `/v3/meta/agent-fixed-asset/list-with-detail`——都是 **tdai core（kernel）**，30s TTL + stale-if-error（`:21-34`）。KS 只是数据面，资源元数据（knowledge_id → type/wiki_id/service_url/team）存在 core。

**MemoryPanel（管理面）几乎直连全部写面**：`src/panel/kernel/adapters/http-knowledge-client.ts:94-225` 覆盖 `/v3/wiki/{create,get,ingest,sync,delete,list,update-meta,raw/*,page/*,graph,search}` + `PATCH /:id/source` + `/:id/test` + `/:id/refetch` + `/v3/code-graph/{create,list,get,sync,delete,update-meta,+查询工具}`；`src/panel/startup/ensure-knowledge-llm-binding.ts:98,153,173` 调 `/v3/internal/llm-binding/{set,list}`；`src/panel/http/routes/settings.ts:92` 转发 `/v3/admin/settings/{get,set,revectorize}`。

**dsh 插件新增面（结论）**：插件是原生工具，只需「一个查询 RPC + 极少量管理」——`/v3/wiki/search`、`/v3/wiki/page/read`|`/raw/read`、`/v3/wiki/page/ls`、`/v3/wiki/graph`，加 `/v3/tools/call` 作为统一门（省得插件实现 12 个端点映射）。写面/设置面继续留给 Panel，插件不碰。

## 4. src/mcp（401 行）是什么，能不能直接当 dsh 插件工具源

**是什么**：一个**独立 stdio 进程**（`package.json:9` bin `knowledge-mcp`→`bin/mcp.mjs`，`scripts.dev:mcp` → `tsx src/mcp/server.ts`），用 `@modelcontextprotocol/sdk` 的 `Server`+`StdioServerTransport`（`src/mcp/server.ts:1-40` 量级），把 HTTP API 包一层：
- `ListTools` 返回 `MCP_TOOLS`（`src/mcp/tools.ts:223`，**只有 12 个只读查询工具**，header `:1-11` 明说管理操作不暴露）：code-graph 8（`code_search/explore/callers/callees/impact/node/status/files`，全需 `code_graph_id`）+ wiki 4（`wiki_search/wiki_read/wiki_list/wiki_graph`，全需 `wiki_id`）。描述写得相当 agent 向（`code_explore` 自称 primary tool、`wiki_search` 解释 hybrid FTS+vector RRF 与 hop/decay/minScore）。
- `CallTool` → `callApi(httpOpts, tool.endpoint, body)`（`server.ts:60-95` 区间），透传 `{text,isError}`，否则 `JSON.stringify(data,null,2)`；异常 → `isError:true` + `Error: msg`。
- 传输客户端 `src/mcp/http-client.ts:1-70`：`POST ${baseUrl}/v3${endpoint}`，可选 `Authorization: Bearer <token>`，按 `{code,message,data}` 解包，`status>=400` 或 `code!==0` 抛错。
- 只有 `main`（`server.ts:93-107`）读 env：`KNOWLEDGE_API_URL`（默认 `http://localhost:8421`）、`KNOWLEDGE_API_TOKEN`。

**能否直接当 dsh 插件 ctx.tools 源**：**不能直接用，但能直接抄**。
- 不能的原因：① 它是**进程间**协议（stdio JSON-RPC），dsh 插件工具是**同进程** TypeScript 函数（`ctx.tools` 注册），中间再起一个 node 子进程只为转发 HTTP 是纯开销；② 工具集是 12 个固定只读，缺 `wiki_fetch`（`routes/tools.ts:78-86` 那个"未命中≠失败"的语义化读页工具，插件最需要）、缺 `raw/*`；③ 它的鉴权只有可选 Bearer，没有 per-session 概念。
- 能抄的原因：`mcp/tools.ts` 的 `name/description/inputSchema/endpoint` 四元组**就是**插件工具定义所需的形状，把 `callApi` 换成插件侧的 `fetch`（`src/mcp/http-client.ts:20-70` 一共 70 行，可直接内联）。**收益：插件侧工具层 ≈ 150 行，删掉 401 行 stdio 层。**
- 判定：`src/mcp/server.ts` D、`src/mcp/http-client.ts` D、`src/mcp/tools.ts` M（元数据迁移）。

## 5. LLM 出口：panel 把 knowledge 绑到 proxy 之后怎么改

**链路（真实代码，三段）**：
1. **Panel 推**：启动钩子 `ensureKnowledgeLlmBindings`（`MemoryPanel/src/panel/startup/ensure-knowledge-llm-binding.ts:164-195`）先 `POST /v3/internal/llm-binding/list` 缓存全部 binding（`:172-176`）；每个实例：已有 key → 只 `/set` 更新 `proxy_base_url`（`:97-105`，不传 api_key 保留原值）；无 key → 走 Gateway 造一个**隐藏计费用户** `username=knowledge-service`、`user_id=knowledge-service`（确定性 id，注释 `:132-133` 说是为了让 proxy `systemUsers` 白名单按稳定 id 命中），取 `default_user_key` 或新 mint 一把，再 `/set` 带上 key（`:121-160`）。best-effort，失败只 warn 不阻塞启动（`:186-193`）。
2. **KS 存**：`llm_binding` 表（`src/db/schema.ts:138-146`）：`service_id` 主键 + `mode`(proxy/byo) + `proxy_base_url` + `api_key` + `base_url` + `enabled` + `updated_at`，**没有 model/timeout 字段**（`store/llm-binding-store.ts:135-137` 明确：model 永远取全局 `LLM_MODEL`，单实例不存模型）。解析：`resolveLlmConfig`（`:146-191`）——无/禁用 binding → `globalDefault()`：`fallback.mode==="custom"` 原样返回，否则 `{...fallback, baseUrl:"", apiKey:""}`（**空格凭据，逼上游抛错，绝不静默直连**）；proxy 模式 → `baseUrl = ${proxy_base_url}/proxy/${serviceId}/v1`（`:167`）。装配点 `src/module.ts:169-171`。
3. **KS 用**：`createLlmClient`（`src/engines/wiki/ingest-v2/llm.ts:106-124`）按 protocol 选 `createOpenAI`/`createAnthropic`（`baseURL`+`apiKey`），缺 key 抛 `LLM apiKey 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding；或设 LLM_MODE=custom + LLM_API_KEY 走自带端点`（`:110-112`）；`normalizeLlmConfig` **已刻意不读 process.env**（`:64-66` 注释：历史 `TDAI_LLM_*` 造成"偷偷掉回直连"）。消费点：`ingest-v2/index.ts:125,312`、`manager.ts:901-902`（动态 import）、`callback.ts:158`（摘要生成）。
4. **proxy 落点**：`MemoryProxy/src/server.ts:382-387` `POST /proxy/:spaceId/v1/{messages,count_tokens,embeddings,completions,moderations}` + `/proxy/:spaceId/*` → `handleChatCompletions`。KS 发的是 `{proxy_base_url}/proxy/{service_id}/v1/chat/completions`（openai 协议）或 `/v1/messages`（anthropic）。

**改成直连 / 删 proxy 依赖要动什么**（按代价升序）：
- **方案 A（零改动，推荐）**：保留 proxy 作为"内部最小 LLM 网关"（与 proxy-handlers.md 的结论一致）。KS 侧一行不改。
- **方案 B（零代码改动，运维改动）**：`LLM_MODE=custom` + `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_PROTOCOL` 写 env——`resolveLlmConfig` 的 `globalDefault()` 当场生效（`store/llm-binding-store.ts:152-155`），不需要 TMC、不需要 panel。**注意**：这是"全局一把 key"，多实例共用一个 KS 时无法按实例隔离计费/换模型。
- **方案 C（删链，方案 B 稳定后再做）**：删 `routes/llm-binding.ts`(117) + `store/llm-binding-store.ts`(191) + `llm_binding` DDL(`schema.ts:138-146`) + `module.ts:169-171` 的 `resolveLlm` 包装（改为直接传全局 `llmConfig`）+ panel 的 `ensure-knowledge-llm-binding.ts` 启动钩子（Panel 侧）。
- **问题答案**：`/v3/internal/llm-binding` **的表与字段在方案 B/C 下可以整体删掉**——model/timeout/maxTokens 从来不在 binding 里（只覆盖 endpoint+key），删掉后能力损失只有「同 KS 多实例各用各的 key」。dsh 单机单实例，不需要这层。**保留的唯一场景**：KS 作为多租户共享服务、且计费要按实例落账。

## 6. 跨机后 knowledge 是否必须对外暴露

先厘清"谁需要连 KS"：① proxy 服务端（只有 `/v3/wiki/search`）；② Panel（管理面写操作）；③ **终端 agent**（`/v3/tools/*` + wiki/code-graph 读面，走 curl，见 §3）。第三类决定了暴露边界。

| 拓扑 | 需要监听的地址 | 必须暴露的端点 | 结论 |
|---|---|---|---|
| 同机（KS + proxy + panel + dsh 插件同一台） | `127.0.0.1:8421` | 无（仅回环） | **推荐**。agent 的 curl 打 `http://127.0.0.1:8421/v3` 即可；零公网面。前提：`KNOWLEDGE_PUBLIC_BASE_URL` 配成回环地址（它被写进资源的 `service_url`，`routes/wiki.ts:233-236`、`routes/code-graph.ts:206-211`，**只在"新建"时写一次**，改地址要重建资源）。 |
| 分机内网（KS 在服务器，开发者在笔记本） | `0.0.0.0:8421` | 读面 + `/v3/tools/*` 对内网开放即可 | **可行但必须设 `KNOWLEDGE_SERVICE_KEY`**；且要堵住 §8-2 的 `llm-binding/set` 无鉴权改写。 |
| 全公网 | — | — | **不需要，也不建议**：单把共享 service key、无 per-user 鉴权、`x-tdai-service-id` 由调用方自带 ⇒ 持 key 者可枚举他人租户。要公网必须前置反代 + mTLS/网关鉴权。 |

结论：**跨机不必须"对外"暴露，只需"对内网暴露"**；最省事的特化方向是「KS 与 dsh 插件同机回环」，此时 §8 的暴露风险全部消失，无需改代码，只需把 `KNOWLEDGE_PUBLIC_BASE_URL` 设为回环。

## 7. D / M / K 逐文件账目

### 7.1 src/（根，1,737 行）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| server.ts | 174 | M | 装配入口；要改：鉴权默认值（空 key 全开→fail-closed）、可去掉 `/docs`+swagger（`:115-126`）与 telemetry 挂载（`:72`）。连带 §2 白名单。 |
| module.ts | 438 | M | `resolveLlm` 接线（`:169-171`）随 LLM 出口方案 B/C 改；其余装配（store/instancePool/wikiMgr/reranker）原样。 |
| config.ts | 240 | M | `LLM_MODE` 默认 `proxy`（`:220`）在方案 B 后失去意义；`TMC_CALLBACK_URL`、ClickHouse（`:180-210`）、Langfuse 段在本地部署可整段删。 |
| callback.ts | 191 | M | 摄取/同步完成 → POST `TMC_CALLBACK_URL`（`:1-26`），空则全 no-op（已内建降级）。特化后 TMC 不在，改「dsh 插件轮询 status / 由插件写入本地事件」，摘要生成逻辑保留。 |
| clickhouse-telemetry.ts | 301 | D | 多租户工具调用日志（`tool_call_logs`，含 buffer/脱敏/512B 截断）。本地单机部署无 ClickHouse；连带 `server.ts:72` 挂载与 config ClickHouse 段。 |
| telemetry.ts | 87 | D | Langfuse OTel span（未配 key 静默跳过，但拖 3 个 `@langfuse/*`+`@opentelemetry/*` 依赖，见 `package.json:31-36`）。本地部署不需要；删后可摘 4 个依赖。 |
| api-helpers.ts | 209 | K | 信封/ID 校验/Row→Detail，纯工具。 |
| config-override.ts | 117 | K | `config-override.json` 读写校验，服务 admin-settings（Panel 保留即留）。 |
| codegraph-tool-names.ts | 15 | K | 单一真源；若删托管 code-graph 则连带删除。 |
| logger.ts | 52 | K | 分级日志。 |

### 7.2 src/db（347）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| client.ts | 189 | K | better-sqlite3 连接 + 建表 + 迁移。 |
| schema.ts | 158 | M | 仅 `llm_binding`（`:138-146`）随方案 C 删；其余（wiki/code_graph/audit）保留。 |

### 7.3 src/engines/wiki（2,438）+ ingest-v2（2,252）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| engines/wiki/manager.ts | 1,579 | K | 摄取/索引/查询生命周期核心；索引落 per-wiki `index.db`（FTS+page_meta+graph_edge），与流量路径无关。 |
| engines/wiki/index-db.ts | 399 | K | per-wiki SQLite 连接池 + 三表读写（`:1-20`）。 |
| engines/wiki/graph-search.ts | 91 | K | 多跳 BFS + 分数衰减（PRD AC-1/AC-5）。 |
| engines/wiki/embedding-client.ts | 113 | K | OpenAI 兼容 `{baseUrl}/embeddings`；未配置即 `vecDim=0` 降级纯 FTS（`module.ts:197-204`）——本地无向量服务也能跑。 |
| engines/wiki/filter-and-copy.ts | 115 | K | git 源按 POSIX 路径正则过滤 + 增量拷入。 |
| engines/wiki/types.ts / index.ts / content-sha.ts | 112/24/5 | K | 类型/barrel/指纹。 |
| ingest-v2/index.ts | 425 | K | 两阶段摄取入口（extract → commit），核心。 |
| ingest-v2/prompts.ts / template.ts / chunker.ts / frontmatter.ts / slug.ts / safe-path.ts | 228/96/100/102/127/21 | K | 摄取提示词与文本协议支撑。 |
| ingest-v2/file-protocol.ts | 148 | K | `<<<FILE path="…">>>` 协议解析 + 路径校验（LLM 不能自由写盘）。 |
| ingest-v2/merge.ts / cascade.ts / overview.ts / index-builder.ts / log-writer.ts | 200/229/112/129/130 | K | 合并去重（locked 页不覆盖）、删除级联、全局综述、索引重建、索引日志。 |
| ingest-v2/llm.ts | 205 | **M** | **唯一必改的引擎文件**：`normalizeLlmConfig` 已断 env 兜底（`:64-66`）、`createLlmClient` 缺 key/baseUrl 直接抛（`:108-119`）。方案 B 下靠 env 走通；若要"开箱即用"，需恢复一个**显式**的 `LLM_*` 兜底（并保留 binding 优先级），否则裸部署连 ingest 都跑不起来。 |

### 7.4 src/engines/code（255）+ 托管 code-graph 链路

判定取决于产品取舍：**dsh 插件已自带本地 codegraph 索引**（见 DSH codegraph 插件），"服务端托管 + 多租户共享 + 定时拉取"的唯一存在理由随之消失。

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| engines/code/bridge.ts | 200 | D | 把 `@colbymchenry/codegraph` 原生包包装成调用面（`:1-20`），只为托管索引服务。 |
| engines/code/normalize.ts / index.ts | 53/2 | D | 同上。 |
| routes/code-graph.ts | 363 | D | 14 个端点（6 CRUD + 8 查询动态注册 `:323-360`）。连带：`/tools` 的 `CODE_GRAPH_TOOLS` 9 项、proxy `knowledge_tools` 的 code-graph 分支、auth 白名单 8 项、`codegraph-tool-names.ts`。 |
| store/code-graph-service.ts | 398 | D | 异步编排（克隆→建图→ready/failed）。 |
| store/auto-sync-scheduler.ts | 375 | D | 服务端定时 `git pull` + 重建（`:1-30`）——**服务端主动出站**，本地部署应由插件按需触发。 |
| routes/auto-sync.ts | 47 | D | 上述调度器的 HTTP 面。 |
| （保留唯一入口）| — | — | 若仍要服务非 dsh agent（CC/CB 走 curl），则整链 K，代价是继续维护克隆+索引+并发。**建议：随 dsh 特化删，产品取舍见 §8-3。** |

### 7.5 src/store（3,425）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| store/sqlite-store.ts | 681 | K | 全部 CRUD；删 code-graph 后仅需瘦身 `code_graph*` 表与访问器（非必须，可留表）。 |
| store/wiki-service.ts | 1,254 | K | wiki 异步编排（状态机 + BuildQueue + raw/page 文件层 + 软删）。 |
| store/types.ts | 267 | K | 接口/行类型。 |
| store/build-queue.ts / serial-queue.ts / ids.ts / index.ts | 34/102/43/80 | K | wiki-service 也复用 BuildQueue/SerialQueue，非 code-graph 专属。 |
| store/code-graph-service.ts | 398 | D | 见 7.4。 |
| store/auto-sync-scheduler.ts | 375 | D | 见 7.4。 |
| store/llm-binding-store.ts | 191 | **M→D** | 方案 C 直接删（含 `resolveLlmConfig`）；方案 A/B 原样保留。 |

### 7.6 src/routes（1,968）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| routes/wiki.ts | 761 | **M** | 21 端点全部保留（内容面就是 KS 的价值），要改两处：① 鉴权从"路径白名单"改为"读面显式声明 + 写面强制 key"（与 `middleware/auth.ts` 同步）；② `service_url` 的自动落库（`:233-236`）在回环部署下改为由插件/配置提供，否则改地址必须重建资源。顺带修 `:2` 的 "15 endpoints" 腐注释。 |
| routes/tools.ts | 576 | **M** | 自发现面（`/tools/list` 元数据 + `/tools/call` 分发）是为"没有原生工具的 agent 只能 curl"设计的；dsh 插件有原生 `ctx.tools` 后，建议**保留 `/tools/call` 作为唯一查询 RPC**（插件只实现 1 个映射），把 `WIKI_TOOLS/CODE_GRAPH_TOOLS` 的元数据搬进插件工具定义。`wiki_fetch`（`:78-86`，≤4000 字符 + "未命中≠失败"）语义必须搬过去，别丢。 |
| routes/code-graph.ts | 363 | D | 见 7.4。 |
| routes/llm-binding.ts | 117 | **M→D** | 方案 C 删；方案 A/B 保留但必须补鉴权（§8-2）。 |
| routes/admin-settings.ts | 89 | K | Panel 设置页转发目标（`panel/http/routes/settings.ts:92`）；改 `llm.baseUrl` 即出站重定向，属管理面，保留但受 key 保护。 |
| routes/health.ts | 15 | K | 探活。 |

### 7.7 src/mcp（401）+ middleware（190）+ rerank（94）+ source-fetcher（269）

| 文件 | 行数 | 判定 | 理由 / 连带 |
|---|---|---|---|
| mcp/server.ts | 108 | D | stdio MCP 进程（含 `main` 读 `KNOWLEDGE_API_URL/TOKEN`）。插件同进程工具后纯属额外进程。 |
| mcp/http-client.ts | 70 | D | 70 行 HTTP 垫片，插件侧内联即可。 |
| mcp/tools.ts | 223 | M | 12 个只读工具元数据 = 插件工具定义的现成草稿；迁移后本文件删。 |
| middleware/auth.ts | 93 | **M** | 两处要改：① 空 key ⇒ 全开（`:26-35`）改 fail-closed（本地回环可显式 opt-in）；② 白名单是**纯路径**匹配（`:48-60`），`/tools/call` 全放开靠"下游只实现读工具"兜底——应改为"按工具名白名单"。 |
| middleware/response-envelope.ts / error-handler.ts | 82/15 | K | 信封与错误兜底。 |
| rerank/client.ts | 94 | M | 依赖 **core** 的 `/v1/rerank` 网关（`:1-20`，注释：内部 MaaS 无 rerank、KS 不得源码依赖 MemoryCore）。特化后要么指向 KS 本地实现的 rerank，要么保持默认关闭（`module.ts:197-199`：`rerankConfig.url` 为空即不注入，零行为变化）。 |
| source-fetcher/{git-fetcher,registry,types,index}.ts | 152/49/61/7 | K | wiki 的 git 源也要用（`/wiki/create` + `:id/refetch`）；安全防护（SSRF/路径/hooks）与流量路径无关。 |

## 8. 顺手发现的问题

1. **空 key 全开是默认态**（`middleware/auth.ts:26-35` + `server.ts:143` 只 warn）。分机部署若忘设 `KNOWLEDGE_SERVICE_KEY`，等于把 `/wiki/raw/write`、`/code-graph/delete`、`/internal/llm-binding/set`、`/admin/settings/set` 全裸奔。
2. **`/v3/internal/llm-binding/set` 可被用来窃取 LLM 凭据**（真实代码路径，不是理论）：`routes/llm-binding.ts:40-93` 无附加鉴权、只校验 `mode`；`api_key` 不传时 `upsert` 保留原值（`:67-82`）；`resolveLlmConfig` 的 proxy 模式把 `proxy_base_url` 拼成 `${…}/proxy/${serviceId}/v1`（`store/llm-binding-store.ts:167`）并带**已存的 key** 发出。⇒ 任何能打这个端点的人，把 `proxy_base_url` 指向自己的主机，KS 下一次 ingest 就会把真实 api_key 送到攻击者日志里。修法：加 key/Bearer + 白名单 `proxy_base_url` 主机 + `/set` 只允许来自 panel。同类问题在 `/v3/admin/settings/set`（`admin-settings.ts:50-72` 可写 `llm.baseUrl/apiKey`，但因 `needsRestart:true` 需要重启才生效，爆炸半径小）。
3. **`/v3/internal/llm-binding/list` 无 service-id、返回全租户**（`llm-binding.ts:103-114`）——为 Panel 启动缓存设计，但同时给了"哪个 service_id 存在"的枚举面。
4. **`/v3/wiki/search`/agent 读面公开是刻意的**（白名单 `auth.ts:48-55`），支撑 curl 直连；一旦 KS 分机后暴露到内网，就等于"内网任何人可读全部 wiki"（`wiki_id` 需知道，但 `/wiki/list` 也要公开、且只带 `team_id` 即可列举）。
5. **两个 token env 名**：KS 自己是 `KNOWLEDGE_SERVICE_KEY`（`config.ts:218`），KS 自带的 MCP 客户端读 `KNOWLEDGE_API_TOKEN`（`mcp/server.ts:93-107`）——极易配错后静默 401。
6. **腐注释**：`routes/wiki.ts:2` 写 "15 endpoints"，实际 21；`codegraph-tool-names.ts:6-7` 自认"新增工具要两处同步，否则工具表与路由/白名单漂移"。
7. **LLM 兜底被刻意删除**（`ingest-v2/llm.ts:64-66` 注释"历史上读 TDAI_LLM_*，会绕过 resolveLlmConfig，造成'偷偷掉回直连'"）。⇒ 今天一个**没跑过 panel** 的裸 KS 无法 ingest，报错文本虽友好（`:110-112`）但运维必须先去 Panel 或 curl `/set`。这就是 §5 方案 B 存在的理由。
8. **`/v3/wiki/search` 的失败语义是静默**：`wikiCanServeReads` 假 → 200 `{results:[]}`（`wiki.ts:725-727`）；proxy 侧非 0 code/非数组也返回 `[]`（`wiki-retrieve-client.ts:66-73`）。召回全灭时日志只有 debug 级一行，**线上"没召回"和"召回为空"不可区分**。
9. **code-graph 查询把业务错误映射成 HTTP 500**（`routes/code-graph.ts:357-358`：`wrapOk(result), result.isError ? 500 : 200`）——信封 `code=0` 但状态码 500，两套语义混用；`/tools/call` 同类错误走的是 200+`isError`（`routes/tools.ts:259` 起）。
10. **`service_url` 只在新建时写**（`wiki.ts:233-236`、`code-graph.ts:206-211`）：KS 换域名/端口后，core 里的旧 URL 不会自动更新，proxy 的 wiki-recall 会静默打到旧地址（3s 超时 → `[]`）。运维坑。
11. **`x-tdai-service-id` 由调用方自带**（`wiki.ts:697-703` 等）：没有"token→租户"绑定，持 key 者可冒充任意租户读写。单租户/回环部署无影响，多租户共享时才致命。
12. **`/docs` + `/openapi.json` 无鉴权且在前缀外**（`server.ts:115-126`）：暴露完整 API 面给扫描器。

## 9. 执行顺序建议

1. **先定 code-graph 去留**（省 ~1,340 行 + 9 个工具面 + 375 行调度器）。若 dsh 插件已自带本地 codegraph，这是最大一笔删减；同时决定 `codegraph-tool-names.ts` / auth 白名单 8 项 / proxy `<knowledge>` 的 code-graph 分支是否一并下线。
2. **再收鉴权（安全项，独立于 1）**：`middleware/auth.ts` 改 fail-closed + 按工具名白名单；`/internal/llm-binding/*` 与 `/admin/settings/*` 加保护或仅在 panel 网段可达；顺手关 `/docs`。这一步不改任何业务语义，可先合。
3. **LLM 出口二选一**：保留 proxy 内部网关（A，零改动）或 `LLM_MODE=custom`（B，零代码改动）。**只有**确定不再需要"多实例各自计费"时才做 C（删 binding 表/端点/panel 钩子，308 行）。
4. **删 MCP stdio 层，把 `mcp/tools.ts` 元数据搬成 dsh 插件工具**（含 `wiki_fetch` 语义）；插件只实现 `/tools/call` 一个 RPC 或直连 4-5 个读端点。
5. **最后收暴露面**：默认回环部署（`KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3`），需要分机时设 `KNOWLEDGE_SERVICE_KEY` 并只开读面；不建议公网直挂。
