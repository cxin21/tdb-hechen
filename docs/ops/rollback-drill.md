# 召回全开档 · 回滚演练单（#149）

- 状态：可执行（2026-10-31 首版；演练记录见 §6，尚未有执行记录）
- 上位依据：`docs/audit/2026-10-31-open-issues-first-principles.md` §3 根节点 B（配置真源分裂）、§4.5 #149 行
- 读数出处：`docs/optimization-results.md` §8（A/B 配对）、§19.3（rerank filter 定档）、§21.3（旋钮存废台账）
- 相关票据：#149（本单）、#154（缺省登记，见 `docs/ops/config-default-ledger.md`）、#168（W1 去留裁决，本单不裁决只给退路）、#172（观测面）

## 0. 为什么需要这张单

「全开」不是最优，只是**可回退的实验档**。同一批配对里：

| 档 | 唯一差别 | 判对 | turnCov | sessionCov |
|---|---|---|---|---|
| A 全开 | `write.factKey.enabled: true`（+ W2 契约门 + W3×4 + validity soft） | 82.2% | 78.8% | 94.0% |
| B | `write.factKey.enabled: false` | **84.4%** | **79.3%** | 92.9 |

判对 B 高 **2.2pp**（McNemar 2 对 / 0 错，不显著）、turnCov +0.5pp、sessionCov −1.1pp。也就是说：全开档在判对上更差、在覆盖率上更"全"，谁该留由 #168 裁决；但**任何时刻都必须能一条命令退回去**，否则档只能整体推倒重配。

本单只解决"怎么退、退完看什么、什么算退成功"，不重新裁决任何键的去留。

## 1. 配置生效链（先搞清改哪儿才算数，否则演练全是假阳性）

### 1.1 进程加载哪个文件（顺序即优先级）

来源：`MemoryCore/src/gateway/config.ts:388-397` 头注 + `resolveConfigPath():839-858`

1. `TDAI_GATEWAY_CONFIG`（显式路径，最高优先）
2. 当前工作目录（CWD）下的 `tdai-gateway.yaml` / `tdai-gateway.json`
3. `<dataDir>/tdai-gateway.yaml` / `.json`
4. 都没有 → 纯 env

**yaml 只在进程启动时读一次（`parseConfig`），没有热加载。改完必须重启。**

### 1.2 谁是"真源"：三套并存，看进程实际加载了哪个

| # | 文件 | 用途 | 本轮实测内容 |
|---|---|---|---|
| 1 | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | 云/生产部署模板（生产契约） | factKey **false**（:66-68）、supersession **true**（:80-81）、factChannel **false**（:163-164）、validity **soft**（:229-233）（2026-11-01 重核） |
| 2 | `deploy/global-images/start-memory-core.sh:73-141` **渲染**的 `${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}/tdai-gateway.yaml` | 非 tencent 路径的 docker 部署（global-images） | 生成方式 = `cp tdai-gateway.base.yaml` **全量渲染**（BASE_CONFIG `:79`、cp `:97`、仅单键占位符替换 `:108-141`），决策键**继承 base 的显式值**：validity **soft**（base `:255-257`）、maxResults **10**（`:159`）、supersession **true**（`:100-101`）、rerank.enabled **true**（`:403-404`）、rerank.candidates **32**（`:411`）、smallToBig additive×**4**（`:340` + `:349`）；手改该文件会在下次启动被覆盖 |
| 3 | `MemoryCore/tdai-gateway.yaml` | 本地开发档（`.gitignore:142`，不入库） | 全开实验档：factKey true(mode channel) / supersession true / validity soft / candidateK 32 / factChannel true / fusion normalized / smallToBig maxExtraLines 4 |

⇒ 演练前必须先确认"我改的是哪一份、进程读的是不是这一份"：

```bash
echo "TDAI_GATEWAY_CONFIG=${TDAI_GATEWAY_CONFIG:-<unset>}"
git check-ignore -v MemoryCore/tdai-gateway.yaml   # 确认本地档不入库（回滚不能靠 git checkout）
ls -l ./tdai-gateway.yaml                          # CWD 档存在就会盖过 <dataDir> 档
```

### 1.3 `config-override.json` 优先级高于 yaml，但只覆盖六段

来源：`MemoryCore/src/gateway/settings-override.ts:56-63`（接口）/ `:65`（文件名）/ `:68-76`（读取 + 损坏回落）、`MemoryCore/src/gateway/config.ts:495`

- 文件位置：`<dataDir>/config-override.json`；损坏按"无 override"处理。
- 覆盖段**只有**：`llm` / `embedding` / `rerank` / `importancePenalty` / `worthiness` / `extraction`。
- 优先级原话：`Admin settings override > yaml > TDAI_LLM_* env(deprecated)`。
- 推论（最容易踩的坑）：
  - 改 `recall.*`、`write.*` ⇒ override 吃不掉，改 yaml 有效；
  - 改 `recall.rerank.*`（enabled / candidates / minScore / mode）⇒ **会被 override 段压过去**，#135 期间就发生过一次静默覆盖。
  - 本机 2026-10-31 实测 `D:/TDB/data/config-override.json` 只有 llm/embedding/rerank/importancePenalty/worthiness，未碰 recall/write —— 但**每次演练都要重读，不能引用这句结论**。

### 1.4 生效自证：目前没有 `config.effective` 快照

审计 §2.3-1 / M6：报告里没有"本次进程实际生效配置"的快照（雏形只有 `MemoryCore/scripts/lib/bench/store.mjs:981-1026` 的 `recall.excludeInvalidated.effective`）。所以"改到底生效没有"只能四者交叉：

1. yaml 原文（`grep` 到键与值）；
2. `config-override.json` 里没有对应该段的覆盖；
3. bench 报告的 config 段 / `--expect-config` 断言（bench 侧）；
4. journal 的门观测 —— **只有部分键可观测**，见 §2 表"journal 观测点"列。

## 2. 回滚开关清单（逐键：位置 / 现值 / 回滚值 / 预期读数 / 观测点）

> 回滚口径（2026-11-01 重核）：**不是所有键都能「回代码缺省」**。ADR-0011 事实通道三开关（factKey / factChannel）缺省仍为关，回滚 = 删段或写 `false`；但 ADR-0010 的两轴缺省已翻转——`write.supersession.enabled` 缺省 **true**（`MemoryCore/src/core/record/write-policy.ts:101`）、`recall.validity.mode` 缺省 **soft**（`MemoryCore/src/config.ts:2234-2253`，非法值也落 soft + 告警）。所以这两轴的「回滚」= **显式写回旧档**（`supersession.enabled:false` / `validity.mode:hard`），删键只会回到新缺省；全程仍**不需要改代码、不需要回滚代码**。

| 优先级 | 键 | 回滚值 | 预期读数（配对实测） | journal 观测点 |
|---|---|---|---|---|
| **1（首选）** | `write.factKey.enabled` | `false` | 判对 **+2.2pp**、turnCov +0.5pp、sessionCov −1.1pp（A→B，§8） | 无独立门；看 `strategy` 与 `gates.nativeMinRRF`/`rerank` 的条数变化 |
| 2 | `recall.validity.mode` | 显式写 `hard`（代码缺省已 **soft**，`MemoryCore/src/config.ts:2234-2253`；回显 hard 会走 #174 的 hard 语义） | `hard` 判对 **−3.3pp**（§21.3 台账；台账该行两处曾写反，见 §5 注 2） | **无** |
| 3 | `recall.fusion.mode` | 删键（回 `rrf`） | matched 判对 **−2.90pp**、深池锚点 **+2.22pp**（§21.3 判"不设"） | **无** |
| 4 | `recall.presentTemporal` | 删键（代码缺省 `enabled:false`，boost 0.08 / recentDays 30 都不生效） | 无同批配对读数（#135 R3 未定档）⇒ 回滚风险最低，随时可删 | **无** |
| 5 | `recall.smallToBig.maxExtraLines` | `2`（代码缺省）或整段 `enabled:false` | 4→2 判对 **−3.3pp**（84.4%→81.1%）；整段关 = 丢 +14.4pp CI[+6.7,+23.3] p=0.0023 | `gates.smallToBig{mode,maxExtraLines,kept,candidates,evidenceFrom*}` |
| 6 | `recall.candidateK` | 删键（回 `maxResults*3` = **30**，`MemoryCore/src/config.ts:2138/:2140-2143`） | matched 判对 **−6.44pp**（15 对，召回侧唯一显著键）⇒ 只在召回规模失控/延迟超标时回滚 | 无独立门（只看条数/延迟 `perfMs`） |
| 7 | `recall.rerank.mode` | 删键（回 `rerank`） | filter 定档 `filterRule:"quantile"`+`filterKeepRatio:0.5` 报 turnCov 81.1%/81.6%、sessionCov 94.0（§19.3）；回滚后 `mode`/`filterRule` 字段消失即生效 | `gates.rerank{mode,filterRule,filterMarginTop,filterKeepRatio,passCount,kept,dropped,floorToppedUp}` |
| 8（兜底） | 精排整体 | `recall.rerank.enabled:false`（或 bench 侧 `--rerank-off`） | 无门排序即退回融合序；用于精排服务抖动/延迟事故 | `gates.rerank.degraded` 是否翻转 |

联动前提（别单独回滚）：`recall.factChannel.enabled:true` 依赖写侧 `write.factKey.mode:"channel"` + `extraction.facts.enabled:true`；关掉写侧事实键后读侧通道是**空查**（不会报错，但白烧一次检索）——所以回滚 #1 时一并把 `recall.factChannel.enabled` 置 false。

**禁止项（§19.3 定档）**：`recall.rerank.filterRule:"floor"` 且 `minScore > -9` 会全量清零，回滚过程中不要顺手试。

## 3. 演练步骤（S0→S8，单次约 15–25 分钟，含一次 bench）

```bash
# S0 备份 + 确认真源（防"改了没生效"）
cp MemoryCore/tdai-gateway.yaml /tmp/tdai-gateway.yaml.bak-$(date +%s)
git check-ignore -v MemoryCore/tdai-gateway.yaml
echo "TDAI_GATEWAY_CONFIG=${TDAI_GATEWAY_CONFIG:-<unset>}"

# S1 记录现值（八键一次抓全）
grep -nE '^ *(write|recall):|(factKey|supersession|validity|candidateK|fusion|presentTemporal|smallToBig|rerank|factChannel)' \
  MemoryCore/tdai-gateway.yaml
cat "${TDAI_DATA_DIR:-D:/TDB/data}/config-override.json"   # 确认没有 rerank/importancePenalty 覆盖

# S2 改键（示例：回滚首选开关）
#   在 MemoryCore/tdai-gateway.yaml 里把 write.factKey.enabled 改 false，
#   并把 recall.factChannel.enabled 一并改 false（读侧空查前提）

# S3 重启（yaml 无热加载；本地档必须重启承载 gateway 的进程）
#   本机：重启你启动 gateway 的那个进程（端口缺省 8420）
#   docker 档：bash deploy/global-images/stop-all.sh && bash deploy/global-images/start-memory-core.sh
#   注意：走 global-images 时 yaml 是脚本生成的，改 MemoryCore/tdai-gateway.yaml 无效

# S4 生效自证（四者交叉，见 §1.4）
grep -n 'factKey' -A2 MemoryCore/tdai-gateway.yaml
tail -f "${TDAI_DATA_DIR:-D:/TDB/data}/logs/recall/recall-journal-"*.jsonl   # 触发一次召回，看 gates

# S5 跑对照（写侧键改了必须换新库：旧库数据不会因改键而变化）
cd MemoryCore
#   bench 没有"关写侧事实键"的旋钮（--fact-channel-off 只关读侧通道）；
#   写侧靠 yaml 生效值 + --expect-config 断言，再用 --store <新库> 重灌才看得出差异：
GEN_LIMIT=0 bash scripts/run-r135-off-arms.sh one \
  --expect-config 'write.factKey.enabled=false,recall.factChannel.enabled=false'
# 读侧键可在同一库上直接对照（--small-to-big-off / --rerank-off 都是纯读侧）：
GEN_LIMIT=0 bash scripts/run-r135-off-arms.sh one --small-to-big-off
GEN_LIMIT=0 bash scripts/run-r135-off-arms.sh one --rerank-off
```

- **S6 判读阈值（写死，避免每次重新解释）**：n=90 的判对 CI 半宽 6–7pp ⇒ 单次差值 **<3pp 视为未检出**，只以方向 + McNemar 配对 + turnCov/sessionCov 三读共同判定；覆盖率类差异要看 CI 是否跨 0。
- **S7 恢复**：`cp /tmp/tdai-gateway.yaml.bak-<ts> MemoryCore/tdai-gateway.yaml` → 重启 → 复跑 S4（确认八键回到原值）。
- **S8 落账**：在 §6 追加一行；如果这次演练产生了新的读数，同步登记到 `docs/optimization-results.md`（不在本单范围内实施）。

## 4. 陷阱清单（踩过的都在这）

1. **yaml 不入库**（`.gitignore:142`）⇒ 回滚不能 `git checkout`，只能靠 S0 备份。
2. **override 静默覆盖** `recall.rerank.*`：闸门类实验最容易把它算成"回滚无效"。
3. **重启不是热加载**：改完不重启，journal 里看到的还是旧档。
4. **改错文件**：global-images 的 yaml 是 `start-memory-core.sh` **每次启动重生成**的 —— 手改立刻被覆盖；本地开发档与云模板互不影响。
5. **写侧开关不能就地比对**：factKey / supersession 改动不回溯已有库，bench 必须 `--store <新库>` 重建，否则结论是"没差别"。
6. **报告可被同名覆盖（M7）**：必须 `--report-name` 且报告落盘留存，否则事后无法复核。
7. **别把 `--store` 复用库当基线**：臂脚本头注（issue #159）明确要求本档未声明的机制一律显式关，并用 `--expect-config` 断言 —— 否则不同臂隐性继承生产 yaml。
8. **journal 只覆盖一半键**：validity / fusion / candidateK / presentTemporal **没有**观测门，不能声称"journal 可观测"（见 §2 表最后一列）。

## 5. 注

1. 本文所有行号为 **2026-10-31 工作树快照**；并行改动会漂移，引用前先 `grep` 复核。
2. `docs/optimization-results.md` §21.3 台账的 validity 行曾**两处写反**（称云模板 soft、代码缺省 soft），2026-10-31 早间一度订正为 hard——**该订正已被同日晚间 WP1b 推翻**。现行实测：云模板 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:229-233`（`:230`）= `soft`，代码缺省 `MemoryCore/src/config.ts:2234-2253`（`:2252` 非法/缺省分支 `return "soft"`）= `soft`，本地 `MemoryCore/tdai-gateway.yaml:222-223` = `soft` ⇒ **三处一致 soft**。「以代码/原文为准」仍成立，只是结论是 soft 不是 hard；#174 的 hard 语义只在显式写 `mode: hard` 时出现。审计 §0 与 §24.9（`optimization-results.md:2413/:2500`）记录过该矛盾；三套真源见 `docs/ops/config-default-ledger.md` §0，本轮收口记录见 `docs/ops/defaults-drift-closeout.md`。
3. 本单不覆盖"全开档该不该保留"（#168）与"云模板该不该开"（`docs/ops/config-default-ledger.md` / #154）。

## 6. 演练记录（每执行一次追加一行，空表 = 尚未演练）

| 日期 | 演练人 | 关掉的键 | 真源（文件 + 是否 override） | bench 报告名 | 判对 Δ | turnCov Δ | sessionCov Δ | 结论 / 是否回滚成功 |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | 尚未演练 |
