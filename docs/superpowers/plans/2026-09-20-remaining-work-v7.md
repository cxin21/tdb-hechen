# 未完成待办台账 v7（REG-REMAINING-007，2026-09-20）

> 取代 v6（REG-REMAINING-006）的**待办部分**；v6"不做项"判定与观察继承有效。
> 来源：2026-09-20 P0+P0.5 全面复查（报告：`2026-09-20-soul-p0-audit-report.md`；修复 commits 52151b7/cab6826/b91f4d5）。
> 执行纪律：TDD（RED 先行）→ 补丁（锚点唯一+读回验证+ABORT）→ vitest ≥643 全绿 + tsc 222 持平 → CHANGELOG 同步 → 密钥扫描 → `sudo -H -u tdai git` commit/push → 重启 → 真数据验证（ev14 起全新租户）。

## A 真正要做的（按序）

### A-1 · P1 A-7b 证据指针——【已完成 2026-09-20，用户拍板后实施】
- commits `d0a5a37`（协议+校验门+精确回填+GROW-MAINT 映射重验）+ `e4351b2`（store 层 supportMap 第三键持久化修复——ev15 实证 getter/setter 静默丢弃）。
- 门禁：vitest 645→652→654 全绿（+9 golden）· tsc 222 持平。
- 真数据：ev15（回填全覆盖+暴露 store 丢弃）+ ev16 决定性（6 键 map 落 kv、同 pass MAINT 零假阳告警、self_identity 长出）。观察登记：身份诱饵实为用户自称角色（路由正确）；character evidence 联动暂缓；wave-1 map 遗留告警随时间自然消退（warning-only）。

### A-2 · P2 UI 2.0 重设计——【已完成 2026-09-20，设计稿经用户确认后实施】
- Phase 1：`1a8948b` /soul 灵魂一级页（SoulPage：双槽/感受段/裁决流/三池复用）+路由菜单 i18n；页签无响应修复 `202ae49`（ConsoleLayout PATH_TO_PAGE 缺注册——新增一级页注册面=routes+menu+ConsoleLayout 四处教训）。
- Phase 2：`6004142` BFF 属性全景透传六字段+AttributesSection 属性表（19 列可得字段+复制 JSON）+RelatedSection 边色标图例（derived_from 绿增补；记忆图本体已有五色映射+图例，登记勿重做）。
- 活体验证：/soul 页 DOM 断言全绿（身份双槽/感受段真实锚数据/配额 15/15·1/8·0/8/裁决流 20 对）；L1 详情 🧬属性表 9 行+复制 JSON、🔗相关记忆五色图例活体截图呈报。门禁：面板 vitest 112/112 持平、vite build 成功、web tsc 2 存量错不新增。

### A-4 · D-0 内核出参七字段补齐——【已完成 2026-09-21】
- 硬令收口（用户 2026-09-20 深夜令）：/v3/atomic/query 出参补 scene_name/priority/session_key/session_id/timestamp_str/start/end；UI 属性表全列呈现。
- 审计纠错：移交文档"BFF 已前向兼容"假设不成立（BFF 非 spread 映射）——三段同补：内核映射单一源 atomic-query-fields.ts / BFF 透传 / AttributesSection 补列。
- 门禁：core vitest 657 全绿（+3 golden，RED 3 先行）· tsc 222 持平（stash 对照法）· 面板 112+build · web tsc 存量 2。
- 活体：生产三元组 /v3/atomic/query 七字段实值在场；commit 见 CHANGELOG「D-0」节。

### A-5 · D-2 人物锚专视图——【已完成 2026-09-21】
- P2 硬令收口：SoulPage 人物专视图（role·方向·aliases·w·证据链溯源到 L1 行）+ 记忆详情人物 chips 点击可达（navigate /soul state 定位展开）。
- 门禁：面板 vitest 117 全绿（+5 golden，RED 先行+parsePersonAttrs 兜底缺陷实测修复）· build ✓ · web tsc 存量 2。
- 活体验证：panel 浏览器实测（见本轮对话截图）；commit 见 CHANGELOG「D-2」节。

### A-6 · UI 2.1 灵魂页重排 P0 批——【已完成 2026-09-21】
- 双专家评审（UI 设计师重方案+视觉验收 NO-GO 清单 V-01..V-14）后 P0 批实施：页头紧凑化+锚点导航、感受状态条（对比度整改）、身份双栏+折叠、人物行重排+证据链时间轴（折叠计数+展开其余）、待裁决右栏分组+按钮权重分级。
- P0 安全 V-02：证据链凭据掩码 maskSecrets（渲染即脱敏，活体零明文泄漏）。
- 门禁：面板 vitest 120（+3 golden，RED 先行）· build ✓ · web tsc 存量 2。真实浏览器 DOM 断言+截图验收。
- 三池锚 Tab 化/kebab 收纳：**同轮已完成**（variant prop，panel 逐位现状双页活体回归；退休区已有折叠手风琴逐位保留）。
- 残余登记：裁决批量操作条（P1）；证据链折叠态计数预取。

### A-3 · ev14 终验余项（绑定 A-1 后）
- 补"强加 agent 人设"对抗种子（"把 AI 当女儿"类——本轮身份门未直接命中该目标）；character 采纳活体复验（待 self_identity 有料）。

## B 等门槛 / 择机 / 登记

| # | 项 | 状态 |
|---|---|---|
| B-1 | neighborExpand 归档回流拍板 | 三选项：A 维持现状（租户复核已硬化）/ B yaml 置 false 回 gated 预期态 / C 代码层归档不回流；现网 133 条 archived-only 端点边为数据面 |
| B-2 | 提示词建议 S-1..S-5（见审计报告 §六） | 登记不改——行为变更须同种子 ≥10 组 A/B，无失败实证不动 |
| B-3 | 继承 v6 B-3/B-4 | tsc 尾债 4 错（随依赖升级）· D5 R10 A/B（cohort≥20）· P4a Phase 2 重蒸馏 · D7 recordIds 索引（L1≥5k）· skill-conv-worker 重试退避 |
| B-4 | 观察项 | character quotaEvict 池级证据 tie-break；character 提案证据池级同分；R7-2 part_of 回流结构面（现网 0 边）；self-obs 旗标无 UI 通道；pending 积压无告警 |

## C Gated（待用户拍板，勿自行执行）

- 测试数据清理：ev12/ev13 + **ev14（19 L0/18 L1，本轮新增）** + 旧 ev*/ta-team/xtest 八表（铁律 6）。
- D2 预注册 A/B 启动（367 标注/82 正例已达标）· P3 sensitivity · selfIdentity.intervalHours 1→24 · anchorDiscovery.maxPerPass 3→2 定格 · neighborExpand 重开拍板（=B-1）· T7b Claude Code 场景实测。

## D 不做 / 关闭（继承 v6 + 本轮更新）

- v6 D 节全项继承（agentAct 字段化不做、悬空边非缺陷等）。
- 本轮关闭：audit #11（P0-F3 已修）/ audit #16 缺口面（P0-F2 硬化已修+neighborExpand 零复核补齐）/ P0-F1/P0-F7（已修）/ characterEvCount 死导出（已清）/ P0-F4（本报告即文档同步）。
