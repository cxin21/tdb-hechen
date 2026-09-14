# 结构感知召回（Structure-Aware Recall）· 设计

> 文档标识：DS-RECALL-STRUCTURE-AWARE-001
> 版本：v1.0（用户经三轮追问收敛：机制集 R1-R6+R8+R9；R7 单独讨论）
> 日期：2026-09-10
> 方法论：taste-skill §11 重设计协议（preserve 档）+ 方案决策框架 + 渐进式披露原则

---

## 0. 设计读（Brief Inference）

> 一句话：当前召回是工程优秀的**通用检索**；本设计把已存储但召回不消费的结构资产（时空/价值/图/场景/置信度/强化信号）变成一等检索信号——**检索质量语义（绝对门槛/宁缺毋滥）零变化，变化的是"什么进入候选池、如何排序"**。

拨盘：DESIGN_VARIANCE 2/5（只加信号不改形态）｜MOTION 不适用｜VISUAL_DENSITY 维持。

## 1. 结构利用率矩阵（设计前→设计后）

| 字段 | 写入 | 展示 | 遗忘 | 感受块 | 召回（前） | 召回（后） |
|---|---|---|---|---|---|---|
| occurred_at/valid_start/end | ✅ | ✅ | ✅ | — | ❌ | 🔧 R1 |
| significance | ✅ | ✅ | ✅ | — | ❌ | 🔧 R2 |
| certainty/source | ✅ | ✅ | ✅ | — | ❌ | 🔧 R3 |
| l1_links(+strength) | ✅ | ✅ | — | — | ❌ | 🔧 R4 |
| metadata.coreRefs | ✅ | ✅ | ✅ | ✅ | ⚠️tiebreak | 🔧 R5 升级 |
| scene_name | ✅ | ✅ | — | — | ❌ | 🔧 R6 |
| recall_count | ✅ | ✅ | — | — | ❌ | 🔧 R8 |
| last_recalled_at | ✅ | — | ✅ | — | ❌ | 🔧 R1 |
| valence | ✅ | ✅ | ✅ | ✅ | ❌ | 🔧 R9（弱偏置，默认关） |
| arousal | ✅ | ✅ | ✅(共线) | — | ❌ | ⚪ 维持不用（与 significance 共线，重复计权；登记裁决） |
| part_of 证据链 | ✅ | ✅ | — | — | ❌ | 🔧 R7（单独讨论） |
| 已归档 | — | ✅ | — | — | ❌ | ⚪ "不可召回"即遗忘语义 |
| session_id/version | 隔离/簿记 | — | — | — | — | ⚪ 非检索信号 |

## 2. 机制规格

### R1 · 时间感知（时间窗 + 时近性）
- query 时间线索解析（"上周/最近/昨天/N 天前"→ [start,end] 窗；正则+相对锚点，宁缺毋滥：解析不出窗口=无时间信号）
- 窗口内记忆（occurred_at ∈ 窗 ∪ valid 区间相交）→ rankKey + `timeBoost`（tiebreak 量级，默认 0.05）
- 时近性：`last_recalled_at` 距今 < 24h → +`recencyBoost`（默认 0.03）
- 可配：`memory.recall.timeBoost/recencyBoost`（0=关）

### R2 · significance 进排序
- `+ significance * sigWeight`（默认 sigWeight=0.03，可配）——重要性首次参与召回排序

### R3 · 置信度分层
- inferred 记忆 rankKey `* (1 - inferredPenalty)`（默认 penalty=0.1，可配 0=关）；source 归并入同层

### R4 · 图一跳扩展
- 命中记忆的 l1_links 邻居（strength ≥ `graphMinStrength` 默认 0.5，causal/evolve 优先排序）→ 以 `score * graphDiscount`（默认 0.6）进候选池，标注 `[graph:causal]`
- 一跳限深、环安全（seen）、候选池上限（默认 +10）；T2 门照常适用

### R5 · 价值驱动召回（升级现有 tiebreak）
- 当前轮 appraisal fired 价值 → coreRef 匹配记忆从 +0.05 tiebreak 升级为**检索通道加权**：候选池内匹配者 `+ valueBoost`（默认 0.05，维持）+ **召回不足时（**R4 扩池前的主检索结果数** < limit 一半——扩池条目永不改判，批2审查 #1 固化）追加一次 coreRef 反查**（listValues fired → 按锚 label 匹配 coreRefs 的记忆补池）

### R6 · 场景路由
- query 命中场景名（scene_name 精确/前缀匹配，宁缺毋滥：不命中=无信号）→ 该场景记忆 `+ sceneBoost`（默认 0.04）

### R8 · 强化闭环
- `+ log10(1 + recall_count) * reinforcementWeight`（默认 0.03，对数缩放防马太效应）
- **闭环意义**：T4 写入累加 → C1 展示 → 本机制排序消费——"越常想起越容易想起"

### R9 · mood-congruent 弱偏置（默认关）
- 当前轮感受块 fired valence 的均值符号 → 召回候选中同符号 valence 记忆 `+ moodBoost`（默认 0，开启建议 0.03）
- **对称加权**（正负都偏）、弱 tiebreak 量级、`memory.recall.moodBoost` 配置（默认 0）
- **黄灯登记**：mood-congruent 的病理面是情绪螺旋——观察到"坏心情只想起坏记忆"即关闭；认知依据 mood-congruent recall

### R1 边界口径补注（R-A1 审查 M-4，S7 第 5 项统一）
- 时间窗统一**半开 [ws, we)**：occurred_at ∈ [ws, we)；valid 区间覆盖窗内至少一点即相交——valid_end 语义"至该点仍成立"，起点判 `e >= ws`（与 occurred 的 `>= ws` 同口径），终点判 `s < we`。

### §2 附 · 设计债登记（S7 择机批落档）
- **rrf 量纲失配（R-A1 审查 M-3）**：auto-recall 层 rrf 相邻差 ≈2.8e-4，boost 0.05 在该空间为主导量级——两路名义对齐、实际权重不对等。改 rrf 常数/加归一化前先复核两路排序稳定性。
- **R5 反查索引策略（R-A2/A3 concern ④）**：coreRefs 反查（LIKE 预筛）在百万级记录下需评估索引策略（当前全表 LIKE 语义不变；规模化前重审，必要时 FTS5 侧建辅助倒排）。

## 3. 不变式（红线）

1. 绝对相关度门槛语义零变化（所有 boost 在门后排序层/候选池层，不越门）
2. 租户隔离、T2 门、降级标注零变化
3. 检索稳定性：全部新通道**确定性**（同 query 同数据同结果），无随机
4. 失效即关：每个 boost 独立可配，0=该通道完全退出（R3 教训：机制不被触发=死代码，机制被触发但可关=可控）

## 4. 性能伴随（同批）

E1 query-embedding 60s TTL 缓存（同轮多路归一）｜E2 values/appraise 租户级缓存（upsert/delete/derive 失效）｜E3 同 session 相邻轮 query 相同 → 复用注入块（TTL 5min）——性能优化不碰检索语义。

## 5.1 锚生命周期与绑定的语义裁决（2026-09-11，用户实测追问后裁定）

1. **挤出/否决后的绑定处理**：记忆 metadata.coreRefs 存锚 label 引用——锚被挤出（retired）/否决（vetoed）后离开 listValues active 集，valueBoost 匹配与反查**自然不再命中（引用变惰性）**：不崩溃、不误加权、无需清理 800 条 metadata（写放大 churn 否决）。同 label 锚恢复/重新采纳 → 绑定**自动复活**。惰性由结构保证（匹配遍历 listValues active 结果，GROW 37 断言已钉 retired/vetoed 排除）。
2. **锚的 agent 绑定边界**：~~core_values 三元组租户隔离（T12）；发现/自生长语料采样限 default 桶（GROW 已堵跨租户泄漏）。**边界语义 = 团队级共享锚（default 桶）+ per-agent 覆盖层**（SEC-1 兜底：agent 有自己的锚用自己，没有兜底看共享）——严格 per-agent 自生长（每 agent 一套发现循环）登记为后续可选项，默认不采（N 倍 LLM 成本、锚集碎片化）。~~
   **⚠️ 本条已于 2026-09-11 被用户推翻（commit 9418639，PA 审查 I-2 闭合）**：价值锚改 **per-agent 严格独立，不做团队共享**——SEC-1 兜底移除（无锚=空）、default 锚扇出迁移至各 agent 桶（5 agent × 6 锚 loud 实证）、自生长/挤出/否决/恢复全部按 agent 隔离、verify-pa 四场景×双 agent 隔离断言。生产已激活。
3. **对用户可见的承诺**：删锚=永久否决（veto 永不重提）；退休=可恢复可钉住；自生长锚带来源徽标。
## 5. 验收

- **回归三重保证**：①关断矩阵——每个 boost=0 时与基线排序逐位一致（逐通道断言）②新增通道专项断言（时间窗解析/一跳扩展/反查补池/强化闭环）③既有 verify 全量（p0-t2 门/p3-t15/s5/c1 排序）不回归。（更正：原写 golden replay——那是 **wiki 召回**的归档设施，记忆召回无 golden harness，以关断矩阵替代）
- 单元：时间窗解析（上周/最近/N天前/无效输入）/boost 排序位次/关断矩阵（每个 boost=0 时与基线逐位一致）
- 性能：E1-E3 生效后单轮召回延迟基线对照
- 真实数据冒烟：369 条记忆上的排序对比抽检
