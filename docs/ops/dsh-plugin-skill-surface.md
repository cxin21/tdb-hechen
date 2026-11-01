# dsh-plugin 技能面（task-72）实现与验证

日期：2026-11-01 · 归属：dsh-plugin（@tdb/agemem-dsh 0.1.0）· 票：task-72

## 1. 做了什么

| 面 | 落地物 | 说明 |
| --- | --- | --- |
| 注入标记同源 | `dsh-plugin/src/injection-markers.ts` | 9 条文本标记 + `INJECTED_KIND` + `AGEMEM_MESSAGE_ID_PREFIX`；`src/writeback.ts` 改为 import，task-79 的三条判据不变（30 例全绿） |
| core skill 协议客户端 | `dsh-plugin/src/skill-client.ts`（约 420 行） | 17 条路由常量、读 5 方法、写 6 方法、全部写口内部 RMW（读 version → 带 `expected_version` 写 → 40901 重读重试一次） |
| 段注册缝 | `dsh-plugin/src/segments/registry.ts`、`segments/index.ts` | `registerHeadPackSegment` / `registerVolatileSegment`，统一做 cap / `tag-safe` / 总预算与段尾丢弃；新增能力只加文件 + barrel 一行 import |
| 技能段 | `dsh-plugin/src/segments/skills.ts` | `<available_skills>` 逐字取 `/v3/skill/listing` 的 `data.listing`（不在本地拼），cap 8000，`truncate:'tag-safe'`，失败零字符 + `skills=failed:0` |
| 工具注册缝 | `dsh-plugin/src/tools/registry.ts`、`tools/index.ts` | `registerToolModule({name, enabled(config), build(deps)})`；`index.ts` 只遍历模块 |
| 10 个技能工具 | `dsh-plugin/src/tools/skills.ts` | 只读 4（`skill_search`/`skill_view`/`skill_files_read`/`skill_extract`）+ 写 6（`skill_create`/`skill_update`/`skill_patch`/`skill_delete`/`skill_files_write`/`skill_files_remove`），写 6 受 `skill.allowLlmWrite`（缺省 false）门控 |
| 配置 | `dsh-plugin/src/config.ts`、`config-schema.ts` | 新 `skill` 段（enabled/allowLlmWrite/headPackChars/searchTopK/maxResultChars/timeoutMs）；`headPack.maxChars` 8000 → 20000（一次/会话，分段配额见 README）；设置页自动出现 `skill.enabled`/`skill.allowLlmWrite`/`skill.headPackChars`（VOLATILE_PATHS 21 条） |
| 装配 | `dsh-plugin/src/index.ts` | `SkillClient` 构造（call 缝 = `MemoryClient.v3`）、`runHeadPackSegments` 组 head pack、`enabledToolModules` 逐个注册、ready 行加 `skill=on(read)` / `on(write)` / `off` |
| 组合逻辑抽离 | `dsh-plugin/src/head-pack-compose.ts` | persona 段要复用 `composeHeadPack`，抽文件避免 segments ↔ index 循环 import；`index.ts` 原样 re-export，既有测试不动 |

## 1.5 注册缝（task-96 / task-97 的插入点，Lead 要的两行展开）

两处缝都是「加文件 + barrel 一行 import」，**不改 `src/index.ts`**。

### 段缝 `dsh-plugin/src/segments/registry.ts`（head pack 与 volatile 各一套）

| 缝 | 签名（逐字） | 单位 |
| --- | --- | --- |
| head pack | `registerHeadPackSegment(spec: HeadPackSegmentSpec)`；spec = `{ name, order?, cap: number | 'remainder', truncate?: 'tag-safe', enabled?(config), fetch(deps: SegmentDeps) }` | 字符（`cap` 是该段上限；`'remainder'` = 总预算减其它固定段） |
| volatile 附加段 | `registerVolatileSegment(spec: VolatileSegmentSpec)`；spec = `{ name, order?, cap?, enabled?(config), fetch(deps) }` | 字符（`cap` 缺省 = 吃剩余量） |
| 统一执行 | `runHeadPackSegments(deps, totalChars)` / `runVolatileSegments(deps, capChars)` → `{ text, segments: SegmentStatus[] }` | `SegmentStatus = { name, chars, truncated, status: 'ok' \| 'empty' \| 'failed' \| 'skipped' }` |
| 诊断串 | `segmentSummary(segments)` → `persona=ok:4600 skills=failed:0` | 每个 runner 的 debug 行都用它 |

- `SegmentDeps = { client: MemoryClient; config: AgememConfig; log?: LoggerLike; skillClient?: SkillClient; sessionId?: () => string | undefined; query?: string }`；`query` 只有 volatile 运行器填（= 本轮用户原文，wiki/knowledge 用它检索），head pack 里恒 undefined。
- `SegmentResult = { text: string; chars: number; truncated?: boolean; failed?: boolean }`；返回 `null` 等同「本段无内容（empty）」，`failed:true` 才是「能力到了但调用失败」（区分 `skills=failed:0` 与 `skills=empty:0`，两种运维动作不同）。
- 预算键：head pack 总预算 = `config.headPack.maxChars`（缺省 20000）；volatile 记忆块 = `config.volatile.maxChars`（缺省 1500，soul 先切片）。段自有预算：`core_memory` 3000（硬编码在段声明）、`skills` = `config.skill.headPackChars`（缺省 8000）、`knowledge` = `config.volatile.knowledge.maxChars`（3000）、`wiki` = `config.volatile.wiki.maxChars`（800）。volatile 附加段的预算是**剩余量**，不是两个 cap 相加：`volatile.maxChars` 先被记忆块消费，wiki（order 50，自重 cap 800）再 knowledge（order 60，自重 cap 3000）依次拿剩下的，每段实际上限 = `min(本段 cap, 剩余量)`（`src/segments/registry.ts` 的 `remaining`）。head pack 溢出从**段尾**丢（`skipped`），不截前缀。
- 内置段（当前）：`persona`（order 10，cap `'remainder'`）、`skills`（order 40，cap 8000，`truncate:'tag-safe'`，开闭标签必须成对）；volatile 侧尚无内置段（wiki/knowledge 接线后：`wiki` order 50、`knowledge` order 60）。
- 失败 reason 词表（模块自己打 debug，段层只记 `failed:true`）：wiki = `disabled / empty_query / no_identity / transport / bad_envelope / http_<status> / bad_payload / no_hits / deadline_empty / deadline_hit / budget_zero / circuit_open`；knowledge = `disabled / no_identity / transport / http_<status> / bad_envelope / bad_payload / empty_list / budget_zero / circuit_open`；skills 只有段层 `failed:true`（具体 code 在 core 应答里，debug 行给 `error`/`code`）。

### 工具缝 `dsh-plugin/src/tools/registry.ts`

| 项 | 值 |
| --- | --- |
| 注册 | `registerToolModule({ name, enabled(config): boolean, build(deps: ToolModuleDeps): ToolDefinitionShape[] })` |
| deps | `{ client: MemoryClient; config: AgememConfig; log?: LoggerLike; skillClient?: SkillClient; sessionId?: () => string | undefined }` |
| 装配 | `src/index.ts` 只跑 `enabledToolModules(config)` 并对每个 `ToolDefinitionShape` 调 `tools.register`（失败 warn 不中断） |
| 门控 | 模块级 `enabled(config)`（例：`skill.allowLlmWrite` 缺省 false ⇒ 技能模块只 build 4 个只读工具） |
| 宿主硬规则 | `parameters` 必须是整份 JSON Schema（`type:'object'`）；可选属性必须**整条省略** `required`（写 `required:false` 会让宿主抛 `UNSUPPORTED_SCHEMA` 并丢掉整个工具）；工具名每进程注册一次 |
| 失败词表 | 模块自定义，约定「原文回给模型」：`skill_search failed (code 40001): SKILL_SCHEMA_INVALID: …`；knowledge 侧多一个 `bad_tool`（不在 `/tools/list` 里的工具名，发请求前拒） |
| 插入 | 新模块 `registerToolModule(...)` + `src/tools/index.ts` 加一行 `import './<name>.js';` |
## 2. 协议事实（写死在实现里，均有源码锚点）

- 五个写路由都要求 `expected_version`：`MemoryCore/src/gateway/skill-schemas.ts:101 / :108 / :117 / :182 / :189`；缺参数是 HTTP 200 + `code 40001`。
- core 自带的 MCP 注入器 `MemoryCore/src/gateway/skill-tools-injector.ts:108-144` 的 body **没带** `expected_version` ⇒ 那些写工具是 200+40001 的半残品，**不可照抄**。
- `get-by-name` 的 schema 无 header 合并（`skill-schemas.ts:143-152`）：三轴 `user_id/team_id/agent_id` 必须进 **body**；插件同时仍发三轴 header（服务端路由前置校验用）。
- `listing` 返回渲染好的 `<available_skills>` 文本：`char_budget 6000 → 6004 字符`、`64000 → 9680`，`data.hits` 固定 20 条 `{skill_id,version,name}`。
- 成功判定只看 `body.code === 0`；失败文案优先用 core 的 `message`，退 `reason`。

## 3. 偏差（有意为之，逐条说明）

1. **`skill_extract` 走 `/v3/skill/conversation/force-archive`**（body `{session_id, reason?}`），不是 `/v3/skill/extract`：后者 schema 要 1..500 条 `messages`，插件不持有该缓冲；`50301`（未接线）原文回给模型。
2. **`skill.allowLlmWrite` 缺省 false**：只注册 4 个只读工具；开启后 10 个全注册。理由：写口会改团队共享 state，默认不可逆操作不放开。
3. `skill_view` 结果截断下限是 **1000 字符**（`truncateForTool` 的 `Math.max(1000, maxChars)`），不是配置值本身——配置 `maxResultChars: 120` 实际按 1000 截断。
4. `headPack.maxChars` 从 8000 提到 20000：Lead 定档「一次/会话 + compaction 后重注」，`refreshMs` 只刷缓存。若后续有人改回「周期重注」，这个 20000 立刻变成上下文污染源，README 已写死这条依赖。

## 4. 验证读数

### 4.1 静态与单测

| 项 | 读数 |
| --- | --- |
| `node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | EXIT=0（09:56 与 09:57 两次） |
| `npm run build` | rc=0（09:57，dist 产出） |
| 全量 vitest（task-72 收口） | **36 files / 632 tests passed**，48.88s（09:57:33） |
| 全量 vitest（task-72 开工时基线） | 36 files / 626 tests（+6：skill-client 4 条、head-pack 1 条、index 1 条） |
| 全量 vitest（本文件首次成文时） | 29 files / 519 tests passed（02:48:04；那是并行队友还在加 knowledge 用例的中间态，只作历史留档） |
| 全量 vitest（前一跑，对照） | 28 files / 500 tests，499 passed，唯一红是 `test/index.test.ts:505 mirrors the log into a file only when debug is on` 超时 10000ms（单跑 1.73s 绿，见 §6） |
| `test/index.test.ts + test/segments.test.ts` | 68 passed（新增两条 head pack 技能段用例） |
| `test/skill-client.test.ts` | 13 passed（含 40901 重读重试调用序 get/patch/get/patch、二次 stale 原样回报） |
| `test/skills-tools.test.ts` | 14 passed（4 只读工具 schema 过宿主校验器子集；写 6 受开关门控；截断标记带原始长度） |

### 4.2 真实 socket 全链（`dsh-plugin/scripts/verify-skills.mjs`）

8420 于 2026-11-01 02:13 后无监听（watchdog 三次重启预算耗尽，err 全是 LLM `2067 Token Plan 用量上限`），按 Lead 口径**不许重启**。因此本票用脚本内置的「core 契约垫片」（真 `node:http` server，同 `expected_version` 规则与同信封）跑真 socket 全链，**并保留 `--base-url/--api-key` 直连真 core 的入口**：

```bash
cd dsh-plugin
node scripts/verify-skills.mjs                      # 本机垫片（本轮实跑）
node scripts/verify-skills.mjs --base-url http://127.0.0.1:8420 --api-key <core server.apiKey>   # 8420 恢复后复核
```

本轮实跑（distSha `041db7850297`）：

```text
skill_create      → created probe-dsh-skill-8e28b823 [skl-probe-0001 v1] (version 1)
skill_search      → 1. probe-dsh-skill-… [skl-probe-0001 v1] score=12.88
skill_view(name)  → v1（body + manifest）
skill_patch       → patched … v2                    ← 写口 RMW：读 v1 带 expected_version=1
skill_files_write → wrote 1 file(s) … v4            ← 垫片对第 2 次写强制 40901 ⇒ 插件重读 v3 重试成功
skill_files_read  → scripts/a.mts (19 bytes) + 内容
skill_update      → updated … v5
skill_files_remove→ removed 1 file(s) … v6
skill_delete      → deleted … v6
skill_view        → skill_view failed (code 40401): SKILL_NOT_FOUND: no skill skl-probe-0001
（长正文用例）skill_view → [truncated: showing 1000 of 1607 chars; call skill_files_read …]
```

汇总行：`{"steps":13,"writesWithVersion":6,"staleRetryProven":true,"deleteConfirmed40401":true,"truncationProven":true,"headerViolations":[],"ok":true}`

垫片同时逐请求校验 `x-tdai-team-id / x-tdai-agent-id / x-tdai-user-id` 与 `Authorization: Bearer`：**0 违规**，证明 v3 缝的 header 路径没在 skill 面上失守。

### 4.3 未真机复核（**02:xx 那轮的记录；8420 恢复后见 §4.4**）

- **真 core 基线没跑**：票面要求的 `skill_search` 基线（query「采购订单 行号」→ top1 `ncc-ct-to-order-generation-chain` / score 12.88 / 86ms）与 `skill_view content 30318 字符`、`skill_files_read skl-2Un5xJjHBU0Y 的 overlap-snapshot.mts（2000 字节）` 都**未**在本轮复核——8420 宕机。脚本里 `score=12.88` 是垫片照着基线形状写死的常量，**不是**真 core 读数，不得当基线用。
- **`tool/ptc-dispatch` 证据**：本会话宿主只暴露 `run_code`（`request/header.tools` 恒 1 项），且 desktop 仍跑旧 build（`2c72dbae5911`），10 个工具尚未装进任何运行中的宿主 ⇒ 无 ptc-dispatch 行可引。等一次 build+装+重启后，用 `grep -c 'tool/ptc-dispatch'` 与 `skill_search` 的调用来补这条证据。

### 4.4 真 core 对拍（2026-11-01 09:4x；8420 已恢复，走插件自己的 client）

脚本 `scratch/e2e-skill/accept.mjs`：`import` 插件的 `dist/{config,memory-client,skill-client}.js`，用 `DEFAULT_CONFIG.paths`、真 key（`~/.dsh/.credentials.yaml` 的 `TDAI_GATEWAY_APIKEY`）、`userKey:'hechen'`、identity `team-2k12lgb650 / agt-2m7buribzz / usr-2m7b1144d9`，`new SkillClient({ call: (p,b) => client.v3(p,b), timeoutMs })`。**不是**另写的探针：每个写口都走插件自己的 RMW 与 body 构造。

| 项 | 读数 | 与 Lead 基线的对照 |
| --- | --- | --- |
| `skill_search('采购订单 行号', 10)` | 41ms；top1 `ncc-ct-to-order-generation-chain` **score 12.878187917361604**、v42；top2 `ncc-crowno-filling-vorownoutils` 10.42；top3 `ncc-scm-pu-chain-api-findings` 10.39 | 基线 top1 12.88 / 86ms — **一致**（延迟差异是同机冷热的量级，不作判据） |
| `get-by-name(..., includeContent)` | `contentLen 30318`、v42 | 基线 30318 — **逐字相等** |
| 同路由 `curl` 直连 | `contentLen 30318` | 插件与直连**同值** ⇒ 中间层没改写正文 |
| `skill.listing(6000)` | `listing` **6004 字符**、`hits` 20、首尾 `<available_skills>` / `</available_skills>` 都在 | 基线 6004 — **一致** |
| 死端点 `http://127.0.0.1:9` | search / get-by-name / listing 全部 `{ok:false, code:null, error:'transport failure: fetch failed'}`，**无 throw** | 失败是值不是异常（模块契约） |

写链（技能名 `probe-dsh-skill-<rand>`，末尾删净）：

```text
create            → v1   （body 自带 frontmatter，模型不写 fence）
get               → manifest [{"path":"notes.md","size_bytes":34,"mime_type":"text/markdown","is_executable":false}]
patch             → v2
files_write       → v3   （模型不传版本，插件读 v3 后 quoted）
files_read        → extra.txt 'echo hi\n' = 8 bytes
resource_read     → notes.md 'hello from probe-dsh-skill-…' = 34 bytes  ← 与 manifest size_bytes 相等
files_remove      → v4
update            → v5   （纯 markdown 正文 ⇒ 借用 head 的 name/description 合成 fence）
delete            → ok
get (after delete) → {ok:false, code:40401, error:'SKILL_NOT_FOUND: SKILL_NOT_FOUND'}
```

**两条字节级对拍**（票面要求的「文件内容与 manifest 一致」）：`notes.md` 34 bytes = manifest `size_bytes:34`；`extra.txt` 8 bytes = 写入的 `'echo hi\n'` 长度。**Lead 举例的 `skl-2Un5xJjHBU0Y` / `overlap-snapshot.mts` 在本机已 40401**（该技能不存在了），listing 前 20 个 head 的 `manifest` 全是 `[]`（本团队没有带资源文件的既有技能）⇒ 用 D 段自建技能做字节对拍是唯一可行路径，**不是偷懒**。

### 4.5 本轮因真 core 暴露并修掉的三处 schema 事实

| 事实（实测原文） | 插件怎么吸收 | 位置 |
| --- | --- | --- |
| resources 缺 `encoding` → 40001 `resources.0.encoding: Invalid option: expected one of "utf-8"|"base64"` | `create` / `filesWrite` 统一补 `encoding: 'utf-8'`（已是 base64 的保留） | `src/skill-client.ts` 两个 map |
| 裸 markdown 正文 → 42203 `[skill][format] missing frontmatter`（core `MemoryCore/src/core/skill/skill-format.ts:49` 要求 `---` 头带 name/description） | `withFrontmatter()`：已带 fence 原样返回，否则用 name + description 合成（description 走 `JSON.stringify` 安全引用；name 不合 `^[a-z0-9][a-z0-9-]*$` 时也加引号） | 同上 + `create()` / `update()` |
| `update` 换整篇正文时也会 42203 | 借**那次版本读取**带回的 head record 合成 fence（`writeWithVersion` 的 build 回调扩成 `(version, record)`，`versionOf` 返回 `{version, record}`）⇒ **一次写仍只有一次 `/v3/skill/get`** | `src/skill-client.ts` `HeadVersion` |

工具的入参也跟着改了：`skill_create` 的 `description` 现在进 `description`（原来错误地塞进 `metadata.description`），工具说明写明「不要自己写 YAML frontmatter，name/description 参数会变成它」。
### 4.6 同 build 里顺手修的两处「假警报」（与技能面无关，Lead 探针实测暴露）

| 症状（实测原文） | 根因 | 修法 |
| --- | --- | --- |
| `agemem: head pack has no parseable scene index; falling back to bare truncation {"rawChars":14204,"firstLine":"# User Narrative Profile","hasHeading":true}` | `hasHeading:true` 说明**认出了标题**（L2 段头 `## 长期记忆 · 场景索引（L2）` 命中 `SCENE_INDEX_HEADING` 的 `场景索引`），但 task-103 之后 pack 是**分段拼出来的**，场景行是 `- scene_blocks/<name>（更新 D）— summary`，永远没有 `### Path:` 主体 ⇒ 解析器判「上游变形状」，可 reduce 的对象其实是**我们自己刚产出的形状** | `isCompressedHeadPack()` 增加第二种产物形状 `L2_SECTION_LINE = /^-\s+scene_blocks\/\S+/m`：认出来 = 幂等，不再 warn、也不再尝试结构化（分段已各自按预算裁过） |
| `agemem: session identity not bound yet; using the configured triple for this call`（出现在 mount 早期、**根本没有 configured triple** 的 profile 上） | 一句文案覆盖两种完全不同的状态。身份走 user key 的 profile 在三元组解析完成前是**空的**，那次调用其实**不带任何隔离头**，文案却让人去查一个不存在的 config | 抽出 `unboundIdentityMessage(hasConfiguredTriple)` 分两句：有 config 才说「using the configured triple」，没有则明说「no configured triple; this call carries no isolation identity while the user key resolves」 |

两条都有回归用例：`test/head-pack.test.ts > recognises the segment-composed pack, whose persona no longer carries a scene tail`、`test/index.test.ts > unbound session diagnostics`。
## 5. README 同步

- 新增「head pack 的注入时机（一次/会话）」小节：首轮注入、`compaction/*` 重注一次、`refreshMs` 只刷缓存不重注，以及分段配额表（core_memory 3000 / persona=剩余 / skills 8000 / knowledge 3000 / wiki 2000）与丢弃优先级。
- 新增「技能面（`/v3/skill/*`）」小节：10 工具表、`skill.allowLlmWrite` 门控、写口 RMW 四步、`skill_view` 截断标记必须带原始长度、`skill_extract` 偏差。
- 配置示例补 `skill:` 段，`headPack.maxChars` 改 20000。

## 6. 已知 flake

`test/index.test.ts:505 it('mirrors the log into a file only when debug is on')`：28 文件并行时曾在 10000ms 超时；`vitest run test/index.test.ts -t 'mirrors the log into a file'` 单跑 **1.73s 通过**；随后全量复跑 **29 files / 519 tests 全绿**（02:48:04）。两次读数都在此，结论：并行负载下的超时抖动，不是断言问题。

## 5.1 README 这次补的两处（task-72 收口）

- 部署节改成「身份缺省走 `--user-key-ref`，`--identity` 是例外路径」：patch 里只留 ref 名（附渲染出的 config 片段）、
  `--identity` 与按 user key 部署互斥、**半截身份 exit 2**（原来只 warn 就装，等于把会话绑到错误 team）、
  缺 user key 时打印一次性 `credentials-util.mjs set` 命令。
- 技能面写清「模型不写 YAML frontmatter」与 `encoding` 缺省（42203 / 40001 的实测原因与自动吸收方式）。

## 7. 复现 / 清理

- 单测与构建：`cd dsh-plugin && node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && npm run build && node ../MemoryCore/node_modules/vitest/vitest.mjs run`
- 垫片全链（8420 不在也能跑）：`node scripts/verify-skills.mjs`；真 core 对拍见 §4.4：`node ../scratch/e2e-skill/accept.mjs`（读 `~/.dsh/.credentials.yaml` 的真 key，会在 core 上建一个 `probe-dsh-skill-<rand>` 再删掉；**末尾断言 40401**，失败就说明有残留技能）。
- 清理：`scratch/e2e-skill/` 保留（accept.mjs 是复核入口，已删净 core 上的探针技能）；本轮未安装到任何 profile、未改 `~/.dsh`（只读凭据）、未 commit。
- 注意：§4.4 的读数跑在 **`9a4721eb165d`**（Lead 09:50 装进 desktop 的那版）之上，它**已含** §4.5 的技能面三处修复；§4.6 的两处假警报修复发生在装机之后（当前 dist `6c5b726e10e6`），只影响诊断文本，需下次装机才生效。