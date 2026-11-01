# dsh-plugin：会话开始选身份（task-117 C 段交付报告）

日期 2026-11-01。票面对应的用户原话：『不对啊，是在会话开始的时候弹窗的啊，你好好看看原代码流程的逻辑，不要瞎猜了』。
本报告只记录**实测**：机制来自宿主源码 + 本机真机 e2e，未用垫片读数充数；没有安装到用户正在跑的 desktop profile、没有重启用户的宿主、没有 commit。

## 1. 机制（探针实测，非推断）

| 事实 | 证据 |
| --- | --- |
| 宿主有 `ctx.userQuestions.ask({agent, questions, signal})` | `@deepseek-ai/dsh-user-questions/lib/index.js:668`（waterfall `user-questions/request`） |
| **必须带 agent**，否则没有 provider | 客户端 `dsh-client-ui-user-questions/lib/client.js:1761-1810` 首行 `ctx.sessions.scopeOf(owner)`；不带 agent 实测 `NO_PROVIDER` |
| 在 `agent/pre-step` 里调即可当场渲染卡片 | 本机 e2e：`CARD {"agents":1,"teams":0}` → 点选 → `SUBMIT clicked` → `AFTER-CARD {"agents":0,"teams":0}` |
| 提交后宿主回 `{"answers":[{"id":"agent_select","selected":["default-agent-hechen (ribzz)"]}]}` | 同上，`session-identity.json` 以 `source:"picked"` 落盘 |
| 本插件 `inject = ['systemPrompt']`，未 inject 的服务**直接属性读会抛** | `agemem: session identity picker failed Error: cannot get property "userQuestions" without inject` |
| 逃生口：`ctx.reflect.get(name, false)` 绕 inject 且容忍 provider 未 active | asar `get(name, strict = true)` 文档「Read a service from the store without the inject requirement」；`if (strict && impl.fiber.state !== 2) return;` |

## 2. 策略（票面要求逐条落地）

- **触发条件**：本 session 未绑定身份，且**用户级 `session_init` 配置说「问」**。弹不弹卡与候选数量无关——旧实现「1 team 自动选中、1 agent 自动绑定」是错的（proxy 侧不是这个逻辑）。现在的决策来自 `POST /v3/meta/config/user/get {user_id, module:"session_init"}` 的四个生效值（照抄 `MemoryProxy/src/session/user-session-init-preset.ts:20-40`）：
  - `manual_select≠"0"` / 读不到配置 / 缺 `default_team_id` ⇒ **ask**：每会话弹「请确认本次对话是否要关联团队资产？」，答「是」之后才按候选数折叠（1 team 不问 team、1 agent 不问 agent，`source:'picked'`），答「否」⇒ 空三元组 + `source:'skipped'`（不注入）。
  - `manual_select="0"` + `default_associate="1"` + 有 team ⇒ **preset**：校验 team 属于该用户、agent 在该 team 内（未配 agent 时取该 team 唯一 agent，0/多个视为失效）后静默绑定，`source:'user-preset'`；校验失败 warn 一次并回落 ask。
  - `manual_select="0"` + `default_associate="0"` ⇒ **bypass**：`source:'user-bypass'` + **空三元组**（`missingIdentity()` 报 `teamId`，数据面全部不发请求），不注入也不写回。**决策之前也不读团队数据**：mount 时读一次配置，`HeadPackDeps.allowFetch` 这一个闸门覆盖全部取数路径（mount 刷新、`turn/start` 的 `ensureFresh`、section 渲染里的 `current()`、`onBound`），判定 `bypass` ⇒ 连 `head pack composed` 都不会出现；embedding 预热（`/v3/core/read` + `/v3/recall`）同闸门。读配置失败 **fail-open**（照常预热 + 弹卡），不把 5xx 当成「用户选择退出」。
  - **配置读取次数**：mount 读一次（供上面的门禁用），**首个**会话复用该值，之后每个新会话各读一次 ⇒ 一个会话恰一次往返，改配置不必重启，也不会被进程级缓存钉死（`test/index.test.ts` 两条用例钉住「首会话复用 / 新会话重读」）。
  - **题面**：`asset_confirm` 问「请确认本次对话是否要关联团队资产？」，**不**附 `SKIP_HINT`（这张卡没有「跳过」选项，两个选项自带的说明已经讲清后果）；team / agent 两题仍带 `SKIP_HINT`（那里确实有跳过项）。
  - 三态 e2e 读数见 `scratch/e2e6/evidence/`（preset / bypass / ask-no / ask-yes / real / 读配置 500 六跑）。
- **题面照抄 MemoryProxy**（`MemoryProxy/src/session/dsh/form.ts`）：id 固定 `team_select` / `agent_select`，问题 `请选择本次会话所属的 Team:` / `请选择「<team_name>」下要使用的 Agent:`，选项 `名称 (id 后 8 位)`，`multiSelect:false`，跳过词 `本次不关联(跳过注入,直接放行)` + `SKIP_HINT`，`skipDefault` 决定跳过项是否置顶。
- **跳过 = 本 session 不注入团队上下文**，记 `source:'skipped'` + `reason`。跳过判定同时接受 custom 自由文本（CJK 子串任意位置 + ASCII 词边界）。
- **绝不卡 turn**：`askTimeoutMs`（缺省 60000）竞速 + 上游 `signal` 透传；`NO_PROVIDER` / `ASK_ABORTED` / `ASK_TIMED_OUT` / 服务缺失 一律回落 config 三 ID，`warn` 一次。
- **绑定按 session 持久化**：进程内 Map + JSON 状态文件（缺省与 outbox 同目录 `session-identity.json`，`identity.statePath` 可指定），tmp + `.pid` + rename 原子写，坏文件静默跳过。
- **一条会话只弹一次**：in-flight `Map<sessionId, Promise>` 去重，同 session 并发两个 pre-step 的第二路 await 同一 Promise（用例 `asks once when two pre-steps race for the same session`）。

## 3. 四个身份面全部改走 session 身份

`MemoryClient` 新增 `deps.identityFor(sessionId?)`，`V3CallOptions.sessionId` 贯穿 `isolation()` / `missingIdentity()` / `headers()`：

| 面 | 走 session 身份的证据 |
| --- | --- |
| recall（volatile 块） | `/v3/recall` 头 + body 都是绑定值 |
| writeback（L0 / skill） | `addConversationResult` / `skillConversationAdd` / `deleteConversation` envelope 用 `isolation(session)` |
| head pack（persona / l2 / skills） | persona `readCore(timeoutMs, sessionId)`、l2 `listScenariosRich(…, sessionId)` |
| 工具面（`memory_recall`、skills/wiki） | `RecallToolDeps.sessionId` → `client.recall(query, limit, timeout, sessionId)` |

**同步零 IO**（硬要求 B）：`identityFor` 只读内存 Map，未绑定立刻回落 config 三 ID（不 await、不抛），回落只 `debug` 一次。

## 4. e2e 里抓到并修掉的三个真 bug

### 4.1 配置全是 cosmokit 引用 ⇒ baseUrl 回落到 8420、debug 丢失
宿主把 `.volatile()` 字段当引用对象交过来（`{}` + `Symbol.for('cosmokit.volatile.write')`），`apply()` 直接 `normalizeConfig(rawConfig)` 把每一个 volatile 路径都回落缺省：baseUrl → `127.0.0.1:8420`（未起）、debug → false、config 三元组 → 空。修法：`apply()` 第一句改 `resolvePluginConfig(rawConfig)`（`src/config-schema.ts` 的 unwrap 层）。
证据：修前 mount trace `rawServer` 全是 `{}` 且 `source:"none",injectedChars:0`；修后 trace `"endpoint":"http://127.0.0.1:18421","debug":true`，volatile `{"source":"recall","injectedChars":1479}`。用例 `reads settings the host hands over as volatile references`（RED 1 failed / GREEN 1 passed）。

### 4.2 `ctx.userQuestions` 属性读抛异常 ⇒ picker 全废
`dist/index.js:144` `cannot get property "userQuestions" without inject`，随后 `source:"skipped", reason:"unexpected picker failure"`。修法：`questionService()` 只走 `ctx.reflect.get('userQuestions', false)` + try/catch + `typeof ask === 'function'`。用例 `asks through reflect when a bare property read would throw (task-117 e2e)`（RED：`ask` 0 次）。

### 4.3 `memory_recall` 用 config 身份、volatile 用绑定身份（同一轮两个身份）
recorder 原文：同一轮 `/v3/recall` 带 `"agent":"agt-2m7buribzz"`（绑定），`/v3/atomic/search` 带 `"agent":"agt-dofal7hgfe"`（config）⇒ 工具查的是别人的 agent，模型答「零命中」。修法：`sessionId` 一路穿到 `RecallToolDeps` → `client.recall(...)`；`recallCombined` 增加第 5 参并透传给 `searchAtomic`/`readCore`/`listScenarios`。用例 `gives the memory_recall tool the same session identity as the volatile block`（RED `expected 0 to be greater than 0` / GREEN 1 passed）。

## 5. 真机读数（一次性 profile `agemem-e2e5`，DSH_HOME 隔离在 `scratch/e2e5/home`）

1. **ready 行**（`scratch/e2e5/agemem.log`）：`agemem: ready (endpoint=http://127.0.0.1:18421, serviceId=default, identity=configured, keySource=env:TDAI_GATEWAY_APIKEY, userKeyHeader=lazy(TDAI_USER_KEY), health=ok, sessionIdentity=on, headPack=on,l2=pending,volatile=recall,…)`；`identityApi=` 已随旧方案归档消失（`test/index.test.ts` 有反向守卫断言）。
2. **只看一张卡**：`CARD {"agents":1,"teams":0}`（团队候选唯一 ⇒ 自动选中、只弹 agent 一题），提交后 `AFTER-CARD {"agents":0,"teams":0}`，整轮只出现一次。
3. **状态文件**（`session-identity.json`）：`{"version":1,"sessions":{"session-3ddac3fc-…":{"teamId":"team-2k12lgb650","agentId":"agt-2m7buribzz","userId":"usr-2m7b1144d9","source":"picked","at":…}}}`；同一 session 再来（重启宿主后）不再弹卡，直接命中绑定。
4. **身份头**：config 故意设为 `agt-dofal7hgfe`（chenxin 的 agent），选中 `agt-2m7buribzz`，recorder 抓到的顺序是
   `…/v3/core/read agt-2m7buribzz` → `/v3/scenario/ls agt-2m7buribzz` → `/v3/skill/listing agt-2m7buribzz` → `/v3/recall agt-2m7buribzz session-3ddac3fc-…` → `/v3/atomic/search agt-2m7buribzz`（**工具面与 volatile 同身份**）。会话之前的两条 `/v3/meta/team/list`、`/v3/meta/agent/list` 仍是 config agent——那是**绑定前**的候选枚举，属预期。
5. **回答内容**：模型直接答出 `RowNoCheckRule.checkRowNo:49`、`Transferz2Action:128-129`、`OrderSaveBP.java:138`（ctgenorder 行号为空根因）⇒ 查的是选中 agent 的那份记忆。

## 6. 边界与诚实说明

- **本团队真实数据下不会自己弹卡**：`/v3/meta/user/list` 只有 1 个 user（`hechen`），`/v3/meta/agent/list` 该 team 下也只 owns 1 个 agent。改动前这导致「自动绑定、永不弹卡」（错误行为，已修）；改动后是否弹卡只看用户级 `session_init`——`preset` 态下同样不弹（静默绑定，`source:'user-preset'`），`bypass` 态不弹也不注入，只有 `ask` 态弹。e2e 通过 recorder（`scratch/e2e6/recorder.mjs`，`STUB_SESSION_INIT` stub `config/user/get` 三态、`STUB_AGENTS=1` 把 agent 候选换成 2 个）来验三态；**stub 只伪造这两个端点，其余请求全部透传到 8420**。
- **绑定与卡片竞速**：`session-identity` 的 pre-step 与 volatile 的 pre-step 都 `{prepend:true}`，宿主 prepend 是 unshift ⇒ **先后不保证**。保证的是「最多一张卡」（in-flight 去重）与「选中后下一步已带新身份」；与卡片同批的那一步最多回落 config 一轮。
- **状态文件上限 200**：超出按 `at` **淘汰最旧**的绑定（不是拒绝新增、不静默留空值）；被淘汰的 session 再来会重新弹一次卡。用例 `evicts the OLDEST binding past 200 sessions`。
- **`askAtSessionStart=false` 只关「问」不关「记」**：状态文件里已有的绑定继续生效（`identityFor` 直接读 store），否则同 session 会悄悄退回 config 身份——这是按 Lead m05992 的接线要求做的选择，README 已写明。
- **未验**：真正的子代理（owned child）路径只有单测（`DELEGATED_CALLER` ⇒ 静默 skipped、不 warn）；没有在 GUI 里跑子代理实测。headless 组合 `credentials` 被禁 ⇒ 无 user key ⇒ inert 不弹，亦只有单测覆盖。

## 6.1 复核用证据目录（保留）

`scratch/e2e5/` **有意保留**：其中 `requests.jsonl` 是本次唯一的时间线证据，可按时间切「绑定前 / 绑定后」——

- `2026-11-01T01:41:17` `meta/auth/verify` → `team/list` → `agent/list`（解析候选，头里仍是 config 的 `agt-dofal7hgfe`）；
- `01:41:20.215` 起 `/v3/core/read`、`/v3/scenario/ls`、`/v3/skill/listing`、`/v3/recall`、`/v3/atomic/search` 全部 `agt-2m7buribzz`（选中值）；`01:41:09` 之前的同类请求全是 config 值。

同目录另有 `session-identity.json`（7 条 session：`userkey`×3 自动选中、`picked`×3 真弹卡、`skipped`×1 修复前 `unexpected picker failure` 的现场，即 RED 留档）、`agemem.log`（ready 行与 volatile 读数）、`recorder.mjs` / `ui.cjs` / `provider.yml` / `extra.yml`。`scratch/e2e5/home/` 是一次性 `DSH_HOME`，deploy 已 rollback、profile 不在 composition 里。

## 7. 门禁与清账

- `tsc -p tsconfig.json --noEmit` EXIT=0；全量 vitest **36 files / 626 tests passed**（改动前 601）；`npm run build` rc=0，`dist/index.js` sha1 `a22ec5dc4253`，安装物 sha256 `9a4721eb165d`（stamp `20261101-094028`）。
- 临时诊断块已删（`src/index.ts` 里的 `AGEMEM_TRACE_PATH` append，含 `appendFileSync` import）。
- 旧「设置页 / 回环 identity API」方案已归档到 `scratch/archive/identity-server.ts`，运行时接线（`server.identityPort`、`identityApi=` 读数）全部移除，`VOLATILE_PATHS` 现 29 条（含 `identity.*` 四条）。
- 一次性 profile 只装在 `scratch/e2e5/home`（`DSH_HOME` 隔离），用户正在跑的 `desktop` profile 全程 `--dry-run` 未触碰；未 commit。