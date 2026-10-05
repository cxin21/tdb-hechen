# Triage 标签词汇（GitHub Labels）

triage 五个 canonical 角色，标签字符串与角色同名（**保留默认词汇，未改写**，2026-10-05 用户拍板）：

| 角色 | 标签字符串 | 含义 |
|---|---|---|
| 待分诊 | `needs-triage` | 新票尚未分类定级 |
| 缺信息 | `needs-info` | 等报告人补充信息，暂不可执行 |
| 可派 agent | `ready-for-agent` | 已界定范围，AI agent 可安全执行 |
| 须人工 | `ready-for-human` | 必须人执行/人拍板，不派 agent |
| 不修 | `wontfix` | 明确不处理（沿用 GitHub 默认标签） |

## wayfinder 标签（同仓库配套）

`wayfinder:map`（地图票，一组票的父票）、`research`、`prototype`、`grilling`、`task`。

## 建齐记录

2026-10-05 初始化：以上 10 个标签已在 GitHub 仓库 `cxin21/tdb-hechen` 建齐（`gh label create` 逐个创建，`wontfix` 沿用仓库既有默认；创建后 `gh label list` 回读核对通过）。后续打标签遵循各技能自身规则，不额外强制。
