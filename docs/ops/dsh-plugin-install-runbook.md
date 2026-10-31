# dsh 记忆插件：安装 / 回滚 / 验收 runbook（人用）

> **谁执行**：由人执行。AI 只维护本手册，不代跑安装、不动 `desktop` profile。
> **时效**：命令与读数于 2026-10-31 实跑或 `bash -n` 验过（逐条标注「实测 / 语法验」）；**2026-11-01 按 task-37 落地后的「隔离走 header / recall 熔断 / 字节分片」契约复核了 §1.3、§3.2、§4.1、§6**。行号为当日值，`dsh-plugin/` 在 git 里 untracked 且并行修改中，**引用它一律按符号**（文件名 + 常量名/函数名），不写行号。
> **配套**：写面幂等边界见 [production-profile.md](production-profile.md) §2.1；召回/写入口径见同文件 §1–§2；回滚演练单见 [rollback-drill.md](rollback-drill.md)。

---

## 0. 一分钟判断清单（先看这四条，再决定要不要装）

| 检查 | 命令（实测） | 期望 | 不符时的含义 |
|---|---|---|---|
| core 活着 | `curl -s -m 4 http://127.0.0.1:8420/health` | `status:"ok"` / `stores.vectorStore:true` | core 没起或端口不是 8420；装插件前必须先修 |
| 还没装过 | `node dsh-plugin/scripts/patch-util.mjs has ~/.dsh/profiles/desktop/cordis.patch.yml` | `no` | `yes` ⇒ 是升级，`deploy.sh` 会走 UPGRADE 分支（替换 tarball + config，不会追加第二条） |
| 身份三元组拿到了 | 见 §1.3 | team/agent/user 三个非空 id | 空 ⇒ 插件挂载但 **inert**（不读不写），这是设计上的安全缺省 |
| key 拿到了 | 见 §1.4 | 40/64 字符的 core `server.apiKey` | 用了 MemoryProxy 的 key ⇒ 401 `Unauthorized: invalid token` |

---

## 1. 前置检查（装之前必须全部过）

### 1.1 core 健康（实测）

```bash
curl -s -m 4 http://127.0.0.1:8420/health
```

2026-10-31 实测输出（截断；这个端点**不需要鉴权**，见 `MemoryCore/src/gateway/server.ts:1575`（`GET /health is always reachable without auth`）与 `:1588`（「唯一豁免是上面的 GET /health 探活」））：

```json
{"status":"ok","version":"0.1.0","uptime":5177,
 "stores":{"vectorStore":true,"embeddingService":true},
 "services":{"stateBackend":"connected"},
 "memory":{"vectorCoverage":1,"vecRows":3514,"metaRows":3514,"embedding":"ok","degradedSince":null,"embeddingConfigured":true},
 "warmup":{"status":"done","steps":{"jiebaMs":61,"storeReadyMs":1,"queryExpandMs":292,"rerankMs":4700},"totalMs":5056}}
```

判读：`status` 与 warmup 无关——`/health` **恒 200**，warmup 失败也不改 status（`MemoryCore/src/gateway/server.ts:1959`：「/health 恒 200：warmup 失败不改变 status——无 readiness 门（设计裁决）」）。所以**不要用 HTTP 码判断健康**，要看 `status`、`memory.embedding`、`memory.degradedSince`。

### 1.2 v3Recall 开关（决定 volatile 走哪条腿）

`memory.recall.v3Recall.enabled` 代码缺省 **false**（`MemoryCore/src/config.ts:2472`，注释 `:2466`：「enabled 缺省 false = 逐位现状」）。关着的时候 `/v3/recall` 返回 404 并在 message 里点名开关（`MemoryCore/src/gateway/v2-router.ts:1897-1904`）。

**这不是故障**：插件在 404/504 时降级到 `atomic/search`（`dsh-plugin/src/index.ts` 的 `warnRecallFailure`），volatile 仍然会出现，只是少了合并召回的收益。

查当前档位（实测）：

```bash
grep -n -A2 'v3Recall:' MemoryCore/tdai-gateway.yaml
```

本机实测 `MemoryCore/tdai-gateway.yaml:287-288` 是 `enabled: true`（实验档；生产云模板/base 档的取值以 [production-profile.md](production-profile.md) §1 为准）。

### 1.3 身份三元组（team / agent / user）

core 用 `(team_id, agent_id, user_id)` 隔离记忆。**插件空身份 = inert**（`dsh-plugin/src/config.ts` 的 `DEFAULT_CONFIG.server` 三项缺省 `''`，注释写明「an install must never inherit the author's identity」）。

**三轴走 header，不走 body**（task-37 收口的口径）：插件在 `dsh-plugin/src/memory-client.ts` 的 `headers()` 里统一附带 `x-tdai-service-id` / `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id`——该函数是**唯一**挂隔离三轴的地方，所有 `/v3/*` 一律带；core 在进 handler 前先校验，缺一个就 422（见 §6.1）。body 里的三轴只是**回显兼容**（`echoIsolationInBody`，缺省 true；关掉它不影响隔离——`/v3/recall` 就是只发 header、body 只有 `query`/`maxResults`/`session_id`）。⇒ 手工 curl 必须给 header；只写 body 不算数，这正是生产环境「每轮 422」的根因。空身份（三项全 `''`）时插件不挂隔离头 ⇒ 同样是 422，但那是设计上的 inert，先补身份（`--identity`）再说。

取值来源（任选其一）：
- 这套记忆在 core 里已有的 id（最稳）：找一次已落库的行看三元组，见 §4.3 的只读查询；
- 旧机器上 e2e 用过的三元组（`docs/ops/dsh-plugin-e2e-report.md` 记录：team / agent / user 各一，**不要照抄别人的值**，否则串记忆）；
- 新装机：自己起一套，三处写同一份（插件 patch 层、`--identity`、core 侧无需登记）。

### 1.4 key 从哪来

| 方式 | 写法 | 说明 |
|---|---|---|
| 自动读（缺省） | 不传 | `deploy.sh` 用 `sed` 取 `MemoryCore/tdai-gateway.yaml` 里**第一个带引号的 `apiKey:`**（脚本内注释：llm 段的 `apiKey` 在下面，第一个就是 `server.apiKey`） |
| 环境变量 | `TDB_CORE_API_KEY=…` | 同上，覆盖自动读取 |
| 显式参数 | `--api-key …` | 优先级最高 |

**必须是 core 的 `server.apiKey`，不是 MemoryProxy 的 key**——两者的失败文案不同，见 §6.1。

验证 key 可用（实测；`/v3/*` 除了 key 还要 `x-tdai-service-id` 与身份三元组）：

```bash
KEY=$(sed -n 's/^[[:space:]]*apiKey:[[:space:]]*"\([^"$]*\)".*/\1/p' MemoryCore/tdai-gateway.yaml | head -1)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8420/v3/scenario/ls \
  -H "Authorization: Bearer $KEY" -H 'x-tdai-service-id: default' \
  -H 'x-tdai-team-id: <team>' -H 'x-tdai-agent-id: <agent>' -H 'x-tdai-user-id: <user>' \
  -H 'Content-Type: application/json' -d '{"path_prefix":""}'
```

实测：三个头齐全 ⇒ `200`；缺 service-id ⇒ `401 Missing x-tdai-service-id header`；缺身份三元组 ⇒ `422 /v3 requires strict isolation: missing team_id, agent_id, user_id…`。

---

## 2. 装前演练：patch 层 drill（不装包、不碰 desktop）

```bash
cd dsh-plugin
bash scripts/drill-patch-layer.sh desktop   # 已在源 profile=desktop 上实跑通过（脚本自建自删 desktop-drill）
```

它把 `~/.dsh/profiles/<profile>` 复制成 `<profile>-drill`，只演练 deploy 的**第二半**（patch 层），断言三条（脚本头注 `What it asserts`）：
1. `upsert` 只写**一条**插件条目，且 `dsh --dump-config` 能解析；
2. 第二次 `upsert` 换 config 是**替换**（升级语义），不是追加第二条；
3. `strip` 后其它条目数不变、文件仍可解析。

成功打印 `DRILL PASSED (source profile: …)`；失败保留 `<profile>-drill` 供检查（头注：*kept on failure so you can inspect it*）。
**已实跑通过**（源 profile=desktop）：输出 `DRILL PASSED (source profile: desktop)`。脚本在 `~/.dsh/profiles/desktop-drill` 上自建自删——源 profile 全程零改动，失败时才留下副本供检查。所以这一步**装前可以放心跑**：它证明的是「patch 层这一半的写 / 替换 / 剥离语义」，不是「装上了能跑」。

---

## 3. 安装

### 3.1 先 dry-run（实测；打印计划、零写入）

```bash
cd dsh-plugin
DSH_HOME=/tmp/fakedsh TDB_CORE_API_KEY=<你的 core key> \
  bash scripts/deploy.sh --dry-run --skip-tests \
    --identity team-demo,agt-demo,usr-demo
```

实测输出（`DSH_HOME` 指向临时 home，故路径为 `/tmp/fakedsh/...`；真实运行时是 `~/.dsh`）：

```text
== profile     : desktop (/tmp/fakedsh/profiles/desktop)
== patch file  : /tmp/fakedsh/profiles/desktop/cordis.patch.yml
== core        : http://127.0.0.1:8420 (service default)
== api key     : set (40 chars)
== identity    : team=team-demo agent=agt-demo user=usr-demo
== 1/6 build
   [dry-run] …/node_modules/.bin/tsc -p …/tsconfig.json
== 3/6 pack
   [dry-run] tar -czf …/tdb-agemem-dsh-0.1.0.tgz -C <staging>/ package.json dist README.md
== 6/6 write the managed patch entry and verify
   [dry-run] would append the managed block in …/cordis.patch.yml (api key masked):
   | - insert:
   |     - id: tdb-agemem-dsh
   |       name: ./node_modules/@tdb/agemem-dsh/dist/index.js
   |       config:
   |         server:
   |           baseUrl: "http://127.0.0.1:8420"
   |           serviceId: "default"
   |           apiKey: "b8475f4b…e760"
   |           teamId: "team-demo"
   |           agentId: "agt-demo"
   |           userId: "usr-demo"

DRY RUN — nothing was written.
```

**key 打码形态固定**：前 8 + `…` + 后 4（`deploy.sh` 里 `sed -E 's/(apiKey: ")([^"]{8})[^"]*([^"]{4})"/\1\2…\3"/'`）。dry-run 里看到完整 key 说明打码被改坏了。

### 3.2 参数逐条

| 参数 / 环境变量 | 缺省 | 作用与坑 |
|---|---|---|
| `--dry-run` | 关 | 只打印，不建目录、不写 patch、不装包（`run()` 在 dry-run 下只 printf） |
| `--skip-tests` | 关 | 跳过 `vitest run`；**不传时没装 vitest 会直接 exit 1**（脚本拒绝静默跳过测试） |
| `--identity team,agent,user` | 空 | 也接受 `TDB_TEAM_ID`/`TDB_AGENT_ID`/`TDB_USER_ID`；空 ⇒ 挂载但 inert |
| `--base-url URL` | `http://127.0.0.1:8420` | 也接受 `TDB_CORE_BASE_URL` |
| `--api-key KEY` | 从 yaml 读 | 也接受 `TDB_CORE_API_KEY`；**不要填 proxy 的 key** |
| `--config-extra <file>` | 无 | 把一段 YAML 原样缩进 8 空格挂到 `config:` 下，用于脚本没建模的键：`writeback.skillFeed`、`writeback.maxRequestBytes`、`volatile.maxChars`、`headPack.enabled`、`paths.*`、`debug`。文件里出现 `- ` 列表行会被拒（它是映射不是列表） |
| `DSH_PROFILE` | `desktop` | 目标 profile；`web` 是模板档 |
| `DSH_BIN` | `D:/DSH/resources/runtime/cli/bin/dsh.cmd` | dsh CLI |
| `DSH_HOME` | `~/.dsh` | profile 根目录；演练时指到临时目录即可完全隔离 |

`--config-extra` 实测（关掉 L2 双写 + 显式钉字节预算，见 §5 与 production-profile §2.1 边界 2/5）：

```bash
cat > /tmp/extra.yml <<'EOF'
volatile:
  maxChars: 1200
writeback:
  skillFeed: false
  maxRequestBytes: 700000
EOF
bash scripts/deploy.sh --dry-run --skip-tests --config-extra /tmp/extra.yml --identity team-demo,agt-demo,usr-demo
```

实测该片段原样出现在 patch 条目末尾，缩进正确（2026-10-31 22:20 再跑一遍，零写入）：

```text
|         writeback:
|           skillFeed: false
|           maxRequestBytes: 700000
```

`writeback.maxRequestBytes` 的取值：缺省 **700000**（`dsh-plugin/src/wire-limits.ts` 的 `DEFAULT_MAX_REQUEST_BYTES`，上限常量 `CORE_MAX_REQUEST_BYTES = 1000000`），解析时 floor 并 clamp 到 **[1, 1000000]**（`dsh-plugin/src/config.ts` 的 `DEFAULT_CONFIG.writeback` 与 normalize 段）。**别钉到 1000000**：core 在 1 MiB 处先 reject 再 destroy socket，客户端只见 `ECONNRESET` 无 413（§6.3 传输层那行），预算要留余量。

### 3.3 真装

```bash
cd dsh-plugin
bash scripts/deploy.sh --identity <team>,<agent>,<user>
```

六步（脚本 `say` 文案）：build → test → pack → back up profile files → `dsh plugin add` → 写管理块并 `--dump-config` 校验。三条安全性质：
- 改 profile 之前先把 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` 备份到 `dsh-plugin/.deploy/<stamp>/`；
- 任何安装后失败都走 `abort_deploy()`：strip 管理块 → 还原三份备份 → `plugin remove` → 删包 → `exit 1`（注释：「failed deploy never leaves an installed package or a dangling patch entry」）；
- **先写 stamp 再校验**（注释：否则校验失败会变成不可恢复的孤儿），校验方式是 `--dump-config` 后 grep 插件 id。

脚本**不会重启宿主**：patch 层生效要你自己重启 dsh（结尾提示「restart the dsh host (this session's GUI) so the plugin mounts」）。

---

## 4. 安装后 4 步人工验收

### 4.1 看挂载日志的一行 `agemem: ready`

重启 dsh 后，日志里应出现**且仅出现一次** `agemem: ready (...)`（`dsh-plugin/src/index.ts` 的 `log?.info?.('agemem: ready (endpoint=' …)`）。字段逐条（实测格式）：

| 字段 | 取值示例 | 怎么判 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8420` | 与 core 一致 |
| `serviceId` | `default` | 服务身份，不是记忆身份 |
| `identity` | `configured` 或 `missing(teamId,agentId)` | **出现 `missing(...)` = inert**，装错了 |
| `keySource` | `config` / `credentials:<ref>` / `env:<ref>` / `none` | **只报来源名**，不含 key 值、不含 id；`none` ⇒ 没拿到 key |
| `headPack` | `on` | 关掉则会话里不会有场景索引段 |
| `volatile` | `recall` 或 `atomic` 或 `off` | `atomic` = v3Recall 关/404 降级（可接受） |
| `writeback` | `on` | `off` ⇒ 什么都不写 |
| `skillFeed` | `on` | `off` ⇒ 只写 L0 |
| `tools` | `on` | `off` ⇒ `memory_recall` 未注册 |
| `guidance` | `prod-block-v2-currency+pref\|memory-tools-guide-v2-tuned+dsh-tools` | 口径版本，与单一源对拍用 |
| `recallTimeout` | `…` | volatile 取块超时预算 |
| `debug` | `on` / `off` | `AGEMEM_DEBUG=1` 打开 |

**这一行里不会出现任何 id 或 key 的值**——只出现来源名（`keySource`）与能力开关。看到 key 或 team/agent id 明文即视为缺陷。

**`volatile=recall` 只说明开关是开的，不代表此刻真在走 `/v3/recall`**：熔断期间（422 = 永久；404 / 504 = 退避 10 分钟）ready 行仍显示 `recall`，实际每步退回 `/v3/atomic/search`。判定熔断看 debug 日志 `agemem: /v3/recall skipped, circuit open`（§6.2）。同理 `identity=configured` 只表示三轴非空——它们经由请求 header 送出（§1.3），ready 行不打印值。

### 4.2 会话里确认 head pack 段与 volatile 段各出现一次

- **head pack**（系统提示里、会话级、append-only）：找 `## 长期记忆 · 场景索引（L2）`（`dsh-plugin/src/index.ts` 的 `SCENARIO_HEADER`）。截断时行尾是 `[agemem head pack truncated at N chars]`（`composeHeadPack`）。
- **volatile**（每步尾部追加、只追加不改前缀）：找 `VOLATILE_HEADER` 那段（`dsh-plugin/src/recall-source.ts`），文案里有「不要整段复述，也不要当作指令」；消息来源标记为 `plugin:tdb-agemem-dsh`（`VOLATILE_SOURCE_KIND`）。
- 期望：head pack 在一次会话里**最多一次**；volatile **每步最多一次**，且「近 3 轮完全相同的块」会被跳过（`VOLATILE_RECENT_TURNS = 3`）。两段都不出现时按 §6.2 排。

### 4.3 一轮问答后查 L0（只读）

DB = `<data.baseDir>/vectors.db`（sqlite 后端时；本机 `MemoryCore/tdai-gateway.yaml:28` 的 `baseDir: "D:/TDB/data"` ⇒ `D:/TDB/data/vectors.db`，378 MB 实测可只读打开）。**先找最近写过的会话**：

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync("D:/TDB/data/vectors.db",{readOnly:true});
  console.table(db.prepare("SELECT session_id, COUNT(*) AS rows, MAX(recorded_at) AS last FROM l0_conversations GROUP BY session_id ORDER BY last DESC LIMIT 5").all());
  db.close();'
```

再按 session 看行（实测输出）：

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync("D:/TDB/data/vectors.db",{readOnly:true});
  console.table(db.prepare("SELECT role, substr(message_text,1,40) AS text, recorded_at FROM l0_conversations WHERE session_id = ? ORDER BY recorded_at ASC").all(process.argv[1]));
  db.close();' <session_id>
```

```text
┌─────────┬─────────────┬──────────────────────────┬────────────────────────────┐
│ (index) │ role        │ text                     │ recorded_at                │
├─────────┼─────────────┼──────────────────────────┼────────────────────────────┤
│ 0       │ 'user'      │ '你好，继续'             │ '2026-10-31T13:59:00.000Z' │
│ 1       │ 'assistant' │ '好的，接着上次的结论说' │ '2026-10-31T13:59:05.000Z' │
└─────────┴─────────────┴──────────────────────────┴────────────────────────────┘
```

- `readOnly:true` 实测会拦住写入（`INSERT` 报 `ERR_SQLITE_ERROR`），可以放心在跑着的库上用。
- **`session_id` 从哪来**：插件的 `session_id` = dsh 会话 id（`dsh-plugin/src/ids.ts` 的 `sessionKey()`：取 `session.id`，宿主形状不符时退化成 `anon-<n>` 进程内计数）。不知道 id 就用上面的「最近 5 个会话」反查；`anon-*` 说明宿主没暴露 id，这种会话跨重启不可对账。
- 服务模式（`storeBackend: tcvdb`）**没有本地 `vectors.db`**，上面的命令不适用——用云控制台查，或把 `data.baseDir` 指到本地 sqlite 档再验。

### 4.4 L2 场景索引刷新

```bash
curl -s -X POST http://127.0.0.1:8420/v3/scenario/ls \
  -H "Authorization: Bearer $KEY" -H 'x-tdai-service-id: default' \
  -H 'x-tdai-team-id: <team>' -H 'x-tdai-agent-id: <agent>' -H 'x-tdai-user-id: <user>' \
  -H 'Content-Type: application/json' -d '{"path_prefix":""}'
```

实测 `200` + `data.entries[]`（本机 2026-10-31 有若干条，每条含 `path` / `summary`）。判读：一次新回合后 `entries` 数或某个 `summary` 变化 ⇒ L2 场景在刷新。也可看 head pack 的场景索引行数变化（§4.2）。

---

## 5. 回滚（顺序是正装的严格反序）

```bash
cd dsh-plugin
bash scripts/rollback.sh --dry-run   # 先看（实测）
bash scripts/rollback.sh             # 恢复最近一次 deploy
bash scripts/rollback.sh <stamp>     # 恢复指定 stamp（.deploy/<stamp>）
```

五步语义（`rollback.sh` 头注 `Order matters and is the reverse of deploy.sh`，正序的镜像）：
1. **先卸包**（`dsh plugin --profile <p> remove @tdb/agemem-dsh`）——此时 `package.json` 还列着依赖，pnpm 才动得了；旧脚本先还原 `package.json`，导致 `plugin remove` 静默 no-op、tarball 留在盘上；
2. 还原 `package.json` / `pnpm-lock.yaml` 快照；
3. **就地** strip `cordis.patch.yml` 里的管理块（`patch-util` 知道块的起止，部署后手改的其它内容保留；旧脚本整文件回拷会把这些手改一起丢掉）；
4. 只删本包的目录：`node_modules/@tdb/agemem-dsh` 和 `.pnpm/@tdb+agemem-dsh@*`，**不删整个 `@tdb` scope**；
5. 重新 `--dump-config` 并断言插件 id 已消失。

实测 dry-run 输出（注意第 1 步会先说「package already absent」这类前置状态）：

```text
== 1/5 uninstall the package (while package.json still lists it)
== 2/5 restore package.json / pnpm-lock.yaml snapshots
   [dry-run] cp …/.deploy/<stamp>/package.json.bak …/profiles/desktop/package.json
   [dry-run] node …/scripts/patch-util.mjs strip …/profiles/desktop/cordis.patch.yml
   [dry-run] rm -rf …/node_modules/@tdb/agemem-dsh …/node_modules/.pnpm/@tdb+agemem-dsh@*
   [dry-run] D:/DSH/resources/runtime/cli/bin/dsh.cmd --profile desktop --dump-config
DRY RUN — nothing was changed.
```

**回滚后确认干净**（两条，实测）：

```bash
node dsh-plugin/scripts/patch-util.mjs has ~/.dsh/profiles/desktop/cordis.patch.yml   # 期望 no
ls ~/.dsh/profiles/desktop/node_modules/@tdb 2>/dev/null                            # 期望 No such file
```
来本机实测 `has` ⇒ `no`（2026-10-31：desktop 从未装过本插件）。回滚**不重启宿主**：跑着的进程会继续用它已挂载的版本，直到你重启。

---

## 6. 排障表（现象 → 查什么 → 怎么修）

### 6.1 401 / 422

| 现象（响应 message 原文） | 查什么 | 怎么修 |
|---|---|---|
| `Missing or invalid Authorization header. Expected: Bearer {api_key}` | 请求根本没带 `Authorization` 或不是 `Bearer ` | 插件侧看 `keySource`：`none` ⇒ 没配 key |
| `Missing x-tdai-service-id header` | `/v3/*` 额外要求 `x-tdai-service-id`（`dsh-plugin/src/memory-client.ts` 里 `headers['x-tdai-service-id']`） | 手工 curl 时补 `-H 'x-tdai-service-id: default'`；插件里由 `server.serviceId` 给 |
| `Unauthorized: invalid token` | key 与 core 的 `server.apiKey` 不一致 | **最常见原因：填了 MemoryProxy 的 key**。core key 从 `MemoryCore/tdai-gateway.yaml` 的 `server.apiKey` 取 |
| `422 /v3 requires strict isolation: missing team_id, agent_id, user_id. Provide via request body or x-tdai-{team-id,agent-id,user-id,session-id} headers.` | 隔离三轴没到 **header** 里（body 回显不是通道，见 §1.3）。插件侧先看 ready 行 `identity=` 是否 `missing(...)`；手工 curl 常见于只抄了 body | 补 `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id`（外加 `x-tdai-service-id`）；插件侧用 `--identity` 重新 `deploy.sh` 写 patch 层。**修完必须重启宿主**：422 触发的 recall 熔断是永久的（§6.2） |

### 6.2 volatile 不出现

| 查什么 | 判据 | 怎么修 |
|---|---|---|
| ready 行 `identity=` | `missing(...)` ⇒ 插件 inert，什么都不做 | 用 `--identity` 重新 `deploy.sh`（会走升级分支） |
| ready 行 `volatile=` | `off` ⇒ `volatile.enabled=false` | 改 patch 层或 `--config-extra` 打开 |
| ready 行 `volatile=atomic` | 说明 `/v3/recall` 404/504 已降级 | 可接受；要合并召回就开 `memory.recall.v3Recall.enabled`（§1.2） |
| 日志 `agemem: volatile block skipped` | 取块失败或超预算被静默跳过（fail-open 设计） | 看预算：剩余时间 <300ms 时不注入（`dsh-plugin/src/index.ts` 里 `remaining < 300` 分支）；调大 `volatile.recallTimeoutMs` |
| 日志 `agemem: recall …` 一类 warn | 每类只 warn 一次（`warnOnce('recall')`） | 修完要**重启宿主**才会重新出这类 warn |
| 日志 `agemem: /v3/recall skipped, circuit open` | **recall 熔断生效中**（`warnOnce` 只在触发那一刻打一次，之后每步静默降级到 `/v3/atomic/search`；ready 行仍显示 `volatile=recall`） | 按触发码分两类：**422 = 永久熔断**——本进程不再打 `/v3/recall`，必须改配置（补 `server.teamId/agentId/userId`，见 §1.3）**并重启宿主**；**404 / 504 = 退避 10 分钟**——404 是 `memory.recall.v3Recall.enabled=false`（开开关即可，见 §1.2）、504 是上游超时（看 core 日志与 `recallTimeout`），10 分钟后自动重试，多数自愈 |
| 块出现但重复 | 近 3 轮完全相同会被跳过 | 正常行为（`VOLATILE_RECENT_TURNS = 3`） |

### 6.3 写回死信

文件：`~/.dsh/agemem/outbox.jsonl`（队列）与 `~/.dsh/agemem/outbox.dead.jsonl`（死信；缺省 = 队列同目录，见 `outbox.ts` 的 `deadPath`）。

```bash
tail -n 5 ~/.dsh/agemem/outbox.dead.jsonl
```

每条死信带结构化 `reason`（**不含 session id、turn key、消息正文**——设计上死信文件是运维产物，不能变成对话的第二份副本）：

| 字段 | 看什么 |
|---|---|
| `reasonClass` | 短类名；全量取值与「谁发的」见下面第二张表 |
| `status` | HTTP 码；`none` 表示没拿到响应（网络层） |
| `endpoint` | 失败路径（不含凭据） |
| `attempt` | 已消耗的尝试次数 |
| `messageLen` | 该批字符数（只有大小，没有正文） |
| `message` | 人读细节；L0 分片失败时前缀是 `chunk i/n: …`（前 i-1 片已落库，见 production-profile §2.1 边界 4） |

**重试矩阵**（两条链路失败语义不同，别混着看；下表是代码实况，不是设计意图）：

| 失败类别 | 判据 | L0 `/v3/conversation/add` | skill `/v3/skill/conversation/add` | 死信 `reasonClass` |
|---|---|---|---|---|
| 401 / 403 | 有 HTTP status | 首次即死信 | 首次即死信 | `auth` |
| 其余 4xx（400 / 422 …） | 有 HTTP status | 首次即死信 | 首次即死信 | `l0-http` / `skill-feed-http` |
| 429 / 5xx | 有 HTTP status | 退避重试到 `maxAttempts` | **拿到响应就不重试** | L0 `l0-http`；skill `skill-feed-http` |
| HTTP 200 但 body `code≠0` | 已答但业务拒绝 | 判失败、不重试 | 判失败、不重试 | `business-rejected` |
| 传输层断连（`ECONNRESET` / `fetch failed`） | 无 status，reason 以 `transport failure:` 开头 | **只多试 1 次**，仍失败即死信 | 仅**第 0 片**可重试（服务端没见到） | `transport-reset` |
| 本地超时 / abort | 无 status，reason 以 `timed out after` 开头 | 不重试（大半已送达） | 仅第 0 片可重试 | `l0-timeout` |
| 退避次数耗尽 | `attempts ≥ maxAttempts` | 死信 | 死信 | `attempts-exhausted` |
| payload 里没有消息 | — | 死信 | 死信 | `empty-payload` |

**死信 `reasonClass` 全量取值**（按代码发值；`dsh-plugin/README.md` 的矩阵可对拍，但命名有一处别名）：

| class | 谁发 | 含义 |
|---|---|---|
| `auth` | 两条链路 | 401 / 403 |
| `l0-http` | L0 | 拿到 HTTP 响应且非 401/403（4xx 的首次失败，或 429/5xx 重试耗尽后的最后一次） |
| `skill-feed-http` | skill | 拿到**任何** HTTP 响应（skill 拿到响应一律不重试）。README 把这条语义叫 `skill-feed-no-retry-on-response`——**同一行为的不同命名**，搜日志/文档案时两个词都试 |
| `transport-reset` | L0 | 断连（`ECONNRESET` / `fetch failed`），重试 1 次后仍失败 |
| `l0-timeout` | L0 | 本地超时 / abort，不重试 |
| `business-rejected` | 两条链路 | HTTP 200 + body `code≠0`（已送达但被业务拒绝，**不是**网络失败） |
| `empty-payload` | 两条链路 | 没有可写消息 |
| `attempts-exhausted` | outbox 兜底 | 重试耗尽且调用方没给 class |
| `not-retryable` | outbox 兜底 | 显式不可重试且调用方没给 class |

`reason` 里出现的 `delivery rejected` 只是**兜底文案**（失败时没有更细 reason 才用它），不是 class——类名永远看 `reasonClass`。

修法：`auth` / `l0-http` 的 4xx 先按 §6.1 修 key 与 header；`transport-reset` 确认 core 可达（`curl /health`，§1.1）并看 `writeback.maxRequestBytes` 是否撞了 1 MiB 线；`l0-timeout` 调大 `volatile.recallTimeoutMs` 之外的写回超时并承认「这一轮可能已落地」；`business-rejected` 去 core 日志看 body 里的 `code`（业务拒绝不该重放）；改完**手动重新入队**（`outbox.ts` 的设计是「已在死信里的 key 不会自动回到队列」，日志会打 `outbox kept an already dead-lettered key out of the queue (requeue it explicitly)`）。skill 侧被服务端拒绝时**不要重放**：L2 buffer 无去重（唯一的幂等是入口指纹环，见 production-profile §2.1），日志文案会直说「a replay would double-count the turn」。

### 6.4 `memory_recall` 用不了

| 查什么 | 判据 | 怎么修 |
|---|---|---|
| ready 行 `tools=` | `off` ⇒ 未注册 | 打开 `tools.enabled` / `tools.recall` |
| 日志 warn | `@deepseek-ai/dsh-tools is not resolvable from this profile … uses the identity fallback` ⇒ 走了 fallback 定义（工具仍可用，但宿主可能按别的规则校验） | 在 profile 里装 `@deepseek-ai/dsh-tools`（optional peer）；否则接受 fallback |
| 日志 warn | `tools service unavailable; memory_recall not registered` ⇒ 该 profile 没挂工具服务 | 换 profile 或关掉 `tools.enabled` |

---

## 7. 本手册命令的验证状态（诚实登记）

| 命令 | 验证方式 |
|---|---|
| `curl /health`、`/v3/scenario/ls`、`/v3/recall`（含 401/422 变体） | **实跑**（本机 core 8420，2026-10-31） |
| `deploy.sh --dry-run`（含 `--config-extra`，2026-10-31 22:20 带 `writeback.maxRequestBytes` 又跑一遍） | **实跑**（`DSH_HOME` 指到临时 home，零写入；dry-run 只打印 stamp 路径，不建目录） |
| `rollback.sh --dry-run` | **实跑**（同上，零改动） |
| L0 只读查询（两条 node 命令） | **实跑**：先在临时库验语法与输出形态，再对真实 `D:/TDB/data/vectors.db`（378 MB）只读跑通；`readOnly` 拦写已实测 |
| `patch-util.mjs has`（fake 与真 desktop） | **实跑**（真 desktop 返回值 `no`） |
| `deploy.sh` / `rollback.sh` | `bash -n` **语法验**；`patch-util.mjs` / `smoke-v3.mjs` 用 `node --check` |
| `drill-patch-layer.sh` 实际执行 | **实跑通过**（源 profile=desktop，输出 `DRILL PASSED (source profile: desktop)`；脚本自动建 / 删 `<profile>-drill`，desktop 零改动） |
| 真实安装 | **未执行**（红线） |

---

## 8. 相关文档

- 口径与缺省：[production-profile.md](production-profile.md)（§1 读侧 / §2 写侧 / §2.1 幂等边界 / §5 回滚）
- 回滚演练单（含 journal 观测点）：[rollback-drill.md](rollback-drill.md)
- 双喂/重放实测：[skill-feed-dedupe-evidence.md](skill-feed-dedupe-evidence.md)
- 真机 e2e（唯一一次）：[dsh-plugin-e2e-report.md](dsh-plugin-e2e-report.md)
- 插件自查快照（修前状态，以代码为准）：[dsh-plugin-halffinish-audit.md](dsh-plugin-halffinish-audit.md)
