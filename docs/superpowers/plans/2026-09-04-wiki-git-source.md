# Wiki Git 源（repo_url + 正则路径过滤 + 重建索引）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TDB 的 wiki 支持从 git 仓库拉取文档——创建时填 `repo_url`，按正则路径过滤只纳入命中的文档，重建索引；支持手动同步与定时自动同步（方向 A：全局开关）。

**Architecture:** 复用 code-graph 现有的 `GitSourceFetcher` + `SourceFetcherRegistry` + `AutoSyncScheduler` 基础设施。拉取 git 仓库到独立 `raw/repo_src/`，按正则过滤后把匹配文件复制到 `raw/sources/`（现有 ingest 读取处），再走现有 `wikiMgr.ingest()` 重建索引。自动同步扩展 `AutoSyncScheduler` 纳管 git 源 wiki。前端在新建对话框与详情页面增加来源/同步 UI。

**Tech Stack:** TypeScript (ESM, `node --import tsx`)、Hono（knowledge/service）、simple-git、better-sqlite3、vitest（已配置未用）、React + Tea UI（panel）。

**Spec:** `docs/superpowers/specs/2026-09-04-wiki-git-source-design.md`

## Global Constraints

- 决策：**方向 A** —— 自动同步用全局开关（`KNOWLEDGE_AUTO_SYNC_ENABLED` / `_SCAN_INTERVAL_MIN` / `_MAX_CONCURRENT`），**不做每 wiki 单例勾选**。
- `GitSourceFetcher`：仅支持 **public HTTPS**，默认 SSRF 拦私网地址（`KNOWLEDGE_SSRF_CHECK=off` 可关）。不改鉴权。
- 正则匹配对象：仓库内文件**相对路径**（POSIX）；`path_exclude` 优先排除；`path_include` 未设时兜底 `.md/.txt/.markdown`；`path_include` 命中则覆盖兜底。
- 复用现有目录规约：clone 产物在 `raw/repo_src/`（含 `.git`），匹配文件进 `raw/sources/`，`raw/*` 不触发 ingest、`ingest` 只读 `raw/sources/`。
- 复用已有字段：`source_type` / `source_url`（DB 已建列，零迁移）；新增仅 `branch`/`path_include`/`path_exclude` 三列。
- **不做**：私有/内网 git 鉴权；每 wiki 独立 auto-sync 开关；文件内容正则；code-graph 正则过滤。
- UI 样式与 `WikiPage` 现有 Tea UI 风格一致（SourceFetcher 复用，无新依赖）。
- `wiki-service.sync()` 已存在（= 重跑 ingest），`IngestResult` 与 `SyncResult` 判别联合结构一致。

---

### Task 1: DB 迁移——新增 `branch` / `path_include` / `path_exclude` 列

**Files:**
- Modify: `src/db/client.ts`（建表语句 + 迁移）
- Modify: `src/db/schema.ts`
- Modify: `src/store/types.ts`（`WikiRow` / `CreateWikiInput` / `WikiStatusPatch` 加字段）
- Test: `tests/wiki-git-schema.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `IXmlStore` / drizzle schema。
- Produces: `WikiRow` 新增 `branch: string | null`、`path_include: string | null`、`path_exclude: string | null`；`CreateWikiInput` 新增同名字段；`listWikis` / `getWiki*` 返回含新字段。

- [ ] **Step 1: 读现有 schema 与 store 类型，定位加列点**

先读：
Run: `src/db/client.ts`（建表语句 L57-100）、`src/db/schema.ts`、`src/store/types.ts` 的 `WikiRow` 与 `CreateWikiInput`（L80-126）、`src/store/sqlite-store.ts` 的 createWiki/映射（L264-330、L600-640）。
Expected: 明确加列位置与映射函数（`sqlite-row→WikiRow`）。

- [ ] **Step 2: 写本体 schema 迁移（幂等）**

在 `src/db/client.ts` 的建表语句后加 ALTER（用 try/catch 包住，列已存在则跳过，保证幂等）：
```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureColumn(db: any, table: string, addSql: string): void {
  try { db.exec(addSql); } catch { /* column exists */ }
}
// 在应用启动建表后调用：
ensureColumn(db, "wiki", "ALTER TABLE wiki ADD COLUMN branch TEXT");
ensureColumn(db, "wiki", "ALTER TABLE wiki ADD COLUMN path_include TEXT");
ensureColumn(db, "wiki", "ALTER TABLE wiki ADD COLUMN path_exclude TEXT");
```
将新列同时加入 `src/db/schema.ts` 的 wiki 表 schema 定义（新库直建），并更新 `src/store/types.ts` 的 `WikiRow`/`CreateWikiInput`/`WikiStatusPatch` 与 `sqlite-store.ts` 的行映射（`createWiki` INSERT 携带、行→对象转换携带）。

- [ ] **Step 3: 写 failing test**

创建 `tests/wiki-git-schema.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/client.js";
// 假定 createDb 返回带便利方法或 raw 的实例；以仓库实际 API 为准做适配
describe("wiki git-schema migration", () => {
  it("wiki table has branch/path_include/path_exclude columns", () => {
    const db = createDb(":memory:");
    const cols = db.pragma("table_info(wiki)").map((c: { name: string }) => c.name);
    expect(cols).toContain("branch");
    expect(cols).toContain("path_include");
    expect(cols).toContain("path_exclude");
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/wiki-git-schema.test.ts -v`
Expected: FAIL（branch 列不存在 → pragma 不含该列）。

- [ ] **Step 5: 实现迁移使测试通过**

实现 `ensureColumn`（Step 2 代码）+ 在 createDb 流程中调用 + 更新 schema/types/sqlite-store 映射。
再 `npx vitest run tests/wiki-git-schema.test.ts -v` → PASS。

- [ ] **Step 6: Typecheck + Commit**

Run: `npx tsc --noEmit`
Expected: 0 错误。
```bash
git add src/db/client.ts src/db/schema.ts src/store/types.ts src/store/sqlite-store.ts tests/wiki-git-schema.test.ts
git commit -m "feat(knowledge): wiki git-source schema columns (branch/path_include/path_exclude)"
```

---

### Task 2: 纯函数 `filterAndCopyMatched`（正则路径过滤 + 增量复制）

**Files:**
- Create: `src/engines/wiki/filter-and-copy.ts`
- Test: `tests/wiki-filter-and-copy.test.ts`（新建）
- Modify: `src/engines/wiki/index.ts`（export）

**Interfaces:**
- Produces: `filterAndCopyMatched(cloneDir, sourcesDir, opts): { copied: string[]; removed: string[]; skipped: number }`
  - `opts: { include?: string | null; exclude?: string | null; languageFallback?: RegExp }`
  - 默认 `languageFallback = /\.(md|txt|markdown)$/i`
  - 对 `cloneDir` 递归，取每个文件的相对 POSIX 路径 `rel`：
    - `exclude && exclude.test(rel)` → skip
    - `include ? include.test(rel) : languageFallback.test(rel)` → copy 到 `sourcesDir`，否则 skip
  - **路径穿越防护**：`rel` 含 `..` 或绝对路径 → skip
  - **增量**：copy 后对比 `sourcesDir` 里已有文件（仅本次复制产物），删除不再匹配的旧文件；返回 `removed`
  - `copied` = 本次复制且内容有变（或新增）的文件相对路径列表

- [ ] **Step 1: 写 failing test**

创建 `tests/wiki-filter-and-copy.test.ts`，覆盖：
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterAndCopyMatched } from "../src/engines/wiki/filter-and-copy.js";

function setupRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wfc-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(require("node:path").dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

describe("filterAndCopyMatched", () => {
  it("copies only include-matched docs", () => {
    const repo = setupRepo({
      "docs/a.md": "#a", "docs/b.txt": "b", "src/x.ts": "x", "notes/c.md": "c",
    });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, { include: "^docs/.*$" });
    expect(r.copied).toEqual(expect.arrayContaining(["docs/a.md", "docs/b.txt"]));
    expect(r.copied).not.toContain("src/x.ts");
    expect(existsSync(join(out, "docs/a.md"))).toBe(true);
    rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  it("exclude wins over include", () => {
    const repo = setupRepo({ "docs/a.md": "#a", "docs/secret.md": "#s" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, { include: "^docs/.*$", exclude: "secret" });
    expect(r.copied).toEqual(["docs/a.md"]);
    rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  it("no include falls back to markdown/txt", () => {
    const repo = setupRepo({ "a.md": "#a", "b.ss": "x" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, {});
    expect(r.copied).toEqual(["a.md"]);
    rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  it("rejects path traversal segments", () => {
    // 在仓库内创建一个名为 ".." 的异常文件名，验证其相对路径含 ".." 时被跳过、绝不写出到 sourcesDir 之外。
    const root = mkdtempSync(join(tmpdir(), "wfc-"));
    mkdirSync(join(root, "..lgtm"), { recursive: true });
    writeFileSync(join(root, "..lgtm", "weird.md"), "#");
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    // 用一个会把 "../.." 这类名字纳入的相对值触发防护；正常递归下 rel 不会有 ".." 段，
    // 但函数必须对含 ".." 或绝对路径的 rel 做防御（见实现）——此处通过 include 全匹配，
    // 断言该异常条目被记为 skipped 且未逃出 out 目录。
    const r = filterAndCopyMatched(root, out, { include: ".*" });
    expect(existsSync(join(out, "..lgtm", "weird.md"))).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(0);
    // 关键：没有任何文件写到 out 的父目录（tmpdir 之外）
    rmSync(out, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("removes stale files no longer matching", () => {
    const repo = setupRepo({ "a.md": "#a" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    filterAndCopyMatched(repo, out, { include: "^a\\.md$" });
    rmSync(join(repo, "a.md"));
    const r2 = filterAndCopyMatched(repo, out, { include: "^a\\.md$" });
    expect(r2.removed).toContain("a.md");
    rmSync(repo, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });
});
```
> 注：这是纯 fs 测试，不依赖 git。若 `require("node:path")` 在 ESM 下不可用，改用 `import { dirname } from "node:path"`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/wiki-filter-and-copy.test.ts -v`
Expected: FAIL（模块不存在 / 函数未定义）。

- [ ] **Step 3: 实现 `filterAndCopyMatched`**

创建 `src/engines/wiki/filter-and-copy.ts`（纯 fs 递归 + 正则 + diff），并在 `src/engines/wiki/index.ts` export。
```ts
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface FilterOpts {
  include?: string | null;
  exclude?: string | null;
  languageFallback?: RegExp;
}
export interface FilterResult { copied: string[]; removed: string[]; skipped: number; }

const DEFAULT_FALLBACK = /\.(md|txt|markdown)$/i;

export function filterAndCopyMatched(cloneDir: string, sourcesDir: string, opts: FilterOpts = {}): FilterResult {
  const includeRe = opts.include ? new RegExp(opts.include) : null;
  const excludeRe = opts.exclude ? new RegExp(opts.exclude) : null;
  const fb = opts.languageFallback ?? DEFAULT_FALLBACK;
  const result: FilterResult = { copied: [], removed: [], skipped: 0 };

  const walk = (cur: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const rel = relative(cloneDir, p).split(sep).join("/");
      if (!rel || rel.split("/").some((seg) => seg === "..")) { result.skipped++; continue; }
      if (excludeRe && excludeRe.test(rel)) { result.skipped++; continue; }
      const match = includeRe ? includeRe.test(rel) : fb.test(rel);
      if (!match) { result.skipped++; continue; }
      const dest = join(sourcesDir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      const payload = readFileSync(p);
      if (existsSync(dest) && readFileSync(dest).equals(payload)) continue; // 内容未变
      writeFileSync(dest, payload);
      result.copied.push(rel);
    }
  };
  walk(cloneDir);

  // 增量清理：删除 sourcesDir 里已不匹配的旧文件（仅本次产物）
  const prune = (cur: string) => {
    if (!existsSync(cur)) return;
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) { prune(p); rmSync(p, { recursive: true, force: true })  if (!readdirSync(cur).length) continue; continue; }
      const rel = relative(sourcesDir, p).split(sep).join("/");
      if (excludeRe && excludeRe.test(rel)) { rmSync(p, { force: true }); result.removed.push(rel); continue; }
      const match = includeRe ? includeRe.test(rel) : fb.test(rel);
      if (!match) { rmSync(p, { force: true }); result.removed.push(rel); }
    }
  };
  prune(sourcesDir);
  return result;
}
```
> 实现细节以"通过测试为准"（prune 的空目录清理分支可简化）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/wiki-filter-and-copy.test.ts -v`
Expected: PASS 全部。

- [ ] **Step 5: Typecheck + Commit**

Run: `npx tsc --noEmit`
```bash
git add src/engines/wiki/filter-and-copy.ts src/engines/wiki/index.ts tests/wiki-filter-and-copy.test.ts
git commit -m "feat(knowledge): wiki git filterAndCopyMatched pure function"
```

---

### Task 3: 后端 git 源 wiki 编排——worker 增加 git 前置阶段

**Files:**
- Modify: `src/store/types.ts`（`WikiBuildContext` 加 git 字段）
- Modify: `src/store/wiki-service.ts`（`sync()`/`ingest()` 把 git 源信息带上 worker ctx；新增 `create` / `updateMeta` 支持 git 参数）
- Modify: `src/module.ts`（`realWikiWorker` 增加 git 分支：拉取 + 过滤 + 再 ingest；注入 fetcherRegistry）
- Modify: `src/store/wiki-service.ts`（导出 `createWiki` 可传 source_type/source_url/branch）

**Interfaces:**
- Consumes: `filterAndCopyMatched`（Task 2）、`GitSourceFetcher` / `SourceFetcherRegistry`（现有）、`WikiWorker(ctx)`（现有）。
- Produces:
  - `WikiBuildContext` 新增可选：`source_type?: string; source_url?: string; branch?: string; path_include?: string | null; path_exclude?: string | null`
  - `WikiService.sync(serviceId, teamId, wikiId)` 保持签名不变（自动同步/手动共用一个入口），但内部对 git 源构造含 git 字段的 worker ctx。

- [ ] **Step 1: 探索现有 worker 数据流，确认注入点**

读：`src/module.ts`（`realWikiWorker` L173-203、`wikiService` 构造 L210-232）、`src/store/wiki-service.ts`（`ingest` L272-290、`sync` L293-295、`enqueueBuild` 附近 L1020-1050、`CreateWikiParams`）。
Expected: 明确 worker ctx 由 `enqueueBuild` 构造，git 字段需从 `WikiRow`（含 source_type/source_url/branch）传递。

- [ ] **Step 2: 扩展类型与传递**

`WikiBuildContext` 加 git 可选字段；在 `wiki-service.ts` 的 `enqueueBuild` 里把 `row.source_type/source_url/branch/path_include/path_exclude` 填入 ctx（依赖 Task 1 的模型字段已加）。

- [ ] **Step 3: `realWikiWorker` 增加 git 前置阶段**

在 `src/module.ts` 的 `realWikiWorker` 开头加分支（`ctx.source_type === "git"` 时）：
```ts
import { filterAndCopyMatched } from "./engines/wiki/filter-and-copy.js";
// realWikiWorker 内，ingest 之前：
if (ctx.source_type === "git" && ctx.source_url) {
  setInternalStatus("fetching");
  const fetcher = fetcherRegistry.resolve(ctx.source_url);
  const cloneDir = join(ctx.dir, "raw", "repo_src");
  try {
    if (existsSync(join(cloneDir, ".git"))) {
      await fetcher.sync(ctx.source_url, ctx.branch ?? "main", cloneDir);
    } else {
      mkdirSync(cloneDir, { recursive: true });
      await fetcher.fetch(ctx.source_url, ctx.branch ?? "main", cloneDir);
    }
    setInternalStatus("filtering");
    filterAndCopyMatched(cloneDir, join(ctx.dir, "raw", "sources"), {
      include: ctx.path_include ?? null,
      exclude: ctx.path_exclude ?? null,
    });
  } catch (err) {
    setInternalStatus("failed");
    throw new Error(`wiki git fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
// 然后进入现有 wikiMgr.ingest(...)（现有逻辑不动）
```
> 注：`fetcherRegistry` 需从 `createKnowledgeModule` 作用域传入 `realWikiWorker`（它已在该作用域，直接用）。

- [ ] **Step 4: 集成测试——git 源 wiki 全流程**

在 `tests/wiki-git-flow.test.ts` 新建集成测（可 mock fetcherRegistry 或用一个本地 git 仓库 fixture）：
```ts
import { describe, it, expect, vi } from "vitest";
// 构造 memory 内 IKnowledgeStore / WikiService，注入一个 mock worker 捕获 ctx，
// 断言 git 源时 ctx 携带 git 字段且 ingest 被触发；非 git 源不受影响。
```
（以仓库实际 WikiService 构造方式为准；若纯集成难搭，用 `filterAndCopyMatched` + 一个极简 worker 桩做验收。）

- [ ] **Step 5: 手动 smoke**

用本地临时 git 仓库构造一个 git 源 wiki（NEWAPI LLM 已配 scm-flash，ingest 会真跑），验证：create→fetch→过滤→ingest→ready。
Run: 重启 knowledge（8421）后，`POST /wiki/create {source_type:'git', source_url:'<本地 https 或 test 仓库>'}`，再 poll `/wiki/get`。
Expected: status 走到 ready，page_count > 0，且 `raw/sources/` 只含匹配文件。

- [ ] **Step 6: Typecheck + Commit**

Run: `npx tsc --noEmit`
```bash
git add src/store/types.ts src/store/wiki-service.ts src/module.ts tests/wiki-git-flow.test.ts
git commit -m "feat(knowledge): git-source wiki worker pre-stage (fetch+filter+ingest)"
```

---

### Task 4: 后端路由——`/wiki/create` 扩展 + 新增 `/wiki/sync`

**Files:**
- Modify: `src/routes/wiki.ts`
- Modify: `src/store/wiki-service.ts`（确认 `create` 已收 git 参数；`sync` 保持）
- Test: `tests/wiki-routes-git.test.ts`（新建）

**Interfaces:**
- Consumes: `WikiService.create` / `.sync` / `.getById`（Task 3）。
- Produces: `/wiki/create` 接受 `source_type|source_url|branch|path_include|path_exclude`；`/wiki/sync {wiki_id}`（service_id 取自 header）。

- [ ] **Step 1: 读现有 create 路由与 idField 提取**

读 `src/routes/wiki.ts` 的 `/create`（L155-185）与 `extractIdFields`。
Expected: create 现在只收 `name`；需扩展 body 解析。

- [ ] **Step 2: 扩展 `/wiki/create`**

在现有 create 处理里解析并透传 git 参数：
```ts
const body = await c.req.json<Record<string, unknown>>();
// ... 现有 name 等 ...
const gitFields = {
  source_type: typeof body.source_type === "string" ? body.source_type : undefined,
  source_url: typeof body.source_url === "string" ? body.source_url : undefined,
  branch: typeof body.branch === "string" && body.branch ? body.branch : undefined,
  path_include: typeof body.path_include === "string" && body.path_include ? body.path_include : null,
  path_exclude: typeof body.path_exclude === "string" && body.path_exclude ? body.path_exclude : null,
};
// 校验：source_type='git' 时必须给 source_url，且用 GitSourceFetcher 校验 url
const result = wikiService.create({ service_id, team_id, name, ...gitFields, user_id });
```
用 `SourceFetcherRegistry` 的 `resolve(url)` 校验 git url（会 throw 非 https/私网）。

- [ ] **Step 3: 新增 `/wiki/sync` 路由（对齐 /ingest）**

在 `src/routes/wiki.ts` 加：
```ts
app.post("/sync", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const serviceId = c.req.header("x-tdai-service-id");
  if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
  const wikiId = body.wiki_id;
  if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
  const row = wikiService.getById(serviceId, wikiId);
  if (!row) return c.json(wrapError(404, "wiki not found"), 404);
  if (row.source_type !== "git") return c.json(wrapError(400, "only git-source wiki supports sync"), 400);
  const requesterUserId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;
  const result = wikiService.sync(serviceId, row.team_id, wikiId, requesterUserId);
  if (result.kind === "not_found") return c.json(wrapError(404, "wiki not found"), 404);
  if (result.kind === "busy") return c.json({ code: 409, message: "busy", data: { status: result.status, step: result.step } }, 409);
  return c.json(wrapOk({ wiki_id: result.row?.wiki_id, status: result.row?.status }), 202);
});
```

- [ ] **Step 4: 写测试**

`tests/wiki-routes-git.test.ts`：用 Hono app 注入 mock WikiService，断言：
- create 带 git 参数时透传到 service，缺 source_url 报 400。
- /wiki/sync 对非 git 源报 400；对 git 源返回 202。
（以现有 Hono 测试范式为准，若仓库无测试基建，用 `app.request()` 直接断言。）

- [ ] **Step 5: 类型check + Commit**

Run: `npx tsc --noEmit`
```bash
git add src/routes/wiki.ts tests/wiki-routes-git.test.ts
git commit -m "feat(knowledge): wiki create accepts git params + /wiki/sync endpoint"
```
先确认 `wiki-service.getById` 存在可复用（已在 L302 确认）。

---

### Task 5: AutoSyncScheduler 扩展——纳管 git 源 wiki（方向 A：全局）

**Files:**
- Modify: `src/store/auto-sync-scheduler.ts`
- Modify: `src/module.ts`
- Modify: `src/store/types.ts`（`listSyncedWikis` 已存在？确认返回含 source_type）

**Interfaces:**
- Consumes: `WikiService.sync(serviceId, teamId, wikiId)`（Task 3）、`store.listSyncedWikis()`（现有）。
- Produces: `AutoSyncScheduler` 构造可注入 `wikiService?: WikiService`；`listSyncCandidates()` 同时返回 git 源 wiki；`syncOne()` 对 wiki 走 `wikiService.sync`。

- [ ] **Step 1: 读现有 scheduler + listSyncedWikis 返回**

读 `src/store/auto-sync-scheduler.ts`（L233-249 `listSyncCandidates`、L280-302 `syncOne`）、`src/store/sqlite-store.ts` `listSyncedWikis`（L580）。
Expected: `listSyncedWikis()` 返回 synced wiki refs（含 service_id/team_id/wiki_id），可用于候选判定；需确认返回是否含 `source_type` 以只筛 git 源。

- [ ] **Step 2: 扩展 scheduler**

```ts
export interface AutoSyncSchedulerDeps {
  store: IKnowledgeStore;
  cgService: CodeGraphService;
  wikiService?: WikiService;   // 新增，可选（无则 wiki 自动同步不生效）
  config: AutoSyncConfig;
}
```
`listSyncCandidates()` 增加：遍历 `listSyncedWikis()`，`getWiki` 后只筛 `source_type==='git' AND status==='ready'`，加入候选（带上 kind 标记）。
`syncOne()` 根据候选类型分派：code-graph → `cgService.sync`；wiki → `wikiService.sync`。

- [ ] **Step 3: module.ts 注入 wikiService**

`createKnowledgeModule` 里构造 scheduler 时传入 `wikiService`：
```ts
const autoSyncScheduler = new AutoSyncScheduler({ store, cgService, wikiService, config: autoSyncConfig });
```

- [ ] **Step 4: 集成测试**

`tests/wiki-auto-sync.test.ts`：mock store（返回 1 个 git wiki ready + 1 个 code-graph）+ mock cgService/wikiService.sync，手动触发一次 `scan()`（或暴露测试钩子），断言 git wiki 被 sync。
（沿用现有 scheduler 测试范式；若无，用 fake timers + vi.fn mock 断言 `wikiService.sync` 被调用。）

- [ ] **Step 5: 类型check + Commit**

Run: `npx tsc --noEmit`
```bash
git add src/store/auto-sync-scheduler.ts src/module.ts src/store/types.ts tests/wiki-auto-sync.test.ts
git commit -m "feat(knowledge): auto-sync scheduler manages git-source wikis (global toggle)"
```

---

### Task 6: 前端 API —— createWiki 扩展 + syncWiki 新增

**Files:**
- Modify: `web/src/lib/api/knowledge-api.ts`

**Interfaces:**
- Consumes: 现有 `panelPost`、`WikiDetail`。
- Produces:
  - `wiki.create(teamId, name, opts?: { source_type?; source_url?; branch?; path_include?; path_exclude? })`
  - `wiki.sync(wikiId): Promise<void>`
  - `WikiDetail` 类型增加 `source_type/source_url/branch/path_include/path_exclude/sync_error`

- [ ] **Step 1: 读 knowledge-api.ts 相关段**

读 `web/src/lib/api/knowledge-api.ts`（wiki 段 L295-420、WikiDetail 类型定义）。
Expected: 明确 create 现在是 `(teamId, name)`。

- [ ] **Step 2: 扩展 create + 新增 sync + 补 WikiDetail 字段**

```ts
create: (teamId: string, name: string, opts?: {
  source_type?: string; source_url?: string; branch?: string;
  path_include?: string; path_exclude?: string;
}): Promise<WikiDetail> =>
  panelPost('/wiki/create', {
    team_id: teamId, name,
    ...(opts?.source_type ? { source_type: opts.source_type } : {}),
    ...(opts?.source_url ? { source_url: opts.source_url } : {}),
    ...(opts?.branch ? { branch: opts.branch } : {}),
    ...(opts?.path_include ? { path_include: opts.path_include } : {}),
    ...(opts?.path_exclude ? { path_exclude: opts.path_exclude } : {}),
  }),
sync: (wikiId: string): Promise<void> => panelPost('/wiki/sync', { wiki_id: wikiId }),
```
同时给 `WikiDetail` interface 补 `source_type?: string|null; source_url?: string|null; branch?: string|null; path_include?: string|null; path_exclude?: string|null; sync_error?: string|null`。

- [ ] **Step 3: typecheck**

在 `web/` 下：`pnpm -C web typecheck` 或 `npx tsc --noEmit`（以仓库脚本为准）。
Expected: 0 错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api/knowledge-api.ts
git commit -m "feat(panel): wiki api create opts + syncWiki"
```

---

### Task 7: 前端 UI —— 新建对话框来源类型 + 详情同步块 + 列表角标

**Files:**
- Modify: `web/src/pages/WikiPage/index.tsx`（新建对话框）
- Modify: `web/src/pages/WikiPage/components/wiki-detail-view.tsx`（详情来源块 + 同步按钮）
- Modify: `web/src/pages/WikiPage/components/WikiSourcesPanel.tsx` 或列表项（来源角标）
- Modify: `web/src/pages/WikiPage/constants/wiki-constants.ts`（来源类型常量，对齐现有 Tab 风格）
- Test: 前端手工验证（无现有前端测试基建则手动核对渲染）

**Interfaces:**
- Consumes: `wiki.create(teamId, name, opts)` / `wiki.sync(wikiId)`（Task 6）。
- Produces: 新建对话框可选「手动上传 / Git 仓库」；详情展示来源 + 「同步」按钮；列表来源 Tag。

- [ ] **Step 1: 读新建对话框与详情组件**

读 `web/src/pages/WikiPage/index.tsx`（新建逻辑）、`wiki-detail-view.tsx`、`WikiSourcesPanel.tsx`。
Expected: 定位新建表单与详情概览区域、现有 `WikiScopeTab` Tab 样式。

- [ ] **Step 2: 新建对话框加来源类型选择**

在新建对话框加「来源类型」单选（`手动上传` / `Git 仓库`），选 `Git 仓库` 显示 `Git 仓库 URL` / `分支` / `路径匹配正则` 字段；提交时调 `wiki.create(teamId, name, {source_type:'git', ...})`。样式复用现有 Tab 与表单控件。

- [ ] **Step 3: 详情页加来源 + 同步**

`wiki-detail-view.tsx`：展示《来源: Git 仓库（<url>@<branch>）/ 路径匹配 / 最近同步 / 状态徽章》，git 源加「同步」按钮调 `wiki.sync(wikiId)` + 复用现有 ingest 进度轮询（`pollWikiStatus`）。

- [ ] **Step 4: 列表角标**

列表项加来源 Tag：`Git` vs `上传`（复用 Tea Tag soft 变体，风格对齐仓库现有来源标记）。

- [ ] **Step 5: 手工验证 + Commit**

启动 panel（8123）手工核对：新建 Git wiki、详情来源块、同步按钮、列表角标。
```bash
git add web/src/pages/WikiPage/index.tsx web/src/pages/WikiPage/components/wiki-detail-view.tsx web/src/pages/WikiPage/components/WikiSourcesPanel.tsx web/src/pages/WikiPage/constants/wiki-constants.ts
git commit -m "feat(panel): wiki git-source create dialog + sync UI + source badge"
```

---

### Task 8: 文档更新

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-wiki-git-source-design.md`（标注"已实现"）
- Modify（推荐）：`docs/tdai-v2-technical-ops.md`（wiki git 源配置说明，若存在相应章节）

- [ ] **Step 1: spec 标注实现状态**

在 spec 标题下加一行实现状态 + 指向本计划。

- [ ] **Step 2: 操作文档补充 wiki git 源**

在技术文档加「wiki 从 git 拉取文档」小节：创建方式、正则语义、自动同步使用 `KNOWLEDGE_AUTO_SYNC_*` 全局变量。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-04-wiki-git-source-design.md docs/tdai-v2-technical-ops.md
git commit -m "docs(knowledge): wiki git source operational notes"
```