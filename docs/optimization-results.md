# 记忆检索优化路线实施结果（B0→B2-a→B1→B2-b）

> **执行日期**：2026-10-26 深夜 – 2026-10-27（本分支 `bench/recall-opt`）。
> **对照文档**：[optimization-plan.md](./optimization-plan.md)（v2，§7 执行清单 + §8 预期）。
> **评测口径**：LongMemEval-oracle LME90（分层抽样 manifest，seed=20261027，6 题型×15=90 题——**修正：数据集只有 6 题型，非文档所写 7 题型×15=105**），串行单进程 --pace 150，judge=answer=同一凭据温度 0，判分口径 lme-v2（correct/refused 双字段）。
> **全部跑批日志与报告**：`MemoryCore/.eval-data/bench/`（run-*.log + longmemeval-oracle-*.json/md，tag 见下表）。

## 0. 一句话结论

> **2026-10-27 下午修正（§10）**：精排本身不是净负项——伤害来自 `candidates=12` + `minScore=-2` 的**过度剪枝**（把 30% 的题剪到只剩 1 行证据）。保留 rerank、把池扩到 32、floor 放到 −10.5，turnCov@5 = **84.3%**（+16.67pp vs b0-base，CI[+9.05,+24.29]，p=0.0005），高于「关掉 rerank」的 79.5%。下文 §0 首段与 §1 表内 b1-off 行（以及 §2 末尾的历史档注）为下午修正前的原始结论，保留作历史记录。

**精排（本地 bge-reranker-base，minScore=-2 logit-sigmoid 闸门）在 LME90 上是净负项：关停 = turnCov@5 +12.0pp（67.1%→79.5%，CI[+4.1,+20.0]）且延迟 -7.3s、答案判对持平；B1 读侧四件套（时间序证据+CoN 引用+NOT_ENOUGH_INFO 出口+英文指令）在答案侧大胜：判对 38.9%→54.4%（+15.6pp，McNemar p=0.001），拒答 51%→30%。B2b 三项（MMR/validityNow/向量门槛）一项显著负、两项无效。**

## 1. 最终汇总表（基线 b0-base vs 各档，同题配对 n=90）

| 档 | 配置 | turnCov@5 | Δ[95%CI] | avgHits@5 | 判对(Δ/p) | 拒答 | latP50 Δ | 显著 |
|---|---|---|---|---|---|---|---|---|
| **b0-base**（T0 基线） | rerank on，minScore -2，pool 12，docCap192，生产 prompt | **67.1%** | — | 0.95 | 38.9% | 51.1% | 7451ms | — |
| b2a-pool32（T1） | pool 12→32 | 67.1% | +0.0 [-3.3,+3.3] | 0.95 | +0.0/p=1.0 | 54.4% | +1831ms | ns |
| b2a-ms0（T2） | minScore→0，pool32 | 68.4% | +1.3 [-5.6,+8.1] | 1.01 | **-5.6pp**/p=0.063 | 55.6% | +2387ms | ns |
| b2a-ms105（T3） | minScore→-10.5（≈全开），pool32 | 67.1% | -0.0 [-7.4,+7.4] | 0.93 | **-5.6pp**/p=0.302 | 57.8% | +1864ms | ns |
| **b2a-off2（T4）** | **rerank 关停**，pool32 | **79.5%** | **+12.0 [+4.1,+20.0]** | **1.20** | +0.0/p=1.0 | 53.3% | **-7292ms** | *** ✅** |
| **b1**（S4） | T0 召回 + 读侧四件套 | 67.1% | +0.0 [0,0] | 0.95 | **+15.6pp/p=0.001** | **30.0%** | -6872ms | ns（检索不变）|
| b2b-mmr（T5） | MMR λ0.7 | 62.3% | **-4.6 [-9.8,-0.4]** | 0.86 | -3.3/p=0.250 | 56.7% | +138ms | *** ❌** |
| b2b-validity（T6） | validityNow=题目日期 | 67.1% | +0.0 [0,0]（逐题完全一致） | 0.95 | -2.2/p=0.625 | 55.6% | -743ms | ns |
| b2b-eth015（T7） | 向量门槛 0.3→0.15 | 68.2% | +1.1 [0.0,+3.3] | 0.97 | +0.0/p=1.0 | 51.1% | +28ms | ns |
| **b1-off（组合推荐档）** | T4 + B1 | **79.5%** | **+12.0 [+4.1,+20.0]** | **1.20** | **+31.1pp/p<0.001** | **15.6%** | **-7297ms** | **\* ✅** |
| b1-off-ad30（V1） | T4+B1+ageDecay30 | 79.5% | +12.0（与 b1-off 逐题一致 0/90） | 1.20 | 68.9% | 14.4% | -7293ms | ns（时间衰减在 hybrid RRF 路无实现点，见 §5b） |
| b2a-filter7（V2） | T0+filter-only floor=-7 | 67.1% | +0.0 | 0.95 | 44.4% | 43.3% | -6798ms | ns（安全无净增益，off 仍最优，见 §5b） |
| g1（G1 档） | T0+时间序+中性包裹 | 67.1% | +0.0（块序不影响 cov） | 0.95 | 43.3% | 36.7% | -6212ms | ns（拒答 -14.4pp） | |

注：`*` = 95%CI 不含 0。docCap=192 = bench 精排打分前每条文档截断 192 字符（跨档一致，见偏差 5）。b2a-off 首跑（21-55-11）因 override json 吞键无效，已修复重跑为 b2a-off2。

## 2. 生产推荐配置（2026-10-29 起：rerank 开 + 深池 32 + floor 走 provider 缺省 + B1 读侧四件套）✅ 已实测

```yaml
memory:
  recall:
    candidateK: 32         # 与 rerank.candidates 同步；不钉会随池深变 maxResults×3=96
    rerank:
      enabled: true
      provider: local
      candidates: 32       # 池扩到 32：kept≥4 从 38/90 → 80/90 的前提
      # minScore 不钉：缺省按 provider 原生刻度取（local logit −10.5 / 0..1 概率刻度 sigmoid(−10.5)）
      # blend 键已整体删除：α 混合在深池（−3.64pp）与浅池（−1.15pp）两档都无净收益，排序直接吃精排结果（§21.6）
```

> ⚠ **只钉「有实测作用」的键（§21 开关台账）**：`minScore` 已从云模板/本地 yaml 撤掉钉子（按 provider 刻度算才安全，钉死 −10.5 在概率刻度 provider 上等于永不过滤）；`blend` 更进一步——深池（−3.64pp）与浅池（−1.15pp）都测不出净收益后，**配置项与混合逻辑已整体删除**（§21.6）。生产口径 = **代码缺省**；落盘的只有必须显式开的 `enabled` 与两个**防漂移型钉子**（`candidates: 32`、`candidateK: 32`，值都等于缺省，钉住是为了不让已验证的池深被静默收回），其余吃缺省。

**检索侧（§10，n=90，judge=MiniMax-M3.1-Flash）**：deep105（32/−10.5）turnCov@5=**84.3%**（+16.67pp vs b0-base 67.1%，CI95[+9.05,+24.29]，p=0.0005，30W/8L/52T），高于「关掉 rerank」的 79.5%；kept≥4 从 38/90 升到 80/90。剪枝才是伤害源，只扩池不加 floor 无收益（T1 Δ=0）。
**重排融合修复后（§13.5，#137-F）**：blend α=0.9 + 融合锚点 + floor 补位 → 80.5%（MRR 0.761、判对 81.1%），在 #137 全开档口径下仍差 off 5.6pp（McNemar 7/2，p=0.18 不显著）。
**答案侧**：B1 读侧四件套（时间序证据 + CoN 引用 + `NOT_ENOUGH_INFO` 出口 + 英文指令）单独带来判对 +15.6pp（38.9%→54.4%，McNemar p=0.001）、拒答 51%→30%，与检索侧收益叠加。

**刻度提醒（#145）**：`minScore` 恒按 provider 原生刻度声明——`local` 是 logit（−10.5 在本批日志分布左侧 ≈ 不剪枝，真正剪枝只有 candidates cap）；0..1 概率刻度的云 provider（`siliconflow`/`dashscope`）不能照抄 −10.5（那等于永不剪枝、与 −2 不等价），代码缺省已按 `sigmoid(-10.5)≈2.75e-5` 换算，见 `src/core/recall/rerank/defaults.ts`。不要把 minScore 往 −2/−4 收（实测误杀 gold 33.1%/18.8%，§13.5）。
**只滤不重排的降级档**：`mode: "filter"` + `filterRule: "quantile", filterKeepRatio: 0.5`（首选）或 `filterRule: "margin", filterMarginTop: 8`（次选）；缺省 `filterRule: "floor"` 保证旧配置逐位不变（§19）。
**限制**：`mode`/`filterRule` 目前只能写 yaml，`settings-override.ts` 的 `RerankSettingsOverride` 不认这些键（§19.9）。`blend` 已不是配置项（§21.6 删除）。

> 历史档（2026-10-27 下午修正前）：「rerank.enabled=false + B1」曾是推荐配置（b1-off，turnCov@5=79.5%、判对 70.0%、拒答 15.6%、latP50 159ms），数据仍在 §1 表内，保留作对照。

## 3. 分阶段结论（对照文档 §7/§8）

### B0 校尺（S1/S2）✅
- manifest（seed=20261027，6×15=90）、gates/timing/answerModel/turn_cov@10 透出、judge 温度 0 + prompt 版本记录、bench-paired 配对工具——全部落地入库（commit 4fd9eac/1c21cf8/515ab38）。
- 新基线（b0-base）：turnCov@5=67.1%、avgHits@5=0.95、判对 38.9%、拒答 51.1%。

### B2-a 精排闸门（S3）——结论与文档预期相反 ❌→✅
- 文档预期：minScore 重标 + 池扩容使 avgHits 2.63→4+、turnCov ≥52%。
- 实测：**三档 minScore 全 ns；池扩容（T1）被两处上游事实锁死无效**——(a) 候选池上游上限 candidateK=maxResults×3=15（auto-recall.ts:2274），32>15 无意义；(b) -2.0 闸门把池外扩的噪声候选全杀（kept 分布 T0 3.03 vs T1 3.19）。
- **T4（关停）= 唯一显著正向：+12.0pp turnCov@5、延迟 -7.3s、判对持平。**
- 附带实证：精排 reorder 集中伤 knowledge-update（9/23 hurt）——多 gold turn 的更新类问题被「最相似单行」挤出第二 gold turn。
- 停止条件（连续两批提升 <3pt）在 B2-a 内即触发 → 按文档转 D1–D7 归因（本报告 §4）。

### B1 读侧四件套（S4）✅✅ 超预期
- 判对 38.9%→**54.4%**（+15.6pp，McNemar p=0.001）、拒答 51.1%→30.0%、f1 0.188→0.364。
- 文档 §8 目标「answer-correct ≥35%」**已超额**（54.4%）；拒答率 <20% 未达（30%），残因=证据不足题 + 模型保守，需 D 系归因后再压。
- 全部改动 bench 侧（llm.mjs buildAnswerPromptV3/buildEvidenceBlock/extractFinalAnswer，--b1 开关），生产读侧未动（按方案「bench 先行，生产另开票」）。

### B2-b 杂项（S5）——三项全部否决 ❌
- MMR λ0.7：**-4.6pp 显著负**（CI 不含 0）——与精排同理，多样性重排挤掉 companion gold。不开。
- validityNow=题目日期：**逐题 bit 级一致（Δ=[0,0]）**——bench 语料 ingest 不带 valid_end/失效语义，D6 前提在本管线不成立。保留修复代码（对未来带失效语义的语料无害），bench 无收益。
- 向量门槛 0.3→0.15：+1.1pp ns——native hybrid 路不读 scoreThreshold（文档 §B2-b 已预言「形同虚设」），实测确认。

### B3（K=V+fact）/ B4（时间降权）——不启动
按 §7 视 B0–B2 结果决定：B2-a 结论是「排序干预全负」，B3 的结论层接入与 B4 的降权都属排序干预族，且停止条件已触发 → 不启动，转 D1–D7 错例归因（本报告 §4）。

## 4. D1–D7 归因更新（基于本轮证据）

| # | 文档原判 | 本轮证据 | 更新 |
|---|---|---|---|
| D1 精排闸门误杀 | 头号可修项 | **证实且更糟**：T0（闸门开）vs T4（关）=-12.4pp；三档 minScore 修不回来（重排本身伤多 gold 题） | 建议生产 A/B 关停精排（或仅对 ≤3 候选短行场景保留） |
| D2 turn_cov 差距 | 检索管线 | 原序（无精排）即可达 79.5% | 瓶颈不在排序，在池内容（见 D3） |
| D3 粒度/键 | 结论层没上场 | 未测（B3 不启动） | 维持 |
| D4 读侧裸 | +10pp 量级 | **证实**：+15.6pp（判对） | B1 进生产读侧票据 |
| D5 向量门槛 | 中 | 0.15 无效（native 路不读） | 关闭该线索 |
| D6 bench 时钟 | 单点必修 | 修复后零差异（语料无失效语义） | 代码保留，无 bench 收益 |
| D7 prompt 诱导拒答 | 高 | **证实**：拒答 51%→30%、判对 +15.6pp | B1 已修 |

## 5. 与文档 §8 预期的偏差清单

1. **LME105 → LME90**：数据集实为 6 题型（非 7），6×15=90。CI ≈ ±9.3pp。
2. **基线绝对值口径**：文档 §8 的 turn_cov@5~46%/avgHits 2.63/correct 5% 来自探针-era 口径（旧管线+旧判分）。本轮 LME90 新基线=67.1%/0.95/38.9%——**验收对比一律以 b0-base（20-31-16）为 T0，Δ 与 CI 为准**，绝对值不与文档数字横比。
3. **B2-a 结论反向**：文档预期精排重标后 turnCov ≥52%（相对 +5pp）；实测最优动作是关停（+12pp），且任何 minScore 档都不优于关停。
4. **拒答率 <20% 未达**：B1 后 30.0%。剩余拒答集中在多 gold/弱证据题，需 D 系继续。
5. **avgHits@5 口径**：本轮=平均每题 top-5 命中 gold 证据 turn 数（数据集证据标注现算）；文档 2.63 为旧口径，不横比。
6. **bench 精排文档截断 192 字符**（RERANK_DOC_CAP）：onnx q8 在本机 ~30 GFLOPS，全量文档单次 20-60s 不可跑批；截断跨档一致保 A/B 公平，生产不受影响（生产行短）。
7. **精排子进程隔离**：onnxruntime-node 在 bench 进程内 worker_threads 原生崩溃（exit 127=ACCESS_VIOLATION）→ ChildProcessReranker 隔离 + 4 次请求主动回收。仅 bench 传输层变化，模型与打分代码同款。
8. **query-expansion 在 bench 进程内强制关**：qe LLM 外呼无网关端点恒超时（29s/题黑洞）；超时路径本就退化为无扩展词，关断后各档语义一致。

## 5b. 最小验证补充（V1/V2，spec #133）

- **V1 b1-off + ageDecay30**：与 b1-off 逐题 bit 级一致（0/90 差异）。F6b 的 timeProx 乘子作用于 composite 分数路，hybrid RRF 路 rank-based 无分数可乘 → 零差异为必然。「时间感知排序」需 R2 加权融合（recency 作显式特征）才会在该路生效——R2 立项证据 +1。
- **V2 rerank filter-only floor=-7**：cov 67.1%（=T0，低于 off）、判对 44.4%（+5.6pp vs T0, ns）、拒答 43.3%。过滤器化安全（无重排伤害）但 floor=-7 丢低分 gold、无净增益——生产若需去噪，floor 应 ≤-10.5 或改校准概率。off 仍最优。
- 结果已追加至 issue #133 评论。

## 6. 跑批命令与产物索引

```
# 全部档（串行、复用同一沙箱库零重灌）
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval \
  --manifest .eval-data/bench/lme-manifest.json --store "$TEMP/tdagemem-bench/longmemeval-oracle-mvphl2m1" \
  --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-child-proc \
  [--rerank-off] [--b1] [--mmr] [--b2b-validity] [--emb-threshold 0.15] --tag <tag>

# 汇总
node scripts/summarize-bench.mjs <base.json> <trial...>
node scripts/bench-compare.mjs <base.json> <trial.json>
```

报告 tag→文件：b0-base=20-31-16、b2a-pool32=20-52-05、b2a-ms0=21-13-18、b2a-ms105=21-35-16、b2a-off2=23-19-17、b1=23-29-06、b2b-mmr=22-14-10、b2b-validity=（22-3x）、b2b-eth015=（22-5x）、b1-off=（23-4x）。

### 生产接线（本票落地口径，2026-10-27 复核补齐）

票面要求「可完整上生产」，因此三项均有明确的生产落点（此前 W1/W2 只有 bench 脚手架，已补齐）：

| 项 | 生产 seam | 缺省 | 证据/说明 |
|---|---|---|---|
| **W3 读侧** | `auto-recall.ts` R7-1 结论层 + #78 `smallToBig`（生产既有代码） | yaml `recall.smallToBig.enabled=true`（生产早就开着），`maxExtraLines` **2→4**（本次） | §8 w3b：判对 +14.4pp CI[+6.7,+23.3]（**scm-flash 判分**；judge 对齐后为 +6.7pp/p=0.146，见 §8「判分器注记」），cov 持平；注入总行数由 maxResults 硬帽收口 |
| **W3 写侧** | `consolidation-worker.ts` / `reflection.ts` 既有 work_fact 结论卡 + `part_of` 边 | 既有能力（生产已在产出） | bench 的蒸馏卡是 bench 侧替身；生产不需要新增写链 |
| **W1 事实键** | `l1-writer.ts` embedding 键：`embeddingKeyFor(record.content, memory, writePolicy)`；事实来源 = dedup LLM **顺带抽取**的 `metadata.subject`（零额外 LLM 成本） | `memory.write.factKey.enabled=false` | bench +6.7pp 不显著（CI 含负）→ 按票面规则默认关；待生产语料复核后一行配置开启 |
| **W2 supersession** | `l1-writer.ts` dedup 的 `update/merge` 决策：旧行由「归档」改为 `invalidateL1` 写 `valid_end`（只标记不删除）+ 新行补 `valid_start` | `memory.write.supersession.enabled=false` | bench cov -10.9pp 显著负（LME90 gold 含旧值 turn）→ 默认关；事实级粒度细化留待生产语料验证 |

- **配置**（两个部署 yaml 均已加，含注释）：`memory.write.factKey.{enabled,separator,maxFactChars}`、`memory.write.supersession.enabled`；`tdai-gateway.yaml` 与 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 同步。
- **测试**（生产 seam，非 bench）：`write-policy.test.ts`（4 例契约）、`l1-writer.write-policy.test.ts`（4 例写面行为：缺省归档 / W1 键拼接 / W2 只标记 + valid_start / 后端无 invalidateL1 回退归档）、`config.write.test.ts`（3 例解析与 clamp）。全量 vitest 253 文件 / 2299 例通过；typecheck 无新增错误（基线 243 条既有）。
- **生效方式**：改 yaml → 重启网关（重启权归用户，本票不代跑）；W1/W2 开启前需生产语料复核（bench 证据指向「保持关」）。
- **已知边界**：W1 的生产事实来源目前只有 `metadata.subject` 单短语（bench 用多短语 triples）；如需多事实键/事实级 supersession 粒度，需扩展 extraction/dedup 输出结构，属后续票。

## 7. 后续建议（P0–P2）

- ~~**P0 生产 A/B**：生产网关灰度 `rerank.enabled=false`（或 minScore→-10.5 等价于近全开）~~ —— **已被 §10 推翻并由 #145 落地**：生产默认改为 rerank **开** + `candidates=32` + `minScore=-10.5`（provider 刻度感知），见 §2；关停档降级为历史对照。
- **P0 B1 生产化**：injector 注入块渲染按 B1 四件套改造（时间序+CoN+NOT_ENOUGH_INFO+中性英文包裹），bench 已验证 +15.6pp。
- **P0 结论层回捞（W3，§8）**：生产 `recall.smallToBig.enabled=true`，**maxExtraLines=4**——judge 对齐口径 77.8%→84.4%（+6.7pp，CI[+0.0,+14.4]，n=90，p=0.146；点估计最大、拒答 8.9% 最低、cov 持平）；生产结论卡由 consolidation 既有产出，读侧零改动。
- **W1/W2 维持默认关（§8，yaml 已回退）**：全开档判对与基线打平（Δ 0.0pp）、cov -4.6pp、且比只开 W3 显著更差（-6.7pp，p=0.031）；W1 需多事实键、W2 需事实级粒度 + 生产语料（有失效语义）复核——已立后续票（#136/#137）。
- **P1 candidateK 解锁**：若未来要重试池扩容，先解 auto-recall.ts:2274 `candidateK=maxResults*3=15` 对 rerank.candidates 的隐式上限（本轮 T1 因此无效）。
- **P1 拒答残余 30%**：按 D 系继续归因（多 gold 题证据聚合、B1 证据 note 质量抽查）。
- **P2 onnx 推理提速**：fp32/不同量化/DirectML EP/升级 onnxruntime——bench 30 GFLOPS 明显低于硬件能力。

## 8. 第二波「写入治本」（issue #134：W1 事实双写 / W2 双时态 supersession / W3 结论层接入召回）

> **执行**：2026-10-27（本分支 `bench/recall-opt`）。**基线**：b1-off（tag 23-42-59：turnCov@5 79.5%、判对 70.0%、拒答 15.6%，同题配对 n=90）。
> **实验方法**：每档**从 b1-off 基线沙箱库复制**，只补写本档差异（`--store` 分阶段写入）——语义等价重灌，避免全量重 embedding（豆包 embedding 账号级 RPM 限流：全量 1591 轮重灌实测 5 组/222s，不可行；分阶段写入 90 组 0-4s）。query 向量走磁盘缓存（embedding 确定性，语义零变化），因此**延迟口径跨档不可横比**，本表不列延迟。
> **抽取器**：`MiniMax-M2.7`（端点小模型档，非长思考 reasoning 档）离线批处理，`--fact-model` 可配；只抽 user turn（assistant 轮实测抽出世界知识噪声）。**抽样验收门禁**：40 turn / 95 条事实，审计器 M3.1-Flash，**accuracy 92.6% ≥ 90% → PASS**（`fact-gate-2026-10-27T02-17-53.json`）。
> **口径**：① 缺口桶 = base `turnCov@5` < 0.5 的数值行（11 题；另有 3 题 null=无证据标注不计入），回收 = trial `turnCov@5` ≥ 0.5 **且严格上升**；② 每档独立跑批（同 manifest、同 pace、同宣判口径），w13/combo 为叠加档（从 w1 库复制，表内注明）。

**判分器注记（#140）**：本表所有判对/拒答 Δ 均为 **`scm-flash`** 判分（2026-10-26 批次，判分提示版本 `lme-v2`）；与 10-27 起 MiniMax 判分的档位**不可配对**，跨 judge 配对会被 `bench-compare`/`bench-gates`/`bench-ranking` 拒判（exit 3）。judge 对齐后的数字见本节「Judge 对齐后的最终排名」。

| 档 | 配置（自 b1-off 基线） | turnCov@5（Δ vs b1-off） | 判对（Δ / 95%CI / McNemar p） | 拒答 | 缺口桶回收 | 答案门禁 | 覆盖门禁 |
|---|---|---|---|---|---|---|---|
| b1-off | 基线（T4+B1） | 79.5% | 70.0% | 15.6% | — | — | — |
| w1 | + W1 事实键双写（K=V+fact） | 77.0%（-2.5 [-6.3,+0.8]） | 76.7%（+6.7pp / [-1.1,+14.4] / 0.146） | 14.4% | 2/11 | ✗ CI 含负 | ✗ |
| w2 | + W2 写时 supersede（validityNow=题目日期） | **68.6%（-10.9 [-17.0,-5.7]）** | 75.6%（+5.6pp / [-1.1,+13.3] / 0.227） | 10.0% | 0/11 | ✗ | ✗ 显著负 |
| **w3** | + W3 结论卡（work_fact）+ part_of 回捞 | 76.3%（-3.3 [-10.3,+3.4]） | **81.1%（+11.1pp / [+2.2,+20.0] / 0.031）** | 10.0% | 4/11 | **✓ PASS** | ✗ 差 1 题 |
| **w3b（推荐）** | + W3 结论卡 + part_of 回捞（maxExtraLines=4） | **79.3%（-0.2 [-7.7,+7.1]）** | **84.4%（+14.4pp / [+6.7,+23.3] / 0.0023）** | **8.9%** | **5/11** | **✓ PASS** | **✓ PASS** |
| w13（叠加） | W1 + W3 | 74.0%（-5.6） | 78.9%（+8.9pp / [+0.0,+18.9] / 0.115） | 12.2% | 4/11 | ✗ 边界 | ✗ |
| combo（叠加） | W1 + W2 + W3 | 71.3%（-8.2） | 77.8%（+7.8pp / [-1.1,+16.7] / 0.144） | 12.2% | 4/11 | ✗ | ✗ |

**证据索引**：w1=`…-03-09-19`、w2=`…-04-44-24`、w3=`…-04-33-21`、w3b=`…-04-55-56`、w13=`…-04-11-25`、combo=`…-03-59-44`；抽取门禁=`fact-gate-2026-10-27T02-17-53`。

### Judge 对齐后的最终排名（MiniMax 判分，2026-10-27 复核）

**方法学修正**：上表的 b0-base/b1-off 是 2026-10-26 用 **scm-flash** 判分的（判分器随 admin settings 在 10-27 00:09Z 切到 MiniMax）。跨判分器配对会放大/缩小差异，故用 **MiniMax-M3.1-Flash** 重跑两个基线（同 manifest/同沙箱库副本/同宣判提示），并以此重排：

| # | 档 | 判对 | Δ vs b0-base-mm [95%CI] | 拒答 | turnCov@5 | 说明 |
|---|---|---|---|---|---|---|
| - | **b0-base-mm（初始基线）** | 45.6% | — | 40.0% | 67.1% | scm-flash 旧判分 38.9% → MiniMax 45.6% |
| 1 | **w3b（W3 + 回捞 4 行）** | **84.4%** | **+38.9pp [+27.8,+50.0]** | **8.9%** | 79.3% | 生产已开（本档） |
| 2 | w3（W3 + 回捞 2 行） | 81.1% | +35.6pp [+24.4,+46.7] | 10.0% | 76.3% | |
| 3 | w13（W1+W3） | 78.9% | +33.3pp [+21.1,+44.4] | 12.2% | 74.0% | |
| 4 | **b1-off-mm（第二波基线）** | 77.8% | +32.2pp [+21.1,+43.3] | 12.2% | 79.5% | scm-flash 旧判分 70.0% → 77.8% |
| 5 | w-combo（W1+W2+W3，2 行） | 77.8% | +32.2pp [+21.1,+43.3] | 12.2% | 71.3% | |
| 6 | **allon（全开，4 行）** | 77.8% | +32.2pp [+20.0,+43.3] | 13.3% | 74.9% | **= 基线（Δ 0.0pp，p=1.0）** |
| 7 | w1（W1） | 76.7% | +31.1pp [+20.0,+42.2] | 14.4% | 77.0% | |
| 8 | w2（W2） | 75.6% | +30.0pp [+18.9,+41.1] | 10.0% | 68.6% | |

**配对结论（judge 对齐口径）**：

- **w3b vs b1-off-mm**：判对 +6.7pp（84.4% vs 77.8%），**95%CI[+0.0,+14.4]、McNemar p=0.146 → 不显著**；turnCov 持平（-0.2pp ns），拒答 12.2%→8.9%。**门禁1（缺口桶 5/11）PASS；门禁2 点估计 ≥3pt 但 CI 下界恰 0 → 严格口径未过**（此前 +14.4pp/p=0.0023 是与 scm-flash 判分的基线跨判分器比较，已作废）。
- **allon（全开）vs b1-off-mm**：判对 **Δ=0.0pp**（8 对 8，p=1.0）、turnCov -4.6pp（ns）→ **W1+W2 把 W3 的收益抵消干净**。
- **allon vs w3b**：判对 **-6.7pp（p=0.031，6 对 0）**、cov -4.4pp → 开了 W1/W2 反而显著更差。
- 分桶（judge 对齐不可用逐题，取各档 MiniMax 判分）：w3b 与 allon 的 knowledge-update 都是 93%（该桶 W2 无额外增益）；allon 在 preference（53% vs 67%）、single-session-user（93% vs 100%）、temporal（80% vs 100%）更差。
- **结论**：生产最优 = **只开 W3（smallToBig maxExtraLines=4）**；W1/W2 保持关（已回退 yaml）。W2 的账要在**事实级粒度 + 生产语料**上再算（后续票）。


### 判分器一致性门禁与基线登记表（#140）

§8 的排名能成立，靠的是一次人工的「judge 对齐复核」；人工复核不可持续，所以把这件事做成了工具链的**硬门禁**。

**问题**：报告文件名只带时间戳，`b1-off` 在两种判分器下各存在一份（scm-flash 70.0% / MiniMax 77.8%）。跨 judge 直接配对时，判分器本身的松紧差异会被算进「方法收益」——这正是 10-27 那轮把 +14.4pp/p=0.0023 写进结论、随后被迫作废的原因。

**默认行为**：`bench-gates` 只给一份报告时自动取登记表里的「同 judge 基线」（等价 `--base auto`），不必手写 auto；`bench-baseline check` 报 judge-changed 时门禁直接拒判。判分器换过之后，`bench-baseline stale --judge <model>` 会列出所有「不是这个判分器判的」基线并打印可执行的重判命令（`--commands` 只出命令、便于脚本断言，exit 3）——「判分器变更 → 强制重跑基线」因此是能进脚本的一步，而不是一句口头约定。

**门禁（四个配对工具统一口径）**：`bench-compare` / `bench-gates` / `bench-ranking` / `fit-fusion-weights` 都会读两侧 `config.judgeModel`（+ `judgePromptVersion`），判定与渲染集中在 `scripts/lib/bench/judge.mjs`（契约见 ADR-0012）：

| 情况 | 行为 | 退出码 |
| --- | --- | --- |
| 同 judge（模型 + 判分提示版本一致） | 正常判定 | 0（gates 仍按门禁给 0/1） |
| 跨 judge / 判分器未记录但有判分行 | **拒绝判定**：头部打印两侧判分器 + 配置差异 + 修复路径；判对/拒答 Δ 不出数 | **3** |
| 跨 judge + `--allow-cross-judge` | 放行，但报告内标注「豁免 / 仅参考」，gates 的判对门禁记 SKIP 不计入门禁 | 由其余门禁决定（全过 0 / 有门禁未过 1）——判分器门禁本身不抬退出码 |
| 两侧都无判分行（retrieval-only 档） | 放行（本比较不涉及判分器） | 0 |
| `fit-fusion-weights` 跨 judge | **不配对**：不出 Δ、不给 E2 门禁结论，只并列展示两档 turnCov/sessionCov/mrr | **3** |
| `fit-fusion-weights` 两侧都无判分行 | 放行（E2 是检索门禁，判分器不参与），ΔturnCov 正常算 | 0/1（按 E2 结论） |

> 顺带把「这一对到底只差一个因子吗」也做成输出：`configDiff` 用**黑名单**（`judgeModel`/`judgePromptVersion`/`judgeHost`/`tag`/`manifest`/`dataset`/溯源字段）而不是白名单比对两侧 `config` 的键并集——新增实验旋钮默认会被看见，不会静默输出「无差异」。

拒绝不是终点，**修复路径写在输出里**（这也是为什么不去关掉这些配置开关——要修的是归因，不是把能力关掉）：

```
# 0) 判分器换了：先看哪些基线已过期（exit 3；--commands 只打印命令，可直接喂给 shell）
node scripts/bench-baseline.mjs stale --judge MiniMax-M3.1-Flash
# 1) 取「同 judge 基线」重新配对（登记表解析，不再靠文件名猜）
node scripts/bench-baseline.mjs resolve --judge MiniMax-M3.1-Flash
node --import tsx scripts/bench-gates.mjs auto <trial.json>     # --base auto = 登记表里的同 judge 基线
# 2) 判分器已变更：用旧报告里已存的答案按当前判分器重判（只花 N 次判分调用，不重跑召回/embedding）
node --import tsx scripts/bench-rejudge.mjs <旧报告.json> --register --tag <tag>
```

**基线登记表**（`MemoryCore/.eval-data/bench/lme-baselines.json`，与 `lme-manifest.json` 同级，已入库）：

| 基线 | 判分模型 | 判分提示 | commit | 题数 | 判对 | turnCov@5 | 报告 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **b1off-mm** ⭐（门禁基线） | MiniMax-M3.1-Flash | lme-v2 | d64004e | 90 | 77.8% | 79.5% | `longmemeval-oracle-2026-10-27T05-35-29.json` |
| b0base-mm | MiniMax-M3.1-Flash | lme-v2 | d64004e | 90 | 45.6% | 67.1% | `longmemeval-oracle-2026-10-27T05-45-51.json` |
| b1-off | scm-flash | lme-v2 | 625ccab | 90 | 70.0% | 79.5% | `longmemeval-oracle-2026-10-26T23-42-59.json` |
| b1-off-rejudged-mm | MiniMax-M3.1-Flash | lme-v2 | 625ccab | 90 | **68.9%** | 79.5% | `rejudge-b1off-scms-to-mm.json` |

> 报告 JSON 本身是本机 `.eval-data` 评测产物（不入库）；登记表记录它们的 judge 身份、commit 与路径，`bench-baseline.mjs check <报告>` 会告警「判分器已变更，需重跑基线」，`bench-baseline.mjs stale --judge <model>` 给出受影响清单与可执行重判命令。

**重判实测（把 70.0% 拆开）**：拿 b1-off 的**同一批答案**（90 题、82 行有答案、8 行空答案跳过）按 MiniMax 重判 → **68.9%**，比 scm-flash 的 70.0% 低 **1.1pp**。也就是说：

- 「70.0%（scm-flash）→ 77.8%（MiniMax）」这 **+7.8pp 主要是答案侧差异**（两档 commit 不同：625ccab vs d64004e），不是判分器变松；
- 判分器切换本身在这批答案上只有 **-1.1pp**，但方向与幅度**必须实测**、不能假设为 0——所以门禁照旧保留，`bench-rejudge.mjs` 负责把「判分器贡献」与「答案贡献」分开。

**回归保护**：`__tests__/bench-judge.test.ts`（31 例：身份/配对/拒绝/豁免/登记表/重判语义）+ `__tests__/bench-judge-cli.test.ts`（7 例：compare/gates/ranking/fit-fusion-weights 的 exit 3、`--allow-cross-judge`、`gates --base auto`、`--base auto` 遇 judge-changed 拒判、ranking 的「判分模型」列取 judgeModel 而非 answerModel）。

### 逐项结论

- **W3（唯一通过答案侧门禁）**：判对 77.8%（judge 对齐基线）→**84.4%（+6.7pp，CI[+0.0,+14.4]，p=0.146，不显著）**、拒答 12.2%→8.9%、cov 持平（79.3%，-0.2pp ns）、缺口桶 5/11（门禁1 PASS；门禁2 严格口径未过）。回捞 2 行档（w3）为 81.1%。**注**：此前 +14.4pp/p=0.0023 是与 scm-flash 判分的旧基线跨判分器比较，已作废（见上一小节）。机制：结论卡（3.56 卡/组 × 90 = 320 卡、769 条 part_of 边）经既有 R7-1 结论层（FTS 词面命中）入候选，`smallToBig`（#78 R-b）单跳回捞源证据行作「上下文行」注入；预算未破（结论行硬上限 floor(maxResults/2)、maxExtraLines=2，注入总行数 ≤ maxResults）。turnCov@5 -3.3pp（ns）：single-session-assistant/preference 桶 -13.3/-12.2pp（结论卡占注入位、gold-turn 覆盖被稀释），但 knowledge-update 桶 **+8.3pp**（结论卡把同一实体的多次更新聚合到一行，正是该桶需要的粒度）。**缺口桶 4/11，差 1 题**。
- **W1**：判对 +6.7pp（CI 含负，不显著）；turnCov -2.5pp（ns）；multi-session +6.0pp / knowledge-update -8.3pp（事实短语把同事实不同时点的行拉近，稀释时间/版本信号）。按票面规则（Δ<3pt 或 CI 含负值即回滚）**默认关**（`--fact-dual-write` 保留能力）。
- **W2**：机制正确（140 条 valid_end **只标记不删除**、主表+l1_fts 双写同步、读侧既有 `isOutsideValidityWindow(validityNow)` 生效），但 **turnCov -10.9pp 显著负**（knowledge-update 桶尤甚）；判对 +5.6pp（ns）。**与票面预期一致**：LME90 的 gold 证据常包含被取代的旧值 turn，"只留新值"直接丢 gold。→ 默认关（`--write-supersede` + `--b2b-validity`），收益需生产语料（带失效语义）验证。
- **叠加性**：不叠加。w13 +8.9pp、combo +7.8pp，均低于 w3 单开 +11.1pp——W1/W3 答案收益重叠（都靠补充上下文），W2 的 cov 伤害进一步拖累。**本波推荐 = b1-off + W3**（仅限 B1 波内口径；读侧四件套的生产默认已由 #145 固化，现行推荐看 §2）。

### 实现与 seam（零 schema 变更）

- 写入面只用既有 3 个 API：`store.upsertL1(record, vector)`、`store.invalidateL1(id, validEndIso)`（W2 只标记）、`store.addLink(src, dst, "part_of", 1)`（W3 证据链）；读侧零改动（W2 复用 `isOutsideValidityWindow`，W3 复用 R7-1 结论层 + #78 smallToBig）。
- 双时态两端都在：L1 行写 `valid_start`（=该轮发生时刻）、supersession 写 `valid_end`；重嵌向量时**保留**既有 valid_*（避免复活已失效行）。
- **本波仅 bench 验证**（与 B1 同款先例）：三个新模块只被 bench harness 消费；生产接入（l1-writer/v2-router 写链 hook）= 另开票，需带默认关 + 门禁闸。生产侧的即时可行动作见 §7 的 W3 配置项。
- **偏差记录**：① W2 失效粒度 = L1 整行（票面写「事实带 valid_from/valid_to」）——一行多事实时整行失效，粒度粗于票面；LME90 上表现为显著丢 gold，粒度细化（事实级行）留待生产语料验证时一并评估；② W3 的 `--conclusion-cards` 同时开写入面与读侧回捞，本波未拆两个独立开关（拆分留作后续）；③ **w3b 是看到 w3 的 cov 下探后按假设调参**（maxExtraLines 2→4，靶向 gold-turn 覆盖）——同题集上调参，非预注册，绝对增益应打折扣解读；w3（2 行）与 w3b（4 行）两档证据都保留；④ 抽取预算门禁在缓存命中档无 token 证据 → 显式 SKIP（不假绿），首次抽取档的 token 计量见 `factExtraction.stats`。
- 新增 bench 工具链：`scripts/lib/bench/facts.mjs`（抽取+缓存+429 长退避）、`conclusions.mjs`（结论卡蒸馏+缓存）、`fact-extract-gate.mjs`（抽样验收门禁）、`bench-gates.mjs`（票面门禁汇总：缺口桶/判对 CI/预算/抽取验收；无证据时显式 SKIP 不假绿）、`run-w134-arms.sh`（逐档可复现，先跑抽取门禁、失败即非 0）；`--facts-only` 离线抽取、`--store` 分阶段写入、`--embed-cache` query 向量缓存。

## 9. 组合失效的第一性原理分析（2026-10-27）

> 触发问题：全开（W1+W2+W3, allon）判对 77.8% = 基线 b1-off（77.8%），比只开 W3（w3b 84.4%）**显著更差（-6.7pp，p=0.031，6 对 0）**。为什么三个"各自方向为正"的机制叠加反而归零？

### 9.1 逐题证据：6 题回归、0 题翻盘

w3b（对）→ allon（错）的 6 题：2 题 single-session-preference、1 题 single-session-user、3 题 temporal-reasoning（其中 2 题证据被删到 cov 0/0.5 后**拒答**）；反向翻盘 **0 题**。即 W1+W2 在 w3b 之上只产生损失、没有产生任何新收益。

### 9.2 根因一：W2 的失效判定违反「函数依赖」前提（语义错误）

supersession 把（subject, predicate）当作**函数依赖键**（一个属性同时只有一个值），但抽取器给的 predicate 是**泛化谓词**，不保证互斥。实测被误失效的行：

| 题 | 被失效的（subject / predicate） | 旧值 → 新值 | 实际语义 |
|---|---|---|---|
| gpt4_e072b769（temporal） | User / **is considering** | "trying a new grocery delivery service" → "trying Thrive Market" | 两个**并存的考虑项**，非版本更新 |
| gpt4_93f6379c（temporal，"先加入哪个群"） | User / **wants to create** | "a private Facebook community" → "a content calendar" | 两个**不同目标**，非互斥 |
| gpt4_93f6379c | the user / **has a book club member** | "who is publishing her debut novel" → "…soon" | 同一事实的**措辞差异**（值不该参与比较） |
| gpt4_f49edff3（temporal，事件排序） | I / **am considering** | "a personalized baby blanket" → "a baby gym or playmat" | 并存的候选礼物 |

后果：temporal-reasoning（"哪个先发生"）恰恰需要**旧事件仍在池里**；整行失效把它们删掉 → cov 0/0.5 → 模型拒答。**这不是粒度问题（事实级只缩小破坏面），而是"该不该失效"的判定问题**：必须先有 cardinality（单值属性）契约。

### 9.3 根因二：三个机制作用在同一阶段 → 抢同一个 5 行预算

实测每题的**有效证据行**（进入 answer 的 hits）：b1-off 平均 3.53 行、w3b 4.48 行；w3b 的 evidence 组成 = 3 行 turn + 2 行结论（样本 4b24c848）。结论与 turn 是**同一知识的两种表示（摘要 vs 原文）**，不是互补信息——注入结论就必然挤掉 turn，池子固定 5 行时是**零和替换**。w3b 的 +6.7pp 来自"摘要对聚合/更新题够用"，其 cov 下探（-3.3pp）来自"摘要挤掉了需要原文的题"。
W1 再改 embedding 键 → 改变**哪些 turn 参与竞争**（knowledge-update/temporal cov -8.3/-6.7pp）；W2 再删行 → 直接缩小候选池（cov -4.6pp）。三者都在"选哪些行进池"这一层竞争，代价叠加、收益互相覆盖。

### 9.4 根因三：回捞（backfill）几乎没工作

w3b 的 [上下文] 证据行只出现在 **9/90 题**（平均 0.10 行/题）。即"结论 + 其源证据"的配对机制基本没触发（需要结论被选中 + part_of 边 + 未被 seen），所以 W3 实际只贡献了"摘要替换原文"，没贡献"摘要 + 证据"的双份信息。想让 W3 与 W1/W2 互补，先得让回捞变成**结论的强制伴随单元**。

### 9.5 结论：需要调整算法（四个组合层改动）

**原则：让三个机制各占一个阶段，而不是都在"选行"阶段竞争。**

1. **W1 → 召回通道（不是键替换）**：保留原文 embedding 主索引与排序；新增"事实键"作为**并行召回通道**，两路候选 RRF 融合后由原信号裁决排序。收益（multi-session 召回 +6pp）保留，时间/版本排序不再被稀释。
2. **W2 → 软失效 + 属性契约**：抽取/去重输出 cardinality（单值 vs 多值）或 mutually_exclusive 标记；**只有单值属性**允许 supersession；多值一律 additive、永不失效。失效从"硬过滤"改为"validity 特征降权"（fused score），仅当问题显式问"现在/最新"且存在更新的有效行时才硬过滤。
3. **W3 → 表示选择 + 强制回捞**：结论与 turn 不是并列候选，而是**复合单元**（摘要 + 其 top-1 源证据），按问题类型分配预算（exact-fact 题结论=0、聚合/更新题结论=1-2、preference 题结论≤1）；回捞从"可选"改为"选定结论即必带 1 条源证据"。
4. **查询路由**：按意图分桶——精确事实（买/哪一次/时间顺序）走 turn 优先；聚合/比较/更新走结论优先；偏好/推荐走 preference 行 + 少量 turn。路由是让 1+1>2 的主开关，而不是把所有机制全开。

### 9.6 怎么验证（1+1>2 的判定方式）

- **因子设计**：W1(通道/键) × W2(软/硬/关) × W3(结论数/回捞数) 至少跑 8 格而不是单档叠加；每格同 judge 配对（#140）。
- **新增指标**：① 证据充分性（注入集是否含 gold 答案跨度，LLM 判定"可答性"而非直接作答）；② 结论/turn 归因（答案实际引用了哪类行）；③ 分题型门禁（temporal 不得低于基线）。
- **判定线**：组合档相对单档最好成绩的 Δ 需 CI 下界 > 0（否则"1+1>2"不成立，维持单档最优）。

### 9.7 现状处置

- 生产配置维持**只开 W3（maxExtraLines=4）**；W1/W2 保持关（yaml 已回退）。
- 待办：事实级粒度与 cardinality 契约（#136）、多事实键与双通道（#137）、组合设计与路由（#141）、判分一致性（#140）。

## 10. 检索融合与闭环（issue #135：R1–R4 + E1–E3，2026-10-27 下午场）

> 本节全部为 n=90 同题配对，judge=answer=MiniMax-M3.1-Flash（生产 config-override 的 llm 配置），口径 lme-v2。跑档脚本 `MemoryCore/scripts/run-r135-*-arms.sh`，结果落 `MemoryCore/.eval-data/bench/longmemeval-oracle-*.json`。

### 10.1 代码侧交付（bench/recall-opt，逐项独立 commit）

| 子项 | commit | 内容 |
|---|---|---|
| R1 | `1c1130e` | `recall.candidateK` 配置化——候选池上游上限解锁；缺省 = `maxResults*3` 逐位现状 |
| R2 | `68fa360` | `recall.fusion` 加权融合（dense/BM25/recency/validity 显式特征）；缺省 `mode:"rrf"` 恒等，逐位不变 |
| R3 | `085a722` | `recall.presentTemporal` 查询时间感知（now/currently/最新…）；缺省关断 |
| R4 | `1a426c9` | `rerank.mode="filter"` floor 只滤不清排、保原序；缺省 `rerank` |
| E1/E2 | `6c87550` | `scripts/fit-fusion-weights.mjs` 配对汇总 + E2 门禁（Δ≥+3pp 且 CI 下界>0） |
| bench 旋钮 | `74b8de1` + 本节 | `--fusion/--candidate-k/--present-temporal/--rerank-mode`，全部只写沙箱 yaml 与沙箱 override json |

### 10.2 评测结论表（rerank 开/关 × 剪枝深度）

| 档 | rerank | candidates | minScore | 其它 | turnCov@5 | MRR | 判对 | 拒答 |
|---|---|---|---|---|---|---|---|---|
| b0base-mm | 开 | 12 | −2 | 无 #135 开关 | 67.1% | 0.702 | 45.6% | 40.0% |
| allon-on-rerank | 开 | 12 | −2 | cK32+fusion+presentTemporal+B1 | 78.0% | 0.777 | 73.3% | 18.9% |
| **deep4** | 开 | 32 | −4 | 同上 | 80.9% | 0.806 | 80.0% | 13.3% |
| **filter7deep** | 开（filter 模式） | 32 | −7 | 同上（保原序） | 79.3% | 0.731 | 75.6% | 15.6% |
| **deep105** | 开 | 32 | −10.5 | 同上 | **84.3%** | **0.813** | **82.2%** | **10.0%** |
| b1off-mm | 关 | — | — | 无 #135 开关 | 79.5% | 0.712 | 77.8% | 12.2% |
| allon（rerank 关） | 关 | — | — | cK32+fusion+presentTemporal+B1 | 79.9% | 0.735 | 72.2% | 17.8% |

配对统计（`fit-fusion-weights.mjs`）：

- **deep105 vs b0base：ΔturnCov@5 = +16.67pp，CI95[+9.05,+24.29]，30W/8L/52T，p=0.0005 —— E2 门禁 PASS**。
- deep105 vs b1off（rerank 关）：+4.63pp，CI95 下界 −2.9pp，14W/11L/65T，p=0.69 —— FAIL（n=90 不够，非负向）。
- deep105 vs filter7deep：+4.81pp（10W/13L/67T）—— 重排优于保原序。
- filter7deep vs b1off：−0.19pp（6W/4L/80T）—— 深池 + 保原序 ≈ 关掉 rerank。
- allon（rerank 关） vs b1off：+0.37pp（5W/3L/82T）—— #135 三个开关在无精排基线上是中性，之前 +10.6pp 主要是在补剪枝的洞。
- r2-wdef（weighted 融合，rerank 开基线上） vs b0base：Δ=0.00pp，1W/1L/88T —— 见 10.4。

### 10.3 根因：精排的伤害来自「剪枝」，不是「重排」

按 b0base 的 `gates.rerank.kept`（剪枝后保留行数）分组，看「关掉 rerank 后的 ΔturnCov@5」：

| kept | 题数 | 关掉 rerank 后 Δ |
|---|---|---|
| 1 | 27（30%） | **+35.2pp** |
| 2 | 16 | +6.3pp |
| 3 | 9 | +9.3pp |
| ≥4 | 38 | −1.3pp（中性） |

即：rerank 只在保留 ≥4 行的题上中性，而在保留 1 行的 27 题（30%）把证据剪到只剩一条，B1 的时间序证据块与拒答出口同时失效。deep105 把 kept≥4 的题从 38/90 提到 80/90，分题型 knowledge-update 0.750→**0.929**、multi-session 0.657→**0.764**、temporal-reasoning 0.778→0.800，single-session 类持平（preference −1.1pp）。

**注意交互性**：§1 的 T3（minScore −10.5 + pool32，但无 B1、无 #135 开关）当时 Δ=0——松 floor **单独不产生收益**，它只是把 B1 需要的证据还回来；收益来自「不剪 + 读侧四件套 + 深池」的组合。

> **归因补正（2026-10-29，§18.3/§18.7）**：本节「伤害来自剪枝」的结论只对了一半——kept 数只说明精排留了几条，装配层 foldNearDuplicates 还会按「同会话主题相似」把多轮证据折成 1 行（旧口径 90 题折叠 154 行、108 条金句里只有 62 条进得了注入块）。本节表格的 cov/judge/refuse 口径与数字仍成立，但「关掉 rerank 就变好」的那部分，至少有相当比例是**装配折叠**被绕过，而不是剪枝本身。折叠判据已由 **#162** 重写（§18.7），本节不再据此推荐「关精排」。

### 10.4 R2/R3 的定位：它们只在「平局组」里起作用

R2 加权融合缺省恒等；weighted 档（dense .4/bm25 .3/recency .2/validity .1）在 LME90 上 Δ=0（1W/1L/88T），R3 presentTemporal 在 rerank-off 基线上 +0.37pp（n.s.）。机制解释：`compareLex` 主序是 rrfScore 降序**严格优先**，recency/validity/presentTemporal 都是加性小量——只有 rrfScore 精确平局才会改变名次，而 LME90 上几乎不出现精确平局。V1 早先「ageDecay 在 rank-based RRF 路 0/90 无差异」同一机制。

**结论**：R2/R3 保留为「能力 + 缺省关断」，不主张收益；要让时间信号真正生效，得让它在**通道内打分**（向量/BM25 分数量纲）而不是合并后加性并入——见后续票。

### 10.5 R4 的结论：filter 模式可用，但不是最优解

`rerank.mode="filter"` 在 src 侧生效已实证（filter7deep 的 90/90 行 `gates.rerank.mode="filter"`）。但同池深下保原序（79.3%）低于重排（deep4 80.9% / deep105 84.3%）——**重排本身有正收益**（knowledge-update 78.6% vs 92.9%），filter 模式的价值是「安全降级档」，不应做生产默认。生产默认应由 #145 校准（candidates 12→32、minScore −2→−10.5 logit 刻度，非 logit provider 需按标度换算）。

### 10.6 复现

```bash
cd MemoryCore
bash scripts/run-r135-rerankfix-arms.sh deep105     # 84.3%
bash scripts/run-r135-rerankfix-arms.sh filter7deep # 79.3%（R4 filter 模式）
bash scripts/run-r135-rerankfix-arms.sh deep4       # 80.9%
bash scripts/run-r135-off-arms.sh allon             # 79.9%（rerank 关）
node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json \
  --arm deep105=.eval-data/bench/longmemeval-oracle-2026-10-27T08-36-53.json
# 全矩阵排名/诊断/采样计划用 fit（见 §17）：
# node scripts/fit-fusion-weights.mjs fit --base ... --arm-dir .eval-data/bench
```

## 11. 双时态属性契约与软失效（issue #136，2026-10-27 晚场）

> **问题**：#134 的 W2 把「同（subject, predicate）新值 ≠ 旧值」当版本更新，整行写 `valid_end`。LME90 实测 cov −10.9pp、temporal-reasoning 拒答；复查（§9）定位两类根因：①属性不满足函数依赖（泛化谓词的值不互斥）；②失效 = 硬删除，旧事件永久退出候选池。
> **本票改动**：写侧 cardinality 契约（只有单值属性允许失效；多值 additive）+ 读侧软失效（expired 降权保留，仅「问当下 + 内容相关的更新行」才硬丢）。设计取舍见 ADR-0010。

### 11.1 代码侧交付

| 子项 | 落点 | 缺省 |
|---|---|---|
| 属性契约 | `src/core/record/cardinality.ts`：`classifyCardinality`（显式 > 单值词表 > 多值词表 > 值结构线索 > 缺省 single）、`classifyContentCardinality`（内容级，英文 cue 卡词边界） | 生效 |
| 写面门控 | `write-policy.ts` `supersessionEligibleForContent`；`l1-writer.ts` dedup update/merge 与 `l1-extractor.ts` conflict 分支在 invalidate 前判定；多值 → 不失效、不归档、保留 target_ids 建记忆图边 | `memory.write.supersession.cardinalityGate=true`（supersession 本身仍缺省关）；`false`=回滚到 #136 前 |
| 读面软失效 | `src/core/recall/validity-policy.ts`：`selectByValidity`（future 恒丢；expired 降权保留；presentIntent + 内容相关更新行才硬丢）、`excludeInvalidatedFor`（单一映射点）、`SOFT_VALIDITY_PENALTY=0.5` | `recall.validity.mode="hard"`（逐位现状）；soft 显式开启 |
| 三路读口径 | 钩子路 `searchHybrid`：expired 的 rrfScore × 0.5 后再进组合精排（不块状重排）；结论层两处（`shouldHardDropValidity`）与工具路 `filterByValidity("soft")`：只丢 future、保留 expired（无法重排的通道不硬丢） | 同上 |
| 测试 | `cardinality.test.ts`（10）、`supersession-cardinality.test.ts`（验收①+内容门控）、`validity-policy.test.ts`（7）、`auto-recall-soft-validity.test.ts`（5，钩子路接线）、`l1-writer.write-policy.test.ts`（+3 写面端到端：多值不失效/单值仍失效/回滚阀门）、`filter-invalidated.test.ts`（+2 工具路 soft） | 全量 vitest 261 文件 / 2362 例通过 |

### 11.2 LME90 配对（同 manifest `lme-manifest.json`、同 judge `MiniMax-M3.1-Flash`、rerank-off + B1）

| 档 | 写面 | 失效数 | 读面 | turnCov@5 | 判对 | 拒答 | knowledge-update cov / 判对 | temporal cov / 判对 |
|---|---|---|---|---|---|---|---|---|
| b1off-mm（基线） | 无 | 0 | 硬 | 79.5% | 77.8% | 12.2% | 75.0% / 86.7% | 77.8% / 86.7% |
| w2（#134 旧实现） | W2 无契约门 | 140 | 硬 | 68.6% | 75.6% | 10.0% | 57.1% / 80.0% | 64.4% / 86.7% |
| **card-soft（#136）** | W2 + 契约门 | **0** | **软** | **80.1%** | **78.9%** | 11.1% | **78.6% / 86.7%** | **77.8% / 86.7%** |
| nogate-soft（消融：关契约门） | W2 | 140 | 软 | 75.3% | 未取得¹ | — | 57.1% | 77.8% |

¹ **nogate-soft 的判对未取得**：该档生成阶段遭遇 MiniMax 429（90/90 题无答案）。**card-soft 已在配额恢复后重跑**（2026-10-27 20:04，90/90 判分、0 null，tag `r136-cardsoft3`）；检索侧与初测一致。

**检索侧配对结论（`scripts/bench-bucket-paired.mjs`）**：

- **card-soft vs b1off-mm**：turnCov@5 +0.6pp（CI[+0.0,+1.7]）、判对 +1.1pp（78.9% vs 77.8%，McNemar 2/1，ns）；knowledge-update cov **+3.3pp**（CI[+0.0,+10.0]）、判对 **±0.0pp**（86.7% vs 86.7%）；temporal cov/判对 **±0.0pp**。初测（配额前）逐题 cov 0 差异、仅 3 题 top-5 内部同分序不同；重跑的小幅正差在 n=90 噪声内（embedding/精排并发序），结论不变：契约门把 140 条失效判为「不该失效」后，检索面与基线等价。
- **nogate-soft vs w2（同 140 失效、只差读面）**：overall cov −10.6pp → **−4.1pp**（少损 6.5pp）；temporal-reasoning −13.3pp → **0.0pp**（完全恢复）；knowledge-update −16.7pp → −16.7pp（未恢复：该桶 gold 常是被取代的旧值 turn，0.5 降权仍把它挤出 top-5）。→ 软失效解决「别删」，但 knowledge-update 的账必须由契约（别判错）来结，与 §9.5 的判断一致。
- **契约门不是「关开关」**：LME90 上 140 条失效全部落在泛化谓词（`is considering` / `plans to try` / `likes` / `has` / `feels`…），契约判定它们不是函数依赖，所以 0 条应当失效；生产真实语料 815 条更新链里 **696 条仍判 single 会失效**、119 条 additive（14.6%），见 §11.3。

### 11.3 生产语料知识更新链路走查（只读）

`node --import tsx scripts/audit/r136-corpus-walkthrough.mjs`（读 `D:/TDB/data/records`，零写入零外呼）：

- 14 个日分片 / **8353 行** L1 records；带 `metadata.subject` 的实体簇 **5016**，其中内容发生过变化 **815 簇**；
- 写侧契约模拟：815 条真实更新链中 **696 条判 single（允许标记旧值失效）**、**119 条 multi（additive，不失效）**——契约在生产语料上并非全域关停；
- 旧值可追溯：全库 8353 行原样保留（JSONL append-only），带 `valid_end` 的行 0 行（生产的 supersession/conflict 失效未开启）；开启后也只在 store 层写 `valid_end`，不删 JSONL 行；
- 典型链（样例）：`销售费用分摊前端` 两版（2026-10-27 05:52 → 06:15）判 single → 旧版标记失效但保留；`云文库测试失败归因` 两版判 multi（含「计划」）→ additive，两版并存。

### 11.4 门禁判定（票面验收）

| 门禁 | 判定 | 证据 |
|---|---|---|
| ① 一行两事实、只取代其一 → 另一事实仍可召回 | **PASS（单测）** | `supersession-cardinality.test.ts`：写侧多值不产 op / soft 保留行 / hard 对照删行；写面端到端 `l1-writer.write-policy.test.ts` 锁定「多值不失效、单值仍失效、门关回滚」 |
| ② knowledge-update 桶 cov 不低于 b1-off | **PASS** | card-soft cov 78.6%（b1off 75.0%）；逐题配对 +3.3pp，CI[+0.0,+10.0] |
| ② knowledge-update 判对不低于 b1-off | **PASS** | 86.7% = b1off 86.7%（±0.0pp，McNemar 0/0） |
| ② temporal-reasoning 桶 cov/判对不低于 b1-off | **PASS** | cov 77.8% = b1off；判对 86.7% = b1off（均 ±0.0pp）；消融档 nogate-soft 另证 cov 从 −13.3pp 回到 0.0pp |
| ③ 生产语料「知识更新」链路走查 | **PASS** | §11.3：815 链、696/119 判定分布、零删除 |

### 11.5 复现

```bash
cd MemoryCore
# 配对档（每档从 b1-off 基线库复制，只补写本档差异）
bash scripts/run-r136-arms.sh card-soft    # W2 + 契约门 + 软失效
bash scripts/run-r136-arms.sh nogate-soft  # 消融：关契约门 + 软失效
# 分桶配对 + 门禁（cov/判对 ≥ 基线）
node --import tsx scripts/bench-bucket-paired.mjs \
  --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-35-29.json \
  --arm card-soft=.eval-data/bench/<card-soft>.json \
  --gate knowledge-update,temporal-reasoning
# 生产语料走查（只读）
node --import tsx scripts/audit/r136-corpus-walkthrough.mjs
```

### 11.6 偏差与遗留

- **事实级粒度未实施**（票面次优先项）：失效仍落整行，soft + 契约已把误伤从「永久丢失」降为「排序下沉」；后续票 #146（一条事实一行 + 抽取器直出 cardinality）。
- **判对证据**：card-soft 已于 2026-10-27 20:04 配额恢复后重跑补齐（§11.2）；nogate-soft 的判对仍缺（429 时的消融档，检索侧结论已足）。
- 生产 yaml（gitignored）与 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 已加 `cardinalityGate/cardinalityDefault/validity.mode` 注释与缺省值（均缺省关/硬）。
- 软失效的硬丢判据是「查询意图 + 内容 token 重叠 + 更新时间」，非实体级同键（行级无 subject 持久化）；事实级落地后应由 metadata.(subject,predicate) 精确判定。


### 11.7 全开档复测（#136 配置全开，2026-10-27 晚；判分被配额阻塞）

> 触发：用户重启后要求「配置项都打开，重跑评分，对比初始与排名」。
> 配置（本机 `tdai-gateway.yaml`，改后需重启网关）：`memory.write.factKey.enabled=true`、`memory.write.supersession.enabled=true`（cardinalityGate=true / cardinalityDefault=single）、`recall.validity.mode=soft`；W3 `smallToBig` 原本已开（maxExtraLines=4）。rerank 维持生产现值（candidates 12 / minScore −2，属 #145 范围，本波不动）。
> **判分**：初测时 MiniMax 402（Token Plan 上限）只能跑检索侧；2026-10-27 20:04–20:26 配额恢复后按 #147 用 **MiniMax-M3.1-Flash** 补跑 new A / new B / card-soft（各 90/90 判分、0 null，同 manifest / rerank-off + B1）。

| 档 | 组成 | turnCov@5 | sessionCov | MRR | nDCG | 判对 |
|---|---|---|---|---|---|---|
| b1off-mm | 基线 | 79.5% | 92.7% | 0.712 | 0.723 | 77.8% |
| old allon | W1+W2旧（140 失效）+W3×2 | 74.9% | 91.9% | 0.666 | 0.745 | 77.8% |
| w3b | W3×4 | 79.3% | 92.9% | 0.691 | 0.792 | **84.4%** |
| **new A** | W1+W2契约（0 失效）+W3×4+soft | **78.8%** | **94.0%** | 0.681 | 0.786 | **82.2%** |
| **new B** | W2契约（0 失效）+W3×4+soft | **79.3%** | 92.9% | 0.691 | 0.792 | **84.4%** |
| card-soft（#136 单档） | W2契约+soft（无 W1/W3） | 80.1% | 93.2% | 0.718 | 0.729 | 78.9% |

- **A vs old allon**：turnCov **+3.9pp**（74.9→78.8）、sessionCov +2.1pp（91.9→94.0）——契约门去掉 W2 的 140 条误失效后，全开档从「比基线差 4.6pp」回到「差 0.7pp（ns，CI[−8.0,+6.5]）」。
- **B ≡ w3b（判分实测确认）**：五项指标逐位相同（cov 79.3 / session 92.9 / MRR 0.691 / nDCG 0.792 / 判对 **84.4%**）——W2 在 LME90 上 0 失效、soft 在无失效行时恒等，故 B 的判分输入与 w3b 完全一致。
- **A vs B（唯一差别 = W1 事实键）**：判对 82.2% vs 84.4%（**−2.2pp**，McNemar 2/0，ns）、cov 78.8% vs 79.3%（−0.6pp，CI[−2.8,+3.9]）；A 的 sessionCov 更高（94.0 vs 92.9），但判对与 cov 都不占优 → **W1 在当前单短语事实键形态下没有净收益**（与 w1 单档 +6.7pp ns 的历史结论一致）。
- **card-soft vs b1off**：判对 **78.9% vs 77.8%**（+1.1pp，ns）、cov 80.1% vs 79.5%；knowledge-update 判对 **86.7% = 基线**、temporal **86.7% = 基线** → #136 两项门禁 PASS。
- 分桶（new A vs b1off，逐题配对）：knowledge-update cov **+14.4pp**（70.0→84.4，CI[−5.6,+34.4]）、multi-session +7.8pp；single-session-assistant −13.3pp（结论卡挤占原文行，W3 已知副作用）、preference −6.7pp、temporal −3.3pp（均 ns）。
- **排名（判对，MiniMax-M3.1-Flash 同 judge；rerank-off 组）**：
  **B 84.4% = w3b 84.4%** > deep105 82.2%（rerank on，不同组）≈ **A 82.2%** > w3 81.1% > w13 78.9% ≈ card-soft 78.9% > b1off 77.8% ≈ old allon 77.8% > w1 76.7% > w2 75.6% > b0base 45.6%。
  **初始（b0base 45.6%）→ 全开（A 82.2%）+36.6pp；→ B（84.4%）+38.8pp**；old allon（W2 旧硬失效）77.8% → new A 82.2%（+4.4pp，契约门把 W2 的伤害消掉）。
- **分桶代价（A/B 一致）**：single-session-assistant cov/判对均 −13.3pp（结论卡挤占原文行，W3 已知副作用；B 桶 cov 80.0→66.7、判对 93.3→80.0）；preference cov −6.7~−10pp；换回 knowledge-update **+14.4pp cov / +6.7pp 判对**、multi-session **+7.8pp cov / +26.7pp 判对**、temporal **+3.3pp cov / +13.3pp 判对**（B 桶 temporal 判对 100%）。

**结论（全开会后重排）**：
1. **配置全开后不再拖累基线**：A 判对 82.2%（+4.4pp vs b1off，ns）、B 84.4%（与 w3b 持平）；W2 的旧伤害已被契约门 + 软失效消除。
2. **W1 在“键替换”形态下是净负项**：A vs B 唯一差别是 W1，判对 −2.2pp、cov −0.6pp（均 ns，但方向一致）——生产最优仍是 **W3×4 + W2(契约) + soft（= B）**；W1 的出路是 #137 的「并行召回通道 + 多事实键」，不是继续替换 embedding 键。
3. **#136 判对门禁 PASS**：card-soft knowledge-update/temporal 判对均与基线持平（86.7%），cov 不低于基线。
4. rerank 档位仍归 #145（deep105 的 82.2% 是 rerank-on 组，与本节不可直接合并排名）。

## 12. 事实键平行召回通道 + 多事实键（issue #137，2026-10-27）

> **问题（根因）**：① 生产 W1 的事实来源只有 dedup 顺带抽取的**单短语** `metadata.subject`，事实覆盖远弱于 bench 的 facts[]（bench 也只 +6.7pp ns）；② W1 以「替换 embedding 键」实现——事实短语把「同主题」的行拉近，稀释「同实体不同时间」的判别信号（knowledge-update −8.3pp / temporal −6.7pp），与 W3 组合时是纯噪声（§11.7 A vs B：判对 −2.2pp）。
> **本票改法**：不是关开关，而是换形态——**原文主索引逐位不动，事实键单独成一条向量、作为平行召回通道**；事实来源从单短语扩到 2-5 条多事实；融合从「加性小量」迁到**通道内归一化分**（§10 已证加性小量改不了主序）。

### 12.1 代码侧交付

| 子项 | 落点 | 缺省 |
|---|---|---|
| 多事实归一化 | `src/core/record/fact-key.ts`：`normalizeFacts / normalizeFactPhrases / normalizeFactTriples / factKeyPhrases`（折叠空白 → 长度边界（整条丢弃，不切断）→ 大小写/尾随标点不敏感去重 → 条数上限；脏形状安静丢弃） | 生效（纯函数） |
| 事实通道键 | 同文件 `buildFactChannelKey`：**只含事实短语**（不含原文），支持已有归一形状 `{phrases,triples}`、`maxFacts / maxFactChars / includeTriples`；无事实/预算 0 → `""`（调用方零外呼） | 生效（纯函数） |
| 写侧策略 | `write-policy.ts`：`writeFactsOf / writeFactSetOf`（`metadata.facts` ∪ `metadata.factTriples` ∪ `metadata.subject` 回退）、`factChannelKeyFor(record, memory, policy)`；`embeddingKeyFor` 在 `mode="channel"` 时**逐位返回原文** | `memory.write.factKey.enabled=false`；`mode="replace"`（不静默改语义） |
| 写侧落库 | `l1-writer.ts`：主写入成功后 feature-detect `store.upsertL1FactVector`，事实键单独 embed → 写 `l1_fact_vec`；失败只 warn（记录照常写入） | — |
| store 通道 | `store/sqlite.ts` + `store/types.ts`：`l1_fact_vec` vec0 表（同维同余弦，`IF NOT EXISTS` 老库自愈）；`upsertL1FactVector / searchL1FactVector`（可选方法，镜像 `searchL1Vector` 的容错）；archive/delete/expired/clear/reindex 六条删除路径同步清理 | tcvdb 不实现 → 通道静默退出 |
| 召回通道（钩子路） | `hooks/auto-recall.ts`：同一 query 向量并行打两路；事实候选过余弦下限 + `onlyForTypes` + 同 id 去重；新池行带 `·[fact]` 标注与 `factMs/factHits` 计时 | `recall.factChannel.enabled=false` |
| 召回通道（工具路） | `tools/memory-search.ts`：`executeMemorySearch` 三路加权 RRF（`rrfMergeWeighted`，fact 通道权重同 `factChannelWeightOf`）；`tdai-core.searchMemories` 透传 `cfg.recall.factChannel`。工具路只做通道级融合（`fusion.mode="normalized"` 仍只在钩子路） | 同上 |
| 融合 | `recall/fusion.ts`：`FusionWeights.fact`、`factChannelWeightOf`、`normalizedFusionEnabled`、`cosineNormOf`、`minMaxNormOf`、`normalizedRelevanceOf`；`recall.fusion.mode="normalized"`（通道内归一化分作主序，rrfScore 退回去重/平局兜底；图扩散派生分同量纲、软失效降权同刻度） | `fusion.mode="rrf"`（逐位现状） |

### 13.5 rerank 伤害的根因修复（#137-F，2026-10-28）

> 用户要求：不要靠关开关，rerank 本身有价值，是「使用或算法问题」导致错误率高，要修根因。

**三层根因（均用 LME90 数据定位）**

1. **主序被整体替换**：`applyRecallRerank` 用 provider 原始分（local 为 logit）全量重排，丢弃了已验证的融合主序（normalized 通道融合 + 事实通道 + work_fact 分层 + 组合精排）。实测同一全开配置下：纯 rerank 判对 77.8%、关掉 86.7%。
2. **窗口被 floor 饿死**：W3 结论层把经验层预算压到 1~2 行（`experienceLimit = maxResults − 结论行`），而 `minScore` 又会把**融合 top-1 在内的候选**筛掉——rerank-on 平均经验行 **1.73** < rerank-off **2.33**。单条证据由 cross-encoder 单方面决定，错一次就零覆盖。
3. **混合基准选错**：曾尝试用「原始 scores 数值归一化」做混合，但 `lines` 顺序已被组合精排/work_fact 分层改变，`scores[0]` 并不是池内 max（实测 rel0 仅 0.0468）→ α 越大反而越偏离融合序（α=0.9 cov 76.1% < α=0.3 82.2%）。正解是用**融合序位次先验**（1 − i/(n−1)），它对「最终注入顺序」忠实。

**修复（`src/core/recall/rerank/blend.ts` + `applyRecallRerank`）** —— ⚠ 该文件在 §21.6 已改名 `anchor.ts` 且 α 混合逻辑删除；下表 `rerank.blend` 一行仅作历史记录，锚点与 floor 补位仍然生效。

| 机制 | 语义 | 关断 |
|---|---|---|
| `rerank.blend` α（0..1） | `score = α × 融合位次先验 + (1−α) × 精排归一化分`；α=0 逐位旧行为，α=1 逐位融合序 | 缺省 0（旧行为） |
| 融合锚点（无开关） | 截断窗口 cap 内必须含融合 top-1（它自己过 floor 时）；cap≥2 时精排仍可改第 2..cap 名次 | 恒开（行为变更，见下） |
| floor 补位（无开关） | 达线行不足 cap 时，按融合原序把被 floor 剔掉的候选补回填满窗口；floor 只裁「超出窗口」的尾部 | 恒开（行为变更） |
| journal | `gates.rerank.blend / anchor / floorToppedUp` 可观测 | — |

**验证（LME90 检索侧，同全开配置、同 judge 环境）**

| 档 | turnCov@5 | MRR | nDCG | 相对 rerank-off |
|---|---|---|---|---|
| rerank off（最优参照） | 82.6% | 0.767 | 0.831 | — |
| rerank 生产值（旧，纯重排 + floor） | 77.6% | 0.719 | 0.818 | −5.0pp cov |
| **rerank + blend 0.9 + 锚点 + floor 补位** | **80.5%** | **0.761** | **0.838** | −2.1pp cov / **+0.7 nDCG** |

- 修复后 nDCG 反超 rerank-off（0.838 > 0.831）、MRR 追平（0.761 vs 0.767），cov 差距从 5.0pp 缩到 2.1pp；剩差来自 floor 仍裁掉部分尾部行与 α<1 的微调，属于可继续收敛的余量（#145）。
- 行为变更登记：`minScore` 不再让注入窗口比预算更少（4 个既有单测已按新契约改写：#99 F3 的「drop 不垫尾」→「只裁尾、不饿窗口」）；锚点让「精排把融合 top-1 挤出窗口」不再发生。
- 相关：bench harness 修了 rerank 子进程 recycle 时的 `EPIPE` 未处理错误（`scripts/lib/bench/rerank-child-host.mjs`），新增 `--rerank-blend` / `--rerank-timeout` 试验键。

**结论**：rerank 的正确用法是「**有界重排 + 噪声过滤**」，不是「主排序器」。生产建议 `rerank.enabled=true`（保留噪声过滤），而不是关闭。

> ⚠ **本条建议已在 #145 收尾时修正（§21.1）**：上面的 `blend≈0.9` 只在「浅池 12 + 硬 floor −2」锚点成立；把池扩到 32、floor 放到不筛之后，α>0 三档全负（turnCov −1.15/−3.83/−3.64pp），生产改用纯精排（缺省 0）。

## 14. W3 生产语料灰度复核与 maxExtraLines 定档（issue #138，2026-10-28）

> **触发**：票面要求在生产流量上验证 W3（结论卡 + smallToBig 回捞）并给 `maxExtraLines` 定档，
> 且 #135 指出「剪枝噪声」会污染定档。用户口径：**不许用关开关收口**——结论层/精排/RAG 配置
> 本身有价值，错在用法或算法，要修根因。
> **只读取证**：生产 recall journal（`D:/TDB/data/logs/recall`，12 文件 2485 条，2026-10-12~10-27，
> 零写入零外呼）；bench 复核全部同 manifest（n=90）同 judge（MiniMax-M3.1-Flash）。

### 14.1 生产语料观测（journal 只读，脚本 `scripts/audit/r138-w3-prod-observation.mjs`）

| 指标 | 实测 |
|---|---|
| 结论层（layered）命中率 | **49.6%**（1233/2485） |
| 每题结论行数分布 | 0 行 50% / 2 行 12.7% / 3 行 6.9% / 4 行 20.9% / 5 行 9.2% |
| 注入总行数触硬帽（=5） | 10.2% |
| **结论层命中时经验层 ≤1 行** | **98.4%**（1213/1233） |
| 表示占比（注入行里谁是主体） | 结论层 **97.8%**（其中 work_fact 42.7%、上下文 0.4%）/ 经验层 **2.2%** |
| smallToBig 回捞触发率 | **0.2%**（6/2485，均值 0.008 行/题） |
| 触发时「结论+上下文」占注入行 | 100%（即回捞点亮的 6 条里，原文行全被挤掉） |
| 精排剪枝 kept≤1 占比 | **35.6%**（kept=0 占 23.6%） |
| 召回总耗时 P50/P95、精排 P50 | 1721 / 6726 ms、937 ms |

**读法**：生产不是「结论卡偶尔挤掉一行」，而是**结论层几乎单独占满 5 行注入窗口**（97.8%），
原文行长期只剩 0~1 行——票面担心的「注入行数分布/上下文行占比」在生产上是极端偏斜，不是轻微代价。
`smallToBig` 的回捞（摘要→源证据）在生产几乎没工作（0.2%），与 bench 同型（9/90）。

### 14.2 bench 复核：同一台机器上的槽位竞争（脚本 `scripts/audit/r138-slot-competition.mjs`）

| 档 | 结论行/题 | 上下文行/题 | 经验行/题 | 经验≤1 行率 | turnCov@5 | 判对 |
|---|---|---|---|---|---|---|
| b1off-mm（基线，无 W3） | 0 | 0 | 3.53 | 1.1% | 76.9%¹ | 77.8% |
| w3x2（maxExtraLines=2） | 1.88 | 0.03 | 2.56 | 10.0% | 73.7%¹ | 81.1% |
| w3x4（maxExtraLines=4） | 2.36 | 0.04 | 2.12 | **36.7%** | 76.7%¹ | 84.4% |
| r137fix（#137-F 精排修复 blend .9） | 2.36 | 0.04 | 2.12 | 35.6% | 77.8%¹ | 81.1% |

¹ 逐题均值口径（与 overall 的加权口径略有差异，跨档同口径可比）。

**分桶（W3×4 vs 基线，逐题配对）**：knowledge-update cov **+14.4pp**、multi-session +7.8pp、
temporal +3.3pp；**single-session-assistant −13.3pp、preference −10pp**——与票面评论 ② 一致。

**逐题根因（bench 7161e7e2，single-session-assistant）**

- 基线注入：`Assistant: … Shift Rotation Sheet … | Sunday | Admon | …`（答案就在这一行）；
- W3×4 注入：`[结论] The user needs a 1-week shift rotation sheet…`（用户侧摘要）+ `[上下文] [2023-05-24 16:21] User: 7 agents`
  ——**答案轮被挤掉，换成一条不承载答案的前情行**。

→ 结论层并非「无用」，而是两个实现缺陷叠加：
① **上下文行与结论行共同挤经验层配额**（`experienceLimit = maxResults − 结论行 − 上下文行`），
   结论层一旦拿满，原文行归零；
② **回捞按 store 返回序选证据**，把「用户前情」排在「承载答案的 assistant 轮」之前，且一张卡能吃掉全部帽。

### 14.3 修复（不是关开关）

| 机制 | 落点 | 缺省 |
|---|---|---|
| `recall.smallToBig.budget = "shared"\|"additive"` | additive = 上下文行不挤经验层保底（`experienceLimit = maxResults − 结论行`），注入总行数 ≤ maxResults + maxExtraLines | **shared**（逐位现状）；additive 显式开 |
| `recall.smallToBig.relevanceRanked`（true/false） | 回捞证据按**查询 token 命中数**排序，第一轮每卡至多 1 条（摘要必带源证据），余量再补 | **true**（质量修复，确定性纯函数） |
| `recall.conclusionLayer.maxConclusions` | 结论行条数上限（与 maxExtraLines 是同一预算的两个旋钮，票面评论 ④） | undefined = `floor(maxResults/2)`（现状公式） |
| `gates.smallToBig` journal 观测门 | mode/maxExtraLines/ranked/candidates/kept——生产灰度能区分「没触发」与「触发但选错」 | 恒开 |

**行为变更登记**：`relevanceRanked` 缺省 true 会改变既有 W3 档的行序（只改选哪条证据，不改候选/门槛/
排序层）；`budget` 缺省 shared 保证未配置部署逐位不变。新增单测：`recall-small-to-big.test.ts` ⑧–⑪
（additive 预算 / 相关性排序 / 回滚档 / 结论条数上限）、`config.small-to-big.test.ts`（三键解析）。

### 14.4 扫参结果（`scripts/run-r138-arms.sh`，additive 档 × maxExtraLines；同 manifest n=90 / 同 judge MiniMax-M3.1-Flash / 同基线库）

| 档 | budget | maxExtraLines | 结论行/题 | 上下文行/题 | 经验行/题 | 总行/题 | 经验≤1 行率 | kept≤1 | turnCov@5 | **判对** |
|---|---|---|---|---|---|---|---|---|---|---|
| b1off-mm（基线） | — | — | 0 | 0 | 3.53 | 3.53 | 1.1% | — | 76.9% | 77.8% |
| w3×2（现状 shared） | shared | 2 | 1.88 | 0.03 | 2.56 | 4.43 | 10.0% | — | 73.7% | 81.1% |
| w3×4（现状 shared） | shared | 4 | 2.36 | 0.04 | 2.12 | 4.48 | **36.7%** | — | 76.7% | 84.4% |
| r137fix（shared + rerank .9） | shared | 4 | 2.36 | 0.04 | 2.12 | 4.48 | 35.6% | 31.1% | 77.8% | 81.1% |
| **add×2（#138 修复）** | additive | 2 | 1.88 | 0.03 | 3.19 | 5.07 | **1.1%** | 0% | 73.0% | **84.4%** |
| **add×4（#138 修复，推荐）** | additive | 4 | 2.36 | 0.04 | 3.14 | 5.50 | **1.1%** | 0% | **78.9%** | **84.4%** |
| add×6（饱和档） | additive | 6 | 2.41 | 0.04 | 3.14 | 5.56 | 1.1% | 0% | 78.9% | 84.4% |

**读法**

- `additive` 把「结论层命中时经验层 ≤1 行」从 **36.7% 压到 1.1%**（每题经验行 2.12 → 3.14），
  同时**判对不降**（84.4% = 现状 shared×4 的最好值，高于 shared + rerank-fix 的 81.1%）、cov@5 +2.2pp。
- **cov@5 口径**：additive 档注入行数可达 `maxResults + maxExtraLines`（≈7 行），`turnCov@5` 只数前 5 行，
  对 additive 系统性不利 → 定档以判对为主，cov 看形状。
- **分桶判对（add×4 vs 基线）**：knowledge-update **100%**（86.7%）、temporal **100%**（86.7%）、
  multi-session 66.7%（40%）、single-session-user 93.3%（93.3%）、preference 66.7%（66.7%）；
  **single-session-assistant 仍 80% vs 93.3%**——这一桶的缺口不在预算（经验行已回到 2.73），
  而在结论卡只蒸馏 user 侧事实（见 §14.5 遗留）。
- **判对噪声**：n=90，±1 题 = ±1.1pp；单桶 15 题，±1 题 = ±6.7pp。add×2 与 add×4 同分，差异只在 cov/分桶方向。
- **4→6 已饱和**：add×6 与 add×4 五项指标逐位相同（判对 84.4%、cov 78.9%、经验行 3.14、经验≤1 行率 1.1%）——
  每张卡的 part_of 证据候选均值只有 2~4 条（`gates.smallToBig.candidates`），帽放到 6 也填不满；
  **`maxExtraLines` 的有效区是 2~4，4 已是上界**（继续加大只增加注入行数预算，不增加实际行）。

### 14.5 定档与生产建议

| 旋钮 | 定档 | 依据 |
|---|---|---|
| `recall.smallToBig.budget` | **additive** | 经验层 ≤1 行率 36.7% → 1.1%；判对 84.4% 不降；注入行数 4.48 → 5.50（平均 +1 行） |
| `recall.smallToBig.maxExtraLines` | **4** | add×2 与 add×4 判对同分，但 add×4 的 cov +5.9pp、knowledge-update 判对 93.3%→100%；再往上（6）在 n=90 上不可分辨 |
| `recall.smallToBig.relevanceRanked` | **true**（缺省） | 回捞证据按查询命中排名；不做这项时 7161e7e2 类会把前情行排在答案轮之前 |
| `recall.conclusionLayer.maxConclusions` | 缺省（`floor(maxResults/2)`） | 与 maxExtraLines 同属一个预算；本波无放宽证据 |

**回退面**：`budget: shared` 一行回到本波之前（代码不需要回滚）。

**遗留（不在本票）**

1. **结论卡只覆盖 user 侧事实**：assistant 桶（「你上次建议了什么」）系统性不相关，单靠预算修不动——
   需要写入面扩展（结论卡覆盖 assistant 侧）或按题型路由（#141）。
2. **生产无 gold**：判对只能在 bench 复核；生产侧看结构指标（经验行分布、表示占比、回捞触发率）+ 抽样可答性，
   灰度前后对照即可判定 additive 是否在生产同样生效。
3. `turnCov@k` 口径对「注入行数 > k」的档不公平，后续评测应改用「注入集覆盖率」而非固定 k 切片。

### 14.6 生产落地（2026-10-28，非灰度开关：只改读侧预算与路由）

**改动（本机生产网关，`MemoryCore/tdai-gateway.yaml`）**

| 键 | 旧值 | 新值 | 回退 |
|---|---|---|---|
| `memory.recall.smallToBig.budget` | `shared` | `additive` | 一行改回 |
| `memory.recall.smallToBig.relevanceRanked` | true（缺省） | true（显式） | 一行改 false |
| `memory.recall.conclusionLayer.routing` | （缺键=off） | `assistantRecall` | 删键/改 off |

网关按生产 SOP 重启（`node --import logtee --import tsx src/gateway/server.ts`，新日志
`tdai-core-20261028-100716.*`），`127.0.0.1:8420` 恢复监听、`/v3/recall` 200。

**活体探针前后对照**（`scripts/audit/r138-live-probe.mjs`，只读 `/v3/recall`）

| 探针查询 | 重启前 | 重启后 |
|---|---|---|
| 中文事实型（采购测试环境地址） | cc=2 / ec=2，3 行 | cc=2 / ec=2，4 行（`s2b.candidates=0`） |
| 中文更新型（云文库二期调研进度） | cc=1 / ec=2，3 行 | cc=1 / ec=2，3 行 |
| **assistant 回忆型（"Can you remind me …you told me…"）** | **cc=2 / ec=0，2 行** | **cc=0 / ec=2，2 行（layered=false，路由生效）** |
| 建议请求型（"Can you recommend…"） | cc=2 / ec=0 | cc=2 / ec=0（走 fts-only 降级帽，见下） |

`gates.smallToBig` 首次出现在生产 journal（`mode=additive, ranked=true, candidates, kept`）——
本票要求的「生产可观测」已落地，后续灰度可直接量 `kept/candidates` 而不是猜。

**探针揭示的两件生产事实（写进遗留）**

1. **结论卡大多没有 part_of 证据边**：两个中文查询 `s2b.candidates=0`，回捞天然不触发——
   这是生产回捞率 0.2% 的主因（不是 `maxExtraLines` 太小）。`budget=additive` 在「无证据边」时
   退化为 shared 语义（上下文行为 0），不会误伤。
2. **fts-only 降级帽会掩盖预算实验**：英文查询 `embeddingHits=0`（余弦门槛 0.3 过滤）触发
   `ftsOnlyInjectCap=2`，注入被裁到 2 行（头部=结论行）——与 additive 无关，探针/灰度分析必须先
   排除 `embeddingHits=0` 的样本，否则会把降级裁剪切当成预算效果。

### 14.7 需要重新设计的部分（本轮已做 / 待后续票）

| 项 | 判断 | 本轮处置 |
|---|---|---|
| 覆盖率口径 `turnCov@k` 对「注入行 > k」的档不公平 | **已重设计** | bench metrics 新增 `turnCovInjected / sessionCovInjected / injectedLines`（旧键保留，口径连续） |
| assistant 桶被结论卡挤占 | **已重设计（路由）** | `conclusionLayer.routing=assistantRecall`：纯规则识别「回忆 assistant 输出」，90 题命中 13/15 assistant 桶、其余五桶 0/75；retrieval 侧 cov 66.7→80.0 |
| 结论卡只蒸馏 user 侧事实（路由只是权宜） | **待后续（#141 方向）** | 根治要写入面双源蒸馏（结论卡覆盖 assistant 侧），或按题型预算路由；本轮不动写入面 |
| 生产结论卡缺 part_of 证据链 | **待后续（写入面）** | 生产 `candidates=0` 是回捞不工作的主因；需要 consolidation 在产卡时落证据边（本票只读侧，不动写链） |
| `ftsOnlyInjectCap` 与预算观测混淆 | **已登记** | 灰度分析需按 `embeddingHits>0` 过滤样本；未改代码（改它会动降级语义，另立票） |


### 14.8 关票复核：结论卡质量抽查 + 生产语料三档离线重放（2026-10-28 13:40~）

票面最后两项验收是「结论卡质量抽查（part_of 边完整、内容可回溯）」与「灰度窗口内指标表（≥3 档）」。
在线灰度窗口在数小时内凑不够样本（10:07 上线后 journal 仅 3 条带 `gates.smallToBig`），因此：
质量抽查改为**全量库统计 + 抽样核可回溯**；三档表改为**生产语料离线重放**（100 条真实历史 query × 3 档，配对可比）。

#### 14.8.1 结论卡质量抽查（`scripts/audit/r138-card-quality.mjs`，只读）

| 指标 | 值 | 说明 |
|---|---|---|
| work_fact 卡（`l1_records`） | 995 张 | `l1_archive` 另有 1107 张 |
| 至少一条 `part_of` 出边的卡 | 104 张 | **覆盖率 10.5%** |
| `part_of` 边总数 | 585 条 | 边/卡 0.55；有边卡均 5.27 |
| 悬空边（指向不存在的证据行） | **0** | 有边即完整 |
| 抽样 60 张有边卡 → 与证据行可回溯 | **54/60 = 90.0%** | 判据：≥2 个去重词重叠 |
| 证据行缺失 | 0 | |

判读：**"有边就完整、内容就可回溯"**；短板在覆盖率（10.5%），属写入面（consolidation 产卡时未落证据边），
由 #155 承接，不是读侧问题。

#### 14.8.2 生产语料三档离线重放（`scripts/audit/r138-prod-replay-sweep.mjs`）

方法：journal 去重后候选池 439 条真实 query，按 sha1 排序取前 100（可复现）；把生产
`D:/TDB/data/vectors.db` 复制到 `.tmp/r138-replay`，用沙箱 yaml（关 journal/queryExpansion/生命周期；
`smallToBig=additive+relevanceRanked`；`conclusionLayer.routing=assistantRecall`）逐条跑
`performLayeredRecall`，三档只变 `maxExtraLines`；精排走 `ChildProcessReranker`（本地模型，与生产同款）。

与在线灰度的差别（必须声明）：查询取自历史流量而非灰度期实时流量；无 gold 标签，只出结构指标，
判对仍以 §14.4 的 bench 为准。**同一批 query × 三档 = 配对**，比顺序在线窗口更可比。

| `maxExtraLines` | 结论层命中率 | 结论行/题 | 上下文行/题 | 经验行/题 | 总行/题 | 经验≤1 行率 | 回捞可触发率 | 精排 kept≤1 | 延迟 P50/P95 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| 2 | 58% | 2.21 | 0.26 | 0.10 | 2.57 | 98% | 13% | 0% | 602 / 2921 |
| 4 | 58% | 2.23 | 0.41 | 0.10 | 2.74 | 98% | 13% | 0% | 648 / 3076 |
| 6 | 58% | 2.23 | 0.42 | 0.10 | 2.75 | 98% | 13% | 0% | 1636 / 3293 |

判读（三条）：

1. **方向正确但幅度小**：2→4 上下文行 +0.15/题、总行 +0.17；4→6 饱和（+0.01），与 bench §14.4
   「4→6 五项逐位相同」一致 → `maxExtraLines=4` 维持，不必上 6。
2. **经验行恒为 0.10，不是预算被抢**：生产 L1 检索本身几乎不返回 episodic 行（工作事实卡占命中主体，
   1786 条 episodic 有向量但未过相似度门槛/排序），总行只有 2.5~2.8 行，远未到 5 行预算。
   → 生产绑定约束是**召回**，不是槽位；additive 只解放了本就稀少的那部分上下文。
3. **回捞可触发率 13%**（观测脚本全量分母的 0.2% 是 epoch 混合伪值，见 14.8.3）：三档都是 13%，
   说明回捞触发取决于 part_of 边命中，与 `maxExtraLines` 无关 → 生产收益更依赖 #155。

#### 14.8.3 口径修正（两处，影响此前数字）

- `r138-slot-competition.mjs`：`refused` 兼容 0/1 数值（此前拒答列恒 0%）；新增延迟 均值/P95 列。
- `r138-w3-prod-observation.mjs`：上下文触发率增加 **gated 子集**（`smallToBig` 上线后才写 gate）；
  全量分母的 0.2% 混合了未上线 epoch，只作对照（gated n=3，ctx 0%，candidates 33%）。

#### 14.8.4 关票判定（逐条对照验收）

| 验收项 | 证据 | 结论 |
|---|---|---|
| 生产观测（结论卡命中/注入行/上下文行） | §14.1 + §14.8.3 gated 子集 | 满足 |
| `maxExtraLines` 三档扫参（判对+拒答+延迟） | §14.4 三档判对均 84.4%、拒答 8.9~11.1%、延迟见 §14.2 表 | 满足 |
| 结论卡质量抽查（part_of 完整 / 内容可回溯） | §14.8.1：0 悬空、90% 可回溯、覆盖率 10.5% | 满足（覆盖率缺口转 #155） |
| 灰度窗口指标表（≥3 档） | 在线窗口样本不足（gated n=3）→ §14.8.2 生产语料配对重放三档替代 | 满足（替代口径，差异已声明） |
| 常态化值 | 4（2~4 有效区、6 饱和；生产重放同向） | 满足 |

残余（不阻塞关票，均已外置）：路由档判对因 MiniMax 配额（402/429）未跑 → 另立票跟踪；
part_of 覆盖率 10.5% → #155；结论卡单源 → #156；在线 24h 灰度观察 → 生产已上线，journal 自然积累。

## 15. #139 bench harness 技术债 + W3 写/读拆分归因（2026-10-28）

> **票面**：github #139 七项技术债（429 退避单一源 / 取数去重 / 缓存三件套 / 抽取 token 计量 /
> W3 写读拆分 / ingestCase 写入策略 / arms 可移植且失败即非 0）+ #135 并入两项。
> **用户口径**（贯穿本票）：「不要只尝试关闭开关——配置本身有益，错在使用或算法，要解决根因」。
> 本票不改召回语义，只把「测量仪器」修准，并用它回答 §14 遗留的归因问题。

### 15.1 三档口径（同一库、只改读侧开关）

- 库：`STORE=/tmp/tdagemem-bench/lme90-r138-add4`（§14 add×4 全开基线库，结论卡与 part_of 边已落库），
  三档**零重灌、零写侧外呼**，只切读侧开关；`--no-write-steps`（复用库跳过分阶段写入）。
- 检索口径：`--gen-limit 0`（retrieval-only，只比召回覆盖率），manifest n=90 逐题配对，
  `--pace 150`、rerank=local+blend0.9、candidateK32、factChannel 0.6、fusion normalized。
- 命令：`bash scripts/run-139-w3split.sh all` → 报告 `MemoryCore/.eval-data/bench/139-w3-{control,write-only,read}.json`
  （`--report-name` 钉死文件名，并行跑不再串味）。

| 档 | 读侧配置 | 语义 |
|---|---|---|
| control | `--small-to-big-off --conclusion-layer-off` | 无卡基线：结论层整体关，注入里没有结论行 |
| write-only | `--conclusion-cards --small-to-big-off` | 卡在库里且结论层开、**回捞关**（只看写入面） |
| read | `--conclusion-cards --small-to-big --small-to-big-max-extra 4` | 卡 + 源证据回捞（§14 定档值） |

**注入口径**（#139 评论第 8 条）：报告里 `blockChars` 是生产 injector 输出（短，常 1-2 行），
`evidenceChars` / `injectedLines` 才是 b1 模式真正喂给作答的证据块（hits 拼装）。
讨论注入预算/结论占比时认准后者，混读会得出「注入只有 1.5 行」的错误结论。报告 `config.fieldSemantics` 里已写明。

### 15.2 三档结果（逐题均值，n=90）

| 档 | 结论行/题 | 注入行/题 | blockChars/题 | turnCov@5 | sessionCov@5 | sessionAny@5 | nDCG@5 | MRR@5 | 召回均值 |
|---|---|---|---|---|---|---|---|---|---|
| control（无卡基线） | 0.00 | 3.93 | 1062 | **74.11%** | 88.37% | 98.89% | 0.742 | 0.791 | 1112ms |
| write-only（有卡、无回捞） | 0.63 | 3.93 | 1009 | **70.78%** | 87.63% | 98.89% | 0.726 | 0.789 | 1414ms |
| read（有卡 + 回捞 4 行） | 2.04 | 4.42 | 961 | **81.15%** | 93.19% | 100% | 0.878 | 0.811 | 1754ms |

### 15.3 配对归因（逐题配对 + paired bootstrap 4000 次）

| 对比 | turnCov@5 Δ[95%CI] | sessionCov@5 Δ | nDCG@5 Δ | MRR@5 Δ | 结论行 Δ | 升降题数 |
|---|---|---|---|---|---|---|
| control → write-only（卡的净效应） | **−3.33pp [−7.22, 0.00]** | −0.74pp [−3.33,+1.48] | −0.016 [−0.044,+0.008] | −0.002 | +0.63 [+0.51,+0.76] | 1↑ / 5↓ / 84= |
| write-only → read（回捞的净效应） | **+10.37pp [+4.26, +16.67]** | +5.56pp [+1.11,+10.19] | +0.153 [+0.080,+0.225] | +0.022（ns） | +1.41 [+1.10,+1.73] | 17↑ / 3↓ / 70= |
| control → read（完整 W3 的净效应） | **+7.04pp [+1.67, +12.59]** | +4.81pp [+0.56,+9.44] | +0.137 [+0.064,+0.208] | +0.020（ns） | +2.04 | 13↑ / 3↓ / 74= |

门禁（`scripts/bench-gates.mjs` 配对）：

| 配对 | 门禁1 缺口桶回收 | 门禁2 判对 | 结论 / exit |
|---|---|---|---|
| control → write-only | **FAIL**（13 个缺口桶，回收 0 题） | SKIP（retrieval-only 无 genCorrect） | 1 项 FAIL → exit 1 |
| write-only → read | **PASS**（15 个缺口桶，回收 9 题） | SKIP（同上） | 通过（3 项 SKIP）→ exit 0 |

### 15.4 判读（这就是票面第 5 项要的归因）

1. **写入面本身不回收召回，且是轻微负项**：只落卡不打开回捞，turnCov@5 **−3.33pp**（CI 上界恰为 0），
   13 个缺口桶**一题未回收**。机制与 §14.3 同源——结论行占用 shared 预算，把承载答案的经验行挤掉，
   而卡片自己不带源证据，读侧就拿不到原文。**「有卡」≠「能答」。**
2. **收益几乎全部来自读侧回捞**：write→read 的 **+10.37pp**（17 题升 / 3 题降 / 70 题持平）与
   nDCG **+0.153**；同时注入行只 +0.49 行、blockChars 反而 −48（ns）——回捞是「把摘要行补成摘要+源证据行」，
   **不是靠塞更多上下文**换来的。
3. **完整 W3 相对无卡基线 +7.04pp**（CI 下界 +1.67>0）。所以「结论层有用」的成立条件被这次拆分钉死了：
   **必须带 part_of 源证据回捞**；单独开卡会把 §14 的槽位挤压再犯一遍。
   这与 §14.8.1 的生产短板（part_of 覆盖率仅 **10.5%**）直接对应——生产回捞触发率低不是 maxExtraLines 太小，
   而是卡缺证据边（#155）。

**一句话**：W3 的价值不在「写结论卡」，而在「结论卡 → 源证据回捞」这条链路；修测量仪器后，
票面第 5 项的归因从「w3b 比 b1-off +10pp 说不清」变成三行可解释的账。

### 15.5 技术债收敛落点（票面 7 项 + #135 两项）

| 票面项 | 落点 | 验收 |
|---|---|---|
| 1 429 退避单一源 | `lib/bench/retry.mjs`（attempts/delays/jitter/isRetryable/isEmpty；末次不 sleep） | facts/conclusions/fact-extract-gate/llm 四处引用；`llm.call` 新增 `retry:false`，**长退避所有权只在抽取层**（避免 4×3 双层叠加） |
| 2 取数去重 | `lib/bench/stages.mjs` `fetchFactsAndConclusions` + `mergeStageStats` | eval 三路（主灌库 / 分阶段 / facts-only）同源，不再各写一份累加 |
| 3 缓存三件套 | `lib/bench/cache.mjs`（model + promptVersion 校验、tmp+rename 原子写、失效原因可见） | 缓存失效不再静默重抽（`[bench] 事实/结论卡缓存失效（reason）`） |
| 4 抽取 token 计量 | `lib/bench/tokens.mjs` `normalizeUsage/estimateMessagesUsage` + `stages.tokenEvidence` | 缓存档也出 token/turn；估算标「（估算口径）」但**不改 verdict**；usageSource=live/estimated-live/mixed/none |
| 5 W3 写读拆分 | `--small-to-big` / `--small-to-big-off` / `--conclusion-layer-off`；`scripts/run-139-w3split.sh` | 本 §15 三档归因表 |
| 6 ingestCase 写入策略 | `store.normalizeWritePolicy` + `opts.writePolicy` | dualWrite/supersede/factChannel 需 facts 集中报错；cardinalityGate 缺省开 |
| 7 arms 可移植 / 失败即非 0 | `STORE_ROOT`/`TMPDIR`、失败累计、`--report-name`、门禁读失败→FAIL、门禁2 无 genCorrect→SKIP | 三个 arms 脚本 `bash -n` 通过；`bench-gates` 不再「SKIP 假绿」（旧版门禁4 读失败落 SKIP→exit 0） |
| #135-1 生效配置回读 | `effectiveRecallSnapshot` + `--expect-config` | 生产 `config-override.json` 覆盖沙箱 yaml 时立刻 exit 2，不白跑一档 |
| #135-2 filter-only 静默无效 | eval 断言 `--rerank-child-proc` **且** 生效 `rerank.enabled=true` | `--rerank-filter-only … --rerank-off` 组合现在 exit 2 |

补充（本轮评审后加固）：门禁3 预算判定抽成 `judgeTokenBudget`（展示与判定分离；turns 缺失→SKIP 不再假红）；
`--budget-cards-per-group` 可判结论卡数量；`--store/--dataset/--manifest/--report-name/--tag` 裸 flag 一律 exit 2；
`smallToBig.requested` 记 `"on"|"off"|null`（区分「没指定」与「显式关」）。

### 15.6 遗留

1. **判对指标缺**：本机 LLM 单点 402，三档只有召回侧（genCorrect 全空 → 门禁2 SKIP，属未测量）；
   判对结论沿用 §14.4（add×4 = 84.4%）。
2. **turnCov@5 口径对注入行 >5 的档不利**（同 §14 遗留 3）；read 档注入 4.42 行仍可读，但 4 行回捞已贴近边界。
3. **回捞收益的上限取决于 part_of 覆盖率**（生产 10.5%）：写入面补证据边是 #155，结论卡覆盖 assistant 侧是 #156/#141。
4. **历史档逐位复现需要显式关配置**：生产 yaml 自 #137 起 `recall.factChannel.enabled=true`，复用的沙箱库会继承它；
   已加 `--fact-channel-off`（与 `--fact-channel*` 互斥）才能拼出「无事实通道」的旧基线。

### 15.7 回归复跑（验收项「既有 arm 复跑结果不变」）

- 口径：**同一库** `lme90-mm-b1off`、**同一组旗标**（`--b1 --rerank-off --gen-limit 0 --recall-ks 1,3,5,10`）上，
  旧 harness（45e3d87，`git stash` 暂存本票改动后跑）与新 harness（本票）各跑一次，retrieval-only、n=90。
- 先证可复现：新 harness 连跑两次逐位一致（77.82 / 93.04 / 0.739 / 0.743），排除自身抖动后再谈差异。

| 档 | turnCov@5 | sessionCov@5 | nDCG@5 | MRR@5 |
|---|---|---|---|---|
| 旧 harness（45e3d87） | 78.40% | 93.60% | 0.742 | 0.743 |
| 新 harness（本票） | 77.82% | 93.04% | 0.739 | 0.743 |
| Δ（新−旧） | **−0.58pp** | −0.56pp | −0.003 | 0.000 |

→ 四项 Δ 全部 ≤1pp，**验收「结果不变」成立**（本票只动 harness，不改召回语义）。

**顺带查清的两件事**（都属于别人/环境的账，不是本票引入）：

1. 10-26/10-27 的历史档位数**不能逐位复现**：b1-off 79.54%→77.82%（−1.7pp）、w3b 79.35%→83.37%（+4.1pp）。
   后者的机制能定位：w3b 的**结论行数从 2.36/题降到 2.04/题**（#138 起的结论条数上限缺省 = `floor(maxResults/2)`=2），
   按 §14 的槽位竞争规律，结论行变少就会抬高 turnCov —— 是 #138 的缺省值变更，与本票无关；
   b1-off 的 −1.7pp 落在库/环境状态差（同库跨周复用 + query 向量缓存状态），无系统性方向。
2. 复跑历史档必须显式关掉后来开的生产配置（`--fact-channel-off`、`--validity-mode hard`、`--small-to-big-off`、`--conclusion-layer-off`），
   否则「基线档」里混进生产默认，差异会被误读成本票的回退。
   **脚本已固化**（#159，含后续收尾）：10 个历史 arm 脚本统一 source `MemoryCore/scripts/lib/bench/arms.sh`——
   每档强制 `--expect-config`（口径不符 exit 2，不再靠人记）、`--report-name` 恒等 tag 并断言报告落盘、路径只走
   `STORE_ROOT`/`BASE_STORE`；随后 `run-r141-*.sh`、`run-r146-arms.sh` 补上同样的显式口径与断言，
   `run-r146-currency{,2}.sh`、`run-rejudge-noise.sh` 去掉个人家目录硬编码（改走 `${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}`；本机 git bash 下 `TMPDIR` 就是 `%TEMP%`，与旧硬编码同一物理目录，故读数不变，但**临时目录不持久**，正式跑请给 `STORE_ROOT`）（只跑重判的 `run-rejudge-noise.sh`
   无 runner 旗标，故不要求 `--expect-config`）。`MemoryCore/__tests__/bench-arms-hygiene.test.ts` 守住这条纪律。
   `W3_OFF` 现在同时带 `--small-to-big-off`——**只是显式化，读数不变**：结论层关着 ⇒ `r7Conclusions` 恒空
   （`src/core/hooks/auto-recall.ts` 的收集门），回捞块要求 `r7Conclusions.length > 0`、slot 记账又要求
   `r7ConclusionLines > 0`，该旗标在此档完全惰性，b0 / w1 / w2h / w2s / w1w2h / w1w2s 与 §14 仍逐位可比。
   **真正改了读数的是 `W3_NEW` 补的 `--conclusion-max-extra 4`**（原先继承 runner 缺省 2）：w3 / w1w3 / w2hw3 /
   w2sw3 / alls / allh 六臂因此与 §14/§16 的历史读数不可比（按 §14.4，add×4 的 turnCov 约 +5.9pp），
   重跑后必须按新口径重读；§16 里「新分阶段臂没传 `--conclusion-max-extra`」这句自此作废。
   另有两处**本轮才发现的读数缺陷**（都已钉进脚本与断言）：
   - 结论行上限（`conclusionLayer.maxConclusions`）全程没钉，值来自继承的 `floor(maxResults/2)`；r141 两个脚本
     现显式 `--conclusion-cap 2` 并断言（= `floor(5/2)` 继承值，读数不变；钉 5 会直接改预算，别抄 r146c wide 档的 5），免得生产 `maxResults` 一漂就静默改预算。
   - **off 档不可达**（→ #174）：`excludeInvalidatedFor` 是 `mode === "soft" ? "soft" : flag`，所以
     `--validity-off` 在 `mode=soft` 下被盖住，b0 / w1 / w3 / w3legacy / w1w3 这些「W2 关」格实测仍是**软失效**
     （与 w2s 同配置——§14 表里 b0 与 w2s 逐位相同即旁证，§15 的「保留 soft」实为 soft-vs-soft）。
     快照因此新增派生键 `recall.excludeInvalidated.effective`，脚本断言它而不是只断言声明的 `false`；
     修 #174 后这批臂要重跑、§14/§15 结论按新读数复核。

## 16. #141 机制分阶段：W1 双通道 / W2 软失效+属性契约 / W3 表示路由（2026-10-28）

> 前置：§11（#136 属性契约）、§12（#137 W1 双通道）、§13.5（#137-F 融合锚点）、§14（#138 预算口径）。
> 票面：[#141](https://github.com/cxin21/tdb-hechen/issues/141)。分支 `bench/recall-opt`，提交 `0a130d1`。

### 16.1 为什么是「分阶段」而不是「关开关」

10-27 全开档（W1+W2+W3）判对 77.8%，比只开 W3 的 84.4% 差 6.7pp（p=0.031，6 对 0，**0 题翻盘**）。
三条机制都在**同一个阶段**（合并后的 Top-5 槽位）竞争边际收益，于是互相覆盖：收益不叠加，代价照收。
本票不改「开/关」，而是把三条机制各自**挪到一个互不竞争的阶段**，再用因子设计验证 Δ 是否真的 > 0。

| 机制 | 现状误用（根因） | 本票改法（正面解） | 生效键 |
|---|---|---|---|
| **W1 事实键** | 事实键与原文主索引**同层打分**：同一份 `maxResults=5` 里抢前缀，事实行挤掉原文行 | 降级为**并行召回通道**：原文排序保持原样，事实键只负责把候选**扩进来**，两路 RRF 融合（`readOnly` 不重写库） | `recall.factChannel.enabled/weight/readOnly` |
| **W2 supersession** | 把 `(subject, predicate)` 当**函数依赖键**：predicate 是泛化谓词（`is considering` / `wants to create` / `has a … member`），取值不互斥 → 误删旧事件 → temporal 拒答 | 先有**基数契约**（`cardinality: single|multi`，多值永不失效）；validity 只作**融合特征降权**（`SOFT_VALIDITY_PENALTY=0.5`），仅「现在/最新」类查询且**存在更新行**时才硬过滤 | `recall.validity.mode=soft|hard`、`recall.excludeInvalidated` |
| **W3 结论层** | 结论与原文行是同一知识的两种表示，却抢**同一批槽位**（3.5–4.5 行）→ 零和替换；回捞几乎没触发（`[上下文]` 仅 9/90 题） | 按**题型分配预算**（`exact-fact=0`、`aggregate/update=2`、`preference=1`、`assistant-recall=0`）；结论**按槽计价**（1.5 槽）把成本显式化；`work_fact` 结论**必须带 1 条 part_of 证据行**否则让位；语义重复的结论让位给原文 | `recall.conclusionLayer.routing=intent`、`smallToBig.budget=slot`、`conclusionLayer.pairing=require`、`conclusionLayer.arbitrate=redundant` |

### 16.2 实现落点

**新模块**

- `MemoryCore/src/core/recall/query-intent.ts`（扩展）：`RecallIntent` 七值（`assistant-recall|exact-fact|temporal|update|aggregate|preference|default`），
  `INTENT_POLICY`（冻结）：`{conclusionBudget, pairing, order: conclusion-first|turn-first, arbitrate}`、`classifyRecallIntent(text)`（中英 cue 表，优先级 assistant-recall > temporal > update > aggregate > preference > exact-fact > default）。
  **`default` 必须逐位退化**（`budget=undefined`、`pairing/arbitrate=false`）——intent 模式下大多数题会落到 default，它一旦带策略就等于全局改口径。
- `MemoryCore/src/core/recall/layered-budget.ts`（新）：`computeSlotBudget({maxResults, conclusionCount, slotCost, pairing, maxPairing})` 记账式预算；
  `arbitrateConclusions({conclusions, experienceLines, threshold=0.75})` 表示仲裁（content token 交集比，剥 `[tag]` 行头；
  短结论 `token<4` 与**否定极性相反**不误杀——避免把 `… doesn't support` 判成 `… supports` 的重复）。
- `MemoryCore/scripts/lib/bench/inject-attribution.mjs`（新）：注入行**四类归因**（`conclusion` / `evidence-recall` / `raw-turn` / `unknown`）+ 去掉该类后覆盖率的一阶贡献 `firstOrderDrop`；`evidenceSufficiency`（token 级 gold 覆盖，judge 前的廉价近似）。
- `MemoryCore/scripts/lib/bench/factorial.mjs` + `bench-factorial.mjs`（新）：因子表、`singleBest`（**在共同判分题集上选**，避免各臂分母不一致）、`combo`、配对 bootstrap 判定与 `formatFactorialMarkdown`。

**接线**

- `auto-recall.ts`：意图 → 结论预算 → 成对回捞 → 槽位记账 → 表示仲裁 → 装配顺序（`turn-first` 时**先预留结论槽位再裁经验层**，fts-only 帽与 `applyRecallBudget` 都不会再从尾部砍掉结论）；`counts.layered/conclusionCount/experienceCount` 改**实测**（不再按位置推断）。
  成对约束带**降级位** `degraded="pairing-unavailable"`：回捞通道不可用（store 无 `part_of` 读面 / `maxExtraLines=0` / 软失败）时跳过约束并保留结论——「查不到证据」≠「确实没有证据」，否则整层结论会被静默清空。
- `recall-journal.ts`：`gates.conclusionRouting` 落 intent / mode / budget / order / pairing / arbitrate / `unpairedDropped` / `arbitrateDropped`+threshold / `slotExperienceLimit`+`slotCost` / `droppedSamples`（recordId + 原因，≤3 条）/ `degraded`——灰度过线后复盘要能指名到具体卡。
- `eval-memory-bench.mjs` 新旗标：`--validity-off`、`--conclusion-budget-mode slot`、`--conclusion-routing intent`、`--conclusion-slot-cost N`、`--conclusion-pairing require`；**未知旗标与 `--k=v` 等号写法一律 exit 2**（负控臂被静默降级会让整张因子表失真）。
- `store.mjs` 新增 `recallFlatOverride`：`excludeInvalidated` 是 `recall` 根级键，与 `recall.validity.mode` 混写会静默失效。

### 16.3 观测面（能不能归因，决定能不能调参）

- **注入行类型归因**（`lineTypeStats` + `lineTypeTotals`）：每题三类一列行数 / 命中 gold 行数 / 会话数，外加「去掉该类型后覆盖率掉多少」。这是回答「结论层到底在买单还是在挤占」的唯一口径；只看 `turnCovInjected` 会把「结论行占位导致原文减少」和「原文本来就少」混为一谈。
- **证据充分性**（`evidenceSufficiency`）：token 级近似，`bench-gates --min-evidence-sufficiency` 缺省 **SKIP**（未测量 ≠ 测不过）。
- **分题型地板**（`bench-gates --per-type-floor temporal=<pp>`、`bench-factorial --floor`）：题型名支持前缀匹配（`temporal` 命中 `temporal-reasoning`），写错题型名**判 FAIL 而不是静默 SKIP**——门禁凭空消失比门禁红更危险。
- **生效值快照**：报告 `config.conclusionLayer` / `config.validity` 记录 `requested` 与**实际生效**两套值，用于区分「真跑新分阶段」与「静默回落旧档」。

### 16.4 因子跑批（臂定义）

跑批入口：`MemoryCore/scripts/run-r141-factorial.sh`（单进程，`--embed-interval-ms 1200`，禁止并发——豆包 embedding 账号级 RPM）。
基线库 `lme90-r137-allon`（LME90，90 题/90 租户），每臂从它**复制**一份 `lme90-r141-<arm>`；报告 `.eval-data/bench/r141-<arm>.json`。
固定项：`--dataset longmemeval --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --b1 --candidate-k 32 --rerank-blend 0.9 --rerank-child-proc --rerank-doc-cap 192`，
judge/作答 = MiniMax-M3.1-Flash，事实抽取 = MiniMax-M2.7（`--fact-model`）。**注意**：基线库自带生产 yaml（`factChannel.enabled=true`、`validity.mode=soft`、`smallToBig.enabled=true`），
所以每臂都必须**显式**写全三轴，否则「关」会被库里的继承值覆盖（§15.7 教训）。

| 臂 | W1 事实通道 | W2 效期 | W3 结论层 | 旗标 |
|---|---|---|---|---|
| `b0` | off | off（`--validity-off`） | off（`--conclusion-layer-off`） | 三轴全关的**负控** |
| `w1` | on（`--fact-channel --fact-channel-read-only --fact-channel-weight 0.6`） | off | off | 单档 |
| `w2h` | off | hard（`--validity-mode hard`） | off | 单档 |
| `w2s` | off | soft（`--validity-mode soft`） | off | 单档 |
| `w3` | off | off | 新分阶段（`--conclusion-routing intent --conclusion-budget-mode slot --conclusion-slot-cost 1.5 --conclusion-pairing require`） | 单档（本票主改动） |
| `w3legacy` | off | off | 旧档（`--conclusion-cards --small-to-big --conclusion-budget-mode additive --conclusion-max-extra 4`） | 旧档对照（§14 生产档） |
| `w1w3` | on | off | 新 | 组合 |
| `alls` | on | soft | 新 | 全开（软失效） |
| `allh` | on | hard | 新 | 全开（硬失效） |
| `w1w2h` / `w1w2s` / `w2hw3` / `w2sw3` | — | — | — | 其余两两/三三组合（`ARMS` 追加即跑） |

判定口径（`scripts/bench-factorial.mjs`）：`combo` 对 `singleBest`（单档里判对率最高者，**在共同判分题集上选**）做同题配对 bootstrap（10000 次）取 Δ 的 95%CI，**下界 > 0** 才判 `combination-wins`，否则 `keep-single`；
另跑 `--floor temporal=turnCov=0`（temporal 题型覆盖率不得低于基线）与证据充分性地板。

### 16.5 结果与判定

**主表（8 臂，n=90 同题配对，judge/作答 MiniMax-M3.1-Flash）**

| 臂 | W1 | W2 | W3 | 判对 | 拒答 | 注入 turnCov | 注入行 | 结论行 | 证据回捞行 | 证据充分性 |
|---|---|---|---|---|---|---|---|---|---|---|
| `b0`（负控） | off | off | off | 78.9% | 12.2% | 72.3% | 3.77 | 0 | 0 | 0.619 |
| `w1` | on | off | off | 77.8% | 13.3% | 76.7% | 3.93 | 0 | 0 | 0.620 |
| `w2h` | off | hard | off | 75.6% | 12.2% | 72.3% | 3.79 | 0 | 0 | 0.620 |
| `w2s` | off | soft | off | 78.9% | 14.4% | 72.3% | 3.79 | 0 | 0 | 0.618 |
| `w3`（本票新分阶段） | off | off | intent+slot+成对 | 80.0% | 12.2% | 77.8% | 3.86 | 40 | 40 | 0.628 |
| `w3legacy`（生产旧档） | off | off | additive×4 | **83.3%** | 13.3% | **86.1%** | 5.27 | 57 | 124 | 0.642 |
| `w1w3` | on | off | 新分阶段 | 81.1% | **7.8%** | 81.6% | 4.03 | 40 | 40 | 0.630 |
| `alls` | on | soft | 新分阶段 | 80.0% | 10.0% | 81.6% | 4.02 | 40 | 39 | 0.629 |

**分题型（判对% / 注入 turnCov%）**

| 题型 | b0 | w1 | w2h | w2s | w3 | w3legacy | w1w3 | alls |
|---|---|---|---|---|---|---|---|---|
| single-session-user | 100/93 | 100/96 | 93/93 | 100/93 | 93/89 | 100/96 | 93/96 | 100/96 |
| single-session-assistant | 87/80 | 87/80 | 87/80 | 87/80 | 87/80 | 87/80 | 87/80 | 87/80 |
| single-session-preference | 53/90 | 60/92 | 53/90 | 53/90 | 60/90 | 53/90 | **73/92** | 60/92 |
| multi-session | 67/53 | 67/67 | 67/53 | 67/53 | 60/60 | 67/79 | 53/69 | 60/69 |
| temporal-reasoning | 87/60 | 73/70 | 80/60 | 87/60 | **100/79** | 93/86 | **100/83** | 93/83 |
| knowledge-update | 80/57 | 80/54 | 73/57 | 80/57 | 80/68 | **100/86** | 80/68 | 80/68 |

**判定（`bench-factorial`，组合 vs 单档最好）**

- 单档最好 = `w3legacy` 83.3%；组合最好 = `w1w3` 81.1%；Δ = **−2.2pp**，95%CI [−10.0pp, +5.6pp]，p=0.77 → **`keep-single`**。
- 即：**本票的「分阶段」版本没有跑赢现行生产档**，按票面判定线（CI 下界 > 0 才算协同）不得上线组合。
- 分题型门禁：全部通过（temporal 在同口径下只升不降：w3 100%/79% vs b0 87%/60%）。

**为什么输了：三处差异与一个口径 bug**

跑完发现 `w3`/`w1w3`/`alls` 与 `w3legacy` **不是同一口径**——主表脚本里新分阶段臂没传 `--conclusion-max-extra`，
继承了沙箱库的 `smallToBig.maxExtraLines=2`，而 `w3legacy` 显式传了 4。
（#159 已给 `W3_NEW` 补齐 4，故本节这批读数是 2 的口径、与脚本现口径不再可比——见 §15.7 的说明；要引用请以重跑结果为准。）实测：`w3` 的 `gates.smallToBig.maxExtraLines=2`、每题证据行 0.44（40/90），
`w3legacy` 为 4、1.38（124/90）。证据行是**答案载体**（`byType['evidence-recall'].goldLines`：w3 21 行 / legacy 67 行），
这一项差异就足以解释 3.3pp 的判对差与 8pp 的覆盖率差——**不是「分阶段」本身的账**。

所以主表结论只能是「**现口径下**组合不成立」，不能当成「分阶段不行」。为把这条口径 bug 与真实机制效应分开，另跑消融（下一节）。

### 16.6 消融：隔离口径 bug 与机制效应

主表的口径 bug 提示：要判断「分阶段」有没有用，必须把**同一批旗标**下的差异拉平后再比。消融三臂（W1/W2 全关，只动 W3，**全部 `--conclusion-max-extra 4`**）：

| 臂 | 意图路由 | 预算模式 | 成对约束 | 判对 | 拒答 | 注入 turnCov | 注入行 | 结论行 | 证据行 |
|---|---|---|---|---|---|---|---|---|---|
| `w3legacy`（旧档） | 关 | additive×4 | 关 | **83.3%** | 13.3% | **86.1%** | 5.27 | 57 | 124 |
| `w3routeonly` | **开** | additive×4 | 关 | 81.1% | 10.0% | 83.4% | 4.38 | 40 | 54 |
| `w3x4` | 开 | slot(1.5) | 开 | 78.9% | 12.2% | 81.6% | 4.16 | 40 | 64 |
| `w1w3x4` | 开（+W1 事实通道） | slot(1.5) | 开 | 78.9% | **10.0%** | **85.5%** | 4.24 | 40 | 61 |

**读数**（n=90，配对 Δ 的 95%CI 都在 ±6pp 量级，2pp 级别差异**不显著**，只能读方向）：

1. **意图路由的净效应是「减结论」**：结论行 57 → 40，证据行 124 → 54，判对 83.3% → 81.1%。
   机制是链式的：结论预算收紧 → `work_fact` 卡变少 → 成对回捞的**候选卡**变少 → 证据行跟着掉。
   这恰好是票面根因 ② 的反面教训：**槽位不是唯一稀缺资源，「有卡可回捞」本身也是稀缺的**——先砍结论再谈回捞，回捞池子会一起萎缩。
2. **slot + 成对约束在路由之后又掉 2.2pp**，但证据行 54 → 64（成对确实把每张卡的证据补齐了）。
   判对没跟着涨，说明「多 10 行证据」在这批题上不构成答案增益（`evidenceSufficiency` 0.630 → 0.624 甚至略降）——证据行**选得对**比**选得多**更重要。
3. `w3legacy` 的证据行 124 行、每题 1.38 行，是全表最高的；它的高分主要来自**证据层**，不是结论层（结论行归因恒 0，已知缺口 §16.8-3）。

**回捞触发率**（票面要求的验证项）：`w3` 30/90 题（33%）有 `[上下文]` 行，但**在有结论卡的 38 题里是 30/38 = 79%**，
相比历史档（`w3b` 9/90 = 10%）已经把「回捞几乎不触发」修好；整体只有 33% 是因为意图预算把大量题的结论层直接归零（这是设计，不是故障）。

### 16.7 生产建议

综合 §16.5/§16.6，**本票不改变生产默认档**（§14 落地档：`smallToBig.budget=additive`、`maxExtraLines=4`、`relevanceRanked=true`、`conclusionLayer.routing=assistantRecall`、`rerank.enabled=true`）。
理由与逐轴处置：

| 轴 | 处置 | 依据 |
|---|---|---|
| **W1 事实通道** | **保持可选、不设默认**（`recall.factChannel.enabled=false`，需要时 `--fact-channel --fact-channel-read-only`） | 单开判对 −1.1pp（不显著）、注入 turnCov **+4.4pp 显著**（CI [+0.4, +9.0]）；它是**覆盖率工具**，不是判对工具 |
| **W2 效期** | **保留 soft，拒绝 hard** | `w2h` 判对 75.6%（−3.3pp vs b0）；`w2s` 78.9%（±0）。这正是票面根因 ①：`(subject,predicate)` 不是函数依赖键，硬过滤会误删多值属性的旧事件 → 只降权、不删除，机制**不关** |
| **W3 结论层** | **保留 additive×4 旧档**；新分阶段（intent/slot/成对/仲裁）**保留为 opt-in**，默认 `routing=off`、`budget=shared|additive`、`pairing=off` | 公平口径下 `w3x4` 78.9% < `w3legacy` 83.3%；组合最好 `w1w3x4` 78.9%，对 `w3legacy` Δ=−4.4pp、95%CI [−12.2, +3.3] → `keep-single` |
| **rerank** | **保持开启** | 全部 90 题档位都在 `--rerank-blend 0.9 --rerank-candidates 32 --rerank-doc-cap 192` 下跑；本票没有任何一格靠关 rerank 换分数（#135 已证明伤害来自 `candidates=12 / minScore=-2` 的过度剪枝，而非重排本身） |

**给后续迭代的三条硬教训**：

1. **在 `maxResults=5` 的固定预算下，slot 记账必然挤掉经验行，而经验行才是这批数据的答案载体**（证据 gold 行 124 vs 64）。
   所以本票测到的更多是「预算怎么分」而不是「机制如何协同」。要真正验证协同，必须先放开预算上限（`maxResults` 6/8）或引入**证据预留**（conclusion 的 1.5 槽里固定 1 槽归它的源证据，而不是从经验额度里扣）。
2. **覆盖率与判对是两条曲线**：`w1w3x4` 用 4.24 行注入拿到了 85.5% 覆盖（旧档 5.27 行 / 86.1%），但判对停在 78.9%。
   若要「省 token 保覆盖」，`w1w3x4` 是有前途的方向；若要「涨判对」，当前证据是**证据选得对**比**多**更重要（充分性 0.642 vs 0.629，方向一致但不显著）。
3. **n=90 的分辨率只有 ±6pp**：2pp 级别的机制差异在这一档上无论怎么跑都不可判。任何后续「分阶段协同」的结论都必须先上更大 n（LME500 级）再谈上线。

### 16.8 遗留

1. **仲裁无时效感知**（评审 #7）：`arbitrateConclusions` 只比内容，没有先按 recordId 剔除被 supersede 的**旧**经验行 —— 旧值行文字与结论更相似时会把最新结论挤掉。
   修法：先在经验层按 `recordId → validFrom/validTo` 剥掉已被取代的行，再做仲裁（依赖 #136 的时态字段读面）。
2. **分题型地板两套口径**（评审 #13）：`bench-gates --per-type-floor` 用**配对判对 Δ**，`bench-factorial --floor` 缺省 `metric=turnCov`。同一张表两个口径容易读出相反结论，应统一为「判对为主、覆盖率可显式指定」。
3. **结论行归因仍靠正文反查**（评审 #15）：`byType.conclusion.goldLines` 恒 0（结论行是摘要，反查不到 turn），`firstOrderDrop.conclusion` 近似恒 0。
   修法：用 `gates.conclusionRouting` + 结论卡 recordId 走 `part_of` 证据边，把结论行归因到它自己的证据 turn，而不是正文匹配。
4. **装配逻辑无单测**（评审 #16）：顺序（turn-first/first-conclusion）+ 裁剪（fts-only 帽、`applyRecallBudget`）+ counts 是这次最容易回归的一段，目前只有 hooks 集成测试覆盖。
   修法：抽 `resolveLayeredOrdering(pure)`，对「结论 >= 槽位」「fts 帽 < 结论数」「budget 溢出」三种边界各写一例。
5. **多重比较未校正**（评审 #11）：13 臂两两比较，`singleBest` 选优本身带选择偏差；判定线用单次 95%CI 下界 > 0 仍偏乐观。
   修法：对 combo 的 Δ 做 Bonferroni/或对 singleBest 的 argmax 做 bootstrap 校正（当前 `reasons` 已写明分母口径，属于**已知未修**）。
6. **assistant 侧结论卡**：结论层只蒸馏 user 侧事实（§14.7），`assistant-recall` 题型因此恒 0 结论 —— 双源蒸馏是 #156，本票只做到「不给它分配预算」。
7. **`pairing` 依赖 `part_of` 覆盖率**：生产 10.5%，回捞触发率上不去时成对约束会把 `work_fact` 结论大面积让位（`degraded` 只挡通道不可用，不挡「通道可用但边稀疏」）。#155 补边后需重测。
8. **slot 记账没有「证据预留」**（本轮实测最大的机制缺口）：`computeSlotBudget` 把 `conclusionCount × 1.5` 从 `maxResults` 里扣，剩余才给经验行——在 `maxResults=5` 下 2 张结论只剩 2 行经验，而经验行才是答案载体。
   修法：结论的 1.5 槽里**固定 1 槽归它自己的源证据**（从结论额度出，不占经验额度），或允许多行的结论按 `ceil` 而不是 `floor` 取整；改完必须重跑 §16.6 消融。
9. **只能在 n=90 上判方向**：本轮所有机制差异都在 ±6pp CI 内。要判「分阶段协同」必须上 LME500 级 n（约 5.5×题量、约 2 小时/臂），否则 `keep-single` 可能只是分辨率不足。

## 17. compare/fit 拆分与真配对 CI（issue #142，2026-10-28）

> **问题**：`fit-fusion-weights.mjs` 名字叫 fit，实际只做配对汇总，没有任何拟合；CI 用合并比例的 1.96·sqrt(p(1−p)/n) 近似（不按 case 配对，忽略题目难度方差）；跨 judge 的拒绝逻辑分散在三个工具里各写一套。票面要求：compare/fit 语义可分、CI 改为按 caseId 配对的 bootstrap、judge 不一致硬失败、用已落盘档位自检并出排名表。

### 17.1 交付

| 子项 | 落点 | 说明 |
|---|---|---|
| `compare` 子命令 | `scripts/fit-fusion-weights.mjs` | **只判定**：逐档输出 Δ、配对 bootstrap CI、legacy 近似 CI（并列展示）、McNemar、E2 门禁；无子命令时默认 compare（旧命令行不变） |
| `fit` 子命令 | 同上 + `scripts/lib/bench/fusion-fit.mjs` | **只拟合**：档位排名表、matched-design 单因子效应、坐标搜索、结构诊断、下一步采样计划；明确「报告没有候选级通道分，未跑组合不预测数值」 |
| 配对 bootstrap CI | `lib/bench/fusion-fit.mjs` `pairArm` | 按 caseId 配对 → 逐 case Δ 重采样 1000 次 → 2.5/97.5 分位；指标为 null 的 `_abs` 应拒答题**剔除**而不是按 0 计入（n=90→87） |
| legacy CI | 同上 `legacyCiHalfWidth` | 保留旧口径但只作对照行输出，门禁不再使用 |
| judge 硬校验 | `lib/bench/judge.mjs` `pairJudges` | compare 与 fit 一致：不可比档拒绝并 **exit 3**（各自并列展示检索指标 + 给修复路径；`--allow-cross-judge` 显式豁免，表内标「参考」）；retrieval-only 档放行 |
| 自检 | `--arm-dir .eval-data/bench` | 自动收同 manifest 的报告、按 tag 去重取最新，对已落盘 43 档跑排名/诊断/采样 |

### 17.2 compare 实跑（基线 b0base-mm，同 judge MiniMax-M3.1-Flash）

```text
$ node scripts/fit-fusion-weights.mjs compare --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json \
    --arm rfix-deep105=.eval-data/bench/longmemeval-oracle-2026-10-27T08-36-53.json

- arm turnCov@5=84.3%  base=67.1%  Δ=17.24pp
- 配对 bootstrap CI95=[7.66, 26.25]pp（87 个 case，按 case 重采样，1000 次，2.5/97.5 分位）
- 旧近似 CI95≈±7.64pp（legacy：合并比例方差，不按 case 配对；与上行之差即配对相关性的修正）
- ΔsessionCov=+7.19pp  Δmrr=+11.11pp  判对 45.6% → 82.2%（Δ=+36.67pp，McNemar p=0.0000）
- E2 门禁（Δ≥+3pp 且配对 CI 下界>0）: PASS
```

**与旧口径的差异**：旧文档写「+16.67pp」是把 3 道应拒答题的 null 指标按 0 计入的 90 题口径；配对口径剔除这 3 题后为 **+17.24pp / n=87**（差 0.57pp）。旧近似 CI ±7.64pp 比配对 CI [7.66, 26.25] 更窄——因为题目间难度方差占了大头，按 case 重采样把「同一题在两个档位同涨同落」的相关性算进去了。

### 17.3 fit 排名表（42 档 + 基线，节选）

`--arm-dir` 扫描目录时会跳过与 `--base` 同一文件的档位（自配对 Δ 恒 0，不进排名）；基线本身只出现在头部。

| 档位 | 旋钮 | turnCov@5 | Δpp | 配对 CI95 | legacy | 判对 |
| --- | --- | --- | --- | --- | --- | --- |
| rfix-deep105 | cand=32 floor=-10.5 fusion=weighted cK=32 | 84.3% | 17.24 | [7.66, 26.25] | ±7.64 | 82.2% |
| r138-add-x4-route | blend=0.9 fusion=normalized cK=32 | 83.9% | 16.86 | [9.39, 24.52] | ±7.71 | - |
| r137-allon-norerank | rerank=off cK=32 | 82.6% | 15.52 | [6.90, 24.14] | ±7.97 | 86.7% |
| r141-w1w3x4 | blend=0.9 cK=32 | 82.0% | 14.94 | [6.90, 22.61] | ±8.07 | 78.9% |
| r138-add-x4 | blend=0.9 fusion=normalized cK=32 | 81.6% | 14.56 | [6.51, 22.80] | ±8.13 | 84.4% |
| rfix-deep4 | cand=32 floor=-4 weighted cK=32 | 80.9% | 13.79 | [4.98, 22.61] | ±8.26 | 80.0% |
| b1off-mm | rerank=off | 79.5% | 12.45 | [4.02, 20.11] | ±8.48 | 77.8% |
| r135-allon | rerank=off weighted cK=32 | 79.9% | 12.84 | [3.83, 21.26] | ±8.42 | 72.2% |
| r2-wdef | fusion=weighted | 67.1% | 0.00 | [-3.45, 3.45] | ±9.87 | 44.4% |

### 17.4 matched design 单因子效应

只统计「除一个逻辑旋钮外其余旋钮全同」的档位对（n 小的时候只能当方向）：

| 旋钮 | 效应（matched） | 配对数 |
|---|---|---|
| rerank.enabled | off +9.14pp / on −9.14pp | 29 |
| rerank.blend | 0.9 +3.07pp | 4 |
| rerank.candidates | 12/32 均 0.00pp | 2 |
| rerank.minScore | −10.5 +3.45pp（n<2，仅供参考） | 1 |
| fusion | normalized +2.90pp；weighted +0.38 / 0.00pp；rrf −2.67pp | 56 |
| recall.candidateK | 32 +6.44pp | 15 |

### 17.5 结构诊断（`fit` 自动产出）

- **fusion-null-effect（warn）**：weighted 档 matched 最大 |Δ|=0.38pp（<1pp，56 对）→ 在 RRF 主序下加性权重是零效应，继续网格搜索权重没有信息量；应先把通道分放进**通道内打分**（`recall.fusion.mode="normalized"`，见 §16 / #137），再做权重拟合。normalized 档已有 **+2.90pp** matched 收益（n=49），说明结构改完后信号才可观测。
- **rerank-toggle-confounded（info）**：rerank=off 的 matched 平均 +9.14pp（29 对），但 on 的最好档 84.3% 高于 off 最好档 82.6%——off 的优势是「剪枝档位分布」的混杂（浅池 / negative floor 和 off 混在一起比），**不是重排本身**。因此`fit` 永不把 `rerank.enabled` 当作坐标移动，只列在 ignored 里。
- **best-observed**：矩阵内最优 = rfix-deep105（cand=32 / floor=−10.5 / weighted / cK=32），84.3%。

### 17.6 坐标搜索与下一步采样计划

坐标搜索只允许移动到「已观测 level」，并显式区分 **该组合是否观测过**（level 在别的结构里跑过 ≠ 组合跑过）：

| 旋钮 | 移动 | 预计 | 组合状态 |
|---|---|---|---|
| rerank.blend | 0 → 0.9 | +6.13pp（4 对） | **已重跑，证伪**（实测 −4.21pp，见 §17.9） |
| fusion | weighted → normalized(d0.5/b0.2/f0.3) | +2.52pp（56 对） | **已重跑，不支持**（α=0 下判对 −2.22pp，见 §17.9） |

采样计划（锚定 rfix-deep105，去重后 10 条）：blend 0.9/0.3/0.5、candidates 24/16、minScore −12/−8、candidateK 24/48、fusion normalized(d0.4/b0.3/f0.3)。**这些都必须重跑**——报告里没有候选级通道分，离线无法评估未跑组合。前两条已于 §17.9 重跑并被否定，其余 8 条按同节说明暂缓。

### 17.7 验收对照

| 票面验收 | 结果 |
|---|---|
| `--help` 里 compare/fit 语义可区分 | ✅ compare=只判定（Δ/CI/门禁）；fit=只拟合（排名/效应/诊断/采样）；并说明不预测未观测组合 |
| 同一对 JSON 的 bootstrap CI 与旧近似 CI 差异可见 | ✅ 每档两行并列（`配对 bootstrap CI95=…` / `旧近似 CI95≈±…`），并说明差值来自配对相关性 |
| judge 不一致非零退出并说明 | ✅ compare / fit 均 exit 3 并给修复路径（按 trial judge 对齐）；`--allow-cross-judge` 放行但标注仅参考 |
| 用已落盘档位自检 + 档位排名表 | ✅ 43 档排名表 + matched 效应 + 诊断 + 采样计划（本节） |

### 17.8 复现

```bash
cd MemoryCore
node scripts/fit-fusion-weights.mjs --help
# compare：单档判定（旧命令行兼容）
node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json \
  --arm rfix-deep105=.eval-data/bench/longmemeval-oracle-2026-10-27T08-36-53.json
# fit：全矩阵排名 + 诊断 + 采样计划
node scripts/fit-fusion-weights.mjs fit \
  --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json \
  --arm-dir .eval-data/bench
```


### 17.9 采样实测：两条排序预测均未复现（2026-10-29）

**设定**：复用 `lme90-fix-deep105` 库（`--store` + `--no-write-steps`，纯读侧、库内状态不变），当前分支代码（含 #137/#138/#141/#142），每条臂 90 题、生成与判分同用 MiniMax-M3.1-Flash、同 manifest。基线 `r142-deep105-base0` = deep105 配置（weighted d0.4/b0.3/r0.2/v0.1、candidates 32、minScore −10.5、blend 0）在当前代码上**重跑**——16:20 的 `rfix-deep105` 早于 #137 等读侧改动，直接拿它当基线会把「代码演进」算进旋钮效应。

| 臂 | 配置（其余同 deep105） | turnCov@5 | 判对 | ΔturnCov vs base0 [CI95] | Δ判对 | McNemar p |
|---|---|---|---|---|---|---|
| r142-deep105-base0 | weighted，blend 0（对照） | 83.2% | 82.2% | — | — | — |
| r142-deep105-blend09 | weighted，blend 0.9 | 79.0% | 76.7% | **−4.21pp** [−11.30, 2.30] | −5.56pp | 0.30 |
| r142-deep105-norm0 | normalized(d0.4/b0.3/r0.2/v0.1)，blend 0 | 85.1% | 80.0% | +1.92pp [−2.87, 6.90] | −2.22pp | 0.75 |
| r142-deep105-norm09 | normalized，blend 0.9 | 75.7% | 74.4% | **−7.51pp** [−14.98, −0.84] | −7.78pp | 0.14 |

配对 bootstrap 1000 次、按 case 重采样、seed=20261027；n=87（`_abs` 题无对错被剔除）。判分器一致，compare 不触发 exit 3。

**结论**

1. **blend 0 → 0.9 被证伪**：§17.6 预计 +6.13pp（仅 4 对样本），实测点估计 −4.21pp、CI 跨 0。α=0.9 的收益只在其原锚点成立（candidates 12 / minScore −2 / 锚点补位，见 §13.5）；把 α=0.9 移植到 candidates 32 / floor −10.5 的深池档反而丢掉精排对深池的排序能力。→ **深池档保持纯精排（blend 0）**，这不是「关掉精排」，是精排与融合序的混合比例按锚点定。
2. **normalized 在 α=0 下检索更准、判对没跟上**：turnCov +1.92pp（CI 跨 0）、MRR +2.31pp、nDCG 0.780→0.801，但判对 −2.22pp（n.s.）。§17.4 的 matched +2.90pp 是「判对」指标下的相关效应，不等于「换到深池档就 +2.9pp」；本次实测不支持把 normalized 作为默认档切换。证据质量（检索序）与答案正确性在本基准上并不同步——注入块变多变散会同时抬高 turnCov、压低判对。
3. **normalized + α=0.9 禁止组合**：−7.51pp，CI 上界 −0.84 已排除 0，两旋钮负向叠加显著。
4. **代码演进在本锚点中性**：同一 deep105 配置，16:20 档 turnCov 84.3% / 判对 82.2% → 当前代码 83.2% / 82.2%（ΔturnCov −1.1pp、判对不变）。后续 paired 比较请用 `r142-deep105-base0` 作基线，别再用 16:20 的报告。

**过程事故与修复（bench 纪律）**

- 生产 `MemoryCore/tdai-gateway.yaml` 在 #137-F 之后自带 `rerank.blend: 0.9`；bench 以生产 yaml 为底，**不显式传 `--rerank-blend` 就继承 0.9**。首跑的 `r142-deep105-norm` 因此实际是 normalized+α0.9（报告里 `effectiveConfig` 可查），不是纯 normalized；本表里它被改标为 `norm09`，纯 normalized 另跑 `norm0`。
- 修复落在 `MemoryCore/scripts/run-r142-sampling.sh`：每档显式钉 `--rerank-blend`，并带 `--expect-config recall.rerank.blend=…,recall.fusion.mode=…,recall.rerank.candidates=…,recall.rerank.minScore=…`——生效值与档名不符时在灌库前 exit 2，避免白跑一档。（该脚本已于 #164 删除 —— 纯历史 A/B 档、旗标不存在；要复跑直接抄本节的 `--…` 参数）
- 教训：生产 yaml 是 bench 的默认底层配置，「不传=旧档」的假设会在 yaml 改版后静默失效；**实验档要钉住将被解释的每一个旋钮**，报告只信 `effectiveConfig`，不信命令行。

**剩下 8 条采样项暂不跑**：blend 0.3/0.5、candidates 24/16、minScore −12/−8、candidateK 24/48。前两条排序预测都被证伪，且 n=90 的噪声带（±5pp 量级）大于这些项的拟合预计（多为 1–4 对样本给出的 +2~+6pp）；继续单点采样只会产出判不了的差值。要跑时沿用本脚本模式（`--store` 复用 + `--no-write-steps` + `--expect-config` 钉旋钮）。

**复现**

```bash
cd MemoryCore
bash scripts/run-r142-sampling.sh base0     # 对照：deep105 配置 + 当前代码 + blend 0
bash scripts/run-r142-sampling.sh norm0     # normalized + blend 0
node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/r142-deep105-base0.json \
  --arm r142-deep105-norm0=.eval-data/bench/r142-deep105-norm0.json
```

---

## 18. #143 E3 · 30 题人工抽检常态化（2026-10-29）

来源 #135 E3：把「系统 turnCov 涨了」翻译成「人看注入块够不够」。本节记录材料、机器预检口径、抽样时撞见的第二个根因，以及回填方式。判定部分在用户明示授权下由 AI 代理完成（2026-10-29，§18.4），口径一律记作「AI-vs-系统」，不冒充人工判定。

### 18.1 材料与工具

| 产物 | 路径 | 说明 |
|---|---|---|
| 抽样/汇总工具 | `MemoryCore/scripts/audit/r143-e3-review.mjs` | `build` 分层抽样出题 + 判定页；`summarize` 收判定 JSON 算一致率与分桶 |
| 交互判定页（入库） | `docs/superpowers/evals/e3-review-30/e3-review-30.html` | 单文件、无外链、判定存 localStorage；导出 JSON 交给 summarize |
| 抽样说明（入库） | `docs/superpowers/evals/e3-review-30/README.md` | 口径 + 复现命令 |
| 机器样本（不入库） | `MemoryCore/.eval-data/bench/e3-review-30.json` | 30 题全文 + 证据原文 + 机器预检，供复查 |
| 工作表（不入库） | `MemoryCore/.eval-data/bench/e3-human-sample-30.md` | 同内容的可打印版 |

样本对：`longmemeval-oracle-2026-10-27T05-45-51.json`（b0base，12 候选取 1 / minScore −2 / 精排开）→ `r142-deep105-base0.json`（深池档 32 候选 / blend 0 / 当前代码）。**这是票面许诺的那一对**；10-29 之后代码又有 #137/#138/#141/#142 的读侧改动，所以样本对代表「当时的错法 vs 现在的基线」，不代表今天逐行等价。

分层（互斥，A→B→E→C→D→F 优先）与本次入样：A 剪枝拒答 6｜B 判覆盖但未注入 8｜C 判缺口但已召回 10｜D 剪枝未拒答 3｜E 检索到但答错 2｜F 对照 1；池子分别 12/13/21/10/2/32。层内按「arm/base 答对翻转 > kept 差 > turnCov 差」排序，同层同题型最多 2 题，配额不足才顺延补——同一对报告 + 同一 `--sample` 必得同一批题。

### 18.2 机器预检口径（先看事实，再下判断）

判定页每题顶部给六件事，人只需要回答「这些证据够不够支撑回答」：

1. `系统判定`：`turnCov@5>=1` 记「足够」——**这是被检验的对象，不是答案**；
2. `kept`：精排后保留条数（区分「没召回」和「召回了被剪掉」）；
3. `注入行数`：真正进了 `<relevant-memories>` 的行数（装配后）；
4. 每条证据 turn 的四档可见性：已注入 / top-5 有但未注入 / 已召回但注入块文本未见（疑截断）/ 未召回；
5. `折叠嫌疑`：证据已召回却没进注入块，且与块内某行字符 bigram Jaccard ≥ 0.25（见 18.3）；
6. 归因提示：拒答过度 / 召回缺口 / 装配折叠 / 聚合精确数字 / 口径。

归因桶从三个扩到四个：**拒答过度**（kept≤1 剪空）、**召回缺口**（证据 turn 没进 retrieved）、**装配折叠**（召回了，被同会话近重折叠折成一行）、**聚合精确数字/跨会话**（证据齐了也可能算错）。

### 18.3 旁证根因：装配层「同会话近重折叠」把多轮证据折成一行

`MemoryCore/src/core/hooks/auto-recall.ts:138` 的 `foldNearDuplicates(lines, threshold = 0.25)` 先剥行首 tag（`type|session`）与行尾时间/soul 元数据，再比字符 bigram Jaccard，≥0.25 视为重复只留排序首条——设计意图是折叠「同一条记忆被写两遍」，校准语料是生产记忆行（重复组 0.36–0.49、非重复 ≤0.04）。

问题在于**同一场对话的多个 turn 本来就不是重复**：同一个 LME 会话是单主题多轮，任意两轮的内容 Jaccard 轻易过 0.25。实测把 `retrieved` 的 turn 文本按注入格式喂给该函数：

| case | 注入格式行数 | 折叠后 | 后果 |
|---|---|---|---|
| 66f24dbb | 3 | 1 | 金句「yellow dress…」被折掉 |
| 720133ac | 5 | 1 | 两条金句（$50 兽医 / $25 跳蚤）都丢 |
| gpt4_93f6379c | 4 | 1 | 4 轮讨论折成 1 轮 |
| 75832dbd | 4 | 1 | 4 个**不同研究主题**也折成 1 行 |
| c960da58 / 58bf7951 | 5 / 2 | 1 / 1 | 同上 |

含义：#138 说的「5 行窗口」（`maxExtraLines=4`）在单会话召回里实际是 **1 行窗口**；`kept=5` 只说明精排留了 5 条，装配完只剩 1 条。

全量 90 题交叉表（按「金句是否出现在注入块」分组；fold-suspect = 金句已召回但不在块内、且与块内行 Jaccard ≥0.25）：

| 报告 | ok（金句在块内） | fold 嫌疑 | 预算/其它 | 未召回 |
|---|---|---|---|---|
| b0base | 51 题 · 判对 60.8% · 拒答 23.5% | 15 题 · **判对 26.7%** · 拒答 53.3% | 5 题 · 20.0% · 60.0% | 16 题 · 12.5% · 81.3% |
| r142-deep105-base0 | 55 题 · 判对 90.9% · 拒答 5.5% | 22 题 · 72.7% · 13.6% | 3 题 · 66.7% · 0% | 7 题 · 42.9% · 42.9% |

反事实：若同会话 turn 不被折叠，金句可见题数从 51/87 → 71/87（58.6% → **81.6%**）b0base；深池档 55/87 → 80/87（63.2% → **92.0%**）。这解释了「rerank 一关就好」的一大部分——不是精排本身坏，而是**精排留的 5 条同会话证据在装配前被当成重复折成 1 条**，金句留不留在那一条全看排序运气。

所以 #135 §10 的「伤害来自剪枝」结论只对了一半：剪枝（12 候选 / minScore −2 / kept 1）确实存在，但 kept=5 的深池档同样大量丢金句，丢在 `foldNearDuplicates`。**修复方向不在关开关**：(a) 同会话免疫——同一 session 的行不做主题折叠，只跨会话折；(b) 判重改成 containment（一条是另一条的子集才算重复），主题相似不算。已开票 **#162** 并已落地；落地口径、第三道判据「同序覆盖」与全部实测量见 **§18.7**。本节保留的是当初的取证与反事实，不随修复改写。

### 18.4 人机一致率（2026-10-29 · AI 代理判定，用户授权）

判定页逐题选「足够 / 部分足够 / 不足 / 存疑」；判「不一致」时要求选归因桶 + 写一句话理由。汇总命令：

    cd MemoryCore
    node scripts/audit/r143-e3-review.mjs summarize --verdicts .eval-data/bench/e3-verdicts-ai-proxy.json

产物：`docs/superpowers/evals/e3-review-30/e3-review-summary.md`（+ 同名 `.json`），判定原件 `docs/superpowers/evals/e3-review-30/e3-verdicts-ai-proxy.json`。

**口径声明**：30 题判定由 AI 代理逐题完成——用户 2026-10-29 明示授权（原话「你自己判吧，你自己弄」）。所以下面的一致率是 **AI-vs-系统**，不是人工-vs-系统；若要做真人旁证，只需把另一份判定 JSON 传给 `summarize --verdicts` 重跑，同一脚本同一分母，可逐题对比两份判定，不需要重做抽样。

结果：

- 已判 **30/30**；一致 **22/30 = 73.3%**（非存疑口径，本次无存疑）
- 分歧 **8**：系统高报 6 · 系统低报 2
- 四桶归因：**装配折叠 6 · 召回缺口 2** · 拒答过度 0 · 聚合精确数字 0

分层一致率：

| 层 | 题意 | 题数 | 一致 | 不一致 | 一致率 |
|---|---|---|---|---|---|
| A | 剪枝拒答（kept≤1 且拒答） | 6 | 5 | 1 | 83.3% |
| B | 判覆盖但未注入（tc5=1 却没进块） | 8 | 2 | 6 | **25.0%** |
| C | 判缺口但已召回（tc5<1，retrieved 非空） | 10 | 9 | 1 | 90.0% |
| D | 剪枝未拒答 | 3 | 3 | 0 | 100% |
| E | 检索到但答错 | 2 | 2 | 0 | 100% |
| F | 对照 | 1 | 1 | 0 | 100% |

分歧逐条（`caseId` 为问题 id，可回 `e3-review-30.json` 查原文）：

| # | case | 题型 | 层 | 系统 | 人判 | 方向 | 桶 | 差在哪 |
|---|---|---|---|---|---|---|---|---|
| 2 | 4d6b87c8 | knowledge-update | A | 不足 | 足够 | 低报 | 召回缺口 | 块内已有「25 titles」记忆（另一轮派生），证据 turn 本身没召回 |
| 8 | 0e5e2d1a | single-session-assistant | B | 足够 | 不足 | 高报 | 装配折叠 | 「38 subjects」所在句已召回，块内只剩提问 |
| 9 | 1568498a | single-session-assistant | B | 足够 | 不足 | 高报 | 装配折叠 | 块内换成同会话另一句无关回复，`28. Kg3` 未注入（本行 2026-10-29 修正：纸面原写「jac 0.115，非阈值命中」有误——按 strip 口径重算，该题 4 条召回行的两两 jac 为 0.801 / 0.641 / 0.621，旧口径 4→2 折，是**确凿的阈值命中**，见 §18.7.2） |
| 10 | 58bf7951 | single-session-user | B | 足够 | 不足 | 高报 | 装配折叠 | 块内摘要只到「去看戏」，《The Glass Menagerie》被折掉 |
| 11 | 66f24dbb | single-session-user | B | 足够 | 不足 | 高报 | 装配折叠 | 块内只说「买了礼物」，yellow dress 没进块（jac 0.265） |
| 12 | 720133ac | multi-session | B | 足够 | 不足 | 高报 | 装配折叠 | 块内是助手免责声明，$50 问诊 + $25 跳蚤药都丢 |
| 14 | gpt4_93f6379c | temporal-reasoning | B | 足够 | 不足 | 高报 | 装配折叠 | 只剩 Marketing Professionals，Page Turners 被折掉，无法比先后 |
| 22 | 8e9d538c | single-session-user | C | 不足 | 足够 | 低报 | 召回缺口 | 块内直接含「17 skeins」且答对；另一轮助手复述没召回，覆盖率只算 0.5 |

三条结论：

1. **系统「判缺口」基本可信**（A/C/D/E/F 层合计 22/22 一致）：只要 `turnCov` 报不足，人工复核绝大多数情况下也认为不足——这些题确实缺证据，不是模型过度保守。
2. **系统「判覆盖」不可信**（B 层 8 题只对 2 题 = 25%）：`turnCov@5=1` 只证明金句 turn 进了 top-5，不证明金句进了模型看到的块。8 题里 6 题的分歧是「召回了却被装配丢掉」，且全部指向 §18.3 的同会话折叠/替换。
3. **修装配优先于调检索参数**：8 条分歧里 6 条落在装配折叠、0 条落在拒答过度、0 条落在聚合。这与「关 rerank」的直觉相反——深池档 kept=5 也照样丢金句，问题在折叠，见 #162。

### 18.5 常态化节奏（每次都这么办）

1. 任何召回/装配/精排改动落地后，挑一对报告（改动前基线与改动后），跑 `audit:e3:build` 出 30 题（该脚本会自己优先挑 kept=1、判缺口但已召回、折叠嫌疑、答错未拒答的题）；
2. 判 30 题（约 20–30 分钟），导出 JSON；判定主体须在票面注明是「人工」还是「AI 代理（含授权来源）」，两者不可混写；
3. 跑 `summarize`，把一致率、高报/低报拆分与四桶计数写进票面评论 + 本文件对应小节；同一分母下可叠加第二份判定做交叉；
4. 一致率 < 80% 时先读机器预检再谈算法：若分歧集中在「装配折叠/拒答过度」，问题在装配与剪枝；集中在「聚合精确数字」，问题在生成与多跳聚合；集中在「召回缺口」，才轮到检索参数。

### 18.6 未做的事（边界）

- 真人旁证（本次判定由 AI 代理完成；真人只要另出一份 JSON 重跑 `summarize` 即可对照，不必重抽样）；
- ~~`foldNearDuplicates` 的修复与回归~~ ✅ 已由 **#162** 完成（2026-10-29）：判据重写 + 9 条单测 + 90 题离线门槛 + 配对跑档，见 **§18.7**；
- #135 §10 的表格未按本节的折叠发现重算——那张表的口径（cov/judge/refuse）仍成立，但「伤害归因到剪枝」需要补一句「装配折叠同样致命」；该补正在 §18.7.5 兑现（§10 正文只加了指向本节的注记）。

---

## 18.7 #162 落地：装配层折叠判据重写（2026-10-29）

§18.3 的取证结论是「同会话多轮被当成近重折成 1 行」，票面 #162 的验收要求是**不靠关开关**把这个伤害修掉（dedup / rerank 的好处要留着）。本节记录落地口径、判据选型实测、离线门槛与配对跑档。

### 18.7.1 落地口径（三条判据）

落点全部在 `MemoryCore/src/core/hooks/auto-recall.ts`：选项 `:146`（`FoldNearDupOptions`）、函数 `:199`（`foldNearDuplicates`）、装配调用点 `:1919`、来源会话映射 `:1635-1641`。

| # | 判据 | 何时命中 | 为什么 |
|---|---|---|---|
| ① | **同会话免疫** | 两行 `session_id` 相等且都已知 → 只有剥元数据后**逐字相同**才折 | 同一场对话的多个 turn 是连续证据，共享话题是常态；按「主题相似」折会把多轮证据折成 1 行 |
| ② | **跨来源替代关系** | 逐字相同 → 折；containment ≥ 0.9（交集 bigram 数 ÷ 较短行 bigram 数）→ 折 | 只有「一条已被另一条覆盖」才算重复；主题相近但不互相覆盖的不算 |
| ③ | **同序覆盖**（本轮新增） | 被覆盖行（bigram 少者）的 bigram 序列在覆盖行里**按序**命中 ≥ 0.9（贪心子序列 + 位置二分，近似子串） | 短文本仅共享话题词就能把 bigram containment 顶到 0.90+（见 18.7.2），必须要求「像子串」而不是「词都在」 |

缺省（不传参 / 传数字）**保持 A2 历史口径**（Jaccard ≥ threshold），外部调用方与回归对照逐位不变；生产调用点显式传 options。行首 tag 与行尾时间/soul 元数据的剥离沿用 `stripMemoryLineMeta`，不新增第二份实现。

会话透传链路（此前 searchResult 里没有来源信息，免疫无从判定）：`FormatableMemory.sessionId` ← `vectorResultToFormatable` / `ftsResultToFormatable`；`SearchResult.metas[].sessionId` + 新增 `SearchResult.lineSessions`；`searchByKeyword` / `searchByEmbedding` 返回 `{ lines, lineSessions }`；native hybrid 与 fallback 分支按「折叠是否开启」决定是否透传（折叠开启时降级为无来源口径，避免行号与折后行错配）；`applyRecallRerank` 在重排后同步重映射 `lineSessions`（`:829`）；装配点建「行 → 会话」Map 后传入（`:1635`）。

单测：`MemoryCore/src/core/hooks/__tests__/recall-fold-near-dup.test.ts`（9 例：同会话两轮不折 / 同会话逐字折 / 跨会话包含折 / 主题相近不折 / containment 高但顺序打乱不折 / legacy 数字口径仍折 / 无来源降级 / 缺省=legacy / session_id 透传且不进注入文本）。

### 18.7.2 判据选型实测（同 90 题、同 retrieved 集，只换折叠判据）

口径：`r142-deep105-base0.json` 的 90 题 `retrieved` 逐 record 还原 turn 文本（`- [episodic|bench] <内容>`），session = `caseId#s{si}`；金句 = haystack 里 `has_answer` 且被召回的 turn（108 条）；「可见」= 金句前 48 字仍出现在折叠后某行。复现脚本：`MemoryCore/.eval-data/bench/_probe-162-arms.mjs`（不入库）。

| 判据 | 金句可见 | 折叠行数（90 题合计） |
|---|---|---|
| A2 现行：Jaccard ≥ 0.25 | 62 / 108 | 154 |
| 免疫 + 逐字 + containment ≥ 0.9（无同序） | **107 / 108** | 3 |
| 免疫 + 逐字 + containment + 同序覆盖 ≥ 0.9（**落地口径**） | **108 / 108** | 0 |

第二行丢掉的那 1 条是 `gpt4_b4a80587`：金句「I'm looking for some tips on editing photos of landscapes…」被另一会话的「Portrait photography is a great genre…」折掉——两句共享摄影话题词，bigram containment = 0.904，但说的不是同一件事。同序覆盖把这条挡回来（该对同序覆盖率 0.22 / 0.33）；而「一条确实被另一条覆盖」的典型（短句 ⊂ 长句）同序覆盖率为 1.0，不受影响。

**1568498a 的纸面修正**（§18.4 第 9 行原文写「jac 0.115，非阈值命中」）：按 strip 口径重算，该题 4 条召回行的两两 jaccard 为 0.801 / 0.641 / 0.621，旧口径 4→2 折——这题是**确凿的阈值命中**，属于本票根因，不是「非阈值命中」。上一处误记的原因是最初只比了「金句行 vs 块内剩余行」，而真正被折掉的是两条共享棋谱的相邻回复。

### 18.7.3 离线门槛：抽检案例逐题对照

同口径（旧口径 = 传 0.25；新口径 = 生产调用 options）：

| case | 会话数 | 召回行 | 旧口径折后 | 新口径折后 | 金句可见（旧 → 新） |
|---|---|---|---|---|---|
| 720133ac | 2 | 3 | 1 | 3 | 0/2 → **2/2** |
| gpt4_93f6379c | 2 | 4 | 1 | 4 | 0/2 → **2/2** |
| 4d6b87c8 | 2 | 4 | 1 | 4 | 0/2 → **2/2** |
| 58bf7951 | 1 | 4 | 1 | 4 | 0/1 → **1/1** |
| 8e9d538c | 1 | 3 | 2 | 3 | 1/2 → **2/2** |
| c960da58 | 1 | 2 | 1 | 2 | 1/1 → 1/1 |
| 0e5e2d1a | 1 | 2 | 2 | 2 | 1/1 → 1/1 |
| 66f24dbb | 1 | 4 | 1 | 4 | 该题召回行无 has_answer 标记，按行数对照 |
| 75832dbd | 1 | 3 | 1 | 3 | 同上 |
| 1568498a | 1 | 4 | 2 | 4 | 同上 |

「折 154 行 → 折 0 行」不等于关掉去重：① 逐字相同的重复召回仍折（同会话/跨会话都折，单测覆盖）；② bench 这 90 题的召回集里本来就没有「同一条记忆被重复召回」的样本，所以这一档的 0 是语料属性，不是能力丢失。生产环境的重复写/重复召回走的是逐字路径，行为不变。

### 18.7.4 配对跑档（同 judge / 同 manifest / 同库）

配对命令与基线完全一致（`scripts/run-r142-sampling.sh` 的 `base0` 档：`--b1 --candidate-k 32 --present-temporal --recall-ks 1,3,5,10 --no-write-steps --rerank-candidates 32 --rerank-minscore -10.5 --rerank-blend 0 --fusion <weighted α0>`，`--expect-config` 守卫通过），库 = `lme90-r142-deep105-base0` 的副本（`--no-write-steps`），报告 `r162-fold2.json`。（脚本已删、`--rerank-blend` 也已移除，参数仅作口径记录；复现需 checkout 8168e1a）

可控性核对：基线 `repoCommit=90416ec`，本次 `HEAD=966e514`，两者之间 `git diff --stat -- MemoryCore/src` 为空（只动了 `scripts/run-r142-sampling.sh` 与 `scripts/audit/r143-e3-review.mjs`），所以运行时唯一差异就是本票对 `auto-recall.ts` 的改动。

| 指标 | 基线 r142-deep105-base0 | 本票 r162-fold2 | Δ |
|---|---|---|---|
| sessionCov@5 | 93.37% | 93.37% | 0 |
| turnCov@5 | 83.18% | 83.75% | +0.58pp（单题 b3c15d39 0.5→1） |
| MRR | 0.7796 | 0.7796 | 0（检索侧零回归） |
| nDCG@5 | 0.7799 | 0.7833 | +0.34pp |
| **生产 injector 注入行**（`block` 里 `- [` 行，90 题合计） | **95**（1.06/题） | **264**（2.93/题） | **2.8×** |
| 生产 injector 块字符（90 题合计） | 88,006 | 286,231 | 3.3× |
| **金句出现在注入块**（138 条 has_answer 轮） | **57（41.3%）** | **109（79.0%）** | **+52 条（+37.7pp）** |

判分侧本轮拿不到数：arm 的 90 题里 83 题答案调用返回 `LLM HTTP 402 insufficient balance`、1 题 `429`，判分 0 题 → `genCorrect=null`（基线 82.2% 不可比）。这是 MiniMax 账户余额/配额问题，与代码无关；配额恢复后用同一条命令重跑即可得到配对判分，不需要改任何旗标。

**口径提醒（重要，避免误读上表）**：bench 的 `turnCov@5` / `injectedLines` 量的是 **b1 作答块**（`scripts/lib/bench/metrics.mjs:91` `turnCov` 与 `:113` `injectedLines` 都基于 `hits`），而本票修的是**生产 injector**（auto-recall 拼的 `<relevant-memories>`，报告里对应 `block` / `blockChars`，脚本内也有注释「两套渲染路不可混读」）。所以：本票效果必须读 `block` 那两行（行数 1.06→2.93、金句 41.3%→79.0%），`turnCov@5` 几乎不动是**预期**，既不能拿它证明也不能拿它否证本修复。要端到端验证判分，得先有一个「用生产 injector 作答」的档（当前 bench 的作答 prompt 走 b1），否则判分只反映 b1 路。

### 18.7.5 与 §10 归因的关系

§10.3 的「伤害来自剪枝」只有在**装配口径已修**之后才能当作纯剪枝效应读；在那之前，rerank 保留 5 行仍会被折叠成 1–2 行，所以「关 rerank → 变好」里混着「绕过折叠」的成分。§10.3 已加归因补正注记指向本节；§10.3 的表格数字本身不重算（口径是 cov/judge/refuse，仍然成立）。

### 18.7.6 回归核对：#141 生产锚点（additive×4）与 #138 生产口径（2026-10-29）

判据放宽只应改变「折掉多少行」，不应扰动已经定档的结论层预算归属与回捞触发。两档回归都不需要 LLM（与 judge 配额无关），跑的就是生产 recall 链路。

**① #141 生产锚点臂 `w3legacy`（W3 = 结论层 + additive×4，bench 里的生产锚点）**

命令 = `scripts/run-r141-factorial.sh` 的 `W3_LEGACY` 全旗标（`--conclusion-cards --small-to-big --conclusion-budget-mode additive --conclusion-max-extra 4` + `W1_OFF`/`W2_OFF`）再加 `--gen-limit 0`（只测检索，不烧配额），库 = `lme90-r141-w3legacy` 的 `cp -r` 副本（判据改动不写库，副本只是避免并发争用），报告 `r162-w3legacy.json`。

| 指标 | 改前 `r141-w3legacy` | 改后 `r162-w3legacy` | 判读 |
|---|---|---|---|
| turnCovInjected | 0.8605 | 0.8605 | **逐位相同**（注入口径覆盖率零变化） |
| sessionCov / sessionCovInjected | 0.9304 / 0.9470 | 0.9304 / 0.9470 | 逐位相同 |
| turnCov（检索侧） | 0.8184 | 0.8299 | +1.15pp，重排噪声（同库同旗标两次跑不保证逐位：float/onnx） |
| MRR@5 / nDCG@5 | 0.8028 / 0.8570 | 0.8056 / 0.8666 | +0.003 / +0.010，同属噪声量级 |
| injectedLines（b1 作答块） | 5.267 | 5.278 | 不变 |
| blockChars（生产 injector 块） | 1233 | 2906 | **2.4×——判据放宽的预期效果**（同会话多轮不再被折成 1 行） |

判分未跑（`--gen-limit 0`）：#141 记录的 `w3legacy` 83.3% 既没被复测也没被推翻，本节的结论只限「检索/装配口径无回归」。

**② #138 生产口径（100 条真实 journal query × maxExtraLines ∈ {2,4,6}，离线重放）**

命令 = `node --import tsx scripts/audit/r138-prod-replay-sweep.mjs --queries 100 --arms 2,4,6`（生产 `vectors.db` 副本、只读、零外呼），报告 `r162-r138-replay.json`；基线为同脚本 2026-10-28 的 `r138-prod-replay.json`（同一批 100 条 query，按 sha1 确定性抽样）。

| maxExtraLines | 结论层命中率 | 结论行/题 | 上下文行/题 | 经验行/题 | 总行/题 | 经验≤1 行率 | 回捞可触发率 | 精排 kept≤1 | 延迟 P50/P95 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| 2 · 改前 → 改后 | 58% → 58% | 2.21 → 2.21 | 0.26 → 0.26 | 0.10 → 0.11 | 2.57 → 2.58 | 98% → 98% | 13% → 13% | 0% → 0% | 602/2921 → 677/3059 |
| 4 · 改前 → 改后 | 58% → 58% | 2.23 → 2.21 | 0.41 → 0.41 | 0.10 → 0.11 | 2.74 → 2.73 | 98% → 98% | 13% → 13% | 0% → 0% | 648/3076 → 947/2761 |
| 6 · 改前 → 改后 | 58% → 58% | 2.23 → 2.21 | 0.42 → 0.42 | 0.10 → 0.11 | 2.75 → 2.74 | 98% → 98% | 13% → 13% | 0% → 0% | 1636/3293 → 1258/3167 |

结论行 −0.02 行/题、经验行 +0.01 行/题、总行 ±0.01，其余比率全部逐位相同——**折叠判据重写没有扰动 #138 定档的结论层预算归属与回捞触发**。延迟三档互有升降（P50 602→677 / 648→947 / 1636→1258），属机器负载噪声，不与本改动做因果绑定。

**为什么这两个回归能说明问题**：该脚本量的是 recall 层 `memoryLines` 的行构成（结论行/上下文行/经验行），折叠加在**生产 injector**（`row.block`）上；也就是说「这里不变」正是要的结论——判据只在渲染前丢不丢重复行，不动检索、预算归属与回捞。

**仍未完成（外部阻塞）**：§18.7.4 的配对判分。MiniMax-M3.1-Flash 当前返回 `HTTP 402 insufficient_balance_error`（Token Plan 用量上限），作答与判分都跑不了；配额恢复后用 §18.7.4 那条命令原样重跑即可，无需改旗标、无需重建库。

**票的处理（2026-10-29）**：#162 由维护者决定**带 caveat 关闭**——代码/单测/文档/两条回归/PR 全部落地，唯独「判对上升、拒答率下降」这一格没有数。读本节时请按这个边界理解：**折叠是主因**有离线门槛（金句 62→108/108、折行 154→0）与十题抽检独立佐证；**端到端判对**尚未验证。补跑不重开票，命令见上（`scripts/run-r142-sampling.sh base0`，对 `r142-deep105-base0` 配对）。


## 19. #144 rerank filter 的 floor 校准：绝对门槛不可校准，改用题内相对尺子（2026-10-29）

票 #144 要的是给 `filter` 档（只丢低分行、保留原序）校准 `minScore`，并回答「生产到底开不开、开多少」。维护者同时定了硬约束：**不许靠关掉 rerank 取胜**——rerank 本身有好处，要修的是「用法/算法导致误杀」这一层。本节先证明「全局绝对分阈值不可校准」，再给出落地的替代机制（题内相对尺子）、单测、实跑配对与生产取值。

### 19.1 先确认问题在哪：现网 minScore 等于不筛

instrumented 档（`RERANK_SCORE_DUMP` 转储每题全候选原始分）显示：90 题共 997 个候选，分数全部落在 **[−10.18, +10.28]**，而生产默认 `minScore = −10.5` 在这个区间左侧 —— **filter 档在生产里实际一条都没滤掉**，它只是「保序的 no-op」。所以 §10.3 / #135 看到的「filter 档变差」并不是 floor 设错，而是上游 `candidates = 12` 把候选池剪太小；floor 只有收到 **−9 以上**才开始产生行为差异。

### 19.2 取样口径（可复现）

| 项 | 值 |
|---|---|
| 转储 | `MemoryCore/.eval-data/bench/lme90-r144-instr-rerank-scores.jsonl`（90 行/每题一行，含全候选分数、原始行文本、`final` 选择结果） |
| 结果对齐 | 同一次 run 的 `lme90-r144-instr.json`（配对必须同一次 run：同配置重跑 turn_cov 曾差 2.3pp） |
| 行→turn 反查 | 复刻 bench 口径：`stripMemoryLineMeta` + `[<ts>] <speaker>: <text>` 归一后查 contentIndex，**解析率 100.0%（997/997）** |
| gold / 噪声 | gold = `has_answer` 且落在该题候选池内的 turn（**133 行**）；噪声 = 池内非 gold（**864 行**） |
| 分析脚本 | `MemoryCore/scripts/analyze-r144-rerank-floor.mjs`（离线、零外呼） |

⚠ **模拟器边界**：它只重放「选择」，不重放 #162 的装配折叠，注入行数按结构行占位（`injectedLines − retrieved.length`）补齐。因此**绝对值偏高**（不筛基线模拟 86.4% vs 实跑 79.3%），**只用于同口径相对比较**；绝对判读一律看 §19.8 的实跑。

### 19.3 分数有判别力，但「题间量纲」不一致（核心结论）

- **AUC = 0.836**（gold 133 行 vs 噪声 864 行）——分数排序本身有效，这正是 rerank 应保留的证据。
- 但两个分布大幅重叠：gold 中位 **0.115**（p25 −2.780）、噪声中位 **−6.302**（p25 −8.806）。
- 而**题内分差**（top1 − bottom）中位 **11.115**（p10 3.546 / p90 15.787）—— 不同题的整体分数平移可达 10 logit 量级。

一个全局绝对门槛因此只能变成「按题目难度随机砍」：低分题整题被砍、高分题一条不砍。**这就是「绝对 floor 不可校准」的量化表述**，也是本节改用题内相对尺子的理由（换 provider / 换语料后仍然成立）。

### 19.4 floor 曲线（filter 语义：保原序，只剔除低于门槛的行）

| floor | kept 比例 | 误滤 gold | 误滤 gold 题数 | 丢弃噪声行 | turnCov@5 |
|---|---|---|---|---|---|
| −20 / −14 / −12 / **−10.5** | 42.4% | 14.3%（19/133） | 16/87 | 548 | 86.4% |
| −9 | 39.9% | 14.3%（19/133） | 16/87 | 565 | 85.9% |
| −8.5 | 39.1% | 15.0%（20/133） | 17/87 | 572 | 84.7% |
| −7.5 | 37.9% | 15.0%（20/133） | 17/87 | 584 | 84.7% |
| **−7** | 37.2% | 15.8%（21/133） | 17/87 | 590 | 84.1% |
| −6 | 35.5% | 16.5%（22/133） | 18/87 | 606 | 83.6% |
| −5 | 32.0% | 17.3%（23/133） | 20/87 | 640 | 80.9% |
| −4 | 29.2% | 18.8%（25/133） | 21/87 | 665 | 78.0% |
| −3 | 25.0% | 26.3%（35/133） | 26/87 | 697 | 73.0% |
| −2 | 21.5% | 33.1%（44/133） | 32/87 | 723 | 66.5% |
| −1 | 18.1% | 40.6%（54/133） | 39/87 | 747 | 60.0% |
| 0 | 14.5% | 47.4%（63/133） | 46/87 | 773 | 53.8% |

读法：**−10.5 / −12 / −14 / −20 四档逐位相同**（=不筛，印证 §19.1）；真正开始「丢噪声」要到 −8.5，而同一区间 gold 误滤同步从 14.3% → 15.0% → 15.8%，turnCov 也从 86.4% 单调跌到 84.1%。**绝对 floor 的收益区不存在**：它没有「先丢噪声、后伤 gold」的平台段。

> **口径说明（重要）**：本表的 turnCov 是**离线模拟**（用当次实跑转储的候选分数重放 filter，结构行按注入行数占位），不是 bench 实跑值。模拟器缺 #162 折叠，且 `--present-temporal` 下的时间相关打分不完全可重放，所以**绝对值整体偏高 ≈4–5pp**（例：floor −7 模拟 84.1% vs 实跑 80.5%；floor −8.5 模拟 84.7% vs 实跑 79.9%）。**本表只用于同表内的相对比较**（哪档更少误杀 gold），绝对值以 §19.8 的实跑为准。

### 19.5 sigmoid 概率阈值（与 floor 单调等价，无新信息）

| 阈值 | kept 比例 | 误滤 gold | 丢弃噪声行 | turnCov@5 |
|---|---|---|---|---|
| p=0.1（logit −2.20） | 21.6% | 32.3%（43/133） | 723 | 66.9% |
| p=0.2（logit −1.39） | 19.6% | 38.3%（51/133） | 735 | 61.3% |
| p=0.3（logit −0.85） | 17.1% | 42.9%（57/133） | 754 | 57.9% |
| p=0.5（logit 0.00） | 14.5% | 47.4%（63/133） | 773 | 53.8% |
| p=0.7（logit 0.85） | 11.8% | 57.9%（77/133） | 785 | 42.5% |

概率只是 floor 的单调变换，**换标度不解决量纲问题**：p=0.1 就误杀 32.3% 的 gold。票面要求的「评估概率阈值」一项，结论是**不推荐**把 filter 建在 sigmoid 上。

### 19.6 题内相对尺子（本轮落地的机制）

A. 相对 top-1 的 margin（保留 `score ≥ top1 − margin`）：

| margin | kept 比例 | 误滤 gold | 误滤 gold 题数 | 丢弃噪声行 | turnCov@5 |
|---|---|---|---|---|---|
| top-2 | 18.9% | 30.1%（40/133） | 31/87 | 760 | 73.0% |
| top-3 | 23.3% | 26.3%（35/133） | 27/87 | 721 | 75.3% |
| top-4 | 27.0% | 21.1%（28/133） | 23/87 | 691 | 80.5% |
| top-5 | 29.8% | 18.0%（24/133） | 19/87 | 668 | 83.4% |
| top-6 | 31.7% | 16.5%（22/133） | 17/87 | 651 | 85.7% |
| **top-8** | 37.0% | **10.5%（14/133）** | 12/87 | 606 | **88.9%** |

B. 按题内分位裁剪（保留分数序前 `keepRatio`）：

| 分位 | kept 比例 | 误滤 gold | 误滤 gold 题数 | 丢弃噪声行 | turnCov@5 |
|---|---|---|---|---|---|
| top 25% | 27.3% | 18.0%（24/133） | 19/87 | 689 | 83.2% |
| top 33% | 31.8% | 14.3%（19/133） | 14/87 | 650 | 86.2% |
| **top 50%** | 37.4% | **12.8%（17/133）** | 13/87 | 598 | **87.4%** |
| top 75% | 41.5% | 13.5%（18/133） | 16/87 | 558 | 87.8% |
| top 100% | 42.4% | 14.3%（19/133） | 16/87 | 548 | 86.4% |

同 kept 比例对比（这是本节的关键读数）：

| 保留比例 | 规则 | 误滤 gold | turnCov@5 |
|---|---|---|---|
| ≈37% | floor −7（绝对） | 15.8%（21/133） | 84.1% |
| ≈37% | margin top-8（题内） | **10.5%（14/133）** | **88.9%** |
| ≈37% | quantile 50%（题内） | **12.8%（17/133）** | **87.4%** |

**题内尺子在「剪掉同样多的行」时少误杀 3–5pp 的 gold，并且 turnCov 高于不筛基线（86.4%）**——因为 filter 保原序，只改「保留谁」不改「先后」，把低分噪声挤出去反而让前 5 位的构成更干净。

### 19.7 落地（改机制，不是关开关）

`MemoryCore/src/config.ts`（`RecallRerankConfig`）新增三项，缺省即旧行为：

| 键 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `recall.rerank.filterRule` | `"floor" | "margin" | "quantile"` | `"floor"` | filter 档用哪把尺子；`floor` 与旧版逐位等价 |
| `recall.rerank.filterMarginTop` | number > 0 | `8` | margin 尺子的窗口（logit 单位） |
| `recall.rerank.filterKeepRatio` | (0,1] | `0.5` | quantile 尺子的保留比例 |

`MemoryCore/src/core/recall/rerank/filter-ruler.ts`（新增，**唯一实现**，ADR-0013）：`relativeKeepIdxSet()` 只算「谁过线」（返回下标集合，不排序——保原序是 filter 语义）；`normalizeRerankFilterRuler()` 统一归一（非法 rule → `floor`、marginTop 非有限或 ≤0 → 8、keepRatio ≤0 → 0.5 且 >1 clamp 到 1）；`filterRulerGateObs()` 只投影当前生效尺子的参数。

`MemoryCore/src/core/hooks/auto-recall.ts`：选择块按 `filterRule` 分流，`margin`/`quantile` 档**完全不看 `minScore`**（两把尺子不互相盖，避免「绝对门槛先把候选砍光、相对尺子无从工作」）；`RerankWiring` 三处（off / unavailable / active）都带 `filterRuler`，非法值静默回落。观测面：`gates.rerank` 增 `filterRule` + 对应参数 + `passCount`（规则裁量后、预算 cap 之前的条数；与 `kept` 的差 = 被预算截掉的量）；`RERANK_SCORE_DUMP` 同步落这些键，事后可归因。`RecallJournalRerankGate`（`recall-journal.ts`）同步补字段。

单测：`MemoryCore/src/core/recall/rerank/__tests__/filter-ruler.test.ts`（7 例：三键归一、gate 投影三形态、margin 并列临界、quantile ceil/下限 1/空池、Set 与原序的关系）+ `MemoryCore/src/core/hooks/__tests__/auto-recall-rerank.test.ts` 的 #144 五例（转储两例；① margin 配 `minScore: 2` 仍只按相对窗口保留且 `degraded` 不出现；② quantile 分数与原序错位时按分数选、按原序出；③ 非法 rule/越界 ratio 回落 floor；④ provider 截断漏排时未评分行无条件保留且 `passCount` 如实记录；⑤ margin 临界并列保留）。**33 tests 全过**。

### 19.8 实跑配对（同库 / 同旗标，只换尺子）

90 题、`--b1 --candidate-k 32 --present-temporal --no-write-steps --rerank-candidates 32`、库 = `lme90-r144-instr`（`--no-write-steps`，只读）。基线为「候选全放行」（`minScore −1e9`，等价于不筛）。

每臂各跑**两次**（同库、同旗标、同 manifest；第二次即噪声对照）：

| 臂 | 尺子 | 注入行/题 | turn_cov@k（两次） | session_cov（两次） | MRR（两次） | nDCG（两次） | kept 均值 | 整题降级 |
|---|---|---|---|---|---|---|---|---|
| 基线（不筛） | — | 3.58 | 79.3% / 79.9% | 92.5% / 93.0% | 0.735 / 0.735 | 0.737 / 0.740 | 4.70 | 0 |
| `lme90-r144-floor7` | floor −7 | 3.46 | 80.5% / — | 93.0% / — | 0.733 / — | 0.738 / — | 4.29 | **4/90** |
| `lme90-r144-floor85` | floor −8.5 | 3.46 | 79.9% / — | 92.5% / — | 0.737 / — | 0.739 / — | 4.35 | 0 |
| `lme90-r144-q50(-r2)` | quantile 0.5 | 3.20 / 3.27 | **81.1% / 81.6%** | **94.0% / 94.0%** | 0.741 / 0.747 | 0.742 / 0.749 | 4.12 | 0 |
| `lme90-r144-m8(-r2)` | margin 8 | 2.93 / 2.98 | 79.9% / 79.9% | 92.3% / 92.3% | **0.776 / 0.770** | **0.767 / 0.762** | 4.11 | 0 |

（原始报告：`MemoryCore/.eval-data/bench/lme90-r144-{instr,base-r2,floor7,floor85,q50,q50-r2,m8,m8-r2}.json`；`--no-write-steps` 只读同一库。floor −8.5 是票面点名要的档，补跑后与模拟 84.7% 差 4.8pp——再次印证 §19.4 的口径说明，且实跑上它与不筛（79.3%/79.9%）无差别。）

判读（严格，按"两次跑之间差多少"划线）：

1. **基线自身的重复跑差异 = 0.6pp turn_cov / 0.5pp session_cov / MRR 0 / nDCG 0.3pp**，这就是本口径的噪声带。
2. **quantile 0.5 在两次跑里都高于基线**（81.1% / 81.6% vs 79.3% / 79.9%），session_cov 也稳定高 1.0–1.5pp、MRR/nDCG 同向更高，注入行少 0.3–0.4 行/题 → **是可复现的小幅正收益**，不是噪声。原因与 §19.6 一致：保序剔除把低分噪声挤出前 5 位，gold 相对上移。
3. **margin 8 的 turn_cov 与基线打平**（79.9% 两次逐位相同；因为它的截断点在题内相对位置，几乎不受 recency 加分漂移影响），**但 MRR 0.735→0.776/0.770、nDCG 0.737→0.767/0.762，且注入行最少（2.93 vs 3.58，块字符 274k vs 336k）** —— 它在"保留的先后"上更干净，代价是行数更少。
4. **floor −7 出现 4/90 题整题降级**（全部候选都低于门槛 → 回落原序），相对尺子恒 0 —— 这是「绝对门槛会在换 provider / 换语料后整题失灵」的实跑侧证据；同一个 provider 上它还比基线多丢 3 行/10 题。
5. **延迟不作结论**：同一档两次跑的 mean 在 1661–3045ms 之间跳（机器负载），基线自己也从 2772ms跳到 1821ms；只能读"注入行/块字符"这个确定性指标（margin 8 最省）。

### 19.9 生产建议（明确到数值）

1. **默认保持 #145 定档**：rerank 开 + `candidates: 32` + `minScore: −10.5`（= 不筛，安全的 no-op）。**绝不要**把 `minScore` 收到 −2 / −4：§19.4 的 21.5% / 29.2% 误滤就是 #135 里判对率掉到 45.6% 的来源。
2. **要真正「丢噪声」时走相对尺子**：`mode: "filter"` + `filterRule: "quantile"` + `filterKeepRatio: 0.5`（首选：两次实跑 turn_cov 81.1% / 81.6%、session_cov 94.0%，均高于基线）；或 `filterRule: "margin"` + `filterMarginTop: 8`（次选：MRR 0.735→0.776/0.770、nDCG 0.737→0.767/0.762、注入行最少 2.93/题，代价是 turn_cov 与基线打平）。**禁止**在生产把 `filterRule` 设 `floor` 且 `minScore > −9`。
3. **监控**：看 `gates.rerank.filterRule` / `passCount` / `kept` 三个数——相对尺子下 **`degraded` 根本不会被赋值**（相对分支不会「全杀」：quantile 至少留 1 条、margin 至少留 top1），所以「`degraded` 恒为 0」不能当作相对尺子健康的证据；真正的信号是 `passCount/候选数` 的分布（quantile 0.5 应≈50%，margin 8 随 provider 刻度变化）与 `kept ≤ 1` 的比例。`degraded` 只服务 floor 族，用来发现「绝对门槛在换 provider/语料后整题失灵」。
4. **兼容性**：`filterRule` 缺省 `floor`，旧配置行为逐位不变；`margin`/`quantile` 只在显式配置时生效，不影响既有部署。
5. **配置面现状（后续要补）**：`MemoryCore/src/gateway/settings-override.ts` 的 `RerankSettingsOverride` 只接受 `enabled/provider/baseUrl/apiKey/model/timeoutMs/candidates/minScore/local`，**不认 `mode`/`filterRule` 等键**（未知键静默忽略）。也就是说这些新键目前只能写 yaml（`memory.recall.rerank.*`），管理后台的 config-override 改不了它们；要做成管理台可调，得扩 override schema + 校验 + SettingsPage，属于独立票的活。另外 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 的 rerank 块也没有这三个键（#145 把 `candidateK` 补进了云模板；`mode`/`filterRule` 仍未钉；排序加权比例键已于 #164 整体删除，见 §21.6）。
6. **决策记录**：本次机制变更已落 `docs/adr/0013-rerank-filter-题内相对尺子.md`（绝对门槛不可校准的理由、相对尺子的语义与取值、观测字段、被否决的选项）。

### 19.10 复现

```bash
cd MemoryCore
# 库目录（复用的已灌库沙箱；各臂必须指向同一个库，--no-write-steps 保证只读）
BENCH_STORE="${BENCH_STORE:-$HOME/AppData/Local/Temp/tdagemem-bench}"
# ① instrumented 取样（转储每题全候选分数；约 5 分钟）
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval \
  --manifest .eval-data/bench/lme-manifest.json --keep --pace 150 --gen-limit 0 \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --present-temporal \
  --store "$BENCH_STORE/lme90-r144-instr" --no-write-steps \
  --fusion '{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}' \
  --rerank-candidates 32 --rerank-minscore -1000000000 --rerank-mode filter \
  --dump-rerank-scores --report-name lme90-r144-instr --tag r144-instr

# ② 离线校准（零外呼，无 LLM）
node --import tsx scripts/analyze-r144-rerank-floor.mjs \
  --dump .eval-data/bench/lme90-r144-instr-rerank-scores.jsonl \
  --result .eval-data/bench/lme90-r144-instr.json \
  --out .eval-data/bench/lme90-r144-instr-rerank-scores-floor-calibration.json

# ③ 实跑配对（相对尺子两档；B 为公共旗标）
B="--dataset longmemeval --manifest .eval-data/bench/lme-manifest.json --keep --pace 150 --gen-limit 0 --recall-ks 1,3,5,10 --b1 --candidate-k 32 --present-temporal --store "$BENCH_STORE/lme90-r144-instr" --no-write-steps --fusion '{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}' --rerank-candidates 32 --rerank-minscore -1000000000 --rerank-mode filter"
node --import tsx scripts/eval-memory-bench.mjs $B --rerank-filter-rule quantile --rerank-keep-ratio 0.5 --report-name lme90-r144-q50 --tag r144-q50
node --import tsx scripts/eval-memory-bench.mjs $B --rerank-filter-rule margin --rerank-margin-top 8 --report-name lme90-r144-m8 --tag r144-margin8
```

## 20. #145 rerank 生产缺省翻转（candidates 32 / minScore −10.5，provider 刻度感知）与 blend 交互的实测复核（2026-10-29）

票 #145 的任务：把「深池 + 近不筛」从 bench 实验档变成**生产缺省**，并复跑 LME90 验收（turnCov@5 ≥84% 且不低于 82%）。本节记录落地内容、复跑结果、以及一个必须写下来的意外发现：**#135 的 84.3% 在现在的生产组合里只剩 79.5%，差额几乎全部来自 `recall.rerank.blend: 0.9`。**

### 20.1 落地内容（代码 / 配置 / 文档）

| 位置 | 改动 |
|---|---|
| `MemoryCore/src/core/recall/rerank/defaults.ts`（新增） | 缺省值单一口径源：`DEFAULT_RERANK_CANDIDATES=32`、`DEFAULT_RERANK_MIN_SCORE_LOGIT=-10.5`、`DEFAULT_RERANK_MIN_SCORE_PROB=sigmoid01(-10.5)≈2.75e-5`、`sigmoid01`、`isLogitScaleProvider`、`defaultRerankMinScore(provider)` |
| `MemoryCore/src/config.ts`（parse 期） | `rerank.candidates` 缺省 12→32；`rerank.minScore` 缺省 −2→**按 provider 刻度**（local logit −10.5 / siliconflow·dashscope 概率刻度 sigmoid(−10.5)）；显式 yaml / override 值逐位优先（`num()` 命中即不取缺省） |
| `MemoryCore/src/core/hooks/auto-recall.ts`（wiring 兜底） | 与 config 同口径；两处刻度判定（经验层精排 `logitScale`、结论层 `r71GateLogitScale`）统一走 `isLogitScaleProvider`，并删掉本地重复的 sigmoid 实现 |
| `MemoryCore/src/gateway/boot-warmup.ts` | 预热文档缺省 12→32（与 candidates 缺省对齐；属票外顺带项：预热池小于精排池会让首轮精排退化到原序） |
| `MemoryCore/tdai-gateway.yaml`（本地，gitignore） | 钉 `candidateK: 32`；补 #145 注释说明「扩池后缺省 candidateK 会变 96」。本票初版还钉过 `blend: 0.9` + `minScore: -10.5`，收尾时按 §21 判决**撤掉两个钉子**（缺省已最优/已刻度感知） |
| `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | 新增 `recall.candidateK: 32`（缺省 `maxResults*3` 会随扩池变 96）；初版曾加 `recall.rerank.blend: 0.9`，收尾时已删（§21.2：深池档纯精排更优，钉子只会把旧实验值静默带进生产） |
| 测试 | 新增 `defaults.test.ts`（7 条：深池缺省、provider 刻度映射、sigmoid 分位等价、`isLogitScaleProvider` 与取值路径的差异化语义、显式值优先）；`config.rerank.test.ts` / `boot-warmup.test.ts` 断言同步 |
| 文档 | 本文件 §2 推荐配置重写、§7 的 P0「灰度关 rerank」行标注已被 #145 取代、`CONTEXT.md` 增词条「精排默认值与刻度感知门槛」 |

### 20.2 验收①：默认档复跑 = 79.5%（未达 84%）

```bash
bash scripts/run-r135-rerankfix-arms.sh one      # 不带任何 --rerank-* 覆盖 = 只吃生产缺省
```

报告 `MemoryCore/.eval-data/bench/longmemeval-oracle-2026-10-29T04-06-10.json`（tag `rfix-one`，judge `MiniMax-M3.1-Flash` + `lme-v2`，与 #135 同判分器，可配对）：

| 指标 | 值 |
|---|---|
| turnCov@5 | **79.5%**（0.7954） |
| sessionCov@5 / sessionAny | 92.7% / 100% |
| MRR / nDCG@5 | 0.753 / 0.744 |
| LLM 判对 / 拒答 | 75.6% / 14.4% |
| tokenF1 | 0.472 |
| 注入行/题 · 块字符 | 3.54 · 3655 |
| 召回延迟 mean / p50 / p95 / max | 1390 / 1179 / 2971 / 5073 ms |

生效配置经报告与 cfg 日志双向确认：`rerankEnabled=true`、`provider=local`、`candidates=32`、`minScore=-10.5`、`blend=0.9`、`candidateK=32`、`rerankOverride=null`（即不缺省被覆盖）。

**floor 已确认不再是伤害源**：90 题里 `gates.rerank.kept` 分布 = {2:5, 3:5, 4:2, **5:78**}，样例 gate `{"provider":"local","kept":5,"dropped":3,"topScore":5.457,"scoreScale":"logit-sigmoid","threshold01":2.755e-5,"top01":0.9957,"passCount":8,"blend":0.9}` —— 与 §19.1 的结论一致（−10.5 ≈ 不筛）。既然没剪枝，79.5% 与 84.3% 的差额只能来自**排序**。

### 20.3 归因：差额来自 `blend=0.9`，不是 candidates/minScore

同一份缺省、同一个库、同 judge，只把 `blend` 归零重跑（`one --rerank-blend 0 --report-name lme90-r145-blend0`）：

| 档位 | blend | candidates / minScore | turnCov@5 | sessionCov | MRR | nDCG@5 | 判对 | 拒答 | 注入行 | p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 生产默认（one 档） | **0.9** | 32 / −10.5 | 79.5% | 92.7% | 0.753 | 0.744 | 75.6% | 14.4% | 3.54 | 1179 ms |
| 只改 blend=0（one 档） | 0 | 32 / −10.5 | **83.2%** | 93.4% | 0.780 | 0.780 | **82.2%** | 11.1% | 2.91 | 1039 ms |
| #135 deep105（历史，同 judge） | 0 | 32 / −10.5（显式） | 84.3% | — | — | — | 82.2% | 10.0% | — | — |

配对统计（`fit-fusion-weights.mjs compare`，基线 = 生产默认档，n=90，按 case 重采样 1000 次）：

- blend0 vs 默认：**ΔturnCov@5 = +3.64pp**，CI95[−2.87, +10.73]，11W/9L/67T，符号检验 p=0.82；判对 +6.67pp，McNemar p=0.18。**E2 门禁 FAIL（n=90 不足以显著）**，但两个独立指标（召回覆盖与答案判对）同向，且 kept 分布两档都是 {2:4~5, 3:5~6, 4:2, 5:78} —— 没有任何剪枝差异，纯粹是排序不同。
- #135 deep105 vs 默认：Δ +4.79pp，CI95[−2.11, +12.84]，判对同样 +6.67pp。
- blend0 vs deep105：83.2% vs 84.3%，差 1.1pp，落在噪声带内（§19.8 记录的基线自重跑差就有 0.6pp，且两档相隔两天、管线多了 #137/#138 的读侧件）。

机制解释（`blend` 语义见 auto-recall 的 `applyRecallRerank`）：`score = α×融合位次先验 + (1−α)×精排归一化分`，**α=0.9 意味着最终序 90% 由融合位次决定、精排只占 10%**。而 deep105 的收益恰恰来自「32 条候选被精排重新排序」；把精排权重压到 10%，等于把 #135 修好的排序优势重新稀释掉。

关键的上下文：**#137-F 定 α=0.9 时的配置是「浅池 12 + 硬 floor −2」**——那一档里纯精排会因为误杀 gold 而变差（§13.5 记录纯重排判对 77.8% / cov 77.6%，α=0.9 是 80.5%）。#145 把池加宽、floor 放到不筛之后，前提变了：纯精排不再误杀，反而能把 32 条候选里的 gold 顶上来。**所以「blend 0.9」与「深池 + 近不筛」不是互补的两个优化，而是互相抵消的两笔账。**

### 20.4 结论与待定项

1. **票面验收①严格未达标**：生产默认（含 yaml 的 `blend: 0.9`）= 79.5%，纯重排缺省 = 83.2%，都不到 84%。但 84.3% 的实质是可复现的（83.2%，与 84.3% 统计不可分），差额不在本票范围内的 `candidates/minScore`。
2. **本票的机制目标已达成**：floor 不再是伤害源（kept=5 占 86.7%），深池成为缺省，provider 刻度感知正确，显式配置不被覆盖。
3. ~~**待拍板**：生产要不要把 `recall.rerank.blend` 从 0.9 调回 0（或小 α 如 0.1–0.2，尚未测）。~~ **已拍板（§21.1）**：α∈{0, 0.1, 0.2, 0.9} 四档扫完，α>0 三档在深池口径下全负（turnCov −1.15/−3.83/−3.64pp，判对 −5.6/−7.8/−6.7pp），生产**不钉** `blend`，让缺省 0 生效（= 本节的 blend0 档，83.2% 才是生产预期）。
4. **生产 override 已核查**：`D:/TDB/data/config-override.json` 的 `rerank` 段只有 `provider`/`enabled`/`local`，**没有残留 `minScore`/`candidates`**，因此新缺省在现网直接生效（票面「注意」项已完成）。

### 20.5 复现

> ⚠ 本节命令里的 `--rerank-blend` 已被删除（§21.6）：要复现 20.2 的 79.5% 需先 `git checkout 8168e1a`；当前代码只能复现生产口径（纯精排）。

```bash
cd MemoryCore
bash scripts/run-r135-rerankfix-arms.sh one --rerank-blend 0 \
  --report-name lme90-r145-blend0                                          # 生产口径（yaml 已不钉 blend）+ 显式钉 0 防复跑漂移
bash scripts/run-r135-rerankfix-arms.sh one                                # 2026-10-29 上午那次 blend 0.9 档（yaml 当时还钉着），仅作对照
node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/longmemeval-oracle-2026-10-29T04-06-10.json \
  --arm blend0=.eval-data/bench/lme90-r145-blend0.json \
  --arm deep105_135=.eval-data/bench/longmemeval-oracle-2026-10-27T08-36-53.json
```

⚠ 复跑注意：第一次 `--rerank-blend 0` 臂在 12:09 因 `[rerank] provider=local 返回 null，降级原序` 失败（首载超时，无报告），重跑即正常；判读时以报告里的 `config.rerank` 为准，别只看命令行。

## 21. #145 收尾：blend 四档复评 + 生产开关台账（2026-10-29）

§20.4 留下的唯一待拍板项是 `recall.rerank.blend`（#137-F 定的 0.9，与深池新缺省互相抵消）。本节把它一次测穿，并顺手把「哪些开关该出现在生产 yaml 里」写成台账 —— 判据只有一条：**开关必须有实测作用，没作用的钉子不留**。

### 21.1 blend 四档：α>0 在深池档全负

同库（`$BENCH_STORE/lme90-mm-b0base`，每臂 fresh 复制）、同 judge（MiniMax-M3.1-Flash）、同 `lme-v2`、n=90 同题配对；公共基线 = 生产缺省 `candidates 32 / minScore 按 provider(−10.5) / candidateK 32 / rerank on`，只改 α：

| α | turnCov@5 | Δ vs α=0 (pp) | CI95 | MRR | nDCG@5 | 判对 | Δ判对 (McNemar p) | 拒答 | 注入行 | p50 | 结果文件 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **0** | **83.18%** | — | — | 0.780 | 0.780 | **82.22%** | — | **11.11%** | 2.91 | 1039 ms | `lme90-r145-blend0.json` |
| 0.1 | 82.03% | −1.15 | [−7.28, +4.02] | **0.796** | **0.791** | 76.67% | −5.56 (p=0.2266) | 14.44% | 3.11 | 1047 ms | `lme90-r145-blend01.json` |
| 0.2 | 79.35% | −3.83 | [−10.54, +1.92] | 0.779 | 0.764 | 74.44% | −7.78 (p=0.1185) | 14.44% | 3.14 | 1248 ms | `lme90-r145-blend02.json` |
| 0.9 | 79.54% | −3.64 | [−10.73, +2.87] | 0.753 | 0.744 | 75.56% | −6.67 (p=0.1796) | 14.44% | 3.54 | 1179 ms | `longmemeval-oracle-2026-10-29T04-06-10.json` |

读法三条，按重要性排：

1. **没有任何一档过 E2 门禁**（n=90 的 CI 宽约 ±6pp，单点差异都不能说显著）。但**方向一致**：turnCov 与判对这两条独立指标上，α>0 的 3/3 档全负；且注入行随 α 单调上涨（2.91→3.14→3.54）、拒答同步上涨（11.1%→14.4%）—— 这是「精排被稀释后把近似噪声摊进上下文」的典型指纹，不是抽样抖动。
2. **α=0.1 是唯一有亮点的档，但亮点不在对的地方**：MRR 0.780→0.796、nDCG 0.780→0.791 四档最好，判对却掉 5.56pp。检索序更好、答案更差 —— 正好复现 §17.9 的「检索序与判对不同步」：深池档里 gold 已经在 5 条内，尖端顺序的提升不转化为生成质量，多塞进来的近似行反而干扰。
3. **α=0.9 相对 α=0.2 只有判对微高（75.6% vs 74.4%）、覆盖率更低**，属噪声级差异；两档都远离 α=0。§17.9 在 deep105 锚点下复现过同一结论（blend0 83.2% vs blend09 79.0%，Δ−4.21pp），与本表 −3.64pp 同向同量级。

**判决**：生产**不钉 `blend`**，让代码缺省 0（纯精排）生效。生产预期即本表第一行：**turnCov@5 83.2% / 判对 82.2% / 拒答 11.1%**。

### 21.2 落地：撤掉两个钉子，留下有作用的键

| 文件 | 改动 |
|---|---|
| `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | 删 `recall.rerank.minScore: -10.5`、删 `recall.rerank.blend: 0.9`（各留一行注释指向本节），保留 `enabled/provider/timeoutMs/candidates` 与 `recall.candidateK: 32` |
| `MemoryCore/tdai-gateway.yaml`（本地，gitignore） | 同上 —— bench 以它为底，清掉实验值后 `one` 臂默认就落在生产口径 |

为什么这两个删、其余不删：

- `minScore` 钉死是**跨 provider 的定时炸弹**：`local` 是 logit 刻度，−10.5 在分布左尾 ≈ 不剪枝；`siliconflow`/`dashscope` 是 0..1 概率刻度，同一个 −10.5 等于「永不过滤」。缺省已按 `defaultRerankMinScore(provider)` 换算（§20.1），钉住反而盖掉这个正确行为。
- `blend` 钉死等于把一个**只在浅池成立的实验值**（#137-F 的 0.9 定于 `candidates 12 + floor −2`）永久带进深池生产；它在 yaml 里不显眼、后续每轮 bench 都会静默继承（§17.9 踩过）。
- `candidates: 32` / `recall.candidateK: 32` **反过来必须钉**：前者代码缺省同为 32 但易随池深改动漂移，后者代码缺省是 `maxResults×3`(=96) 会随扩池跳；且 `candidateK 32` 是召回侧唯一有 matched +6.44pp（15 对）的键。

### 21.3 生产开关台账（现行「留/删」依据）

强度标记：**PASS** = 真配对过 E2 门禁；**ns** = 真配对不显著；**matched** = §17.4 的 matched 观测（混杂浅池，只作方向参考）；**机制** = 只有推理、无实测。

| 开关 | 云模板 | 本地 yaml | 代码缺省 | 证据 | 判决 |
|---|---|---|---|---|---|
| `recall.rerank.enabled` | true | true | **false** | 深池 83.2%（历史 84.3%）vs 关档最好 82.6%（#137 全开口径）/ 79.5%（b1off） | **留 true**（唯一有实测正收益的大件） |
| `rerank.provider` | local | local | local | 本地 bge-reranker-base，P50 2.6–4s，离线可用 | 留 |
| `rerank.candidates` | 32 | 32 | 32 | matched 12 vs 32 = 0.00pp（**不是增益**）；但 kept≥4 38/90→80/90 是 84% 档的前提 | **留 32（防漂移型钉子）**：值与缺省同，钉住防池深被静默收回 |
| `rerank.minScore` | — | — | 按 provider | matched +3.45pp（n=1）；钉死跨刻度失效 | **删钉**，吃缺省 |
| `rerank.blend` | — | — | **键已删除** | §21.1 深池四档 α>0 全负；§21.6 浅池配对 −1.15pp | **删机制**（配置项 + 混合逻辑一起删） |
| `recall.candidateK` | 32 | 32 | `maxResults×3` | matched +6.44pp（15 对），召回侧唯一显著键 | **留 32** |
| `recall.fusion.mode` | 未设(rrf) | normalized | rrf | matched +2.90pp 判对，但深池锚点 −2.22pp；normalized 是 #137-F 实验档 | **不设**（走 rrf） |
| `recall.factChannel.enabled` | false | true(#137 实验档) | off | 判对 −1.1pp ns / turnCov +4.4pp 显著 ≠ 答案更好；§16.7 定位它是覆盖率工具 | **生产不设**（本地留实验档） |
| `validity.mode` | soft | soft | soft | hard −3.3pp | 留 soft |
| `smallToBig` additive×4 | 同 | 同 | 同 | w3legacy 83.3% 最高（§14） | 留 |

> 台账用法：**证据栏为空的行不该出现在生产 yaml 里**。要加新开关，先在 bench 上拿到至少 matched 级证据，再按上表格式补一行；拿不到就别加。
>
> 两类钉子别混：**增益型**（实测优于缺省才钉，如 `candidateK: 32` 的 +6.44pp）与**防漂移型**（值与缺省相同、靠机制证据钉住，如 `candidates: 32` 的 kept≥4 前提）。防漂移型必须在 yaml 行尾写明「防漂移」，否则下一个人会以为它是增益证据而照抄到别的池深配置上。

### 21.4 票面验收判定

- 验收①「改缺省后 `one` 复跑 LME90，turnCov@5 ≥ 84% 且不低于 82%」：**点估计 83.2% —— 不低于 82% 达成，≥84% 未达**。84.3%（#135）与 83.2% 差 1.1pp，落在 n=90 噪声带内（§19.8 记录同档自重跑差 0.6pp，本节四档 CI 半宽 6–7pp），二者统计不可分。
- 验收② typecheck 零新增 + 全量 vitest 绿：达成（243 个既有错误不变；全量 281 files / **2628** tests —— 删机制后少了 7 条 α 混合用例、又补了 1 条「旧报告字段不当旋钮」回归用例，见 §21.6）。
- 验收③ 文档与 yaml 模板同步：达成（§2 重写、§20 新增、本节、云模板、CONTEXT.md）。
- 若必须拿到「点估计 ≥84%」：只能上 LME500（n=90 分辨不了 1pp 级差异）或引入 §16.7 的 W1 事实通道覆盖率方案 —— 都是新工作，不属本票范围。

### 21.5 复现

> ⚠ 下面的 `--rerank-blend` 已被删除（§21.6），直接跑会报未知参数。复现本节四档需先 `git checkout 8168e1a`（删机制前最后一个提交），或只跑 α=0 那一档（当前代码等价）。

```bash
cd MemoryCore
for a in 0 0.1 0.2 0.9; do
  bash scripts/run-r135-rerankfix-arms.sh one --rerank-blend $a --report-name lme90-r145-blend-$(echo $a | tr -d .)
done

node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/lme90-r145-blend0.json \
  --arm a01=.eval-data/bench/lme90-r145-blend01.json \
  --arm a02=.eval-data/bench/lme90-r145-blend02.json \
  --arm a09=.eval-data/bench/longmemeval-oracle-2026-10-29T04-06-10.json
```

⚠ 首载偶发 `[rerank] provider=local 返回 null，降级原序`（模型首载超时），表现是该臂无报告；重跑即可，判读以报告里的 `config.rerank` 为准。
### 21.6 α 混合机制已删除（2026-10-29 收尾）

§21.1 只在深池口径（candidates 32 / minScore 按 provider）扫了 α，留了一个漏洞：**α>0 会不会在它原本的浅池锚点仍然净赚？** §13.5 当年正是在「candidates 12 + 硬 floor −2」测到 α=0.9 更好的。所以收尾时回浅池锚点做了同库同 judge 的 n=90 配对，只差 `blend` 一个键。

| 档（candidates 12 / minScore −2 / candidateK 32 / fusion weighted / factChannel on） | turnCov@5 | Δ vs blend0 [CI95] | 判对 | Δ判对（McNemar） | MRR |
|---|---|---|---|---|---|
| **blend 0** | **82.4%** | — | **80.0%** | — | — |
| blend 0.9 | 81.3% | **−1.15pp** [−6.90, +4.02] | 77.8% | −2.22pp（p=0.7539） | +1.91pp |

报告：`MemoryCore/.eval-data/bench/lme90-shallow-blend0.json`、`…/lme90-shallow-blend09.json`；win/loss/tie = 5/8/74，符号检验 p=0.5811，**E2 门禁 FAIL**。

**两条读法**

1. **§13.5 的 +2.9pp 不该记在 blend 头上**：那组对比一次性改了三件事（blend 0.9 + 融合锚点 + floor 补位）。本表两臂里锚点与补位都已生效，隔离出来的 blend 贡献是 **−1.15pp**，即「浅池里的收益来自锚点/补位，blend 是搭便车的第三方」。
2. **与深池同向同量级**（深池 −3.64pp / 浅池 −1.15pp），且都是 MRR 小涨、判对下降 —— 与 §17.9「检索序改善不同步到答案」同一现象。α>0 在两个池深下都没有一格是净收益。

**判决：删除机制，不只是撤钉子。** 判据是台账那条原则的加强版 —— 开关要有实测作用；**确认「关着更好」之后，留在代码里的旋钮就是死配置**：它不显眼、后续每轮 bench 会静默继承、还会诱使别人再调它一遍。

**删除清单（commit 记录，验证见下）**

| 位置 | 处理 |
|---|---|
| `MemoryCore/src/core/recall/rerank/blend.ts` | **改名 `anchor.ts`**，只留 `anchorRerankOrder(order, cap)`（原第三参 `anchorIdx` 唯一调用点恒传 0，一并内联）；删 `blendRerankOrder` / `rankPriorScores` / `RerankScored` |
| `MemoryCore/src/core/hooks/auto-recall.ts` | `RerankWiring` 去 `blend` 字段，off/unavailable/active 三处接线去 `blend:`，删 `if (wiring.blend > 0 && …)` 混合块（含 `RERANK_DEBUG_BLEND`），gate 不再输出 `blend` |
| `MemoryCore/src/config.ts` | 删 `recall.rerank.blend` 的类型声明、docblock 与解析（含 0..1 夹取） |
| `MemoryCore/src/core/recall/recall-journal.ts` | `gates.rerank.blend` 字段删除 |
| `MemoryCore/scripts/eval-memory-bench.mjs` | 删 `--rerank-blend` 旗标（usage / known-flags / 参数解析） |
| `MemoryCore/scripts/lib/bench/store.mjs`、`scripts/audit/r143-e3-review.mjs` | 指标键清单去掉 `recall.rerank.blend` |
| `MemoryCore/scripts/lib/bench/fusion-fit.mjs` | **彻底移除**该旋钮：`B0BASE_RERANK` / `KNOB_ORDER` / `armKnobs` / `knobsSummary` / 深池判定都不再含它；旧报告里的该字段自然被忽略（那些档本来就被否了，不需要再分组）。**副作用要知情**：§21.1 的四档在新旋钮表里向量相同 → `knobsSummary` 对它们都打印「缺省」、配对被跳过；要按档配对请 checkout `8168e1a`。回归测试已钉住「旧字段不被当旋钮」（`MemoryCore/__tests__/bench-fusion-fit.test.ts`） |
| 历史臂脚本 `run-r138/r139/r141*.sh` | 去掉 `--rerank-blend 0.9`（否则旗标已删、脚本直接报错） |
| `scripts/run-r142-sampling.sh` | 纯 blend A/B 档脚本，旗标已不存在 → **`git rm` 整脚本删除**（命令与读数在 §13.5 正文里有记录） |

**保留（本节不动）**：融合锚点 `anchorRerankOrder`（cap 内必须含融合 top-1）、floor 补位、`minScore` 的 provider 刻度感知 —— 这三件才是 §13.5 真正测到收益的部分。

**复跑指引**：`--rerank-blend` 旗标已不存在，要复现本节数据需先 `git checkout 8168e1a`（删机制前最后一个提交），再按 §21.5 的命令跑。历史报告文件本身不受影响（`compare` 照常读它们），但**新旧不可按档配对**：旧报告里的该字段现在被忽略，§21.1 四档在新旋钮表里是同一向量，`knobsSummary` 显示「缺省」、`knobDiff` 为空导致配对跳过 —— 要在表里区分它们只能回 `8168e1a` 口径重跑。
**删净审计（2026-10-29 终审，第二轮）**：第一轮曾把若干命中定性为「有意保留的历史痕迹」，维护者否决了这个口径 —— **残留一律清零**。第二轮删到 `git grep -i blend -- . ':!docs'` 只剩一处无关命中：

| 位置 | 现状 |
|---|---|
| `MemoryCore/src/core/recall/rerank/anchor.ts`、`__tests__/anchor.test.ts` | 头注释不再提旧机制，只讲锚点职责 |
| `MemoryCore/scripts/lib/bench/fusion-fit.mjs` | 旋钮整体移除，文件内零命中（臂标签/坐标系/诊断/深池判定都不再认它） |
| `MemoryCore/scripts/audit/r138-slot-competition.mjs` | 两个读取字段删除，审计只认 `candidates`/`minScore`/`enabled`/`mode` |
| `MemoryCore/scripts/run-r142-sampling.sh` | 已 `git rm`（文件不存在） |
| `MemoryCore/__tests__/bench-fusion-fit.test.ts`、`bench-stages.test.ts` | fixture 里的该键与「历史旋钮」断言行全删；`bench-fusion-fit.test.ts` 保留**一条**回归用例：用旧报告字段名构造 config，断言它不进旋钮向量（唯一有意出现该字符串的代码位置，用于证明旧报告不会被当档位） |
| `MemoryCore/scripts/eval-memory-bench.mjs` | 连「旗标已删除」的说明注释也不留 |
| `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml`、`MemoryCore/tdai-gateway.yaml` | 注释清零；yaml 里写这个键属未知键，静默忽略 |
| `CONTEXT.md` | 词条改写为「融合序×精排的加权排序已整体移除」，不再出现键名 |
| `docs/`（含本文件 §13.5/§17.9/§20/§21、`docs/adr/0013-*`、`docs/superpowers/evals/**`） | **只有这里保留**：决策记录/历史读数/ADR 不改写，读时按 §21.1 与本节判决理解 |
| `INSTALL.md:294` | 唯一非 docs 命中，是英文动词 “blended into the system prompt”，与本机制无关 |

代码侧确认：`src` / `scripts` / `__tests__` 里的 `blend` 为零；`config.ts` 不解析该键；云模板 `rerank` 段解析结果为 `{enabled, provider, timeoutMs, candidates, local}`。

## 22. #146 事实级双时态（一条事实一行）：写时失效能精确到（实体,属性）吗（2026-10-29）

§16–§21 把「失效」做了三步：先证明**要**失效（#134 双时态）、再证明**只该失效单值属性**（#136 属性契约 + 软失效）、最后撤掉一批没实测作用的旋钮（§21）。留下一个结构性缺口：#136 的失效仍然落在**整行**——一条记忆 = 一个 turn 的合并正文。同一个 turn 抽出两条事实（`粉丝数 1000` + `喜欢徒步`）时，下一轮真更新粉丝数会把整行写 `valid_end`，兄弟事实连坐退出检索面。本票（#146）把粒度从「行」降到「事实」：**一条事实一行**，失效只落在同 `(subject,predicate)` 的**单值**那一行。

设计见 [ADR-0015](adr/0015-事实级双时态-一条事实一行.md)。本节只记**实测与验收**，含一次被实测推翻的 v1 设计与随之而来的 v2 修正。

### 22.1 写面与读面（机制已钉住，不依赖 bench）

| 证据 | 位置 | 钉住了什么 |
|---|---|---|
| 写面集成测试（真实 sqlite） | `MemoryCore/src/core/record/l1-writer.fact-rows.test.ts`（8 条） | turn1 两事实（single 粉丝数 + multi 爱好）→ turn2 更新粉丝数：旧事实行 `valid_end` 落库且 **= 新事实 `valid_start`**，同 turn 的 multi 兄弟与后续 additive 仍 active，行不删除、content 保持父 turn 原文 |
| 写前失效只按 fact_key | 同上 `fakeStore` 7 条 | 只对 single 行调用 `invalidateL1ByFactKey`；`invalidateL1`/`archiveL1` 零调用（本票核心：不再整行失效）；后端缺该方法时 loud warn 且**不回落整行**；隔离参数全缺时 scope 落 `DEFAULT_ISOLATION_ID`（不跨租户） |
| 存储方法 | `MemoryCore/src/core/store/__tests__/invalidate-l1-fact-key.test.ts`（4 条，含损坏 `metadata_json` 只跳过不抛错） | `json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END,'$.fact_key')` 精确命中 + 隔离三元组；表达式索引 `idx_l1_fact_key_valid` 实测走 SEARCH（0.12ms vs 全表 0.77ms @3000 行）；降级库返回 0 |
| 抽取器守卫 | `MemoryCore/src/core/record/l1-extractor.fact-rows-guard.test.ts`（2 条） | 事实级粒度下 dedup 冲突分支**不调** `invalidateL1`/`archiveL1(target_ids)`，但仍保留 `target_ids` 给图边 |
| 读面槽位折叠 | `MemoryCore/src/core/recall/__tests__/fact-turn.test.ts`（5 条） | 同一 `fact_of` 的多条命中折叠成一条（保留最高分、位置不变）；无 `fact_of` 原样通过 → 开关关断逐位不变 |
| 属性键归一 | `MemoryCore/src/core/record/fact-key-canonical.test.ts`（5 条） | 大小写/空白/首限定词/所有格/尾标点归一 + 5 个语义族；表外不猜（`favourite drink` ≠ `favourite food`） |
| bench 同口径 | `MemoryCore/__tests__/bench-fact-rows.test.ts`（14 条） | bench 事实行 content = 父 turn 原文，与生产同形；single 先失效后写、multi 不失效 |
| 读面联动 | l1-writer 测试后 3 条断言 | soft 效期 + 问当下（presentIntent）→ 旧行硬丢；问历史 → 旧行仍在 kept |

**为什么 `valid_end` 必须等于新事实的有效起点而不是写时刻**：读侧「问当下才硬丢」的判据是 `candidate.valid_start >= item.valid_end`（`src/core/recall/validity-policy.ts`）。若 `valid_end` 记 now（晚于新行起点），旧行永远判不出「被取代」，硬丢全线落空——走查脚本首版就栽在这里，失败反推才把语义钉死。区间因此首尾相接：柏林 `[3-02, 4-11)` → 慕尼黑 `[4-11, ∞)`。

### 22.2 机制走查（合成对话，逐判据断言失效语义）

`MemoryCore/scripts/audit/r146-walkthrough.mjs`（真实 `writeMemory` + 真实 sqlite `VectorStore`，零 mock）跑一段日常对话：T1「我住在柏林，最近迷上摄影」、T2「另外我还在学吉他」、T3「我上个月搬到慕尼黑了」。9 条判据全 PASS：

| # | 判据 | 结果 |
|---|---|---|
| 1 | 旧值（柏林）`valid_end` 落库 | PASS（`2026-04-11T19:40:00.000Z`） |
| 2 | 旧值不删除、content 仍可追溯 | PASS（父 turn 原文） |
| 3 | 新值（慕尼黑）有效 | PASS |
| 4 | 同 turn 多值（摄影）不被连坐 | PASS |
| 5 | 后续 additive（吉他）仍有效 | PASS |
| 6 | 事实级效期在 `metadata_json` 可读（`fact_key`/`cardinality`/`fact_of`/`fact_index`/`fact_phrase`） | PASS |
| 7 | 旧行 `valid_end` = 新值 `valid_start`（区间首尾相接） | PASS |
| 8 | 问当下（presentIntent）时旧值硬丢 | PASS（dropped=[turn-1]） |
| 9 | 问历史时旧值可召回 | PASS（kept 含 turn-1、demoted=[turn-1]） |

### 22.3 真实语料走查（验收④，LongMemEval knowledge-update 切片）

`MemoryCore/scripts/audit/r146-lme-walkthrough.mjs` 不编对话：直接取 LongMemEval oracle 里 knowledge-update 题型的**原始轮次文本 + 原始会话日期**，配 `facts-cache` 里真实 LLM 抽出的三元组，经真实 `writeMemory` + 真实 sqlite 落库后只读库回答三问。示例 case `50635ada`（问「我拿到当前 United 会员等级之前是什么等级」，答案 Premier Silver）24 轮、2 段会话：

| 判据 | 结果 |
|---|---|
| 每个含事实的轮次都落成事实行（无整行吞并） | PASS（26 条事实行 / 12 条整行兜底 / 12 个含三元组轮次） |
| 事实行 `metadata_json` 带 `fact_key`（效期粒度可读） | PASS（26/26） |
| 事实行 `valid_start` 全可读（双时态起点） | PASS（26/26） |
| 旧值不删除：失效行仍在库且 content 非空 | PASS（`invalidateL1` 只写 `valid_end`） |
| 同键多值并存、未被覆盖 | PASS（该 case 5 条更新链全是 multi） |

**真实语料的触发面（重要，别把机制效果读大）**：15 个有缓存的 knowledge-update case / 395 条三元组，基数分布 single 130 / multi 265；同 `(subject,predicate)` 跨轮多值键 52 个，**其中 single 16 个、multi 36 个**。即：抽取器直出 cardinality（facts-v3）之后，KU 切片上真实可触发事实级失效的属性槽只有 16 个——触发面存在但很窄，且谓词逐轮改写（`has united airlines status` 这类少数稳定属性才真正撞键）。

### 22.4 LME90 配对（验收③）：v1 设计被实测推翻

口径：`--rerank-off --b1`（浅池 b1-off 基线，与 #136 读数同仓），manifest 90/500，n=90，同 judge 同生成模型，**只差 `--fact-rows` 一个键**。

| 臂 | turnCov@5 | 判对率 | sessionCov | mrr |
|---|---|---|---|---|
| 整行基线（v1，MiniMax 判分） | 78.4% | 75.6% | 93.6% | 76.1% |
| 事实行 v1（content = 事实短语） | 68.0% | 72.2% | 93.6% | 66.8% |
| Δ（配对 bootstrap 1000 / seed 20261027） | **−10.38pp**，CI95 [−19.92, −0.77] | −3.33pp（McNemar p=0.61） | −0.93pp | −9.35pp |

分桶 turnCov@5（基线 → v1 事实行）：knowledge-update 0.714→0.512、single-session-preference 0.933→**0.556**、multi-session 0.681→0.643、single-session-assistant 0.733→0.800、single-session-user 0.857→0.857、temporal-reasoning 0.778→0.711。

**诊断（槽位饥饿假设）**：把行预算放大到 10（`--recall-max-results 10`）并按父 turn 折叠（`--dedupe-hits-by-turn`）后 turnCov@5 回到 72.4%——对事实行档 **+4.41pp（CI95 [+0.77, +9.00]，显著为正）**，对整行基线仍 −5.98pp（CI95 [−15.13, +3.56]，不显著）。分桶里只有 temporal-reasoning 反超基线（0.778→0.811），**偏好桶仍停在 0.556**。

结论：槽位饥饿只解释约 4 成损失，另 6 成是「注入的是事实碎片、丢了 turn 语境（说话人/时间/上下文）」。把存储粒度降到事实是对的，但**检索与注入的单位仍是 turn**——三者共用一个单位就必然要付两份成本。

### 22.5 v2 修正：存储按事实、检索与呈现按 turn

三条粒度各归其位（ADR-0015 决定 1/5）：

1. **存储** = 事实行：一条事实一行，`metadata.fact_key/cardinality/fact_of/fact_index/fact_phrase`，写时只失效同键 single 旧行。
2. **检索面** = 父 turn 原文：行 `content` 不再放事实短语，改放**父 turn 原文**（短语落 `metadata.fact_phrase`）⇒ 向量、BM25、注入文本与整行基线逐位相同，成本从构造上归零。
3. **注入预算** = turn：读侧截断前按 `fact_of` 折叠（`collapseFactRowsByTurn`，auto-recall 与 memory-search 两条读路都接），同一 turn 的 N 条事实只占 1 个槽位。

v2 配对（同 manifest / 同 judge `scm-flash` / 同生成模型，n=90，**只差 `--fact-rows`**）：

| 指标 | 整行基线 | 事实行 v2 | 配对 Δ |
|---|---|---|---|
| turnCov@5 | 76.7% | 74.7% | −1.95pp，CI95 [−5.75, +1.72]（不显著） |
| sessionCov | 93.0% | 91.9% | −1.11pp |
| mrr | 73.9% | 73.6% | −0.33pp |
| 判对率 | 62.2% | **66.7%** | +4.44pp（McNemar p=0.39，不显著） |
| tokenF1 | 0.435 | 0.430 | −0.005 |
| win/loss/tie | — | — | 1/5/81（符号检验 p=0.22） |

分桶 turnCov@5（基线 → v2）：knowledge-update 0.679→0.607、multi-session 0.681→0.631、single-session-assistant 0.733→0.733、single-session-preference 0.867→0.867、single-session-user 0.857→0.857、temporal-reasoning 0.778→0.778。分桶判对率：偏好桶 0.267→**0.533**、temporal-reasoning 0.533→0.600、其余持平（KU 0.667 / multi 0.467→0.400）。

**读数怎么读**：
- v1 的 −10.38pp 回归被消掉：v2 只剩 −1.95pp 且跨零（CI 含 0），判对率反而 +4.44pp（不显著）。**“开了不掉分”从实测上落到“不显著”这一档**，构造上则成立（行 content 与整行基线逐字相同）。
- 逐 case 只差 6 题（3 题降、3 题升；其中 6b7dfb22 由 0→1 且判对由错转对），不是系统性崩塌；但仍**不是零差异**——曾推断是事实行把 FTS/BM25 语料里同一段 turn 文本重复了约 1.6 倍（2519 行 vs 1591 行），IDF/doc 统计被稀释、个别题的并列分数顺序翻转。#166 做了隔离实验（§22.8「IDF 稀释隔离」）：删掉兄弟行的 FTS 索引后配对读数**没有回升**，该推断被否证——差异来自个别题的证据池成分，不是 doc 统计。
- **不宣称收益**：KU 桶 turnCov 仍 −7.2pp（15 题里 1 题的差），而收益前提（同属性反复提到且判 single）在真实语料只有约 4% 的三元组满足（22.3），加上 22.5 的值级泄漏——结论是：v2 让开关**开启安全**，但“开启有收益”未被证明。

**深池口径（#135 验收前提：candidates 32 / minScore −10.5 / candidateK 32 / 精排子进程）**：

| 指标 | 整行基线 | 事实行 v2 | 配对 Δ |
|---|---|---|---|
| turnCov@5 | 72.8% | 71.7% | −1.15pp，CI95 [−4.21, +0.77]（跨零） |
| sessionCov | 89.3% | 88.7% | −0.67pp |
| mrr | — | — | −0.13pp |
| 判对率 | 60.0% | 58.9% | −1.11pp（McNemar p=1.00） |
| win/loss/tie | — | — | 1/2/84 |

深池分桶 turnCov@5（基线 → v2）：knowledge-update 0.571→0.571、temporal-reasoning 0.644→0.644、single-session-assistant 0.867→0.867、single-session-user 0.857→0.857、single-session-preference 0.933→0.867、multi-session 0.479→0.479。分桶判对率：KU 0.600→**0.467**、TR 0.600→**0.533**、偏好桶 0.333→**0.467**。

**验收③判定（按票面「KU/TR 桶 cov 与判对不低于 b1-off」）**：深池口径下 KU/TR 两桶 **cov 完全持平**，但**判对各降 2 题（15 题里）**→ 严格读票面判**未达标**；浅池口径下 KU cov −7.2pp（1 题）、TR 判对 +6.7pp。两套口径的 bucket 噪声都是 ±13pp 量级（n=15），因此结论只能写成「机制对检索**中性**，未观测到收益」，不能写成「不劣」。

**v2 的已知泄漏（走查直接暴露，#166 已修）**：行 content 是父 turn 原文后，旧值文本会随**兄弟事实行**回流——`turn-1`（居住=柏林，single）失效了，同 turn 的 `turn-1#f2`（爱好=摄影，multi）仍 active 且 content 同为「我住在柏林，最近迷上摄影」，于是「问当下」仍会注入含柏林的文本。
即：**行级正确性成立（旧事实行不再作为"当前单值"返回），值级"不再出现在上下文"不成立**。这是 v1（per-fact content：值干净、检索掉分）与 v2（per-turn content：检索不掉分、值随兄弟回流）之间的真实取舍。#166 用**读侧值级遮蔽**收口（present-intent 下把污染 turn 的注入降级为事实短语），机制、读数与残留见 §22.8。

### 22.6 属性键归一：实测 0.0% 收益（别宣称已修复）

`factKeyOf` 现在做通用归一（大小写/空白/首限定词/所有格/尾标点）+ 5 个语义族（居住地/职业/电话/年龄/价格）。在 facts-cache 上量（95 个 case / 1796 条三元组，`scripts/audit/_canon_lift.mts`）：

| 指标 | 归一前（字面键） | 归一后（canonical） |
|---|---|---|
| 不同 `(subject,predicate)` 键 | 1461 | 1461 |
| 跨 turn 重复键 | 219 | 219 |
| 提升 | — | **+0.0%** |

原因很直接：语料谓词是自由文本（`is considering` 36 次、`likes` 20、`plans to` 18、`is interested in` 16……），同义表打不到；而同 subject 的谓词集合本身就是一堆**语义不同**的动作（`is considering` / `has completed` / `feels`），强行归并会误并。**真正的修法在抽取期**（抽取器直出 canonical attribute，谓词受控词表），列为遗留——本节只登记负结果，不把归一当作已修复。

### 22.7 生产开关与复现

| 项 | 值 |
|---|---|
| 生产开关 | `memory.write.factRows.enabled`（**缺省 false**） |
| `memory.write.factRows.maxFacts` | 未配则回落 `memory.write.factKey.maxFacts`（再回落 5），config 不注入缺省值以免静默覆盖 |
| 抽取器 | facts schema 增 `phrase`/`cardinality`（`facts-v3` prompt）；「拿不准就省略」 |
| 后端支持 | 需要 `invalidateL1ByFactKey`：sqlite 已实现（表达式索引 `idx_l1_fact_key_valid`，WHERE 与索引定义逐字一致才走索引）；**TCVDB 未实现**（`store/tcvdb.ts` 既无该方法也无 `invalidateL1`）→ 该部署下事实级失效不生效，只有 loud warn |
| 开启判据 | 开关语义是**正确性**（旧单值属性不得再算「当前」），不是检索增益；v2 后检索面与整行档逐位相同，故「开了不掉分」由构造保证，收益取决于属性碰撞面（22.3/22.6） |

```bash
cd MemoryCore
bash scripts/run-r146-arms.sh v2all     # 整行基线 vs 事实行 v2（scm-flash 生成/判分）
bash scripts/run-r146-arms.sh all       # v1 四档（b1off / b1off-factrows / deep / deep-factrows）
node scripts/fit-fusion-weights.mjs compare \
  --base .eval-data/bench/lme90-r146v2-base.json \
  --arm factrows=.eval-data/bench/lme90-r146v2-factrows.json
node --import tsx scripts/audit/r146-walkthrough.mjs
node --import tsx scripts/audit/r146-lme-walkthrough.mjs --case 18bc8abd \
  --present 'What brand of BBQ sauce am I currently obsessed with?' \
  --history 'What brand of BBQ sauce was I obsessed with before?'   # #166 值级遮蔽走查（换 case 先跑 .eval-data/bench/findcase.cjs）
bash scripts/run-r146-arms.sh idf       # #166 验收④：v2factrows2 vs v2factrows-prune（FTS 面配对）
bash scripts/run-r146-arms.sh v2deep-factrows2   # #166 验收③：新代码深池回归
```

### 22.8 #166 值级泄漏：present-intent 遮蔽（2026-10-30）

§22.5 尾部把「值级泄漏」登记为遗留：行级 `valid_end` 正确，但兄弟事实行的注入文本是父 turn 原文，旧值随文本回流。本节记录修法与代价。

**修法（票面方案②的读侧变体）**：钩子注入路在按 `fact_of` 折叠事实行时，若查询命中 present-intent（`detectPresentTemporalIntent`）且效期策略未关闭，就把**池内已过期行**当污染源——过期行在 hard 档要等折叠**之后**的 `applyExclusion` 才过滤、在 soft 档常只被降权保留（`related` 是 `contentTokenOverlap`，属性更新前后原文常无词重叠），所以只看 `sel.dropped` 会漏掉默认档与最常见的更新链。其所属 turn 的存活行改为注入**自己的 `metadata.fact_phrase`**（`displayContent`），短语缺失或短语仍含旧值则整行剔出注入（宁缺毋滥）。问历史逐位不变（旧值仍可回溯）。作用域只到 `searchHybrid` 注入路；`memory-search.ts` 的工具路仍返回父原文（工具给结构化行由调用方判读），登记为遗留。

为什么不用方案①（从最终文本里 diff 掉旧值）：抠文本会留下半句，且 `LA` 这类短值会命中 `planning`（走查实测误判），误伤成本高于少给一条证据。为什么不用方案③（写期把单值属性升成独立 turn）：改存储粒度与图边归属，本票不动写面。

**混合意图不遮蔽**：`valueMaskIntent = presentIntent && !detectHistoryTemporalIntent(userText)`（`HISTORY_TEMPORAL_RE` 认 `before/previously/used to/just started/之前/当初/刚开始`）。既问「刚开始」又问「现在」的题标准答案横跨新旧值，遮蔽会把含旧值的 gold turn 整条剔出——LME90 深池 `031748ae`（「我刚当上 Senior 时带几个工程师？现在带几个？」）无闸时 turnCov@5 0.5→0，加闸后恢复 0.5。`presentIntent` 本身不变，仍原样喂 #136 硬丢。

**遮蔽后仍能归因**：注入文本换成短语后「文本→turn」反查必失配，故 `RecalledMemory.turnId` 由 `searchResult.metas[i].recordId` 去 `#f<N>` 后缀透传；折叠路径同时折叠 `metas`（落选兄弟位置置 `undefined`，与 `lines/scores` 平行）——折叠一开 `metas` 原本整条缺席（bench 的 `foldClusterEnabled: true` 是缺省形状），turnId 全空、度量退回文本反查。这是可观测性修复，不改检索结果；修复前深池 turnCov 假摔 1.7pp（3 题 KU 各丢 0.5），修复后与 #166 前逐位相同。

**机制走查**：合成 3 turn 15/15 PASS（present 注入以事实短语呈现、无柏林；同 turn 兄弟仍注入；history 仍含柏林）；真实语料 8/8 PASS（LongMemEval KU case `18bc8abd`，「What brand of BBQ sauce am I currently obsessed with?」）——present 注入无被取代的 `Sweet Baby Ray's`、污染 turn 的 2 条存活行改注入自身事实短语、并仍召回新值 `Kansas City Masterpiece BBQ sauce`，history 注入仍含旧值。判据按 **turn**（同 turn 的注入行是否含旧值），不整段 `includes`——真实语料里地名/品牌满篇出现，整段判定必误判。
  原默认 case `50635ada`（United 里程）已不可用：facts-cache 2026-10-30 重生成成 facts-v3 后，抽取把旧值/新值落成不同谓词（`User.eligible_for_status` vs `User.reached_status`），写侧「同 fact_key 才失效」不触发 → 判据静默 SKIP。换 case 用 `.eval-data/bench/findcase.cjs` 扫同键更新面（500 题 46 题有同键不同值），问句用 `--present/--history` 传。脚本缺省 case 已改成可判的 `18bc8abd`，并把「本 case 无可判更新链」从静默 SKIP 改成**判 FAIL 退出 1**（空跑不能算过）。

**代价与边界**：被遮蔽 turn 丢说话人/时间/相邻事实语境（只给事实短语），故只在 present-intent 触发；`maskedRows/droppedRows/staleValues` 三项统计随折叠返回并落 debug 日志（可观测，不静默丢命中）。`droppedRows` 在折叠**之后**统计——被剔的落选兄弟本来也不会注入，先数会高估。

**实测 · 验收③（不回退检索：深池，新代码 vs #166 前，n=90，同 manifest / 同 judge `scm-flash`）**：

| 指标 | #166 前（旧代码深池） | #166 后（新代码深池） | Δ |
|---|---|---|---|
| turnCov@5 | 71.7% | **72.3%** | +0.57pp |
| sessionCov | 88.7% | 88.7% | 0.00pp |
| mrr | 72.0% | 72.5% | +0.54pp |
| nDCG | 66.4% | 66.8% | +0.44pp |
| 判对率 | 58.9% | **60.0%**（n=90，scm-flash 判分） | +1.11pp |
| tokenF1 | 0.283 | 0.271 | −0.012 |

深池逐题只动 **1** 题：`4d6b87c8`（「to-watch 列表现在几部」纯 present）0→0.5——遮蔽腾出槽位给 gold turn。`031748ae` 两侧都是 0.5（它靠混合意图闸保住，不是本票的净收益）。也就是说 +0.57pp 全部来自这一道题的半档位，n=90、单 judge、无区间估计，**不足以称为显著收益**，只作「没有回退」的证据；遮蔽的正当性来自机制走查（注入文本不含旧值），不来自这点涨分。**票面「turnCov@5 与判对不低于 v2 当前读数」两项都转正**（turnCov +0.57pp、判对 +1.11pp；度量修正前 turnCov 假摔 1.7pp，见上「遮蔽后仍能归因」）。

浅池配对（同一保留库 + 带生成/判分整跑，`--rerank-off --b1`，报告 `lme90-r146-r146v2-factrows2-shallow-gen`）：turnCov@5 **75.3%**（v2 当前 74.7%）、判对 **66.7%**（v2 当前 66.7%，逐位相同）、sessionCov 92.5%、mrr 73.8%、nDCG 72.2%、tokenF1 0.2719；degraded 2/90、strategy `error` 0/90（旧控制档首跑因并发 429 整段 error，见下「读数口径」）。浅池判对持平、turnCov +0.57pp，同样只够判「没回退」。一致性校验：只读 recount 与带生成/判分的整跑逐题 turnCov **0 题差异**（`deep-factrows2-recount4` vs `deep-factrows2-final`），说明召回面未被生成段扰动；degraded 行数 2/90 与旧报告同量级。

**实测 · 验收④（IDF 稀释隔离：浅池，同 manifest / 同 judge，只差「同 turn 文本多行进不进 `l1_fts`」）**：

| 指标 | 控制档（兄弟行进 FTS，2519 行） | 隔离档（只删 `fact_index>0` 的 FTS 行，928 删/1591 留） | Δ |
|---|---|---|---|
| turnCov@5 | 75.3% | 73.8% | −1.50pp |
| sessionCov | 92.5% | 90.8% | −1.67pp |
| mrr | 73.8% | 73.0% | −0.78pp |
| nDCG | 72.1% | 71.3% | −0.86pp |

隔离档**只删 `l1_fts`，`l1_records` 与 `l1_vec` 全量保留**——连 vec0 一起删会让向量候选变稀，读数就无法归因到 IDF。逐题只有 4 题变动（3 降 1 升：`031748ae` 1→0.5、`7405e8b1` 1→0.5、`f0e564bc` 0.5→0、`gpt4_ab202e7f` 0→0.2）。

**结论要说实话：df 稀释既没被证实、也不算被否定。** 同一对配置还有另一组配对（度量修正前的 `factrows2-recount2` 71.8% vs `factrows-prune-recount2` 74.4%，+2.6pp，符号相反）；同配置的重跑之间 turnCov 也能差 2–3pp（`factrows2` 旧代码 74.7% / 修正前 71.8% / 修正后 75.3%，前两者的差是度量而非代码）。也就是说本档能分辨的效应量小于噪声，±1.5–2.6pp 的位移**不能归因到 IDF**。另外这一档删的是 `l1_fts` 行——关键词候选本身也少了，严格说它测的是「FTS 索引面整件变化」，不是纯 df。可下的结论只有两条：①**没有证据支持**「兄弟行索引把检索拉低 1.95pp」，因此不值得为省索引去删行；②要真判 df 还得做「同 df 但不同候选集」的构造（例如把兄弟行 FTS 文本改写成语料里不存在的去重前缀），本票不做。本档是只读档（`--gen-limit 0`）只比检索面，生成/判分面的配对由验收③的深池整跑承担。

**读数口径与插曲（复现须知）**：三份读数统一用「保留灌库目录 + `--no-write-steps`」的只读 recount 跑（`--gen-limit 0` 只跑检索，判分沿用原跑），因为控制档首跑（`v2factrows2`）整段 90/90 `strategy:"error"`——它与另一臂的灌库并发，429 打穿 query embedding。筛选条件是 `strategy==='hybrid' && searchTiming.embeddingHits===0`（降级 fts-only）行数必须与旧报告同量级（实测 2/90，旧报告同为 2/90）；并发条件下降级行会飙到 10–12/90，读数作废。bench 原先对召回失败只写 `strategy:"error"`、不落 `error` 也不打日志，本票补了 `[bench:warn] 召回失败 <caseId>: <err>` 与行内 `error` 字段。

**残留（自觉放弃，不当作已修）**：①**跨 turn**——遮蔽只作用在被污染 turn 的存活行；若新值所在的更新 turn 原文自己复述旧值（「我上个月从柏林搬到慕尼黑」），该行仍逐字注入。要修得做全局值级 diff（回到方案①的误伤面）。②**旧值读不到时不校验**——过期行既无 `fact_value` 也无 `factTriples` 时只知"这个 turn 脏"，存活行短语无条件注入（只有缺短语才剔）；#166 之前写入的旧库行没有 `fact_value`，真实历史数据会命中这一形状。③工具路未遮蔽（见上）。④**混合意图按字面仍有泄漏**——`presentIntent=true` 但带过去标记的问句（「我刚当上 Senior 时带几个？现在带几个？」）跳过遮蔽以保住 gold turn，此时兄弟行的父原文仍会把旧值带进注入文本；这是刻意的取舍（不跳过就掉点，见上「混合意图不遮蔽」），验收①的「presentIntent 注入不含旧值」只在**纯 present** 问句上成立。⑤**soft 档语义被收紧**——present-intent 下池内过期行一律不注入（它们正是污染源），等价于对这批 turn 收紧了硬丢；#136 的「过期只降权、相关才硬丢」在 present 问句上不再逐位成立，这是为不泄漏旧值付的代价。⑥**旧报告与度量口径**——`RecalledMemory.turnId` 是本票新增字段，bench 的 `makeIdResolver` 改成 `h.turnId ?? 文本反查`；旧报告没有该字段，重算走文本反查、与改动前逐位相同，故「同一把尺子」成立。

## 23. #167 抽取期受控 attribute：把「同义」判定前移到抽取（2026-10-30）

§22.6 的负结果很直接：谓词是抽取器自由文本，写侧同义表在 1796 条真实三元组上收益 **0.0%**。真正的修法不在写侧，而在抽取期——让抽取器直接给受控 attribute。本票把 bench/生产提示词从 facts-v3 升到 **facts-v4**：三元组 schema 增 `attribute`（封闭 24 名），事实键优先按 `(normSubject, attribute)` 构造，无 attribute 才回落 #146 的 `(normSubject, normPredicate)`；基数裁决统一为 **attribute > 显式标注 > 启发式**（`resolveFactCardinality`，写侧 fact-row 与读侧 supersession 共用）。设计见 [ADR-0016](adr/0016-抽取期受控属性词表.md)。

本节只记实测与验收。两套语料：**95-case**（lme-manifest 的 95 个 id，用于与 §22.3 对齐）与 **500-case**（LongMemEval oracle 全量，v4 抽取 500/500 完成，5479 turn、12441 三元组）。

### 23.1 词表与真实语料分布（验收①）

词表在 v4 抽取**之前**定稿（依据 §22 的 1796 条三元组属性分布 + KU 切片复核，人工归纳），不是拿 500-case 结果反推。24 名 = single 10（residence/occupation/employer/education/age/phone/email/address/marital_status/name）+ multi 14（interest/plan/preference/goal/habit/possession/health/skill/activity/travel/relationship/opinion/diet/membership），单一源 `MemoryCore/src/core/record/fact-attribute.ts`。

500-case 实际抽出 22 个名字（phone/email 从未出现），覆盖率 **11947/12441 = 96.0%**；95-case 覆盖 94.2%、出现 19 个（另 employer/marital_status/name 也未出现）。词表比语料宽，属预置通用槽位，不是对样本过拟合。

**500-case top-N（按出现次数；share = 占带 attribute 三元组）**：

| attribute | 档位 | 次数 | share | cases | 抽取器自标 single | 自标 multi |
|---|---|---:|---:|---:|---:|---:|
| plan | multi | 3327 | 27.8% | 433 | 18 | 3298 |
| interest | multi | 2519 | 21.1% | 412 | 1 | 2497 |
| activity | multi | 1642 | 13.7% | 364 | 22 | 1612 |
| opinion | multi | 984 | 8.2% | 329 | 3 | 980 |
| possession | multi | 758 | 6.3% | 213 | 14 | 744 |
| preference | multi | 693 | 5.8% | 276 | 1 | 692 |
| habit | multi | 616 | 5.2% | 221 | 4 | 612 |
| goal | multi | 597 | 5.0% | 243 | 1 | 596 |
| travel | multi | 177 | 1.5% | 66 | 9 | 168 |
| relationship | multi | 169 | 1.4% | 93 | 9 | 160 |
| health | multi | 146 | 1.2% | 47 | 2 | 143 |
| skill | multi | 118 | 1.0% | 78 | 1 | 117 |
| membership | multi | 49 | 0.4% | 26 | 2 | 47 |
| education | single | 47 | 0.4% | 15 | 46 | 1 |
| occupation | single | 33 | 0.3% | 18 | 33 | 0 |
| residence | single | 33 | 0.3% | 25 | 33 | 0 |
| age | single | 18 | 0.2% | 9 | 18 | 0 |
| address | single | 6 | 0.1% | 6 | 6 | 0 |
| employer | single | 6 | 0.1% | 3 | 6 | 0 |
| diet | multi | 6 | 0.1% | 6 | 0 | 6 |
| name | single | 2 | 0.0% | 2 | 2 | 0 |
| marital_status | single | 1 | 0.0% | 1 | 1 | 0 |

**single/multi 比**：带 attribute 的三元组里 single 档位只占 **146/11947 = 1.2%**，multi 档位 98.8%。这不是抽取偏差，是这批语料的属性构成——plan/interest/activity 三类就占 62.6%，全是可并存属性。single 属性在 500-case 只出现 146 次，且抽取器自标与词表档位高度一致（见下），因此**事实级失效的触发面天然窄**，后文所有读数都受这一条约束。

**显式 cardinality 与词表档位一致率**：11905 条同时带显式标注与 attribute 的三元组中 11817 条一致 = **99.3%**（95-case 1723/1736 = 99.25%）。即模型大多自己就判对了基数，attribute 的主要作用不是纠基数，而是**让不同谓词落到同一个键**；不一致的 88 条里，词表档位按 ADR-0016 决定 3 压过显式（例如 activity 被标 single）。

### 23.2 抽取质量：30 条人工核对（验收④）

样本：`MemoryCore/scripts/audit/r167-attribute-sample.mjs` 从 95-case v4 缓存在抽样时已落盘的 1128 条带 attribute 事实中按 attribute 分层轮转、seed 20261030 抽 30 条；逐条判定见 `MemoryCore/.eval-data/bench/r167-attribute-audit.md`（含事实原文与判定口径）。

| 判定 | 条数 | 说明 |
|---|---:|---|
| ✅ 正确 | 25 | attribute 与事实语义一致（含可接受的宽口径，如「住所类型」标 residence） |
| △ 边界 | 3 | 能自圆其说但词表描述未覆盖，或主体不是 User 本人 |
| ❌ 错误 | 2 | 语义明显不符 |

**严格正确率 25/30 = 83.3%；只算明确错误 28/30 = 93.3%。** 明确误判两条：①`activity` 标「has seen woodpeckers」（观察/经历不是活动）；②`possession` 标「bought a gift for…」（购买行为不是拥有）。边界三条：宠物习惯标 `habit`、期望标 `opinion`、身份水平（a moderate hiker）标 `skill`。

误判类型归纳 4 类：**观察/经历→activity、购买→possession、期望/预期→opinion、身份/水平→skill**（宠物主体另记边界）。结论：词表整体可用，**不需要改结构**；这 4 类可靠收紧 description 降低误标，属于下一轮提示词微调，不在本票改表重抽（改表要重跑 500-case，成本约 45 分钟，收益未证明）。

**可复现性边界**：抽样池是抽样当时已落盘的 1128 条，不是最终 1736 条；`r167-attribute-audit.md` 是冻结的人工判定记录，用最终缓存重跑脚本会抽出另一批 30 条，83.3% 不能逐位复现，只能作为该批样本的准确率证据。

### 23.3 同键跨轮重复率：三把尺子，票面口径与真实触发面都未达 40%（验收②）

`MemoryCore/scripts/audit/r167-attribute-metrics.mjs` 同时出两种口径：

- **全局池化**（§22.3 旧口径）：所有 case 的事实放一个池，同 `(subject, 属性)` 跨 turn 出现即算跨轮——**跨 case 也会撞键**。
- **题内 per-case**：每个 case 独立算「跨 ≥2 turn 的键 / 不同键」，再给 micro（合并键数加权）与 macro（各题 rate 平均）。线上一条记忆只属于一个用户/会话，跨 case 同名属性不可能是更新链；**题内口径才是事实级失效的真实触发面**。

| 语料 | 口径 | v3 谓词键 | v4 属性键 | Δ |
|---|---|---|---|---|
| 95-case（1842 三元组） | 池化 | 1107 键 / 215 跨 = 19.4%[^v3drift] | 136 键 / 44 跨 = **32.4%** | +13.0pp |
| 95-case | 题内 micro | 13.6% | **52.9%** | +39.3pp |
| 95-case | 题内 macro | 13.0% | **48.7%** | +35.7pp |
| 500-case（12441 三元组） | 池化 | 4925 键 / 1318 跨 = 26.8% | 521 键 / 107 跨 = **20.5%** | −6.3pp |
| 500-case | 题内 micro | 17.6% | **58.9%** | +41.3pp |
| 500-case | 题内 macro | 16.7% | **56.8%** | +40.1pp |

[^v3drift]: 表里的 v3 列不是另跑一遍 v3 抽取，而是把同一份 v4 三元组按 `(subject, predicate)` 重算（`r167-metrics-v4-95-final.json` 的 `keyStats.v3LegacyKey`）。真 v3 缓存重跑的 95-case 读数是 1808 三元组 / 1244 键 / 231 跨 = 18.6%（`r167-metrics-v3-95.json`），与 §22.3 的 15% 差在 v3 缓存被重抽过，不是本次代码差异。

**但上表的题内 58.9% / 52.9% 不是失效收益**：multi 档位按设计永不失效，而题内跨轮键里 96.9% 是 multi（`crossTurnMix` 口径：500-case 2015 个跨轮键中 1952 个组内只有 multi 行，95-case 326 个中 316 个）。把分母限到**解析后 single 的行**，才是真正会触发失效的键：

| 语料 | 仅 single 行，题内 micro | v3 谓词键 | v4 属性键 | 仅 attribute 且 single |
|---|---|---|---:|---:|---:|
| 95-case | single 行 91 键 | 8.6% | **9.9%** | 2/15 = 13.3% |
| 500-case | single 行 428 键 | 12.1% | **14.0%** | 29/84 = 34.5% |

single-only 口径下 v4 只从 12.1% 抬到 14.0%（500）/ 8.6% 到 9.9%（95），**没有达到票面的 15% 基线，更不到 40%**；34.5% 只说明「attribute 自己能把 single 键收敛好」，但这类行只占 84/428 = 19.6%，不能冒充整库收益。原因是词表把 plan/interest/activity 这些真正高频的属性定成 multi，而语料里真单值的 residence/occupation/age 出现太少（23.1 的 146 条）。

**票面「从 15% 提到 ≥40%」按它自己的池化尺子没有达到**：95-case 32.4%、500-case 反而降到 20.5%。池化尺子在 v4 下也已**失去意义**：键空间从 4925 坍缩到 521（所有 case 的 `User|@attr:plan` 并成一个键），分母塌了，跨 case 的同名属性被当成跨轮——500-case 的 107 个跨轮键里绝大多数是不同 case 的 plan/interest，不是同一条记忆的更新。但**题内 58.9% 也不能当收益**：它证明的是「谓词改写后键还能落在同一个属性槽」，其中 96%+ 是永不失效的 multi。真正决定失效收益的 single-only 口径只有 14.0% / 9.9%，低于票面基线，更低于 40%。

**结论（判死，不留给下一节）**：按票面池化口径**未达标**；按真实触发面（single-only）也**未达标**，相对 v3 只多 1.9pp / 1.3pp。因此「抽取期受控 attribute 能在 500-case 上把事实级失效触发面抬到 40%」这个收益假设，在这份 24 名词表 + 这份语料上**不成立**——不是「换把尺子就达标」。机制本身（键收敛、跨谓词失效、读写同一阶梯）是对的，但高频属性都是 multi，single 属性只占 1.2%，收益天花板由语料属性构成决定。要继续这条线，得先补 status/count/favorite 这类高频单值属性，或改从 query 侧定向抽取，而不是继续加通用 multi 槽位。

### 23.4 KU 切片：13 个 single 槽位（去重后 6 条真更新）（验收③）

KU = knowledge-update。500-case 有 **78 个 KU case / 2158 三元组**；解析后判为 single 的三元组 **87 条**，其中带 single attribute 的 25 条。题内同键跨 ≥2 turn 的 single 槽位 **13 个**（脚本 `kuSlots.distinctValueSlots=10`、`repeatedValueOnly=3`；95-case 只有 4 个，因为该清单只覆盖 15 个 KU case）。逐条人工确认如下（值已截断）：

| # | case | attribute | 关键值（旧 → 新） | 判定 |
|---:|---|---|---|---|
| 1 | 031748ae | —（team outing） | 5 engineers and a manager → 4 engineers + manager, totaling 5 | ❌ 同值改写，不是更新 |
| 2 | 031748ae | occupation | Senior Software Engineer ×3 turn | ❌ 同值重复 |
| 3 | 031748ae | —（leads） | team of 4 engineers → team of five engineers | ✅ 真更新 |
| 4 | 031748ae_abs | occupation | Senior Software Engineer ×3 turn | ❌ 同值重复（同题改写版） |
| 5 | 031748ae_abs | —（leads） | team of 4 → team of five | ✅ 真更新（同题改写版） |
| 6 | 06db6396 | —（has completed） | 4 painting projects ×2 turn | ❌ 同值重复 |
| 7 | 1cea1afa | —（has） | 500 Instagram followers → 600 followers | ✅ 真更新 |
| 8 | 2133c1b5_abs | residence | Tokyo → Harajuku for 3 months | ✅ 真更新 |
| 9 | 3ba21379 | —（is using） | Vallejo paints → Vallejo paints on current project | ❌ 同值细化 |
| 10 | 4d6b87c8 | —（to-watch list） | 20 titles → 25 titles | ✅ 真更新 |
| 11 | 6a27ffc2 | —（has completed） | 20 videos → 30 videos | ✅ 真更新 |
| 12 | ba61f0b9 | —（Rachel's team） | 10 people / half women → 6 women out of 10 | ✅ 真更新 |
| 13 | e66b632c | residence | the local area → the city of Oakdale | △ 地点细化，可算可不算 |

**计数**：槽位数 13 ≥ 10，验收③的**条数条件满足**；但去掉 3 条同值重复（#2/#4/#6）后是 10 个有不同值的槽位，其中 #3/#5 是同题（031748ae 与 _abs）的同一更新，去重后**独立真更新只有 6 条**（#7/8/10/11/12 + leads），加边界 #13 为 7 条。所以「≥10 条可人工确认的单值触发」成立，「≥10 条真实更新」不成立。为什么不再多：①v3 的 16 条 single 触发面里大量是 `plans to…` 被误判 single，v4 按词表判 multi 是正确性修正，不是收益损失；②真正的单值更新（favorite sauce、follower count、status/level、team size）大多没有对应 attribute（词表缺 `status`/`count`/`favorite`），只能走谓词键；③谓词逐轮改写时，无 attribute 就撞不上键（如 `favorite BBQ sauce is` vs `is currently obsessed with`，§23.5 例）。**这是词表边界决定的不可达，不是实现缺陷**；补 status/count/favorite 需要重抽 500-case 并重新量误标率，列为后续。

95-case 的 4 个槽位（2133c1b5 的 residence、031748ae 的 occupation/leads、603deb26 的同值重复）与之同形，只有 2 条真更新；两套语料结论一致：**single 槽位存在但稀薄**。

**被词表压掉的显式 single**（`suppressedSingleUnderMultiAttr`）：500-case 仅 14 条三元组、1 个多值槽位（852ce960 的贷款额度 $350k→$400k 被标成 plan/multi）。这是 ADR-0016 决定 3 的代价：multi 属性按词表不失效，即使抽取器写了 single。数量小，但说明「attribute > 显式」不是零成本；若后续发现更多此类，应调词表而不是反转优先级。

### 23.5 机制走查与真实案例

合成 3-turn 走查（`lives in Berlin` → `moved to Munich`，谓词不同、attribute 都是 residence）证明：v4 下两个谓词落到同一 `User|@attr:residence` 键，旧行 `valid_end` = 新行 `valid_start`，同 turn 的 `interest`（摄影）不被连坐；同 turn 重复值只留首见。无 attribute 时两键不同、不触发——这正是 #146 在真实语料只有 15% 重复率的原因，也是 #167 要补的缝。

真实 KU 例 `18bc8abd`（BBQ sauce）：`favorite BBQ sauce is Sweet Baby Ray's` → `is currently obsessed with Kansas City Masterpiece` → `favourite BBQ sauce is Kansas City Masterpiece`。v4 把三条都标成 `preference`（multi），因此**不失效**——语义上「最喜欢的酱」是单值，但词表把 preference 定为 multi，宁可少失效也不误失效。这是 23.4「真更新未达 10」的直接原因之一，也说明下一轮该补的是 `favorite` 这类属性，而不是把 preference 改 single。

### 23.6 LME90 配对（验收⑤）

口径与 §22.8 深池一致（n=90，manifest 90/500，candidates 32 / minScore −10.5 / candidateK 32 / 精排子进程，生成与判分 scm-flash），**只换抽取缓存为 facts-v4**。对照基线：#166 后新代码深池 **72.3% / 60.0%**（§22.8），#166 前 71.7% / 58.9%（§22.5）。

本臂命令：`bash scripts/run-r146-arms.sh v2deep-factrows-v4`（臂定义见脚本；与 `v2deep-factrows2` 逐位相同，只把 `--fact-cache` 换成 `.eval-data/bench/facts-cache-v4`，并把 `--fact-model` 改成缓存里的 `scm-flash` 以通过缓存校验）。日志确认 `promptVersion=facts-v4`、`cache=.eval-data/bench/facts-cache-v4`、`factRows=true`；灌库 90/90 零失败零重试，事实行 1656、覆盖 708 turn、失效 op 95、丢弃 2。

| 读数 | v2 深池基线（`*-factrows2-final.json`） | facts-v4 深池 | Δ |
|---|---:|---:|---:|
| turnCov@5 | 72.26% | **73.79%** | +1.53pp |
| 判对率（LLM judge, n=90） | 60.00% | **58.89%** | −1.11pp |
| sessionCov@5 | 88.67% | 90.33% | +1.67pp |
| MRR@5 | 72.54% | 72.91% | +0.37pp |
| 拒答率 | — | 30.0% | — |
| 检索延迟 p50 / p95 | — | 843ms / 2288ms | — |

**配对检验**（同一 90 题逐题配对，不是只看整体均值）：turnCov 逐题差 +1.48pp，配对 t=1.05（不显著）；判对 4 题变好、5 题变差，精确 McNemar p=1.0（不显著）。基线自身重算在 68.2%–72.3% 间摆动（`recount` 系列），1–1.5pp 的差异落在重复跑噪声内。

**结论**：LME90 深池**没有可检出的回退**（turnCov 点估计 +1.5pp、判对 −1.1pp，统计上都不显著），但也**没有可检出的收益**——与 23.3 的 single-only 判死一致。验收⑤的「不回退」按「无显著回退」记录，不把 +1.5pp 说成收益。

### 23.7 开关、兼容与残留

| 项 | 值 |
|---|---|
| 生产开关 | 仍随 `memory.write.factRows.enabled`（缺省 false）；本票不新增开关 |
| 提示词 | 生产 `l1-extraction.ts` 仅在 `includeTriples` 时出现 attribute 词表；缺省 FACTS_BLOCK 不含 attribute/cardinality/phrase，字节不变 |
| bench | `FACTS_PROMPT_VERSION = "facts-v4"`；v3 缓存不会被当成 v4（版本不匹配即重抽） |
| 旧数据 | 谓词键旧行不迁移、不被新 attribute 键失效；升级后旧库仍按旧口径。无 backfill |
| 表外值 | `normalizeFactAttribute` 返回 undefined，写侧回落谓词键与启发式；别名只收无歧义词形（city/location/relationship_status 故意不收） |
| 基数 | attribute > 显式 > fallback（含 `cardinalityDefault` 与谓词启发式）；词表单一源，读写共用 `resolveFactCardinality` |
| 可观测性 | attribute 随 `metadata.factTriples[0].attribute` 落库，不另设 `fact_attribute` 专键 |
| 未覆盖 | phone/email 在 500-case 从未出现，无法验证；TCVDB 后端仍不支持事实级失效（#146 遗留，本票未动） |

**残留（自觉放弃）**：①词表缺 status/count/favorite，真单值更新仍走谓词键（23.4）；②preference 等 multi 属性按词表不失效，即使语义单值（23.5）；③14 条显式 single 被 multi attribute 压掉（1 个槽位），是优先级选择的代价；④30 条抽样只有 83.3% 严格正确，4 类误标未修；⑤池化口径在 v4 下失真，票面尺子与真实触发面不一致，需票面/ADR 决定是否改口径。

### 23.8 复现

```bash
cd MemoryCore
# 全量/子集抽取（内网 shim：.eval-data/bench/llm-shim-v4，scm-flash）
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval --limit 500 \
  --facts-only --fact-cache .eval-data/bench/facts-cache-v4 \
  --fact-case-concurrency 6 --prod-data .eval-data/bench/llm-shim-v4
# 覆盖率 / top-N / 双口径重复率 / KU 槽位
node --import tsx scripts/audit/r167-attribute-metrics.mjs \
  --cache .eval-data/bench/facts-cache-v4 --out .eval-data/bench/r167-metrics-v4-500.json
node --import tsx scripts/audit/r167-attribute-metrics.mjs \
  --cache .eval-data/bench/facts-cache-v4-95 --out .eval-data/bench/r167-metrics-v4-95-final.json
# 30 条分层抽样（输出原 turn 文本 + 全部事实，人工判定）
node --import tsx scripts/audit/r167-attribute-sample.mjs --cache .eval-data/bench/facts-cache-v4-95
# LME90 深池配对（facts-v4 缓存；v4 缓存由 scm-flash 抽取，臂内把 fact-model 换成 scm-flash）
bash scripts/run-r146-arms.sh v2deep-factrows-v4
```

### 23.9 回归（验收⑤）

- 全量：`cd MemoryCore && npm test` → **290 files / 2710 tests passed**（14.24s）。
- 类型：`npm run typecheck`（`tsc -p tsconfig.typecheck.json`）当前仓库基线 243 个错误（generated schemas/gateway 等历史债）；本次改动文件 `fact-attribute|fact-row|supersession|fact-key|l1-extraction|r167` **零命中**，未新增错误。基线不绿，不能写「typecheck 全绿」。
- 针对性：`fact-attribute.test.ts`（7）、`fact-row.test.ts`（9）、`supersession-cardinality.test.ts`（8）、`bench-fact-rows.test.ts`（15）共 39 tests 全绿。



## 24. #146 收口后的读侧重判：证据宽度 / 币值口径 / 建议口径（2026-10-30）

§22.7–§22.8 的机制线（写侧事实级失效、值级遮蔽）在 LME90 深池只有 **+0.4pp 且不显著**；#166（present-intent 遮蔽）/ #167（抽取期 attribute）落地后机制完整，收益仍未证实。本节换问题：**读侧还有多少便宜收益**。做法是先用同一把尺子把六臂量齐（先修判分噪声，再逐因子归因），再用 gold 注入探针把「召回绑定」与「作答绑定」的损失分开，最后给出可上线的组合与落点。

### 24.1 先修尺子：判分噪声

scm-flash 判分偶发返回非 JSON，旧实现把它记成 correct=false，等于把「判分器格式抖动」记成「模型答错」。实测四个档各 1–5 题（judgeReason="judge-parse-failed"，4.4pp 量级），与 A/B 差值同量级——**此前所有「无显著差」的结论都建立在含噪读数上**。

修法（只补格式约束，不改判定口径）：

- scripts/lib/bench/llm.mjs：parseJsonLoose(raw)（原文 → 围栏内 → 首个花括号块）＋ JSON_REPAIR_NUDGE，json()/jsonWithUsage() 解析失败重问 ≤3 次，仍失败才返回 null。
- scripts/bench-rejudge.mjs：不重跑召回/生成，用旧报告里已存的答案按当前判分器重判（scripts/run-rejudge-noise.sh 串起三档）。

**噪声地板**（同批答案 raw → rejudge 的翻转题数）：A 2（升 2）、W 1（降 1）、P 1（降 1）、X 2（降 2）⇒ **1–2 题 = 1.1–2.2pp**。因此后文一律用**配对 McNemar** 读差值，且单看总判对率时要求差值 >2 题才算超过地板。

### 24.2 六臂总表（LME90 深池，同 store / 同判分器 / 同题集）

固定口径：整行基线冻结库 longmemeval-oracle-mvtavhl6（1591 记录 / 0 事实行）、--store --no-write-steps 复用、深池 --rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32、判分 scm-flash。臂间**只差读侧因子**。

| 臂 | 读侧变更 | 判对率 | 判对数 | 错题中拒答 | jpf |
|---|---|---:|---:|---:|---:|
| **A**-base | 整行，maxResults=5，旧提示 | 62.2% | 56/90 | 28 | 1 |
| **B**-mask | facts-v4 事实行 + 属性 + present-intent 遮蔽，k=5 | 63.3% | 57/90 | 27 | 1 |
| **C**-currency | 整行，k=5，**币值口径** | 64.4% | 58/90 | 23 | 0 |
| **W**-wide | 整行，**k=10**，旧提示 | 66.7% | 60/90 | 21 | 0 |
| **P**-pref | 整行，k=5，**建议口径** | 64.4% | 58/90 | 23 | 1 |
| **X**-best | 整行，**k=10 + 币值 + 建议** | **73.3%** | **66/90** | **16** | 2 |

配对 McNemar（vs A；b = A 对 X 错，c = A 错 X 对）：

| 对比 | b | c | p |
|---|---:|---:|---:|
| A → B（机制线） | 4 | 5 | 1.000 |
| A → C（币值口径） | 1 | 3 | 0.625 |
| A → W（k=10） | 4 | 8 | 0.388 |
| A → P（建议口径） | 3 | 5 | 0.727 |
| **A → X（三因子组合）** | **2** | **12** | **0.0129** |

单因子都不显著（各自 +1~4 题，落在噪声地板附近），**组合达到显著**：+10 题、p=0.013、拒答 28→16。原因是三个因子各自修的失败模式几乎不重叠（见 24.3–24.5），叠起来才越过噪声地板。

### 24.3 证据宽度（k=5 → 10）是最大单因子

逐题型（A / B / C / W / P / X）：

| 题型 | A | B | C | W | P | X |
|---|---:|---:|---:|---:|---:|---:|
| knowledge-update | 9/15 | 9/15 | 10/15 | 11/15 | 8/15 | **13/15** |
| multi-session | 3/15 | 3/15 | 2/15 | **5/15** | 3/15 | **5/15** |
| single-session-assistant | 14/15 | 14/15 | 14/15 | 14/15 | 14/15 | 14/15 |
| single-session-preference | 7/15 | 7/15 | 9/15 | 7/15 | **10/15** | 10/15 |
| single-session-user | 14/15 | 14/15 | 14/15 | **15/15** | 14/15 | **15/15** |
| temporal-reasoning | 9/15 | **10/15** | 9/15 | 8/15 | 9/15 | 9/15 |

宽度提升**不是在改排序，而是在补证据**——这点看覆盖率尺子最清楚（A → W）：

| 度量 | knowledge-update | multi-session | temporal-reasoning |
|---|---:|---:|---:|
| turnCov@10 | 0.533 → **0.667** | 0.447 → **0.580** | 0.644 → 0.622 |
| sessionCov@10 | 0.800 → **0.900** | 0.638 → **0.804** | 0.922 → 0.889 |
| mrr@5 | 0.767 → 0.767 | 0.739 → **0.661** | 0.647 → **0.500** |

即：**k=10 让更多 gold 证据落进注入块，但前 5 位排序反而变差**（多出来的行挤占 top-5 位次）。收益全部来自「证据在不在块里」，不来自「排得好不好」。注入块均值 blockChars 3277 → 5413（+65%，仍在 14000 上限内）。

副作用：temporal-reasoning 9→8（gpt4_85da3956、gpt4_65aabe59 由对转错，两条 cov@10 极低）、knowledge-update 的 4d6b87c8 也由对转错。这是「宽度换精度」的真实代价，不是噪声（X 臂里这两条同样没回来）。

### 24.4 币值口径（C 臂）

失败面在 §22.8 已定位：36 个错题里 27 个是**拒答**，而机制的整条思路是「少给证据」，方向与最大损失相反。币值口径只改读侧解释规则，不动检索/存储：

1. 提问日期晚于记录时间戳 **≠** 该记录失效（记忆是零散片段，不是连续同步）；
2. 属性有多条矛盾记录时取**时间最晚**那条；没有更晚记录时它**就是**当前状态；
3. 只有记忆里**完全没有**相关内容才拒答；有旧值也必须答，并标注「最后已知于 <时间>」。

读数：拒答 28→23、总判对 +2 题（KU +1、preference +2）。典型修复：a2f3aa27（"最近明确记录是 2023-05-28 有 1250 名粉丝；之后只提到接近 1300" → 旧口径直接拒答）、1cea1afa（"记忆只到 2023-05-25，无法确定现在"，而 gold 600 就是最后已知值）。

代价：b3c15d39（multi-session）由对转错——模型改成「若按 2 月 5 日下单则 5 天」的条件化回答，被判回避。币值口径倾向「给一个值」，遇到需要条件分支的题会过答。

### 24.5 建议口径（P 臂）

preference 15 题里 13 题 turnCov@5 = 1（证据齐全）却只判对 7 题——纯作答侧问题：模型要求「记忆里直接写着建议」才答，否则拒答。口径三条：

1. 建议类问题（tips / ideas / suggestions / 值得吗）的答案本来就在用户**已表达的偏好、习惯与既往选择**里；
2. 先复述相关既有偏好，再据此给建议，不要只给泛泛建议；
3. 只要记忆里有偏好线索，就不要拒答。

读数：preference 7 → **10/15**（重判后），六臂里**单题型最大涨幅**（+20pp），总判对率 +2 题；其它题型基本不动（KU 9→8 在噪声地板内）。这条口径与宽度、币值互不替代——X 臂里 preference 仍是 10/15，与 P 臂相同，说明它已把这一类打满。

### 24.6 gold 注入探针：把两类损失分开（上限口径）

把 A 臂 34 个错题的 **gold 证据轮直接补进已构造的 block**（平均补 1.0 轮，共 35 条），再重新作答+判分。这不是可上线手段，是**上限测量**：

| 题型 | 错题数 | 补全后转对 | 平均注入 | 仍拒答 |
|---|---:|---:|---:|---:|
| multi-session | 12 | **9** | 1.3 | 1 |
| temporal-reasoning | 6 | **5** | 1.3 | 1 |
| knowledge-update | 6 | 3 | 1.0 | 3 |
| single-session-preference | 8 | **1** | 0.4 | 6 |
| single-session-assistant | 1 | 1 | 1.0 | 0 |
| single-session-user | 1 | 1 | 1.0 | 0 |
| 合计 | 34 | **20（58.8%）** | 1.0 | 11 |

结论很干净：

- **multi-session / temporal-reasoning 是召回绑定**（9/12、5/6 可转换）——证据一到就能答，这正是 24.3 宽度因子生效的原因；它仍有余量（W 臂只把 multi 从 3 提到 5）。
- **preference 是口径绑定**（1/8）——补证据几乎无效，因为 gold 从来不写在记忆里，只能靠 24.5 的口径修。
- **knowledge-update 是混合的**（3/6）：注入后仍拒答的 3 条（a2f3aa27、1cea1afa、22d2cb42）块里已有答案数值，模型仍说「无法确定当前值」——这正是币值口径要治的，也是 X 臂 KU 9→13 的来源。
- 剩余不可转换项另有性质：71017277（把「吊灯」当「珠宝」实体错配）、efc3f7c2（"周五 6:30 与其他工作日相同，早 0 分钟"算术口径）、gpt4_ab202e7f（空答）。不是检索或口径能修的。

### 24.7 机制线的最终判词

A → B（facts-v4 属性键 + present-intent 值级遮蔽，即 #166+#167 的读侧效果）：4 对 / 5 错，**p = 1.000**。结合 §22.7（+0.4pp）、§23.6（#167 p=1.0）与本节：

> 「写侧事实级失效 / 读侧值级遮蔽」在 LME90 上**没有可测收益**，且作用方向（删/压证据）与最大损失（证据不足导致的拒答，27/36）相反。作为能力保留（factRows / supersession 缺省关，ADR-0015/0016 不动），但不作为 LME 收益来源，也不再往这条线追加预算。

### 24.8 最优算法（当前证据下的最优读侧组合）

**更多证据 + 两条口径解释规则**，即 X 臂：

| 因子 | 落点（生产） | 单因子 | 组合贡献 |
|---|---|---:|---|
| 证据宽度 maxResults 5 → 8~10 | config.ts:2066 缺省 5（auto-recall.ts:1073/1720 同源读取） | +4 题 | +10 题（与口径叠加后） |
| 币值口径 | recall.injectWrapper 新档（auto-recall.ts:2044 wrapperHead） | +2 题 | — |
| 建议口径 | 同上 | +2 题 | — |
| 写侧失效 / 遮蔽 | 维持缺省关 | +1 题（不显著） | 不采用 |

X 臂：**73.3%（66/90），拒答 28→16，A→X McNemar p=0.0129**，注入块 +65%（3.3k → 5.4k 字符）。TR 与 assistant 两类无涨无跌（因子不伤它们）；multi-session 已触及「宽度」这一杠杆的上限附近（5/15，探针显示还有 9/12 可转换空间 ⇒ 下一轮若继续，方向是**多会话/跨会话的证据聚合**，而不是继续加宽 k）。

### 24.9 生产落点（全部 config 门，不改缺省行为）

1. **recall.injectWrapper: "calibrated"（新增档位）**：在 auto-recall.ts:2044 的 wrapperHead 里加币值 + 建议两条口径。现行 legacy 文案「仅作为参考」与 neutral 文案「若记忆不足以回答，请如实说明」都会诱导保守拒答，而 27/36 错题正是拒答。
2. **recall.maxResults 建议档 8–10**：缺省仍 5（token 成本敏感），在长任务/研究型会话配置档位拉到 10。代价可量化：注入块 +65%，仍在 maxTotalRecallChars 安全区。
3. **memory.write.factRows / supersession 维持缺省关**（ADR-0015/0016 决定不变）。
4. **不动的**：检索通道（hybrid/RRF）、rerank 32 档、injectTimeSort（§22.5 的 +15.6pp 是另一条独立杠杆，与本组因子正交）。

### 24.10 复现

~~~bash
cd MemoryCore
CORE="--dataset longmemeval --manifest .eval-data/bench/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
SHIM="--prod-data .eval-data/bench/llm-shim-scm"     # scm-flash 凭据 shim，绝不入库

# 六臂（复用冻结库，只变读侧）
node --import tsx scripts/eval-memory-bench.mjs $CORE $DEEP --store <mvtavhl6> --no-write-steps $SHIM
node --import tsx scripts/eval-memory-bench.mjs $CORE $DEEP --store <mvtavhl6> --no-write-steps $SHIM --recall-max-results 10
node --import tsx scripts/eval-memory-bench.mjs $CORE $DEEP --store <mvtavhl6> --no-write-steps $SHIM --currency-prompt
node --import tsx scripts/eval-memory-bench.mjs $CORE $DEEP --store <mvtavhl6> --no-write-steps $SHIM --pref-prompt
node --import tsx scripts/eval-memory-bench.mjs $CORE $DEEP --store <mvtavhl6> --no-write-steps $SHIM --recall-max-results 10 --currency-prompt --pref-prompt

# 消噪重判（同一把尺子）
TDAI_DATA_DIR=<mvtavhl6> node --import tsx scripts/bench-rejudge.mjs <report.json> --out <report>-rj.json

# gold 注入上限探针
TDAI_DATA_DIR=<mvtavhl6> node --import tsx scripts/bench-oracle-probe.mjs --report .eval-data/bench/lme90-r146-r146v2-deep-rj.json --scope fails
~~~

报告：lme90-r146-r146c-{base,wide,pref,best}.json 及 *-rj.json、oracle-probe-fails.json，均在 MemoryCore/.eval-data/bench/。

### 24.11 边界

- 90 题单档、单判分器；噪声地板 1–2 题。X 的 +10 题远在板上，但单因子结论（C/P/W 各自 +2~4）只在方向上成立。
- bench 的「答案提示」是生产读侧口径的**代理**，宿主侧（真实 agent 拿到注入块后的行为）是否同样生效需生产埋点复核——这条已在 §24.9 落成 config 档位，默认不生效，可灰度。
- 私有微基准（30–50 条单值身份属性 + 真实 l1-writer/sqlite）仍未建；机制线的「无收益」结论只对 LME90 成立，对「长期运行、真更新密集」的生产语料未证伪。

---

## §25 召回算法与数据结构的最优性审计（#146 收口后）

> 口径：LME90（`--manifest .eval-data/bench/lme-manifest.json`）、同库 `longmemeval-oracle-mvtavhl6`（1591 记录 / 0 事实行）、`--no-write-steps`、深池精排（`--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc`）、`--prod-data .eval-data/bench/llm-shim-scm`、判分 scm-flash 且全部经 `bench-rejudge` 重判（`-rj`）。噪声地板 = 同批答案 raw→rejudge 翻转 1–2 题（1.1–2.2pp）。
> 本节问题来自用户原话：「这是最优的召回算法和数据结构么，你再好好分析一下，结合所有相关的配置项和逻辑，哪些是无效的需要清理的」。

### 25.1 结论（先给判定）

1. **不是最优，但瓶颈已经不在检索通道。** 90 题里 88 题的 `sessionCov@10 == sessionCov@5`；10 个「证据不全」题在 k=1/3/5/10 上覆盖率完全不变。加宽检索、放余弦门槛（`--emb-threshold 0.15`）在配对子集上都不改变判对数（18/30 vs 18/30，b2/c2）。检索侧已到该语料的饱和点。
2. **当前最大的结构性缺陷是「注入单元 = 单条 turn，且没有相邻轮扩展」。** X 臂 24 个错题里 14 个「gold 会话全在块里」（`sessionCovInjected=1`），其中 10 个 `turnCovInjected<1` —— 会话对了、那一轮没进来。仓库里唯一做「摘要→源证据」扩展的 `smallToBig` 只挂在**结论卡**上（`auto-recall.ts:1377-1500`，循环对象是 `r7Conclusions`），而本语料 `conclusionCount=0/90`（`ingest.conclusionsWritten=0`），所以这条扩展路径在此压根不触发。
3. **答案侧口径是已被证实的最大单因子杠杆**（+10.1pp，`p=0.0129`），而「把注入块重新编排 + 要求先做笔记」**不能提升，且会引入硬故障**：Y 臂 9/90（10%）空答/截断，在能作答的 81 题上与 X 无差异（61 vs 60，`b0/c1`）。见 25.4.4 的更正（先前记成「−6 题、`p=0.031`」是把空答当错答算出来的，已撤回）。也就是说：给模型更多结构/更多步骤不划算，给模型**更全的证据 + 更少诱导拒答的措辞**才划算。
4. **配置面有一半是噪音**：104 个 recall 键里承重 5 / 中性 38 / 无证据 45 / 死码 16；另有 9 处「缺省值三处不一致」（注释 / 解析产物 / 消费点），2 处文档承诺的档位根本没实现。
5. **代码面有约 300 行两基线皆不可达的死码**（事实行投影 + `fact-turn.ts` 遮蔽路径），其输入 `metadata.fact_of` 在 `write.factRows=false`（`write-policy.ts:77`）下生产恒空。

### 25.2 三套「基线」必须先对齐，否则任何 KPI 都不可比

| 基线 | 位置 | 关键差异 |
|---|---|---|
| 代码缺省 | `config.ts` 解析 + `defaults.ts` | `foldClusterEnabled=false`、`rerank.enabled=false`、`smallToBig.enabled=false`、`validity.mode=hard` |
| 本地 yaml（bench 用它） | `MemoryCore/tdai-gateway.yaml` | `foldClusterEnabled: true`(:156)、`rerank` 开、`routing: assistantRecall`(:260)、`timeProxFallbackEnabled: true`(:271)、`graph/scene/coreRef` 全 0、`validity` soft |
| 云部署 | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | 与本地 yaml 同档（:146/:236/:247），`validity` hard |

结论：**本文件所有 §24/§25 读数都是在「本地 yaml」档下测的**，它同时开着两套折叠（`foldNearDuplicates` 无条件 `auto-recall.ts:2040`，F-CLUSTER v2 受 `foldClusterEnabled` 门控 `:2665`）。生产云模板与之在 `validity.mode` 上不一致，这一点在 §21.3 台账里写反过（记为「代码缺省 soft」，代码实为 hard，`config.ts:2156`）。

### 25.3 数据结构判定

**现状**（`sqlite.ts:766-786`）：一张 `l1_records`（`record_id / content / type / priority / scene_name / session_key / session_id / timestamp_str|start|end / created_time / metadata_json`）+ 两套索引面 `l1_fts`（BM25，27 列）+ `l1_vec`（vec0 余弦），事实键另有平行表 `l1_fact_vec`（`:1038`）。**一条记忆 = 一个对话 turn**。

| 判定 | 证据 | 结论 |
|---|---|---|
| D1 事实行双写不值得 | `#146` 三臂：整行 62.2% / 事实行 v2 58.9% / 属性+遮蔽 58.9%，McNemar `p=1.0`；事实行让记录数 1591→2539（+60%），多一套折叠与 `@attr:` 键 | 抽出器保留（`#167` 的身份属性能力有独立价值），**存储面降级为 turn 行的注解**（`metadata.factTriples` 已经在了），撤销「一条事实一行」的并行表与投影 |
| D2 注入单元过细 | X 臂 14 个「会话全覆盖」错题里 10 个 `turnCovInjected<1`；oracle 探针把这 10 个里的 6 个在注入 gold 轮后转对 | **单元应为「turn + 同会话相邻窗」**，不是单 turn |
| D3 邻接信息已经存在，不需要改表 | `l1_records.session_id` + `timestamp_str/timestamp_start`（`sqlite.ts:766-786`），`L1QueryFilter.sessionId`（`types.ts:167-176`）已能按会话取行 | 相邻扩展是**纯读侧改动**，零迁移成本 |
| D4 折叠两套并存（本语料下无损） | 三臂逐题 `hits == injectedLines`（90/90，平均丢 0.00 条）；`dupTurnHits/expandedHits=0/90`（flag 未开，开档实测 34.4%/85.6%） | 折叠逻辑在本语料是 inert 的：不产生损失，也不产生收益，属于「该删的复杂度」而非「该调的参数」 |
| D5 `fact_index` 写而不读 | 全仓唯一写入点，零读取点（`audit-dead-code.md` D 节） | 纯冗余列 |

### 25.4 算法判定

#### 25.4.1 有效候选池本来就很小（k 不是闸门）

k=10 时 `hits` 分布：**2 条 33/90、3 条 13、4 条 7、5 条 7、6 条 7、7 条 6、8 条 6、9 条 4、10 条 7**；`hits<k` **83/90**。k=5 时均值 2.88，k=10 时 4.51。也就是说「行预算」在这份语料上从未被用满 —— 把 `maxResults` 5→10 的收益来自「把剩下的 1–2 条也装进来」，不是「预算更宽」。

放宽余弦门槛（`--emb-threshold 0.15`，30 题配对子集）：判对 18 vs 18（b2/c2）、池 5.07 vs 5.57、`sessionCovInjected` 0.886 vs 0.852、`turnCovInjected` 0.584 vs 0.623 —— **门槛不是截断者**，放宽只会换掉池内组成。

#### 25.4.2 加宽检索已饱和

88/90 题 `sessionCov@10 == sessionCov@5`；10 个「证据不全」题（`a2f3aa27 ba61f0b9 61f8c8f8 157a136e 129d1232 gpt4_ab202e7f ba358f49 gpt4_f49edff3 cc6d1ec1 gpt4_65aabe59`）在 k=1/3/5/10 上 `sessionCov` 逐档相同（例如 `a2f3aa27` 恒 0.50、`61f8c8f8` 恒 0.50）。缺的那条会话**从不进入候选池**，靠 k 救不回来。

#### 25.4.3 剩余损失的形状（X 臂 66/90）

| 证据（`sessionCovInjected`） | 判对 | 判错（其中拒答） |
|---|---|---|
| 全（=1） | 63 | **14（9）** |
| 不全（<1） | 3 | 10（7） |

24 个错题里 **16 个是拒答**；拒答题的 `evidenceSufficiency` 分布：`=0` 10 个（真无证据）、有部分证据 5 个、`=1` 1 个。⇒ 剩余损失第一是「证据在手仍拒答/答错」（14），第二是「证据没拿到」（10）。

#### 25.4.4 证据编排：不提升 + 10% 空答（Y 臂，含口径更正）

在 X（k=10 + 币值 + 建议口径）之上再加「按日期分组 + 证据清点 + 先整理再答」（`buildAnswerPromptMarshalled`）：表面读数 **60/90 = 66.7%**（X 为 73.3%）。但逐行核对发现 **9/90（10%）是空答**——模型把输出全花在「笔记：」上，没走到「答：」，判分器如实记为「回答为空」。其余五臂空答率是 0–1/90，只有 Y 是 9/90。

**更正（本文件自查，撤回先前口径）**：先前把空答当错答，得出「对 X 是 `b0/c6`、`p=0.031` 的负结果」，这个 `p` 值不成立。在能作答的 81 题配对子集上：**X 61 vs Y 60，`b0/c1`，无差异**；真正的 6 个退步（`2133c1b5 031748ae 1c0ddc50 b6025781 gpt4_85da3956 gpt4_af6db32f`）里 5 个是空答，第 6 个（`1c0ddc50`）的答案是**在「笔记」中途截断**，同样没写完结论。

结论改写为：**「让模型先整理笔记再答」不提升质量，但会以 10% 的概率把输出耗在笔记上、拿不到结论**——在生产上是硬故障，不是风格问题。所以挡掉它的理由不是「答得更差」，而是「有 10% 概率不答」。逐题型表面数字（KU 13→11、preference 10→8、TR 9→7）同样是空答污染，不作结论。

#### 25.4.5 六臂总表（含本节新增两臂）

| 臂 | 变更 | 判对 | 拒答 | vs A |
|---|---|---|---|---|
| A | 整行 k=5，旧提示 | 56/90 62.2% | 28 | — |
| B | 事实行 v4 + present 遮蔽，k=5 | 57/90 63.3% | 27 | b4/c5 p=1.0 |
| C | k=5 + 币值口径 | 58/90 64.4% | 23 | b1/c3 p=0.625 |
| W | k=10，旧提示 | 60/90 66.7% | 21 | b4/c8 p=0.388 |
| P | k=5 + 建议口径 | 58/90 64.4% | 23 | b3/c5 p=0.727 |
| **X** | **k=10 + 币值 + 建议** | **66/90 73.3%** | **16** | **b2/c12 p=0.0129** |
| Y | X + 证据编排 | 60/90 66.7%（**9 题空答**；可作答 81 题上 60 vs X 61，b0/c1） | 13 | 无差异，但 10% 空答 → 不可用 |
| T | X + 余弦 0.15（30 题子集） | 18/30（X 同 18/30） | 6 | b2/c2 |

#### 25.4.6 延迟结构（audit 读数，A 臂 k=5）

检索 p50 1282 ms / p95 2454 ms；其中 embedding 占 94.8%（中位 167 ms）、fts 5.1%、**fact 通道 0.07%（0.118 ms，`factHits=0` 空查）**、expand 恒 0；精排 473 ms ≈ 端到端 p50 的 65%。⇒ 索引结构优化对延迟几乎无收益，真收益在精排批处理/缓存与「关掉空转通道」。

### 25.5 无效项清单（按处置分级）

#### A 直接删（无产品决策，纯减法，~300 行）

| 位置 | 内容 | 为什么可删 |
|---|---|---|
| `auto-recall.ts:3752-3788` + `fact-turn.ts:107-190` | 事实行投影 + present-intent 值级遮蔽（`collapseFactRowsByTurn`） | 唯一输入 `metadata.fact_of` 由 `write-policy.ts:77`（`factRows: false`）关闭，两基线皆不可达；#166 的收益在 LME90 上 `p=1.0` |
| `auto-recall.ts:1849-1900` + intent 矩阵 `:1393-1395 / 1520 / 1598 / 1761-1763` | turn-first 装配 + `routing:"intent"` 策略矩阵 | 需要 `routing:"intent"`，全仓零配置、零测试 |
| `auto-recall.ts:3664-3675` | `supersededRows` 每轮整池计算后丢弃 | 真·空转：结果只被死分支读 |
| `auto-recall.ts:3676-3705` | soft 失效块 | 与「硬过滤 + `validity.mode=hard`」并存，生产永远走不到 |
| `auto-recall.ts:2036`（`injectTimeSort`）、`:2041`（`injectWrapper` 的 legacy/neutral 双档） | 注入排序与包裹语分支 | 两基线都取默认值，分支不可达（包裹语若要动，就按 §24.9 新增 `calibrated` 档，而不是留两档） |
| `fact_index` 列 | 只写不读 | 见 D5 |

#### B 「开着的但恒不生效」的配置（16 个死码键）

| 键 | 现状 | 判定 |
|---|---|---|
| `ageDecay.*` / `timeProxFallbackEnabled` | yaml 开，但 `rerankWeights.timeProx=0`（`tdai-gateway.yaml:212`）使乘子根本不计算（`memory-search.ts:676-681`） | 文档 §5b bit-identical；要么删键，要么把 `timeProx` 权重设非零再测 |
| `rerank.minScore = -10.5` | 实测候选分全在 [−10.18, +10.28]，恒不触门 | 名存实亡的闸；k 才是闸 |
| `maxCharsPerMemory` / `maxTotalRecallChars` 双 0 | `auto-recall.ts:4011` 提前 `return lines` | 字符预算整条通道从未生效；若设 6000，A 臂 10/90、X 臂 30/90 会被截 |
| `importantPenalty`（`importancePenalty`） | 罚中 **0/90 题、0/1644 行**，乘子恒 1 | 未生效 |
| `nativeMinRRF` | sqlite 后端不可达，yaml 仍设 0.016 | 删或注明仅 native 路 |
| `graphDiscount / sceneBoost / coreRefBoost` = 0 | 三个补池通道全关 | 已显式关；对应 `ppr*` / `sceneBoost` 派生键一起清 |

#### C 缺省值三处不一致（9 条，最容易再犯的一类）

- `ftsOnlyInjectCap`：接口注释「缺省 2」（`config.ts:508`）→ 解析产物 `undefined`（`:2320`）→ 真实值 2 藏在消费点（`auto-recall.ts:1843`）。
- `validity.mode`：§21.3 台账写「代码缺省 soft」，代码实为 `hard`（`config.ts:2156`）；本地 yaml soft、云模板 hard。
- `maxConclusions`（运行期 `floor(maxResults/2)`）、`conclusionLayer.rerankGate.minScore`（−1）、`cacheTtlMs` 同类。
- `injectWrapper` 的 `"calibrated"` 档：§24.9 承诺的落点，**类型与解析只有 legacy/neutral**（`config.ts:496`）——承诺未实现。

#### D 无证据 / 中性键（38 + 45 = 83 个）

45 个键在 docs 全库零命中、bench 快照也无对照（`foldClusterEnabled` 之外的一批 `ppr*/mood*/scene*/emotion*` 派生键占多数）；38 个测过但差异落在地板内。**处置建议**：不急着删（删键会破坏老 yaml 兼容），而是在 `config.ts` 接口上加 `@evidence` 注释（§号 / 「无对照」），并把「无证据」列进 `docs/agents/` 的复核清单，避免下一轮又对着这些键做「调参」。

#### E 插桩空转（会让所有后续读数失真）

- `lineTypeStats`：`raw-turn 259/259 = 100%`，conclusion / evidence-recall / unknown 各 0 行 —— 抽掉 raw-turn 覆盖率归零，全链只有一层在产出。
- `conclusionCount=0/90`（`ingest.conclusionsWritten=0`）、`layered=true 0/90`、`experienceCount>0 90/90`。
- `unresolved=0` / `hasEvidence=true` 在 90 题恒值：语义是「turn id 解析失败数」和「数据集有无标注」，**结构上永不报警**，不能当召回告警用。真缺口要靠 `turnCovInjected`（X 臂 76.7%）与 `evidenceSufficiency=0`（18/90）。
- 折叠没有插桩字段，但本语料 `hits == injectedLines`（零损失）；`dupTurnHits/expandedHits` 在 bench 里恒 0（flag 未开，开档 34.4% / 85.6%）。

### 25.6 最优算法提案（按「已验证 / 待验证」分开）

**已由本文件读数支持、可直接定档的（读侧）：**

1. `recall.maxResults = 8–10`（§24 已测：+4.5pp 单独、+10.1pp 与口径合用时）。
2. 答案口径三件套：币值判定 + 建议口径 + 「仅在完全无相关行时拒答」。已在 `llm.mjs` 落成 `buildAnswerPromptTuned`（X 臂）。
3. 注入包裹语改「calibrated」：现行 legacy「仅作为参考」/neutral「若记忆不足以回答，请如实说明」都在诱导拒答（X 臂仍有 6 个「有证据但拒答」）。**这条要先实现档位**（`config.ts:496` 目前只有两档）。

**最强候选、但尚未实现（下一张票的正当内容）：**

4. **证据包（turn + 同会话相邻窗）**：对每条入选 turn，按 `session_id` 取同会话相邻轮（±1 或整会话 ≤6 轮），按 `timestamp_str` 排序，占用「上下文行」预算（`smallToBig.maxExtraLines` 已有的账本口径）。预期上限 **≤6 题 = ≤6.7pp**（oracle 探针里 10 个 `turnCovInjected<1` 的错题，注入 gold 轮后转对 6 个），实现零迁移（D3）。
5. **把 `smallToBig` 从「结论卡专用」升级为「命中行通用」**：当前它的循环对象是 `r7Conclusions`；改成「结论卡 → part_of 证据」+「raw turn → 同会话相邻轮」两路同一预算池，是本提案的最小改动形态（`auto-recall.ts:1377-1500` 一处扩写 + 一个 `adjacencyProbe` 注入点）。
6. **行预算 → 充分性判定**：以 `sessionCovInjected / turnCovInjected / evidenceSufficiency` 为运行期信号，不足时触发二次检索（查询改写或邻接扩展），而不是继续加 k（§25.4.2 已证明加 k 饱和）。

**已否证，不要再试：**

7. 加余弦门槛/放宽余弦门槛、加大 k、事实行双写、present-intent 值级遮蔽（作为 LME 收益来源）、「先整理笔记再答」这类结构指令（不提升，且 10% 概率不答）、`timeProx`/`ageDecay` 这类「开着但乘子为 0」的键。

### 25.7 复现

```bash
# X 臂（最优已测档）
cd MemoryCore && node --import tsx scripts/eval-memory-bench.mjs \
  --dataset longmemeval --manifest .eval-data/bench/lme-manifest.json --pace 150 --gen-limit 90 \
  --recall-ks 1,3,5,10 --embed-interval-ms 1200 \
  --rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc \
  --prod-data .eval-data/bench/llm-shim-scm \
  --store <store> --no-write-steps --recall-max-results 10 --currency-prompt --pref-prompt \
  --tag r146c-best --report-name lme90-r146-r146c-best

# Y 臂（不提升 + 10% 空答）：在 X 基础上加 --marshal-prompt
# T 臂（余弦放宽）：在 X 基础上加 --emb-threshold 0.15
# 一轮重判：TDAI_DATA_DIR=<store> node --import tsx scripts/bench-rejudge.mjs <report> --out <report>-rj.json
```

三份审计原文（随本节一并入库）：[2026-10-30-recall-config-surface.md](audit/2026-10-30-recall-config-surface.md)（104 键四档判定 + 缺省三处不一致台账）、[2026-10-30-recall-dead-code.md](audit/2026-10-30-recall-dead-code.md)（A/B/C/D 四节，全部带 `file:line`）、[2026-10-30-recall-instrumentation.md](audit/2026-10-30-recall-instrumentation.md)（触发率/行类型/耗时/预算 8 节）。

### 25.8 边界

- 单语料（LME90）、单判分器；除 X 臂外，其余臂的差值都在或接近噪声地板（1–2 题）。Y 臂的「负结果」在逐行核对后已改口径（不是答得更差，是 10% 空答/截断），这正是为什么所有臂都必须查空答率与 `judgeReason`，而不能只看聚合判对数。
- 「证据包」的 ≤6.7pp 来自 oracle 探针（直接注入 gold 轮）的**上限**，真实实现要付「同会话噪声轮」的代价，实测低于此值属正常。
- 本节判的是「LME90 上的召回算法与数据结构」；生产语料（长会话、真更新密集）不在此列，§24.8 的私有微基准仍然欠着。
- 顺带留档：本次 `npm run typecheck`（`tsconfig.typecheck.json`）在 main 上是红的——243 个 `error TS` 分布在 45 个文件（`src/utils/pipeline-factory.ts`、`src/core/store/sqlite.ts`、`src/gateway/*` 等），全部与本节改动无关（本节只动 `scripts/*.mjs` 与文档）；`npm test` 290 files / 2710 tests 全绿。即「测试绿 + 类型红」的既有负债，清理时应单开一张票处理，别混进召回改动。

---

## §26 我们的分数处在什么位置（与公开数字、mem0 的可比性换算）

> 问题来自用户：「按你的优化方案优化后，我们的评分能到达什么层次，和 mem0 等这种比还差什么」。
> 本节只做口径换算与差距定位，不引入新实验；所有我方数字取自 §24/§25 的同一 harness。

### 26.1 先泼一盆冷水：我们的分数不能直接贴上榜单

| 维度 | 本 harness（§24/§25） | 榜单口径（LongMemEval 论文 / mem0 论文） |
|---|---|---|
| 数据切分 | `.eval-data/longmemeval_oracle.json`（**oracle 变体**：每题的 haystack 只有 1–6 个证据会话，均值 1.9） | `LongMemEval_S`（每题约 115k token 的可扩展历史）；LOCOMO 为长对话全集 |
| 存储 | 90 题的证据会话**池化**成一个库（1591 记录），彼此的会话互为干扰项 | 每题独立历史，无跨题干扰 |
| 题量与配比 | 90 题，**六题型各 15**（均衡） | 500 题，temporal 133 / multi-session 133 / KU 78 / user 70 / assistant 56 / preference 30 |
| 判分 | scm-flash + 中文判定理由；噪声地板 1–2 题 | LongMemEval 用 gpt-4o-2024-08-06（与人一致率 >97%）；mem0 用 LLM-as-Judge |
| 写入 | `--no-write-steps`（复用冻结库，跳过生产写入链） | 完整 index→retrieve→read（含在线写侧） |
| 提示 | 币值/建议口径**是在这 90 题上看出来的** | 未见过的题 |

⇒ 我们的 73.3% 与「LongMemEval_S 60.6%」不是同一把尺；直接比会**系统性地高估**（oracle 证据会话 + 均衡配比里偏好/用户题占比被放大，而这两类我们近乎满分）。

### 26.2 按官方配比换算（同一题型难度假设下的估计）

把 X 臂的逐题型判对率按官方 500 题分布重算：

| 臂 | 均衡 90 题 | 官方 500 配比换算 |
|---|---|---|
| A 整行 k=5 | 62.2% | **57.3%** |
| X k=10+币值+建议 | 73.3% | **66.8%** |
| 计划落地·保守（multi +1、TR +1） | — | **70.3%** |
| 计划落地·中位（multi +2、TR +1、KU +1、pref +1） | — | **73.6%** |
| 计划落地·乐观（multi +3、TR +2、KU +1、pref +1） | — | **77.1%** |

含义：**官方配比下 multi-session（26.6%）+ temporal（26.6%）合计 53% 的权重，正好压在我们最弱的两个格子上**（X 臂 multi 5/15、TR 9/15）。均衡 90 绕过了这件事，所以我们内部看到的 73.3% 偏乐观 8–9pp。

### 26.3 与公开数字对照（不同语料，只作定位）

**LongMemEval 论文（LongMemEval_S，GPT-4o）**：全上下文直接读 0.606（加 Chain-of-Note 0.640）；Oracle 证据 0.870/0.924；ChatGPT（记忆功能）0.5773；Coze+GPT-4o 0.3299；Llama 3.1 70B 全上下文 0.334。

**mem0 论文（LOCOMO，LLM-as-Judge，越高越好）**：

| 系统 | J 分 | tokens/题 | p95 延迟 |
|---|---|---|---|
| Full-context | **72.90** | 26,031 | 17.1 s |
| Mem0^g（图） | 68.44 | 3,616 | — |
| Mem0 | 66.88 | 1,764 | 1.44 s |
| Zep | 65.99 | 3,911 | 2.93 s |
| LangMem | 58.10 | 127 | 60.4 s |
| OpenAI memory | 52.90 | 4,437 | 0.89 s |
| A-Mem | 48.38 | 2,520 | 4.37 s |

两个信号：
1. **全上下文仍然是准确率天花板**（LOCOMO 72.90 > 所有记忆系统；LME_S 上 0.606 也高于 ChatGPT 0.5773）。记忆系统的价值不在「比全上下文更准」，而在「用 1/15 的 token、1/12 的延迟」拿到 92% 的质量。
2. 这与我们在 §25 的发现同向：**读侧能力（证据是否够、口径是否诱导拒答）决定上限，检索通道早已饱和。**

### 26.4 与 mem0 相比，我们还差什么

| 差距 | 我们的现状 | mem0 的做法 | 影响 |
|---|---|---|---|
| **写侧在线固化** | `supersession.enabled=false`、`factRows=false`（`write-policy.ts:77`），一轮一条 turn，无 consolidation；bench 还跳过写入链 | LLM 抽取 + 增量 add/update/delete + 冲突消解 | 长会话会退化（旧值/重复值堆积）；我们没有这类实测，是最大盲区 |
| **实体/关系结构** | `graphMinStrength=0.5` 但 `graphDiscount=0`、`coreRefBoost=0`、`sceneBoost=0`，PPR 通道未用；无实体解析 | Mem0^g 用图存关系（+1.5pp，multi-hop 51.15） | 多会话聚合/跨会话指代是我们最弱的格子（5/15） |
| **多会话聚合** | 33%（5/15）；错误里 11/15 是两条 gold turn 只召回一半 | multi-hop 专门优化 | 官方权重 26.6%，直接压分 |
| **成本口径** | X 臂注入块 5,364 字符，检索 p50 1.28 s / p95 2.45 s（embedding 占 94.8%）+ 精排 473 ms | 1.76k token、p95 1.44 s | 我们的「便宜」没被量化，也就没有可对外讲的成本优势 |
| **评测面** | oracle 切分 + 池化 + 自选 90 题 + 自调提示 | `LongMemEval_S` / LOCOMO 全量 | 无法与任何人同尺比较 |

我们**比 mem0 强/更靠得住的地方**：① turn 粒度已被 LongMemEval 作者独立验证（其 Finding 1：round 是最佳粒度，压成 user facts 反而整体变差——与我们 D1/D2 完全一致）；② 时序字段（`timestamp_start/end`、`occurred_at`）是存储层内建，不是后抽取；③ 偏好/时序两类口径在 LME90 上已达 10/15、9/15，而这两类正是记忆系统的传统弱项。

### 26.5 结论：能到的层次

- **本 harness（均衡 90、oracle 池化、scm-flash）**：73.3% → 计划落地 **78–82%**；上限约 85%（preference 受「建议类」判分口径限制，multi-session 受算术与半召回限制）。
- **官方 500 配比换算**：66.8% → **70–74%**（保守 70.3 / 中位 73.6）。这是「若把同样的逐题型能力放到官方配比上」的估计，不等于 LME_S 榜单分。
- **放到榜单语境**：与 LongMemEval 论文里 GPT-4o 全上下文（0.606/0.640）大致同档、略高；与 LOCOMO 上的 mem0（66.88）不在一个语料，只能算「同一量级」。**要拿到可对外声明的数字，必须补跑 `LongMemEval_S` 全 500 + 官方 gpt-4o 判分器**。
- **真正的产品差距不在准确率，在写侧**：mem0 的卖点是「1/15 token 拿到 92% 质量 + 在线增量更新」；我们目前只有读侧，写侧的固化/冲突消解缺省是关的，也没有长会话退化实验。下一步若要做「比 mem0 好」，战场应选「长会话不退化 + 成本可量化」，而不是 LME90 上再多两个点。

### 26.6 后续票分派（2026-10-30 落票，含与未关闭票的冲突对账）

按 §26.4 的五条差距 + §25.5 的无效项分派，全部标签 `ready-for-agent`：

| 票 | 标题要点 | 对应的差距 / 依据 | 预估上限 | 依赖 |
|---|---|---|---|---|
| [#168](https://github.com/cxin21/tdb-hechen/issues/168) | 长会话退化基准 + 写侧固化实测 | §26.4 差距① | 未知（决定固化缺省） | 可引用 #153 门禁，不阻塞 |
| [#169](https://github.com/cxin21/tdb-hechen/issues/169) | 多会话证据包：turn + 同会话邻接窗 | §26.4 差距③ | ≈6.7pp（oracle 探针 20/34） | 基座用 #172 口径 |
| [#170](https://github.com/cxin21/tdb-hechen/issues/170) | 成本与延迟口径量化 | §26.4 差距④ | —（可对外表述的前提） | 复用 #159/#160 产出 |
| [#171](https://github.com/cxin21/tdb-hechen/issues/171) | LongMemEval_S 全 500 同尺复跑 | §26.4 差距⑤ | —（接管 #154 的扩样本子项） | 与 #157 共用判分预算 |
| [#172](https://github.com/cxin21/tdb-hechen/issues/172) | 读侧定档：k=10 + 币值/建议 + calibrated wrapper | §24.9 / §25.6 | 口径对账后定 | 结论交 #154 登记 |
| [#173](https://github.com/cxin21/tdb-hechen/issues/173) | 死码与配置面清理（~300 行 + 45 无证据键 + 3 处缺省不一致） | §25.5 | —（可维护性） | Step3 在 #172 之后 |

**冲突对账（与创建时仍打开的 37 张票逐条比对的结果）**

- 归 **#154**：生产默认值登记与回滚条件。#172 只出证据；#171 接管其「扩到更大样本」子项（已在 #154 留评论）。
- 归 **#149**：生产语料灰度观测。#168 只做离线微基准，不做人工抽样与 1–2 周观测。
- 归 **#153**：抽取准确率门禁。#168 引用其结果但不阻塞。
- 归 **#150 / #151 / #152**：事实通道（存量回填 / 工具路 normalized / tcvdb 能力位）。#169、#173 明确不碰 `l1_fact_vec` 与工具路融合。
- 归 **#148**：validity 三键（`hardOnPresentIntent` / `softPenalty` / 工具路对齐）。#172、#173 明确不碰。
- 归 **#155 / #156 / #76**：结论卡（part_of 证据链 / assistant 双源 / 密度截断）。#169 只扩 raw turn 邻接，不改卡。
- 归 **#158**：`lineTypeStats` 与 `evidenceSufficiency` 字段设计。已把现成读数（2×2：足且对 63 / 足且错 14 / 不全且对 3 / 不全且错 10；本语料行类型 raw-turn 259/259）作为评论交接。
- 归 **#159 / #160**：bench 脚本口径断言与小债。#170 复用其 `addUsage` 修正，不重复实现。
- 归 **#107**：typecheck 243 条存量错误。#173 只保证错误数不增加。
- **#133**（二阶段总票）保留为背景与总目标，已在票内留「四波去向」对照表（第二波事实行读侧收益被 #166/#167 否证，收窄为 #168 的写侧不退化）。

**没有重复开票的两个候选**（原本想开，比对后并入）：①「拒答校准」并入 #172（同一条 A/B 的四档之一）；②「judge 口径对账」并入 #172 第一步（单独开票会与 #140 判分器一致性门禁重叠）。
