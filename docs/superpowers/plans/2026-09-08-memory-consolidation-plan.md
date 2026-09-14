# 巩固（Consolidation）子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** 把同一主体多条点状 L1 巩固成"持续态摘要"，喂 L2/L3；reconsolidation 仅动 observed。
**Architecture:** 复用 offload 管道的 `consolidation-worker`（按 subject 分组 → LLM 生成持续态 → 附着 L2/L3）；回收原有 L1 降为证据。
**Tech Stack:** TS / vitest(或真机) / offload(pipeline-worker)。
**Spec:** `specs/2026-09-08-memory-consolidation-design.md`。

## Global Constraints
- 组内 ≥N 条且跨期才巩固；`certainty=observed` 优先促成。
- **reconsolidation 只在 observed 层**；inferred 锁死不重写（红线）。
- 不阻塞在线写入（后台 worker）；不影响既有 L0–L3/Skill。

---
### Task H1: subject 归并键 + 组定义
**Files:** Create `src/core/lifecycle/consolidation/grouping.ts`；Test。
**Interfaces:** `groupBySubject(memories,{minCount,minSpanDays})->Array<MemoryGroup>`；`isObservable(m)`。
- [ ] **Step1 失败测试**: 3 条同主题跨期 → 一组。
- [ ] **Step2 失败 → Step3 实现 → Step4 通过 → Step5 commit** `G1`。

### Task H2: 持续态摘要生成器
**Files:** Create `src/core/lifecycle/consolidation/summarizer.ts`（LLM 调用）；Test(mock LLM)。
**Interfaces:** `buildDurativeSummary(group)->DurativeRecord`（含 occurred_at=最新、valid_*、significance=max）。
- [ ] TDD 循环同 G。

### Task H3: worker 调度 + 附着 L2/L3
**Files:** Create `src/core/lifecycle/consolidation/consolidation-worker.ts`（挂 offload）；Modify `scene-extractor`/L2、`persona-generator`/L3 消费。
- [ ] TDD / 真机冒烟；验证不阻塞在线写。
- [ ] Commit `feat(memory): H 巩固 worker（点→持续态→喂 L2/L3）`。

### Task H4: reconsolidation（仅 observed）
**Files:** Modify `memory-search.ts` / 调用点：当 observed 记忆被回忆触发时，允许按当下微更新（inferred 锁死）。
- [ ] TDD；守红线。Commit。