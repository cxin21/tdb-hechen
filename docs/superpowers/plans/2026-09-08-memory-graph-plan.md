# Memory Graph (l1_links) 子计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans。Step 用 `- [ ]`.

**Goal:** 为 L1 建显式记忆图（L1↔L1 边：因果/相似/冲突/演化），支撑邻居召回与后续重构式回忆。
**Architecture:** 新表 `l1_links` + 写入时在 dedup 处建边 + `getNeighbors/getPath` 查询；不替换原记忆，只加关联。
**Tech Stack:** TypeScript / better-sqlite3(via store) / vitest。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-08-memory-graph-design.md`（执行者同读两文档）。

## Global Constraints
- 边不替换记忆内容；删除记忆时级联删边。
- `causal/evolve` 只对 `certainty=observed` 建（推断不自动连因果）。
- 边表幂等：同 (s,t,type) 只一条，重复建边更新 strength/created_at。
- 测试必须真实跑（vitest；若 MemoryCore vitest 不可用，用真机 + tsx LOAD_OK + 重启冒烟）。
- Node 20.6+/ESM。

---
### Task G1: `l1_links` 表 + 写边/查询
**Files:** Create `src/core/store/sqlite.ts`(l1_links DDL + 迁移)；Create `src/core/record/l1-links.ts`；Test 新增。
**Interfaces:**
- `addLink(s,t,type,strength=1): memo`
- `getNeighbors(id,{types?,maxHop=1}): Array<{id,type,strength,hop}>`
- `deleteLinksFor(id): memo`

- [ ] **Step 1: 失败测试** `tests/record/l1-links.test.ts`：addLink → getNeighbors 返回邻居；deleteLinksFor 级联。
- [ ] **Step 2: 运行失败**
- [ ] **Step 3: 实现**：sqlite DDL（`l1_links` 表 + 幂等 ALTER/建表）+ `l1-links.ts` 三函数。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat(memory): G1 l1_links 表+写边/查询`

### Task G2: dedup 处建边
**Files:** Modify `src/core/record/l1-dedup.ts`（merge→similar / update→evolve / conflict→conflict / top-hit→similar）；Test 新增。
**Interfaces:** 复写 `applyDecisions`/dedup 结果后调 `addLink`（观察类才建 causal/evolve）。
- [ ] **Step 1: 失败测试**：merge 决策 → 生成 similar 边；conflict → conflict 边。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现**：在 dedup 分支按动作建边，守 certainty 约束。
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(memory): G2 dedup 写入即建边`

### Task G3: 部署+冒烟
- **Step 1:** 真机 `tsx` LOAD_OK + 重启 MemoryCore，验 8420 健康 + 无 sqlite 错。
- **Step 2:** 触发一次真实 L1 写入，查 `l1_links` 是否有边（若无 dedup 触发，至少表存在/边函数可用）。
- **Step 3:** Commit（若需）。