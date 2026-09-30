# 记忆事实聚合（F-CLUSTER）· 设计定案与实施记录

> 拍板：2026-09-26 何晨委托自主拍板（「你自己先检查分析是不是最优设计……你自己拍板」）。
> 判据锚：提取明确简洁 · 关联有依据准确全面有相关性评分 · 召回层级正确信息完整 · Panel 美观易用。

## 1. 设计演化（v1→C案→v2→实施修正，三轮对抗性自审）
1. v1（metadata 轻量簇）：clusterId 内嵌 metadata_json+三档评分 1.0/0.8/0.5+六步实施序。
2. C案（用户采纳钢人论证）：存储按既有 memory-graph l1_links 图形态一步到位，行为渐进分步 A/B。
3. v2 定稿：定位修正为「memory-graph 写入时建边+consolidation 持续态+召回簇感知折叠」三机制接线。
4. **实施期再修正（取证推翻假设，2026-09-26）**：l1_links 五类边已在产（similar 1232/derived_from 1094/evolve 35/conflict 5），v2 设计第 1/2 项属重复建设→撤销；part_of 边 0 条+consolidation 写 evidence_ids 为死路径（-S 考古无改名）→真数据源=work_fact.metadata_json.**evidence_record_ids**（366/369=99.2%，991 引用，48.3% 源在场）；逐字簇 similar 边零互通（HOP1 0/4）→折叠走内容驱动，不依赖边。

## 2. 已实施（v1 2cba420 / v2 bb6dc13）
- v1 同源折叠：stripMemoryLineMeta 内容口径逐字相同→保留首现行+「·同源×n」（多缀循环剥离到不动点；单遍残留 soul 段缺陷经 RED-1 归因修正）。
- v2 持续态优先：foldByDurative——批内 work_fact 行吸收其 evidenceIds 指向且同批在场的源行+「·源×n」（n=合并总数含自身）；宁漏勿错杀（源不在批/meta 缺失/自引用不折）。
- 接线：RecallConfig.foldClusterEnabled（**缺省关**）；FormatableMemory.recordId/evidenceIds 透传；折叠点=vector 搜索路返回前（budget 之前）；fts 降级路不接线；auto-recall.ts:736 恢复 foldNearDuplicates(memoryLines)。
- 真数据对照（10 组函数级，2026-09-26）：9 组折叠、注入行 23→9（-60.9%）、保留行全部为持续态。
- 门禁：vitest 856/856 · typecheck 222 持平 · 密扫 0。

## 3. 撤销项（对抗性自审登记）
- summary 新边类型（part_of+evidence_record_ids 已承载该语义）。
- 0.5 弱关联边（subject 覆盖 77.5% 有洞+价值存疑）。
- memory-line-meta 物理单一源抽取（循环剥离会漂移 A2 单遍校准口径；副本一致性由 RED-3 测试锁定）。

## 4. 转产前置（拍板窗，未做勿抢跑）
1. 重启 core 加载 v1/v2 代码（现行 MainPID 527236 为旧代码，生产零行为变更）。
2. golden P@5 回归：复用 recall-anchor.mjs OFF/ON 双跑，验收线 0.897（新基线 0.917−0.02）。
3. foldClusterEnabled 置 on（config-first，yaml 显式）+重启生效+活体 /v3/recall 探针复核折叠注记在场。

## 5. 后续队列
- v3 逐字簇边回填（datafix-sop：备份先行+拍板执行窗）——使图查询/Panel 簇视图有边可依。
- Panel 簇视图（主卡+「n 源」展开抽屉，二期设计呈报；组件路径先精确定位）。
- 观察项：注记对 :736 既有 Jaccard 折叠的 bigram 影响（A2 分离度 9 倍余量下低风险，golden 覆盖）。


## 6. 实施修正与转产实录（2026-09-30，0b7ef5a + f3dd273）

> 本节修正/取代 §2 接线段声明与 §1/§4 基线；三层断点逐层现场取证（五点诊断探针走线 + 运行时 cfg.recall 键集打印），非推测定责。

### 6.1 三层断点修复（本节取代 §2「fts 降级路不接线」）
- **接线层**：折叠此前仅接 TCVDB nativeHybridSearch 分支，SQLite 主形态走 searchHybrid fallback 无折叠（结构性不可达，on=合闸无电线的开关）。修复=SearchResult 增 metas + fallback 同款三元接 foldClusterAware（auto-recall.ts:1261/:1279 双接线）。**「fts 降级路不接线」作废——现双路同接**。
- **数据层**：FTS keyword 通道基座 recordToFormatable（:2289-2317）不带 recordId/evidenceIds（vectorResultToFormatable :2363-64 有）→ FTS 行 metas 全 undefined → foldByDurative 引用图建不起来。修复=基座补两字段（空 evidence→undefined 语义对齐）。
- **配置层**：config.ts:100 类型声明自 09-26 存在，但 parseConfig 逐键手动装载遗漏 foldClusterEnabled → yaml true 装不进运行时（实锤 fcVal=undefined）。修复=bool(recallGroup, ...) ?? false（config.ts:1271）。

### 6.2 数据面漂移（§1 基线过期，以本节数字为准，2026-09-30 只读实测）
- work_fact 432/438=98.6% 带 evidence_record_ids（§1 的 366/369=99.2% 口径持平）；引用总数 1131（§1: 991）。
- **源在场率 48.3%→37.3%**（1131 引用中 422 目标在 l1）——持续态增速快于其源写入，折叠触发上限被此约束。
- **exact 同 content 组=0** → v1 foldSameSourceDuplicates 在真实库零原料零触发（§2 的 9/10 函数级对照为构造数据；动机样例「×5」已不存在）；保留无害，防未来。
- 语义差异登记：设计「work_fact 行吸收」vs 实现「带 evidenceIds 行吸收」（超集）——当前数据面 anytype_with_evidence=432=wf 全集，语义等价。

### 6.3 漏斗实测（2026-09-30，10 组真实查询，双网关 8422 on/8423 off 同种子）
- 两级漏斗：级1 批内引用对（pairs）=召回同批带源，5/10；级2 有料触发折叠，**pairs>0 的 5/5 全部触发**（pairs=1→src=1 线性），零「有料不折」缺陷。
- 注入块差异 5/10、5 行 ·源×2、off=65/on=64；无信息丢失（持续态行+计数可见）。批容量 4-5 行（maxResults=5）是级1 同批率 50% 的主要约束。
- 对照 §2「10 组函数级 9 组折叠 23→9」：口径差=函数级构造批（源必在场）vs 真实查询批（源同批率 50%），非实现回归。

### 6.4 转产状态（对照 §4 前置三项）
1. 重启 core 加载折叠代码：**已完成**（2026-09-30 MainPID 1886628，active，health=200）。
2. golden P@5 回归（验收线 0.897）：**未做——欠账**。前置已知阻塞：golden 桶语料漂移 + labels v2 过期（需先重标再重锚新基线），登记为独立任务；§5 观察项（Jaccard bigram 影响）同样待此验证。
3. foldClusterEnabled 置 on+活体：**已完成**（tdai-gateway.yaml memory.recall.foldClusterEnabled:true，备份 /tmp/tdai-gateway.yaml.pre-flip；读回 fold=True；活体 A/B 5/10 触发、·源×2 在场）。
   - 时序如实登记：③ 先于② 执行，依据=何晨 2026-09-29「继续执行」转产窗拍板 + 2026-09-30「修复，本会话完成」；② 欠账在册，golden 重锚完成后补回归。

### 6.5 golden 重锚 + Jaccard 观察项闭环（2026-09-30，「遗漏的全做」执行轮）
- **golden P@5 重锚（§4② 欠账清偿）**：labels v3（11 query/46 正例/零死 id/口径修正三处：rf_ 纳入+同语义簇整标+persona 不标+死 id 2c875ed7 剔除；备份 labels.jsonl.bak-v2）→ recall-anchor.mjs QUERIES 补第 11 条（硬编码集与 labels 一致性）→ 重跑 runs/2026-09-30T03-19-08.json：**corpus=48 labels=11、OFF determinism PASS、gate mean P@5=0.653 (pass) → 新基线 0.653、新验收线 0.633**（0.6183/0.5983 十 query 中间口径作废）。0.917/0.897 旧线正式由本节取代。
- **§5 观察项（注记对 :735 Jaccard 的 bigram 影响）闭环**：foldNearDuplicates stripMeta 不剥折叠注记（memory-line-meta:23 剥=两套口径）+单遍链缺陷经 A/B 矩阵（5 形态近似对，/tmp/jaccard-ab.mjs 留证）实锤：S3 残留 soul、S4 生产折叠行 soul+时间全残留（注记顶掉 $ 锚）、S5 短行伪相似误折（分组差异 1/5）、S1/S2 纯内容两口径逐位一致。修复走 TDD：export foldNearDuplicates + RED-11（零内容交+同注记：闭包 J=4/11≈0.364 误折 vs 剥后 0；首版构造 union 算错未跨阈经数学复核修正）/RED-12（真近似护栏）→ 步1 注记剥离 → 步2 单一源迁移（memory-line-meta:13 登记的 v2 计划执行）。**迁移后复跑分组差异 0/5**；门禁 vitest **875/875**（+2）、tsc 222 持平。§2「A2 行为逐位不变」红线经矩阵实证保全：纯内容行零变更，差异组全部为 A2-R1 同类元数据缺陷修正。

### 6.6 遗留取证定责（2026-09-30「遗漏的全做」轮，P2/P3 收口）
- **P2 源在场率 37.3%（设计基线 48.3%）判定=非缺陷，不改写链**：缺失引用 492 唯一目标中 488 在
  l1_archive（取证 SQL 实测）——归档主因 dedup-merge 1198 条（l1-writer.ts:355-390 B3 审计：归档
  优先于删除红线，recall 不扫 archive=设计内「旧证据不进检索面」）；桥接 similar/evolve 边仅
  31% 覆盖+similar 边语义不可靠+恢复归档违背设计。**不做写链变更**；Panel 溯源经
  getL1ByIdsWithArchive 回溯兜底（§6.5 起的 /v3/atomic/by-ids 即其 HTTP 面）。
- **P3 逐字簇（v3）目标集双口径=0**：exact 同 content 组=0（SQL 实测）、样例前缀=0——**v3 转
  条件触发**（出现同 content 组再启动），不排期。
