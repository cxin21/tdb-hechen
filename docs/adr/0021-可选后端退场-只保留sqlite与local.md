# ADR-0021 可选后端退场：只保留 sqlite 存储 + local 状态 + noop/console 观测

- **状态**：已接受（2026-11-01，来源：用户令「除了 rerank 云端凭据外其他都做，按生产级标准落地并测试」；本轮实施票 = Wave 3，取证见本 ADR §背景与本仓 `MemoryCore/src/**` 的 fail-loud 守卫）
- **关联**：ADR-0020（MemoryProxy 退场——本条延续「不在 core 内部再造补偿层」）、ADR-0018（上游同步边界）、ADR-0019（召回耗时与人格预算）；实现面 `MemoryCore/src/core/store/factory.ts`、`MemoryCore/src/core/store/store-pool.ts`、`MemoryCore/src/core/state/index.ts`、`MemoryCore/src/core/report/factory.ts`、`MemoryCore/src/metadata/store/factory.ts`、`MemoryCore/src/config.ts`、`MemoryCore/src/gateway/{config,server}.ts`、`MemoryCore/package.json`
- **域词典**：[CONTEXT.md](../../CONTEXT.md) → 存储后端 / 状态后端 / 元数据后端 / 可观测性后端

## 背景（2026-11-01 取证）

core 的四个「可选后端」在 DSH-only 构建里都已经没有真实场景，而且其中两个**在本仓根本跑不起来**：

| 后端族 | 代码量（删前） | 生产配置 | 实际状态 |
|---|---|---|---|
| TCVDB 内存库（`core/store/{tcvdb,tcvdb-client,tcvdb-skill-store}.ts`） | 3,753 行 | `storeBackend: "sqlite"` | 只有 `deployMode=service` 会用；service 模式本身依赖不存在的私有子模块 |
| MongoDB 元数据库（`metadata/store/mongodb-adapter.ts`） | 1,397 行 | 未配置（sqlite） | service 模式专用，同上 |
| Redis 状态后端（`core/state/index.ts` 的 redis 分支） | 分支 + `ioredis` | `state_backend` 未设置（local） | `await import("../../integrations/redis/index.js")` —— **该目录在本仓从未存在**，走到即抛「Redis integration is not available」 |
| OTLP / ClickHouse / Kafka / Langfuse（`core/report/{otlp-backend,otel-sdk-init,otel-context,trace-propagation,clickhouse-exporter,kafka-metric-producer,langfuse-span-processor}.ts`） | 2,368 行 | 四个块 `enabled: false` | `internal` 后端依赖的 `src/integrations/observability/` 只有一个 11 行 stub（`createInternalObservabilityBackend` 未导出 ⇒ 走到即崩） |

两条独立证据说明这不是「暂时关掉」而是「结构性不可用」：

1. `src/integrations/` 目录里**只有** `observability/index.ts` 一个 stub，`factory.js`、`redis/`、`cos/` 全都不存在；`gateway/server.ts` 中 `await import("../integrations/factory.js")` 在 `deployMode=service` 时必然抛错，standalone 永远回落到 `LocalConfigSource` + `NoopQuotaReporter`。
2. 生产 `MemoryCore/tdai-gateway.yaml`（gitignored）的四个观测后端全部 `enabled: false`、`storeBackend: "sqlite"`、`deployMode: standalone` —— 即真实运行的那套从来没走过这些代码。

维护这些后端的成本却是实打实的：它们是 `@opentelemetry/*` 9 个包、`mongodb`、`ioredis`、`kafkajs`、`@clickhouse/client`、`crc-32` 的唯一理由，也是 `gateway/server.ts` 里三百多行 mode 三元与 redis 队列分支的唯一理由。

## 决定

1. **整组退场，不做迁移**。删除上述 11 个实现文件 + `src/integrations/observability/index.ts`（该目录随后清空）。唯一保留的第三方记忆相关依赖是 `@tencentdb-agent-memory/tcvdb-text` —— 它是**本地 BM25 稀疏编码器**（`src/core/store/bm25-local.ts:12-13`），与 TCVDB 服务端无关，名字里的 "tcvdb" 是包名巧合。
2. **fail-loud，不静默降级**。四个工厂各有一个明确的错误类型与早于任何 IO 的断言：
   - `RetiredStoreBackendError`（`src/core/store/factory.ts`）：`storeBackend` 非 `"sqlite"` 即抛；`StorePool` 构造期同样校验，`getSkillStore()` 恒抛（skill 侧 TCVDB 实现已随包删除）。
   - `RetiredStateBackendError`（`src/core/state/index.ts`）：`state_backend` 非 `"local"` 即抛。
   - `RetiredMetadataBackendError`（`src/metadata/store/factory.ts`）：`TDAI_METADATA_MONGO_URI` 非空、或 backend 非 `"sqlite"` 即抛；`deployMode=service` 直接抛 `MetadataStartupValidationError`。
   - `RetiredObservabilityBackendError`（`src/core/report/factory.ts`）：`observability.type` ∉ {`noop`,`console`} 即抛。
   每条错误消息都写明：该后端已在 DSH-only 构建中退场、生产应写什么值、以及本 ADR 的路径。
3. **配置面同步收窄，但保留「读到旧值就报错」的能力**：`src/config.ts` 的 `StoreBackend` 收窄为 `"sqlite"`（解析处对非 sqlite 抛 `[config] storeBackend "X" has been retired…`）；`src/gateway/config.ts` 删除 `RedisConfig`/`KafkaConfig`/`OTelConfig`/`ClickHouseConfig`/`LangfuseConfig`/`BaradConfig`/`ZhiYanConfig` 与 `parseBrokers()`，`ObservabilityConfig` 收窄为 `{ type: "noop" | "console" }`，并对 `deployMode`、`STATE_BACKEND`、`metadata.store.mongoUri` 做启动期校验。
4. **旧 yaml 的「已关闭块」不算错误**：`observability.{otel,clickhouse,kafka,langfuse}` 若仍存在但 `enabled !== true`，只汇总一条 `console.warn("[gateway-config] ignoring retired observability blocks (all disabled): …")`；只有 `enabled === true` 才抛。理由：现网 yaml 里这四个块就是 `enabled: false`，让「历史残留配置」直接把服务打死没有收益，而「明确想启用」必须失败。
5. **观测门面保形、实现归一**：`kafka-metric-producer.ts` 的 `metricProducer`（send/initialize/destroy）是通用 metric 门面而非 Kafka 实现，11 个消费者（含 `metric-tracking-*`）只需要它 —— 因此保存为 `src/core/report/metric-producer.ts`（删 `calculatePartition`/`crc-32`/`KafkaMetricConfig`）；`trace-propagation.ts` 收敛为 `trace-context.ts` 的单个 `serializeTraceContext()`（`deserializeTraceContext` 无外部消费者，删除）。OTel 的 `Span` 类型重导出、`runInRootContext()`、v2-router 的两处 `import("@opentelemetry/api")` 埋点全部删除。
6. **依赖清理**：`package.json` 删 11 个 `@opentelemetry/*`、`@clickhouse/client`、`ioredis`、`kafkajs`、`mongodb`、`crc-32`、孤儿 `@tencentdb-agent-memory/memory-sdk-ts-v2`、devDep `mongodb-memory-server`（合计 19 条，删前逐个 grep 确认零非注释消费者）。

## 后果

- **升级即报错**：老的 `storeBackend: tcvdb` / `state_backend: redis` / `TDAI_METADATA_MONGO_URI=…` / `observability.type: otlp|internal` 部署，升级后**启动即失败**并给出迁移提示，不会静默降级。这是本 ADR 的核心取舍：静默降级到 sqlite 的后果是「服务健康、数据是空的」，比崩溃更难发现。
- **数据不自动迁移**：TCVDB 里的向量、Mongo 里的元数据表都留在原地。迁移路径写在各自错误消息里（sqlite 库路径 = `{dataDir}/vectors.db`；元数据库 = `{baseDir}/tdai_metadata_{id}/metadata.db`）。
- **service 模式不可用**：`deployMode=service` 在 `gateway/config.ts` 与 `metadata/store/factory.ts` 两处都会抛错。它的编排代码（per-instance resolvers、COS 存储分支、`ensureConversationAddForInstance`）按"欠删除"记账保留在 `gateway/server.ts`，待后续票处理。
- **可观测性只剩两档**：`noop`（默认，零开销）与 `console`（stdout，开发调试）。需要真链路追踪时的落点是 DSH 侧或外部系统，不是把 OTel 装回 core。
- **skill 侧 TCVDB 能力位失效**：`storePool.getSkillStore()` 恒抛，`skill/types.ts` 的 `storeBackend` 收窄为 `"sqlite"`，`hasTcvdbCredentials` 恒 `false`（字段保留以免大面积改签名）。

## 诚实边界

- **未跑真实升级演练**：fail-loud 的验证是单元测试（`src/core/store/__tests__/retired-backends.test.ts`，10 例），没有拿一份真实的老 yaml 走一遍 `loadGatewayConfig()` 的端到端启动失败路径 —— 测试里只覆盖了 `TDAI_METADATA_MONGO_URI`、`assertXxx` 与工厂构造，`gateway/config.ts` 的 `deployMode=service` / `STATE_BACKEND=redis` 抛错**没有直接测试**（由 typecheck 收窄 + 代码审阅保证）。
- **`scripts/` 下的残留不在本票写作用域**：`scripts/bench-checkpoint-lock.ts:42` 仍 `await import("ioredis")`（只有设了 `REDIS_HOST` 才走，属压测工具的 Redis 锁分支）、`scripts/verify-tcvdb-*`、`scripts/migrate-sqlite-to-tcvdb/**`、`bin/migrate-sqlite-to-tcvdb.mjs` 等仍引用已删的 `tcvdb-client`。这些文件不在 `tsconfig.typecheck.json` 范围内（`include: ["src/**/*"]`），因此门禁不会发现；需要一张后续票清理或明确标注为"仅历史数据迁移用、需手动补回依赖"。
- **`config/templates/**` 属 config-sync 域，本票未改**：本轮删除的配置键会让模板漂移（模板里仍有 `tcvdb.*`、`redis.*`、`otel.*`、`clickhouse.*`、`kafka.*`、`langfuse.*`、`metadata.store.mongoUri`），由 config-sync 另一张票重锚。
- **门禁环境已漂移**：本机 `MemoryCore/node_modules/typescript` 现指向 6.0.3，TS 6 不再自动引入 `@types/node`，于是 `npx tsc -p tsconfig.typecheck.json` 报 961 errors（其中 670 条 `TS2591 Cannot find name 'node:*'`），与 `typecheck-baseline.json`（在 TS 5.9.3 下生成、无 TS2591）不可比。本票的可比读数是 **TS 5.9.3 = 203 errors / 30 files**（基线 240/44，Δ = -37 / -14），并且按「文件×错误码」组比对**零新增组**。
