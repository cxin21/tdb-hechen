# L0 清理脚本独立复核（task-108）

范围：独立复现 task-83 交付物 `MemoryCore/scripts/l0-testdata-clean.ts`（386 行）。**未阅读交接方报告**，下表读数全部来自我自建实例与生产只读副本；脚本一字未改。
复核时刻：2026-11-01 03:34–03:45（Asia/Shanghai）。

## 方法（可复跑）

- 隔离实例：`scratch/verify-l0/iso-core.mjs` → 端口 **8493**，数据 `MemoryCore/scratch/verify-l0/data`，apiKey `verify-l0-key`，provider none。health 200，用完已关（job bash-a34c22d03af24958）。
- 播种：`scratch/verify-l0/seed.mjs` 走 HTTP `/v3/conversation/add`（12 行：probe-alpha 5 / session-probe-beta 3 / session-real-1 4）；`scratch/verify-l0/insert-special.mjs` 直插 2 行（HTTP 造不出 `session_id='default'`）：`probe-default-id/default`、`default/default`。合计 **14 行 / l0_fts 14**，`l0_vec` 缺席（dimensions=0）。
- 生产只读：`cp /d/TDB/data/vectors.db{,-wal,-shm}` → `MemoryCore/scratch/verify-l0/prod-copy/`（源文件 size/mtime 跑前跑后逐位一致：db 383037440/1793468762、wal 11482472/1793470346、shm 32768/1793473223；**未在 D:/TDB/data 写入任何字节**，生产 `--yes` 从未执行）。

## 逐项结果（6/6 PASS）

| # | 验证点 | 结果 | 关键读数 |
|---|---|---|---|
| ① | dry-run 零写 | **PASS** | exit 0；`vectors.db` sha `2fb9e76bc8b8bb82` / 4096 B / mtime 1793475408 不变；`-wal` sha `88c740d3ee47d850` / 2447312 B / mtime 1793475452 不变。**主库只有 4096 B，数据全在 WAL，必须同时 hash 两个文件才算零写** |
| ② | 三条拒绝路径 exit 2 且库不变 | **PASS** | ①`TDB_DATA_ROOT=…`+`--yes` → `拒绝：… 位于生产数据目录 …，执行 --yes 需额外 --allow-production-db` exit 2 ②`--base-url http://10.4.100.50:8493` → `不是本机回环，需额外 --allow-remote` exit 2 ③无 apiKey → `缺少 --api-key（或 env TDAI_API_KEY）` exit 2。三次后快照 sha 仍 `f71b12e633bcae9d`，`docs/ops/archive` 文件数 0→0 |
| ③ | 身份头不符 | **PASS** | `--user-id usr-other`（team/agent 正确）→ `接口返回 deleted_count = 0（含级联）`、`计数（后）: 14/14`、`目标会话残留行数 = 9`、**exit 1**，提示 `[失败] 删除后目标会话仍有残留行：请检查 scope 身份头…` |
| ④ | 正确身份删净 + 级联一致 + 真实行完好 | **PASS** | `deleted_count = 9`、残留 0、exit 0；`l0_conversations` 14→**5**、`l0_fts` 14→**5**、`l0_fts` 孤儿行（无对应 l0_conversations）**0**；幸存 = session-real-1 4 行（real keep 1–4，原文完好）+ default 1 行 |
| ⑤ | 导出 jsonl 行数/sha256 与计划一致 | **PASS** | 9 行，sha256 `ca9fcf20…ee6df82`，三次独立运行 + `.sha256` 旁车 + 我自己算的 sha 三者完全一致；12 列齐全（record_id,session_key,session_id,team_id,task_id,user_id,agent_id,role,message_text,recorded_at,timestamp,classification）。生产副本规模复跑：128 行 / sha `0fc904c7…` / 同样 12 列 |
| ⑥ | `session_id='default'` 永不被当删除 id | **PASS** | 记录型假端点抓到的 POST body：`session_ids=["probe-alpha","probe-default-id","session-probe-beta"]`，`contains_default=false`，count=3（`/v3/conversation/delete`，一次请求）。纯函数级亦证：`buildDeleteSessionIds` 剔除 default（l0-testdata-plan.ts:185）、`validatePlan` 兜底（:215） |

## 生产只读 dry-run（与 Lead 口径逐位一致）

- **selected：23 会话 / 128 行 / 934375 字符；送删除接口的 id 数 = 23** —— 与 23 / 128 / **934,375** **完全一致**，无需查差异。
- 保留：191 会话 / 13322 行 / 21014410 字符（合计 214 会话 / 13450 行 / 21948785 字符）。
- 23 个选中键逐个核对：全部是 `probe-*` 与 `session-probe-*` 测试数据（最大 probe-red-…-m100 100 行，其余 1–4 行），无真实会话被误命中。
- 生产库里 `session_key='default'` 与 `session_id='default'` 恰有 1 行 —— ⑥ 的剔除在这份数据上是**有实际保护对象的**，不是空转。

## 未验 / 观察（不改脚本，仅登记）

1. **`l0_vec` 级联路径未验证**：隔离实例 dimensions=0 没有 vec 表；生产副本 `l0_vec` 是 sqlite-vec 虚拟表，`COUNT(*)` 报错（扩展未加载）。④ 的级联只证到 `l0_fts`。要补需能加载 sqlite-vec 的实例。
2. 观察（非 bug）：`deletableIdsOf` 对 `session_key='default'` 仍返回 `["default"]`（l0-testdata-plan.ts:93 只过滤 session_id），靠下游 `buildDeleteSessionIds`/`validatePlan` 两道兜底。显式 `--sessions default` 时该组被静默丢弃、`validatePlan` 返回空（无告警）——安全但无提示。
3. 本票曾因我的命令拼接错误把一次导出落到默认目录 `docs/ops/archive/`（非脚本行为）；已把它连同 `.sha256`（9 行，sha 同 ⑤）**移入** `MemoryCore/scratch/verify-l0/export/` 并删掉空的 archive 目录，**docs 下无残留测试数据**；其余导出本就落在 `MemoryCore/scratch/verify-l0/export/`。
4. 复核脚本与快照全部在 `scratch/verify-l0/`（iso-core / seed / insert-special / snapshot / recorder / plan-default-probe / plan-explicit-default），可复跑。

**结论：6/6 验证点 PASS，0 FAIL；生产计划 23/128/934375 逐位一致；唯一未验项是 `l0_vec` 级联。**
