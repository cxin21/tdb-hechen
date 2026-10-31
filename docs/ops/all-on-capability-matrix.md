# 全开档能力矩阵（2026-11-01，Lead 亲测）

> 口径来源：用户 m02708「`<skill_tools>` 的 curl 配方在 DSH 无意义…等价物是原生工具 skill_search / skill_view / skill_files_read，必须真实测试 TDB 的技能有注入 dsh，且 dsh 可用，当 allowLlmWrite 开启时需要真实可用；soul 两个注入器缺省就是关的，必须全部开启做真实测试，包括其他配置项」+ m02467（不许降级删减）。
> 本文只记**实测读数与契约**；票在 team task board。

## §0 三个决定性发现（先看这三条）

### 0.1 proxy 自带的 6 个 skill 写工具，按它自己的 curl 配方调用**全部失败**
实测（真 8420，真身份，真 skill）：`/v3/skill/update`、`/v3/skill/patch`、`/v3/skill/delete`、`/v3/skill/files/write`、`/v3/skill/files/remove` 五个写口全部要求 `expected_version: z.number().int().min(1)`（`MemoryCore/src/gateway/skill-schemas.ts:101/:108/:117/:182/:189`），而 `MemoryProxy/src/injection/injectors/skill-tools-injector.ts:108-144` 渲染的 body 里**没有这个字段**。现象：HTTP 200 + `code=40001` + `expected_version: Invalid input: expected number, received undefined`。
⇒ 如果照抄配方，`allowLlmWrite=true` 是个**假的可用开关**。DSH 原生工具必须做 read-modify-write：`skill_view` 拿 `version` → 写口带 `expected_version`。
带版本后全链实测通过：create(v1) → update(v2) → stale 用 v1 → `code=40901 SKILL_VERSION_STALE`（正确拒） → patch(v3) → files/write(v4) → files/read 回 `"echo hi\\n"` → files/remove(v5) → delete(archived) → get 40401。

### 0.2 核心 skill API 是「HTTP 200 + body.code」双轨，且身份要 body
- `/v3/skill/search`：200，**86ms**，10 条，score = **-bm25**（越大越相关，首条 12.88），snippet ≈ 120 字符。三轴可只走 header。
- `/v3/skill/get-by-name`：**只走 header 会 40001**（`team_id/agent_id: expected string, received undefined`），schema `skill-schemas.ts:143-152` 的 team/agent 必填且无 header 合并 ⇒ **body 必须带三轴**。返回 32271 字节，其中 `content` 30318 字符（真实 SKILL.md 全文）。
- `/v3/skill/listing`：200，49-64ms，`data = {mode, listing, hits}`，`listing` 是**已渲染好的字符串**（char_budget 6000 → 6004 字符；64000 → 9680 字符），开头就是 `<available_skills>`；`hits` 固定 20 条 `{skill_id, version, name}`。⇒ head pack 的技能段**不需要自己拼**，直接用 core 渲染好的 listing 字符串，天然与 proxy 的 `<available_skills>` parity。
- `/v3/skill/files/read`：200，`{path, content, encoding, size_bytes, mime_type, version}`，utf-8 与 base64 双编码。

### 0.3 `<core_memory>` 稳定块在 DSH 侧完全没有注入面（task-77 对照结论，**2026-11-01 二次核正**）
**更正**：本段初稿写「源 = `/v3/core/read` 10003 字符」不够准确。proxy 的真实取数是 `POST /v3/core-memory/read`（`MemoryProxy/src/tdai/client.ts:458-482` 的 `listCoreMemories`，按租户三元组、proxy 侧 60s TTL，`tdai-profile-memory-injector.ts:277` 调用、`:137-153` 渲染成 `<core_memory>` 里的若干 `<slot>`）。活体实测（真身份，2026-11-01）：
- `body {}` → 200/70ms，`slots` = **3 个**：`identity` 774 字符、`self_identity` 869、`strict_rule` 1471（合计 3114）；`values` = **25 条**（`{value_id,label,weight,valence,origin,node_type,attrs_json}`）。
- `body {"format":"narrative"}` → 200/7ms（缓存热），`slots` = **2 个**：`identity_narrative` 1562、`strict_rule` 1471（合计 3033）——**这是 proxy 生产口径**（`tdai-profile-memory-injector.ts:277` 显式传 narrative，把 identity+self_identity 折叠为叙事槽，禁双份实现）。
- `/v3/core/read`（另一个端点）返回 `data.content` 10003 字符的档案全文，**不是** proxy 的 core_memory 源，勿混用。

结论不变：插件 `src` 对 core_memory **零命中** ⇒ 身份锚与红线在 DSH 里丢失；soul redline 近端注入器的数据源就是同一份 `strict_rule`（`tdai-soul-redline-event-injector.ts:113-115`），必须与 core_memory 段共用同一次 fetch。

## §1 能力 × 现状 × 全开档

| # | proxy 能力 | DSH 现状 | 全开档做法 | 真实可用性证据 |
|---|---|---|---|---|
| 1 | `<available_skills>` 目录 | 无 | head pack 段直接用 `/v3/skill/listing` 的 `listing` 字符串（预算内截断留闭合标签） | listing 6004/9680 字符实测 |
| 2 | skill_search | 无 | 原生工具 → `/v3/skill/search`，回 top_k 条 name/id/score/snippet | 86ms/10 条/score 12.88 |
| 3 | skill_view | 无 | 原生工具 → `/v3/skill/get-by-name`（body 带三轴），返回 content + manifest + version | 32271 字节/content 30318 |
| 4 | skill_files_read | 无 | 原生工具 → `/v3/skill/files/read` | `echo hi` 原样取回 |
| 5 | skill_extract | 无 | 原生工具 → `/v3/skill/extract`（复用 buffer） | 端点存在（`skill-handlers.ts:1153`），待真跑 |
| 6-11 | 6 个写工具 | 无 | 原生工具 + `expected_version` RMW；`skill.allowLlmWrite` 缺省 false（与 proxy 同档），开时全链真可用 | create→update→patch→files→delete 全过 |
| 12 | `<core_memory>` identity_narrative/strict_rule | 无（`dsh-plugin/src` 对 `core_memory` 零命中） | head pack 独立段，源 `POST /v3/core-memory/read {format:"narrative"}`（不是 `/v3/core/read`，两者职责不同，见下 12b） | 2 slots 3033 字符（1562+1471），热 7ms |
| 12b | `<l3_core_memory>`（persona 全文，proxy 侧 UTF-16 截 6000） | **已覆盖**（结构压缩，非硬截） | head pack persona 段：叙述逐字 + 每场景一行，不触发截断 | 10003 → 4565 字符（`dsh-plugin/src/head-pack.ts:36`）；截断口径不等价，见 `docs/ops/l2l3-segment-parity.md` §5 |
| 12c | `<l2_scene_index>`（path + summary ≤200，proxy 侧 `l2Limit: 3`） | **部分**：persona 尾部一行/场景（带热度+日期、无 summary），端点段被去重成空 | 剥 persona 尾部 + `/v3/scenario/ls` 独占渲染，行格式 `- scene_blocks/<path>（更新 …）— <summary ≤120>`（补前缀以保住 verify 锚） | 端点 14 条、summary 141–736 字符/条；去重实测 kept 0；见 parity 文档 §3/§4。**对齐票 = task-96**（端点独占 + 剥 persona 尾部 + 保 `- scene_blocks` 锚）；heat 缺口已定档 A（接受丢热度，与 proxy 同档） |
| 13 | soul redline（动作点近端） | 无 | 挂 `tool/call`，`soul.redline.mode="action_proximate"`；cadence every_action_point + dedup；数据源 = core_memory 的 `strict_rule` 槽（1471 字符，实测） | 需 strict_rule 非空，待真跑 |
| 14 | soul reanchor（漂移再锚） | 无 | 挂 `tool/call`，`soul.reanchor.enabled=true`，intervalTurns=20 | 待真跑 |
| 15 | current_feeling（当轮**价值命中**：用户问句命中 appraisal label + valence 方向） | **部分覆盖**：只覆盖情绪基调/状态，价值命中无对应 | 不移植算法：core 的 `auto-recall` 渲染 `<soul-feeling>` = `## 当下的状态` + 基调行（`MemoryCore/src/core/hooks/soul-assembler.ts:923-926`）+ 可选 state 行（`soul-state.ts:70-76`）；**方向锚清单行已于 2026-10-17 删除**（`:909-916` 注释）⇒ 两侧不是一回事，见 `docs/ops/l2l3-segment-parity.md` §6 | recall block 实含 `<soul-feeling>`（36–40 字符实测） |
| 15b | core_values（25 条 value + valence） | 无直接消费 | 不单独注入：proxy 只用它做 current_feeling 的命中匹配（`tdai-current-feeling-injector.ts:68`）；DSH 侧 `<soul-feeling>` 不含价值标签，要补得走 core_memory 的 `core_value` 槽 | 实测 25 条 `{value_id,label,weight,valence}` |
| 16 | profile 借入 ≤2 其他 agent | 无（数据空） | 按 `/v3/meta/agent-fixed-asset/list-with-detail` 拉；需 per-call identity | 跨 agent 绑定 0 条（今天无数据可注入） |
| 17 | wiki recall | 无 | 等 core `/v3/wiki/{list,search}` 转发后接 volatile | 8421 三库真实命中（task-64） |
| 18 | knowledge_tools | 无 | 三段式：资源清单 → `/tools/list` → `/tools/call`（不是两段式） | 待真跑 |
| 19 | asset reflection | 无 | `/analyse` 显式 token + 从 L0 剥离 | 待真跑 |

## §2 「能开的全开」清单（测试档 = 全开，缺省档按§3）

- headPack：`enabled`、`includeScenarioIndex`、`includeSkills=true`、`maxChars` 提到 20000（分段配额见 §4）
- volatile：`recall=true`、`soul.enabled=true`、`soul.includeFeeling=true`、`wiki.enabled=true`、`knowledgeRecall.enabled=true`
- tools：`recall=true`、`skill=true`（4 读全开）、`skill.allowLlmWrite` 测试档 true / 缺省档 false、`knowledge=true`
- soul：`redline.mode="action_proximate"`、`redline.enabled=true`、`redlineDedup.enabled=true`、`reanchor.enabled=true`、`intervalTurns=20`
- assetReflection：`enabled=true`、`triggerToken="/analyse"`
- 观测：`debug=true`（文件日志）
- 前置阻塞：recall 同步路径在本机不可用（P50 4260ms，见 **§7 E1–E3**）⇒ 全开档里 volatile/recall 相关项的读数只能在 core 恢复且 task-99 落地后复测

## §3 缺省档（= 生产最优档）暂定
技能读 4 项开、写 6 项关（`allowLlmWrite=false`，与 proxy 同龄）；soul redline `action_proximate` **开**（用户 m02708 明确要求不全关，且红线近端是抗稀释设计）；reanchor 开（intervalTurns=20，成本=每 20 轮一次槽读）；knowledge/wiki 待转发端点落地后开。
volatile 细项按**代码缺省**（`dsh-plugin/src/config.ts`）：`maxChars=1500`（`:318`）、`soul.maxChars=600`（`:323`）、`timeoutMs=3000`（`:328`）、`recallMaxResults=3`（`:330`）、`recallTimeoutMs=2500`（`:335`）。这些是「保持」不是「待定」，改动须先跑 bench 双臂（`docs/ops/recall-budget-measured.md` §5）。

## §4 预算（待 head pack 注入时机的实测读数定死）
分段上限：persona 余量 / sceneIndex ≤3000 / skills ≤8000（proxy 同款预算，listing 9680 字符须截断）/ knowledge ≤3000 / wiki ≤2000；溢出按 persona > sceneIndex > skills > knowledge > wiki 从低往高丢；每段独立 truncated 标记。总预算暂按 20000，若 head pack 按 refreshMs 重注则压回 12000 并让 skills 段「首轮全量 + 后续只命名」。

**volatile 是另一本账（不与 head pack 相加）**：`volatile.maxChars` 代码缺省 **1500**（`dsh-plugin/src/config.ts:318`）= 其中 `soul.maxChars` 600（`:323`）+1 分隔符 ⇒ **记忆预算 899**。装载容量按真实现算（单条成本 ≤361 = 块头 52 + 正文 ≤360 + 换行 1）：**800 与 899 完全相同（都只装 2 条，722 字符）**，故「把 1500 砍到 800」零收益；1500 全额（关 soul）时装 4 条。详见 `docs/ops/recall-budget-measured.md` §4。

## §5 复跑命令
```bash
node -e "const fs=require('fs');const t=fs.readFileSync('MemoryCore/tdai-gateway.yaml','utf8');const m=t.match(/^\\s*apiKey:\\s*[\"']?([0-9a-f]{32,})/m);fs.writeFileSync('scratch/lead/.k',m[1])"
TDB_CORE_API_KEY=$(cat scratch/lead/.k) node scratch/lead/probe-skill-api2.mjs   # 读面
TDB_CORE_API_KEY=$(cat scratch/lead/.k) node scratch/lead/probe-skill-write2.mjs # 写面全链（会建/删 probe-skill-tool-zt）
TDB_CORE_API_KEY=$(cat scratch/lead/.k) node scratch/lead/probe-core-read.mjs    # core_memory/mood/pending
rm -f scratch/lead/.k
```

## §6 副产物与清理
- probe 建的 `skl-FubTp5KDEQKe`（首轮缺版本留下的）与 `skl-3rqjv9RuQmbu`（全链测试）均已 `delete`（archived），`get` 复查 40401。
- 探针脚本：`scratch/lead/probe-skill-api2.mjs`、`probe-skill-write2.mjs`、`probe-core-read.mjs`、`probe-listing.mjs`。

## §7 已知环境阻塞（2026-11-01，实测 n=144）

| # | 事实 | 读数 | 出处 |
|---|---|---|---|
| E1 | recall 端到端延迟 | **P50 = 4260ms / P90 = 17348ms**（P95 25206 / max 31063 / mean 7457，n=144，01:00–01:59 生产日志） | `docs/ops/recall-budget-measured.md` §2 |
| E2 | 时间去哪了 | **l1 占 99.5%**（7422/7457ms），其中大头是远端 embedding RTT（缓存命中 282–315ms；实打 2607/3011/6738/9970/19274ms） | 同上 §3 |
| E3 | 服务端也在超时 | `v3Recall.timeoutMs=5000`（`MemoryCore/src/gateway/v2-router.ts:2156`），144 次里 **77 次 504（53.5%）** | 同上 §1.3 |

⇒ 结论（架构性，不是零件配置）：插件 `recallTimeoutMs=2500`（`dsh-plugin/src/config.ts:335`）只够覆盖 P10 左右，`volatile.timeoutMs=3000`（`:328`）连 P50 都装不下 ⇒ **同步注入拿不到不是调参能解决的**；把超时调大只会击穿整步预算。根治票 = **task-99**（core `/v3/recall` 预算内降级 + embedding 缓存），本矩阵只登记阻塞、不改产品。

