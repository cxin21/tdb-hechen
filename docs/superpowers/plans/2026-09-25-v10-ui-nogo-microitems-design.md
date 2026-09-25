# UI 线 NO-GO v2 微项设计先行呈报（v10 会话，2026-09-25）

- 状态：设计先行呈报，零改动；拍板后按「视觉审查实修配方」（源码定责→DOM 几何实测→截图量化→最小补丁→复测几何+复截图）逐项实施。
- 取证面：生产 Panel 实机（:8123，default-agent-hechen 主桶）DOM 几何实测+截图存档（v10-ui-soul-before.png）+Panel 源码 file:line。

## G1 健康环 68% 文本溢出——**复查自纠：当前构建不可复现，建议关闭**

- DOM 实测：`svg._memory-health-ring` viewBox 36×36，环 circle r=15（内径 30px），文本 "68%" bbox 宽 18px、textAnchor=middle 居中（x=9→27），`textOverInner=−12px`（距环带内缘尚余 ~4.5px），font-size 9px（css:1626-1630）。
- 结论：NO-GO v2 登记「3px 微溢出」在当前构建零复现（0px）。处置=关闭；若实现期复测重现，修法=font-size 9→8.5px 或 viewBox 36→40（二选一，复测几何闭环）。

## G3 感受条首要卡 tag 冗长——**建议实施（优先级 1）**

- DOM 实测：`_soul-prime-card--neg` w=412px，头部三枚并列 tag（`首要` w38 + `审计` + `w0.8`）+ 描述行，tag 占位冗长、信息层级 3 级（硬令 3：同元素过多禁靠截断）。
- 设计：①「首要」与 label 合并单行主标题「首要 · 审计」；②权重 `w0.8` 降级为描述行尾内联徽标（或 tooltip），头部只留 1 枚徽标；③描述行 2 行截断+渐隐+点击展开抽屉（沿用既有渐隐折叠机制，展开边界=卡片内抽屉，防溢出容器）。
- 依据：状态条单卡信息层级 ≤2 级（业界 ACI 信息密度惯例）；首要段选取两端同键契约（F-U2）不动，纯展示层。

## G4 弹卡 key 列 sticky——**建议实施（优先级 2）**

- 源码定责：css:1004 的 sticky=记忆列表条目头吸顶（设计内行为，勿动）；属性弹卡=`AttributesSection.tsx:131` tea Modal（size=l），key 列**无 sticky**——窄宽横向滚动时 key 上下文丢失。
- 设计：Modal.Body 包横向滚动容器，key 列（th/首列）`position: sticky; left: 0` + 实色背景 + 右侧 1px 分隔阴影（sticky-first-column 业界惯例）；verify=768px 宽下横向滚动 key 常驻截图+DOM 断言（offsetLeft 恒 0）。

## 窄屏单行长描述换行——**建议实施（优先级 3，实现期补 375px 实测）**

- 源码定责：chat-memory-panel.css 断点仅 `@media (min-width:768px)`（:375）与 `@media (max-width:960px)`（:478），**无 <768 窄屏处理**；身份/人物长描述行（self_identity 主桶 4 长事实）在 375px 行为未验证（内置浏览器视口不可调，已诚实登记）。
- 设计：新增 `@media (max-width: 767px)` 断点——长描述行 `overflow-wrap: anywhere` + `max-height` + 渐隐折叠展开（沿用既有机制）；**禁用截断省略号掩盖**（硬令 3）；verify=375px 三形态巡检（长文本行/多元素行/空值行）截图+DOM 断言零溢出。

## 待裁决红线提案卡与分区卡风格统一——**建议实施（优先级 4）**

- 实机现状：Soul 页待裁决 tab 提案卡=tea-card+8×`_soul-chip--red 行为红线提案` 红徽标；分区卡=`_soul-section` 体系——两套视觉语言并存。
- 设计：提案卡并入 `_soul-section` 视觉体系（同圆角/边框/标题行/padding 规范），保留 red 语义徽标与「行为红线提案」类型标识；信息结构零变化（不碰 proposal-dedup 比对域与业务逻辑）。

## 附：UI-3.2 实机复证（维持 NEEDS_CONTEXT）

Chat_Memory 页实机确认资产两层=团队资产/Agent 资产，Agent 资产列表仅见 comfyui-chenxin（agt-l5ugn6urg4，L1=172）——default-agent-hechen（agt-kfynybx0ly，L1=504）的 chat_memory 不在列表=平台资产层未暴露实机复证，维持 NEEDS_CONTEXT（需平台侧共享或批准「本 agent 记忆直读」入口，勿自行实施）。

## 实施序建议

G3 → G4 → 窄屏 → 提案卡统一 → G1 关闭。全部改动最小补丁+复测配方闭环，门禁=panel vitest 144/144+web tsc 存量 2 持平+build ✓。
