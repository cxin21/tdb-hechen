# 遗忘（Forgetting / 归档桶）子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** 重要性×时间衰减 → 低价值归档桶（软删可恢复）；归档优先于删除。
**Architecture:** `forgetting-worker`（后台）按 `significance×priority×decay(age)` 打分，把低分移入 `l1_archive`；检索排除归档、可显式恢复。
**Tech Stack:** TS / vitest(或真机) / sqlite(store) / offload。
**Spec:** `specs/2026-09-08-memory-forgetting-design.md`。

## Global Constraints
- **归档优先于删除**；`certainty=observed` 才可自动归档（inferred 需更高阈值）。
- λ 保守默认（宁漏不忘）；可审计（reason/时间）、可恢复。
- 检索默认排除 archive；显式恢复 API。

---
### Task I1: `l1_archive` 表 + 归档/恢复
**Files:** `sqlite.ts`(l1_archive DDL + 迁移)；Create `src/core/lifecycle/forgetting/archive.ts`；Test。
**Interfaces:** `archiveRecords(ids,{reason})`；`restoreRecord(id)`；`queryArchived(filter)`。
- [ ] TDD：归档后 `l1_records` 无、`l1_archive` 有且带 reason；恢复回 `l1_records`。
- [ ] Commit `feat(memory): I1 归档桶+恢复`

### Task I2: 遗忘打分 + worker
**Files:** Create `src/core/lifecycle/forgetting/scorer.ts`（`score=m*significance*priority*decay`）+ `forgetting-worker.ts`（挂 offload）；Test。
**Interfaces:** `decay(ageDays,{lambda})`；`scoreFor(memory)`；`runForgetting(store,{lambda,lowThreshold})`。
- [ ] TDD：低分且超期→归档；高价值→保留。
- [ ] 真机冒烟不阻塞在线写。
- [ ] Commit `feat(memory): I2 遗忘打分+worker`

### Task I3: 检索排除归档 + 恢复口径
**Files:** Modify `memory-search.ts` / `queryL1Records`：默认 `archived_at IS NULL`。
- [ ] TDD / 冒烟。Commit。