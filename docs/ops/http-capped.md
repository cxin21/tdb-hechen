# 响应体上限 + URL scheme 闸（task-100）

结论：`memory-client` 的读取从「整段 `await response.text()`」改成**有界流式读取**（缺省 2 MiB，上限 16 MiB），并在新读取器里内置 `http/https` 白名单（本票只接到 `memory-client`，见「剩余面」）；诊断语义、返回结构、`v3<T>` 公共缝一个字节没动。

## 改了什么
- 新 `dsh-plugin/src/http-capped.ts`：`readCapped`（先看 `content-length`，超限**不读 body**；否则按流累加，超限 `reader.cancel()`）+ `fetchJsonCapped`（union：`ok|bad_url|bad_scheme|timeout|transport|http|too_large|bad_json`，**永不 throw**；不在 scheme 白名单时 fetch 调用 0 次）。
- `dsh-plugin/src/memory-client.ts:548` `call()`（接线在 `:598`）：只把 fetch+读取那一对换成 `fetchJsonCapped`（`timeoutMs: 0`，超时仍由它自建 controller 管，保 `aborted` 字段），分支判定与 debug 文案原样搬运；`:683 async v3<T>`、`:702 private async post<T>` 保留（skill-client 10 个技能工具依赖）。
- `dsh-plugin/src/config.ts:99/:293/:517`：`server.maxResponseBytes`（缺省 2 MiB、`0/缺省`=默认而非无限，sanitize 用 `clampMaxResponseBytes`）；`src/index.ts:322` 把配置传给 client。

## 语义不变的证据（诚实口径：仓内零 commit，贴不出改前实跑日志）
- 变更前就存在的断言全绿：`test/memory-client.test.ts` 57 例 + `test/skill-client.test.ts` 13 例（含 `code=1001` 软失败、401 触发 `onAuthFailure`、`aborted` 分支）。
- 新增三例把同一失败路径的 debug 串**逐字**锁死：`/v3/core/read -> HTTP 401`、`response was not JSON`、`response too_large endpoint=/v3/core/read declared=99999999`（`test/http-capped.test.ts`）。
- 变化面仅限「怎么读 bytes」：`call()` 的 kind→返回字段映射与文案未改，故 endpoint/status/reason 三字段取值路径不变。

## 剩余面（不在本票范围，已如实标注）
- `src/knowledge-segment.ts:399` 仍是 `await response.text()`（归 bench-metrics 的熔断改造）；wiki 段已无裸 `text()`。
- `service_url` 的真实取用点 `src/knowledge-segment.ts:399`、`src/tools/knowledge.ts:115` 仍直接 fetch，**没有过 scheme 闸**；`health()` 只判 `response.ok` 不读 body，故也未接。

## 复跑
- `cd dsh-plugin && npx vitest run test/http-capped.test.ts` → 19 passed；全量 `npx vitest run` → **29 files / 519 tests 全绿**；`npx tsc -p tsconfig.json --noEmit` rc=0；`npx tsc -p tsconfig.json`（build）rc=0，`dist/index.js` 02:49:10 已新于 `src/memory-client.ts` 02:46:21。