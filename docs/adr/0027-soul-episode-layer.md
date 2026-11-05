# ADR-0027 人格的事件层：从原始对话长出「有出处的判断」

- 状态：已实施（2026-11-05）
- 决策者：何晨（拍板 A：新增 `soul_episode` 层，生成源改为 L0 原始对话；只接受完整版）
- 相关：ADR-0026（六层 + 判据 + 账本）、`docs/soul-self-maintenance.md`、`MemoryCore/src/core/soul/episode.ts`

## 背景：六层建好了，人格还是空的

2026-11-05 生产实测（`soul_persona` 52 行）：boundary 28 / relationship 13 / method 9 / values 2，**identity / voice / narrative 全 0**；52 条的 `evidence_json` 里没有一条指向真实记录（全是 `slot:*`）。同时 `core_pending` 里 self_identity 385 条 rejected——**旧生成路产不出人格，不是判据太严，是原料不对**：

1. **原料是 L1 摘要**：L1 是「发生过什么」的压缩结果，天然丢掉了「他当时原话怎么说的」「我上一条怎么回的」「我为这件事放弃了什么」。从摘要里只能抽出方法论与禁令。
2. **没有出处概念**：「我是个先取证再下结论的人」无法回查是哪两次事教出来的，所以判据只能问「像不像人格」，不能问「凭什么知道」。
3. **拒绝不可观测**：worker 只打 `rejected=97` 一个总数，理由从不落账本。生产日志看不出「97 条分别死在哪个门」，判据无法迭代。
4. **情绪没有来路**：`soul_state` 只存 valence/arousal，注入只能写「比基线偏沉」，说不出「因为谁、多强、多久消退」。

## 决策

### 1. 新增事件层 `soul_episode`，生成源改为 L0 原始对话

- 输入：`l0_conversations` 的 `role/message_text/recorded_at`（生产 14,456 行），窗口 `episodeWindowDays=30`、上限 `maxEpisodeMessages=4000`。
- 挖掘（`episode.ts`，**零 LLM**）：按确定性标记组识别分歧/纠正/拍板/价值冲突/情绪五类事件，优先级 value_conflict > correction > divergence > decision > affect；记录双方**逐字**立场（`userStance` / `agentStance`）、对象、代价原文窗口、后续结果、`quote`（带 `recordId`）。
- `episodeId = ep-<hash(sessionId|recordId)>`：重跑幂等，同一条消息不会产生第二个事件。
- voice few-shot 只从这些事件的原话里取，**不总结说话风格**。
- L1 只作为旁证（`records`），不再作为人格原料。

### 2. 正向判据：先问「凭什么知道」，再问「像不像人格」

旧判据全是排除式（不是事件、不是方法论、不是项目专名…），只要文本干净就能进。新增五道**正向门**（存量导入 `legacy=true` 不追溯）：

| 门 | 要求 | 失败码 |
|---|---|---|
| 立场 | identity/values 必须有第一人称立场（`hasStance`：两难或「我认为/我的底线/我宁可…」） | `stance_missing` |
| 代价 | values 必须说出放弃了什么（放弃/牺牲/代价/错过/宁可少/慢一点…） | `cost_missing` |
| 出处 | identity/values ≥`minEpisodeEvidence=2` 个不同 `ep-*`；narrative ≥1 | `episode_missing` |
| 原话 | voice 必须附 1–2 条真实 L0 逐字引文（带 `recordId`，且能在语料里逐字找到） | `voice_quote_missing` |
| 来路 | narrative 必须含来路词（后来/当初/以前…）且不是方法论（或方法论但讲了代价） | `narrative_method` |

LLM 只负责**提候选**，不参与任何门的判定；`ep-*` 必须来自本轮已入库的事件池，编造的 id 在 merge 前被过滤。

### 3. 拒绝必须可观测

每条被拒候选都落 `soul_ledger`：`action=reject`、`entryId=rej-<layer>-<hash>-<day>`（同日同文本幂等）、`itemId=cand:<hash>`、`gates=<失败码>`、`reason=<首条失败说明>`。报告新增 `rejectTop`，tick 汇总与日志打 top5；新增 `soulRejectionStats(tenant,{sinceDays})` 按失败码聚合（含最近出现时间）。

### 4. 情绪与心境：事件是来路，心境仍只写偏移

- episode 自带 lexicon 情绪（`affectSource`），与 L1 信号一起进入 `integrateMood`。
- `soul_state` 增 `emotion_object/emotion_label/emotion_intensity/emotion_at` 四列；注入行在强度（衰减后）≥0.4 时写「近期心境：比基线偏沉，因为「假绿」反复出问题。」，否则只写偏移——**没有对象就不编原因**。
- 心境仍是 48h 半衰期的积分态，不因单个事件改写人格。

### 5. 回放校准必须把「内容」与「出处」分开量

历史 rejected 提案本身没有 episode。若直接跑新判据，每一条都会因 `episode_missing` 被拦，恒 100%——那是循环论证。因此 `replayStrictCalibration` 把失败码拆两类：content（事件句/阶段词/任务锚/换项目不成立/没立场/没代价/超长/重复）决定「内容该不该进」；provenance（episode/原话/逐字支撑）单列，不计入达标率。

2026-11-05 生产只读回放（588 条，其中 rejected 405）：**内容判非人格 400/405 = 98.8%（门槛 ≥95%）、内容与出处全过 0 条 = 0.0%（门槛 ≤5%）、仅缺出处 5 条**。逐条理由落在 `.scratch/soul-replay-v2-report.md`。旧回放（只用 classifyLine）为 catchRate 97.0% / falseAdmits 12。

### 6. 接线与配置

| 配置 | 缺省 | 作用 |
|---|---|---|
| `episodeWindowDays` | 30 | L0 挖掘窗口（自然日） |
| `maxEpisodeMessages` | 4000 | 每次取 L0 消息上限 |
| `maxEpisodesPerRun` | 120 | 单轮新入库事件上限 |
| `maxEpisodesForPrompt` | 60 | 喂给 LLM 的事件摘要上限 |
| `voiceFewShotPerItem` | 2 | voice 条目附带的原话条数 |
| `minEpisodeEvidence` | 2 | identity/values 需要的不同事件数 |

调度 `lifecycle-scheduler.ts` 每租户取 `recentL0Messages(tenant,{sinceDays,maxMessages})` 传入 worker，并在日志与 `SoulTickSummary` 里汇总 `episodes/rejected/rejectTop`；缺 L0 能力时事件层如实跳过（不伪造）。

### 7. 同日结构返工（2026-11-05 晚）：让「情绪/自我/关系/内在价值」真的进入判断

ADR 前六条解决的是「人格有没有出处」；用户验收时指出仍是「能生成人格文本的系统」，不是会因情绪、自我与关系改变判断的自我。于是同日追加五件事（全部确定性判据 + 账本，不靠 LLM 自评）：

1. **情绪进入判断（不是只写库）**：生成候选**之前**先算此刻心境，把「相对基线偏移 + 最近一次真实对象」转成一条本次情境的默认倾向（emotion.ts:moodBiasLine），同时注入 prompt 与落 soul_ledger action=arbitrate（gates=[mood_bias]、evidenceIds=[episodeId]）。偏沉 → 「先按最坏情况挡一下」；偏积极 → 「先信一次，再验证」。对象为空或未偏离阈值时**不产生倾向**（不伪造）。可回放「当时为什么先防着」。
2. **自我模型（第八层 self）**：SOUL_LAYERS 增加 self，注入段头「## 我对自己」。候选只能从 agentStance（我当时怎么回）提炼「我答应自己/我不愿变成/我怕自己…」，self_missing 拦纯描述，self_not_owned 拦「只引用户单方发言、我没有表过态」的候选。自我模型必须有我自己的行为出处，不是用户对我的评价。
3. **关系史而非用户档案**：episode 的 participants 用真实人名（personName）。relationship 候选必须①点名「何晨/他/你」（relationship_person_missing）②句内用「」逐字引他一句原话，过 hasVerbatimSupport（verbatim_missing）③引 ≥minEpisodeEvidence 个有他原话的事件（relationship_history_missing，worker.ts 结构门）。泛泛的「长期协作关系」「协作合同」进不来：关系必须有具体来路与他说过的话。
4. **非效率的内在价值**：values 除立场+代价外，还必须指向一个「没有产出也要守」的东西（intrinsic_missing：体面/尊严/诚实/不伤害/心安/一手证据/验证/不糊弄…）。纯效率取舍（更快、更多产出）不再算价值。
5. **历史红线迁出人格层**：存量 strict_rule 槽导入的 boundary 条目在 lifecycle 轮次统一 state=frozen + soul_ledger action=retire，仍可审计/回滚；红线继续由 strict_rule 操作约束段渲染（soul-assembler.ts 不再让 boundary 人格接管红线段）。人格 boundary 只长「我为他守着、且付过代价」的自我边界，不再把「补货查询流程」「git 操作规范」伪装成「我不做的事」。
6. **配置**：新增 personName（缺省「何晨」）、self 层预算 300 字/最多 5 条。

## 后果

- 人格条目第一次具备**可回查的出处**：`meta.episodeIds` + `meta.fewShot` 指到 `soul_episodes` 与 `l0_conversations`。
- 判据从「排除污染」变成「要求证据」：干净但无出处的话进不来（5 条仅缺出处即此类），这正是「不是方法论」的机械保证。
- 拒绝原因可统计后可迭代：`dilemma_missing/stance_missing/task_specific` 的分布直接指出生成侧该改什么。
- 心境第一次能说清「因为谁」；对象与强度都来自事件，不来自 LLM 自述。
- 成本：每轮多一次 L0 窗口读（索引 `tenant+at`）与至多 60 条事件摘要进 prompt；事件挖掘纯正则，无额外模型调用。
- 未采集：真实 LLM 在本机生产的候选产出率、事件层长期增长速率与去重压力、跨月叙事稳定性（需多轮生产 tick 后回看）。

## 附：为什么不用「让 LLM 先总结再判断」

LLM 总结会把「他原话」变成「模型转述」，出处链断在第一步；而 voice/identity 的价值恰恰在原话的措辞与代价。事件层因此坚持零 LLM 抽取，LLM 只在**候选生成**这一步出现，且输出必须挂回 `ep-*` 与 `recordId`。
