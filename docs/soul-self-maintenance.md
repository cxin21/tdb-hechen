# 自维护人格：运行手册

> 架构决定见 [ADR-0028](adr/0028-persona-card-v3-declared-observed.md)（当前口径；ADR-0026/0027 已被它取代）。
> 代码：`MemoryCore/src/core/soul/`（产线）、`MemoryCore/src/gateway/soul-*.ts`（只读接口）、`dsh-plugin/src/persona-card.ts`（注入）。
> 规范：`docs/specs/2026-11-07-soul-production-grade-spec.md`（v3.7，唯一权威；跟踪 issue #180）。

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

- **稳定段**：`systemPrompt.section({ name:'tdb-agemem:persona-card', text: () => card.current() })`。一次取、冻结、后台刷新（`PERSONA_CARD_REVALIDATE_MS=300_000`），新版本只在新会话或压缩后出现；`text` 是 getter，永不 await。
- **每轮段**：`agent/pre-step` 尾部 volatile 块，`<soul-feeling>` 近期心境 + 未完成提醒，单轮上限 `PERSONA_TURN_MAX_CHARS=400`（单条 360），append-only、producer-owned `source.kind`、两级去重（同 turn 一次 + 近 3 轮同文本）。
- **失败语义**：取卡失败 fail-open（保留上一次冻结文本），四类原因 `http_status / timeout / empty / parse` 各 warn 一次；注入量回报 `POST /v3/soul/injection`（只报长度与指纹，不报正文）。
- 键不再由 Core 判断启停：Core 只提供只读接口（`/v3/soul/card`、`/v3/soul/turn`、`/v3/soul/trait-state`、`/v3/soul/injection/stats`、`POST /v3/soul/injection`、`POST /v3/soul/introspect`）。

## 4. 人格卡（15 区块 → 渲染段）

区块与来源（声明 D / 观察 O / 推导 B）：名称（D→O→骨架）、形象（O，90 天变更门）、说话方式（O+D）、使命（D，禁项目名）、底色（B，6 轴投影 + 标签带权）、红线（D 逐行 + O 用户拍板）、关于你（O，`human` 层）、关系（O，按对象聚类）、自我史（O，正向/修复/复盘）、自传（O+B，月度三段）、未完的事（B，承诺 + 失败决策点）、心境（B）。

卡头常量 `CARD_READER_NOTE`（读法，版本无关）固定不变以保 prefix cache；卡尾 `<!-- persona-card v="N" hash="…" -->` 只作指纹。

**红线**：每行 ≤120 字、≤30 行、总字符 ≤2600；超限先相似合并（去标点相等 / 二元组 ≥0.85 / 连续子串），再退役最久未引用行（`active=false`，不物理删），最后按「保留更早、拒收最新」截断并告警。红线只 append/retract，永不改写、不衰减、不合并语义。

## 5. 判据与阈值

**准入（确定性，全在 `gates.ts`）**：形态（各层字数上限）、任务锚（哈希/路径/版本/工具名 → method）、事件句、项目专名、两难结构、出处（`minEpisodeEvidence` 个不同 `ep-*`）、原话逐字（voice/relationship）、独立性（soul/model 来源 >50% 拒）。

**变更率**：`alpha=0.15`（归一化编辑距离）、`windowDays=7 / windowRewrites=1`、`maxUpdatedPerCycle=3`；只数正文真改写。

**特质（6 轴）**：亲和/主导/严谨/开放/稳定/守界，`state ∈ [-1,1]^6` 是漂移唯一载体；`TRAIT_DRIFT_ALPHA=0.02`、单 tick 每轴 `|Δ|≤TRAIT_MAX_STEP=0.05`、`Σ|state|≤TRAIT_L1_MAX=0.5`。标签=空间里的方向向量，`act=clamp((⟨state,d⟩+1)/2)`；声明标签与 evidence 达标的标签都进卡；`AXIS_VERSION` / `TRAIT_PROTOCOL_VERSION` / `CARD_READER_NOTE_VERSION` 三常量写进账本。

**情绪**：24 模板 + PAD dominance，半衰期按模板（2–12h），强度 = `(0.55*目标相关 + 0.45*违背) * 规范一致 * 公开系数`；对象从正文首句确定性抽取（拒问句、拒泛化）；到期 = 衰减后 <0.05 或 >6 个半衰期。情绪门已降级为**观测**（`gates:["mood_gate","observed_only",code]`），不再拦候选。

**心境**：基线慢速 EMA（`BASELINE_EMA_ALPHA=0.02`）；注入写相对偏移；无存活情绪时写「底子」三档（阈值 0.15 / 0.4）；`pickCurrentEmotion` 全过期则四列写 null，不挂陈年原因。

**承诺**：`factsFromEpisode` 的 promise 事实（对象锚必填、`这件事` 除外）→ `settlePromises`（kept 需 repair 且不早于 fail；broken 需「没守住」+ 我承认）→ `upsertSoulPromise` / `transitionSoulPromise(source=evidence)`；核对只覆盖事件史（LLM 改写句无对象锚，是写下来的边界）。

**生命周期**：`degradeAfterDays=30`（weight×0.7）、`freezeAfterDays=90`；滑出窗口不再 freeze，改 `validTo=now`（存 `meta_json`）+ 权重×0.5，被取代写 `supersededBy`；渲染只取未失效。矛盾（自我层 repair/review 同对象被更晚未修复事件推翻、非同自然日、幂等锚 `meta.lastContradictionEpisode`）达 `freezeContradictions=2` 冻结。

**调度**：`lifecycle.intervalMs=600000`；`updateIntervalHours=6` 按账本 `cadence` 节流；`episodeWindowDays` 取数窗口、`maxEpisodesPerRun` 入库上限；漂移 `driftConsecutive=3`。

**告警**：写 `soul_ledger action=alert`，同码 6h 抑制（`alertRecentlyLogged`）。`control`（`language_unmapped`、`rollback_applied`）与 `diagnostic`（`emotion_label_sparse`、`forgetting_*`）分级；`report.alerts` 由 lifecycle 汇总打日志。

**遗忘**：`forgetting` 只归档 `soul_episodes`（`archived_at`），保护源是 `soul_persona.meta.object` 的人名（`personaAnchor`）；保护源不可用时写告警 `forgetting_values_protection_unavailable`，不再静默恒 0。

## 6. 排查清单

```bash
# 当前卡（含 version/hash/chars/warnings）
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8420/v3/soul/card?team=&user=&agent='
# 本轮尾巴与未完的事
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8420/v3/soul/turn?team=&user=&agent=&session='
# 特质现在值（声明 vs 现在）
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8420/v3/soul/trait-state?team=&user=&agent='
# 注入健康（journal 聚合）
curl -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8420/v3/soul/injection/stats?team=&hours=24'
```

- journal：`D:/TDB/data/logs/recall/recall-journal-<team>-<agent>.jsonl`；`kind:"injection"` 是插件回传的权威量（带 `phase:"card"|"volatile"` 区分两条通道），`soul.source:"server-render"` 是召回侧估算。
- 插件注入原文证据：`D:/TDB/data/logs/persona-injection.jsonl`（插件侧常驻 JSONL，2 MB 轮转到 `.1`，不吃 `debug` 开关；路径可用 `TDB_PERSONA_LOG` 覆盖、`TDB_DATA_DIR` 改根）。
  - `event:"section-read"`：宿主真的调了 section getter，`chars`/`hash` 是**交出去的字节**。拿这里的 `hash` 与 `/v3/soul/card` 返回的 `hash` 比对，相等即证明「人格卡进了该会话的系统提示词」（L2 端到端证据）。
  - `event:"turn-append"`：本轮尾部块追加了多少字符；`event:"turn-skip"`：去重跳过，`chars` 恒为 0（跳过绝不记成注入）。
- 账本：`SELECT at,trigger,action,gates_json,reason FROM soul_ledger ORDER BY at DESC`；节流看 `action=cadence`，漂移看 `action=drift`（带 `protocol_version`），拒绝看 `action=reject`。
- 快照：`SELECT ts,trigger,version,payload_json FROM soul_snapshots ORDER BY ts DESC`（`payload_json.text` 即注入原文）。
- 服务：`D:/TDB/data/run/tdb-supervisor.state.json`（schema 3，15s 心跳，`managed` 全量名单 + `origin` 标注来源）。

## 7. 已退场（禁复活）

`core_pending` / 提案与人工采纳 / 自动采纳门 / 提案去重与相似门；`core_memory` 身份槽导入（`slot-import`）；`anchor-growth` 价值锚自生长与 `anchor_growth_state`；`core_values` 整表与 Panel 价值锚读写面；`soul-assembler` 的人格/红线/承诺渲染（只留 `buildSoulPrefix` 的 `<soul-feeling>` 给自省端点）；`soulMaintenance.enabled` 总闸（人格恒开）；`role_prompt` / `rules_prompt`（人设只在人格卡表单）；插件的 `volatile.soul.*` 旧注入回退；`replay.ts` 回放校准；`freeze` 作为「事实退出注入」的语义。

墓碑注释保留在代码里（可审计），但不要再接回读链。

## 8. 验收

```bash
cd MemoryCore && node scripts/typecheck-gate.mjs          # Δ ≤ 0（基线 121 errors / 23 files）
cd MemoryCore && npx vitest run                           # 全量
cd MemoryPanel && npx tsc --noEmit && npx vitest run      # Panel
cd MemoryPanel/web && npm run build                        # 前端产物
cd dsh-plugin && npm test && npm run build                 # 插件
```

生产验收看四件：卡里区块非空（名称/底色/红线）、`soul_ledger` 无 `episode_history` freeze 增量、`/v3/soul/injection/stats` 有 rows、`soul_snapshots` 最新 `payload_json` 含红线与 `关于你`。
