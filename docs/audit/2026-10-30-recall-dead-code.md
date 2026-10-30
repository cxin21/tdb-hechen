# 召回链路死码与重复实现审计（MemoryCore）

> 审计对象：`MemoryCore/src/core/hooks/auto-recall.ts`（4312 行，注入主流程）及其召回/记录侧依赖
> 审计方式：只读静态走查 + grep 计数；**未运行测试、未修改任何源码**
> 审计日期：2026-10-30
> 结论口径：每条都带 `file:line` 与可复现的 grep 命令；无法用行号证明的猜测一律不写

---

## 0. 前提修正：这不是"一套基线"，是两套

任务书假设的「生产缺省配置」= 代码缺省（全部关闭）。仓库里同时存在**第二套更高优先级的基线**：

**`deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml`**（生产部署模板，注释更新到 2026-10-29）显式把很多"代码缺省关"的开关打开了：

| 项 | 代码缺省 | 生产 yaml | 后果 |
|---|---|---|---|
| `recall.foldClusterEnabled` | false（config.ts:2209） | **true（:146）** | F-CLUSTER 在生产是**活的** |
| `recall.timeProxFallbackEnabled` | false（:2206） | **true（:247）** | 时间锚回退活着 |
| `recall.rerank.enabled` | — | true / provider local / candidates 32 | 精排活着 |
| `recall.conclusionLayer.routing` | "off" | **"assistantRecall"** | 结论层路由活着（intent 分支仍死） |
| `recall.conclusionLayer.minBm25RelRatio` | 未设 | 0.4 | R71 地板活着 |
| `recall.smallToBig.enabled / budget` | false / "shared" | **true / "additive"** | 回填活着，slot 分支死 |
| `recall.dynamicTopK.enabled` | false | **true** | elbow 收缩活着 |
| `recall.nativeMinRRF` | 0 | **0.016** | native 门槛活着 |
| `recall.importancePenalty.enabled` | false（config.ts:2127-2132） | **true / 0.3** | 降权活着 |
| `recall.graphDiscount / sceneBoost / coreRefBoost` | 0.6 / 0.04 / 0.05 | **0 / 0 / 0**（:177-179） | 图/场景/coreRef 三通道在**生产**退出 |
| `recall.emotionSalienceWeight` | 0 | **0（:212，注释「未过 A/B 不得置正」）** | 情绪通道两基线皆死 |

**yaml 里完全不存在的键**（= 代码缺省生效，两套基线都无法打开）：
`recall.injectTimeSort`、`recall.injectWrapper`、`write.factRows`、`recall.mmr`、`recall.presentTemporal`、`conclusionLayer.pairing`、`conclusionLayer.arbitrate`、`conclusionLayer.slotCost`、`importanceGate`。

复现：
```bash
cd D:/TDB/td-agemem
grep -n 'foldClusterEnabled\|timeProxFallbackEnabled\|injectTimeSort\|injectWrapper' deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml
# → 146: foldClusterEnabled: true / 247: timeProxFallbackEnabled: true（injectTimeSort、injectWrapper 零命中）
grep -rn 'injectTimeSort\|injectWrapper' --include=*.yaml . | wc -l   # → 0
```

因此下文 A 类分三档：
- **A-1 真死码**：两套基线都不可达（最该删）
- **A-2 仅代码缺省下不可达**：生产 yaml 已开（不算死码，但"缺省配置"下是死的，改动前需知）
- **A-3 仅生产 yaml 下不可达**：代码缺省活着，生产关掉了（图/场景/coreRef/情绪通道）

---

## A. 不可达分支

### A-1 两套基线皆不可达（真死码）

#### A-1-1 `injectTimeSort` 时间序打包 —— auto-recall.ts:2036-2037
```ts
const orderedLines = cfg.recall?.injectTimeSort?.enabled === true
  ? sortLinesByLeadingTimestamp(memoryLines)   // ← 永不执行
  : memoryLines;
```
- 干什么：注入前把召回行按行首时间戳重排（bench/recall-opt G1 的"时间序打包"）。
- 为何死：代码缺省 false（config.ts:2198-2200），生产 yaml 无此键，全仓 yaml 零命中。
- 连带：`src/core/hooks/inject-order.ts:21 sortLinesByLeadingTimestamp` 生产**零调用**。
- 测试：`src/core/hooks/__tests__/inject-order.test.ts` 有 9 个 it（:14-80）测纯函数 + 3 个 it（:83-96）测 config 解析（"缺省 = 关 + legacy"）。**没有任何集成测试把它翻到 true 跑一遍 performLayeredRecall**。
- 建议：删开关与调用点（保留 `inject-order.ts` 纯函数与测试无成本，但调用点应删）。

#### A-1-2 `injectWrapper` neutral 包裹语 —— auto-recall.ts:2041-2045
```ts
const wrapperHead = cfg.recall?.injectWrapper === "neutral" ? "<neutral 句>" : "以下是当前对话召回的相关记忆，…仅作为参考：";
```
- 干什么：#G1-b 的包裹语文案消融（neutral vs legacy 两种口吻）。
- 为何死：config.ts:2202-2205 `return raw === "neutral" ? "neutral" : "legacy"`，yaml 无键 → 恒 legacy。
- 测试：同 inject-order.test.ts:83-96（只测解析与回落）。
- 建议：若 A/B 已裁决，删 `injectWrapper` 类型 + 解析 + 三元，硬编码选中文案。

#### A-1-3 事实行读侧投影整套 —— auto-recall.ts:3752-3788 + fact-turn.ts:107-190
```ts
if (sorted.some(([, v]) => v.formatable.factOf)) {        // :3752 恒 false
  const collapsed = collapseFactRowsByTurn(sorted, …, {    // :3753
    superseded: supersededRows, phraseOf: …, valueOf: …,
  });
  …
}
```
- 干什么：#146 W2b —— 事实行按 `fact_of` 折叠回父 turn（省槽位），#166 —— present-intent 下把 stale 值所在的 turn 降级为"事实短语"或整条剔除。
- 为何死（**因果链完整**）：
  1. `fact_of` 唯一写入点 `record/fact-row.ts:187`（`FACT_ROW_META.factOf`），只被 `factRowMetadata()` 调用；
  2. `factRowMetadata()` 只在 `l1-writer.ts:587 if (factRowsActive)` 分支里用，而 `factRowsActive = factPlan.hasFacts`（:373）来自 `factRowsEnabled(writePolicy)`（:365）；
  3. `write-policy.ts:77 DEFAULT_WRITE_POLICY` 里**没有 factRows 键**（注释："缺省策略：全关 = 与既有行为逐位一致"），生产 yaml 也无 `write.factRows`；
  4. ⇒ 任何库里都不存在 `metadata.fact_of` ⇒ `:3752` 的 `some()` 恒 false。
- 测试：`core/recall/__tests__/fact-turn.test.ts`、`core/hooks/__tests__/auto-recall-fact-mask.test.ts` 都有，且**直接驱动 searchHybrid / 纯函数**，手工构造 `fact_of` fixture —— 证明"代码是对的"，但不证明"生产能喂进数据"。
- 建议：**整块删除**（见 A-1-4、D 节）；若产品决定保留 factRows 路线，则必须同时打开 `write.factRows` 并补一条端到端测试，否则就是永久死码。

#### A-1-4 fact-turn #166 遮蔽分支 —— fact-turn.ts:114-148
```ts
const staleByTurn = new Map<string, readonly string[]>();
if (opts?.superseded && opts.superseded.length > 0) {   // :116 无 superseded 则整段跳过
  …
  if (polluted) {
    const phrase = opts.phraseOf?.(entry);
    if (!phrase || masked === …) continue;              // :145 剔除
```
- 干什么：turn 被污染时，存活行改写为事实短语；短语缺失或仍含旧值 → 剔除。
- 为何死：**双重不可达**
  1. hook 路唯一带 `opts` 的调用点在 A-1-3 的死 guard 内（:3753）；
  2. 工具路 `core/tools/memory-search.ts:1520` `collapseFactRowsByTurn(exclResults, factOfOfResult, (r) => r.score)` **不传第三参 opts** ⇒ 即使有事实行，只要走工具路，遮蔽分支结构性不可达。
- 测试：fact-turn.test.ts 覆盖遮蔽语义（纯函数），无生产路径测试。
- 建议：随 A-1-3 一起删；若要保留，至少让 memory-search 传 opts 并补端到端。

#### A-1-5 soft 失效档 —— auto-recall.ts:3676-3705
```ts
if (excludeInvalidated === "soft") {        // :3676 恒 false
  const sel = selectByValidity(sorted, { mode: "soft", … });
  … rrfScore * SOFT_VALIDITY_PENALTY …
```
- 干什么：#136 软失效——expired 行降权保留而非硬删。
- 为何死：config.ts:2154 `excludeInvalidated: bool(...) ?? true`，生产 yaml `:206 excludeInvalidated: true`，validity.mode `"hard"`（:210-211）⇒ 恒走硬过滤。
- 连带：`core/recall/validity-policy.ts:125 selectByValidity`、`:70 SOFT_VALIDITY_PENALTY` 只服务此分支（工具路另有调用，见 B-3）。
- 测试：`auto-recall-soft-validity.test.ts` 存在（按 15 位置参数的第 10 位传 `"soft"` 驱动 searchHybrid）——同样是"能测不能达"。
- 建议：保留并注明"实验档"，或删掉 `"soft"` 枚举值让类型系统强制唯一口径（推荐后者，能防误配）。

#### A-1-6 结论层 intent 矩阵：pairing / slotCost / arbitrate / turn-first / conclusionBudget
| 行 | 分支 | 打开条件 | 现状 |
|---|---|---|---|
| auto-recall.ts:1393-1394 | `r7PairingRequire` | `s2bCfg.enabled && (pairing==="require" \|\| r7Policy.pairing)` | 死（pairing 键不存在；r7Policy 需 routing=intent） |
| auto-recall.ts:1395 / 1598 | `r7SlotMode` | `s2bCfg.budget === "slot"` | 死（yaml additive；缺省 shared） |
| auto-recall.ts:1412 | 上述二者的 extra 预算 | 同上 | 死 |
| auto-recall.ts:1520-1530 | pairing 强制配对块 | `r7PairingRequire` | 死 |
| auto-recall.ts:1761-1763 | `r7ArbitrateEnabled` | `arbitrate==="redundant" \|\| r7Policy.arbitrate` | 死（键不存在） |
| auto-recall.ts:1849-1900 | `r7TurnFirst` 备用装配 | `r7Policy?.order === "turn-first"` | 死（见 A-1-7） |
| auto-recall.ts:1248-1249 | `r7Policy.conclusionBudget` | routing=intent | 死 |

- 机制：`recall/query-intent.ts:92-101 INTENT_POLICY` 定义了 7 类意图的 (budget, pairing, order, arbitrate)，但 `r7Policy` 只在 `r7RoutingMode === "intent"` 时产生（auto-recall.ts:1080-1082），而两套基线都不是 intent（缺省 off / 生产 assistantRecall）。
- 测试：**零**。`grep -rn -E 'routing:\\s*["']intent|pairing:\\s*["']require|arbitrate:\\s*["']redundant|budget:\\s*["']slot' --include=*.test.ts src` → 0 命中。
- 建议：整套 #141 分阶段路由（含 query-intent.ts 191 行）标记为"未上线实验"，删除或移入 bench 包；不要留在生产类型里。

#### A-1-7 turn-first 备用装配（同一件事的第二套编排）—— auto-recall.ts:1849-1900
- 干什么：意图为 turn-first 时，重新走一遍 fts-only cap → 预算 → `assembleLayeredLines`，顺序与 else 分支不同（:1876/:1886 两处三元重复同一选择）。
- 为何死：需要 `routing="intent"` 且意图命中 turn-first；实测两基线均不满足。
- 测试：无（同上 grep）。
- 建议：删除——这是 performLayeredRecall 内**唯一残留的重复装配**（见 B-4）。

#### A-1-8 recall MMR —— auto-recall.ts:830-834 / 1728 / 906
```ts
if (mmr?.enabled && passIdxs.length > 1) { … mmrReorder(…) }   // :830 恒 false
```
- 为何死：`:1728 cfg.recall?.mmr?.enabled ? {…} : undefined`；`recall.mmr` 缺省 false（config.ts:2409-2418 `enabled ?? false`），yaml 无此键（yaml:469 的 `mmrLambda: 0.7` 是 `soulRender.anchorSelect.scorer`，不是召回 MMR）。
- 测试：**零**（`grep -rln 'mmr' --include=*.test.ts` → 只有 soul-quality-round.test.ts，测的是 anchorSelect）。
- 建议：删除调用点与 `recall/mmr.ts`（53 行），或明确标注"实验轨未上线"。

#### A-1-9 情绪显著度比较器 —— auto-recall.ts:3441-3446
```ts
if (emotionWeight > 0) { const aEmo = emotionSalienceOf(…) * emotionWeight; … }
```
- 为何死：`emotionWeight = signals.emotionSalienceWeight`；代码缺省 0（recall-signals.ts:108-119），生产 yaml 显式 0（:212）。
- 测试：recall-signals.test.ts 有单测，但比较器本身只在 weight>0 时执行。
- 建议：保留（守卫写得很干净，零开销），在 config 注释处保留"未过 A/B 不得置正"即可 —— **不建议删**，因为这是唯一合规的实验入口。

#### A-1-10 `displayContent ?? content` 的死哑支 —— auto-recall.ts:3949-3951
```ts
let line = `- [${tag}] ${m.displayContent ?? m.content}`;
```
- `displayContent` 只会被 A-1-3 的折叠块（:3763-3767）写入 ⇒ 生产恒 undefined ⇒ 恒走 `m.content`。
- 建议：随 A-1-3 一起删；`FormatableMemory.displayContent`（:3935）字段同删。

#### A-1-11 零生产 caller 的已死导出
| 位置 | 函数 | 证据 | 建议 |
|---|---|---|---|
| record/`filter-invalidated.ts:37` | `filterInvalidated()` | 注释自述"兼容保留（无生产 caller）"；grep 非测试 0 调用 | 删 |
| hooks/`recall-fold-cluster.ts:61` | `foldSameSourceDuplicates()` | 仅测试 import | 删 |
| hooks/`recall-fold-cluster.ts:127` | `foldClusterAware()` | 仅测试 import（生产用 `…WithMeta`） | 删 |
| hooks/`auto-recall.ts:220` | `foldNearDuplicates` | 生产活（:2040），但工具路零调用 → 见 B-1 | 保留，补工具路或注明仅钩子路 |

### A-2 仅"代码缺省"下不可达（生产 yaml 已开）

| 位置 | 分支 | 缺省 | 生产 yaml | 建议 |
|---|---|---|---|---|
| auto-recall.ts:2665-2667 | `foldedNative = foldClusterEnabled === true ? foldClusterAwareWithMeta(…) : undefined` | false | true → **活** | 保留；但注意与 :2040 串成双层折叠（B-1） |
| auto-recall.ts:2711-2715 | 同上（fallback 分支） | false | true → 活 | 同上 |
| auto-recall.ts:2655 | `nativeMinRRF > 0` 门槛统计 | 0 | 0.016 → 活 | 保留 |
| auto-recall.ts:1824-1828 | `dynamicTopK` elbow 收缩 | false | true → 活 | 保留 |
| auto-recall.ts:1094-1102 | `r7ConclusionRoutingOff` 跳过结论层 | routing off → false | assistantRecall → 视查询而定 | 保留（生产有效） |
| auto-recall.ts:3726-3740 | `r7AgeDecay` 半衰期衰减 | ageDecay 未设 | true / 14d → 活 | 保留 |
| auto-recall.ts:1677 | `needValues` → 调 `computeRecallValueSignals` | coreRefBoost 0.05 ⇒ true | 0 ⇒ **false**（跳过） | 生产省了一次 store 读，正常 |
| auto-recall.ts:1681-1683 | `graphDiscount 0.6 / sceneBoost 0.04 / coreRefBoost 0.05` | 非零 | **0/0/0** ⇒ A-3 | 见 A-3 |
| auto-recall.ts:1661 | `presentTemporalBoost` | 0 | yaml 无键 → 0 | 见 A-1 之外的"presentTemporal 死" |
| auto-recall.ts:3155 | `signals.presentTemporalBoost > 0 && rankSignal.presentTemporal` | 0 | 0 | 死（两基线）→ 归 A-1，见下 |

> 补 A-1：`presentTemporal`（当下时态加成）——config.ts:2135-2142 `enabled ?? false`，yaml 无键；消费点 auto-recall.ts:3155 与 :1707 都要求 `presentTemporalBoost > 0` ⇒ **两基线皆死**。测试 `auto-recall-present-temporal.test.ts` 有 7 处引用，同样只测纯函数/手工参数。建议并入 A-1 删除清单（或与 A-1-9 一起划入"实验轨白名单"）。

### A-3 仅生产 yaml 下不可达（代码缺省活着）

| 位置 | 分支 | 生产 yaml | 影响 |
|---|---|---|---|
| auto-recall.ts:3465+ | PPR 全图扩散（`graph.discount > 0`） | `graphDiscount: 0`（:177） | `core/recall/ppr.ts`（209 行）在生产**零调用**——两个调用点都设了同一守卫：`auto-recall.ts:3465` 与 `memory-search.ts:473 if (opts.graphDiscount > 0 …)`；`getNeighbors` 零调用（代码注释自己写了"graph.discount=0 … 通道退出"） |
| auto-recall.ts:3437+ | `sceneSignalOf` 场景加成 | `sceneBoost: 0`（:179） | 场景通道退出（scene 索引仍被结论层用） |
| auto-recall.ts:1641 / 1677 | `coreRefBoost` / `needValues` | `coreRefBoost: 0`（:178） | coreRef 通道退出，`computeRecallValueSignals` 跳过 |
| auto-recall.ts:3441-3446 | 情绪比较器 | `emotionSalienceWeight: 0`（:212） | 已列 A-1（两基线皆 0） |

- 缺省值出处：`coreRefBoost 0.05` = config.ts:2112-2117；`graphDiscount 0.6 / sceneBoost 0.04 / graphMinStrength 0.5` = config.ts:2148-2150；`excludeInvalidated true` = config.ts:2154。
- 建议：**保留但必须注明**——这是"生产配置把代码能力关掉了"，不是死码。风险点在于：任何按代码缺省做的本地/测试环境会启用 PPR/场景/coreRef，与生产行为不一致；建议在 config 注释里写明"生产基线 = 0"。

---

## B. 重复实现：同一语义的 N 套写法

### B-1 折叠：三套实现 + 两层串联

| # | 实现 | 位置 | 语义 | 生产状态 |
|---|---|---|---|---|
| ① | `collapseFactRowsByTurn` | core/recall/fact-turn.ts:107-190（190 行） | 按 `fact_of` 把 N 条事实行折回父 turn（取最高分）+ #166 值遮蔽 | **死**（无 fact_of，见 A-1-3） |
| ② | `foldClusterAwareWithMeta` = `foldByDurative`(:82) + `foldSameSourceDuplicatesWithMeta`(:26) | core/hooks/recall-fold-cluster.ts:117 | 持续态吸收（evidenceIds 引用图）+ stripMemoryLineMeta 逐字同文折叠，行尾加「·源×n」「·同源×n」 | **活**（yaml:146 true；代码缺省下死） |
| ③ | `foldNearDuplicates` | core/hooks/auto-recall.ts:220（实现）、:2040（唯一调用） | 近似 Jaccard（阈值 0.25）折叠 + 同会话免疫 | **两基线皆活** |

判定：
- ①与②③**不重叠但同域**：①是"事实行→turn"的结构折叠，②③是"文本近重"的文本折叠。①整条不可达。
- ②与③**是串联的两层**，不是重复实现——`recall-fold-cluster.ts:12-13` 头注释写明"先本函数（精确同文）→ 再 foldNearDuplicates（近似 Jaccard）"，生产 yaml 开 ② 后**同一批行会被扫描两遍**（两次 `stripMemoryLineMeta`、两次分组、两次 Map 建表）。属"设计上有意、实现上重复劳动"，建议合并成一次遍历（先精确同文分组，再对组代表做 Jaccard）。
- **钩子路 / 工具路不一致（真正的重复实现缺口）**：工具路 `core/tools/memory-search.ts:1478-1527` 只有 ①（且不传 opts），完全没有 ②③。
```bash
cd D:/TDB/td-agemem/MemoryCore/src
grep -rn 'foldNearDuplicates' --include=*.ts . | grep -v test   # → 只有 core/hooks/auto-recall.ts:220,2040
grep -rn 'foldClusterAwareWithMeta' --include=*.ts . | grep -v test # → 只有 auto-recall.ts:2666,2714
```
  ⇒ 同一份召回结果，钩子注入会折叠、`memory_search` 工具不会。读者会以为"折叠是召回层能力"，实际是"钩子层能力"。
- 附带：`foldClusterAwareWithMeta` 的注释说 metas 缺省时 `foldByDurative` 自动跳过（:83 `if (!metas …) return`）——fallback 分支在 `linesMeta` 未产出时整段空转，属结构性死路（`recall-fold-wire.test.ts` 头注释已记录"缺 metas 字段 → fallback 分支无法执行 foldByDurative"）。

建议动作：②③合并为单一 `foldRecallLines(lines, metas, {sessionOf})`，工具路复用同一函数；①随 factRows 一起封存/删除。

### B-2 时间：五套语义，两套死、一套口径不一致

| 语义 | 实现 | 位置 | 状态 |
|---|---|---|---|
| 注入行按时间戳排序 | `sortLinesByLeadingTimestamp` | hooks/inject-order.ts:21 | **死**（A-1-1） |
| 时间锚回退（缺 occurred_at 用 created_at） | `timeProxFallbackEnabled` | auto-recall.ts:3720 / memory-search.ts:1482 | 活（yaml:247 true） |
| 时近性加成 | `recencyBoost`（last_recalled_at < 24h） | recall-signals.ts（DEFAULT 0.03） | 活 |
| 时间窗命中加成 | `timeBoost` | 同上 0.05 | 活（需窗参数） |
| 半衰期衰减 | `r7AgeDecay` → `applyCompositeRerank` | auto-recall.ts:3710-3713 | 活（yaml 14d） |
| 当下时态加成 | `presentTemporal` | auto-recall.ts:1707 / 3155 | **死**（两基线 0） |

关键发现（口径不一致，不是重复实现，是**同一语义两处不同锚**）：
```ts
// 钩子路 auto-recall.ts:3720
occurredAt: v.formatable.occurred_at ?? (timeProxFallbackEnabled === true ? (v.formatable.timestamp ?? null) : null)
// 工具路 memory-search.ts:1481-1482
occurredAt: r.occurred_at ?? (params.timeProxFallbackEnabled === true ? (r.created_at ?? null) : null)
```
- 钩子路回退到 `formatable.timestamp`（converter 产出，kw 路 = record.timestamps[0]，向量路 = r.timestamp_str）；
- 工具路回退到 `r.created_at`（原始列）。
- 两者在"记录被更新过"或"columns 与 metadata 不同步"时会**给出不同的时间**，而 `applyCompositeRerank` 的 timeProx 权重 0.15（DEFAULT_COMPOSITE_WEIGHTS）足以影响名次。
- 建议：合并到单一 accessor（在 `FormatableMemory`/`tool result` 上收敛成一个 `occurredAtOf()`），并给一条跨路一致性测试（已有 `bitemporal-two-path.test.ts` 可扩展）。

### B-3 失效：五套实现，只有一套活

| # | 实现 | 位置 | 状态 |
|---|---|---|---|
| ① | 写时 supersession | record/supersession.ts:129 `computeSupersessions` + l1-writer.ts:424 `if (vectorStore && supersessionEnabled(writePolicy))` | **死**（yaml+缺省 supersession.enabled=false；config.ts:1162 区） |
| ② | 读时硬过滤（钩子路） | `isOutsideValidityWindow`（filter-invalidated.ts:22）+ auto-recall.ts:3801-3810 | **活**（两基线） |
| ③ | 读时硬过滤（工具路） | memory-search.ts:1509 `filterByValidity(results, params.validityNow, params.excludeInvalidated)` | 活（共用同一谓词，OK） |
| ④ | 读时软失效 | validity-policy.ts:125 `selectByValidity` + :70 `SOFT_VALIDITY_PENALTY` | **死**（A-1-5） |
| ⑤ | 值级遮蔽（present-intent） | fact-turn.ts:114-148 | **死**（A-1-4；且依赖 ① 产出的 valid_end） |

判定：
- ②③是**同一谓词的两个调用点**（设计正确，单一源在 filter-invalidated.ts），不是重复实现；建议保持。
- ②④是**同一状态机的两档**（hard/soft），hard 恒走、soft 永不 ⇒ 代码里两条互斥路径只有一条可达，属"枚举值型死码"。
- ①⑤ 是**因果链**：① 死了 ⇒ 没有 valid_end 由写侧产生 ⇒ ⑤ 无输入。这两套合计约 340 行（supersession.ts 196 + fact-turn.ts 190）在生产不产生任何效果。
- `filter-invalidated.ts:37 filterInvalidated` 是第 6 个（已死导出，见 A-1-11）。

建议：④删除 `"soft"` 枚举（或移到实验分支）；①⑤整体封存并在文件头写"生产不可达：需 write.factRows + write.supersession 同时开启"。

### B-4 复合精排 / 装配：已合并，仅剩一处

- 好消息：文件中曾有两套装配器，`DS-RECALL-MERGE-001` 已合并——`performAutoRecallCore:2139` 只调 `performLayeredRecall`（:2153），block 直接取 `layeredOutcome.block`（:2243 注释"钩子与端点共用同一实现…逐位一致"）。**不再有重复装配**。
- 残留唯一一处：A-1-7 的 turn-first 分支（:1849-1900）把 fts cap + 预算 + `assembleLayeredLines` 又写了一遍，顺序不同。该分支已死 ⇒ 删掉即可彻底消灭重复装配。
- `applyCompositeRerank` / `applyExploreSlot` 在钩子路与工具路各调一次是**正确的单一源消费**（R-A1 纪律），不算重复实现；只有 B-2 的锚不一致是真问题。

---

## C. 实验脚手架留在生产代码里

### C-1 空转（真实浪费）：`supersededRows` 每轮白算
```ts
// auto-recall.ts:3664-3675
let supersededRows: [string, MergedPoolValue][] = [];
if (validityEnabled(excludeInvalidated) && valueMaskIntent) {   // 生产：true && present-intent → 常成立
  const staleNow = validityNow ?? new Date();
  supersededRows = sorted.filter(([, value]) => validityStateOf(value, staleNow, valueAccessors) === "expired");
}
```
- 唯一读者是 :3758（在 A-1-3 的死 guard 内）。
- 生产影响：每个"纯当下意图"查询都要对**整个候选池**做一次 `validityStateOf`（Date.parse × 2/行）+ 一次 filter 分配，然后结果被丢弃。
- 建议：把这段挪进 :3752 的 guard 内部（或直接用 `if (sorted.some(factOf))` 短路），A-1-3 删除时一并删。

### C-2 空转（可忽略但应注明）：`valence/arousal` 搬运
- mergedMap 条目（:3408 附近）带 `valence/arousal`，唯一消费者是 :3441 的情绪比较器；权重 0 ⇒ 字段搬运无产出。
- 成本极低，建议**保留**，在字段注释标"仅 emotionSalienceWeight>0 时被读"。

### C-3 死分支的透传字段（脚手架残留）
- `recordToFormatable`（auto-recall.ts:4148-4156）、`vectorResultToFormatable`（:4206-4211）、`ftsResultToFormatable`（:4276-4280）**各自**写一遍 `factOf / factPhrase / factValue` 的 IIFE + `factValueOfMeta` 调用。
- 生产下三者恒 undefined（无写入方），但每行都要执行：3 个 IIFE × 每个候选 × 每轮 + `factValueOfMeta` 里的 `Array.isArray(factTriples)` 扫描。
- 建议：随 A-1-3 删除；若保留，抽出单一 `factFieldsOf(meta)` 避免三处复制（当前是同一段代码抄三遍）。

### C-4 bench 转储钩子：`RERANK_SCORE_DUMP`
```ts
// auto-recall.ts:908-935
const scoreDumpPath = process.env.RERANK_SCORE_DUMP;   // :911
if (scoreDumpPath) { appendRerankScoreDump(scoreDumpPath, { … 18 个字段 … }); }
```
- 干什么：#144 精排校准的样本转储（bench 侧 `--dump-rerank-scores` 透传）。
- 空转吗：**不空转**（guard 即 return，未设 env 时零开销），但它把 18 字段的 `RerankScoreDumpRecord` 类型（~:660-700）+ 文件 IO 依赖留在生产模块里。
- 建议：保留功能，移动到 `recall/rerank/dump.ts` 并从 hooks 里移除 `process.env` 直读（改为参数注入），让 hook 不依赖 env。

### C-5 已 gated 的脚手架（无需动作）
- `buildFactsBlock` 只在 `l1-extraction.ts:461 if (opts?.factsEnabled)` 时拼提示词；`describeAttributes()`（fact-attribute.ts:124）只在该块内（:530）。生产 `extraction.facts.enabled: false` ⇒ **24 属性词表不进提示词**，零 token 成本。✅ 这台脚手架是干净的。
- `injectWrapper/injectTimeSort` 的注释自称 "B1 生产化（bench/recall-opt G1）"，属已生产化的实验开关（不是脚手架），只是死了（A-1-1/2）。

### C-6 b1/v3 提示与标记
- bench/实验标记（`grep -iE 'bench|LME90|实验'`）分布在 24 处，多数是注释溯源（可读性好，建议保留）。真正的"侵入"只有两处：
  1. `auto-recall.ts:911` 的 env 直读（C-4）；
  2. `auto-recall.ts:677/693` 的 `RerankScoreDumpRecord` 类型住在 hook 文件里。
- 建议：类型下沉到 `recall/rerank/`。

---

## D. 数据结构冗余：metadata 四个事实键

### D-1 计数（可复现）

```bash
cd D:/TDB/td-agemem/MemoryCore/src
for k in fact_of fact_phrase fact_value fact_index factTriples facts; do
  echo "$k total=$(grep -rn --include=*.ts "$k" . | wc -l) \
files=$(grep -rl --include=*.ts "$k" . | wc -l) \
nontest=$(grep -rn --include=*.ts "$k" . | grep -v '\.test\.ts' | wc -l) \
nontest_files=$(grep -rln --include=*.ts "$k" . | grep -v '\.test\.ts' | wc -l)"
done
```

实测输出（2026-10-30）：
```
fact_of      total=21 files=9  nontest=17 nontest_files=5
fact_phrase  total=14 files=7  nontest=10 nontest_files=4
fact_value   total=6  files=5  nontest=4  nontest_files=3
fact_index   total=3  files=3  nontest=1  nontest_files=1
factTriples  total=43 files=14 nontest=24 nontest_files=8
facts        total=228 files=36 nontest=106 nontest_files=20
```

### D-2 谁写 / 谁读

键常量单一源：`core/record/fact-row.ts:30-51 FACT_ROW_META`（注释："读侧/测试/运维走查的唯一口径，禁止散落字面量"）。

| 键 | 写入点 | 读取点 | 非测试 命中/文件 | 判断 |
|---|---|---|---|---|
| `fact_of` | **1 处**：fact-row.ts:187 `[FACT_ROW_META.factOf]: ctx.parentId`（唯一调用者 `factRowMetadata()`，被 l1-writer.ts:587 `if (factRowsActive)` 门控） | 4 处：auto-recall.ts:3744（guard 谓词）、:4149、:4207、:4277；1 处工具路：memory-search.ts:1511-1515 | 17 / 5 | 写读成对，但写入被 `factRows` 关闭 ⇒ **生产恒空** |
| `fact_phrase` | **1 处**：fact-row.ts:194 | 4 处：auto-recall.ts:3759、:4153、:4208、:4278 | 10 / 4 | 同上；l1-writer.ts:642 只是注释 |
| `fact_value` | **1 处**：fact-row.ts:190 | 1 个函数 `factValueOfMeta`（fact-row.ts:53）+ 4 个调用点：auto-recall.ts:3760、:4156、:4209、:4279 | 4 / 3 | 命中最少，读侧全部为 #166 遮蔽服务（死） |
| `fact_index` | **1 处**：fact-row.ts:189 | **0 处**（生产代码零读取；只有 fact-row.test.ts 断言 + fact-mask 测试 fixture） | 1 / 1 | **写了没人读** ⇒ 纯冗余 |
| `factTriples` | 2 处：l1-extractor.ts:979（gated `includeTriples`，yaml false）、fact-row.ts:187（行级重写） | 3 处：fact-row.ts:59（`factValueOfMeta` 回退）、write-policy.ts:112、fact-key.ts:215（`mergeFactTriples`） | 24 / 8 | 写侧被 `includeTriples` 关；读侧是写字面量的兼容回退 |
| `facts` | 2 处：l1-extractor.ts:975、fact-row.ts:193 | write-policy.ts:106/119、fact-key.ts 等 | 106 / 20 | **真活键**（写时事实键与 dedup 用），不属冗余 |

补充说明：
- `fact_key` 键（`FACT_ROW_META.factKey`）在非测试代码 18 处，主要消费者是 `core/store/sqlite.ts`（9 处）的 `invalidateL1ByFactKey`——它随 ① supersession 一起死，但它是"事实级失效"的唯一落点，属"有基础设施无调用方"。
- 工具路 `memory-search.ts` 只读 `fact_of`，**不读** `fact_phrase/fact_value`（`grep -n 'fact_phrase\|fact_value' src/core/tools/memory-search.ts` → 0 命中）⇒ 即使将来开 factRows，工具路仍然只折叠不遮蔽。

### D-3 建议
1. `fact_index`：删除（无人读），或若为"运维走查"保留则在 FACT_ROW_META 注释里写明"仅供人工排查，代码零读"。
2. `fact_of / fact_phrase / fact_value`：与 A-1-3 同生共死 —— **要么开 `write.factRows` 并补端到端，要么四键 + fact-turn.ts + 三处 converter IIFE 一起删除**（涉及约 300 行）。
3. `factTriples`：保留（读侧兼容回退仍需要），但把 `factValueOfMeta` 的 `factTriples[0].value` 回退标为"仅旧库行"，避免新代码误依赖。

---

## 最该删的 3 条（按收益/风险比排序）

1. **`MemoryCore/src/core/hooks/auto-recall.ts:3752-3788` 事实行投影块 + `MemoryCore/src/core/recall/fact-turn.ts:107-190` 整套（190 行）**
   理由：两套基线皆不可达（唯一输入 `metadata.fact_of` 的写入被 `write-policy.ts:77` 的缺省策略与生产 yaml 双重关闭）；连带 4 个 metadata 键、3 处 converter IIFE、`displayContent` 哑支。删掉即减约 300 行死码。

2. **`MemoryCore/src/core/hooks/auto-recall.ts:1849-1900` turn-first 备用装配 + `:1393-1395/1520/1598/1761-1763` intent 矩阵**
   理由：需要 `conclusionLayer.routing="intent"`，两套基线都不是 intent；全仓 **零测试**、零 yaml 引用。这是 performLayeredRecall 内最后一处重复装配，删掉后装配路径唯一。

3. **`MemoryCore/src/core/hooks/auto-recall.ts:3664-3675` 的 `supersededRows` 计算（空转）+ `:3676-3705` soft 失效块**
   理由：前者生产每轮对整池做 `validityStateOf` 后丢弃结果（真实 CPU 浪费），后者 `excludeInvalidated === "soft"` 永假。两条都不需要等产品决策，属于"纯减法"。

> 若还要第 4 条（无争议）：`recall-fold-cluster.ts:61 foldSameSourceDuplicates` 与 `:127 foldClusterAware` 两个零生产 caller 的导出，以及 `filter-invalidated.ts:37 filterInvalidated`（注释已自认无 caller）。

---

## 附：方法说明与未覆盖项

- 全部结论来自 `read`/`grep`/`sed`，**未运行测试、未改任何文件**（除本报告）。
- 未逐条核对 `coreMemory` 组（`soul-assembler` 的 selfIdentity / characterTension / promises / capabilities / perTurnSlots 等）各开关的缺省与生产值——它们与召回主链正交，量大且属另一审计单元；本报告只在 :2032 附近确认注入块拼接顺序。
- 未评估 `gateway/v2-router.ts:2045` 端点路与钩子路的**其余**差异（除 B-2 的时间锚、B-1 的折叠缺口）。
