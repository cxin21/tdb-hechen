# 记忆基准评测 harness（LoCoMo + LongMemEval）

> 2026-10-26 · 入口 `npm run bench:memory`（`MemoryCore/scripts/eval-memory-bench.mjs`）
> 目标：用学术界通用、被广泛引用的记忆评测集，给本仓库的记忆系统打一份**可复现、口径写明**的分数。

## 为什么选这两个集子

按 arXiv 全字段短语提及量实测（2026-10-26，`export.arxiv.org/api/query`）：

| 基准 | 出处 | 体量 | 本 harness 用法 |
| --- | --- | --- | --- |
| **LoCoMo** | ACL 2024，`snap-research/locomo`，arXiv 2402.17753 | 10 段极长期对话，19–32 session / 200–600 轮，1986 QA（category 1–5），证据精确到 `dia_id` | 每样本原始对话灌成一个语料组，样本内 QA 逐题检索 |
| **LongMemEval** | arXiv 2410.10813，`xiaowu0162/LongMemEval` | 500 题 / 6 类能力（信息抽取、多会话推理、时序推理、知识更新、弃权、偏好） | `longmemeval_oracle`（500 题，每题自带证据会话） |

口径提醒：**oracle 子集每题只带 36–82 轮证据会话**（候选池小），不等于 `longmemeval_s`（~115MB）/
`longmemeval_m`（~1.5GB）那种「大海捞针」的长上下文版本。报告里必须写明这一点，不能拿 oracle 分数
类比论文里的 s/m 分数。

## 纪律：生产同路，检索层零重实现

`scripts/lib/bench/` 只做桥接，不引入第二套打分：

- 配置：读生产 `tdai-gateway.yaml` + 生产 `config-override.json`（`loadGatewayConfig` 同一套解析），
  env 只把 `TDAI_GATEWAY_CONFIG`/`TDAI_DATA_DIR` 指向一次性沙箱（`%TEMP%/tdagemem-bench/<dataset>-<rand>`），
  **绝不写生产 dataDir**。
- 写入：`createStoreBundle` → `store.init` → `store.upsertL1`（生产写入路径）。
- 召回：`performLayeredRecall`（与 `/v3/recall` 端点字面同一函数），消费其 `recalledL1Memories` / `perfMs`，
  不自己算相似度。
- 生成+判分：独立 LLM 调用（`scripts/lib/bench/llm.mjs`），与检索解耦，`--gen-limit 0` 即纯检索。

## 指标定义（报告里逐条复述，避免"数字好看但定义含糊"）

| 指标 | 定义 |
| --- | --- |
| `session_any@k` | top-k 内任意一行来自证据 session → 该题命中（LongMemEval 官方口径） |
| `session_cov@k` | 命中的证据 session 数 / 证据 session 总数 |
| `turn_cov@k` | 命中的证据 turn 数 / 证据 turn 总数（LoCoMo 精确到 `dia_id`） |
| `MRR` | 首个证据命中的位次倒数，无命中记 0 |
| `nDCG@k` | 二值相关性（证据=1）的折扣累积增益 |
| 召回延迟 | 单题 `performLayeredRecall` 端到端 ms（含 query 扩展外呼） |
| `LLM 判对率` | 生成答案交由 LLM 判分与 gold 是否一致 |
| `token-F1` | LoCoMo 官方风格 token 重叠 F1（仅供与论文口径对话） |

## 证据对齐：三个真实踩过的坑（都已修，改动留住以免重犯）

1. **session 坐标不统一** → LME 的 `answer_session_ids` 是原始 id，而 turn id 用位置序号，两边对不上，
   `session_any` 恒为 0（而 `turn_cov` 正常，自相矛盾暴露了 bug）。改：加载时把原始 session id 映射成
   `session_<位置序号>`，原始 id 留在 `meta.rawSessionIds` 供溯源。
2. **召回行是「渲染后文本」**：带 `[type|scene]` 前言与 `·soul[...]` / `·(活动时间:…)` 尾注，拿它去比对
   落库原文自然对不上。改：用生产同一个 `stripMemoryLineMeta` 剥标注后再全文比对；
   内容索引键统一走 `normHead`（折叠空白、**不截断**）——早期截断前 120 字 + 尾注残留导致不同 turn
   撞同一 key，证据错配成相邻会话。
3. **embedding 静默丢弃向量**：豆包 embedding 账号级限流会直接 `HTTP 429 AccountRateLimitExceeded`，
   旧逻辑「批失败→逐条再试→再失败就放弃」会把 419 轮里 323 轮写成**没有向量**，
   召回静默退化成纯 BM25/FTS。改：`embedWithRetry()` 指数退避 + 模块级限速闸（最小间隔 400ms）+
   并发默认 1，并把 `embedRetries` 写进报告。**判断一次跑有效与否的唯一标准：`embedding（失败 0）`。**
   另实测硬约束：该模型 `input` 上限 **8 条/请求**，>8 直接 `HTTP 400 InvalidParameter`。

## 跑法

```bash
cd MemoryCore
npm run bench:memory -- --dataset longmemeval --limit 500 --gen-limit 0 --pace 200
npm run bench:memory -- --dataset locomo --limit 120 --gen-limit 0 --pace 200
npm run bench:memory -- --dataset longmemeval --limit 40 --gen-limit 40
```

常用参数：`--limit`（题数）/`--gen-limit`（生成+判分题数，0=只检索）/`--k`/`--pace`（每题间隔 ms，
限流账号必加）/`--concurrency`（默认 1）/`--keep`（保留沙箱）/`--store <dir>`（复用已灌库）。

报告落 `MemoryCore/.eval-data/bench/<dataset>-<UTC时间>.{json,md}`（含逐题 `rows`、分题型 `perType`、
被测配置与灌库统计）；数据集文件落 `D:\TDB\td-agemem\.eval-data\`。

## 结果

（跑数中；有效跑数的判据是报告「灌库统计」里 `失败 0`。）

| 数据集 | 题数 | session_any@5 | session_cov@5 | turn_cov@5 | MRR | nDCG@5 | 召回延迟 mean | LLM 判对率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LoCoMo（单样本冒烟，全量向量） | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 3455ms | — |

## 已知限制

- **embedding 配额是瓶颈**：账号 RPM 很紧，一次只能跑一个基准进程；大批量灌库会大量 429
  （实测 419 轮触发 158 次退避重试才全部成功）。跑全量前先确认没有别的进程在抢配额。
- LoCoMo 单样本语料就有 419 轮，逐题召回 ~2.5–3.5s；全量 1986 题不做生成判分也需要数小时，
  因此常规做法是「检索全量 + 生成判分子集」。
- oracle 口径 ≠ 长上下文口径（见上）。
- 判分模型沿用生产配置的 LLM；报告里记录 `judgeModel`，跨版本比较时必须同模型。