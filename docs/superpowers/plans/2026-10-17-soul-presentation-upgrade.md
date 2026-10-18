# 灵魂注入呈现层升级与收口（2026-10-17 两日授权）

## Goal

用户判定当前注入「乱、像调试输出」；两天内把灵魂注入推进到生产级可用并验收。定谳：代码层六属性三时机已在 HEAD 4c46f55 全量落地（非首期骨架），欠账=呈现债+集成门禁。本计划收口七件事：①soul-feeling 数值直出→叙事化 ②「我能做什么」段整体摘除（m00265 用户拍板；config-first kill switch，重启后不再渲染）③承诺块注入面（未来性）④#42 shadow 定标落盘 ⑤#27/#44 激活实证 ⑥全量门禁+集成重启+live E2E 四段 ⑦报告落库。

## Architecture

- 注入链：proxy 收到 /v1/messages → 调 core auto-recall → `buildSoulPrefix`（soul-assembler.ts，进程内 cache 100，cacheKey=fnv1a32(soulVersion+state+scorer 签名)）产出 `<soul-identity>`（静态人格区：self_identity/identity 双通道+价值锚）与 `<soul-feeling>`（当下性区：状态行+首要形态）→ proxy 侧 TdaiCurrentFeelingInjector / TdaiSoulRedlineEventInjector（红线=tools.before_call 近端）/ TdaiToolCapabilitiesInjector（能力段）各自挂点注入。
- 本计划全部改动在 MemoryCore 渲染层（soul-state.ts / soul-assembler.ts / tdai-tool-capabilities.ts / soul-anchor-scorer.ts）与部署 yaml；不改存储 schema、不改 D8 判定语义、不动红线通道。

## Global Constraints（违反任一即打回）

1. 真实性硬边界（ADR0003）：不伪造当下体验；「因为…」归因仅当存在真实事件记录，无可归因事件则静默省略该从句；红线不软化。
2. config-first：一切新行为缺省关（`enabled:false` 或 mode=旧值），部署 yaml 侧才打开；改 config 需重启生效，合并单次重启。
3. TDD：每个任务先写失败测试（RED 亲见失败且因正确原因）→ 最小实现 → GREEN → 全量相关套件。实现侧（含子代理）禁自行 commit（红线）：任务完成后 send_message 报告，主代理审查 diff 后统一 conventional commit。
4. 零删除注入内容：信息通道不消失，只改形态/位置（数值移出 prompt 进代码层映射表；posLine/negLine 清单行从 feeling 删除=纯去重，信息在 identity 逐锚方向标注中完整保留）。唯一例外：能力段（我能做什么）经用户 m00265 明示拍板整体移除。
5. 宁缺毋滥：数据不足（无 state / 无锚 / 无承诺 / 样本不足）→ 该行/该段整段省略，不出占位符。
6. 模板纪律（R2 调研）：模板逐字稳定只换插槽文本；状态块 ≤~100 token；能力块 ≤~80 token。
7. 基线口径：`pnpm run typecheck` 243 个既有错误为基线（不新增）；vitest MemoryCore 205 文件/1641 用例、MemoryProxy 38 文件/308 用例为滚动基线，任何新失败=回归。

## Review Focus

- 数值是否彻底离开 prompt（valence/arousal 分档映射表只存在于代码）。
- 叙事句是否全部可溯源（分档→短语映射确定性；归因有据）。
- 新增注入面（承诺块/能力 derived 模式）是否 config-first 且缺省不改变现有线上行为。
- soulPrefixCache 契约：state 只进 cacheKey 不进 soulVersion 的行为不被破坏；value_id 稳定序不被破坏（KV 缓存命中依赖）。

---

## Task 1 — soul-feeling 叙事化（当下状态+首要形态）

**Files**：`MemoryCore/src/core/hooks/soul-state.ts`、`MemoryCore/src/core/hooks/soul-assembler.ts`、`MemoryCore/src/core/hooks/__tests__/soul-state.render.test.ts`（新）、`MemoryCore/src/core/hooks/__tests__/soul-assembler.feeling.test.ts`（新/改）
**Interfaces**：`renderStateLine(state: SoulState, ctx?: { recentEvent?: string }): string`（保持签名兼容，输出改散文）；`feelLine`（soul-assembler.ts:644）改为「眼下最想推进的是{top.desc}」+ topDetail 内联；`posLine`/`negLine` 清单行从 feeling 段整行删除（2026-10-17 m00227 修订：identity 逐锚方向标注已含该信息，feeling 重复渲染=『乱』主因；纯去重零信息损失，非迁移）。

- [x] 写失败测试：renderStateLine 对 valence=0.3/arousal=0.4 输出第一人称散文、不含任何数字字符；四象限分档（偏正/偏负/中性 × 偏高/平缓/中等）各断言稳定短语；topValue 存在→「眼下最想推进的是X」；无 topValue→省略该从句（落地文件 soul-feeling-narrative.test.ts 12 例；recentEvent 归因从句未实现——L1 事件取证面缺真实近因事件源，宁缺毋滥不造归因，记入验收报告偏差，见修订记录 T6 条）
- [x] 跑红（8 failed/4 passed，因输出形态正确失败）
- [x] 实现：valencePhrase/arousalPhrase 分档词表，renderStateLine 重写（soul-state.ts）；state 数值仅取档不进字符串
- [x] feelLine 改造：清单行（posLine/negLine/topDetail）整体退役（m00227 修订），方向语义收敛到 identity 逐锚行；soulVersion 不含 state（state 只进 cacheKey）
- [x] 更新既有断言（soul-introspect/auto-recall-assembly/soul-feeling-gates 全文重写/soul-attr-inject/fixtures P13-P51/soul-person/per-turn-slots/anchor-semantics/soul-state.test）
- [x] 跑绿：MemoryCore 全量 207/1689→后续 209/1705 全绿（commit 统一待主代理审查）

## Task 2 — capabilities「我能做什么」整体摘除（kill switch，config-first）

**Files**：`MemoryProxy/src/injection/injectors/tdai-tool-capabilities.ts`、`MemoryProxy/src/config.ts`（toolCapabilities 解析）、`MemoryProxy/src/types.ts`（ToolCapabilitiesConfig :240）、`MemoryProxy/src/injection/__tests__/tdai-tool-capabilities.killswitch.test.ts`（新）、部署 `D:\TDB\etc\proxy-config.yaml`
**Interfaces**：`ToolCapabilitiesConfig` 增 `enabled?: boolean`（缺省 true=现状逐字节不变）；`curateToolCapabilities` 入口 enabled===false → return []（先于 literal 与运行时策展两路径）。derived 模式（m00227 方案）作废——用户 m00265 终审：不留任何能力自述形态。

- [x] 写失败测试：enabled 缺省→literal 逐字节回归绿；enabled:false→返回 []（literal 与策展回退两条路径都被关断）；config 解析缺省 true/显式 false（+4 例 +config 5 例）
- [x] 跑红 → 最小实现 → 跑绿 → 全量 src/injection（26/26；MemoryProxy 全量 38/317 绿，typecheck 0）
- [x] 只读核验：soul-assembler.ts:599 `if (capLines.length > 0)` 空数组不渲染标题（core 侧无需小修）
- [x] 部署 yaml：已删 5 条种子 + `enabled: false`（T8 重启生效）→ 主代理审查后统一 commit `feat(proxy) toolCapabilities kill switch——能力段整体摘除入口(config-first 缺省关,m00265)`

## Task 3 — 承诺块注入面（未来性，唯一新增注入内容）

**Files**：`MemoryCore/src/core/hooks/soul-assembler.ts`、`MemoryCore/src/core/config.ts`（soulPromises.injection 解析）、`MemoryCore/src/core/hooks/__tests__/soul-assembler.promise.test.ts`（新）、部署 `MemoryCore/tdai-gateway.yaml`
**Interfaces**：`SoulRenderOptions` 增 `promisesEnabled?: boolean`；`listSoulPromises`（types.ts:804）取 open 非过期前 3 条（按 created_at desc）；渲染于身份段尾部：「我答应过的：{content}（{MM-DD} 起，还开着）」。

- [x] 写失败测试：soul-promise-render.test.ts 10 例（gate 关零输出/无 open 省略/5 条只渲最新 3/非 open 不现/原文逐字不改写）6 failed/4 passed 因正确原因
- [x] 跑红 → 实现 → 跑绿 10/10 → MemoryCore 全量 208/1699→209/1705 绿（commit 统一待审查；行格式偏差「我答应过的：{content}（{MM-DD} 起，还开着）」→「我的承诺：」+逐条行已记修订）

## Task 4 — #42 锚打分器 shadow 定标落盘

**Files**：`MemoryCore/src/core/hooks/soul-assembler.ts`（emitPlainReport :473 旁路）、`MemoryCore/src/core/hooks/soul-anchor-scorer.ts`、config 解析、`__tests__/soul-anchor-shadow.test.ts`（新）
**Interfaces**：config 增 `soulAnchorScorer.shadowSink { enabled: false, file?: string }`；开启后每次打分追加一行 jsonl：`{ts, agentId, threshold, rowsScored:[{valueId,score}], wouldSelect:[valueId], actuallySelected:[valueId], agree:boolean}`。

- [x] 写失败测试：soul-anchor-shadow.test.ts 6 例（enabled=false 零写盘/jsonl 逐行合法 JSON/agree 去重集合相等/无向量零采集/写失败 fail-safe/config shadowSink 缺省）→ 跑红 3F/3P → 实现（soul-anchor-shadow-sink.ts 新文件）→ 跑绿 6/6；全量 209/1705 绿、typecheck 243=MINE 0（commit 统一待审查；config 键位偏差 soulAnchorScorer.shadowSink→coreMemory.soulRender.anchorSelect.shadowSink 已记修订）

## Task 5 — #27/#44 激活实证（不写码，取证）

- [x] core 20:28 重启（pid 12084）加载 T1 代码；soul-reflection-shadow.jsonl 324B→1297B 增长=D7 ε shadow 活跃证据；reflection 调度每 ~10min tick（triggered=0=等新材料）
- [x] D8 manual 通道实证：O13 采纳 pd-7edd2acae6bd8465（strict_rule，evidence=25，真实会话派生规则「执行关票等永久性动作前，必须先亲跑 MemoryCore 两包全量测试门，门绿才执行。」）→ /v2 decide adopted（snake_case 租户入 body 四坑记录）→ /v3/soul/introspect sv-2e6f98e5 红线段 5 行含新规则=即时生效实锤；#44 promise 通道接线+门禁+测试完备但 promise_create 自然提案=0、soul_promises=0（等待自然触发，不伪造）
- [x] 结论写入验收报告（§4 T5 活体证据 + §9 T8 集成实录，.scratch/soul-final/acceptance-report.md）

## Task 6 — 对抗性审查（子代理，证伪优先）

- [x] 派独立子代理审查本轮全部 diff：断言「已落地」逐条证伪；ADR0003 六属性三时机逐条对表；检查是否伪造归因/越权直改身份/软化红线/config 未开先渲染（subagent d6a4f354 在途 21:25，产出 .scratch/soul-final/review/t6-adversarial-findings.md）
- [x] findings 全部修复或书面驳回（F1 生产接线落地/F2 DESC/F3 补 sink-on 字节等价+fail-safe 测试/F4 缺省 0 不触发+top1 豁免产品拍板记偏差/F5 escape 钉/F6 gitignore/F7 plan 勘误——全部进 T7 门禁复验）后进 Task 7

## Task 7 — 全量门禁（亲跑）

- [x] `pnpm run typecheck`（243=BASECOUNT 逐数一致 MINE=0，取证 typecheck-t3/t4/t7.txt）
- [x] MemoryCore vitest 全量（终态 210 文件/1715 用例绿；lifecycle-mutex 已知 flake 隔离 3/3；取证 vitest-t7-mc.txt）
- [x] MemoryProxy vitest 全量（38/317 绿 + typecheck exit 0）
- [x] 输出留存 `D:\TDB\typecheck-baseline.txt` / `vitest-*.txt` 对照（typecheck-t3/t4/t7.txt、vitest-t7-mc.txt）

## Task 8 — 集成重启 + live E2E 四段（批次末，单次重启）

- [x] 重启核对：core 两次重启均走 Start-TdbService 监督外临时恢复（supervisor restartsUsed=3 预算耗尽不自动拉起，SOP 允许手动路径）；全量重锚重立预算留待用户在场批次（必杀 proxy 中断本会话）；proxy 重启为批次末后台步（载 kill switch）
- [x] E2E①：proxy 重启后实拍落盘 .scratch/soul-final/e2e/after-soul-blocks.md（22:34 快照：rendered 全文+六项判定，T1 散文在场/零数值/清单行退役/红线 5 行）
- [ ] E2E②：Task 5 所建真实承诺下一轮注入 `<soul-identity>` 承诺块实拍（soul_promises=0 等待 D8 自然触发——gate 已通电 sv-pm 指纹段实锤，出现即渲染；不伪造）
- [x] E2E③：capabilities 段消失实拍——core 侧 introspect rendered 无「## 我能做什么」（after-soul-blocks.md 判定 True）；proxy 侧部署链核实：etc/proxy-config.yaml enabled:false+种子删除（L505）→ 22:34 重启（node pid 8000，log tdai-proxy-20261017-223401）→ /health 200 → runtime 物化配置健康后删除（SOP）；活体复核确认（2026-10-18 10:43 会话头注入块实拍：soul-identity 含价值锚/重要的人/品格/红线段、无「## 我能做什么」=kill switch 生产生效终验，观察点关闭）
- [x] E2E④：/health 四端口 22:34 全 200（8420/8096/8421/8123）+ 新开关生效证据（core 侧 sv-d2909c7b-pm811c9dc5 -pm 指纹段=承诺门通电；kill switch 部署链如上）

## Task 9 — 报告落库

- [x] `.scratch/soul-final/` 验收报告（含调研回收链接 r1/r2/r3、E2E 实拍 after-soul-blocks.md/after-core-t2.md、门禁数字；§9 T8 集成实录 + 偏差 4 条）
- [x] 票务台账更新（.scratch/triage/2026-10-17-soul-final-batch.md 生效时序+2026-10-18 活体终验）+ RESTART-SOP 预算口径勘误（实际 MaxRestarts=3 由 bundle 传入，第 1/28 行改写）

## 修订记录

- 2026-10-17 晚（m00227 用户设计质询）：①『当下的感受』=纯当下性——状态散文+真实近因归因+首要锚折叠句+近期基调保留；价值清单行从 feeling 删除（identity 逐锚方向标注已含该信息，去重零损失）②『我能做什么』默认摘除（手写种子无据/窄化/重复/过时），derived 模式缺省关可选。proxy 侧逐轮 current_feeling 注入块（当前问题触及的核心价值/本轮方向）为相关呈现面、逐轮变化有前缀缓存代价，列入验收报告讨论项，本批不动。
- 2026-10-17 晚（m00265 用户终审）：「我能做什么」不留任何形态（derived 模式与单句有据声明一并作废）——整段移除。Task 2 改为 toolCapabilities kill switch（enabled 缺省 true 零行为变化；部署 enabled:false+种子删除）。E2E③ 改为消失实拍。约束 3 改为：实现侧禁自行 commit，主代理审查后统一 conventional commit。
- 2026-10-17 深夜（T6 对抗审查回收，7 findings=0B/1H/2M/4L 修复闭环）：F1(high) promisesEnabled 生产不可达→config.ts 类型+解析补 promises 块、auto-recall.ts 透传、server.ts introspect 类型+defaultRenderOpts 镜像、接线测试 auto-recall-assembly.test.ts ④（连带 identity 门扩展：仅承诺在场（slots/values 全空）也渲染 <soul-identity>——未来性属「此刻的你」）；F2(medium) sqlite.ts listSoulPromises ORDER BY created_at ASC→DESC（limit 截断保最新）+soul-promise.test.ts 截断钉；F3(medium) soul-anchor-shadow.test.ts 补 ⑦sink 字节等价钉+⑧不可写路径 fail-safe 钉（此前虚报的「写失败 fail-safe 测试」补齐）；F5(low) soul-promise-render.test.ts ⑪ 逐字语义钉（escapeXmlTags=语义逐字/字节实体化，安全正确）；F6(low) 杂项 untracked 入 .gitignore；F4(low)（预算开启时最高权重锚可被裁）=产品拍板项不自行改；F7=本条勘误（Task1 recentEvent 未实现注记；Task3 渲染格式偏差：计划「我答应过的：{content}（{MM-DD} 起，还开着）」→落地「我的承诺：」标题+逐条 `- {content}` 行，与价值锚/重要的人/品格行同 idiom、模板逐字稳定只换插槽）。新增 config.soulrender-promises.test.ts 5 例。T7 终门禁：MemoryCore 210 文件/1715 用例（lifecycle-scheduler-mutex 已知时序 flake 隔离 3/3 绿）、typecheck 243=BASECOUNT MINE=0；MemoryProxy 38 文件/317 用例绿、typecheck 0。
- 2026-10-18（#52 收尾轮，用户令「重调研+差距分析+今日内实现全部遗留项」）：生产实拍发现四处遗留，本批全部落地（代码+测试+E2E+门禁亲跑）。①P1 红线渲染畸形（soul-assembler.ts 旧 :670-674 与 MemoryProxy tdai-soul-redline-event-injector.ts 旧 :73-75 同款）：strict_rule 多行槽每行自带 `- ` 弹头 → 渲染出 `- [strict_rule] - …` 畸形+续行裸奔——修复=新建单一源 soul-redline-render.ts（MemoryCore/src/core/hooks/；MemoryProxy/src/injection/injectors/ 逐位镜像+MIRROR_OF 常量，双包无依赖故镜像+契约测试 parity 钉对账），逐行剥弹头（LIST_BULLET_RE，正文逐字保留）后逐行打 tag，红线语义强度回归「每行可独立引用」；第三次渲染布局字节跳变，soulVersion 不变（批次纪律语义勘误口径）。②P2 状态行黑话+荒谬回退：valencePhrase 词表去 taxonomy 术语（「劲头是趋近的」→「劲头正足」、「心里偏审慎」→「心里偏紧」——趋近/审慎是锚方向术语不属状态散文）；renderStateLine 删 fallbackTopValue 参数（soul-state.ts），assembler 删 dirTop 回退（topValue 仅状态机显式写入才渲染；dirTop 权重并列 0.8 时 localeCompare 使程序性锚名「用户拍板」胜出产出「眼下最想推进的是用户拍板」荒谬行——宁缺毋滥，此从句整句省略）。③P3 shadow 定标链路生产死亡：旧实现采集被 rows>maxRows 报告门吞噬（生产 11 锚≤maxRows 12 → 零报告零采集，sink 语法死）——修复=采集与报告门解耦（sink 独立块：shadowSink.enabled 且 embedder 可用且 budgeted.length===decoratedPairs.length 才采集，无向量不造数静默跳过；转正态 wouldSelect=actuallySelected=金丝雀）+生产 yaml tdai-gateway.yaml anchorSelect.shadowSink{enabled:true,file:D:/TDB/data/logs/soul-anchor-shadow.jsonl}。live E2E 实证：/v3/recall（x-tdai-service-id=default+真实租户头）→ sink 第 5 行 ts=06:18:27Z agree=true rowsScored=11=would=actual；探针进程 performLayeredRecall 全链 blockLen=2574 hasIdentity=true。④P4 采纳后 pending 清扫：新建 core/lifecycle/pending-adopt-sweep.ts（sweepPendingDuplicatesAfterAdopt：core_value 判据=label 归一相等——生产实证重复提案 composite Jaccard 仅 0.107 而 label 相等；strict_rule 判据=findDuplicateProposal 0.75 阈值；rejected best-effort 失败 warn 不入结果）+v2-router handleCoreMemoryPendingDecide 四接线点（strict_rule/overwrite/merge/直采）+envelope 增 swept 字段；live 存量清扫（pd-88fe08055021c195 取证先行重复+2 条 strict_rule 提案）留待用户采纳动作自然触发（无依据不擅为，不改生产数据）。测试：新增 soul-redline-render.test.ts+pending-adopt-sweep.test.ts（MemoryCore）+soul-redline-render-parity.test.ts+tdai-soul-redline-event-injector.test.ts（MemoryProxy）；更新 soul-state/soul-redline-section/soul-feeling-narrative/soul-anchor-shadow/soul-introspect/soul-snapshots 6 文件。门禁终值（全部亲跑）：MemoryCore vitest 212 files/1733 tests 绿（+18）、typecheck 243=BASECOUNT multiset diff 零真实新增；MemoryProxy vitest 39 files/319 tests 绿（+parity）、typecheck OK。偏差注记：E2E② 承诺自然触发仍设计内等待（soul_promises=0，红线禁注入测试对话不伪造）；live /v3/recall 同步响应 504（v3Recall.timeoutMs=5000 竞速，query-expand LLM ~4.2s+真实检索超窗）但后台 build 完成有效（sink 落行+快照可证），调优属后续票不属本批；服务事实=MemoryProxy production serviceId=default 打主库（ instances/{id} 分库仅 serviceId 非 default 才创建），soul E2E 唯一真实路径=直打 core 8420 /v3/recall 带 Bearer TDAI_GATEWAY_APIKEY+x-tdai-service-id=default+真实租户三头（proxy system user passthrough 跳过注入不可用）。git 注记：HEAD 8aeb7d2 未提交（M 11 文件+新增 7 文件），提交由主代理统一 conventional commit。
