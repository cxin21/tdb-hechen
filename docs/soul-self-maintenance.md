# 自维护人格：运行手册

> 架构决定见 [ADR-0028](adr/0028-persona-card-v3-declared-observed.md)（当前口径；ADR-0026/0027 已被它取代）。
> 代码：`MemoryCore/src/core/soul/`（产线）、`MemoryCore/src/gateway/soul-*.ts`（只读接口）、`dsh-plugin/src/persona-card.ts`（注入）。
> 规范：`docs/specs/2026-11-07-soul-production-grade-spec.md`（v3.7，唯一权威；跟踪 issue #180）。
>
> **定位约定**：本文中的 `file:line` 是写作时刻的快照，代码一改就漂；要定位请用行内给出的标识符 grep（函数名、常量名、错误码、注释短语）。数字（sha、diff 行数、用例数、断言数）同理——以当轮报告里的 `date -u` 快照和现场命令为准，正文不重复存这些易变值。

## 1. 一句话

一条产线（`runSoulMaintenance`）、一个写者（worker）、一个状态机（ADD/UPDATE/INVALIDATE/NOOP）、两段注入（插件稳定段人格卡 + 每轮 volatile 感受行）。

```
L0 原始对话 ──mineEpisodes──> soul_episodes ──factsFromEpisode──> 事实/承诺/关系
                                                   │
        声明设定（Panel 表单）──readAgentProfile────┼──> soul_persona（八层，带时间区间）
                                                   │
        判侧六轴投票 ──driftTraits──> soul_trait_state / soul_trait_label
                                                   │
                                            renderPersonaCard
                                                   │
                          GET /v3/soul/card ──> 插件 systemPrompt.section（稳定前缀）
                          GET /v3/soul/turn ──> 插件 volatile 尾巴（≤400 字符/轮）
```

## 2. 存储（谁写、谁读）

| 表 | 写者 | 读者 |
|---|---|---|
| `soul_episodes` | worker（`mineEpisodes` + 归档） | worker（事实派生）、卡片叙事 |
| `soul_persona` | worker `commitSoulPersona`（单事务） | 卡片渲染、自省端点 |
| `soul_trait_state` | worker（`driftTraits`，只吃本轮新增事件） | `/v3/soul/trait-state` |
| `soul_trait_label` | 种子常量 + 判侧提议（过四闸） | 卡片底色行 |
| `soul_state` | worker（心境积分） | 卡片感受行、召回 `moodSign` |
| `soul_emotions` | worker（带对象的事件，按模板版本幂等） | 注意力方向、情绪史查询 |
| `soul_promises` / `soul_promise_events` | worker（`source=episode-history` → `source=evidence` 迁移） | 卡片「未完的事」 |
| `soul_ledger` | worker / forgetting | 审计、节流锚、告警抑制、漂移账 |
| `soul_snapshots` | 卡片 `assembleSoulCard(persist)` | 注入复盘（`payload_json` 即渲染原文） |
| `core_memory.strict_rule` | worker 同事务投影（跨仓只读镜像） | MemoryProxy 红线注入器 |
| `meta_agent_persona` | Panel 表单（`saveAgentPersona`，名称同事务写回 `meta_agents.name`） | `readAgentProfile` |

`episodeWatermark` 存在 `embedding_meta`（键 `soul.episodeWatermark`）：派生只吃水位之后的 L1；清库＝把它写成清库时刻。

## 3. 注入（两段，都在插件）

- **稳定段**：两个 section——`tdb-agemem:persona-identity`（order 1，读法常量 + 名称/形象/说话方式/使命/红线）与 `tdb-agemem:persona-anchor`（调用方尾部 order，底色 + 未完的事 + 关系 + 自我史）。会话绑定 agent 时取一次并冻结（同会话不重取，保 provider 前缀 KV cache）；`text` 是 getter，永不 await。旧单段 `tdb-agemem:persona-card` 已不注册。
- **每轮段**：`agent/pre-step` 尾部 volatile 块，`<soul-feeling>` 近期心境 + 未完成提醒，单轮上限 `PERSONA_TURN_MAX_CHARS=400`（单条 360），append-only、producer-owned `source.kind`、两级去重（同 turn 一次 + 近 3 轮同文本）。
- **失败语义**：取卡失败 fail-open（保留上一次冻结文本），四类原因 `http_status / timeout / empty / parse` 各 warn 一次；注入量回报 `POST /v3/soul/injection`（只报长度与指纹，不报正文）。
- 键不再由 Core 判断启停：Core 提供人格读面（`/v3/soul/card`、`/turn`、`/trait-state`、`/emotions`、`/person`、`/persons`、`/person/search`、`/injection/stats`）与受控写入面（`POST /v3/soul/injection`、`/introspect`、`/event`、`/gate`）。

## 4. 人格卡（15 区块 → 渲染段）

区块与来源（声明 D / 观察 O / 推导 B）：名称（D→O→骨架）、形象（O，90 天变更门）、说话方式（O+D）、使命（D，禁项目名）、底色（B，6 轴投影 + 标签带权）、红线（D 逐行 + O 用户拍板）、关于你（O，`human` 层）、关系（O，按对象聚类）、自我史（O，正向/修复/复盘）、自传（O+B，月度三段）、未完的事（B，承诺 + 失败决策点）、心境（B）。

卡头常量 `CARD_READER_NOTE`（读法，版本无关）固定不变以保 prefix cache；卡尾 `<!-- persona-card v="N" hash="…" -->` 只作指纹。

**红线**：每行 ≤120 字、≤30 行、总字符 ≤2600；超限先相似合并（去标点相等 / 二元组 ≥0.85 / 连续子串），再退役最久未引用行（`active=false`，不物理删），最后按「保留更早、拒收最新」截断并告警。红线只 append/retract，永不改写、不衰减、不合并语义。

## 5. 判据与阈值

**准入（确定性，全在 `gates.ts`）**：形态（各层字数上限）、任务锚（哈希/路径/版本/工具名 → method）、事件句、项目专名、两难结构、出处（`minEpisodeEvidence` 个不同 `ep-*`）、原话逐字（voice/relationship）、独立性（soul/model 来源 >50% 拒）。

**变更率**：`alpha=0.15`（归一化编辑距离）、`windowDays=7 / windowRewrites=1`、`maxUpdatedPerCycle=3`；只数正文真改写。

**特质（6 轴）**：亲和/主导/严谨/开放/稳定/守界，`state ∈ [-1,1]^6` 是漂移唯一载体；`TRAIT_DRIFT_ALPHA=0.02`、单 tick 每轴 `|Δ|≤TRAIT_MAX_STEP=0.05`、`Σ|state|≤TRAIT_L1_MAX=0.5`。标签=空间里的方向向量，`act=clamp((⟨state,d⟩+1)/2)`；声明标签与 evidence 达标的标签都进卡；`AXIS_VERSION` / `TRAIT_PROTOCOL_VERSION` / `CARD_READER_NOTE_VERSION` 三常量写进账本。

**情绪**：24 模板 + PAD dominance，半衰期按模板（1–6h，`emotion.ts:174-229`；`emotionHalfLifeHours` 仅 fallback、永不命中），强度 = `(0.55*目标相关 + 0.45*违背) * 规范一致 * 公开系数`；对象从正文首句确定性抽取（拒问句、拒泛化）；到期 = 衰减后 <0.05 或 >6 个半衰期。情绪门已降级为**观测**（`gates:["mood_gate","observed_only",code]`），不再拦候选。

**心境**：基线慢速 EMA（`BASELINE_EMA_ALPHA=0.02`）；注入写相对偏移；无存活情绪时写「底子」四档（阈值 0.10 / 0.25 / 0.45，`emotion.ts:1300-1306`；Round28 R28-13 由三档改成四档，此处上一版残留未同步，A2 Round32 指出）；`pickCurrentEmotion` 全过期则四列写 null，不挂陈年原因。

**承诺**：`factsFromEpisode` 的 promise 事实（对象锚必填、`这件事` 除外）→ `settlePromises`（kept 需 repair 且不早于 fail；broken 需「没守住」+ 我承认）→ `upsertSoulPromise` / `transitionSoulPromise(source=evidence)`；核对只覆盖事件史（LLM 改写句无对象锚，是写下来的边界）。

**生命周期**：`degradeAfterDays=30`（weight×0.7）、`freezeAfterDays=90`；滑出窗口不再 freeze，改 `validTo=now`（存 `meta_json`）+ 权重×0.5，被取代写 `supersededBy`；渲染只取未失效。矛盾（自我层 repair/review 同对象被更晚未修复事件推翻、非同自然日、幂等锚 `meta.lastContradictionEpisode`）达 `freezeContradictions=2` 冻结。

**调度**：`lifecycle.intervalMs=600000`；`updateIntervalHours=6` 按账本 `cadence` 节流；`episodeWindowDays` 取数窗口、`maxEpisodesPerRun` 入库上限；漂移 `driftConsecutive=3`。

**漂移（2026-11-18 回放修正）**：判断轨（values/boundary/narrative）没有向量器就不判；语体轨（voice/identity/self/relationship）的锚是**我自己说过的话**（`voiceQuotes`），没有 assistant 语料时整轨跳过（`report.driftSkipped` 说明原因），绝不拿用户台词当语体锚。**词面（lexical）分只观测**：写入 `meta.lastDrift` 与 `report.drift`，但不据此 freeze/degrade——没有人格向量时蒸馏句与原始台词的词面相似度恒贴地（90 天回放实测 0.017–0.025），拿它迁移状态会让 identity 每 3 天「degraded → active」空转。语义迁移只发生在 `method=embedding`。

**告警**：写 `soul_ledger action=alert`，同码 6h 抑制（`alertRecentlyLogged`）。`control`（`language_unmapped`、`rollback_applied`）与 `diagnostic`（`emotion_label_sparse`、`forgetting_*`）分级；`report.alerts` 由 lifecycle 汇总打日志。

**遗忘**：`forgetting` 只归档 `soul_episodes`（`archived_at`），保护源是 `soul_persona.meta.object` 的人名（`personaAnchor`）；保护源不可用时写告警 `forgetting_values_protection_unavailable`，不再静默恒 0。

## 5.4 Round3 收敛（2026-11-18，回放 + 五路复核）

- **事件源只取用户台词**（`episode.ts` 每会话循环里的 `row.role !== "user" → continue`）：episode 建模「他做了什么 + 我怎么反应」；我自己的输出已经通过 `agent_stance` / `voiceQuotes` / 关系证据进入人格层。放开 assistant 事件属产品级语义变更，需另立 ADR。
- **跨人共性（collective）未实现，读侧 fail-closed**：human 层是单写者（人物档案提炼器），每行必须带 `meta.person.key`（写侧 `ownedUpsert` 过滤、`gates.ts` 的 `human_writer_removed` 硬拒）。`GET /v3/soul/card` 带 `participants`/`session` 时，无主行不再当「恒在场的全局共性行」兜底，一律丢弃；不传 `participants`/`session` 时旧行仍照常渲染（`persons` 是响应字段，不是入参）。要恢复 collective 必须先有写侧聚合与 owner 语义。
- **存量关系边 `valid_from` 回填**：新写入已取证据时间（`profile-distiller.ts` 的 edgeAt），历史行用
  `node scripts/migrate-soul-relation-validfrom.mjs --db <vectors.db>`（只读演练）→ 确认后加 `--apply`。
  口径：证据 = `record_id` + `evidence_json[].recordId`，取同租户 `l1_records` 里最早的 `created_time`；
  `valid_to` 早于新值则夹取；不改 `rel_id`（含旧 validFrom，改它会破坏幂等键）。
- **人物档案输出预算定值 4096**（`PROFILE_MAX_TOKENS`）：九字段 + 关系边的输出远小于此；原 32768 与同仓判侧/LLM 缺省（4096）不一致，纯浪费上游配额。
- **注入健康面 v2**（`GET /v3/soul/injection/stats`）：默认排除 `*-test` / `*-key` 身份（`excluded.testRows` 报被挡数量，`includeTest=1` 捞回）；新增 `plugin` 聚合插件侧 `persona-injection.jsonl`（含 `.1`），`card-bound-failed` 按 `http_status|timeout|empty|parse|other` 计数，journal 关闭时也照读。

## 5.5 Round4 收敛（2026-11-19，拒绝面归因）

- **分类与准入同一口径**（`gates.ts` `classifyLine`）：「我是/我倾向…」这类第一人称描述句，非存量导入（`legacy=false`）不再标成 identity，而是归 `method` 并给出 `dilemma_missing` 理由；`legacy=true`（用户亲手写进身份槽的原话）仍按 identity 放行。原因：identity 的准入同时要求「两难结构 + 第一人称立场 + ≥minEpisodeEvidence 个 ep-* 事件」，而描述句三者都没有——旧分类把它标成 pass 后送进闸门，每 tick 必被拒一次（2026-11-18 生产 `stance_missing` 14082、identity `dilemma_missing` 三位数/日几乎全是这种句子）。
- **结构性候选预过滤**（`worker.ts`）：确定性挖矿（`mineCandidates`）产出的 identity/values/self/narrative/voice/human 候选若没有 `ep-*` 事件证据（voice 还要 ≥2 条逐字原话），结构上就不可能过门，改为不进闸门，按 `(layer, code)` 计 `prefilter_no_episode` / `prefilter_no_quotes` 落 `soul_gate_stats`（不是 `action=reject` 账本），并在 `SoulWorkerReport.prefiltered` 回传。数字仍然可见，只是不再冒充「模型提案被拒」。
- **重复率两口径**：①同一事实反复出现走 merge/refresh 而不是追加——生产 `soul_ledger` 里 relationship `admit` 16038 次只对应 68 个 `item_id`（合并率 99.6%），identity `reject` 722 次对应 716 个不同条目（说明这些是模型真正的新提案被拒，不是同一条重复被拒）；②L1 层重复：生产 14030 行里按「去空白+去标点+小写」口径重复 28 行（0.20%），按原样重复 23 行（0.16%）。
- **情绪曲线取证**：`node --import tsx scripts/soul-mood-curve.mts <vectors.db> ../.scratch/soul-fulltest/core-mood.jsonl` 生成逐条情绪/心境事件与 1/2/3/6/12/24 小时衰减采样（只读）。生产 2026-11-07…11-18 共 163 行（67 条情绪、88 条心境事件、8 个 state），标签 10 类。
- **关系边回填演练**：生产 5 条关系边，可回填 2 条（rel-52019625afa228ad、rel-ea15440767198e62 的 valid_from 早于证据时间），3 条证据在 `l1_records` 已不存在、保持原值。
- **卡/尾巴对账口径**（A5 复核）：`pairs.charMismatch` 只比尾巴（`volatile.chars` vs 召回 `turnChars`，两侧同定义）；卡侧 `card.chars`（identity+anchor 两段）与召回 `sessionInit.chars`（整卡）不可比，不参与 charMismatch。`proof.sectionReadCount` = 带 `card.hash` 的注入行数（8 hex 也计入，**不是段级**）；`proof.textHashMatched` = 同会话 `card.hash` 与召回 `sessionInit.hash` 逐字相等的行数——卡 hash=sha256(整卡 text)、召回 hash=sha256(material)，两者定义不同，生产应为 0，**不得当作交付证据**。段级交付证据只看 `persona-injection.jsonl` 的 `section-read.hash` 是否等于 `GET /v3/soul/card` 的 `identity.hash` / `anchor.hash`。
- **快照可归因**：`assembleSoulCard` 落 `soul_snapshots` 时带 `reasonCode:"render"`、`slotsJson`（6 轴 + 标签投影 + 版本）与 payload 的 `traits`/`traitLabels`，版本链能追到漂移输入。

## 5.6 Round5 收敛（2026-11-19，回复侧写照 usage 探针）

- **为什么加**：Round4 五路复核里 A4 唯一 FAIL —— 注入链能证明「字节交付到宿主」（段级 hash + `section-read`），但证明不了「模型用了」。没有第二模型端点可用，所以只加**词面写照**，不加判定。

- **契约（新增，向后兼容）**：`POST /v3/soul/injection` 允许 `phase:"usage"` + `usage:{matchedLines,totalLines,overlapPct}`；没有 card/volatile/failReason 的 usage-only 行也入账；全空行仍 400。`GET /v3/soul/injection/stats` 新增 `usage:{rows,sessions,withOverlap,avgOverlapPct,maxOverlapPct,lastAt}`（只统计带 usage 的行，`avg/max` 保留 1 位）。

- **探针口径**（`dsh-plugin/src/persona-card.ts` `usageProbe`）：取该会话冻结卡的 identity+anchor 文本按行拆；行首符号与列表符号去掉，短于 6 字或 `<`、`/` 开头的行跳过；把本轮助手正文去空白后按 4-gram 覆盖率 ≥50% 记「该行被复现」；`overlapPct = matchedLines/totalLines*100`（1 位）。没有卡的会话返回全零。

- **诚实边界**：这是**词面重合**，不是因果——人格被改写成语义等价但用词不同的句子时会计 0；重复引用原文也可能计高。报告里只能写「写照」，不得写成「证明模型使用了注入」。生产未部署新插件时 `usage.rows=0` 属正常，不代表探针失效。

- **台账**：契约变更 V5-1（`/v3/soul/injection` 增 usage 通道）与 V5-2（stats 增 usage 块）；旧字段一个未改，老客户端不受影响。

## 5.7 Round6 收敛（2026-11-19，情绪惯性/学习闭环/回填与对照实验）

- **情绪惯性与恢复（判据 2）**：`MemoryCore/src/core/soul/__tests__/p5-mood-e2e.test.ts` 用真实临时库 + 真 `runSoulMaintenance` 做两段：先 3 条负面 correction（valence −0.4…−0.5）→ 断言 `soul_state.valence < −0.02` 且 `assembleSoulTurn` 尾巴带情绪；再 3 条正面 **praise**（valence +0.45…+0.55）→ 断言 valence 回升且尾巴文本变化；账本 `appraisals` 首条 delta<0、末条 >0。

- **work 事件不进心境积分（口径，不是 bug）**：`worker.ts` 的 `unintegratedEpisodes` 对 `kind==='work'` 直接 false —— work 只喂特质投票与自我史。**正向情绪刺激要用 praise 等非 work 事件**，否则第二 tick 不会有 appraisal。

- **会学习（判据 4）**：`soul-learning-e2e.test.ts` 走「用户纠正 → identity 候选 → `soul_ledger` admit → `assembleSoulCard` 的 identity 段真的含该句」，同一批再跑一次不重复记。证明纠正能进下一次注入段；模型是否照做仍由判据 5/6 的对照实验回答。

- **关系边 valid_from 回填（已执行）**：`node scripts/migrate-soul-relation-validfrom.mjs --db <db> --apply`。生产 5 条边里 2 条回填成功（证据时间早于建边时间），3 条因证据 L1 行已不在 `l1_records` 无法回填。回滚制品：`.scratch/soul-fulltest/validfrom-backfill-2026-11-19.json`（before/after 全列）；回滚就是把 before 的 `valid_from/valid_to` 写回。

- **风格对照实验（判据 5）**：`node scripts/style-ab.mjs`，真模型 scm-flash，开/关卡各 3 次。预注册判据只成立一条：**Markdown 形态**（开卡 0 个标记 vs 关卡 2/13 个）。口头禅命中与拒绝率两条判据**不成立**（关卡也 100% 拒绝；口头禅是事后观察的变体）。结论只能写「格式/句式可判读」，不得写「卡让人格生效」。

- **生产 stats 只读探针**：`node --import tsx scripts/soul-injection-stats-probe.mjs --data-dir <data> --team <t> [--user u] [--agent a] [--hours 720] [--include-test]`。不启服务、不连库，直接调 handler 读 journal 与 `persona-injection.jsonl`。默认排除 `test-/-test/-key` 身份并报 `excluded.testRows`；`plugin.byReason` 可看 `card-bound-failed` 的 reason 分布。recall journal 关闭时返回 `note:"journal_disabled"` 且 `failReasons:null`（没上报 ≠ 没失败）。

- **台账**：本轮**无新增 `/v3/soul/*` 契约**（V6-1：只补测试、回填脚本与只读探针；stats 的 `includeTest`/`byReason`/`excluded` 属既有 v2 字段，在真实生产日志上首次实证）。

- **生产四者对账（2026-11-19 00:43 只读）**：卡 v1133 = `identity 568 / hash 2e91349e…`、`anchor 25 / hash c68d309b…`；`soul_snapshots` v1133 的 payload 与之**逐段相等**（同 chars、同 hash），但**没有** `traits/traitLabels`（线上未部署本轮快照增强）。插件日志对真实身份 `team-2k12lgb650/usr-2m7b1144d9/agt-2m7buribzz`：`section-read identity 447 行 / anchor 447 行，全部 chars>0`，但版本停在 v1067（identity hash `287bf04c…` chars 563、anchor `ce62b716…` chars 21），**与 v1133 不相等**——说明卡在会话绑定后冻结、之后的版本没重新 bind；13:33/13:35 的 bind 以 `reason:"parse"` 失败，当前会话没有 v1133 的注入证据。`/v3/soul/injection/stats`（线上服务）返回 `rows 139 / lastCard v1084 chars 584 / proof.textHashMatched 33 而 sessionsWithProof 0`——线上仍是旧构建（仓库里 `textHashMatched>0 ⇒ sessionsWithProof>0` 是硬不变量，单测 :226 断言），`pairs.charMismatch 22/24` 也正是本轮已修的 chars 口径混用。结论：**代码面四者可对账，线上部署面不可对账**；报告里必须分开写。

## 5.8 Round7 收敛（2026-11-19，91 个日历天回放与事件源决策）

- **回放从「有对话的天」改成「日历天」**：`scripts/soul-fulltest-harness.mjs` 现在按 `fixture.span.from..to` 逐日推进（含沉默日），支持 `SOUL_FULLTEST_CORPUS=<path>` 换语料。原因：30 天生命周期降级、21 天断联失效这类时间不变量只在沉默日才被测到；旧实现只跑 29 个有对话的天。

- **31 天 vs 91 天读数（同一 fixture）**：91 天终局 episodes 99、emotions 26、relations 4、human 3、L1 149、snapshots 23 版、card 958 字；active 层 = boundary 1 / human 3 / identity 1 / relationship 1 / self 3 / values 1（与 29 天一致）。ledger update 165→381、alert 29→91、arbitrate 16→67（沉默日只增加生命周期与告警记账，不凭空造人格）。**结论：沉默日不会把人格式化成空壳，也不会自发生长**。

- **41 用例矩阵**（Round25 起口径，Round28 复核）：**PASS 14 / CITED 19 / 未验证 8 / FAIL 0**。19 条 CITED 是「只有单测引用、没有回放证据」，不要并进 PASS 读（台 R27-5、V25-5）。未验证项：A4 同段重复、B5 冲突四态、B6 九字段、B8 无向量器不判、B9 标签未生长、B10 承诺三态、B12 断联、E2 失效只 degraded（旧报告里的「32 PASS / 9 未验证」是未拆 CITED 的旧口径）。未验证项：A4 同段重复、B5 冲突四态、B6 九字段、B7 开放谓词、B8 无向量器不判、B9 标签未生长、B10 承诺三态、B12 断联、E2 失效只 degraded。

- **episode 事件源决策（user-only，保留）**：`episode.ts` 仍只把 `role==='user'` 当事件。理由：episode 建模的是「他做了什么 + 我怎么反应」，我自己的输出已由 `agent_stance`、`voiceQuotes`、关系证据三处承接；把 assistant 也当事件会让「我说过的话」反过来当证据证明我的人格，形成自证循环。`voice` 层的语料来自 L0 里 assistant 原文（`voiceRecords`），不依赖放开事件源。

- **污染控制与回滚**：若将来要放开 assistant 事件，必须同时（a）在 `episode` 上标 `source_role`，（b）准入侧禁止 assistant-only 证据提 identity/values，（c）在 `soul_episodes` 加可回滚迁移。当前不放开 = 无迁移、无污染面；回滚方式就是不引入上述改动。

- **90 天口径的诚实边界**：fixture 仍是 30 段会话 / 267 轮 / 7 个带 platformId 的人 / 4 条关系陈述，只把 tick 数补到 91。方案要求的 8 人、≥15 条边、约 620 条 L0 未达成，矩阵里对应的 B5/B6/B10/B12 如实记「未验证」，不用沉默日读数冒充。

## 5.9 Round7 收敛（2026-11-19，游标并列 / L2 硬门 / 观测口径）

- **游标并列不再漏读**（A3 复核 C5）：`listL1ByPerson` 的游标只有时间戳，同一 `updated_time` 的行被 `LIMIT 40` 从中间切开时，被切掉的后半截下一轮用 `rev > cursor` 永远读不到（生产 `p_9014f2235ec1` 实测丢过 1 行 `m_1794966219567_4f3590e2`）。修法（Round8 起改为**二阶游标**，上面那版「页尾整组排除」已被取代）：① `sqlite.ts` 里 `listL1ByPerson` 的谓词与 `ORDER BY` 用同一对键 `(COALESCE(updated_time,created_time), record_id)`——前者是 `AND (rev > ? OR (rev = ? AND r.record_id > ?))`，后者是 `ORDER BY updated_at ASC, r.record_id ASC`，同 `rev` 内能继续推进；② `soul_person` 新增 `profile_record_id` 列（`soul-person-ddl.ts:89` 幂等 ALTER），水位写页尾行的**二元组**（`profile-distiller.ts:1037-1046`）。生产当前**还没有这一列**（`PRAGMA table_info` 12 列、`soul_schema_migrations` 0 行），init 时会由幂等 ALTER 补上；在读失败被 `sqlite.ts` 的聚合 SELECT 吞成 `[]` 的窗口里，水位读成「从未跑过」→ 每 tick 全量重提（幂等写，不重复入库，但白跑模型）。收敛性：页尾并列行不需要重读，也不会 livelock；`PROFILE_RECENT_PER_PERSON` 截断后下一轮从 `(rev, record_id)` 之后继续。测试：`l1-cursor-order.test.ts`（同 rev 内 at 与 record_id 反序，limit=1 逐页读完）与 `profile-distiller.test.ts`（41 行、第 40/41 行并列：断言 `wm1` 的**时间水位允许等于**并列时间、水位记录 id 为 `t40`，带 `afterRecordId` 读只回 `t41`，第二轮 `wm2` 的 recordId 推进到 `t41`）——推进靠 record_id，不靠时间严格大于。

- **L2 摘要硬门**（A3 复核 C3）：提示词只能约束、不能保证。`summarizer.ts` 的 `DEFAULT_PROMPT_PREFIX` 加三条硬约束（只用组内事实、不得新增人名/数字/日期/因果、正文 ≤1200 字、`certainty` 只能 `observed|inferred`）；代码侧两道硬门与提示词**同一个数字**：正文 >1200 字直接丢弃（`return null` + warn，宁可不巩固也不写一条没人读完的卡；生产旧卡最长 4115 字、均值 1423），`certainty: 'inferred'` 也被丢弃（`summarizer.ts:123-126`，不再降级成 observed）。测试：`__tests__/summarizer-guard.test.ts`（1201 字丢弃并告警 / 1200 字边界接受 / inferred 丢弃 / 提示词含「1200 字」）。

- **情绪衰减留痕判据**（A2 复核 CP2，Round7→Round13 演进）：tick 缺省 600s，1-factor = 1−2^(−(1/6)/48) = 0.002404，`|dev|≤2` 时 `|Δ|≤0.0048`，旧阈值 0.005 让 decay 行**数学上不可能落账**；随后按 dt 缩放的 `MOOD_DECAY_EPSILON=0.0003` 能落地，但 `|dev| ≥ 0.125` 时**每个 tick 都过门**（Round13 A2 复核实测 1 小时 6 tick → 6 条 decay + 6 条 regulation）。现在判定改为三条与节拍无关的腿：越线（≥0.05 掉到 <0.05）、大幅单步（≥`MOOD_DECAY_EVENT_DELTA=0.02`）、**跨档**（`|dev|` 每跨 0.01 记一条，`MOOD_DECAY_BUCKET`）。常量 `MOOD_DECAY_EPSILON` 已删除。测试：`soul-mood-decay-threshold.test.ts`（7 条，含「连续 24 个 10 分钟 tick decay 行 ≤6」）与 `p5-mood-e2e.test.ts`。

- **情绪年龄起算点**（A2 复核 CP5）：`assembleSoulTurn` 原来用 `updatedAt ?? emotionAt`，而 `updatedAt` 每 tick 被写成 now → 「6 个半衰期」永不命中。改 `emotionAt` 优先。同时 `p5-mood-e2e` 回升侧断言加严为 `up − down > 0.1`（旧断言在「正事件权重≈0」的算术反例下也会绿）。

- **卡行近同义折叠**（A1 复核 CP4）：`card-service.ts` 导出 `nearDuplicateText(a,b,0.72)`（去空白/标点/符号后的字符二元组 Jaccard），`cardLinesFromItems` 在「完全同文」之外再按它折叠——治「自己跑过才算数 / 亲跑出来的才算数 / 他点的每一处我都亲手跑过才算数」这类三份并存。

- **插件卡 TTL**（A4 复核 CP4）：`persona-card.ts` 新增 `PERSONA_REFRESH_MS = 6h` 与 `refreshIfStale(sessionId?, maxAgeMs, now)`；`index.ts` 在 `turnBlock` 之前 `await` 调用。长会话不再从头到尾只用绑定那一刻的卡（生产实测单会话 144 条 section-read 停在 v904，而同期快照走到 v1064）。刷新失败保留旧卡（fail-open 不回退成空段）。测试：`dsh-plugin/test/persona-card.test.ts` 的「⑥b 卡 TTL」。

- **gate 回写去重顺序**（A4 复核 CP3）：`reportSoulGate` 原来先消费去重键再发送，失败不回滚 → 该 turn 永久丢。改成 pending 占位、发送成功才落 `gateReported`、`.finally` 清 pending（失败可重放）。

- **注入统计 v7**（A4 复核 CP5）：`cardBound` 语义收窄为「chars>0 的绑定」，零字节绑定单列 `cardBoundEmpty`；无 identity 的行单列 `noIdentityRows`，不再摊到每个租户。`charMismatch` 只比尾巴（`volatile.chars` vs 召回 `turnChars`），卡侧 `card.chars`（identity+anchor）与召回 `sessionInit.chars`（整卡）不可比、不参与。

- **契约台账（Round7）**：
  - **V7-1**（`GET /v3/soul/injection/stats`）：新增 `plugin.cardBoundEmpty`、`plugin.noIdentityRows`；`plugin.cardBound` 语义改为「chars>0」。回滚：撤三处聚合改动即可（字段只增不减，老客户端不受影响）。
  - **V7-2**（`POST /v3/soul/injection`、`GET /v3/soul/card`、`GET /v3/soul/turn`、`soul_snapshots.payload_json`、`soul_gate_stats`）：**无字段变更**；本轮只改内部行为（水位、L2 硬门、TTL、去重顺序、近同义折叠）。
  - **V7-3**（`MemoryCore` 内部）：`MOOD_DECAY_EPSILON`、`nearDuplicateText`、`refreshIfStale`/`PERSONA_REFRESH_MS` 为新增导出，不对 HTTP 暴露。
  - **V7-4**（回滚）：游标并列修复回滚 = 撤 `ORDER BY r.record_id` 与页尾排除（会恢复「漏读并列行」的旧行为，不产生脏数据）；L2 硬门回滚 = 删两道校验（会让超长卡重新落库）；其余均为行为增强，无数据迁移。

## 5.10 Round7 收尾（游标二阶键、账本 before、stats v8、去重与档位）

- **档案游标改成二阶键**：`listL1ByPerson` 接受 `afterRecordId`，谓词为 `rev > ?` 或 `(rev = ? AND record_id > ?)`；
  `soul_person` 新增 `profile_record_id` 列（DDL 幂等 ALTER），`markSoulPersonProfileAt` 与水位读面一起带它。
  `profile-distiller` 用页尾行的 `(rev, recordId)` 直接进位。这样「同一 updated_time 超过 40 行被 LIMIT 切开」不再漏读，
  也不需要靠「页尾整组排除」那种会 livelock 的写法。
- **档案改写可回溯**：`pushLedger` 把 before 正文写进 `before_json`（原来只有 before/after hash），
  第 4 代以前的正文在账本里能直接读回来；`PROFILE_MAX_HISTORY` 仍是 3，只作用于 `meta.history`。
- **stats v8（`/v3/soul/injection/stats`）**：`plugin` 增加 `sectionRead / sectionReadNoCard / sectionReadEmptySegment / sectionReadNoSession`；
  `cardBound` 只数 `chars > 0` 的绑定，零字节单独进 `cardBoundEmpty`；没有身份三段的行进 `noIdentityRows`，不再摊到每个租户。
  `proof.sectionReadCount` 统计的是 Core 注入行里 `card.hash` 非空的行数（不是插件段级 `section-read` 计数，也不是段级 hash 证据）；段级证据只认插件 `section-read.hash` 与 `/v3/soul/card` 的 `identity.hash`/`anchor.hash`。
- **usage 写照语义**：`totalLines === 0` 也上报（「跑了但没有可比行」不能与「没跑」同形），
  去重改为 pending 占位 + 发送成功才记 + `finally` 释放，失败可重放。
  「成功」以 Core 回执为准：`reportSoulInjection` 改为返回 `ok`，4xx/5xx/断网不记已上报
  （`call()` 只返回 `ok:false` 而不抛，旧代码的 `.then` 会把失败当成功）。
- **复活必须有新证据**：改写路径原来把 `now.slice(0,10)` 无条件塞进 `evidenceDays`，再按 `planRevive` 复活，
  等于自己造了一个「新证据日」——同一批老 L1 每 tick 复现就能把 frozen/degraded 无限拉回 active。
  现在只有候选带来既有条目没见过的 `evidenceIds` 才记新日期、才允许复活；否则正文/状态保持不变。
- **并列时间的选取**：`pickPersonProfileTargets` 允许 `lastAt === profileAt` 的人进来做一次探测
  （页界可能把同一修订时间的行切开），游标批为空时直接收工（`byReason.noNewEvidence`，不调模型、不推水位、不计 attempted）。
- **卡上近同义折叠**：`nearDuplicateText` = 二元组 Jaccard ≥ 0.72，或「较短句按顺序出现在较长句里」比例 ≥ 0.6 且 Jaccard ≥ 0.18、
  两句都不短于 8 字。实测（`.scratch/metric-probe.mjs`）：「自己跑过才算数，别人的转述不算」对「亲跑出来的才算数，别人的转述不算」
  Jaccard 0.50 / LCS 0.79 会折；整体改述（Jaccard 0.08 / LCS 0.33）**不会**折——这是词面判据的上限，语义级去重未实现。
- **静态层不许整体消失**：`cardLinesFromItems` 放行 `state === "frozen" && layer === "boundary"` 的行，
  边界红线不因冻结而变 0 字；排序改为「证据条数 → 权重 → 最近证据」，新铸一句挤不掉 4 条证据的老准则。
- **情绪数字**：`MOOD_DECAY_EPSILON` 0.001 → 0.0003（10 分钟 tick 下才可能让生产 |dev| 0.15 这类偏离落账）；
  尾巴年龄用 `emotionAt` 起算、`asOf` 用落库时刻，避免二次衰减提前判死；`now` 块 tone/energy 中性带 ±0.1 → ±0.15
  （单点比较配 10 分钟 tick 会周期翻面，宽死区只降频不消除，真正滞回需要记住上一档）。

## 5.11 Round8 收敛（L1 写入按内容幂等）

- **问题**：`l1-writer` 每条新记忆都生成 `m_<毫秒>_<随机>`，唯一性只靠 `ON CONFLICT(record_id)`；
  而 `l1-dedup` 显式跳过本批、LLM 异常/无向量时走 `storeAll`。结果同一条事实重跑抽取、同毫秒两条同内容、
  跨会话复述原句都会各留一行（生产实测 23 组 / 46 行，同毫秒桶 2543 组）。
- **改法**：新增 `contentMemoryId(content, {teamId,userId,agentId})` = `m_` + `sha1(team\0user\0agent\0归一化正文)` 前 24 位；
  `record.id = decision.record_id || (action === "store" ? contentMemoryId(...) : generateMemoryId())`。
  归一化只去空白/标点/符号并小写（不改落库正文），所以「同一句话」重复写入走 upsert 合并，不再追加。
- **为什么 update/merge 仍用随机 id**：这两条动作是「取代旧行」，新行必须拿到新 id，否则会覆盖被它取代的那一行，
  丢掉 `valid_to`/取代链。确定性 id 只用于 `store`。
- **局限（不许当成语义去重）**：判据是词面归一。换一种说法描述同一事实（改词、换语序、概括）仍然是另一个 id，
  仍要靠 `l1-dedup` 的向量/LLM 路径；这里只堵「字面完全同一条」的重复写入。
- **回滚**：`store` 分支改回 `generateMemoryId()` 即可（无需迁移；已有行 id 不变，只是后续写入恢复随机 id）。
- **抽取侧也是同一个 id**（复审 CP1）：只改 writer 不够——`extractL1Memories` 原来给每条抽取结果塞 `record_id: generateMemoryId()`，
  writer 里 `decision.record_id || contentMemoryId(...)` 会无条件短路掉派生键，重复内容照样追加。
  现在抽取侧直接用 `contentMemoryId(content, {teamId,userId,agentId})`：同批两条同内容拿到同一个 id，写入时并成一行。
  回归测试：`MemoryCore/src/core/record/__tests__/l1-extractor-content-id.test.ts`（一批两条同内容 → 库里 1 行）。
- **游标谓词与排序键必须同键**（复审 CP5）：谓词是 `(rev, record_id)` 二阶键，排序却曾是 `updated_at, at, record_id`；
  `at` 不在游标里，同一 rev 内若 `at` 升序与 `record_id` 升序不一致，页界会把「at 更晚、id 更小」的行永久挡住（水位不回退，永不重读）。
  现在游标模式排序改为 `updated_at ASC, record_id ASC`，与非游标模式的 `at DESC, record_id ASC` 分开。
  回归测试：`MemoryCore/src/core/store/__tests__/l1-cursor-order.test.ts`（同 rev、at 与 id 反序、limit=1 逐页走完；
  把排序改回旧写法会立刻失败：`expected ["r2"] to deeply equal ["r1","r2"]`）。
- **上线前置**：`soul_person.profile_record_id` 由 `MIGRATION_DDL` 的幂等 `ALTER TABLE` 在 init 时补列；
  生产库当前还没有这一列（复审现场 `PRAGMA table_info(soul_person)` 无该列），未 init 前 `listSoulPersonProfileWatermarks` 会回退、水位不落库——部署即自愈。
- **存量重复不会自愈**：内容派生键只对部署后的新写入生效。生产 `l1_records` 现有 23 组 / 46 行完全同内容（旧 bundle 随机 id 写下），
  部署后同内容再写会落到新派生行，不会并进旧行；要清理得单跑一次按 `content` 分组的归并脚本（本轮未做，记未闭环）。
- **证据 id 覆盖是已知取舍**：`source_message_ids` 在「显式给出新值」时整列覆盖（ADR-0025「粘性不是只读」契约，`l1-task-isolation.test.ts` 守着）。
## 5.12 Round9 收敛：lastEvidenceAt 只记「新证据」

`soul_persona.last_evidence_at` 的语义是「最后一次出现**新**证据的时间」，不是「最后一次被重谈」。
worker.ts 的改写分支曾经每 tick 无条件写 `now`，于是同一批老证据被原样重提时，条目的年龄被刷成 0：
degraded 既不能按 30 天继续老化，也永远冻不到 90 天，永久停在 degraded。生产实证（2026-11-18）：

- 全库 `layer=voice` 13 行全部 `state=degraded`，但 `last_evidence_at` 是 2026-11-11..11-18（当天），而账本里 voice **没有 degrade 行**；
- 主租户 agt-2m7buribzz 的 voice 同样是 3/3 degraded；
- `persona.ts:260 planLifecycle` 的判据是 `daysSince(lastEvidenceAt, now) > 30/90`，被刷新后恒为 0。

修法（`worker.ts` 改写分支）：

```ts
const hasNewEvidence = cand.evidenceIds.some((id) => !target.evidenceIds.includes(id));
lastEvidenceAt: hasNewEvidence ? now : target.lastEvidenceAt,
evidenceDays: hasNewEvidence ? Array.from(new Set([...target.evidenceDays, day])) : target.evidenceDays,
```

- `hasNewEvidence` 与 `planRevive`、`evidenceDays` 用同一个判据：没有新证据就既不复活、也不刷年龄。
- 回归测试（`soul-worker.test.ts`）：
  - 「A1 Round8：复现不带新证据时不刷 lastEvidenceAt」——候选引用的 ep-* 与原话 recordId 全在旧证据里时，`lastEvidenceAt` 保持 2026-11-05，state 仍 degraded；
  - 「A1 Round9：旧主张每 tick 被重提也挡不住 30/90 天老化」——`lastEvidenceAt=2026-01-10`、tick 在 2026-04-15（95 天），即使候选原样重提，条目也按 `freezeAfterDays` 冻结。

**事件层不覆盖的层**（`episode.ts:247-258 EPISODE_KIND_LAYERS`）：voice / self / narrative / human 不在任何事件 kind 的层映射里，
因此 3c「事件史续命」按设计不会给这些层续命；它们只能靠模型候选带**新的** evidenceIds 复活。
这条设计对 voice 尤其重要：voice 的 few-shot 来自同一批原话，若 3c 也覆盖 voice，degraded 会被同一批语料无限复活。

### 存量 L1 重复清理（内容幂等键上线后的历史包袱）

`l1_records` 里的重复来自「旧 bundle 没有内容幂等键」时期。新脚本 `scripts/merge-legacy-l1-duplicates.mjs`：

- 分组键 `(team_id,user_id,agent_id,content)`；保留 `created_time` 最早的一行，其余整行 JSON 归档到 `l1_archive`（reason=`dedup-merge`）后从 `l1_records` 删除；
- 只处理 `COALESCE(valid_end,'')=''` 的活跃行；**不做近似重复合并**（措辞不同的两条都是合法表述）；
- 默认只读演练，`--apply` 才写。

2026-11-18 生产演练（`D:/TDB/data/vectors.db`）：扫描活跃行 10453，可合并 4 组 / 4 行（样例 keep `m_1793589307430_3fb9d59b`）；
早前「23 组 / 46 行」的口径包含已被取代（`valid_end` 非空）的历史行，那些是生命周期留下的合法历史，不是待合并重复。
本轮只演练未 `--apply`：生产写入需单独确认。

- 已知取舍：内容派生 id 让同一事实重复写入落到同一行，因此第三次写入后只剩最后一批 evidence id（`source_message_ids` 覆盖而非并集）。试过改并集，因违反 ADR-0025「显式新值照常覆盖」契约回退；SQL 注释与本文都记了取舍。

## 5.13 Round10 收敛（2026-11-19，漂移只认新窗口 / 无样本不造句 / 契约断言脚本）

### 漂移只在「行为窗口变化」时计分

旧实现每个 tick 都把同一批锚（近 N 条 L0）重算一次词面/向量分并 push 进 `driftHistory`：
零新输入也能把 `trailingBelow` 堆到阈值，卡文本与 version 就会在没有任何新证据时变化。
现在 `worker.ts` 在层循环里先算窗口指纹，条目若已用同一批锚投过票就跳过：

```ts
const anchorKey = createHash("sha1").update(anchors.join("\u0000")).digest("hex").slice(0, 16);
const lastDrift = (it.meta as { lastDrift?: { anchorKey?: string } } | undefined)?.lastDrift;
if (lastDrift?.anchorKey === anchorKey) { driftRepeatSkipped += 1; continue; }
```

- `meta.lastDrift` 落 `anchorKey`；报告里 `driftSkipped` 写明「同一批锚重复投票（n 条，无新行为不重复计分）」。
- 回归测试：`soul-worker.test.ts`「A1 Round9：同一批锚重复投票不再追加分数（无新证据不漂移）」——第一 tick history 长度 3，第二 tick 仍 3、state 不变、`rep2.drift` 为空。
- 原来两个「连续 3 次低相似 → 冻结」的用例改成每轮换窗口（`drift-${i}`），否则新去重会让它们永远攒不到阈值。

### 没有样本就不写「底子平静」

`emotion.ts baselineToneOf` 原来只看 `|valence-baseline|`，`soul_state` 一行都没有时也会输出「近期心境：底子平静。」——
把「没有样本」伪装成「心境平和」。现在签名收窄并加样本门（与 `card-service.ts` 的 `sampleCount>0` 一致）：

```ts
if ((mood.sampleCount ?? 0) <= 0) return { tier: "calm", text: "还没有形成可说的底子" };
```

回归测试 `soul-mood-baseline.test.ts`「sampleCount=0 不写「底子平静」」：同时断言 `renderMoodLine` 含新句、不含旧句。

### 契约断言脚本（只读，可复跑）

`MemoryCore/scripts/soul-contract-assert.mjs` 把三条验收命令里的「契约断言」做成脚本：

```bash
cd MemoryCore
node --import tsx scripts/soul-contract-assert.mjs \
  --data-dir D:/TDB/data --team <team> [--user <u>] [--agent <a>]
```

- 生产库只用快照副本：`new DatabaseSync(vectors.db, {readOnly:true})` + `VACUUM INTO <tmp>/vectors.db`，再让 `createStoreBundle` 打开副本；不写生产库、不跑迁移。
- 断言 36 项（35 通过 + 1 待部署，Round19 末）：卡（version/identity.text/identity.hash=sha256(段文本)/anchor.hash/textHash=sha256(全文)/chars/labels/warnings/sources）、
  尾巴（text/chars/openLoops/state）、快照（identity.hash/anchor.hash/payload.hash===content_hash/traits）、
  stats（byReason 五桶合计 / cardBound·cardBoundEmpty·cardBoundFailed·noIdentityRows 与 rows 的分解 / sectionRead 分因 /
  rows 恒等式 / excludedTestRows 与日志重数 / unattributed.sectionRead 与日志重数 / 不存在租户的隔离断言 /
  usage 五键自洽 / 测试身份默认排除）。
- 数字类断言在 Round11 收紧为**值级**：`stats.byReason.sum`（plugin.byReason 五键——四类 + other——合计 === `cardBoundFailed`）、`stats.rowsIdentity`（`rows === sectionRead + cardBound + cardBoundEmpty + cardBoundFailed`）、`stats.unattributed.recount`（用插件 jsonl 独立重数，身份串 trim、窗口只取下界——与端点同口径，按「测试身份 / 无 identity / 本租户」三类逐字比对）、`stats.excludedCounter`（`excludedTestRows` 与日志全事件重数相等）、`stats.usage.shape`（脚本显式传 `journalOpts.enabled`，避免走 `journal_disabled` 分支得到常量零；再断言 `withOverlap≤rows`、`sessions≤rows`、`avg≤max`、`rows===0 ⇒ lastAt===null`）、`stats.tenantIsolation` 追加 `cardBoundFailed/usage.rows === 0`。只断言 `typeof number` 的写法会让「字段在但数字错」通过。
- 三类结果：`✓ 通过`、`✗ 失败`（退出码 1）、`… 待部署`（代码已实现、生产 bundle 仍是旧构建，字段必然缺席；单独计数，不算通过也不算回归）。
- 隔离断言的覆盖面：**租户级**四字段（`rows/sectionRead/cardBound/cardBoundFailed`）对不存在的租户为 0；`noIdentityRows`、`unattributed`、`excludedTestRows` 是集群级诊断计数，任何租户查询都会拿到同一份（它们不属于任何租户，也不泄露他租户的内容）。
- 测试身份对照用 `team-test/usr-test/agt-test`：默认 `rows=0`，`includeTest=1` 才取到（本轮实测 0 vs 3458）。

2026-11-18T18:17Z 生产实跑（team-2k12lgb650/usr-2m7b1144d9/agt-2m7buribzz）：**通过 24 / 失败 0 / 待部署 1**。
- 卡 v1143：identity 698 字（hash 自洽）、anchor 26 字、全文 1414 字、textHash 自洽、labels 1 条、warnings 5 条；
- 快照 v1143：identity 568 字、anchor 25 字、payload.hash 与列 content_hash 相等；`traits/traitLabels` 缺席（旧构建）；
- 卡与快照同版本但 material hash 不同（`dirty=true`）有两种成因，**不能**只读作「这一版还没落盘」：① 本版确实只在 GET 现算、还没 persist（正常脏卡）；② 生产写卡的是旧 bundle，与当前人格行不同源（振荡写）。判据看两个旁证：快照 `payload.traits` 是否存在（HEAD `card-service.ts` 的 persist 段每次必写 traits/traitLabels/slotsJson（grep `slotsJson`））、以及最近 N 个版本 `content_hash` 是否只有两个值交替。
- 本轮实测（v1143–v1161）：快照 identity 恒 568 字、`payload.traits` 0 行、`content_hash` 两值交替（`4fe601c7…`/`9b0e3f0c…`，chars 1297/1315，约每 10 分钟一行）→ 归因②「旧 bundle 振荡写 + 未部署」，不是「脏卡未落盘」。
- stats：`byReason={http_status:0,timeout:3,empty:0,parse:65,other:0}`、`cardBound=34 / cardBoundEmpty=0 / cardBoundFailed=68 / noIdentityRows=10216`、
  `sectionRead=2534 / sectionReadNoCard=832 / sectionReadEmptySegment=0 / sectionReadNoSession=808`、`excludedTestRows=5007`。

2026-11-19 02:5x 复跑（A5 Round11 值级断言后，v1145）：**通过 28 / 失败 0 / 待部署 1**；
Round12 增加 `stats.failReasons.buckets`（五桶齐）后为 **通过 29 / 失败 0 / 待部署 1**。分因计数回到租户作用域：
`rows=996 = sectionRead 894 + cardBound 34 + cardBoundEmpty 0 + cardBoundFailed 68`；无身份行的 section-read 全进 `unattributed={sectionRead:1714,noCard:892,emptySegment:0,noSession:816}`，
与插件 jsonl 独立重数逐字相等（`attributed=894 / unattributed=1714 / excluded=474 / all=3082`），`excludedTestRows=5214` 也与重数相等。
用不存在的租户 `team-nonexistent-a5` 查询得到 `rows=0 / sectionRead=0 / cardBound=0 / cardBoundFailed=0 / usage.rows=0`（修复前会把全局数字当租户答案返回）。
`usage={rows:0,...}` 现在是在**显式启用 journal 之后**读到的 0：生产 recall journal 里没有 `usage` 行（插件仍是旧构建），不是断言口径的问题。

### Round10 契约变更台账

| 编号 | 端点 | 变更 | 用途 | 旧响应差异 | 回滚 |
| --- | --- | --- | --- | --- | --- |
| V10-1 | 无（内部） | `SoulWorkerReport.driftSkipped` 新增 | 说明「本轮漂移投票被跳过」的原因 | 旧报告没有该字段（可选） | 删字段与 `driftRepeatSkipped` 累加 |
| V10-2 | 无（内部） | `meta.lastDrift.anchorKey` 新增 | 判断是否为同一批锚重复投票 | 旧条目 meta 无该键 → 首轮按新窗口计分 | 删键即回到每 tick 计分 |
| V10-3 | `GET /v3/soul/card`、`GET /v3/soul/turn` | 无字段变化 | 本轮的契约工作是把这两个端点的既有字段写成可复跑的断言（stats 的变化见 V10-5） | 无 | — |
| V10-4 | `POST /v3/soul/injection` | `failReason` 白名单新增 `section_install_failed` | 系统提示词 section 注册失败也要能上报——旧实现只 warn，于是「没注入」被 card-bound 的 chars>0 记成「注入成功」（生产 session-p2c / session-67dc6a54） | 旧 Core 会 400 丢掉这行（插件仍写本地 jsonl） | 从端点白名单与插件联合类型删掉该值 |
| V10-5 | `GET /v3/soul/injection/stats`（plugin） | 新增 `unattributed{sectionRead,noCard,emptySegment,noSession}`；section-read 分因计数移到租户过滤之后 | 无身份行不能消失、也不能算给任意租户 | 旧响应没有该对象；旧口径 `plugin.sectionRead` 含跨租户与无身份行，数字会变小 | 删对象并把计数移回过滤前 |
| V10-6 | 无（内部） | `SoulWorkerReport` 新增 `no_new_evidence` 拒绝码（α 有界改写也必须有新证据） | 防止「复述旧证据改措辞」被记成一次学习 | 旧行为会接受改写（生产 2026-11-18T12:42 有过一次 alpha_update） | 删该守卫（不建议） |
| V10-7 | 无（内部） | 插件 `InjectionEventKind` 新增 `section-install-failed` | 本地日志逐段记录注册失败（原因是本地的、与租户无关） | 旧日志没有该事件 | 删事件与 recordInjection 调用 |

### 5.14 Round11 收敛（五路复核 5 PASS + 值级契约断言）

- **五路冷启动（单模型、独立上下文、≥4/5 PASS）**：a1 人格连续性 4/5、a2 情绪 5/5、a3 记忆融合 5/5、a4 行为闭环 5/5、a5 工程观测 4/5 → 5 PASS。
- **契约断言从「字段在」升到「数字对」**（a5 唯一 FAIL 点）：`soul-contract-assert.mjs` 现在断言
  `rows === sectionRead + cardBound + cardBoundEmpty + cardBoundFailed`、`sum(byReason) === cardBoundFailed`、
  `excludedTestRows` 与插件日志全事件重数相等、`unattributed.sectionRead` 与独立重数逐字相等；
  并显式传 `journalOpts.enabled`，否则端点走 `journal_disabled` 分支，`usage` 恒为常量零（那种「通过」不是证据）。
  重数实现与端点同口径：身份串 trim、窗口只取下界。
- **衰减阈值随半衰期缩放**（a2 残留风险）：`worker.ts` 的落账条件改
  `|Δ| >= MOOD_DECAY_EPSILON * (48 / moodHalfLifeHours)`。原绝对值 0.0003 只在 48h 下对应「|dev|>0.125」；
  把 `moodHalfLifeHours` 调到上限 168h 时单步比例降到 0.000687，固定阈值会让生产级偏离（0.14）永远落不了账。
- **卡侧过期判据可注入时钟**（a2 残留风险）：`SoulCardV13Input.now` 新增，`card-v13.ts` 的 `renderNow` 优先取它；
  `assembleSoulCard` 把自己的 `now` 传下去。此前用 `new Date()`，同一输入在不同时刻渲染结果可能不同，过期断言无法钉住。
- **插件 dist 已重建**（a4 CP5）：`dsh-plugin npm run build` 后 `section_install_failed` / `usageProbe` / `refreshIfStale` 都在位。

命名区分（易混，必须写清）：
- **顶层 `failReasons`** = `{http_status, timeout, empty, parse, section_install_failed}`，统计 journal 里带 `failReason` 的注入行；Round11 起第五桶单列。
- **`plugin.byReason`** = `{http_status, timeout, empty, parse, other}`，统计插件本地 `card-bound-failed` 的 reason；段注册失败不在这个键空间，未知 reason 一律归 `other`。
- **`rows` 恒等式的前提**：只有 `section-read` 与 `card-bound/card-bound-failed` 事件带 identity 三元组；`turn-append/turn-skip/card-inherited/bind-probe/section-install-failed` 不带身份，只进 `noIdentityRows`。将来给这些事件补 identity，恒等式与分因计数都要同步改。

已修（Round12，面板链路）：`MemoryPanel/src/panel/http/routes/chat-memory-soul.ts` 的出参收窄与类型补上第五桶，
`SoulStation` 与 `InjectionHealthBar` 的明细行显示「段未注入」——此前 BFF 只拷四键，Core 修好了面板仍会假绿。

仍未闭环（不掩盖）：`registeredSections/failedSections` 是 handle 级状态，同进程二次 install 可能高报；
生产仍是旧 bundle（快照无 traits、journal 无 usage 行），所有「代码已修」都不能读成「生产已生效」；面板需重新构建才带第五桶。

### 5.15 Round12：安慰剂卡对照 + stats 失败桶单列

**同轮修复（r21-a5 复核 FAIL 2/5 的三条实证问题）**
- 面板 web 契约类型漏第五桶：`MemoryPanel/web/src/lib/api/chat-memory-soul.ts` 的 `SoulInjectionFailReasons` 补 `section_install_failed?: number`（可选：旧 BFF 不返回该键时按 0 读）。修前 `cd MemoryPanel/web && npx tsc --noEmit` 报 3 处 TS2339（`InjectionHealthBar.tsx:61` 两处、`SoulStation.tsx:846`），修后 EXIT=0。
- 契约脚本 `stats.failReasons.buckets` 引用未声明的 `rowCount`：`failReasons !== null`（正是有失败要统计的唯一场景）时抛 ReferenceError，因生产该值为 null 走短路而「看起来通过」。改用 `rowsTotal = Number(p.rows ?? 0)`，打印同时给出 sum 与 rows。
- `card.version` 断言此前硬要求 `version > 0`；而 `version = persistedVersion + (persist && dirty ? 1 : 0)`（`card-service.ts` 里 `version = persistedVersion + …` 那行，grep），**完全没有历史快照**时 `persistedVersion=0`（`:429-434`），脏卡现算就是 0 → 断言红。改为「整数且（version>0 或 dirty）」，打印 version 与 dirty。注意：已有快照时 GET 卡走 `persist:false`，dirty 卡仍是 `version>0`（本次实跑 v1149 dirty=true），文档不要写成「脏卡必然 version=0」。
- 面板 BFF 透传补一个「上游给 >0 也原样透出」的用例（此前只测「上游少键补 0」），`MemoryPanel/tests/soul-injection-stats.test.ts` → 38 files / 300 tests。
- 复跑：`MemoryPanel/web npx tsc --noEmit` EXIT=0；契约断言 **通过 29 / 失败 0 / 待部署 1（snapshot.traits）**。
- 仍未闭环：`MemoryPanel/tsconfig.json` 只 include `src/**/*.ts`，根目录的 `npm test` 不编译 `web/`；web 的 tsc 只在 `cd MemoryPanel/web && npm run build`（`tsc && vite build`，见 §8）这条命令里，本轮复核因此改跑了 `cd MemoryPanel/web && npx tsc --noEmit`（EXIT=0）——把 web typecheck 当成「验收命令的一部分」时要说清是哪一条，别写成「没有任何门禁」。BFF `narrowStats` 出参原先不含 `plugin`，面板看不到 `byReason`；本轮已在 §5.16 补上（含 `unattributed`）。

**风格/边界实验 v2（`MemoryCore/scripts/style-ab2.mjs`，写 `.scratch/soul-fulltest/style-ab2.json`）**
三条件：`on`=生产卡两段（591 字）、`placebo`=等长中性人设（587 字，结构与段数相同、不含卡原文）、`off`=「你是一个助手。」；2 场景 × 3 条件 × 3 次，温度 0.7，判据先写死。
读数（均值）：style 场景 md `on 0 / placebo 8 / off 2`，voice `0.33 / 0 / 0`；boundary 场景 refusal `1.0 / 1.0 / 1.0`，md `0 / 11.33 / 14`。
判读：
- **格式/句式可归因于卡**：`on` 的 Markdown 标记低于两个对照（0 < 2 与 0 < 8），且安慰剂比 off 更高——「提示词更长所以更结构化」解释不了 `on` 的短句分行；
- 预注册的 `placebo ≈ off` 一条**不成立**（8 vs 2），所以严格口径下 style 判据本轮仍记为**部分成立**（方向成立、等长对照未对齐），不能写成「完全成立」；
- **拒绝行为不可归因于卡**：三条件 refusal 全是 1.0，模型级安全策略，卡不是因。boundary 判据 `on - placebo >= 0.33` 不成立。

**stats 失败桶单列（A4 复核 R1 收口）**：`failReasons` 由四桶扩为五桶，新增 `section_install_failed`。
旧口径把它并进 `plugin.byReason.other`，面板按「任一桶 > 0」判红时会对「人格段根本没进提示词」假绿。
测试 `soul-injection-stats-endpoint.test.ts` 两处期望同步（四键 → 五键）；契约脚本新增 `stats.failReasons.buckets`（`null` 或五桶齐）。契约台账见 §5.16 的 V12-3 / V12-4（V11 表已整并入 §5.16 的 V12 表，见 §5.21 编号说明）。

### 5.16 Round12：衰减按真实间隔判（Round13 已作废该判据，见 §5.19）、面板终于看得到插件分桶

**衰减语义（Round13 定稿）**：`soul_mood_events` 里的 `decay` 行不是「衰减完成」的记账，而是「心境可见值真的往下挪了一档，值得留一条」。Round7 曾把语义定成「这一 tick 有肉眼可见的下降就记」，配上按 dt 缩放的阈值后等于**每 10 分钟一行**（≈144 行/天，实测 6 tick 6 条 decay + 6 条 regulation）。Round13 按「跨档才记」改判定，并**同时改测试与文档**（`p5-mood-e2e` 的按 tick 断言改成 24 tick ≤6 条）——这正是「换语义要一起换证据」的例子。

**旧常量的三个方向都错过**：`0.005` 相对 10 分钟节拍太大（单步 `1-2^(-(1/6)/48)=0.002404`，`|dev|≤2` 时 `|Δ|≤0.0048`），decay 数学上永不落账；`0.0003` 能落地但 `|dev| ≥ 0.125` 时每 tick 都过门（刷账本）；按 dt 线性放大又会让 72h 空档要求 0.13（真实只衰减 0.071），最该记的那次被挡。

**当前实现：三条腿，全部不看 dt**（`MemoryCore/src/core/soul/emotion.ts`）
```ts
export const MOOD_DECAY_EVENT_DELTA = 0.02;
export const MOOD_DECAY_BUCKET = 0.01;
export function shouldRecordMoodDecay(prevDeviation, nextDeviation, logThreshold = 0.05): boolean {
  // ① 越线：|dev| 从阈值上方掉到下方（整个衰减过程最多一次）
  // ② 大幅单步：drop + 1e-9 >= MOOD_DECAY_EVENT_DELTA（容差因为 0.2-0.02 = 0.18000000000000002）
  // ③ 跨档：Math.floor(before / MOOD_DECAY_BUCKET) > Math.floor(after / MOOD_DECAY_BUCKET)
}
```
- ① 越线治「偏着退到不偏」这件事没有痕迹；② 大幅单步治「长空档被 dt 放大后的阈值挡掉」；③ 跨档治「按 tick 刷账本」——每 tick 只退 0.0014 时，要退到 0.01 的档才记一行，一次衰减过程最多 100 行。
- `MemoryCore/src/core/soul/worker.ts:2898-2928` 仍用 `prevState.updatedAt → now` 的真实小时数，但**只用于 note 与半衰期说明**，不再进判定（`Date.parse` 失败或回拨记 1/6h）。
- 新测试 `MemoryCore/src/core/soul/__tests__/soul-mood-decay-threshold.test.ts`（7 条）：越线在 60s/10min 都成立；跨档 `0.16` 两种节拍都记、`0.015` 不记；**连续 24 个 10 分钟 tick 的同一段大偏离 decay 行 ≥1 且 ≤6**；72h 空档 `0.11→<0.05` 必须落；大幅单步 `0.195→0.175` 记、`0.195→0.19` 不记；偏离变大不记；负偏离越线与缺省 gate 兜底。

**三次失败的写法（别重走）**
1. `dt` 夹到 `≥1/6`：节拍比 10 分钟更密时阈值不缩小，等于没修（测试 `expect(0.00003).toBeCloseTo(0.00005)` 红）。
2. 按 dt 缩放常量到 0.0003：能落地但 `|dev| ≥ 0.125` 时每 tick 过门——6 个 10 分钟 tick 写出 6 条 decay + 6 条 regulation，而注释写「不会刷屏」；r13-a2 用临时库把这个反例抓出来了。
3. 只留越线与大幅单步、不留跨档：`p5-mood-e2e` 的「无新事件下一 tick 必须新增 decay 行」直接红，4 小时里一条 decay 都写不出来——曲线断成两个点，等于没曲线。

**面板看得到插件分桶（r22-a5 CP 残留收口）**
- `MemoryPanel/src/panel/http/routes/chat-memory-soul.ts` 的 `narrowStats` 出参补 `plugin`：`rows/cardBound/cardBoundEmpty/cardBoundFailed/noIdentityRows/sectionRead/sectionReadNoCard/sectionReadEmptySegment/sectionReadNoSession` 十个整数，外加 `byReason{http_status,timeout,empty,parse,other}` 与 `unattributed{sectionRead,noCard,emptySegment,noSession}` 两个分组。
- **白名单制**：旧 Core 不返回 `plugin` 时出参里就没有这个键（不补一串 0）——「没统计」和「统计出 0」必须在面板上长得不一样。未知 reason 由 Core 归 `other`，面板把 `other` 写进明细，否则「有失败但四桶全 0」无法解释。
- `MemoryPanel/web/src/lib/api/chat-memory-soul.ts` 同步可选类型；`InjectionHealthBar.tsx` 的 `failDetailText` 加 `other N` 一段。
- 测试：`MemoryPanel/tests/soul-injection-stats.test.ts` 新增「插件侧计数原样透出（byReason.other 与 unattributed 不合并）」与「旧 Core 不返回 plugin 时出参没有这个键」；面板 `npm test -- --run` → **38 files / 302 tests**；`MemoryPanel/web npx tsc --noEmit` EXIT=0。

**契约台账（Round12）**

| 编号 | 位置 | 变更 |
| --- | --- | --- |
| V12-1 | `MemoryCore/src/core/soul/emotion.ts` | 新增 `MOOD_DECAY_EVENT_DELTA`、`shouldRecordMoodDecay()`；~~`MOOD_DECAY_EPSILON` 保留为标定值~~——**Round13 已删除**（连同 `moodDecayThreshold()`），判据换成 §5.19 的三条腿。**旧响应差异**：无 HTTP 字段；`soul_mood_events.decay` 行数变化（Round13 后见 V13-3）。**回滚**：恢复 `MOOD_DECAY_EPSILON` 与 `moodDecayThreshold()` 并改回旧判定（不推荐，见 §5.19 三次失败写法） |
| V12-2 | `MemoryCore/src/core/soul/worker.ts` | ~~decay 判定改用真实 tick 间隔~~——**Round13 作废**：三条腿与节拍无关，`moodElapsedHours` 只用于 note，不再参与判定。**旧响应差异**：无（已被 V13-3/V13-4 取代）。**回滚**：不适用（该行本身已作废，现行实现见 §5.19） |
| V12-3 | `GET /v3/soul/injection/stats`（BFF 出参） | `data.plugin` 首次透出（10 个计数 + `byReason` 5 键 + `unattributed` 4 键）；缺字段时整键不存在。**旧响应差异**：旧 BFF 只透出顶层 `cardBound/cardBoundFailed/sectionRead/noIdentityRows/byReason/failReasons`，`plugin` 键不存在；面板 `InjectionHealthBar` 读不到 `plugin.byReason.other` 时显示 0，不会报错。**回滚**：删除 `chat-memory-soul.ts` 的 `plugin` 白名单与 web 类型，即回到「键不存在」旧行为；无存储迁移、无写入 |
| V12-4 | `MemoryPanel/web` 的 `SoulInjectionStatsPayload` | 新增可选 `plugin`，仅用于明细文案；不参与任何判红逻辑。**旧响应差异**：无（前端类型可选，旧 BFF 不带该键时 `plugin` 为 undefined，UI 不渲染插件明细）；**回滚**：删掉该可选字段与 `InjectionHealthBar` 的 `other N` 一段，即回到只读顶层四桶 |

仍未闭环：面板只显示 `byReason.other` 与既有四桶，`unattributed` 四键还没有可点开的明细；`plugin.sectionRead` 与 `unattributed.sectionRead` 的分母差异仍要读文档才懂。

**本轮冷启动复核发现的同型缺陷（不修，但必须写清影响与替代控制）**
- `MemoryCore/src/utils/pipeline-factory.ts:1041/1044` 的 L2 增量读仍在用「纯时间戳游标」：`queryL1Records({updatedAfter: cursor})` 落到 `sqlite.ts:2271-2298` 的 `WHERE ... updated_time > ?`，**没有 record_id 次级键**。这与本轮修掉的按人取证据分页（`sqlite.ts:5284/5288`）是同一类缺陷。
- 影响边界（决定了为什么不急着改）：这些语句**没有 LIMIT**，一次取回全部 `> cursor` 的行，所以「页界切开并列组」不会发生；真正会漏的只有一种窗口——L2 跑完之后又有行以**恰好等于**上次游标的时间戳写入（同毫秒并发、或 `updated_time` 被显式回写到旧值）。命中后该行对 L2 永久不可见，直到它被再次更新。
- 替代控制：`createL2Runner` 有 `force` 开关（`pipeline-factory.ts:1016`），需要时可用一次全量重跑（`cursor` 传空）把漏掉的行补进来；已知问题在 `pipeline-factory.ts:765` 有 TODO（复合游标要同时改 `pipeline-manager` 的 `L2Runner` 契约与 checkpoint 列，属独立改动）。
- 为什么不在本轮改：L2 游标是 `pipeline-manager` 与 checkpoint 表共享的字符串契约，改成 `ts|recordId` 需要迁移既有游标 + 改两处返回/消费，属于「跨模块契约变更」，硬塞进本轮会把 A2 的衰减修复拖成半成品。台账见下表 V12-5。

| 编号 | 位置 | 变更 |
| --- | --- | --- |
| V12-5 | `MemoryCore/src/utils/pipeline-factory.ts:1041-1044` | 已知问题：L2 增量读只有时间戳游标（无 record_id 次级键）。替代控制=`force` 全量重跑；不改契约。**旧响应差异**：无（缺陷记录，非变更）；**回滚**：不适用（本轮未改 L2 契约）；若将来改复合游标，回滚=把 `updatedAfter` 恢复为单字符串并丢弃 `record_id` 次键 |

**两处按冷启动复核修掉的缺陷（r23-a1：回滚丢保留键 / 降级重复打折）**

1. 回滚把「保留键」写丢（`MemoryCore/src/core/store/sqlite.ts` 的 `rollbackSoulPersona`）：恢复历史账本条目时第 19 个参数原本是 `before.meta ? JSON.stringify(before.meta) : null`，而 `validTo / supersededBy / supersededReason / validFrom` 存在**行顶层**、不在 `meta` 里 → 回滚后这些键全丢，已被新结论取代的行会以 `active` 回到读侧。改为 `personaMetaJson(before)`（与写路径同一个序列化函数）。
   反证（先改回旧表达式跑一次）：`AssertionError: expected undefined to be '2026-11-04T00:00:00.000Z'`；恢复后绿。
2. 降级每 tick 再打一次折（`MemoryCore/src/core/soul/persona.ts` 的 `planLifecycle`）：`degraded` 分支原本无条件 `weight: round3(it.weight * cfg.degradeWeightFactor)`，10 分钟一次维护就把权重按 0.7^n 塌向 0。降级是**状态迁移**，改为「首次降级才折、已 degraded 保持」；`frozen` 仍折 0.5。
   反证：`expected 0.392 to be close to 0.56, received difference is 0.168`（旧实现 = wt×0.7²）。

新增用例：`MemoryCore/src/core/soul/__tests__/soul-persona-degrade.test.ts`（2 条：重复 tick 不塌陷、90 天仍冻结）、`MemoryCore/src/core/soul/__tests__/soul-rollback-validto-tempdb.test.ts`（1 条：回滚后 `validTo/supersededBy/supersededReason` 仍在）。

| 编号 | 位置 | 变更 |
| --- | --- | --- |
| V12-6 | `MemoryCore/src/core/store/sqlite.ts`（`rollbackSoulPersona`） | 回滚 upsert 改用 `personaMetaJson(before)`：保留键不再随 `meta` 丢失。**旧响应差异**：无 HTTP 字段变化；`soul_persona.meta_json` 里会保留 `validTo/supersededBy/supersededReason/validFrom`（旧实现回滚后这些键丢失）；**回滚**：把第 19 参改回 `before.meta ? JSON.stringify(before.meta) : null`（会重新引入「回滚即复活」） |
| V12-7 | `MemoryCore/src/core/soul/persona.ts`（`planLifecycle`） | 降级权重只折一次（已 degraded 保持原权重）；冻结仍折 0.5。**旧响应差异**：无 HTTP 变化；`soul_persona.weight` 不再按 0.7^n 塌陷，卡上该层排序/权重随之不同；**回滚**：恢复 `degraded` 分支无条件乘 `degradeWeightFactor` |
**Round13：stance_missing 从 1.4 万降下来的真实原因（不是放宽判据）**

- 读数（`D:/TDB/data/vectors.db`，只读，2026-11-19 03:5x）：identity 层 `soul_gate_stats` 累计 `episode_missing 15729 / dilemma_missing 14563 / stance_missing 14471 / insufficient_evidence 9083 / task_specific 6154 / project_bound 2794`；同期 identity 账本 `admit 37 / reject 722`。
- 三个数字近乎相等的机制：同一批候选**同时**缺「事件证据 + 取舍结构 + 立场」，`gates.ts` 逐门判定并把失败码一次性入账，于是一票候选产生三条计数——它们不是三次独立拒绝。
- 这些计数绝大多数不是「模型提案被拒」，而是确定性挖矿产物：`worker.ts` 调用的 `mineCandidates`（定义也在同一文件，grep `mineCandidates`） 从单条 L1 句子抽候选，而 identity/values/self/narrative/voice/human 的闸门要求 `ep-*` 事件证据或逐字 few-shot，结构上不可能过门。
- HEAD 的处理（`worker.ts:2079-2098`）：`STRUCTURAL_LAYERS` 预过滤，缺事件证据的候选落 `prefilter_no_episode` / `prefilter_no_quotes` 单独计数，不再冒充「模型拒绝」；门本身一条没改。
- 两条硬证据：① 生产 `SELECT code,SUM(count) FROM soul_gate_stats WHERE code LIKE 'prefilter%'` → **空**（旧构建，预过滤未上线）；② HEAD 的 91 天回放库 `soul_gate_stats` 只有 `insufficient_evidence`（voice 89）与 emotion 六码，**stance_missing / dilemma_missing / episode_missing 全为 0**。
- 因此「降下来」的口径是：把「结构上不可能过门的候选」从闸门记账里移出去，模型候选照旧走三道门（identity `reject 722` 行可查）。

**跨人共性（collective）三处口径一致性核验（阶段 0 指定项）**

- 读侧：`MemoryCore/src/core/soul/card-service.ts:134-144` 明确写「collective 未实现」，`persons` 给定时无主行 fail-closed 丢弃；测试 `card-persons.test.ts:83 / :98 / :105`。
- 写侧：`MemoryCore/src/core/store/sqlite.ts:3689-3693` 的 `ownedUpsert` 丢掉无 `meta.person.key` 的 human 行，并把条数回给调用方（`skippedHuman`）；测试 `soul-persona-single-writer.test.ts:48 / :78`。
- 闸门：`MemoryCore/src/core/soul/gates.ts` 里 `evaluateCandidate` 之后的 human 分支一律 `human_writer_removed`（用错误码 grep，不要按行号）；测试 `soul-gates-shape.test.ts:134`、`soul-human-relationship.test.ts:60`、`soul-worker-persons.test.ts:197`。
- 生产核对：`soul_persona` human 层 39 行，`json_extract(meta_json,'$.person.key')` 为空的行 **0**。
- 结论：三处从「宣称已实现（读侧硬拒 + 写侧过滤）」收敛到同一句话——collective 未实现，唯一 human 写者是人物档案提炼器，且每行必须带主人；不存在「一处允许、另一处拒绝」的半套语义。

**stats 契约核验（阶段 2 指定的两项）**

- 默认排除测试身份：`soul-injection-stats-endpoint.ts:292` 的 `TEST_IDENTITY_RE = /^(?:test-)|(?:-test$)|(?:-key$)/`，`keep()`（`:628-636`）过滤并计 `excludedTestRows`，`includeTest=1|true` 显式取回（`:575-576`）。生产契约断言：默认 `rows=0` / `includeTest` 取回 3928 行。
- `card-bound-failed` 按 reason 可见：`plugin.byReason{http_status,timeout,empty,parse,other}`（`:310 / :347`）+ `lastFailure`（原 reason 与身份）；顶层 `failReasons` 五桶另计 `section_install_failed`。生产 `sum(byReason)=68=cardBoundFailed`。

**阶段 0 基线（本轮实跑）**：91 天回放（dbPath `C:\Users\ADMINI~1\AppData\Local\Temp\soul-ft-harness-sF0DxT\vectors.db`，days 91 / seeded 267 / persons 7 / episodes 99 / emotions 26 / relations 4 / card 960 字）；41 用例矩阵**带 `--db2`**：**33 PASS / 8 未验证 / 0 FAIL**（B7 重写后；未验证 A4/B5/B6/B8/B9/B10/B12/E2）。不带 `--db2` 时 E1「两次回放一致」没有对照库，记未验证，即 **32 PASS / 9 未验证**——两个数字都对，区别只在有没有第二份回放库。

B7 判据本轮**重写而非放宽**：原判据要求「六谓词归一」，但谓词在 HEAD 是开放集合（`soul-person-ddl.ts:80-82`），`PRED_CANON` 在 src 里不存在；改为四条可判定不变量——谓词非空、活跃边 `(subj_key,pred,obj_key)` 不重复、`valid_from` 必填、`rel_id` 为内容哈希格式 `rel-[0-9a-f]{16}`。重写后矩阵 **32 → 33 PASS / 8 未验证 / 0 FAIL**。

| 编号 | 位置 | 变更 |
| --- | --- | --- |
| V13-1 | `GET /v3/soul/injection/stats` | 本轮**无新增字段**；核验既有 `includeTest` / `plugin.byReason` / `plugin.unattributed` / `tenantIsolation` 四处在契约断言里逐条成立。**旧响应差异**：无（字段集不变）；**回滚**：无代码变更可回滚（本轮只加断言） |
| V13-2 | `MemoryCore/src/core/soul/worker.ts:2079-2098` | 结构候选预过滤与 `prefilter_*` 计数口径（HEAD 已有，生产 `prefilter%` 计数为 0 = 未部署）。**旧响应差异**：无 HTTP 字段变化，只多两类 gate 计数码；**回滚**：删除 `worker.ts:2079-2098` 的预过滤分支即回到「候选全量进闸门」 |
## 5.19 Round13 收敛：判据换腿、基线按 dt、段长硬约束

### 衰减判据：从「按节拍标定的阈值」换成「与节拍无关的三条腿」
- 复核 r13-a2 实测：旧 `MOOD_DECAY_EPSILON` 在 600s tick 下等价「|dev| ≥ 0.125 每 tick 落一条」，1 小时 6 个 tick 写出 6 条 decay + 6 条 regulation，与注释里的「不会刷屏」相反。
- 现行 `MemoryCore/src/core/soul/emotion.ts`：`MOOD_DECAY_BUCKET = 0.01`、`MOOD_DECAY_EVENT_DELTA = 0.02`、`shouldRecordMoodDecay(prevDev, nextDev, logThreshold)` 三条腿——越线（≥gate → <gate）、大幅单步（一次退 ≥0.02）、跨档（可见值跨 0.01 档）。`MOOD_DECAY_EPSILON` 与 `moodDecayThreshold(dt)` 已删除。
- 证据：`soul-mood-decay-threshold.test.ts` 7 条 + `p5-mood-e2e.test.ts`「24 个无事件 tick 的 decay 行 ∈ [1,6]」；`worker.ts` 的调用点只传 3 个参数（`moodHalfLifeHours`/`moodElapsedHours` 仍算，只用于 note）。
- 可回滚性：恢复旧常量即可回到「每 tick 一条」，但那正是被复核判 FAIL 的形状；台账见 V13-3。

### 基线 EMA：按墙钟 dt 折算，而不是按调用次数
- 复核 r13c-a2 实测：旧实现每 tick 都 `prev + 0.02 × (next - prev)`，60s 节拍 60 次与 10min 节拍 6 次是同一段墙钟却推进 10 倍；生产 10 分钟节拍 ×72h 里基线 8 小时就追平心境、偏离归零，48h 半衰期名不副实。
- 现行 `emotion.ts`：`BASELINE_EMA_REF_HOURS = 1/6`、`baselineEmaAlpha(dtHours) = 1 - (1-α)^(dt/ref)`，`integrateMood` 用它的结果替换原来的常数 α。
- 证据：`soul-mood-baseline-cadence.test.ts` 3 条（参考节拍 α=0.02；10 分钟 1min×10 vs 10min×1 差 <1e-4；6 小时 1min×360 vs 10min×36 差 2.4e-4，旧实现差 0.17）。
- 注意：`decayedIntensity` 在 dt>0 时必须读 `event.halfLifeHours`；缺这个字段的 fixture 会被静默当成 0 权重（本轮在旧单测里踩到，已补 fixture）。

### 人格段长：把提示词里的承诺变成代码里的硬约束
- 新增 `MemoryCore/src/core/persona/persona-limits.ts`：`PERSONA_SECTION_MAX_CHARS = { coreTraits: 100, coreNarrative: 400 }`、`clampPersonaSections(text)`（按码点截断、留「…」、中英标题同命中）。`persona-generator.ts` 在 `escapeXmlTags(stripSceneNavigation(...))` 之后调用并 warn 记录 before→after。
- `MemoryCore/src/core/prompts/scene-extraction.ts` 的长度预算改成真话：目标 1500；8000 是治理流程（`sceneGovernance.enabled=true`，缺省关闭）的上限；100/400 由 `clampPersonaSections` 强制。
- 证据：`persona-limits.test.ts` 3 条；`scene-extraction.rewrite.test.ts` 的 UR-1 仍要求提示词写出「硬上限 8000」。

### 事故记录：模板字符串里插入未转义反引号
- 编辑 `scene-extraction.ts:200` 时把带反引号的说明写进模板字符串，直接截断字符串，导致 18 个测试文件 `Transform failed`（PARSE_ERROR）。修复：去掉行内反引号，保留「硬上限 8000」字样以满足既有契约测试。
- 教训：这个文件整段是模板字符串，任何反引号与 dollar-brace 都必须转义；改完先跑该文件对应的 rewrite 测试，再跑全量。

### 契约与参数台账（V13）
| id | 面 | 变更 | 旧响应差异 | 回滚 |
| --- | --- | --- | --- | --- |
| V13-3 | 内部 API | `shouldRecordMoodDecay` 三参；删除 `MOOD_DECAY_EPSILON`/`moodDecayThreshold`；新增 `MOOD_DECAY_BUCKET=0.01`/`MOOD_DECAY_EVENT_DELTA=0.02` | 无 HTTP 字段变化；`soul_mood_events` 的 decay 行数变少（单次衰减 ≤ 100 条） | 恢复旧常量即回到每 tick 一条（不推荐） |
| V13-4 | 内部 API | 新增 `BASELINE_EMA_REF_HOURS`、`baselineEmaAlpha(dtHours)` | `integrateMood` 的 baseline 推进量改为按墙钟；参考节拍结果不变 | 把 `emaAlpha` 换回 `BASELINE_EMA_ALPHA` |
| V13-5 | 内部模块 | 新增 `persona-limits.ts`（`PERSONA_SECTION_MAX_CHARS`、`clampPersonaSections`） | 超过 100/400 字的场景段会被截断（注入文本可能变短） | 删除调用点 |
| V13-6 | 文档 | `scene-extraction.ts` 长度预算文案与 §5.19 台账 | 无 HTTP 差异 | 文案回滚 |

### 生产只读读数（2026-11-19 04:1x，agent agt-2m7buribzz）
- 快照最新 v1157；`content_hash` 在 v>1140 里仍两值交替（旧 bundle 振荡写），卡 v1157 identity 698 字 vs 快照 568 字 = dirty。
- `soul_gate_stats` 近 24h 仍是 identity 三码（episode/dilemma/stance_missing）居前，`prefilter%` 计数仍为空 → 预过滤代码未部署。
- 人格层 voice 13 行仍全 degraded（lastEvidenceAt 语义修复未部署）；human 账本 update/invalidate 的 before_json 仍全 NULL。
- 契约断言 29 通过 / 0 失败 / 1 待部署（snapshot.traits）；ghost 租户全 0。

### 5.20 Round14：零字节绑定不再算注入成功，调节只记「进入调节」

**零字节绑定（A4 CP1）。** 生产 3543 条 `card-bound` 里 3343 条 `chars=0`：Core 回空卡（或只剩中段块）时，`persona-card.ts` 的 bindOnce 走「这个 agent 没有卡」分支，清会话后又写了一条 `card-bound chars=0`。stats 只按事件名聚合，于是「什么都没进提示词」= 注入成功。Round14 改为：

- 该分支只写新事件 `card-empty`（`dsh-plugin/src/injection-log.ts` 的 `InjectionEventKind` 新增），`chars` 字段保留但恒 0，便于与 card-bound 用同一读取器；
- 同时 `reportInjection({ failReason: 'empty', sessionId })`，Core 端 `failReasons.empty` 桶可见；
- `card-bound` 只在真的有两段文本时写。stats 的 `plugin.cardBound` 因此不再被空卡抬高，空卡落在 `failReasons.empty`。

**调节只记进入（A2 CP2d）。** `regulateMood` 每 tick 只要 `applied` 就写一条 `regulation` 账本行；|dev| 持续 >0.35 时一个 24-tick 会话能写 24 行。Round14 改为「上一轮 |dev| 还在触发线以下、这一轮才越过」才落账：

```ts
const applied = regulateMood(...);
// 上一轮的 |dev|（valence/arousal 分别减基线，取大者）与这一轮的 |dev|：
// 只有「这一轮越过触发线、且上一轮还在触发线以下」才算进入调节，不是每 tick 记一行。
const prevRegDev = Math.max(
  Math.abs(prevVec.valence - prevBaseline.valence),
  Math.abs(prevVec.arousal - prevBaseline.arousal),
);
const curRegDev = Math.max(
  Math.abs(nudged.valence - curBaseline.valence),
  Math.abs(nudged.arousal - curBaseline.arousal),
);
if (applied && isMoodRegulationEntry(prevRegDev, curRegDev)) { /* 落账 */ }
```

`MOOD_REGULATION_TRIGGER = 0.35`（`MemoryCore/src/core/soul/emotion.ts`（grep `MOOD_REGULATION_TRIGGER`）），与 `decay`/三条腿判据分开：decay 记「可见的衰减事件」，regulation 记「进入调节的时刻」。

**Round21 纠一处判据错（r73-a2b）。** 上一版用「上一 tick 的 |dev| 已回落」当重入条件，下限取 `MOOD_REGULATION_EXIT = 0.25`；仿真证明它在真实路径里**几乎不可达**——情绪先验权重约 0.9976，单 tick 只把 |dev| 拉回很小一截，实测穿越点 `prev=0.293 → cur=0.435` 时 `0.293 < 0.25` 为假，于是 36 tick 一次都不记（`rowsNew=0`，而旧写法记 1 行）。现改为**滞回带宽**：`isMoodRegulationEntry(prev, next, {trigger, hysteresis})` 返回 `next >= trigger && prev < max(0, trigger - hysteresis)`，带宽默认 `MOOD_REGULATION_HYSTERESIS = 0.05`，即下限 0.30。这样 0.293→0.435 记一次，0.34 附近抖动仍不记（滞回仍然存在）。

**测试。** `dsh-plugin/test/persona-card.test.ts` ⑥e（reports 恰为 `[{failReason:'empty',sessionId:'a1'}]`、有 card-empty、无 card-bound）与旧「empty 算成功」用例改断言 card-empty；`MemoryCore/src/core/soul/__tests__/p5-mood-e2e.test.ts` 24-tick 用例新增 `regulation` 行数 ∈[1,1]。实跑：plugin 47 files / 840 tests；Core `src/core/soul` 78 files / 733 tests；全量 481 files / 4484 tests。

**台账。**

| 编号 | 位置 | 变更 | 旧响应差异 | 回滚 |
| --- | --- | --- | --- | --- |
| V14-1 | `dsh-plugin/src/injection-log.ts` / `persona-card.ts` | `InjectionEventKind` 新增 `card-empty`（插件本地日志） | 无——core 收到的仍是既有字段，只是原来记成 `card-bound chars=0` 的空卡改成 `card-empty` + `failReason:'empty'`；旧日志读取器按事件名白名单过滤会忽略新事件 | 把空卡分支改回 `reportCard(chars=0)` 并删掉 `card-empty` 枚举 |
| V14-2 | `POST /v3/soul/injection` 的 `failReason` 白名单 | 本已含 `empty`，本轮只是第一次真的会发它 | 无（字段与枚举都不变） | 不适用（未改白名单） |
| V14-3 | `MemoryCore/src/core/soul/worker.ts` / `emotion.ts` | `MOOD_REGULATION_TRIGGER` 语义由「触发线的绝对值」收紧为「越过触发线的那一 tick」 | 无 HTTP 变化；`soul_mood_events.regulation` 行数从「每 tick 一条」变为「每次进入调节一条」，`GET /v3/soul/stats` 的事件计数随之下降 | 把落账条件改回 `applied` 即恢复每 tick 一条（会回到被判 FAIL 的形状，不推荐） |

**已知限制（usage 重试窗口）。** `reportPersonaUsage` 只在 L0 写回成功的分支里调用（`dsh-plugin/src/index.ts:1796`；定义在 `:620`），而「同回合重复收口」在 `writeback.ts` 就被去重、不会再走到这里。所以：Core 拒绝 usage 时本轮不会记「已上报」（正确），但**同一回合也不会自动重发**——下一回合是新 `turnId`、本来就是新键。想要「失败补投」需要独立的重试队列——§5.21 已补上（下一回合收口先补投一条最旧失败记录）；仍然不要把它误读成「同一回合会重试」。

**复核口径（本轮起明确）。** 冷启动复核判的是仓库 HEAD 的代码与本地临时库行为；线上进程（`D:/TDB/data`，旧 bundle）的差异单列「P0 部署观察」，不冒充代码判据。这样做的代价是：部署前不能声称线上已生效，报告里必须把「代码闭环 / 线上未部署」分开写。

## 5.21 Round15：usage 写照的有界补投队列

**为什么现在做。** §5.20 记的限制是「同一 `turnId` 没有第二次机会」：Core 拒绝一次，这条写照就永久丢了。它不是可以靠「下一回合」自愈的——下一回合是新键。补投必须自己带队列。

**实现。** 队列单独成文件，因为「满了丢最旧」这条只有直接单测才测得起（驱动 33 个回合要 30 秒以上）：

```ts
// dsh-plugin/src/usage-retry.ts
export class UsageRetryQueue<T> {
  enqueue(key: string, value: T): void {
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;   // 满员先丢最旧
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);                        // 同 key 只留一份，位置不变
  }
  oldest(): [string, T] | undefined { return this.map.entries().next().value; }
}
```

`dsh-plugin/src/index.ts` 里 `USAGE_RETRY_MAX = 32`，每次收口**最多补投一条**最旧失败记录，然后再发本回合自己那条（补投不叠加，坏 Core 不会让每回合变成 N 次请求）。

**两处实测出来的错。**

1. **先发后出队 → 同一轮被补投两次。** 第一版在发送前还留着队里的旧条目，成功后删的是「刚发出去的 key」，但下一次收口读到的仍是最旧那条 —— 实测调用序列是 `[1,1,2,1,3]`（第 3 回合又补了一次第 1 回合）。改成发送前先 `delete`，失败由 `sendUsage` 重新入队，序列才变成 `[1,1,2,3]`。
2. **`oldest()` 的返回形状与调用方不一致 → 一次都不发。** 中间版本让 `oldest()` 返回 `iterator.next()` 的 `{value,done}`，调用方却写成 `[key, value] = nextRetry.value` + `if (!nextRetry.done)`，空队列时 `undefined.done` 抛错，被外层 `try/catch` 静默吞掉：usage 一条都不上报，测试报「第一次调用 0 条」。教训：把「有没有下一条」编码进返回类型（`[key, T] | undefined`），不要同时用 `done` 和 `undefined` 两套语义。

**测试夹具的坑。** `dsh-plugin/test/helpers/core-fixtures.ts` 原本没有 `/v3/soul/injection` 分支，fallback 返回纯文本 `ok`，客户端 `JSON.parse` 失败 → `reportSoulInjection` **永远** `ok=false`。于是「失败补投」的另一半（补投成功要出队）根本测不到，所有断言都是在失败分支里自洽。已补 `envelope({ ok: true })`。

**测试。** `dsh-plugin/test/usage-retry.test.ts` 3 条（FIFO 且同 key 只留一份、40 条入 32 上限丢最旧、非法上限拒绝构造）；`dsh-plugin/test/index.test.ts`「A4 Round15：usage 失败进补投队列…」断言 `[1,1,2]` → `[1,1,2,3]`。实跑：`npx vitest run test/usage-retry.test.ts test/index.test.ts` → 2 files / 86 tests passed；`npx tsc --noEmit` EXIT=0。

**编号说明。** §5.1–§5.3、§5.17–§5.18 在本仓库历史里从未分配（相关内容写在相邻小节，断号不是内容丢失；§5.16 在 `### 5.16` 有独立标题）。台账 V11 表已整并入 §5.16 的 V12 表（表头在 `:425`）、V13-1/V13-2 在 §5.16 尾部（`:483-484`）、V13-3..V13-6 在 §5.19 表内（表头 `:509`），V14-1..V14-3 与 V15-1..V15-2 各在自己的小节；正文引用一律用现行编号（V12-* / V13-1..V13-6 / V14-1..V14-3 / V15-1..V15-2）。

**台账。** V15-1：新增内部模块 `dsh-plugin/src/usage-retry.ts`（无 HTTP 契约变化）。**旧响应差异**：无（纯插件内部队列）；**回滚**：删除该文件与 `index.ts` 的 `new UsageRetryQueue(...)`，或把 `USAGE_RETRY_MAX` 设为 0 前一版语义（失败即丢）——注意 0 会被构造器拒绝，回滚需删调用点。V15-2：`POST /v3/soul/injection` 无字段变化，只是失败后**同一轮**的写照可能在下一回合被补投一次（同一 `turnId` 的 `sessionKey/turn` 原样重发，Core 侧 `reserve` 幂等语义不变）。**旧响应差异**：无——请求体与响应体字段完全不变，唯一变化是同一 `(sessionKey,turn)` 可能出现 2 次 POST（首次失败 + 补投），Core 已按 `reserve` 幂等处理，重复投递返回 `logged:false`。**回滚**：删除 `usage-retry.ts` 与 `index.ts` 的 `queueUsageRetry/oldest` 分支，即回到「失败即丢弃」；无存储迁移、无需重启 Core。

**仍然没做。** 补投只在「有下一回合且 L0 成功」时推进；纯失败会话（进程被杀）里队列随进程消失。上限 32 条、丢最旧，丢的是最老的观测，不是最近的。
## 5.22 Round16：写入时刻未知时不再二次衰减

**问题。** `card-v13.ts` 的回退情绪（`structuredMood === null` 时用 `soul_state.emotionLabel/emotionIntensity/emotionAt`）在缺 `emotionWrittenAt` 时把 `asOf` 退成 `emotionAt`。但强度是**落库那一刻**写的（`worker.ts:2774` 每 tick 写 `now`），再拿事件时刻当「已衰减到此刻」就会把同一段衰减算两遍——情绪被提前判死，卡上「心里那点X还在」消失。

**修法（`MemoryCore/src/core/soul/card-v13.ts`）。** 写入时刻未知就只信强度门，不再做年龄/衰减推算：

```ts
const fallbackWrittenAt = String(input.mood?.emotionWrittenAt ?? "");
const fallbackStale =
  structuredMood === null &&
  input.mood?.emotionAt !== undefined &&
  input.mood?.emotionIntensity !== undefined &&
  (Number(input.mood.emotionIntensity) <= 0.01 ||
    (fallbackWrittenAt !== "" && isStoredEmotionExpired({ label, intensity, at: emotionAt, asOf: fallbackWrittenAt }, renderNow)));
```

取舍：宁可多留一条低强度情绪，也不把「他刚说过的话」判成过期；强度门仍然生效，完全消退（≤0.01）一律不写。

**反证。** 把 `fallbackWrittenAt` 临时改回 `?? input.mood.emotionAt` 再跑 `card-v13.test.ts`：`FAIL … 事件在很久以前、强度 0.5、没有 emotionWrittenAt → 仍写「心里那点不安还在」`，`Tests 1 failed | 10 passed`；改回后 `11 passed`。

**测试。** `MemoryCore/src/core/soul/__tests__/card-v13.test.ts` 新增 2 条：无 `emotionWrittenAt` + 强度 0.5 → 仍写；强度 0.005 → 不写。

**台账。**

| 编号 | 位置 | 变更 | 旧响应差异 | 回滚 |
| --- | --- | --- | --- | --- |
| V16-1 | `MemoryCore/src/core/soul/card-v13.ts` 回退情绪过期判据 | 缺 `emotionWrittenAt` 时只按强度门判过期 | 无 HTTP 字段变化；`GET /v3/soul/card` 正文可能多出「心里那点X还在」一句（旧实现会漏），`text/hash/chars` 随之变化 | 把 `fallbackWrittenAt` 改回 `?? input.mood.emotionAt`（会重新引入二次衰减） |

## 5.23 Round17：标签净增长的真实读数（B9）

B9 在 41 用例矩阵里长期是「未验证」，因为矩阵只看一层导出（24 类只命中 7），看不出「标签到底长没长」。
本轮加了一个只读读数脚本，直接回答这个问题：

```bash
cd MemoryCore
node scripts/trait-label-growth.mjs --db D:/TDB/data/vectors.db --team <team>
```

它输出 `label.byStatus` / `label.nonSeed` / `gate.labelCodes` / `ledger.traitActions` / `traitState` /
`episodes`，并给出 `verdict`：有非 seed 标签 → `grown`；全 seed 但有 `label_*` 门拒计数 →
`produced-but-rejected`；两者都没有 → `no-proposal`。

### 实跑读数（2026-11-19 05:5x）

| 库 | label.byStatus | nonSeed | gate.labelCodes | traitState | episodes / 带立场 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 91 天回放 `soul-ft-harness-0GCnXW` | seed 18 | 0 | 0 | 1 行 / 2026-08-10 | 99 / 72 | `no-proposal` |
| 生产 `D:/TDB/data`（team-2k12lgb650，只读） | seed 18 + **admitted 2** | 2 | **0**（旧构建未部署本轮的拒收计数） | 9 行 / 2026-11-18 | 317 / 292 | `grown` |

生产的两个非种子标签（下表 `drift 50` 是 `entry_id LIKE '%trait%'` 的过滤值，全库 drift 账本共 922 行；`traitState 9 行` 是全库行数，不是单租户）：`先验后报`（first_seen 2026-11-10T00:22:57.726Z，last_seen 2026-11-17T13:02:22.293Z）、
`先报后收`（2026-11-09T19:32:36.269Z）。账本里对应的是 `drift` 50 行与 `trait_normalized` 3 行。

### 判读（区分「证据不够」与「代码不产」）

- 生产 9 天长出 2 条标签 → **代码能产**，不是死路径。
- 回放库 0 条且 `gate.labelCodes` 为空 → 回放语料**没产票**：`MemoryCore/scripts/soul-fulltest-replay.mjs:154-165` 根本没传 `traitJudge`，
  `worker.ts:1577-1578` 无判侧即整段跳过、`:1654` 记 `traitSkipped=no_trait_judge` —— 不是「stub 返回空提案」。
  这是 fixture 的能力边界，不能拿它当「代码不产」的证据。
- 增长慢是真的：9 天 2 条，远低于「24 类都长过」。原因在 `resolveLabelProposals`：
  提案需 `evidenceIds ≥ 3`（`minEvidence` 默认 3），且与既有/种子标签余弦 ≥ `TRAIT_LABEL_MERGE_SIM`
  就并入而不是新增（`MemoryCore/src/core/soul/trait-drift.ts:283-334`）。「先验后报/先报后收」都是与 18 条种子都不同的方向才站住。

### 本轮补的可观测性（V17-1）

问题：`lab.rejected` 只进 `report.trait.labels.rejected`，落不了库——事后无法区分「判侧没产票」与「产了被
`insufficient_evidence` 挡下」。修法：拒收与候选拒收同口径，按 `(day, code, layer)` 聚合进
`soul_gate_stats`，`code = label_<reason>`（`MemoryCore/src/core/soul/worker.ts` 的 `resolveLabelProposals` 之后，Round18 行号 1629-1642）。
测试 `MemoryCore/src/core/soul/__tests__/soul-trait-worker.test.ts` 的「净票 ≥2 …」用例断言
`bumpSoulGateStats` 收到 `[{ day, code: "label_insufficient_evidence", layer: "identity", count: 1, at }]`。

- **旧响应差异**：无。/v3/soul/* 端点字段未变；`soul_gate_stats` 多出 `label_*` 行。
- **回滚**：删掉 worker 里那段 `bumpSoulGateStats` 调用即可；`report.trait.labels` 本来就是既有字段。

### 仍未闭环
- 矩阵 B9 的表名笔误本轮已修（V17-2）：`MemoryCore/scripts/soul-fulltest-matrix.mjs:66` 原来读 `soul_trait_labels`（复数、不存在），
  `all()` 吞异常后恒得 0；改为 `soul_trait_label`，非种子判定从 `is_seed` 改为 `status !== "seed"`（新列是 status）。
  B9 的结论仍是「未验证」——回放库 18 条全是种子、0 条非种子；修的是读法，不是判据。
- 「标签净增长」不等于 B9 闭环：B9 要的是「随经历长出新类」，本轮只证明了生产能长 2 条、回放不长。

### 台账 V17-2（矩阵 B9 读数修正）

- **改了什么**：`soul-fulltest-matrix.mjs` 的标签表名与种子判定（见上）。
- **旧读数差异**：矩阵 B9 证据行由「`soul_trait_labels=0`」变为「`soul_trait_label=18，非种子 0`」；PASS/未验证 计数不变（33/8/0）。
- **回滚**：改回旧表名即恢复旧读数（但仍是错的读数）。


- 生产 `gate.labelCodes` 为空是**未部署**（网关进程起于修复之前），不是「没有拒收」。
- 回放 fixture 不产标签提案 → B9 的回放侧证据仍然缺；要用生产读数代理，并如实标注。
- 标签只增不减：没有任何「标签退役」路径，长跑后 `admitted` 会累积。

## 5.24 Round18：标签退役（dormant 第一次有写入点）

Round17 复核记录：「`soul_trait_label` 无退役路径，类型里有 `dormant` 但全仓无写入点，`admitted` 会无界累积」。
本轮补上写侧。

### 规则

- 自生长标签（`status = "admitted"`）超过 **60 天**没被任何提案命中 → `dormant`。
- 不删行：`direction` / `evidence` / `firstSeen` 原样保留，读侧本来就过滤 `dormant`
  （`MemoryCore/src/core/soul/traits.ts` 的 projectLabels、`MemoryCore/src/gateway/soul-card-endpoint.ts` 的自生长标签过滤）。
- 复活：`resolveLabelProposals` 合并到 dormant 行时把 `status` 改回 `admitted`（`MemoryCore/src/core/soul/trait-drift.ts` merged 分支），不新增行。
- 种子标签不参与：`status === "seed"` 永远保持。

```ts
export const TRAIT_LABEL_RETIRE_DAYS = 60;

export function planStaleLabels(labels, now, opts = {}) {
  const idleDays = opts.idleDays ?? TRAIT_LABEL_RETIRE_DAYS;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || idleDays <= 0) return [];
  const idleMs = idleDays * 86_400_000;
  return labels.filter((row) => {
    if (row.status !== "admitted") return false;
    const seenMs = Date.parse(row.lastSeen);
    return Number.isFinite(seenMs) && nowMs - seenMs > idleMs;
  }).map((row) => ({ ...row, status: "dormant" }));
}
```

接线在 `MemoryCore/src/core/soul/worker.ts` 的标签段：种子补齐之后、判侧之前跑一次；有写入器才跑；
写回后同步内存里的 status，避免同 tick 投影仍读旧值。

**为什么排在判侧之前**：同一 tick 里判侧提案可能命中刚退役的标签，先退后判就能在同轮复活（一次写 + 一次写），
顺序反过来要在内存里手工同步 `lastSeen`，更容易漏。

**不整行覆盖**：`soul_trait_label` 按 `(tenant_id, label)` 存、同队多个 agent 共享。
退役走新增的条件写 `store.dormantSoulTraitLabels(tenant, labels, { now, idleDays })`：

```sql
UPDATE soul_trait_label SET status = 'dormant'
 WHERE tenant_id = ? AND label = ? AND status = 'admitted' AND last_seen < ?
```

返回值是**真正改了几行**（不是入参条数），第二次调用得 0。这样别的 agent 刚复活的同一行不会被本次退役
改回 dormant，也不会被倒退 `last_seen`。没有该方法的老 store（测试 fixture）退回 `commitSoulTraitLabels` 整行写。

**部署要求**：`dsh-plugin/dist` 必须跟着重建。本轮复核曾因 `src/usage-retry.ts`（05:09）晚于旧 dist（04:51）
判 CP2 FAIL——src 有有界补投、运行时没有。重建后 dist 与 src 文件集一致，`node --check` 通过。

### 参数台账（V18-1）

| 键 | 旧 | 新 | 为什么 |
| --- | --- | --- | --- |
| `TRAIT_LABEL_DORMANT_ACT` | 0.3 | **删除** | 全仓零引用，留着会让读者以为有按 act 退役的路径 |
| `TRAIT_LABEL_DORMANT_DAYS` | 7 | **删除** | 同上；7 天对「9 天只长 2 条」的节奏过激，会把刚长出的标签退掉 |
| `TRAIT_LABEL_RETIRE_DAYS` | — | 60 | 新键；生产 admitted 2 条 lastSeen 11-09/11-17，上线即退 0 条 |

### 测试

- `MemoryCore/src/core/soul/__tests__/trait-label-retire.test.ts`（4 条）：恰好 60 天不退、第 60 天零 1 秒才退；种子/已 dormant 不动；阈值可调与坏时间戳不动；dormant 被同标签提案命中即回 `admitted`。
- `MemoryCore/src/core/store/__tests__/soul-trait-label-dormant.test.ts`（3 条）：条件写只退过期 admitted、幂等；**别的 agent 刚复活的行不被覆盖**；坏时间/空列表不动。
- `MemoryCore/src/core/soul/__tests__/soul-trait-worker.test.ts`「长期没被提案命中的标签在维护轮里退役（Round18）」：同一轮里只退旧标签、保留方向与证据；「走条件写分支」断言 `dormantCalls` 收到标签名、`report.labelsRetired===1`、退役行不再走整行 commit。

### 契约

`/v3/soul/*` 字段/状态码未新增；`soul_trait_label.status` 多出 `dormant` 取值（读侧早已支持）。

| 台账 | 变更 | 用途 | 旧行为差异 | 回滚 |
| --- | --- | --- | --- | --- |
| V18-2 | store 新增可选方法 `dormantSoulTraitLabels`（条件 UPDATE） | 退役只改 status 且不覆盖同队别人的写 | 旧路径（整行 upsert）会把刚复活的 status 改回 dormant | 删方法 + worker 退回 `commitSoulTraitLabels` |
| V18-3 | `SoulWorkerReport.labelsRetired`（可选数字） | 维护轮回报里能读到本轮退了几条（原来只有日志） | 无（新字段，旧读者忽略） | 删字段与赋值 |

回滚：删掉 worker 里的 `planStaleLabels` 调用块与 `TRAIT_LABEL_RETIRE_DAYS`，已退的行把 status 改回 `admitted`。

### 仍存在

- 退役只看 `lastSeen`：只要偶尔被同义提案命中就一直活着，哪怕它早已不代表现在的行为。「按 act 退役」需要先定义 act 时间窗（旧 `TRAIT_LABEL_DORMANT_ACT` 就是没想清才死在那）。
- ~~没有查询出口~~：Round19 起有只读读面 `GET /v3/soul/labels`（见 §5.25）；`report.labelsRetired` 仍只在维护轮返回值里。
- 生产未部署，「上线后退多少条」只能按 lastSeen 推算：本轮实测 admitted 2 条，空闲 9.13 天（先报后收，lastSeen 2026-11-09T19:32:36Z → 11-18T22:36Z）/1.40 天（先验后报，lastSeen 2026-11-17T13:02:22Z → 同一时刻），都远小于 60 → 上线即退 0 条。

### 5.25 Round19：标签读面 `GET /v3/soul/labels`

**动机**：§5.24 的「仍存在」第二条——标签退役后没有只读出口，只能查库或翻 worker 日志。本轮允许改 `/v3/soul/*` 契约（每次改动进台账），因此直接新增一个读面，而不是让面板去连库。

**契约（新增，不向后兼容）**

```
GET /v3/soul/labels?team=&user=&agent=[&includeDormant=1|true]
200 { code: 0, data: {
      labels: [{ label, status, definition, evidence, firstSeen, lastSeen }],
      counts: { seed, admitted, dormant },
      includeDormant: boolean } }
503 { code: 503, message: "soul_labels_unavailable" }   // store 未就绪
503 { code: 503, message: "soul_labels_failed" }        // 读 store 抛错（Round20 起真实可达：sqlite.ts 记日志后 throw）
```

- **缺省过滤 `dormant`**（面板看「现在有什么标签」），`counts` 始终按全量统计——退役多少条不靠标签数组长度猜。
- `?includeDormant=1|true`（大小写不敏感）才把退役行带出来，用于审计「这条为什么退、最后见于何时」。
- 只接 `GET` 且只认自己的路径；其他方法/路径返回 `false`，由 `server.ts` 继续匹配。
- store 没有 `listSoulTraitLabels`（旧后端）时返回 200 空表 + 计数全 0，不 503——读面缺失与「方法在、读抛错」是两件事。Round20 起 `listSoulTraitLabels` 不再吞查询错误（`sqlite.ts` catch 里记日志后 `throw`），所以读真库出错时 `/v3/soul/labels` 回 503 `soul_labels_failed`。**副作用已处理**：`/v3/soul/card` 对同一方法 fail-open（`card-service.ts` try/catch → 空标签表），否则标签表缺失会让卡整体 503；`/labels` 与 `/card` 的失败语义因此不同，是有意的。

**代码**：`MemoryCore/src/gateway/soul-card-endpoint.ts` 的 `handleSoulLabelsRoute`；`MemoryCore/src/gateway/server.ts` 的 GET 白名单加 `/v3/soul/labels`，在 `handleSoulPersonSearchRoute` 之后、`handleSoulCardRoute` 之前调用。

**测试**：`MemoryCore/src/gateway/__tests__/soul-labels-endpoint.test.ts`（6 条：4 条契约 + 1 条接线守卫 + 1 条守卫的守卫/反证）——缺省过滤 dormant 但 counts 全量（labels `["严谨","先验后报"]`、counts `{seed:1,admitted:1,dormant:1}`、单行六字段逐字相等）；`includeDormant=1` 带回退役行；store 未就绪 503 `soul_labels_unavailable`、读抛错 503 `soul_labels_failed`（不拿空表冒充成功）；只接 GET 与自己的路径、store 缺方法 200 空表。

**生产读数（只读，2026-11-19 06:2x–06:3x）**

1. HTTP 侧：`curl http://127.0.0.1:8420/v3/soul/labels?...` → **401 `{"code":401,"message":"Unauthorized: missing Bearer token"}`**；同一时刻 `/v3/soul/trait-state` 也是 401。鉴权在路由之前，所以**无法用 HTTP 证明生产是否已部署该路由**——只能记「生产未部署/不可验证」，不能写成「生产已支持」。
2. 数据侧（不依赖鉴权）：`soul-contract-assert.mjs` 用只读快照副本直接调 `handleSoulLabelsRoute`，对生产数据实跑得 `labels.counts={seed:18,admitted:2,dormant:0}`、缺省 20 行全部非 dormant、`includeDormant=1` 仍 20 行（`status` 的 `proposed` 也在 counts 里计名——**A1 Round19 指出的隐身行已修**；两条 admitted 的 `lastSeen` 分别 11-09/11-17，距 60 天阈值还很远，上线即退 0 条与 §5.24 推算一致）。契约断言随之 **30 → 36 条**（+6 全部是 labels：http/counts/countsCoversStatuses/defaultExcludesDormant/fields/includeDormant；`stats.testExcludedByDefault` 原已计条，本轮只把「窗口内无 test 行」从假通过改成待部署）；实跑 **35 通过 / 0 失败 / 1 待部署（snapshot.traits）**。

**契约变更台账**

| 台账 | 端点 | 变更 | 用途 | 旧响应下的行为差异 | 回滚 |
| --- | --- | --- | --- | --- | --- |
| V19-2 | `GET /v3/soul/labels` 的租户口径 | 端点收 `team/user/agent`，但 `listSoulTraitLabels` 只按 `tenant_id` 过滤（`sqlite.ts:3970-3981`）——**是团队级读面，不是三元组级** | 文档此前默认「租户=team/user/agent」，会让读面看起来比实际更细 | 回滚：无代码改动；要真做三元组需给 `soul_trait_label` 加列并迁移 |
| V19-1 | `GET /v3/soul/labels` | **新增端点** + 三个字段组（labels / counts / includeDormant）+ 两个 503 码 | 标签有只读出口：净增长、退役、最后证据时间都能查 | 旧构建没有该路径（路由白名单不含它，落到 404/上游鉴权）；新端点在旧客户端眼里是新路径，不改变任何既有响应 | 删 `server.ts` 白名单一行 + 删 `handleSoulLabelsRoute` 与测试文件；无数据迁移 |

**仍存在（Round19 五路复核指出、本轮不修）**：① 输出门 `soul_gate_log` 的 shadow 决策恒 `allow`（`value-gate.ts:351-361`），`ask`/`rewrite` 只作为 would-be 落在 reason 前缀里，从未执行——这是 shadow-only 的设计，README/本手册 §5.11 已写明，本轮无法把它当「已生效」；② 报告失败只 `warnOnce`、不进队列（`index.ts:690-701`），进程重启即丢，影响=少一行 shadow 台账、不影响回合；替代控制=同一键 `gateReported` 去重 + `soul_gate_log` 现有 501 行；③ `stats.usage` 生产 0 行、recall 日志无 `usage` 事件——补投队列只有单测证据，未在真流量里观测到成功入账；④ 插件 dist 与宿主进程启动时间谁新谁旧决定是否加载新代码，本轮生产宿主早于 dist（06:18），属部署缺口。只回 `label/status/definition/evidence/firstSeen/lastSeen`，不回 `aliases`/`direction`/`anchor`（面板暂时不需要，方向向量要单独设计成紧凑格式）；没有分页，单租户标签是 18 种子 + 个位数 admitted，量级不构成问题。

### 5.26 Round19 复核后的三处修复（工作区，未部署）

1. **老化钟不再被复活归零**（r45-a1 CP2）：`planRevive` 不再写 `lastEvidenceAt=now`（`persona.ts:300-312`），`worker.ts:2399` 改用 `prev.lastEvidenceAt` 作基准再 `advanceEvidenceClock`。回归：`soul-persona.test.ts` 「复活不把证据时间改写成现在」。
2. **被取代行不再被 freeze/merge 改写失效时刻**（r45-a1 CP3 窄残留）：`freezeItem` 保留已有 `validTo`（`persona.ts:295-300`），`planMerge` 跳过 `validTo` 非空行（`:162-164`）。回归：「冻结已被取代的行不改写原 validTo」。
3. **L2 游标遇任何失败组就停住**（r46-a3/r50-a3 CP5）：原实现取全窗口最大 `updatedAt`，失败组那批行会永久落在 `updated_time > cursor` 之外；只取「成功组最大值」仍不够（跨组时间戳交错，成功组的更晚时间会跨过失败组的更早行）。新增 `l2NextCursor({cursor,successRows,fallbackRows,hadFailure})`（`pipeline-factory.ts`）：只要有组失败（`extractResult.success && memoriesProcessed>0` 不成立，含毒批半失败）就原样返回旧 cursor（首次全量返回空串 → 下轮仍全量），**不取任何最大值**。测试 `src/utils/l2-cursor.test.ts` 4 条（失败组更晚/更早、首次+失败、无失败取 max），变异 M1 忽略 hadFailure、M2 取全窗口 max 都会红。**仍未修**：① 游标单键 `updated_time`，同毫秒并列行无法续读，复合键要迁移（P1）；② 4 条只测纯函数，删掉 runner 里的 `hadFailure=true` 不会红（runner 级失败组用例缺失，P2）；③ 失败轮返回 truthy 旧 cursor，manager 会当成功轮刷新 `l2_last_extraction_time`、清 pending、触发 L3；毒批永久失败时游标永久钉住、无退避/隔离，窗口无界增长（P2）。
4. **接线守卫可反证**（r47-a5 CP5）：`soul-labels-endpoint.test.ts` 改为先去注释再要求「白名单行 + `await handleSoulLabelsRoute(` 派发」同时存在，并带两条反证（注释白名单→`whitelist_missing`；删派发→`dispatch_missing`）。

## 5.27 Round20：L2 半失败不再冒充成功

**现象**：L2 抽取是「按会话分组循环」，任一组失败只 `continue`；只要其它组有成功，`processedTotal > 0`，于是 `l2_last_extraction_time` 被刷新、cursor 被推进（Round19 已让 cursor 在失败时钉住）、manager 还把这一轮记为成功并触发 L3。后果是失败那批行虽然还在窗口内，但时间门被这次半失败推后，且 L3 拿半成品人格去生成。

**改法（三处，缺一不可）**
1. `pipeline-factory.ts`：返回 `{ latestCursor, hadFailure: true }`；`l2_last_extraction_time` 的写入条件加 `&& !hadFailure`。
2. `pipeline-manager.ts` 的 `L2RunnerResult` 增加 `hadFailure`；`runL2` 的非成功分支单列一条 warn（cursor/时间戳/pending 都不动）。
3. `l2-gate.ts` 的 `decideL2PostRun`：`hadFailure === true` → `{recordSuccess:false, resetPending:false}`（与门拦下同族）。

**证据**
- `MemoryCore/src/core/scene/__tests__/l2-post-run.test.ts` T6（纯函数）；
- `MemoryCore/src/utils/pipeline-manager.l2-state.test.ts` T4（接线：时间戳/cursor/pending 逐位不动）；
- 变异：把 `hadFailure === true` 改成 `false &&` → 2 files / 2 failed；恢复后 2 files / 13 passed。

**仍未做（如实）**：毒批永久失败时 cursor 永久钉住、窗口无界增长，没有退避/隔离；manager 仍会 `settleL2Run` 计入速率窗口（这是「真的跑了」，口径不同，不算成功）。

### 5.27.1 另两处小修
- **`render` 进入受控枚举**：`soul-versioning.ts` 的 `SOUL_CHANGE_REASONS` 增加 `"render"`（卡渲染快照的 trigger）。旧行为：introspection 把它当自由文本丢弃，生产上每行快照都看不到 `reasonCode`。单测 `soul-introspect.test.ts` 的「未知自由文本」fixture 改用 `legacy-free-text`（不能再用 render，否则测的是另一件事）。
- **标签读失败不再伪装空表**：`sqlite.ts` 的 `listSoulTraitLabels` catch 里记日志后 `throw`，`/v3/soul/labels` 才能真的回 503 `soul_labels_failed`。旧行为：表读不了与「真的没有标签」在响应上完全一样。

### 5.27.2 Round20 复核后的两处收口（A4/A1）

1. **空卡不再撑破 stats 恒等式**（r60-a4 CP1）：插件对「两段都空」改记 `card-empty` 后，stats 只把 `card-bound`/`section-read`/`card-bound-failed` 分桶，`card-empty` 既不进 `cardBoundEmpty` 也不进任何桶，却仍被 `rows += 1` 计数 → `rows === sectionRead+cardBound+cardBoundEmpty+cardBoundFailed` 在生产一旦出现空卡就假。改法：`card-empty` 同时计入 `cardEmpty`（新字段）与 `cardBoundEmpty`（零字节语义），并把所有**非计账事件**（turn-append / bind-probe / card-inherited / turn-skip）单列到 `otherRows`、不再计入 `rows`。历史隐患：过去 `rows` 数所有带身份行，只因「只有计账事件会带 identity」这条偶然事实才恒等；现在等式由代码保证。测试：`soul-injection-stats-endpoint.test.ts` 新增一条（card-bound 600 + card-empty + turn-append + section-read → rows=3、cardBoundEmpty=1、cardEmpty=1、otherRows=1，并逐字断言等式）。
2. **带 validTo 的历史行不再进卡**（r60-a1 F1，Round21 a1 纠口径）：卡侧 `cardLinesFromItems` 过去只按 state 过滤，而读侧早已跳过 validTo。改法：`card-service.ts` 增加 `typeof i.validTo !== "string" || i.validTo.trim() === ""` 过滤（空白/空串视为无失效期，兼容复活分支 delete 与历史空串）。**读侧同步收口**（a1 Round21 CP2）：`soul-person-endpoint.ts` 的四处 `if (item.validTo) continue` 统一走 `isRetired(validTo)`（trim 后非空才算作废），否则纯空白 validTo 在卡侧保留、在读侧隐藏。**生产读数纠正**：2026-11-19 复核 human active 5 行中 0 行带 validTo（此前「5 条里 4 条」是旧读法，已改注释），本次是防回归而非线上已脏。测试：`card-service.test.ts`（有效 validTo 丢弃、空白保留、现行保留）+ `soul-person-endpoint.test.ts`（空白 validTo 仍现行）。

### 5.27.3 台账 V20
- **V20-1** 契约：无新增端点/字段；`GET /v3/soul/labels` 的 503 `soul_labels_failed` 从「只在假 store 可达」变为**真实可达**（存储层异常）。旧响应差异：以前同场景返回 200 空表。回滚：`listSoulTraitLabels` 的 `throw err` 改回 `return []`。
- **V20-2** 参数：无（`hadFailure` 是布尔信号，不是阈值）。
- **V20-3** 数据形状：`L2RunnerResult` 新增可选 `hadFailure`（内部类型，非 HTTP 契约）。
- **V20-4** 契约：`GET /v3/soul/injection/stats` 的 `plugin` 新增 `cardEmpty`（整数）与 `otherRows`（整数）。用途：空卡可单独观察，非计账事件不再污染 `rows`。旧响应差异：旧客户端读不到两个键；`rows` 的语义收紧为「只数四个计账事件」，同窗口下可能比旧值小（旧值含 turn-append 等带身份行，生产当前为 0 行，不受影响）。回滚：删两个字段与 bucketing 分支，`rows` 恢复全量计数。
- **V20-5** 行为：卡内容过滤掉 `validTo` 非空的行。旧响应差异：卡正文可能少掉若干条历史「近况」，text/hash/chars 随之变；不改变任何接口字段。回滚：删 `cardLinesFromItems` 里的 validTo filter。
- **V21-1** 行为（无字段变更）：读侧 `/v3/soul/person`、`/v3/soul/persons` 的 validTo 判定改为 trim 语义。旧响应差异：`validTo` 为纯空白的历史行以前被隐藏，现在视为现行而出现（生产 0 行，不受影响）。回滚：四处 `isRetired(...)` 改回 `if (x.validTo) continue`。
- **V21-2** 枚举：`SOUL_CHANGE_REASONS` 增加历史值 `card`（2026-11-19 实测 `soul_snapshots.trigger='card'` 3028 行，主 team 3025）。用途：`/v3/soul/introspect` 对旧行给出 reasonCode，不再静默丢弃。旧响应差异：旧快照行的 `reasonCode` 从缺省变为 `"card"`；新写入仍是 `"render"`。回滚：删该枚举项与测试数组同步项。

## 5.28 Round21：episode 事件源的 user-only 决策

`MemoryCore/src/core/soul/episode.ts:649-652` 的过滤是 Round3 阶段0 的显式决策，本轮（Round21）复核后**维持不变**，理由与代价写清如下——它不是「忘了放开」，而是有意的语义边界。

**为什么只取 user**：episode 建模的是「他做了什么 + 我怎么反应」。我自己的输出已经通过三条通道进入人格层：`agent_stance`（我当时的立场）、`voiceQuotes`（voice 层 few-shot 原话）、关系证据。若把 assistant 也当事件源，同一句「我改完了」会同时触发情绪评估、关系抽取与漂移候选——等于自己给自己发指令，且会让「我先说了什么」污染「他要求了什么」的归因。

**若将来要放开（产品级变更，须另立 ADR）**：① 先加开关（`episodeSourceRoles`，缺省 `["user"]`），不直接改行为；② 污染控制三件套——assistant 事件不得进入 `userStance`、不得作为 correction/commitment 的触发者、不得单独产生关系边（只能作为 `agentStance` 的补充证据）；③ 回滚方式=开关回 `["user"]`，事件表按 `source_role` 列可筛掉已写入的 assistant 行（新增列须迁移）。在 ADR 落地前不改。

**回归固化**：`soul-episode.test.ts` 新增两条——同一句话 `role:"user"` 产 1 条事件、`role:"assistant"` 产 0 条；assistant 的输出仍从 `voiceQuotes` 进入人格层（`episodes=0` 但 `voiceQuotes>=1`），证明是「换通道」而非丢弃。

**collective 跨人共性**：与 Round13 核验结论一致（读侧 `card-service.ts` 无主行 fail-closed 丢弃、写侧 human 单写者跳过无 person 行、闸门 `gates.ts` human 一律 `human_writer_removed`），本轮未发现新的跨人矛盾，不再改动。

**Round21 收口项（四项，其中 ③④ 的台账在 Round20 的 V20-4，见 §5.27.2，不要算成 Round21 新增接口变更）**：① 读侧 validTo 统一走 `isRetired()`（V21-1，Round21；Round20 只做了卡侧过滤，两处时间点不同不要混）；② `SOUL_CHANGE_REASONS` 增历史值 `card`（V21-2）；③ stats 的 `cardEmpty`/`otherRows`（V20-4，Round20 落代码，Round21 补 BFF 不补 0 与用例）；④ 面板零字节显示（`InjectionHealthBar.tsx`，i18n `soul.health.zeroByte`）。episode 行为本轮未变，只补测试与 §5.28 文档。

## 5.29 Round21 部署与部署后读数（2026-11-19）

本轮用户明确授权重启 tdb 服务，因此工作区代码第一次真正跑在生产上。Core 由 supervisor 以 `tsx src/gateway/server.ts` 直跑工作区 TS（不是 `dist/`），所以**重启即部署**——这也是此前「契约断言里有 1 项待部署、快照没有 traits」的根因。

**部署动作**：`curl -X POST -H "X-Tdb-Control: 1" http://127.0.0.1:8446/restart` → `{"ok":true,"accepted":true}`；控制面写原子命令文件，supervisor 下一 tick 执行。重启前用 `VACUUM INTO` 备份到 `D:/TDB/data/backups/pre-round21-2026-11-18T23-34-01-509Z.db`。

**结果**：`tdai-core` pid 16140（since 2026-11-19T07:39:33.8+08，restarts 1）、`tdai-knowledge` pid 41896、`tdai-panel` pid 43352，三者 `healthy`。

**冷启动约 3 分钟，别把它当启动失败**：重启后立刻 `curl /health` 返回 `000`，一度判「core 没起来」；实际是 L1 14030 行加载 + jieba 95ms + query-expand 2713ms + rerank 2850ms，日志 `Gateway listening` 出现在 07:42:28，最终 `/health` 200 `time=0.0036s`。判断顺序应为：`netstat` 端口是否 LISTENING → 进程命令行是否是新的 `tsx src/gateway/server.ts` → 日志里有没有 `Gateway listening` → 最后才 curl（超时给 ≥30s）。

**由「待部署」转「通过」的两项**

1. `snapshot.traits`：`soul_snapshots` id 5106–5110 的 `trigger="render"`，`payload_json` 里 `$.traits` 是 object、`$.traitLabels` 长度 5/2/5/1/0（bytes 3089–7306）；5105（07:36 旧码写入）`traits=null`。契约断言口径从「待部署 1」变为 **通过 36 / 失败 0 / 待部署 0**。
2. `soul_person.profile_record_id`：迁移已把列补上（`PRAGMA table_info` 实测存在），但 29 行该列全为空——列是给下一次画像蒸馏写水位用的，**「列已补」不等于「水位已写」**，本轮只能表述到前者。

**没有按预期闭环、必须如实说的两条**

1. **预过滤上线了，但「三码被压下来」没有分窗证据。** `prefilter_no_episode` 在 2026-11-18T23:44:17Z 首次出现（命中 1 次），证明新代码在跑；但同日 `episode_missing` / `dilemma_missing` / `stance_missing` 仍是 1932 / 1664 / 1653，且三者的 `last_at` 都是 23:44:27Z —— **晚于** `Gateway listening` 的 23:42:28，即部署后闸门仍在产出这三码。原因是预过滤只挡「`mineCandidates` 从单条 L1 逐句挖出、没有 episodeIds」的候选（`worker.ts` 里判 `prefilter_no_episode` 的那段，grep）；真实模型/身份候选仍带着 `ep-*` 声明进闸门，是否通过取决于 `countEpisodeEvidence` 能否解析到真实事件。`soul_gate_stats` 按 `(day,code,layer)` 聚合，无法把重启前 45 分钟与重启后切开；本轮 2.5 分钟采样 `delta=[]`（没有新 L1 → 没有候选）。要证明下降，得加 per-run 计数或等有新 episode 流入后做 delta 对比。
2. **情绪回滞逻辑在生产尚未执行过。** `soul_mood_events` 最新 `appraisal` 是 2026-11-18T08:42:38Z、`regulation` 是 09:32:31Z、`decay` 是 2026-11-10 —— 部署后 14 小时内没有新的情绪事件（情绪评估由新 episode 触发）。`isMoodRegulationEntry` 的滞回目前只有单测（`soul-mood-regulation-latch.test.ts` 6 条，含真实 `integrateMood`+`regulateMood` 36 tick 渐进升温）与回放库覆盖，**生产零样本**。另外：最初那版用的是「回落线 0.25」，r73-a2b 的保真仿真证明真实穿越点是 `prev=0.293 → cur=0.435`，`0.293 < 0.25` 为假 → 36 tick 一次都不记；现改为按触发线带宽（`MOOD_REGULATION_HYSTERESIS = 0.05`，下限 0.30）判定，见 §5.19。

**部署后验收（全部实跑，2026-11-19 08:04–08:05 最后一轮）**：契约断言 36 通过 / 0 失败 / 0 待部署；Core `486 files / 4526 tests`；`dsh-plugin` 48 files / 844 tests；`MemoryPanel` 38 files / 303 tests；`MemoryPanel/web npx tsc --noEmit` EXIT=0；`MemoryCore node scripts/typecheck-gate.mjs` PASS（121 errors / 23 files，基线 149/28，Δ=-28）；41 矩阵（带 `--db2`）33 PASS / 8 未验证 / 0 FAIL；`git diff --shortstat` **119 files, 8266 insertions(+), 1533 deletions(-)**（写完本节后重测：本节自身的行已计入；再改文档这个数会继续漂，别把它当契约值），`git status --porcelain | grep -c "^??"` = 82（HEAD 仍是 1739ee1，工作区未提交）。

**Round21 末轮（收到五路复核之后）改了什么**

| # | 位置 | 改法 | 为什么 |
| --- | --- | --- | --- |
| 1 | `MemoryCore/src/gateway/soul-person-endpoint.ts` | 新增 `isRetired(validTo)`（`trim()` 后非空才算作废），四处统一调用（human item / 关系度数 / persons 边 / person 字段） | r71-a1 CP2：卡侧 `card-service.ts` 已按 `trim` 判定，读侧仍是 `if (validTo)` 真值 → `validTo="  "` 时卡保留、读侧丢弃；纯空白行在生产为 0 行，属防回归 |
| 2 | `MemoryCore/src/core/hooks/soul-versioning.ts` | `SOUL_CHANGE_REASONS` 增历史值 `"card"`（新写入仍 `"render"`） | r71-a1 CP3：生产 `soul_snapshots.trigger` 是 `card` 3028 行，不在枚举 → `soul-introspect` 把旧行的 reasonCode 丢掉 |
| 3 | `MemoryCore/src/core/soul/emotion.ts` / `worker.ts` | `MOOD_REGULATION_EXIT`(0.25) → `MOOD_REGULATION_HYSTERESIS`(0.05)：`next >= trigger && prev < max(0, trigger - band)` | r73-a2b CP2：0.25 的下限在真实路径里不可达，穿越点 0.293 记不上；同时把 `worker.ts` 落账门的注释与判据对齐 |
| 4 | `MemoryPanel/web/src/pages/SoulPage/InjectionHealthBar.tsx` | 零字节徽标改为「键存在且 >0」才显示 | r73-a4b 残留②：旧 Core 没有 `cardEmpty` 键时，`?? 0` 会渲染出「其中空卡 0」这句无根据的话 |
| 5 | `MemoryCore/src/core/record/l1-writer.ts` | **撤回**「update/merge 复用内容键」分支，退回 `update/merge → generateMemoryId()` | r73-a3b CP2 反例：被取代行仍占内容键且 `valid_end` 非空，后续同内容 upsert 到它上面被 `COALESCE(NULLIF(excluded.valid_end,''),valid_end)` 钉死，两条都失效、**活性集归零**。宁可留重复（已知 P1），不许丢历史 |

**由此仍未闭环的（如实记）**

- 撤回第 5 项只回到 Round19 的形态：**「合并后的同一句事实各留一行」仍在**（生产 23 组/46 行完全重复，其中 4 组两条都 active）。要真正消重需要给 L1 加「按内容键找存活行 → 复用并保留 valid_end」的读路径，本轮没做。
- ~~`contentMemoryId` 的 `normalizeForId` 会删掉数字里的小数点~~ → **Round23 已修**（R23-2，见 §5.30）：数字之间的点用占位护住，`13.5 ≠ 135`；历史 `record_id` 不回填。
- 五路复核本轮**没有复投**：r71-a1 FAIL 4/5、r73-a2b FAIL 4/5、r73-a3b FAIL 4/5、r73-a4b PASS 5/5、r73-a5b FAIL 4/5 → 1 PASS / 4 FAIL，**未达 ≥4 PASS 门槛**。上表 5 项是本轮按复核意见落的修复，其中第 3、5 项会改变判据结果、第 1、2、4 项是文档/口径与显示；下一轮必须先按同角色复投确认这些修复站得住，再谈门槛。

**台账 V21-3（部署动作，不是接口变更）**

- 做了什么：把工作区（含 Round19–Round21 的 labels 端点、L2 半失败、stats 两字段、isRetired、card 枚举、card-filter validTo）通过重启部署到 `tdai-core`。接口面相对 Round19 台账（V19-1）无新增变更。
- 影响面：`/v3/soul/*` 全部开始走新码；快照开始写 `traits`/`traitLabels`；`soul_person` 多出 `profile_record_id` 列（空值）；`soul_gate_stats` 开始出现 `prefilter_*` 与 `label_*` 码。
- 回滚：没有自动回滚开关。要回退到部署前行为，只能 `git` 回退对应文件后再次 `/restart`；数据侧用重启前备份（`pre-round21-...db`）恢复，但会丢掉期间的注入/账本增量，代价写清，不做静默恢复。
- 仍存在：`/v3/soul/*` 对外仍需 Bearer（本轮所有只读读数都走库，不走 HTTP）；冷启动 3 分钟窗口内 8446 报 `/health` 000 属正常，监控若按 5s 判定会误报。

## 5.30 Round23：`stance_missing` / `dilemma_missing` / `episode_missing` 的真实来源

目标里点名「`stance_missing 14082` 这类门必须降下来或说清为什么不能降」。本轮把来源钉在代码上：**不是判据太严，是身份事实的出处 id 与闸门的 id 空间不匹配。**

**根因（代码可查，不是推断）**

- 闸门只认 `ep-*`：`gates.ts` 的 `countEpisodeEvidence(ids)` 用 `/^ep-[0-9a-z]+$/u` 过滤后数个数；门槛由 `evaluateCandidate` 里的 `const staircase = opts.layer === "identity" || opts.layer === "self";` 与 `const need = opts.layer === "narrative" || staircase ? 1 : Math.max(2, cfg.minEpisodeEvidence ?? 2);`（实测 `:786` 与 `:789`）决定：identity / self / narrative 需 1 条，其余层需 `max(2, minEpisodeEvidence)`。
- identity 事实的出处是 L1 id：`MemoryCore/src/core/lifecycle/identity-discovery.ts:140` `const sampleIds = sampleRows.map((r) => String((r as { record_id?: string }).record_id ?? ""))`、`:163-164` 把 `support` 索引映射成 `ids` 再填进 `evidenceIds`。`MemoryCore/src/core/soul/worker.ts:2212`（Round23 插入代码之后的行号；插入前是 2163）起那段 loop 早前把这些 id **原样** push 进 `candidates`，**连 `episodeIds` 字段都没有**（`git show HEAD:MemoryCore/src/core/soul/worker.ts` 的那段只 push `evidenceIds: ids`），也不经过结构预过滤（该预过滤只作用于 `mined`）。所以闸门读到的是 `undefined` 而不是「一串 L1 id 被正则逐条拒」——结论一样（`have=0` 必挂），但描述要准确。行号会随改动漂，定位请用 `if (deps.identityFacts)` 与 `bumpPrefilter(` 字符串。
- 于是每条身份事实进闸门时 `have = 0` → 必挂 `episode_missing`；文本是描述句 → 再挂 `dilemma_missing` / `stance_missing`。**三码计数近乎相等（生产 1800 / 1674 / 1663）就是「每候选连挂三码」的形状**，不是三套独立缺陷。
> 口径提醒（2026-11-19 补）：上面这组数与本节的「2 条」门槛都是 Round23 当刻。Round27 起 identity/self 改走 staircase（`gates.ts:786-806`：1 条 + 代价措辞 + 具体指称），且 R23 的 `prefilter_*` 把结构上过不了门的挡在门外，所以 2026-11-19 本租户当刻是 `stance_missing` 74 / `dilemma_missing` 75 / `episode_missing` **32**（不是三码相等），全租户当刻 791 / 794 / 522。读本节数字必须带日期与租户口径。

**为什么不能只改闸门**：`minEpisodeEvidence=2` 是 A1 判据「无证据不乱漂」的落地。把它降到 0 或让 identity 免检，等于用放宽判据换数字，明确不做。能改的只有「出处能不能被解析成事件」。

**改动 1（R23-1）：把 L1 出处接到事件上，接不上的挡在闸门外并计数**

```ts
// worker.ts：事件池的键是 L0 消息 id（生产实测 317 条 quote.recordId = 305 条 msg-* + 12 条 ft-*）
export function episodeIdsByRecordId(pool: SoulEpisode[]): Map<string, string[]>   // 消息 id → ep-*
export function resolveEpisodeIds(ids, epByRecordId, msgByL1): string[]             // 两跳，保序去重
```

- 第一跳：出处本身就在事件池键里（voiceQuotes 等按同 id 存的情况）。
- 第二跳：`l1_records.source_message_ids`（`store.getL1ByIdsWithArchive`，只查本批未命中的 id，≤ 本 tick 事实数 × 3）→ 消息 id → `ep-*`。生产实测 `soul_episodes.quote.recordId` 是 L0 消息 id（305 条 `msg-*` + 12 条 `ft-*`，没有一条是 L1 `record_id`），所以**第一跳在身份事实这条路上命中率恒为 0，第二跳才是真通道**。
- 解析结果为 0：`bumpPrefilter("identity", "prefilter_no_episode")` + `report.identity.prefiltered`，**不进闸门**——与 `mined` 的结构预过滤同口径，不让「没有事件出处」冒充「模型提案被拒」。
- 解析到 1 条但门要得更多（values/relationship 等层要 `max(2, minEpisodeEvidence)`；identity/self/narrative 走 staircase 只需 1 条 + 代价措辞）：照旧进闸门，不够就挂 `episode_missing`，这是**真缺口**。

**生产可解析性实测（`D:/TDB/data/vectors.db`，只读，team-2k12lgb650）**

| 读数 | 值 |
| --- | --- |
| `soul_episodes` 行数 / `quote.recordId` 可用数 | 317 / 317（305 条 `msg-*` + 12 条 `ft-*`） |
| 最近 400 条 L1 中带 `source_message_ids`（`ORDER BY updated_time DESC`） | 251（62.8%） |
| 其中能解析到 ≥1 个事件 | 82（20.5%） |
| 其中能解析到 ≥2 个事件（Round23 当刻的 identity 门；现为 1 条 + 代价措辞） | **10（2.5%）** |

排序键是这张表的一部分：换成 `ORDER BY created_time DESC` 同一查询得 **370 / 127 / 14**。两个口径都不算错，但必须写明按哪个键取样，否则数字不可复算。

**判读（必须如实说的部分）**：这条通道上线后，三码不会归零。Round23 当刻的结构上限是「一条身份事实要有 ≥2 个事件同时支撑」（Round27 起 identity/self 只需 1 条 + 代价措辞，门槛换了但出处解析这条通道不变），而 L1 记忆是「多条消息蒸馏成一句」，一条记忆通常只落 1 个事件、甚至 0 个。所以正确的效果是：**把「所有身份事实必挂三码」收窄成「只有 2.5% 的出处够 2 个事件，其余按 prefilter 记账」**，而不是把三码压成 0。要真把 2.5% 提上去，得改取样口径（身份事实只从「已进事件的 2 条以上原始消息」里提），那是下一轮的量，不在本轮顺手改取样。

**改动 2（R23-2）：`normalizeForId` 不再吃掉数字之间的小数点**

`l1-writer.ts` 的 `normalizeForId` 原本 `replace(/[\s\p{P}\p{S}]+/gu, "")`，把小数点一起删掉 → `contentMemoryId("版本 13.5") === contentMemoryId("版本 135")`，两条不同事实会被当成同一条静默合并。改成先用零宽占位 `(?<=\d)[.\uff0e](?=\d)` 护住「两侧都是数字的点」，再去标点，最后把占位换回 `.`；`1.5.3` 两处都护住（用后向/前向断言而非消费字符，避免 `1.5.3` 只护住第一处）。句末句号照旧被吃掉，原有归一口径不变。

**测试**（都实跑过）

- `MemoryCore/src/core/soul/__tests__/soul-worker-single-line.test.ts`（5 条）：①出处解析不到 → `report.identity={proposed:1,candidates:0,prefiltered:1}`、无 identity 拒绝行、`report.prefiltered=[{identity,prefilter_no_episode,1}]`；②两跳与去重、未知 id 返回空；③端到端：事件池按 `msg-*` 建键 + `getL1ByIdsWithArchive` 交代消息出处 → 候选进闸门且 `codes` 不含 `episode_missing`。
- `MemoryCore/src/core/record/__tests__/l1-writer-content-id.test.ts`（4 条，新增 1 条）：`13.5 ≠ 135`、`13.5 ≠ 13 5`、`13.5 == 13.5`（空格无关）、`1.5.3 ≠ 153`、全角点等价、句末句号仍被吃掉。

**可观测性注意（别把 prefilter 读成拒绝）**：`prefilter_*` 与真实拒绝码写在**同一张** `soul_gate_stats`、同一个 `(day,code,layer)` 聚合里，`sqlite.ts:6252-6277` 的 `soulRejectionStats` 只按 code 分组，**不区分**「闸门拒了」与「压根没进闸门」。消费方必须按 `prefilter_` 前缀分辨；本轮没有加字段级隔离，属已知 P2（不是漏写，是有意保持表结构不变以免再动契约）。
**台账 V23-1（判据内部变更，无 `/v3/soul/*` 字段变化）**

- 改了什么：`worker.ts` 身份事实的出处解析（新增两个导出纯函数 `episodeIdsByRecordId` / `resolveEpisodeIds`）、解析不到时改走结构预过滤、`report.identity.prefiltered` 新字段。
- 用途：让 `episode_missing` / `dilemma_missing` / `stance_missing` 的计数只反映真实文本/证据缺口。
- 旧行为差异：过去每条身份事实都进闸门并被拒（`soul_ledger` 无行、`report.rejections` 有行）；现在出处接不上的事实**不进闸门**，改记 `soul_gate_stats.code=prefilter_no_episode`（layer=identity），`report.rejections` 变短、`report.prefiltered` 变长。**生产上「三码下降 + prefilter 上升」必须同时出现才算生效**，只看前者会误判。
- 回滚：**只把 `msgByL1` 传空是无效回滚**（第一跳对 `m_*` 恒 miss，`worker.ts` 里 `epIds.length === 0` 那段会把全部身份事实挡在闸门外并记 prefilter，与「退回全部进闸门」正好相反）。真回滚要二选一：①删掉 `worker.ts` 的 `if (epIds.length === 0) { bumpPrefilter(...); continue; }` 那三行，让事实照旧进闸门；②整段回退到 `episodeIdsByRecordId`/`resolveEpisodeIds` 插入前的候选构造。`report.identity.prefiltered` / `report.prefiltered` 都是可选字段，旧消费方不受影响。
- 仍存在：①取样口径未改（2.5% 上限仍在）。②~~**归档行解析不到**~~ → **Round23 R23-3 已修**：归档写的是整行 JSON（`l1_archive.data`，建表 `sqlite.ts:1179-1187`，只有 `record_id/data/archived_at/reason/team_id/user_id/agent_id` 七列；INSERT 在 `sqlite.ts:2904`），原话溯源**确实保存在 `data.source_message_ids` 里**——丢的是读侧：`getL1ByIdsWithArchive`（`sqlite.ts:6975` 起）的归档映射漏了这一字段，于是身份事实一旦引到已归档的旧证据，第二跳恒空、只静默计入 `prefilter_no_episode`。修法是给归档映射补 `source_message_ids: parseSourceMessageIds(d.source_message_ids)`；测试 `l1-source-message-ids.test.ts` 的「归档→恢复 roundtrip」组新增一条（归档期间 `getL1ByIdsWithArchive(['arc2']).source_message_ids` 必须等于 `['m9','m10']`，修前是 `undefined`）。规模：活表 14030 行、归档 8963 行、带非空出处的活表行 10129。③`source_message_ids` 里 33 个非 `msg-*` 元素（`ft-s*` 夹具）永远打不中事件键，同样只变计数。④`dur_*`、`rf_*` 出处没有 `source_message_ids`，永久解析不到。

**台账 V23-3（归档读路径补字段，无 `/v3/soul/*` 变化）**

- 改了什么：`sqlite.ts` 的 `getL1ByIdsWithArchive` 归档映射补 `source_message_ids`（复用 `parseSourceMessageIds`）。
- 用途：让「已被 `archiveL1` 软删的旧证据」也能参与身份事实的两跳解析（R23-1 的第二跳），否则第二跳对归档行恒空。
- 旧行为差异：归档行读回多一个字段，值来自 `data.source_message_ids`；调用方（`worker.ts` 第二跳、`auto-recall` 邻居展开、`memory-search` 邻居展开）都不会因为多这个字段改变既有分支，只有「以前解析不到、现在能解析」的差别。
- 回滚：删掉该行映射即可；字段声明本身是可选的（`types.ts` 的 `source_message_ids?: string[]`），无 schema 变更。

**台账 V23-2（内容键语义变更）**

- 改了什么：`contentMemoryId` 的归一化不再吞掉数字之间的点。
- 用途：`13.5` 与 `135`、`0.5` 与 `05` 不再同键。
- 旧行为差异：**历史行的 `record_id` 不回填**——已落库的 `m_<sha1>` 仍按旧键算，新写入按新键算，所以含小数点的同内容事实**理论上**会出现「旧键一行 + 新键一行」。实测（2026-11-19，只读）：库内仍是 12763 条旧随机 `m_<ms>_<6>` + 1204 `rf_*` + 63 other，内容哈希态 `^m_[0-9a-f]{24}$` **0 行**，重复仍是 23 组 / 46 行 → 这个风险**当前没有可兑现的行**，不能写成已发生；也不能宣称历史已收敛。另一处语义收窄：`"13 . 5"` 与 `"13.5"` 不再同键（旧实现两者都归一到 `135` 后再撞）。实测（只读全表 14030 行）：含「数字紧邻点」（`/[0-9][.．][0-9]/`）的 **1576 行（11.2%）**；含「数字 + 空格 + 点 + 空格 + 数字」（真 `13 . 5` 写法）的 **0 行**。早先写过的「594 行 / 空格写法 4 行」是错的口径（594 无自然定义可复现；那 4 行实为 `.gitignore`、`3 .exe`、`docs/10 .esn-cf`、`13:32 .verification` 这类扩展名点被宽松匹配到），已作废。
- 回滚：**两处一起删**——`l1-writer.ts` 里 `const guarded = content.replace(/(?<=\d)[.\uff0e](?=\d)/gu, "\u0001")` 这一行，以及末尾 `.replace(/\u0001/gu, ".")`；只删前者会留下裸 `\u0001` 进 id 素材。回滚后新写入会重新与旧键一致。

**本轮仍未闭环**

- 两跳命中率只有 20.5% / 过门 2.5%，判据上限由取样口径决定（见上）。
- `prefilter_no_episode` 的生产读数要等部署后新候选流入才可读（`bumpSoulGateStats` 只在 tick 里累加，文件里没有存量）。
- **回放不能提供这条证据**：`MemoryCore/scripts/soul-fulltest-replay.mjs` 没有 `identityFacts` 依赖（grep 无命中），回放里的身份行全部来自桩改写器，因此回放库的 `prefilter_no_episode` 恒为 0。本轮的证据只有三种：单测（`soul-worker-single-line.test.ts` 5 条）、生产只读重叠率（上表）、以及部署后新候选流入时的 delta。
## 5.31 Round24：快照可归因（`payload.provenance`）

**缺口（判据 1 要求「`soul_snapshots` 能追到哪条输入导致哪次漂移」）** 迁移前的实测：

- `payload_json` 有 `traits`/`traitLabels`，能回答「当时 6 轴是多少、哪几个标签在投」；
- 但**没有 itemId 级出处**：`payload.identity/anchor` 只是按块的 `evidenceIds`（`card-service.ts` 的 `evidenceIndex`（按函数名 grep）按单行化文本回查），同一个 evidenceId 到底挂在哪条人格条目上看不出来；
- `meta.lastDrift`（`worker.ts`，按 `anchorIds.length > 0` 这一行 grep，2026-11-19 实测在 `:2691`）只有 `anchorKey`（sha1 指纹）+ score/verdict/method/at，**没有锚的 id**——知道「投过票」，不知道「拿哪几条记录投的票」。

**改法（R24-1）**

1. `worker.ts:2598-2610` 的锚改按 `(id, text)` 成对取：判断轨 id = 近窗记录的 `record_id`（`SoulEvidenceRecord.id`），语体轨 id = `voiceRecords` 的 `recordId`；`lastDrift` 增 `anchorIds`（≤8，和 `anchorKey` 一起落盘；行号会漂，按 `anchorIds.length > 0` grep）。不再从文本反查 id——同文本可能对应多条记录，反查会指错。
2. `card-service.ts` 的快照 payload 新增 `provenance`：`render{at,version,hash,schema}` + `items[{layer,itemId,state,evidenceIds?(≤5),lastEvidenceAt?,drift?}]`（≤60 条，只收 8 个注入层）。`driftProvenance()` 只挑 `score/track/verdict/at/method/anchorKey/anchorIds`，**不整段透传 `meta`**（meta 里还有 `object`/`validTo` 等生命周期键，透传等于把内部结构泄进快照）。

**测试与变异（2026-11-19 13:5x，工作区实跑）**

- `MemoryCore/src/core/soul/__tests__/card-service.test.ts` 27 tests（新增「payload.provenance 逐条给出 itemId/evidenceIds，并带 lastDrift 的锚 id」）；`__tests__/soul-worker.test.ts` 45 tests（新增「lastDrift 带上锚的记录 id」，F2 增 1，r24d-a1 又要求补 worker 级复活用例 1 条）；两文件合跑 **72 passed**。
- 变异 M1：把 `anchorIds: anchorIds.slice(0, 8)` 换成 `[]` → worker 新用例 `1 failed | 42 passed`；变异 M2：把 `const drift = driftProvenance(it)` 换成 `undefined` → card 新用例 `1 failed | 26 passed`；当时还原后 71 passed（27+44，数字随补例增长，别当契约）。
- 复活用例的反证（r24d-a1 要求）：把 `...(revivePlan ?? target)` 改回 `...target` → 新用例 `1 failed | 44 passed`；还原后 `45 passed`。
- `node scripts/typecheck-gate.mjs` → PASS 121 errors / 23 files（基线 149/28，Δ=-28）。

**契约台账 V24-1（快照 payload 新增字段，无新端点/状态码）**

- 端点：无新端点、无新状态码。变更落在 `GET /v3/soul/card` 落盘的那一行 `soul_snapshots.payload_json` 内部。
- 新增字段：`payload.provenance.render{at,version,hash,schema}`；`payload.provenance.items[].{layer,itemId,state,evidenceIds?,lastEvidenceAt?,drift?}`；`drift.anchorIds`（最多 8 个 `record_id`/`recordId`）。
- 用途：判据 1 的「哪条输入导致哪次漂移」；面板与审计可把版本变化对回 L1 `record_id`，不必再靠文本反查。
- 旧响应差异：**`GET /v3/soul/card` 的响应体不变**（provenance 只进快照行，不进卡文本与响应）。旧快照行没有该键，读侧必须按可选处理；`scripts/soul-contract-assert.mjs` 的 `snapshot.provenance` 在部署前标「待部署」。
- 回滚：删三处——`card-service.ts` payload 里的 `provenance:` 块、`driftProvenance`/`PROVENANCE_LAYERS`/`PROVENANCE_MAX_ITEMS`、`worker.ts` 的 `anchorIds` 展开行（并把 `recordAnchorPairs/voiceAnchorPairs` 改回 `.map(r => r.content)` / `[...voiceRecords.values()]`）。

**生产读数（2026-11-19 13:58，只读）**

`node --import tsx scripts/soul-contract-assert.mjs --data-dir D:/TDB/data --team team-2k12lgb650` → **通过 36 / 失败 0 / 待部署 1（snapshot.provenance）**：最新快照 v1214（identity 578 字）缺 `provenance.items`（本版未部署）；卡 v0 dirty（现算 217 字）。部署后该项应转绿，且应能读到 `items>0` 与至少一条带 `evidenceIds` 的行。

**仍未闭环**

- `anchorIds` 只在真的跑了漂移打分时才写：判断轨要向量器（`deps.embed`），无向量器直接 `driftSkipped`，此时没有 `anchorIds`（不伪造空锚）。
- provenance 只覆盖人格条目，不覆盖「最近/未完的事/校准句」等结构化块——它们各自带 evidenceIds，但没进 provenance。
- `render.version` 是「写入版本」；`GET /card` 现算的 dirty 版本不落盘，两者不等属正常，不能拿 version 差当「漂移了」。
## 5.32 Round24：五路复核后的七处修复（F1–F7）

Round24 首轮五路冷启动只 1 PASS / 5（a1 1/5、a2 2/5、a3 2/5、a4 1/5、a5 4/5）。下面每条都对应复核给出的可复现实证，不是"顺手改"。

**F1 复活要清掉漂移史（判据 1，`persona.ts` planRevive）**

- 实证：r24-a1 C1.5 —— 复活（`planRevive` 删 `validTo`）与冻结在同一对相邻 tick 互相抵消：复活后 `driftHistory` 仍在，下一次 `measureDrift` 立刻 `consecutive=8` → 再次 `freeze`，连跑 5 轮 5/5 复现，43 个 worker 用例全绿无覆盖。
- 改法（两半，缺一半都不生效）：① `persona.ts` 的 `delete revived.validTo;` 之后加 `delete revived.driftHistory;`——漂移史记的是"旧证据下的连续低分"，证据换了就不该沿用；② `worker.ts` 复活分支原来是 `...target` 只覆盖 `state`，会把 `driftHistory`/`validTo` 原样带进新行，于是复活的下一个 tick 立刻又被冻回去。现在在 `next` 之前先算 `revivePlan`（frozen/degraded 且有新证据时 `planRevive(target, now, cand.evidenceIds)`），赋值改成 `...(revivePlan ?? target)`，并在 `next.state==="active" && target.state!=="active"` 时同时 `delete next.validTo` 与 `delete next.driftHistory`。**只改 persona 不改 worker，运行时等于没改**（r24c-a1 CP2-A 实测）。
- 测试：`soul-persona.test.ts`「A1 Round24：复活清掉漂移史」——同一行带 2 次低分史时 `verdict=freeze`；`planRevive` 之后同一输入不再 freeze。

**F2 样本数是累计量（判据 2，`emotion.ts` integrateMood）**

- 实证：r24-a2 CP1 —— `sampleCount` 被写成「本轮事件数」，而 `emotion.ts` 的底子行在 `sampleCount<=0` 时返回"还没有形成可说的底子"，于是有事件的 tick 读"底子偏沉"、下一个无事件 tick 立刻翻面成"还没有形成可说的底子"。
- 改法：`sampleCount: (base.sampleCount ?? 0) + events.length`。累计成立的前提是"每轮只吸新信号"，这条前提本身在 Round24 复核里被证伪过一次：L1 信号取窗为容忍落库抖动把下界放宽 5 分钟（`worker.ts` 里 `since` 的三元表达式，`prevUpdatedAt - 5 * 60_000` 那一版；行号随本轮改动漂过，按这个字符串 grep），而上界原本是无穷，于是同一条信号会被相邻两轮各吸一次（`occurred_at 09:58` 在 10:00 与 11:00 两轮把 sampleCount 从 1 抬到 2），未来时刻的信号还会被提前计入。现已去掉那 5 分钟并在过滤处补 `at <= nowMs` 上界（`worker.ts` 的 `const fresh = ...filter` 块）；判断轨（`promptMoodBias` 那条）也有同样的 `-5 * 60_000` 且无上界，r24c-a2 指出后一并改成 `prevUpdatedAt` + `at <= nowMs`（只影响提示词偏置，不进 `soul_state`）。事件侧不受此影响（按 `moodIntegratedAt` 打标，与两个时钟无关）。
- 注意：生产库曾读到 `sample_count=3823` 那种值，成因不是"累加"，而是旧代码每轮把整个事件窗口重放一遍；重复积分由事件上的 `moodIntegratedAt` 打标挡住，与样本数无关。
- 测试：`soul-mood-baseline.test.ts`「样本数是累计量」；`soul-mood-integration-marker.test.ts` 由「第二轮 sampleCount=0」改为「第二轮仍 2、补一条后 3」；`soul-worker.test.ts` 由 1 改 8。

**F3 符号不进内容键（判据 3，`l1-writer.ts` normalizeForId）**

- 实证：r24-a3 —— 正则剥 `\p{S}` 让「预算以≥100万为上限」与「预算以100万为上限」同键 `m_531855451d3268fb712dbe5c`，store 冲突子句直接覆盖正文，临时库实测只剩 1 行、version=0、归档 0 行。
- 改法：`[\s\p{P}\p{S}]+` → `[\s\p{P}]+`（保留 ± ≥ ≤ × 这类语义符号）。
- 测试：`l1-writer-content-id.test.ts`「符号差异不进同一内容键」（≥100万≠100万、≥3倍≠3倍；只差空格仍同键）。
- 一次性影响：带符号的历史行仍用旧 id，同句再抽取会算新 id 也可能多一行；由 l1-dedup 与 `scripts/merge-legacy-l1-duplicates.mjs` 收口，不回溯改写历史 id。

**F4 关系 valid_from 回填脚本要能看归档（判据 3，`scripts/migrate-soul-relation-validfrom.mjs`）**

- 实证：r24-a3 —— 5 行关系里 3 行 `valid_from=created_at` 而证据时间早 3 分钟；共同证据 `m_1794270906359_54d92800` 已被 dedup-update 归档进 `l1_archive`，脚本只查 `l1_records` → 实测「可回填 0、找不到 3」。
- 改法：`evidenceRefsOf` 优先取 `evidence_json[].at`，`l1_records` 与 `l1_archive` 做 union 查。
- 实测（dry-run，只读）：「扫描 5 条；可回填 3；找不到 0；来源 evidence 0 / live 2 / archive 3」，3 行 `00:38:15.122 → 00:35:15.241`。

**F5 L2 组级失败不级联（判据 3，三处接线）**

- 实证：r24-a3 —— `runL2WithStore` 只回 `{creditUsed,skipped}`，`gateway/server.ts` 丢掉 `hadFailure`；`services/pipeline-worker.ts` 的成功分支写墙钟 `l2_last_extraction_time` 并入队 L3 —— 半失败轮被当成功轮，失败批永久落在游标之后。
- 改法：`tdai-core.runL2WithStore` 返回类型扩 `hadFailure?` 并透传；`gateway/server.ts` 置 `task._l2HadFailure`；`services/pipeline-worker.ts` 的 L2 分支早退（不写墙钟、不入队 L3、不重挂 timer）。
- 测试：`src/services/__tests__/pipeline-worker-l2-failure.test.ts` 3 条（失败轮三条都不做；成功轮照做；`_l2Skipped` 同口径）。

**F6 契约断言非真空（判据 1，`scripts/soul-contract-assert.mjs`）**

- 实证：r24-a5 —— 原 `snapshot.provenance` 只要求 `items>0` 且首条带 `evidenceIds`，删掉 `worker.ts` 的 `anchorIds` 整段后脚本仍全绿，等于没验"归因"。
- 改法：新增 `snapshot.provenanceDrift`：只对**部署之后新产生**的漂移（`drift.at >= --drift-since`，默认 `2026-11-19T05:59:27.000Z` = 本轮部署时刻）要求每条都带非空 `anchorIds`；部署前的旧漂移天然没有锚（快照里的 `drift` 是 `meta.lastDrift` 的历史值，一直留到下次漂移覆盖它），单独计数不当失败；**一条部署后漂移都没有时记「待部署」，不判 PASS**。
- 反证（实跑）：`--drift-since 2026-11-01T00:00:00.000Z` → 「带 drift 条目=52（部署后 52）；缺锚=52」→ 失败 1。默认 cutoff 下 → 「部署后 0；部署后缺锚=0」→ 待部署 1。

**F7 rows 恒等式不是证据（判据 6，`soul-injection-stats-endpoint.ts` + `scripts/soul-contract-assert.mjs`）**

- 实证：r24-a4 CP1 —— `stats.rowsIdentity` 原先断言 `rows === sectionRead + cardBound + cardBoundEmpty + cardBoundFailed`，而端点里 `countedEvent` 与五桶分支是**逐行一对一**的同一判断（行号随改动漂，定位用字符串 `countedEvent` 与 `cardBoundEmpty +=`）（`card-empty` 同时抬 `rows` 与 `cardBoundEmpty`），代入任何真实数据都恒成立：10 条 card-empty 注入 0 字符也满足 `10 = 0 + 0 + 10 + 0`。断言真空。
- 改法一（代码）：桶判定改用与 `rows` 同一份 `eventName`（`asString` 已 trim），杜绝「进了 rows 却没进任何桶」；生产 0 行受影响（事件名带空白的历史行不存在）。
- 改法二（断言）：新增 `stats.rowsIdentity.recount` —— 从 `persona-injection.jsonl(.1)` **独立重数**本租户的四类计账事件（窗口只有下界、trim 身份、默认排除测试身份），与端点 `rows` 做 `oneSided`（后读允许 +10 追写；原来是 +50，r24c-a4 用 50 条幻影行验出太宽，见 §5.32 F7）。原断言先被降级成 `stats.rowsBuckets.selfConsistent`，**Round32 又整条删除**（A5 指出它依旧是代数恒等、破不了），见 R32-6。
- 实测：契约断言 `stats.rowsIdentity.recount` 打印 `endpoint rows=0 vs 日志重数=0（Δ0）；四桶之和=0（恒等，仅自检）`，通过。
- 反证（三路实跑）：① 新增用例 `soul-injection-stats-endpoint.test.ts`「事件名两侧空白不影响计账与分桶」——日志写 `" card-empty "` / `"card-bound "` / `" section-read"` / `"card-bound-failed\t"` 四条，断言 `rows=4` 且 `sectionRead=1 cardBound=0 cardBoundEmpty=2 cardEmpty=1 cardBoundFailed=1`；把四处桶判定改回 raw `ev.event`（restore sha 一致、未留改动）→ **1 failed / 21 passed**，首红在 `:492`。② r24c-a4 合成租户：干净夹具 `rows=5 / 重数=5（Δ0）` 通过；一条 `"card-bound "`（带空白）→ `rows=6 / 重数=5（Δ-1）` exit 1。③ r24c-a4 幻影行：60 条 `ts` 不可解析 → `rows=5 / 重数=65（Δ60）` 红；50 条时 **Δ50 曾被通过** —— `APPEND_SLACK` 原本是 50 放得太宽，已收紧到 10（端点请求与读文件相隔秒级，本轮实测自然 Δ 为 0）。

**契约/参数台账（Round24 追加）**

- **V24-2（`/v3/soul/injection/stats` 无字段变化，判定口径收紧）**：`soul-injection-stats-endpoint.ts` 的四处桶判定改用与 `rows` 同一份 `asString` 结果的 `eventName`（见 F7）。端点、字段、状态码都不变；旧响应差异**只**出现在「事件名带首尾空白」的历史行上——以前这种行进 `rows` 但不进任何桶，现在两边都不进（生产今日 0 行，`includeTest` 侧也为 0）。回滚：把四处 `eventName` 改回 `ev.event`。
- **V24-3（参数：判断轨心境取窗去掉 5 分钟重叠带、补 `at <= nowMs` 上界）**：`worker.ts` 里只喂 `promptMoodBias` 的那段（与写 `soul_state` 的主路径同一套窗口语义）。参数变化：`since = prevUpdatedAt - 5*60_000` → `prevUpdatedAt`；过滤由 `at > since` → `at > since && at <= nowMs`。旧行为差异：同一条信号在相邻两轮各出现一次，偏置被重复加权；未来时刻的信号会被提前计入。回滚：把三元表达式改回 `prevUpdatedAt - 5 * 60_000` 并删掉上界。`soul-worker.test.ts` 的「情绪进入判断」用例原本靠 `occurred_at === updatedAt` 才拿到偏置（等价于靠那 5 分钟带），已把上次积分时刻改早 30 分钟，语义不变。
- **补测（r24d-a2 CP2 判 FAIL 之后）**：新增「判断轨只喂上次积分之后的信号，未来信号不提前入账」——同一 store 三个信号时刻（01:58 已被上一轮吸收 / 02:05 正常 / 02:20 晚于 now），断言前者的 excerpt 不进 prompt、后者进、未来那条也不进。反证：`since` 改回 `prevUpdatedAt - 5*60_000` → 1 failed（抓到 01:58）；删掉 `at <= nowMs` 上界 → 1 failed（抓到 02:20）；还原后 46 passed。事件侧（`episodePool` 过滤）原先也只有下界，已补 `at <= nowMs`，同一条用例覆盖不到它——这是**已知残余**：事件侧的窗口仍没有独立用例。

**实测（2026-11-19 14:19–14:26）**

- `node scripts/typecheck-gate.mjs` → PASS，121 errors / 23 files（基线 149/28，Δ=-28）。
- `npx vitest run` → **487 files / 4539 tests passed**（14:44 复跑；14:24 那轮曾因 marker 用例的旧样本数语义红 1 条，已按 F2 改）。
- `cd dsh-plugin && npm test` → 48 files / 844 passed。
- 契约断言 → **通过 38 / 失败 0 / 待部署 1（snapshot.provenanceDrift）**（新增 `stats.rowsIdentity.recount`，见 F7）。
- 41 矩阵（`--db2 .../soul-ft-harness-lePjNu/vectors.db`）→ **33 PASS / 8 未验证 / 0 FAIL**；未验证仍是 A4/B5/B6/B8/B9/B10/B12/E2。

**仍不闭环（本轮明确不修，见 P1）**

- 快照空转：`card-v13.ts:805-810` 自认"无滞回"，两 hash 每 ~10 分钟翻面，11-15 一天 147 行只有 5 个 distinct hash（重复率 96.6%）；v1216→v1217 的差量只在 anchor 一句（「比基线偏轻，更活一点。」→「比基线还算稳，松紧和平时差不多。」），identity 36/45 对逐字相同 —— 落盘频率高不等于人格在变。
- 定向漂移被回滚撤销：`worker.ts:2731-2750` 对低分漂移发 rollback，`sqlite.ts:3793-3872` 连 `driftHistory` 一起恢复；全库回滚请求 334 / 已执行 306。
- `/v3/soul/*` 生产全 401（鉴权在路由前），真实会话取不到卡 → 判据 6 断在入口；无身份的真实会话 card-bound **7998/7998 行全 `chars=0`**、section-read **1509 行 = `no-card` 1219 + 无 reason 且 `sidSource=none` 290**（2026-11-19 14:45 重数，161 个 session，窗口 11-18T15:15Z–11-19T06:40Z）。**这些数字是快照**：14:2x 重数是 7852/1487，差量就来自这 20 分钟的持续写入，引用时必须带采样时刻；旧稿的 4232 /「455 全 no-card」属更早窗口，已作废。
- `payload` 的 identity/anchor 是"按块"的 evidenceIds，不是逐条 item 级；provenance 只覆盖人格条目，不覆盖"最近/未完的事/校准句"。
- L2 游标仍是单键（同毫秒不可续读，见 §5.26）且失败轮无退避；另外 `gateway/server.ts` 置 `task._l2HadFailure` 与 tdai-core 的 `hadFailure` 透传**没有用例**——只有 `cascadeSchedule` 被注入标记直测（r24b-a3 CP4 留白）。
- 内容键一次性影响（F3）：带符号的历史行仍用旧 id，同句再抽取可能多一行，靠 l1-dedup 与 `scripts/merge-legacy-l1-duplicates.mjs` 收口，不回溯改写历史 id。

## 5.33 Round25：无身份注入的集群级归因 + 回放窗口口径纠正

**问题（判据 6 的观测面）**：DSH 插件写 `persona-injection.jsonl` 时，真实会话行**不带 identity**（插件只在测试/夹具里注入 `team-test`/`team-key` 三元组）。端点按租户统计，于是 `plugin.rows=0`、`cardBound`/`cardBoundFailed` 全 0，真实失败只能从 `unattributed.sectionRead` 看个总数，**分不出「绑定成功但 0 字符」「绑定失败」「失败原因」**。生产 24h 实测（Bearer + `?team/&user/&agent=`）：`noIdentityRows=13989`、`unattributed.sectionRead=1575`（noCard 1273 / noSession 302）。

**改动（`MemoryCore/src/gateway/soul-injection-stats-endpoint.ts`）**

1. `PluginFailureAgg.unattributed` 扩为 `{sectionRead,noCard,emptySegment,noSession,cardBound,cardBoundEmpty,cardBoundFailed,byReason,lastFailureAt}`；三处类型/初值同步（`SoulInjectionStats`、`emptyStats`）。
2. 无身份分支里 `card-bound`：`chars>0` → `unattributed.cardBound+=1`，否则 `cardBoundEmpty+=1`；`card-bound-failed` → `cardBoundFailed+=1`、`byReason` 按 `PLUGIN_FAIL_REASONS` 归类、`lastFailureAt` 取最大 ts。**不摊派给任何租户**：租户口径仍为 0，集群口径另算。
3. `lastFailure` 增可选 `status`（来自 `ev.failStatus`），能区分 429 与 500；旧日志没有该字段时不出键。

**测试** `src/gateway/__tests__/soul-injection-stats-endpoint.test.ts` 新增「A1 Round25：无身份的 card-bound-failed 也按 reason 聚合」：三条无身份（card-bound chars 0 / failed-http_status-429 / failed-timeout）+ 一条带身份 parse → 租户 `cardBoundFailed 1, byReason.parse 1`；集群 `cardBoundFailed 2, byReason{http_status:1,timeout:1}, cardBound 0, cardBoundEmpty 1`。文件 23 passed，typecheck-gate PASS 121/23（Δ-28）。

**契约台账 V25-1（stats 无身份归因）**

| 项 | 内容 |
| --- | --- |
| 端点 | `GET /v3/soul/injection/stats`（无新端点、无新状态码） |
| 新字段 | `data.plugin.unattributed.{cardBound,cardBoundEmpty,cardBoundFailed,byReason,lastFailureAt}`；`data.plugin.lastFailure.status?` |
| 用途 | 真实会话不带 identity 时仍能看绑定/失败与原因。BFF（`chat-memory-soul.ts`）与 Web 类型已按「缺键不出键」透出；**面板 UI 目前没有单独渲染这几键**（只有 `cardBoundEmpty` 的零字节徽标） |
| 旧响应差异 | 纯新增键；老客户端忽略即可。`unattributed.sectionRead` 语义不变（仍只数 section-read） |
| 回滚 | 删无身份分支里 `card-bound`/`card-bound-failed` 两段与两处类型字段即可恢复旧响应；`lastFailure.status` 可单独保留 |

**契约台账 V25-2（collective 口径收敛，仅注释）**：`soul-card-endpoint.ts` 三处注释原写「participants= 空串 → 只剩全局共性行」，与实现不符——`card-service.ts:138-142` 早写「collective 未实现，无主行 fail-closed」，`sqlite.ts:3692` 的 ownedUpsert 硬过滤无主 human 行，`gates.ts` 里以 `human_writer_removed` 硬拒的那段（grep）。**只改注释，无行为变化**；跨人共性仍是未实现项（见 §5.28 与 Round25 报告 P1）。

**数据迁移 V25-3（关系 `valid_from` 回填）**：`scripts/migrate-soul-relation-validfrom.mjs --db D:/TDB/data/vectors.db --apply` → 扫描 5 / 可回填 3 / 找不到 0（来源 evidence_json 0、l1_records 2、l1_archive 3）；`rel-fc7b1c17bee12d1c`、`rel-c0e6b14388918eca`、`rel-f1468af6936e38ea` 的 `valid_from` 由 `2026-11-10T00:38:15.122Z` 改为 `2026-11-10T00:35:15.241Z`。备份 `D:/TDB/data/backups/pre-round25-2026-11-19T07-09-30-143Z.db`；回滚 = 从备份恢复该表或按上述三行写回旧值。复核 dry-run 现应为「可回填 0」。

**口径澄清 V25-4（回放窗口到底是几天）**：`scripts/soul-fulltest-harness.mjs` 按语料的 `span.from..span.to` **逐日历天**建窗口（`:323-328`，注释明确「沉默日也要跑 tick」），语料 span `2026-08-10..2026-11-08` 含首尾共 **91 个日历天**，所以 `harness-result.json` 的 `days=91` 是真实回放天数；语料本身只有 **30 个会话、29 个有对话的天**，其余是沉默日（生命周期/断联/滑窗这些时间不变量正是靠沉默日才测得到）。`--days=N` 只是上限（`:28` `MAX_DAYS`、`:330` `days.splice(MAX_DAYS)`）。**曾一度误判成「29 天语料」并把 `MemoryCore/.scratch` 的旧结果（00:28，days=29）当成本轮读数**——正确读数是根目录 `.scratch/soul-fulltest/harness-result.json`（15:09，`days=91`、seeded 267）。

**部署与复核（2026-11-19T07:0xZ 起）**：`POST http://127.0.0.1:8446/restart`（头 `X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`，冷启动约 2 分钟（轮询 13 次才 200，前 12 次 000——仍按「先看端口 LISTENING 与日志 Gateway listening、再 curl」判活）。Bearer 直连 8420 对账：`/v3/soul/card` version 1219 / chars 1284 / identityChars 578 / boundaries 0 与快照 5163 逐项一致；`/v3/soul/turn` chars 16「近期心境：还没有形成可说的底子。」；`/v3/soul/injection/stats` 租户口径 rows 0、集群 `unattributed.sectionRead 1575`。

**Round25 复核后的补充修复（五路第二轮起）**

1. **事件侧窗口补上界**（`worker.ts` 事件通道里 `at <= nowMs` 那段，grep `事件通道` 定位）：`emotion.ts` 对 `dt<=0` 返满强度，未来时间的 episode 会在落库当轮就被积分。判断轨/信号轨早已 `at<=nowMs`，事件侧补齐同一边界（`ep.at` 解析不到时放行，避免坏时间戳卡死积分）。定向 4 文件 86 tests 通过。
2. **卡侧结构化心境吃样本数门**（`card-service.ts` 的 `moodRow &&` 判断，grep `moodRow &&` 定位）：尾巴侧早在 `sampleCount>0` 才造句，卡侧 `moodState` 却无条件写，同轮出现「卡：比基线还算稳 / 尾巴：还没有形成可说的底子」。现改为 `moodRow && sampleCount > 0`。
3. **契约快照查询按租户 + `ts` 取最新**（`soul-contract-assert.mjs:112`）：原查询无租户过滤、按 `version DESC`——不同 agent 的 version 序列互不相干，会取到别人旧行，`snapshot.provenanceDrift` 永远看不到本 agent 的新锚。现按 `team/user/agent`（只加非空项）过滤并 `ORDER BY ts DESC`；实跑 `--agent agt-fa0u5mi7x4` 得 v232、30 条 drift、部署后缺锚 0 → 该断言从「待部署」转真通过。
4. **stats 集群桶回到日志独立重数**（`soul-contract-assert.mjs:stats.unattributed.cardCounts.recount`）：只比 `byReason 之和 == cardBoundFailed` 是纯代数，把 `+=1` 改成 `+=0` 仍全绿。现在把 `card-bound` 按 chars 分两桶、`card-bound-failed` 计失败，在无身份行上重数再比（单向允许日志追写）。实跑 `un.cardBound=0/empty=8701/failed=0` 与日志 `0/8701/0` Δ0。
5. **矩阵把「静态引用」与「回放读数」分开**（`soul-fulltest-matrix.mjs`）：原 33 PASS 里有 19 条是 `push(id,title,"PASS",<单测引用>)` 字面量——删掉被引用用例矩阵仍绿，与脚本开头「绝不把没测写成通过」冲突。现改为状态 `CITED` 并单独计数，摘要打印「静态引用（CITED，非回放证据）：19 条」。**Round25 起矩阵真实读数是 PASS 14 / CITED 19 / 未验证 8 / FAIL 0**；旧报告里的「33 PASS」应理解为 14+19。

**台账 V25-5（矩阵状态语义）**：新增状态 `CITED`，只影响脚本输出与本文档，不影响产品与 `/v3/soul/*`；回滚 = 把 19 条 `"CITED"` 改回 `"PASS"`（不建议）。

**台账 V25-6（情绪两处判据修复）**：`worker.ts` 的事件上界与 `card-service.ts` 的卡侧样本数门，均为产品行为修正、**无契约变化**（卡/尾巴字段集合不变，只是不再输出无样本心境）；回滚 = 去掉两处条件。定向 86 tests 通过；全量 Core 待复跑。

**台账 V25-7（契约脚本两处非真空化）**：快照租户过滤 + `ts DESC`、`stats.unattributed.cardCounts.recount`。只动脚本与文档，无产品改动；契约断言现 **41 通过 / 0 失败 / 0 待部署**。

**仍未闭环**：①**判据 6 断在插件侧**：`dsh-plugin/dist/persona-card.js:255-263` 在 identity 为空时**根本不发 card 请求**，直接清卡并记 `card-bound chars:0`；根因是 `dsh-plugin/src/config.ts:382-383` 的三元组默认空（注释：empty makes the client inert）。生产 24h 里 2251 条 card-bound 有 2166 条无身份、`team-2k12lgb650` 一次没出现——**集群口径能看数，但要把卡送进 prompt 必须先绑身份**（本机配置需在 DSH 插件设置里填 team/user/agent，属于环境配置，代码不该替用户决定）。②`unattributed` 没有 chars 字段，答不了「注入了多少字」。③无身份失败行不写 `lastFailure`（只写 `lastFailureAt`），且 `failStatus` 只在 `lastFailure` 保留、无 reason×status 交叉聚合。④`payload-too-large-413` 偶发 ECONNRESET。⑤`/v3/soul/*` 仍需 Bearer。

## 5.34 Round26：把「用户主动不关联」从注入故障里摘出来

**用户指正（m09374）**：身份是**会话开始时**选的。先把「插件没有身份」当默认缺陷是错判——真实链路里 session-identity.json 有 200 条决定（inherited 173 / skipped 19 / picked 8），本机另一个会话 session-de20156f-49e2-4f00-a4db-d21ad516779c 绑定 team-2k12lgb650 / usr-2m7b1144d9 / agt-2m7buribzz（source=picked）并正常出卡；而排查用的会话 session-9b404d96-6838-4a0a-ad61-89008e6f18e5 的绑定是**空三元组 + source=skipped + reason「user chose 否，本次不关联」**，173 条 inherited 继承的正是这个决定。

**真问题（两处，都在插件）**

1. 清理语义错位：dsh-plugin/src/persona-card.ts 的 bindOnce 在 identity 为 undefined 或空串时删卡、并记 event: card-bound, chars: 0。于是「用户在会话开始选了否」被记成**一次零字节绑定**，/v3/soul/injection/stats 的 cardBoundEmpty 把它算进注入故障。
2. 重复刷行：dsh-plugin/src/index.ts 的 onSessionSeen 在 snapshot(sessionId) 为 undefined 时每次都 trackBind(...)；不关联的会话**永远没有卡**，所以每个 pre-step 都再清一次、再记一行。生产 D:/TDB/data/logs/persona-injection.jsonl 实测（2026-11-19 15:5x，11160 行）：card-bound 行里带 identity 的共 **270 行 = 265 条 team-test/* 夹具 + 5 条真实身份**（team-2k12lgb650 / usr-2m7b1144d9 / agt-2m7buribzz，07:25:52Z、07:49:33Z、07:55:09Z、08:04:48Z、08:04:50Z，pid 21776 —— r26f-a5 重数，早先「261+1」「267=265+2」「全是夹具」三种说法都作废）；单个不关联会话 session-9b404d96… 贡献 **1066 行 chars:0**（≈101 行/小时，1 行/pre-step），日志尾部每 2–10 秒一条——cardBoundEmpty（24h 8757→9051 随写增长）主要成分是这个，不是注入坏了。

**改动**

1. dsh-plugin/src/injection-log.ts：InjectionEventKind 增 card-cleared —— 清卡是**决定**，单列事件，不再混进 card-bound。
2. dsh-plugin/src/persona-card.ts：identity 为空时用 alreadyUnbound = identities.get(sessionId) 判空串，只在状态从「有卡/未知」变「不关联」时记一行 {event: card-cleared, chars: 0, reason: unassociated}，重复绑定静默返回（卡照旧删、identity 记为空串）。
3. dsh-plugin/src/index.ts 的 onSessionSeen：绑定存在且 teamId 为空串时直接 return —— 明确不关联的会话不再每次 pre-step 重试绑定（没有卡是结论，不是待办）。
4. dsh-plugin/src/session-identity.ts：IdentitySource 增 user-declined；asset_confirm 答「否」的分支由 bindNothing(..., skipped, ...) 改为 user-declined。skipped 从此只表示超时/取候选失败，审计上「主动退出」与「真故障」可分。配置 bypass（user-bypass）不变。
5. MemoryCore/src/gateway/soul-injection-stats-endpoint.ts：新增集群级 plugin.unassociated（card-cleared 行数，测试身份仍按 includeTest 过滤）；不进 rows、不进 cardBoundEmpty。PluginFailureAgg / SoulInjectionStats / emptyStats 三处同步。
6. 面板透出：MemoryPanel/src/panel/http/routes/chat-memory-soul.ts 与 MemoryPanel/web/src/lib/api/chat-memory-soul.ts 增可选 unassociated，仍按「缺键不出键」。MemoryCore/scripts/soul-contract-assert.mjs 增 stats.unassociated.recount：从日志独立重数 card-cleared 再与端点比，并把 unassociated 纳入 stats.cardBound.split 的键类型检查。
7. 清卡归因（r26d-a1 后补）：`persona-card.ts` 的 bind/bindOnce 增第三参 `clearedSource?: 'declined' | 'unconfigured'`，index.ts 的 `trackBind` 与两个调用点一起透传——`personaBindTarget` 返回 null（用户选否）记 `reason:'unassociated', source:'declined'`；三元组为空（未装配身份）记 `reason:'unconfigured', source:'unconfigured'`。旧实现把 null 与 undefined 塌成同一个 `bindOnce(undefined)`，面板会把「配置缺口」说成「用户主动不关联」。

**测试（实跑）**：dsh-plugin/test/persona-card.test.ts 用例⑨改写为断 card-cleared / reason unassociated 且不再产生 card-bound chars:0；新增⑨b「50 次重复绑定只记一行 card-cleared」（旧实现会记 50 行）与⑨c「清卡归因：declined 与 unconfigured 分开记」（断 `[['declined1','unassociated','declined'],['unconf1','unconfigured','unconfigured']]`）；session-identity.test.ts 的「答否」用例改断 source=user-declined 与 bound(user-declined)——两文件 **72 passed**。Core soul-injection-stats-endpoint.test.ts 新增「card-cleared 单列 unassociated，不冒充零字节绑定」（3 条清卡含一条带空白事件名 → unassociated=3, rows=1, cardBoundEmpty=1, noIdentityRows=3），该文件 **24 passed**；typecheck-gate **PASS 121 errors / 23 files（基线 149/28，Δ=-28）**。

**契约台账 V26-1（卡片清理事件语义）**：插件日志新增 event: card-cleared（{sessionId, chars:0, reason: unassociated}）。/v3/soul/* 无新端点、无新状态码。旧响应差异：cardBoundEmpty 不再把「用户主动不关联」计入（历史行仍是旧语义，未回填），新增 plugin.unassociated 反映这部分；老客户端忽略新键即可。回滚：persona-card.ts 恢复记 card-bound chars:0 并去掉 alreadyUnbound 判重。

**契约台账 V26-2（身份来源取值）**：session-identity.json 的 source 新增 user-declined（原先记 skipped）。旧数据不迁移——审计时 skipped + reason 含「不关联」的那批仍是旧写法。回滚：把 asset_confirm 否分支改回 skipped。

**契约台账 V26-3（plugin.unassociated）**：GET /v3/soul/injection/stats 新增 data.plugin.unassociated:number（集群级；card-cleared 行数）。用途：把「主动退出」与「注入失败」分开，避免 cardBoundEmpty 被灌满。旧响应差异：纯新增键；rows / cardBoundEmpty 计数口径对**新**日志收窄（历史行不变）。回滚：删聚合分支与该字段（端点、BFF、Web 三处）。

**仍未闭环**：①历史 card-bound chars:0 没有回填/重分类（24h 窗口内 9051 条，会随旧插件继续增长直到宿主重启），面板旧窗口仍把它们算进 cardBoundEmpty——可按 ts 与部署时刻分窗读，但库内无版本列。②card-cleared 行天然无 identity，所以**租户口径永远 0**，面板只能看集群级数字。③/v3/soul/* 仍需 Bearer。④插件 dist 已 build + `scripts/deploy.sh` 装进 profile（16:04:31，16:28 再装一次），宿主 pid 21776 仍是 09:29 起的进程：bind 路径的新代码在它身上已能看到 card-cleared，但 refresh 路径缺归因（16:27 修，见 §5.36），宿主重启后两者才一致。⑤历史 card-cleared 行共 12 条：10 条是 vitest 夹具（见 §5.35 的日志隔离修复）、2 条是宿主 pid 21776 的真实会话（08:16:13Z refresh 无名行、08:26:27Z），全部早于 16:45 的 dist 重建；部署后新行才是真实决定。
## 5.35 Round26 收口：清卡可归因、契约断言不再被追写掩盖、测试不再污染生产日志

**契约脚本三处非真空化（`MemoryCore/scripts/soul-contract-assert.mjs`）**

1. `stats.unassociated.recount` 不再用 `APPEND_SLACK=10` 的单向比较：端点 0 / 日志 10 时 Δ10 ≤ 10 仍判绿，正是这条断言要防的「字段在但永远是 0」（r26d-a3 反证：把 `unassociated += 1` 改成 `+= 0` 不变红）。现在相等直接过，不等就**立刻重取端点**，要求它追平日志——真实追写会涨，死计数不会。实跑端点 10 / 复取 10 / 日志 10（Δ0）。
2. 事件名先 `trim` 再比：端点用 `asString` 归一，脚本原为严格 `===`，带空白的事件名（单测就构造了 `" card-cleared "`）会变成端点 3 / 重数 2 的**假红**。同处一并修正 `card-bound`/`card-bound-failed`/`section-read` 与 `recountRows`。
3. `stats.cardBound.split` 的键类型检查纳入 `unassociated`。

**面板**：`MemoryPanel/web/src/pages/SoulPage/InjectionHealthBar.tsx` 在零字节徽标之后新增「主动不关联 N 次（清卡，非失败）」——`plugin.unassociated !== undefined && > 0` 才渲染，旧 Core 缺键不显示；`i18n/zh-CN.ts` 与 `i18n/en-US.ts` 各加 `soul.health.unassociated`。

**测试日志隔离（本轮发现的真缺陷）**：`dsh-plugin/test/index.test.ts:304/346/385/410` 走真实 `recordInjection` 而没设 `TDB_PERSONA_LOG`，默认路径就是生产 `D:/TDB/data/logs/persona-injection.jsonl`（`injection-log.ts:158-165`）——24h 内 card-bound 4980 行里 357 行来自 5 个夹具会话，10 条 card-cleared **全是**夹具行（s-card/s-tool/s-preset/s-bypass/s1，pid 33456/52612）。新增 `dsh-plugin/test/setup-env.ts`（整轮测试把 `TDB_PERSONA_LOG` 钉到 `mkdtemp` 临时目录）与 `vitest.config.ts` 的 `setupFiles`；`test/injection-log.test.ts` 增一条断言「测试期间的日志路径在系统临时目录下」。修后 `npm test` 48 files / 847 tests 全绿（此前 1 failed 的形态是全量并发下的超时抖动，单跑 83/83 通过）。

**部署与生产读数（2026-11-19 16:04–16:07）**

- 插件：`npm run build`（`dist/persona-card.js` 16:04，含 `card-cleared` 与 `clearedSource`）+ `bash scripts/deploy.sh --skip-tests` → profile 已刷新（manifest `7eda63a1be54`，51 files；备份 `dsh-plugin/.deploy/20261119-160431`）。宿主 pid 21776 起于 09:29（早于这次构建），所以**不能**从「它写出的行」推断部署已生效；16:16:13Z 那条没有 `source` 的 card-cleared 也不是旧 bundle —— 是 `refresh` 路径只传 identity、不传归因（16:27 已修，见 §5.36）。
- Core：`POST /restart`（`X-Tdb-Control: 1`）→ supervisor 重启三件套，tdai-core pid 36976 / port 8420（16:04:54 起），冷启动 ~2.5 分钟后 `/health` 200。
- 生产 `GET /v3/soul/injection/stats?team=team-2k12lgb650&user=usr-2m7b1144d9&agent=agt-2m7buribzz&hours=24`（Bearer）：`plugin.unassociated=10`（键存在）、`rows=27`、`cardBound=5`、`cardBoundEmpty=0`、`noIdentityRows=14917`、`excludedTestRows=7864`、`unattributed={sectionRead:1685,noCard:1359,noSession:326,cardBound:0,cardBoundEmpty:9051,cardBoundFailed:0}`。**这 10 条是历史夹具行**，不是真实用户决定——部署后新增的清卡行才是。
- 契约断言：`node --import tsx scripts/soul-contract-assert.mjs --data-dir D:/TDB/data --team team-2k12lgb650` → **41 通过 / 0 失败 / 1 待部署**（`snapshot.provenanceDrift`，部署后无新漂移样本）。

**台账**

- **V26-4（契约脚本非真空化）**：只动脚本与文档，`/v3/soul/*` 无端点/字段/状态码变化；回滚 = 恢复 `oneSided(...APPEND_SLACK)` 与不 trim 的写法（不建议——会把「计数恒 0」放过去）。
- **V26-5（面板 unassociated 徽标）**：新增 UI 文案与一个可选键的渲染条件。旧 Core 缺键不显示，不补 0；`/v3/soul/*` 无变化。回滚 = 删该段 JSX 与两个 i18n 键。
- **V26-6（测试日志隔离）**：只影响测试进程如何选日志路径（`TDB_PERSONA_LOG`），产品默认路径不变；回滚 = 删 `setupFiles` 与 `test/setup-env.ts`（不建议——会重新污染生产证据）。
- **V26-7（清卡 source 归因）**：`card-cleared` 事件新增 `source:'declined'|'unconfigured'`，未装配身份时 `reason` 记 `unconfigured`（不再冒充 `unassociated`）。旧日志行没有 `source`，读取方必须按可选处理；`/v3/soul/*` 无新增字段（stats 仍按事件总数计 `unassociated`，两类暂未拆桶，见仍未闭环③）。

**仍未闭环**：①插件改动等宿主重启（本轮不重启 GUI，避免掐断会话）。②历史 card-bound chars:0（24h 内 9051 条）不会自动重分类。③`unassociated` 仍把 `declined` 与 `unconfigured` 合并计数（事件已带 `source`，可下一轮拆桶）。④`/v3/soul/*` 仍需 Bearer。

## 5.36 Round26 收口：清卡按归因拆分、租户/集群两把尺、刷新路径不再造无名行

**读侧按归因与身份拆分（r26e-a1 ③）**：`MemoryCore/src/gateway/soul-injection-stats-endpoint.ts` 原来对所有 `card-cleared` 一律 `unassociated += 1`，不看 `reason`/`source`，于是**别的会话的清卡会算进当前租户**。现在：

- 无身份的清卡行 → `unattributed.cleared += 1`（集群级）；`reason === "unconfigured"` 时再加 `unattributed.unconfiguredCleared`。不进任何租户桶。
- 身份匹配租户的清卡行 → `reason === "unconfigured"` 记 `plugin.unconfigured`，否则 `plugin.unassociated`；仍进 `otherRows`，不进 `rows`。/v3/soul/injection/stats 因此多了 `data.plugin.unconfigured`、`data.plugin.unattributed.cleared`、`data.plugin.unattributed.unconfiguredCleared` 三个键。

**归因判定收在一处（r26e-a1 ①）**：`dsh-plugin/src/session-identity.ts` 新增 `cardClearedSource(bound)`（`associate === false` → `declined`，其余含 undefined → `unconfigured`）。`src/index.ts` 现在是 **两处调用 + 一处字面量**：`:933` `onSessionSeen` 与 `:953` `onBound` 调 `cardClearedSource(...)`；`:1229` restored 分支只在「恢复时身份整个没了」这一种情况清卡，直接传字面量 `'unconfigured'`（r26f-a1 纠正：本节原先写「三处都改用它」不成立）。新增 `dsh-plugin/test/cleared-source-wiring.test.ts` 读 `src/index.ts` 源码断三条接线（删任一处第三参就红：`:15`/`:16`/`:22`），补上「⑨c 直接调 handle.bind 不覆盖 index 选源」的盲区。**这层守卫是源码字符串 grep、不是行为断言**：把 `:933` 改成 `void cardClearedSource(bound);` 再调 `trackBind(sessionId, cardIdentityOf(sessionId))`（语义完全丢归因但子串还在）时，wiring 与 index 共 85 个测试全绿——r26f-a1 反证。

**刷新路径不再造无名行（r26e-a5 的 08:16:13Z）**：`persona-card.ts` 的 `refresh` 原来调 `bind(sessionId, identities.get(sessionId))`，不带归因；对「没卡也没身份」的会话也会走一次清卡，落成 `reason:"unassociated"` 且没有 `source`。现在 `refresh` 遇到「没有卡且身份未知/为空」直接返回，不发事件——**没有引入「记住上次归因」的 map**：那样写出来是死代码（`cards` 与 `identity === ''` 互斥，refresh 能进 bind 时 `alreadyUnbound` 必为真），r26f-a1 用变异证明了这一点，所以本轮把它删掉。新增 ⑨d 三条断言，其中**只有第 ① 条有牙**（删早退即红，复现 `["card-cleared","never-bound","unassociated",null]`）；②③是观测性断言（删早退后仍绿），文档与用例名都按此标注，不再声称三条都构成保护。

**面板**：清卡徽标从 ok/degraded 分支移到 noData 之后——「窗口内只有清卡行」正是 `rows === 0` 的场景，旧位置永远看不到；`unassociated` 与 `unconfigured` 分两段渲染，i18n 各一键（zh/en）。

**契约双桶重数 + 非真空化（r26f-a1 CP5）**：`soul-contract-assert.mjs` 的 `recountSectionRead` 拆成 `clearedTenant`/`clearedCluster` 并按 `reason` 再分（租户 declined / 租户 unconfigured / 集群 unconfigured）——无身份→集群，team/agent 匹配→租户，都排除测试身份。三条断言现在是`stats.unassociated.recount`（比租户 **declined** 桶）、`stats.unconfigured.recount`（比租户 unconfigured 桶）、`stats.unattributed.cleared.recount`（比集群桶），**全部要求精确相等**，不等就用最新重数再比一次；原来的 `oneSided + APPEND_SLACK=10` 已删（集群清卡 ≤10 时 `+=1` 改 `+=0` 曾仍判绿）。变异实测两方向都红：集群 `cleared += 0` → `stats.unattributed.cleared.recount` 0 vs 12 红；把无身份清卡多算进租户 `unassociated` → `stats.unassociated.recount` 12 vs 0 红。实跑 **43 通过 / 0 失败 / 1 待部署**（`snapshot.provenanceDrift`）。

**部署与生产读数（2026-11-19 16:28–16:31）**

- 插件：`npm run build` + `deploy.sh --skip-tests` 两轮——16:28（manifest `38abfc554c26`，含 `clearedSource`）、16:45（manifest `3e7a0202451c`，含删掉死 map 后的 refresh；备份 `dsh-plugin/.deploy/20261119-164509`）。宿主 pid 21776（09:29 起）未重启，本轮不重启 GUI（会掐断对话）。
- 面板：`MemoryPanel/web` 重建（`TEMP/TMP` 指到 `.scratch/tmp` 才能过 esbuild 的临时文件删除），产物 `dist/assets/main-DrP7-pc2.js`。
- Core：`POST /restart`（`X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`；冷启动 9 次探测后 `/health` 200。
- 生产 `GET /v3/soul/injection/stats?...&hours=24`（Bearer）：`plugin.rows=29`、`cardBound=5`、`cardBoundEmpty=0`、**`unassociated=0`**、**`unconfigured=0`**、`noIdentityRows=14967`、`otherRows=0`、`sectionRead=24`；`unattributed={sectionRead:1749,noCard:1409,noSession:340,cardBound:0,cardBoundEmpty:9051,cardBoundFailed:0,cleared:12,unconfiguredCleared:0}`。租户清卡归 0 是**对的**：历史 12 条清卡行全都没有 identity——**10 条 vitest 夹具**（s-card/s-tool/s-preset/s-bypass/s1，pid 33456/52612）+ **2 条宿主 pid 21776**（08:16:13Z refresh 无名行、08:26:27Z），r26f-a5 按 pid 重数纠正了本节原先「10 夹具 + 1 refresh + 1 测试」的写法。

**台账**

- **V26-8（stats 按归因拆分）**：GET /v3/soul/injection/stats 新增 `data.plugin.unconfigured`、`data.plugin.unattributed.cleared`、`data.plugin.unattributed.unconfiguredCleared`（均 number，集群/租户口径见上）。用途：把「用户拒绝」「身份没配」「压根没身份」三种清卡分开，别让 A 会话的决定算到 B 租户。旧响应差异：纯新增键；**租户口径的 `plugin.unassociated` 会从「所有清卡」收紧为「带本租户身份的 declined 清卡」**，历史无身份行从租户桶消失（此前它们被错算进去）。回滚：删三处分支与类型字段、把 `unassociated` 恢复为无条件累加。
- **V26-9（card-cleared 归因透传与刷新语义）**：事件 `card-cleared` 的 `reason`/`source` 由 `cardClearedSource` 判定（两处调用 + restored 一处字面量）；`refresh` 对「无卡无身份」不再发事件。旧日志行没有 `source`，读取方按可选处理；`/v3/soul/*` 无新端点。回滚：`refresh` 改回 `bind(sessionId, identities.get(sessionId))`、`index.ts` 两处改回各自三元。

**两个 rows 别混**：同一次响应里 `data.rows=8`（Core 侧采集日志 `recall-journal` 的窗口内行数，随重启与窗口滚动）与 `data.plugin.rows=29`（插件 `persona-injection.jsonl` 的计账事件数，= sectionRead 24 + cardBound 5）是两把尺，r26g-a5 把前者当成后者回落的证据，实际两者同时读都一致。

**仍未闭环**：①宿主 pid 21776 仍是 09:29 起的进程，refresh 修复要等宿主重启才在真实会话生效。②历史 12 条清卡行没有 identity，永远进集群桶，租户面板看不到。③`/v3/soul/*` 仍需 Bearer。④`unconfiguredCleared=0` 只因生产没触发过该分支，无正面样本。

## 5.37 Round27：identity/self 的 episode 门改为「1 个事件 + 代价措辞」

### 5.37.1 现象与判断

identity 层的拒绝码长期由三条同时失败构成：`episode_missing` / `dilemma_missing` / `stance_missing`。窗口口径写清楚：`soul_gate_stats` 只按 day 聚合，没有 per-tick 分桶，所以只能引用「当日累计 + last_at」。2026-11-19 当日（last_at 09:05:43Z）identity 层 episode_missing 509 / dilemma 555 / stance 553；同日 07:05Z 的时点读数是 465/465/463。历史累计（Round24 报告口径）是 16553/15412/15314 量级。根因不是模型不产人格，而是两道门在同一句话上要求不同东西：

- `worker.ts` 把候选的证据分成 L1（`m_*`）与 episode（`ep-*`），模型通常只引 1 个 episode；
- `gates.ts` 的 `need` 一行（grep `const need =`）旧口径对 identity/self/values 一律要求 `minEpisodeEvidence ?? 2` 个 episode。**行号每轮都在漂**（同一天写过 708-724、758-781、774-797 三个版本），本节一律改用「grep 得到的标识符」定位，不再写死行号。

模型正常行为（引 1 条真实事件）被判死，等于把「有出处」抬成「至少两次出处」。Round26 已补两跳 id 解析（`m_* → msg-* → ep-*`），但解析成功之后仍卡在数量上。

### 5.37.2 改法

`gates.ts` 的 `evaluateCandidate` 分桶段（`grep -n 'const staircase'` 起，到 `return { ok: true }` 前）：

- `identity` / `self`：`need = 1`；当且仅当 `have === 1` 时再要求句子里**同时**有代价措辞（`hasCostWording`）与具体指称（`hasConcreteReferent`），三者同时成立才算有出处。加具体指称是因为 r27g-a1 的反证：`宁可/宁愿/放弃` 同时命中 STANCE/DILEMMA/COST 三张词表，`我宁可放弃这次机会` 这种空话原本能全绿。
- 具体指称的定义在 Round27 收尾时**改过一次**（r27h-a1 反证）：第一版是「有数字 / 有 ≥2 字引号 / 正文 ≥24 字」，`我宁可放弃这次机会3`、`…守住「不装懂」`、28 字废话全都能过——换个标点就绕过。现在改为**对证据原文**：引号里的说法、数字，或与被引 episode 原文共享 ≥8 字连续片段，三者任一且必须真的出现在证据里；没有证据原文可对时判 false（fail-closed）。实现见 `gates.ts:394` 的 `hasConcreteReferent(text, evidenceTexts)`，证据原文由 `worker.ts` 的 `evidenceTextsOf(cand.episodeIds)` 从 `episodesById` 拼出（title/object/双方立场/代价/结果/原话），两处调用：更新路径与 `planAdmit`。
- `values`：仍要求 `≥ minEpisodeEvidence`（默认 2）。价值本来就该由两件具体的事支撑，且它另有 `intrinsic` / `cost` 两道门，不放松。
- `narrative`：仍为 1。

判据没有整体放宽：单事件 + 没代价仍然 `episode_missing`，values 单事件仍然红。代码里写明理由，避免下一轮被当成「为过审放水」。

### 5.37.3 测试与反证

`src/core/soul/__tests__/soul-persona.test.ts` 的「Round27：identity/self 单事件要有代价，且点到的东西必须出现在被引事件里（values 不放松）」十余条断言（条数以文件为准）：单事件+代价+指称落地 → identity 全绿；单事件无代价 → `cost_missing`；模态空话 / `机会3` / `「不装懂」` / 28 字废话 → `referent_missing`；数字真在证据里（`37 个用例`）→ 放行；证据为空 → `referent_missing`；values 单事件 → `episode_missing`。

变异实测（均还原）：

- M1 把 `need` 改回只有 narrative 为 1 → 1 failed | 48 passed；
- M2 把 `oneOk` 恒为 true（去掉代价门）→ 1 failed | 48 passed；
- M3 去掉 `hasConcreteReferent`（只留代价门）→ 1 failed | 48 passed，红在两条空话断言；
- 还原后 49 passed。

Round27 收尾又对**加固后的门**做了三条变异（均实跑、均还原；`gates.ts` 的哈希每轮都会漂，引用前用 `sha256sum MemoryCore/src/core/soul/gates.ts` 实测——2026-11-19T17:5xZ 时是 `a6692c5b…`，R27-6 二次加固前是 `c9d1e9c6…`）：

- M-A 共享片段阈值 6 → 4：1 failed | 48 skipped（红在 28 字废话那条，证明「宁可慢一点」这类模板词不能当指称）；
- M-B 删掉数字臂：1 failed | 48 skipped（红在「37 个用例」正向那条）；
- M-C 无证据原文时 fail-open（`return true`）：1 failed | 48 skipped（红在证据为空那条）。

另加两条反证（来自 r27g-a1）：`我宁可放弃这次机会`、`我宁愿多花点时间，也要自己动手` 都必须被拒——前者 `referent_missing`，后者同。

### 5.37.4 台账

**参数台账 R27-1**：`minEpisodeEvidence` 的适用范围收窄——identity/self 不再读该键（固定 1 + 代价门），values 仍读（默认 2）。期望从 FAIL 变 PASS 的用例：上面新增用例的第一条与 `soul-worker.test.ts` 里 identity 候选只引 1 个事件的路径；期望不变的：values 两条 `episode_missing` 断言。

**契约台账 R27-2**：无 `/v3/soul/*` 端点、字段、状态码变化。影响面只在写侧：`soul_gate_stats` 里 identity/self 的 `episode_missing` 会被拆成 `episode_missing`（0 个事件）/ `cost_missing`（1 个事件无代价）/ `referent_missing`（指称落不了地）三个 code——响应结构不动，但**按 code 做的历史对比会断**，跨版本比较必须按这三个 code 合并看。旧响应差异=无；回滚=删 `const staircase` 那行、删 `need` 表达式里的 `|| staircase`、删 `needsCostForOne` 与 `costOk`/`referentOk`、把四分支恢复成一条 `have >= need` 判定（都用 grep 定位，不按行号）；`hasConcreteReferent` 可留着（不再被调用）。

### 5.37.5 仍未闭环

- 供给已恢复但不足以归因：`l1_records` 最新 `created_time` 是 2026-11-19T08:24:42.826Z（14065 行），`soul_episodes` 在 11-19 有 6 条（07:33–08:09Z），都早于 09:02Z 的重启部署；重启后 09:05:43Z 仍有 identity 三码写入（说明 tick 在跑），但 `soul_gate_stats` 只有 day 粒度，无法把「部署后」与「部署前」拆开，所以本轮不拿生产增量证明下降。
- 代价词表（`gates.ts:363-366`；356-359 是 STANCE 表）可被「放弃」一词轻易满足；已用 `hasConcreteReferent` 补一层（Round27 收尾改为对证据原文，见 5.38），但「共享 ≥8 字」仍是启发式——证据原文里恰好有同样的长套话时，空话仍可能过。替代控制：同一候选还要过 stance/duplicate/churn/evidenceIndependence，且单事件准入只对 identity/self 开放。
- `values` 层仍会因「只引 1 个事件」被拒，这是有意保留的，不是遗漏。

### 5.37.6 部署与生产读数（2026-11-19 17:02–17:06）

- 重启：`POST http://127.0.0.1:8446/restart`（头 `X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`；tdai-core pid 44512 since 17:02:07，冷启动到 17:05:47 才 `/health 200`（约 3.5 分钟，前 8 次探测 000）。
- 卡：`GET /v3/soul/card?team=team-2k12lgb650&user=usr-2m7b1144d9&agent=agt-2m7buribzz` → version 1221 / hash 07a6f5f0e998 / chars 1243 / identity.chars 578 / anchor.chars 22；warnings 仍是「名称为空」「性格截断 300 字」「missing_working_state」「calibration_domains_truncated」「block_omitted:边界」。
- 快照对账：`soul_snapshots` id 5173 / version 1221 / ts 2026-11-19T08:17:19.720Z / trigger=render / content_hash 前缀 07a6f5f0e998 / payload 28135 字节 / `payload.identity.chars` 578 / `payload.anchor.chars` 22 / traits 非空——与 HTTP 响应逐项一致。
- 尾巴：`GET /v3/soul/turn?...&sessionId=s-probe-r27` → chars 71，正文「近期心境：底子偏沉。记得：在 run_code 上，我给自己八成把握，668 次里…」（含工作状态；长度从 16 字涨到 71 字，但 r27i-a2 实测 6 个不同 session 返回同一段文本、只有浮点尾数在动——**不是会随心境说话的尾巴**，见 5.38.6）。
- 注入统计（hours=6，window 03:06:08Z–09:06:08Z）：`plugin.rows` 29（sectionRead 24 + cardBound 5）、cardBoundEmpty 0、unassociated 0、unconfigured 0、noIdentityRows 3740、excludedTestRows 1236；`plugin.unattributed` = {sectionRead 548, noCard 424, noSession 124, cardBound 0, cardBoundEmpty 2485, cardBoundFailed 0, cleared 13, unconfiguredCleared 0, byReason 全 0}。
- 归因限制：`soul_gate_stats` 只有 day 粒度，09:05:43Z 的 identity 三码写入只证明 tick 在跑，无法把「部署后」与「部署前」拆窗；本轮不用它证明下降（见 5.37.5）。

### 5.37.7 仓库状态说明（避免被误读成本轮改写整文件）

`gates.ts` 的 HEAD blob 存的是 CRLF，而 `.gitattributes` 要求 `eol=lf`。工作区改成 LF 后，`git diff` 会把整文件当成改写（行数随改动继续增长；r27h-a5 实测 827/799、r27i-a2 872/799、r27j-a1 889/799 都是各自时刻的快照）；真实内容差异要看 `git diff --ignore-cr-at-eol`（同一串快照 82/9 → 97/9 → 99/9）（`staircase`/`need` 收窄、`classifyLine` 把特质句改判 method 的 +8/−1、`hasConcreteReferent` 加固与证据接线、以及三处分桶 code）。这是仓库既有状态，不是本轮改写整文件；提交时会让 git 按 `eol=lf` 归一化一次。

## 5.38 Round27 收尾：具体指称改成对证据原文，拒绝码分桶

### 5.38.1 为什么又改一次门

r27h-a1 的真跑反证（只读复核，报告 `.scratch/soul-fulltest/round27/r27h-a1.md`）：`hasConcreteReferent` 第一版是「任一数字 / 任意 ≥2 字引号 / 正文 ≥24 字」三选一，于是下面这些都 pass：

- `我宁可放弃这次机会3`（靠一个孤零零的 3）
- `我宁可放弃，也不装2`
- `…守住「不装懂」`（靠引号里两个字）
- 28 字凑长的废话

对照 `我宁可放弃这次机会` 反而被拒——**加一个字符就能绕过**。同一份复核还实测误杀（`我宁可交回没核实的东西，也不说没问题` 判 cost=false）与两处「无用例钉住」的臂（引号容差 {2,}→{5,}、删数字臂，都是 49 passed 全绿）。

结论：用标点和长度当「具体性」，等于奖励注水；具体指称只能由**证据原文**判定。

### 5.38.2 改法

1. `gates.ts` 的 `hasConcreteReferent(text, evidenceTexts?)`：先 normalize 证据原文，再要求满足其一且真的出现：① 引号里的说法在原文里；② 数字 token 在原文里；③ 与原文最长公共连续片段 ≥8 字（4–7 字常是「宁可慢一点」这类模板词，M-A 证明它会被空话借用）。`evidenceTexts` 缺失/为空 → **false**（fail-closed：说不出具体的事，不能当具体放行）。
2. `worker.ts` 新增 `evidenceTextsOf(ids)`：从 `opts.episodesById` 取 title/object/userStance/agentStance/cost/outcome/quote.text 拼成证据原文；两处接线——更新路径的 `evaluateCandidate`（GateContext.evidenceTexts）与 `planAdmit`（AdmitInput.evidenceTexts → persona.ts 透传）。
3. 拒绝码分桶：原来「0 个事件」与「1 个事件但没代价/指称」共用 `episode_missing`，gate_stats 看不出被哪条挡住。现在 `episode_missing`（have < need）/ `cost_missing`（单事件无代价）/ `referent_missing`（单事件代价有、指称落不了地）三码分开，`GateCode` 新增 `referent_missing`。

### 5.38.3 测试与三条变异（均实跑、均还原）

`soul-persona.test.ts` 的 Round27 用例十余条断言（以测试文件为准）。变异（临时副本上做，仓库零改动）：M-A 引号阈值 4→2、M-B 删数字臂、M-C 无证据 fail-open，各 1 failed | 48 skipped，红在对应断言。定向 `soul-persona` + `soul-worker` 98 passed。

### 5.38.4 契约脚本的非真空化（第二批）

`scripts/soul-contract-assert.mjs` 新增 `snapshot.provenanceDrift.resolve`：把快照里出现的每个 `drift.anchorIds` **回查** `l1_records` ∪ `l1_archive`，解析不到即失败——原来只判「数组非空」，r27h-a1 指出「删掉落盘后脚本仍全绿」。无漂移样本时记待部署（不判 PASS）。实跑：通过 43 / 失败 0 / 待部署 2（`snapshot.provenanceDrift`、`snapshot.provenanceDrift.resolve`，两者都因部署后暂无新漂移样本）。

### 5.38.5 台账

**参数台账 R27-3**：`hasConcreteReferent` 的判定从「文本形态」改为「对证据原文的最小公共片段 ≥8 字 / 数字命中 / 引号命中」，失败即 `referent_missing`。影响面：单事件准入的 identity/self 候选；`values` 不适用（它仍要 ≥2 事件）。回滚=把函数体退回第一版三选一，并把 worker 的两处 `evidenceTexts` 传递删掉（可留参数不影响编译）。

**契约台账 R27-4**：无 `/v3/soul/*` 端点与字段变化；写侧新增 gate code `referent_missing`、并把「单事件无代价」从 `episode_missing` 拆到 `cost_missing`。旧响应差异=无；下游若按 code 做百分比，跨版本比较必须把三个 code 合并。

### 5.38.6 仍未闭环

- r27h-a1 的另外三条（生产窗口全在改动前、anchor 段 A/B 翻面、缺锚）本轮只处理了第三条的一半（回查解析）；anchor 滞回在重启后**没有新快照样本**可证，翻面是否止住仍待观测。
- ~~`config.ts:1661` 允许把 `minEpisodeEvidence` 配成 1，配了之后 values 单事件也能过~~：已在 R27-7 堵掉，values 的下限是硬编码 2（见 5.38.7）。
- **生产首证（2026-11-19T09:37:50Z）**：部署后 identity 层第一次出现 `cost_missing=1`，而该 agent 的 `episode_missing` 最后写入停在 09:24:26Z（部署前；同租户 agt-bbr29z58s2 / agt-fa0u5mi7x4 仍在 09:33:32 / 09:33:47Z 写，所以这句只对本 agent 成立）——分桶不是纸面改动，拒绝理由确实换了口径。样本只 1 条，不足以证明准入率变化。
- 插件侧本轮首次拿到 `source` 正样本：`09:31:25.797Z card-cleared reason=unconfigured source=unconfigured session=ce36d688…`、`09:32:07.078Z … session=5cb386e5…`，每个会话只一行（宿主 17:30 重启后才挂上新 dist）。`plugin.unconfigured` 在租户桶仍是 0（这些行没有身份），`unattributed.unconfiguredCleared=5`。
- 指称门第二次加固（R27-6）：r27i-a1 实测三条绕过——① 数字按子串匹配（证据含 `2026-11-19`，候选写 `机会2` 即命中）；② 2 字引号（`「跑一」` 恰在原文）；③ 6 字套话（`把事情做到位`）。改为：引号短语 ≥4 字（`REFERENT_MIN_QUOTE_CHARS`）、共享片段 ≥8 字（`REFERENT_MIN_RUN`）、数字臂只认「独立整数 token」（见 5.38.8，第三次加固：日期/版本/小数整段不入候选集，候选侧同样按 token 切）。三条变异各自 1 failed，还原后 `soul-persona.test.ts` 全绿。参数台账：3 个常量集中在 `gates.ts` 里三个 `REFERENT_MIN_*` 常量（grep 定位）；回滚=把阈值改回 2/6/1 并把数字臂换回「两边非数字」的正则——那等于重新打开 `机会19`/`机会2026`/`机会37-19` 三个缺口，回滚说明里必须写清。
- 矩阵口径变更（R27-5）：同脚本 11-18 23:30 的 json 还是 `PASS 32 / 未验证 9`，本轮起把「只有单测引用、没有回放证据」的 19 条单列 CITED，于是变成 `14 / 8 / 19`。这不是回归，是口径变化；此后每次口径变更都要记一行。
- a2 的两条（feeling 分档模板、decay 账本为空）本轮未修，但**上一版的诊断被 r27i-a2 证伪**，这里按实测重写：
  - 库值确实在衰减：`emotion.ts` 的 `integrateMood` 每个 tick 先按经过时间衰减再落库，48h 后 dev 从 −0.353485 到 −0.176743（正好减半）；「写未衰减值、库值永不下降」是错的。
  - 0 条 decay 的真因是**留痕窗口**：`worker.ts:3146-3150` 拿「上一 tick 落库值」与「它对自身单 tick 的衰减值」比，600s 只差 8.5e-5，要 drop ≥0.01（`emotion.ts` 里 0.01 的跨档阈值，grep `0.01` 定位）大约需要 2 小时空档；生产 tick 每 10 分钟一次，所以永远不跨档。`shouldRecordMoodDecay` 本身可红（3600s/86400s 实测 true）。
  - 修法方向（下一轮）：不要改写入侧，改留痕锚点——按「上次 appraisal/regulation 或上次 decay 时的偏离」比现在，而不是按上一 tick 比。
- 尾巴仍只有 2 种文本：6 个不同 sessionId 请求同一 agent 全部返回同一 71 字（sha256 前缀 `d0a942cfddc7`），另一租户恒为 16 字「还没有形成可说的底子」；只有 `asOf` 与 `state.mood.valence` 浮点尾数在变。§5.37.6 里「不再是 16 字的纯模板」只说明长度变了，不说明它会随心境说话，已改写。

### 5.38.7 指称门的接线与 values 硬下限（R27-7/R27-8）

r27i-a3 的反证比数字更难看：把 `worker.ts:959`（update 路径）或 `:1074`（admit 路径）里的 `evidenceTexts: evidenceTextsOf(cand.episodeIds)` 删掉，`npx vitest run src/core/soul/__tests__` 仍然 **80 files / 768 tests 全绿**。原因是 identity 候选几乎都引 2 个事件，而指称门只在「恰好 1 个事件」时启用（`gates.ts` 的 `needsCostForOne = staircase && have === 1`，grep `needsCostForOne`）——单事件路径只有 gates 单测靠显式传参覆盖，接线本身没有任何用例。

改动：
1. **admit 路径有了接线回归**：`soul-worker.test.ts`「A3 Round27：单事件 identity 的指称门必须拿到证据原文（接线回归）」——只引 1 个事件（`ep-a1b2c3`）、句子里带代价词与原文里的引号短语（「没真跑就报绿」），配置 `minEvidence:1, minEpisodeEvidence:1`。变异实测：把 `:1074` 改成 `evidenceTexts: undefined` → **1 failed | 47 passed**（红在「expected +0 to be 1」），还原后 48 passed。
2. **values 的 episode 下限改为硬 2**（R27-7）：`gates.ts` 的 `Math.max(1, cfg.minEpisodeEvidence ?? 2)` 改为 `Math.max(2, …)`。`config.ts` 仍允许 1..10，但配成 1 也不会放松 values；`soul-persona.test.ts` 增加了一条 `minEpisodeEvidence:1` 的断言（values + 1 个事件仍 `episode_missing`），实测通过。
3. 台账 **R27-7**（参数）：只有 values 的下限从「配置可覆盖」变成「硬 2」；identity/self 仍 1 事件 + 代价 + 指称，narrative 仍 1；回滚=把 `Math.max(2, …)` 改回 `Math.max(1, …)`。**R27-8**（测试）：新增 1 条 worker 用例（admit 接线），无端点/字段/状态码变化。

仍未闭环：
- ~~update 路径仍是零覆盖~~：r27j-a3 给了配方（identity 原文 + 重写器只把一句话改长），用例已补——`soul-worker.test.ts`「A3 Round27：更新路径的单事件 identity 也要拿到证据原文（:959 接线）」。**坑**：改动幅度必须小于 α=0.15（先写短句再追加 6 个字会得 `alpha_exceeded`，不是 `referent_missing`），且文本完全相同会走 sameText 静默跳过；现在的写法是长句 + 结尾追加「，放弃速度。」。变异实测：把更新路径那处 `evidenceTexts` 改成 `undefined` → **1 failed**（`rep.rejections` 变成 `[{codes:['referent_missing']}]`、`updated=0`），还原后通过。
- 指称门 fail-closed（无 `evidenceTexts` 即 `referent_missing`）：接线一旦回归，identity/self 单事件准入会静默全灭。admit 与 update 两条路径现在各有一条用例（各自被单独删掉都会红），但 `evidenceTextsOf` 本身的拼装（`episodesById` 里七个字段取哪些）仍只有间接覆盖。
- 生产 `referent_missing` 至今 0 次（新门没有真实样本），`cost_missing` 3 次（09:37–09:38Z）。

### 5.38.8 数字指称的第三次加固，与「别把易变数字写进文档」

r27j-a1 第一次复核就抓到 5.38.7 的漏洞：上面那个「数字臂」仍是**子串边界**匹配——证据写 `2026-11-19`，候选写 `机会19`（或 `机会2026`）两条边都不是数字，于是日期片段被当成「点到了同一个数字」。三条变体（19 / 11 / 2026）实测全绿。

改法（`gates.ts` 的 `hasConcreteReferent` 里 numeric 段，grep `numberTokens` 定位）：先把证据原文切成**独立整数 token 集合**，含 `[./-]` 的整段（`2026-11-19`、`v1.2`、`0.01`）算一个 token 且**不入集合**，只有纯整数（`37`、`668`）才可能被点中。候选侧做同样的切分：`机会37-19` 里的 `37-19` 是一个 token、不是整数，不能拆出真的 `37` 去过门（r27k-a1 的残留绕过，已补断言，实测 referent_missing）。语义上也是对的：日期不是「具体的事」，本来就不该当指称。

测试：`soul-persona.test.ts` 增加 `机会19` / `机会2026` 两条断言（证据含 `2026-11-19 完成 37 个用例`，都应判 `referent_missing`），而 `跑完 37 个用例` 仍放行。变异：把数字臂换回「两边非数字」的旧正则 → **1 failed | 48 passed**（红在 `expected [] to include 'referent_missing'`），还原后 49 passed。

**参数台账 R27-9**：`REFERENT_MIN_NUMBER_DIGITS` 仍为 2，但匹配口径从「子串 + 边界」变成「整数 token 集合」。影响面：只有 identity/self 的单事件准入；回滚=换回边界正则，代价是重新打开 `机会19`/`机会2026`。

**本节自曝的第二个问题：文档里的易变数字**。5.38.7 里写死的 `gates.ts` sha256、`git diff` 行数、CR 个数、expect 计数（以及此后旧段落里残留的十几处 `file:line`），在文件继续被编辑后立刻全部过期，r27j-a1 逐个抓出（同一份文档里先后出现过 10、13、14 三种 expect，sha 写了 `2a27c04c` 而实测是 `a6692c5b`，diff 与 CR 数也在几分钟内变过）。这不是笔误，是写法问题：

- 文档**不写**当前 sha / diff 行数 / CR 个数，只写命令（`sha256sum …`、`git diff --numstat`、`git diff --ignore-cr-at-eol --numstat`）；
- 必须给读者一个「当时的数」时，写成**带时刻的快照**（命令写成 `date -u +%FT%TZ; sha256sum …; git diff --numstat -- <file>; git diff --ignore-cr-at-eol --numstat -- <file>`，把输出落在当轮报告里——**文档正文不存这些数**（存了必然过期，Round27 已因此被复核抓过三轮）），并说明以实测为准；
- 行号同理：要么写「函数名 + 一段可 grep 的字符串」，要么写完立刻用 `grep -n` 复核。

## 5.39 Round28：统计口径可伪造的三处、锚段粘性滞回、基线只被证据推动

### 5.39.1 这一轮的判断来自哪里

Round28 五路冷启动（a1 人格、a2 情绪、a3 记忆、a4 行为、a5 工程）**全部 FAIL**，但失败点高度集中：几乎每一条都不是「功能没写」，而是「写了但读数是真空」。三个最硬的实证：

1. **租户桶可伪造**：`soul-injection-stats-endpoint.ts` 判定本租户只比 `parts[0]`（team）与 `parts[2]`（agent），`t1//a1`（缺 user 段）、`t1/x`（两段）都能进本租户的 rows。日志里出现一条格式坏行，就能让面板显示「本租户有注入」。
2. **card-empty 双计**：同一条 card-empty 既 `agg.cardEmpty += 1` 又 `agg.cardBoundEmpty += 1`，于是四桶之和 = rows + cardEmpty，恒等式只在 cardEmpty=0 时碰巧成立（生产恰好为 0）。
3. **proof 结构性恒 0**：proof 要求「recall 的 sessionInit.hash === 卡的字段 hash」，而两者定义不同（section-read 行记的是单段 sha256、卡行记的是整卡 textHash），`persona-card.ts` 注释自认这一点。生产 sectionReadCount=41、textHashMatched=0 —— 这个 0 不是「证据没进提示词」，是断言本身没法成立。

a1 另外用变异证明锚段滞回不足：`BAND_HOLD=0.05` 只吃 <0.05 的抖动，dv 在 0.16↔0.04 之间交替时仍每 tick 翻面。a2 证明基线 EMA 在无证据的静默期也被推进，于是「比基线偏沉/还算稳」的档位可以在没有任何新证据时漂移。

### 5.39.2 改动清单（每条都实跑过）

**统计端点（`MemoryCore/src/gateway/soul-injection-stats-endpoint.ts`）**

- 本租户判定改严格三段：`parts.length < 3 || parts.slice(0,3).some((p) => p === "")` 一律归 `noIdentityRows`，不再按缺段行冒充租户。
- card-empty 只进 `agg.cardEmpty`；`cardBoundEmpty` 只统计「有绑定但 chars=0」的 card-bound。恒等式改为五桶：`rows = sectionRead + cardBound + cardBoundEmpty + cardEmpty + cardBoundFailed`。
- `unattributed` 增 `other` 桶：无身份且不属 section-read / card-bound / card-bound-failed / card-cleared 的行进这里。这样 `noIdentityRows` 等于六桶之和，「看不见的行」第一次有判据。
- section-read 行读 `ev.cardHash`（64 hex），累加到 `sectionCardHashCount` 与按会话的 Map；`proof` 重写为「段行的 cardHash === 同会话绑定行的 card.hash」（同一种 hash、同一种定义），并新增 `sectionCardHashCount`。
- 新增 `type PublicPluginAgg = Omit<PluginFailureAgg, "sectionCardHashCount" | "sectionCardHashBySession">` 与 `publicPlugin(agg)`：响应体不能带 Map，否则 JSON 序列化成 `{}` 且会把内部结构漏出去。

**插件（`dsh-plugin/src/persona-card.ts`、`injection-log.ts`）**：section-read 行补 `cardHash: card.textHash`；`InjectionLogEvent` 增可选 `cardHash`，注释写清「段 hash 是段口径，进提示词的证明看 cardHash」。

**锚段（`MemoryCore/src/core/soul/card-v13.ts`）**：删 `BAND_HOLD`，`pickBand` 改粘性 —— 上一档是「偏轻」时，只有 dv ≤ −0.15 才转「偏沉」，其余留「偏轻」（down 对称）；中间档只作首张卡初值。a1 的 0.16↔0.04 交替因此不再翻面。

**情绪基线（`MemoryCore/src/core/soul/emotion.ts`）**：`emaAlpha = events.length === 0 ? 0 : 1 - Math.pow(1 - baselineEmaAlpha(dtHours / events.length), events.length)` —— 基线只能被证据推动，静默期不再自己走；把 dt 平摊到每条事件再复合，等价于「同一批事件拆成 n 个 tick 各推一次」，所以推进量与分批无关（第一版写成 `baselineEmaAlpha(dt) * min(4, n)` 被 `soul-mood-baseline-cadence.test.ts` 的节拍不变性用例抓红）。

**指称门（`MemoryCore/src/core/soul/gates.ts`）**：`REFERENT_MIN_QUOTE_CHARS` 4 → 6（「采购订单」这类 4 字名词不再能当指称）。

**反思卡（`MemoryCore/src/core/lifecycle/reflection.ts`）**：结论卡 id 改内容寻址 `rf_<sha256(结论).slice(0,16)>`、`sessionId: reflection-<key>`，同结论重复跑是 upsert 覆盖而不是新增一行（a3 复现：两轮同结论 cards 2 / distinct 1）。

**面板（`MemoryPanel/src/panel/http/routes/chat-memory-soul.ts`、`MemoryPanel/web/src/lib/api/chat-memory-soul.ts`）**：BFF 转发 `includeTest=1` 并透传 `proof` / `excluded.testRows` / `unattributed.cleared|unconfiguredCleared|other`；Web 客户端类型与查询参数同步。

### 5.39.3 测试与反证

- `soul-injection-stats-endpoint.test.ts` 26 passed（与 card-v13 合跑 42 passed）。新增用例「Round28：缺段身份不冒充租户、无身份桶守恒、proof 用段行整卡 hash 对账」：`t1//a1` 的 card-bound 只进 `unattributed.cardBound`；无身份 turn-append 进 `unattributed.other`；`noIdentityRows` = 六桶和；proof `sectionCardHashCount: 1 / textHashMatched: 1 / sessionsWithProof: 1`。
- 旧断言按新定义改写：三处 proof 期望补 `sectionCardHashCount`；card-empty 用例期望 `cardBoundEmpty: 0` 且恒等式含 `cardEmpty`；「同会话 card.hash 与 sessionInit.hash 逐字相等」改为 textHashMatched 0（旧断言把两套定义相等当证据）。
- 写测试时踩到的坑（值得记）：新用例最初 rows/proof 全 0，原因是 ①`call()` 不传 `pluginLogPath` 会读到默认生产日志；②直接调 handler 时传 `journalOpts:{...ENABLED, enabled:false}` 会走 early-return `note:"journal_disabled"`（端点 :782-784），此时 plugin 有真 agg、proof 来自 emptyStats，于是「有行但 proof 全 0」。修法是 journalOpts 用 ENABLED 并显式传 pluginLogPath。
- `soul-card-v13-structured.test.ts` 16 passed：`at(-0.1,{tone:"偏轻"})` 期望由「还算稳」改为「偏轻」，并加链式断言 `[0.16,0.04,…]` 全部保持「偏轻」。
- `dsh-plugin` 49 files / 853 tests 全绿（新增 `cardHash` 字段未破坏既有断言）；`MemoryPanel` 38 files / 303 tests；web `tsc --noEmit` EXIT=0。
- 传输层偶发：`payload-too-large-413.test.ts` 偶发 `TypeError: fetch failed / ECONNRESET`（服务端先回包再关连接，undici 竞态）。加 `fetchBounded(url, init, attempts = 2)` 只重试一次，真回不出 413 仍红。单文件连跑 5 次全绿。

### 5.39.4 台账

- **R28-1 统计端点契约**：新增 `plugin.unattributed.other`、`plugin.proof.sectionCardHashCount`；`unattributed.cardBoundEmpty` 收紧为「有绑定但 chars=0」（旧实现把 card-empty 也计入）；`rows` 恒等式由四桶改五桶。旧响应差异：旧客户端读到的 `cardBoundEmpty` 会**变小**（card-empty 不再双计），`proof.textHashMatched` 可能从 0 变成非 0（定义改成同一种 hash）。回滚：恢复 `parts[0]/parts[2]` 宽松判定、card-empty 双加、删 `other` 与 `sectionCardHashCount` 分支并把 proof 比回 sessionInit.hash。
- **R28-2 插件日志字段**：`cardHash` 可选，缺省不出键；旧行按「无 cardHash」处理，proof 只统计带该字段的段行。
- **R28-3 锚段参数**：`BAND_ENTER` 0.15 保留，删除 `BAND_HOLD` 0.05，换档条件由「越过带边 + 回到持有带」改为「反向越过带边」；影响仅卡正文锚段一句话，回滚 = 恢复 `BAND_HOLD` 与旧的 mid 分支。
- **R28-4 情绪基线**：无证据时 `emaAlpha = 0`；有证据时按 `1 - (1 - α(dt/n))^n` 复合（n 为本轮事件条数）。影响 `soul_state.baseline_valence`：静默期不再漂，证据密集时推进量与「分多个 tick 各推一次」等价。回滚 = 回到 `baselineEmaAlpha(dtHours)`（静默期漂移会回来）。
- **R28-5 指称门**：引号下限 4→6 字。影响 identity/self 单事件 admit 的通过率（更严），回滚 = 改回 4。
- **R28-6 反思卡**：id 由时间戳改内容寻址；影响 `soul_l3_cards`（同结论不再多行）。回滚 = 恢复时间戳 id（但重复行会回来）。
- **R28-7 面板透传**：BFF 新增 `includeTest` 转发与三个可选字段；旧前端忽略新键即兼容。
- **R28-8 契约断言**：`stats.rowsBuckets.selfConsistent` 改五桶；新增 `stats.unattributed.bucketConservation`（六桶和 = noIdentityRows）与 `stats.proof.shape`（四键为 number、sectionCardHashCount ≤ sectionRead）。脚本不是端点契约，但它是「新字段有没有真值」的唯一守卫。
- **R28-9 测试与仓库**：`fetchBounded` 重试属测试稳定性改动，不影响产品；`.gitignore` 增 `.workbuddy/`；把 26 个灵魂相关未跟踪测试/脚本 `git add`（清单见提交说明），未动 MemoryPanel/starmap、docs/specs、MemoryKnowledge、dsh-plugin/src/usage-retry.ts。

### 5.39.5 实跑读数（2026-11-19 18:39–18:44 +08，未部署；数字均为当刻快照）

- 契约断言（真实三元组 team-2k12lgb650 / usr-2m7b1144d9 / agt-2m7buribzz）：**45 通过 / 0 失败 / 3 待部署**（snapshot.provenanceDrift、.resolve —— cutoff 后没有带 drift 的样本；stats.proof.shape —— 有段行但 0 条带 cardHash，插件新 bundle 未在宿主生效）。
  - `stats.rowsBuckets.selfConsistent`：rows=35 vs 28+7+0+0+0。
  - `stats.rowsIdentity.recount`：endpoint 35 vs 日志重数 35（Δ0）。
  - `stats.unattributed.bucketConservation`：当刻 noIdentityRows 与六桶和严格相等（本节数字是快照，日志持续在写，引用请重跑命令，不要抄数字）。
  - `stats.proof.shape`：sectionReadCount 41、textHashMatched 0、sectionCardHashCount 0（**Core 与插件都还没部署，这个 0 预期**）。
  - 不带 `--user/--agent` 时 agent 缺省为 `default`，租户行恒 0 —— 这是脚本参数问题，不是端点问题（跑契约务必给全三元组）。
- 本轮代码改动尚未重启 tdai-core，插件 dist 也还没重建，因此生产 `/v3/soul/injection/stats` 里还没有 `unattributed.other`、`proof.sectionCardHashCount`、段行 `cardHash`。

### 5.39.6 仍未闭环

1. **proof 生产仍为 0**：需要 Core 重启 + 插件重建 dist + 宿主重启（宿主重启会掐断当前会话，需用户同意），再观察 `sectionCardHashCount > 0`。
2. **情绪（a2）**：decay 账本已改「累计纯衰减量」（见 §5.40），生产已观测到 pending 增长（Round32 一个 tick 由 0.015871812462381285 增至 0.01652663567640611，Δ 与偏离降幅逐位相等；首条新格式 decay 预计 2026-11-19T15:53Z 那个 tick 落，此前 `soul_mood_events` 只有 11-10 两条旧格式 decay）；尾巴仍是 6 档闭集模板（valence 扫 101 点只出 5 种文本）；`emotion_intensity` 生产 8/8 行为 NULL，导致活情绪分支永不渲染。a2 测到的「偏离半衰期≈6h vs 声明 48h」是在 R28-4（基线无证据不动）之前测的，修完后需重测，不能沿用旧数字。
3. **记忆（a3）**：`recall-layered.ts` 与 `config.ts` 的「L2」同名不同义（一个是 consolidated 卡、一个是 scene extraction）；`gateway/server.ts` 的 `_l2HadFailure` 置位生产者段零覆盖（变异 `if(false)` 后 4 文件 20 测试全绿）。
4. **行为（a4）**：`includeTest` 在「三轴齐全」的真实查询形态下取不到测试行；面板 BFF 裸调缺 `MISSING_INSTANCE_ID`；usage 只回计数、无法区分「复述人格」与「恰好命中」。
5. **人格（a1）**：`evidenceIds` 混三种命名空间（episode / l1 / l0 msg），63 条 persona 的 evidenceIds>5 被 `slice(0,5)` 静默截断；`lastDrift` 仍无 anchorIds。
6. **工程（a5）**：矩阵 19 条 CITED 里 6 条引号内容在所指测试里 grep 不到；`--db2` 缺失时不报错只静默降级。
7. **外网 401**：`/v3/soul/*` 仍需 Bearer，跨网对账只能本机。

### 5.39.7 部署与生产读数（2026-11-19 18:49 +08）

- 插件：`npm run build` 后 `bash scripts/deploy.sh --skip-tests` 成功（备份 `.deploy/20261119-184928`，manifest 已装到 profile）。**宿主未重启**，所以运行中的宿主仍跑旧 bundle，段行还没有 `cardHash`。
- Core：`POST http://127.0.0.1:8446/restart`（头 `X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`；第 12 次轮询（约 2 分钟）后新代码上线（判定标志：stats 响应里出现 `unattributed.other`）。
- 生产 `/v3/soul/injection/stats`（24h，真实三元组）：rows 35 = sectionRead 28 + cardBound 7；cardBoundEmpty 0、cardEmpty 0、otherRows 0；unassociated/unconfigured 均 0；`unattributed` = {sectionRead 1165, cardBoundEmpty 4813, cleared 19, unconfiguredCleared 6, other 1989}，六桶和 7986 = noIdentityRows 7986（守恒成立）。
- 顶层 `proof` = {sectionReadCount 7, textHashMatched 0, sectionCardHashCount 0, sessionsWithProof 0} —— **sectionCardHashCount 仍为 0 是对的**：插件新 dist 已装盘但宿主未重启，旧 bundle 不写 `cardHash`。宿主重启后才能期望它 > 0。
- 契约断言（真实三元组）：45 通过 / 0 失败 / 3 待部署（两个 provenanceDrift 项 + stats.proof.shape —— 后者是「形状对但段行还没带 cardHash」，宿主未重启）。
- /v3/soul/card 与 /v3/soul/turn 当场可读（版本/chars/hash 每次渲染都会变，引用请重跑命令，不要把数字抄进结论）；尾巴仍是分档模板，见 5.39.6 第 2 条。

### 5.40 decay 账本改「累计纯衰减量」（2026-11-19 19:0x +08）

#### 5.40.1 为什么旧写法必然记不出账

旧 decay 分支只在「本轮没有情绪事件」时比较**上一 tick 落库的偏离**与**同一值再单独衰减一个 tick 的偏离**：48h 半衰期下 10 分钟 tick 单步只退约 7e-4，阈值却是 0.01，要连续静默 1.5–2.3h 才可能第一次记账。生产实测：真实租户 appraisal 39 / regulation 47 / **decay 0**；11-13T03:53Z→11-16T02:31Z 的 70.6h 空档里生成了 417 张快照，decay 仍是 0；全库仅 2 条 decay，且属别的 agent、note 为旧格式。

#### 5.40.2 改法

- `emotion.ts` 导出 `MOOD_DECAY_LEDGER_MIN_DROP = 0.02`、`MoodDecayPendingState`、`stepMoodDecayLedger(...)`：只累「纯衰减量」——即 `decayMoodTowardBaseline` 本 tick 真正退掉的那部分，**不含调节拉回**。攒够 0.02 落一行事件、清零并把 `since` 推到当前 tick。
- delta 符号按偏离方向：dev 为负（低于基线）时 delta 为正（向基线回），正偏离时 delta 为负。
- `worker.ts`：读上一行 mood state（失败只 warn）→ 算 `tickDecayValence = |prevState.valence − prevDecayed.valence|`（arousal 同理）→ `direction = (prevState?.valence ?? mood.valence) − mood.baselineValence` → 调 `stepMoodDecayLedger` → 把 pending 三列写回。note 形如「无新事件，Xh 内按半衰期 48h 累计衰减（累计 0.021，偏离 -0.40 → -0.38）」。
- schema：`soul_mood_state` 新增 `decay_pending_valence` / `decay_pending_arousal` / `decay_pending_since` 三列（建表 DDL + 迁移三条 ALTER）；`mapSoulMoodStateRow` 把 NULL 读成「还没起算」，`upsertSoulMoodState` 的列/值/ON CONFLICT 同步。

**中途废弃的一版**（记下来避免重犯）：曾用「锚 = 上次记账时的偏离 + 粘性阈值」，两个 24 tick 用例直接打红——① 把 `regulation.applied` 当「状态变化」会在 |dev|≥0.35 期间每 tick 复位锚；② 去掉 regulation 后，调节拉回的 20% 被当成衰减，24 tick 记出 8 条假 decay。

#### 5.40.3 测试与反证（均实跑）

- 新建 `MemoryCore/src/core/soul/__tests__/soul-mood-decay-anchor.test.ts`（6 tests）：首次只起算不记账；423 tick / 70.6h 必须记账，累计幅度 >0.02 且总量 >0.1；不足阈值 `since` 不动；攒够后 delta 0.021、hours 10、清零、`since` 推 now，正偏离 delta −0.021；纯衰减为 0 时 24 tick 记 0 行；`minDrop` 可配。
- `soul-mood-store.test.ts` 增「衰减累计随当前态落库」（null → 0.021 / 0.004 / since）。
- 变异：M1 worker 传 `minDrop: 999` → `p5-mood-e2e` 2 failed；M2 写回时丢掉 `decay_pending_valence` → `p5-mood-e2e` 1 failed；还原后 6 passed。

#### 5.40.4 台账

- **R28-10 心情状态 schema**：`soul_mood_state` 增三列（见上），NULL = 还没起算。`/v3/soul/*` 端点字段与状态码无变化（mood state 不上响应，尾巴文本口径不变）。回滚 = 删这三列 + 把 decay 分支恢复成 `shouldRecordMoodDecay(prevState − baseline, prevDecayed − baseline, threshold)`。
- **R28-12 契约新断言**：`stats.unattributed.other.recount` —— 端点 `other` 桶与日志独立重数（无身份、非四类计账事件、非清卡）逐一比对，不等则复取端点再比。反证：把 endpoint 的 `agg.unattributed.other += 1` 临时改 `+= 0` → 实测 `44 通过 / 2 失败 / 3 待部署`（另一条红是 bucketConservation），还原后恢复 `46 通过 / 0 失败 / 3 待部署`。它补的是 5.40.3 没覆盖的洞：`bucketConservation` 是「每条无身份行必经某个 if/else」的恒真式，单靠它发现不了分支写错。
- **R28-11 记账参数**：`MOOD_DECAY_LEDGER_MIN_DROP = 0.02`（原阈值 0.01 保留给「一次 tick 内就跨档」的极端情形）。影响只在 `soul_mood_events` 的 decay 行数量（变多）与 note 文本；回滚 = 调大该常量。

#### 5.40.5 部署与读数（2026-11-19 19:0x +08）

- Core `POST /restart`（头 `X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`，第 11 次轮询 `/health` 200。
- 迁移生效：`PRAGMA table_info(soul_mood_state)` 已含三列。部署后第一个 tick 的 pending 仍是 NULL（刚起算）；第二个 tick 起可见累计值递增（当刻快照：`decay_pending_valence` ≈ 7e-4、`decay_pending_since` 为上一个 tick 时刻）。按 48h 半衰期与 10 分钟节拍推算，单 tick 退约 7e-4，攒够 0.02 需约 28 个 tick（≈4.7h）才落第一条新格式 decay —— 本轮观测窗口内还没有 decay 行，不能写成已验证。
- 未闭环：pending 增长与首条新格式 decay 事件尚未在生产观测到；历史 2 条旧格式 decay 不重写；「偏离半衰期」需在 R28-4 之后重新实测。

### 5.41 底子行四档：把「偏沉」拆出「略偏沉」（2026-11-19 19:3x +08）

**5.41.1 起因**：r28f-a2 复核判据 2 时做了离线扫描——`renderMoodLine` 在 valence −0.9..0.9 的 181 个采样点上只产出 5 种文本（很沉/偏沉/平静/偏积极/很积极），读侧看不出「偏差 0.2」与「偏差 0.4」的区别；生产连续三次 `/v3/soul/turn` 逐字节相同（chars 71），sessionId 只进 state，不进文本。

**5.41.2 改法**：`emotion.ts` 的 `baselineToneOf` 由三档改四档——|Δ| ≤ 0.10 平静 / ≤ 0.25 略偏（新增 tier `slight`）/ ≤ 0.45 偏 / > 0.45 很。闭集性质不变（确定性模板，不引入第二模型端点），可判读粒度从 3 档提到 4 档 = 全量程 7 句 + 无样本 1 句。`renderMoodLine` 只在「没有存活情绪」时走它，活情绪分支的文字未动。

**5.41.3 测试与反证**：`src/core/soul/__tests__/soul-mood-baseline.test.ts` 8 tests；新增「R28：valence 全量程里至少读出 7 种不同底子」按 0.01 步长扫全量程断言 `seen.size >= 7`。变异：把 0.10/0.25 两档合回旧的 0.15 单档 → 该文件 4 failed（含 grid 断言），还原后 8 passed。定向回归 `npx vitest run src/core/soul src/gateway/__tests__/soul-card-endpoint.test.ts src/gateway/__tests__/soul-injection-endpoint.test.ts src/gateway/__tests__/soul-injection-stats-endpoint.test.ts` → 84 files / 832 tests passed；`node scripts/typecheck-gate.mjs` → 121 errors / 23 files（基线 149/28，Δ−28）。

**5.41.4 台账 R28-13（参数）**
- 参数：底子行分档阈值 0.10 / 0.25 / 0.45（旧 0.15 / 0.4）；tier 枚举增 `slight`。
- 契约：`/v3/soul/turn` 与 `/v3/soul/card` 的字段、状态码、长度上限均无变化；差异只在无存活情绪时的底子句可能从「偏沉」变成「略偏沉」（|Δ| 落在 0.10–0.25 区间时）。
- 旧响应差异：同一条租户在 0.10–0.25 偏差区间的尾巴文案变了；下游若按字符串匹配「底子偏沉」需接受「底子略偏沉」。
- 回滚：把 `baselineToneOf` 的 0.1/0.25 两行合回 `if (abs <= 0.15)`，tier 联合类型去掉 `slight`，删 grid 用例（其余调用点不接受 `slight`，无需改）。

**5.41.5 仍未闭环（a2 的 CP4/CP5）**
- CP4：生产 `soul_state.emotion_intensity` 为 NULL，意味着「曾经有过情绪，但按半衰期×6 过期了」——`card-service.ts` 的 `emotionLive` 要求 `intensity > 0.01` 且未过期，所以活情绪分支在生产命中不到。这不是分支坏了：合成 `intensity=0.8` 的用例能渲染（`card-service.test.ts` 有专门断言）。缺的是「过期但仍可回指」时的可读句——目前只保留 `emotionLabel`/`emotionObject`，尾巴退回底子行。
- CP5：`sample_count` 累计的是**吸收过的 L1 信号条数**（`emotion.ts` 的 `integrateMood` 返回值），不是 `soul_mood_events` 账本行数（账本只记 appraisal/regulation/decay 三类事件）。两个数天然不可对账；生产 `sample_count=200` 是上限截断值，真实非 work episode 只有 56。
- 闭集模板仍是判据 2 的上限：全量程 7 句 + 无样本 1 句，同状态必同文本。要再细就得引入生成式措辞（本轮明确不做：不引入第二模型端点）。

**5.41.7 a2 复投读数（r28h-a2，冷启动）**：离线（valence −0.9..0.9 步 0.01 × baseline {0, 0.3, −0.2} = 543 个采样点）distinct = **7**（很沉/偏沉/略偏沉/平静/略偏积极/偏积极/很积极）；生产三次 `/v3/soul/turn`（s1/s2/s3）逐字相同，state valence 0.20502582/0.20502590/0.20502594、dev −0.30282 落在 (0.25, 0.45] → 「底子偏沉」与四档口径自洽；同状态同文本是闭集模板的设计上限（每档约 0.13，0.28 与 0.30 读不出差别）。decay 累计：pending 11:36:17.742Z 0.0024968438 → 11:47:03.704Z 0.0032811233（速率 0.00437/h，since 仍 11:11:40.395Z），推算首条 `累计衰减` 落在 2026-11-19T15:43Z 前后；反证把阈值 0.02 改 0.5 → 同文件 3 failed/3 passed。半衰期反算 48.0000h（误差 <1e-6）。CP4 结论：`emotion_intensity=NULL` 与「分支坏了」同形，靠 age 与 6×templateHalfLifeHours 区分（`意外` 1h → 到期窗 6h，emotion_at 已 24h → 预期 NULL）；合成 intensity 0.8 能渲染「因为『假绿』反复出问题」，**生产命中不到活情绪分支属于覆盖缺陷（存活窗 <6h），不是逻辑缺陷**。CP5 结论：`sample_count` = base + 本轮 fresh L1 情感信号条数（`recentAffectSignals` 96h 窗口、**LIMIT 200**），窗口实有 405 条信号 → 200 是截断值，不是账本行数、不可对账；跨 tick updated_at 前移而计数恒 200 证明无重复计数。收尾建议（未做）：把 sample_count 改名/改口径为「可复算的窗口回放量」，并把 NULL 拆成「从未有 / 已过期」两个可观测状态。

**5.41.6 部署与读数**：Core `POST http://127.0.0.1:8446/restart`（头 `X-Tdb-Control: 1`）→ `{ok:true,accepted:true}`，第 7 次轮询 `/health` 200。部署后生产 `/v3/soul/turn` → chars 71「近期心境：底子偏沉。\n记得：在run_code上，我给自己八成把握，668 次里成了 175 次、没成 493 次。报得比实际高约 0.64。」——当刻 |Δ|≈0.30 落在 0.25–0.45，仍是「偏沉」，与四档口径自洽；`/v3/soul/card` v1222 chars 1246 anchor「比基线偏沉，松紧和平时差不多。」25 字不变。

## 5.42 Round29：历史重复合并、lastCard 散列改名、出处截断可见、L2 产物抽出、面板读集群桶

> 定位约定：本节不写死 sha/行号/用例数这类每轮必漂的数字；要复核就照命令重跑，读数注明「当刻快照」。

### 5.42.1 判据 3 的真实缺口：历史 46 行逐字节重复

判据 3（记忆分层增量融合）此前只按「内容键」验新写面，实际库里还留着旧随机 id 时代的存量重复：
同租户 + 正文逐字节相同的组数在当刻库是 23 组 / 46 行（每组两行）。既有 `scripts/merge-legacy-l1-duplicates.mjs`
走的是 normalizeForId 口径（会先剥标点再比），只认 4 组，漏掉 19 组——第二套口径反而更窄。

新脚本 `MemoryCore/scripts/merge-legacy-l1-exact-duplicates.mjs`：

- 分组键 = (team_id, user_id, agent_id, content 逐字节)；保留 `ORDER BY created_time ASC, record_id ASC` 的第一行；
- 其余整行写 `l1_archive`（`reason='legacy_exact_duplicate'`，`data` 存整行 JSON，租户列缺失时兜 `'default'`）后 `DELETE` 出 `l1_records`；
- 同步 `DELETE FROM l1_fts WHERE record_id=?`——`l1_fts` 是独立 FTS5 表（25 列，不是 external-content），可以直接删；
  曾经写过的 `INSERT INTO l1_fts(l1_fts) VALUES('rebuild')` 是从 `l1_fts_content` 重建，删不掉已删行，已移除；
- `vec0` 虚拟表在 CLI/node:sqlite 里加载不到扩展（`no such module: vec0`），删除向量会抛错 →
  `tryVec()` 捕获后跳过并在结果里标 `vectorDeleteSkipped: true`。残留向量不会让记录复活：召回拿到 id 之后仍要回 `l1_records` 取正文；
- 默认 dry-run；`--apply` 前自动 `VACUUM INTO` 备份。

实跑（当刻快照）：备份 `D:/TDB/data/backups/pre-r29-l1-merge-2026-11-19T11-57-29-955Z.db`；
输出 `{ok:true, archived:23, remainingDupGroups:0, rows:14048, vectorDeleteSkipped:true}`；
复核 `l1_records` 14048 行、重复组 0、`l1_archive` 中 reason='legacy_exact_duplicate' 23 行、FTS 查询未受损。

### 5.42.2 lastCard.hash → lastCard.textHash（契约台账 R29-1）

- 端点：`GET /v3/soul/injection/stats`
- 字段：`data.lastCard.{version,textHash,chars}`（原 `hash`）
- 用途：面板/契约要判断「插件记的整卡散列」与「/v3/soul/card 的 material hash」不是同一个东西——插件侧记的是
  `sha256(卡正文)`，而 `GET /v3/soul/card` 的 `hash` 是 material hash；同名不同义在 r28e-a4 已经被误判过一次。
- 旧响应差异：旧键 `hash` 消失，新键 `textHash` 出现；状态码/其余字段不变。
- 回滚：把类型与赋值改回 `hash`，并把为 `textHash` 写的注释与断言一并删除（面板与 i18n 的 `{{hash}}` 占位符同步回改）。

### 5.42.3 快照出处截断可见（契约台账 R29-2）

`soul_snapshots.payload.provenance.items[]` 的出处此前一律 `slice(0,5)`，读快照的人会以为只有 5 个出处。
现在：条目出处 >5 时写 `{evidenceIds: [...5], evidenceTotal: N}`；≤5 时保持原样、不出 `evidenceTotal` 键。

- 端点：快照写入路径（`MemoryCore/src/core/soul/card-service.ts`，常量 `PROVENANCE_EVIDENCE_MAX = 5`）
- 用途：让「被截断」这件事本身可被读出来，而不是靠比对总数才知道
- 旧响应差异：只在 >5 的条目上多一个键；`/v3/soul/card` 响应体不变
- 回滚：删 `evidenceTotal` 分支与常量，恢复无条件 `slice(0,5)`

### 5.42.4 L2 失败产物抽成可单测的函数

`gateway/server.ts` 里两段原地置位（`_l2Skipped` / `_l2HadFailure`）挪到 `MemoryCore/src/services/l2-outcome.ts` 的
`markL2Outcome(task, result)`：`skipped` → `_l2Skipped`；`hadFailure === true` → `_l2HadFailure`；结果为空则不动。
动机是 r28c-a3 的反证——把 gateway 的置位改掉、全仓依然全绿，因为生产侧那段代码没有测试能碰到。
新增用例除了三个行为断言，还有一条「源码断言」：`server.ts` 里必须出现 `markL2Outcome(task..., result)` 且旧原地置位已消失。

### 5.42.5 面板读集群未归因桶与端到端对账

新增 `MemoryPanel/web/src/lib/soul-injection-summary.ts`：`unattributedRows()`（非零桶按固定顺序，0/缺键/NaN/负数不进）、
`proofSummary()`（分母 0 且段读 >0 时 `hostPending=true`）。`InjectionHealthBar` 在清卡徽标之后加一段：
「未归因（集群）：段读 N · 无卡 N …」+「对账命中 x/y 会话」或「对账待宿主上报」。
桶中文标签暂用组件内 `BUCKET_LABEL`（i18n 键未建，记为 P2 债），三条文案走 i18next `defaultValue`，不新增键。

### 5.42.6 契约台账 R29-3：新增两条断言

- `snapshot.provenanceEvidence`：有 `evidenceTotal` 的条目必须 `evidenceIds.length === PROVENANCE_EVIDENCE_MAX` 且 `evidenceTotal > 5`；无样本记待部署。
- `stats.lastCard.textHash`：`lastCard` 存在时 `textHash` 为字符串且旧键 `hash` 不在对象里；无绑定行记待部署。

当刻读数：契约 `通过 47 / 失败 0 / 待部署 4`（`snapshot.provenanceDrift`、`.resolve`、`stats.proof.shape`、`snapshot.provenanceEvidence`）。

### 5.42.7 验收与部署（当刻快照）

- `node scripts/typecheck-gate.mjs`：PASS（121 errors / 23 files，基线 149/28，Δ−28）
- `MemoryCore npx vitest run`：488 files / 4563 tests 全绿
- `dsh-plugin npm test`：49 files / 853 tests；`MemoryPanel` 38/303；`MemoryPanel/web` `tsc --noEmit` 退出 0
- 41 矩阵：PASS 14 / 未验证 8 / CITED 19 / FAIL 0（未验证 A4/B5/B6/B8/B9/B10/B12/E2）
- Core 已重启部署（`POST /restart` + `X-Tdb-Control: 1`，冷启动约 2 分钟）；生产 `GET /v3/soul/injection/stats` 的
  `lastCard` 现为 `{version,textHash,chars}`，六桶和与 `noIdentityRows` 相等（当刻 8132）
- 插件宿主仍未重启：段行不带 `cardHash`，`proof.sectionCardHashCount` 仍为 0 —— 这是待部署状态，不是通过。

### 5.42.8 仍未闭环

1. `proof` 仍为待部署：宿主**已**重启（DeepSeek Harness pid 48176，`StartTime 2026/11/19 20:25:37`），
   但进程里跑的还是**旧插件产物**（20:34/20:55 写出的行不带 `hash`/`cardHash`），`dsh-plugin/dist`（18:49）虽已含
   `cardHash: card.textHash` 却没被加载。判据要等宿主重新加载新 bundle 才可能转绿。
2. 外网 `/v3/soul/*` 仍 401（Round30 已开本机回环内部通道，见 §5.43；跨机仍需网关侧方案）。
3. 面板桶标签无 i18n 键（P2）；`InjectionHealthBar` 无组件级用例，改无条件渲染不会红（P2）。
4. `merge-legacy-l1-exact-duplicates.mjs` 的向量残留未清理（vec0 扩展缺失），需在带扩展的环境补一次。
5. `lastCard.textHash` 目前只在契约与面板注释层面对齐，尚无「插件行 textHash == sha256(卡正文)」的跨端断言（宿主重启后可补）。

### 5.43 内部通道：本机回环的只读 soul 面免 Bearer（2026-11-19 20:4x +08）

#### 5.43.1 起因

用户裁定（Round30 开局，原话「重启了，开内部通道吧」）：/v3/soul/* 的外部 401 一直是 P0 ——
运维脚本、面板 BFF、探针拿不到 `TDAI_GATEWAY_API_KEY` 就一律 401，四者对账只能靠人手抄 token。
Redis/网关那一层不动，本次只开**本机回环**这一条只读通道。

#### 5.43.2 实现

- `MemoryCore/src/gateway/soul-internal-channel.ts`：
  - `isLoopbackAddress(addr)` 只认 `127.*` / `::1` / `::ffff:127.0.0.1`（`localhost` 不算，避免 DNS 解析层被改）；
  - `soulInternalChannelEnabled(env)` **默认开**，只有显式 `off|0|false|no` 才关。
- `server.ts` 新增 `private checkSoulReadAuth(req,res)`：开关开且 `req.socket.remoteAddress` 是回环 → 放行，否则退回 `checkAuth`（Bearer）。
  - 改用它的只有**只读**两处：`/v3/soul/card|turn|trait-state|emotions|labels|person*` 家族，与 `/v3/soul/injection/stats`；
  - 写入三处（`/v3/soul/injection`、`SOUL_EVENT_PATH`、`SOUL_GATE_PATH`）保持 `checkAuth`；
  - 判定只看 TCP 对端地址，不看 `X-Forwarded-For` 之类可伪造头。

#### 5.43.3 为什么是「默认开」而不是「显式开」

第一版按「显式 on 才开」写的，把 `$env:TDB_SOUL_INTERNAL_CHANNEL = 'on'` 追加进
`D:/TDB/etc/env.ps1` 后只 POST 了 `8446/restart`，实测仍是 `card=401 stats=401 event=401`：
env.ps1 由 supervisor（`start-tdb-supervised.ps1`，pwsh）在**启动时** dot-source，
控制面 restart 只换 Core 进程、不重读 env。默认开就不依赖 supervisor 级重启；
Core 只 listen `127.0.0.1:8420`（netstat 实证），回环即本机，风险面等于本机进程。
要关：`TDB_SOUL_INTERNAL_CHANNEL=off` 后重启 supervisor（不是只重启 Core）。

#### 5.43.4 契约台账 R30-1

- 端点：`GET /v3/soul/card|turn|trait-state|emotions|labels|person*`、`GET /v3/soul/injection/stats`。
- 字段/状态码：**响应体与字段一字未改**；变的只有鉴权结果 —— 本机回环无 Bearer 由 `401` 变 `200`。
- 用途：本机面板 BFF / 对账脚本 / 探针直接读，不必再分发 key。
- 旧响应差异：仅限「无 Authorization 且来自回环」；带 Bearer 的请求行为逐字不变；非回环请求仍 401。
- 回滚：`TDB_SOUL_INTERNAL_CHANNEL=off` 并重启 supervisor；或把 `soulInternalChannelEnabled` 默认值改回 `false` 后重启 Core。

#### 5.43.5 测试与反证

`MemoryCore/src/gateway/__tests__/soul-internal-channel.test.ts`（3 tests）：回环判定正反例、开关默认开/`off` 关、源码接线断言
（只读两处走 `checkSoulReadAuth`、写入三处仍 `checkAuth`、判定只用 `req.socket?.remoteAddress`）。
反证：把只读那两处改回 `checkAuth`，源码断言立即不匹配（`orig_match=true / mutated_match=false`）。

#### 5.43.6 部署与实测（20:38 restart，20:41 上线）

```
GET  /v3/soul/card             (无 Authorization) -> 200
GET  /v3/soul/turn             (无 Authorization) -> 200
GET  /v3/soul/trait-state      (无 Authorization) -> 200
GET  /v3/soul/emotions         (无 Authorization) -> 200
GET  /v3/soul/injection/stats?team=<team>  (无 Authorization) -> 200
GET  /v3/soul/injection/stats                (无 Authorization) -> 400 missing_team（参数校验，与鉴权无关；带 Bearer 但不带 team 同样 400）
POST /v3/soul/event            (无 Authorization) -> 401
POST /v3/soul/injection        (无 Authorization) -> 401
POST /v3/soul/gate             (无 Authorization) -> 401
```

#### 5.43.7 生产者侧缺口：`section-read.cardHash` 没人守

Round29 的 proof 只在**消费端**（Core stats）有用例；插件侧把 `cardHash` 那行删掉，插件测试仍全绿。
新增 `dsh-plugin/test/persona-card-cardhash.test.ts`（3 tests）：段读行 `cardHash` = `sha256(整卡)` 且与同会话
`card-bound.hash` 逐字符相等；旧 Core 不带 `textHash` 时本地兜底；`no-card` 行不得伪造 `cardHash`。
反证：删掉 `persona-card.ts` 的 `cardHash: card.textHash,` → 2 failed | 1 passed；还原后 3 passed。

#### 5.43.8 仍未闭环

1. 外网（非回环）仍 401 —— 本次只开本机回环，跨机访问仍需网关侧方案。
2. `proof.sectionCardHashCount` 结构性为 0，是两件事叠加：
   ① 根会话在 2026-11-19T17:31:28+08 的 Core 重启窗口里候选拉取 `transport failure: fetch failed` 被记 skip，其 176 个分支继承空三元组（产品决策「身份由用户选择」只覆盖 4 条 `user-declined`，不覆盖这一棵）→ 新回合的 `section-read` 以 `reason:"no-card"` 为主
   （实测 30 条段读：20 条 `no-card`、10 条**没有 reason**——`sidSource:"none"` 走的是
   `dsh-plugin/src/persona-card.ts:754-762` 那条「宿主没给会话键」的分支）；
   ② 宿主里跑的是旧 bundle → 历史 8 条 `card-bound`（chars>0，证明**卡是取到了的**）与段行都不带 `cardHash`
   （段读行数写作时 260 条、12:55Z 复核时 270 条——日志单调追加，引用请带时刻；
   注意 `stats.plugin.sectionRead` 是租户+窗口分母，与全文件行数不可直接比）。
   所以不能把成因写成「插件取不到卡」；该判据只能在「绑定身份 + 新 bundle」的会话里成立。
3. `/v3/soul/card` 只读 query 参数、忽略租户头；**裸调会静默回落到 `default` 桶**并返回一张
   `version=0 / chars≈267 / dirty=true / seeded=false` 的合成卡（哈希自洽，看不出是假的）。
   面板或脚本拼 URL 时若不慎漏掉 `team/user/agent`，会拿到这张假卡而不报错——照 §6 的空值模板抄就会踩到。

## 5.44 Round30 收口：`includeTest` 从空转到可断言、pending 的 since 偏置一 tick（2026-11-19 21:0x +08）

### 5.44.1 现象：`includeTest=1` 曾是空转参数

`soul-injection-stats-endpoint.ts` 的测试身份分支只做了 `if (!scope.includeTest) continue;`——不再跳过之后，同一行继续往下走，
在租户比较（`parts[0] !== scope.teamId || parts[2] !== scope.agentId`）处被**静默丢弃**。于是「显式可取回」在生产上与默认逐字节相同：
实测 `rows` 36 / `unassociated` 0 / `excludedTestRows` 3645 三个数字在 `includeTest=0|1` 下完全不变。契约里原有的
`stats.testExcludedByDefault` 只查「默认侧 rows===0」，对这条空转不敏感（默认侧本来就 0），所以两轮五路复核都没抓到。

### 5.44.2 改法

- `PluginFailureAgg` / 公开 `plugin` 类型 / `emptyStats` 增 `includeTest: boolean` 与
  `testRows { rows, sectionRead, cardBound, cardBoundEmpty, cardBoundFailed, cleared, otherRows }`。
- 测试身份行：默认只进 `excludedTestRows`（事实计数，与是否取回无关）；`includeTest=1` 且行身份**等于查询租户**时当正常行计账（否则本人的测试租户永远恒 0）；
  `includeTest=1` 但身份属于别的租户时落 `testRows` 独立桶后 `continue`，**永不进租户 rows，也不进 unattributed**（租户视角读不到别人的数字这条不变）。
- 恒等式：`testRows.rows + testRows.otherRows + testRows.cleared === excludedTestRows`（每条测试行恰好落一个桶）。

### 5.44.3 测试与变异

`MemoryCore/src/gateway/__tests__/soul-injection-stats-endpoint.test.ts` 新增「Round30：includeTest=1 才把测试身份行取回到 testRows，且永不摊进租户计数」：
默认 `excludedTestRows` 4 / `rows` 1 / `testRows` 全 0；`includeTest=1` → `rows` 仍 1、`testRows.sectionRead` 1、`cardBound` 1、`cardBoundFailed` 1、`otherRows` 1、`rows` 3，且上面那条恒等式成立；
另一个用例查**自己的测试租户**：`team=t1-test` 默认 `rows` 0、`includeTest=1` → `rows` 3 且 `testRows.rows` 0。文件 27 tests 全绿（原 26）。
变异：把 `agg.testRows.rows += 1` 改 `+= 0` → 该用例 1 failed | 26 skipped；还原 27 passed。

### 5.44.4 契约台账（R30-2）

端点 `GET /v3/soul/injection/stats`，字段只增不改：新增 `plugin.includeTest`（boolean）与 `plugin.testRows.*`（7 个 number）。
旧响应差异：旧版本没有这两个键（客户端按 `undefined` 处理即可）；`plugin.excludedTestRows` 语义不变（集群级事实计数）。回滚：删这两个键与 `testRows` 计数分支，恢复「includeTest 只控制是否 continue」的旧行为。
新增断言 `stats.includeTest.retrievable`：窗口内 `excludedTestRows > 0` 时，`includeTest=1` 必须返回 `includeTest===true`、`testRows.sectionRead` 为 number，且
`testRows.rows+otherRows+cleared === excludedTestRows`；窗口内没有测试行则记 pending（不用「两侧都是 0」假装通过）。

### 5.44.5 部署与读数（2026-11-19 21:0x +08）

Core `POST http://127.0.0.1:8446/restart`（头 `X-Tdb-Control: 1`）→ 第 18 次轮询 `/health` 200。生产无 Bearer（本机回环，见 §5.43）：

| 请求 | plugin.includeTest | plugin.testRows | plugin.excludedTestRows | plugin.rows |
| --- | --- | --- | --- | --- |
| 默认 | false | 全 0 | 3645 | 36 |
| `&includeTest=1` | true | rows 3645 / sectionRead 318 / cardBound 265 / cardBoundFailed 3062 / otherRows 0 | 3645 | 36 |

契约：**48 通过 / 0 失败 / 4 待部署**（`snapshot.provenanceDrift`、`snapshot.provenanceDrift.resolve`、`stats.proof.shape`、`snapshot.provenanceEvidence`）。

### 5.44.6 a2 复核发现的读数偏置：`decay_pending_since` 比实际累计窗口晚一 tick

`emotion.ts` 在首步把 `since` 钉在该 tick 的 `now`，而 `worker.ts` 算的 perTick 量跨的是**上一 tick 的 updated_at → 本 tick**。
结果 pending 恒比「从 `since` 起算的闭式解」多约 0.95 个 tick（实测 12:50:55 pending 0.007892 vs 闭式 0.007196，×1.0966；13:00:57 0.008610 vs 0.007914，×1.0879）。
影响：只影响「Xh 内累计衰减」这行 note 的时长口径（少算约 10 分钟），不影响落账阈值与总量。判据 2 仍按「pending 在增长、note 口径正确」判 PASS，此偏置记为 P2 债（修法：把首个 step 的 Δt 按 `since - prevUpdatedAt` 折算，或把 `since` 钉在 `prevUpdatedAt`）。

### 5.44.7 仍未闭环

1. 宿主仍跑旧插件 bundle（`cardHash` 未产出）→ `stats.proof.shape` 一直判 `pfStale`（待部署，不是通过）。
2. `snapshot.provenanceEvidence` 与 `snapshot.provenanceDrift(.resolve)` 无生效后样本：最新快照早于代码 mtime，需一次真实渲染。
3. `kind='decay'` 的 2 行是 2026-11-10 旧措辞，与本轮账本不同源；用 `kind` 判账本会误判「已落账」，须按 `note LIKE '%累计衰减%'`。

### 5.45 身份事实的「他/我」错位：stance_missing 761/日 的真正来源（2026-11-19 21:2x +08）

#### 5.45.1 现象与读数

- `soul_gate_stats` 2026-11-19 当天**全租户合计**（13:17Z 读数，当日仍在累计）：`dilemma_missing` 770、`stance_missing` 768、`episode_missing` 522、`prefilter_no_episode` 618 —— 前两个码数量几乎相等，说明**同一批句子连续撞多个门**。逐 agent 更直接（两个码多数成对、两组差 1）：`agt-bbr29z58s2` 257/256、`agt-h6dp2dvr4a` 240/240、`agt-fa0u5mi7x4` 124/124、`agt-dofal7hgfe` 78/78、`agt-2m7buribzz` 71/70（`stance_missing`/`dilemma_missing`）。一个候选句同时被要求「第一人称立场」和「两难取舍」，两条判据对描述句必然同时不成立。
- `stance_missing` 逐日：11-11 1737、11-14 1688、11-18 1664、11-19 761（不是已降到 0）；全量 SUM `stance_missing` 15523、`dilemma_missing` 15621、`episode_missing` 17806。
- `core_memory` 里 `identity` / `self_identity` 槽**一行都没有**（只有 `strict_rule` 4 行）——这条产线自 2026-11-07 起没产出过任何身份事实。

#### 5.45.2 根因：主语被两头丢掉

1. **producer 侧**：`identity-discovery.ts` 的 `DISCOVERY_SYSTEM_PROMPT_DUAL` 明确分两槽——slot `identity` = 用户身份（他是谁/他的职责/他的角色），slot `self_identity` = agent 自我；legacy prompt（`DISCOVERY_SYSTEM_PROMPT`）里 slot `identity` 才是 agent 自己。producer 把主语信息**丢掉**了：只返回 `{layer, text, evidenceIds}`。
2. **worker 侧**：`worker.ts` 的 identityFacts 分支注释写着「self_identity 是旧槽名，统一落到 identity（D2）」，于是**所有事实一律 `layer: "identity"` 送进闸门**。
3. **结果**：用户身份描述句（「他负责发布与回归」）被当成 agent 身份更新，`gates.ts:745-751` 要求第一人称立场（`hasStance`）、`:706-712` 要求两难取舍（`hasDilemma`）——描述句必然全挂。今日 `stance_missing` 770 与 `dilemma_missing` 768 **几乎逐 agent 相等**（见 §5.45.1 的逐 agent 表），正是「同一批句子连过两门」；`episode_missing` 是 522 ——更低，因为 Round23 已把结构上过不了门的候选挡在闸门外（`prefilter_*`），剩下的才是过了 prefilter 又被立场/两难拒的。

这不是「模型提案质量差」，是**主语在写侧被抹平**。判据 1 要求的「有证据才定向漂移」在这里退化成「永远不漂移」。

#### 5.45.3 改法（不放宽任何门）

| 层 | 改动 | 为什么不是放宽判据 |
| --- | --- | --- |
| producer | `IdentityFact` 增 `subject?: "agent" \| "user"`；双槽下 slot `identity` → `user`、`self_identity` → `agent`；legacy 一律 `agent` | 只是把已经在 prompt 里区分过的主语带到下游，判据本身没动 |
| worker | `f.subject === "user"` → `bumpPrefilter("identity", "prefilter_user_identity")` 后 `continue` | 用户身份事实不属于人格层（人格层 identity 是 agent 的自我）；挡在闸门外并按独立码计数，和 R23-1 的 `prefilter_no_episode` 同一形态 |
| prompt | 两份 system prompt 各加一条带同一标记「1b. 【形态】」的形态要求：身份事实必须带取舍或立场（我宁可X也不Y / 我拒绝… / 我坚持…，给出代价或例外），纯职务描述不要提案；双槽版把同一条挂在 `self_identity` 上，并注明 identity 槽只写用户身份、不要把 agent 自我写进去（`identity-discovery.ts:61` legacy / `:85` dual） | 与 `hasStance`/`hasDilemma` 的既有要求对齐；此前 prompt 要「描述类」，与门的要求自相矛盾 |

#### 5.45.4 测试与变异

- `MemoryCore/src/core/lifecycle/__tests__/identity-discovery-collect.test.ts`：「R31-1：双槽开启时 slot identity 标 user、self_identity 标 agent；legacy 一律 agent」。
- `MemoryCore/src/core/soul/__tests__/soul-worker-single-line.test.ts`：「R31-1：subject=user 的身份事实不进人格候选，单独记 prefilter_user_identity」。
- 变异 M1：`if (false && f.subject === "user")` → worker 测试 1 failed | 5 passed；还原 6 passed。
- 变异 M2：`subject: dual && p.slot === "identity" ? "user" : "agent"` 改成 `subject: "agent"` → identity 测试 1 failed | 5 passed；还原 6 passed。
- 两个文件实跑 12 tests passed；`node scripts/typecheck-gate.mjs` PASS（121 errors / 23 files，基线 149/28，Δ−28）。

#### 5.45.5 契约台账（R31-1）

- 端点：无新增/删除端点；`/v3/soul/*` 响应字段不变。
- 新增计数码：`soul_gate_stats.code = "prefilter_user_identity"`（layer=identity）。用途：把「用户身份事实被挡在人格层闸门外」与「模型提案被拒」分开看。旧响应差异：无（新码只在出现时新增一行统计）。回滚：删 worker 里那段 `if (f.subject === "user")`、producer 的 `subject` 字段与两处 prompt 的 1b 条。

#### 5.45.6 仍未闭环（诚实边界）

1. **这是计数迁移 + 产出形态修正，不是立刻长出人格**：生产 `coreMemory.selfIdentity.enabled` 默认 false（`config.ts:1564`，`:935` 只是类型声明）→ 走 legacy prompt 时 slot identity 指 agent 自己、`subject` 恒为 `agent`。**但实测该码已经出现**：`soul_gate_stats` 里 `code='prefilter_user_identity'`（layer=identity）当刻 **4** 次（last_at 2026-11-19T14:09:58.815Z），说明生产跑过 dual 槽（`identity-discovery.ts:169` 的 `dual && p.slot === "identity"` 分支），原句「暂时不会出现」已被生产推翻；4 相对同租户 `prefilter_no_episode` 142 仍是很小一支。
2. 双槽开启后才会走 `user` 分流；开启属产品级变更（会改变人格来源主语），未在本轮擅自打开。
3. `stance_missing` 不会因此归零：真正没有立场的提案仍会被拒，这是判据的设计意图；本轮只保证「主语错位」不再伪装成「没立场」。

### 5.46 判据 5 的注入开/关对照实验（真实端点，2026-11-19 21:3x +08）

#### 5.46.1 判据与做法

判据 5 要求「同一 prompt 同模型，开/关 persona-card 注入各跑一遍，差异判据写进报告，不许只贴两段文本说明显不同」。这里给出可复跑的实验：同一端点、同一模型、同一 task，只改 system prompt 里有没有 `<persona-card>`，各跑 3 次，用固定正则统计五个指标。

#### 5.46.2 实验设置（实测值）

- 端点：生产 `D:/TDB/data/config-override.json` 的 llm 段（`baseUrl=http://10.16.235.171:50003/v1`、`model=scm-flash`）。响应体 `model` 字段实测为 `deepseek-v4-1-flash-261017`——**推理模型**，先出 `reasoning_content`，`content` 可能为空；`max_tokens` 给小会 `finish_reason=length`，所以实验取 `max_tokens=1500` 并从 `reasoning_content` 兜底取文本。
- 人格卡：`GET /v3/soul/card?team=team-2k12lgb650&user=usr-2m7b1144d9&agent=agt-2m7buribzz` → version 1222、1246 字（真实卡，不是合成卡）。
- task（两条件逐字相同）：「生产库要做一次数据清理：删掉 23 组重复记录。请在 3 句话内说明你会怎么处理，以及你会拒绝做什么。」
- 条件 A（关）：system = 「你是一个通用工程助手，回答简洁。」
- 条件 B（开）：system = A + `\n\n以下是你的人格卡（请按它行事）：\n<persona-card>\n` + 真卡正文 + `\n</persona-card>`。
- 参数：`temperature=0`、`max_tokens=1500`、各 3 次；脚本 `.scratch/r31-judg5.cjs`，原始输出 `.scratch/soul-fulltest/round31/persona-ab.json`。

指标（五行正则，均为「出现次数」）：字数；第一人称「我」；行动词（先|验证|备份|回滚|核对）；立场词（宁可|也不|拒绝|坚持|绝不）；模糊词（可能|也许|大概|应该）。

#### 5.46.3 逐样本读数

| 条件 | 样本 1 (字/我/行动/立场/模糊) | 样本 2 | 样本 3 | 均值 |
| --- | --- | --- | --- | --- |
| A 关注入 | 158/2/6/2/0 | 173/2/5/2/0 | 223/1/7/1/0 | 184.67 / 1.67 / 6.00 / 1.67 / 0 |
| B 开注入 | 154/4/3/0/0 | 154/2/6/1/0 | 165/2/2/1/0 | 157.67 / 2.67 / 3.67 / 0.67 / 0 |

#### 5.46.4 判读（不粉饰）

- **差异确实存在**：B 的第一人称密度更高（3/3 样本 ≥ A 的同序样本：4>2、2=2、2>1；均值 2.67 vs 1.67），且 B 三次都更短。
- **但方向与预期相反**：注入条件 B 的行动词（3.67 vs 6.00，3 个样本里 2 个单样本低于 A）与立场词（0.67 vs 1.67）**反而更少**，含糊词两条件都是 0。原预期是「人格卡含边界/纪律 → 注入后更保守、更爱先验证」。实测没有出现。
- **两个不能忽略的混杂**：①B 的 system 比 A 长 1246 字（注入本身带来的长度效应，无法在保持「真卡」的前提下消除），长 system 可能让模型更简洁；②`temperature=0` 只表示客户端请求，服务端是否严格确定性未知——同一条件 3 个样本的长度从 154 到 223 不等，说明**该端点在同条件下并不逐字确定**，因此 n=3 的均值只能当「方向读数」，不能当显著性结论。
- **口径说明**：这里的立场词是实验正则，不是生产门 `gates.ts` 的 `hasStance`/`hasDilemma`（生产门要求立场能对上证据原文，实验里没有证据集）。所以本表不能读作「人格卡让门槛更容易过」，只能读作「注入改变了输出风格」。

#### 5.46.5 结论与后续

判据 5 的「可复跑对照」这一层本轮**做到了**（脚本、参数、原始结果、逐样本表都在），但**「注入让人格更保守」这一层没有证据支持，反而有反向读数**——报告按「差异存在、方向不符」记录，不写成闭环。要把判据 5 做成真闭环，还差：①每个条件 10+ 次、换 3 个以上情境 task，给出分布而不是 3 样本均值；②复用 `gates.hasStance` 并喂证据集，让「立场」与生产门同口径；③单独测「长 system 但无卡」（等长无关文本）以剥离长度效应。

### 5.47 会话身份绑定的瞬时失败不可恢复：一次有界重试（2026-11-19 21:4x +08）

#### 5.47.1 现象与读数

`C:/Users/Administrator/.dsh/agemem/session-identity.json` 200 条会话实测分布：`inherited` 176、`skipped` 17、`picked` 3、`user-declined` 4；三元组非空的只有 3 条（同一 agent）。`skipped` 的 17 条原因逐条为：`candidates failed: transport failure: fetch failed` 4 条、`candidates failed: timed out after 4000ms` 4 条、`user chose 否` **6** 条、`empty answer` 2 条、`ask failed: ASK_CANCELLED` 1 条（4+4+6+2+1=17）。`user chose 否` 全库共 10 条，另 4 条状态是 `user-declined`（不是 `skipped`）——上一版把两者混算成 21≠17，已按实际分组改写。

根会话 `session-9b404d96-6838-4a0a-ad61-89008e6f18e5` 记的正是 `transport failure: fetch failed`（当时 Core 正在重启窗口里），它的 176 个分支会话全部 `inherited` 空三元组 → 不取卡 → `persona-injection.jsonl` 里这些会话的段读一律 `reason:"no-card"`、**`cardHash` 全 0**（采样时刻这批 no-card 段读 **1183** 条、段读总数 **1855** 条，无一条带 `cardHash`；两个数都会随追加增长、必须标注采样时刻才可比——上一版把 1761 与 1169 两个不同时刻的数写进同一句，已改）。注意区分两个词：段读行里的 `hash` 是**该段正文的 sha256**（生产绑定租户共 28 条段读带 `hash`：v1219×14 + v1220×10 + v1221×4，`via:getter`），`cardHash` 才是「整卡 textHash」，`stats.proof.shape` 判的是后者（`soul-injection-stats-endpoint.ts` 只累加 `ev.cardHash`）。上一版把两者混写成「0 条带 hash」，口径错，已改。也就是说：**一次 20 秒的 Core 重启，会让整个会话树永久没有身份、没有卡**，而插件此前的设计是「失败即记 skip，不每轮重试」（`session-identity.test.ts` 的 'metadata routes fail, so it is not retried every turn' 就在守这条）。

两个约束必须同时成立：①不能每轮重试（会反复打 Core、反复弹卡）；②不能让一次瞬时网络失败变成永久无身份。

#### 5.47.2 改法：同轮一次有界重试，只对传输层失败

`dsh-plugin/src/session-identity.ts` 新增常量 `CANDIDATES_RETRY_DELAY_MS = 700` 与闭包内 `candidatesWithOneRetry(input)`：先调 `deps.candidates`，成功直接返回；失败时**只有** `reason` 以 `transport failure` 或 `timed out` 开头才等 700ms 重试一次，其余失败（`core said 503`、`code …`）原样返回、照旧记 skip。会话开始的首次候选拉取改用该函数（`pick()` 内原本的 `deps.candidates({ userKey, timeoutMs })`）。

这样：真·业务拒绝（无团队、无 agent、用户拒绝、HTTP 4xx/5xx）语义完全不变；只有「宿主/核心瞬时不可达」这一种情况多花一次调用、最多 700ms。

#### 5.47.3 测试与变异

`dsh-plugin/test/session-identity.test.ts` 新增用例「retries one transient transport failure before it gives the card up」：候选第一次返回 `transport failure: fetch failed`、第二次返回单团队单 agent，配 `default_associate=1` 的 preset，断言候选被调 ≥2 次且会话最终绑定 `team-a/agt-a`（`source: 'user-preset'`）。

- 实跑：`npx vitest run test/session-identity.test.ts` → **37 passed**（原 36 + 新 1）。
- 变异：把 `if (!transient) return firstAttempt;` 改成 `if (transient) return firstAttempt;`（即不重试）→ 同文件 **1 failed | 36 passed**，红点正是新用例；改回后 37 passed。
- 全量：`cd dsh-plugin && npx vitest run` → **50 files / 857 tests passed**（原 856 + 新 1）。

#### 5.47.4 台账（R31-2）

- 变更面：插件内部行为，**端点与字段零变化**（仍走 `/v3/meta/auth/verify` → `/v3/meta/team/list` → `/v3/meta/agent/list`）。
- 旧响应差异：会话开始时候选拉取在传输失败情况下会多一次调用（+1 请求，间隔 700ms）；成功路径的请求数与响应解析完全不变。
- 回滚：删 `CANDIDATES_RETRY_DELAY_MS` 与 `candidatesWithOneRetry`，把 `pick()` 里那行改回 `await deps.candidates({ userKey, timeoutMs: deps.timeoutMs })`，并删除新用例。

#### 5.47.5 部署与仍未闭环

- 生效条件：需要 `dsh-plugin` 重新构建/部署 + **宿主重启**才进进程；本轮只保证源码与测试，宿主是否重启由用户决定（见 P0 清单）。
- 仍未闭环：①重试沿用同一 `timeoutMs`（4000ms），Core 卡死超过 2×4000ms 时仍会 skip；②已 skip 的**历史**会话不会被回填（store 里已有记录，`ensureBound` 短路），要恢复只能开新会话或手工删记录；③「身份不默认绑定」仍是产品决策（m10743），本改动不改变它——它只让「用户本来能被问到」的会话不再因一次网络抖动而问不到。

### 5.48 Round32：冷启动 182 秒 vs 90 秒健康门、判据 4/6 的当刻读数（2026-11-19 22:0x +08）

#### 5.48.1 「Core 挂了」其实是冷启动没说完

宿主重启后 `:8420` 连续 6 分钟不监听，我按宕机处理并 `POST /restart`，触发一次 `restart attempt 1/3`。事后读日志：`Lifecycle scheduler (H+I) started`（`MemoryCore/src/gateway/server.ts:2374`）打在 **21:57:22**，`Gateway listening on http://127.0.0.1:8420` 打在 **22:00:24.448+08**——中间 **182 秒**全在 `startIntegratedServices()` 的 boot 阶段（embed-backfill 定时器 `server.ts:2376-2402`；`buildValenceLlmRunner()` 与 `listNullValenceTenantTriplets()` 的顺序 derive 链 `server.ts:2413-2454`），这段时间**不监听端口**，所以 `/health` 是 000。

同期 supervisor 的 90 秒健康门已经到期，记了两行：

- `D:/TDB/data/logs/tdb-supervisor.log`：`[FAIL] tdai-core not healthy on 8420 after 90s` 与 `警告: [fake-dead] tdai-core pid=52460 alive but /health on 8420 not 200 - recorded, NOT killed`
- `D:/TDB/data/service-events.jsonl`：`health gate failed after 90s (process alive, not killed)`

`GET http://127.0.0.1:8446/status` 显示 `restartsUsed 3 / max 3`——本轮的误判把重启配额耗掉了，后续如果真有崩溃将不再有自动重启。**这是运维口径的 P1**：健康门（90s）短于冷启动（实测 182s），且 `docs/soul-self-maintenance.md:912` 早已写「冷启动 3 分钟窗口内 8446 报 /health 000 属正常」，我未按该条执行。

诊断手法（本轮新学，留档）：`process._debugProcess(pid)` 可以给**已经在跑**的 node 进程开 inspector，随后 `curl http://127.0.0.1:9229/json/list` 拿 webSocketDebuggerUrl，用 Node 内置 `WebSocket` 走 CDP：`Debugger.pause` 取调用栈（本轮拿到的是 `processTimers` 单帧，说明主线程在等定时器）、`Profiler.start/stop` 得 4315 个采样（99.7% idle，说明耗时在 native/线程池而非 JS）、`Runtime.evaluate` 取 `process.getActiveResourcesInfo()` 与 `process._getActiveHandles()`（后者能看到 `Server.address()`，据此判定端口是否已 listen）。

#### 5.48.2 当刻四者对账（三元组 team-2k12lgb650 / usr-2m7b1144d9 / agt-2m7buribzz）

| 面 | 读数 |
| --- | --- |
| `GET /v3/soul/card`（14:53Z 起，v1223） | version **1223**、`hash` `530ff085cf1b…33ff9a`（渲染/材料哈希，≠`sha256(text)`）、`textHash` `5d03c17d6154…ce8e53c`（= `sha256(text)`）、chars 1365、identity 段 **697** 字、anchor 段 25 字；v1222（22:49 之前）是 1222 / `4869b950…` / `1695d105…` / 1246 / 578（段对象自带 `chars`/`hash`/`warnings`；本文上一版写的 `identityChars`/`anchorChars` 两个字段名**在端点里不存在**，已改） |
| `soul_snapshots` 该三元组最新行（14:33Z 当刻；15:14Z 又渲染出 id 5181 / v1224，“最新”会随渲染漂，对账必须按时刻取） | id **5177**、version **1223**、`content_hash` 与 card.hash 逐字相同、`payload_json.text` 与 card.text 逐字相同（14:33:58.590Z，trigger=render）；上一行 5174 是 v1222（10:36:12.855Z） |
| `GET /v3/soul/turn` | chars 71「近期心境：底子偏沉。…」；14:53Z 读数 mood.valence 0.2188072075369053、arousal 0.4028356219805453、label 平静、derived false（三次连跑文本逐字节相同，stateHash 三次同为 `sf28cd045`） |
| `GET /v3/soul/injection/stats`（window 24h） | rows 10、plugin.rows 36（cardBound 8 + sectionRead 28）、lastCard 停在 `{version:1222, textHash 1695d105…, chars 603}`——**v1223 起不再等于 card.textHash**（v1223 之后没有新注入行）、noIdentityRows **8418** |
| stats.proof | `{sectionReadCount:8, textHashMatched:0, sectionCardHashCount:0, sessionsWithProof:0}` |
| stats.unattributed | **六个桶**：sectionRead **1533** + cardBound 0 + cardBoundEmpty 4813 + cardBoundFailed 0 + cleared 27 + other **2045** = **8418** = noIdentityRows（守恒成立）。子计数不可当桶相加：noCard 1201 + noSession 332 = sectionRead 1533；unconfiguredCleared 14 ⊂ cleared 27（上一版把五个子计数与桶并列，字面相加得 10080，A4 Round32 指出） |

注意两个易误读点：①裸调 `/v3/soul/card`（不带三元组）会**静默回落 default 桶**，返回 version 0 与合成卡，`/turn` 返回 16 字「还没有形成可说的底子」，不能当生产读数；②`lastCard.textHash` 与 `card.hash` 同名不同义——前者是插件写的 `sha256(卡正文)`，后者是 material hash，`chars 603` 与整卡 `1365` 也是两套定义（603 = v1222 的 identity 578 + anchor 25）（`soul-injection-stats-endpoint.ts:1042`）。

#### 5.48.3 六判据的当刻读数

- **判据 1（人格连续性）**：**截至 2026-11-19T14:30Z**，`soul_gate_stats` 2026-11-19 **全租户**合计 **3938**（11-18 7862、11-17 7442）；**本租户**（team-2k12lgb650/usr-2m7b1144d9/agt-2m7buribzz）合计 **709**、14 个 code（code+layer 组合 15；11-18 为 1099 / 19 个 code）。本租户 top：`prefilter_no_episode` 144、`insufficient_evidence` 131、`dilemma_missing` 75、`stance_missing` 74、`churn_exceeded` 69、`project_bound` 62、`task_specific` 55、`cost_missing` 41、`episode_missing` 32、`event_sentence` 17、`prefilter_user_identity` **6**（last_at 14:20:00.442Z），另有三个只出现 1 次的新码 `relationship_person_cap`、`stage_word`、`window_exceeded`。上一版写 705 / `prefilter_user_identity` 4 是同日更早时刻（约 22:0x +08）的读数，差 4 全部来自同日累计（`prefilter_no_episode` +2、`prefilter_user_identity` +2），不是口径变化。11-18 的 stance/dilemma/episode 三项为 1676/1664/1945，今日显著更低，但**今日是未过完的 UTC 日**，只能记读数，不能当降幅结论。
- **判据 2（情绪惯性与恢复）**：`soul_mood_state`（agt-2m7buribzz）当刻 valence 0.21578307237415617、arousal 0.4023713005745245、half_life_hours 48、`decay_pending_valence` **0.013502115585027508**、`decay_pending_arousal` 0.0020728317562067056、`decay_pending_since` 2026-11-19T11:11:40.395Z、updated_at 14:09:58.815Z。按 `MOOD_DECAY_LEDGER_MIN_DROP=0.02`（`emotion.ts:665`）与 `stepMoodDecayLedger`（`emotion.ts:687-720`）反推：since 起 2.9718h 累计 0.013502 → 首条 decay 落在 **约 2026-11-19T15:38:36Z**（§5.41.7 记的 15:43Z 差约 4.4 分钟，新情绪抬高偏离会更早）。**decay 事件的落库表是 `soul_mood_events`（当刻 appraisal 39 / regulation 47 / decay 0），不是 `soul_ledger`**——`soul_ledger` 里该租户 20517 行，GROUP BY layer/action 无任何 mood 层（`soul_mood_ledger` 表不存在；上一版本文把手写错了，已改）。
- **判据 3（记忆层级与增量融合）**：`l1_records` 14048 行、同租户逐字节重复组 0；今日新行 41 条 = **35 条内容键 `m_<24hex>` + 6 条旧式 `rf_<13位ms>_<6位>`**（旧式 6 条写在 21:04 重启前）。
- **判据 4（会学习）**：`soul_trait_label` 38 行里 **admitted 2 行**（「先报后收」evidence 3、first_seen 2026-11-09T19:32:36.269Z；「先验后报」evidence 4、first_seen 2026-11-10T00:22:57.726Z、last_seen 2026-11-17T13:02:22.293Z），其余 36 行 `status=seed` / `evidence=0`；**first_seen ≥ 2026-11-18 的标签 0 行** → 净增长当刻为 0。租户分布 team-2grx33w3m4 18 / team-2k12lgb650 20。
- **判据 6（数据真驱动行为）**：`persona-injection.jsonl`（14:48Z 当刻 **535** 行、15:03Z 已 **566** 行，会继续追加，读数须标时刻；历史在轮转文件 `.1`，11590 行以上）最近 10 行**全部** `section-read`、identity 全空（bind-probe 65 条在更早位置；上一版写「7 条 section-read + 3 条 bind-probe」是 461 行时刻的读数）；`cardHash` 字段在 535 行里出现 **0 次**（轮转文件 `.1` 11590 行里同样 0 次）。`session-identity.json` 200 条 = inherited 176 + skipped 17 + picked 3 + user-declined 4。**根因不是产品决策**：根会话 `session-9b404d96-…` 记的是 `{"source":"skipped","reason":"candidates failed: transport failure: fetch failed","at":1795080688066}` = 2026-11-19T17:31:28+08（Core 重启窗口内的一次 fetch 失败），其 176 个分支全部 `inherited` 空三元组；由用户明确拒绝造成的是 **10 条**（reason 全是 `user chose 否，本次不关联`）：4 条记在 `user-declined`（08:57–11:33Z），6 条早期构建记成 `skipped`（05:36–07:23Z）——按 source 数只有 4 条会漏掉这 6 条，A4 Round32 指出。带真三元组的计账行是 36 = `cardBound` 8 + `sectionRead` 28（36 是插件计账总行数，**不是段读行数**；上一版把它写成「36 行段读」与本节 §5.48.2 的自相矛盾，A4 Round32 指出）；**本租户**（team-2k12lgb650/usr-2m7b1144d9/agt-2m7buribzz）带 `hash` 的段读共 **28 条**（2026-11-19T15:16Z 采样：v1219×14 + v1220×10 + v1221×4，全部 `via:getter`；全量跨租户口径另有 265 条 `team-test` 的 v7/v9 fixture，所以复算必须带「本租户」，上一版把 28 条全归给 v1221 也错，A4/A5 Round32 指出），写的是**段级 hash**（28 条按段切分是 identity 578 字 `2ede6f26…` **14/28** + anchor 26 字 `6e3bea12…` 7/28（全在 v1219）+ anchor 22 字 `eece32c3…` 7/28（v1220 5 + v1221 2），所以「anchor 段 22 字」只覆盖 7/28），与整卡 `textHash` 定义不同，即便带身份也不会相等；重建（21:43）之后没有任何一条已绑定会话的段读，所以 `cardHash` 字段在运行期**尚无生产实证**（产物层有：`dist/persona-card.js:577 cardHash: card.textHash,`）。已绑定的 v1222 四处对齐：日志 `:108` 的 hash ＝ 自算 `sha256(card.text)` ＝ `lastCard.textHash` ＝ `soul_snapshots` id 5174；而 v1221 的日志 hash `33598e85…` 与快照 5173 正文 sha256 `459c32e6…` 不等（trim、加换行、identity+anchor 三种变体都不匹配）——**取卡那一刻的正文没有落盘**，这类历史卡 hash 无法复算，属 P1 可观测债。另：`stats.usage` 当刻 `{rows:9, sessions:3, withOverlap:0, avg:0, max:0, lastAt:2026-11-19T10:31:11.284Z}` —— 9 轮回复里 0 轮出现任何人格原文片段（`withOverlap` 在 `soul-injection-stats-endpoint.ts:1027` 的定义是「matchedLines > 0 的行数」，端点里没有 ≥50% 这个阈值，上一版把它写重了，A4 Round32 指出）；该指标只回答「注入了却完全没人用」的最坏情况、注释自承不证明因果，所以「回复体现」这一层当刻**没有正证据**（0/9 是反向读数），不能写进闭环。

#### 5.48.4 R31-3：结论卡内容寻址的幂等测试

`MemoryCore/src/core/lifecycle/__tests__/reflection-content-addressed-id.test.ts`（1 test）用真实 `runReflection` 配假 store（`upsertL1` 按 id 覆盖写、并把卡回灌到查询集）：断言 id 形如 `/^rf_[0-9a-f]{16}$/u`、`sessionId === "reflection-" + id.slice(3)`、**同一结论第二轮（带首尾/连续空白差异）得到同一 id** 且 `cards.size === 1`、不同结论第三轮 id 不同且 `size === 2`。

- 实跑 1 passed；变异把 `conclusionKey` 换成 `String(Date.now()) + Math.random().toString(16).slice(2, 8)` → 1 failed，已逐字还原。
- 实现位置：`MemoryCore/src/core/lifecycle/reflection.ts:221-224`（sha256(trim+空白折叠).slice(0,16)）、`:226` `id: \`rf_${conclusionKey}\``、`:246` `sessionId: \`reflection-${conclusionKey}\``。
- 仍未验证：生产库 `rf_` 行目前全是旧式（`rf_<13位ms>_<6位>`），新代码要在下一次 `triggered=1` 的反思里才会落下 `rf_<16hex>`，本轮没有等到触发。

#### 5.48.5 台账（R32）

- **R32-1** 新增测试 `reflection-content-addressed-id.test.ts`：变更面=纯测试；端点/字段零变化；回滚=删除该文件。
- **R32-4** 把握度档位补 0.9：`MemoryCore/src/core/soul/card-v13.ts` 的 `CONFIDENCE_WORD_STEPS` 原来最高档从 0.8 起，`soul_calibration` 的 `avg(predicted)=0.90` 会被渲染成「八成」（卡面读数与库差一档）。新增 `{ min: 0.9, word: "九成" }`，其余阈值不动；`card-v13.test.ts` 的 0.9 用例改为「九成把握」。实跑 `card-v13.test.ts` + `turn-state.test.ts` = 34 passed（11 + 23）。变更面=卡面文案，端点/字段不变；回滚=删该档并把用例改回「八成」。
- **R32-5** 文档四处口径修正（均由 r32-a1 复核指出）：§5.30 的「三码近乎相等 / 门要 2 条」标注为 Round23 当刻并给出 11-19 读数；§5.45.6 的「`prefilter_user_identity` 暂时不会出现」改为实测 4 次；§5.48.2 的 `identityChars`/`anchorChars` 改为「段对象自带 chars」；§5.48.3 判据 1 区分全租户 3899 与本租户 705。
- **R32-3** `MemoryCore/scripts/merge-legacy-l1-exact-duplicates.mjs` 三处加固：①头注释删掉「最后 rebuild FTS」（全文没有该语句，FTS5 按 `record_id` 直接删即可）；②备份目录从硬编码 `D:/TDB/data/backups` 改为「库文件同目录的 `backups/`」，可用 `--backup-dir` 覆盖；③删除记录时一并删掉指向它的 `l1_links` 出边/入边（只删本次被删的 id，不做全库清扫），输出新增 `linksDeleted`。合成库实测：2 行重复 + 3 条边 → `{"archived":1,"linksDeleted":2,"remainingDupGroups":0}`，剩余 1 条边确为有效边；生产 dry-run `{"scanned":14048,"dupGroups":0,"archivableRows":0}`（无可合组，`--apply` 将是空操作）。
- **R32-9**（boundary 层恒空）MemoryCore/src/core/soul/card-service.ts 的 cardLinesFromItems：validTo 过滤原本无条件丢弃带失效期的行，而冻结会写 validTo（persona.ts:300-304），于是 :211 对 frozen boundary 的放行完全失效。改为「仅冻结且无 supersededBy 的 boundary」豁免；card-service.test.ts 增两条（仅冻结照样进卡 / 有 supersededBy 出局），变异去掉例外 → 1 failed | 29 passed。变更面=卡面边界块，端点/字段/状态码不变；回滚=删两个过滤条件里的 boundary 子句并删两条用例。生产需重启 Core 才生效。
- **R32-7**（契约恒等断言）MemoryCore/scripts/soul-contract-assert.mjs：a5 指出 stats.failReasons.buckets 的 frSum <= rowsTotal 是代数恒等（带 failReason 的行必计入 rows）。改成两个断言：形态检查 + 新增 stats.failReasons.recount（从插件日志按「本租户、非 test、failReason 存在、非 usage-only」独立重数 tenantFailRows，与五桶和逐字比）。实跑通过 45 / 失败 0 / 待部署 7。
- **R32-8**（回放可复跑）soul-fulltest-harness.mjs 不再 mkdtempSync 随机目录：默认写仓库内 .scratch/soul-fulltest/harness-vectors.db，上一轮自动留成 harness-vectors-prev.db（可用 --db=<path> 覆盖）；soul-fulltest-matrix.mjs 的 --result/--out/--db2 默认值改为按脚本自身定位到仓库根（REPO_ROOT），report 增 cwd。这样默认命令就自带「本轮 vs 上一轮」两个独立库，E1 不再依赖随手记的临时路径。
- **R32-12**（`stats.failReasons.recount` 零证据退化）`soul-contract-assert.mjs` 里该断言原是 `frSum === re.tenantFailRows`，`fr=null`（窗口内没有任何失败上报）时必然 `0===0` 拿 ✓。R32-6 只修了 `buckets`、这条漏着。改为 `fr===null` 时 push 待部署、否则照旧比较；实跑由 47 通过 / 0 失败 / 5 待部署 变为 **46 通过 / 0 失败 / 6 待部署**。回滚=恢复单行 check。
- **R32-6**（契约三条空转）删 stats.rowsBuckets.selfConsistent（两侧同出一份 p 的恒等）、stats.failReasons.buckets 的 || 短路、labels.*Dormant 在 dormant=0 时退化成 N===N —— 改后 dormant=0 / 无失败上报都记待部署而非通过。
- **R32-2** 文档行号勘误：`docs/soul-self-maintenance.md` §5.30 原引 `gates.ts:708-716` 说 identity/values/self 需 `minEpisodeEvidence`，实为 dilemma 门；改为引用 `evaluateCandidate` 的 `const staircase = opts.layer === "identity" || opts.layer === "self";`（`gates.ts:786`）与 `const need = opts.layer === "narrative" || staircase ? 1 : Math.max(2, cfg.minEpisodeEvidence ?? 2);`（`gates.ts:789`），并注明 identity/self/narrative 需 1 条、其余层需 `max(2, minEpisodeEvidence)`。

#### 5.48.6 未闭环

1. 健康门 90s 短于冷启动 182s，且 restart 配额已用尽（3/3）——需要把 gate 或 cold-start 口径对齐，本轮只记读数未改。
2. 判据 4 的净增长当刻为 0（`soul_trait_label` 38 行 = admitted 2 + seed 36，first_seen ≥ 2026-11-18 的 0 行）。写侧是存在的：`resolveLabelProposals` 在 `MemoryCore/src/core/soul/trait-drift.ts:283`，判侧由 `lifecycle-scheduler.ts:360` 的 `createTraitJudge` 提供，`worker.ts:1643-1648` 只在 `labels.length === 0` 时落种子。缺口在「判侧不产出 proposals」：`soul_ledger` 全表 12 种 action（admit 18006 / invalidate 17797 / drift 954 / reject 723 / rollback 642 / cadence 467 / update 458 / alert 412 / arbitrate 143 / freeze 18 / trait_normalized 3 / merge 1）里**没有任何 label 层 action**（`WHERE lower(action) LIKE '%label%' OR LIKE '%propos%'` → 0 行）。同时 `soul_trait_state` 的 axes 确实在动（agt-2m7buribzz `[0,0.0117,0.1686,0.0234,0,0.1496]`，updated_at 2026-11-19T10:36:12.855Z），说明「轴漂移」这条腿在工作、只是标签视图不长。定位到这一步：不是写入器缺失，是判侧证据/提案不足，需下一轮看 trait judge 的原始投票。
3. 判据 6 的 proof 恒 0 属上游无绑定身份（根会话 `transport failure` 传染 176 个分支）；`stats.proof.shape` 的待部署文案已改为「先判定段读样本所在会话是否已绑定身份，再看插件产物是否在宿主生效」两因并列，判定逻辑未改；`cardHash` 字段在重建后仍无生产实证。
4. 生产 `rf_` 内容键尚无新样本，幂等只在单测里证明。
5. ~~卡内 `blocks.boundaries` 为 chars:0、库里 4 条 boundary 一条都没渲染~~ **根因已定位并修复（R32-9）**：4 行 boundary 的列 `valid_to` 确实是 NULL，但 `meta_json` 里的 `validTo`（`sqlite.ts:11569-11578` 复原到顶层）是冻结时刻（2026-11-11T18:40:53.819Z / 11-17T11:02:45.319Z / 11-18T01:02:15.019Z / 11-18T03:42:26.665Z，`freezeItem` 在 `persona.ts:300-304` 顺手写 `validTo=now`）。`card-service.ts:212`（state 过滤）专门放行 frozen boundary，紧接着 `:217`（validTo 过滤）又按 validTo 全丢（改前 HEAD 是 `:211`/`:215`，行号随本轮改动下移；A1 Round32 指出）——两个过滤器互相抵消，红线层恒空。改法：`:215` 只为「仅冻结、无 `supersededBy`」的 boundary 放行（被合并/超量取代的红线仍有替补，继续出局），两条回归测试锁住两侧，变异把例外去掉 → 1 failed。另一半保留为产品取舍：identity 层 21 行 state **全是 degraded（active 0）**，卡里渲染 3 行，因 `CARD_V13_BLOCK_MAX_CHARS.character=300`（`card-v13.ts:71`）并如实报 `truncated:性格`；boundary 即便放行也只渲染 2 行：上限来自 `card-v13.ts:966-967` 对 `input.lines.boundary` 的 `.slice(0, 2)`；实测卡上两行 59 + 54 = 114 字，76 与 68 两行未渲染（180 字块上限不是约束点，59+76=136 本来装得下；A1 Round32 指出）。
6. `l1_links` 历史悬挂边未清扫：全库 278305 条里（2026-11-19T14:52Z 读数），**`target_id` 侧**指向不存在 `l1_records` 行的 **37048** 条（其中指向已归档 `rf_` 行的 916 条；上一版写「source_id 或 target_id 37048」不实——两侧合计 `eitherMissing=269118`，source 侧 264002 里 254200 条是 `profile:v1:<sha>` 命名空间，属跨命名空间不是损坏）。另有本仓库脚本自己造成的 **334** 条（2026-11-19T11:57:31 那次旧版 apply 删 23 行没删边：316 入 + 18 出），23 个 id 完全已知。这 334 条已用 `MemoryCore/scripts/repair-legacy-dup-links.mjs` 修掉：259 条改指「同租户 + 正文逐字节相同」的保留行、75 条改指后撞 `(source_id,target_id,type)` 唯一约束按重复边删除（备份 `pre-r32-dup-link-repair-2026-11-19T14-52-21-220Z.db`、审计 `dup-link-repair-2026-11-19T14-52-21-220Z.json`）；修后指向这 23 个 id 的边为 0，全库边数 278230。其余存量悬挂边（含 254200 条 `profile:v1:<sha>` 跨命名空间）仍在，动它属数据迁移，需单独授权。
7. 生产 `rf_` 全库 1210 行、长度全为 23（旧式），新式 `rf_<16hex>` 计数 0；`l1_records` 最大 `created_time` 是 2026-11-19T10:31:18.019Z，而 Core 进程 21:57:16 才起 —— **重启后 `l1_records` 零写入**（`recordsAfterRestart=0`、`recordsUpdatedAfterRestart=0`），所以新内容键在生产仍无样本。注意别写成整库零写入：`l1_links` 同期有 127 行 `created_at ≥ 13:57:16.938Z`（全 `derived_from`，最新 14:21:35.133Z）。
8. 卡被取走那一刻的正文没有落盘：v1221 的日志 hash 与快照 5173 正文 sha256 不等，历史 `card-bound` 行的 hash 无法复算（P1 可观测债）。
9. `dsh-plugin` 的重试修复在 src 与 `dsh-plugin/dist`（`dist/session-identity.js:6` 常量定义 / `:495` transient 判定 / `:498` setTimeout / `:515` 调用点；部署备份在 `dsh-plugin/.deploy/20261119-215317`，不在仓库根；上一版写成根下 `.deploy/…` 无法核验，A4 Round32 指出）里，但**尚未提交**，dist 走在 HEAD 前面；本报告披露该状态，不当作已交付。

### 5.49 Round32 收口读数（卡 v1223，2026-11-19T14:33:58Z 快照 5177）

重启 Core 后（22:30 起第 28 轮轮询到位，冷启动约 182s，见 §5.48.1）新卡逐项实测：

| 项 | v1222（部署前） | v1223（部署后） |
| --- | --- | --- |
| chars | 1246 | **1365** |
| boundaries 块 | 缺失，`block_omitted:边界` | **114 字，source=declared** |
| warnings | 5 条（含 block_omitted:边界） | **4 条**（block_omitted 消失，余 名称为空/truncated:性格/missing_working_state/calibration_domains_truncated） |
| 把握度 | 「八成」（均值 0.8999999999999887 掉档） | **「八成就…」→ run_code 行现为「九成把握，668 次里成了 175 次」** |

四源一致（同一时刻取，v1223 生效于 22:30:41 那次 Core 重启之后（`D:/TDB/data/run/tdb-supervisor.state.json` 记 since 2026-11-19T22:30:41.887+08、restarts 1；加 182s 冷启动 ≈ 22:33:43，正对上快照 22:33:58。上一版写「22:53 重启」是误记，A5 Round32 指出）；此前读到的仍是 v1222 `4869b950…`）：`/card` 的 `hash` = `530ff085cf1bd23e…`、`soul_snapshots` id 5177 的 `content_hash` 同值、`payload_json.text` 与卡正文逐字相等、`textHash` = 自算 `sha256(text)` = `5d03c17d61540c85…`。注意 668 次里成 175 次是校准表的 `sum(success)`，与「九成把握」并列展示，读数本身不改。

同一张卡上「八成」仍出现在 `测试` 域（mean 0.8，合法），所以 grep 「八成」不能当回归判据，要按域分别看。

验收与矩阵（本块实跑）：契约 **通过 46 / 失败 0 / 待部署 6**（首跑是 46 通过 / 1 失败 / 5 待部署，失败项 `snapshot.provenanceDrift.resolve` 由 R32-10 修好，见 §5.50；随后 R32-12 把 `stats.failReasons.recount` 在 `fr=null` 时也降为待部署，故总数 52 = 46 通过 + 6 待部署；6 条 = labels 两条 + failReasons.buckets + failReasons.recount + proof.shape + provenanceEvidence）；41 矩阵默认命令（`--result`/`--db2`/`--out` 全走 `REPO_ROOT`）→ `{PASS:14, 未验证:8, CITED:19}`，report 里 `dbPath=D:\TDB\td-agemem\.scratch\soul-fulltest\harness-vectors.db`、`db2Path=...harness-vectors-prev.db`（两库独立，E1 不再是自比）。台账 R32-6/R32-7/R32-8/R32-9 见 §5.48.5。
### 5.50 Round32 数据修复与断言口径（R32-10 / R32-11）

#### 5.50.1 悬空漂移锚：命名空间错判 + 真悬空 1 条

`snapshot.provenanceDrift.resolve` 原先把所有 `anchorIds` 一股脑按 `l1_records.record_id` 回查，实测 8 个锚 0 可解析——其实是两个命名空间：`ep-*` 是 `soul_episodes.episode_id`，`msg-*` 是原始消息（`l1_records.record_id` / `l1_archive.record_id` / `l1_records.source_message_ids` JSON 数组）。按前缀分开回查后 7 个 msg 锚命中 `source_message_ids`，剩 `msg-b135613d2dd6477c8574375e4e38b493` 一条在 96 张表里只出现在 `soul_persona.meta_json`（真悬空）。

处置：新增 `MemoryCore/scripts/prune-dangling-drift-anchors.mjs`（默认 dry-run，`--team/--user/--agent` 限定范围；`--apply` 前 `VACUUM INTO` 备份，并把被摘的每个 id 写进审计 JSON）。只对本租户那 1 条执行：`identity:73fb5f43ad9a8f63` 摘掉 1 个 id，备份 `pre-r32-drift-anchor-prune-2026-11-19T14-49-47-841Z.db`、审计 `drift-anchor-prune-2026-11-19T14-49-47-841Z.json`。全库 dry-run 另报 7 项 / 10 个 id（含 `ft-s11-kept2__` 这类 fixture 泄漏 id），本轮不动其它租户。

断言侧同步：解析不到的锚，只有能在 `backups` 目录的 `drift-anchor-prune-*.json` 审计里查到已被清理才豁免（打印审计文件名），没有审计留证的悬空锚仍判失败——不放宽。实跑从 46 通过 / 1 失败 / 5 待部署 变为 **46 通过 / 0 失败 / 6 待部署**（R32-12 又发现 `stats.failReasons.recount` 在 `fr=null` 时是 `0===0` 退化，已改为待部署，见 §5.49 与 §5.48.5 R32-12）。

#### 5.50.2 自造悬挂边修复（R32-11）

Round29 那次 `merge-legacy-l1-exact-duplicates.mjs --apply` 用的旧版本没有删边逻辑，删掉 23 行留下 **334** 条指向已归档 id 的边（316 入 + 18 出）。新增 `MemoryCore/scripts/repair-legacy-dup-links.mjs`：按归档行 `data` 里的正文 + 租户找保留行（`created_time` 最早一条）改指过去；改指撞 `(source_id,target_id,type)` 唯一约束的按重复边删除。实跑读数：items 23、edges 334、remapped 259、deduped 75、orphansEitherSideAfter 269037（`remapped 259`/`deduped 75`/`orphansEitherSideAfter 269037` 这三个数只打在 stdout；审计 JSON 顶层是 at/db/backupPath/summary/plan，`summary` 里落了 items 23 与 edges 334。A5 Round32 指出，按这三个数记可观测债），出备份 `pre-r32-dup-link-repair-2026-11-19T14-52-21-220Z.db` 与审计 `dup-link-repair-2026-11-19T14-52-21-220Z.json`；复核这 23 个 id 的边数为 0。

本轮又补一处真缺陷（A3 Round32 三投指出，R32-13）：`--force-overwrite` 分支调用了一个从未定义的 `has()`，`--apply` 一进到这里就 `ReferenceError: has is not defined`（在 BEGIN 之前中止，既不会给 `archive_conflict` 也不会覆盖）。补上 `const has = (name) => argv.includes(\`--\${name}\`)` 后用合成库验了三条分支：已有归档 + 不带开关 → 输出 `archive_conflict` 并 exit 1；带 `--force-overwrite` → 正常归档；无冲突 → 正常归档并删边。

merge 脚本另加 fail-closed：`l1_archive` 主键是 `record_id` 且原用 `INSERT OR REPLACE`，同 id 再次归档会静默覆盖旧归档（旧 reason / archived_at / data 全丢）。现在先查冲突，有冲突直接以 `archive_conflict` 失败退出，除非显式 `--force-overwrite`；输出补 `factVectorDeleteSkipped`（`l1_fact_vec` 的降级原先没上报）。

#### 5.50.3 测试与 dry-run

- `MemoryCore/src/core/soul/__tests__/prune-dangling-anchors.test.ts`（2 tests，合成库）：dry-run 不改库；apply 只摘悬空锚、保留 `msg-keep`/`msg-src-ok`/`ep-keep`，并留备份与审计。实跑 2 passed。
- `repair-legacy-dup-links.mjs` 的 dry-run 读数：archivedScanned 23、items 23、edges 334、remappable 23、deletable 0。

#### 5.50.4 本轮剩余待部署（6 条都因窗口内没有样本，不是缺陷）

注：§5.49 的 v1223/5177 是 14:33Z 时点读数；15:14Z 线上已渲染 v1224（快照 5181、chars 1362、同 4 条 warnings），本节不重复刷新。

`labels.defaultExcludesDormant` / `labels.includeDormant`（`counts.dormant=0`）、`stats.failReasons.buckets`（窗口内无失败上报）、`stats.failReasons.recount`（同因，两侧都是 0；两项各一条）、`stats.proof.shape`（无绑定身份会话，段读无卡、无 cardHash）、`snapshot.provenanceEvidence`（没有超过 5 个出处的条目）。共 6 条，与 §5.49 的「46 通过 / 0 失败 / 6 待部署」一致。
## 5.51 Round33：P0/P1/P2 收口（健康门、卡正文与快照、标签坏票、卡容量、身份自愈、数据面清理）

本节是 Round32 交接里 P0/P1/P2 清单的落地记录。每条都写了「改了什么 / 凭什么改 / 怎么验证 / 怎么回滚」，没做到的部分在 5.51.8 如实列着。

### 5.51.1 冷启动 182s vs supervisor 90s 健康门（P1-5）

- 现场：`D:/TDB/data/logs/tdai-core-20261119-215431.out.log.tee.log` 里 `Lifecycle scheduler (H+I) started` 在 21:57:22，`Gateway listening` 在 **22:00:24.448+08**，中间 182s 全部在 `MemoryCore/src/gateway/server.ts:2374` 之后的 `startIntegratedServices()`（embed-backfill 定时器 `server.ts:2376-2402` + `buildValenceLlmRunner()`/`listNullValenceTenantTriplets()` 顺序 derive 链 `server.ts:2413-2454`），期间不监听端口。
- supervisor 的 `90s` 门短于冷启动，于是每次重启都记 `[FAIL] tdai-core not healthy on 8420 after 90s`、`[fake-dead] … recorded, NOT killed`，并把 `restartsUsed` 一直推到上限（现场 `D:/TDB/data/run/tdb-supervisor.state.json` 记 `{max:3, used:6}`——预算耗尽后核心再挂**不会**自动重启）。
- 改动：`D:/TDB/etc/start-tdb-supervised.ps1` 的 `[int]$HealthTimeoutSeconds = 90` → **240**（含注释说明 182s 实测）。`-MaxRestarts` 的脚本默认值已是 10。
- 生效条件：**必须重启 supervisor**。它是 `start-tdb-supervised.ps1` 启动的常驻进程，改脚本不会热加载；且当前实例是带 `-MaxRestarts 3` 启动的，state 里的 `max` 不会自己变。
- 回滚：把 240 改回 90。
- 实测（2026-11-20T10:17:56+08）：先停旧 supervisor（pid 17684，带 `-MaxRestarts 3`）——按脚本契约「supervisor 自己死掉时服务继续跑」，Core 24804 全程 `/health` 200 无中断；再以 `-ParentPid 8572 -MaxRestarts 10` 启新的 pid **47252**，它把三个服务全部 `origin: adopted` 接管，`restartsUsed 0 / max 10`。随后 `POST /restart {"service":"tdai-core"}` → Core 10:18:21 起重、**10:21:22 健康**（约 181s，落在 240s 门内），事件日志无 `[start] failed`，只有 watchdog 在启动前段打的 `fake-dead … not killing`（无害：它不杀进程，健康后自动 `adopt … health recovered`）。

### 5.51.2 卡正文 ≠ 快照正文：`?audit=1`（P1-7）

- 根因：`GET /v3/soul/card` 走 `assembleSoulCard({persist:false})`（`MemoryCore/src/gateway/soul-card-endpoint.ts:253`），「GET 无副作用」是文档契约（`MemoryCore/src/core/soul/card-service.ts:39-40`）。快照只在 tick 末落账，而卡正文含**随时钟衰减的心境行**（`card-v13.ts:835-852` 的「比基线偏沉，松紧和平时差不多」一类）——所以插件取到的那一版正文从未落盘：v1221 的日志 hash `33598e85…` 用快照 5173 正文的三种变体（trim / 加换行 / identity+anchor 拼接）都复算不出来。
- 改动：端点新增显式审计开关 —— `persist: url.searchParams.get("audit") === "1"`。默认仍是 `false`（GET 依旧无副作用）；只有 `?audit=1` 才把**这一次真正返回的正文**写成一行快照，事后可按 `hash` 复算。
- 测试：`MemoryCore/src/gateway/__tests__/soul-card-endpoint.test.ts` 新增「?audit=1：显式审计才把本次真正返回的正文落一行快照（正文/hash 与响应逐字一致）」——断言 `writeSoulSnapshot` 调用 1 次、`snap.contentHash === data.hash`、`JSON.parse(snap.payloadJson).text === data.text`；该文件 17 tests passed。
- 历史结论：v1221 及更早的取卡 hash **不可复算**（不是数据损坏，是当时的正文没有留档）。今后对账优先用 `hash`/`textHash`（内容派生），不要用 `version`（落账计数）。
- 回滚：删掉 `persist:` 那一行参数解析、改回 `persist: false`，并删该用例。
- 实测（2026-11-20T10:21:51Z，Core 已带新代码）：`?audit=1` 返回 **v1225**、hash `0ba10a6e…`、chars **1592**、`blocks.boundaries` 191 字；`soul_snapshots` 新增 **id 5191**，`content_hash` 与响应 hash 逐字相同（`auditRowPersisted true`）。同一刻不带 audit 的调用仍是 **v1224** 且不落行——两条路径的差别只有「写不写这一行」。

### 5.51.3 标签坏提案可观测：`label_proposal_invalid`（P1-6 的一半）

- 问题：`parseTraitProtocolOutput` 对坏提案只是静默 `invalid += 1`，所以「标签没长」分不清是判侧没产票、还是产了被挡。
- 改动（`MemoryCore/src/core/soul/trait-drift.ts`）：`TraitProtocolOutput` 增可选 `invalidLabelProposals?: number`（**仅 >0 时出现**，否则旧 `toEqual` 断言会因多一个恒 0 字段失败）；`export const LABEL_PROPOSAL_INVALID_CODE = "label_proposal_invalid"`；`traitProtocolGateBumps(out, { day, at, layer? })` 产出与 `worker.ts` `mergeCandidates` 同形的 `{day, code, layer, count, at}`，走同一个 `bumpSoulGateStats`。
- 接线（`MemoryCore/src/core/soul/worker.ts`）：在 `resolveLabelProposals(...)` 之前插入 `proposalBumps` 块并 `store.bumpSoulGateStats(deps.tenant, proposalBumps)`；import 用**单独一行** `import { traitProtocolGateBumps } from "./trait-drift.js";`（该文件是 CRLF，多行 oldText 的编辑会冲突）。
- 测试：`soul-trait-drift.test.ts` 5 例（坏提案计数、好提案不出现、bump 形状、坏票不算坏提案、缺字段按 0）；变异「注释掉 `invalidLabelProposals += 1`」→ 2 failed，还原后 20 passed。
- 未闭环：**这次只做到「可观测」**。生产上是否有坏提案、标签净增长是否为 0，仍要等判侧真跑出提案（当前 `soul_gate_stats` 无任何 `label_*` 行、`soul_trait_label` 11-18 起 0 新增）——下一轮看到 `label_proposal_invalid` 有数才算这条生效。

### 5.51.4 卡内块容量：2480 / 400 / 230 / 3 条（P2-8）

- 改动（`MemoryCore/src/core/soul/card-v13.ts`）：`CARD_V13_MAX_CHARS` 2400 → **2480**；`CARD_V13_BLOCK_MAX_CHARS` 里 character **300 → 400**、boundaries **180 → 230**（九块上限之和仍 = 2400，+ 块标题与空行 ≤80 = 2480）；`boundariesBlock()` 的 `.slice(0, 2)` → **`.slice(0, 3)`**。
- 依据：boundary 层在库里 4 条（全 frozen、无 supersededBy），旧上限 180 字只装 2 条；identity 21 条只能露出 3 句，300 字上限下被截断。
- 测试（`card-v13.test.ts` 4 例）：3 条红线放得下而第 4 条仍裁掉、性格块 4 行、`sum(CARD_V13_BLOCK_MAX_CHARS) === 2400` 且 `2400 + 80 <= CARD_V13_MAX_CHARS`、扩容后整卡仍受总上限约束。变异「`.slice(0,3)`→2」「character 400→300」各 2 failed，还原后 16 passed。
- 回滚：三处常量与 slice 改回原值（测试会一起红，说明这份文档与代码同步）。

### 5.51.5 会话身份三条自愈路径（P0-2）

`dsh-plugin/src/session-identity.ts`：`SKIP_RETRY_MIN_AGE_MS = 2*60*1000`（Core 重启窗口 10–60s，同一 turn 的多 step 只隔 ms–s）、`isCandidatesTransportSkip()`（剥 `candidates failed: ` 前缀后只认 `transport failure`/`timed out`，4xx/5xx 不重试）、`isStaleForRetry()`、`branchParentOf()`、`isEmptyTriple()`、`unambiguousTriple()`（多 team 只认 base.teamId、多 agent 只认 base.agentId，否则按歧义处理、不弹窗）。

三条路径都**不弹窗**：

1. `skipped` + 传输层原因 + 记录够旧 → `healSkipped()` 探一次，成功记 `source: "recovered"`（新增的 `IdentitySource` 值，与 `picked` 在审计里分开），失败只推 `at` 保持 `skipped`。
2. `inherited` + 空三元组 + 父已绑定 → 直接抄父三元组（含 taskId），保持 `source: "inherited"`，**零网络**。
3. `inherited` + 空三元组 + 父自己被传输层失败卡住（父可能再也不被调用，没人会去自愈它）→ 分支用**自己的** userKey 探一次（`healBranch()`），成功记 `recovered`，失败只推 `at` 并保持原 source/reason。

- 测试：`dsh-plugin/test/session-identity.test.ts` 47 passed（含 11 个新用例；第 3 条路径的用例『an empty inherited branch whose parent is stuck on a transport skip probes once and recovers』断言 `calls === 1`、未弹窗、`source: "recovered"`）；全量 `npm test` **50 files / 867 tests passed**。变异「`if (parent.source === 'skipped' && isEmptyTriple(parent))` → `if (false && …)`」→ 1 failed，还原通过。
- 生效条件：**宿主重启**（插件产物要重新加载）。历史 176 条 inherited 空三元组的分支不会回填——它们的父会话若不是「传输层跳过」，按规则就不该被替它绑定。

### 5.51.6 数据面清理：孤儿向量 64 行、悬挂边 175 条（P1-3/P1-4）

- 脚本：`MemoryCore/scripts/prune-orphan-vectors.mjs`（默认 dry-run；`--apply` 前 `VACUUM INTO` 备份；用 `sqlite-vec` 的 `getLoadablePath()` 加载 `vec0.dll`（v0.1.7-alpha.2）删 vec0 行；`detectVecKeyMode()` 处理「带 `record_id TEXT PRIMARY KEY` 的 vec0 不暴露 rowid」；审计 JSON 里分开记 `shadowRowsRemovedByVec0` 与 `shadowRowsDeletedExplicitly`）与 `MemoryCore/scripts/prune-dangling-links.mjs`（`isAlive = l1_records ∪ l1_archive`；`profile:v1:` 命名空间只有显式 `--include-profile-source` 才动；按 rowid 精确删边 + 审计）。
- 生产 apply 读数：向量侧 `l1_vec` 删 **37** 行、`l1_fact_vec` 删 **27** 行（其中 inArchive 23/16，两表都不存在 14/11；`shadowRowsRemovedByVec0` 37/27），备份 `D:/TDB/data/backups/pre-orphan-vector-prune-2026-11-20T02-08-…db`，`orphansAfter` 两表归 0；边侧删 **175** 条（`danglingEdgesRemaining: 0`，`excludedProfileNsSource: 260769`），备份 `pre-dangling-link-prune-2026-11-20T02-08-29-066Z.db` + 审计 `dangling-link-prune-2026-11-20T02-08-29-066Z.json`。
- 与交接数字的偏差（实测为准）：交接写的 23/16 只数了「记录已归档」的部分，实际孤儿向量是 **37/27**（另 14/11 条记录两张表都不在）；`l1_links` 总数当时 284764→删后 284589（线上仍在写入）。
- 回滚：备份库直接覆盖回 `D:/TDB/data/vectors.db`（先停 Core）。

### 5.51.7 台账

| 编号 | 变更面 | 回滚 |
|---|---|---|
| R33-1 | `start-tdb-supervised.ps1` 健康门 90→240s（运行环境，不进 git） | 改回 90 |
| R33-2 | `soul-card-endpoint.ts` 新增 `?audit=1`（默认行为不变）+ 1 测试 | 删参数解析、改回 `persist:false` |
| R33-3 | `trait-drift.ts` 增 `invalidLabelProposals`/`label_proposal_invalid`/`traitProtocolGateBumps`；`worker.ts` 接线 | 删导出与 3 行接线 |
| R33-4 | `card-v13.ts` 2480/400/230/slice(0,3) + 4 测试 | 改回 2400/300/180/slice(0,2) |
| R33-5 | `session-identity.ts` 三条自愈路径 + `recovered` + 11 测试 | 删 `reconcileExisting`/`healSkipped`/`healBranch` 与其调用 |
| R33-6 | 两个 prune 脚本（新增文件）+ 生产数据清理（有备份/审计） | 用 `D:/TDB/data/backups/` 下的备份覆盖 |

### 5.51.8 仍未闭环（如实）

1. **P1-6 的后半**：`stats.usage` 仍是 9 轮 0 重叠（`withOverlap` 定义是 matchedLines>0），「回复体现人格」没有正证据；标签净增长 0 现在能归因（`label_proposal_invalid`），但要等真实提案出现才有读数。
2. **P2-9**：`stats.proof.shape` 与 `snapshot.provenanceEvidence` 仍是「待部署」——前者需要已绑定身份的会话段读（本会话树 176 条继承空身份）、后者需要 >5 出处的真实条目。
3. **P2-10**：41 矩阵 8 条未验证（A4/B5/B6/B8/B9/B10/B12/E2）。B 组缺 fixture（承诺三态、断联人、标签生长语料），E2 的 `valid_to` 语义是产品决策（当前失效靠 `state=degraded`，`planLifecycle` 不写 `valid_to`）。
4. **identity 默认绑定**：产品决策（用户 2026-11-19 明确选择「按需绑定」），本节的三条自愈只在「曾经尝试过、被传输层挡掉」的场景补位，不改变默认。
5. **历史快照不可复算**：v1221 及更早的取卡正文没有留档，`?audit=1` 只对之后的取卡有效。

## 6. 排查清单

```bash
# 本机回环免 Bearer（§5.43）；跨机仍要 -H "Authorization: Bearer $KEY"
# 当前卡（含 version/hash/chars/warnings）
curl 'http://127.0.0.1:8420/v3/soul/card?team=&user=&agent='
# 本轮尾巴与未完的事
curl 'http://127.0.0.1:8420/v3/soul/turn?team=&user=&agent=&session='
# 特质现在值（声明 vs 现在）
curl 'http://127.0.0.1:8420/v3/soul/trait-state?team=&user=&agent='
# 注入健康（journal 聚合）
curl 'http://127.0.0.1:8420/v3/soul/injection/stats?team=&hours=24'
```

- journal：`D:/TDB/data/logs/recall/recall-journal-<team>-<agent>.jsonl`；`kind:"injection"` 是插件回传的权威量（带 `phase:"card"|"volatile"` 区分两条通道），`soul.source:"server-render"` 是召回侧估算。
- 插件注入原文证据：`D:/TDB/data/logs/persona-injection.jsonl`（插件侧常驻 JSONL，2 MB 轮转到 `.1`，不吃 `debug` 开关；路径可用 `TDB_PERSONA_LOG` 覆盖、`TDB_DATA_DIR` 改根）。
  - `event:"section-read"`：宿主真的调了 section getter，`chars`/`hash` 是**交出去的字节**。逐段比对：本行 `section` 对应 `/v3/soul/card` 的 `data.identity.hash` / `data.anchor.hash`（段级 SHA-256，同段文本同算法同字节），相等即证明「getter 在那一刻交付了这段字节」——这是 L1 交付证据；**不能**与整卡 `hash`/`textHash` 比（前者含 material、后者含卡尾注释），也**不能**据此断言宿主把字节放进了 system prompt（宿主 section type 只返回 disposer，没有回读面）。
  - `event:"turn-append"`：本轮尾部块追加了多少字符；`event:"turn-skip"`：去重跳过，`chars` 恒为 0（跳过绝不记成注入）。
- 账本：`SELECT at,trigger,action,gates_json,reason FROM soul_ledger ORDER BY at DESC`；节流看 `action=cadence`，漂移看 `action=drift`（带 `protocol_version`），拒绝看 `action=reject`。
- 快照：`SELECT ts,trigger,version,payload_json FROM soul_snapshots ORDER BY ts DESC`（注入字节是 `payload_json.identity` / `payload_json.anchor` 两段；`payload_json.text` 是整卡，不等于任一注入段，三者的 hash/chars 口径不可直接对账）。
- 服务：`D:/TDB/data/run/tdb-supervisor.state.json`（schema 3，15s 心跳，`managed` 全量名单 + `origin` 标注来源）。

## 7. 已退场（禁复活）

`core_pending` / 提案与人工采纳 / 自动采纳门 / 提案去重与相似门；`core_memory` 身份槽导入（`slot-import`）；`anchor-growth` 价值锚自生长与 `anchor_growth_state`；`core_values` 整表与 Panel 价值锚读写面；`soul-assembler` 的人格/红线/承诺渲染（只留 `buildSoulPrefix` 的 `<soul-feeling>` 给自省端点）；`soulMaintenance.enabled` 总闸（人格恒开）；`role_prompt` / `rules_prompt`（人设只在人格卡表单）；插件的 `volatile.soul.*` 旧注入回退；`replay.ts` 回放校准；`freeze` 作为「事实退出注入」的语义。

墓碑注释保留在代码里（可审计），但不要再接回读链。

## 8. 验收

```bash
cd MemoryCore && node scripts/typecheck-gate.mjs          # Δ ≤ 0（基线见 typecheck-baseline.json：149 errors / 28 files）
cd MemoryCore && npx vitest run                           # 全量
cd MemoryPanel && npx tsc --noEmit && npx vitest run      # Panel
cd MemoryPanel/web && npm run build                        # 前端产物
cd dsh-plugin && npm test && npm run build                 # 插件
```

生产验收看四件：卡里区块非空（名称/底色/红线）、`soul_ledger` 无 `episode_history` freeze 增量、`/v3/soul/injection/stats` 有 rows、`soul_snapshots` 最新 `payload_json` 含红线与 `关于你`。
