# 核心价值锚 + Core Memory 子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** 可维护的 `core_memory`（身份/严格规则）+ `core_values`（价值锚），稳定锚进 session_init 稳定区，且 agent 可读改（守信任边界）。
**Architecture:** 新 core 表 + 读写接口 + agent 工具 + 注入器稳定块。
**Tech Stack:** TS / vitest(或真机) / MemoryProxy 注入器。
**Spec:** `specs/2026-09-08-memory-core-values-design.md`。

## Global Constraints
- core 只收身份/严格规则/价值锚；agent 改动需可信来源+留痕（version/updated_at/source），可回滚。
- 稳定块走 `session_init`（保 cache）。
- 信任边界：不可信内容不得直接写 core。

---
### Task K1: core/core_values 表 + CRUD
**Files:** MemoryCore `src/core/store/sqlite.ts`(core_memory, core_values DDL)；Create `core/store/core-memory.ts`；Test。
**Interfaces:** `readCore(slot?)`；`upsertCore(entry)`；`listValues()`；`setValue(value)`。
- [ ] TDD：CRUD + 版本自增 + 留痕。
- [ ] Commit `feat(memory): K1 core 表+CRUD+版本`

### Task K2: agent 可维护工具 + 信任边界
**Files:** MemoryCore `src/core/tools/` 注册 `memory_core_read/update`；守 source 白名单 + 长度/消毒。
- [ ] TDD/冒烟：可信写留痕、不可信拒绝。
- [ ] Commit `feat(memory): K2 core 工具+信任边界`

### Task K3: 注入稳定块
**Files:** Modify `MemoryProxy/.../tdai-profile-memory-injector.ts`：core_memory 并入稳定块（session_init）。
- [ ] 冒烟：注入含 core 且稳定。Commit。