# 召回选线：分层相对尺子 + 注入形态治理 — 规格

- 状态：**已实现并在生产 enforce**（2026-11-02；差异见 §8）
- 日期：2026-11-02
- 范围：记忆注入的**选线与形态**（哪几行进上下文、进几次）；不含写入侧抽取、不含 rerank 服务修复
- 关联：ADR-0013（题内相对尺子）、ADR-0014（精排单信号）、`docs/ops/core-outage-2026-11-01.md`（rerank 降载根因）、#141（意图路由）、#138/#99（结论层历史病灶）
- 证据脚本（`.scratch/*` 是立项期的临时探针，**不入库**；落地后的可复跑入口是 `MemoryCore/scripts/selection-offline-replay.ts`（离线重放/门槛 c+e）与 `MemoryCore/scripts/calibrate-embedding-sim-floor.ts`（地板标定），归档在 `docs/superpowers/evals/memory-recall-golden/recall-precision-2026-10-20/runs/` 与 `D:/TDB/data/calibration/`）：`.scratch/protoA.mjs`（golden 回放）、`.scratch/protoA2.mjs`（按层 vs 全局）、`.scratch/protoAD.mjs` / `protoAD2.mjs` / `protoFinal.mjs`（journal 影子重放）、`.scratch/protoInv.mjs`（不变性）、`.scratch/protoGen.mjs`（通用性矩阵）

## 0. 先说清楚：这不是针对某批数据的特例

用户要求先证明「全数据通用算法优化」而不是「在 10 轮回放上拟合出来的特例」。四条证据，逐条可复核：

| # | 通用性主张 | 证据 | 复核方式 |
|---|---|---|---|
| G1 | 选线器里**没有绝对阈值常数**：只按层内相对名次取前 q 比例（缺省 0.67，每层至少 1 条） | 对 288 轮 / 920 行的相似度做两种单调变换（`s³`、`sigmoid(12(s−0.35))`），选线结果**逐行完全一致，差异 0 轮**（`.scratch/protoInv.mjs`） | `node .scratch/protoInv.mjs` |
| G2 | 分层不依赖数据分布：层标签取自渲染契约（行首 `- [类型|`），不是聚类/启发式 | 288 轮 920 行中 **100% 带前缀，0 条无前缀**；分布 结论 238 / work_fact 407 / persona 30 / episodic 54 / 上下文 174 / instruction 16 / work_task 1 | 同上 |
| G3 | 唯一依赖嵌入模型的数字（相关性地板）**外置为标定产物**，缺失即诚实 no-op，机制不会误删 | 先例：`soul-dedupe.ts:203-210` 已写明「绝对 cosine 门跨嵌入模型不可移植」，缺省 0.85 在本模型下为诚实 no-op | 读该注释 |
| G4 | 效果不靠「池化后好看」：golden 10 轮**逐轮**核对，只在 1/10 轮丢过 1 条好行 | `.scratch/protoGen.mjs` 的 per-round 段 | `node .scratch/protoGen.mjs` |

跨窗口核对（`.1` 老窗口抽样 90 轮 / 184 行，同一套规则）：基线 356 行 / 184,058 字符（avg 2,045/轮）；名次切 0.67 **零效果**（该窗口每层每轮只有 1~2 条候选，`ceil(2×0.67)=2` 全留）；地板 0.30 去掉 20% 行、保留 67% 结论行、4 轮归零；折叠 0 轮（该窗口没有相邻重复注入）。→ 结论：**名次切在注入尾端是公平机制而不是压缩机制**，压缩来自地板；而地板是唯一模型相关的数字，必须走标定。

三种机制各司其职（避免把「压缩」误记到「公平」账上）：

| 机制 | 职责 | 实测 | 局限 |
|---|---|---|---|
| 分层名次切（q=0.67） | 防跨层挤压：结论层不被高分经验层挤掉 | golden：结论好行 4/4 保住（全局 top-half 只剩 1/4） | 在注入尾端零压缩；候选池（≈15 条/轮）级效果由本票新增埋点观测（§4.6），首个 shadow 窗口产出基线 |
| 相关性地板 | 真压缩：无关轮整体归零 | golden 精度 30%→38%（召回 100%）；老窗口 −20% 行 | 唯一模型相关数字 → 必须标定，未标定即 no-op |
| 折叠 + 意图预算 | 形态治理：不重复注入、按题型给量 | 折叠：当前窗口 81 轮、−29.2% 字符；预算：当前窗口 0%、上一窗口 6.9% | 收益随窗口/意图分布漂移，只能实测不能承诺 |

同时**主动声明数据依赖性**（这些是收益大小，不是算法正确性，必须按窗口实测而非承诺）：
- 折叠收益取决于会话复用形态：本窗口 81 轮可折叠、省 80,559 字符 = **29.2%**；上一窗口同法测得 28.4%；更早一次口径不同测得 4.6%（窗口不同，不可混用）。
- 预算收益取决于意图分布：本窗口 D2/D3 轮多数本来只有 1 行，预算几乎无作用（−0%）；上一窗口实测 6.9%。
- 结论层可分辨性上限受模型限制：good/noise 平均相似度 0.417 vs 0.360、AUC 0.678（n=37 行，11 条 good）——别把这条尺子当成灵丹妙药。

## 1. Problem Statement

用户视角：召回的记忆「很多不沾边」，而且同一批记忆会在相邻轮反复出现。

实证（journal 影子重放 + 代码取证，2026-11-02）：
1. 结论层的命中判据是**字面子串**：只要查询里有一个 ≥2 字的 token 出现在结论正文里就入选（`recall-layered.ts:192-193`）。于是「用一句话介绍你自己。」会命中所有含「一句话」的旧结论（20 轮反复发生）；「继续」会命中一条毫不相干的 work_fact。
2. 唯一有语义判别力的门（cross-encoder rerank）在 2026-11-01 因本地 ORT 崩溃被**全局关闭**（`docs/ops/core-outage-2026-11-01.md:13-26`、`:92-101`），结论层因此完全退回字面判据；而 ADR-0013 已接受的生产建议相反（rerank 开 + candidates=32）。
3. 候选池里 14/15 是场景块且**豁免** BM25 相对地板（`auto-recall.ts:1185`），BM25 地板在 114 轮里 dropped=0。
4. 注入形态单一：同一会话相邻两轮**内容完全相同**的注入在本窗口 288 轮里出现 81 次，占字符 29.2%。

用户已拍板的口径（m00437）：「0 行可接受，但是要自动召回」。即：允许某些轮不注入任何记忆行；不允许用「关掉自动召回」来解决精度问题。

## 2. Solution

把「选线」从**字面判据 + 无标定绝对值**改为**分层相对尺子**，并对注入形态做治理：

1. **分层相对选线**：每条候选先有 (查询, 行) 的语义相似度；在同一层内按名次取前 `keepRatio`（缺省 0.67），每层至少保 1 条（有候选时）。层间**互不竞争**——因为各层的相似度刻度不同（结论 0.378 / work_fact 0.453 / persona 0.356），竞争式 top-half 会系统性挤掉结论层（golden 实测：结论好行 4/4 → 1/4）。
2. **相关性地板可选**：地板值来自标定产物（按嵌入模型 + 维度），未标定即不设地板（诚实 no-op），绝不在代码里写死常数。
3. **注入形态治理**：
   - 相邻轮**逐字节相同**的注入折叠（同一会话内），重复轮注入 0 行；
   - 按查询类型给预算：空/工具类 0 行、续接/自指 1 行、信息型按 `maxResults`。
4. **0 行分两类（2026-11-03 LME90 归因修订）**：
   - 意图本就「不该注」（`empty` / `continuation`）→ 0 行是**契约结果**；
   - 其余意图（`self` / `info`）且候选池非空 → **不得输出 0 行**：空块对模型等于「没有相关记忆」，
     实测 13 道空块题 13/13 拒答（占基线 90 题全部拒答 27.7%）。保护只保回渲染后装得进
     `maxChars` 的行（在装得下的子集里取分数最高者），装不下仍输出 0 行——成本契约优先。
   任何路径都不得回退成「全收」，也不得为凑行放宽相关性地板。
5. **降级保底**：语义通道超时/报错/返回空向量 → 退回今天的字面判据（不退化为全收），journal 记 `bypass:'ruler-unavailable'`。

效果（当前窗口，288 轮 / 920 行 / 275,424 字符，折叠前）：
- 折叠：81 轮 → 注入 0 行，字符 −29.2%（80,559）；
- 选线：golden 候选级精度 30% → 38~40%（召回 91~100%），自指轮 20/28 归零（用户已接受）；
- 预算：本窗口 −0%，按上一窗口实测 6.9%。

## 3. User Stories

1. 作为用户，我希望「用一句话介绍你自己」这类自指问题不再拉出一堆含「一句话」的旧结论，这样注入的记忆才不会被无关内容淹没。
2. 作为用户，我希望在同一个会话里连续追问时，不要每一轮都把同一批记忆重复注入，这样上下文预算能留给真正的新信息。
3. 作为用户，我希望某些轮干脆不注入记忆（0 行），也不要用凑数的行冒充召回。
4. 作为用户，我希望结论层与经验层各自用自己的尺子，而不是一方的高分把另一方的候选挤掉。
5. 作为用户，我希望结论行（长期结论）不因为文本短、话题泛而被系统性淘汰。
6. 作为用户，我希望「你是谁」这类自指问题走人格块（soul block），而不是靠记忆层硬凑。
7. 作为用户，我希望续接型追问（「继续」「好」）最多注入 1 行，避免重复铺陈。
8. 作为用户，我希望空查询/工具调用轮不触发任何记忆注入。
9. 作为用户，我希望语义服务不可用时自动回到今天的行为，而不是整块召回失败或注入全量。
10. 作为用户，我希望这套判据换了嵌入模型仍然成立，而不是绑定在 doubao-embedding-vision 上。
11. 作为用户，我希望地板的取值有标定产物与来源可查，而不是散落在代码里的魔数。
12. 作为维护者，我希望选线是纯函数、确定性、可单测，不依赖时钟与随机。
13. 作为维护者，我希望 journal 记录每行被丢弃的原因（名次/地板/预算/折叠），便于事后审账。
14. 作为维护者，我希望新旧行为可一键回退（`mode: off`），不需要回滚代码。
15. 作为维护者，我希望先 shadow 观察一周再 enforce，观察期只记录不丢弃。
16. 作为维护者，我希望候选级与注入级两个观测面都能复盘（今天 journal 只记注入结果）。
17. 作为维护者，我希望这套改动不引入新依赖、不新增外部服务调用面。
18. 作为维护者，我希望 rerank 的崩溃域问题（G2）由独立票处理，不被本改动裹挟。

## 4. Implementation Decisions

### 4.0 不变量清单（可逐条对照代码）

1. **相似度只做相对排序**：单调变换（s / s³ / sigmoid）不得改变选线结果。
2. **层内不补位**：某层被地板/预算清空就是 0 行，绝不从别的层借行来凑数。
3. **预算是硬上限**：任何一轮注入字符数 ≤ `maxChars`；装不下就压缩（证据窗）或丢弃，绝不放宽上限。
4. **不许静默空块**：池非空且意图不是 `empty`/`continuation` 时，注入 0 行属缺陷——必须保回一行装得下的最高分证据（零行保护）；一行都装不下才允许 0 行，且要能在 journal 里对账。
5. **off 是逐位回滚通道**：`mode: off` 下行为、注入集合与改动前逐位一致（证据窗、零行保护在 off 下都不生效）。
6. **观测面不改行为**：所有 journal 字段（含 `rescued`/`windowed`）只读不改注入结果。

### 4.1 模块与接缝
- 新增纯函数模块（建议名 `recall/selection/layer-ruler`）：输入 `{candidates: [{text, layer, score, order}], keepRatio, minPerLayer, floor?}`，输出 `{kept[], dropped: [{text, reason: 'rank'|'floor'|'budget'|'fold'}]}`。零 IO、零时钟、零随机。
- 复用 `recall/rerank/filter-ruler` 的**词汇**（floor / margin / quantile）与归一化函数风格，但**不共用阈值**：那里输入是 cross-encoder logit，这里输入是 cosine。
- 接线点：结论层在 `selectL2Conclusions` 的候选循环处（现在是 `sceneHit || textHit`），经验层在其候选截断处；**两层调用同一个函数**，避免再次出现「两层两套判据」。
- 折叠与预算在注入装配阶段（auto-recall 组装处），与既有 `foldNearDuplicates`（轮内近似去重，阈值 0.25）职责不同：本规格处理的是**跨轮、逐字节相同**的重复注入。

### 4.2 相似度来源
- 复用现有 EmbeddingService（`embedBatch`），批量嵌入查询与候选（候选池约 15 条/轮）。
- 单轮预算 800ms；超时/异常/空向量 → 走 4.5 降级。
- 不新增第三方服务、不改 provider 配置。

### 4.3 配置面
```
| 键 | 代码缺省（标准档） | 生产 override（2026-11-03 观测值） | 说明 |
| --- | --- | --- | --- |
| `layerRuler.mode` | `off`（逐位现状） | `enforce` | off 是回滚通道 |
| `layerRuler.keepRatio` | 0.67 | 0.67 | 每层至少 1 条 |
| `layerRuler.floor` | null（不设地板） | `doubao-embedding-vision@2048 = 0.3` | 归一化量纲 |
| `layerRuler.budgetMs` | 300 | 800 | 单轮选线预算 |
| `injection.foldIdentical` | false | true | 同回合折叠 |
| `injection.maxLineChars` | null | null | 单行渲染上限 |
| **`injection.maxChars`** | **2400** | **600** | 本轮注入字符预算（硬上限） |
| **`injection.budgetByIntent`** | **`{empty:0, continuation:1, self:null, info:null}`** | `{empty:0, continuation:1, self:1, info:null}` | 意图预算 |
```
**2026-11-03 起标准档成为代码缺省**（用户口径：最优召回是标准，不是可配置项）：不写这两个键时
自动落到上表「代码缺省」列，实测 LME90 genCorrect 0.400（600 档）→ 0.778（2400 档）。
显式写 `null` 才回滚到「不限」；`≤0` 归一为 `null`；只有「根本没写这个键」才落标准档。
生产 override 里仍是 600 档，属**部署值**，改它需要点名数值 —— 不在本规格范围。

### 4.4 标定产物
- 位置：`data/calibration/embedding-sim-floor.json`，键 = `model@dims`，值 = 由 null-probe（查询 × 无关行）分布取 p95 得到的相似度地板，附测量日期与样本量。
- 读取失败/键缺失 → `floor = null`（诚实 no-op），journal 记 `floorSource:'uncalibrated'`。

### 4.5 降级与失败语义
- 语义通道不可用 → 沿用现有字面判据，注入行为与今天一致；journal `ruler:{mode, bypass:'ruler-unavailable'}`。
- 地板过滤导致某层全空 → 该层 0 行，不补位、不放宽（层内不补位；跨层零行保护见 §4.8）。
- 任何路径不得 fallback 到「注入全部候选」——唯一豁免是 `bypass`（选线不可用、判定集为 null）：
  此时注入与 `mode: off` 逐位一致，这是降级语义，不是选线结果。

### 4.6 可观测
- journal 新增：`selection.kept`、`selection.droppedBy={rank,floor,budget,fold}`、`ruler.mode`、`ruler.floorSource`、`fold.identicalLines`。
- 2026-11-03：`selection.rescued`（零行保护保回条数）+ `candidates.lines[].rescued`——否则会出现「kept=true 但 scoreQ 低于地板」这种无法解释的非法态。
- 2026-11-03：`selection.windowed`（证据窗改写条数）+ `ruler.maxChars`（本轮生效预算，已存在）——
  两者必须同轮可读，否则无法区分「行被压短」与「行被丢弃」。类型定义见
  `src/core/recall/recall-journal.ts` 的 `RecallJournalSelection` / `RecallJournalCandidateLine`。
- **候选级埋点（本票范围内）**：journal 新增 `candidates.total`、`candidates.byLayer={层:条数}`、`candidates.bm25Exempt`（豁免 BM25 地板的条数）、`candidates.lines[]`，每项 `{layer, hash(前8位), scoreQ(相似度分位 0-100 整数), bm25Rel, kept, droppedBy}`。
  - 目的：今天 journal 只有注入结果，看不到「候选池 15 条 → 注入 3 条」之间被谁砍掉；没有这一面，名次切/地板/预算的账无法逐轮核对，后续标定也无从取数。
  - 有界：`candidates.lines` 最多 40 条（超出只记汇总 + `truncated:true`）；不记正文，只记哈希与分位，单轮增量目标 < 4KB。
  - 独立于 `mode`：`off` 也记录（这是观测面，不是行为开关），但 `off` 下 `droppedBy` 恒为 `{rank:0,floor:0,budget:0,fold:0}`，便于对照。
- 不记录行全文（避免 journal 膨胀），记行哈希 + 层名 + 分数分位。

### 4.7 与既有机制的边界
- 不动 rerank 开关与本地 ORT（G2 另票）。
- 不动结论层字符截断（#178 已关，属另一问题）。
- 不删任何记忆（零删红线）。
- 不接管人格块/soul block（人格层与选线互不干涉）。
- 证据窗只压缩「本轮要注入的记忆行」，不触碰 soul block、前言与 wrapper。

### 4.8 零行保护（标准行为，无开关）
- 触发条件：`mode=enforce` 且非 bypass、判定集为空、预算池非空、意图 ∉ {empty, continuation}。
- 选行：在「渲染后装得进 `maxChars`」的子集里取 `scoreQ` 最高者；渲染长度按 `capMemoryLine`
  实算（与最终渲染同源），所以「最高分行超预算、次高分行装得下」不会误判为放弃。
- **允许低于地板**：地板是排序启发式，不是正确性闸门——空块对模型等于「没有记忆」，
  实测 13 个空块轮 13/13 拒答，代价远大于给一行弱证据。此行必须打 `rescued` 标记，
  并在 journal 把原 `droppedBy` 计数冲销，保证账目自洽。
- 一行都装不进预算 → 仍 0 行（不击穿成本契约），由调用方按「无可注入记忆」处理。
- 与折叠的关系：保护发生在同回合折叠**之前**，因此「本轮已注入过同内容」仍可能得到 0 行，
  这是折叠契约的既定行为，不是保护失效。

### 4.9 证据窗（evidence-window）
- 动机：金标轮常是 1468–3079 字的 assistant 长轮，整行装不进预算就被整条丢弃，
  实测 7 道题因此丢掉唯一证据（块里还留着上千字空预算）。
- 规则：行本身装得下 → 原样不动；装不下 → 「头 35% + 命中窗 40% + 尾 25%」三明治，
  保留 `·(活动时间: …)`/`·soul[…]` 锚，末尾标 `…（节选）`；可写空间 < 60 字则放弃
  （宁可丢行也不给几句噪声）。
- 边界：只在 `mode ≠ off` 且 `maxChars > 0` 时生效；**不改 `maxChars` 上限**（节选后仍 ≤ 预算）。
- 与 `conclusionLayer` 截断、`maxLineChars` 的关系：`maxLineChars` 是渲染期单行上限（可能截断），
  证据窗是选线期的「装不下才压」，两者都不改预算上限；结论层自带 `maxCharsPerMemory` 截断，
  互不接管。

### 4.10 残预算回填（2026-11-03，标准行为、无配置键）

- 病灶：名次尺的字符预算是「装得下就装，装不下跳过」（layer-ruler.ts:236-242），
  于是一条 1468–3079 字的金标轮会把整轮丢光，而块里还剩几百字预算空着。
- 规则：在零行保护**之后**、同回合折叠**之前**，把 `dropOf==="chars"` 的候选按 `scoreQ` 降序
  取出，用证据窗裁到「剩余预算」，逐条回填，直到剩余预算 < `BACKFILL_MIN_CHARS`(200)。
  回填行计入 `judgeKept`、冲销 `droppedBy.chars`、写 `selection.windowed` 与
  `candidates.lines[].backfilled`；渲染顺序 = 名次行在前、回填行在后（碎片不抢完整证据）。
- 不变量：只用**剩余**预算，绝不移除已选中的任何一行 → 结构上不可能让已有证据变差。
- 边界：`mode:off` / `bypass` / `maxChars=null` 时不触发（与改动前逐位一致）。
- 实现：`MemoryCore/src/core/recall/selection/injection-stage.ts:582-614`（回填）、
  `:616-621`（preFold 顺序）、`:651`（windowText 参与渲染）；用例
  `selection/__tests__/injection-backfill.test.ts`（5 例）。

### 4.11 轻度超预算连续窗：实测否决，**不采用**（2026-11-03）

- 假设：18dcd5a5 的 3131 字 assistant 轮在 2400 预算下被三段窗切成 1701 字（利用率 54%），
  答案「Mummies (4)」正在 26% 的切口上 → 改成「头 X% + 尾 Y%」连续窗，把预算用满。
- 实测（同一 90 题、同判官、同库、除本项外逐位相同）：
  | 臂 | 窗口 | genCorrect | refused | 相对基线 |
  | --- | --- | --- | --- | --- |
  | step0 基线 | 三段窗 | 71/90 = 78.9% | 15.6% | — |
  | arm1 | 头 80% + 尾 20% | 70/90 = 77.8% | 17.8% | −1 |
  | arm2 | 头 60% + 尾 40% | 70/90 = 77.8% | 18.9% | −1 |
- 逐题归因：80/20 把 7405e8b1、afdc33df、35a27287、gpt4_93f6379c、gpt4_65aabe59 五题从对翻错
  （答案都落在长轮**末尾**），只救回 18dcd5a5 一题；60/40 救回 gpt4_65aabe59 又丢掉 2318644b
  （答案在轮次**中段**，被头尾两段之间的切口吃掉）。三段窗的「命中段」恰好覆盖 35%–75%
  这一答案高发区——它按比例落刀看似粗糙，实际是用**命中**而不是位置在选内容。
- 结论：单一窗口策略在任何固定比例下都会切掉某一位置的答案；**不引入新窗口策略**，
  证据窗保持 `evidence-window.ts:126-152` 的三段窗，仅在 §4.10 的回填路径上复用它。
- 另一条被否的假设：把「同块不同答」当成改动效果。arm1 的 4 个 WIN 里 1c0ddc50（blockChars
  两臂完全相同 1098）、75f70248、gpt4_b4a80587 属**同块不同答**，即 LLM 采样噪声；
  单臂噪声量级约 ±2–4 题，故任何 ±1 的臂差都不能算改动效果。

### 4.12 口径上限的逐题证据（2026-11-03，答「为什么 0.85 不是再调预算就能到」）

在同一臂（arm3 = step3-backfill-only，71/90 = 78.9%，与基线逐题同分）里，把每题的
**金标答案词面**分别在「块内文本」与「检索到的轮次全文」里做覆盖率（≥50% 记为覆盖到），
得到四层分布（`retrieved` 的 `lme-<case>-s<N>-t<M>` 按 `haystack_sessions[N-1][M]` 还原全文）：

| 分层 | 全量 | 其中答错 | 含义 |
| --- | --- | --- | --- |
| BLOCK（块内已覆盖） | 45 | 7 | 证据已在块里仍答错/拒答 → **加预算、加行数、加回填都无效** |
| RENDER（检索到但未进块） | 11 | 2 | 选线取舍/渲染丢失 → 读侧唯一能动的一格 |
| RETRIEVE（检索层就没命中） | 20 | 6 | 排名问题 → 需 rerank/多跳，§6 范围外 |
| 无法判定（金标词面 < 3 字或过短） | 14 | 4 | 词面法判不了（如 "Yes."、"$270"） |

块字符 p10/p50/p90 = 1626/2647/2820（上限 2834 = maxChars 2400 + wrapper/前言 434），
**54/90 题的块利用率 ≥90%**。即：多数题预算早已吃满，缺的是「哪 10 行赢」而不是「能装多少行」。
这也解释了 §4.10 回填在白盒上成立、在总分上不构成增益：全库 90 题里只有 6 题的块文本发生变化
（变化量 ±100 字），因为剩下 84 题的剩余预算 < `BACKFILL_MIN_CHARS`。

**算术上限**：19 道错题里读侧选线能碰到的只有 RENDER 类 2 道，全对也只到 73/90 = **81.1%**；
要到 0.85（77/90）必须再动 4 道 BLOCK 类（生成/拒答行为，bench 侧答案 prompt 由
`scripts/lib/bench/llm.mjs` 的 `buildAnswerPromptTuned` 决定，改生产口径不进这个口径不会被测到）
或 RETRIEVE 类（rerank，`rerank.enabled=false`，ORT 崩溃域）。**在「只动注入面」的口径下，
0.85 不可达**——这不是调参不够，是可动的题数不够。

### 4.13 精排生效时必须停用 dynamicTopK 的 elbow 收缩（2026-11-03，无配置键）

`dynamicTopKCount`（`MemoryCore/src/core/hooks/recall-dynamic-topk.ts:32-57`）假定输入是
**名次单调递减**的分数序列：取最大相邻落差 ≥ `dropRatio × (pool[0] − pool[last])` 处切断。
而精排路（`applyRecallRerank`）**不重算分数**——它只在 `auto-recall.ts:223` 做
`searchResult.scores = final.map((i) => searchResult.scores![i])`，把原融合分按精排新序**平行重排**。
于是送进 elbow 的序列不再单调（实测 031748ae：`[0.462, 0.430, 0.469, 0.431, 0.209, …]`，
第 4→5 位落差 0.222 = span 的 103%），elbow 判 `k=4`，注入从 10 行砍到 4 行、答案行被丢。

修法（`auto-recall.ts`，rerank 接入段之后）：`rerankApplied = rerankWiring.state === "active"`，
elbow 门槛加 `!rerankApplied`。**精排档的选行口径由精排自己的 cap（= `r7Budget.experienceLimit`）
＋ `minScore` 定**；elbow 是融合分几何上的经验启发，精排后失去意义。rerank 关断时
`rerankApplied=false` ⇒ 逐位不变（零回滚风险）。

锁死用例：`src/core/hooks/__tests__/auto-recall-rerank.test.ts` ⑧「精排档不叠 dynamicTopK elbow」
与 ⑧b「对照：精排关断时 elbow 照旧生效」（同一分数几何必须切）。RED 留档
`D:/tmp/RED-dyntopk-rerank.txt`（无门槛时被砍到 `minTopK=2`）。

### 4.14 精排只定集合、呈现恒回融合序（2026-11-03，rerank 的落地形态）

**病灶**：精排接管顺序后，块内**位置**决定作答。逐题账：gpt4_8c8961ae 的 gold 行在精排档排 #3~#6
（融合档 #1~#2）、gpt4_1d80365e / gpt4_85da3956 / gpt4_65aabe59 两档都全量命中却只在精排档答错。
交叉编码器在本库上「会挑集合、不会排序次」：它的分序把决定性证据从头部推到中部，而块内注意力
先验是融合序（向量 + BM25 + 事实通道 + 时效）。

**决定**（`auto-recall.ts`，`applyRecallRerank` 内 `:935` 之后）：

    const presentIdxs = wiring.mode === "filter" ? final : final.slice().sort((a, b) => a - b);

lines / scores / metas / lineSessions 全部按 `presentIdxs` 取，journal 的 `gates.rerank` 记
`presentation: "fusion"`。无配置键；`mode: "filter"` 本就保原序，行为不变。

**三臂实测**（LME oracle 90 题、同 judge、同库、单臂串行）：

| 臂 | 选行 | 呈现 | genCorrect | refused | turnCov | nDCG | blockChars | injectedLines |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| step3-backfill-only | 融合 | 融合 | 71/90 = 78.9% | 15.6% | 87.7% | 0.809 | 2397 | 6.84 |
| step5-rerank-on（修 elbow 后） | 精排 | 精排 | 66/90 = 73.3% | 17.8% | 92.1% | — | 2511 | 7.93 |
| step9-rerankon-fusionpresent | 精排 | **融合** | **72/90 = 80.0%** | 17.8% | 91.6% | 0.837 | 2523 | 8.01 |

互比：融合呈现 vs 纯精排序 **9 胜 3 负**（超出单臂 ±2–4 题噪声带 ⇒ 机制成立）；
vs 融合-融合 3 胜 2 负（打平），但检索指标全面更好（sessionCov 96.1%→98.9%、turnCov 87.7%→91.6%、
nDCG 0.809→0.837 为全臂最高）。

**为什么不是「行数问题」**：injectedLines 6.84 → 5.30（中间一臂）→ 7.93 与 genCorrect 71 → 68 → 66
同向恶化，说明单纯多给行没用；LOSS 形态统一是「比较/时间类题只进了一侧证据」
（gpt4_8c8961ae「欧洲 vs 泰国」只给欧洲、gpt4_1d80365e 只有开始日）。

### 4.15 发布态等价性验证（2026-11-03，env 门控移除后的实测）

臂 step9 用 `RERANK_PRESENT_FUSION=1` 门控跑出 72/90；把门控**无条件化**后，代码走的是同一条表达式
（`presentIdxs = wiring.mode === "filter" ? final : final.sort(a-b)`），但需要一次运行态证据。方法：
`--gen-limit 0`（只测检索/注入，不生成不判分）在**同一 store、同一组 90 题**上重跑，逐题对比块文本：

- 90/90 题块非空；**78/90 题块文本与 step9 逐字节相同**；
- 12 题不同，均为「字符数相同或 ±300 内的内容差异」（如 `ba358f49` 2038 vs 2038、`ad7109d1` 1524 vs 1524），
  来源是检索侧非确定性（embedding 429 重试窗口下的候选抖动与 `scoreThreshold` 边界），与本改动无关。

因此 step9 的 72/90 = 80.0% 就是发布态口径。**诚实边界**：env 移除后没能再跑出一条完整的生成臂
（本机当晚 `recall timeout 60000ms` 与 onnx 精排 `provider=local 返回 null` 反复出现，两次重试都在
4b24c848 / 06db6396 上超时退出），故发布态只有「块等价 + 单测/suite 全绿」两组证据，没有第二条完整生成臂。

### 4.16 结论门 enforce 后不得经 L1 回流入块（2026-11-03，修一处真缺陷）

把呈现序改回融合序后，`auto-recall-conclusion-gate.test.ts` ②enforce 用例暴露出既往被顺序掩盖的缺陷：
`excludeIds`（`auto-recall.ts:1795` 附近）在**门控之后**才从 `r7Conclusions` 生成，于是被
`conclusionLayer.rerankGate` 判死的结论**不**在排除列表里，会以「普通 L1 行」身份被搜索重新召回、
重新进块——门等于没生效（此前它只是被预算截断挡在尾部，看起来像生效）。

修法：门控前先取快照 `r7ConclusionExcludeIdsBeforeGate`，`excludeIds` 用「快照 ∪ 门控后剩余」去重并集。
shadow/off 档下两者相同 ⇒ 逐位不变；只有 enforce 真的剔除时才有差异。

## 5. Testing Decisions

好测试的标准：只断言**外部可观察行为**（注入几行、哪些行、journal 记了什么），不断言内部实现细节（中间数组、调用次数按实现细节除外）。

- 单元（纯函数）：`layer-ruler` —— 边界（候选 1 条时必留 1 条）、`keepRatio` 取整、并列分数按输入序稳定、全零分数、混合层不互相竞争、地板 null 与有值两态。
- 性质测试：单调变换不变性（`s` vs `s³` vs `sigmoid`）选线结果完全一致——这条直接把「通用性」写成可执行断言。
- 集成：auto-recall 装配层用假 embedder（先例：`auto-recall-fact-channel.test.ts` 的 `embedBatch` fake、`recall-layered.test.ts`），断言注入行集合与 journal 字段。
- 折叠：同会话两轮相同候选 → 第二轮 0 行（先例：`recall-fold-near-dup.test.ts`）。
- 降级：embedder 抛错/超时 → 注入结果与 `mode:off` 完全一致。
- 候选级埋点：单轮 journal 含 `candidates.total/byLayer/lines`，每项有 layer+hash+scoreQ；候选 > 40 条时 `truncated:true` 且汇总字段仍完整；`mode:off` 下同样记录但 droppedBy 全 0。
- journal 体积守卫：构造 40 条候选 × 长正文样本，断言单轮记录序列化后 < 4KB（防止观测面吃掉 5MB 滚动窗口）。
- 行为契约：golden 10 轮回放，逐轮断言「好行保留数」与「0 行轮数」（当前基线：pooled 精度 30%/召回 100%；目标 38~40%/91~100%）。
- 变异抽查：把 `keepRatio` 改成 1.0 与 0.0，用例必须变红；把层合并成单层，用例必须变红。
- 零行保护：判定集为空 + 池非空 + 意图 info/self → 必得 1 行且 ≤ `maxChars`；intent empty/continuation → 仍 0 行；
  一行都装不下 → 0 行；bypass → 不受影响。
- 证据窗：`buildEvidenceWindow` 对 ≤ 预算的行返回 null；超预算行返回 ≤ 预算且带锚的节选；
  `mode: off` 下不触发（逐位一致）。

## 6. Out of Scope

- rerank 服务修复与重启用（G2，另票；含 ORT 崩溃域隔离）。
- 写入侧抽取/原子化结论（G4，受零删红线阻断）。
- 嵌入 provider 更换、维度变更。
- 人格块/soul block 的编排。
- 按需检索（B 派）——用户已否决「关掉自动注入」。
- 记忆删除/合并（零删红线）。
- 写入路径性能、成本优化。

## 7. Further Notes

- 口径纪律：journal 5MB 滚动，窗口不同数字不可直接比较；本规格所有百分比都标注了窗口与样本量。
- 小而诚实的样本：golden 37 行 / 11 条 good；AUC 0.678 是「有判别力但弱」，不足以单独支撑强结论，故结论部分只承诺「不丢好行 + 减少无支撑行」，不承诺「精度翻倍」。
- 历史教训：任何「收紧字面判据」的尝试都会复现 #99 的结论层 0 行病灶（token 收紧实验：召回 100%→27~55%，精度反而 30%→26~33%）；本规格因此**不改字面判据本身**，只改「谁说了算」。
- 待补实测：跨窗口（.1 文件抽样 90 轮）稳定性核对仍在跑，结论并入评审时的附录，不改本规格的算法选择。

## 8. 实际落地与规格的差异（2026-11-02 实施收口）

状态：**已实现并在生产 enforce**（生产 override 是 §4.3 的同形两段；代码缺省仍为今天行为）。落地映射：

| 规格条目 | 落地位置 |
| --- | --- |
| §4.1 纯函数名次尺 | `MemoryCore/src/core/recall/selection/layer-ruler.ts`（18 例，含三种单调变换逐位一致 + 源码约束两例） |
| §4.1 两层共用一份实现 | `MemoryCore/src/core/hooks/recall-layered.ts`（`selectL2ConclusionsDetailed` → `layerRulerSelect`，limit 作 budget） |
| §4.3 配置面 | `MemoryCore/src/config.ts`（`recall.layerRuler` / `recall.injection` 解析；新键缺省 = 今天行为） |
| §4.4 标定产物 + 缺键 no-op | `MemoryCore/src/core/recall/selection/floor-calibration.ts`、`MemoryCore/scripts/calibrate-embedding-sim-floor.ts`、`D:/TDB/data/calibration/embedding-sim-floor.json` |
| §4.2/§4.5 语义通道与降级 | `MemoryCore/src/core/recall/selection/injection-stage.ts` + `injection-wiring.ts`（地板按 `model@dims` 匹配才用、单请求 10 条切片） |
| §4.6 观测面 | `MemoryCore/src/core/recall/recall-journal.ts`（`selection`/`ruler`/`fold`/`candidates`）+ `MemoryCore/src/core/hooks/auto-recall.ts` 注入点 |
| 生产开关与回退 | `D:/TDB/data/config-override.json` 顶层两段；运维文档 `docs/ops/recall-layered-ruler-ops.md` |

差异逐条（每条带原因与后果）：

1. **单轮预算 300ms 而非 §4.2 的 800ms**：§4.2 是语义超时上限，验收门 e 要求「增量 p95≤300ms + 超预算自动 bypass」，取严者——`SELECTION_BUDGET_MS=300`，到点整段 bypass（`ruler.bypass='ruler-budget'`），800ms 仅作兜底注释保留。实测（20 轮重放，doubao-embedding-vision@2048）p50 271 / p95 344 / max 683ms ⇒ 约 5% 慢轮降级为「今天行为」。
2. **地板取 p50（0.3126）而非标定产物里的 p95（0.4923）**：用户拍板（D7）。p95 地板在 40 轮重放里把 30% 的轮打到 0 行（超 ≤20% 门槛）、golden 少 3 条命中；p50 地板降 16.3% 行数、0 行轮 5%，代价是 golden 少 1 条 high（P3）。标定产物仍按规格记 p95；生产 `floor.value` 写 p50 数字，`floorSource='config'` 可追溯。
3. **生产 embedding 单请求最多 10 条输入**（超限实测 HTTP 400 InvalidParameter）：接线层按 10 切片，比规格「一次 embedBatch」保守；池子大时走多次请求，也更容易撞 300ms 预算。
4. **折叠按「回合」不按「调用」**：journal 实测同会话 93 对相同注入绝大多数是**同一轮两次召回**（生产两个调用点：`auto-recall.ts` 与 `gateway/v2-router.ts`），按字面实现会误折叠。台账只在 hook 注入路径记上一回合指纹，同轮第二次调用仍返回全量。本窗口折叠命中 0 次（无跨轮重复），机制保留。
5. **意图预算判定口径**：`self` 复用既有 `isAssistantRecallQuery`；`continuation` 收紧为「以续接词开头、剥前缀后尾巴 ≤4 字、无英数、整句 ≤12 字」（初版「≤12 字无实体」把「继续昨天那个采购单据改造」误判为续接）。
6. **`selection.kept` 语义**：判定保留数（shadow 下即「若 enforce 会留几条」）；折叠计入 `droppedBy.fold`，故折叠轮 `kept=0`；恒等式 `kept+rank+floor+budget+fold = candidates.total`。
7. **`candidates.bm25Exempt` 恒 0**：注入层没有 BM25 相对分（结论层 bm25Rel 在 L2 内部），字段保留但不驱动任何行为。
8. **gate b 口径重定（用户 D5 批准）**：golden 基线本身已丢 2 轮好行、precision proxy 只有 0.182（与 §0 引用的「30%/100%」不是同一口径），故判据改为「逐轮保留现命中行不减少、丢好行轮数 ≤ 基线」；enforce + p50 地板实测 highValue 5/9、丢 P3 一条 high，已由 D7 记为批准偏离。
9. **新增嵌入内容寻址缓存（§4.2 未写）**：`injection-wiring.ts` 的 `embedCached` 按 `<model>@<dims>\0<文本>` 缓存向量（LRU 1024 条，进程内、不落盘）。原因：不加缓存时 40 轮重放有 15/40 轮撞 300ms 预算，降幅从 16.3% 掉到 11.8%（门 c 不过）；加缓存后同批样本 bypass 7/40、降幅 **20.8%**、0 行轮 1/40、增量 p50 236 / p95 286 / max 287ms（门 c、e 全过）。语义不变：同模型同文本向量确定，键含 model@dims 防跨端点串味；缓存没补齐（端点少返回）按长度不符走 `ruler-unavailable`，绝不拿空向量凑数。

## 2026-11-03 增补：标准档成为代码缺省

- 触发：LME90 全量复测（scm-flash judge / lme-v2）暴露三处读侧缺陷——空块 13/90、
  「检索到但未渲染」50/90（其中 41 题答错，占全部错题 75.9%）、413 字固定前言占块字符 p50 47.3%。
- 处置：`maxChars` 缺省 2400、`budgetByIntent.self` 缺省 null、零行保护与证据窗成为标准行为
  （无配置键、无开关）；`mode: off` 仍是逐位回滚通道。
- 标定曲线（同一 90 题、同判官、复用库）：600 → 0.400 / 1200 → 0.667 / 1600 → 0.744 /
  2400 → 0.778 / 3600 → 0.789；refused 52.2% → 15.6%。
- 生产 override 仍是 600 档，属部署值变更，需点名数值后另行执行。

### v3 增补（2026-11-02 下午，同票二轮）

10. **单轮预算抬到 800ms（差异 1 的反转）**：`layerRuler.budgetMs` 落地为可配（50..5000，缺省 300 = 规格验收门 e 的严值），生产写 800。原因：实测火山 Ark `/embeddings`（doubao-embedding-vision@2048）单次 RTT 111–382ms（p50≈175、p75≈300），300ms 预算下「查询嵌入一次」就可能到点 —— 真机 18 轮实测 bypass 约 2/3，即名次与地板在生产基本没生效过。切 800 后同批实测 bypass 1/18=5.6%、p50 340ms、p95 814ms。代价：慢轮最长多等 0.5s（仍在 /v3/recall 5000ms 硬超时内）。
11. **地板 p50 → 0.30（差异 2 的修订）**：p50=0.3126 会丢掉 golden P3 的 high（cos 0.311），这是「单阈值必丢好行」的直接证据。0.30 在 golden 上：无预算时 high 召回 0.900→1.000；配合 maxChars 600 时 high 0.900、lowKeep 0.346、字符降 88.2%、0 行轮 1/10、**「整轮丢光 high」的轮数 0**。生产 24 轮重放：98 行/26379 字符 → 50 行/9638 字符（降 63.5%）、0 行轮 0。唯一代价：P6 一条 431 字 high 被同轮 596 字 high 挤出 600 预算（kept 1/2，该轮仍有 high 注入）。
12. **新增 `injection.maxChars`（字符预算）——真正的压缩器**：名次尺按比例保留，压缩上限由总字符决定。golden 网格 500/600/700/800/900/1200：500 太紧（high 0.700）、600 与 700 逐位同、800 起 lowKeep 回升；取 600。代价已计入差异 11。`lengthLambda` 在 600/800 预算下 0/.04/.06/.08/.10 **零影响**（≥0.12 反而丢掉 P6 两条 high）→ 生产 `lengthLambda: 0`。`dedupeSim` .92/.95 在 golden 与生产 24 轮上零影响（近重复对已被地板/预算挡住）→ 生产留 null。
13. **bypass 时的字符兜底 + 零行纪律（规格 §4.5「任何路径不得 fallback 到注入全部候选」的落地加严）**：bypass 且配了 maxChars 时按候选原序贪心装填、其余记 `droppedBy.chars`、写 `ruler.fallback='char-budget'`；**装得下 0 行也照样接管**（早期实现在 size=0 时跳过 → `judgeKept=null` → 退回全量注入，等于预算被静默绕过，已由装配层用例咬住）。选线判空时整段不输出（不再吐空壳 `<relevant-memories>`）。观测面新增 `selection.poolChars` / `selection.injectedChars`：`memoryLines` 是候选池（选前），用它算「是否超预算」会得出反结论（实测把 562 字符注入误读成 1400）。

回退：`layerRuler.mode` 改回 `off`（或整段删除）→ 注入路径与改动前**逐位一致**（有 `mode:off 与改动前逐位一致` 用例 + 离线重放 off 列作证），不需要回滚代码；改完必须重启 core（配置仅启动时读）。


## 2026-11-04 增补 §4.17：本地精排的延迟契约（实测标定 → 代码缺省 → 硬预算）

### 4.17.1 问题：精排把召回预算吃穿
2026-11-03 两次 rerank-on 完整臂（`4b24c848` / `06db6396`）撞 `recall timeout 60000ms`
（`scripts/eval-memory-bench.mjs:1203` 的 `recallTimeoutMs = 60000`）。根因三处：
1. `local.ts` 旧缺省 `inferTimeoutMs: 30_000` —— 推理假死时**一次**就拖 30s，两次即破 60s；
2. `--rerank-timeout` 只写 `config.rerank.timeoutMs`（云端 fetch 用），**local provider 从不读它**
   → 命令行「调了没用」；
3. 推理本身太慢：32 候选 × 生产行长（bench 库 `l1_records.content` 实测 p50=497 / p75=2151 /
   p90=2748 字符）在 1 线程下 ≈4.5s/题（step9 报告 `gates.rerank.ms` p50 **4515ms**、max 14305ms、90 题累计 485s）。

### 4.17.2 标定（本机 16 核 / onnxruntime-node q8 / bge-reranker-base，32 候选）
| 变量 | 实测 | 结论 |
| --- | --- | --- |
| intra_op 线程 1/2/4/8（×400 字符） | 3257 / **1939** / 3245 / 3850 ms | 只有 2 线程有收益（1.68×）；4/8 反向变慢 |
| 单条长度 200/400/800/1200/2000 | 1680 / 3441 / 6546 / 7770 / 6816 ms | 与长度近似线性，≥1200 撞 tokenizer 512-token 截断后封顶 |
| batch（32 条一次前向） | 400 字符 3564 vs 单条 3175；800 字符 6462 vs 6229 | **无收益**（CPU q8 的 padding 吃掉并行），不采用 |
| 模型加载 | tokenizer 1015 + model 728 = 1743 ms（worker 首调 2894ms） | 冷启动一次性成本，不做超时击杀 |

### 4.17.3 落地（零新增配置键；env 只留给 A/B）
- `src/core/recall/rerank/tuning.ts`（新增，单一真源）：`DEFAULT_RERANK_THREADS = 2`、
  `DEFAULT_RERANK_DOC_CAP = 320`、`DEFAULT_RERANK_INFER_TIMEOUT_MS = 6_000`；
  `resolveRerankTuning(env)` / `resolveRerankInferTimeoutMs(env)` 支持 `RERANK_THREADS` / `RERANK_DOC_CAP` /
  `TDAI_RERANK_INFER_TIMEOUT_MS` 覆盖（脏值/0/负数一律回落缺省，不会变成 0 线程或 0 预算）。
- `local.ts`：`inferTimeoutMs` 缺省改 `resolveRerankInferTimeoutMs()`；新增 `buildRerankWorkerData()`
  把 `tuning` 随 workerData 下发（worker 内优先级：workerData > env > 内置缺省）。
  `rerank-worker.mjs` 不再自带第二份缺省值（避免主/worker 双源漂移）。
- `scripts/eval-memory-bench.mjs`：`--rerank-timeout` 同时写 `config.rerank.timeoutMs` 与
  `process.env.TDAI_RERANK_INFER_TIMEOUT_MS` —— 命令行开关对 local 生效，不再「看着像没生效」。
- 兜底语义不变：硬预算到点 → `killWorker`（terminate）+ 本次降级原序 + `breaker.recordFailure()`，
  三次连败熔断 60s。降级路径与改动前逐位一致（rerank 关断时完全不走这段）。

### 4.17.4 验收（同 90 题 / 同判官 scm-flash / 同库 / 串行，报告 `.eval-data/bench/bench-longmemeval-oracle-20261103-165006-1eb3ab4c.json`）
| 指标 | step9（无提速，1 线程无截断） | step12（本次：2 线程 + docCap 320 + 4s 预算） |
| --- | --- | --- |
| genCorrect | 72/90 = 80.0% | **72/90 = 80.0%（逐题不变）** |
| refused | 17.8% | **15.6%（14 题）** |
| turnCov / sessionCov | 91.6% / 98.9% | **93.6% / 98.9%** |
| MRR / nDCG | 0.774 / 0.837 | 0.772 / 0.828 |
| 端到端召回延迟 mean/p50/p95/max | 6814*（并发污染）/ — | **1657 / 1451 / 3173 / 5696 ms** |
| `gates.rerank.ms` p50/p90/p95/max | 4515 / 10658 / 12221 / 14305 ms | **299 / 658 / 765 / 1944 ms** |
| rerank 累计耗时（90 题） | 485s | **31.7s（15.1×）** |
| `presentation` | fusion 90/90 | fusion 90/90 |
| 曾超时的两题 | 4b24c848 / 06db6396 超时退出 | 4b24c848 rr=1944ms 判对、06db6396 rr=847ms 判对 |

\* step9 与另一臂并发共用同一 bench store，延迟不可用；step9 的生成指标本身有效。

**结论**：提速档 **不损失**生成正确率（72/90 逐题同分），把精排从「吃穿 60s 预算」压到
「p50 0.3s、p95 0.8s」；生产插件 `recallTimeoutMs=2500` 下也留足余量。

### 4.17.5 生产生效证据（2026-11-04 00:54 重启，用户当场授权）
- `GET /health` → `warmup.rerankMs = 2333`（此前为 0 = rerank 未启用），日志
  `[rerank] startup warmup done in 2331ms (scores=32, docs=32)`。
- 真实召回 journal（`data/logs/recall/recall-journal-team-2k12lgb650-agt-2m7buribzz.jsonl`）
  首条带精排记录：`gates.rerank = {provider:"local", ms:3810, kept:2, dropped:29, presentation:"fusion"}`。
  3.8s 高于 bench p50，原因是重启后 `pipeline-v2` boot recovery 重挂 406 会话造成 CPU 争抢
  （同一份代码在空载实测 32×500 字符 = 1848/1660/2486ms）。

### 4.17.6 诚实边界
1. **docCap 截断的语义风险**：长 turn（p75 2151 字符）只按前 320 字符打分，若相关陈述落在尾部，
   精排可能降权。本臂未见损失（72/90 与无截断档逐题相同），但这是**单臂**证据；单臂噪声带 ±2–4 题，
   故只敢声明「未观测到退化」，不声明「证明无论文无损」。
2. **生产争抢期延迟可翻倍**（3.8s vs 1.7s）。硬预算因此定 6s（争抢实测 3.81s 的 1.57×）而不是 4s——
   4s 只剩 0.2s 余量，一次争抢就会误降级（本次无精排 + 熔断计一次，三次连败熔断 60s）。
   真到 6s 仍会降级原序（presentation 仍记 fusion、kept 记降级前值），属预期失败模式而非静默错答。
3. 本轮只验证 loongmemeval oracle 这一档；其它数据集/写入侧不受本改动影响（rerank 只作用于读侧选行）。


## 2026-11-04 增补 §4.18：注入预算标准档重标定为 6000（三条「让预算花得出去」的机制）

### 4.18.1 问题：旧曲线把「预算花不出去」误读成「加预算无用」

11-03 曲线（1600 → 0.744 / 2400 → 0.778 / 3600 → 0.789）据此把 2400 定为标准档。11-04 逐题取证
推翻其解释：61f8c8f8 的候选池 10 条、金标轮排第 1，块里 0 条来自该会话——同会话一条 ~1200 字
assistant 长回答独占预算，块只装 3 行、1287 字预算空转。此时加预算买到的只是「那条长轮更多铺陈」。

### 4.18.2 机制（三条，全部代码缺省、无配置键）

| 机制 | 位置 | 口径 |
| --- | --- | --- |
| 证据窗单行份额 3/5 | `injection-stage.ts:370-375`、回填 `:757` | 窗预算 = min(maxChars, max(200, ⌊maxChars×3/5⌋))；一条证据最多六成 |
| 跨会话份额 3/5 | `layer-ruler.ts:39-40`、`:64` | 字符预算步单个来源会话最多吃 3/5；仅跨 ≥2 会话生效 |
| 残预算回填 + 窗填满 | `injection-stage.ts:740-770`（§4.10） | 仍有 ≥200 字预算时把已入选窗行按份额扩回 |

**被否决形态（不采用）**：给超预算行「全量 maxChars」的窗（win 臂）——一条长轮独占整块，
afdc33df/35a27287 的块从 5–6 行塌成 1 行，偏好题其它证据全灭。

### 4.18.3 标定

16 道失败题探针：4000 → 7/16（refused 37.5%、blk 4312）、**6000 → 9/16（25.0%、5583）**、
12000 → 8/16（25.0%、8028）⇒ 6000 与 12000 同档。

全 90 题（同库、串行、`--rerank-on`）：
| 臂 | genCorrect | refused | blockChars | 端到端 p50/p95 | 精排 p50/p95 |
| --- | --- | --- | --- | --- | --- |
| 2400（四臂） | 76 / 73 / 75 / 74 | 13.3–18.9% | ≈2600 | 1562 / 3348 | 375 / 799 |
| **6000（首臂）** | **83/90 = 92.2%** | **5.6%** | 5817 | **1456 / 2397** | **324 / 699** |
| 6000（复跑 full6k-b） | 80/90 = 88.9% | 5.6% | 5866 | 1475 / 3358 | 333 / 833 |
| 6000（三臂 full6k-c） | 82/90 = 91.1% | 4.4% | 5797 | 1640 / 2772 | 419 / 1136 |
| 对照 default6k（不带 --inject-json） | 74/90 = 82.2% | 13.3% | 2721 | 1505 / 3045 | — |

报告 `.eval-data/bench/bench-longmemeval-oracle-20261104-045653-1eb3ab4c.json` /
`…-052019-1eb3ab4c.json`。三臂 83/80/82 ⇒ 稳定估计 ≈ **90.7%（81.67/90）**，单臂离散 ±3 题，三臂均 ≥85% 门；
端到端 p95 三臂 2397/3358/2772ms 均 < 4s。精排 p95 699/833/**1136**ms：第三臂与 `typecheck:gate`
（tsc 全量）并发、p50 亦从 324/333 抬到 419ms，属 CPU 争用上界；串行两臂均在 1s 内。

### 4.18.4 三臂失败并集（14 题）与诚实边界

「三臂全失」4 题：157a136e、gpt4_ab202e7f（4 vs 5 件聚合）、ba358f49（`sessionCov=0.5`，线索在
同会话另一轮从未进池）、71017277（aunt 未召回）；「两臂失」5 题：a2f3aa27、75832dbd、afdc33df、
7405e8b1、gpt4_f49edff3；「一臂失」5 题：2318644b、35a27287、195a1a1b、75f70248、efc3f7c2。
157a136e/ba358f49 属检索层候选池缺料，非装载层；其余多为偏好题细节与多会话聚合（判分噪声带内翻转）。
偏好类对窗化边界敏感，留给「偏好题证据挑选」专项，本轮不动窗化比例。
**生产生效前置**：`default6k` 臂（不带 `--inject-json`）实测 74/90、blockChars 2721 ⇒ 生产
`config-override.json` 顶层的 `injection.maxChars = 2400` 经 `applyInjectionOverrideToRaw`
（`gateway/config.ts:325-343`）盖住了代码缺省；**删掉该键 + 重启 core 才让 6000 档生效**（均需用户授权）。
写侧（捕获/提取/L1/L2/L3）本轮零改动。

### 4.18.5 生产路径干跑：删键后的解析结果（2026-11-04，未触碰生产配置）

把生产 `config-override.json` 复制到 `D:/tmp/drydata` 并**只删除 `injection.maxChars` 一键**，
其余键与 `calibration/` 原样带上，以 `TDAI_DATA_DIR=D:/tmp/drydata` 调真实 `loadGatewayConfig()`：

```
{"base":"D:/tmp/drydata","maxChars":6000,"foldIdentical":true,
 "budgetByIntent":{"empty":0,"continuation":1,"self":null,"info":null}}
```

⇒ 只删这一个键就落回标准档 6000，其余 override（`foldIdentical=true`、`budgetByIntent` 四项）逐位保留。
契约固化为 `src/gateway/__tests__/injection-standard-default.test.ts`（3 例全绿）：无显式预算 → 6000、
显式 2400 → 2400（回滚通道不封）、显式 null → 不限。
### 4.18.6 生产路径全 90 题臂（干跑副本跑 bench，2026-11-04）

不只验解析，还要验行为：不带 `--inject-json`，以 `TDAI_DATA_DIR=D:/tmp/drydata`（生产 override 副本，仅删
`injection.maxChars` 一键）跑完整 90 题，沙箱库与判官不变。

| 臂 | genCorrect | refused | blockChars | 召回 p50/p95 | 精排 p50/p95 |
|---|---|---|---|---|---|
| prodpath-6k | 81/90 = 90.0% | 5.6% | 5853.7 | 1489/3225ms | 330/1072ms |
| prodpath-6k-b | 81/90 = 90.0% | 5.6% | 5865.5 | 1506/3225ms | 245/1072ms |

⇒ 行为与显式 6000 臂同档（四臂 83/80/82/81，均值 90.6%），blockChars 5853–5866（≤6000 注入行 + ≈434 wrapper）。
两次过程失败留档：① `--expect-config recall.injection.maxChars` 恒报「实际 null」，因
`scripts/lib/bench/effective-config.ts:42-87 snapshot()` 白名单不含 recall.injection（改白名单会变
`config.fingerprint` 且需重跑基线 → 本轮不改 bench，遗留项）；② `TDAI_DATA_DIR` 指向临时目录时
`factory.ts:37-45` 把模型目录解析到临时目录导致 `local.ts:156-158` 判定未就绪、`triggerDownloadAndDegrade()`
返回 null（`auto-recall.ts:870` 记「降级原序」），首次臂 40 题内 6 次；用 `mklink /J drydata/models → 真实模型目录`
后复跑两臂 0 次 null。⇒ 起 bench 前必须保证模型目录可达，否则精排静默降级。

精排 p95 的边界：四臂 699 / 833 / 1136（与 tsc 并发）/ 1072ms ⇒ **<1s 只在无并发争用时成立**；
p50 稳定 245–419ms。隔离压测（32 候选 × 320 字符连打 40 次）p50 1764ms / p90 5227ms 且第 18 次触发 4s
`inferTimeoutMs` 击杀 ⇒ 4s 硬预算只在持续满载下会被打穿；端到端召回 p95 3225ms <4s 稳定成立。


### 4.19 精排尾延迟：滚动打分预算（2026-11-04）

#### 4.19.1 问题

精排原为「整池单次打分」，耗时 = 池子大小 × 单条长度 × 机器争用。实测四臂 p95 在 699 / 833 / 1136 / 1072ms
之间漂移（只有无并发争用的两臂 <1s）；隔离压测（32 候选 × 320 字符连打 40 次）p50 1764ms / p90 5227ms，
第 18 次打穿 4s `inferTimeoutMs` 返回 null。⇒ 尾延迟由工作量决定，无法靠调 provider 参数稳定。

#### 4.19.2 机制

| 机制 | 位置 | 作用 |
|---|---|---|
| 滚动打分预算 | `src/core/recall/rerank/score-budget.ts`（400ms / chunk 4 / 单块宽限 250ms） | 每块前检查预算，到点即停；已评块保留，未评候选按融合原序垫尾（`unscored` 进 gate） |
| 冷启动预热 | `LocalReranker.warmup()`（`rerank/local.ts`） | 模型加载（实测 1430ms）移出打分预算，否则首块必超时 |
| 放弃不计故障 | `auto-recall.ts` 的 `softTimedOut` | 预算到点不推熔断，否则 3 题连丢即 open、后续题全跳过精排 |
| 预热计时单列 | `gates.rerank.warmupMs` | 把「加载」与「打分慢」拆开，避免冷启动被误读成尾延迟 |

四条均无配置键：生效即缺省（同 §4.10 的纪律）。池子 ≤4 条退化为单次整池调用；云 provider 保持单次。

#### 4.19.3 被否决形态（实测，非推断）

- `chunk=6 / budget=700ms`（只做块间检查）：精排 p95 1390ms、max 1910ms。
- `chunk=3 / budget=300ms`：p95 **1557ms** —— 块越碎，慢块的暴露面越大，尾巴更长。
- `软超时即 terminate worker 取消在途推理`：onnxruntime 推理中 terminate 会让进程原生崩溃（**exit 127**，
  90 题臂复现两次、无 JS 栈；二分唯一差异即该调用）。⇒ 撤销，`cancelPending` 从接口移除。
- `warmup 后不设预算`（=原行为）：p95 1072ms。

#### 4.19.4 证据（同库 longmemeval-oracle-mw0axwpe、scm-flash、--no-write-steps、指纹 65c9f0a9）

| 臂 | genCorrect | refused | 精排 p50 / p95 | 精排 max | 备注 |
|---|---|---|---|---|---|
| armR1（无预算） | 79/90 = 87.8% | 5.6% | 1022 / 3181ms | 4466ms | 插桩臂 |
| armR2（700/6） | 82/90 = 91.1% | 6.7% | 723 / 1390ms | 1910ms | 块间检查不足 |
| armR3（300/3） | 79/90 = 87.8% | 5.6% | 470 / 1557ms | 2877ms | 更碎更慢 |
| armR4（400/4 + race） | 83/90 = 92.2% | 4.4% | p90 516 / p95 544ms | 957ms | **不可用**：61/90 题 ms=0（冷启动撞预算→熔断 open） |
| armR5b（400/4/250 + warmup） | **83/90 = 92.2%** | **4.4%** | **509 / 666ms** | 2410ms | 熔断零跳过、null 0 次 |
| armR6（同 + warmupMs） | **81/90 = 90.0%** | 5.6% | 504 / 654ms（扣 warmup） | 667ms（扣 warmup） | 仅 1 行带 warmupMs=1430 |

报告：`bench-longmemeval-oracle-20261104-071922-65c9f0a9.json`、`…-073111-65c9f0a9.json`。
质量不退化：turnCov 95.3%（历史 93.6%）、sessionCov 98.7%、MRR 0.779、nDCG 0.835、blockChars 5850–6348。
扣掉 warmup 后精排 p95 654ms / max 667ms = 预算 400 + 宽限 250 的机制上限 ⇒ 「p95 <1s 且稳定」由机制保证。

#### 4.19.5 bench 观测面缺陷（已修）

`--expect-config` 读的是 `MemoryCore/scripts/lib/bench/store.mjs:1071` 的 `effectiveRecallSnapshot(cfg)`（不是
`scripts/lib/bench/effective-config.ts:42` 的同名函数，后者只服务 readEffectiveBenchConfig/formatEffectiveConfig）。
已补 `recall.injection.{maxChars,maxLineChars,foldIdentical,budgetByIntent.*}` 7 键（快照 19→29），
多键必须写成单个逗号串（`arg("expect-config")` 只取最后一次）。副作用：`config.fingerprint` 变化一次
（1eb3ab4c → 65c9f0a9）。
