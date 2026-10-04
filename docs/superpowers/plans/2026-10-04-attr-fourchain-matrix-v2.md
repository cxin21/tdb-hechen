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
