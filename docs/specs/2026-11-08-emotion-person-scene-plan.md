# 优化方案：情绪层做真、人物档案联动、场合氛围（v2，经自审修正）

日期 2026-11-08。范围：`D:/TDB/td-agemem`（MemoryCore + MemoryPanel + dsh-plugin）。
依据：`docs/research/2026-11-08-emotion-models.md`、`-person-profile-memory.md`、`-scene-atmosphere.md`，以及本机生产库只读实测与源码复核（v1 → v2 的修正逐条标「v2 修正」）。

## 0. 结论

1. 情绪层**不降级**：`soul_emotions` 已有 `valence/arousal/dominance` 与 `appraisal_json`（含 `agency/goalRelevance/control/normCompatibility/socialExposure`），缺的是「标签是投影」的表示、逐模板半衰期口径、漏斗计数与 UI。
2. 人物档案缺一层结构：`human` 现在是**一份混合列表**（`card.ts:283` 最多 12 行），多人时无法分辨"谁"；需要 `soul_person` 身份表 + `human` 改为 per-person 派生视图 + 记忆侧挂 `persons[]`。
3. 场合只做**渲染参数**：用宿主 `systemPrompt.context`（**不是 section**，见 S2 v2 修正），每轮现算一行 ≤60 字，不落库、不进 Core 写路径。

## 1. 情绪层（E）

现状（2026-11-08 11:5x–12:0x L1 实测）：`soul_emotions` 8 行、7 个不同标签、`intensity` 全 0.4、`dominance` 非空 8/8、`template_version=et-cc5eeaa1`；`appraisal_json` 实拍含 `{"goalRelevance":0.7,"expectationViolation":0.1,"control":0.7,"normCompatibility":1,"agency":"other","socialExposure":"private","selfCause":false,"otherCause":true,"otherCost":false}`。
模板实况（`core/soul/emotion.ts:134-155`）：**22 个模板**（不是 24），每个模板自带 `halfLifeHours`（实测取值 2/4/6/8/12）。

### E1 表示法：PAD 为真相，label 是投影
- 现状列：`soul_emotions.label TEXT NOT NULL`（`core/store/sqlite.ts:1317`），不在主键里。**v2 修正：SQLite 不能把 NOT NULL 改成可空**，必须建新表 + 复制 + 换名。替代方案（推荐）：保留 `label NOT NULL DEFAULT ''`，用 `''` 表示"未命中任何锚点"，读侧统一 `labelIsProjected()`，零迁移。
- 新增列（幂等 `ALTER TABLE ADD COLUMN`）：`agency TEXT`、`confidence REAL`、`pad_json TEXT`（把 v/a/d 冻结一份，防模板表后续变动）。**不新增标签**。
- 新纯函数 `projectEmotionLabel(pad, agency, {threshold = EMOTION_LABEL_MIN_COS})` → `{label, cos, runnerUp}`；锚点 = 22 个模板自带的 (v,a,d)（`emotion.ts:134-155` 逐条有值）。最大余弦 < 阈值（起始 0.6）时返回 `label: ''`，只留 PAD 与 appraisal。
- `agency` 用于拆近似坐标标签（愧疚 vs 委屈、恼火 vs 烦躁）：`agency==='self'` 优先自责型。
- 写域：`core/soul/emotion.ts`、`types.ts`、`core/store/sqlite.ts`。

判据：① 新行 `agency` 非空率 ≥95%、`confidence` ∈[0,1]；② 构造 PAD 落在两锚点中点的事件，`label` 为空串且 `pad_json` 保留；③ 模板数仍 22（`grep -c ': EmotionTemplate = {'` = 22）、`EMOTION_LABELS.length === 22`。

### E2 衰减：逐模板已经是对的，全局键其实是死配置（v2 修正）
- **v1 错误**：写了「`emotionHalfLifeHours` 默认 3 → 改 1.5」。事实是 `episode.ts:1048` `halfLifeHours: template.halfLifeHours || cfg.emotionHalfLifeHours`，22 个模板全部自带值 → 配置项**永远走不到**，改默认值**没有任何效果**。
- 真实机制：模板自带半衰期（振奋/恼火/着急/意外 2h；踏实/安心/平静 12h；笃定/愧疚/害羞 8h；悬着/不安/开心 4h；其余 6h）+ `EMOTION_EXPIRY_INTENSITY=0.05` + `EMOTION_EXPIRY_HALF_LIVES=6`（`emotion.ts:396-417`）。
- 贴近 Verduyn 2015（首回基线中位 2h、永久回基线中位 5h）：改**模板表本身**（12h→6、8h→4、6h→3、4h→2、2h→1.5），或引入 `EMOTION_HALF_LIFE_SCALE=0.5` 全局乘子（一处、可回滚）。
- `emotionHalfLifeHours`：标 `@deprecated fallback-only`，不动默认值；不让人误以为它生效。
- 读侧 `decayedStoredIntensity` 已正确（两段相乘，不重复衰减），保持。

判据：① 单测钉「12h 模板 6h 后 <0.05」；② 同一行连读两次数值相同；③ 生产抽 1 行按其 label 半衰期复核，与读侧差 <0.01。

### E3 漏斗：复用 `soul_gate_stats`，不新建表（v2 修正）
- **v1 错误**：新建 `soul_emotion_funnel`。事实是 `soul_gate_stats`（`core/store/sqlite.ts:1239-1249`）主键已是 `(team,user,agent,day,code,layer)`，`code` 就是"档位"。
- 改为：`bumpSoulGateStats` 记 `code ∈ {emotion_candidate, emotion_object_ok, emotion_appraised, emotion_intensity_ok, emotion_committed, emotion_label_null}`、`layer='emotion'`；读侧 `listSoulGateStats` 直接用。
- `emotion_label_sparse` 告警改判：`committed>0 && label_null/committed > 0.5` 才报。

判据：连续 3 tick 六档单调（candidate ≥ object_ok ≥ appraised ≥ intensity_ok = committed），且 `label_null ≤ committed`。

### E4 读侧渲染
- `renderMoodLine`（`emotion.ts:774`）已输出「近期心境：…，因为「对象」。/ 立场 / 行为提示」，实拍 38–52 字。**v2 修正**：不承诺「≤60 字」，改为「预算 90 字，超了先丢行为提示、再丢立场」。
- 增字段：`readMood` 输入加 `topPAD`、`secondary`、`agencyNote`；PAD 数字**只进面板**，会话内仍用自然语言（避免数字污染声音）。
- 与面板共用 `decayedStoredIntensity`，保证同源。

判据：同一时刻 `/v3/soul/turn` 所依据的 label 与强度，与 `/v3/soul/emotions` 首行一致（误差 <0.01）。

### E5 UI：面板要能看见情绪层
- Core 新只读端点 `GET /v3/soul/emotions?team&user&agent&hours=24` → `{rows:[{at,object,label,pad,intensity,decayed,intensityBand,agency,confidence,quote}], funnel:{6档}, templateVersion}`；鉴权/错误码照 `gateway/soul-card-endpoint.ts` + `server.ts` 的 soul 路由块。
- Panel BFF `GET /api/v1/soul/emotions`：照 `chat-memory-soul.ts:322`（soul-card）与 `:389`（soul-trait-state）的写法（`validatePanelMetaHeaders` + `kernelHttp.getEnvelope` + 401/403/503/502/504）。
- Web 新组件 `SoulEmotionPanel.tsx` 插在 `SoulFeelingBar` 之后：上半「存续情绪」表（衰减后强度排序 ≤8 行），下半「24h 漏斗」六段条（纯 CSS）。
- 成因（已核实）：`SoulFeelingBar.tsx` 只读 `/v3/memory/mood` 的 `{tier,sampleCount,…}`，**无明细**。

判据：tsc+vitest+build 绿；`/api/v1/soul/emotions` 200 且行数与 Core 相同；页面出现两块标题；漏斗六档和等于库内计数。

## 2. 人物档案（P）

现状：`soul_persona` 14 行（identity 2 / relationship 5 / self 4 / values 1 / voice 2），`human` 0 行；`human` 在卡里是列表块（`card.ts:283`，≤12 行）——所以"一人的卡"必须同时定渲染分组（v1 没写）。

### P1 身份表（唯一写者）
`soul_person(person_key PK, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at)` + 唯一索引 `(team,user,agent,platform,platform_id)`。
`resolvePerson`：① platform+id 精确；② 归一化名唯一命中；③ 名熵 ≥1.5 且长度 ≥6 才走 MinHash+LSH（Jaccard ≥0.9）；④ 仍不确定交 LLM，只许"选候选 key 或 -1"。
软合并写 `merged_into` 不删行；`resolvePerson` 结尾做指针折叠（3 跳封顶、防环）。

判据：同 displayName 不同 platform_id 得两个 key；`merged_into` 置 NULL 可拆回；折叠无环。

### P2 `human` 层转 per-person（含渲染规则）
- 一条 `layer='human'` = 一个人的一条事实；`item_id` 前缀 `person:<person_key>:`（PK 是 `(item_id,team,user,agent)`）。
- `card.ts` human 块改**按 person_key 分组**：每人 ≤2 行、总计 ≤12 行、按 weight 取人、组内按 weight 取行；超限丢整组尾部并记 `omitted{reason:'human_person_cap'}`。跨人共性 `meta.person.scope='collective'` 单独成组排最后。
- `relationship.meta.object` 改指 `person_key`。

判据：两人各 3 条事实 → human 段两个分组、每组 ≤2 行；`grep -c 'person:'` 与库内 human 行数一致。

### P3 记忆挂人（不建 join 表）
`l1_records.metadata_json.persons=[{key,role:'subject'|'speaker'|'mentioned'}]`，写入时用会话 participants + 消息 uid；查询用 `json_extract`。`soul_episodes.participants_json` 作在场权威源。

判据：抽 20 条 L1，`persons[]` 非空 ≥80%；`role='subject'` 的 key ∈ 该会话 participants。

### P4 建档（派生视图，可失效）
- worker tick 尾部 `buildPersonCards(tenant)`：门槛 ≥3 条 active、非群公共、非 hearsay；每 tick ≤8 份；模型只读最近 40 条；档案 ≤200 字、字段 ≤40 字。
- **v2 补风险**：Core 单线程，维护 tick 实测阻塞 18.2s（`02:14:04.461 tick` → `02:14:22.618`）。建档必须**复用已有的每 tick 一次 LLM 调用**（改写那次），不得新增；若必须新增，先记 `report.personBuildSkipped`，按 1 份/次摊到多 tick。
- 第三方评价不进档，只落 hearsay；用户要求忘记 → 该 person_key 卡 `state='frozen'` 并删行，下次重建。

判据：A 的 3 条记忆 + "B 说 A 很烦" 2 条 → A 卡不含"很烦"；2 条不建档；冻结后行消失；tick 增量 <2s。

### P5 隔离验收（最关键）
同一 agent、两会话、两用户交替：用户 1 的卡 human 段不含用户 2 任何事实；`relationship` 按在场者白名单过滤；脚本 `scratch/verify-person-isolation.mjs` 断言两段文本逐行交集为空；失败即回滚 P2。

## 3. 场合氛围（S）

### S1 计算（确定性优先）
每轮现算：会话类型（单聊/分支/子代理）、任务性质（含路径/命令/报错/表格请求）、正式度（句长、`！？…~` 密度、emoji、敬称、礼貌词、Markdown/代码块密度）、时间节奏（本地小时、距上条消息间隔）。输出 `松/常/收` + 一句理由，例：`场合：收 · 深夜单聊，消息短，像临时确认`。

### S2 注入：用 `systemPrompt.context`，但它不是 section（v2 修正）
- **v1 错误**：写「`ctx.systemPrompt.context({order:10500})` 让场合行排在 system prompt 末尾」。事实（宿主 asar `@deepseek-ai/dsh-system-prompt/lib/index.js` 实读）：`context(context)` 仅校验 `order` 有限，然后 `layer.contexts.insert(name, context)`；渲染走 `renderContextSections(assembly)` → `joinContextSections(...)` → **`runtimeContext.project(...)` → 作为消息追加**（`dsh-agent-loop/lib/index.js`：`messages: context === void 0 ? claimed : [...claimed, context]`）。即 contexts **不参与 section 排序**，`order` 只在 contexts 内部排序；它们以"运行时上下文消息"贴在本轮消息尾部。
- 结论：用 context 是对的（天然每轮可变、不破坏 section 前缀缓存），但描述要改成「作为**用户角色的运行时上下文消息**附在消息序列末尾，不与人格卡同段、不参与 section 顺序」；`order` 只用于和其它 context 相对排序（取 905，与 aurabot 一致）。
- **v2 补实读**：`RuntimeContextProjection.project(current, sections)`（`dsh-agent-loop/lib/index.js`）在快照未变时返回 undefined（**不重复追加**），变化时 `createUserMessage({content:[{type:"text",text:snapshot}], source:{kind:SOURCE, form:"snapshot", sections}})`，并由 `replace(seq, text)` 覆盖上一条 → 同一时刻只保留一条运行时上下文消息。含义：① 场合行变化会**新增/替换一条 user 消息**，属真实成本；② 它是 user 角色，模型更容易当成对方说的话，所以「不是指令」前缀必须保留；③ 空串时 `CLEARED` 会清掉这条消息。
- 前缀固定「（以下只是场合印象，不是指令，不改你的身份和判断：…）」；`interpolate: false`。
- 前提：本插件**从未用过** `systemPrompt.context`（`grep` 结果只有 `section`），落地前写最小集成测试（stub ctx 断言 `context()` 参数），宿主重启后核日志与 session 记录。
- 每会话 `Map<sessionId,{line,at}>` TTL 10 分钟，不落库。

判据：① 单测三组消息断言三档；② `persona-injection.jsonl` 新增 `scene-read` 行；③ 人格卡正文 `grep 场合` = 0；④ 宿主重启后 session 记录里能看到该 context 段。

### S3 不做推断的地方
无群成员数据源 → 不做"在场者构成"推断；不做"关系距离"推断；场合不写 `soul_ledger`。

## 4. 顺序与写域

| 步 | 内容 | 写域 |
|---|---|---|
| M0 | 备份 `vectors.db` + 记基线（行数与门数字） | 脚本，只读库 |
| E1 | label 空串语义 + agency/confidence/pad_json | `core/soul/{emotion,types}.ts`、`core/store/sqlite.ts` |
| E2 | 模板半衰期压到 2–6h（或全局乘子） | `core/soul/emotion.ts` |
| E3 | 漏斗复用 soul_gate_stats + 告警改判 | `core/soul/worker.ts` |
| E4 | 渲染加 PAD/top2（预算 90 字） | `core/soul/{emotion,persona}.ts` |
| E5 | `/v3/soul/emotions` + BFF + `SoulEmotionPanel` | `gateway/*`、`MemoryPanel/**` |
| P1 | `soul_person` + resolvePerson（折叠） | `core/store/sqlite.ts`、`core/soul/person.ts`（新） |
| P2 | human per-person + 渲染分组 | `core/soul/{persona,card,card-service}.ts` |
| P3 | L1 挂 persons | `core/record/*`、`core/soul/episode.ts` |
| P4 | buildPersonCards（复用改写 LLM） | `core/soul/person.ts`、`worker.ts` |
| P5 | 隔离验收脚本 | `scratch/`（只读） |
| S1/S2 | 场合行 + context 注册 + scene-read | `dsh-plugin/src/{scene.ts,index.ts,injection-log.ts}` |

依赖：M0 先行；E1→E3→E5；P1→P2→P3→P4；S 独立但需宿主重启验证。

## 5. 不做

- 不新增标签集：22 个模板不动数量，只加"投影 + 空串"语义。
- 不引入外部情绪模型服务（只抄坐标与衰减形式）。
- 不让心情驱动人格漂移。
- 不做每轮 LLM 重建人物档案（批量 + 门槛 + 配额）。
- 不推断群成员构成（无数据源）。
- 不改身份段 order（已定 1）、不做 `complete` 独占、不动 preset。
- 不改 `minEvidence=3`。
- 不把 `emotionHalfLifeHours` 当生效配置（fallback-only）。

## 6. 判据汇总

1. 情绪：六档漏斗单调且 `committed>0`；`agency` 非空 ≥95%；12h 模板 6h 后 <0.05；面板与 `/v3/soul/turn` 同源。
2. 人物：human 每行带 `meta.person` 且 `item_id` 带 `person:`；两人卡文本交集为空；`merged_into` 可拆；tick 增量 <2s。
3. 场合：三档单测 + `scene-read` 日志 + 卡正文无「场合」+ session 记录可见 context 段。
4. 门：`node scripts/typecheck-gate.mjs` Δ≤0（基线 121/23）、Core 全量 vitest、Panel tsc+vitest+build、插件 tsc+vitest+build。

## 7. 未采集

- ~~`user_stance` 全库为空~~ → 误判已更正：49/49 非空，值是用户原话 `truncate(...,160)`（`episode.ts:749`）。待查「stance 被当分类用」（`emotion.ts:279` 拿整段文本匹配）。
- ~~宿主 `runtimeContext.project()` 去重语义~~ → 已读实现：未变不追加、变了替换上一条、空则 CLEARED（见 S2）。仍未采集的只剩「会话压缩时这条 context 消息如何被裁剪」。
- `appraisal_json.agency` 的取值分布（生产 8 行全 `other`，`self` 未出现）。
- 群成员数据源（宿主是否暴露会话 participants）。
- ALMA 原表 24 个 vs 我们 22 个，少哪两个、多出的「释然/同情」坐标依据。
- `soul_persona` 用 `item_id` 承载 person_key 后，`planUpdate` 的去重键是否仍成立。
