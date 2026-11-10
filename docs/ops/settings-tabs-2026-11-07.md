# 设置页「配置面四档」页签（2026-11-07）

## 1. 做了什么

MemoryPanel 管理员的设置页由 3 个页签扩为 6 个，按「谁能改、改错什么后果」分档：

| 页签 | 组件 | 能否写 | 内容 |
| --- | --- | --- | --- |
| Wiki 设置 | `ServiceSettingsPanel target="knowledge"` | 可写 | MemoryKnowledge 的 LLM/Embedding（原有） |
| A 部署与凭据 | `ServiceSettingsPanel target="memory"` | 可写 | LLM/Embedding 的 baseUrl、apiKey、model、maxTokens/timeoutMs、dimensions（原有字段，移出「重要度」） |
| B 应急开关 | `EmergencySwitchesPanel` | 可写 | 8 个回滚总闸，每项写清「关掉之后会发生什么」 |
| C 校准阈值 | `CalibrationPanel` | 可写 | importancePenalty / worthiness / layerRuler / injection |
| D 常量清单 | `ConstantsPanel` | 只读 | 440 条服务配置键，可搜索/按档过滤，带类型、缺省、意义、解析点 |
| Rerank | `RerankSettingsPanel` | 可写 | rerank 段（原有） |

文件：

- 页面与页签：`MemoryPanel/web/src/pages/SettingsPage/index.tsx`
- B/C/D 组件：`MemoryPanel/web/src/pages/SettingsPage/ConfigPanels.tsx`
- D 的数据：`MemoryPanel/web/src/pages/SettingsPage/configCatalog.ts`（自动生成）
- 类型：`MemoryPanel/web/src/lib/api/settings.ts`（`SettingsView` 新增 extraction/layerRuler/injection/coreMemory/lifecycle/capture/evolution/sceneGovernance/links/bm25/search）

B 档 7 个开关（写进 Core override，重启后生效）：

> 2026-11-07 移出：`memory.coreMemory.soulMaintenance.enabled` 已随人格卡 v3 删除（人格恒开，注入由 DSH 插件两段完成，见 ADR-0028）；下面 7 项为当前 B 档。

2. `memory.extraction.enabled` — L1 抽取（关 = 不再把会话抽成结构化记忆）
3. `memory.lifecycle.consolidation.enabled` — L1→L2 固化/合并
4. `memory.evolution.enabled` — 自我演化（唯一允许改写已固化正文的路径）
5. `memory.sceneGovernance.enabled` — 场景块治理
6. `memory.embedding.enabled` — 向量通道（关 = 召回降级纯 FTS/BM25）
7. `memory.bm25.enabled` — BM25 关键词通道
8. `memory.links.enabled` — 记忆关联边

C 档字段：`importancePenalty.enabled/penalty`、`worthiness.extractionEnabled`、
`layerRuler.mode/keepRatio/minPerLayer/lengthLambda/budgetMs`、
`injection.foldIdentical/maxChars/maxLineChars`（maxChars / maxLineChars 支持 unlimited = null）。

## 2. 后端为什么要一起改

新页签要「真读真写」，但 Core 的 override 链路原先有两处硬缺口：

1. `MemoryCore/src/gateway/admin-settings.ts` 的 `deepMerge` 只合并
   llm/embedding/rerank/importancePenalty/worthiness 五段。validateOverride 虽接受
   extraction/layerRuler/injection/recall/persona/lifecycle，提交后却被静默丢弃（落盘为空）。
   已改为通用深合并（`copyDefined` + `deepMergePlain`：数组/标量整体替换、普通对象递归），
   并删除只服务旧五段的 `mergeFlatOverride` / `mergeRerankOverride`。
2. `validateOverride` 不接受 `extraction.enabled` 与 `embedding.enabled`（只接受各自的
   scenePoisonSplit / dimensions 等子字段），B 档这两个总闸会被静默丢掉。已在
   `MemoryCore/src/gateway/settings-override.ts` 补 boolean 校验与类型字段。

同时把 7 个整组（coreMemory/capture/evolution/sceneGovernance/links/bm25/search）加入
`SettingsOverride`、`MemorySectionsSettingsOverride` 与
`applyMemorySectionsOverrideToRaw` 的 sections 列表 —— 这些组的 override 在 parse 之前
并入 raw，因此最终值 = parseConfig 结果，clamp/缺省仍由 config.ts 单一事实源决定。

get 侧：`admin-settings.ts` 新增 `plainSection`（effective 与已落盘 override 深合并、
剥掉废弃 shadowMode、不注入 source/apiKeyMasked 元字段），`server.ts` 的 getEffective
补 10 个整组。这样 /set 后即使 Core 未重启，页面也能立刻看到已保存值。

## 3. D 档数据怎么来的

`configCatalog.ts` 由 `config/templates/memorycore.keys.json`（440 条：path/type/default/source）
+ `D:/TDB/.scratch/cfg-inventory/merged-dedup.json`（每键「大白话」）合并生成：

```bash
# 生成脚本（幂等；改 keys.json 或盘点表后重跑）
node D:/TDB/.scratch/prune2/gen-catalog.mjs
```

档位规则（脚本内 `tier()`）：

- A：顶层组 `llm|embedding|auth|server|data|cos|shark|deployMode|stateBackend|instanceId|storeBackend`
- B：上面 8 个总闸的精确路径
- C：`importancePenalty.*` / `worthiness.*` / `recall.layerRuler.*` / `recall.injection.*` / `recall.rerank.*`
- D：其余

实测计数：A 48、B 8、C 15、D 369（合计 440；B/C 的少量页签字段不在 keys.json 的
layerRuler/injection 内，故清单里 C 只有 15 条，页签仍按 config.ts 实际字段渲染）。

注意：keys.json 440 条里有 63 条非 `memory.` 前缀（`skill.*` 等，同包内部键），
D 档按原路径展示，便于审计；它们不是 MemoryCore parseConfig 的外部配置面。

## 4. 验证

- MemoryCore：`npx vitest run src/gateway/admin-settings.test.ts src/gateway/__tests__/settings-override.memory-sections.test.ts src/gateway/settings-override.test.ts`
  → 3 文件 / 47 用例全过（新增：整组落盘与二次 set 不互相冲掉、非对象组 400、
  extraction.enabled 落盘、coreMemory.soulMaintenance 真进 parse、六组深合并互不串联）。
- MemoryCore：`npm run typecheck:gate` → 148 errors / 28 files vs 基线 149/28，Δ=-1，PASS。
- MemoryPanel web：`npx tsc --noEmit` EXIT 0；`npx vite build` 成功（1377 modules）。

## 5. 已知边界

- **生效时机**：所有保存仍走「写 override → Core 重启后生效」（/set 返回 needsRestart）。
  正在运行的旧 Core 不认新组，页面能保存但要在重启后才会真正改变行为。
- **D 档只读**：不提供写入口，避免把「协议常量」误改成生产差异；要改走代码评审。
- **capture 组**：后端已接受整组 override，但本版 B/C 页签没有暴露 capture 字段
  （当前 A/B/C 三档的定义里 capture 无「必须可调」的键）。
- **模板未变**：本轮只改设置 UI 与 Core override 链路；config/templates/memorycore.yaml
  未新增/删除键，check-config-templates 与上次一致（可复跑确认）。
