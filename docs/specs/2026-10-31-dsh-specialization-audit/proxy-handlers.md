# Proxy 五个 handler 内部逐函数删改清单（task-4）

前提：dsh 插件直连模型，agent LLM 流量不再过 proxy；proxy 只剩（a）记忆控制面 `/v3/dsh/*`（当前仓库 0 命中，未实现（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）），（b）**内部专用最小 LLM 网关**——core/panel/knowledge 的 LLM 出口走 `/proxy/<iid>/v1` + `llm-providers` 凭据。判定：**D** 删 / **M** 改（保留骨架、剥语义）/ **K** 留。行数按 `wc -l` 区间。

## 1. src/handler.ts（2516 行，21 声明）——唯一保留文件：改成内部网关 M

| 函数 | 行号 | 行数 | 判定 | 理由（一行） |
|---|---|---|---|---|
| memberStore | 69-72 | 4 | M | 网关要按 `llm-providers` 取成员/租户凭据，缓存单例保留 |
| resolveMemberOverride | 74-80 | 7 | M | 凭据解析入口，改为「内部调用方 → provider 凭据」 |
| createTdaiClient | 88-102 | 15 | D | L0 写入搬插件侧（`/v3/dsh/turn/end`），proxy 不再需要 TDAI 客户端 |
| flattenMessagesForOpik | 107-224 | 118 | D | dsh 对话的可观测性搬插件侧；网关只要原始 body + usage |
| SKIP_REQUEST_HEADERS | 226-233 | 8 | M | header 手术仍要（含 `expect`，undici 拒 100-continue） |
| SKIP_RESPONSE_HEADERS | 235-240 | 6 | M | 同上，响应侧 |
| extractSseUsage | 243-263 | 21 | M | 网关计费仍需从 OpenAI SSE 抽 usage（且被 systemUserPassthrough.ts:49 依赖） |
| buildUpstreamBody | 269-278 | 10 | D | 只做 cost-guard 的 `bodyOverrides`；路由没了就没有 override |
| buildUpstreamHeaders | 285-318 | 34 | M | 网关鉴权注入（Bearer / x-api-key + `x-vertex-ai-session-id`）保留，去掉 authHeaders 分支 |
| forwardWithRetry | 323-467 | 145 | M | 只留 fetch + 超时 + 错误映射；retryTarget/rateLimitContext/PROXY_DEBUG_DUMP_* 全剥（可压到 ~40 行） |
| GO_ALLOWED_BODY_FIELDS | 472-476 | 5 | D | opencode.ai 上游字段白名单，纯 agent 场景补丁 |
| stripNonStandardFieldsForGo | 481-491 | 11 | D | 同上，host=opencode.ai 专用归一化 |
| handleChatCompletions | 494-2045 | 1552 | M | 网关主体：auth→凭据/模型别名→model gate→计费转发。整段删 session-init(938-1228)、mem-command(1254-1395)、injection(1409-1447)、cost-guard/marker(1448-1510)、agent 分类(759-864)、turnSeq/langfuse/opik(1517-1593)——目标 ~250 行 |
| assistantContentForTdai | 2048-2061 | 14 | D | L0 文本组装，随 L0 一起搬插件 |
| outputMessageContent | 2063-2065 | 3 | D | 同上 |
| TapContext | 2069-2114 | 46 | D | tap 上下文全是为 agent 会话埋点设计 |
| ToolCallAccumulator | 2117-2122 | 6 | D | 工具调用累积只服务 skill/model_intent 埋点 |
| SseExtractResult | 2125-2128 | 4 | D | 同上 |
| extractSseContentAndTools | 2131-2169 | 39 | D | 插件侧拿到 assistant-stream 帧，无需解析 SSE 文本 |
| mergeToolCallDeltas | 2172-2187 | 16 | D | 同上 |
| createUsageTapTransform | 2192-2515 | 324 | M | 只留 usage 抽取（`extractSseUsage`），删 flushL0/trackWrite/notifyUpstreamResponse/emitModelIntentTelemetry/writeLog 段（→ ~50 行） |

**删后预估：2516 → ~470 行**（保留 auth + 凭据解析 + header 手术 + 转发 + usage 计费 + 响应透传）。

## 2. src/anthropicHandler.ts（2391 行，18 声明）——整段 D

| 函数 | 行号 | 行数 | 判定 | 理由 |
|---|---|---|---|---|
| memberStore / resolveMemberOverride | 71-82 | 11 | D | 仅 CC/CB 成员模型覆盖用，网关在 handler.ts 侧已有一份 |
| SKIP_REQUEST/RESPONSE_HEADERS | 84-98 | 14 | D | 随文件删（handler.ts 有等价常量） |
| createTdaiClient | 106-120 | 15 | D | L0 搬插件侧 |
| stringifyAnthropicSystem | 128-142 | 15 | D | Anthropic `system` 扁平化只为 trace 展示 |
| buildLangfuseInput | 156-171 | 16 | D | debug 双模 trace 展示；无 agent 会话即无意义 |
| flattenAnthropicMessagesForOpik | 181-272 | 92 | D | 同上，且会丢 cache_control/thinking 签名 |
| extractApiKey | 275-284 | 10 | D | dsh 不再走 Anthropic 协议（server.ts:325 的 `/dsh/:spaceId/messages` 路由同步删） |
| hasValidThinkingSignature | 290-297 | 8 | D | 无上游 thinking 签名透传场景（插件直连模型，签名不经 proxy） |
| sanitizeThinkingBlocks | 304-335 | 32 | D | thinking 占位/清洗彻底不需要（见焦点判断） |
| buildUpstreamBody | 340-358 | 19 | D | max_tokens 夹取 + 清洗，两者都消失 |
| buildUpstreamHeaders | 363-400 | 38 | D | x-api-key/authorization 二选一 + session header，Anthropic 协议专属 |
| forwardWithRetry | 405-553 | 149 | D | retryTarget 属 cost-guard；网关版在 handler.ts |
| handleAnthropicMessages | 556-1883 | 1328 | D | 整条 Anthropic 流水线（session-init/mem/injection/SSE 定型） |
| createSseThinkingFixStream | 1889-1983 | 95 | D | 见焦点判断 |
| AnthropicTapContext | 1987-2031 | 45 | D | 随 tap 删 |
| consumeAnthropicStream | 2036-2390 | 355 | D | 见焦点判断；usage 语义由插件 assistant-stream 提供 |

**删后预估：2391 → 0**。

## 3. src/codexHandler.ts（1448 行，24 声明）——整段 D

| 函数 | 行号 | 行数 | 判定 | 理由 |
|---|---|---|---|---|
| memberStore / resolveMemberOverride | 68-79 | 11 | D | 同 anthropic，重复实现 |
| SKIP_*_HEADERS | 83-96 | 13 | D | 随文件 |
| createCodexTdaiClient | 105-119 | 15 | D | L0 搬插件 |
| extractLatestCodexUserMessage | 128-134 | 7 | D | Responses `input[]` 解析，无协议即无意义 |
| CodexSessionState | 138-142 | 5 | D | 状态机搬控制面 |
| CODEX_AUX_PATH_SUFFIXES / THREAD_SOURCES | 147-157 | 9 | D | compact/trace_summarize/realtime 的 aux 分流消失 |
| classifyCodexRequest | 163-182 | 20 | D | 同上 |
| extractCodexSessionId | 190-198 | 9 | D | session 由 `/v3/dsh/handshake` 建立 |
| detectDefaultModeGate | 213-221 | 9 | D | 已是 test-only（逻辑在 session/codebuddy/init.ts） |
| injectCodexAssets | 234-255 | 22 | D | `<tdai_injections>` 注入改由 `/v3/dsh/context` 下发 |
| buildUpstreamHeaders / filterResponseHeaders | 259-285 | 26 | D | 随文件 |
| handleCodexEndpoint | 296-945 | 650 | D | 整条 Responses 流水线（synthetic body、form 重渲染） |
| CodexArchiveCtx / buildArchiveCtx / triggerCodexArchiveHooks | 982-1110 | 117 | D | skill+L0 归档钩子搬插件/控制面 |
| forwardToUpstream | 1114-1253 | 140 | D | 无 cost-guard/retry/rate-limit 的手写转发，被网关取代 |
| countHumanTurnsCodex / buildCodexLangfuseInput | 1264-1287 | 17 | D | turn 计数随 trace 消失 |
| CodexTapContext / consumeCodexStream | 1289-1447 | 148 | D | 见焦点判断 |

**删后预估：1448 → 0**。连带删 src/common/codex-injection.ts、src/session/codex/form.ts、src/agent-adapters/codex.ts、whitelist 的 `/responses*` 条目、server.ts:252-260 路由。

## 4. src/workbuddyHandler.ts（1476 行，23 声明）——整段 D

| 函数 | 行号 | 行数 | 判定 | 理由 |
|---|---|---|---|---|
| memberStore / resolveMemberOverride | 67-78 | 11 | D | 重复实现 |
| SKIP_*_HEADERS | 82-95 | 13 | D | 随文件 |
| WorkbuddySessionState | 109-113 | 5 | D | 状态机搬控制面 |
| DEFAULT_GATE_PREFIX | 128-141 | 14 | D | 抄 codex 的 gate 字符串（TODO 未抓包实证） |
| classifyWorkbuddyRequest | 145-171 | 27 | D | aux 子串分流消失 |
| extractWorkbuddySessionId | 184-197 | 9 | D | 同上 |
| detectWorkbuddyDefaultModeGate | 212-224 | 13 | D | 同上 |
| injectWorkbuddyAssets | 244-265 | 22 | D | 注入改 `/v3/dsh/context` |
| countHumanTurnsWorkbuddy | 280-291 | 12 | D | trace 消失 |
| WorkbuddyArchiveCtx / extractLatestWorkbuddyUserMessage / createWorkbuddyTdaiClient / buildWorkbuddyArchiveCtx / triggerWorkbuddyArchiveHooks | 300-460 | 160 | D | L0/skill 归档钩子搬插件 |
| buildWorkbuddyLangfuseInput / buildUpstreamHeaders / filterResponseHeaders | 476-505 | 30 | D | 随文件 |
| forwardToUpstream（含 /workbuddy/<spaceId> 剥离、SSE 判定） | 511-659 | 149 | D | 被网关取代 |
| WorkbuddyTapContext / consumeWorkbuddyStream | 664-836 | 162 | D | 见焦点判断 |
| handleWorkbuddyEndpoint | 856-1475 | 620 | D | 整条流水线（与 codex 近乎复制，且 sessionKey 硬编码 `codex:`） |

**删后预估：1476 → 0**。连带删 src/common/workbuddy-injection.ts、src/agent-adapters/workbuddy.ts、server.ts:268-276 路由。

## 5. src/auxiliaryHandler.ts（304 行，7 声明）——D（保留条件见不确定清单）

| 函数 | 行号 | 行数 | 判定 | 理由 |
|---|---|---|---|---|
| SKIP_*_HEADERS | 35-48 | 12 | D | 随文件 |
| buildAuxUpstreamHeaders | 58-81 | 24 | D | count_tokens/embeddings/completions 的按协议注入 |
| filterResponseHeaders | 84-92 | 9 | D | 同上 |
| extractModelId | 98-107 | 10 | D | 仅日志用 |
| extractUsageFromResponse | 118-143 | 26 | D | count_tokens 特例 `{input_tokens}` 解析 |
| handleAuxiliaryEndpoint | 160-303 | 144 | D | 白名单端点透传；agent 场景无调用方 |

**删后预估：304 → 0**。

## 6. src/systemUserPassthrough.ts（716 行，15 声明）——整段 D

| 函数 | 行号 | 行数 | 判定 | 理由 |
|---|---|---|---|---|
| SKIP_*_HEADERS | 70-83 | 12 | D | 随文件 |
| buildPassthroughHeaders | 95-110 | 16 | D | 内部服务账号改走 `/proxy/<iid>/v1` + llm-providers 凭据 |
| filterResponseHeaders | 113-121 | 9 | D | 同上 |
| tryParseJson / readModelId | 127-145 | 17 | D | trace 用解析 |
| extractNonStreamUsage | 155-167 | 13 | D | 网关版 usage 抽取在 handler.ts |
| recordTracesAndUsage | 181-403 | 223 | D | 内部流量可观测性由网关的 writeLog 取代 |
| normaliseForOpikInput / normaliseForOpikOutput / opikSpanInputMessages / opikSpanOutputMessage | 410-450 | 24 | D | Opik 载荷整形 |
| handleSystemUserPassthrough | 462-636 | 175 | D | 整条「免业务、只观测」旁路；新架构下内部调用方本身就是网关主路径 |
| consumeStream | 646-690 | 45 | D | 见焦点判断（512KiB raw 截断 + usage 双解析） |
| mergeAnthropicUsageFromEvent | 693-715 | 23 | D | Anthropic usage 合并 |

**删后预估：716 → 0**。

## 焦点判断（为什么插件化后不需要）

- **SSE tap（consumeAnthropicStream 355 行 / consumeCodexStream 131 / consumeWorkbuddyStream 141 / createUsageTapTransform 324 / consumeStream 45）**：都在「字节流里反解语义」。插件直连模型时拿到的是结构化 assistant-stream 帧（usage/text/tool_calls 原生字段），反解纯属重复劳动；网关只保留 `extractSseUsage`（计费必需）。→ 全 D，仅 usage 抽取 M。
- **thinking 占位/清洗（sanitizeThinkingBlocks 32、createSseThinkingFixStream 95、NONSTREAM 补丁 anthropicHandler.ts:1622-1640）**：存在理由只有一条——非 Anthropic 上游产出的 thinking 块缺 `thinking` 字段，会让 Claude Code 崩（`s.thinking.length`）。dsh 插件不经 Claude Code 客户端渲染，占位彻底无意义。→ 全 D。
- **max_tokens 夹取（anthropicHandler.ts:351-355，>131072→131072，缺失→4096）**：为 Ark 上游 `[1,131072]` 约束兜底；网关用 llm-providers 里同一批凭据，可直接在 provider 配置侧钳制。→ D。
- **模型别名（resolveModelId 调用点 handler.ts:639、anthropicHandler.ts:612）与 model gate（enforceModelGate）**：别名是「客户端面向名 ↔ 上游 model_id」的映射，只服务 agent 客户端自带的名字；网关仍需要 `llm-providers` → model_id 的解析，判 **M**（保留别名，删 `creditPricing` 版 gate）。
- **retryTarget（forwardWithRetry 145+149+140 三份）**：cost-guard 路由到便宜模型失败时回退「客户原本要的模型」。没有路由就没有回退目标。→ D，网关只需一次 fetch + 超时。
- **synthetic body（codexHandler.ts:893-940、workbuddyHandler.ts:1405-1448）**：把 injection pipeline 硬塞进 OpenAI `messages[]` 再抽出 system 文本回填 `input[0]`。插件化后上下文由 `/v3/dsh/context` 直接返回结构化块。→ D。
- **marker 路由（`useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(path) : true`）**：整段随 cost-guard 消失。→ D。

## 跨文件连带（删了要跟着改）

| 被删符号 | 使用者 | 处置 |
|---|---|---|
| `extractSseUsage`（handler.ts:243） | src/systemUserPassthrough.ts:49 | 两文件同批删；网关若留用，挪到新网关模块 |
| `handleSystemUserPassthrough` | src/handler.ts:43、src/anthropicHandler.ts:43、src/auxiliaryHandler.ts:32 | 三处 import 同批删；`src/systemUser.ts` 的匹配逻辑可留待配置清理 |
| `joinUrl`（src/guard-adapter.ts） | codexHandler:33、workbuddyHandler:25、auxiliaryHandler:28、systemUserPassthrough:47 | 分支删后仅 handler.ts 需要；guard-adapter 的 cost-guard 半边整体 D |
| `writeLog` / `createPipeline`（src/logger.ts） | 全部 5 个 handler | 网关保留 usage 行；pipeline 事件可缩到 3 个 |
| `notifyUpstreamResponse`（request-prepare-adapter.ts:360） | handler.ts:2279、anthropicHandler.ts:1642/2172、codexHandler:（无，archiveCtx 替代） | 私有扩展一起下线后删 |
| `buildRequestDebugMetadata`（common/langfuse-debug.ts） | handler/anthropic/codex/workbuddy | 随 trace 删 |

## 删后行数汇总

| 文件 | 现 | 删后 | 剩什么 |
|---|---|---|---|
| src/handler.ts | 2516 | **~470** | auth + 凭据/别名解析 + header 手术 + 单次转发 + usage 计费 + 响应透传 |
| src/anthropicHandler.ts | 2391 | 0 | — |
| src/codexHandler.ts | 1448 | 0 | — |
| src/workbuddyHandler.ts | 1476 | 0 | — |
| src/auxiliaryHandler.ts | 304 | 0 | — |
| src/systemUserPassthrough.ts | 716 | 0 | — |
| 合计 | 8851 | **~470** | 削减 ~94.7% |

## 不确定清单

1. **embeddings / count_tokens 是否仍需过 proxy**：knowledge / core 若把 embedding 也走 `/proxy/<iid>/v1/embeddings`，auxiliaryHandler.ts 从 D 升 M（保留 `handleAuxiliaryEndpoint` 144 行 + `extractUsageFromResponse`），代价 ~250 行。需 panel/core 侧确认调用点。
2. **内部网关是否需要流式给 core**：core 若用 stream=true，`createUsageTapTransform` 的 usage 抽取必须保留（M）；若统一非流式，可连 `extractSseUsage` 一起删。
3. **systemUser 白名单是否还有别的消费者**：`src/systemUser.ts` 的 `matchSystemUserByUserId` 目前只被三个 handler 调用；若配置里仍有 `systemUsers` 条目，需要一次配置清退，否则删 handler 后是死配置。
4. **`/v3/dsh/*` 尚不存在**（全仓 grep 0 命中）：本清单是目标态推演，插件侧 handshake/turn-end 契约未落地前，handler 不能真的删——否则记忆写入断流。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）。
5. **workbuddy sessionKey 硬编码 `codex:`（workbuddyHandler.ts:970/1022）**：若短期只删 codex 不删 workbuddy，会留下跨客户端共享状态机的孤儿键；两个文件必须同批处理。
