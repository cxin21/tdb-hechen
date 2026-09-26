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
