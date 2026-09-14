# Memory Hub 管理员设置页设计（Wiki 设置 / Memory 设置）

> 日期：2026-09-09
> 状态：已实施（2026-09-09，全量自动化回归 214 tests PASS @ commit efc1738；依赖服务重启的手动 E2E 步骤待运维执行，runbook 见实施计划 Task 12）
> 范围：MemoryPanel（UI + 透传）、MemoryKnowledge（admin settings API + override + 重建补齐）、MemoryCore（admin settings API + override + 重建补齐）、MemoryProxy（成员 Provider 门禁豁免 + creditPricing admin 管理）

## 0. 背景与目标

LLM / embedding 配置目前只能改文件（KS `.env`、Core `tdai-gateway.yaml`）并手工重启。目标：管理员在 Memory Hub UI 的设置页新增「Wiki 设置」「Memory 设置」两个页签，可视化配置两个服务的 LLM 与 embedding。

已确认的决策：
- **生效方式**：全部「保存后提示重启」，不做热生效。
- **配置归属**：各服务自持配置——KS / Core 各暴露 admin 接口，配置持久化到各自数据目录的 override 文件；Panel 只透传。
- **管理员判定**：Panel 层用现有 `isCallerSystemAdmin`（`auth/verify` → `user.user_type === 'system_admin'`）门控；服务侧接口沿用内网信任模型（与 `/v3/internal/llm-binding` 一致，不新造鉴权）。
- **embedding 变更重建**：纳入本期（§6）。

## 1. 总体架构

```
Web 设置页（新页签，仅管理员可见）
   │  /api/v1/settings/knowledge   /api/v1/settings/memory
   ▼
MemoryPanel 后端（新增 2 个透传路由，模式照抄 routes/llm-providers.ts）
   │  门控：validatePanelMetaHeaders + isCallerSystemAdmin（非 admin → 403）
   ▼
KS  GET/PUT /v3/admin/settings          Core  GET/PUT /v3/admin/settings（各自新增）
   │ 写 override 文件                       │ 写 override 文件
   ▼                                       ▼
{KS dataDir}/config-override.json        {Core baseDir}/config-override.json
启动合并优先级：override 文件 > env / tdai-gateway.yaml
```

保存成功响应带 `needsRestart: true`，UI 弹提示「已保存，重启 MemoryKnowledge / MemoryCore 后生效」。

## 2. 配置字段

### 2.1 Wiki 设置（MemoryKnowledge）

| 段 | 字段 |
|---|---|
| llm | baseUrl、apiKey、model、maxTokens、timeoutMs |
| embedding | provider（openai_compatible）、baseUrl、apiKey、model、dimensions |

### 2.2 Memory 设置（MemoryCore）

| 段 | 字段 |
|---|---|
| llm | baseUrl、apiKey、model、maxTokens、timeoutMs |
| embedding（对应 `memory.embedding`） | provider、baseUrl、apiKey、model、dimensions、sendDimensions |

## 3. 服务侧改动

### 3.1 MemoryKnowledge

- 新增 `src/routes/admin-settings.ts`，挂载 `POST /v3/admin/settings/get` 与 `POST /v3/admin/settings/set`（KS 路由惯例为 POST envelope；若既有路由存在 GET/REST 惯例则对齐现有惯例）。
- GET：返回当前生效配置 + 每字段来源标注（`env` | `override`）；apiKey 掩码回显（仅尾 4 位，`has_api_key` 布尔）。
- PUT：字段校验（§4）后写入 `{dataDir}/config-override.json`；`apiKey` 传空 = 保留原值（对齐 llm-binding 语义）；返回 `needsRestart: true`。
- `src/config.ts`：env 解析后合并 override 文件（override 优先），合并处有注释说明优先级。

### 3.2 MemoryCore

- gateway 新增同款 settings 路由（server.ts 挂载），读写 `{baseDir}/config-override.json`。
- `src/gateway/config.ts`：fileConfig/env 解析后合并 override（override 优先）。注意 `TDAI_LLM_*` 环境变量优先级低于 override（override 是管理员显式意图）。
- GET 掩码 / PUT 保留原值语义与 KS 一致。

### 3.3 校验（两个服务一致）

- baseUrl：合法 http(s) URL。
- model：非空字符串。
- maxTokens / timeoutMs：正整数。
- dimensions：正整数（KS/Core 均要求与所选 embedding 模型匹配，服务侧不做模型知识校验，仅格式校验）。
- 非法 → 400 + 具体字段错误信息。

## 4. Panel 侧改动

- 后端新增 `src/panel/http/routes/settings.ts`：
  - `POST /api/v1/settings/knowledge` → 透传 KS `/v3/admin/settings/*`（注入 KS base URL 来自现有 knowledge 配置）。
  - `POST /api/v1/settings/memory` → 透传 Core `/v3/admin/settings/*`（gateway endpoint 来自实例注册表）。
  - 门控：`validatePanelMetaHeaders` + `isCallerSystemAdmin`，非 admin 403；上游错误映射 Control envelope（复用 `runKs` 风格）。
- Web 端（React + tea-component，风格对齐 `LlmProviderPage`）：
  - 新设置页两个页签：Wiki 设置 / Memory 设置。
  - 页签入口可见性：调一个轻量接口（Panel 返回当前登录者是否 system_admin，如 `GET /api/v1/settings/access`）；非 admin 不渲染入口。
  - 表单保存成功 → toast「已保存，重启 XX 服务后生效」；`embeddingChanged: true` 时追加 §6.3 的重建提示。
  - apiKey 输入框留空表示保留原值；placeholder 显示「已配置（尾 4 位：xxxx）」。

## 5. 测试

- KS / Core：override 合并单测（优先级、缺省回退、掩码）、PUT 校验单测、apiKey 保留原值单测。
- Panel：门控单测（非 admin 403、透传字段注入、上游错误映射）。
- 手动 E2E：UI 保存 → 重启对应服务 → 服务日志确认新配置生效 → 设置页回读一致。

## 6. embedding 变更后的向量重建

### 6.1 现状盘点

**MemoryCore**：
- `VectorStore.init(providerInfo)` 已记录 provider/model/dimensions 指纹；变更时自动 DROP 向量表并返回 `needsReindex: true`（含"模型变、维度不变"场景）。
- `reindexAll()` 全量重 embed 引擎已实现（getAllL1Texts / getAllL0Texts → 重新 embed → 回填）。
- **断点：`reindexAll()` 无任何调用方**——检测到需要重建但无人调度。

**MemoryKnowledge**：
- `initIndexDb` 维度不匹配 → DROP `wiki_vec` 重建；`writeVectors` 有 content_sha 增量对账 + 孤儿清理。
- **缺口 1：只比维度不比模型**——同维度换模型 → 新旧模型向量混存（静默错误）。
- **缺口 2：内容指纹未变时 rebuild 整体跳过**——维度变更 DROP 后向量表为空却不再回填 → 向量召回静默归零、降级纯 FTS 无提示。

### 6.2 补齐设计

**Core 侧**：
1. 启动链路（`pipeline-factory` 的 `_doInitStores` 消费方）拿到 `needsReindex=true` 后，调度后台 `reindexAll()`：不阻塞启动、分批 embed、复用现有容错与日志。
2. 新增运行时状态 `reindexState { status: idle|running|done|failed, reason, startedAt, finishedAt }`，在 admin settings GET 响应透出。

**KS 侧**：
1. 每个 wiki 引擎记录 embedding 指纹（provider+model+dimensions，存 index.db meta 表或引擎 state），引擎加载时与当前配置比对——补"只比维度"缺口。
2. 指纹不一致 → 强制重建：DROP `wiki_vec` 后触发**绕过 content_sha 短路**的全量 re-vectorize（为现有 `writeVectors` 通道增加 force 参数，分批、单页失败跳过、孤儿清理全部复用）——补"指纹跳过"缺口。
3. 触发时机：启动时自动（主路径，与"保存后重启"语义衔接）+ 设置页手动「重建向量索引」按钮（兜底）。
4. 各 wiki 的 vector 状态（stale / rebuilding / ready + 进度）在 admin settings GET 透出。

### 6.3 与设置页衔接 + 防静默

- PUT 检测到 embedding model/dimensions 变更 → 响应带 `embeddingChanged: true` → UI 提示：「重启后自动重建向量索引；重建期间向量召回不可用（降级 FTS），完成后自动恢复」。
- settings GET 增加 `rebuildStatus` 段（Core `reindexState` / KS 各 wiki vector 状态汇总），UI 展示进度与失败红点。
- 现状 `writeVectors` 失败静默降级纯 FTS——本期改为：失败必须 `log.warn` + 状态置 `failed` 可见。

## 7. 明确不做（本期 non-goals，§1~§7 设置页范围）

- 热生效、服务自动重启。
- embedding 索引重建的自动化之外的索引迁移工具（向量迁移 = 全量重 embed，不做旧→新向量转换）。
- 多实例差异配置（本期按 `default` 单实例）。
- 服务侧第二套鉴权体系（沿用内网信任，管理员判定在 Panel 层）。

## 8. 成员自配 Provider 的入口门禁豁免（方案 B，2026-09-09 追加）

### 8.1 现状（实证）

成员自配 LLM Provider（`/v3/admin/llm-providers`，user/agent 级）命中后，转发 url/apiKey/model **完全绕开** proxy 的 `upstream.*` 与价目表（handler.ts:1353-1385：`applyMemberModel` 直接替换 model，`defaultUpstreamUrl = memberUpstream?.url ?? …`）。但入口模型门禁（handler.ts:594-614、anthropicHandler.ts:600-620）跑在成员解析**之前**——即使配了自己的 Provider，进门时 `body.model` 仍必须是价目表登记的 `modelName`，否则 400。workbuddy/codex 路径本无门禁（只有别名改写）。

### 8.2 设计

- **门禁整体从入口迁到转发缝**：迁移到 `resolveMemberOverride` / `applyMemberModel`（handler.ts:1353-1357、anthropicHandler.ts:~1228）之后、`resolveForwardTarget` 之前。
- 豁免条件：`memberUpstream` 命中 → 跳过门禁（成员自有上游不走自营计费链路，其流量本就 CreditDelta=0，豁免不产生漏计费）；未命中 → 执行原门禁，行为逐字不变。
- 别名改写 `resolveModelId`（入口处）保持不动：命中成员时 `applyMemberModel` 会覆盖 `body.model`，别名改写无副作用。
- 门禁逻辑提取为可测纯函数 `enforceModelGate(config.creditPricing, memberUpstream, requestedModel): string | null`（放 `pricing.ts`）：返回 null=放行，返回 string=400 错误消息。两个 handler 调用它，消息文本保持原文。
- **不变式**：无成员配置的流量（DSH 等直连 proxy 的自营计费链路）门禁完整保留；请求 model 在入口先记录原始值 `requestedModel`（别名改写前），门禁检查用原始值。

### 8.3 non-goals

- 不给 workbuddy/codex 路径新增门禁（维持现状）。
- 不改成员 Provider 的存储/缓存/路由语义。

## 9. creditPricing 运行时管理（admin 路由 + UI 页签，2026-09-09 追加）

### 9.1 现状

`creditPricing` 只在启动时从 config.yaml 读取一次（config.ts:373），无运行时通道；改价目表 = 改文件 + 重启。三处消费：入口门禁（§8 迁移后仍在转发缝）、别名改写（`resolveModelId`）、Credit 计费计算（credit-reporter / logger / auxiliary / systemUserPassthrough）。

### 9.2 设计（复刻 `/v3/admin/rate-limits` 既有模式，routes/rate-limits.ts）

- 新路由：`GET / PUT / DELETE /v3/admin/credit-pricing`（server.ts 与 rate-limits 同处挂载）。
- **语义**：yaml `creditPricing.models` 为底；storage override 为**整表替换**（UI 管理全量表）。effective = storage override ?? yaml。
- **持久化**：ProxyStorage 单键存 `CreditPricingEntry[]`（key 风格对齐 `LlmProviderRepo` 的 keyOf 约定）；重启后启动链路（index.ts，`initProxyStorage` 之后、serve 之前）应用 override。
- **热生效**：PUT/DELETE 直接对共享 `config.creditPricing` 对象赋值——handlers 每请求读该对象，下一请求立即生效（与 rate-limits "修改后立即生效" 同一机制）。
- **校验**（PUT 整表）：`models` 为数组；每条 `name`/`modelName` 非空且 `modelName` 全表唯一；五个价格字段（input/output/cacheRead/cacheWrite5m/cacheWrite1h）为 ≥0 数值；非法 400。
- **鉴权**：与 rate-limits 一致的内网信任模型（不新增第二套鉴权）。

### 9.3 Panel 与 UI

- Panel 后端：`POST /api/v1/settings/proxy-pricing/:action`（action ∈ get|set）透传到 `${deps.config.llmProvider.proxyBaseUrl}/v3/admin/credit-pricing`，门控复用 `isCallerSystemAdmin`（与 §4 的 settings 透传同款）。
- UI：设置页新增第三页签「Proxy 计费」：价目表可编辑列表（增/删/改行 + 保存全表），保存成功 toast「已保存，下一请求生效」（本页签**无需重启**）。

### 9.4 non-goals

- 不迁移 costGuard 内部定价（本部署 costGuard.enabled=false）。
- 不做价目表版本历史/审计。
