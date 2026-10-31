# task-71 · task-58（D-6 / D-7 / D-8）独立复核

复核人 record-pipeline｜基线 main@17c0582｜零 commit｜只报不改
产物：本文 + `scratch/review-task58/verify-live.mts`（活体）、`probe-classify.mts`（分类探针）、`live2.log`（本次读数）

## 0. 结论

| 项 | 交接声称 | 我判 | 关键依据 |
|---|---|---|---|
| D-6 LLM 失败不再记 completed | 已修 | **达成** | server.ts:3599-3605 抛错顺序 + 活体进死信、游标不动、L1 零行 |
| D-7 402 一次即死信 | 已修 | **未达成** | 活体：402 → `class=unknown` → 重试 3 次（5s/15s/45s，共 64.9s）才死信 |
| D-8 注入块守卫缺省 skip | 已修 | **达成（缺省档位仍待拍板）** | 活体 A1/A2/A3 + 行首匹配读码 |

分级合计：P0 0 条、P1 1 条（含同簇注释不符为 P1b）、P2 4 条。

## 1. 读码四条（path:line → 判定）

1. **分类表 vs 报告**：表本身一致（400/422→data_schema、401/403→auth、402→quota 均不可重试；429/5xx/network/timeout/unknown 可重试）。但 **报告 :33 与 task-failure.ts:87-90 注释所称「裸 401/402/403/429 故意不认」不成立** —— task-failure.ts:79-94 裸码是认的。probe 实测：`upstream returned 402 (quota exhausted)`→quota/不可重试；`processed 422 records ok`→data_schema/立即死信（恰是注释声称要避免的误判）。裸 402 该保留（真实供应商文案常无 `status=` 前缀），要收紧的是裸 400/422。
2. **两条路径都走 planTaskRetry**：成立。lock-free pipeline-worker.ts:320-325、带锁 :550-555；死信 :344/:581 → moveToDeadLetter(:777)；重试前均先 ACK（:333/:567）避免 XPENDING 重复消费；只有成功路径 :528→:532 才 cascadeSchedule。缺口见 P2-b。
3. **L1ExtractionFailedError 抛出位置**：成立。server.ts:3599-3605 throw 早于 :3607 `_l2ProfileScopes`、:3611-3617 reportUsage、:3626-3636 `enqueueL1Drain`/`armL1IdleAfterDrain` ⇒ 失败不推进 L2。残留窗口见 P2-c。
4. **injection-guard 行首匹配 + reject 双证据**：成立。injection-guard.ts:64-75 先 `replace(/^\s+/)` 再 startsWith 标记（含 `"\n"+marker`），非子串；:78-81 插件声明须 `plugin:` 前缀；:84-93 非法档位回落 skip。接线 v2-router.ts:965-1000，:968 要求 `pluginDeclared && findings>0` 双证据，响应 `data.code=INJECTED_BLOCK`。

## 2. 活体验证（隔离实例 8497 + scratch/review-task58/iso + 402 替身 LLM :8496）

结果 20/22 PASS，两个 FAIL 同源（= D-7，不是脚本缺陷）：

- **注入块守卫**：A1 200、`data.skipped=1`、`accepted_ids`=1，L0 只落真实那条（无 marker 文本）；A2 `reject` + `x-tdai-source-kind: plugin:dsh-codex` → 400 `data.code=INJECTED_BLOCK`、markers=["【agemem 记忆提示】"]；A3 同文本但无插件头 → 200 `skipped=1`（降级，不误伤用户粘贴）。
- **L1 失败落地**：HTTP 写入本身触发 L1（日志 `pipeline-v2 Threshold reached`，standalone capture 钩子）→ LLM 恒 402 → `tasksFailed` +3、`tasksDeadLettered` +1（64.9s 后，retryCount=3）、会话 `last_extraction_time` 未写、`l1_records` 零行（无半截）、L2 未级联。
- **402 只试一次**：**否**。chat/completions 命中时间轴间隔 `[0, 234, 5018, 15016, 45031]` ms ⇒ 首试 + 5s/15s/45s 三次退避重试；死信后 15s 观察窗无新增（已无修前 ~2s 无限自旋，收敛为有界 3 次）。
- 隔离不变量：8420 `/health` 前后各 200（未重启）；`D:/TDB/data` 零写入（库在 `iso/data/instances/iso71-service/vectors.db`，服务名独立命名空间）。

## 3. 缺陷与建议（只报不改）

- **P1 · D-7 对生产文案失效**：`llm-runner.ts:49 formatApiErrorDetail` 把 `status=` 只写进日志（:575），`err.message` 仅供应商 body 文案 → `l1-extractor.ts:374-376` 原样透传为 `failureDetail`（pipeline-factory.ts:821/:864）→ `classifyTaskFailure` 落 unknown/可重试。probe 钉死：去掉 `(status=402)` → `unknown/retry@5000ms`；加上 → `quota/dead_letter@0ms`。建议：把 `status=` 拼进 llm-runner 抛错消息（或让分类消费 `err.statusCode`），并补一条「无状态前缀的中文配额文案」用例。
- **P1b · 注释与实现不符（同一簇）**：task-failure.ts:151-157 与 l1-extractor.ts:370-372 都声称「错误消息含供应商状态码」——活体与 probe 均显示不含。
- **P2-a** 裸 400/422 数字误判（`processed 422 records ok` → 立即死信）。
- **P2-b** pipeline-worker.failure-policy.test.ts 只覆盖带锁路径，lock-free 分支（:303-364）无用例。
- **P2-c** 失败前 runL1WithStore 可能已落部分 L1 行（storedCount>0），这些行不级联到 L2 直到重试成功（server.ts:3599 抛错前已写入）。
- **P2-d** 失败后再来一个「空 L1」任务会代它推进 L2 定时器（本次实测 L2 timer advanced → L2 skipped 无数据，语义无害，但「失败不推进 L2」应按任务而非按会话断言）。

## 4. 38 例假绿抽查

无「必然通过的常量断言」、无「快照替代行为断言」：pipeline-worker 4 例用真 PipelineWorker + fake backend，断言 metrics/acks/onL1Complete 未调用；extract-worker 5 例断言 DLQ 长度与 retry_count。**但 fixture 不真实**：所有 402 用例都把状态码拼进 message（extract-worker.test.ts:140 `status=402`、task-failure.test.ts:92 `402 insufficient quota`），恰是生产不产生的形态 ⇒ 38 绿不覆盖真实失败文本，D-7 的「已验证」被高估。建议补「statusCode=402 + 中文 body 经 LLM run() 抛出」的用例。

## 5. 未验证 / 诚实边界

只验 standalone 单实例 + 本地 402 替身（未打真实 ark）；未验 429/5xx 真链路与会话级并发；D-8 缺省档位是否可上生产仍需 lead 拍板（交接方自认未决）；reject 档对插件真实流量的影响未测。
