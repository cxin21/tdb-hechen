# 召回 golden 评测集（spike 基线测量）

目的：把"召回准不准"从感觉变成数字，用于：
1. 量化**当前系统基线**的 over-recall（spike 交付）。
2. 后续在用 4.6（融合/门控/过滤）调参时做回归门。

## 基线事实（2026-09-08 实测，生产 RRF 检索 / 10.4.100.30:8421）

对 q1/q2/q3/q4/q6 共 5 条 query，逐库 `search(limit=5)` 采集 top-5：

| 库 | 相关命中 / 采样项 | Precision@5 |
|---|---|---|
| Standards | 0 / 25 | **0%** |
| AgentSkill | 0 / 25 | **~0%** |
| Coding | 1 / 25（q1 方案决策框架 0.6） | **4%** |

**关键实证（三项病根全中）：**
1. **跨库：真相关被跨库噪音压掉** —— q1"设计方案是否最优"在 Coding 实际能召回"方案决策框架"(0.6, 真相关)，但合并注入时会被 Standards 的"性能评审/字段命名/接口场景化"（0.4~0.8 撞词）稀释。→ 印证 [②] 元数据/库过滤。
2. **撞词** —— q2"rerank 接口"在 Standards 全返回"OpenAPI/领域服务/万能接口/接口场景化"，字面无外一个"接口"。→ 撞词 over-recall。
3. **entity 硬编码高分** —— "复合语义模型/报表语义模型"search 里即返 `1.000`。→ 印证 [③] entity 降级。

> 注：本检索工具返回真实 RRF 分（0~1），与 `tdai_recalled_wiki` 布告的硬编码 1.00 部分重叠——entity 精确命中确为 1.000。

**正例 Recall（同库对题，实测）**：p1–p12 正例在各**对应库**内检索：

| 正例 | 库 | 应召回 | 命中 | Recall@5 |
|---|---|---|---|---|
| p1 暂估应收回冲 | Coding | 3 | 3 | 1.0 |
| p2 万能接口服务 | Standards | 2 | 2 | 1.0 |
| p3 报表 top 上限 | AgentSkill | 1 | 1 | 1.0 |
| p4 金额双口径 | Coding | 2 | 2 | 1.0 |
| p5 N+1 查询禁令 | AgentSkill | 1 | 1 | 1.0 |
| p6 出库暂估回冲触发 | Coding | 2 | 1~2 | ~0.7 |
| p7 临时表中转 | Coding | 3 | 3 | 1.0 |
| p8 跨模块接口规范 | Coding | 2 | 2 | 1.0 |
| p9 尾差精度 | Coding | 3 | 3 | 1.0 |
| p10 Begin/End 差量 | Coding | 3 | 3 | 1.0 |
| p11 数据库分库 | Standards | 2 | 2 | 1.0 |
| p12 权限与安全 | AgentSkill | 4 | 4 | 1.0 |

**负例/元/无关 query（q2,q4,q6,q7,q8）在 3 库合并下的 Precision@top≈0**（q8"买笔记本"能在 Coding 召回"聚合弹窗语义局限"、Standards"复合语义模型"、AgentSkill"SqlBuilder"——全无关仍 0.6/0.4 顶分）。

**→ 重大定性修正（扩集后更清晰）：引擎的同库对题检索很好（Recall@5≈0.95）**；真正的病根是召回**注入侧**：
1. **跨库污染**：3 库合并不按 query 域定库 → 无关库高分噪音掺入稀释。
2. **hop>0 图扩展**：无字面支撑仍把图邻居拽成 1.00。
3. **元/无关 query 仍硬注入**（宁缺毋滥缺失）+ **分数池内相对**（min-max/RRF 让无关顶分 0.6/1.0，绝对门控本可挡掉）。

**修正方案重测（模拟库过滤 + 绝对门控）量化增益**：
- 正例集（p1–p12）：库过滤**不伤害 Recall**（本就只在该库查）→ 仍 0.95。
- 负例/无关集（q2,q4,q6,q7,q8）：定域 + 绝对门控把这些**不注入**（当前却各注入一堆 0.6~1.0 噪音）→ 注入 Precision 由 ~0 提升到"有真相关才注入"（元/无关类恒为安全空）。
- 结论：最高杠杆 = **[②]库过滤/定域 + [召回限流 hop>0] + [①]绝对门控（宁缺毋滥）**；[③]entity 降级次之；**融合非主缺口**（同库已 0.95）。

## 使用法

- `queries.jsonl`：每行一条 `{id, query, domain, should_recall[], should_not_recall[]}`。
- `should_recall`：与 query 语义相关的条目（path 或 id 均可）。
- `should_not_recall`：管线常误召、应被门控/降级挡掉的条目。
- 指标：Precision@k（注入候选里相关占比）、Recall@k、MRR；另计"跨库误召数"。

## 修复后（已实现管线 + golden 调参回归，2026-09-08）

`replay.mjs` 用**线上引擎数据**复跑整份 golden，内存扫参数组合（typeWeights×relGate×absGate×domainRouter）：

| 配置 | posRecall | negInjected |
|---|---|---|
| 基线库内对题（仅检索目标库） | 0.95 | — |
| A 初版生产(type0.8/rel0.7/无router) | 0.63 | 9 |
| **B 已部署(concept0.9/rel0.6/router on)** | **0.79** | **10** |

- **absGate 1.5 校准**：相关命中 absScore≈2.0+、噪音≈1.19~1.44，鸿沟清晰。
- **杠杆排序被数据确认**：类型降权 + absGate 压噪音；跨库软定域 boost 业务正例、往回补 Recall；但**合并3库+门控有固有取舍**——最优 Recall 0.79 < 库内 0.95，噪音非 0。
- **已部署**：`typeWeights{entity:.6,concept:.9}`、`minInjectAbsScore:1.5`、`minInjectNormScore:0.6`、`domainRouter(boost1.5+三库领域词)`。

## 当前状态

- [x] 基线：生产 RRF 检索实测（q1–q8 负例/元 ×3库 Precision≈0；p1–p12 正例同库 Recall≈0.95）
- [x] 最高杠杆被实测支撑：库过滤/定域 + 召回限流 hop>0 + 绝对门控（宁缺毋滥）
- [x] golden 集含正例（Recall）与负例（Precision）双覆盖，作为回归门
- [x] 落地后在同一 golden 集回归对比（同库 Recall 不得退化、跨库/图噪音 Precision 上升）
  → 2026-09-09 起 golden harness 修复并可复跑，见下方复核小节；归档目录 `runs/`。

## 2026-09-09 复核（golden harness 修复 + 首次归档锚点）

> 诚实纪律：以上历史数字**原样保留**（时点快照）。本节是修复后的重新实测，
> 数字与上文并存、不互相覆盖。上方 0.63→0.79 为 09-08 时点结果，当日未归档
> 逐 query 快照、语料指纹，且 `replay.mjs` 存在键名错位（见下），**今日不可复现**，
> 归因请以本节归档锚点为准。

**本次修复（W1b①②/W6，replay.mjs v2）：**
1. **router 键名统一**（W1b②）：v1 的 `LIBS` 键（`Coding`/`Standards`/`AgentSkill`）与
   `router.keywords` 键（`Coding-WiKi`/…）错位 → router 在评测脚本里**恒 no-op**
   （生产按 `w.name`="Coding-WiKi" 匹配所以生效）。v2 顶部 `WIKI_NAMES` 常量统一键名源，
   并在脚本内校验：router 启用时键名必须 ⊆ WIKI_NAMES，否则抛错（防回归钉）。
   **因此 v1 的 "router 带来提升" 归因不被已提交脚本支撑**（v1 的 B vs A 差异实为
   tw/relGate 参数差异）。
2. **GOLDEN 运行时读取**（W6）：v1 硬编码 18 条漏 p6；v2 直接解析 `queries.jsonl`
   全部 19 条，`should_recall` 完整读入（29 个正例项口径）、`should_not_recall` 生效。
3. **匹配形态归一**：golden 条目是文件名 slug（`报表-top-上限`），引擎 title 是人读
   形态（`报表 top 上限`）→ 匹配前两侧小写 + 去分隔符（`- + / 空格`），否则系统性
   假阴性（实测 0.31~0.41 的假低值即此 artifact）。
4. **`--archive` 归档模式**（W1b①）：`node replay.mjs --archive` 输出
   `runs/<ISO时间>.json`（gitSha / scriptVersion / 语料指纹 / 每配置逐 query 快照 /
   metrics）。**纪律：每次调参必须 `--archive` 归档后再引用数字**——无归档的数字
   视为未发生。语料指纹含 golden 文件 sha256 与本轮逐库检索快照哈希（远端语料
   本体不可 stat，用检索快照锁定归档时看到的语料状态）。

**09-09 实测锚点**（引擎 10.4.100.30:8421 实时数据；归档
`runs/2026-09-09T19-43-25.json`（**v2 脚本首个锚点**，gitSha `2357b09`），golden 19 query / 29 正例项 / 20 负例项）：

| 配置 | posRecall (29 口径) | negInjected | notRecallHits |
|---|---|---|---|
| A cur-prod(type0.8/rel0.7/无router) | 0.55 (16/29) | 11 | 0/20 |
| **B 已部署(concept0.9/rel0.6/router on)** | **0.66 (19/29)** | 13 | 0/20 |
| C (concept0.9/rel0.7/router on) | 0.62 (18/29) | 13 | 0/20 |
| D (concept0.9/rel0.5/router on) | 0.69 (20/29) | 17 | 0/20 |

- **数字口径变化**：分母 29 = `queries.jsonl` 全量 `should_recall`（v1 脚本手工裁剪
  为 19 项）；`should_not_recall`（20 项）首次参与 precision 断言——词表口径 0 误召
  （20 负例项均未命中词表）；但实际噪音注入 11-17 块/轮（负例词表未覆盖的含元页）。
  fix1（replay v2.1）起该指标升级为**失败门**：任一配置 notRecallHits > 0 即
  FAIL+exit 1（见下方 fix1 小节）。
- **与 09-08 的 0.79 不可直接对比**：分母口径不同（19 vs 29）+ 键名修复后 router
  实际生效 + 归一匹配消除假阴性。B 配置 0.66 与 0.79 的差值含真实成分（q1 方案
  决策框架、p6 出库暂估回冲、p9 先进先出尾差处理/尾差校准机制、p10 双阶段模式、
  p11 分库同步、p12 登录与租户鉴权机制/权限与安全规范当前未注入）与口径成分，
  逐项见归档 perQuery。
- 结论（**fix1 归因更正**，隔离实验实证）：tw09+rel0.6 优于 tw08+rel0.7；B 相对 A
  的差值全部来自 tw08→tw09 + rel0.7→0.6 参数差，router 单变量在部署工作点（rel0.6）
  对 recall 无贡献、只增噪音（negInjected 恒 +2）——router 存废/权重作为独立调参
  变量另行归档后再议（隔离数据见下方 fix1 小节）。rel0.5 (D) recall 最高但
  negInjected 也最高（17 vs 13），宁缺毋滥取舍仍在。

## 2026-09-09 复核修补 fix1（审查 I-1~I-4，replay v2.1）

> 诚实纪律：上节锚点数字原样保留（时点快照）。本节登记 fix1 修补内容与新锚点。

1. **I-1 归因更正（隔离实验实证）**：3 对 router on/off 镜像配置隔离实跑
   （tw08/rel0.7、tw09/rel0.7、tw09/rel0.6）：tw09+rel0.6 无 router 镜像 = **0.66**，
   与 B（0.66，router on）完全相同——B 相对 A（0.55）的差值全部来自参数差；三对
   negInjected 均 +2（11→13）。精确表述：部署工作点（rel0.6）router 对 posRecall
   单变量贡献=0；rel0.7 镜像对中 +1~+2 但同样恒 +2 噪音。**勿再以"router 带来提升"
   归因**。
2. **I-3 notRecallHits 升级失败门**：任一配置 notRecallHits > 0 → 输出 FAIL 明细 +
   exit 1；`--archive` 归档 JSON 顶层新增 `passed: bool`。红向验证：强制 passed=false
   实跑，FAIL 明细/归档字段/exit 1 全部生效后删除红向归档。
3. **M-3 hit 字段拆分**：逐 query 快照的 `hit` 拆为 `posHit`（正例命中，true=好）/
   `negRecalled`（负例误召，true=坏），不再一个布尔字段正负混读。
4. **I-4 注入器日志真降噪**：`wiki-recall-injector.ts` 逐轮 `console.debug`（Node 里
   它是 `console.log` 的别名，必然进 stdout——原"降 debug"实为假降噪）改走分级
   logger（`MemoryProxy/src/report/log.ts`，LOG_LEVEL_PRIORITY 过滤）；`per-wiki
   recall failed` 错误路径保持 warn 必打。
5. **I-2 锚点重归档**：v2 脚本首个锚点 `runs/2026-09-09T19-43-25.json`（gitSha
   `2357b09`，指向 v2.1 修补前的树）原样保留；fix1 修补 commit 后重跑 `--archive`，
   新锚点 `runs/2026-09-09T20-05-06.json`（gitSha=含 v2.1 脚本的树）。

**fix1 实测锚点**（引擎 10.4.100.30:8421 实时数据；归档
`runs/2026-09-09T20-05-06.json`）：四配置数字与上节锚点一致——A 0.55/11、B 0.66/13、
C 0.62/13、D 0.69/17，notRecallHits 0/20，`passed=true`。

## 2026-09-10 C3 router 默认退役（先归档后翻转）

> 诚实纪律：以上各节锚点数字原样保留（时点快照）。本节登记 C3（soul-memory
> trust-repair Task C3）——按归因纪律**先归档 router-off@部署参数锚点、再翻默认**。
> 前提偏差如实登记：brief 写"flip injection/index.ts 默认对象 `enabled: true→false`"，
> 实证 grep 后确认代码默认对象本就**没有** domainRouter 字段、`domainRouter` 也无
> `enabled` 开关（injector 只判 keywords 非空）——代码默认层原状即"缺省=关"，
> router 开着纯来自 config.yaml 部署镜像。故"翻转"落地为：**显式退役标记**
> （`defaultWikiRecallConfig.domainRouter = { boost: 1.5, keywords: {} }`，空表 =
> injector 恒 no-op，能力形状保留）+ config.yaml 整段注释退役
> （**不能写 `enabled: false`**——injector 不读该字段，是静默 no-op）。

replay.mjs 新增配置 **E (tw09 rel0.6, router off) = B minus router**（与 B 唯一差异
= router，同语料快照内成对对照）。

**锚点1（翻默认前，归档 `runs/2026-09-10T04-07-38.json`，gitSha `218440e` 树，passed=true）**：

| 配置 | posRecall (29 口径) | negInjected | notRecallHits |
|---|---|---|---|
| A cur-prod(tw08 rel0.7,无router) | 0.59 (17/29) | 11 | 0/20 |
| B (tw09 rel0.6, router on) | 0.66 (19/29) | 13 | 0/20 |
| C (tw09 rel0.7, router on) | 0.62 (18/29) | 13 | 0/20 |
| D (tw09 rel0.5, router on) | 0.69 (20/29) | 16 | 0/20 |
| **E (tw09 rel0.6, router off) — C3 锚点** | **0.66 (19/29)** | **11** | 0/20 |

**锚点2（默认态复跑，归档 `runs/2026-09-10T04-09-17.json`，passed=true）**：
A 0.59/12、B 0.66/14、C 0.59/14、D 0.69/17、E 0.66/12。

- **降 2 断言成立（两锚点均如此，同快照成对）**：B(on) − E(off) 的 negInjected
  差 = 2（13 vs 11；14 vs 12），posRecall 完全相同（0.66 = 0.66，19/29）——
  与 09-09 隔离实验（审查员 E/F 对照）结论第三次复现：部署工作点 router 对
  recall 单变量贡献=0、噪音恒 +2。
- **跨锚点漂移**：锚点1→2 全部配置 negInjected 统一 +1（引擎侧语料漂移，
  同快照内成对差值不受影响）；A 的 posRecall 0.55→0.59 为 09-09→09-10 语料
  演化，与 C3 无关（A/E 均无 router）。
- **默认退役落地**：`defaultWikiRecallConfig.domainRouter = { boost: 1.5,
  keywords: {} }`（显式退役标记 + 重开协议注释）；config.yaml domainRouter 段
  整段注释（关键词表留档于注释）。测试钉死：`wiki-recall-injector.test.ts`
  两条 C3 用例（TDD RED→GREEN）。
- **W4（boost→归一→注入门耦合）随退役消失**；重开 router 前必须
  (a) 先归档 router-on 实验 (b) 先解耦 W4（独立任务）。
