# 总验收执行方案（goal 台账终项 · 2026-10-20 落盘待拍板）

> 前置：D2/D3/conclusionContract 拍板（见 2026-10-20-d2-d3-decision-pack.md）→ 部署重启 → 生产观察窗。本方案定义验收口径与判据，零代码改动。

## 口径 A（主判据）：活体召回有效信息率

- **方法**：复刻 T4 取证口径（docs/research/2026-10-20-recall-forensics.md 附录 A）——取部署重启后一段观察窗内真实 query 的 recall 返回（journal 采样，过滤 sessionReused TTL 重放），逐条标注：
  - high=直接可用的结论/事实（无需加工即可支撑当前任务）
  - mid=主题命中但需加工（截断/低密度但方向对）
  - low=擦边（命中但用不上）
  - none=无关
- **指标**：高价值率=(high+mid)/n；**基线 26.5%**（T4，fresh 437）；**判据 ≥40%**。
- **样本量**：n≥30 起评（±17% 置信，方向性判据）；观察窗内不足 30 条则顺延。
- **标注者**：用户抽样复核 ≥10 条（防自评偏差），分歧条目以用户裁定为准。

## 口径 B（回归锚）：golden runner 复跑

- 11 条数据集照跑：no red cards 必须保持；highValueHitRate/strictHighHitRate **不低于**基线 0.667/0.75（回归不许降）；precisionProxy/emptyRecall 如实记录对照（生产数据自然演进差异须归因标注，同 Batch C 先例）。
- 探针红线：scaffoldProbeSkipped=2/2 持续。

## 观察窗检查清单（部署重启后）

1. reflection `conclusion card rejected` 日志出现且 skipped 计数 >0（拒收门活体生效）
2. journal 新增 conclusion 卡长度分布：>300 码点条目归零（产出端粒度收敛）
3. 若开 ageDecay/timeProxFallbackEnabled：v3 recall composite 打分日志中 timeFactor 乘子生效抽查
4. 空召回率与噪音查询率对照 T4（59.5%/77.7% 应显著下降——F2 预算+F1 拆条+D2 开关合力）

## 通过定义

口径 A ≥40% **且** 口径 B 无回归 → 总验收通过，goal 可标 complete；未达标 → 按 observation 归因（粒度/时效/查询侧三类病灶残余）开下一轮票，不降低判据。
