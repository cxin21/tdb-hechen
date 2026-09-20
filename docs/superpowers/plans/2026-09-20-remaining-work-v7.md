# 未完成待办台账 v7（REG-REMAINING-007，2026-09-20）

> 取代 v6（REG-REMAINING-006）的**待办部分**；v6"不做项"判定与观察继承有效。
> 来源：2026-09-20 P0+P0.5 全面复查（报告：`2026-09-20-soul-p0-audit-report.md`；修复 commits 52151b7/cab6826/b91f4d5）。
> 执行纪律：TDD（RED 先行）→ 补丁（锚点唯一+读回验证+ABORT）→ vitest ≥643 全绿 + tsc 222 持平 → CHANGELOG 同步 → 密钥扫描 → `sudo -H -u tdai git` commit/push → 重启 → 真数据验证（ev14 起全新租户）。

## A 真正要做的（按序）

### A-1 · P1 A-7b 证据指针——【已完成 2026-09-20，用户拍板后实施】
- commits `d0a5a37`（协议+校验门+精确回填+GROW-MAINT 映射重验）+ `e4351b2`（store 层 supportMap 第三键持久化修复——ev15 实证 getter/setter 静默丢弃）。
- 门禁：vitest 645→652→654 全绿（+9 golden）· tsc 222 持平。
- 真数据：ev15（回填全覆盖+暴露 store 丢弃）+ ev16 决定性（6 键 map 落 kv、同 pass MAINT 零假阳告警、self_identity 长出）。观察登记：身份诱饵实为用户自称角色（路由正确）；character evidence 联动暂缓；wave-1 map 遗留告警随时间自然消退（warning-only）。

### A-2 · P2 UI 2.0 重设计（用户明确不满：太丑、信息不全）
- 硬需求：①灵魂页签独立一级页（双槽/三池/品格锚/重要的人/感受段完整呈现）；②记忆属性与关系全景（19 列属性、l1_links 关系图、refs 反向链、pending 裁决流、锚池配额健康条 15/8/8）；③对照 UI redesign spec（2026-09-10）视觉升级。
- 流程：设计稿（信息架构/分区/组件/数据映射）→ 用户确认 → 实施（TDD+面板基线 112+vite build）。

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
