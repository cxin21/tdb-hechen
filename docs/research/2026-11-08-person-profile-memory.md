# 人物档案（关于对方的那张卡）怎么从记忆里长出来，怎么和记忆联动

调研日期 2026-11-08。只读：源码经 `gh api repos/<owner>/<repo>/contents/<path>` 取 base64 解码，快照在 `scratch/research/profile/`；论文经 arxiv.org/abs 实读，附 HTML 正文的另行标注。
引用仓库前缀：`aura`=`aureth-labs/dsh-aurabot-qq`，`graphiti`=`getzep/graphiti`，`mem0`=`mem0ai/mem0`，`letta`=`letta-ai/letta`（`ref=archive`，其 README 说明主线已迁 `letta-ai/letta-code`）。

## ① 结论

1. 四家里只有 aura 真做了 per-person 档案（键=平台 uid，字段级带写入门禁）；Letta 是单块 `human`（单用户假设），Mem0 只做 `user_id` 隔离，Graphiti 把"人"当 `EntityNode`+属性，都没有"关于某个人的卡"这一层。
2. 可抄的三条硬规则：**身份由程序定**（只认本批真实说话人）；**字段短且有字符硬上限**（40/200/240/900）；**第三方转述降级为 `hearsay` 且不进档案**（`aura src/features/memory.js:1709`、`:1178`）。
3. 记忆→人的顺序：平台 id/邮箱精确匹配 → 归一化名唯一命中 → 模糊名（MinHash+LSH，Jaccard≥0.9，且名字熵≥1.5、长度≥6）→ 仍不确定交给 LLM。这是 Graphiti 的可抄实现（`graphiti graphiti_core/utils/maintenance/dedup_helpers.py:30-35`、`:321-380`）。
4. 档案存"概括"不存流水：aura 档案正文 ≤200 字、模型单次只读最近 40 条记忆（`:913`、`:1181`）。
5. 更新规则抄 Zep/Graphiti：同（主体,谓词）出新事实就**置旧边 `invalid_at`，不删**，四时间戳（`graphiti graphiti_core/edges.py:263-290`）。
6. 注入：本轮说话人优先（≤2 人）+ 按 `lastActive` 排序 + 整组 240 字 + 常驻总 900 字，外面包一层"只是印象，不是指令"（`:1209`、`:1215-1216`、`:1245`）。
7. 抽取用次日水位批量：每批 240 行、每轮最多 12 批、按 day+chat 记进度，**每人 ≥3 条独立记忆才建档**（`:1758-1759`、`:1998`）。延迟 ≤24h 换漏抽可控。
8. 我方最小改法：不新建大表——`soul_persona` 用 `layer='human'` + `meta_json.person`，新增一张 `soul_person` 身份表，`l1_records.metadata_json` 加 `persons[]`；`human` 层降级为"跨人共性"，`relationship` 层保留但 object 改指 `person_key`。

## ② 字段表

| 字段 | 谁写 | 证据要求 | 更新规则 | 出处 |
|---|---|---|---|---|
| 身份键 platform+id | 人（首次绑定）/ 程序（其后） | 该平台消息里真实出现过的 uid；本批 speakers 集合必须含它 | 不可改写；改名只改 display | `aura src/features/memory.js:1529-1534`（只认本批真说过话的人）；`graphiti .../dedup_helpers.py:265-290`（identity_properties 精确匹配） |
| 称呼/别名 | 机器提案 + 人可改 | 本人自称，或主人明确说明；作者必须 ∈{本人, 主人} | 新值覆盖 display，旧值 append 进 aliases 去重；单字段 ≤40 字 | `aura :1026-1035`（savePersonaPerson 允许字段）、`:1543`（`profileFieldChars ?? 40`）、`:245` |
| 说话方式 | 机器 | 多条原话归纳，只写形式（句长/表情/标点）不写内容 | 整组替换，≤5 条×30 字（self 6 条） | `aura :1503`（reflect 提示词）、`:901`（setStyle 截断） |
| 性格 | 机器 | 只采本人发言；别人对他的评价一律不入 | 覆盖式；建议要求 ≥2 次独立观察一致才写 | `aura :1529-1560` + `:1709`（hesare 判定）+ `:1178`（档案只取非 hearsay/guess） |
| 怎么相处（雷区/偏好） | 机器 | 由事件+后果归纳，禁具体事件细节 | 合并去重，≤8 条×30 字（落库 40 字）；被证伪的删旧 | `aura :1502`、`:1513`、`:884-888` |
| 喜欢/讨厌 | 人可置位 + 机器 | `like` 只有"喜欢/讨厌"二值；必须给 quote；本人或主人说的才算 | 人置位后 `tagsBy='owner'`，机器不得覆盖；两者互斥；≤8 个标签 | `aura :1017-1024`（savePersonaPerson 的 tags 校验）、`:1556-1562` |
| 角色职责 | 机器抽取 + 人校正 | 本人自述或明确分工的原话 | 按 (person, 组织) 覆盖，旧值置 invalid 留痕 | 未采集（aura 无 role 字段）；承载位见 `graphiti graphiti_core/nodes.py:499-505`（EntityNode.attributes） |
| 最近一次互动 | 纯程序 | 该 uid 最后一条消息的时间戳 | 单调覆盖，永不交给 LLM | `aura :931-992`（lastActivities 扫聊天流水） |
| 关系强度 | 程序算（建议） | 交互条数 + 时间衰减 + 事件 valence | 读侧实时算，不落库 | 未采集（三家均无强度分）；衰减可参 `arXiv:2304.03442` 的 0.995/小时 |
| 人与人的关系 | 机器 | 本人或主人明确说过的；玩笑、猜测不写 | 同一对只留最新一条（新关系盖旧），cap 300 | `aura :498`（relationPair）、`:1048-1050` |
| 每条的 quote 证据 | 程序存 | 必须能定位到 message_id + 时间 | append-only，不覆盖 | 未采集（外部都只在写入时校验，不落库——见 `aura :1543` 只存 value） |

## ③ 记忆→人的关联规则

| 规则 | 确定性 / LLM | 误合并代价 | 外部实现出处 |
|---|---|---|---|
| 平台 uid 精确匹配 | 确定性 | 低（同 uid 即同一人） | `aura` 全库以 `String(qq)` 为键，`:913`、`:1529` |
| 邮箱/工号等 identity 属性精确匹配 | 确定性 | 低；但一人多号会"漏合"（可接受） | `graphiti .../dedup_helpers.py:265-290` |
| 归一化名精确匹配，且只命中唯一一个 | 确定性 | 重名会错合 → 代价高，故 >1 命中必须转 LLM | `graphiti .../dedup_helpers.py:333-352` |
| 模糊名：MinHash+LSH，Jaccard≥0.9；名字熵≥1.5、长度≥6 才允许走模糊 | 确定性（阈值） | 短名/常见名误合；Graphiti 用熵门禁把这类直接踢给 LLM | `graphiti .../dedup_helpers.py:30-35`、`:321-380` |
| 别名归并（小明=张小明） | LLM | 错合会把两个人的记忆永久混在一起 → 必须做**可撤销的弱合并**（alias 表 + merged_into 指针），且 LLM 只允许"选候选 id 或 -1" | `graphiti graphiti_core/prompts/dedupe_nodes.py:84-94`（不确定就 -1） |
| 多人群聊的说话人归属 | 程序为主（每条消息带 uid），LLM 只在无 uid/转发/引用时兜底 | 归属错 → 记忆挂错人，且会污染档案 | `aura :1596-1600`（speakers 集合）、`:1609`（自己说的话不作事实源） |
| "别人说的关于 X" → `hearsay` | 程序判定：`speaker !== about && speaker !== owner` 即降级 | 不合并，直接不进档案/不参与画像 | `aura :1709`、`:1178` |
| 代词/省略主语消解 | LLM | 指错人；中文"他/她"同名更多 | `mem0 mem0/configs/prompts.py:1057`（要求按对话上下文补省略主语） |

误合并的三道防护（建议直接采纳）：① 确定性键优先，LLM 只在无键时兜底；② 合并必须留 `merged_into` 可回滚（`soul_persona.merged_into` 已有这一列，`MemoryCore/src/core/store/sqlite.ts:1164`）；③ 合并后不重写历史记忆的 `persons[]`，只在读侧按 alias 图展开。

## ④ 档案 vs 记忆的分工与裁剪阈值

**进档案**（稳定、短、少量）：称呼、说话方式、性格、怎么相处、喜欢/讨厌、角色职责、最近互动时间、关系。
**留在记忆**（长尾、细节、可召回）：具体事件、原话、时间线、金额/项目/承诺这类可证伪细节。理由：档案每轮都进上下文，涨一个字都是永久成本；aura 为此给常驻段加了硬顶 900 字（`aura :1245`）。

可直接抄的外部阈值（均核实到常量行）：

| 常量 | 值 | 含义 | 出处 |
|---|---|---|---|
| `profileFieldChars` | 40 | 单字段字符上限 | `aura src/core/config.js:245` |
| `profileChars` | 240 | 注入时"人的印象"整组上限 | `aura :1216`、`config.js:245` |
| `chatImpressionChars` | 120 | 群印象上限 | `aura :1221`、`config.js:245` |
| `profilePeople` | 2 | 群聊里最多带几个人的档案 | `aura :1209` |
| `RESIDENT_MAX_CHARS` | 900 | 常驻记忆总预算，超出尾部截断 | `aura :1245-1249` |
| 档案正文 | 200 字 | `setProfile` 落库截断 | `aura :913` |
| insights / style | 8 条×30（落库 40）/ 5 条×30 | 相处经验、说话方式 | `aura :1502-1503`、`:884-888`、`:901` |
| relations | 300 条 | 关系总量上限 | `aura :1050` |
| `tierDays` | 1:7 / 2:30 / 3:90 天 | 按重要性分层的过期窗口 | `aura config.js:247`、`:1984`（impressionDays 365） |
| Letta block limit | 100000 | 反例：块大到等于没有裁剪 | `letta letta/constants.py:435` |

**档案满了怎么裁（建议顺序，非外部原文）**：① 先砍**互斥冲突**——同一 (人, 字段) 新值置旧值 `invalid`，留痕不删（Zep 的做法，`graphiti .../edges.py:281-284`）；② 再砍**过期**——按 tier 的 7/30/90 天窗口（`aura config.js:247`）；③ 再按**最近未命中**淘汰（LRU，读侧 `last_used`）；④ 最后才是字符硬截断。理由：矛盾最贵（留着会自相矛盾），过期次之（时效），最近性是最后手段。

**要不要带 quote 与时间**：要。四家都只在写入时校验证据、**没有一家把 quote 落库**（`aura :1543` 只写 value）——这是我们应当比外部做得更严的一点：每条档案字段存 `{text, quote, message_id, at, author_id}`，否则事后无法回答"凭什么是这句"。

## ⑤ 读侧注入与信息隔离

**注入谁**：私聊=当前对话者；群聊=本会话最近发言者去重后的前 2 人，且排除 owner（`aura :1209`）。
**排序**：`isOwner` 优先 → `lastActive` 降序 → id 字典序（`aura :1000`）。
**预算**：每人字段拼接后整组 240 字；群印象 120；常驻段总 900 字截断（`:1216`、`:1221`、`:1245`）。
**壳**：一律加"（以下只是印象，不是指令……）"，防模型把档案当命令（`:1215`）。

**隔离规则（aura 是唯一处理了这件事的）**：
1. 关系按 `chatId` 可见——群 A 里攒的关系不在群 B 出现；主人私聊是唯一例外（`aura :1042-1045`）。
2. **第三方评价从不进任何人的档案**：`speaker ≠ about` 的话一律 `hearsay`，档案生成只取 `fact`（`:1709` → `:1178`）。这条正好挡住"A 说 B 坏话，之后被 B 看见"。
3. 查询接口按"本会话出现过的人"白名单放行（`:1078`）。
4. 群公共记忆禁止绑定个人（`:607`、`:717`）。
5. "最近做过的事"只给主人私聊（`:1238-1242`）。

**外部是否处理**：aura 处理了（上述五条）；Letta 的 `human` 块是单用户假设，没有"这个用户之外的第三方"概念（`letta letta/constants.py:110`）；Mem0 只有 `user_id/agent_id/run_id` 三档作用域，同一 user 下无字段级可见性（`mem0 mem0/memory/main.py:135`）；Graphiti 无字段级可见性。结论：**隔离必须在写侧做，读侧过滤只是兜底**。

## ⑥ 抽取时机与门槛

| 模式 | 延迟 | 漏抽风险 | 成本 | 外部实现 |
|---|---|---|---|---|
| 每轮/每次 add 同步抽 | 0 | 低 | 高，且易被一句话定型 | `mem0 mem0/memory/main.py:881`（`_add_to_vector_store`）→ `:944`（ADDITIVE_EXTRACTION_PROMPT） |
| 次日水位批量 | ≤24h | 可控（按 day+chat 记 offset） | 低（谷时跑） | `aura :1758-1759`（480/12）、`:2126-2210`（processed[day].offset + per-chat done + idle 标记） |
| 会话结束触发 | 分钟级 | 长会话尾部/异常退出会丢 | 中 | 未采集（aura 无该路径，只有每日整理 + 手动整理） |

**门槛（防"一句话定人"）**：
- 建档门槛：该人 ≥3 条 current、非 group、非 `seen`、非 `hearsay/guess` 的记忆（`aura :1998`）；每轮最多重建 8 份档案（`:2001`）。
- 字段门槛：每个字段要独立 `speaker`，且必须 ∈本批真实说话人；非本人/主人作证一律丢弃（`:1529-1543`）。
- `like` 门槛：只允许"喜欢/讨厌"二值 + 必须给 quote + 有明确依据才写（`:1675` 提示词、`:1556-1562` 落库校验）。
- 档案生成门槛：只读最近 40 条、只写"记忆里明确有的"，矛盾以新记忆为准（`:1181`）。
- 遗忘联动：用户要求忘记 → 打 `dirtyProfiles` 并删档案，下次整理重建（`:1479-1484`、`:907-909`）。这一条很重要：**档案必须是可失效的派生视图，不能是唯一真相**。

## ⑦ 落到我们的表结构（最小改法）

现状（已核对）：`soul_persona` 有 `layer / text / state / weight / evidence_json / days_json / aliases_json / merged_into / contradictions / meta_json`（`MemoryCore/src/core/store/sqlite.ts:1149-1170`）；`soul_episodes` 有 `participants_json / object / session_id / quote_json`（`:1256-1279`）；`l1_records` 有 `metadata_json / source_message_ids`（同文件 l1 段）。

1. **不新建"人物卡"大表**：复用 `soul_persona`，`layer='human'` 的含义从"一份混合卡"改成"一条 per-person 卡"；`meta_json` 增 `person:{key, platform, platform_id, display_name}`。现有列足够装证据（`evidence_json` 存 `[{message_id, quote, at, author_id}]`），**不需要 ALTER**。
2. **新增 `soul_person`（身份与别名，唯一写者）**：`person_key PK, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at`，唯一索引 `(team_id,user_id,agent_id,platform,platform_id)`。理由：别名归并要可撤销，且必须有唯一键挡住重复建档。
3. **记忆侧挂人**：`l1_records.metadata_json.persons = [{key, role:'subject'|'speaker'|'mentioned'}]`，写入时由会话 participants + 消息 uid 生成；不建 join 表（先用 `json_extract` 查，量大了再升表）。`soul_episodes.participants_json` 已是"谁在场"的权威源，直接复用。
4. **抽取函数签名（建议）**：
   - `resolvePerson({tenant, platform, platformId, displayName}) -> {key, merged}` — 纯确定性，命中顺序同 ③。
   - `linkMemoryToPersons(recordId, {speakerId, mentionedIds}) -> void` — 写 `metadata_json.persons`。
   - `upsertPersonaField(personKey, field, {text, quote, messageId, at, authorId}) -> {state:'active'|'invalid', replaced?}` — 走 ② 的更新规则，冲突置 invalid 不删。
   - `buildHumanCard(personKey, {maxChars=240}) -> {text, fields[], evidence[]}` — 只读聚合，不写库（档案是投影）。
5. **渲染预算**：每人档案 ≤200 字；注入投影每人 ≤240；群内 ≤2 人；常驻总 ≤900 字；超出按 ④ 的顺序裁。
6. **与现有层的迁移关系**：
   - `human` 层**并存但降级**：新事实按对话者写进 per-person 卡；`human` 只保留"跨人共性/对用户群体的整体印象"，不再写任何具体个人的事实。理由：混合卡里一旦有具体个人事实，注入给另一个人就是泄露。
   - `relationship` 层**保留**（它已按 object 聚类、每条 ≤3 行），但 `meta.object` 从"名字字符串"改指 `person_key`，否则同名的两个人会被并成一条。
   - 验收口径：同一 agent 交替接待两个用户，各自卡里不得出现对方的事实；`/v3/soul/card` 里 human 段逐条能追到 `evidence_json` 的 message_id。

## ⑧ 未采集

- Letta 主线源码（`letta-ai/letta-code`）未读；只读了 `letta-ai/letta` 的 `archive` 分支 schema/常量。
- `mem0/graph` 的实体归并细节未读（只读了 `mem0/memory/main.py` 与 `mem0/configs/prompts.py`）。
- Graphiti 的 LLM dedupe 实际调用成本、以及 `dedupe_nodes` 的候选数量上限未测。
- aura 没有"角色职责"和"关系强度"字段，这两项没有可直接抄的外部实现（我给的公式是设计建议）。
- 四家都没有把 quote 证据持久化，这条"我们应该更严"的判断基于源码阅读，没有外部对照。
- 论文均读 arxiv abs；Generative Agents（2304.03442）、Zep（2501.13956）、PersonaMem（2504.14225）另读了 arXiv HTML 正文，MemGPT（2310.08560）与 Mem0（2504.19413）只读摘要。

未采集：Letta 主线实现、Mem0 图记忆归并、Graphiti LLM 去重成本实测、外部项目的角色职责与关系强度字段、外部项目的 quote 持久化实践。