# L1 抽取会话隔离（task-62）

> 口径来源：用户 m02362「既有记忆检索可以跨会话拉，但是抽取的时候不能混到一起」。
> 基线 main@17c0582；本文件只记录事实与读数，无自我确认。

## 1. 缺陷（改动前事实）

| # | 位置 | 现象 |
|---|---|---|
| A1 | MemoryCore/src/utils/pipeline-factory.ts（createL1Runner 批处理） | 一个 sessionKey 下的全部 L0 行被 `flat()` 扁平成一个 groups 数组，多 session_id 时同一批送 LLM：抽取语料混杂。 |
| A2 | MemoryCore/src/core/prompts/l1-dedup.ts | 候选池（跨会话召回）与新记忆共处一个 prompt 段落，无 reference 标注、无「结论只基于 corpus」约束，模型无从区分。 |
| A3 | MemoryCore/src/utils/pipeline-factory.ts（游标） | `last_l1_cursor` 是 sessionKey 级单标量；若简单丢弃多余会话行再推进游标，被丢弃行永久跳过。 |

补充事实（非缺陷）：dedup 候选召回**故意**不带 sessionId（MemoryCore/src/core/record/l1-extractor.ts:538-542 注释：带 sessionId 会让新会话零候选、dedup 永远 store），隔离靠 team/user/agent/task filter。

## 2. 改动

### A. L1 单会话守卫（MemoryCore/src/utils/pipeline-factory.ts）

- **配置已接线（task-81）**：`memory.extraction.sessionScope: "session" | "profile"` 是 `ExtractionConfig`（MemoryCore/src/config.ts:52-65）的必填字段，缺省与非法值归一在 config 加载层（MemoryCore/src/config.ts:2122 附近，`str()` trim 后非空才返回值，`"PROFILE"`/数字/空串一律回落 `"session"`）；生产 `MemoryCore/tdai-gateway.yaml:110-114` 显式写 `sessionScope: session`。运行时只按值分支：pipeline-factory.ts:671-672 `cfg.extraction?.sessionScope === "profile" ? "profile" : "session"`，**不再软读取/cast**（软读会让「类型里有、运行时没有」无从对账）。
- :683 触发：`sessionScope === "session" && groups.length > 1 && batchSessionIds.length > 1` → 只保留 `groups[0].sessionId` 的 group；其余会话行计入 `deferredRowCount`。
- :682/:693 `cursorCeilingMs = deferredMinMs - 1`；:942-943 游标 `Math.min(maxRecordedAtMs, cursorCeilingMs)`，只推进到被延后行最早 `recordedAtMs` 之前 —— 保证 `recorded_at_ms > cursor` 不会跳过被延后行（代价：被选中会话晚于该水位的行下轮重取一次，dedup 兜底）。
- :694-698 一条 WARN 级 `[l1] session isolation` 日志（session_id 数 / 被延后会话数 / 行数 / 游标天花板）。
- :700-706 观测指标 `l1.batch.session_groups`（try/catch 静默，观测失败不影响业务）；:733-734 同族 `l1.batch.ignored_sessions`。
- 成功返回 `processedCount - deferredRowCount`、`hasMore || deferredRowCount > 0` → 被延后会话自动进入下一批，收敛（测试②证明游标最终=4000）。

### B. dedup prompt corpus / reference 分区（MemoryCore/src/core/prompts/l1-dedup.ts）

`formatBatchConflictPrompt(matches, valueCandidates?, corpus?: {sessionId?, agentId?})`（:202），第三参缺省兼容全部旧调用。

改动前后结构对照（示意，非完整 prompt）：

```
BEFORE                                  AFTER
────────────────────────────────────    ────────────────────────────────────────────
## 统一候选记忆池（共 N 条）             **语料/参考边界（会话隔离）**
[ {id, content, ...}, ... ]              - corpus 单会话，结论只能基于它
                                        - reference 带 source.session_id / agent_id
## 待判断的新记忆（共 M 条）              - 不得把参考独有事实写成结论/伪装来源
[ {id, content, ...}, ... ]           ──────────────────────────────────────────────
                                        ## 统一候选记忆池（reference：跨会话检索的已有记忆，
                                           共 N 条，其中 K 条来自其它会话；只用于判重/判冲突，
                                           不单独作为结论来源）
                                        [ {id, content, source:{session_id, agent_id}, ...}, ... ]
                                        ## 待判断的新记忆（corpus，共 M 条；均来自当前会话 session_id=X）
                                        [ {id, content, ...}, ... ]
```

- :244 空池文案同步改为 reference 口径；:251 池标题带「共 N 条 + 其中 K 条来自其它会话」。
- 调用侧 MemoryCore/src/core/record/l1-dedup.ts:266 传入 `{ sessionId: traceContext?.sessionId, agentId: traceContext?.agentId }`。
- 保留「统一候选记忆池」子串，不打断 l1-dedup.rewrite.test.ts / l1-dedup.call.test.ts / scripts/verify-c1.ts 的既有断言。

## 3. L2 profileScopes 结论（票面②③）

**是设计，不是跨会话污染。** 链路：L1 侧 `profileScopes.add(buildProfileL2Key({team,user,agent,sessionId}))` 把**源会话**编进 L2 任务键（MemoryCore/src/utils/pipeline-factory.ts:117-131）→ createL2Runner `parseProfileL2Key` 还原含 sessionId 的 filter，`queryMemoryRecords` 按 (team,user,agent,**sessionId**) 取输入，**L2 输入仍限单会话** → 之后按 `buildProfileIsolationScope(record)`（MemoryCore/src/core/profile/profile-sync.ts:20-33，返回 `team|user|agent`，注释 :31「sessionId/taskId 仍不进 scope，会话只做写入边界」）分组写 profile 目录，是**人物级输出聚合**。

因此不需要「按会话切 L2 输出」的开关；票面③的开关落在 **L1 抽取侧**（sessionScope session|profile，缺省 session）。影响面：仅「同 sessionKey 多 session_id」形态（Lead 实测 l0_conversations 211 session_key / 211 session_id，当前几乎不触发；本轮回调未复测）；单会话行为逐位不变。

## 4. 测试

| 命令（cd MemoryCore） | 结果 |
|---|---|
| `npx vitest run src/utils/l1-runner-session-isolation.test.ts` | 4/4 通过（新增） |
| `npx vitest run src/core/prompts/l1-dedup.corpus-reference.test.ts` | 5/5 通过（新增） |
| `npx vitest run src/utils/l1-runner src/core/record/l1-dedup src/core/prompts` | 15 files / 111 tests 全绿（含 l1-runner-failure.test.ts 4 条原不变量，未弱化） |
| `npx vitest run src/config/__tests__/config.extraction-session-scope.test.ts` | 5/5 通过（新增，task-81：缺省 session / 显式 profile / 显式 session / 非法值回落 / 生产 yaml 读回 session） |
| `node scripts/typecheck-gate.mjs` | PASS：240 errors / 44 files（基线 243 / 44，Δ=-3） |

## 5. 观测口径（task-81 写实）

**核心侧没有任何「指标注册表」或白名单**：`metricProducer` 是 `MetricProducerFacade`（MemoryCore/src/core/report/kafka-metric-producer.ts:112），`send()` 委托 `getObservabilityBackend().metric.send`；后端未初始化时**样本静默丢弃**（开源发行走 Noop/Console，生产走 Kafka → memory-monitor → Barad/ClickHouse）。因此「注册」这一步不在本仓，可做的只有两件事：

1. **核心侧发送**（已生效，无需开关）：`l1.batch.session_groups`（pipeline-factory.ts:700-706，命中守卫时 value=本批 session_id 数）、`l1.batch.ignored_sessions`（:733-734，卫生闸忽略的会话数）。
2. **结构化日志**（始终落盘，不依赖观测后端）：pipeline-factory.ts:694-698 `[l1] session isolation: N session_id in one batch — processing only … deferred M L0 row(s), cursor ceiling=… (session=…)`。

取证命令（生产日志）：

```bash
grep -F "[l1] session isolation:" <gateway-log> | tail -20     # 守卫是否被触发过
grep -c "l1.batch.session_groups" <gateway-log>                # 开源/无后端时不会有输出——属预期
```

判据：「守卫在位却零日志」= 未触发（当前 sessionKey:session_id≈1:1，见 §3）；「日志有、看板无样本」= 观测后端未接，样本丢弃，不影响抽取。

## 6. 跨会话候选 `(unknown)` 根因（task-81 ③）

- `(unknown)` 只出现在 prompt 渲染处：MemoryCore/src/core/prompts/l1-dedup.ts:237-238 `(c as { sessionId?: string }).sessionId || "(unknown)"`。
- 两条候选召回路径都**正确映射**了 sessionId：MemoryCore/src/core/record/l1-dedup.ts:372-387（向量路 `sessionId: r.session_id`）与 :420-436（FTS 路同）。`MemoryRecord`（src/core/record/l1-writer.ts:77-103）`sessionId` 也是必填 string。
- 所以 `(unknown)` 只能来自 `r.session_id` 为空串/缺失的**存量行**：`l1_records.session_id TEXT DEFAULT 'default'`（MemoryCore/src/core/store/sqlite.ts:774），store 打开时有一次幂等回填把 `''`/NULL 写成 `DEFAULT_ISOLATION_ID`（:799，L0 侧同款 :1162）。回填之后新读不再为空；**向量库 payload 里的旧 metadata 不会被这条 SQL 修**——那部分候选仍会显示 `(unknown)`。
- 结论：**不是映射 bug，不需要改代码「补」**。真要让旧向量 metadata 归位，得重跑 `l1_vec` 重建（写面动作，需单独排期与授权）；在此之前 `(unknown)` 的存在意味着「其中 K 条来自其它会话」会**偏小**（宁少不误标），不影响隔离正确性。

## 7. 未做 / 风险

1. `sessionScope: "profile"` 回退路径无 UI 暴露（`src/gateway/settings-override.ts:219-231` 的 extraction 白名单未含 `sessionScope`，改它需单独拍板）；仅用于灰度与排查。
2. 跨会话 reference 计数依赖候选对象上的 `sessionId`；`(unknown)` 情形见 §6，会使「来自其它会话」计数偏小。
3. 观测后端（Kafka/Barad）侧的看板与告警不在本仓，本轮未接；核心侧只有指标发送与日志（§5）。
4. 未重启 8420、零 commit；活体未复验（生产 sessionKey:session_id 近乎 1:1，守卫不触发，无可观测行为差异）。
