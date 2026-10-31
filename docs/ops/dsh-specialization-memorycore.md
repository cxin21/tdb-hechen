# MemoryCore 域 · DSH 特化盘点（task-46，只分析不改码）

## 0. 口径与证据来源
- 目标：MemoryCore/ 在「DSH 是唯一正式客户端」后的取舍。DSH 客户端 = dsh-plugin（@tdb/agemem-dsh，路径 `dsh-plugin/src`）。
- 证据：源码 grep（非 test、排 node_modules/dist/.local）；路由表源码；生产日志 `/d/TDB/data/logs/tdai-core-20261031-203348.out.log`（20:33:52→22:49 仍在写，34.9MB）；生产配置 `/d/TDB/data/config-override.json`、`/d/TDB/data/knowledge/config-override.json`；DB 只读盘点脚本 `scratch/probe-mc-tables.mjs`（node:sqlite readOnly）。
- 计数分「文件数（grep -rl）」与「出现次数」；无证据的断言标「未证实」。

## 1. 对外入口分层：/v3 /v2 /v1（**无 /dsh**）

| 层 | core 落点 | 端点量 | 仓内调用方 | 真实流量 | 结论 |
|---|---|---|---|---|---|
| /dsh | 无 | 0 | — | — | DSH 无特化面，走通用 /v3 |
| /v1 | `/v1/rerank` | 1 | 仅 MemoryKnowledge（生产未接） | 未见 | 可删（需确认） |
| /v2 | 18 条 deprecated CRUD + instance/destroy + offload | 20+ | 0 | 未见 | 整层可删（需确认） |
| /v3 | 数据面 37 + skill 17 + metadata 55 + knowledge/admin | ~120 | dsh-plugin 7 条 | 179 次 skill/add | 唯一真实面，需瘦身 |

**/dsh 不存在（实测）**：`grep -rn '"/dsh' MemoryCore/src` = 0 命中；dsh-plugin/src/index.ts:29 自注「the `/v3/dsh/*` endpoints in the spec have no …」。⇒ 当前「DSH 特化」全在插件侧（拼装/预算/注入），核心仍是通用多客户端后端。

**/v1 只有 rerank**：src/gateway/rerank-endpoint.ts:154 `if (method !== "POST" || pathname !== "/v1/rerank") return false;`，分派 src/gateway/server.ts:1272。调用方只有 MemoryKnowledge：src/rerank/client.ts:2、src/config.ts:122（`url` 空 = 关闭）、src/module.ts:195。生产 `/d/TDB/data/knowledge/config-override.json` 只含 llm/embedding，**无 rerank url ⇒ 生产未接**（未证实：不排除别处注入）。

**/v2 三类，客户端引用全 0**：
1. 18 条 v2 routeTable 键（team/user/agent/task 的 create·get·update·delete + pipeline/status），逐条标 `@deprecated 改用 /v3/meta/…`（src/gateway/v2-router.ts:561-575）。
2. `POST /v2/instance/destroy`（src/gateway/server.ts:1252）。
3. `/v2/offload/*`（src/offload_server/router.ts:35）。**src/gateway/server.ts:1519 无条件挂载**，不读 `config.offload.enabled`（src/config.ts:1515 缺省 false）⇒ 开关只关客户端/执行器，HTTP 面照旧在听。
   实测：四仓 grep `/v2/team|user|agent|task|pipeline|instance|offload` 每个 = 0 文件；offload 客户端（MemoryCore/dist/index.mjs:8467-8558）在 MemoryCore 外 0 引用。

**/v3 是唯一真实面**：白名单 37 条 subpath（src/gateway/v2-router.ts:197-244，白名单外 404）；管理面前缀 7 个（:633-642：skill/knowledge/chat-memory/memory-prompt/memory-generation-log/admin）；skill 17 条字面量（src/gateway/skill-handlers.ts）；metadata 55 条路由 / 31 个非 test 文件（src/metadata）。
**真实流量**：日志里唯一有请求级埋点的路由是 skill 面——`url=/v3/skill/conversation/add` **179 次**、`path=/v3/skill/conversation/add` 92 次（20:33→22:49）。同日志中 `/v3/recall` 27、`/v3/conversation/add` 4、`/v1/rerank` 10 次匹配**全是记忆正文**（:80062、:186679 为 L1 命中内容），不是请求。⇒ 今天唯一被真调的 HTTP 面是 skill 写入；其他路由无请求级埋点，真实调用量「未证实」。
**DSH 实际用的 7 条 + /health**：dsh-plugin/src/config.ts:197-203（core/read、atomic/search、scenario/ls、conversation/add、conversation/delete、skill/conversation/add、recall）。三轴 header 已在插件侧补齐（memory-client.ts:364-368），task-34 的 recall 422 P0-1 已闭环。

## 2. 非 DSH 集成面（谁在撑这些面）
| 面 | 体量（文件） | 落点 | 现役调用方 | 判据 |
|---|---|---|---|---|
| skill 写入 + 抽取 | src/core/skill 31 | src/gateway/skill-handlers.ts 17 端点 | MemoryProxy（日志 179 次） | 真在跑 |
| metadata 管理面 | src/metadata 31 | 55 路由 + 12 表 | MemoryProxy 10 文件 / MemoryPanel 14 文件 | 真在跑（Panel） |
| /v3/admin | 含上 | src/gateway 内 admin 前缀 | MemoryProxy 3 / Panel 9 / Knowledge 1 | Panel 配置页 |
| /v3/wiki · knowledge · chat-memory | src/gateway/knowledge-handlers.ts、chat-memory-handlers.ts | — | Knowledge 2 / Panel 4·3·2 | Knowledge 真在跑 |
| offload 栈 | offload 34 + offload_server 21 + offload-client 6 = 61 | /v2/offload/* 等 | **0** | 死（配置关 + 无客户端） |
| OpenClaw 宿主适配 | src/adapters/openclaw 3 | adapters/index.ts:14 再导出 | **0**（adapters/index 无人 import） | 死 |
| 云向量库 tcvdb | 33 | store-pool/factory | 0（生产 deployMode standalone，tdai-gateway.yaml:14） | 备用路径 |
| 其他客户端 | workbuddy 0 / claude-code 0 / hermes 仅枚举值（src/core/types.ts:249 hostType） / cursor 21 全为「时间游标」误匹配（src/core/conversation/l0-recorder.ts:89） | — | 0 | 无实现代码 |
| 非本机部署产物 | deploy/tencent-cloud 16 + global-images 11 + panel-knowledge-combined 6 + dockerhub 2 | — | 云端/镜像发布 | 与 DSH 桌面单机无关 |
| 观测四后端 | otel/clickhouse/kafka/langfuse 8 个 exporter/tracer | tdai-gateway.yaml:626-634 全 false | 0 | 死（开关关） |

今天真正在跑的客户端链（supervisor + proxy 日志实锤）：`tdai-core pid=24524` + `tdai-proxy pid=35184`（/d/TDB/data/logs/tdb-supervisor.log 20:33:48 那轮启动），proxy 监听 8096，启动行 `"injection":"skill,knowledge,tdai-memory"`、upstream=ark（/d/TDB/data/logs/tdai-proxy-20261031-203348.err.log 首屏）⇒ **179 次 skill/add 全部来自 MemoryProxy**；DSH 插件因宿主未重启尚未接流。即：今天的生产流量仍是「LLM 代理顺带注入」那条路。

## 3. core 自己调 LLM 的前提（DSH 特化最大的耦合）
- 生产真值（/d/TDB/data/config-override.json）：`llm = MiniMax-M3.1-Flash @ api.minimax.cn`、`embedding = doubao-embedding-vision @ ark（2048 维）`、`rerank.local.enabled=true`、`worthiness.extractionEnabled=true`。**core 自己持有模型密钥、自己发请求**。
- 生产 runner 入口：src/adapters/standalone/llm-runner.ts:22（Vercel AI SDK `generateText/streamText`）；装配 src/core/tdai-core.ts:804-851（L1 runner `enableTools:false`、L2/L3 `enableTools:true`），skill 抽取 runner src/core/tdai-core.ts:1018/:1075，valence runner src/gateway/server.ts:2234。
- 触发链（今天真在跑）：DSH/Proxy 写 skill buffer → core 内部 worker 抽取——日志 tag 计数 `[skill-conv-worker]` 107977 行、`[pipeline-worker]` 34781、`[extractor]` 30657。⇒ **LLM 成本记在 core，DSH 只是投递对话**。
- 若改由 DSH 发起抽取（core 不再自调 LLM）：改动面 = ①关 3 处 runner 注入（tdai-core.ts:804-851、:1018/:1075、server.ts:2234）②新增「外部提交抽取结果」写入口（现有 /v3/skill/extract 是 core 内部 direct-trigger，dsh-plugin 未调用）③丢掉 core/prompts 6 + core/scene 7 + core/persona 2 的 prompt 组装（约 15 文件迁移）。**存储层（L0–L3）不用动**。规模属「中」，不是重写。

## 4. 死码（无内部消费者，实测）
1. src/adapters/openclaw（3 文件）+ src/adapters/index.ts（仅 :14 再导出，全仓 0 import）。
2. src/offload（34 文件，入口 offload/index.ts:54，src 内 0 引用）+ src/offload-client（6，0 引用）+ src/integrations/observability（1）。
3. src/cli（2 文件，`openclaw memory-tdai seed` 命令，cli/commands/seed.ts:2）。
4. /v2 18 条 deprecated handler（v2-router.ts:561-575）+ `/v2/instance/destroy`（server.ts:1252）。
5. /v3/memory-generation-log 三端点（仓内 0 客户端引用；表 memory_generation_refs 8543 行无读取方）。
6. skill 向量路（skill_vec 表 0 行；yaml:618 `routing.mode: bm25`）。
7. `/v3/memory-prompt/*` 端点（gateway/memory-prompt-handlers.ts，四仓客户端 0 引用）——但底层 `memory_prompts` 在 sqlite.ts:6912-7097 有完整读写，删端点后代码仍留，故归 B 档。

## 5. 数据面（/d/TDB/data/vectors.db 370MB；metadata default 412KB）
| 表 | 行数 | 服务面 | 结论 |
|---|---|---|---|
| l0_conversations 13278 / l0_fts / l0_vec* | 13006 向量 | /v3/conversation/*（DSH 写） | 别删 |
| l1_records 3514 / l1_fts / l1_vec / l1_links 33352 / l1_archive 6504 | — | recall+search | 别删 |
| l1_fact_vec* 140 | — | fact 通道 | 别删 |
| core_memory 4 / core_values 49 / core_pending 564 | — | /v3/core-memory/*（Panel） | 需确认 |
| skills 2052 / skill_fts 284 / skill_vec **0** | — | skill 面 | 需确认（skill_vec 安全删） |
| memory_generation_refs 8543 | — | /v3/memory-generation-log（0 客户端） | 需确认 |
| **entity_users/teams/agents/tasks 0/0/0/0、entity_knowledge 1** | — | v2 CRUD 遗留 | 安全删 |
| memory_prompts / memory_prompt_settings / memory_prompt_setting_logs **0/0/0** | — | /v3/memory-prompt/*（0 客户端） | 需确认 |
| soul_state 2 / soul_snapshots 1247 / soul_promises 1 / events 2 / anchor_growth_state 18 / memory_audit 5 | — | soul+anchor 子系统 | 需确认 |
| metadata 库：meta_assets 290 / meta_agent_fixed_assets 289 / meta_agents 3 / meta_users 3 / meta_teams 1 / meta_user_keys 3 / meta_config_params 26；meta_tasks 0 / meta_participation_logs 0 / meta_asset_acl 0 | — | 管理面（Panel/Proxy 鉴权） | 需确认 |

## 6. 死配置
- tdai-gateway.yaml:626-634 观测四项全 false（代码 8 文件仍在）。
- tdai-gateway.yaml:14 `deployMode: standalone` / :15 `stateBackend: local` ⇒ redis 分支持久不执行（未证实：无启动日志证据，按配置推断）。
- `offload` 组在 yaml 中整段缺失，config.ts:1515 缺省 `enabled=false`；但 /v2/offload 仍无条件挂载（server.ts:1519）。
- `skill.routing.mode: bm25`（yaml:618）⇒ skill_vec 恒 0。
- `memory.*` 数百行（yaml:46-607）中与已废弃路径相关的子键未逐一核实（未证实）。

## 7. 三档结论
**A. 安全删（无现役入口，删除不改行为）**
1) /v2 整层：18 条 deprecated CRUD + `/v2/instance/destroy` + /v2/offload 挂载点。2) src/adapters/openclaw + src/adapters/index.ts。3) src/cli。4) src/offload + src/offload-client + src/integrations/observability（deploy/ 已核：仅 deploy/global-images/check-config-consistency.mjs:107 把 "offload." 当配置前缀，不引用二进制）。5) entity_* 四张空表（与 v2 同批）。

**B. 需确认（有真实数据/面板在用，删前要用户拍板）**
1) skill 面 17 端点 + skills/skill_fts（MemoryProxy 今天 179 次真写；若都被 DSH 的 skill/add 取代才算替代——**注意两者是同一入口**，Proxy 只是另一个投递方）。2) metadata 55 端点 + metadata 三库（Panel 全靠它；且是鉴权面 meta_user_keys）。3) /v3/wiki · knowledge · chat-memory（Knowledge/Panel）。4) /v3/core-memory/values|pending（Prompt 面板人工采纳流程，564 条 pending）。5) soul_* / anchor_growth_state。6) tcvdb 33 文件（云端部署候选）。7) 观测四后端代码。8) /v3/memory-generation-log 与 /v3/memory-prompt/* 端点（0 客户端，但 core 仍写 memory_generation_refs 8543 行、sqlite.ts:6912-7097 仍维护 memory_prompts）。

**C. 别删**
L0–L3 数据面 37 条白名单、embedding/recall/search、`/v3/skill/conversation/add`（DSH 唯一真实写入口，日志 179 次）、`/v3/conversation/add`、`/v3/core/read`、`/health`、l0/l1 各表。

## 8. 建议执行顺序（每步都能独立验证）
1. 删 /v2 整层（A-1）→ `cd MemoryCore && npx vitest run src/gateway`（现 27 files/291 tests）+ 隔离实例打 /v2/team/create 期望 404。
2. 删 adapters/openclaw + adapters/index.ts + cli（A-2/3）→ `node scripts/typecheck-gate.mjs`（基线 243/44，只降不升）。
3. 删 offload 栈（A-4）→ 先 `grep -rn 'offload' deploy/ bin/ package.json`，再删；验 /v2/offload/health 404。
4. 空表清理（A-5）→ 备份 vectors.db 后 DROP entity_*；验 v2 读路径 404。
5. B 档逐项等用户拍板；每项先出「谁在用」清单再动。
