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

## 事件台账（auto_adopted / blocked 事件发生时逐条追加：pending_id、内容摘要、门参数、快照版本、后续回滚与否）

（暂无）

## 定线（观察窗收口时用户拍板）

- 待数据。精确率 = 1 − 回滚数 / auto_adopted 总数；N₂/T₂/阈值按 #80 法真实数据复核可调（config 键承载）。
