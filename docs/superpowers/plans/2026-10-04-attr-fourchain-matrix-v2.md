# 第二令：逐属性四链判定表 v2（函数级锚版）——载体与首批判定

> 2026-10-04 建立（63 号 ANCHOR-PRECISION 执行件，UR-18 锚精度要求=函数级）。上游取证基座：10-02 代码四链取证（探针统计+task_id 四链完整+GAP-1 createdByBadge TDD 修复 0c40f3c）+56 号 nodeType 联合统一（3d91234）。本文件=判定表载体：四链定义+名册+格式+首批 3 属性判定；续批按名册顺序推进，每批 3 属性（td-agemem-attr-fourchain-audit-sop 流程）。

## 一、四链定义（每属性逐链判定）

| 链 | 含义 | 代码面（file 级） |
|---|---|---|
| ① 获取 | L1 提取/解析写入 | record/l1-extractor.ts、v2-router 入口 |
| ② 评分使用 | 召回排序/遗忘/演化门 | tools/recall-signals.ts、lifecycle/forgetting、anchor-growth |
| ③ 注入 | auto-recall 灵魂/记忆注入 | hooks/auto-recall.ts、hooks/mood-line.ts、soul-assembler |
| ④ 展示 | Panel 徽章/属性表/锚面板 | MemoryPanel web attribute-badges.ts、ValueAnchorsPanel（GAP-1 修复 0c40f3c 在案） |

## 二、判定表五列格式

`设计原文摘录（2026-09-17-soul-memory-design.md §4 属性总表）｜代码 file:line（函数级）｜真数据（生产库/活体探针）｜✅⚠️❌📝｜差异说明`

## 三、属性名册（§4 总表 :220-261 + 五徽章 :164 + 锚属性 :126-130，续批顺序）

- **L1 记忆属性（批 1-4）**：valence · arousal · certainty（本文件首批）｜significance · sensitivity · source ｜ task_id · coreRefs · personRefs · identityRefs ｜ recallCount · evolution · valid_start · state · pinned · created_by
- **锚属性（批 5-6）**：node_type（56 号 3d91234 已统一）· attrs_json（role/aliases/description/facts）· weight · label ｜ valenceDir · slot · origin · created_by · description · state
- **徽章链（批 7）**：·强烈（arousal≥0.7）/ ·验证×N（recallCount≥3）/ ·核心事实（identityRefs）/ ·已演化（evolution 休眠）/ ·自 date 起（valid_start）/ created_by 徽章（GAP-1 修复）

## 四、首批判定表（valence / arousal / certainty）

### valence

| 列 | 内容 |
|---|---|
| 设计摘录 | :222「REAL，agent（归档评价），信号多来自用户表达；F4 情感显著度、锚方向聚合、渲染；∈[-1,1]」；:248 明确不建类别情绪（渲染派生防双源） |
| 代码锚 | 评分=emotionSalienceOf（recall-signals.ts:192，src{valence,arousal}）；感受段聚合=computeMoodValence（mood-line.ts:41，半衰期加权）；渲染=IS NULL 守卫 derive 后渲染（:200 设计锚）；方向映射 1→趋近/-1→审慎/0→中性（F17 valenceDir） |
| 真数据 | 10-02 探针：source=extraction 699 行 **无 null valence**；455 个 null 全集中 source 空旧语料行 |
| 判定 | ✅ 获取（新语料 100%）、评分、注入、展示四链在场；📝 旧语料 455 null=不回填（09-30 P2 定案=归档设计内），登记差异说明 |
| 差异 | 无行为差异；null 集中面=旧语料存量态，非链路缺口 |

### arousal

| 列 | 内容 |
|---|---|
| 设计摘录 | :223「REAL（以 schema 为准），agent；F4、遗忘；唤醒度」；:164 徽章 ·强烈（arousal≥0.7） |
| 代码锚 | 评分=emotionSalienceOf（recall-signals.ts:192 同参数面）；徽章渲染=formatMemoryLine（auto-recall.ts:2116 五徽章单一源）；分层池 soul 源扩 arousal（:164 三构造点透传成对补齐） |
| 真数据 | 10-02 探针未单列 arousal 分位数分布；活体注入徽章链全渲染（10-02 /v3/recall 五徽章链在场） |
| 判定 | ✅ 获取/评分/注入/展示链路在场（代码+活体双证）；📝 DB 分位数探针（≥0.7 占比）续批补 |
| 差异 | 无行为差异；真数据面分位数待补=取证粒度项非缺陷 |

### certainty

| 列 | 内容 |
|---|---|
| 设计摘录 | :220「TEXT observed/inferred，agent 认识论；渲染"实见/推断"、演化门②」 |
| 代码锚 | 获取=l1-extractor.ts（certainty 解析，与 normalizeSensitivity :22 同文件同层）；注入徽章=soul[实见 · 验证×N]；演化门②=certainty 参与演化判定 |
| 真数据 | 活体注入块徽章「soul[实见 · 验证×14]」在场（2026-10-04 会话注入实证）；10-02 探针 certainty 无异常登记 |
| 判定 | ✅ 四链在场（获取解析/演化门/注入徽章/展示）；📝 DB observed vs inferred 占比探针续批补 |
| 差异 | 无行为差异 |

## 五、续批登记

- ~~批 2：significance/sensitivity/source~~ → **批 2 判定完成（2026-10-04，见 §六）**
- 批 3-4：task_id（四链完整已证 10-02）/coreRefs/personRefs/identityRefs/recallCount/evolution/valid_start/state/pinned/created_by
- 批 5-7：锚属性+徽章链（node_type 56 号收口后仅需复核 character 池启用态 anchor-growth.ts:71/85）
- 每批完成=本文件判定表追加+台账双写；全部批次完成=63 号 DONE。

## 六、批 2 判定表（significance / sensitivity / source，2026-10-04）

### significance

| 列 | 内容 |
|---|---|
| 设计摘录 | :224「REAL，agent（重要性判断）；召回排序、遗忘保留、F13 反思触发；[0,1]」 |
| 代码锚 | 获取=prompt 硬约束六字段（l1-extraction.ts:99/101「缺一不可」）+l1-extractor.ts:331/:751 解析回填+l1-writer.ts:324 缺省 0.5；评分=R2 significanceSignalOf（recall-signals.ts:147，sigWeight 0.03）+RV2-2 组合精排四因子 0.1（memory-search.ts:601 DEFAULT_COMPOSITE_WEIGHTS）+遗忘 scorer（scorer.ts:56-69，A2 回归=顶层真实落库形状参与打分）+F13 反思累计阈值 R_REF=150（reflection.ts:17/:135）+V2-3 分析型放宽 significance top-5（auto-recall.ts:465-485，sqlite.ts:3307-3319 significance DESC）+高显著采样 ≥0.8（core-values-discover.ts:172）；注入=徽章「重要度 X.XX」（auto-recall.ts:2149，null 不标注宁缺毋滥）；展示=v2-router.ts:1252/:1768 出参+atomic-query-fields.ts:49 |
| 真数据 | 生产库 1170 行：null=460（集中 source 空旧语料，与 valence null 455 同分布）、≥0.8=264、avg=0.725、缺省 0.5=22；活体[48] 旧语料行无徽章=条件渲染设计内（新语料 100% 有值） |
| 判定 | ✅ 获取/评分使用/注入/展示四链在场且活跃（五处消费=R2/RV2-2/遗忘/F13/V2-3+采样） |
| 差异 | 📝 null 面=旧语料存量态不回填（与 09-30 P2 valence 同判=归档设计内） |

### sensitivity

| 列 | 内容 |
|---|---|
| 设计摘录 | :245「D-3 已实施（2026-09-22 收口）：召回门控/遗忘优先（R11 缺省 0/遗忘 bias 缺省 0）；枚举门单一源 normalizeSensitivity（undefined/非法一律 none）；三层体现=注入徽章/出参/属性表」 |
| 代码锚 | 获取=normalizeSensitivity（l1-extractor.ts:22，F-T1-1 修复）+gated prompt SENSITIVITY_BLOCK（l1-extraction.ts:406/:416，extractionEnabled yaml 缺省 false config.ts:1395）+l1-writer.ts:316 缺省 "none"+sqlite.ts:784 第 9 列 TEXT；评分=R11 sensitivityMultiplierOf（recall-signals.ts:171）+遗忘 sensitivityBias（scorer.ts:149-151）；注入=徽章「敏感:健康」（auto-recall.ts:2152-2153，none/缺失不标注）+F-R12 透传修复（:1683-1686/:2304-2306）；展示=atomic-query-fields.ts:61/:109 出参+UI 属性表（D-3 收口在案） |
| 真数据 | 生产库 1170 行 **全 none**=三个缺省门全关（extractionEnabled=false / sensitivityPenalty=0 / sensitivityBias=0，config-first gated 设计内）；测试 D-3a/b/c（sensitivity-d3.test.ts:13-84）全绿 |
| 判定 | ✅ 四链在场（schema 列/枚举门/降权+遗忘偏置/徽章+出参），实现完整且受测试锚定 |
| 差异 | 📝 生产态=全关静默，属 gated 待拍板项（开启=行为变更，须 A/B ≥10 组）——非链路缺口 |

### source

| 列 | 内容 |
|---|---|
| 设计摘录 | :221「TEXT，agent 系统；审计；extraction/consolidation/evolution/auto-growth」 |
| 代码锚 | 获取=L1 提取路写 "extraction"（l1-writer 落库，探针 706 行实证）+演化合并写 "evolution"（evolution-worker.ts:284 `source: "evolution"`，测试 :177 断言）；消费=v2-router.ts 出参+atomic-query-fields+审计探针（10-02 四链探针/B 批取证均按 source 分面统计） |
| 真数据 | extraction=706（新语料 +7 全 extraction）/空串=464（旧语料）/evolution=0 行（生产无演化合并发生）、consolidation/auto-growth=0 行 |
| 判定 | ✅ 获取（双写路）/消费（出参审计）链在场 |
| 差异 | 📝 设计四枚举 vs 代码两枚举在用：consolidation 无独立写路（合并由 evolution-worker 承担，语义等价）、auto-growth 不产 L1 行（锚层维护）——枚举收窄为设计演进登记，非缺陷 |

## 七、批 3 判定表（task_id / coreRefs / personRefs / identityRefs，2026-10-04）

### task_id

| 列 | 内容 |
|---|---|
| 设计摘录 | :229「TEXT，agent；任务关联」 |
| 代码锚 | 获取=l1-extractor 解析透传+l1-writer 落库+sqlite/tcvdb 列持久化；评分/注入/展示=10-02 四链取证已判 ✅ 完整（task_id 四链完整在案，判定表 v1 前基座）；注入行内上下文关联+出参透传（atomic-query-fields） |
| 真数据 | 生产库 1170 行 **task_id 非空=566（48.4%）**——任务关联记忆约半数活跃 |
| 判定 | ✅ 四链在场（10-02 取证+本轮计数双证） |
| 差异 | 无（约半数行为会话无关记忆，task_id 空=语义内缺省非缺陷） |

### coreRefs

| 列 | 内容 |
|---|---|
| 设计摘录 | :239「锚→记忆证据链（双向反查）；backfill 回填，已验证」 |
| 代码锚 | 获取=A8 提取路（l1-extraction.ts:104 候选清单内选+宁缺毋滥、l1-extractor.ts:622/:738 parseCoreRefs 防幻觉过滤）+C1 dedup 路（l1-dedup.ts:192/:424 同款过滤）+GROW-EVO 采纳回填（anchor-growth.ts:518，backfillMemoryRef 单源 sqlite.ts:2784）；评分使用=R5 反查补池（sqlite.ts:3114 searchL1ByCoreRefs、auto-recall.ts:1862）+coreRefBoost（memory-search.ts:229 +0.05）+RV2-2 coreRef 因子 0.05（memory-search.ts:601）+F14 遗忘保护（scorer.ts:53）+salienceBoostWithRefs（appraisal.ts:72-106 coreRefs 优先/子串兜底）+anchorEvidenceValences（sqlite.ts:2485 品格张力 T2 证据源）；注入=R-A2 补池 [value:锚] 通道标注（auto-recall.ts:1862-1873）+touched_core_refs 尾注（memory-search.ts:1468）；展示=atomic-query-fields.ts:50 metadata 面板透传+ValueAnchorsPanel 反查 |
| 真数据 | 生产库 **806 行（68.9%）coreRefs 非空**（样本 ['插件','测试']/['管线','anima']）；本轮注入/召回链五消费全部依赖此键族 |
| 判定 | ✅ 获取（三写路）/评分使用（五消费）/注入/展示四链在场且活跃——全库最高覆盖标注属性 |
| 差异 | 无 |

### personRefs

| 列 | 内容 |
|---|---|
| 设计摘录 | :240「P2 新增：人物锚→记忆证据链；与 coreRefs 同款回填」 |
| 代码锚 | 获取=GROW 采纳 F12 证据链回填（anchor-growth.ts:592-597 personEv 同款 label/alias 包含口径）；评分使用=P0-F7 反查键族扩 personRefs（store.personrefs-reverse.test.ts RED→GREEN 修复旧死通道；sqlite.ts:3131/:3166-3170 searchL1ByCoreRefs 双键族）+F14 遗忘保护（scorer.ts:53 coreRefs/personRefs 同查）；注入=R5 补池人物通道；展示=反查链出参 |
| 真数据 | 生产库 **193 行 personRefs 非空**（样本 ['用户']）；F12 回填+P0-F7 反查测试双锚定（anchor-growth.person.test.ts:74） |
| 判定 | ✅ 四链在场（回填/反查/保护/通道） |
| 差异 | 无 |

### identityRefs

| 列 | 内容 |
|---|---|
| 设计摘录 | :241「P2 新增：身份事实→记忆证据链（GROW-MAINT 重算+遗忘保护 F14）；20 字切片弱口径，仅警告不自动退场」+五徽章「核心事实」（identityRefs 非空） |
| 代码锚 | 获取=identity-discovery.ts:298-315 回填（identityFactSlice :553-562 措辞断链单源修复+support 精确回填 identity-support-pointer.test）；评分使用=F14 遗忘保护 F-EV13-1 模糊匹配（scorer.ts:57-59）+GROW-MAINT 重验证+四消费面统一（identity-fact-match.test.ts:13）；注入=徽章「核心事实」（auto-recall.ts:2161）；展示=V6-1a 属性透传（attr-signal-badge.test.ts:102-107 三路 formatable 携带） |
| 真数据 | 生产库 **88 行 identityRefs 非空**（20 字切片弱口径实证：'我的Danbooru用户名是chenxi'）；**活体徽章在场=本轮注入 relevant-memories [5] 行「·soul[实见 · 验证×17 · 核心事实]」**；R-C 红线测试锚定（character-tension 蒸馏零 identityRefs 回填 :194-202） |
| 判定 | ✅ 四链在场（回填/保护/徽章/透传）+R-C 反耦合红线受测试锚定 |
| 差异 | 无（切片弱口径=设计明文，非缺陷） |

---

## 八、批 4 判定表（recallCount / evolution / valid_start / state / pinned / created_by）

> 2026-10-05 v17 轮取证（HEAD=cebd3b0 基线、生产库 vectors.db 只读探针 1170 行、门禁 899/899·tsc 222·panel 147/147）。state/pinned/created_by 名册列于批 4，实际为 §4.2 锚层属性（:261-262），按锚层原文判定。

### recallCount（metadata.recall_count / last_recalled_at）

| 列 | 内容 |
|---|---|
| 设计摘录 | :244「recall_count/last_recalled_at｜agent｜F3 强化、R1 时近性｜P0-T4 原子自增」（metadata_json 子结构表）+F3 R8 使用度强化 |
| 代码锚 | 获取=P0-T4 原子自增 bumpRecallCount（sqlite.ts:3655-3707，json_set 单语句原子 :3698/:3707，不读回）+tcvdb.ts:1236-1277 同语义；调用点=memory-search.ts:142-159（top-3 observed，store 无 bumpRecallCount 回退 read-then-write 恒 1 warn :153）；评分使用=reinforcementSignalOf log10(1+count)·weight（recall-signals.ts:181-184，R8 权重缺省 0.03 :56）+recallCountBoost min(count,5)·0.02 封顶 10%（scorer.ts:89-94）+探索位/组合分 recallCountOf（auto-recall.ts:1649-1651）+探索位 median（memory-search.ts:700-730）；注入=·验证×N 徽章（auto-recall.ts:2160，≥3）；展示=atomic-query-fields.ts:50 面板透传+v2-schemas.ts:157 |
| 真数据 | 生产库 **547/1170 行（46.8%）recall_count>0、MAX=106**，last_recalled_at 547 行非空（与 recall_count>0 同集=原子同写）；**活体实证：本轮注入 relevant-memories「·soul[…· 验证×24]」徽章在场** |
| 判定 | ✅ 四链在场且活跃（原子自增/双评分消费/徽章/面板透传） |
| 差异 | 无（测试锚定：recall-count-bump.test.ts、recall-signals.test.ts:108-114） |

### evolution（metadata.evolution{from,reason}）

| 列 | 内容 |
|---|---|
| 设计摘录 | :242「evolution{from,reason}｜agent｜演化审计」+F7 五条件门（:285）+:164 ·已演化徽章「当前休眠」 |
| 代码锚 | 获取=evolution-worker.ts:277 `evolution:{from:[older.id,newer.id],reason}` 写入 merged metadata（与 :276 created_by='evolution' 同批，审计三件套）+F7 门+evolved_from×2 审计边（:296-297）+双失效（:298-299）；评分使用=无排序消费（审计属性，设计内）；注入=·已演化徽章（auto-recall.ts:2162，evolution!=null）；展示=出参 metadata 透传（v2-router.ts:1767 同批） |
| 真数据 | 生产库 **0 行 evolution 非空**——F7 五条件在生产 1170 行从未同时满足（门严）=设计「门严不触发良性」（S4）预期，徽章休眠与 :164 注记逐字一致 |
| 判定 | ✅ 四链在场（写路/徽章/透传+测试锚定 evolution-worker.test.ts:177-181、attr-signal-badge.test.ts:104-116）；📝 0 行=门严休眠设计内非缺口 |
| 差异 | 无 |

### valid_start

| 列 | 内容 |
|---|---|
| 设计摘录 | :218「TEXT｜agent｜事实｜F18 检索过滤｜有效窗开」+GROW-EVO P2 §2.2（durative 开关缺省 false=提取侧不写）+:164 ·自 date 起（日期精度） |
| 代码锚 | 获取=l1-extractor.ts:322-325（`durativeEnabled===true && mem.durative===true → mem.valid_start‖occurred_at`）+prompt l1-extraction.ts:103（durative 判定指令，判不了给 false 宁缺毋滥）；落库=l1-writer.ts:296+sqlite.ts:776（迁移列）/:931-949 upsert/:2009-2014+soul-columns.ts:5（FTS UNINDEXED）；演化合并 bi-temporal 沿用旧值起点（evolution-worker.ts:281）+consolidation 组内最早（summarizer.ts:13/:84）；评分使用=filterByValidity（memory-search.ts:1487-1491）+时近性 vs=valid_start 优先（recall-signals.ts:120）；注入=·自 date 起徽章（auto-recall.ts:2163，slice(0,10)）；展示=atomic-query-fields.ts:43/:99+v2-router.ts:1246/:1767 |
| 真数据 | 生产库 **189/1170（16.2%）非空**（durative 宁缺毋滥，与事件型记忆为主一致）；活体本轮召回样本未命中 valid_start 行（稀疏），单测在证（attr-signal-badge.test.ts:54-55、:102-128 三路透传） |
| 判定 | ✅ 四链在场（durative 门提取/bi-temporal 消费/徽章/出参透传） |
| 差异 | 无（F18 解析失败保留=filter-invalidated.ts 设计内） |

### state（锚层 §4.2）

| 列 | 内容 |
|---|---|
| 设计摘录 | :262「pinned/state｜agent（维护决策）｜挤出豁免/全态去重/守卫豁免｜active/retired/vetoed」 |
| 代码锚 | 写=upsertValue INSERT state='active'+DO UPDATE 复活语义（sqlite.ts:2398，:2272 注释沿用）+setValueState（values-state.test.ts:88-92）+GROW-MAINT retire（anchor-growth.ts:341-349，仅 auto-growth 射程）+QUOTA retire（:428）；评分使用=F6 挤出 displaceable=active 非 pinned+F15 全态去重/守卫+listValues stateFilter（sqlite.ts:2447，includeRetired 可选）；注入=soul-assembler 渲染源仅 active 集（:187-245 上游 listValues 过滤，retired/vetoed 不入灵魂）；展示=出参带 state+Panel（values-state 门禁在案） |
| 真数据 | 生产库 **active 85（theme 76+person 9）/retired 45（theme 34+person 2+character 9）/vetoed 0**；character 池 9 行全 retired=§10-04 拍板②（maxTotal 8→6）GROW-MAINT 清退产物——state 链行为变更活体实证 |
| 判定 | ✅ 四链在场（三分写路/豁免与过滤消费/active 渲染门/出参）；📝 vetoed 0 行=veto 端点在位未用（登记观察） |
| 差异 | 无 |

### pinned（锚层 §4.2）

| 列 | 内容 |
|---|---|
| 设计摘录 | :262 同行（pinned=挤出豁免/守卫豁免）；F6 displaceable=非 pinned |
| 代码锚 | 写=POST /core-memory/values/pin 路由（v2-router.ts:205/:508）+handleCoreMemoryValuesPin（:2062-2081，布尔校验/缺 value_id 400）→setValuePinned（sqlite.ts:2708-2713，state IN ('active','retired') 可 pin）+tcvdb.ts:1814+types.ts:745；评分使用=anchor-growth.ts:341/:349 GROW-MAINT pinned 豁免+:428 QUOTA pinnedNow+F6 挤出排除；注入=无（设计内不入注入）；展示=pin 端点回显+出参 pinned 列 |
| 真数据 | 生产库 **130 行 pinned 全=0**——端点在位、生产从未 pin 过 |
| 判定 | ✅ 四链在场（路由/豁免双消费/出参）；📝 零使用=能力在数据未用，登记观察非缺口 |
| 差异 | 无 |

### created_by（锚层 §4.2）

| 列 | 内容 |
|---|---|
| 设计摘录 | :261「created_by｜agent｜维护豁免判定｜verify/auto-growth」 |
| 代码锚 | 写=upsertValue INSERT+DO UPDATE 沿用（sqlite.ts:2398，:2272「created_by 保留源头可追溯性」）+seedValues 沿用 anchorSeeds.created_by（config.ts:286）+GROW 采纳='auto-growth'（anchor-growth.ts:17/:385）+Panel 采纳='panel-adopt'（v2-router.ts:1869/:1880，O13/V12-CV）+L1 面 metadata.created_by='evolution'（evolution-worker.ts:276，spec §4.3 审计三件套）；评分使用=GROW-MAINT/QUOTA 射程=created_by==='auto-growth'（anchor-growth.ts:341/:349/:428，manual/seed 永不自动动）；注入=无；展示=createdByBadge（0c40f3c GAP-1 修复，chip _va-origin--by+i18n memory.anchors.createdBy zh/en，空/空白/undefined 三态返 null） |
| 真数据 | 生产库 **auto-growth 127/panel-adopt 2（'取证先行''根因优先'=V12-CV 采纳产物）/agent 1（value_id='test-desc-anchor'，租户 team-ev19 测试种子残留，label '?????'=ASCII 毁中文实锤产物）**；verify 0 行 |
| 判定 | ⚠️ 四链在场但**枚举漂移**：真数据三值 {auto-growth,panel-adopt,agent} vs 设计 {verify,auto-growth}——panel-adopt=V12-CV 合法第三值（设计 :261 未更新=文档勘误项）；verify 生产 0 行；'agent' 1 行=测试种子残留归 v9 gated「测试租户种子清理 11 桶 244 行」待拍板，非生产缺陷 |
| 差异 | 文档-代码枚举脱节（勘误：:261 枚举补 panel-adopt）；测试种子残留 gated 在案 |

---

## 九、批 5 判定表（node_type / attrs_json / weight / label）

### node_type

| 列 | 内容 |
|---|---|
| 设计摘录 | :125/:256「TEXT 缺省'theme'：'theme'=主题锚（现状逐位）；'person'=人物锚（P2）」——两值枚举 |
| 代码锚 | 获取=anchor-growth.ts:107 `node_type?: "theme"\|"person"\|"character"`（**三池**，M2 S-CHAR-2 扩展）+upsertValue INSERT 含 node_type（sqlite.ts:2398）+listValues/listValuesAnyState 返回（:2426-2448/:2522-2527）+tcvdb.ts:1776-1801；56 号 3d91234 联合类型统一 9 处+growthValueId nodeType 盐（防 person/theme 同 label 覆盖，:134 设计条款）；评分使用=F11/F12 人物口径+F15 maxTotal 按 node_type 分池（anchor-growth.ts 分池守卫）+QUOTA 分池；注入=渲染分行（soul-assembler：价值锚=theme :187-220、重要的人=person :222-245、品格=character :246-264 过滤 v.node_type==="character"）；展示=ValueAnchorsPanel 类型徽标（U2 P2） |
| 真数据 | 生产库 **theme 110（active 76+retired 34）/person 11（active 9+retired 2）/character 9（全 retired）**；三池真数据齐备 |
| 判定 | ✅ 四链在场（三池写路/分池消费/三分行渲染/类型徽标）；⚠️ 设计 :125/:256 两值 vs 代码三值——character=M2 引入的设计演进（soul-evolution DS-SOUL-EVOLUTION-001 为权威定义源），09-17 :256 未同步=文档勘误项 |
| 差异 | 枚举两值→三值（M2 设计演进未回写 09-17，登记勘误） |

### attrs_json

| 列 | 内容 |
|---|---|
| 设计摘录 | :126/:257「TEXT 缺省'{}'：人物锚属性 {role, aliases[]}（role=家人/同事/朋友/其他；aliases=昵称数组并入证据重算）；关系情感方向不重复存——由 valence 列承载」 |
| 代码锚 | 获取=GROW 提案 role/aliases 入 attrs（anchor-growth person 池，F12）+description 写路（pending-adopt-merge.ts:45 sanitizeDescription 60 字窗口句边界+v2-router.ts:1880 adopt 写 {description}+reweight 保留 growth-reweight-preserves-description.test.ts）；评分使用=aliases 并入证据重算（F9+F11 personEv=content 包含 label **或任一 alias**）+去重别名维度（F19 全态去重另含 alias 命中）；注入=attrsOf 统一解析（soul-assembler.ts:194/:229）——role 段 :231+desc 段 :236-241；展示=Panel 人物行编辑含 role/aliases（U2）+反查计数并入 aliases |
| 真数据 | 生产库 active person role 全非空（'同事'×2/'其他'×7）+aliases 空数组合法（[]）+非空别名（['开发者']['导师张三','导师']['用户','cxin21']['老何']）；**theme 行 attrs 含 {description}（V6-1a③ 首要锚 desc）** |
| 判定 | ✅ 四链在场（写/重算与去重/注入解析/Panel 编辑）；⚠️ 实际键族 {role,aliases,description} vs 设计 {role,aliases}——description=R2b/R2c 引入（V6-1e :167 权威定义），:126/:257 未同步=文档勘误项；【v17 补正】character 采纳通道 attrs 另含 {source,facts}（anchor-growth.ts:652，F1/F2 白名单五字段 role/aliases/description/source/facts，70bb050），生产 character 9 行全 retired 无 active 样本 |
| 差异 | 键族扩展未回写设计（登记勘误；方向由 valence 承载的红线保持无双源） |

### weight

| 列 | 内容 |
|---|---|
| 设计摘录 | :258「REAL agent（信念强度）｜F5/F6/F12、渲染排序｜D6 绝对证据+饱和」+F5（:283）w=clamp((3+5·min(e,E_REF)/E_REF)/10, 0.3, 0.8)，e≤0→0.3，E_REF=50+V6-1b 锚行 weight 显示 label(方向·w0.9)（:165，weight≤0 不展示） |
| 代码锚 | 获取=F5 计算于 GROW 采纳/reweight（anchor-growth.ts:385 沿用+新锚 F5）+|Δw|≥0.05 reweight 门（F15）；评分使用=F6 挤出强度比较+F15 QUOTA 分池强度升序 retire+渲染取舍 :205-207（weight>0 才显示）；注入=soul-assembler wSeg `·w{weightLabel}`（:205-208，V6-1b 单一源）；展示=V6-1a② 锚行 weight 显示（活体「实证(趋近·w0.79)」） |
| 真数据 | 生产库 **theme 0.33-0.8 avg0.484/person 0.33-0.8 avg0.509/character 0.44-0.78**——值域与 clamp(0.3,0.8) 吻合（min 0.33>0.3 无触底、max 0.8=上限触顶）；活体 w0.79/w0.8/w0.5 渲染实证 |
| 判定 | ✅ 四链在场（F5 计算/挤出与 QUOTA 消费/w 徽章渲染/Panel 展示） |
| 差异 | 无 |

### label

| 列 | 内容 |
|---|---|
| 设计摘录 | :255「agent｜用户价值主题/用户生活中人物｜渲染、证据重算、反查」+F9 recountEvidence（每 token 均包含，纯 CJK 单 token 整串） |
| 代码锚 | 获取=GROW 提案 label+growthValueId(label,nodeType) 盐化主键（56 号）+F9 证据重算口径；评分使用=recountEvidence（F9）+F11 personEv（label 或任一 alias）+F19 去重键 (node_type,label) 复合；注入=escapeXmlTags(v.label) 渲染（soul-assembler.ts:208/:242）+反查 searchL1ByCoreRefs（sqlite.ts:3114，批 3 已证）；展示=Panel label 列+行内编辑（label 三态编辑 U2） |
| 真数据 | 生产库 130 label 全非空（'何晨''取证先行''根因优先''RED' 等）；活体注入「何晨(同事·趋近)」「实证(趋近·w0.79)」渲染实证 |
| 判定 | ✅ 四链在场 |
| 差异 | 无 |

---

## 十、批 6 判定表（valenceDir / slot / origin / description；created_by·state 已见批 4）

### valenceDir

| 列 | 内容 |
|---|---|
| 设计摘录 | F17（:296）「valenceDir 渲染映射：1→趋近、-1→审慎、0→中性、NULL→无标注」+：259 valence 列=方针方向（聚合自证据情感）+:148 重要的人行方向内联标注 |
| 代码锚 | 获取=valence 列写路（F12 均值符号化 ≥+0.2→1/≤-0.2→-1/否则 0，anchor-growth person 池+theme derive）；评分使用=无排序消费（渲染属性）；注入=valenceDir(v.valence)（soul-assembler.ts:204）+personDir（:230）+拼装 `${dir}${wSeg}`（:205-208）+NULL→无 dir 段（dir 假值不拼 :206）；展示=V6-1a② 锚行方向·weight（活体实证） |
| 真数据 | 生产库 **theme null·1/−1·21/0·39/1·49+person 0·1/1·10+character −1·2/1·7**——四态真数据全存在；活体「实证(趋近·w0.79)」「RED(审慎·w0.8)」「何晨(同事·趋近)」渲染实证；null 1 行=IS NULL 守卫先例（感受段排除 :200） |
| 判定 | ✅ 四链在场（F12 写/渲染映射/活体三态实证）；📝 NULL 无标注分支有真数据 1 行 |
| 差异 | 无 |

### slot

| 列 | 内容 |
|---|---|
| 设计摘录 | :268-269「slot=identity（我心中的他，用户主语）/slot=self_identity（我是谁，agent 第一人称 P1）」+：115「allowedSlots 缺省 [identity,core_value,strict_rule]（config.ts:872 实证），P1 须扩展+self_identity」 |
| 代码锚 | 获取=guard.ts slot 白名单写入口（F2：allowedSlots 白名单+2000 字硬上限+writeEnabled）+upsertCore 路由（panel-adopt :1869）；评分使用=无；注入=soul-assembler dual 渲染（:165-185：labelFor self→"我是谁"/identity→"我心中的他" :171-172+渲染序 rank self→identity :175-179+F17 预算 budgetFor :166-170+truncateByLines :183）；展示=U1 身份区只读展示（P1 已实施）+出参 readCore |
| 真数据 | 生产库 core_memory **core_value 1 行(v1)/identity 3 行(v50)/self_identity 3 行(v64)/strict_rule 1 行(v13)**——四槽全活、version 演化留痕；活体注入「（我是谁）- [self_identity]…」「（我心中的他）- [identity]…」前缀渲染实证 |
| 判定 | ✅ 四链在场（白名单写/双槽渲染序+预算/活体前缀/U1 展示） |
| 差异 | 无 |

### origin

| 列 | 内容 |
|---|---|
| 设计摘录 | :260「origin｜agent｜QUOTA 豁免判定｜seed/manual/auto」 |
| 代码锚 | 获取=GROW 采纳='auto'（anchor-growth.ts:17）+seedValues 灌种='seed'（config.ts:286 anchorSeeds 缺省空=不自动灌）+Panel 采纳='manual'（v2-router.ts:1880）；评分使用=anchor-growth.ts:349 `a.origin!=='auto'` GROW-MAINT 豁免+QUOTA 守卫同射程（manual/seed 永不自动动）；注入=无直接消费；展示=出参 origin+Panel |
| 真数据 | 生产库 **auto 127/manual 3/seed 0**——seed 0 行=生产 yaml anchorSeeds 未配（缺省空设计内）；manual 3=Panel 采纳产物 |
| 判定 | ✅ 四链在场（三值写/豁免消费/出参）；📝 seed 0 行=缺省空设计内非缺口 |
| 差异 | 无 |

### description（attrs_json.description）

| 列 | 内容 |
|---|---|
| 设计摘录 | V6-1e（:167）「人物锚行同构升级 label(role·方向)：description（当前 person 锚无 description=段休眠，数据面回填另行拍板）」+R1 渲染端 desc 门+R2 episode 门+R2b person 行三步门（v17 轮补链） |
| 代码锚 | 获取=pending-adopt-merge.ts:45 sanitizeDescription（60 字窗口句边界，存储端）+v2-router.ts:1880 adopt 写 {description}+GROW-MAINT reweight 保留（growth-reweight-preserves-description.test.ts）；评分使用=无；注入=soul-assembler anchorDescOf 句边界清洗（:193-199）+R2 episode 门整锚跳过（:216）+person 行门降级 desc 段不抹人（:236-241，R2b）+UR-15 勘误注记（:227-228「生产 active person 锚 2/2 有 description（cdcfe5c 终判），描述段=活跃路径」）；展示=Panel desc 列+G-ANCHORDESC-WRITE gated（存量回填待拍板） |
| 真数据 | 生产库 active **person 2/9 有 desc**（何晨/cxin21 行）+theme 7/76（活体「何晨(同事·趋近)：从要求逐轮记录召回与灵魂注入日志…」渲染实证）；7 行 person 无 desc=ev19/ev21 测试租户锚+新自动锚（G-ANCHORDESC-WRITE gated 在案） |
| 判定 | ✅ 四链在场（sanitize 写/desc 门+episode 门注入/活体渲染/Panel）；📝 desc 覆盖 2/9——UR-15 时点「2/2」→现「2/9」因 person active 扩至 9（10-04 后新增），无 desc 7 行按 gated 策略宁缺毋滥 |
| 差异 | 设计 :167「段休眠」表述已过时（现活跃路径，UR-15 勘误已注记于代码注释）；存量回填 gated 待拍板不变 |

---

## 十一、批 7 判定表（徽章链六件）

| 徽章 | 设计摘录 | 代码锚 | 真数据 | 判定 | 差异 |
|---|---|---|---|---|---|
| ·强烈 | :164 arousal≥0.7 | auto-recall.ts:2159（m.arousal>=0.7）；三构造点透传（attr-signal-badge.test.ts:35-40） | 批 1 已证 arousal 真数据（455 null 集中旧语料）；活体样本未触发（arousal 缺省宁缺毋滥） | ✅ | 无 |
| ·验证×N | :164 recallCount≥3 | auto-recall.ts:2160（`验证×${m.recallCount}`） | **活体实证「·soul[…验证×24]」「验证×17」双行在场**；真数据 547 行>0 | ✅ | 无 |
| ·核心事实 | :164 identityRefs 非空 | auto-recall.ts:2161 | 活体实证「实见 · 验证×17 · 核心事实」；真数据 88 行 | ✅ | 无 |
| ·已演化 | :164「evolution 存在，当前休眠」 | auto-recall.ts:2162 | 真数据 0 行=门严休眠（与 :164 注记逐字一致） | ✅📝 | 休眠=设计内 |
| ·自 date 起 | :164 valid_start 日期精度 | auto-recall.ts:2163（slice(0,10)） | 真数据 189 行基数；活体样本未命中（稀疏），单测 :54-55 在证 | ✅📝 | 稀疏非缺口 |
| created_by 徽章 | UR-18/GAP-1（ValueAnchorsPanel created_by 展示链缺失→TDD 修复令） | createdByBadge 纯函数（0c40f3c；空/空白/undefined 三态返 null；chip _va-origin--by 复用 _va-origin 基座；i18n memory.anchors.createdBy zh/en） | 门禁 web tsc 存量 2 不涉及本链；活体 DOM 补做=45 号 LIVE-DOM BLOCKED（环境） | ✅ | 活体 DOM 验证归 45 号环境项 |

### 批 4-7 收口结论

- **16 属性+6 徽章全量判定完毕：零 ❌（无断链属性）**；✅ 20 项、⚠️ 2 项（created_by 枚举漂移、node_type/attrs_json 设计枚举未随 M2/R2b 演进回写——均为文档勘误级，非代码缺口）、📝 8 项（休眠/稀疏/零使用/gated 类观察，全部设计内或有登记在案的拍板项）。
- 63 号 ANCHOR-PRECISION 四链判定表**全名册收口**：批 1-3（10 属性）+批 4-7（16 属性+6 徽章）=五列判定 32 项全过，无「提取不用/用不展示/展示难用」断链。
- 文档勘误待办（不阻收口，随三写登记）：①09-17 :261 created_by 枚举补 panel-adopt；②:125/:256 node_type 补 character（引 soul-evolution 为权威）；③:126/:257 attrs_json 键族补 description（引 V6-1e）。
