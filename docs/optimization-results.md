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
**turnCov@5=79.5%（+12.4pp）、判对 70.0%（63/90，+31.1pp，McNemar p<0.001）、拒答 15.6%（<20% 达标）、f1 0.486（基线 0.188）、latP50 159ms（-7.3s）。**
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
| **W3 读侧** | `auto-recall.ts` R7-1 结论层 + #78 `smallToBig`（生产既有代码） | yaml `recall.smallToBig.enabled=true`（生产早就开着），`maxExtraLines` **2→4**（本次） | §8 w3b：判对 +14.4pp CI[+6.7,+23.3]，cov 持平；注入总行数由 maxResults 硬帽收口 |
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
node scripts/fit-fusion-weights.mjs \
  --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json \
  --arm deep105=.eval-data/bench/longmemeval-oracle-2026-10-27T08-36-53.json
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
