# 记忆指标（docs/ops/memory-metrics.md）

> 2026-11-02 起生效。P7（研究文档 §P7）落地的**唯一指标口径**：任何"记忆质量提升了"的说法，必须能用本文件的指标名 + 读数 + 采样口径复述，否则不算证据。
>
> 工具：
> - 纯函数层 `MemoryCore/src/core/metrics/memory-metrics.ts`（零 I/O，可被测试/离线复放器复用）
> - CLI 层 `MemoryCore/scripts/memory-metrics.ts`（`npm run memory:metrics`，**只读**打开 `D:/TDB/data/vectors.db`）
>
> 红线：CLI 以 `readOnly: true` 打开数据库，不 checkpoint / 不 VACUUM / 不写任何行；指标本身不产生副作用。

## 1. 命令

```bash
cd MemoryCore

# 缺省：读 D:/TDB/data/vectors.db 最近 2000 行 + 最近 10 个 journal 文件
npm run memory:metrics

# 常用
npm run memory:metrics -- --limit 800 --journal-files 6
npm run memory:metrics -- --since 2026-10-01T00:00:00Z --json
npm run memory:metrics -- --db D:/TDB/data/vectors.db --atomic-max-chars 600 --dup-threshold 0.90
```

| flag | 默认 | 作用 |
|---|---|---|
| `--db` | `D:/TDB/data/vectors.db` | 生产库（readOnly） |
| `--limit` | 2000 | 采样最新 N 行 `l1_records` |
| `--since` | 无 | 只算 `created_time >= ISO` 的行 / journal 条目 |
| `--journal-dir` | `D:/TDB/data/logs/recall` | 召回 journal 目录（JSONL） |
| `--journal-files` | 10 | 取 mtime 最新 N 个 journal 文件 |
| `--atomic-max-chars` | **跟随配置** | 原子性长度上限。缺省不写死数字：按 `--config`（缺省 `D:/TDB/data/config-override.json`）的 `extraction.atomicMaxChars` 取，经 `parseConfig` 同一 clamp（120..2000）；CLI 显式值优先，报告里标 `source=cli\|config-override\|default` |
| `--config` | `D:/TDB/data/config-override.json` | 读 `extraction.atomicMaxChars` 的 override 文件（缺失/损坏 → 回落 `parseConfig` 缺省并标 default） |
| `--dup-threshold` | 0.85 | 语义重复判定阈值 |
| `--dup-sample-limit` | 120 | 重复对采样行数上限（**随机采样**，不再取前 N 行） |
| `--sample-seed` | 20261102 | 采样种子（同种子可复现同一批行，跨日可比） |
| `--json` | 关 | 输出完整 JSON（归档 runs 用） |

## 2. 指标定义（L1 内禀）

| 指标 | 定义 | 目标方向 | 判据来源 |
|---|---|---|---|
| `total` | 采样行数 | — | — |
| `avgLen` | 平均 `content` 字符数 | 略升（原子化后单条更短但禁拆多断言） | §A3 |
| `selfNarrationRate` | agent 自述行占比。判定**只有一套**：`record/agent-narration.ts` 的 `isAgentNarration`（第三人称主体 = 谓语位置的 AI/助手/模型；第一人称 = 自指证据，或「我 + 已/了/过 + 执行类动作」；`我明天提交周报`、`我的笔记里写满了待办` 这类计划/领属句**不算**），`metadata.actor==="agent"` 精确优先 | **降** | §A3 |
| `actorLabeledRate` | **写侧标注**覆盖率：`metadata.actor==="agent"` 的行占采样行比。与 `selfNarrationRate` 并列——前者是"真被打了标签"（读侧过滤只认它），后者是"文本看着像自述"（启发式，可能误判）。两个数不可互相替代 | 观察项 | §A3 |
| `atomicityRate` | `len ≤ atomicMaxChars` **且** `claims == 1` 的行占比（`atomicMaxChars` 来自配置，见 §1；`parseConfig` 缺省 2026-11-03 起为 **600**，与 ADR 0023 校准值一致） | **升** | §A3 |
| `semanticDupRate` | 采样内近重复对占比，分母 = **真正比较过的对数** `compared=C(sampled,2)`（随机采样，`sampleIds` 自证） | **降** | §B4 |
| `factsCoverage` | 带 `facts`/`factTriples` 的行占比 | 由 A2 决定（通道模式要显著升） | §A2 |
| `churn` | **同期**翻台：`rate = archived/(archived+live)`；**分子分母都走 SQL 全表 COUNT**，窗口起点 `W = --since ?? 采样最老行 created_time`：`archived = COUNT(l1_archive WHERE archived_at >= W)`、`live = COUNT(l1_records WHERE created_time >= W)`。**分母不再用采样行数**（旧实现分子覆盖全表窗口、分母只是 2000 行采样，`--since` + 小 `--limit` 时失真最明显）。取不到窗口（空库）时 `live=null`、`rate=null`，**绝不回落成采样数**。报告同时打印 `archiveWindow{numerator,denominator}` 与 `sampling{sampledRows,totalRows,limitSource}` | 降（>50% 说明归档快于存留） | §B3/§B4 |
| `typeDistribution` | 各 `type` 行数 | 观察项 | — |

## 3. 指标定义（召回，来自 journal）

journal 条目字段来自 `auto-recall`：`selection.kept`（注入行数）、`selection.injectedChars`（注入字符）、`selection.poolChars`、`memoryLines`（**候选池**，不是注入行）。**本 CLI 的口径是 `selection.*`，绝不用 `memoryLines.length` 冒充注入。**

| 指标 | 定义 |
|---|---|
| `rounds` | **只数 `selection != null` 的轮**（没有 selection 的轮没有注入口径，进分母就是失真）。2026-11-03 起空池轮也会写 `selection`（`emptyPool=true`），所以 `rounds` 第一次覆盖到"整轮什么都没召回到"的场景 |
| `coverage` | 覆盖度单列：`{withSelection, withoutSelection, rate}`。`rounds` 的分母是 journal 总轮数，两者必须一起看 |
| `emptyPoolRounds` | 其中候选池为空的轮（`selection.emptyPool`）。这些轮**不是选线砍光的**，是召回本身没给东西 |
| `zeroInjectionRate` | `selection.injected == 0` 的轮占比（分母 = `rounds`，**含空池轮**）：回答"用户这一轮到底拿到记忆没有" |
| `zeroInjectionRateNonEmpty` | 同式，但分母只算非空池轮：回答"召回到了东西时，选线是否把它全砍掉"。两者不可混读——一个数是召回的病，一个是选线的病 |
| `injectedCharsP50` | `selection.injectedChars` 最近秩中位数 |
| `injectedCharsMean` | 均值 |
| `avgInjectedLines` | `selection.injected` 均值（**不再**拿候选池 `memoryLines.length` 除以轮数） |
| `poolAnchorRate`（recallPoolAnchorRate） | **候选池**行里含**可验证锚**的占比 —— `precisionScope="candidate-pool"`，代理口径，不是注入行精度，更不是人工标注精度。旧名 `precisionProxy` 同值保留并标 `@deprecated`（"precision"容易被读成注入行精度，实际取样面是候选池） |
| `anchorLines` / `totalInjectedLines` | 上式的分子 / 分母（候选池行数） |

**"可验证锚"的判定（F6③）**：日期 `YYYY-MM-DD` / 时刻 `HH:MM[:SS]` / `file:line`（`.ts/.tsx/.js/.mjs/.cjs/.json/.md/.yaml/.yml/.py/.java`）/ 短哈希（7–40 位十六进制且**必须含字母**）。**裸 `\d+` 不算锚**（旧口径把它算进去，precisionProxy 因此虚高）。

## 4. 基线读数

### 4.1 F5/F6 修正前的旧口径（2026-11-02T07:07Z，采样 800 行 / 888 轮）

> 旧口径的公式与已删代码一致（`churnRatio`、`memoryLines` 当注入、裸数字当锚、前 N 行采样、硬编码 300、两套自述正则）。下面这组数**只用于对照**，不可与新口径相减。

| 指标 | 读数 |
|---|---|
| avgLen | 135.2 |
| selfNarrationRate | 2.1%（17/800）；扩正则后 2.3%（28/1200） |
| atomicityRate | 53.3%（426/800）；1200 行采样 49.9%（599/1200） |
| semanticDupRate@0.85 | 0.0%（0 对 / 样本 120，jaccard-proxy） |
| factsCoverage | 53.0%（424/800） |
| churnRatio | 8.16（归档 6526 / 采样 800） |
| injectedCharsP50 | 0 |
| zeroInjectionRate | 95.0%（844/888） |
| recallPrecisionProxy | 92.6%（2353/2540） |

类型分布：`work_fact=63, episodic=542, instruction=141, persona=52, work_method=1, work_task=1`。

### 4.2 F5/F6 修正后（2026-11-02T09:17:16Z，全库 3927 行 / 采样 3913 行 + 18 个 journal 文件 2084 轮）

命令：`npx tsx scripts/memory-metrics.ts --limit 3913 --journal-files 20`（`--atomic-max-chars` 缺省跟随 `--config` → 读到 600）。

| 指标 | 分子 / 分母 | 读数 | 与旧口径对比（旧值用同一 3913 行窗口复刻探针重算） |
|---|---|---|---|
| `selfNarrationRate` | 947 / 3913 | **24.2%** | 旧 agent-narration 374/3913=9.6%（AI 组 **0/535**）；旧 metrics 第二套正则 227/3913=5.8% → 两套口径并集 586 行、交集仅 17 |
| ├ AI 主语 | 194 / 534 | 36.3% | **0.0%** → 非零，F5 目标达成（未命中的 340 行多为「AI 给出的…／AI 在交付中自曝…」等非动作词形态，宁缺毋滥） |
| ├ 我 主语 | 713 / 813 | 87.7% | 362/813（旧） |
| └ 助手 / 模型 主语 | 0 / 0 | — | 生产库暂无以此开头且带动作词的记录（形状用例在单测里覆盖） |
| `atomicityRate` | 1291 / 3913 | **33.0%** | 旧公式 @300 = 81.5%；差异主要来自 `atomicMaxChars` 300→600（配置值，来源 `config-override`） |
| `semanticDupRate` | 0 对 / 7140 对 | 0.0% | 旧=0 对/7140（前 120 行切片）→ 同值，但分母现在自证是 C(120,2) 全比较（seed 20261102） |
| `factsCoverage` | 495 / 3913 | **12.7%** | 800 行样本 53.0% → 采样面不同（全库含大量无 facts 的存量行） |
| `churn` | 6483 / (6483+3913) | **62.4%** | 旧 `churnRatio`=6529/3913=1.67（分子全表、分母采样，量纲不一致）；窗口 from `2026-10-14T07:22:22.944Z` |
| `recall.injectedCharsP50` | — | **406** | 旧 0（被无 selection 的轮压成 0） |
| `recall.zeroInjectionRate` | 5 / 91 | **5.5%** | 旧 2019/2081=97.0%（分母掺进 1992 轮无 selection） |
| `recall.avgInjectedLines` | 214 / 91 | **2.35** | 旧 2.16（用候选池行数除轮数） |
| `recall.coverage` | 91 / 2084 | **4.4%** | 新增：只有 91 轮带 `selection`，其余 1993 轮是老 journal 格式 |
| `recallPrecisionProxy` | 3182 / 4501 | **70.7%** | 旧 4268/4495=94.9% → **降 24.2pp 全部来自去掉裸数字锚**，不是召回变差 |

类型分布（全库 3913 行采样）：`persona=287, episodic=2118, instruction=436, work_fact=1055, work_method=12, work_task=5`。

**读数解读的硬约束**：`coverage=4.4%` 说明召回侧读数目前只覆盖 91 轮（新格式 journal）；扩样本要等新 journal 累积或补老格式兼容 —— 不许把这 91 轮的 5.5% 当成"生产零注入率已从 97% 降到 5.5%"。旧值取自同一 3913 行窗口的复刻探针；期间库新增 14 行，故少数量级 ±1 行抖动，不影响量级结论。

### 4.3 F 批上线后的读数（2026-11-02T09:40Z；`--limit 2000`，10 个 journal 文件）

命令：`npx tsx scripts/memory-metrics.ts --limit 2000`（`--atomic-max-chars` 跟随配置 600，`--config` 缺省读 `D:/TDB/data/config-override.json`）。

| 指标 | 分子 / 分母 | 读数 |
|---|---|---|
| `selfNarrationRate` | 536 / 2000 | **26.8%** |
| `atomicityRate` @600 | 826 / 2000 | **41.3%** |
| `semanticDupRate`@0.85（jaccard-proxy，seed 20261102） | 0 对 / 7140 对 | 0.0% |
| `factsCoverage` | 525 / 2000 | **26.25%** |
| `churn` | 1508 / (1508 + 2000) | **43.0%** |
| `recall.injectedCharsP50` | — | **443** |
| `recall.zeroInjectionRate` | 5 / 108 | **4.6%** |
| `recall.avgInjectedLines` | 253 / 108 | **2.34** |
| `recall.coverage` | 108 / 947 | **11.4%** |
| `recallPrecisionProxy` | 1937 / 2726 | **71.1%** |
| `db` | l1_records 3960 / l1_archive 6530 | — |

**这张表不能与 §4.2 直接相减**：`--limit` 从 3913 变 2000 后，`churn` 的窗口起点（采样最老行 `created_time`）随之前移、`factsCoverage` 的分母采样面变小，`coverage` 的分母（journal 轮数）从 2084 降到 947 是因为只读了 10 个而非 20 个 journal 文件。要比较必须先固定 `--limit` / `--journal-files` / `--since` 三个参数（§5.5、§6）。

## 5. 诚实边界（必须一起引用，禁止只报数字）

1. **selfNarrationRate 是启发式代理。** 研究文档 §A3 写的 32.1% 是**人工抽查口径**（含"我已完成 X 但无产物锚"的语义判断）；本指标是正则 + `metadata.actor` 的机械判定，**两者不可直接相减**。引用时写"机械口径 X%"，不要写"改善了多少个百分点"，除非同时给出同口径的前后两次读数。
2. **semanticDupRate 默认是字符 bigram Jaccard 代理**（无 embedding 时），它抓的是"近重写"而非"语义等价"。文档 §B4 的 63% 是 embedding cos 口径，与本读数 0.0% 的差距**未归因**，不许拿任一数字宣布"重复率已降"。要真实 cos 口径需传 `embeddings`（CLI 暂不计算 embedding）。
3. **zeroInjectionRate 不是"召回坏了"的直接证据**：journal 含探针轮、空 query 轮、以及 `budgetByIntent.empty=0` 刻意不注入的轮。看这个数字必须同时看 `rounds` 与 query 类型分布。
4. **precisionProxy 不是 precision**：它只判断**候选池**行是否带可验证锚（日期 / 时刻 / `file:line` / 含字母短哈希），既不判断"是否被注入"，也不判断是否答对了问题。
5. `churn` 现在是**同期比率**（分子分母同窗口），但仍受窗口起点影响：窗口起点取 `--since`，否则取采样最老行的 `created_time`。跨轮比较必须固定 `--limit` 与 `--since`，且报告的 `archiveWindow.from` 要一起引用。
6. **recall 侧口径已换，不能与旧读数直接相减**：旧 `rounds` 含无 selection 的轮（把 p50 压成 0、零注入率抬到 97%）；新 `rounds` 只数有 selection 的轮，并单列 `coverage`。引用时必须写"`rounds=91`（coverage 4.4%，journal 共 2084 轮）"这样的两段式，否则分母是谁都看不出来。
7. **precisionProxy 从 94.9% 掉到 70.7% 不是质量回退**：旧 `ANCHOR_PATTERN` 把裸数字（如"数值 42""39.47%"）也算锚，分母不变而分子虚高。新口径只认日期/时刻/file:line/含字母短哈希。
8. **selfNarration 只有一套判定**：metrics 侧已删除第二套正则，改为复用 `record/agent-narration.ts`；单测里有 200 行逐行对拍用例锁定"两处判定逐行一致"。若未来要在 metrics 侧加口径，必须改 agent-narration，不许再起第二套。

## 6. 用法约定

- **改动前后各跑一次同参读数**，参数（`--limit` / `--since` / `--journal-files` / `--atomic-max-chars`）必须写在回报里，否则读数不可比。
- 归档进 `runs/` 的 `--json` 输出是**耐久锚**：指标类结论必须能指到具体 run 文件。
- `atomicMaxChars` 从 300 改到 600 后，`atomicityRate` 必须用**新值**重跑，否则是两套口径相减。
- 只读守卫：`memory-metrics.test.ts` 的 `computeL1Metrics` 用例锁定"空池 / 零行 / NaN / 单行超预算"边界；CLI 的 readOnly 是代码事实（`new DatabaseSync(db, { readOnly: true })`），不是约定。

## 7. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-02 | 首次落地：纯函数层 + CLI + 本文档；采集改动前基线 | `npm run memory:metrics -- --limit 800 --journal-files 6`（2026-11-02T07:07:15Z） |
| 2026-11-02 | **F 批上线后读数**（§4.3）：`--limit 2000`，八项 + 新增 `churn` 同期比率；口径与 §4.2 不同参数，不可相减 | `npx tsx scripts/memory-metrics.ts --limit 2000`（2026-11-02T09:40Z） |
| 2026-11-02 | **F5+F6 修正**：selfNarration 主语扩到 AI/助手/模型且 metrics 复用同一判定（删第二套正则）；`churnRatio`→`churn`（同期比率）；recall 只统计有 `selection` 的轮并单列 `coverage`，`avgInjectedLines` 取 `selection.injected`；`ANCHOR_PATTERN` 去裸数字；重复率随机采样 + 统一分母 `compared`；`atomicMaxChars` 从配置读（CLI 缺省跟随，新增 `--config`） | `npx tsx scripts/memory-metrics.ts --limit 3913 --journal-files 20`（读数见 §4.2）；`memory-metrics.test.ts` 42 用例 |
