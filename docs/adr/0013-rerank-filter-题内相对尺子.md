# ADR-0013 rerank filter 改用题内相对尺子（绝对 logit 门槛不可校准）

- 状态：接受
- 日期：2026-10-29
- 关联：#144（实施票，已实施）、#138（灰度复核）、#145（生产默认值）、ADR-0008（§F3 rerank 刻度校准化与降级）、ADR-0012（口径集中：一把尺子只能有一份实现）
- 落点：`MemoryCore/src/core/recall/rerank/filter-ruler.ts`（唯一实现）、`MemoryCore/src/core/hooks/auto-recall.ts`（selection）、`MemoryCore/src/config.ts`（解析归一）、`MemoryCore/scripts/analyze-r144-rerank-floor.mjs`（离线校准共用同一实现）

## 背景

`memory.recall.rerank.mode="filter"` 从 #99/ADR-0008 起只有一把尺子：`minScore`（provider 原始 logit 的绝对下限）。#144 的离线取样（90 题 longmemeval-oracle，997 条候选，gold 133 行）暴露两个事实：

1. **现网 `minScore=-10.5` 等于不筛**：全部观测分数落在 [−10.18, +10.28]，阈值在整个分布左侧 → filter 模式实际只靠 `candidates` / 预算（cap）在剪枝，门槛本身是 no-op。
2. **absolute floor 不可校准**：gold 行中位 0.115、噪声行中位 −6.302，AUC=0.836（有判别力）；但**题内分差**（top1−bottom）p10 3.5 / 中位 11.1 / p90 15.8 logit——题与题之间量纲平移达十几个 logit，任何单一绝对门槛必然「在紧题全杀、在松题全留」。收紧到能真正剪枝的位置就整题误杀：floor −7 误滤 15.8% 的池内 gold、−4 误滤 18.8%、−2 误滤 33.1%，且 −7 已有 4/90 题触发 ADR-0008 §F3 的「全员低于阈值」降级（整题回退未重排）。

同一份取样里，**题内相对尺子**在相近的保留比例下明显少误杀，且 top-k 组成更好：

| 规则（保留比例 ≈37%） | 误滤 gold | 丢弃的题内噪声行 | turnCov@5（模拟） |
| --- | --- | --- | --- |
| floor −7 | 15.8% | 590 | 84.1% |
| margin 8（相对 top-1） | 10.5% | 606 | 88.9% |
| quantile 0.5（题内分位） | 12.8% | 598 | 87.4% |
| 不筛（基线） | 14.3%（cap 截断） | — | 86.4% |

实跑配对（同库同旗标，每档两次）复现了方向：quantile 0.5 两次 81.1%/81.6% vs 基线 79.3%/79.9%（+1.2~2.3pp，session_cov 稳定 94.0%）；margin 8 turn_cov 打平（79.9%）但 MRR 0.735→0.770/0.776、nDCG→0.762/0.767、注入行 2.93 vs 3.58（块字符 274k vs 336k）；floor −7 实跑 80.5% 但出现 4/90 整题降级，floor −8.5 实跑 79.9%（≈不筛）。

## 决定

1. **filter 模式增加两条题内相对尺子**，与 absolute floor 并存（config-first，缺省仍是 floor）：
   - `filterRule: "floor" | "margin" | "quantile"`（缺省 `floor`，即旧行为逐位不变）；
   - `filterMarginTop`（margin 的 logit 差值，缺省 8）：保留 `score ≥ top1 − marginTop` 的候选，**并列临界值保留**（宁可多留）；
   - `filterKeepRatio`（quantile 的保留比例，缺省 0.5，clamp (0,1]）：按题内分数保留 `ceil(n × ratio)` 条，下限 1。
2. **相对尺子下 `minScore` 不参与判定**（两把尺子不互相盖）；`floor` 分支语义与降级（`degraded:"all-below-minScore"`）完全保留。
3. **保序**：两条尺子都只决定「保留谁」，输出仍按候选原序（filter 语义），不引入新的排序信号。
4. **单一实现**：`filter-ruler.ts` 是唯一真相源——生产 selection、config 归一、离线校准脚本共用 `relativeKeepIdxSet` / `normalizeRerankFilterRuler`（ADR-0012）。离线按曲线选参数与线上判定必须是同一把尺子，否则调参结论不成立。
5. **观测可归因**：journal/dump 的 `gates.rerank` 增 `filterRule` + 当前生效尺子的参数 + `passCount`（规则裁量后的条数，cap 之前）。`kept` 含预算截断，二者之差 = 预算剪掉的量，不能混为一谈。
6. **生产建议维持重排**（#145：rerank 开 + `candidates=32` + `minScore=-10.5`）；filter 只作为**安全降级档**，取值 `filterRule="quantile", filterKeepRatio=0.5`（首选，与 provider 刻度无关）或 `filterRule="margin", filterMarginTop=8`（次选，换 provider 后需重估）。**禁止**把 floor 收紧到 −9 以上。

## 理由

- **绝对门槛不是「更严格」，而是「按题随机误杀」**：题内量纲平移大于任何可用阈值，收紧绝对 floor 等价于对小分差题整片丢弃——这正是 #144 里「开关本身有益、用法错了」的那部分。
- **尺子决定分布位置，不决定信息量**：AUC=0.836 说明分数有判别力，问题在于如何把「题内相对位置」翻译成保留决策；margin 与 quantile 是这条翻译的最小充分形式（一个常数 / 一个比例）。
- **quantile 与刻度无关**：分母只数已评分候选，provider 换版/换家不改语义；margin 仍以 provider 原生刻度为单位，换 provider 要重估（注释已纠偏，不再声称「天然免疫」）。
- **不靠关开关取胜**：全档都保持 rerank 开启；修的是 filter 的判定口径，而不是把 rerank 或 filter 关掉。
- **config-first**：缺省 `floor` 让既有部署逐位不变（有单测钉住），新尺子只能显式配置启用。

## 后果

- **配置面**：三个新键只能写 yaml `memory.recall.rerank.*`；`gateway/settings-override.ts` 的 `RerankSettingsOverride` 尚不认 `mode/blend/filterRule`（未知键静默忽略），管理台可调需另开票扩 schema + 校验 + 页面。`deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 的 rerank 块也未含这些键。
- **行为不变性**：`mode≠filter` 时 `filterRule` 静默忽略（`filterRuler` 回落缺省），不改变重排/融合路径。
- **降级信号只服务 floor 族**：相对尺子分支不赋值 `degraded`（它不会「全杀」——quantile 至少留 1 条、margin 至少留 top1），监控应看 `passCount`/`kept`，不要把 `degraded==0` 当作相对尺子健康的证据。
- **回归保护**：`__tests__/filter-ruler.test.ts`（7 例，归一 + 裁量边界）+ `auto-recall-rerank.test.ts` 的 #144 五例（转储两例、margin、quantile 保序、provider 截断漏排、margin 临界并列）。
- **文档与数据**：`docs/optimization-results.md` §19（floor 14 档 / sigmoid / margin / quantile 全表 + 两跑配对）；离线脚本 `scripts/analyze-r144-rerank-floor.mjs` 可复现全部曲线（`node --import tsx`）。

## 被否决的选项

- **只调 `minScore` 数值**（−7/−8.5/−12）：−12/−10.5 是 no-op（分布在阈值右侧），−7 起整题误杀与降级并发；数值调参救不了量纲漂移。
- **sigmoid 概率阈值**（p=0.2/0.3/0.5）：与 floor 单调等价，只是换了刻度单位，误杀率照样 32.3%（p=0.1）~57.9%（p=0.7）。
- **分数归一后再用绝对门槛**（按题内 min/max 拉伸到 0..1 再比 0.5）：等价于 quantile 的粗糙版，且对离群分数敏感；直接按分位/差值更直接、可解释。
- **关闭 filter 模式或关闭 rerank**：回避问题而非修复（用户约束明确否决）。
- **把尺子实现散落在 config / auto-recall / 离线脚本三处**：三份实现必然漂移，离线调参会对不上线上判定（ADR-0012 的教训）。
