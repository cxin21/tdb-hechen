# 遗忘（Forgetting）· 设计

> 触底：spec 支柱「遗忘(C4)」。原则（承前讨论）：**不会忘就不是记忆**；重要性×时间衰减；**归档优先于删除**（你怕误删，我们断言）。

## 1. 目标
- 用 `significance × priority × 时间衰减` 决定：高价值进 L2/L3、低价值归档、过时被覆盖则合并。
- **归档桶软删**：可恢复、可审计，绝不直接丢你真想要的东西。

## 2. 遗忘判据
```
score = significance * (priority/100) * decay(age)
decay(age) = e^{-λ * (now - occurred_at)/days}     // λ 可配，如 0.01/天
阈值分档：score 高→保留/晋升 L2；中→保留但降权；低且 age 大→归档；被明确覆盖→merge
```

## 3. 归档机制
- 新表 `l1_archive`：结构与 `l1_records` 一致 + `archived_at` + `reason`。
- 归档=从 `l1_records` 软删（逻辑行移动到 archive），`l1_links` 相关边同步标记。
- 检索默认排除 archive；可显式查询/恢复。

## 4. 触发
- `forgetting-worker`：离线周期（复用 offload），或按批次（每次写满 N 条后触发其对应主体组的小扫）。
- 与 H（巩固）配合：巩固是"提拔"，遗忘是"清退"，同一 score 轴的两端。

## 5. 安全
- 默认 `λ` 保守（衰减慢），宁漏忘不多忘。
- 只有 `certainty=observed` 才可自动归档/删除；`inferred` 需人工/更高阈值（红线）。
- 归档可审计（reason、时间）、可一键恢复。

## 6. 非目标
- 不做语义访问频率衰减（可后加）；不删 L2/L3 画像一级的全局（那是 M 演化时重建）。

## 7. 待评审
- λ 与分档阈值，经真实数据打样再定（参照 wiki golden 的做法，建"遗忘不误删"评测样例）。
- 恢复 API 的形态。

---

## 实现状态（2026-09-08 P2）
- ✅ `l1_archive` 表（整行 JSON + archived_at + reason）+ `archiveL1/restoreL1/listArchived`（sqlite + IMemoryStore）。
- ✅ forgetting-worker 真归档（宁漏勿多 + **仅 observed 自动归档**红线已编码）；lifecycle scheduler 已接线（`332005e`）。
- ⏳ 待办：恢复 API 暴露成 v2 路由/UI、审计页、"遗忘不误删"评测样例。