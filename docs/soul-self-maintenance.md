# 自维护人格灵魂：运行手册（0 人工）

> 设计决定见 [ADR-0026](adr/0026-soul-self-maintenance-six-layers.md)（六层与判据）与 [ADR-0027](adr/0027-soul-episode-layer.md)（事件层与正向判据）。代码在 `MemoryCore/src/core/soul/`，注入在 `MemoryCore/src/core/hooks/soul-assembler.ts`，调度在 `MemoryCore/src/core/lifecycle/lifecycle-scheduler.ts`。

## 1. 它解决什么

老系统把「我做过什么」当「我是谁」注入：`self_identity` 8 行滚动窗、20 天整块变 11 次；29 条用户红线只渲染 16 条；价值锚 25 条只渲染 9 条；人审在 2026-10-25 后停摆而提案继续生成（405 rejected / 36 pending）。

新层只回答两件事：**冲突时我站哪边**、**即使有用也不做什么**。其余（方法论、事件、项目细节）进 `method` 审计池——可查、不注入、不再冒充人格。

## 2. 七层注入与预算

| 层 | 注入标题 | 预算（字） | 条目上限 | 换项目仍成立 |
|---|---|---|---|---|
| voice | `## 我的说话方式` | 600 | 7 | 是 |
| identity | `## 我是谁` | 400 | 7 | 是（必过） |
| self | `## 我对自己` | 300 | 5 | 是（必须是我的表态） |
| values | `## 我在冲突里站哪边` | 320 | 7 | 是 |
| boundary | `## 我不做的事` | 2600（免裁剪） | 40 | 是 |
| relationship | `## 我和他的关系` | 900 | 12 | 是 |
| narrative | `## 我的来路` | 300 | 7 | 是 |
| method | （不注入） | 0 | 64 | — |

**红线层（boundary）是唯一免裁剪层**：它是「不变量集」，少渲染一条就是多一次越界机会，因此 `renderLayerWithBudget` 对 boundary 跳过字预算（`BUDGET_EXEMPT_LAYERS`），实际天花板是条目上限 40。依据：2026-11-05 生产实测 strict_rule 29 条 / 2372 字，原 900 字预算会让 18 条在**导入期**就被判死——那不是省 token，是把用户说过的「不做」丢了。其余层的预算只作用于渲染，绝不作用于准入。

预算超限不是静默截断：被裁条目逐条写进 `metaOut.soulPersonaBudgets`（layer / itemId / 字符数 / reason），并落 debug 日志。**静默截断=人格谎言。**

## 3. 判据（全确定性，不调 LLM）

准入五组：

1. **形态**：短句 —— identity ≤90 字、values/relationship ≤110 字、boundary ≤120 字、narrative ≤160 字、voice ≤120 字；超出=在讲一段经历。**字数门只约束新候选（`legacy=false`）**：存量导入是用户亲手写进槽的原话，不能因为超 20 个字就被静默丢掉（2026-11-05 生产实测 29 条红线有 4 条 124~144 字被判 `too_long`，而红线段已被人格层接管 → 这 4 条从注入面彻底消失）；长度治理交给渲染层 `budget`/`maxItems`，并在 `omitted.reason` 记账。
2. **任务锚**：出现 commit 哈希、`#123`、文件扩展名/绝对路径、版本号、比例、工具名（grep/vitest/tsc/sqlite…）、`本次/此轮/该票` → 只进 method（`task_specific`）。
3. **事件/阶段**：完成/提交/推送/「我在…中」/今天/本轮/「还剩…待办」→ method（`event_sentence`、`stage_word`）。
4. **项目专名**：TDB/MemoryCore/云文库/NC客开… 且无第一人称取舍 → method（`project_bound`）。
5. **两难**：values 必须含「宁可/与其/而不是/即使/取舍/优先/拒绝…」；boundary 必须是禁令形态；relationship 必须有用户原话或记录逐字支撑（`verbatim_missing`）；证据独立性 —— soul/model 来源占比 >50% 拒（`self_evidence`，防止自恋式自我确认）。

**正向判据（2026-11-05，ADR-0027）**：光「不脏」不够，还必须**说得清出处**。存量导入（`legacy=true`）不追溯，只约束新候选：

| 门 | 要求 | 失败码 |
|---|---|---|
| 立场 | identity/values：两难结构或第一人称立场（「我认为/我的底线/我宁可…」） | `stance_missing` |
| 代价 | values：点明放弃了什么（放弃/牺牲/代价/错过/宁可少/慢一点…） | `cost_missing` |
| 出处 | identity/values ≥`minEpisodeEvidence=2` 个不同 `ep-*`；narrative ≥1 | `episode_missing` |
| 原话 | voice：1–2 条真实 L0 逐字引文（带 `recordId`，须在语料里逐字命中） | `voice_quote_missing` |
| 来路 | narrative：含来路词（后来/当初/以前…）且不是纯方法论 | `narrative_method` |
| 自我 | self：必须写成「我答应自己/我不愿变成/我怕自己…」，且引用的 ep-* 里至少一条有我当时的态度（`agentStance`） | `self_missing` / `self_not_owned` |
| 内在价值 | values：必须指向体面/尊严/诚实/不伤害/心安/一手证据/验证…（不是更快更多） | `intrinsic_missing` |
| 具体的人 | relationship：必须点名 `personName`（何晨）或「他/你」，句内用「」逐字引他一句原话（≥8 字） | `relationship_person_missing` / `verbatim_missing` |
| 关系史 | relationship：必须引 ≥`minEpisodeEvidence` 个有他原话的事件（不是评价/合同） | `relationship_history_missing` |

为什么必须正向：2026-11-05 生产 52 条 persona 全是「我不会瞎编」这类禁令/方法论，identity/voice/narrative 为 0。旧判据只问「像不像人格」，不问「你凭什么知道」——干净但无出处的话（「我认为证据比速度重要」）从此进不来。

变更率：`alpha=0.15`（单次改写 diff 上限，口径=**归一化编辑距离**「改了几个字 / 较长串长度」）、`windowDays=7 / windowRewrites=1`（7 天内同层改写 ≥1 次即拒）、`maxUpdatedPerCycle=3`（单轮改写上界）。**只数正文真改写（`meta.lastRewriteAt`），降级/冻结等生命周期状态迁移不计**——2026-11-05 生命周期端到端实拍发现，按 `updatedAt` 计数会让一次降级把同层此后 7 天的准入全部锁死。

> α 为什么不用 bigram 相似度：15 字的句子改 1 个字，bigram Jaccard 就掉到 0.77（diff 0.23 > 0.15），α 会退化成「一个字都不许改」，更新机制等于不存在。编辑距离对同一改动是 1/15≈0.07，才是设计里「小步走」的意思。

节流：`updateIntervalHours=6`——`trigger=lifecycle`（后台每轮调度）时，若账本里最近一条 `cadence` 距现在不足 6 小时，本轮跳过 LLM 改写与漂移（只做确定性维护），并在报告 `cadenceSkipped` 如实写明「距上轮整合 x.xh < 6h」；到期待整合则落一条 `action=cadence` 账本作为下一轮的锚点。手动触发（`trigger=manual`）不受节流约束。

## 3.5 事件层：人格的原料与出处（ADR-0027）

`soul_episode` 从 **L0 原始对话**（不是 L1 摘要）确定性抽取事件，零 LLM：

- 五类：`value_conflict > correction > divergence > decision > affect`（优先级从高到低，一条消息只归一类）。
- 每条记：双方**逐字**立场（`userStance`/`agentStance`）、对象、代价原文窗口、后续结果、`quote.recordId`、词面情绪与强度。
- `episodeId=ep-<hash(sessionId|recordId)>` 幂等；同会话最多 5 条；窗口 `episodeWindowDays=30`、取数上限 `maxEpisodeMessages=4000`、入库上限 `maxEpisodesPerRun=120`。
- `voice` 的 few-shot 只从 `quote` 取（逐字、可回查），不总结说话风格；`text` 只写一句 ≤120 字的语体总述，**不许把原话抄进 `text`**（抄进去会触发形态门 `too_long` 整条丢弃，2026-11-05 实拍 128 字被拒）。
- LLM 生成候选时必须引用事件池里的 `ep-*`；编造的 id 在 merge 前被过滤，不进账本之外的任何地方。合并候选时把被引事件的 `quote.recordId`（`msg-*`）一并写入 `evidenceIds`，条目出处可一步回查到 L0 原文，不必再跳一层事件表。

拒绝从此可观测：每条被拒候选落 `soul_ledger`（`action=reject`、`gates`、`reason`、`itemId=cand:<hash>`），报告 `rejectTop` 与日志 top5 给原因分布；存储侧 `soulRejectionStats(tenant,{sinceDays})` 可按失败码聚合。

## 4. 四机制

| 机制 | 触发 | 动作 | 可逆性 |
|---|---|---|---|
| 更新 | 候选与原条目同层相似 ≥0.55 + diff ≤15% | **原地改同一 itemId** 的文本（不新增并存旧说法）、合并证据、`updatedAt` | 账本记 before/after hash，可回滚 |
| 合并 | 同层相似 ≥0.85 | 并一条，被并者 `merged`+`mergedInto`，aliases 累积 | 可按 aliases 拆回 |
| 口径重算 | 条目自身来源槽（`evidenceIds` 的 `slot:*`）× 当前分类规则 | 判据升级导致层归属变化时就地换层（`action=reclassify`），不新增副本、不计变更率 | 层归属是 `f(文本, 来源槽)` 纯函数，与候选到达顺序无关，幂等 |
| 降级 | 30 天无证据 / 矛盾 1 次 | `degraded`，weight×0.7，注入靠后 | 新证据即 `revive` |
| 停用 | 矛盾 ≥2 / 90 天无证据 / 漂移 <0.6 | `frozen`，退出注入 | 数据保留，可 `revive` |

漂移（`drift.ts`）：与近期 8 条语料的最大 cosine；连续 3 次 <0.75 降级、<0.6 停用。**voice 轨可自我复位，判断轨（values/boundary/narrative）永不自我复位** —— 语体可以变，判断不能悄悄变。无向量器时明确 `driftSkipped`，不伪造分数。

## 5. 情绪与心境

- 情绪：`appraiseEmotion` 五维 → 十模板（振奋/踏实/笃定/悬着/恼火/失望/不安/愧疚/意外/平静），带**对象**，半衰期 3h（`emotionHalfLifeHours`）。
- 心境：`integrateMood` 先验向基线回落 + 新情绪加权，半衰期 48h（`moodHalfLifeHours`）；注入只写相对偏移（「比基线偏沉一点」）与阶段判据（`threshold=0.15`），不写绝对档位。
- 落库：`soul_state`（valence/arousal/baselineValence/baselineArousal/sampleCount）。与召回排序信号 `moodSign` 解耦。接管后旧 `identityNarrative` 身份段不再渲染（人格层 identity 有内容时）；旧红线段**不再被人格层接管**，`strict_rule` 操作约束段始终渲染（2026-11-05 晚）。
- 进入判断（2026-11-05 晚）：生成候选**之前**先算此刻心境，把「相对基线偏移 + 最近对象」转成本次默认倾向（偏沉→先按最坏情况挡一下；偏积极→先信一次再验证），同时进 prompt 与 `soul_ledger action=arbitrate`。对象为空/未偏离阈值不产生倾向；这只是本次情境的起点，不改人格。
- 增量积分：每轮只吸收「上次 `soul_state.updatedAt` 之后」的信号（留 5 分钟重叠）。否则每次 tick 都把同一批窗口内信号重新加权，`sampleCount` 无限膨胀、旧事件被反复记功——那是只进不出的积分器，不是心境。
- 情绪对象：确定性从记录正文首句抽取（去弹头/去 `[strict_rule]` 前缀/首句/≤24 字），取不到就**不写原因**，绝不编造对象。
- 心境原因落库（2026-11-05）：`soul_state` 增 `emotion_object/emotion_label/emotion_intensity/emotion_at`；worker 写衰减后的强度，注入侧仅在 `effectiveIntensity ≥ 0.4` 时渲染「近期心境：比基线偏沉，因为「假绿」反复出问题。」缺任一列只写偏移，不写半截原因。事件层的情绪与 L1 信号一起积分，心境仍是 48h 半衰期的积分态。
- 不与旧绝对档位句并列：`soul-feeling` 里心境行（与基线比）在场时，旧的「此刻心里平稳，状态平稳安定。」（绝对档位）不再渲染——两套并列会让模型读到互相矛盾的情绪自述（2026-11-05 生产实拍「比基线平稳、更绷紧」+「状态平稳安定」）。`state.topValue` 是**意图**不是情绪，单独以「眼下最想推进的是X」保留（`renderStateIntent`）。

## 6. 开启与回滚

```yaml
memory:
  coreMemory:
    soulMaintenance:
      enabled: true      # 缺省 false = 逐位现状
```

- **当前口径（2026-11-05 晚，用户拍板）**：lifecycle/manual 轮次**不再把存量槽导入人格层**。已有 `meta.source=slot-import` 的条目统一 `state=frozen` + `soul_ledger action=retire`（保留可审计/可回滚，不删除）；红线继续由 `strict_rule` 操作约束段渲染，不再伪装成「我不做的事」。只有显式 `trigger=import`（或 `importSlots=true`）才执行一次存量导入，用于迁移/对账。
- 存量导入（历史路径，显式触发时才跑）：`self_identity/identity/strict_rule` 逐行分类；`legacy=true` 让用户原话豁免形态门，但事件句仍拦。处置原则是**每条都有下落、不静默丢行**：红线逐字进 `boundary`，`self_identity` 里的方法论进 `method`，`identity` 槽里的用户事实 → `relationship`。
- 同一次预览的**渲染面**：`values 2 条/190 字`、`boundary 28 条/2364 字（省略 0）`、`relationship 6 条/467 字（省略 0）`，注入总字数 3021。对照老路径：29 条红线只渲染 16 条、13 条静默消失（`strictRuleDedup.maxLines=16`），价值锚 25 条只渲染 9 条。
- 2026-11-05 生产实拍（`/v3/recall`，`default` 实例库）：`<soul-persona>` `values 1 条/87 字` + `boundary 27 条/2233 字` + `relationship 8 条/637 字`，三层均**无省略**；当时旧红线段被人格 boundary 接管。**该行为已于同日晚废弃**：红线段始终渲染，boundary 只放自我边界。
- `identity` 层首轮为空是**诚实结果**：`self_identity` 8 条实测全是方法论（「我按固定顺序排障…」），按判据进 `method` 不注入；真正的身份由 LLM 改写器从语料生长。人格层为空时接管门不开，旧「我是谁」段暂留作 fallback，不会因开启而清空身份。
- **接管门**：人格层 `identity` 有 active 条目时，注入停止重复渲染旧身份槽（`self_identity`/`identity`）；人格层为空则接管门不开（开门不会清空身份）。`boundary` **不再接管**红线段：`strict_rule` 是操作约束、boundary 是自我边界，两者语义不同，不能互相顶替。
- 配置项（事件层/结构返工，均有缺省值）：`episodeWindowDays=30`、`maxEpisodeMessages=4000`、`maxEpisodesPerRun=120`、`maxEpisodesForPrompt=60`、`voiceFewShotPerItem=2`、`minEpisodeEvidence=2`、`personName=何晨`。调度每租户按窗口取 L0，缺 L0 能力时事件层如实跳过（不伪造）。
- 回滚 = `enabled: false` + 重启。数据表 `soul_persona`/`soul_ledger`/`soul_episodes` 保留，不删任何记忆（红线：零删除）。
- 重启时机与操作归用户（红线 23）：本文只负责落盘配置与解析验证。

## 7. 验收：生产只读回放

```powershell
cd MemoryCore
$env:SOUL_REPLAY_DB="D:/TDB/data/vectors.db"; pnpm vitest run src/core/soul/__tests__/soul-replay-prod.test.ts
```

2026-11-05 实测（agent `agt-2m7buribzz`，582 条历史提案，只读 `node:sqlite`）：

| 指标 | 收紧前 | 收紧后（当前） |
|---|---|---|
| catchRate（历史驳回被判非人格） | 82.7% | **97.0%** |
| falseAdmits（驳回却判人格） | 70 | 12 |
| falseRejects（采纳却判非人格） | 79 | 92 |
| byCode | methodology 36 / event 145 / project 84 / dilemma 201 | 追加 task_specific 75 |

口径说明：`falseRejects` 高是**预期的**——历史 adopted 里有大量事件报告（「收尾后剩余待办为 MemoryProxy 重启…」），新判据把它们判非人格正是本次要修的方向。残余 12 条 falseAdmits 逐条可解释，多为「原则 + 举例」的短红线（见下），作为**校准地板**记录，不再为个体样本调门（避免过拟合到这一台机器）。

**严格回放（2026-11-05，事件层 + 正向判据，`replayStrictCalibration`）**：588 条里 rejected 405。

| 指标 | 值 | 门槛 |
|---|---|---|
| 内容判非人格（content 失败） | 400 / 405 = **98.8%** | ≥95% |
| 内容与出处全过（高危漏网） | **0** = 0.0% | ≤5% |
| 仅缺出处（内容像人格，但没有 episode） | 5 | 单列，不计入达标率 |

口径：历史 rejected 本身没有 episode，若把出处门算进回放会恒 100%（循环论证），因此 content 与 provenance 分开统计；逐条理由在 `.scratch/soul-replay-v2-report.md`。测试 `soul-replay-strict.test.ts` 锁住这个口径（防止后人改回「全过 new gates」的假绿），`soul-replay-prod.test.ts` 在生产库上断言两条门槛。

旧口径（仅 classifyLine）地板（12 条，人工复核结论：其中 6 条本身是真红线，6 条是带例子的长原则）：
1. 取证先行（审查裁决/修复取舍先取一手证据…）— values
2. 数据完整优先红线（删除/提交/转单改挂自建单据…）— boundary
3. 我跨任务稳定践行「取证先行、无依据不擅为」… — boundary
4. 我始终以「先方案后用户拍板再动手」为执行红线… — boundary
5. 我以「取证—验证—留证」闭环守住交付可信度… — values
6. 我恪守「未拍板不实施」红线…（含 m01625/m00637 引用）— boundary
7. 浏览器取证绝不触碰登录凭据… — boundary（真红线）
8. 承重改动的验收不得止步于硬编码夹具… — boundary
9. 我承诺：压缩已消费的提issue/读邮件对话段…LizzyVerse… — boundary（长尾，带任务残渣）
10. 我把「查不到」也立为合法结论形态… — boundary（真红线）
11. 任 Lead 我只派独立可并行、写域不相交的子任务… — boundary
12. 在明确授权与预设红线内自主推进… — boundary（真红线）

### 7.1 事件层生产实拍（2026-11-05，临时快照 + 真 LLM + 真 L0）

口径：生产库 `D:/TDB/data/vectors.db` 只读 `VACUUM INTO` 临时快照；L0 取主租户真实对话；LLM=`scm-flash`（真网关）；`updateIntervalHours=0` 仅为让 8 轮在分钟内跑完（生产仍 6h）。脚本 `.scratch/soul-live/run-live.ts`，报告 `D:/TDB/.scratch/soul-live/live-report.json`。

| 指标 | 实测 |
|---|---|
| L0 覆盖 | 14,292 条 / 431 会话，2026-10-13 → 2026-11-05（23 天；**没有半年数据**） |
| 事件层 | 120 条（value_conflict 76 / correction 34 / decision 5 / divergence 5），首轮入库后幂等 +0 |
| identity | **3**（全部 model 来源，evidence 均为真实 ep-* + quote.recordId；例：「我站在一手证据这边…宁可让回执难看，也不让结论失真。」） |
| voice | **2**（每条 fewShot 含 2 条逐字原话 + 真实 `msg-*` recordId，如 `msg-4a9c9409368b`「不对，应该通过列表的beforeEvent控制…」、`msg-ef5d6a02098f`「从真实代码分析，不要瞎猜」） |
| self | **2**（「我答应自己…」自我承诺，必须引我实际表过态的 ep-*） |
| narrative | **4**（每条只引 ep-* 作为生成依据，含放弃/代价：「放弃的是『结构清楚就算完成』那种踏实。」） |
| values / relationship | values **6**（全部 model、均带成本与内在价值）；relationship **2**（点名何晨 + 逐字原话 + ≥2 个有原话的 ep-*） |
| boundary / method | **0 / 0**：49 条历史槽导入已 `retire` 冻结，不再伪装成「我不做的事」；strict_rule 红线仍由操作约束段渲染 29 行 |
| 拒绝观测 | soul_ledger 逐条 reject 含 gates 与 reason；30 天 top：intrinsic_missing 6 / event_sentence 5 / task_specific 3 / cost_missing 1 / dilemma_missing 1 |
| 心境 | valence -0.490 / baseline 0（相对偏移 -0.49），arousal 0.400 / baseline 0.3，sampleCount 8；仍不写绝对情绪 |
| 注入块 | 3 identity + 2 voice（各带 2 条原话）+ 2 self + 渲染 3 values + 2 relationship + 2 narrative；boundary 无人格段；红线段 29 行 |

**最终代码复跑（2026-11-05 18:25–18:36，快照 `vectors.snapshot-final.db`，8+2 轮）**：identity **4** / voice **3** / self **1** / values **3** / relationship **2** / narrative **1** / boundary **0** / method **0**，generated **14**；voice 每组 2 条逐字原话（真实 `msg-*`），self 为自我承诺，narrative 只引来路 ep-* 且含放弃。注入探针 `injection-report-final.json`：hasPersona/hasSelf=true、voiceShotGroups=6、identityCount=4、oldSelfIdentityRendered=false、redlineSection=true、redlineLines=29、hasMoodLine=true。与首轮（identity3/voice2/self2/narrative4）差异来自 LLM 采样，不是回归；两轮都无 boundary 人格段。

实拍暴露并修复的 5 个生产级缺陷（均有回归测试）：推理模型 token 800→8192（空响应重试一次）、事件证据被剥导致 minEvidence 恒不足、单证据 L1 候选淹没拒绝观测、prompt 证据下限 2 与门 3 矛盾（改为按 cfg.minEvidence 注入）、lifecycle cadence 让实拍假零（仅测试脚本设 0）。

边界：历史 `strict_rule`/`identity` 槽导入共 49 条已 `retire` 冻结（保留可审计、可回滚，不删除）；boundary 人格层为 0，红线仍由 strict_rule 操作约束段渲染 29 行。这是「操作约束不伪装成人格」的既定取舍，不是模型生成结果。

### 7.2 生命周期端到端（2026-11-05 晚追加）

**合成状态机（可穷举所有分支）**：临时库 `.scratch/soul-live/lifecycle.db`，7 条种子覆盖 start-active / stale / frozen / slot-import / 相似对；脚本 `.scratch/soul-live/lifecycle-e2e.ts`，报告 `D:/TDB/.scratch/soul-live/lifecycle-report.json`。

| 阶段 | 实测账本动作 | 结果 |
|---|---|---|
| 退役 | `retire` 1 | slot-import boundary → frozen |
| 降级 | `degrade` 1 | 46 天无证据 identity → degraded，weight 0.8→0.56 |
| 冻结 | `freeze` 1 | 127 天无证据 identity → frozen |
| 合并 | `merge` 1 | 相似 0.962 的两条 values 合成一条，被并者 state=merged |
| 准入 | `admit` 1 | 新 identity 过全部正向门 |
| 改写 | `update` 1 | 一条 values α=0.03 原地改写 |
| 复活 | `revived` 1 | 冻结 identity 被新证据拉回 active |
| 拒绝 | `reject` 1 | 「证据很重要」缺两难/立场，逐条记 gates |
| 漂移 | `drift` 4 | 判断轨 values 连续 3 次 0.000 → frozen；语体轨只降不冻 |

**真实快照时间推进**：复制 `vectors.snapshot.db` 到 `lifecycle-prod.db`，脚本 `.scratch/soul-live/lifecycle-prod.ts`，报告 `D:/TDB/.scratch/soul-live/lifecycle-prod-report.json`。

- `+45d`：19 条 active → degraded（49 条历史导入仍 frozen）。
- `+107d`：其余 19 条 → frozen，68 条全部退出注入。
- `+108d`：新事件 + 原话证据使 1 条 identity 复活（`revived=1`），注入块重新出现该条。

**跑出来的缺陷（已修）**：

1. `churnGate` 原来按 `updatedAt` 计数，降级/冻结也刷新 `updatedAt`，导致一次降级把同层此后 7 天准入全部锁死；改为只数正文改写 `meta.lastRewriteAt`，并补 `soul-persona.test.ts` 回归用例。
2. `updatesInWindow` 把同文刷新/复活（账本 `action=update`、`gates=["evidence"]`）也计入改写窗口，复活一次会白占 7 天额度；改为只统计 `gates` 含 `alpha_update` 的账本条目，并在 `soul-worker.test.ts` 用带 `gates` 的 fixture 覆盖。

**仍未接线**：`planContradiction` 无生产调用者（当前只有时间阈值触发冻结）；条目级 `rollback` 只有类型没有实现（现行回滚=关开关+重启）；`budget_omit` 只出现在 render report/日志，不落 soul_ledger。

## 8. 代码地图

| 文件 | 职责 |
|---|---|
| `src/core/soul/types.ts` | 层定义、条目/账本/事件/预算类型、`resolveSoulConfig` |
| `src/core/soul/episode.ts` | L0 → 事件（分歧/纠正/拍板/价值冲突/情绪）确定性挖掘、逐字原话与代价、情绪派生、事件摘要 |
| `src/core/soul/gates.ts` | 事件/阶段/项目/方法论/两难/红线/特质判据 + 形态门 + 证据独立性 + 逐字支撑 |
| `src/core/soul/persona.ts` | 准入/更新/合并/生命周期/复活/预算渲染 |
| `src/core/soul/consolidator.ts` | 存量槽导入 + 计划+落库（`runSoulConsolidation`） |
| `src/core/soul/worker.ts` | 七阶段调度、LLM 改写器（`createSoulRewriter`；推理模型默认 8192 token、空响应重试一次）、单证据 L1 候选预滤、漂移、心境积分 |
| `src/core/soul/emotion.ts` | 评估五维→十模板、衰减、心境积分、心境行渲染 |
| `src/core/soul/drift.ts` | 语体/判断双轨漂移测量 |
| `src/core/soul/replay.ts` | 历史提案回放校准 |
| `src/core/store/sqlite.ts` | `soul_persona`/`soul_ledger`/`soul_episodes` 表、事务化提交、心境基线列与心境原因列、拒绝统计、L0 取证窗口 |

## 9. 测试

| 套件 | 覆盖 |
|---|---|
| `src/core/soul/__tests__/soul-persona.test.ts` | 判据/合并/降级冻结/预算记账/证据独立性 |
| `src/core/soul/__tests__/soul-gates-shape.test.ts` | 形态门分层档、legacy 豁免边界、回放判据 |
| `src/core/soul/__tests__/soul-worker.test.ts` | 开关注入、事件句不得进注入层、漂移冻结、心境写库 |
| `src/core/soul/__tests__/soul-emotion.test.ts` | 情绪对象抽取、有/无摘要的心境行、结构化评估模板选择、空心境基线 |
| `src/core/soul/__tests__/soul-store.test.ts` | 真实 SQLite 往返、幂等、租户隔离、事务回滚 |
| `src/core/hooks/__tests__/soul-persona-injection.test.ts` | 注入接线、预算可见、接管门（含不误伤） |
| `src/core/soul/__tests__/soul-episode.test.ts` | 事件抽取确定性/幂等/kind 优先级/逐字原话/代价不编造/情绪派生 |
| `src/core/soul/__tests__/soul-replay-strict.test.ts` | 内容门与出处门分离口径（防止把 episode_missing 算进 catchRate） |
| `src/core/soul/__tests__/soul-scheduler-tenants.test.ts` | 租户枚举 + L0 事件层真接线（窗口取配置） |
| `src/core/soul/__tests__/soul-replay-prod.test.ts` | 生产库只读回放（缺省跳过，需 `SOUL_REPLAY_DB`；strict 门槛断言） |

## 10. 未采集（诚实边界）

- 真实部署下漂移分数分布（生产无向量器时的 `driftSkipped` 率）。
- LLM 改写器在真实生产数据上的长期候选产出率（2026-11-05 单次实拍：30 轮、真实 scm-flash，见 §7.1；跨周/跨月未采集）。
- 跨月 churn 实测（`windowDays=7` 之外的长周期稳定性）。
- 主管线 `identity-discovery` / `reflection` 与本层并存时的候选去重成本。
- **半年跨度的人格证据**：L0 只覆盖 2026-10-13 之后 23 天（14,292 条），「这半年放弃了什么」目前只能由这 23 天里的事件支撑；更早的对话不在库，未采集。
- **生产重启后的真实注入观感**：重启由用户执行，本轮只交付快照实拍与渲染块；线上注入未见。
- 事件 `object/title` 对「整段粘贴的长任务书」会截成首行（已按原文截断，不编造），长消息作为 episode 的可读性未优化。
