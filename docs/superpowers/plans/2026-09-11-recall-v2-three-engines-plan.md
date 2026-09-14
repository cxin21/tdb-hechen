# 召回 v2 三引擎 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
**Goal:** 三引擎落地（引擎二 PPR 全图扩散直接上 / 引擎一 查询自动扩展 / 引擎三 注意力平衡 + R-v2.1 精排轻档）——P@5 平台期（0.210）的结构性突破。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-11-recall-v2-three-engines-design.md`（执行者与 spec 同读；E2.1 算法规格/E1.1-E1.4/E3.1-E3.3 逐条采用）。
**Tech Stack:** MemoryCore (memory-search.ts / auto-recall.ts / sqlite.ts / config.ts)、vitest、tsx。

## Global Constraints
- **不变式（§3）**：绝对门槛/gatedVec/RRF/租户隔离/T2 门/降级标注零变化；三引擎全部作用于候选池/排序/注入组装层
- **关断矩阵延续**：每引擎独立开关，0/off = 与 v1 基线逐位一致（逐通道断言）
- **零人工**：全部自动生成/派生/启发式；失败自动退化
- 推理验证先行（报告前节）；TDD；两排序点（咽喉+auto-recall）逐处覆盖；不派生子代理；不碰 D:/tdai-data/生产进程（收口队长统一）
- **R-A2 一跳替换是预期行为变更**（verify-ra2 断言相应更新并登记）
- tdai-gateway.yaml（UTF-8 无 BOM）不碰

---

## Task V2-1: 引擎二 PPR 全图扩散（核心，替换一跳）
**Files:**
- Create: `MemoryCore/src/core/recall/ppr.ts`（纯函数：buildAdjacency/runPPR）
- Modify: `MemoryCore/src/core/tools/memory-search.ts`（expandCandidatePool 内部替换为 PPR）
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts`（同层对齐）
- Modify: `MemoryCore/src/gateway/config.ts`（memory.recall.pprDamping 0.85/pprTopK 10/pprIterations 30——graphMinStrength/graphDiscount 沿用）
- Create: `MemoryCore/scripts/verify-v2-ppr.ts`
**Interfaces:**
- Produces: `runPPR(seeds: Map<id, weight>, edges: Array<{src,tgt,strength,kind}>, opts): Map<id, pprNorm>`（纯函数，无 IO）
- Consumes: 命中集（门槛后）、l1_links 边（租户过滤后）、graphMinStrength/graphDiscount
**Steps:**
- [ ] RED：多跳断言（A→B→C 链，seeds={A} → B 与 C 都浮现且 C < B——一跳 BFS 做不到的多跳一步到位）/收敛性/空图/租户隔离/确定性/关断（graphDiscount=0 → 零图候选）
- [ ] ppr.ts：buildAdjacency（无向化：双向各记一条同权边）+ runPPR（迭代 r=d·M·r+(1-d)·p，收敛 1e-6 或 30 轮，稀疏 Map 实现）
- [ ] 集成：expandCandidatePool 内部替换——种子=门槛后命中（score 归一化为种子权重）→ PPR → 非种子 top-pprTopK → 候选分 = maxHitScore × graphDiscount × pprNorm → [graph:ppr] 标注（主导边类型）
- [ ] auto-recall 同层对齐（R-A1/R-A2 教训：两排序点单一源消费）
- [ ] verify-ra2 断言更新（一跳→PPR 多跳，预期行为变更登记）+ 全量回归
- [ ] Commit: `feat(memory): V2-1 引擎二 PPR 全图扩散 — 多跳一步到位替换一跳补池（关断矩阵延续）`

## Task V2-2: 引擎一 查询自动扩展
**Files:**
- Create: `MemoryCore/src/core/recall/query-expand.ts`（纯函数：buildExpansionPrompt/parseExpansion）
- Modify: `memory-search.ts`（FTS OR 合并）、`auto-recall.ts`（同层）、`config.ts`（queryExpansion 四键）
- Create: `MemoryCore/scripts/verify-v2-qe.ts`
**Interfaces:**
- Produces: `expandQuery(query, runner): Promise<string[]>`（失败→[]）
**Steps:**
- [ ] RED：扩展词并入 FTS 后候选扩大的断言 + LLM 失败退化断言 + 缓存断言
- [ ] expandQuery：standalone runner（maxTokens 8192——推理模型预算教训）+ prompt（纯语义扩展零语料泄漏）+ 解析（字符串数组/去重/去原词）+ 失败→[]
- [ ] FTS OR 合并：扩展词 OR 进 MATCH 表达式（注入路径的 FTS 查询构建点）
- [ ] 缓存：Map<query, terms> TTL 10min
- [ ] Commit: `feat(memory): V2-2 查询自动扩展 — LLM 语义邻域/FTS OR 并入/缓存/失败退化`

## Task V2-3: 引擎三 注意力平衡 + R-v2.1 精排轻档
**Files:**
- Modify: `memory-search.ts`（探索位+精排）、`auto-recall.ts`（同层）、`config.ts`（exploreSlot/conclusionRelaxedForAnalytical）
- Create: `MemoryCore/scripts/verify-v2-bal.ts`
**Steps:**
- [ ] 探索位：最终截断前，末席替换为"结构命中但 recall_count 最低"候选 + [explore] 标注
- [ ] 结论层放宽：分析型 query 检测（启发式：分析标记+长度）→ significance top-5 durative 结论入结论层
- [ ] R-v2.1 精排轻档：候选合并后、截断前——组合分精排（occurred_at 时近 + significance + coreRef 命中数的加权组合，替代单一 rankKey 排序；零成本零延迟）
- [ ] Commit: `feat(memory): V2-3 注意力平衡 — 探索位/结论放宽/组合分精排（R-v2.1 轻档）`

## 收口（队长）
- [ ] golden 前后锚 + P@5 对照（**预期上移**——扩展词+PPR 捞回文本不匹配的主题相关记忆）
- [ ] 全量回归 + 重启 + CHANGELOG
