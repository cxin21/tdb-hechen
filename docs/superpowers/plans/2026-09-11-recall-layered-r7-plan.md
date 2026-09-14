# R7 分层召回 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
**Goal:** 召回升级为两层渐进披露——L2 结论常驻 + L1 经验按预算折叠，退化安全（无 L2 与现状逐位一致）。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-11-recall-layered-r7-design.md`（执行者与 spec 同读）。
**Tech Stack:** MemoryCore (auto-recall.ts 注入组装 / lifecycle-scheduler / sqlite.ts)、golden 锚点（recall-anchor.mjs）。

## Global Constraints
- 不变式：九通道/绝对门槛/租户隔离/T2 门/降级标注零变化；无 L2 命中 → 与现状逐位一致（退化安全）
- 幂等结论层：结论未变化的场景不重组（借团队幂等与防重模式：命中返回已存）
- 推理验证先行；TDD；两排序点覆盖；不派生子代理；不碰 D:/tdai-data/生产进程

## Task R7-1: L2 结论层选择与组装
**Files:** Modify `auto-recall.ts`（注入组装序列加 L2 层）、Create `recall-layered.ts`（L2 选择+预算切分纯函数）+ 测试
**Steps:**
- [ ] RED：分层断言（L2 命中→结论块前+经验折叠后/预算对半/无 L2→与现状逐位一致）
- [ ] L2 选择：query→场景结论匹配（沿既有 L2 注入匹配逻辑——grep 早期 title+snippet 通道）
- [ ] 幂等：结论未变化的场景不重组
- [ ] Commit: `feat(memory): R7-1 L2 结论层 — 渐进披露第一层（幂等/退化安全）`

## Task R7-2: L1 经验层（scene 反查 + 预算切分）
**Files:** Modify `auto-recall.ts`、`sqlite.ts`（如需 scene 过滤查询）
**Steps:**
- [ ] scene_name 反查：part_of 证据链 + 同 scene 过滤（T14 租户过滤）
- [ ] 预算对半切：结论层用剩给经验层
- [ ] 九通道排序在经验层照常（R1-R6/R8/R9）
- [ ] Commit: `feat(memory): R7-2 L1 经验层 — scene 反查/coreRef 辅助/预算切分`

## Task R7-3: golden 双锚
**Steps:**
- [ ] R7 前锚（现状最后状态）+ R7 后锚（分层形态）——锚点分化记录
- [ ] Commit: `chore(memory): R7 golden 双锚`

## 收口（队长）
- [ ] 全量回归 + 重启 + 注入块人工目检 + CHANGELOG
