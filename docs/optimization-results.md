# 记忆检索优化路线实施结果（B0→B2-a→B1→B2-b）

> **执行日期**：2026-10-26 深夜 – 2026-10-27（本分支 `bench/recall-opt`）。
> **对照文档**：[optimization-plan.md](./optimization-plan.md)（v2，§7 执行清单 + §8 预期）。
> **评测口径**：LongMemEval-oracle LME90（分层抽样 manifest，seed=20261027，6 题型×15=90 题——**修正：数据集只有 6 题型，非文档所写 7 题型×15=105**），串行单进程 --pace 150，judge=answer=同一凭据温度 0，判分口径 lme-v2（correct/refused 双字段）。
> **全部跑批日志与报告**：`MemoryCore/.eval-data/bench/`（run-*.log + longmemeval-oracle-*.json/md，tag 见下表）。

## 0. 一句话结论

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

## 7. 后续建议（P0–P2）

- **P0 生产 A/B**：生产网关灰度 `rerank.enabled=false`（或 minScore→-10.5 等价于近全开），观测生产侧有效信息率与延迟——bench 证据支持关停方向，但生产语料（短行）需自证。
- **P0 B1 生产化**：injector 注入块渲染按 B1 四件套改造（时间序+CoN+NOT_ENOUGH_INFO+中性英文包裹），bench 已验证 +15.6pp。
- **P0 结论层回捞（W3，§8）**：生产打开 `recall.smallToBig.enabled=true`，**maxExtraLines=4**——bench 判对 70.0%→84.4%（+14.4pp，CI[+6.7,+23.3]，n=90，p=0.0023）、拒答 8.9%、turnCov 持平（79.3%，-0.2pp ns）；生产结论卡由 consolidation 既有产出，读侧零改动，配置级灰度即可。
- **W1/W2 维持默认关（§8）**：W1 事实双写 +6.7pp 不显著（CI 含负）；W2 supersession 在 LME90 cov 显著负（gold 含被取代旧值 turn），需生产语料（有失效语义）复核后再议；W2 粒度（事实级 vs 整行）同时复核。
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

### 逐项结论

- **W3（唯一通过答案侧门禁）**：判对 70.0%→**81.1%（+11.1pp，CI[+2.2,+20.0]，p=0.031）**、拒答 15.6%→10.0%；证据回捞行数调到 4（w3b）后 **84.4%（+14.4pp，CI[+6.7,+23.3]，p=0.0023）、拒答 8.9%、cov 回到基线（79.3%，-0.2pp ns）、缺口桶 5/11**——**六档中唯一双门禁达标**（调参口径见下方偏差记录）。机制：结论卡（3.56 卡/组 × 90 = 320 卡、769 条 part_of 边）经既有 R7-1 结论层（FTS 词面命中）入候选，`smallToBig`（#78 R-b）单跳回捞源证据行作「上下文行」注入；预算未破（结论行硬上限 floor(maxResults/2)、maxExtraLines=2，注入总行数 ≤ maxResults）。turnCov@5 -3.3pp（ns）：single-session-assistant/preference 桶 -13.3/-12.2pp（结论卡占注入位、gold-turn 覆盖被稀释），但 knowledge-update 桶 **+8.3pp**（结论卡把同一实体的多次更新聚合到一行，正是该桶需要的粒度）。**缺口桶 4/11，差 1 题**。
- **W1**：判对 +6.7pp（CI 含负，不显著）；turnCov -2.5pp（ns）；multi-session +6.0pp / knowledge-update -8.3pp（事实短语把同事实不同时点的行拉近，稀释时间/版本信号）。按票面规则（Δ<3pt 或 CI 含负值即回滚）**默认关**（`--fact-dual-write` 保留能力）。
- **W2**：机制正确（140 条 valid_end **只标记不删除**、主表+l1_fts 双写同步、读侧既有 `isOutsideValidityWindow(validityNow)` 生效），但 **turnCov -10.9pp 显著负**（knowledge-update 桶尤甚）；判对 +5.6pp（ns）。**与票面预期一致**：LME90 的 gold 证据常包含被取代的旧值 turn，"只留新值"直接丢 gold。→ 默认关（`--write-supersede` + `--b2b-validity`），收益需生产语料（带失效语义）验证。
- **叠加性**：不叠加。w13 +8.9pp、combo +7.8pp，均低于 w3 单开 +11.1pp——W1/W3 答案收益重叠（都靠补充上下文），W2 的 cov 伤害进一步拖累。**推荐配置 = b1-off + W3**。

### 实现与 seam（零 schema 变更）

- 写入面只用既有 3 个 API：`store.upsertL1(record, vector)`、`store.invalidateL1(id, validEndIso)`（W2 只标记）、`store.addLink(src, dst, "part_of", 1)`（W3 证据链）；读侧零改动（W2 复用 `isOutsideValidityWindow`，W3 复用 R7-1 结论层 + #78 smallToBig）。
- 双时态两端都在：L1 行写 `valid_start`（=该轮发生时刻）、supersession 写 `valid_end`；重嵌向量时**保留**既有 valid_*（避免复活已失效行）。
- **本波仅 bench 验证**（与 B1 同款先例）：三个新模块只被 bench harness 消费；生产接入（l1-writer/v2-router 写链 hook）= 另开票，需带默认关 + 门禁闸。生产侧的即时可行动作见 §7 的 W3 配置项。
- **偏差记录**：① W2 失效粒度 = L1 整行（票面写「事实带 valid_from/valid_to」）——一行多事实时整行失效，粒度粗于票面；LME90 上表现为显著丢 gold，粒度细化（事实级行）留待生产语料验证时一并评估；② W3 的 `--conclusion-cards` 同时开写入面与读侧回捞，本波未拆两个独立开关（拆分留作后续）；③ **w3b 是看到 w3 的 cov 下探后按假设调参**（maxExtraLines 2→4，靶向 gold-turn 覆盖）——同题集上调参，非预注册，绝对增益应打折扣解读；w3（2 行）与 w3b（4 行）两档证据都保留；④ 抽取预算门禁在缓存命中档无 token 证据 → 显式 SKIP（不假绿），首次抽取档的 token 计量见 `factExtraction.stats`。
- 新增 bench 工具链：`scripts/lib/bench/facts.mjs`（抽取+缓存+429 长退避）、`conclusions.mjs`（结论卡蒸馏+缓存）、`fact-extract-gate.mjs`（抽样验收门禁）、`bench-gates.mjs`（票面门禁汇总：缺口桶/判对 CI/预算/抽取验收；无证据时显式 SKIP 不假绿）、`run-w134-arms.sh`（逐档可复现，先跑抽取门禁、失败即非 0）；`--facts-only` 离线抽取、`--store` 分阶段写入、`--embed-cache` query 向量缓存。
