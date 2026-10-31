# L2/L3 段 parity 收口（task-90，2026-11-01）

> 目的：把「L2 索引到底该从哪来」用代码证据定死，供 dsh-plugin 下一票实施。
> 口径：**实测** = 仓库内抓包或本轮跑代码得到；**代码** = 读到实现；**推断** = 由前两者推得、未真机验。
> 只读代码 + 只写 docs；未跑真机写；8420 未重启 ⇒ task-73 的 `/v3/wiki/*` 是「未生效」不是「不存在」。

## §0 一句话结论
Lead 已拍板的两段两个源成立（`<l3_core_memory>` ← `/v3/core/read`；`<core_memory>` ← `/v3/core-memory/read`）。
**L2 索引的情况是另一回事**：插件今天不是「取了端点又去重」，而是**端点结果被 persona 尾部全量去重掉了**（实测 14/14 条被 `personaListsPath` 过滤，最终 L2 段 0 行、连 `## 长期记忆 · 场景索引（L2）` 头都不出现）⇒ 唯一有信息量的 `summary`（实测 141–736 字符/条）**恒不注入**，而端点不返回的 `heat` 成了唯一附加物。
对齐 proxy 的唯一正解：**剥掉 persona 尾部 + 独立取 `/v3/scenario/ls`**，且渲染时必须把 `scene_blocks/` 前缀补回（端点 `path` 是相对 `scene_blocks/` 的裸文件名），否则自家验收锚 `- scene_blocks`（`dsh-plugin/scripts/verify-installed.mjs:113`）会从 PASS 掉成 PENDING（本轮实测：剥尾部后该串消失）。

## §1 Q1 proxy 侧数据源与行格式（代码）
- 调用链：`loadAgentProfile` `Promise.all([client.readL3ForCtx, client.listL2ForCtx])`（`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:302`）→ `TdaiClient.listL2ForCtx` `POST /v3/scenario/ls`，body `{team_id, agent_id, path_prefix: ""}`，`includeSession/includeTask:false`（`MemoryProxy/src/tdai/client.ts:335-346`）。
- 门：`!isEnabled() || !config.injectL2L3` ⇒ 直接 `[]`（`MemoryProxy/src/tdai/client.ts:334`）。proxy 代码缺省 **`injectL2L3: false`**（`MemoryProxy/src/config.ts:125`）、`l2Limit: 3`（`:129`）；生产 yaml 打开但条数仍 3（`MemoryProxy/config.yaml:625`、`:630`）。
- 响应整形：`data.entries[]` → `{path, summary?, updatedAt?}`（`MemoryProxy/src/tdai/client.ts:347-352`）→ 过滤 `!path.endsWith("/")`（目录，`MemoryProxy/src/tdai/client.ts:353`）→ **`.slice(0, l2Limit)`**（`:354`）。`loadAgentProfile` 再只留 `{path, summary}`（`tdai-profile-memory-injector.ts:309`）⇒ `updatedAt` 被丢。
- 渲染：`<l2_scene_index>` … `</l2_scene_index>`（`:117/:127`），有 summary 时 `- \`${path}\` — ${truncate(summary, 200)}`（`:122`），无则 `- \`${path}\``（`:124`）；summary 按 UTF-16 截 200 + `"...[truncated N chars]"` 标记（`:326-328`）。

## §2 Q2 core 侧该端点真实行为（代码 + 实测）
- handler：`async function handleScenarioLs`（`MemoryCore/src/gateway/v2-router.ts:3597`），路由 `"/scenario/ls"`（`:249/:576`）。
- **不分页**：`// One-shot full listing (no pagination; marker-based pagination planned for phase 2)`（`:3612`）→ `backend.listObjects(sceneBlocksDir, {recursive:true})`（`:3613-3614`）。实测 14 条 / `total: 14`。
- `summary` 来源 = **`.metadata/scene_index.json` 的 front-matter 摘要**：`readSceneIndex`（`:3620`）→ `indexMap.get(externalPath)` → `summary: indexEntry?.summary || undefined`（`:3636-3640`）；索引本体由 `syncSceneIndex` 扫 `scene_blocks/*.md` 的 `parseSceneBlock(...).meta.summary` 生成（`MemoryCore/src/core/scene/scene-index.ts:102-136`、`scene-format.ts:24-44`）。索引在 L2 write / rm 时同步刷新（`v2-router.ts:3795`、`:3843`）。
- `created_at/updated_at` 也优先取索引，缺失回退文件 mtime（`:3637/:3644-3645`）；`version` 取 `getProfileVersionBatch("l2")`（`:3629`）。
- **端点不返回 `heat`**（实测 entries 的键只有 `path,summary,version,team_id,agent_id,created_at,updated_at`），尽管 `scene_index.json` 里存了 `heat`（`scene-index.ts:12`）。
- team/agent 定位：不是 body，而是头 → `deps.requestIsolation`（`v2-router.ts:862-880`），storage 被 `scopedProfileStorage` 加隔离前缀（`:3387-3393`）；body 只用 `path_prefix`（`src/gateway/generated/schemas.ts:235-237`）。
- 实测响应（仓库内抓包 `scratch/probe-read/out/scenario-ls.json`，14 条）：`path` = **裸文件名**（如 `AI-工程纪律-TDD与交付规范.md`，无 `scene_blocks/` 前缀）；summary 14/14 条、长度 141–736；目录 0 条。

## §3 Q3 插件 `head-pack.ts` 等价性判定 —— **部分 parity**
| 维度 | proxy（生产档） | 插件今天实际注入的 L2 |
|---|---|---|
| 条数 | 端点全量 → `slice(0, 3)` | persona 尾部 14 条（fixture/注释实测 14） |
| path 形态 | 裸文件名 + 反引号 | `scene_blocks/<file>`（persona 来源） |
| summary | 有（≤200 截断） | **无**（压缩时丢弃 Summary 正文） |
| heat | 无（端点不返回） | 有（`（热度 N，更新 YYYY-MM-DD）`） |
| 更新日期 | 有字段但被丢（`:309`） | 有（到日） |
| 目录过滤 | 有（`:353`） | **无**（`parseScenarios` 只取 path：`dsh-plugin/src/memory-client.ts:397-410`） |
（表内 proxy 列是代码，插件列是本轮跑代码得到的实测数值见 §6）
- 压缩路径：`structureHeadPack` 认 `### Path:` + `**热度**: N` + `**更新**: YYYY-MM-DD`，产出 `- <path>（热度 N，更新 …）`（`dsh-plugin/src/head-pack.ts:43-52/:96-99`）；摘要正文按设计丢弃（`:18-30` 头注）。
- 去重实测（本轮跑 `structureHeadPack`/`composeHeadPack`）：端点是**裸文件名**，persona 行含 `scene_blocks/<file>` ⇒ `personaListsPath` 全部命中（14/14 过滤，kept 0），`composeHeadPack` 输出 4603 字符且**不含** `## 长期记忆 · 场景索引（L2）` 段。
- 结论：**部分 parity** —— 集合一致（同 14 篇）、路径可操作性一致（插件还多给热度），但插件缺 summary、少目录过滤，端点段被自己弃用（死代码态）。

## §4 Q4 对齐方案（一句话 + 依据 + 硬约束）
- **方案**：剥掉 persona 尾部 Scene Navigation，L2 索引改由 `/v3/scenario/ls` 独占渲染。
- 依据①：summary 信息量大 —— 端点 141–736 字符/条（人工写的场景摘要，看摘要就能决定读哪篇）；persona 尾部零摘要，模型只能靠文件名猜。
- 依据②：更新更快 —— 端点每次读 `scene_index.json`，L2 write/rm 当场刷（`v2-router.ts:3795/:3843`）；persona 尾部随 L3 重建才变，滞后。
- 代价 —— **已拍板 A：接受丢 heat**（2026-11-01 Lead 裁决，终局；实施票 **task-96** / record-pipeline）。`heat` 只有 persona 里有、端点不返回，所以「剥尾部 + 端点独占」必然丢热度。裁决理由三条：①**parity 优先** —— 与 proxy 同档即达标（proxy 生产档同样没有 heat 字段），本插件没有理由比 proxy 多一个字段；②**B 案改产品** —— 让 core 在 `ScenarioEntry` 里回 `heat` 属产品改动，超出 parity 票边界；③**C 案造第二真源** —— 插件侧回读 `scene_index.json` 是 core 的 `.metadata`，跨进程读文件＝绕过存储契约，不允许。
- **硬约束（实测）**：剥尾部 + 端点独占后，场景行是裸文件名 ⇒ `- scene_blocks` 消失（verify-installed.mjs:113 的 PASS 会掉 PENDING）。实施必须渲染 `- scene_blocks/<path>`（`MemoryCore/src/core/storage/types.ts:254` `sceneBlocksDir: "scene_blocks/"`，即 path 本就相对该目录）。
- 建议行格式：`- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary ≤120>`；成本实测估算 ≈2.2k 字符（14×约 120 字摘要），head pack 由 4603 → ≈6.3k，远低于总预算 20000（`dsh-plugin/src/config.ts:303`）。
- 目录过滤 —— **定论，不是待查**：端点**不提供**过滤参数，`path_prefix` 是唯一入参（`MemoryCore/src/gateway/generated/schemas.ts:235-237`）且强制 `recursive: true`（`v2-router.ts:3614`）；目录项以**尾 `/`** 形态出现在同一条 entries 里（`v2-router.ts:3635` `displayPath = e.isDirectory && !externalPath.endsWith("/") ? \`${externalPath}/\` : externalPath`），与文件项不可区分真假（`version: 0`，`:3641`）。proxy 在客户端显式丢弃目录（`MemoryProxy/src/tdai/client.ts:353`），插件 `parseScenarios` 不过滤（`dsh-plugin/src/memory-client.ts:397-410`）⇒ 一旦 `scene_blocks/` 下出现子目录，插件会把目录行当场景注入（与 proxy 的确定性差异，非随机）。当前实测 0 目录，故今天不产生错行；按 parity 应补 `!path.endsWith("/")`，随 task-96 落地。

## §5 Q5 `<l3_core_memory>` 截断口径
- proxy：`truncate(content, 6000)`（`tdai-profile-memory-injector.ts:114`），实现是 UTF-16 `slice(0, max)` + `"\n...[truncated N chars]"`（`:326-328`，标记不计入 6000）⇒ 对 10003 字符人格**必然硬切**，切点落在 Scene Navigation 中段（叙述 3766 + 约 2334 字符索引 ≈ 只剩前几篇且尾行被切）。
- 插件：结构压缩后 4603（本轮 fixture 实测；真实 10003 → 4565 见 `head-pack.ts:36`），叙述逐字 + 每场景一行，**不触发任何截断**。
- 判定：**不等价，插件更优**（信息面更全、无半截 markdown），但两边都丢 per-scene summary（persona 尾部 summary 本就占约 6.2k，压缩时丢）。
- 上限建议：persona 段别学 6000；以结构压缩后实量（≈4.6k）为准，段内下限不得低于 叙述 3766 + 14 行索引 799 ≈ 4565（低于此会砍索引尾部，同头注结论 `head-pack.ts:37-40`），上限交给 `headPack.maxChars` 20000 总预算。

## §6 Q6 `<soul-feeling>` vs `<current_feeling>` —— **不是一回事**
- proxy 侧 `TdaiCurrentFeelingInjector`：`point="user.before"`、`cacheStrategy="none"`（每轮重算、不进稳定区），数据 = 当轮**真实用户消息关键词命中** `appraisal.values[].label`（`MemoryProxy/src/injection/injectors/tdai-current-feeling-injector.ts:33-41/:71-80`）；匹配与渲染在 `MemoryProxy/src/knowledge/current-feeling.ts:29-53`：`当前问题触及的核心价值：<labels>。` + 可选 `本轮方向：围绕【X】推进` / `对【X】保持审慎`（valence≠0 才出）+ 免责行；label 表见 `MemoryProxy/config.yaml:643-664`（正确/可靠/可用/性能/私有部署/本地，threshold 0.4）。
- core 侧 `<soul-feeling>`：`## 当下的状态` + `近期基调：偏积极|偏承压|平稳。`（`MemoryCore/src/core/hooks/soul-assembler.ts:923-926`）+ 可选 `此刻<valence 短语>，<arousal 短语>。`（state 机，`soul-state.ts:70-76`，需 store.readSoulState，`auto-recall.ts:2007`）。**方向锚清单行已在 2026-10-17 呈现层翻修中删除**（`soul-assembler.ts:909-916` 注释），只剩基调+状态。
- 两侧样例（合成对照，非实测原文）：
  - proxy：`<current_feeling>` / `当前问题触及的核心价值：正确, 可靠。` / `本轮方向：围绕【正确、可靠】推进` / `（功能性的"在意程度"信号：…）` / `</current_feeling>`
  - core：`<soul-feeling>` / `## 当下的状态` / `近期基调：平稳。` / `</soul-feeling>`（实测 36–40 字符）
- 结论：**不是一回事** —— 前者=「本轮问句命中哪些核心价值」（每轮、绑查询词、带 valence 方向语义）；后者=「会话情绪基调/状态机当下态」（不绑查询、无价值标签）。插件的 `includeFeeling` 只覆盖后者；价值命中在我们侧**无对应**（要覆盖得走 core_memory 的 `core_value` slot，票 task-88）。
- 连带更正：矩阵 §1 第 15 行原写「已覆盖（含 valence 方向锚）」两处都不准，已按本节改写。

## §7 Q7 未验证 / 推断清单（不藏）
- 【推断】proxy 生产实际注入条数 = 3：依据是 `config.yaml:630` `l2Limit: 3` 与 `MemoryProxy/src/tdai/client.ts:354` 的 slice，未在线上抓 `<l2_scene_index>` 原文核对。
- 【推断】真实 persona 的 14 条与端点 14 条是同一批文件：fixture 与抓包各自 14 且文件名一致，但未对真实 persona 全文逐条 diff。
- 【未测】`heat` 对模型选场景的实际贡献（无 A/B 读数），本页只说信息面差异，不宣称质量收益。
- 【未测】剥尾部方案的最终字符数与注入效果（仅本地函数级实测 4603 / 剥离后 4102 / 加摘要估算 6.3k），未走真机注入。
- 【已定论·非缺陷】目录项：端点无过滤参数、目录以尾 `/` 返回、proxy 客户端丢弃、插件不丢弃（详见 §4 末条）⇒ 差异是确定性的；唯一的未知是「`scene_blocks/` 何时真出现子目录」（当前实测 0），所以既不能写「潜在缺陷」（它不是未知 bug），也不必等复现，按 task-96 一并补过滤即可。
- 【未生效】`/v3/wiki/*`（task-73）尚未重启生效；L2 段不涉及 wiki，但本票不对其做任何判定。
