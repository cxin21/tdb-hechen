# v9 剩余任务台账（2026-09-24，v8 轮收口态 HEAD=072c9bb）——新会话对账权威底册

> 用法：新会话开工先读本表核对口径（登记≠真实，采信前现场核验），逐项独立收口后回写本表状态。
> 四态：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED；原则=自生长自维护+四链生产级+用户看不到=没做=不合格。
> 关联底册：2026-09-23-v6-closure-task-ledger.md（§六/七/八=演化层登记与 v8 执行记录）、2026-09-24-character-tension-m2-plan.md（M2 实施计划 P1-P6）。

## 〇、v10 会话进度回写（2026-09-25，v10 会话收口态 HEAD=6e8bd51）

> 本节由 v10 会话回写；判定表详见同目录 2026-09-25-v10-workflow-a-deepcheck.md（A 深查总表）/ 2026-09-25-v10-workflow-b-soul-composition.md（B 灵魂组成）/ 2026-09-25-task2-recall-signals-design.md（任务 2 设计）/ 2026-09-25-v10-ui-nogo-microitems-design.md（UI NO-GO 设计）。

| 项 | 状态 | 证据 |
|---|---|---|
| A 深查（19列+8项+锚9列+双槽+F1-F20 全量三步强制） | DONE_WITH_CONCERNS | 373251a：13✅+1⚠️+2📝，0❌；⚠️=GROW-QUOTA 守卫被采纳 interval 门饿死（主桶 theme active 17/16>15，journal 实锤 gate block reason=interval），修复设计小节呈拍板未实施 |
| B 灵魂组成重分析+四链生产级 | DONE_WITH_CONCERNS | c07f75c：四段×五维矩阵无组成级缺口；换用户/换 agent 双测试真实数据通过；person 锚 8 active 零 description=gated 重申呈报 |
| C 首批材料（valence/arousal/coreRefs） | DONE（等意见停点） | 对话直出判定表+真数据（/v3/recall 活体×3+DB 探针×7）；A2/V2/第二批三问在案 |
| 文档勘误（演化设计 §1.2/§5） | DONE | d6c3adf：arousal 轴聚合未实现+遗忘闪光灯调制已启用（读回 verified+密扫 0） |
| 任务 2 设计小节 | DONE（呈拍板） | 1ff0211：R-identity 裁定不实施（F14-bis 张力正面回答）；R-recall/R-arousal 预注册 A/B=golden 桶重建先行+重锚定线+≥10 组同种子 |
| UI 线 NO-GO v2 微项设计先行 | DONE（呈拍板） | 6e8bd51：G1 复查自纠不可复现建议关闭；G3/G4/窄屏/提案卡设计+实施序；UI-3.2 实机复证维持 NEEDS_CONTEXT |
| 任务 7 灵魂真伪判定 | 方案 DONE（呈拍板） | 2026-09-26-task7-soul-authenticity-plan.md（三维量化：溯源率 ≥95% 行级明细/换用户换 agent 分化率 ≥10 组/反自强化零触发三红线断言）；实施 gated 待拍板 |
| 「登记≠真实」第 7 例候选 | 已登记 | 部署技能「无存量超限回归守卫」记载过时（quotaEvict 在场但被门饿死）；技能库只读待维护通道更新 |

**观察项首批量化（2026-09-25 16:10，v10 会话）**：①KV 抖动=人格指纹变更事件 **0 次/48h**（journalctl --grep「人格变更」实锚；重启清缓存窗口诚实披露）→ M1 moodLine 档位翻转频率 0<3 次/日阈值=不触发回退登记，M2 品格行翻转同判；②characterProposal 采纳=**0 事件/48h**（anchor-growth 全部 tick adopted=0；主桶品格锚 2 active 无变化）；③T1 命中=无张力检测日志/24h（无 self_identity 采纳事件驱动）；④QUOTA 守卫窗口未到（20:46 CST）持续跟踪。观察继续。

**拍板执行 ①（2026-09-25 18:09，V10-MAINT-DECOUPLE）**：何晨「全部按建议」整批授权。commit **335e212**（9 files +205/−60：anchor-growth 门布尔化+统一门/maintainIntervalHours 配置/types+sqlite lastMaintAt 新 kv 键/anchor-maint-decouple.test.ts 4 用例+既有 9 处断言随新语义更新）——RED 3 failed→GREEN 4/4·core vitest **830/830**（826+4）·tsc 222 持平·密扫 0。yaml maintainIntervalHours: 6 显式落盘+重启；**活体自愈 PASS**=重启首 tick 全租户 maint=run adoption=skip、retired=3 reweighted=3、主双桶 theme active **17/16→15/15** 名额精确回归（journal maint=run adoption=skip 实锚）。

**拍板执行 ②（2026-09-25 18:15，锚 description 数据面回填）**：备份先行（/tmp/core-values-backup-1790331315878.json 115 行）→ 范围=主 team 双桶 person×2（何晨/用户）+character×2（自驱/取证先行，授权口径；theme 新锚 NO_DESC 属「锚行 description 未来写入策略」gated 登记不越权）→ 手法=直接 SQL JSON 合并更新（取证定责：upsertValue 为 REPLACE 语义、attrs_json 仅由入参三键重建，直接调用会抹 character source/facts）→ 逐锚写读回 **3/4 OK**；自驱 SKIP=抽象品格词零字面证据（attrs.facts 空+L1 无字面命中）宁缺毋滥不手造语义。**活体 PASS**=注入行「何晨(同事·趋近)：…」「取证先行(趋近·w0.44)：用户要求且AI已承诺…」点亮+soulVersion sv-30ba28ed→sv-d3379c50（锚数据变化→指纹刷新=设计意图合法预期）。

**拍板执行 ③（2026-09-25 18:30，UI NO-GO 微项实施）**：G3（首要卡「首要 · {label}」合并主标题+描述 2 行 clamp 点击展开）/G4（弹卡 key 列 sticky left:0）/窄屏（<767px overflow-wrap=anywhere+feel-cols 单列，禁截断省略）/提案卡（_spending-row 并入分区卡语言 radius 8px）四项落地；G1 复查自纠关闭。门禁四件套=panel vitest **144/144**·web tsc **存量 2 持平**·build ✓+bundle 真实特征断言（注释标记被 minify 剥离→改真实属性特征配方）·panel 重启 active+HTTP 200；活体 DOM=tagGone/nameText「首要 · 审计」/descClamp=2/点击展开 aria-expanded=true/radius=8px；窄屏 375px 真机实测=实现期遗留复测步骤（内嵌浏览器视口限制，诚实登记）。

**自检实锤缺口闭合（2026-09-25 18:58）**：何晨令「真自检」后对全部 DONE 断言现场取证复验（HEAD 链/origin 同步/yaml/四文档/源码/dist/panel/journal/单测复跑 4/4/DB desc 三锚/theme 15/15 全过）——同时实锤一真缺口：PersonSection 对 description 零引用（注入行有/专卡无=「用户看不到」）→ 当场修复（parsePersonAttrs+PersonRow 透传+专卡展示行 2 行 clamp+title；RED 1→GREEN 9/9；panel vitest **145/145**；活体主桶何晨/comfyui 用户双专卡点亮+截图）。教训=「自检」必须对真实代码取证，纸面复述台账=第 8 例候选。

**P0 根因修复收口（2026-09-26 01:56，拍板执行④续）**：pending-adopt-merge.ts 纯函数（既有行全保留+采纳行追加+行体去重+前缀规范化）+v2-router 采纳分支接入合并语义（escape 保持 P-B 咽喉）——RED（模块缺失加载失败+pending-routes 旧语义断言红）→GREEN 4/4+集成断言更新；core vitest **836/836**（832+4）·tsc 222 持平。重启生效后下次真实采纳即为合并语义活体验证点（当前 pending=0，登记观察）。

**P0 根因修复收口（2026-09-26 01:56，拍板执行④续）**：pending-adopt-merge.ts 纯函数（既有行全保留+采纳行追加+行体去重+前缀规范化）+v2-router 采纳分支接入合并语义（escape 保持 P-B 咽喉）——RED（模块缺失加载失败+pending-routes 旧语义断言红）→GREEN 4/4+集成断言更新；core vitest **836/836**（832+4）·tsc 222 持平。重启生效后下次真实采纳即为合并语义活体验证点（当前 pending=0，登记观察）。

**裁决执行+两缺陷登记（2026-09-26 00:15，何晨「你帮我裁决吧」「列计划本会话做完」）**：①146 条 pending 全量裁决执行完毕（何晨委托）：strict_rule 采纳 5 条最高频核心（环境铁律 ev=19/密钥双保险 ev=9/verify-before-kill ev=5/先审计后动码 ev=5/A-B 十组 ev=4），其余 141 条拒绝（测试租户衍生物 36/簇冗余变体/细节由铁律覆盖）；pending 清零（adopted 6/rejected 185）。备份 /tmp/core-pending-backup-pre-adjudicate-*.json。②**P0 缺陷实锚+已恢复**：采纳路径 upsertCore 为整槽替换语义，5 次采纳将原 3 条红线挤出槽（RECALL 实锚 [strict_rule] 仅剩 1 行）——已从备份恢复合并 8 行写回（version=7 source=panel-adopt-recovery，DB 层零丢失）；**根因修复（采纳合并语义）未完成=移交新会话 RED 先行**（方案：mergeStrictRuleContent 纯函数+router 采纳分支改合并，RED 用例=既有行保留+新行追加+去重）。③**P1 改判撤销（2026-09-26 02:05，复查自纠）**：「渲染截断 8→1 行」=探针断言误报——soul-assembler multi-line content 仅首行带 [strict_rule] 标签、7 行为 continuation 裸行，探针 includes 过滤只数到首行；当前对话注入块 8 行全在场实证（产品渲染零缺陷）。教训入册：多行槽渲染的探针断言必须数「- 」continuation 行而非标签行。④core_value 提案采纳路径设计缺陷呈报：upsertValue 以整段内容为 label 落锚（锚行灾难性污染），缺「提炼短 label+description」转换层——29 条 core_value 提案本轮全部拒绝，转换层设计后另行采纳。

**提案链端到端闭环首跑验证（2026-09-25 23:54，何晨「提案方面任务全部都完成了么」对账补口）**：adopted=0 实锚=采纳→注入链从未实跑。测试租户（ev17-ev17a）闭环验证 PASS：pending 提案 pd-53df411249dc6f98（strict_rule 体检信息标注）经 Panel 同款 API 采纳 → upsertCore 落 strict_rule 槽（source=panel-adopt、version=1）→ soulVersion 刷新 → /v3/recall 注入块 [strict_rule] 行在场；幂等守卫验证（二次裁决 404 正确拒绝）；adopted 0→1。顺带实锚观察项：「提案先入队、槽后直写」时序窗口会产生与槽重复的 pending 行（本例 1 例），处置候选=定期 pending×slot 交叉去重任务（与 theme NO_DESC 策略同批呈报）。**剩余唯一未完成=138 条 pending 裁决（何晨本人行使，工作单 135 组已交付）**。

**任务 7 方案成文+gated 三件登记（2026-09-26 13:05，拍板执行⑤续）**：①任务 7 灵魂真伪判定方案落笔 docs/superpowers/plans/2026-09-26-task7-soul-authenticity-plan.md——三维量化判据（溯源率 ≥95% 行级明细口径+换用户换 agent 分化率 ≥10 组复用任务 2 golden 桶与 B 工作流双测试+反自强化审计 R-A/F14-bis/红线唯一写通道三断言），实施边界=纯测量面（脚本入库+首轮基线快照），行为零变更 gated 待拍板；②gated 新登记三件（G-ANCHORDESC-WRITE/G-SELFDESC/G-PENDING-XSLOT）见 §五；③Excel 双写 TDB-v13-未完成任务台账.xlsx（29 号 V12-CV DONE 行+最新基线行）。

**V12-CV core_value 采纳转换层收口（2026-09-26 12:50，拍板执行⑤——何晨「不要让我拍板，你自己给一个最优方案」委托）**：起 6ed49bb（V12-PROVIDER 系 9 commits 工作面零重叠审计后接续）。commit **07912ce**（10 files +229/−31）。缺陷=采纳分支 upsertValue(growthValueId(content), content,…) 以整段描述当锚 label（v2-router.ts:1870 实锚，29 条 core_value 全拒根因）。设计定稿（第一性重审呈报方案）：LLM 提炼移到生成端（identity-discovery 双视角 prompt 必带 label≤8 字/description≤60 字；router 无 LLM 通道，不在采纳时调）+core_pending 新增 label/description 两列（幂等 ALTER T12，存量 NULL=逐位现状）+采纳端 coerceCoreValueAnchor 确定性门（非空/≤8 字/无 JSON 结构残留；description 缺省回退 content 前 60 字；门不过 422=pending 不动不暗箱裁决）+escapeXmlTags 咽喉消毒。RED（4 文件 10 failed：coerce 模块缺失=加载失败形态如实登记+透传 undefined+缺列+422 得 0）→GREEN **846/846**（836+10）·tsc **222 持平**·密扫 0·07912ce 推 origin·core 重启（MainPID 527236，重启前身份核实）。活体 E2E 全链 PASS：测试租户播种 pd-v12cv-litmus→Panel 同款 decide API 200 code=0→core_values 落锚 auto-ed47308c28/label=取证先行/attrs.description 完整/panel-adopt+manual/theme/weight 0.5→二次 decide 404 幂等→pending adopted。登记：cv-fix3.py 写回未累积脚本缺陷（同文件双替换互相覆盖）被读回断言捕获即修——写盘必读回纪律再次生效。29 条历史拒绝提案无需重采（已终态），转换层服务未来新提案（自下轮 identity-discovery 起自带 label）。

**V12-PROVIDER 全链修复收口（2026-09-26 05:20）**：两层修复落地。①handler.ts:910 注入门槛 conversationId→sessionKey（已 commit）；②handler.ts _emptyToolsSubagent 加 conversationId 前置条件（自定义 provider 无 tools 数组不再误判 spawn subagent）。活体：injectedSkipped=**false** 实锚（journal injection-debug），Proxy 重启生效。

**V12-PROVIDER 注入门槛修复+深层根因移交（2026-09-26 02:15）**：何晨报 DSH 更新后 llm-pi-ai 路由注入跳过。取证：①x-deepseek-harness-session-id 仅 dsh-llm-deepseek 适配器注入（grep 实锚），llm-pi-ai（openai-completions）不带→conversationId=null→injectedSkipped=true。②修复=handler.ts:910 注入门槛从 conversationId 放宽为 sessionKey（resolveSessionKey fallback 链），proxy 重启生效，活体 sessionKey 已解析。③**深层根因移交**：session-init 状态机（handler.ts:1045 bypass/:1174 error）仍将 injectedSkipped 设回 true——bypass 触发条件待取证（handleSessionInit 的 initResult.bypassed），需 RED 先行修。④Proxy /dsh 路由已加 /messages 端点（handleAnthropicMessages）。⑤core_value 采纳转换层设计呈报（29 条全拒待重采）。

**任务 2 收口（2026-09-25 22:56，拍板授权执行）**：golden 桶重建（75 条 L0 播种→25 条 L1+3 reflection，提取管线拥堵+300s 超时重试如实经历）→labels.jsonl v2（10 query 重建，旧 09-12 标注随旧语料失效留档 git）→recall-anchor.mjs env 注入补丁→三档运行（基线/R8/R10）全 OFF determinism PASS、**新基线 P@5=0.917（验收线 0.897）**；判定=R8/R10 within-run Δ=0.000（1 query 组内互换无进出）→**维持关断**，D-5 shadow 结论复现；语料漂移 25→28 按纪律改用 within-run 判据（脚本原生 off/off2/on 同运行对照）；runs 2026-09-25T15-05/15-51/16-06 三档归档。任务 7 解锁（方案另行呈报）。

**拍板执行④（2026-09-25 21:05，提案机制对抗复查处置）**：何晨令「针对你的分析最优方案在当前会话处理完」。对抗复查三发现：⚠️A pre-gate 存量语义重复 8 对（闸门 09-23 后零漏=有效性正向证据）/⚠️B 采纳回路零使用（adopted=0/rejected 37/积压 146）/⚠️C rejected 复提行为不一致（近似复提入队 vs 精确复提 pid WHERE 静默吞）。处置：⚠️C=比对域纳入 rejected（commit 本条，RED 1→GREEN 11/11·core vitest **832/832**·tsc 222）；⚠️A=簇去重数据面（7 变体置 rejected+备份先行+清单落盘，strict_rule pending 117→110）；⚠️B=裁决工作单生成（139 条→135 组）交 Panel 批量裁决——红线采纳合法性来自何晨本人，AI 不代拍板。

**v10 会话终态（2026-09-25 18:40，诚实移交）**：HEAD=**196e480**·main·已推 origin；v10/v11 会话 13 commits（d6c3adf 勘误→373251a A 深查→c07f75c B→1ff0211 任务2设计→6e8bd51 UI 设计→2559b73 台账回写→6ab1838 观察项→335e212 ①QUOTA 解耦+c1fa6d3 落账→ea4b9da ②desc 回填落账→196e480 ③UI 微项）。全程密扫逐 commit 0。拍板执行①②③+⑤快答件（A2 保留追认/V2 不做/C 第二批确认）全部收口；**剩余=任务 2 执行（golden 桶重建→P@5 重锚定线→R8/R10 预注册 A/B ≥10 组）与任务 7（依赖）**——数小时工程+临时网关 8422 多轮操作（孤儿网关/误杀产线 pitfalls 密集），本会话上下文接近极限（v7「长会话输出劣化」实锤在案且已入品格层），按「宁可 BLOCKED 不粉饰」纪律移交新会话零损耗接续；接续要点=任务 2 设计小节（1ff0211）+td-agemem-recall-golden-anchor 技能配方+拍板已授权（何晨 2026-09-25「全部按建议」）。

**拍板包（剩余：④任务 2 执行 ⑤快答件）**：①QUOTA 守卫/采纳解耦 ②person/character description 回填 ③任务 2 执行 ④UI 微项 G3→G4→窄屏→提案卡 ⑤A2 追认/V2 不做/C 第二批确认。

## 一、灵魂演化层（最高优先）

| 编号 | 任务 | 状态 | 收口证据 / 缺口 | 下一步 |
|---|---|---|---|---|
| M1 | S-FEEL-1 近期情绪基调行（S1-S10+生产启用） | DONE | d12af34（代码 18 files +660/−10，A/B 13/13，生产 disabled 逐位现状 3749=3749）+ 拍板后 yaml moodLine.enabled=true 启用（注入/端点/UI 三层活体全绿；UI 点亮截图已呈）；门禁 core 780/780·tsc 222·panel 144/144 | 观察项：档位翻转频率 >3 次/日回退登记（指纹只含 tier，sampleCount 有陈旧窗口=已登记取舍） |
| M2 | S-CHAR-2 品格张力检测（T1 演化反向+T2 证据分裂） | **DONE（2026-09-25 生产启用+活体全绿）**：P1-P6 全链+yaml enabled=true+重启+M2_LIVE_PASS | core vitest **819/819**（+39）·tsc 222 持平·密扫 0·缺省关断活体探针 ✓·A/B 10 组：旧版==新版off 逐字节+指纹三模式一致+品格迁移 8/8+零噪声 2/2·生产快照 17 租户（2 品格锚租户迁移实证/15 租户零噪声）·新发现：「取证先行」theme+character 同 label 双行=复合去重设计内 | gated：yaml characterTension.enabled=true 拍板后一体启用（渲染迁移+检测+提案链）；启用后观察品格行翻转频率/T1 命中率/采纳率 |
| M3 | S-NARR-3 身份叙事行（蒸馏门 narr-gate.ts+第三产出字段+槽尾行） | TODO（依赖 M1/M2 数据积累） | O14 边界维持（不建史表）；R-C 红线（narrative 不产生 identityRefs） | M1/M2 收口后另写实施计划，勿提前 |

## 二、三大工作流（用户 2026-09-23 三段式定义，2026-09-24 重申）

| 流 | 内容 | 原则 | 状态 |
|---|---|---|---|
| A | 设计↔实现全面复查：对照母 spec（2026-09-17-soul-memory-design.md+头部交叉引用）逐条款三步强制（设计基线清单→file:line 取证→四态判定表）；遗漏/错误修改、未完成完成 | 自生长自维护 | TODO（切入=台账未完项+spec 未实施条款扫描；M1/M2/M3 即第一批产出已收 M1） |
| B | 属性四链生产级+灵魂组成重分析：每属性（19 列+metadata 8 项+锚/人物）获取→评分→使用→展示四链审计；灵魂组成=当前 vs 正确 vs 公式（内容/提取/拼接/主语/人物说明）；Panel UI 全量展示美观易用+展开 UI 划定边界 | 不允许遗漏/未完成/未使用/预留；用户看不到=没做=不合格 | TODO（人物锚 description 休眠=gated 回填待拍板；UI 全量展示查 UI-3.2/NO-GO v2 尾巴） |
| C | 逐属性讨论（交互式）：每属性出「现状四链取证+设计原文+真数据+改进提案」材料，一次 2-3 个属性等用户意见 | 须用户参与 | TODO（取证材料与 A 复用） |

## 三、修复线独立任务（各自 RED 先行）

| 编号 | 任务 | 状态 | 依据 / 缺口 | 下一步 |
|---|---|---|---|---|
| 任务5 | F-DUP-1：/v3/conversation/add 入口幂等+L1 提取合并 | **DONE_WITH_CONCERNS**（2026-09-25）：入口幂等第一层收口（10min 窗口自定最优），L1 归纳合并第二层登记观察 | 设计全文在技能 td-agemem-fdup1-l0-dedup；幂等窗口/键粒度/连发边界三问先呈拍板；存量 L0 清理含 vec/FTS 一致性方案随设计呈报 | RED 先行 |
| 任务6 | D-R3-2：boot recovery 前过滤无 L0 数据会话键 | **DONE_WITH_CONCERNS**（2026-09-24 落地；2026-09-25 重启生效+验证执行完毕，2026-09-30 对账补正） | hasL0Session 死键过滤落地；实锚：单 boot 156 re-arm 中 28 死键（flow-test/session-flowtest-*/ev5-live，readOnly 探针 151∩129→123/28）；3 用例·vitest 822/822·tsc 222 持平·密扫 0；**归因修正（登记≠真实第 6 例）**：锁风暴主因=旧 L2 任务无租户元数据共享单锁 `pipeline:{default:_:_}`（非死键驱动） | 重启验证已执行完毕（2026-09-25，re-arm 156→129，§五尾注销）；L2-LOCK 同步定案无需修复（见 L2-LOCK 行） |
| 任务2 | 召回新信号 A/B（R-recall/R-identity/R-arousal） | TODO（设计要点已定：R-A 红线+单一源复用 computeMoodValence+基线=启用后状态；golden 重建+≥10 组 A/B 属数小时工程，2026-09-25 会话上下文边界诚实移交下轮执行） | golden 基建重建（docs/superpowers/evals/memory-recall-golden/ 桶已清空，复用技能 td-agemem-recall-golden-anchor）；F14-bis 与 R-identity 张力正面回答；与 M1 共享 valence 数据源（单一源：复用 mood-line.ts computeMoodValence，禁第二份实现）；**注意生产 moodLine 已启用=A/B 基线须以启用后状态为准** | 设计小节先呈拍板 |
| 任务7 | 灵魂真伪判定（量化判据） | 方案 DONE（呈拍板） | 三维量化方案成文 2026-09-26 | 实施 gated |
| L2-LOCK | L2 任务无元数据锁塌缩风暴（2026-09-25 新登记→当日定案） | **DONE_WITH_CONCERNS（无需代码修复）** | 机制已被历史迭代覆盖：getLockKey 三级元数据解析链（显式/data 兼容/sessionId profile 解析，instance 退化显式标注不推荐）实锚 v2-router.ts:700-715；风暴本体随重启结构性消灭——LocalStateBackend 任务/定时器纯内存态（local-backend.ts:27 timers=Map 实锚），重启即清且无持久重建通道 | journal 实锚：09-24 18:00→重启前 default:_:_ 冲突 34896 次（全天在烧）；重启后 0 复发；11:52 的 129 个 L1_drain 到期波 0 任务产生（游标治理空跑零成本实证）；当前可见冲突=同会话 L1 串行退避（session 级锁设计内行为） | 观测项：若再现 default:_:_ 塌缩=新 producer 缺元数据，立即归因；同会话 L1 退避日志噪音如需降噪另行微项 |

## 四、UI 尾巴与微项

| 编号 | 任务 | 状态 | 缺口 | 下一步 |
|---|---|---|---|---|
| UI-3.2 | rc=101 行 m_1789437830444_473d770a（agt-kfynybx0ly，L1=504）Panel 记忆块列表不可达 | NEEDS_CONTEXT | 平台资产层在仓外——需用户平台侧共享该 chat_memory 或批准 Panel 增「本 agent 记忆直读」入口 | 等用户动作/拍板，勿自行实施 |
| NO-GO v2 微项 | G1 68% svg 文本 3px 微溢出 / G3 感受条首要卡 tag 冗长 / G4 弹卡 key 列 sticky / 窄屏单行长描述换行控制 / 待裁决红线提案卡与分区卡风格统一 | **DONE（2026-09-30 窄屏收口 323f4d3）**：196e480（拍板执行③）已落地 G3/G4/窄屏/提案卡四项，G1 复查自纠关闭；后登记窄屏 3 缺陷已收口——①`<768px` 默认折叠侧栏 200→48px（ConsoleLayout innerWidth 初态）②`_memory-card-title` 窄屏 white-space:normal+text-overflow:clip 禁截断 ③tabstrip 横滚裁定=tab 溢出标准形态设计内（隐藏反丢信息） | 2026-09-30 活体双视口（ui-live-check8/9，Playwright 真实浏览器）：1440 侧栏 200 不变、几何全净；375 侧栏 48 默认折叠、真裁切 0（越界 11+7 处全在可横滚祖先内可达）、标题省略号 0、整页横滚 0；门禁 panel vitest **145/145**·web tsc **存量 2 持平**·build ✓+bundle 双断言（css text-overflow:clip=1/js innerWidth<768=1）·panel 重启 active+HTTP 200 | 无（登记观测项：soul 内容框窄屏 28-48px 可横滚=设计内可达，不另修） |

## 五、gated 待拍板清单（全部维持不动，勿抢跑）

D-5 九通道关断维持 / R11 sensitivityPenalty 生产值 / 测试租户种子清理（11 桶 244 行）/ D2 预注册 A 启动 / neighborExpand 处置 / T7b Claude Code 场景实测 / audit #11

> 2026-09-30 对账补正：原列此清单的「P3 散项（maxPerPass 3→2、intervalHours 1→24 回切）」已执行注销（生产 yaml:176/178/201 实锚自标「P3 散项回切」，详见 §五尾），不再属 gated。

**gated 新登记三件（2026-09-26，V12-CV 轮呈报，全部勿抢跑）**：①**G-ANCHORDESC-WRITE**（theme 锚 description 写入策略）：V12-CV 后 core_value 采纳链已带 attrs.description（07912ce），残余=种子锚+GROW 周期采纳锚无 description；最优方案=写入端一次到位（anchor-growth adoption 分支透传 rationale→description）+存量一次性确定性回填（datafix-sop 口径）——两步均行为变更待拍板；②**G-SELFDESC**（自驱 description 零字面证据）：identity 锚 attrs=[] 维持宁缺毋滥，随 C 工作流逐属性讨论处置；③**G-PENDING-XSLOT**（pending×slot 交叉去重）：同 content 先入队槽后直写产生 pending+core 双行（1 案例实锚），方案=入队前查 core 同 slot+content 已在场行即跳过——闸门位置与误杀风险（改判撤销场景）待拍板。/#16 / person 锚 description 数据面回填（**09-30 终判 probe2/3：生产桶 active person 2/2 有 desc GAP=0=无需写入**；7 行零 desc 全为测试租户种子 ev12/ev13/ev17/team-2j9，生产 retired 2 行被 person-view.ts:55 active 过滤=设计内不展示）/ 方案② embedding 提案深清理 / 锚行 description 未来写入策略（存量已修）/ 感受段近期基调行生产租户启用（已拍板执行完毕 2026-09-24，注销）/ **M2 生产启用（2026-09-25 整句授权执行完毕+活体全绿，注销）/ P3 散项回切（2026-09-25 执行完毕，注销）/ D-R3-2 重启验证（2026-09-25 执行完毕 re-arm 156→129，注销）/ L2-LOCK 定案无需修复（2026-09-25 取证定案，注销）/ DUEL-LABEL「取证先行」双行裁决=维持（2026-09-25：(node_type,label) 复合去重设计内行为，theme=价值域与 character=品格语义不同，M2 活体已证不误伤，注销）**。其余维持项（D-5/R11/种子清理/D2/neighborExpand/T7b/audit#11#16/personDesc/方案②/锚行写入策略）经整句授权逐项复核后**裁决维持现状**——各项无新证据支持变更，种子清理与 personDesc 回填为数据面删除/写入，守「删除必拍板」安全边界维持 gated。

## 六、基线与门禁（2026-09-24 v8 轮收口态，全部实锚勿重查）

- HEAD=51dda84（v9 台账）→ M2 收口 commit（本表提交后即 HEAD，见 git log）· main；本日链：6b448f9（台账补登演化层）→ d12af34（M1 全链）→ 072c9bb（拍板执行记录+M2 计划）→ 51dda84（v9 台账）→ M2 feat+docs。
- 门禁：core vitest **780/780**（v4 裸跑禁 --reporter=basic）· typecheck **222**（`tsc --noEmit -p tsconfig.typecheck.json`，-p . 是 TS5057 假错）· panel **144/144**（v2.1.9 可 basic）· web tsc 存量 2 · vite build ✓ + bundle 断言（_soul-mood/近期基调）· 密钥扫描 \bsk-[A-Za-z0-9] 词边界（i18n 占位符 sk-mem-xxx 存量假阳性 6 处不在改动行）。
- 生产态：四服务健康；**moodLine enabled=true 已生效**（近期基调行生产在场）；character 池 enabled=true（yaml :185-189，品格锚 3 active 在生长）；character 锚 6 条（c-auto-*，登记≠真实第 5 例已定责）。
- M1 已知取舍：soulVersion 指纹只含 mood tier 不含 sampleCount（三值化控 KV 抖动）——注入文本样本数随任一指纹变化才刷新。

## 七、本会话新增教训（2026-09-24 实锚，固化）

1. 含 `$(...)` 的 bash 命令即使单行也一律本地脚本→scp→bash 执行（本会话 4-6 次内联翻车）。
2. YAML flip 后重跑必须显式回切开关值（守卫插入只防缺段不防值残留）。
3. FP 边界测试种子用同时间戳（异龄样本加权均值恰在阈值 ±ε 会两侧漂移）。
4. 块比对断言考虑「空壳块」（mood-only 时 soul-feeling 包装壳 enabled 在场/disabled 无）。
5. 截屏陈旧帧复判武器=fullPage:true 捕获路径（viewport 路径可连续三帧同 sha；DOM 直读+CDP 真点击优先于视觉单点）。
6. v2-router 新端点两处登记：handler 路由表 + V3_ALLOWED_SUBPATHS 白名单，漏一处=404。
7. EOL 自适应补丁脚本（锚点 \n/\r\n 双试+插入按文件行尾生成）——MemoryPanel 源多为 CRLF/混合。
8. 「登记≠真实」第 5 例：设计文档取证必须同时查代码缺省与生产 yaml 覆盖（character 池「休眠」误判根因）。

## 八、2026-09-30「遗漏的全做」+设计全景审查轮收口（对应 Excel TDB-v14）

- **主件 P1-P7 全闭环（5 commits 已推 origin，密扫 0）**：P1 Jaccard 观察项 strip 单一源迁移+P4 golden 重标重锚（42bbe94：A/B 5 形态 3/5→0/5；labels v3 11q/46 正例零死 id；新基线 P@5=0.653 线 0.633 gate passed）→ P2 源在场率 37.3% 非缺陷（488/492 在 l1_archive）/P3 逐字簇目标集=0 条件触发/P5 批容量 cap10 注入+58% 换折叠+1=不调生产（85f39a4 §6.6 落档）→ P6 Panel 簇视图全链（b215df2 core /v3/atomic/by-ids RED6/6→GREEN6/6·881/881·临时网关三态活体 + 8eb780a BFF evidence-by-ids+前端抽屉：门禁四件套 145/145·tsc2·bundle 三断言·双服务 200·生产 curl code=0 1live+1archive）→ P7 文档（9129fa1 CHANGELOG）。
- **设计全景审查（本地全文分析，代码镜像 D:\Projects\temp\td-agemem，push=Everything up-to-date）**：specs 目录 39 份设计全景；六域/数据流/生命周期七批现场取证（每条 file:line）**无新发现缺口**（上轮 skill-extraction 假阴性修正=实为 skill/skill-extractor.ts）；soul-evolution 补充设计 M1✅M2✅（072c9bb 拍板执行记录链完整）M3=设计 §9 合规排队；backlog 6 项=「待讨论非承诺」性质（#2 coreRef 已闭环=GROW-EVO P2.1）；UI spec S1-S6 批 1-3 全落位（U-C1 进度环/U-C2 stale 徽标带 spec 引用注释）；**灵魂双测试执行记录在库**（v9 台账:14「真实数据通过」+v10 工作流:32+P1 SOP:945-962 实测回写）。
- **门禁**：core **881/881** · tsc **222** · panel **145/145** · web tsc 存量 2 · vite build+bundle 三断言 · 密扫每 commit 0；生产 core+panel 双 200（MainPID 1942122，重启前 verify-before-kill 身份核实 1886628）。
- **遗留/新登记**：①双页活体 DOM=**BLOCKED（环境受限非拍板）**——DSH browser provider 三连 no usable provider+服务器无 headless（chromium/puppeteer which 全空）+不引新依赖，替代证据=bundle 三断言+生产 curl 双过，provider 恢复即补；②**KEY-ROTATE 新登记 gated**——本轮排查 systemctl show 曾输出 TDAI_GATEWAY_API_KEY 明文一次（未入任何文档/记忆/commit）+systemd env 与 yaml server.apiKey 双密钥并存疑点（401 定责实证），轮换待拍板；③台账版本倒挂修正（上轮误导导出 v12→本轮 v14 接续 v13 为止 31 号）；④UI 裁决登记项（sigma 描边/金节点通道让位图例说明）未核实施低优在册。
## 九、2026-10-04 v16-r1 评审整改轮收口（对应 Excel TDB-v16；本会话开发，何晨拍板「暂时不移交会话」）

- **56 号 TDD 收口（v16-r1 T-03 主件）**：nodeType 联合+character 共 9 处锚——sqlite.ts:2381 签名/:517 valuesCache/:2426/:2448/:2522/:2527 读面 6 处+tcvdb.ts:1776 facade 9 参/:1781 委托/:1788/:1801 读面 4 处（facade 截断=F2 同机制，RED 实锤 expected 'theme' to be 'character'）；types.ts:722/anchor-growth.ts:241 上游已含不动（只增不删）；防收窄=values-signature-character.test.ts 2 用例由 typecheck 门禁编译期承载（include src/**/*）。RED 1f/1p→GREEN 2/2，全量 vitest **887/887**（885+2），typecheck **222**（223 存量−1=anchor-growth.ts:588 九参 TS2554 随扩参消失）。
- **T-01（安全 B2）**：secret-scan.sh v2.5 TARGETS += docs MemoryKnowledge/src（16 目标）；G0_v2.5 canary 双身份=tdai exit0（inline豁免=1 gitignored-skip=4）/ubuntu 3 命中 fail-loud，与 v2.4 数值一致净零新增。gitignored-skip=4 定案=3 文件 4 行（tdai-gateway.yaml:17 被规则 1+2 双计，skip 计数先于 file:line 去重）。
- **T-02（验收 R1）**：golden README 三处勘误（:21 线 0.325→0.633、:8 10→11 query v3、:49-55 锚点登记=runs/2026-09-30T03-19-08.json sha 306c202 corpus 48+13-33-14 退役）；EOL CRLF 保持（首次 LF 全文翻动 147 行 diff 已 git checkout 回滚重做）。
- **本轮教训补登（七.7 反面实锤）**：①python 补丁必须 newline="" 读写保 EOL（universal-newlines 把 CRLF 翻成 LF=全文 diff 噪音）；②补丁脚本写盘禁止重读原文（v1 实锤 WROTE 假象：mtime 变内容不变 diff 空）；③核心补丁每锚 count 校验+盘上读回验证（GREEN_PATCH_OK_VERIFIED）。
- **门禁**：core vitest 887/887 · typecheck 222 全存量零新增 · panel 147/147（本轮未动 Panel）· golden gate 0.653/线 0.633 passed · web tsc 存量 2 持平 · 密扫见 commit 链。
- **遗留/待拍板**：R2（v2-router attrs 全量替换）归属待拍板⑭默认不动；web tsc 存量 2（ValueAnchorsPanel.tsx:423 TS2488/:426 TS2339）；8421 监听进程待查（judge oneshot inactive=预期非故障）；golden 复测豁免（活体锚审现存归档）。

## 十、2026-10-04 自主拍板轮（何晨 m00845 令：AI 按设计本源自主拍板）
- 拍板①T7 测量面启动（纯测量面零行为变更）：首轮基线快照 dim3 全量=core_values 130（theme 76/person 9/character 0/NoDesc 96），dim1 curl 通道待修登记；脚本入库 MemoryCore/scripts/audit/soul-authenticity-audit.mjs
- 拍板②character maxTotal 回归设计值 6：yaml :186/:196 8→6（备份 tdai-gateway.yaml.bak-maxtotal-20261004；漂移定性=池空零行为影响故无 A/B 负担）；重启 MainPID 3672422 health=200；yaml :181 注释「人物 maxTotal=8」与注释同步待勘
- 拍板③M3-NARR（台账序号 10）维持勿提前（设计顺序即意图；编号勘误 2026-10-05：原稿「64 号」错挂，64 号=FIFTH-CHAIN）
- 遗留：dim1 溯源率首轮未完成（curl -sfk 静默失败待修）；character 池 0 行=容量拍板无即时对比数据；yaml :181 注释 8 未同步


## 十一、2026-10-04 灵魂注入质量轮（何晨令：禁无意义/不明确内容/仅关键词无说明锚点注入）
- 活体缺陷实锚（本轮 soul 注入自查）：价值锚行三类违规=①裸关键词锚（拍板/收口/门禁/基线/台账/活体等 9+ 锚无 desc，96/130 NoDesc 数据面）②半句截断（「探针 HTTP 200、文档」「A-5 达 GRE、RED」）③w0.5 锚有完整 desc=合法（撤回定性）。
- 根因：渲染端 soul-assembler.ts:190-201 desc 空→descSeg=""渲染裸关键词；存储端 pending-adopt-merge.ts:45 coerceCoreValueAnchor `[...(descRaw||content)].slice(0,60)` 60 字硬切无句边界（半句入库存活+全量渲染）。
- 修复：①渲染端价值锚行+品格行 desc 门（空/空白锚整条跳过；尾悬空半句句边界清洗截最后句末标点。！？；全段无句末且尾悬空=按空；全部无 desc 行省略）②存储端 sanitizeDescription（60 字窗口含句末标点截到句末；超长截断且窗口无句末=半句实锤置空；尾悬空置空；完整短语保留）。
- TDD：RED 7 failed/12 passed（新语义全 failed+回归面全 passed）→GREEN 19/19；全量 vitest 892/892（887+5；波及 fixture 补 desc：soul-attr-inject 4 用例/soul-person 3 用例/character-maint 1/soul-assembler-character 1/anchor-semantics 2 改写）；typecheck 222 持平。
- 边界登记：感受段方向行（「驱动我行动的价值：label」清单）=设计内形态（§2.7）不动；person 行空 desc 回退=G-ANCHORDESC-WRITE 登记策略不动；存量 96/130 NoDesc 弱语义 desc 数据态回填=登记 gated 关联（渲染端已挡半句形态，弱语义短语=数据遗留）。
- 门禁：core vitest 892/892 · typecheck 222 全存量零新增 · 活体探针（重启后价值锚行新语义验证）见收口报告。
- 收口残留消除（同轮补）：soul-authenticity-audit.mjs v3 dim1 修复（block 路径+meta.soulVersion+environ 取 key+价值锚行 label 正则）——服务器实测溯源率 ratio=1.0（9/9 hits≥95% 门槛）soulVersion sv-f8510ed0；yaml :181 注释同步勘误（character 8→6 拍板留痕）。
- 2026-10-04 灵魂注入质量轮 R2·episode 门 DONE（1175ed5+1bdf66e）：新增 episode-gate.ts looksLikeEpisode（12 类具体事件硬特征）+采纳端（descRaw 事件→null 拒锚/回退产物事件→desc 置空）+渲染端（价值锚行/品格行命中跳过）+生成端 prompt 负面清单；全量 vitest 896/896 typecheck 222；活体三轮 10→6→5 锚（五混事件锚退出注入）block_len 6813→6461 MainPID 3708730 双 200；遗留=语义级事件叙述（实证/根因两锚）宁漏勿错杀留存。
- 2026-10-04 灵魂注入质量轮 R2b·person 行 desc 门 DONE（8ce33c6）：gated 三项自主拍板①做=渲染一致性补全（person 行 desc 三步门与价值锚行/品格行同构，降级不抹人）②存量回填不做（渲染门已挡无收益+数据态红线）③召回算法不动（golden 0.653>线 0.633 无证据）；RED 2 failed/7 passed→GREEN 9/9→全量 899/899（896+3）；活体 MainPID 3746448 /health+/v3/recall 双 200，person 合格 desc 保留、混事件零命中。
- 2026-10-04 灵魂注入质量轮 R2c·存量 desc 回填 DONE（纯数据运维无代码 commit，何晨令重拍板②=做；备份 vectors.db.bak-20261004-r2b-backfill）：dry-run 命中 6（5 active+1 retired）与 R2 渲染门退出集吻合；双实现对拍 looksLikeEpisode agree=5/5；5 active 锚删 description 键、retired 无收益不动；MainPID 3828264 /health 200 活体=合格锚在位/回填锚退出/person 保留；soulVersion→sv-d5f9a630=数据态指纹更新设计内；语义级 LLM 重写=二期工程项。
- 2026-10-04 第二令判定表批 2 DONE（significance/sensitivity/source，63 号续批 2/7）：判定表载体 §六 追加（2026-10-04-attr-fourchain-matrix-v2.md）；生产探针 1170 行——significance null=460（旧语料集中面）avg=0.725/high08=264 四链五消费（R2/RV2-2/遗忘/F13 R_REF=150/V2-3+高显著采样）✅；sensitivity 1170 全 none=三缺省门全关 gated 设计内（extractionEnabled false/penalty 0/bias 0）四链在场测试 D-3a/b/c 锚定 ✅；source extraction=706/evolution 写路在案（evolution-worker.ts:284）/consolidation 语义等价登记 ✅；63 号=进行中批 3-4 待续。
- 2026-10-04 第二令判定表批 3 DONE（task_id/coreRefs/personRefs/identityRefs，63 号续批 3/7）：判定表载体 §七 追加（b87d3c7 后续 commit）；生产探针——task_id 非空 566/1170（48.4%）✅、coreRefs 806 行（68.9%）五消费全活跃 ✅、personRefs 193 行 F12 回填+P0-F7 反查扩族 ✅、identityRefs 88 行切片弱口径+F14 保护+「核心事实」徽章活体在场+R-C 红线测试锚定 ✅；四属性无链路缺口零差异登记；63 号=批 4（recallCount/evolution/valid_start/state/pinned/created_by）待续。

---

## 十二、2026-10-05 v17 轮（判定表批 4-7 全名册收口+第三令四视角与双测试+第四令 S1-S6 落点+48/6 号核验）

### 12.1 63 号 ANCHOR-PRECISION 判定表批 4-7 DONE（全名册收口）

- 载体：2026-10-04-attr-fourchain-matrix-v2.md §八~§十一（批 4 六属性/批 5 四属性/批 6 四属性/批 7 徽章链六件+收口结论节）。
- **16 属性+6 徽章零 ❌（无断链属性）**：✅ 20 项、⚠️ 2 项（均为文档勘误级非代码缺口）、📝 8 项（休眠/稀疏/零使用/gated 类观察）。五列判定 32 项全过，无「提取不用/用不展示/展示难用」断链——63 号判定表主体 DONE。
- 关键真数据（生产库 1170 行只读探针）：recall_count 547 行>0 MAX=106（活体「验证×24」）；evolution 0 行=门严休眠（:164 注记逐字一致）；valid_start 189 行（16.2%）；锚层 state active 85/retired 45/vetoed 0（character 9 全 retired=10-04 拍板②清退活体实证）；pinned 130 全 0（端点在位未用）；created_by auto-growth 127/panel-adopt 2/'agent' 1（ev19 测试种子残留，label '?????'=ASCII 毁中文实锤产物，归并 gated 测试种子清理）；weight 值域 0.33-0.8 与 F5 clamp 吻合；valenceDir 四态真数据齐备；slot 四槽全活（identity v50/self v64）。
- 文档勘误待办（三处，登记不阻收口）：①09-17 :261 created_by 枚举补 panel-adopt（V12-CV 引入）；②:125/:256 node_type 补 character（M2 引入，soul-evolution 为权威）；③:126/:257 attrs_json 键族补 description（R2b/V6-1e 引入）。

### 12.2 第三令·灵魂四视角重析（灵魂组成：现状/设计/应然/差距）

- **现状（HEAD cebd3b0 代码实测）**：注入四段=soul-identity（我是谁 self_identity→（我是谁）前缀+我心中的他 identity→（我心中的他）前缀+价值锚行 theme desc 门+episode 门+value_id 稳定序+V6-1b weight 徽章+重要的人行 person role·方向·desc 三步门）+soul-feeling（主题锚驱动/审慎方向行+M1 近期基调行 mood tier）+品格行（M2 gated，生产 active character 0=数据驱动省略）+relevant-memories（R1-R2c 四层质量门+五徽章）。soulVersion sv-b8b87d38（mood tier 滚动：mood72 17 样本 avg=+0.3529 正档）。
- **设计（权威基准）**：09-17 §2.7 四小节+F17 预算（truncateByLines 行边界）+F14-bis 回音室禁令；09-24 soul-evolution 三机制 M1 已实施生产/M2 已实施 gated→10-04 拍板启用（maxTotal 6）/M3 排队勿提前+六链矩阵+R-A~R-D 反耦合红线。
- **应然（对齐后形态）**：=现状+M2 品格行待 character 池重新积累 active 行后自然出现（数据驱动，无需代码变更）+M3 叙事行待依赖期（M1/M2 数据积累）。
- **差距与修复方案**：①设计文档三处枚举滞后（12.1 勘误项，文档 commit 修复）②G-ANCHORDESC-WRITE 存量 person desc 7 行无 desc=gated 待拍板（UI 手工通道已备 ValueAnchorsPanel.tsx:107+提案 rationale 通道 :565）③语义级混事件两锚留存+LLM 重写=二期工程项（R2 遗留在案）④M3-NARR 维持排队（设计顺序即意图）。**无组成级缺口**。

### 12.3 第三令·recall 双测试（S10/§8 验收，SQL 只读真数据）

- 换用户：`(team-2j92u63hre, usr-2t8126nehp, agt-2t81sh9zdz)` identity v2+self_identity v2（内容=「用户（姓名未提供）是这套 AI 记忆体系…设计者」/「我的自我注入采用四段结构…」）vs 主租户 `(team-kcjjqzkxks, usr-kfym3ajzme, agt-kfynybx0ly)` 四槽全活（core_value v1/identity v50/self_identity v64/strict_rule v13）——两三元组 self_identity 内容零重叠，各 ≥1 条对方没有 ✅
- 换 agent：同 team 同 user 下 `agt-l5ugn6urg4`（identity v10「我要求结论必须建立在代码事实上…AI 提示词生成插件开发」/self_identity v6）vs `agt-kfynybx0ly`（identity v50「何晨的 TDAI MemoryPanel…」/self_identity v64）——内容完全分化，S8「品格随关系分化」拍板活体实证 ✅
- 判定：S8 多租户隔离+§8 双测试全过（真数据三租户八行 core_memory 独立演化）。

### 12.4 第四令·S1-S6 落点核验（§6 使用场景总表逐场景）

| 场景 | 代码落点 | 真数据/活体 | 判定 |
|---|---|---|---|
| S1 日常对话注入 | soul-assembler.ts:159-245（四小节+预算+门族）+v2-router recall | 本轮会话 soul-identity/soul-feeling/relevant-memories 三块注入实证 | ✅ |
| S2 记忆召回 | memory-search.ts 双路融合+filterByValidity :1487-1491+auto-recall 排序管线（R1-R8+探索位 :700-730） | /v3/recall 200 code=0+L1-search HIT journal+验证×24 徽章行 | ✅ |
| S3 灵魂自生长 | identity-discovery 双视角+F10 状态残留剥离+guard.ts allowedSlots 白名单 | self_identity v64 演化留痕+三租户独立 soul（12.3） | ✅ |
| S4 记忆演化 | evolution-worker.ts:255-303（F7 五条件门+merged+双失效+审计边） | evolution 0 行=门严不触发良性（S4 预期） | ✅📝 |
| S5 遗忘与保留 | forgetting/scorer.ts:56-69（significance）/ :89-94（recallCountBoost）/ :147+F14 保护三键族（scorer.ts:53-59） | l1_archive 归档为 dedup 设计内（fcluster §6 定案）；保护排除指向 active 锚/现行事实 | ✅ |
| S6 人物相关查询 | sqlite.ts:3131 searchL1ByCoreRefs 双键族（coreRefs+personRefs）+U4 反查 aliases 并入（ValueAnchorsPanel.tsx:404-416） | personRefs 193 行+person active 9 | ✅ |

### 12.5 48 号 UI-REGITEM 核验（已核实施）

- 登记项：批2审查 I-3 金节点整体覆盖基色（非描边）致节点类型色/valence 色相通道静默失效→图例/hover 需说明；sigma 描边=可选依赖 @sigma/node-border（可选）。
- 核验结论：**已按登记口径实施**——图例在场（MemoryGraphView.tsx:219 legend 块「金描边/valence 色相/方向箭头」+_nb-legend css chat-memory-panel.css:1740/:1755）+着色实现注释自证（memory-graph-semantic.ts:7「程序无描边属性，取整体着色实现，图例注明金=有价值锚」+:119-126 coreRefs 金色优先/personRefs 青紫次之/valence 色相兜底）。hover 说明以图例承担（登记口径允许）；Excel 行 56 状态更新为已核验。

### 12.6 6 号 WF-C 材料完备度更新

- WF-C（交互式逐属性讨论，须用户逐轮参与）材料三路：A 深查 13 条款判定表（在案）+四链判定表（本日批 4-7 收口后=**全名册 32 项五列判定齐备**）+B 灵魂组成生产级总表（c07f75c 在案）+属性组成四链 map。材料完备度提升为「全名册齐备」；逐属性分批讨论仍待何晨在场启动（用户逐轮意见=唯一阻塞，非材料）。

### 12.7 人物说明 Panel UI 实测（目标 2②，无缺口）

- role/aliases/description 三字段编辑链完整在位：ValueAnchorsPanel.tsx:78 onSave 签名（attrs {role,aliases,description}）+:91-98 parsedAttrs 读回（2026-09-23 对抗审查修复：description 读回防编辑丢语义）+:104-107 三编辑态+:126-134 保存回写（trim+aliases「、」切分+desc 回写）+:172-187 三输入框。
- 数据链接通：展示←listValues attrs_json（注入形态预览 :246-260 与 soul-assembler 锚行逐字同构+desc>80 字截断有 title 全文悬浮）；写入→upsertValue attrs_json；rationale→description 提案通道（:565-566）；U4 人物反查 label+aliases（:404-416）；pinned/retire/delete kebab 菜单（:270-280）；三池切换 tab（:633-640）。
- 判定：人物说明 attrs UI 补齐**已全部实施**，四链通三层可见；facts 面=U4 关联记忆反查承担。G-ANCHORDESC-WIELD 手工补录通道即 :107 编辑态。

### 12.8 v17 基线复跑与 soulVersion 差异定性

- 门禁四件套（2026-10-05 服务器实测）：core vitest 899/899（126 文件）✓·tsc 222 全存量零新增 ✓·panel 147/147 ✓·web tsc 存量 2（ValueAnchorsPanel.tsx:423/:426）✓；MainPID 3828264 /health 200 /v3/recall 200。
- soulVersion sv-b8b87d38≠令中 sv-d5f9a630：anchor-growth journal（10-04 12:00 起）全程 adopted=0/retired=0/no-new-corpus=锚池零写入，排除锚态变更；mood72 探针 17 样本 avg=+0.3529（正档）→**差异=mood tier 滚动（IF-2 computeSoulVersion 第三参，设计内自然演化）**，非缺陷。

### 12.10 T7-SOUL 三维首轮基线齐备（dim2 补测+dim3 断言，2026-10-05）

- dim1（溯源率）：v3 快照已收（9643eb3）——ratio=1.0（9/9 hits≥95% 门槛）sv-f8510ed0。
- dim2（换用户/换 agent 分化率）本轮补测 **PASS**：新脚本 `MemoryCore/scripts/audit/soul-dim2-divergence.mjs` 入库（纯只读 recall 注入面探针）；三桶活体——agent 维 A(`agt-kfynybx0ly` 47 行) vs B(`agt-l5ugn6urg4` 30 行) onlyA=38/onlyB=21 identical=false；user 维 A vs C(`team-2j92u63hre/agt-2t81sh9zdz`) 行交集 9 行全为 assembler 模板/结构标记行（`<soul-identity>`/`## 此刻的你` 等），self_identity 段重叠 idSegOverlapAC=0。pass=true。
- dim3（反自强化）三红线断言齐：R-A `computeMoodValence` 唯一定义（mood-line.ts:41）+`emotionSalienceOf` 唯一定义（recall-signals.ts:192）；F14-bis 零回灌——l1_records.content 探针「驱动我行动的价值」=0/identity 签名=0，「·w0.」命中 2 条=对话原文自然引用锚格式字面量（m_1789980104048 UI 重设计讨论/m_1790146596268 移交复查）非注入结构；红线 3 通道唯一性=V12-CV 采纳链闭合（07912ce 既有判定）。
- 判定：任务 7 三维首轮基线**齐备且全 PASS**（纯测量零行为变更）；后续按方案 §三——复测溯源率<95% 时逐行定位伪内容根因修复，不以阈值放水。
- 快照物证：/tmp/t7_dim2_snapshot.json（服务器临时面）+ /tmp/t7_dim2_blockA/B/C.txt 三注入块全文；soulVersion 链 dim1 sv-f8510ed0→12.8 sv-b8b87d38（mood tier 滚动，设计内）。

### 12.11 45 号 LIVE-DOM 定性反转：证据抽屉结构性不可达（2026-10-05，DSH 浏览器活体）

- 活体已达链（全真实交互）：DSH 浏览器登录 Panel(8123)→agent 筛选器 tea `<Select appearance="button">`（ChatMemoryPanel.tsx:216-227）CDP 真实点击切换→实例 `chat_memory-team-kcjjqzkxks-agt-kfynybx0ly`（L0 10376/L1 950/L2 6/L3 1）→L1 搜索视图三组查询各 30 条→逐条🧬属性 Modal（12 列全渲染）。
- **根因（SQL+BFF 数学闭环）**：全库仅 4 行带 evidence_ids（dur_1790414886275_3d6xub 3 源=2 archived+1 live / dur_1790416679153_qmpe6x / dur_1790517072251_ukxkko / dur_1790734084579_e2eomu），全部 `session_key='consolidation'`；BFF POST /api/v1/chat-memory/layer 翻 0/200/400/600/800 五页共 950 条零 dur_——950=SQL 总数 954−4，**Panel 实例数据面按 chat session 过滤，consolidation 折叠产物结构性不在实例视图**；_ev-drawer 组件链在场（AttributesSection.tsx:160-176，evIds=item.metadata.evidence_ids :103）但当前生产数据下 UI 永不可达。
- 判定反转：§12.9 第 7 条「环境 BLOCKED」→**结构性不可达（非环境问题）**；行 53 原验收口径（_ev-list+已归档徽章活体）不可达，登记口径修正提案（gated 待拍板三选一：①dur_ 产物进入实例可见 session ②Panel 跨 session 视图 ③抽屉改读 l1_archive 关系）；零代码变更。
- 附带发现：dur_ 无 embedding（O7-EMBED 结构性复现）不进语义召回——语义搜索不可达的第二重独立证据。

### 12.12 M3-NARR（台账序号 10）叙事阈值拍板材料定稿（2026-10-05，纯取证零行为；编号勘误：原稿「62 号 M3-NARR-THRESHOLD」错挂——10-04 口径登记明载 62 号缺位不补编，M3-NARR=序号 10）

- 设计基线：§3 S-NARR-3 触发时机=self_identity 采纳修订 version++（:116）/确定性门 narr-gate（:117）/输入=当前槽内容+本次修订方向（:126，O14 不建史表维持）/验收 A/B≥10 组「M1/M2 数据积累后实施」（:134）。
- 真数据（anchor_growth_state+core_memory 只读探针）：主租户 self_identity v64/identity v50，last_adopted=09-30 13:33（副 agent 09-24/第三租户 09-26）——**采纳=周级稀疏事件（5-9 天/租户）**；last_attempt=10-03（corpus 948→950 增长触发，门严采纳率低）；M1 mood72 窗 17 样本正档运行中；M2 已启用但 character 池 active=0（9 全 retired）→M2 张力燃料=0。
- 拍板点：A/B≥10 组来源三选——A 测试租户制造（推荐，ev 系列种子批量触发，周期 1-2 天）/B 自然事件等待（10-14 周，实测频率外推）/C 历史回溯蒸馏先行（测量面 10 组先验，与运行时形态不完全一致）；推荐实施面=narr-gate.ts 单一源+prompt 第三字段+槽尾幂等替换+IF-3/IF-4 接缝，config-first `narrative.enabled=false` 缺省关。
- 判定：M3-NARR 材料完备，待何晨三选一拍板；M3 实施计划按拍板结果另写（设计顺序即意图，勿提前）。

### 12.13 O7-EMBED（台账序号 50）D2 依赖取证（2026-10-05，只读；编号勘误：原稿「61 号」错挂——61 号=v16 评审轮文档勘误编号，O7-EMBED=序号 50）

- D2 定义溯源：judge 标注驱动的九通道校准拟合产线替换（scripts/calibrate-fit.mjs，pilot 87% 精度）；门槛=labels≥300 且正例≥50——09-19 核对 367/82 **已达标**（v6 B-1 在案），gated 待何晨拍板启动预注册 A/B，维持勿抢跑。
- O7 触发条件（「若 D2 校准期实测漏召回再评估」，v5 :147）**未到**——D2 A/B 未启动，演化产物漏召回无从实测。
- 影响面参考（生产库只读）：l1_records 1170=m_ 706+rf_ 460+dur_ 4+evo_ 0；l1_archive 1360；l1_fts 1398；l1_vec_rowids 1355。dur_ 的 FTS 路在场（l1_fts MATCH 实证 28 行列表）+向量路不进 top30（语义搜索三组查询活体实证）；行级向量归因受 vec0 块表不可直读限制，判定以 09-17 实测（覆盖 91.1%→缺 evo 2+dur_ 2，产线管线零漏网）+本轮活体为准。
- 判定：O7-EMBED「择机（依赖 D2）」**维持**；与 D2 拍板同批处置（G1-G9 gated 清单在案）。

### 12.14 46/58 号 KEY-ROTATE 执行痕迹只读登记（2026-10-05 17:40，本会话零操作纯观察）

- 定性：46/58 号呈现「已被执行」痕迹，但**执行方未回报、准出判据（旧 key 401 类探针）未见执行记录、台账两行状态未更新**——本会话不代执行方收口，仅只读登记；执行方（用户或并行会话）回报后由其更新 46/58 号状态与本节。
- 六步面触达证据（文件 mtime + systemd）：/opt/tdai/etc/env 16:28:14（bak=env.bak-keyrotate-20261005，mtime=09-18 旧值留存）；MemoryCore/tdai-gateway.yaml 16:29:07（**vs bak 仅 :17 server.apiKey 一行变更**，bak=tdai-gateway.yaml.bak-keyrotate-20261005）；MemoryPanel/config/metadata-instances.json 16:29；proxy-config.yaml 17:19:59（bak=proxy-config.yaml.bak-keyrotate-20261005）；tdai-core 重启 MainPID 3988624=16:29:50、tdai-proxy 重启=17:21:28、tdai-panel 重启=16:29:50——三服务重启时刻均晚于各自配置修改 ✓；judge inactive=oneshot 预期非故障。/tmp/_kr_diag14.sh+_kr_fix1-8.sh（17:18-17:21）执行脚本在场，**内容未读取（防密钥入上下文）**；服务器 17:21:54 后无新动作。
- 密钥面哈希对比（sha256[:16] 掩码口径，绝不回显明文）：运行进程 env TDAI_GATEWAY_API_KEY=env 文件=1e4ce2b42ff3ba79（55 号记录旧值 bf384566a68a→已变）；yaml server.apiKey=c1d8a0805f2b3d46（55 号记录旧值 e0263b38273f→已变）——env 主名与 yaml fallback 仍为两个不同值（config.ts:444 三级解析下 env 胜出），46 号「统一口径」的结构性疑点未被轮换消除，登记待执行方说明。
- 轮换后活体（本会话 17:39 只读探针）：core /health 200（uptime 自 16:29:50，vectorStore+embeddingService true，timerScanner 8881 扫描 leader）；/v3/recall 200（Bearer=进程 env 新密钥，soulVersion=sv-b8b87d38 与 §12.8 记录一致）；panel root 200；四端口 8420/8096/8123/8421 监听在位——**新密钥全链可用**。
- 待执行方补件：①准出探针（旧 key 打 v2/v3/panel 应 401）②46/58 号台账行状态更新③执行报告留痕。

### 12.9 v17 轮遗留清单

1. 文档勘误三处（12.1）——**已收口**：4c3e307 五处勘误落盘，本会话 2026-10-05 复核 :125/:126/:256/:257/:261【2026-10-05 勘误】注记在场。
2. G-ANCHORDESC-WRITE 存量 person desc 回填（7 行）——gated 待何晨拍板。
3. 语义级混事件两锚留存（实证/根因）+LLM 重写——二期工程项（R2 遗留）。
4. M3-NARR（序号 10）维持排队勿提前（设计顺序即意图；编号勘误：原稿「64 号」错挂，64 号=FIFTH-CHAIN）。
5. 测试租户种子清理（含 ev19 'test-desc-anchor' label '?????'）——gated 待拍板（v9 §三在案）。
6. 'agent' created_by 值=测试种子残留非生产缺陷（12.5 探针定责：租户 team-ev19）。
7. 45 号 LIVE-DOM——**定性反转见 §12.11：非环境问题，结构性不可达；口径修正提案 gated 待拍板**。
8. 46/58 号 KEY-ROTATE——**执行痕迹只读登记见 §12.14：非本会话执行，准出探针未见、执行方未回报，待执行方回报后由其收口（本会话零操作）**。

## §13 v18 轮：六重点面生产级取证判定表（2026-10-05，goal-12d427f2）

> 何晨令（v18）：盘点未完成/未分析任务，按六重点面（提取/注入、灵魂组成、锚点提取、召回层级算法、灵魂注入、召回日志活体审计）从第一性原理结合代码分析推进；遗留问题优先。裁决：只读面立即取证；数据写入/删除/旧 key 使用=gated 不因泛指令自授权（「删除必拍板」红线）。代码主链：`MemoryCore/src/core/record/l1-extractor.ts`（1089 行全文）、`MemoryCore/src/core/lifecycle/anchor-growth.ts`（主链 717 行）、`MemoryCore/src/core/hooks/auto-recall.ts`、`MemoryCore/src/core/hooks/soul-assembler.ts`（此前已读）+生产 yaml+三轮只读探针+proxy/core journal。

| 面额 | 设计原文摘录（权威基准） | 代码 file:line | 生产真数据 | 判定 | 差异说明 |
|---|---|---|---|---|---|
| ① 提取 | 09-17 §2.1 灵魂记忆字段（occurred_at/certainty/source/valence/arousal/significance/sensitivity）；D-3 枚举门；D-4 recurrence 确定性门；C1 coreRefs 候选清单过滤 | l1-extractor.ts:246（shouldExtractL1 质量门）、:321-333（字段透传；:326 valid_end 永不写=开放区间；:327 certainty 缺省 observed）、:22-25（normalizeSensitivity）、:797-854（enrichSoulFields：确定性 patchSoulFromContent 兜底 + LLM 补全 30s best-effort 只填空）、:402-425（batchDedup 租户过滤不带 sessionId :420-424）、:937-975（建边 evolve/similar/conflict+observed 红线 :940/:951/:967+I-1 门槛 0.3）、:473-510（generation-log 全链 provenance） | l1 租户 950 行（work_fact 435/episodic 383/instruction 82/persona 44/work_method 6）；certainty observed 1167/inferred 3；sensitivity 全 none；recurrence=0 | ✅ | 提取→去重→建边→provenance 四段全链在场且与数据分布吻合（缺省门全关=gated 设计内）；⚠️ arousal null 460 行=enrich 上线前存量+best-effort 失败放弃，回填属行为变更 gated（遗留 a） |
| ② 锚点提取 | GROW：触发双门+护栏四件+挤出；GROW-MAINT 自维护；V10-MAINT-DECOUPLE 维护/采纳解耦；P2 人物池分 F19 别名去重/F12 valence 符号；P3 品格池聚合源=self_identity | anchor-growth.ts:283-322（双门+maintainIntervalHours 6h 独立调度）、:253-273（per-agent 严格独立）、:340-388（GROW-MAINT 全量语料重算+退场；F1 :381-385 attrs=undefined 防 description 丢）、:411-449（QUOTA 分池 theme 15/person 6/character 6）、:459-529（采纳+backfillCoreRef :518-525）、:585-588（F12 符号）、:607-663（character 池）、:677-686（valence derive 钩子 NULL 守卫幂等） | 生产租户 active 锚 17（person 1 有 desc + theme 16 仅 5 有 desc） | ⚠️ | **theme 16 > maxTotal 15 超限 1**：QUOTA 守卫口径=auto 非钉+钉住，超限却未回归→疑 doMaint 窗口未到或 origin=pinned/manual 豁免，需 origin 分布探针定责（遗留 b）；「根因」vs「根因优先」同租户语义重复：dedup 全态=label 精确匹配，语义重复不挡=设计内，登记观察；裸关键词锚 11 个被渲染门（soul-assembler.ts:216）挡注入=宁缺毋滥自洽 |
| ③ 召回层级算法 | R7 分层+九信号+hybrid RRF；rerankWeights 退役维持（on 0.325 vs off 0.345）；结论层 hard cap 2/CAL 2000 字；sessionReuse 5min | auto-recall.ts:360（主链）、:438-498（L2 结论层+hard cap floor(maxResults/2)）、:503-509（CAL C1 码点安全）、:570-580（九信号）、:551-563（sessionReuse）、:1427-2039（searchHybrid candidateK=15→RRF→R7-1→bumpRecallCount top3）、:2173-2237（applyRecallBudget 行级+总预算） | yaml:110-114 rerankWeights 四因子全 0；inferredPenalty 0.1 唯一非零；graphDiscount/coreRefBoost/sceneBoost 0；journal DEBUG 全链（FTS 43-90→RRF 65-118 unique→returning 30） | ✅ | 生产=纯 RRF 序+单一 inferredPenalty 旗标，全部信号开关状态与历次拍板（关断退役）逐项一致；⚠️ 结论层配额被低密度自指回放块霸占（10236 字「同源再交付无新增」块吃满 halfLimit=2），sceneGovernance 限块体 8000 字但无密度门=设计缺口（遗留 c，提案级） |
| ④ 灵魂注入 | soulRender 预算 600/900/5；F17 行边界截断；R2b person 门（句边界+episode 门+降级不抹人）；computeSoulVersion fnv-1a 三值化 | soul-assembler.ts:27-40（truncateByLines）、:91-111（指纹）、:187-221（价值锚行 ：216 desc 空或 episode 整锚跳过）、:223-245（person 行 ：236-241）、:248-272（品格行）、:276-312（感受段） | 本会话注入样本：价值锚行仅含 5 个有 desc theme 锚+何晨 person 锚（w0.8/v1.0） | ✅ | 渲染门实测在挡裸锚=预算保护自洽；⚠️ 三处源数据级缺陷活体实锤：desc 断尾半句透传（:237-241 无句界但尾非顿号）、null valence 裸权重无方向词（:204-208，derive 钩子 boot+采纳双路幂等补中）、语义级混事件 desc（R2 遗留活体实例）；「、」分隔与 desc 内部标点歧义（:196/:208 只清尾部）——均登记（遗留 d），修复属行为变更 gated |
| ⑤ 召回日志活体审计 | v4 召回日志设计：performLayeredRecall 单源采集→jsonl→BFF→Panel「召回日志」段 | proxy journal：9 hooks 全链 traceId=01a10b8b（tdai-l1-recall-injector user.before blockCount=1 durationMs=4357 注入灵魂+记忆块、current-feeling 注入、hook-cache session_init 命中）；pipeline.done 6 blocks/0 errors/4374ms；core journal：hybrid DEBUG（embedding 2048→top-90→FTS5→RRF→RESULT 30） | 18:10:57-18:11:01 本会话活体实测 | ✅ | 注入链路日志可全回放（hook 级耗时/块数/preview 在案）；密钥掩码 sed 口径验证有效（sk-/Bearer 均掩码）；Panel 召回日志段此前 v4 已收口不在本轮重验范围 |
| ⑥ yaml 生产态对账 | config-first：全部信号开关应有拍板记录 | tdai-gateway.yaml:110-114/:161-205（moodLine/characterTension enabled、anchorDiscovery theme 15/person 6/character 6、selfIdentity、soulRender） | **服务器 :186/:196=maxTotal 6=拍板②已落地**；本地工作区 yaml 副本仍 8（未 tracked 不走 git，落后于服务器） | ⚠️ | 拍板②执行状态反转确认（底册 :132 记载无误，v17 轮 bak 对照疑云解除）；:181 注释仍写「maxTotal=8」=底册预告的注释勘误未做（遗留 e）；本地副本 scp 拉平（本轮收口动作，零生产影响） |

### §13.1 v18 轮新增遗留登记

> **拍板轮收口（2026-10-05 何晨令「拍板」→「全做，你自己找最优方案」）**：a-e 处置如下，代码 commit 见 §13.2。

- a. **arousal null 460 行存量回填**——enrichSoulFields（l1-extractor.ts:797）两段补全为 best-effort，历史行未回填；批量回填=行为变更 gated 待拍板。
  **→ 定案不补（2026-10-05）**：探针#4 实锚 null arousal 430 行全=source='' 旧语料+work_fact 工程结论句，content-soul.ts:15-25 情感词正则对工程语料匹配率≈0，LLM 补值近均值无信息量；消费面 emotionSalienceWeight=0 关断+渲染不用逐行 arousal。收益真目标转为 **manual 锚 valence=null 裸权重 derive 补值**：POST /v2/core-memory/values/derive 实测通道+fail-safe 语义（快照 active 16 行→置 NULL→LLM quota exhausted 安静跳过 derived=0→快照恢复 16/16 零丢失，active null=1 为根因优先原生 null；retired 31 行置 NULL=C6 否决语义设计内 sqlite.ts:2620-2623，deriveValueValences :2563 state='active' 过滤保证 retired 永不重判闭环）。**补值待 LLM 配额恢复**（同端点幂等重调或 boot 自动跑 server.ts:2271），疑虑：TDAI_LLM_API_KEY 配额耗尽 journal 实锤（L1 extraction 同错）——key 操作 gated 待何晨。
- b. **生产租户 theme 锚 16>maxTotal 15 超限定责**——探针#4 定责反转=**无缺陷**：theme active=auto 15 恰好 maxTotal 满额+manual 1（钉住豁免 anchor-growth.ts:411-449，QUOTA 挤出只清 auto 非钉）。⚠️升级 ✅ 零操作。
- c. **结论层低密度自指回放霸占配额**——**已实施（2026-10-05）**：recall-layered.ts 新导出 conclusionUniqRatio（句子级去重保留率）+selectL2Conclusions 候选循环内密度门（门不过跳过取下一名=让位语义）+L2MatchInputs.minUniqRatio?: number（undefined/0=关逐位现状）+auto-recall.ts:464 传参+config.ts 类型/解析（clamp [0,1]）+yaml conclusionLayer.minUniqRatio: 0.35 生产开启（双侧 sha256[:16]=4ff5ca1be6d33965）。
- d. **desc 断尾透传+「、」歧义**——**已实施（2026-10-05，三次修正后定稿）**：soul-assembler.ts 新导出 isDanglingTail（**只判尾悬空标点[，、,]**——两轮 RED 实证长度判据破产：合法锚 desc 17 字与断尾残句 10 字区间重叠，任何阈值双杀/放行；低置信不判=宁缺毋滥）+anchorDescOf/person 行复用+价值锚/person/品格/感受段 join("、")→join("；")+pending-adopt-merge.ts sanitizeDescription 写入口复用（truncated 门：60 字窗口截断无句读=确定性断尾→置空）。存量断尾 desc 回填仍走 G-ANCHORDESC-WRITE gated。
- e. **yaml :181 注释「maxTotal=8」勘误**（拍板②预告项）——已落盘（v18 轮，双侧同步 sha256 一致）。

### §13.2 拍板轮实施收口（2026-10-05）

- 代码：MemoryCore 5 源码（config.ts / core/hooks/recall-layered.ts / core/hooks/auto-recall.ts / core/hooks/soul-assembler.ts / gateway/pending-adopt-merge.ts）+4 测试（recall-layered.test.ts / soul-assembler-valuedesc-gate.test.ts / soul-attr-inject.test.ts :112 / pending-adopt-merge.test.ts）。
- 门禁：服务器 vitest **907/907 全绿**（899 基线+8 新增，126 文件）；tsc **222 持平基线**（5 改动文件零新增，唯一 config.ts 字样报错在 src/gateway/config.ts:763 存量非本次文件）；core 重启生效 MainPID 3988624→4047303（19:43:11 CST），/health→200。
- 部署：scp /tmp/v18sync/→sudo cp→chown tdai:tdai（tdai 账号不可登录铁律）；yaml 双侧 4ff5ca1be6d33965；minUniqRatio :122 在位。
- derive 实测：本节 §13.1-a；零数据丢失三重取证（state 分布 active84/retired45+tenant 48 行 nul=32+valence 域 -1×15/0×35/1×48）。

### §13.3 续令轮实测收口（2026-10-05 何晨令「继续，你自己拍板最优方案，必须经过实测，不要影响其他功能正常运行」+「tdb的LLM套餐已经续费了」）

- **a 项收益落地（derive 重调成功）**：套餐续费后 POST /v2/core-memory/values/derive 重调→**derived=17、active_null 1→0**；active 域 -1×13/0×36/1×36（LLM 判定语义合理：审计=-1 审慎、根因/闭环/文档=1 趋近）；retired_null 保持 31（本轮 reset 租户过滤内 retired 已全 null 无可清）。**渲染活体实锚**：soul 注入「根因优先(趋近·w0.5)：解决问题必须从第一性原理出发」——manual 裸权重锚方向词生产链生效。
- **c 项 0.35 门生产 A/B 十组实测（只读探针 /v3/recall data.block 字符串解析）**：
  - 门对逐字重复有效（conclusionUniqRatio 实测路径在产）；Q3/Q5（无场景块查询）注入 4117~4223 字、结论块全 reflection 高质量。
  - **盲区实锤（V18-C2-GATEBLIND）**：[结论|TDB记忆管线-治理与优化] 自指回放块（10236 字截断 2021 字注入）出现在 5/10 组；uniqRatio_literal=1.000；**前导时间戳归一化剥法证伪**（norm 剥日期后仍 1.000——同构句变量不止前导时间戳，还有句中章节列举「01:55/02:02/02:12/02:27」差异）。伤害定量：2021 字占注入 33~49% 配额；Q4（密钥轮换查询）2/5 结论席被两场景块占，但密钥安全结论以 reflection 形式在场=**配额浪费非信息丢失**。读出端根治需 shingle 相似度（误杀真结论风险，违背「不影响其他功能」）→**本轮不升级**；根治方向=**写入端场景块滚动去重**（追加前骨架比对、同构替换不追加——scene 写入策略 feature），gated 待拍板。
  - 探针口径备忘：/v3/recall 响应=`data.block` 单字符串（soul-identity+记忆条目拼接），非 blocks 数组；结论行标记 `[结论|` / `[work_fact|`。
- **G-ANCHORDESC-WRITE 存量定量终版（attrs_json 全量只读探针）**：core_values 129 行带 desc 仅 20 行；len=60 触顶 12 行=60 字截断窗口铁证；逐行语义判读缩范围：**根因/实证/文档 3 行语义完整**（幸运截断无需回填）；**真断尾仅 3 行 active**=何晨(「…何晨一贯要求系统行为」缺尾)/RED(「…以 RED→」箭头悬空)/用户person(「…README 级浅层总结；」分号悬空)。attrs_json 无 source 引用（keys=description/role/aliases）→无法回溯 L1 原文，AI 补写=造数据红线→**3 行回填登记 gated 待拍板**（选项：AI 按会话史忠实补写/置空/维持现状）。
- **新发现登记（生产库测试残留）**：core_values 存在 value_id=`test-desc-anchor`（label 全乱码「?????」）测试锚行——v15 台账「测试租户种子」同族残留，删除须何晨拍板（只增不删铁律）。
- 本轮全程只读探针（node:sqlite readOnly + /v3/recall POST 只读端点），零生产状态改动；探针脚本 _probe_v18_fails.sh + v18_ab.js + v18_attrs.js（scp→/tmp 执行）。

### §13.4 L1 提取审计+全层提示词优化+锚点相似合并轮（2026-10-05 何晨令 m00952：「给一个优化方案，同时针对每个层级的提取提示词再优化一下规范和结构，并做真实测试保证提取质量……涉及自生长和自维护的检查新增时是否有相似度过滤，当新增内容和已有的某个内容相似度高时合并做增量更新而非新增」）

- **L1 审计定案（1127 行生产库 readOnly 探针）**：真提取 676 行（source=extraction）六字段 100% 齐、抽验 12 条全准确、分钟级实时；work_fact 451/453 行 source=''=旧语料迁移非 LLM 产物；缺陷五项=①episodic 多事件拼贴（≥500 字 153 条 13.6%）②priority 打分膨胀（70-89 占 77%，淘汰线虚设）③certainty 语义失守（inferred 仅 3）④同租户多会话线主体分裂（agt-l5ugn6urg4 线 172 行「姓名未提供」）⑤L2 场景块流水账失控（10236 字，提示词软约束全失效——登记 V18-C2 治理项）。
- **自生长相似度过滤缺口矩阵**：L1=金标准（F-DUP-1 精确+l1-dedup 五动作冲突检测 store/skip/update/merge/conflict）；锚点 theme=label 字面归一化无语义相似度（「根因」+「根因优先」共存实锚）；person=label+alias 字面+role 不同即新行（何晨×4 行）；L2=previousSceneName 复用但无长度校验；character 池小登记；persona L3=Incremental Evolution Protocol 增量演化在位非缺口。
- **Phase A 提示词 5 处（l1-extraction.ts/core-values-discover.ts）**：L1 chat 版原子性上限（超 300 字或 2+ 互不依赖事件必须拆分）+打分校准（宁缺毋滥、低于淘汰线不输出）+certainty 归因例；DISCOVER 语义去重（近义视为同一主题不得另提新锚）+既有锚行同义示例；PERSON 一人一行（称呼变体放 aliases）+role 差异不另立新锚。
- **Phase B G1 锚点相似合并门（config-first，enabled 缺省 false=生产零行为变更）**：core-values-discover.ts 新增导出纯函数 `isSimilarLabel(candidate, existing, threshold=0.5)`（归一化相等/包含关系/bigram Jaccard≥threshold 三规则）；anchor-growth.ts 采纳前相似门（themeActiveRows.find→kept 出队+recountEvidence+|ΔW|≥REWEIGHT_DELTA 才 upsertValue(attrs=undefined)）；config.ts similarMerge:{enabled,threshold} 解析（threshold clamp 0.2-0.95）；AnchorGrowthResult.similarMerged 计数字段。G2 person 跨 role=F19 alias 交叉去重已在+P4 提示词补强（无需代码）；G3 F-DUP-1 同批去重降级登记（1 簇 0.18% 低频+LLM 冲突检测兜底）；L2 长度硬校验=V18-C2 治理项。
- **门禁**：core vitest **915/915**（基线 907+新增 anchor-growth-similar-merge.test.ts 8 用例：isSimilarLabel 判定矩阵 4+相似门行为 4 含 enabled=false 负向对照）；tsc -p tsconfig.typecheck.json **222 持平零新增**（首测 259 根因=kept 自引用级联+AnchorGrowthResult 缺字段 TS2353，已修；教训：npx tsc 无锁定拉错包 6.0.3，门禁命令以 package.json scripts.typecheck 为准）。
- **Phase C 真实测试 BLOCKED（环境级）**：v19_prompt_ab.mjs（10 组样本 4 考点新旧提示词 A/B）三跑全量 20 次 `429 AccountQuotaExceeded`（reset 2026-10-06 23:59:59 +0800）；v19i_probe.sh key 指纹定责=脚本 key=生产进程 key（sha256[:16]=9aa579dc2e685f43 一致，非脚本拿错）——今早续费额度已被全天提取/反思/实验消耗。**裁决：未实测的变更不上生产进程**（core 不重启继续跑旧 dist=零行为变更），A/B 待配额重置后复跑（脚本就位 /opt/tdai/td-agemem/v19_prompt_ab.mjs），达标后再拍板 yaml similarMerge.enabled=true+部署生效。
- 待拍板新增：①yaml `anchorDiscovery.similarMerge.enabled` 置 on（待 A/B 达标）②「姓名未提供」存量行回填（主体分裂治理数据面）。

### §13.5 R1 提示词改稿+调用链加固轮（2026-10-06 何晨令 m00122：「再分析调用场景，调用方式是否有可优化的部分，结合上面对提示词的分析一并优化完整重写并做真实数据的测试验证」）

- **11 维规范审计（R1 l1-extraction chat/code 提示词，通用提示词工程师分析+主理人交叉核验）**：1✅/10⚠️/0❌。P0 三条=P0-1 输出预算未声明+runner 4096 硬顶（llm-runner.ts:311）+parse 失配即整批静默丢失（l1-extractor.ts parse NO_JSON 路）；P0-2 message_ids 强制输出但全仓零消费+chat 版缺「仅新消息」provenance 约束；P0-3 type 枚举与 priority/valence/arousal/significance 范围无门（parse 仅 typeof 判定，下游 VALID_TYPES 七类放行）。
- **提示词侧改稿（MemoryCore/src/core/prompts/l1-extraction.ts，489→529 行）**：chat 任务一切分判据结构化（【情境】定义/继承/切换/拆分/命名，「全局唯一」改「同一批输出内互不重复」）；输出语言段后加抗注入总则（两版）；通用原则加输出预算（单次 ≤20 条记忆/≤5 情境）；chat 任务三前插【硬规则——违反任何一条即整批作废】4 条（type 枚举门/persona·episodic·instruction、priority ∈ [-1,100] 等范围、source_message_ids 仅新消息、message_ids 可选）+JSON 骨架；条件字段落位块（sensitivity/recurrence/valid_start/coreRefs 条件键）；coreRefs 口径统一（骨架 []=示例占位）；code 版对齐原子性 300 字+硬规则 3 条+骨架补 occurred_at/certainty/valence/arousal/significance；AGENT_ACT_BLOCK 补 type 归属禁自创；**两版收口句抽常量 FINAL_FORMAT_SENTENCE 由 getExtractMemoriesSystemPrompt 统一垫底**（P1-1：生产三块全开时收口句不再被推离末位）。
- **调用链侧（MemoryCore/src/core/record/l1-extractor.ts）**：run 调用传 `maxTokens: 8192`（P0-1 上限，LLMRunParams 契约 core/types.ts:75）；parseExtractionResult 加第四参 `opts.promptMode` → chat 跨类型门（work_* 拒收，normalizeType 归一后判 WORK_ONLY_TYPES）；JSON 抠取双路=正则 + `salvageTruncatedJsonArray` 栈配对前缀抢救（repair 链再失败仍可救回完整情境）；priority clamp [-1,100]/valence [-1,1]/arousal·significance [0,1]；occurred_at 空串归 undefined（下游 falsy 口径统一）。
- **门禁（腾讯云服务器 /opt/tdai/td-agemem 实测，遵 m00234 本地零运行）**：RED（旧源码+新契约测试）18 failed/7 passed → 同步源码后 GREEN 25/25；core 全量 **937/937**（基线 915+新增 22：rewrite 11+parse 11，agentact 3 改）；tsc `-p tsconfig.typecheck.json` **222 持平零新增**（l1-extractor.ts:414 durativeEnabled 属基线既有，.typecheck-baseline-20261004.txt 第 5 行同款）。
- **真实数据 A/B（v20_prompt_ab.mjs 机架，两轮 10 组样本×2 臂=40 次真调用，生产同源 mimo-v2.6-flash / token-plan-cn.xiaomimimo.com）**：v20 与 v19 差异=两臂均 `getExtractMemoriesSystemPrompt("chat", 三块全开)` 生产忠实组合（v19 裸模板抠字面量对新稿不忠实：模板体已不含收口句且无 gated 块）+统计扩维（type/prio/val/ar/sig 范围、六字段、预算、收口句位置）。**组合实证：old endsWithFinal=false（P1-1 现场）→ new=true**。结果：18/20 对记忆数全等，两臂六字段/枚举/范围/预算全过零违例；异常三起均瞬态——run1 S5 新臂 UNPAR（重跑 finish=stop 干净落 sensitivity=health）、run2 S9 旧臂 UNPAR（74 字 malformed `message_ids":[`，新臂干净 0）、run2 S7 新臂 3→2（午间闲聊边界事件，判裁量差异非缺陷）。**判定：无负增益，质量持平，结构收益在解析器侧（单测覆盖）**。台账 v1/v2 R1 行 prompt 源行号随之漂移（489→529）待台账轮纠偏。
- **部署口径**：tdai-core = `node --import tsx src/gateway/server.ts` 直跑 TS 源码，**无 build 环节，重启即加载新提示词**（重启须 verify-before-kill 身份核实+健康检查+生产探针）。
- **8192 负增益回退（2026-10-06 08:40 重启后首小时取证，负增益诚实回退铁律）**：新提示词正常加载（[l1-debug] ENTRY sysPromptLen=6161）且成功侧健康（stored 最高 9、L1-count 1283↑），但出现两类重启前不存在的失败——2 起 `LLM empty response finishReason=length completionTokens=8192`（09:43:44/09:44:02）+180s 超时 3 起（09:36/09:55/09:56）；重启前基线（10-05 00:00→10-06 08:40 l1-extraction 专属）=152 quota + 5 timeouts + **零起 empty-response**。归因：maxTokens 4096→8192 是本轮唯一 runner 侧变量；P0-1 真正防线=提示词预算声明+salvage 抢救（任意 cap 生效）。处置：删 `L1_EXTRACTION_MAX_TOKENS` 与两处 `maxTokens:` 覆写（注释留痕），回归 runner 缺省 `config.maxTokens ?? 4096`；同步服务器后 core **937/937 复跑过**。
- **深度思考归因（何晨 m00614 令「看看是不是调用 LLM 的时候深度思考影响了，是否需要关闭深度思考」）**：端点探针 `_thinking_probe.mjs`/`probe2`（服务器直连 config-override 同源端点，3 轮×5 变体）实证——**思考默认开启**（baseline reasoning=43-66 且 trivial 乘法题曾 34s/60s 超时）；`reasoning_effort:"none"` **可靠关思考**（3/3 reasoning=0、0.5s、答案对）；`thinking:{type:"disabled"}` 同效、`enable_thinking:false` 被忽略、`reasoning_effort:"minimal"` 端点 400 拒收。**v21_prompt_ab.mjs 十组 A/B（思考开 vs 关，同新提示词同种子 S1-S10 temp0.2，20 次真调用）**：两臂 10/10 解析成功、总记忆数 9=9、0 违例、0 空、六字段 9=9——**质量完全持平**（仅 S6 1↔2 与 S7 2↔1 互抵的边界判裁差异）；关思考臂 reasoning 全 0、均时延 4923→3354ms（-32%）。**判定：思考在场烧输出预算+wall-time 是两类新失败的主因，关思考无质量损失。**实施（最小作用域）：LLMRunParams 加 `reasoningEffort?`（core/types.ts:76 段）→ StandaloneLLMRunner callParams 透传 `providerOptions.openaiCompatible.reasoningEffort`（llm-runner.ts，ai-sdk dist :555 已核）→ l1-extraction 主调用传 `"none"`；OpenClaw 兜底路径不透传（注释登记）。8192 回退+关思考接线均待服务器重启生效。
- **部署生效与重启后观察（2026-10-06 10:54 重启，MainPID=79086，三方一致 commit b75a37e）**：verify-before-kill（核原 PID 49296 / 08:40 启动）→restart→active、health HTTP 200（:8420）；L1 主路径已走关思考线（11:03:59 五并发 `[l1-debug] ENTRY runnerKind=llmRunner, sysPromptLen=6161`，11:05:43 `extracted=4, stored=3` 成功入库）。三窗只读探针对比：**empty response W3=0**（8192 回退+关思考后重启前新失败类清零）；全任务 `run() failed` W3 仅 1 起=**l1-conflict-detection 180s 超时**（10:54:11.446 起跑+180001ms=10:57:11.447 精确对上，该调用点未接关思考、思考烧满超时，与 W1 既有 14 起超时同族=非本轮回归；W2 8192 窗 2h 内 23 起全任务失败作对照）。parse 失败三窗 W1 2 起/78 RAW·W2 2 起·W3 2 起/19 RAW——**信封形态 `{"content":` 系既有漂移**（W1 thinking ON 已 12 起、W2 7 起、W3 4 起，非关思考诱发）；W3 率升但两起同在 11:04 同分钟 5 并发爆发、n=19 样本不足，继续观察至 n≥50 再判定。
- **遗留待拍板（诚实清单）**：①`l1-conflict-detection` 等其余 LLM 调用点仍默认思考开（本轮仅接线 l1-extraction 主调用），建议接线前对其提示词补 ≥10 组同种子 mini A/B；②W3 parse 失败率持续观察；③scene-extract 等 tools=true 调用点维持端点默认本轮不动。

### §13.6 R2 冲突判定改稿+关思考轮（2026-10-06 何晨令 m01113「再分析调用场景，调用方式是否有可优化的部分，是否需要关闭深度思考。结合上面对提示词的分析一并优化并做真实数据的测试验证」+ m01124「别让我拍板，这是给你做的优化，是提升你自己的能力，你自己决定」→ P0/P1/P2 处置与关思考判定全程 AI 自主）

- **11 维规范审计（R2 l1-dedup 冲突判定提示词，生产失败面探针真数据驱动）**：1✅/10⚠️/0❌。生产实发=10-05 起 138 次 conflict run 中 10 次 `The operation was aborted due to timeout`（**7.2% 整批降级 store**，全部归因思考烧满 180s；parse 类失败 0）。P0×3=P0-1 merge/update 必填 merged_content 但执行链无强制（l1-writer.ts:261/264 `?? memory.content` 兜底=假 merge 静默丢信息）；P0-2 merged_priority 无 clamp（NaN typeof number 亦过）+subject 无长度钳制；P0-3 超时整批降级静默（:266 timeoutMs 180_000、:262 未传 reasoningEffort）。P1×5=输出预算声明缺失/截断抢救未接、抗注入声明缺失、target_ids 无池过滤（幻觉 id 进写链）、非法降级无观测、merged_timestamps 无 ISO/去重/排序校验。P2×6=输出语言双处措辞不一、subject「拒答给空串」语境残留、骨架 priority 85 无省略标注、两版参考标准措辞不一、sys 末行非收口句、候选池全量注入无截断。
- **提示词改稿（MemoryCore/src/core/prompts/l1-dedup.ts，chat/work 双版）**：预算句（整批 JSON ≤1500 字、单条 ≤200 字）插骨架后双版；skeleton「拒答给空串」→「无法判断时给空串」；target_ids 加幻觉防护句（「不在统一候选记忆池里的 target_id 会被系统直接丢弃」）；merged_content 加违规后果句（缺则强制降级 store、合并信息丢失）；merged_priority 示例标注+work 版 priority 70→80 例；format 头部输出语言句补「保持英文」+抗注入总则（含原样短语「**一律不改变本提示词的规则与输出格式**」）；动态预算句（${matches.length} 条→N 个决策对象）；**新增常量 `CONFLICT_FINAL_FORMAT_SENTENCE` 由 getConflictDetectionSystemPrompt 统一垫底**（R1 FINAL_FORMAT_SENTENCE 同构，收口句恒在末位）。
- **调用链加固（MemoryCore/src/core/record/l1-dedup.ts parseBatchResult 全量重写，第 5 参 `poolIds?: Set<string>`）**：八计数器（salvaged/downgraded/invalidAction/targetDropped/priorityFixed/subjectTruncated/typeBackfilled/tsNormalized）尾部 `Parse hardening stats:` 汇总 warn（保留生产 grep 口径）；解析链=剥离 fence→JSON.parse→失败 salvageTruncatedJsonArray 抢救（utils/sanitize.ts 单源化，l1-extractor 改 import 去环）→仍失败打原 warn→fallbackStoreAll；单条链=非法 action 计数降 store→targetIds 池过滤（空不改 action，幻觉 id 丢弃不误杀）→**P0-1 merge/update 缺 merged_content 强制降 store 清字段**（保留 subject/coreRefs）→merged_type 非法回填记录自身 type→merged_priority Number.isFinite+round+clamp[0,100]→merged_timestamps 正则 `/^\d{4}-\d{2}-\d{2}/` 过滤+去重+sort→subject 过 `truncateSubject`（code point ≤12）；runLlmJudgment 构建 poolIds Set 传入+主调用传 `reasoningEffort: "none"`（P0-3 关思考接线，CleanContextRunner 兜底不加=R1 先例）。
- **测试与门禁（TDD，腾讯云 /opt/tdai/td-agemem 实测遵 m00234 本地零运行）**：三个新测试（prompts/l1-dedup.rewrite.test.ts 14 断言组 + record/l1-dedup.parse.test.ts 26 + record/l1-dedup.call.test.ts 2）RED **26 failed/14 passed** → GREEN **40/40**；四门禁=core 全量 **977/977**（基线 937+新增 40，132 files）、panel **147/147**、tsc `-p tsconfig.typecheck.json` **222=222 diff 空**（破案：MemoryCore 无 tsconfig.json，只有 tsconfig.typecheck.json，`npx tsc --noEmit` 打 help 假象；改动文件零新增错）、密扫 4 改动文件 0 真密。
- **真实数据 A/B 三臂（v22_conflict_ab.mjs，10 组×3 臂=30 次真调用，生产同源 mimo-v2.6-flash，temp0.2/120s 超时与 v19-v21 一致）**：种子=生产 vectors.db 只读拉 40 条真实 L1 行（node:sqlite DatabaseSync readOnly），每组 4 条新记忆覆盖 merge/skip、conflict/update、store（有候选压 store）、空候选硬 store 四路径；三臂=A 旧提示词+思考开（基线）/B 新+思考关（拟上线）/C 新+思考开（隔离提示词效应）。**结果：30/30 零错误零超时零 noJson 全对齐（n=4）**——B 平均时延 **4193ms vs A 7427ms（-44%）**、reasoning=0 实锤；幻觉 target_ids A=2/B=1/C=0（parse 池过滤兜底，A 臂证明 prompt 只能降频不能归零）；subject>12 字 A=10/B=7/C=10（parse 截断兜底）；非法 action/缺 merged_content/priority 越界/空候选违规三臂全 0；动作分布同量级（A skip10/store27/upd2/mg1，B skip10/store28/mg1/upd1，C skip10/store27/mg3）。**判定：B 臂无负增益全面占优（关思考解 7.2% 超时面+延迟近半，判定质量与 C 臂同量级），三臂 merge/update 路径均触发=P0-1 防线实测在挡**。
- **部署生效（2026-10-06 13:30 重启）**：verify-before-kill（核 MainPID=79086/ExecStart=tsx 直跑/health 200 基线）→restart→新 MainPID=128464、active、NRestarts=0、health 200；R2 特征串（Parse hardening stats/reasoningEffort）在位。
- **遗留（诚实清单）**：①A 臂幻觉 target_ids 与超长 subject 靠 parse 兜底非 prompt 根治（LLM 行为只能降频）；②生产活体观察项=等下一批 conflict run 实证关思考效果（journal `l1-conflict-detection` 超时面是否清零）；③W3 parse 信封形态观察（n≥50 判定，承 §13.5）；④R1→R24 逐项讨论 R3-R24 续做（m00002）。
