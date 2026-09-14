# 结构感知召回 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
**Goal:** 记忆召回接入全部结构资产（R1-R6/R8/R9 九通道）+ 性能速赢（E1-E3），检索质量语义零变化。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-10-structure-aware-recall-design.md`（执行者与 spec 同读；§1 utilization 矩阵、§3 不变式、§5 验收）。
**Tech Stack:** MemoryCore (memory-search.ts 咽喉 / auto-recall.ts / sqlite.ts / config.ts)、MemoryCore verify 脚本。

## Global Constraints
- **不变式（§3）**：绝对门槛/gatedVec/RRF 融合/租户隔离/T2 门/降级标注零变化；全部新通道作用于门后排序层与候选池层
- **关断矩阵是回归主保证**：每个 boost 默认值见 spec §2；**每个通道独立可配、置 0 时与基线排序逐位一致**（逐通道断言）
- 通道确定性：同 query 同数据同结果（无随机/无时钟依赖进入排序——last_recalled_at 读取在排序时快照）
- 推理验证先行（报告前节：数据流/消费方穷举/关断证明）；MemoryCore tsx 直跑 + verify 脚本；vitest
- 不碰 D:/tdai-data/生产进程（收口队长统一）；不派生子代理；tdai-gateway.yaml（UTF-8）不碰
- auto-recall 与 executeMemorySearch 两个排序点都要覆盖（C5 教训：只改一处=另一处静默不一致）

---

## Task R-A1: 排序层信号 R1/R2/R3/R8/R9 + config 十开关
**Files:**
- Modify: `MemoryCore/src/core/tools/memory-search.ts`（applyCoreRefTiebreak 扩展为 rankContext 组装或并列信号）、`MemoryCore/src/core/hooks/auto-recall.ts`（同层对齐——C5 教训）
- Modify: `MemoryCore/src/core/lifecycle/feeling/appraisal.ts`（如 mood 信号来源需暴露 fired valence 均值——先 grep 现有形状）
- Modify: `MemoryCore/src/gateway/config.ts`（memory.recall 下新增：timeBoost/recencyBoost/sigWeight/inferredPenalty/reinforcementWeight/moodBoost，默认值见 spec §2，0=关）
- Create: `MemoryCore/scripts/verify-ra1.ts`
**Interfaces:**
- Produces: `buildRankContext(query, items, opts): { firedValues, timeWindow, moodSign }`（R-A2 复用）
- Consumes: 条目顶层 soul 字段 + metadata（896ee5d 出参已透传）；listValues（E2 后走缓存）
**Steps:**
- [ ] RED：五通道逐个断言（时间窗命中→位次前移/significance 排序/inferred 降权/recall_count 对数加成/mood 对称偏置）+ **关断矩阵**（全 0 → 与基线逐位一致）
- [ ] R1：query 时间线索解析器（"上周/最近/N 天前/昨天"→ 窗口；解析失败=null）——纯函数放 soul-utils 同级或 recall-signals.ts，vitest 直测
- [ ] R1 时近性：last_recalled_at < 24h → recencyBoost
- [ ] R2/R3/R8：rankKey 追加对应分量（与 coreRefBoost 同位置；inferred 用乘法 penalty）
- [ ] R9：moodSign 从当前轮 fired valence 均值符号；moodBoost 默认 **0**（spec：默认关）
- [ ] config 十开关解析（clamp+默认值，沿 C1 coreRefBoost 模式）
- [ ] 同形验证：临时库+hashEmbed+真数据流——每通道单独开/全开/全关三态断言
- [ ] Commit: `feat(memory): R-A1 排序层结构信号 — 时间/significance/置信度/强化闭环/mood 弱偏置（关断矩阵钉死）`

## Task R-A2: 候选池通道 R4/R5/R6
**Files:**
- Modify: `memory-search.ts`（候选池扩展段——gatedVec 之后、RRF 之前的插入点先穷举论证）、`auto-recall.ts`（同层）、`sqlite.ts`（getNeighbors 复用+coreRef 反查查询）、`config.ts`（graphMinStrength/graphDiscount/valueBoost/sceneBoost）
- Create: `MemoryCore/scripts/verify-ra2.ts`
**Interfaces:**
- Consumes: R-A1 buildRankContext
- Produces: 候选池标注 `{graph:kind}` / 反查补池通道
**Steps:**
- [ ] RED：三通道断言（一跳邻居折扣入池+seen 防环/反查补池触发条件=结果数<limit 一半/场景名命中加权）
- [ ] R4：命中记忆 getNeighbors(strength≥graphMinStrength) → 邻居以 score*graphDiscount 入池 + `[graph:kind]` 标注 → 一跳限深/候选上限 +10/T2 门照常
- [ ] R5 升级：结果数 < limit 一半时 → fired 锚 label 反查 coreRefs 匹配记忆补池（valueBoost 加成）
- [ ] R6：query 含 scene_name 精确/前缀命中 → 场景记忆 sceneBoost
- [ ] 陪审团核对：T2 门/租户过滤（getNeighbors T14 filter）在扩展路径照常
- [ ] Commit: `feat(memory): R-A2 候选池通道 — 图一跳/价值反查补池/场景路由`

## Task R-A3: 性能速赢 E1/E2/E3
**Files:**
- Modify: `memory-search.ts`/`auto-recall.ts`（E1 embedding 60s TTL Map 缓存——key=query 文本，命中免外呼）、`sqlite.ts`（E2 listValues 租户级缓存 + 失效钩子：upsertValue/deleteValue/deriveValueValences/restoreValueValences 全部失效点——**穷举**）、`auto-recall.ts`（E3 同 session 相邻轮 query 相同 → 复用注入块 TTL 5min）
**Steps:**
- [ ] E2 先行（失效点穷举是 E1/E3 的模板）：缓存结构/失效穷举/断言（读两次一次 DB/写后失效/derive 后失效）
- [ ] E1：TTL 缓存 + 命中统计日志（debug）
- [ ] E3：同 session 上轮 query 与本轮全等 → 复用（不做模糊匹配——确定性）
- [ ] 全部可配开关（默认开，0/TTL=0 关）
- [ ] Commit: `feat(memory): R-A3 性能速赢 — embedding TTL 缓存/values 缓存/会话复用`

## 收口（队长）
- [ ] 全量 verify + MemoryProxy vitest + 记忆页真实数据冒烟（369 条排序抽检对比）
- [ ] 重启网关 + Proxy → 生产冒烟
- [ ] CHANGELOG + spec 状态更新

## Self-Review
- Spec §2 九机制：R1=R-A1、R2=R-A1、R3=R-A1、R4=R-A2、R5=R-A2、R6=R-A2、R8=R-A1、R9=R-A1、R7=未含（单独讨论）✅
- E1-E3=Task R-A3 ✅；关断矩阵=每任务 RED 套件 ✅
- 两排序点（咽喉+auto-recall）每任务都覆盖 ✅
