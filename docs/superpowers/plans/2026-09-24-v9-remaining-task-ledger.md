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
| 任务 7 灵魂真伪判定 | 排队 | 依赖任务 2 执行收口 |
| 「登记≠真实」第 7 例候选 | 已登记 | 部署技能「无存量超限回归守卫」记载过时（quotaEvict 在场但被门饿死）；技能库只读待维护通道更新 |

**观察项首批量化（2026-09-25 16:10，v10 会话）**：①KV 抖动=人格指纹变更事件 **0 次/48h**（journalctl --grep「人格变更」实锚；重启清缓存窗口诚实披露）→ M1 moodLine 档位翻转频率 0<3 次/日阈值=不触发回退登记，M2 品格行翻转同判；②characterProposal 采纳=**0 事件/48h**（anchor-growth 全部 tick adopted=0；主桶品格锚 2 active 无变化）；③T1 命中=无张力检测日志/24h（无 self_identity 采纳事件驱动）；④QUOTA 守卫窗口未到（20:46 CST）持续跟踪。观察继续。

**拍板执行 ①（2026-09-25 18:09，V10-MAINT-DECOUPLE）**：何晨「全部按建议」整批授权。commit **335e212**（9 files +205/−60：anchor-growth 门布尔化+统一门/maintainIntervalHours 配置/types+sqlite lastMaintAt 新 kv 键/anchor-maint-decouple.test.ts 4 用例+既有 9 处断言随新语义更新）——RED 3 failed→GREEN 4/4·core vitest **830/830**（826+4）·tsc 222 持平·密扫 0。yaml maintainIntervalHours: 6 显式落盘+重启；**活体自愈 PASS**=重启首 tick 全租户 maint=run adoption=skip、retired=3 reweighted=3、主双桶 theme active **17/16→15/15** 名额精确回归（journal maint=run adoption=skip 实锚）。

**拍板执行 ②（2026-09-25 18:15，锚 description 数据面回填）**：备份先行（/tmp/core-values-backup-1790331315878.json 115 行）→ 范围=主 team 双桶 person×2（何晨/用户）+character×2（自驱/取证先行，授权口径；theme 新锚 NO_DESC 属「锚行 description 未来写入策略」gated 登记不越权）→ 手法=直接 SQL JSON 合并更新（取证定责：upsertValue 为 REPLACE 语义、attrs_json 仅由入参三键重建，直接调用会抹 character source/facts）→ 逐锚写读回 **3/4 OK**；自驱 SKIP=抽象品格词零字面证据（attrs.facts 空+L1 无字面命中）宁缺毋滥不手造语义。**活体 PASS**=注入行「何晨(同事·趋近)：…」「取证先行(趋近·w0.44)：用户要求且AI已承诺…」点亮+soulVersion sv-30ba28ed→sv-d3379c50（锚数据变化→指纹刷新=设计意图合法预期）。

**拍板执行 ③（2026-09-25 18:30，UI NO-GO 微项实施）**：G3（首要卡「首要 · {label}」合并主标题+描述 2 行 clamp 点击展开）/G4（弹卡 key 列 sticky left:0）/窄屏（<767px overflow-wrap=anywhere+feel-cols 单列，禁截断省略）/提案卡（_spending-row 并入分区卡语言 radius 8px）四项落地；G1 复查自纠关闭。门禁四件套=panel vitest **144/144**·web tsc **存量 2 持平**·build ✓+bundle 真实特征断言（注释标记被 minify 剥离→改真实属性特征配方）·panel 重启 active+HTTP 200；活体 DOM=tagGone/nameText「首要 · 审计」/descClamp=2/点击展开 aria-expanded=true/radius=8px；窄屏 375px 真机实测=实现期遗留复测步骤（内嵌浏览器视口限制，诚实登记）。

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
| 任务6 | D-R3-2：boot recovery 前过滤无 L0 数据会话键 | **DONE_WITH_CONCERNS**（2026-09-24）：hasL0Session 死键过滤落地，代码待下次重启生效 | 实锚：单 boot 156 re-arm 中 28 死键（flow-test/session-flowtest-*/ev5-live，readOnly 探针 151∩129→123/28）；3 用例·vitest 822/822·tsc 222 持平·密扫 0；**归因修正（登记≠真实第 6 例）**：锁风暴主因=旧 L2 任务无租户元数据共享单锁 `pipeline:{default:_:_}`（非死键驱动） | 重启验证待拍板；L2 锁元数据修复另立任务呈报 |
| 任务2 | 召回新信号 A/B（R-recall/R-identity/R-arousal） | TODO（设计要点已定：R-A 红线+单一源复用 computeMoodValence+基线=启用后状态；golden 重建+≥10 组 A/B 属数小时工程，2026-09-25 会话上下文边界诚实移交下轮执行） | golden 基建重建（docs/superpowers/evals/memory-recall-golden/ 桶已清空，复用技能 td-agemem-recall-golden-anchor）；F14-bis 与 R-identity 张力正面回答；与 M1 共享 valence 数据源（单一源：复用 mood-line.ts computeMoodValence，禁第二份实现）；**注意生产 moodLine 已启用=A/B 基线须以启用后状态为准** | 设计小节先呈拍板 |
| 任务7 | 灵魂真伪判定（量化判据） | TODO | 依赖任务 2 产出 | 任务 2 后 |
| L2-LOCK | L2 任务无元数据锁塌缩风暴（2026-09-25 新登记→当日定案） | **DONE_WITH_CONCERNS（无需代码修复）** | 机制已被历史迭代覆盖：getLockKey 三级元数据解析链（显式/data 兼容/sessionId profile 解析，instance 退化显式标注不推荐）实锚 v2-router.ts:700-715；风暴本体随重启结构性消灭——LocalStateBackend 任务/定时器纯内存态（local-backend.ts:27 timers=Map 实锚），重启即清且无持久重建通道 | journal 实锚：09-24 18:00→重启前 default:_:_ 冲突 34896 次（全天在烧）；重启后 0 复发；11:52 的 129 个 L1_drain 到期波 0 任务产生（游标治理空跑零成本实证）；当前可见冲突=同会话 L1 串行退避（session 级锁设计内行为） | 观测项：若再现 default:_:_ 塌缩=新 producer 缺元数据，立即归因；同会话 L1 退避日志噪音如需降噪另行微项 |

## 四、UI 尾巴与微项

| 编号 | 任务 | 状态 | 缺口 | 下一步 |
|---|---|---|---|---|
| UI-3.2 | rc=101 行 m_1789437830444_473d770a（agt-kfynybx0ly，L1=504）Panel 记忆块列表不可达 | NEEDS_CONTEXT | 平台资产层在仓外——需用户平台侧共享该 chat_memory 或批准 Panel 增「本 agent 记忆直读」入口 | 等用户动作/拍板，勿自行实施 |
| NO-GO v2 微项 | G1 68% svg 文本 3px 微溢出 / G3 感受条首要卡 tag 冗长 / G4 弹卡 key 列 sticky / 窄屏单行长描述换行控制 / 待裁决红线提案卡与分区卡风格统一 | TODO（P2/P3 可选） | NO-GO v2 无 P0/P1 | 可选穿插 |

## 五、gated 待拍板清单（全部维持不动，勿抢跑）

D-5 九通道关断维持 / R11 sensitivityPenalty 生产值 / 测试租户种子清理（11 桶 244 行）/ D2 预注册 A 启动 / neighborExpand 处置 / T7b Claude Code 场景实测 / P3 散项（maxPerPass 3→2、intervalHours 1→24 回切）/ audit #11/#16 / person 锚 description 数据面回填 / 方案② embedding 提案深清理 / 锚行 description 未来写入策略（存量已修）/ 感受段近期基调行生产租户启用（已拍板执行完毕 2026-09-24，注销）/ **M2 生产启用（2026-09-25 整句授权执行完毕+活体全绿，注销）/ P3 散项回切（2026-09-25 执行完毕，注销）/ D-R3-2 重启验证（2026-09-25 执行完毕 re-arm 156→129，注销）/ L2-LOCK 定案无需修复（2026-09-25 取证定案，注销）/ DUEL-LABEL「取证先行」双行裁决=维持（2026-09-25：(node_type,label) 复合去重设计内行为，theme=价值域与 character=品格语义不同，M2 活体已证不误伤，注销）**。其余维持项（D-5/R11/种子清理/D2/neighborExpand/T7b/audit#11#16/personDesc/方案②/锚行写入策略）经整句授权逐项复核后**裁决维持现状**——各项无新证据支持变更，种子清理与 personDesc 回填为数据面删除/写入，守「删除必拍板」安全边界维持 gated。

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
