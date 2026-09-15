# 记忆维度口径对照表（GOLD-EVO P1 · 2026-09-15）

> 目的：单一事实源——记录每个维度的代际、口径、消费方与"同名异义"陷阱。
> 依据：2026-09-15 全量审计（23 维度 × 13 消费者，file:line 报告）。

## 1. 时间字段三代同堂

| 代际 | 字段 | 语义 | 消费现状 |
|---|---|---|---|
| 一代 | `timestamp_str` / `timestamp_start` / `timestamp_end` | 活动时间窗（capture 期） | 展示；⚠️ 被错位映射为 API 的 created_at/updated_at（memory-search.ts:1078-1079） |
| 二代 | `metadata.activity_start_time` / `activity_end_time` | 活动窗（LLM 抽取期） | 展示、巩固跨期计算（grouping.ts:52-55）、遗忘兜底 |
| 三代 | `occurred_at` / `valid_start` / `valid_end` | 业务发生时间 / 效期（P2a 灵魂列） | **过滤/排序唯一键**（queryL1Paginated TIMEFIX-v2，sqlite.ts:4404-4418）；遗忘 ageDaysOf 首选；valid_* 当前无写入方（P2 失效语义将激活） |
| 系统 | `created_time` / `updated_time` | 行创建/更新簿记 | updated_time 被重巩固 bump 刷写（touchUpdatedTime 可关，P1）——**禁止再作业务过滤/排序键** |

**口径约定**：一切业务语义的时间过滤/排序/年龄计算 = 三代（occurred_at）；一代/二代仅展示与兜底。

## 2. valence 同名异义（勿混）

| 字段 | 域 | 语义 | 消费 |
|---|---|---|---|
| `l1_records.valence` | 连续 -1..1 | 记忆的情感色调（LLM 抽取必填） | 遗忘 \|valence\| 回退（scorer.ts:41）、R9（关断）、展示 |
| `core_values.valence` | 枚举 -1/0/1 | 价值锚的动机方向（LLM derive） | Panel 方向徽标、R9 moodSign 派生源（关断）、current-feeling 注入 |

## 3. 硬编码常数清单及判定（GOLD-EVO 配置/硬编码裁定）

| 常数 | 位置 | 判定 | 备注 |
|---|---|---|---|
| `RRF_K = 60` | memory-search.ts（两处） | **硬编码**（协议不变量） | Cormack et al. (2009) 标准常数；配置化只会诱导破坏契约的乱调 |
| `recallCountBoost = min(c,5)*0.02` | forgetting/scorer.ts:59 | 待 P5 校准 | R8 数据前提补齐后（P1 钩子路 bump）进校准特征 |
| neighborExpand 邻居分 `0.2` | memory-search.ts:1274 | 待 P5 校准 | 同上 |
| `DEFAULT_COMPOSITE_WEIGHTS` 0.7/0.15/0.1/0.05 | memory-search.ts:583 | 待 C 轨取代 | 校准产物写 rerankWeights（yaml） |
| `firedThreshold 0.4` | appraisal.ts:17（proxy config 有同名字段） | yaml | 已配置化 |
| `ATTEMPT_COOLDOWN_MS = 3600_000` / `REWEIGHT_DELTA = 0.05` | anchor-growth.ts | 硬编码（前者）+ 硬编码（后者） | 冷却分级属协议；GROW-MAINT 登记 |
| `ABSTAIN_FLOOR = 0.5` | eval-capabilities.mjs | 硬编码（评估协议） | OOC query 须经临时库实测零命中后选用 |
| `DISCOVER_MIN_EVIDENCE = 3` / `DISCOVER_SAMPLE_CAP = 50` | core-values-discover.ts | 硬编码（prompt 契约） | 与提案 prompt 绑定 |