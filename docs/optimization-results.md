# 记忆检索优化路线实施结果（B0→B2-a→B1→B2-b）

> **执行日期**：2026-10-26 深夜 – 2026-10-27（本分支 `bench/recall-opt`）。
> **对照文档**：[optimization-plan.md](./optimization-plan.md)（v2，§7 执行清单 + §8 预期）。
> **评测口径**：LongMemEval-oracle LME90（分层抽样 manifest，seed=20261027，6 题型×15=90 题——**修正：数据集只有 6 题型，非文档所写 7 题型×15=105**），串行单进程 --pace 150，judge=answer=同一凭据温度 0，判分口径 lme-v2（correct/refused 双字段）。
> **全部跑批日志与报告**：`MemoryCore/.eval-data/bench/`（run-*.log + longmemeval-oracle-*.json/md，tag 见下表）。

## 0. 一句话结论

> **2026-10-27 下午修正（§10）**：精排本身不是净负项——伤害来自 `candidates=12` + `minScore=-2` 的**过度剪枝**（把 30% 的题剪到只剩 1 行证据）。保留 rerank、把池扩到 32、floor 放到 −10.5，turnCov@5 = **84.3%**（+16.67pp vs b0-base，CI[+9.05,+24.29]，p=0.0005），高于「关掉 rerank」的 79.5%。下文 §0–§2 为下午修正前的原始结论，保留作历史记录。

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

## 2. 推荐配置（b1-off 组合档）✅ 已实测

`rerank.enabled=false` + `B1 读侧四件套`（tag=b1-off，23-42-59）：
**turnCov@5=79.5%（+12.4pp）、判对 70.0%（63/90，+31.1pp，McNemar p<0.001；判分器 `scm-flash`——与 MiniMax 判分档不可配对，见 §8）、拒答 15.6%（<20% 达标）、f1 0.486（基线 0.188）、latP50 159ms（-7.3s）。**
两项收益完全叠加（检索侧来自 T4、答案侧来自 B1），为最终推荐配置。

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

- **P0 生产 A/B**：生产网关灰度 `rerank.enabled=false`（或 minScore→-10.5 等价于近全开），观测生产侧有效信息率与延迟——bench 证据支持关停方向，但生产语料（短行）需自证。
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
- **叠加性**：不叠加。w13 +8.9pp、combo +7.8pp，均低于 w3 单开 +11.1pp——W1/W3 答案收益重叠（都靠补充上下文），W2 的 cov 伤害进一步拖累。**推荐配置 = b1-off + W3**。

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

**修复（`src/core/recall/rerank/blend.ts` + `applyRecallRerank`）**

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

**结论**：rerank 的正确用法是「**有界重排 + 噪声过滤**」，不是「主排序器」。生产建议 `rerank.enabled=true` + `rerank.blend≈0.9`（保留噪声过滤与第 2..cap 名次修正），而不是关闭；进一步把 rerank 变成净增益需要分数校准/分类型路由（#145）。

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
继承了沙箱库的 `smallToBig.maxExtraLines=2`，而 `w3legacy` 显式传了 4。实测：`w3` 的 `gates.smallToBig.maxExtraLines=2`、每题证据行 0.44（40/90），
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
- 修复落在 `MemoryCore/scripts/run-r142-sampling.sh`：每档显式钉 `--rerank-blend`，并带 `--expect-config recall.rerank.blend=…,recall.fusion.mode=…,recall.rerank.candidates=…,recall.rerank.minScore=…`——生效值与档名不符时在灌库前 exit 2，避免白跑一档。
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

配对命令与基线完全一致（`scripts/run-r142-sampling.sh` 的 `base0` 档：`--b1 --candidate-k 32 --present-temporal --recall-ks 1,3,5,10 --no-write-steps --rerank-candidates 32 --rerank-minscore -10.5 --rerank-blend 0 --fusion <weighted α0>`，`--expect-config` 守卫通过），库 = `lme90-r142-deep105-base0` 的副本（`--no-write-steps`），报告 `r162-fold2.json`。

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
5. **配置面现状（后续要补）**：`MemoryCore/src/gateway/settings-override.ts` 的 `RerankSettingsOverride` 只接受 `enabled/provider/baseUrl/apiKey/model/timeoutMs/candidates/minScore/local`，**不认 `mode`/`blend`/`filterRule` 等键**（未知键静默忽略）。也就是说这些新键目前只能写 yaml（`memory.recall.rerank.*`），管理后台的 config-override 改不了它们；要做成管理台可调，得扩 override schema + 校验 + SettingsPage，属于独立票的活。另外 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 的 rerank 块也没有这三个键。
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
