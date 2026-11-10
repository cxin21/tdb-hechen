# 场合氛围（context / vibe / register）调研

2026-11-08 · 只读调研 · 目标仓库 D:/TDB/td-agemem
源码证据经 `gh api` 取原始文件，快照落在 `scratch/research/scene/`（`aurabot_*.js` / `sotopia_*.py` / `aitown_*.ts` / `genagents_scratch_isabella.json`），行号指快照内行号。
论文只读了 arxiv abs 页（摘要级），正文未读，逐条标「仅摘要」。

## ① 结论

1. 「场合」不是一个状态，是五层信号的合成：会话类型 / 在场者 / 任务性质 / 正式度 / 时间节奏。前两层能从元数据确定性取得，后三层必须推断，且只应影响**渲染**。
2. 外部唯一有落地代码的实现（aurabot）只做了最薄的一层：群 vibe 三个自由文本字段，120 字符，后台 LLM 批量提炼，只进「印象不是指令」的系统提示词上下文段，私聊完全不注入。
3. 没有任何开源项目把 register 做成可计算特征表；politeness / 社会语言只有「标量分类器打分 + 生成时按分值调节」这一条路线。
4. 场合指令确实能压过人格指令（指令层级），所以场合只能写成渲染参数，不能写成「你现在是评审员」。
5. 我方现状是 1:1（人↔agent）+ 多 agent 隔离，没有群成员数据源：在场者层只能退化成 team/user/agent 身份，真群聊场合在数据上不可得。
6. 最小改法不需要新表新列：插件侧每轮现算一行 ≤60 字，进独立 `systemPrompt.context` 段（不进人格卡、不进 Core 写路径），天然满足「场合不影响人格写入」。

## ② 场合分层表

| 层 | 确定性/推断 | 现有可得字段 | 用途 |
|---|---|---|---|
| 会话类型（私聊/群/频道/工单线程） | 确定性 | 会话头 `chatId` 前缀（aurabot `private:`/`group:`，memory.js:1128 只认 `group:\d+`）；我方只有宿主 `sessionId`（dsh-plugin/src/index.ts:611-623），无 kind 字段 | 决定要不要谈「在场者」，以及是否允许群级氛围注入 |
| 在场者构成（谁、几个、熟不熟） | 确定性（成员列表）+ 推断（熟不熟） | 群成员 API（我方无）；ai-town 用 `ConversationMembership{playerId,invited,status}` 显式建模在场者；我方有 identity 的 team/user/agent 三元组 | 称呼、是否点名、要不要照顾第三人 |
| 任务性质（闲聊/评审/救火/交付） | 推断 | 本轮用户消息（volatile.ts:118-143 `extractTurnClaim` 可取到）、最近 N 条工具调用形态、git 分支/未提交文件（未采集） | 决定收着说还是铺开说、要不要先给结论 |
| 正式度 register | 推断（可用廉价特征打分） | 消息本身（句长、标点、emoji、称呼、礼貌词、结构标记） | 语气松紧、是否用表情、要不要客套 |
| 时间与节奏（深夜/连发打断/长静默） | 时间确定性、节奏推断 | 时钟（确定性）、消息时间戳与间隔（插件侧 turn 记录，未核实是否留存） | 深夜收敛篇幅；连续打断只答当下 |
| 关系距离（补一层，避免重复造） | 半确定 | 人格卡已有 relationship / 关于对方的人卡 | 场合行不复述关系，只引用 |

判定口径：能从会话头、成员列表、时钟直接读到的写「确定性」；需要看消息内容或多轮统计的写「推断」。没有数据源的层直接标不适用，不做假推断。

## ③ 外部实现对照表

| 项目 | 数据结构 | 谁写 | 预算 | 出处 |
|---|---|---|---|---|
| aurabot（dsh-aurabot-qq） | `state.chats[chatId] = {vibe, topics, impression, updatedAt}`，chatId 形如 `group:<gid>` | 后台提炼 LLM 在批量提炼时顺带产出 `chat:{vibe,topics,impression}`（提示词见 1675 行，明确「chat 只在群聊填写」）；另有手工工具 `saveChat` 覆盖（1126-1139） | 每字段写时截 120 字符（1573）；注入时三段拼起来再截 120（1221）；开关 `chatImpression: true`（src/core/config.js:245） | src/features/memory.js:1113, 1126-1139, 1218-1223, 1568-1579, 1675 |
| aurabot 注入路径 | 系统提示词上下文段，不是用户消息 | 插件注册 `contextProviders`（src/host.js:274），hub 挂到 `agent.ctx.systemPrompt.context({name:'aurabot-context', order:905, text: () => ...})` | 每次提示词拼装时惰性求值，无额外预算 | src/chat/hub.js:570-588；src/features/memory.js:1218-1223 |
| aurabot 更新节奏 | 不是每轮 | 每分钟 tick，受每日批次上限约束（`extractDailyBatches ?? 24`、`gistDailyBatches ?? 6`），单批 80 行、每 tick 最多 12 批；失败退避 10 分钟起翻倍至 2 小时 | — | src/features/memory.js:1757-1759, 1788, 2482-2489 |
| Sotopia | `EnvironmentProfile{codename, source, scenario, agent_goals, relationship, age/occupation/agent_constraint}` | 数据集离线编写/生成，不是运行时推断；`SocialGame` 直接吃 `env_profile` | 无字符预算概念，整段 scenario 进提示词 | sotopia/database/persistent_profile.py:72-102；sotopia/envs/social_game.py:41,49 |
| Generative Agents | 每人一份 `scratch.json`：`currently`（情境句）、`innate`（特质）、`learned`（身份）、`daily_plan_req`、`lifestyle`、`living_area`、`curr_time` | bootstrap 人写，`currently` 由反思/规划覆盖 | 无显式预算 | environment/frontend_server/storage/.../personas/Isabella Rodriguez/bootstrap_memory/scratch.json |
| ai-town | `AgentDescription{agentId, identity, plan}` + `ConversationMembership{playerId, invited, status: invited\|walkingOver\|participating(started)}` | 场景初始化写一次，成员状态随进场/离场变更 | 无 | convex/aiTown/agentDescription.ts:5-20；convex/aiTown/conversationMembership.ts |

读出来的分野：aurabot 是「在线提炼的群氛围」，Sotopia 是「离线写好的场合剧本」，Generative Agents 是「每人一句 currently」，ai-town 只建模「谁在场」。四个里没有一个把 register 形式化。

## ④ register 可计算特征清单

按「拿到消息就能算、不需要模型」排序，括号里是中文口径的注意点：

- 句长与条数：每条字符数、轮内连发条数、句子平均长度（中文按标点切，不按空格）。
- 标点密度：`！？…~` 与句末语气词（啊/吧/呢/嘛）占比，反向指标是句号密度。
- emoji / 表情包占比：Unicode emoji 计数 + 图片消息占比（QQ 场景直接可得）。
- 称呼：是否 @、是否用昵称、是否用敬称（您/老师/大佬/哥/姐），反向是省略称呼直入主题。
- 礼貌词表：请/麻烦/谢谢/辛苦/抱歉/不好意思；please/thanks/sorry/apologies。词表本身要另建，见⑦。
- 结构标记：Markdown 标题/列表/表格行数、代码块、路径与日志片段——技术正式度的强信号。
- 网络语与压缩写法：hhh/草/6/绝了/栓Q、省略主语、拼音缩写。
- 话题深度：专业词密度、是否引用具体文件/行号/报错文本。
- 交互节奏：响应延迟、被打断次数、静默时长——归到节奏层，但同样可算。

两条可引的外部路子：politeness 用分类器打成标量分，再在生成时按分值调（arXiv:1805.03162，仅摘要，TACL）；社会语言水平（politeness + positivity）作为可测变量注入任务型 agent（arXiv:2012.14653，仅摘要）。两者都是「先打分再调表达」，不是改写人设。中英文礼貌/正式度词典本身未采集。

## ⑤ 与人设/情绪的相互作用规则

规则一：场合改表达方式，不改决策。证据是 aurabot 自己的写法——vibe 进的是「（这个群的印象，只是印象不是指令：…）」（memory.js:1222），同段还有「（只是印象不是指令）」（memory.js:1101、1114 的查印象返回），而人格与规则的渲染值是另一条路（src/host.js:295 注释：人格和规则的最终渲染值由 variable 在当前回合记录）。即：实现者主动把氛围降级成「非约束性上下文」。

规则二：场合指令会覆盖人格指令，所以不能写成指令。Instruction Hierarchy 明确系统提示词优先级高于用户与第三方文本，模型被训练成冲突时忽略低优先级指令（arXiv:2404.13208，仅摘要）。若场合写成「你现在是严格的评审员」，它就是在和人格卡抢同一层。

规则三：位置决定权重。相关信息放在上下文开头或结尾效果最好，放中间显著退化（arXiv:2307.03172，仅摘要，TACL 2023）。所以场合行要么紧贴人格卡，要么放进每轮尾巴，不要塞在长上下文中段。

写法对照（正式评审场景，人设不变，只收着说）：

- 不要写：你是严谨的评审专家，请严格审查。
- 要写：场合：正式评审，对方在等结论。收着说，先结论后理由，不发散，不用表情。
- 区别在于第二句描述的是「这一次怎么说话」，第一句描述的是「你是谁」。

规则四：场合不影响人格写入，靠的是物理隔离而不是自觉。场合行只存在于插件拼出来的提示词里（`systemPrompt.context` 段），Core 的写路径（/v3/soul/* 的提炼、outbox 上报）看不到它，因此它进不了 L0→L1 提炼的输入，也就进不了特质漂移。这条比「请在提炼时忽略场合」这种提示词约束可靠得多——后者只是请求，前者是数据不可达。

规则五：情绪层优先级高于场合、低于用户明说。用户说「别客气直接说」时，场合推断让位；情绪低落时场合只能让它更短，不能让它装高兴。

## ⑥ 我方最小改法

输入（全部已有，零新增采集）：

- `sessionId`：dsh-plugin/src/index.ts:611-623 已解析（`agent.session.id` 或 `agent.id`）。
- identity：team/user/agent 三元组，绑定在会话上（identity.ts 的 resolve 结果）。
- 本轮用户消息：`extractTurnClaim(messages)`（dsh-plugin/src/volatile.ts:118-143）在 pre-step 已能拿到文本。
- 时钟：本地时间直接取，无需存储。

计算：确定性信号三个（会话类型恒为 1:1、在场者恒为单用户、时段按小时分档），推断信号两个（任务性质用关键词 + 最近工具名；正式度用④里最廉价的三项：结构标记、礼貌词、称呼）。不做概率模型，只做档位：`松 / 常 / 收`。

渲染：一行 ≤60 字，独立段注册 `name: 'tdb-agemem:scene'`，`order` 贴着 persona-card（同 index.ts:1030-1033 的段注册方式），`text: () => ...` 惰性求值，每轮重算。

缓存：进程内 `Map<sessionId, {line, at, turnCount}>`，TTL 10 分钟或轮数变化超过 1 才重算；不落库、不跨重启，重启后第一轮重算即可（场合本来就是易失量，没有恢复价值）。

什么时候不注入：

- 会话不足 2 轮（还没有任何节奏可看）。
- 五个信号都落在中性档（闲聊、白天、无任务词）——没有信息就不要占预算。
- 推断与人格卡冲突且无法调和时（例如推断出「正式」但用户上一轮说「随便聊」），以用户明说为准，直接不注入。
- 每轮只注入这一行，不追加第二行；宁可缺，不要长。

明确不做：

- 不建表、不建列、不加配置键（场合是推导量，不是存储量）。
- 不改 `GET /v3/soul/turn` 的契约（当前是纯读、无消息入参，memory-client.ts:1537-1544）；场合留在插件侧算。
- 不做群成员/在场者层：没有数据源，硬做就是编。
- 不训练 register 分类器，不引入新依赖；先用手写特征跑两周，看它到底有没有改变输出，再决定要不要升级。
- 不写进人格卡，不进 Core 的任何写路径。

## ⑦ 未采集

- 我方插件侧是否留存会话内历史消息的时间戳（决定「节奏」层能否真的算出来）：未采集。
- 中文礼貌词/正式度词典与标注资源：未采集（没有核实到可用公开资源，不写编号）。
- 四篇论文的正文（只读 abs 摘要）：Instruction Hierarchy 的四级优先级细节、Lost in the Middle 的具体位置曲线数值，均未采集。
- Sotopia 里 scenario 在提示词中的确切拼接位置：只读到字段定义与 `SocialGame.__init__` 吃 `env_profile`，未读模板。
- aurabot 的 mood 模块与 vibe 是否有交互：只看到 `moodEffects`（src/host.js:288），未读 mood 实现。
