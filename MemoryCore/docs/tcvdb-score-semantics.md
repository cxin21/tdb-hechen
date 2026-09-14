# TCVDB searchL1Vector score 语义实证（代码级）— T1-A

> 日期：2026-09-10。任务：灵魂记忆·收尾与补全计划 阶段四 T1-A。
> 性质：**代码级推演文档**（无 tcvdb 本地实例，SDK 调用链实读）；**只文档化不改行为**
> （改语义=行为变更，等真机实证）。**切换前须真机复验**（spec §6.4 先例）。

## 结论

`TcvdbMemoryStore.searchL1Vector` 返回的 `L1SearchResult.score` **不是** sqlite 后端的
`1 - distance` cosine 相似度刻度（sqlite.ts:2408），而是按调用链分两种语义：

### ① hybridSearch 路径（存在 BM25 sparse 向量）— score = RRF 融合分，非相似度

调用链（tcvdb.ts）：
- `searchL1Vector`（:978 原行号）→ `searchL1HybridAsync`（:1013 原行号）；
- 有 sparse 向量时走 `client.hybridSearch`（tcvdb-client.ts:263 → HTTP
  `/document/hybridSearch`），search 参数：`ann`（dense，服务端 embeddingItems on
  `"text"` 字段，:1052-1056 原行号）+ `match`（sparse BM25，:1061-1065 原行号）+
  `rerank: { method: "rrf", k: 60 }`（:1066 原行号）；
- 返回文档的 `score` 经 `_parseL1SearchResults` 原样读入（`score: Number(doc.score ?? 0)`，
  :2044 原行号）。

TCVDB 服务端 RRF rerank 按腾讯 VDB 公式推演：`score = Σ 1/(k + rank_i)`（k=60，rank 从 1 起）：
- 双路（dense+sparse）都排第一的上限 = 2/(60+1) ≈ **0.0328**；
- 单路命中上限 = 1/61 ≈ **0.0164**；
- **刻度 (0, ~0.0328]，与 sqlite 的 cosine 相似度 (0,1] 绝对不可比**。
  本仓客户端 RRF 同族公式可互证：memory-search.ts `rrfMergeL1`（`1/(RRF_K + rank + 1)`，
  RRF_K=60，:87-115 原行号）。

### ② dense-only 回退（embedding 开但无 BM25）— score = 稠密检索相似度

- 无 sparse 向量时走 `client.search`（tcvdb-client.ts:254 → HTTP `/document/search`，
  `embeddingItems: [queryText]`，tcvdb.ts:1072-1081 原行号）；
- score 为 TCVDB 稠密检索相似度，方向"越大越近"（VDB 惯例）；
- 精确刻度（cosine 相似度 vs 1-distance、取值域）**无真实实例不可证**，登记真机复验。

## 对现有绝对门槛的影响（切换 tcvdb 前必读）

| 门槛 | 位置 | 影响 |
|---|---|---|
| `scoreThreshold`（默认 0.3） | memory-search.ts:453 `gatedVec`（双路向量候选门）；auto-recall.ts:804（混合回退向量候选门） | 任何携带 RRF 融合分（≤0.0328）的候选被 `score >= 0.3` **100% 滤除**。可达形态：`!embeddingEnabled` + BM25 的 sparse-only hybrid（此时 `nativeHybridSearch=false`，走双路回退，`searchL1Vector` 带 queryText → hybrid 路径 → RRF 分） |
| `MIN_SIMILAR_STRENGTH`（0.3，可配 minSimilarity） | l1-dedup.ts:560 `topScore < minSimilarity → 不建边` | tcvdb 向量召回的 topScore 恒 < 0.3 → **similar 边静默建不出**（宁缺毋滥方向的安全失败，但图能力在 tcvdb 上不可用） |
| native-hybrid 主路径 | memory-search.ts:313、auto-recall.ts:584 | **不做绝对门槛**，score 仅排序/展示（0.0xx 刻度直接露出）——排序语义正确（RRF 保序），绝对值仅展示层 |

## 切换前须真机复验（部署时任务）

1. RRF 融合分公式与上限（造 1/2/3 条命中，实测 score 分布是否吻合 1/(60+rank) 推演）；
2. dense-only `/document/search` 的 score 刻度（cosine 相似度还是 distance 变换）；
3. 若刻度与推演不符：`scoreThreshold` 消费点（memory-search.ts:453、auto-recall.ts:804）
   与 l1-dedup 建边门（l1-dedup.ts:560）需按真机刻度重校 —— 届时为行为变更，
   走独立 spec 评审，不在本任务（只文档化）范围内。
