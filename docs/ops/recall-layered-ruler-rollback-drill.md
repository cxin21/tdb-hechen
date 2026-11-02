# #179 选线尺 — 生产切换与回退演练记录（2026-11-02）

角色说明：本记录由 AI（lead）在生产机执行，**重启与开关动作均为真实执行**，每一步都有 journal 证据行。
相关文档：开关与回退 SOP `docs/ops/recall-layered-ruler-ops.md`；规格与差异 `docs/specs/2026-11-02-recall-selection-layered-ruler-spec.md`（§8）。

## 0. 起点

- 生产配置：`D:/TDB/data/config-override.json`（改前备份 `config-override.json.bak-20261102-pre179`），顶层两块
  `layerRuler{mode,keepRatio,minPerLayer,floor}` + `injection{foldIdentical,budgetByIntent}`。
- 生产 embedding：`openai_compatible/doubao-embedding-vision@2048`；标定产物键 `doubao-embedding-vision@2048`（p50 0.3126 / p95 0.4923，300 对样本）。
- 重启方式：认端口不认 cmdline —— `Get-NetTCPConnection -LocalPort 8420 -State Listen | OwningProcess`，杀该 pid 后跑 `pwsh -NoProfile -File D:/TDB/etc/start-tdb.ps1`（端口健康即 skip，必须先杀；不要跑 start-tdb-supervised.ps1）。

## 1. enforce（最终代码：300ms 预算守卫 + 嵌入缓存）

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 重启 | kill 8420 pid 45544 → `start-tdb.ps1` | `[start] tdai-core pid=23920 ... [ok] tdai-core healthy on 8420` |
| 冷缓存首轮 | `POST /v3/recall`（session-smoke-179-final） | `ruler={mode:enforce,floorSource:config,floor:0.3126,bypass:'ruler-budget',ms:305}`、`selection={kept:8,injected:8,droppedBy 全 0}`、candidates total 8 —— **冷缓存首轮按设计降级成「今天行为」** |
| 温缓存第 1 轮 | 同 query（session-smoke-179-warm） | `ruler.ms=224`、`kept 6 / injected 6 / droppedBy.rank=2`（8→6，真裁行） |
| 温缓存第 2 轮 | 同上 | `ruler.ms=0`（全部命中内容寻址缓存）、同样 8→6 |

结论：守卫与缓存都在生产生效；**冷缓存首轮 ≈300ms 会 bypass**，属设计内降级（观测面记 `ruler-budget`）。

## 2. 回退演练：enforce → off

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 改开关 | `config-override.json` 顶层 `layerRuler.mode='off'`（其余键原样保留） | 写盘成功，`floor` 仍在但模式 off |
| 重启 | kill 8420 pid 34944 → `start-tdb.ps1` | `[start] tdai-core pid=44672 ... healthy on 8420` |
| 复放同 query | `POST /v3/recall`（session-smoke-179-off） | `ruler={mode:off,floorSource:uncalibrated,floor:null}`、`selection={kept:8,injected:8,droppedBy 全 0}`、注入 8 行（= enforce 时被看砍掉的那 2 行回来了）、无 `ruler.ms`/无 `bypass`（off 不调 embedding） |

结论：**一行开关即回退**，且回退后的注入行数与内容回到「改动前语义」（off 分支与旧路径逐位一致的证据在 `src/core/hooks/__tests__/recall-layered-ruler.test.ts` 与 `auto-recall-selection-journal.test.ts` 的 off 用例）。

## 3. 切回 enforce（当前稳态）

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 改开关 | `layerRuler.mode='enforce'` | 写盘成功 |
| 重启 | kill 8420 pid → `start-tdb.ps1` | `[start] tdai-core pid=22272 ... healthy on 8420` |
| 复放同 query ×2 | session-smoke-179-enforce2 | 第 1 轮 `ms=230, kept 6, droppedBy.rank=2`；第 2 轮 `ms=0, kept 6`；`candidates{total:8,n:8}` |

结论：当前生产 = enforce + p50 地板 + 300ms 预算 + 嵌入缓存，行为可复现。

## 4. 观察窗（24h，只需开头状态）

- 判据：核心报错/崩溃；`ruler.bypass="ruler-budget"` 占比 >30%；0 行轮 >30%（分母=去掉同轮重复的回合数，基线 16.1%）；用户主观「更不沾边」。
- 触发任一条 → 按 §2 回退（改 mode=off + 重启），票面记录命中项与 journal 证据行。

## 5. 诚实的边界

- 本记录的三次重启后的冒烟用的是**合成 sessionKey**（`session-smoke-179-*`），没有等真实对话自然发生；真实对话的接管证据以「下一轮真实召回携带 `ruler.mode=enforce`」为准。
- 冷缓存首轮的 `ruler-budget` bypass 是真实观察值（305ms > 300ms），说明本机（CPU 被节流）在池子较大时首轮基本不裁行；稳态靠缓存。
- 观察窗内的 bypass 占比尚未有真实分布样本（只有 40 轮离线重放的 7/40=17.5% 参照）。
