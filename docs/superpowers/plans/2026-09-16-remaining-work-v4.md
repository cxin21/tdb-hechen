# 剩余工作 · 第一性原理分析文档 v4

> 文档标识：REG-REMAINING-004（取代 v3 的待办部分；v3 已完成项与验证轮成果见 CHANGELOG 2026-09-16 各条）
> 日期：2026-09-16 晚
> 方法论：每项从第一性原理出发，结合真实代码（file:line 实证）与设计文档分析 → 判定"做/等/不做" → 附实现设计
> 审计原则：自生长、自维护——凡是"等人操作/等人发现"的环节都是设计缺口
> 数据基线（2026-09-16 17:10 实测，HEAD=2c76af2）：L1 238（FTS 238/238 同步）· 锚 30（valence 30/30，采纳钩子真实数据生效）· conflict 3 · derived_from 121 · similar 381 · evolve 17 · 判官标注 142 · 溯源日志 L1 668+ 持续落盘 · 四服务健康
> 本轮已完成（对照）：待办 #1 valence 修复（946b6d9）· #2 测试还债 + A2-R1 折叠内容口径（82ff763）· #3 提取漏损实证 + 探针（3fbf80e）· #5 溯源前提修正 + **anchorDiscovery 配置接线修复**（2c76af2，SOP 验证轮发现 yaml 段全程死配置）

---

## 第一部分 · 真正要做的

### 1. D2 产线替换——九通道校准拟合 → yaml 部署（等门槛）

**背景**：九通道排序信号全部关断（golden A/B 实测降精度），根因是小语料期先验信噪比不足。校准拟合器已建（pilot 87%），等标注量到统计有效门槛后用数据学出权重。

**原因（第一性原理）**：信噪比不足的解不是等语料变大碰运气，而是用标注数据学权重。统计有效门槛 = 标注 ≥300 且正例 ≥50——未达门槛做拟合是过拟合 fixture 分布；且校准依赖情感/冲突信号的真实分布（P2-P4 产出，evolution-design §141），先验依赖未就绪时拟合出的权重不可信。

**相关代码**：
- `MemoryCore/scripts/calibrate-fit.mjs`：拟合器（逻辑回归 + 7 特征）；**产线替换需扩展**：coreRefHit / channel one-hot / type one-hot
- `MemoryCore/scripts/judge-run.mjs` + `docs/superpowers/evals/judge/labels-*.jsonl`（当前 142 条，timer 每日 04:00 积累）
- `src/core/hooks/auto-recall.ts:1143,1341,1825-1834`：`applyCompositeRerank` 消费 `cfg.recall?.rerankWeights`（关断态，RV2-2 复合精排）
- `tdai-gateway.yaml`：`recall.rerankWeights` 键**当前不存在**（D2 部署时新增——config-first：缺省缺键 = 全 0 恒等）

**设计思路**：标注达标 → 扩展特征重跑拟合 → 精度人工复核 → **预注册 A/B**（拟合权重 vs 全 0 基线，同标注池，标注固定法）→ 通过后 yaml 新增 `recall.rerankWeights`、九通道按系数逐步解禁（先高系数通道，非一次全开）→ Lane 2 回归精度 ≥ 基线 → CHANGELOG 登记并列名受影响测试（v3 教训）。

**触发条件**：标注 ≥300 且正例 ≥50（当前 142，每日 +~70，预计 09-18 达标）。**量级**：~100 行。

---

### 2. D1-P4b evolution-worker（等门槛）

**背景**：conflict 边 = 同主题新旧记忆矛盾。不处理则新旧并存、召回自相矛盾。spec 已有完整设计（evolution-design P4 节：五条件门 + 审计边）。

**原因（第一性原理）**：错误不对称——门严 = 不触发（良性），门松 = 错误改写正文（污染难恢复）。受控合并 = LLM 重写正文，是全系统唯一允许改写已固化正文的路径，必须最严门控。P4-GATE 旗标未宣告前启动 = 抢跑。

**相关代码**：
- `docs/superpowers/specs/2026-09-15-memory-evolution-design.md` P4 节（五条件门 + evolved_from 审计边，设计已定稿，不重新设计）
- `src/core/record/l1-extractor.ts:850`：conflict 自动失效路径（`decision.target_ids` → invalidateL1）——**本轮实证**：session-e 的 m6/m7 矛盾走了"归纳合并"路径（新旧值同条呈现）而非 conflict 路径，说明 LLM 合并与 conflict 失效是两条并存的消解路径，P4b 设计时需明确两者边界
- `src/core/lifecycle/anchor-growth.ts` self-obs 块：conflict ≥5 → `[P4-GATE]` 宣告（本轮实测 conflict 1→3，旗标未到）
- `src/core/store/sqlite.ts` invalidateL1 / l1_links（evolved_from 审计边直接复用 addLink）；失效传播复用 derived_from 定位（`[P4a-P2]` 已闭环）

**设计思路**：按 spec P4 节执行。新增点：worker 触发挂 self-obs tick（conflict 门槛到达即宣告）；对"归纳合并 vs conflict 失效"的边界做 golden 用例（合并叙事不触发失效、真矛盾触发）。

**触发条件**：conflict ≥5（当前 3）。**量级**：~150 行。

---

### 3. D5 R10 A/B 执行（等门槛）

**背景/原因**：预注册已完成（REG-R10-AB-001，判据/样本/终止条件已冻结，判官同源偏差声明 + 标注固定法 + 双口径敏感性分析已预登记）——执行期唯一禁止的是偏离预注册。emotionSalienceWeight 恒等位（yaml:106）在 A/B 通过前不得置正（实验轨红线，本轮 vitest 断言已固化该口径）。

**相关代码**：
- `docs/superpowers/specs/2026-09-16-r10-ab-design.md`（预注册，判据冻结）
- `src/core/hooks/auto-recall.ts` compareLex R10 项（钩子侧）+ `src/core/tools/memory-search.ts` secondaryOf[4]（工具侧）
- `src/core/tools/recall-signals.ts:171`：`emotionSalienceOf`（|valence|×arousal 纯函数）
- 待建：`MemoryCore/scripts/r10-ab.mjs`（Lane 2 hermetic 同构 + config-override 每臂 boot）

**设计思路**：按预注册执行序——选集脚本出 cohort（queryId 升序前 20，不得挑优）→ 冻结标注快照 → A 臂基线复算 → B 臂（weight=0.3）→ 逐批判定（+5pp 通过 / 连续 3 批无差异终止 / 100 组判负）→ 报告 + CHANGELOG。

**触发条件**：情感 cohort ≥20 组（随 D2 标注积累，筛选用选集脚本）。**量级**：~50 行。

---

### 4. P4a Phase 2 逐块重蒸馏（等边覆盖成熟）

**背景**：层级边（derived_from，当前 121）+ 沿边定位（`[P4a-P2]` 产线可见，本轮 session-e 失效传播再次实证）已闭环。"失效 → 受影响块 → 逐块重蒸馏（剔除失效内容）"按设计暂缓。

**原因（第一性原理）**：重蒸馏 = 用块的 derived_from 输入集（排除失效者）重建该块。两个前置：① 溯源日志落盘——**已实证正常**（L1 668+/L2/L3 持续落盘，schema 含 input_refs；且 `best-effort.ts:13/:23` 失败路径本就有 `logger?.warn`，v3"静默吞错"前提双重推翻，该项**关闭**）；② **存量块输入史不可回填**——建边（2026-09-16）前蒸馏的块没有边，自动重建会静默丢掉历史贡献。②满足前启用重建必错。

**相关代码**：
- `src/core/memory-generation-log/store.ts:14`（ROOT 常量）+ `src/core/memory-generation-log/best-effort.ts:12-24`（失败 warn 已在位）
- `src/utils/pipeline-factory.ts:954`（L2 溯源写入调用点）、`:1118`（L3）
- `src/core/scene/scene-extractor.ts`（changedSceneFiles 权威变更集）
- `src/core/store/sqlite.ts` getLinksByTarget（反查已就绪）

**设计思路**：边覆盖成熟判定 = 新蒸馏块 100% 有边 + 溯源 input_refs 与边数互证一致（两条独立证据）→ 实现 `redistillBlock(blockId)`：取块的有效输入集 → 复用 extractor 蒸馏 → 重写块 + 刷新边 → 全程 config 门控（缺省关）+ Lane 2 回归。

**触发条件**：边覆盖观测成熟（预计 1-2 周积累）。**量级**：~150 行。

---

### 5. 提取覆盖性与批次/重试策略实证（新项 · 待办 #3 判定的下一步）

**背景**：待办 #3 已实证判定漏损为随机（竞争性）而非判据排斥（assistant 帮办 2/3 命中，判据无恙，不改 prompt）。但验证轮 session-e 又暴露一个**机制性**覆盖缺口：12 条消息注入后仅前 10 条进了提取窗口，m11/m12（月食/窄带重复）成为背景从未被提取——月食记忆因此缺失，时间旅行测试用例只能改用既有记忆。

**原因（第一性原理）**："记全"是记忆系统的第一性承诺；窗口截断本身是合理设计（10 条上下文上限保护 LLM 质量），但**截断后的尾段必须有确定的后续消费路径**——若尾段被静默遗留（无第二批、无日志、无宣告），就是"等人发现"型缺口。当前证据：① `l1-extractor.ts:190` `qualifiedMessages.slice(-maxNewMessages)`（默认 10）单次调用只取尾窗；② session-e 实测仅 1 个 flowtest 提取代（溯源日志 input_refs=10），m11/m12 未形成后续批次；③ 探针另证 `maxMemoriesPerSession` 缺省 10 vs 生产 yaml 20 的混淆面。三者中哪些是"管道游标未走完"、哪些是"调用方未续批"，**尚未实证区分**——先观测后改。

**相关代码**：
- `src/core/record/l1-extractor.ts:176`（`shouldExtractL1` 资格过滤）、`:190`（`slice(-maxNewMessages)` 尾窗）、`:193`（背景窗）、`:301`（maxMemoriesPerSession 截断）
- 调用方游标语义：conversation/add 捕获管道的 cursor 推进逻辑（`ensureConversationAddForInstance` 侧，待插桩实证）
- 观测工具：`MemoryCore/scripts/extraction-loss-probe.mjs`（已入库，复跑即得基线）

**设计思路**：① 插桩实证：对 N≥12 条注入测游标是否保证尾段最终被消费（计时 + 溯源日志对账）；② 若尾段确会遗留 → 修复方向 = 捕获管道补"尾窗续批"（cursor 收敛保证），config-first 无新开关；③ 若游标已保证而本轮是时序巧合 → 记录实测证据关闭该项；④ 批次内随机漏损（LLM 竞争方差）不在本项修复面——如需收敛，评估"低产批次一次性重试"（宁缺毋滥语义下的成本/收益另行裁定）。

**触发条件**：现在（观测 ~1 小时级）。**量级**：插桩 + 对账 ~60 行；修复视实证 0-80 行。

---

### 6. D7 recordIds 查询 O(N)→索引路径（继承登记项，等大语料）

**背景**：v1/v2 登记的遗留项（`2026-09-15-remaining-work-registry.md:41`、v2:194），v3 未携带。`queryL1Records` 的 `recordIds` 过滤在应用层逐条比对，记录量大时 O(N) 全表扫。

**原因（第一性原理）**：当前 238 条无感；但 derived_from/邻居扩展/失效传播都走 recordIds 路径，语料到万级时这是召回延迟的确定性上限项。等"性能可感"再做的判定合理（提前做是无实测收益的优化），但必须在登记清单里留位防止遗忘。

**相关代码**：`src/core/store/sqlite.ts:3723`（`queryL1Records` 解构 `recordIds`，应用层过滤）；对照 `:3350` `deleteL1Batch` 的批量习惯。

**设计思路**：recordIds 走临时表 JOIN 或 `IN (dynamic placeholders)` 分批（SQLite 变量上限 999 的分批习惯）；改造前后用 judge-run 同款计时对照。**触发条件**：L1 ≥5k 或召回 P95 劣化实测。**量级**：~40 行。

---

### 7. anchor-growth 双门静默 continue debug 化（小）

**背景**：验证轮插桩发现门 1a/1b 拦截时 `firstBlockReason ??= ...; continue;` 无任何日志——agent 级拦截对外完全不可见（与待办 #1 的 boot derive 静默同类；本轮靠临时插桩定位，插桩已移除）。

**原因（第一性原理）**：anchorDiscovery 接线修复（2c76af2）后该路径已是主路径；拦截原因不可见意味着"为什么锚没长出来"永远要靠插桩考古——静默失败宣告原则的残余缺口。仅 debug 级（INFO 门下零增量，符合日志级别门语义）。

**相关代码**：`src/core/lifecycle/anchor-growth.ts:194-206`（1a `attempt-cooldown` / 1b `interval` 两处 continue）；对照 summary 行（`:351` 附近）只打 `agents/adopted` 不打 reason。

**设计思路**：两处 continue 前各加一行 `logger?.debug?.("[anchor-growth] gate block agent=... reason=... state=...")`；summary 行追加 `firstBlockReason`（ran=false 时）。零行为变更。**触发条件**：现在（顺手）。**量级**：~6 行。

---

### 8. flowtest 探针退役（择机）

**背景**：flowtest 现有 18 条 L1（a-e 五批）+ 2 场景块 + identity v1 + 锚 2（本轮流程测试又复用一次）。其价值 = 隔离可复现测试场；成本 = 身份/锚自发现的持续 LLM 消耗（冷却自限）。

**相关代码**：`/data/tdai-memory/profiles/team%3Ateam-flowtest%7Cagent%3Aagt-flowtest/`；`l1_records WHERE agent_id='agt-flowtest'`。

**设计思路**：保留至 D5 A/B 结束（hermetic 测试可能复用该租户模式）；届时统一归档（导出 JSON + 删除租户目录 + kv 清理），归档脚本 ~30 行。**触发条件**：D5 A/B 结束。

---

## 第二部分 · 不做 / 已关闭（相对 v3 的增量判定）

| 项 | 判定 | 依据 |
|---|---|---|
| 提取 prompt 判据修改 | **不做**（待办 #3 实证） | assistant 帮办 2/3 命中，判据"主体须为用户/AI"不排斥 AI 工作成果；漏损为 LLM 竞争方差 |
| 溯源 best-effort 失败 warn 补加 | **关闭**（前提双重推翻） | 落盘正常（668+ 文件）且 `best-effort.ts:13/:23` 失败路径已有 warn——v3"静默吞错"不成立 |
| 溯源日志落盘修复 | **关闭** | 同上，v3 待办 #5 前置缺口 ① 不存在 |
| 撤销 maxMemoriesPerSession 缺省 10 与 yaml 20 的分叉 | **并入待办 #5 观测** | 探针已踩坑登记；是否统一待游标实证一并裁定（config-first：改缺省=行为变更需裁定） |
| 不做项 | 继承 v3 | 动机方向深化 / 策略统一双兜底 / TCVDB 实证 / router 存废 / Lane 1 重建 / 密度公式 / B4 注释重灌 |

## 第三部分 · 配置项审计（2026-09-16 17:10 复审）

anchorDiscovery 5 字段 ✓（**2c76af2 接线修复后运行时实证贯通**，调参已还原 24h）· durativeEnabled: true ✓（valid_start 落库实证）· excludeInvalidated: true ✓ · arousalRetention: 0.3 ✓ · emotionSalienceWeight: 0 ✓（恒等位红线）· enableDedup: true ✓（persona 合并实证）· creditReport ✓ · MEMORY_LOG_LEVEL=info ✓（已还原）· lifecycle ✓（consolidation/forgetting active）· FTS 238/238 ✓ · 向量双写 0 跳过 ✓ · 无 seedValues/P4P5 残留 ✓。
**新增审计维度（验证轮教训）**：配置项审计须含**接线连通性**（解析→传参→消费全链），静态"键存在"是假阳性面——本轮 anchorDiscovery 即凭静态审计漏网。

## 执行时间线

| 优先级 | 项 | 触发 | 量级 |
|---|---|---|---|
| **1** | 提取覆盖性与批次/重试实证（#5） | 现在（观测） | ~60 行插桩 + 0-80 行修复 |
| **1** | anchor-growth 门静默 debug 化（#7） | 现在（顺手） | ~6 行 |
| 等 | D2 产线替换（#1） | 标注 ≥300 且正例 ≥50（现 142） | ~100 行 |
| 等 | P4b evolution-worker（#2） | conflict ≥5（现 3） | ~150 行 |
| 等 | D5 R10 A/B（#3） | 情感 cohort ≥20 | ~50 行 |
| 等 | P4a Phase 2 重蒸馏（#4） | 边覆盖成熟（derived_from 121 积累中） | ~150 行 |
| 等 | D7 recordIds 索引（#6） | L1 ≥5k 或 P95 劣化 | ~40 行 |
| 择机 | flowtest 探针退役（#8） | D5 A/B 后 | ~30 行 |

---

## 验证轮二补记（2026-09-16 晚，用户发现锚超限 → 拍板 A+B）

**新增第 9 项并当日完成：GROW-RACE 互斥 + GROW-QUOTA 名额回归守卫 ✅**——用户发现 l5ug 锚 18 个超
maxTotal=15 且无自愈。根因二重：① scheduler `void runOnce` 无互斥 + 慢 LLM + intervalMs 短 → 重叠 run
基于过期快照超额采纳（9 秒内三个 run，adopted=8/6/3）；② maxTotal 仅是采纳名额门，GROW-MAINT 只有证据
退场，存量超限无自愈路径。修复：scheduler 进程级互斥（全生命周期路径覆盖）+ GROW-QUOTA 名额回归守卫
（非钉 auto + 钉住 > maxTotal → 强度升序 retire，可恢复，manual/钉住豁免）。真实数据回归：l5ug 18→15、
全 agent 名额达标、valence 0 NULL。+3 golden，vitest 465/465，tsc 243。详见 CHANGELOG
「GROW-RACE 互斥 + GROW-QUOTA 名额回归守卫」。登记未改：free 计算的 pinned-auto 双计（保守方向无害）。
本项发现再次印证方法论：**配置/护栏类机制的"存在"必须以不变量的持续满足为准，而非代码路径存在**。

> **验证轮三补记（2026-09-16 晚）**：#5 游标缺口**三重实证升级为实锤缺陷**——① 注入后重启吞掉 add 触发的
> 提取调度（13 条滞留，40 分钟 0 提取代）；② 溯源 input_refs 实证单窗口仅前 10 条；③ 两次 nudge 后尾段
> 仍无消费。#5 从"待实证"转为"实锤，按设计思路①②推进修复"。另：互斥硬化（连续跳过 10 次 warn 停滞
> 告警）已落地；A+B 主体验证全 PASS（API 8/8、锚挤出守恒、采纳钩子 4/4、FTS/溯源/隔离/时间旅行）

---

## 第四部分 · 观察登记（未立项，供后续裁定参考；2026-09-16 晚验证轮沉淀）

| # | 观察 | 证据 | 当前判定 |
|---|---|---|---|
| O1 | free/名额计算存在 pinned-auto 双计：钉住的 auto 锚在 autoActive 与 pinnedCount 各计一次 → 采纳名额偏保守。GROW-QUOTA 守卫已改用无双计口径，但采纳侧 free 未动 | `anchor-growth.ts` 采纳循环 free 计算（`:285` 附近）vs 守卫口径 | 保守方向无害，登记不改——改动影响挤出语义，需随 D 类裁定一并处理 |
| O2 | 锚提案质量波动：flowtest 验证轮"计划"（弱语义）获采纳，而证据同样达标的"无人机/航拍"主题未获提案；session-e 亦出现过弱标签 | flowtest 锚列表（深空/每周/计划）+ 发现轮 LLM 提案 | 机制正确（minEvidence 证据门拦得住证据不足者），提案选择是 LLM 判定质量——样本不足不下结论，积累观察；若持续弱标签增多，候选方向 = 提案 prompt 的"锚 worthy"标准收紧（届时登记受影响测试） |
| O3 | durative valid_start 推导质量波动：session-e"下个月"→精确推导 2026-10-01；session-f"下季度"→落在当下时刻（未推导 Q4 起点） | `l1_records.valid_start` 两轮实测对比 | LLM 时间推理方差，非机制缺陷；durativeEnabled 门语义正常（有推导才写）。持续观察 |
| O4 | 批次窗口头部弱势嫌疑：session-e 提取实验中窗口前两条（书法/多肉）3 轮 0 命中，而生产轮它们被正常提取 | `extraction-loss-probe.mjs` runs=3 数据 | 与随机漏损假设不矛盾但方向存疑；并入 #5 游标/批次实证一并观察，不单独立项 |

以上观察均**不构成立即行动项**：机制门（证据/名额/守卫）均正常工作，波动面在 LLM 判定质量层。触发立项的条件：任一观察出现可复现的系统性模式（≥2 轮独立实证）。