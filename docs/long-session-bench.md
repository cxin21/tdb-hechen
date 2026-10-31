# 长会话退化基准（#168）

> 目的：把「写侧固化开关」（`write.supersession` / consolidation）从**无人量化**变成**可离线、可复现、与判分器无关**的读数。
> 现状问题是：此前所有 bench 读数几乎都在 `--no-write-steps` 档跑（整段跳过写侧），
> 所以 `docs/optimization-results.md` 里没有任何数字能回答「长会话下旧值会不会被反复召回」。
> 本基准不产生 LLM 调用，因此**不受** MiniMax-M3.1-Flash / scm-flash 两把判分尺的「不可配对」约束。

## 1. 它回答什么

| 问题 | 指标 | 期望方向 |
| --- | --- | --- |
| 同一实体同一属性被更新 k 次后，问「现在是什么」还能答对吗 | `currentHitRate` / `currentTop1Rate` | ↑ |
| 注入块里还会混进**已被取代的旧值**吗 | `staleInjectionRate`（旧值注入率） | ↓ 0 |
| 问「当时是什么」还能召回当时的值吗（历史不塌） | `historyHitRate` | 不下降 |
| 同一属性还挂着几条互相矛盾的有效行 | `activeDistinctValues`（重复行率的口径） | ↓ 1 |
| 会话越长退化越厉害吗 | `curve.byCaseSize`（31-38/39-47/48-60 轮三档） | 平坦 |
| 写侧代价 | `writeMs` p50/p95、`supersedeOps`、`supersedeMs` | 可接受 |

**不回答**：答案措辞质量、拒答措辞、生成侧 token 成本。这些仍归 judge 门禁那套口径（#140/#154）。

## 2. 三臂

| arm | 写侧 supersession | 写侧折叠（consolidation 替身） | 对应生产开关 |
| --- | --- | --- | --- |
| A `baseline` | 关 | 关 | **不等于现缺省**：A 臂 = 显式关 supersession。2026-10-31 WP1b 起代码缺省是 supersession **开**（`MemoryCore/src/core/record/write-policy.ts:101`），factKey / factRows 仍关（`:92-99` / `:102`；`DEFAULT_WRITE_POLICY` 在 `:91`） |
| B `supersede` | 开 | 关 | `write.supersession.enabled=true` |
| C `supersede+fold` | 开 | 开 | supersession + 持续态折叠（目标形态，见 `docs/optimization-results.md` §27） |

arm B/C 走的是**生产同一份实现** `MemoryCore/src/core/record/supersession.ts:computeSupersessions`（按 `(subject,predicate,attribute)` 归并、只对 single 值失效、同刻按输入序），
失效落库走 `store.invalidateL1(id,validEnd)`（`MemoryCore/src/core/store/sqlite.ts:4568`，只改 `valid_end IS NULL/''` 的行并同步 `l1_fts`）。
arm C 的折叠行是**确定性替身**：一条 `work_fact`/`consolidated` 持续态行 + `part_of` 链回各更新轮。

## 3. 语料规格（`MemoryCore/scripts/lib/bench/long-session-corpus.mjs`）

- 每条 case = 一个实体 + 一个属性 + k 次更新（`k∈[5,10]`）；每次更新独占一个 session（3-6 条 filler + 1 条更新轮），尾部再补一个**无更新**的收尾 session。
- 轮数落在 31-60（`--turns-min/--turns-max` 可调，默认 20/60；实际下界由 k 与 filler 数决定）。
- 每条 case 出 2 道题：
  - `current`：问「现在…是什么？」，gold = **时间上最后一次**更新的值，提问时刻 = 收尾 session 时刻（严格晚于最后一次失效时刻，避免 valid_end 并列）；
  - `history`：问「在 <某次更新日期> 的时候…是什么？」，gold = 该时刻的值，`staleValues` = 该时刻之后才出现的值。
- 属性族固定在 **single 值语义**（负责人/住址/粉丝数/预算/体重/常住城市），避免被 #136 的多值契约挡掉——本基准不测多值属性。
- 更新轮文本**不复述旧值**（`X 的负责人现在更新为 Y。`），否则旧值会因字面出现在新行里被算成假注入。
- 写侧事实（subject/predicate/value）由生成器直接给出（`factsByCase`），**零 LLM 抽取**。

> 口径陷阱（实现时真实踩到过，别再犯）：
> 1）session 日期必须随更新序号**严格递增**。第一版用「每次随机 9-21 天间隔」，导致时间上最后的值不是 ordinal 最后的值，`computeSupersessions` 按时间把 gold 失效掉，当前值命中率变成假读数（arm B 的 gold 被换成旧值）。
> 2）离线向量维度必须以 `cfg.embedding.dimensions` 为准。`openBenchStore()` 在远端 provider 未真正初始化时 `getDimensions()` 返回 0，若按 0 建 hash 向量（默认 256 维）会与 sqlite vec0 的 2048 维表不匹配，`upsertL1` 静默丢行（日志只有 `Dimension mismatch` 的 non-fatal warn），最终召回全空。

## 4. 命令

```bash
cd MemoryCore

# 1) 只生成语料（dry-run，零网络、零建库）
node --import tsx scripts/gen-long-session-bench.mjs --cases 40 --out .eval-data/long-session

# 2) 离线机制冒烟（hash 向量；验证写侧与度量管道，不是检索质量读数）
node --import tsx scripts/gen-long-session-bench.mjs --run --offline-embedding --cases 4 --arm A,B,C

# 3) 真实读数（需要 embedding 凭据；会外呼，按 --embed-interval-ms 限速）
node --import tsx scripts/gen-long-session-bench.mjs --run --allow-embedding --cases 40 --arm A,B,C --embed-interval-ms 400

# 4) 指定沙箱源配置 / 复用库目录 / 只跑前 N 条
node --import tsx scripts/gen-long-session-bench.mjs --run --offline-embedding --limit-cases 2 \
  --src-yaml tdai-gateway.yaml --store-root .eval-data/long-session/stores
```

`--run` 必须显式二选一：`--offline-embedding` 或 `--allow-embedding`（防误外呼）。默认 `--store-root` 为空时用 `makeStoreDir` 的临时目录。

### 4.1 用同一套 hash 向量验证度量管线（M6/M7/M8 端到端）

`eval-memory-bench.mjs` 也支持 `--offline-embedding`（共用 `scripts/lib/bench/offline-embedding.mjs`），
用于在没有 embedding 凭据的环境里把「报告生成 → config.effective → 判分门禁 → 只追加写盘」整条链路跑通：

```bash
cd MemoryCore
# 1) 生成小语料（dry-run）
node --import tsx scripts/gen-long-session-bench.mjs --cases 4 --out .eval-data/long-session
# 2) 用其 oracle 走完整 eval 管线（--gen-limit 0 = 只测检索，不产生判分）
node --import tsx scripts/eval-memory-bench.mjs \
  --dataset longmemeval --data .eval-data/long-session/long-session-oracle.json \
  --limit 8 --gen-limit 0 --offline-embedding --no-embed-cache --rerank-off \
  --report-name m678-smoke --out .eval-data/bench
```

这种报告的三个自证字段（缺一不可）：
`config.embeddingVector.mode="offline-hash"`（+ `caliber` 文案）、`config.effective`（逐键 `cli|file|default` 来源 +
指纹）、`judging.invalid=true`（judged=0）。因为 `judging.invalid`，`bench-report.mjs` /
`bench-bucket-paired.mjs` 会对它 **exit 3**；只有显式 `--allow-unjudged` 才放行打印（仍带 warn）。
hash 向量档会自动禁用 embed-cache，避免把 hash 向量写进真实模型的缓存键（`<model>-<dims>`）。

## 5. 产物

| 文件 | 内容 |
| --- | --- |
| `long-session-corpus.json` | 全部 case（turn 原文、时间戳、updates、questions、gold） |
| `long-session-facts.json` | 写侧三元组 sidecar（`factsByCase[caseId][turnId].triples`），零 LLM |
| `long-session-oracle.json` | 标准 LongMemEval-oracle 形状，可直接 `--dataset` 喂 `eval-memory-bench.mjs`（走生产读侧 + LLM 判分） |
| `long-session-goldens.json` | 精简 gold（人工抽查用） |
| `long-session-<arm>-<yyyymmdd-HHMMSS>.json` | 单臂报告：`metrics` + 逐题 `questions` + `caliber` + `config.effective` |
| `long-session-suite-<stamp>.json` / `latest.json` | 三臂汇总与指针 |

报告里的 `caliber.judge = "none（deterministic ground truth）"` 是硬标记：**这份报告没有 judged 覆盖，不要拿它跟 judge 门禁报告并列**；它也不是 `eval-memory-bench` 的 schema，`bench-report.mjs` / `bench-bucket-paired.mjs` 的判分门禁不适用。

## 6. 离线机制冒烟读数（2026-10-31，3 cases / 147 轮 / 23 次更新 / 6 题，offline-hash 向量）

| arm | 当前值命中 | top1 | 旧值注入 | 历史命中 | 重复值/属性 | 块字符 p50 | 失效 op | 折叠行 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A baseline | 33.3% | 33.3% | 100% | 100% | 7.67 | 520 | 0 | 0 |
| B supersede | 100% | 100% | 0% | 100% | 1.0 | 509 | 20 (single 20) | 0 |
| C supersede+fold | 100% | 100% | 0% | 100% | 1.0 | 434 | 20 | 3 |

**怎么读这张表**（重要，别过度解读）：
- 它证明的是**机制与度量管道**已通：A 的重复值与旧值注入必然是满的；B 把重复值压到 1、旧值注入压到 0 且历史命中不塌；C 再加折叠行、块体积进一步缩小。
- **命中率不是质量读数**：离线 hash 向量只保证「同一字面串能召回」，3 条 case / 6 道题的分母也太小。真实读数必须用 `--run --allow-embedding` 在 40 条 case 上跑。
- 写侧耗时（0.7-0.9 ms/轮）不含 LLM 抽取（三元组是预置的），所以**不能**拿它当生产写侧成本。

## 7. 与生产实现的差异（引用这些读数时必须一起说）

1. **没有 LLM 抽取/去重**：生产 `src/core/record/l1-writer.ts` 先让模型抽事实、判重、写 `factKey`；本基准直接给三元组。所以它测的是「失效与折叠的收益上限」，不是端到端写侧收益。
2. **arm C 的折叠是确定性替身**：生产 `src/core/lifecycle/consolidation/consolidation-worker.ts` 是 LLM 驱动、按 subject 分组产持续态；本基准用模板文本 + `part_of` 链模拟。
3. **读侧是生产实现**：`makeRecall` 走 `auto-recall` 同一套（检索 + 精排 + 组装 + 注入渲染），精排默认关闭以省本地模型加载；所以召回块体积与块内旧值分布是有意义的。
4. **单实体、无噪声会话**：语料里没有其他实体的干扰，测的是「同一属性多值」这一种退化，不含跨实体串味。

## 8. 已知限制 / 未验证项

- 真实 embedding 下的读数：**未验证**（本次只跑离线机制冒烟）。
- 多值属性（`interest/plan/...`，#136 契约）：**未覆盖**。
- 时间并列边界（同一时刻两条更新）：生成器不产生，未验证 supersession 的 tie-break 在真实链路上的表现。
- 生成侧答案措辞 / 拒答：不测。
- 与 `docs/optimization-results.md` 现有任一读数**不可并列**（不同语料、不同判分口径）。
- 未接入 CI：跑 40 条 case 需真实 embedding，成本与 #160 的 token 账分开记。

## 9. 使用建议（怎么用这份读数决定生产开关）

1. 先看 `staleInjectionRate`：长会话下若显著 >0，`write.supersession.enabled` 是治本项（#153/#172 的讨论也依赖这一点）。
2. 再看 `duplicates.activeDistinctValues` 与 `canonicalRows`：失效后仍 >1 说明还有「同属性多有效值」，需要折叠（consolidation）。
3. 最后看 `historyHitRate` 与 `blockChars.p50`：折叠的代价项。若历史命中下降或块体积上升，说明折叠粒度错了（不该按 subject 粗折）。
