# Persona 演进（自我模型）子计划

> **REQUIRED SUB-SKILL:** subagent-driven-development / executing-plans。`- [ ]` 追踪。

**Goal:** L3 persona 随巩固(H)持续演化 + 跨会话一致；高价值结论可进 core_memory(K)。
**Architecture:** 增量式 persona 合成（旧画像+近期持续态）；一致性/防漂移裁决。
**Tech Stack:** TS / vitest(或真机) / persona-generator / LLM。
**Spec:** `specs/2026-09-08-memory-persona-design.md`。

## Global Constraints
- 默认只并入 `certainty=observed` 且有显著性支撑的结论。
- 防漂移：连续高显著性才让核心画像变（不因一天异常重写）。
- 增量式合成控 token；留演化留痕段。

---
### Task M1: 增量 persona 合成
**Files:** Modify `persona-generator.ts`（旧 persona + 近期持续态 → 新画像）；Test。
**Interfaces:** `evolvePersona(oldPersona, durativeRecords)->newPersona`（增量式）。
- [ ] TDD：持续态并入、旧核心保留。
- [ ] Commit `feat(memory): M1 增量 persona 合成`

### Task M2: 一致性 + 防漂移裁决
**Files:** Create `src/core/lifecycle/persona/consistency.ts`（冲突裁决/高显著才变）；Test。
- [ ] TDD：观测证据不足→保留旧/标待确认。
- [ ] Commit `feat(memory): M2 一致性+防漂移`

### Task M3: 持续态回写 core(可选触发) + 冒烟
- **Step1:** 高价值画像结论按规则进 `core_memory`（复用 K）。
- **Step2:** 真机冒烟 persona 演进 + 跨会话一致。
- Commit。