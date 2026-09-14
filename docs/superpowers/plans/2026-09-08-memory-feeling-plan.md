# 当前感受（Appraisal）子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** 每轮由"当下语境 vs core_values"派生轻量 `appraisal` 信号，进注入看重/显著性加权（功能性诚实，不假装情绪）。
**Architecture:** `appraisal` 计算器 + 注入块（可选/宁缺毋滥）+ 供巩固/遗忘加权。
**Tech Stack:** TS / vitest(或真机) / MemoryProxy 注入器 / core_values。
**Spec:** `specs/2026-09-08-memory-feeling-design.md`。

## Global Constraints
- 只表达"这件事在多重要/触动哪个价值"，**不宣称主观情绪**。
- 无价值命中 → 中性，不硬给情绪块。
- 只加权显著性，不改事实内容。

---
### Task L1: appraisal 计算器
**Files:** Create `MemoryCore/src/core/feeling/appraisal.ts`（`matchValues(ctx, values)` → `[{value,weight,fired,arousal}]`）；Test。
**Interfaces:** `appraise(context, values)->Appraisal|undefined`。
- [ ] TDD：命中价值→fired；无关→undefined。
- [ ] Commit `feat(memory): L1 appraisal 计算器`

### Task L2: 注入块（宁缺毋滥）
**Files:** Modify `MemoryProxy/.../tdai-profile-memory-injector.ts`：仅当 fired 且超阈值输出短 `<current_feeling>`。
- [ ] 冒烟：强相关语境出 short 块；无关不出。
- [ ] Commit `feat(memory): L2 当前感受注入块`

### Task L3: 接入巩固/遗忘显著性
**Files:** Modify H(scorer)/I(scorer)：把 `appraisal.weight` 并入显著性。
- [ ] TDD/冒烟。Commit。