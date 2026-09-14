# memory-recall-golden — 记忆召回轻量锚点归档（Task GOLD，E' 零人工）

记忆召回（MemoryCore `/v3/atomic/search` 混合检索）的归档锚点：OFF/ON 排序对比 + 通道归因 + Precision@5 粗门 + FTS 交叉自检。布局镜像同级 `recall-golden/`（wiki 召回 golden）。

## 用途

- **排序回归锚点**：每次锚定运行 `MemoryCore/scripts/recall-anchor.mjs`，产出 `runs/<ts>.json`——含十开关配置快照、OFF 双跑确定性断言、OFF/ON per-query top-5 与逐位次变化的通道归因（R1时窗/R1时近/R2/R3/R5价值/R6场景/R8强化/R9，取值来自 `recall-signals.ts` 各信号分量实际计算）、Precision@5 粗门、FTS 交叉自检（warn 级）、重巩固 bump 清单。
- **非循环主题真值**：`labels.jsonl` 为 10 条 query 的主题相关记忆标注（每条 3-5 个 id + 逐条理由）。标注产自全量语料阅读（896 条 digest 通读 + 关键词全文扫描 + 候选全文复核），**产标时未运行任何检索**，与排序路径零交集（防循环自证）。

## 触发纪律（重锚时机）

以下任一变更后**必须重锚**：

1. 排序代码变更（memory-search.ts / recall-signals.ts / auto-recall.ts 排序链路）；
2. 十开关值变更（tdai-gateway.yaml `memory.recall` 的 timeBoost/recencyBoost/sigWeight/inferredPenalty/reinforcementWeight/moodBoost/coreRefBoost/graphMinStrength/graphDiscount/sceneBoost）；
3. embedding 端点或模型变更（memory.embedding.baseUrl/model/dimensions）；
4. **R7（渐进式披露分层召回）实施前后**。

## P@5 验收线与漂移重锚协议（DS-P5-REANCHOR-001，2026-09-12 重锚 ×4）

- **现行验收线：P@5 ≥ 0.325**（平面层体系）。锚定：重锚基线 0.345 − margin 0.02（④ 完结重锚重确认）。
- **基准工作点（四次重锚后）：纯基线**（rerank off + 结构信号 off，排序为字典序两段式——5fc7962 + fe6b37ae 全链对齐）。四次同日换线/重确认均按协议有据：
  ① 精排 A/B（reanchor-2026-09-12T04-26-51.json）：off 0.285 / on 0.160 → 精排关断（线 0.265）；
  ② 结构信号 A/B（runs/12-08-44 vs 12-11-49，加法混排时代）：on 0.285 / off 0.325 → 结构信号关断（线 0.305）；
  ③ 排序三刀后复测（runs/13-33-14 vs 13-36-22，同 sha 5fc79629）：off 0.345 / on 0.325，q9 挤位已被字典序修复、
  q10 平局组内重排仍有净伤害 → 信号维持退役（线 0.325，新基线 0.345）。数字三次接近纯属巧合，详见 spec §8.3。
  ④ **完结补齐重锚**（runs/19-46-39，sha fe6b37ae，corpus 1246——漂移 6.9% 触发① + :1368 字典序对齐/Minor④
  防撞形触发②）：基线 0.345 精确复现 → **线 0.325 重确认不变**；写副本纪律端到端首跑实证（sidecar
  19-46-39.layered.json 产出、原档 sha 逐字节不变）；塌方检查 0.4→0.3 无触发（CC 0.3/CC'=1 为蒸馏聚焦块
  的设计内形态，非退化，登记）。
  历史轨迹（旧线 0.325 RV2-1 时代 / 首换线 0.265 / 二换线 0.305）留痕于 yaml 注释与 spec §7-§8。
- **漂移重锚触发条件**（满足其一，须重锚后方可比数字）：
  1. 语料条目数相对重锚快照漂移 > 2%；
  2. L1 排序语义配置变更（九通道权重 / rerankWeights / 门槛 / 分层预算）；
  3. golden 集（queries/labels）变更。
- **重锚操作**：`MemoryCore\scripts\reanchor-p5.ps1`（工作点 on/off A/B 重放 +
  corpus/gitSha 一致性硬校验 + 裁决字段自动计算）；mismatch RED-CARD 时人工复裁、
  不采信自动 workingPoint。工作点不变时仅刷新基线与线；工作点变更时全流程重走
  （含分层旁证人工复裁）。分层指标（CC/CTR/SD）随锚建基线，**不设绝对线**；
  塌方侦测（CC 相对上一锚相对降幅 >50% → 红牌，不阻塞 exit code）已于 2026-09-12
  A1 落地实施（eval-layered-recall.ts；阈值 3 锚带宽 0（0.40/0.40/0.40）校准）。
  同批 A1 Minor ② 落地：eval-layered-recall 重放结果改写**派生副本**
  `<原名>.layered.json`（同目录旁挂），归档原档**永不改写**——reanchor-p5.ps1 /
  calibrate-recall-scale.ps1 的 metric 采集已同步指向副本；历史锚的内嵌
  layeredMetrics 保持原样可读。

## 锚点登记

- **分析型 query 新锚 = runs/2026-09-12T13-33-14.json**（rerank off，sha `5fc79629`，
  V2-3 预算封顶后注入形态，run corpus 快照 1176；layeredMetrics 全量重放
  `replayGitSha=5fc79629`、重放快照 1179，corpus.driftVsRun sameCorpus=false 如实在档，
  CC=0.4 / CC'=1）。分析型 query 的分层指标对锚以本锚为准。
- **旧锚退役**：runs/2026-09-12T12-11-49.json（及同批 12-08-44，加法混排时代、
  V2-3 预算封顶前形态，corpus 1168）不再作为分析型 query 注入形态的对锚基准；
  其 P@5 换线历史语义见上文 P@5 验收线节 ②。

## 运行

```powershell
cd D:\TDB\td-agemem\MemoryCore
node --import tsx scripts/recall-anchor.mjs
```

- 生产 `tdai-gateway.yaml` 全程只读；临时 yaml 经 `TDAI_GATEWAY_CONFIG` 指向（os.tmpdir，自清理），临时网关端口 **8422**（避开生产 8420 / KS 8421 / Panel 8123），自起自停。
- 结伴生（lifecycle/capture/extraction/skill.extraction）在临时 yaml 中关闭；召回本身的 `bumpRecallCount`（recall_count/last_recalled_at）是排序链路自带行为，归档 JSON 以前后照 diff 如实记录 bump 清单。
- 粗门/确定性失败 → 红牌写入归档 JSON + stderr loud，**不阻塞**（exit 0，零人工）。

## 局限性（三条）

1. **语料增长漂移**：生产库持续有新记忆写入（本锚点 896 → 运行时 901），跨时间的 runs 之间语料不同，P@5 与排序对比只在同语料快照内可比；重锚时以当次 `configSnapshot.corpus` 为准。
2. **embedding 外呼近似确定**：向量分数来自远程 embedding（火山方舟），两次调用分数可在同分 tie 边界内抖动；首锚 OFF 双跑即出现 1/10 query 第 4/5 位（0.030/0.031）互换——确定性断言失败不一定意味着排序代码回归，须对照分差是否在 tie 边界。
3. **R1·R8 时变通道使排序天然时变**：`recencyBoost`（24h 内被召回加分）与 `reinforcementWeight`（recall_count 对数加分）随调用历史变化；且 OFF 先行的双跑会 bump 自身结果、污染后续 ON 跑的这两个分量（方向性污染声明见归档 JSON `reconsolidationBumps.note`）。锚点记录的是**归因**而非永恒排序。
