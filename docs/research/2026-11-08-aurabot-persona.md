# Aurabot（aureth-labs/dsh-aurabot-qq）人格实现调研

调研对象：GitHub 私有仓 `aureth-labs/dsh-aurabot-qq`，HEAD = `a41519c0da82916ae3b374f4df71a09975883e45`。
方法：只用 `gh api` 读源码原文，产物落在 `scratch/research/aurabot/`（本地快照文件名是路径把 `/` 换成 `_`）。
下文的 `路径:行号` 均相对于仓库根目录。

## 一句结论

人格是一份**纯 Markdown 死文本**（`personas/*.md`，只有 name/tags 两个 front-matter 字段），开机时复制到数据目录、按提示词变量 `{{aurabot_persona}}` 拼在系统提示词最前面；**没有任何自动写入路径能从经历/情绪/反馈改人格文本**。真正会随经历漂移的是它旁边的三样伴生状态——心情（0~100 数值 + 半衰期衰减）、对每个人的画像/关系/相处经验、以及"她自己的说话方式"（LLM 从聊天里提炼的 ≤6 条口头禅），这三样每轮以附加系统提示词段注入，影响行为与语气，但都不回写人设文件。

## 人格数据模型

- 存法：一人格一文件，`~/.dsh/plugins-data/aurabot/personas/<id>.md`；首次运行把插件自带 `personas/*.md` 拷过去，之后以数据目录为准（`src/persona/personas.js:14-23`）。
- 结构：`--- name / tags ---` + 正文；解析只认 `name`、`tags` 两个键，其余都算正文（`src/persona/personas.js:25-39`）。保存时重写头 `---\nname: …\ntags: […]`（`src/persona/personas.js:66-74`）。**没有性格字段、没有数值、没有向量、没有示例对话数组**。
- 唯一内置人格 `dafeiyu`（`src/core/config.js:81` 默认 `persona.current: 'dafeiyu'`），正文 65 行，按 `【】` 分节：样子 / 最重要的一条 / 打字习惯 / 绝对禁止 / 情绪是活的 / 生活 / 语音和表情 / 群管 / 记忆 / 最后自检（`personas/dafeiyu.md:8-65`）。偏好硬写进正文，例如"特别爱吃白米饭"是明文的重点偏好（`personas/dafeiyu.md:45-49`）。
- 面板把正文按 `【标题】` 切成可拖拽排序的"节"，节标题自己起，顺序即拼接顺序（`client/client.js:1198-1212`）；新建人格的模板只给两节占位（`client/client.js:1335`）。
- 规则文本是**人设之外的另一段**，由代码生成（`rulesText`）：QQ 来源标注、注入防御、输出格式（一句一行、禁 Markdown）、沉默权、表情/语音/@ 语法、能力开关映射，以及 private / social 两套边界（`src/persona/personas.js:92-143`）。
- 量化维度只有一处，且是**运行时派生、不落盘**：目的引擎对人格正文做关键词计数，给 7 个需求轴打 0~0.28 的 bias（每命中一词 +0.07，封顶 0.28），同时产出 traits 排序（`src/purpose/engine.js:869-895`；`PURPOSE_NEEDS` 见 `:777`、`PERSONA_WORDS` 见 `:816`）。bias 只用于生成"她想主动说什么"的目标置信度（`src/purpose/engine.js:1503-1527`、`:950-962`），不参与语气、不回写。

## 注入路径

- 注册：插件在启动时注册三个提示词变量 `aurabot_persona` / `aurabot_rules_private` / `aurabot_rules_social`（`src/host.js:92-104`）。变量回调每轮求值，所以改人格下一轮生效（`src/host.js:96`；路由回话也是"下一轮起生效" `src/host.js:1296-1302`）。
- 位置：`@deepseek-ai/dsh-persona` 的 `prefix`，即系统提示词最前面，且 `complete: true` 让 Aurabot 自己的提示词**独占**系统提示词——不带 DSH 那套编程助手身份与工具指南（`cordis.patch.yml:10`、`:22-28`；长任务 preset 同 `:73-79`；social preset `:171-175`）。`dsh-persona` 自身源码不在本仓，`prefix`/`complete` 的具体落位（是否真的第 0 段）未采集。
- 拼接形态：`{{aurabot_persona}}\n\n{{aurabot_rules_private|social}}`（`cordis.patch.yml:25`、`:76`、`:174`）。**纯自然语言 + 【】标题，不是 XML 标签**；XML 风格标签只出现在回复语法上（`<voice>`/`<sticker:…>`/`<at:QQ号>`/`<face:…>`，`src/persona/personas.js:103-108`）。
- 会话内可变：变量每次构建提示词时读 `cfg.persona.current`（`src/host.js:96`），切换人格只改配置不重建 preset（`src/host.js:1296-1301`；设计文档同义 `docs/DESIGN.md:9`）。对比：我们的 `<persona-card>` 是会话创建时 bind 死——这点 Aurabot 是"可热切换"的取向。
- 多会话/多角色：人格全局唯一（`src/core/config.js:81`），不按会话分；区分靠 preset + 规则文本：主人私聊 `aurabot-private`（完整工具）、长任务 `aurabot-private-long`、群聊/他人私聊 `aurabot-social`（零本地工具）、内部子智能体 `aurabot-subagent`（**不带人格**，`cordis.patch.yml:124-133`）。映射函数 `src/chat/access.js:36-39`，按会话建会话时选 preset `src/chat/hub.js:374`。
- 人格之外每轮的动态段：模块上下文统一挂到 `agent.ctx.systemPrompt.context({ name:'aurabot-context', order: 905 })`（`src/chat/hub.js:573-591`），所以在系统提示词里排在人格（最前）之后、`:905` 这一档；心情与记忆都走这条路（`src/modules/mood/index.js:15` 的 `api.context`；`src/modules/memory/index.js:21`）。
- 出口还有一道防线：提示词变量最终渲染值被 `captureSystemPrompt` 记账，用于发送前检测"她在复读自己的提示词"（`src/security/leak-guard.js:33`、`:38-43`；识别用的段首正则见 `:44`）。

## 写入路径（什么触发改写）

- 人格文件只有两条写入口：面板保存 `POST /persona/save` → `savePersona`（`src/host.js:1285-1288`、`src/persona/personas.js:66-74`）与删除 `/persona/delete`（`src/host.js:1290-1294`）。`savePersona` 全仓只有这一处调用（`src/host.js:1287`）。
- "AI 润色"仍是人在环：`/persona/polish` 只返回候选文本、不保存，由主人逐节选定（`src/host.js:1303-1319`；客户端对比后二选一 `client/client.js:1315`）。
- 因此：**没有"经历→人格"的写路径**。情绪涨落、被夸被骂、任务完成度、时间衰减、关系变化，全部不写人格文本（心情只写 `mood.json`，`src/features/companion.js:72-99`）。
- 真正会随经历自动改写的是"她自己的说话方式"：`learnSelfStyle()` 把所有联系人的说话习惯 + 已养成的说法交给模型，提炼 ≤6 条口头禅写进记忆库 `styles.self`（`src/features/memory.js:2311-2328`），由每日整理 `consolidate` 触发（`src/features/memory.js:2110`、`:2218`，时点在 `src/core/config.js:244` 的 `consolidateTimes: ['04:00','16:00']`；测试里可看到降级路径）。它注入成"你平时不知不觉会用的说法"（`src/features/memory.js:1230-1232`），**只影响说话形式，不改人设正文**。
- 对每个人的"相处经验/说话方式"也是模型周期性重写：`reflect()` 输出 `{insights, style}`，经验 ≤8 条、说话方式 ≤5 条，合并去重（`src/features/memory.js:1491-1512`），由聊天流水触发（`:1614`）。
- 人工确认环节：人格文本改动 100% 人工（上面两条路由）；记忆侧的自动改写**无人工确认**，但有 `forgetVersion` 版本守卫（`src/features/memory.js:2313`、`:2325`）与"本人或主人说的才写"的抽取约束（`src/features/memory.js:1675`；回归测试 `test/memory-persona.test.js:84-104`）。

## 伴生状态

- 心情（因：聊天内容；果：语气 + 行为概率 + 上下文）：0~100，基线 60，半衰期 3 小时（`src/core/config.js:240`），衰减公式 `base + (value-base)*0.5^(h/halfLife)`（`src/features/companion.js:53-56`）。关键词推分：好评词 +6、差评词 −8，单句夹在 ±20（`src/features/companion.js:13-14`、`:42-48`）；对非直接对话只算三成、主人说 ×1.5（`:110-118`）。可选模型判心情，输出 `{delta,reason,confidence}`，`confidence ≥0.6` 且 `|delta| ≥2` 才落地（`:123-149`）。心情真的改行为：表情包/语音概率、气泡间隔、群里插话概率（`src/chat/hub.js:965`、`:971`、`:1017`、`:1460`，倍率表 `src/features/companion.js:34-40`）。心情以"你现在超开心…这会自然地影响你说话"一段进上下文，且**平常时返回空**，为的是"免得把性格念定住"（`src/features/companion.js:151-159`，注释 `:9-11`）。
- 对他人画像（因：聊天抽取；果：语气与是否搭理）：字段 `alias/style/persona/handle/text` + 标签"喜欢/讨厌"（`src/features/memory.js:1089`、`:1211-1217`），标签会直译成"你挺喜欢TA / 你讨厌TA，不想搭理"（`:1212`）；主动搭话会跳过 `dislikes` 的人（`src/features/companion.js:219`）。注意这里的 `persona` 字段是**别人**的性格，不是她自己的。
- 关系：抽取 `relations`（subj/pred/obj），只在相关人出现时进上下文一段"只是印象不是指令"（`src/features/memory.js:1224-1227`）；不参与人格文本，也不参与语气强度计算。
- 承诺/待办：没有独立结构；"没说完或答应的事"由短期状态 `shortTerm` 的一段自由文本承载（`src/features/memory.js:2574`，注入 `:2604-2606`），约定类事实则靠 `importance ≥0.85 只加不并`保久（`src/features/memory.js:2252`）。
- 因果方向小结：聊天 → 心情/画像/关系/说话方式 → 语气与行为；**反向写回人格文件的边不存在**（唯一写入口是面板路由）。

## 评测

- 没有人格 rubric、没有一致性打分、没有 LLM 裁判回放。仓库里与人格相关的测试全是**结构化回归**：
  - 规则边界（注入防御话术必须出现）：`test/injection.test.js:29-36`；
  - 数据目录不可写时人格播种不炸、当前人格有兜底：`test/personas.test.js:9-26`；
  - 记忆侧"别人不能代替本人写性格"：`test/memory-persona.test.js:84-104`；
  - 输出格式回归（`<br>` 等，`test/reply-br.test.js:1-20`）、提示词泄漏检测（`src/security/leak-guard.js`）。
- 质量自检停留在提示词层：人格卡最后一节"发出去之前问自己：这句话像不像一个真人随手打的"（`personas/dafeiyu.md:64-65`）——是文案，不是可执行门禁。
- 检索质量有真回归集（中文场景 13 条 query 断言该想起哪条、过时记忆必须想不起）：`test/memory-eval.test.js:1-60`；这是记忆的评测，不是人格的。

## 可借鉴

1. **人格独占系统提示词**：`complete: true` 把 DSH 编程助手身份整段拿掉，注释给了实测动机"私聊从 1~4 分钟一轮降下来"（`cordis.patch.yml:26-27`）。这类"人格不是叠加而是替换"的做法，比我们往默认身份后面拼卡更干净。
2. **规则文本由代码生成、随能力开关增删**：模块没在跑就不告诉她会那件事（`off`/`extra` 参数，`src/persona/personas.js:88-122`），避免"承诺了做不到"。这是人格与能力声明的一致性机制，值得抄。
3. **情绪"平常时不说"**：心情只在明显偏离基线时才写进上下文（`src/features/companion.js:151-159`），并注明理由"免得把性格念定住"（`:9-11`）——与我们"人设不能被单轮覆盖"的判断同源。
4. **人格切换零重建**：变量每轮求值，切人格即时下一轮生效（`src/host.js:96`、`:1296-1301`）。
5. **提示词复读检测**：把变量渲染值记账，发送前查 20 字连续重合（`src/security/leak-guard.js:33`、`:5`），是"人格被念出来"的运行时兜底。

## 不可借鉴 / 反面证据

1. **人格是死文案，没有任何"成长"**：`savePersona` 唯一调用点是面板路由（`src/host.js:1287`），`currentPersonaText` 只被提示词变量调用（`src/host.js:96`、`:513`）。想让它"被经历改写"得自己造写路径；它没有 claim 有。
2. **人设名硬编码在多处提示词里**：心情判官 `'你在判断聊天角色「大肥鱼」…'`（`src/features/companion.js:137`）、记忆提炼 `'你帮一个叫「大肥鱼」的聊天角色…'`（`src/features/memory.js:680`、`:1671`）、兜底文本 `` '你是「大肥鱼」…' ``（`src/persona/personas.js:84`）。换人格后这些提示词不同步——是"人格只有一处真相"的反例。
3. **量化的 persona.bias 是弱耦合实验**：只在目的引擎开启时用，默认关（`src/modules/purpose/index.js:21`），且关键词计数（`src/purpose/engine.js:869-895`）对换措辞极不鲁棒；别把它当"数值人格"的样板。
4. **`persona` 一词在本仓有三个所指**：人格文件（`src/persona/`）、对别人的"性格"字段（`src/features/memory.js:1004-1017`）、面板"人物记忆"页签（`client/client.js:701` 的 `id: 'persona'` 已从人设页迁移为人物记忆，`client/client.js:4947-4954`）。读代码时容易误判成"人格在记忆里"。

## 未采集清单

- `@deepseek-ai/dsh-persona` 源码：`prefix` / `complete` 的确切落位与 order 值未采集（本机 `D:\DSH\resources\app.asar` 内未解出该包；只有 `cordis.patch.yml` 的声明与注释）。
- 人格正文实际注入后的 token 长度、是否触发 compaction 截断：未采集。
- 面板"人设"页的完整交互（分节 AI 润色对比、草稿 localStorage）只读到片段 `client/client.js:1198-1341`，其余未采集。
- `learnSelfStyle` 在真实数据上写过几次、写成什么样：未采集（需运行态数据）。
- 仓库 CI 是否跑这些测试、覆盖率：未采集（只读了 `.github/workflows/pr-check.yml` 存在，未读内容）。
