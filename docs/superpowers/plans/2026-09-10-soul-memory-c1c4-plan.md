# 灵魂记忆 · 第三档首批（C1-C4）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。任务间由队长审查，含 scoped re-review 与 fix round。
**Goal:** 价值信号全链流动——coreRef 写入标注+召回消费、动机方向（LLM 总结+微调）、router 退役、策略统一。检索层打分/门槛语义零改动（P-D 红线）。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-10-soul-memory-c1c4-semantic-recall-design.md`（执行者与 spec 同读；§1 影响矩阵是用户约束的交付物）。
**Tech Stack:** MemoryCore (sqlite/tsx)、MemoryProxy (vitest)、yaml（UTF-8 无 BOM——注意 tdai-gateway.yaml 编码纪律）。

## Global Constraints
- **检索层冻结**：向量/FTS 打分、绝对门槛、rrfMerge 语义零改动；价值信号只在排序 tiebreak/展示/遗忘层
- **宁缺毋滥**：coreRefs 仅明显触动才标（LLM 拒答给空）；方向仅 valence 非 NULL 非 0 才出
- **推理验证先行**：每个任务的报告必须先含推理验证节（数据流追踪+调用方穷举+边界清单），再给测试证据（用户指令）
- 同形验证：测试数据走生产同一条数据流；MemoryCore tsx 直跑 / MemoryProxy vitest
- 不碰 D:/tdai-data（生产收口重启由队长统一执行）；不派生子代理

---

## Task C4: summarizer significance 双兜底（策略统一）
**Files:** Modify `MemoryCore/src/core/lifecycle/consolidation/summarizer.ts`、`MemoryCore/scripts/verify-c4.ts`（新建）
**Steps:**
- [ ] RED：verify 断言"组内一条 metadata.significance=0.9（顶层无）→ durative significance=0.9"——当前实现 FAIL
- [ ] GREEN：significance 提取改顶层→metadata 双兜底（与 scorer.ts:35-47 同构）：顶层 numeric → metadata_json 已由 T17.5 mapL1RowToRecord 并入 metadata（T17.5 修复后行有 metadata）→ 半数规则不变
- [ ] Commit: `fix(memory): C4 策略统一 — summarizer significance 双兜底（与 scorer 一致）`

## Task C1: coreRef 全链（写入→排序→展示→遗忘）
**Files:** Modify `MemoryCore/src/core/prompts/l1-dedup.ts`、`record/l1-dedup.ts`（DedupDecision.coreRefs+parse）、`record/l1-extractor.ts`（attach+排序加成）、`tools/memory-search.ts`（排序 tiebreak+values 获取）、formatSearchResponse 尾注、`lifecycle/forgetting/forgetting-worker.ts` 或 appraisal.ts（salienceBoost 优先读）、`config.ts`（memory.recall.coreRefBoost）、`MemoryCore/scripts/verify-c1.ts`（新建）
**Interfaces:**
- Produces: `metadata.coreRefs: string[]`（写入侧全链）；`resolveRecallBoost(r, firedValues): number`（memory-search 内部或导出）
- Consumes: `store.listValues(tenant)`（T12 后带租户）、`appraisal.ts` 既有命中逻辑
**Steps:**
- [ ] RED：三断言（dedup 后 metadata.coreRefs 落库失败/命中价值时排序加成缺失/salienceBoost 不读 coreRefs）
- [ ] prompt：dedup 输出 schema 增 `coreRefs`（候选清单注入——从 listValues(tenant) 取当前租户 values；"仅明显触动时标注，无命中空数组"）；parse 宽松解析 + **过滤不在候选清单的 value_id**（防幻觉，P-D）
- [ ] extractor：decision.coreRefs → writeMemory 前 attach metadata
- [ ] 排序：executeMemorySearch 排序处 `rankKey = score + priority*1e-6 + coreRefBoost`；coreRefBoost = appraisal(query, tenant values) 命中 V ∧ r.metadata.coreRefs 含 V → memory.recall.coreRefBoost（默认 0.05，0=关）；appraisal 每次搜索只算一次（复用 current-feeling 的匹配函数或 appraisal.ts 既有）
- [ ] 展示：formatSearchResponse 片段行 `·触[正确,可靠]`（coreRefs ∩ appraisal 命中 非空才显示）
- [ ] 遗忘：salienceBoost 判定改为 coreRefs 命中优先、子串匹配兜底（B5 缓解）
- [ ] config：memory.recall.coreRefBoost 解析（默认 0.05）
- [ ] 同形验证：临时库+mock LLM（返回带 coreRefs 的决策）+ hashEmbed 向量路径——全链断言（落库/排序位次变化/尾注出现/salience 生效）
- [ ] Commit: `feat(memory): C1 coreRef 全链 — dedup 顺带判定/召回排序加成/展示尾注/遗忘 salience 优先`

## Task C2: valence 列 + LLM 总结 + 用户微调 + 渲染
**Files:** Modify `MemoryCore/src/core/store/sqlite.ts`（幂等 ALTER + deriveValueValences + upsertValue 增 valence）、`store/types.ts`、`gateway/v2-router.ts`（upsert 增可选 valence + /values/derive 路由）、`gateway/server.ts`（种子后 fire-and-forget）、`MemoryProxy/src/knowledge/current-feeling.ts`（三态方向行）、`MemoryCore/scripts/verify-c2.ts`（新建）
**Interfaces:**
- Produces: `deriveValueValences(tenant): Promise<{derived:number; skipped:number}>`（LLM 批量判 NULL 行，fire-and-forget 安全）；values/upsert body 增可选 `valence: -1|0|1`
**Steps:**
- [ ] RED：三断言（新 value 无 valence → 方向行不出现且 LLM 判定后出现；derive 路由重置+重判；upsert 微调覆盖 LLM 且不被再判）
- [ ] sqlite：幂等 ALTER 加 `valence REAL`（NULL=未判定）；`upsertValue` 透传；`listValues` 返回带 valence；`deriveValueValences`（LLM 批量三值枚举，解析失败→保持 NULL，R3 降级可见）
- [ ] hooks：server.ts 种子后 fire-and-forget；values/upsert 新建后 fire-and-forget（**只判 NULL**——微调覆盖永不重判）
- [ ] 路由：`/v3/core-memory/values/derive`（V3_ALLOWED_SUBPATHS + handler，无 body，返回 {derived, skipped}）
- [ ] 渲染：current-feeling.ts 按 valence 三态（NULL 不出）；S1 upsert 增可选 valence（clamp -1/0/1）
- [ ] 同形验证：mock LLMRunner 判定 + 真实 store + 真实渲染函数全链
- [ ] Commit: `feat(memory): C2 动机方向 — valence 列/LLM 总结初值/用户微调/derive 路由/三态渲染`

## Task C3: router 默认关 + 归档锚点
**Files:** Modify `MemoryProxy/src/injection/index.ts`（默认 enabled:false）、`MemoryProxy/config.yaml`（显式 false+注释）、`docs/superpowers/evals/recall-golden/runs/`（新锚点）
**Steps:**
- [ ] **前置归档**：replay 以部署参数（tw09/rel0.6）跑 `router-off` 配置 → `--archive`（router 退役前的诚实基线；预期 ≈0.66）
- [ ] 默认翻转 + config.yaml `enabled: false` + 注释（隔离实验数据引用）
- [ ] 复跑 replay 四配置归档（router-on 作为对比配置保留）→ 断言 negInjected 相比 router-on 降 2
- [ ] Commit: `feat(proxy): C3 router 默认关 — 隔离实验证伪归因后退役（锚点归档）`

## 收口（队长）
- [ ] 全量回归（全部 verify 脚本 + MemoryProxy vitest）
- [ ] 重启网关+Proxy → 生产冒烟（values derive 路由/appraisal 排序实况/注入块方向行三态/结构页排尾不回归）
- [ ] CHANGELOG 登记 + spec §6.4 更新（C1 coreRef 从未实现表移除——部分实现：写入+排序+展示+遗忘，检索层按设计不参与）

## Self-Review
- Spec 覆盖：§2 C1=Task C1、§3 C2=Task C2、§4 C3=Task C3、§5 C4=Task C4、§1 矩阵各行均有任务落点、§7 两拍板已闭合
- 类型一致：coreRefs/valueRefBoost/deriveValueValences 前后引用一致；MIN_SIMILAR_STRENGTH 不受影响
- 排序加成仅咽喉一处的裁决已在 spec §7.1 记录
