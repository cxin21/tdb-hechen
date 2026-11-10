# Soul 人格系统只读评审与修改方案（2026-11-07）

> 范围：`D:/TDB/td-agemem` 的 Soul/人格层（MemoryCore + dsh-plugin + 生产数据面）。
> 方式：只读评审 + 全量测试 + 生产接口/库/日志抽样；本文件是新增评审文档，未修改源码、配置或既有文档，未重启服务，未写生产库。
> 数据快照：生产数字取自 2026-11-07 15:24Z 前后的只读查询与接口返回；评审后数据仍会变化，引用时请保留时间。
> 结论：**机制骨架成立，但“真实会话 → 事件 → 特质/事实 → 卡更新”没有跑通；存在 1 个 P0 身份错误、4 个 P1 数据/证据缺陷。**

## 0. 摘要

- 生产 `agt-bbr29z58s2` 的人格卡被命名为「何晨」——这是用户的名字，来源是 assistant 解释正则的说明文字，不是自称。**P0，必须修。**
- 唯一真实会话有 44 条 user 消息，只产出 5 条事件，正好等于 `perSessionCap`；12:38 之后 10 条含纠正/抱怨的消息永远进不了事件。**P1。**
- 种子状态 L1=2.1，远超 `TRAIT_L1_MAX=0.5`；首次漂移会把六轴等比缩到 23.8%，人格会突然变淡。**P1。**
- 同一 agent 的卡显示激活度 0.8，`/v3/soul/trait-state` 显示 0.00；注入 hash 两端算法/输入不同，审计无法证明“卡进了提示词”。**P1 ×2。**
- 门全部 PASS：core typecheck 121 errors/23 files（基线 149/28，Δ=-28）；core 398 files/3778 tests；panel 36/282 + build 7.68s；plugin 40/714。**测试绿 ≠ 机制通。**

## 1. 范围、环境与方法

### 1.1 代码面

- `MemoryCore/src/core/soul/`：card、card-service、traits、trait-drift、trait-judge、trait-judge-prompt、episode、history、emotion、gates、persona、worker、observation、sqlite。
- `MemoryCore/src/gateway/`：soul-card-endpoint、soul-injection-endpoint、soul-injection-stats-endpoint。
- `dsh-plugin/`：persona-card、segments/persona、volatile、injection-log、index。
- `panel/`：仅跑门，不展开评审。

### 1.2 运行面

- core `8420`、knowledge `8421`、panel `8123`、supervisor `127.0.0.1:8446/status`。
- `D:/TDB/data/vectors.db`（`node:sqlite`，`readOnly:true`）。
- `D:/TDB/data/logs/persona-injection.jsonl`、`tdb-service-events.jsonl`、`D:/TDB/data/run/tdb-supervisor.state.json`。
- Node v22.22.2，Windows，命令在 git-bash 下执行。

### 1.3 方法

- 先 codegraph/grep 定位，再逐函数读源码；每条结论回到 `path:line` 或实测数字。
- 接口只用 GET；库连接 `readOnly:true`；未写库、未重启、未跑迁移。
- 测试只运行，不修改；红/失败只报告。

## 2. 门与数字

| 门 | 命令/对象 | 实测 | 基线对比 | 结果 |
|---|---|---|---|---|
| core 类型门 | `node scripts/typecheck-gate.mjs` | 121 errors / 23 files | 149 / 28；Δ=-28 | **PASS**（exit 0） |
| core 单测 | `npx vitest run` | 398 files / 3778 tests passed | 3777；**+1** | **PASS**（exit 0，数字待确认） |
| panel 类型门 | `tsc --noEmit` | 0 error | — | **PASS** |
| panel 单测 | `npx vitest run` | 36 files / 282 tests passed | — | **PASS** |
| panel 构建 | `npm run build` | ✓ built in 7.68s | — | **PASS**（chunk >500 kB 警告） |
| plugin 单测 | `npm test` | 40 files / 714 tests passed | — | **PASS** |
| plugin 构建 | build/tsc | exit 0 | — | **PASS** |

> 唯一数字偏差：core 实测 3778，基线 3777，多 1 条。按“数字对不上即发现”记录；不改变 exit code，但需要确认是新增测试还是基线陈旧。

## 3. 逐条复核

| # | 机制点 | 结论 | 证据（path:line / 实测） |
|---|---|---|---|
| 1 | 卡自洽、轴名不泄漏、红线逐字、无半截 | **成立** | `MemoryCore/src/core/soul/card.ts:109-205`、`:300-326`；实测 667 字符、hash `e3460a3f0d50e9a6...`、六轴名 0 命中、4/4 红线逐字在卡内 |
| 2 | 卡有总字符预算 | **不成立** | 只有 block 行数上限与红线 30 行/单行 120/总 2600（`card.ts:200-205`、`:300-326`）；无整卡 maxChars，插件 section 也不设 |
| 3 | `ADD/UPDATE/INVALIDATE/NOOP` 状态机 | **不成立** | 生产无此枚举；决策体现为账本 `action`（`worker.ts:1609-1633`、`:2148`）。`validTo` 只写不读（`persona.ts:227`，读取侧无按 validTo 截止）；`supersededBy` 零生产者（`sqlite.ts:8707` 仅保留键） |
| 4 | 唯一写者 | **成立** | `commitSoulPersona` 唯一 upsert 在 `worker.ts:2148`；`forgetting-worker.ts:207` 只写 ledger（`upsert: []`） |
| 5 | 事件归档与水位 | **成立** | `deleteSoulEpisodes` 实为 `UPDATE ... archived_at`（`sqlite.ts:3672-3678`）；list 默认 `archived_at IS NULL`（`:3702`）；水位读取于 `worker.ts:988-1000`、`:1917-1924`；`embedding_meta` 值 `2026-11-07T06:42:15.634Z` |
| 6 | 每会话事件上限 | **成立且已实锤** | `episode.ts:416` 默认 5；`:540` 用 `break`。实测 5 行全同 session，user 44/assistant 49，12:38 后仍有 10 条 user 消息未进入 |
| 7 | 事实层全量史 + 承诺闭环 | **部分成立** | `historySource = listSoulEpisodes({includeArchived:true,limit:2000})`；`soul_promises` 生产 0 行；`broken` 只在后续文本命中 `/没守住/` 时成立（`history.ts:249-261`） |
| 8 | 修复判据唯一 | **不成立** | 事件侧 `/补上了|已按|已对齐|已改|改完|改口/`（`episode.ts:797`）；承诺侧只认「没守住」（`history.ts:249-255`） |
| 9 | `mood_gate` 会拦住生长 | **不成立** | `worker.ts:1442-1456` 只写 `action=arbitrate`，注释明确“门只观测不否决”；`emotion.ts:723-726` 注释仍称会写 identity/values，属陈旧注释 |
| 10 | 特质步长/L1 约束可验 | **成立** | `TRAIT_DRIFT_ALPHA=0.02`、`TRAIT_MAX_STEP=0.05`、`TRAIT_L1_MAX=0.5`（`traits.ts:28-30`）；单 tick `|Δ|≤0.02`，`trait-drift.ts:124-130` 的 `step_exceeded` 正常参数不可达 |
| 11 | 判测信息隔离与接线 | **成立** | `lifecycle-scheduler.ts:255` 实际注入 `createTraitJudge`；`trait-judge-prompt.ts:1-11` 导入面只 traits/types，`:57-73` 不带卡文本/轴值；12:53 账本有净票 5/2，证明跑过 |
| 12 | 注入 hash 可端到端对账 | **不成立** | Core `sha256([READER_NOTE,body])`（`card.ts:114-120`）vs 插件 `fnv1aHex(frozen)`（`persona-card.ts:311-317`）；`injection-log.ts:13-16` 的对账说法不成立；9 条 section-read 全为测试夹具 v9/`35d8d7b0`/28 字符 |
| 13 | 退场词未复活 | **成立** | 非注释活引用只剩 `worker.ts:846` 的 slot-import 清退；`role_prompt/rules_prompt/legacySoulEnabled/volatile.soul/oncePerSession/soulGate` 等均 0；`core/soul/replay.ts` 不存在 |

## 4. 问题清单（按是否造成错误行为降序）

### P0-1 观察名把用户名字写成 agent 名（身份错误）

**证据**

- `card-service.ts:82-111`：`observedNameFromL0` 只认 `role==="assistant"`，正则为 `/我叫.../、/叫我.../、/我的名字是.../`，无长度、代码围栏、引号上下文过滤；调用点在 `:361-366`，扫最近 200 条。
- 生产 `soul_snapshots` v18（`agt-bbr29z58s2`）名称「何晨」，`meta.nameSource="observed"`；来源 `msg-0df185a899d043d488f0f6087bada22f` 第 2205 字符处的机制说明（原文在解释“用户说『我叫何晨』不会给 agent 命名”）。
- 注释 `:91-92` 已经预言了用户自述的风险，但没有防住 assistant 引用/解释。

**触发条件**

任何 assistant 消息在最近 200 条内出现“我叫X/叫我X/我的名字是X”（包括文档、示例、测试、bug 复现、机制解释），且长度/上下文未过滤。

**后果**

该 agent 的卡以自己的卡说“名称：何晨”，会以用户身份自称；属于跨身份污染，且会被注入系统提示词。

**根因**

把“对话文本里的字符串”当成“agent 的自述”；在无 declared 名时，观察路径直接把这段字符串当名字。

---

### P1-1 `perSessionCap=5` 造成会话尾部永久饥饿

**证据**

- `episode.ts:416`：`const perSessionCap = opts?.perSessionCap ?? 5`；`:540`：`if (sessionEpisodes >= perSessionCap) break;`。
- 扫描每 tick 从窗口最早重新开始，`nearDup` 只看本轮数组（`:533-539`），因此永远先收满最早 5 条再 `break`。
- 生产 `soul_episodes` 5 行全部同一 `session_id=session-f0c9f3f0-43a4-48d8-b695-008cbf4bba3a`、`kind=work`、09:22:45–12:38:21Z；该 session 的 L0 有 user 44 / assistant 49，12:38:21 之后还有 10 条 user 消息（含「已经重启了，为什么配置页的是都没启动」「不是说了…为什么非本插件拉起的点不了重启」等 correction/complaint）。

**触发条件**

单个会话中合格事件超过 5 条，且最早 5 条仍在 30 天窗口内。

**后果**

后续纠正/抱怨永远不进入事件，不参与特质判票、情绪、事实层；人格学不到会话后半段。这是“数据不流动”的直接机制，不是模型不努力。

**根因**

cap 的语义是“每会话每轮最多 5 条”，实现却是“扫描到第 5 条就停止”，且每轮重新从最早扫；cap 没有对“本轮新增”生效。

---

### P1-2 种子状态 L1=2.1，首次漂移整体骤缩

**证据**

- `traits.ts:352-366`：`seedStateFromSeeds` 逐轴 `clamp(Σ w·d, -1, 1)`，**不做 L1 归一**。
- `worker.ts:1171-1172`：把 `state+seedState` 一起落库；生产 `agt-3i8k22f496` 的 `axis_json=seed_json=[0.5,0.3,0.6,0.2,0.1,0.4]`，L1=2.1。
- `trait-drift.ts:136-144`：首次漂移若 L1>0.5，按 `0.5/2.1=0.238` 等比缩放全部六轴；raw 轴值缩到 23.8%，激活度从约 0.75 降到约 0.56。

**触发条件**

agent 声明了多个种子标签，使 `Σ|axis|>0.5`，且第一次出现净票 ≥2 的漂移。

**后果**

人格数值在第一次学习时突然整体变淡；用户看到的是“刚开始学就变了一个人”，不是渐进漂移。L1 预算不变式在初始化时即被违反。

**根因**

L1 归一只在 drift 内做，种子初始化绕过；且 clamp 在“算完 delta 之后”执行，把未变化的轴也一起缩放。

---

### P1-3 同一 agent 的卡与 trait-state 数字矛盾

**证据**

- 无 `soul_trait_state` 行时，卡走 `seedStateFromSeeds(profile.traits)`（`card-service.ts:292-293`），显示 0.8/0.7/0.7/0.6。
- `soul-card-endpoint.ts:118-126` 在无 state 行时 `state=null`；`:156` `nowWeight: state ? activationOf(...) : 0`，于是接口全 0.00。
- `:140-145` 的 `drifted` 用 `|state−seedState| > TRAIT_MAX_STEP(0.05)`，把“单 tick 上限”当成“是否漂移”的阈值。
- 实测 `agt-fa0u5mi7x4`：卡 0.8/0.7/0.7/0.6，`/v3/soul/trait-state` 四个 `nowWeight` 全 0，`updatedAt=null`。

**触发条件**

agent 有 declared profile、但还没有 `soul_trait_state` 行（新 agent 或重置后）。

**后果**

面板/接口与卡讲两个数字；用户无法判断哪个是真的，也无法验收“漂移是否发生”。

**根因**

读侧没有共用同一 fallback；`drifted` 语义混用。

---

### P1-4 注入 hash 跨端不同源，审计无法证明卡进了提示词

**证据**

- Core：`card.ts:114-120` `hash=sha256([CARD_READER_NOTE, body.text].join("\n\n"))`，卡尾只放前 12 位。
- 插件：`persona-card.ts:311-317` 对 `frozen`（含卡尾注释的整段）算 `fnv1aHex`。
- `injection-log.ts:13-16` 声称“hash 与 Core GET 相等即证明卡进了提示词”，算法与输入都不同，结论不成立。
- 生产 `/v3/soul/injection/stats?team=team-2k12lgb650&agent=agt-bbr29z58s2&hours=24`：`rows=3`、`pairs={matched:2,charMismatch:2}`、`serverRenderOnly=110`；9 条 `section-read` 全是测试夹具（v9/`35d8d7b0`/28 字符），真实会话只有 1 条 `turn-append`，**没有真实 section-read**。
- `soul-injection-stats-endpoint.ts:377-422` 的 `pairs` 只按 sessionKey 配对、只比 chars，不比 version/hash/turn；一个会话里任一条 chars 不等就整会话记 mismatch。

**触发条件**

任何真实会话；尤其当插件对卡做了裁剪/前处理时。

**后果**

“注入健康”看起来有数字，但无法证明稳定前缀里真的有卡；mismatch 也可能只是 chars 统计口径，而不是注入失败。

**根因**

两端各自发明 hash；统计层用 chars 代替内容指纹；真实 section-read 缺失时没有“未证明”状态。

---

### P2 低危问题

| 编号 | 问题 | 证据 | 后果 |
|---|---|---|---|
| P2-1 | 心境每 tick 把 `episodePool` 全部非 work 事件重投 `integrateMood`，不按 since 过滤 | `worker.ts:1934-1938`；`integrateMood` 是加权平均（`emotion.ts:479-530`） | 同一证据被反复加权，情绪被“持续按住”；当前 `soul_emotions` 0 行，尚未显形 |
| P2-2 | 硬编码专名「何晨」/「Lead」 | `emotion.ts:990`；`history.ts:96` | 跨租户复用会误抽对象；产品专名进入通用抽取器 |
| P2-3 | 快照同 version/hash 重复写 | `agt-dofal7hgfe` v1 06:42:49.919/.087、v2 12:53:45.402/.514 各两行 | 审计计数偏大；版本非唯一 |
| P2-4 | 评审会话被当人格证据蒸馏 | 15:24 新增 4 条 reject 直接引用「我给自己（并为审查人设「审墨」）定下的红线…」等本轮文本，仅“独立证据 2<3”挡住 | 同类文本重复 3 次可能被 admit；任务书/assistant 自述污染人格 |
| P2-5 | 卡无总字符预算 | `card.ts` 只有 block 行数与红线上限；插件 section 不设 maxChars | 极端多行时稳定前缀膨胀；当前 667 字符，风险未发生 |
| P2-6 | `validTo`/`supersededBy` 半套状态机；死分支/陈旧注释 | `validTo` 只写不读；`supersededBy` 零生产者；`TRAIT_MAX_STEP` 分支不可达；`emotion.ts:723-726` 与 `sqlite.ts:4201` 注释陈旧 | 读者误以为有“取代/过期”执行；排障成本 |

## 5. 修改方案

> 原则：先把“错身份/错数字/假证据”修掉，再改数据分布，最后做质量项。三批可独立发布、独立回滚。

| 批次 | 项目 | 对应问题 | 改动面 | 风险 |
|---|---|---|---|---|
| A1 | 观察名停用/严格化 | P0-1 | card-service 读侧 | 低 |
| A2 | trait-state 与卡同 fallback | P1-3 | gateway 读侧 | 低 |
| A3 | 注入 hash 统一 | P1-4 | core + plugin + stats | 中（双端发版） |
| B1 | 事件 cap 改为“每 tick 新增” | P1-1 | worker 流程 | 中（判侧成本） |
| B2 | 种子 L1 归一 | P1-2 | traits + drift + 数据迁移 | 中（卡值可见变化） |
| B3 | 快照幂等/版本唯一 | P2-3 | sqlite 写入 + 表约束 | 中（迁移） |
| C | 心境 watermark、硬编码、自蒸馏门、卡预算、状态机/注释 | P2 | 局部 | 低 |

### A1（P0）观察名不再从对话猜

**推荐：直接停用 observed 名。** 名字只认 `meta_agent_persona.name`；没有 declared 名就渲染“（未命名）”。理由：这是唯一能彻底消灭“assistant 解释正则 → 把用户名字写成 agent 名”的路径，且真实 agent 都有 declared 档案。

如果产品坚持保留“自述名”，用严格抽取器，四道过滤缺一不可：

```ts
const NAME_DECL = /^(?:你好[，,]\s*)?我叫\s*([\u4e00-\u9fa5]{2,6})(?:[，。！!]|$)/u;
const NAME_BAD = /\x60{3}|\x60|\/|正则|示例|比如|例如|假设|用户|他|她|名字是|叫我/u;

function observedNameFromL0(msgs: Array<{ role: string; content: string }>): string | undefined {
  for (const m of msgs.slice().reverse()) {
    if (m.role !== "assistant") continue;
    const text = String(m.content ?? "").trim();
    if (!text || text.length > 80) continue;      // 长文一律不认
    if (NAME_BAD.test(text)) continue;            // 代码/说明/引用/第三人称
    const hit = NAME_DECL.exec(text);             // 必须从消息开头自述
    if (hit) return hit[1];
  }
  return undefined;
}
```

**数据处置**：历史错误快照保留（审计），不删；读侧只取最新。下一 tick `persist:true` 时名称变化 → 文本变化 → version+1，自动自愈。`GET /v3/soul/card` 是 `persist:false`，发版后立即正确。

**测试**

- 生产原消息 `msg-0df185a899d043d488f0f6087bada22f` 全文 → `undefined`（长度+反引号双拦截）。
- `"我叫何晨，是..."`（消息开头、80 字内）→ `何晨`。
- user 说“我叫何晨” → `undefined`。
- assistant 说“用户说「我叫何晨」不会给 agent 命名” → `undefined`。
- declared `审墨` 存在时，任何 observed 结果都不能覆盖。

**验收**：`GET /v3/soul/card?...&agent=agt-bbr29z58s2` 不再出现“何晨”；新快照 `nameSource` 为 `declared`/`skeleton`。

### A2（P1）trait-state 与卡使用同一套 fallback

**位置**：`soul-card-endpoint.ts:118-156`；对照 `card-service.ts:292-293`。

```ts
const seed = seedStateFromSeeds(profile?.traits ?? []);
const state = traitState?.state ?? seed;
const hasState = Boolean(traitState?.state);

return {
  // ...
  nowWeight: activationOf(state, label.direction),
  seedSource: hasState ? "state" : "seed",
  initialized: hasState,
  drifted: hasState && axes.some((a) => Math.abs(a.state - a.seedState) > 0.005),
};
```

`drifted` 改用“是否偏离种子”的 epsilon（如 0.005），不要复用 `TRAIT_MAX_STEP=0.05`。

**测试**：有 profile、无 state 的 agent，卡上 0.8/0.7/... 与 `/v3/soul/trait-state` 的 `nowWeight` 完全一致；`source:"seed"`。

### A3（P1）注入 hash 统一为 SHA-256 + 卡正文

**契约**

- 算法：SHA-256。
- 输入：卡正文去掉尾部 `<!-- persona-card ... -->`；即 Core 的 `material = READER_NOTE + "\n\n" + body.text`。
- 长度：64 位 hex，不再截 8 位。

插件侧：

```ts
import { createHash } from "node:crypto";
const body = frozen.replace(/\n?<!-- persona-card[^>]*-->\s*$/, "");
const hash = createHash("sha256").update(body).digest("hex");
// 与 Core GET 返回的 hash 直接比较
```

注意：若插件在拿卡后还有 `stripSceneNavigation`/裁剪，必须在裁剪**之前**算 hash，或让 Core 返回“裁剪后文本的 hash”；否则仍不同源。

**统计侧**：`pairs` 改为“sessionKey + phase + version + hash”；chars 只作辅助。新增 `coverage: { injectionRows, sectionReadRows, sessionsWithProof }`；没有真实 section-read 时明确 `proof=0`。旧行标 `legacy:true`，保留 chars 回退。

**验收**：真实会话 section-read 的 64 位 hash 与 Core 相等；`charMismatch` 归零或只剩 legacy；统计页区分“服务端渲染估算”和“插件回传实证”。

### B1（P1）事件 cap 改为“每 tick 新增 5 条”

**位置**：`episode.ts:416`、`:540`；`worker.ts:1008-1054`。

**不要只把 `break` 改成 `continue`**——那仍然只保留最早 5 条。正确做法是把 cap 移到 worker，针对“本轮新事件”生效：

```ts
// 1) known 快照已经在 commit 之前（1013 在 1024 之前），顺序正确
const freshAll = minedEpisodes.episodes.filter((e) => !knownEpisodeIds.has(e.episodeId));

// 2) 每个 session 本轮最多收 cap 条；优先非 work，再按时间新→旧
const fresh = capFreshPerSession(freshAll, 5);

// 3) 只提交本轮真正要入库的
if (fresh.length > 0) {
  const res = await store.commitSoulEpisodes(deps.tenant, fresh);
  inserted = res?.inserted ?? 0;
}

// 4) 判侧只吃 fresh；未入选的留给下一 tick
const freshEpisodes = fresh;
const repeatEpisodes = minedEpisodes.episodes.length - freshAll.length;
report.episodeCapSkipped = freshAll.length - fresh.length;
```

```ts
function capFreshPerSession(eps: SoulEpisode[], cap: number): SoulEpisode[] {
  const by = new Map<string, SoulEpisode[]>();
  for (const e of eps) (by.get(e.sessionId) ?? by.set(e.sessionId, []).get(e.sessionId)!).push(e);
  const out: SoulEpisode[] = [];
  for (const list of by.values()) {
    list.sort((a, b) =>
      Number(b.kind !== "work") - Number(a.kind !== "work") ||
      Date.parse(b.at) - Date.parse(a.at),
    );
    out.push(...list.slice(0, cap));
  }
  return out;
}
```

第 1 tick 收最新 5 条，第 2 tick 这 5 条已 known，再收下一批 5 条，直到 44 条消息里所有合格事件都入库。`episode.ts` 的 `perSessionCap` 保留作纯函数参数，但不再在扫描时 `break`；若窗口内候选超过 `maxEpisodes=120`，也改成“收集后按 at 倒序截断”。

**测试**：伪造 12 条合格消息，第一次入库 5 条；带着已有 5 条再跑，入库接下来 5 条；两次无重复；最终覆盖 12 条。用生产 session 的 44 条消息做 fixture，断言 12:38 后的 correction/complaint 在后续 tick 出现。

**验收**：同一真实 session 的 `soul_episodes` 连续 tick 从 5 增长到 >5；新 episode_id 出现在判侧票/账本；无重复。

### B2（P1）种子状态先归一，再允许漂移

**位置**：`traits.ts:352-366`；`worker.ts:1171-1172`；`trait-drift.ts:136-144`。

源头：

```ts
const raw = /* Σ w·d，逐轴 clamp */;
const l1 = l1Norm(raw);
if (l1 > TRAIT_L1_MAX) {
  const k = TRAIT_L1_MAX / l1;
  for (const axis of SOUL_AXES) raw[axis] = clamp(raw[axis] * k, -1, 1);
}
return raw;
```

drift 入口兜底：

```ts
const startL1 = l1Norm(state);
const base = startL1 > TRAIT_L1_MAX
  ? scaleAxes(state, TRAIT_L1_MAX / startL1)
  : state;
// 后续 delta 基于 base 计算；l1Clamped = startL1 > TRAIT_L1_MAX
```

**数据迁移**：先备份 `soul_trait_state`；对 `L1 > 0.5` 的行按 `0.5/L1` 同时缩放 `axis_json` 与 `seed_json`，写 `action="trait_normalized"` 账本。生产 `agt-3i8k22f496` 当前 L1=2.1，缩放后 raw 轴值约为原来 23.8%，卡上激活度约 0.75→0.56——这是可见变化，必须提前告知。

**产品决策点**：`TRAIT_L1_MAX=0.5` 对声明很多特质的 agent 偏低。若希望种子仍显得强，可把上限调到 2.0 并让种子/漂移都用 2.0；但必须只保留一个上限，不能“种子不设限、漂移 0.5”。

**测试**：种子 L1=2.1 → 归一后 ≤0.5；首次 drift 不再产生超过单 tick 的跳变；ledger 记录 `startL1/afterL1`。

### B3（P1）快照写入幂等，版本唯一

**位置**：`MemoryCore/src/core/soul/sqlite.ts` 的 `writeSoulSnapshot` + 表约束。

1. 备份并去重现有重复行（同 tenant/user/agent/version 只留最早一行）。
2. 加唯一索引 `UNIQUE(tenant_id, user_id, agent_id, version)`。
3. 写入改 `INSERT ... ON CONFLICT DO NOTHING`；冲突且 `content_hash` 相同则复用；不同则读 `MAX(version)+1` 重试一次。
4. `assembleSoulCard(persist:true)` 外层加 per-agent 互斥（进程内 `Map<key, Promise>`），避免同 tick 并发写。

**测试**：并发两次同 version → 只落一行；不同 hash 同 version → 第二次递增；重复 tick 不产生重复。

**验收**：`agt-dofal7hgfe` 的 v1/v2 重复行消失；`GROUP BY agent,version HAVING count(*)>1` 为空。

### C. 质量项

| 项 | 做法 | 验收 |
|---|---|---|
| 心境重复加权 | `episodeEvents` 不再吃全量 pool；增加 `soul.moodEpisodeWatermark`（首次=now-lookback，之后=max(已处理 at)），只处理 `at > watermark`；若需严格一次，增加 `soul_mood_consumed(episode_id)` 幂等表 | 同一 episode 连续两 tick 只影响一次 |
| 硬编码姓名 | `extractAffectReferent(text, personName?)`、`factsFromEpisode(ep, personName?)`；删除 `emotion.ts:990` 的「何晨」，由 worker 传 `personName` | 多租户测试用张三/李四；`grep 何晨 MemoryCore/src` 仅测试夹具 |
| 自蒸馏风险 | identity/values 新增“用户亲口立场”门：`cited` 中 `userStance.length>=8` 的事件 ≥ `minEpisodeEvidence`，否则拒 `user_stance_missing`；任务书/纯 assistant 自述标 `task_brief` 排除 | 仅 assistant 解释的候选被拒；本轮“我为审查人设定红线”类文本不再仅靠证据数挡住 |
| 卡总预算 | 增加 `CARD_MAX_CHARS`（建议 2000），超限按 `openLoops → selfHistory → human → relationship → autobiography` 丢块并 warning；红线永不丢 | 极端 12+12+12 行输入 ≤2000，红线 100% 保留 |
| `validTo`/`supersededBy` | 二选一：读侧过滤并在 merge 写 `meta.supersededBy`；或从 schema/保留键删除。不要保留半套状态机 | 过期/被取代条目不进卡；或字段彻底不存在 |
| 告警噪声/注释 | `emotion_label_sparse` 改 24h 或仅集合变化时发；修 `emotion.ts:723-726`、`sqlite.ts:4201` | 单 agent 每天 ≤1 条；注释与实现一致 |

## 6. 实施顺序、迁移与回滚

**合并顺序**：A1 → A2 → B1 → B2 → B3 → A3（Core 与插件同步）→ C。

1. **PR1（A1）**：只改 card-service + 测试；无 schema；可单独发。
2. **PR2（A2）**：只改 gateway 读侧 + 测试；无 schema。
3. **PR3（B1）**：worker cap + 两 tick 测试；先观察判侧成本。
4. **PR4（B2）**：traits/drift + 迁移脚本 + 备份；发版前通告卡值变化。
5. **PR5（B3）**：去重/唯一索引/写重试；迁移前备份 `soul_snapshots`。
6. **PR6（A3）**：Core 返回/日志契约 + 插件 SHA-256 + stats 配对；双端发版，旧行 legacy。
7. **PR7（C）**：按表逐项，小步合。

**回滚**

- A1/A2/B1：直接 revert；B1 回滚后事件恢复旧行为（但不会破坏已有行）。
- B2：迁移前备份表；回滚代码 + 从备份恢复 axis/seed。
- B3：唯一索引可 drop；去重删除的行只能从备份恢复，故必须先备份。
- A3：stats 兼容 legacy；插件回滚后新行仍可被旧逻辑按 chars 读取。

## 7. 验收清单

| 项 | 通过条件 |
|---|---|
| 身份 | `GET /v3/soul/card`（agt-bbr29z58s2）不再出现“何晨”；新快照 `nameSource != "observed"` |
| 特质一致性 | 同一 agent 的卡激活度 == `/v3/soul/trait-state` 的 `nowWeight`；`source` 明确 |
| 注入 | 真实 session `section-read` 64 位 hash == Core `hash`；`charMismatch=0`（legacy 除外）；`sessionsWithProof>0` |
| 事件 | 连续两 tick 后同 session episodes >5；12:38 后 correction/complaint 出现；无重复 id |
| 种子 | 所有 `soul_trait_state` L1 ≤ 选定上限；首次 drift 激活度跳变 ≤5 个百分点 |
| 快照 | `GROUP BY agent,version HAVING count(*)>1` 为空；唯一索引存在 |
| 门 | `node scripts/typecheck-gate.mjs` 不低于基线；`npx vitest run` 全绿；plugin `npm test` 全绿 |

## 8. 待决策

1. 观察名是**彻底停用**，还是保留严格抽取器？
2. `TRAIT_L1_MAX` 维持 0.5，还是调到 2.0 并统一种子/漂移？
3. 心境是先用 watermark 近似，还是一次性上 `soul_mood_consumed` 幂等表？

## 9. 证据索引

- 卡：`GET /v3/soul/card?team=team-2k12lgb650&user=usr-2m7b1144d9&agent=agt-fa0u5mi7x4` → 200，667 chars，version 0，hash `e3460a3f...`，4 条红线逐字。
- 注入统计：`GET /v3/soul/injection/stats?team=team-2k12lgb650&agent=agt-bbr29z58s2&hours=24` → rows 3，matched 2，charMismatch 2，serverRenderOnly 110。
- 事件：`soul_episodes` 5 行，同一 session，09:22:45–12:38:21Z；L0 该 session user 44/assistant 49。
- 账本：15:24Z 233 行 = reject 203 / alert 11 / cadence 10 / arbitrate 7 / drift 2；admit/update/freeze/merge 0。
- 特质：`agt-3i8k22f496` state=seed=[0.5,0.3,0.6,0.2,0.1,0.4]，L1=2.1。
- 快照重复：`agt-dofal7hgfe` v1 06:42:49.919/.087；v2 12:53:45.402/.514。
- 门日志：`.tmp-review/typecheck.log`、`core-vitest.log`、`panel-tsc.log`、`panel-vitest.log`、`panel-build.log`、`plugin-vitest.log`、`plugin-build.log`。

## 10. 本轮未采集

- 真实会话注入后的系统提示词实际字节（无真实 section-read，且 hash 不同源）。
- DSH 宿主侧拼装后的截断/预算行为。
- 生产 provider 的 model/prompt_version（drift 账本为 null）。
- 真实长周期 |Δ|>0.05 与 L1 触顶样本。
- 首次 drift 后 `agt-3i8k22f496` 的实际激活度变化（需等下一 tick，未重启/未造数据）。
- 情绪标签有实例后的 gate 行为（当前 0 行）。
