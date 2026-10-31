# core 活体验证：隔离第二实例（task-39）

> 目的：给今天 core 侧三项改动（**413 可诊断性**、**skill 入口幂等**、**L0 幂等**）补上**装配链**证据 —— env/yaml → config → handler → 落盘/响应。单测只证明模块，不证明这条链；线上 8420 跑的是改动前的进程，task-31 的 e2e 也打不到新代码。
>
> 结论：**三条链全部活体通过（25/25 检查项，exit 0）**，且全程只在隔离 baseDir 落盘、未重启 8420、未写 `D:/TDB/data`。同时发现一处口径偏差：**`/v3` 的 413 不带 `limitBytes`/`hint`**（见 §7 局限与 `docs/ops/dsh-plugin-conformance-review.md` §10.4.1 / P2-5）。

- 日期：2026-10-31 22:14–22:15（Asia/Shanghai）
- 基线：`main@17c0582` + 本工作树未提交改动（未 commit、未 git add）
- 环境：Node v22.22.2、tsx v4.23.15、Windows（git bash）；生产实例 8420 全程未重启（`/health` uptime 6061 → 6065）
- 脚本：`MemoryCore/scripts/verify-core-live.ts`（可复跑）；配置：`scratch/core-iso/config.yaml`；原始输出：`scratch/core-iso/run.log`、`scratch/core-iso/verify-result.json`

## 1. 隔离不变量

| 维度 | 生产实例（8420） | 本验证实例（8499） |
|---|---|---|
| 配置来源 | `MemoryCore/tdai-gateway.yaml` | `TDAI_GATEWAY_CONFIG=scratch/core-iso/config.yaml`（yaml 裁剪副本，显式路径优先级最高，见 `src/gateway/config.ts:401`） |
| 监听 | 127.0.0.1:8420 | 127.0.0.1:8499 |
| `data.baseDir` | `D:/TDB/data` | `D:/TDB/td-agemem/scratch/core-iso/data` |
| apiKey | 生产 key | `iso-task39-local-only-key`（仅本机隔离实例） |
| LLM | minimax | `http://127.0.0.1:9/v1`（discard 端口，只证不依赖 LLM 的链路） |
| embedding | openai_compatible（ark，2048 维） | `enabled:false` / `provider:"none"` ⇒ 无 client embedding，零网络 |
| 其它 | capture/recall/lifecycle/skill 全开 | capture+skill 开（被验链路需要），recall/lifecycle/warmup/extraction 关，observability 四段全 false |

启动方式（真进程、真端口、真 HTTP，不是 in-process mock）：

```bash
cd /d/TDB/td-agemem/MemoryCore
node --import tsx scripts/verify-core-live.ts 8499
```

脚本内部：设 `TDAI_GATEWAY_CONFIG` / `TDAI_METADATA_SQLITE_BASE_DIR=<baseDir>/metadata`、清掉 `MEMORY_MAX_BODY_BYTES`（验缺省 1 MiB），`new TdaiGateway({server:{port,host,apiKey}, data:{baseDir}})` → `await gateway.start()`（`src/gateway/server.ts:480` 构造器 + `:3850` CLI 之外的第二入口），然后发真请求（`http.request`，`agent:false`）并直接读磁盘断言，最后 `gateway.stop()` 并复查端口不可达。

## 2. C0：生效配置（装配链第一段：yaml → config）

```text
config file        : D:\TDB\td-agemem\scratch\core-iso\config.yaml
server.port        : 8499
server.host        : 127.0.0.1
data.baseDir       : D:\TDB\td-agemem\scratch\core-iso\data
memory.embedding   : {"enabled":false,"provider":"none"}
MAX_BODY_BYTES     : 1048576 (1 MiB = 1048576)
PASS [C0-port] / [C0-base-dir] / [C0-embedding] / [C0-body-limit]
```

同时用启动日志证明 store 落在隔离目录（这行是 `store-pool` 打的，不是脚本自报）：

```text
[memory-tdai][factory] Store created: backend=sqlite, dbPath=D:\TDB\td-agemem\scratch\core-iso\data\vectors.db, dimensions=0, embedding=disabled, bm25=enabled
[store-pool] Created sqlite store for default: sqlite @ D:\TDB\td-agemem\scratch\core-iso\data\vectors.db (pool size: 1)
[store-pool] Initialized: mode=sqlite, maxStores=1000, maxSkillStores=100, bm25=shared
```

## 3. #123 回归：noop embedder 不被判为可用（`stores.embeddingService=false`）

任务 A 的验收点：**没配 embedding / provider=noop 时，`/health` 不能报 ok**。活体（fresh 库、无 client embedding）：

```text
GET /health -> 200
{"status":"ok","version":"0.1.0","uptime":0,
 "stores":{"vectorStore":true,"embeddingService":false},
 "services":{...},
 "memory":{"embedding":"degraded","embeddingConfigured":false,"embeddingProvider":null, ...},
 "warmup":{...}}
PASS [S-health-vector-store]      stores={"vectorStore":true,"embeddingService":false}
PASS [S-health-embedding-noop]    memory.embedding={"status":"degraded","configured":false,"provider":null}
PASS [S-health-noop-not-counted]  stores.embeddingService=false（#123：noop 不算可用 embedding）
```

启动期只有一条 WARN，且是「一次」而非每请求：

```text
WARN [vector-health] embedding degraded: no embedding service (client embedding not configured) (reason=not-configured)
WARN [embed-backfill] skipped: embedding service unavailable
```

落库侧行为（H-15「降级 + WARN」语义）：向量写入被**静默跳过而不是报错**，meta 仍写入（`sqlite.ts:4970-5017` 的 `skipVec` 分支）：

```text
[L0-upsert] START id=msg-6a6abd5c…, session=iso-…-l0-idem, role=user, embeddingDims=0, embeddingNorm=0.0000 (ZERO VECTOR or vec tables not ready …)
[L0-upsert] Skipping vec write (zero vector) id=msg-6a6abd5c…
[L0-upsert] OK id=msg-6a6abd5c… (meta-only)
```

## 4. A：413 可诊断性（1 MiB 字节墙）

同一路由、同一进程、只改 body 大小：

| 用例 | body | 结果 |
|---|---|---|
| A1 | 495 865 B（60 条 × 8192 字符，schema 内） | `200` in 269 ms，`data.accepted_ids` 60 条 |
| A2 | 1 307 165 B（100 条 × 13 000 字符） | `413` in **7 ms** |
| A3 | — | 紧接 A2 再 `GET /health` → `200`（连接未被毒化、进程未崩） |

A2 原文：

```text
POST /v3/conversation/add -> 413 in 7ms
headers: {"connection":"close","content-type":"application/json","content-length":"169"}
body   : {"code":413,"message":"Request body exceeds 1048576 bytes limit",
          "request_id":"req-914dc90f64ef40e1","trace_id":"5b6097f0-7b2e-4162-833b-a56105a352f2",
          "retryable":false}
PASS [A2-413-json]            status=413 code=413 retryable=false，message 含 1048576
PASS [A2-not-econnreset]      status=413（0/ECONNRESET 才是修前表现）
PASS [A2-connection-close]    connection=close
PASS [A2-detail-fields]       /v3 路径不带 limitBytes/hint（见下）
PASS [A3-alive-after-413]     GET /health -> 200
```

判读：

1. **修前是 ECONNRESET（curl exit 56 / `TypeError: fetch failed`），现在是确定性 413 + JSON** —— 客户端可据此判「确定性失败，不要重试」（对应 `dsh-plugin` P0-2 的最小修法）。
2. **口径偏差**：`/v3/**` 的 413 由 `v2-router.ts:766-779` 自己的 catch 组装，只带 `code/message/request_id/trace_id/retryable`；`limitBytes`/`hint` 只在 `server.ts` 顶层 413 catch（非 v2 路由）才有。task-36 的单测与报告描述的是后者，**对 /v3 属过度声明**。已在 `docs/ops/dsh-plugin-conformance-review.md` §10.4.1 更正并记为 **P2-5**（修法一行，但 `v2-router.ts` 不在 task-36/39 的 write scope，未实施）。字节墙本身仍可诊断：`message` 里带 1048576。
3. `connection: close` 来自 Node「request 未读完即结束响应」的自动行为，恰好等价于「413 后关连接」，无需额外代码。

## 5. B：skill 入口幂等（`/v3/skill/conversation/add`）

payload（4 条、含 tool 对，`space_id=iso-service`，session `iso-<run>-skill`）：

```json
{"session_id":"iso-…-skill","space_id":"iso-service",
 "user_id":"iso-user","team_id":"iso-team","agent_id":"iso-agent",
 "messages":[
   {"role":"user","content":"iso skill dedupe probe …"},
   {"role":"assistant","content":"ack …"},
   {"role":"tool_call","content":"pnpm run lint #1","tool_name":"bash","tool_call_id":"c1"},
   {"role":"tool_result","content":"ok 1","tool_name":"bash","tool_call_id":"c1"}]}
```

| 步骤 | 请求 | 响应原文 |
|---|---|---|
| B1 首投 | 同 payload | `200 {"code":0,"message":"ok","request_id":"req-b37d0d2fe8164268","data":{"status":"ok"}}` |
| B2 重放 | 同 payload（同 session） | `200 {"code":0,…,"data":{"status":"ok","duplicate_skipped":4}}` |

磁盘断言（直接读 buffer，不经 API）：

```text
B1 disk: messages=4 tool_call_count=1 byte_count=416 currentBytes=434 metaBytes=458
  路径 skill_buffer/iso-user/iso-team/iso-agent/iso-<run>-skill/{data-current.jsonl,meta.json}
PASS [B3-buffer-unchanged] messages 4->4  currentHash d3ac873a65b85526->d3ac873a65b85526  bytes 434->434
PASS [B4-counters-unchanged] metaHash 39ae8603c7331e9d->39ae8603c7331e9d  tool_call_count=1  byte_count=416
```

判读：重放**不追加消息、不推进阈值计数**（`tool_call_count` 仍 1 —— 阈值是「tool_call 数」，重放若被计数会提前触发归档），返回体明确告诉调用方跳过了 4 条。这是 task-26 去重逻辑在**真实装配链**（router → handler → 指纹环 → storage.putObject）上的行为，而不仅是 `dedupe.ts` 的单元行为。

## 6. C：L0 幂等（`/v3/conversation/add`）

| 步骤 | 请求 | 响应原文 |
|---|---|---|
| C1 首投 | 2 条（user/assistant，timestamp ISO Z），session `iso-<run>-l0-idem` | `200` `data:{"accepted_ids":["msg-6a6abd5c…","msg-3eb38b80…"],"accepted_versions":["v1","v1"],"total_count":2}` |
| C2 重放 | 同 payload | `200` `data:{"accepted_ids":[],"accepted_versions":[],"total_count":0}` |
| C3 查库 | `POST /v3/conversation/query`（limit 50） | `200` `total=2`，messages 2 条，roles `user,assistant` |
| C4 一致性 | 对比 C1 的 `accepted_ids` 与 C3 的 id | 完全一致（2 条） |

服务端日志（说明命中的是 F-DUP-1 去重分支，而不是「静默丢包」）：

```text
INFO [v2] [F-DUP-1] duplicate skipped (session=iso-…-l0-idem, role=user, window=10min): iso L0 idempotency probe …
INFO [v2] [F-DUP-1] duplicate skipped (session=iso-…-l0-idem, role=assistant, window=10min): iso L0 idempotency reply …
INFO [v2] [F-DUP-1] iso-…-l0-idem: 2 duplicate(s) skipped, 0 accepted (window=10min)
```

判读：**`accepted_ids` 为空 + 行数不增**（C3/C4），重放只产生日志不产生数据。窗口 10 分钟，超过窗口的同内容会再次接收（F-DUP-1 的既有语义）。

## 7. 隔离证据

隔离 baseDir 落盘清单（脚本自动打印，深度 2）：

```text
.conversations/2026-10-31.jsonl 508605B   # L0 原始对话 journal（含那批 495KB）
.instances/iso-service/vectors.db 1290240B (+ -shm/-wal)   # serviceId=iso-service 专属 store
.metadata/manifest.json 167B
.metadata/metadata/tdai_metadata_iso-service/metadata.db 241664B
.skill_buffer/iso-user/iso-team/iso-agent/…
.vectors.db 4096B (+ -wal 1347272B)
```

- **每个 serviceId 一个 store**：`[store-pool] Created sqlite store for iso-service: sqlite @ …\instances\iso-service\vectors.db (pool size: 2)` —— 也说明装配链里 `x-tdai-service-id` → store 选择是活的（缺该头会 401 `Missing x-tdai-service-id header`，首跑 6 条 FAIL 全是这个，属预期契约）。
- **不写 `D:/TDB/data` 的证据**：①生效 `baseDir` 两处独立打印（C0 + store-pool 日志）都指向 `scratch/core-iso/data`；②本实例所有 `[storage][local]` 日志前缀都是 `skill_buffer/iso-user/…`、`conversations/…`，相对隔离 baseDir；③**不以 mtime 为证**：8420 与本实例并发，且 8420 的 baseDir 就是 `D:/TDB/data`，mtime 变化无法归因。故改用「路径断言 + 日志前缀 + 隔离实例自身落盘清单」三重证据。
- 8420 存活：验证前 `GET /health` 200（uptime 6061）、验证后 200（uptime 6065）；本实例 `stop()` 后 8499 不可达（`PASS [S-stopped]`，stop 约 5s，skill worker pool 退出耗时）。

## 8. 局限（这张票没证明什么）

1. **只证明「不依赖 LLM 的链路」**。LLM 指向 discard 端口、embedding 关闭，所以 L1/L2 抽取与向量召回没有活体覆盖（也不在本票范围）。
2. **skill 归档路径未活体触发**（`archiveBytes: 40960`，本次只投 ~0.5KB）；只验证了「不归档分支」的 buffer 不涨与计数不推进。归档分支由 task-26/33 的单测覆盖（`force-archive-meta.test.ts` 等）。
3. **`/v3` 的 413 缺 `limitBytes`/`hint`**（§4 第 2 点），对手工排障体验有影响，对「该不该重试」无影响。
4. **`warmup` 在 `/health` 里是 `warming`**：fresh 库 + `enableWarmup:false`，健康字段不等于「已暖」；不要拿这个实例的 `warmup` 判生产状态。
5. 隔离实例缺 `integrations/` 模块，启动 WARN `integrations/ not available … falling back to inline LocalConfigSource + NoopQuotaReporter`；observability WARN `privateModule.createInternalObservabilityBackend is not a function. Using noop.`。两者只影响配额/观测，不影响被验三条链。
6. fresh 库启动有两条非致命 WARN：`countL1WithVectors failed (non-fatal): no such table: l1_vec_rowids`、`ensureChatMemoryAsset failed (… agent iso-agent not found)`（隔离租户下没有 chat_memory asset）。
7. `node:sqlite` 仍报 `ExperimentalWarning`（与生产同）。

## 9. 复跑与清理

```bash
cd /d/TDB/td-agemem/MemoryCore
node --import tsx scripts/verify-core-live.ts 8499     # 全 PASS exit 0；输出写 scratch/core-iso/{run.log,verify-result.json}
```

- 端口被占时换一个（`8498`/`8500`），脚本会先探测；**不要**指向 8420。
- 每次跑都新建 `iso-<run>-*` 会话，不会与上次冲突；`scratch/core-iso/data` 可在两次跑之间整目录删掉（脚本会自动重建 schema），基线干净时更好读日志。
- 生产切换验证：本脚本只读 8420 的 `/health`，不会发写请求。
- **本次跑完已删除** `scratch/core-iso/data`（3.3 MB，脚本可重建）；`config.yaml`、`run.log`（64 KB 原始日志）、`verify-result.json`（25 项检查明细）保留在 `scratch/core-iso/`，本文所有原文均引自这两份产物。

## 10. 对照结论

| 链路 | 修前 | 修后（活体） | 证据 |
|---|---|---|---|
| 1 MiB 字节墙 | ECONNRESET / `fetch failed`（客户端只能猜网络抖动） | `413` + `{"code":413,…,"retryable":false}`，7 ms 返回，连接随后关闭，进程健康 | §4 |
| skill 入口幂等 | 同 payload 重投即翻倍（task-26 记录的 362→724） | `duplicate_skipped` + buffer 字节/hash 不变 + `tool_call_count` 不推进 | §5 |
| L0 幂等 | 同 payload 重投落新行 | `accepted_ids: []`、`total_count: 0`、行列数不增、id 与首投一致 | §6 |
| #123 noop embedder | `isReady` 恒 true ⇒ 探针报绿 | `stores.embeddingService=false`、`memory.embedding=degraded`、WARN 一次 | §3 |
