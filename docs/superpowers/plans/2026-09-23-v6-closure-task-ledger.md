# V6 会话收口任务台账（2026-09-23，v6 会话终态 HEAD=12c8e46）

> 依据：v6 移交提示词（8 任务）+ v6 会话执行增量。状态四态：DONE/PARTIAL/TODO/GATED(待拍板)。
> 原则：自生长自维护；属性「获取→评分→使用→展示」四链生产级闭环；用户看不到=没做=不合格。

## 一、v6 任务清单对账

| 编号 | 任务 | 状态 | 收口证据 / 缺口 | 下一步 |
|---|---|---|---|---|
| T1a | 注入行五徽章（强烈/验证×N/核心事实/已演化/自 date 起） | DONE | 6d4a1a4；双租户活体；阈值与内核一致 | — |
| T1b | 锚行 weight（label(方向·w0.8)） | DONE | 6d4a1a4；w 值反推全对上 | — |
| T1c | soulVersion 消费端验证 | DONE | 幂等 sv×2 PASS | — |
| T1d | 感受段语义增强（方案B） | DONE | 6d4a1a4；首要段双组活体 | — |
| T1e | personRefs 描述 | DONE(代码) | 描述段休眠——person 锚无 description（数据面回填待拍板） | 回填方案呈拍板 |
| T2 | 召回新信号 A/B（R-recall/R-identity/R-arousal） | TODO | golden 桶已清空须重建；F14-bis 禁令与 R-identity 张力须正面回答 | 设计小节先行+≥10 组同种子对照 |
| T3 | 灵魂组成重分析+token 预算评估 | PARTIAL | 1d/1e 完成；锚 19 行膨胀后 soul 段 token 预算/截断策略未评估 | 归入工作流 B |
| T4 | 全量展示验收 | PARTIAL | 徽章/锚行/首要段/属性表 UI 已亮；尾巴：验证×N 徽章复核（用 rc=101 真实行 m_1789437830444_473d770a）、相关记忆展开走查、全按钮三套风格归一 | UI 批次三 |
| T5 | F-DUP-1 L0 去重 | TODO | 根因+两层设计在技能 td-agemem-fdup1-l0-dedup；幂等窗口/键粒度/连发边界三问先呈拍板；存量 L0 清理须含 vec/FTS 一致性方案 | RED 先行 |
| T6 | D-R3-2 锁风暴治理 | TODO | 活体证据已捕获（pipeline:{default:_:_} retry 86）；修法=boot recovery 过滤无 L0 会话键 | RED 先行 |
| T7 | 灵魂真伪判定（量化判据） | TODO | 依赖 T2 产出 | 工作流 C |
| T8 | pending 提案去重 | DONE | P1 闸门 0.75+P2 prompt 注入（77bf07e）+P0 清理 104→67（ec7a479，备份 in /data/tdai-memory/backups/）；方案② embedding 深清理登记待评估 | 可选二期 |
| G1-G9 | gated 9 项（D-5 关断维持/R11 生产值/sensitivity 存量[已修3行]/测试租户清理/D2 A/B/neighborExpand/T7b/P3 散项/audit#11#16） | GATED | 全程零抢跑 | 逐项呈报拍板 |
| +UI | 批次二 UI（徽章组/注入预览/首要段/aria） | DONE | 808cb78+2aa481f（ChatMemory 移除价值锚 tab，锚唯一入口=/soul）+89eda93（锚行整宽）+12c8e46（属性表可读性） | CHANGELOG 待补记 UI 三连 |
| +F-U1 | 列表路 metadata 缺口 | 撤销(误报) | 三层透传实锚在场（内核 atomic-query-fields.ts/BFF :1279+:2815/mapLayerItem）；教训=待办采信前先现场核验 | — |
| +F-U2 | 并列 weight 首要选取两端序差异 | TODO(低) | Panel=weight DESC 序 vs 注入=value_id 序 | 展示一致性统一 |
| +NO-GO | UI 2.1 整改双专家评审 NO-GO 清单（2 P0+8 P1+4 P2，纯视觉项…） | TODO | 线索来自 soul 锚 设计文档 锚语义（锚 id 待溯源） | 溯源清单并落地 |

## 二、v7 三大工作流（用户 2026-09-23 定义）

| 流 | 内容 | 原则 |
|---|---|---|
| A 设计↔实现全面复查 | 对照 spec（docs/superpowers/specs/2026-09-17-soul-memory-design.md）逐条款检查设计与实现遗漏/错误并修改、完成未完成项 | 自生长自维护；三步强制（设计基线→file:line 取证→判定表） |
| B 属性四链生产级 | 获取→评分→使用→展示全链生产级闭环；灵魂组成重分析（当前/正确/公式/内容/提取/拼接/主语/人物）；Panel UI 全量展示且美观易用；可展开 UI 划定边界防溢出 | 不允许任何遗漏/未完成/未使用/预留的属性和逻辑；用户看不到=没做=不合格 |
| C 逐属性讨论 | 灵魂与记忆所有属性的提取/内容/分析/使用与用户逐项重新讨论 | 交互式：每属性出讨论材料（现状四链+设计原文+真数据）等用户参与 |

## 三、环境速查
- HEAD=12c8e46 · core vitest 755/755 · tsc 222 · panel 140/140 · web tsc 2 · 四服务 200
- DB /data/tdai-memory/vectors.db；备份 /data/tdai-memory/backups/；pending 72/37 rejected
- 属性基数：arousal≥0.7=10 / rc≥3=225 / identityRefs=141 / valid_start=208 / evolution=0

## 四、UI 批次三任务（2026-09-23 深夜 v7 轮开工补登，按序执行，逐项过信息完整性硬标准）

| 编号 | 任务 | 状态 | 收口证据 / 缺口 |
|---|---|---|---|
| UI-3.1 | 信息完整性专项巡检（先于视觉美化）：逐页逐组件排查三类违规——①长文本溢出/省略号截断（嫌疑：ValueAnchorsPanel 注入形态预览/锚行 description/AttributesSection 属性长文本/SoulPendingRail 提案内容）②同行元素过多挤压（嫌疑：记忆行 tag+徽章组同行、_va-row 徽标+label+weight+下拉+按钮）③空值行占位。每处违规换展示形态，改前 mini-mockup 对比呈拍板，改后长文本/多元素/空值三形态截图验收 | TODO | v7 开工 |
| UI-3.2 | 验证×N 徽章点亮复核：rc=101 真实行 m_1789437830444_473d770a 记忆页搜索/翻页复核（预期即亮；不亮=新丢值点取证修复） | TODO | v7 开工 |
| UI-3.3 | RelatedSection 相关记忆展开区视觉走查+整改（截图+DOM 双验收，密度/对齐/边界逐项列问题） | TODO | v7 开工 |
| UI-3.4 | 全按钮逐项测试+三套按钮风格归一（soul pill vs 记忆页白底黑字 vs 蓝填充主按钮→tea-component 语义体系），出 NO-GO 清单分批修 | TODO | v7 开工 |
| UI-3.5 | F-U2 并列 weight 首要选取两端序统一（Panel=weight DESC vs 注入=value_id，建议两端均 value_id 次级键） | TODO | v7 开工 |
| UI-3.6 | UI 2.1 整改 NO-GO 清单（2 P0+8 P1+4 P2）溯源落地 | TODO | v7 开工 |
| UI-3.7 | CHANGELOG 补记：UI 三连整改（2aa481f/89eda93/12c8e46）+批次三全部 | TODO | v7 开工 |