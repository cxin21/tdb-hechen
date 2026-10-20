# #73+#74 全量实现合同（Batch A + Step 0，2026-10-20）

> 授权链：final-plan v1.0（D1-D7 定案）→ 用户「开工」（m00169）→ 用户 m00207「我要全量完整实现，验收的时候你别给我搞个最小实现什么的糊弄我」。
> 本合同按 #73/#74 票面全验收项落地，不裁剪范围；TDD「最小 GREEN」仅约束单测试驱动节奏，不构成范围裁剪依据。

## 1. #74 范围（Batch A · 查询剥噪两级接入 + time_point 透传 + journal skipReason）

### 1.1 sanitize.ts 扩展（六 pattern 补全，单一源进 sanitizeText，钩子路同步受益）
- 既有（sanitize.ts:48-68）：<acp> 标签、<system-reminder|current_feeling|soul-identity|soul-feeling> 块、Time sampled/Elapsed/Browser time zone 行、[model changed: 行、efficiency nudge 行。
- 新增 4 类（D4 缺口）：
  1. 裸 m\\d{5} ref token（词边界，如 m00207）→ 删 token 留正文；
  2. ⚠️/Context limit 系统提醒行（整行删）；
  3. 【Compressed conversation section】区段头（整行删，区段正文保留交两级策略）；
  4. [current_feeling]/[soul-*] 方括号标签头（含属性形式 [soul-event kind="..."]，删 token 留正文）。

### 1.2 两级策略 sanitizeRecallQuery（sanitize.ts 新导出）
- `MIN_QUERY_RESIDUAL_CHARS = 10` 导出常量；
- 返回 `{ text, skipped, residualChars }`：sanitizeText 清洗后 residual < 10 字符 → skipped=true（一级：整条跳过）；否则 text=清洗后查询（二级：清洗后检索）。

### 1.3 handleRecall 接入（v2-router.ts）
- b.query → sanitizeRecallQuery；
- skipped → best-effort 写 journal skip 条目（cfg.recallJournal 门控；目录/租户推导镜像 auto-recall.ts:1245-1274；skip 路是独立语义入口，不经 performLayeredRecall，以 skipReason 区分）+ successEnvelope block="" + meta.skipReason="scaffold-query"（additive 字段，向后兼容）+ perfMs 零值；
- 非 skipped → performLayeredRecall userText=sq.text（端点路剥噪补齐，与钩子路 auto-recall.ts:693 对齐）。

### 1.4 recall-journal.ts
- RecallJournalEntry 增可选 `skipReason?: string`（缺省字段=正常召回，向后兼容）。

### 1.5 proxy time_point 透传（MemoryProxy/src/tdai/client.ts:289 body）
- recallBlockForCtx 请求体增 `time_point`=调用时 ISO → 核心 :1880-1885 旁路会话复用缓存 + 时窗锚定（T4 病灶②接线第一刀）。

### 1.6 测试（RED 先行）
- sanitize-harness-noise.test.ts 扩 4 用例（新 pattern 各一+普通文本回归锚沿用）；
- 新 sanitize-recall-query.test.ts：两级边界（9/10 字符）、纯脚手架 skip、混合清洗、干净查询逐位保留、常量=10；
- recall-journal：skipReason 往返用例；
- v2-router-recall-merge.test.ts（端点级）：D1 纯脚手架→200+block=""+meta.skipReason+journal skip 条目落盘；D2 混合查询→正常召回且 journal.query=清洗后文本（端到端清洗实证）；D3 干净查询行为不变（回归锚）；
- client.recall-merge.test.ts：body.time_point 存在且可解析为 ISO。

### 1.7 非目标（边界）
- 四门（idfWeighted/textHitMaxTokenRatio/minUniqRatio/minBm25Rel）配置翻转不在本票，测试全绿后单独报备用户；
- F2 密度截断/F6 时效衰减/F1 原子化（Batch B/C/D）另票，本批不触。

## 2. #73 范围（Step 0 · golden 数据集 + runner 四指标复跑）

- 数据集：docs/superpowers/evals/memory-recall-golden/recall-precision-2026-10-20/dataset.jsonl——P1-P10 生产 11 轮/34 行标注（T4 取证表 §4），行级 record id 与原文从生产 journal **只读回捞**；_meta 头行记录口径（评级 rubric、会话隔离、sessionReused 过滤）。
- runner：MemoryCore/scripts/recall-precision-eval.mjs——镜像 recall-anchor.mjs 脚手架（临时 yaml 经 TDAI_GATEWAY_CONFIG、os.tmpdir 自清理、临时端口 8422、生产 vectors.db **副本**入临时目录：零写生产、bump 只落副本）；重放 11 条生产干净查询过 /v3/recall；
- 四指标：高价值率（对 dataset 正例 id 计 P@k）、脚手架噪音查询率（sanitizeRecallQuery skip 判定）、空召回率、perfMs 分位（p50/p90）；归档 runs/<ts>.json（配置快照+corpus 快照+逐 query 明细）；
- runner 为独立脚本，**不改动生产代码路径**，不入 vitest 套件。

## 3. 验收门（final-plan D5）
- 全量门绿：vitest-core 基线守恒（230 files/2008 tests）+新增全绿；vitest-proxy 守恒（47 files/368 tests）；`pnpm run typecheck` 243 errors 基线零新增；
- D1-D3 端点测试全绿；#73 runner 可执行且四指标与 T4 基线（26.5%/77.7%/59.5%/p90=2024）同口径可对账；
- 对抗审查（零编辑只读）→ 收口；commit/push 待用户授权（surgical，绝不裹挟外来 WIP）。
