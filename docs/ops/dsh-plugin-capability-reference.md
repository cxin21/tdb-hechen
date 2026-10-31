# dsh 插件能力参考手册（tdb-agemem-dsh，2026-11-01）

> 面向**运维与使用者**：每项能力怎么开、怎么验、坏了读哪一行。不是设计文档；设计取舍见 `docs/specs/` 与 `docs/ops/proxy-parity-matrix.md`。
> 数据源三份：**矩阵** = `docs/ops/all-on-capability-matrix.md`（Lead 2026-11-01 亲测读数）、**parity** = `docs/ops/proxy-parity-matrix.md`（proxy 注入器逐条映射，补齐清单真源）、**profile** = `docs/ops/production-profile.md`（配置生效链与回滚）。
> 引用口径：**每个数字后面带出处**（`矩阵 §0.1` / `path:line`）；没有实测的写「待实测（票号）」。行号 = 2026-11-01 工作树快照；`dsh-plugin/` 整目录未入库且多人并行改，**行号会漂，按符号名 grep**。
> 今天的能力面一句话：**已落地 = 3 条注入面 + 1 个工具**（head pack 的 persona 与场景索引、volatile 的记忆与 soul 段、原生工具 `memory_recall`、写回 L0/L2）；其余 16 项是票面待实现（`dsh-plugin/src/tools.ts:40` 只有 `memory_recall` 一个工具）。

---

## §0 三分钟上手

### 0.1 装：`dsh-plugin/scripts/deploy.sh`（非破坏 + 不重启）

- 一条命令 = build → test → pack → install → verify（`dsh-plugin/scripts/deploy.sh:11-13`）。`--dry-run` 只打印计划，`--skip-tests` 跳过自测。
- 它写进 profile 的东西只有两样：一次 pnpm install、`~/.dsh/profiles/desktop/cordis.patch.yml` 里的一行 managed 块；改之前先把 profile 的 `~/.dsh/profiles/desktop/package.json` / `~/.dsh/profiles/desktop/pnpm-lock.yaml` / `~/.dsh/profiles/desktop/cordis.patch.yml` 备份到 `dsh-plugin/.deploy/<stamp>/`（`:6-9`，回滚用 `dsh-plugin/scripts/rollback.sh`）。
- **不重启正在跑的 GUI host**（`:8-9`）：装完必须自己重启宿主，插件才生效。

| 变量 / 参数 | 缺省 | 作用 |
|---|---|---|
| `DSH_PROFILE` | `desktop` | 目标 profile（`web` 是发行模板） |
| `DSH_BIN` / `DSH_HOME` | `D:/DSH/resources/runtime/cli/bin/dsh.cmd` / `~/.dsh` | 宿主 CLI 与 home |
| `TDB_CORE_BASE_URL` | `http://127.0.0.1:8420` | core 地址（`server.baseUrl`） |
| `TDB_CORE_API_KEY` | 从 `MemoryCore/tdai-gateway.yaml` 的 `server.apiKey` 读 | core 服务端 key |
| `TDB_API_KEY_REF` | `TDAI_GATEWAY_APIKEY` | 凭据库里的**名字**（不是值） |
| `TDB_TEAM_ID` / `TDB_AGENT_ID` / `TDB_USER_ID` | 空 | 记忆隔离三轴；空 = 插件 inert |
| `--identity team,agent,user` `--base-url` `--api-key` `--api-key-ref` `--inline-key` `--no-store-key` | — | 等价命令行（`:36-56`） |

- **key 永不进 patch**：值写进宿主凭据库 `~/.dsh/.credentials.yaml`，patch 里只留 ref 名；`env[REF]` 作运行时兜底（`:25-31`）。
- **身份三来源**：patch 里显式三轴 → `server.userKey` 启动时解析（`dsh-plugin/scripts/agemem-identity.mjs` 可交互写入）→ 都没有则 inert。**空身份是刻意的安全缺省，不是故障**（`:21-23`）。

### 0.2 验：`node scripts/verify-installed.mjs [--profile web] [--hours 24] [--json]`

- 只在 `bad === 0` 时 exit 0；**没机会验的项报 PENDING 而不是 PASS**（`dsh-plugin/scripts/verify-installed.mjs:13`、`:132-134`）。

| 检查项 | 判据 / 失败含义 | 位置 |
|---|---|---|
| `patch entry` | profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 有 managed 块；否则「跑 deploy.sh」 | `:43` |
| `dist entry` / `package.json dep` | `dsh-plugin/dist/index.js` 存在、`@tdb/agemem-dsh` 在依赖里 | `:48` / `:53` |
| `session scan` / `session read` | 会话归档可定位、可解压（zstd，含多帧容错） | `:79` / `:122` |
| `volatile injection` | 归档里出现 `agemem-volatile-` 标记 | `:103` |
| `plugin source id` | 出现 `plugin:tdb-agemem-dsh`（证明确实是本插件注入的） | `:104` |
| `head pack scene index` | 出现 `- scene_blocks`（head pack 真进了提示） | `:105` |
| `tool registration` / `schema rejected` | 归档里出现 `memory_recall registration failed` / `UNSUPPORTED_SCHEMA` ⇒ **FAIL** | `:141-155` |
| `volatile recall fell back` | 出现 `recall failed`（召回降级到 atomic/search） | `:143` |
| `dead letters` | `$DSH_HOME/agemem/outbox.dead.jsonl` 最近窗口内有新行 ⇒ FAIL | `:165-167` |

### 0.3 看：ready 行逐字段（插件挂载时一行 info，`dsh-plugin/src/index.ts:1119-1140`）

| 字段 | 含义 / 取值 | 出处 |
|---|---|---|
| `endpoint` / `serviceId` | core 地址与 `server.serviceId` | `:1120-1121` |
| `identity` | `configured` \| `resolved(user_key)` \| `missing(teamId,agentId…)` | `:1121`、`dsh-plugin/src/identity.ts:128-134` |
| `userKeySource` | 只在非 configured 时出现：key 来自 config / 凭据库 / env（**从不打值**） | `:1122-1128` |
| `keySource` | 服务端 key 的来源（同上口径） | `:1129` |
| `health` | `ok` 或 `fail(no-answer)`（3s 探测） | `:484` |
| `capabilities` | `headPack=on/off,volatile=recall/atomic/off,soul=on(600,feeling)/off,writeback=on/off,skillFeed=on/off,tools=on/off` | `:1094-1106` |
| `guidance` | 答案口径 + 工具指南版本串 | `:1132` |
| `volatileChars` / `recallTimeout` / `volatileTimeout` / `headPackTimeout` / `requestTimeout` | **全部毫秒原值**（不四舍五入，便于对拍 1500 vs 2500） | `:1111-1117` |
| `debug` / `logFile` | `on` 才有 `logFile`；日志路径 `$DSH_HOME/agemem/agemem.log` | `:1133-1134`、`dsh-plugin/src/debug-log.ts:65-75` |

- **debug 关 = 黑盒**：GUI 没有 stderr，关掉后只剩这一行 ready；`config.debug: true` 才建文件日志（`dsh-plugin/src/index.ts:269-274`）。

---

## §1 能力总表（19 项，与矩阵 §1 同序）

| # | 能力 | 配置键（点号路径） | 缺省 | 全开 | 生效面 | 实测读数 | 失败时行为 |
|---|---|---|---|---|---|---|---|
| 1 | `<available_skills>` 目录 | `headPack.includeSkills`（未实现） | — | true | head pack 段 | listing 6004 / 9680 字符（矩阵 §0.2） | 无段（task-72） |
| 2 | skill_search | `tools.skill.*`（未实现） | — | true | 工具 `skill_search` | 86ms / 10 条 / score 12.88（矩阵 §0.2） | 无工具（task-72） |
| 3 | skill_view | 同上 | — | true | 工具 `skill_view` | 32271 字节，content 30318（矩阵 §0.2） | 无工具（task-72） |
| 4 | skill_files_read | 同上 | — | true | 工具 `skill_files_read` | `echo hi` 原样取回（矩阵 §0.2） | 无工具（task-72） |
| 5 | skill_extract | 同上 | — | true | 工具 | 待实测（task-72） | 无工具（task-72） |
| 6 | skill_create | `tools.skill.allowLlmWrite`（未实现） | false | true | 工具（RMW + `expected_version`） | 全链第一步通过（矩阵 §0.1） | 无工具（task-72） |
| 7 | skill_update | 同上 | false | true | 工具 | v1→v2 通过（矩阵 §0.1） | 无工具（task-72） |
| 8 | skill_patch | 同上 | false | true | 工具 | 通过（矩阵 §0.1） | 无工具（task-72） |
| 9 | skill_delete | 同上 | false | true | 工具 | 走 archived，随后 get 回 40401（矩阵 §0.1） | 无工具（task-72） |
| 10 | skill_files_write | 同上 | false | true | 工具 | 通过（矩阵 §0.1） | 无工具（task-72） |
| 11 | skill_files_remove | 同上 | false | true | 工具 | 通过（矩阵 §0.1） | 无工具（task-72） |
| 12 | `<core_memory>`（identity_narrative/strict_rule） | `headPack.coreMemory{enabled,maxChars,refreshMs}`（未实现） | — | true / 3000 / 300000 | head pack 段（最前） | `POST /v3/core-memory/read {format:"narrative"}` → 2 slots 3033 字符（1562+1471，矩阵 §0.3） | 段零字符（task-88）；与 `<l3_core_memory>` 是**两段两源**，见 `docs/ops/l2l3-segment-parity.md` |
| 13 | soul redline（动作点近端） | `soul.redline.{enabled,mode,dedup}`（未实现） | 等价关 | `action_proximate` | `tool/call` 钩子 | 待实测（task-76） | 无动作（task-76） |
| 14 | soul reanchor | `soul.reanchor.{enabled,intervalTurns}`（未实现） | 等价关 | true / 20 | `tool/call` 钩子 | 待实测（task-76） | 无动作（task-76） |
| 15 | current_feeling（当轮价值命中） | `volatile.soul.includeFeeling` | true | true | volatile `<soul-feeling>` | 36–40 字符（soul-segment.md §0） | 部分覆盖：只覆盖情绪基调/状态，价值命中无对应（parity §6） |
| 16 | profile 借入 ≤2 agent | 无键 | — | — | head pack 分组头 | 跨 agent 绑定 0 条（矩阵 §1） | 不注入（task-77 结论：缺维度） |
| 17 | wiki recall | `volatile.wiki.*`（未实现） | — | true | volatile 段 | 8421 三库真实命中（task-64） | 无段（task-74） |
| 18 | knowledge_tools | `tools.knowledge` / `volatile.knowledgeRecall`（未实现） | — | true | 工具 + 段 | 待实测（task-75） | 无工具（task-75） |
| 19 | asset reflection | `assetReflection.{enabled,triggerToken,alwaysOn,maxChars}` | true / `/analyse` / false / 600 | 同左 | `systemPrompt.section` | 待实测（task-82） | 不注册 section |

> 「未实现」= 键在 `DEFAULT_CONFIG`（`dsh-plugin/src/config.ts:237-346`）里**不存在**，全开值来自矩阵 §2 的票面约定，实装以对应票为准。

---

## §2 分能力（做什么 / 开法 / 怎么验 / 失败语义 / 边界）

### 2.1 `<available_skills>` 技能目录（票 task-72，进行中）
- 做什么：把 core 渲染好的技能清单塞进 head pack，让模型知道有哪些技能可用。
- 开法：`headPack.includeSkills: true`（键未实现）；预算 `skills ≤8000`（矩阵 §4）。
- 怎么验：`curl -s -X POST <core>/v3/skill/listing` —— `data.listing` 已是渲染串，`char_budget 6000 → 6004`、`64000 → 9680` 字符，开头就是 `<available_skills>`，另带固定 20 条 `hits`（矩阵 §0.2）。
- 失败语义：core 不可达 ⇒ 段零字符，其余段不受影响（同 task-63 口径）。
- 边界：**不要自己拼清单**——直接用 core 渲染串才与 proxy parity；9680 字符超 8000 预算时必须截断并保留闭合标签。

### 2.2 skill_search / 2.3 skill_view / 2.4 skill_files_read（票 task-72）
- 做什么：三个只读原生工具，替代 proxy 的 curl 配方（`<skill_tools>` 在 DSH 里无意义，用户 m02708 口径）。
- 开法：`tools.skill=true`（未实现）；写面另有 `allowLlmWrite`。
- 怎么验：`/v3/skill/search` 200/86ms/10 条，**score = −bm25**（越大越相关，首条 12.88）；`/v3/skill/get-by-name` 返回 32271 字节、`content` 30318 字符 + `version`；`/v3/skill/files/read` 返回 `{path,content,encoding,size_bytes,mime_type,version}`，utf-8/base64 双编码（矩阵 §0.2）。
- 失败语义：`get-by-name` **只走 header 会 40001**（`team_id/agent_id` 必填无 header 合并，`MemoryCore/src/gateway/skill-schemas.ts:143-152`）⇒ body 必须带三轴。
- 边界：read 面三轴可只走 header，get-by-name 不行——两套口径别混。

### 2.5 skill_extract（票 task-72）
- 做什么：直接触发一次会话切片归档（代替 proxy 的队列异步抽取）。
- 开法：同 2.2 的技能工具组。
- 怎么验：`POST /v3/skill/extract`（路由 `MemoryCore/src/gateway/skill-handlers.ts:1153`）；**真跑待补**（矩阵 §1 第 5 行）。
- 失败语义：队列未就绪回 `QUEUE_UNAVAILABLE → 50301`（`MemoryCore/src/gateway/skill-handlers.ts:18`）。
- 边界：会归档 buffer，属**有副作用**工具，缺省应只读三件套先上线。

### 2.6–2.11 六个写工具：create / update / patch / delete / files.write / files.remove（票 task-72）
- 做什么：让模型能在 DSH 里维护 skill（proxy `allowLlmWrite` 的等价物）。
- 开法：`tools.skill.allowLlmWrite: true`（未实现，**缺省 false = 与 proxy 同档**）。
- 怎么验：必须先 `skill_view` 取 `version`，写口带 `expected_version`（`skill-schemas.ts:101/:108/:117/:182/:189` 五个写口都要求 `z.number().int().min(1)`）；实测全链 create(v1) → update(v2) → stale v1 ⇒ `40901 SKILL_VERSION_STALE` → patch(v3) → files/write(v4) → files/read 回 `"echo hi\n"` → files/remove(v5) → delete(archived) → get `40401`（矩阵 §0.1）。
- 失败语义：**照抄 proxy 配方 = 假开关**——`MemoryProxy/src/injection/injectors/skill-tools-injector.ts:108-144` 渲染的 body 没有 `expected_version`，五个写口一律 HTTP 200 + `code=40001`。
- 边界：写面是**读-改-写**工具，不允许盲写；delete 是 archived 而非物理删。

### 2.12 `<core_memory>` 稳定段（identity / strict_rule，票 task-88）
- 做什么：把核心身份锚与严格规则作为**稳定段**注入（会话级，不是每轮重注）。
- 开法：`headPack.coreMemory{enabled:true, maxChars:3000, refreshMs:300000}`（未实现）；段必须在 head pack **最前**（身份先于内容）。
- 怎么验：`POST /v3/core-memory/read {format:"narrative"}` 实测 200/7ms → 2 slots（`identity_narrative` 1562 + `strict_rule` 1471 = 3033 字符，矩阵 §0.3）；注入后与拆分结果对拍（两 slot + 标签 ≤ maxChars）。
- 失败语义：core 不可达或 `code!==0` ⇒ 段零字符、debug 一行 `coreMemory=fail(<code>)`，**不许用上次缓存冒充成功**；成功结果可在进程内按 refreshMs 缓存。
- 边界：**两段两个源，勿混**——本段（`<core_memory>`）走 `POST /v3/core-memory/read`（`loadCoreMemorySlots` + 逐 slot 标签包裹，`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:137-157`）；`<l3_core_memory>`（人格全文）才走 `POST /v3/core/read`（`:112-115`，proxy 侧 UTF-16 硬截 6000）。`/v3/core/read` 的 10003 字符档案**不是**本段数据源（2026-11-01 拍板，原「需拍板」句作废）。
- 现状：`dsh-plugin/src` 对 `core_memory|coreMemory|core/memory` 仍**零命中**（`fixed-asset-parity.md` §1 第 6 行）⇒ 本段待实现；同期 L2/L3 两段的现有实现、等价性与对齐方案见 `docs/ops/l2l3-segment-parity.md`。

### 2.13 soul redline（动作点近端，票 task-76）
- 做什么：在工具调用前把 strict_rule 红线贴到最近处，抗长上下文稀释。
- 开法：`soul.redline.mode="action_proximate"` + `enabled:true` + `redlineDedup.enabled:true`（未实现）。
- 怎么验：挂 `tool/call` 后看 debug 每轮是否 emit；数据源与 2.12 的 strict_rule 同一份（proxy 侧 `MemoryProxy/src/injection/injectors/tdai-soul-redline-event-injector.ts:113-115` 也走 `loadCoreMemorySlots`）。
- 失败语义：proxy 缺省 `session_head` ⇒ 直接返回空（等价关）；DSH 侧未实现 ⇒ 无输出。
- 边界：需要 strict_rule 非空才有内容；待实测（task-76）。

### 2.14 soul reanchor（漂移再锚，票 task-76）
- 做什么：每 N 轮重新贴一次身份，压住长会话漂移。
- 开法：`soul.reanchor.enabled=true`、`intervalTurns=20`（未实现）。
- 怎么验：待实测（task-76）；成本 = 每 20 轮一次槽读。
- 失败语义：缺省等价关（与 proxy 同档）。
- 边界：与 redline 共用数据源，两处不得各拉一次（同 cache 键）。

### 2.15 current_feeling（已落地）
- 做什么：把当轮情绪基调 `<soul-feeling>` 放进 volatile 首部。
- 开法：`volatile.soul.includeFeeling: true`（缺省 true，`dsh-plugin/src/config.ts:295`）。
- 怎么验：ready 行 `soul=on(600,feeling)`（`:1102-1104`）；实测该段 36–40 字符（`dsh-plugin-soul-segment.md` §0）；上游 mood 端点实测 129ms、`tier=positive`、`sampleCount=20`（矩阵 §0.3）。
- 失败语义：soul 整段装不进预算时被丢（`soul.enabled:false` 时记忆预算逐位回到旧形态）。
- 边界：插件不直连 `/v3/memory/mood`，feeling 随 `/v3/recall` 响应回来。**与 proxy 的 `<current_feeling>` 不是一回事**：proxy 那个是「本轮问句命中哪些核心价值」+ valence 方向行、每轮重算（`MemoryProxy/src/injection/injectors/tdai-current-feeling-injector.ts:33-41`、`MemoryProxy/src/knowledge/current-feeling.ts:29-53`）；我们的 `<soul-feeling>` 是会话情绪基调/状态机当下态（`MemoryCore/src/core/hooks/soul-assembler.ts:923-926`、`soul-state.ts:70-76`），且方向锚清单行 2026-10-17 已删（`soul-assembler.ts:909-916`）⇒ 价值命中在 DSH 侧无对应，详见 `docs/ops/l2l3-segment-parity.md` §6。

### 2.16 profile 借入（≤2 个其他 agent 的画像，票 task-77 已判定）
- 做什么：proxy 会把绑定给本 agent 的其他 agent 画像一起注入，并标 `role=self|imported_from`。
- 开法：无键——**能力本身缺**（`fixed-asset-parity.md` §0：self 的 L3/L2 有，借入维度无、分组标注无）。
- 怎么验：`/v3/meta/agent-fixed-asset/list-with-detail` 返回 `agent + items[{asset_id, asset_type, name, injection_mode}]`（`MemoryCore/src/metadata/router/v3-meta-router.ts:275`）；按 header 切 agent 的 `/v3/core/read` 在 `MemoryCore/src/gateway/v2-router.ts:3863`。
- 失败语义：不注入（当前 head pack 只有 self）。
- 边界：今天**绑定 0 条**，即使实现也无数据可注入（矩阵 §1 第 16 行）；core 侧不需要新票。

### 2.17 wiki recall（core 端已落地 / 插件端待做，票 task-73 → task-74）
- 做什么：把 wiki 命中条目按轮注入 volatile。
- 开法：core 侧 `memory.wiki` 段已加（需重启 gateway 生效）；插件 `volatile.wiki.enabled`（未实现）。
- 怎么验：`POST /v3/wiki/list`、`POST /v3/wiki/search`（薄转发，不复制真源，`docs/ops/core-wiki-forwarding.md`：16 单测 + 13 项隔离实例活体验证全绿）；8421 三库真实命中（task-64）。
- 失败语义：8421 不可达 ⇒ 空结果，不阻断主链路（薄转发口径）。
- 边界：预算 `wiki ≤2000`（矩阵 §4）；跨库合并按 `absScore`。

### 2.18 knowledge_tools（票 task-75，待实现）
- 做什么：团队知识自发现——先列可读知识源，再按需取内容。
- 开法：`tools.knowledge=true` + `volatile.knowledgeRecall.enabled=true`（未实现）。
- 怎么验：**三段式**（资源清单 → `/tools/list` → `/tools/call`），不是两段式（矩阵 §1 第 18 行）；真跑待补。
- 失败语义：待实测（task-75）。
- 边界：与 proxy `KnowledgeToolsInjector`（`MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts:259-262`）对齐，段名 `<knowledge_tools>`。

### 2.19 asset reflection（模块已在、未接线，票 task-82 进行中）
- 做什么：让模型对「本轮用过的资产是否起作用」输出固定格式的自评块（`【资产反思】`），要求从 L0 写回里剥离。
- 开法：`assetReflection.enabled:true`（缺省 true）+ `triggerToken:"/analyse"` + `alwaysOn:false` + `maxChars:600`（`dsh-plugin/src/config.ts:332-342`）。
- 怎么验：模块 `dsh-plugin/src/asset-reflection.ts` 已实现双门（`enabled` + 用户文本里的独立 token）与 `stripAssetReflection`，section 名 `tdb-agemem:asset-reflection`；但 `grep -n asset dsh-plugin/src/index.ts` **零命中** ⇒ 尚未接线，今天不产生任何段落。
- 失败语义：未注册 section 时提示词零改动（`dsh-plugin/src/asset-reflection.ts:9-11`）。
- 边界：判定见 `docs/ops/asset-reflection-parity.md`（可等价接入，**触发语义不能 1:1 搬 URL marker**）。

---

## §3 预算与截断（数字以矩阵 §4 为准）

| 段 | 上限 | 现状 |
|---|---|---|
| `<core_memory>` | ≤3000（票 task-88） | 未实现；与 persona 段**不得双份**（同一份数据要先去重） |
| persona（`/v3/core/read` 正文，压缩后） | 余量 | 已实现：实测 10003 → **4565** 字符且 14 条路径全在（`dsh-plugin/src/head-pack.ts:36-40`） |
| sceneIndex | ≤3000 | 已实现：`composeHeadPack` 先扣场景段预算再放 persona（`dsh-plugin/src/index.ts:133`） |
| skills | ≤8000 | 未实现（task-72） |
| knowledge | ≤3000 | 未实现（task-75） |
| wiki | ≤2000 | 未实现（task-74） |
| **总** | 20000 | **已与代码一致**：`headPack.maxChars = 20000`（`dsh-plugin/src/config.ts:303`，注释明写「一次注入、session 级冻结，20000 安全」）。<br>（2026-11-01 更正：本行原写「实际总上限 8000（`config.ts:274`）」，那既是旧缺省、行号也已漂移；同批更正见 `docs/ops/recall-budget-measured.md` §1.4） |

- **volatile 是另一本账**：`volatile.maxChars = 1500`（`dsh-plugin/src/config.ts:318`）= soul ≤600（`:323`）+ 1 分隔符 ⇒ **记忆预算 899**；soul 是 volatile 预算的**切片不是加法**（`dsh-plugin/src/config.ts:478-484`，100 floor / 3000 ceiling）。
- **溢出顺序**：persona > sceneIndex > skills > knowledge > wiki，从低往高丢（矩阵 §4）。
- **截断标记**：当前只有全局 `[agemem head pack truncated at N chars]`（`dsh-plugin/src/head-pack.ts:188`）；「每段独立 truncated 标记」尚未实现（矩阵 §4）。
- **每轮重注要压预算**：若 head pack 改成按 refreshMs 重注，矩阵 §4 要求总量压回 12000 且 skills 段「首轮全量 + 后续只命名」。

---

## §4 三条注入路径怎么选（同一身份只能选一条喂写）

| 路径 | 入口 | 注入面 | 写面 | 身份 |
|---|---|---|---|---|
| **DSH 插件**（本手册） | profile patch（`dsh-plugin/scripts/deploy.sh`） | head pack（system/message）+ volatile（pre-step user/message）+ `memory_recall` | `/v3/conversation/add`（L0）+ `/v3/skill/conversation/add`（L2） | `server.{teamId,agentId,userId}` 或 `server.userKey` 解析 |
| **MemoryProxy** | 端口 8096（`MemoryProxy/src/config.ts:13`） | 11 个注入器（parity §1），session_init 缓存 + 每轮 | proxy 转发 | `TDB_API_KEY` + 三轴 |
| **核心原生钩子**（core 侧 openclaw-plugin） | 宿主钩子 | memory-tools-guide / answer-guidance 同源镜像（`production-profile.md` §3） | — | — |

- **排他纪律**：同一身份只能有一条写链，否则 L0 重复（`production-profile.md` §2.1 第 2 条）。排他开关：`writeback.enabled=false`（整体不写）或 `writeback.skillFeed=false`（只关 L2）。
- **不要双跑**：插件与 proxy 同时喂写时，内容级幂等只能拦「同一写者的重试」，拦不住两个写者（`MemoryCore/src/core/skill/conversation-add/dedupe.ts:20-22`）。

---

## §5 排错速查（6 条）

| 症状 | 先看什么 | 结论 / 修法 |
|---|---|---|
| 记忆完全不进（inert） | ready 行 `identity=missing(...)`；日志 `memory stays inert for this process`（`dsh-plugin/src/index.ts:399-441`） | 补三轴：`deploy.sh --identity team,agent,user` 或 `dsh-plugin/scripts/agemem-identity.mjs` |
| `health=fail(no-answer)` | `GET <endpoint>/health` 3s 超时（`dsh-plugin/src/index.ts:484`） | core 没起 / `server.baseUrl` 错 / 端口不通，先通 health 再谈注入 |
| recall 404 / 504 / 422 | 404 = `v3Recall.enabled=false`（`MemoryCore/src/gateway/v2-router.ts:2075-2079`）；504 = `/v3/recall timed out`（`:2255`）；422 = 三轴缺失（`:755-773`） | 404 开 yaml 键；504 调 `v3Recall.timeoutMs`；422 查身份（插件已带三轴，见 `dsh-plugin/src/memory-client.ts:40`） |
| 工具没出现 | 归档里 `memory_recall registration failed` / `UNSUPPORTED_SCHEMA`（`dsh-plugin/scripts/verify-installed.mjs:141-155` 会 FAIL） | 历史坑：**可选参数写 `required:false` 会让宿主静默丢工具**；今天宿主仍不校验 `parameters`（`docs/ops/dsh-plugin-writeback-rootcause.md` §2） |
| 写回没落库 | `$DSH_HOME/agemem/outbox.dead.jsonl` 的 `reasonClass` | `auth`（401/403）/ `l0-http` / `skill-feed-http` / `-transport`（`dsh-plugin/src/index.ts:256-260`、`:869`、`:944`）；`chunk i/n:` = 第 i 片失败且前 i-1 片**已落库**（`production-profile.md` §2.1 第 4 条） |
| 什么都看不见 | ready 行 `debug=off` | `config.debug: true` 才建 `$DSH_HOME/agemem/agemem.log`（`dsh-plugin/src/index.ts:269-274`）；GUI 里没有 stderr，没日志等于黑盒 |

---

## §6 本手册的诚实边界

1. 表中 **16 项「未实现」** 的配置键名来自矩阵 §2 的票面约定，`DEFAULT_CONFIG` 里并不存在；实装键名以对应票为准，本手册不预设。
2. 读数全部转引（矩阵 / parity / profile / 各取证文档），**本手册自身没有新增实测**；转引的毫秒/字符数均标了出处。
3. 行号是 2026-11-01 快照；`dsh-plugin/` 未入库且并行修改，引用以「文件 + 符号」为准。
