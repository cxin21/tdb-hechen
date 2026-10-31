# MemoryProxy 残项 + deploy + sdk + agents + scripts（D/M/K）

> 前提：dsh 插件直连模型（spec §1）。proxy 的「转发 + 注入 + 记账」只剩注入与记账，转发链路整体作废。行数为 `wc -l` 实测，路径相对 `MemoryProxy/src/`（另有标注者除外）。

## 1 删（D）

| 目标 | 行数 | 依据 |
|---|---|---|
| handler.ts 2515 / anthropicHandler 2390 / codexHandler 1447 / workbuddyHandler 1475 / auxiliaryHandler 303 / systemUserPassthrough 715 | 8,845 | spec 计 8,851（差 6 行，未逐文件对账）；LLM 流量不过 proxy |
| skill/skill-bridge.ts 1097、skill/handler-glue.ts 174、memory/memory-bridge.ts 517、memory/bridge-telemetry.ts 136 | 1,924 | 隧道成立前提是「客户端拿不到 token」；插件直连后 token 直读，隧道反而把服务 token 暴露在公网 443 的转发路径上 |
| skill/normalize-conversation.ts 563 | 563 | 唯一消费者是上表 handler；core-client.ts 429 保留（skill 归档仍要写 core） |
| rate-limit/redis-store.ts 326、rate-limit/usage.ts 32、guard.ts 138 | 496 | 口径改会话级（§3），Lua 滑动窗口与输入 token 计量都不再需要；只留 ≈120 行计数器 |
| mem-command/parser 138、pre-intercept 86、response-builder 284、task-draft-generator 632、utils 101 | 1,241 | 命令文本由插件侧解析 |
| routes/whitelist.ts 281 | 281 | 白名单只服务上游转发与 aux 分派，无消费者 |

死代码实测：`routes/session-task.ts` 748 行里 `createSessionCreateTaskHandler:604`、`createSessionUpdateTaskHandler:626` 从未在 `server.ts` 注册（`server.ts` 只挂 `:178` refresh-cache、`:183` force-archive），是全仓唯一的「导出即死」路由；被 mem-command 复用的只有 `:254/:381/:500/:565` 四个函数。

## 2 改（M）

**ClickHouse 每回合 token 列来源**（`clickhouse.ts` 1338，`ClickHouseRow:52-95`）分三类，新模型各换一支：

- 上游响应解析（`buildClickHouseRow:585`）：prompt/completion/total_tokens、cache_hit/miss/write、input_tokens、cache_creation_ephemeral_5m/1h —— 新模型无上游响应，改由 `/turn/end` 的 client-reported usage 映射（spec §2.4），列结构可不动，加 `source=client_reported`。
- 服务端派生：`timestamp` 走 `toChTimestamp:450-458`（**+8h 墙钟偏移**，新模型由服务端写可删，改直传）、`source_tag:"proxy":641`、`host:642`、`credit:637`、`credit_saved:526-551`、`compress_*:561-646`。
- 路径/请求派生：`space_id`（`credit-reporter.ts:66` 正则 `/^\/?proxy\/([^/?]+)/`:70 与 agent 白名单:77）、`upstream_url、stream、routed_from、upstream_request_id、user_input` —— `upstream_url` 恒空，`space_id` 改从 `/v3/dsh` 入参取。
- `usage_raw` 的 5 个 reason（non_tokenhub/unknown_model/invalid_format/invalid_credit/report_failed，`:107-125`）只剩 invalid_format / report_failed。

**credit 自报后怎么改**：`computeCreditDelta:115` 现在只在 upstream URL 匹配 `/tokenhub/i`（`:124`）时算，公式 `:169-174`（anthropic input_tokens 已剔缓存 `:140-146`，openai prompt_tokens 减 cached `:150-158`），价目表 `pricing.ts` 160（`getModelPricing:22`，Credit/1K）。上游消失 → 解析段（`detectUsageProtocol:45`、`extractSpaceIdFromPath:66`）整段删，≈150 行；保留价目表 + 公式，计算点从 handler 后置移到 `/turn/end` 内。上报 `reportCreditUsage:209` → `/UpdateMemoryPlusUsage` 语义变为「客户端申报值」，spec §8 明确 billing SoT 是 Ark 账单，此值只可用于配额/看板/异常（`isCreditAnomalous:481` + `CREDIT_SANITY_CAP 1e6:468` 已有护栏），需加 source 字段否则污染账单。失败路径不变：`writeFailedReportRaw:773` + `x-credit-report-error`（`sanitizeHeaderValue:337` 截 256）。

**rate-limit 改口径后删哪些**：现状是 Redis Lua 60s 滑动窗口 log，key=(spaceId, modelId) 带 `{rl}:` hash tag，前置 `enforceRateLimit:29`（fail-open `:40-51`，30s 节流告警），响应后 `recordInputTokenUsage:72` 回填真实输入 token。新口径（turns/min 30、context/min 60、per-user 日配额）下：`modelId` 服务端不可见 → 删 per-model 维度（`routes/rate-limits.ts` 151 的 instance_id×model_id 组合校验 `:26/:132`）；不需要 token 计量 → 删 `usage.ts`；滑动窗口 log → 改固定窗口 `INCR+EXPIRE`，`redis-store.ts` 326 整文件重写。保留 admin 热改（`PUT :68-79` 写 Redis，Lua 每次读 → 下一请求生效，live 变更无需重启）。

**turnSeq / langfuse traceId 改服务端分配**：现状 `countHumanTurns(turnSeq.ts:44)` 数「文本不以 `<system-reminder>` 开头的 user 消息」，文件头 `:1-19` 自认「靠猜、客户端截断历史即漂移」；`langfuseTurnTraceId(langfuse.ts:122)` = `sha256(${sessionKey}:${turnSeq})`.slice(0,32)；`injection/observer.ts:227` 再复算同一值。改：`/context` 用 Redis 每会话 INCR 分配 turnSeq 并返回（spec §2.3 同式），traceId 仍走同一函数（seed 不变，Langfuse 侧零改动）；`turnSeq.ts` 55 整文件删；observer 改读上下文；storage degraded 时按 spec §6 进程内自增 + `policy.multiNodeSafe=false`。

**routes 逐个判定**（`server.ts` 393）：留 `/health:89`、`/whoami:112`、`POST /v3/instance/proxy-destroy:144`、`/v3/admin/{rate-limits:147-149, credit-pricing:152-154, llm-providers:173-175}`、`/v3/session/refresh-cache:178`、`force-archive-skill:183`；全新加 `POST /v3/dsh/*`；其余全删（`/skill-bridge/*:132`、`/memory-bridge/*:137`、`/v1/messages:191`、aux `:196-199`、codex `:252-260`、workbuddy `:268-276`、dsh `:322-350`、opencode marker `:361-366`、泛匹配 `:369-378`、`/proxy/*:382-387`、catch-all `:390`）。**计数实况**：共 76 条注册（65 POST + 5 GET + 6 PUT/DELETE），spec 说「~30 条」偏低；改造后剩 ≈14 条。
**鉴权缺口**：`session-refresh.ts:238` 与 `session-force-archive.ts:236` 注释都写「走 admin auth」，但 handler 体内无 `checkAdminAuth` 调用（`admin-auth.ts:7` 全仓只被 `instance-destroy.ts:69` 使用）→ 两条运维口实际未鉴权，仍会挂在公网 443 后面，必补。

## 3 留（K）

storage/`{factory,cos,sqlite,fs,memory}` + db/ 2,603（spec 计；cos 仍 fail-fast）、injection/injectors 3,790、tdai/ 1,380、pricing.ts 160、skill/core-client.ts 429、meta/client.ts 647、knowledge/、observability（`clickhouse` 1338 / `langfuse` 398 / `opik` 303 / report 605）、`routes/credit-pricing.ts` 119（整表热替换，key `nottl/_default/admin/credit-pricing.json`:17）、`config.ts` 827（裁剪）、`logger.ts` 210（ClickHouse 桥 `:42-62`）。

## 4 deploy/tencent-cloud（跨机后只暴露 /v3/dsh/*）

> （已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）；本节 path 白名单按现有 v3 数据面（`/v3/core/read`、`/v3/atomic/search`、`/v3/scenario/ls`、`/v3/conversation/*`）落地。

- `Caddyfile.template:7-9` 现在是整站 `reverse_proxy proxy:8096` → 改 path 白名单：仅 `/v3/dsh/*`（+ `/health`），其余 404；`:20-28` 的纯 IP 443 变体同样收紧。
- `docker-compose.yml:46` `127.0.0.1:8096:8096` 已正确（proxy 不经宿主机暴露），`:79-81` caddy 只开 80/443，无需改。
- `systemd/tdai-proxy.service:11` `--config /opt/tdai/etc/proxy-config.yaml` 保留（进程仍跑同 config）；`tdai-core.service:11` 不动。
- `config/env.example`：`:6/:14` `TDAI_GATEWAY_APIKEY` 只剩「proxy→core/knowledge 的 service token」用途；`:33/:34` 双名 admin key 留一个（proxy 实际读 `TDAI_PROXY_ADMIN_API_KEY`，`config.ts:716`）；`:47` `MEMORY_LOG_LEVEL` 留。
- `config/proxy/proxy-config.cloud.example.yaml`（908）：删 `upstream:32`、`costGuard:137`、`ccRequestRouting:903`、`server.forwardTimeoutMs:29`；`rateLimit:183` 的 tpm/qpm 换 turns/context 口径；`storage:226` 保留。
- `DEPLOY.md:151-154` §9「dsh 型会话代理指 skill-bridge/memory-bridge/knowledge」整段失效 → 改为「装插件 + 只放行 /v3/dsh」；`:126-130` 的 `/v3/recall` 验证仍有效。（已更正，见 spec 头部「实测更正」节 #4：v0 不新建 `/v3/dsh/*`，复用现有 v3 数据面四端点）

## 5 agents / sdk / 脚本

- `agents/dsh/README.md` 469：**失效** §0.1-0.3（:17-86 v0.1→v0.2 base_url 迁移）、§1.1/1.2/1.4（:99/:168/:178 全指向 `http://<proxy>:8096/dsh/<spaceId>`）、§3.8（插件接管 handshake）、§10 常见问题（隧道错误码排查）。**保留** §2 Session ID、§3.2 ask_user_question schema、§3.6 thinking block、§5 用户文本提取、§6 注入 Profile、§8 归档触发、§9 环境变量。
- `sdk/` 8,902 行（python 17 文件 + typescript 15 文件）：打的是 core/knowledge `/v3`，不经 proxy，**保留**；插件若复用 `v3/skill-client.ts` 460 需版本对齐。
- 根目录一次性脚本全删：`_thinking_probe.mjs` 51、`_thinking_probe2.mjs` 52、`v20_prompt_ab.mjs` 132、`v21_prompt_ab.mjs` 133、`full-vitest.log`、`nul`（Windows 误重定向产物）；`scripts/` 是空目录（0 文件）→ 删。

## 6 不确定清单

1. spec §9 的 8,851 与实测 8,845 差 6 行，未逐文件对账。
2. `mem-command` 的 create/update-task 是否随插件下沉，取决于插件侧是否实现 task 绑定；我只确认了 `session-task.ts` 两个 HTTP handler 无注册。
3. credit 自报后是否仍调 `/UpdateMemoryPlusUsage`（会污染账单口径）需业务定；代码里没有任何 source 字段。
4. 未读：`src/types.ts` **1,115** 行（spec §9C 记 116，明显不是同一文件）、`index.ts` 183、`opik.ts` 303 字段级细节、`deploy/tencent-cloud/native/*.sh`、`config/proxy/CLOUD-DIFF.md`。
5. Caddy 能否按 path 前缀做「仅放行 POST + 45x 兜底」未验证。
