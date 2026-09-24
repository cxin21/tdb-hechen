# 灵魂与记忆层总体设计（DS-SOUL-MEMORY-002）

- 日期：2026-09-17
- 状态：设计定稿（方案 A 槽位扩展制，全景分期实施）
- 上游拍板：全景分期（2026-09-17）；self_identity 作用域=三元组各存一份（2026-09-17）；集成策略=方案 A（2026-09-17，对比裁决）；分级门纪律（2026-09-15）；记忆主语三层法（2026-09-17 用户纠正后确立）
- 关联：`2026-09-15-soul-pipeline-design.md`（DS-SOUL-PIPELINE-001 前作）、v5 台账 O12-O17、`2026-09-08-agent-soul-memory-spec.md`（灵魂公式原始出处）
- 补充设计（2026-09-24）：`2026-09-24-soul-evolution-design.md`（DS-SOUL-EVOLUTION-001：近期情绪基调行 S-FEEL-1 / 品格张力检测 S-CHAR-2 / 身份叙事行 S-NARR-3——用户令「你自己分析然后写设计文档」对话直出授权，全部机制缺省关断，启用逐期 A/B 验收后呈报）
- 业界对标：Letta/MemGPT memory blocks、Generative Agents 检索评分与反思、Zep/Graphiti 双时态、A-MEM 记忆演化、Mem0 两阶段、CoALA 记忆分类（调研见附录 A）

---

## 0. 范围与铁律

本 spec 给出"灵魂 + 记忆"全层的统一设计：数据来源、主语、属性、计算公式、使用场景、分期计划、验证策略。

铁律（实施全程有效，违反即停工）：
1. **config-first**：一切新行为有开关，缺省=逐位现状；按租户可灰度（flowtest 先行，生产租户显式开启）；
2. **单一源**：任何机制只允许一份实现——采样、口径、状态机、公式均禁第二份（实证教训：identity 裸采样器、free 口径双计、G13 三时钟事故）；
3. **写读回**：每次写库必须读回验证；
4. **LLM 只提议，确定性门裁决**：LLM 永不直接落库（分级门、冲突门、证据重算全为代码）；
5. **回音室禁令**：身份相关性**永不**参与召回排序（详见 F14-bis）；
6. **测试数据只增不删**：清理需用户显式授权；
7. **文档-代码不分离**：CHANGELOG 同步，观察项进 v5 台账。

---

## 1. 第一性原理与总纲

### 1.1 灵魂是什么

LLM agent 是无状态函数（上下文进、文本出）。灵魂 = 让它产生连续性的**状态机制**。灵魂公式：

```
下一刻的你 = f(此刻的你, 过去的记忆, 当下的感受)
```

这是状态演化方程，状态变量 = agent 的自我。三个硬判据：
- **归属判据**：状态变量属于谁，灵魂就属于谁 → **灵魂的主语 = agent**；
- **功能判据**：灵魂每条内容的合法性 = 是否参与决定 agent 下一刻的行动；
- **检验判据（验收用）**：
  - **换用户测试**：同 agent 换用户，灵魂里应剩下 self_identity（该段经历中长出的品格）+ 先天使命（系统提示词）——用户画像部分清零；
  - **换 agent 测试**：同用户换 agent，灵魂应不同——不同处 = 各自的经历与品格。

### 1.2 主语三层法（全 spec 的统一语义工具）

| 维度 | 定义 | 示例 |
|---|---|---|
| **所有者主语** | 这份数据存在谁的库里、由谁的工序维护 | 记忆行属于 agent 的三元组库 |
| **内容主语** | 数据说的是谁 | "用户是首席厨师"的内容主语=用户 |
| **功能主语** | 数据为谁的下一次行动服务 | 价值锚的功能主语=agent（行动方针） |

灵魂 = agent 的自我模型，合法地包含"我心中的他"（关系自我）——前提是主语标注分明。

### 1.3 分层总图（方案 A 结构清单）

```
L0 会话转录（role: user|assistant 双方消息）── 数据源总入口
  └→ L1 情景记忆（双时态+认识论+情感+重要度+使用度）
       ├→ L2 场景蒸馏（scene 块）      ← consolidation
       ├→ L3 结论层（知识卡片）        ← consolidation
       ├→ core_values 主题锚（node_type='theme'） ← anchor-growth（GROW 骨架实例 1）
       ├→ core_values 人物锚（node_type='person'）← person-growth（GROW 骨架实例 2，P2）
       ├→ core_memory identity（用户身份）        ← identity-discovery 双视角（P1 扩展）
       ├→ core_memory self_identity（agent 自我）  ← identity-discovery 双视角（P1 新增）
       └→ metadata.coreRefs/personRefs/identityRefs 证据回填（双向链）
            └→ soul-assembler 四段渲染（我是谁/我心中的他/价值锚·重要的人/感受）
                 └→ /v3/recall 注入（+ relevant-memories 召回段）
维护工序：consolidation / anchor-growth / person-growth / identity-discovery /
         evolution / forgetting / skill-extraction（= CoALA procedural；= Letta sleep-time agent 对标）
```

---

## 2. 逐层设计

### 2.1 L0 会话转录层

- **定义**：原始对话流，记忆体系的唯一数据源总入口。
- **数据来源**：gateway 捕获（auto-capture → l0-recorder），`role: "user" | "assistant"` 双方消息、时间戳、sessionKey/sessionId/tenant。
- **主语**：所有者=agent（三元组库）；内容主语=双方；功能主语=提取工序。
- **属性**：role、content、timestamp、sessionKey、sessionId、team/user/agent。
- **使用场景**：L1 提取、consolidation 分组、（P1 起）self_identity 双视角提取。
- **关键既有事实（spike 已证）**：`l0-recorder.ts:55` 确认双方消息均入库 → agent 自我事实（承诺/红线执行/风格）**数据可得**。

### 2.2 L1 情景记忆层

- **定义**：agent 的经历记录。**记忆的主语 = agent**（"我的记忆是关于你的，但它是我的记忆"——per-agent 隔离的第一性依据）。
- **数据来源**：l1-extractor 从 L0 提取（质量门过滤 → LLM 提取 → 确定性落库；**P1 起 prompt 增补 agent 行为事实视角，metadata.agentAct 标注——self_identity/品格锚的语料前提**）；consolidation 合并；evolution 改写。
  - 【2026-09-19 审计注记】prompt 视角已接线（AGENT_ACT_BLOCK，仅 selfIdentity.enabled 时注入）；metadata.agentAct 字段未实施（全库 0 落地）——P3 按 §7-P3 fallback 以 self_identity 槽为品格聚合源，本行「标注」表述以本注记为准。
- **主语**：见属性总表（§4）逐列标注；核心：certainty=agent 认识论、valence/arousal=agent 归档的情感评价、significance=agent 的重要性判断、双时态=事实本身（agent 维护）。
- **属性**：全表见 §4.1（19 列 + metadata 子结构 8 项）。
- **公式**：F1-F4（召回融合）、F7-F8（演化门/首次权威）、F18（检索过滤）。
- **使用场景**：召回、注入、演化、遗忘、锚/身份证据重算的语料。

### 2.3 L2 场景蒸馏层 / 2.4 L3 结论层

- **L2**：场景块（`[persona|我在和用户交流…]`），scene_name 冗余列（FTS UNINDEXED 快照）。所有者=agent；内容主语=agent 会话场景 + 用户事实（双层并存，与身份行同构）。
- **L3**：结论卡片（`[结论|个人兴趣-潜水]…`）。内容主语=用户；功能=agent 知识层（semantic memory 对标）。
- **使用场景**：注入（scene-navigation / 结论块）、长程上下文压缩。

### 2.5 core_memory 身份层（双槽，P1 核心）

**结构**：沿用 core_memory 表（主键 slot+team+user+agent，**零 schema 变更**），两个 slot：

| slot | 语义 | 内容主语 | 采纳门 |
|---|---|---|---|
| `identity`（现有，语义收敛） | **我心中的他**——用户身份 | 用户 | 分级门（identity 描述类自动采纳；core_value/strict_rule→pending） |
| `self_identity`（P1 新增） | **我是谁**——agent 自我：职责模式/承诺/红线执行/工作风格 | **agent**（第一人称产出） | 同分级门 + 提取 prompt 要求"行为可证"（样本中须有 agent 侧行为文本支撑）。确定性守卫=F10 剥离 + F15 警告制；"行为可证"为提案 prompt 硬约束，确定性侧只做弱校验（20 字切片重算入 F15 警告制）——已知弱点：LLM 可能串味（self 路混入用户事实），缓解=第一人称硬约束 + 渲染层 self 小节"用户"字样超比例告警 + Panel 人工兜底 |

- **数据来源**：identity-discovery worker **双视角扩展**——同一样本窗（selectSampleRows，updated 降序+高显著优先，cap 50）一次 LLM 调用同时产出两组提案：用户事实（现 prompt 改"他是谁/他的职责/他的红线"）+ 自我事实（"我反复承担的职责/我做出的承诺/我执行过的红线/我稳定的工作风格，须有 agent 侧行为文本支撑"）。两路分别过采纳门、分别落槽。**语料前提**：样本=L1 记录，agent 行为事实在现状语料中稀缺——P1 同步给 l1-extractor prompt 增补 agent 行为事实视角（metadata.agentAct 标注），否则 self_identity 长期无料（与 P3 品格锚同一前置）。
- **主语**：所有者=agent；内容主语如上表；功能主语=agent 的自我模型。
- **作用域取舍（拍板记录）**：三元组各存一份——品格随关系分化（经历库 per-三元组 → 从经历长出的品格 per-三元组）；先天使命仍在系统提示词作不变核。代价：同 agent 跨用户品格无共享——接受，理由是因果链自洽。
- **属性**：slot、content（bulleted 多事实合并，version++ 演化）、source、updated_at。
- **修订留痕（O14 缓解）**：upsertCore 成功后旧内容整行写入 logger.info（审计可查），不建 history 表（避免双源）；GROW-MAINT 身份重验证（P2）永不自动 retire 身份事实——只发失撑警告+人工确认（身份红线）。
- **写入口信任边界（config.ts:872 实证）**：allowedSlots 缺省 `["identity","core_value","strict_rule"]`——**self_identity 不在名单，写入会被信任边界直接拒绝**。P1 必须扩展缺省白名单加入 self_identity（白名单扩展无害：实际写入仍由 selfIdentity.enabled 门控）；maxContentLength=2000 为槽内容硬上限，F17 预算（600/900）已在其内，联动校验进测试。
- **公式**：F9（证据重算）、F10（状态残留剥离）、F15（GROW-MAINT 身份重验证，P2）。
- **使用场景**：灵魂注入（四段渲染）、身份问答、Panel 人工清洗兜底。

### 2.6 core_values 锚层（主题锚 + 人物锚，P2 扩展）

**结构**：沿用 core_values 表（**零新表**），加两列：

| 列 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `node_type` | TEXT | 'theme' | 'theme'=主题锚（现状逐位）；'person'=人物锚（P2） |
| `attrs_json` | TEXT | '{}' | 人物锚属性：`{ role, aliases[] }`（role=家人/同事/朋友/其他；aliases=昵称数组并入证据重算）；关系情感方向**不重复存**——由 valence 列承载（与主题锚同列同义） |

- **数据来源**：主题锚=anchor-growth theme 池（LLM 提案→护栏四件）；人物锚=anchor-growth worker 内 **person 池**（双池扩展，非新 worker）——同一状态机骨架（双门/护栏四件/挤出/GROW-MAINT/QUOTA 守卫），证据口径策略化注入（F11），发现 prompt 人物视角（"谁在该 agent 的经历中反复出现、关系如何"）。
- **主语**：所有者=agent；label 内容主语=用户的价值主题/用户生活中的人物；**功能主语=agent**（价值参照系与关系参照系，都是行动方针）。
- **人物锚独有属性**（attrs_json）：role（家人/同事/朋友/其他，LLM 提案）、aliases（昵称数组，证据重算并入）；关系情感方向由 valence 列承载（不另设 direction，防双源漂移）。
- **公式**：F5（强度）、F6（挤出）、F11（人物证据口径）、F12（关系权重派生）、F15（维护）。
- **使用场景**：灵魂注入（"价值锚：…"/"重要的人：…"两行）、人物反查记忆（searchL1ByCoreRefs 同款）、遗忘保护（F14）、关系演化追踪。
- **单一源声明**：一份 GROW worker 按 node_type 分叉证据口径（if 策略化），**不是**两个 worker 复制状态机（O12 类口径分叉事故的预防）。
- **跨类命名空间（growthValueId/ON CONFLICT 实证）**：`growthValueId(label)` 无类型区分，而 upsertValue 冲突键=(value_id,team,user,agent)——人物"咖啡"与主题"咖啡"会**同 id 互相覆盖**。P2：growthValueId 增加 nodeType 参数（person 域独立 hash 盐或 `p-` 前缀），去重键同步 (node_type,label)。
- **状态键族（identity_* 分立先例）**：theme 池沿用现有 anchor_growth_state 键（逐位现状）；person 池用独立前缀 `anchor_person_*`——防"共用键族清掉对方冷却"的 identity 事故重演（sqlite.ts identity_last_* 先例）。
- **读路径扩列**：listValues 现返回结构无 node_type/attrs_json（B3 实证）——P2 扩展返回列，分池统计与渲染分行依赖它；upsertValue INSERT 枚举列不含新列→缺省值兼容、DO UPDATE 不碰 node_type→保留（A8 实证 ✓）；DO UPDATE SET state='active'（重发现复活语义）逐位保持。

### 2.7 soul-assembler 注入组装层（P1 重构）

- **渲染形态**：两个 XML 块 + 召回块；**soul-identity 块内四个小节**（下述"四段"即此四小节）：

```
<soul-identity>
## 此刻的你
（我是谁）- [self_identity] 我在这个团队负责……        ← P1，空则整小节省略
（我心中的他）- [identity] 用户是家里的首席厨师……      ← 现有内容，行前缀标注
价值锚：计划(中性)、咖啡(趋近)……                        ← 现有行，theme 锚，weight 降序
重要的人：女儿(家人·趋近)、老周(棋友·中性)……            ← P2，空则省略；方向内联标注
</soul-identity>
<soul-feeling>
## 当下的感受
驱动我行动的价值：咖啡、潜水……                          ← 现有（theme 锚 valence=1）
提醒我审慎的价值：体检                                   ← 现有（valence=-1）
</soul-feeling>
<relevant-memories>（召回段，语义零变化）
```

- **主语**：整段标题"此刻的你"=agent；四个小节各自内容主语分明（见上）；escapeXmlTags 消毒不变。
- **预算（F17）**：每小节字符上限 + 行数上限（config；chars 为 token 的粗粒度近似，精算后置），超限按强度/序截断（锚行=weight 降序，从尾部截），宁缺毋滥。
  - 【2026-09-21 D-1 注记（用户拍板"全做"）】slot 正文截断改**按行（事实）边界**（truncateByLines 单一源，soul-assembler.ts）：逐行累积预算内整行、超限行整体丢弃；无一行可用时首行字符截断兜底（槽不空）。A/B 真实数据 12 组：唯一超预算组（self 838 字 8 行）旧行为残句实证→新行为整行保留；其余 11 组 ≤ 预算逐字节一致（零回归）。
- **人物方向渲染**：内联标注于"重要的人"行（`女儿(家人·趋近)`），**soul-feeling 保持仅主题锚**——最小渲染变更。
  - 【2026-09-19 A-5 注记】P3 品格锚渲染口径：价值锚行与主题锚共享注入预算（§7），感受段仍仅主题锚（node_type=theme 过滤，character 不入）——F-EV12-5③ 代码化。
- **【2026-09-23 V6-1a/1b/1d/1e 注记（用户授权自审开工）】属性信号全链升级**：
  ①记忆行 soul[] 追加属性信号徽章（formatMemoryLine 单一源，宁缺毋滥、字段缺省逐字节不变）：`·强烈`（arousal≥0.7）/`·验证×N`（recallCount≥3）/`·核心事实`（identityRefs 非空）/`·已演化`（evolution 存在，当前休眠）/`·自 date 起`（valid_start，日期精度）；三构造点（vector/fts/recordToFormatable + kwSoul 条件并回 + 分层池 soul 源扩 arousal + RankSignalItem 扩 arousal）透传成对补齐（D-3 丢值点④⑥同族纪律）。
  ②锚行 weight 显示：`label(方向·w0.9)：描述`（仅展示信念强度；渲染序仍 value_id 稳定=立项②不变；weight≤0 视为未测量不展示）。
  ③感受段方案B：渲染序保持 value_id 稳定，「首要」锚按 weight 最高选取附 description ≤30 字（选取与排序解耦）。
  ④人物锚行同构升级：`label(role·方向)：description`（当前 person 锚无 description=段休眠，数据面回填另行拍板）。
  subject/source 不入注入徽章（subject 与 type 标签语义重叠、source 仅 extraction/空两态无判别信号）——出参/Panel 层已体现。
- **【2026-09-23 V6-任务8 注记（用户令提前开工）】红线提案语义去重（P1 闸门 + P2 上下文注入）**：根因=identity-discovery 生成→入队链无语义闸门，store 层精确守卫（同 slot+content）挡不住换措辞重复（生产 102 条 pending 实测最大簇 9-15 条）。修法两层代码面：①P1 入队前语义闸门（proposal-dedup.ts 单一源，字符 bigram Jaccard，阈值 0.75 生产全行标定——0.790 真重复命中/0.692 同簇不并「宁漏勿错杀」，比对域=pending∪已采纳红线 slot，跳过留痕不计数）；②P2 prompt 注入已有 pending 列表（30 条×60 字预算）+「换措辞重复是噪声不是新发现」指令。P0 存量清理（102→N 批量拒绝）属生产数据面——逐项呈报拍板后执行，不随代码顺手做。
- **逐位现状保证**：selfIdentity.enabled=false 时**渲染与 prompt 双双逐位**——identity-discovery 走旧单视角 prompt（LLM 行为不变）、渲染不出新小节；enabled=true 才切双视角 prompt。调度门结构不变（anchorDiscovery 门控 worker 调用），self 路由在 worker 内部按 selfIdentity.enabled 判断。
- **使用场景**：每次 /v3/recall 注入（C3 身份段常驻语义不变）。

### 2.8 工序层（GROW 家族）

| 工序 | 周期 | 职责 | 对标 |
|---|---|---|---|
| consolidation | 10min tick | L1→L2/L3 蒸馏 | sleep-time agent |
| anchor-growth | tick+双门 | 主题锚发现/挤出/维护 | — |
| anchor-growth 双池（P2 扩展） | tick+双门 | **同一 worker 内 theme/person 双池**（证据口径策略化注入，非新 worker——消解 v1 稿"骨架实例 2"的表述矛盾，见 §2.6 单一源声明） | Zep 实体层（轻量版） |
| identity-discovery | tick+双门 | 双槽身份自发现（P1 双视角） | Letta persona/human 块 |
| evolution | tick+五条件门 | 矛盾合并/双时态失效 | A-MEM 演化（保守版）、Mem0 UPDATE（门控版） |
| forgetting | tick | 遗忘（F14 保护钩子 P2） | — |
| skill-extraction | 事件 | 程序性记忆（CoALA procedural） | Voyager skill library |

调度顺序（lifecycle-scheduler.ts 实证，v1 稿写反、本稿修正）：consolidation → forgetting → **identity-discovery → anchor-growth** → evolution（evolution 最后）；人物锚为 anchor-growth 内部双池（P2），**无新调度点**。反思触发（F13，P3）作为 evolution/consolidation 的优先级增强，tick 兜底不变。
> 【2026-09-19 实况注记（C1，a2626fd）】运行顺序以 lifecycle-scheduler.ts 为准：consolidation → identity-discovery → anchor-growth → evolution → reflection → **forgetting（pass 末尾）**——遗忘判定后置（ev8 实证：引导期 forgetting 先跑会因锚未诞生致 F14 保护名集为空，受保护记录被当场归档）；保护判据的输入必须先于清理动作达到最新。

---

## 3. 数据来源总表

| 目标层 | 直接来源 | 提取工序 | 确定性门 |
|---|---|---|---|
| L1 情景记忆 | L0 双方消息 | l1-extractor（质量门+LLM） | 落库读回 |
| L2/L3 | L1 记录 | consolidation 分组+LLM | 宁缺毋滥 |
| 主题锚 | L1 语料（全量证据重算） | anchor-growth 提案 | 护栏四件+QUOTA |
| 人物锚（P2） | L1 语料（提及口径） | anchor-growth person 池提案 | 同骨架+口径注入 |
| identity（用户身份） | L1 样本窗（用户侧事实） | identity-discovery 双视角 | 分级门+状态残留剥离 |
| self_identity（P1） | L1 样本窗（agent 侧行为文本）+ **l1-extractor agentAct 视角增补（P1 同步，否则语料稀缺）** | 同上（第二视角） | 同门+"行为可证"要求 |
| 感受段 | 主题锚 valence | soul-assembler 渲染 | IS NULL 守卫（derive 后渲染） |
| 证据回填链 | 锚/人物/身份事实 ↔ L1 | backfill 同款 | 重算精确一致（已验证 7/7 先例） |
| 漂移基线 | self-obs 统计 | get/setSelfObsBaseline | 首轮不误报 |

---

## 4. 属性总表（完整清单——所有者/内容/功能主语逐列标注）

主语标注：**所**=所有者主语，**内**=内容主语，**功**=功能主语。

### 4.1 L1 情景记忆（19 列 + metadata 8 项）

| 属性 | 类型 | 所 | 内 | 功 | 说明/消费方 |
|---|---|---|---|---|---|
| record_id | TEXT PK | agent | — | 工序 | 主键；slug/演化 lineage 锚点 |
| content | TEXT | agent | **多为用户** | agent 下轮注入 | 记忆正文；FTS/向量索引 |
| type | TEXT | agent | — | 渲染 | episodic/persona/结论等 |
| occurred_at | TEXT | agent | 事件 | R1 时近性、演化时序门、渲染"发生" | 事件时钟 |
| valid_start | TEXT | agent | 事实 | F18 检索过滤 | 有效窗开 |
| valid_end | TEXT | agent | 事实 | F18、F8 | 有效窗关；**未来值=窗口未开=现仍有效** |
| certainty | TEXT | agent（认识论） | — | 渲染"实见/推断"、演化门② | observed/inferred——**agent 的知识状态** |
| source | TEXT | agent 系统 | — | 审计 | extraction/consolidation/evolution/auto-growth |
| valence | REAL | agent（归档评价） | 信号多来自用户表达 | F4 情感显著度、锚方向聚合、渲染 | 情感效价 ∈[-1,1] |
| arousal | REAL（以 schema 为准） | agent | 同上 | F4、遗忘 | 唤醒度 |
| significance | REAL | agent（重要性判断） | — | 召回排序、遗忘保留、F13 反思触发 | [0,1] |
| priority | REAL | agent 系统 | — | 工序调度 | — |
| scene_name | TEXT | agent | 会话场景 | FTS 快照、L2 关联 | UNINDEXED 列 |
| session_key/session_id | TEXT | agent | — | 隔离/缓存指纹（O11） | 会话归属 |
| team_id/user_id/agent_id | TEXT | agent | 交互方 | **per-agent 隔离根** | 三元组主语 |
| task_id | TEXT | agent | — | 任务关联 | — |
| version | INT | agent | — | 演化守恒 | — |
| created_time/updated_time | TEXT | agent 系统 | — | updated 降序采样（selectSampleRows） | 系统时钟 |
| timestamp_str/timestamp_start/timestamp_end | TEXT×3 | agent | 事件 | 渲染"活动时间"、事件跨度 | 事件名/起/止三列（B1 PRAGMA 实证；无 timestamps 数组列） |

metadata_json 子结构：

| 属性 | 所 | 内 | 功 | 说明 |
|---|---|---|---|---|
| subject | agent | 记忆主题 | 演化门③（严格相等） | 主题一致性 |
| coreRefs | agent | — | 锚→记忆证据链（双向反查） | backfill 回填，已验证 |
| **personRefs（P2 新增）** | agent | — | 人物锚→记忆证据链 | 与 coreRefs 同款回填 |
| **identityRefs（P2 新增）** | agent | — | 身份事实→记忆证据链（GROW-MAINT 重算+遗忘保护 F14） | 20 字切片弱口径，仅警告不自动退场 |
| evolution{from,reason} | agent | — | 演化审计 | — |
| evidence_ids | agent | — | 合并溯源 | 引用纪律（Generative Agents 同型） |
| recall_count/last_recalled_at | agent | — | F3 强化、R1 时近性 | P0-T4 原子自增 |
| **sensitivity（D-3 已实施，2026-09-22 收口）** | agent | — | 召回门控/遗忘优先（已实施：R11 缺省 0/遗忘 bias 缺省 0） | 枚举 none/health/finance/relationship；枚举门单一源 normalizeSensitivity（l1-extractor.ts 导出，undefined/非法一律 none）；三层体现=注入徽章/出参/属性表 |
| **recurrence（D-4 已实施，2026-09-22 收口）** | agent | 事件 | 遗忘保护（recurrenceProtection 生产已启用） | cadence 六枚举+anchor 形状门 normalizeRecurrence（LLM 只提议、门裁决）；落 metadata_json.recurrence 零 schema；三层体现=注入徽章·周期:…/出参 metadata/UI 属性表「周期」行 |

**明确不建**：类别情绪（渲染时从 valence/arousal 派生，防双源漂移）；身份相关性-召回向（F14-bis 回音室禁令）。

### 4.2 core_values（锚层，加两列）

| 属性 | 所 | 内 | 功 | 说明 |
|---|---|---|---|---|
| value_id | agent | — | pin/retire/delete 路由 | slug；纯 CJK→auto-<sha256[:10]> |
| label | agent | 用户价值主题/用户生活中人物 | 渲染、证据重算、反查 | — |
| **node_type（P2）** | agent | — | GROW 口径策略化、渲染分行 | 'theme'（缺省）/‘person' |
| **attrs_json（P2）** | agent | — | 人物 role/aliases（方向由 valence 列承载） | 主题锚 '{}' |
| weight | agent（信念强度） | — | F5/F6/F12、渲染排序 | D6 绝对证据+饱和 |
| valence | agent（方针方向） | 聚合自证据情感 | 感受段渲染 | 趋近/审慎 |
| origin | agent | — | QUOTA 豁免判定 | seed/manual/auto |
| created_by | agent | — | 维护豁免判定 | verify/auto-growth |
| pinned/state | agent（维护决策） | — | 挤出豁免/全态去重/守卫豁免 | active/retired/vetoed |

### 4.3 core_memory（身份层）

| 属性 | 所 | 内 | 功 | 说明 |
|---|---|---|---|---|
| slot=identity | agent | **用户** | 渲染"我心中的他" | 语义收敛（P1 prompt 修正） |
| slot=self_identity（P1） | agent | **agent（第一人称）** | 渲染"我是谁" | 行为可证采纳门 |
| content/version/updated_at | agent | — | 演化审计、旧文留痕 | version++；旧文 logger.info 留痕 |
| source | agent 系统 | — | 审计 | identity-discovery / manual（Panel 清洗兜底） |

---

## 5. 计算公式总表

| 编号 | 公式 | 参数 | 消费方 | 状态 |
|---|---|---|---|---|
| F1 | RRF 融合：score = Σ 1/(RRF_K + rank)，向量路与 FTS 路各排一次 | RRF_K（实现常量） | 召回融合 | 已有 |
| F2 | 时近性信号 R1（occurred_at/last_recalled_at 衰减） | 实现内 | 召回排序 | 已有 |
| F3 | 使用度强化 R8：recall_count 加权 | 实现内 | 召回排序 | 已有 |
| F4 | 情感显著度 R10：valence/arousal 随池加权 | 缺省 0=恒等 | 召回排序 | 已有 |
| F5 | 锚强度：w = clamp((3 + 5·min(e,E_REF)/E_REF)/10, 0.3, 0.8)；e≤0→0.3；E_REF=50 | 绝对证据+饱和（D6） | 采纳/挤出/渲染 | 已有 |
| F6 | 挤出：candidateStrength = w(候选)·ev(候选) > min(displaceableStrength)；displaceable=active 非钉 auto，强度升序，tie 按 weight 升序→value_id 升序 | — | 名额满时 | 已有（口径已修复） |
| F7 | 演化五条件门：①冲突边 ②双方 observed ③subject 严格相等 ④newer.occurred_at>older ⑤非 pinned/vetoed+newerInvalid+幂等；改写=merged 记录+evolved_from×2+双失效（older.ve=newer.occurred_at，newer.ve=now） | — | evolution | 已有 |
| F8 | 首次权威不覆盖：invalidateL1 已有 ve→拒绝返回 false | — | 演化/夹具 | 已有 |
| F9 | 证据重算：recountEvidence(label, corpus)=每 token 均包含的记录数（lowercase；纯 CJK 单 token 整串） | — | 锚/人物证据 | 已有 |
| F10 | 身份采纳门：状态残留结构剥离（\d{4}[-年] 日期、P\d 阶段号→剥离所在句；整条全状态→拒收） | 单一源导出 | 身份双槽 | 已有 |
| F11 | 人物证据口径（P2）：personEv = \|{r: content 包含 label 或任一 alias}\| | — | 人物锚 GROW | 新增 |
| F12 | 关系权重（P2）：strength = F5(personEv)·personEv；valence=证据 valence 均值符号化（≥+0.2→1，≤-0.2→-1，否则 0，存锚 valence 列）；role/aliases=提案入 attrs_json | — | 人物锚/渲染/遗忘保护 | 新增 |
| F13 | 反思触发（P3）：自上次反思起新入库记录 significance 累计 > R_REF（缺省 150，Generative Agents 对标）→ 下 tick **提前+强制**执行一次反思式 L3 蒸馏（Generative Agents 三问式：从近期记录提"最显著的高层问题"→检索证据→合成结论卡写入 L3，引用证据指针）；固定 interval 兜底不变——语义=触发生成时机增强，不新增管道 | R_REF config | lifecycle 调度 | 新增 |
| F14 | 遗忘保护（P2）：forget 候选排除 coreRefs/personRefs/identityRefs **指向仍 active 的锚或现行身份事实**的记录——排除前重验 refs 有效性（锚 state=active、事实仍在现行槽内容中）；悬空 refs（锚已退休/事实已被修订替换）不保护——**防"永生记忆"违背自维护** | — | forgetting | 新增 |
| **F14-bis** | **回音室禁令：身份相关性禁止参与召回排序**（召回只由查询驱动） | — | 设计红线 | 永久 |
| F15 | GROW-MAINT（主题/人物/身份）：全量语料重算；ev<minEvidence→retire（pinned/manual 豁免）；\|Δw\|≥0.05→reweight；QUOTA 守卫**按 node_type 分池**（maxTotalTheme=15 / maxTotalPerson=8 各自独立：autoNow(该类)+pinnedNow(该类)>maxTotal(该类)→该类内强度升序 retire）——防人物锚挤占主题锚名额。**身份事实只警告不自动退场** | 分池配置 | 自维护 | 已有（身份/人物分支 P2） |
| F16 | 漂移旗标：drift=\|rate−prevRate\|/prevRate ≥0.3→AROUSAL-GATE；基线首轮落盘不误报 | — | self-obs | 已有（本轮修复） |
| F17 | 段级注入预算（P1）：soulRender.budgetSelfChars/budgetIdentityChars/maxRelationLines，超限按强度/序截断，宁缺毋滥；valenceDir 渲染映射：1→趋近、-1→审慎、0→中性、NULL→无标注 | config | soul-assembler | 新增 |
| F18 | 检索过滤：isInvalidated(r) = ve 非空字符串且 Date.parse 成功且 ≤now（**解析失败保留——宁缺毋滥不误删**，filter-invalidated.ts 实证）；租户三元组硬隔离 | — | 召回池组装 | 已有 |
| F19 | 采纳双门（锚/人物）：attempt 冷却 1h + adopted 冷却 24h + 语料增量门 + 空语料短路；护栏四件：ev≥minEvidence、maxPerPass、maxTotal（**按 node_type 分池，同 F15**）、全态去重（veto/retired 永不重提；去重键=**（node_type, label）复合**；人物锚另含别名维度——提案 label 或任一 alias 命中同类型既有 label/alias → 拒）。已知弱点（诚实登记）：F11 人物名宽口径（"女儿"出现在无关记录）会虚增 personEv——缓解=提案质量门+maxPerPass+QUOTA 分池，实证后再收紧口径 | config | GROW 家族 | 已有（人物实例化 P2） |
| F20 | 演进守卫红线：身份事实 retire 永不自动（P2 GROW-MAINT 仅警告+人工确认） | — | 自维护 | 新增 |

---

## 6. 使用场景总表

| # | 场景 | 流程 | 触及公式 | 预期 |
|---|---|---|---|---|
| S1 | 日常对话注入 | /v3/recall → soul-assembler 四段 → 召回段 | F17、F18 | agent 开口前带着"我是谁+我心中的他+我的方针+我的感受" |
| S2 | 记忆召回 | 查询→向量+FTS 双路→融合→过滤→top-k | F1-F4、F18 | 准确完整；降级打横幅；已失效排除；跨租户零泄漏 |
| S3 | 灵魂自生长 | tick→双视角身份发现→分级门→双槽落库 | F9、F10、F19 | 用户事实与自我事实各自演化；旧文留痕 |
| S4 | 记忆演化 | 冲突边→五条件门→合并+双失效 | F7、F8 | 门严不触发良性；lineage 可审计 |
| S5 | 遗忘与保留 | forgetting 扫描→保护排除→衰减回收 | F14 | 支撑灵魂的记忆幸存 |
| S6 | 人物相关查询 | "我女儿…"→FTS/向量+personRefs 反查 | F11、F12 | 人物维度召回与"重要的人"注入 |
| S7 | 身份修订 | Panel/API 人工清洗 → upsertCore（**UI 入口见 §6.5 U1：P1 只读展示，编辑入口 P2**） | — | 人工兜底；版本留痕 |
| S8 | 多租户隔离 | 三元组硬隔离；self_identity per-三元组 | F18 | 换 agent 测试可过；品格随关系分化（拍板） |
| S9 | 降级路径 | fts-only 横幅/无身份省段/无锚省行/基线首轮不误报 | F16、F17 | 诚实降级，宁缺毋滥 |
| S10 | 灵魂验收 | 换用户测试/换 agent 测试 | — | 见 §8 验收 |

---

## 6.5 Memory Hub UI 适配（终审 2026-09-17 增补；UI 现状实证：MemoryPanel/web/src/pages/ChatMemoryPage）

UI 视觉重构 spec（2026-09-10）确立 Surface S1-S6 与"零后端新增"原则。本节判定：本设计的数据在 **read API 已返回或随列扩展自动带出，适配=纯前端透传，无新端点**——与"零后端新增"精神兼容。

| # | UI 现状（实证） | 适配需求 | 分期 |
|---|---|---|---|
| U1 | `/v3/core-memory/read` 的 **slots 被 UI 丢弃**（chat-memory.ts:1594 注释实证"丢 slots"）——identity 槽内容在 Hub 完全不可见，**S7 人工清洗无入口**（spec 依赖 Panel 兜底却无入口=真缺口） | ChatMemoryPage 增**身份区**：identity + self_identity 两槽内容只读展示（+version/updated_at/source 徽标）——用户可审读 agent 灵魂、发现 O14 类丢事实；slots 写路由缺位，编辑入口 P2 | **P1** |
| U2 | ValueAnchorsPanel（S4）列表**不识 node_type**：人物锚上线后会与主题锚混排无区分；行内编辑三态(label/weight/valence)不含 attrs；关联记忆数反查不含 aliases 维度（计数偏低） | 类型徽标（人物/主题）+ **分池配额显示**（theme 15 / person 8，可入 S5 健康条）；人物行编辑含 role/aliases；反查计数并入 aliases；"重新总结方向"(derive) 对人物=valence 聚合重算，语义一致复用 | **P2** |
| U3 | S2 灵魂区 chips 仅 coreRefs；S3 记忆图金色描边=coreRef 命中、无人物通道 | chips 扩展：personRefs（人物徽标）、identityRefs（身份徽标）——复用现有 chip 机制；S3 加人物节点色/图例扩展 | **P2** |
| U4 | S4 已有"关联记忆数 via coreRef 反查"交互 | 人物行"查看关联记忆"跳转——复用同款反查交互（S6 人物查询场景的 UI 入口） | **P2** |
| U5 | L3 结论卡在记忆卡片/详情已有渲染 | reflection（F13）产物=普通 L3 结论卡，**零适配** | P3 零成本 |
| U6 | sensitivity 预留位无 UI | 预留徽章位（不实施，拍板后启用） | P3 |
| U7 | S5 健康条无锚池配额概念 | 分池配额迷你显示（可并入 U2，非独立必做） | P2 可选 |

**裁决**：UI 适配是本设计的**一等公民交付物**（不是附带）——灵魂对用户可见、可审、可清洗是"自维护"闭环的最后一环（用户看到 agent 的自我认知错了 → Panel 修 → 留痕）。U1 缺口若不补，O13/O14/O16 的人工兜底路径全部落空。

---

## 7. 分期计划（全景分期，每期独立验收）

### P1 双槽 + 四段渲染（灵魂骨架）
- core_memory `self_identity` slot（零 schema 变更）；identity-discovery 双视角（user prompt 主语修正"他是谁" + self prompt "行为可证"）；soul-assembler 四段渲染+F17 预算；旧文留痕。
- **UI（§6.5 U1）**：ChatMemoryPage 身份区只读展示（identity/self_identity 槽内容 + version/source 徽标）——slots 透传，零新端点。
- 配置：`memory.coreMemory.selfIdentity.{enabled=false,minEvidence=3,maxPerPass=2,intervalHours=24}`、`memory.coreMemory.soulRender.{budgetSelfChars=600,budgetIdentityChars=900}`。
- 写入口：allowedSlots 缺省白名单 +self_identity（信任边界扩展，config.ts:872）；maxContentLength=2000 与 F17 预算联动校验；**l1-extractor prompt 增补 agent 行为事实视角（metadata.agentAct 标注）——self_identity 语料前提**；enabled=false 时 identity-discovery 走旧单视角 prompt（逐位现状含 LLM 行为）。
- 验收：开关关=逐位现状回归；开=flowtest 真数据 SOP（自我事实从对话长出、换用户/换 agent 测试、渲染预算截断、identity 主语修正后 soul 块人工审读）。
- 顺手：identity 提取 prompt 主语修正（O15 遗留）。

### P2 人物锚 + 维护链（关系自我）
- core_values 加 `node_type`/`attrs_json`（ADD COLUMN 缺省 'theme'/'{}'——**sqlite 不可删列，回滚策略=列保留无害、缺省值即逐位现状**）；anchor-growth worker 双池扩展（person 池，F11/F12）；personRefs/identityRefs 回填；identity GROW-MAINT 重验证（F15 身份分支：只警告）+ F14 遗忘保护；strict_rule Panel 落点（O13 闭环）。
- 配置：`memory.coreMemory.personAnchors.{enabled=false,minEvidence=3,maxPerPass=2,maxTotal=8,intervalHours=24}`——maxTotal 为**人物分池**独立预算（F15 分池制），主题锚 maxTotal=15 不变。
  - 【2026-09-20 P0 审计注记（P0-F4）】代码缺省为 minEvidence=5/maxPerPass=1（宁缺毋滥方向有意从严）；产线 tdai-gateway.yaml 显式 3/2/8 为运行真值——缺省差异非文档-代码脱节，运行口径以 yaml 为准。
- 验收：人物锚 12 组真数据 SOP（别名归并/关系情感方向/挤出/维护退场/反查/遗忘保护实测）+ 回归全量。
- **UI（§6.5 U2-U4）**：ValueAnchorsPanel 类型徽标+分池配额+attrs(role/aliases)行内编辑+aliases 反查计数；S2 灵魂区 personRefs/identityRefs chips；S3 人物节点图例；人物行"查看关联记忆"跳转。

### P3 品格锚 + 反思公式（远期收口）
- **数据来源链（2026-09-19 落定）**：P1 的 prompt 视角已接线（AGENT_ACT_BLOCK，l1-extraction.ts），但 metadata.agentAct 字段未实施（审计 #6：全库 0 落地）；P3 spike 实测 agentAct 占比 0% → **按本节 fallback 定案：品格聚合源 = self_identity 槽演化史**（已实现，anchor-growth character 池）。
- 品格锚双源（与主题锚**共享注入预算、独立 maxTotal 分池**，F15）；F13 反思触发；sensitivity 若拍板实施。
- 验收：品格锚与主题锚并存不互挤（分池断言）；反思触发真数据实测（累计阈值 vs 固定 tick 对比）。

---

## 8. 测试与验证策略

1. **单测**：每公式一节（F5/F6/F11/F12/F13/F14/F17 新增用例；状态机骨架复用现有 27 锚用例的模式）；
2. **真数据 SOP**：每期 ≥12 组新鲜对抗种子（evN_* 前缀、flowtest 桶、相对时间戳），逐项验证+读回；
3. **灵魂双测试**：换用户（同 agent 两三元组，self_identity 可操作判据=两份事实清单做 diff：各自 ≥1 条对方没有的事实（分化）+ 人工审读共性职责表述；完全相同=失败——说明提取未吃到各自经历）、换 agent（同用户两 agent，灵魂四段应出现实质差异）；
4. **逐位现状回归**：开关关 = 现有 500 测试全绿 + 渲染字节级对比；
5. **对抗审查**：每期含去重对照（active/retired/vetoed 全态）、低于门槛对照、隔离对照、降级对照。

## 9. 演进边界（明确不做与触发条件）

| 项 | 触发条件 | 去向 |
|---|---|---|
| 图谱化（C） | 出现多跳消费方（"女儿在哪次旅行中和谁"） | 实体表+边表=邻接表，平滑升级 |
| 热路径记忆形成 | 对话内即时记忆需求实证 | LangMem hot-path 对标 |
| 跨 agent 蒸馏 | 多 agent 协同共享语义的实证需求 | 另立 spec |
| 类别情绪存储 | 渲染派生不稳定的实证 | 属性追加 |
| 敏感度门控 | 产品边界拍板 | P3 预留位实施 |

## 10. 风险登记（v5 台账关联）

- O13（pending 无落点）→ P2 strict_rule Panel 落点闭环；
- O14（身份替换静默遗忘）→ P1 旧文留痕 + P2 GROW-MAINT 警告制（F20 红线：身份永不自动退场）；
- O15（主语立场）→ 本 spec §1.2 三层法定案，identity prompt 修正入 P1；
- O16（agent 自我层缺失）→ P1 双槽 + P3 品格锚；
- O17（属性扩展）→ §4/§5 全量盘点落地（人物→关系权重→身份维护链）；
- O12（certainty 无门槛）→ 维持现状（证据门槛+maxPerPass 已是两道闸），留产线实例观察；
- O11（缓存隔离指纹）→ 不在本期，已登记。
- **台账 gated 项依赖（2026-09-17 对照 v5 全量）**：
  - **flowtest retirement（gated）**：P1/P2/P3 全部验收依赖 flowtest 桶——retirement 拍板前须完成各期验收或迁移验证租户；
  - **maxPerPass 定格（gated）**：anchorDiscovery.maxPerPass=3 为 FLOW-TEST 演示值——人物分池独立参数后互不影响，登记依赖；
  - **D5 R10 A/B**：F4 情感显著度缺省 0=恒等，A/B 结论回填 F4 参数；
  - **D2 产线替换（labels≥300 & 正例≥50）**：主题锚产线化门槛，P2/P3 产线启用继承该拍板；
  - **O7（lifecycle 嵌入接线，择机）**：evo_/dur_ 产物 metadata-only 无向量——S2"召回准确完整"对演化产物仅 FTS 层生效（S4 场景同理），已知限制；
  - O9（eager pool）/L2 300s 预算：与本 spec 无交叉。
- **UI redesign spec（2026-09-10）兼容性裁决**："零后端新增"原则成立——U1-U7 全部为纯前端透传（read API 已返回 slots、列扩展后 values 自动带出 node_type/attrs_json），无新端点；UI 适配为本设计一等公民交付物（§6.5），身份区缺口不补则 O13/O14/O16 人工兜底路径落空。

## 附录 A：业界调研摘要（2026-09-17）

- **Letta/MemGPT**：core memory = human 块（用户模型）+ persona 块（agent 自我）——O16 双槽的直接对标；sleep-time agent 独占记忆编辑（= 我们 lifecycle workers 的结构）；"记忆形成是增量的，会变乱——后台持续重组为 learned context"。（https://www.letta.com/blog/memory-blocks/ 、https://www.letta.com/blog/sleep-time-compute/）
- **Generative Agents**：score=α·recency+β·importance+γ·relevance（min-max 归一、等权、recency=0.995^h）；importance 写入时 LLM 打分；反思=importance 累计>150 触发、洞见引用证据指针——F13 的出处；我们的 RRF+四信号是同构工程化。（https://arxiv.org/abs/2304.03442）
- **Zep/Graphiti**：双时态四时间戳、矛盾边失效（t_invalid=新边 t_valid）——与 F7/F8 完全同构；"不能表示何时为真的图会把矛盾事实都端给 agent"。（https://arxiv.org/abs/2501.13956 、https://github.com/getzep/graphiti）
- **A-MEM**：新记忆触发既有记忆上下文更新——我们的演化是其门控保守版（门严不触发良性、门松污染难恢复的拍板被反向印证）。（https://arxiv.org/abs/2502.12110）
- **Mem0**：ADD/UPDATE/DELETE/NOOP 由 LLM 工具调用裁决——我们坚持"LLM 提议、确定性门裁决"的分界。（https://arxiv.org/abs/2504.19413）
- **CoALA**：semantic memory = "关于世界**和它自己**的知识"——self_identity 的学理定位；procedural = 我们的 skill worker。（https://arxiv.org/abs/2309.02427）
