# writeback 注入闸门与缓冲边界修复（task-79）

日期：2026-11-01 · 票：task-79 · 相关：task-72（技能面）、task-82（并行编辑）

## 1. 背景（票面三条判据，均来自探针矩阵）

| 失败模式 | 证据 session | 判据 |
| --- | --- | --- |
| 注入块原文落进 L0 成普通用户消息 | `probe-matrix-m2-inj` | 插件自己产出的消息不得回写 |
| 用户把注入块原文贴回来问「为什么长这样」被丢 | `probe-matrix-m2-quote` | 标记开头的**真实用户消息**必须落库 |
| `turn/end` 无 turn 时缓冲被删、文本永久丢失 | `probe-matrix-m2-lost` | 删周边界＝提交边界，未提交不删 |

## 2. 改动（`dsh-plugin/src/writeback.ts`）

### 2.1 P1-a 身份闸门，文本只作兜底

旧实现 `isInjected(message, text)` 只用 `source.kind` 前缀 + 文本宽匹配，两个方向都错：

- **漏**：宿主把 source 改写成 `user` 后，同一块注入被当成用户发言写进 L0（`probe-matrix-m2-inj` 的失败模式）；
- **误杀**：用户原样贴回带标记的文本（问「这段为什么长这样」），被当成注入丢掉整轮（`probe-matrix-m2-quote`）。

新实现把「身份」和「文本」分开，且**身份是 OR、文本只兜底**：

| 位置 | 内容 |
| --- | --- |
| `dsh-plugin/src/writeback.ts:218` | `const AGEMEM_MESSAGE_ID_PREFIX = 'agemem-';` |
| `dsh-plugin/src/writeback.ts:221` | `function sourceKindOf(message: HostMessage): string \| undefined` — 非空字符串才算「有来源」 |
| `dsh-plugin/src/writeback.ts:230` | `function isOurInjection(message, sourceKind): boolean` — `sourceKind === INJECTED_KIND \|\| sourceKind.startsWith('plugin:') \|\| id.startsWith('agemem-')`（**OR**） |
| `dsh-plugin/src/writeback.ts:240` | `function looksLikeInjectedBlock(text): boolean` — 只看**第一个非空行**是否以标记开头 |
| `dsh-plugin/src/writeback.ts:544` | user/message 分支：先 `isOurInjection` 丢弃；再 `sourceKind !== undefined && sourceKind !== 'user'` 丢弃（skill feed / runtime-context）；**仅当 source 缺失**才 `looksLikeInjectedBlock` 兜底 |

判据为何这样落：

- **必须是 OR，不能是 Lead 口径的交集**：「source 被改写成 `user` 但 id 仍是我们给的 `agemem-volatile-<n>`」恰是 `probe-matrix-m2-inj` 的实况。交集（两者同时成立才丢）会让这条注入漏进 L0——恰好把要修的 bug 留下。任一身份信号成立即判注入。
- **source 缺失不再当「非用户」**：宿主有些路径不带 `source`，旧逻辑因此整轮丢失。现在缺失时先按用户处理，只有文本首行命中标记才丢（P1-a 的兜底）。
- **文本只看首行**：旧逻辑 `head.includes(marker)` 会把「用户在自己那句里引用了标记」也判成注入。

### 2.2 P1-b 缓冲边界：未提交不删

- `dsh-plugin/src/writeback.ts:391-405`：`warnedPendingOverflow` 一次性告警闸门；`pendingUsers.set(id, bucket.slice(-maxPending))` 溢出保留最新 `maxPending` 条，载荷 `{ sessionId, dropped, limit }` 不含正文。
- `dsh-plugin/src/writeback.ts:604-630`：`turn/end` 分支 `const turn = data?.turn ?? currentTurn.get(id);`；`turn` 缺失时只打 `agemem: writeback.droppedPending`（`dsh-plugin/src/writeback.ts:624`，仅 pending>0）并 **return，不删缓冲**。只有拿到 turn 才 `flushPending → finalize → pendingUsers.delete → currentTurn.delete`。

旧实现在 `turn/end` 无 turn 时 `finalize` 早退却仍删缓冲 ⇒ 文本既没写进 L0 也没留档，是静默数据丢失。

## 3. 测试（`dsh-plugin/test/writeback.test.ts`，25 → 30，全绿）

| 用例 | 断言 |
| --- | --- |
| `drops an injection block whose source kind was rewritten but keeps our id` | id `agemem-volatile-2/3` + source `user` ⇒ 仍丢；落库只剩真问题与回答 |
| `keeps a real user message that STARTS with our header (P1-a)` | source `user`、文本以标记开头 ⇒ messages = `[quoted, '那是我们的注入块']` |
| `writes a user message that carries no source at all (P1-a)` | 无 source、无 id 前缀 ⇒ 落库 |
| `still drops a header-led block when no source AND no id identifies it` | 无 source 无 id、首行 `【agemem 记忆提示】- [work_fact] 旧注入` ⇒ 丢 |
| `records several distinct user messages inside one turn` | turn 11 两条不同 id 用户消息 + 重复 id 去重 ⇒ `['第一句','中途补一句','答']` |
| `keeps the buffered user text when turn/end carries no turn (P1-b)` | 无 turn 的 `turn/end` ⇒ 不投递、日志含 `writeback.droppedPending`；下一轮 `turn-stopping` 一次投递 `['turn 未知时到达的问题','下一轮的回答']` |

## 4. P2 steering：不接入（取证）

票面要求先判断「同一 turn 的第二条用户输入」在宿主里是 `steering/message` 还是 `user/message`。结论：**运行期只有 `user/message`，`steering/message` 是历史格式**。

| 证据 | 位置 | 内容 |
| --- | --- | --- |
| 当前 build 的会话事件白名单 | `scratch/dsh-plugin-probe/host/dsh-session/lib/types/known-event-types.js:80` | `'user/message',` 在集合内；全文件 88 行，`grep -c steering` = **0** |
| 宿主文档原文 | `D:\DSH\resources\app.asar` 偏移 ≈91677709 | “The bounded historical normalizers convert `steering/message` to `user/message`” |
| 迁移函数 | `D:\DSH\resources\app.asar` 偏移 ≈91766236 `function normalizeLegacySteering(event, sessionId)` | `event.type === 'steering/message'` 时返回 `{...event, type: 'user/message', data: {...message, id: legacyMessageId(sessionId, event.seq), role: 'user'}}`，并断言旧键 `['turn','message']` / `['turn','content','source']` |

`app.asar` 里 `steering/message` 共 16 处，全部属于旧会话读取/规范化路径，没有运行期发射点。因此不监听该事件（监听即死代码）；同一 turn 多条用户输入已由用例 `records several distinct user messages inside one turn` 覆盖（按 message id 去重）。

## 5. 读数

- `npx tsc -p tsconfig.json --noEmit` → EXIT=0；`npm run build` → EXIT=0。
- `test/writeback.test.ts`：**30 passed**。
- 全量 `vitest run`：**3 files failed / 12 failed / 358 passed**，失败全部落在并行编辑中的 `test/config-schema.test.ts`（1）、`test/guidance.test.ts`（1）、`test/index.test.ts`（10：head-pack section 期望 2 个实得 3 个、persona/scenario、tools 注册等）。并行编辑者 01:27:51 新增 `src/asset-reflection.ts`、01:27:59 改 `src/index.ts`（本票只动 `src/writeback.ts`，mtime 01:25:30）。**全量绿需等并行票收口**，本票对 `test/writeback.test.ts` 的 30 条负责。

## 6. 诚实边界

- 未在真宿主上跑（桌面 profile 仍是旧 build；真机 smoke 归 task-51 的 e2e 渠道），本票为单测级验收。
- OR 口径与 Lead 口头口径（交集）不一致，理由见 §2.1；若 Lead 坚持交集，需同时给出「source 改写但 id 保留」这条实况的替代防漏手段，否则该失败模式复活。
- 溢出丢最旧（保留最新 `maxPending`）是策略选择，未与 Lead 单独确认；若应丢最新需改一行。