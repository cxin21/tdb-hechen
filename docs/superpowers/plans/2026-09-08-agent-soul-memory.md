# Agent 灵魂记忆系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TDB 记忆从"检索式"升级为"真正的记忆+感受"系统（时空性、关联图、巩固、遗忘、重构式回忆、情感层、自我模型），对到现有 L0–L3 代码落地。

**Architecture:** 复用 L0–L3 管道与 offload 调度；在 L1 写入链路加"时空/情感/置信"字段；新增 `l1_links` 记忆图与巩固/遗忘 worker；利用层沿用 wiki 召回的门控/宁缺毋滥 teach-out。**先写对"写入即理解"，再补生命周期与感受。**

**Tech Stack:** TypeScript, MemoryCore(MemoryCore/src), MemoryProxy(MemoryProxy/src), vitest, tsx, sqlite/tcvdb。

**Spec:** `td-agemem/docs/superpowers/specs/2026-09-08-agent-soul-memory-spec.md`（本计划从该 spec 论证；执行者两者同读）。

## Global Constraints
- 不推翻既有 L0–L3 与 Skill 资产，在其上增量扩展。
- 情绪层"功能性诚实"：不宣称主观体验；`reconsolidation` 只作用于 `certainty=observed` 层。
- 所有新字段/表必须有落库与可恢复（归档桶优先于删除）。
- 测试必须真的跑起来（`npx vitest run <path>`），不是纸面通过。
- 版本地板：Node 20.6+ / ESM / tsx。

---

## File Structure

**改（MemoryCore）**
- `src/core/prompts/l1-extraction.ts` — 提取 prompt 增加时空/情感/置信输出
- `src/core/record/l1-extractor.ts` — 解析新增字段
- `src/core/record/l1-writer.ts` — MemoryRecord/ExtractedMemory 增字段 + 落库
- `src/core/store/sqlite.ts` — `l1_records` 增列
- `src/core/store/tcvdb.ts` — 向量字段透传
- `src/core/hooks/auto-recall.ts` — 修 `_threshold` 被忽略（L1 门控）
- `src/core/tools/memory-search.ts` — tdai_memory_search 门控 + priority；后续加邻居/时间组装

**建（MemoryCore）**
- `src/core/record/l1-links.ts` + `src/core/store` 增 `l1_links` 表
- `src/core/lifecycle/consolidation-worker.ts` — 点→持续态
- `src/core/lifecycle/forgetting-worker.ts` — 重要性×时间→归档
- `tests/...` 对应单测

**改（MemoryProxy）**
- `src/injection/injectors/tdai-profile-memory-injector.ts` — 稳定记忆锚定 + 当前感受(appraisal)块

---

## 阶段一：利用层门控（P1，最先可落地）

### Task 1: L1 检索修绝对门控（`auto-recall.ts`）
**Files:** Modify `src/core/hooks/auto-recall.ts`（`searchHybrid` 忽略 `_threshold`）；Test 新增。

**Interfaces:** 无外部签名变化；`searchMemories(userText, ..., threshold)` 内 `searchHybrid` 遵循 threshold 语义。

- [ ] **Step 1: 写失败测试**（在 `tests/hooks/auto-recall.threshold.test.ts`）
```ts
import { describe, it, expect } from "vitest";
import { searchHybrid } from "../src/core/hooks/auto-recall.js"; // 若为私有则同文件抽 export
it("filter below threshold even when ranked in top-K", async () => {
  // mock vectorStore/embeddingService 返回 3 条 cosine [0.1,0.5,0.9] -> threshold 0.3 应只剩 2 条
  // (构造见 Task 1 说明文件；断言 results.lines.length === 2)
});
```
- [ ] **Step 2: 运行验证失败** `npx vitest run tests/hooks/auto-recall.threshold.test.ts` → FAIL
- [ ] **Step 3: 最小实现**：`searchHybrid` 前先按 `absScore>=threshold`（原向量 cosine）过滤，再 RRF 融合；`_threshold` 不再忽略。
- [ ] **Step 4: 运行通过** 同上 → PASS
- [ ] **Step 5: Commit** `feat(memory): L1 hybrid 绝对门控生效（宁缺毋滥）`

### Task 2: tdai_memory_search 门控 + priority 加权
**Files:** Modify `src/core/tools/memory-search.ts`。

**Interfaces:** 保持对外 `MemorySearchResultItem{content,type,priority,scene_name,score}`；内部融合后按 score 过滤 + priority 加权排序。

- [ ] **Step 1: 写失败测试** `tests/tools/memory-search.gate.test.ts`：给低 score 记忆直接被丢弃、高 priority 且 score 达标者靠前。
- [ ] **Step 2: 运行失败**
- [ ] **Step 3: 实现**：在返回前 `filter(score>=threshold)` + `sort(by score + priorityWeight)`。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat(memory): memory_search 门控+priority 加权`

---

## 阶段二：写入即理解（P2a，真记忆的根）

### Task 3: L1 提取加"时空/情感/置信"字段
**Files:** Modify `prompts/l1-extraction.ts`、`record/l1-extractor.ts`、`record/l1-writer.ts`（ExtractedMemory/MemoryRecord）；Test 新增。

**Interfaces:**
- `ExtractedMemory` 新增可选 `occurred_at?`, `valid_range?:[string,string]`, `certainty:"observed"|"inferred"`, `source?:string`, `valence?:-1|0|1`, `arousal?:0|1`, `significance?:0|1`。
- `MemoryRecord` 同字段，透传写入。

- [ ] **Step 1: 写失败测试** `tests/record/l1-extractor.fields.test.ts`：
```ts
import { parseExtractionResult } from "../src/core/record/l1-extractor.js";
it("parses spacetime/affect/certainty fields", () => {
  const raw = `[{"scene_name":"x","message_ids":["a"],"memories":[{"content":"c","type":"episodic","priority":80,"occurred_at":"2026-09-08","certainty":"observed","valence":1,"arousal":0.6,"significance":0.8}]}]`;
  const scenes = parseExtractionResult(raw, undefined);
  const m = scenes[0].memories[0] as any;
  expect(m.occurred_at).toBe("2026-09-08");
  expect(m.certainty).toBe("observed");
});
```
- [ ] **Step 2: 运行失败** `npx vitest run tests/record/l1-extractor.fields.test.ts`
- [ ] **Step 3: 实现**：`prompt` 的 system prompt 要求并给出这些字段示例；`parseExtractionResult` 解析并回填；`writer` 透传。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat(memory): L1 写入即理解（时空/情感/置信字段）`

### Task 4: L1 存储 schema 增列
**Files:** Modify `src/core/store/sqlite.ts`（`l1_records`）、`src/core/store/tcvdb.ts`；Test 新增（schema / round-trip）。

**Interfaces:** `l1_records` 增列：`occurred_at TEXT`, `valid_start TEXT`, `valid_end TEXT`, `certainty TEXT`, `source TEXT`, `valence REAL`, `arousal REAL`, `significance REAL`。

- [ ] **Step 1: 写失败测试** `tests/store/l1-schema.columns.test.ts`：建库后 `PRAGMA table_info(l1_records)` 断言含新列；写入+读回 round-trip 保留字段。
- [ ] **Step 2: 运行失败**
- [ ] **Step 3: 实现**：`sqlite.ts` 建表 SQL 增列 + 读写映射；tcvdb 向量索引字段（若启用）同步。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat(memory): l1_records schema 增时空/情感/置信列`

---

## 阶段二后半：记忆网络 + 巩固 + 遗忘（P2b/c/d，核心、需拆子计划）

> 说明：以下为较大子工程，单个计划文档装不下全部 bite-size 步骤；**按 writing-plans 范围检查，建议各拆一份子计划**。本计划先给出任务边界与接口，作为各子计划的地图。

### Task G: 记忆图 `l1_links`
**Files:** Create `src/core/record/l1-links.ts` + `src/core/store` 增表 `l1_links(source_id,target_id,type,strength,created_at)`；Modify `l1-dedup.ts` 在 update/merge 结果建边。
**Interfaces:** `addLink(s,t,type,strength)`、`getNeighbors(id,{maxHop,types})`。
**Verification:** `tests/record/l1-links.test.ts`（建边、邻接、去重）。

### Task H: 巩固 worker（点→持续态，TSM）
**Files:** Create `src/core/lifecycle/consolidation-worker.ts`（复用 offload 调度）；Modify `persona-generator.ts` 由它驱动演进。
**Verification:** 给定同一主体 N 条 L1 → 产出 1 条持续态摘要；`certainty=inferred` 不动。

### Task I: 遗忘 worker（重要性×时间→归档桶）
**Files:** Create `src/core/lifecycle/forgetting-worker.ts` + `l1_archive` 表。
**Verification:** 低 `significance×priority` 且超期 → 归档（软删，可恢复）；高价值不过期。

### Task J: 重构式回忆（邻居+时间线组装）
**Files:** Modify `src/core/tools/memory-search.ts` 沿 `l1_links.getNeighbors` + 时间轴组装进结果。
**Verification:** 返回含关联记忆/场景/时间线。

---

## 阶段三：感受层 + 自我模型（P3）

### Task K: 核心价值锚 + core memory
**Files:** Create `src/core/core-memory/*`（`core_memory` 表 + `core_values` 表 + 读写接口）；Modify 注入器暴露可编辑 core。
**Verification:** 读/写 core；值表 CRUD 单测。

### Task L: 当前感受(appraisal) 注入块
**Files:** Modify `MemoryProxy/.../tdai-profile-memory-injector.ts`：每轮由"当下语境 vs 核心值"产出一个轻量"当前状态"块。
**Verification:** 注入器单测：给定语境/值 → 产出块；边界（无关语境）不强行输出情绪。

### Task M: persona 演进
**Files:** Modify `persona-generator.ts`：由巩固结果重建 persona。
**Verification:** 巩固后 persona 内容变化、跨会话一致。

---

## Self-Review 记录
- **Spec 覆盖**：P1=利用层门控(§9)、P2a=时空/情感/置信(§4.1/§5/§7)、G=关联(§4.2)、H/I=巩固/遗忘(§4.3/§4.4)、J=重构式回忆(§4.5)、K/L/M=感受+自我(§5/§6)。红线（入口真实/会巩固会忘/重构式回忆）均落任务。
- **占位符**：G–M 为"子计划地图"，不含 bite-size 步骤——已在文中明确需拆分，不伪装成完整步骤。
- **类型一致**：`ExtractedMemory`/`MemoryRecord` 新字段名在 Task 3/4 间一致。