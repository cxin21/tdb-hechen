# D-7 真修：LLM 失败的「结构化状态码」一路到底

> 票：task-84（来源 D-7，docs/ops/fullstack-test-capture-isolation.md §4 / docs/ops/verify-task58-review.md §3）
> 时间：2026-11-01 · 基线 main@17c0582 · 全部改动未提交
> 结论：**修好了，且有活体取证**（本地 402 端点 6/6 PASS）；typecheck gate Δ=-3。

---

## 1. 症状（生产实锤）

配额耗尽时（HTTP 402）`l1_tasks` 仍照常走 3 次退避重试，实测间隔 **[0, 234, 5018, 15016, 45031] ms**（首试 + 5s/15s/45s，共 64.9s）才死信；期间无任何读得懂的失败类别（class 落 `unknown`）。

## 2. 根因链（三层，缺一环都不成立）

| 层 | 事实（修前） | 后果 |
|---|---|---|
| ① 适配器 | `MemoryCore/src/adapters/standalone/llm-runner.ts` 的 catch 只把状态码拼进**日志**（`formatApiErrorDetail`），然后 `throw err` 原样抛出 | 状态码离开该函数就丢了 |
| ② 分类器 | `MemoryCore/src/utils/task-failure.ts` 只读 `err.name` + `err.message` | 供应商文案里没有 `status=402` ⇒ `unknown`（retryable=true） |
| ③ 决策 | `planTaskRetry` 对 unknown 按 `base*3^n` 退避 | 配额故障被放大成 3 次重试 + 64.9s 空转 |

⚠️ 关键事实：**供应商文案不带状态码**。生产原文是
`当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)` ——
只有业务码 `(2067)`，没有 HTTP 码。所以「把状态码塞进 message」这种修法不可靠，
必须让错误**对象**带字段。

## 3. 修法（单一事实来源：错误对象上的字段）

### 3.1 新增 `MemoryCore/src/utils/llm-error-annotation.ts`（无第三方依赖）
- `:18` `numberInRange`（只认 100..599）
- `:35` `extractHttpStatus(err)`：`statusCode` → `status` → `response.status`/`statusCode` → 文案 `status=NNN` 兜底
- `:50` `extractProviderCode(err)`：`responseBody` JSON 的 `code`/`error.code`（数字或字符串）→ 文案尾部 `(2067)`
- `:73` `annotateLlmError<T>(err): T`：**原地**挂 `statusCode`/`providerCode`（不覆盖已有值）；对象不可写时退化为 `new Error(msg,{cause})`，保留原 name/stack

### 3.2 适配器在抛错前标注
- `MemoryCore/src/adapters/standalone/llm-runner.ts:34` import
- `:593` `throw annotateLlmError(err);`（日志保持原样，`formatApiErrorDetail` 未动 —— 行为兼容）

### 3.3 分类器改为「结构化字段优先，文本兜底」
`MemoryCore/src/utils/task-failure.ts`：
- `:47` `TaskFailure` 增加 `providerCode?: string`
- `:77` `PROVIDER_QUOTA_CODES = {2067, insufficient_quota, quota_exceeded, insufficient_balance}`（宁缺毋滥，只放确定代表配额耗尽者）
- `:108` `structuredStatusCode`、`:121` `structuredProviderCode`（都支持沿 `cause` 下钻；**cause 缺失时必须停**，否则 asErrorLike 返回空对象会无限递归 —— 自测当场炸出 RangeError，已修）
- `:156` `classifyTaskFailure` 现在接受 `Error` **或** `{message,statusCode,providerCode}`；判定顺序：结构化字段 → 文本 `status=/code=` → 裸 401/402/403/429 → `:136` `bareStrict4xx`（只认 "400 Bad Request"/"422 Unprocessable Entity"）→ 裸 5xx
- `:191` 供应商码命中配额集合时**直接**判 `quota/retryable=false`（即使没有任何 HTTP 码）
- `:235` `describeLlmFailure(err)`、`:247` `classifyLlmFailure(detail, statusCode?, providerCode?)`：给上层 catch 用的统一出口
- `:283` `describeTaskFailure` 输出带上供应商码：`quota(http=402,code=2067)`（原来只有 http）
- `:299` `L1ExtractionFailedError` 增加 `statusCode/providerCode` 与第 4 个可选参数 `extra`

> 顺带修掉 task-71 复核发现的误判：`"processed 422 records ok"` 以前会被当成 HTTP 422 → data_schema 立即死信（好任务被误杀）。现在只有原因短语形态才算。

### 3.4 状态码从 runner 一路带到 worker（穿透 4 层返回值）
| 文件 | 行 | 改动 |
|---|---|---|
| `MemoryCore/src/core/record/l1-extractor.ts` | `:209-210` | `L1ExtractionResult` 增 `failureStatus/failureProviderCode` |
| 同上 | `:381` | catch 里 `describeLlmFailure(err)`，日志带 `(status=?, providerCode=?)` |
| 同上 | `:398-399` | 失败时把两字段放进返回值 |
| `MemoryCore/src/utils/pipeline-factory.ts` | `:451-452` | `createL1Runner` 返回类型增两字段 |
| 同上 | `:820-821` | 毒批对半拆分的失败合并取 `first ?? second` |
| 同上 | `:837-838`、`:882-883` | 累积并在 `failed:true` 时出栈 |
| `MemoryCore/src/core/tdai-core.ts` | `:1154/1156`、`:1203-1205` | `runL1WithStore` 透传 |
| `MemoryCore/src/gateway/server.ts` | `:3614-3617` | `new L1ExtractionFailedError(session, detail, stored, {statusCode, providerCode})` |

同时受益、**零改动**：`MemoryCore/src/core/skill/conversation-add/extract-worker.ts:736` 的 `classifyError` 直接调 `classifyTaskFailure` —— llm-runner 标注后它自动拿到真状态码。

## 4. 活体取证（scratch/d7-probe/live-402.mts，6/6 PASS）

本地起 OpenAI 兼容端点，对 `/v1/chat/completions` 恒回 **HTTP 402** + Ark 报文
`{"error":{"code":"2067","message":"…(2067)","type":"quota_exceeded"}}`，用真 `StandaloneLLMRunner` 打一次：

```
name         : AI_APICallError
message      : 当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)
statusCode   : 402          ← 修前不存在（只在日志里）
providerCode : 2067         ← 修前不存在
修复后 classify : quota(http=402,code=2067) retryable=false → plan=dead_letter @0ms
修前等价物(只传 message) : unknown retryable=true → retry 5000 → 15000 → 45000 → dead_letter
```

最后一行就是生产那 64.9s 的复现：**退避序列 5s/15s/45s 与生产实测逐位一致**。

## 5. 测试

| 文件 | 用例 | 说明 |
|---|---|---|
| `MemoryCore/src/utils/llm-error-annotation.test.ts`（新） | 13 | 状态码/供应商码提取各形状；原地标注不改 message；AbortError name 不被改写；无结构化信息零副作用；frozen 退化为包装且保留 cause/name；已有字段不覆盖 |
| `MemoryCore/src/utils/task-failure.test.ts`（增 8） | 23 | 新增「结构化字段优先」：文案无状态码但带 `statusCode=402` → quota；`providerCode=2067` 单独成罪；`describeTaskFailure` 含 `code=2067`；纯对象 422 → data_schema；`processed 422 records ok` → unknown；经典 "400 Bad Request" 仍认；`L1ExtractionFailedError` 用 extra 带码 → quota |
| `MemoryCore/src/services/pipeline-worker.failure-policy.test.ts`（增 1） | 5 | 生产形状（detail 无状态码 + extra 402/2067）→ 死信 1 次、不重试，且日志含 `quota(http=402,code=2067)` |
| `MemoryCore/src/utils/l1-runner-failure.test.ts`（增 1） | 5 | llm-runner 标注后的错误 → `res.failureStatus===402`、`failureProviderCode==="2067"`，游标仍不动 |

跑法与结果：
```
cd MemoryCore && npx vitest run src/utils/llm-error-annotation.test.ts src/utils/task-failure.test.ts \
  src/services/pipeline-worker.failure-policy.test.ts src/utils/l1-runner-failure.test.ts
→ 4 files / 46 passed

npx vitest run src/core/record src/core/skill/conversation-add <上面 4 个>
→ 29 files / 261 passed

npm run typecheck:gate
→ 当前 240 errors / 44 files；基线 243 / 44；Δ=-3 → PASS
```

## 6. 诚实边界

1. **未跑全量 `npm test`**（Lead 统一跑）；也没跑 gateway 端到端 HTTP 用例，只跑 record/skill/工具层相关 29 个文件。
2. **没重启 8420**（生产实例未动），活体取证全部在本进程内的临时端口完成。
3. `annotateLlmError` 的 `frozen` 分支只在测试里走到；生产错误对象（APICallError）可写，实际走的是原地标注。
4. 供应商配额码集合是**白名单**：新供应商若用别的码（比如 "quota_exhausted_v2"）仍会漏判 —— 需要按新码补 `PROVIDER_QUOTA_CODES`，代码里有单点。
5. `L2`/`reflection` 等其它 LLM 调用方目前**没有**改用 `describeLlmFailure`，但它们只要 `classifyTaskFailure(err)` 就能享受结构化字段（分类器直接读错误对象），无需逐处改。
