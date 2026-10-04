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
- 拍板③M3-NARR/64 号维持勿提前（设计顺序即意图）
- 遗留：dim1 溯源率首轮未完成（curl -sfk 静默失败待修）；character 池 0 行=容量拍板无即时对比数据；yaml :181 注释 8 未同步


## 十一、2026-10-04 灵魂注入质量轮（何晨令：禁无意义/不明确内容/仅关键词无说明锚点注入）
- 活体缺陷实锚（本轮 soul 注入自查）：价值锚行三类违规=①裸关键词锚（拍板/收口/门禁/基线/台账/活体等 9+ 锚无 desc，96/130 NoDesc 数据面）②半句截断（「探针 HTTP 200、文档」「A-5 达 GRE、RED」）③w0.5 锚有完整 desc=合法（撤回定性）。
- 根因：渲染端 soul-assembler.ts:190-201 desc 空→descSeg=""渲染裸关键词；存储端 pending-adopt-merge.ts:45 coerceCoreValueAnchor `[...(descRaw||content)].slice(0,60)` 60 字硬切无句边界（半句入库存活+全量渲染）。
- 修复：①渲染端价值锚行+品格行 desc 门（空/空白锚整条跳过；尾悬空半句句边界清洗截最后句末标点。！？；全段无句末且尾悬空=按空；全部无 desc 行省略）②存储端 sanitizeDescription（60 字窗口含句末标点截到句末；超长截断且窗口无句末=半句实锤置空；尾悬空置空；完整短语保留）。
- TDD：RED 7 failed/12 passed（新语义全 failed+回归面全 passed）→GREEN 19/19；全量 vitest 892/892（887+5；波及 fixture 补 desc：soul-attr-inject 4 用例/soul-person 3 用例/character-maint 1/soul-assembler-character 1/anchor-semantics 2 改写）；typecheck 222 持平。
- 边界登记：感受段方向行（「驱动我行动的价值：label」清单）=设计内形态（§2.7）不动；person 行空 desc 回退=G-ANCHORDESC-WRITE 登记策略不动；存量 96/130 NoDesc 弱语义 desc 数据态回填=登记 gated 关联（渲染端已挡半句形态，弱语义短语=数据遗留）。
- 门禁：core vitest 892/892 · typecheck 222 全存量零新增 · 活体探针（重启后价值锚行新语义验证）见收口报告。
