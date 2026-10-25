# #92 stage 2 确定性自动采纳门——实施设计（2026-10-25 细化稿）

> 授权链：用户 2026-10-25「启动 stage 2」拍板。本票草案（2026-10-22）标注「设计要点（草案，动工前需细化并经用户拍板）」，本文 = 细化稿；**四项拍板点（§8）确认后按 TDD 实施**。全程 config-first 缺省关，flag 不开 = 现状逐位。

## 1. 机制总览

- **触发**：lifecycle 调度拍内新增 auto-adopt 块（reflection 块与 TTL sweep 块之后；独立 try/catch warn 非致命，同 sweep 先例）。新文件 MemoryCore/src/core/lifecycle/auto-adopt-gate.ts，scheduler 一处挂块。
- **候选**：store 新方法 listReadySelfIdentityPending(tenant?, {votesN, spanHours})——state='pending' ∧ recurrence ready（count≥N₂ ∧ span≥T₂）；tenant 缺省=全租户（#91 R1 先例），行带租户三元组；scheduler 按三元组分组逐租户处理。
- **三重门**（逐候选）：
  1. count≥N₂ ∧ 跨度≥T₂（候选查询已保证）；
  2. **无矛盾**：proposalSimilarity(content, 任一 rejected self_identity 行内容) ≥ contradictionThreshold → 矛盾，不采纳（计数 autoBlocked；state 留 pending，stage-1 晋升语义不受影响）；
  3. **非槽内重复**：proposalSimilarity(content, 任一现行槽行) ≥ dupThreshold → 重复，跳过（autoSkipped）。
- **采纳**（逐位镜像 #82 人审链 v2-router.ts:2435-2450，source 改 "auto-adopt-gate"）：readCore(tenant) 取现行槽 content → escapeXmlTags 按行拆分消毒 → mergeIdentityFacts 合并（单一源，槽行守恒 slice(-8)）→ 合并输出与槽逐字节相同则跳过写槽（幂等零 version 空转）→ upsertCore("self_identity", merged, "auto-adopt-gate", tenant) → decidePendingCoreAuto(pid, tenant, prev) → state='auto_adopted'。
- **审计与回滚**：attrs_json.auto_adopt = { adopted_at, gate:{votes,span,contradictionThreshold,dupThreshold}, prev_slot_content, prev_slot_version }。回滚**复用既有 decide 路由**：decision=rejected 打在 state='auto_adopted' 行上 → router 走 rollbackAutoAdoptedPending(pid, tenant)——版本守卫（现行槽 version ≠ 快照 version → 拒绝 422 提示手工处理；相等 → 恢复 prev_slot_content + state='rejected'，零删除，recurrence/attrs 证据全留）。Panel 零 API 变更（reject 按钮即回滚入口）。
- **观测**：拍级日志行 `[lifecycle] self_identity auto-adopt adopted=X blocked=Y skipped=Z`（同 #91 观测夹带口径）；autoAdopt 缺省关 → 块整体旁路零调用。

## 2. config（config-first，缺省关）

```yaml
lifecycle.reflection.selfIdentityGate.autoAdopt:
  enabled?: boolean        # 缺省 false = 现状逐位（晋升只到 ready，人审不变）
  votes?: number           # N₂，缺省 4
  spanHours?: number       # T₂，缺省 72
  contradictionThreshold?: number  # 缺省 0.60
  dupThreshold?: number    # 缺省 0.75
```

- parse 白名单接线（config.selfidentity-gate.test 同款三态：显式透传 / 部分键不带 / 非对象宽容降级）；
- **生产启用由用户部署时显式写 yaml**——终审权变更的最后一道闸在部署面，AI 不代开。

## 3. 标定（起点，呈报后可固化/调整）

- **N₂=4、T₂=72h**：比 stage-1 ready（votes=3 ∧ span=72h）严一票——须跨 3 天持续复现才够格（「真实自我事实漂移率天然极低（慢变量）」口径）；#80 法在真实数据复核后呈报调整。
- **contradiction=0.60**：低于去重标准 0.75——矛盾检查宁拦勿收（误拦=退回人审，安全方向；漏拦=误收污染，不可自动修复）；**dup=0.75**：沿用 proposal-dedup 单一源标准。

## 4. 状态机扩展审计（#91 R1 教训强制项）

新 state 'auto_adopted' 全部字面量过滤点清单+处置：
- listPendingCore（缺省 state='pending' 过滤）→ auto_adopted 自然出局 ✓；
- sim-gate 语料（pending|expired）→ 不受影响 ✓；
- updatePendingRecurrence（pending|expired 才可计票）→ 已决行不可计票 ✓；
- K 阀 countSelfIdentityRecent（全 state 计数）→ 应含 auto_adopted，保持 ✓；
- Panel/API includeDecided（全量读）→ 自然可见 ✓；
- TTL sweep（state='pending'）→ 不碰 ✓。
回滚 = UPDATE state，零删除；recurrence_json/attrs_json 证据全留。

## 5. RED 合同（测试先行）

1. R1 flag off golden：autoAdopt 缺省 → auto-adopt 块零调用，现状逐位；
2. R2 三重门过 → 采纳链逐位（readCore→消毒→mergeIdentityFacts→幂等跳过→upsertCore source="auto-adopt-gate"→state='auto_adopted'）+ attrs 审计四字段 + 拍级计数；
3. R3 rejected 矛盾 → 不采纳，state 留 pending；
4. R4 槽内重复 → skip；
5. R5 回滚：版本相等 → prev_slot_content 恢复 + state='rejected'；版本漂移 → 拒绝（422，提示手工处理）；
6. R6 槽行守恒：IDENTITY_MAX_FACTS=8 语义随 mergeIdentityFacts 单一源，不旁路；
7. R7 config 接线三态（显式 / 部分 / 垃圾宽容降级）。

## 6. 对草案的一处收紧（如实偏差预告）

草案 RED5「回滚仅 UPDATE state」：仅翻状态时**被否事实仍留在人格槽内**——「误收污染不可自动修复」与「可回滚」自相矛盾。收紧为：采纳时快照 prev_slot_content/version 进 attrs_json，回滚 = 版本守卫下恢复快照 + 翻状态。代价 +1 store 方法 +2 用例，换「可逆」成真。

## 7. 交付面

- MemoryCore：lifecycle/auto-adopt-gate.ts（新）+ lifecycle-scheduler 挂块 + sqlite.ts（listReadySelfIdentityPending / decidePendingCoreAuto / rollbackAutoAdoptedPending）+ store/types.ts 签名注释 + config.ts 接线 + v2-router（decide 分支识别 auto_adopted+rejected → 回滚；采纳块镜像复用）；
- ADR-0007：身份槽确定性自动采纳门（约束变更记录：默认关 / 三重门 / 快照回滚 / 人转审计员）+ CONTEXT.md 身份槽词条补一行；
- 面板审计视图：**建议跟进票**（小白优先原则值得单独设计；因回滚复用 decide 路由，Panel 侧只剩「auto_adopted 徽标 + 列表可见」，跟进票很小）；
- 门：typecheck 243 基线逐位 + 双 vitest 全绿 + flag off golden 逐位；生产观察窗（用户部署 + 显式开 flag 后）：auto_adopted 精确率（零回滚占比）呈报后定线。

## 8. 拍板点（4 项，均有推荐默认）

| # | 拍板点 | 推荐 | 说明 |
|---|--------|------|------|
| 1 | N₂ / T₂ | **4 / 72h** | 比 ready 严一票；跨 3 天复现才够格 |
| 2 | 矛盾/重复阈值 | **0.60 / 0.75** | 宁拦勿收；dup 沿用单一源标准 |
| 3 | 回滚形态 | **快照+版本守卫**（收紧草案） | 仅翻状态回滚不净，见 §6 |
| 4 | 面板审计视图 | **跟进票** | 回滚复用 decide 路由后 Panel 余量很小 |

## 9. 边界

本文档 untracked 落盘 docs/research/；零代码改动；生产/yaml 零触碰；#92 保持 OPEN（认领人 cxin21）；测试一律临时 SQLite fixture，绝不触碰生产库。
