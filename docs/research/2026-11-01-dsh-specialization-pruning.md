# DSH 特化：全仓可删 / 需改逐文件分析（2026-11-01）

> 前提：目标形态是「**只支持 DSH 接入、只通过 dsh-plugin 连 core、不需要 MemoryProxy**」。
> 方法：五名只读调查员分域扫全仓真实源码（未跑构建/未跑测试/零写盘），lead 交叉核验互相矛盾处并亲自复核关键锚点。
> 取代关系：本文**取代** `docs/ops/dsh-specialization-{proxy,memorycore,panel-knowledge,dsh-plugin}.md` 与 `docs/specs/2026-10-31-dsh-specialization-audit/core.md` 中过期的行号与结论（见 §7）。

## 0. 判定口径

| 判定 | 含义 |
|---|---|
| A 可删 | 零非测试引用（basename + 相对 import + 目录 specifier 三重核对） |
| B 可删 | 只服务将退场的宿主/协议面（OpenClaw、`/v2/offload`），DSH 与 Panel 零消费者 |
| M 需改 | 逻辑有活消费者，但契约/入口随特化变化，必须改而非删 |
| X 分歧 | 可选后端 / 扩展点 / 未接线，删需拍板 |
| K 保留 | 生产活路径 |

## 1. 结论摘要

| 域 | 源码规模 | 确定可删 | 需改 | 待拍板 | 保留 |
|---|---|---|---|---|---|
| MemoryProxy（含 sdk、agents） | 272 文件 / 62,926 行 | **243 文件 / 58,490 行** | —（改=迁移 29 文件 / 4,436 行） | sdk 19 ts / 3,963；agents 27 / 8,550 | agents 2 / 2,602 |
| MemoryCore 对外接口面 | 106 ts/js / 32,802 行 | **22 文件 / 4,897 行** | 10 文件 / 10,857 行（含 3 测试） | — | 80 文件 / 19,244 行 |
| MemoryCore 内部实现 | 321 文件 / 103,729 行 | **82 文件 / 20,002 行** | 31 文件 / 18,069 行 | 13 文件 / 8,819 行 | 200 文件 / 57,233 行 |
| MemoryPanel + MemoryKnowledge | 387 文件 / 82,027 行 | **25 文件 / 4,874 行** | 113 文件 / 26,871 行 | — | 249 文件 / 50,282 行 |
| dsh-plugin | src 41 ts / 12,345 行 | 0（无死文件） | 收敛后整文件消失 12 / 1,885 行 + 内缩 ≈1,000 行 | — | 其余 |

- **确定可删 ≈ 88,263 行**；含待拍板项（sdk 3,963 + agents 2,602 + X 8,819 + dsh 收敛 1,885）≈ **105,532 行**。全仓源码 ≈39 万行 ⇒ 确定可删 ~23%，含待拍板 ~27%。
- **必须迁移 ≈ 4,436 行 / 5 个单元**（见 §4），不是"删了就算完"。
- 另有未计入清单的孤儿目录：删 `MemoryCore/index.ts` 后 `MemoryCore/openclaw-plugin/`（17 文件 / 989 行非测试）与 `MemoryCore/pi-plugin/`（5 文件）失去唯一父入口。

## 2. MemoryProxy（退场主体）

**整包可删 243 文件 / 58,490 行**（272 文件中，除下表 29 个迁移文件与 agents 保留项外全部）。

**需迁移的 5 个单元（proxy 独有、core/panel/plugin 无对等实现）**

| 单元 | 文件 | 行数 | 去向与判断 |
|---|---|---|---|
| M1 计费链 | `credit-reporter.ts`、`pricing.ts`、`routes/credit-pricing.ts` | 691 | ⚠ 语义陷阱：计费只在「proxy 转发 LLM 且 URL 带 spaceId」时成立。DSH 直连 core + 直连自有 LLM 后，这套只剩空壳 → **建议放弃，不迁移** |
| M2 DSAT/升级判定 | `judge-client.ts`、`guard-adapter.ts:25` | 189+ | 若保留 DSAT 行为判定则迁 core hooks |
| M3 限流 | `rate-limit/{guard,redis-store,usage}.ts` | 496 | core 全仓无对等实现；DSH 单用户场景可放弃 |
| M4 `mem:` 命令 | `mem-command/`、`routes/session-task.ts` | 2,285 | 插件侧无 `mem:` 命令 → 放弃或重做成插件工具 |
| M5 成员 LLM Provider | `member-llm/`、`routes/llm-providers.ts` | 895 | Panel `LlmProviderPage` 的后端；若整删该页则一并放弃 |

**删包的真实阻碍不在代码**：
- Panel 4 处透传（见 §5 R3）、CI 两个 job（`.github/workflows/ci.yml:102-119`、`probes-nightly.yml:31-45`）
- 配置机校验四份模板（`config/SPEC.md:11`、`config/templates/memoryproxy.yaml`、`config/templates/memoryproxy.keys.json`、`scripts/check-config-templates.mjs:27`）
- 部署 29 文件（`deploy/dockerhub/publish.sh:162`、`deploy/tencent-cloud/docker-compose.yml:31`）
- ⚠ `docs/adr/0018-上游同步边界.md:37-39` 明文「不接受删掉这五个 handler」⇒ **删 handler 必须同批改 ADR-0018**，否则违反既有决策记录

**sdk/ 与 agents/（待拍板）**：`sdk/` 43 文件 ≈10,800 行（其中 19 个 ts / 3,963 行）；`agents/` 27 文件 ≈8,550 行（其中 ts 2,602 行）。两位调查员对 `agents/` 判断冲突：一方认为 `agents/asset-import.ts` 写 Panel、与 proxy 零耦合应保留；另一方认为它服务 8 个非 DSH IDE 的接入文档与历史会话导入，应整删。**关键分叉**：`agents/asset-import.ts:1933-1948 make_dshAdapter` 的「历史会话一次性导入」能力是否还要。

## 3. MemoryCore

### 3.1 对外接口面（可删 22 / 4,897 行）

| 可删 | 行数 | 依据 |
|---|---|---|
| `index.ts`（OpenClaw 插件入口） | 1,034 | 自述 "plugin for OpenClaw"，0 TS importer（仅 `package.json:69,170` 的 `openclaw.extensions`） |
| `src/adapters/openclaw/{host-adapter,index,llm-runner}.ts` + `adapters/index.ts` + `standalone/index.ts` | 255 | barrel 与 OpenClaw 适配，仅内部互引 |
| `src/cli/{index.ts,commands/seed.ts}` + `src/cli/README.md` | 341 + 174 | 自述「Registers the memory-tdai namespace under the OpenClaw CLI」 |
| `hermes-plugin/`（5 文件） | 2,022 | Python 侧 hermes 接入，任务明确排除 |
| `gateway/chat-memory-e2e-helpers.ts` | 243 | 死文件，0 代码引用（只在 `.eval-data`/`.tmp`/`scratch` 有副本） |
| `gateway/quota-credit-policy.ts` | 36 | 自述存在理由全部为 `llm.provider="proxy"` 时避免重复计费 |
| `gateway/memory-prompt-{handlers,schemas}.ts` | 396 | panel 0、DSH 0 命中 |
| `gateway/memory-generation-log-{handlers,schemas}.ts` | 107 | 同上 |
| `gateway/soul-introspect-endpoint.ts` | 115 | 见 X-U1 |
| `__tests__/v2-router-task-source-type.test.ts` | 174 | 全篇只测废弃 `/v2/task/*` |

### 3.2 对外接口面（需改 10 / 10,857 行）

- `gateway/server.ts`（3,980）：删 `/v2/instance/destroy`(:1268)、`/v3/instance/destroy`(:1279)、`/v1/rerank`(:1288)、`/v3/soul/introspect`(:1303) 四个直分派块；`/v2/` 前缀分派(:1417) 收窄为 `/v3/`；`extraRouteTable` 装配(:1596-1610) 去掉 memory-prompt / memory-generation-log 两表。
- `gateway/v2-router.ts`（4,313）：删 `/v2` 孪生展开(:611-619)、16 条 @deprecated entity 路由(:628-643)、`/v2/pipeline/status`(:645)、GET 放行清单(:681-687)、`V3_ALLOWED_SUBPATHS`(:225-271) 内已删功能子路径；保留 `/v3/recall`(:648)、`/v3/memory/mood`(:651)。
  - **这是既定方向**：`:646-648` 注释自述「新接入方一律 v3——不进 DATAPLANE_HANDLERS 以免自动获得 /v2 孪生路由」。
- `config.ts`（1,025）：删 `llm.provider:"proxy"` 分支(:458-475、:528-542)、`embedding.provider:"qclaw"` 校验(:585-595)。
- 🔴 `gateway/llm-resolver.ts`（136）：删 proxy 分支(:48、:53-95，baseUrl 拼 `${base}/proxy/<iid>/v1`)。**不同批改此处 = core 自己所有 LLM 抽取当场全断**。
- `bin/seed-v2.mjs`：自述「通过 v2 API 灌历史对话」→ 改 v3 或退役。
- 测试：`v2-router-l0-batch-embed.test.ts`(:87)、`v2-router-recall-merge.test.ts`(:195)、`rerank-endpoint.test.ts` 随定论调整。

### 3.3 内部实现（可删 82 / 20,002 行）

- **A 纯死码 13 文件 / 2,328 行**：`hooks/anchor-shadow-stats.ts`(155)、`hooks/behavior-judge.ts`(152)、`recall/layered-metrics.ts`(452)、`record/conclusion-card.ts`(69)、`utils/l0-testdata-plan.ts`(218)、`utils/text-utils.ts`(31)、`store/bm25-client.ts`(163)、`store/search-utils.ts`(62)、`skill/queue/index.ts`(20)、`skill/skill-fast-path.ts`(44)、`core/index.ts`(73, barrel 零 importer)、`store/factory.ts`(75)、`storage/{index.ts`(51)`,factory.ts`(75)`、`report/{index.ts`(108)`,log.ts`(87)`。全部零非测试 importer，各带 1 个测试（删后基线 3,298 用例降约 20 例）。
- **B 宿主/offload 链路 64 文件 / 17,280 行**：`src/offload/` 33 + `offload-client/` 6 + `offload_server/` 21 + `utils/{ensure-hook-policy.ts`(260)`,memory-cleaner.ts`(392)`,openclaw-state-dir.ts`(35)` + `core/tools/read-cos.ts`(160)。唯一入口：`MemoryCore/index.ts:32-33/982-1000` 与 `gateway/server.ts:1519`（`/v2/offload` **无条件挂载**，不读 `offload.enabled`）；DSH 插件与 Panel 对 `/v2/offload` grep 均 0。

**内部多 agent 残留几乎只剩类型声明**：`core/types.ts:49 platform:"openclaw"|"hermes"|"cli"|"gateway"`、`:51 agentIdentity?`、`:53 agentContext?`、`:249 hostType`——`agentContext`/`agentIdentity` 全 src 消费点 **0**。但 🔴 `team_id`/`agent_id` 是**现行隔离维度，不能删**（`metadata/store/team-member-view.ts`、`core/state/timer-member.ts`、插件 `/v3/scenario/ls` 带 `{team_id,agent_id,user_id}`）。

**service 模式是死路**：`core/state/index.ts:48-70` 与 `core/report/factory.ts:31-38` 动态 import 的 `src/integrations/{redis,observability}/` 私有子模块**不存在**，`report factory` 取到的 `getObservabilityBackend()` 恒 `undefined`。

### 3.4 待拍板 X 组 13 文件 / 8,819 行

`store/tcvdb.ts`(3,571) + `tcvdb-client.ts`(311) + `tcvdb-skill-store.ts`(871)、`metadata/store/mongodb-adapter.ts`(1,397)、`report/{clickhouse-exporter,langfuse-span-processor,kafka-metric-producer,otlp-backend,otel-sdk-init,otel-context,trace-propagation}.ts`、`store/factory.ts`(144)、`core/hooks/soul-introspect.ts`(157)。生产实际是 `storeBackend: sqlite` + local + standalone。

## 4. 必须迁移的单元（合计 ≈4,436 行）

见 §2 的 M1–M5。迁移前必须决定：**放弃**（M1 计费、M4 命令，建议）。剩 M2/M3/M5 视 DSAT、限流、成员 LLM Provider 是否在 DSH 单用户形态下还有意义。

## 5. 跨域风险（连带动刀顺序）

- **R1（最高）`llm-resolver.ts` proxy 分支**：`llm.provider:"proxy"` 一旦出现，baseUrl 被拼成 `${base}/proxy/<iid>/v1` 指向已退场的 proxy。必须与 proxy 退场同批改。
- **R2 Knowledge `LLM_MODE` 缺省 `proxy`**（`MemoryKnowledge/src/config.ts:220`、`.env.example:36`、`docker/env.example:24`）：不改 custom ⇒ **wiki ingest 全断**（P0）。
- **R3 Panel 打 8096 的 4 处代码 + 1 前端 fallback**：`panel-config.ts:42/50/82/86`、`routes/llm-providers.ts:42`、`routes/settings.ts:131-137`（proxy-pricing）、`startup/ensure-knowledge-llm-binding.ts`、`GuidePage/index.tsx:303` 与 `:57-60`。
- **R4 MemoryCore/scripts 反向 import MemoryProxy**（各调查员的通用盲区，只扫 `src/` 会漏）：`scripts/backfill-l0-classification.ts:19` → `MemoryProxy/src/common/intent-classifier.js`；`scripts/verify-c2.ts:46` → `MemoryProxy/src/knowledge/current-feeling.js`。删 proxy 前必须先处置。
- **R5 `/v2` 与 `entity_*` 表同批**：`core/store/sqlite.ts:1277/1290/1303/1317` 建 `entity_teams/users/agents/tasks`、`:1352-1353` ALTER 加 `user_ids_json/agent_ids_json`；唯一消费者是 v2 deprecated CRUD。
- **R6 DSH 自身 LLM 可能仍走 proxy**：`~/.dsh/profiles/desktop/cordis.patch.yml:16-27` 的 `tdb` provider `baseURL` 是 `http://127.0.0.1:8096/dsh/default`。删 proxy 前必须确认当前会话实际用的 provider（`scm` 直连 vs `tdb` 过 proxy）。
- **R7 openapi 契约**：`MemoryCore/docs/team-api-仅memory.yaml` → `kubb.config.ts` → `src/gateway/generated/{schemas,types}.ts`。删路由须同批改 yaml 并重生成。
- **R8 typecheck 基线 240 errors / 44 files**：删减只会降低错误数，但删 `core/types.ts`/`config.ts` 字段会触发下游错误（下游本就在 240 内），删后须重跑 `npm run typecheck` 记账，别把"减少的错误"当净收益掩盖新错。

## 6. 待拍板（7 项）

1. **OpenClaw 宿主是否退场** → 决定核心内部 B 组 17,280 行（最大金额分叉）。若保留第二宿主，B 组只可删 `offload_server/` 21 文件 4,904 行。
2. **proxy 五个唯一能力**（计费/DSAT/限流/`mem:` 命令/成员 LLM Provider）迁移还是放弃。
3. **sdk/ 与 agents/ 是否整删**（存在对外发布承诺与历史会话导入能力）。
4. **Knowledge 是否保留**——lead 判断：**必须保留**（core `gateway/wiki-client.ts:92-100` 与插件 `knowledge-segment.ts` 都直连 8421）。
5. **tcvdb/mongo/redis/otel 可选后端 8,819 行**是否作为商业版扩展点保留（service 模式已实证不可运行）。
6. **Panel 多 agent 编排三块**（任务工作台 `WorkbenchPage`、`GuidePage`、`LlmProviderPage`）是否整删（含 routes/api 层 4,471 行）。
7. **`soul-reanchor`（灵魂再锚定）能力归属**：proxy 的 6 个 soul/feeling 注入器里，core 已有 `soul-dedupe`/`soul-redline-render`/`fixed-asset`/`profile-memory`；core **无**等价物的是 `reanchor`/`current-feeling`/`tool-capabilities`/`asset-reflection`（后者在插件侧有 319 行）。而 `soul-reanchor` 恰好治「长会话人格稀释」——与 2026-11-01 刚落地的 `volatile.soul.oncePerSession`（每会话只注入一次）是同一问题的两套解法，必须二选一或组合。

## 7. 与既有文档的取代关系

| 既有文档 | 本次结论 |
|---|---|
| `docs/specs/2026-10-31-dsh-specialization-audit/core.md` D4「删 x-tdai-* 身份兜底」 | 🔴 **驳回**。`v2-router.ts:503-510` 缺 `x-tdai-service-id` 直接 401；x-tdai-* 全仓 144 处引用，是 DSH 唯一接入方式的命门 |
| 同上，全部 file:line | 已随树漂移（例：DATAPLANE_HANDLERS 实际 `:565-609`，文中写 `:504-549`）⇒ 整篇行号不可采信 |
| `docs/ops/dsh-specialization-dsh-plugin.md:61-67`（`recallCombined`/`health` 为死代码） | 已过期：现被 `src/index.ts:950`/`:650` 调用；仅 `deleteConversation`（`memory-client.ts:1114`）仍死 |
| `docs/ops/dsh-specialization-{proxy,memorycore,panel-knowledge}.md` | 方向性结论（proxy 降级为 legacy 可选网关、plugin 只认 7 个 core 端点、panel 建在「多实例」上）仍成立；行数与文件级判定以本文为准 |

## 8. 诚实边界

- 五名调查员与 lead 全程**只读**：未跑构建、未跑测试、未起服务、零 git 写。所有「可删」= 静态不可达 + DSH/Panel 零客户端，**不等于运行时无人调用**。
- import 可达性只覆盖相对 import 与目录 specifier，不含包名 import；配置字符串/动态拼接路径只能靠 grep 佐证。
- 三个跨范围交叉结论由 lead 亲自复核（`llm-resolver.ts` proxy 分支、Knowledge `LLM_MODE` 缺省、`MemoryCore/scripts` 反向 import）。
- `/v1/rerank` 生产是否启用未取证（MemoryKnowledge 侧 `rerank.url` 默认空=关闭）；`/v2` 是否有仓外调用方无法从仓内证明。
- 本次分析不改变任何代码与配置，仅产出判定与顺序。
