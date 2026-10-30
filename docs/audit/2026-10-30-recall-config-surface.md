# 记忆召回（recall）配置面审计 — td-agemem

- 审计对象：MemoryCore/src/config.ts 的 RecallConfig 及全部嵌套子结构（config.ts:142-568）
- **缺省口径：以解析代码为准**（config.ts:2064-2419）；接口注释只作对照，不一致项单列第 8 节。
- 生效口径：本机生产两份配置 —— MemoryCore/tdai-gateway.yaml（recall 段自 :133 起）+ D:/TDB/data/config-override.json（settings override 层，优先于 yaml）。云模板对照 deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml（recall 段自 :128 起）。
- 证据口径：docs/optimization-results.md §1–§24 + MemoryCore/.eval-data/bench/*.json 的 config 快照 + 代码消费点（file:line）。
- 噪声地板：§24.1「1-2 题 = 1.1-2.2pp，单看总判对率要求差值 >2 题」（judge=scm-flash，非 JSON 误判已由 parseJsonLoose 修复）。承重判据 = 有配对臂且增益 > 该地板。
- 「生产是否生效」：**否** = 键存在但当前默认组合下不改变输出（代码路径不可达，或被上游权重归零）；**生效值 X** = 配置值与实际生效值不同。
- 统计：共 104 个配置键 —— 承重 5 / 中性 38 / 无证据 45 / 死码 16。

---

## 1. 总开关与召回池

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.enabled | boolean | true (config.ts:2065) | 是 (tdai-gateway.yaml:134) | 无 | §1–§24 全部实验臂均 recall.enabled=true，无 off 臂 | 无证据（召回池） |
| recall.maxResults | number | 5 (config.ts:2066) | 是 (yaml:135) | 有 | §24.2/§24.3 A 臂 k=5 62.2% → W 臂 k=10 66.7%（+4.44pp，4W/8L，p=0.388），X 组合 73.3% p=0.0129；单因子未过显著门但增益 > 噪声地板 | 承重 |
| recall.candidateK | number? | undefined → maxResults*3 = 15 (config.ts:2068-2071；auto-recall.ts:2994) | 是，钉 32 (yaml:147) | 有 | §17.4 matched +6.44pp（15 对，召回侧唯一显著键）；§21.3 kept≥4 38/90→80/90 | 承重 |
| recall.scoreThreshold | number | 0.3 (config.ts:2105) | 是（sqlite 路 auto-recall.ts:3108-3110） | 有 | §1 b2b-eth015 0.3→0.15：+1.1pp ns；native hybrid 路不读它（auto-recall.ts:2632 注释「形同虚设」） | 中性 |
| recall.nativeMinRRF | number? | undefined = 关 (config.ts:2107) | 否 —— storeBackend=sqlite (yaml:345)，auto-recall.ts:2627 的 nativeHybridSearch 分支不可达 | 无 | auto-recall.ts:2636-2652 是唯一消费点；yaml:142 设 0.016 但无执行路径 | 死码 |
| recall.strategy | string | "hybrid" (config.ts:2108) | 是 (yaml:143) | 无 | docs 无 keyword / embedding 单路对照；ftsOnlyInjectCap 触发条件依赖 strategy≠"keyword" (auto-recall.ts:1839-1842) | 无证据（召回池） |
| recall.timeoutMs | number | 5000 (config.ts:2109) | 是 (yaml:157) | 无 | 无 §；仅截断/降级语义；同时是 queryExpansion 预算基准 (auto-recall.ts:2579) | 无证据（召回池） |
| recall.queryExpansion.enabled | boolean | true (config.ts:2175) | 是 (yaml:163) | 无 | bench 全部 config 快照 queryExpansion=false，生产 true → 无对照；docs 仅 §14.8.2 旁及 | 无证据（召回池） |
| recall.queryExpansion.maxTerms | number | 8，clamp[1,32] (config.ts:2176) | 是 (yaml:164) | 无 | 同上（无 on/off，更无档位扫描） | 无证据（召回池） |
| recall.queryExpansion.ttlMs | number | 600000 (config.ts:2177) | 是 (yaml:165) | 无 | 纯缓存，不改检索输入 | 无证据（召回池） |
| recall.queryExpansion.timeoutMs | number | 8000，下界 1000 (config.ts:2178) | 生效值 4000 —— yaml:166 写 8000，auto-recall.ts:2580 取 min(qe.timeoutMs, recall.timeoutMs−1000)，recall.timeoutMs=5000 | 无 | 见第 9 节「运行期改值」 | 无证据（召回池） |
| recall.queryExpansion.hotPathTimeoutMs | number | 1500 (config.ts:2179) | 是 (yaml:169) | 无 | auto-recall.ts:2604-2607 热路等待帽 | 无证据（召回池） |
| recall.queryExpansion.negativeTtlMs | number | 30000 (config.ts:2180) | 是 (yaml:170) | 无 | 失败负缓存，LLM 故障期短路 | 无证据（召回池） |
| recall.queryEmbeddingCacheTtlMs | number | 60000 (config.ts:2151) | 是 (yaml:191) | 无 | config.ts:262-266 注释：只改性能不改检索输入（设计上不可被质量指标区分） | 无证据（召回池） |
| recall.valuesCacheTtlMs | number | 60000 (config.ts:2152) | 是 (yaml:192) | 无 | 同上；价值锚缓存，跨进程写漂移窗口=TTL | 无证据（召回池） |
| recall.sessionReuseTtlMs | number | 300000 (config.ts:2162) | 是 (yaml:193) | 无 | 同时是 conclusionLayer.cacheTtlMs 的缺省回落源 (auto-recall.ts:1548) | 无证据（召回池） |
| recall.exploreSlot | boolean | true (config.ts:2184) | 是 (yaml:171) | 无 | auto-recall.ts:3729-3739 applyExploreSlot；docs 无 on/off 臂 | 无证据（注入预算） |
| recall.conclusionRelaxedForAnalytical | boolean | true (config.ts:2185) | 是 (yaml:172) | 无 | auto-recall.ts:1213-1234；docs 全文零出现 | 无证据（召回池） |
| recall.dynamicTopK.enabled | boolean | false (config.ts:2330) | 是 true (yaml:278) | 无 | auto-recall.ts:1825-1829 只缩不扩；docs 全文零出现 | 无证据（注入预算） |
| recall.dynamicTopK.minTopK | number | 2，clamp[1,50] (config.ts:2331) | 是 (yaml:279) | 无 | 同上 | 无证据（注入预算） |
| recall.dynamicTopK.dropRatio | number | 0.5，clamp[0.01,1] (config.ts:2332) | 是 (yaml:280) | 无 | 同上 | 无证据（注入预算） |
| recall.ftsOnlyInjectCap | number? | undefined（解析 config.ts:2320-2323；接口注释 config.ts:504-508 承诺「缺省 2」） | 是 —— 运行时 auto-recall.ts:1843 取 ?? 2 | 无 | §14.6② 记录该帽把注入裁到 2 行、掩盖预算实验；无 on/off 或档位配对臂 | 无证据（注入预算） |

## 2. 时间语义

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.ageDecay.enabled | boolean | false (config.ts:2193；块起 2188) | 否 —— yaml:266 true，但 rerankWeights.timeProx=0 (yaml:212) ⇒ 乘子不计算 | 有 | §5b b1-off-ad30 bit-identical 0/90；memory-search.ts:669/676/679-681 仅 time>0 时算 ageDecay | 死码 |
| recall.ageDecay.halfLifeDays | number | 30，finite>0 才 floor (config.ts:2194) | 否 —— 同上（yaml:267 设 14 亦不生效） | 有 | §5b + memory-search.ts:679-681 | 死码 |
| recall.timeProxFallbackEnabled | boolean | false (config.ts:2206) | 否 —— yaml:271 true，但只喂 composite（auto-recall.ts:3720）且 timeProx 权重 0 | 无 | auto-recall.ts:3720 + memory-search.ts:713（全 0 权重退化为 work_fact 分层 + 原序） | 死码 |
| recall.injectTimeSort.enabled | boolean | false (config.ts:2198) | 否（yaml 未设，走缺省 false） | 有 | §1 g1 臂（injectTimeSort + neutral wrapper 混测）：turnCov +0.0、判对 +4.4pp ns、拒答 −14.4pp | 中性 |
| recall.injectWrapper | string("legacy"/"neutral") | "legacy" (config.ts:2202-2205；接口 config.ts:496) | 是 legacy | 无（与 §1 g1 混臂，无法分离） | §24.8/§24.9 要求在 wrapperHead 新增 "calibrated" 档（币值口径 + 建议口径）；config.ts:492 类型与 auto-recall.ts:2042-2045 仅 legacy/neutral → 承诺的档位不存在 | 死码 |
| recall.validity.mode | string | "hard" —— 只有字面 "soft" 才软 (config.ts:2156-2159) | 是 soft (yaml:222) | 有 | §11 soft 判对 +1.1pp ns、knowledge-update cov +3.3pp；§16.5 w2h 75.6% vs w2s 78.9%；§11 hard w2 cov −10.9pp | 中性 |
| recall.excludeInvalidated | boolean | true (config.ts:2154) | 是 (yaml:216) | 有 | §1 b2b-validity Δ=[0,0] bit-identical | 中性 |
| recall.emotionSalienceWeight | number | 0，max(0,…) (config.ts:2161) | 否 0 (yaml:223) | 无 | yaml:223 注释「进预注册 A/B 队列，未过 A/B 不得置正」；auto-recall.ts:1657 | 死码 |

## 3. 结构信号 / 图 / 排序权重

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.timeBoost | number | 0.05 (config.ts:2119) | 否 0 (yaml:180) | 有（yaml golden A/B） | yaml:180 注释「关断实测有害：q9/q10 挤位」；docs 全文零出现 | 中性 |
| recall.recencyBoost | number | 0.03 (config.ts:2120) | 否 0 (yaml:181) | 有（yaml golden A/B） | yaml:180-189 golden A/B：10 条中 8 条逐位中性、2 条有害 → 全量置 0 | 中性 |
| recall.sigWeight | number | 0.03 (config.ts:2121) | 否 0 (yaml:182) | 有（yaml golden A/B） | 同上 | 中性 |
| recall.inferredPenalty | number | 0.1，上限 1 (config.ts:2122) | 是 0.1 (yaml:183) | 无 | yaml:183 注释只记录「降为平局组内旗标（commit 5fc7962）」，无配对读数 | 无证据（排序） |
| recall.reinforcementWeight | number | 0.03 (config.ts:2144) | 否 0 (yaml:184) | 有（yaml golden A/B） | 同 yaml:180-189 | 中性 |
| recall.moodBoost | number | 0 (config.ts:2145) | 否 0 (yaml:185) | 无 | auto-recall.ts:3417「缺省 0 = 不计算」；docs 零出现 | 死码 |
| recall.sensitivityPenalty | number | 0，clamp[0,1] (config.ts:2124) | 否 0（未设） | 无 | auto-recall.ts:1657；docs 零出现 | 死码 |
| recall.importancePenalty.enabled | boolean | false (config.ts:2130) | 是 true（config-override.json + yaml:159-161） | 无 | auto-recall.ts:1645/1659/1684 消费；docs 全文零出现，yaml 只有「config-override 已固化同值」一句 | 无证据（精排/排序） |
| recall.importancePenalty.penalty | number | 0.3，clamp[0,0.9] (config.ts:2131) | 是 0.3 (yaml:161) | 无 | 同上 | 无证据（排序） |
| recall.presentTemporal.enabled | boolean | false (config.ts:2139) | 否（yaml 未设；bench r146 快照 false） | 有 | §10.4 R3 presentTemporal +0.37pp ns；§17.4 列进 ignored（compareLex 下只改精确平局） | 中性 |
| recall.presentTemporal.boost | number | 0.08 (config.ts:2140) | 否（随 enabled；auto-recall.ts:1707 仅 boost>0 才检测） | 有 | 同 §10.4 | 中性 |
| recall.presentTemporal.recentDays | number | 30 (config.ts:2141) | 否 | 有 | 同 §10.4 | 中性 |
| recall.graphDiscount | number | 0.6，clamp[0,1] (config.ts:2148) | 否 0 (yaml:187) | 有（yaml golden A/B） | yaml:180-189：图开 P@5=0.285 / 关 P@5=0.325，差 0.04 > 平手线 0.02 → 置 0 | 中性 |
| recall.graphMinStrength | number | 0.5，clamp[0,1] (config.ts:2147) | 是 0.5 (yaml:186) | 有（yaml golden A/B） | 同上；yaml:186 注「graphDiscount=0 时零调用，保留备重开」 | 中性 |
| recall.sceneBoost | number | 0.04 (config.ts:2149) | 否 0 (yaml:189) | 有（yaml golden A/B） | 同 yaml:180-189 | 中性 |
| recall.coreRefBoost | number | 0.05，clamp≥0 (config.ts:2112-2116) | 否 0 (yaml:188) | 有（yaml golden A/B） | 同 yaml:180-189；yaml:188 注「C1 coreRef 落盘与展示不受影响」 | 中性 |
| recall.pprDamping | number | 0.85，clamp[0,1] (config.ts:2165) | 否 —— graphDiscount=0 ⇒ auto-recall.ts:1696 图通道整体退出，零调用 | 无 | auto-recall.ts:1684/1696-1704 | 死码 |
| recall.pprTopK | number | 10，clamp[0,100] (config.ts:2166) | 否 —— 同上 | 无 | auto-recall.ts:1698-1704 | 死码 |
| recall.pprIterations | number | 30，clamp[1,100] (config.ts:2167) | 否 —— 同上 | 无 | auto-recall.ts:1698-1704 | 死码 |
| recall.rerankWeights.relevance | number | 0.7 (config.ts:2340) | 否 0 (yaml:211) | 有（yaml golden A/B） | yaml:210-214：精排 on P@5=0.160 / off P@5=0.285，差 0.125 → 全 0（关断恒等，memory-search.ts:650 注释） | 中性 |
| recall.rerankWeights.timeProx | number | 0.15 (config.ts:2341) | 否 0 (yaml:212) | 有（yaml golden A/B） | 同上；本键为 0 是 ageDecay / timeProxFallback / fusion.recency 全族失效的根因 | 中性 |
| recall.rerankWeights.significance | number | 0.1 (config.ts:2342) | 否 0 (yaml:213) | 有（yaml golden A/B） | 同上 | 中性 |
| recall.rerankWeights.coreRef | number | 0.05 (config.ts:2343) | 否 0 (yaml:214) | 有（yaml golden A/B） | 同上 | 中性 |

## 4. 融合（fusion / factChannel）

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.fusion.mode | string | "rrf" (config.ts:2073-2086) | 本地 "normalized" (yaml:152) / 云模板 rrf | 有 | §17.4 matched：normalized +2.90pp（49-56 对）、weighted +0.38/0.00、rrf −2.67；§17.5 fusion-null-effect（weighted 最大绝对差 0.38pp）；§17.9 normalized 判对 −2.22pp、normalized+blend0.9 −7.51pp 上界 −0.84 显著负 | 中性 |
| recall.fusion.dense | number? | undefined → rrf 1 / weighted 0.4 / normalized 0.5 (fusion.ts:31-43) | 是 0.5（本地 normalized 路） | 有 | §17.9 normalized α 扫描；fusion.ts:88-98 rrf 档忽略全部权重 | 中性 |
| recall.fusion.bm25 | number? | undefined → rrf 1 / weighted 0.3 / normalized 0.2 (fusion.ts:34/43) | 是 0.2 (yaml:151-155) | 有 | 同 §17.9 / §17.5 | 中性 |
| recall.fusion.fact | number? | undefined → 回落 factChannel.weight → 0.6 (fusion.ts:76-82) | 是 0.3 (yaml:151-155) | 有 | §12（factChannel 平行通道 + fusion.mode normalized 通道内归一化）；§16.7 | 中性 |
| recall.fusion.recency | number? | 0 (rrf) / 0.2 (weighted) / 0 (normalized) (fusion.ts:31-43) | 否（本地 normalized 未设 → 0） | 有 | §10.4 compareLex 主序 rrfScore 严格优先，加性小量只在精确平局改名次；LME90 几乎无平局 | 中性 |
| recall.fusion.validity | number? | 0 / 0.1 / 0 (fusion.ts:31-43) | 否（同上） | 有 | §10.4 | 中性 |
| recall.fusion.recencyHalfLifeDays | number | 30 (fusion.ts:146-149) | 否 —— recency 权重 0 ⇒ recencyNorm 不计算 | 无 | fusion.ts:146-169；docs 零出现 | 死码 |
| recall.factChannel.enabled | boolean | false (config.ts:2088-2102) | 本地 true (yaml:149) / 云模板 false (cloud:154) | 有 | §12 平行通道；§16.7 单开判对 −1.1pp ns、注入 turnCov +4.4pp CI[+0.4,+9.0] 显著（「覆盖率工具，不是判对工具」） | 中性 |
| recall.factChannel.weight | number | 0.6，parse 侧 Math.min(1,…) (config.ts:2088-2102) | 是 0.6 (yaml:150) | 无 | §12 只测通道开/关，未单独扫 weight 档位 | 无证据（融合） |
| recall.factChannel.candidateK | number? | undefined → candidateK (auto-recall.ts:3005) | 否（未设） | 无 | auto-recall.ts:3005 | 无证据（融合） |
| recall.factChannel.minScore | number? | undefined → 回落 scoreThreshold (config.ts:179-189) | 否（未设） | 无 | 无 § | 无证据（融合） |
| recall.factChannel.onlyForTypes | string[]? | undefined = 全类型 (config.ts:2088-2102) | 否（未设） | 无 | 无 § | 无证据（融合） |

## 5. 精排（rerank）与多样性（mmr）

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.rerank.enabled | boolean | false (config.ts:2362-2407) | 是 true (yaml:324) | 有 | §21.3 台账「深池 83.2%（历史 84.3%）vs 关档 82.6%/79.5%」；§20.2 生产默认档 79.5% → §20.3 归零 blend 后 83.2%；§1 b2a-off2（浅池）关档 79.5% +12.0 [+4.1,+20.0] 显著 | 承重 |
| recall.rerank.provider | string | "none" (config.ts:2364；非法值回落 none + configError 见 2368-2376) | 是 "local" (yaml:325) | 无（无 provider 间配对臂） | §21.3 记录本地 bge-reranker-base P50 2.6-4s（延迟读数，无质量配对） | 中性 |
| recall.rerank.candidates | number | 32 (defaults.ts:24) | 是 32 (yaml:330) | 有 | §17.4 matched 12 vs 32 = 0.00pp（不是增益）；§21.3 kept≥4 38/90→80/90 是 84% 档的前提 → 防漂移型钉子 | 中性 |
| recall.rerank.minScore | number | provider 刻度：local −10.5 / 云 sigmoid(−10.5)≈2.75e-5 (defaults.ts:30-70) | 是（配置生效但恒不触门） | 有 | §19.1 90 题 997 候选分数全在 [−10.18,+10.28]，floor 只有收到 −9 以上才有行为差异；§17.4 minScore −10.5 仅 +3.45pp 且 n<2 | 死码 |
| recall.rerank.mode | string | "rerank" (config.ts:2392) | 是 rerank | 有 | §10.5 mode="filter" 生效已实证（90/90 行 gates.rerank.mode=filter）但低于 rerank；§19.8 quantile 0.5 = 81.1/81.6 vs 基线不筛 79.3/79.9 | 中性 |
| recall.rerank.filterRule | string | "floor"（normalizeRerankFilterRule，filter-ruler.ts） | 是 floor | 有 | §19.6 误滤 gold：margin top-8 10.5%（cov 88.9%）、quantile top50% 12.8%（87.4%）、floor −7 15.8%（84.1%）；§19.8 实跑 margin 8 = 79.9 两次逐位 | 中性 |
| recall.rerank.filterMarginTop | number | 8（parse config.ts:2396 → normalizeRerankFilterMarginTop，filter-ruler.ts:48） | 否（floor 档不用） | 有 | §19.6/§19.8（注入行 2.93） | 中性 |
| recall.rerank.filterKeepRatio | number | 0.5（parse config.ts:2397 → normalizeRerankFilterKeepRatio，filter-ruler.ts:59） | 否（floor 档不用） | 有 | §19.8 quantile 0.5 = 81.1/81.6，session 94.0，注入行 3.20/3.27 | 中性 |
| recall.rerank.timeoutMs | number | 800 (config.ts:2389) | 生效值 5000（yaml:326 覆盖） | 无 | 仅性能/超时语义 | 无证据（精排） |
| recall.rerank.local.modelDir | string | "" (config.ts:2402) | 是 "" | 无 | 无 § | 无证据（精排） |
| recall.rerank.local.idleUnloadMs | number | 600000 (config.ts:2403) | 是 600000 (yaml:334)；override 层为 0 | 无 | 进程生命周期语义，无 § | 无证据（精排） |
| recall.mmr.enabled | boolean | false (config.ts:2409-2418；enabled 2413) | 否 | 有 | §1 b2b-mmr（λ0.7）判对 −4.6pp [−9.8,−0.4] 显著负 | 中性 |
| recall.mmr.lambda | number | 0.7，clamp[0,1] (config.ts:2414) | 否（enabled=false） | 有 | 同 §1（仅测 λ0.7 单点） | 中性 |

## 6. 结论层 / smallToBig / 折叠 / 预算 / v3

| 配置键 | 类型 | 缺省值（以解析代码为准） | 生产是否生效 | 有无配对证据 | 证据（§/报告/config 快照） | 判定 |
|---|---|---|---|---|---|---|
| recall.conclusionLayer.enabled | boolean | true (config.ts:2216；块起 2213) | 是 (yaml:225) | 无 | 全部实验臂均 true，无关闭对照；docs 无 off 臂 | 无证据（注入预算） |
| recall.conclusionLayer.maxCharsPerMemory | number | 2000 (config.ts:2217) | 是 2000 (yaml:226) | 无 | auto-recall.ts:1260；docs 零出现 | 无证据（注入预算） |
| recall.conclusionLayer.truncateMode | string | "chars"（只有字面 "sentences" 才换档，config.ts:2221） | 是 "sentences" (yaml:250) | 无 | auto-recall.ts:1265；docs 零出现 | 无证据（注入预算） |
| recall.conclusionLayer.maxTotalChars | number? | undefined = 关 (config.ts:2225) | 是 2000 (yaml:254) | 无 | auto-recall.ts:1266-1270 allocateConclusionPerLineChars；§24.9 只提上下文上限 14000 | 无证据（注入预算） |
| recall.conclusionLayer.minUniqRatio | number? | undefined = 关，clamp[0,1] (config.ts:2232) | 是 0.35 (yaml:228) | 无 | auto-recall.ts:1199-1207 透传 selectL2Conclusions；docs 零出现 | 无证据（折叠） |
| recall.conclusionLayer.cacheTtlMs | number? | undefined → 回落 sessionReuseTtlMs (config.ts:2238；auto-recall.ts:1548) | 是 300000 (yaml:227) | 无 | 幂等缓存，不改输出；见第 8 节 | 无证据（注入预算） |
| recall.conclusionLayer.idfWeighted | boolean | false (config.ts:2243) | 是 true (yaml:238) | 无 | auto-recall.ts:1202-1207；docs 零出现 | 无证据（精排/结论选择） |
| recall.conclusionLayer.minBm25Rel | number? | undefined = 关 (config.ts:2246) | 否（未设；且相对门优先） | 无 | auto-recall.ts:1160-1176 相对门优先、绝对门标 legacy | 死码 |
| recall.conclusionLayer.minBm25RelRatio | number? | undefined = 关，clamp[0,1] (config.ts:2252) | 是 0.4 (yaml) | 无 | auto-recall.ts:1158-1176；docs 零出现 | 无证据（召回池/结论候选） |
| recall.conclusionLayer.maxConclusions | number? | undefined → 运行期 floor(maxResults/2) (config.ts:2258；auto-recall.ts:1247) | 是（走缺省 → 2） | 无 | auto-recall.ts:1247-1251；§14.3 仅登记缺省形状 | 无证据（注入预算） |
| recall.conclusionLayer.routing | string | "off" (config.ts:2264) | 是 "assistantRecall" (yaml:260) | 有 | §14.6 活体探针 assistant 回忆型 query cc=2/ec=0 → cc=0/ec=2（路由生效）；§16.6 w3routeonly 81.1% vs w3legacy 83.3%，意图路由净效应是「减结论」（结论行 57→40、证据行 124→54） | 中性 |
| recall.conclusionLayer.pairing | string | "off"（仅小写 "require" 生效，config.ts:2269） | 否 | 有 | §16.6 w3x4 78.9%；§16.8 遗留「依赖 part_of 覆盖率（生产 10.5%）」 | 中性 |
| recall.conclusionLayer.slotCost | number? | undefined → 1.5，clamp[1,3] (config.ts:2271) | 否（budget=additive，slot 记账不启用） | 有 | §16.6 w3x4 78.9%；§16.8「slot 记账无证据预留」 | 中性 |
| recall.conclusionLayer.arbitrate | string | "off"（仅 "redundant" 生效，config.ts:2278） | 否 | 无 | auto-recall.ts:1760-1762（启用条件不依赖 smallToBig）；§16.8 遗留「无时效感知」 | 无证据（注入预算） |
| recall.conclusionLayer.arbitrateThreshold | number? | undefined → 0.75，clamp[0,1] (config.ts:2279) | 否（随 arbitrate off） | 无 | auto-recall.ts:1760 | 无证据（注入预算） |
| recall.conclusionLayer.rerankGate.mode | string | undefined → "shadow"（组存在时；整键缺省 undefined，config.ts:2287） | 否（未设） | 无 | auto-recall.ts:1289-1328；docs 零出现 | 无证据（精排/结论门） |
| recall.conclusionLayer.rerankGate.minScore | number? | undefined → 消费点缺省 −1 (auto-recall.ts:1322) | 否 | 无 | auto-recall.ts:1322-1328 isLogitScaleProvider + sigmoid01 | 无证据（精排/结论门） |
| recall.smallToBig.enabled | boolean | false (config.ts:2305) | 是 true (yaml:299) | 有 | §14.4/§14.6 生产落地（2026-10-28）；§16.5 w3legacy（additive×4 生产档）83.3% 为 8 臂最高；§8 w3b（maxExtraLines=4）84.4% vs 77.8% = +6.7pp p=0.146 | 承重 |
| recall.smallToBig.maxExtraLines | number | 2 (config.ts:2306) | 是 4 (yaml:303) | 有 | §14.4 b1off 77.8% / w3×2 shared 81.1% / w3×4 shared 84.4%；add×4 84.4%（经验≤1行率 1.1%）；add×6 与 add×4 五项逐位相同（有效区 2-4）；§18.7.6 r138 三档重放逐位不变 | 承重 |
| recall.smallToBig.budget | string | "shared" (config.ts:2311) | 是 "additive" (yaml:312) | 有 | §14.4 shared×4 84.4%（经验≤1行率 36.7%）vs additive×4 84.4%（1.1%）→ 判对无差异，差异在经验层表示结构 | 中性 |
| recall.smallToBig.relevanceRanked | boolean | true (config.ts:2316) | 是 true (yaml:315) | 无 | §14.3 只登记为「行为变更」（缺省 true），无 A/B | 无证据（注入预算） |
| recall.foldClusterEnabled | boolean? | false (config.ts:2209) | 是 true (yaml:156) | 无 | §22.8 记录：bench 全臂 foldClusterEnabled=true（缺省形状），metas 整条缺席、turnId 全空 → 无对照；另 auto-recall.ts:2040 注入前折叠不受本键控制（附注 1） | 无证据（折叠） |
| recall.maxCharsPerMemory | number | 0 (config.ts:2103) | 否 —— 未设 0，auto-recall.ts:4011 整段预算通道退出 | 无 | auto-recall.ts:4008-4011：`if (!maxCharsPerMemory && !maxTotalRecallChars) return lines` | 死码 |
| recall.maxTotalRecallChars | number | 0 (config.ts:2104) | 否 —— 同上 | 无 | auto-recall.ts:4008-4011 | 死码 |
| recall.v3Recall.enabled | boolean | false (config.ts:2353) | 是 true (yaml:287) | 无 | gateway/v2-router.ts:1887-1892 只影响 /v3/recall 端点（false → 404），与 auto-recall 无关；docs 零出现 | 无证据（召回池/端点） |
| recall.v3Recall.timeoutMs | number | 5000 (config.ts:2354) | 是 5000 (yaml:291) | 无 | v2-router.ts:1966 | 无证据（端点） |

---

## 7. 判定汇总

| 判定 | 计数 | 键（键名去掉 recall. 前缀） |
|---|---|---|
| 承重 | 5 | maxResults、candidateK、rerank.enabled、smallToBig.enabled、smallToBig.maxExtraLines |
| 中性 | 38 | scoreThreshold、injectTimeSort.enabled、validity.mode、excludeInvalidated、timeBoost、recencyBoost、sigWeight、reinforcementWeight、presentTemporal.enabled/boost/recentDays、graphDiscount、graphMinStrength、sceneBoost、coreRefBoost、rerankWeights.relevance/timeProx/significance/coreRef、fusion.mode/dense/bm25/fact/recency/validity、factChannel.enabled、rerank.provider/candidates/mode/filterRule/filterMarginTop/filterKeepRatio、mmr.enabled/lambda、conclusionLayer.routing/pairing/slotCost、smallToBig.budget |
| 死码 | 16 | nativeMinRRF、ageDecay.enabled、ageDecay.halfLifeDays、timeProxFallbackEnabled、injectWrapper、emotionSalienceWeight、moodBoost、sensitivityPenalty、pprDamping、pprTopK、pprIterations、fusion.recencyHalfLifeDays、rerank.minScore、conclusionLayer.minBm25Rel、maxCharsPerMemory、maxTotalRecallChars |
| 无证据 | 45 | 见第 9 节（按阶段归类：召回池 15 / 融合 4 / 精排 6 / 注入预算 14 / 时间语义 0 / 折叠 2 / 排序 3 / 端点 1） |

死码 16 项的三种成因（互不重叠，按出现次数）：

1. **上游权重归零导致下游计算不发生**（7 项）：rerankWeights 全 0 → ageDecay.enabled/halfLifeDays、timeProxFallbackEnabled；graphDiscount=0 → pprDamping/pprTopK/pprIterations；fusion.recency=0 → fusion.recencyHalfLifeDays。证据：memory-search.ts:669/676/679-681、auto-recall.ts:1696、fusion.ts:146-169。
2. **当前参数组合下门槛恒不触发**（1 项）：rerank.minScore 缺省 −10.5，而实测候选分数区间 [−10.18,+10.28]，§19.1。
3. **代码路径不可达或通道整体退出**（8 项）：nativeMinRRF（storeBackend=sqlite，auto-recall.ts:2627）；maxCharsPerMemory / maxTotalRecallChars（双 0 ⇒ auto-recall.ts:4011 提前返回）；conclusionLayer.minBm25Rel（相对门优先，auto-recall.ts:1160-1176）；injectWrapper（§24.9 要求的 "calibrated" 档未实现，auto-recall.ts:2042-2045）；emotionSalienceWeight / moodBoost / sensitivityPenalty（缺省 0 即不计算，auto-recall.ts:3417/1657）。

---

## 8. 接口注释缺省 vs 解析缺省 不一致清单

### 8.1 类型 A：缺省值位置漂移（注释声明缺省，解析产物却是 undefined，真实缺省落在消费点）

| 配置键 | 接口注释说法 | 解析产物 | 真实缺省所在 | 影响 |
|---|---|---|---|---|
| recall.ftsOnlyInjectCap | 「缺省 2（无结果兜底；0=off）」config.ts:504-508 | undefined（config.ts:2320-2323） | auto-recall.ts:1843 `?? 2` | 读 config 对象判断「是否配置」会误判；转储/台账记成未配置 |
| recall.conclusionLayer.rerankGate.minScore | 「local logits 缺省 −1.0」config.ts:437-450 | undefined（config.ts:2287-2300） | auto-recall.ts:1322 `: -1` | 同上；且刻度（logit vs prob）在消费点由 isLogitScaleProvider 再判一次 |
| recall.conclusionLayer.maxConclusions | 「缺省 undefined = 运行期 floor(maxResults/2)」config.ts:396-401 | undefined（config.ts:2258） | auto-recall.ts:1247 `?? r7HalfLimit` | 同上；bench config 快照里该键为 null，看不出真实取值 |
| recall.conclusionLayer.cacheTtlMs | 「缺省回落 sessionReuseTtlMs」config.ts:370-373 | undefined（config.ts:2238） | auto-recall.ts:1548 | 同上；yaml:227 已显式写 300000（等价值） |

这 4 项属同一类 bug：**注释是唯一记录真实缺省的地方**，代码里既没有缺省常量也没有测试钉住。任何按「config 对象是否带该键」推断行为的工具（含 settings-override 合并、bench config 快照）都会得到错误结论。

### 8.2 类型 B：文档/台账 与代码 不一致

| 配置键 | 一方说法 | 另一方 | 位置 |
|---|---|---|---|
| recall.validity.mode | §21.3 生产开关台账：「代码缺省 soft」 | 代码：仅字面 "soft" 才软，否则 **hard** | docs/optimization-results.md §21.3 vs config.ts:2156-2159 |
| recall.validity.mode（两份生产配置互斥） | 本地 yaml "soft" | 云模板 **"hard"** | MemoryCore/tdai-gateway.yaml:222 vs deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:211 |
| recall.injectWrapper | §24.8/§24.9：「新增 "calibrated" 档」为落点 1 | 类型与解析均只有 legacy/neutral，**档位不存在** | docs §24.8/§24.9 vs config.ts:496、2202-2205、auto-recall.ts:2042-2045 |
| recall.factChannel.weight | 接口注释只写「缺省 0.6」，未声明上界 | 解析强制 `Math.min(1, …)`，**>1 静默截断** | config.ts:181 vs config.ts:2088-2102 |
| recall.smallToBig.maxExtraLines | 接口注释只写「缺省 2」 | 解析把 0/负值落成 **0 = 关**（0 的语义未在接口声明） | config.ts:456 vs config.ts:2306-2310 |
| recall.ageDecay | 类型只有 enabled/halfLifeDays | 实现另有 **floor 0.05** 常量，配置面无法设 | config.ts:478-484 vs fusion.ts:158-169、memory-search.ts:679-681 |
| recall.rerank.filterRule | §19 把 filterRule 当作生产可调档 | settings-override.ts 的 RerankSettingsOverride **不认 mode/filterRule**（未知键静默忽略）→ 只能写 yaml | docs §19.9 vs MemoryCore/src/gateway/settings-override.ts（RerankSettingsOverride 定义在 :22-33，无 mode/filterRule 字段） |
| recall.rerank.minScore | §21.2 判「跨 provider 定时炸弹」 | 解析仍按 provider 给缺省（local −10.5 / 云 sigmoid），行为本身一致，但缺省依赖 provider | docs §21.2 vs config.ts:2362-2407、defaults.ts:66-70 |

### 8.3 类型 C：配置值 ≠ 生效值（运行期改写）

| 配置键 | 配置值 | 生效值 | 原因 |
|---|---|---|---|
| recall.queryExpansion.timeoutMs | 8000 (yaml:166) | **4000** | auto-recall.ts:2580 `Math.min(qeCfg.timeoutMs, Math.max(1000, recall.timeoutMs - 1000))`，recall.timeoutMs=5000 (yaml:157) |
| recall.ftsOnlyInjectCap | 未配置（解析 undefined） | **2** | auto-recall.ts:1843 `?? 2` |
| recall.candidateK | 32 (yaml:147) | 32（一致，本行为钉子登记、不属改写） | 注释缺省为 maxResults*3=15；若撤钉回到 15，§3 记录 15 是 T1 隐式帽、§17.4 记录 15→32 是召回侧唯一显著键 |

---

## 9. 「无证据」按阶段归类（45 项）

判定为无证据的**共同前提**：docs/optimization-results.md 全文检索这些键名零命中，且 bench config 快照里它们或恒为同一值（进不了旋钮表）、或压根不出现。

### 9.1 召回召回池（15 项）

recall.enabled、recall.strategy、recall.timeoutMs、queryExpansion.enabled/maxTerms/ttlMs/timeoutMs/hotPathTimeoutMs/negativeTtlMs、queryEmbeddingCacheTtlMs、valuesCacheTtlMs、sessionReuseTtlMs、conclusionRelaxedForAnalytical、conclusionLayer.minBm25RelRatio（结论候选 BM25 召回）、v3Recall.enabled（端点级，不影响 auto-recall 主路）

要点：queryExpansion 一族在生产开启、bench 全臂关闭 → 生产与 bench 的召回池形状不同，这是「生产读数无法由 bench 复现」的一个来源（与 §14.6② 的 fts-only 帽同类）。

### 9.2 融合（4 项）

factChannel.weight、factChannel.candidateK、factChannel.minScore、factChannel.onlyForTypes —— factChannel 只测了整体开/关（§16.7），通道内四轴从未单独扫描。注：fusion.dense/bm25/fact/recency/validity 有证据（§17.5/§17.9），不在此列。

### 9.3 精排（6 项）

rerank.timeoutMs、rerank.local.modelDir、rerank.local.idleUnloadMs、conclusionLayer.idfWeighted（结论层 IDF 加权选择）、conclusionLayer.rerankGate.mode 与 .minScore（结论层精排门，从未开启）

### 9.4 注入预算（14 项）

exploreSlot、dynamicTopK.enabled/minTopK/dropRatio、ftsOnlyInjectCap、conclusionLayer.enabled、conclusionLayer.maxCharsPerMemory/truncateMode/maxTotalChars/cacheTtlMs/maxConclusions、conclusionLayer.arbitrate/arbitrateThreshold、smallToBig.relevanceRanked

要点：§14 的生产 journal 观测（结论层命中率 49.6%、表示占比 97.8%/2.2%、kept≤1 35.6%）是**观测**而非配对实验；§14.4 只扫了 maxExtraLines 与 budget 两轴，预算族其余 12 个键没有任何 A/B。

### 9.5 时间语义（0 项）

该阶段全部键落在「死码」或「中性」，无一项处于无证据状态（ageDecay×2、timeProxFallback = 死码；injectTimeSort、presentTemporal×3、fusion.recency/validity = 中性）。

### 9.6 折叠（2 项）

foldClusterEnabled（bench 全臂 true，无对照）、conclusionLayer.minUniqRatio（句子级去重门，从未单独扫）

### 9.7 排序 / 结构信号（3 项）

inferredPenalty、importancePenalty.enabled、importancePenalty.penalty —— 这 3 项是**当前仍在生产开启、却没有任何 § 配对证据的排序键**（yaml:183 只有机制描述，yaml:159-161 只有「override 已固化同值」）。

### 9.8 端点（1 项）

v3Recall.timeoutMs（随 v3Recall.enabled 一起，只影响 /v3/recall 端点；主路 auto-recall 不读）

---

## 10. 盘点附注（非建议，仅记录事实）

1. **两套折叠并存**：auto-recall.ts:2040 无条件执行 `foldNearDuplicates(orderedLines, { sessionOf })`（#162 重写版，三判据见 §18.7）；auto-recall.ts:2665 / 2713 才以 `foldClusterEnabled === true` 门控 `foldClusterAwareWithMeta`（元数据折叠）。因此 `recall.foldClusterEnabled` 只能关掉后者，关不掉前者 —— 该键的语义与名字不符（§18.7.6 已记录 w3legacy 下 blockChars 1233→2906 的 2.4 倍变化）。
2. **yaml 注释与自身取值不一致**：yaml:180-189 段注释称结构信号「全量置 0」，但 yaml:183 `inferredPenalty: 0.1` 实际非 0（该行有独立注记说明保留原因，段注释未更新）。
3. **两份生产配置在 3 个键上互斥**：factChannel.enabled（本地 true / 云 false）、fusion.mode（本地 normalized / 云 rrf）、validity.mode（本地 soft / 云 hard）。台账 §21.3 的「云模板」「本地 yaml」「代码缺省」三列在这 3 行与现文件不符（validity 的代码缺省一列写 soft，代码实为 hard）。
4. **rerankWeights 全 0 是本仓库最大的一处「配置面空转」**：它一次性使 ageDecay(2)、timeProxFallback、fusion.recencyHalfLifeDays 共 4 个键进入死码，并使 fusion.recency/validity、presentTemporal 三键退化为只改精确平局的加性小量（§10.4）。
5. **bench config 快照的可观测缺口**：foldClusterEnabled、nativeMinRRF、dynamicTopK、ftsOnlyInjectCap、maxCharsPerMemory/maxTotalRecallChars、importancePenalty、ppr*、graph* 等键**不进 bench config 字段**（bench 只保留 ageDecayDays 一个 CLI 覆盖位），因此这些键在 bench 侧无法从快照复核，只能回到 yaml 与代码。
6. **§24.9 的 4 条生产落点，落地状态**：maxResults 8-10（未落，缺省仍 5）、injectWrapper calibrated（未实现）、factRows/supersession 维持关（已符合）、不动 rerank 32 档（已符合）。

---

## 11. 引用索引

- 配置类型与解析：MemoryCore/src/config.ts（接口 142-568，解析 2064-2419，recallSignalBoost 1285）
- 精排缺省单一口径源：MemoryCore/src/core/recall/rerank/defaults.ts（24/30/41/56-58/66-70）
- 过滤尺子：MemoryCore/src/core/recall/rerank/filter-ruler.ts（ADR-0013，§19.7）
- 融合权重：MemoryCore/src/core/hooks/fusion.ts（31/34/43/76-82/88-98/146-169）
- settings override 层：MemoryCore/src/gateway/settings-override.ts（RerankSettingsOverride :22-33，不认 mode/filterRule，§19.9）
- 召回主路：MemoryCore/src/core/hooks/auto-recall.ts（1073-1104、1158-1270、1390-1548、1641-1707、1745-1831、1834-1867、2036-2045、2565-2607、2627-2652、2994-3110、3417、3711-3739、4008-4011）
- 复合精排：MemoryCore/src/core/tools/memory-search.ts（612/650/652-689/700-715/1478-1487）
- v3：MemoryCore/src/gateway/v2-router.ts（1887-1892、1966）
- 生产配置：MemoryCore/tdai-gateway.yaml（recall 133-345）、D:/TDB/data/config-override.json、deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml（128-211）
- 证据文档：docs/optimization-results.md（2362 行，§1 line 14 … §24 line 2204）
- bench 快照：MemoryCore/.eval-data/bench/*.json（219 个）
