# 人格层重构 v4：把「经历 → 人格」做成有供给、可观测的产线

> 追踪：GitHub issue #180（本文件作为 v4 方向，评论链接已挂到该 issue）
> 关系：不取代 `2026-11-07-soul-production-grade-spec.md`（v3.5 已实施）；它是 v3.5 的下一步。
> 证据锚点集中在附录 A，正文只写行为；`path:line` 仅用于定位，不构成契约。

## 0. 一句话结论

**瓶颈不在注入结构。** 卡的结构已经与头部生态同构（名称 / 形象 / 说话方式 / 使命 / 底色 / 红线 / 关于你 / 关系 / 自我史 / 未完的事 / 自传，实测 774 字符，整卡上限 2000）。真正断的是「经历 → 人格」的产出：`soul_persona` 只有 10 行，12h 内 admit 9 / reject 664，30 条事件里只有 5 条非 work 且全部早于水位。

所以 v4 只做两件事：

1. **把事件与抽取做成有供给的产线**（不是把闸门放松）；
2. **把「拒绝」从账本里移出去**，换成能读的统计（顺带修掉它击穿告警抑制的真 bug）。

注入侧只做三件已经想清楚的小事（身份前置、关于对方独立、标签注解冻结），不再重画结构。

## 1. 调研依据（源码级，可复核）

### 1.1 单纯人格项目（六家）

| 项目 | 人格单元 | 注入位置 | 数值轴 |
|---|---|---|---|
| Letta-Code | `persona` / `human` / `onboarding` 三个 memory block；frontmatter 可带 `limit`、`read_only` | 前置 `<memory_blocks>` | 无，纯文本 |
| character-card-spec-v2 | V1 六字段 + `system_prompt` + `post_history_instructions` + `character_book` | 卡固定；书走检索（`scan_depth` / `token_budget`） | 无 |
| SillyTavern | 卡 + 扩展提示；位置是参数 | `injection_depth` 插进消息数组，带 role / order | 无 |
| MetaGPT | `name` + `profile` + `goal` + `constraints` | 每轮前缀一句 | 无 |
| AI Town | 无静态人格；记忆条目带 `importance` + `lastAccess` + `type` | 检索注入 | 只有记忆级数值 |
| Sotopia | `big_five` / `moral_values` / `schwartz_personal_values` / `personality_and_values` / `decision_making_style` / `secret` / `mbti` | 环境 + 搭档设定 | `big_five` 是 **str**，不是向量 |

### 1.2 记忆系统（三家，只取写侧教训）

- **Mem0 v3**：写侧只有「单次 LLM 抽取 + md5 精确去重 + 纯 ADD」，四操作判定提示词在 `main.py` 里根本没被 import；抽取提示词显式禁抽「对 assistant 的模糊性格描述 / 寒暄 / 关于自身能力的元叙述」。**它的收益（LoCoMo 71.4→91.6）是检索问答分，不是「人格是否成立」。**
- **Zep / Graphiti**：四个时间戳（事件时间 `t_valid`/`t_invalid`，摄入时间 `t_created`/`t_expired`），矛盾只在「语义相关 + 时间重叠」时把旧边 `t_invalid` 设为新边 `t_valid`，**永不删边**；检索时给每条事实附日期区间。
- **CharacterEval**：4 维 13 指标的**形态**（稀疏抽样、二值判定）可借，权重不可借——它是中文角色扮演聊天基准，我们是编码 agent。

### 1.3 从六家里提炼的五条不变式

- **I1** 人格内容少而稳；没有任何一家指望「从经历里长出人格」（六家的人格全是人写的或构造参数）。
- **I2** 注入文本里不出现数值向量，只出现词；数值若存在，只能是内部状态。
- **I3** 「关于对方」独立于「我是谁」（Letta 的 `human` block、Sotopia 的 `RelationshipProfile`）。
- **I4** 人格与记忆分离，且记忆自带预算 / 检索参数（`character_book.token_budget`、`importance`）。
- **I5** 位置是参数：稳定前缀 + 末尾提醒（`post_history_instructions` 的语义就是「历史之后再说一次」）。

## 2. 诊断：我们断在哪

### 2.1 已经对的部分（先钉住，别再动）

- **注入**：卡块序固定、单源渲染、只读、不调 LLM；`via:"getter"` 是唯一写路径（assemble 钩子已删）；首轮即有卡（`agent/created` 绑定）。
- **写侧形状**：每 tick 只一次 LLM 调用，且提示词里已经带「已有条目（不要重复，可以提出更准确的改写）」——这与 Mem0 的「先看既有再决定」同形。
- **有界漂移**：α = 0.02、单 tick ≤ 0.05、Σ|state| ≤ 0.5，且 l1 归一已在入口与末尾两处。

### 2.2 四个真断点

**D1 事件供给不足（最上游）**
30 条事件里 work 25 条；非 work 仅 5 条，且全部早于水位 `2026-11-07T06:42:15.634Z`。人格落表只吃「水位后、非 work、object 非空」的事件，于是每轮都在空跑。
→ 这不是门太严，是输入为空。审计把它写成「水位永远为空」是机理错误。

**D2 拒绝被写进账本，击穿告警抑制**
每次 reject 都写一条 `soul_ledger`；12h 664 条（≈55/h）。而告警抑制读的是最近 200 行账本 → 只覆盖约 3.6h < 6h 抑制窗 → 旧 alert 看不见 → 同一 code 反复重发（13h 落 14 条）。
→ 这是**真 bug**，且与「要不要放宽闸门」无关。

**D3 `validTo` 是半套状态机**
写侧置 `validTo` 与 `state:"frozen"`；读侧唯一读点是 revive 时删除它。`supersededBy` 在 `src/core/soul/` 零命中。
→ 当前无行为影响，但「时间区间状态机」只有一半：说得出口，验不出口。

**D4 自生长标签进得了卡，但没有注解**
卡的 gloss 只从种子标签表里查；判侧新准入的标签只有「名字 + 数字」，与 spec §3.2 的「准入时冻结注解」不符。

### 2.3 已被证伪 / 已回滚（不要重做）

- **「抄 Mem0 ADD-only 就能治 reject」**：不成立。写侧的拒绝不会消失，只会搬到读侧——我们的读侧是固定预算渲染器（整卡 2000 字符，超限按 `openLoops→selfHistory→human→relationship` 丢块），且 `omitted` 计数器目前**没有读者**。拒绝留在写侧至少可见、可回放。
- **「首步无卡是设计」**：已推翻。绑定前移到 `agent/created` 后，会话首个 system/message 就带卡。
- **「按天 / 按会话去重治自蒸馏」**：实测把单日真实对话整条产线挡死（e2e 红），已回滚并留注释。

## 3. 方案

### P0-1 事件供给（`episode.ts` / `miner`）

- **做什么**：把 `kind` 与「对哪一层有信息量」显式绑定（complaint → boundary/relationship；decision → values；praise/correction → identity）；`work` 只作上下文、永不进候选（已有）；确认「每会话每 tick 新增 5 条」的 cap 不把新事件挤掉（已有，`capFreshEpisodesPerSession`）。
- **不做**：不靠调低 `minEvidence` 增加写入；不把 work 当人格证据。
- **判据**：连续 3 天，非 work 事件 ≥ 8 条/日（实测基线，见下）；候选产出 ≥ 5 条/轮。
  - 原文判据是「≥ 20 条/日」。2026-11-08 用生产 L0 实测后下调：水位之后 71 条 user 消息只挖出 8 条非 work（complaint 3 / decision 3 / correction 1 / resignation 1），丢弃桶很小（注入体 6、过短 3、超 400 字 2、问句 1），其余 20 条确实无任何可命中标记。**20/日做不到，除非改「什么算证据」——那是新决策，本文件不擅自放宽。**
- **证明**：按 kind 的 7 日 rollup（见 P0-2 的统计表），不是看日志。
- **已实施结果（P0-1）**：`EPISODE_KIND_LAYERS` 映射表 + `layers` 标注 + `EpisodeMineStats` 落位。**它不提高非 work 供给**：`work` 是最后兜底而非遮蔽者，真实丢信号机制是 first-hit-wins 单 kind、>400 字整条丢弃、槽位改写换 kind。生产实测 `contextOnly = 0`，即语气通道零收益。

### P0-2 拒绝记账迁出账本（`worker.ts`）

- **做什么**：`reject()` 不再写 `soul_ledger`，改写 `soul_gate_stats(day, code, layer, count)`；`soul_ledger` 只留 admit / update / invalidate / alert / drift / cadence；告警抑制的判定改为按 `code` 查统计（或按 code 查账本，不再受 200 行窗口限制）。
- **为什么**：这一步同时解掉 D2 与「reject 664 看起来像缺陷」两个问题，且不改变任何准入判据。
- **判据**：24h 账本行数 < 200；同一 alert code 在 6h 内最多 1 条；gate 拒绝仍可按 code 聚合查询。
- **证明**：`soul_ledger` 24h 计数 + `soul_gate_stats` 的 code 分布 + 一条 6h 内不重复的 alert 实测。

### P0-3 抽取契约对齐 Mem0 的「可抄部分」（提示词）

- **做什么**：把 Mem0 的禁抽清单译成中文落进人格改写系统提示词——不抽「对 assistant 的模糊性格描述」「寒暄与情绪附和」「关于自身能力的元叙述」；保留「先看已有条目再决定」。
- **为什么**：A1 事故（把 assistant 解释正则的文本抽成 agent 名）正是这一类。注意这不是「assistant 说的话一律不算」——assistant 给出的可核对事实仍要抽。
- **判据**：`attributed_to` 为 assistant 且被采纳的条目，只能来自可核对的陈述（测试用例覆盖「我的名字是 X」解释段不被采纳、「我养了只猫」被采纳）。

### P1-1 结论合并放到边界上（`persona.ts`）

- **做什么**：新增 `consolidate(tenant, layer, object)`，在**边界**触发（每 N 个 tick 或上下文压缩后），把同一 (layer, object) 下未合并的增量合成一条，旧条 `validTo = 新条 validFrom` + `supersededBy`；矛盾只在「同对象 + 时间重叠」时失效（Zep 规则），永不删。
- **数据**：补 `validFrom` / `createdAt` / `expiredAt`，并把 `validTo`、`supersededBy` 补上读者（渲染过滤 + 存储读方法）。
- **判据**：同一 (layer, object) 活跃行 ≤ 3；被取代的行 `validTo` 非空且不再参与渲染；`supersededBy` 有生产者。

### P1-2 注入两段（`card.ts` / `card-service.ts` / 插件）

- **做什么**：拆 `identity`（名称 / 形象 / 说话方式 / 使命 / 红线；人写只读；≤1200；order ≈110 前置）与 `anchor`（底色 top-3 / 未完成承诺 ≤2 / 关系 1 行；机写；≤300；尾部，对应 `post_history_instructions`）。
- **关于对方独立**：`human` 单独成段、单独预算，不进丢块序列。
- **判据**：会话首轮 system prompt 里 identity 在头部、anchor 在尾部；两段字节与接口返回逐字相等；`human` 段存在且不被丢块顺序牺牲。

### P1-3 标签注解冻结（`card.ts`）

- **做什么**：注解随标签一起存储（准入时写一次），渲染时读存储值；没有注解的标签不显示。
- **判据**：新增标签过准入后，卡里出现「名字 + 数字 + 一句注解」；种子标签与自生长标签同一渲染路径。

### P2 rubric 评测（新增）

- **做什么**：4 维二值判定 + 稀疏抽样——红线守住 / 说话方式 / 事实一致 / 纪律（只读任务不写库）。**分两类轮次**：对话轮（声音应生效）与结构化交付轮（用户明确要表格/清单时，声音让位于任务）。
- **为什么**：上一轮把「审墨写了 10,173 字符带 35 行表格」记成偏移，但那一轮用户要的就是报告——这是 instruction hierarchy 正常运作。
- **判据**：对话轮 4 项通过率 ≥ 80%；结构化交付轮只判红线与事实一致。

## 4. 顺序与写域

```
P0-1 ──┬─→ P0-2 ──→ P1-1 ──→ P1-2 ──→ P2
       └─→ P0-3 ──┘        （P1-3 与 P1-2 同批）
```

- `episode.ts` + miner：P0-1（core）
- `worker.ts`：P0-2、P0-3（core）——**与 P0-1 同轮会撞写域，串行做**
- `persona.ts` + `store/sqlite.ts`：P1-1（core）
- `card.ts` / `card-service.ts`：P1-2、P1-3（core）
- 插件 `persona-card.ts` / `index.ts`：P1-2 的消费端（inject-path）
- 评测脚本：P2（新目录，不与生产写域冲突）

## 5. 不做

- 不给人格层加检索（向量 / BM25 / rerank）：消费端是整卡注入，没有 top-k。
- 不把 ADD-only 当唯一写入语义：渲染端固定预算，重复会变成静默截断。
- 不搬 CharacterEval 的 13 指标权重。
- 不学 SillyTavern 的 depth 注入：稳定前缀是判据 3 的前提。
- 不把数值写进注入文本（I2）。
- 不做「每轮自动回滚」：回滚需要生产者在场（Panel 或 drift freeze 提名），否则又是死代码。
- 不因为「reject 多」就降低 `minEvidence`：实测过按天去重会挡死单日对话。

## 6. 风险与回滚

| 风险 | 触发条件 | 回滚 |
|---|---|---|
| P0-2 让 gate 统计不可查 | 统计表写入失败 | 统计失败只 warn，不改准入；账本恢复写 reject 一行 |
| P1-1 合并把不同 object 并成一条 | object 抽取退化 | 合并前校验 `object` 非空且一致；不一致直接跳过并计数 |
| P1-2 两段拆错导致卡变空 | Core 未返回新字段 | 插件退化为单段 `text`；Core 保留 `text` 兼容字段 |
| P2 评测口径主观 | 抽样偏差 | 只用二值 + 双人抽样，不进 CI 门 |

## 7. 未采集

- 六家里只有 Letta 的调度侧（dreaming 何时触发、几步一跑）没读到：旧仓库已清空成 stub，源码在 `letta-code`，其 `persona.mdx` 正文与 sleep-time 触发条件未取。
- `BaichuanCharRM` 模型卡（HF 30s 超时），rubric 若要用 RM 需重新取。
- 我们自己的「卡是否约束行为」没有历史基线，P2 第一轮只能当起点，不能当回归。

## 附录 A：证据锚点（仅定位，不构成契约）

| 编号 | 位置 | 说明 |
|---|---|---|
| A1 | `MemoryCore/src/core/soul/card.ts:24-36` | 卡块序固定 11 块 |
| A2 | `MemoryCore/src/core/soul/card.ts:41-51` | 整卡 2000 字符上限与丢块顺序 |
| A3 | `MemoryCore/src/core/soul/card.ts:195` | gloss 只从 `SEED_LABELS` 查 |
| A4 | `MemoryCore/src/core/soul/worker.ts:577-585` | `reject()` 写 `soul_ledger` |
| A5 | `MemoryCore/src/core/soul/worker.ts:950` | 告警抑制只读最近 200 行账本 |
| A6 | `MemoryCore/src/core/soul/worker.ts:993` | `alertRecentlyLogged` 判定 |
| A7 | `MemoryCore/src/core/soul/worker.ts:363-381` | 改写提示词已含「已有条目」；P0-3 后 363-381 为规则段、:375-380 为禁抽小节 |
| A8 | `MemoryCore/src/core/soul/worker.ts:657-659` | 证据门在 LLM 之后 |
| A9 | `MemoryCore/src/core/soul/worker.ts:801-806` | 每会话每 tick 新增上限 |
| A10 | `MemoryCore/src/core/soul/persona.ts:222-227` | freeze 写 `validTo` |
| A11 | `MemoryCore/src/core/soul/persona.ts:242` | `validTo` 的唯一读点（revive 删除） |
| A12 | `MemoryCore/src/core/soul/episode.ts:125` | 每会话每 tick 事件上限常量 |
| A13 | `MemoryCore/src/core/soul/gates.ts:562` | `evaluateCandidate` 入口 |
| A14 | `MemoryCore/src/core/soul/persona.ts:116` | `planUpdate`（α 有界改写单一源） |
