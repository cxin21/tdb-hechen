# #92 生产观察窗证据（2026-10-25 开窗）

观察窗 **t=0 = 2026-10-25 20:54:55+08:00**（重启后首个 lifecycle 拍的 auto-adopt 计数行）。
验收口径：auto_adopted 精确率 = 用户零回滚占比（呈报后定线）。
巡检纪律：纯只读取证（node:sqlite readOnly + PRAGMA query_only=ON 双保险），零写库、零重启、零 yaml、零 git 写。循 #91 同名先例（[2026-10-23-91-observation-window-log.md](./2026-10-23-91-observation-window-log.md)）。
观测锚：拍级日志行 `[lifecycle] self_identity auto-adopt adopted=X blocked=Y skipped=Z`（空拍也打，节拍在场可证）。

## 开窗前置（2026-10-25，全部只读取证）

- 17:12:49 前代 core 启动（早于开闸 yaml 19:13:35 → 门未生效）；20:47 只读复核：supervisor restartsUsed=2/3（MaxRestarts=3 bundle 传参一手核验）、core_pending self_identity rejected=385 / adopted=76 / expired=13 / **pending=0**、gate-ready 候选=空、auto_adopted=0。
- 19:13:35 MemoryCore/tdai-gateway.yaml 开闸块落盘：selfIdentityGate.autoAdopt 五键（enabled: true / votes: 4 / spanHours: 72 / contradictionThreshold: 0.6 / dupThreshold: 0.75）；recurrence.enabled: true（stage-1 计票供料在开）。
- 19:17 17802f4 推送 origin/main（门+13 用例+store 四方法+scheduler/config/路由接线+ADR-0007+设计稿，13 文件 703 插入）。
- 20:52 用户重启（RESTART-SOP 全量重锚路径）：supervisor takeover 20:52:57、restartsUsed=0（预算重立）；新 core PID 1944 起 20:52:46（晚于 yaml → 载入开闸配置）；/health 8420 ok（warmup done）。

## 生效证据（决定性）

```
2026-10-25T20:54:55.676+08:00 INFO  [tdai-gateway] [lifecycle] self_identity auto-adopt adopted=0 blocked=0 skipped=0
```

- 落于 tdai-core-20261025-205243.out.log 与 .tee.log 双写；
- 首拍零候选（pending=0）无突跳——与开闸记档「重启后首拍 pending=0 零候选，随计票自然累积」逐位吻合。

## 基线计数（2026-10-25 20:55 只读探针，探针留档 .tmp-gate/92-db-probe.mjs / 92-prod-probe.ps1）

- core_pending slot='self_identity'：rejected=385 / adopted=76 / expired=13 / pending=0 / **auto_adopted=0**；全槽 core_pending=529。
- /health 8420：status ok、vecRows=3006、embedding ok。

## 拍级日志（巡检逐日追加）

| 时间 | 拍级行 | 判读 |
|---|---|---|
| 2026-10-25 20:54:55 | auto-adopt adopted=0 blocked=0 skipped=0 | 开窗首拍，零候选（pending=0） |
| 2026-10-26 | 每 10 分钟一拍；重启 08:56/09:01/09:42/16:08/18:07，各存活代均有拍 | 全 0；新提案 2 条 |
| 2026-10-27 | 同上；重启 09:34/13:09/14:04/15:26/18:45/20:37/21:29 | 全 0；新提案 12 条 |
| 2026-10-28 | 同上；重启 06:49/10:07×2/10:36/22:39/22:52 | 全 0；新提案 0 |
| 2026-10-29 | 同上；重启 00:50/11:43/12:27；yaml 13:36 被他票改动（gate 块不变） | 全 0；新提案 10 条（05:59–06:50Z） |
| 2026-10-30 | 同上；重启 10:40–11:20 多次、23:00 重启（当前代，载入新 yaml） | 全 0；新提案 0 |
| 2026-10-31 09:30 巡检 | 当前代 08:50–09:30 每 10 分钟连续 | 全 0；新提案 0 |

## 2026-10-31 巡检（窗内第 5.5 天，全窗汇总）

### 生产状态（只读）
- supervisor startedAt=10/30 23:00:26、restartsUsed=0；core PID 3064 起 10-30 23:00:10；/health 8420 ok、uptime 37861s（~10.5h）、vecRows=3514、warmup done。
- yaml mtime=2026-10-29 13:36:37、size 49862（开窗 39920）——他票/用户改过配置，但 gate 块完好：L541 selfIdentityGate（recurrence.enabled true / ttlHours 72）、L548 rateLimit（maxNew 12）、L556 autoAdopt（enabled true / votes 4 / spanHours 72 / contradictionThreshold 0.6 / dupThreshold 0.75）；当前 core 载入该 yaml。
- 日志代际：10-26..10-30 约 30 代（重启频繁，多数与他票工作相关，非本票范围）；**每个存活 ≥10 分钟的代都打出追赶拍，且全部 `adopted=0 blocked=0 skipped=0`；全窗零非零拍；无 `[auto-adopt]` warn/fail 行**。

### DB 计数（readOnly+query_only，探针 .tmp-gate/92-db-probe-v3.mjs）
- self_identity：rejected=385 / adopted=76 / expired=27（13→27，TTL 扫除）/ **pending=10（0→10）** / auto_adopted=0；全槽 core_pending=564。
- 窗内新提案 24 条（10-26:2、10-27:12、10-29:10）；当前 pending 10 条（created 10-29 05:59–06:50Z）全部 count=1、span_h=0、first_seen=last_seen=created——**无复现投票累积**。
- count≥3 的 5 条全部为终态旧行（10-24/10-25）：count 14/span 8.2h adopted、7/4.1h rejected、4/3.2h rejected、4/2.1h rejected、3/1.5h rejected。

### 判读
- 门健康：拍级连续、无 warn/fail；**零 auto_adopted/blocked/skipped 事件**。
- 无自然候选：候选条件 pending ∧ count≥4 ∧ span≥72h 无行满足；pending 群体 TTL 72h（最早 11-01 05:59Z 过期），当前无相似提案复现 → 大概率全部过期而不产生自动采纳。
- 精确率仍不可估（分母 0）；**不能据本窗判定门过严或过松**——只能说明窗内身份主题复现频率 < 4 次/72h（提案总量 24 条，但每条仅出现一次）。

### 下一步（待用户拍板=判断类决策）
1. 继续观察，等自然复现（复现频率未知，可能 > 数周；零候选本身是保守设计的预期结果）；
2. 调整观察窗 KPI 口径：由「精确率」改为「零误收 + 零门故障 + 提案质量抽样人工标注」的保守口径（需用户定线）；
3. 或做 N₂/T₂ 对照实验（config 键已具备，变更需拍板，且会重置观察窗）。

## 事件台账（auto_adopted / blocked 事件发生时逐条追加：pending_id、内容摘要、门参数、快照版本、后续回滚与否）

（暂无；窗内零事件，回滚统计不适用）

## 定线（观察窗收口时用户拍板）

- 待数据。精确率 = 1 − 回滚数 / auto_adopted 总数；N₂/T₂/阈值按 #80 法真实数据复核可调（config 键承载）。
