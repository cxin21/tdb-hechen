# dsh 原生记忆插件：宿主 API 实测报告（阶段 A）

- 日期：2026-10-31
- 执行：teammate `dsh-plugin`
- 目的：为 `docs/specs/2026-10-31-dsh-native-memory-plugin-spec.md` 的扩展点假设做**最小实测**，只回答"能不能做、怎么接"，不重写规格。
- 结论：**可行**。四类扩展点（系统提示词段落、pre-step 改写、回合结束回写、工具注册）全部在 `dsh headless` 里跑通并留下证据；但 spec §3/§4 有 **5 条假设被证伪或需改写**（见 §3），落地设计必须按本报告口径调整。

---

## 1. 测试方法（可复现）

| 项 | 值 |
| --- | --- |
| 宿主 | `D:\DSH\resources\app.asar`（Electron 44.7.0 / Node 24.21.0），CLI `D:\DSH\resources\runtime\cli\bin\dsh.cmd` |
| 隔离 profile | `C:\Users\Administrator\.dsh\profiles\probe`，由 `dsh --profile probe --from-default-profile headless --dump-config` 创建 |
| probe 包 | 源码 `scratch/dsh-plugin-probe/pkg/`（包名 `tdb-agemem-probe`）；**必须复制**到 `~/.dsh/profiles/probe/node_modules/tdb-agemem-probe/` 才能解析 `@deepseek-ai/*` peer |
| patch 层 | `~/.dsh/profiles/probe/cordis.patch.yml`：`credentials` 启用 + `llm-pi-ai`（provider `scm` → `http://10.16.235.171:50003/v1`，模型 `scm-flash`）+ `agent-default-model` + `insert: tdb-agemem-probe`（相对路径按 patch 文件所在目录解析） |
| 运行命令 | `AGEMEM_PROBE_LOG=<abs> "D:/DSH/resources/runtime/cli/bin/dsh.cmd" --profile probe "<一句话任务>"` |
| 日志 | `scratch/dsh-plugin-probe/logs/probe{1,2,3}.jsonl`（JSONL，每行一条 `ev`） |
| 会话存档 | `~/.dsh/sessions/<cwd编码>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd 拼接；解析脚本 `scratch/dsh-plugin-probe/bin/read-session.cjs`、`scan-sessions.cjs`） |

三次 headless 运行（预算 3 次，已用尽）：

| # | 任务 | 结果 |
| --- | --- | --- |
| 1 | "用一句话说明你现在看到几条消息" | 失败：`format v4 message requires a producer-owned source kind`（注入消息用了 `source.kind='plugin'`）→ 反证 source 规则 |
| 2 | 修正 source kind 后重跑 | exit 0，模型同时复述 `AGEMEM-PROBE-SYSTEM-7F3A` 与 `AGEMEM-PROBE-TOKEN-9C1D` → 系统提示词段落 + pre-step 追加**都真的到达模型** |
| 3 | 修正工具 DSL 后"调用 probe_echo 工具一次" | exit 0，模型答"工具返回值为 echo=hello node=24.21.0 pid=19776" → 工具注册与执行**跑通** |

**没有重启正在运行的 GUI 宿主**，没有改 `~/.dsh/cordis.patch.yml`，没有改 web profile 的 `package.json`。

---

## 2. 实测 API 表

| API | 实测签名（逐字） | 证据行 | 与 spec 的差异 |
| --- | --- | --- | --- |
| 插件模块契约 | `export const name`、`export const inject = ['systemPrompt','tools']`、`export function apply(ctx, config)`；未声明的服务在访问时直接抛 `Error: cannot get property "tools" without inject` | `logs/probe1.jsonl`（load 阶段报错）、`logs/probe3.jsonl` `ev:"apply"` | spec 未写 inject 是硬约束；漏声明即崩，必须显式列出 |
| `ctx.systemPrompt.section` | `section({ name, order, interpolate:false, text })`，`text` 可以是**返回 string 的函数**（每次装配重算），返回 disposer（type `function`） | probe3：`{"ev":"section-registered","order":10300,"base":10200,"disposer":"function"}`；`session/message` seq 7 `src:"system-prompt" len:2819`；模型复述 `AGEMEM-PROBE-SYSTEM-7F3A` | 与 spec 一致，且证实"每轮可重算"可行 |
| 段落 order 基准 | `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') === 10200`；实测取 +100 = 10300，位置在 persona 之后 | `logs/probe3.jsonl` `section-registered` | 补充：`renderPrompt` 用 `"\n\n"` 拼接非空段落（`host/dsh-system-prompt/lib/index.js:117-119`） |
| `agent/pre-step` | waterfall：`async ({ agent, turn, step, signal, messages }, next) => decision`；`step` 是 **number**；`next()` 返回 `{kind:'enter', messages:[...claimed, context]}`，`decision.kind==='reject'` 须原样返回 | probe3 第一次 `{"ev":"fired","event":"agent/pre-step","keys":["messages","turn","step","signal","agent"],"messages":1}` → `pre-step-decision {"kind":"enter","messages":4}` | **每个 step 触发一次**，不是每轮一次；`messages` 只含"本 step 被 claim 的消息"（step2 实测 `messages:0`） |
| 尾部追加合法性 | `{...decision, messages:[...decision.messages, extra]}` 合法且前缀不变 | `pre-step-append {"before":4,"after":5,"prefixStable":true}`；模型看到内容（复述 TOKEN 标记） | spec §4"结构稳定只追加"成立，但"ephemeral"不成立（见下条） |
| 注入消息持久化 | 追加消息以 `user/message` 会话事件**落盘**：`seq 12 dataKeys:["id","role","source","content"]`，后续 step/turn 仍在历史里 | probe3 session log seq 12、seq 22（两个 step 各一条） | **证伪 spec"volatile 不入历史"**：必须按"每轮去重注入的耐久消息"设计，否则会累积 |
| `source.kind` 规则 | 必须 producer-owned，`'plugin'` 被拒：`format v4 message requires a producer-owned source kind`（`host/dsh-session/lib/types/message-sources.js`） | `logs/probe1.jsonl` `turn/end reason {"kind":"error","error":{"message":"format v4 message requires a producer-owned source kind"}}` | spec 未写；第三方应使用 `plugin:<id>` 或自有稳定 kind（本机真实取值：`user`、`agent-instructions`、`runtime-context`、`skill-catalog`、`system-prompt`、`model`、`tool`） |
| `agent/turn-stopping` | `{ turn, signal, agent }`（`turn` 是 number），**成功路径**在 `turn/end` 之前同步触发；错误/中断路径**不触发** | probe3：`12:57:00.035 end frame` → `12:57:00.036 turn-stopping keys ["turn","signal","agent"]` → `turn/end reason {"kind":"completed"}`；probe1 错误路径无 turn-stopping | 与 spec 基本一致，但**不能当作"每轮必达"**；错误轮需要 session/event `turn/end{reason.error}` 兜底 |
| `agent/assistant-stream` | `{ frame, agent }`；frame 有 `start|chunk|end`；`end` 帧 keys `["type","attemptId","revision","index","outcome"]` | probe2/probe3：`{"frameType":"end","usage":null,"usageRaw":null}` | **证伪 spec"end 帧带 usage"** |
| usage 真实来源 | `ctx.on('session/event', (session, event) => …)`，`event.type==='assistant/message'` 时 `event.data = { turn, step, message, usage, stream }` | probe3：`{"type":"assistant/message","usage":"{\"inputTokens\":6631,\"outputTokens\":139,\"totalTokens\":6770}"}` | spec 需改写：记账走 session/event，不走 stream 帧 |
| `agent/session-start` | **不存在**：注册不报错但三次运行**一次都没触发** | `grep '"event":"agent/session-start"' logs/*.jsonl` 仅 3 条 `listener-installed`，无 `fired`；实际触发的是 `agent/created {agent,source,signal}` | **证伪 spec §3**（`source ∈ startup|clear|compact` 无从谈起）：head pack 只能走 systemPrompt.section（+ 可选 pre-step 兜底），会话开始用 `agent/created` 或 `session/event` `turn/start` |
| 工具注册 | `ctx.tools.register(defineTool({ name, description, parameters, output:{schema, render(args,v)=>[{type:'text',text}]}, execute }))`；`parameters` 是**字段表**不是 JSON Schema：`{ text: { type:'string', required:true, description } }`；`output.schema` 是值 schema（如 `{type:'string'}`） | probe3 `tool-registered {"via":"defineTool"}` → `tool-execute {"tool":"probe_echo","args":{"text":"hello"}}` → `session-event tool/result len:33 "echo=hello node=24.21.0 pid=19776"` | spec 未给 DSL；错误写法会抛 `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object` |
| peer 解析 | `import('@deepseek-ai/dsh-tools')` 只有在插件 realpath **位于 profiles 树内**时成功 | probe3 `{"ev":"peer-import","pkg":"@deepseek-ai/dsh-tools","defineTool":"function"}` | 落地部署必须先复制/安装进 `~/.dsh/profiles/web/node_modules/` |
| 工具模式 | 默认 `native`（仅 ptc 模式降为 run_code-only），`probe_echo` 被模型真实调用 | probe3 `tool/call → tool-execute → tool/result` | 与 spec 一致 |
| 其它可用事件 | `system-prompt/change`、`tools/change`（无 payload）、`agent/end`、`agent/request-error`、`session/event`（`turn/start`、`step/start`、`step/end`、`turn/end{reason}`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/title`） | probe3 全量 `session-event` 行 | spec §3 事件清单需要按此收敛 |

---

## 3. spec 假设证伪 / 需改写（必须回写规格）

| # | spec 原文假设 | 实测 | 处置 |
| --- | --- | --- | --- |
| 1 | §3 用 `agent/session-start({agent, source})`，`source ∈ startup/clear/compact` 做会话开始注入 | 该事件**在此构建里不存在**，注册成功但永不触发；`agent/created {agent,source,signal}` 才是真实事件 | head pack 改走 `systemPrompt.section`（order 10200 之后）；"compact 后重取"改为在 section 文本函数里按当前会话状态重算 |
| 2 | §3 assistant-stream `end` 帧带 usage | `end` 帧无 usage（`usage:null`） | token 记账改监听 `session/event` 的 `assistant/message.data.usage` |
| 3 | §4"volatile 块只追加、不入历史" | pre-step 追加的消息**落盘为 `user/message` 会话事件**，会留在历史里 | 设计改为"每轮一次、带 turnId 的耐久注入"；跨轮去重（同一 turn 只注入一次），并在提示词里明确它是注入块 |
| 4 | §3 pre-step 每次"改本步消息" | pre-step **每 step 触发**，`messages` 只含该 step 被 claim 的消息（工具调用轮 step2 为 0） | 追加位置按"decision.messages 末尾"，不要假设能定位到用户原文位置；本轮用户原文从第一次 pre-step（step=1）的 claimed 里取 |
| 5 | 未提及 source.kind 约束 | `kind:'plugin'` 直接导致整轮失败 | 插件统一用稳定 kind（建议 `plugin:tdb-agemem-dsh` 或 `tdb-agemem-dsh`），并在报告/规格里写死 |

补充事实（不冲突，但 spec 未写）：插件 `inject` 必须声明用到的每个服务；`ctx.tools.register` 的参数 DSL 是字段表；peer 包必须装在 profiles 树内。

---

## 4. 对 v0 落地的直接影响

1. **head pack**：`ctx.inject(['systemPrompt'])` + `section({name:'tdb-agemem:head', order: getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')+100, interpolate:false, text: () => cached})`；首次取到缓存，异常 fail-open 返回 `''`（宿主拼接时会跳过空段落）。
2. **每步注入**：pre-step 里 `const decision = await next(); if (decision.kind==='reject') return decision; if (alreadyInjected(decision.messages, turn)) return decision; return {...decision, messages:[...decision.messages, msg]}`；整体 try/catch，异常返回原 decision。
3. **回合回写**：`agent/turn-stopping`（fire-and-forget 推 outbox，**不 await 网络**）+ `session/event` `assistant/message` 取 usage + `turn/end{reason}` 处理错误轮兜底。
4. **工具**：`defineTool` 字段表 DSL；先做 `memory_recall` stub（参数 `query`、可选 `limit`），保留接 core `/v3/recall` 的接口。
5. **部署**：必须落到某个 **profile 的 node_modules** 里（peer 解析），用 `dsh plugin --profile <p> add` 走官方安装；回滚删除该目录 + 还原 profile 的 `package.json`/patch（脚本内做备份）。
   实测更正：正在跑的宿主 profile 是 **`desktop`**（环境变量 `DSH_PROFILE=desktop`，bundles 含 dsh-context / billion-context / esn-client-plugin 等）；
   `web` 只是出厂模板（bundles = dsh-base + dsh-web-app + esn-client-plugin）。部署脚本因此缺省 `PROFILE=${DSH_PROFILE:-desktop}`。

---

## 5. 清理账目

- 一次性 profile `C:\Users\Administrator\.dsh\profiles\probe`（含 probe 包副本）：**已删除**（2026-10-31，阶段 B 部署链路实测复用过它，随后 `rm -rf ~/.dsh/profiles/probe`，现 `~/.dsh/profiles` 只剩 desktop / web / node_modules）。
- probe 源码、日志、helper 脚本保留在 `scratch/dsh-plugin-probe/` 作为证据，**不入库、不提交**。
- 未触碰：`~/.dsh/cordis.patch.yml`、`~/.dsh/profiles/web/`（package.json / cordis.* 均未改）、`~/.dsh/profiles/desktop/`（阶段 B 只做了 `--dry-run`，未安装）、正在运行的 GUI 宿主进程。

---

## 6. 阶段 B（v0 落地）实测记录

包位置 `dsh-plugin/`（`@tdb/agemem-dsh` 0.1.0），构建与单测绿：`tsc` 干净、`vitest run` = **8 files / 59 tests passed**（fake ctx，不需要宿主）。

### 6.1 部署/回滚链路端到端实测（在一次性 `probe` profile 上，不动 desktop）

| 步骤 | 命令 | 实测结果 |
| --- | --- | --- |
| 部署 | `DSH_PROFILE=probe bash scripts/deploy.sh --skip-tests` | pnpm v11.28.5 `+ @tdb/agemem-dsh 0.1.0`（416ms）；patch 追加 insert 行；`--dump-config` 输出含 `tdb-agemem-dsh` → "composition resolved" |
| 安装物加载 | `node -e "import('file:///C:/Users/Administrator/.dsh/profiles/probe/node_modules/@tdb/agemem-dsh/dist/index.js')"` | `ok: tdb-agemem-dsh ["systemPrompt"] function` |
| 回滚 | `DSH_PROFILE=probe bash scripts/rollback.sh` | 还原 3 个 profile 文件 + 删包目录；`--dump-config` 断言不含插件 → "verified" |
| 收尾 | `rm -rf ~/.dsh/profiles/probe` | 已删；desktop 的 patch/package.json 无本插件痕迹（grep = 0） |

### 6.2 打包前缀：一个只在真实安装时才暴露的坑（已修）

第一次 e2e 后加载安装物失败：`Cannot find module ...\node_modules\@tdb\agemem-dsh\dist\index.js`。
根因：npm/pnpm 的 tarball 约定是**所有条目都在单层 `package/` 前缀下**，安装器会剥掉这一层；
如果直接把 `package.json / dist / README.md` 打在归档根部，pnpm 会把 `dist/index.js` **拍平成 `index.js`**，
装出来的包没有 `dist/` 目录（实测虚拟店目录里是 `config.js`、`index.js`… 平铺）。
修复：`deploy.sh` 的 3/6 先 `cp` 到 `$STAGE/package/`，再 `tar -czf <tgz> -C "$STAGE" package`；修复后安装物 `dist/` 齐全且可直接 import。
（另修：pnpm 是 Windows 进程，git-bash 路径 `file:/d/...` 会被解析成 `C:\d\...`，脚本改用 `cygpath -m` 传 `file:D:/...`。）

### 6.3 CLI 事实（`dsh --help` 与实测）

- `dsh plugin [--profile <p>] <args...>`：把剩余参数原样转给 profile 目录里的 pnpm（help 原文 "manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"）；`--profile` 必填。
- `dsh plugin add <file:tgz>` 会告警 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`：符合预期，我们靠 patch 的 `insert` 行显式挂载。
- `dsh --profile <p> --dump-config` 只做组合解析，**不加载插件**，因此它通过 ≠ 插件已挂载；挂载要等宿主重启。

### 6.4 尚未实测的一项

真实 desktop profile 上的**挂载**（section 是否出现在系统提示词、pre-step 注入是否落盘）需要重启宿主，属于 Lead 决策，本次未做：
当前正在跑的这个 GUI 进程全程未被触碰。
