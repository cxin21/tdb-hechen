# MemoryProxy → DSH 插件：注入能力 parity 矩阵

> 目的：用户要求「完整版，不许降级/删减」。本表以 **MemoryProxy 实际注册的注入器**为基线（`MemoryProxy/src/injection/index.ts:318-510` 的 `registry.register(...)` 调用，逐个核对 = **12 个**），映射到 DSH 插件的承载位置与现状，作为补齐清单的唯一真源。
> 生成 2026-11-01；**2026-11-01 02:00 二次校正**：票号与板子对齐、core_memory 双源更正、L3 尾部剥离事实补入、current_feeling 改挂 task-90。

## 0. 锚点语义对照（为什么不能 1:1 搬）

| Proxy 锚点 | 语义 | DSH 等价承载 | 代价 |
|---|---|---|---|
| `slot: skills/knowledge/memory, relation: before/after/inside_append` + `cacheStrategy: session_init` | 塞进系统提示词固定段，**整会话只算一次**（prewarm + 指纹缓存） | **head pack**（`system/message`，会话开始注入一次 + compaction 后重注） | 有字符预算（当前 maxChars 8000） |
| `user.before` + `cacheStrategy: none` | 每轮按当轮用户消息现场渲染 | **volatile**（pre-step 追加 user/message，append-only） | 每轮固定字符 + 破坏 KV cache，预算 1200→1500（task-61） |
| `tools.before_call` + `cacheStrategy: none` | 动作点（工具调用前）注入 | **`tool/call` / `tools/pre-execute` 钩子**（宿主已提供） | 需要新挂点，插件当前未用（task-76） |
| `system.suffix` + `cacheStrategy: none` | 贴在系统提示词最末 | `ctx.systemPrompt.section`（text 可为函数，index.ts:614-619 已在用） | 顺序号决定位置（asset-reflection 用 order=10302） |

## 1. 逐个映射（12 个注入器，与 registry.register 一一对应）

| # | Proxy 注入器（行号为 register 点） | 产出块 | 锚点 / 缓存 | DSH 现状 | 票 |
|---|---|---|---|---|---|
| 1 | `SkillInjector` `injection/index.ts:322-324` | `<cloud_skills>`（core 渲染的 listing，20 条硬上限） | skills/before, session_init | **实现中**：head pack 段直接嵌 `/v3/skill/listing` 的 `data.listing` 串 | task-72 |
| 2 | `SkillToolsInjector` `:330` | `<skill_tools>` 的 curl 配方（**在 DSH 无意义**） | skills/before, session_init | **改造中**：换成 10 个原生工具（读 4 / 写 6），写口必须自己 RMW 取 `expected_version` | task-72 |
| 3 | `KnowledgeToolsInjector` `:337-341` | `<knowledge_tools>` 团队知识两段式自发现 | knowledge/after, session_init | **缺** | task-75 |
| 4 | `WikiRecallInjector` `:347-371` | `<team-wiki>` 命中条目（per-turn） | user.before, none | **缺**：core 薄转发已交（task-73），插件段待做 | task-74 |
| 5 | `TdaiProfileMemoryInjector` `:394-395` | `<tdai_profile_memory>`：`<l3_core_memory>`（/v3/core/read，truncate 6000）+ `<l2_scene_index>`（listL2，行=`- \`path\` — summary(≤200)`）+ 指南 | memory/inside_append, session_init | **部分**：head pack 从 persona 尾部解析场景索引（10003→4565），**未核 listL2 端点** | task-90（研究）→ 后续实现票 |
| 5b | 同上，`loadCoreMemorySlots` `:137-157 / :265-284` | `<core_memory>`：`/v3/core-memory/read` `{format:"narrative"}` 的 slots（identity_narrative / strict_rule），逐槽 `<slot>内容</slot>` | session_init | **缺**（DSH 侧零注入面） | task-88 |
| 5c | 同上，fixed-asset agents `:35-39` | self + 借入 ≤2 个 agent 的画像分段 | session_init | **待核** | task-77（已判部分） |
| 6 | `TdaiCurrentFeelingInjector` `:400` | 当轮感受块（cacheStrategy=none，每轮重算） | user.before, none | **部分**：task-61 取 `<soul-feeling>`（36–40 字符，随 /v3/recall 同块） | task-90（逐字对拍） |
| 7 | `TdaiSoulRedlineEventInjector` `:405-407` | 红线动作点近端 event | tools.before_call, none；**缺省 `session_head` ⇒ execute 直接 \[\]** | **缺** | task-76（缺省 = 与 proxy 等价的「空」） |
| 8 | `TdaiSoulReanchorInjector` `:412-414` | 身份漂移再锚定（首轮 + 每 intervalTurns 轮） | tools.before_call, none；**缺省 `driftTrigger: off`** | **缺** | task-76 |
| 9 | `TdaiToolsInjector` `:431-433` + `memory-tools-guide.proxy.ts` | 记忆工具指南（curl 版本） | memory/before, session_init | **已有**：`guidance.ts`（原生 `memory_recall` + 指南），parity 由 MemoryProxy 侧 20 例单测守 | 完成（task-19） |
| 10 | `TdaiL1RecallInjector` `:456-473` | L1 召回块（proxy 走 /v3/atomic/search） | user.before, none | **已有且更强**：volatile 走 `/v3/recall`（R7 分层 + 结论层 + soul + mood） | 完成（task-61/43） |
| 11 | `AssetReflectionInjector` `:487-508` | 反思要求（URL marker 选入） | system.suffix, none | **已实现模块，未接线** | task-82 + 接线（index.ts 归 dsh-plugin） |
| 12 | （`shouldRegisterKnowledgeInjector` 同族）knowledge 配置分叉 `:337` | 与 3 同块，端点可 diverge | session_init | 跟随 task-75 | task-75 |

## 2. 关键事实（2026-11-01 实测，勿再凭印象）

- **`<core_memory>` 与 `<l3_core_memory>` 是两个不同源**：前者 `POST /v3/core-memory/read` body `{format:"narrative"}`（`tdai/client.ts:458-482`），实测 200/7ms，slots = `identity_narrative` 1562 + `strict_rule` 1471 字符；不带 format 时回 3 槽（identity 774 / self_identity 869 / strict_rule 1471）。后者 `/v3/core/read` → `data.content`，实测 **10003 字符**，proxy 截到 6000。
- **persona 尾部的 Scene Navigation 必须剥**：`loadAgentProfile` 调 `stripSceneNavigation`（`tdai-profile-memory-injector.ts:300-311`，注释 :303-305），因为它另注 `<l2_scene_index>`。我们插件反着来（persona 尾部直接被当 L2 索引）⇒ 实测 head pack 4939 字符里 **334 字符重复**。@注意 verify-installed.mjs 依赖 `- scene_blocks` 标记，任何去重方案必须保住它。
- **技能写口必须有 `expected_version`**（`MemoryCore/src/gateway/skill-schemas.ts:101/:108/:117/:182/:189`），proxy 自己的 curl 配方没带 ⇒ 实测 HTTP 200 + `code=40001`，六个写工具全废。带版本后全链真通（create v1 → update v2 → stale=40901 → patch v3 → files/write v4 → files/read → files/remove v5 → delete → get 40401）。
- **skill API 是 HTTP 200 + `body.code` 双轨**，且 `/v3/skill/get-by-name` 只给 header 会 40001（`:143-152` 的 team/agent 必填不并 header）⇒ 插件必须三轴进 body。
- **wiki 合并按 `absScore`**，不是 `score`（实测 `{score:0, absScore:1.2665}`）；`deadlineHit=true` 是部分成功，不得整段丢弃。
- proxy 敢塞 10.9–14K 是因为 session_init 只算一次；DSH head pack 同为会话级 ⇒ **总量上限由配置显式给出**（`headPack.maxChars`），禁止隐式硬截断（`compressHeadPack` 当前是硬截断）。

## 3. 预算与分账（实施时必须照此）

| 段 | 上限 | 载体 | 依据 |
|---|---|---|---|
| persona（L3） | 4565 实测（压缩后） | head pack | head-pack.ts:36 |
| sceneIndex（L2） | ≤3000 | head pack | 本表 §1-5 |
| `<cloud_skills>` | 8000 | head pack | task-72 票面 |
| `<core_memory>` | 3000 | head pack（最前） | task-88 票面 |
| `<knowledge_tools>` | 3000 | head pack | task-75 |
| `<team-wiki>` | 800 | volatile | task-74 票面 |
| soul（identity+feeling） | 600（feeling 预留 ≥12） | volatile | task-61 |
| head pack 总 | 20000（全开档） | — | all-on-capability-matrix.md §4 |
| volatile 总 | 1500 | — | task-61 |

## 4. 未证实项（写清楚，别当已知）

- fixed-asset agents 的「self + 借入 ≤2」解析是否已被 `/v3/core/read` 内部完成（未核，task-77）。
- `TdaiSoulRedlineEventInjector` 依赖的渲染源 `soul-redline-render.ts` 在 DSH 侧是否需要同样的「rider 句」（以上为既有红线近端复现…）——按 task-76 对齐。
- `TdaiCurrentFeelingInjector` 与 `<soul-feeling>` 是否同源同形（task-90 逐字对拍中）。
- proxy 的 `getCoreKnowledgeClient` 在服务 id 与 wiki 绑定的错位问题（`injection/index.ts:350-353` 注释自述曾 404）——DSH 侧走 core 薄转发后由 core 统一处理，不再复现该坑。
