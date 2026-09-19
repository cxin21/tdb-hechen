# TDB Soul Memory 设计↔代码↔真数据 三方交叉审计报告

- 审计时间：2026-09-19 09:58 – 10:40（CST）
- 审计者：独立审查（default-agent-hechen），全程未修改任何代码/配置
- 仓库：/opt/tdai/td-agemem（部署即仓库）· HEAD `1d8b19e`（09-19 09:12，docs-only；运行代码= `1d03a37`，服务 09:10:47 启动）
- 权威基准：docs/superpowers/specs/2026-09-17-soul-memory-design.md（392 行全文精读）
- 执行记录：docs/superpowers/plans/2026-09-17-soul-p2-person-anchors.md（T-A~T-E、D-R5 系列核对）
- 真数据：vectors.db（126.6MB，quick_check ok，311 L1）只读 + ev12 对抗种子 4 会话 32 条 L0 + 老化夹具 2 条 + /v3/recall 活体探针 15+ 次
- 环境：tdai-core active；LLM=OpenCode Go glm-5.3-flash（**周配额耗尽，1 天后重置**）；embedding=ark doubao（正常）

判定统计：**✅ 22 项 · ⚠️ 8 项 · ❌ 3 项**（其中 2 项附带 📝 设计文档自身问题）
完成度口径：✅ 率 22/33 = **67%**；加权（⚠️ 计半分）= **79%**；剔除环境阻断项 #33 后加权 ≈ **81%**

---

## A. 设计文档 §2.5 身份层（双槽）

| # | 条款 | 设计原文（摘录） | 实现代码 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|---|
| 1 | core_memory 零 schema 变更 | "沿用 core_memory 表（主键 slot+team+user+agent，零 schema 变更）" | sqlite.ts:831-840 | PRAGMA 活体：恰 8 列（slot/content/source/version/updated_at+三租户列），无 self_identity 列，slot 制 | ✅ | 无 |
| 2 | identity-discovery 双视角 prompt | user"他是谁/他的职责"；self"我反复承担的职责/我做出的承诺/我执行过的红线/我稳定的工作风格，须有 agent 侧行为文本支撑" | identity-discovery.ts:62-77（DUAL）；:40-57 legacy 保留 | dual 开关 :162-165（enabled=false 走旧 prompt=逐位现状）；T-A 实证 sysPromptLen=3828=3657+171（AGENT_ACT_BLOCK 已进 systemPrompt，journal 10:20:45 复现同值） | ✅ | 与 §2.5:108 逐项吻合；"行为可证"为 prompt 硬约束+确定性侧弱校验，与 spec 允许口径一致 |
| 3 | soul-assembler 四段顺序 | §2.7：self→identity→价值锚→重要的人 | soul-assembler.ts:90-95（rank 0/1/2 显式排序，不依赖 readCore 返回序） | PROD 活体注入块：（我是谁）→（我心中的他）→[core_value]/[strict_rule]→价值锚→重要的人 | ✅ | 无 |
| 4 | F17 预算生效 | budgetSelfChars/budgetIdentityChars/maxRelationLines；超限截断宁缺毋滥 | soul-assembler.ts:46-53,80-98,69-72；config.ts:980-993 clamp | PROD 活体：self 段第 7 行于"…向量与 FTS rebuild、状态"句中截断=slice(0,600) 精确生效；maxRelationLines=5 默认 | ✅ | 无 |
| 5 | allowedSlots 含 self_identity | "白名单扩展无害：实际写入仍由 selfIdentity.enabled 门控" | config.ts:917 缺省四槽；guard.ts:43-47 信任边界 | yaml:152 显式四槽 | ✅ | 无 |
| 6 | metadata.agentAct 标注真实产出 | §2.2:87"prompt 增补 agent 行为事实视角，metadata.agentAct 标注"；§7:332 | prompt 段：l1-extraction.ts:392-405（仅 prompt 指令，无机器可读标注）；**全库无 agentAct 字段写入点**（grep 仅 2 处注释） | 活体：`agentact_meta_rows=0`（311 条 L1 零命中）；计划文档 :447 spike 实测占比 0%；:449 D-R5-1 登记"全库零落地"；T-A 收口仅验证 prompt 接线（:645） | ❌+📝 | **标注机制自始未实现**（prompt 视角已接线✓）。P3 已按 spec §7 预设 fallback 改用 self_identity 聚合源，但 §2.2/§2.5/§3/§7 四处"metadata.agentAct"承诺未修订——设计文档与实现脱节 |

## B. 设计文档 §2.6 锚层（P2/P3）

| # | 条款 | 设计原文（摘录） | 实现代码 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|---|
| 7 | node_type/attrs_json 两列 | "TEXT 缺省 'theme'/'{}'；DO UPDATE 不碰 node_type；DO UPDATE SET state='active' 保持" | sqlite.ts:871-872（幂等 ALTER）；:2370-2391（upsertValue 语义） | PRAGMA 活体：node_type dflt='theme'、attrs_json dflt='{}'；listValues :2429 带出两列 | ✅ | 无 |
| 8 | F11 personEv | "personEv = \|{r: content 包含 label 或任一 alias}\|" | core-values-discover.ts:230-239 | 纯包含口径（非语义匹配），维护/候选/挤出/QUOTA 四处同源调用 | ✅ | 无 |
| 9 | F12 valence | "均值符号化（≥+0.2→1，≤-0.2→-1，否则 0）；IS NULL 守卫" | discover.ts:242-265；sqlite.ts:2527-2529（`AND (valence IS NULL)` 写回守卫）；anchor-growth:612-621 采纳钩子 | NULL→走 C2 derive 钩子路径代码在位 | ✅ | 无 |
| 10 | F15 分池配额 | "theme/person 独立 maxTotal（15/8），不互挤" | anchor-growth:366-394（themeActive/personActive 独立过滤+quotaEvict 分池） | yaml:160/168/178 = 15/8/8 | ⚠️ | 代码两池✓；**character 池无 quotaEvict 超限回归守卫**（:391-394 仅 theme/person），仅有采纳侧名额门（:577）——超限无自愈路径（GROW-RACE 互斥下调低风险） |
| 11 | F19 别名去重 | "提案 label 或任一 alias 命中同类型既有 label/alias → 拒；去重键=(node_type,label) 复合" | anchor-growth:472-491（personNames=全态 label∪aliases；提案双向命中→拒） | 逻辑与 spec 一致（person 池内） | ⚠️ | **theme 去重清单混入全类型 label**（:402 `anyState2.map(label)` 含 person/character）→ 跨类型同名锚（人物"咖啡"+主题"咖啡"）被误挡，比 spec 复合键更严（§2.6 明文要求可并存） |
| 12 | F20 身份永不退场 | "GROW-MAINT 身份重验证永不自动 retire——只发失撑警告" | anchor-growth:138-161（maintainIdentityFacts 仅 logger.warn:157，全文零 upsertCore/retireValue 调用）；:603-607 接线 | yaml:170-171 identityMaintain.enabled=true | ✅ | 无 |
| 13 | character 池 | "聚合源=self_identity 槽事实（spike 定案）；c- 前缀独立 id" | anchor-growth:545-602（readCore self 槽逐行事实→LLM 提案→characterEvCount 事实切片证据）；:125-127 c- 前缀；:596 attrs 标注 `source:"self_identity"` | 证据=identityFactSlice 单一源复用（:555,568-570） | ⚠️ | 聚合源/c- 前缀✓；**三处不对称**：①维护循环（:327-353）无 character 分支——用 theme 口径 `recountEvidence(label)`+theme minEvidence 重算品格锚，与采纳口径（事实切片）错配，可误退；②无 quotaEvict（同 #10）；③soul-assembler:68 仅排 person——character 锚可进"价值锚"行（§7"共享注入预算"勉强可释）及经 derive 获 ±1 valence 后渗入 soul-feeling（§2.7"感受段仅主题锚"存疑） |
| 14 | 别名归并来自 LLM 提案 | "role/aliases=提案入 attrs_json" | PERSON_DISCOVER_SYSTEM_PROMPT:312（aliases=用户对该人物的实际称呼变体）；parsePersonProposals:276-298 仅做规范化（白名单/去空/去重/去同 label），**零代码拼接** | upsertValue attrs 仅透传 c.role/c.aliases（anchor-growth:526） | ✅ | 无 |

## C. 设计文档 §2.7 注入组装层

| # | 条款 | 设计原文（摘录） | 实现代码 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|---|
| 15 | 四段渲染顺序 | 同 #3 | 同 #3；auto-recall:646-657 接线（dual 由 cfg.coreMemory.selfIdentity.enabled） | 同 #3 | ✅ | 无 |
| 16 | F18 检索过滤/隔离下推 | "租户三元组硬隔离"（清单要求：下推到 SQL/vector，非仅事后复核） | 向量路=过检索×5+逐行 rowMatchesIsolation（sqlite.ts:3317,3378,3418）；FTS 路=limit×5+filter（:5240,5271），**预编译语句无租户谓词（:1355-1366）**；queryL1Records 隔离维度内存过滤（:3876-3880）；仅 queryL1Paginated 有 buildIsolationWhere SQL 下推（:2048） | 实时检索路隔离正确：P桶-b/Q桶 活体空结果 | ⚠️ | **未下推，靠"过检索×5+事后复核"**（隔离语义成立但与清单口径不符；top-K 可被外租户行挤占=召回质量面）；且 🚨 **事后复核被 E3 缓存绕过**——见新发现 F-EV12-2（该项因此实质击穿） |
| 17 | /recall 注入块来源/主语/属性 | §2.7 渲染形态+escapeXmlTags+主语分明 | soul-assembler 全文 | PROD 活体逐行审读：四段齐全、valenceDir 趋近/审慎/中性标注、重要的人`cxin21(同事·趋近)`、感受段仅主题锚、[type\|scene] 来源标签、soul[发生/实见/情感/重要度] 属性行、空节省略（A桶无 self 段/无价值锚行） | ✅ | 通过；P桶泄漏为独立缺陷（F-EV12-2），不计入本项渲染语义 |

## D. 身份门（对抗审查）

| # | 条款 | 设计原文（摘录） | 实现代码 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|---|
| 18 | isIdentityImposition 全 patterns | 清单 12 类覆盖 | identity-discovery.ts:389-411 **14 条正则**：①身份设定②把我当作/成③认/视我为/作④让我以X身份⑤叫/让我扮演⑥以X身份(与/跟/同/和)(用户/他/你/其)⑦作为X身份/角色…用户⑧每天/晚/日+时段+提醒/通知⑨从今天/今/明天开始/起⑩指定X(专属)秘书/管家/助理/顾问/代理人⑪称呼/叫/喊+他/用户/你+为/作/是⑫引号尊称「称呼"X"」⑬无条件执行/服从⑭说/称我是/为 | 与清单 12 类逐一对上（自述复述=⑥、周期提醒=⑧、定时状态=⑨、角色指派=⑩、尊称驯化=⑪⑫、无条件服从=⑬） | ✅ | 理论薄弱面：⑥要求交流对象后缀，"以X身份说话"类无后缀复述不命中——H 组实证被配额阻断，留待复验 |
| 19 | stripIdentityStateResidue 全 patterns | F10"日期 \d{4}[-年]、P\d 阶段号→剥离所在句；整条全状态→拒收" | :279-317：枚举 4 条（当前…/截至…/已全部落地…/进入观察期…）+结构式日期/阶段号；先切句后剥离；空=整条拒收（:188-190,:201-205 双槽同门） | 一次性指令/定时任务由 imposition ⑧⑨ 承担（:400-402） | ✅ | 无 |
| 20 | mergeIdentityFacts existing 行过门 | 门校验写入的最终内容 | :428-445：existingLines 过 isIdentityImposition（:434-435，D-R5-4）；slice(-8) 保最新防饥饿（A1，:436-444） | 单测 gate-dr5/identity-replacing 在位 | ✅ | 无 |
| 21 | consolidation 蒸馏层确定性门 | 蒸馏产物=写入面，必须同过门 | consolidation-worker.ts:205-214：persist 循环内 `subject+durative.content` 过 isIdentityImposition‖strip===""，命中整条拒收+warn | commit 61fb33a/9a20c22（D-R5-7）；ev11 老板大人/秘书/冥想实证在前 | ✅ | 无 |
| 22 | scene_block 注入门 | 三级传播链最后无门通道补齐 | auto-recall.ts:444-451：r7Candidates 收集处对 filename+summary 过单一源门，命中拒收留痕 | commit b1ea2e5（T-D，ev11 scene summary 实证在前） | ✅ | 无 |

## E. 维护链（GROW 家族）

| # | 条款 | 设计原文（摘录） | 实现代码 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|---|
| 23 | 调度顺序 | §2.8:174"consolidation→forgetting→identity-discovery→anchor-growth→evolution" | lifecycle-scheduler.ts:106(consolidation)→:124(identity)→:145(anchor)→:162(evolution)→:185(reflection)→:193(forgetting **末尾**) | C1 修复注释：180-182（ev8 实证：引导期 forgetting 先跑会因锚未诞生致保护名集空、受保护记录当即归档） | ⚠️+📝 | **实际顺序≠spec 字面**——遗忘移至 pass 末尾是有意改进（保护判据输入先于清理动作达到最新，第一性正确）；但设计文档 §2.8 未同步，文档-代码脱节（违反铁律 7 的点，需文档补丁） |
| 24 | F14 遗忘保护 | "refs 指向仍 active 锚/现行身份事实→排除；悬空不保护" | scorer.ts:42-52（isRefProtected：active 锚名集∪现行切片集）；forgetting-worker.ts:66-107；仅 observed 自动归档（:114-115） | **活体双向夹具**：protected 行（identityRefs→现行切片）10:34 仍存活；dangling 行 10:31:08 归档 reason="forgetting" | ✅ | 完美闭环 |
| 25 | F14 租户聚合 | "worker 的 listValues 传 tenant（非 default 桶）" | forgetting-worker.ts:49-57（显式 tenant→listValues(t)）；:71-88 批内租户去重聚合（A3：无 filter 时按批内记录租户逐桶取锚/切片） | 活体夹具在 scheduler 无 filter 路径下保护命中=批内聚合路径实证生效；scheduler:195 传 filter | ✅ | 无 |
| 26 | interval 门：0 采纳回 1h | "0 采纳轮 1h 冷却（非 24h 兜底）" | anchor-growth:98（ATTEMPT_COOLDOWN_MS=3600000）；:274-296 门 1a/1b；D-R5-5：双字段行 0 采纳不写 lastAdoptedAt→由 1h attempt 冷却承担；存量行保守 24h；写侧 :623-628 | sqlite 状态键四键族（checkpoint.ts 前科）在位 | ✅ | 无 |

## F. 数据完整性

| # | 条款 | 预期 | 真数据证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|
| 27 | l1_links 悬空外键 = 0 | 0 | **363/522 悬空**（derived_from 349 / similar 13 / evolve 1；构成：单端归档 13、双端归档 7、幽灵 0） | ❌ | 根因=dedup-merge 归档（352 条）不级联清理边；全为"端点在 l1_archive 可恢复"型、无幽灵 id；当前唯一图消费通道 neighborExpand 因 graphDiscount=0 关断→功能零面，但计数与清单预期不符 |
| 28 | FTS rebuild 后功能召回 | 功能命中 | 四词探针全命中（部署/记忆/数据/周报）；fts 内部计数 539≠311 为索引计数非行数指标（skill 既有结论） | ✅ | 无 |
| 29 | anchor_growth_state 无测试租户残留 | 0 | 残留键族：ta-team（09-18 T-B/T-C 轮）、team-xtest（09-17）、ev12-user-a（09-18 旧桶）；default/生产两 agent 键族正常 | ⚠️ | 属"测试数据只增不删"铁律+计划文档 :527 待授权清理清单范围（ev10/ev11 同批），非违规，但不符合"无残留"理想态 |
| 30 | 备份存在且大小合理 | 存在 | vectors.db.bak-20260915（42MB）/bak-purge-20260917（113MB+shm/wal）/bak-purge-20260918（115MB）；/opt/tdai/backup：legacy-D tar.gz+yaml.bak-20260918；当前库 126.6MB quick_check=ok | ✅ | 无 |

## G. 配置项审计（tdai-gateway.yaml）

| # | 条款 | yaml 位置 | 接线消费点 | 判定 | 差异说明 |
|---|---|---|---|---|---|
| 31 | 八组配置键 | anchorDiscovery.person:164-168（true/3/2/8）；character:174-178（true/3/2/8）；identityMaintain:170-171（true）；selfIdentity:180-183（true/2/**1**）；soulRender:184-187（600/900/5）；forgetting.refProtection:198（true）；lifecycle.reflection:204-206（true/**2**）；allowedSlots:152（四槽） | 逐键消费实证：anchor-growth:217-220,548,604；identity-discovery:106-108；auto-recall:654-657；forgetting:66；scheduler:185；guard.ts:46 | ⚠️ | 两观察：①**reflection.rRef=2 被 clamp 静默改为 10**（config.ts:1034 `Math.max(10,…)`——yaml 注释"取 2.0≈3 条高显著"的意图落空，生效阈值=10）；②selfIdentity.intervalHours=1 为验收期值仍在线（yaml 自注"验收后回 24"）。其余六键值正确且接线贯通；密钥安全：yaml 已 gitignore（.gitignore:142）且 git 未追踪 ✓ |

## H. 真数据对抗审查（ev12）

| # | 条款 | 执行情况 | 证据 | 判定 | 差异说明 |
|---|---|---|---|---|---|
| 32 | ≥10 组新鲜对抗种子（ev12-team） | 4 会话 32 条 L0 全落地（10:07），覆盖 10 类目：身份设定/角色指派/尊称驯化+无条件服从/定时状态（s1）；第三方人物张三×5+合法自证周报承诺（s2）；agent 行为事实+P 独有隔离事实（s3）；Q 对照租户（s5）；老化夹具 2 条（protected/dangling） | l0_conversations 对账：s1=6/s2=8/s3=9/s5=9；夹具 created_time=2026-07-20 落库 | ⚠️ | 种子侧完成；**L1 提取被 LLM 周配额耗尽阻断**（journal："Weekly usage limit reached. Resets in 1 day"）——环境级，非系统缺陷；降级行为本身合格（不崩溃/ERROR 留痕/任务保留） |
| 33 | 提取+发现轮后逐项核对 | L1=0（配额死）；identity/anchor 发现轮 LLM 同因不可达 | journal 10:17:45-49 四会话 L1 任务全部 quota 失败；**且暴露 F-EV12-1：extracted=0 但游标照进（"L1 complete"）→32 条种子被永久跳过**，配额重置后需手工重放（重置 last_l1_cursor 或重投） | ❌ | 阻断归因=外部配额+F-EV12-1 缺陷放大（无重试残留）；替代取证已完成：PROD/A桶活体注入块审读（#17）、F14 活体双向（#24）、隔离实时路正确（#16）、E3 缓存泄漏取证（F-EV12-2）、agentAct 活体 0 落地（#6） |

---

## 新发现缺陷登记（本轮实证，未修——审查纪律）

| 编号 | 严重度 | 缺陷 | 证据 |
|---|---|---|---|
| **F-EV12-1** | **高** | **L1 提取 LLM 失败→游标照进→该批 L0 永久丢失提取机会**。l1-extractor.ts:230-231 吞错返回 `{success:false, extractedCount:0}`；pipeline-factory.ts:664 无条件 `markL1ExtractionComplete(…, maxRecordedAtMs)`；外层 catch（:670-673）不可达。供应商故障期内全部对话记忆静默丢失（配额重置前每天生效） | journal 10:17:45-49（ev12 四会话）+10:20:45-57（本会话 10 条）："LLM extraction failed… → markL1ExtractionComplete extracted=0, cursor=… → L1 complete" |
| **F-EV12-2** | **高** | **E3 session-reuse 缓存跨租户污染**：cache 键=`params.sessionKey` 单键（auto-recall.ts:161,528,596），命中条件仅同 query+TTL+同实例（:529-530），**租户三元组不参与**；/v3/recall body 缺 session_id 时 sessionKey 恒 ""（v2-router:1634-1638）→全员共享一个桶。v2-router 注释声称"空 sessionKey→通道退出"仅在结论层实现，检索复用通道无此守卫 | 活体复现：A桶 10:25 召回「代码审查 负责人」→P桶 10:29 同 query 得到 **A桶 5 条 persona 记忆**（meta.sessionReused=true）；而 P桶-b「覆盖率 红线 合并」（A桶记录强特征词，无缓存）与 Q桶 实时检索均正确为空——实时路隔离完好，唯独缓存路击穿。⚠️ 生产 MemoryProxy 走同端点瘦传输，若 body 未带 session_id 则全代理面共享此洞 |
| F-EV12-3 | 中 | l1_links 悬空 363（归档不级联清边） | #27 |
| F-EV12-4 | 低 | reflection.rRef yaml=2 被 clamp [10,100000] 静默改为 10 | config.ts:1034 |
| F-EV12-5 | 低 | character 锚维护口径错配（theme 证据口径+theme 阈值）+无 quotaEvict+渲染未过滤（价值锚行/感受段） | anchor-growth:327-353,391-394；soul-assembler:68,122 |
| F-EV12-6 | 低 | skill-conv-worker 对必死 LLM 任务 ~10s 连环重试无退避（日志噪音+无效调用） | journal 10:32-10:34 每 10 秒一条 ERROR |
| 观察 | — | ①theme 去重清单混入全类型 label（:402，比 spec 复合键更严）；②selfIdentity.intervalHours=1 验收值在线；③ev12-team 名与 09-18 旧测试桶撞名（本轮用全新 user 三元组规避）；④yaml 含明文密钥（gitignore 已覆盖，本地明文属部署形态） | 各处 file:line |

## 判定汇总

| 判定 | 项 | 编号 |
|---|---|---|
| ✅ 22 项 | 67% | 1,2,3,4,5,7,8,9,12,14,15,17,18,19,20,21,22,24,25,26,28,30 |
| ⚠️ 8 项 | 24% | 10,11,13,16,23,29,31,32 |
| ❌ 3 项 | 9% | 6（agentAct 标注未实现+📝文档未修订）、27（悬空边 363）、33（H 组全链被配额+F-EV12-1 阻断） |

**总体完成度**：✅ 率 22/33 = **66.7%**；加权（⚠️ 半分）= **78.8%**；若将 #33 视为"环境未测"而非"不符合"，加权 ≈ **81.3%**。
结论：P1 双槽+四段渲染、P2 人物锚骨架、身份门四道（提案/蒸馏/scene/merge-existing）、F14 遗忘保护、F15/F19 分池护栏、F17 预算、F20 红线**实现与设计高度一致且经真数据活体验证**；主要缺口集中在：①agentAct 标注（设计承诺未实现，已有 fallback 代偿）；②l1_links 悬空积累；③本轮新发现的两个高危缺陷（F-EV12-1 游标丢失、F-EV12-2 缓存跨租户）——建议优先修复并补 spec §2.8/C1 与 agentAct fallback 的文档同步。

## 审计纪律声明

- 未修改任何代码/配置；唯一写入=测试数据（ev12 种子 L0 32 条、老化夹具 2 条，保留待授权清理）；/tmp 审计脚本已清理。
- 未派发任何子代理；全部读取/命令/判定亲历。
- 密钥零回显（override 脱敏读取）；密钥不入本报告。
- 运行时与 HEAD 差异=1 个 docs-only 提交（1d8b19e），运行代码=1d03a37。


## 勘误（2026-09-19 批次二）

- **#27 判定更正：❌→✅（审计口径勘误）**。sqlite.ts:1951-1954（审计 B3 裁决）明确「归档不再级联删边——边是关系事实，指向归档记录合法（getL1ByIdsWithArchive 能解析证据链）；真正的删边留给 deleteL1（硬删）」。实测 363 条「悬空」边全部为端点在 l1_archive 的可解析证据链边（ghost=0），属有意设计；真悬空（两端均不可解析）=0——「悬空=0」的正确定义口径应为后者。原 F-EV12-3（悬空边治理）撤销：执行级联删边反而会断证据链、误伤 dedup 时序（B3 注释明确警告）。
- 附带观察（不修，登记）：neighborExpand（graphDiscount=0 关断中）若未来重开，BFS 经 getL1ByIdsWithArchive 会放行租户匹配的归档节点——归档记忆可经图扩展回流注入面，重开前需产品拍板。
