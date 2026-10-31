# 生产 L0 测试数据卫生（task-83）

两段式：**A 抽取侧跳过闸**（新数据不再被探针会话污染）+ **B 可逆清理工具**（已有探针行，默认 dry-run，执行由人拍板）。

## 1. 现状读数（只读，取数时刻 2026-11-01 02:4x +08）

| 项 | 值 | 来源 |
| --- | --- | --- |
| l0_conversations / l0_fts | 13450 / 13450 行（1:1） | 只读打开 D:/TDB/data/vectors.db |
| l0_vec | unavailable（非 0） | 只读连接不加载 sqlite-vec，COUNT 抛错被 catch |
| 库文件 | 383,037,440 B / mtimeMs 1793468762471.561 | fs.statSync |
| 其中探针占比 | 128 行 / 23 会话 / 934,375 字符 | 2026-11-01 02:5x 生产库 **dry-run 实测**（只读；最大一条 probe-red-…-m100 = 100 行/819,200 字符） |
| 8420 实例 | 本次取证时未监听 | /health code=000；脚本只记 SKIP，不代启 |

取数命令（只读）：`node --import tsx MemoryCore/scripts/l0-testdata-clean.ts --db D:/TDB/data/vectors.db`（缺省 dry-run）。早前记录的 905,703 字符为另一扫描口径，已用全量归档（`scratch/lead/probe-l0-full-archive.jsonl`，Lead 复核 rows=128/sessions=23/chars=934375）更正为 934,375。

## 2. A 段：抽取侧跳过闸（新数据）

- 语义：命中 `ignoreSessionPatterns` 的会话在 L1 批次里**整段跳过**——不进 LLM、不进 l1_records，但**游标照常前进**（先推 maxRecordedAtMs 再 skip，防饥饿）。
- 缺省 `["probe-", "session-probe-"]`，来源是上面 128 行/23 会话的实测形状；前缀匹配（`^` 锚定，不锚 `$`），大小写敏感，`*` 通配。
- 关闭方式：显式写 `ignoreSessionPatterns: []`（空数组 = 关闸）。缺字段 = 用缺省，不是关闸。
- 配置位置：`tdai-gateway.yaml` 的 `memory.extraction.ignoreSessionPatterns`（紧接 `sessionScope`）；代码 `MemoryCore/src/utils/session-ignore.ts` + `pipeline-factory.ts` 循环内闸。
- 可观测：命中时打 info 日志（session_id/session_key + 命中 pattern + 行数，前 5 条 + 余数）并发 metric `l1.batch.sessions_ignored`（值 = 被忽略会话数）；批末 `processedCount` 已扣除忽略行数，不会把跳过算成"处理过"。

## 3. B 段：清理工具（已有探针行）

`MemoryCore/scripts/l0-testdata-clean.ts`，**缺省 dry-run，零写**。

- dry-run 打印：三处计数 → 选中会话表（session_key / rows / chars / first / last / 命中来源）→ 保留会话表（前 40）→ 合计。
- `--yes` 的执行顺序（任一步失败即中止）：计划校验 → 生产库守卫（路径以 `D:/TDB/data` 开头必须加 `--allow-production-db`）→ 非回环 base-url 必须加 `--allow-remote` → 必须有 apiKey → **先全量导出** `docs/ops/archive/probe-l0-<ISO>.jsonl`（全列 + `.sha256`；0 行即抛，中止不删）→ 分批 100 个 session_id 调 `POST /v3/conversation/delete`（带四身份头）→ 复查目标会话残留行数。
- 退出码：0 成功（含 dry-run）/ 1 删后有残留 / 2 参数、导出或接口失败。
- 安全不变量：只有**显式 `--sessions` 列出或命中 `--patterns`** 的会话进计划；`default` 这个 session_id 永远不当真删除 id 传出（否则等于清掉该身份全部缺省会话）；`--sessions` 全不命中模式时要求额外 `--allow-unmatched-sessions`。
- 删除用的是服务端接口（不直删 sqlite），因此级联（l0_fts / l0_vec / 缓存）与 scope 校验都走线上同一套代码。

常用：

```bash
# 1) 看（默认）
node --import tsx MemoryCore/scripts/l0-testdata-clean.ts --db D:/TDB/data/vectors.db
# 2) 删（必须先有导出口径 + 人工确认）
node --import tsx MemoryCore/scripts/l0-testdata-clean.ts --db D:/TDB/data/vectors.db --yes \
  --allow-production-db --base-url http://127.0.0.1:8420 --api-key "$TDAI_GATEWAY_APIKEY" \
  --service-id <svc> --team-id <team> --user-id <user> --agent-id <agent>
```

身份四头必须与行上的归属一致：**不一致就删 0 行**（活体已证，见 §5），这是 scope 闸生效而非 bug。

## 4. 谁执行 `--yes`

**只有 Lead 在用户明确授权后执行**。工具本身不设自动执行路径，也不进任何 cron/后台任务；本票只交付"写好但未在生产执行"的工具与 dry-run 读数。

## 5. 回滚

导出文件是完整行快照（全列，含 record_id/session_key/session_id/team_id/task_id/user_id/agent_id/role/message_text/recorded_at/timestamp/classification）。回滚 = 按行重放 `POST /v3/conversation/add`（list 形态兜底），不改 record_id 哈希前缀；`.sha256` 用于确认导出未损坏。

## 6. 活体证据与边界

- 隔离实例（8495，tmpdir 自毁，embedding none，llm 指向 127.0.0.1:9 零外呼）上 21 项断言：dry-run 零写、三条拒绝路径 exit 2 且库不变、身份头不符 deleted_count=0 且残留 4 行、正确身份 deleted_count=4 且残留 0、真实会话 2 行完好、l0_fts 级联同步 2=2、导出 4 行全列 + sha256 校验通过。
- 生产库前后指纹一致（rows/size/mtimeMs 三项相同）⇒ 本次验收未写生产库；另在**生产库上只读跑 dry-run** 取到 §1 那张表（23 会话/128 行全部命中 `probe-`、`session-probe-` 前缀，真实会话一条未进计划）。
- 边界：l0_vec 只读下恒 unavailable，向量表计数由服务端级联负责；`--yes` 在生产**尚未执行**，实际删除效果以隔离实例为准，不等于生产已清。
