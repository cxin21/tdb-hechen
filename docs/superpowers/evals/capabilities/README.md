# capabilities — 三信号 Lane2 能力道评估（P1 Task 2）

spec：`docs/superpowers/specs/2026-09-15-memory-evolution-design.md` §6.1
（三信号分层：L1 构造式真值硬门 / L2 不变量硬门 / L3 LLM 判官软轨）
语料：`MemoryCore/scripts/eval-capabilities-fixture.mjs`（P1 Task 1，36 条主题包，可轮换）
脚本：`MemoryCore/scripts/eval-capabilities.mjs`

## 覆盖

四能力探针 + 两不变量，全部走临时网关（:8423，hermetic 临时库，BM25-only 确定性道）的
`/v3/atomic/search` 生产同构链路：

| 探针 | 层 | 断言 |
|---|---|---|
| time | L1 硬门 | 时间锚 query → 返回项 occurred_at 全落 parseTimeWindow 窗内 |
| session | L1 硬门 | 同主题跨 session query → 去重 session 数 ≥ minSessions |
| update | L1 硬门（expectedRed） | new 记忆应排 old 之前（P1 known-FAIL：无失效语义 → P2 翻绿） |
| abstain | L2 弃答 | 噪声 query 零结果，或 top1 < 真实 query top1 中位数（top1P50） |
| determinism | L2 不变量 | 同 query 双跑（独立 session）投影 [id, score, occurred_at] 逐位一致 |
| tenantClosure | L2 不变量 | 跨租户三元组 query → 0 结果（正控：fixture 租户 > 0） |

## 运行

```bash
cd MemoryCore && sudo -u tdai node --import tsx scripts/eval-capabilities.mjs
```

- exit code：全过=0；仅 expectedRed（update）失败=0（`baseline:true`）；意外失败=1。
- 生产 yaml 全程只读；临时 yaml / dataDir 在 os.tmpdir 自建自清理，绝不触碰生产 /data/tdai-memory。
- 执行顺序：boot 网关（建 schema）→ 停 → seedStore 直写 temp DB → 再 boot → HTTP 探针 → 归档 → 自停。
- 临时 yaml 相对生产的关断（归档 `gateway.deviations` 登记）：结伴生四开关（最小写入面）、
  `queryExpansion`（LLM 外呼破坏确定性）、`exploreSlot`（组成依赖 recall_count，跨 pass 漂移）。
- `runs/` 不入库（`.gitignore: docs/superpowers/evals/*/runs/`，2026-09-14 审计裁决），
  证据锚点以本 README 与 CHANGELOG 登记为准。

## 基线（2026-09-14T23-47-44，themeIndex=0，fixture sha256 c50d71b4…3a92）

| 探针 | 结果 | 数据 |
|---|---|---|
| time | PASS | "6月做了什么" 2 hits 全落 6 月窗；"上个月的部署安排" 0 hits（8 月窗无部署记忆，空集通过） |
| session | PASS | 8 hits / 4 distinct sessions（≥ 3） |
| update | known-FAIL（基线红） | old=`fx0-conflict-1-old`（阿里云，0.895）rank0 > new=`fx0-conflict-1-new`（腾讯云，0.843）rank1 —— P1 无失效语义 |
| abstain | FAIL 0/5 | 真实 query top1 P50=0.811 vs 噪声 query top1 0.890–0.912（brief 探针与 fixture 噪声 query 语义错位，见 Task 2 报告疑虑②） |
| determinism | PASS | 8 query 双跑逐位一致 |
| tenantClosure | PASS | 跨租户 0 hits；正控 8 hits |

exit=1（意外失败：abstain）——即本 README 所记基线；abstain 探针重设计后重跑为准。
