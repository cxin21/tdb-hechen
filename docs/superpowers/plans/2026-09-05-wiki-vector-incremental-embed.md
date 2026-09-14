# wiki 向量增量重嵌 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `writeVectors` 从"每次 ingest/sync 全量重嵌全部 wiki 页"改为"全量对账 + 仅对变更/缺向量页 embed"，降低 embedding API 调用量与配额消耗，同时保留 spec §5.1 的切片增删零孤儿一致性锚点。

**Architecture:** 给 `wiki_vec` 表增加 `content_sha` 指纹列；重构 `writeVectors` 为「读当前 (page_id,content_sha) → 逐页比对：sha 相同且有向量则复用、否则重嵌 → 末尾 `NOT IN pages` 清理孤儿」。因 sqlite-vec 的 vec0 不支持 `ALTER TABLE ADD COLUMN`（spike 已证：`virtual tables may not be altered`），加列通过 `ensureWikiVecTable` 检测缺列时 `DROP TABLE wiki_vec` 重建实现。

**Tech Stack:** MemoryKnowledge（Node 22 + better-sqlite3 + sqlite-vec）；sha256 用 node:crypto（内置）；vitest 测试。

**Spec:** [2026-09-05-wiki-vector-incremental-embed-design.md](../specs/2026-09-05-wiki-vector-incremental-embed-design.md)

## Global Constraints

- **不改动已审查通过的向量化检索/建表/embedding 客户端核心逻辑**；只改 `writeVectors`（manager.ts）与 `ensureWikiVecTable`（index-db.ts）+ 新增 sha 工具函数。
- **保持一致性锚点**：每次仍基于 `pages = scanWikiDir()` 全量集合；删页由 writeVectors 末尾 `NOT IN pages` 清理；不牺牲零孤儿。
- **复用条件**：`content_sha == 当前 sha` **且** 该 `page_id` 行已存在（有向量）才复用；缺任一 → 重新 embed（覆盖"整个没向量化/新增文件没向量/曾失败"场景）。
- **spike 已证（实现依据）**：vec0 表支持建表时带附加非向量列（`content_sha TEXT DEFAULT ''`）；但**不支持** `ALTER TABLE ... ADD COLUMN`（`virtual tables may not be altered`）——加列必须走 `DROP TABLE wiki_vec` 重建。
- 跨平台无新增假设（sha256 纯计算）。
- 测试沿用现有 vitest + mock embed（`tests/rrf-hop-search.test.ts` 的 mock 模式）。

---

### Task 1: ensureWikiVecTable 加 content_sha 列（建表重建）

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/index-db.ts`（`ensureWikiVecTable`，L146-163）

**Interfaces:**
- Produces: `wiki_vec` 表 DDL 含 `content_sha TEXT DEFAULT ''`；对已有缺列库 DROP 重建（检测 `sqlite_master.sql` 是否含 `content_sha`）。

- [ ] **Step 1: 加"缺 content_sha 则 DROP 重建"判断**

改 `ensureWikiVecTable`：在维度判断之外，加对 `existing.sql` 是否含 `content_sha` 的检测；任一不匹配 → DROP。DDL 加 `content_sha TEXT DEFAULT ''`。最终形如：
```ts
function ensureWikiVecTable(db: Database.Database, dimensions: number): void {
  try {
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_vec'")
      .get() as { sql: string } | undefined;
    const existingDim = existing?.sql ? /float\[(\d+)\]/.exec(existing.sql)?.[1] : undefined;
    const hasSha = existing?.sql ? /content_sha/.test(existing.sql) : false;
    if (existing && (existingDim !== String(dimensions) || !hasSha)) {
      db.exec("DROP TABLE wiki_vec");
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
      page_id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine,
      updated_time TEXT DEFAULT '',
      content_sha TEXT DEFAULT ''
    )`);
  } catch {
    /* 降级纯 FTS，不建向量表 */
  }
}
```

- [ ] **Step 2: 跑现有测试确认不回归**

Run: `pnpm -C MemoryKnowledge test -- index-db-vec`
Expected: PASS（现有测试仍过，含建表/维度重建）

- [ ] **Step 3: 写"缺列重建"测试**

在 `tests/index-db-vec.test.ts` 加用例：手动建无 content_sha 的 wiki_vec（旧 schema），调 `ensureWikiVecTable`（通过重建路径）后，确认 `sqlite_master.sql` 含 `content_sha`。

- [ ] **Step 4: run & commit**

Run: `pnpm -C MemoryKnowledge test -- index-db-vec` → PASS；`npx tsc --noEmit` → 0 error
```bash
git add MemoryKnowledge/src/engines/wiki/index-db.ts MemoryKnowledge/tests/index-db-vec.test.ts
git commit -m "feat(knowledge): add content_sha column to wiki_vec via DROP-rebuild (vector incremental)"
```

---

### Task 2: 新增 content sha256 工具函数

**Files:**
- Create: `MemoryKnowledge/src/engines/wiki/content-sha.ts`
- Test: `MemoryKnowledge/tests/content-sha.test.ts`

**Interfaces:**
- Produces: `export function contentSha256(content: string): string` — 返回 sha256 hex；空串返回空串。

- [ ] **Step 1: 写工具函数**

```ts
import { createHash } from "node:crypto";
/** 页面 content 的 sha256 指纹。空 content → 空串。 */
export function contentSha256(content: string): string {
  if (!content) return "";
  return createHash("sha256").update(content, "utf8").digest("hex");
}
```

- [ ] **Step 2: 写单测**

`tests/content-sha.test.ts`:
```ts
import { test, expect } from "vitest";
import { contentSha256 } from "../src/engines/wiki/content-sha.js";
test("same content same hash", () => {
  expect(contentSha256("abc")).toBe(contentSha256("abc"));
});
test("different content different hash", () => {
  expect(contentSha256("abc")).not.toBe(contentSha256("abd"));
});
test("empty content -> empty string", () => {
  expect(contentSha256("")).toBe("");
});
```

- [ ] **Step 3: run & commit**

Run: `pnpm -C MemoryKnowledge test -- content-sha` → PASS
```bash
git add MemoryKnowledge/src/engines/wiki/content-sha.ts MemoryKnowledge/tests/content-sha.test.ts
git commit -m "feat(knowledge): content sha256 fingerprint helper"
```

---

### Task 3: 重构 writeVectors 为增量对账

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/manager.ts`（`writeVectors` L911-934，`writeIndex` L438-452）
- Test: `MemoryKnowledge/tests/wiki-vector-incremental.test.ts`

**Interfaces:**
- Consumes: `contentSha256`（Task2），`wiki_vec` 含 `content_sha`（Task1）
- Produces: `writeVectors` 增量行为；`writeIndex` **不再** `DELETE FROM wiki_vec`（改由 writeVectors 对账 + 末尾清理）。

- [ ] **Step 1: writeIndex 移除 `DELETE FROM wiki_vec`**

`writeIndex`（L438）删掉：
```ts
// 向量表：整体重建清空…（删除此 DELETE FROM wiki_vec）
try { db.prepare("DELETE FROM wiki_vec").run(); } catch { /* ... */ }
```
（向量对账与清理全权移交 writeVectors。）

- [ ] **Step 2: 重构 writeVectors**

把 `writeVectors` 从"直接逐页 embed"改为"读-比-写 + 末尾清理"：
```ts
async function writeVectors(projectPath: string, pages: WikiPage[]): Promise<void> {
  if (!embeddingClient) return; // 未启用 → 纯 FTS
  try {
    await withWriteAsync(projectPath, async (db) => {
      const has = db
        .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='wiki_vec'")
        .get() as { c: number };
      if (!has || !has.c) return;
      // 读当前 (page_id, content_sha)，用于增量复用判断
      const existing = new Map<string, string>();
      for (const r of db.prepare("SELECT page_id, content_sha FROM wiki_vec").all() as any[]) {
        if (r.page_id !== null && r.page_id !== undefined) existing.set(String(r.page_id), String(r.content_sha ?? ""));
      }
      const delVec = db.prepare("DELETE FROM wiki_vec WHERE page_id = ?");
      const insVec = db.prepare(
        "INSERT INTO wiki_vec(page_id, embedding, updated_time, content_sha) VALUES (?,?,?,?)",
      );
      const ids = new Set<string>();
      for (const p of pages) {
        ids.add(p.id);
        const sha = contentSha256(p.content);
        if (existing.has(p.id) && existing.get(p.id) === sha) continue; // 未变且有向量 → 复用，跳过 embed
        try {
          const vec = await embeddingClient.embed(p.content);
          // ⚠️ vec0 虚拟表**不支持** `INSERT OR REPLACE`（对已存在 page_id 抛 UNIQUE 冲突，
          //    spike + REPL 实证）。刷新变更页必须先 DELETE 再 INSERT。
          delVec.run(p.id);
          insVec.run(p.id, Buffer.from(vec.buffer), new Date().toISOString(), sha);
        } catch {
          // 单页 embed 失败 → 跳过该页，仍走 FTS
        }
      }
      // 末尾清理孤儿：删除不在当前页集合内的旧向量
      if (existing.size > 0) {
        for (const pid of existing.keys()) {
          if (!ids.has(pid)) db.prepare("DELETE FROM wiki_vec WHERE page_id = ?").run(pid);
        }
      }
    });
  } catch {
    // 连接/schema 异常 → 静默降级纯 FTS
  }
}
```

- [ ] **Step 3: 写增量行为测试（含删除一致性）**

`tests/wiki-vector-incremental.test.ts`（mock embed 计数）：
```ts
import { test, expect } from "vitest";
// mock embed（沿用 rrf-hop-search 的本地 mock 模式）：记录每页 embed 调用。
// 前置：注册两页 → wiki_vec 有 2 行（2 次 embed）。

test("unchanged pages skip embed on second run (复用)", async () => {
  // run1 两页各 embed 1 次（count=2）
  // 再次 writeVectors 同内容 → 0 次新 embed（count 仍=2）
  expect(embedCount).toBe(2);
});

test("changed page re-embeds, others reuse (变更)", async () => {
  // 改 pageA 内容 → writeVectors → 仅 pageA 重新 embed（count 从 2 → 3）
  expect(embedCount).toBe(3);
});

test("deleted page vector cleaned up (删页零孤儿)", async () => {
  // 删除 pageB（其磁盘 .md 已删，模拟 deleteSourceFiles/cascade 后 scanWikiDir 不再含它）
  // 以仅含 pageA 的 pages 集合调 writeVectors → 末尾清理
  // 断言：wiki_vec 只剩 pageA 一行；pageB 向量被删；embedCount 不变（未对已删页调 embed）
  const rows = allPageIds();
  expect(rows).toEqual(["pageA"]);
  expect(embedCount).toBe(3); // 未触新增 embed
});

test("brand-new page embeds (新增)", async () => {
  // 新增 pageC 进 pages → writeVectors → pageC embed（count → 4）
  expect(embedCount).toBe(4);
});
```
> 说明：删除用例如实覆盖"git 拉取后源文件删除 / UI 删原文件(page/rm+raw/rm) 最终扫描集合不含该页"的场景——周围盘 .md 已被既有 cascade 删除，writeVectors 末尾 `NOT IN pages` 清理向量，且不误触发 embed。

- [ ] **Step 4: run 全量测试 + commit**

Run: `pnpm -C MemoryKnowledge test -- wiki-vector-incremental` + 回归 `pnpm -C MemoryKnowledge test`（全量）
Expected: 全部 PASS；`npx tsc --noEmit` EXIT=0
```bash
git add MemoryKnowledge/src/engines/wiki/manager.ts MemoryKnowledge/src/engines/wiki/content-sha.ts MemoryKnowledge/tests/wiki-vector-incremental.test.ts
git commit -m "feat(knowledge): incremental wiki vector embed (sha reuse + orphan cleanup)"
```

---

## Self-Review

**Spec 覆盖：**
- §4 数据模型加 content_sha + 迁移 → Task1（DROP 重建，因 ALTER 不可用）✓
- §5 writeVectors 增量逻辑（读-比-写+末尾清理）→ Task3 ✓
- §5 复用条件（sha 相同且有向量）→ Task3 Step2 的 `existing.has && equal` ✓
- §6.4 缺向量兜底（new/fail/clear）→ Task3 Step2（非复用分支 → 重嵌）✓
- §6 孤儿清理 → Task3 末尾 `NOT IN`-等价 `existing-not-in-pages` 清理 ✓
- §8 测试 → Task1/2/3 各带测试 ✓

**占位符/遗留：**
- 无 TBD/TODO。Task3 的删页清理是"读 existing → 不在 pages 则 DELETE"，明确且无占位。

**类型一致性：**
- `contentSha256(content): string` 在 Task2 定义、Task3 使用；`wiki_vec.content_sha` 在 Task1 建列、Task3 读写 —— 一致。
- `withWriteAsync/simple INSERT` 沿用现有签名。✓

**已知取舍（如实记录）：**
- 存量库首次因 `content_sha=''` 触发全量重嵌一次（one-time，spec §4 已认可）。
- `ensureWikiVecTable` 的 DROP 重建会丢弃旧向量（加列场景）→ 首次启用增量即重嵌，符合 spec。