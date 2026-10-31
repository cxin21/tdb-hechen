# fixed-asset parity：head pack 是否含 self + 借入≤2 的 agent 画像（task-77）

复核人 record-pipeline｜基线 main@17c0582｜只读取证 + 记账，未改码、零 commit
基线真源：`docs/ops/proxy-parity-matrix.md` §1 第 5 行（`TdaiProfileMemoryInjector`，判定栏「待核」）
取证时刻：2026-11-01 01:30 +08（生产库只读读数如下，引用需带此刻）

## 0. 结论（三档）

**部分 parity。** head pack 已覆盖「self 的 L3 persona + self 的 L2 场景索引」，**完全缺「借入（imported）agent」维度**与 proxy 的分组/标注/核心记忆稳定块。

| 维度 | proxy | 当前 head pack | 判定 |
|---|---|---|---|
| self 的 L3 persona | 有，截断 6000 字符 | 有（`/v3/core/read` → `data.content`） | parity |
| self 的 L2 场景索引 | 有（path + summary ≤200 字符） | 有，但形态不同（见 D4） | 部分 parity |
| 借入 ≤2 其他 agent 的 L3/L2 | 有（`items.slice(0, 2)`） | **无** | 缺（D1/D2） |
| 每 agent 分组 + `role=self|imported_from` 标注 | 有 | **无** | 缺（D1） |
| `<core_memory>` slot 稳定块（identity/strict_rule） | 有 | **无** | 缺（D3） |

**是否需要 core 票：不需要。** 借入所需的两件事 core 都已具备——绑定清单 `/v3/meta/agent-fixed-asset/list-with-detail`（v3-meta-router.ts:275 → metadata-service.ts:1563，返回 `agent` + `items[{asset_id, asset_type, name, injection_mode, …}]`），以及按 header 切 agent 的 `/v3/core/read`（v2-router.ts:3863 / :3869 `scopedProfileStorage(baseStorage, deps.requestIsolation)`）与 `/v3/scenario/ls`。缺的只有插件侧实现。

## 1. 逐项对照（字段 → 是否渲染 → 缺失影响）

| # | Proxy 渲染内容 | Proxy 锚点 | head pack 现状 | 缺失影响 |
|---|---|---|---|---|
| 1 | `<tdai_profile_memory>` 外壳 + 说明句 | tdai-profile-memory-injector.ts:99-102 | 无外壳；head pack 直接是 persona 正文 | 纯形态；模型仍能读到内容，只少一处「这是长期记忆」的语义提示 |
| 2 | `<agent name= role=self agent_id=>` 分组头 | :106-111（`tag = isSelf ? "self" : "imported_from"`） | 无 | 多 agent 时无法区分「这是谁的记忆」，跨 agent 事实会被当成用户本人 |
| 3 | 每组 `<l3_core_memory>`（截 6000） | :112-115 | 仅 self 的 persona，且无标签、无 6000 截断（靠 headPack.maxChars 硬截） | 借入 agent 的画像完全不可见 |
| 4 | 每组 `<l2_scene_index>`（`- path — summary(≤200)`） | :116-130 | 仅 self；索引来自 persona 内嵌 Scene Navigation 压缩行（`- path（热度 N，更新 日期）`），summary 全丢；另有 `## 长期记忆 · 场景索引（L2）` 裸 path 段补漏 | 索引可用，但少了 summary 这一层「要不要读它」的判断依据；且没有 per-agent 的 L2 归属 |
| 5 | persona 尾部 Scene Navigation 剥离（避免与 L2 段重复） | :300-311 / :317 | 反向操作：compressHeadPack 保留索引、丢 summary | 与 proxy 取舍不同（体量换可读性），非缺陷，但同输入下文本必然不同 |
| 6 | `<core_memory>` slots（identity / strict_rule 等） | :138-160 | **无任何 /v3/core/memory 读取**（`grep core_memory|coreMemory|core/memory` 在 dsh-plugin/src 零命中） | 稳定身份锚与严格规则在 DSH 侧完全没有对应注入面 |
| 7 | `MEMORY_TOOLS_GUIDE` 尾段 | :133-135 | 由 `guidance.ts` / `memory_recall` 承载（矩阵第 10 行已判「完成」） | 不属本票缺口，仅记形态差异 |
| 8 | 借入解析：self + 同 team + 去自身 + 来源 agent 存活校验 + 上限 2 | tdai-fixed-asset.ts:99-116（`...items.slice(0, 2)`）、:37-40 selfCtx | 无解析、无元数据调用 | 借入能力整体缺失 |

## 2. 核心侧能力与数据物证（只读）

- 端点：`/v3/meta/agent-fixed-asset/list-with-detail`（MemoryCore/src/metadata/router/v3-meta-router.ts:275）；schema 见 v3-meta-schemas.ts:302-313（`asset_types` 可过滤，proxy 正是按 `chat_memory` 取的）。
- 服务实现：`MetadataService.listAgentFixedAssetsWithDetail`（MemoryCore/src/metadata/service/metadata-service.ts:1563-1612），返回 `agent{agent_id,team_id,owner_user_id,…}` + `items[]`。
- 生产库只读读数（`D:/TDB/data/metadata/tdai_metadata_default/metadata.db`，实例命名空间 = default）：
  - `meta_agents` 4 行、`meta_assets` 291 行（chat_memory 4 / llm_wiki 3 / skill 284）、`meta_agent_fixed_assets` 290 行。
  - 每个 agent 的 **chat_memory 绑定只指向自己**：`agt-2m7buribzz`→`chat_memory-team-2k12lgb650-agt-2m7buribzz`（1 条），`agt-2k12cf4hzo`、`agt-dofal7hgfe` 同形各 1 条；**跨 agent 绑定 0 条**。
  - 同目录 `tdai_metadata_team-2k12lgb650` / `tdai_metadata_e2e-test` 三表全 0 行（非生产命名空间）。
- 结论含义：**借入链路今天在数据上是空的** ⇒ 现在补 D1/D2 不会改变任何生产注入文本；但能力对齐仍要做（用户口径「完整版不许降级」，且一旦给 agent 绑定别的 agent 的 chat_memory 就会立刻生效）。

## 3. 实现面评估（未改码，仅记账）

1. 解析：新增 `resolveFixedAssetCtxs` 等价物（self + imported ≤2）——需调用 metadata 端点，插件现有 `MemoryClient` 无 meta 路由方法（dsh-plugin/src/memory-client.ts 只有 readCore :578 / listScenarios :600）。
2. **硬阻塞（设计层）**：`headers()`（memory-client.ts:424-446）把 `x-tdai-agent-id` 等一律取自身份，且写在 `...extra` 之后 ⇒ `extraHeaders` **无法**覆盖为借入 agent 的 id。要么加 per-call identity 形参，要么为每个 ctx 建一个轻量 client（proxy 做法是后者：每 ctx `readL3ForCtx`/`listL2ForCtx`，tdai-profile-memory-injector.ts:300-311）。
3. 渲染：在 `composeHeadPack`（dsh-plugin/src/index.ts:139-172）之前插入分组段更稳妥——现有实现把 persona 与索引当两段拼接，加多 agent 需要新的 budget 分账（headPack.maxChars 8000 已接近实测 4939-8437）。
4. 合规：core 侧 `/v3/core/read` 对任意 `x-tdai-agent-id` 无归属闸（auth-binding 三开关缺省全关）⇒ 技术上可读别的 agent 画像；这与 proxy 用同一把 service token 读同一批数据等价，但**跨 agent 读取是否该收紧**属于产品裁决，建议写进 core 票讨论而不是插件偷偷做。

## 4. 剩余差异 / 未证

- `<core_memory>`（D3）来源是 `/v3/core/memory` 的 slots；本票未核该端点在 DSH 链路的鉴权与 tenant 头是否齐备（与矩阵 §4 未证实项同源）。
- 未做 HTTP 级端点实测：生产 gateway 的 apiKey 只在运行进程环境里（yaml 是 `${...}` 占位、config-override.json 无 server 段），本代理无法在不取密钥的前提下发认证请求 ⇒ 端点结论以「代码 + 生产库行数」为证，标注为未做 live 调用。
- 「同输入下两段文本一致性」未做逐字 diff：因 D1–D4 已确定不同，逐字比对本票无收益，等实现后再做一次对拍（可作为实现票的验收项）。
