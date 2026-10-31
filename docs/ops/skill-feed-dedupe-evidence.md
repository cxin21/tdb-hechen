# 同身份双喂重复写入实证（skill feed / L0）

> 任务 task-25。待答问题：**同一身份两条写入路径同时喂同一会话（MemoryProxy 桥 + dsh-plugin 插件）时，到底会不会重复落库、会不会提前触发蒸馏、要防的话最少做什么。**
> 环境：本机 core `http://127.0.0.1:8420` 活体（2026-10-31 21:40–21:43），identity `team-2k12lgb650 / agt-2m7buribzz / usr-2m7b1144d9`，`data.baseDir=D:/TDB/data`，代码基线 `main@17c0582` + 工作树未提交改动。
> 探针：`scratch/dedupe/probe.mjs`、`scratch/dedupe/probe2.mjs`，原始读数 `scratch/dedupe/probe-out.json`。一次性 session：`probe-dedupe-1793454039865`（纯文本）、`probe-dedupe-tool-1793454039865`（含 tool_call）、`probe-dedupe-l0-1793454039865`（L0 路径）。探针正文全部带 `PROBE-SENTINEL-*` 前缀，便于事后清理与检索。

## 0. 直接回答三问

| 问 | 答 | 一句话依据 |
|---|---|---|
| ① L0（`/v3/conversation/add`）会重复行吗 | **不会**（同 session + 同 role + 同 content，10 分钟窗口内） | E3：第二次投递返回 `accepted_ids:[]`、`total_count:0`；日志 `[F-DUP-1] … 2 duplicate(s) skipped, 0 accepted (window=10min)` |
| ② skill buffer（`/v3/skill/conversation/add`）会重复累加、提前归档吗 | **会**：逐字翻倍，并把归档阈值提前打满 | E1：2 条 → 4 条、`byte_count` 362 → 724，data-current 解包为 `[A1,A2,A1,A2]`；E2：只有 3 个唯一 tool_call 的载荷投 4 次即命中阈值 10 触发归档，归档 48 条里 user 12 条只有 **1 种**内容 |
| ③ 最少要做什么 | 插件侧**无法自证**「我是不是第二个写者」⇒ 运维层面只能排他（`writeback.enabled=false`，L0+skill 一起关）；技术层面的最小修复在 **core 的 skill buffer 入口做幂等**（对齐 L0 的 F-DUP-1） | §6 |

**一句话结论**：双喂不是「多几行日志」，而是**用重复内容把归档阈值提前打满，再把整批重复内容送进 L2 extractor**（实测 extractor 收到 `messages=48`，唯一内容只有 12 条）。L0 有幂等兜底；skill 链路 / L2 抽取链路上**没有任何去重**。

## 1. 三条路径的重复投递对照

| 路径 | 重复投递行为 | 观测读数 | 结论 | 依据 |
|---|---|---|---|---|
| **L0 写** `/v3/conversation/add` → `l0_messages` | 同 session + role + content 在 10 分钟内重复投递被跳过；批内也按 `role+\u0000+content` 去重 | E3 call1 `accepted_ids=[msg-46c7…, msg-caf5…]`（2 条）；call2 `accepted_ids:[] total_count:0` | **行级幂等成立**，重复投递不产生重复 L0 行 | `MemoryCore/src/gateway/v2-router.ts:874-891`（`store.hasRecentL0Duplicate(session_id, role, content, 600000)`）、批内去重 `:894-902`、实现 `MemoryCore/src/core/store/sqlite.ts:5590` |
| **L0 → 管线计数**（`notifyPipeline`） | 行被去重了，但**轮次按请求体的 user 消息条数计数**，与是否落库无关 | E3 第二次投递后日志：`count=1/2, L1 idle timer set`；首次投递：`Threshold reached (1), L1 task enqueued` + `Warmup advanced → 2` | **去重不保护蒸馏触发**：重复投递照样推进 warmup / 空闲计数，L1 被额外触发（warmup 阈值为 1 时每次投递都触发；固定阈值时等于提前一半） | `v2-router.ts:932-936`（`rounds = messages.filter(m => m.role === "user").length`）、`MemoryCore/src/utils/stateful-pipeline-manager.ts:175-220`（`captureAtomic({ rounds: effectiveRounds })`） |
| **skill buffer** `/v3/skill/conversation/add` → `data-current.jsonl` | **纯追加，零去重、零幂等键**：整批 incoming 直接拼到 existing 后面 | E1 call1 `currentMsgs=2, byte_count=362`；call2 `currentMsgs=4, byte_count=724`；解包 `[A1,A2,A1,A2]`，`dup02=true, dup13=true`，消息对象只有 `{role, content}` 两个键（无 id 可挂幂等） | **逐字重复累加**，重复多少轮就翻多少倍 | `MemoryCore/src/core/skill/conversation-add/prepare-archive.ts:63-66`（`const combined = [...existing, ...compressed]`）、`buffer-storage.ts:180-195`（`data-current` 每次整份覆盖写） |
| **skill 归档阈值** | 阈值判定用**累加计数**（`meta.tool_call_count + countRoles(incoming)`），重复内容同样计数 | E2 每次投递 +3 个 tool_call：`tool_call_count` 3 → 6 → 9 → **12**；第 4 次响应 `status:"archived", reason:"tool_calls"`，归档 `data-1793454131602.jsonl`（4382 字节，48 条：user 12 / assistant 12 / tool_call 12 / tool_result 12，唯一内容 1 / 1 / 3 / 3） | **提前归档**：只有 3 个唯一 tool_call 的载荷，投 4 次就把 10 的阈值打满；真实场景约 5 次真实工具调用即触发（正常应 10 次） | `MemoryCore/src/core/skill/conversation-add/add-handler.ts:203-210`（`addedToolCalls = countRoles(input.messages, TOOL_CALL_ROLES)`）、阈值缺省 `:101-105`（`toolCallThreshold:10, bytesThreshold:40960`）、命中分支 `:214-273` |
| **skill 归档 → L2 extract** | 归档文件整批进 extractor，重复内容不筛 | 归档后日志：`[skill-conv-worker] processing task_id=skill-extract-task-c0c032a6`、`extract start … messages=48`（48 条重复内容一次性进抽取） | **重复内容进入 L2 抽取**，token 成本 4 倍、抽取质量受污染 | 上一步归档文件 + `tdai-core-20261031-203348.out.log:82697-82699` |

## 2. 读数细节（可复现）

**E1｜skill buffer 纯文本双投**（`probe-dedupe-1793454039865`）
- 载荷：1 组 `[user PROBE-SENTINEL-A1, assistant PROBE-SENTINEL-A2]`，连发两次。
- call1 → `currentMsgs=2`、`meta.tool_call_count=0, byte_count=362`；call2 → `currentMsgs=4`、`byte_count=724`。
- data-current 解包 = `[A1,A2,A1,A2]`，`currentDup=true`（`currentDup` 是本探针的相邻对判定，序列非相邻故 false，但位置 0↔2、1↔3 逐字相同）。
- 界面无任何 warn/告警字段，响应恒 `status:"ok"`。

**E2｜tool_call 阈值提前命中**（`probe-dedupe-tool-1793454039865`）
- 载荷：每次 12 条消息、含 3 个 `tool_call`（`TOOL_CALL_ROLES` 只统计 `tool_call`，`add-handler.ts:51`）。
- `tool_call_count`：3（call1）→ 6（call2）→ 9（call3）→ 12（call4 命中）。
- call4 响应：`status:"archived"`、`reason:"tool_calls"`、`archive_key=skill_buffer/usr-2m7b1144d9/team-2k12lgb650/agt-2m7buribzz/probe-dedupe-tool-1793454039865/data-1793454131602.jsonl`；buffer 清空（`tool_call_count:0, byte_count:0`）。
- 归档文件解析（`{messages:[…]}` 单行，4382 字节，48 条）：`user` 12 条唯 1 种、`assistant` 12 条唯 1 种、`tool_call` 12 条唯 3 种、`tool_result` 12 条唯 3 种。
- 后续：worker 立刻消费该归档，`messages=48` 整批进 extract；随后 LLM 报 `当前已达到 Token Plan 用量上限…(2067)`，transient 重试多次（见 §7）。

**E3｜L0 行级幂等**（`probe-dedupe-l0-1793454039865`）
- call1 `data={"accepted_ids":["msg-46c7…","msg-caf5…"],"total_count":2}`；call2 `data={"accepted_ids":[],"total_count":0}`。
- 日志证据链：`[F-DUP-1] duplicate skipped (session=…, role=user, window=10min)` → `role=assistant` → `2 duplicate(s) skipped, 0 accepted`，**但**同一时刻 `count=1/2, L1 idle timer set`（管线计数照样 +1）。
- 首次投递触发了 L1：`Threshold reached (1), L1 task enqueued`、`Warmup advanced → 2`，随后 `l1-empty reason=llm_error inputMsgs=2`（LLM 配额，见 §7）。

**生产实况扫描**：`D:/TDB/data/skill_buffer/…/` 下 175 个 session 目录逐一比对相邻 exchange，**0 个**存在重复对（唯一重复是我造的 3 个 probe 目录）。即**今天生产尚未发生双喂**——desktop profile 未安装插件，且 LLM 配额已耗尽，L2 其实一直没跑起来。

## 3. 为什么双写一定会落在同一个 buffer（结构原因）

1. **session id 同源**：DSH 只在 header 里发 `x-deepseek-harness-session-id: session-<uuid>`（`MemoryProxy/src/agent-adapters/dsh.ts:11-14`），proxy 侧用 `deriveSessionId(c)` 直接取该 header（`MemoryProxy/src/memory/memory-bridge.ts:304`、`MemoryProxy/src/skill/skill-bridge.ts:235`）；插件侧 `sessionId = agent.session.id`（`dsh-plugin/src/ids.ts:21-32`）。**两者是同一个字符串** ⇒ 插件一旦装上，两路写的是同一 `sessionKey`、同一 `skill_buffer/{user}/{team}/{agent}/{session}/` 目录。
2. **skill 接口根本没有幂等键**：`/v3/skill/conversation/add` 的入参里没有 turn id / batch id / request id 可挂（`add-handler.ts` 只读 `messages`），所以服务端**无法区分「重试」与「新内容」**。
3. **buffer 是整份覆盖写**（`buffer-storage.ts:180-195`），重复累加是确定性的，不是并发竞争；即使串行投递也翻倍。
4. **反方注释已被证伪**：`MemoryProxy/src/tdai/pending-writes.ts:21-24` 声称「kernel 可能收到两条同样内容的 L0…L1/L2/L3 蒸馏管线幂等（同一 hash 一条），观测上仅 L0 冗余」。实测：L0 确实幂等，但 **skill buffer 与 L2 extract 链路零去重**，该断言对 skill 路径不成立。

## 4. 影响（按双喂真实发生推算）

| 影响面 | 推算 |
|---|---|
| 归档频率 | tool_call 阈值被重复内容打满：真实 ~5 次工具调用即归档（阈值 10 的一半）；纯文本靠 `bytesThreshold=40960` 同理会减半 |
| L2 抽取 token | 归档 batch 里 4 倍冗余（48 条 / 唯一 12 条）⇒ extract 调用 token 约 4× |
| L1 触发频率 | warmup=1 时每次投递都触发一次全量 L1 扫描（L0 行被去重但管线仍跑），成本翻倍且产出 0 新记忆 |
| L2 场景质量 | 重复 exchange 可能让同一 path 被多次 upsert / 场景热度虚高；**本轮未观测到**（LLM 配额耗尽，§7） |
| 观测性 | skill add 恒返回 `status:"ok"`，重复累加对所有调用方不可见 |

## 5. 最少防护（按代价从低到高）

| 方案 | 覆盖 | 代价 / 风险 | 归属 |
|---|---|---|---|
| **A. 运维排他**：同一身份若已由 MemoryProxy 喂写，则 `writeback.enabled=false`（**连 L0 一起关**，不要只关 skill，避免半开状态） | 100%（不并发就没有双喂） | 用户必须知道自己被 proxy 接管；插件装上即等于关掉记忆写回 | 文档 + README/production-profile（lead 已拍板，skillFeed 缺省保持 true，排他降级为运维规则） |
| **B. core 侧 skill buffer 幂等（推荐的最小技术修复）**：入口对 incoming 逐条与 `data-current` 尾部 + 窗口内已归档内容做 `(role, content)` 去重（对齐 L0 的 F-DUP-1 语义），并让阈值只统计**唯一**消息 | 双喂（内容相同时）+ outbox 重试（单客户端重复） | 内容不完全相同时无效（详见下）；需定 TTL 窗口；改动在 `add-handler.ts`/`prepare-archive.ts` | core（skill 负责人） |
| **C. 接口加幂等键**：`/v3/skill/conversation/add` 增加 `batch_id`/`turn_id`，服务端按 `(session, batch_id)` 幂等 | 单客户端重试/重放 100% | 需改契约 + 两个写者都传（proxy 与插件），且**不能**解决「两个客户端各自 batch_id 不同却内容相同」 | core + 两个写者 |
| **D. 插件侧自己判重** | 无真正覆盖 | 插件无法知道 proxy 是否已写同一回合（无共享状态、无接口可查），只能靠内容比较，而内容本来就不同（proxy 取模型原始输出、插件取宿主 assistant 文本，且 proxy 的 user 文本会带 `<acp …>` 等上下文标记） | 不推荐 |

**关于 B 的边界（重要）**：两路写者的**同一回合内容并不逐字相同**——proxy 侧 user 文本来自请求体（含 `<acp tokens=…>`、`<system-reminder>` 等上下文），assistant 文本来自模型原始输出（可能带 `reasoning_content`）；插件侧 user 文本来自宿主 `user/message` 事件、assistant 文本来自 `assistant/message` 的 text parts。所以「按 content 去重」只能拦住**同一个写者的重试**与**内容偶然一致的重复**；真正的跨写者双喂只能靠 A（排他）或 C（共享幂等键，且两路要能协商同一 turn 标识——目前没有）。

## 6. 未覆盖 / 存疑

- **L2 落库效果未观测**：本轮所有 LLM 调用都撞 `当前已达到 Token Plan 用量上限…(2067)`（`l1-empty reason=llm_error`、`skill-conv-worker transient extract failure`），所以「重复 exchange 会不会造出重复场景/虚高热度」没有实测读数，只能从代码推断（scene 写入是否按 path upsert 决定是合还是重）。**要做这个实验必须先补 LLM 额度。**
- **outbox 重试导致的单客户端重复未实测**：插件 outbox 失败会重试（`dsh-plugin/src/outbox.ts:127-199`），而 skill 接口无幂等键 ⇒ 「首次 POST 已成功但响应丢失」的退避重试会双写。本轮只验证了「同一 payload 连发两次必然翻倍」（E1/E2），该场景等价成立，但没有真机 outbox 重试链路读数。
- **跨 space 未测**：本轮只测 `space_id=default`；`space` 由 adapter prefix 决定（`buffer-storage.ts:150-176`），不同 space 会落不同目录，双喂跨 space 时会变成「两个 buffer 各自累加」，比同 space 更隐蔽。
- **未测 `/v3/conversation/add` 的 10 分钟窗口边界**：E3 在窗口内（毫秒级）验证；>10 分钟后的重复投递按代码会重新接受，未实测。
- **生产实况**：175 个 session 目录 0 重复对，且 desktop 未安装插件 ⇒ **当前没有正在发生的双喂**；本报告是「若同时开两路会发生什么」的判定，不是事故复盘。

## 7. 复现步骤（最小）

```bash
# 1) 同一 payload 连投两次（E1）
node scratch/dedupe/probe.mjs        # 输出 scratch/dedupe/probe-out.json

# 2) tool_call 阈值（E2）
node scratch/dedupe/probe2.mjs       # 每投一次打印 meta.tool_call_count

# 3) L0 幂等（E3）：同一 payload 连投 /v3/conversation/add 两次，比对 accepted_ids
```

读数在 `scratch/dedupe/probe-out.json`；buffer 落盘在 `D:/TDB/data/skill_buffer/{user}/{team}/{agent}/{session}/data-current.jsonl|meta.json`；归档在 `data-<ms>.jsonl`。三个 probe session 目录与 `probe-dedupe-*` L0 会话可安全删除（含 `PROBE-SENTINEL-` 前缀，不含真实用户内容）。

## 8. 修复后行为（task-26，已合入工作树）

**实现位置**：`MemoryCore/src/core/skill/conversation-add/dedupe.ts`（新增）、`add-handler.ts`、`buffer-storage.ts`、`wire.ts`、`conversation-add/index.ts`。

- **入口幂等**：`add-handler` 在读 buffer 之后、算 `raw_bytes` / 计 `tool_call_count` / 压缩之前，先对 `input.messages` 逐条判重。普通消息按 `(role, content)`，`tool_call`/`tool_result` 按 `(role, tool_call_id)`（content 可能带时间戳差异，id 才是配对锚点）。重复消息不入 `data-current`、不计 `byte_count`、不计 `tool_call_count`。
- **跨归档**：`meta.json` 新增 `recent_fingerprints: [{h,t}]`（sha256 前 32 hex + 接受时间）。归档只清 `data-current` 与计数，**保留指纹环**，因此「首次 POST 成功但响应丢失 → outbox 退避重试」落在归档之后仍会被拦住。环容量 200 条 / 窗口 10 分钟，对齐 L0 F-DUP-1（`DEFAULT_DEDUPE_WINDOW_MS` / `DEFAULT_DEDUPE_MAX_ENTRIES`，`wire` 可覆盖，0 = 关闭）。
- **阈值只计唯一消息**：`addedToolCalls = countRoles(acceptedMessages)`、`nextBytes = byte_count + totalMessagesBytes(acceptedMessages)`。E2 的「3 个唯一 tool_call 投 4 次命中阈值 10」不再成立，计数停在 3。
- **重复请求可区分**：全重复时返回 `{status:"ok", duplicate_skipped:N}`，buffer/meta 一个字节都不动（不写 `last_appended_at_ms`）。没有新增 `status:"duplicate"` —— MemoryProxy 的 `skill/core-client.ts` 把 status 声明为 `"ok" | "archived"`，新增枚举会让类型与运行时不一致；`duplicate_skipped` 是向后兼容的增量字段。
- **可观测**：`obsLogger.info("skill.add_handler.dedupe", {skipped, accepted, incoming_msgs, current_msgs, ring_size, window_ms})`；`write_back` 事件新增 `duplicate_skipped` 字段；全重复路径额外 `write_back {archived:false, wrote:false}`。顺手修掉 `trigger_archive` / `write_back` 两处重复对象键 `instance_id`（后者原本覆盖前者，值相同，无行为变化）。
- **force-archive 也保留指纹环**（task-33）：所有「只改几个字段」的 meta 写入收敛到 `SkillBufferStorage.updateMeta(sess, patch)`（读改写，`buffer-storage.ts:230`），`gateway/skill-handlers.ts:1093-1107` 的 force-archive 只 patch `tool_call_count/byte_count/last_appended_at_ms/last_archived_at_ms`，`recent_fingerprints` 与未知字段原样保留。手拼完整对象是丢字段的根因，不再允许。回归：`src/core/skill/__tests__/force-archive-meta.test.ts`（3 例）。
- **回归测试**：`MemoryCore/src/core/skill/conversation-add/add-handler.dedupe.test.ts`（6 例）——同 payload 连投两次 byte_count 不变；3 个唯一 tool_call 投 4 次计数=3 不归档；归档后重放被拦；tool pair 按 tool_call_id 判重（同 id 不同 content 仍重复、不同 id 同 content 接受）；批内重复；窗口过期后可重新入 buffer。

**仍然存在/未覆盖**：

- 只验到 buffer/meta 层（LLM 配额耗尽，未跑 extract，未验证「不再把重复内容送进 L2」的端到端读数）。
- 跨写者双喂若内容不逐字相同（proxy 的 user 文本带 `<acp …>` 上下文），本修复无效，仍需 §5 的 A（运维排他）或 C（共享幂等键）。

