# dsh 特化：全仓删改账目（LLM 流量不过代理之后）

- 日期：2026-10-31
- 前提方案：docs/specs/2026-10-31-dsh-native-memory-plugin-spec.md（dsh 插件 + 服务端记忆控制面）
- 判定口径：**D 删** = 唯一存在理由是「LLM 流量经过我们 / 多端协议适配 / 未鉴权就地转发」；**M 改** = 逻辑仍有价值但入口或契约变了；**K 留** = 与流量路径无关。
- 分卷：core.md（MemoryCore）｜panel.md（MemoryPanel）｜knowledge.md（MemoryKnowledge）｜proxy-handlers.md（handler 家族六个文件）｜proxy-session-tdai.md（session + tdai + mem-command + agent-adapters）｜proxy-ops-deploy.md（MemoryProxy 残项 + deploy + sdk + agents + scripts）

## 0. 一条决定全局的边界裁决：控制面留在 MemoryProxy，不搬进 MemoryCore

插件只能认识**一个**地址。所以对外只有一个控制面，内部再分：

```
dsh 插件 --HTTPS--> 控制面（原 MemoryProxy，改名 MemoryControlPlane） --回环--> MemoryCore
                          |                                              |
                          +--> MemoryKnowledge（wiki / code-graph）        +--> SQLite / Vector
                          +--> ClickHouse / Langfuse / Opik（观测）
```

为什么不让 Core 直接当控制面：
- 注入装配、会话状态机、块缓存、meta 客户端、tdai 客户端都在 proxy 侧已经成形（injectors 3,790 行 + session 核心 3,914 行 + storage/db 2,603 行），搬进 core 等于把 1 万行挪进一个 16.6 万行的仓库，回归面不可控。
- proxy→core 是**同机回环**（deploy 里 8420 不对外），多这一跳的代价约 1ms，换来的是 core 一行不动就能先跑起来。
- 后续若要去掉这个进程（Phase 5 可选），core 只需要吸收「块装配 + 会话状态」两层，接口不变，属于纯搬家。

## 1. 总量

| 模块 | 非测试行数 | 性质 |
|---|---|---|
| MemoryCore | 165,998 | 记忆本体（L0→L3、召回、画像、判分、资产元数据、gateway） |
| MemoryProxy | 53,488 | 今日的 LLM 代理；改造后只剩控制面 |
| MemoryPanel | 46,580 | 管控台（team/user/agent/task + 四类资产 + 观测页） |
| MemoryKnowledge | 13,712 | wiki / code-graph 服务 |
| sdk | 3,963 | 见 proxy-ops-deploy.md |
| agents | 2,529 | 各端接入文档（含 dsh README 469 行） |
| 合计 | ≈287,000 | |

## 2. 读法

先看六份分卷的 D 表（逐文件、带 路径:行号），再看本文件 §3 的反向依赖、§4 的合并总账与 §5 的执行顺序。

## 3. 一个必须先解决的反向依赖：proxy 不只是「Agent 的网关」，它还是**内部三个服务的 LLM 出口**

这条如果漏了，删完 handler 会当天炸线上。证据（全部来自真实代码）：

| 调用方 | 证据 | 形态 |
|---|---|---|
| MemoryCore | MemoryCore/src/gateway/llm-resolver.ts:7-11、91（`${cleanBase}/proxy/${instanceId}/v1`）、MemoryCore/src/adapters/standalone/llm-provider-resolver.ts:7 同款第二份；消费点 MemoryCore/src/core/tdai-core.ts:636/987/1037/1082（注释自述四个接入点） | 内核所有 LLM 调用（抽取、offload、判分）可配 `llm.provider=proxy`，走 proxy 的 legacy `/proxy/:spaceId/*` 路由与 sk-mem-* 身份 |
| MemoryPanel | MemoryPanel/src/panel/config/panel-config.ts:82/86（`KNOWLEDGE_LLM_PROXY_BASE_URL`、`LLM_PROVIDER_PROXY_BASE_URL` 默认 `http://127.0.0.1:8096`）、startup/ensure-knowledge-llm-binding.ts:100/155（写 `proxy_base_url`） | Panel 把 **Knowledge 的 LLM base** 绑到 proxy，并把 `/v3/admin/llm-providers`、`/v3/admin/credit-pricing` 透传给 proxy |
| MemoryKnowledge | 同上（被绑定方） | wiki / code-graph 的 LLM 调用实际打到 proxy |

**含义**：删掉 LLM 转发并非「只影响 Agent 接入」，而是会切断 core / panel / knowledge 自身的模型调用。两条出路：

- **M1（推荐，最小改动）**：保留一个**内部专用最小网关**——只留 OpenAI 兼容 `/v1/chat/completions` + 现有 `llm-providers` 凭据解析 + credit 计费，绑回环、只接受内部身份；删掉全部 Agent 协议层（chat 会话注入 / anthropic / codex / workbuddy / aux / 系统用户旁路 / marker / legacy 路由）。规模约 500~700 行，而不是 8,851 行。
- **M2（更彻底）**：三个服务各自直连上游（各自持 key），proxy 只保留控制面。代价：凭据从一个 SoT 散成三份，与 ADR-0006 冲突；跨服务的 credit 归集断裂。**不推荐**。

所以最终删除账目要按 M1 口径修正：`handler.ts` 里的会话/注入/转发主体删，但「凭据解析 + 计费 + OpenAI 兼容转发骨架」保留（约 550 行），anthropic/codex/workbuddy/aux/systemUserPassthrough **整文件删**。


## 4. 合并总账

口径统一为 M1（保留内部最小 LLM 网关）。各服务的逐文件证据在分卷里，这里只汇总。

| 服务 | 非测试行数 | D 删 | M 改 | K 留 | 分卷 |
|---|---|---|---|---|---|
| MemoryProxy | 53,488 | **≈20,700（38.7%）** | ≈3,900 | ≈28,900 | proxy-handlers.md / proxy-session-tdai.md / proxy-ops-deploy.md |
| 合计 | ≈288,000 | **≈23,400（8.1%）** | ≈11,900 | ≈252,000 | — |
| MemoryCore | 165,998 | **≈216**（+15,359 条件项） | ≈3,500 | 余下全部 | core.md |
| MemoryPanel | 46,580 | **510** | ≈1,000 | 8 个页面目录 | panel.md |
| MemoryKnowledge | 13,463（不含测试） | **2,004（14.9%）** | 3,461 | 7,998 | knowledge.md |
| sdk | 8,902（含测试） | 0 | 0 | 全部（打的是 /v3，不经 proxy） | proxy-ops-deploy.md §5 |
| agents | 2,529 | 0（但 `agents/dsh/README.md` 469 行里约一半段落失效需重写） | — | — | proxy-ops-deploy.md §5 |

### 4.1 MemoryProxy 的 20,700 行构成（逐块可独立提交）

| 块 | 行数 | 分卷依据 |
|---|---|---|
| handler 家族（anthropic 2,390 / codex 1,447 / workbuddy 1,475 / aux 303 / systemUserPassthrough 715 / handler.ts 主体 2,045） | 8,375 | proxy-handlers.md；handler.ts 保留 ~470 行网关骨架（凭据 + 计费 + 单次转发 + usage 抽取） |
| 表单 + 分页（7 个 form.ts 3,807 + 2 个 pagination 198） | 4,005 | proxy-session-tdai.md §1；留 FormSpec 契约不留代码 |
| 各端解析器 / 状态机（5 个 extractor+cleaner 1,781 + claude-code/init 1,204 + codex barrel 18） | 3,003 | proxy-session-tdai.md §2 |
| 桥接层（skill-bridge 1,097 + handler-glue 174 + memory-bridge 517 + bridge-telemetry 136） | 1,924 | proxy-ops-deploy.md §1 |
| mem-command 文本层（parser 138 + help 89 + response-builder 284 + task-draft-generator 632） | 1,143 | proxy-session-tdai.md §5 |
| agent-adapters（9 文件） | 848 | proxy-session-tdai.md §6 |
| skill/normalize-conversation.ts | 563 | proxy-ops-deploy.md §1 |
| rate-limit（redis-store 326 + usage 32 + guard 138） | 496 | 改会话级计数后 Lua 滑动窗口与输入 token 计量都无用 |
| routes/whitelist.ts | 281 | 只服务上游转发与 aux 分派 |
| turnSeq.ts | 55 | 改服务端 INCR 分配 |
| 合计 | **20,693** | |

### 4.2 三个服务的 D 都很少，这不是巧合

- **Core 的 D 只有 ≈216 行**（`/v2` 双前缀 17 + 16 条 deprecated entity 路由 24 + `x-tdai-*` header 兜底 60 + `/v3/soul/introspect` 115 候选）。它是记忆内容真源，不是协议中间人——**这恰好证明 proxy 那 2 万行删得掉，而 core 不用动**。
- **Panel 只删 1 个页面 + 1 条透传路由（510 行）**，因为管控台本来就是 core 的直连客户端（`/v3/meta|atomic|core-memory|wiki|conversation|skill` 全直连），不是 proxy 客户端。而且点名的五类「代理运维页」（会话初始化日志 / 注入排查 / cost-guard / 限流 / 按请求 token 看板）**在 Panel 里一页都不存在**，删页面不是工作量，真正要做的是**身份契约换血**（user_key → tm_ token、7 端向导砍成 1 端）。
- **Knowledge 的 LLM 出口是被 Panel 绑到 proxy 的**（`ensure-knowledge-llm-binding.ts:100/155` 写 `proxy_base_url`），它自己完全不认识 proxy——所以这一条改的是绑定配置，不是 knowledge 的代码。

## 5. 执行顺序（顺序错了会炸，按这个来）

| 步 | 动作 | 为什么必须在这个位置 |
|---|---|---|
| 0 | 解反向依赖：core `llm-resolver.ts:91` 的 `provider=proxy`、Panel `panel-config.ts:82/86` + `ensure-knowledge-llm-binding.ts:100/155` 的 `proxy_base_url` 改直连或改指 M1 网关 | 不先做，删 handler 会连带打死 core 的 L1/L2/L3 抽取（`tdai-core.ts:636/987/1037/1082` 四个接入点）与 knowledge 的全部 LLM 调用 |
| 1 | 先给 `/v3/conversation/add` 加 `client_turn_id` + core 侧 `UNIQUE(session_key, client_turn_id)` | 现在 `record_id` 是服务端 `msg-${randomUUID()}`（`v2-router.ts:852`），10 分钟内容去重又只在 sqlite 实现——双写期重试必产生重复行、换 TCVDB 后去重静默失效 |
| 2 | 在 core 侧长出 `/v3/dsh/{handshake,session/answer,context,turn/end,tools/*}`，全部复用现有 handler 体（`/v3/recall` → `handleRecall` `v2-router.ts:1894`；`turn/end` → `handleConversationAdd` `v2-router.ts:789`） | 控制面需要的鉴权/隔离/store 全在 `V2RouterDeps`（`v2-router.ts:294`），从零写会重造隔离。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点） |
| 3 | 插件接入并灰度，与旧链路**双跑**；核对「L0 新增行数 == 回合数」而不是「== LLM 调用次数」 | 这是插件化唯一定量验收口径。现状实测：DSH 里一次「继续」被记成 12 条（`v2-router.ts:874-876` 注释） |
| 4 | Caddy / ingress 只放行 `/v3/dsh/*`（+`/health`），其余 404，观察 7 天 | `deploy/tencent-cloud/Caddyfile.template:7-9` 现在是整站 `reverse_proxy proxy:8096`；没有这 7 天证据，`/v2` 双前缀与 16 条 entity 路由不敢删。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点） |
| 5 | 按 §4.1 自上而下删 proxy（每块可独立提交、独立回滚）；再删 core 的 `/v2` 与 entity 表；最后单独决策 offload 15,359 行去留 | 前面各块的 import 关系已被分卷列出（`extractSseUsage` ← `systemUserPassthrough.ts:49`、`joinUrl` ← 4 处、`handleSystemUserPassthrough` ← 3 处），顺序反了会删出编译不过的半成品 |

**三个必踩的坑**（都写在分卷的不确定清单里）：

1. `provider=proxy` 只改了 baseUrl 还不够——core 的 extraction 与 embedding 是两套配置，要分别验证（core.md §6-5）。
2. Panel 直读 core 的 recall journal **日志目录**（`MemoryPanel/src/panel/http/routes/chat-memory.ts:51-70`、路由 `:3132-3208`），跨机部署第一个炸的就是它。
3. `/v3/dsh/*` 全仓 grep 0 命中——**所有 D 清单都是目标态推演**，插件侧 handshake / turn-end 契约落地之前不能真删，否则 L0 写入当天断流（proxy-handlers.md 不确定项 4）。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）。


### 4.3 MemoryKnowledge 的 2,004 行是两件事

| 块 | 行数 | 为什么删 |
|---|---|---|
| 托管 code-graph 整链（engines/code 255 + routes/code-graph 363 + store/code-graph-service 398 + store/auto-sync-scheduler 375 + routes/auto-sync 47） | 1,438 | dsh 自带本地 codegraph 索引（本仓根目录就有 `.codegraph/`），服务端再托管一套是重复；且这套的暴露面是「把 curl 塞进 prompt 让 agent 自己打」 |
| MCP stdio 垫片（mcp/server 108 + mcp/http-client 70） | 178 | 它只是把 12 个查询工具转成 HTTP 打自己；dsh 插件用 `ctx.tools` 直连 `/v3/tools/call` 即可，stdio 传输在插件模型下没有位置 |
| 遥测（clickhouse-telemetry 301 + telemetry(langfuse) 87） | 388 | 与 proxy 的 ClickHouse/Langfuse 重复记一遍；统一到控制面一处 |
| 合计 | **2,004** | |

## 6. 需要拍板的六件事（代码层面已备好两套答案）

| # | 决策 | 选项 A | 选项 B | 影响面 |
|---|---|---|---|---|
| 1 | LLM 出口形态 | **M1 保留内部最小网关（推荐）**：proxy 留 ~470 行 OpenAI 兼容网关，凭据 SoT 不变 | M2 三个服务各自直连上游 | M1 删 8,375 行；M2 删 8,845 行但凭据散三份、违 ADR-0006、credit 归集断裂 |
| 2 | 托管 code-graph 去留 | A：删（dsh 自带本地索引），省 1,438 行 + 9 个工具面 | B：留（若还要服务仍在用 curl 直连的 CC/CB） | knowledge 的 D 从 2,004 掉到 566 或反弹回 0 |
| 3 | 上下文压缩归属 | A：dsh 插件接管（`agent/pre-step` 有对应钩子），offload 三块改接钩子 | B：不接管 | `offload` 10,455 + `offload_server` 4,904 + `offload-client` 1,163 = **15,359 行整体 D** |
| 4 | `mem:create-task/update-task` 是否下沉 | A：dsh slash 命令自己实现二次确认，服务端 pending-store（95 行）删 | B：留服务端两阶段确认 | 影响 226+216 行命令 + 95 行 pending-store；dsh slash 是否支持二次交互**未验证** |
| 5 | credit 自报口径 | A：只做配额/看板，加 `source=client_reported`，不再调 `/UpdateMemoryPlusUsage` | B：仍上报（会污染 Ark 账单口径，且代码里没有 source 字段） | `credit-reporter.ts` 342 行的去留与 ClickHouse `usage_raw` 的 5 个 reason 只剩 2 个 |
| 6 | Panel 新增哪些页 | 最小 4+1：设备与会话（epoch/撤销 40901）、上下文装配诊断、Outbox 与回写、回合与用量、可选知识可见性 | 不加，先用日志 | Panel 现有 8 个页面一页都不用删，是**新增**而不是删除 |

## 7. 分机部署前必须先堵的安全口（实测，不是推测）

| 位置 | 问题 | 处置 |
|---|---|---|
| `MemoryKnowledge/src/routes/llm-binding.ts:40-93` + `store/llm-binding-store.ts:167` | **无鉴权即可窃取 LLM 凭据**：`/v3/internal/llm-binding/set` 只校验 mode，`api_key` 不传则保留原值，把 `proxy_base_url` 指向攻击者主机后，knowledge 下次 ingest 就把真实 key 发过去 | 走 M1 后这套 binding 链（117+191+DDL+panel 钩子）**整体删**最干净；若要留，必须先加鉴权 |
| `MemoryKnowledge/src/middleware/auth.ts:26-35` + `server.ts:143` | `KNOWLEDGE_SERVICE_KEY` 为空 ⇒ 45 个 `/v3` 端点全裸，启动只打一行 warn；白名单是纯路径匹配，`/tools/call` 整条放开 | 生产强制非空 + 启动 fail-fast |
| `MemoryProxy/src/skill/skill-bridge.ts`、`memory/memory-bridge.ts` | 两个桥接是**未鉴权公开 POST**，只凭 `x-conversation-id` + `x-tdai-service-id` 就由 proxy 盖章身份 | 本次改造整体删除（1,924 行），问题随之消失 |
| `MemoryProxy/src/routes/session-refresh.ts:238`、`routes/session-force-archive.ts:236` | 注释都写「走 admin auth」，handler 体内**没有** `checkAdminAuth` 调用（`admin-auth.ts:7` 全仓只被 `instance-destroy.ts:69` 使用） | 保留这两个运维口就必须补鉴权 |
| `MemoryPanel/src/panel/http/routes/settings.ts:130` | 注释自述「内网信任、不注入鉴权头」 | 控制面公网化后必失效，需补 |

