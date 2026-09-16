# 剩余工作 · 第一性原理分析文档 v5

> 文档标识：REG-REMAINING-005（取代 v4 的待办部分；v4 已完成项与验证轮成果见 CHANGELOG 2026-09-16 各条——#5 提取覆盖性与游标双根因修复 c35a3e6、#7 锚门 debug 化、验证轮四实锤两缺陷修复 64dd815）
> 日期：2026-09-16 深夜（验证轮四收口后）
> 方法论：每项从第一性原理出发，结合真实代码（file:line 实证）与设计文档分析 → 判定"做/等/不做" → 附实现设计；每项含背景/原因/相关代码/设计思路/触发条件/量级
> 审计原则：自生长、自维护——凡是"等人操作/等人发现"的环节都是设计缺口；**配置/机制"存在"必须以不变量的持续满足为准**（验证轮四：遗忘年龄缺陷即"机制存在但不变量被破坏"的活例）
> 数据基线（2026-09-16 23:10 实测，HEAD=64dd815）：L1 281（FTS 281/281 同步）· conflict 6（**P4-GATE ≥5 已自动宣告**）· derived_from 146 · evolve 23 · similar 500+ · 判官标注 142（tdai-judge.timer 每日 04:00，下次 09-17 04:00）· flowtest 锚 5/15（潜水/航拍/围棋/每周/计划，valence 全非 NULL）· 四服务健康 · boot recovery 53 会话覆盖实证

---

## 第一部分 · 真正要做的（门槛已到 / 即将到达）

### 1. P4b evolution-worker——受控正文演化（门槛已到，待拍板）

**背景**：conflict 边 = 同主题新旧记忆矛盾，不处理则新旧并存、召回自相矛盾。spec 已有完整设计（evolution-design P4 节：五条件门 + evolved_from 审计边，设计已定稿，不重新设计）。**v4 时 conflict=3 未达门槛；本轮实测 conflict=6，`anchor-growth.ts:392` 的 `[P4-GATE]` 旗标已在 self-obs 日志自动宣告——观察期正式结束，可立项，等用户拍板。**

**原因（第一性原理）**：错误不对称——门严 = 不触发（良性），门松 = 错误改写正文（污染难恢复）。受控合并 = LLM 重写正文，是全系统唯一允许改写已固化正文的路径，必须最严门控。P4-GATE 旗标本轮真实到达（session-h 12 组注入贡献 3 条新 conflict），说明矛盾消解需求是真实数据驱动的，非先验设计。

**相关代码**：
- `docs/superpowers/specs/2026-09-15-memory-evolution-design.md:31`（P4 行：evolution-worker 离线重写 + 审计边，前置 = P2 失效设施 ✓ 已闭环 + conflict 频率观察期 ✓ 本轮到达）
- `src/core/record/l1-extractor.ts:834-850`：**两条并存消解路径的现场**——`decision.target_ids` 按 decision.kind 分派：evolve/similar/conflict 建边（:839/:841/:844）、conflict 走 `invalidateL1(t, invalidEnd)`（:850）。**关键边界事实**：LLM 大量走"归纳合并"路径（本轮 session-e 的 4K30→60、session-h 的 CMAS→PADI，均同条呈现新旧值），只有 LLM 显式判 conflict 才触发失效——P4b 的"受控演化"只应处理后者，绝不能把合并叙事误判为待演化矛盾
- `src/core/store/sqlite.ts:3511` `invalidateL1(id, validEndIso)`（失效设施，P2 已闭环）；`:2665` 附近 coreRefs 读改写 + 双表同步（invalidateL1 教训——evolution-worker 写路径必须复用同款双表纪律）；evolved_from 审计边直接复用 addLink
- `src/core/lifecycle/lifecycle-scheduler.ts`：P4b worker 承载点（与 consolidation/forgetting/anchor-growth 同款 tick；验证轮四已实证该 scheduler 的互斥 `runOnceInFlight` + 停滞告警工作正常）
- 失效传播复用 derived_from 定位（`[P4a-P2]` 闭环，验证轮 session-e 实证）

**设计思路**：按 spec P4 节执行，不重新设计。新增点：
① worker 挂 lifecycle tick，扫描 conflict 边（`getLinksByTarget/getLinksBySource` + type='conflict'，`sqlite.ts:1749/1767`），对满足五条件门的矛盾对执行 LLM 受控重写；
② **合并/失效边界 golden（本轮新增的硬要求）**：用 session-h 真实矛盾对做 fixture——"CMAS→PADI 改意"（归纳合并叙事，同条呈现）不得触发 evolution 重写；"新旧值同字段真矛盾"（如计划时间变更）必须走 evolved_from 审计边。该 golden 防止 P4b 把 extractor 的合并决定系统性推翻；
③ LLM runner 复用 StandaloneLLMRunner（**maxTokens 显式 0 / timeoutMs 显式 0**——GROW-EVO P2.1 裁定，Ark 推理模型 thinking 会吃满缺省 4096 返回空文本）；
④ config-first：`memory.evolution.enabled` 缺省 false = 逐位现状（本项是全系统唯一允许改写已固化正文的路径，宁可多一层显式开关）；
⑤ 全程 evolved_from 审计边 + 写路径走 store 层（双表同步纪律），CHANGELOG 登记列名受影响测试。

**触发条件**：**已到达（conflict=6 ≥5），待用户拍板后执行。量级：~150 行。**

---

### 2. D2 产线替换——九通道校准拟合 → yaml 部署（预计 09-18/19 到达）

**背景**：九通道排序信号全部关断（golden A/B 实测降精度），根因是小语料期先验信噪比不足。校准拟合器已建（pilot 87%），等标注量到统计有效门槛后用数据学出权重。判官标注当前 142 条（`docs/superpowers/evals/judge/labels-2026-09-15.jsonl` 67 + `labels-2026-09-16.jsonl` 75），`tdai-judge.timer` 实证每日 04:00 自动积累（下次 09-17 04:00）。

**原因（第一性原理）**：信噪比不足的解不是等语料变大碰运气，而是用标注数据学权重。统计有效门槛 = 标注 ≥300 且正例 ≥50——未达门槛做拟合是过拟合 fixture 分布；且校准依赖情感/冲突信号的真实分布（P2-P4 产出，evolution-design §141），先验依赖未就绪时拟合出的权重不可信。本轮验证轮四实证情感信号链路已就绪（emotionSalienceOf 纯函数 + valence 8/8 落库），拟合的特征面有真实数据支撑。

**相关代码**：
- `MemoryCore/scripts/calibrate-fit.mjs`：拟合器（逻辑回归 + 7 特征）；**产线替换需扩展**：coreRefHit / channel one-hot / type one-hot
- `MemoryCore/scripts/judge-run.mjs` + `docs/superpowers/evals/judge/labels-*.jsonl`（142 条，timer 积累中）
- `src/core/hooks/auto-recall.ts:1341,1825-1834`：`applyCompositeRerank` 消费 `rerankWeights`（`:1834` 传入 `rerankWeights ?? DEFAULT_COMPOSITE_WEIGHTS`）；`:1143` exploreSlot/rerankWeights 配置消费点
- `tdai-gateway.yaml:99-103`：`recall.rerankWeights` 四通道**显式落盘全 0 恒等**（验证轮四审计修正：v4"键不存在"表述与盘面不符，行为等价）——D2 部署 = 改值而非新增键
- `src/core/tools/recall-signals.ts:171`：`emotionSalienceOf`（|valence|×arousal 纯函数，单源）

**设计思路**：标注达标 → 扩展特征重跑拟合 → 精度人工复核 → **预注册 A/B**（拟合权重 vs 全 0 基线，同标注池，标注固定法）→ 通过后 `tdai-gateway.yaml:99` 改值（先高系数通道，非一次全开）→ Lane 2 回归精度 ≥ 现行验收线 P@5 ≥ 0.325（yaml:98 注释重锚基线 0.345 − margin 0.02）→ CHANGELOG 登记列名受影响测试。R10 恒等位红线（`yaml:106` emotionSalienceWeight=0）在 A/B 通过前不得置正。

**触发条件**：标注 ≥300 且正例 ≥50（当前 142，每日 +~70，**预计 09-18 晚~09-19 到达**）。**量级：~100 行。**

---

## 第二部分 · 等门槛（行号已按 64dd815 刷新）

### 3. D5 R10 A/B 执行（等情感 cohort ≥20）

**背景/原因**：预注册已完成（REG-R10-AB-001，判据/样本/终止条件冻结，判官同源偏差声明 + 标注固定法 + 双口径敏感性分析预登记）——执行期唯一禁止的是偏离预注册。emotionSalienceWeight 恒等位（`yaml:106`）在 A/B 通过前不得置正。

**相关代码**：
- `docs/superpowers/specs/2026-09-16-r10-ab-design.md`（预注册冻结）
- `src/core/hooks/auto-recall.ts` compareLex R10 项（钩子侧）+ `src/core/tools/memory-search.ts:276` `secondaryOf` 第 5 元（工具侧，:292-293 消费）
- `src/core/tools/recall-signals.ts:171`：`emotionSalienceOf` 纯函数
- 待建：`MemoryCore/scripts/r10-ab.mjs`（Lane 2 hermetic 同构 + config-override 每臂 boot；**注意 config-override.json 仅支持 llm/embedding 段，勿用它调 memory**）

**设计思路**：按预注册执行序——选集脚本出 cohort（queryId 升序前 20，不得挑优）→ 冻结标注快照 → A 臂基线复算 → B 臂（weight=0.3）→ 逐批判定（+5pp 通过 / 连续 3 批无差异终止 / 100 组判负）→ 报告 + CHANGELOG。**依赖 D2 标注积累**，随 D2 一并到达。

**触发条件**：情感 cohort ≥20 组。**量级：~50 行。**

---

### 4. P4a Phase 2 逐块重蒸馏（等边覆盖成熟）

**背景/原因**：层级边（derived_from，当前 146）+ 沿边定位（`[P4a-P2]`）已闭环。"失效 → 受影响块 → 逐块重蒸馏（剔除失效内容）"暂缓。两个前置：① 溯源落盘正常（L1 281 轮实证持续落盘，`store.ts:14` ROOT = `memory-generation-logs/v1`，instances/default 实盘有文件）；② **存量块输入史不可回填**——建边（2026-09-16）前蒸馏的块没有边，自动重建会静默丢历史贡献。②满足前启用重建必错。

**相关代码**：
- `src/core/memory-generation-log/store.ts:14`（ROOT 常量）+ `best-effort.ts`（失败 warn 已在位，v3"静默吞错"判定已推翻并关闭）
- `src/utils/pipeline-factory.ts:38`（`writeGenerationProvenanceBestEffort` 导入；L2/L3 溯源写入调用点 v4 登记 :954/:1118）
- `src/core/scene/scene-extractor.ts:55,569`（`changedSceneFiles` 权威变更集）
- `src/core/store/sqlite.ts:1749` `getLinksByTarget`（反查已就绪）

**设计思路**：边覆盖成熟判定 = 新蒸馏块 100% 有边 + 溯源 input_refs 与边数互证一致（两条独立证据）→ 实现 `redistillBlock(blockId)`：取块的有效输入集（derived_from 反查排除失效者）→ 复用 extractor 蒸馏 → 重写块 + 刷新边 → 全程 config 门控（缺省关）+ Lane 2 回归。

**触发条件**：边覆盖观测成熟（预计 1-2 周积累）。**量级：~150 行。**

---

### 5. D7 recordIds 查询 O(N)→索引路径（等大语料）

**背景/原因**：`queryL1Records` 的 `recordIds` 过滤在应用层逐条比对，记录量大时 O(N) 全表扫。当前 281 条无感；但 derived_from/邻居扩展/失效传播都走 recordIds 路径（本轮 boot recovery 的 L0 并集补口同样依赖逐键查询模式——两者同源），语料到万级时是召回延迟的确定性上限项。

**相关代码**：`src/core/store/sqlite.ts:3723`（`queryL1Records` 解构 `recordIds`，应用层过滤）；对照 `:3350` `deleteL1Batch` 的批量习惯（分批 IN 防 SQLite 999 变量上限）。

**设计思路**：recordIds 走临时表 JOIN 或 `IN (dynamic placeholders)` 分批；改造前后用 judge-run 同款计时对照。**触发条件**：L1 ≥5k 或召回 P95 劣化实测。**量级：~40 行。**

---

## 第三部分 · 择机 / 小项

### 6. flowtest 探针退役（等 D5 A/B 结束）

**背景/原因**：flowtest 现 31 条 L1（a-h 八批，h 为验证轮四对抗数据）+ 5 锚（潜水/航拍/围棋/每周/计划）+ identity。价值 = 隔离可复现测试场（本轮 boot recovery/续批/遗忘修复全部靠它实证）；成本 = 身份/锚自发现的持续 LLM 消耗（冷却自限，本轮发现轮一次性 3 锚采纳）。

**相关代码**：`/data/tdai-memory/profiles/team%3Ateam-flowtest%7Cagent%3Aagt-flowtest/`；`l1_records WHERE agent_id='agt-flowtest'`。

**设计思路**：保留至 D5 A/B 结束（hermetic 测试可能复用该租户模式）；届时统一归档（导出 JSON + 删除租户目录 + kv 清理含 `anchor_growth_state` 四键与 checkpoint runner_states 对应键）。**触发条件：D5 A/B 结束。量级：~30 行。**

### 7. anchorDiscovery.maxPerPass 工作点定格（文档级小项）

**背景**：`tdai-gateway.yaml:156` `maxPerPass: 3 # FLOW-TEST 调参演示（2→3，观察采纳数量变化）`——调参后一直未裁定。验证轮四发现轮实证：3 的采纳节奏正常（一次 3 锚，名额 5/15 守恒），无超额证据。

**设计思路**：二选一并落注释——① 裁定 3 为新工作点（改注释定格"3 = 验证轮四实证工作点"）；② 回 2（走调参流程 + 回归）。**需要用户拍板，不擅自定。量级：1 行注释。**

---

## 第四部分 · 不做 / 已关闭（相对 v4 的增量判定）

| 项 | 判定 | 依据 |
|---|---|---|
| extractor 窗口改全量消费 | **不做**（验证轮四复审裁定） | 窗口截断是 LLM 质量保护（10 条上限），游标续批（c35a3e6）+ drain 豁免已保证 cursor 收敛；全量消费反而放大单窗口截断丢上下文的风险 |
| boot 运行时 persister 周期持久化 count/timer | **不做**（验证轮四复审裁定） | 更重且仍不覆盖 timer；游标治理 + boot recovery 并集补口（64dd815）以不变量（L0 全会话可发现）达成同一保证，不动状态面 |
| executor count===0 去重整体移除 | **不做** | 窄豁免（isDrainTimer）已解封续批路径，纯 idle 去重保留 Redis 模式成本优化 |
| 提取 prompt 判据修改 | **不做**（继承 v4） | 漏损为 LLM 竞争方差 |
| 溯源 best-effort 失败 warn 补加 | **关闭**（继承 v4） | 前提被推翻 |
| 撤销 maxMemoriesPerSession 10/20 分叉 | **维持现状**（继承 v4 并入观测，本轮无新证据） | config-first：改缺省=行为变更需裁定 |

## 第五部分 · 配置项审计（2026-09-16 23:10 复审，HEAD=64dd815）

anchorDiscovery 5 字段 ✓（enabled/minEvidence=3/maxPerPass=3/maxTotal=15/intervalHours=24，接线贯通+发现轮实跑）· durativeEnabled: true ✓（session-h 三条 valid_start 落库实证）· excludeInvalidated: true ✓ · arousalRetention: 0.3 ✓ · emotionSalienceWeight: 0 ✓（恒等位红线）· enableDedup: true ✓（CMAS→PADI 归纳合并实证）· **recall.rerankWeights：显式落盘全 0 恒等** ✓（v4 表述修正）· MEMORY_LOG_LEVEL=info ✓ · lifecycle ✓（互斥 + 停滞告警 + P4-GATE 旗标全部实跑）· FTS 281/281 ✓ · 向量双写 0 跳过 ✓ · 无 seedValues/P4P5 残留 ✓ · l1IdleTimeoutSeconds=600 ✓（byte-identical 还原验证）· 新增接线维度：boot recovery（53 会话）/ drain 豁免 / listL0SessionIds 全部运行时实证贯通。
**新增审计教训（继承验证轮三 + 四）**：接线连通性（解析→传参→消费全链）是审计必查维度；**遗忘年龄类语义耦合**（一个子系统的权威字段成为另一个子系统的输入）是新识别的假阳性面——A2 修复当时正确，P2a 落地后语义漂移，机制"存在"≠不变量满足。

## 第六部分 · 观察登记（未立项，供后续裁定参考）

| # | 观察 | 证据 | 当前判定 |
|---|---|---|---|
| O1 | 采纳侧 free 计算的 pinned-auto 双计（`anchor-growth.ts:307`），守卫侧 :269 已用无双计口径 | 代码实证 | 保守方向无害，登记不改——改动影响挤出语义，需随 D 类裁定一并处理 |
| O2 | 锚提案质量波动 | **本轮更新**：发现轮潜水/航拍/围棋三主题族全部正常提案+采纳+valence，此前弱标签（"计划"类）未再新增 | 机制正确，暂无恶化，持续观察 |
| O3 | durative valid_start 推导质量方差（session-h"仙本那 2027-03"未推导） | 提取代记录 | LLM 时间推理方差，非机制缺陷，持续观察 |
| O4 | 窗口头部弱势嫌疑 | 续批修复后批次按游标分轮（10+2 两轮实证），头部消息进入次轮窗口头部 | 并入 #5 已收口语义，暂无新模式 |
| O5 | **遗忘年龄 × P2a 溯源语义对抗（已修复留档）**：occurred_at 权威字段曾被 forgetting 当记忆年龄 → 溯源越准忘得越快 | session-h 实锤（64dd815 修复 + 3 golden） | 修复已落地；**复发监测点**：若未来再出现"刚提取即归档"，优先排查 ageDaysOf 语义链 |
| O6 | flowtest 归档率高位（archiveRate≈0.47，archived 244） | self-obs 日志 | 遗忘机制正常工作（含本轮 dedup-merge 归档），非缺陷；若 D2 校准期标注池受影响再评估 |

触发立项条件：任一观察出现可复现的系统性模式（≥2 轮独立实证）。

## 执行时间线

| 优先级 | 项 | 触发 | 量级 |
|---|---|---|---|
| **1（待拍板）** | P4b evolution-worker（#1） | **已到达（conflict=6）** | ~150 行 |
| **1（临近）** | D2 产线替换（#2） | 标注 ≥300 且正例 ≥50（现 142，预计 09-18/19） | ~100 行 |
| 等 | D5 R10 A/B（#3） | 情感 cohort ≥20（随 D2） | ~50 行 |
| 等 | P4a Phase 2 重蒸馏（#4） | 边覆盖成熟（derived_from 146 积累中） | ~150 行 |
| 等 | D7 recordIds 索引（#5） | L1 ≥5k 或 P95 劣化（现 281） | ~40 行 |
| 择机 | flowtest 退役（#6） | D5 A/B 后 | ~30 行 |
| 择机（待拍板） | maxPerPass 工作点定格（#7） | 用户裁定 | 1 行 |
