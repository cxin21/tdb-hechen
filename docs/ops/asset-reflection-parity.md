# task-78 判定：AssetReflectionInjector 在 DSH 的适用性

结论：**可等价接入**（触发语义必须重新定义，不能 1:1 搬 URL marker）。不做会少一个「自动、格式固定、可比」的逐工具自评产物，不是少一个能力。

## 1 它在 proxy 里到底是什么（读码，非转述）
- 挂点/顺序/缓存：`MemoryProxy/src/injection/injectors/asset-reflection-injector.ts:74-78`（point=`system.suffix`、priority=`HOOK_PRIORITY.CUSTOM`=1000 见 `src/injection/types.ts:354`、cacheStrategy=none）。
- 产出文本：`asset-reflection-injector.ts:41-64` `renderAssetReflectionBlock(tags)`——固定格式【资产反思】+ 每工具一行「是否起作用」，没调过的不列，本轮没调任何工具也要输出固定一行；空 tag 返回空串。
- 触发是**双闸门**：① 配置 `injection.assetReflection.markerOptIn`（缺省 true，`MemoryProxy/src/config.ts:83-86`，解析 `:532-537`）；② 请求 URL 带 `/analyse` 段（`execute` 的早退见 `asset-reflection-injector.ts:82-96`，判定 `src/routes/whitelist.ts:234-238`，正则在 `:218`，要求形如 `/{agent}/{spaceId}/analyse/...`）。关掉时顶部 gate 对带 marker 的请求直接 404（`src/server.ts:66-78`），路由注册在 `:224-240`。
- requestPath 从哪来：`src/injection/types.ts:127-131` 由 `src/handler.ts:1425` / `src/anthropicHandler.ts:1239` 透传。
- tag 集合怎么来：`src/injection/index.ts:481-505`——按 registry 里**实际注册**的 skill / tdai-memory / knowledge 注入器派生；一个都没注册则恒不 emit（`asset-reflection-injector.ts:83-86` 是防御性空返回）。
- 产品定位（官方文档）：`INSTALL_CN.md:345-360`——「把评测集 / 一次性 curl / 某个 Team 的 staging CC 会话导到 `/analyse` URL 上」，并明说「特意做成可选，不建议对线上真实流量默认打开」。

## 2 它真的在被用吗（可核的只有这些）
- **proxy 日志给不出答案**：`MemoryProxy/logs/*.jsonl` 共 25304 行，字段固定为 timestamp/event/modelId/keyId/sessionKey/turnSeq/usage/...，**不含请求路径** ⇒ `/analyse` 命中数无法从日志统计，本项**未验证**（不能写成「从没用过」）。
- 全仓无任何调用方：排除 `MemoryProxy/src` 后 grep `analyse/v1`、`/analyse/` 在脚本/文档示例/配置中 0 命中；`PROXY_DEBUG_ASSET_REFLECTION` 也没出现在任何 systemd/service/部署脚本里。
- 它自己**没有单测**：`grep 'assetReflection|markerOptIn'` 在 MemoryProxy 的 test/spec 文件里 0 命中。
- git 历史只有 initial import + 一次 format（`d32930c` / `74ae047`），无迭代修复。
⇒ 判定：在架、可触发，但**没有任何被行使的正向证据**；「在位」不等于「在用」。

## 3 DSH 侧触发点逐项核查
| 候选触发面 | DSH 是否存在 | 语义贴合度 |
|---|---|---|
| URL 段 marker | 不存在（插件跑在进程内，无 HTTP 请求层） | 不可搬 |
| `system.suffix` | **有等价**：`ctx.systemPrompt.section({ order, text })`，且 `text` 可为函数（head pack 已用 `text: () => headPack.current()`，`dsh-plugin/src/index.ts:614-619`）；插件已有在 `DEPLOYMENT_PERSONA_SUFFIX` 之后插段的先例（`:599-605`） | 高（这正是反思要求该待的位置） |
| 每轮尾追加 user 消息 | 有：`agent/pre-step` 追加（`dsh-plugin/src/volatile.ts:203-206`） | 中——会进会话历史、会被写回，比 system 段更脏 |
| 当轮用户文本 token | 有：pre-step 已能读当轮 messages 并抽取文本（`volatile.ts:206-215`） | **高**（可做 per-turn opt-in） |
| 会话标题 / session/title | 标题由模型生成、非用户传入 | 不适合做 opt-in |
| `tool/call` / pre-execute | 宿主有，插件未用（`docs/ops/proxy-parity-matrix.md:12`） | 与「回答末尾自评」语义不符 |

## 4 接入方案（判定的落地部分）
挂点：`systemPrompt.section`，name `tdb-agemem:asset-reflection`，order = head pack 之后，`text: () => revoked(turn) ? '' : block`；触发状态在 `agent/pre-step` 里按当轮用户文本判定后写入 turn-scoped 集合（复用 volatile 的 `injected` map 形态，天然去重，`volatile.ts:172-186`）。
触发设计（二选一）：A. 用户文本出现独立 token `/analyse`（最贴 proxy：调用方显式 opt-in、零配置、per-turn）；B. 配置项常开 `injection.assetReflection.enabled=true`（只适合一次性 eval 会话）。
实现要点：
1. **文案必须重写**：proxy 的 `<skill_tools>/<tdai_memory_tools>/<knowledge_tools>` 在 DSH 名字不对应——DSH 实际资产 = 宿主 `skill` 工具（宿主提供）+ 插件 `memory_recall`（注册点 `dsh-plugin/src/index.ts:1023`）；knowledge 面等 task-76。tag 集合应从「本插件实际注册 + 宿主必有 skills」派生，空集合不 emit（对齐 `injection/index.ts:496-505`）。
2. **新增素材污染闸（proxy 没有的问题）**：DSH 会把 assistant 文本写回 L0（`dsh-plugin/src/writeback.ts:402-418` assistantText），反思段会变成记忆内容。必须在写回侧剥离该段（按 `【资产反思】` 起止裁剪），否则等于让模型自评污染长期记忆。
3. **预算**：块体约 700-900 字符，进 system prompt 即破 KV 前缀（proxy 同为 cacheStrategy=none）；只在触发轮出现，代价可接受，但要进预算表。
4. **观测**：照搬 `PROXY_DEBUG_ASSET_REFLECTION` 的 debug 行（`asset-reflection-injector.ts:94-96`），另加一条 outbox 事件，便于事后统计「触发了几次、产出了几条反思」。
5. 建议同步改 `docs/ops/proxy-parity-matrix.md:29` 的 #11 行为「可等价接入（task-79）」，并删掉 `:49` 的未证实项 1。
代价：一个 injector 级小改动（约 100-150 行 + 8-10 用例）+ 文案定稿要用户过一遍。

## 5 需要拍板的两问
1. 触发选 A（`/analyse` token，推荐）还是 B（配置常开）？
2. 反思段是否从 L0 写回中剥离（推荐剥离）？

## 6 与 task-67 P2 的关系
task-67 的 P2（`writeback.ts:554` 缓冲误删、`steering/message` 未监听）都在 dsh-plugin 写回路径，与 task-79 同包但不同关注点——**不并入本票**，建议随 task-79 之后独立开票；本票自带的一条 DSH 侧风险是「反思段污染 L0」，已写进 §4 要点 2。
