# 红队发现修复记录 · Panel 鉴权顺序 / 限速 / Proxy 日志脱敏（task-59）

- 上游报告：`docs/ops/adversarial-review-2026-11-01.md`（红队实战，探针 `scratch/probe-red/probe-0{1..4}.mjs`）
- 本记录只覆盖能做代码修复的三类；**运维类**（收回 127.0.0.1 / 换历史 user-key）与 **core 数据面归属校验**（task-60）不在本轮。
- 零 commit：工作树未提交（仓库当前无任何 commit 基线）。

## 一、Panel 鉴权顺序前移（存在性预言机）

**根因**：五条写路由先做 schema 校验与资产查找，最后才解析调用方身份，于是「假 key + 不存在的 id」与「假 key + 存在的 id」返回不同错误码 —— 未鉴权者可以借此枚举 block_id。
证据（修复前实测）：`S8` 假 key + 虚构 block_id → `200 code 0`；`S9` 假 key + 真实 block_id → `401 INVALID_USER_KEY`（`scratch/probe-red/results-02.json`）。写侧同类：`S4/S6` → `403 NOT_YOUR_AGENT`、`S1` → `404 BLOCK_NOT_FOUND`、`S2/S3/S5` → `400`。

**修法**（`MemoryPanel/src/panel/http/routes/chat-memory.ts`）：
- 新增 `requireChatMemoryCaller(deps)` 中间件（定义在 `resolveCallerUserId` 之后，:3378 起）：先 `buildCtx` + `resolveCallerUserId`，失败立即 `401 INVALID_USER_KEY`，成功写入 `c.set("callerUserId", userId)`。
- 挂到五条路由（均在 `validatePanelMetaHeaders(deps)` 之后）：create(:462)、patch-scope(:627)、layer(:1082)、clear(:2359)、layer-delete(:2434)；删除各自的 inline 身份解析，改用 `c.get("callerUserId")`。
- 效果：鉴权先于 schema 与资产查找，未鉴权请求不再产生任何资产查询。

**测试**：`MemoryPanel/tests/chat-memory-auth-order.test.ts`（9 tests）— 五路由 × {合法 body / schema 非法 body / 虚构 block_id} 一律 401，且 `invoke` 只出现 `auth/verify`；真实 vs 虚构 id 的响应除 `request_id` 外逐字相同；带合法 key 时 400/404 分支仍按原语义工作。

## 二、鉴权面 HTTP 限速

**根因**：`/v3/meta/auth/verify` 20 连发假 key 全 200、均 1ms，全仓无请求级限速（`rateLimit` 仅出现在 `MemoryCore/src/config.ts:980` 的 lifecycle K 阀，与 HTTP 请求无关）。历史 user-key 只有 4–7 字符（即用户名），可离线穷举。

**修法**：
- 新文件 `MemoryPanel/src/panel/http/middleware/rate-limit.ts`：固定窗口计数 `takeToken(buckets, key, rule, now)`（被拒不计数、`retryAfterSec` 向上取整≥1）；默认 `DEFAULT_KEY_RULE={max:120,windowMs:60_000}`（按 `x-tdai-user-key`）、`DEFAULT_IP_RULE={max:60,windowMs:60_000}`；超限 `Retry-After` + `429 RATE_LIMITED`；桶表上限 10000，超限时清理过期桶。
- `clientIp` 缺省用 `@hono/node-server/conninfo` 的 `getConnInfo`，**回环地址（127.0.0.1 / ::1 / localhost / ::ffff:127.0.0.1）与取不到地址一律跳过 IP 维度**——威胁模型是 LAN 侧，本机与开发代理不应自我 DoS。
- 接线：`MemoryPanel/src/panel/http/app.ts` 新增 `PanelAppOptions{rateLimit?: RateLimitOptions|false}`，在 `requestLogger` 之后、健康路由之前 `app.use(`${API_PREFIX}/*`, rateLimit(...))`；`rateLimit:false` 可整体关闭（测试与内嵌场景）。

**测试**：`MemoryPanel/tests/rate-limit.test.ts`（12 tests）— 纯函数三条（上限/被拒不计数/retryAfter 取整）；中间件层：正常流量不误伤、突发 429 且带 `Retry-After: 60`、窗口滚动恢复、异 key 独立、**IP 维度挡住「换 key 爆破」**、回环不限 IP、无 key 不参与 key 维度、非 `/api/*` 不受影响；接线层用真实 `buildPanelApp` 断言 200/200/429 + 换 key 200 + `false` 时全 200。

## 三、MemoryProxy 日志脱敏（消息正文不再落盘）

**根因**：`MemoryProxy/src/handler.ts:672-692`（旧编号）在 `sessionInit.enabled` 时把最后 3 条消息的 `content.slice(0, 80)` 直接 `console.log`，用户消息正文与工具入参进入生产日志；全仓其余 dump 点（`:340-352`、`:356-373`、`:541-556`、`:560-633`）本来就有环境变量或配置门控。

**修法**：新增 `MemoryProxy/src/common/session-init-tail.ts`（`summarizeSessionInitTail` / `isSessionInitTailDumpEnabled` / `SESSION_INIT_TAIL_ENV`），handler 改为调用它：
- 缺省只输出 `role`、content 的类型与**长度**（`string(len=123)` / `array[text,image_url]`）、`tool_call_id` 前 8 位（`call_012…`）；
- 正文仅在 `PROXY_DEBUG_SESSION_INIT_TAIL=1`（严格等于 1）时回显，且仍截前 80 字符；
- 异常形状（null / 缺字段 / 非字符串 role）不抛异常，只降级成 `role=?`。

**测试**：`MemoryProxy/src/common/__tests__/session-init-tail.test.ts`（7 tests）— 缺省不含正文（含中文人名/密码样例）、开关才含且截断 80、数组 content 只报 block 类型、长 id 截断、只取最后 3 条、异常形状不抛、开关严格等于 `"1"`。

## 四、验证读数（修复后实测）

| 套件 | 修复前 | 修复后 |
| --- | --- | --- |
| `cd MemoryPanel && npx vitest run` | 30 files / 265 tests | **32 files / 286 tests 全绿** |
| `cd MemoryPanel && npx tsc --noEmit` | exit 0 | exit 0 |
| `cd MemoryProxy && npx vitest run` | 63 files / 561 tests | **64 files / 568 tests 全绿** |
| `cd MemoryProxy && npx tsc --noEmit` | exit 0 | exit 0 |

**复跑命令**
```bash
cd MemoryPanel && npx vitest run tests/chat-memory-auth-order.test.ts tests/rate-limit.test.ts
cd MemoryProxy && npx vitest run src/common/__tests__/session-init-tail.test.ts
```

## 五、未做 / 残余（交回 Lead）

1. **插件 fail-open 仍不能完全区分「无记忆」与「记忆坏了」**（对应报告 MEDIUM 行）：
   - recall 侧已可区分 —— `dsh-plugin/src/index.ts:470-500` `warnRecallFailure` 对 404/422/504 各 warn 一次并置电路（422 本进程熔断，404/504 退避 10 分钟），`401/403` 走 `onAuthFailure` 一次性 warn（`dsh-plugin/src/memory-client.ts:511-523` + `index.ts:341-349`）。
   - **未覆盖**：head pack / 人格读取。`dsh-plugin/src/index.ts:403-428` 的 `fetchHeadPack` 把 `client.readCore()` 的失败折叠成 `undefined` → `core?.content ?? ''` → 空文本 → `composeHeadPack` 返回空 → `undefined` → `HeadPack.current()` 回落 `fallbackText`（`dsh-plugin/src/head-pack.ts:192-196`），**全程无 warn**（`head-pack.ts:225` 只在「保留旧值」时 debug）。也就是说核心中途 500/超时时，注入的人格会静默变空，与「这个人本来就没画像」不可区分。
   - 建议（本票未实施，`dsh-plugin/` 不在本票 write scope）：`fetchHeadPack` 区分「`readCore` 失败（返回 undefined）」与「成功但内容为空」，前者用 `warnOnce('headpack'` 类开关报一次，并在 ready 行带上读数；判据是单测断言两种情形只 warn 一次。
2. **历史日志含用户正文**：`MemoryProxy/logs/` 与 `D:/TDB/data/logs/` 下旧文件仍有正文片段。**未删除未改写** —— 保留/截断/归档需用户拍板后统一处置（Lead 已认领）。
3. **未做运维动作**：Panel 8123 / Knowledge 8421 的绑定地址、三个历史明文 user-key（Lead 请示用户）。本轮**没有重启任何服务**，只有 `vitest` 与 `tsc`。
4. **威胁模型边界**：限速是进程内计数（单实例），多副本部署时按副本各算一份；不是网络层防线，LAN 内横向流量的采集仍需边界设备。
