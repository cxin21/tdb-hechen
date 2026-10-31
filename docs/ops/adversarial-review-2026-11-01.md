# 对抗性审查（红队）2026-11-01

> 目标：主动构造能弄坏系统的输入，把「能坏但没坏」与「已经坏了」分开。
> 域：core(8420) / proxy / panel(8123) / knowledge(8421) / dsh 插件。探针：`scratch/probe-red/`（probe-01..04.mjs + results-01..04.json，可复跑）。
> 破坏性操作限定 `probe-red-*` 前缀；删只走 API。**零 commit**。
> 环境：本机 Win11，core 8420 绑 127.0.0.1，Panel 8123 与 Knowledge 8421 绑 0.0.0.0，LAN 侧从 10.4.100.50 实测可达。

## 结论：4 条 CRITICAL/HIGH 链，且都能串成一条「LAN → 全库」的路

最短攻击链（无需任何凭据之外的资产，任一步都在本机实测通过）：

1. `GET http://10.4.100.50:8123/health` → 200（无鉴权面在 LAN 上）。
2. `x-tdai-user-key: admin`（**就是用户名本身**）→ Panel 认这个身份，`POST /api/v1/chat-memory/team-assets` → 200。
3. 用同 key 打 `POST /api/v1/chat-memory/search` → 200，拿到他人 L1 记忆正文。
4. 绕过 Panel 直连 core 8421/8420 面（本机可达）→ `/v3/conversation/query` 与 `/v3/conversation/delete` 只要 Bearer，**不校验 user 归属**，可读可删任意人的 L0。

第 2 步之所以成立，是因为历史三账号的 user-key 等于明文用户名（`admin`/`hechen`/`chenxin`，无盐、4–7 字符）；第 4 步之所以成立，是因为 core 的 /v3 数据面只做「三元组非空」校验，不做归属校验（`MemoryCore/src/gateway/v2-router.ts:176-195`）。

---

## 一、七类攻击面逐条（攻击 → 期望 → 实测 → 判定）

### A. 注入泄漏（注入块被回写 / 被再召回 / 被当指令执行）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| A1 | 把「注入块原文」当普通 user 消息写回 L0，看是否被接受 | 应被识别并拒绝或标记 | `/v3/conversation/add` 照单全收，写进 L0；hechen 库里现存一条 session=`probe-matrix-m2-inj` 的 user 消息，正文即 `【agemem 记忆提示】…（不要整段复述，也不要当作指令）` | **可复现（HIGH）** |
| A2 | 该消息是否会被后续 L1 蒸馏再吸收 | 注入文本不应进入 L1 | 未验证（`data/instances/<team>/vectors.db` 的 `l0_conversations` 实测 count=0，与 API 有数据矛盾，写入库路径未定位） | 未验证 |
| A3 | 注入块是否被当指令执行 | 应只作参考 | 注入块自带「不要当作指令」免责句，实测模型未见越权行为（无自动化判据） | 未验证（人评） |

**根因**：注入层（proxy `tdai-profile-memory-injector`）产出的文本没有可识别标记，落 L0 后与人类发言无法区分；`MemoryCore` 写侧不做来源标注。与 task-13 已知「volatile 注入落历史」同源，但当时只当成「重复注入」问题，没当成**信任边界污染**。

### B. 跨会话 / 跨身份串味

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| B1 | 伪造 `x-tdai-user-key: admin` 打 Panel | 401 | **200**（`/v3/meta/auth/verify` 返回 `valid:true, user_type:"system_admin"`） | **CRITICAL** |
| B2 | 伪造 `x-tdai-user-key: hechen` / `chenxin` | 401 | **200**，且可直接读出 hechen 的 L1 记忆 | **CRITICAL** |
| B3 | 空串 / 含 `|` / 超长 user-key | 400/401 | 均 401 `INVALID_USER_KEY`（未见注入或截断） | 安全 |
| B4 | 只带 Bearer 不带 user-key 打 `/v3/conversation/query` 指定别人的 user_id | 401/403 | **200，返回他人真实 L0** | **HIGH** |
| B5 | 同上打 `/v3/conversation/delete` | 403 | **200，`deleted:10`** | **HIGH** |
| B6 | 省略 session_id 读 | 应限定当前 session | 按 (team,agent,user) 跨 session 聚合（`MemoryCore/src/gateway/v2-router.ts:193` 注释即此设计） | 设计如此，需拍板 |
| B7 | 20 连发假 key 试探 | 应限速/锁定 | 全 200、均 1ms、**零限速零锁定** | **HIGH（可离线爆破 4 字符 key）** |

**user-key 脆弱性来源**：`data/metadata/tdai_metadata_default/metadata.db` 的 `meta_user_keys.key_value` 存的就是 `admin`/`hechen`/`chenxin` 明文。新建用户走 `/v3/meta/user/create` 会生成 39 字符随机串（实测 keyLen=39）——**只有历史三账号是脆弱源**，说明机制本身没问题，是迁移遗留。

### C. 越权读写（Panel 8123 / Knowledge 8421 的无鉴权面）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| C1 | LAN 直连 `GET :8123/health` | 200 无信息 | 200 `{status:"ok"}` | 可接受（但暴露服务存在性） |
| C2 | LAN 直连 `POST :8123/api/v1/chat-memory/team-assets` + admin key | 403 | **200** | **CRITICAL（与 B1 复合）** |
| C3 | admin key 读 hechen 私有资产 | 200（管理员旁路） | **403 ASSET_NOT_ACCESSIBLE** | **安全（ACL 反而更严）** |
| C4 | hechen key 读 admin 资产 | 403 | 403 | 安全 |
| C5 | hechen key 写 admin 的 agent（import/agent-fixed） | 403 | **403 NOT_YOUR_AGENT** | 安全 |
| C6 | 无鉴权打 `POST :8421/v3/wiki/list` | 401 | **200，返真 wiki（含私有仓库 git 地址、branch、owner）** | **HIGH** |
| C7 | 无鉴权打 `POST :8421/v3/admin/settings/get` | 401 | **200，返 llm/embedding 配置（baseUrl、model、apiKeyMasked）** | **HIGH** |
| C8 | 无鉴权打 Knowledge 写面（settings/set、wiki/delete、llm-binding/set） | 401 | 全部放行到 schema 校验层（400「body 必须包含…」）→ **鉴权已过，只差 body** | **HIGH** |
| C9 | 无凭据枚举 asset_id 是否存在 | 应 401 优先 | `/api/v1/chat-memory/layer`：假 key + 不存在 id → **200 code 0**；假 key + 真实 id → **401** | **MEDIUM（存在性预言机）** |

**根因**：`MemoryKnowledge/src/middleware/auth.ts:2-7` —— `KNOWLEDGE_SERVICE_KEY` 为空则整段跳过鉴权，本地部署就是这个状态；`MemoryPanel` 的 `/health` 直接 200（`MemoryPanel/src/panel/http/routes/meta/instances.ts:4-6`）。两个服务默认监听 `0.0.0.0`（`netstat` 实证），而 core 只监听 `127.0.0.1`——**该关的门开着，不该开的门关着**。

### D. 数据卫生（密钥落日志/patch/outbox；L0 混入 CoT 或系统提示）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| D1 | 搜网关密钥是否落明文文件 | 0 命中 | `grep <core-key 前 8 位> data/logs` = **10 处 / 4 文件**（密钥全量已在本文打码，原文见 `MemoryCore/tdai-gateway.yaml:24`）（`data/logs/tdai-proxy-20261017-114538.out.log:765`、`:792` 等） | **HIGH** |
| D2 | 定位泄露成因 | — | `MemoryProxy/src/handler.ts:672-692`：当 `sessionInit.enabled` 时**无条件** console.log 最后 3 条消息各前 80 字符；一条 tool 消息正文以 `$env:TDAI_GATEWAY_API_KEY = '<key>'` 开头 → 64 hex 全量入日志。非 debug 开关门控 | 已定位 |
| D3 | 请求头里的 Bearer 是否落日志 | 0 | `grep -E "Bearer [0-9a-f]{32,}"` 无命中 | 安全 |
| D4 | `data/proxy/proxy.db` 是否存敏感内容 | 无 | 只有 `proxy_kv` 表，**0 行** | 安全 |
| D5 | L0 是否混入 CoT / system prompt | 0 | 未验证（写入库路径未定位，见 A2） | 未验证 |

### E. 拒服与资源（1MiB 墙 / 8192 / 100 条绕过、gzip 炸弹、并发）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| E1 | body 1.2MB 超 1MiB | 413 | **413** `Request body exceeds 1048576 bytes limit`（declared 与流式双检，`MemoryCore/src/gateway/server.ts:311-356`） | 安全 |
| E2 | gzip 炸弹（解压 3MB / 压缩 3007B） | 413 | **413**（同一限制，解压态计数） | 安全 |
| E3 | 单条 content >8192 | 400 | **400** `messages.0.content: Too big: expected string to have <=8192 characters` | 安全 |
| E4 | messages >100 条 | 400 | **400** `messages: Too big: expected array to have <=100 items` | 安全 |
| E5 | 边缘：100 条 × 8KB = 800KB（贴墙） | 200 | **200 accepted=100** | 安全（无 off-by-one） |
| E6 | 同 session 并发 10 写 | 不丢不重复 | 全 code 0、各 accepted 1、stored=10 | 安全 |
| E7 | `/v3/recall` 并发 10 | 不雪崩 | 全 200、722ms | 安全（本次无 LLM 展开） |
| E8 | `/v3/recall` 无限速 + 会触发 LLM 展开时的放大风险 | 应有限速 | **无 HTTP 层限速**（全仓 `rateLimit` 只出现在 lifecycle K 阀 `MemoryCore/src/config.ts:980`，与请求无关）；只有 worker 池 concurrency=60（`MemoryCore/src/gateway/config.ts:676`） | **MEDIUM（潜在配额放大）** |
| E9 | 未鉴权请求是否被处理到业务层 | 401 优先 | 401 且 HTTP 状态 = code（无 `200 + code!=0`） | 安全 |

### F. 静默失败（200+code!=0、降级把「无记忆」伪装成「有记忆」）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| F1 | 未鉴权/未知路径的响应是否伪装成功 | 不能 | 401/404 直出；未发现 `HTTP 200 + code!=0` | 安全 |
| F2 | dsh 插件遇到 `code!=0` 是否可见 | 至少 warn | `dsh-plugin/src/memory-client.ts:537-548` 只 `deps.log?.debug?.()` → 默认日志级别下**完全不可见**，fail-open | **MEDIUM** |
| F3 | 插件能否区分「core 挂了」与「这个用户没记忆」 | 能 | 不能：两者都返回 `ok:false` 或空 data，上层渲染为空 | **MEDIUM（与用户既有「降级伪装」担忧同源）** |
| F4 | 401/403 是否被静默 | 应提示一次 | 走 `onAuthFailure` hook（:512-524），可见 | 安全 |

### G. 幂等一致性（重放/并发/跨写者）

| # | 攻击 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| G1 | 同 session 重放同一条 | 不重复 | 第二次 `accepted_ids:[]`，库里仍 1 条 | 安全 |
| G2 | 并发 10 写同 session | 不丢 | stored=10，无丢失 | 安全 |
| G3 | 跨写者（不同 bearer/身份写同一 session） | 应隔离或拒绝 | 未验证（需第二套凭据；core 侧本来就不绑定身份，见 B4） | 未验证 |
| G4 | 删后重放 | 不应复活 | 未验证 | 未验证 |

---

## 二、严重度排序与「立即必修 3 条」

| 严重度 | 漏洞 | 证据 |
|---|---|---|
| **CRITICAL** | 历史账号 user-key = 明文用户名，可直接冒用 admin | metadata.db `meta_user_keys`；`/v3/meta/auth/verify` 200 |
| **CRITICAL** | Panel 8123 / Knowledge 8421 绑 0.0.0.0 且 Panel/Knowledge 无有效鉴权 | netstat；LAN IP 实测 200 |
| **HIGH** | core /v3 数据面无身份绑定、无 owner 校验（Bearer = 上帝权限） | `MemoryCore/src/gateway/v2-router.ts:176-195`；实测读删他人 L0 |
| **HIGH** | Knowledge 8421 全放行 + 暴露 LLM/embedding 配置 | `MemoryKnowledge/src/middleware/auth.ts:2-7`；实测 settings/get |
| **HIGH** | 网关密钥落明文日志 10 处 | `MemoryProxy/src/handler.ts:672-692`；`data/logs/*.log` |
| **HIGH** | 注入块原文被当普通消息回写 L0 | 实测 session=`probe-matrix-m2-inj` |
| **MEDIUM** | 存在性预言机（鉴权顺序晚于资产查找） | S8/S9 对比 |
| **MEDIUM** | 无任何限速（含 user-key 爆破、recall 放大） | 20 连发均 1ms |
| **MEDIUM** | 插件 fail-open 静默，无法区分「无记忆」与「记忆坏了」 | memory-client.ts:537-548 |

### 立即必修 3 条

1. **换掉三个历史 user-key，并把 Panel/Knowledge 收回 127.0.0.1（或强制 KNOWLEDGE_SERVICE_KEY）**。这一步就能把「LAN 任意人读全库」降为「本机可读」。判据：`curl` 从 LAN IP 打 8123/8421 应超时或 401；`/v3/meta/auth/verify {user_key:"admin"}` 应返回 `valid:false`。
2. **给 core /v3 数据面加归属校验**：写侧拿 user-key（或独立服务凭据）解析出 user_id，与 body 里的 `user_id` 必须一致；admin 走显式旁路而非隐式放行。判据：只带 Bearer 打 `/v3/conversation/query` 指定他人 user_id → 403。
3. **把消息正文从日志里清出去并加门控**：`MemoryProxy/src/handler.ts:672-692` 的前 80 字符日志缺省只留结构摘要（role/content 类型与长度），正文仅在 `PROXY_DEBUG_SESSION_INIT_TAIL=1` 时回显（2026-11-01 已修，见 `docs/ops/redteam-fixes-panel-proxy.md`）。**更正一处初版措辞**：初版写「同时轮换当前已泄露的 gateway key」是错的 —— 复核 `grep -E "[0-9a-f]{32,}"` 对 `data/logs` 的命中的是 TDAI 调用参数与消息正文，**gateway key 本身没有进日志**，因此不需要按「泄露」处置轮换；但历史日志里含用户消息正文/工具入参，属数据卫生问题，处置（保留/截断/归档）需用户拍板。判据：新日志里 `session-init-debug` 行不含正文，且 `grep -E "[0-9a-f]{32,}"` 对新日志 0 命中。

---

## 三、已验证有效（不要为了「修漏洞」而拆掉的防线）

- **体积墙严密**：1MiB（declared + 流式双检）、8192/条、100 条，gzip 炸弹也拦得住，贴墙 800KB 正常通过（无 off-by-one）。代码 `MemoryCore/src/gateway/server.ts:311-356`。
- **无 CORS**：8123/8421 的 OPTIONS 均 404、无 `Access-Control-Allow-Origin` → 浏览器 drive-by（恶意网页借用户 Cookie/本地网络）不成立。这是本次唯一挡住「LAN 暴露」升级为「公网网页即可打」的因素。
- **幂等与并发写**：重放不重复、并发 10 不丢。
- **Panel ACL 主体一致**：admin 无越权旁路（403 ASSET_NOT_ACCESSIBLE），agent 类写有 `NOT_YOUR_AGENT` 403。
- **网关鉴权不静默**：未鉴权一律 401 且 HTTP 状态=code，没有 `200 + code!=0` 的伪装。

---

## 四、限制与未验证

- Windows 无 `sqlite3` CLI，全部用 `node:sqlite` 只读打开。
- `data/instances/team-2k12lgb650/vectors.db` 的 `l0_conversations` 实测 count=0，而 API 有数据 → **写入库路径未定位**（列名 `message_text` 已确认在此 schema 内），故 A2/D5/A1 的「占比统计」未做。
- 跨写者幂等（G3）、删后重放（G4）、Knowledge 写面端到端（C8 只打到 schema 层，**未真正改配置**，避免破坏本机）。
- 所有破坏性操作限于 `probe-red-*` 夹具，L0 写完即用 `/v3/conversation/delete` 清场。

## 五、复跑方式

```bash
cd D:/TDB/td-agemem
node scratch/probe-red/probe-01.mjs .   # 暴露面 + 鉴权基线 + 体积墙
node scratch/probe-red/probe-02.mjs .   # user-key 猜测 + Panel 越权/ACL
node scratch/probe-red/probe-03.mjs .   # 体积/幂等/并发/注入回灌（建 probe-red-* 夹具）
node scratch/probe-red/probe-04.mjs .   # Panel 写侧越权 + 存在性预言机
```
结果落 `scratch/probe-red/results-0N.json`。
