# dsh-plugin 写回 / memory_recall 根因与修复（task-52）

日期 2026-11-01 · 对象 `@tdb/agemem-dsh` 0.1.0（`D:/TDB/td-agemem/dsh-plugin`）· 未 commit

## 0. 结论先说

| # | Lead 原假设 | 实测 | 是否真缺陷 |
|---|---|---|---|
| 1 | `agent/turn-stopping` payload 无 `agent` ⇒ 写回 miss | payload 带 `agent`（宿主 `dsh-agent/lib/types/dispatch.js` 的 agentEvents 把 agent fuse 进每个 payload），且 L0 有该 session 4 行 | 假设**被证伪**，但派发缺口是真缺陷 |
| 2 | `memory_recall` 未注册 | 两道独立断点：peer 解析不到 → 注册未编译字段表；`tools` 服务只在 apply 查一次 | 真缺陷（已修） |
| 3 | 注入块原文能被当 user 消息回写 | probe matrix `session=probe-matrix-m2-inj` 复现 | 真缺陷（已加固） |

取证时机说明：GUI 会话 `session-6fb73ffa-…` 的 4 行 L0 落在 16:39:20.414–.417Z，比该轮 `turn/end#20`（16:39:23.015Z）**早 2.6s**，说明走的是 turn-stopping 分支；当时查库看到 0 行是因为该轮仍在跑。历史 e2e 的 L0 行来自 MemoryProxy(8096) 代理路径，不是本插件。

## 1. 缺陷一：中断 / blocked / 空回合不派发 turn-stopping

宿主 `dsh-agent-loop/lib/index.js:1001` 只在「step 正常返回且 inbox 为空」时 dispatch `agent/turn-stopping`；阻断、空回合、中断（aborted/interrupted）只 append `turn/end`。旧代码只在 `reason.kind === 'error'` 时 finalize ⇒ 这些回合的 messages 永远留在内存。

修复（`src/writeback.ts`）：
- `turnEndStatus(reason)`（:279）—— 只有 `{kind:'completed'}` 算 completed，其余一律 error（skillFeed 只对干净完成开）；
- `turn/end` 分支无条件 `flushPending` + `finalize`（:553），去重靠 `finalized` 集合，双触发只写一次；
- `agentSessionId`（:314）只认 `agent.session.id`，拿不到就 debug 一次并交给 turn/end 兜底，**不再写 `anon-N` 键**（:568）。

回归依据：该 GUI 会话 turn 3/5/6 为 interrupted，旧代码不落库；新增 8 条单测覆盖 interrupted/blocked/completed/双触发两种顺序/无 agent payload。

## 2. 缺陷二：memory_recall 从未注册（两处一起修）

> **合成示例，不是运行时日志**（2026-11-01 诚实修正，task-80；复核见 `docs/ops/verify-task52-review.md` §2）。下面这行是把两处宿主源码拼出来的**示意**，本会话没有任何运行时日志能复现它——引用时不要当原文。

```
# 合成示例（非实测）：code/name 形状取自 JsonSchemaError，文案模板取自 author-schema 校验器
agemem: memory_recall registration failed {"code":"UNSUPPORTED_SCHEMA","name":"JsonSchemaError","violations":["parameters.limit.required must be true when present"]}
```

出处拆开（抽出件路径 `scratch/dsh-plugin-probe/host/dsh-tools/lib/index.js`，等价实现另在同包 `lib/types/`）：
- `code`/`name`/`violations` 的形状：`JsonSchemaError`（`:25-31`，code 传 `UNSUPPORTED_SCHEMA`，`this.name = "JsonSchemaError"`）；
- `… must be true when present` 文案：同包 author-schema 编译路径（`:544-546` `authorError` → `throw new JsonSchemaError([message])`，文案在 `:603`；等价实现 `scratch/dsh-plugin-probe/host/dsh-tools/lib/types/schema.js:79`），`parameters.limit` 前缀由 `compilePropertyMap(spec, "parameters")` 生成（`:802-812`）。复核另称该文案只出自 `cordis-host-runner` 的 `normalizeParameterSchemaSpec`——本次抽出的 20 个宿主包里没有该模块（抽取范围有限，不据此否证），但无论哪处来源都**不在插件走的那条路上**：DSL 编译只发生在 `parameterSchemaSpecToJsonSchema`/`defineTool`（`:802`/`:829`/`:848`/`:1550`），插件是 `ctx.tools.register(definition)` 直传（`dsh-plugin/src/index.ts:1014`、`:1022`）。
- 这条串为什么不可能由插件路径产生：`register` 只校验 `output` 形状、`timeoutMs`、保留名（`:2974-2982`），**从不校验 `parameters`**；`schemaOf` 把 `definition.parameters` 原样 snapshot 给模型（`:3136-3142`）。旁证：`~/.dsh/agemem/` 只有 `outbox.jsonl`/`outbox.dead.jsonl`（均 0 字节），没有 `agemem.log`（debug 文件日志是本轮才加的，见 §4）。

**复核结论（采纳 bench-metrics 判定，修法不变）**：缺陷二的真实症状不是「注册被拒」，而是**未编译的字段表（根缺 `type:'object'`）被原样投影成模型看到的 schema**——宿主不报错，模型既无法校验也无法调用，静默失效。所以 §2 末尾的离线取证用「旧字段表形态必须抛 `JsonSchemaError`」钉契约，线上定位只能靠 §4 的 debug 日志。

断点 A：`@deepseek-ai/dsh-tools` 在安装后的 profile 里不可解析（`ERR_MODULE_NOT_FOUND`），`resolveDefineTool` 退回 identity 包装 ⇒ 交给 `tools.register` 的是**未编译的 DSL 字段表**（根缺 `type:'object'`、`required` 不是数组）。`register()` 从不校验 `parameters`，所以既不报错也不可用。
修复：`src/tools.ts:46` 直接产出完整 JSON Schema（`type:'object'` / `properties` / `required:['query']` / `additionalProperties:false`），删掉 peer 依赖与 fallback；`package.json` 去掉 `peerDependencies`。

断点 B：`tools` 服务与 credentials 同类 mount-timing 陷阱 —— 兄弟 entry 的服务对象在 apply 之后才挂上。
修复：`src/index.ts:156 TOOLS_WAIT_MS = 800` + `:946` 先 `getService` 再 `waitForService`。

离线取证（不需要宿主）：把宿主 `dsh-tools/lib/types/json-schema.js` 从 app.asar 原样抽到 `test/fixtures/host-json-schema/`（两个 import 用最小 shim），单测里断言：本工具 schema 通过 `assertObjectJsonSchema`；旧字段表形态必须抛 `JsonSchemaError`。另加 `describeRegistrationError`（:200）把 code/name/violations 拍平成可 grep 的一行。

## 3. 缺陷三：注入块原文可被当 user 消息回写

`src/writeback.ts:195` 新增 `INJECTION_TEXT_MARKERS`（`【agemem 记忆提示】`、`<soul-identity>`、`<soul-feeling>`、`<relevant-memories>`、`【币值判定规则`、`【建议类问题口径`）。`user/message` 分支上实际是**两道闸**：
- **主闸** `:488` `if (candidate.source?.kind !== 'user') return;` —— 宿主把注入消息写成 `user/message` 时 `source.kind` 是插件来源（`plugin:…`）等非 user 值，直接丢；
- **文本闸门** `:204` `isInjected()`，调用点 `:485` 在主闸之前 —— 认行首/换行后行首的标记，防「`source.kind` 被伪装成 user」的注入块。

两闸**重叠**而非一闸失效：`isInjected` 内的 kind 分支（`:205-206`）与主闸挡同一批消息，只是先执行、结果相同（复核记「kind 分支不可达」，按行序不精确）。只认行首是为了不误杀用户在句中引用标记（有单测）；P1 残留：以标记开头的**真实用户消息**仍会被文本闸门丢掉（`docs/ops/verify-task52-review.md` §3），task-79 修完再按实际行号更新本节锚点。

## 4. GUI 可观测性：debug 文件日志

桌面宿主没有可读 stderr，这就是「插件在说话但没人听」。新增 `src/debug-log.ts`：`config.debugLogFile`（空 = `$DSH_HOME/agemem/agemem.log`，`DSH_HOME` 缺省 `~/.dsh`），仅 `debug=true` 构造（关时零文件零目录），5MB 轮转一次到 `.1`，写失败即静默且永不抛；ready 行追加 `logFile=`（`src/index.ts:1060`）。

## 5. 验收读数（本轮实测）

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 退出码 0，无输出 |
| `npx vitest run` | 20 files / **318 tests** 全绿（本轮单文件读数：writeback 25、index 48、tools 9、debug-log 13） |
| `npx tsc -p tsconfig.json`（build） | 退出码 0，`dist/debug-log.js` 等产出 |

## 6. 部署与验证（下一步，由 Lead 决定时机）

1. `bash scripts/deploy.sh --profile <p>`（默认取 `DSH_PROFILE`，本机为 `desktop`）→ 装包 + 追加 patch insert + `dsh --dump-config` grep；
2. 重启宿主后看 `~/.dsh/agemem/agemem.log`：应有 `agemem: ready (…, debug=on, logFile=…)` 与 `agemem: memory_recall registered {"parameters":["query","limit"]}`；
3. 会话里调一次 `memory_recall` 应返回命中或 `no memory hits`（不是「工具不存在」）；
4. 中断一轮（发消息后立刻停止）后查 `/d/TDB/data/vectors.db` 的 `l0_conversations`：应有该轮 user 原话，assistant 文本可缺；
5. 回滚：`bash scripts/rollback.sh --profile <p>`。

`--dump-config` 只做组合解析、不加载插件：通过 ≠ 已挂载，挂载要重启宿主。

## 7. 与 spec 的偏差（更新上一轮 probe 报告）

- spec 假设 `agent/session-start` 存在 —— 本 build 只有 `agent/created`；
- spec 假设 `assistant-stream` end 帧带 usage —— 实测无，usage 只在 `session/event` 的 `assistant/message.data.usage`；
- spec 假设 pre-step 追加的消息是 ephemeral —— 实测落盘成 `user/message` 会话事件（这正是缺陷三的由来）。
