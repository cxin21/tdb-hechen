# 全栈实测 · 读面 / 注入面（task-54）

生成时间：2026-11-01T00:52+08:00　探针：`scratch/probe-read/`（`probe-all.mjs`、`probe-all-2.mjs`、`probe-all-3.mjs`、`probe-all-4.mjs`、`probe-layers.mjs`、`probe-nohit-skills.mjs`、`probe-soul.mjs`），原始响应落 `scratch/probe-read/out/*.json`。
只读审计：未改产品代码、未 commit、未动 desktop profile。

## 0. 口径与环境

| 项 | 值 | 证据 |
|---|---|---|
| 服务 | core 8420（pid 28876）、knowledge 8421（pid 31116）；**tdai-proxy(8096)、tdai-panel(8123) 未运行**（启动计划里有，今天没起） | `netstat -ano` 实测；`etc/tdb-services.common.ps1:90-93` 启动计划 |
| 身份 | service=default / team=team-2k12lgb650 / agent=agt-2m7buribzz / user=usr-2m7b1144d9 | `MemoryCore/tdai-gateway.yaml:24` + desktop profile `cordis.patch.yml:226-232` |
| 生产插件 | desktop profile 安装副本 `~/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist` 与 `dsh-plugin/dist` **逐文件 sha256 全同**（index/recall-source/head-pack/config/memory-client 5/5） | `sha256sum` 对比 |
| 生产配置 | profile 只给 `server` 段，**headPack / volatile 全走代码缺省**（maxChars 8000、includeScenarioIndex true、maxScenarioEntries 20、volatile maxChars 1200、recallMaxResults 3、timeoutMs 3000、recallTimeoutMs 2500） | `dsh-plugin/src/config.ts:240-265` |
| 底配 | 运行面底配来自 `D:/TDB/data/config-override.json`（llm=MiniMax-M3.1-Flash、rerank local enabled、importancePenalty 0.3）；`config-override.json` 优先于 yaml | `MemoryCore/src/gateway/config.ts`（override > yaml）+ 实读 override |
| LLM 429 | **本轮探针未遇 429**：queryExpansion 实测 expand 166–206ms 成功；本轮全部结论不依赖生成式调用 | probe 各轮 `meta.perfMs.expand` |

## 1. 六项矩阵

| # | 项 | 结论 | 关键读数 | 证据 |
|---|---|---|---|---|
| 1 | 灵魂注入 | **DSH 链路 0 注入**（不是弱、是整段被丢） | `/v3/recall` 的 `<soul-identity>` 3303 字符、`<soul-feeling>` 36 字符；插件只保留 `<relevant-memories>` 里 `- [` 行；head pack 的 persona（`/v3/core/read` 10003）**不含** soul 段 | `dsh-plugin/src/recall-source.ts:172-176`（recallBlockText → memoryLines/renderMemoryBlock）；`probe-soul.mjs` 实测 `soulHeadInPersona=false`、`soulFullInPersona=false` |
| 2 | 分层召回三方 | 三条路径返回**不同集合**，不可互相代表 | /v3/recall(k=10) block 7013 字符 / 12 条（结论层 8、经验层 6 计数口径见 meta）；/v3/atomic/search(limit=10) 10 条（work_fact 为主，无结论层标签）；插件 1200 预算投影 5 条/1019 字符 | `out/layers.json`、`out/probe-all-3.json` |
| 3 | maxResults 曲线 | k=2 与 k=3 **逐位相同**；注入面 k=10 只多 1 条 | P1：k=1 注入 1 条/260；k=2 = k=3 → 4 条/967；k=5 → 5 条/1126；k=10 → 1200 预算 5 条/1019、2000 预算 8 条/1737 | `probe-all-3.mjs` volatile 表 |
| 4 | wiki 召回 | **8421 有真命中，DSH 零接线** | `/v3/wiki/list` 3 个 wiki（scm-standards 50 页 ready、scm-recipes 686 页 ready、wiki-sm8cdo1j **status=failed**）；ready 两个 `/v3/wiki/search` 均 5 条命中（含 title/snippet/score/hop）；failed 的返回 0 条 | `out/probe-all-3.json` wiki.searches；`dsh-plugin/src` grep `wiki|knowledge` **零命中** |
| 5 | 技能注入 | 表里 2052 行，但**不是 2052 个技能**；DSH 侧 0 消费 | `skills` 表 2052 行全部 `status=active`，`is_head=1` 仅 **284**（本 agent 275）；`/v3/skill/list` total=275；`/v3/skill/listing` 默认 topK=20 → 8004 字符被 8000 预算截断（`... [truncated]`） | 直查 `D:/TDB/data/vectors.db`（readOnly）；`MemoryCore/src/gateway/skill-handlers.ts:671-737`（handleListing）；消费者仅 `MemoryProxy/src/injection/injectors/skill-injector.ts`（未运行）与 MemoryPanel |
| 6 | 场景索引 | 走 head pack，**但注入两份** | `/v3/scenario/ls` 14 条 7367B；生产等价组装 4939 字符，含 **14 行带热度**（压缩后 persona 内）+ **14 行裸路径**（composeHeadPack 追加）= 334 字符 / 6.8% 重复 | `out/headpack-prod.txt`；`dsh-plugin/dist/index.js:59`（SCENARIO_HEADER）、`:81-100`（composeHeadPack）、`:339-345`（生产调用点） |
| 7 | 读面边界 | 四态全部实测，两处越权/噪声 | 空 query → 400 `query (non-empty string) required`；无相关 query → **仍注入 9 条**；4000 汉字 query → core 504（实测 5002ms）；换 agentId → 0 命中（隔离生效）；**换 team 头 wiki 仍 200 有结果** | `out/probe-all-4.json`；`MemoryCore/src/gateway/v2-router.ts:1885-1925`；`MemoryKnowledge/src/routes/wiki.ts:712-725` |

## 2. 关键发现（按严重度）

### F1 灵魂段在 DSH 侧被整段丢弃（高）
`/v3/recall` 返回 `<soul-identity>` 与 `<soul-feeling>`，插件 `recallBlockText` 只取 `<relevant-memories>` 内以 `- [` 开头的行，其余全部丢弃（`dsh-plugin/src/recall-source.ts:172-176`）。head pack 注入的 persona 来自 `/v3/core/read`（10003 字符），实测**不含** soul 段。⇒ 「灵魂注入」在 DSH 会话里实际只有 persona 的叙事画像，人格"此刻状态/情绪"从未进入提示词。

三 query 实测（`probe-soul-meta.mjs`，maxResults=5，四头齐备）：soul-identity **3343 / 3388 / 3346** 字符（随 query 与召回内容浮动，不是静态串）；soul-feeling **40 / 40 / 40** 字符（另一次 36 字符——随 mood 微调，正文恒定形态 `## 当下的状态 / 近期基调：偏积极。…`）；`data.meta` = `{conclusionCount:3, experienceCount:2, sessionReused:false, layered:true, soulVersion:"sv-c80c3e5b-pm811c9dc5", mood:"positive", perfMs:{total:2261, scene:1, expand:234, l2:1, l1:2229, soul:31}}`。⇒ soulVersion 稳定、mood 可读，但都在 `data.meta`，插件侧不消费（`recall-source.ts` 只读 `data.block`）。
### F2 head pack 场景索引重复注入（中）
`compressHeadPack(core.content)` 后 persona 仍保留 `## 🗺️ Scene Navigation (Scene Index)` 的 14 行（带"热度/更新"，前缀 `scene_blocks/`）；`composeHeadPack` 又按 `/v3/scenario/ls` 追加 `## 长期记忆 · 场景索引（L2）` + 14 行裸路径（`dsh-plugin/dist/index.js:59,92`）。同一批场景以两种路径写法各出现一次，浪费 334 字符（占 4939 的 6.8%）并制造两套路径口径。

### F3 wiki 有真命中但 DSH 未接线（高）
8421 侧 `scm-standards`/`scm-recipes` 对业务 query 均返回 5 条带 score/hop 的命中（`probe-all-3.json`），说明索引与检索可用；但 `dsh-plugin/src` 对 `wiki|knowledge` 零引用，插件只连 8420。⇒ task-46「DSH 链路 0 命中」的根因不是索引空，而是**没有调用方**；同时第三个 wiki `wiki-sm8cdo1j` `status=failed`，对它检索恒 0 命中（静默）。

### F4 wiki 读面无 team 隔离，8421 鉴权整体未启用（高，安全）
`/v3/wiki/search` 只用 `wikiService.getById(serviceId, wikiId)` 取行，**不校验 team_id**（`MemoryKnowledge/src/routes/wiki.ts:722-725`，随后只判 `wikiCanServeReads`）；实测把 `x-tdai-team-id` 换成 `team-other-zzz` 仍 200 且返回 scm-recipes 命中。

更深一层：8421 当前**完全没有鉴权**。`KNOWLEDGE_SERVICE_KEY` 未配置 ⇒ 中间件按设计整体放行（`MemoryKnowledge/src/middleware/auth.ts:1-9` 头注释），实测 `/v3/internal/llm-binding/status`（本应受保护）无 Bearer 也 200、`/v3/wiki/create` 无 Bearer 走到参数校验 400（即已过鉴权）。⇒ 本机知识库的读**写**面（wiki raw/page write、admin/settings、llm-binding/set）对任何能连 8421 的进程开放；即使日后配上 key，`/wiki/search` 仍在只读白名单（`auth.ts:47-54`，`/wiki/search` 在 :51），team 隔离缺口依旧。
### F5 技能行数被当成技能数（中）
`skills` 表 2052 行 = 版本行（`is_head=1` 仅 284，本 agent 275），票面/报告若引用 2052 会把规模放大 7 倍。读取面：`/v3/skill/list` 与 `/v3/skill/listing` 都由 core 提供（`skill-handlers.ts:671-737`），但 `listing` 缺省 topK=20 + 8000 字符预算，275 个技能只能"搜索式"到达（mode=search），全量 listing 不可行。DSH 插件只有写入侧（`skillConversationAdd`、`skillFeed`，`dsh-plugin/src/config.ts:232,269`），**读取/注入侧零接线**；真实注入方是 MemoryProxy 的 skill-injector（`MemoryProxy/src/injection/injectors/skill-injector.ts:207-300`），本机未运行。

### F6 k=10 在生产注入面几乎无收益（高，直接冲 WP1b 论证）
生产 volatile 用 `recallMaxResults=3`（`config.ts:259`，profile 未覆盖）。实测（P1 采购 query）：k=2 与 k=3 的 recall 返回**逐位相同**（4 条 / rm 1309 / block 4751），注入面 4 条 / 967 字符；k=10 在 1200 预算下 5 条 / 1019（+1 条、+52 字符），2000 预算才 8 条 / 1737。⇒ "k=5→10"（§24 的 60/90 vs 56/90）是在 eval harness（无 1200 字符裁剪、无 360/条裁剪）上测的；**在 DSH 真实注入面，k=10 相对 k=3 的增量是 +1 条/+52 字符**，且生产从不发 k=10。

### F7 无相关也必注入（中）
junk query `zzqx vvkk 8899 无此内容`：`/v3/atomic/search` top1 score **0.176**（低于 yaml 的 `scoreThreshold: 0.3`），`/v3/recall` 却返回 9 条（结论层 7）并注入 578 字符。原因：本库走 native-hybrid 路，门槛是 `nativeMinRRF=0.016`（`MemoryCore/src/core/tools/memory-search.ts:1146-1149`），0.3 余弦门槛对 native 路形同虚设（yaml 注释自认）。⇒ 「无命中」这个态在生产几乎不可达，检索噪声会稳定进提示词。

### F8 超时三档，生产看不到 core 的 504（中）
core `v3Recall.timeoutMs` 5000 → 实测 504 `/v3/recall timed out after 5000ms`（5002ms）；插件 `recallTimeoutMs=2500`（`config.ts:126-141`）会先 AbortController 取消，volatile 总预算 3000（`:254`）。⇒ 长 query/冷启动在生产表现为"静默回落 atomic/search"，而不是报错；观测上不可区分"慢"与"空"。

### F9 四头隔离与鉴权的强制面（低，按设计）
缺 `x-tdai-agent-id` / `x-tdai-team-id` → 422（`/v3 requires strict isolation: missing agent_id…`）；缺 Bearer → 401 `Unauthorized: missing Bearer token`。8420 侧强制，8421 侧不强制（见 F4）。

## 3. 复测脚本与产物

| 产物 | 内容 |
|---|---|
| `out/probe-all.json` | 第一轮：soul 段长度、maxResults 曲线、边界四态 |
| `out/probe-all-3.json` | 生产等价注入投影（k=1/2/3/5/10 × 3 query）、head pack、wiki、mood |
| `out/probe-all-4.json` | tools/call、team/service 越权、recall↔atomic 重叠、长 query 504 |
| `out/layers.json` | 三 query 的分层标签分布、atomic top score、注入文本 |
| `out/injected-real-1200.txt` | 生产 1200 预算下的真实注入文本（可直接进 prompt 对拍） |
| `out/headpack-prod.txt` | 生产等价 head pack 全文（4939 字符，含重复场景索引） |

## 4. 未验证 / 限制

1. **未在真实会话里取到最终提示词**：head pack / volatile 的组装是"按生产调用点等价复现"（`dist/index.js:339-345` + `recall-source.js`），没有从宿主 session 事件里抠出注入块做逐字对拍。
2. **MemoryProxy 未运行**：技能注入、proxy 侧 recall hook 的运行时行为未测，只做了代码取证。
3. `/v3/tools/call` 的正确参数形状仍未打通（两次 400：`tool_name is required`、`params is required (object)`），wiki 工具面对 Agent 的可用性未验证。
4. mood 只测了 tier/sampleCount（positive / 20），未验证 mood→soul-feeling 文案的生成链路。
5. 8421 第三个 wiki `status=failed` 的原因（sync_error 为空）未查。
6. k 曲线只跑了 3 个 query，P1 之外的两条在 k≥3 后基本持平，样本不足以给"全开配置下 k=10 是否仍成立"下结论——但足以否定"k=10 在注入面带来 4 条额外记忆"的预期。