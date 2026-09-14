# 巩固（Consolidation）· 设计

> 触底：spec 支柱「巩固(C3)」。依赖 P2a（L1 已有 occurred_at/significance/certainty）+ G（记忆图，供按邻接聚合）。
> 原则（承前讨论）：**把点状经验"熬成"持续态结论**；回忆即重巩固(reconsolidation)，但**只动 observed**，推断不冒充。

## 1. 目标
- 把同一主体/主题的多条点状 L1 → 一条"持续态摘要"（TSM 思路），非孤点堆。
- 同步把这层喂给 L2 场景 / L3 画像。
- 离线/睡眠式跑（复用 offload 管道），不阻塞在线写入。

## 2. 选型触发
- 按 `subject`（用 LLM 归并键：person/entity/topic，可由 content 提取）分组。
- 组内 ≥N 条（如 ≥3）且跨期（occurred_at 跨度 > 阈值）才巩固，避免过早撮合。
- 同类主体、`certainty=observed` 优先促成持续态。

## 3. 持续态摘要生成
- 输入：组内 L1（content/type/priority/occurred_at/情感）。
- LLM 生成一条 `持续态记录`：概括"稳定现状、变化轨迹、当前结论"，保留 `occurred_at=组内最新`、`valid_*=组内最早~最新`、`significance=组内 max`。
- 产物附着到 L2 场景/L3 画像；原 L1 保留（作为证据链），高价值降为 `episodic` 引用。

## 4. reconsolidation（回忆即重巩固）
- 当某记忆被回忆触发时，允许"按当下重新缝合"微更新 **仅 `certainty=observed`** 层；`inferred` 层**锁死**不自动重写（红线）。

## 5. 落点（复用既有）
- 复用 `offload` 调度（timer-scanner 的 offload-l2/l3 模式）起 `consolidation-worker`。
- L2 scene-extractor / L3 persona-generator 作为持续态的载体。

## 6. 非目标
- 不提前做全图级全局重排；不做情感主导的合并（那是 L 当前感受参与处）。

## 7. 待评审
- 组密钥 `subject` 由 LLM 提取的召回稳定性；跨会话重起名问题。
- reconsolidation 的"当下"信号从哪来（拟：引用次数 + 最近上下文 relevance）。