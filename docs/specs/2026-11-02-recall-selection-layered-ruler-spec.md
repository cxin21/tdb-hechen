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
4. **0 行是合法结果**：任何代码路径不得把 0 行当错误，也不得回退成「全收」。
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
recall.layerRuler:
  mode: off | shadow | enforce      # 代码缺省 off（逐位现状）
  keepRatio: 0.67                   # 0-1，>0；每层至少 1 条
  minPerLayer: 1
  lengthLambda: 0                   # v2 名次折扣（0 = 纯余弦）
  margin: null                      # v2 层内相对 margin
  dedupeSim: null                   # v2 近重复抑制
  budgetMs: 300                     # v3 单轮选线预算（50..5000 ms）；生产 800
  floor: null                       # {model, dims, value}，null = 不设地板
injection:
  foldIdentical: false              # 代码缺省 off；yaml 在 shadow 通过后开
  maxLineChars: null                # v2 单行渲染上限
  maxChars: null                    # v3 本轮注入总字符预算；生产 600
  budgetByIntent: {empty: 0, continuation: 1, self: 1, info: null}
```
- 所有新键缺省值 = 今天行为（config-first 纪律）。
- `mode: shadow` 只记 `wouldDrop`，不改注入。

### 4.4 标定产物
- 位置：`data/calibration/embedding-sim-floor.json`，键 = `model@dims`，值 = 由 null-probe（查询 × 无关行）分布取 p95 得到的相似度地板，附测量日期与样本量。
- 读取失败/键缺失 → `floor = null`（诚实 no-op），journal 记 `floorSource:'uncalibrated'`。

### 4.5 降级与失败语义
- 语义通道不可用 → 沿用现有字面判据，注入行为与今天一致；journal `ruler:{mode, bypass:'ruler-unavailable'}`。
- 地板过滤导致某层全空 → 该层 0 行，不补位、不放宽。
- 任何路径不得 fallback 到「注入全部候选」。

### 4.6 可观测
- journal 新增：`selection.kept`、`selection.droppedBy={rank,floor,budget,fold}`、`ruler.mode`、`ruler.floorSource`、`fold.identicalLines`。
- **候选级埋点（本票范围内）**：journal 新增 `candidates.total`、`candidates.byLayer={层:条数}`、`candidates.bm25Exempt`（豁免 BM25 地板的条数）、`candidates.lines[]`，每项 `{layer, hash(前8位), scoreQ(相似度分位 0-100 整数), bm25Rel, kept, droppedBy}`。
  - 目的：今天 journal 只有注入结果，看不到「候选池 15 条 → 注入 3 条」之间被谁砍掉；没有这一面，名次切/地板/预算的账无法逐轮核对，后续标定也无从取数。
  - 有界：`candidates.lines` 最多 40 条（超出只记汇总 + `truncated:true`）；不记正文，只记哈希与分位，单轮增量目标 < 4KB。
  - 独立于 `mode`：`off` 也记录（这是观测面，不是行为开关），但 `off` 下 `droppedBy` 恒为 `{rank:0,floor:0,budget:0,fold:0}`，便于对照。
- 不记录行全文（避免 journal 膨胀），记行哈希 + 层名 + 分数分位。

### 4.7 与既有机制的边界
- 不动 rerank 开关与本地 ORT（G2 另票）。
- 不动结论层字符截断（#178 已关，属另一问题）。
- 不删任何记忆（零删红线）。
- 不接管人格块/soul block（自指轮 0 行即由人格层承接）。

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

### v3 增补（2026-11-02 下午，同票二轮）

10. **单轮预算抬到 800ms（差异 1 的反转）**：`layerRuler.budgetMs` 落地为可配（50..5000，缺省 300 = 规格验收门 e 的严值），生产写 800。原因：实测火山 Ark `/embeddings`（doubao-embedding-vision@2048）单次 RTT 111–382ms（p50≈175、p75≈300），300ms 预算下「查询嵌入一次」就可能到点 —— 真机 18 轮实测 bypass 约 2/3，即名次与地板在生产基本没生效过。切 800 后同批实测 bypass 1/18=5.6%、p50 340ms、p95 814ms。代价：慢轮最长多等 0.5s（仍在 /v3/recall 5000ms 硬超时内）。
11. **地板 p50 → 0.30（差异 2 的修订）**：p50=0.3126 会丢掉 golden P3 的 high（cos 0.311），这是「单阈值必丢好行」的直接证据。0.30 在 golden 上：无预算时 high 召回 0.900→1.000；配合 maxChars 600 时 high 0.900、lowKeep 0.346、字符降 88.2%、0 行轮 1/10、**「整轮丢光 high」的轮数 0**。生产 24 轮重放：98 行/26379 字符 → 50 行/9638 字符（降 63.5%）、0 行轮 0。唯一代价：P6 一条 431 字 high 被同轮 596 字 high 挤出 600 预算（kept 1/2，该轮仍有 high 注入）。
12. **新增 `injection.maxChars`（字符预算）——真正的压缩器**：名次尺按比例保留，压缩上限由总字符决定。golden 网格 500/600/700/800/900/1200：500 太紧（high 0.700）、600 与 700 逐位同、800 起 lowKeep 回升；取 600。代价已计入差异 11。`lengthLambda` 在 600/800 预算下 0/.04/.06/.08/.10 **零影响**（≥0.12 反而丢掉 P6 两条 high）→ 生产 `lengthLambda: 0`。`dedupeSim` .92/.95 在 golden 与生产 24 轮上零影响（近重复对已被地板/预算挡住）→ 生产留 null。
13. **bypass 时的字符兜底 + 零行纪律（规格 §4.5「任何路径不得 fallback 到注入全部候选」的落地加严）**：bypass 且配了 maxChars 时按候选原序贪心装填、其余记 `droppedBy.chars`、写 `ruler.fallback='char-budget'`；**装得下 0 行也照样接管**（早期实现在 size=0 时跳过 → `judgeKept=null` → 退回全量注入，等于预算被静默绕过，已由装配层用例咬住）。选线判空时整段不输出（不再吐空壳 `<relevant-memories>`）。观测面新增 `selection.poolChars` / `selection.injectedChars`：`memoryLines` 是候选池（选前），用它算「是否超预算」会得出反结论（实测把 562 字符注入误读成 1400）。

回退：`layerRuler.mode` 改回 `off`（或整段删除）→ 注入路径与改动前**逐位一致**（有 `mode:off 与改动前逐位一致` 用例 + 离线重放 off 列作证），不需要回滚代码；改完必须重启 core（配置仅启动时读）。

