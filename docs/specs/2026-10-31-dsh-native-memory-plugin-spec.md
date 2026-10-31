# dsh 原生记忆插件（跨机）— 规格

- 状态：草稿（待评审）
- 日期：2026-10-31
- 范围：只支持 DeepSeek Harness（下称 dsh）一个客户端；dsh 与 tdb 服务跨机部署
- 关联：ADR-0006（LLM 凭据 SoT）、ADR-0009（服务间鉴权）、ADR-0017（资产读授权口径）、ADR-0018（上游同步边界）
- 决策记录建议：新增 ADR-0019「dsh 原生插件 = 记忆控制面，LLM 流量不过代理」

## 实测更正（2026-11-01，证据 docs/ops/dsh-plugin-probe-report.md）

本节是**唯一**的更正口径：下文（尤其 §2、§3、§4）保留原假设作为演进记录，凡与本节冲突处以本节为准。证据两路：宿主内 headless 实测（`docs/ops/dsh-plugin-probe-report.md` §2/§3）、本机核心活体冒烟（`dsh-plugin/scripts/smoke-v3.mjs`，`cd dsh-plugin && npm run smoke:v3`）。

| # | 原文假设（已证伪 / 需改写） | 实测 | 更正后的口径 |
|---|---|---|---|
| 1 | §4「volatile 块只追加、**不入历史**」 | pre-step 追加的消息**落盘为 `user/message` 会话事件**（probe 报告 §2「注入消息持久化」、§3-3；实测 seq 12/22 各一条，后续 step/turn 仍在历史里） | volatile 是**耐久注入**：按（sessionId, turnId）去重、每轮只注入一次，并按 ttlTurns 停止新增；不能再假设它「本回合可见、下回合消失」 |
| 2 | §3「`agent/assistant-stream` 的 end 帧带 usage」 | `end` 帧 keys 只有 `["type","attemptId","revision","index","outcome"]`，`usage: null`（probe 报告 §2、§3-2） | usage 真源是 `ctx.on('session/event')` 的 `assistant/message` 事件里的 `data.usage`（inputTokens / outputTokens / totalTokens） |
| 3 | §3 `agent/session-start({ agent, source })`，source ∈ startup / clear / compact | 该事件在此构建里**不存在**：注册不报错但三次运行一次都没触发（probe 报告 §2、§3-1） | 会话开始用 `agent/created { agent, source, signal }`；head pack 走 `ctx.systemPrompt.section(...)`（order 取 `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`+100 = 10300，text 用函数按当前会话状态重算），「compact 后重取」由该函数重算实现 |
| 4 | §2 新增 `/v3/dsh/{handshake,session/answer,context,turn/end,tools/*}` 控制面端点 | 这些端点**全仓 0 命中**（`docs/specs/2026-10-31-dsh-specialization-audit/README.md:109`、`proxy-handlers.md:168`） | v0 插件**不新建端点**，直接复用已有 v3 数据面：`POST /v3/core/read`（L3 persona）、`POST /v3/atomic/search`（L1 召回）、`POST /v3/scenario/ls`（L2 索引）、`POST /v3/conversation/add`（L0 回写，配 `/v3/conversation/delete` 清理） |

更正后的线格式与隔离约束（实测，插件与冒烟脚本共用）：

- 请求头：`authorization: Bearer <apiKey>` + `x-tdai-service-id: <serviceId>` + `content-type: application/json`；apiKey 取 `MemoryCore/tdai-gateway.yaml` 的 `server.apiKey`（填 `'local'` 会 401）。
- 请求体：隔离字段 snake_case `team_id` / `agent_id` / `user_id`；`/v3` 严格校验三元组（缺一 422，`MemoryCore/src/gateway/v2-router.ts:189-193`），`session_id` 在数据面可选。信封 `{ code, message, request_id, data }`，`code !== 0` 即失败。
- 写面硬约束（`MemoryCore/src/gateway/generated/schemas.ts:82-98`、`v2-schemas.ts:115-121`）：`content` 必须是单个非空字符串且 ≤ 8192，`timestamp` 必须是 ISO 字符串（否则整批 400）；`conversation/add` 的 `session_id` schema 上有兼容缺省桶，插件**必须显式给**，否则 L0 落进 default 桶。
- 本机实测读数（2026-11-01，`smoke-v3.mjs` 真跑三次）：core/read 200 / 32–36ms / 10003 chars（首行 `# User Narrative Profile`）、scenario/ls 200 / 5–6ms / 14 entries、atomic/search 200 / 5 hits、conversation/add 200 / accepted_ids=2、conversation/delete 200 / deleted_count=2 / 38–47ms。**atomic/search 冷热差取决于核心空闲时长**：服务端刚被访问过时首查 422–6394ms 之间大幅波动（最近一次空闲后首查 6394ms，热查 47ms；进程刚热时二次运行 44/40ms），别把单次冷值当 SLA。

## Problem Statement

今天的 tdb 记忆系统是一个 **LLM 协议代理**：dsh 把 baseURL 指到 https://<网关>/{agent}/{spaceId}，代理在 HTTP 层做三件事——伪造会话初始化表单、把记忆块拼进 system/messages、把 assistant 回复切出来回写 L0。这套设计对**同机**是划算的：代理挨着 core（回环一次 RTT 约 1ms），能用最低成本拿到完整请求与响应。

跨机之后成本结构反转。按 deploy/tencent-cloud/DEPLOY.md 的实际拓扑，dsh 在用户机器，唯一公网入口是 Caddy 443 → Proxy 8096，core 8420 / knowledge 8421 / panel 8123 只在安全组内网。于是：

1. **LLM 流量被迫绕路**：用户的每一次模型调用（含每个 tool-loop 子请求）都要先跨境/跨运营商到云上代理，再回源到火山 Ark。代理本身不产生任何 token 价值，纯粹是延迟与故障点。
2. **代理能力全用在「翻译」上**：为了在别人的协议里塞进记忆，代码里堆了六端表单构造器、Anthropic/OpenAI 双适配器、SSE tap、thinking 块占位、tools.before_call 搭便车、mem: 文本命令解析……非测试代码 53,524 行里，真正与记忆内容相关的部分不到 1 万行。
3. **模型直连的收益全丢**：dsh 的 provider 侧优化（连接复用、区域就近、供应商自带 KV cache 命中）被中间一跳抵消；代理为了插块还必须改动 system 前缀，反而更容易打碎上游 KV cache。
4. **状态语义只能靠猜**：turnSeq 靠数消息历史推（countHumanTurns 排除 system-reminder）、sessionKey 靠 header 指纹推、L0 写入没有幂等键只能接受重复。这些「猜」在同机低延迟下勉强可用，跨机后一旦重试/乱序就会放大成脏数据。
5. **安全面被放大**：/skill-bridge/* 与 /memory-bridge/* 是**未鉴权**的公网 POST，只凭 x-conversation-id + x-tdai-service-id 就盖章身份并以该用户身份驱动 core；memory-bridge 还接受调用方自带的 session_id。同机时这算内网便利，跨机公网暴露后是真实越权面。

结论：跨机场景下「代理 LLM」是负债而不是资产。dsh 已经是一个有插件体系（cordis + dsh-tools / dsh-commands / dsh-session（event-sourced）/ dsh-agent-instructions / dsh-plugin-manager）的宿主，正确的形态是把记忆从「协议中间人」改成「**宿主内的插件 + 服务端控制面**」：LLM 直连模型，插件在回合头取上下文、回合尾推回写、工具调用按需检索。

## Solution

**一句话**：dsh 直连模型；新增一个 dsh 插件（@tdb/agemem-dsh）与一组**记忆控制面 API**（/v3/dsh/*，挂在现有 Proxy 进程上，公网只经 Caddy 443 暴露），把原来「改 body」的三件事变成「取块 / 报回合 / 调工具」。

三条不变量：

1. **控制面只有客户端发起**（NAT/防火墙决定服务端不可能主动连 dsh），因此所有交互是 dsh → 服务端：握手一次、每回合头取上下文一次、回合尾推回写一次（异步）、工具内联调用。
2. **前缀稳定性优先于内容新鲜度**：静态上下文包（head pack）在会话内**冻结**，服务端给 packVersion，插件逐字追加；每回合变化的块只追加在**尾部**（当前 user 回合之后）。换 pack 只发生在会话开始与显式 mem:sync。这条是为了不吃掉上游 KV cache。
3. **失败必须对模型透明**：控制面任何失败都 fail-open（本轮不注入 / 回写进本地 outbox 稍后重试），绝不阻塞模型调用。

拓扑：

```
┌─ 用户机器 ────────────────┐        ┌─ 云上（安全组内）──────────────┐
│ dsh (Electron)            │        │  Caddy :443                    │
│  └ @tdb/agemem-dsh 插件   │ HTTPS  │   └ Proxy :8096  /v3/dsh/*     │
│      ├ 上下文装配          │ ─────► │        ├ 会话状态机             │
│      ├ 工具 (skill/memory) │        │        ├ 上下文装配(块)         │
│      └ outbox (磁盘)       │        │        └ 回写/观测/计费        │
│  └ @deepseek-ai/dsh-llm-* │───────►│  Ark / 任意上游（直连，不经代理）│
└───────────────────────────┘        └────────────────────────────────┘
```

记忆内容侧（core 8420 / knowledge 8421）不动：控制面仍通过现有 tdai / coreSkill / knowledge 客户端以回环调用它们。被删掉的是「协议代理」那一层。

## User Stories

1. As a dsh user, I want my model calls to go straight to the provider, so that latency and reliability no longer depend on a memory proxy in another region.
2. As a dsh user, I want my project memory (agent profile, task goal, soul rules) to appear in the conversation without configuring anything beyond a URL and a key, so that setup stays a one-line change.
3. As a dsh user, I want the first turn of a new session to ask me which team / agent / task I belong to using dsh own UI, so that I never see a fake form rendered as if it were the model output.
4. As a dsh user, I want the injected context to stay byte-identical across turns within a session, so that the provider KV cache keeps hitting and my token bill does not inflate.
5. As a dsh user, I want per-turn recalled memories (L1 / wiki / feeling) appended at the tail instead of rewriting the system prompt, so that freshness does not cost me cache misses.
6. As a dsh user opening dsh offline, I want the model to still work with the last cached context pack and no error banner, so that a network blip never blocks my work.
7. As a dsh user on a flaky network, I want turn writeback to be queued locally and retried, so that no conversation turns are lost and none are duplicated.
8. As a dsh user, I want an explicit switch to disable writeback entirely, so that I can keep all prompt content on my machine when working on sensitive code.
9. As a dsh user, I want to see in dsh settings which memory server I am connected to, whether I am initialized, and when the last successful sync happened, so that I can debug why it forgot something.
10. As a dsh user, I want memory/skill search to be real tools the model can call with structured results instead of curl recipes in the prompt, so that the model spends fewer tokens and gets better answers.
11. As a dsh user, I want mem: commands (sync / create-skill / create-task / update-task / session-reset / help) to be dsh slash commands, so that they are discoverable and do not depend on text parsing.
12. As a dsh user, I want session reset to take effect immediately on every device, so that a stale session on my laptop does not keep injecting an old task.
13. As a dsh user, I want the plugin to degrade silently and tell me in a status line when the server is unreachable, so that I know memory is cold but my work continues.
14. As a dsh user behind a corporate proxy, I want to configure an HTTPS endpoint and a token and have everything else work, so that no port other than 443 is required.
15. As a dsh user, I want the plugin to refuse plaintext HTTP to a remote host, so that my prompts and memories are never sent in the clear by accident.
16. As a dsh user with multiple machines, I want each session tracked separately while the same team/agent/task is shared, so that my profile is consistent but sessions do not collide.
17. As a platform operator, I want a single authenticated control-plane namespace for the plugin, so that I can rate-limit, audit and version it independently from LLM traffic.
18. As a platform operator, I want to retire the unauthenticated /skill-bridge and /memory-bridge endpoints, so that knowing a session id is no longer enough to act as a user.
19. As a platform operator, I want short-lived session tokens issued at handshake, so that WAN round-trips to the auth service happen once per session instead of once per request.
20. As a platform operator, I want server-assigned per-session turn counters, so that one logical turn maps to exactly one trace across retries and tool loops without guessing from message history.
21. As a platform operator, I want idempotent writeback keyed by a client turn id, so that L0 duplicate rows disappear.
22. As a platform operator, I want to cap control-plane payload size and per-session turn rate, so that a buggy client cannot amplify cost.
23. As a platform operator, I want the plugin to report token usage per turn, so that dashboards and per-user quotas keep working even though LLM traffic no longer transits the proxy.
24. As a platform operator, I want the control plane to keep working when Redis/ProxyStorage is degraded, so that a state outage does not take down memory for every user.
25. As a platform operator, I want to keep one release of dual-mode (proxy transport + plugin) behind a flag, so that rollback does not require redeploying clients.
26. As a maintainer, I want to delete the six per-agent form builders and four LLM handlers, so that the module stops carrying about 24k lines that only exist to be a protocol middleman.
27. As a maintainer, I want the memory-content logic (injectors, recall, soul rules, writeback recording) to stay the single source of truth, so that this migration does not fork memory semantics.
28. As a maintainer, I want one thin seam per layer (HTTP contract / assembly function / plugin client) so that tests assert external behaviour instead of protocol internals.
29. As a maintainer, I want a capability-only spike before the migration, so that we learn what dsh actually allows third-party plugins to do before deleting the working path.
30. As a maintainer, I want the plugin and server to exchange protocolVersion, so that they can skew by months without breaking each other.
31. As a maintainer, I want a shadow mode that runs both transports for the same session and diffs injected blocks and written rows, so that parity is measured rather than assumed.
32. As a maintainer, I want the deletion list to be an explicit ordered checklist with line-count accountability, so that removing the proxy is verifiable in review.
33. As a memory owner, I want per-turn recalled blocks to carry a kind and a placement hint, so that future clients can decide where to put them without the server knowing any protocol.
34. As a memory owner, I want the head pack to be content-addressed via packVersion, so that we can cache it on disk, log which pack a turn used, and reproduce an injection after the fact.
35. As a memory owner, I want soul red-line rules attached to the turn where a risky tool is about to run, so that the safety property survives the loss of per-request body access.
36. As a security reviewer, I want the session token bound to (sessionId, spaceId, userId, epoch) and to expire within 30 minutes, so that a leaked token has a bounded blast radius.
37. As a security reviewer, I want session-reset to bump the epoch, so that an outstanding token for the old session becomes unusable immediately.
38. As a security reviewer, I want client-side logging to never contain prompt text, so that debug logs cannot become a data-exfiltration channel.
39. As a security reviewer, I want redaction (ACP tags, secret patterns) applied before writeback leaves the machine, so that credentials accidentally pasted into chat do not land in the cloud store.
40. As a product owner, I want the plugin to be installable from the dsh plugin manager with a URL and a token, so that onboarding is not editing YAML by hand.
## Implementation Decisions

### 0. 落地最优方案（一页版）

如果只记一页，记这些：

1. **形态**：dsh 插件 + 服务端控制面。插件装在用户机器上（一行 cordis patch + 一个真实目录，不动 dsh 源码），LLM 流量由 dsh 直连模型，**一个字节都不经过 tdb**；tdb 只剩「记忆控制面」。
2. **三个钩子撑起全部能力**：`agent/session-start`（含 source=compact）注入会话级 head pack；`agent/pre-step` 瀑布每步把 volatile 块追加到 batch 尾部；`agent/turn-stopping` + `agent/assistant-stream` 在回合结束回写。soul.event 挂 `tool/call`，比现在的「搭便车」精准。（已更正，见本文件头部「实测更正」节：`agent/session-start` 不存在，head pack 走 `systemPrompt.section`；usage 走 `session/event`。）
3. **工具**：`ctx.tools` 注册一个 `memory` 工具（action 枚举 search / read / skill / wiki），宿主自带 dsh-mcp-client 就是官方先例；技能目录改 `ctx.skills.register` 变成原生技能，`<skill_tools>` / `<tdai_memory_tools>` 那两坨 curl 菜谱注入器直接删掉。
4. **前缀稳定性是结构性的，不用机制去维护**：只往尾部追加，system 与历史不动 → KV cache 不会碎，也不需要 packVersion 冻结、staleness 判定、「记忆包下个会话生效」这类妥协。
5. **跨机只加一条关键路径**：每个回合一次 `POST /v3/dsh/context`（预算 700ms，超时 fail-open），会话首回合一次 handshake（短时 token，免每回合 WAN 鉴权往返）。回写走本地 outbox 至少一次 + turnId 幂等，断网 30 分钟不丢不重。
6. **删掉的是「为代理 LLM 而存在」的代码**：四个 LLM handler + aux + 系统用户旁路、guard/request-prepare、agent-adapters + 互操作 common、六端 form/init/extractor、injection/adapters + agentProfiles 槽位手术、mem-command 文本解析、两个未鉴权 bridge、路由死条目、按请求维度的限流与 usage 解析 —— 约 **23,900 行（−45%）**，净减 22.4k，剩约 30k。
7. **落地顺序可停在任意一步**：Phase 1 抽核（行为不变、62 个测试文件全绿）→ Phase 2 插件只做 head pack 注入（证明链路通）→ Phase 3 加 volatile + 工具 + 回写（此时 dsh 用户已可完全不走代理）→ Phase 4 才动删除。**删除永远在最后**，前面每一步都是纯增量。
8. **不算不知道的两个收益**：一是 `/skill-bridge`、`/memory-bridge` 这两个**未鉴权**、只要知道 sessionId + spaceId 就能冒充身份的端点被彻底删掉，越权面消失；二是「六端表单文案必须逐字一致」这类跨仓库隐式契约消失，因为表单由 dsh 原生 UI 渲染，服务端只给 JSON。

### 1. 形态：插件 + 控制面，不是 MCP，也不是「瘦代理」

- **采纳**：dsh 侧插件 + 服务端 /v3/dsh/*。
- **否决 纯 MCP 工具**：MCP 只能做「模型主动检索」，无法在回合头注入画像/任务/红线，也无法在回合尾拿到结构化回写；会丢掉系统最有价值的两件事。
- **否决 瘦代理**（继续转发 LLM，但砍掉多端适配）：跨机绕行与协议翻译的根因没变，删除量也不减。
- **否决 服务端 push**（SSE/WS 下发上下文）：跨机 NAT 下不可靠，且会在模型调用链上引入第二条长连接。

### 2. 控制面 API 契约（/v3/dsh/*，全部 POST JSON，HTTPS）

> （已更正，见本文件头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，插件直接复用现有 v3 数据面四端点；本节保留为目标态契约。）

统一响应封套（为了版本漂移可解析）：

```
{ "ok": true,  "data": { ... }, "apiVersion": "2" }
{ "ok": false, "error": { "code": "40101", "message": "...", "retryable": false } }
```

错误码沿用现有 5 位风格：40001 参数非法、40101 token 无效/过期、40301 未授权的 space/资产、40901 epoch 不匹配（会话已 reset）、40902 写冲突（乐观锁过期）、42201 状态冲突（表单未完成）、42901 超配额、50301 上游记忆服务不可用、50302 服务端处理超时（可重试）。

**2.1 POST /v3/dsh/handshake** — 每会话一次（+ token 过期前刷新）

```
req:  { apiVersion, pluginVersion, spaceId, sessionId, userKey, deviceId?,
        capabilities: ["context","writeback","tools","commands"] }
resp: { token, tokenExpiresAt, epoch,
        sessionState: "uninitialized" | "initialized",
        form?: FormSpec,
        sessionInfo?: { team, agent, task },
        pack?: { packVersion, blocks[] },
        policy: { contextDeadlineMs, writebackEnabled, maxTurnBytes, volatileBudgetChars },
        features: [...], minPluginVersion }
```

要点：
- userKey 只在这里校验（复用现有 verifyUserKey 语义）。此后全部用 token，避免每请求一次跨机鉴权往返（现状是每请求都打鉴权服务且无缓存）。
- token = tm_<base64url(payload)>.<hmac>，无状态：payload = { sid, sp, uid, ep, exp }；服务端密钥支持双密钥窗口轮换。
- 未初始化时直接返回 FormSpec（见 §5），而不是伪造 assistant tool_call。

**2.2 POST /v3/dsh/session/answer** — 表单作答（可能多次，逐阶段）

```
req:  { formId, answers: [{ questionId, values: [...] }] }
resp: { sessionState, form?, sessionInfo?, pack? }   // 与 handshake 同构
```

**2.3 POST /v3/dsh/context** — 回合头（唯一在关键路径上的调用）

```
req:  { turnId, turnSeqClient?, userText, userTextHash, packVersion,
        historyMeta: [{ role, hash, chars, toolNames? }],   // 只发摘要，不发正文
        budgetChars }
resp: { turnSeq, traceId,
        headPack?: { packVersion, blocks: [{ id, kind, text }] },  // 仅当 packVersion 过期
        volatile: [{ id, kind: "l1"|"wiki"|"feeling"|"soul.event", text,
                     placement: "turn_tail"|"tool_pre_call", toolFilter?: string[] }],
        notes: { degraded?, dedupedKinds? } }
```

- turnSeq 由服务端分配（每会话单调递增），**不再从历史推**；traceId = sha256(sessionId + ":" + turnSeq)[:32]，保持「一回合一条 trace」的既有观测口径。
- historyMeta 只带 hash/结构，是为了隐私（不把完整历史再传一遍）、字节可控、以及服务端仍能拿到「用户文本是否重复」这类信号（现有意图去重、wiki 归一化都在这一侧）。
- 服务端**不返回**任何要求改写历史的指令；插件只在尾部追加。

**2.4 POST /v3/dsh/turn/end** — 回合尾（异步、幂等）

```
req:  { turnId, turnSeq, traceId, model,
        messages: [{ role, text, toolCalls?: [{ name, argsDigest }] }],
        usage: { input, output, cacheRead, cacheWrite5m?, cacheWrite1h? },
        stopReason, truncated? }
resp: { accepted: true, duplicate?: true, turnSeq }
```

- 幂等键 (sessionId, turnId)，服务端保留 24h 去重窗口；turnId 建议 UUIDv7（时间有序）。
- 载荷上限 maxTurnBytes（默认 256KiB）；超限由客户端按消息条数截断并标 truncated，服务端照收并记 telemetry。
- 服务端把这一条同时写入：L0 会话流水（复用现有 classified 采集口径）、token/计费流水（source = client_reported）、ClickHouse 回合行。

**2.5 工具端点**（同步、小载荷、幂等只读；写操作单独门控）

```
POST /v3/dsh/tools/{ skill.search | skill.get | skill.files.read
                   | memory.search | memory.read | knowledge.list | wiki.search }
req:  { tool, args: {...}, turnId }
resp: { result, meta: { scope, agents[]?, truncated? } }
```

- 身份由 token 盖章（**不再信任调用方自报的 user/team/agent/session**），这正是替掉两个未鉴权 bridge 的原因。
- 写类（skill create/update/files.write）保留现有 allowLlmWrite 门控；关闭时返回 40301（不再有 403 + 40302 双码）。
- 版本钉（乐观锁）语义保留：读带 version、写带 expectedVersion，冲突返回 40902。

**2.6 管理面不变**：/health、/whoami、/v3/admin/*、panel 走 SSH 隧道。/health 增加 controlPlane: { tokensIssued, degraded }。

### 3. dsh 扩展点：已实证，不需要改 dsh 源码

本机 ~/.dsh 里有一个**已安装并正在运行**的第三方插件 dsh-superpowers（v7.0.0，自述 Shape B port），它的源码给出了可直接照抄的落地形状：

```
export const name = 'superpowers';
export const inject = ['skills'];
export function apply(ctx, config = {}) {
  ctx.skills.register({ name, description, whenToUse, source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true }, content, resourceBase });
  ctx.on('agent/session-start', ({ agent, source }) => {
    if (!/^(startup|clear|compact)$/.test(source)) return;
    agent.inject(createUserMessage({ content: [{ type: 'text', text: bootstrap }],
      source: { kind: 'plugin', plugin: 'superpowers' } }));
  });
}
```

装配方式：~/.dsh/cordis.patch.yml 里一行 insert（`- id: x / name: ./profiles/node_modules/<pkg>/lib/index.mjs`），包内 package.json 的 dsh.bundle.patch 指向自己的 cordis.patch.yml。**既不改 dsh 本体源码，也不需要 fork**——这是本方案「能落地」的第一条硬证据。

宿主事件与机制（从宿主内文档字符串逐个核对过）：

| 机制 | 形状 | 本方案用途 |
|---|---|---|
| agent/session-start | `({ agent, source })`，source ∈ startup / clear / **compact** | 会话开始与**压缩后**重新注入 head pack（天然解决「压缩后记忆丢失」）（已更正：该事件不存在，见头部实测更正 #3） |
| agent/pre-step | `async ({ agent, messages, step, signal }, next)`，瀑布流，**可替换进入本步骤的 messages** | 每步注入 volatile 块；只追加尾部，前缀不变 |
| agent/assistant-stream | 有序 start / chunk / end 帧，最终提交为一个 assistant/message | 回写：拿完整回复与工具调用（已更正：end 帧无 usage，见头部实测更正 #2） |
| agent/turn-stopping | 回合关闭前可阻止关闭 | 回合结束触发回写 |
| tool/call、tool/result | 工具边界 | soul.event 贴到动作点（比现状「搭便车」更准） |
| agent/request | 派发前可补 provider/model | 读取本轮真实模型（计费/日志） |
| ctx.tools.* | 注册 / restrict / guard / 瀑布重写 | 注册记忆工具；宿主自带的 dsh-mcp-client 就是「把 MCP 工具注册到 ctx.tools」，官方先例 |
| ctx.skills.register | 运行时技能注册（模型可调 + 用户可用 / 唤起） | 把「技能目录」变成宿主原生技能，替掉 curl 菜谱注入器 |

宿主文档里还有一条裁决要遵守：「扩展点是共享的，用最弱的机制」——ctx.tools.restrict() 只能删工具、ctx.tools.guard() 只能拒绝、**瀑布监听器才能重写**。我们的注入走 agent/pre-step 瀑布（重写类），不用 guard / restrict。

**残余未知（P0 收尾，1~2 天，不影响形态选择）**：

1. pre-step 的 next() 具体签名（改写 messages 是返回值还是 next 参数）——照抄本机已有插件的写法即可确认。
2. assistant-stream 的 end 帧是否携带 usage；若不携带，回写 usage 留空，计费退回「上游账单为准 + 服务端按字符估算」。（**已实测并证伪**：end 帧 `usage: null`，真源是 `session/event` 的 `assistant/message.data.usage`，见头部实测更正 #2）
3. pre-step 的 messages 里能否干净地取到「用户本轮原文」（是否已被 ACP 标记包裹）。

### 4. 装配与时序：按宿主真实语义（比「冻结 packVersion」更简单）

因为 pre-step 是瀑布且只在 batch 尾部追加，**前缀天然稳定**，不需要额外的 packVersion 冻结机制：

- **会话首步**：head pack 作为一条 `source: { kind: 'plugin' }` 的用户消息插在已领取消息之后（与宿主既有插件同位置），会话内不再重发；收到 source = compact 时重发。（已更正：`source.kind` 必须是 producer-owned，`'plugin'` 会让整轮失败；且 session-start 不存在，见头部实测更正 #3 与 probe 报告 §3-5）
- **每一步**：pre-step 里把 volatile 块合成**一条** plugin 消息追加到 batch 尾部；**不改历史、不重排、不删旧块**。缓存友好是结构性的，不靠纪律。（已更正：追加消息**会落盘为 `user/message`**，须按 (sessionId, turnId) 去重，见头部实测更正 #1）
- **增长控制**：块带 ttlTurns（默认 3），过期后不再追加新块，旧块留在历史里交给 dsh 自身 compaction；压缩后 session-start(compact) 重新注入 head pack，形成闭环。（已更正，见头部实测更正 #1/#3：注入落历史、session-start 不存在，靠 section 文本函数重算）
- **预算**：单步 volatile ≤ volatileBudgetChars（默认 1800），超时 fail-open（本轮不追加）。
- **为什么不再需要「head pack 冻结」**：冻结是为了对抗「每回合重拼 system」，而现在每回合只往尾部追加，system 与历史一个字节都不动。省掉了一整套版本协商、staleness 判定和「记忆包下个会话生效」的 UX 妥协。

head pack 内容（会话级）：灵魂 head（身份叙事 + 红线规约，遵循 ADR-0003/0005）、Agent（id/name/description/prompt）、Task（id/name/description/goal）、团队资产清单、技能目录（BM25 从 agent/task 细节取，弱信号退 full）、知识库清单、L2/L3 画像记忆（6000 字符 core memory + 场景索引）、session_context。

volatile（每步）：L1 召回（intent 去重 + 同会话 60min 抑制）、wiki 召回（归一化门槛 + 结构尾巴）、feeling（每步重算）、soul.event（工具边界，经 tool/call 钩子而不是尾巴）。

**注入与工具化的边界**（保持现有决策）：L0/L1 走工具（模型按需检索），L2/L3 注入；injectL2L3 = false 时只给工具与画像摘要。工具注册后，「curl 菜谱」注入器（skill-tools、tdai-memory-tools）失去存在理由，一并删除。
### 5. 会话状态机：保留语义，换驱动方式

- 保留现有阶梯：uninitialized → (asset_confirm) → (team) → (agent) → (task) → initialized；单团队可跳级；跳过/不关联/skip 走 bypass；attemptCount 超上限则 initialized + bypassed 并记录原因。语义与文案常量**逐字保留**（「是，关联团队资产」/「否，本次不关联」等），避免老用户行为变化。
- FormSpec 是平台无关的数据结构：

```
{ formId, stage, title,
  questions: [{ id: "team"|"agent"|"task"|"asset_confirm",
                header, question, multiSelect: bool,
                options: [{ value, label }], allowFreeText: bool }],
  page?: { index, total } }
```

- 插件负责渲染（dsh 原生 UI：单选/多选/搜索/分页由客户端决定，服务端不再编码「≤4 选项 / header ≤12 字符」这类协议怪癖）。
- 服务端只做状态机与校验：答案 → 下一个 FormSpec 或 initialized + pack。答案非法返回 42201 并重发同一 formId。
- 保留的登记动作：团队 = 首个包含该 agent 的团队（无兜底）；agent/task 并行解析；sessionInfo 由本地拼装；space_id 回填必须在 pack 组装之前（否则 pack 会以空 space 组装）。
### 6. 跨机韧性与时序

- **关键路径只有 /context**：预算 contextDeadlineMs 默认 700ms（可配 0 = 关闭）。超时/失败 → 用磁盘上最近一次 headPack（可能已过期，标 stale）+ 本回合无 volatile，继续模型调用。
- **握手缓存**：状态文件 + 内存；token 剩余 <5min 时在下一次 /context 前顺手刷新（复用同一 HTTP 连接）。
- **回写至少一次 + 幂等**：先落 outbox 再发；成功删行；4xx（除 401/429）直接丢弃并记一条本地可见错误；401 触发一次重握手后重试；5xx/超时指数退避（1s/4s/16s，上限 5 分钟，抖动 20%）。
- **顺序**：outbox 按 turnId 保证会话内有序发送；服务端按 turnSeq 重排入库，乱序到达不落错位。
- **离线**：30 分钟断网后恢复，outbox 全量落地且不产生重复行（幂等键保证）。
- **服务端降级**：ProxyStorage 降级到内存/fs 时控制面仍工作，但 epoch/turnSeq 退化为进程内（/health 与 handshake 的 policy.multiNodeSafe=false 明示）；cos 后端不可用仍然 fail-fast 让 pod 起不来（沿用现有多节点分裂脑裁决）。
- **时钟**：一律服务端时间；客户端只发单调计数与 turnId。ClickHouse 侧不再需要 TS→CH 的 +8h 位移补丁（服务端统一写入）。

### 7. 安全与隐私（跨机新增的主要风险面）

- **鉴权**：token 绑定 (sessionId, spaceId, userId, epoch)；TTL 30min；session-reset bump epoch 使旧 token 立刻失效（40901）。服务端不存 token 表，验签 + epoch 比对即可。
- **传输**：远端主机强制 HTTPS；http:// 仅在 localhost/127.0.0.1/::1 允许，其他情况插件直接拒绝并提示（可显式 allowInsecureHttp = true 覆盖，用于内网自建）。
- **越权收紧**：删除 /skill-bridge/*、/memory-bridge/*（未鉴权）。所有能力走 token 化工具端点；session_id 不再可由调用方指定（sessionId 来自 token）。
- **数据最小化**：
  - /context 只发历史摘要（hash + role + 工具名 + 字符数），不发历史正文。
  - /turn/end 发正文但受 maxTurnBytes 与 writebackEnabled 双重约束；writebackEnabled = false 时插件完全不发正文，只发 usage + 摘要（可验证：抓包无正文）。
  - 出站前脱敏：剥 acp 标记、常见密钥形态（sk-、ghp_、AKIA、私钥块）替换为 [redacted]。
- **日志**：插件侧日志只记长度/哈希/耗时，**永不**记 prompt 正文；服务端沿用「不记 body」的既有裁决（bridge 已经这么做过，因为 body 含 SKILL.md），并给控制面 logBody = false 默认值。
- **审计**：每次 handshake 与 session-reset 记一行（userId、spaceId、sessionId、deviceId、IP 段、结果），便于事后定位。

### 8. 计费、限流与观测（失去「代理锚点」后的替代口径）

- **token 记账**：/turn/end 自报 usage，服务端按现有价目表算 credit，落 ClickHouse，source = client_reported。**明示取舍**：客户端自报不可信，因此 (a) 计费真源改为上游（Ark）账单，(b) 本侧数字用于配额、看板与异常检测（自报 token 与 chars 比值异常 → usage_raw 记异常原因）。
- **限流**：从「每请求 TPM/QPM」改为「每会话回合速率 + 每用户日额度」（turns/min 默认 30、context/min 默认 60、日 token 建议额度）。不再需要 Redis Lua 滑动窗口那套按请求维度的实现，保留一个轻量计数器即可。
- **trace**：traceId = sha256(sessionId:turnSeq) 保持；插件把 traceId 回传 /turn/end 以做跨边界关联。Langfuse 一回合一条 trace 的语义不变，但 generation 改由服务端按自报数据生成（或由客户端上报 span——见 Out of Scope）。
- **拆开的指标**：客户端侧（握手耗时、/context p50/p95、超时率、outbox 深度、丢弃数）+ 服务端侧（装配耗时、块数/字节、降级次数、去重命中）。这两组不再混在一个进程里，必须分别看板。

### 9. 删除清单（本规格的核心账目）

口径：MemoryProxy/src 非测试 53,524 行。删除目标 = 「只为代理 LLM 而存在」的代码。

**A. 整文件删除**

| 层 | 内容 | 行数 | 为什么必须删 |
|---|---|---|---|
| LLM 协议 handler | handler.ts（OpenAI chat）、anthropicHandler.ts、codexHandler.ts、workbuddyHandler.ts、auxiliaryHandler.ts、systemUserPassthrough.ts | 2,516 + 2,391 + 1,448 + 1,476 + 304 + 716 = **8,851** | LLM 流量不再经过代理 → 无请求可解析、无流可 tap、无 body 可改 |
| 路由守卫/改稿 | guard-adapter.ts、request-prepare-adapter.ts | 566 + 373 = **939** | cost-guard 与改稿钩子都作用在「即将转发的 body」上 |
| Agent 互操作 | agent-adapters/**（9 文件 858）、common/{cc-request-classifier 78, codex-injection 117, workbuddy-injection 114, user-query-extractor 194, user-text-extractor 30, short-intent 78} | 858 + 611 = **1,469** | 只有「读懂六种客户端协议」时才需要 |
| 会话协议适配 | session/{claude-code, codebuddy, codex, workbuddy, opencode, dsh}/** 的 form / init / extractor / cleaner / pagination（目录合计 7,473，保留少量注册壳） | ≈ **7,300** | 表单由插件用原生 UI 渲染；答案走 JSON，不再需要伪造 assistant tool_call / SSE 事件序列 |
| 注入协议适配 | injection/adapters/**（anthropic 303 + openai 257 + interface 31）+ agentProfiles 与槽位手术 | ≈ **740** | 服务端只产出「块 + placement」，不再改 body 形状 |
| mem: 文本命令 | mem-command/** 的 parser 139、pre-intercept 87、response-builder 285、task-draft-generator 633、index 91、types 63、utils 102（保留 5 个动作实现约 900） | ≈ **1,400** | dsh 有原生斜杠命令；不再从用户文本里正则抠命令 |
| 未鉴权桥 | skill/skill-bridge.ts、memory/memory-bridge.ts | 1,098 + 518 = **1,616** | 被 token 化工具端点取代（同时修掉越权面） |
| 路由表死条目 | routes/whitelist.ts 及 catch-all / legacy /proxy 分支 | ≈ **430** | 无协议转发可路由 |
| 限流 | rate-limit/**（499，保留约 120 的轻量计数器） | ≈ **379** | 没有逐请求 TPM 可限 |
| 计费解析 | credit-reporter.ts 中「从流里扒 usage」的部分（保留价目表与公式） | ≈ **150** | usage 改为自报，解析逻辑无用 |

合计约 **23,900 行（−45%）**。

**B. 局部删除（散落在保留文件里的死代码）**

- 四个 handler 内共有的：SSE tap（consumeAnthropicStream / consumeCodexStream / usage tap transform）、thinking 块清洗与占位、max_tokens 夹取、模型别名解析、retryTarget、marker 路由（/cost-guard/*、/analyse/*）、/proxy/:spaceId legacy 路由、catch-all POST /*。
- common/acp-tag.ts 保留（脱敏仍要用），但「只在 L0 写入边界剥」的注释改为「出站前统一剥」。
- server.ts 路由表从约 30 条降到约 12 条（/health、/whoami、/v3/dsh/* 六端点、/v3/admin/*、panel 用的 session 管理路由）。
- config.ts 删掉与上游转发相关的整块：upstream.agents 覆盖、costGuard、sessionInit.debugVerboseLogging、markerOptIn 两处、server.forwardTimeoutMs。保留 upstream.url/apiKey 仅当「代理模式」开关还开着（见 §10）。

**C. 保留（不动语义）**

injection/injectors/**（15 文件 3,790，块内容真源）、tdai/**（client / recorder / pending-writes / identity，1,380）、storage/** + db/**（2,603）、观测（clickhouse 1,339 / langfuse 399 / opik 304 / report 605）、meta/client.ts、knowledge/**、skill/core-client.ts + 版本钉、routes/{session-task, session-refresh, session-force-archive, credit-pricing, llm-providers}、config.ts（裁剪后）、types.ts（裁剪）。

**D. 净账**

删除约 **23.9k**，新增控制面约 **1.5k**（六端点 + 装配 + token + outbox 服务端侧），净减约 **22.4k（−42%）**，MemoryProxy/src 降到约 **30k**。同时删掉三个隐性依赖：@context-proxy/cost-guard（若只在 guard / request-prepare 使用）、限流 Lua 脚本、以及「六端表单常量必须逐字一致」这类跨仓库隐式契约。

### 10. 迁移与灰度（删除必须可回滚）

> 落地顺序按「可回滚且每步可独立验证」排列：先抽核（行为不变、测试全绿），再插件灰度（只加不改），最后才删代理。任何一步都可以停在那里交付。

- **Phase 0（hello plugin，1~2 天）**：照抄本机 dsh-superpowers 的形状写一个最小插件（`apply(ctx)` + `agent/session-start` + `agent/pre-step`），只验 §3 剩下的三项：next() 签名、assistant-stream end 帧是否带 usage、pre-step 能否干净取到本轮用户原文。**不改 dsh 源码、不写生产代码**。任一项不成立 → 按 R1 退化（head 走 session-start、volatile 退化为工具检索）。
- **Phase 1（抽核）**：把「块装配」从 InjectionPipeline.executeHooks 抽成纯函数 assembleTurnPlan(input) → { headPack, volatile, meta }；现有 pipeline 改为调用它，**行为不变**（现有 62 个测试文件全绿为门禁）。这一步在同机代理模式下就能验证重构正确。
- **Phase 2（插件 MVP，head only）**：握手 + 会话状态机 + head pack 注入 + 设置面板。回写关闭。灰度：单个 spaceId 白名单。
- **Phase 3（volatile + 工具 + 回写）**：L1 / wiki / feeling / soul.event 尾部追加，工具注册，outbox 回写。此时 dsh 用户可完全不走代理。
- **Phase 4（删除）**：按 §9 顺序删（先删 codex/workbuddy/aux → 再删 anthropic/chat handler → 再删 bridge 与 mem-command 解析器 → 最后删 adapters 与 agentProfiles）。每删一层同步删对应测试，/health 的 legacyProxy = false 作为标记。
- **Phase 5（影子对比）**：同一会话可同时开两种模式（插件上报块 hash、代理记录注入块），对比 7 天：head pack 内容一致率、volatile 块数分布、L0 行数与去重命中、/context p95、上游 cache 命中率与成本。一致率与成本达标才允许把代理传输降级为 deprecated。
