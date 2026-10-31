# 生产配置画像（production profile）

- 状态：**2026-11-01 首版**。本文件描述「线上实际生效的召回 / 写入 / 答案 / 门禁口径」，并给每一键标出**代码解析点、生产档位置、证据等级、归口票、回滚动作**。
- 行号口径：**2026-11-01 工作树快照**。代码会漂移，结论以本文件 + `docs/ops/config-default-ledger.md`（#154 逐键台账）+ `docs/optimization-results.md` §21.3 为准，行号只作定位线索。
- 上位依据：`docs/audit/2026-10-31-open-issues-first-principles.md` §4.4/§4.5；**回滚动作与演练流程**见 `docs/ops/rollback-drill.md`（#149）。
- 分工（避免两份台账打架）：`config-default-ledger.md` 回答「这个键留还是不留、凭什么读数」；**本文件回答「生产上现在是什么值、谁改的、怎么回滚、出了事看哪」**。两者任一改动都要同步另一份的对应行。

---

## §0 三套真源与生效链（先分清谁说了算）

| 真源 | 文件 | 谁在什么时候读它 |
|---|---|---|
| global-images 生产档 | `deploy/global-images/tdai-gateway.base.yaml` | `deploy/global-images/start-memory-core.sh` **cp 全量渲染**（`:74`「唯一真源 = 本目录 tdai-gateway.base.yaml」、`:79` `BASE_CONFIG=...`、`:97` `cp "$BASE_CONFIG" "$CORE_CONFIG_FILE"`、`:108-141` 只做单键占位符替换） |
| 腾讯云生产档 | `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` | 云上 systemd 部署，拷到 `MemoryCore/tdai-gateway.yaml`（文件头 `:1-6`） |
| 本地开发档 | `MemoryCore/tdai-gateway.yaml` | 本地跑 bench / 复跑历史实验（`.gitignore` 忽略，不入库） |

**关键事实一（2026-10-31 已变）**：脚本**不再内联 heredoc 拼 yaml**，改为 cp base 档 ⇒ 「脚本没写的键就静默取代码缺省」这条历史病根（#145/#173）在 global-images 路径上已被切断，**决策键全部写在 base 里**（脚本 `:74-78` 的说明就是为此写的）。因此本文件 §1–§3 的生产值以 base 档为第一依据。

**关键事实二（优先级）**：`Admin settings override({baseDir}/config-override.json) > yaml > TDAI_LLM_* env(deprecated)`（`MemoryCore/src/gateway/config.ts:495`）；yaml 加载序 `TDAI_GATEWAY_CONFIG` → CWD → `<dataDir>` → 纯 env（`MemoryCore/src/gateway/config.ts:392-401`、`:839-858`），**无热加载**。
override 只覆盖六段：llm / embedding / rerank / importancePenalty / worthiness / extraction（`MemoryCore/src/gateway/settings-override.ts:56` 起的 `SettingsOverride` 接口（六段字段 `:57-63`））⇒ **只有 `recall.rerank.*` 会被 override 静默压过**，其余键不会。

**关键事实三（三方同改纪律）**：改任一决策键 = 本文件 + base 档 + 云模板（+ 代码缺省若同步翻）四处一致；base 文件头 `:10-14` 已把这条写成硬约定，一致性可用 `node deploy/global-images/check-config-consistency.mjs` 核（2026-11-01 实跑 PASS：白名单外键集合与值完全一致、9 个防漂移钉两套 yaml 均等于代码缺省）。

---

## §1 召回口径（读侧）

| 键 | 生产值 | 代码解析点 | 生产档位置 | 证据 / 归口 |
|---|---|---|---|---|
| `recall.maxResults` | **10** | `MemoryCore/src/config.ts:2138` `num(...) ?? 10` | base `:159`、cloud `:140`、本地 `:135` | #135/#172-③：LME90 六臂 k=10 = **60/90** vs k=5 = **56/90**（`docs/optimization-results.md` §24.2 `:2247-2254`、§24.3 `:2266+ `「最大单因子」）；组合 X（k=10+币值+建议）= **66/90 = 73.3%**，McNemar p=0.0129。代价：blockChars 3277→5413（`§24.3 :2287`）、top-5 内排序变差 |
| `recall.candidateK` | **32** | `MemoryCore/src/config.ts:168` 类型、`:2140-2144` 解析（缺省 undefined ⇒ `maxResults*3`） | base `:174`、cloud `:155`、本地 `:147` | #141 匹配设计 15 对：**+6.44pp**（§20.3、ledger §1） |
| `recall.rerank.enabled` | **true** | 代码缺省 false（解析见 `config.ts` rerank 段） | base `:404`、cloud `:357+` | 深池 32/−10.5 = **84.3%** vs 关精排 79.5% vs 12/−2 = 67.1%（§10 修正、§19.9） |
| `recall.rerank.candidates` | **32**（防漂移） | `config.ts` rerank 段 clamp | base `:411`、cloud `:365`、本地 `:330` | 防漂移型：kept≥4 由 38/90→80/90 是 84% 档前提；缺省同为 32 |
| `recall.rerank.mode` | **rerank** | `config.ts` rerank 段（缺省 rerank） | base `:416`、cloud `:368` | #135 R4/#144；filter 档有 §19.3 读数（quantile+keepRatio 0.5 → turnCov 81.1%/81.6%）但**未定档** |
| `recall.rerank.minScore` | **不钉** | 按 provider 刻度取缺省（local logit −10.5） | 三处都故意不写 | 钉死 −10.5 在概率刻度 provider 上等于永不过滤 ⇒ 换 provider 即失效（#145 撤钉） |
| `recall.validity.mode` | **soft** | `config.ts:2234-2253`（未知值也落 soft + 告警） | base `:257`、cloud `:230`、本地 `:222` | #136 §11.2（`:418-426`）：card-soft turnCov **+0.6pp** / 判对 +1.1pp(ns)；nogate-soft overall cov **−10.6pp→−4.1pp**、temporal **−13.3pp→0.0pp** |
| `recall.validity.softPenalty` | **0.5** | `config.ts:2257` clamp[0,1] | base `:261`、cloud `:231` | 显式钉 = 让审计一眼看到刻度，不是新调值 |
| `recall.validity.hardOnPresentIntent` | **true** | `config.ts:2258` | base `:266`、cloud `:233` | #148：「问当下 + 池里有取代行」是否硬丢；缺省 true = #136 口径 |
| `recall.injectWrapper` | **calibrated** | `config.ts:2305` → `MemoryCore/src/core/recall/inject-wrapper.ts:20` `INJECT_WRAPPER_DEFAULT = "calibrated"` | base `:293`、cloud `:178` | #172-②：legacy 文案含「仅作为参考」`inject-wrapper.ts:24`、neutral 诱导保守；深池 A 臂 36 个错题里 **27 个（75%）是拒答**（`docs/optimization-results.md` §24.4 `:2293`、`answer-guidance.ts:1-25` 头注）。回滚 = yaml 显式 `injectWrapper: legacy`（`inject-wrapper.ts:18`） |
| `recall.evidencePack.enabled` | **false** | `config.ts:2307-2319`（`?? false`；maxExtraLines clamp[0,24] 缺省 6） | base `:282`、cloud `:242` | **#169 pending**：四档脚本 `MemoryCore/scripts/run-r169-evidence-pack.sh` 读数出来再翻转；键/观测/脚本齐备 ≠ 半成品（`core/recall/evidence-pack.ts:2`、gates 恒现 `auto-recall.ts:2176`） |
| `recall.presentTemporal.enabled` | **false** | `config.ts` presentTemporal 段（boost 0.08 / recentDays 30 可调） | base `:272-275`、cloud `:236-239` | §16：+0.37pp **n.s.** ⇒ 不翻转；显式落盘 = 防缺省未来翻转 |
| `recall.coreRefBoost` / `graphDiscount` / `sceneBoost` | **0 / 0 / 0** | `config.ts:2184-2187`、`:2226`、`:2227`（缺省 0；消费点 `core/hooks/auto-recall.ts:1683`、`:1722`、`:1724`） | base `:217-219`、cloud `:194-196`、本地 `:187-189` | WP1b #173-B：关断 **有害** ⇒ 0 = 关。**禁止用 delete 关档**（`config.ts:230` 明写：删键会让历史缺省 0.05/0.6/0.04 复活并反向打开通道）；要重开必须显式非 0 + 新读数 |
| `recall.smallToBig.*` | base/cloud 显式 `budget: additive`；代码缺省 `enabled:false` / `maxExtraLines:2` / `budget:"shared"` | `config.ts:2419+` | base `:336` 起（`maxExtraLines: 4` 在 `:340`、`budget: additive` 在 `:349`）、cloud `:294/:303` | #138 定档：add×4 判对 84.4% 不降、经验层 ≤1 行 36.7%→1.1% |
| `recall.fusion.mode` | base/cloud **rrf**（本地档 normalized 属实验） | `config.ts:164-168` 类型注释 | base `:196`、cloud `:174-175` | §17.9：normalized 深池 **−2.22pp**（`docs/optimization-results.md:1190`）⇒ 维持 rrf |
| `recall.factChannel.enabled` | base **false**（带前置未满足标记）、本地 true | `config.ts` factChannel 段 | base `:182-183`、cloud `:163`、本地 `:148-150`（`enabled: true`） | #137：判对 −1.1pp(ns)、turnCov +4.4pp ⇒ 覆盖率工具；开前置 = `write.factKey.mode="channel"` + `extraction.facts.enabled=true`，否则空查（base `:183`） |
| `lifecycle.enabled` / `consolidation.enabled` | **true / true** | `config.ts:1842`、`:1865`（`?? true`） | base/cloud 显式 true | 结论层（R7）供给依赖项；本批**不动**，回滚 = 显式 false |

**读召回口径时最容易踩的两条**：
1. `coreRefBoost/graphDiscount/sceneBoost` 写 `0`，不要删行（见上表最后一行）。
2. `recall.rerank.*` 可能被 `config-override.json` 覆盖（六段之一），排查「yaml 明明写了却不生效」先看 override（§0 关键事实二）。

---

## §2 写入口径

| 键 | 生产值 | 代码解析点 | 生产档位置 | 证据 / 归口 |
|---|---|---|---|---|
| `write.supersession.enabled` | **true** | `MemoryCore/src/config.ts:2089-2101`；`MemoryCore/src/core/record/write-policy.ts:101` `supersession: { enabled: true }` | base `:100`、cloud `:80`、本地 `:82` | #153 长会话三臂（`docs/long-session-bench.md` §6 `:104-113`）：B 开 = 旧值注入 **0%** / 当前命中 **100%** / 重复值 **1.0**；A 关 = **33.3%** / 100% / **7.67**。误删护栏 = `cardinalityGate true` + `cardinalityDefault single`（只对单值谓词失效）。残留风险：LME90 turnCov **−10.9pp**（该语料无失效语义） |
| `write.factKey.enabled` | **false** | `config.ts:2067-2087`（`?? false`，`:2075`）；`write-policy.ts:92-99` | base `:86-97`、cloud `:66-78`、本地 `:72-79` | #149：LME90 A vs B 判对 **−2.2pp**（ns）、cov −4.6pp；`#147` 全开档键替换无净收益。开启前置：`l1_fact_vec` 能力位（tcvdb 不支持 ⇒ 空查） |
| `write.factRows.enabled` | **false** | `config.ts:2105+`；`write-policy.ts:102` | 未在 yaml 显式（走代码缺省） | #146：事实行粒度无正收益 ⇒ 显式关（不开半成品） |
| `extraction.sessionScope` | **session** | `config.ts:52-65`（`ExtractionConfig` 必填字段）、`config.ts:2122` 附近 loader（`=== "profile" ? "profile" : "session"`，非法值/大小写一律回落）；消费点 `utils/pipeline-factory.ts:671-672`，守卫 `:683`，游标天花板 `:682/:693`、`:942-943` | `MemoryCore/tdai-gateway.yaml:110-114`（显式 `sessionScope: session` + 三行注释） | task-81 / 用户口径 m02362「检索可以跨会话拉，抽取的时候不能混」：`session` = 一批出现多 `session_id` 时只抽最靠前会话、其余整组延后且游标只推进到被延后行之前（零丢行，dedup 兜底）；`profile` = 旧多会话同批，仅灰度/排查，**不建议长开**。单会话行为逐位不变。文档见 [extraction-session-isolation.md](extraction-session-isolation.md) |

**同档纪律**：生产实际生效的是 `config.ts` 的 `write.*` 缺省（`utils/pipeline-factory.ts` 传 `cfg.write`），`write-policy.ts` 的 `DEFAULT_WRITE_POLICY` 必须与之同档，由 `config.write.test.ts` 钉死（`write-policy.ts:88-89` 头注原文）。
**配套对**：supersession 开 + validity soft 是**同一套读写的两半**——库里产生 expired 行，读侧才需要「降权保留」；若把 supersession 回滚成 false，soft 档退化为与 hard 逐位等价（无害），这条已写进 base `:252-254`。

### 2.1 写面幂等边界（2026-11-01 核对工作树）

> 行号为 2026-10-31 实测。`MemoryCore/src` 仍在并行修改，行号漂移时按括号里的符号名 grep；`dsh-plugin/` 整个目录 untracked 且持续被改，**一律按符号引用**（文件名 + 常量名/函数名），本表不写它的行号。

| 写面 | 幂等键 | 窗口 / 容量 | 落地位置 | 全重复时的返回 |
|---|---|---|---|---|
| L0 `/v3/conversation/add` | `(session_id, role, content)` 逐字 | 10 分钟（窗口字面量 `600000` 硬编码在调用点）；不设容量上限，查库不查环 | 调用 `MemoryCore/src/gateway/v2-router.ts:874-904`（`hasRecentL0Duplicate` 判定 `:879-891`、批内同文本去重 `:894-902`）；实现 `MemoryCore/src/core/store/sqlite.ts:5586-5604`（`hasRecentL0Duplicate`，只读 SELECT；store 处于 degraded / 查询异常 / 窗口非法时一律返回 false = 照收） | `accepted_ids: []`、`accepted_versions: []`、`total_count: 0`（`:987` 取 `acceptedIds.length`）；跳过以 journal info 留痕（`:923-927`），**响应契约不变**。store 无该方法时不做去重、逐条照收（`:879` feature-detect） |
| L2 skill `/v3/skill/conversation/add` | 普通消息 `(role, content)`；tool pair `(role, tool_call_id)`；sha256 前 32 hex | 10 分钟 / 200 条（均可配，`0` = 关） | `MemoryCore/src/core/skill/conversation-add/dedupe.ts`（`DEFAULT_DEDUPE_WINDOW_MS` `:30`、`DEFAULT_DEDUPE_MAX_ENTRIES` `:32`、`messageFingerprint` `:69-79`、`dedupeMessages` `:88-127`）；接线 `add-handler.ts:195-202`；环持久化在 `SessionMeta.recent_fingerprints`（`buffer-storage.ts:62`） | `status: "ok"` + `duplicate_skipped: N`（`add-handler.ts:216-227`）。**不新增枚举**——`MemoryProxy/src/skill/core-client.ts:150-153` 只声明 `ok \| archived` |

五条「动手排查前必须先知道的边界」：

1. **L0 的计数仍按请求体推进，幂等 ≠ 零副作用。** 去重只拦「多写行」，不拦管线计数：`rounds = messages.filter(m => m.role === "user").length`（`v2-router.ts:933`）用的是**请求体**而不是 `acceptedRecords`（`:929-942`）⇒ 同一轮重复提交 5 次，「不会多 5 行，但会给 pipeline 记 5 个 round」。准确表述只有一句：**幂等 = 不多写行 + 不重复触发归档**。
2. **跨写者内容不逐字一致时，内容级幂等完全无效。** 原文就在 `dedupe.ts:20-22`：两个写者的同一回合内容通常并不逐字相同（MemoryProxy 的 user 文本带 `<acp …>` 等上下文标记，插件抓的是原文）⇒ 幂等只能拦住「同一写者的重试/重放」和「内容偶然一致」，**替代不了运维层的排他**。同一身份只许有一条写链：`writeback.enabled=false`（整体不写）或 `writeback.skillFeed=false`（只关 L2，L0 仍由插件写）；后者仅适用于「L0 插件写、L2 由 proxy 喂」的割裂场景，不推荐常态使用。两者都能用 `deploy.sh --config-extra` 写进 patch 层（做法见 [dsh-plugin-install-runbook.md](dsh-plugin-install-runbook.md) §3.2）。
3. **指纹环有上限，超窗口的历史重放仍能进来。** 环 = 最近 200 条 + 10 分钟，比对集合是「环 ∪ 本轮 buffer」（`dedupe.ts:104-110`）⇒ 短时间大批量写入会把更早的指纹挤出环，实际重放保护窗口 = `min(10 分钟, 200 条)`。环**跨归档保留**（归档只清 buffer 不清 meta，`dedupe.ts:16-17`；写回统一走 `updateMeta` 读改写 `buffer-storage.ts:230-243`，force-archive 也保环 `skill-handlers.ts:1093-1107`，注释 `:1093-1097` 记着「task-26 的 recent_fingerprints 就是这样在 force-archive 路径上被清空的」），所以「首次 POST 成功但响应丢失 → outbox 退避重试」落在归档之后也照样能被拦。
4. **L0 分片是部分成功语义。** 单请求 >100 条按 `CORE_MAX_MESSAGES_PER_REQUEST` 分片顺序发（`dsh-plugin/src/wire-limits.ts` 的 `chunkMessages`，常量 `CORE_MAX_MESSAGE_CHARS=8192` / `CORE_MAX_MESSAGES_PER_REQUEST=100` / `CORE_MAX_SKILL_MESSAGES_PER_REQUEST=500`）；第 i 片失败即整条返回 `ok:false`，死信 reason 前缀 `chunk i/n:` ⇒ 前 i-1 片**已经落库**，库里留下半个回合的行。重放整条是安全的（L0 入口幂等，`memory-client.ts` 的 `addConversationResult` 注释原文：*a failed chunk after an accepted one replays on retry; that is safe because this write face is idempotent server-side (unlike the skill buffer)*）。skill 侧相反：分片 500，且**只有「请求未到达 core」才允许重试**——L2 buffer 除入口指纹环外没有去重，重放会把回合重复计一次。
5. **字节预算是同一套分片的第二把尺子（插件侧 `writeback.maxRequestBytes`）。** 条数上限（L0 100 / skill 500）之外还有**单请求字节**上限：缺省 **700000 B**，解析时 floor 并 clamp 到 `[1, 1000000]`（`dsh-plugin/src/wire-limits.ts` 的 `DEFAULT_MAX_REQUEST_BYTES` / `CORE_MAX_REQUEST_BYTES`）。超预算时先**逐条裁**（`fitMessageToByteBudget`，code point 安全，留 `…[truncated]`），再按字节**切片**（`chunkByByteBudget`）——所以「只有 12 条但 960 KB」的回合会真分片，而不是整轮丢。为什么必须有它：core 在 1 MiB 处**先 reject 再 destroy socket**，客户端只见 `ECONNRESET`、没有 413（README 实测：0.9 MB 通过，L0 1.05 / 1.2 MB 与 skill 3.75 MB 全挂在 reset 上）。**部分成功语义与第 4 条同源**：第 i 片失败即返回 `ok:false`，前 i-1 片**已落库**，死信 reason 前缀 `chunk i/n:`。运维侧要改这个键用 `deploy.sh --config-extra`（做法与实测输出见 [dsh-plugin-install-runbook.md](dsh-plugin-install-runbook.md) §3.2）。

**阈值纪律**：判重必须早于算字节/计数（`add-handler.ts:186-188` 注释 + `:228-231` 只对唯一消息累加 `raw_bytes`）。否则原症状会复现——`docs/ops/skill-feed-dedupe-evidence.md` 实测：「3 个唯一 tool_call 的载荷投 4 次，打满阈值 10 并归档 48 条（唯一内容只有 12 条）」。

**实测证据**：[skill-feed-dedupe-evidence.md](skill-feed-dedupe-evidence.md)（双喂 / 重放实测）；写链排他的运维做法见 `dsh-plugin/README.md`「与 MemoryProxy 路径的排他」一节。

---

## §3 答案口径（单一源 + 两处镜像）

| 层 | 单一源 | 版本号 | 镜像方 |
|---|---|---|---|
| 记忆工具指南 | `MemoryCore/src/core/prompts/memory-tools-guide.ts` | `MEMORY_TOOLS_GUIDE_VERSION = "memory-tools-guide-v2-tuned"`（`:19`） | `MemoryCore/openclaw-plugin/src/prompt-context.ts:9-34`（注释「与 … 逐字一致」+ 内联模板）；`dsh-plugin/src/guidance.ts` 的 `MEMORY_TOOLS_GUIDE_VERSION`（按符号引用：该目录 untracked 且并行修改，行号会漂） |
| 答案口径（币值 + 建议） | `MemoryCore/src/core/prompts/answer-guidance.ts` | `ANSWER_GUIDANCE_VERSION = "prod-block-v2-currency+pref"`（`:25`） | `openclaw-plugin/src/prompt-context.ts:36+`；`dsh-plugin/src/guidance.ts` 的 `buildAnswerGuidance` / `ANSWER_GUIDANCE_VERSION`（按符号引用）；`GUIDANCE_VERSION = ANSWER_GUIDANCE_VERSION + '|' + MEMORY_TOOLS_GUIDE_VERSION + '+dsh-tools'` 就是 ready 行 `guidance=` 的来源 |

- 两段口径各 3 条规则：币值 `answer-guidance.ts:28-33`（提问日期晚于记录 ≠ 失效；多条取最晚；完全没有相关内容才拒答）、建议 `:36-41`（先复述偏好再建议，有偏好线索就不拒答）。
- 为什么必须有：深池 A 臂 36 个错题里 **27 个（75%）是拒答**，而 bench 侧 `scripts/lib/bench/llm.mjs buildAnswerPromptTuned` 早就有这两段、**生产此前没有**（`answer-guidance.ts:1-25` 头注）。两边口径分叉 = 生产答得比 bench 保守。
- 一致性由 `answer-guidance.parity.test.ts` 调 `buildAnswerPromptTuned` 钉死（`answer-guidance.ts:20-25`）：改文案必须同步 parity 测试，否则 CI 红。
- 注入包裹语另有一档 `injectWrapper`（§1），calibrated 档文案 `inject-wrapper.ts:27`：「以下是与问题相关的历史记忆，请据此回答；若信息不足再说明。」

---

## §4 度量与门禁（结论能不能用，先过这四关）

### 4.1 bench 报告：只追加、永不覆盖

- 命名 = `<base>-<yyyymmdd-HHMMSS>-<配置指纹 sha8>.json`（冲突再追加 `-2/-3`），落盘见 `MemoryCore/scripts/eval-memory-bench.mjs:1508-1535`（`:1508-1510` 记病史：r141 五臂同名重跑覆盖 ⇒ 判分行消失、20 张票判定被卡住）。
- `latest.json` 目录级指针（`eval-memory-bench.mjs:1537-1547`）：并行/重跑后按它找最近一次，而不是猜文件名；归档工具认这个指针（`MemoryCore/scripts/archive-bench-reports.mjs:13`、`:89`）。
- `--report-name=<tag>` 额外写 `<tag>.json` 副本（arms 脚本按 tag 定位），**原件仍在带时间戳文件里**（副本 `:1534-1535`，原件 `:1531-1532`）。

### 4.2 判分覆盖率门禁：judged < 95% 就不许当结论

- `JUDGE_COVERAGE_MIN = 0.95`（`MemoryCore/scripts/lib/bench/report.mjs:15`）、`judgeCoverage(report)`（`:18-36`）直接数 `rows[].genCorrect`，不信任 `overall.genJudged`。
- `judgeGate`（`:38-59`）四类 invalid：rows 空 / 覆盖 < 95% / 有判分行但 `config.judgeModel` 缺失 / judged=0。
- `enforceJudgeGate` 返回 **3**（`:61-79`），各 bench 脚本照此 `process.exit(3)`：`bench-baseline.mjs:120/151/176/199`、`bench-bucket-paired.mjs:136`、`bench-gates.mjs:119`、`bench-ranking.mjs:165`、`bench-report.mjs:118`、`fit-fusion-weights.mjs:396`。
- 检索-only 档必须**显式** `--allow-unjudged` 才能配对（`report.mjs:38-59` 的 `allowUnjudged`、`:80+` 的 `attachJudgingStatus` 严格口径把检索-only 也标 invalid）——这是 #140 的「不许静默通过」。

### 4.3 typecheck 基线门禁（#107）

- `MemoryCore/typecheck-baseline.json`：`total 243 / fileCount 44`（main@17c0582 干净树读数，权威出处 `docs/audit/…§4.4`），按「文件 × 错误码」记条数（`byCode` 现 20 个码，最大 TS2322=70、TS2304=58）。
- `MemoryCore/scripts/typecheck-gate.mjs`：跑 `tsc -p tsconfig.typecheck.json --pretty false`，与基线逐组比对，**任一组条数变多或出现基线没有的组合 ⇒ exit 1** 并打印新增明细；条数变少只提示（`--update` 人工收紧）。CI job `memorycore-gates` 调 `pnpm run typecheck:gate`（`.github/workflows/ci.yml:65` 为 job 起点、`:90` 为该 step）。
- 语义边界：它只回答「这次改动有没有把红的面积做大」，不修错误、不判定责任（脚本头注 `:23-24`）。

### 4.4 prettier 门禁（#108，只查改动文件）

- 实测（`MemoryCore/.prettierrc` 头注）：`MemoryCore/src` 下 646 个 .ts，**任何**参数组合都 >545 个不一致（缺省 600 / Panel 口径 640 / printWidth 120 = 547）⇒ 本仓从未跑过 prettier，整仓 reformat 是纯噪声 diff。
- 故门禁只查本次改动的文件（`MemoryCore/scripts/format-changed.mjs`）：新增 .ts **硬门**、改动到的存量 .ts **告警**（`FORMAT_STRICT_MODIFIED=1` 时转硬门，等一次性纯格式 commit 落地再开）。CI 见 `.github/workflows/ci.yml:93-100`（`FORMAT_STRICT_MODIFIED` 现值 `"0"` 在 `:99`；install step 在 `:87-89`）。
- **状态注（2026-10-31 收尾实测，登记在 issue #108 的 comment）**：本地跑 `npm run format:check` 时，目标集只取**已提交**的 diff（`MemoryCore/scripts/format-changed.mjs:82-103` 的三点 `git diff <base>...HEAD`，不含工作树与暂存区）⇒ 本轮 171 个工作树改动、0 个已提交改动 ⇒ 目标空 ⇒ `:156-160` 直接跳过并 exit 0，**这一轮没有任何格式判定**。更硬的一层：`MemoryCore/node_modules` 里**没有 prettier**（`package.json:193` 只声明 `^3.9.10`，本机未 install），一旦目标非空又会走 `:56-65` 的 `resolvePrettier()` ⇒ 以「找不到 prettier」exit 2 ⇒ 本地这条门禁的两种结局是「跳过」或「缺工具报错」，都不等于「判定格式」。**边界**：CI 侧 `ci.yml:87-89` 的 `pnpm install` 会装 prettier，且 CI 跑在提交上 ⇒ CI 上目标非空时确实判定；结构性假绿只限「本地工作树 / 未装依赖」这条路径。修法与顺序（`pnpm install` → `.prettierrc` → 独立纯格式 commit → 再开 `FORMAT_STRICT_MODIFIED=1`）见 issue #108；**本票不修门禁**。
- 配置选型方向按实测走：**双引号 + semi + printWidth 120 + trailingComma all**（票面原方向是反的，见 `.prettierrc` 注释表）。

---

## §5 回滚（改了就回得去，才敢改）

**唯一入口**：`docs/ops/rollback-drill.md`（#149 召回全开档 · 回滚演练单）。要点：

1. **回代码缺省就能回滚**：ADR-0010 / ADR-0011 的缺省都是全关，回滚 = 删 yaml 段或写 `false`，**不需要改代码、不需要回滚代码**（`rollback-drill.md:73`）。
2. **先确认进程实际加载了哪个文件**（三套真源并存）：`git check-ignore -v MemoryCore/tdai-gateway.yaml`（`rollback-drill.md:46`）——本地档不入库，回滚不能靠 git checkout。
3. **目前没有 `config.effective` 快照**：改了 yaml 想知道生效没有，只能看 journal 的 gates 观测（`rollback-drill.md:62`）。
4. 逐键「位置 / 现值 / 回滚值 / 预期读数 / 观测点」表在 `rollback-drill.md:75+`；例：`recall.presentTemporal` 回滚 = **删键**（代码缺省 false ⇒ 无风险，`:80`）。
5. **纪律**：改缺省前先跑 bench 双臂取证（同 store / 同 manifest / 同判分器），读数进 `docs/optimization-results.md`，再改代码缺省 + 两套 yaml + 本文件四处（§0 关键事实三）。

**回滚风险排序**（按本文件 §1 的键）：零风险（代码缺省即目标态）：presentTemporal / evidencePack / (`coreRefBoost|graphDiscount|sceneBoost` 显式 0)。低风险（有读数、方向明确）：`validity.mode`、`maxResults`、`rerank.mode`。需配对读数才能回滚的：`supersession`（回滚会让旧值注入率回到 33.3%，见 `long-session-bench.md` §6）、`candidateK`（回 15 会掉 6.44pp）。

---

## §6 取证对照表（改动 → 读数 → 结论）

（只取仓库**已有**读数；n=90 的判对 CI 半宽 6–7pp，≤3pp 一律按「未检出」处理。）

| 改动 | 取证读数 | 出处 | 结论 |
|---|---|---|---|
| `maxResults` 5→10 | 判对 56/90 → **60/90**（+4.5pp）；三因子组合 66/90 = 73.3%（A→X McNemar p=0.0129） | `docs/optimization-results.md` §24.2-24.3 | 留 10；代价是 top-5 内排序变差、块字符 +65%（3277→5413，仍 < 14000） |
| `injectWrapper` legacy→calibrated | 深池 A 臂 36 错题里 **27 个是拒答（75%）**；legacy/neutral 文案都在「先声明可能不相关」 | §24.4、`answer-guidance.ts:1-25`、`inject-wrapper.ts:11-19` | 缺省 calibrated，保留 legacy 回滚档；无 A/B 读数 ⇒ 证据等级 argued |
| 币值 + 建议口径（答案侧） | 拒答 28→23、判对 +2 题（§24.4 单因子 ns）；三因子组合显著 | §24.4/§24.5、§24.8 | 生产注入（§3），token 成本计入 §6 表下方注 |
| `validity` hard→soft | card-soft turnCov **+0.6pp**、判对 +1.1pp(ns)；nogate-soft overall cov **−10.6→−4.1pp**、temporal **−13.3→0.0pp** | §11.2（`:418-426`） | 缺省 soft；cloud/base/本地三处一致 |
| `supersession` false→true | 长会话三臂：旧值注入 **100%→0%**、当前命中 **33.3%→100%**、重复值 **7.67→1.0**（离线机制冒烟，非质量读数） | `docs/long-session-bench.md` §6 | 缺省 true；LME90 turnCov −10.9pp 是残留风险，故与 validity soft 配套 |
| `factKey` true→false | LME90 A vs B 判对 **−2.2pp**（ns）、cov −4.6pp；全开档键替换无净收益 | §22.4 / #147 / ledger §3-4 | 缺省 false，等 #168 长会话读数再议 |
| `candidateK` 15→32 | 匹配设计 15 对 **+6.44pp** | §20.3 | 留 32（增益型） |
| `rerank` 开 + 深池 32 + floor −10.5 | turnCov@5 **84.3%** vs 关精排 79.5% vs 12/−2 = 67.1% | §10 修正 / §19.9 / §21.3 | 生产开；minScore 按 provider 刻度不钉 |
| `fusion` rrf→normalized（**未采纳**） | 浅池 matched +2.90pp，但深池锚点 **−2.22pp**（ns） | §17.9（`docs/optimization-results.md:1190`） | 生产维持 rrf；本地档 normalized 属实验 |
| `coreRefBoost/graphDiscount/sceneBoost` →0 | 关断有害（#173-B） | `config.ts:2184-2187` 注释 | 0 = 关；**只能写 0，不能删键** |
| `evidencePack`（**未翻转**） | 无读数（待 #169 四档） | `run-r169-evidence-pack.sh` | 缺省 false = 等读数，不是否决 |
| `presentTemporal`（**未翻转**） | +0.37pp **n.s.** | §16 | 缺省 false；显式落盘防漂移 |

---

## §7 复查命令（任何人可复跑，全部只读）

```bash
# 1) 三套真源一致性（白名单外键集合与值必须完全一致；钉住的 9 个键必须等于代码缺省）
node deploy/global-images/check-config-consistency.mjs

# 2) 代码缺省：逐键看 config.ts 的 ?? / 缺省分支
grep -nE 'maxResults:|softPenalty:|hardOnPresentIntent:|injectWrapper:|coreRefBoost:|graphDiscount:|sceneBoost:' MemoryCore/src/config.ts

# 3) 生产档现值的三处对照
grep -nE 'maxResults:|validity:|softPenalty|hardOnPresentIntent|injectWrapper|budget:' \
  deploy/global-images/tdai-gateway.base.yaml \
  deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml \
  MemoryCore/tdai-gateway.yaml

# 4) 写面缺省与 yaml 是否同档
grep -n 'supersession\|factKey\|factRows' MemoryCore/src/core/record/write-policy.ts
cd MemoryCore && npx vitest run src/config/__tests__/config.write.test.ts

# 5) 门禁本身是否可用
cd MemoryCore && pnpm run typecheck:gate && pnpm run format:check
```

---

## §8 已知漂移收口记录（**已收口 2026-11-01**）

§8 原登记 6 条**别人文件**里的旧缺省值/旧行号漂移，2026-11-01 已全部收口：**只改文档与 YAML 注释行，未改任何值**（值已于 2026-10-31 WP1b 定档）。逐条「文件:行 旧说法 → 新说法 → 依据代码 path:line」见 **`docs/ops/defaults-drift-closeout.md`**。

| # | 位置 | 旧说法 | 现说法 | 状态 |
|---|---|---|---|---|
| 1 | `docs/ops/config-default-ledger.md` §3-3（validity） | 云模板仍 **hard**（cloud:210-211）、代码缺省 hard | **三处一致 soft**：cloud `:229-233` / `config.ts:2234-2253` / 本地 `:222-223` | 已收口（2026-11-01） |
| 2 | 同上 §3-5（supersession） | 本机 true、**云模板 false**、代码缺省 false | **三处均 true**：cloud `:80` / `write-policy.ts:101` / 本地 `:82-83`；去留仍归 #168 | 已收口（2026-11-01） |
| 3 | 同上 §3-8（maxResults） | 两份 yaml 仍显式钉 5 | 三处均 **10**：base `:159` / cloud `:140` / 本地 `:135` | 已收口（2026-11-01） |
| 4 | 同上 §0（env 生成档 / 白名单结论） | 脚本每次启动「重写」yaml 且不含决策键 ⇒「生产缺省 = 代码缺省」 | 脚本已改为 **cp base.yaml 全量渲染**（`start-memory-core.sh:79/:97/:108-141`）⇒ 生产值 = base 值；白名单差异只剩 factKey / factChannel / fusion 三条实验轴 | 已收口（2026-11-01） |
| 5 | `MemoryCore/tdai-gateway.yaml:220`（行注） | 「缺省 hard（零行为变化）」 | 「代码缺省已 soft（WP1b 2026-10-31，`config.ts:2234-2253`）；本档显式 soft = 防漂移钉」 | 已收口（2026-11-01） |
| 6 | `docs/long-session-bench.md:25`（三臂表） | 「现状缺省（`write-policy.ts:77` 三个开关全关）」 | A 臂 = 显式关 supersession，**不等于现缺省**（缺省 supersession 开：`write-policy.ts:101`；factKey/factRows 仍关 `:92-99`/`:102`） | 已收口（2026-11-01） |

**复查顺带收掉的本文件之外漂移**（同属 docs，本票 scope 内）：`docs/optimization-results.md` §21.3 validity 行（`:1761` 三列全 soft）、`:2346`（maxResults 缺省 5→10、`config.ts:2138`）、`:140`/`:258`（supersession「默认关」→ 注明 WP1b 翻 true）、`:407`、`:408`、`:468`、`:1758`（candidateK 缺省 =30）、`:1759`（cloud fusion 已显式）、`:1762`（smallToBig 生产 ≠ 代码缺省）、`:48`（「生产口径 = 代码缺省」限定为「yaml 已写按 yaml」）。`docs/benchmarks.md` grep「缺省/默认/default」零命中，未改。

**scope 外残留（2026-11-01 已由 task-27 收口）**：原登记 3 条，现全部落地——逐条改法见 `docs/ops/defaults-drift-closeout.md` §3。

1. `docs/ops/rollback-drill.md`：`:39`（生成档 = base 全量渲染，决策键继承 base 显式值）、`:78`（validity 回滚 = 显式写 `hard`，不再等于缺省）、`:145` 注 2（早间「订正为 hard」已被同日晚 WP1b 推翻，现三处一致 soft）；同行同族另修 `:38`（云模板 supersession/validity 旧值）、`:73`（「全部键都能回代码缺省」两分类改写）、`:82`（candidateK 回滚 = `maxResults*3` = 30）、`:25`/`:52`（`:839-858`、`:56-76` 行号）。
2. `docs/adr/0010-双时态属性契约与软失效.md`：**正文一字未改**（决策历史不追溯篡改），仅在 H1 下加一行指引「现行档位与缺省值以 production-profile.md 为准；本文记录的是当初的决策与理由，不追溯改写」（`:3`）。
3. `MemoryCore/src/config.ts:160` 类型注释「两份 yaml 仍显式钉 5」→「三处均为 10（base `:159` / cloud `:140` / 本地 `:135`，2026-10-31 定档）」；缺省值 10 未动。

> 漂移不是结论错，是**行号与旧值残留**。纪律：只改对应行、不重新裁决；改完在 §0 的三方一致性检查（`node deploy/global-images/check-config-consistency.mjs`）与 `MemoryCore/typecheck-baseline.json` 上各复跑一次。

---

## §9 注

1. 本文件所有行号为 2026-11-01 工作树快照；改动 `config.ts` / 任一套 yaml 后，**必须**同步本文件对应行的行号。
2. 本文件不新增任何键值，也不重新裁决留/删——裁决归 `config-default-ledger.md`（#154）与 `docs/optimization-results.md` §21.3。
3. 引用 bench 读数必须同时说清三件事：同 store / 同 manifest / 同判分器（`report.mjs:9` 的配对口径）；跨判分器不可比（`judge.mjs:59` 的 fingerprint）。
