# 灵魂管线 Phase 1 实施计划（身份自发现 + 三段组装器 + 感受层修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本会话内联执行——用户已裁定不派子代理）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 落地 DS-SOUL-PIPELINE-001 轨道 1——灵魂公式三段式组装器 + 身份自发现提案制 + 感受层 valence 修复，使注入块从"检索堆叠"变为"灵魂状态组装"。

**Architecture:** 三段式注入块（身份段/记忆段/感受段）+ IdentityDiscovery worker（GROW 模式复用：扫描→提案→分级门→写入）+ valence derive 路径解除限制。

**Tech Stack:** Node 22 / node:sqlite / tsx / vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-soul-pipeline-design.md`（DS-SOUL-PIPELINE-001）

## Global Constraints

- 排序路径零变更（本 Phase 不碰九通道/RRF/精排——轨道 2 等 P5）
- config-first：新增开关缺省 = 逐位现状
- K 信任边界红线：core_value/strict_rule 提案永不自动写入（分级门）
- tsc 基线 244 持平（不扩预存量）；vitest 全绿
- 云端纪律（sudo -u tdai / sudo -H -u tdai git）

---

### Task 1: 感受层 valence derive 修复

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（deriveValueValences 的 llm 调用传 timeoutMs: 0 / maxTokens: 0）
- Test: 集成验证（derive 后 core_values.valence 非 NULL）

**Interfaces:**
- Produces: 4 锚 valence 非 NULL → 感受层 moodSign 可用

- [ ] **Step 1: 定位 derive 的 llm 调用**——grep `deriveValueValences` 在 sqlite.ts 中的 llmRunner.run 调用，传参处加 timeoutMs: 0 / maxTokens: 0（0 = 不限制，llm-runner P2.1 语义）
- [ ] **Step 2: 重启后验证**——core_values.valence 非 NULL 行 ≥ 4
- [ ] **Step 3: Commit** `feat(SOUL): valence derive 解除 LLM 限制（感受层方向补齐）`

---

### Task 2: 身份自发现模块（IdentityDiscovery）

**Files:**
- Create: `MemoryCore/src/core/lifecycle/identity-discovery.ts`（GROW 模式复用）
- Modify: `MemoryCore/src/core/lifecycle/lifecycle-scheduler.ts`（挂钩）
- Modify: `MemoryCore/src/core/store/types.ts`（IdentityDiscoveryConfig 接口）
- Modify: `MemoryCore/src/config.ts`（`memory.coreMemory.identityDiscovery` 解析：enabled 缺省 false / minEvidence 缺省 3 / intervalHours 缺省 24）
- Test: `MemoryCore/src/core/lifecycle/__tests__/identity-discovery.test.ts`

**Interfaces:**
- Produces: `runIdentityDiscovery({ store, llmRunner, config, logger })` → `{ ran, adopted, pending }`
- 分级门：`identity` slot → 多源一致 ≥3 + observed → auto 写入；`core_value`/`strict_rule` → pending（不上库，产出提案列表供 Panel）

- [ ] **Step 1: 失败测试**——①identity 多源一致自动采纳；②core_value 提案进 pending 不写库；③冷却/去重
- [ ] **Step 2: 实现**（采样→LLM 提案→证据重算→分级门→store.upsertCoreMemory / pending 列表）
- [ ] **Step 3: scheduler 挂钩**（anchor-growth 同款，config 透传）
- [ ] **Step 4: 测试全绿 + tsc 持平** → **Step 5: Commit**

---

### Task 3: 三段式灵魂组装器

**Files:**
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts`（performLayeredRecall 返回后、注入块组装段重构成三段）
- Test: 组装器输出包含三段标题 + 身份段内容 + 感受段内容

**Interfaces:**
- Consumes: core_memory read（slots）、core_values（锚）、current-feeling（appraisal）、searchResult（经验层）
- Produces: 三段式 `<soul>` 注入块（替换现有 `<relevant-memories>` 单块）

- [ ] **Step 1: 组装重构**——`<relevant-memories>` → `<soul>` 三段（此刻的你/过去的记忆/当下的感受），身份段从 `/v3/core-memory/read`（store.readCoreMemory）取 slots + 锚列表
- [ ] **Step 2: 维度标注**——经验行格式增加 `[活动时间|certainty]` 前缀
- [ ] **Step 3: 测试**——三段标题存在、身份段非空时包含 slots 内容、感受段包含 fired 标签、无身份时该段省略（宁缺毋滥）
- [ ] **Step 4: tsc + 回归** → **Step 5: Commit**

---

### Task 4: 回归、部署与收尾

- [ ] tsc 244 持平 + vitest 全量 + Lane 2 重跑逐位不变（组装器重构不改排序/过滤语义，只改注入块文本形态）
- [ ] `sudo systemctl restart tdai-core` → health 200 → 身份段/感受段实测
- [ ] CHANGELOG 登记 + `sudo -H -u tdai git push`
- [ ] **剩余待设计/完成项登记**（本文件 §5 已有，迁移至项目台账）

---

## 剩余待设计与完成项登记（P4/P5/记忆召回/情感检索）

| 项 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P4** | 受控正文演化（evolution-worker 五条件门+审计边）+ **L2 失效传播**（L1 失效 → scene_blocks/persona 重蒸馏，含 persona.md Nacos 残留清理） | conflict 观察期数据 | 已计时 |
| **P5** | 排序校准合成（九通道+R10+情感+失效 → yaml 权重）→ 价值通道解禁 | 语料 ≥1200 + 判官软轨 | 待语料 |
| **记忆召回优化** | 九通道校准回归 + 邻居/PPR/图的维度贯通 + recordIds O(N)→索引路径 | P5 校准产物 | 待 P5 |
| **情感记忆检索** | valence/arousal 联合检索加权（R10 A/B 载体：判官软轨） | 判官软轨建成 | 待语料 |
| **身份 GROW-MAINT** | slots 的重验证/权重演化/退场（与锚同构） | Phase 1 交付后 | 待一期 |
| **LLM 空响应 fail-loud** | StandaloneLLMRunner 空 text 静默返回改 fail-loud（本问题静默两天才被发现） | 独立小任务 | 待做 |
| **[DEBUG-GROW]/[DEBUG-CFG] 插桩清理** | 观测点转正式日志或移除 | P4 修复后 | 待 P4 |
