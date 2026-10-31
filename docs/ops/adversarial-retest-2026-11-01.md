# 对抗复测第二轮（2026-11-01）—— task-52 / 58 / 59 / 60 重打

只读复测，零改码零提交，未重启任何服务（8420/8123/8421 探针前后 /health 均 200）。
探针与原始读数：`scratch/probe-red2/probe-0{1..4}.{mjs,ts}` + `results-0{1,2,2b,3,4}.json`。

## 判据与结论总表

| 组 | 项 | 判定 | 证据 |
|---|---|---|---|
| task-52 | 写回断链（turn-stopping 无 agent） | **已封** | `dsh-plugin/src/writeback.ts:640-649` 缺 agent 时 warn、`:606-609` turn/end 兜底；活体：`l0_conversations` 中 GUI 会话 session-6fb73ffa… = **22 行**，末行 ts≈01:23（node:sqlite 只读查 vectors.db） |
| task-52 | GUI 文件日志 | **半修** | 机制在（`dsh-plugin/src/debug-log.ts:1-30`，opt-in `config.debug`），生产 `~/.dsh/profiles/desktop/cordis.patch.yml:223-233` **没开 debug** ⇒ 线上仍无日志通道 |
| task-52 | memory_recall 注册 | **已封** | `dsh-plugin/src/tools.ts:44`，口径说明 `src/guidance.ts:18` |
| task-58 | D-6 LLM 失败不再记 completed | **已封（代码）** | `MemoryCore/src/gateway/server.ts:3584-3605` 抛 `L1ExtractionFailedError`；`MemoryCore/src/utils/l1-runner-failure.test.ts` |
| task-58 | D-7 402 不再无限重试 | **已封（代码）** | `MemoryCore/src/utils/task-failure.ts:97` 402→quota/non-retryable；`MemoryCore/src/services/pipeline-worker.ts:546-547` 一次即死信；`task-failure.test.ts`、`pipeline-worker.failure-policy.test.ts` |
| task-58 | 注入块服务端守卫 | **半修** | skip/reject 两档生效但**识别面可绕过**（见下 T2）；只在缺省 skip 档有实际作用（见矛盾 4） |
| task-59 | ① 鉴权顺序前移（存在性预言机） | **代码已封 / 线上未生效** | 隔离 8489：假 key 下真 id 与不存在 id **同为 401 INVALID_USER_KEY**（results-04 I-fakekey.distinguishable=false）；生产 8123 仍 **401 vs 200** 可区分 |
| task-59 | ② 限速 | **代码已封 / 线上未生效** | 隔离 8488：顺序 130 次第 121 次起 429、140 并发 120 放行 20×429、XFF 无效、LAN 源 IP 第 61 次起 429；生产 8123 同 key 130 次 **130×401 零 429** |
| task-59 | ③ Proxy 日志脱敏 | **未复测（源码在位）** | `MemoryProxy/src/common/session-init-tail.ts` 在位、`MemoryProxy/src/handler.ts:679-689` 已改调用；本轮未重启 proxy，未取活体样本 |
| task-60 | 缺省档（无 user-key 不拒） | **已封** | 生产无 user-key `/v3/conversation/query` → 200 code 0（A1/A2） |
| task-60 | enforce 档 | **半修 + 生产禁用** | 见下 T7：读面也拒、无 key 也拒；2026-11-01 拍板定为生产禁用（`docs/ops/core-auth-binding.md` §6） |
| task-60 | 未知主体 reject 档 | **半修 + 生产禁用** | 写侧 400 UNKNOWN_PRINCIPAL 生效，但**读端点同为 POST 也被 400**（T8）；生产 entity 三表 0 行 ⇒ 一开即全拒，故同样生产禁用（§6） |
| 环境 | 8123 限速/预言机「已修未部署」 | **暂缓（等重启）** | PID 35812 启动 **00:29:41**，`rate-limit.ts` mtime 00:53、`chat-memory.ts` 00:52 ⇒ 进程早 23 分钟；命令行 `node --import tsx src/index.ts`（**无 watch**），无 `MemoryPanel/dist` ⇒ 重启即生效，不需 build |
| 环境 | dsh 插件线上 dist 滞后 | **暂缓（等重新安装）** | `~/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist/index.js` mtime **10-31 23:32**，`dsh-plugin/artifacts/*.tgz` 重打包 **11-01 01:22**、源码 `writeback.ts/index.ts` **01:24-01:25** ⇒ 安装物比源码旧约 2h |
| 环境 | 8421 绑定 0.0.0.0 + 只读白名单免 Bearer | **未变（运维项）** | 只带 `x-tdai-service-id: default` 打 `POST /v3/wiki/list` → 200 code 0；OPTIONS 404 无 ACAO（浏览器 drive-by 不成立） |

## 三处重点结论

1. **注入守卫有没有连带丢真实消息？没有。** 隔离实例同批写入「注入块 + 2 条真实消息」→ `{code:0, skipped:1, accepted:2, total_count:2}`，回读 total=2、roles=[user,assistant]、原文完好、markerLeaked=false。**但识别面是半修**：content 只有「首行是标记」或「换行紧跟标记」才命中；**一句前缀 + 换行 + 缩进标记** → `accepted:1, 无 skipped`，标记整段落库（markerStored=true）⇒ 主动伪造者随手即可绕过，守卫只能拦「老实复读」。
2. **限速：代码对，线上没有。** 顺序/并发/XFF/多 IP 四个维度在隔离实例全部符合设计（第 121 次 429、并发无竞态、XFF 伪造无效、LAN 源地址第 61 次 429），但**生产 8123 一次 429 都没有**——因为进程是修复前启动的。两个副作用值得写进运维口径：① 回环豁免 IP 维度 ⇒ 从本机换 key 即可无视 key 上限；② IP 桶 60/min 按源地址计，NAT 后的多用户会共享（R6a 打满后，R6b 同 IP 的合法 key 也全 429，最长 60s）。
3. **task-60 两档：缺省档合格；enforce 与 reject 已被拍板为「生产禁用」。** 缺省档无 user-key 读面 200（符合「没有 user-key 时不许拒」）。但 `MEMORY_AUTH_REQUIRE_USER_BINDING=1` 后：无 key、空串 key → **403 USER_BINDING_REQUIRED**，**读面同样 403**；错配 → 403 USER_BINDING_MISMATCH。而 DSH 插件 `dsh-plugin/src/memory-client.ts` 的 headers() 只发 `x-tdai-user-id`，**从不发 `x-tdai-user-key`** ⇒ enforce 一开，插件读写全 403。更值得裁决的是 admin 旁路：`x-tdai-user-key` 填任意垃圾 + `x-tdai-user-type: system_admin` + `x-tdai-admin-bypass: 1` → **200 code 0**（身份纯靠请求头自证，无凭据校验）；仅当两个开关同时显式打开才可达。**2026-11-01 拍板**：两档生产禁用已写入 `docs/ops/core-auth-binding.md` §6；admin 旁路升为 HIGH 并落 §7.1（最小复现 `scratch/probe-red2/probe-05.ts`，实测 B2a 冒充受害者 `user_id` 读到 `total=1`，B2b 自带身份同 session `total=0` ⇒ 越权纯属身份冒用）；攻防倒挂结论：enforce+bypass 同开时合法插件全 403、伪造两个 header 者可冒充任意 user，安全增益为 0、只增停服面。

## 矛盾清单

1. 票 vs 线上：task-59 ①② 已 complete，但两份代码均未部署（8123 无 429、预言机仍 401/200 可区分）。「已修」≠「已封」，验收口径必须含部署时间戳。
2. ~~文档 vs 口径~~ **已裁决（2026-11-01，task-86）**：Lead 拍板 enforce 与 reject 两档均为**生产禁用**（仅灰度/隔离实例），并已落进 `docs/ops/core-auth-binding.md` §6「生产禁用档」（两条理由带 file:line）；原 `:24`「仅对写 POST 生效」也按实测改为「读面同样生效」。缺省档满足「没有 user-key 时不许拒」，未变。
3. 代码注释 vs 行为：task-60 注释称未知主体策略「只对写 POST 生效、读面不拦」，实测 `POST /v3/conversation/query` 同样 400 UNKNOWN_PRINCIPAL（core 所有查询都是 POST）。**文档侧已改**（`docs/ops/core-auth-binding.md` §2 ③），**代码注释 `MemoryCore/src/gateway/v2-router.ts:823-824` 仍是错的**，待 Lead 排期。
4. 守卫设计 vs 现实：reject 档（400 闸）要求客户端自我声明 `x-tdai-source-kind: plugin:*`，但**全仓无任何客户端发送该头**（只有 `MemoryCore/src/gateway/injection-guard.ts:56` 定义、`v2-router.ts:867` 读取、测试与我的探针写）⇒ 生产实际只有 skip 档在工作，reject 档是无触发者的死配置。
5. 插件「已修」vs 安装物：源码 01:25 还在改（他人并行），已安装 dist 停在 10-31 23:32，重打包 tarball 01:22 未重新安装 ⇒ GUI 里跑的不是当前源码。
6. 日志可观测性：task-58 要求的「进死信 + 打可观测事件」，在 `D:/TDB/data/logs/tdai-core-20261101-003910.out.log` 里找不到可 grep 的 quota/死信事件行（`grep -i quota` 只命中检索正文）；同时该日志持续输出 `Lock conflict [L2] … retry 52 after 5000ms`——L2 单任务在 `lockTtlMs` 窗口内空转（有界，非死循环），但 300s LLM 超时持锁会把等待拉长到分钟级。

## 建议（不改码，供 Lead 排期）

- 重启 8123（零 build）后复跑 `probe-01.mjs` 与 `probe-04.ts` ⇒ 预期 R1 第 121 次 429、O1/O2 同为 401。
- 插件重装（`pnpm install` 重装 tarball 或 deploy.sh）后再跑一次 GUI 写回 + 一份 `debug: true` 的临时 profile 验证日志通道。
- 守卫：把「多段夹带」纳入 detectInjectedBlock（现只判首行/紧邻），或至少对 `plugin:` 声明客户端一律 reject 而非 skip。
- `allow` 档建议启动即 WARN（当前静默全关）。

## 8. 第三轮（2026-11-01 01:40–01:45，只测代码侧）

**基线指纹**：`MemoryCore/src/gateway/injection-guard.ts` sha256 前 16 位 `5cda69406f7dd331`（10341 B，mtime 01:37:41）；`MemoryCore/src/gateway/v2-router.ts` `9bc0cf72c896eb2c`（219882 B，mtime 01:38:57）。攻击性验证全部在隔离实例（8483 / 8484 / 8488 / 8489，自建自删）；对生产 8420 / 8123 / 8421 只做只读探针（`/health` 前后均 200）。

| # | 项 | 判定 | 一句话证据 |
|---|---|---|---|
| 1 | 存在性预言机（生产 8123） | **【线上未生效】** | 源码含 `requireChatMemoryCaller`（`MemoryPanel/src/panel/http/routes/chat-memory.ts:3431` 定义，:466/:633/:1090/:2371/:2450 五处挂载），同源隔离实例 8489 假 key 下真/假 id **同为 401**；生产仍 401 vs 200 ⇒ 旧进程（PID 35812 启动 00:29:41，早于 chat-memory.ts 00:52:37 / rate-limit.ts 00:53:17，`node --import tsx src/index.ts` 无 watch，无 dist） |
| 2 | 限速 IP 维度 + Retry-After | **【代码已封】** | 隔离 8488：LAN 源地址 10.4.100.50 无 key 70 次 → 前 60 次 400、第 61 次起 429；`Retry-After: 60`、`code: RATE_LIMITED`；回环 130 次第 121 次 429（key 桶 120/min） |
| 3 | task-60 四态读端点 | **【代码已封】** | 读端点 `POST /v3/conversation/query`：off 200 / warn 200 / reject 400 UNKNOWN_PRINCIPAL / enforce 403 USER_BINDING_REQUIRED；注释已改，见 §8.3 |
| 4 | admin 旁路是否只对匹配 user 生效 | **【已知残留】** | 旁路无条件，但单独用它不越权：C1 自带 user_id + 伪造 type+flag → 200 `total=0`；C3 同时把 body user_id 改写成受害者 → 200 `total=1`。见 §8.4 |
| 5 | 注入守卫识别面（task-85 已在位） | **【代码已封】+ 2 项残留** | 前导空格 / 前导空行 / CRLF / tab / 全角空格 / BOM / 4 行内标记 / ≥30% 兜底 全部 skipped；残留：① 第 4 个非空行之后的小占比块（设计取舍）② 零宽空格 U+200B 前缀。见 §8.5 |
| 6 | 插件注入块回写（skip 档计数） | **【代码已封】** | 未带 `x-tdai-source-kind` 的真实用户消息以 `【agemem 记忆提示】` 开头 → `skipped:1, accepted:1, total_count:1`，回读 `total=1`、`markerStored=false`（标记消息被丢、助手消息保留） |

### 8.1 存在性预言机：不是代码缺口，是旧进程

- 生产实测（`scratch/probe-red2/probe-07.mjs`，只读：全部打 `POST /api/v1/chat-memory/layer`，body 只含 block_id）：假 key + 真 id → **401 INVALID_USER_KEY**；假 key + 不存在 id → **200 code 0**，`distinguishable=true`。
- 同源隔离实例（`scratch/probe-red2/probe-04.ts`，8489，进程内 import 当前源码）：假 key 下真/假 id **同为 401**，`distinguishable=false`；无 key 两种情况同为 400 MISSING_USER_KEY。
- 时间线（`scratch/probe-red2/panel-proc.ps1` 取证）：PID **35812**，START **2026-11-01 00:29:41**，CMD `node --import file:///D:/TDB/etc/logtee.mjs --import tsx src/index.ts`（**无 --watch**）；`chat-memory.ts` mtime **00:52:37**、`rate-limit.ts` **00:53:17** ⇒ 进程比修复早 23 分钟；`MemoryPanel/dist` **不存在**（`Test-Path` False）⇒ 不存在「旧编译产物」这一解释，tsx 直接译源码，重启即生效。
- 判定：**【线上未生效】**。任何「已修」表述必须带进程启动时间戳，否则无法与「代码缺口」区分。

### 8.2 限速：代码侧四个维度全对

| 用例 | 读数 |
|---|---|
| 顺序同 key 130 | `{401:120, 429:10}`，首 429 在第 **121** 次，`Retry-After: 60` |
| 140 并发同 key | 120 放行 / 20×429（wallMs≈526，`takeToken` 同步无竞态） |
| 130 个伪造 XFF 同 key | 仍在第 121 次 429（XFF 不参与） |
| 回环换 90 个 key | 90×401 全放行（回环豁免 IP 维度，设计取舍） |
| **LAN 源地址无 key 70 次** | 60×400 后 **10×429**，首 429 在第 61 次（IP 桶 60/min 真生效） |
| LAN 同 key + 130 XFF | 全 429（IP 桶先被打满，IP 维度优先于 key 维度） |

运营风险两条（与第二轮一致，未变）：回环豁免 ⇒ 本机换 key 即无上限；IP 桶按源地址计 ⇒ NAT 后多用户共享 60/min。

### 8.3 task-60：文档 / 注释 / 实际 三者对齐

| 档位 | 读端点实际（probe-06） | 文档（`docs/ops/core-auth-binding.md`） | 代码注释（`MemoryCore/src/gateway/v2-router.ts`） |
|---|---|---|---|
| 缺省（off） | 200 code 0（无 key 不拒） | §2 ② 缺省全关 | :783-786「可配开关，缺省保持服务级信任」 |
| `warn` | 200 + `UNKNOWN_PRINCIPAL (warn-only)` 日志 | §5.2 口径 2 | :846-850 |
| `reject` | **400 UNKNOWN_PRINCIPAL（读面同样被拒）** | §2 ③ 已按行为改写「读面同样生效」 | :820-823 **本轮已改**（原「只对写 POST 生效」证伪） |
| `requireUserBinding` | **403 USER_BINDING_REQUIRED（读面也拒）** | §6 生产禁用 + 理由 1 | :794-819（判据不含 method，读面天然覆盖） |

注：`reject` 档与注入守卫 400 闸存在**执行顺序遮蔽**——reject 打开时写请求先被 router 的 UNKNOWN_PRINCIPAL 拦（probe-06 R2 即为此），注入守卫 400 只有 `unknownPrincipalPolicy=off` 时才可达（probe-08 X1 已证：400 `Injected memory block must not be persisted…`）。

### 8.4 admin 旁路：无条件放行，但单独使用不越权

`MemoryCore/src/gateway/auth-binding.ts:127-146` 的旁路分支在 key 比对**之前** return，因此不存在「只对匹配 user 生效」的约束。四例实测（probe-06，隔离 8484，`MEMORY_AUTH_REQUIRE_USER_BINDING=1` + `MEMORY_AUTH_ADMIN_BYPASS_ENABLED=1`）：

- C1 自带 user_id + `x-tdai-user-key: any-rubbish-key` + `x-tdai-user-type: system_admin` + `x-tdai-admin-bypass: 1` → **200 code 0，`total=0`**（放行，但数据面仍按自己的 user_id 过滤）
- C2 同组 header 但**缺** `x-tdai-admin-bypass` → **403 USER_BINDING_MISMATCH**
- C3 同上但把 body `user_id` 改写成受害者 → **200，`total=1`**（越权成立，来源＝身份冒用）
- C4 完全不带这三个头 → **403 USER_BINDING_REQUIRED**

结论：**旁路是身份类型的自证，不是「只对匹配 user 生效」的开关**；危害以「同时改写请求体 user_id」为前提，C1/C3 对照即最小反例。

### 8.5 注入守卫识别面：当前 HEAD 已封，剩两项残留

命中项（`skipped:1`、回读 `markerStored=false`）：首行前 2 空格 / 3 个前导空行 / CRLF / tab / 全角空格 U+3000 / BOM U+FEFF / 标记在第 3 个非空行 / 标记在第 4 个非空行且块占比 ≥30% / `【币值判定规则` / `<soul-identity>`。第二轮那条绕过（一句前缀 + 换行 + 缩进标记）现已命中（第 2 个非空行）。

负例（必须放行，实测 `accepted:1`）：正文里提及标记「我把【agemem 记忆提示】这段贴给你看，是不是有问题？」——不误杀。

**残留 1（设计取舍）**：标记落在第 4 个非空行之后、且块占比 <30% ⇒ 整段落库（probe-08 `W1b` `accepted:1`）。判定范围见 `MemoryCore/src/gateway/injection-guard.ts:47-60`，常量 `LEADING_NON_EMPTY_LINE_LIMIT=3`（:85）、`MIN_MATCHED_SEGMENT_RATIO=0.3`（:88）。

**残留 2（task-92 已封）**：`\u200b`（零宽空格）前缀曾可绕过 ⇒ `accepted:1`。归一化原只剥 `[\s\u00a0\u3000]`，U+200B 属 Cf 类不在其中；BOM U+FEFF 因 JS `\s` 含它反而被剥掉（`W5` skipped）。**已修**：`LEADING_INVISIBLE_CHARS_RE = /^[\s\u00a0\u3000\u200b-\u200f\u2060\ufeff]+/u`（`MemoryCore/src/gateway/injection-guard.ts:96-116`）。隔离实例 8487 复跑：zwsp / zwnj / word-joiner / zwsp+缩进 四形态全部 `skipped=1`；负例（长正文中段行首带 ZWSP 的引用、句中夹 ZWSP）仍 `accepted`，零误杀。

> **Cf 仅行首，标记内部不归一化 = 有意不处理**（Lead 2026-11-01 裁决）：把 `<soul\u200b-identity>` 拆开已经不是我们的注入块、不构成自我中毒；真在标记内部再做一层归一化，代价是把「用户就在讨论这个字符串」判成注入。要做也必须再引「只对已知整块形态生效」的上下文判据，收益不抵复杂度。

### 8.6 插件注入块回写（skip 档计数基线）

probe-06 `B1`：未带 `x-tdai-source-kind` 的真实用户消息（内容为 `【agemem 记忆提示】…`）+ 一条助手消息 → `{status:200, code:0, skipped:1, accepted:1, total_count:1}`，回读 `total=1`、`markerStored=false`。即：**识别只看内容不看声明**；声明只影响 reject 档是否升级为 400。

### 8.7 本轮改的代码（注释，Lead 授权）

`MemoryCore/src/gateway/v2-router.ts:820-823`：删除「只对写（POST）生效，读面不因 entity 表缺登记被拦」，改为「判据是 `method === "POST"`，而 /v3 读端点同样是 POST ⇒ 读面同样生效」，并指向 `docs/ops/core-auth-binding.md` §2 ③。`grep -rn '只对写（POST）生效'` → 0 命中。typecheck gate：**240 errors / 44 files**（基线 243，Δ=-3，PASS）。

### 8.8 复跑命令

```bash
cd MemoryCore && node --import tsx ../scratch/probe-red2/probe-06.ts   # 8484：注入识别面 + task-60 四态 + admin 旁路
cd MemoryCore && node --import tsx ../scratch/probe-red2/probe-08.ts   # 8483：残留变体 + reject 闸（policy=off）
cd MemoryPanel && node --import tsx ../scratch/probe-red2/probe-03.ts  # 8488：限速五维度
cd MemoryPanel && node --import tsx ../scratch/probe-red2/probe-04.ts  # 8489：预言机（生产 vs 隔离）
node scratch/probe-red2/probe-07.mjs                                   # 生产 8123 只读复核（不写任何东西）
powershell -NoProfile -File scratch/probe-red2/panel-proc.ps1           # 8123 进程 PID/启动时间 + 文件 mtime + dist 存在性
```
