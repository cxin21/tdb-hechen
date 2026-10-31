# task-103：L2 场景索引独立成段

日期：2026-11-01（门禁读数时刻见 §5）。范围：`dsh-plugin` 内，只碰
`memory-client.ts` / `segments/l2.ts`（新建）/ `segments/persona.ts` / `segments/index.ts` /
`config.ts` / `index.ts` / README 与本票测试。未 commit。

## 1. 为什么动

`/v3/core/read` 返回的 persona 尾部带一整块 `## 🗺️ Scene Navigation (Scene Index)`：
14 个 `### Path:` 段、每段带 **热度** / **更新** / `Summary:`，实测约 6.2k 字符（persona 10k 的六成）。
旧实现把它压缩进 persona（一行 `- <path>（热度 N，更新 YYYY-MM-DD）`），同时另一条腿又把
`/v3/scenario/ls` 的路径以裸 `- <path>` 追加在同一标题下 —— 两处索引、字段互不覆盖
（一处有热度没摘要，一处有摘要没日期），模型没法据一行判断该读哪一篇。

现在：**persona 只留叙事**（`stripSceneNavigation()` 从标题切到 EOF），**索引只由 L2 段产**，
一行一景：`- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>`。

## 2. 落点（path:line 为本次改动后的行号）

| 位置 | 改动 |
| --- | --- |
| `dsh-plugin/src/memory-client.ts:766` | 新增 `listScenariosRich(timeoutMs?)`：`POST /v3/scenario/ls`（body 三轴），返回 `L2FetchOutcome`——成功是 `{ok:true,entries}`，失败是 `{ok:false,reason}`，**不把失败拍平成 `[]`**；目录条目（`path` 以 `/` 结尾）在此层过滤 |
| `dsh-plugin/src/memory-client.ts:429` | 新私有 `scenarioFailureReason()`：`aborted→timeout`、`status≥400→http_<code>`、其余交给 `classifyL2Failure`，与段的标签同一套词汇 |
| `dsh-plugin/src/memory-client.ts:749` | `listScenarios()` 保留原签名与「失败→`[]`」语义（`recallCombined` 与 `test/config.test.ts:144` 仍在用），只补 doc 指向 rich 版 |
| `dsh-plugin/src/segments/l2.ts`（新建 113 行） | `registerHeadPackSegment({name:'l2', order:20, cap:3000, enabled: c=>c.headPack.enabled && c.headPack.includeScenarioIndex, fetch})`；复用 record-pipeline 的 `renderL2Section`/`l2StatusLabel`/`classifyL2Failure`/`parseL2Outcome`，本文件只做接线；导出 `l2StatusSummary()` / `l2StatusForDebug()` / `l2Budget()` / `resetL2StatusForTests()` |
| `dsh-plugin/src/segments/persona.ts:29` | fetch 只取 `/v3/core/read`，`stripSceneNavigation()` 后再 `composeHeadPack(narrative, [], {includeScenarioIndex:false})`；不再调 `listScenarios` |
| `dsh-plugin/src/segments/index.ts:9` | barrel 加 `import './l2.js'`（顺序 persona → l2 → skills → wiki → knowledge） |
| `dsh-plugin/src/config.ts:130` / `:374` / `:611` | `headPack.l2Chars`（缺省 3000，夹取 `[0,3000]`；0 合法＝开关开着但不占字符） |
| `dsh-plugin/src/index.ts:19` / `:467` / `:1167` | import 段标签；`agemem: head pack composed` debug 加 `l2:`；ready 行 `capabilities` 加 `l2=ok(N,chars)|empty|truncated(0,N)|fail:<reason>|pending|off` |
| `dsh-plugin/README.md` | 段表拆出「场景索引（L2 段）」、注入时机表、量化段与「索引只写一遍」三条说明改写成新实现 |

## 3. 关键设计口径

- **cap 静态、预算动态**：注册 `cap` 必须是静态 `L2_MAX_CHARS`（3000），配置值 `l2Chars` 在 fetch 内
  作为 `renderL2Section(entries,{budget})` 的预算生效。两个上限都夹到 3000，不会出现「注册 3000、
  配置要到 6000」这种自相矛盾。
- **整行丢弃**：预算不够就少一行（`renderL2Section` 的 `continue`），从不把一行切半；全部丢光时标签是
  `l2=truncated(0,N)` 而不是 `empty`——「有场景但装不下」和「团队没场景」是两件事。
- **失败零字符**：抓错/非数组 payload/客户端没有 rich 方法，一律 `{text:'',chars:0,failed:true}` + 一条
  `agemem: l2 segment failed`，prompt 不会因为索引挂了而变空。
- **`- scene_blocks` 行首锚保住**：`scripts/verify-installed.mjs:113` 依赖它判 L2 生效；行格式由
  `formatL2Line` 固定（前缀补 `scene_blocks/`，日期只到日，摘要 ≤120 且折行归一）。
- **persona 拿剩余量**：L2 是固定 cap 段，persona 仍是 `'remainder'`。段序 persona(10) → l2(20) → skills(100)，
  溢出时从尾部丢，前缀永不动。

## 4. 已知假警报（不属本票，task-104 清）

`src/head-pack.ts` 的 `HeadPack.render()` 在「有场景标题但行里没有 `热度/更新`」时会打一次
`head pack has no parseable scene index; falling back to bare truncation`。task-103 之后 persona 不再带
`### Path:` 块，这条 warn 会在每次挂载打一次（进程内只打一次，行为无害：退回裸截断）。它来自
`hand-pack.ts` 里 `fetchScenarios` 那条**死路径**（`src/index.ts` 构造 HeadPack 时从未传）。
本票按边界不动 `head-pack.ts`，测试里把这条断言成「≤1 次」并注明归属，等 task-104 删除死路径后归零。

## 5. 门禁读数（时刻为本机本地时间）

| 项 | 结果 | 时刻 |
| --- | --- | --- |
| `node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | EXIT=0 | 03:45:34 |
| 全量 `node ../MemoryCore/node_modules/vitest/vitest.mjs run` | **34 files / 598 tests passed**，Duration 45.36s | 03:45:40–03:46:25 |
| `npm run build`（`tsc -p tsconfig.json`） | rc=0 | 03:47:05 |
| `parse-check` 逐个改动文件 | 全部 `diags=0 PARSE OK`：persona.ts 39 行 / l2.ts 113 行 / segments/index.ts 19 行 / memory-client.ts 1223 行 / config.ts 706 行 / src/index.ts 1257 行 / l2-segment.test.ts 160 行 / memory-client.test.ts 839 行 / config.test.ts 331 行 / index.test.ts 1230 行 | 03:46:3x |

新增测试 13 条：`test/l2-segment.test.ts` 10 条（注册槽与 order、双开关门控、ok 路径行格式与 `- scene_blocks` 锚、
`empty` 零字符、`fail:http_404`/`timeout`/`no_client` 零字符 + 日志、整行丢弃、预算夹取、runner 内共存），
`test/memory-client.test.ts` +2（rich 读的归一化与目录过滤、失败原因 vs 老签名 `[]`），
`test/config.test.ts` +1（`l2Chars` 缺省与夹取）。另改 `test/index.test.ts` 两条既有用例（见 §6）。

## 6. 改到的既有测试与理由

- `test/index.test.ts:349`「serves persona plus the L2 scenario index」：断言从裸 `- scenes/deploy.md`
  改成 `- scene_blocks/scenes/deploy.md — 部署流程`（前缀由段补），并新增 ready 行 `l2=` 标签断言。
- `test/index.test.ts:390`「compresses the live persona structure…」整条重写为「strips the persona scene block…」：
  旧断言（14 行热度索引留在 persona 内、无 warn）与新实现相反；新断言是 persona 叙事保留、`## 🗺️ Scene Navigation`
  不再出现、索引来自 `/v3/scenario/ls` 的两条 fixture、总长 ≤20000、已知 warn ≤1 次。

## 7. 未验项（8420 不在，不许拿 fake 冒充真读数）

- `/v3/scenario/ls` 的真实返回：`curl -m 5 -X POST http://127.0.0.1:8420/v3/scenario/ls` → **000**（未起）。
  因此 `l2=ok(14,~2400)` 这类**真**读数本轮没有拿到；测试里全部是 fake client。等 8420 回来后
  与 task-72 verify-skills、knowledge 段真体、wiki 真跑三条挂账一并补。
- 本机 desktop 仍跑旧 build，本票代码未部署、未重启宿主（按 Lead 指令）。