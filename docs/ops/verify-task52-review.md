# task-67 复核：task-52 三项取证（独立实测，非采信自述）

复核对象：docs/ops/dsh-plugin-writeback-rootcause.md §1/§2/§3/§5。方法：读源码 + 从 app.asar 抽出宿主模块 + 自建 fake ctx 直驱 dist 产物（脚本 scratch/verify-task52/*.mjs）+ 独立重跑 vitest。零修改。

**总判定：三项问题都真实存在且修法方向正确，但两处 P1 缺口 + 一条引文不能作为「原文」采信。总体 = 有条件通过。**

## §1 写回兜底 —— 有条件通过
- turnEndStatus 映射正确：`dsh-plugin/src/writeback.ts:279`，实测 completed→completed，interrupted/blocked/aborted/undefined/{}→error。
- turn/end 兜底生效：`writeback.ts:540-560`。双信号两种顺序实测都只写 1 条（stopping→end：status=completed/messages=2；end→stopping：status=error），去重靠 finalized 集成立。真实缺口（aborted 轮只发 turn/end）确实被补上。
- 不写 anon-N 成立：`writeback.ts:314` agentSessionId 返回 undefined，`:568` 只 log 一次，随后 turn/end 仍能补写（实测 0 条 then 1 条）。
- **P2 缓冲被误删（新发现）**：`writeback.ts:554` `pendingUsers.delete(id)` 无条件执行，而 `:553` finalize 在 turn 为 undefined 时于 `:381` 早退。实测「session 有 id、全局无 turn」→ 用户消息静默丢（0 payload），匿名 session 同理。现网 turn/end 都带 turn，风险低，但属静默数据丢失分支，建议改为 `if (turn != null) { flushPending(); pendingUsers.delete(id); }`。
- **P2 半轮落库**：只有 assistant 文本的轮次会被写成一条无 user 的记录（实测确认）。真实触发点是下节 P1-a 的误杀。
- **P2 steering 未覆盖**：`writeback.ts:470-540` 只处理 turn/start·user/message·assistant/message·tool/call·tool/result·turn/end 六类；宿主侧存在 `steering/message` 事件类型（app.asar grep 命中）。未验证宿主是否同时镜像成 user/message，故列缺口不下结论。

## §2 tools schema —— 通过（结论正确，证据链要改）
- 宿主**根本不校验 tool.parameters**：`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2974` register() 只校验 output 形状(:2977)、timeoutMs、保留名；`:3139-3146` schemaOf() 把 definition.parameters 原样 snapshot 投影给模型。⇒ 旧「字段表」形态不会在注册时抛错，而是把无根 type 的形状交给模型（危害是约束不到模型，不是注册失败）。
- **task-52 §2 的「真实拒绝原文」不能采信**（〔2026-11-01 补注·task-80〕本次实读抽出件后修正一句：`must be true when present` 在 `dsh-tools` 里也有一处 —— `scratch/dsh-plugin-probe/host/dsh-tools/lib/index.js:603` 的 `authorError`，路径前缀由 `compilePropertyMap(spec, "parameters")` 生成（`:802-812`），故「只出现在 cordis-host-runner」不精确；结论不变：两处来源都不在插件调用的 `ctx.tools.register` 链上。已按此改写 `docs/ops/dsh-plugin-writeback-rootcause.md` §2 与 `dsh-plugin-e2e-report-4.md` B2）：`{"code":"UNSUPPORTED_SCHEMA","name":"JsonSchemaError","violations":["parameters.limit.required must be true when present"]}` 是把两处源码拼在一起——JsonSchemaError/UNSUPPORTED_SCHEMA 出自 dsh-tools json-schema.js，而 "must be true when present" 只出现在 `@deepseek-ai/dsh-cordis-host-runner/lib/index.js` 的 normalizeParameterSchemaSpec（普通 Error，无 code/violations），且该函数**只被 sandboxDefineTool(:479) 调用**，不是条目插件的 ctx.tools.register。另：`~/.dsh/agemem/` 下只有 outbox.jsonl/outbox.dead.jsonl（0 字节），无 agemem.log，原文无法复现。建议改写为「症状按代码推定，命令为合成示例」。
- 独立验证（fixture 校验器 + dist/tools.js，证明校验器非恒绿）：新 schema accepted；legacy 字段表 **rejected**（"schema.query is not a supported keyword"）；无根 type rejected；limit.required:false rejected；validateJsonSchemaValue 对 legacy 字段表校验 {} → **[]（恒绿，证明旧形态约束不到模型）**，对新 schema → missing required "value.query"、多余键 → "\"value.bogus\" is not a declared property (additionalProperties: false)"。
- fixture 与宿主的一致性已复核：两者 497 行代码逐行全等，差异仅文件头 docblock（+19 注释行）；task-52 称「sole edit 是 sourceMappingURL」不准确，无功能影响。
- **P2 潜在不兼容**：cordis-host-runner `:198-215` 对 type:"object" 只允许 type/properties/required/additionalProperties/annotations，且 additionalProperties 必须为 true 或省略。若插件将来走 sandboxDefineTool 路径，`dsh-plugin/src/tools.ts:62` 的 additionalProperties:false 会被拒。现路径不影响。

## §3 注入双闸 —— 有条件通过
- 闸门顺序与主次已核实：主闸是 `writeback.ts:488` `source.kind !== 'user' → return`，isInjected（`:195/:204`）在其前但 kind 分支因此失效，实际只剩文本闸门起作用。〔2026-11-01 补注·task-80：按行序 `isInjected` 在 `:485`、主闸在 `:488`，`plugin:` 来源先在 `:485` 被丢，故 kind 分支**与主闸重叠**、结果相同而非「不可达/失效」；已据此改写 `docs/ops/dsh-plugin-writeback-rootcause.md` §3。〕
- 正确行为实测：source.kind='plugin:tdb-agemem-dsh' → 丢弃（宿主确实把注入消息持久化成 user/message，probe-report:44 也写明 kind 取值 user/agent-instructions/runtime-context/skill-catalog/system-prompt/model/tool）；文中含标记 → 保留；assistant 侧不过滤（:499-513，含 <soul-identity> 仍保留）。
- **P1 误杀**：真实用户消息**以标记开头**（如「【agemem 记忆提示】这段是什么格式，照抄分析」）或第二行起出现标记 → 整条丢；该轮若无 assistant 文本则不落库，有则落成半轮（实测）。建议把文本闸门限定在 source.kind ∈ 宿主注入集合时才生效，或至少 warn 一条不静默。
- **P1 无 source 的 user/message 也丢**（source {} 或缺失 → 0 条）。现网真实用户消息带 kind='user'，风险低，但与宿主契约无断言保护。

## §5 读数核对
独立跑 `node ../MemoryCore/node_modules/vitest/vitest.mjs run`（cwd dsh-plugin）→ **20 files / 318 tests 全 passed**，与自述一致；用例数 writeback 25 / index 48 / tools 9 / debug-log 13 全对。抽查 writeback.test.ts:236-337 与 tools.test.ts：均为行为断言（enqueue 次数/payload 字段/logs 片段/不抛异常），无恒真常量与快照替代；tools.test.ts 的负例是真负例。用例形状提醒：测试给 user/message 都带 data.turn，真实事件 dataKeys 为 id/role/source/content（无 turn），走 :490-494 缓冲分支——该分支有 test:192 覆盖且实测通过，不算漏洞。

## 未验证（不做结论）
1) 桌面 GUI 运行时 memory_recall 是否真的注册成功、断点 B（index.ts:946 先 getService 再 waitForService）是否真被命中——无运行时日志，只能代码推断。
2) 插件拿到的 tools 服务实例是 ToolRuntime 还是 sandboxTools（决定 P2 潜在不兼容是否会成为活路径）。
3) 宿主 steering/message 是否同时产生 user/message。
4) fixture 三个 shim（dsh-llm / dsh-util-values 等）在极端输入下的行为是否与宿主逐位一致（只核对了主校验函数 497 行）。

## 建议开票
- P2 writeback.ts:554 缓冲误删（附 scratch/verify-task52/writeback-probe.mjs S3/S3b）。
- P1 注入闸误杀真实用户消息（行首/第二行标记 + 无 source）。
- P2 steering/message 未监听（先验宿主是否镜像）。
- P1 文档诚信：task-52 §2 引文改为合成示例并标注出处。
