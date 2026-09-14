# 知识库（wiki）向量化语义检索 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 MemoryKnowledge 服务的 wiki 检索叠一层语义向量召回，与现有 FTS5(BM25) RRF 融合，改善中文业务查询语义召回，且复用记忆侧已验证的 embedding 服务。

**Architecture:** 在 wiki 的 `index.db`（better-sqlite3）里通过 `sqlite-vec` 扩展新增 `wiki_vec` `vec0` 向量表；ingest/重建时对每页正文 embed 并存向量；查询时 FTS5 + 向量并行检索后 RRF 融合。向量与 FTS 共用 `writeIndex` 整体重建生命周期，切片新增/更新/删除自动对账，无孤儿向量。

**Tech Stack:** MemoryKnowledge（Node 22 + better-sqlite3 + sqlite-vec + hono）；embedding 复用火山 `openai_compatible`（doubao-embedding-vision，2048 维）；TypeScript（tsx 运行）。

**Spec:** [2026-09-05-knowledge-wiki-vectorization-design.md](../specs/2026-09-05-knowledge-wiki-vectorization-design.md)

## Global Constraints

- **SQLite 栈**：wiki 用 better-sqlite3（`index-db.ts`），向量表通过 `sqlite-vec` 的 `load(db)` API（`db.loadExtension`）在同一 `index.db` 内建 `wiki_vec`；不得迁移到 node:sqlite 或独立向量库。
- **embedding 配置**：复用记忆侧火山服务（`baseUrl=https://ark.cn-beijing.volces.com/api/plan/v3`, `model=doubao-embedding-vision`, `dimensions=2048`），从 `MemoryKnowledge/config.ts` 读取（参照现有 `llm` 段的 env 读取范式）。
- **降级**：embedding 未配置/加载 sqlite-vec 失败/embed 失败 → 跳过向量，退纯 FTS5，行为与现状完全一致。
- **不改结构**：不动 `wiki_fts`/`page_meta`/`graph_edge`、页面 .md 结构、ingest 流程、API 契约。
- **仅动 MemoryKnowledge**：不触碰 MemoryCore（记忆）、MemoryProxy。
- 测试用 vitest（MemoryKnowledge 现有测试框架）。
- **跨平台（Windows + Linux）**：本项目须同时支持 Windows 与 Linux 部署。硬性约束：① 路径一律用 `node:path` 或 `replace(/\\/g,"/")`，禁止硬编码 Windows 路径/分隔符；② 不得假设 `.dll`（Windows 特有扩展名）——`sqlite-vec` 的 `load()` 由库负责各平台扩展名（win→`sqlite-vec-windows-x64`、linux→`sqlite-vec-linux-x64` 等），代码只调 `loadVecExtension(db)`，不碰扩展名/平台子包路径；③ 除 `code/bridge.ts` 既有 `process.platform` 用法外，不得新增平台特化分支。
- **embed 调用超时/重试（R2 非阻塞建议，落实为约束）**：`WikiEmbeddingClient.embed()` 必须加 AbortController 超时（参照 MemoryCore `embedding.ts` 的 ~10s timeout + 有限重试），防止上游 embedding 服务挂起时阻塞 `writeIndex` 重建。超时/失败按单页降级（跳过该页向量，仍走 FTS）。由 T5 实现（T2 不扩 scope）。
- **三连接须全部加载 sqlite-vec 扩展（Spec §7.5，防回归）**：`sqlite-vec` 为动态插件，每个数据库连接打开后必须 `loadVecExtension(db)` 激活。代码会开三类连接——建表（`initIndexDb`）、写（`withWriteAsync`）、读（`getReadDb`）——**每一类都必须加载**。历史上写/读连接漏加载导致"向量从未写入（0 行）/向量检索静默退 FTS"，两个真实 bug 已修复（见 T5/T6 说明）；后续任何连接相关改动不得破坏三类连接的扩展加载完整性。

---

### Task 1: 引入 sqlite-vec 依赖

**Files:**
- Modify: `MemoryKnowledge/package.json`
- Modify: `MemoryKnowledge/src/engines/wiki/index-db.ts`

**Interfaces:**
- Produces: `loadVecExtension(db)` — 在 better-sqlite3 实例上加载 sqlite-vec 扩展；失败时静默返回（不抛）。

- [ ] **Step 1: 安装 sqlite-vec 到 MemoryKnowledge**

Run（在 `MemoryKnowledge/` 目录）:
```bash
pnpm add sqlite-vec
# sqlite-vec 运行时需对应平台子包（sqlite-vec-windows-x64），pnpm 会自动装
```
Expected: `package.json` 出现 `"sqlite-vec"` 依赖；`node_modules/sqlite-vec/` 存在。

- [ ] **Step 2: 加扩展加载封装函数**

在 `index-db.ts` 新增：
```ts
import { load } from "sqlite-vec";

/**
 * 在 better-sqlite3 实例上加载 sqlite-vec 扩展。失败静默（调用方据此降级）。
 * 与记忆侧 MemoryCore 相同：`load(db)` 内部是 `db.loadExtension(path)`，对
 * better-sqlite3 原生可用。仅当确实需要向量（dimensions>0 且已配置）才调用。
 */
export function loadVecExtension(db: Database.Database): boolean {
  try {
    load(db);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: 验证加载**

Run: `node --input-type=module -e "import Database from 'better-sqlite3'; import { loadVecExtension } from './src/engines/wiki/index-db.ts'"`
Expected: 能加载（`loadVecExtension` 返回 true），无报错。若 `load` 不在导出，改用 `import * as vec from "sqlite-vec"; vec.load(db)`。

- [ ] **Step 4: Commit**

```bash
git add MemoryKnowledge/package.json MemoryKnowledge/src/engines/wiki/index-db.ts
git commit -m "feat(knowledge): add sqlite-vec dependency + loadVecExtension helper"
```

---

### Task 2: 新增 embedding 配置与客户端

**Files:**
- Modify: `MemoryKnowledge/src/config.ts`
- Create: `MemoryKnowledge/src/engines/wiki/embedding-client.ts`

**Interfaces:**
- Produces:
  - `WikiEmbeddingConfig { provider: string; baseUrl: string; apiKey: string; model: string; dimensions: number; }`
  - `getEmbeddingConfig(): WikiEmbeddingConfig | null` — 未配置返回 null
  - `class WikiEmbeddingClient { constructor(cfg); embed(text: string): Promise<Float32Array>; isReady(): boolean; }`

- [ ] **Step 1: 在 config 新增 embedding 段**

`config.ts` 的 `LlmConfig` 旁新增并从 env 读取（参照现有 `llm` 的 `env("LLM_*", "")` 范式）：
```ts
export interface EmbeddingConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}
// 在 config 对象里加：
embedding: {
  provider: env("EMBEDDING_PROVIDER", "openai_compatible"),
  baseUrl: env("EMBEDDING_BASE_URL", ""),
  apiKey: env("EMBEDDING_API_KEY", ""),
  model: env("EMBEDDING_MODEL", ""),
  dimensions: Number(env("EMBEDDING_DIMENSIONS", "0") || "0"),
},
```
若 `baseUrl`/`apiKey`/`model` 为空或 `dimensions<=0` → `getEmbeddingConfig()` 返回 null（不启用向量）。

- [ ] **Step 2: 写 embedding 客户端**

`embedding-client.ts`（参照 MemoryCore `OpenAIEmbeddingService._callApi`）：
```ts
export interface WikiEmbeddingConfig {
  provider: string; baseUrl: string; apiKey: string; model: string; dimensions: number;
}
export function getEmbeddingConfig(cfg: unknown): WikiEmbeddingConfig | null {
  const e = (cfg as any)?.embedding;
  if (!e || !e.baseUrl || !e.apiKey || !e.model || !(e.dimensions > 0)) return null;
  return { provider: e.provider ?? "openai_compatible", baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model, dimensions: e.dimensions };
}
export class WikiEmbeddingClient {
  constructor(private cfg: WikiEmbeddingConfig) {}
  isReady(): boolean { return true; }
  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ input: [text], model: this.cfg.model, dimensions: this.cfg.dimensions }),
    });
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const json = await resp.json() as { data: Array<{ embedding: number[] }> };
    const v = json.data?.[0]?.embedding;
    if (!v || v.length !== this.cfg.dimensions) throw new Error(`embed bad response dims=${v?.length}`);
    return Float32Array.from(v);
  }
}
```

- [ ] **Step 3: 写单测**

Create `MemoryKnowledge/tests/embedding-client.test.ts`（或现有测试目录）：
```ts
import { test, expect } from "vitest";
import { getEmbeddingConfig, WikiEmbeddingClient } from "../src/engines/wiki/embedding-client.js";
test("getEmbeddingConfig returns null when incomplete", () => {
  expect(getEmbeddingConfig({})).toBeNull();
  expect(getEmbeddingConfig({ embedding: { baseUrl: "x" } })).toBeNull();
});
test("getEmbeddingConfig parses valid cfg", () => {
  const c = getEmbeddingConfig({ embedding: { baseUrl: "http://h:1", apiKey: "k", model: "m", dimensions: 4 } });
  expect(c?.dimensions).toBe(4);
});
test("WikiEmbeddingClient normalizes baseUrl trailing slash", () => {
  const c = new WikiEmbeddingClient({ provider: "x", baseUrl: "http://h:1/", apiKey: "k", model: "m", dimensions: 2 });
  expect((c as any).cfg.baseUrl).toBe("http://h:1");
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C MemoryKnowledge test -- embeddings`（或项目实际 test 命令）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add MemoryKnowledge/src/config.ts MemoryKnowledge/src/engines/wiki/embedding-client.ts MemoryKnowledge/tests/embedding-client.test.ts
git commit -m "feat(knowledge): add wiki embedding config + client"
```

---

### Task 3: index.db 建 wiki_vec 向量表（initSchema 扩展）

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/index-db.ts`

**Interfaces:**
- Consumes: `loadVecExtension(db)` (Task 1)，`getEmbeddingConfig` (Task 2)
- Produces: `initSchema` 里在加载扩展成功后新增 `wiki_vec` vitual table 的 DDL。

- [ ] **Step 1: 在 initIndexDb 里加载扩展并建表**

`initSchema` 顶部加向量表（在 `wiki_fts` 等现有建表后）：
```ts
// 向量表：仅在 sqlite-vec 加载成功且配置了 embedding 时创建。
// 用静态 DDL（dimensions 无法参数化进建表），按配置维数创建；未配置/加载失败则跳过。
```
在 `initIndexDb` 中 put extension load + 建表：
```ts
export function initIndexDb(wikiDir: string, dimensions = 0): void {
  const db = new Database(dbPath(wikiDir));
  applyPragmas(db);
  try {
    initSchema(db);
    if (dimensions > 0 && loadVecExtension(db)) {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
        page_id TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine,
        updated_time TEXT DEFAULT ''
      )`);
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
```
`initIndexDb` 现在接收可选 `dimensions` 参数；未传/为 0 → 不建向量表（与现状一致）。所有调用点需传入维度（见 Task 4 coordinator 改造）。

> 注意：`dimensions` 变更时需处理旧表维度不匹配 —— 简化：建表用 DFS 检查 `sqlite_master.sql`，若已存在且维度不同则 `DROP TABLE wiki_vec` 重建。用 try/catch 包裹，any 失败降级纯 FTS。

- [ ] **Step 2: 写建表逻辑测试（用内存/临时 db）**

Create `MemoryKnowledge/tests/index-db-vec.test.ts`:
```ts
import { test, expect } from "vitest";
import Database from "better-sqlite3";
import { loadVecExtension } from "../src/engines/wiki/index-db.js";
test("loadVecExtension loads on better-sqlite3", () => {
  const db = new Database(":memory:");
  const ok = loadVecExtension(db);
  expect(ok).toBe(true);
  db.exec("CREATE VIRTUAL TABLE t USING vec0(embedding float[3])");
  expect(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='t'").get().c).toBe(1);
  db.close();
});
```

- [ ] **Step 3: 跑测试确认**

Run: `pnpm -C MemoryKnowledge test -- index-db-vec`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add MemoryKnowledge/src/engines/wiki/index-db.ts MemoryKnowledge/tests/index-db-vec.test.ts
git commit -m "feat(knowledge): create wiki_vec vec0 table in index.db when embedding enabled"
```

---

### Task 4: 装配 coordinator —— config + embedding 注入 wiki

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/manager.ts`
- Modify: `MemoryKnowledge/src/module.ts`（或实际注册 wiki 引擎处）

**Interfaces:**
- Consumes: `getEmbeddingConfig`(Task2), `WikiEmbeddingClient`(Task2), `initIndexDb(wikiDir, dimensions)`(Task3)
- Produces: `WikiSourceManager` 实例持有 `embeddingClient: WikiEmbeddingClient | null`；`rebuildIndex`/`searchInternal` 能访问到。

- [ ] **Step 1: manager 持有 embedding client**

在 `manager.ts` 的 manager 创建/状态处，加载 embedding：
```ts
import { getEmbeddingConfig, WikiEmbeddingClient } from "./embedding-client.js";
// manager state 加字段：
//   embedding: WikiEmbeddingClient | null  (null = 未启用/降级)
```
在 manager 构造/装配时：
```ts
const embCfg = getEmbeddingConfig(config);
this.embedding = embCfg ? new WikiEmbeddingClient(embCfg) : null;
const vecDim = this.embedding?.isReady() ? embCfg!.dimensions : 0;
```
`rebuildIndex` 调 `initIndexDb(state.path, vecDim)`（把维度传下去）。

- [ ] **Step 2: 确认装配点**

在 `module.ts`（`realWikiWorker` / `wikiMgr` 注册处）把 embedding 配置从服务 config 传入 manager。若 manager 构造从别处拿 config，确保 `getEmbeddingConfig` 拿到的是 MemoryKnowledge 的 embedding 段。

- [ ] **Step 3: 编译检查**

Run: `pnpm -C MemoryKnowledge exec tsc --noEmit`（或项目 build 命令）
Expected: 无新类型错误（既有历史错误除外）。

- [ ] **Step 4: Commit**

```bash
git add MemoryKnowledge/src/engines/wiki/manager.ts MemoryKnowledge/src/module.ts
git commit -m "feat(knowledge): wire embedding client + vec dimension into wiki manager"
```

---

### Task 5: writeIndex 落向量（与 FTS 同事务整体重建）

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/manager.ts`

**Interfaces:**
- Consumes: `wiki_vec` 表(Task3), `this.embedding`(Task4)
- Produces: `writeIndex(db, pages)` 里：`DELETE FROM wiki_vec` + 每页 embed 后 `INSERT INTO wiki_vec`。

- [ ] **Step 1: 改 writeIndex**

`writeIndex(db, pages)` 顶部加清空向量表（若有表）：
```ts
try { db.prepare("DELETE FROM wiki_vec").run(); } catch { /* wiki_vec 不存在=未启用向量 */ }
```
在 for 循环里，建页后将 content embed 并写向量：
```ts
for (const p of pages) {
  insFts.run(p.id, tokenize(p.title).join(" "), tokenize(p.content).join(" "));
  insMeta.run(p.id, p.title, p.type, p.relPath, makeSnippet(p));
  // 向量落库（embedding 启用且 wiki_vec 存在时）
  if (this.embedding) {
    try {
      const vec = await this.embedding.embed(p.content);
      db.prepare("INSERT OR REPLACE INTO wiki_vec(page_id, embedding, updated_time) VALUES (?,?,?)")
        .run(p.id, Buffer.from(vec.buffer), new Date().toISOString());
    } catch {
      // 单页 embed 失败 → 跳过，仍走 FTS
    }
  }
}
```
> 因 `writeIndex` 现在是 `withWriteDb` 内同步 transaction，需把循环改为 async 或改用逐条 insert（better-sqlite3 transaction 支持同步）。embed 是 async；**改为每页 embed 后立即 insert，不包在 db.transaction 里**（向量部分允许部分成功）。为保持与现有 `withWriteDb` 事务一致：FTS/meta/graph 仍在事务，向量独立 try/catch 逐条写。

- [ ] **Step 2: 写回归测试（embedding 关闭时行为不变）**

Create/modify `MemoryKnowledge/tests/wiki-vector-write.test.ts`:
```ts
import { test, expect } from "vitest";
// 验证：embedding=null 时 writeIndex 不创建 wiki_vec、不写向量，FTS 照常。
test("writeIndex without embedding leaves wiki_vec absent", () => {
  // 构造 manager（embedding=null），写 index，断言 wiki_vec 表不存在
});
```

- [ ] **Step 3: run tests**

Run: `pnpm -C MemoryKnowledge test -- wiki-vector-write`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add MemoryKnowledge/src/engines/wiki/manager.ts MemoryKnowledge/tests/wiki-vector-write.test.ts
git commit -m "feat(knowledge): write wiki_vec vectors during writeIndex rebuild"
```

---

### Task 6: searchInternal 向量检索 + RRF 融合

**Files:**
- Modify: `MemoryKnowledge/src/engines/wiki/manager.ts`

**Interfaces:**
- Consumes: `this.embedding`, `wiki_vec` 表, `ftsSearch`(现有), `loadReadModel`(现有)
- Produces: `searchVector(db, query, limit): Array<{id, score}>` — cosine top-k；`searchInternal` 中与 FTS 结果 RRF 融合。

- [ ] **Step 1: 加向量检索函数**

```ts
function searchVector(db: DatabaseType.Database, embedding: WikiEmbeddingClient, query: string, limit: number): Array<{id:string; score:number}> {
  const q = await embedding.embed(query); // async
  const rows = db.prepare(
    "SELECT page_id, distance FROM wiki_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance LIMIT ?"
  ).all(Buffer.from(q.buffer), limit, limit) as Array<{page_id?: string; distance: number | null}>;
  return rows.filter(r => r.page_id && r.distance !== null)
    .map(r => ({ id: r.page_id!, score: r.distance === 0 ? 1 : 1 / r.distance }));
}
```

- [ ] **Step 2: 改 searchInternal 做 RRF 融合**

当前 `searchInternal` 用 `ftsSearch` 得 `rawSeeds`，然后图扩展。改为：若 `this.embedding` 可用且 `wiki_vec` 存在，先 `searchVector` 得向量结果，与 `rawSeeds` 做 RRF 融合后再喂图扩展/组装。

RRF 融合（在最后 limit 前）：
```ts
function rrfMerge(fts: Array<{id:string; score:number}>, vec: Array<{id:string; score:number}>, k=60): Array<{id:string; score:number}> {
  const rank = new Map<string, number>();
  const add = (list: {id:string}[]) => list.forEach((x, i) => rank.set(x.id, (rank.get(x.id) ?? 0) + 1 / (k + i + 1)));
  add(fts); add(vec);
  return [...rank.entries()].map(([id, s]) => ({ id, score: s })).sort((a,b)=>b.score-a.score);
}
```
融合后 map 回完整 `SearchResult`（复用现有图扩展/组装路径；hop 仅对 BM25 seed 有意义，向量结果标 `hop: 0`, `via: undefined`）。

设计权衡说明：为最小侵入，向量结果先并入 `rawSeeds`（作为 `{id, score}`），等于提高召回池；图扩展逻辑不变。融合后的集合作为新的 `rawSeeds` 传入现有 `loadReadModel` + 组装。

- [ ] **Step 3: 写 RRF 单元测试**

`MemoryKnowledge/tests/rrf.test.ts`：
```ts
import { test, expect } from "vitest";
test("rrfMerge combines fts and vector ranks", () => {
  const fts = [{id:"a",score:5},{id:"b",score:4}];
  const vec = [{id:"b",score:0.9},{id:"c",score:0.8}];
  const out = rrfMerge(fts, vec);
  expect(out[0].id).toBe("b");  // 两路都出现 → RRF 最高
  expect(out.map(x=>x.id)).toContain("a");
});
```

- [ ] **Step 4: run tests**

Run: `pnpm -C MemoryKnowledge test -- rrf`
Expected: PASS

- [ ] **Step 5: 集成验证（真实 wiki search）**

Run 一个真实查询确认混合结果：
```bash
node --import tsx/esm -e "import {} from './src/engines/wiki/router.ts'..." # 或直接调 wikiMgr.search
```
Expected: `search` 返回混合(FTS+向量)结果；embedding 关闭时仅 FTS 结果，与现状一致。

- [ ] **Step 6: Commit**

```bash
git add MemoryKnowledge/src/engines/wiki/manager.ts MemoryKnowledge/tests/rrf.test.ts
git commit -m "feat(knowledge): hybrid FTS+vector RRF search for wiki"
```

---

### Task 7: 端到端验证 + 文档

**Files:**
- Modify: `MemoryKnowledge/tdai-data/.../wiki-*/index.db`（运行验证生成）
- Create/Modify: `docs/superpowers/` 实现说明或 ops 文档（参照 `tdai-v2-technical-ops.md`）

- [ ] **Step 1: 全量回填向量（真实 wiki）**

重启 knowledge 服务后触发 rebuild（或对现有 3 个 wiki 跑一次 `rebuildIndex`），验证 988 页向量落库：
Run: knowledge 服务启动日志应出现 vec 相关 `info`；或手动 curl `/v3/tools/call {tool_name:'search'}`。
Expected: `index.db` 出现 `wiki_vec` 表且有 988 行。

- [ ] **Step 2: 语义查询实测**

对之前 spike 的查询（"发票结算时暂估应收怎么冲掉""信用额度怎么计算和检查"）跑 wiki search，对比是否命中更相关页。
Expected: 向量提升语义查询召回（spike 已验证方向正确）。

- [ ] **Step 3: 删页/改页后向量一致性验证**

手动删除/修改一个 wiki `.md` 页并触发 rebuild，确认 `wiki_vec` 中该页向量消失/更新（无孤儿向量）。
Expected: `DELETE FROM wiki_vec` + 全量重建保证一致。

- [ ] **Step 4: 更新 ops 文档**

在 `td-ai-v2-technical-ops.md`（或其他 knowledge ops 文档）补一节：知识库向量化说明（配置 env、启用/关闭、降级行为、重建命令）。

- [ ] **Step 5: Commit**

```bash
git add docs/ MemoryKnowledge/
git commit -m "docs(knowledge): vectorization ops + verification"
```

---

## Self-Review

**Spec coverage：**
- 5.1 切片一致性（整体重建同步）→ Task 5 + Task 7 Step3 ✓
- 5.2 embedding 降级 → Task 2 getEmbeddingConfig null / Task 5 try-catch / Task 3 skip ✓
- 5.3 首次回填 → Task 7 Step1 ✓
- 5.4 配置 → Task 2 ✓
- 6 数据流 / 7 组件 → Task 3/4/5/6 ✓
- 8 测试 → Task 2/3/5/6 各带测试 + Task 7 端到端 ✓

**潜在缺口修正：**
- `writeIndex` 是 `withWriteDb` 事务内同步函数，embed 是 async。Task 5 已明确改为「FTS/meta/graph 在事务，向量逐条独立 try/catch 写」，避免把 async 塞进同步 transaction —— 已写明。
- `initIndexDb` 加 dimensions 参数需同步所有现有调用点（wiki 创建、rebuildIndex），Task 4 已列为协调改造。

**类型一致性：** `WikiEmbeddingClient.embed(): Promise<Float32Array>` 在 Task 5/6 复用；`searchVector` 用 `Buffer.from(vec.buffer)` 存（sqlite-vec 的 float[] 列期望 BLOB buffer），检索时同样 `Buffer.from(q.buffer)` —— 已一致。