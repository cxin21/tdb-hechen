# core 侧缺陷修复 D-6 / D-7 / D-8（2026-10-31，task-58）

来源：`docs/ops/fullstack-test-capture-isolation.md` §4。范围仅 `MemoryCore/`，零 commit，8420 未重启。

## D-6（高）LLM 失败仍记 completed，L2 定时器继续推进

- **缺陷**：配额耗尽（实测 HTTP **402**）时 `tasksConsumed=4 / tasksCompleted=4 / tasksFailed=0`，
  `l1_records` 零新增。失败被吞在 runner 里，executor 看到的是"正常返回的空批次"。
- **根因**：`MemoryCore/src/utils/pipeline-factory.ts:423-431`（`createL1Runner` 返回类型）原先只有
  `processedCount/hasMore/hasFullBacklog`，失败批与"本批没活干"同型（都是 0/false）；
  `MemoryCore/src/gateway/server.ts:3543-3561` 于是照常 `armL1IdleAfterDrain` / `enqueueL1Drain`。
- **修法**：runner 增加显式 `failed` / `failureDetail`（`pipeline-factory.ts`、`l1-extractor.ts:364-369`
  透传 `error`、`tdai-core.ts:1123+` 的 `runL1WithStore` 透传）；`executeL1` 在
  `runL1WithStore` 之后、`_l2ProfileScopes` 之前 `throw new L1ExtractionFailedError(...)`
  （`MemoryCore/src/utils/task-failure.ts` 新增，携带分类）。**runner 本身仍不抛错**，
  `MemoryCore/src/utils/l1-runner-failure.test.ts` 的 F-EV12-1 不变量原样保留，只补 `failed` 断言。
  抛错使 `cascadeSchedule` / `onL1Complete` 全部跳过 → L2 定时器不再被失败批次推进。
- **H-15 语义**：不 fail-fast 退出进程（生产可用性优先）；单会话批次失败不拖垮实例，
  只让该 session 的任务走死信。理由已写进 `server.ts` 与 `task-failure.ts` 注释。
- **可观测**：`core.task.dead_letter` 事件新增 `failure_class` / `retryable`，死信日志带 `class=`。

## D-7（中）402 被判 transient 无限重试

- **根因**：重试策略只看 `retryCount < maxRetries`，没有失败分类；`classifyError` 把 401/403 归
  transient，`extract-worker` 的 transient 分支只按 streak 计数，402 在两条路径上都当"临时抖动"。
- **修法**：新增唯一分类源 `MemoryCore/src/utils/task-failure.ts`（`classifyTaskFailure` /
  `planTaskRetry` / `describeTaskFailure`），分类表写在文件顶部注释：
  | 类别 | 判定 | 可重试 |
  |---|---|---|
  | `quota` / `auth` / `data_schema` | 402 / 401·403 / 400·422（含 JSON·schema·zod 关键字） | 否 → 一次即死信 |
  | `rate_limited` / `upstream_5xx` | 429 / 5xx | 是 → `base*3^n`，封顶 60s |
  | `timeout` / `network` / `unknown` | AbortError / 网络关键字 / 兜底 | 是 → 保持原基线 |
  裸 `401/402/403/429` 故意不认（无 `status=` 前缀时误判会把好任务直接送死信）；
  `14002`、`line 4000` 这类数字串不误判。消费点：
  `MemoryCore/src/services/pipeline-worker.ts:516-565`（带锁路径）与同文件 lock-free 路径、
  `MemoryCore/src/core/skill/conversation-add/extract-worker.ts:437-505`。

## D-8 注入块服务端守卫（新增）

- `MemoryCore/src/gateway/injection-guard.ts`：6 条登记标记（与 `dsh-plugin/src/writeback.ts:195-202`
  同源）在**行首**匹配（子串不算），三档 `reject|skip|allow`，缺省 **skip**；
  环境变量 `TDB_INJECTION_GUARD_MODE` 可覆盖。
- 接线 `MemoryCore/src/gateway/v2-router.ts:958-1000`：命中消息不进 embedding、不落 L0，
  响应 `data.skipped` 计数；`reject` 仅在「标记命中 + `x-tdai-source-kind: plugin:*`」双证据
  时返回 400 `INJECTED_BLOCK`（单凭文本 400 会连带丢掉同批真实用户消息）。
- **缺省档位建议 = skip**，理由：一次 POST 最多 100 条，硬失败把"自注污染"升级成"用户数据丢失"；
  纯注入批次不再触发 `notifyPipeline`（rounds 只数真正落库的 user 消息），省一次 LLM 空跑。

## 调研（未改码）：错误 team_id 写入独立命名空间

- **现状**：L0–L3 数据面只校验"三个 ID 非空"（`v2-router.ts:187-207` `collectV3Missing`），
  **不校验归属**。`ensureChatMemoryAsset`（`v2-router.ts:943-956`）虽然每轮都调 metadata，
  但只登记资产、失败仅 warn，不是归属闸门。对比：metadata 面自己有闸
  （`knowledge-handlers.ts:92-96` 403、`v2-router.ts:3302/3315` 403）。
  ⇒ 任意 `team_id` 都能开出自己的 L0/L1 命名空间（实测 `team-bogus-000` 可写可读），
  数据不串到别人的 team，但**租户维度没有"这个 team 是否属于本调用方"的裁决**。
- **结论**：应当校验，且成本接近零 —— metadata 通路已在热路径上（LRU 短路），
  加一次 `(team, agent)` 归属查命中缓存即常数开销；只在 miss 时多一次 metadata 往返。
- **代价/风险**：① 归属数据缺失的历史 team 会从"能写"变成"400/403"，需灰度 + 白名单；
  ② metadata 故障时若硬失败会连带阻断记忆写入，必须 fail-open + WARN（与 `ensureChatMemoryAsset` 同口径）；
  ③ 需要产品先定错误码（建议 403 并审计，与 metadata 面一致）。
  **未改码，等拍板。**

## 测试

命令：`cd MemoryCore && npx vitest run src/utils/task-failure.test.ts src/services/pipeline-worker.failure-policy.test.ts src/utils/l1-runner-failure.test.ts src/core/skill/conversation-add/extract-worker.test.ts src/gateway/__tests__/v2-router-injection-guard.test.ts`
→ **5 files / 38 tests 全绿**（新增 25：task-failure 15、pipeline-worker 4、
injection-guard 6；extract-worker 4→9 新增 5；l1-runner-failure 4 不变但补 `failed` 反向哨兵）。
回归：`npx vitest run src/gateway/__tests__ src/services` → **15 files / 123 tests 全绿**。
类型门禁：`node scripts/typecheck-gate.mjs` → **240 errors / 44 files，基线 243，Δ=-3，PASS**。

## 没做 / 风险

- `executeL1` 的抛错分支没有网关级端到端测试（需要整套 server 依赖），证据是
  runner golden 的 `failed` 断言 + worker 分类测试 + 代码位置 `server.ts:3551` 前。
- D-8 的缺省档位（skip）与 `allow` 回退需 Lead 拍板；`/v2/conversation/add` 同样受守卫管辖。
- `extract-worker` 的 429 退避值未做真实等待测试，只断言 `requeueDelayMs` 的计算与封顶。
- 错误 team_id 归属校验按上文"等拍板"，未落码。
