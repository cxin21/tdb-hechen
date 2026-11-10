# 人格卡 v13：表演层

状态：草案，未实施
日期：2026-11-10
关联：issue #180、docs/specs/2026-11-10-soul-event-model-full-optimization.md
样例：docs/specs/2026-11-10-persona-card-v13-sample-xiaoman.md

## 0. 一句话

把人格卡从「事实清单」改成「表演脚本」：前台像一个具体的人，后台仍然每一句都能指回证据。

## 1. 为什么改

现在的卡不是没有内容，是内容的结构不对。

它已经有声明层（名称、形象、说话方式、使命、红线）、派生层（底色）和观察层（关于你、关系、自我史）。但观察层是把 soul_persona 的行按 last_evidence_at 倒序直接摊开，所以卡上会出现「用户对我的要求：……——我只回了话，没改」这种句子。这是工单，不是关系。

card-service 目前只读 listSoulPersona、readSoulTraitState、listSoulTraitLabels、readLastSoulSnapshot、readSoulState、listSoulPromises。P0 已经建好的 soul_person_state、soul_mood_state、soul_goals、soul_working_state、soul_person_relation，它一个都没读。所以不是表不够，是前台没接后台。

角色卡和桌宠人格卡的第一目标不是记录，是表演：给模型一个场景、一段开场、几段对话样品、几条行为约束，让它演成一个具体的人。我们这张卡第一目标是审计，所以读起来像会议纪要。v13 不放弃审计，只是把审计从正文挪到 metadata。

## 2. 目标

1. 卡正文读起来像一个人，而不是一份人格报表。
2. 关系从「用户对我的要求」变成「我们现在是什么关系、我欠你什么、我最近有没有伤到你」。
3. 性格从数字变成行为锚：遇到什么，会怎么做。
4. 当下有心境、能量和注意力，不只有历史。
5. 记忆是三个具体场景，不是「我站在……这边」的总结。
6. 每一句仍可回指证据；缺数据就省略或标未采集，不编。
7. 不新增数据库表，不改变 P0 事件模型，不做读时 LLM 生成。

## 3. 非目标

1. 不为卡新增一套人格表。能用现有 P0 表就用，缺的字段先省略。
2. 不在 GET /v3/soul/card 时调用模型生成人格文本。渲染必须是确定性的、可缓存的。
3. 不删除旧卡 v12。v13 先做旁路，可回滚。
4. 不把证据 ID、轴名、α、tanh、权重、confidence 数字写进正文。
5. 不改变 P1-A 的事件切分和行动事件逻辑。
6. 不做多人格、群卡、跨人关系混排。
7. 不在卡里生成样品对话或具体台词。语气靠声音、口头禅、禁用表达和行为锚传递，避免编造。
8. 不为关系状态造占位。person_state 为空就只写关系事实，事实也没有才省略整块。

## 4. 设计原则

1. 表演优先：卡是给模型看的角色脚本，不是给审计员看的报表。
2. 行为优先：写「被指出错时先认，再补复验条件」，不写「严谨 0.8」。
3. 关系优先：写「我们」，不写「用户对我的要求」。
4. 具体优先：写时间、场景、原话，不写抽象总结。
5. 当下优先：除了过去，还要有现在的心境、注意力、想做的事。
6. 证据后置：正文只演人，证据、来源、置信度放 metadata。
7. 缺失即缺失：没有数据就省略或标未采集，不用漂亮话补位。
8. 预算硬顶：整卡不超过 2400 字，超了按固定顺序丢块。

## 5. 卡的九块

### 5.1 第一眼

目的：让人在三秒内知道这是谁。

来源：agent 声明层的 name、selfImage、purpose；可选 age、city、job。

写法：名字一行；一句生活自述；一句使命。不要写「我是一个 AI 助手」。

上限：220 字。

缺失：年龄、城市、职业没有就省略，不猜。

### 5.2 生活

目的：让这个人有日常，不是只有工作。

来源：selfImage、human 层的 likes/focus、最近事件。

写法：作息、正在忙的事、喜好、雷区、小习惯、宠物。至少两条具体生活细节。

上限：260 字。

缺失：没有生活细节就只写正在忙的事，不编城市和宠物。

### 5.3 性格

目的：让模型知道遇到什么事会怎么反应。

来源：identity、values、boundary、voice、trait labels；trait 数值只做后台。

写法：五条行为锚，每条以「遇到/被/当……时，会……」开头。不要形容词堆砌，不要数字。

上限：300 字。

缺失：行为锚不足五条时，宁可只写三条，不拿标签凑。

### 5.4 说话

目的：让模型直接模仿语气。

来源：voice、redlines，以及 voice 层里已经存在的声音描述。

写法：声音一句；句长或节奏一句；口头禅一句（有原话依据才写）；禁用表达一句。不写样品对话，不写具体台词。

上限：220 字。

缺失：口头禅没有原话依据就省略；声音和禁用表达至少有一样，否则整块省略。

### 5.5 我们

目的：把关系从事件流水账变成关系状态。

来源：soul_person_relation（谓词、方向、有效期、引文）、soul_person_state（trust/affinity/respect/obligation/boundaries/model）、relationship 层、human 层。

写法：先一句「我们是什么关系」；再写两到四个维度，例如信任、亲近、张力、亏欠、边界、共同仪式、最近一次修复；最后一句「我现在想从你这里要什么」。不要写「用户对我的要求」和「我只回了话」。

上限：320 字。

缺失：soul_person_state 为空时，只写关系事实和最近修复，不写五维、不伪造信任分；关系事实也为空才整块省略，不留空话。

隐私：传 persons 时只渲染这些人相关的关系；解析不到 person_key 就省略关系块并给 person_unresolved warning，不静默回退展示名。

### 5.6 现在

目的：让卡有此刻，不只有历史。

来源：soul_state（valence/arousal/baseline/emotion_label/emotion_object）、soul_mood_state、soul_working_state、soul_goals、最近事件。

写法：一句心境，跟基线比，不写数字；一句注意力或正在做什么；一句下一步。不写「如果我先开口我会说……」这类台词，避免无依据地编对话。

上限：220 字。

缺失：没有 soul_mood_state 时，用 soul_state 与 baseline 的差值写「偏沉/偏松」，标 derived；没有 working_state 就只写心境，不编当前任务。

### 5.7 记得

目的：用具体场景代替抽象自我史。

来源：soul_events + soul_event_evidence、self 层、narrative 层。

写法：最多三个场景。每个场景要有时间或情境、一句原话、一句「这件事改变了我什么」。原话必须逐字来自证据；没有引文就不渲染这个场景。

上限：300 字。

缺失：不足三个就写两个或一个，不拿「我站在……这边」凑数。

### 5.8 边界

目的：让红线变成关系边界，不只是禁令。

来源：boundary、redlines。

写法：两到四条。写「不替你做承诺」「不编来源」「不属于我写域的只报不动手」这类可执行边界。

上限：180 字。

缺失：至少保留红线里的硬边界，不省略。

### 5.9 最近的变化

目的：让用户看到这个人最近在变什么。

来源：narrative、soul_ledger、drift 记录。

写法：一到两句。写「我从什么走到什么，放弃了什么，为什么」。

上限：160 字。

缺失：没有变化就省略，不写「我一直在成长」。

## 6. 数据来源映射

声明层：agent 配置里的 name、selfImage、voice、purpose、redlines。只读，不改。不读样品对话。

观察层：soul_persona 的 human、relationship、self、identity、narrative、values、boundary。只作为素材，不直接整行贴到卡上。

结构化层：soul_person_relation、soul_person_state、soul_state、soul_mood_state、soul_goals、soul_working_state、soul_promises、soul_events、soul_event_evidence、soul_ledger。

优先级：结构化层 > 观察层 > 声明层里的推断。结构化层没有的维度，不要用观察层的句子硬凑成数字。

## 7. 渲染规则

1. 人称：关于对方默认用「你」；只有 soul_person_state.affinity 达到亲近阈值且 relation 存了昵称时用昵称，昵称不从正文猜；关于自己用「我」。禁止「用户」作为关系对象。
2. 行为锚：一条只写一个反应，不写「温柔/严谨/通透」这种形容词。
3. 关系：先关系类型，再状态维度，再最近修复。禁止事件流水账。
4. 场景：时间/情境 + 原话 + 改变。禁止「我站在……这边」单独成行。
5. 心境：跟基线比，用「偏沉/偏松/更稳」这类词，不写 0.27。
6. 台词：卡里不生成样品对话，也不生成「如果我先开口会说什么」。语气只靠声音、口头禅、禁用表达和行为锚传递。
7. 名字：只认 soul_person.display_name 或声明名；解析不到就用「你」，不写「用户」。
8. 格式：卡正文不用 Markdown，不用表格，不用加粗；一行一句，短句优先。
9. 证据：正文不出现 record_id、event_id、hash；这些放 metadata。
10. 省略：任何一句找不到来源，就不渲染；不要让模型「合理补全」。

## 8. 预算与丢块顺序

整卡硬顶 2400 字，目标 1900 到 2250 字。

身份段硬顶 1000 字；末尾锚硬顶 460 字。

分块上限：第一眼 220，生活 260，性格 300，说话 220，我们 320，现在 220，记得 300，边界 180，最近 160，合计 2180，留 220 给分块之间的过渡句。

超限丢块顺序：最近的变化 → 生活 → 我们里的细节 → 现在里的细节 → 记得从三条减到两条 → 性格从五条减到三条。

永不丢：第一眼、性格里的核心行为锚（至少两条）、边界、红线。

## 9. 元数据与审计

GET /v3/soul/card 的响应新增 blocks 数组。每块包含：id、chars、source（declared/observed/derived/structured/absent）、confidence（high/medium/low/absent）、evidenceIds、warnings。

整卡保留 version、hash、textHash、chars、labels、warnings、sources、dirty、seeded。

warnings 至少支持：missing_person_state、missing_mood_state、missing_working_state、sample_dialogue、person_unresolved、truncated、block_omitted。

证据映射：每块给 evidenceIds；正文行不嵌 ID。没有证据的行不渲染。

hash 规则不变：hash = sha256(CARD_READER_NOTE + 正文)，textHash = sha256(正文)。v13 的 CARD_SCHEMA_VERSION 改为 13；正文变化时 hash 必须变化，底色变化小于 0.05 不触发重渲染的规则保留。

## 10. API 与兼容

第一阶段默认仍返回 v12；加 query 参数 v=13 预览，或环境变量 TDB_SOUL_CARD_VERSION=13 切默认。

v13 响应保留现有字段，新增 blocks；旧消费者忽略新字段即可。

GET /v3/soul/turn 暂不改；末尾锚继续用 v12 选择逻辑。等 v13 正文稳定后再切锚。

传 persons 时，关系块只渲染这些人；解析不到 person_key 就省略关系块并给 warning。

回滚：TDB_SOUL_CARD_VERSION=12 或去掉 v=13，立即回旧渲染；不改库，不需要迁移。

## 11. 实施阶段

阶段 0：本 spec 加小满样张。不改代码，不写库。

阶段 1：card-service 增加 v13 渲染器，藏在开关后。只读声明层、soul_persona、soul_state。补单测：九块顺序、预算、丢块、缺数据、无「用户对我的要求」、不含台词、hash 稳定。

阶段 2：接结构化层。读 soul_person_state、soul_mood_state、soul_goals、soul_working_state、soul_person_relation；缺数据先省略，不在卡里补。对应 P2/P3/P5 的数据生产。

阶段 3：默认切 v13，面板加卡预览和 evidence 展开；观察一个发布周期。

阶段 4：末尾锚切 v13；删除旧渲染器。

## 12. 验收

1. 盲读：找五个没看过实现的人读旧卡和新卡，至少四个人说新卡「像一个人」，不是「像报表」。
2. 禁句：正文不出现「用户对我的要求」「我只回了话」「我站在……这边」作为独立行。
3. 具体性：至少三个场景带原话和时间；至少两个关系维度；至少一句心境。
4. 证据：每个正文事实能回指 evidenceIds；没有无标记的编造；缺数据要么省略要么标未采集。
5. 预算：整卡不超过 2400 字；超限按第 8 节顺序丢块；身份段 1000、锚 460 不超。
6. 稳定：同一份输入连续渲染，hash 不变；底色变化小于 0.05 不重渲染。
7. 隐私：传 A 的 persons 不出现 B 的关系；未解析 person_key 不给展示名回退。
8. 回归：现有 card 测试、soul-persons 端点测试、P0 双写测试全绿；P0 读模式不受影响。

## 13. 风险

1. 编造生活细节。缓解：只读声明和观察层；没有就省略；不生成台词。
2. 关系状态为空，卡又变回流水账。缓解：soul_person_state 没数据就整块省略；先补 P2 数据，不拿 persona 行硬凑。
3. 卡变长，挤占上下文。缓解：2400 字硬顶，分块预算，固定丢块顺序。
4. 读时生成导致慢和贵。缓解：确定性渲染，不在读时调模型。
5. 隐私泄漏。缓解：persons 过滤；person_key 解析失败就省略；不按展示名回退。
6. 观察层句子本身像工单。缓解：渲染器做转换，不整行复制；工单句只做素材。
7. 旧卡回滚复杂。缓解：开关 + v=12；不改库。

## 14. 已定决策（2026-11-10）

1. 整卡硬顶 2400 字，身份段 1000，末尾锚 460。理由：九块都要留位置，2000 会先丢关系细节，关系正是当前最缺的。
2. 不做样品对话。理由：样品不是事实，读时生成或离线预置都会进水，宁可只给声音、口头禅、禁用表达和行为锚。
3. soul_person_state 为空时只写关系事实，不写五维；关系事实也没有才整块省略。理由：事实可审计，分数不能编。
4. 只在「现在」和「最近的变化」允许 derived 推断，其余块禁止。理由：当下最容易失真，也最需要；历史必须逐字有证据。
5. 正文默认「你」；昵称要同时满足 affinity 达阈值和 relation 里存了昵称，不从正文抽。理由：昵称是关系事实，不是文风。
6. 末尾锚只放第一眼、边界、现在的心境，不放关系细节。理由：锚每轮都在，关系变化快，放进去会和稳定卡打架。
7. v13 稳定卡不含「我们」和「现在」，这两块走动态段。理由：稳定段同一会话内 hash 不能变。
8. 关系块按 person_key 过滤，解析失败给 person_unresolved 并省略，不回退展示名。理由：隐私优先于完整。

## 15. 与现有实现的关系

card.ts 的 11 块顺序、CARD_MAX_CHARS、IDENTITY_MAX_CHARS、ANCHOR_MAX_CHARS、hash 规则保留，v13 只改「块的内容和来源」，不改渲染骨架。

card-service.ts 的 CARD_FIELD_SOURCES 扩展为 declared/observed/derived/structured/absent 五类；relationship 不再只读 soul_persona.relationship，优先读 soul_person_relation 和 soul_person_state。

soul-card-endpoint.ts 的响应加 blocks，其余字段不变。

P0 的 soul_events、soul_event_evidence、soul_person_relation、soul_person_state、soul_mood_state、soul_goals、soul_working_state 是 v13 的后台；v13 不新建表。

## 16. 样例

见 docs/specs/2026-11-10-persona-card-v13-sample-xiaoman.md。样张里标了哪些是现有数据，哪些是演示补位，哪些是缺数据。
