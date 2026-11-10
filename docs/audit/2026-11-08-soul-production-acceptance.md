# Soul 人格系统生产终验报告（2026-11-08）

> 范围：`D:/TDB/td-agemem` 的「人格/灵魂系统」上线前终验——机制是否闭环、数据是否真的长出来、门是否全绿。
> 方式：只读。未改源码、配置、测试，未写生产库，未重启任何进程，未 commit/push。本文件是终验新增文档。
> 数据快照：生产数字取自 2026-11-08 02:46–02:58（+08:00）/ 18:46–18:58Z 的只读查询、接口返回与日志抽样；库在持续写入，引用时请保留时间。
> 证据分级：L1 生产库只读 > L2 真实会话/日志实拍 > L3 临时库运行 > L4 单测 > L5 代码。**L4/L5 不单独判 PASS。**
> 前序文档：`docs/audit/2026-11-07-soul-system-review.md`（同日早些时候的评审，P0/P1 已修）。本文件是终验口径，不复述已修项。

## 0. 结论

1. 注入链路端到端成立且可证伪：本会话 `t1s1` 卡长 774、`sha256 8b5df2984757a49b…ddbb8`，与 journal `18:47:26.416Z` 的 section-read 行 `chars/hash` 逐字节相等；同 persona 四会话 `667/114527f9a670` 逐字节一致，不同 persona 未串卡。
2. 人格**没有真的长出来**：`soul_persona` 8 行全部属于 `agt-bbr29z58s2`（测试人设），真实用户 `agt-fa0u5mi7x4`（审墨）观测层 0 行；八层只落 4 层（values/boundary/narrative/human 全 0）。
3. 三条自维护通道生产为空：`soul_emotions` 0 行、`soul_promises` 0 行、`soul_promise_events` 0 行；窗口内 `admit 8 / reject 421`（1.86%）。
4. 门全绿、服务健在：四条门 exit=0（Core 3793/401、Panel 282/36、plugin 712/40、typecheck Δ=-28），三端口 200，supervisor 32892 托管三服务 restarts 0；但 tdai-core 每约 10 分钟一次 fake-dead 自愈，根因未采集。
5. 定位：**注入链路可以上线（声明式人格卡）；「自维护人格」不能按已交付宣传**（1 个 agent / 4 层 / 情绪与承诺 0 行）。

## 1. 口径确认（两条曾被误判为缺陷，实为设计）

> 写入原因：避免后续复审重复报缺陷。

- **A3 首轮第一步无卡 = 多 agent 设计，不是缺陷。** 当前是多 agent 架构，宿主先要选定 agent，绑定发生在选择之后，故选择的那个 step 还没有卡。实测时序与之一致：会话首个 turn 先 `card-bound chars:0`，数秒后才 `card-bound chars:<真卡>`（`session-0856bb8c`：`18:46:19.096` → `18:46:24.328`；`session-79811b51`：`17:41:40.561` → `17:41:45.801`）。**判定：符合设计，不再作为缺陷。**
- **子智能体无 persona 卡 = 不适用，不是缺陷。** 子智能体不受人格卡约束（无红线、无说话方式）。实测：`session-7b76ba19` 解码 788218 字节，「[读法]」0 次、「## 名称」0 次；journal 对其 `card-bound chars:0` 20 行、`section-read no-card` 9 行。**判定：不适用。**

## 2. 门与数字（亲自重跑，未引用历史数字）

| 门 | 命令 | 退出码 | 关键输出（原样） | 判定 |
|---|---|---|---|---|
| Core typecheck | `cd MemoryCore && node scripts/typecheck-gate.mjs` | 0 | `[typecheck-gate] 当前 121 errors / 23 files；基线 149 errors / 28 files；Δ=-28` | PASS |
| Core 单测 | `cd MemoryCore && npx vitest run` | 0 | `Test Files  401 passed (401)` / `Tests  3793 passed (3793)` 35.48s | PASS（仅记数） |
| Panel 类型 | `cd MemoryPanel && npx tsc --noEmit` | 0 | 无输出 | PASS |
| Panel 单测 | `cd MemoryPanel && npx vitest run` | 0 | `Test Files  36 passed (36)` / `Tests  282 passed (282)` 2.60s | PASS |
| Panel 构建 | `cd MemoryPanel/web && npm run build` | 0 | `✓ 1374 modules transformed.` `assets/main-Ow7tRmOc.js 2,139.72 kB │ gzip: 531.59 kB` `✓ built in 6.73s` | PASS，3 警告：graphology-types 重复键（`package.json:22:4` 与 `:19:4`）、teamApi.ts 双导入、chunk >500kB |
| Plugin 类型 | `cd dsh-plugin && npx tsc --noEmit` | 0 | 无输出 | PASS |
| Plugin 单测 | `cd dsh-plugin && npx vitest run` | 0 | `Test Files  40 passed (40)` / `Tests  712 passed (712)` 57.14s | PASS（与历史 765 差异原因未采集） |
| Plugin 构建 | `cd dsh-plugin && npm run build` | 0 | `> tsc -p tsconfig.json` | PASS |
| 健康 | `GET /health` ×3（02:58:27） | 200/200/200 | 8420 `{"status":"ok","version":"0.1.0","uptime":1425,…}`；8421 `{"status":"ok",…}`；8123 `{"status":"ok"}` | PASS |
| 托管 | `GET 127.0.0.1:8446/status` | 200 | `supervisorPid:32892 hostPid:15016 hostPidAlive:true restartsUsed:0 maxRestarts:3`；三服务 `origin:"owned" healthy:true restarts:0`（60044/55588/40776） | PASS |

## 3. 逐条判定

### A 注入端到端

| 项 | 证据 | 级别 | 判定 |
|---|---|---|---|
| A1 卡进真实会话且 chars 相等 | `session-0856bb8c` t1s1 抽出 section 长 774、`sha256 8b5df2984757a49b…ddbb8`；journal `18:47:26.416Z` `chars:774` 同 hash；卡尾 `<!-- persona-card v="12" hash="4f87f9899b0f" -->` | L2+L1 | PASS |
| A2 `via/sidSource/sidField` | 同上行 `"sidSource":"context-agent","sidField":"agent.id","via":"getter"`；当前 pid 15016 上 chars>0 的 92 条全部带 via（getter 91 / assemble-hook 1），chars=0 的 230 条按设计无 via | L2 | PASS |
| A3 首 step 带卡 | 12 个已解码会话里首 step 有卡 2 个；见 §1 口径确认 | L2 | **不适用（多 agent 选择）** |
| A4 多会话隔离 | `agt-fa0u5mi7x4` 四会话 667/`114527f9a670`/`b261f53c34d1` 逐字节同；`agt-bbr29z58s2` 两会话 740/`de1a66336140` 同；0856bb8c 774 名「审墨」、f0c9f3f0 未命名、79811b51 254 未命名，与 `meta_agents.name` 一一对应 | L2+L1 | PASS |
| A5 卡版本变化后重注入 | journal `17:43:43.403 card-bound` ver20 `de1a663…` 740 → `18:14:50.280` ver21 `5f2b4f4…` 822；会话原文 t64s2 出现 740、t66s2 出现 822 | L2 | PASS（identity 未变，真「换 agent 换卡」场景未采集） |
| A6 `card-bound-failed` 分布 | journal 2555 行：empty 599 / http_status 52 / timeout 27 / parse 1；非合成会话失败仅 2 条——`18:14:18.070 timeout`(session-8f85d27e, chars 0)、`18:34:31.350 parse`(session-f0c9f3f0, `18:35:54` 自愈同 ver21 同 hash) | L2 | PASS（附缺陷 D-5：journal 被单测污染） |

### B 人格是否真长出来（L1）

| 项 | 实测 | 判定 |
|---|---|---|
| B1 `soul_persona` | 8 行全 `agt-bbr29z58s2`；layer identity 1 / relationship 3 / self 3 / voice 1，**values/boundary/narrative/human 各 0**；state 全 active；meta source episode-history 6 / l1+model+episode 2 | FAIL |
| B2 `soul_episodes` | 30 行：work 25（83.3%）/ complaint 3 / decision 2；最新 `18:49:53.927Z`；affect_source 全 lexicon | FAIL（work 占绝对多数，代码 worker.ts:1994 已排除其进情绪） |
| B3 admit vs reject | 窗口 482 行：admit 8 / reject 421（**1.86%**），另 arbitrate 18 / alert 18 / cadence 16 / drift 8 / trait_normalized 3；reject 主因「独立证据 1–2 < 3」63.8%，其次任务锚 48、价值须在冲突中显形 41、超形态上限 90 字 27 | FAIL（门偏严 + 候选多为任务播报） |
| B4 trait 有界与漂移 | 7 行/6 agent；axis 范数最大 0.2685（`agt-fa0u5mi7x4`，≤0.5 成立）；drift 8 条全 `agt-bbr29z58s2`（rigor +0.0455、boundary +0.0468、openness +0.0117，Σ0.104）；trait_normalized 3 条（含 2.1→0.4998、1.2835→0.4998 L1 归一） | 部分 PASS（漂移只在测试人设身上动过） |
| B5 情绪 | `soul_emotions` **0 行**（24 模板 0/24）；`soul_state` 6 行 label 踏实×2 / 振奋×1 / null×3；alert「情绪标签零实例」16 条，`06:42:44.658Z→18:46:23.373Z`，5.4 秒连发 5 条 | FAIL |
| B6 承诺 | `soul_promises` 0 行、`soul_promise_events` 0 行（表存在） | FAIL（没产生） |
| B7 contradict/rollback | ledger action 7 类，contradict / rollback / rollback_requested 各 0 行；文本兜底 3 行只是候选内容用词 | 未采集（路径未触发，不算 PASS） |

### C 机制一致性（L5，只找矛盾）

| 项 | 证据 | 判定 |
|---|---|---|
| C1 写点与四态 | 写点 `sqlite.ts:3361` upsert / `:3460 DELETE + :3462 ON CONFLICT`；调用方 `worker.ts:2221`、`forgetting-worker.ts:207`、`worker.ts:968`；读侧 `sqlite.ts:3346` **无 state、无 validTo 过滤**，靠 `card-service.ts:115-116` 与 `persona.ts:300-301` 渲染过滤；`supersededBy` 无生产写入点；`validTo` 只写不读 | FAIL |
| C2 卡预算 | `card.ts:41 CARD_MAX_CHARS = 2000`；丢块序 `:46-51`；实测最大 822（f0c9f3f0 ver21）、本会话 774，未丢块；`types.ts:353-414` 的 budget/maxItemChars 在 card.ts 与 card-service.ts **0 命中** | PASS（附注：config 预算对卡无效，只作用写侧 gates.ts:70-108） |
| C3 红线 | `card-service.ts:198-199` 只 filter(active) → `card.ts:209-211` 逐行「- 」；无 join/合并；仅单行 >120 字 slice 加 warning(`:358-360`)；本会话 4 条与 `meta_agent_persona.redlines_json` 4 条一致 | PASS |
| C4 mood_gate | `gates_json LIKE '%mood_gate%'` = **0 行**；emotion.ts:734-757 仍返回 defer，worker.ts:1490-1504 只落 observed_only | PASS（附注：情绪经 `["mood_bias"]` 18 条进 arbitrate） |
| C5 配置漂移 | 13 类，见 D-7 | FAIL |

### D 运维面

| 项 | 实测 | 判定 |
|---|---|---|
| D1 端口与托管 | 8420/8421/8123 均 200；8446 三服务 owned/healthy/restarts 0 | PASS |
| D2 heartbeat 与事件 | state `mtime 18:58:19.978Z`、`lastTick 02:58:19.978(+08)`、heartbeatSeconds 15、paused false、lastError ""；events 88 行末条 `02:54:49 adopt` | 有条件 PASS（D-6 fake-dead 周期） |
| D3 重启存活时序（只读） | plugin log：`module loaded v0.4.0` → `apply enter hostPid=15016` → `supervisor spawned pid=32892` → `control plane on 127.0.0.1:8446`（18:34:12.205/.340/.374/18:34:13.487），与 state 一致 | PASS |

## 4. 缺陷清单（降序，只描述不改）

### D-1 「人格自维护」实际只覆盖 1 个 agent、4 个层（最高优先）

- 触发：真实用户 agent 使用声明层 persona 卡。
- 当前后果：`soul_persona` 8 行全属 `agt-bbr29z58s2`；`agt-fa0u5mi7x4`（审墨）观测层 0 行，其卡内形象/说话方式/使命/红线全部来自 `meta_agent_persona` 声明；values/boundary/narrative/human 恒 0。
- 证据：§3 B1；`meta_agent_persona` 仅 2 行（`agt-3i8k22f496` 青禾、`agt-fa0u5mi7x4` 审墨）。
- 最小修面：不是单点代码，是层准入策略（`MemoryCore/src/core/soul/gates.ts:70-108` 与 `worker.ts:2163` 附近）。

### D-2 `soul_emotions` 恒 0（情绪史永不落表）

- 触发：每个 tick。
- 机制：唯一写入口 `worker.ts:2083-2085` 的待写行来自 `episodeEvents` = 水位 `moodIntegratedAt` 之后新增且 `kind!=="work"` 的事件（`worker.ts:1991-1998`，`:1994` 直接排除 work）；水位每 tick 推进到 now（`soul.moodIntegratedAt = 18:55:49.141Z` 恰等于 `soul_state.max(updated_at)`），而 5 条非 work episode 全部早于水位 → 永远为空。
- 当前后果：情绪史无法回溯；24 模板 0/24 入库；但 `soul_state` 仍有 label → 两条通道不对称，不是写失败（Core 日志 `commitSoulEmotions failed` 0 命中）。
- 最小修面：`worker.ts:1991-1998`（水位与事件选取）+ 落表时机。

### D-3 准入门过严：admit:reject = 1.86%

- 触发：每轮人格候选。
- 证据：窗口 482 行内 admit 8 / reject 421；reject 主因「独立证据 1–2 < 3」占 63.8%，其次「含任务锚，换项目即不成立」48、「价值必须在冲突中显形」41、「超形态上限 90 字」27。
- 当前后果：真实会话 1 天只长出 8 条，且全部落在测试人设；真实 agent 0 条。
- 最小修面：`gates.ts`（证据数门槛与形态上限）与候选生成侧（任务播报应更早过滤，不该都走到 reject）。

### D-4 情绪告警无抑制且与实态脱节

- 触发：每个 tick 的 `emotion_label_sparse`。
- 证据：ledger 16 条（`06:42:44.658Z→18:46:23.373Z`，跨度 12.061h），间隔 min 0.088s / 中位 2.596s；`06:42:44` 与 `12:44:00` 各有 5.4 秒/31 秒内连发 5 条；payload 全 `["emotion_label_sparse"]`、`evidence_json []`、无 cadence/cooldown 字段；而 `soul_state` 同期已有 踏实/振奋 两个标签 → 告警只数 `soul_emotions` 表，与 state 实有标签矛盾。
- 最小修面：`worker.ts` 告警判定改为「state ∪ emotions」，并加同因去重窗口。

### D-5 生产注入 journal 被单测污染

- 触发：跑 `dsh-plugin` vitest（会话 id 形如 `s1`/`s-one`/`s-card`/`s-preset`）。
- 证据：2555 行里 empty 599 条主要来自合成会话（s1 340、s-fail-open 43、s-one 43、s-two 43、s-card 30、s-tool 30、s-preset 30、s2 26、s-bypass 13）；真实失败只有 2 条。
- 当前后果：任何按 reason 的失败率统计都不可证伪。
- 最小修面：`dsh-plugin/src/injection-log.ts:40-52` 写盘前判测试环境，或测试注入独立 logPath。

### D-6 tdai-core 周期 fake-dead

- 触发：约每 600s。
- 证据：events `02:44:24.928 fail` → `02:44:37.247 adopt`；`02:54:26.754 fail` → `02:54:49.952 adopt`（间隔 601.8s）；reason 均为 `fake-dead: alive but /health not 200 (not killed)`；进程 pid 60044 未变、`restartsUsed:0`。
- 当前后果：不误杀，但污染运维判断；若超时叠加重启阈值可能误重启。**根因未采集。**
- 最小修面：插件侧探活超时/退避（`dsh-plugin` 监管探活逻辑）。

### D-7 文档与配置漂移 13 处

| # | 位置 | 漂移 |
|---|---|---|
| 1 | `docs/soul-self-maintenance.md:44` | `PERSONA_CARD_REVALIDATE_MS` 在 dsh-plugin 0 命中；真实常量是 `persona-card.ts:42 SECTION_READ_HEARTBEAT_MS = 300_000`（只作日志心跳） |
| 2 | 同上 `:44/:46` | 「一次取冻结 + 后台刷新 + fail-open 保留冻结文本」与 `persona-card.ts:19-21`「不缓存，每次 bind 都 fetchCard」相反 |
| 3 | 同上 `:45` | 「单条 360」无此常量，代码为 400（`traits.ts:45`、`persona-card.ts:39/:474`） |
| 4 | 同上 `:49/:51` | 「15 区块 / 心境进卡」与 `card.ts:24-36` 的 11 块、无心境不符（心境只在 `/v3/soul/turn`） |
| 5 | 同上 `:51` | 名称「D→O→骨架」已废（`card-service.ts:188` 名字只认声明） |
| 6 | 同上 `:102` | 称 `volatile.soul.*` 已退场，但 `config/templates/dsh-plugin.keys.json:285-312` 仍列；`dsh-plugin/src` 0 命中 → 写了不生效 |
| 7 | 同上 `:71` | 「不再 freeze / supersededBy / 只取未失效」三条全不成立（见 C1） |
| 8 | 同上 `:73` | 6 个 episode 键当配置项，`MemoryCore/src/config.ts` 全 0 命中（只有 types.ts 缺省值） |
| 9 | `docs/adr/0028:18` | 「唯一写者 commitSoulPersona」不精确：调用方 3 个，且 rollback 是第二组物理写 |
| 10 | `docs/adr/0028:22` | `ADD/UPDATE/INVALIDATE/NOOP` 字样 0 命中；真实 action 联合在 `types.ts:206-228` |
| 11 | `MemoryCore/src/config.ts:1622-1623` | 注释仍写已删总闸 `enabled=false` |
| 12 | `MemoryPanel/web/src/pages/SettingsPage/configCatalog.ts:742` 起 | soulMaintenance 的 source 行号漂移（实际解析在 `config.ts:1624-1671`） |
| 13 | `MemoryCore/tdai-gateway.yaml:469-509` | 缺 self / human 的 budget 与 maxItems |

### D-8 `soul_state` 累积可疑

- 证据：`agt-fa0u5mi7x4` 的 `sample_count` 从 4（18:46Z）变 0（18:56Z），两条 `emotion_intensity` 变 null，label/object 保留。
- 当前后果：心境可能被周期性重置，累积不成立。**重置路径未采集。**
- 最小修面：`worker.ts:2047-2050`（prevState 兜底与 sample 累积）。

### D-9 `soul.episodeWatermark` 不推进

- 证据：`embedding_meta` 中 `soul.episodeWatermark = 2026-11-07T06:42:15.634Z`（12h13m 未推进），而 L0 中 `recorded_at` 晚于它的有 172 条、episode 仍在增长（28→30）。
- 判断：该键不是实际游标，或写回失效。**未采集是哪种。**

## 5. 上线判定

**有条件上线**：声明式人格卡注入可以上；「自维护人格」不能按已交付宣传。

必修（上线前）：

1. 对外口径：自维护人格实测仅 1 个 agent / 4 个层 / 8 条，情绪与承诺 0 行 —— 不得宣称「人格自己长出来」（依据 §3 B1/B5/B6）。
2. D-5 生产 journal 去污染（`injection-log.ts:40-52`），否则后续「注入失败率」不可证伪。
3. D-4 告警抑制 + 判定改为「state ∪ emotions」，否则账本会被同因告警淹没。

上线后 24h 三个指标：

| # | 指标 | 当前值 | 目标 |
|---|---|---|---|
| 1 | `soul_emotions` 行数 / 非 work episode 占比 | 0 行 / 5:30 = 16.7% | >0 行 / >30% |
| 2 | admit:reject | 8:421 = 1.86% | ≥10%（或明确调整门判据并记录理由） |
| 3 | tdai-core fail 事件数 / restartsUsed | 每 600s 一次 / 0 | 24h 内 0 次 / 仍为 0 |

## 6. 本轮未采集

- 真实用户流量下的长期注入（只有本会话 774 一条真实链路）。
- 宿主重启后的注入实测（本轮按约束未重启）。
- A5 真「换 agent 换卡」场景。
- contradict / rollback / rollback_requested 生产路径。
- D-6 tdai-core fake-dead 根因。
- D-8 `sample_count` 归零路径、D-9 watermark 写回是否失效。
- Core 测试数 398→401、plugin 765→712 的差异原因。
