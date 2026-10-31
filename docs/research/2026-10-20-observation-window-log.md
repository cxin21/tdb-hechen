# #77 生产观察窗证据台账（2026-10-20）

> 状态：观察窗进行中。本文件为总验收（口径 B 回归锚+判据核验）引用的耐久锚；随总验收报告一并走授权链入库。

## 窗口开启
- 重启方式：core 单服务 taskkill（runbook ③），watchdog 拉起，restartsUsed=1
- core 新进程 pid=164 StartTime=**20:26:53** > yaml mtime **19:41:53**（三键加载时序证据）
- /health 四端口全 200（core 8420 / proxy 8096 / knowledge 8421 / panel 8123），uptime 与启动时刻吻合

## 基线锚（.tmp-gate/observation-baseline.json，重启前采样）
- work_fact 总 425 / 活跃 420 / 失效 5
- 码点：all max=1283 p90=222 p50=110；活跃 max=647 p90=219
- **>300 码点 28 条（占活跃 5.7%）**
- 水位线 created_time=2026-10-20T12:14:19.305Z（采样时刻）
- **判据分界修正：三键生效分界=重启时刻 12:26:53Z（水位线早于生效点 12 分钟，12:14-12:26 之间的卡属旧进程产物不计入）**

## 观察窗四项判据（总验收口径 B 关联）
1. rejected/skipped 日志：出现首批触发后核验 `conclusion card rejected` 行为（reason+len 附带）
2. 新卡码点：created_time > 12:26:53Z 的 work_fact 全部 ≤300 码点（存量不回填不删除，P1）
3. timeFactor 抽查：ageDecay(halfLifeDays=14)+timeProxFallbackEnabled=true 行为核验
4. 空召回/噪音对照：对照 T4 基线（空召回 59.5%/噪音 77.7%）不恶化

## 三键（MemoryCore/tdai-gateway.yaml）
- recall.ageDecay {enabled:true, halfLifeDays:14}
- recall.timeProxFallbackEnabled true
- lifecycle.reflection.soulProposals.conclusionContract {enabled:true}

## 哨兵安排
- 只读观察哨 .tmp-gate/obs-sentinel.mjs（后台 job pwsh-038aadaf0eef45d1）：每 5 分钟 tail 日志，发现 cards>0 或 rejected 即退出报告；4 小时超时；零写入零注入，DB 仅 readOnly
- 触发节奏实锚：lifecycle-scheduler.ts:196 唯一调用点，10 分钟节拍；rRef=2.0（≈3 条高显著记录）importance 累计未达阈值前 triggered=0 属正常

## 崩溃根因预取证（20:55 二次重启后，只读，供拍板）
- **dedup 阶段=LLM 调用**：l1-extractor.ts:457 setL1Stage("dedup")→:471「dedup 主调同 L1 提取」→batchDedup LLM 判重+:476 候选召回（agent 维度不带 sessionId）→:482 dedupLatencyMs
- **历史先例在册**：l1-extractor.ts:329「2026-10-15 事故：extraction 在 dedup 降级存储段悬挂 43min 全程静默」+:1248 L1-OUTAGE-20261015 breadcrumb（悬挂点=storeAllDirectly 降级路径某条）
- 降级路径存在但慢：:521 batchDedup failed→storeAllDirectly 全存（不丢数据，但等 LLM 超时 300s 才触发）
- **死亡时序**：LLM 端点超时风暴（20:37 起 reasoning_effort 400→60s/300s 超时×N）→dedup LLM 悬挂 200-320s（watchdog 只记不杀 :335）→任务堆积→scene-governor distill 60s 超时→本地 reranker 503→recall 5s 超时→20:55:29 静默死亡（err.log 无 OOM/堆栈；supervisor.log 只记 died）
- **排除项**：SQLite WAL 11MB 正常（锁爆炸假说排除）；watchdog 本身不杀进程（只记日志）
- **死因候选**：H1 任务堆积→内存增长→OOM 被系统杀（err.log 无 heap 输出=存疑）/H2 监督层判定失联 taskkill/H3 原生崩溃（WER 可查）
- 修复方向候选（待拍板，未实施）：A dedup LLM 硬超时+快降级（config-first）/B 任务并发背压/C LLM 端点熔断/D 保守观察（预算剩 1）/E 立 #79 根修票走 TDD

## 死因定性闭环（round 24，只读取证完成）
- **排除清单（证据）**：原生崩溃（Application log 无 WER 1000/1001）；系统 OOM（System log 无 2004 Resource-Exhaustion，20:50-21:10 零错误事件）；Job Object 击杀（start-tdb-supervised.ps1:10-11「was tried and removed: it never fired」）；supervisor watchdog 主动杀（watchdog 仅检测死亡→预算→拉起，无 kill 路径）；tether 触发（无「DSH host is gone」行，supervisor 存活并拉起 32516）；node 自行 fatal（tee.log/logtee.mjs 应用层镜像流=实证可靠通道，20:55:29.807 最后一行仍为正常 DEBUG 写入——skill-conv-worker 循环中，无异常无堆栈无 shutdown 日志）
- **死亡形态=外部强制终止**（taskkill /F 形态）：执行中戛然而止、无任何事件、err.log 运行期静默系已知缺陷（tdb-services.common.ps1:103-115 两代日志缺陷史：-RedirectStandard* 0 字节→cmd 重定向长驻静默→logtee 兜底）——**「err.log 无堆栈」不构成排除证据，tee.log 才是可靠流且同样干净**
- **凶手不可定位**（杀进程无机器痕迹）；候选=运维/诊断工具单发 taskkill（supervisor stop 语义会树杀连 supervisor 一起死，与「supervisor 存活」观测矛盾，排除）/系统级安全或优化软件强杀高资源进程
- **直接前因不变**：LLM 端点超时风暴→dedup LLM 悬挂持续增长（232s→323s→342s）→高 CPU 任务堆积（可能构成外部杀手触发条件）
- **修复对策不依赖凶手身份**：A（dedup LLM 硬超时快降级）治本悬挂——风暴中从「堆积」变「快降级」；B（背压）限并行。E（立 #79 TDD 根修票）符合立票纪律

## round 25 例行（21:40 前后，用户指示：问题先记录最后统一讨论）
- **判据③初步**：tee.log 全程「conclusion card rejected」零行=300 门从未拒卡（few-shot 拆条引导生效，产出全合规；拒收门待更强证据，暂计观察通过方向）
- **风暴未息**：dedup watchdog 持续（21:33:21 354s→21:34:21 414s 峰值→21:37:17 301s），端点间歇性——与 #79 药方（超时可配+快降级）对因
- **第三批卡** 21:34:40 triggered=1 cards=3 proposals=1（判据②累积 9 卡全 ≤300）；32516 存活 CPU 597s
- **待办记录**：用户工作方式指令（m02089）=问题先记录最后整理讨论→goal 轮转静默例行，汇报攒至观察窗判据齐/总验收时点统一给讨论材料

## round 25b 静默例行（21:39 前后）
- **第四批卡** 21:38:00 triggered=1 cards=3 proposals=0——判据②累积至 12 卡（四批全 ≤300 码点，码点核验覆盖前两批 6 卡逐张、后两批按触发行推定待抽验）；风暴持续（21:38:17 dedup watchdog 361s）；32516 存活 CPU 627s

## round 27：三键生效后 golden 观察窗复跑（21:42，只读复放，job pwsh-9ebf6bf708ae4248 exit 0）
- **SUMMARY 权威值**：highValueHitRate=**0.667（6/9）** / strictHighHitRate=**0.75（6/8）**——与缺省基线（09-22/10-31 归档）**逐位一致**；**no red cards**；probe S1/S2 skipped=true（Batch A 剥噪在位）；归档 runs/2026-10-20T13-41-53.json；tmp cleaned
- **口径 B 预验证成立**：三键生效（ageDecay=14d/timeProxFallback=true/conclusionContract=true）下 hitRate 逐位持平=「不低于」判据直接满足，无回归实锤
- **判据③定性**：14d 半衰对 0-7d 库龄（衰减 0.71-0.95）+timeProx 回退未改变命中面=预期内的温和乘子，判据③初步过（更细 timeFactor 证据可在归档 JSON 抽验，总验收时点做）
- 诚实记录：逐轮行粗算（high=7/11）与 SUMMARY 0.667 不符——粗算无效弃用，以 runner SUMMARY/归档 JSON 为权威（expected=high+mid 的召回率口径，逐轮行不含 expected 标注，不能直接加总）
- l1rows=1139（DB 副本时点，较上一基线 1064+新增四批 12 卡演进）

## round 28：判据②闭环——新卡码点逐张一手实证（21:45，readOnly 探针 .tmp-gate/card-recheck.mjs 用后即删）
- **新增行 9/9 全 ≤300**：12:49:11 两张（180/194）+13:18:01 一张（259）+13:34:39 三张（169/225/130）+13:38:00 三张（168/167/165），TOTAL=9 OVER300=0
- **诚实对账**：四批触发 cards=12 但新增行仅 9——第一批 1 张（此前记录 146）、第二批 2 张（171/109）不在「created_time>生效点」过滤内=**走 dedup update/merge 路径更新既有卡**（保留旧 created_time，不新建行）——此系 dedup 正常工作证据而非丢卡；待补查：被 update 的既有行 content 码点是否仍 ≤300（下轮探针）
- 判据②口径收窄定案：新写 work_fact 行 9/9 ≤300 **实证通过**；update 行合规性待补查后判据②完全闭环

## round 28b：判据②补查——update 行发现 1 张超长（诚实记录，绝不删改）
- **探针结果**：重启后被 update 的既有 work_fact 行 3 张（updated_time 12:55:08 同批），**1 张 OVER 351 码点**（m_1792017241926_2d8206）+2 张 OK（117/94，rf_ 前缀）
- **定性分析（两个假设待拍板裁决）**：①m_ 前缀系存量卡，update 前可能本就 >300（基线 >300 占 5.7%=28 条存量之一），300 门按设计只管新增产出不管存量（存量处置=D2 域待拍板）——若如此判据②新增语义仍成立；②若 update 前曾 ≤300 则 dedup merge 内容拼接不受 300 门覆盖=**门覆盖缺口**（#79 候选观察项，gate 只在 reflection 写卡路径、dedup update 路径无门）
- **纪律执行**：零删改（P1+处置权归用户）；该行留证 record_id=m_1792017241926_2d8206 供拍板后处置
- **判据②最终口径**：新增行 9/9 ≤300 实证通过；update 行 1/3 超长系存量触碰或门缺口待定性——不阻塞观察窗，列入讨论包拍板点

## round 29：351 行定性收束（m_ 前缀=l1-writer capture 管线 id 生成点）
- **锚点**：l1-writer.ts:209（return 模板串 m_+Date.now()+randomBytes=capture/L1 提取产卡专用）；reflection.ts:264 rf_=反思卡专用——**两路 id 前缀分离**
- **时间戳定性**：m_1792017241926 ≈ 2026-08-21 诞生（capture 管线产卡，当年无 300 门——validateConclusionCard 仅接 reflection.ts 写卡路径）
- **结论**：351 行系**无门时代存量卡**今天被 dedup update 触碰；判据②新增语义成立（新增 9/9 合规不受影响）；「update/merge 路径长度治理」列为 #79 候选观察项；存量处置归 D2 域待拍板
- 诚实边界：update 前值无历史表不可恢复，定性止于「无门时代存量+触碰」层面；若拍板 #79 可在合同阶段做 update 语义代码级审计

## round 30：判据④前置对照——三键复跑归档完整指标（只读 runs/2026-10-20T13-41-53.json）
- **emptyRecallRate=0**（vs 06-11 归档 0.111——golden 复放口径内改善；T4 活体 59.5% 的对照需口径 A 采样，总验收时点做）
- **highValuePrecisionProxy=0.182**（vs 06-17 归档 0.3、09-22 复跑 0.188——继续下行）诚实归因：memoryRowsReturned 33（vs 20）行数增长摊薄+DB 数据自然演进，与代码行为无关（同 Batch C 复跑先例口径）；判据④的「噪音对照 77.7%」待活体采样
- perf p50=2442/p90=2469 稳定；scaffoldProbeSkipped 2/2；mixedRaw 8 轮 overlap 全满
- **判据④初判**：golden 复放口径内无空召回回归（0 vs 0.111）；活体口径对照待总验收

## round 32-34 例行与虚惊修正（21:59）
- 第七拍 21:58：trig_total=6 无新触发、rejected 零行持续 ✓
- **ws=0MB「疑点升级」判断撤回**：复观测 pm=0/threads=0 同归零而 /health uptime=3882s 与 32516 启动时刻精确吻合+supervisor 无新 death 行+tee.log 持续新行——真因=非提升会话读提升进程（用户管理员终端重启）的 ws/pm/threads 计数器返回 0（CPU 时间可读），非内存压力非 zombie。教训：单点进程计数器不作生死判据，/health+supervisor.log+日志新行三准绳并取
- Get-Process node 列空同属读法受限；restartsUsed 仍 2/3

## round 35：第六批核验（22:02）
- 第八拍三准绳：/health ok uptime=4008s、supervisor 无新 death、trig_total=7
- **第六批 21:59:21 triggered=1 cards=3 proposals=1**；判据② readOnly 探针（.tmp-gate/card-recheck-6th.mjs 用后即删）：FRESH 3 张 rf_ 卡码点 **150/163/133 全 ≤300** ✓+TOUCH 0（本批无 update 触碰）；累计新增行 12/12 全合规
- 附带发现：m_1792504661696_07e0cb40（capture 管线 14:01:30 产卡）155 码点亦 ≤300——L1 提取链原子性规则在位的旁证
- rejected_total=0 持续 ✓

## round 36-38 例行（22:02-22:07）
- 第八~十一拍：/health ok（uptime 4008→4279s）、supervisor 无新 death、rejected_total=0 持续 ✓
- 22:06:37 拍=**空转**（triggered=0 cards=0）；诚实修正：曾误判为「第七批触发」——trig_total 计数含空转拍（triggered=0 也占行），探针 fresh=0/touched=0 佐证自洽；累计产卡口径不变=六批 15 卡（新增行 12/12 全 ≤300）
- 探针教训重申：先读触发行确认 cards>0 再跑抽验，不凭 trig_total 计数预判

## 时间线
- 20:28 / 20:38 两拍 triggered=0（正常，阈值未达）
- **20:49:11 首批自然触发**：`reflection triggered=1 cards=3 proposals=3`（importance 累计达 rRef=2.0）
- 20:51 判据②核验（readOnly 探针 obs-card-check.mjs）：新 work_fact 卡 3 张（12:49:11Z），码点 **180/146/194 全部 ≤300，JUDGE-PASS**（基线活跃卡 max=647、>300 占 5.7%——粒度提升实锤）
- 判据①：`conclusion card rejected` 零行——3 卡全过 300 门（few-shot 拆条引导下 LLM 产出即短卡；门的机械行为证据=测试 13 用例，生产行为=全过）
- 探针脚本 .tmp-gate/obs-card-check.mjs / obs-sentinel.mjs 用后即删（哨兵 job pwsh-038aadaf0eef45d1 检测到触发后自行退出）
- 待办：判据③ timeFactor 抽查、判据④空召回对照（属总验收范围）；总验收口径 A 活体标注 n≥30 待自然流量积累（预估 1-2 天）

## round 39：第七批核验（23:15）
- 例行三准绳：四端口 200（core uptime 2845s）、supervisor restartsUsed=0（pid 32200，22:31 全量重锚起）、REJECTED=0 持续、**DEDUP-FALLBACK=0（#79 修复后 dedup 降级零发生）**
- **第七拍 23:02:28 triggered=1 cards=2 proposals=0**（真·第七批；与 round 36-38 所述 22:06 空转误判相区分）
- 判据② readOnly 探针（.tmp-gate/card-recheck-7th.mjs 用后即删）：FRESH 2 张 rf_ 卡码点 **139/188 全 ≤300** ✓；累计新增行 14/14 全合规
- TOUCHED-UPDATES 2 张（updated_time 15:09:49Z 同批 dedup update）：m_1792489354343_67bfeadf（created 09:45 capture 管线，**524 码点超长存量行**——与 351 行同类「无门时代存量+触碰」定性，零删改留证）+ rf_1792502281803_ar69bh（13:18 反思卡 259 OK）；超长存量处置统一归 D2 域拍板 B（总验收后归档留证）
- 时序说明：update 时点 15:09:49Z=23:09 本地，介于 23:02 触发与 23:12 空转拍之间，与第七批新增 2 张（created_time=15:02:28Z 精确对应触发拍）无冲突

## 口径 A 总验收（23:40–23:58，用户 m02487 拍板后立即执行）
- 回放：.tmp-gate/acceptance-a-replay.mjs（本会话 32 条真实工作 query × maxResults=5，DB 副本+临时网关 8423，零跳过零报错），归档 acceptance-a-replay.json totalRows=370。三跑修复链：yaml 裸名 ESM（第三次同坑）→createRequire 修复；DatabaseSync TDZ 残留行→删除修复。
- 标注（T4 口径，逐条亲读 370 行）：high=31 mid=14 low=23 none=302 → **主口径高价值率 45/370=12.16% ❌ 未达 40% 判据**。
- **压倒性发现=新病灶⑤ strict_rule 常驻霸位**：每条 query 前 8 行=相同 8 条 strict_rule 红线记忆（soul-event 红线重申被 capture 持久化为 L1 instruction），霸位 256/370=69.2% 全为 none。剔除后副口径 45/114=**39.47%**（vs T4 26.5%，+12.9pp，Batch A–D 合力真实有效）。
- query 级覆盖 24/32=75%；零命中 8 条全为函数/参数级问题（q03/q10/q11/q15/q21/q23/q27/q31）。
- 判据 B 已过（三键复跑 0.667/0.75 逐位+no red cards）；判读=按计划开下一轮票：**#80 已立**（霸位治理：capture 侧拦截治本 or 召回侧去重帽治标，软失效/召回面过滤守 P1）。
- 产出：docs/research/2026-10-20-acceptance-a-labeling.md（81 行，含逐条台账+渠道披露+诚实边界）；待用户抽样复核 ≥10 条。

## #80 定性反转与方案交付（2026-10-21 07:02–07:40）

- **触发**：m02581 用户拍板「针对 #80 给最优方案，先分析之前为什么这样设计」。
- **定性反转**：原票「capture 持久化+检索霸位」证伪——8 条红线在 l1_records 零命中、instruction 49/49 全失效；红线真身=recall 响应身份段（SOUL C3 设计内常驻，core_memory.strict_rule 槽 version=14/14 条，渲染单一源 soul-redline-render.ts #52 P1）。三快照：探针 8 / soul-event 12 / 槽 14（渲染端去重差异=观察项）。
- **复算实证**（acceptance-a-replay.json 32 query 只读）：totalRows=370、strict_rule 行=256（每 query 恒 8 条、恒前缀连续块=机械判据）、检索段=114、修正口径 45/114=**39.47%**。
- **方案**：docs/research/2026-10-21-f80-plan-identity-section.md（65 行，考古三链+M1-M5+拍板点 P1-P4）；M1 口径修正/M2 分块解析/M3 maxLines 维持关/M4 #80 勘误/M5 红线槽去重（须用户拍板）。
- **预备**：勘误评论文本 .tmp-gate/gh-80-correction.md（22 行）已落盘待发。
- **状态**：方案卡已交用户，等拍板 P1-P4；未实施。



## P3 红线槽近似合并实施（2026-10-21，#80 用户拍板「相似→更新而非新增」）

- 考古定案：机制在位但域不对（proposalSimilarity 只用于 pending 闸门）；悬置记录在案（proposal-dedup.ts:9-12「更激进的语义合并属 P0 存量清理，逐项呈报拍板后执行」）；实测真重复对 L1×L2=0.508、L4×L10=0.459 均低于 0.75 闸门阈值、次高对仅 0.097=孤立相似峰 → REDLINE_MERGE_THRESHOLD=0.4（安全边距 4 倍）。
- TDD：RED 5 failed/9 passed（全因相似合并未实现）→ GREEN → 单文件 14/14 → 三门 core 232f/2077t 全绿（+8 对账）+proxy 47f/368t 全绿+typecheck 243 守恒（本批命中 0）。
- 存量清理（两包门全绿后执行）：strict_rule 槽 14→12 行（version 14→15），merge-replace ×2（sim 0.508/0.459），写后逐字比对 mergedByteEqual=true、alienRows=0，备份 .tmp-gate/strict-rule-slot-backup-*.json；写回脚本 .tmp-gate/p3-fold-apply.mjs（precondition 漂移即拒绝）。
- 增量语义（mergeStrictRuleContent）：全等幂等保持→相似≥0.4 取最高 sim→采纳行码点更长原位替换（更新）否则旧行保留→不相似追加（V12-ADJ 语义不变）；

## P3 增量合并活体实证（2026-10-21，用户指令「用真实数据测试一下」）

- 方法：生产 strict_rule 槽 12 行真实文本（readOnly 拉取，version=15）+ 生产真实函数 mergeStrictRuleContent（node --import tsx 直跑 src/gateway/pending-adopt-merge.ts）+ 完整采纳链 O13 同构落在 .tmp-gate 副本 DB（零生产写入，探针用后即删）。
- 结果四场景全 PASS：A 相似→更新（L1 真实行 vs 更长变体 sim=0.646≥0.4 → rows 12→12 原位替换、更新而非新增）；B 全等→幂等（逐字节一致）；C 不相似→追加（真实客开规范 sim=0.000<0.4 → 12→13 尾部追加）；D 完整采纳链落库（副本 version 15→16、rows 12→13、重复采纳幂等=行数不变）。
- 诚实披露：探针 A 场景「旧行消失」子断言写歪（长变体以短版为前缀，includes 必 true），但结论不受影响——判据=行数不变+原位替换+新句在位；A/B/C/D 主判定均以行数与位置证据为准。
- 边界澄清：本实证覆盖「采纳端」增量（panel-adopt 时 mergeStrictRuleContent）；「生成端」防重复机制=identity-discovery 生成提案时携带 redlineExisting 上下文（未改动，考古记录在案）。

## #76 Batch B F2 生产翻转与观察窗（2026-10-25，拍板「按最优方案」）

- 拍板执行：Q1 `truncateMode: sentences`、Q2 `maxTotalChars: 2000`（数字面量；B2b golden 实证：注入字符 -38%、高价值率 0.778 持平、p50 不升）；Q5 跨层配比不加码。生产 yaml `MemoryCore/tdai-gateway.yaml` conclusionLayer 增两键，删两行即回滚。
- 门 4 补做：只读独立对抗审查 PASS-with-notes（vitest 65/65 对账 63+2；da466b9 纯新增、scene-governance 复用面零触碰；19 项对抗探针全 PASS；1 Low + 3 Nit 不阻塞——Low= maxTotalChars<结论行数时 floor=0 判关跳过截断，触发需 maxResults≥2×maxTotalChars，后续 clamp≥1 候选）。留证全文见票 #76 评论区。
- 观察窗：自网关重启生效后起算，7 天回收 skipReason/注入字符/命中率，对照 B2b 基线；达标关票 #76，命中率异常按 Q2 放宽 6000~8000 定标。

## #79 A1+A2 受控实证（2026-10-25，拍板「补配 yaml + 受控制造判重端点超时」）

- 环境：本地临时实例（端口 8431/数据目录 .tmp-gate/dedup-storm/，生产 8420 pid 34932 未动），测试 yaml dedupTimeoutMs=60000（clamp 下限加速观察），判重 LLM 悬挂 mock（按 systemPrompt 特征串分流：提取→罐头 2 条记忆/判重→永不响应/其余→中性）；mock-llm.mjs、gateway-test.yaml、run-storm.mjs 与 out.log/err.log/mock.log 全套留存 .tmp-gate/dedup-storm/。
- 证据链（2026-10-25）：判重 LLM 00:43:48.365Z HANG（warmup 阈值翻倍后第 4 轮 capture 才带候选触发完整判重，前 3 轮快路径/未达阈值不调 LLM）→ +60.007s 客户端 socket 断连（AbortSignal.timeout 量纲=配置值 60s，≠ llm 缺省 120s、≠ 旧缺省 300s）→ +1ms err.log 降级 warn（内层 catch：「Batch conflict detection failed, defaulting all to store: The operation was aborted due to timeout」；外层「Batch dedup failed, storing all as new」仅召回/解析抛错才触发，纯超时场景不出现）→ +8ms [l1] L1 complete: extracted=2, stored=2 流程继续 → l1_records 回读 4 行（第二代 2 条与 warn 同毫秒按全存新落库，零丢失，mgl_l1_succeeded_*）→ 降级后 POST /capture 与 /health 均 200。
- 生产对照：两份 yaml（MemoryCore/tdai-gateway.yaml 活体版 + deploy/tencent-cloud/…cloud.yaml）已补 dedupTimeoutMs: 90000；活体版需网关重启生效，cloud 版待部署；真实风暴继续以 DEDUP-FALLBACK 计数/err.log 口径长期观察（round 39 基线 DEDUP-FALLBACK=0）。
- 备注：本地 FTS 检索 /search/memories 查「张三」返回 0（strategy=fts）为独立检索话题，与 #79 无关。


## #79 生产重启生效记录（2026-10-25 08:57）

- 生产网关重启：8420 监听 pid 34932 → 29832，新进程 2026-10-25 08:57:23 启动；MemoryCore/tdai-gateway.yaml:64 dedupTimeoutMs: 90000 随本次启动加载（进程启动晚于 yaml 写入 08:08:32，mtime 2026-10-25T00:08:32.866Z 佐证），A1 配置化在生产生效。
- /health 复核：200 正常。
- 观察口径不变：盯 err.log「Batch conflict detection failed, defaulting all to store」降级行与 DEDUP-FALLBACK 计数（round 39 基线 0）；#79 以受控实证（拍板口径 b）+ 生产配置生效关票，自然风暴长期观察为非阻塞跟进，cloud 版 yaml 随下次部署生效。


## #76 观察窗回收（2026-11-01 01:32 CST，顺延）

- 回收点：schedule-9281c35a 提醒触发（occurrence 2026-10-31T17:32Z）；数据口径=生产 journal team-2k12lgb650/agt-2m7buribzz 全量 379 条（ts 2026-10-23T05:41:39Z→2026-10-31T17:32:44Z）。
- 生效起算：EFF=2026-10-26T00:56:55Z（翻转后首次网关启动 2026-10-26 08:56:55 CST）。pre 119 条 / post 259 条。
- 读数：pre hit 98.3%、charsAvg 2628、结论行 p50 1042 / p90 2027、截断标记 76；post hit 95.0%、charsAvg 1127、结论行 p50 252 / p90 448、句末标点 315/315、截断标记 0、每卡结论 {0:52,1:75,2:99,3+:39}、smallToBig 上下文行 129。
- 决定性判定：317 条 post 结论行按 perLine=floor(min(2000/n,2000)) 核，0 条越预算 → **F2 dormant（窗口内从未触发）**；chars -57% 混杂 #99/#78/#134/#135/#138 与卡片重蒸馏，不可归因 F2；hit 95.0% vs 98.3% 以构成变化为主（52 条零结论、13 条空召回）。
- 异常：11-01 00:29–00:39 LLM Token Plan 配额耗尽（2067）→ recall 超时 ×5 → core 死亡 → watchdog 00:39:10 重启；yaml mtime 01:32:56 外部写入未溯源（内容完整）。
- 三档现状：本地 :251/:255 两键在；base:309-310、cloud:263-264 两键在（2026-11-01 production-profile 登记）。
- 处置：未满 7 整天 → 顺延；收口日 2026-11-02 08:56 CST 后复核，若仍 0 触发按「生效+实证 dormant+无劣化」关票并记 dormant 结论；提醒重排 11-02 09:00。Low 项（floor=0 判关）待另票。

