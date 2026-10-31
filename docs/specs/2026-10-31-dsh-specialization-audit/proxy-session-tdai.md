# 分卷：session/** · tdai/** · mem-command/** · agent-adapters/** 逐文件删改账目

- 日期：2026-10-31｜判定口径见 [README.md](./README.md)（**D 删** / **M 改** / **K 留**）
- 前提：dsh 改插件直连模型，LLM 流量不再过代理；控制面只保留 `/v3/dsh/{handshake,session/answer,context,turn/end,tools/*}`。**表单由 dsh 原生 UI 渲染，服务端只出 FormSpec JSON**。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）
- 所有行数 = 非测试 `wc -l`；路径相对 `MemoryProxy/src/`。

## 1. 表单一层：伪造 assistant tool_call（全 D）

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| session/form.ts | 1202 | D | CB `ask_followup_question` 的 fake tool_call + 双协议 builder；id 前缀 form.ts:23-26，UI 文案 :32-70 | importer 仅 session/extractor.ts:15 |
| session/dsh/form.ts | 553 | D | dsh `ask_user_question` 六事件 SSE（:295 buildFormResponse、:301 protocol 分派）、`call_dsh_session_init_`（:76）、空 thinking 占位（:104 REASONING_PLACEHOLDER / :519 thinking_delta） | session/index.ts:194 外层重渲染 |
| session/codex/form.ts | 661 | D | Responses `request_user_input`；call_id `call_codex_session_init_`（:26）+ id `fc_`（:35）、Default gate 前缀（:60） | codexHandler.ts:41、codebuddy/init.ts:50、workbuddyHandler.ts:40 |
| session/claude-code/form.ts | 283 | D | `AskUserQuestion` 仅 Anthropic SSE，`toolu_cc_session_init_`（:20） | claude-code/{init,extractor,cleaner} |
| session/codebuddy/form.ts | 407 | D | 平铺字符串 option、双协议、`call_session_init_`/`toolu_session_init_`（:18） | codebuddy/{init,extractor,cleaner} |
| session/opencode/form.ts | 379 | D | opencode 白名单 `question`（:64）、`call_oc_session_init_`（:65）、header≤30 截断 | session/index.ts:92 |
| session/workbuddy/form.ts | 322 | D | CC shape + OpenAI SSE 混血，`call_wb_session_init_`（:24） | session/index.ts:82 |
| session/claude-code/pagination.ts | 100 | D | 纯客户端 option 上限产物（CC_MAX_OPTIONS=4/CC_PAGE_SIZE=3，:35-38），dsh 无此上限 | claude-code/form.ts:15 |
| session/codex/pagination.ts | 98 | D | 同上，3/2（:33-36） | codex/form.ts:16 |

**要留下的不是文件，是契约**：FormStage 五态 `asset_confirm|team|agent_select|agent_task|task_select`（session/dsh/form.ts:144-145）、分页参数（总页数 = ceil((total-末页满) / 每页)）、`__bypass__`/`__more__` 两个哨兵语义（session/extractor.ts:21-27）→ 收敛成一份 FormSpec JSON Schema，随 `/v3/dsh/handshake` 下发。

## 2. 各端解析器与状态机

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| session/claude-code/extractor.ts | 446 | D | 只解析 AskUserQuestion tool_result JSON（:392 extractStructured） | claude-code/init.ts:46 |
| session/codebuddy/extractor.ts | 438 | D | 只解析 `<question_answer>` XML，头注释自认"fragile 依赖，不是精确解析"（:1-14） | codebuddy/init.ts:41 |
| session/workbuddy/extractor.ts | 28 | D | CC extractor 纯 re-export | — |
| session/extractor.ts | 513 | D | 旧共享提取器（"agent: 1" / option 文本 → identity），仅 CB 状态机引用 | codebuddy/init.ts |
| session/claude-code/cleaner.ts | 80 | D | 只剩 getLastUserMessageText(:35)，读 form 答复用 | — |
| session/codebuddy/cleaner.ts | 276 | D | 同上 + **stripInitArtifacts 仍活着**（:80，CC 版注释宣称已删 :4，两处自相矛盾） | codebuddy/init.ts:42 |
| session/codebuddy/init.ts | 1635 | M | 真业务：completeRegistration(:394)、mapPendingStatusToStage(:532)、handleSessionInit(:544)。codex/workbuddy/dsh/opencode 四端都借它（session/index.ts:166/:194/:229 三处外层换 form）→ 保留登记/校验/状态推进，删 form 分派、intercepted 分支、per-protocol 重渲染（估剩 ~400 行） | session/index.ts、codex/workbuddy/dsh 三 handler |
| session/claude-code/init.ts | 1204 | D | CC 专属状态机，与 CB 版重复实现；CC 侧无流量 | session/index.ts:100 |
| session/workbuddy/init.ts | 474 | M | header-preselect-only、不返回 intercepted（:1-40），**正是未来 handshake 的模板**（:138），迁入口后留 | workbuddyHandler.ts |
| session/codex/index.ts | 18 | D | barrel | — |
| session/index.ts | 249 | M | 统一 dispatch + 三端外层重渲染（:120-249）；缩成核心导出 + `/v3/dsh` 入口 | handler/anthropicHandler/codexHandler/workbuddyHandler 四处 import |

## 3. 会话内核（K 为主）

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| session/store.ts | 828 | K | L1 Map + L2a SessionRepo（30min TTL，:33）+ L2b BindingRepo（nottl）；keyId→identity 绑定（:16-27） | 9 处（handler 系列 + routes + memory-bridge + mem-command） |
| session/session-key.ts | 86 | K | 会话 id 头优先级（:10-25，含 x-deepseek-harness-session-id、x-session-affinity） | handler.ts:720、anthropicHandler.ts:678 |
| session/registrar.ts | 35 | K | buildSessionInfo 本地构造，已不调 TMC | 四个 init.ts |
| session/context-injector.ts | 290 | K | `<session_context>` 生成（:43-77 / :106 / :199），特意绕开 injection.enabled 门（:1-11）；只换入口 | 5 handler |
| session/types.ts | 243 | K | SessionInitStatus/State/Info 等类型底座 | 全模块 |
| session/preset.ts | 117 | M | x-team-id/x-agent-id/x-task-id 头预选 + 校验；handshake 自带身份后只剩校验分支 | handler.ts:834 |
| session/user-session-init-preset.ts | 39 | K | 用户级 session_init 三态（ask/bypass/preset） | CC/CB init |
| session/dsh-ptc-preset.ts | 97 | M | PTC headless 配置代供身份（:47）；handshake 必带身份后降级为兜底 | handler.ts:846 |
| session/init-telemetry.ts | 64 | M | 状态跃迁埋点装饰器，入口换成 /session/answer | — |
| session/model-intent-telemetry.ts | 67 | M | SSE 关流后批量写 tool_use 意图；改由 turn/end 上报 | handler.ts:53 |
| session/one-shot-detect.ts | 27 | M | 扫 system 消息找 `[[one-shot-subagent]]`（:12-26）；插件可直接给 isSubagent 标志 | handler.ts:52 |
| session/restore-space-id.ts | 42 | K | 恢复会话时按 URL 回填 space_id，否则内核答错租户（:5-22） | handler.ts:1127 |

## 4. tdai/**（L0 写入链）

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| tdai/types.ts | 101 | K | TdaiMemoryConfig / TdaiIdentity(:21) / TdaiMessage(:61) | 全 tdai |
| tdai/client.ts | 631 | M | `/v3/conversation/add`（:154）、8192/100 分块常量、recall/inject 三段；L0 段留，recall 改由 /context 调 | recorder、handler |
| tdai/recorder.ts | 234 | M | L0 切片逻辑：classified 全量（:148-190）/ legacy 单条（:47-93）；写边界 stripDshAcpTags(:174/:205)；per-session sha256 指纹去重（:107-127，上限 200 会话） | handler.ts:1921/2207 |
| tdai/pending-writes.ts | 109 | M | withL0Retry 3 次退避（:74）、flushPendingWrites 10s（:53）；**头注释自认 /add 无幂等键**（:22-25） | index.ts:165 SIGTERM |
| tdai/identity.ts | 47 | K | deriveTdaiIdentity 无默认值，缺字段即 null（:22-38） | — |
| tdai/bearer-token.ts | 52 | K | env → yaml → 历史 token 三级取值（:48） | 4 处调用 |
| tdai/capabilities.ts | 104 | K | DEFAULT_ASSET_CAPABILITIES(:4) + fetchAssetCapabilities(:57) | handler.ts:1382 |
| tdai/sentinel.ts | 94 | K | log-only 哨兵（5min 窗 / 空召回率 0.8 / 红线只打日志，:1-14） | — |

**插件直报结构化 turn 后可删的东西**：`isExtractableUserInput` 的「不以 `<` 开头」启发式（recorder.ts:47-57）、`isDshRuntimeContextSnapshot` 嗅探、extractLatestUserMessage / extractLatestDshUserMessage 双通道（:59/:84）、ACP 标签写边界剥除（上移到插件侧）。**captureMode 可整体塌成一档**：插件上报时已带 classification，legacy/shadow 双跑（:141-163）失去意义。

**幂等补法**：`/v3/conversation/add` 加 `client_turn_id`（= session_id + turnSeq + role 的 hash），core 侧建唯一索引；比让 proxy 做指纹集合（现有 200 会话内存上限、重启即清空）更彻底。

**可删的兜底**：streaming 的 30s `l0Timer`（handler.ts:2201-2234，防 dsh SSE tool-loop 不触发 flush）——插件 turn/end 是同步 HTTP，不需要。

## 5. mem-command/**（文本命令层）

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| commands/session-reset.ts | 142 | M | 写 uninitialized + resetEpoch + 删 binding（刻意不写 pending_asset_confirm）；保留，入口改 /v3/dsh/tools/* | store/bindingRepo |
| commands/sync.ts | 74 | M | → refreshSessionCache 重拉 team/agent | routes/session-refresh.ts |
| commands/create-skill.ts | 50 | M | → forceArchiveSkill | routes/session-force-archive.ts |
| commands/create-task.ts | 226 | M | 两阶段确认（pending-store 5min TTL） | routes/session-task.ts |
| commands/update-task.ts | 216 | M | 同上 | 同上 |
| commands/help.ts | 89 | D | 静态 HELP_TEXT 表 | — |
| parser.ts | 138 | D | 取最后一条 user 消息、要求整条以 `mem:` 开头、per-command 参数表（:1-40） | index.ts |
| pre-intercept.ts | 86 | M | 唯一的 session-reset 前置钩子；只留 reset，删 input[]/messages[] 双形态嗅探（:1-40） | handler.ts:872/891 |
| pending-store.ts | 95 | M | 内存 Map + 5min TTL + 重启即丢；若 dsh slash 支持二次确认则可删 | create/update-task |
| response-builder.ts | 284 | D | 逐协议伪造 assistant 响应（:9/`:35`/`:99`/`:120`/`:148`/`:168`）+ Anthropic thinking 占位 | index.ts:90 |
| task-draft-generator.ts | 632 | D | 调 LLM 从近期消息起草任务标题/描述 | create-task |
| types.ts | 62 | M | MemCommandContext 缩水 | — |
| utils.ts | 101 | M | extractSimpleMessages 归一化，只留 reset 需要的 | — |
| index.ts | 90 | M | KNOWN_COMMANDS 由 5 个 action 承载，删 parse/execute 文本分支 | handler.ts:1267 |

## 6. agent-adapters/**（全 D，848 行）

| 文件 | 行 | D/M/K | 依据（path:line） | 连带 |
|---|---|---|---|---|
| dsh.ts | 196 | D | classifyRequest = compact 头 > title-gen body 形状 > main（proxy 侧路由判断），extractUserText 解析两种 wire；流量不过代理后两侧都无消费者 | handler/anthropicHandler 的 isAuxiliary 判定 |
| claude-code.ts 25 / codebuddy.ts 53 / codex.ts 123 / workbuddy.ts 221 | — | D | 各端 classify（fork/sidequery/aux 识别）+ 用户文本抽取 | handler 系列 |
| opencode.ts 68 / pi.ts 20 / default.ts 41 | — | D | 同上 | — |
| types.ts 56 / index.ts 45 | — | D | AgentAdapter 接口 + resolveAgentAdapter 分发（:26） | 全仓 22 处 |

## 7. 合并账目

- **D 共 ~9,000 行**：7 个 form.ts（3,807）+ 2 个 pagination（198）+ 5 个 extractor/cleaner（1,781）+ claude-code/init（1,204）+ codex/index（18）+ 文本命令层（1,143：help/parser/response-builder/task-draft-generator）+ agent-adapters（848）。
- **M 共 ~3,400 行**：codebuddy/init 收缩后 ~400 + workbuddy/init 474 + session/index 120 + tdai 三件 974（client/recorder/pending-writes）+ mem-command 1,056（5 action 708 + pending-store/types/utils/index）+ preset 117 + 三件埋点 158 + dsh-ptc-preset 97。
- **K 共 ~1,960 行**：store 828 / context-injector 290 / session-key 86 / registrar 35 / types 243 + tdai 五件 398（identity/bearer/capabilities/sentinel/types）+ user-session-init-preset 39 + restore-space-id 42。

## 8. 不确定清单

1. `session/dsh-ptc-preset.ts:47` — handshake 必带身份后，"配置代供"是否还有兜底价值？标 M，可能降为 D。
2. `codebuddy/init.ts` 1635 行里真正的业务内核估 ~400 行，需按 completeRegistration 的实参依赖再核一遍（本轮未逐函数验证）。
3. dsh 原生 slash command 能吸收哪几个 mem: 命令未验证；create-task / update-task 依赖两步确认，若 slash 不支持二次交互就得留服务端 pending-store。
4. `agent-adapters/dsh.ts` 的 compact/title-gen 分类：若控制面按 README §3 的 M1 口径保留计费骨架，classifyRequest 可能仍需留 ~30 行。
5. `session/codebuddy/cleaner.ts:80` 的 stripInitArtifacts 与 `claude-code/cleaner.ts:4` 的"已删除"注释矛盾；删文件时以代码为准。
