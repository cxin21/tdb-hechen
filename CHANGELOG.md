# Changelog

本文件记录 **TencentDB Agent Memory** 的显著变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/)。

覆盖仓库全部开源模块：`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。
---

## 📋 V10 会话（2026-09-25）：三大工作流深查收口+待拍板设计包

### Added（文档，零代码）

- **工作流 A 深查判定总表**（373251a）：19 列+metadata 8 项+锚层 9 列+core_memory 双槽+F1-F20 全量三步强制，13✅+1⚠️+2📝/0❌；唯一 ⚠️=GROW-QUOTA 回归守卫（anchor-growth.ts quotaEvict）被采纳 interval 门饿死——维护面与采纳面共用 24h 冷却，主租户 theme active 17/16 超 maxTotal=15 无自愈（journal 实锤），修复设计小节呈拍板。
- **工作流 B 灵魂组成重分析**（c07f75c）：四段×五维矩阵（内容/提取/拼接/主语/人物说明）对照母 spec 无组成级缺口；换用户/换 agent 双测试真实数据通过；person/character 锚 description 数据面休眠=gated 呈报。
- **任务 2 召回新信号设计小节**（1ff0211）：R-identity 裁定不实施（F14-bis 回音室张力正面回答）；R-recall/R-arousal 预注册 A/B（golden 桶重建先行+P@5 重锚定线+≥10 组同种子+负增益诚实回退）。
- **UI NO-GO v2 微项设计**（6e8bd51）：G1 健康环溢出复查自纠不可复现建议关闭；G3 首要卡信息层级降维/G4 弹卡 key 列 sticky/窄屏 <768 断点/提案卡并入分区卡体系，实施序与复测配方成文。

### Fixed（行为变更，2026-09-25 何晨拍板「全部按建议」）

- **GROW-QUOTA 守卫被采纳冷却饿死**（335e212）：`runAnchorGrowth` 四门改布尔化+统一门——维护面（证据重算+名额回归+品格张力 T2）按 `anchorDiscovery.maintainIntervalHours`（缺省 6h，clamp 0..168）独立调度并持久化 `lastMaintAt`（新 kv 键 `last_maint_at`，per-tenant 后缀同族）；采纳面四门节奏不变，纯维护轮保留采纳门状态。活体自愈=重启首 tick 主双桶 theme active 17/16→15/15（retired=3）。新增 `anchor-maint-decouple.test.ts` 4 用例（RED 3 failed→GREEN 4/4），core vitest **830/830**、tsc 222 持平。

- **锚 description 数据面回填（拍板执行②）**：主 team 双桶 person×2+character×2 按「top-1 支撑记忆首句≤60 字」确定性手法回填（备份先行+逐锚写读回 3/4；自驱零字面证据 SKIP=宁缺毋滥；直接 SQL JSON 合并——upsertValue 为 REPLACE 语义会抹 character source/facts，取证定责）。活体=「何晨(同事·趋近)：…」「取证先行(趋近·w0.44)：…」注入行点亮+soulVersion 刷新。

- **UI NO-GO 微项实施（拍板执行③）**：G3 首要卡「首要 · {label}」合并主标题+描述 2 行截断点击展开；G4 属性弹卡 key 列 sticky；窄屏 <767px 断点（overflow-wrap=anywhere 禁截断省略）；提案卡并入分区卡语言。panel vitest 144/144·web tsc 存量 2 持平·build ✓+bundle 断言·活体 DOM 断言+截图验收。

- **人物专卡 description 展示行（自检实锤缺口闭合）**：自检取证发现 PersonSection 对 description 零引用（注入行有/专卡无=三层缺口）。parsePersonAttrs+PersonRow 透传 description，专卡行内展示（2 行 clamp+title 全文，宁缺毋滥）。RED 1→GREEN 9/9，panel vitest **145/145**、web tsc 存量 2 持平、build+bundle 断言、活体主桶何晨/comfyui 用户双桶点亮。

- **V12-REPRO：红线提案比对域纳入 rejected（拍板执行④）**：对抗复查实证 rejected 同义复提 1 例（比对域不含 rejected）+精确复提被 pid WHERE 静默吞——比对域纳入 rejected（identity-discovery.ts，低相似仍放行=宁漏勿错杀）。RED 1→GREEN 11/11，core vitest **832/832**、tsc 222 持平。配套：pre-gate 存量语义重复簇去重（7 变体置 rejected，备份先行+变更清单落盘，strict_rule pending 117→110）；裁决工作单生成（139 条→135 组）交 Panel 批量裁决。

- **任务 2 召回新信号 A/B 收口（拍板授权执行）**：golden 桶重建（10 主题×事实化对话 75 条 L0→25 条 L1+3 条 reflection，隔离租户 team-2j92u63hre）+labels.jsonl v2（10 query×2-3 正例，产标零检索）+recall-anchor.mjs 加 TDAI_ANCHOR_ON_OVERRIDES env 注入（ON 相位开关覆盖，归档留痕）。三档锚定运行（基线/R8=0.03/R10=0.03）全 OFF determinism PASS、新基线 **P@5=0.917**（线 0.897）。判定：R8/R10 within-run ΔP@5=0.000、仅 1 query 组内位次互换无进出=**零增益证据，维持关断**（D-5 shadow 结论在新语料复现）；runs 三档归档+labels v2+脚本改动入库。

- **V12-ADJ：pending 采纳 strict_rule 合并语义（P0 缺陷修复）**：原整槽替换使 5 次采纳后槽仅剩最后一条、原 3 条红线被挤出注入（生产实锚）。修复=pending-adopt-merge.ts 纯函数（既有行全保留+采纳行追加+行体去重+'- ' 前缀规范化）+router 采纳分支接入（escape 保持 P-B 咽喉语义）。RED（模块缺失加载失败+旧语义断言红）→GREEN 4/4+pending-routes 集成断言更新；core vitest **836/836**、tsc 222 持平。

### Changed（文档勘误）

- 演化设计 §1.2/§5 勘误（d6c3adf）：M1 仅实现 valence 轴聚合（arousal 轴无消费方裁定不实现）；遗忘闪光灯调制 arousalRetention=0.3 已生产启用（原「仅 valence 轴有消费」表述过时）。

### Verified

- 全程零代码零行为零数据面变更；密扫 \bsk-[A-Za-z0-9] 词边界逐 commit 0 命中；活体证据=/v3/recall 探针×3（sv-30ba28ed）+node:sqlite readOnly 探针×8+生产 Panel DOM 实测。

---

## 🧬 V9-M2 灵魂演化层 S-CHAR-2 品格张力检测（2026-09-24，DS-SOUL-EVOLUTION-001 §2 配套）

### Added（MemoryCore）

- **M2 品格张力全链（P1-P6）**：
  - P1 store 只读接口 `anchorEvidenceValences?(tenant)`（IF-1 同族可选签名；l1_records metadata_json coreRefs/identityRefs 键族 × valence IS NOT NULL，node 侧 JSON.parse 按 label 展开；损坏行跳过宁缺毋滥；6 用例）。
  - P2 `character-tension.ts` 单一源纯函数：`detectEvidenceSplit`（T2 证据分裂：同锚 valence 正负各 ≥ minInstances，tensionRefs 带 recordId）/`detectEvolutionReversal`（T1 演化反向：极性词表确定性对照「不做X→做X」，零 LLM 零随机；13 用例）。
  - P3 接线+config：T2 挂点=GROW-MAINT 证据重算周期（anchor-growth）、T1 挂点=identity/self_identity 采纳 version++（identity-discovery）；张力候选只入内存注册表（record/drain，cap 50 一次性消费，O14 不落表）；config `memory.coreMemory.characterTension.{enabled=false, minInstances=2, maxCandidatesPerPass=2}`（clamp 同族；缺省关断=逐位现状）。
  - P4 identity-discovery 第三产出字段 `characterProposal`（IF-3 宽松读取：slot=character，旧输出无字段=逐位现状）+ 确定性门（tensionRefs 必须命中真实检测实例 ≥ minInstances + ev≥minEvidence（characterEvidenceCount 同刻度单一源）+ per-pass cap + (node_type,label) 全态去重 + F15 池配额不挤出；R-D 不新造门）；IF-4 钉死：characterProposal 不入 proposal-dedup 比对域（文档+守卫用例）；R-C 断言：品格提案采纳路径零 identityRefs 回填（11 用例）。
  - P5 渲染迁移（行为变更 A/B 主对象）：`opts.characterTensionEnabled` 渲染门（缺省关断=品格锚保持现状混渲染于价值锚行）；开启=价值锚行排除 character（与感受段 theme-only filter 对齐）+「我是谁」小节尾「我的品格：label(方向·w)：描述」（value_id 稳定排序）；soulVersion 不变（指纹=数据不含渲染门，node_type/attrs 本就在指纹内）；R-B 断言：品格锚 valence=±1 也不入感受段（4 用例）。
- **红线落实**：R-B（品格不入感受段）断言化；R-C 扩展（品格张力不产生 identityRefs——蒸馏物非事实）断言化；R-D（全部走既有 F19/F15 门族，不新造第二套门）。

### Verified

- 门禁：core vitest **819/819**（780+39）/ typecheck **222** 持平 / 密扫 \bsk-[A-Za-z0-9] 词边界 0 命中 / MemoryPanel 零改动（panel 144/144 基线不适用）。
- 配置缺省关断活体探针：parseConfig({}) → `characterTension {enabled:false, minInstances:2, maxCandidatesPerPass:2}`。
- A/B（同种子 10 组 × 三模式：旧版 51dda84 渲染 vs 新版 off vs 新版 on；临时 VectorStore，逐模式独立租户键防指纹缓存污染）：**旧版==新版 off 10/10 逐字节一致**（逐位现状）；指纹三模式一致 10/10（渲染门不入指纹）；品格迁移 8/8（价值锚行排除+「我的品格」行在场）；无品格锚组零噪声 2/2。
- 生产租户真实数据快照（readOnly，17 租户全量）：2 个品格锚租户（agt-kfynybx0ly：取证先行 0.37/复盘 0.33；agt-l5ugn6urg4：求精 0.33）开启渲染门后「我的品格」行全部在场、指纹不变、字节 3471→3476；**15 个无品格锚租户 off==on 逐字节零噪声**。数据面新发现：「取证先行」同 label 同时存在 theme（active）与 character（active）两行——(node_type,label) 复合去重设计内行为，启用后主题行合法保留、不误伤。

### Enabled（2026-09-25 生产启用，何晨整句授权自定最优）

- yaml `characterTension.enabled=true`（minInstances=2/maxCandidatesPerPass=2 显式落盘）；同批 P3 散项回切（anchorDiscovery.maxPerPass 3→2、selfIdentity.intervalHours 1→24，均登记在案的临时调参演示值回登记值）。
- 重启后服务 10s 健康、0 致命错误、yaml 零配置错误。**生产活体探针 M2_LIVE_PASS**：真实 /v3/recall（生产租户 agt-kfynybx0ly）注入块「我的品格：自驱(趋近·w0.33)、取证先行(趋近·w0.44)」在场且位于 soul-identity 段、与 DB active 品格锚（取证先行/自驱）逐 label 一致（GROW 池活体演化：复盘→自驱，品格自生长实证）、感受段无品格行（R-B 生产面）、近期基调行在场（M1 回归）、soulVersion sv-30ba28ed 格式稳定。
- D-R3-2 同批重启验证收口：boot recovery re-arm **156→129**（27 死键消除）、死键 0 出现于 armed 链路（预测 128，实测 129——1 键偏差在探针样本与活体计数口径差内，诚实登记）。
- 启用后观察项（已开始）：品格行翻转频率（KV 抖动）、T1 极性词表命中率、characterProposal 采纳率。

## ✨ V8-M1 灵魂演化层 S-FEEL-1 近期情绪基调行（2026-09-24，DS-SOUL-EVOLUTION-001 配套）

### Added（MemoryCore + MemoryPanel）

- **M1 近期基调行全链（S1-S10）**：
  - S1 store 只读接口 `recentAffectSignals?(tenant, {windowHours, maxSamples})`（IF-1 可选签名先例；l1_records valence IS NOT NULL + occurred_at ≥ 窗口 ISO 字典序 + 三元组硬隔离；sqlite 实现 + 5 用例）。
  - S2 `mood-line.ts` 单一源纯函数：`computeMoodValence`（半衰期加权 w=2^(-age/halfLife)，导出供任务 2 R10 复用、禁第二份实现）+ `computeMoodTier` 三档映射（±0.15 边界含；样本 <minSamples=null 降级；11 用例）。
  - S3 soul-assembler：soul-feeling 块尾「近期基调：档位（近 N 条经历的情感聚合）」（无方向锚时块仍可只含基调行，宁缺毋滥不造空段）；computeSoulVersion 可选第三参 moodTier（IF-2：undefined 指纹逐位一致；只入 tier 不入 sampleCount=三值化控 KV 抖动）+ 6 渲染守卫用例。
  - S4 auto-recall 接线：enabled=false 完全跳过（零行为差异）；config `memory.coreMemory.moodLine.{enabled=false, windowHours=72, maxSamples=20, minSamples=5, posThreshold=0.15, negThreshold=-0.15, halfLifeHours=48}`（clamp 防手滑）；outcome.mood 透传。
  - S5/S6 v2-router：/v3/recall meta.mood（条件展开，undefined 不出键）+ 新只读端点 `POST /v3/memory/mood`（V3_ALLOWED_SUBPATHS 登记；出参带真实 config 判定依据字段）。
  - S7 Panel：BFF `POST /chat-memory/mood`（values/list 同款 ACL）+ SoulFeelingBar 全宽副行（三态徽标 积极=绿/平稳=灰/承压=橙 + tooltip 判定依据=真实 config 值）+ i18n zh/en 5 键 + CSS 纯追加（MOOD-LINE-CSS-MARKER 守卫）。
- **红线 R-A 落实**：mood 不参与任何召回排序/加权（F14-bis 情绪版同构——情绪不得喂自身回路）。BFF 裁决=BFF 直连 core 新端点（不要求完整召回，mood 读取与 recall 解耦）。

### Verified

- 门禁：core vitest **780/780**（758+22）/ typecheck **222** 持平 / panel **144/144** / web tsc 存量 2 / vite build ✓ + bundle 断言（_soul-mood / 近期基调 在场）。
- A/B（同种子对照，隔离临时实例 8430 + DB VACUUM 副本 + 合成租户播种；生产 yaml 全程 enabled=false 零抢跑）：**13/13 通过**——合成租户字节对照 9 组（enabled 块剥 mood 行与 disabled 逐字节一致）+ 边界组（恰 0.15 同时间戳精确判定 positive）+ 降级组（<5 样本基调行省略）+ 生产租户 3 组（meta.mood 与 DB valence 半衰期加权手算一致，n=20）。临时实例与副本已清理。
- 生产 disabled 逐位现状：新旧代码同查询 /v3/recall 块 **3749=3749 byte_equal**、meta 无 mood 键；/v3/memory/mood → `{tier:null, enabled:false}`。
- M2 spike（并行收口）：T2 证据分裂 readOnly 实测 83 active 锚中 **18 个张力锚**（pos≥2∧neg≥2）+ 5 条人工候选抽验（负 valence 全部对应真实逆境事件，方向语义合理非噪声）——燃料 18 >> 止损线 2，S-CHAR-2 可立项（呈报拍板）。意外发现 character 锚 6 条真实在场（3 active/3 retired，origin=auto）——「品格池零数据休眠」登记与真实数据不符（登记≠真实新例，来源待查）。

### Pending（gated）

- 生产租户 moodLine enabled=true 属行为变更启用：A/B 已全过，**等拍板后改 yaml + UI 副行点亮活体验证**（「用户看不到=没做」的最终闭环步骤）。SoulPage 需登录态+选中资产，本轮浏览器活体未及（登记疑虑清单）。

## 🔧 V9-M2 修复线：D-R3-2 boot recovery 死任务键过滤（2026-09-24）

### Fixed（MemoryCore）

- **任务6 D-R3-2**：boot recovery 的 recoveryKeys（checkpoint runner_states ∪ L0 全会话键）新增死键过滤——新增 store 可选方法 `hasL0Session(sessionId)`（与 listL0SessionIds 同族语义，session_id 跨租户全局键；degraded/空串/异常 → false 宁缺毋滥），server.ts recovery 前剔除无 L0 数据的 runner_states 残留键，不再白挂 L1_drain 定时器；hasL0Session 缺实现的旧 store → 不过滤=现状语义。3 用例（存在性/与 listL0SessionIds 一致性/退化输入）。
- **活体实锚（2026-09-24）**：单次 boot re-arm **156 会话中 28 键无 L0 数据**（flow-test-20260915、session-flowtest-20260916-c..h、ev5-live-s1 等 09-15/16 测试残留，readOnly 探针 runner_states∩L0 实测 151∩129→123/28）。
- **机制级归因修正（登记≠真实第 6 例）**：锁风暴主因不是死键——journal 风暴样本 4 会话 L0 均有数据（23/186/387/148 行）；**主因=旧版产生的 L2 任务无租户元数据**（锁键全部塌缩到 `pipeline:{default:_:_}` 一把实例锁互相冲突退避，retry 100+ 与 `-lrN` requeue 链滞留）。死键过滤消除 boot 空跑面（28/151）；L2 任务租户元数据/锁粒度修复属行为变更另行立项呈报。

## 🛡️ V9 修复线：F-DUP-1 L0 入口幂等（任务5，2026-09-25，何晨整句授权自定最优）

### Fixed（MemoryCore）

- **入口幂等（第一层）**：store 新增可选方法 `hasRecentL0Duplicate(sessionKey, role, content, windowMs)`（session_key+role+message_text 逐字比对 + recorded_at 窗口；degraded/空参数/非法窗口 → false 宁缺毋滥不误跳）；`/v3/conversation/add` 消息循环内对 10min 窗口内重复提交跳过（feature-detect：store 缺实现=现状逐条照收）；响应契约不动（generated/types.ts 为 Kubb 生成禁手改），跳过以 journal info 留痕。
- **三问自定最优（设计小节结论）**：①窗口=10min（实测 DSH 单回合 12 连发跨约 5min → 窗口×2 余量；真实重发为小时级照存）；②键=session+role+content 逐字（role 维度隔离助手回声）；③边界=窗口内重复跳过+留痕、第二层 L1 提取归纳合并登记后续观察（存量重复行随 F14 衰减稀释；技能自钉「存量清理勿随代码顺手删」纪律，数据面清理维持 gated）。
- **4 用例 RED 先行**（窗口内命中/窗口外放行/维度隔离/退化输入）+ **生产活体 FDUP1_LIVE_PASS**：隔离租户连发实测 ①首条 accepted=1 ②同条重发 accepted=0 ③不同 content accepted=1 ④DB 恰 2 行无重复；且上线即时在生产会话拦截真实重复提交（journal「你自己拍板吧…」×2 duplicate skipped——DSH 每轮重提交污染面当场止血）。

## 🎨 V7-UI 批次三：信息完整性专项 + 按钮语义归一 + 属性/相关记忆弹出卡（2026-09-23/24）

### Fixed（MemoryPanel/web）

- **UI 三连整改补记（v6 会话 2aa481f/89eda93/12c8e46，此前未入账）**：ChatMemory 移除价值锚 tab（锚唯一入口=/soul）/ soul 锚行整宽 / 属性表可读性（key 170px/行距 1.55/圆角 8）。
- **信息完整性专项（b327e00）**：① _va-row 补 flex-wrap:wrap，批次二注入形态预览独占第二行，_va-label 截断 15→0（根因=预览 flexBasis:100% 与 nowrap 容器同行挤占）；② 实例卡 id/_alp-item-id 省略号改 overflow-wrap:anywhere 全文可读；③ _memory-detail-atomic-title flex:1(basis 0) 缩到 0 宽不可见→不缩+头行 wrap，30 行活体 title 30/30 可见·截断 0·硬溢出 0。

### Changed（MemoryPanel/web）

- **按钮语义归一（8452250，NO-GO N1-N4）**：N1 双主蓝归一 #1677FF→#0052D9（tea primary 单一语义蓝）；N2 soul 导航 pill 补选中态（--active 双通道+aria-current）；N3 禁用主钮灰字浅底替换 tea 缺省白字浅蓝底（对比度 1.6:1→达标）；N4 disclosure 补 aria-expanded。N5 退休区图标经活体取证为误报撤销（第三例登记≠真实）；N6（tab 切换丢选中）N7（两页文本钮色差）诚实缓议。

### Refactored（MemoryPanel/web）

- **属性/相关记忆改弹出卡（bb5ccf5，拍板「不行就改成弹出卡片」）**：取证展开态 _attr-table 被塞 head 行内 349px 窄列（键值换行错乱、布局失衡）→ AttributesSection/RelatedSection 内联展开改 tea Modal size=l 全宽弹卡（750-800px，零新依赖）；chip 留作触发器+aria-haspopup=dialog；记忆行头不再被展开内容撑爆（行高恒 122px），密度问题同步缓解。

- **F-U2 并列 weight 首要选取两端序统一（UI-3.5）**：Panel pickPrimeAnchor 补 value_id 次级键（原输入=listValues weight DESC 序，并列时可能与注入端异根）；内核 topDescSeg 显式化同键（原承载于输入序的隐式行为，无行为变化）。生产活体：0.80 并列 ×7 真实重 tie 下首要=文档(pos)/审计(neg)，双调用字节幂等；RED（得乙 expect 甲）→ GREEN 756/756+142/142，tsc 222 持平。
- **感受段方案A：主副结构+句边界描述（用户整句授权「自选最优方案」）**：概念审计坐实两处偏离（①首要 description=30 字硬截残句「…一律」；②长尾清单无程度感）→ 内核 topDescSeg 与 Panel firstSentenceDesc 同构改首句完整呈现（句边界截取，预算 80；无完整句或首句超预算则省略=宁缺毋滥）；SoulFeelingBar 改两行主副：首要卡主位（方向色条+锚名+w+完整首句）+长尾 pills weight 降序（程度梯度）cap3+抽屉带 aria-expanded；A/B 真数据 14/14 全部改善（30 字残句→55-60 字完整句）、非首要部分渲染逐字节不变；登记：锚行 description 残句根因=v2-router 写入时 80 字硬截（数据面，另行呈报）；门禁 core 758/758·panel 144/144·tsc 222/2 持平·build ✓
- **N6 tab 切换丢选中 + NO-GO v2 收口（UI-3.6）**：ChatMemoryPage 记忆视图常挂载+display 隐藏（条件渲染卸载丢选中实例；零新依赖，无组件测试基建故以活体 DOM 双向断言验收）；当前态重生审查：Soul 页 0/0/0·Memory L1 30 行·L0 干净，NO-GO v2 无 P0/P1（G1 68% 微溢出/G2 文本钮两页灰度=语义角色差异保留/G3 tag 冗长登记不改/G4 弹卡 sticky 可选）；锚行 description 残句根因勘正（v2-router 系 400 拒绝守卫非截断器，真因=存量数据生成时 60 字切片产物）→ 5 条括号失衡残句确定性修剪（备份 core_values_desc_fix-20260924.json+读回 5/5，排查过狠自纠）
- **感受段 v2 布局返工（用户令「布局太难看，都挤到一起」）**：从 44px 状态条升维为分区卡（与三池锚面板同卡片语言）：两列网格（驱动 3fr/审慎 2fr，单列占满）+首要卡两行主副（结构行 tag+锚名+w / 描述独立行）+长尾 pills 每列 weight 降序 cap5 流式+per-col +n/收起抽屉；活体：default agent 满数据（19 锚）展开态 15 pills 0 溢出·无描述实例首要卡省略正确；vision 验收 5/5（两列卡片边框/分层清晰/流式不挤/间距正常/整体优）
- 门禁：三批 panel vitest 140/140 · web tsc 存量 2 持平 · vite build ✓+bundle 断言 · 双页活体 DOM 断言+截图验收。


---
## 🖥️ V6-批次二 UI：注入徽章组 + 锚行注入形态预览 + 感受段首要段（用户拍板「做」，2026-09-23）

### Added（MemoryPanel/web，零后端新增）

- **注入徽章组（记忆页 BlockDetail L1 行）**：`attribute-badges.ts` 纯函数 deriveAttributeBadges（阈值与内核 formatMemoryLine 一致：arousal≥0.7/recallCount≥3/identityRefs 非空/evolution 存在/valid_start）+ `attribute-badges.tsx` 五徽章渲染（核心事实紫/验证×N 蓝/强烈橙/已演化绿/自 date 起灰，颜色+图标+文字三通道；tooltip 只读判定依据；零命中不渲染）。
- **锚行注入形态预览（ValueAnchorsPanel）**：display 态行下 `注入形态 label(方向·w0.8)：描述`（anchorInjectPreview 与 soul-assembler 逐字同构）+ description 展示行（>80 字截断 hover 全文）；无 description/weight≤0 宁缺毋滥。
- **感受段首要段（SoulPage SoulFeelingBar）**：pos/neg 组尾「；首要 X：描述≤30字」（pickPrimeAnchor 按 weight 最高选取与渲染序解耦；调用侧按 valence 分组过滤——首轮 bug neg 组错取 pos 首要，已修）。
- **W3C disclosure 补齐**：AttributesSection 触发钮 aria-expanded/aria-controls + 表格 id（此前缺失）。
- i18n zh-CN/en-US 八键（{{n}}/{{date}}/{{label}}/{{desc}}/{{preview}} 插值）。
- 门禁：面板 vitest **140/140**（129+11，新增 attribute-badges 纯函数单测）· web tsc 存量 2 持平 · vite build ✓ + bundle 内容断言（核心事实/注入形态）· tdai-panel 重启 200 · 双页活体截图+DOM 断言（徽章 11 枚/预览 21 条/首要段 pos=根因 neg=审计）。
- **登记两项（不粉饰）**：F-U1 列表路出参 metadata 不齐（recall_count/identityRefs 部分行缺）→ 验证×N/核心事实徽章在多数列表行不显示，待 BFF 透传补齐；F-U2 并列 weight 时首要选取两端数组序不同（Panel=weight DESC 序 vs 注入=value_id 序）可能不同根——低优先展示一致性。
---
## 🗃️ V6-数据面：P0 提案存量清理 + sensitivity 存量修复（用户整句授权「你自己拍板吧」，2026-09-23）

### Changed（生产数据面，零代码）

- **拍板依据**：用户整句授权「你自己拍板吧，找最优方案落地…同时清理一下之前的错误数据和提案」——AI 自主拍板记录在案（09-22 gated 整句授权同款先例）。
- **P0 提案存量清理（104→67）**：方案①=bigram th=0.5 同 slot 确定性并簇、每簇保留 created_at 最早、其余 decide rejected（不删行、可审计）。备份先行：core_pending 全表 170 行 + l1 3 行 → /data/tdai-memory/backups/。结果：67 簇 / reject 37 / 最大簇 13 条（网关不重启簇）收敛；残留 th=0.5 dup 对=0。0.5-0.75 区间深度改写保留（宁漏勿错杀——与 P1 闸门同哲学），方案②（embedding 语义级，预期 ~15 簇）登记待后续评估。
- **sensitivity 存量修复（3 行）**：'undefined'→'none'（ev17-agent×2 + 生产×1，与移交台账口径一致）；normalizeSensitivity 代码单一源已堵新增（D-3），修复后值域全合法（none 853/finance 5/health 4/relationship 2）。
- **自测（用户令「严谨一点」）**：soulVersion 双调用幂等 PASS（sv-355b893e×2）· 锚行 w 段/首要段/核心事实徽章活体在场 · /v3/atomic/search 出参 24 字段全量实锚（sensitivity=finance 正确返回——F-R12b 已由出参补 7 字段批收口，登记项结案）· 门禁复跑 vitest 755/755（100 文件）+ tsc 222 持平。

## 🔁 V6-任务8：红线提案语义去重（P1 入队闸门 + P2 生成层上下文注入）（用户令提前开工，2026-09-23）

### Added（MemoryCore）

- **P1 提案语义去重闸门**：identity-discovery core_value/strict_rule 入队前经 `findDuplicateProposal`（新模块 proposal-dedup.ts 单一源：字符 bigram Jaccard，零依赖零 LLM 纯函数）比对 pending∪已采纳红线 slot，同 slot 相似度 ≥0.75 → 跳过留痕不计数。阈值生产全行标定（102 条实测：网关簇 pairwise 0.790 真重复命中；同簇 0.692 改写幅度大的同族规则不并——宁漏勿错杀，漏放由 Panel 人工兜底）。store 层精确守卫（同 slot+content，sqlite.ts:2755）保持不变——两层互补。
- **P2 生成层上下文注入**：buildIdentityPrompt 增可选第三参 pendingList（30 条×60 字预算），prompt 增「已有待拍板提案（语义相近者不要再提——换措辞重复是噪声，不是新发现）」段；feature-detect 无 listPendingCore 的 store 逐位现状（向后兼容守卫）。
- 根因实锚：生产 102 条 pending 重复全部为换措辞语义重复（最大簇 9-15 条），精确匹配守卫无法拦截。**P0 存量清理（102→N 批量拒绝）属生产数据面变更，逐项呈报拍板后执行（双方案：bigram 0.5→102→65 保守 / embedding 语义级→预期 ~15），未拍板不动。**
- 门禁：RED 3 failed（闸门×2+prompt×1）/6 守卫 passed → GREEN；core vitest **755/755**（+9）· tsc **222 精确持平** · 文档同步=本节+spec V6-任务8 注记。

## 🧬 V6-1a/1b/1d/1e：属性信号徽章 + 锚行 weight 显示 + 感受段方案B + 人物锚行描述（用户授权「严格自审通过即开工」，2026-09-23）

### Added（MemoryCore）

- **注入行属性信号徽章（V6-1a）**：formatMemoryLine soul[] 在「敏感:/周期:」之后按固定序追加 `·强烈`（arousal≥0.7）/`·验证×N`（recallCount≥3，N=实际次数）/`·核心事实`（identityRefs 非空）/`·已演化`（evolution 存在）/`·自 date 起`（valid_start，日期精度与「发生」同 slice(0,10)）——全部宁缺毋滥、字段缺省输出逐字节不变；MEMORY_LINE_RE 行首结构不破坏（守卫用例）。生产基数实证（只读探针 838 行 L1）：验证×225 行/核心事实 141 行/自 date 起 208 行/强烈 10 行/已演化 0 行（休眠保留）。
- **三构造点透传成对补齐（丢值点防线）**：vectorResultToFormatable / ftsResultToFormatable（metadata_json recall_count/identityRefs/evolution + 顶层 arousal/valid_start）+ recordToFormatable（metadata 对象，sigMeta 局部宽松读取）+ kwSoul 条件并回扩展（arousal/valid_start，F-R12 防抹值同款）+ 分层候选池 soul 源补 arousal + RankSignalItem 扩 arousal。每点测试断言字段在场（D-3 丢值点④⑥同族纪律）。
- **锚行 weight 显示（V6-1b）**：价值锚行 `label(方向·w0.9)：描述`（weightLabel 两位小数去尾零；仅展示信念强度，渲染序仍 value_id 稳定=立项②不变；weight≤0 视为未测量不展示）。存量快照断言 3 处合法波及更新（soul-person 1 + anchor-semantics 2，非回归）。
- **感受段语义增强·方案B（V6-1d，与立项②冲突裁决=方案B）**：渲染序保持 value_id 稳定；「首要」锚按 weight 最高选取（选取与排序解耦）附 description ≤30 字；首要锚无 description 不回退次锚（宁缺毋滥）。
- **人物锚行描述（V6-1e）**：`label(role·方向)：description`（attrsOf 统一解析替代 personAttrs 并删除冗余函数；当前生产 person 锚无 description=描述段休眠；数据面回填另行拍板）。subject/source 不入注入徽章（subject 与 type 标签语义重叠且「反思结论」占多数、source 仅 extraction/空两态无判别信号）——出参/Panel 层已体现，诚实登记。
- 门禁：RED 18 failed/9 守卫 passed → GREEN；core vitest **746/746**（99 文件，+27）· tsc **222 精确持平**（+6 即修：recordToFormatable meta 窄类型 → sigMeta 局部宽松读取）· 文档同步=本节+spec §2.7 V6 注记。

## 🧠 立项补丁：锚语义持久化（rationale）+ 锚行排序稳定化 + soulVersion 人格指纹（用户拍板「立项，直接做了吧，记得测试」，2026-09-23）

### Added（MemoryCore + MemoryPanel/web）

- **锚语义通道（rationale 持久化，三闸全通）**：①存储=upsertValue attrs 增 `description`（attrs_json 序列化并入，role/aliases 保留）+ `IMemoryStore` 接口签名同步；②网关=v2-router attrs 守卫与构造补 description（≤80 字、P-B 咽喉消毒 escape 同款；错误文案升级为 `attrs requires role or aliases or description`——首版部署后活体探针抓到旧守卫拒收 400，第二闸定位修复）；③注入=soul-assembler 锚行升级 `label(方向)：描述`（attrsOf 安全解析，损坏 attrs_json → 不渲染宁缺毋滥；描述过 escapeXmlTags 同咽喉原则）。来源=提案制 ValueProposal.rationale——此前采纳即丢（全库 grep 实锚）。RED：store 面测试（description+role+aliases 全量保留/仅 description/不传逐位现状三例）。
- **锚行排序稳定化（KV cache 前缀连续性）**：listValues=ORDER BY weight DESC → weight 漂移会让注入前缀抖动；修=价值锚行/感受段驱动+审慎清单/人物锚行（weight DESC 取 top-N 后）**渲染序统一按 value_id 稳定排序**（weight 只管取舍与上限）。TDD：RED 双锚错位权重→value_id 序断言。
- **soulVersion 人格指纹（出参透传）**：`computeSoulVersion(双槽∪锚集合)` fnv-1a 32bit 稳定哈希（零依赖）；buildSoulPrefix 增可选 `metaOut`（不破坏既有调用面）；/v3/recall 响应 meta 透传 `soulVersion`。消费端语义：未变化=复用上轮 soul 字节（KV cache 满命中），变化=立即重注入（人格不冻结）。活体：sv-8d42f498 两次幂等 → description upsert 后 sv-9c9895ec（指纹随锚数据变化）。
- 门禁：core vitest **710/710**（95 文件，+12：锚语义 3+排序 3+指纹 3+存储 attrs 3）· tsc **222 精确持平**（归因修：soulVersion 作用域误置块内→提升至函数级与 outcome 四变量同位）· 面板 vitest 129 · web tsc 存量 2 持平 · vite build ✓ · 双重启 health 200（MainPID=3484203 登记）· 密钥扫描 0。事故登记：①新增测试自身笔误 4 处（escapeXmlTags 名单实锚 core_memory/system 两 tag/label 断言错字）——取证修正；②full-suite 首跑 13 项失败=陈旧转换缓存假象（复跑自愈，与 D-4 批同款）；③重启批误用 tdai 身份内嵌 sudo→router 补丁未加载（400 旧错误消息暴露）→ubuntu 身份重启复测。
- **遗留说明**：现有锚（auto-growth 产出）无 description——注入行对存量锚逐位现状；语义随新提案采纳/手工编辑逐步累积。DSH 插件消费端复用 soulVersion 的接线属插件面（仓库外），已登记为集成观察项。

---
## 🔁 D-4：recurrence 周期性事实结构化实施（用户拍板「自己选最优方案·配置全开·实现完整」，2026-09-22）

### Added（MemoryCore + MemoryPanel/web）

- **确定性门单一源**：`normalizeRecurrence`（l1-extractor.ts 导出，normalizeSensitivity 同族）——cadence 六枚举（weekly/biweekly/daily/monthly/quarterly/yearly）+anchor 形状门（weekly/biweekly→三字母星期必填；monthly→月内日可选；quarterly/yearly→MM-DD 可选；daily→无锚）+note 可省略（>20 字整体拒绝）；`isRecurrenceMeta`（形状重验守卫）+`recurrenceLabel`（note 首选，缺省 cadence+anchor 中文映射）。TDD：`src/core/record/__tests__/recurrence.test.ts`（RED 19 failed→GREEN）。
- **提取块（LLM 只提议）**：`RECURRENCE_BLOCK` prompt 运行时追加（l1-extraction.ts，AGENT_ACT/SENSITIVITY_BLOCK 同先例），开关 `memory.extraction.recurrenceEnabled` 缺省 false=逐位现状——落点=**既有 memory.extraction 组（ExtractionConfig）**（首版误开新子树撞 TS2300 duplicate，落点勘误已改并入）。直调取证：prompt 组装 4617 字符含块 ✓。
- **落库**：主映射 metadata.recurrence=normalizeRecurrence(mem.recurrence)（丢值点 #3 writeMemory 构造位；零 schema 变更，metadata_json 子结构）。
- **遗忘保护（拍板 2=true 生产启用）**：forgetting-worker 候选扫描 normalize 形状重验后 continue（防提取侧绕过）；`memory.lifecycle.forgetting.recurrenceProtection` 缺省 false；生产 yaml 已置 true。
- **三层体现**：①注入行徽章 `周期:…`（formatMemoryLine，与 D-3 敏感徽章同位；note 首选/中文映射 WED→每周三）；双通道 formatable 透传成对补齐（vectorResultToFormatable/ftsResultToFormatable 导出供测+metadata_json.recurrence 提取——D-3 丢值点④⑥同族）；分层候选池 soul 源+kwSoul spread+工具路 summary 行（丢值点⑤⑦同位）。②atomic/query 出参 metadata 既有单一源透传（探针核验无需改）。③UI AttributesSection「周期」键值行（recurrenceText 与内核同语义）。
- **生产 yaml**：`memory.extraction.recurrenceEnabled: true` + `lifecycle.forgetting.recurrenceProtection: true` 双重启生效（MainPID=3223911 登记）。
- **ev19 真数据（阶段性）**：全新租户 team-ev19 播 11 组（10 周期事实+1 阴性）→ 提取 11 行 1:1 落库（valid_start 全对齐、阴性双行零过标）→ DB 只读：**1 行落 metadata.recurrence（biweekly）**——提取层 LLM 提议方差（其余 9 行周期语义未落结构化），prompt 组装/门/写入链经直调+落库实锚完好；**登记观察项=ev19 复验发射率与 prompt 位置调优**（A/B 直打曾 10/10，生产链路发射率待复测）。
- 门禁：core vitest **698/698**（+21：门 10+徽章 7+遗忘钩子 2+其余）· tsc **222 精确持平**（stash 对照法：新错误 6 处归因修复——extraction 落点重复/`RankSignalItem` 补 recurrence 字段）· 面板 vitest 129 · web tsc 存量 2 持平 · vite build ✓ · 双重启 health 200 · 密钥扫描 0。事故登记：①D-3 丢值点排查清单 7 处全查（落点勘误=extraction 组并入既有）；②测试自身口径错 4 处（99-99 按 MM-DD 正则本合法/weekly 无锚断言反/两处期望笔误）+实现 WEEKDAY_ZH 全称致「每周周三」——双侧修正后 GREEN；③README 级自查：脚本中文两次被 ASCII 编码毁（固化 UTF-8 无 BOM 手势）。

---
## 🧬 F-T4-1：L1 列表路属性表 D-0 七列/归属五列/sensitivity 丢值修复（任务4 全量展示验收发现，2026-09-22）

### Fixed（MemoryPanel/web）

- **发现链（用户看不到=没做红线命中）**：任务4 活体复核中，L1 列表路展开 `🧬 属性 (10)` 仅现 10 个基础键——**scene_name/priority/session×2/timestamp×3（D-0 七列）+ task_id/team_id/user_id/agent_id/version + sensitivity（D-3）全缺**；逐环取证：DB 实值全在场（`l1_records` 行 scene_name=生产场景名/priority=88/session×2/timestamp×3/task_id/version=2）→ 内核 `/v3/atomic/query` 直探七字段实值在场 → BFF `/chat-memory/layer` 出参透传全在场（页面 fetch 实锚 firstKeys 29 项）→ **丢值环=`mapLayerItem`**（memory-utils.ts 只透传 13 字段，列表路 `res.items.map(mapLayerItem)` 把其余列全部丢弃）。D-0 轮验收走的是 atomic/query 详情与搜索路（`ChatMemorySearchHit` 直传不经此映射），列表路漏列至今未被发现。
- **修复**：`mapLayerItem` 抽单一源 `utils/map-layer-item.ts`（纯函数、零运行时 import 仅 type——可被根 vitest node 环境直测），透传列补齐（D-0 七列+task/team/user/agent/version+sensitivity），缺失字段 undefined 保持（宁缺毋滥）；`memory-utils.ts` 原地 re-export 保持既有 import 面不变。
- **TDD**：`tests/memory-utils-maplayer.test.ts` RED 1 failed/1 passed（透传断言 failed 钉住缺口）→ 修复后 GREEN 2/2；vitest **129**/129（+2）。
- **测试基建（随批）**：根 `vitest.config.ts` 增 `@` → `web/src` 别名（web 源码 `@/` 在根 vitest 默认不解析；仅测试解析用，web 自身 tsconfig 别名不动）；`memory-utils.ts` 清理抽取后残留的未用类型 import（web tsc 3→**存量 2 持平**）。
- **活体验证**：搜索路 AttributesSection 属性表 DOM 断言 19 键在场（`scene_name`=生产场景名/priority/team×3/version/occurred_at/certainty/source/valence/arousal/significance/created_at/updated_at/recall_count/last_recalled_at/subject/id/type）——D-0 列实值渲染能力确证；列表路=纯函数测试+re-export 链（Browser 驱动 agent 下拉在本会话反复失败未能现场展开列表路属性表，登记为验收遗留观察项，代码+测试证据完整）。
- 门禁：面板 vitest **129/129** · web tsc 存量 2 持平 · vite build ✓ · tdai-panel 重启 200 · 密钥扫描 0。事故登记：vitest 别名解析/导入链（memory-utils→teamApi→i18n 不可 node 载入）→拆纯函数解决；脚本中文又两次被 ASCII 编码毁（py heredoc/测试文件正则替换）→**固化为 UTF-8 无 BOM 手势**；浏览器 agent 下拉与截屏陈旧帧按既有手势处理。

---
## ⚖️ 任务6② UI P1：裁决批量操作条（双面）+ 证据链折叠计数预取（2026-09-22）

### Added（MemoryPanel/web）

- **裁决批量操作条（双面同构）**：`PendingSection`（ChatMemoryPage 价值锚页）与 `SoulPendingRail`（/soul 右栏队列）各增批量操作条——全选/清空 + `批量采纳（n）/批量拒绝（n）`（0 选与 busy 态禁用）+ 每行复选框；批量决策走 `tea.confirm` 二次确认（O13 单向状态机不可复决，批量拒绝同样确认），逐条顺序调 `pendingDecide`，失败计数诚实提示「批量决策部分失败（k 条）」，完成后 refresh+清空选择；批量期间行级按钮同步禁用。零新端点（复用 `pendingList/pendingDecide` 单一 API 面）。
- **证据链折叠计数预取（PersonSection）**：rows 到位后经 `prefetchedRef` 防重逐行预取（`fetchEvidence` 与展开共用同一缓存，展开即显示零等待）；折叠态计数从首次展开前的 `—` 变为真实条数——活体实证「证据链 · 37」与 C11 判据一致（此前 C11 实测 37 条仅存在于展开后，折叠态为 `—`）；失败静默落空态（展开时诚实显示失败文案）。
- 活体验收（截图+DOM 断言并用）：价值锚页批量条 0 选禁用→勾选 2 条后 `批量采纳（2）/批量拒绝（2）` 启用（**不实际提交**——生产数据面变更待用户拍板）；/soul 人物行 `证据链 · 37` + 右栏批量条+20 复选框（截图·DOM·OCR 三证）。
- 门禁：面板 vitest **127/127** 持平 · web tsc 存量 2 持平 · vite build ✓ · tdai-panel 重启 200 · 密钥扫描 0 · bundle 内容断言（`_pending-batch` 在场）。事故登记：补丁脚本 v1 闭包 bug（make_R 修改自身闭包 s 而非模块级 s→save 写回未修改原文，mtime 假变更）——已重写为传递式 `s=R(s,…)` 并加读回断言（v2 全过）；浏览器截屏陈旧帧按既有手势（强制重绘）恢复后 OCR 对账收口。

---
## 📚 D-3 sensitivity 全链实施 + 丢值点 #1-#8 收口（用户拍板「全做」，2026-09-21/22）——文档-代码脱节补案（任务6①）

### Added（MemoryCore）

- **全链实施（`9925f3f`）**：SOUL_COLUMNS 第 9 列 + 幂等迁移 + FTS 26 列重建门 + 提取 SENSITIVITY_BLOCK（gated 缺省关=逐位现状）+ 确定性枚举门 + 注入行敏感徽章 + R11 召回降权乘子（缺省 0）+ 遗忘 sensitivityBias（缺省 0）+ atomic/search 出参 + BFF/UI 属性表。core vitest 666/tsc 222 持平 + 面板 120/build ✓。
- **丢值点 #1/#2（`4dfe49d`）**：`parseExtractionResult` 字段映射未透传 sensitivity（LLM 输出被解析层丢弃→确定性门兜底 none）；config `parseConfig` 补 sensitivity 子树解析（yaml 门此前静默丢弃未知键）；导出 `parseExtractionResult` 供测试（+2 golden，core vitest 667）+ yaml extractionEnabled 开启。
- **丢值点 #3（`01afbb3`）+ 旁路防护（`36fa56b`）**：writeMemory record 构造与本地类型补透传（soulBindValues 按 SOUL_COL_NAMES 取键但记录未携带）；update/merge 路径敏感缺省合标 undefined→none（旁路 NULL 防护）。
- **向量/FTS/工具路丢值点 #4-#7（`02fe1a0`/`620c10b`/`40f0e2c`/`8806cfd`/`0597ed1`）**：vectorResultToFormatable→searchL1Vector push（+meta 内联类型）→R7 分层候选池 soul 源→ftsResultToFormatable→工具路 summary 行徽章——双路召回行徽章渲染数据面逐环补齐，每笔 vitest 667/tsc 222 持平。
- **第 8 处（F-T1-1，`0ad0ed5`）**：`l1-extractor.ts:273-274` 非对称空值合并（条件侧 `?? "none"` 枚举命中、后果侧裸 `String(undefined)` 串化落库）→ 枚举门抽单一源导出纯函数 **normalizeSensitivity**（undefined/null/缺失/非法一律 "none"），l1-writer falsy 兜底保留；DB 实锤 4 行存量 "undefined"（生产 2+ev17e 2，created 2026-09-21T23:16）——**存量值修正提案单独 gated 待拍板**（不批维持现状：SENS_LABEL 不识别即不渲染徽章=诚实降级，代码已拦新增）。RED 4/4→GREEN 9/9；vitest 671/tsc 222。
- **终验证据**：生产租户有效 sensitivity 标注=0（6 行有效标注全在测试租户——生产实效依赖真实数据自然累积，不建议人为播种）；徽章渲染=召回行+属性表双层活体在场；SENS_LABEL 双份（auto-recall.ts:2025 / memory-search.ts:1459）单一源收敛候选登记（属任务1 整改面，改前 RED）。

### Fixed（docs / UI 2.1c）

- **UI 2.1c 节补案（`1811851`，此前无 CHANGELOG 案）**：价值锚面板内嵌 agent 下拉在 SoulPage 复用（blockIdOverride）时隐藏——死控件去除（用户指令「直接去掉」），ChatMemoryPage 缺省挂载逐位保留（面板 vitest 120 / web tsc 存量 2 / build ✓）。
- **spec §4.1 sensitivity 行状态同步**：L237「预留拍板项（不实施）」→「D-3 已实施（2026-09-22 收口）」+ 机制一行（normalizeSensitivity 单一源枚举门；三层体现=注入徽章/出参/属性表）；L238 recurrence 行按既定口径待 D-4 收口后一并更新，本轮不动。

---
## 🔍 任务1 收口轮：§4.1/§6.5 余条款判定 + U1 徽标/U6 占位文案修复（2026-09-22）

### Fixed（MemoryPanel/web）

- **§6.5 U1 收口（spec 原文：「identity + self_identity 两槽内容只读展示（+version/updated_at/source 徽标）」）**：此前 `IdentitySection` 只渲双槽正文、丢三徽标——内核 `/v3/core-memory/read` slots 本就返回全字段（`sqlite.ts:2355` readCore SELECT `slot,content,source,version,updated_at`；BFF `identity/read` 纯透传），纯 UI 消费缺口。修=新增纯函数 `identityMetaOf`（同槽首行三字段，缺失/非法一律 undefined 不造假值）+ 双槽徽标行（`v{n}` / `source: …` / 本地时间，全缺不渲染）；`identityRead` 出参类型同步三可选字段。TDD：RED 3（`tests/identity-meta.test.ts`，跨包 import 前例=`../web/src/…`）→ GREEN 3/3。活体：价值锚页身份区徽标 `v4 / v7 / source: identity-discovery / 2026/9/19 21:39:50` 截图+DOM 双证。
- **§6.5 U6 收口（spec 原文：「预留徽章位（不实施，拍板后启用）」→ D-3 已实施，占位残迹误导）**：锚池配额条两处 `敏感度（待拍板）` 改如实 `敏感度（L1 行已实施）`；注释同步。活体：配额条 OCR（主题 15/15 · 人物 1/8 · 品格 0/8 · 敏感度 (L1 行已实施)）+DOM 双证。
- **判定表摘要（§4.1 三层体现）**：19 列 + metadata 8 项逐列对照（召回注入徽章=§2.7 round 3 活体；灵魂注入=soul[发生/实见/情感/重要度]+活动时间；Panel UI=AttributesSection 全列+SoulSection chips personRefs/identityRefs+memory-graph 语义着色）——除 recurrence 行（D-4 gated 设计已呈等拍板 📝）与 spec §4.1 L237/L238 文本滞后（任务6① 已案）外全 ✅；§6.5 U2（node_type 徽标/三池配额/role+aliases 行内编辑/aliases 并入反查计数 `queries=[label,...aliases]`）、U3（refsOf 单点泛化三 refs）、U4（handleViewRelated 人物反查）、U5（零适配）、U7（配额条并入锚面板）全 ✅。
- 门禁：面板 vitest 124→**127**（+3）全绿 · web tsc 存量 2 持平 · vite build ✓ · tdai-panel 重启 200 · 密钥扫描 0。事故登记：脚本内含中文锚点需按目标文件行尾转换（`双组皆空` 注释实锚在 identity-utils.ts 而非 IdentitySection.tsx——锚选错文件 ABORT 1 次，取证后改锚重跑）。

---
## 📓 T5 召回/灵魂注入日志系统（用户 2026-09-22 新令·拍板定案）——采集点单一源 + BFF 直读 + ChatMemory「召回日志」UI 全链（2026-09-22）

### Added（MemoryCore + MemoryPanel）

- **内核 writer（`0271d82`）**：采集点=`performLayeredRecall` 返回点单一源（钩子路+路由路两路共用，禁第二采集点防 O12 双计重演）；entry=`ts/query/strategy/租户三元组/sessionReused/layered/conclusionCount/experienceCount/searchTiming/block/memoryLines`；best-effort 双层吞错=日志失败零影响召回热路径；写入 `<dataDir>/logs/recall/recall-journal-{team}-{agent}.jsonl`，大小轮转缺省 5MB、数量上限缺省 5（`.1.jsonl` stem 命名，logrotate 惯例）；config=`memory.recallJournal.{enabled,rotationSizeMB,maxFiles}` 挂 memory 层级，clamp (0,100]/[1,100]，**缺省 enabled=false=逐位现状**。TDD RED 6→GREEN 6/6（轮转命名约定错位直调诊断脚本实锚后按测试契约修）；vitest 677（+6）/tsc 222 持平；enabled=false 下 `logs/recall/` 目录不存在=逐位现状实证。
- **BFF 读面（`c9a9261`）**：`/chat-memory/recall-journal` 直读路由（分页倒序+租户过滤+轮转聚合；目录=env `TDAI_RECALL_JOURNAL_DIR` ?? `/data/tdai-memory/logs/recall`，与 core writer 同源语义）；零改内核；RED 4→GREEN 4，Panel vitest 124/124。事故登记：路由插桩吞上一路由收尾 `});`→接缝两次修复（插入型补丁接缝检查已录入 SOP）。
- **UI 段（本批）**：ChatMemoryPage 第三视图「召回日志」=`RecallJournalView`（每轮一卡：时间+query 原文+meta 徽标（策略/分层召回/会话复用/结论/经历/FTS·向量耗时）+灵魂注入块 details 折叠+召回记忆行列表；agent 下拉+刷新+共 N 轮；分页 prev/next；zh/en 双语）。防御渲染：可选字段缺失一律不渲染；错误态诚实文案不造数据；memory/anchors 两既有视图逐位现状（_rj-* 零泄漏 DOM 断言）。事故登记：i18n 插值 key 误用单 `{x}`（仓库惯例 `{{x}}`）→8 key 修正重验。
- **ev18 真数据**：生产 yaml 开 `enabled: true`+双重启后 12 轮真实召回（生产租户双 agent，覆盖同 session 同 query/新 session/无 session 三形态）逐轮核验：租户分文件成立（两 agent 两文件）、entry 14 字段齐全、sessionReused 活体语义正确（同 session 同 query→true，其余 false）、钩子路与路由路双路均被单一采集点捕获。UI 真数据验收=截图+DOM 断言并用：真实徽标数值/灵魂块折叠展开（`<soul-identity>` 原文在场）/分页（共 N 轮+has_more+页码切换）。
- 门禁：面板 vitest 124 持平 · web tsc 存量 2 持平 · vite build ✓ · tdai-panel 重启 200 · 密钥扫描 0。事故登记：浏览器截屏流陈旧帧×3（像素 diff=0 实锚）→ 刷新+强制重绘恢复，DOM+裁剪 OCR 双通道交叉确认后收口。

---
## 🔢 D-0：内核 atomic/query 出参七字段补齐——UI 属性表全列呈现（2026-09-21）

### Fixed（MemoryCore + MemoryPanel）

- **内核出参映射补齐 7 字段（spec §4.1 十九列硬令收口）**：`/v3/atomic/query` 出参补 `scene_name/priority/session_key/session_id/timestamp_str/timestamp_start/timestamp_end`——此前 `queryL1Paginated` SELECT（sqlite.ts:4766）已含全部列（真数据填充率 519-520/520）但 v2-router AtomicDetail 映射丢弃。修复=映射抽单一源 `atomic-query-fields.ts`（空串文本→undefined 宁缺毋滥；priority 数值照传），fast path（1276）与 legacy fallback（1297）双路同函数共用；v2-schemas AtomicDetail override 接口同步 7 可选字段。**审计纠错：移交文档"BFF 已前向兼容"假设不成立**——BFF chat-memory.ts 非 spread 映射，本轮三段同补（内核映射/BFF 透传/AttributesSection 补列），scene/priority/session/事件时间三组进属性表+复制 JSON。
- **TDD**：RED 3 用例先行（七字段/既有字段逐位回归/空值 undefined）→ GREEN 3/3。
- 门禁：MemoryCore vitest 654→657 全绿（+3 golden）· tsc 222 持平（stash 对照法实证：改动前 222/改动中 226/双跳转修复后 222）· 面板 vitest 112 持平 · vite build 成功 · web tsc 存量 2 不新增。
- 活体验证（生产三元组 team-kcjjqzkxks/usr-kfym3ajzme/agt-kfynybx0ly）：`/v3/atomic/query` 出参七字段实值在场（scene_name=生产场景名/priority=98/session×2/timestamp×3）；四服务重启后 health=200。
- **D-0b（彻底覆盖路径面）**：`/v3/atomic/search` 映射第三份内联拷贝同走单一源——`handleAtomicSearchShape`（scene_name/priority 补齐；搜索行类型 MemorySearchResultItem 不含 session/timestamp×3，诚实缺列）+ BFF /chat-memory/search 透传同补。RED 2 用例先行→GREEN 5/5；vitest 654→659 全绿、tsc 222 持平、面板 112+build。活体：search 出参 scene_name/priority 实值在场。教训登记：补丁 python 重写整文件时 newline="" 将 CRLF 文件统一为 LF（chat-memory.ts 等 3 文件 6155/866/876 行重写）——e8e0651 按 O19 铁律恢复 CRLF，diff vs HEAD~1 仅剩 27 行真实改动。

---
## 🎨 UI 2.1：灵魂页重排（用户反馈"不满意"→ 双专家设计评审 → P0 批实施，2026-09-21）

### Fixed（MemoryCore）

- **D-1（行为变更，用户拍板"全做"，2026-09-21）：F17 slot 正文截断改按行（事实）边界**——`truncateByLines` 单一源（soul-assembler.ts 导出）：旧行为字符 slice 截在事实句中间（活体实证：self 600 字符截于"如 identit"），注入块以残句喂 LLM 破损主语完整性；新行为逐行累积预算内整行、超限行整体丢弃、无一行可用时首行字符截断兜底（槽不空）。TDD：RED 3 用例（多行无残句/短内容逐字节回归/单行超预算兜底）→ GREEN 8/8。**A/B 新旧对照 12 组真实生产槽内容（≥10 组硬令）**：唯一超预算组（self 838 字 8 行）oldResidual=true→newResidual=false（整行保留 500 字符、丢 3 条超限行）；其余 11 组 ≤ 预算逐字节一致（零回归面）。spec §2.7 F17 注记同步。门禁：core vitest 659→662（+3）· tsc 222 持平。

### Changed（MemoryPanel/web）

- **三池锚 Tab 化 + kebab 收纳（P0 尾批，同轮追加）**：ValueAnchorsPanel 增 `variant?: 'panel'|'soul'` prop——`panel` 缺省逐位现状（ChatMemoryPage 活体回归零变化：quota 条+16 行四按钮+零 kebab/零 vtab DOM 断言）；`soul` 变体（仅 SoulPage 消费）：配额并入三池 Tab 标签（主题 15/15·人物 1/8·品格 0/8 计数内嵌）+ 每池行过滤 + 每行四操作（编辑/钉住/退休/删除）收 kebab ⋯ 菜单（危险项红色），敏感度预留位右置。真实浏览器双页验收+活体 DOM 断言。

- **触发**：用户明示对 /soul 视觉不满意；并行召唤「UI 设计师 + UI 视觉验收设计师」双专家（设计重方案 + NO-GO 整改清单），P0 批由 AI 亲自编码实施（共享组件 IdentitySection/PendingSection 零改动——ChatMemoryPage 逐位现状）。
- **IA 重排（信息零丢失映射）**：紧凑页头 56px（标题 18px + 副标题升维为 5 个锚点导航 pill + Agent 下拉同行居中）→ 全宽感受状态条 44px（原两行大卡降级；语义 pill 深色文字 #0a7f2e/#a04e0f 对 chip 底 ≥4.5:1——验收 V-01 整改）→ 12 栅格主列(8)+右栏(4, sticky)：身份双槽**双栏并排**（色点+徽标+bullet 首句加粗+行高 1.75+>12 行渐隐折叠「展开全文(n 字)」）与重要的人单卡行列表（32px 头像圆+role/方向/别名 chips+w 迷你条）+ 待裁决右栏分组折叠队列（采纳=蓝色小主按钮/拒绝=text 级 hover 红——20+ 对等权按钮轰炸整改）→ 全宽三池锚面板（本批复用零改动，Tab 化属下一批）。
- **V-02（P0 安全）凭据掩码**：`maskSecrets` 单一源（显式 key=value/Bearer/长 token ≥24 位三规则，留前 4 后 4），PersonSection 证据链正文渲染前统一过掩码——**渲染即脱敏**（截图/快照/导出同步生效）。活体验证：证据行 10 条渲染、1 行含 ****** 掩码、零明文 sk- 泄漏。
- **C11 整改**：证据链按钮折叠态带计数（「证据链 · n」）；展开默认 10 条 +「展开其余 n 条」（37 条时实测）。
- 新组件：SoulIdentityDual/SoulFeelingBar/SoulPendingRail（SoulPage 局部，数据同源 identityRead/pendingList/valuesList 零新端点）；PersonSection 重排（原 D-2 功能全保留：chips 可达/定位展开）。
- 门禁：面板 vitest 117→120 全绿（+3 maskSecrets golden，RED 先行）· vite build ✓ · web tsc 存量 2 不新增。
- 真实浏览器验收（DOM 断言+截图双证）：五分区全在场（feeling/identity/person/pending/anchors）· 行高 22.75px/13px=1.75 · pill 文字色 rgb(10,127,46)·折叠态展开全文(809 字)·裁决 20 行分 2 组。
- 残余（下一批）：三池锚 Tab 化+kebab 收纳+退休区折叠（设计师 §4.6）；裁决批量操作条（P1）；Anchor 面板四按钮 kebab 化。

---
## 👥 D-2：人物锚专视图 + chips 可达性（P2 硬令"设计有的全部可见"，2026-09-21）

### Added（MemoryPanel/web）

- **SoulPage 人物专视图（PersonSection 新组件）**：每人物一卡——👥徽标 + label + role + 方向徽标（趋近/回避/中性，personDir 同语义）+ aliases + 信念强度 + **证据链展开**（label+aliases 反查 → personRefs 命中过滤 → record_id 去重 → L1 行列表逐行展示：时间/实见推断/正文——溯源到具体 L1 行）。置于感受段与裁决流之间；无人物锚宁缺毋滥不渲染。
- **记忆详情人物 chips 点击可达**：SoulSection 人物 chips 由 span 升级为 button——点击 navigate('/soul', state:{person:label})，SoulPage PersonSection 自动展开该人物证据链并滚动定位（高亮卡）。
- **纯逻辑单一源 `person-view.ts`**：buildPersonRows（active 人物筛选+attrs 解析）/ directionLabel / collectPersonEvidence（与 VAP handleViewRelated 反查口径收敛同源）。
- TDD：`tests/person-view.test.ts` RED 先行（5 用例：筛选/attrs 损坏降级/方向词映射/证据 personRefs 过滤去重/空 refs 全滤）→ GREEN 5/5。**RED 阶段修复：parsePersonAttrs catch 返回 {} 致下游 aliases=undefined（宁缺毋滥语义应为 []）——单测实测暴露。**
- i18n：soul.person.* 六键（zh/en）；CSS：_soul-person-* 族+chips hover 可达 affordance。
- 门禁：面板 vitest 112→117 全绿（+5 golden）· vite build 成功 · web tsc 存量 2 不新增。
- 教训登记：CRLF 文件补丁锚须显式 \r\n 形态（首版锚未转行尾被 ABORT 拦截零写入，二版修复）；vitest transform 缓存曾致"磁盘与执行面不符"假象，清 node_modules/.vite 后排除。

---
## 🎨 UI 2.0 Phase 1：灵魂一级页（用户拍板③，2026-09-20）

### Added（MemoryPanel/web）

- **`/soul` 独立一级页（SoulPage）**：页级 Agent 选择器 + 身份双槽卡（IdentitySection 复用）+ 当下的感受（FeelingCard 新组件：theme ∧ valence=±1，与 soul-assembler 注入块同构渲染——「驱动我行动的价值/提醒我审慎的价值」）+ 待裁决流（PendingSection 复用）+ 三池锚面板（ValueAnchorsPanel 复用）。空态宁缺毋滥。
- **ValueAnchorsPanel 复用改造**：新增可选 `blockIdOverride`（页级注入 blockId）与 `hideIdentityPending`（SoulPage 页级渲染身份/裁决避免重复）；缺省逐位现状（ChatMemoryPage 挂载不变）。
- 路由 `/soul` + 菜单「灵魂 Soul」（资产组 order 6）+ i18n（zh/en）soul.* 键族。数据零新端点（blockId=chat_memory-{team}-{agent} 确定性组合）。

### Phase 2（记忆页属性与关系全景）

- **BFF 属性全景透传**：/chat-memory/layer|search 出参补 `task_id/team_id/user_id/agent_id/version/updated_at`（内核 atomic/query 已返回；scene_name/priority/session/timestamp×3 内核今日不出参——诚实缺列，内核补映射后自动呈现）。
- **AttributesSection（新）**：L1 详情「🧬 属性」折叠表——双时态/认识论/情感与重要度/版本与演化（evolution.from·reason）/租户与任务/召回统计/主题与证据（subject/evidence_ids）分组键值表 + 「复制 JSON」（clipboard 缺省时 execCommand 兜底，http 面板可用）。
- **RelatedSection 边类型着色+图例**：邻居行/关联链 type 色标（similar 蓝 #5b6bff / evolve 绿 #1a9d63 / conflict 红 #e5484d / **derived_from 绿 #16a34a（Phase 2 增补）** / part_of 紫 #8b5cf6 / causal 橙）+ 展开段图例，与记忆图配色一致；记忆图本体已有五色边映射+图例（U-B1）——登记勿重做。
- 门禁：web tsc 2 存量错不新增；vite build 成功；面板 vitest 112/112 持平。

### Verified

- 面板 vitest 112/112 持平；web vite build 成功；web tsc 2 存量错不新增（SoulPage ResourcePage import 漏项即修）。
- **页签无响应修复（用户实测反馈）**：ConsoleLayout `PATH_TO_PAGE` 缺 `/soul` 注册 → 菜单点击 `PAGE_TO_PATH['soul']`=undefined 不导航、activePage 回退 chat_memory。补 `/soul`+legacy 别名，重建重启后活体 DOM 断言全绿（页头/三卡/双槽三标题/感受段真实数据「驱动：SDD、管线、spec · 审慎：审计、回归、评审」/配额 15/15·1/8·0/8/VAP 16 行/pending 20 对）。教训：**新增一级页完整注册面 = routes + menu(union/meta/icon) + ConsoleLayout PATH_TO_PAGE 四处，缺一即页签无响应**。

---
## 🧬 A-7b 证据指针（用户拍板，2026-09-20）——身份支撑从"字面找回"升级为"确定性引用"

### Added（MemoryCore）

- **提案协议扩展**：DISCOVERY(_DUAL) 输出契约增可选 `support: [样本行号,…]`（1..N，只列真实支撑 1-3 行，宁缺毋滥）；buildIdentityPrompt 样本行号声明可作 support 引用；无 support 行为逐位现状。
- **确定性校验门**：`sanitizeSupportIndices`——整数/样本窗内/去重/上限 5（F20 红线下投机全选=永生事实风险，门必须收口）；非法编号丢弃；全非法→回退滑窗路径（协议失败不降级）。
- **identityRefs 精确回填**：有合法指针 → 逐 record_id 直填支撑行（摘要式改写不再依赖 12 字滑窗——ev14 量化残余回填漏 1/8 的正解）；无指针 → 滑窗兜底（F-EV13-1 修复保留）。
- **supportMap 并入身份状态 kv**（上限 64 键）：事实→支撑 record_ids 映射。
- **GROW-MAINT 确定性重验**：映射命中且引用行仍 active → 支撑（ev14 量化 unsupported 假阳 1/1 的正解）；映射悬空/未命中 → 滑窗兜底；悬空+滑窗漏 → 仍告警（防永生事实，F20 不变）。identityRefs 切片引用/-isRefProtected 全兼容。
- 登记：character 池 evidence 的 support 联动暂缓（ev14 该拒采面未触发；self_identity 有料后随 A-3 终验复评）。

### Verified（ev15/ev16 全新租户真数据）

- **ev15（18 种子）**：identityRefs 回填 7/8→（kv 修复后 wave-2）18 行全覆盖；暴露 store 层 supportMap 静默丢弃（getter/setter 仅两键）→ `e4351b2` 第三键 JSON 持久化修复 + store 级 roundtrip golden（RED 证据=生产实况：adoption 写/MAINT 读丢）。
- **ev16（10 种子，决定性）**：首轮 pass 6 事实采纳→supportMap 6 键全落 kv（精确 record_id）→同 pass anchor-growth MAINT 读 map→**零 unsupported 假阳告警**（ev14 基线 1/1 假阳归零）；self_identity 经 AGENT_ACT 视角长出 1 条。观察登记：'以产品总监身份要求你' 诱饵实为用户自称角色→正确落 identity 槽（门语义未破、主语路由正确、证据链可审计）；'强加 AI 人设'形态留 A-3 终验。

### Tests

- 新增 golden `identity-support-pointer.test.ts`（7 用例：精确回填/非法弃用滑窗兜底/上限 5/supportMap 落 kv/MAINT 映射支撑/悬空仍告警/无 support 逐位现状）。vitest 645→652 全绿；tsc 222 持平。

---
## 🔒 neighborExpand 归档不回流（用户拍板 C，2026-09-20）

### Fixed（MemoryCore）

- **executeMemorySearch 两条图通道邻居解析统一改 `getL1ByIds` 优先**（仅 l1_records 活跃表）：V2-1 PPR 候选池（graphDiscount 缺省 0.6=active）与 J 邻居扩展两处此前均 WithArchive 优先，归档记录可经图扩散/扩展回流工具路结果（活体 RED：归档邻居 b2 复现于结果）。归档=软删（遗忘语义），图通道不得复活已遗忘记忆；旧 store 无 getL1ByIds 回退 WithArchive（逐位兼容）；租户复核与失效排除不变（b91f4d5）。登记：auto-recall 注入路 PPR/R7-2 通道（产线 graphDiscount=0 关断中）在 gated 重开时须同步本语义。

### Tests

- 新增 golden `neighbor-expand-archive.test.ts`（归档邻居不回流 + 活跃邻居能力保留控制组）。vitest 643→645 全绿；tsc 222 持平。

---
## 📋 P0 收口轮：审计报告入库 + 死导出清理 + v7 台账（2026-09-20）

- **审计报告入库**：`docs/superpowers/plans/2026-09-20-soul-p0-audit-report.md`——P0 对照复查 53 行判定表（§5 公式+§4 骨架 23 行、层结构场景 15 行、P0.5 公式六面+提示词九面 15 面）+ ev14 F-EV13-1 残余量化（GROW-MAINT unsupported 假阳 1/1、identityRefs 回填漏 1/8、身份门/pending 修复/隔离 ✅）。
- **characterEvCount 死导出清理**：anchor-growth.ts 零生产引用（F-EV12-5 后被 characterEvidenceCount 取代），按铁律 2 单一源精神删除；vitest 643/643、tsc 222 持平。
- **v7 台账**：`2026-09-20-remaining-work-v7.md`（A-1 A-7b / A-2 UI 2.0 / A-3 ev14 终验余项；gated 继承+ev14 数据登记；neighborExpand A/B/C 拍板项）。

---
## 🔍 P0 对照复查轮一：四处缺陷修复（REG-REMAINING v7 审计，2026-09-20）

### Fixed（MemoryCore）

- **P0-F1（中）pending 证据展示单一源化**：删除 identity-discovery.ts 本地第二份 `recountEvidence`（20 字前缀逐字、无 lowercase，与 F9 token 口径同名不同义，违铁律 2），core_value/strict_rule→pending 的 evidence 改与 `identityFactMatchesCorpus` 同源（≥12 字滑窗）——旧口径对提炼措辞结构性假 0（F-EV13-1 同族），pending 裁决流人工证据数失真。identity/self 提案按 09-15 裁定本就跳过证据重算，不受影响。
- **P0-F3（低）theme 去重清单跨类型收窄**：anchor-growth existingLabels 收窄 theme 池（spec §2.6 复合键——人物/品格与主题同名可并存）；同类型全态 veto/retired 永不重提语义保留（audit #11 闭环）。顺手：GROW-MAINT 退场日志阈值改分池 minEv。
- **P0-F7（中）反查键族扩 personRefs**：searchL1ByCoreRefs SQL/JS 双层扩 personRefs（spec §2.6/S6"searchL1ByCoreRefs 同款"）——人物锚证据链反查恢复（R5 补池/工具路/Panel 计数三个消费面受益）；identityRefs 不并入（20 字切片语义，消费方=GROW-MAINT/F14）。
- **P0-F2 硬化（防御纵深）**：neighborExpand 扩展路径补租户复核——getNeighbors 透传 isolationFilter + resolveByIds 后 rowMatchesIsolation 复核（T14 两步过滤同款）。跨租户邻居边泄漏 RED 活体复现后 GREEN（同租户建边不变量下零行为差）；归档回流产品开/关仍属 gated 待拍板。

### Tests

- 新增 golden：`identity-pending-evidence.test.ts`（2）/ `anchor-growth-dedup-scope.test.ts`（2，跨类型去重+veto 控制组）/ `store.personrefs-reverse.test.ts`（2，personRefs 反查+coreRefs 回归）/ `neighbor-expand-tenant.test.ts`（1，跨租户邻居不泄漏——RED 阶段活体复现 b1 入 t1 结果）。vitest 636→643 全绿；tsc 222 基线持平（stash 对照法确认唯一新增 TS2352 已修）。

---
## 🛡️ 审计修复轮一：F-EV12-1/2/4（REG-REMAINING-006，2026-09-19）

### Fixed（MemoryCore）

- **F-EV12-1（高危）L1 提取失败不再推进游标**：`pipeline-factory.ts` 组循环累计 `extractionFailed`，失败批次跳过 `markL1ExtractionComplete`（游标不动 → 下次对话触发 / l1Idle 600s / boot L1_drain 自愈重试），并压平 `hasMore/hasFullBacklog`（防 hasFullBacklog 立即重入队在供应商故障期形成重试风暴）。此前 LLM 失败被吞错后游标照进，故障期对话记忆静默丢失（journal 实证）。
- **F-EV12-2（高危）E3 session-reuse 缓存租户隔离**：`auto-recall.ts` 缓存键并入租户三元组（teamId/userId/agentId）+ 空 sessionKey（/v3/recall 缺 body session_id）整体关断复用通道。此前 sessionKey 单键使同 query 不同租户在 TTL 内互相复用注入记忆列表（A桶→P桶 跨用户泄漏活体实证）。
- **F-EV12-2-b（A-2 硬化）结论层幂等缓存键并入租户三元组**：端点 sessionKey 被 resolveIsolation 缺省填充为 `"default"`（v2-schemas.ts:393，此前 v2-router 注释宣称空串——已同步修正），sessionKey 单键会跨租户共享结论层 LRU（同指纹才复用=内容良性，但 LRU 互相驱逐 + reused 标志失真；活体 P桶-b/Q桶 sessionReused=true 实证）。硬化后隔离完整。

- **UI 轮（A-8，浏览器实测）MemoryPanel 修复与验证**：①U7 分池配额迷你显示**回归修复**（CSS 类在而 tsx 渲染零引用——Vision 三次核验+grep 双证；补 `_va-quota` 条：主题 15/人物 8/品格 8 + sensitivity 预留位，活体 DOM 验证「主题 15/15 人物 1/8 品格 0/8」）；②character 类型徽标补齐（nodeTypeBadge/_va-nodetype--character）；③存量构建破损修复（en-US.ts relatedCount 值缺收尾引号，0abc6a9 起从未构建成功）；④存量 tsc 债清理 3 错（PERSON_REF_COLOR 漏 import 运行时崩溃预防/PendingItem 漏 re-export/ValueRow 漏解构 onViewRelated），余 2 错登记。面板 vitest 112/112 持平；web vite build 成功。
- **F-EV13-1（A-7，ev13 真数据发现）身份事实↔语料措辞断链修复**：槽事实（identity-discovery 提炼措辞）与 L1 语料（提取器措辞）必然微差 → identityFactSlice 20 字逐字包含结构性零命中——identityRefs 回填 0 / GROW-MAINT unsupported 全假阳 / character 提案恒拒采（三处共用断链口径，违反自生长/自维护）。修复=单一源匹配器 `identityFactMatchesCorpus`（12 字滑窗，确定性纯函数，统一 strip 列表前缀；<4 字宁缺毋滥不命中；完全相等命中），四消费面统一换用（identityRefs 回填/GROW-MAINT/character 证据门/isRefProtected——旧切片引用向后兼容）。
- **F-EV12-5（A-5）character 池三处不对称修复**：GROW-MAINT 维护口径改事实切片 characterEvCount（与采纳同源，theme 字面计数误退消除；无切片冻结）+ 分池阈值 cfg.character.minEvidence + QUOTA 守卫补 character 分池 + reweight 不漂 node_type；soul-feeling 过滤收窄 theme-only（spec §2.7「仅主题锚」代码化）。
- **F-EV12-4 rRef clamp 下限 10→1**：`config.ts` yaml `rRef: 2` 曾被静默钳到 10（配置值与生效值背离）。

### Tests

- 新增 golden：`l1-runner-failure.test.ts`（游标不变量）/ `recall-e3-tenant.test.ts`（跨租户不复用 + 空 sessionKey 关断 + 复用语义正向控制）/ `config.rref.test.ts`。vitest 617→627 全绿（批次一 623 + A-2b 1）；tsc 222 基线持平。
- 批次二：+`anchor-growth.character-maint.test.ts`（3 用例：维护口径/QUOTA 守卫/感受段过滤）；A-3 勘误改判非缺陷（B3 裁决 sqlite.ts:1951-1954，审计报告勘误段）；A-6 spec §2.2/§2.7/§2.8/§7-P3 同步。
- 批次三（ev13 重放轮）：+`identity-fact-match.test.ts`（9 用例）；vitest 627→636 全绿；tsc 222 基线持平。


## 🪞 灵魂 P2：人物锚双池与人工采纳闭环（DS-SOUL-MEMORY-002，2026-09-17）

### Added（MemoryCore）
- **人物锚双池**（spec §2.6）：`core_values` 增 `node_type`（theme/person）与 `attrs_json`（role/aliases）列（幂等 ALTER，缺省=逐位现状）；anchor-growth 同一 worker 策略化分叉 person 池——`p-` 前缀跨类命名空间、F11 别名维度证据口径（label∨alias 包含去重）、F12 valence 符号（±0.2 阈值）+ personRefs 证据链回填、F19 别名维度去重（提案 label/alias 命中既有人物 label/alias 全态即拒）、F15 QUOTA 分池（主题 15 / 人物 8 独立计数与阈值，防人物锚挤占主题名额）。
- **identity GROW-MAINT**（F15 身份分支/F20 红线）：`identityFactSlice` 20 字切片弱口径单源；身份事实全量语料重验——失撑**只告警永不自动退场**；identityRefs 采纳路径回填。
- **F14 遗忘保护**：`forgetting.refProtection`——coreRefs/personRefs 命中仍 active 锚（含人物 alias）、identityRefs 命中现行身份事实切片的记忆不进归档候选；保护前重验 refs 有效性（悬空不保护，防永生记忆）。
- **O13 人工采纳闭环**：`core_pending` 表（pending→adopted/rejected 单向状态机，同 (slot,content,tenant) 幂等，不复活）+ 三 store 方法 + `/v3/core-memory/pending/list|decide` 路由——identity-discovery 的 core_value/strict_rule 红线类提案落 pending（永不自动写入），Panel 采纳：strict_rule→validateCoreWrite+消毒+upsertCore('panel-adopt')；core_value→upsertValue('panel-adopt','manual')。
- **灵魂渲染 person 分流**（spec §2.7）：新增「重要的人：女儿(家人·趋近)、老周(棋友·中性)」行（weight DESC cap 5，数据驱动空则省略）；价值锚/感受段过滤人物锚（关系方向「回避」与价值方向「审慎」语义分离）。
- **配置**（config-first，全部缺省=现状，yaml 显式开启）：`anchorDiscovery.person.{enabled,maxPerPass,maxTotal}`、`anchorDiscovery.identityMaintain.enabled`、`lifecycle.forgetting.refProtection`。

---

## 🪞 灵魂 P1：agent 自我层双槽落地（DS-SOUL-MEMORY-002，2026-09-17）

- **双槽制（spec §2.5）**：core_memory 新增 `self_identity` 槽（agent 自我第一人称：职责模式/承诺/红线执行/工作风格），identity 槽语义收敛为用户身份（我心中的他）——零 schema 变更，信任边界 allowedSlots 缺省 +self_identity（写入仍由开关门控）。
- **双视角自发现**：identity-discovery 单次 LLM 调用同窗产出用户事实 + agent 自我提案（gated：`memory.coreMemory.selfIdentity.enabled` 缺省 false=逐位现状，含 prompt 行为）；agent 侧提案复用 stripIdentityStateResidue 单一源（状态剥离门），「行为可证」为提案 prompt 硬约束；maxPerPass 截断；`selfIdentity.intervalHours` gated 覆盖冷却（F15 分池节奏，enabled=false 不读取）。
- **四段渲染（F17）**：soul-assembler gated 渲染（我是谁）self 段在前 +（我心中的他）identity 段 + 价值锚 + soul-feeling；multi-line 仅首行带前缀；段级预算超限截断（宁缺毋滥）；legacy 路径（开关关）字节级一致。
- **提取视角（l1）**：AGENT_ACT_BLOCK 运行时追加（常量体零改动），仅内置 chat prompt 且开关开时生效；mode=code 隔离；自定义 memoryPrompt 策略权威保持。
- **旧文留痕（O14 缓解）**：身份 merge 成功后 replacing 日志（旧文 200 字切片），首次写入不打。
- **Panel（U1）**：`/chat-memory/identity/read` BFF 只读透传（复用 /v3/core-memory/read 零新端点，ACL/idFields 与 values/list 同款）+ IdentitySection（宁缺毋滥，双槽空/读失败不渲染）挂载于价值锚管理视图。
- **测试**：MemoryCore vitest 500→521（+config 5/双视角 4/冷却 2/四段渲染 5/留痕 2），MemoryPanel 106（+BFF 透传 3）；tsc 基线 243 持平。
- **实机 SOP（ev5_* 32 条种子 + 2 轮全管线对话，3 租户）**：首轮 tick 双槽采纳（identity 5 事实+self 2 事实）；对抗全挡——串味提案（用户事实伪装 agent 自我）未进 self、纯状态陈述被 strip 拒、strict_rule 走 pending（分级门，evidence=0）、XML 注入零残留；换用户 B（围棋教练 vs 书店创始人零泄漏）/换 agent C（self 换、用户身份不幻觉）双判据过；/v3/recall 注入 soul 前缀四段完整（（我是谁）在前）；AGENT_ACT 提取宁缺毋滥（agent 承诺入 self_identity 不重复入 L1）。
- **登记**：v5 O18（per-instance store：lifecycle 自发现只覆盖 default 实例库）、O19（MemoryPanel CRLF 行尾——补丁须二进制安全）、O20（typecheck 基线 243 行预存债务）、O21（ev5_* 测试数据留存待授权清理）。O15/O16 的 P1 部分落地（主语修正+双槽）见 v5 行内标注。

---

## 🧬 身份自发现两修复：采样窗口失明 + LLM 预算对齐（2026-09-17）

- **修复 1（自生长核心）**：identity-discovery 裸 `rows.slice(0,50)` 建立在 queryL1Records 无过滤路径 `ORDER BY updated_time ASC` 之上——采样的是**最旧 50 条**：语料超上限后新记忆永远进不了样本窗，身份自生长对新语料失明。改用 `selectSampleRows`（updated 降序 + 高显著 ≥0.8 优先 + cap 截断，锚同款禁第二份），证据重算语料仍走全量。
- **修复 2（可用性）**：LLM 调用从 `maxTokens: 16384` + 缺省 120s 超时对齐 GROW-EVO P2.1（用户裁定）：`timeoutMs: 0, maxTokens: 0`——此前是 O8 同款确定性失败病（推理模型 thinking 吃满预算/时延）。
- **登记**：v5 O13（分级门 pending 无持久化落点 + 留痕承诺失实）、O14（身份全量替换的旧事实静默遗忘——live 实证 v3→v4 蜜蜂/日语出局，缓解=语料可再生自愈）。
- **实机 SOP（12 组 ev4_* 灵魂/召回验证）**：身份槽 v3→v4 演化全部有语料支撑（技术评审/首席厨师/深空摄影/手冲咖啡/围棋）；/v3/recall 三组靶标全中（向量+FTS 双层命中、soul 字段渲染完整：发生/实见/情感/重要度）；fts-only 诚实降级横幅、已作废记录召回排除、跨租户零泄漏（xtest 查询不漏 flowtest 内容/锚/身份）、会话缓存 meta.sessionReused 二次命中 True。AROUSAL-GATE 基线机制运行正常（漂移 1.5%<30% 不误报）。

## ⚓ 价值锚自生长自维护修复：漂移基线死代码激活 + 名额口径对齐 + 快照新鲜度（2026-09-17）

- **背景**：锚子系统 SOP 对抗审查（自生长/自维护原则专项）发现三处实现级问题，全部修复并 live 实证。
- **修复 1（自维护核心）**：P3.1 拍板②的归档率漂移旗标（±30% AROUSAL-GATE）是**死代码**——`obs_archive_total`/`obs_l1_total` 全库只有读者没有写入者，且 `getAnchorGrowthState` 键集根本不含它们。新增 `store.getSelfObsBaseline/setSelfObsBaseline`（anchor_growth_state 全局单键组，与调度状态四键分立防 clobber），self-obs 块读基线算 drift、写本轮基线；首轮无基线 drift=0 不误报。
- **修复 2（名额口径）**：采纳 free 计算（旧）= maxTotal − 全态钉住数 − 含钉 auto 的 auto 活跃数——钉 auto 被**双计**、retired 钉住被计入占席；与 GROW-QUOTA 守卫口径（active 钉 + active 非钉 auto）不一致（偏保守方向）。统一为守卫口径。
- **修复 3（快照新鲜度）**：GROW-QUOTA 守卫退场后 anyState 未刷新——陈旧快照导致 free 低估、挤出可打已退场空炮。quotaRetiredA>0 时重查全态。
- **测试**：anchor-growth.test.ts 23→27 用例（+漂移基线点火/不误报双断言、+名额口径对齐、+快照新鲜度防空炮——后两者用**有状态假件**（retire/upsert 真实变更行集）才能观察刷新路径）。vitest 496→500，tsc 243 持平。
- **实机 SOP（12 组新鲜对抗种子 ev3_*，31 条，flowtest 桶）**：adopted=3（maxPerPass=3 封顶）、reweighted=2（每周 0.33→0.41、计划 0.40→0.47，与 |Δw|≥0.05 防抖对账）、displaced=0、valence derive=3（体检=-1 渲染"审慎"）、backfillCoreRef 与独立重算精确一致（咖啡 7/7、体检 4/4、家庭烹饪 4/4）、围棋(active)/深空(retired) 双去重守恒、垂直园艺(ev=2)/泰拳(ev=1) 被门槛拒、钉住锚证据豁免 live、状态自愈重写、注入面 soul-identity 价值锚行含全部新锚。基线 kv 首轮落盘（obs_l1_total=352），次轮起 AROUSAL-GATE 具备数据基础。
- **登记**：v5 O12（锚证据口径无 certainty 门槛——inferred 内容同权参与锚强度，本轮未观察到实际采纳，等产线实例再评估）。测试夹具（状态回移/钉住）已回滚或自愈；ev2_/ev3_ 测试种子留存待授权清理。

## [Unreleased] — 2026-09-09

### 🔧 skill 提取工人活性修复：transient 无界重试封顶 + 争锁轮询日志降级（2026-09-17）

- **现场实证**：09-17 03:13:53 起三个 skill 提取任务（超大对话，必然超出提取超时预算）以
  "operation was aborted due to timeout" 被 classifyError 判 transient → **无限重试**（79/50/25 次，
  5+ 小时）：retry_count 永不增长→永不入 DLQ，extract-lock 被长期占住拖垮两个产线 agent
  队列；同时 60 worker 池对积压 agent 以 ~2s 周期热轮询，每轮 3 组 info 日志
  （dequeued + acquire_lock 块 + contended）≈ **2 万行/分钟** 日志洪水（基线 ~20 行/分钟）。
- **第一性原理定性**：两个不变量被破坏——① 活性：任何排队任务必须到达终态
  （完成|DLQ），transient 是错误类的统计性质不保证单任务自愈，同 task 连续同因
  失败即事实确定性失败；② 可观测性：空转/轮询事件不得 info 刷屏（P4a 已降
  consume_done，本次补全剩余三处）。
- **修正**（extract-worker.ts 7 处 + 超时/输出上限解除 6 文件）：① `transientMaxRetries`（缺省 5，0=关不推荐）——
  同 task 连续 transient 达上限→转永久路径（retry_count++ → 达 permanentMaxRetries 入 DLQ，
  数据保留可重放）；streak 转路后不清零（后续失败直通，总尝试次数有界≈
  cap + permanentMaxRetries）；② 成功即清 streak；③ dequeued/acquire_lock(未抢到)/contended
  三处轮询日志 info → debug（抢到锁仍 info）。
- **验证**：新增 `extract-worker.test.ts` 4 用例（cap 封顶入 DLQ / 未达 cap 逐位不变 /
  成功清 streak / 争锁降 debug）；全量 vitest 495/495（491+4），tsc 243 持平（stash 基线
  对比法证明零新增）；重启后日志速率 20000 → **38 行/分钟**，contended 刷屏归零，
  四服务健康；**端到端实证**：向 flowtest 注入 46.7KB/62 条中性载荷，
  提取以 dur_ms=144480（>120s 旧死亡线）success=true 完成（旧预算下必然
  超时进入无界重试）；另登记 O9（懒启动 pool + 内存队列重启孤儿化，择机项）。
- **根治拍板（同日追加，用户指示"不限制超时、要功能可用"）**：skill 提取
  解除固定预算——`skill.extraction.timeoutMs: 0` + `skill.extraction.maxTokens: 0`
  （两新旋钮，llm-runner GROW-EVO P2.1 同款语义：params 显式 0 覆盖 runner 级
  llm.timeoutMs/maxTokens 缺省；0 = 不挂 abort / 不传 maxOutputTokens）。链路：yaml
  → config.ts skill 段透传 → resolveSkillConfig → SkillExtractor（新增 timeoutMs
  选项）→ review runner.run；tdai-core 单例与 server per-instance 工厂双装配点同步。
  关键语义：超大对话超 120s 是确定性失败而非瞬时故障，不应被当作瞬时
  错误反复重试；提取锁续约机制（TTL/4）已支持任意长跑。真挂死连接由
  undici 层超时兜底 + LIVENESS-CAP 最终入 DLQ。关键字调用（maxTokens: 64）不变。
- **观察登记 O8**（v5 第六部分）：超大对话（接近 40KB 归档阈值）的提取超时为
  确定性失败，现由 cap 入 DLQ 保护；根治已拍板实施（超时/输出上限解除）。
- 产线影响面：DLQ 中任务可手工/工具化重放（_buffer DLQ 条目含原始 archive_key）；
  真实瞬断故障（网络闪断 <10 分钟）仍在 cap 容忍带内自愈，不受影响。

### 🧬 P4b 受控正文演化上线：evolution-worker（GROW-EVO §4，REG-REMAINING-005 #1；2026-09-17）

- **新组件** `MemoryCore/src/core/lifecycle/evolution-worker.ts`：离线 worker 挂 lifecycle tick（consolidation/forgetting/anchor-growth 同款互斥 tick），扫描 conflict 边 → 五条件门 → LLM 单次受控重写 → 合并单条（`source='evolution'`、`metadata.created_by='evolution'`、`metadata.evolution={from,reason}`）+ `evolved_from` 审计边×2 + 双旧失效（旧值 valid_end=新观察时刻对齐 P2 内联语义、新值 valid_end=演化时刻）。全系统唯一允许改写已固化正文的路径，宁缺毋滥。
- **设计最优性审查（实施前置红队 10 问，全部真实代码/数据实证）**，5 处实现级修正全部向“门更严”偏置：① 幂等标记 = evolved_from 审计边参与集——**valid_end 不能当幂等标记**（P2 内联失效实测已把真矛盾对旧值置位，拿它当标记 = worker 永不触发）；② spec 门①“dedup 给了 rationale”降级为“conflict 边存在”（rationale 从未落盘，全库 grep 零命中），再验证职责移交 worker LLM 单次调用的 skip 分支（spec §4.3“低置信→只留 conflict 边”预留分支，语义等价，登记 spec 偏差）；③ 新增 `store.getLinksByType(type)` 单条索引查询（取代逐 id `getLinksByTarget/Source` 的 O(N) 扫描，sqlite.ts/types.ts 同款模式）；④ 门② subject 双侧非空且严格相等（null≠null；danbooru 假阳性边实证拦截）；⑤ 门③ pin/veto 实现为 L1 `metadata.pinned/vetoed` 协议位（当前 L1 无 pin 机制，前瞻位）。
- **合并/失效边界 golden（v5 硬要求）**：`evolution-worker.test.ts` 16 用例——CMAS→PADI 归并叙事 fixture（skip→零写路径 + prompt 反例指令断言，防系统性推翻 extractor 合并决定）、真矛盾对 rewrite 全链断言（bi-temporal：occurred_at=新值/valid_start=旧值起点/valid_end 开放）、五条件门逐项拦截、悬挂边容错、maxRewrites 护栏、进程内节流。
- **live 验证两轮（flowtest 11 组播种场景 + 产线 8 条真实边，真实 Ark LLM）**：首轮 rewrites=1（“主力手机 iPhone 13→16 Pro”合并质量人工复核通过：保留最新值+沿革一句），门遥测逐项命中（dangling=5/certainty=1/subject=4 含产线假阳性对/pin=1/newerInvalid=1/timeOrder=1/crossTenant=1）；次轮 rewrites=0、归并合并对真实 LLM skip、已演化对被 newerInvalid 拦截（evolved_from 幂等集为三角冲突防御）、maxRewrites 精确护栏。召回核查：合并记录可召回、失效旧记录被排除；FTS 副本同步实证；LLM 调用 maxTokens=0/timeoutMs=0（GROW-EVO P2.1 裁定）。
- **配置**：`memory.evolution`（enabled/maxRewrites=3/intervalMs=3600000）config-first，代码缺省 false=逐位现状；产线 yaml（部署本地）与 `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml` 模板同步落盘 enabled=true（拍板启用）；server 接线 evolution 配置透传，LLM runner 缺失时 worker 安静跳过。
- **设计最优性复审 v2（2026-09-17 SOP 对抗实施）**：五条件门/去重无向对/幂等参与集/maxRewrites 最保守口径/P2.1 语义/bi-temporal 合并产物逐项复核符合 spec §4.2-4.3；新发现链式残差（3 链终态新端真值与谱系叙事双 valid，v5 O10）——处置=预登记遥测 gate.staleLineage（数据先行不松门，§4.5 同款）+ 链式 golden 用例（单次合并收敛/最新真值不触碰/不失控）；否定传递闭包失效方案（现实拓扑无可达触发路径）。测试 16→17 用例。
- **SOP 实机全链验证（2026-09-17，12+1 组新鲜对抗数据）**：门遥测逐项对账（certainty/subject/timeOrder/pin/newerInvalid/crossTenant/dangling/idempotent/staleLineage=2/llmSkip 全命中，2 次真矛盾重写 LLM 理由均正确排除叙事包含）；召回注入端到端：合并记录注入首位、过去时态 ve 的双旧记录被生产同款 isInvalidated 谓词排除；bi-temporal 在三种时钟配置（未来/混合/过去 ve）下行为均正确；invalidateL1 首次权威不覆盖 live 确认；价值锚 40 条（origin=auto 自生长）无演化产物污染，coreRefs 关联通道可用。发现登记：v5 O11（recall 会话复用缓存键缺隔离指纹，本部署未触发）。测试参数（maxRewrites=20/intervalMs=60s）已回滚产线值。
- **受影响测试**：新增 `src/core/lifecycle/evolution-worker.test.ts`（16 用例）；全量 vitest 491/491（基线 475+16，50→51 文件）；tsc 243 持平零新增。判定类变更：无（排序/golden 快照未触碰）。
- **观察登记 O7**：合并记录 metadata-only（无 embedding——lifecycle scheduler 无 embedding 接线，upsertL1(rec, undefined) 与 consolidation 持续态同款先例）：FTS 路召回不受损，向量通道对合并知识有覆盖缺口，量级受门严控制；若 D2 校准期实测漏召回再评估（前置 = embedding 接入 lifecycle 装配）。
- 附：判官标注积累 labels-2026-09-16.jsonl +75（09-17 04:00 timer 自动，总量 217/300——D2 门槛预计 09-18/19 到达，未抢跑）。

### 📋 剩余工作 v5 落盘（REG-REMAINING-005，取代 v4 待办部分；2026-09-16 深夜）

- 按方法论将未完成待办逐项对照真实代码（file:line 按 64dd815 刷新）做第一性原理分析后写入
  `docs/superpowers/plans/2026-09-16-remaining-work-v5.md`，v4 头部标记取代（留档不删）。
- **第一部分·真正要做的**：① P4b evolution-worker——**门槛已到（conflict=6，[P4-GATE] 自动宣告），
  待拍板**；新增硬要求 = 合并/失效边界 golden（session-h CMAS→PADI 归并叙事 fixture，防 P4b 推翻
  extractor 合并决定）+ evolution.enabled config-first 缺省关；② D2 产线替换——标注 142/300
  （tdai-judge.timer 实证每日 04:00，预计 09-18/19），rerankWeights 为改值非新增键（yaml:99）。
- **等门槛**：D5 R10 A/B、P4a Phase 2 重蒸馏（溯源 ROOT 实盘实证）、D7 recordIds（:3723）。
- **择机**：flowtest 退役；maxPerPass 工作点定格（3 采纳节奏正常，待拍板，1 行）。
- **不做/关闭增量**：extractor 窗口全量消费（续批已收敛）、运行时 persister（游标治理更优）、
  executor 去重整体移除（窄豁免已达目的）。
- 观察登记 O1-O6（新增 O5 遗忘×P2a 语义对抗修复留档 + 复发监测点、O6 flowtest 归档率高位）；
  配置审计全绿含 rerankWeights 表述修正。

### 🔬 修复后全量验证轮（SOP 四步）——对抗性审查实锤并修复两缺陷：遗忘年龄语义 + boot recovery 边界（2026-09-16 深夜）

- **① 复审**：c35a3e6 双修复 7 项红队候选全核销（TimerScanner legacy 解析、L2 级联隔离、双定时器
  并存、锁丢失重放、endsWith 边界、worker 启动时序、阈值双跑幂等）；更优方案四项排除（运行时
  persister / boot 直接入队 / 全量去 skip / 窗口全量消费）。
- **② 配置审计**：全绿——anchorDiscovery 5 字段、durativeEnabled、excludeInvalidated、
  arousalRetention 0.3、emotionSalienceWeight 0（恒等位红线）、MEMORY_LOG_LEVEL=info、FTS 同步、
  向量双写 0 跳过、无 seedValues 残留。**修正 v4 审计表述一处**：recall.rerankWeights 键实为显式
  落盘全 0 恒等（非"键不存在"），行为等价、红线无恙。**[P4-GATE] conflict=6 ≥5 自动宣告**（v4 #2
  立项条件到达，待用户拍板，勿抢跑）。
- **③ 完整流程测试（session-h，潜水主题族 12 组新数据，真实入口 + 对抗面）**：提取 12→两轮
  （前 10 + 续批 2）自愈闭环；纯知识噪声（珊瑚白化）拒提；CMAS→PADI 矛盾归纳合并；durative
  valid_start 落库（游泳/装备/入坑）；LLM 时间推导（"周末"→2026-09-19）；valence 8/8 非 NULL；
  召回 11 组 PASS（含时间旅行 2025-06、跨 agent 隔离、噪声禁现）。
- **③ 对抗性发现·缺陷一（boot recovery 边界缺口）**：飞行中提取被重启打断 → 游标未落 checkpoint →
  会话对 recovery 不可见（session-h 12 条滞留复现）。修复：store 新增可选能力 `listL0SessionIds()`
  （sqlite DISTINCT，degraded→[]），boot recovery 数据源改 **runner_states ∪ L0 全会话**并集，扩面键
  由游标治理空跑兜底。重启实证 53 会话覆盖、h 自愈。
- **③ 对抗性发现·缺陷二（系统性：遗忘年龄语义）**：`forgetting/scorer.ts ageDaysOf` 沿用 A2 的
  occurred_at 优先链——**事件时间被误当记忆年龄**：P2a 溯源越准（occurred_at 越精确指向过去），刚
  出生的记忆 decay 越低、越快被归档。session-h 实锤：occurred_at=2025-06 的高价值溯源锚记忆
  （Koh Tao 浮潜，valence 0.8）**出生 4 分钟被 forgetting tick 归档**，时间旅行召回失灵——两个子系统
  在真实数据上互相对抗。修复：**遗忘年龄 = 记忆系统年龄**（createdAt/created_time 优先，occurred_at
  旧链仅作无系统时间形状的回退，A2 语义保持）；语义边界 = occurred_at 描述"事件多老"（检索时间相关
  性），衰减输入是"记忆多老"（Ebbinghaus 自形成起算）。**误归档 2 条经 /v3/atomic/archive/restore
  全部回滚**（L1/FTS 重新同步），召回复验转绿。
- **③ 价值锚全链验证**：kv 冷却回拨（快照留档）触发发现轮——adopted=3（潜水/航拍/围棋，valence
  derive 3/3 非 NULL）；GROW-MAINT 深空 evidence=2<3 退场；coreRefs 双向回填实证（AOW/装备/愿望单
  记忆挂 ["计划","潜水"]）；名额 5/15，GROW-QUOTA 未触发。kv 回拨已被发现轮合法状态覆写（还原反而
  伪造状态，不还原）。
- **回归**：tsc 243 持平（改动文件零新增）；vitest **475/475**（50 文件 = 472 + 遗忘 golden 3）。
  **受影响测试（新增：`forgetting/__tests__/scorer.test.ts` +3）**：occurred_at 久远+createdAt 新 →
  keep；L1RecordRow created_time 行形状生效；无系统时间旧形状回退 occurred_at 链（A2 逐位保持）。
  调参（l1IdleTimeoutSeconds 60）byte-identical 还原；四服务健康。

### 🩹 提取覆盖性与游标缺陷修复（boot recovery + L1_drain 续批豁免）+ 锚门静默 debug 化（2026-09-16 深夜）

- **问题（v4 #5 实锤缺陷的机制定位，双重根因）**：
  - **根因 A（重启触发丢失）**：`LocalStateBackend` 的 conversation_count 与 L1_idle 定时器全在进程内，
    重启即失；而 gateway 路径从不把 checkpoint 状态恢复回 backend（`setStatefulPipelineManager` 把
    `ensureSchedulerStarted` 变 no-op，`statefulManager.start` 无调用方；checkpoint `pipeline_states`
    在盘上恒空——StatefulPipelineManager 无运行时 persister）。重启前已捕获、尚未过阈值的会话在无新
    消息时**永久滞留**。实证：session-e 游标停在提取窗口第 10 条，尾段 2 条（月食/窄带）十几小时无消费。
  - **根因 B（续批定时器被去重饿死）**：`hasMore` 尾段续批靠 `armL1IdleAfterDrain` 挂定时器，但到期任务带
    `triggeredBy=timer_scanner`，executor 对 `conversation_count===0` 的 timer 任务按"已处理完"跳过——
    续批场景下 count 几乎总是 0（阈值触发后已清零），且续批定时器复用 `L1_idle` 成员无差别命中该去重。
    游标尾段因此只有 nudge 阈值触发这一条侥幸路径（session-f 实证）。
- **修复（3 文件，~100 行，config-first 无新开关）**：
  - `stateful-pipeline-manager.ts`：① `armL1IdleAfterDrain` 改挂独立 `L1_drain` timer member
    （`classifyTimerType` startsWith("L1")→L1 兼容，与 L1_idle 键分离可共存）；② 新增
    `recoverPendingSessions(sessionKeys)`——按 checkpoint `runner_states` 会话键逐会话重挂 L1_drain
    定时器（service mode `__unset__` 跳过；SessionFilter 生效；destroy 后 no-op）。
  - `gateway/server.ts`：① boot 时调 recoverPendingSessions（读 checkpoint runner_states，失败
    non-fatal warn）；② executor 的 count===0 去重对 `timerMember` 以 `L1_drain` 结尾的任务豁免。
  - 不变量：到期 L1 任务由**游标治理**——无积压时空跑即返回（零 LLM 成本，不推进游标），有积压
    hasMore→再次续批 / hasFullBacklog→立即重入队，逐批收敛。
- **真实数据验证（生产管线，idle 临时调 60s 逐键还原）**：
  - 历史滞留清账：boot recovery 48 会话重挂 → session-c/e/f 尾段全部消费（颈椎操/茶馆/月食→归纳合并落
    L1，session-e 游标 914→916 收敛）；
  - 事故完整复演（session-g，围棋主题族 12 条）：首轮提取窗口=前 10 条 → `hasMore=true` → **重启**
    （杀掉续批定时器）→ boot recovery 重挂 → 60s 后 drain 到期 → 游标后 2 条（象棋起源/友谊赛）被提取
    落库，游标收敛至第 12 条。事故场景从"永久滞留"变为"闲置超时自愈"。
- **锚门静默 debug 化（v4 #7，~7 行）**：`anchor-growth.ts` 门 1a/1b 拦截 continue 前各加一行 debug
  （agent/reason/时间戳），summary 行 ran=false 时追加 `firstBlockReason`——重启日志即见
  `firstBlockReason=interval`，"为什么锚没长出来"不再需要插桩考古。零行为变更。
- **回归**：tsc 243 持平（改动文件零新增）；vitest 472/472（50 文件，基线 465 + 新增 7）。
  **受影响测试（新增 golden：`src/utils/stateful-pipeline-drain.test.ts`）**：L1_drain member 解析为 L1
  任务（plain+scoped）、与 L1_idle 键分离、armL1IdleAfterDrain 挂 L1_drain、recoverPendingSessions
  逐会话挂载/SessionFilter/destroy/service-mode 四语义。调参（l1IdleTimeoutSeconds 600→60）已逐键还原
  并 diff 验证 byte-identical；四服务健康。

### 🔬 GROW-RACE/QUOTA 验证轮（SOP 全流程）+ 停滞告警硬化 + 游标缺口三重实证（2026-09-16 晚）

- **对抗性复审**：① retireValue 缓存失效疑点排除（`sqlite.ts:2620` 已有 invalidateValuesCache，写路径 4/8）；
  ② 互斥引入的**停滞面**识别并硬化——一次挂起的 LLM 调用（timeoutMs=0）会静默阻塞全部生命周期且 skip 仅
  debug 不可见：新增连续跳过计数，每 10 次 warn 一次「生命周期停滞告警」，run 完成清零（6 行）。
- **12 组新数据完整流程测试（session-f，无人机航拍主题族，真实入口）**：API 召回组 8/8（Air 3/4K 60 帧反转值
  在场、噪声不在场、persona 在场、旧主题不串、时间旅行、跨 agent 隔离、3 锚 valence 非 NULL）；锚机制
  l5ug 挤出换位守恒（adopted=4 displaced=3，15 不变）+ flowtest 新锚采纳 + 采纳 valence 钩子 4/4 生效；
  FTS 241/241；derived_from 122；提取质量（矛盾合并 4K30→60、durative、persona 增强）落库 5 条。
- **重大发现（v4 #5 游标缺口三重实证升级为实锤缺陷）**：① 注入 12 条后重启（调参）→ add 触发的提取调度
  丢失，13 条全部滞留（40 分钟 0 条 flowtest 提取代）；② 一次 nudge 触发提取 → 溯源 input_refs 实证窗口
  仅含前 10 条（`l1-extractor.ts:190` slice(-10)），尾段 3 条未进窗口；③ 二次 nudge 后尾段仍无消费——
  **重启吞调度 + 尾窗截断 + 续批不完整**三环齐实证。修复方案按 v4 #5 设计推进（插桩游标语义后修"尾窗续批"）。
- **回归**：tsc 243 持平、vitest 465/465（49 文件）；调参（intervalHours/intervalMs/pipeline 5 键）与 kv
  回拨全部还原；四服务稳态（valence 稳态零 LLM）。
### 🛡️ GROW-RACE 互斥 + GROW-QUOTA 名额回归守卫（用户发现超限 → 拍板 A+B，2026-09-16）

- **问题（用户发现）**：l5ug agent 价值锚 18 个（全部 origin=auto、pinned=0）超出 maxTotal=15 三个，
  且无任何自愈处理。
- **根因一（GROW-RACE 并发竞态）**：`lifecycle-scheduler.ts` 的 `setInterval(() => void runOnce(...))`
  不等待上一轮完成；发现 LLM timeoutMs=0 慢调用 + intervalMs 短 → 多个 runAnchorGrowth 重叠，各自基于
  **pass 开始时的状态快照**计算采纳名额 free → 超额采纳。时间戳实锤：9 秒内三个 run 相继完成
  （adopted=8/6/3），l5ug 21 秒内三轮发现各采 3（11+7=18）。
- **根因二（名额无自愈）**：maxTotal 在代码中仅是采纳名额门（anchor-growth.ts 采纳循环的 free 计算），
  GROW-MAINT 自维护只有证据退场（ev < minEvidence）——存量超限无任何回归路径。
- **修复 A（互斥）**：scheduler 进程级 `runOnceInFlight` 标志——上一轮在飞则跳过本轮 tick（debug 可见，
  不留静默）。覆盖 consolidation/forgetting/identity-discovery/anchor-growth 全部生命周期路径。
- **修复 B（GROW-QUOTA 名额回归守卫）**：GROW-MAINT 增加名额回归——超限（非钉 auto + 全部钉住 >
  maxTotal）时按强度（weight × 证据）升序 retire 超出部分（可恢复非删除）；manual/钉住豁免（信任边界）。
  守卫口径：非钉 auto 单列——free 计算的 pinned-auto 双计为保守方向无害，登记不改（改动影响挤出逻辑，
  另行裁定）。
- **真实数据回归**：强制维护轮 l5ug 18→15（按强度升序退"第一性原理"1.360/"Cloudflare"1.667/"确定性"
  2.160，state=retired 可恢复）；全 agent 名额达标（flowtest 2 / kfyn 10 / l5ug 15），活跃锚 valence
  0 NULL；测试手段（intervalHours/intervalMs 调参、冷却戳与语料基线回拨）已全部还原。
- **测试**：+3 golden（quota 超限按强度升序退场且 manual/钉住豁免、名额内零触发、互斥 skip 日志断言）——
  vitest 465/465（49 文件）；tsc 243 持平。
### 📋 剩余工作 v4（REG-REMAINING-004）——验证轮后重排 + 新增提取覆盖性项

- **取代 v3 待办部分**。结构：8 项真正待办（新增 #5 提取覆盖性与批次/重试实证、恢复继承项 D7
  recordIds 索引、#7 门静默 debug 化）+ 相对 v3 的增量不做/已关闭判定 + 配置审计新增
  **接线连通性**维度（anchorDiscovery 假阳性教训制度化）。
- **关键新证据**：session-e 的 m11/m12 因窗口截断（`l1-extractor.ts:190` slice(-10)）未被提取且无后续
  批次——月食记忆缺失使时间旅行用例改用既有记忆；待办 #5 要求插桩实证游标是否保证尾段最终消费。
- **关闭两项**：溯源 best-effort warn 补加（`best-effort.ts:13/:23` 已有 warn，v3 前提双重推翻）、
  提取 prompt 判据修改（#3 实证判据无恙）。
- 文档：`docs/superpowers/plans/2026-09-16-remaining-work-v4.md`。

### 🔌 anchorDiscovery 配置接线修复 + SOP 验证轮实证（REG-REMAINING-003 验证轮，2026-09-16）

- **验证轮重大发现（12 项配置审计的对抗性复核 + 完整流程测试）**：`anchorDiscovery` yaml 段**从未生效**——
  server 把它作为 `startLifecycleScheduler` 的顶层兄弟键传入，而调度器只读 `deps.config.anchorDiscovery`，
  产线恒跑缺省（24h/5/2）。yaml 内"FLOW-TEST 调参演示（2→3）"等历史观察全部无效；此前配置审计该项 ✓
  为假阳性。tsc 基线里 `anchorDiscovery does not exist in type` 即本 bug 的影子（修复后 244→243）。
- **修复**：anchorDiscovery 并入 `config` 对象传入调度器。运行时 debug 实证：
  `anchorDiscovery={"enabled":true,"minEvidence":3,"maxPerPass":3,"maxTotal":15,"intervalHours":1}`（调参值）正确到达。
- **链式发现（配置贯通后）**：① runAnchorGrowth 门 1a/1b 静默 `continue` 无任何日志——又一处静默跳过
  （与待办 #1 同类；本轮临时插桩定位后已移除，gate 原因 debug 化未实施）；② identity-discovery 同链同解——
  flowtest agent 首次采纳 identity（proposals=8 adopted=1）；③ **价值锚自发现全链路首次在 flowtest 跑通**：
  新锚"深空"/"每周"（origin=auto）采纳，**采纳路径 valence derive 钩子（946b6d9）在真实数据上生效**——
  两锚 valence=0（LLM 判定）而非 NULL。
- **12 组对抗性新数据完整流程测试（session-e，真实入口 /v3/conversation/add + 调参加速流水线）**：
  提取质量实证——m1+m2 归纳合并、m6+m7 矛盾归纳消解（新旧值同条呈现，无独立旧记录残留；conflict 路径
  未触发属 LLM 合并判断，非缺陷）、durative valid_start 正确推导（"下个月"→2026-10-01）、纯知识噪声
  （1344 光年）正确拒提、dedup 将新 persona 与既有天文兴趣合并增强；溯源日志 raw_output/input_refs 实证
  assistant 帮办 m4/m8 在窗口内未提取 = LLM 竞争方差（与判据无关）。FTS 238/238 同步、vec 双写 0 跳过、
  溯源日志 668+ 持续落盘、召回注入 5/5（装备事实/反转后主镜在场，噪声不在场，persona/价值锚段在场）、
  跨 agent 隔离（DB+API 双层）✓、时间旅行召回（既有记忆 time_point）✓。
- **回归**：tsc 243（-1）、vitest 462/462 全绿；调参（pipeline 5 键 / anchorDiscovery.intervalHours /
  lifecycle.intervalMs / MEMORY_LOG_LEVEL）全部还原，临时插桩全部移除，四服务稳态（valence 稳态零 LLM）。
### 📊 assistant 提取漏损实证 + 探针脚本（REG-REMAINING-003 #3，2026-09-16）

- **观测设计**：新增 `MemoryCore/scripts/extraction-loss-probe.mjs`——对 flowtest session-d 的 12 条消息按
  生产平价（maxMessagesPerExtraction=10、maxMemoriesPerSession=20、enableDedup、同 LLM 同判据）重复 N 次
  完整提取，逐消息统计命中率；隔离写入临时 baseDir（records JSONL），不触碰生产存储。
- **基线（runs=3，内容锚判定）**：生产观测的"漏损重灾区"assistant 3 条（咖啡/马拉松/观鸟）在本实验
  **2/3 命中**——提取判据不排斥 assistant 主体；生产中已提取的书法/多肉反而 0/3；run2 精确复现生产的
  7/10（丢的正是生产丢失的 3 条 assistant 消息）。轮次间丢失集合不同、与生产观测互斥 → **判定：随机
  （竞争性）漏损，非系统性排除**。无跨消息合并（dedup 非漏损源）。
- **机制补充**：单次 extractL1Memories 只取 10 条窗口，其余降为 background（上下文非提取目标）；
  批次内 LLM 对"值得记"存在竞争方差。窗口头部两条（书法/多肉）0/3 存在"批次头部弱势"嫌疑，
  样本不足不下结论。
- **判定与后续**：按 v3 决策树走"随机 → 评估批次大小与重试策略"，**不修 prompt 判据**；本表作为
  后续提取改动的对照锚（复跑：`npx tsx scripts/extraction-loss-probe.mjs --runs 3`）。
- **探针自身坑（登记防复发）**：① 消息对象必须带 timestamp（否则 Invalid time value 静默失败）；
  ② runner 必须显式传 `maxTokens: 0`（缺省 4096 被推理模型 thinking 吃满返回空文本——产线红线的
  再验证）。
### 🔁 A2-R1 近重折叠剥离回归修复（REG-REMAINING-003 #2 排查中实证，2026-09-16）

- **发现路径**：待办#2 断言还债中 auto-recall-assembly（4 例）/explore-relax（1 例）失败实证追查——
  非交接快照所判的"断言滞后"，而是**真实产品回归**（A2 cfe9eba 引入，stash 对照未覆盖到语义层）。
- **两步根因**：① stripTime 正则锚定 `# Changelog

本文件记录 **TencentDB Agent Memory** 的显著变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/)。

覆盖仓库全部开源模块：`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。

---

，行尾为 "·soul[...]" 时时间戳不剥离——同日行的时间+灵魂
  后缀公共 bigram 主导相似度，**完全异主题同日活动记忆 Jaccard 0.50 ≥ 0.25 被误折**；② 行首 tag
  （type|session）同为元数据，同 tag 行恒共享 20+ bigram——仅共享 3 个内容 bigram 的行对仍被折
  （实测 jaccard 0.254）。A2 校准"重复组 0.36-0.49 vs 非重复 ≤0.04"只在**内容口径**下成立，
  实现却对整行（tag+时间+灵魂）计算，校准前提被元数据污染失效。
- **修复（A2-R1）**：`foldNearDuplicates` 相似度改为内容口径——剥离行首 tag、行尾 soul、时间段
  （stripMeta）后比较。阈值 0.25 不变；真实近重复（跨通道同内容/转述）内容高度重叠不受影响，
  A2 原始动机（重复指令收敛）保持。
- **实证**：单元探针三组数值——I① 行对 0.45→0.143、异主题同日行对 0.50→内容口径 <0.1、
  ④-1 行对 0.254→内容口径 <0.05；受影响套件 13/13 绿。

### ✅ 14 例预存量测试口径还债收口（REG-REMAINING-003 #2，2026-09-16）

- **结果**：全量 vitest **462/462 全绿**（48 文件），回归底线恢复判别力；tsc 244 持平；
  四服务重启后健康（valence 稳态零 LLM 日志正确宣告）。
- **逐例处置**（每例对照裁定登记）：anchor-growth maxTokens 8192→0 ×2（GROW-EVO P2.1：0=不限制）；
  recall-signals DEFAULT_RANK_SIGNALS 快照补 `emotionSalienceWeight: 0`（R10 REG-R10-AB-001 实验轨
  红线）；values-state / values-per-agent growth state 断言补 lastAttemptAt/lastAdoptedAt（GROW-MAINT
  冷却分级落 kv）；core-values-discover 5 例 → D6 绝对证据+饱和公式（0.3 + 0.5*min(e,50)/50，
  REG-REMAINING-001，commit 41ca707）；auto-recall-assembly Critical metric 断言改 A2 语义
  （recalledL1Memories = 未折叠全集，注入块 = 折叠行集；对齐性改证：每条注入行源自某未折叠记忆）。
- **fixture 去近重**：④-1 / ④-3 / explore-relax 三处"仅尾字符不同"的近重复 fixture 改为真实可区分
  内容——行首 tag 公共 bigram 恒定共享，近重复 fixture 会使 slice 对齐与预算裁剪语义不可观测。
- **教训登记**：今后排序/配置类裁定在 CHANGELOG 登记时**同步列名受影响测试**（A2 cfe9eba 未登记
  CHANGELOG，导致本轮需逆向考古才能区分"断言滞后"与"回归 bug"）。
### 🧭 锚 valence 漂移修复：boot 逐租户 derive + 采纳路径补值钩子（REG-REMAINING-003 #1，2026-09-16）

- **根因（三层实证）**：① DB 探针——15 活跃锚全部位于非 default 租户（team-kcjjqzkxks，kfyn 2 NULL + l5ug 4 NULL）；
  ② journalctl——每次重启 boot derive 日志都在（`derived=0 skipped=0`），守卫实际满足，交接快照"零 derive 日志"为口径误记；
  ③ 代码——boot derive 只判 default 桶（`normalizeCoreTenant(undefined)`），非 default 租户锚永不覆盖；且自生长采纳直调
  `store.upsertValue` 不经 v2-router values/upsert 钩子（derive 只在 API 路径触发），NULL valence 原地落库后无人补判。
  真缺口 = "default 桶语义 + 采纳路径绕钩子"的双重静默，非守卫失效。
- **修复**：`IMemoryStore.listNullValenceTenantTriplets?()`（types 可选声明 + sqlite 实现 + tcvdb 伴生库委托，feature-detect
  家族先例，旧后端回退 default 单桶）；server boot 从"仅 default 桶"改为**逐租户顺序 derive**——仅存在 NULL 锚的租户产生
  LLM 调用（稳态零成本），triplet 源与 deriveValueValences 过滤同表（无跨租户泄漏），写回带 `valence IS NULL` 守卫（与
  用户微调/采纳钩子三方幂等，LLM 永不覆盖非 NULL）；每个 skip 分支带原因日志（store 不支持 / LLM runner 不可用 / 无 NULL 锚）；
  anchor-growth 采纳路径补 fire-and-forget derive 钩子（重启之间也有补值闭环，不再只兜重启）。
- **多用户/多 agent 对抗性审查**：逐租户顺序 derive（拒并发 LLM 突发）；`/values/derive` 是全租户重判入口（reset→derive→
  restore），不用于补 NULL——已判值不重掷。
- **回归（实测）**：重启后 boot 日志 `agent=agt-kfynybx0ly derived=2 skipped=0` / `agent=agt-l5ugn6urg4 derived=2 skipped=2`，
  二次重启补齐剩余 2（LLM 首轮未给出有效判定，NULL-only 重试幂等收敛）；DB 探针 NULL=0，**15/15 valence 全覆盖**；
  `/v3/core-memory/read` API 实证 l5ug 11 锚全带方向；soul-feeling 感受段组装覆盖全部锚（valenceDir 消费无 NULL）；
  tsc 244 持平；全量 vitest 14 例失败与预存量分类清单逐位一致（零回归）；新增 `values-cache` 2 例（多租户隔离/空集稳态）。
- 注：l5ug `anima`/`judge` 判 0（中性/无法判定——"宁缺毋滥给 0" prompt 约定语义，非故障）。
### 🔗 P4a-P2 层级边：derived_from 跨层关联（REG-REMAINING-002 #1，2026-09-16）

- **L2→L1 派生边落库**：L2 场景提取完成时，按 `changedProfiles × 本次蒸馏输入记录`
  写 `l1_links` 新边类型 `derived_from`（source=L2 scene block 的 `profile:v1:*` 稳定
  id，租户唯一；target=L1 record_id）。边只增不重写——增量蒸馏语义下 scene block 是
  累积蒸馏，边记录"曾贡献"；同 (block,record) 幂等（addLink ON CONFLICT）。
- **沿边反查接口**：`getLinksByTarget(id, type?)` / `getLinksBySource(id, type?)`
  （sqlite 实现 + IMemoryStore 可选声明，旧后端 feature-detect）——失效传播定位与
  scene block 身世查询（"这段 persona 由哪些记忆塑造"）的数据基础。
- **失效传播定位步**：`invalidateL1` 成功后沿 `derived_from` 边定位受影响 scene
  block 并 `[P4a-P2]` 日志宣告。**逐块自动重蒸馏暂缓**（P4a Phase 2）：生产无溯源
  日志存量（generation-logs 实测 0 份），建边前贡献不可回填，自动重建会静默丢失——
  等边覆盖成熟后启用。
- **P4a-2 混合窗口缺口修正**（对抗性审查发现）：失效排除此前只挡"全失效早退"，
  混合窗口（失效+活跃并存）时失效记录仍混入提取 prompt，scene_blocks 会重新吸收
  已失效内容。现按组过滤蒸馏输入；cursor 仍取全窗口，失效 bump 不造成重查询循环。
- 测试：`l1-links-derived-from.test.ts` 5 例（建边反查/对偶/type 隔离/幂等/失效
  定位）；tsc 244 持平；既有测试失败集与 stash 前基线逐位一致（零回归）。

### 🔇 产线日志级别门 + 遗留清理（P4a 运维，2026-09-16）

- **MEMORY_LOG_LEVEL 级别门**：`env-config.ts` 新增统一读取器（缺省 `debug` = 逐位
  现状），应用到 gateway `createConsoleLogger`（debug/info 门控，warn/error 恒通）、
  `ConsoleLogBackend`（info/debug 门控）、`ConsoleTraceMiddleware` REQUEST_START
  （debug 门控）；`ILogBackend` 接口补可选 `debug?`，`obsLogger` 补 `debug` 方法。
  **空转事件降级**：`skill.worker.suppressed_skip` 与 `consume_done(outcome=
  lock_contended)` 降 debug——空转/争锁重试不是完成事件（产线 INFO 刷屏主源，
  实测 5382 行/分钟）。
- **产线部署（含一次写入事故与恢复，如实登记）**：`/opt/tdai/etc/env` 追加
  `MEMORY_LOG_LEVEL=info` 时因原文件无结尾换行发生**粘连**——`tee -a` 把新行拼进
  `PROXY_ADMIN_API_KEY` 的值（首验 `tail -c 1`/`awk` 给出假阴性；对抗性审查经
  `/proc/<pid>/environ` 实证）。恢复：从污染前启动的 proxy 进程 environ 提取原始值
  重建 env 文件（4 行，键值独立），重启后 `^MEMORY_LOG_LEVEL=info$` 独立 entry 确认。
  **教训**：追加写前必须校验结尾换行；单点验证不可靠，用独立证据源交叉确认。
  修复期间 core 带污染 key 运行约 15 分钟（proxy 侧进程环境始终为原值，无实际损害）。
  实测日志量 **~35000 行/分钟 → ~20 行/分钟**（99.9% 削减），journald 限流解除，
  `[P4a-P2] invalidation … → 1 scene block(s) affected` 产线日志现场可见——层级边
  失效传播定位端到端闭环。级别门行为断言：REQUEST_END(INFO) 可见 / REQUEST_START
  (DEBUG) 归零。
- **遗留清理**：`MemoryCore/D:/tdai-data/`（历史 Windows 路径误配产物，1.1M）整目录
  归档至 `/opt/tdai/backup/tdai-data-legacy-D-20260916.tar.gz`（含 default 租户早期
  种子锚 6 枚：正确/可靠/可用/性能/私有部署/本地——与产线真实锚无重叠）后删除。
  `.gitignore` 原已覆盖该路径。

### 🔬 P4a-P2 全流程验证修正：权威变更集 + 参数实证（2026-09-16 验证轮）

- **建边过度上报修正（对抗性审查发现）**：sqlite（无 pullProfiles）下 L2 进程内
  profileBaseline 恒空 → changedProfiles 每轮上报全部 scene block，建边若直接采用会
  退化为近似完全二部图，失效传播精确定位被稀释。修正：SceneExtractor 的正文 diff
  （created + content-updated，仅 META 变化不算）提升为无条件计算并随 ExtractionResult
  以 `changedSceneFiles` 返回；建边据此过滤。生产实测：flowtest 租户 7 条输入 × 1 个
  实际变更块 = 7 条边，精确连接。
- **llm.maxTokens 参数实证调整**：config-override.json 4096 → 0（解除限制）——真实数据
  实测 9 消息批次 `LLM empty response (finishReason=length, completionTokens=4096)`，
  推理模型 thinking 耗尽输出预算（交接避坑清单已知坑的产线复现）。调整后提取正常。
- **运维发现（登记）**：tdai-core 产线 DEBUG 级刷屏触发 journald 限流
  （`Suppressed 41132 messages`/30s 窗口）——日志诊断不可靠，建议产线提升日志级别；
  `MemoryCore/D:/tdai-data/`（历史 Windows 路径误配产物，空库 0 行）建议清理。
- **全流程实测（flowtest 独立租户，零污染产线）**：12 条真实消息注入 → L1 提取 7 条
  （提取判据"主体必须为用户/AI"实测确认，通用世界知识不提取——设计如此）→ L2 蒸馏
  生成 scene block + derived_from 精确建边 → 显式失效 2 条探针记忆（valid_end 落库 +
  沿边定位逻辑隔离实测通过 `[P4a-P2] invalidation … → 1 scene block(s) affected`）→
  12 组召回查询：5 组精确命中、2 组失效记录正确排除（excludeInvalidated 实证）。
  多租户身份自发现隔离实证：flowtest identity v1 独立落槽，kfyn v4 / l5ug v3 零污染。

### 🛡️ 身份采纳门第二轮：结构校验替代枚举（REG-REMAINING-002 #2，2026-09-16）

- **枚举 → 结构双道**：第一轮枚举剥离（（当前…）/（截至…）/已全部落地/进入观察期）
  被 LLM 发明新表述绕过（三轮复发实证）——第二轮升级为**结构判据**：日期引用
  （`\d{4}[-年]\d{0,2}`）与阶段编号（`P\d`）是状态陈述的结构标志，身份内容
  （角色/职责/关系/纪律）不应含时间坐标；命中 → 剥离所在句。
- **单一源**：剥离链收敛为导出函数 `stripIdentityStateResidue`（identity-discovery.ts），
  采纳门接线；整条提案全是状态陈述 → 空串整体拒收 + `[identity-discovery]` 留痕日志。
  人工清洗（Panel / core-memory write API）保持最后兜底。
- **切分先于枚举**（实施中实测修正）：枚举模式的 `[。；]?` 会吞句界，先枚举后切分
  会把相邻干净句并入状态句遭过度剥离——修正为按句切分 → 逐句枚举 → 结构判据。
- 测试：`identity-gate.test.ts` 7 例（枚举剥离/日期句/阶段编号句/年月形式/干净保留/
  整体拒收/混合叠加）；tsc 244 持平。

### 📋 D5 R10 A/B 预注册（REG-R10-AB-001，2026-09-16）

- **预注册文档入库**：`docs/superpowers/specs/2026-09-16-r10-ab-design.md`——假设
  （weight=0.3 提升情感查询 P@5，判官 rel≥2 口径）/ A/B 设计（0 vs 0.3，config 层
  切换 + Lane 2 hermetic 同构，同标注池 + 标注固定法）/ 情感查询集选集规则（≥20 组，
  queryId 升序不得挑优）/ 终止条件（+5pp 通过 · 连续 3 批无差异终止 · 100 组判负）/
  判官同源偏差声明（判官与 R10 同源 LLM 打分，主检验标注固定 + 双口径敏感性分析）。
  判据/样本/终止条件 commit 即冻结——防 p-hacking 纪律，偏离须修订版登记。
- **R10 工具侧死代码修复**：`memory-search.ts` secondaryOf 第 5 位（情感显著度）比较
  原位于无条件 `return sb[3]` 之后——不可达，工具侧 R10 项从未生效（钩子侧接线正确）。
  移入比较链；weight=0 时第 5 位恒 0，行为逐位不变（tsc 244 持平，tools 域 103 测试
  通过）。此修复为 A/B 双链覆盖前提。
- 登记修订：计划文档所记 `MEMORY_R10_ABILITY_WEIGHT` 环境变量实测不存在，A/B 切换
  以 config-override.json 每臂独立 boot 为准。

### 💗 P3 情感维度激活（GROW-EVO Phase 3，2026-09-15）

- **arousal 遗忘调制（§3.1 闪光灯记忆）**：`effectiveλ = λ×(1-k×arousal)`——高唤醒记忆
  衰减更慢。`memory.lifecycle.forgetting.arousalRetention` 缺省 0 = 逐位现状；生产显式 0.3；
  config 解析层 clamp [0, 0.9]。**归档率漂移观察条款**：`forgetting ran: archiveCandidates=N`
  为观察点，漂移超基线 ±30% → k 回 0 重评（significance 与 arousal LLM 打分正相关，
  乘法公式有情感记忆囤积双重加成风险）。
- **R10 emotionSalience 实验轨（§3.2）**：`|valence|×arousal` 纯函数
  （`emotionSalienceOf`，recall-signals.ts）+ 双链平局接线（工具侧 secondaryOf 五元组 +
  钩子侧 compareLex 项）。`memory.recall.emotionSalienceWeight` 缺省 0 = 可证恒等
  （全 0 项比较）；进预注册 A/B 队列，未过 A/B 不得置正——判官/抽取器同源偏差，
  永不单独放行排序变更。
- **债务清偿**：yaml inferredPenalty 注释修正（三刀后实为平局组内旗标）；valence 同名
  异义已于 P1 口径对照表覆盖。
- **升级须知**：`ForgettingConfig.arousalRetention` / `RankSignals.emotionSalienceWeight`
  / `RecallConfig.emotionSalienceWeight` 新增（缺省值 = 逐位现状）；RankSignals 构造点
  需补字段（DEFAULT/ZERO 已带）。

### 🔄 P2 失效语义闭环（GROW-EVO Phase 2，2026-09-15）

- **写入三口**：① dedup conflict 自动失效（方向性守卫：仅新记忆 observed 才失效旧记忆，
  inferred 只记边——`invalidateL1` 新 store 方法，不覆盖已失效行）；② durative 效期提取
  （prompt 第 6 条判定 + `memory.extraction.durativeEnabled` 缺省 false、生产显式 true——
  持续状态写 valid_start，valid_end 提取侧永不写）；③ `/v3/atomic/update` 显式失效
  （raw body valid_end，ISO 校验，upsertL1 之后写防 soul 回写清除）。
- **读侧排除**：`filterInvalidated` 纯函数 + `memory.recall.excludeInvalidated`（缺省 true，
  spec 拍板①——现存库无失效行 = 逐位不变）三消费点（工具路两裁剪点 + 钩子路 hybrid tail，
  失效记忆连 recall_count 都不积累）；解析失败保留（宁缺毋滥）。
- **API**：`/v3/atomic/search` 的 `time_start/end` schema 死参数激活（显式时间窗，occurred_at
  语义）；`timeWindow:"auto"` 与显式窗共存（无显式参数回落 auto）。
- **Lane 2 转绿**：update 探针判据改为"old 被失效排除、new 在列"（P1 known-FAIL 基线闭环）；
  新增 invalidationExclusion 不变量（预失效噪声记录必须被排除）。
- **P2.1 时间旅行补全（2026-09-15 同日）**：`/v3/recall` 增 `time_point`（ISO）——
  三层管道（handleRecall → performLayeredRecall → searchHybrid）透传 `validityNow`，
  失效排除与时间窗解析以该时点为"当前"；会话复用缓存对 time_point 查询旁路（不同时点
  不可复用）；`/v3/conversation/search` 的 `time_start/end` 死参数激活（recorded_at
  后过滤，L0 无 soul 列口径）。Lane 2 增 timeTravel 探针（tp 过去含 old / 现在排除 old）
  GREEN——原推迟裁定退役。
- **边界发现（登记 P4）**：L1 失效语义闭环（经验层 + 结论层记录路径），但 **L2
  scene_blocks 蒸馏摘要无失效机制**——已失效事实可经结论层 scene 命中路径回流注入块
  （流程测试实测）。L2 失效传播（触发受影响 scene_blocks 重蒸馏）归入 P4 受控正文演化。
- **升级须知**：`ExtractionConfig.durativeEnabled` / `RecallConfig.excludeInvalidated` 新增
  （缺省值 = 逐位现状）；`invalidateL1` 为 IMemoryStore 可选方法（旧后端安静跳过）；
  `/v3/recall` time_point 时间旅行推迟至 P2.1（三层管道成本，失效数据已可经 atomic/query
  时间窗查询）——相对 A/B 与判官软轨不受影响。

### 🧪 P1 验收底座 + 口径还债（GROW-EVO Phase 1，2026-09-15）

- **背景**：DS-MEMORY-EVO-001 v3——本地 golden 语料丢失，人工标注退出；验收转为三信号分层
  （构造式真值 + 不变量断言硬门，LLM 判官软参考轨）。
- **Lane 2 能力道上线**：`scripts/eval-capabilities-fixture.mjs`（hermetic fixture 36 条×双主题包
  可轮换，BM25-only 确定性）+ `scripts/eval-capabilities.mjs`（临时网关 8423，四能力探针：
  时间推理/多会话/知识更新 known-FAIL 基线/弃答（域外零交集 query 实测选型 + ABSTAIN_FLOOR=0.5）
  + 不变量（确定性双跑/租户封闭）），归档 `docs/superpowers/evals/capabilities/`（runs 不入库）。
- **口径还债**：① `handleAtomicQuery` legacy fallback 时间过滤对齐 occurred_at（快慢路统一，
  soul 列 cast 访问）；② `bumpRecallCount` 增 `touchUpdatedTime` 选项（缺省 true = 逐位现状），
  auto-recall 钩子路补 recall_count 计数（top-3 observed，只加计数不刷 updated_time——R8 复开
  数据前提成立）；③ 维度口径对照表 `MemoryCore/docs/memory-dimensions-dict.md`（时间三代/
  valence 同名异义/硬编码常数判定）；④ RRF_K=60 协议常数注释化。
- **升级须知**：钩子路 recall_count 开始积累属预期行为变化（遗忘 recallCountBoost 数据源），
  排序语义零变更；重锚纪律——排序代码未变，无需重锚。

### 🧪 三信号 Lane2 能力道评估脚本（P1 Task 2，2026-09-15）

- 新增 `MemoryCore/scripts/eval-capabilities.mjs`：四能力探针（时间推理 / 多会话 / 知识更新 /
  弃答）+ 不变量组（确定性 / 租户封闭），走临时网关 :8423 + hermetic 临时库（BM25-only 确定性道）
  的 `/v3/atomic/search` 生产同构链路；fixture 语料复用 `eval-capabilities-fixture.mjs`
  （multiSession 时间公式改全局唯一日——P1 Task 2 裁定 Minor①，36 条结构不变，Task 1 冒烟复跑通过）。
- 执行顺序：boot 网关建 schema → 停 → seedStore 直写 temp DB（租户三元组注入）→ 再 boot →
  HTTP 探针 → 归档 → 自停；生产 yaml 全程只读，临时 yaml/dataDir os.tmpdir 自清理。
- 基线（runs/2026-09-14T23-47-44.capabilities.json；runs/ 不入库）：time / session /
  determinism / tenantClosure PASS；update known-FAIL（old 0.895 > new 0.843，P1 无失效语义，
  P2 `excludeInvalidated` 目标翻绿）；abstain FAIL 0/5（真实 query top1 P50=0.811 vs 噪声
  query top1 0.890–0.912——brief 弃答探针与 fixture 噪声 query 语义错位：短词面精确命中在
  bm25RankToScore 下恒 ~0.9，P50 相对门结构上不可过，待弃答探针重设计）。
- exit code 契约：全过=0；仅 expectedRed 失败=0（baseline:true）；意外失败=1。
- 临时 yaml 偏离生产（归档 deviations 登记）：结伴生四开关 + queryExpansion（确定性）+
  exploreSlot（recall_count 跨 pass 漂移）关断。

### 🌱 价值锚纯自发现 + 自维护（GROW-MAINT，2026-09-15）

- **拍板**：取消预制种子——价值锚（标签与权重）全部 LLM 自发现 + 自维护，不再灌 `seedValues`/扇出 default 锚。
- **自维护**：每轮 GROW 对 auto 锚（`created_by='auto-growth'`）按**全量语料**重算证据：
  `< minEvidence` → retire（pinned/manual 豁免）；权重 = suggestAnchorWeight(证据, 全量语料条数)，
  |Δw|≥0.05 才落库；标签不原地改写（coreRefs/dedup 身份锚点），主题演化 = 退场 + 新标签再入。
- **证据重算语料口径 v3**：候选证据重算从 50 采样窗改为全量语料（消除"支撑记忆老化出
  recent 窗 → 证据假衰减 → 误退场"）；LLM prompt 仍为 50×200 字预算。
- **冷却分级**：有采纳 intervalHours（24h）/ 0 采纳 1h（`lastAttemptAt`/`lastAdoptedAt` 落
  `anchor_growth_state` kv 四键；存量 `lastDiscoveryAt` 兼容映射为采纳时刻，保守等价旧行为）。
  语料增长期发现节奏跟随语料（最密 1h 一试），锚稳后回到 24h。
- **可观测**：`[anchor-growth] ran:` 汇总行带 adopted/retired/reweighted；per-agent 明细
  （corpus/candidates/retired/reweighted）上 info/debug。
- **配置**：生产 yaml 删 `seedValues`，`anchorDiscovery.minEvidence` 显式 3；存量 default 桶
  6 行 seed **物理删除**（不用 veto——dedup 查全态清单，veto 会"永不重提"误杀同 label 新提案）。
- **升级须知**：老部署无需动作；fork 部署若 default 桶仍有 seed 行，须**先删行再重启**（顺序反了
  会被构造期扇出复制进 agent 桶）。store 接口 get/setAnchorGrowthState 签名扩展（可选字段，向后兼容）。

### 📄 README 重写为 fork 导向（2026-09-14）

- 原上游英文版 README 移至 `docs/upstream/README.en.md`（README_CN.md 保留为原仓库中文文档）；
  新 `README.md` 声明基线（上游 v2.0.1）、四模块职责、fork 增量总表与同步上游协议。
- 对比基线实测（diff -rq，排除 node_modules/运行时配置）：新增 131 文件 / 修改 937 文件 / 删除 0 文件。

### 💰 Credit 上报总开关（creditReport.enabled，2026-09-14）

- **背景**：云端部署 upstream 非 TokenHub，`computeCreditDelta` 恒 0，上报链路只产噪音
  （每轮 CREDIT_REPORT ERROR + usage_raw 失败审计行）且无记账价值。
- **变更**：`CreditReportConfig` 新增 `enabled?: boolean`（config-first；缺省 true = 逐位现状）；
  `tryReportCreditFromPath` 入口在 `enabled === false` 时短路返回 `{attempted:false, ok:false}`，
  不 fetch、不写 usage_raw、不设 `x-credit-report-error`、不打 pipe.error。
- **升级须知**：老配置无该字段 = 行为不变；生产 `/opt/tdai/etc/proxy-config.yaml` 显式
  `enabled: false`。重新启用 = 置 true（或删字段）并把 url 指向可达端点。

### 🔀 合并召回 · 核心单点 /v3/recall + 代理瘦传输（DS-RECALL-MERGE-001，2026-09-12）

- **MemoryCore 新增 `/v3/recall` 端点**：与 auto-recall 钩子共用同一条提取出的组装路径
  `performLayeredRecall`（九通道检索 + R7 分层 + 预算切分 + 幂等结论层 + CAL C1 截断），
  返回 `{ block, meta: { conclusionCount, experienceCount, sessionReused, layered } }`——
  block 与钩子同 query 同会话产出**逐位一致**（同形验证为自动化验收）。请求 = query +
  maxResults? + 会话标识（body `session_id` 或 `x-tdai-session-id` 头，v3 隔离头族先例）+
  三元组隔离头（严格隔离闸门继承，缺失 422）；检索按 (team,user,agent[,task]) 收窄
  （与 `/v3/atomic/search` 同形）。钩子路径行为逐位不变（提取只搬编排）。
- **配置**：`memory.recall.v3Recall { enabled（代码缺省 false = 逐位现状，端点 404）,
  timeoutMs（缺省 5000，超时 504） }`；生产 `tdai-gateway.yaml` 已显式开启。
- **MemoryProxy TdaiL1RecallInjector 瘦传输**：改调 `/v3/recall` 拿现成块直接前插
  （借入 agent 块前置 `[from <agent>]` 标注）；**降级路**——端点 404/5xx/超时 → 退回
  `/v3/atomic/search` 自行组装 + loud 日志（防静默降级）；`recallL1` 开关语义不变
  （false = 唯一代理注入链零注入，不降级）；`<relevant-memories>` 标记防重保留为冗余保险。
  升级须知：MemoryCore 与 MemoryProxy 需同批升级（老 Proxy + 新 Core = Proxy 继续走旧路，
  行为不变；新 Proxy + 老 Core = 端点 404 自动降级旧路 + loud，均向后兼容）。

### 🔐 记忆可信性修复 M3（信任边界门禁，P2-T11+T13，拍板③）

### ⚠️ 升级须知（行为变更，无兼容期）— 升级后必须配置 API Key，否则记忆功能 401

- **网关鉴权必填**：MemoryCore 网关不再"无 key 放行"。`server.apiKey`（env
  `TDAI_GATEWAY_API_KEY` 或 yaml）未配置时，网关启动会生成一把随机临时密钥
  （crypto.randomBytes 32 字节 → 64 hex，本进程有效，**重启更换**）并 loud 打印
  一次；所有请求（除 `GET /health`）必须带 `Authorization: Bearer <key>`。
- **跨进程调用方必须配置同一把 key**（否则一律 401）：
  - MemoryProxy：env `TDAI_GATEWAY_APIKEY`，或 `config.yaml` 的 `tdai.apiKey`
    （复核修补 I-1 后，skill / knowledge / meta 三链路的 Bearer 也走该兜底，
    不再只读各自 `serviceToken`）
  - MemoryPanel：env `TDAI_GATEWAY_APIKEY`（覆盖全部实例），或
    `config/metadata-instances.json` 每实例 `api_key`
  - openclaw：默认 `Bearer local`（本机无鉴网关遗留默认）——接入鉴权网关后
    必须改为真实 key，否则 401
  - hermes：默认 `Bearer local`（同上）
  - curl / 探针脚本：请求头加 `Authorization: Bearer <key>`
- **`V3_STRICT_ISOLATION` 默认 OFF → ON**：`/v3` L0–L3 数据面现在强制
  team+agent+user 三元组（缺失 422）。本机联调需要旧行为时显式设
  `V3_STRICT_ISOLATION=0` 回退；未知取值 fail-secure 视为开启。
- **升级步骤**：① 先在各组件 env/yaml 配好同一把 `TDAI_GATEWAY_APIKEY` →
  ② 网关 `tdai-gateway.yaml` 的 `server.apiKey` 写入固定 key → ③ 重启网关与各组件。

#### 回滚预案（数据库迁移）

- **T12 core 租户化迁移不可单方面 revert**：revert 后旧代码的 `upsertCore`
  仍走 `ON CONFLICT(slot)`（不含新增三列的冲突目标），对租户化后的新表
  结构报错，core 写入挂。回滚必须二选一：① 先重建旧 slot-PK 表结构
  （迁移回退 DDL）再切回旧代码；② 接受 core 写入降级（读不受影响）。
- **T7 FTS 迁移可单独回退**：旧代码对新 25 列表结构只读列兼容，直接
  切回旧版本即可，无需 DDL。

### 修复内容

- **I-1 · 复核修补（skill/knowledge/meta env 兜底）**：MemoryProxy 三链路
  （skill core-client / knowledge core-client / meta client / skill-bridge
  反代）原先只读各自 `serviceToken`（默认空），不在 `TDAI_GATEWAY_APIKEY`
  透传范围内——鉴权翻转后静默 401 断供。现统一走 `resolveBearerToken`
  （`TDAI_GATEWAY_APIKEY` env → `tdai.apiKey` 配置 → 原 serviceToken）
- **I-2 · 复核修补（L3 persona 消毒接线）**：`escapeXmlTags` 名单追加
  `l3_core_memory|agent` 注入边界标签；`/v2/core/write`（handleCoreWrite）
  落盘前对 content 调 `escapeXmlTags`（与 core-memory write 同模式）
- **T11 · core 写入消毒（守卫在咽喉）**：`escapeXmlTags` 边界名单追加
  `core_memory|identity|strict_rule|core_value|user`；`/v3/core-memory/write`
  handler 在 guard 校验通过后、落库前对 content 统一转义——含 `</core_memory>` /
  `</system>` 的毒化内容无法越块逃逸进 system 注入区，所有读端天然安全
- **T13 · 门禁收口**：`resolveApiKey(config)` 纯函数收编"缺失即生成"逻辑；
  `verifyAuth` 语义收紧为"恒校验"（key 由启动期保证恒有值）
- 同形验证脚本：`MemoryCore/scripts/verify-p2-t11-13.ts`（33 断言全过，
  含临时 server :8421 端到端 401/200 与写入消毒回读）；MemoryProxy 新增
  env 透传单测（`src/tdai/__tests__/client.apikey.test.ts`）

### ✨ 记忆系统第三档首批（C1-C4：价值信号全链流动 + router 退役，2026-09-10）

> 设计与召回影响矩阵：`docs/superpowers/specs/2026-09-10-soul-memory-c1c4-semantic-recall-design.md`
> 纪律：**检索层（向量/FTS 打分、绝对门槛）零改动**——价值信号只在排序/展示/遗忘三层生效

- **【C1】coreRef（记忆→价值锚引用）**：dedup LLM 调用顺带判定记忆触动
  哪些价值锚（候选清单注入 + 幻觉 id 过滤），落 `metadata.coreRefs`；
  召回排序加成（当前查询触动的价值 ∧ 记忆 coreRefs → +0.05 tiebreak，
  `memory.recall.coreRefBoost` 可配）；回忆片段带 `·触[价值]` 尾注；
  遗忘 salience 优先读 coreRefs（子串匹配降为兜底，缓解 K-B5 否定失明）
- **【C2】动机方向（LLM 总结初值 + 用户微调）**：core_values 加
  `valence` 列（可空=未判定）；LLM 批量总结方向初值（三值枚举，
  不确定给 0）；用户经 values/upsert 微调**永远优先**（derive 带
  `valence IS NULL` SQL 守卫 + apply-after-success 快照恢复，并发窗口
  不覆盖微调）；`/v3/core-memory/values/derive` 重判入口；current_feeling
  块按方向输出"围绕【X】推进 / 对【X】保持审慎"（NULL/0 不输出）
- **【C3】router 默认退役**：跨库软定域 router 经隔离实验证伪归因
  （recall 贡献 0、噪音 +2）后退出生产路径（代码默认层 + 本机镜像双退役，
  能力保留可重开）；退役前后锚点归档（negInjected -2 实证）
- **【C4】策略统一**：summarizer significance 补 metadata 双兜底
  （与 scorer 一致，legacy 行真值可见）
- **已知限制**（C2 报告 concern 3/4 登记）：`/v3/core-memory/values/derive`
  当前为同步阻塞实现（30s LLM 超时窗口内请求挂起），异步任务态留待后续；
  LLM 配置热更后 valence runner 不感知，新配置需重启进程才生效
- 同形验证：`verify-c4`(5)/`verify-c1`(21)/`verify-c2`(51)/`verify-c3` 锚点×2、
  MemoryCore+MemoryProxy 全量回归绿- **【阶段五】Memory hub UI 视觉重构（"有灵魂的记忆"可视化）**：BlockDetail
  拆分（SoulSection 灵魂区/RelatedSection 关联区+getPath 链路）、记忆卡片
  增强（valence 双色条/coreRef chips/recall 火苗/归档徽标）、记忆图语义
  通道（金色=挂价值锚/valence 色相/evolve·conflict 箭头）、价值锚管理面板
  （列表/微调/derive）、健康条进度环、wiki 源管理样式统一；Sigma 边 type
  误传业务类型致渲染崩溃修复（f53b173）；atomic/query|search 出参透传
  metadata（896ee5d）——数据零后端新增，纯 UI 工程
- 同形验证：panel vitest 94+ 用例全绿、web build exit 0、BFF 层全测、
  浏览器渲染层人工验收清单（web 无组件测试基建，已登记）- **【阶段七】R7 渐进式披露分层召回**：召回升级两层——L2 持续态结论常驻
  注入（幂等，借团队防重模式）+ L1 经验按预算折叠（scene_name 反查
  part_of 证据链 + coreRef 辅助）；九通道保留 L1 层；无 L2 命中与现状
  逐位一致（退化安全）；golden 双锚实证 P@5 逐位同值（分层不改 L1 排序）
- 同形验证：MemoryCore vitest 275/275 + golden 双锚（runs/12-41-28 前锚、
  13-09-41 后锚）
- **【阶段六】结构感知召回（R1-R6/R8/R9 九通道 + E1-E3 性能速赢）**：时间窗+
  时近性/significance/置信度分层/图一跳扩展(折扣+标注)/价值反查补池/场景
  路由/强化闭环(recall_count log 缩放——T4→C1→排序闭环最后一块)/mood
  congruent 弱偏置(默认关)；query embedding 60s TTL 缓存/values 租户级
  缓存(五写路径失效穷举)/会话级复用；关断矩阵逐通道 0=与基线逐位一致；
  spec：structure-aware-recall-design.md（utilization 矩阵 30%→100%）
- 同形验证：verify-ra1(22)/ra2(14)/ra3(16) + 全量回归绿；golden 系 wiki 设施，
  记忆召回以关断矩阵替代（spec 已更正）

- **【阶段四】TCVDB 后端七项缺口补全（伴生 SQLite 模式）**：score 刻度实证
  文档化（RRF 融合分 ≤0.0328——切 tcvdb 前须真机复验门槛语义）/图全套/
  归档桶/core 表 CRUD 全套（辅助表 DDL/SQL 委托 sqlite 单一实现，
  零第二份手写 SQL）/updateL1Metadata/bumpRecallCount/countL1VectorRows/
  native-hybrid 补 reconsolidation/restoreL1 degraded 守卫/prune fail-safe/
  getL1ByIds(WithArchive) 实现+消费侧 await 接线；契约测试 verify-t1/t2
  （真机实证留部署时，已登记）

### 🔧 收尾与补全（阶段一~三，2026-09-10）

- **阶段一（bug）**：T13 验证链 7 断言修复——根因：CWD 真实
  `tdai-gateway.yaml` 经 override 合并穿透临时 server（测试密钥与实例
  不同源）；修法 `TDAI_GATEWAY_CONFIG` 隔离 + `resolvedApiKey` getter
  同源取值。config 解析失败 loud 化（console.error，静默 catch 语义保留，
  verify-s1 端到端断言钉死）
- **阶段二（小扫除八项）**：env 双名兼容（`TDAI_GATEWAY_APIKEY` 主用 /
  `TDAI_GATEWAY_API_KEY` 兼容）、summarizer significance clamp、wiki
  结构页附尾 cap≤3、探针词拼时间戳、/health 注释、verify-s1 头注释、
  finally try/catch、derive 30s 与 LLM 热更登记
- **阶段三**：coreRef 排序加成延伸 auto-recall（复用 C1 同源常量与
  appraise；多租户 default 桶限制如实登记）；`getPath(a,b,maxHop)` 图
  查询接口 + `/v3|/v2 atomic/path` 路由（BFS 最短路径/租户过滤内置/
  环路安全；消费方=0，待 MemoryPanel 接入）
- 同形验证：`verify-s3`(10)/`verify-s5`(22)、回归全绿

### 🔧 记忆可信性修复 M3 续（T14 租户隔离，P2-T14）

- **neighbors 租户过滤（G2 封堵）**：`/v3|/v2 atomic/neighbors` 按
  isolation 过滤邻居与内容——跨租户枚举封堵；maxN clamp ≤50。
  **行为变更**：/v2 匿名调用（无租户头）由"返回全部邻居"收窄到 default
  桶——与 atomic/search|delete 同族语义对齐
- **巩固/遗忘租户隔离（H-B2）**：`memory.lifecycle.filter` 可配
  （team/user/agent/task，缺省 undefined=单机旧行为）；混租户同前缀组
  整组丢弃+warn（数据级双保险）；持续态落库补全租户字段
- **已知限制**：neighbors 无 filter 兼容路径下稠密图 BFS 全量遍历仍在
  （仅输出面 clamp）；`agent` 标签转义不覆盖带属性打开标签（逃逸面是
  闭合标签，已覆盖）；迁移期旧记录空租户与新记录混排会被判混租户丢弃
  （保险方向，有 warn）

### 🔧 记忆可信性修复 M3 续（core 租户化，P2-T12）

- **core 两表加归属列（K1）**：`core_memory` / `core_values` 增加
  `team_id` / `user_id` / `agent_id` 三列；CRUD（upsertCore / readCore /
  upsertValue / listValues）全链按租户过滤——身份小本本不再全 agent 共享。
  唯一性由复合唯一索引 `(slot|value_id, team_id, user_id, agent_id)` 保证，
  同 slot 不同租户可并存
- **handler 消费 isolation**：`/v3|/v2 core-memory/read|write` 按
  requestIsolation 过滤（照抄 T14 模式）；/v2 匿名 → default 桶（与回填
  自洽，行为连续）；顺手修 K9：core 写审计的 version 取刚写槽（按租户定位），
  不再误取 readCore 排序首行
- **MemoryProxy 四元组 + 缓存租户键（K-B4）**：`listCoreMemories` /
  `listCoreValues` 透传当前会话 identity 三元组（不再 hardcode default）；
  injector 的 core slots/values 模块级缓存改 `Map<tenantKey, …>` 分桶——
  双租户交替注入不再互相泄漏身份块。**行为变更**：core 注入读从"全局
  同一份"变为"各租户各一份"；多租户实例升级后各租户首次注入为空
  （属预期——各自的 core 各自维护）
- **⚠️ 升级须知（拍板⑤存量回填）**：存量库 core 行（生产 1+6 行）init 时
  自动幂等迁移：补三列 + 回填归属 `<default/default/default>` 并 loud 打印；
  如需变更归属请直接 `UPDATE core_memory/core_values SET team_id/user_id/agent_id`。
  回填 default 与 /v2 匿名桶对齐，匿名读写迁移前原数据不受影响
- 同形验证：`MemoryCore/scripts/verify-p2-t12.ts`（26 断言：全新库隔离 /
  存量迁移回填 / handler 链路 / upsert 冲突目标）；MemoryProxy 单测

### 🔧 记忆可信性修复 第二档（S1/S2 小件清零，2026-09-10）

- **【S1】similar 边门槛配置化**：`memory.links.minSimilarity`（默认 0.3，
  clamp [0,1]）——硬编码转 config-first（T9 裁决待办兑现）
- **【S1】core_values 写 API**：新增 `/v3/core-memory/values/upsert|delete`
  （租户隔离 + label 消毒 + 审计 + 失败 5xx/404）——"agent 可维护价值锚"
  成立；非 default 租户不再恒空（T12 审计 M-5 补齐）
- **【S1】yaml 编码根治**：`tdai-gateway.yaml` 历史上为 UTF-16 LE，
  CWD 加载路径 `readFileSync(utf-8)` 解析抛错被**静默 catch**——配置全量
  落默认值 + 临时密钥（09-10 上午登录断供的真正根因）。已规范为 UTF-8
  （无 BOM），并用网关同款 YAML 解析器验证；**已知限制**：静默 catch 保留
  （文件可选语义），已由 `verify-s1` 端到端断言钉死，loud 化登记后续
- **【S2】缓存键碰撞收敛**：knowledge/meta/skill 三 client 共 6 处
  `${a}:${b}` / `::` 拼接键改 `JSON.stringify([…])` 数组序列化（与
  coreTenantCacheKey 同模式）——分隔符歧义与 ids 逗号歧义（K2）消除
- 同形验证：`MemoryCore/scripts/verify-s1.ts`（41 断言，含真实 yaml 文件
  端到端——文件加载段覆盖）、MemoryProxy vitest 140+ 全过
- **下一轮设计大件**（层级边/coreRef/动机方向/TCVDB 实证/router 调参）：
  待讨论清单见 `docs/superpowers/specs/2026-09-10-soul-memory-next-round-backlog.md`
  （client identity 透传 + injector 缓存租户分桶）

### 🔧 wiki 召回 domainRouter 默认退役（C3，先归档后翻转，2026-09-10）

- **退役依据（隔离实验第三次复现）**：部署工作点（tw09/rel0.6/absGate1.5）
  router 对 posRecall 单变量贡献=0（on/off 同为 0.66, 19/29）、negInjected 恒 +2
  （13 vs 11；复跑 14 vs 12）——锚点
  `docs/superpowers/evals/recall-golden/runs/2026-09-10T04-07-38.json`（翻默认前）
  与 `runs/2026-09-10T04-09-17.json`（默认态复跑），replay 新增配置 E
  （= B minus router，同语料快照成对对照）
- **代码默认层显式退役**：`defaultWikiRecallConfig.domainRouter = { boost: 1.5,
  keywords: {} }`（keywords 空表 = injector 跨库软定域恒 no-op，能力形状保留）；
  注意代码默认此前即"缺省=关"（domainRouter 本就无 enabled 开关），本次是
  把退役状态**显式钉死 + 注释重开协议**，防静默复活
- **config.yaml（gitignore 部署镜像）同步整段注释退役**：本 injector 不读
  `enabled` 字段（只判 keywords 非空），写 `enabled: false` 是静默 no-op——
  退役 = 注释整段，关键词表留档于注释
- **⚠️ W4（boost→归一→注入门耦合）随退役消失**：boost 作用于归一前分数、
  直接受注入门放大。**重开 router 前必须**：(a) 先归档 router-on 实验；
  (b) 先解耦 W4（独立任务）
- 行为变更：升级后未显式配置 domainRouter keywords 的部署不再有跨库 boost
  （对 recall 无影响、噪音 -2）；显式配置 keywords 的部署行为不变（能力保留）
- 测试：`wiki-recall-injector.test.ts` 两条 C3 钉死用例（TDD RED→GREEN）；
  MemoryProxy vitest 全量 149 过

### 🔧 记忆可信性修复 M4（语义补全，P3-T17/T17.5/T15/T16）

- **subject 语义归组（拍板④）**：dedup LLM 调用顺带抽取归一化主题词
  （零额外调用），巩固分组从"前缀 24 字符字符串匹配"升级为
  `llm（默认）→ 词法兜底` 两档策略门（embedding 档登记待做）
  （`memory.consolidation.subjectStrategy`）——
  同义不同表述的记忆现在能归入同组触发巩固（此前结构性不可能）
- **scheduler 行映射根治（⚠️ 遗忘行为变更）**：行映射补全 id 与
  metadata_json 内容（空派生值不再盖真值）。**行为变更**：soul 列为空的
  存量记忆此前按常数 significance=0.5 打分，现在按 metadata_json 真值
  打分——**significance<0.5 的存量记忆归档风险上升、>0.5 更受保护**；
  recall_count 抗遗忘 boost 在真实调度链路真实生效（此前恒死）；
  F4 幂等与 evidence_ids 证据链在真实链路恢复（此前 fixture 验证掩盖）
- **向量健康三件套**：dedup 向量可用性判据改数向量行（元数据行会误导）；
  /health 增 memory 子对象（vectorCoverage/探活/lastVecWriteAt，探针
  embed-only 不写业务表）；召回降级时注入块带
  `[degraded: fts-only]` 标注（两义措辞：向量层降级或相关度门滤除）
- **current_feeling 解冻**：感受块从 session_init 冻结缓存拆出为独立
  每轮注入器（cacheStrategy=none，动态区）——"每轮派生当前感受"首次
  真实生效；core_memory 稳定块保留缓存（cache 友好不变）；补
  chat_memory 资产门控与 identity=null 用例
- **durative 真值**：持续态 significance 从 priority 派生常量 0.8 改为
  组内顶层 significance 真实 max（半数缺值退 0.5 中性）；含 inferred 组
  不巩固（T1 洗白门双保险）
- **结构页降权**：wiki 召回 log/index/schema/purpose/overview/other 页
  权重 0.3 且无 absScore 结构页排尾+`[structural]` 标注（实际排尾集合
  5 类：log/index/schema/purpose/overview；overview 权重项已被排尾
  取代）——log.md 不再以 rank 1-4
  挤占注入位（**部署须知**：MemoryProxy config.yaml 不进 git，换机部署
  需手动同步 typeWeights 4 项；重启 MemoryProxy 后生效）

### 🔧 记忆可信性修复 M1（数据止血，P0）

第五轮对抗性审查（`docs/superpowers/reviews/2026-09-09-soul-memory-fifth-round-audit.md`）
发现的一批数据正确性问题，本批先行修复：

- **H 侧洗白门**：巩固分组入口接 `isObservable`——inferred（推断）记忆不再
  被熬成 certainty="observed" 的持续态（此前凑满同前缀 3 条即可洗白并进画像）
- **C 侧重巩固门收紧**：只放行 certainty="observed"——FTS 路径 certainty 不可见
  时宁缺毋滥整体跳过（此前黑名单式判断放行 undefined，inferred 经 FTS 命中也吃
  抗遗忘 boost）
- **编辑即失忆修复**：`/v3/atomic/update` 现在保留既有行的 soul 8 字段
  （时间锚/情感/可信度，null 透传）——此前编辑一次即被 upsert 刷空，时间锚
  消失导致该记忆永不归档；顺带堵住"编辑 inferred 被静默晋升 observed"的洗白变体
- **recall_count 原子自增**：新增 `bumpRecallCount`（SQL json_set 自增），
  修复"每次回忆计数恒 1、抗遗忘封顶 +10% 永不可达"；损坏 JSON 行显式失败 +
  告警去重，不再静默半写
- **嵌入服务切换**：嵌入套餐额度耗尽导致向量层死亡（09-08 起零向量），
  已切换至新套餐端点并验证恢复（向量重建 + 记忆图边恢复落库）
- **【M2】FTS soul 列迁移**：`l1_fts` 17→25 列（soul 8 字段从主表回填，
  init 幂等自动迁移）——FTS 命中的记忆现在带时间锚/情感/可信度，J 时间窗、
  回忆片段情感标注、auto-recall soul 尾注全通道恢复
- **【M2】边强度真实化**：dedup 路径 similar 边不再使用常量 0.8/0.5，
  透传真实 cosine；FTS-only 不再建假强度边；同批新记忆不再互建边；
  **行为变更**：similar 边新增最低相似度门槛 0.3（与检索门槛对齐），
  strength=0 的假关系不再入库；恢复 FTS 重建补分词（恢复的记忆可被搜到）
- **【M2】生产假边清理**：历史 0.8 假边 227 条已清除（清理前备份于
  `D:/tdai-data/backup/`）；`scripts/clean-fake-edges.ts` 留档（dry-run 默认）
- 全部修复带"同形验证"脚本（`MemoryCore/scripts/verify-p0-t1..t4.ts`，
  测试数据走生产同一条数据流）；行为无破坏性变更，接口签名不变

---

## [2.0.1] — 2026-08-25

### 🚀 支持更多 Agent 客户端

现在无论你用哪款 coding agent，都能直接挂上团队记忆：

- 新增 **OpenCode** 客户端接入
- 新增 **DeepSeek Harness (dsh)** 接入 —— DeepSeek 官方 agent harness 的
  Web UI 会话可直接接入 Proxy，自动获得团队记忆 / skill / 知识注入
- 新增 **Codex CLI** 接入
- 新增 **WorkBuddy** 客户端接入，开箱即用
- 多款客户端的首次引导与重置体验保持一致，切换更顺畅

### 🤖 会话内直接下指令

不用切到面板，在对话里就能完成常用操作：

- 会话中途一键重置绑定（换团队 / 换 Agent / 换任务）
- 对话内直接创建 / 更新任务
- 指令响应更快，减少等待

### 🧠 冷启动开箱即用

- 创建团队或用户即自动生成默认 Agent，无需手工配置
- 管理员可自定义默认 Agent 模板，新用户冷启动自动套用
- 支持从 IDE 里已有的 Agent 一键导入资产，快速起步
- 接入后默认绑定任务，即开即用

### 🔄 会话绑定更稳定

- 会话绑定持久化保存，重启不丢失
- 切换 Agent 后记忆与技能正确跟随切换，不再串场
- 修复部分客户端历史回放被误判的问题

### 🧰 技能（Skill）体验升级

- 会话里新建的技能立即可被检索到，不再有"搜索盲区"
- 恢复技能 ID 的展示与一键复制
- 技能支持在线编辑
- 新增接入向导技能：跟着引导一步步配置，或一条命令自动完成 Proxy 接入

### 🎛️ Memory Hub 面板

- 全新登录页，加入点阵波纹动效
- 团队编辑 / 删除入口整合到团队切换器，操作更顺手、修复切换异常
- 管理员创建账号时可自定义 User_Key
- 新增对话记忆搜索：跨会话的语义与关键字检索，按权限精确控制可见范围；
  支持对单层记忆直接覆盖修改
- 资产 ID 直接展示并可复制；列表完整加载，修复分页截断显示不全的问题

### ⚙️ 一键部署增强

- 启动脚本支持交互式配置，自动预检 LLM 通路与端口占用，避免部署踩坑
- 客户端接入地址一键复制，单机部署下自动解析为宿主机地址，外部客户端可直接连接

### ⚡ 性能优化

- 知识库列表加载提速，常用路径更快响应
- Wiki 页面并发构建，单页失败自动重试，大批量文档导入时间大幅缩短

### 📚 文档

- 按客户端拆分独立接入文档，各 agent 各有一份清晰的接入指南
- 新增面板与 API 使用文档
- 补充英文面板截图与 README 更新

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效、资产较多时记忆 tab 丢失的问题
- 修复导入历史会话时间错乱，恢复原始时间线
- 修复编辑场景时部分内容被重复展开的问题
- 修复 macOS 下部署脚本的兼容性问题
- 修复依赖缺失导致的安装报错
- 修复部分客户端首次引导表单在老版本上的兼容性问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 冷启动开箱即用 · 默认 Agent + 预置 Skill

- 创建团队/用户即自动生成默认 Agent，无需手工配置
- 客户端接入地址一键复制，支持指向 Memory Proxy
- 单机部署下接入地址自动解析为宿主机地址，外部客户端可直接连接

### ⚡ Wiki 生成加速

- 优化 Wiki 生成，页面并发构建，大幅缩短大批量文档导入时间
- 单页失败自动重试，不再拖停整个批次
- 生成进度与单页状态实时可见

### 🧰 Skill 生态

- 新增 Skill 导出功能
- 优化 Skill 检索，私有 Skill 可被检索到，结果更精准
- 优化 Skill 提取能力，捕获范围更广

### 🔀 Memory Proxy · 新增客户端接入

- 新增 Codex CLI 接入
- 新增 WorkBuddy 客户端接入
- 新增 DeepSeek Harness (dsh) 接入 —— DeepSeek 官方 agent harness 的 Web UI 会话
  可直接接入 Proxy,拿到团队记忆 / skill / knowledge 注入;支持 aux 请求短路
  (compaction / title-gen) 与 CLI headless bypass
- 优化 code-graph 资源与工作区的关联

### 🎛️ Memory Hub 面板

- 重构首次使用引导流程，新增 Agent 绑定步骤
- 优化面板交互、加载骨架屏与过渡动效
- 优化 Task 页用户展示名解析
- 优化资产页面布局与归属/共享规则说明
- 修复资产较多时记忆 tab 丢失的问题

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效的问题
- 导入的历史会话保留原始时间，时间线不再错乱
- 修复某些场景下记忆丢失的问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.0] — 2026-08-03

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。新增 Skill 强制归档功能。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。新增定时自动同步代码库功能。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建
- 管理员（System Admin）现在也可使用资产管理功能
- 面板全面支持中英文切换；统一页面设计风格，优化列表交互和分页体验

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性
- Cost Guard 支持为不同 Agent 配置不同模型以降低成本

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 文档

- 新增 CodeBuddy / Hermes / OpenClaw 接入指南
- 更新安装指南中的角色权限说明

---

## [2.0.0-beta.1] — 2026-07-21

首次公开发布。SemVer 从 `2.0.0-beta.1` 起步（npm 包名迁移到 `-v2` 后缀：
`@tencentdb-agent-memory/memory-tencentdb-v2`、`memory-sdk-ts-v2`）。
Docker 镜像 tag 独立于 npm 版本，本次镜像发的是 `:1.0.0-beta.1`。

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

## 2026-09-17 运维：内核 LLM 切换 OpenCode Go GLM-5.3-Flash
- runner 新增 host 作用域客户端标识头（`e4cc31c`）：仅 opencode.ai 端点附加自标识 UA（tdb-memory/1.0）+ x-opencode-session（部署稳定 sha256(baseUrl|model)）；其他模型/供应商零额外头零行为差异（Go 文档客户端要求，防风控）。测试 +4（llm-go-headers.test.ts）。
- 环境配置（config-override.json，仓库外）：llm.baseUrl=https://opencode.ai/zen/go/v1、model=glm-5.3-flash、maxTokens=0；原方舟配置备份于 config-override.json.bak-ark-20260917（回滚：恢复备份+重启）。
- 真实数据验证：vp3 探针租户 3/3 播种→3/3 L1 提取（GLM 真实驱动抽取管线，零报错）；直接端点探针 200（注意：glm-5.3-flash 为推理型输出，带 reasoning_content，max_tokens 需给足）。
- 已知观察：GLM-5.3-Flash 为 flash 档推理模型，抽取/发现质量待长周期观察；对抗身份设定种子由身份提案主语门拦截（L1 记录层保留原文为设计行为）。
