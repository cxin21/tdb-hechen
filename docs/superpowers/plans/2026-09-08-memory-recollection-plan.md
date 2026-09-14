# 重构式回忆（Reconstructive Recollection）子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** 把 `memory_search` 从"孤儿 top-k 取件"升级为"沿关联+时间轴组装回忆片段"。
**Architecture:** 语义种子(G1 绝对门槛) → 图扩展(l1_links getNeighbors) → 再门控 → 包装成"记忆+场景+时间线"片段。
**Tech Stack:** TS / vitest(或真机) / 依赖 G 的 `getNeighbors`。
**Spec:** `specs/2026-09-08-memory-recollection-design.md`。

## Global Constraints
- 宁缺毋滥：强相关才出片段；`certainty/source` 可信且过门槛才进（红线）。
- maxHop=1；片段带预算；支持"当时"时间窗。
- 只在 observed 层做重缝合（N/A）。不改检索入口对外 API 语义。

---
### Task J1: 图扩展组装
**Files:** Modify `src/core/tools/memory-search.ts`（种子后拼 `getNeighbors`）；Test。
**Interfaces:** 新返回 `{ items:[{id,titles,score,scene,occurred_at,valid_end,path?}], strategy }`。
- [ ] TDD: query→种子→邻居并入→再门控→含场景/时间线。
- [ ] Commit `feat(memory): J1 图扩展+再门控`

### Task J2: 时间轴 + 包装
**Files:** 同文件 `groupTimeline(items)` + 格式化；Test。
- [ ] TDD: 结果能给出时间先后/持续态优先。
- [ ] Commit `feat(memory): J2 时间轴+回忆包装`

### Task J3: 部署冒烟
- [ ] `tsx` LOAD_OK + 重启 MemoryCore + 8420 健康；真机触发一次 memory_search，看返回是否含 scene/时间线。