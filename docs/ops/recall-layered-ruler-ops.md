# 召回选线尺（#179）— 生产开关与回退

适用版本：MemoryCore 侧 `recall.layerRuler` / `recall.injection` 两段配置（#179 交付）。
运行时真源：`D:/TDB/data/config-override.json` 的**顶层** `layerRuler` / `injection` 两段（settings-override 白名单，读写时并入 `memory.recall.*`；与 `rerank` / `importancePenalty` 同型）；
代码缺省 = **今天行为**（mode=off、foldIdentical=false、budgetByIntent 全 null），所以「什么都不写」等于没上线。

## 1. 开关一览

| 键 | 取值 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `layerRuler.mode` | `off` \| `shadow` \| `enforce` | `off` | off=逐位今天行为；shadow=只记 `wouldDrop` 不改注入；enforce=真按名次尺裁行 |
| `layerRuler.keepRatio` | (0,1] | `0.67` | 层内按名次保留比例（层间不竞争，每层至少 `minPerLayer` 条） |
| `layerRuler.minPerLayer` | ≥1 整数 | `1` | 每层下限；层被地板清空时不补位 |
| `layerRuler.floor` | `null` 或 `{model,dims,value}` | `null` | 查询-行余弦相似度地板；model@dims 必须与当前 embedding 端点一致，否则按 null 诚实 no-op |
| `layerRuler.lengthLambda` | ≥0 实数 | `0` | v2 名次折扣：`rankScore = cos − λ·log10(1+chars/100)`（只改名次，不改地板）。实测生产取 0 最稳 |
| `layerRuler.margin` | `null` 或实数 | `null` | v2 层内相对 margin（原始 cos 刻度） |
| `layerRuler.dedupeSim` | `null` 或 (0,1] | `null` | v2 近重复抑制（与已留者 ≥ 阈值即丢）。生产实测重复对 0.938，但地板+预算已挡住 → 生产留 null |
| `layerRuler.budgetMs` | 50..5000 整数毫秒 | `300` | v3 单轮选线预算；到点整段 bypass（见 §1.1）。生产值 800 |
| `injection.foldIdentical` | boolean | `false` | 同会话相邻「回合」注入行逐字节相同 → 折叠为 0 行 |
| `injection.budgetByIntent` | `{empty,continuation,self,info}` 各 `null` 或非负整数 | 全 `null` | 按意图的注入行上限，null=不裁 |
| `injection.maxLineChars` | `null` 或正整数 | `null` | v2 单行渲染上限（码点，句界收口，不改判定） |
| `injection.maxChars` | `null` 或正整数 | `null` | **v3 本轮注入总字符预算**：选线后按名次装填，装不下记 `droppedBy.chars`；bypass 轮同样守住（原序装填，见 §1.2） |

### 1.1 单轮增量预算与降级（选中即写进 journal 的 `ruler` 段）

- 预算：`layerRuler.budgetMs`（代码缺省 300，**生产值 800**；`MemoryCore/src/core/recall/selection/injection-stage.ts` 的 `SELECTION_BUDGET_MS` 是下限兜底）。**到点即放弃本轮选线**，不等语义通道返回，也不部分应用。
  为什么生产从 300 抬到 800：实测火山 Ark `/embeddings`（doubao-embedding-vision, dims 2048）单次 RTT 111/170/179/284/320/382ms（p50≈175、p75≈300）——300ms 预算下「查询嵌入一次」就可能超时，选线在生产恒降级为原序截断（名次与地板失效）。切到 800 后实测 bypass 1/18=5.6%（p50 340ms、p95 814ms）。
- 降级两种：**没配 `injection.maxChars` 时**与 `mode=off` 逐位一致（不砍行）；**配了 maxChars 时**走字符预算兜底（§1.2），绝不为降级而全量注入：
  | `ruler.bypass` | 触发条件 |
  | --- | --- |
  | `ruler-budget` | 本轮嵌入批次+纯选择耗时超 300ms（含 800ms 语义超时的到点放弃） |
  | `ruler-unavailable` | 嵌入抛错 / 空向量 / 零模长 / 维度不符 / 返回长度不符 |
- 观测：`ruler.ms` 只统计「新增嵌入批次 + 纯选择」的增量；**bypass 轮的 ms 到点即停**，所以判分要看 bypass 计数，而不是只看 ms。
- 生产 embedding 单请求最多 10 条输入（超限 HTTP 400），接线层按 10 切片；行数多的大池会走多次请求，更容易撞预算 → 表现为 `ruler-budget`。
- **嵌入内容寻址缓存**（`injection-wiring.ts` 的 `embedCached`）：按 `<model>@<dims>\0<文本>` 缓存向量，LRU 上限 1024 条（≈8MB 上界），进程内即生命周期、不落盘。动机=实测不加缓存时 40 轮重放有 15/40 轮直接撞 300ms 预算（降幅 16.3%→11.8%）；加缓存后同批样本 bypass 降到 7/40、降幅回到 20.8%、p95 286ms。缓存命中不等于放宽判据：向量确定性由「同模型同文本」保证，换端点因键含 model@dims 不会串味；测试要模拟「嵌入抛错」时必须先 `clearEmbeddingCache()`，否则零请求不会抛错。

### 1.2 字符预算兜底与零行纪律（v3）

- **bypass 轮也守预算**：`ruler.bypass` 非空且配了 `injection.maxChars` 时，按**候选原序**（不引入新排序）贪心装填到预算，装下的注入、装不下的记 `droppedBy.chars`，并写 `ruler.fallback="char-budget"`。装得下 0 行也照样接管（否则 `judgeKept=null` → 退回全量注入，预算被静默绕过）。
- **零行纪律**：选线判空（全低于地板 / 同回合折叠 / 意图行上限为 0 / 字符预算装不下）时**整段不输出**——不再吐一个只有外壳的 `<relevant-memories></relevant-memories>`（"说有记忆却一行不给"比不注入更差）。
- **观测口径（重要）**：journal 的 `memoryLines` 是**候选池（选前）**，不是注入内容。真正的注入量看 `selection.poolChars` / `selection.injectedChars`（v3 新增）与 `selection.kept`。用 `memoryLines` 长度和判「是否超出 maxChars」会得出反结论（实测把 562 字符的注入误读成 1400）。

地板标定产物：`D:/TDB/data/calibration/embedding-sim-floor.json`（键 `<model>@<dims>`，由 `MemoryCore/scripts/calibrate-embedding-sim-floor.ts` 用 journal 跨会话 query×line 的 null-probe 分布算出）。
重算命令（离线批任务，自带节流与长退避；账号级 429 时请把 `--delay-ms` 再放大）：

```bash
cd D:/TDB/td-agemem/MemoryCore
npx tsx scripts/calibrate-embedding-sim-floor.ts --pairs 300 --delay-ms 10000
```

## 2. 切换步骤（shadow → enforce）

1. 改 `D:/TDB/data/config-override.json`，在**顶层**加入（或改）`layerRuler` / `injection` 两块 —— **只动这两段，不碰 rerank/ORT**：

```json
{
  "layerRuler": { "mode": "enforce", "keepRatio": 0.67, "minPerLayer": 1, "budgetMs": 800, "lengthLambda": 0,
                  "floor": { "model": "doubao-embedding-vision", "dims": 2048, "value": 0.3 } },
  "injection": { "foldIdentical": true, "maxChars": 600,
                 "budgetByIntent": { "empty": 0, "continuation": 1, "self": 1, "info": null } }
}
```
2. **必须重启 core**：配置只在启动时读，没有 watch 通道。
   ```powershell
   pwsh -NoProfile -File D:/TDB/etc/start-tdb.ps1
   ```
   影响面：core（8420）重启期间召回/写入不可用，DSh 侧请求会失败重试；窗口约 10–30 秒。
   不要直接跑 `start-tdb-supervised.ps1`（会 takeover，杀 panel/proxy）。
3. 启动后冒烟：随便聊一轮，然后读 `D:/TDB/data/logs/recall/recall-journal-*.jsonl` 最后一条，确认
   `ruler.mode='enforce'`、`selection.droppedBy` 有非零档、`candidates.lines` 完整（超 40 条时 `truncated:true` 但汇总完整）、
   新增字段增量 < 4KB。

## 3. 一键回退

把顶层 `layerRuler.mode` 改回 `off`（`injection` 两键同时置 `false`/全 null 更彻底），重启 core。
**off = 逐位今天行为**，不需要回滚代码、不需要恢复数据；已写入的记忆不受影响（选线只在注入期工作）。
回退演练记录见 `docs/ops/recall-layered-ruler-rollback-drill.md`。

## 4. 观察窗与触发即回退的线

上线后 24h 观察窗（只需开头状态即回报，不必等满）：

- 核心报错 / 崩溃 / core 起不来；
- 单轮选线增量 p95 > `layerRuler.budgetMs`（生产 800）—— 预算守卫已经把单轮增量硬封在该值，所以真实判据是 **`ruler.bypass="ruler-budget"` 占比**：>30% 说明选线在生产基本不生效（慢轮持续降级），按回退处理；
- 地板取 **0.30**（v3 定案，替代原 0.3126=p50）：golden 37 行实测——0.3126 会丢掉 P3 的 high（cos 0.311），0.30 无预算时 high 召回 0.900→**1.000**；0.30 + maxChars 600 定案点为 high 0.900 / lowKeep 0.346 / 字符降 88.2% / 0 行轮 1/10 / **「整轮把 high 全丢」的轮数 0**。唯一代价：P6 有一条 431 字 high 被同轮 596 字 high 挤出 600 预算（已记录，见规格 §8）；
- 生产 24 轮重放（floor 0.30 + maxChars 600）：98 行/26379 字符 → 50 行/9638 字符（**降 63.5%**）、0 行轮 0；真机 18 轮实测池 31101 字符 → 注入 8455 字符（**降 72.8%**）、超 600 的轮 0、bypass 5.6%；
- 0 行轮占比 > 30%（分母 = 去掉同轮重复后的回合数；基线 16.1%）；选线判空时整段不注入（v3 零行纪律），所以 0 行轮不再产生空壳记忆段；
- 用户主观反馈「更不沾边」。

任一条命中 → 按 §3 回退，并在票上记录命中项与 journal 证据行。