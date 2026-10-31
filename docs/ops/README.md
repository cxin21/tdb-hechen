# docs/ops 索引（运维/取证台账）

> 本目录回答「今天线上是什么档、怎么装怎么回滚、谁测过什么、哪些结论已经被推翻」。**索引不替代正文**：状态只标到「还能不能当依据」，细节以正文为准。
> 判据：状态按**正文自身的结论 + 当前工作树代码**判定，不按文件名猜；正文没写日期/结论的标「未标注」。行号会漂移（多成员并行改），引用代码请按 `文件 + 符号` 定位。
> 更新纪律：新增/推翻一份文档时同步改本索引对应行；「已被取代」必须写清取代者的文件名。**索引行必须写「回答什么问题」（含关键结论），写标题不算**——照标题抄等于没索引。**纪律不靠记性**：`node docs/ops/scripts/check-ops-index.mjs` 扫目录与索引的差集，有未索引文档或悬空索引行就 exit 1（加 `--quiet` 给门禁用，`--json` 给机器读）；它只查存在性，查不出「照标题抄」，那半句只能靠纪律。

## 图例

- **现行**：可直接当运维/配置依据；被代码或新结论推翻前一直有效。
- **取证快照**：某时点的一次实测/审查记录，**不随代码更新**；复跑请用它自带的探针脚本，别把它当现状。
- **待拍板**：结论已明确但动作未获授权，或方向需人裁决。
- **已被 X 取代**：同一问题的结论已由 X 更新，本文件只作历史留痕。

## ① 现状规范与真源（先读这六份）

| 文件 | 作用 | 日期 | 状态 | 归属票 |
|---|---|---|---|---|
| [production-profile.md](production-profile.md) | 线上实际生效的召回/写入/答案/门禁口径；每键给代码解析点、生产档位置、证据等级、回滚动作 | 2026-11-01 | **现行（配置真源）** | #154 #172 #149 |
| [config-default-ledger.md](config-default-ledger.md) | 逐键「留还是不留、凭什么读数」台账；只登记不重新裁决 | 2026-10-31（11-01 行号重核） | **现行（裁决真源）** | #154 |
| [core-auth-binding.md](core-auth-binding.md) | `/v3` 数据面主体绑定三层开关（缺省全关 ⇒ 对现有插件零影响，可灰度） | 2026-11-01 | 现行（已落地工作树，开关缺省关） | 红队② / task-60 |
| [defaults-drift-closeout.md](defaults-drift-closeout.md) | 六条缺省值/行号漂移的收口记录（旧说法→新说法→依据） | 2026-11-01 | 取证快照（结论已并入上面两份，本文件只留「改了什么」） | #154 #172 #174 |
| [all-on-capability-matrix.md](all-on-capability-matrix.md) | 全开档 19 项能力矩阵（Lead 亲测）：每项给真端点、实测读数、契约、缺什么；本目录能力面数字的唯一真源；§3/§4 已按代码钉死 volatile 预算（1500/899），§7 登记环境阻塞（recall P50 4260ms） | 2026-11-01 | 现行（实测读数；代码改后按 §5 复跑） | 矩阵轮（#176 能力面依据） |
| [dsh-plugin-capability-reference.md](dsh-plugin-capability-reference.md) | 用户/运维向能力手册：19 项能力怎么开、怎么验、失败语义、预算与截断、三条注入路径、排错 6 条 | 2026-11-01 | 现行（能力面口径；16 项「未实现」以对应票为准） | task-89 |

## ② 安装 / 运维 / 回滚 runbook

| 文件 | 作用 | 日期 | 状态 | 归属票 |
|---|---|---|---|---|
| [dsh-plugin-install-runbook.md](dsh-plugin-install-runbook.md) | 人用手册：一分钟判断清单、安装、升级、回滚、验收读数（AI 只维护不代跑） | 2026-10-31（11-01 按 task-37 契约复核 §1.3/§3.2/§4.1/§6） | **现行** | #176（epic） |
| [rollback-drill.md](rollback-drill.md) | 召回全开档回滚演练单：开关清单、回滚值、预期读数、journal 观测点 | 2026-10-31 | 现行（可执行；**尚无演练执行记录**） | #149 #154 #168 |
| [cross-host-deployment.md](cross-host-deployment.md) | DSH 与 core 分机部署：五条结论、必需端口、SSH 隧道最小路径、断网队列与身份分发 | 2026-11-01 | 现行（方案层，deploy 尚未落地） | 无独立票（#176 背景） |
| [dsh-plugin-release-checklist.md](dsh-plugin-release-checklist.md) | 发布检查单：门禁 → 打戳 → 备份 → 部署 → 重启+首轮取证 → 失败回滚 → 24h 内定缺省档 | 2026-11-01 | 现行（清单；执行人为 Lead，未跑完不得发布） | #176（发布轮） |
| [plugin-settings-ui-implementation.md](plugin-settings-ui-implementation.md) | 档 2 设置页落地记录：`export { Config }` → 宿主表单 → 写回 patch override；含「deploy 重跑会静默抹掉 override」的修法与复跑命令 | 2026-11-01 | 现行（已落地**工作树**未提交；schemastery 须声明 dependency 3.18.5） | task-57 |
| [wiki-segment-wiring.md](wiki-segment-wiring.md) | 插件 wiki 注入段接线说明：`registerVolatileWikiSegment` 一次接线、预算分账顺序、诊断行与失败原因表、排序口径（按 `absScore` 不按 score） | 2026-11-01 | 现行（模块自洽、**未接真机**：`/v3/wiki/*` 依赖 8420 重启；读数是 28 例单测） | task-74 |
| [knowledge-tools-wiring.md](knowledge-tools-wiring.md) | knowledge 工具 + 注入段接线（dsh-plugin 三处改点）、预算顺序（wiki 之后拿剩余）、诊断行与 reason 全集、8420 真机读数（`/v3/knowledge/list` 200 / 1 条 wiki）、待补的 `volatile.knowledge.*` 配置键 | 2026-11-01 | 现行（接线说明；`volatile.knowledge` 专键尚未加，当前沿用 `tools.enabled`） | task-94 / task-95 |
| [dsh-plugin-capability-segments-wiring.md](dsh-plugin-capability-segments-wiring.md) | 回答「wiki / knowledge 两个能力段是怎么接进 volatile 块的」：谁注册、段顺序与 cap、剩余预算与时限怎么让、barrel 要加哪一行（两个模块归 bench-metrics，本文件只记接线层） | 2026-11-01 | 现行（接线层；8420 未重启 ⇒ 线上仍是 404） | task-74 / task-97 |
| [dsh-plugin-skill-surface.md](dsh-plugin-skill-surface.md) | 回答「技能面在插件里由哪些文件承担、cap 与失败语义是什么、写口怎么防并发覆盖」：注入标记同源、skill-client 17 条路由、段/工具两条注册缝、10 个技能工具（写 6 受 skill.allowLlmWrite 门控） | 2026-11-01 | 现行（实现 + 单测口径） | task-72 |
| [dsh-plugin-preflight.md](dsh-plugin-preflight.md) | 装桌面之前的**一次性**预飞：建临时 profile（不碰 desktop）→ 真身份+真 8420 起一轮 headless → `scan-session-evidence.mjs --strict` 扫段/工具 → 报告落 `scratch/preflight-<stamp>/` → 删 profile；含退出码、PASS 行样例、headless 禁 credentials 的处理 | 2026-11-01 | 现行（脚本 2026-11-01 03:21 实跑 exit 1：8420 宕机，段缺、工具在；**全绿读数待核心起来**） | task-95 |
| [core-wiki-forwarding.md](core-wiki-forwarding.md) | core 侧 wiki 薄转发（`/v3/wiki/list`、`/v3/wiki/search`）：20 单测 + 13 项隔离实例活体全绿，yaml 已加 `memory.wiki` 段 | 2026-11-01 | **现行（代码已实现，生产未生效）**：8420 未重启 ⇒ 该进程里仍是 404，重启后先看启动日志的 `memory.wiki` 生效值再放流量 | task-73 |

## ③ 审计与盘点（某时点的判断，不是现状）

| 文件 | 作用 | 日期 | 状态 | 归属票 |
|---|---|---|---|---|
| [dsh-plugin-halffinish-audit.md](dsh-plugin-halffinish-audit.md) | 「能不能直接上生产」审查：P0 三条（reasoning 当正文写 L0、8192/100 上限冲突）+ 测试绿≠可用的论证 | 2026-10-31 | 取证快照；**其 P0 三条均已修**（`dsh-plugin/src/writeback.ts:131/:504`、`dsh-plugin/src/wire-limits.ts:1-40`，第二轮 e2e 复核） | #176 |
| [dsh-plugin-conformance-review.md](dsh-plugin-conformance-review.md) | 插件↔core v3 契约逐字段复核（P0×2 / P1×4 / P2×4），含 34 项活体探针 | 2026-10-31 | 取证快照；P0（三轴 header、字节预算）已随 task-37 收口，见 e2e-report-2 | #176 / task-34 |
| [change-inventory-2026-11-01.md](change-inventory-2026-11-01.md) | 本轮交付变更清单：171 个未提交改动按域分组、增删行数、逐文件说明 | 2026-11-01 | 取证快照（一次性交付账，不随后续改动更新） | #123 #127 #152 #153 #155 #168 #173 |
| [dsh-specialization-dsh-plugin.md](dsh-specialization-dsh-plugin.md) | dsh-plugin 的 DSH 特化盘点：四问速览、宿主能力缺口（该补 3 个）、bundle 该不该加 | 未标注（task-49 轮） | 取证快照（只分析未改码） | task-49 |
| [dsh-specialization-memorycore.md](dsh-specialization-memorycore.md) | MemoryCore 在「DSH 是唯一正式客户端」后的取舍盘点（/v3 /v2 /v1 入口分层与真实流量） | 未标注（正文日志 2026-10-31） | 取证快照 | task-46 |
| [dsh-specialization-panel-knowledge.md](dsh-specialization-panel-knowledge.md) | MemoryPanel + MemoryKnowledge 读面盘点、体量统计、与 core 的接线事实 | 2026-10-31 | 取证快照 | task-48 |
| [dsh-specialization-proxy.md](dsh-specialization-proxy.md) | MemoryProxy 还有没有存在价值、删它的代价（结论：零 LLM 流量，仅剩三类活依赖） | 2026-10-31 | 取证快照 | task-? （盘点轮，无票号） |
| [core-defect-fixes-d6-d7.md](core-defect-fixes-d6-d7.md) | core 侧 D-6/D-7/D-8 缺陷修复记录：LLM 402 失败仍记 completed、L1 定时器继续推进等，逐条给根因与修法 | 2026-10-31 | 取证快照（修在**工作树**，未提交、8420 未重启） | task-58 |
| [fixed-asset-parity.md](fixed-asset-parity.md) | head pack 是否含 self + 借入 ≤2 agent 画像的复核：结论「**部分 parity**」——self 的 L3/L2 有，借入维度、分组标注、`<core_memory>` slot 全缺 | 2026-11-01 01:30 +08（生产库只读读数，引用须带此刻） | 取证快照（结论未变；所需 core 端点均已具备 ⇒ 不需新票） | task-77 |
| [http-capped.md](http-capped.md) | 回答「读响应体为什么要设上限、超限怎么退、语义有没有变」：有界流式读取（缺省 2 MiB / 上限 16 MiB）+ http/https 白名单，失败 union 永不 throw | 2026-11-01 | 现行（修在**工作树**未提交） | task-100 |
| [injection-marker-parity.md](injection-marker-parity.md) | 回答「插件凭什么认定某条消息是我们自己注入的块、比 core 严会怎样」：与 MemoryCore injection-guard 同源三条口径（前 3 个非空行 / 0.3 命中比 / 行首不可见字符），修的是自我中毒 | 2026-11-01 | 现行（30 例全绿） | task-91 |
| [l2-segment-from-endpoint.md](l2-segment-from-endpoint.md) | 回答「L2 场景索引为什么不再从人格尾部取」：端点独占 + 剥尾后重复字符 6237→0、首次拿到 summary；硬约束是端点给裸文件名、必须补 scene_blocks/ 前缀（验收锚 - scene_blocks 见发布检查单 G7c） | 2026-11-01 | 现行（接线已落；8420 未重启） | task-96 / #155 |
| [segment-health.md](segment-health.md) | 回答「某个段长期失败会不会每轮白打一次 HTTP」：段级熔断器 closed/open/半开（连续 3 次失败开、冷却 10 min、半开只放一个探测） | 2026-11-01 | 现行（单测口径） | task-98 |
| [team-ownership-check.md](team-ownership-check.md) | 回答「/v3 数据面凭什么认定这个 team 属于调用方」：off（缺省，逐位现状）/ warn / enforce（403）三档灰度、判定源 meta_team_members、身份只认 x-tdai-user-key；enforce 生产禁用 | 2026-11-01 | 现行（缺省 off；灰度期只许 warn） | task-68 / #137 |
| [extraction-session-isolation.md](extraction-session-isolation.md) | L1 抽取跨会话混杂的三条缺陷（A1/A2/A3）+ 改法与 L2 `profileScopes` 结论；口径「检索可跨会话，抽取不能混」 | 2026-11-01 | 取证快照（修在**工作树**，8420 未重启；§5 留未做/风险） | task-62 |
| [asset-reflection-impl.md](asset-reflection-impl.md) | task-82 模块交付版：`dsh-plugin/src/asset-reflection.ts` 完整实现+自测；`dsh-plugin/src/index.ts`、`dsh-plugin/src/config-schema.ts`、`dsh-plugin/src/writeback.ts` 的改动**已撤回**交回插件独占 | 2026-11-01 | 取证快照（模块在、**`dsh-plugin/src/index.ts` 未接线** ⇒ 今天不产生任何段） | task-82 |

| [config-key-consumption-audit.md](config-key-consumption-audit.md) | 回答「设置页那 25 个键真被代码消费吗、反向还有哪些看不见的键在改行为」：三档判定（生效 25 / 仅解析 0 / 孤儿 0）、隐藏 49 键人工复核、三个真孤儿（`writeback.maxMessagesPerRequest`、`headPack.maxScenarioEntries`、`assetReflection.*` 四条无调用点）+ 复跑 `dsh-plugin/scripts/audit-config-keys.mjs --strict` | 2026-11-01 | 现行（静态审计：生效=路径可达且读值参与分支/预算，未起宿主） | task-107 |
| [dsh-plugin-l2-segment.md](dsh-plugin-l2-segment.md) | 回答「L2 场景索引怎么从人格尾段改成独立段、四态标签怎么读」：`segments/l2.ts` order 20 / cap 3000 / `headPack.l2Chars`、`listScenariosRich` → `POST /v3/scenario/ls`、persona 只留 `stripSceneNavigation` 后正文；**8420 未起 ⇒ 全是 fake client 读数** | 2026-11-01 | 现行（接线已落，无真读数） | task-103 |
| [core-outage-2026-11-01.md](core-outage-2026-11-01.md) | 回答「8420 为什么静默死、怎么安全拉起来、拉起来怎么判定没再死」：四代 pid 时间线、WerSvc 停用导致「无崩溃记录」不算证据、rerank warmup 66–72s 且 `scores=0`（=返回 null 降级）与死亡秒级耦合 ⇒ K1 原生崩溃带走进程；方案 A 零改动 / 方案 B 三行 yaml，含「别直接跑 supervised 会 takeover」的告警 | 2026-11-01 | **待拍板**（A/B 未执行；K1 非实证） | task-106 |

## ④ 测试与红队取证（复跑用自带探针）

| 文件 | 作用 | 日期 | 状态 | 归属票 |
|---|---|---|---|---|
| [adversarial-review-2026-11-01.md](adversarial-review-2026-11-01.md) | 红队：构造坏输入把「能坏但没坏」与「已经坏了」分开；最短链「LAN → 全库」四步本机实测 | 2026-11-01 | 取证快照；四条链中 ①② 已修（见 redteam-fixes）、③ 已开关化（core-auth-binding）、④ 运维类仍待（security-hardening-pending） | 红队轮 |
| [redteam-fixes-panel-proxy.md](redteam-fixes-panel-proxy.md) | 上述 ①② 的代码修复记录：根因、修法、修复前后实测码 | 2026-11-01 | 现行（已落地工作树） | task-59 |
| [fullstack-test-capture-isolation.md](fullstack-test-capture-isolation.md) | 全栈捕获/边界/隔离实测矩阵（G1–G6 + 替身身份 + sqlite 只读取证） | 2026-11-01 | 取证快照 | task-53 |
| [fullstack-test-read-injection.md](fullstack-test-read-injection.md) | 读面/注入面全栈实测（召回、head pack、volatile、layer） | 2026-11-01 | 取证快照 | task-54 |
| [dsh-plugin-e2e-report.md](dsh-plugin-e2e-report.md) | 第一轮 v0.1 一次性真机 e2e（head pack 进提示、volatile 进上下文、写回落到 L0） | 2026-10-31 | 取证快照（覆盖范围已被 report-2/3/4 扩展） | #176 |
| [dsh-plugin-e2e-report-2.md](dsh-plugin-e2e-report-2.md) | 第二轮真机 e2e：7 条证据 6 条通过 + 6 条偏差 | 2026-11-01 | 取证快照 | #176 / task-31 |
| [dsh-plugin-e2e-report-3.md](dsh-plugin-e2e-report-3.md) | 轻量 smoke：ready 行 ms 原值、head pack 不再误报（写回关闭，零写入） | 未标注（stamp `20261031-224206`） | 取证快照 | task-44 |
| [dsh-plugin-e2e-report-4.md](dsh-plugin-e2e-report-4.md) | user key → team/agent/user 身份解析的真机验证；发现并修 B1（mount 时 seam 查找早一步）；**含 2026-11-01 诚实修正**（B2 症状串是合成示例，因果改为「register 不校验 parameters ⇒ 静默不可用」） | 2026-10-31 | 取证快照 | task-51 |
| [final-gate-report.md](final-gate-report.md) | 全量收尾门禁：12 项命令 rc=0，**其中 core-format 为「跳过」，不构成格式证据** | 2026-11-01（跑于 10-31 22:39） | 取证快照（工作树口径，非已提交代码） | task-41 |
| [core-live-verification.md](core-live-verification.md) | core 三项改动的**装配链**活体验证（隔离第二实例 8499，25/25 通过） | 2026-10-31 | 取证快照 | task-39 |
| [l0-e2e-cleanup-report.md](l0-e2e-cleanup-report.md) | 两次 e2e 留下的 17 行取证数据清理记录（只走 `/v3/conversation/delete`） | 2026-11-01 | 取证快照（现状：已清零） | — |
| [recall-budget-measured.md](recall-budget-measured.md) | `/v3/recall` 预算实测（生产日志 n=144）：端到端 P50 4260/P90 17348ms、l1 占 99.5%、504 53.5%；按真实现算 800/899/1500 的装载容量；四个 volatile 旋钮的建议值与依据；根治=跨轮异步/task-99 | 2026-11-01 | 现行（实测读数；**8420 宕机期采集**，恢复后用文中复核命令重跑） | task-93 / task-99 |
| [skill-feed-dedupe-evidence.md](skill-feed-dedupe-evidence.md) | 同身份双喂（proxy 桥 + 插件）会不会重复落库/提前蒸馏的实证 | 2026-10-31 | 取证快照 | task-25 |
| [dsh-plugin-probe-report.md](dsh-plugin-probe-report.md) | 宿主 API 可行性实测（四类扩展点全跑通；spec 5 条假设被证伪或需改写） | 2026-10-31 | 取证快照 | #176（阶段 A） |
| [dsh-plugin-writeback-rootcause.md](dsh-plugin-writeback-rootcause.md) | 写回 / `memory_recall` 根因与修复：Lead 三条假设逐条证伪或确认，含 probe matrix 复现；**含 2026-11-01 诚实修正**（§2 拒绝串改标为合成示例并拆出处，§3 注入闸门改 `:488` 主闸 + `:204` 文本闸门） | 2026-11-01 | 现行（根因已定、修复在**工作树**未提交） | task-52 |
| [adversarial-retest-2026-11-01.md](adversarial-retest-2026-11-01.md) | 第二轮对抗复测（task-52/58/59/60 重打）：只读零改码，探针前后 8420/8123/8421 `/health` 均 200；写回断链与 `memory_recall` 注册**已封**，GUI 文件日志**半修**（生产 patch 未开 debug） | 2026-11-01 | 取证快照（含矛盾清单与不改码的排期建议） | 红队复测轮 |
| [dsh-plugin-soul-segment.md](dsh-plugin-soul-segment.md) | soul 段接入 + head pack 场景索引去重：soul 取料/预算/可观测性，实测 soul 段 36–40 字符、场景索引去重 334 字符（6.8%） | 2026-11-01 | 取证快照（读数有效；行号随代码漂移） | task-61 |
| [dsh-plugin-gate-fix.md](dsh-plugin-gate-fix.md) | 写回注入闸门与缓冲边界修复：票面三条判据 → `dsh-plugin/src/writeback.ts` 改动 → 测试 25→30 全绿；含「P2 steering 不接入」的取证 | 2026-11-01 | 现行（修复在**工作树**未提交） | task-79 |
| [verify-task52-review.md](verify-task52-review.md) | task-67 独立复核 task-52 三项取证（读源码 + 抽宿主模块 + 自建 fake ctx + 独立重跑 vitest）：**有条件通过** + 两处 P1/P2 | 2026-11-01 | 取证快照；**含 2026-11-01 诚实修正**（「只出自 cordis-host-runner」「kind 分支失效」两条口径不精确，结论不变） | task-67 |
| [fix-d7-structured-llm-errors.md](fix-d7-structured-llm-errors.md) | D-7 真修：LLM 失败状态码从适配器→分类器→worker 结构化穿透（供应商文案只有业务码 2067、无 HTTP 码），402 不再 3 次退避空转 64.9s | 2026-11-01 | 现行（修在**工作树**未提交；活体 402 端点 6/6 PASS） | task-84 |
| [verify-task58-review.md](verify-task58-review.md) | task-71 复核 task-58 的 D-6/D-7/D-8：D-6 达成、D-8 达成、**D-7 未达成**（402 仍重试 3 次、累计 64.9s） | 2026-11-01 | 取证快照（D-7 缺口仍在队） | task-71 |
| [recall-budget-degradation.md](recall-budget-degradation.md) | 回答「/v3/recall 超预算时在哪降级、降级后还够不够用」：降级点选 L1 向量腿、FTS 腿实测 P50 0.42ms、缺省 l1BudgetMs=2000 的由来、「降级轮不出 fact 通道」与 meta.degraded 口径 | 2026-11-01 | 现行（交付 + 实测） | task-100 |
| [l0-testdata-hygiene.md](l0-testdata-hygiene.md) | 回答「生产 L0 里有多少探针测试数据、能不能安全清掉、以后怎么不再写进来」：13450 行库中探针 128 行 / 23 会话的 dry-run 读数 + 可逆清理工具 + 抽取侧跳过闸 | 2026-11-01 | 现行（清理执行待拍板，本文件只做 dry-run） | task-83 |

| [plugin-test-timing.md](plugin-test-timing.md) | 回答「两例固定等待为什么改假时钟、断言有没有变松」：改前后逐例耗时（3228/3237/3284ms → 42/51/39ms）、`settleOnFakeClock` 断言虚拟耗时 `toBe(1600)`、RED 两条变异证明改坏仍能红 | 2026-11-01 | 现行 | task-102 |
| [verify-l0-clean-review.md](verify-l0-clean-review.md) | 回答「L0 清理脚本真能安全删吗、生产读数对得上吗」：自建隔离实例 6/6 PASS（dry-run 零写含 WAL、三条拒绝 exit 2、身份不符 deleted=0、正确身份删净、导出三处 sha 一致、`default` 永不外传）+ 生产只读 dry-run 23 会话/128 行/934375 字符逐位一致；未验 `l0_vec` 级联 | 2026-11-01 | 取证快照（复核方自带探针，未读交接方报告） | task-108 |

## ⑤ 方案与待拍板

| 文件 | 作用 | 日期 | 状态 | 归属票 |
|---|---|---|---|---|
| [plugin-config-ui-feasibility.md](plugin-config-ui-feasibility.md) | 插件 50 个配置键能否 UI 化：机制事实、三条路与工作量分档、键分档表、今天可用的命令 | 2026-11-01 | **待拍板**：档 2（写客户端表单）前必须先实测 `dsh-plugin/scripts/deploy.sh` managed 块与 settings override 是否打架 | task-56 |
| [l2l3-segment-parity.md](l2l3-segment-parity.md) | L2 场景索引 / L3 persona / core_memory / feeling 四段与 proxy 的逐项 parity：端点行为、行格式、等价性判定、对齐方案与硬约束（保住 `- scene_blocks` 验收锚）、截断口径、未验证清单 | 2026-11-01 | 现行（对齐方案）；heat 缺口**已定档 A**：接受丢热度（与 proxy 同档），不为了 heat 改产品、也不在插件侧造第二真源；实施票 = task-96 | task-90 / task-96 |
| [proxy-parity-matrix.md](proxy-parity-matrix.md) | MemoryProxy 注入器 → DSH 插件承载位置的逐条 parity 矩阵（缺/部分/已有），作补齐清单的唯一真源 | 2026-11-01 | 现行（补齐清单真源；逐行带 task-73~78 待补项） | task-73~78 |
| [wiki-recall-integration-plan.md](wiki-recall-integration-plan.md) | wiki 召回接入插件的只读调研与方案：跨库检索无现成端点、8421 team 隔离靠 caller 自证、core 注册表漏 registration；推荐 core 加 `/v3/wiki/{list,search}` 薄转发 | 2026-11-01 | **待拍板**（方案 B/C 待选，未改码） | task-64 |
| [skill-injection-integration-plan.md](skill-injection-integration-plan.md) | 技能注入要不要接、怎么接：proxy 侧 8 条机制事实、体积实测（一次会话 skill 面 ≈10.9–14K 字符）、读侧 0 消费的现状 | 2026-11-01 | **待拍板**（只读调研，结论未拍） | task-65 |
| [security-hardening-pending.md](security-hardening-pending.md) | 安全收紧待办：LAN 明文 user-key 四步链、Panel/Knowledge 0.0.0.0 暴露、处置建议 | 2026-11-01 | **待拍板**（用户原话「暂时记录但先不处理」）；代码侧 ①②③ 已修，本条只剩运维动作 | 红队④ |
| [asset-reflection-parity.md](asset-reflection-parity.md) | AssetReflectionInjector 在 DSH 的适用性判定：**可等价接入**，但触发语义须重定义（不可 1:1 搬 URL marker；proxy 是 markerOptIn + `/analyse` 双闸门） | 2026-11-01 | 取证快照（判定已定：实装见 asset-reflection-impl.md，接线见 task-82） | task-78 |

## 交叉引用（不在本目录但常被本目录引用）

- 审计与票面判定：`docs/audit/2026-10-31-open-issues-first-principles.md`（**只读，不在 docs/ops 维护范围内**）
- 读数与 A/B 台账：`docs/optimization-results.md`（§8 配对、§19.3 rerank 定档、§21.3 旋钮存废、§24 k 值）
- 架构决定：`docs/adr/`（0011 事实通道、0010 双时态、0017 资产读授权、0018 上游同步边界）
- 规格：`docs/specs/`（2026-10-31 dsh 原生记忆插件 spec 与特化审计）