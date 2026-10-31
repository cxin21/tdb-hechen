# @tdb/agemem-dsh

dsh 原生记忆插件 v0。把 TDB 长期记忆接进 dsh 宿主的三条缝隙，LLM 流量不经过 tdb 代理：
宿主自己的 provider 直连模型，插件只负责「注入记忆 + 回写回合」。

三个能力，各自 fail-open（任何一环失败都退化成宿主原样行为）：

| 能力 | 宿主接缝 | 行为 |
| --- | --- | --- |
| 会话级 head pack | `ctx.inject(['systemPrompt'])` + `section()` | 身份/红线/记忆检索指引，取一次后在会话内冻结，compaction 后重取 |
| 每步 volatile 块 | `agent/pre-step` 瀑布 | 只在本轮消息**尾部追加一条**记忆提示（`/v3/recall` 供料，失败退回 `atomic/search`），不改历史前缀（KV cache 不碎） |
| 回合回写 | `session/event` + `agent/turn-stopping` | 收集本轮 user/assistant 文本/工具调用/usage，落本地 outbox，fire-and-forget 推给 core |
| 工具 | `ctx.tools.register` | `memory_recall`：按 query 检索长期记忆（走 core `/v3/atomic/search`） |

宿主侧的三条硬事实（实测证据见 [docs/ops/dsh-plugin-probe-report.md](../docs/ops/dsh-plugin-probe-report.md)）：

1. 本 build **没有** `agent/session-start` 事件，会话级注入只能走 `systemPrompt.section`；
2. `agent/pre-step` 的 messages 是「本 step 刚 claim 的消息」，且追加的消息会被**持久化**成 `user/message` 事件 —— 所以每条追加都带 id 并按 turn 去重，不能当 ephemeral 用；
3. `assistant-stream` 的 end 帧不带 usage，真实 usage 在 `session/event` 的 `assistant/message.data.usage`；
4. 本 build 的 compaction 事件是 `compaction/start` / `compaction/end`（`session/compacted` 在 app.asar 里 0 命中），
   head pack 靠它们失效重取，`refreshMs` 只是兜底；
5. `assistant/message` 的 content 是 **parts 数组**，`reasoning`/`thinking` 与可见答案混在一起
   （e2e 实测 1613 字符里真回答只有末尾 ~180 字符）。写回只取 `type: 'text' | 'output_text'` 的 part，
   拿不到可见文本就**不写** assistant 文本，绝不拿 CoT 顶替（否则检索会把推理当记忆、还抬高 embedding 成本）。

## 依赖

运行期 **零依赖**（只用宿主注入的 `ctx` 与全局 `fetch`），连 peer 都没有：`memory_recall` 的参数
直接写成完整的 JSON Schema 对象交给 `ctx.tools.register`。

> 早前版本声明了 `@deepseek-ai/dsh-tools` 作为可选 peer，靠它的 `defineTool()` 把 DSL 字段表编译成
> JSON Schema。实测（安装后的 profile 里 `ERR_MODULE_NOT_FOUND`）该包解析不到，退回 identity 包装后
> 注册进去的是**未编译的字段表**——根缺 `type:'object'`、`required` 不是数组，宿主据此丢弃整个工具，
> 而 `register()` 从不看 `parameters`，于是 `memory_recall` 静默消失。现在自己不依赖任何 peer 生成
> schema，并用宿主自己的校验器（`test/fixtures/host-json-schema`，从 app.asar 原样抽出）在单测里兜底：
> 字段表形态必须被拒、本工具的 schema 必须通过。

## 配置

所有开关有缺省值。身份（teamId/agentId/userId）**缺省为空**：不配身份时插件是 inert 的，
一次请求都不发（防止几个 profile 共用一份默认身份互相串记忆）。token 不落提示词、不落配置文件。

这里有**两层不同的凭据**，别混：

| 层 | 键 | 形态 | 去处 |
| --- | --- | --- | --- |
| 网关层 | `server.apiKey` / `server.apiKeyRef` | core 的 64 位 hex | `Authorization: Bearer …` |
| 身份层 | `server.userKey` / `server.userKeyRef` | 用户的短 key | `x-tdai-user-key`（meta 路由必带；数据路由在三轴齐备时才带） |

两层都按 **显式配置 → `ctx.credentials.resolve(ref)` → `env[ref]`** 解析，显式值必须赢过 ref/env
（否则桌面 profile 配了也不生效）。缺省 ref 分别是 `TDAI_GATEWAY_APIKEY`（core 自己的 key）与
`TDAI_USER_KEY`；**都不是** MemoryProxy 的 `TDB_API_KEY`，用错层不会报「用错了」，只会静默 401
或「解析不到身份」。401/403 会 warn 一次（含 endpoint/status/该查哪个字段），其余失败维持 fail-open。

```yml
- insert:
    - id: tdb-agemem-dsh
      name: ./node_modules/@tdb/agemem-dsh/dist/index.js
      config:
        server:
          baseUrl: http://127.0.0.1:8420     # memory core（云端部署要改）
          apiKey: ""                          # 桌面 profile 兜底；优先于 ref
          apiKeyRef: TDAI_GATEWAY_APIKEY      # core 的 key（不是 proxy 的 TDB_API_KEY）
          userKey: ""                         # 身份层 key（短 key）；配了就自动解析 team/agent
          userKeyRef: TDAI_USER_KEY           # 或走凭据库/env 的这个 ref 名
          serviceId: default
          teamId: ""                          # 三个身份缺省为空 = inert，不发请求
          agentId: ""
          userId: ""
          requestTimeoutMs: 10000             # atomic/search 冷启动实测 6.4s
        paths:                                     # 换了一个不同版本的 core 才需要改
          coreRead: /v3/core/read
          atomicSearch: /v3/atomic/search
          scenarioLs: /v3/scenario/ls
          conversationAdd: /v3/conversation/add
          conversationDelete: /v3/conversation/delete
          skillConversationAdd: /v3/skill/conversation/add   # 第二条写回链路（L2）
          recall: /v3/recall                  # 合并 recall 块（服务端 opt-in，关掉会 404）
          metaAuthVerify: /v3/meta/auth/verify  # user key → 用户（公开路由）
          metaTeamList: /v3/meta/team/list      # 该用户的 team（要 x-tdai-user-key）
          metaAgentList: /v3/meta/agent/list    # 该 team 下本人 agent（owner 过滤）
          health: /health
        headPack:  { enabled: true, orderOffset: 100, maxChars: 20000, refreshMs: 300000, timeoutMs: 10000 }
        volatile:  { enabled: true, maxChars: 1500, timeoutMs: 3000,
                     soul: { enabled: true, maxChars: 600, includeFeeling: true },
                     recall: true, recallMaxResults: 3, recallTimeoutMs: 2500 }
        writeback: { enabled: true, skillFeed: true, maxAttempts: 8, retryMs: 30000, outboxPath: "",
                     maxMessageChars: 8192, maxMessagesPerRequest: 100,
                     maxRequestBytes: 700000,        # 单次请求的 JSON 字节预算（core 1 MiB 硬墙）
                     maxOutboxEntries: 500,          # 队列上限：core 长时间不可达时丢最旧
                     maxOutboxBytes: 20971520 }      # 队列字节上限（20 MiB），死信不计入
        tools:     { enabled: true, recall: true, recallTopK: 8 }
        skill:     { enabled: true, allowLlmWrite: false,   # allowLlmWrite=false：只给 4 个只读工具
                     headPackChars: 8000,                   # <available_skills> 段预算（一次/会话）
                     searchTopK: 10, maxResultChars: 20000, timeoutMs: 2500 }
        debug: false
```

- head pack 的 section order = `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` + `orderOffset`（本 build 10200 + 100）。
- **场景索引只写一遍，而且不再是 persona 的一部分**：`/v3/core/read` 返回的 persona 尾部本来就带一份
  `## 🗺️ Scene Navigation` 块（14 个 `### Path:`、约 6.2k 字符，占 10k persona 的六成）；`src/segments/persona.ts`
  渲染前用 `stripSceneNavigation()` 把它切掉，索引改由 `src/segments/l2.ts` 从 `/v3/scenario/ls` 一行一景渲染
  （`- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>`）。旧行为是把这个块压缩后留在 persona 里、
  再追加 `/v3/scenario/ls` 的裸路径，两处索引字段不一致（一处有热度无摘要、一处有摘要无日期）。
  `- scene_blocks` 行首锚仍然存在（`scripts/verify-installed.mjs` 靠它判 L2 生效）。
- 写回是**两条独立链路**，同一回合各发一次，互相不阻塞：
  - `/v3/conversation/add`（L0）→ 行级会话 → L1 事实（`atomic`/`work_fact`），timestamp 是 **ISO 字符串**；
  - `/v3/skill/conversation/add`（L2）→ skill buffer → 阈值归档 → extractor → L2 `scene_blocks`（persona 尾部
    Scene Navigation 就是它产的），timestamp 是 **epoch 毫秒 number**。缺了这条，L1 天天长但场景永远不新增。
  - skill 只在**成功回合**发（半截的错误回合会污染 buffer）；`writeback.skillFeed: false` 可单独关掉 L2。
  - **线路限额**跟 core schema 对齐：单条 content ≤ **8192** 字符、单批 ≤ **100** 条（L0；skill 批 ≤ 500，
    那是 skill schema 的上限）。超长单条在安全字符边界裁断并留 `[truncated: N chars]` 标记（不切 surrogate pair、
    优先段落边界），超长回合按限额**顺序分片**发，任一分片失败只重试该分片，不整轮丢。
    `maxMessageChars` / `maxMessagesPerRequest` 只能往下配，配超过上限会被钳回。以前单条硬编码 20000 ⇒ 长回合
    400 → 8 次重试 → 死信 → 该轮 user+assistant 全丢。skill 的 8192 是**有意保留的产品选择**（core 侧没有这个上限，
    实测 9000 字符照样 200）——把 L2 抽取的输入控在这个量级，buffer 归档与 extractor 成本才可预测。
  - **字节墙（比条数更早撞）**：core 的 HTTP server 在 1 MiB 处**先 reject 再 `req.destroy()`**
    （`server.ts:274-315`），客户端看不到 413，只看到 `ECONNRESET`。实测 0.9 MB 通过，L0 1.05 / 1.2 MB、
    skill 3.75 MB 全挂在 reset 上（约 349k 汉字触顶）。所以分片不能只按条数：`maxRequestBytes` 缺省 **700000**，
    用 `Buffer.byteLength(JSON.stringify(body))` **实测字节**（JSON 转义会让中文/emoji 比字符数膨胀），
    超预算就把消息挪到下一片；单条自身就超预算时按字节二分裁（code point 安全，留 `…[truncated]`）。
    只按字符数估的旧实现会把一个 960KB 的回合当成「才 12 条」发出去，然后整轮丢。
  - **分片是部分成功的**：多分片回合按顺序发，chunk 1 成功、chunk 2 网络失败时已写进去的那片**不回滚**
    （半条比整轮丢好，这是有意的取舍）。死信行里记的是失败那片 `chunk i/n`，运维按 `session_id`/`turn`
    在 core 里找回缺失的尾巴，再用 `requeueDead()` 重放——L0 的 `(session, turn)` 幂等（F-DUP-1）保证重放不翻倍。
  - **skill 不做 HTTP 级重试**：`/v3/skill/conversation/add` 服务端零去重，同一个 payload 投两次 buffer 翻倍
    （阈值按请求体条数算，重复 48 条会整批进 L2 extractor）。所以只有请求从未到达 core（fetch 抛错 /
    ECONNREFUSED / 连接超时）才重试；一旦拿到 HTTP 响应（含 4xx/5xx）立即进死信，reason 记
    `skill-feed-no-retry-on-response`。L0 保持重试（服务端按 turn 幂等）。
  - **重试矩阵**（两条链路的失败语义不同，别混着看）：

    | 失败类别 | 判据 | L0（`/v3/conversation/add`） | skill（`/v3/skill/conversation/add`） | 死信 `reasonClass` |
    | --- | --- | --- | --- | --- |
    | 401 / 403 | 有 status | 不重试，首次即死信 | 不重试，首次即死信 | `auth` |
    | 400 / 422 等 4xx | 有 status | 不重试，首次即死信 | 不重试，首次即死信 | `l0-http` / `skill-feed-http` |
    | 429 / 5xx | 有 status | 退避重试到 `maxAttempts` | 拿到响应就不重试 | `skill-feed-no-retry-on-response` |
    | HTTP 200 但 body `code≠0` | 已答但业务拒绝 | 判失败、不重试 | 判失败、不重试 | `business-rejected` |
    | 传输层断连（ECONNRESET / fetch failed） | status 缺失 | **只多试 1 次**，仍失败即死信 | 可重试（请求可能没写完，服务端没见到） | `transport-reset` / `l0-transport` |
    | 本地超时 / abort | status 缺失且 reason 是 `timed out` | 不重试（大半已送达，重放风险大） | 不重试 | `l0-timeout` |
    | 退避次数耗尽 | attempts ≥ maxAttempts | 死信 | 死信 | `attempts-exhausted` |
    | payload 里没有消息 | — | 死信（保留待人工 requeue） | 死信 | `empty-payload` |
- outbox 缺省在 `$DSH_HOME/agemem/outbox.jsonl`（`~/.dsh`），JSONL 落地，按 `sessionId:turn:N`（L0）与
  `sessionId:turn:N:skill`（L2）分别幂等：L1 已成功、skill 失败时重试不会把 L0 再写一遍。
- 死信（`outbox.dead.jsonl`）每行是**运维记录，不是会话副本**：只带 `reason.reasonClass`
  （`auth` / `l0-http` / `skill-feed-http` / `business-rejected` / `l0-transport` / `transport-reset` /
  `l0-timeout` / `skill-feed-no-retry-on-response` / `attempts-exhausted` / `empty-payload`）、
  `endpoint`、`status`、`attempt`、`messageLen`，**不带** session/turn/正文/key。零删除红线不变：死信只追加，
  人工 `requeueDead()` 才能重放。每类失败只 warn 一次，warn 里同样只有 class + endpoint + status。
  已知死信的 key 不会被重新入队（同一进程内也不跨进程重放），必须显式 `requeueDead()`——防止「重启后又悄悄重发一遍」。
- **队列有容量上限**（`writeback.maxOutboxEntries` 500 / `maxOutboxBytes` 20 MiB）：core 长时间不可达时
  outbox 不能无限长。超限丢**最旧**的排队条目（保留最新一条，哪怕它自己就超字节），只 warn 一次并带 `dropped` 计数，
  之后降级成 debug。死信文件不受这个上限约束——它本来就是只追加的运维记录。
- volatile 取料：先打 `/v3/recall`（服务端 `v3Recall.enabled`，本机已开；关掉会 404），
  从返回块里取两样东西：
  1. **soul 段**（`<soul-identity>` / `<soul-feeling>`）——蒸馏人格与本轮情绪，按闭合标签切出、按 code point
     安全裁剪后放在块首。实测 identity 3343–3388 字符、feeling 36–40 字符；旧版只取 `- [` 行，**整段人格被丢掉**，
     于是插件注入的是「没有性格的记忆」。
  2. `<relevant-memories>` 内的 `- [` 行——块头部那 ~300 字符的【币值判定规则】【建议类问题口径】
     与已注入的 answer-guidance 段重复，丢掉不重注。
  404/504/超时/无条目一律退回 `/v3/atomic/search` 摘要（**atomic 路没有 soul 段，也不许编造**），全失败就不注入。
  - **预算怎么分**：`volatile.maxChars` 1500 = soul 最多 600 + 记忆约 900。soul 是**从总预算里切走的**，不是额外叠加：
    先渲染 soul（`volatile.soul.maxChars` 600，clamp [100,3000]），剩下的 `1500 - soul - 1` 才给记忆装填。
    `volatile.soul.enabled: false` 时记忆预算逐位回到旧形态（1500 全给记忆）。
  - **人格缺失是可降级的**：块里没有 soul 标签、核心超时、`includeFeeling: false` 都只是少一段，不影响记忆注入；
    每轮 debug 行带 `soulChars` / `soulVersion`（只版本串，不打正文），mount 行带 `soul=on(600,feeling)|off`。
  - **隔离三轴是 header，不是 body**：core 的 v2 层对所有 `/v3/*` 强制 `x-tdai-team-id` / `x-tdai-agent-id` /
    `x-tdai-user-id`（+`x-tdai-service-id`），缺一个就是 **422 `missing team_id, agent_id, user_id`**；
    `session` 不强制（header 或 body 给一个就行）。插件里这些头由唯一一处 `headers()` 统一附加，
    `recallBlock` 只是不在 body 里重复 echo 三轴——**不是**不发头。
  - **降级熔断**：`422` 判为**永久**（和 401 同类：重装/改配置才可能好），本进程内一次之后不再打 `/v3/recall`，
    直接走 `atomic/search`；`404`（服务端 `v3Recall.enabled: false`）/ `504` 退避 10 分钟后重试。
    两者各 warn 一次（含 endpoint + status + 怎么修），其余失败按 generic 一类。熔断只是「不再白打请求」，
    注入语义不变：一样降级到 `atomic/search`，全失败就不注入。装填顺序是**先逐条裁到 360 字符**（code point 安全边界 + `…`）**再按预算装填**：
  实测 `maxResults=2` 返回 2 条、合计 1214 字符（单条 450–770），按「整行回退 + 1200」只装得下 1 条，
  第二条白丢；裁到 360 后同一份预算装得下 2–3 条（≈800 字符）。预算不够时**按整条丢弃**，只有单条自身
  超预算才裁——不会切在一条记忆中间。同一次查询里前缀相同的重复条目只留一条。
  **单条上限固定 360，不随可用预算放大**：只有 1 条可选时预算还剩 ~840 字符也不再放宽——
  token 成本可预测、测试面小，比「池子薄时临时放宽到 720」值。
  `volatile.maxChars` 1500（soul ≤600 + 记忆 ≈900）；`recallMaxResults` 3（多要一条不多花 embedding：l1 只 embed 一次 query）。
- **每轮的时间预算**（pre-step 里是同步 await，所以每一档都要能 fail-open）：

  | 档位 | 缺省 | 作用 |
  | --- | --- | --- |
  | `volatile.recallTimeoutMs` | 2500ms | 单次 `/v3/recall`。AbortController **真中止 fetch**（不是只不再等待），超时后判为「本地取消」，与网络错分开记 |
  | `volatile.timeoutMs` | 3000ms | 整个 getBlock 的总预算；recall 用掉多久，atomic/search 回退就只剩多少（2500 用满还剩 500），剩余 <300ms 直接不注入 |
  | `recallTimeoutMs` 的档位依据 | — | 见下方分布：2500 覆盖到约 90 分位，长尾与冷启动一律 fail-open 降级 |

  实测分布（本机 core，每轮送的都是**当轮新文本**，所以 core 的 embedding 缓存根本不命中）：

  | 读数 | 说明 |
  | --- | --- |
  | 95 / 119ms | **缓存命中**（同一个 query 重复打），不能当预算依据 |
  | 314ms | 早期读数，同样含命中成分 |
  | 1250 / 1396 / 1467 / 1540 / 2002 / 2147 / 2255ms | 真实当轮文本的常态区间（l1 embedding 占 97%+） |
  | 5067ms | 冷启动；`agent/created` 那次预热就是为它存在 |

  超时的那一半由降级买单：`atomic/search` 回退恰好还有 500ms 预算。把预算砍到 1500ms 的实测结论是**更慢**——
  那一轮既付了 recall 的钱，又得再付一次回退的钱，还未必拿到更好的块。

- **预热与缓存**（都只为省掉重复的 embedding，不改注入语义；**不要算进本轮延迟预算**）：
  - `session/event` 的 `user/message`（真实用户原话，**不含**注入块）触发一次 fire-and-forget 预取。
  - **实测结论：预取省不了它自己那一轮。** 本宿主把 `session/event user/message` 派发在 `agent/pre-step`
    **之后**，那一轮的 pre-step 早就自己取过了 —— 所以 debug 读数里的 `prefetched:false` 是**正常现象，不是故障**。
    预取真正省的是「同一段文本再次出现」（重试、重复提问）时的 embedding；同一个 key 的在途请求仍然只发一次，
    预取不会让请求数翻倍。
  - 命中成功（拿到非空块）的结果进 10 分钟 / 50 条的 LRU 缓存；**失败不入缓存**（空块、422/404/504、取消都不缓存），
    免得把降级状态冻结 10 分钟。key 是 `sessionId + turn`，没有 turn 时退回用户文本哈希。
  - `agent/created` 那一次预热仍然必需（冷启动 5s 必挂任何预算），失败静默。
  - 每轮一条 debug 读数：`{recallMs, cacheHit, prefetched, source: recall|atomic|none, injectedChars, entriesKept}`。
- 挂载时会打**一条** `agemem: ready` info：endpoint、serviceId、身份是否齐全（只打「缺失的字段名」，
  绝不打 id）、key **来源**（`config` / `credentials:<ref>` / `env:<ref>`）、各能力开关，以及**按 ms 原值**打印的四个预算
  （`recallTimeout=2500ms,volatileTimeout=3000ms,headPackTimeout=10000ms,requestTimeout=10000ms`）——取整成 `2s`/`3s`
  正好把 1500 与 2500 这种要手调的差别抹平。head pack 的 `no parseable scene index` 只在**结构真的解析失败**时
  warn 一次（带 `rawChars` 与首个非空行前 60 字）：已压缩形态和带截断标记的文本都是正常形态，不再每次挂载误报。
  其余失败仍按类各 warn 一次（auth 401/403、recall 404/504、L0/skill 写入被拒、outbox 死信），
  每条带 endpoint + status + 一句怎么修。
- `AGEMEM_DEBUG=1` 打开详细日志（等价 `debug: true`；配置里显式写的 `debug` 优先于环境变量）。
- 未知配置键只 warn 不报错；数字越界会被 clamp。

## 身份：user key → 用户 → team/agent

静态三元组（`teamId/agentId/userId`）是「这台机器永远写这个人的记忆」。多机、多人、换人时更好的做法是
只留一个 **user key**，让插件去 core 问「这是谁、他的 team、他名下这个 team 的 agent」。两条入口都已落地：

### 启动自动解析（零交互的常态）

挂载时若三元组不齐：按 `server.userKey` → `credentials.resolve(userKeyRef)` → `env[userKeyRef]` 取 key →
`/v3/meta/auth/verify` → `/v3/meta/team/list` → `/v3/meta/agent/list`（owner 过滤，只列本人 agent）：
- 唯一命中 ⇒ 就地生效，ready 行报 `identity=resolved(user_key)`，本进程后续所有 v3 请求带解析出的三轴；
- 该用户属于多个 team / 名下有多个 agent ⇒ **不猜**，warn 一次并保持 inert（提示跑 CLI 选）；
- key 无效 / 0 team / 0 agent / 超 4s ⇒ warn 一次并保持 inert；
- 未解析时 ready 行额外带 `userKeySource=config|credentials:<ref>|env:<ref>|none`（只报来源，不报值）。

解析只在内存里：**从不写 patch**，也不会把 user key 推进提示词。换 agent = 换一份记忆池，选定了就别乱改（无迁移工具）。

同一个 user key 还当**请求头身份**用：隔离三轴（`x-tdai-team-id`/`x-tdai-agent-id`/`x-tdai-user-id`）只说明
请求打到哪个库，`x-tdai-user-key` 才说明是**谁的**记忆，core 的归属校验（缺省 warn、enforce 才拒）靠它。
规则是「取不到就整条不发」——不发空串（空串会被读成「给了身份，但是空的」），解析失败只降级为不带该头，
请求照发；日志只报是否附带，不打印值。ready 行另有 `userKeyHeader=on|off`。

### 一次性 CLI（多候选 / 想换 team、agent）

```bash
# user key 放凭据库（值走 stdin，不进 argv、不进 shell 历史）
node scripts/credentials-util.mjs set "$DSH_HOME/.credentials.yaml" TDAI_USER_KEY < userkey.txt
# 或临时用环境变量 / --userkey

node scripts/agemem-identity.mjs --profile desktop --dry-run   # 先看会写成什么
node scripts/agemem-identity.mjs --profile desktop             # 交互选 team / agent 后写回
node scripts/agemem-identity.mjs --profile desktop --team team-xxx --agent agt-xxx   # 非交互
```

- 只改 managed 块里 `config.server` 的 `teamId/agentId/userId` **三行**，其余行（含 `skillFeed`、`maxChars`、
  内联 key 等运维自己加的键）逐字保留；重复跑是幂等的。
- profile 里没有 managed 块（没部署过）⇒ 直接 exit 2 让你先跑 `scripts/deploy.sh`，不会凭空造一个插件条目。
- 非 TTY 且候选不唯一 ⇒ 打印候选清单后 exit 2；`--json` 模式不弹交互。
- **user key 永远不写进 patch**（patch 会被 `--dump-config` 打印、被复制、被 grep），只留在凭据库或 env。
- 写回后要重启宿主才生效（配置在挂载时读）。

## 排障

| 症状 | 先查 |
| --- | --- |
| `/v3/recall` 一直 422 | 看 422 原文 `missing team_id, agent_id, user_id`：**隔离三轴是 header**（`x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id`），不是 body 字段；身份没配齐（`teamId/agentId/userId`）时插件本身是 inert 的，一次请求都不发 |
| 一直 401 | core 要的是 `server.apiKey`（64 位十六进制），**不是** MemoryProxy 的 `TDB_API_KEY`；缺省 `apiKeyRef` 是 `TDAI_GATEWAY_APIKEY`，用 `server.apiKey` 显式覆盖最省事 |
| 写回全进死信、status 400 | 大概率撞了线路限额：单条 >8192 字符或单批 >100 条（插件现在会裁/分片），或 timestamp 不是 ISO（插件会归一化）；死信行里的 `reasonClass` 能区分 `l0-http` 与 `business-rejected` |
| 写回全进死信、reason `transport-reset` | 撞 1 MiB 字节墙（core 先 reject 再 destroy，客户端只看到 reset）。看 `messageLen` 与 `maxRequestBytes`（缺省 700000），别按字符数估 |
| 每轮都有 `circuit open` 但注入还在 | 正常：熔断后走 `atomic/search`。想恢复 `/v3/recall` 就重启宿主（422 是进程级永久）或等 10 分钟（404/504） |
| 完全没注入 | 先看有没有 `agemem: ready`（没挂上），再看 `identity=missing(...)`（缺哪个字段） |
| ready 行 `identity=missing(...)` 但明明配了 user key | 看 `userKeySource=`：`none` 是三层都没取到（`server.userKey` / `refs.TDAI_USER_KEY` / env）；warn 会说明是 key 无效、0 team、还是多 team/多 agent。后者跑 `scripts/agemem-identity.mjs` 选定 |
| user key 改了没生效 | 解析在挂载时做一次（4s 预算）：改配置/凭据后要重启宿主。解析结果只在内存，patch 里不会出现解析出的三元组 |
| 身份解析很慢（挂载卡几秒） | verify+team+agent 三次 meta 往返，上限 4s 后放弃并 inert；core 慢或跨机房时调 `--base-url` 指向近端，或改用静态三元组 |
| 跨机后没有记忆 | 先 `curl http://<core>:8420/health`（网络/端口/防火墙），再看 ready 行的 `health=` 与 `keySource=`：`keySource=none` 是凭据没落到宿主，`health=fail(no-answer)` 是 core 没起或 ACL 挡了 |
| 跨机后一直 401（本机明明能过） | 跨机时脚本**不会**去读本机的 `../MemoryCore/tdai-gateway.yaml`：那是对端机器的另一把 key。用 `--api-key` 传对端的 `server.apiKey`，`has` 一下确认 ref 真的写进去了 |
| warn `head pack has no parseable scene index` | 只 warn 一次、说明 core 返回的 persona 结构**真的**变了：看同一行的 `rawChars` 与 `firstLine`（首个非空行前 60 字）；此时 head pack 退回裸截断，L2 的 14 个场景路径会丢 |
| debug 里 `prefetched:false` | 正常现象：`session/event user/message` 在本宿主上晚于 `agent/pre-step`，预取赢不了它自己那一轮；预取只对重复文本有用 |

## 与 dsh-context 的分工

`dsh-context` 负责上下文面的保留/compaction/archive/token 记账；本插件**不重复实现压缩**，
只在它之外做两件事：稳定前缀里放记忆 head pack，每轮尾部放检索到的片段。

## head pack 的注入时机（一次/会话，不是每 refreshMs）

这条容易被误解成「按 `refreshMs` 周期重注」，所以写清：**head pack 一个会话只进一次系统提示词**。

| 时机 | 行为 |
| --- | --- |
| 会话首轮 | 组装一次全量 head pack（core_memory + persona + 场景索引 + 技能，总预算 `headPack.maxChars`=20000） |
| `compaction/start` / `compaction/end` | `invalidate()` + 重新组装**一次**（上下文刚被裁，这是补偿而非重复） |
| `refreshMs`（缺省 300000） | 只刷**内部缓存**（head pack 数据对象、`/v3/skill/listing`、core_memory），**不触发注入** |
| 会话中途能力变化（装/卸工具、换 provider） | 不重注 |

实现上它不是一个 append 的消息，而是 `ctx.inject(['systemPrompt'])` 注册的 section：`text` 是函数
（`() => headPack.current()`），每次请求都会把**同一段文本**发给模型，所以 KV cache 的前缀是稳定的；
「一次/会话」指的是**内容在会话内冻结**，不是「只发一次字节」。

为什么不能按 `refreshMs` 重注：`agent/pre-step` 追加的消息是 append-only 进历史的，会话一长就会变成
每 5 分钟往上下文里灌 20000 字符。分段预算因此按「一次/会话」定档（见下表），`persona` 拿剩余量。

**系统提示词里（head pack，一次/会话）**

| 段 | 上限（字符） | 失败时的行为 |
| --- | --- | --- |
| `core_memory` | 3000 | 零字符 + debug `coreMemory=fail:<reason>` |
| `persona`（只叙事） | 剩余量（`maxChars` 减去其它段） | 零字符（head pack 空则不注册 section） |
| 场景索引（L2 段） | `headPack.l2Chars`（3000） | 零字符 + debug `l2=fail:<reason>`；`l2=empty` 是「团队还没有场景」 |
| `<available_skills>` | 8000 | 零字符 + `skills=failed:0`（保留 persona） |

溢出丢弃优先级：`persona` > 场景索引 > `skills`（后段先丢，永不动前缀）。

场景索引自成一票一份（`src/segments/l2.ts`，`order 20`）：persona 段只负责身份叙述，它尾部那份
`## 🗺️ Scene Navigation` 块在渲染前被 `stripSceneNavigation()` 切掉，索引统一由 L2 段按
`- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>` 一行一景渲染。四态标签 `l2=` 同时出现在
mount 行与 `agemem: head pack composed` debug 行：`ok(N,chars)` / `empty` / `truncated(0,dropped)` /
`fail:<reason>`；`pending` 只在首次 fetch 未落地时出现在 mount 行。行是整行丢弃的——预算不够就少一行，
不切半句。

**每轮尾部（volatile 块，`agent/pre-step` 追加一条消息）**

| 段 | 上限（字符） | 预算从哪来 | 失败时的行为 |
| --- | --- | --- | --- |
| 记忆块（soul + `/v3/recall`） | `volatile.maxChars`（1500） | 独占，先消费 | 回落 `atomic/search`，再不行零字符 |
| `<team-wiki>` | `volatile.wiki.maxChars`（800） | `order 50`，吃记忆块**剩下的** | 零字符，debug `wiki=... fail=http_404` |
| `<knowledge_tools>` | `volatile.knowledge.maxChars`（3000） | `order 60`，再吃剩下的 | 零字符，debug `knowledge=... fail=<reason>` |

能力段的预算不是「两个 cap 相加」：`volatile.maxChars` 先被记忆块消费，之后每段的实际上限是
`min(本段 cap, 剩余量)`（`src/segments/registry.ts` 的 `remaining`）。余量不足 60 字符时干脆不跑，
省掉两次网络往返。三段互不牵连：一段失败只让它自己零字符。

三段各带一个段级熔断器（`src/segment-health.ts`，阈值 3 次 / 冷却 10 分钟 / 半开只探一次）：
连败三次后这一段直接跳过、不再发请求，debug 行留 `circuit=open(http_404, 3, retryIn=540s)`；
「空答案」记成功不记失败（`no_hits` / `empty_list` / 空 listing 是正常业务空，不是故障）。

缺省开关：**wiki 关**（8420 的 `/v3/wiki/search` 从未答过，开了就是每轮一个 404），**knowledge 开**
（`/v3/knowledge/list` 实测 200/7ms，空团队只付一次廉价 list）。ready 行里 `wiki=off` / `knowledge=on(3000)`
就是这两个开关的实况；开关在设置页（`volatile.wiki.enabled` / `volatile.knowledge.enabled`）。

**量化（缺省档必须能算）**：20000 字符 ≈ 6.7k token（按 3 字符/token 粗算）。实测只有 8000 档的数字：
head pack 落在 4939–8437 字符（≈1.6k–2.8k token，2026-10-31 的 14 个场景实例）。改成 20000 是给
`core_memory` 3000 + 场景索引 3000 + `skills` 8000 + `persona` 剩余量留出上限，实际渲染仍由数据量决定；
（`wiki` / `knowledge` 不在 head pack 里，它们走每轮 volatile 块，预算单列、不占这 20000。）
代价是首轮 system 段最多比 8000 档多约 1.2 万字符（≈4k token），它只付一次且落在稳定前缀上（KV cache 复用），
但**上下文窗口的常量占用同样只多这一次**。若长会话逼近窗口上限，已知退路：把 `headPack.maxChars` 调回 12000，
并把 `skills` 段降为「首轮全量 + 后续只留名称」（配置层暂无开关，需改 `segments/skills.ts`）。
`- scene_blocks` 场景索引**任何重构都不许丢**：它是 L2 场景的唯一导航。

## 技能面（`/v3/skill/*`）

core 的 17 条 skill 路由里，插件只用其中 10 条做工具，另外用 `/v3/skill/listing` 供 head pack 的技能段。
**`/v3/skill/listing` 返回的 `data.listing` 是 core 自己渲染好的 `<available_skills>` 文本，插件逐字嵌入**
（不在本地拼）——拼一遍就会在 core 改格式后悄悄和 core 的注入器不一致。

| 工具 | 读写 | 走的路由 | 说明 |
| --- | --- | --- | --- |
| `skill_search` | 读 | `/v3/skill/search` | query → `[{skill_id,name,version,score,snippet}]`；snippet 压到 ≤160 字符 |
| `skill_view` | 读 | `/v3/skill/get-by-name` 或 `/v3/skill/get` | body + manifest；`content` 超 `skill.maxResultChars`（20000）截断并**显式标原始长度** |
| `skill_files_read` | 读 | `/v3/skill/files/read` | 读附件（脚本/模板/夹具），附字节数 |
| `skill_extract` | 读 | `/v3/skill/conversation/force-archive` | 触发本会话的归档抽取（见下「偏差」） |
| `skill_create` | 写 | `/v3/skill/create` | 支持 `resources[]` 一次带附件 |
| `skill_update` | 写 | `/v3/skill/update` | 整体覆盖正文 |
| `skill_patch` | 写 | `/v3/skill/patch` | 精确替换一段，其余字节不变 |
| `skill_delete` | 写 | `/v3/skill/delete` | 删一个 skill |
| `skill_files_write` | 写 | `/v3/skill/files/write` | 附件写入/替换（≤100 个/次） |
| `skill_files_remove` | 写 | `/v3/skill/files/remove` | 附件删除（≤100 个/次） |

写工具的开关是 `skill.allowLlmWrite`（缺省 **false**，只注册 4 个只读工具）；打开后 10 个全注册。

### 写口做模型无感的 read-modify-write

core 的五个写路由都要求 `expected_version`（`skill-schemas.ts:101/108/117/182/189`），而 core 自带的
`/v3/skill/*` MCP 注入器（`skill-tools-injector.ts:108-144`）**没带**，所以那些写工具实际是 200 + `code 40001`
的半残品。插件不让模型关心版本：

1. 先 `POST /v3/skill/get`（`include_content:false, include_manifest:false`）取当前 `version`；
2. 带上 `expected_version` 发写请求；
3. 若返回 `code 40901`（`SKILL_VERSION_STALE`，期间有人改过）**重读一次再重试一次**；
4. 第二次仍 40901 就把 core 的原文回给模型（不无限重试，也不首次即放弃）。

判成功只看 `body.code`（HTTP 一律 200）。失败文案原样回给模型，含 `code` 与 `message`。

### 偏差（有意不照 proxy 的做法）

- `skill_extract` 走 `/v3/skill/conversation/force-archive`（body `{session_id, reason?}`）而不是 `/v3/skill/extract`：
  后者的 schema 要 1..500 条 `messages`，插件不持有那份缓冲；`50301`（未接线）时原样回给模型。
- 读工具的返回体按 `skill.maxResultChars` 截断，**截断必须带 truncated 标记与原始长度**：
  `[truncated: showing N of M chars; call skill_files_read (or re-view a narrower section) for the rest]`——
  只截断不标记会让模型以为 skill 正文就到这里。

## 构建 / 测试

```bash
npm run build      # tsc -> dist/
npm test           # vitest run（fake ctx，不需要宿主）
```

单测覆盖：section 注册参数、pre-step 只追加不重排/reject 透传/超时与异常 fail-open、
outbox 幂等 + 退避 + 重启恢复、turn 结束回写的完整与不阻塞、工具参数 schema 与降级路径、
以及一条跨模块集成用例（`test/turn-pipeline.integration.test.ts`）：预热 → 注入 → 会话事件 → 回写，
断言 agent 提示注入的那条 volatile 消息**不会**混进写回 payload，且同一回合的两条链路各自用对时间戳形状
（L0 body 是 ISO 串、skill body 是 epoch 毫秒 number）。另有 `test/recall-source.test.ts` 锁住
「只留 `- [` 行 / 按整行截断 / 无标签降级」，`test/writeback.test.ts` 锁住「reasoning 不进 L0」，
`test/wire-limits.test.ts` 锁住「8192 / 100 的裁断与分片（含 surrogate pair）」与「JSON 字节预算下的分片、
单条字节二分裁」，`test/outbox.test.ts` 锁住「非重试类失败第一次就进死信、死信 reason 结构化且不含会话内容，
已死信的 key 不会被静默重放」，`test/recall-cache.test.ts` 锁住「key 归一化、TTL/LRU、同一 key 只允许一个在途请求」，
index 用例锁住「预取与 pre-step 共用一个请求、预取先到则走缓存、超时自我取消后回退、key 对不上就现发、
422 永久熔断只 warn 一次、4xx 首次即死信、传输断连只多试一次、HTTP 200 + `code≠0` 判失败」，
`test/memory-client.test.ts` 另锁住「所有 `/v3/*` 都带隔离三轴 header、`/v3/recall` 的 body 不再 echo 三轴」、
「offset 时区归一为 UTC、非法 timestamp 只丢该条」、「900KB 回合按字节分片、每片 JSON ≤ `maxRequestBytes`」，
集成用例还锁住「一个强制隔离头的假 core 在最前面：缺头就 422，插件不会静默成功」。
`test/head-pack.test.ts` 另锁住「已压缩形态被认作正常形态（不再误报 `no parseable scene index`）、
真结构损坏时 warn 恰好一次且带 `rawChars` + 首行前 60 字」，index 的 ready 行用例锁住「四个预算按 ms 原值打印」。
`test/credentials-util.test.ts` 锁住「只改 `refs:` 块、`records:` 逐字节不变、`ref: ""` 不算已配置、日志只露长度与末四位」；
outbox 另锁住「超 `maxEntries`/`maxOutboxBytes` 时丢最旧、warn 一次带 dropped 计数、最新一条即使超字节也保留、死信不被裁剪」；
index 另锁住「挂载时只探一次 `/health`、ready 行报 `health=ok|fail(...)`、身份不全时 `health=skipped(inert)`」。
身份流另有三组：`test/identity.test.ts` 锁住解析的每条分支（唯一命中 / key 无效 / 0 team / 多 team 不猜 /
0 agent / 多 agent 不猜 / 就地写回 / 候选清单渲染），index 用例锁住「解析出的三轴真的进了 `/v3/recall` header、
user key 不会被当成 Bearer、多 team 时 inert 且只 warn 一次、连开两个进程各解析一次（从不写 patch）」，
`test/identity-cli.test.ts` 锁住「参数解析、profile 路径推导、唯一候选才自动选、非 TTY 多候选就停、
只改 managed 块的三行、`--dry-run` 不写文件、user key 不出现在 patch 与输出里」，
`test/patch-util.test.ts` 锁住「`extractManagedBody` 逐字取块、三行幂等改写、缺字段插在 server 段内、
值带 `:`/`#` 时仍被引号包住」。

## 部署 / 回滚

```bash
bash scripts/deploy.sh --dry-run    # 只看计划（api key 打码），不改任何东西
bash scripts/deploy.sh              # build + test + pack + `dsh plugin --profile <p> add` + dump-config 验证
bash scripts/rollback.sh            # 反向撤销（见下），并用 --dump-config 断言组合里已无本插件
bash scripts/drill-patch-layer.sh   # 演练：在一次性 profile 上验「写块 / 升级替换 / 剥块」三件事
```

- 目标 profile 缺省 `desktop`（当前 GUI 在跑的 profile；`web` 是出厂模板），可用 `DSH_PROFILE` 覆盖。
- **重复执行 = 升级**：第二次跑 `deploy.sh` 会替换同一个管理块（新 tarball + 新 config），不会插第二份，
  也不再像旧版那样「已存在就 exit 0」把升级伪装成成功。管理块有显式首尾标记
  （`# >>> tdb-agemem-dsh managed block`），块内不要手改——改配置用 `--config-extra` 或改脚本参数。
- 备份写在仓库内 `dsh-plugin/.deploy/<stamp>/`，不往 `~/.dsh` 塞额外文件。
- **失败即回滚**：安装后任何一步（写块 / dump-config / 校验）失败，脚本会剥块 + 还原 package.json 与
  pnpm-lock + 卸包 + 删残留目录再 exit 1，不留孤儿安装；`.deploy/last` 在**校验之前**写，所以失败的
  那次也能用 `rollback.sh` 兜底。
- **rollback 的顺序是反的、删除是定点的**：先卸包（此时 package.json 还列着它，pnpm 才认得），再还原
  package.json / pnpm-lock，然后**就地**剥管理块（patch-util 知道块边界，部署后别人的编辑不会丢），
  最后只删 `node_modules/@tdb/agemem-dsh` 与 `node_modules/.pnpm/@tdb+agemem-dsh@*`，不再 `rm -rf .pnpm/@tdb`。
- **部署不会重启宿主**：正在跑的 GUI 进程保持原样，插件在下次重启后才挂载。
- **rollback 不删凭据 ref**：`refs.TDAI_GATEWAY_APIKEY` 是宿主级共享密钥，可能被别的插件/工具用；
  回滚只卸载本插件与它的 patch 块。真要删用 `node scripts/credentials-util.mjs remove ~/.dsh/.credentials.yaml TDAI_GATEWAY_APIKEY`。
  部署**中途失败**时脚本自己会把凭据文件还原成这次改动前的样子。

身份与密钥由 deploy.sh 写进该 profile 的 patch 层插件 config（loader 是整块替换 config，不深合并，
所以这一块就是全部配置）：

```bash
DSH_PROFILE=desktop bash scripts/deploy.sh \
  --identity team-xxx,agt-xxx,usr-xxx     # 或 TDB_TEAM_ID/TDB_AGENT_ID/TDB_USER_ID
# 可选：--base-url=http://host:8420  --api-key=<core server.apiKey>
# key 来源顺序：--api-key / TDB_CORE_API_KEY → 本机 ../MemoryCore/tdai-gateway.yaml（仅 baseUrl 是本机时）
#              → 凭据库 ref $TDB_API_KEY_REF（缺省 TDAI_GATEWAY_APIKEY）→ 同名环境变量
# 一个都找不到就 exit 2，不会静默装一个 401 的插件；--inline-key / --no-store-key 可改写入方式
```

- 身份不全时脚本会明说「plugin mounts but stays INERT」：**这不是失败**，是防串记忆的安全缺省。
  想走 user key 的话，部署时可以不传三元组，改用
  `--config-extra` 提供 `server.userKeyRef`（或 `server.userKey`），挂载时自动解析；
  多候选再用 `node scripts/agemem-identity.mjs --profile <p>` 一次性选定（见上一节「身份」）。
- **key 缺省不进 patch**：deploy.sh 把它写进宿主凭据库（`$DSH_HOME/.credentials.yaml` 的 `refs:`），patch 只留
  `apiKeyRef`；`--inline-key` 恢复「key 直接写 patch」的老行为，`--no-store-key` 完全不碰凭据库。
  跨机部署（插件在 A 机、core 在 B 机）见「跨机部署」一节。
- dry-run 会把 api key 打码成 `b8475f4b…e760` 再打印，可以安全贴进工单（`--inline-key` 时才有密文可打码）。
- 脚本只建模 `server.*`；其余键（`writeback.skillFeed`、`volatile.maxChars`、`debug`、`paths.*` …）用
  `--config-extra=<file>` 传一段 YAML，脚本按 8 空格缩进塞到 `config:` 下：

  ```bash
  cat > /tmp/agemem-extra.yml <<'YAML'
  writeback:
    skillFeed: false
  volatile:
    maxChars: 1500
    soul:
      maxChars: 600
  YAML
  bash scripts/deploy.sh --identity team-x,agt-y,usr-z --config-extra=/tmp/agemem-extra.yml
  ```

## 跨机部署（插件在 A 机，core 在 B 机）

结论先说：**跨机就是这个插件换个 `server.baseUrl`，全程走 HTTP 直连**。宿主侧的 LLM 流量依然不经过任何代理，
插件只对 core 的 8420 发那几条 v3 请求。TLS **本轮不做**（用户 2026-11-01 拍板）——内网明文，跨不可信网络请自己加
SSH 隧道/内网 ACL。真要上 https + 自签证书：插件侧没有 `tlsCaFile`（`server.tlsCaFile` 留作后续项），
现在只能给宿主进程设 `NODE_EXTRA_CA_CERTS=<ca.pem>` 让 Node 信任该 CA。

```bash
# A 机（跑 dsh 的机器），把 core 的 64 位 server.apiKey 交给 deploy.sh
bash scripts/deploy.sh --profile desktop \
  --base-url http://10.16.235.171:8420 \
  --identity team-xxx,agt-xxx,usr-xxx \
  --api-key <core machine 的 server.apiKey>
# 然后重启宿主；插件挂载后看 ready 行
```

**key 不再进 patch**：deploy.sh 把 key 写进宿主凭据库 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下
（ref 名缺省 `TDAI_GATEWAY_APIKEY`，可用 `--api-key-ref` 改），patch 里只留 `apiKeyRef: "TDAI_GATEWAY_APIKEY"`。
原因很实际：patch 会被 `--dump-config` 打印、被复制到别的机器、被人 grep；凭据库才是宿主自己管密钥的地方。
插件的解析顺序仍是 **显式 `server.apiKey` → `credentials.resolve(apiKeyRef)` → `env[apiKeyRef]`**。

- 想保持老行为（key 直接写进 patch）：`--inline-key`。适合没有凭据库的机器，代价是 patch 里带明文。
- 不想让脚本碰凭据库：`--no-store-key`——那就得自己保证 ref 或环境变量有值，否则插件起来是 401。
- **找不到 key 时脚本直接报错退出（exit 2）**，不再像旧版那样静默装一个 inert/401 的插件。
  本地 `../MemoryCore/tdai-gateway.yaml` 只在 **baseUrl 指向本机**时才会被读：跨机时那是**另一台机器上的另一把 key**，
  拿它来用只会每轮 401。
- 环境变量兜底：`export TDAI_GATEWAY_APIKEY=<key>`。插件在宿主进程里读 `env[apiKeyRef]`，
  适合容器/CI 这类没有凭据库的场景；注意桌面宿主是长驻进程，改了 env 要重启才生效。

### 上线前先验一遍这两行

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.16.235.171:8420/health        # 期望 200
curl -s -H 'Authorization: Bearer <key>' -H 'x-tdai-service-id: default' \
  -H 'x-tdai-team-id: team-xxx' -H 'x-tdai-agent-id: agt-xxx' -H 'x-tdai-user-id: usr-xxx' \
  -H 'content-type: application/json' -d '{"query":"hello","maxResults":1}' \
  http://10.16.235.171:8420/v3/recall | head -c 300        # 期望 code:0 + <relevant-memories>
```

### 插件挂载后读 ready 行

```
agemem: ready (endpoint=…, serviceId=default, identity=configured, keySource=credentials:TDAI_GATEWAY_APIKEY,
              health=ok, headPack=on, volatile=recall, writeback=on, skillFeed=on, …)
```

| 字段 | 含义 |
| --- | --- |
| `keySource=config` / `credentials:<ref>` / `env:<ref>` / `none` | key 到底从哪来。跨机排查第一个看它 |
| `health=ok` / `fail(no-answer)` / `fail(error)` / `skipped(inert)` | 挂载时**只探一次** `/health`（3s 上限，不阻塞回合） |
| `identity=resolved(user_key)` | user key 解析成功，三轴已就地生效（只在内存，没写 patch） |
| `identity=missing(teamId,…)` | 身份没配齐 ⇒ inert，一个请求都不发 |
| `userKeySource=none` | 没配 `userKey`、凭据库里也没有 `refs.TDAI_USER_KEY`、env 也没有 |

- `health=fail(...)` + `keySource=none` ⇒ 先解决 key（`credentials` 里没有那个 ref，或 env 没带上）。
- `health=ok` 但注入为空 ⇒ 看是不是 `/v3/recall` 被关（404）或身份在 core 侧不存在（422），见排障表。
- 跨机延迟比本机高：`recallTimeoutMs` 2500 是按本机实测定的，跨机房 RTT 大的话按 README「每轮时间预算」表往上调；
  调小了不会报错，只会一直 fail-open 退回 `atomic/search`（更慢、更差）。

### 断网/对端挂掉时的行为

- 回合永远不会被网络阻塞：注入超时就 fail-open 不注入，写回走本地 outbox 后台重试。
- outbox 有上限（`maxOutboxEntries` 500 / `maxOutboxBytes` 20 MiB），超限丢**最旧**并 warn 一次，
  不会把磁盘塞满；死信文件只追加不删。
- 重连后不需要人工干预：`startTimer` 按线性退避继续投递；死信里的条目要显式 `requeueDead()`。
## 与 MemoryProxy 路径的排他

两条路径都能把记忆接进 dsh，**同一个记忆身份只能选一条喂写**：

| | dsh 插件（本包） | MemoryProxy（8096） |
| --- | --- | --- |
| LLM 流量 | 不经过，宿主 provider 直连 | 全量经过代理 |
| 注入 | 宿主接缝（系统提示 + 每步尾部） | 改请求体再转发 |
| 写回 | 插件在 turn 结束推 core 的两条链路：L0 会话 + L2 skill | 代理在每次回复后推同样两条（L0 + L2 归档） |
| 适用 | 想在宿主内看得到记忆读了什么、要按 profile 隔离 | 不想改宿主，或客户端不是 dsh |

两条同时作用于同一身份 ⇒ 每个回合被写两遍（L0 重复、L2 buffer 归档次数翻倍、同一段对话出现两次）。
所以：**插件路径装了就不要再让同一身份走 MemoryProxy**；若无法避免（例如团队里有人用代理），
就把插件的写回关掉（`writeback.enabled: false`），只留注入与工具。
如果只有 L2 被代理喂过（L0 没走代理），把 `writeback.skillFeed` 设 `false`，只留插件的 L0——两条链路可以分开取舍。

## 已知边界（有意不做，属设计选择）

- head pack 只做「冻结 + 过期重取」，不做按会话的差异化选择；
- volatile 块只做一次 recall，不做多轮 query 改写/重排；
- **注入块会被宿主落成 `user/message` 存进会话历史**（实测：宿主对 pre-step 追加的消息没有 ephemeral 概念）。
  这是 append-only 的代价：它不会改写历史前缀（provider KV cache 不碎），但长会话里每轮多 1200 字符上限的块。
  缓解：同轮去重 + 近 3 轮同文本跳过 + 无命中就不注入；确实嫌吵就把 `volatile.enabled` 关掉，只靠 head pack 与工具；
- 回写只看 turn 级（assistant 文本 + 工具调用 + usage），不解析文件级编辑事件；
- `memory_recall` 走 core 的 `/v3/atomic/search`，core 不可用时返回可读的降级文案而不是抛错。
- L0 的 `session_id` 在 core schema 里其实是**可选**、也不校验 `|`（只有 skill 队列要求 id 不含分隔符）；
  插件仍然每条都带 `session_id`——会话维度对 L1 检索有用，是主动保留而不是 schema 强制。
- 死信没有自动 TTL 清理：`outbox.dead.jsonl` 只追加不删，堆积靠人工 `requeueDead()` 或按 `reasonClass` 归档。
- 身份选择的 **GUI 弹窗（v3）没做**：现在只有「启动自动解析」与「一次性 CLI」两条入口；CLI 需要先
  `npm run build`（它直接复用 `dist/` 里的 wire 契约，避免与插件分叉）。
- user key 解析只在**挂载时做一次**（4s 上限），不做运行时重新解析，也不缓存到磁盘；换 key / 换 team 要重启宿主。
- 平台级多用户隔离不做（一个宿主管一个身份）：同一 profile 里两个会话共用一个 agent 就是共用一个记忆池，这是有意的。
