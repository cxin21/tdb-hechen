# 插件测试计时（task-102：消除 index.test.ts 两例固定等待）

## 判据与读数（`dsh-plugin/test/index.test.ts`）
| 用例 | 改前（scratch/task-98/run-{1,2,3}.log） | 改后（03:36 / 03:38 全文件） |
| --- | --- | --- |
| `re-resolves on every mount: nothing is persisted to the profile` | 3228 / 3237 / 3284 ms | 8 / 10 / 11 ms |
| `retries a transport reset exactly once, then dead-letters it` | 2050 / 2057 / 2046 ms | 14 / 16 / 39 ms |

同文件其余用例未动；文件总时长 49.1s → 45.5s（剩下的是另外约 50 次 `startApp` 各付 800ms 真实 seam 等待，见文末）。

## 慢因（实测，非推断）
`apply()` 对每个 mount 做两次有界 seam 等待：`waitForService('credentials', SEAM_WAIT_MS=800)`（src/index.ts:156 / :257）与 `waitForService('tools', TOOLS_WAIT_MS=800)`（:165 / :1058）。测试的 fake 组合不挂这两个服务，于是每 25ms 轮询一次直到 800ms 才放弃。
- 身份用例（两次 `startApp`）实测虚拟耗时 **1600ms/次**；写回用例（有身份）**800ms**。
- 所以 `retries` 那 2.05s = 800ms seam + 重试地板 1000ms + 轮询相位；`re-resolves` 3.2s = 2 × 1600ms。

## 手段（票面优先级 #2：只换时钟，不换断言）
`vi.useFakeTimers()` + 新增 `settleOnFakeClock(promise, budgetMs=5000, stepMs=100)`（test/index.test.ts:56-83）：mount 仍跑同一套轮询代码，只是把 25/800ms 的计时器按 100ms 步进推进，不再真实睡眠；`afterEach` 里 `vi.useRealTimers()` 兜底防泄漏。未改 src 的等待逻辑（那是产品行为），也未缩小任何超时窗口。

## 断言强度（不降，反而逐位）
- `re-resolves`：两次 mount 的虚拟耗时**恰好 1600ms**（= SEAM_WAIT_MS + TOOLS_WAIT_MS，断言 `toBe(1600)`），且 `/v3/meta/auth/verify` 仍为 2 次——不再等待、只等一次、或超预算都会红。
- `retries`：`+1100ms` 时 `seen===1` 且死信 0；`+1200ms`（`max(1000, retryMs)` 地板 src/outbox.ts:359 + interval 相位）时 `seen===2`、死信 1 条、`attempt===2`；`+2200ms` 仍 `seen===2` 且只有 1 条死信（死就是死）。原 `vi.waitFor(timeout:4000)` 换成精确毫秒窗：挂死会失败，而不是白等 4 秒再碰运气。

## RED 留档（证明守卫承重）
`scratch/task-102/red-proof.mjs`（日志 `scratch/task-102/red-proof.log`）：临时改 src 后跑，跑完按内存原文还原并校验 sha256。
- 变异 A（第二次 mount 跳过身份解析）→ 红：`expected [ { …(5) } ] to have a length of 2 but got 1`
- 变异 B（`entry.attempts < 1` 改 `< 2`，重放两次）→ 红：死信断言在 `+1200ms` 处失败
- 还原后 `sha256 = 9a1b0167b0ffed0d0ba420850cafdbec8922a491848854b77474fa35c2ffbb1c`，与改前逐字节相同（脚本自报 RESTORED byte-for-byte）。

## 读数（带时刻）
- 本文件：**55 tests / 2 failed**（03:39:05–03:40:18）。两红是 `serves persona plus the L2 scenario index…` 与 `compresses the live persona structure…`，**属 task-103 中间态**（`src/segments/persona.ts` 已停拼场景、`src/segments/l2.ts` 尚未接线，测试期望待其更新），与本票无关；单跑这两例同样红。
- 全仓 `npx vitest run`（03:39:05 起）= **34 files / 598 tests，2 failed（同上）**。
- `npx tsc -p tsconfig.json --noEmit` = 0 errors；`npm run build` rc=0。

## 未做 / 边界
- 未把该 helper 推广到其余用例（不在本票 scope）。若推广，文件还能再快约 40s：每次 `startApp` 的 800ms 都是同一个缺省 seam 等待。
- 虚拟时钟依赖 `vi.useFakeTimers` 同时伪造 `Date.now()`（`waitForService` 用 `Date.now()` 判 deadline），这是不改产品代码也能快进的前提；若将来等待改成注入时钟，应改成注入并保留这两处断言，而不是删掉。
