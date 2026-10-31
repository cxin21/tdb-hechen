# 未关闭 Issue 第一性原理审计（2026-10-31）

> 范围：GitHub `cxin21/tdb-hechen` 全部 34 张未关闭 issue（open 且非 PR），基线 `main@17c0582`。
> 方法：每票主张对照真实代码/真实报告逐条复核（一手 `gh api` 拉正文+评论、逐行读源码、实跑 `tsc`、实跑 prettier、抽样解析 bench 报告 JSON）。不使用票面自述作为事实。
> 目标：(1) 主张是否为真；(2) 方案是否最优；(3) 真实依赖；(4) 执行顺序；(5) 收敛到「无半成品、逻辑闭合、可直接上生产」。

---

## 0. 一页结论

**这个 issue 集的问题不是「有 34 件事没做完」，而是「有两件事坏了，导致另外 20 件事无法被判定做完」。**

1. **测量基座不可自证。** bench 报告的 `config` 字段只记录 CLI 覆盖值，底配来自 `.gitignore:142` 忽略的 `MemoryCore/tdai-gateway.yaml`（未入库、10-27 之后已改过）。因此历史上所有「全开」「off 档」臂都无法从仓库状态复现；更糟的是同名报告被就地覆盖（`r146c-raw` 在 10-31 06:52–06:58 被重跑成 `judged=0`，而 `-rj` 是 10-30 的旧件），`r141-b0/w2s/w3/w3x4/w3legacy` 五个臂的判分行已从磁盘消失，而 `docs/optimization-results.md` §16.5 仍在引用它们的判对数。
   → **在修好这个之前，任何「定档 / 翻转默认值」的动作都是把噪声固化成生产配置。**

2. **生产配置没有单一真源。** 云模板 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 与本地 `tdai-gateway.yaml` 在四个关键轴上**方向相反**：

   | 轴 | 本地 yaml（本机生效值） | 云模板（deploy） |
   |---|---|---|
   | `write.factKey.enabled` | true（`mode: channel`, `:71-84`） | **false**（`:61-63`） |
   | `write.supersession.enabled` | true（`:85-91`） | **false**（`:74-75`） |
   | `recall.factChannel.enabled` | true, weight 0.6（`:148-155`） | **false**（`:153-154`） |
   | `recall.validity.mode` | **soft**（`:221-222`） | **hard**（`:210-211`） |

   而 `config-override.json` **不覆盖 recall/write**（实读 `D:/TDB/data/config-override.json` 只有 llm/embedding/rerank/importancePenalty/worthiness）⇒ 本机 yaml 即生效值。
   → **「生产跑的是哪一套」目前无法回答；#154 要登记的「默认值」没有载体**，因为 deploy 模板一处都没翻。

**其余 32 张票分四类**（明细见 §4）：

| 类别 | 张数 | 处置基调 |
|---|---|---|
| 主张为真、方案基本最优、只缺执行 | 11 | 排期做，票面小修 |
| 主张为真，但**方案不是最优 / 根因定位错**（按票面做=白做或回退已关票） | 8 | **先改写票面再动手** |
| 主张部分为真、数字/行号/因果陈旧 | 9 | 改写票面，降级为文档治理 |
| 纯时间门控或纯人工裁决，无工程剩余 | 4 | 到期/裁决即关 |
| **无票覆盖的真实缺陷** | 8 项 | 需新建票（§7） |

**最强的一条判断**：全部 34 张票里，**只有 3 项真正阻塞「可直接上生产」**——
- **#92 的自动采纳门**（`sqlite.ts:3159` `LIMIT 200` vs 生产 rejected=385 ⇒ 185 条人工拒绝对门②不可见，可能自动采纳曾被拒主题；且 `upsertCore` 与 `decidePendingCoreAuto` 非原子，失败仅 warn ⇒ 无痕人格写入）；
- **#124 B1**（`chat-memory.ts:262-263` 翻页硬上限 500 ⇒ 线上 tab 整片空白，已发生）；
- **生产配置真源分裂**（见上，无票）。

其余全是「质量债 / 测量债 / 治理债」，不阻塞上线，但阻塞「下一次定档」。

---

## 1. 证据与口径

### 1.1 生效配置的真相（决定多张票的结论）

- `MemoryCore/tdai-gateway.yaml:7-11` 自述优先级：`{data.baseDir}/config-override.json` > `TDAI_LLM_*` env > yaml。
- 实读 `D:/TDB/data/config-override.json`（30 行）：只含 llm / embedding(doubao-embedding-vision, dim 2048) / rerank(local, enabled) / importancePenalty / worthiness。
- ⇒ **override 不覆盖 recall / write / fusion / validity**，yaml 这些段即生效值。
- ⇒ **#150 / #152 评论里「factRows/supersession 缺省关 ⇒ W1 无写 ⇒ 挂起」的前提是假的**：代码缺省确实全关（`write-policy.ts:77-88`），但生产 yaml `:71-91` 全开。挂起的**结论**仍对，**理由必须换**成「W1 净收益 −2.2pp（#149 A/B 实测）」。否则后来者会去删一个生产正在跑的能力。

### 1.2 两把尺，不可混

判分器只有两支，且 `MemoryCore/scripts/lib/bench/judge.mjs:74 pairJudges` / `:157 decidePairing` 会**代码强制**：同 model + 同 `judgePromptVersion`(lme-v2) 才 `same`，否则 `cross` → `exit 3`。

- **MiniMax-M3.1-Flash**：§8 / §10 / §14 / §16 / §21 / #154 的 86.7。
- **scm-flash**：§1 / §24 / §25。

⇒ **#154 的 86.7% 与 §24 的 73.3% 绝对不可并列。** 二者差值 13.4pp 中，判分器只解释约 1pp（`rejudge-b1off-scms-to-mm.json`：同批答案 63/90 → 62/90 换 judge 重判）。**「不可配对」≠「不能拆」** —— 主体是配置 / commit / 答案提示差异，不是判分器。这一句票面写错了。

另两处口径须钉死：
- **84.3% 与 82.2% 是同一条臂的两个指标**（`…2026-10-27T08-36-53.json`：`cov@5=84.3`、判对 `82.2`），不是两个档位。
- 88/90 题的 `sessionCov@10 == sessionCov@5` ⇒ **加宽 k 只在已召回会话内加行，从不新增 gold 会话**（§25 D5）。这条决定 #169 / #172 的收益上限。

### 1.3 三套基线（必须每次说清是哪套）

| 基线 | validity | rerank | 折叠 | smallToBig | routing |
|---|---|---|---|---|---|
| 代码缺省（`config.ts` + 默认） | **hard**（`:2156-2159`） | off | off | off | intent |
| 本地 yaml（`tdai-gateway.yaml`，bench 用它） | **soft**（`:221-222`） | on | on（`:156`） | on | `assistantRecall`（`:260`） |
| 云模板（deploy） | **hard**（`:210-211`） | — | — | — | — |

`docs/optimization-results.md` §21.3 的台账把这一行**写反了两处**：称「云模板 soft」（实为 hard）、称「代码缺省 soft」（实为 hard）；而同文档 `:468` 又写「云模板…缺省关/硬」——文档内部自相矛盾。

---

## 2. 根节点 A：度量基座不可自证（阻塞 20 张票的判定）

### 2.1 三个结构性缺陷

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| A1 | 报告只记覆盖值，底配来自 gitignored yaml | 报告 `config` 只含 CLI flags；`MemoryCore/tdai-gateway.yaml` 被 `.gitignore:142` 忽略、49862 字节、mtime 10-29（#154 的臂是 10-27 跑的） | 所有「全开」臂不可复现。#154 票面称「全开含 W1+W2+W3+soft+B1+ck32」，报告里实际只有 `B1 prompt + candidateK 32 + rerank off` 能自证（`factChannel: null`、`conclusionCards: null`、无 `validity` 键） |
| A2 | 同名报告可被就地覆盖 | `r146c-{base,wide,pref,best}.json`（raw）在 2026-10-31 06:52–06:58 被重跑成 `judged=0`；`*-rj` 是 10-30 旧件 ⇒ raw 与 -rj 已非同批答案。`r141-{b0,w2s,w3,w3x4,w3legacy}.json` 五个臂判分行全部消失（现 cov 65.56/65.56/80.88/80.11/85.10，均 `judged=0`） | §16.5 的 78.9/78.9/80.0/78.9/83.3 与 §16.7 的「hard −3.3pp」全部不可复现；且门禁把 `judged=0`+无 `judgeModel` 的报告当「retrieval-only 档」**放行**（`judge.mjs:151`），等于覆盖一步就绕过所有门禁 |
| A3 | 配对门禁只覆盖 5 个 CLI | 已接：`bench-compare.mjs:65`、`bench-gates.mjs:138`、`fit-fusion-weights.mjs:187`、`bench-ranking.mjs:59/:163`、`bench-factorial.mjs:158`（单测 `bench-judge-cli.test.ts:73/92/128/197/217`）。**未接**：`bench-report.mjs`、`bench-bucket-paired.mjs`（`:127` 只有 `exitCode=1`） | §14.5 / §24.3 的**分桶结论全部出自无门禁脚本** |

### 2.2 已被这条缺陷污染的具体结论

- **§16 的「b0 = 三轴全关负控」不成立**：b0 实际 `effective = soft`（报告 `config.validity.requested: "off"` / `excludeInvalidated: false` / `mode: soft`）⇒ b0 不是负控，§16.5 中 b0 与 w2s 逐位相同（65.56/65.56）是同一配置自比。这是 #174 的直接后果。
  - **但 §16.7「保留 soft、拒绝 hard」的证据仍成立**：依据是 `w2h`（`--validity-mode hard` 有效执行）vs `b0`（effective soft），hard −3.3pp。被推翻的是「b0=off」这个**定义**，不是这个**比较**。
- **#142（§21.1 blend 四档）未被 #174 推翻**：blend 机制已删（`config.ts` 无键），结论是「删」。
- **#146（§24/§25 六臂）未被 #174 推翻**：六臂 `config.validity` 均为 soft 或 null，没有 off 臂。**但 §24.10 的复现命令缺 `--validity-mode / --small-to-big / --conclusion-*` 显式旗标**，照抄会继承已变更的 yaml ⇒ 复现性弱，这是 #174 的连带风险。
- **§14.4 的 cov 列不可复现**：文档 73.0/78.9/78.9 vs 文件 75.5/81.6/81.6（差 2.1–2.6pp），pooled@5 / macro@5 / sessionCov@5 三种算法都复现不出；且 add×4 与 add×6 在文件里**逐位相同**（cov/genCorrect/refused 全等），文档未记。

### 2.3 修法（这是整个 issue 集的真正 P0，且无票）

1. **报告落 `config.effective` 快照**：`scripts/lib/bench/store.mjs:981-1026` 已有 `recall.excludeInvalidated.effective` 这个雏形，把它扩成「全部承重键的派生三态快照」（validity / fusion / candidateK / rerank / smallToBig / conclusionLayer / factChannel / write）。
2. **报告只追加不覆盖**：文件名含 `commit + judgeModel + tag`，或目录按日期只写不改。**这是治本**——加门禁挡不住覆盖。
3. **把 `decidePairing` 接到 `bench-report.mjs` / `bench-bucket-paired.mjs`**，并让「`judged=0` 且无 `judgeModel`」不再是合法放行态（至少要求显式 `--retrieval-only` 旗标）。
4. **重跑 r141 五臂并补判分**（五个臂共 5×90 生成，用 scm-flash 与 §24 同尺），否则 §16 永久不可引用。

> **依赖判定：这一组不依赖任何票，但 #171 / #172 / #154 / #149 / #157 / #170 / #153 全部依赖它。必须排第一。**

---

## 3. 根节点 B：生产配置真源分裂（阻塞 #149 / #154 / 上生产）

无票。现状：

- deploy 模板四项全关/硬，本地全开/soft（见 §0 表）；
- `presentTemporal`（`config.ts:243`/`:2135`）与 `rerank.mode`（`config.ts:598`）是活配置，但 `tdai-gateway.yaml` **两个键都没写**（fusion/candidateK 有，`:147`/`:151`）⇒ 生产行为依赖代码缺省、无法审阅，缺省一翻就无痕变更；
- `config-override.json` 优先级高于 yaml，且 #135 期间已被它**静默覆盖过一次**（#149 票面自己记了）。

**处置**：
1. 定义唯一真源：`deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 是生产契约，本地 yaml 是开发档；两者差异必须**白名单化并写进 ADR**，不能靠人记。
2. 启动时 dump 一份 `effectiveRecallSnapshot` 到 journal（一行 JSON），并在 bench 报告落同名字段（与 §2.3-1 合并实现）。
3. `presentTemporal` / `rerank.mode` 立即显式写进两个 yaml。
4. `config-override.json` 若命中 recall/write 段，启动即 WARN。

---

## 4. 逐票判定表（34 张）

图例：**真** = 票面主张与代码一致；**半** = 部分成立或数字/行号陈旧；**假** = 关键断言被代码反证。
处置：**保留**（可直接做）/ **改写**（票面必须先改，否则照做会错）/ **合并** / **拆** / **关**（条件已消失或已完成）。

### 4.1 召回与写入内核（10 张）

| 票 | 真伪 | 关键一手证据 | 方案最优性 | 处置 |
|---|---|---|---|---|
| **#174** validity off 不可达 | **真**（且票面方案不足） | `validity-policy.ts:38-43` `return mode === "soft" ? "soft" : flag;` → soft 吞掉 flag=false。**票面漏了第二层**：`auto-recall.ts:1010` `validityMode` 只看 `mode` 不看 `flag`，其消费点 `:1115`（结论层 FTS 预筛）、`:1222`（V2-3 放宽通道）仍按 hard 硬丢 expired ⇒ 只改一处 **off 仍不可达** | **需补 3 处**：①`excludeInvalidatedFor` 定序（flag 优先）②`auto-recall.ts:1010` 改成从同一派生三态取值 ③`run-r141-factorial.sh:81` 的期望串 `excludeInvalidated.effective=soft` 与 `:56` 臂名 `W2_OFF` 自相矛盾，修完必红，属票内未提的必要同步改动 | **保留 + 补 2 条**（第二层取值链、bench 断言同步）。**执行第一**：它是 #148 的前置，也是 §14/§15/§16 结论复核的前置 |
| **#148** 软失效扩展三旋钮 | **半**（「9 旋钮」口径过期） | 三处硬编码属实：`validity-policy.ts:70 SOFT_VALIDITY_PENALTY=0.5`；`hardOnPresentIntent` 形参在 `:126` 但唯一生产调用点 `auto-recall.ts:3678-3688` 不传；`config.ts:2156-2159` 只解析 `mode`。**但「9 旋钮从未进 schema」不是回退，是设计意图**（`config.ts` 从来只有 `excludeInvalidated` + `validity.mode` 两项） | 工具路/结论层 soft 排序不对齐是真缺陷：`memory-search.ts:1654-1661` `filterByValidity` 对 soft **只丢 future、不降权**，而钩子路 `:3676-3703` 乘 0.5 ⇒ 同语义不同刻度。**判决：只做「工具路排序对齐」那一半 + 两键配置化**；`softPenalty` 扫参**不做**（票面评论已自证 LME90 上 0 个 expired 行） | **改写 + 缩范围**。**顺序：#174 → #148**（同一派生三态的两次改造，颠倒会互相回退） |
| **#155** 结论卡 part_of 证据链 | **假（根因错）** | 写面**已在落边**：`consolidation-worker.ts:197` `sourceIds=g.memories.map(m=>m.id)`、`:220 metadata.evidence_ids`、`:221 upsertL1` 成功 → `:224-226 for(ev of sourceIds) addLink(rec.id, ev, "part_of", 1)`。真因在**读面**：`auto-recall.ts:1428-1433` `getLinksBySource` 返回空即 `continue`，**从不读已有 `metadata.evidence_ids`**（全仓只有 `gateway/atomic-by-ids.ts:4` 消费）。次因：存量 reflection 卡的边是 `79fdd8c`（10-25，#78）才引入，而 #138 探针在 10-28 前后。**另**：`consolidation-worker.ts:225 addLink` **未 await** ⇒ 异步 store 会丢边 | 从「写回填脚本」改为「**读面兜底一行**（links 空则回退 evidence_ids）+ 存量脚本缩到极少数」。验收「candidates>0 占比 ≥80%」是否可达取决于被召回卡里 scene 卡占比（scene 卡设计上无 part_of），需生产 journal 数据 | **改写根因 + 换方案**。依赖：无（读面单点改动） |
| **#156** 结论卡双源蒸馏 | **假（因果断裂）** | agent 侧通道**已存在且生产已开**：`l1-extraction.ts:429-435 AGENT_ACT_BLOCK`、`:453 selfIdentityEnabled` 拼接、`l1-extractor.ts:779-783` 从 `coreMemory.selfIdentity.enabled` 读门、生产 `tdai-gateway.yaml:438-441 enabled: true`。真因是 **`:71` 的「不应该提取的内容」列了「AI助手自身的行为或输出」，与 `:429-435` 直接矛盾**。且结论卡由 `consolidation-worker.ts:192 buildDurativeSummary` 从 L1 行蒸馏 ⇒ **改结论层完全无用，必须先修 L1 抽取** | 票面的「结论卡双源 + card.source_side」全部无效（白做）。真正要做：删/改 `:71` 那一条，让 `:429-435` 生效；辅助轮（`assistant` 桶）单独加一条取样规则 | **改写根因 + 换修复层**（结论层 → L1 抽取提示词）。依赖：无 |
| **#173** 死码与配置面清理 | **假（1/3 真）** | 三组抽验：<br>①「`:3752-3788` fact 投影 + `fact-turn.ts:107-190` 不可达」→ **过期措辞**，它是**配置门控**（`if (sorted.some(([,v])=>v.formatable.factOf))`）+ **数据门控**（`metadata.fact_of`），且同函数被工具路 `memory-search.ts:1519-1520` 调用、有 3 个测试。<br>②「turn-first 两基线皆死」→ **半假**：生产 `routing=assistantRecall` 恒 false，但 bench 三处臂显式 `--conclusion-routing intent`（`run-r141-factorial.sh:65`、`run-r141-ablate.sh:46/:52`、`run-r138-arms.sh:50`）⇒ bench 里是活的。<br>③「`supersededRows` 算完即丢/空转」→ **假**：`:3758` 作为 `collapseFactRowsByTurn` 入参被消费，是已关票 **#166 值级遮蔽的唯一实现体**；且 `:3676 if (excludeInvalidated === "soft")` 块在生产 yaml（soft）下**实际执行**。<br>另「不一致 9 条」里的 `ftsOnlyInjectCap` 是**有意设计**（`config.ts:508` 可选 → `auto-recall.ts:1843 ?? 2`，测试 `config.rerank.test.ts:164` 注明），不是缺陷 | **照票删 = 静默回退 #166 + 删掉 bench 可复现能力**。可删的只有无分歧部分：`fact_index` 只写不读（全仓零读取点）、插桩空转（`lineTypeStats` raw-turn 259/259=100%、`unresolved=0` 结构上永不报警）、`injectTimeSort`/`injectWrapper` 双档。**「不可达 23 条」清单必须逐条重验** | **拆分**：③「真死码清理」保留（重验后执行）；①②降级为「休眠能力文档化」（在 CONTEXT/ADR 标注「生产不产生 fact_of 行，能力休眠」）。**不要在本票内碰 validity 三键（#148）、factChannel（#150-152）、结论层预算（#76）** |
| **#168** 长会话退化基准 + 写侧固化 | **真** | `write-policy.ts:77-88 DEFAULT_WRITE_POLICY` 里 `factKey.enabled=false`、`supersession.enabled=false`；bench 用 `--no-write-steps`（`eval-memory-bench.mjs:932-935`、`:939` 整段跳过分阶段写入）⇒「长历史会不会退化」**从未被测过** | **最优且独立**。三臂（现状 / 仅 supersession / supersession+consolidation）+ 30-50 条同实体多值更新序列，指标含旧值注入率 / 重复行率 / 退化曲线 | **保留**。**它是 #150/#152 的唯一裁判**（W1 去留），建议**提前**到 Wave 1 末并行启动 |
| **#150** l1_fact_vec 存量回填 | **真**（脚本确实没有），**但挂起理由为假** | `scripts` 下 backfill-* 只有 anchor-description/core-refs/l0-classification/soul-fields/theme-aliases；写侧唯一入口 `l1-writer.ts:554 factChannelKeyFor` → `sqlite.ts:4107 upsertL1FactVector` | 结论（挂起）对，理由错。真理由：**W1 净收益 −2.2pp**（#149 A/B：82.2% vs 84.4%）⇒ 给一条实测为负、且 deploy 模板里还关着的通道做回填，是把债做大 | **改写理由 + 挂起到 #168/#172 结论**。若 #168 判 W1 删，则本票与 `l1_fact_vec` 表一并并入 #173 |
| **#151** 工具路 normalized 缺失 | **真** | `normalizedFusionEnabled`/`normalizedRelevanceOf` 全仓只在 `auto-recall.ts:3000/:3397` + `fusion.ts`；工具路 `memory-search.ts:1121` 三路 Promise.all → `:1235-1311` fact 支路 → `:1312/:1332-1339` 加权 RRF，**无 normalized**；`tdai-core.ts:488-493` 已注「工具路不实现 normalized」。缺观测位 `factMs/factHits`（钩子路 `auto-recall.ts:2412-2413` 定义、`:3175` 写 timing）、缺 `·[fact]` 标注（钩子路 `:3998`）。**注意：工具路有事实通道**（`:1235-1311` 双门 + 余弦下限 + 只收新候选），不要写「没有」 | 最优修法：把 normalized 抽成 `fusion.ts` 的**单一函数**，两路共用；否则永远两份实现 | **保留 + 补「抽单一函数」约束**。依赖 #174（normalized 排序与 validity 降权同刻度，见 `:3697`） |
| **#152** tcvdb 无 l1_fact_vec 能力位 | **真** | `store/types.ts:340-349 StoreCapabilities` 只有 vectorSearch/ftsSearch/nativeHybridSearch/sparseVectors；tcvdb.ts 内 grep `L1FactVector`/`factChannel` 零命中；消费者 `auto-recall.ts:2627`、`memory-search.ts:1062`、`conversation-search.ts:146` | 评论拆优先级正确：**①能力位 + WARN 现在就做**（防静默空跑，独立于 W1 去留）；②tcvdb 侧实现等 #168/#172 | **拆**：(1a) 能力位 + WARN 立即做；(1b) 实现挂起 |
| **#169** 多会话证据包（turn + 同会话邻接窗） | **真** | X 臂 multi-session 5/15；15 个错里 11 个是「两条 gold turn 只召回一半」；`sessionCov@10 == sessionCov@5` 88/90（§25 D5）⇒ 加宽 k 只在已召回会话内加行，**从不新增 gold 会话**。oracle 探针（`oracle-probe-fails.json`，34 个错题注入 35 条 gold 轮）转对 20/34（multi 9/12）⇒ 上限 ≈6.7pp。邻接信息已存在：`l1_records.session_id` + `timestamp_str/start`（`sqlite.ts:766-786`）、`L1QueryFilter.sessionId`（`types.ts:167-176`）⇒ **零迁移**。但 `smallToBig` 目前只作用于结论卡（`auto-recall.ts:1377-1610`，`s2bCfg = cfg.recall?.smallToBig`），raw turn 命中行**没有**邻接扩展 | **最优**：注入单元从「单行」改为「turn + 同会话相邻窗（≤6 行）」，并把 smallToBig 从「结论卡专用」升级为「命中行通用」（一处扩写 + adjacencyProbe 注入点）。**优于加大 k**（已饱和） | **保留**。与 #172 同批但**独立 A/B**（四档 +0/+1/+2/+3），不要塞进同一次 4×90 |

### 4.2 度量与验收（7 张）

| 票 | 真伪 | 关键一手证据 | 方案最优性 | 处置 |
|---|---|---|---|---|
| **#172** 读侧定档 | **半（k=10 收益被高估 1 倍）** | `r146c-wide-rj` 60 与 `r146v2-deep-rj` 56 都真实，但**跨 commit**（5d71c12 vs 5438d43）、跨 series。**同 commit 干净配对**：`r146c-base` 58 → `r146c-wide` 60（同 5d71c12）= **+2**；`r146s-base` 58 → `r146s-expand` 60（同 1b78b23）= **+2** ⇒ 真实 k=10 增益 **+2/90 = 2.2pp（噪声内）**，不是 +4。`injectWrapper` 只有 `"legacy"|"neutral"`（`config.ts:496`，`auto-recall.ts:2043`），**`calibrated` 全仓零实现**——§24.9 的承诺类型层就不存在。`maxResults` 缺省 5（`config.ts:2066`）。**全开配置下 k=10 零证据** | ①口径对账仍要做（判分器只解释 ~1pp，13.4pp 主体是配置/commit/答案提示）；②`calibrated` 要实现（新档解析 + legacy/neutral 逐位不变断言）；③k=10 与 wrapper **分开 A/B**，别塞进一次 4×90 | **改写 + 拆三件**：口径对账 / calibrated 实现 / k 与 wrapper 分离 A/B。**依赖 #174 必须先修**；依赖 §2 基座 |
| **#154** 门禁 B 复验 + 默认值登记 | **半** | 86.7% / cov 82.6 / 拒 6.7% 在 `…2026-10-27T14-36-26.json` **逐位成立**（78/90）。但「全开」只有 `B1 prompt + ck32 + rerank off` 可自证（见 §2.1-A1）。**deploy 模板一处未翻**（见 §0 表）。n=90 下 86.7% vs 84.4% 的 CI 半宽 6–7pp，本就不足以定档 | 门禁 B 方向对，**优先级错位**——配置不可自证时扩样本只是把不可复现的数算得更精确。**先做 `config.effective` 归档，再谈扩样本**。回滚阈值目前**完全不存在** | **改写 + 降优先级**。它是 #149/#172 的汇合点，但必须排在 §2 基座之后 |
| **#157** 重跑 #138 路由档 | **半** | `…2026-10-28T02-03-47.json`：`cap.judgeModel=MiniMax`、cov 83.95、**90 行无一条 `genCorrect`** ⇒ `judged=0` 属实。「81 行 genError = 61×429 + 29×402」**无法复核**（报告不存 error 明细）→ 未验证。验收判据「§14.4 表含该行」**落空**（`optimization-results.md:628-630` 只有 add×2/×4/×6） | 「等 MiniMax 配额」前提已失效（M2.7 下线 503）。**更优替代：直接用 `r146c` 系列（scm、同 commit 5d71c12）承接 W3 结论**，省掉 90×N 次生成 | **改写 + 并入 #172**（共用判分预算与判分器） |
| **#171** LME_S 全 500 复跑 | **半（算错一个数）** | X 66.8% **精确正确**（133/133/78/70/56/30；X 逐桶 13/5/14/10/15/9 → 334/500）。**A 应为 57.0%，不是 57.3%**（A 9/3/14/7/14/9 → 284.8/500；凑 57.3 需 pref 记 8/15，文件是 7/15，§24.3 自己也写 7/15）。「偏乐观 8–9pp」与自表 73.3−66.8=**6.5pp**、62.2−57.0=**5.2pp** 不自洽。**数据集不在仓库**（只有 `longmemeval_oracle.json`，manifest 90 题/型各 15/seed 20261027），无 500 跑批脚本 | **降级**：53% 官方权重压在两个 15 题桶（multi 3/15、TR 9/15，Wilson CI 分别 [7,45]%、[36,80]%）⇒ 换算值本身 CI 极宽。**先给区间，别给单点**；除非要对外发数字，500 次灌库+判分不划算 | **改写数字 + 降级为「区间估计」**；实跑需先定判分器 |
| **#170** 成本与延迟口径 | **半（复述的数字拼错了）** | `94.8%` 是**搜索子阶段占比**：A 臂 `searchTiming` 中位 embedding 167.6ms / fts 9.1ms / fact 0.118ms，合计 ~180ms ⇒ 94.1%。**它不可能是 1282ms 的 94.8%**。而 1282/2454 与任何已存报告不符（A 臂 rows `latencyMs` p50 732 / p95 2350，X 臂 1067/2629）。**报告无 usage 字段**（root keys 只有 `generatedAt/repoCommit/dataset/config/overall/perType/lineTypeTotals/evidenceSufficiency/rows`；row 无 token，`searchTiming` 无 `rerankMs`）。计量能力在旁路：`lib/bench/llm.mjs:105-115` 返回 usage、`stages.mjs:18/49` 累加、`tokens.mjs` 的 `heuristic-v1` 估算 | 「新增独立 cost 段」是**治标**。治本：把 usage 与 `rerankMs` 写进 row/overall，否则 cost 永远在报告外再算一遍。**且 scm 中转不报 usage**（`tokens.mjs` 头注：facts-cache 里 `usage:{prompt:0,completion:0}`）⇒ 只能 `estimated=true`，**不能对外声称比 mem0 便宜** | **改写口径 + 升级为「改报告 schema」**（与 §2.3-1 同批）。依赖：必须等 usage 能取到 |
| **#153** 生产 prompt 抽取抽样门禁 | **真** | `fact-extract-gate.mjs:132-144` 只读 `readFactsCacheFile`，报告写 `promptVersion`；该常量在 bench 侧 `lib/bench/facts.mjs:27` = `facts-v4`。现存两份门禁件 `fact-gate-2026-10-27T02-17-53.json`/`…04-23-11.json` 是 `facts-v2`、accuracy 0.9263（88/95，sample 40）。**生产 prompt 是另一份**：`l1-extraction.ts:545 FACTS_BLOCK`，门 `config.ts:58 factsEnabled`（缺省 false，只在单测开）⇒ **生产 0 读数** | 对，但治本是**两套 prompt 合一**或 gate 支持 `--prompt prod`，否则读数出来仍证明不了生产那份。**与 #150/#151 无覆盖关系** | **保留 + 补「合一二选一」约束**。依赖：生产语料 + `factsEnabled` 是否开的决策 |
| **#158** 三类行一阶贡献 + answerable | **真（已自我收窄，只剩 2 项）** | 已实现部分核实：`inject-attribution.mjs:298-324`、`eval-memory-bench.mjs:1117/:1207-1219/:1220-1367`、`bench-gates.mjs`、`__tests__/bench-inject-attribution.test.ts`。剩：①`answerable` 独立 judge 字段（全仓零命中）②文档一节三类行一阶贡献拆分 | ①合理且小；②是文档。**口径坑**：本语料 `hits == injectedLines` 90/90，审计脚本 `kept>hits` 73/90 是另一口径，不可混用 | **保留**。依赖 §2 基座 |

### 4.3 Panel / Proxy / 客户端（4 张）

| 票 | 真伪 | 关键一手证据 | 方案最优性 | 处置 |
|---|---|---|---|---|
| **#124** panel B1–B4 | **真（四条全对，全部仍存在）** | B1：`chat-memory.ts:247-292` 仍翻页聚合（`:262 FA_PAGE_SIZE=100`、`:263 FA_PAGE_HARD_LIMIT=500`、`:285-291` 三个 break、`:294-301` 才内存过滤）⇒ 519 skill + 1 chat_memory 时触顶 500 即停。core 侧**已支持下推**：`v3-meta-schemas.ts:293-304`（`:303 asset_types`）→ `metadata-service.ts:1569-1573` → store 三实现（`interface.ts:178`、`sqlite-adapter.ts:1435`、`mongodb-adapter.ts:1148`）。B2：`refreshNonce`/`refreshLayer` 在 `MemoryPanel/web/src` **零命中**。B3：`TabBar/index.tsx:34-39` onKeyDown **无 `e.target!==e.currentTarget` 守卫**，`:49 aria-label` 硬编码英文未 i18n。B4：`useResizable.ts:43-49` onMouseUp 直接置 `''`，无 `previousBodyStyles` / 无 blur / 无 unmount cleanup | B1 **OPTIMAL**（core 已就绪，纯删代码）；B3/B4 **直接取上游版本**（上游 `b8e13539` 用 `previousBodyStyles` useRef 且带单测）优于自写；B2 需先定「刷新粒度」 | **保留**。**B1 是全仓唯一「线上可见故障」且改动最小，应最先合**。B3/B4 需先给 Panel 引入测试运行器（`MemoryPanel/web` 当前无 `*.test.*`） |
| **#125** panel B5/B6/B7/A11 | **2 真 / 1 半 / 1 假** | B7 **真**：`panel-config.ts:6-8 env() = process.env[key] ?? fallback`，无 trim/空串判定，而同文件 `:10-15 envInt`、`:42-46 envBool` 都显式把 `''` 当未设；消费点 `:53-74`。B6 **真**：`ApiKeyPanel.tsx:332-333` 硬编码 `{base}/openclaw/default`、`{base}/hermes/default`，其余五个 agent 用 `:311 iid=auth?.instance_id??'[instance-id]'`；`MemoryProxy/src/server.ts:360-365` 通用路由无 `spaceId==="default"` 特判 ⇒ 多实例下指错实例。B5 **半→假**：`error-message.ts:13-69` 确无 `USER_CREATE_FAILED`，但**全仓该码只出现在 upstream diff 文档与票快照里，后端从无产出方**，i18n `error.USER_CREATE_FAILED` 也不存在 ⇒ **照票面加进去是死条目**。A11 **假**：`MemoryKnowledge/src/openapi.yaml` 不存在，实际是 `MemoryKnowledge/openapi.yaml:778-785` **已含** `source_type`(nullable)+`source_url`，Panel 早已展示（`wiki-detail-view.tsx:241`、`WikiSourcesPanel.tsx:77/391/449`） | B7 修 `env()` 即可（顺带定「空串 vs 未设」全仓语义）；B6 应把 `'default'` 换成与 `:311` 同源的 iid 兜底（**不要给 proxy 加 default 特判**）；B5 **删条目**；A11 **重写**为真问题：`chat-memory.ts:495 source_type: "uploaded"` 硬写 | **拆分**：B7/B6/A11-重写 保留执行；B5 关闭；A11 原条作废 |
| **#127** TaskSourceType 收窄 | **真** | 三份 union 互不 import：`web/src/lib/api/tasks.ts:9`（4 值）、`web/src/services/backendStore.ts:69`（2 值 `manual\|tapd`）、`TaskCreateDialog.tsx:21`（2 值）；`services/index.ts:12`、`teamApi.ts:41` 只 re-export 第一份。上游收窄有仓内直证：`.local/upstream-sync/diffs/MemoryCore_src_gateway_v2-schemas.ts.diff:6-7`、`..._core_store_types.ts.diff:66-68`，口径 `.local/upstream-sync/modules/MemoryCore.md:170`；`v201/.../types.ts:369` 仍是 4 值 ⇒ 收窄在 2.0.x 之后 | 若跟随上游**必须一次改四处**，否则 `backendStore.ts:253` 把 `external` 折成 `manual`（标签错而非空列表，更隐蔽）。**若决定不收窄，web 三份归一仍该做** | **拆**：「web 三份归一」立即可做；「跟不跟上游」等 #129 裁决。**隐性依赖**：重生成 `generated/schemas.ts` 会牵动 #107 第一大错误源（51 错） |
| **#175** dsh v0.2 文档 + anthropic 配套 | **真** | Part A：`agents/README.md:83` 把 dsh 定为 OpenAI Chat、`:145-147` 路由表把 dsh 归 OpenAI、`:136` 只写 settings.yaml；`setup-proxy/SKILL.md:26/:105-109/:222/:257`「dsh 的 URL 不带 /v1」。Part B **五处全未移植**：①`session/dsh/form.ts:20` 头注「OpenAI /v1/chat/completions」、`:248-260` 只分 OpenAI 两种、`:284-294` 帧体是 `reasoning_content/tool_calls/finish_reason:"tool_calls"`；②`session/index.ts:194-211` dshFd 无 `protocol`；③`form.ts:81-82` 半角逗号 vs `:89` 注释自称「一并改全角」、`:91 SKIP_HINT` 已全角 ⇒ 常量与注释自相矛盾；④`agent-adapters/dsh.ts:90` 要求 `first.role==="system" && typeof first.content==="string"`、`:108-111` 只接受 string content ⇒ v0.2 的 `body.system`/block array 全漏判；⑤`anthropicHandler.ts:851` 传 `protocol:"anthropic"`、`:860-862` 原样 return，但该文件 grep `dsh` **零命中**、无流尾修复 | **接近 OPTIMAL**——同仓两个现成模板：`session/form.ts:128-134`（`protocol?: "openai"\|"anthropic"`）+`:226-235` 分支、`session/claude-code/form.ts:240-274`（完整 anthropic SSE）。**票面未提的缺口**：`MemoryProxy/src/server.ts:325` 只注册 `/dsh/:spaceId/messages`，没有 `/dsh/:spaceId/v1/messages`，靠 `:360-365` 通配兜 | **保留 + 补一条路由缺口**。这是**真阻塞**：v0.2 客户端首个 turn 会拿到 OpenAI 形状表单帧（无 `type` 字段），按 `server.ts:305-329` 记录的强校验会被拒 |

### 4.4 治理 / Core 运维 / 文档（9 张）

| 票 | 真伪 | 关键一手证据 | 方案最优性 | 处置 |
|---|---|---|---|---|
| **#123** Noop embedder 被判可用 | **真** | 两条路径都误报 ok：①`gateway/server.ts:906-927` 探针「未配置→直接 return」，status 保持 `:349-350` 初值 ok；②`embedding.ts:721` Noop `embed()` 返回 `new Float32Array(0)` 且 `:737 isReady→true`、不抛错。上游有现成判定 `hasClientEmbedding`（`embedding.ts:109-119`，`provider==='noop'⇒false`）。**Panel 侧另有一条**：`health-utils.ts:50-73`（`:70 embeddingOk=embedding==='ok'`）→ `ChatMemoryPanel.tsx:149` 恒绿；而对外 payload `server.ts:144-181` **不含 provider 字段**（`getProviderInfo` 在 `embedding.ts:733-734` 存在但没透出） | 票面「判定修正」只治 core。**治本必须两步**：core 判定修正（照上游 `hasClientEmbedding`）+ payload 增 `provider/configured` 让 Panel 能降档。H-15 语义（fail-fast vs 降级+WARN+journal）按上游选**降级 + WARN**（本仓 `RecallErrors.configMissingEmbedding` 已是硬抛，生产上等于整轮 recall 失败，比降级差） | **保留 + 补 Panel 侧一步**。无依赖，可与其他并行 |
| **#107** typecheck 243 错 | **真（漂移 −1 文件）** | 实跑 `npx tsc -p tsconfig.typecheck.json` = 243 errors / **44** files（票记 45）。`tsconfig.typecheck.json:9 noEmit:true`。top 文件：`gateway/generated/schemas.ts` 51、`gateway/server.ts` 23、`core/tdai-core.ts` 17、`gateway/skill-handlers.ts` 16、`offload/index.ts` 11、`utils/pipeline-factory.ts` 10。码：TS2322×70、TS2304×58、TS2339×16、TS18048×13、TS2345×12、TS2307×12、TS2564×11 | 四层分推进（generated / 测试 / 手写 / CI）正确。**缺一条关键约束**：必须先锁基线（`--pretty false | tee` 计数入 CI artifact），否则「243→243」无法当硬线。generated 那 51 个应**重生成而非手改** | **保留 + 补「先锁基线」**。**约束**：凡要重生成 `generated/schemas.ts` 的改动（#127 若跟随上游）必须先做本票，否则 51 错会变成不可归因的抖动 |
| **#108** 引入 prettier | **真，但票面方向反了** | MemoryCore 无 `.prettierrc`、无依赖、无 script；CI 只有 `.github/workflows/ci.yml:85-100` 的 panel-format job。前置「等 #106」**已解除**：`74ae047`（183 文件换行红基线）+ `1154d61`（扩 `.gitattributes`，首行 `* text=auto eol=lf`）。实跑 prettier 3.9.10 `--list-different`（只读）：`MemoryCore/src` 646 个 `.ts` 中，**缺省配置 600 个不一致；套 Panel 配置 640 个不一致**（MemoryCore 用双引号，离 prettier 缺省更近） | 票面默认「沿用 Panel 参数」是错的 —— 那会造出 640 文件的 diff。**最优 = 用 prettier 缺省 + 只钉 `printWidth/trailingComma`，一次性 reformat 600 文件单独一个 commit**，再进 CI | **保留 + 改默认参数方向**。低风险但**大 diff**，必须独立 commit、不与功能改动同 PR |
| **#129** 不跟上游 5 铁律 | **4 条成立，第 5 条无仓内支撑** | 铁律1/2/3/4 均由代码或 ADR 支撑（`server.ts:2262-2264` 只 sqlite\|tcvdb；`/v3/recall` 在 `v2-router.ts:212`+`server.ts:1460`；ADR-0006 凭据 SoT）。**铁律5（promptMode 缺省 chat→code 是语义翻转）WRONG**：`deploy/global-images/start-memory-core.sh:83-86` 与仓内上游快照 `.local/upstream-sync/v201/deploy/global-images/start-memory-core.sh:75-78` **都是 -chat**，两处注释同文 ⇒ 上游自己也是 chat，不存在翻转 | 票面所有体量数字陈旧（见 §5）。**铁律本身该保留，但要以「语义结论」而非「行号」写成 ADR**，否则每次上游 diverge 就过期一次 | **改写第 5 条 + 落 ADR**（建议 `docs/adr/0018-upstream-sync-invariants.md`，票面说「ADR 到 0008」已过期，实到 0017） |
| **#130** CHANGELOG 台账缺口 | **真** | `CHANGELOG.md` 单文件 1637 行、无 `docs/CHANGELOG.md`。11 个关键词（ingest/drizzle/sync_error/openapi/SERVICE_KEY/H-15/contextEngine/offload/APICallError/越权/生日/l1-empty）grep 全 0（think=3 是别的语义）。#135 四个用户可见键（candidateK / fusion / presentTemporal / rerank.mode）同样 0 命中，而**四个都是活配置**（消费点 `auto-recall.ts:2701` / `:2966-3004` / `:1661-1664` / 无 mode 消费行） | 只是台账，方案无异议。**但它与 §3 强耦合**：presentTemporal 与 rerank.mode **连 yaml 都没写**（`config.ts:243/:2135`、`:598`），CHANGELOG 补了也仍不可审阅 | **保留，降级为 Wave 3**；其中 presentTemporal/rerank.mode 两个键的「显式化」提到 §3（Wave 0 一起做） |
| **#131** 上游能力缺口盘点 | **半（清单可复核部分多数「不适用」）** | analytics 在 `MemoryCore/src` 只有 `utils/sanitize.ts:175` 一句注释；`v2-router.ts:198-244` 白名单与 `server.ts:1460-1470` 六条 case 均无 analytics；strict_mode / buildFromLocalDir / insertL0Batch / nativeBm25Search 全零命中。**session-add 是改名不是缺失**（`v2-router.ts:197/:504` = `/conversation/add`）。code-graph 只到 list 语义（`generated/schemas.ts:1427`）。**skill 版本清理本仓反而更全**（`core/skill/skill-versioning.ts` + `skill-resource-store.ts:190 copyTree` + `skill-store.ts:295` 幂等） | 票面「可摘 4 项」判断基本成立，但「不适用-已分叉」的 7 类里至少 skill 版本清理一项是**误判为缺口** | **保留为「已裁决」结论票**，改两处误判即可关 |
| **#113** 上游同步路线图（map） | **半** | 索引结构侧抽样成立（子票 #123–#131/#175 全部存在、Parent map 指向正确）。体量数字与 #129 一样全陈旧。「278 条缺口 / 160 冲突」依赖 `.local/upstream-sync` 的外部报告，**不可从仓库复算**；子票 #114–#122/#100 未逐票核 | 作为 map 合法。**但它当前在误导**：把已裁决不跟的项（MemoryProxy pipeline、store 目录化）仍挂在「缺口」里 | **保留，加一条「已裁决不跟」分区**；不阻塞任何事 |
| **#128** Wiki provider registry | **真（问题已被代码部分消解）** | `MemoryKnowledge/src/middleware/auth.ts:62-63` 注释直言「上游白名单还含 /source-credential/status 与 /source-provider/*，本仓未引入这两组路由」；全仓 `knowledge_source_credential` 零命中。**权限面断言被反证**：本仓无 `requireWikiWritable`，统一走 `knowledge/common.ts:101 requireTeamMember`（`wiki-routes.ts:42`、`list-routes.ts:38`、`code-graph-routes.ts:36/55/98`）⇒ **本仓比上游更严**，不需要「放开给同 team 成员」。限额面已对齐：`routes/wiki.ts:508-510`（512KB/10 文件/5MB）、`wiki-service.ts:201-202`、`knowledge/wiki-routes.ts:347` | 三待裁决现在只剩**一个真裁决**：要不要做 provider 抽象（S 还是 L）。权限面与凭据面都应直接**裁决为「不跟」**并写进 ADR | **缩为单裁决 + 落 ADR** |
| **#133** 二阶段总 spec | **过期（其「名下 open」表全错）** | 票内「名下仍 open」列 #136/#137/#138/#140/#141/#142/#143/#144/#145 —— **34 张未关票里一个都没有**（全已关）。核心结论已在票内修正为「伤害来自 candidates=12+minScore=-2 过度剪枝，不是重排本身」，并保留 rerank+池 32+floor −10.5 = 84.3%（+16.67pp CI[+9.05,+24.29]，30W/8L/52T，p=0.0005） | 作为历史 spec 有价值，**作为 open 票无意义**——它名下已无子票 | **关票**（保留正文作历史），并把「二阶段剩余 = #168 写侧 + #169 证据包 + #172 定档」这条现状写进评论 |

### 4.5 时间门控 / 人工裁决（4 张，无工程剩余或仅剩裁决）

| 票 | 真伪 | 状态与卡点 | 处置 |
|---|---|---|---|
| **#76** 结论层密度优先截断 | **真，已完成** | 实施完成，验收门 1-4 已过（门 4 独立对抗审查 PASS-with-notes，19 项探针全 PASS，1 Low + 3 Nit）。生产已翻：`tdai-gateway.yaml:180 truncateMode: sentences`、`:184 maxTotalChars: 2000`（mtime 2026-10-25）。网关栈 2026-10-25 06:55:20 重启。**观察窗 2026-10-25 06:55 → 2026-11-01 06:55** | **到期回收即关**（2026-11-01）。回收需读 journal 的 skipReason/注入字符/命中率。Q5 跨层配比有意不做，不要补 |
| **#66** R2 人格回归 | **半（「无第 2 次实跑」为假）** | 实施 6/7 真。**实存三次 live 实跑**：`shadow/run-2026-10-25.jsonl`、`run-2026-10-27.jsonl`、`run-2026-10-28.jsonl`（+对应 `shadow-*.json`，均 `mode:"live"`、`soulInjected:true`、`driftRounds:8`）。CI 干跑成立（`probes-nightly.yml:73 --no-llm`、`:88 --no-soul`）。**卡点变了**：`shadow/README.md` 把模型窗切成 10-19~10-24 ark / 10-25 glm / 10-27 起 MiniMax，ε 只用同模型 ≥10 有效点 ⇒ 日历下限由 2026-11-02 **后移到 ≥2026-11-10**；10-29/10-30 失败（`MiniMax 402 insufficient_balance_error 2067`）、10-26 缺失，无 catch-up | **改写日历下限 + 补 catch-up**。这是**唯一一个「票面时间已过期但没人更新」的票**，必须改，否则 11-02 会有人误关 |
| **#92** self_identity 自动采纳门 | **真，且有 2 个票面未记的缺陷** | 提交 `17802f4`（13 文件 703 插入）。三重门（N₂=4 / T₂=72h / 矛盾线 0.60 / 重复线 0.75）在 `auto-adopt-gate.ts:47-113`，每拍统计在 `lifecycle-scheduler.ts:217-231`，store 四方法 `sqlite.ts:3316-3395`，路由 `v2-router.ts:2237-2258`，配置 `tdai-gateway.yaml:556-561 enabled:true`。**缺陷 1**：门②矛盾证据取数用 `listPendingCore` 硬上限 `sqlite.ts:3159 ORDER BY created_at DESC LIMIT 200`，生产 rejected=385 ⇒ **185 条更早的人工已拒绝对门②不可见**（消费点 `auto-adopt-gate.ts:78-84`）⇒ 可能自动采纳一个人类已拒绝过的主题。**缺陷 2**：写序非原子（`:92 upsertCore` 先写槽 → `:96 decidePendingCoreAuto` 后落账，失败仅 `:108 warn`）⇒ 无 `auto_adopted` 记录、无可回滚审计 | **本票是全 34 张里第 1 号上生产阻塞项**：`enabled:true` 已开、观察窗全窗 adopted=0/blocked=0/skipped=0，但**门②取数上限使它在数据量增长后必然错误**。修法：`listPendingCore` 加「按 topicId 取全量 rejected」的专用查询（不走 200 上限）+ 写入改单事务。**在修好前建议把 `enabled` 置回 false** |
| **#149** W1+W2 全开灰度与回滚演练 | **半（配置只在本机，观测与演练零落点）** | 本机 yaml 全开：`write.factKey.enabled:true`（`:71-84 mode:channel`）、`write.supersession.enabled:true`（`:85-91`）、`recall.validity.mode:soft`（`:221-222`）、`smallToBig maxExtraLines:4`（`:303`）。**云模板四项全关/硬**。A 档 82.2% vs B 档（W1 关）84.4% ⇒ 全开不是最优。**观测四项与回滚演练在全仓无任何代码/记录落点**（只有票面与 §26.6 提及） | 结论对，**顺序错**：在 `config.effective` 可自证之前演练回滚，会重演 #135 被 `config-override.json` 静默覆盖那次。**先做 §2.3-1 与 §3-2，再做演练**。回滚清单应含 fusion / presentTemporal / candidateK / rerank.mode 四键 | **保留，排在 #172 之后**；本票是「W1 去留」的裁决载体，但裁决依据应交 #168 |

---


## 5. 票面纠错清单

### 5.1 照票面做会出错的（11 处，必须先改票）

| 票 | 票面说法 | 真实 | 照做的后果 |
|---|---|---|---|
| #174 | 改 `excludeInvalidatedFor` 定序即可让 off 可达 | 还有第二层：`auto-recall.ts:1010` 的 `validityMode` 只看 `mode`，其消费点 `:1115`/`:1222` 仍硬丢 expired | off 仍不可达，白改一轮，且会误判为「off 无收益」 |
| #148 | 9 个旋钮从未进 schema（属回退） | `config.ts` 从来只有 `excludeInvalidated`+`validity.mode` 两项；`selectByValidity` 的 `hardOnPresentIntent` 是形参、调用点不传而已 | 会去「恢复」从未存在的配置面 |
| #155 | 结论卡没有 part_of 边，需回填脚本 | 写面已在落边（`consolidation-worker.ts:224-226`），真因是读面 `auto-recall.ts:1428-1433` 零边即 `continue`、不读 `metadata.evidence_ids` | 写一堆回填脚本，读面照样不读 |
| #156 | 结论卡缺 assistant 源，要双源蒸馏 + source_side | 结论卡由 L1 行蒸馏；真因是 L1 抽取提示词 `:71` 与 `:429-435` 自相矛盾 | 改结论层 = 白做（源头没数据） |
| #173 | 23 条不可达可直接删，其中已死三组含 `supersededRows` 空转 | 该块是 #166 值级遮蔽的唯一实现体且生产（soft）实际执行 | 删掉 = 静默回退一张已关票的核心能力 |
| #172 | k=10 相对 k=5 是 60/90 vs 56/90（+4） | 跨 commit 比较；同 commit 干净配对是 58→60（+2，噪声内） | 把 2 题噪声当成 4 题收益写进缺省 |
| #154 | 全开档含 W1/W2/W3/soft 全套 | 报告只自证 `B1+ck32+rerank off`，`factChannel:null`/`conclusionCards:null`/无 validity 键 | 登记一个不存在的配置为生产缺省 |
| #171 | 官方配比换算 A 57.3%、内部读数偏乐观 8-9pp | A 应 **57.0%**（pref 7/15 不是 8/15）；实际差 6.5pp / 5.2pp | 对外发布错误数字 |
| #170 | embedding 占检索 94.8%（对应 1282ms） | 94.8% 是**搜索子阶段内部占比**（167.6/180ms）；1282ms 在任何报告里都不存在（A 臂 p50 732） | 用错的分母讲成本故事 |
| #108 | 沿用 Panel 的 prettier 参数 | 实测套 Panel 配置 640 文件不一致、缺省 600 | 多改 40 个文件，且引入与仓库风格相反的引号 |
| #125 A11 | `MemoryKnowledge/src/openapi.yaml` 缺 source_type/source_url | 该路径不存在；实际 `MemoryKnowledge/openapi.yaml:778-785` 已含，Panel 早已展示 | 重复添加已存在字段 |

### 5.2 数字/行号陈旧（不影响结论，但会误导后来者）

| 票 | 陈旧项 | 现值 |
|---|---|---|
| #107 | 45 文件 | **44** 文件 / 243 错（错数正好） |
| #129/#113 | handler 8171 / sqlite 6755 / auto-recall 3256 | **8112 / 7059 / 4312**（auto-recall 差 33%） |
| #129 | promptMode 行号 190-194 / 75-78 | 83-86 / 75-78 |
| #129 | ADR 到 0008 | 实到 **0017** |
| #66 | 无第 2 次实跑；日历下限 2026-11-02 | 已有 3 次 live；下限 **≥2026-11-10** |
| #133 | 名下仍 open 9 张 | 34 张未关票里**一张都没有** |
| #125 B5 | 需补 `USER_CREATE_FAILED` | 后端无该产出方，补进去是死条目 |

---

## 6. 票间冲突与重复（7 组，必须先定归属）

1. **W1 事实通道去留：#150 / #152 / #168 / #173**。三票都挂起「等结论」，但**没有票是裁判**。唯一能判的是 #168（写侧实测）。⇒ 定 #168 为裁判票，#150/#152-② 依赖它，#173 的 `l1_fact_vec`/`fact_index` 清理也依赖它。
2. **读数定档四票汇合：#154 / #157 / #171 / #172**。四票都在「再测一次」，判分器/配置/样本各不相同。⇒ 合并为一个「定档工作流」：先 §2 基座，再 #172 出读侧结论，#157 并入 #172（同 commit 的 r146c 系列），#171 只做区间换算，#154 只做登记。
3. **W1 去留的裁决主体：#149 vs #154**。#149 有 A/B 实测（−2.2pp），#154 有门禁 B 与登记职责。⇒ **裁决归 #149（有 A/B），登记归 #154**，不要让 #154 去重新裁决。
4. **validity 三键归属：#173 vs #148**。#173 声称不碰 validity 三键，但其「死码 16 键」里含 `excludeInvalidated` 相关项。⇒ 明确：validity 派生链只归 #174/#148，#173 一行不碰。
5. **#173 vs #166（已关）**：见 §5.1。⇒ #173 执行前必须核对「被删代码是否是已关票的实现体」。
6. **上游同步裁决链：#129 → #127 → #107**。若 #129 裁决「跟随上游收窄」，则 #127 要重生成 `generated/schemas.ts`，而那是 #107 第一大错误源（51 错）。⇒ 顺序必须是 **#107 先锁基线 → #129 裁决 → #127 执行**。
7. **#133 与二阶段现状**：#133 名下的二阶段实际剩余是 #168（写侧）+ #169（证据包）+ #172（定档），票内表全过期。⇒ 关票并把这三条写进评论。

---

## 7. 无票覆盖的真实缺陷（M1–M12，建议新建）

| # | 缺陷 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| **M1** | 自动采纳门②取数被 `LIMIT 200` 截断 | `sqlite.ts:3159` → `auto-adopt-gate.ts:78-84` | 生产 rejected=385，185 条更早的人工拒绝对门②不可见 ⇒ 可能自动采纳人类已拒主题 | 并入 #92（P0） |
| **M2** | 自动采纳写序非原子 | `auto-adopt-gate.ts:92`/`:96`/`:108` | 落账失败仅 warn ⇒ 无痕人格写入、无可回滚审计 | 并入 #92（P0） |
| **M3** | `addLink` 未 await | `consolidation-worker.ts:225` | 异步 store 下 part_of 边可能丢（正是 #155 的现象之一） | 并入 #155 |
| **M4** | 结论层两处 validity 预筛用 `new Date()` 而非 `validityNow` | `auto-recall.ts:1115`/`:1222` | bench `--now` 在结论层不生效；与钩子路 `:3666`/`:3677`/`:3804` 不一致 | 并入 #174（第三处） |
| **M5** | `presentTemporal` / `rerank.mode` 未写入任何 yaml | `config.ts:243/:2135/:598` | 生产行为依赖代码缺省、无法审阅；翻缺省即无痕变更 | 并入 §3（Wave 0） |
| **M6** | 报告无 `config.effective` 快照 | `scripts/lib/bench/store.mjs:981-1026` 已有雏形 | 全部「全开」臂不可复现 | 新建（P0） |
| **M7** | 报告可被同名就地覆盖 | `r146c-*`、`r141-{b0,w2s,w3,w3x4,w3legacy}` 已发生 | §16.5 判对数已从磁盘消失 | 新建（P0，改为只追加） |
| **M8** | `bench-bucket-paired.mjs` 无 judge 配对门禁 | `:127` 只有 `exitCode=1` | §14.5/§24.3 分桶结论出自无门禁脚本 | 并入 M6/M7 同批 |
| **M9** | 云模板与本地 yaml 四轴相反、无同步票 | 见 §0 表 | 「生产跑哪套」无法回答 | 新建（P0，§3） |
| **M10** | §24.10 复现命令缺 `--validity-mode / --small-to-big / --conclusion-*` | `docs/optimization-results.md` §24.10 | 照抄会继承已变更的 yaml | 并入 #172 |
| **M11** | `MemoryPanel/web` 无任何测试运行器 | 全目录无 `*.test.*` | #124 B3/B4 类纯前端回归无法防 | 新建（低） |
| **M12** | `source_type` 在 chat-memory 上传路硬写 `"uploaded"` | `MemoryPanel/src/panel/http/routes/chat-memory.ts:495` | 知识库上传件类型失真 | 并入 #125（A11 重写） |

---

## 8. 依赖图与执行顺序

### 8.1 真实依赖（只列硬约束，不列「相关」）

```
Wave 0（测量与配置基座，无前置，阻塞 7 票）
  M6 config.effective 快照 ┐
  M7 报告只追加          ├─→ #172 / #154 / #157 / #171 / #149 / #170 / #158
  M8 judge 门禁补全      ┘
  重跑 r141 五臂（补判分）──→ §16 才能被引用
  M5/M9 yaml 一致性 + 显式键 ─→ #149 回滚演练 / #154 登记

Wave 1（正确性，互相独立，可并行）
  #174（validity 三态，含 M4 第三处）
      └─→ #148（同一派生三态第二次改造；颠倒会互回退）
      └─→ #151（normalized 与 validity 降权同刻度）
  #155（读面兜底 + M3 await）
  #156（改 L1 抽取提示词 :71，不动结论层）
  #124-B1（core 已支持，纯删代码）
  #92（M1 取数上限 + M2 事务；期间 enabled 置 false）
  #125-B7/B6 + M12
  #123（core 判定 + payload.provider）
  #152-①（能力位 + WARN，独立于 W1 去留）
  #173-③（真死码：fact_index 只写不读、插桩空转、injectTimeSort 双档）

Wave 2（判定型，必须等 Wave 0/1）
  #172（依赖 #174 + M6/M7/M10）──→ 读侧定档结论
  #157 → 并入 #172（用 r146c 系列，不重跑 90×N）
  #154（依赖 #172 结论 + M9；只做登记，不重新裁决）
  #149（依赖 #172 + M5/M9；裁决依据交 #168）
  #168（可提前到 Wave 1 末并行启动，但要独占机器跑长序列）
  #158（依赖 M6）

Wave 3（清理与治理，等所有裁决落定）
  #150 / #152-② / #173 剩余 ──→ 等 #168 判 W1
  #127（web 三份归一先做；收窄等 #129）
  #107（先锁基线，再清 243）→ #129 裁决 → #127 收窄
  #108（独立大 diff commit）
  #130 / #131 / #113 / #128 / #133

Wave 4（时间门控，无可执行项）
  #76（2026-11-01 到期回收）
  #66（≥2026-11-10，需 catch-up）
  #171（只在需要对外发数字时做）
```

### 8.2 四条「顺序颠倒就会出事」的硬约束

1. **#174 必须先于 #148**：两者改同一条派生链，先做 #148 会把 `softPenalty` 挂到错误的 mode 判定上，#174 修完再回退一次。
2. **Wave 0 必须先于任何「定档/翻转缺省」**：否则把不可复现的数固化成生产配置（#135 已踩过 `config-override.json` 静默覆盖）。
3. **#168 必须先于 #150/#152-②/#173-W1 部分**：没有写侧实测就没有 W1 去留的裁判，删或补都是猜。
4. **#92 的 M1/M2 必须先于再次开启自动采纳**：当前 `enabled:true` + `LIMIT 200` 是一个会随数据增长必然出错的组合。

---

## 9. 每票下一步动作与验收

（仅列「票面要改什么 + 做完的判定」，不重复 §4 的证据）

| 票 | 下一步动作 | 验收判据 |
|---|---|---|
| #174 | ①`excludeInvalidatedFor` 改为 flag 优先；②`auto-recall.ts:1010` 从同一派生三态取值；③`:1115/:1222` 改用 `validityNow`；④同步 `run-r141-factorial.sh:56/:81` 的臂名与期望串；⑤补三态×两 mode 单测 | 三态×两 mode 六格各有断言；`--validity-off` 在 soft 配置下 `effective=false` 且结论层不丢 expired |
| #148 | 只做：`hardOnPresentIntent` + `softPenalty` 配置化；工具路 `memory-search.ts:1654-1661` 对 soft 改为乘子对齐 | 两路同语义同刻度；`softPenalty` 在合成失效样本上可观测 |
| #155 | 读面：links 空则回退 `metadata.evidence_ids`；写面：`addLink` 加 await；存量脚本缩到极少数 | 生产连续 N 条结论层命中记录里 `candidates>0` ≥80% |
| #156 | 删/改 `l1-extraction.ts:71` 那一条，让 `AGENT_ACT_BLOCK` 生效；assistant 桶单独取样规则 | assistant 桶 turnCov 从 66.7% 回到 ≥80%，且 user 桶不退化 |
| #173 | 拆两半：③真死码（3 项）先做；①②降级为「休眠能力」文档化 + ADR 标注 | 删的每一处都有「生产不产生该数据」的实测依据 |
| #168 | 30-50 条同实体多值更新序列，三臂（现状/仅 supersession/两者） | 旧值注入率、重复行率、退化曲线三指标出表，并给出 W1 去留建议 |
| #150/#152 | ①能力位 + WARN 立即做；②实现与回填等 #168 | tcvdb 下不再静默空跑（有 WARN） |
| #151 | 把 normalized 抽成 `fusion.ts` 单一函数，两路共用；补 `factMs/factHits` 与 `·[fact]` | 工具路与钩子路同一函数、同一观测字段 |
| #172 | ①口径对账（同 judge + 同全开 store + 90 题四档）②实现 `calibrated` 档 ③k 与 wrapper 分开 A/B | `calibrated` 有类型、有解析、有「legacy/neutral 逐位不变」断言 |
| #154 | 只登记；扩样本等 M6/M9 | deploy 模板与本地差异有 ADR 白名单；回滚阈值量化 |
| #157 | 并入 #172，用 r146c（同 commit 5d71c12） | 不再重跑 90×N |
| #171 | 改 A 为 57.0%，改「偏乐观」为 6.5/5.2pp，给区间而非单点 | 换算表内部自洽 |
| #170 | 改报告 schema：row 加 `usage`、`searchTiming.rerankMs`；cost 段标 `estimated` | 报告能自证 token 与精排耗时 |
| #153 | gate 支持 `--prompt prod`，或两套 prompt 合一 | 生产 prompt 有 ≥1 份读数 |
| #158 | 补 `answerable` judge 字段 + 文档一节 | 字段进报告 schema；文档含三类行一阶贡献 |
| #124 | B1 下推 `asset_types`（core 已支持）；B2 加 `refreshNonce`；B3/B4 取上游版本 | 519 skill + 1 chat_memory 场景 tab 不再空白 |
| #125 | B7 修 `env()` 空串语义；B6 用同源 iid；B5 关；A11 重写为 M12 | `env('') ` 视为未设；多实例指向正确 |
| #107 | 先锁基线（计数入 CI artifact），再清 243 | 计数不回退；最终 0 |
| #108 | 改默认参数为 prettier 缺省；一次性 reformat 独立 commit | CI 加 memorycore-format job |
| #129 | 落 ADR（语义而非行号）；改第 5 条 | ADR 存在且不含易过期行号 |
| #130/#131/#113/#128 | 台账与裁决，Wave 3 | 各自「已裁决」结论落 ADR 或 CHANGELOG |
| #92 | M1 专用查询绕过 200 上限；M2 单事务 | 门②能看到全部 rejected；写入失败可回滚 |
| #149 | 观测四项落点 + 回滚演练脚本 | 演练有执行记录 |
| #76 | 到期回收 | 观察窗数据出表 |
| #66 | 改日历下限为 ≥2026-11-10 + catch-up | 同模型 ≥10 有效点 |
| #133 | 关票，评论写现状 | — |

---

## 10. 已否证，不要再试

以下都在本仓实测过并否证，任何票再提出即为回退：

1. **加宽/放宽余弦门槛**（`--emb-threshold 0.15`）：判对 18 vs 18，池 5.07 vs 5.57 ⇒ 门槛不是截断者。
2. **加大 k**：`sessionCov@10 == sessionCov@5` 88/90；10 个缺口题在 k=1/3/5/10 逐档相同 ⇒ k 不是闸门（唯一例外：`maxResults` 8-10 有 +2/90 量级收益，属噪声内）。
3. **事实行双写**（一条事实一行 + 投影表）：62.2% vs 58.9%，`p=1.0`，记录数 +60%。
4. **present-intent 值级遮蔽作为 LME 收益源**：它是正确的产品行为，但不是召回收益来源。
5. **「先整理笔记再答」类多步编排**：Y 臂（证据编排）空答 9/90，可作答 81 题上 60 vs X 臂 61 ⇒ 无收益。
6. **乘子为 0 的键**：`timeProxFallbackEnabled`（yaml 开但 `rerankWeights.timeProx=0`）、`ageDecay.*`、`graphDiscount/sceneBoost/coreRefBoost=0`、`importantPenalty`（罚中 0/90）、`nativeMinRRF`（sqlite 不可达）。
7. **`rerank.minScore=-10.5` 当门禁**：实测分域 [−10.18, +10.28]，恒不触发；它是「不钉」的刻度占位。
8. **`maxCharsPerMemory`/`maxTotalRecallChars` 当字符预算**：双 0，`auto-recall.ts:4011` 提前 return，从未生效（设 6000 会让 A 臂 10/90、X 臂 30/90 被截）。

---

## 11. 「可直接上生产」的判据（本审计的定义）

一张票只有在同时满足以下 5 条时才算 DoD 完成，否则不许标 ready：

1. **主张可复算**：票内的数字能在当前 commit 上重跑出来（或标注「历史读数 + 出处文件 + 该文件在 git 里」）。
2. **配置可自证**：涉及行为变更的，报告或启动日志里有 `effective` 快照；云模板与本地差异有白名单。
3. **回退有路径**：每个行为开关都能用单一配置键回退，且回退演练有记录。
4. **有门禁**：结论所依赖的脚本必须挂 judge 配对门禁；「`judged=0`」不得静默放行。
5. **不留半成品**：同一机制不允许「写面做了读面没做」「配置加了代码没用」「文档承诺了类型没有」（#155/#152/#172-calibrated 就是这三种）。

按这个定义，当前 34 张票里 **0 张完全满足**；最接近的是 #124-B1（只差一条回归测试）。这不是悲观结论——它说明**缺的不是工作量，是「完成」的定义**。

---

## 12. 与生产目标的差距闭合

- **不阻塞上线**（但阻塞下一次定档）：Wave 0 全部 + Wave 2 全部。
- **阻塞上线**：仅三项 —— #92（在 `enabled:true` 下必错）、#124-B1（已发生线上空白）、生产配置真源分裂（§3）。
- **可上生产后仍欠的**：写侧在线固化（#168，缺省全关）、多会话聚合（X 臂 multi 3/15）、成本口径（#170）。这三项决定「产品是否比 mem0 好」，而不是「能否上线」。
- **不该再投入的**：把内部 73.3% 往榜单上贴。本 harness 是 oracle 切分 + 90 题池化 + 自调提示，官方配比换算后是 66.8%，且 53% 权重压在两个 15 题桶上（Wilson CI 分别 [7,45]%、[36,80]%）⇒ 任何对外数字都应按区间发布。

---

## 13. 票面更正已落地（2026-10-31）

以下 22 张票的正文已追加「## ⚠️ 票面更正（2026-10-31，代码核对）」一节。更正内容与 §5.1/§5.2 同源，**更正节与原叙述冲突时以更正节为准**；原正文保留作历史。

| 票 | 更正要点 |
|---|---|
| #174 | 补第二层（`auto-recall.ts:1010 validityMode`）与第三层（`:1115/:1222` 用 `new Date()` 而非 `validityNow`）；补 bench 断言同步 |
| #173 | 三组「不可达」中 ①③ 判定不成立（③ 是 #166 值级遮蔽唯一实现体）；只保留真死码 3 项 |
| #155 | 根因由「缺 part_of 边」改为「读面不回退 `metadata.evidence_ids`」；补 `addLink` 未 await |
| #156 | 根因由「结论卡缺双源」改为「L1 抽取提示词 `:71` 与 `:429-435` 自相矛盾」；改结论层无效 |
| #172 | k=10 收益由 +4 修正为 +2/90（同 commit 配对）；`calibrated` 类型层不存在 |
| #154 | 「全开」只有 B1+ck32+rerank off 可自证；deploy 模板一处未翻；84.3 是 cov 不是判对 |
| #171 | A 由 57.3% 改为 57.0%（pref 7/15）；「偏乐观 8-9pp」改为 6.5/5.2pp |
| #170 | 94.8% 是子阶段占比；1282/2454ms 无出处（A 臂 732/2350）；须改报告 schema |
| #150 | 挂起理由由「缺省关」改为「W1 净收益 −2.2pp」（生产 yaml 实际全开） |
| #148 | 「9 旋钮」是设计意图非回退；真缺陷是工具路 soft 不降权 |
| #123 | 补 Panel 侧独立缺口（payload 无 provider ⇒ 恒绿 chip）；H-15 建议降级+WARN |
| #107 | 44 文件（非 45）；补「先锁基线」前置与 generated 重生成约束 |
| #108 | 参数方向改反：prettier 缺省 600 不一致 vs 套 Panel 640 |
| #113 | 体量数字全陈旧；「278/160」不可复算；需加「已裁决不跟」分区 |
| #129 | 铁律 5 无仓内支撑（两处都是 -chat）；体量数字与 ADR 进度全更新 |
| #130 | （未改，仅降级排序） |
| #131 | session-add 是改名；skill 版本清理本仓更全，移出「缺口」 |
| #128 | 权限面/凭据面已被代码消解，只剩 provider 抽象一个裁决 |
| #133 | 「仍 open」9 张全已关；二阶段真实剩余 = #168 + #169 + #172 |
| #125 | B5 关闭（无产出方）；A11 重写为 `chat-memory.ts:495 source_type` 硬写 |
| #66 | 「无第 2 次实跑」为假（已有 3 次 live）；日历下限后移至 ≥2026-11-10 |
| #92 | 补两条 P0：门②取数 `LIMIT 200` vs rejected=385；写序非原子无审计 |
| #175 | 五处未移植成立；补第 6 处路由缺口 `/dsh/:spaceId/v1/messages` |

未改动：**#76 / #124 / #127 / #169 / #151 / #152 / #158 / #149**（票面与代码一致，或仅有执行顺序调整，无需改正文）。

## 13.1 判定修订（2026-10-31，实施期复核）

实施 recall-core 在按 #173 动手前复核「双基线均不可达」的三项真死码，结论是**可删集合为空**，证据如下（推翻本审计 §4.1 与 §25.5 A 对 #173 的可执行部分）：

| 票面主张 | 实际 | 结论 |
|---|---|---|
| lineTypeStats 插桩空转，可删 | 不在 src，是 bench 在读的插桩：`MemoryCore/scripts/eval-memory-bench.mjs:1121` 生成、`:1163` 挂 row、`:1213-1217` 汇总、`scripts/lib/bench/inject-attribution.mjs:298-330` 实现 | 不是死代码，是「注入行 100% raw-turn」的观测仪表，删掉等于拆掉 #155/#158 的诊断依据 ⇒ **保留** |
| fact_index 只写不读，可删 | bench 读：`eval-memory-bench.mjs:844/:859`（`--prune-fact-sibling-index`，#166 验收④ IDF 隔离档）、`scripts/audit/r146-walkthrough.mjs:140` | 生产运行时不读为真，删写入会让 #166 诊断档失效 ⇒ **等 #168 判 W1 去留** |
| injectTimeSort / injectWrapper 双档可删 | bench flag 驱动：`eval-memory-bench.mjs:157/:583-588` → `scripts/lib/bench/store.mjs:78-79` → 消费 `auto-recall.ts:2076/:2082` | 是 bench 可复现能力，不是死码 ⇒ **保留** |

另有两处更重要的推翻：

- **组②「turn-first 整段(1849-1900)可删」会删生产路径**：实测只有 `auto-recall.ts:1888-1899` 的 `if (r7TurnFirst)` 是死的；同块 `:1849-1870`（R7 预算切片 + #54 动态 topK elbow）与 `:1900-1905`（else 分支组装/预算/fts 帽）是活代码。且 `routing=intent` 非零使用（`scripts/run-r141-factorial.sh:65`、`run-r141-ablate.sh:46/:52`）。
- **B 组 16 键「删 yaml 行」会反向打开通道**：`graphDiscount/sceneBoost/coreRefBoost` 在 `tdai-gateway.yaml:187/:188/:189` 显式为 0，但消费点回落值是 0.6（`auto-recall.ts:1718`）/0.04（`:1720`）/0.05（`:1680`）⇒ 只删键不改回落值，图补池与场景补池会从关静默变开（`:174-189` 注释记着「有害才关」的 A/B 依据）。ppr* 同理内部有默认值。

**因此 #173 的执行形态改为**：
1. A 组 → 加 `@evidence` 注释（按后端/按档休眠，非死码），不删；
2. B 组 → 拆成独立票，每键必须「删 yaml 行 + 删解析器 + 消费点回落值改成当前生产值」三件同改，其中 graph/scene/coreRef/ppr 属「删键即开通道」，需要单独设计；
3. fact_index → 等 #168。

这条修订的意义：审计当时判「A 直接删 ~300 行」是基于可达性静态分析，实施期用「bench 是不是消费方」这一层重新过滤后发现三条都漏了 bench —— **凡是被 bench flag 驱动的东西，在完成「bench 退役」之前都不是死码**。这条可以外推到后续所有死码清理。

## 3.1 生产真源的第三条事实（2026-10-31 补，来自 #149 演练单编写时的一手核对）

前文说「配置真源分裂」，实施期发现比「分裂」更严重的一条：**走 global-images 部署时，这些键根本不在生效的 yaml 里**。

`deploy/global-images/start-memory-core.sh:60-105` 在每次启动时**重写** `tdai-gateway.yaml`，重写内容不含 recall/write 的任何实验键。因此：

| 部署形态 | write.factKey | write.supersession | validity.mode | rerank.enabled |
|---|---|---|---|---|
| 代码缺省（parseConfig({})） | false | false | hard | false |
| global-images（start-memory-core.sh 重写） | false | false | hard | false |
| 云模板 deploy/tencent-cloud/.../tdai-gateway.cloud.yaml | false | false | hard（:210-211） | false |
| 本地实验档 MemoryCore/tdai-gateway.yaml | **true** | **true** | **soft**（:216/:222） | true |

结论：**四处里只有本地实验档是全开/soft，其余三处一致地全关/hard**。这意味着：

1. 本审计 §1「三套基线」应更正为「**四点**」：代码缺省 = global-images = 云模板（三处一致），本地 yaml 是唯一的异类。
2. 因此 §25.5 E 里「生产永远走不到 soft 块」的直觉在**云/global-images** 上成立，在**本地实验档**上不成立 —— #173 组③ 的裁决必须写明「按部署形态分叉」，不能一句「生产走不到」带过。
3. 更关键：bench 用本地实验档（全开）读数，而生产跑全关 ⇒ **bench 读数与生产行为系统性地不是同一套配置**。这不是「口径不严」，是「测的东西不是跑的东西」。修复顺序必须是：先让 bench 的报告里落 `config.effective`（已由 WP4 的 M6 落地），再讨论任何「生产收益」。
4. `recall.rerank.*` 还会被 `config-override.json` 静默压过（`MemoryPanel`/gateway 的 settings-override.ts:55-61 只覆盖六段，而 override 优先于 yaml），#135 踩过一次。演练与 bench 都必须先确认「进程读的是哪一份」。

## 13.2 实施期新增结论（2026-10-31，第二批）

**M13（无票缺陷，本轮修复）**：`recordToFormatable`（`MemoryCore/src/core/hooks/auto-recall.ts:4262-4320` 原实现）构造 `FormatableMemory` 时不拷 `sessionId`，而 FTS 通道 `:3187` 明明映射了 `record.sessionId` ⇒ `hybrid.metas.sessionId` 恒空 ⇒ **#162 的「同会话免疫」在 FTS 通道整段降级为「无来源」**。修法：补 `sessionId: record.sessionId || undefined`（现 `:4323`，行首带 `【#162 同会话免疫依赖 sessionId 传递】` 注释）。影响面：#162 的折叠行为从「降级态」恢复「正常态」，属行为变化，回归（recall-fold-cluster / small-to-big / near-dup）全绿。

**#173 修订补一条边界**：判「死码」必须先问「bench 是否消费」。本轮 16 键里 `graphDiscount/sceneBoost/coreRefBoost/ppr*` 在 yaml 显式为 0、而消费点回落值是 0.6/0.04/0.05/内部默认 ⇒ **删 yaml 键会反向打开通道**，必须三件同改（删键 + 删解析器 + 回落值改成当前生产值），单独立票（见 §13.1）。

**#175 的一处票面推测被证伪**：票面要求补「dsh form 帧流尾未正确关闭（STREAM_CLOSED）」。全仓 grep `STREAM_CLOSED`/`ensureStreamEnd` 零命中，且 form 帧在 `MemoryProxy/src/anthropicHandler.ts:860` 就 return，根本不经过 `:1595` 的 `createSseThinkingFixStream` ⇒ **无法复现，未实现**。替代做法是 `:860` 前加协议一致性守卫（content-type 与请求 stream 期望不符即 `console.warn("[session-init:dsh] ...")`），把「OpenAI↔anthropic 错配」从静默失败变成响亮日志。若真客户端报 stream close，须先拿到 parser 报错原文再补帧。

**#127 只完成了「读侧归一」**：Panel 三处 union 已收敛为 `manual|external|other` 且 `backendStore.ts:253` 不再把 external 折成 manual；但 core 侧 `MemoryCore/src/gateway/v2-schemas.ts:260` 的 zod 仍是 4 值（`manual|github|tapd|other`），**写 external 会被 400 拒** ⇒ 写侧仍限 `manual`。core 收窄是独立待办（要同时改 zod + `TaskData.source_type` + metadata 层默认值）。

**两处脚本/快照的因果链缺口，本轮已闭合**：
- `MemoryCore/scripts/run-r141-factorial.sh:81` 的 `EXPECT_W2_OFF` 未随 #174 同步 ⇒ `--expect-config` 会 exit 2，W2_OFF 五臂白跑（已改为断言 `effective=false`）。
- `scripts/lib/bench/store.mjs` 的 `effectiveRecallSnapshot` 未收录 `recall.evidencePack.*` ⇒ 只能靠放宽 `ALLOWED_RECALL_KEYS` 让测试变绿，而 allowlist 宽于快照会让「拼错的键名」被放过（已收录两键并删除手工补登）。

**判据外推（对后续死码清理与配置收敛都适用）**：
1. 凡被 bench flag 驱动的东西，在「bench 退役」之前都不是死码；
2. 凡 benchmark 断言的键，必须 ⊆ 生效快照键集，白名单只能收紧不能放宽；
3. 凡「删配置键」必须同时处理消费点的回落默认值，否则删的是「显式关」而不是「关」。
