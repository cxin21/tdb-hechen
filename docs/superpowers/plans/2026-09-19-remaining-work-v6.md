# 未完成待办台账 v6（REG-REMAINING-006，2026-09-19）

> 取代 v5（2026-09-16-remaining-work-v5.md）的**待办部分**；v5"不做项"判定与 O1-O6 观察继承有效。
> 来源：2026-09-19 设计↔代码↔真数据三方交叉审计（33 项：✅22 / ⚠️8 / ❌3，报告见 `2026-09-19-soul-audit-report.md`；HEAD 1d8b19e，运行代码 1d03a37）。
> 执行纪律：TDD（RED 先行）→ 补丁（锚点唯一+读回验证）→ tsc 222 基线持平 + vitest 617+ 全绿 → CHANGELOG 同步 → 密钥扫描 → `sudo -H -u tdai git` commit/push → 重启 → 真数据验证。
> **进度（2026-09-19 批次一）**：A-1（F-EV12-1）/ A-2（F-EV12-2）/ A-4（F-EV12-4）已修复——vitest 617→623 全绿、tsc 222 基线持平，CHANGELOG 已登记；批次 1.5 = A-2b 结论层缓存键硬化（vitest 624）；批次二 = A-5 三处不对称修复 + A-3 勘误改判非缺陷（B3 裁决 sqlite.ts:1951）+ A-6 spec 同步（vitest 627）；批次三（ev13 重放轮）= A-7 F-EV13-1 措辞断链修复（identityFactMatchesCorpus 单一源 12 字滑窗，四消费面统一；vitest 636）；批次四（ev13 重放验证）= LLM 换套餐（ark）重启恢复 + ev13 4 会话 22 条 user 消息全流程通过（提取 23 条 L1、身份门活体拦截 2 拒+红线 pending、张三/小七 p- 锚+周报/脱敏 theme 锚落库、F-EV13-1 修复后 identityRefs 回填 0→2、注入块四段+对抗零渗漏+跨租户隔离）；UI 视觉实测 blocked（session 无 browser provider），人工清单见 A-8
；A-3 / A-5 下一批；B-2 真数据重放待 LLM 配额重置。

## 数据门槛快照（2026-09-19 10:5x 实取）

| 项 | 读数 | 门槛 | 状态 |
|---|---|---|---|
| judge 标注 | 367（09-17:75 + 09-18:75 + 前期 217） | ≥300 且 正例≥50 | 总量已过；**正例数待核**后 D2 可拍板 |
| conflict 边 | 1（09-18 清理后回厂） | ≥5（P4b） | P4b evolution 已于 09-17 live 轮启用（yaml evolution.enabled=true），本门槛关闭 |
| derived_from 边 | 349（**其中 349 条悬空**，见 A-3） | — | A-3 治理对象 |
| similar 边 | 171（悬空 13） | — | 同上 |
| L1 / FTS | 311 / 功能召回四词全命中 · quick_check ok | — | 健康 |
| 门禁基线 | vitest 617/617 · tsc 222（存量类型债，D-R5-2 尾） | 持平或更优 | — |
| LLM 供应商 | OpenCode Go 周配额耗尽（~1 天重置） | — | **真数据验证轮阻断**，重放步骤见 B-2；embedding=ark 正常 |

---

## A 真正要做的（本轮，按序执行）

### A-1 · P0-A（高危）F-EV12-1：L1 提取 LLM 失败→游标照进→该批 L0 永久丢失提取机会
- **背景**：2026-09-19 journal 10:17:45-49（ev12 四会话）与 10:20:45-57（default 会话 10 条）实证：LLM 周配额耗尽时批次报 "LLM extraction failed… Weekly usage limit reached" 后仍打 `markL1ExtractionComplete extracted=0, cursor=…` → "L1 complete" → 游标越过该批消息。供应商故障期内**全部对话记忆静默丢失**（当前配额死一天即全天生效）。
- **原因（file:line 实证）**：`l1-extractor.ts:229-232` LLM 失败被 catch 吞掉返回 `{success:false, extractedCount:0,…}`（不抛错）；`pipeline-factory.ts:642-664` 无条件消费结果并 `markL1ExtractionComplete(sessionKey, totalStored, maxRecordedAtMs)` 推进游标；**`L1ExtractionResult.success`（l1-extractor.ts:75）从未被工厂消费**；外层 catch（pipeline-factory.ts:670-673）因此不可达。
- **设计思路（第一性）**：游标语义=「已确定提取成功的消息边界」。失败批次推进游标违反语义。修法（单文件 pipeline-factory.ts ~15 行）：组循环累计 `extractionFailed = l1Result.success === false`；批次结束时若 failed：①**跳过 markL1ExtractionComplete**（游标不动→下次对话触发 everyN=5 / l1Idle 600s / boot L1_drain 自愈重试，c35a3e6 机制在位）；②返回 `hasMore=false, hasFullBacklog=false` 压平续批——pipeline-manager.ts:777-781 `hasFullBacklog→enqueueL1 立即重入队`，不压平会在配额死期形成重试风暴；③error 留痕（session/ stored/ 原因）。多组批部分成功：已存组产出保留（重提取由 extraction.enableDedup 兜底）；`processedCount=0` 诚实口径（warmup 阈值不推进）。**更优方案评估**：按组粒度游标更精准，但需改 checkpoint 游标结构（大手术、双写风险）——否决；整批不推进=简单/安全/dedup 覆盖。
- **验证**：RED golden（stateful-pipeline-drain.test.ts 家族：fake runner 返回 success:false → 断言 checkpoint 游标不变 + hasMore/hasFullBacklog=false）→ 修复 GREEN → 全量门禁 → 真数据重放（B-2，配额恢复后）。

### A-2 · P0-B（高危）F-EV12-2：E3 session-reuse 缓存跨租户污染
- **背景**：活体复现——A桶（ev12-user-a）10:25 召回「代码审查 负责人」后，P桶（ev12-user-p）10:29 同 query 得到 **A桶 5 条 persona 记忆**（meta.sessionReused=true）；换任意其他 query 实时检索则隔离正确（P桶-b/Q桶 空）。实时检索路（rowMatchesIsolation）无恙，唯缓存路击穿。
- **原因（file:line 实证）**：`auto-recall.ts:161` `sessionReuseCache = Map<sessionKey, Entry>`；get `:528` / set `:596` 均以 `params.sessionKey` 单键；命中条件 `:529-530`（同 query + TTL + 同实例）**无租户维度**；`/v3/recall` body 缺 session_id 时 sessionKey 恒 ""（v2-router.ts:1634-1638）→ **全员共享一个缓存桶**。v2-router 注释宣称"空 sessionKey→通道退出"仅在结论幂等层实现，检索复用通道无此守卫。生产 MemoryProxy 走同端点瘦传输，若 body 未带 session_id 则全代理面暴露。
- **设计思路**：①空 sessionKey 直接退通道——get（:527）与 set（:595）双侧加 `params.sessionKey` 真值门（与 v2-router 已宣称语义对齐，/v3/recall 无 session_id 场景零缓存）；②缓存键并入租户三元组（`isolationFilter.teamId/userId/agentId`，params 字段已存在 :362）——防未来同 sessionKey 字符串跨租户碰撞。E3 原语义（**同租户**同 session 同 query 复用）完整保留。
- **验证**：RED 两用例（recall-perf-cache.test.ts E3 组：跨租户不复用 embedCalls=2；空 sessionKey 不复用 embedCalls=2）→ 修复 GREEN → 门禁 → 活体复测（与配额无关，立即可做：A桶召回→P桶同 query 期望空块）。

### A-3 · P1-C F-EV12-3：悬空 l1_links ——【批次二改判：非缺陷，撤销治理】

- **改判依据（第一性复查）**：sqlite.ts:1951-1954（审计 B3 裁决）明确归档不级联删边是有意设计——边指向 l1_archive 可解析（getL1ByIdsWithArchive 证据链），ghost=0；「悬空=0」正确口径=两端均不可解析。原审计 #27 口径（l1_records 缺失即悬空）误判，已勘误（见审计报告勘误段）。级联删边/gc 方案撤销（会断证据链、误伤 dedup 时序）。附带观察登记：neighborExpand 重开前需拍板归档节点回流注入面问题。

### A-4 · P1-D F-EV12-4：reflection.rRef clamp 下限 10 → 1
- **原因**：`config.ts:1034` `Math.max(10, …)` 使 yaml `rRef: 2`（注释意图"2.0≈3 条高显著记录"）被静默钳到 10——配置值与生效值背离（审计 G-31 发现）。
- **设计思路**：clamp 下限改 1（rRef 语义=significance 累计阈值，[0,1] 刻度下 1~2 均为合法意图值）；补 config 解析断言（yaml 2 → parsed 2）。
- **验证**：config 单测 RED→GREEN；重启后 journal `[lifecycle] reflection triggered=…` 口径回归。

### A-5 · P1-E F-EV12-5：character 池三处不对称
- **原因（file:line）**：①维护循环（anchor-growth.ts:327-353）无 character 分支——品格锚被 theme 口径 `recountEvidence(label)`+theme minEvidence 重算，与采纳口径（characterEvCount 事实切片，:568-570,721-728）错配→可误退；②quotaEvict 仅 theme/person 两池（:391-394）——character 无超限回归守卫；③soul-assembler.ts:68 仅排 person——character 锚可进"价值锚"行，且 derive 获 ±1 valence 后渗入 soul-feeling（:122），疑违 §2.7"感受段仅主题锚"。
- **设计思路**：①维护分支：character 行用 `characterEvCount(factSlices, corpus)` + `cfg.character.minEvidence`（factSlices 取自现行 self_identity 槽，与采纳同源）；②quotaEvict 增 character 池（maxTotal=cfg.character.maxTotal，evOf=characterEvCount(factSlices)）；③soul-feeling directional 过滤收窄为 `node_type 缺省 theme`（价值锚行保留 character——§7"与主题锚共享注入预算"）。
- **验证**：anchor-growth.character.test.ts 增补维护/守卫用例；soul-assembler.test.ts 增感受段过滤用例。

### A-6 · P1-F 文档同步（铁律 7：文档-代码不分离）
- spec `2026-09-17-soul-memory-design.md`：①§2.8 调度顺序补 C1 实况注记（forgetting=pass 末尾，ev8 实证）；②§2.2/§2.5/§3/§7 的 "metadata.agentAct 标注" 改注"prompt 视角已接线（l1-extraction.ts AGENT_ACT_BLOCK）；metadata.agentAct 字段未实施——P3 spike 定案占比 0%，聚合源=self_identity 槽（§7 fallback 已执行）"；③§2.7 补 character 渲染口径一句（价值锚行共享/感受段仅主题锚）。CHANGELOG 登记本轮 A-1~A-5。

---

### A-8 · UI 展示与规范实测（MemoryPanel 8123）——【已完成 2026-09-19 晚，浏览器实测】

- 已降级验证：panel active + `/` 200（Memory Hub Vite 正常）；UI 数据源形状全就绪（slots 双槽/values node_type+attrs_json/分池 state——DB 与 /v3/recall soul 块活体已证同一数据渲染路径）。
- 待人工/有浏览器环境实测清单：① ChatMemoryPage 身份区（identity/self_identity 槽只读展示+version/source 徽标）② ValueAnchorsPanel 类型徽标（人物/主题）+ 分池配额迷你显示（theme15/person8/character8）+ 行内 role/aliases 编辑 ③ 记忆图 personRefs 青紫色标+图例 ④ S2 灵魂区 personRefs/identityRefs chips ⑤ 视觉美观与 UI redesign spec（2026-09-10）符合性。发现问题按 TDD 修复推送。
- **实测结果**：U1 身份区 ✓（我是谁/我心中的他 渲染）· U2 类型徽标 ✓（人物/主题活体）· U4 反查按钮 ✓（🔍 关联记忆 每行）· U3 pending 区 ✓ 组件接线 · **U7 分池配额回归已修**（活体 DOM：「主题 15/15 人物 1/8 品格 0/8 敏感度（待拍板）」）· 存量构建破损与 tsc 债 3 错修复（112/112 持平）。美观度（Vision 评）：简洁专业/蓝白协调/无重大布局缺陷；右侧空旷小瑕疵登记。

### A-7b · F-EV13-1 残余缺口：摘要式改写超出演算面（设计级，下一批）

- ev13 二轮实测：12 字滑窗对「句式重组型改写」（代词替换/标点差异散布全句，如『带其开』vs『带用户开』）仍不命中——GROW-MAINT unsupported=2 中含残余假阳、守诺式提案在 minEvidence=3 下可能拒采。
- 长期解（方案 B，spec 附录 A 引用纪律同型）：identity-discovery 提案协议增补**支撑样本指针**（LLM 输出支撑样本编号 → 校验后在样本窗内 → identityRefs 记 record_id 引用；GROW-MAINT=引用行仍 active 即支撑；F14 保护=引用行在即保护）——确定性、精确、无字面依赖；触及 prompt 协议与 ref 语义，单独一轮 TDD+对抗审查实施。

## B 等门槛 / 环境

| # | 项 | 门槛/条件 | 动作 |
|---|---|---|---|
| B-1 | D2 产线替换 | **门槛已到（2026-09-19 核对）：总量 367≥300 ✓，正例（rel=1）82≥50 ✓**（另有 rel=2:28/-1:160/0:97） | 待用户拍板启动预注册 A/B（calibrate-fit.mjs 扩特征 → 预注册判据 → A/B → yaml rerankWeights 先高系数通道逐步解禁） |
| B-2 | **H 组真数据重放**（审计 #33 补闭环） | LLM 配额重置（~1 天） | 重置 ev12 四会话 `last_l1_cursor`（checkpoint runner_states）或重投 32 条种子 → 完整对抗验证：身份门四道拦截面/张三人物锚 p- 前缀+attrs/周报主题锚/character 锚（A-5 修复后）/跨用户隔离/E3 修复后复测/agentAct 记忆占比 → 补审计 #33 判定 |
| B-3 | D-R5-2 尾债 4 错（adapters 存量类型） | 运行时正常（审计复核） | 择机，随依赖升级治理 |
| B-4 | 继承 v5 | — | D5 R10 A/B（cohort≥20）· P4a Phase 2 重蒸馏 · D7 recordIds 索引（L1≥5k）· skill-conv-worker 重试退避（F-EV12-6，低） |

## C Gated（待用户拍板，勿自行执行）

- 测试数据清理：ev12 种子（32 L0）+ 老化夹具 2 条 + 旧 ev*/ta-team/xtest 租户八表（铁律 6：删除必拍板）。
- D2 预注册 A/B 启动拍板（门槛已到，读数见 B-1）
- P3 sensitivity 拍板 · selfIdentity.intervalHours 1→24 回归（yaml 自注"验收后回 24"）· anchorDiscovery.maxPerPass 3→2 定格（yaml:159 演示值）· T7b Claude Code 场景实测。

## D 不做 / 关闭（继承 v5 + 本轮关闭）

- 审计 ✅ 22 项全部关闭（含 F20/F14/F12/F11/F19/身份门四道/蒸馏门/scene 门/调度互斥等）。
- metadata.agentAct 字段化：**不做**（P3 fallback 代偿，A-6 文档化收口）。
- v5 不做项继承：窗口全量消费、运行时 persister、executor 去重整体移除。
