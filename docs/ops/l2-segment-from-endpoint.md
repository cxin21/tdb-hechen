# L2 场景索引段改由 /v3/scenario/ls 独占（task-96 / #155 读面）

> 结论：L2 段不再从人格尾部 `Scene Navigation` 取，改由 `POST /v3/scenario/ls` 独占渲染；
> 人格尾段先剥离。同一份真人格下重复字符从 6237 降到 0，且首次拥有 summary。

## 1. 数据来源（真响应，非文档推断）

- 8420 未监听（`/health` code=000）⇒ 不启生产实例：把 `D:/TDB/data` 只读复制到系统临时目录，
  在 **8496** 起隔离实例（embedding none、recall/lifecycle/capture 关），用真身份头打真端点。
- `POST /v3/scenario/ls {}` → 200，`data.entries` 14 条，字段 `{path, summary, version, team_id,
  agent_id, created_at, updated_at}`；**`path` 是裸文件名**（无 `scene_blocks/` 前缀），summary 最长 736 字符。
- `POST /v3/core/read` → 200，`data.content` 10003 字符，`## 🗺️ Scene Navigation` 起于 3767，尾部 6237 字符。
- 原始报文留档：`scratch/task96/scenario-ls-response.json`、`core-read-response.json`、`persona-10003.txt`。

## 2. 实现（`dsh-plugin/src/head-pack.ts`）

- `:348 stripSceneNavigation` 按 MemoryProxy 同语义剥尾（标题→EOF；无标题则原样返回，fail open）。
- `:394 renderL2Section` 行格式 `- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>`；
  `scene_blocks/` 强制补齐（端点给裸名；`scripts/verify-installed.mjs:113` 以 `- scene_blocks` 为锚）。
- 排序 = 更新日 DESC、无日期最后、path 破平；预算 `L2_MAX_CHARS=3000`（含标题）**整行丢弃**，不切半行。
- 失败可区分：`l2=ok(14,2434)` / `l2=empty` / `l2=truncated(0,14)` / `l2=fail:http_404|timeout|bad_payload|error`，
  绝不静默零字符；`L2FetchOutcome` 的 `{ok:false}` 与空列表是两件事。
- （历史）原设 `:137 HeadPackDeps.fetchScenarios?` + `:261 loadL2`（未传即老路径、失败只 warn 一次）——**该入口已于 task-104 删除**：生产组装点从诞生只传五个字段，它永远是死代码、是第二个数据源入口。L2 现由独立段装配（task-103，`src/segments/l2.ts` 消费上面这些纯函数）。此条保留为历史记录，不删。
- **heat 定档 A**：接受丢热度（与 proxy 同档）。不读 core 的 `scene_index.json`——那是第二真源。

## 3. 真机读数（同一份 10003 字符人格 + 同一份 14 条端点响应）

| 指标 | 改前（读 8420 尾段） | 改后（端点独占） |
| --- | --- | --- |
| 人格正文 | 10003 字符（含尾段 6237） | 3766 字符（尾段已剥） |
| L2 条目 | 14 条（**无 summary**） | 14 条（**含 summary，单行 ≤120**） |
| L2 段字符 | 0（与尾段重复） | 2434 字符，`l2=ok(14,2434)`，dropped=0 |
| head pack 总字符 | 10003 | 6202 |
| `- scene_blocks` 锚 | 存在（借尾段） | 存在（自渲染） |

## 4. 测试与门禁

- `dsh-plugin/test/head-pack.l2-segment.test.ts`：25 例（剥尾三形态+中文标题、行格式/无日期/无 summary、
  summary 截断 120、路径不双前缀、日期排序、预算整行丢弃、四态状态标签、三类失败分类、端点报文解析、
  接线五态、真样本 14 条）。
- 全量（03:06 实测，含队友并行新增文件）：`npx vitest run` **32 files / 571 tests 全绿**；`npx tsc --noEmit` rc=0；`npm run build` rc=0。
  （同日 03:03 首跑曾见 `test/segment-adapters.test.ts` 1 例红，该文件 mtime 03:04 正被他人改写；单跑与复跑均绿，判定为并发写入非本票回归。）

## 5. 接线状态（历史 + 现状）

- **历史**：本票交付时生产组装点 `dsh-plugin/src/index.ts:449 new HeadPack({...})` 只传五个字段，而我当时把入口做在类上（`deps.fetchScenarios`），
  ⇒ 能力就绪、活路没走，属于**半成品**；lead 据此拆票，并明确「零件就绪」不等于「完成」。
- **现状**：接线由 task-103 落在独立段 `src/segments/l2.ts`（order 20、cap `headPack.l2Chars`=3000、persona 段停拼场景）；
  类上的死入口已由 task-104 删除（见 §2 第 4 条），本文件所述纯函数即新段的全部依赖。
- **教训**：能把「就绪」当「完成」上报的项目，一定会有人以为它在跑；交付时必须写清「零件 vs 活路」。