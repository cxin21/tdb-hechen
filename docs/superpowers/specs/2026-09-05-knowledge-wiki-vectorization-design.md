# 设计文档：知识库（wiki）向量化语义检索

> 日期：2026-09-05
> 模块：MemoryKnowledge（knowledge 服务，8421）
> **状态：设计中**（spike 可行性已验证；待实现）
> 决策已确认：后端用 sqlite-vec / vec0 虚拟表；入库时增量 embed；检索用 FTS5+向量 RRF 混合；
> 向量与 FTS 共用"整体重建"生命周期（切片新增/更新/删除通过 `writeIndex` 全量对账，无孤儿向量）。

---

## 1. 背景与目标

知识库（wiki，服务 `MemoryKnowledge` :8421）当前检索是**纯 FTS5 + BM25 关键词**（`manager.ts` `bm25(wiki_fts,...)`），
**没有任何向量能力**（全仓无 embedding/vector 代码）。

问题：wiki 存的是 NC 财务/信用/采购等**语义密集型**中文文档，大量查询属于**业务语义描述**
（"主键怎么变更""暂估和回冲会不会重复""发票结算怎么冲掉暂估应收"）。纯 BM25 靠字面词命中，
**同义改写/长查询语义召回差**。

目标：给 wiki 检索叠一层语义向量召回，与现有 FTS5 **RRF 融合**，改善中文业务查询的语义召回。
**不动现有 FTS5/BM25、不动入库/页面结构、不新增外部服务。**

---

## 2. 现状调研结论（基于源码）

| 项 | 结论 |
|---|---|
| 记忆（MemoryCore）向量化 | ✅ 已实现：`l1_vec`/`l0_vec` `vec0` 虚拟表 + `embedBatch` 后台填充 + FTS/向量 RRF（`memory-search.ts` / `sqlite.ts`），可复用其范式 |
| 知识库 wiki 检索 | ❌ 纯 FTS5 + BM25（`manager.ts` `ftsSearch` → `bm25(wiki_fts)`），无向量 |
| embedding 服务 | 附用记忆侧火山 doubao `openai_compatible`（2048 维）可达（已实测 HTTP 200） |
| wiki 页正文存哪 | 磁盘 `.md`（`wiki/` 目录），`index.db` 只存 token/元数据/图谱，不含正文 |
| 索引生命周期 | `scanWikiDir(扫全部 .md)` → `writeIndex(整体重建)`：每次 `DELETE FROM wiki_fts/page_meta/graph_edge` 全量重写 |
| 删除/更新 | 都收敛到重扫 → `rebuildIndex` → `writeIndex` 整体重建 |

---

## 3. 可行性验证（spike 实测）

> spike 在 `tmp/` 下做了真实 A/B（复用记忆 embed 服务 + 真实 wiki 页正文 + 8 篇候选页）。

| 查询 | 向量 top1（cosine） | 相关性 |
|---|---|---|
| 主键怎么变更，历史合同怎么办 | 数量价格联动(0.41)、合同关联字段映射(0.40) | ⚠️ 部分相关 |
| 成本怎么算，暂估和回冲重复？ | 434c出库暂估回冲(0.43)、ethit暂估应收回冲校验(0.39) | ✅ 强相关 |
| 发票结算时暂估应收怎么冲掉 | ethit暂估应收回冲校验(0.50)、434c出库暂估回冲(0.50) | ✅ 极强相关 |
| 信用额度怎么计算和检查 | 多层级信用检查(0.46) | ✅ 强相关 |

**结论：向量召回对语义改写查询 ≥ BM25，对部分歧义查询提升有限（受页面粒度限制）。可行性成立。**

---

## 4. 数据模型

在 `index.db`（每个 wiki 一个）新增 **`wiki_vec`** `vec0` 虚拟表（与记忆 `l1_vec` 同构）：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
  page_id TEXT PRIMARY KEY,
  embedding float[2048] distance_metric=cosine,
  updated_time TEXT DEFAULT ''
);
```

依赖：`sqlite-vec` 扩展（MemoryCore 已用，MemoryKnowledge 需引入）。

---

## 5. 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| **embedding client** | `MemoryKnowledge` 新增（复用/移植 `MemoryCore OpenAIEmbeddingService` 逻辑） | 文本 → 2048 维向量 |
| **wiki_vec 表 + 建表** | `index-db.ts` `initIndexDb`（幂等，+1 表） | 存页面向量，cosine 检索 |
| **ingest 落向量** | `manager.ts writeIndex`（整体重建时） | 对每页 content 调 embed → upsert wiki_vec |
| **检索融合** | `manager.ts searchInternal` | FTS5 + vec0 并行 → RRF 融合（参照记忆 `mmemory-search.ts`） |
| **config** | `MemoryKnowledge/config.ts` 新增 `embedding` 段（复用现有 `llm` 的 env 读取范式） | 读 embedding 配置 |

---

## 6. 数据流

```
入库/重建：
  源 → LLM 生成 wiki 页(.md) → writeIndex(整体重建)
      → ① DELETE FROM wiki_fts/page_meta/graph_edge/wiki_vec (清空)
      → ② 每页：插 FTS/meta/graph + embed(content)→ upsert wiki_vec
      （同一次 withWriteDb 事务，delete 与 insert 原子对账）

查询：
  search(query) → FTS5(bm25) ∥ (embed(query) → vec0 cosine) → RRF 融合 → top-k
```

---

## 7. 关键设计点

### 7.1 切片新增/更新/删除的向量同步 —— 整体重建，零孤儿

这是本设计对"切片变更一致性"的核心答案：

- wiki 的**所有变更**（新增/更新/删除切片）都收敛到 `scanWikiDir(全扫) → writeIndex(整体重建)`。
- 在 `writeIndex` 事务内，**`DELETE FROM wiki_vec` 后全量重写**，入参 `pages` 是扫描到的全部页：
  - 删除的页 → 不在 pages → 向量自动消失（`DELETE FROM wiki_vec` 清掉）
  - 更新的页 → content 变了 → 重新 embed 覆盖
  - 新增的页 → 追加
- **向量与 FTS 生命周期完全绑定**：建库建表、重建重建、删库删表，无需逐切片 diff、无孤儿清理器。

### 7.2 embedding 失败降级

单页 embed 失败 → 跳过该页向量，仍走 FTS（graceful degradation，与记忆一致）。全失败则退纯 FTS5，行为与现状完全相同。

### 7.3 首次回填

已有 988 页：首次启用时后台任务全量 embed 一次（可复用 `rebuildIndex`，把向量与 FTS 一起建）。耗时/成本注意点：全量重建每页都调外部 embed。

### 7.4 配置

复用现有 `embedding` 配置段（`provider/baseUrl/apiKey/model/dimensions`），未配置/不可用 → 不建向量表、不 embed、检索退纯 FTS5（零影响）。

### 7.5 三连接必须都加载 sqlite-vec 扩展（显式约束，防回归）

`sqlite-vec` 是 SQLite 的**动态插件**，**每个数据库连接打开后必须显式 `loadVecExtension(db)` 激活**才可用向量表。代码会打开三类连接，**每一类都必须加载扩展**：

| 连接 | 用途 | 函数 |
|---|---|---|
| 建表连接 | 创建 `wiki_vec` 向量表 | `initIndexDb`（建库时） |
| 写连接 | 把向量写入表 | `withWriteAsync`（落向量时） |
| 读连接 | 检索时查向量 | `getReadDb`（搜索时） |

**历史教训**：初版实现漏了写/读连接的加载，导致两个潜伏 bug——
- 写连接未加载 → 写 `wiki_vec` 报 "no such module" 被静默吞 → **向量从未实际写入**（0 行）
- 读连接未加载 → 向量检索同样报错被吞 → **静默退化回纯 FTS**，向量搜索形同虚设

**硬性约束**：任何新增的数据库连接（建表/写/读）都必须先 `loadVecExtension(db)`。若未来修改连接逻辑，务必保持三类连接的扩展加载齐全，否则向量写入或检索会静默失效。

---

## 8. 测试

- 单元：embed client、RRF 融合、vec0 upsert/delete
- 集成：re-ingest 后 search 返回混合结果；删除切片后向量不残留
- 回归：embedding 关闭时行为与现状完全一致（纯 FTS5）

---

## 9. 兼容性

- 仅 `MemoryKnowledge`（wiki 服务）改动；不动 `MemoryCore`（记忆）、`MemoryProxy`。
- 现有 FTS5/BM25、图谱、ingest、页面结构、API 全不变。
- 向量化是叠加能力：未配置 embedding 时零影响。