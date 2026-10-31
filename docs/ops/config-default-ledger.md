# 缺省值登记表：已登记 / 待登记（#154）

- 状态：登记完成（2026-10-31 首版）；**2026-11-01 全表行号与缺省值按工作树重核一遍**（收口记录见 `docs/ops/defaults-drift-closeout.md`）。**本表只登记，不重新裁决**——裁决已有出处，见"证据"列。
- 上位依据：`docs/audit/2026-10-31-open-issues-first-principles.md` §4.5 #154 行、M5/M6/M9；`docs/optimization-results.md` §21.3 台账、§19.3、§8
- 配套：回滚动作与演练流程见 `docs/ops/rollback-drill.md`（#149）
- 覆盖范围：`recall.rerank.*`、`recall.candidateK`、`recall.fusion.mode`、`recall.factChannel.enabled`、`recall.presentTemporal`、`recall.validity.mode`、`recall.smallToBig.*`、`write.factKey.*`、`write.supersession.*`；WP1b 追加 `recall.maxResults`、`recall.injectWrapper`、`recall.evidencePack.*`、`recall.graphDiscount`/`sceneBoost`/`coreRefBoost`

## 0. 先说清"谁说了算"：三套真源并存，分别是三件事

| 真源 | 文件 | 什么时候说了算 |
|---|---|---|
| 云模板 | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | tencent-cloud 部署路径（挂进容器的生产契约） |
| env 生成档 | `deploy/global-images/start-memory-core.sh:79` 取 `BASE_CONFIG=deploy/global-images/tdai-gateway.base.yaml`，`:97` **cp 全量渲染**到 `${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}/tdai-gateway.yaml`，`:108-141` 只做单键占位符替换（`render_key`）| 非 tencent 路径的 docker 部署（global-images）。真源 = **`deploy/global-images/tdai-gateway.base.yaml`**（`:73-78` 头注「唯一真源…不渲染新键，也不删键」） |
| 本地开发档 | `MemoryCore/tdai-gateway.yaml`（`.gitignore:142`，不入库） | 本地开发 / 复跑历史实验档 |

**关键事实（决定了"改了云模板不代表线上变了"）**：env 生成档自 2026-10-31 起是 **cp `tdai-gateway.base.yaml` 全量渲染**（脚本不再内联拼 yaml），base 里**本表所有决策键都显式写入** ⇒ 走 global-images 部署时生效值 = **base 值**，不再回落代码缺省。base 与代码缺省**不同的键只有三处**（均为部署侧显式开，不是漂移）：`rerank.enabled: true`（代码 `false`）、`candidateK: 32`（代码 `maxResults*3` = 30）、`smallToBig.enabled/maxExtraLines/budget = true/4/additive`（代码 `false/2/shared`）。其余键 base 与代码缺省同值（钉住 = 防漂移）。云模板是 tencent 路径的覆盖值（决策键与 base 同值）；本地档是实验档（全开）。三方一致性可用 `node deploy/global-images/check-config-consistency.mjs` 复跑。

**优先级**（`MemoryCore/src/gateway/config.ts:495` 原话）：`Admin settings override > yaml > TDAI_LLM_* env(deprecated)`；yaml 加载序见 `resolveConfigPath():839-858`（`TDAI_GATEWAY_CONFIG` → CWD → `<dataDir>` → 纯 env），且**无热加载**。`config-override.json` 只覆盖六段（llm/embedding/rerank/importancePenalty/worthiness/extraction，`settings-override.ts:56-63`）⇒ 只有 `recall.rerank.*` 会被 override 吃掉，其它键不会。

**三条使用纪律（§21.3 台账原文口径）**：
1. **证据栏为空的行不该出现在生产 yaml 里**（没读数就别钉）。
2. 钉子分两类：**增益型**（实测优于缺省才钉，如 `candidateK=32`）与**防漂移型**（值与缺省相同、靠机制证据钉住，如 `rerank.candidates=32`）；防漂移型必须在 yaml 行尾写「防漂移」，否则下一个人会当冗余删掉。
3. 模板与本机档的差异必须**白名单化**（第 2 节即白名单），不能靠谁记得。

## 1. 已登记（已落地，四处对齐）

| 键 | 代码缺省 | 云模板 | 本机 yaml | 证据 | 判决 | 钉子类型 |
|---|---|---|---|---|---|---|
| `recall.rerank.enabled` | `false` | `true`（**:358** `rerank.enabled`，provider local；段首 `:357`） | `true`（:323-324） | 精排是 kept≥4 与 filter 定档前提（§19.3/§21.3） | **留 true** | 增益型（部署侧显式开、代码保守缺省关） |
| `recall.rerank.candidates` | `DEFAULT_RERANK_CANDIDATES=32`（单一口径源 `MemoryCore/src/core/recall/rerank/defaults.ts`；`config.ts:2477` 注释、`:2479` rerank 段 clamp[1,100]） | `32` | `32` | matched 12 vs 32 = 0.00pp，但 kept≥4 由 38/90→80/90 是 84% 档前提 | **留 32**，行尾标「防漂移」 | 防漂移型 |
| `recall.rerank.minScore` | **按 provider 刻度缺省**（local logit −10.5 / 概率刻度 sigmoid(−10.5)≈2.75e-5；单一口径源 `MemoryCore/src/core/recall/rerank/defaults.ts`） | 未钉 | 未钉 | 钉 −10.5 在概率刻度上等于永不过滤（跨 provider 刻度错位） | **不钉**（#145 起撤钉） | — |
| 精排"融合序×精排分"加权比例（`rerank.blend`） | **机制已整体删除** | 无 | 无 | §21.1 深池 α>0 全负；§21.6 浅池 n=90 配对 blend 0 vs 0.9 = −1.15pp CI[−6.90,+4.02]、McNemar −2.22pp p=0.7539 | **删机制**（不是撤钉：代码/bench 旋钮/审计脚本/测试/两份 yaml 全部清零） | — |
| `recall.candidateK` | `maxResults*3`（**=30**，当前 maxResults=10；类型 `config.ts:164-168`、解析 `:2140-2143`） | `32`（:155） | `32`（:147） | matched 判对 **+6.44pp**（15 对），召回侧唯一显著键（§20.3） | **留 32** | 增益型 |

> 两条"32"不是同一回事：`rerank.candidates` = 精排深池大小（防漂移），`candidateK` = 召回候选池上游上限（增益）。改一个不要顺手改另一个。
> blend 是"机制删除"：若有人从旧分支 cherry-pick 回来，它会复活且无读数保护 ⇒ 复活前必须有新证据（§21.6 口径不变）。

## 2. 已定"不进 deploy 模板"（= 明确不加，不是待办）

| 键 | 代码缺省 | 云模板 | 本机 yaml | 证据 | 判决 |
|---|---|---|---|---|---|
| `recall.factChannel.enabled` | `false`（事实通道三开关全关，ADR-0011） | `false`（:163-164，weight 0.6） | `true`（:148-150，weight 0.6） | 判对 −1.1pp（ns）、turnCov **+4.4pp** 显著 ⇒ 覆盖率工具而非准确率增益（§16.7/§21.3） | **不进模板缺省**；本机 true 属 #137 全开实验档 |
| `recall.fusion.mode` | `rrf`（类型注释 `config.ts:170`、解析 `:2145-2158`） | 已显式 `mode: "rrf"`（:174-175） | `normalized` + dense 0.5 / bm25 0.2 / fact 0.3（:151-155） | matched 判对 +2.90pp 但深池锚点 −2.22pp（§21.3） | **不进模板缺省（走 rrf）**；本机 normalized 属实验档 |

**白名单结论（2026-11-01 复查后重写）**：生产两档（云模板 / base）的决策键**已全部同值**（`node deploy/global-images/check-config-consistency.mjs` 实跑 PASS）；本机档与生产档的差异**只剩两条实验轴**——`factKey.enabled`（本机 true / 生产 false）、`factChannel.enabled`（本机 true / 生产 false）——外加 `fusion.mode`（本机 normalized / 生产 rrf）。`supersession` 与 `validity.mode` **已两侧同值**（均 `true` / 均 `soft`，2026-10-31 WP1b 翻转）。这些差异是**有意**的，不是漂移——生产 = 保守生产口径，本机档 = 复跑历史实验的锚点（全开）。要改这个结论必须同时改三处：本表、`docs/optimization-results.md` §21.3、对应 yaml 注释。逐条收口记录见 `docs/ops/defaults-drift-closeout.md`。

## 3. 待登记 / 未决（本表不裁决，列清归属）

> 2026-11-01 复查：第 1/2/3/7/8/9/10 项的缺省与 yaml 均已落地（见各行「现状」列），保留在本节只为留下证据与回滚口径，**不再有待办**；真正未决的只有第 4/5 项（去留归 #168）与第 6 项（三套真源无同步机制）。

| # | 项 | 现状 | 缺什么 | 归属 |
|---|---|---|---|---|
| 1 | `recall.presentTemporal` | **生产两份 yaml 已显式写**（base `:272-275`、cloud `:236-239`，均 `enabled:false` + boost 0.08 + recentDays 30 = 代码缺省，防漂移钉）；本地 yaml 未写（吃代码缺省）。代码解析 `config.ts:2210` 起 | 无配对读数（#135 R3 未定档） | M5 / 审计 §3 Wave 0（**已落地 2026-10-31**）；翻转待新读数 |
| 2 | `recall.rerank.mode` | **生产两份 yaml 已显式** `mode: "rerank"`（base `:416`、cloud `:368`）= 代码缺省（解析 `config.ts:2479` 段） | filter 定档已有读数（§19.3：quantile + keepRatio 0.5 → turnCov 81.1%/81.6%、sessionCov 94.0），但**未定档** | M5 / 审计 §3 Wave 0（**已落地 2026-10-31**）+ #149 回滚对齐；filter 档待 #135 R4 |
| 3 | `recall.validity.mode` | **2026-10-31 WP1b 后三处一致 soft**：代码缺省 `MemoryCore/src/config.ts:2234-2253`（未知值也落 soft + 告警）、云模板 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:229-233`（`:230 mode: "soft"`）、本地 yaml `MemoryCore/tdai-gateway.yaml:222-223`。同日早间曾把云模板与代码缺省记作 hard（`optimization-results.md` §21.3 台账一度如此「订正」），WP1b 落地后该订正作废 | 已落地；回滚 = 三处同改 hard | 依照 `docs/optimization-results.md` §11.2 card-soft turnCov +0.6pp / 判对 +1.1pp ns、nogate-soft 少损 6.5pp ⇒ soft 不劣于 hard，故缺省取 soft |
| 4 | `write.factKey.enabled` 去留 | 本机 true、云模板 false、代码缺省 false；A vs B 判对 −2.2pp（ns）、sessionCov +1.1pp | 生产语料验证 + 事实级粒度 | **#168 裁决**；退路见 #149 演练单（首选回滚开关） |
| 5 | `write.supersession.enabled` 去留 | **三处均 true**（本地 yaml `:82-83`、云模板 `:80`、代码缺省 `MemoryCore/src/core/record/write-policy.ts:101`；2026-10-31 按长会话三臂翻转，判据注释 `write-policy.ts:80-84`）；W2 契约门修掉 140 条误失效（ADR-0010/#136） | 生产语料配对（该读数来自离线机制冒烟，非质量读数） | #168 / 后续票 |
| 6 | 三套真源无同步机制 | 云模板 / env 生成档 / 本地档互不校验 | 启动 dump `effectiveRecallSnapshot`（审计 §3 第 2 条）+ override 命中 recall/write 时 WARN（第 4 条） | **M6/M9**（观测面 #172 承接） |
| 7 | `recall.graphDiscount` / `recall.sceneBoost` / `recall.coreRefBoost` | **WP1b 改代码缺省统一 0**（原 0.6 / 0.04 / 0.05）；解析缺省 `MemoryCore/src/config.ts:2226`（graphDiscount）/ `:2227`（sceneBoost）/ `:2187`（coreRefBoost）；消费点 `MemoryCore/src/core/hooks/auto-recall.ts:1722` / `:1724` / `:1683`；三份 yaml 显式 0（本地 `:187-189`、cloud `:194-196`、base `:217-219`） | — | **0 = 关，不得用 delete 关档**：删键会让 0.6/0.04/0.05 复活（旧缺省，`config.ts:230` 明写）；要重开必须显式非 0 + 新读数 |
| 8 | `recall.maxResults` | 代码缺省 **10**（`MemoryCore/src/config.ts:2138`；依据 `docs/optimization-results.md` §24/§25.6：k=10 判对 +4.5pp、与口径合用 +10.1pp）；**三处已对齐 10**（本地 `:135`、cloud `:140`、base `:159`；2026-10-31 落地，代价 blockChars 3277→5413 仍 <14000） | 线上需重装/重启才吃到新值（**无热加载**） | 代码缺省=生产最优；yaml 钉子与缺省同值 ⇒ 防漂移 |
| 9 | `recall.injectWrapper` | 代码缺省 **calibrated**（`MemoryCore/src/config.ts:2305` → `MemoryCore/src/core/recall/inject-wrapper.ts:20` 的 `INJECT_WRAPPER_DEFAULT`）；生产两档已显式 `calibrated`（base `:293`、cloud `:178`）= 防漂移钉、不是新行为；本地 yaml 未写（吃缺省） | 回滚：yaml 显式 `injectWrapper: legacy`（bench `--inject-wrapper legacy` 同样生效） | #172-② 口径：不诱导拒答、不写「仅作参考」；legacy 保留为显式回滚档 |
| 10 | `recall.evidencePack.*` | 代码缺省 **enabled:false**（`MemoryCore/src/config.ts:2307` 起、`MemoryCore/src/core/recall/evidence-pack.ts`）；生产两档已显式 `false`（base `:282`、cloud `:242`）；键、`gates.evidencePack` 观测（`auto-recall.ts:2176`）、四档脚本 `MemoryCore/scripts/run-r169-evidence-pack.sh` 齐备 | run-r169 四档真实读数（本地/深池配对） | **归口 #169**：缺省关 = 等读数，不是否决；读数出来再翻转 |

## 4. 复查方式（任何人可复跑）

```bash
# 代码缺省：逐键看 config.ts 的 ?? / 三元默认
grep -nE 'factKey|supersession|validity|candidateK|presentTemporal|smallToBig|rerank' MemoryCore/src/config.ts | head -40

# 云模板 vs 本地档四轴
grep -nE 'factKey|supersession|factChannel|validity' \
  deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml MemoryCore/tdai-gateway.yaml

# 是否被 override 静默压过（rerank 段唯一风险点）
cat "${TDAI_DATA_DIR:-D:/TDB/data}/config-override.json"

# bench 侧断言"这一档到底开了什么"（防隐性继承）
cd MemoryCore && GEN_LIMIT=0 bash scripts/run-r135-off-arms.sh one --expect-config
```

## 5. 注

1. 行号为 **2026-10-31 快照 / 2026-11-01 复查修订**，代码会漂移；结论（留 / 不设 / 删）以本表与 `docs/optimization-results.md` §21.3 为准，行号只作定位线索。复查方法论（每条断言必须 grep 到 path:line）见 `docs/ops/defaults-drift-closeout.md`。
2. n=90 的判对 CI 半宽 6–7pp：本表所有 ≤3pp 的差异按"未检出/方向性"处理，不得据此新增钉子。
3. 本表**不新增**任何键值——#154 明确"只登记不重新裁决"，要改缺省另开票。
