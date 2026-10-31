# Segment health (task-98) — 段级熔断器

## 为什么需要它
`volatile.wiki.enabled` 与 `volatile.knowledge.enabled` 缺省 **true**，但 `/v3/wiki/*` 在 8420 从未生效
（task-73 代码进了仓库、进程没重启加载 ⇒ 每轮必 404），core 停机时 knowledge 的 core 腿每轮必 transport 失败。
后果不是「少一条记忆」而是**每轮一次注定失败的 HTTP + 一条 warn**：日志被刷满、多一个 RTT、用户第一印象是满屏报错。

## 实现（dsh-plugin/src/segment-health.ts）
- `createSegmentHealth({name, threshold=3, cooldownMs=600_000, logger?, now?})`：
  `shouldAttempt()` / `recordSuccess()` / `recordFailure(reason)` / `describe()` / `snapshot()` / `reset()`。
- 状态机：closed → 连续 `threshold` 次**段失败**打开 → 冷却期内一律 false → 到期放行**恰好一个**探测
  （in-flight 标志，半开并发只探一次）→ 成功关、失败重新计时。
- 半开 lease 超过 `cooldownMs` 自动回收：调用方拿到 true 却没回报，不会把段永久锁死。
- 日志：每次打开**只**一条 warn（name/reason/threshold/cooldown），恢复一条 info；探测失败只 debug。
- 只把 transport / http_* / bad_envelope / bad_payload 算段失败（`isSegmentFailure`）；
  `no_hits` / `empty_list` / `budget_zero` / `deadline_empty` 是**健康端点的空答案，不计失败**。

## 接线（三条独立实例，互不连坐）
| 腿 | 实例 | 落点 |
| --- | --- | --- |
| wiki | `wiki` | `fetchWikiSegment({health})` → 熔断时 `reason='circuit_open'` |
| knowledge core 腿 | `knowledge-core` | `fetchKnowledgeSegment({health})` |
| knowledge tools 腿 | `knowledge-tools <service_url>` | `executeKnowledgeTool({health})` + `tools/knowledge.ts` 的 tools/list |

熔断打开时仍然 **fail-open**：返回空块 + `reason='circuit_open'`，与 `http_404` 可区分；
`describeWikiDiagnostic` / `describeKnowledgeDiagnostic` 追加 ` circuit=open(http_404, 3, retryIn=540s)`。

## 与 /v3/recall 那个熔断的区别
`src/index.ts` 的 `recallUnavailableStatus` 是**永久**关（422 = 配置错，重试无意义，且影响整条通道）；
这里的失败多是**临时**的（未部署 / 正在重启），所以必须冷却后放行探测。两者语义不同，不能合并。

## 手动复位
`health.reset()`（日志打 `segment health=closed (reset)`），或重启插件进程。没有对外配置开关：
阈值/冷却写死在常量，改需发版——这是刻意的，避免把「关掉观测」做成配置项。

## 验证
`dsh-plugin/test/segment-health.test.ts`（20 例）：3 次失败后第 4 次 fetch 调用数 = 0、半开并发 4 调用只探 1 次、
半开成功/失败、describe 三形态、warn 只打一次、bad_tool 不计数、两腿独立、register 句柄透传。
读数：`tsc -p tsconfig.json --noEmit` 0 错；`npm run build` rc=0；`npx vitest run` **30 files / 538 passed / 1 failed**，
失败项是 dsh-plugin 自己的 `test/segments.test.ts:140`（「no module registered a segment」期望空注册表，但 barrel 会 import
`src/segments/knowledge.ts:42` 自注册 `knowledge`，且 `afterEach` 用的 `resetSegmentsForTests()` 缺省 `keepBuiltins:true`）
—— 单跑该文件同样 1 failed/13，与本改动无关，归属 dsh-plugin。
本文件自身的 20 例（`test/segment-health.test.ts`）全绿。
