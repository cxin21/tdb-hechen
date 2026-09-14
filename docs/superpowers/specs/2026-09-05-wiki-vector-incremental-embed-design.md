# 设计文档：wiki 向量增量重嵌（降低 embed 成本与配额消耗）

> 日期：2026-09-05
> 模块：MemoryKnowledge（knowledge 服务，8421）—— wiki 引擎 manager.ts / index-db.ts
> **状态：设计中**（决策已确认，待实现）
> 前置背景：知识库向量化已实现（commit 5a4af92），当前 `writeVectors` 对每次 ingest/sync 全量重嵌全部页面。

## 1. 背景与目标

已实现的向量化中，`writeVectors`（manager.ts）在每次 ingest/sync 时对 `scanWikiDir` 扫到的**全部**页面（真实 wiki `wiki-d7l7gdjw` ≈991 页）逐页调外部 embedding。现状：

- 每次 ingest/sync = **991 次外部 embedding API 调用**（每页一次）
- 这是付费服务，实测会耗尽火山**周配额**（真实 HTTP 429 `AccountQuotaExceeded`）
- 全量重嵌耗时约几分钟，且低频大动作

对照：同文件 `ingest-v2`（L378-392）**已实现** LLM 抽取的 sha 增量（`toIngest` 只取 sha 变化/新增页，`skipped` 跳过未变页）——**唯独向量层至今是全量**。

**目标**：把 embed 调用从"每次全量"降到"仅变更/缺向量页"，降低成本和配额消耗，同时**严格保留 spec §5.1 的"切片增删对账零孤儿"一致性锚点**。

## 2. 关键决策（已确认）

1. **全量对账 + 增量 embed**：每次仍基于 `pages = scanWikiDir()` 全量集合处理（保证删页零孤儿、新增页被纳入），仅对内容未变的页跳过 embed。
2. **content sha256 指纹**：对 `page.content` 做 sha256（可靠，不受 mtime/touch 干扰，对齐 LLM 抽取侧 sha 先例）。
3. **wiki_vec 加 `content_sha` 列**：同一行存向量 + 指纹，一行完成对账。
4. **复用条件 = content_sha 相同 且 该页已有向量**：缺向量（新增/失败/曾清空）时即使 sha 相同也重新 embed —— 覆盖"整个没向量化/新文件没向量"场景。
5. **方案 A（改 writeVectors 结构）**：不再"先 DELETE wiki_vec 再重写"（否则复用无从谈起），改为「读-比-写 + 末尾删孤儿」。

## 3. 现状与矛盾（基于源码事实）

- `writeIndex`（manager.ts:438-452）在同步事务内 `DELETE FROM wiki_vec`（L443）+ 重建 FTS。
- `writeVectors`（manager.ts:911-934）随后在独立异步写连接里逐页 embed + `INSERT OR REPLACE`。
- **矛盾**：`writeIndex` 先 DELETE 清空 wiki_vec，导致 writeVectors 执行时库里已无旧向量可复用 —— 若不改结构，增量复用失效。故需方案 A。

## 4. 数据模型

`wiki_vec` 增加 `content_sha` 列（vec0 表支持非向量附加列，需在实现前 spike 验证）：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
  page_id TEXT PRIMARY KEY,
  embedding float[N] distance_metric=cosine,
  updated_time TEXT DEFAULT '',
  content_sha TEXT DEFAULT ''          -- 新增：页面 content 指纹
);
```

**迁移**：`ensureWikiVecTable` / 初始化处对已有库执行
`ALTER TABLE wiki_vec ADD COLUMN content_sha TEXT DEFAULT ''`（幂等，存在则跳过）。
迁移后首次 ingest/sync：旧行 `content_sha=''` ≠ 任何真实 sha → **全部重嵌一次**（等价首次全量，one-time 成本可接受）。

## 5. writeVectors 增量逻辑（方案 A）

```
writeVectors(projectPath, pages):
  if (!embeddingClient) return                 # 未启用 → 纯 FTS（现状不变）
  withWriteAsync(projectPath, db):
    if (!wiki_vec exists) return               # 未建向量表 → 纯 FTS
    existing = db: SELECT page_id, content_sha FROM wiki_vec
    for page in pages:
      sha = sha256(page.content)
      prev = existing.get(page.id)
      if (prev 存在) && (prev.content_sha == sha):   # 内容未变 且 已有向量
        continue                                   # 复用向量，不调 embed
      else:
        vec = await embed(page.content)            # 新增/变更/缺向量 → 重嵌
        INSERT OR REPLACE INTO wiki_vec(page_id,embedding,updated_time,content_sha)
        # 单页 embed 失败 → catch 跳过该页（仍走 FTS），不中断
    # 末尾清理孤儿：删除 wiki_vec 中不在当前 pages 集合内的行（处理删页）
    DELETE FROM wiki_vec WHERE page_id NOT IN (当前 pages ids)
```

要点：
- **复用**严格要求"sha 相同 且 该页行存在（有向量）"，缺任一 → 重嵌。
- **零孤儿**由末尾 `NOT IN pages` 清理保证，与删页对账一致。
- 未改动 FTS/reindex/graph 逻辑；仅调整 writeVectors 的写策略。
- `writeIndex` 不再 `DELETE FROM wiki_vec`（改为由 writeVectors 按对账 + 末尾清理），或保留 DELETE 但 writeVectors 必须在其后重建——**采用"writeIndex 不删向量，全权交 writeVectors 对账"**，避免时序耦合。

## 6. 边界与一致性

1. 删页：不在 pages 集合 → 末尾 `NOT IN` 清理 → 向量消失（零孤儿）。
2. 新增页：不在 existing → 重嵌。
3. 内容变化：sha 变 → 重嵌。
4. 缺向量（曾失败/清空/整个没向量化）：prev 行不存在 → 重嵌（兜底，不误判跳过）。
5. sha 碰撞：sha256 碰撞概率可忽略，接受。
6. embed 失败：单页 catch 跳过，退 FTS，不中断整体。
7. embedding 未启用：writeVectors 提前 return，零影响。
8. 跨平台：sha256 为纯计算，无平台假设。

## 7. 风险与前置验证

- **spike 前置**：确认 sqlite-vec 的 vec0 表支持附加非向量列（`content_sha`），以及 `ALTER TABLE ... ADD COLUMN` 对 vec0 虚拟表是否可行；若不可行，退化为独立 `vec_fingerprint` 表（page_id, sha）。
- "首次全量"迁移成本：存量库首次需全量重嵌一次，可接受。
- 涉及 writeVectors 核心结构改动 + 建表迁移 + 缺向量兜底。

## 8. 测试

- 单元：sha 前后一致→跳过；sha 变→重嵌；缺向量→重嵌；删页→孤儿清理。
- 用本地 mock embed（沿用 rrf-hop-search.test 的 mock 模式）验证 embed 调用次数 = 仅变更页数，而非全量。
- 回归：embedding 关闭行为不变；已测过的向量检索/写链路不回归。

## 9. 兼容性

- 仅 MemoryKnowledge wiki 引擎；不动检索/建表/embedding 客户端已有逻辑。
- 对未配置 embedding 的部署零影响（提前 return）。