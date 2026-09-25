# 工作流 A 深查判定总表（v10 会话，2026-09-25）

- 基线：HEAD d55eee7（取证起点）→ d6c3adf（本轮文档勘误）；方法=三步强制（设计原文摘录→file:line 取证→真数据→四态判定）。
- 取证面：node:sqlite readOnly 探针 ×7（/data/tdai-memory/vectors.db，L1=964 行）+ /v3/recall 活体探针 ×3（HTTP 200，sv-30ba28ed）+ journalctl 实证 + 全仓 grep（信号 grep 全仓，单文件漏检教训 1 例自纠）。
- 快速扫描（v9，13 条款 11✅/2⚠️/0❌）的深查展开；本文为工作流 A 交付物。

## 一、L1 19 列判定表

| 属性 | 设计条款 | 代码锚 | 真数据 | 判定 |
|---|---|---|---|---|
| record_id/content/type | §4.1 主键/正文/渲染 | soul-columns.ts 单点 | type: episodic 426/work_fact 323/persona 116/instruction 95/work_method 4 | ✅ |
| occurred_at | R1 时近性/演化时序门 | l1-extractor.ts:785 prompt+回填 :850 | 非空 645（319 null=旧语料+反思结论，宁缺毋滥） | ✅ |
| valid_start/valid_end | F18 双时态 | filter-invalidated | 非空 236；valid_end 非空仅 5 且全可解析=F18 失效通道真实工作 | ✅ |
| timestamp_str/_start/_end | 渲染「活动时间」 | AttributesSection:54-56 | 964 全覆盖 | ✅ |
| certainty | 演化门②/渲染实见推断 | evolution-worker.ts:194-195；auto-recall 徽章 | observed 962/inferred 2（门真料少=非缺陷） | ✅ |
| source/priority | 审计/工序调度 | forgetting/scorer.ts:147 priorityOf 真实消费 | priority 964 全非零 | ✅ |
| valence/arousal | F4/锚聚合/遗忘 | 详见二轮报告（C 首批） | 644 非空；≥0.7 仅 15 | ✅（R10 关断=gated D5） |
| significance | R2/F13/遗忘主因子 | scorer.ts:72-80（B5 顶层优先修复）+reflection.ts:132 | ≥0.8 223/mid 415 | ✅（R2 关断） |
| scene_name/session_key/session_id | FTS 快照/O11 指纹 | — | 963/964；全行有值 | ✅ |
| team/user/agent 三元组 | F18 硬隔离 | 全查询 WHERE 实锚 | 5+ 租户零交叉 | ✅ |
| task_id/version/created/updated | 任务关联/演化守恒/采样 | selectSampleRows | task_id 358 | ✅ |

## 二、metadata 8 项判定表

| 属性 | 代码锚 | 真数据 | 判定 |
|---|---|---|---|
| subject | 演化门③+consolidation 幂等键（consolidation-worker.ts:118） | 718 行 | ✅ |
| coreRefs | 提取期标注（l1-extractor.ts:738-749）+backfill（sqlite.ts:2776）+R5/C1/F14/T2 四消费方 | 主桶 372/568 | ✅ |
| personRefs | backfill 三键族单源+反查扩键（sqlite.ts:3153-3157） | 214 行 | ✅ |
| identityRefs | F14 保护+F-EV13-1 模糊匹配（scorer.ts:57-59） | 159 行 | ✅ |
| evolution{from,reason} | 写入方在场（evolution-worker.ts:270-271） | 0 行 | 📝 门严零触发=良性（见 §五） |
| evidence_ids | 双写入方（consolidation-worker.ts:217/evolution-worker.ts:270） | 0 行 | 📝 同上 |
| recall_count/last_recalled_at | SQL 原子自增单源（sqlite.ts:3685-3694） | 418 行 | ✅ |
| sensitivity/recurrence | R11 bias 0 关断 gated；recurrenceProtection=true | none 953/finance 5/health 4/relationship 2；recurrence 3 行 | ✅ |

## 三、锚层 9 列判定表

value_id（三域前缀隔离 growthValueId :121-138）✅ · label ✅ · node_type（三池分池 yaml 15/8/8 全启用）✅ · attrs_json（upsertValue :2375+Panel 三字段编辑+description 回写修复 ValueAnchorsPanel.tsx:97-107）✅ · weight（F5+注入 w 值+首要段两端同键）✅ · valence（valenceDir+感受段两清单）✅ · origin/created_by（QUOTA/manual 豁免）✅ · pinned+state（全态去重）✅。Panel：ValueAnchorsPanel vtab 三池徽标（:37-40）+分池护栏 yaml 显式落盘+IdentitySection 双槽卡。

## 四、core_memory 双槽判定表

readCore 五列（sqlite.ts:2351）✅ · allowedSlots 含 self_identity（yaml）✅ · selfIdentity.enabled=true（maxPerPass 2/intervalHours 24）✅ · F17 预算 600/900/maxRelationLines 5 显式落盘 ✅ · DB：identity 22 槽/self_identity 9 槽 ✅ · F10 状态残留剥离单一源（identity-discovery.ts:406，双槽 reject 路径 :235/:247）✅。

## 五、F 公式族抽证（F1-F20）

F1 RRF_K=60 硬编码不配置化（memory-search.ts:172-177，GOLD-EVO 判定）✅ · F2 recencyBoost 关断（yaml:0）✅ · F3 原子自增（sqlite.ts:3685）✅ · F4 R10 缺省 0 关断 gated（yaml:116）✅ · F5 suggestAnchorWeight 证据饱和（主桶 33 锚 weight 0.46-0.80 与 F5 曲线一致）✅ · F6 挤出 free 口径（:477/:550）✅ · F7 五条件门（evolution-worker.ts:194-195 certainty 计数）✅ · F8 invalidateL1 首次权威 ✅ · F9 recountEvidence（quotaEvict evOf :436）✅ · F10 单一源导出 ✅ · F11/F12 personEvCount/personValenceSymbol（:355/:438/:544）✅ · F13 reflection rRef=2（reflection.ts:132，yaml 刻度换算注记）✅ · F14 refProtection=true（yaml:215+scorer.ts:46-57）✅ · F14-bis 回音室禁令（身份相关性无召回排序参与面）✅ · F15 分池 quotaEvict :436-441 ✅（但见 §六⚠️） · F16 漂移基线（sqlite.ts:2939-2963+anchor-growth.ts:695-698 首轮不误报）✅ · F17 soulRender yaml 显式 ✅ · F18 解析失败保留（5 行全可解析）✅ · F19 护栏四件（yaml minEvidence 3/maxPerPass 2+全态去重同三元组零重复 label 实锚）✅ · F20 identityMaintain.enabled=true（yaml，身份永不自动退场）✅。

## 六、⚠️ 发现（工作流 A 深查唯一 ⚠️）：GROW-QUOTA 守卫被采纳 interval 门饿死

**数据面实锚**：主 team 两 per-agent 桶 theme active = agt-kfynybx0ly **17** / agt-l5ugn6urg4 **16**，均超 maxTotal=15（+2/+1）；其余全部租户/池合规；同三元组零重复 label（跨桶同名=per-租户设计内）。

**机制定责（journal 实锤）**：`[anchor-growth] gate block agent=[...] reason=interval lastAdopted=2026-09-24T12:46 intervalHours=24` + `ran: agents=23 adopted=0 retired=0 reweighted=0 displaced=0 firstBlockReason=interval`（15:14:56/15:24:56 连续 tick）。quotaEvict（anchor-growth.ts:415-441，REG-REMAINING-004 #9）在 runAnchorGrowth 体内、interval 门之后——**维护面（证据 recount+名额回归）与采纳面共用同一 24h 冷却门**；活跃租户隔日采纳持续重置 lastAdopted → 守卫长期无运行窗口 → 超限存量无自愈。守卫本体逻辑正确（autoNow+pinnedNow 口径、强度升序 retire、manual/钉住豁免、可恢复非删除）。

**登记修正（「登记≠真实」第 7 例候选）**：部署技能记载「无存量超限回归守卫」过时——守卫已实施，真缺陷=守卫被门饿死。

**修复设计小节（呈拍板，未实施）**：
- 方案：维护/采纳解耦——GROW-MAINT+quotaEvict 移出 interval 门（每 tick 或独立 maintainIntervalHours，建议独立 6h 控成本），采纳面 F19 冷却（attempt 1h+adopted 24h）维持不变。
- 影响面：runAnchorGrowth 门结构+守卫用例；行为变更硬标准=同种子 A/B ≥10 组（对照=现状超限持续 vs 解耦后回落 ≤15）；recountEvidence 全量语料成本评估（O(corpus×anchors)×租户数）。
- 风险与边界：存量 retire=守卫自然执行（可恢复非删除），但属行为+数据面双变更，**等拍板后走 RED→补丁→门禁→A/B→回切验证全流程**；gated 纪律不因整句授权抢跑。

## 七、📝 零产出观察项

evolution/evidence_ids 写入链完整但全库 0 行：重复源已被上游三闸治理（F-DUP-1 入口幂等+l1-dedup+提案语义去重）→ 合并路径饥饿=门严良性。观察项：若真实重复穿透三闸而两者持续为 0 → 升级缺陷排查。agentAct 0 行=母 spec 审计注记既定（P3 fallback=self_identity 槽已被 M2 消费）。

## 八、文档勘误登记

- §1.2/§5（演化设计）：arousal 轴聚合未实现+遗忘闪光灯调制已启用——commit **d6c3adf** 已推 origin（读回 verified+密扫 0）。
- 部署技能「无存量超限回归守卫」过时→§六修正；云端技能库只读（skill-bridge 无 patch 通道），待技能维护通道更新。

## 九、结论

工作流 A 深查完成：19 列+metadata 8 项+锚层 9 列+双槽+F1-F20 全量判定，**13✅+1⚠️+2📝，0❌**；唯一 ⚠️（QUOTA 守卫饿死）已到机制级根因并附修复设计小节待拍板。C 首批材料（valence/arousal/coreRefs）与本文复用同一取证面。移交：B 灵魂组成重分析证据全复用本文；任务 2 设计小节独立呈报。
