# dsh-plugin 半成品审查（可直接上生产判定）

- 审查人：record-pipeline（teammate）
- 快照时刻：**2026-10-31T21:36–21:50（+08:00）**。审查期间 `dsh-plugin/src` 与 `scripts` 正被其他队友改动，本文件所有 `文件:行` 以该快照为准；`dsh-plugin/` 整目录在 git 里 untracked（`?? dsh-plugin/`），无 diff 可回溯，复核时请以行号附近的代码文本为准。
- 审查对象：`dsh-plugin/`（src 11 文件 / 4729 行、scripts 3 文件、README、package.json）。
- 方法：逐文件读源码 → 与 MemoryCore 侧真实 zod schema / handler 逐字对照（不是看本仓库自己的测试）→ 与唯一一次真机 e2e（`docs/ops/dsh-plugin-e2e-report.md`，一次性 `agemem-e2e` profile，已回滚）交叉核对 → 解码真实会话存档验证宿主事件形状。
- 证据基线：`cd dsh-plugin && npx vitest run` → **11 files / 134 tests 全 PASS**（config 11、head-pack 14、ids 3、tools 8、writeback 13、memory-client 22、volatile 15、guidance 11、outbox 9、turn-pipeline 2、index 26）。**测试全绿不等于生产可用**：本次找到的 P0 全部在测试夹具之外。

## 0. 判定摘要

| 维度 | 判定 |
| --- | --- |
| 注入面（head pack / volatile / guidance section） | **可用**；真机 e2e 已证（`docs/ops/dsh-plugin-e2e-report.md` §2/§3），场景索引 14/14 未丢，无截断标记 |
| 写回面（L0） | **可用但带毒**：注入不泄漏（e2e 0 行），但把模型 reasoning 当正文写进 L0（P0-1），且单条/批量上限与 core schema 冲突（P0-2/3）会整批死信 |
| 写回面（L2 skill） | **默认开启但无观测**：契约字段缺 space_id/task_id，归档结果被丢弃，失败只在 debug 级（P1-1/2/3） |
| 配置面 | 键都有消费者（无配了不生效的键），但**部署脚本只写 server.***，其余键无法按 profile 调（P1-4） |
| 部署/回滚 | 不对称：无升级路径、失败留孤儿安装、回滚删整个 `.pnpm/@tdb`、还原后再 remove（P1-5/6/7/8） |
| 生产状态 | desktop profile **当前未安装**（patch 无 `tdb-agemem-dsh` 行、profile package.json 无依赖、`~/.dsh/agemem/` 不存在），最后一次操作是回滚（`.deploy/20261031-211135/dump-config-after-rollback.yml`）。**「生产已验证」目前不成立**，只有一次性 profile 的 e2e |

结论：**不能按「完整逻辑、无半成品」直接上生产**。P0 三项（reasoning 入 L0、L0 批次超限死信、失败静默）必须先修；P1 的 skillFeed 双喂与部署面缺口需要 Lead 拍板后再落。

## 1. 合约层对照（插件请求 vs MemoryCore 真实校验）

| 端点 | 插件发的 body | core 侧校验 | 判定 |
| --- | --- | --- | --- |
| `/v3/core/read` | `{}` + isolation（`memory-client.ts:350`，isolation 由 `:293` 合并进 body） | `coreReadRequestSchema = idFields + {}`，id 全可选（`MemoryCore/src/gateway/generated/schemas.ts:274`） | 一致 |
| `/v3/atomic/search` | `{ query, limit }`，limit clamp 1..50（`memory-client.ts:357-365`） | `query: min(1).max(2048)`、`limit: int 1..100 default 5`（`generated/schemas.ts:191-197`）；路由读 `limit`（`v2-router.ts:1672-1687`） | 一致 |
| `/v3/scenario/ls` | `{}` + isolation（`memory-client.ts:371-375`） | `scenarioListRequestSchema`（`generated/schemas.ts:235`）；出参 `entries[].path` | 一致 |
| `/v3/conversation/add` | `{ session_id, messages[{role,content,timestamp(ISO)}] }`（`memory-client.ts:406-433`） | role 只允许 `user`/`assistant`、`content: min(1).max(8192)`、`timestamp: iso.datetime`、`messages: min(1).max(100)`（`generated/schemas.ts:82-98`；v2 覆写 `v2-schemas.ts:115-121`，路由 `v2-router.ts:789-792` 失败返回 400） | **部分不符**：条数无上限、单条上限 20000 > 8192（P0-2/3） |
| `/v3/skill/conversation/add` | `{ session_id, messages[...] }` + isolation（`memory-client.ts:489-493`） | `session_id/user_id/team_id/agent_id` 必填且禁 `|`、`space_id`/`task_id` 可选、5 role、500 条（`MemoryCore/src/gateway/skill-schemas.ts:254-264`；handler `skill-handlers.ts:937-966`，space 回落 `auth.serviceId`） | 字段能过校验，但**缺 space_id/task_id**（P1-2） |

isolation 三元由 `MemoryClient.call()` 统一并入 body（`memory-client.ts:293`），所以「body 里没有身份」不是漏写——`test/memory-client.test.ts:217-226` 断言了这一点，核对通过。

## 2. P0：不修不算上生产

| 文件:行 | 现状 | 判定 | 生产影响 | 修法 |
| --- | --- | --- | --- | --- |
| `src/writeback.ts:108-117`（`textOfContent`），用于 `:365` user、`:382` assistant、`:409` tool result | 把 content 里**任何**带 `text` 字段的 block 拼成正文，不看 `block.type` | **半成品/带毒** | 本 build 的 `assistant/message.content` = `[{type:"reasoning",text:1293},{type:"text",text:319}]`（实测解码 `scratch/e2e/session-834ccf55-….jsonl`），于是 L0 写入 1613 字、开头是 `The user asks: …` 的 CoT（`docs/ops/dsh-plugin-e2e-report.md` §4.3，L0 #13261）。后果：记忆库长期存推理文本，召回命中带回推理噪声、embedding 成本翻倍；L2 skill 抽取同样把 CoT 当 assistant 发言喂给 extractor | 只收可见文本：`block.type === undefined \|\| "text" \|\| "output_text"`；`reasoning`/`thinking`/`redacted_reasoning` 丢弃（需要时单独打标）。补测试：给定上述真实 content 数组，断言写回只剩 text 段 |
| `src/writeback.ts:215-217` + `src/memory-client.ts:412-421` | 单条消息截断 `maxChars = 20000`（无 config 键，硬编码），`addConversation` 不再做长度校验 | **与 core 契约冲突** | core `content.max(8192)` 硬拒整批（`generated/schemas.ts:88`）。一次 >8192 字的回答 ⇒ 该轮 user+assistant **全部** 400 ⇒ outbox 重试 8 次 ⇒ 死信。user 原文一起丢，等于这轮对话对记忆完全不存在 | 单条 clamp 到 8000（留余量）并在截断处加 `…[truncated]`；把 8192 写成常量并从 core schema 抄注释；补测试：9000 字回答仍以 ≤8192 发送 |
| `src/memory-client.ts:412-433`（无条数裁剪）| 不限制单批消息数 | **与 core 契约冲突** | core `messages.max(100)`（`v2-schemas.ts:120`）。工具密集长回合可产生 >100 条 assistant 消息 ⇒ 整批 400 ⇒ 同上死信 | 发送前裁剪到 100 条（保头尾、warn 一次说明丢了中间 N 条） |
| `src/index.ts:340` + `src/outbox.ts:131-155` | L0 deliver 只返回 `boolean`，`addConversation` 失败不区分原因、不打日志；死信 reason 恒为 `delivery rejected` | **静默失败** | 写不进去在生产里唯一的痕迹是 `~/.dsh/agemem/outbox.dead.jsonl`（还要 8 次重试之后），而 debug 级日志在宿主 headless 下被过滤（e2e §4.1 实测 0 条 `agemem:` 日志） | deliver 返回 `{ ok, status, reason }`（outbox 已支持该形状，`outbox.ts:140-146`）；L0 失败首次 warn 一次（带 status），skill 同理把 `debug` 提到 `warn` |

## 3. P1：口径分叉 / 部署面缺口（需 Lead 拍板或排期）

| 文件:行 | 现状 | 判定 | 生产影响 | 修法 |
| --- | --- | --- | --- | --- |
| `src/config.ts:166` + `README.md:110-124` | `writeback.skillFeed` 缺省 **true**；README 明写「两条路径同时作用同一身份 ⇒ 每回合写两遍」并建议关写回 | **默认值与自己文档的排他规则冲突** | 同一身份若同时被 MemoryProxy（8096）喂过，每条 exchange 进 L2 buffer 两次 ⇒ 归档触发阈值提前、同一段对话被抽两遍 | Lead 拍板：缺省改 false（显式开启），或 deploy 时按「该身份是否已有 proxy 写入」决定；无论哪种都要在 README 配置块里写出该键 |
| `src/memory-client.ts:489-493` vs `MemoryProxy/src/skill/handler-glue.ts:129-140` | 插件不发 `space_id`、`task_id`；proxy 两个都发（且 proxy 无 `space_id` 直接 skip，`:86-92`） | **口径分叉** | 插件 L2 归档落到 `auth.serviceId`（`skill-handlers.ts:961`，本机 = `default`）分区，且 `task_ref_id` 为空 ⇒ 场景抽取无法按 task 归属、与 proxy 写入分属两个分区 | 明确 dsh 路径的 space 语义：要么显式传 `space_id`（= serviceId 时等价），要么在 README 写明「L2 落在服务实例分区、不含 task 归属」 |
| `src/memory-client.ts:495-496` + `src/index.ts:314-325` | `archived`（是否触发归档、原因）被丢弃，成功路径零日志；失败仅 `debug` | **无观测** | 无法回答「L2 到底在不在长」：阈值未到、归档成功、被 core 拒收，三种情况在缺省 `debug:false` 下完全同形 | 成功/归档时按 `debug`/节流 `info` 打一条（status+reason+msg 数）；README 的排障一节写清看哪条日志 |
| `scripts/deploy.sh:197-213`（`render_entry`）+ 注释 `:193-196` + `README.md:33-59` | 脚本只写 `server.{baseUrl,serviceId,apiKey,teamId,agentId,userId}`；注释声称「loader 整块替换 config，这一块就是全部插件配置」；README 示例却列出 `headPack/volatile/writeback/tools/debug` | **文档与产物漂移** | 部署后无法按 profile 关掉双喂（skillFeed）、无法调 `headPack.maxChars`/`volatile.maxChars`，只能手改 patch 且下次 deploy 被覆盖 | 二选一：① `render_entry` 支持 `--set headPack.maxChars=8000` 之类的透传并写进 manifest；② README 删掉那段示例、改成「deploy 只写 server.*，其余键请手改 patch」 |
| `scripts/deploy.sh:121-124` | patch 里已有本插件行 ⇒ 打印 `nothing to do` 并 `exit 0` | **无升级路径** | 插件升级/改配置后重跑 deploy 静默什么都不做，运维会以为已生效（本次 e2e 之后重装必须手改 patch） | 已存在时走「先 rollback 再 insert」或原地替换该 insert 行；至少把 `nothing to do` 改成明确提示「需先 `rollback.sh`」 |
| `scripts/deploy.sh:231-242` | dump-config 失败只 `cp` 回 patch 文件；包已装、`STATE_DIR/last` 未写 | **失败留孤儿安装** | 此后 `rollback.sh` 无 `last` 可读（`rollback.sh:36-39` 直接退出），孤儿包留在 profile 里无法用脚本清理 | 失败分支补齐：`dsh plugin remove` + 删 `node_modules/@tdb`，或至少写 `last` 让 rollback 可用 |
| `scripts/rollback.sh:73-77` | `rm -rf node_modules/.pnpm/@tdb`（整个作用域） | **越界删除** | 同 profile 里其他 `@tdb/*` 包的虚拟 store 副本一起被删，可能连带破坏别的插件 | 只删 `.pnpm` 下本包的目录（`@tdb+agemem-dsh@*`），保留作用域目录 |
| `scripts/rollback.sh:57-70` | 先还原 `package.json`，再执行 `dsh plugin remove` | **顺序反了** | pnpm 会重写刚还原的 `package.json`/`pnpm-lock.yaml`，回滚后清单与备份不一致 | 先 `remove` 再还原备份（或还原后校验 diff 为空） |
| `src/writeback.ts:417-438` | 成功路径只靠 `agent/turn-stopping`；`turn/end` 只在 `reason.kind === 'error'` 时 finalize | **单事件依赖** | 宿主不触发 turn-stopping（中断/异常退出/headless 变体）时该回合永不出队；`records` 上限 64（`:214`、`:232-235`）会**静默淘汰**最旧回合——既不投递也不进死信，违反自己的零删红线 | 增加兜底：下一个 `turn/start` 时把上一个未完成 turn 按 `aborted` finalize；淘汰时 emit warn 或把 record 落 outbox |
| `src/writeback.ts:363` | `user/message` 只认 `candidate.source?.kind === 'user'` | **窄路径，静默丢** | 宿主改 kind/不带 source 时用户原文全丢，L0 只剩 assistant 半边（召回无法锚回问题）；`volatile.ts:66-83` 有「排除注入块」兜底，两处不对称 | 复用 volatile 的兜底顺序：先 `source.kind === 'user'`，再退回「排除 plugin: 前缀的 user 消息」；补测试 |
| `src/index.ts:252` + `src/guidance.ts:53/61/106/115` | 口径段恒用模块级 `GUIDANCE_TEXT = buildGuidance()`；`buildGuidance` 的三个开关无 config 键 | **能力不可达** | 无法在 profile 里关掉 currency/preference/toolsGuide 段；若 MemoryCore 侧已注入同文案（read 路径），系统提示里会重复 | 加 `guidance: { currency, preference, toolsGuide }` 配置键（缺省全 true，与 MemoryCore 口径同源），或删掉未用的 options 与 `GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE`（`:94`，仅测试引用） |
| `src/tools.ts:14-24` + `package.json`（无 dependencies/peerDependencies） | 懒 import `@deepseek-ai/dsh-tools`，失败回退 identity 定义 | **生产未验证** | 实测从 `~/.dsh/profiles/desktop` 解析该包 `ERR_MODULE_NOT_FOUND`（该目录 `@deepseek-ai` 只有 cosmokit、schemastery；`app.asar.unpacked/dsh/node_modules/@deepseek-ai` 只有 dsh-session-log-export、libreoffice-kit*）⇒ `memory_recall` 基本走 identity fallback；宿主是否接受这种定义、工具是否真的注册，没有任何真机证据（e2e 没调工具） | 参照 esn-workbench 的写法：`peerDependencies` 声明 + 静态 import `defineTool`（缺失即 warn 不注册），并在 e2e 清单里加一条「`memory_recall` 出现在工具列表且返回命中」 |

## 4. Lead 三个旧坑的当前状态：均已修（需回归守住）

| 坑 | 现状 | 证据 |
| --- | --- | --- |
| head pack 先裸截再结构化 ⇒ `structureHeadPack` 生产死代码 | **已修**：先 `compressHeadPack` 再算预算 | `src/index.ts:186`；`src/head-pack.ts:133-141`（render 内也先结构再 clamp）；回归 `test/index.test.ts:84-119`；e2e §2 实测 14/14 场景行、无 `[agemem head pack truncated]` |
| 写回自拼 messages、不消费 payload.messages ⇒ user 原文死代码 | **已修**：`deliver` 直接用 `payload.messages`，空则 warn 保留重试 | `src/index.ts:332-340`；e2e §4 实测 L0 user 行 = 17 字原文、注入泄漏 0 行 |
| 身份硬编码本机三元组 | **已修**：缺省全空 + inert | `src/config.ts:128-130`；`test/config.test.ts` “ships no identity and no private identifiers” / “is inert … while the identity is unconfigured” |

## 5. P2：清理项（不阻塞，但「无半成品」红线要求清掉）

| 文件:行 | 现状 | 判定 | 修法 |
| --- | --- | --- | --- |
| `src/writeback.ts:296-313`、`src/index.ts:340`、`src/writeback.ts:16`、`README.md:12`、`README.md:132` | payload 里 `assistantText`/`usage`/`workspaceId`/ `endedAt` 有收集、无人消费（L0 只发 `sessionId+messages`；skill 只发 messages）；注释却说 usage 是「token 记账唯一真源」 | 死字段 + 口径不一致 | 二选一：真把 usage 送 core（新增字段或日志），或删字段并改注释/README 为「本插件不做 token 记账」 |
| `src/writeback.ts:44-48` | 注释仍写「TurnEndPayload … **没有 messages**；v3 端点由队友在改，收口时以这份形状为准」 | 生产代码里的临时说明 | 删掉该段，改为陈述现状（`memory-client.ts:75-93` 已有 messages） |
| `test/head-pack.test.ts:167` | 注释仍写「composeHeadPack clamps the persona before HeadPack sees it」 | 过时注释（`index.ts:186` 已先 compress） | 改成「compress 之后再预算」 |
| `src/index.ts:15` | `Scope (v0): three host seams` | 与实际不符：已是 guidance section + head pack + volatile + writeback + tool 五段 | 改为四缝一工具，并去掉 v0 措辞 |
| `src/index.ts:51` | `export function textOfContent` 在 src 内无引用（`writeback.ts:108` 有同名私有实现） | 死导出 + 双实现漂移风险 | 删掉或让 writeback import 它（连同 reasoning 过滤一起收敛到一处） |
| `src/memory-client.ts:500/512` | `deleteConversation`/`health` 只有测试调用 | 死 API | 保留则注释写明「运维/测试用」；否则删 |
| `src/outbox.ts:251-293` + `package.json` scripts | `requeueDead()` 无任何生产/运维入口，`outbox.dead.jsonl` 只能手改 | 死运维通道（零删红线全靠人工） | 加 `npm run outbox:requeue`（或用 `dsh` 子命令）并在 README 写清死信处理步骤 |
| `src/writeback.ts:263/373/385`、`src/volatile.ts:172/218` | 一律 `slice(0, maxChars)`，按 UTF-16 code unit 切 | 可能切出孤立代理项；volatile 还会切在条目中间（e2e §4.2 实测尾部「…角色：」） | 截断按码点（`Array.from`）或按行回退到最后一个完整条目；volatile 至少保证不在 `- [layer]` 行中间断 |
| `src/index.ts:349` | `workspaceId: process.cwd()` | 不可配、无人消费（见上） | 与死字段一并处理 |
| `README.md:76` | 「120 个用例」 | 实测 **134**（11 files） | 改成 134，或去掉具体数字改为「`npx vitest run` 全绿」 |
| `README.md:3/125`、`src/config.ts:157` | `插件 v0` / `已知边界（v0 有意不做）` / `800 chars is the agreed v0 ceiling` | 「v0」措辞与「可直接上生产」冲突 | 改为版本号（0.1.0）或写明「本版边界」 |

## 6. 部署 / 回滚对称性

| 项 | deploy.sh | rollback.sh | 判定 |
| --- | --- | --- | --- |
| profile 三文件备份/还原 | 备份到 `.deploy/<stamp>/*.bak`（`:175-181`） | 还原（`:57-63`） | 对称 |
| 包安装/卸载 | `dsh plugin add file:<tgz>`（`:190`） | 先还原再 `remove` + 删目录（`:66-77`） | **不对称**：顺序反了、删除越界（P1-7/8） |
| 失败路径 | 只还原 patch，包留着、无 `last`（`:231-242`） | 依赖 `last`，读不到就退出（`:36-39`） | **不对称**：孤儿安装无脚本可回滚 |
| 升级 | 已有行 `exit 0`（`:121-124`） | — | 无升级路径 |
| 残留 | `artifacts/*.tgz` 累积 | 不清理 | 需人工；建议加 `--prune` |
| 运行态数据 | `~/.dsh/agemem/outbox*.jsonl` | 不清理（正确，属数据） | 需在 README 写明「回滚不删记忆/待投递队列」 |
| 测试 | 无 | 无 | `bash -n` 之外零校验；本次三个真实故障（参数写法、空 patch `[]`、无升级路径）都是 e2e 现场才发现的 |

## 7. 测试覆盖缺口（都属「测试绿但生产可能死」）

1. 无任何 `scripts/deploy.sh`/`rollback.sh` 测试（e2e §4.4 的三个坑靠人肉踩）。
2. 无 `smoke-v3.mjs` 自动化（活体脚本，可接受，但应在 README 标注「只在真机跑」）。
3. 无测试覆盖「assistant content 含 reasoning 块」——本次最严重的数据污染就是这么漏出去的。
4. 无测试覆盖「单条 >8192 字」「单批 >100 条」——core schema 上限没有在插件侧被断言。
5. 无测试覆盖 `skillFeed` 双喂（同一身份两条管道写两次）。
6. 无测试覆盖 `user/message` 缺 `source.kind` 时静默丢失。
7. 无测试断言 `assistantText`/`usage` 最终**不**被发送（口径不一致无人守）。
8. `memory_recall` 注册只在 fake ctx 里过；没有真机证据（见 P1-11）。

## 8. 建议的最小收口批次

1. **P0-1**（reasoning 过滤）+ 测试 —— 一行 helper 的事，但它决定 L0/L2 数据质量。
2. **P0-2/3**（8192/100 上限对齐）+ **P0-4**（失败可观测）—— 决定「写不进去」是否会被发现。
3. **P1-1** 拍板 skillFeed 缺省；若要留 true，必须在 deploy 里可配并写进 README。
4. **P1-5/6/7/8** 部署脚本四处修（升级路径、失败回滚、删除范围、还原顺序）。
5. **P1-11** 工具注册真机验证（加进 e2e 清单）。
6. P2 清理（死字段/过时注释/v0 措辞/README 用例数）与第 7 节补测。

做完 1–2 才谈得上「写回面可上生产」；3–4 是「运维可交付」；5–6 是「无半成品」。

---

附：本次审查未改动 `dsh-plugin/src` 任何文件；上述行号对应快照 2026-10-31T21:36–21:50。真机 e2e 报告见 `docs/ops/dsh-plugin-e2e-report.md`（一次性 profile，已回滚；desktop 全程未触碰）。
