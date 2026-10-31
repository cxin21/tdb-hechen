# dsh 插件 ↔ MemoryCore v3 契约一致性复核（task-34）

- 复核对象：`dsh-plugin/src`（只读）↔ `MemoryCore/src/gateway` 的 v3 数据面
- 方法：静态逐字段对照（core 校验点行号 ↔ 插件构造点行号）+ 活体探针 `scratch/probe-core-conformance.mjs`（34 项，全部通过 = 实测与本文档一致）
- 探针环境：core `http://127.0.0.1:8420`，profile `MemoryCore/tdai-gateway.yaml`（`v3Recall.enabled: true`，`:287-288`）；命名空间 `team/agent/user = dshprobe`，会话 `probe-conf-<run>-<tag>`（一次性）
- 本次 run：`1793455078781`；探针只做写入 L0/L2 的 throwaway 数据，L0 会话跑完即删（见 §8）

## 1. 结论摘要

| 级别 | 数量 | 一句话 |
|---|---|---|
| P0 | 2 | ① `/v3/recall` 插件从不发隔离三轴 ⇒ 生产恒 422，合并召回是死链路；② 分片只按条数/字符、不按字节 ⇒ 超过 1 MiB 时 core 直接销毁连接（不是 413），整批写入重试后进死信 |
| P1 | 4 | skill 面过度截断（core 无 content 上限）；L0 timestamp 原样透传不做归一；skill 面业务错误走 HTTP 200 + code 40001 导致插件侧零告警；L0 写入失败"可重试"判定对确定性 4xx 也成立 |
| P2 | 4 | L0 不校验 id 里的 `|`（与 skill 不一致）；文档称 skill 拒 ISO 时间戳（实测接受）；L0 8192 按**码点**计数（插件按 UTF-16，方向安全）；body 超限用 `req.destroy()` 而非 413 |

**结构上是健康的**：隔离三轴在 body 里（`memory-client.ts:335`）与 `collectV3Missing`（`v2-router.ts:174-194`）口径一致；role 枚举、空 content、tool 成对、条数上限（100 / 500）、skill id 的 `|` 禁止全部对得上；L0 写入幂等（F-DUP-1）使分片重试安全。两处 P0 都在"插件构造请求"一侧，core 不需要改。

## 2. 公共层（所有 v3 调用共用）

| 契约 | core 位置 | 插件位置 | 探针 | 结论 |
|---|---|---|---|---|
| 鉴权 `Authorization: Bearer <apiKey>`，否则 401 | `server.ts` auth 前置 | `memory-client.ts:292-303` `headers()` | 探针用 `tdai-gateway.yaml:24` 的 key | ✅ |
| `x-tdai-service-id` 缺省 `default` | skill-handlers `auth.serviceId` 回落（`:961-974`） | `memory-client.ts:295` | S1 | ✅ |
| **隔离三轴** `team_id/agent_id/user_id`：body 优先，header `x-tdai-{team,agent,user}-id` 兜底 | `v2-router.ts:174-194` 构造、`:732-740` 拦截（422） | body：`memory-client.ts:335` `{...this.isolation(), ...body}`；header：**只发 `x-tdai-service-id` 与 `x-tdai-session-id`（`:295`、`:445`），从不发三轴 header** | P7d / S6 | ⚠️ 只有 `includeIsolation=false` 的那条路径会缺三轴（见 P0-1） |
| 业务错误 = `{code!==0, message}`；HTTP 状态由 `code` 决定（400..599 原样，其余 200） | `v2-router.ts:762-764` | `memory-client.ts:342-352`（401/403 单独处理，`:350` 非 2xx 返回 status） | P2 / P4 / P14 | ⚠️ 只对 v2/L0 路由成立，skill 路由固定 200（见 P1-3） |
| 请求体上限 1 MiB（`MEMORY_MAX_BODY_BYTES`），超限 `reject(PayloadTooLargeError)` + `req.destroy()` | `server.ts:257`、`:264-272`、`:274-315`（`:279-283` 提前判 `content-length`、`:308-311` 累计超限） | 分片只按条数（`wire-limits.ts:76-83` `chunkMessages`）+ 单条字符（`:47-73` `truncateForCore`） | P8 / P8b / S3 / S4 | ❌ P0-2 |
| 传输失败/超时分类 | — | `memory-client.ts:378` `transport failure: <detail>`；`:342-350` HTTP | P8 → `TypeError: fetch failed`，`cause.code=ECONNRESET` | 见 P0-2 |

## 3. L0：`POST /v3/conversation/add`

core 契约：`MemoryCore/src/gateway/generated/schemas.ts:82-98`

| 字段 | core 校验 | 插件发送 | 探针 | 结论 |
|---|---|---|---|---|
| `session_id` | `:94` `z.string()`（可选，缺省铸临时 session）；**无 `|` 校验** | `memory-client.ts:510-514` 空则跳过；`ids.ts:21-45` 取宿主 session.id（可能含 `|`） | P10（不带 → 200）、P16（含 `|` → 200） | ⚠️ P2-1 |
| `messages` 条数 | `:96` `.min(1).max(100)` | `wire-limits.ts:20` `CORE_MAX_MESSAGES_PER_REQUEST=100`，`:540` 分片 | P3（101 → 400） | ✅ |
| `role` | `:31` `enum(['user','assistant'])` | `memory-client.ts:518` 过滤（只留 user/assistant），`:527` 原样发送 | P11（tool_call → 400） | ✅ |
| `content` | `:88` `.min(1).max(8192)`（**按码点**） | `:519-525` 空跳过 + `truncateForCore(8192)`（UTF-16 单元 + `\n…[truncated: N chars]`） | P1/P2（8192/8193 ASCII）、P15a/P15b（8193 单元=4097 码点 → **200**）、S7（8192 汉字） | ✅ 方向安全（见 P2-3） |
| `timestamp` | `:89` `z.iso.datetime()`：必须是带 `Z` 的 ISO | `:529` `nonEmpty(message.timestamp) ?? new Date().toISOString()` —— **不归一，原样透传**；`writeback.ts:156-163` `isoOf` 产出 `toISOString()` | P12（数字 → 400）、S2（`+08:00` → 400 `Invalid ISO datetime`） | ⚠️ P1-2（当前链路安全，靠 writeback） |
| 隔离三轴 | `idFieldsSchema` 必填（`v2-router.ts:189-191`，缺失 → 422） | `:335` merge | S8-S11 带三轴全 200；不带 → 422 | ✅ |

## 4. L2 技能面：`POST /v3/skill/conversation/add`

core 契约：`MemoryCore/src/gateway/skill-schemas.ts:53`、`:73-79`、`:254-264`；handler `skill-handlers.ts:937-974`、路由 `:1154`；`|` 二次校验 `add-handler.ts:382`

| 字段 | core 校验 | 插件发送 | 探针 | 结论 |
|---|---|---|---|---|
| `session_id` | 必填，禁 `|` | `:587-597` 前置自检（含 session） | P16b → 200 / 40001 `session_id must not contain '|'` | ✅（但业务错误是 200，见 P1-3） |
| `space_id` | **可选**（`:256-258`），缺省回落 `auth.serviceId` | **从不发送** | S1 → 200 | ✅ |
| `messages` 条数 | `.min(1).max(500)` | `wire-limits.ts:22` 500，`:629` 分片 | P14（501 → 200/40001） | ✅ |
| `role` | 五值（含 tool_call/tool_result） | `:602` `SKILL_ROLES` 过滤 | P4b → 200 | ✅ |
| `content` | `z.string()`，**无上限** | `:605` `truncateForCore(8192)` | P9（9000 字符 → **200**） | ❌ P1-1 过度截断 |
| `tool_call/tool_result` 成对 | 必须同时有 `tool_name` + `tool_call_id`（`:73-79` + handler） | `:608-616` 半对直接丢弃（不猜测） | P4（缺 id → 40001）、P4b | ✅ |
| `timestamp` | `z.union([z.number(), z.string()])`，**接受 ISO 串** | `:617` `skillTimestamp()` 转 epoch ms | P5（ISO → **200**） | ⚠️ P2-2（文档与 `memory-client.ts:34/64` 注释称会 400，实测接受） |
| `team_id/agent_id/user_id` | 必填，禁 `|` | `:335` merge（`ids.ts` 可能含 `|`，前置自检只覆盖 session/space？见下） | P16c → 200/40001 | ✅ |

> 注：`memory-client.ts:587-597` 的自检覆盖 `session_id` + `isolation()` 里的 team/agent/user 三轴（`:592-596` 用 `Object.entries(this.isolation())` 逐项查 `|`），所以插件路径下 P16b/P16c 这两类 40001 实际到不了 core；探针 P16b/P16c 是按"外部调用方"形状直接打服务端。`space_id` 插件从不发送，`z.optional()`（`:256-258`）也不校验缺失。

## 5. 读路径：`/v3/recall` 与 `core/read` / `scenario/ls` / `atomic/search` / `conversation/delete`

| 接口 | core | 插件 | 探针 | 结论 |
|---|---|---|---|---|
| `/v3/recall` | `v2-router.ts:1894-1938`：`v3Recall.enabled=false` → 404；`query` 非空必填；`maxResults` 正整数；`time_point` ISO；**严格闸门（`v2-router.ts:732-740`）要求三轴** | `memory-client.ts:430-455` `recallBlock()`：`includeIsolation=false`（`:323`）且只加 `x-tdai-session-id`（`:445`） | **P7/P7b/P7c → 422 `missing team_id, agent_id, user_id`**；P7d（body 三轴）→ 200；S6（header 三轴）→ 200 | ❌ P0-1 |
| `/v3/core/read` | v3 子路径（严格闸门覆盖） | `:392-397` `post(path, {})` → body 只有三轴 | S8 → 200 | ✅ |
| `/v3/scenario/ls` | 同上 | `:414-418` | S9 → 200 | ✅ |
| `/v3/atomic/search` | v3 子路径 | `:400-411` `{query, limit}`（1..50） | S10 → 200 | ✅ |
| `/v3/conversation/delete` | 批量删、去重、至少一项 | `:671-672` `{session_ids:[session]}` | S11 → 200 | ✅ |

recall 失败时插件的降级：`index.ts:240-250` `warnRecallFailure` → `warnOnce('recall', …)`，随后 `index.ts:362-370` 回落到 `client.recallCombined`（`memory-client.ts:458-490`：`Promise.all([recall, searchAtomic, listScenarios])`，三个请求都带三轴，探针 S8-S10 已验证 200）。**所以 P0-1 不是功能全失，而是"服务端合并召回永久失效、退回客户端拼装"；只 warn 一次，hint 只覆盖 404/504，422 落到兜底文案，没人会去查"插件根本没发三轴"。**

## 6. 探针实测表（`node scratch/probe-core-conformance.mjs`，34/34）

| id | 场景 | 期望 | 实测 |
|---|---|---|---|
| P1 | L0 单条 8192 ASCII | 200 | 200 |
| P2 | L0 单条 8193 ASCII | 400 | 400 `content: <=8192` |
| P3 | L0 101 条 | 400 | 400 `messages: <=100` |
| P15a | L0 4096 emoji（8192 UTF-16 单元） | 200 | 200 |
| P15b | L0 8193 UTF-16 单元 = 4097 码点 | 200 | 200（证明按码点计数） |
| P10 | L0 不带 session_id | 200 | 200 |
| P11 | L0 role=tool_call | 400 | 400 |
| P12 | L0 timestamp=epoch 数字 | 400 | 400 |
| P13 | L0 content="" | 400 | 400 |
| P16 | L0 session_id 含 `|` | 200 | 200（无该校验） |
| P8 | L0 100×4000 汉字（1.20 MB） | 连接被重置 | `fetch failed` / `ECONNRESET` |
| P8b | L0 100×3000 汉字（≈0.9 MB） | 200 | 200 |
| P4 | skill tool_call 缺 tool_call_id | 200 + 40001 | 200 + 40001 |
| P4b | skill tool 成对 | 200 | 200 |
| P5 | skill timestamp=ISO 串 | 200 | 200 |
| P9 | skill content 9000 字符 | 200 | 200 |
| P14 | skill 501 条 | 200 + 40001 | 200 + 40001 |
| P16b | skill session_id 含 `|` | 200 + 40001 | 200 + 40001 |
| P16c | skill team_id 含 `|` | 200 + 40001 | 200 + 40001 |
| P7 | recall 插件真实形状（无三轴） | 422 | 422 |
| P7b | recall maxResults=0（插件形状） | 422（闸门先于校验） | 422 |
| P7c | recall 只带 query | 422 | 422 |
| P7d | recall body 带三轴 | 200 | 200 |
| S1 | skill 不带 space_id（插件真实形状） | 200 | 200 |
| S2 | L0 timestamp `+08:00` | 400 | 400 `Invalid ISO datetime` |
| S3 | L0 100×3500 汉字（1.05 MB） | 连接被重置 | `fetch failed` |
| S4 | skill 500×2500 汉字（3.75 MB） | 连接被重置 | `fetch failed` |
| S5 | 超限批次后 conversation/query | 200 | 200（无半写崩溃） |
| S6 | recall 三轴走 **header** | 200 | 200 |
| S7 | L0 单条 8192 汉字（24 KB body） | 200 | 200 |
| S8 | core/read 插件形状 | 200 | 200 |
| S9 | scenario/ls 插件形状 | 200 | 200 |
| S10 | atomic/search 插件形状 | 200 | 200 |
| S11 | conversation/delete 插件形状 | 200 | 200 |

## 7. 偏差清单

### P0-1 插件 `/v3/recall` 恒 422（合并召回是死链路）— 归属：插件

- 证据：`memory-client.ts:323` 传 `includeIsolation=false`、`:335` 因此不 merge 三轴、`:445` 只补 `x-tdai-session-id`；core `v2-router.ts:189-193` 明确要求三轴，缺失即 422（`:732-740`）。探针 P7/P7b/P7c 复现，P7d/S6 证明两种修法都可行。
- 影响：`/v3/recall`（服务端 R7 分层 + 预算裁剪的合并块）**从未生效**，每个会话都走 `index.ts:362-370` → `client.recallCombined`（`memory-client.ts:458-490`，内部并发 `/v3/core/read` + `/v3/scenario/ls` + `/v3/atomic/search`，服务端合并排序与预算全部丢失）。不是数据丢失，是**功能静默降级 + 每轮多 2 次往返**；只 warn 一次且 hint 不含 422 解释（`index.ts:243-249`）。
- 最小修法：`memory-client.ts:292-303` `headers()` 常驻 `x-tdai-team-id/agent-id/user-id`（S6 已验证 200，其他接口多余 header 无副作用）；或 `:430-453` recall 保留三轴 body。任一都可，推荐前者（一处改动覆盖所有路径）。
- 顺带：`index.ts:243-249` 给 422 加一条 hint（"the request is missing the isolation triple"），否则修完前仍无指向性。

### P0-2 分片按条数/字符、不按字节，超 1 MiB 被 core 断连而非 413 — 归属：插件

- 证据：`wire-limits.ts:76-83` 只切条数；`memory-client.ts:540`（L0 100 条）、`:629`（skill 500 条）无字节预算。core `server.ts:257` 1 MiB 上限，`:279-283`/`:308-311` `reject + req.destroy()` ⇒ 客户端只能看到 `TypeError: fetch failed`（`cause.code=ECONNRESET, errno=-4077`）。探针 P8/S3/S4 复现；P8b/S7 证明阈值：**单请求约 349k 汉字**即触顶。
- 影响链：
  - L0：`memory-client.ts:547-555` 返回 `ok:false`（无 status）→ `index.ts:479-488` `retryable: true` → outbox 退避重试 → 每次同样超限 → 退避重试到 `maxAttempts`（`config.ts:210-211`：8 次 / 30s，`outbox.ts:212` 判定耗尽）后进 `outbox.dead.jsonl`（payload 不丢，但**这一轮记忆永久缺失**，且 L0 侧 `index.ts:472` 只在 `typeof status === 'number'` 时告警 ⇒ 传输失败**一条 warn 都没有**，只有死信那一刻的 `outbox.dead` warn）。
  - L2：`memory-client.ts:642-645` 仅 `index===0` + 传输失败可重试；超限批次本来就是 index 0 ⇒ 同样重试到死信。
  - 触发条件现实吗：单轮 100 条消息（长工具链的 assistant 逐步消息）且平均 ≥3.5k 汉字即可；插件单条上限 8192 ⇒ 最坏 2.4 MB，是上限的 2.3 倍。**不是常见路径，但一旦命中就是整轮静默丢失。**
- 最小修法：`chunkMessages`（`wire-limits.ts:76-83`）增加 UTF-8 字节预算（建议 700 KB，留 JSON 转义余量），按累计 `Buffer.byteLength` 切分；`call()` 把 `ECONNRESET`/`content-length` 拒绝识别为确定性失败（`status: 413` 语义），不重试直接死信并 warn。core 侧无需改（但见 P2-4）。

### P1-1 skill 面过度截断（8192）— 归属：插件 — **有意保留（Lead 拍板：控 L2 抽取成本）**

- 证据：`skill-schemas.ts:73-79` `content: z.string()` 无上限；探针 P9 9000 字符 → 200。插件 `wire-limits.ts:20` `CORE_MAX_MESSAGE_CHARS=8192` 同一常量用于 L0 与 L2（`memory-client.ts:605`），并追加 `\n…[truncated: N chars]` 标记。
- 影响：L2 提取器拿到的是被截断文本 + 标记（标记本身也会进 prompt/摘要），长工具结果/长文被腰斩。L0 的 8192 是刚需，L2 不是。
- 最小修法：L2 用独立常量（建议 60000，最终仍受 P0-2 的字节预算约束）；`truncated` 计数分开上报。
- **决定（Lead，台面结论）：有意保留 8192。** 理由是 L2 抽取成本（送进抽取器/prompt 的 token 预算）是产品选择，不是缺陷；本复核把它记为已知取舍，不再作为待修项。

### P1-2 L0 timestamp 不归一 — 归属：插件

- 证据：`memory-client.ts:529` 把 `message.timestamp` 原样放进 body（只有缺失时才 `toISOString()`）；core `generated/schemas.ts:89` 只收 `z.iso.datetime()`（默认要求 `Z`）。探针 S2 `+08:00` → 400，P12 数字 → 400。
- 当前链路安全：`writeback.ts:156-163` `isoOf` 统一转 `toISOString()`；风险在"outbox 里的旧行"或"直接调 client 的其他调用方"——一处 `:529` 的脏值会让**整批** 400（`messages.0.timestamp`），且 L0 会重试到死信。
- 最小修法：`:529` 改成 `new Date(ts).toISOString()`（坏值回落 `now()`，与 writeback 的 `isoOf` 同语义）。

### P1-3 skill 面业务错误走 HTTP 200 + code 40001 ⇒ 插件侧零告警 — 归属：core（口径）+ 插件（告警）

- 证据：`v2-router.ts:762` 的 `httpStatus = code∈[400,600) ? code : 200` 是 v2/L0 口径；skill 路由（`skill-handlers.ts:937-1021`）自己包 envelope，业务错误固定 HTTP 200。探针 P4/P14/P16b/P16c 均为 `HTTP 200 + code 40001`。
- 影响：`memory-client.ts:342-350` 只在非 2xx 时带 `status`；`call()` 对 40001 返回 `{ok:false, reason:'code 40001'}`（无 status）。`index.ts:420` 只在 `typeof status === 'number'` 时 `warnOnce('write.skill')` ⇒ **任何 skill 业务拒绝（`|`、缺 tool 对、超 500 条）线上只有 debug 一行**，L2 写入失败完全不可见。L0 同类失败反而有 warn（`:472-478`）。
- 最小修法（择一）：① core 侧让 skill 路由复用 `v2-router.ts:762` 的映射（40001 这种 5 位数码需要显式映射：`code>=400&&code<600` 否则 400 兜底——建议 skill 的 envelope code 也遵循 4xx 区间）；② 插件侧在 `call()` 里对 `code!==0` 补一个 `businessCode` 字段，`index.ts` 据此 warn。②改动小、不动线上状态码，但 ①才是根治（HTTP 语义正确后，所有客户端/探针/监控都一致）。
- 备注：`code=40001` 不在 400..599 区间，所以①的实现需要把 skill 的 envelope code 改成 `400`/`422` 之类，或让映射函数显式支持 5 位内部码 ⇒ 属于契约变更，需 Lead 拍板。
- **task-36 复核结论：改成 4xx 对 MemoryProxy 是安全的，但本期不实现**（详细证据见 §12）。

### P1-4 L0 写入失败一律 `retryable: true`（含确定性 4xx）— 归属：插件

- 证据：`index.ts:479-488` 注释写"L0 幂等所以重试安全"，于是 `retryable: true` 不区分状态码：`messages.0.content` 超长（文本上不该出现，但 P2 证明 curl 层可达）、`timestamp` 脏值（P1-2）、`role` 非法都会重试 8 次进死信。
- 影响：噪音 + 死信堆积；不过 payload 保留，可 `requeueDead()`。
- 最小修法：`retryable: result.status === undefined || result.status >= 500`（幂等只说明"重试不产生重复"，不代表"重试有意义"）。

### P2-1 L0 不校验 id 中的 `|` — 归属：core（契约一致性）

- 证据：`generated/schemas.ts:94` 只有 `z.string()`；skill 面四个 id 都 `.refine(v => !v.includes('|'))`（`skill-schemas.ts:255-261`）。探针 P16 → 200。
- 影响：L0 各 id 分列存储（`sqlite.ts:4995-5030` 分别落列），未观察到污染或键碰撞；但任务书/文档口径是"含 `|` 会被拒"，实际只有 skill 会拒 ⇒ 契约描述失真。
- 最小修法：要么给 L0 的 id 加同款 refine（会有存量兼容风险，需拍板），要么在契约文档里写明"L0 容忍、skill 禁止"。

### P2-2 文档称 skill 拒 ISO timestamp，实测接受 — 归属：文档

- 证据：`memory-client.ts:34`、`:64` 注释；`skill-schemas.ts:76` 实际是 `z.union([z.number(), z.string()])`；探针 P5 → 200。
- 影响：纯文档；插件的 `skillTimestamp()` 转换无害（core 也接受 ISO）。
- 最小修法：改注释，不要改行为。

### P2-3 L0 `content` 上限按码点计数，插件按 UTF-16 单元截断 — 归属：文档（方向安全）

- 证据：8193 码点（`emoji×4096 + 'a'`，8193 UTF-16 单元）→ 200（P15b）；8193 ASCII → 400（P2）。插件 `truncateForCore` 用 UTF-16 `slice`（`wire-limits.ts:47-73`），永远 ≤ 8192 码点 ⇒ 只会更保守。astral 密集文本最多被多截一倍。
- 最小修法：在 `wire-limits.ts` 注释里写明"core 的上限是码点，我们按 UTF-16 单元，天然更严"，避免后来人误以为是 bug。

### P2-5 `/v3` 的 413 缺 `limitBytes` / `hint` — 归属：core — **未修（task-39 实测发现，见 §10.4.1）**

- 证据：`v2-router.ts:775-779` 自建 envelope；活体 413 体只有 `{code, message, request_id, trace_id, retryable}`。
- 影响：可诊断性（见 §10.4.1），不影响 P0-2 的修法。
- 最小修法：catch 里按 `err instanceof PayloadTooLargeError` 透传 `limitBytes` + `hint`；`v2-router.ts` 变更需独立票。

### P2-4 body 超限用 `req.destroy()`，客户端只见 ECONNRESET — 归属：core — **已修（task-36，见 §10）**

- 证据：`server.ts:279-283`（`content-length` 预判）与 `:308-311`（累计超限）都先 `reject` 再 `req.destroy()`，响应来不及发出。探针 P8/S3/S4 只能看到 `fetch failed`。
- 影响：客户端无法区分"我发太大"与"网络抖动"，这正是 P0-2 之所以会重试到死信的原因。
- 最小修法：先用 `Content-Length` 判超时**先回 413 再 destroy**（或 `req.pause()`），累计超限同理；若担心半包攻击，可在回 413 后延迟 1s 再断。

## 8. 遗留现场（探针写入的 throwaway 数据）

- L0：本次 run 写入的会话 `probe-conf-1793455078781-{p1,p3,p15a,p15b,p8b,s7}` 已用 `/v3/conversation/delete` 删除（`deleteStatus 200 / code 0`，探针末尾打印）。
- L0：P10 故意不带 `session_id`，core 铸了一个**无法命名**的临时 session（一行 `role=user, content='probe no session'`），命名空间 `dshprobe`。
- L2 技能面**没有删除 API**，以下 buffer 会话留在库里（本次 run）：`probe-conf-1793455078781-{p4b,p5,p9,s1}`。历史调试 run（`1793454906451`、`1793454964420`、`1793454981484` 等）同样留下了各自的 `-{p4b,p5,p9,s1}`；全部在命名空间 `team/agent/user=dshprobe`，不与真实租户重叠，但 L2 提取器会看到它们。清理需要 core 侧提供 skill buffer 删除能力（或直接删 buffer 存储），不在本次票面范围。
- **task-36 已清**：`MemoryCore/scripts/skill-buffer-clean.mjs` 逐条精确匹配删掉 `dshprobe` 命名空间下 31 个 probe buffer（210 → 179 个 session，释放 78.8 KiB），见 §11。另有 2 个 `probe-dedupe-*`（task-26 去重验证遗留，位于真实租户 `usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz` 下）**未动**，见 §11 末。L2 已归档的 `scene_blocks` 行仍然没有删除 API（既有缺口）。

## 9. 复跑

```bash
cd /d/TDB/td-agemem
node scratch/probe-core-conformance.mjs      # 需要 core 在 127.0.0.1:8420 且 profile 已加载
```

- key 优先 `$TDAI_GATEWAY_APIKEY`，否则读 `MemoryCore/tdai-gateway.yaml` 的 `server.apiKey`；base 可用 `$AGEMEM_BASE_URL` 覆盖。
- 每次 run 生成新的 `probe-conf-<run>-*` 会话，不复用；`l0_sessions_deleted` 与 `skill_sessions_left_in_buffer` 打印在 `## RESULT_JSON`。
- 输出约定：`[PASS]/[FAIL]` 行 + 结尾 JSON；`PASS` 表示"实测 = 本文档记录的契约事实"，不是"契约没问题"。
## 10. core 侧限制与可诊断性（task-36 ①，P0）

### 10.1 限制从哪来

- 上限：`MemoryCore/src/gateway/server.ts:257` `const MAX_BODY_BYTES = resolveMaxBodyBytes()`；缺省 `src/utils/env-config.ts:48` `DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024`（1 MiB），env `MEMORY_MAX_BODY_BYTES` 可覆盖。
- 判定在 `server.ts:274-354` `parseJsonBody()` 里两处：`Content-Length` 预判（`:311-322`）与解压/流式累计超限（`:342-354`）；gzip/deflate 走解压流，**按解压后字节**计。
- 错误类型 `PayloadTooLargeError`（`server.ts:264-272`，`statusCode = 413`、带 `limitBytes`）。

### 10.2 修前为什么是「网络故障」而不是 413

修前两处都是 `reject(new PayloadTooLargeError(...)); req.resume(); req.destroy();` —— `destroy()` 在响应写出之前就掐掉 socket，客户端只能看到 `TypeError: fetch failed`（`cause.code=ECONNRESET, errno=-4077`），413 语义被降级成网络抖动。这正是 §7 P0-2 里「插件重试到死信」的根因之一。

### 10.3 改法（server.ts，task-36）

- `server.ts:274-309` 新增 `drainOversizeBody(req, source?)`：解压流先 `destroy()` 丢弃，然后 `req.resume()` 排空剩余字节，**不再 `req.destroy()`** —— socket 保持可写，413 能发出去；排空同时避免客户端在写大 body 时被 RST 丢响应。
- 两处超限分支改为「`drainOversizeBody` → `reject(PayloadTooLargeError)`」，累计分支额外 `aborted = true; chunks.length = 0` 释放已收的大块内存。
- `server.ts:1607-1626` 顶层 413 catch：`res.setHeader("Connection", "close")` + `sendJson(res, 413, { error, code: 413, limitBytes, hint, retryable: false })`；`hint` 明确写 "Split the batch into several smaller requests, or raise MEMORY_MAX_BODY_BYTES."，客户端拿到的是可行动的错误而不是 ECONNRESET。
- 其他路由族（v3-meta-router、offload router）的 catch 不 import `classifyError`，但它们共用同一个 parser；parser 不再销毁 socket 后这些路由也能正常写出响应，故未改（也不在本票 scope）。

### 10.4 真请求实测（`node --import tsx MemoryCore/scripts/verify-payload-limit-413.ts`）

脚本在同进程起两个真 server（fixed = 真 `parseJsonBody`；legacy = 内联复刻修前 8 行），用真 curl（`-H "Expect:" --data-binary @file`）与真 fetch 打；limit = 1048576 bytes，curl 8.22.0：

| body | 修前（legacy） | 修后（fixed） |
|---|---|---|
| 0.9 MB（900 011 B） | 200 | 200 `{"ok":true,"bytes":900011}`，fetch 200 |
| 1.05 MB（1 050 011 B） | `curl exit=56` `curl: (56) Recv failure: Connection was reset` | `exit=0` `HTTP/1.1 413 Payload Too Large`，body 见下；fetch HTTP 413 |
| 1.2 MB（1 200 011 B） | 同 1.05 MB（exit=56） | 同 1.05 MB（413 + JSON） |

修后 413 响应体（1.05 MB / 1.2 MB 完全一致）：

```json
{"error":"Request body exceeds 1048576 bytes limit","code":413,"limitBytes":1048576,
 "hint":"Split the batch into several smaller requests, or raise MEMORY_MAX_BODY_BYTES.",
 "retryable":false}
```

注：本机 127.0.0.1:8420 的 gateway 当时仍在跑修前代码（进程启动早于本次改动），所以证据来自该脚本内的真 socket，不代表线上实例；也**没有重启**线上 gateway。

### 10.4.1 `/v3` 路径少两个字段（task-39 活体实测，更正上面的口径）

上面的 413 体来自 server.ts 顶层 catch，只有**非 v2 路由**会走到。`/v3/**` 由 `src/gateway/v2-router.ts:766-779` 自己的 catch 组装：

```text
POST /v3/conversation/add, body=1 307 165 B (>1 MiB)
→ 413 in 7ms, headers: connection: close, content-type: application/json, content-length: 169
→ {"code":413,"message":"Request body exceeds 1048576 bytes limit",
   "request_id":"req-…","trace_id":"…","retryable":false}
```

- **没有 `limitBytes` / `hint`**：`v2-router.ts:775-779` 只 spread `errorEnvelope(code, message, requestId)` + `trace_id` + `retryable`。字节墙本身仍可诊断（`message` 里带 1048576），客户端可据此判"确定性失败、不要重试"。
- `connection: close` 是 Node 在未读完的 request 上结束响应时的自动行为，恰好符合"413 后关连接"的预期。
- 影响面：§7 P0-2 的最小修法（插件识别 413 = 不重试）**不受影响**（看 status 就够）；受影响的是"把 limit 直接反馈给用户/调参"这一类体验。
- 最小修法（**未实施**，`v2-router.ts` 不在 task-36/39 的 write scope）：catch 里加 `...(err instanceof PayloadTooLargeError ? { limitBytes: err.limitBytes, hint: "Split the batch…" } : {})`，并在 `error-handler.ts` 的 `classifyError` 里透传；属契约变更，单独立票。

### 10.5 回归测试

`MemoryCore/src/gateway/__tests__/payload-too-large-413.test.ts`（4 用例，真 HTTP + 真 socket + 真 `parseJsonBody`，响应壳与 gateway 同形）：
1. `fetch` 1.2 MB（带 `Content-Length`）→ 413 + `connection: close` + `limitBytes === DEFAULT_MAX_BODY_BYTES` + `hint` 非空；
2. `http.request` 逐块写 1.2 MB（无 `Content-Length`，chunked）→ 413；
3. gzip 炸弹（压缩后 < 1 MiB、解压 1.5 MB，走解压流累计超限分支）→ 413；
4. 0.5 MiB 正常 body → 200（不误伤）。

`npx vitest run src/gateway/__tests__/payload-too-large-413.test.ts` → 1 file / 4 tests passed。

### 10.6 对 P0-2 的意义

core 侧现在给出确定性 413 + JSON，插件侧因此**可以**把「超限」从「网络抖动」里区分出来（§7 P0-2 的最小修法第二步）；在插件改完之前，至少监控/探针能直接看到 413 而不是 ECONNRESET。字段完整度分两档（活体实测，见 §10.4.1）：非 v2 路由带 `code/limitBytes/hint/retryable`；`/v3/**`（插件唯一用的路由）带 `code/message/request_id/trace_id/retryable`，`message` 内含字节上限。

## 11. skill buffer 清理（task-36 ②）

### 11.1 为什么需要专门脚本

`POST /v3/skill/conversation/add` 在触发归档前把消息攒在 `<dataDir>/skill_buffer/<user>/<team>/<agent>/<session>/`（`data-current.jsonl` + `meta.json`；路径规则 `src/core/skill/conversation-add/buffer-storage.ts:153-158`，`DEFAULT_SUB_PATH='skill_buffer'`）。**注意磁盘嵌套顺序是 user/team/agent**，与票面写的 `team:agent:user` 不同（脚本按磁盘顺序，`--namespace` 也按这个顺序）。
L2 归档后没有任何删除 API，buffer 是唯一能在不碰库的前提下清掉的现场。

### 11.2 用法（`MemoryCore/scripts/skill-buffer-clean.mjs`，纯 .mjs）

```bash
cd MemoryCore
node scripts/skill-buffer-clean.mjs --list                       # 只列现存的 session
node scripts/skill-buffer-clean.mjs --session <id> [--namespace u:t:a]      # dry-run
node scripts/skill-buffer-clean.mjs --all-probe                  # dry-run（缺省）
node scripts/skill-buffer-clean.mjs --all-probe --yes            # 真删
node scripts/skill-buffer-clean.mjs --all-probe --yes --root D:/TDB/data
```

- 数据根解析顺序：`--root` → env `TDAI_DATA_DIR` → yaml `data.baseDir`（缺省 `MemoryCore/tdai-gateway.yaml`，`--config` 可换）。buffer 根自动发现 `<root>/skill_buffer` 与 `<root>/instances/<id>/skill_buffer`（service 模式）。
- 安全不变量：**缺省 dry-run**，真删必须 `--yes`；不做通配，选择器是 basename **精确相等**（`--all-probe` 也只接受 `^probe-[A-Za-z0-9._-]+$`）；目标必须恰是 `<user>/<team>/<agent>/<session>` 四层且自身含 `meta.json` 或 `data-*.jsonl`；链路上出现 symlink 一律跳过；删除前复核仍在 buffer 根之下；不删 `user/team/agent` 父目录、不动 `_tasks.json`；删除后重新枚举复核，残留则 exit 1；没给选择器（且非 `--list`）exit 2。
- 输出：每条路径 + files/size、`SKIP` 原因、总量、`freed`；footer 固定打印边界说明。

### 11.3 本次清理前后（probe buffer）

```
# 清理前
[skill-buffer-clean] sessions: 210
# --all-probe（dry-run）选中 33 条（31 条 dshprobe + 2 条 probe-dedupe-*，见 11.4）
# --all-probe --namespace dshprobe:dshprobe:dshprobe --yes
[skill-buffer-clean] deleted 31/31 sessions, freed 78.8 KiB (80673 bytes)
# 清理后
[skill-buffer-clean] sessions: 179
[skill-buffer-clean] matched sessions: 0 / total 179     # --all-probe --namespace dshprobe:... 再查
```

- 删除的 31 条 = 8 个 run × `-{p4b,p5,p9,s1}`（最早几轮只有 `p4b/p5/p9`），全部在 `skill_buffer/dshprobe/dshprobe/dshprobe/`。
- 空目录 `skill_buffer/dshprobe/dshprobe/dshprobe/` 仍在（按设计不删父目录），可手工 `rmdir`，无害。

### 11.4 真实租户下的 probe 残留（Lead 批准后已删）

`--all-probe` 还匹配到 2 条不在探针命名空间下的目录，属 task-26 去重验证遗留，位于真实租户路径下；**task-36 当时未删**（不在本票范围），task-39 取清单报 Lead 批准后已删（见 11.4.1）：

```
skill_buffer/usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz/probe-dedupe-1793454039865      (2 files, 962 B)
skill_buffer/usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz/probe-dedupe-tool-1793454039865 (3 files, 4.5 KiB)
```

要清的话：`node scripts/skill-buffer-clean.mjs --all-probe --namespace usr-2m7b1144d9:team-2k12lgb650:agt-2m7buribzz --yes`（dry-run 先看一遍）。

#### 11.4.1 清单与删除（Lead 2026-10-31 批准后已删）

```text
node scripts/skill-buffer-clean.mjs --session probe-dedupe-1793454039865
  → matched 1 / total 179
    skill_buffer/usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz/probe-dedupe-1793454039865
    files=2 size=962 B
node scripts/skill-buffer-clean.mjs --session probe-dedupe-tool-1793454039865
  → matched 1 / total 179
    skill_buffer/usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz/probe-dedupe-tool-1793454039865
    files=3 size=4.5 KiB (4656 bytes)
```

| session | 目录内容 | meta 关键值 | 内容头部 |
|---|---|---|---|
| `probe-dedupe-1793454039865` | `data-current.jsonl` 742 B + `meta.json` 220 B | `space_id=default`、`tool_call_count=0`、`byte_count=724`、`last_appended_at_ms=1793454039914`（无 `last_archived_at_ms` ⇒ 仍在 buffer） | `PROBE-SENTINEL-A1 我想把记忆插件的写回路径从同步改成异步队列…` / `PROBE-SENTINEL-A2 现有 outbox 用 turnId 做幂等键…`（同 payload 重复 2 遍 = task-26 去重取证现场） |
| `probe-dedupe-tool-1793454039865` | `data-1793454131602.jsonl` 4382 B（已归档）+ `data-current.jsonl` 15 B（`{"messages":[]}`）+ `meta.json` 259 B | `tool_call_count=0`、`byte_count=0`、`last_archived_at_ms=1793454131602`（已归档出 current） | `PROBE-SENTINEL-B0 帮我跑一下 lint 和 typecheck.` / `B1 好，我逐个调用.` / `tool_call bash call-…-1` / `tool_result ok 1` … |

- 只读扫描（`scratch/probe-leak-scan.cjs`，`node:sqlite readOnly`）三个 metadata 库 `default` / `e2e-test` / `team-2k12lgb650` 的所有表所有列，`LIKE '%PROBE-SENTINEL%'` **0 命中** ⇒ 这两条 probe **只存在于 buffer**，没进 L0/L1/L2 表；删 buffer 即可完全清除（`skill_buffer/…` 下两条目录 + 空的 dshprobe 父目录另说）。
- **已删（Lead 批准，2026-10-31）**，命令与前后清单：

```text
# 删前 dry-run
node scripts/skill-buffer-clean.mjs --all-probe --namespace usr-2m7b1144d9:team-2k12lgb650:agt-2m7buribzz
  → matched sessions: 2 / total 181      (2 sessions, 5 files, 5.5 KiB / 5618 bytes)
    …/probe-dedupe-1793454039865          files=2 size=962 B
    …/probe-dedupe-tool-1793454039865     files=3 size=4.5 KiB (4656 bytes)

# 真删
… --yes
  → DELETED …/probe-dedupe-1793454039865
  → DELETED …/probe-dedupe-tool-1793454039865
  → deleted 2/2 sessions, freed 5.5 KiB (5618 bytes)

# 删后复查
--all-probe --namespace usr-…:team-…:agt-…   → matched sessions: 0 / total 179
--all-probe（全库，probe-* 前缀）             → matched sessions: 0 / total 179
ls …/probe-dedupe*                           → no probe-dedupe-* dir under namespace
```

- 删除依据：上面的只读扫描证明 `PROBE-SENTINEL` **只在 buffer**（三个 metadata 库 0 命中），故删 buffer 即彻底清除；L0/L1/L2 无残留。
- 注：删前 dry-run 的 `total` 是 181（比 §11.3 的 179 多 2，期间有别的会话写入），删后 179，说明本次只动了这两条。

### 11.5 边界

- 只清 buffer。**已归档进 `scene_blocks` 的 L2 行没有删除 API**，属既有能力缺口，本脚本不处理（也不应顺手实现）。
- 不碰数据库、`skills`、`records`、`atomic`、`core_*` 等任何表。

## 12. skill 业务错误改 4xx 是否安全（task-36 ③）

**结论：对 MemoryProxy 安全（不会造成「写入静默失败」），但本期不实现** —— 需要改 `skill-handlers.ts`（~55 个 `errorEnvelope` 站点）与 `v2-router.ts` 的状态映射，都不在 task-36 的 write scope，且属契约变更，须单独立票。

### 12.1 客户端判成功的逻辑（证据）

- `MemoryProxy/src/skill/core-client.ts:382-385`：`if (!resp.ok) { throw new Error(...HTTP ${resp.status}: ...) }` —— **任何非 2xx 都抛错**。
- `MemoryProxy/src/skill/core-client.ts:394-397`：`if (env.code !== 0) { throw new Error(...envelope error ${env.code}: ...) }` —— 5 位业务码也抛错。
- 两个分支都走到同一个 `catch`：`MemoryProxy/src/skill/handler-glue.ts:126-163` 包 `try { await client.addConversation(...) } catch (err) { console.warn("[skill-conversation-add] addConversation failed:", ...) }` —— 只是日志，不影响主响应链（注释 `:19-20`/文件头 `:16-17` 明确「callers wrap in try/catch and degrade」）。
- ⇒ 把 200+code 换成 4xx+code，Proxy 侧行为**完全等价**（都是抛 Error + warn 一行），不存在「本来成功被判失败」的新风险。

### 12.2 会看到差异的另外两类消费者

- `skill-bridge`（agent 经反向代理直连 `/v3/skill/*`）：`MemoryProxy/src/skill/skill-bridge.ts:956-961` 原样透传上游 `status` 与 body；`:915-927` 埋点记录 `upstreamStatus`；`:940-954` 的过滤/lazy-pin 只在 2xx 时做。⇒ 4xx 会让 agent 直接看到失败状态，比「200 里塞错误」更正确；lazy-pin 也不会误把失败当成功。
- `MemoryProxy/src/injection/injectors/skill-tools-injector.ts:151` 的 agent 提示词里写死了「`40001` 参数校验失败」，改成 4xx 需要同步文案。

### 12.3 core 侧改法（若将来要做）

- 机制已存在：`v2-router.ts:762` `httpStatus = envelope.code === 0 ? 200 : (code >= 400 && code < 600 ? code : 200)`。所以不需要动 `server.ts`，只要让 skill 路由的 envelope code 落在 4xx 区间（例如参数校验 `400`、未找到 `404`、超限 `429`），HTTP 状态自动正确。
- 代价：`skill-handlers.ts` 有 ~55 个 `errorEnvelope(40001|40401|4291|50001|50301, ...)` 站点要逐个改；`40001` 是客户端可见的既有分类（插件/Proxy/agent 文案里都有），属**破坏性契约变更**，需要 Lead 拍板 + 全仓测试重跑（含 MemoryProxy 与 dsh-plugin 两套）。
- 折中（不改状态码的最小改善）：Proxy `call()` 对 `code !== 0` 补 `businessCode` 字段，`index.ts` 据此 `warnOnce`；core 侧零改动。这也是本期建议的过渡方案（已由 Lead 安排在插件侧按 body code 判失败兜住）。

## 13. 与任务书/票面不符的两处（以实测为准）

1. **L0 `/v3/conversation/add` 的 `session_id` 实际可选，且不校验 `|`。**
   - 实测：P10（不带 `session_id`）→ 200，core 自铸临时 session；P16（`session_id` 含 `|`）→ 200。
   - 代码：`generated/schemas.ts:93-98` 的 `session_id` 无 `.min(1)` 强约束；`v2-schemas.ts:116` 给了 default；`v2-router.ts:174-194` `collectV3Missing` 只强制 `team_id/agent_id/user_id`（`:192` 有注释）。
   - 对比：skill 面 `skill-schemas.ts:254-264` 四个 id 都必填且 `.refine(v => !v.includes('|'))`。
   - 处置：见 §7 P2-1（要么给 L0 加同款 refine（存量兼容风险，需拍板），要么把「L0 容忍、skill 禁止」写进契约文档）。本复核不改行为。
2. **skill 面 `timestamp` 实际接受 ISO 字符串，与插件注释「core 拒 ISO」相反。**
   - 实测：P5 传 ISO 串 → 200。
   - 代码：`skill-schemas.ts:76` `z.union([z.number(), z.string()])`；插件注释在 `dsh-plugin/src/memory-client.ts:34`（以及 `:64` 附近的任务书口径）。
   - 处置：见 §7 P2-2 —— 只改注释，不改行为（core 接受更宽，插件那边的转换无害）。

