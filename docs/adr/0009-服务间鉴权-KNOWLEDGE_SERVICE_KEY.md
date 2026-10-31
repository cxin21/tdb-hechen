# ADR-0009 服务间鉴权：KNOWLEDGE_SERVICE_KEY fail-closed

- **状态**：已接受（2026-10-26，issue #115 实施）
- **关联**：#115（fix(knowledge): 知识服务写/管理面缺入站鉴权）；上游 TencentCloud/TencentDB-Agent-Memory 分支 `feat/server_team` 的 `MemoryKnowledge/src/middleware/auth.ts`（本决策以其为起点，但白名单口径与之不同，见下）
- **域词典**：[CONTEXT.md](../../CONTEXT.md) → 服务间鉴权（service key）

## 背景

KS（MemoryKnowledge）把 `/v3` 挂在对外暴露的端口上，写/管理面此前**没有任何入站鉴权**：任何能连到该端口的调用方都能 ingest/sync/delete 知识库、改写 wiki 原始页与页面、创建/删除 code-graph、读取 `/v3/internal/llm-binding/*`（暴露 binding 存在性与 base_url），以及通过 `/v3/admin/settings/*` 读取/改写向量库设置。租户维度只有自报的 `x-tdai-service-id`，属于内网信任模型，不构成身份。

上游 `feat/server_team` 已引入 `KNOWLEDGE_SERVICE_KEY` 的 Bearer 校验（key 空=不启用；非空=除只读白名单外一律 401）。本仓 0 处引用该变量，属于能力缺口（issue #115）。同时上游白名单只列了 `/code-graph/list` 与 `/code-graph/get`，**漏掉了本仓 code-graph 动态注册的 8 个只读查询端点**（`search`/`explore`/`callers`/`callees`/`impact`/`node`/`status`/`files`，`src/routes/code-graph.ts` 动态注册、`src/mcp/tools.ts` 的 12 个 MCP 工具正是转发到它们），启用 key 后 Agent/MCP 查询面会被误伤 401，与本票验收「查询不受影响」直接冲突。

## 决定

1. **鉴权模型（三态）**：`KNOWLEDGE_SERVICE_KEY` 为空 → **不启用**，全部放行（保持内网信任模型，向后兼容本地/开发部署）；等于占位符 `REPLACE_ME` → 由部署脚本视为未设置并自动生成（该特判只在 `deploy/global-images/_lib.sh` 的 `ensure_knowledge_service_key`，应用进程本身不特判：直接把 `REPLACE_ME` 设进 KS 环境会被当成普通非空 key）；非空 → **除只读白名单外的 `/v3` 端点必须带 `Authorization: Bearer <key>`**，缺失或错误一律 401（fail-closed）。`/health`、`/docs`、`/openapi.json` 挂在 `/v3` 之外，保持开放。
2. **只读白名单口径 = Agent 查询面**：`POST /tools/list`、`POST /tools/call`、`POST /wiki/{get,list,search,graph,raw/ls,raw/read,page/ls,page/read}`、`POST /code-graph/{list,get}` **与 8 个动态只读查询**、`GET /auto-sync/status`。写/管理面（wiki ingest/sync/delete/update-meta/create、raw|page write|rm、`PATCH /wiki/:id/source`、`POST /wiki/:id/{test,refetch}`、`DELETE /wiki/:id`、code-graph create/update-meta/sync/delete、`/v3/internal/llm-binding/*`、`/v3/admin/settings/*`、`POST /auto-sync/trigger`）一律需要 key。**本仓相对上游补齐了 8 个 code-graph 动态查询**（上游启用 key 会让它们 401）。
3. **真相源边界**：code-graph 动态查询名提到零依赖叶子模块 `MemoryKnowledge/src/codegraph-tool-names.ts`，路由注册（`src/routes/code-graph.ts` 的循环）、工具名映射（`toCodeGraphToolName` 校验）与鉴权只读白名单共用这一份。边界之外仍是手写：`src/routes/tools.ts` 的 `CODE_GRAPH_TOOLS`（描述/参数 schema 等 MCP 工具元数据）不由此生成，新增或改名工具需要两处同步——两者漂移是已知代价，换来鉴权侧不必经 `routes/tools.js` 把 store/engines（better-sqlite3 原生依赖）拖进依赖链。
4. **护栏（真实路由表回归）**：新增 `tests/service-auth-route-guard.test.ts`，静态还原真实 `/v3` 路由清单后断言——每个端点都被归类（只读白名单 ∪ 显式写端点清单）、写端点与白名单互斥、白名单无死条目、24 条写端点逐条真实路径无 Bearer → 401 / 带正确 Bearer → 200、只读端点免鉴权、未知新端点默认 fail-closed、`/tools/call` 工具表不得出现写工具。目的：新增端点时若未登记即测试变红，避免白名单与真实路由漂移。
5. **密钥传播与生成**：同一把 key 三侧使用——校验侧 `KNOWLEDGE_SERVICE_KEY`（KS 进程）、Panel 调用侧 `KNOWLEDGE_AUTH_TOKEN`、MCP 侧 `KNOWLEDGE_API_TOKEN`。部署脚本 `deploy/global-images/_lib.sh:ensure_knowledge_service_key` 在 `.env` 缺省时生成 `ks-svc-<hex48>`（`openssl rand -hex 24`，无 openssl 走 `/dev/urandom`）并幂等回写 `.env`，`start-memory-hub.sh` 把同一个值分两路注入容器；`deploy/panel-knowledge-combined/start-combined.sh` 让 Panel 侧 `KNOWLEDGE_AUTH_TOKEN` 回落 `KNOWLEDGE_SERVICE_KEY`（只设一侧也生效）。
6. **配置类型复用**：`ServiceConfig.auth` 用命名导出接口 `KnowledgeAuthConfig`（与 `LlmConfig`/`RerankConfig` 一致），鉴权中间件以 `import type` 引用，运行时零耦合。

## 理由

- **为什么 key 空=不启用**：KS 是共享组件，很多开发/单机部署没有 key 概念；强制要求会打断既有部署流。可用「未设置 = 敞开，但启动日志显式 warn（`Service auth: DISABLED …`）」来承担风险披露，部署脚本则保证共享/生产路径自动生成 key。
- **为什么 fail-closed**：鉴权中间件的默认姿态必须是拒绝；只在显式白名单上开口。未知新端点默认受保护，避免「忘记加白名单」变成静默的写入口。
- **为什么白名单按查询面而非按 CRUD 判定**：KS 的只读面是 Agent 直连面（tools/call 与 code-graph 查询是 MCP 工具的落点），收紧它会打断 Agent 自主查询；写面则只由 Panel 与运维脚本调用，一律带 key。
- **为什么补齐上游的 8 个查询端点**：它们是只读查询的事实标准（`src/mcp/tools.ts` 直接转发），上游白名单是覆盖不全而非有意收紧；本仓以「查询不受影响」为验收口径，故以更完整的事实为准。

## 后果

- 启用 key 后，未带 Bearer 的历史调用脚本会收到 401；只读面不受影响，Panel 与 MCP 侧按第 5 条传 key 即可。
- `/docs` 与 `/openapi.json` 仍公开（issue #115 验收未要求关闭）；若要一并收紧需另开票。
- `safeEqual` 是仓内第 4 份常量时间比较实现。既有 3 处**secret 字符串**比较：`MemoryCore/src/gateway/server.ts:329`、`MemoryCore/src/metadata/system-user.ts:28`、`MemoryProxy/src/routes/admin-auth.ts:19`（`checkAdminAuth` 的比较行，长度差在 `:18` 直接返回；均来自初始导入提交 `d32930c`，早于 #115）；本仓 `MemoryKnowledge/src/middleware/auth.ts:33`（`safeEqual`）是第 4 处。（`MemoryCore/src/metadata/utils/crypto.ts:159` 用 `timingSafeEqual` 校验 scrypt 口令哈希，用途不同，不计入。）各实现分支形状已有差异：上述 3 处长度不等时直接返回/短路，本仓保留「长度不等 → 先 `timingSafeEqual(ba, ba)` 自比再返回 false」，使两条分支的耗时形状一致、不泄露长度。本仓无跨包共享工具包，暂不抽公共包，记为后续可做项（漂移风险：4 份实现口径已开始分叉）。
- `MemoryKnowledge/openapi.yaml` 未加 `securitySchemes`（上游同）；鉴权口径以 `MemoryKnowledge/v3-api-memoryknowledge-doc.md` §1.3 为准。
- 云端部署模板 `deploy/tencent-cloud/config/knowledge/env.cloud.template` 仍需人工填入 key（留空即不启用），已在模板中就地说明。
- 鉴权契约分散在六处：`MemoryKnowledge/.env.example`、`MemoryKnowledge/README.md`、`deploy/global-images/.env.example`、`deploy/panel-knowledge-combined`/`deploy/global-images` 的 README、`deploy/tencent-cloud/config/env.example` 与 `deploy/tencent-cloud/config/knowledge/env.cloud.template`（后两者为 systemd 腿，2026-10-31 补，见 #132），存在文案漂移风险；后续可考虑由单一文档生成。
