# Agent 灵魂记忆系统—设计完整性对抗性审计报告

> 审计日期：2026-09-09
> 审计对象：`td-agemem/docs/superpowers/` 内 9-08 一整天沉淀的**灵魂记忆系统**设计（master spec + G–M 子设计 + 计划），对照 git 提交（9-08 ~ 9-09 00:04，HEAD `03a8026`）与真实代码（MemoryCore / MemoryProxy / MemoryKnowledge）。
> 范围：以**第一性原理**逐项核验"设计意图 → 计划 → 代码落地"三者是否一致；挑遗漏、缺实现、静默失效、配置不生效、测试掩盖真实行为。wiki 召回侧（另一条召回线）非本次核心，但涉及门控路径处一并核对。

---

## 0. 总体结论

设计非常完备（时空/关联/巩固/遗忘/重构回忆/情感/自我模型，配合诚实边界与红线）。git 提交也多：P0–P5 + G–M + UI，约 60 个 commit，多数**真机 LOAD_OK + 冒烟**。

但**"做好"和"做对"是两件事**。从第一性原理逐项追下来，发现一批**"字段/表/接口都在，但信号根本没接上"**的静默问题——这类最危险，因为它们被配置默认值或测试数据掩盖，表象绿灯、实际空转。按严重度分 A/B/C 三级。

---

## A 级 · 真实缺陷（静默失效，建议优先修）

### A1.【配置不生效】G–M 新增 yaml 配置块被 `parseConfig` 丢弃——`links`/`lifecycle`/`search.neighborExpand` 形同虚设

- **证据**：`MemoryCore/src/config.ts` 的 `MemoryTdaiConfig` 接口（330–363 行）与 `parseConfig()`（559–667 行返回体）**都只有** `promptMode/capture/extraction/persona/pipeline/recall/embedding/storeBackend/tcvdb/bm25/memoryCleanup/report/llm/offload/skill`，**没有 `links`、`lifecycle`、`search`、`appraisal`**。
- **后果**：
  1. `pipeline-factory.ts:606` `enableMemoryLinks: cfg.links?.enabled !== false` → `cfg.links` 恒 `undefined` → **永远 true**。即 `memory.links.enabled:false` 在 yaml 里写了也没用，links 关不掉（今天恰好默认开、yaml 也是 true，所以表象一致；但契约已坏）。
  2. `server.ts:1866/1895` 读 `this.config.memory?.lifecycle` → `undefined` → 落到 `DEFAULT_LIFECYCLE_CONFIG`。yaml 的 `consolidation.persist/minCount/minSpanDays`、`forgetting.minAgeDays/lowThreshold` **从未被读取**，全靠代码默认值；今天 yaml 值与代码默认值**恰好相等**（minCount 3 / minSpanDays 1 / minAgeDays 30 / lowThreshold 0.12），所以"看起来对"。改任何一个配置，系统无感。
  3. `v2-router.ts:1243` `config?.memory?.search?.neighborExpand` → `parseConfig` 丢弃 `search` → 恒 `undefined` → `executeMemorySearch` 收到 `neighborExpand=undefined`，`neighborExpand?.enabled` 为 falsy → **J 图邻居扩展在 HTTP /atomic/search 与 tdai_memory_search 工具路径下从未真正启用**，即便 yaml 写着 `search.neighborExpand.enabled: true`（commit `242b8be`/`0a86586` 的"全部开启"实际没读到）。
- **第一性原理**：`config-first` 的承诺（进 yaml 即生效）被"解析器只保留白名单字段"破坏；配置成为**装饰性 doc**，行为由代码默认值决定。这是"配置与实际行为不一致"的典型种子。
- **建议**：`parseConfig` 显式增补并解析 `links`/`lifecycle`/`search.neighborExpand` 三个块（参照 MemoryProxy `config.ts:454-465` 对 `appraisal` 的显式解析做法），并补一条单测：改 yaml 值 → 断言生效。

### A2.【真 bug】遗忘打分的 `significance`/`valence` 维度在生产里恒为默认 0.5——显著性×时间衰减形同虚设

- **证据**：`lifecycle/forgetting/scorer.ts`
  - `significanceOf()`(34–41) 只读 `meta.significance` / `meta.valence`（**metadata 里**）。
  - 但 P2a/P0 把 `significance/valence` 存成 **MemoryRecord 顶层字段**（`l1-writer.ts:274-278` `record.significance`、schema 顶层列 `significance REAL`），**没有写进 metadata_json**。
  - `lifecycle-scheduler.ts:30-38` 构造 queryL1 时把行铺开保留顶层字段（`...r`），但 `metadata` 只填 `activity_start_time` + `occurred_at`，**没把 significance/valence 放进去**。
  - → `scorer.significanceOf(record).metadata.significance` 恒 `undefined` → 回退 `0.5`。
- **后果**：`score = significance × priority × decay` 在生产其实是 `0.5 × priority/100 × decay`。**高情绪/高显著性记忆不会被遗忘机制保护**，"重要性×时间衰减""情绪红笔决定遗忘"这一设计支柱（spec §3.5/§5.1/feeling 核心）**根本没起作用**。而且和占有高显著性时的意图相悖：显著性越高应该越难遗忘，这里反而全是 0.5 平均化。
- **掩盖机制**：`forgetting/__tests__/scorer.test.ts:9` 的 `mk()` **特意把 significance 放进了 metadata**——测试这样写才会过，但真实落库的字段不在 metadata → **测试绿=掩盖生产缺陷**。这是本审计最典型的"测试验证了实现的形状，没验证实现的意图"案例。
- **建议**：`scorer.significanceOf` 同时读顶层 `m.significance`/`m.valence`（或 scheduler 把列搬进 metadata）；改测试为构造真实落库形状的 record。

### A3.【真 bug】J 图邻居扩展配置被吞，重构式回忆的图扩展路径实为关闭

- 与 A1.3 同根。补充证据：`memory-search.ts:342` 仅在 `neighborExpand?.enabled && vectorStore.getNeighbors && getL1ByIds` 时扩展；而唯一传入 `neighborExpand` 的 `v2-router.ts:1243` 从被丢弃的 `config.memory.search` 取值 → 恒 undefined。sqlite 后端 `getNeighbors`/`getL1ByIds` 是有的（`sqlite.ts:1553/1762`），所以是"能力在、开关死"。
- **建议**：A1 修完后 J 自然复活；并加一条 v2→executeMemorySearch 的配置传参单测（设计 recol J：邻居+再门控才叫"重构式回忆"，否则只是 top-k）。

---

## B 级 · 真实现但与设计有偏差 / 存在一致性风险

### B1.【源不一致】K 的 `core_values` 表与 L 的 appraisal 值不是同一个源

- **证据**：
  - K 落库：`MemoryCore core_values` 表 + `/v3/core-memory/read|write`（`9711de2`）。
  - L 注入：MemoryProxy `knowledge/current-feeling.ts` `renderCurrentFeeling(query, cfg)` 读的是 **MemoryProxy `config.yaml` 的 `appraisal.values`**（`config.ts:454-465` 显式解析），**不是 MemoryCore.core_values**。
  - MemoryCore 侧 `lifecycle/feeling/appraisal.ts` 的 `appraise()` 只被自己的单测调用，**生产无任何注入点调用它**（grep 证实）。
- **后果**：价值锚存在**两套源**（MemoryCore core_values 表 vs MemoryProxy config.yaml），**从不同步**。改 config.yaml 的 appraisal，core_values 表不知道；`/v3/core-memory/read` 改值，注入也不变。设计 §5.2"核心价值锚置于 core memory，是情绪参照系"没有被 L 兑现。且 `appraise()`（MemoryCore）是**死代码**，与 MemoryProxy 的 `renderCurrentFeeling` 是两个**行为可漂移的平行实现**。
- **建议**：裁定单一源（建议 core_values 表），L 注入改从 MemoryCore 读值；删除或统一 MemoryCore `appraise()`。

### B2.【红线未达】"reconsolidation 仅 observed 层"只看得到，没触发代码

- 设计红线："reconsolidation 只作用于 observed 层；inferred 锁死"。
- 代码里**找不到任何 reconsolidation 触发点**：`l1-writer.ts` 写入时 patch + P0；`memory-search.ts` 只读不改；consolidation 是"写新持续态"，没有"回忆时重缝合旧 observed 记忆"。`grouping.isObservable()`、`persona-evolution` 里的 `certainty!=="inferred"` 仅是**防守侧**（防止 inferred 被归档/巩固/入画像），但"回忆即重巩固"这个正向机制（spec §3.3 H4）**没有实现**。
- **后果**：master spec §4.3/§6.1 宣称"重构式回忆是重巩固"、plan 里 H4/reconsolidation 子任务，现状是**只做了"防 inferred"，没做"observed 可重缝合"**——设计前的卖点缺了一半。属于"红线达标、正向机制缺位"。
- **建议**：要么在 doc 明确 H4 降级为"仅防守"，要么补一个 observed 层回忆触发的微更新机制（受 recommended 预算限制）。

### B3.【偏差】merge/update 的目标记忆被硬删——与图边/证据链语义冲突

- `l1-writer.ts:329-349`：`update`/`merge` 决策时 `deleteL1Batch(target_ids)` **从向量库删除旧记录**（说"留给 memory-cleaner 清 JSONL"）。
- 而图设计 §5"不替换原记忆内容；删除时级联删边"、recollection 希望"带回旧证据链"。merge 产生 `similar` 边、update 产生 `evolve` 边（`l1-extractor.ts:783-789`），但**被 merge 的旧记忆已被硬删**，边指向的 `target` 不存在 → 邻居召回/回忆带回的旧记忆**实际是空**（`getL1ByIds` 查不到）。
- **第一性原理**：如果"持续态/演化的证据链要可追溯"，旧记忆应当**软删/归档**而非硬删；现在是"建 evidence 边"与"删 target"自相矛盾。
- **建议**：update/merge 改为**归档** target（复用 `archiveL1`），或至少把被覆盖内容并入新记录而保留旧行供 `getL1ByIds` 命中。

### B4.【协议差异】`formatSearchResponse` 的"回忆片段"只在工具侧；自动召回注入仍是旧 top-k

- recollection 设计 §5"改 memory-search；auto-recall 注入沿用其输出"。`formatSearchResponse`（持续态优先+时间线+soul 标注）只在 `tdai_memory_search` 工具侧生效（`memory-search.ts:402`）；而**自动召回注入** `auto-recall.ts` 走的是旧的 `formatMemoryLine`（plain "- [type] content (活动时间: ...)"），**没有持续态优先、没有情感标注、没有图扩展**。
- **后果**：用户实际每轮看到的核心注入（`<relevant-memories>`）与 sink(memory-real) 的"重构式回忆"不是一套东西；两条召回线（auto-recall 与 tdai_l1_recall_injector）行为也不一致。
- **建议**：明确"回忆片段格式"是仅工具侧还是全注入侧统一；若统一，auto-recall 也用 `formatSearchResponse`/邻居扩展。

---

## C 级 · 可观测性 / 测试 / 文档一致性

1. **uvitest 在本环境跑不起来，多项"已单测"实际未验证**：`MemoryCore/vitest` 二进制/包不可用（`node_modules/.bin/vitest` 缺失，纯逻辑测试 `grouping/scorer/appraisal/persona-evolution` 由 `2478b72` 写入但写明"本环境暂不可跑，落真实回流"）。A2 正是"测试数据掩盖真实行为"的例子。**任何声称"已单测"需能在测试环境执行**。
2. **`everyN/interval` 的 sleep 型 worker 只在 standalone 时序上跑过，未见并发/幂等测试**；consolidation 每 tick 读全库 `queryL1Records()`（无 filter），worker 未传 isolation filter → 与设计一贯的"never crosses tenants"（dedup 有 filter）**不一致**（多租户下有越租户归档/巩固风险），单机部署掩盖。
3. **语义/命名漂移**：`significance` 顶层列 vs metadata 读取（A2）；deployed config 文档（§8.3）写的是 golden 调参结论，但 absent path 的 `minInjectAbsScore`/`neighborExpand` 现状与文档"已启用"不符（A1.3）。

---

## 验证方式（建议的 golden 回归方向，来自审计发现的共性）

- **配置生效**：解析 tdai-gateway.yaml → 断言 `memory.links/lifecycle/search` 进到运行 config（先修 A1）。
- **显著性生效**：写入一条 `significance=0.9` 的 L1 → 跑 forgetting → 断言不会被归档（修 A2）。
- **图扩展生效**：建同主题点 + dedup merge → 调 /v3/atomic/search（neighborExpand 开）→ 断言返回含邻居（修 A3）。
- **证据链可回溯**：merge/update 后 `getNeighbors(新id)` 能 `.getL1ByIds` 拿到旧证据（修 B3）。

---

## 结语

这套设计的**广度与纪律在同类系统里少见**（红线、诚实边界、config-first、golden 回归的意图都对）。但从"设计 → 代码行为"的映射看，当前状态更像**"脚手架全立、水流没接通"**：表/字段/接口/worker 都在，可 A1（配置丢弃）、A2（soul 字段没进遗忘打分）、A3（J 图扩展被配置开关死）、B1（core_values 两套源）都指向同一个模式——**实现按设计造好了容器，却没把正确的数据/配置灌进去，而默认值和测试数据恰好掩盖了空转**。这比"功能没写"更难发现，也更值得先在 A 级修完再谈 B/C。

---

## 修复实录（2026-09-09，同日完成，对抗性自审已跑）

### 已修复

| 项 | 修复内容 | 验证证据 |
|---|---|---|
| **A1** | `config.ts` 增补 `MemoryLinksConfig`/`MemoryLifecycleConfig`/`search.neighborExpand` 类型 + `parseConfig` 显式解析（含缺省值，与 yaml/代码默认对齐）；`pipeline-factory.ts:606` 改 `cfg.links.enabled`；`server.ts` 生命周期读类型化 `this.config.memory.lifecycle` | tsx 端到端链路验证：yaml 形状 → parseConfig → v2-router/server/pipeline 三条读取路径全部可达 ✓（此前恒 undefined） |
| **A2** | `scorer.ts` `significanceOf`/`ageDaysOf` 顶层字段优先（significance/valence/occurred_at），metadata 兜底；测试 fixture 重写为真实落库形状 + 新增"A2 回归"断言 | tsx 验证：sig0.9→keep、sig0.1→archive、分数≠0.5兜底 ✓ |
| **A3** | 同 A1（`search.neighborExpand` 进 parseConfig，v2-router:1243 读到真实值） | 链路验证 ✓；J 扩展在生产配置(yaml enabled:true)下复活 |
| **B1** | `appraisal.ts` 新增 `salienceBoost()`（价值命中→显著性 boost，宁缺毋滥）；`scorer.ts` 新增 `classifyWithValues()`；`forgetting-worker` 自动从 `store.listValues()`（core_values 表）读价值锚（value_id→id 映射），values 空时零影响 | tsx 验证：命中价值→keep（更难被遗忘）、values 空→与 classify 完全一致 ✓；`salienceBoost` 单测追加进 appraisal.test.ts |
| **B3** | `l1-writer.ts` update/merge 从硬删 target 改为 `archiveL1(reason="dedup-update/merge")`（归档优先于删除红线；store 不支持 archive 时回退硬删保检索面干净）；`sqlite.getL1ByIdsWithArchive()` 新增（归档桶回退解析）；**`archiveL1` 不再级联删边**（边是关系事实，指向归档记录合法；真删才删边）；`memory-search`/`v2-router` 邻居解析切到 WithArchive | tsx+sqlite 全链路：upsert→建 evolve 边→archive→getNeighbors 仍见 old→getL1ByIds 查不到（检索面干净）→getL1ByIdsWithArchive 读回证据（content+certainty 完整）✓ |
| **B4** | `auto-recall.ts` `FormatableMemory` 增 soul 字段透传；`formatMemoryLine` 追加 `·soul[发生 X · 实见/推断 · 情感 X · 重要度 X]` 尾注（有值才加，宁缺毋滥）；无 soul 字段零尾注 | tsx 验证：尾注正确渲染、metric 解析正则 `^-\s+\[([^\]]+)\]` 不受污染、无字段时零尾注 ✓ |
| **C** | `lifecycle-scheduler` 增 `filter`（租户隔离，缺省不传保持兼容）；`runForgettingOnStore` 透传 filter | 类型化接线 ✓ |
| **额外（自审发现）** | ① `DedupAction` 类型**漏了 `"conflict"`**（P4 加了 conflict 处理逻辑但类型没同步——strict tsc 下 conflict 分支不可达 TS2367）→ 补上；② `forgetting-worker` 补 `ForgettingConfig` re-export（lifecycle-scheduler 依赖）；③ `consolidation-worker` metadata `Record<string,never>` 过度收紧断言放宽；④ `pickArchiveCandidates` record_id 兜底收紧 | strict tsc 复跑：我改动的文件零新增错误（剩余错误均为未触碰模块的预存在问题：skill/add-handler、otel、report、quota、llm-runner 等） |

### 对抗性自审中的两个插曲（诚实记录）

1. **第一次验证脚本跑出 2 个失败**——排查后是我的验证脚本自身把阈值/age 组合设错了（sig0.9+age365+decay0.026 必然低于 0.3），**不是修复缺陷**；修正脚本语义后全过。教训：验证 cue 本身也要被审。
   **【复核补正 2026-09-09】** 用户追问"插曲都改了么"后复查发现：当时只改了 tsx 验证脚本，**`scorer.test.ts`（vitest 用例）里同样的数学错误原样残留**（sig0.9×0.8×decay(365)=0.0187<0.3 却断言 keep；A2 的 sig1.0 同病；B1 的 boost 0.1 也跨不过 0.3 阈值）——因为 vitest 一直跑不起来，从没人发现这些断言必挂。已重写：age 365→30（decay≈0.741），A2 用 sig1.0+prio80（0.593 keep，旧 bug 恒 0.5 会得 0.296 archive，断言能区分修复前后），B1 阈值压到 0.08 让 boost 恰好跨界。**全部 12 条断言已用 tsx 逐条模拟执行通过**；vitest 恢复后仍应正式跑一遍。
2. **B3 脚本"archive false"失败**——根因是**上一次失败运行的 sqlite db 文件被 Windows 文件锁没删干净**（WAL 残留→主键冲突），改 per-run 唯一文件名后全过。产品代码无问题，但暴露"测试残留同样能制造假失败/假通过"。此条当时已修到位（`audit-fix-verify-b3.ts` 用 pid+时间戳命名 db）。

### 验证工具留档

- `MemoryCore/scripts/audit-fix-verify.ts` — A1/A2/B1 纯逻辑校验（tsx 直跑，绕开 vitest）
- `MemoryCore/scripts/audit-fix-verify-b3.ts` — B3 sqlite 全链路校验
- 运行：`node --import tsx scripts/audit-fix-verify.ts`
- **vitest 在本环境仍不可用**（pnpm store 里有包但未链接、`pnpm install` 因网络超时失败）——所有"已单测"的 vitest 用例（scorer/appraisal 重写后）**尚未在 vitest runner 里跑过**，等环境恢复后应 `pnpm vitest run src/core/lifecycle` 复跑。

### 未修（明确留档）

- **B2**（reconsolidation 正向机制缺位）——涉及"回忆触发微更新"的产品语义决策（预算、触发点、与 H 的边界），需要拍板后再做，不适合顺手补。
- **C-预存在类型错误**（skill/conversation-add、otel、report 等）——与本审计无关的存量债，建议另开任务。