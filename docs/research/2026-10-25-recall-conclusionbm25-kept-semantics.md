# gates.conclusionBm25 `kept` 语义取证：预选择候选总数（work_fact 池 + scene_block 豁免），非 FTS 池大小

> 2026-10-25 · Lead（#75 triage 诊断落盘，拍板 Q1a）· **只读取证**：未动生产、未改配置、未改业务代码。生产 journal 原始条目按体积轮转，本文固化 2026-10-25 取证窗口的全部数据以防丢失。关联：#75（诊断收口）、#95（观测语义增强票，待实施）、#73（Step 0 外推前提）、#74（skipReason 在产佐证）。

## 0. 问题与结论

**问题（#75）**：生产 journal #303（ts=2026-10-20T03:19:32.910Z）`gates.conclusionBm25.kept=16`，而工作区代码结论层 FTS 池上限 = halfLimit×2 = 4 —— 生产是否跑着落后于 R71 的部署构建？

**结论**：

1. **假设 1（生产构建落后 R71）否证** —— 生产经 `tsx` 直跑 `D:\TDB\td-agemem` 工作树，根本没有构建产物；R71-A1/A2 双门、#74 skipReason 字段均在产。
2. **假设 2（scene_block 豁免计入 kept）实证成立** —— `kept` 的真实语义 = **进入 bm25 地板筛选的预选择候选总数** = work_fact FTS 行（≤ halfLimit×2 = 4）+ 通过 identity 门的 scene_block 候选（不带 bm25Rel、豁免地板、数量不限）。生产 scene_index 现有 14 条 → kept ∈ 14-18，与 619 条 gate 记录分布完全吻合。kept=16 不是异常，是字段语义被误读。

## 1. 代码事实（工作区 HEAD，2026-10-25）

| 锚点 | 事实 |
| --- | --- |
| `MemoryCore/src/core/hooks/auto-recall.ts:693-694` | r7MaxResults = cfg.recall.maxResults ?? 5；r7HalfLimit = floor(maxResults/2) |
| `:715` | wfRows = vectorStore.searchL1Fts(wfQuery, r7HalfLimit*2, isolationFilter) → 池 ≤ 4 |
| `:719-731` | work_fact 行带 bm25Rel = -rank（FTS5 rank 缺失则 undefined，同样豁免地板） |
| `:743-750` | scene_block 从全部 sceneIndexEntries 过 identity 门后入 r7Candidates：**无 bm25Rel、数量不限** |
| `:756-764` | R71-A1 地板只删 rel<min 的候选；r71Bm25Gate = {minRel, kept: r7Candidates.length, dropped: before-after} |
| `:768-774` | selectL2Conclusions(cap halfLimit) 在 gate 之后 |
| `:779-800` | V2-3 放宽通道在 gate 之后追加，不计入 kept |
| `:808` | 最终 slice(0, halfLimit) |
| `MemoryCore/src/core/store/sqlite.ts:5860` | `searchL1Fts(ftsQuery: string, limit = 20, filter?)`（#75 票面引 ：5713 为 2026-10-20 当时行号，文件已漂移） |
| `MemoryCore/src/core/config/config.ts:308-321` | recall.relevance.minBm25Rel 文档（语料拟 6.5、禁硬编码）；rerankGate 缺省 shadow |

⇒ `kept = |wf 行| + |scene_block 候选|`（gate 删减后），其中只有 wf 行受地板约束。

## 2. 生产 journal 实证（2026-10-25 全量扫描）

窗口：5 文件 2183 条，`D:/TDB/data/logs/recall/recall-journal-team-2k12lgb650-agt-2m7buribzz{,.1,.2,.3,.4}.jsonl`，最早 2026-10-20T06:54:17.121Z（.4）→ 最晚 2026-10-24T14:47Z（.jsonl）。**#303 原条目已随轮转丢失**，以 619 条 gate 记录的分布替代验证。

| 指标 | 分布 | 解读 |
| --- | --- | --- |
| gates.conclusionBm25 条数 | 619 | minRel 恒 6.5 |
| kept | {15:427, 16:150, 14:25, 17:13, 18:4} | = wf(≤4) + scene；scene_index 现 14 条 → 上限 18 = 4+14 恰吻合；众数 15 推断当日 scene≈11-12（scene_index 无历史快照，推断项） |
| dropped | {0:591, 1:8, 2:17, 3:3} | 地板实际删减仅 28/619（4.5%），只作用于 wf 行 |
| conclusionCount（gate 条目内） | {0:9, 1:5, 2:605} | 恒 ≤2 → halfLimit=2 → **maxResults=5 → 池=4 实证**，与工作区一致 |
| gates.conclusionRerank | 1184 条，全 shadow | R71-A2 在产 |
| #74 skipReason 字段 | 972 条，2026-10-20T07:27:00.665Z → 2026-10-22T02:36:39.001Z | 首现比 #74 提交（10-20 15:36:58 +0800）**早 10 分钟** → 工作树未提交变更重启即生效 |
| #88 rawQuery/rawLen/rawHash8/residualChars | 0 条 | 仅 skip 行携带；保留窗口尾部无 skip 行，中性 |

首条 gate：`.4:20` 2026-10-20T07:21:09.376Z，minRel=6.5，kept=15。

## 3. 生产部署形态：tsx 直跑工作树，无「部署构建」可言

- 启动脚本族：`D:\TDB\etc\{start-tdb.ps1, start-tdb-supervised.ps1, tdb-services.common.ps1, logtee.mjs, RESTART-SOP.md}`；`tdb-services.common.ps1` 内 `TdbRepo='D:\TDB\td-agemem'`，secrets 仅 `env.ps1`（不落持久第二文件）。
- 进程（2026-10-25 采样）：
  - PID 31116，起 2026-10-22 18:24:48：`node --import file:///D:/TDB/etc/logtee.mjs --import tsx src/server.ts` = `MemoryCore/src/server.ts`
  - PID 33140，起 2026-10-24 23:33:46：同款，`src/gateway/server.ts` = `MemoryCore/src/gateway/server.ts`
- **无 dist/构建产物 → 「部署构建版本/滞后」不成立**；重启即生效工作树当前态。

### git 时间线（+0800）

| 提交 | 时间 | 内容 |
| --- | --- | --- |
| 5b3ea53 | 2026-10-19 22:56:12 | R71 双门（#71） |
| 7a1d187 | 2026-10-20 15:36:58 | #74 skipReason |
| da466b9 | 2026-10-20 16:28 | #76 |
| 15b296d | 2026-10-20 17:27 | #77 |
| 1fd846e | 2026-10-22 13:02:47 | #88（skip 行 rawQuery/rawLen/rawHash8/residualChars） |

#303 ts（本地 10-20 11:19:32）在 R71 提交后约 12.5h，该时刻已有 gate 记录 → R71-A1 当晚已在产。

## 4. 判定

- **假设 1 否证**：无构建产物可滞后；池=4 实证（conclusionCount 恒 ≤2 → halfLimit=2 → maxResults=5）；R71 双门与 #74 字段在产。
- **假设 2 成立**：kept 语义 = 预选择候选总数；scene_block 豁免且不限量；619 条分布与 scene_index 14 条精确吻合（kept 上限 18 = 4+14）。

## 5. 对关联票的影响

- **#73（Step 0 golden 基线生产外推）**：生产 = 工作树直跑、无漂移 → Step 0 用工作区代码复放的外推前提成立（#74 skipReason 在产，Batch A 复放期生产侧有对应观测）。
- **#74**：其 skipReason 观测面在本取证窗口持续有效。

## 6. 后续

- 观测语义增强票 #95（ready-for-agent）：`gates.conclusionBm25.kept/dropped` 按来源拆分（work_fact vs scene_block）+ 字段注释，防止 kept 再被误读为 FTS 池大小。
- #75 按拍板（Q1a）落本文后关闭（取证完成，不贴 wontfix）。