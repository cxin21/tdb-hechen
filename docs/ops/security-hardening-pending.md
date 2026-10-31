# 安全收紧待办（用户已决定：记录，暂不处理）

记录时间：2026-11-01
决定人：用户（原话「这个暂时记录但先不处理」）
依据：docs/ops/adversarial-review-2026-11-01.md（红队实测，非推测）

## 一、已确认的四步链（本机实测跑通）

LAN 上任意人 → 明文 user-key（`admin`/`hechen`/`chenxin` 就是用户名）→ 打 0.0.0.0 上的
Panel 8123 / Knowledge 8421 → 拿到全库读写。

- CRITICAL：三个历史账号 user-key = 明文用户名；`/v3/meta/auth/verify {user_key:"admin"}` → 200 `valid:true, user_type:system_admin`。新建用户走 create 才是 39 字符随机串（只有历史三账号脆弱）。
- CRITICAL：Panel 8123 / Knowledge 8421 绑 `0.0.0.0`；LAN IP 10.4.100.50 实测 200（带 admin key 打 `/api/v1/chat-memory/team-assets` 200）。
- HIGH：core `/v3` 数据面零身份绑定，只带 Bearer 即可读/删他人 L0（`deleted:10`）。
- HIGH：MemoryProxy `handler.ts:672-692` 无条件打消息前 80 字符 ⇒ 用户正文进日志 10 处/4 文件。
- HIGH：注入块原文被当普通 user 消息回写 L0（session=`probe-matrix-m2-inj`）。
- 注：`grep "Bearer [0-9a-f]{32,}"` 无命中 ⇒ **网关 key 本身未进日志**，泄漏的是消息正文。

## 二、暂缓的三件环境动作（等都不要现在做）

1. 轮换 `admin`/`hechen`/`chenxin` 三个明文 user-key 为随机串。代价：Panel 需用新 key 重新登录。
2. Panel 8123 / Knowledge 8421 收回 `127.0.0.1`（或强制 `KNOWLEDGE_SERVICE_KEY`）。代价：两个辅助服务各重启一次（不影响 DSH 宿主）。
3. 历史含用户正文的日志归档/截断（`MemoryProxy` 日志与 `tdai-proxy-*.out.log`）。

## 三、已在推进的代码侧（不依赖上面三件）

- task-59（panel-misc）：Panel 鉴权顺序前移 + 鉴权面限速 + Proxy 日志脱敏。
- task-60（record-pipeline）：core `/v3` 数据面归属校验（`requireUserBinding` 可配，缺省行为逐位不变）+ 脏 team 写入拦截。
- task-58（core-ops-b）：D-6 静默丢抽取 / D-7 402 无限重试 / 注入块服务端守卫（服务端 origin 标记是「注入块污染 L1」的根治点）。

## 五、读面矩阵新发现（2026-11-01，bench-metrics task-54，均为实测）

- **灵魂注入在 DSH 链路上等于 0**：/v3/recall 里 `<soul-identity>` 3343–3388 字符、`<soul-feeling>` 36–40 字符，但插件 `dsh-plugin/src/recall-source.ts:172-176` 只取 `<relevant-memories>` 的 `- [` 行 ⇒ soul 段整段丢弃；head pack 的 persona 也不含 soul。meta 里 soulVersion=`sv-c80c3e5b-pm811c9dc5`、mood=`positive` 客户端不读。⇒ 见 task-61。
- **8421 Knowledge 鉴权整体未启用**（新增 HIGH，记入本待办）：`KNOWLEDGE_SERVICE_KEY` 未配置 ⇒ `middlewares/auth.ts:1-9` 全放行；无 Bearer 实测 `/v3/internal/llm-binding/status`=200、`/v3/wiki/create` 已过鉴权进到参数校验 400。且 `/v3/wiki/search` 只 `getById(serviceId,wikiId)`（routes/wiki.ts:722-725），换 `x-tdai-team-id` 仍 200 ⇒ 跨 team 读；即便将来配 key，`/wiki/search` 仍在只读白名单（auth.ts:47-54）。
- **8420 上 /v3/wiki/* 是 404** ⇒ wiki 能力只在 8421，DSH 链路零接线（不是没索引，是没客户端消费）。
- **技能注入现网 0**：skills 表 2052 行（is_head=1 仅 284），消费方是 MemoryProxy 的 skill-injector，本机 proxy 未运行；插件只有写入侧。

## 四、恢复处理时的最小步骤

1. 先跑 task-59/60/58 的修复与测试，确认代码侧防线在位。
2. 再做第 2 项（收回绑定）——它消掉「LAN 可达」，且不需要改凭据。
3. 最后做第 1 项（换 key），此时 `requireUserBinding` 已可开启。
4. 第 3 项随时可做，做完跑一次 `grep -c "【agemem 记忆提示】"` 复核。
