# dsh 原生记忆插件 · 真机 e2e 报告（第二轮 / agemem-e2e2）

- 日期：2026-11-01（Asia/Shanghai）
- 票：task-31（epic：dsh 原生记忆插件，GitHub issue #176）；上一轮见 `docs/ops/dsh-plugin-e2e-report.md`
- 被测代码：`dsh-plugin/` @tdb/agemem-dsh 0.1.0（task-37 收口态：recall 三轴 header、字节预算、timestamp 归一、business-code 判定）
- 结论：7 条验收证据中 **6 条真机实测通过**；字节墙按 Lead 口径只做单测证明、不跑真机长回合。另发现 6 条需后续处理的偏差（§5）。

## 1 环境与方法

| 项 | 值 |
| --- | --- |
| 宿主 | D:/DSH/resources runtime，`dsh.cmd headless` 一次性运行；**全程未重启正在跑的 desktop 宿主** |
| 隔离 profile | `agemem-e2e2`，现建：`dsh.cmd agemem-e2e2 --from-default-profile headless --dump-config`，测后整目录删除 |
| 插件装配 | `cd dsh-plugin && DSH_PROFILE=agemem-e2e2 bash scripts/deploy.sh --skip-tests --identity <team>,<agent>,<user>`（stamp 20261031-221449；`dsh plugin add file:…tgz` + patch insert；dump-config 可见 `- id: tdb-agemem-dsh`） |
| 回滚 | `DSH_PROFILE=agemem-e2e2 bash scripts/rollback.sh`（dump-config 不再含插件）→ 删整个 profile 目录 |
| 模型 | llm-pi-ai 增 scm provider（`http://10.16.235.171:50003/v1`，scm-flash）；agent-default-model 指 scm/scm-flash |
| 记忆后端 | MemoryCore `http://127.0.0.1:8420`（真实 core，非 mock）；LLM 流量直连 scm，不经 tdb 代理 |
| 日志 | headless bundle 无任何 logger exporter ⇒ 自写 shim `scratch/e2e2/logger-shim.mjs` 接 `ctx.logger.exporter`（`levels.default=6`），逐行进 stderr |
| 取证工具 | L0：`scratch/e2e/query-l0.mjs`（readonly sqlite `D:/TDB/data/vectors.db`）；会话：`scratch/e2e/decode-session.mjs`；skill buffer：`D:/TDB/data/skill_buffer/…`；recall 直连：`scratch/e2e2/fetch-recall.mjs`（原生 fetch，不 import 插件代码） |

### 运行清单（8 次，每次一句话任务；4 次是 fallback 试错）

| run | 目的 | session | 备注 |
| --- | --- | --- | --- |
| 1 | 首次试跑 | session-745d06d9 | 失败：`MISSING_CREDENTIAL: llm-deepseek: no API key for provider route deepseek-official`（未加 model overlay） |
| 2 | 加 model overlay、未加 shim | session-41fdc1b4 | 成功，但无插件日志 |
| 3 | shim `levels.default=0` | session-156493ad | 仍无日志：threshold 把全部挡掉 |
| 4 | shim 改 `levels.default=6`，第 1 轮 | session-54968049 | 日志可见 |
| 5 | 同会话第 2 轮 | session-54968049 | 验证多轮 |
| 6 | 正例：recall 供料 | session-19a1c046 | 证据②主证 |
| 7 | 反例：`volatile.recall=false` | session-f8dc723c | 第二层 patch 覆盖 |
| 8 | 反例：故意配错 apiKey | session-d2dca358 | 证据⑦ |

> 反例没另建 profile，而是同 profile 叠第二层 `--patch`（`scratch/e2e2/cfg-no-recall.yml` / `cfg-bad-key.yml`，由 `scratch/e2e2/make-patch.mjs` 从 managed block 生成**完整 config**）。原因：宿主 patch 的 `- id: <entry>` 是**整体替换** config、不是深合并；同 profile 换 overlay 可把「唯一变量是 volatile.recall / apiKey」锁死。
## 2 七条验收证据

### ① ready 行存在、恰好一条、不含任何 id/key 值

run5/6/7/8 各**恰好 1 条**（每进程一次）：

    agemem: ready (endpoint=http://127.0.0.1:8420, serviceId=default, identity=configured, keySource=config, headPack=on,volatile=recall,writeback=on,skillFeed=on,tools=on, guidance=prod-block-v2-currency+pref|memory-tools-guide-v2-tuned+dsh-tools, recallTimeout=2s, debug=on)

run7 同一条但 `volatile=atomic`（配置确实生效）。泄漏断言（run5/6/7/8 的 stderr）：

    grep -c -E '<team-id>|<agent-id>|<user-id>|<core-key>' scratch/e2e2/run{5,6,7,8}.err
    → 全部 0

> 本报告把身份三元组与 core key 一律脱敏成 <team-id> / <agent-id> / <user-id> / <core-key>；运行时用的是真值。

### ② volatile 真的来自 /v3/recall（+ 反例对照）

**正例 run6**（session-19a1c046）插件自报读数：

    agemem: volatile block ready {"recallMs":1396,"cacheHit":false,"prefetched":false,"source":"recall","injectedChars":863,"entriesKept":4}

注入消息（`source.kind=plugin:tdb-agemem-dsh`，id `agemem-volatile-1`）里 4 条全部以 `- [` 开头，长度 135 / 182 / 229 / 261 字符（均 ≤360，未触发截断故无省略号）：

    - [结论|reflection] 我把『先查后问』立为处理需求的缺省次序：先阅仓内文档/代
    - [上下文|reflection] 用户要求 AI 处理需求时遵循「先查后问」：先阅读仓内
    - [work_fact|reflection] deck-autopilot #9（p1-
    - [work_fact|reflection] 我把前置取证用作反编造门：动手前先锚定关键

**跨源交叉取证**（同一时刻用原生 fetch 直打 core，不经过插件代码）：

    node scratch/e2e2/fetch-recall.mjs 'headless 用一句话说明你知道我的项目在做什么' scratch/e2e2/run6-block.txt session-19a1c046-… 3
    → status 200 · 119ms · blockChars 4614 · entryLines 12 → 4/4 注入条目「前 40 字符」HIT

**反例 run7**（`volatile.recall=false`，session-f8dc723c）：ready 行 `volatile=atomic`，读数 `{"recallMs":763,"source":"atomic","injectedChars":1090,"entriesKept":6}`；6 条全是 `- [work_fact] …`（**没有** `|reflection` 这种 recall 分层标签，条目内容也不同），长度 166/148/137/136/258/187。

→ 两条链路产物形态可区分，说明 recall 链路真的被走通，而不是「凑巧都能注入」。

### ③ 可见回答进 L0，reasoning/CoT 不进

L0（`D:/TDB/data/vectors.db` readonly 查询）：

| 行 | session | role | 字符 | 开头 |
| --- | --- | --- | --- | --- |
| #13313 | session-19a1c046 | assistant | 153 | 你的项目 td-agemem 是一套本地自托管的「自进化记忆系统」… |
| #13311 | session-54968049 | assistant | 74 | 先修 L1 记忆管道的召回精度（提案洪泛，77.7% 噪音…） |
| #13315 | session-f8dc723c | assistant | 226 | 你的主线项目是跑在 D:/TDB/td-agemem 的 TDB 自进化记忆系统… |

三行都以**真实答案**开头，没有 `The user asks` / `Thinking Process` 这类 CoT 前缀。

**反例（宿主确实会产出 reasoning）**：同批会话解码后，assistant/message 的 content parts 是 `[reasoning, text]`（run6 还有一步 `[reasoning, tool-call]`；run5 两轮均 `[reasoning, text]`）。即：宿主给的原始内容里 reasoning 与可见答案**同时存在**，插件只取了 `text` part。

### ④ skill 第二链路不翻倍（每轮只进一次）

路径 `D:/TDB/data/skill_buffer/<usr>/<team>/<agt>/<sessionId>/`：

| run | 轮数 | buffer 消息 | 说明 |
| --- | --- | --- | --- |
| 5 | 2 | 4 = user,assistant,user,assistant | 每轮恰好 2 条，线性增长 |
| 6 | 1（含 1 次工具调用） | 4 = user,assistant,tool_call,tool_result | meta `tool_call_count:1`、`byte_count:14705`；文本 timestamp 是 **number**，tool 两条 timestamp 缺省（schema 允许） |
| 7 | 1 | 2 = user,assistant | `byte_count:648` |
| 8 | 1（401） | **无目录** | 被拒的写入从未进 buffer |

→ 「同 payload 投两次会让 buffer 翻倍」的风险没有发生；配合 task-28 的「拿到任何 HTTP 响应即死信、不重放」，L2 侧不会被重复计数。

### ⑤ 注入内容不泄漏进 L0

每次 L0 查询都带 `injection leakage rows: 0` 断言（markers：`【agemem 记忆提示】`、`agemem-volatile`、`User Narrative Profile`、`memory-tools-guide`）。八次运行全部 0。

### ⑥ head pack：14 行场景索引、无截断标记

run5/6/7 的 `system/message`：总长 **8437** 字符、以 `- scene_blocks` 开头的行 **14** 条、不含 `head pack truncated`、不含 `Summary:`。样例行：

    - scene_blocks/AI-工程纪律-TDD与交付规范.md（热度 356，更新 2026-10-29）

run8（401）对照：总长 3496、0 条场景行 —— core 拒绝时 fail-open，不注入半截人格。

### ⑦ 401 可诊断（故意配错 key）

run8 首条 warn 逐字：

    agemem: the core rejected the API key (HTTP 401 on /v3/core/read). Set server.apiKey, or make server.apiKeyRef (TDAI_GATEWAY_APIKEY) resolve to the core's own server.apiKey — the MemoryProxy key is a different secret. Memory stays disabled for this process (fail-open, no retry storm).

后续同类 401（core/read 再 2 次、recall 2 次）**不再重复**这条。其余分类各一条：

    /v3/recall failed (HTTP 401): falling back to /v3/atomic/search
    conversation write rejected (HTTP 401 on /v3/conversation/add); not retried on an HTTP response
    outbox moved an entry to the dead letter file after 1 attempt(s) (class=auth, endpoint=/v3/conversation/add, status=401, dead=…/outbox.dead.jsonl)
    skill write rejected (HTTP 401 on /v3/skill/conversation/add); not retried … the L2 buffer has no dedupe …

死信两行 reason（L0 与 skill 各一条）：

    {"reasonClass":"auth","endpoint":"/v3/conversation/add","status":401,"attempt":1,"messageLen":17,"message":"HTTP 401"}
    {"reasonClass":"auth","endpoint":"/v3/skill/conversation/add","status":401,"attempt":1,"messageLen":17,"message":"HTTP 401"}

→ 含 endpoint + status + 可执行建议；**不含** session/turn/正文/key。

### 附：字节墙（按 Lead 口径，只做单测证明）

未做真机长回合。依据：core `server.ts` 在 1 MiB 处先 reject 再 `req.destroy()`，客户端只看到 ECONNRESET；真机实测 0.9 MB 通过、L0 1.05/1.2 MB 与 skill 3.75 MB 全部断连。插件侧由 `test/wire-limits.test.ts` + `test/memory-client.test.ts` 保证：按 `Buffer.byteLength(JSON.stringify(body))` 实测分片（预算 700000；单条超预算按字节二分裁、code point 安全）。

## 3 完整数据流（注入 → 写回）

    agent/created ─ prewarm recallBlock('warmup') + readCore
    agent/pre-step ─ 用 sessionId+turn 取 key → RecallCache / RecallInflight → /v3/recall
                     → <relevant-memories> 只留 - [ 行 → 逐条裁 360 → 装填 ≤1200
                     → 追加 1 条 user 消息（source.kind=plugin:tdb-agemem-dsh）
    session/event assistant/message ─ content parts 只取 text/output_text（丢 reasoning）
    agent/turn-stopping ─ TurnWritebackPayload{kind:'l0'}    → /v3/conversation/add（ISO timestamp）
                        └ SkillWritebackPayload{kind:'skill'} → /v3/skill/conversation/add（epoch ms，含 tool 对）
    outbox 幂等键 <session>:turn:<N> / <session>:turn:<N>:skill；失败退避；4xx/401 首死信

## 4 复现命令

    # 1) 建隔离 profile 并部署插件
    dsh.cmd agemem-e2e2 --from-default-profile headless --dump-config
    cd dsh-plugin && DSH_PROFILE=agemem-e2e2 bash scripts/deploy.sh --skip-tests --identity <team>,<agent>,<user>

    # 2) 正例
    bash scratch/e2e2/run.sh scratch/e2e2/run6.json scratch/e2e2/run6.err --json '用一句话说明你知道我的项目在做什么'

    # 3) 反例：关掉 recall（叠第二层 patch）
    EXTRA_PATCH=scratch/e2e2/cfg-no-recall.yml bash scratch/e2e2/run.sh scratch/e2e2/run7.json scratch/e2e2/run7.err --json '用一句话说明你知道我的项目在做什么'

    # 4) 反例：错 key
    EXTRA_PATCH=scratch/e2e2/cfg-bad-key.yml bash scratch/e2e2/run.sh scratch/e2e2/run8.json scratch/e2e2/run8.err --json '只回复 ok'

    # 5) 取证
    node scratch/e2e/decode-session.mjs ~/.dsh/sessions/--D-TDB-td-agemem--/<sid>/session.v4.jsonl.zstd /tmp/<sid>.jsonl
    node scratch/e2e2/dump-volatile.mjs /tmp/<sid>.jsonl
    node scratch/e2e/query-l0.mjs <sid-frag>
    node scratch/e2e2/fetch-recall.mjs '<同一句问话>' /tmp/block.txt <sid> 3

    # 6) 收尾
    cd dsh-plugin && DSH_PROFILE=agemem-e2e2 bash scripts/rollback.sh
    rm -rf ~/.dsh/profiles/agemem-e2e2
## 5 发现的偏差（需后续处理）

| # | 现象 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | 每次 mount 都打 `agemem: head pack has no parseable scene index; falling back to bare truncation`，但产物正确（14 行） | 纯误导日志：读日志的人会以为结构化失效 | `composeHeadPack(compressHeadPack(text))` 里第二次 `structureHeadPack` 解析的是**已压缩文本**（压缩产物没有 `### Path:`）⇒ 重复解析。另立票：只解析一次，或对已压缩产物跳过检查 |
| 2 | ready 行 `recallTimeout=2s`（实际 1500ms） | 按秒取整会误判预算 | 改成毫秒或保留一位小数 |
| 3 | 所有 run 的 `prefetched:false`、`cacheHit:false` | task-30 设计的「user/message 预取 + pre-step 复用」真机**没生效**，recall 仍卡本轮关键路径 | 宿主 `session/event` 的 `user/message` 派发晚于当轮 pre-step ⇒ 预取拿不到本轮 user 文本。要么用**上一轮**文本预取，要么接受 await 并压低预算（见 #4） |
| 4 | run6 内 `recallMs:1396` 顶着 1500ms 上限；run5 冷态 1580ms 直接降级；同查询直连只要 95–119ms | 预算余量极薄，长尾稳定退化成 atomic | 需 Lead 决策：提高 recallTimeoutMs（代价是最坏等待）或到 core 侧查 l1 embedding RTT（perfMs.l1 2180–2220ms 占 97%） |
| 5 | headless 组合没有 `tools` 服务 | `memory_recall` 未注册（每次 warn 一条），真机工具路径不可验 | 环境事实，非缺陷；工具路径留待有 tools 服务的 profile 验证 |
| 6 | scm provider 未配 key 时首跑 `MISSING_CREDENTIAL` | 与本插件无关 | `run.sh` 已内置从 `~/.dsh/.credentials.yaml` 读 `SCM_API_KEY` 并 export |

## 6 本次 e2e 写进 L0 的行（便于核对/清理）

全部由插件经 `/v3/conversation/add` 写入（身份 team-…/agt-…/usr-…）：

| 行 | session | role | 字符 |
| --- | --- | --- | --- |
| #13299 | session-745d06d9 | user | 26 |
| #13302 | session-41fdc1b4 | user | 26 |
| #13303 | session-41fdc1b4 | assistant | 206 |
| #13306 | session-156493ad | user | 15 |
| #13307 | session-156493ad | assistant | 2 |
| #13308 | session-54968049 | user | 26 |
| #13309 | session-54968049 | assistant | 171 |
| #13310 | session-54968049 | user | 21 |
| #13311 | session-54968049 | assistant | 74 |
| #13312 | session-19a1c046 | user | 26 |
| #13313 | session-19a1c046 | assistant | 153 |
| #13314 | session-f8dc723c | user | 26 |
| #13315 | session-f8dc723c | assistant | 226 |

run8 全部 401 ⇒ 0 行；run1 只有 user 行（该轮因 LLM 缺凭证以 error 结束，写回按设计走 error 回合、不含 assistant）。

## 7 清理清单（已执行）

- `cd dsh-plugin && DSH_PROFILE=agemem-e2e2 bash scripts/rollback.sh` → dump-config 不再含 `tdb-agemem-dsh`
- `rm -rf ~/.dsh/profiles/agemem-e2e2`
- `rm -f scratch/e2e2/cfg-no-recall.yml scratch/e2e2/cfg-bad-key.yml`（含明文 apiKey）
- `dsh-plugin/.deploy/20261031-221449/`（本次 deploy 的 state，`entry.yml`/`dump-config.yml` 含明文 core key）→ **已删除**；同时删了 `.deploy/last` 指针（profile 都没了，没有可回滚对象）
- `scratch/e2e2/dump-with-logger.yml` 里的 core key 已脱敏成 `<redacted-core-key>`
- `~/.dsh/agemem/outbox.dead.jsonl`（run8 的 2 条 auth 死信）保留给 Lead 复核后手动删除 —— 死信里只有 reasonClass/endpoint/status/messageLen，无正文；`outbox.jsonl` 为空

**仍未清的明文 key（不是本次 e2e 产生，请对应 owner 处理）**：

- `dsh-plugin/.deploy/20261031-213325/dump-config.yml`（上一轮 panel e2e 的 deploy state）
- `scratch/dedupe/probe.mjs`、`scratch/dedupe/probe2.mjs`、`scratch/probe-recall-fit.cjs`、`scratch/probe-recall-lines.cjs`、`scratch/probe-render-clip.mjs`、`scratch/e2e/profile-patch.before-cleanup.yml`

（都在 `.gitignore` 覆盖范围内，但仍是磁盘上的明文 key。）

## 8 desktop（正在运行的宿主）零痕迹断言

    grep -c 'tdb-agemem-dsh' ~/.dsh/profiles/desktop/package.json      → 0
    grep -c 'tdb-agemem-dsh' ~/.dsh/profiles/desktop/cordis.patch.yml  → 0
    ls ~/.dsh/profiles/desktop/node_modules/@tdb                       → 不存在

本次全程未重启 desktop 宿主；只有 `agemem-e2e2` 被安装与删除。

## 9 本轮顺带修掉的脚本 bug（收尾时被证据逮到）

rollback 后第一次 `--dump-config` 失败：

    Error: dsh: overlay C:/Users/Administrator/.dsh/profiles/agemem-e2e2/cordis.patch.yml must be a top-level YAML array of loader patch entries

根因：profile 现建时 `cordis.patch.yml` 结尾是 `[]` 种子行，deploy.sh 在追加 block 前会把这一行删掉（`[]` 后面接 block 不是合法 YAML）；rollback 的 strip 只删自己的 block、**没把种子补回去**，于是文件只剩注释 → YAML 解析成 null → 宿主拒绝启动。

修法（`dsh-plugin/scripts/patch-util.mjs`）：新增 `hasArrayContent(text)` 与 `restoreArraySeed(text)`，CLI 的 `strip` 在删除区域后若文件已无任何 YAML 条目则补回 `[]`；若还有别人的条目则原样不动（不劫持）。新增单测 `test/patch-util.test.ts > restores the [] seed when stripping emptied the array`（含幂等与「有其它条目时不动」两条断言）。

复查：修完后重跑 rollback → `verified: composition no longer contains tdb-agemem-dsh`，patch 文件恢复为注释 + `[]`。

## 10 读数

- `npx tsc -p tsconfig.json --noEmit` → TSC_EXIT=0
- `npx vitest run` → **15 files / 221 tests 全绿**（220 → +1：上面的 patch-util 用例）
- `npm run build` → BUILD_EXIT=0
- `git status`：全部改动仍在工作区，未 commit（`dsh-plugin/` 整个目录仍是未跟踪状态）
