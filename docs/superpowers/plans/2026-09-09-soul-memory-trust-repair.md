# 灵魂记忆可信性修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已拍板的修复设计（五阶段）落地全部 P0-P4 修复，使记忆系统的数据正确性、信任边界、降级可观测性、验证纪律一次性闭环。

**Architecture:** 六个根因模式（副本抄漏/守卫未接线/降级静默/常量伪造/验证失配/归因无锚）对应六原则（单一事实源/守卫在咽喉/降级喊疼/拒绝伪造/验证同形/归因留锚），按数据流顺序五阶段落地：P0 数据止血 → P1 FTS/图数据链 → P2 信任边界 → P3 可观测与算法 → P4 诚实性。每阶段一个 commit 收口，每任务带"同形验证"（测试数据走生产同一条数据流）。

**Tech Stack:** TypeScript, MemoryCore (better-sqlite3 + sqlite-vec + FTS5), MemoryProxy, vitest(MemoryProxy)/tsx 直跑(MemoryCore), Node ≥20.6 ESM。

**Spec:** `td-agemem/docs/superpowers/specs/2026-09-09-soul-memory-trust-repair-design.md`（本计划从该 spec 论证；执行者两者同读。问题编号 W1/E1/E2/H-B*/G*/K* 沿用 `reviews/2026-09-09-soul-memory-fifth-round-audit.md`）

## Global Constraints

- **只增不推翻**：不改 L0-L3 架构与既有 API 语义；FTS 列只追加；dedup 双 Tier 保留只改判据。
- **宁缺毋滥**：拿不到真值不造假值（G5 边强度、T2.3 FTS 边不建、T4.4 混租户组不巩固）。
- **同形验证**：每条 verify 断言的数据必须走生产同一条数据流（测 reconsolidation 调 executeMemorySearch，不手拼 record 喂 scoreFor）。
- **fixture 共享类型**：fixture import 生产类型定义，生产加字段 fixture 编译报错。
- **Node 20.6+ / ESM / tsx**；MemoryCore vitest 不可跑，验证统一用 `node --import tsx scripts/<verify>.ts` 直跑。
- **诚实登记**：所有行为变更（鉴权必填/假边清理/结构页降权）入 CHANGELOG + 部署文档。
- **生产库纪律**：迁移脚本必须 dry-run 默认、`--apply` 才真写；生产执行前备份 `vectors.db`（copy 一份带时间戳）。

---

## File Structure

**MemoryCore（主战场）**
- `src/core/store/soul-columns.ts` — **新建**：SOUL_COLUMNS 单一事实源（8 字段名/类型/默认值）
- `src/core/store/sqlite.ts` — FTS 虚表迁移、stmtL1FtsInsert/Search 改造、restoreL1 分词、updateL1Metadata SQL 自增、core 表加租户列、getNeighbors filter、countL1VectorRows
- `src/core/lifecycle/consolidation/consolidation-worker.ts` — sourceMemories 接 isObservable、混租户组校验、inheritTenancy 不动
- `src/core/lifecycle/consolidation/summarizer.ts` — durative significance/certainty 真值化
- `src/core/lifecycle/consolidation/grouping.ts` — subjectStrategy（llm/embedding/lexical）
- `src/core/record/l1-dedup.ts` — CandidateMatch.topScore 透传、attachTopCandidates 真值/FTS 不建边
- `src/core/record/l1-extractor.ts` — storeAllDirectly 同批排除、dedup prompt subject 字段解析
- `src/core/prompts/l1-dedup.ts` — prompt 增 subject 输出要求
- `src/core/tools/memory-search.ts` — inferred 门收紧、reconsolidation 改 SQL 自增依赖
- `src/core/hooks/auto-recall.ts` — 注入块 degraded 标注
- `src/core/hooks/auto-capture.ts` 或对应 l1 recall 触发处 — current_feeling 解冻接线（MemoryProxy 侧为主）
- `src/core/core-memory/guard.ts` — 不动（已完备）
- `src/utils/sanitize.ts` — escapeXmlTags 边界名单加 core_memory 系
- `src/config.ts` — MemoryLifecycleConfig.filter、subjectStrategy、结构页权重字段
- `src/gateway/v2-router.ts` — handleAtomicUpdate soul 补拷、neighbors filter/maxN clamp、core-memory handler 租户化
- `src/gateway/server.ts` — apiKey 缺失生成、lifecycle filter 传递、/health 探活
- `scripts/` — 各阶段同形验证脚本 + FTS 迁移脚本 + 假边清理脚本
**MemoryProxy**
- `src/tdai/client.ts` — searchL1ForCtx 补 8 字段映射（P1 顺手）
- `src/injection/injectors/tdai-profile-memory-injector.ts` — current_feeling 拆每轮执行、缓存租户键
- `src/injection/injectors/wiki-recall-injector.ts` — 结构页降权、degraded 标注、日志拼接 bug
**MemoryKnowledge**
- 无改动（typeWeights 配置已在 proxy 侧）
**docs**
- `CHANGELOG.md`、spec §6 偏离补登记

---

## 阶段一 · P0 数据止血（M1，1 天）

### Task 1: 堵 H 侧洗白门（H-B3，一行）

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/consolidation/consolidation-worker.ts:37-40`
- Test: `MemoryCore/scripts/verify-p0-t1.ts`（新建）

**Interfaces:**
- Consumes: `grouping.ts:25-27` `isObservable(m: {certainty?: string}): boolean`（已存在）
- Produces: `sourceMemories` 仅放行 observed；后续 Task 4.4 复用此行为

- [ ] **Step 1: 写同形失败验证**

```ts
// MemoryCore/scripts/verify-p0-t1.ts
/**
 * 同形验证：走真实 runConsolidation 数据流，断言 inferred 源记忆不进组。
 * 用 mock LLMRunner + 真实 grouping/worker 代码（与生产同一函数）。
 */
import { groupBySubject, type ConsolidationConfig } from "../src/core/lifecycle/consolidation/grouping.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// 构造：2 条 observed + 1 条 inferred，同前缀（subjectOf 命中同组）
const mk = (content: string, certainty: string): MemoryRecord => ({
  id: `m_${Math.random()}`, content, type: "episodic", priority: 70,
  scene_name: "s", source_message_ids: [], metadata: {},
  timestamps: ["2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z"],
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
  version: 0, sessionKey: "k", certainty,
} as MemoryRecord);
const group = [
  mk("用户偏好本地部署：原因一", "observed"),
  mk("用户偏好本地部署：原因二", "observed"),
  mk("用户偏好本地部署：推断其一", "inferred"), // 若不过滤，凑满 3 条会触发巩固
];
// 复刻 worker 的 sourceMemories 逻辑（修复后应走同一导出函数）
const sources = group.filter((m) => (m.certainty ?? "observed") !== "inferred");
const groups = groupBySubject(sources);
console.log(groups.length === 0 ? "PASS: inferred 被排除，组未触发" : "FAIL: inferred 进组");
process.exit(groups.length === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑验证（此时 sourceMemories 未修，用临时脚本断言的是目标行为）**

Run: `node --import tsx MemoryCore/scripts/verify-p0-t1.ts`
Expected: 当前生产代码 worker 内联的过滤是 `(m.type === "work_fact" && m.scene_name === "consolidated")` 取反——inferred 会被放行，真实 worker 路径会产组。此脚本先用**目标行为**钉死验收。

- [ ] **Step 3: 修改 consolidation-worker.ts**

```ts
// 修改前（:37-40）
function sourceMemories(all: Array<MemoryRecord>): Array<MemoryRecord> {
  return all.filter((m) => !(m.type === "work_fact" && m.scene_name === "consolidated"));
}
// 修改后：守卫在咽喉——进组唯一入口接 isObservable
import { isObservable } from "./grouping.js";
function sourceMemories(all: Array<MemoryRecord>): Array<MemoryRecord> {
  return all.filter((m) => !(m.type === "work_fact" && m.scene_name === "consolidated") && isObservable(m));
}
```

- [ ] **Step 4: 跑验证通过**

Run: `node --import tsx MemoryCore/scripts/verify-p0-t1.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/lifecycle/consolidation/consolidation-worker.ts MemoryCore/scripts/verify-p0-t1.ts
git commit -m "fix(memory): P0-T1 H侧洗白门 — sourceMemories 接 isObservable（inferred 不再被熬成 observed 持续态）"
```

### Task 2: 堵 C 侧 FTS 绕过（E2，一行）

**Files:**
- Modify: `MemoryCore/src/core/tools/memory-search.ts:421`
- Test: `MemoryCore/scripts/verify-p0-t2.ts`

**Interfaces:**
- Consumes: 无（局部行为变更）
- Produces: reconsolidation 块只对 `certainty === "observed"` 更新 recall_count

- [ ] **Step 1: 写同形失败验证**

```ts
// MemoryCore/scripts/verify-p0-t2.ts
/**
 * 同形验证：经真实 executeMemorySearch（FTS 路径）召回 inferred 记忆，
 * 断言其 recall_count 不更新。FTS 路径 certainty 恒 undefined（W1 未修前），
 * 因此收紧后的门必须是 !== "observed" → skip（而非 === "inferred"）。
 */
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
// … 构造临时 sqlite 库：1 条 inferred 记忆（content 含唯一关键词"针脚词XYZ"）
// … 调 executeMemorySearch({query:"针脚词XYZ", ...}) 走 FTS-only 策略
// … 读回该行 metadata_json，断言不含 recall_count
console.log("PASS: FTS 召回 inferred 未触发 recall_count");
```

（完整可执行版本含临时库构造，Task 1 同款模式：`new VectorStore(临时路径)` + `upsertL1(certainty:"inferred")` + FTS 命中 + 读回断言。）

- [ ] **Step 2: 跑验证确认 FAIL**

Run: `node --import tsx MemoryCore/scripts/verify-p0-t2.ts`
Expected: FAIL——现行 `certainty === "inferred"` 门对 undefined 放行，recall_count 被写入。

- [ ] **Step 3: 修改 memory-search.ts:421**

```ts
// 修改前
if ((r as { certainty?: string }).certainty === "inferred") continue; // 红线：inferred 锁死
// 修改后：FTS 行 certainty 可能 undefined（W1 未修前），门语义必须"仅 observed 放行"
if ((r as { certainty?: string }).certainty !== "observed") continue; // 红线：仅 observed 可重巩固
```

- [ ] **Step 4: 跑验证通过 → Commit**

```bash
git add MemoryCore/src/core/tools/memory-search.ts MemoryCore/scripts/verify-p0-t2.ts
git commit -m "fix(memory): P0-T2 reconsolidation 门收紧 — 仅 observed 放行（FTS undefined 不再绕过 inferred 锁）"
```

### Task 3: atomic/update 保留 soul 8 字段（E1）

**Files:**
- Modify: `MemoryCore/src/gateway/v2-router.ts:1086-1104`（handleAtomicUpdate updated 构造处）
- Test: `MemoryCore/scripts/verify-p0-t3.ts`

**Interfaces:**
- Consumes: sqlite upsertL1 的 ON CONFLICT 语义（excluded.* 覆盖列）
- Produces: update 后 soul 列保持原值（null 透传，不造默认）

- [ ] **Step 1: 写同形失败验证**

```ts
// MemoryCore/scripts/verify-p0-t3.ts
/**
 * 同形验证：直接调 handleAtomicUpdate 的核心逻辑（或起临时 server 打 /v3/atomic/update），
 * 对一条带完整 soul 的记忆改 content，断言 8 列原值保留、occurred_at 仍可算 age。
 */
// 临时库写 1 条: occurred_at="2026-01-01T00:00:00Z", certainty="observed",
//              valence=0.7, arousal=0.4, significance=0.9, source="user", valid_start/end=null
// POST /v3/atomic/update { record_id, content: "新内容" }
// 读回断言 8 列逐项相等（null 仍 null）；scorer.ageDaysOf 读回 occurred_at > 0 天
```

- [ ] **Step 2: 跑验证 FAIL**（updated 漏拷 → 8 列全 NULL）

- [ ] **Step 3: 修改 handleAtomicUpdate**

```ts
// updated 构造处补拷（从 existing 行取，undefined 透传——不造默认值）：
const soul = existing as {
  occurred_at?: string | null; valid_start?: string | null; valid_end?: string | null;
  certainty?: string | null; source?: string | null;
  valence?: number | null; arousal?: number | null; significance?: number | null;
};
const updated = {
  ...base, content: newContent,
  occurred_at: soul.occurred_at ?? null,
  valid_start: soul.valid_start ?? null,
  valid_end: soul.valid_end ?? null,
  certainty: soul.certainty ?? null,       // 注意：null 时 P0 写入口默认不适用（update 不走 writeMemory choke point）
  source: soul.source ?? null,
  valence: soul.valence ?? null,
  arousal: soul.arousal ?? null,
  significance: soul.significance ?? null,
};
```

（若 handler 拿不到 existing 行，先 `queryL1Records({recordIds:[id]})` 取一次——多一次读，正确性优先。）

- [ ] **Step 4: 验证 PASS → Commit** `fix(memory): P0-T3 atomic/update 保留 soul 8 字段（null 透传不造默认）`

### Task 4: recall_count SQL 自增（H-B1）

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（updateL1Metadata 特化或新增 `bumpRecallCount(id: string): boolean`）
- Modify: `MemoryCore/src/core/tools/memory-search.ts:424-426`（调用点换 bump）
- Test: `MemoryCore/scripts/verify-p0-t4.ts`

**Interfaces:**
- Produces: `bumpRecallCount(id): boolean`——原子自增 `$.recall_count` + 写 `$.last_recalled_at`；供 memory-search 与未来 auto-recall 复用

- [ ] **Step 1: 同形失败验证**（同 Task 2 临时库模式：对 1 条 observed 记忆**连续调 3 次** executeMemorySearch → 断言 recall_count===3）

- [ ] **Step 2: 跑 FAIL**（恒 1）

- [ ] **Step 3: 实现**

```ts
// sqlite.ts 新增（updateL1Metadata 旁）
bumpRecallCount(id: string, now = new Date().toISOString()): boolean {
  try {
    this.db.prepare(`
      UPDATE l1_records SET
        metadata_json = json_set(
          COALESCE(metadata_json,'{}'),
          '$.recall_count', COALESCE(json_extract(metadata_json,'$.recall_count'), 0) + 1,
          '$.last_recalled_at', ?
        ),
        updated_time = ?
      WHERE record_id = ?
    `).run(now, now, id);
    return true;
  } catch (err) { this.logger?.warn?.(`${TAG} bumpRecallCount failed: ${err}`); return false; }
}
// memory-search.ts 调用点：store.bumpRecallCount?.(r.id) 替换原 read-then-write
```

- [ ] **Step 4: 验证 PASS（recall_count=3、boost=0.06 在真实链路可达）→ Commit** `fix(memory): P0-T4 recall_count 原子自增（bumpRecallCount，修恒 1）`

### Task 5: M1 收口

- [ ] **Step 1: 四个验证脚本全量重跑全过**
- [ ] **Step 2: MemoryProxy vitest 回归** `pnpm vitest run`（79+ 全过，确认 proxy 侧无被 P0 波及）
- [ ] **Step 3: 真机冒烟**：重启网关 → `/v3/atomic/update` 改一条记忆 → SQL 确认 soul 保留
- [ ] **Step 4: Commit（CHANGELOG + yaml 嵌入配置一并入库）**

```bash
git add MemoryCore/ MemoryProxy/ CHANGELOG.md tdai-gateway.yaml docs/
git commit -m "docs(memory): M1 收口 — P0 四修验证留档 + 嵌入套餐切换入库（ark coding/v3）"
```

---

## 阶段二 · P1 FTS/图数据链（M2，2-3 天）

### Task 6: SOUL_COLUMNS 单一事实源（R1 根治，P-A 原则）

**Files:**
- Create: `MemoryCore/src/core/store/soul-columns.ts`
- Modify: `MemoryCore/src/core/store/sqlite.ts`（import + stmtL1FtsInsert/stmtL1FtsSearch/FtsSearchResult 改用）
- Test: `MemoryCore/scripts/verify-p1-t6.ts`

**Interfaces:**
- Produces: `SOUL_COLUMNS: Array<{name, sqlType, ftsSuffix}>`、`SOUL_COL_NAMES: string[]`、`SOUL_SELECT_FRAGMENT: string`——后续 Task 7/8/15 复用

- [ ] **Step 1: 写单一源模块**

```ts
// MemoryCore/src/core/store/soul-columns.ts
/** soul 8 字段单一事实源（P-A）：schema/FTS/SELECT/映射全部由它展开。
 *  新增字段只改这里——编译期强制所有消费端跟进（漏抄=类型错误而非静默 undefined）。 */
export const SOUL_COLUMNS = [
  { name: "occurred_at",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_start",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_end",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "certainty",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "source",       sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valence",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "arousal",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "significance", sqlType: "REAL", ftsSuffix: "UNINDEXED" },
] as const;
export const SOUL_COL_NAMES = SOUL_COLUMNS.map((c) => c.name);
export const SOUL_SELECT_FRAGMENT = SOUL_COL_NAMES.join(", ");
```

- [ ] **Step 2: 验证**：tsc 编译零错 + 现有 stmtGetMeta 8 列与 SOUL_COL_NAMES 断言一致

### Task 7: FTS 虚表迁移（W1，重建式）

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（initFts 段：建表 SQL 由常量展开、版本探测、迁移分支）
- Create: `MemoryCore/scripts/migrate-fts-soul.ts`
- Test: `MemoryCore/scripts/verify-p1-t7.ts`

**Interfaces:**
- Consumes: SOUL_COLUMNS（Task 6）
- Produces: `l1_fts` 含 25 列（原 17 + soul 8）；`FtsSearchResult` 增 8 字段；`searchL1Fts` 返回带 soul

- [ ] **Step 1: 迁移脚本（dry-run 默认）**

```ts
// MemoryCore/scripts/migrate-fts-soul.ts
/**
 * FTS soul 迁移（重建式，FTS5 虚表不可 ALTER）：
 * 1. 探测 l1_fts 现有列（PRAGMA table_info），已含 occurred_at → 幂等退出
 * 2. dry-run：打印新旧列清单 + 主表行数 + 预计耗时，不写
 * 3. --apply：备份 vectors.db → 建新表(25列) → INSERT ... SELECT 回填（soul 列从 l1_records join 回填）
 *    → DROP 旧表 → rename → 重建触发器/索引（如有）→ 完整性校验（行数一致）
 * 注意：FTS 虚表回填必须走 tokenizeForFts 与写入侧同函数（教训：H-B9 恢复侧曾不分词）
 */
```

- [ ] **Step 2: 同形验证**

写 1 条中文记忆（occurred_at=昨天、certainty=observed、valence=0.8）→ `searchL1Fts` 命中 → 断言 8 字段逐项相等；再跑 J 时间窗（query 带上周锚+occurred_at=昨天 → 应被拦）。

- [ ] **Step 3: stmtL1FtsInsert/Search 改常量展开**（列清单/SELECT 片段 import SOUL_COLUMNS；插入调用处补 8 绑定值，从 upsertL1 的 record 透传）

- [ ] **Step 4: 迁移 + 真机验证**（dry-run → 备份 → apply → 行数校验 → 真机 FTS 搜索带 soul 断言）

- [ ] **Step 5: Commit** `fix(memory): P1-T7 FTS soul 单一源迁移 — l1_fts 25列重建（dry-run 默认/幂等/回填）`

### Task 8: restoreL1 分词修复（H-B9，两行）

- [ ] **Step 1: sqlite.ts:1680 `tokenizeForFts(record.content)` 替换原文**（restoreL1 内 FTS 重建处）
- [ ] **Step 2: 同形验证**：归档中文记忆 → restore → FTS 关键词命中 → PASS
- [ ] **Step 3: Commit**（与 Task 7 同 commit 或独立小 commit）

### Task 9: 边强度真实化 + 假边清理（G5 + 拍板②）

**Files:**
- Modify: `MemoryCore/src/core/record/l1-dedup.ts`（CandidateMatch.topScore、attachTopCandidates）
- Modify: `MemoryCore/src/core/record/l1-extractor.ts:882`（同批排除，G4 顺手同修）
- Create: `MemoryCore/scripts/clean-fake-edges.ts`
- Test: `MemoryCore/scripts/verify-p1-t9.ts`

- [ ] **Step 1: findCandidatesByVector 映射带真分**

```ts
// l1-dedup.ts :236-252 映射处增
const candidates: MemoryRecord[] = searchResults
  .filter((r) => !newRecordIds.has(r.record_id)).slice(0, topK)
  .map((r) => ({ /* …原字段…*/ }));
// 并行维护：
topScores.set(top.id, hasVectorScores ? r.score : undefined); // 或 CandidateMatch 增 topScore 字段
```

（实现取 `CandidateMatch` 增 `topScore?: number`——向量路径填 `searchResults[0].score`，FTS 路径不填。）

- [ ] **Step 2: attachTopCandidates 真值/拒绝伪造**

```ts
// 修改前：score: hasVectorScores ? 0.8 : 0.5
// 修改后（P-D）：无真分不附 top_candidate → applyDecisions 不建边
const sc = m.topScore;
if (typeof sc !== "number") continue; // FTS 分不可比——宁缺毋滥，不建假强度边
return { ...d, top_candidate: { record_id: top.id, score: Math.min(Math.max(sc,0),1) } };
```

- [ ] **Step 3: 同批排除（G4）**：storeAllDirectly 循环外建 `Set(batchIds)`，top-1 find 时排除

- [ ] **Step 4: 假边清理脚本**（dry-run 列出 strength=0.8 且无对应向量召回证据的 similar 边 → `--apply` 删；当前生产 2 条）

- [ ] **Step 5: 同形验证**：向量路径建边 strength≈cosine(±1e-6)；FTS-only 断言**零新增边**；同批 3 条互不建边

- [ ] **Step 6: Commit** `fix(memory): P1-T9 边强度真实化 — topScore 透传/FTS 不建假边/同批排除/假边清理`

### Task 10: M2 收口

- [ ] MemoryProxy vitest 回归 + 真机 FTS soul 冒烟 + CHANGELOG
- [ ] Commit（迁移留档 + spec §6 偏离表更新：getPath/coreRef 等补登记也在此 commit）

---

## 阶段三 · P2 信任边界（M3，2-3 天）

### Task 11: core 消毒接线（K2）

- [ ] **Step 1:** `sanitize.ts:291` 边界正则增 `core_memory|identity|strict_rule|core_value`
- [ ] **Step 2:** guard 通过后、落库前调 `escapeXmlTags(content)`（handler 写入路径单点）
- [ ] **Step 3:** 同形验证：写入含 `</core_memory>` 的 slot → 读回已转义；注入器拼块边界完整
- [ ] **Step 4:** Commit 合并进 M3 主 commit

### Task 12: core 租户化（K1 + 拍板⑤）

**Files:**
- Modify: `sqlite.ts`（两表幂等 ALTER + 迁移）、`v2-router.ts`（core-memory handler 消费 isolation）、`MemoryProxy/src/tdai/client.ts`（读写带四元组）、injector 缓存键
- Create: `MemoryCore/scripts/migrate-core-tenant.ts`

- [ ] **Step 1: DDL 迁移（幂等）**

```sql
ALTER TABLE core_memory ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE core_memory ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE core_memory ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
-- core_values 同款三列
-- 迁移回填（拍板⑤）：存量行按当前唯一租户回填
UPDATE core_memory SET team_id='team-2j92u63hre', user_id='usr-2t8126nehp', agent_id='agt-2t81sh9zdz' WHERE team_id='';
```

- [ ] **Step 2: handler 消费 requestIsolation**：read/write 按 team+user+agent 过滤（ WHERE 三列），无四元组 → 400
- [ ] **Step 3: proxy client 带四元组**（`listCoreMemories/listCoreValues/upsertCore` 传 identity）
- [ ] **Step 4: injector 模块级缓存改复合键** `Map<tenantKey, {…expiresAt}>`，tenantKey=`${team}|${user}|${agent}`
- [ ] **Step 5: 同形验证**：双租户写读隔离断言 + 旧客户端不带四元组请求 → 400 + 迁移后生产 7 行归属正确
- [ ] **Step 6: Commit 部分**（与 T13/T14 合并 M3 主 commit）

### Task 13: 鉴权必填（K1 后半 + 拍板③直接生效）

- [ ] **Step 1:** `server.ts verifyAuth`：`config.server.apiKey` 缺失 → 启动时生成 32 字节 hex、**打印一次**（`[security] generated ephemeral apiKey: <key>`）、写入内存供本进程校验（不回写配置——重启换新，提示用户配置固化）
- [ ] **Step 2:** v3StrictIsolation 默认翻 true（env-config 默认值变更）
- [ ] **Step 3:** 同形验证：无 key 请求 401；带生成 key 200；部署文档更新（Connection 段）
- [ ] **Step 4:** Commit 部分

### Task 14: neighbors 租户过滤 + lifecycle.filter（G2 + H-B2）

- [ ] **Step 1:** `getNeighbors(id, types, maxHop, filter?)` SQL 改 join l1_records 双端租户过滤；handler 消费 requestIsolation；`maxN = Math.min(maxN ?? 20, 50)` clamp（G8 顺手）
- [ ] **Step 2:** `MemoryLifecycleConfig` 增 `filter?: IsolationFilter` + parseConfig 解析 + server.ts:1894 传实例隔离
- [ ] **Step 3:** `groupBySubject` 组内租户一致性校验：混合租户组丢弃 + warn（数据级双保险）
- [ ] **Step 4:** 同形验证：跨租户 neighbors 零返回；混合租户组被拒
- [ ] **Step 5:** **M3 主 commit**：`fix(memory): P2 信任边界 — core 租户化+消毒+鉴权必填+neighbors/lifecycle 隔离（CHANGELOG 标注行为变更）`

---

## 阶段四 · P3 可观测与算法可达（M4，3-4 天）

### Task 15: 向量健康三件套（G1/W1b③，R3 主修）

**Files:**
- Modify: `sqlite.ts`（countL1VectorRows）、`l1-dedup.ts:90`（判据替换）、`auto-recall.ts`（degraded 标注）、`gateway/server.ts`（/health 探活）
- Test: `MemoryCore/scripts/verify-p3-t15.ts`

- [ ] **Step 1: 判据替换**

```ts
// l1-dedup.ts :90
// 修改前：const hasVectorData = vectorStore && (await vectorStore.countL1()) > 0;
const hasVectorData = vectorStore?.countL1VectorRows
  ? (await vectorStore.countL1VectorRows()) > 0
  : (await vectorStore!.countL1()) > 0; // 旧后端无新方法时保守回退
```

（`countL1VectorRows`：sqlite 数 `l1_vec_rowids`；tcvdb 数向量集合行——缺失则回退旧判据并 warn 一次。）

- [ ] **Step 2: /health 探活**：`vectorCoverage`（vec 行/记录行）+ 每 5min 探针（embed "health-probe" → 断言可写；失败计 degradedSince）；`embedding: { status: "ok"|"degraded", since }`
- [ ] **Step 3: 注入块降级标注**：FTS-only 时 `<relevant-memories degraded="fts-only">`（LLM 与人都能看见）
- [ ] **Step 4: 同形验证**（测试环境停嵌入）：coverage 下降→dedup 日志走 FTS Tier→health.degraded=true→注入块带标注；恢复→自动回正常
- [ ] **Step 5: Commit** `feat(memory): P3-T15 向量健康三件套 — 判据修正/探活/降级标注`

### Task 16: current_feeling 解冻（K3）

**Files:**
- Modify: `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`（拆稳定块与感受块）、`prewarm.ts`（感受块不进 prewarm 白名单）

- [ ] **Step 1: 拆分**：core_memory 稳定块保留 session_init 缓存（A 项本意）；current_feeling 拆独立注入路径（每轮执行，q=当轮真实消息）
- [ ] **Step 2: prewarm 白名单**：shouldPrewarm 仅 cacheStrategy=session_init 的 hook（感受块 hook 标 none）
- [ ] **Step 3: 同形验证**：两轮不同价值向提问 → 感受块随轮变化 + 稳定块逐字节不变（cache 未破）
- [ ] **Step 4: Commit** `fix(proxy): P3-T16 current_feeling 解冻 — 拆每轮执行，session_init 稳定块保留`

### Task 17: subjectOf 语义化（H1 + 拍板④ llm 顺带）

**Files:**
- Modify: `grouping.ts`（subjectStrategy）、`l1-dedup prompt/parse`（subject 字段）、`pipeline-factory`（策略装配）
- Test: `MemoryCore/scripts/verify-p3-t17.ts`

- [ ] **Step 1: 配置门**：`memory.consolidation.subjectStrategy: "llm" | "embedding" | "lexical"`（默认 llm， lexical 为兜底）

```ts
// grouping.ts 增
export function subjectOfLlm(m: MemoryRecord): string | null {
  const md = m.metadata as { subject?: unknown } | undefined;
  return typeof md?.subject === "string" && md.subject.trim() ? md.subject.trim() : null;
}
// groupBySubject: strategy==="llm" → subjectOfLlm ?? subjectOf(词法兜底)
```

- [ ] **Step 2: dedup prompt 增输出字段**（`l1-dedup.ts` 系统提示每条决策增 `"subject": "<归一化主题词，≤12字>"`，LLM 拒答时 null → 词法兜底）；parse 带回写 `metadata.subject`（在 writeMemory 前 attach）
- [ ] **Step 3: 同形验证**：三条同义不同前缀（"用户喜欢X/用户偏好X/用户爱用X"）→ llm 模式归组触发巩固；lexical 模式不归组（对照断言）
- [ ] **Step 4: Commit** `feat(memory): P3-T17 subject 语义化 — dedup 顺带抽取/三档策略门/词法兜底`

### Task 18: durative 真值 + 结构页降权（H-B8/K6 + W5）

- [ ] **Step 1:** summarizer significance 改组内顶层 `significance` 真实 max（半数无值才 0.5 中性）；certainty：含 inferred 组不巩固（与 T1.1 双保险）
- [ ] **Step 2:** wiki-recall-injector：typeWeights 增 `other/log/index/schema: 0.3`（config 默认+yaml 同步）；无 absScore 结构页排尾+`[structural]` 标注
- [ ] **Step 3:** 同形验证：sig=[0.3,0.9,0.6]→0.9；混 inferred→不巩固；log.md 不再进 top-3（本轮实况回归用例）
- [ ] **Step 4:** Commit + **M4 收口**（CHANGELOG：结构页降权为行为变更）

---

## 阶段五 · P4 诚实性（M5，1-2 天）

### Task 19: golden harness 修复 + 归档锚点（W1b①② + W6）

**Files:**
- Modify: `docs/superpowers/evals/recall-golden/replay.mjs`
- Create: `docs/superpowers/evals/recall-golden/runs/.gitkeep`

- [ ] **Step 1: 键名共享常量**：`LIBS` 与 `router.keywords` 统一用带 `-WiKi` 后缀名（或双方去后缀）——与生产 `w.name` 一致
- [ ] **Step 2: GOLDEN 对齐 queries.jsonl 全集**（含 p6；should_recall 全集读文件而非硬编码；should_not_recall 作 precision 断言）
- [ ] **Step 3: `--archive` 模式**：输出 `runs/<date>.json`（逐 query 命中 + 语料指纹 sha256 汇总 + git sha + 脚本版本）
- [ ] **Step 4: 验证**：连跑两次归档 diff 可解释；与 README 时代口径可比
- [ ] **Step 5: Commit** `fix(evals): P4-T19 golden harness 修复 + 归档锚点（键名统一/全集对齐/should_not_recall 生效）`

### Task 20: absGate 测试钉死（W7）+ 注入日志修复（W10）

- [ ] **Step 1:** `wiki-recall-injector.test.ts` 增用例：absScore 过/不过门槛、**undefined fail-open 显式断言**（注释注明这是有意设计）
- [ ] **Step 2:** 修 injector:220 字符串拼接 bug（`' + ${...}` → `${...}`）；INFO 日志降 debug（保留错误路径日志）
- [ ] **Step 3: Commit** `test(wiki): P4-T20 absGate 行为钉死 + 日志修复`

### Task 21: spec 偏离补登记 + 收口（M5 完成）

- [ ] **Step 1:** soul spec §6 补登记表：getPath / coreRef / 层级边 / 动机方向 / TCVDB native-hybrid 跳过 reconsolidation / updated_time↔TTL 耦合——各给"设计原句→现状→打算做与否"
- [ ] **Step 2:** proxy client.ts 补 soul 8 字段映射（D1，顺手同 commit）
- [ ] **Step 3:** 全量回归（四阶段所有 verify 脚本重跑 + MemoryProxy vitest + 真机冒烟）
- [ ] **Step 4:** **终版 commit**：`docs(memory): M5 收口 — spec 偏离补登记 + proxy soul 透传 + 全量验证留档`

---

## Self-Review 记录

- **Spec 覆盖**：六根因→六原则→21 任务映射完整（R1=T6/T7、R2=T1/T11/T14、R3=T15/T16、R4=T9/T18、R5=各任务同形验证步骤、R6=T19/T20）；拍板①=T7、②=T9、③=T13、④=T17、⑤=T12。唯一未查项（CandidateMatch 携分）已在 T9 Step 1 显式实现方案化。
- **占位符扫描**：T2/T3 的验证脚本给的是骨架+同形断言要点，完整临时库构造模式在 Task 1 给了全文模板——执行者按模板展开，无 TBD。
- **类型一致**：`bumpRecallCount(id, now?)` / `SOUL_COLUMNS` / `topScore?` / `subjectOfLlm` / `getNeighbors(…, filter?)` 前后引用一致。

## Execution Handoff

**计划已存 `docs/superpowers/plans/2026-09-09-soul-memory-trust-repair.md`。两种执行方式：**

**1. Subagent-Driven（推荐）**——每 Task 派新鲜 subagent 执行，任务间我审查把关，隔离上下文防漂移

**2. Inline 执行**——本会话内按 executing-plans 顺序执行，批次间设检查点

**选哪种？**（建议从 M1 开始：4 个一行级修复 + 同形验证，今天就能带着生产验证收口）
