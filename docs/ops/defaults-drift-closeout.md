# 缺省值漂移收口（production-profile.md §8 六条 + 全仓复查）（2026-11-01）

- 上位：`docs/ops/production-profile.md` §8（登记 6 条**别人文件**的旧缺省值/旧行号漂移）、`docs/audit/2026-10-31-open-issues-first-principles.md` §4.5 #154、#172 观测面
- 目的：用户红线是「无未完成/半完成项、可直接上生产」；文档写着旧缺省值会让运维**按错的档位排障**——与代码 bug 同级。本报告是这 6 条的收口记录。
- 纪律：**只改文档与 YAML 注释行，未改任何代码或 YAML 的值**（值已于 2026-10-31 WP1b 定档）；未动 `docs/audit/`、`MemoryCore/src/`、`deploy/` 云模板、`.eval-data` 历史报告。
- 方法：每条断言都 grep 到 path:line；下表行号为 **2026-11-01 工作树快照**（代码会漂移，结论以行内容为准，行号只作定位）。
- 复跑：`node deploy/global-images/check-config-consistency.mjs`（三方一致性）+ `cd MemoryCore && npm run typecheck:gate`（Δ=+0）。

## 1. 收口清单（旧说法 → 新说法 → 依据）

| 位置（新行号） | 旧说法（已改） | 新说法（现行） | 依据（代码/文档 path:line） |
|---|---|---|---|
| docs/ops/config-default-ledger.md:13 | env 生成档「`:60-105` 每次启动**重写**」+「只写 deployMode/… 不含本表任何一键」 | cp `base.yaml` 全量渲染（`:79` BASE_CONFIG、`:97` cp、`:108-141` 仅单键占位符替换）；真源 = `tdai-gateway.base.yaml` | `deploy/global-images/start-memory-core.sh:73-78/:79/:97/:108-141` |
| docs/ops/config-default-ledger.md:16 | 「生产缺省 = 代码缺省」（global-images 路径） | 生产值 = base 值；base ≠ 代码缺省只有 rerank.enabled / candidateK / smallToBig 三处；三方一致性可脚本复跑 | `deploy/global-images/tdai-gateway.base.yaml:404/:411/:174/:340/:349`；`MemoryCore/src/config.ts:2479/:2140-2143/:2419` |
| docs/ops/config-default-ledger.md:18 | `resolveConfigPath():841-857`、`settings-override.ts:55-61` | `:839-857`、`:56-63` | `MemoryCore/src/gateway/config.ts:839`、`MemoryCore/src/gateway/settings-override.ts:56` |
| docs/ops/config-default-ledger.md:29 | rerank.enabled 云模板列 `:321-322` | cloud `:357`（`rerank:`）/`:358`（`enabled: true`） | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:357-358` |
| docs/ops/config-default-ledger.md:30 | 「代码缺省常量（`config.ts:2412` 附近 clamp）」 | `DEFAULT_RERANK_CANDIDATES=32`（`core/recall/rerank/defaults.ts`）+ clamp 注释 `config.ts:2477`、段 `:2479` | `MemoryCore/src/core/recall/rerank/defaults.ts`、`MemoryCore/src/config.ts:2477/:2479` |
| docs/ops/config-default-ledger.md:31 | minScore「`config.ts:2420-2421` 注释」 | 单一口径源 `core/recall/rerank/defaults.ts`（local logit −10.5 / 概率刻度 sigmoid(−10.5)≈2.75e-5） | `MemoryCore/src/core/recall/rerank/defaults.ts` |
| docs/ops/config-default-ledger.md:33 | candidateK「`maxResults*3`（=15，`config.ts:148-152/:2083-2086`）」、云模板 `:145` | `maxResults*3`（**=30**，当前 maxResults=10）；类型 `:164-168`、解析 `:2140-2143`；cloud `:155` | `MemoryCore/src/config.ts:164-168/:2138/:2140-2143`、cloud `:155` |
| docs/ops/config-default-ledger.md:42 | factChannel 云模板列 `:153-154` | `cloud :163-164` | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml:163-164` |
| docs/ops/config-default-ledger.md:43 | fusion「`config.ts:161` 类型注释」+「未设 ⇒ rrf」 | 类型 `config.ts:170`、解析 `:2145-2158`；cloud 已显式 `:174-175` | `MemoryCore/src/config.ts:170/:2145-2158`、cloud `:174-175` |
| docs/ops/config-default-ledger.md:45 | 「四轴相反（factKey / supersession / factChannel / validity）」 | 差异只剩三条实验轴 factKey / factChannel / fusion；supersession、validity 已两侧同值 | cloud `:80/:229-233/:163-164/:174-175`；本地 `:73/:83/:222-223/:151-155` |
| docs/ops/config-default-ledger.md:53 | presentTemporal「两份 yaml 都没写（grep 0 命中）」 | base `:272-275`、cloud `:236-239` 均显式 false；本地未写（吃缺省） | base `:272-275`、cloud `:236-239`、`MemoryCore/src/config.ts:2210` |
| docs/ops/config-default-ledger.md:54 | rerank.mode「两份 yaml 都没写 ⇒ 依赖代码缺省」 | base `:416`、cloud `:368` 均显式 `mode: "rerank"` | base `:416`、cloud `:368`、`MemoryCore/src/config.ts:2479` |
| docs/ops/config-default-ledger.md:55 | 「云模板仍 hard（cloud:210-211）…当前有意保留 hard」、代码缺省 hard（`:2241`） | 三处一致 soft：cloud `:229-233`、`config.ts:2234-2253`、本地 `:222-223` | cloud `:230`、`MemoryCore/src/config.ts:2234-2253`、本地 `:223` |
| docs/ops/config-default-ledger.md:57 | supersession「本机 true、云模板 false、代码缺省 false」 | 三处均 true：本地 `:82-83`、cloud `:80`、`write-policy.ts:101` | `MemoryCore/src/core/record/write-policy.ts:101`、cloud `:80` |
| docs/ops/config-default-ledger.md:59 | boosts「消费点 `auto-recall.ts:1689` / `:1727-1729`」、yaml「本地 :186-189、cloud :176-179」 | 消费点 `:1683`/`:1722`/`:1724`；三份 yaml：本地 `:187-189`、cloud `:194-196`、base `:217-219` | `MemoryCore/src/core/hooks/auto-recall.ts:1683/:1722/:1724`、`MemoryCore/src/config.ts:2187/:2226/:2227` |
| docs/ops/config-default-ledger.md:60 | maxResults「两份 yaml 仍显式钉 5（本地 :135、cloud :130）」+「线上仍是 5」 | 三处均 10（base `:159`、cloud `:140`、本地 `:135`）；线上需重启（**无热加载**） | `MemoryCore/src/config.ts:2138`、base `:159`、cloud `:140` |
| docs/ops/config-default-ledger.md:?? | injectWrapper「`config.ts:2291`…两份 yaml 均未钉」 | `config.ts:2305` → `inject-wrapper.ts:20`；base `:293`、cloud `:178` 显式 calibrated | `MemoryCore/src/config.ts:2305`、`MemoryCore/src/core/recall/inject-wrapper.ts:20` |
| docs/ops/config-default-ledger.md:?? | evidencePack「`config.ts:2293` 起」 | `config.ts:2307` 起；base `:282`、cloud `:242` 显式 false；观测 `auto-recall.ts:2176` | `MemoryCore/src/config.ts:2307`、`MemoryCore/src/core/hooks/auto-recall.ts:2176` |
| docs/ops/config-default-ledger.md:3 | 状态行「登记完成（2026-10-31 首版）」 | 加「2026-11-01 全表重核」并指向本报告 | — |
| docs/ops/config-default-ledger.md:49 | §3 无落地状态说明 | §3 增注：第 1/2/3/7/8/9/10 项已落地、不再有待办；真正未决只剩 4/5（归 #168）与 6（三套真源无同步机制） | — |
| MemoryCore/tdai-gateway.yaml:220 | 行注「缺省 hard（零行为变化）」 | 「代码缺省已 soft（WP1b 2026-10-31，`config.ts:2234-2253`）；本档显式 soft = 防漂移钉，不是实验档」 | `MemoryCore/src/config.ts:2236-2240` |
| docs/long-session-bench.md:25 | A 臂「现状缺省（`write-policy.ts:77` 三个开关全关）」 | A 臂 = 显式关 supersession，**不等于现缺省**（缺省 supersession 开 `:101`；factKey/factRows 仍关 `:92-99`/`:102`） | `MemoryCore/src/core/record/write-policy.ts:91-103` |
| docs/optimization-results.md:48 | 「生产口径 = **代码缺省**；落盘…两个防漂移钉子，其余吃缺省」 | 生产口径 = 两档 yaml 显式值，未写才吃缺省；钉子 = candidates 32（防漂移）/ candidateK 32（增益，≠缺省 30） | `MemoryCore/src/config.ts:2138/:2140-2143` |
| docs/optimization-results.md:140 | W2 行「→ 默认关」 | 当时结论默认关；2026-10-31 WP1b 翻为缺省 true | `MemoryCore/src/core/record/write-policy.ts:80-84/:101` |
| docs/optimization-results.md:258 | W2 结论「→ 默认关（--write-supersede + --b2b-validity）」 | 当时结论默认关；WP1b 按三臂翻 true + 配套 validity soft | `docs/long-session-bench.md` §6、`MemoryCore/src/core/record/write-policy.ts:101` |
| docs/optimization-results.md:407 | 「cardinalityGate=true（supersession 本身仍缺省关）」 | supersession 自身缺省已 true（WP1b） | `MemoryCore/src/core/record/write-policy.ts:101` |
| docs/optimization-results.md:408 | 「`recall.validity.mode="hard"`（逐位现状）」 | 当时缺省 hard；WP1b 改缺省 soft | `MemoryCore/src/config.ts:2234-2253` |
| docs/optimization-results.md:468 | 「已加注释与缺省值（均缺省关/硬）」 | 当时 supersession 关 / validity 硬；WP1b 后 supersession true / validity soft，两档 yaml 显式同值 | `MemoryCore/src/core/record/write-policy.ts:101`、`MemoryCore/src/config.ts:2234-2253` |
| docs/optimization-results.md:1758 | §21.3 candidateK 代码缺省列 `maxResults×3` | `maxResults×3`（当前 = **30**） | `MemoryCore/src/config.ts:2138/:2140-2143` |
| docs/optimization-results.md:1759 | §21.3 fusion 云模板列「未设(rrf)」 | 云模板已显式 `mode: "rrf"` | cloud `:174-175` |
| docs/optimization-results.md:1761 | §21.3 validity 行「云模板 hard / 本地 soft / 代码缺省 hard」+ 同日「订正为 hard」 | 三列全 soft；旧订正作废（WP1b 当晚又翻 soft） | cloud `:229-233`、`MemoryCore/src/config.ts:2234-2253`、本地 `:222-223` |
| docs/optimization-results.md:1762 | §21.3 smallToBig 行「同 | 同 | 同」 | 生产 additive×4（cloud `:294`/`:303`）；代码缺省 false/2/shared ⇒ 部署侧显式开 | `MemoryCore/src/config.ts:2419` 段 |
| docs/optimization-results.md:2346 | §25.x「config.ts:2066 缺省 5」 | `config.ts:2138` 现缺省 10（WP1b） | `MemoryCore/src/config.ts:2138` |
| docs/ops/production-profile.md:171 | §8「已知漂移（不在本票改动范围）」表（6 条待办） | §8 改为收口记录：6 条标「已收口（2026-11-01）」+ 指向本报告 + 列出 scope 外仍 3 处 | 本报告 |

## 2. 顺带核对的文件

- `docs/benchmarks.md`：grep `缺省|默认|default` **零命中**，无漂移，未改。
- 其余 `docs/research/`、`docs/superpowers/plans/` 里的「缺省」多是**当时的计划/研究快照**（属于历史记录，与现行档位无关），不在本票范围，未改。

## 3. scope 外残留（**已于 2026-11-01 由 task-27 全部收口**）

> 本节原登记 5 条「仍待派」；Lead 已派 task-27 并全部落地。逐条给收口后的说辞与依据行号（行号为 2026-11-01 工作树快照）。

| # | 位置（收口后行号） | 原残留说法 | 收口后说法 | 依据（path:line） |
|---|---|---|---|---|
| 1 | `docs/ops/rollback-drill.md:39`（表格第 2 行） | 「env 生成档只生成 deployMode/… 不含决策键 ⇒ 这些键全走**代码缺省**（全关 / validity hard / rerank.enabled false）」 | 生成档 = `cp tdai-gateway.base.yaml` **全量渲染**（BASE_CONFIG `:79`、cp `:97`、单键占位符替换 `:108-141`），决策键**继承 base 显式值**：validity soft、maxResults 10、supersession true、rerank.enabled true、candidates 32、smallToBig additive×4 | `deploy/global-images/start-memory-core.sh:73-141`；base `:255-257`/`:159`/`:100-101`/`:403-404`/`:411`/`:340`+`:349` |
| 1b | `docs/ops/rollback-drill.md:38`（表格第 1 行） | 云模板「factKey false、supersession **false**、factChannel false、validity **hard**」 | 同一张表里同行同样过时，一并改：supersession true、validity soft（另补键所在行号） | cloud `:66-68`/`:80-81`/`:163-164`/`:229-233` |
| 1c | `docs/ops/rollback-drill.md:73`（§2 表头注） | 「全部键都可以『回代码缺省』完成回滚：ADR-0011/ADR-0010 缺省都是**全关**」 | 改写为两分类：factKey/factChannel 仍缺省关 ⇒ 删段/写 false；supersession（缺省 true）与 validity（缺省 soft）两轴**回滚 = 显式写回旧档**，删键只会回到新缺省 | `MemoryCore/src/core/record/write-policy.ts:101`、`MemoryCore/src/config.ts:2234-2253` |
| 1d | `docs/ops/rollback-drill.md:82`（§2 表第 6 行） | candidateK 回滚值「删键（回 `maxResults*3`=**15**）」 | 删键回到 `maxResults*3` = **30**（maxResults 已 10） | `MemoryCore/src/config.ts:2138`/`:2140-2143` |
| 1e | `docs/ops/rollback-drill.md:25`/`:52`（生效链引用） | `resolveConfigPath():841-857`；`settings-override.ts:55-61 / :65 / :67-77` | `:839-858`；`:56-63`（接口）/ `:65`（文件名）/ `:68-76`（读取+损坏回落） | `MemoryCore/src/gateway/config.ts:839-858`、`MemoryCore/src/gateway/settings-override.ts:56-76` |
| 2 | `docs/ops/rollback-drill.md:78`（§2 表第 2 行） | validity 回滚值「`hard`（= 代码缺省）」 | 「显式写 `hard`（代码缺省已 soft，`config.ts:2234-2253`；回显 hard 会走 #174 的 hard 语义）」 | `MemoryCore/src/config.ts:2252` = `return "soft"` |
| 3 | `docs/ops/rollback-drill.md:145`（§5 注 2） | 「2026-10-31 已订正为 hard…三列里只有本地是 soft」 | 「该订正已被同日晚间 WP1b 推翻；现行三处一致 soft」，并补 cloud/local/config.ts 三处行号 | cloud `:229-233`、`MemoryCore/src/config.ts:2234-2253`、本地 `MemoryCore/tdai-gateway.yaml:222-223` |
| 4 | `docs/adr/0010-双时态属性契约与软失效.md:35`/`:57`（正文） | validity 缺省 hard、supersession 缺省关 | **正文一字未改**（决策历史不追溯篡改）；仅在 H1 下加一行指引 `> 现行档位与缺省值以 production-profile.md 为准；本文记录的是当初的决策与理由，不追溯改写。` | `docs/adr/0010-双时态属性契约与软失效.md:3` |
| 5 | `MemoryCore/src/config.ts:160`（`maxResults` 类型注释） | 「两份 yaml 仍显式钉 5（部署侧覆盖…）」 | 「三处均为 10（base `:159` / cloud `:140` / 本地 `:135`，2026-10-31 定档；三处已与代码缺省对齐）」 | `MemoryCore/src/config.ts:157-163`；base `:159`、cloud `:140`、本地 `:135` |

**收口后的验证**（2026-11-01）：`cd MemoryCore && npm run typecheck:gate` → 243/44 vs 基线 243/44，Δ=+0 PASS（改注释不影响读数）；本报告 + 上述 5 文件的 path:line 自检：行号超文件行数 **0**。

## 4. 与票面 / 既有文档的出入（交 Lead 裁）

- 票面提到「`docs/benchmarks.md` 也要核」：该文件**没有**缺省断言（零命中），实际漂移集中在 `config-default-ledger.md`、`optimization-results.md`、`long-session-bench.md`、本地 yaml 行注——已全部处理。
- 票面 §8 第 4 条写「脚本已改为 cp base.yaml 全量渲染（`start-memory-core.sh:74-97`）」：实测为 `BASE_CONFIG` 定义在 `:79`、`cp` 在 `:97`、占位符替换 `:108-141`、真源说明头注 `:73-78`。
- 6 条之外，`optimization-results.md` §21.3 台账还有 3 行同类漂移（candidateK 缺省现值、fusion 云模板「未设」、smallToBig「同/同/同」），一并改掉——它们是同一套缺省断言的另一份副本，留着会再次误导。
