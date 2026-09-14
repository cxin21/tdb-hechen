# 设计文档：wiki 增加 Git 源（repo_url + 正则路径过滤 + 重建索引）

> 日期：2026-09-04
> 模块：MemoryKnowledge（knowledge 服务）+ MemoryPanel（web）
> **状态：已实现 ✅**（后端 t1–t5、前端 t6–t7 全部实现并通过各自 task-review；
> 整分支评审 t16 视团队流程执行。实现细节见
> [实现计划 2026-09-04-wiki-git-source.md](../plans/2026-09-04-wiki-git-source.md)。
> 操作说明见 [tdai-v2-technical-ops.md](../../tdai-v2-technical-ops.md) §13。）
> 决策已确认：复用 code-graph 的 git 拉取与自动同步机制；正则按仓库相对路径匹配；
> 手动同步 + 定时自动同步（全局开关，无单例勾选）；UI 与面板现有风格一致。

---

## 1. 背景与目标

当前 TDB 的知识库有两类资产：

- **code-graph**（代码图谱）：支持从 git 仓库 `clone/fetch` + 增量 `sync`，并有定时自动同步
  （`AutoSyncScheduler` + `KNOWLEDGE_AUTO_SYNC_*` 全局开关）。
- **wiki**（文档）：**只能手动上传源文件**（`raw/write`），`ingest` 前要求"已有源文件"。

目标：让 wiki 也能**从 git 仓库拉取文档**——创建 wiki 时填 `repo_url`，拉取后**按正则
路径匹配只纳入命中的文档**，并重建索引；支持手动同步 + 定时自动同步。

设计原则：**完全复用 code-graph 现有的 git 基础设施**（`GitSourceFetcher`、
`SourceFetcherRegistry`、`AutoSyncScheduler`），不重写 git 拉取逻辑。

---

## 2. 现状调研结论（基于源码）

| 能力 | code-graph | wiki |
|---|---|---|
| git clone/fetch/sync | ✅ `GitSourceFetcher`（simple-git） | ❌ 无 |
| 定时自动同步 | ✅ `AutoSyncScheduler` | ❌ 无 |
| 正则路径过滤 | ❌（全量索引） | ❌（全部源文件 ingest） |
| 源字段持久化 | `repo_url` / `branch` / `repo_name` | `source_type` / `source_url`（已有但未使用） |

关键发现：

1. **`CreateWikiInput` 已有 `source_type` / `source_url` 字段**，且 `db/client.ts` L88-89 已建列，
   **零迁移**即可承载 git 源标识。
2. **`GitSourceFetcher` 只支持 public HTTPS 仓库**，且默认 SSRF 拦私网地址
   （`PRIVATE_ADDR_RE` + `KNOWLEDGE_SSRF_CHECK=off` 可关）。对齐 code-graph 现状，wiki git 源同样受限。
3. **wiki worker 不自己拉 git**：`realWikiWorker` 只 ingest 已就位的本地 `dir`
   （`wiki-service.dirFor()` → `<dataRoot>/<serviceId>/<teamId>/<wikiId>/`，源文件在
   `raw/sources/`）。所以 git 拉取 + 过滤是**插入在 ingest 之前的**新环节。
4. `AutoSyncScheduler.listSyncCandidates()` 只挑 **status=`ready`** 的仓库；配置是
   **全局**（`KNOWLEDGE_AUTO_SYNC_ENABLED` / `_SCAN_INTERVAL_MIN` / `_MAX_CONCURRENT`），
   **无 per-repo 开关**。

---

## 3. 数据模型

复用 `source_type` / `source_url`，新增三列：

```text
wiki 表新增列：
  branch             TEXT   -- 分支，默认 'main'
  path_include       TEXT   -- 相对路径 include 正则（null=不限制）
  path_exclude       TEXT   -- 相对路径 exclude 正则（可选）
```

- `source_type = 'git'` 表示 git 源；`source_type = 'upload'`（或 null）保持原有手动上传路径。
- 需要一次轻量迁移（在 `db/client.ts` 建表语句 + `schema.ts` 加列）。

---

## 4. 正则语义（路径匹配）

- **匹配对象**：仓库内每个文件的**相对路径**（POSIX 风格，如 `docs/xx.md`），不匹配文件内容。
- 判定顺序：
  1. `path_exclude` 命中 → **排除**
  2. `path_include` 未设置 → 兜底语言类型：`.md / .txt / .markdown`
  3. `path_include` 设置且命中 → **纳入**（可覆盖语言兜底）
- 实现时可借用现有 `WIKI_ALLOWED_FILE_RE`（前端）作为默认过滤认知。

---

## 5. 后端设计

### 5.1 wiki worker 增加 git 前置阶段（module.ts `realWikiWorker`）

当 `source_type == 'git'` 时，在 ingest **之前**插入：

```ts
if (sourceType === "git") {
  // 1) 复用 fetcher：首次 clone / 已存在则增量 sync
  const fetcher = fetcherRegistry.resolve(sourceUrl);
  const cloneDir = join(dir, "raw", "repo_src");       // .git 存这里
  if (existsSync(join(cloneDir, ".git"))) {
    await fetcher.sync(sourceUrl, branch, cloneDir);   // fetch depth=1 + hard reset
  } else {
    mkdirSync(cloneDir, { recursive: true });
    await fetcher.fetch(sourceUrl, branch, cloneDir);  // 浅克隆单分支
  }

  // 2) 按 path_include / path_exclude 正则，把匹配文件同步到 dir/raw/sources/
  //    增量：对比 sources 内已有文件，diff 出新增/修改/删除
  filterAndCopyMatched(cloneDir, join(dir, "raw", "sources"), {
    include: pathInclude, exclude: pathExclude,
  });

  // 3) setInternalStatus("ingesting") → 落现有 wikiMgr.ingest()（重建索引）
}
```

要点：

- **目录规约**：clone 产物在 `raw/repo_src/`（含 `.git`）；过滤后的**匹配文件**进
  `raw/sources/`（现有 ingest 认它）。`dirFor()` 不变。
- **过滤函数 `filterAndCopyMatched`**：遍历 clone 目录，按相对路径正则决定每个文件去留；
  对 `raw/sources/` 与 `raw/repo_src/` 做 diff，只复制变更、删除已不匹配的旧文件。
- **重建索引**：复用现有 `wikiMgr.ingest()`（它本就重建索引与页面）。无需新写 ingest。
- **失败处理**：clone/fetch 失败 → `setInternalStatus('failed')`，写入 `sync_error`；
  不进入 ingest，保持原有 `failed` 状态流转。

### 5.2 新增 /wiki/sync 路由（手动同步）

对齐 `POST /code-graph/sync`：

```text
POST /wiki/sync  { wiki_id }   （service_id 从 header `x-tdai-service-id` 取，对齐现有路由风格）
  → 触发一次"重新 git 拉取 + 过滤 + ingest"（fire-and-forget，返回 202）
  → 复用现有 ingest 的 busy/not_found 判别语义
```

对非 git 源的 wiki 调用 `/wiki/sync` → 返回 400（仅 git 源支持同步）。

### 5.3 改造 /wiki/create（支持 git 参数，非破坏）

现有 `POST /wiki/create` 扩展 body，新增可选字段：

```text
source_type, source_url, branch, path_include, path_exclude
```

- 传了 `source_type='git'` → 创建为 git 源，并（可立即触发一次拉取+ingest，或由面板点同步）；
- 未传 → 保持现有手动上传路径，行为不变。
- 校验：`source_type='git'` 时必须提供合法 `source_url`（复用 `GitSourceFetcher.validate`）。

### 5.4 持久化展示字段（/wiki/get）

`GET /wiki/get` 返回中带 `source_type` / `source_url` / `branch` / `path_include` /
`path_exclude` / `sync_error` / `last_sync_at`，供前端展示来源与同步状态。

### 5.5 自动同步（方向 A：全局开关，复用现有机制）

**不改** per-repo 配置。扩展 `AutoSyncScheduler` 使其同时纳管 git 源 wiki：

- `listSyncCandidates()` 增加：额外收集 `source_type='git' AND status='ready'` 的 wiki 行。
- `syncOne()` 对 git 源 wiki 调 `wikiService.sync(...)`（而非 `cgService.sync`）。
- 节奏沿用现有全局配置：
  - `KNOWLEDGE_AUTO_SYNC_ENABLED`（总开关）
  - `KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN`（扫描周期）
  - `KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT`（并发）
- **无单例勾选**：所有 `ready` 的 git 源 wiki 都参与自动同步（对齐 code-graph 现状）。

> 已确认：当前部署已在 `MemoryKnowledge/.env` 启用
> `KNOWLEDGE_AUTO_SYNC_ENABLED=true`（间隔 10 分钟、并发 3）。

### 5.6 鉴权 / 安全（复用 code-graph 现状）

- `GitSourceFetcher` 沿用：仅 public HTTPS、SSRF 私网黑名单。
- 不新增鉴权字段（对齐 code-graph 现状；私有/内网仓库不在本期范围）。

---

## 6. 前端 UI 设计（对齐面板现有风格）

### 6.1 「新建 Wiki」对话框：来源类型选择

在 `WikiPage/index.tsx` 的新建对话框加「来源类型」单选（复用 `WikiScopeTab` 的 Tab 样式）：

- 选项：`手动上传` / `Git 仓库`
- 选 `Git 仓库` 时显示 git 字段：
  - `Git 仓库 URL`（必填）
  - `分支`（默认 `main`）
  - `路径匹配正则`（可选；placeholder 注明"留空=仓库内全部 .md/.txt 文档"）
- 复用 `knowledge-api.ts` 的 `createWiki`，body 扩展传球。

### 6.2 Wiki 详情：来源 + 同步状态块

在 `wiki-detail-view.tsx` 概览卡片加一块：

- 来源：`Git 仓库（<url> @ <branch>）` 或 `手动上传`
- 路径匹配：`^docs/.*\.md$`（git 源才显示）
- 最近同步 / 状态徽章（复用 `WIKI_STATUS_*`）
- **「同步」按钮**：调用新增 `syncWiki()`，复用现有 ingest 进度轮询展示

### 6.3 Wiki 列表：来源角标

`WikiSourcesPanel.tsx` / 列表项加小 Tag 区分来源：`Git` vs `上传`
（用现有 Tea Tag `soft` 变体，风格对齐 `SkillPage`/`ResourcePage` 已有来源标记）。

### 6.4 前端改动文件清单

| 文件 | 改动 |
|---|---|
| `pages/WikiPage/index.tsx` | 新建对话框加来源类型 + git 字段 |
| `pages/WikiPage/components/wiki-detail-view.tsx` | 来源 + 同步状态块 + 「同步」按钮 |
| `pages/WikiPage/components/WikiSourcesPanel.tsx` | 来源角标 |
| `lib/api/knowledge-api.ts` | `createWiki` 扩展参数 + 新增 `syncWiki()` |

---

## 7. 测试计划

- **单测**：
  - `filterAndCopyMatched`：include/exclude 正则的组合（in-else、exclude 优先、无 include 兜底 .md）、
    diff 增量（新增/修改/删除）、路径穿越防护。
  - `resolveAutoSyncConfig`：现有（不改）。
- **集成**：
  - git 源 wiki 全流程：创建（带 branch/正则）→ 拉取 → 过滤 → ingest → `ready`。
  - 手动 `/wiki/sync`：仓库更新后拉取最新 + 只重建匹配文件。
  - 自动同步：模拟 scheduler 扫描命中 git 源 wiki；`_SCAN_INTERVAL_MIN` 生效。
- **前端**：新建表单校验（git URL 必填、正则非法提示）、详情来源展示、同步按钮进度。

---

## 8. 非目标 / 范围外

- **[不做]** 私有 / 内网 git 仓库鉴权（对齐 code-graph 现状，仅 public HTTPS）。
- **[不做]** 每 wiki 独立自动同步开关/间隔（方向 A：全局统一）。
- **[不做]** 文件内容正则过滤（仅路径匹配）。
- **[不做]** code-graph 的正则过滤（code-graph 保持全量索引）。

---

## 9. 风险与注意

- `GitSourceFetcher.sync` 的 `git clean` 会对 `.git` 目录做排除（`-e .codegraph` 墓碑）——
  对 wiki 的 `raw/repo_src/` 无 `.codegraph`，clean 语义需确认不会误删我们需要保留的已匹配文件；
  过滤增量逻辑应把"已生成 sources"视为受保护。
- 自动同步的 wiki 与 code-graph 共用 worker/队列，需确认并发上限与互不阻塞。
- DB 加列需兼容旧版 SQLite 库（迁移脚本幂等）。