# Memory hub UI 视觉重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。任务间队长审查 + fix round。
**Goal:** 记忆 UI 视觉重构——灵魂字段/价值/方向/关联/健康全部可视化，数据零后端新增。
**Spec:** `td-agemem/docs/superpowers/specs/2026-09-10-memory-ui-visual-redesign-design.md`（执行者与 spec 同读；Surface 编号 S1-S6 沿用）。
**Tech Stack:** MemoryPanel web (React + tea-component + Sigma/graphology)、BFF (Hono)、vitest。

## Global Constraints
- 零后端新增：全部数据源已在生产（spec §1 映射表）；仅 BFF 透传/聚合允许
- BlockDetail 拆分**行为不变**（渲染重排，既有 soul/时间轴/graph/相关记忆功能全保留）
- 组件体系：tea-component；样式沿用 `_memory-*` 前缀；新组件文件按职责拆分
- 推理验证先行（报告前节）；Panel vitest（BFF 层）；web 渲染层无自动化——如实登记留人工验收
- 不碰 D:/tdai-data、不重启生产进程（收口队长统一）、不派生子代理
- MemoryGraphView 的 Sigma 边 type 恒 'line'（f53b173 修复，勿回退）

---

## 批 1 · BlockDetail 拆分 + 灵魂区 + 记忆卡片增强

### Task U-A1: 灵魂区组件（SoulSection）+ BlockDetail 接线
**Files:**
- Create: `MemoryPanel/web/src/pages/ChatMemoryPage/components/block-detail/SoulSection.tsx`
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/BlockDetail.tsx`（拆出灵魂数据展示段 :238 附近，接线新组件）
- Create: `MemoryPanel/web/src/pages/ChatMemoryPage/components/block-detail/soul-utils.ts`（valence 双色条百分比/方向/recall 格式化纯函数）
- Test: BFF/纯函数 vitest

**Interfaces:**
- Consumes: 条目级 soul 数据（BlockDetail 既有 L1 条目形状：occurred_at/valid_start/valid_end/certainty/source/valence/arousal/significance + metadata.coreRefs/recall_count——C1/896ee5d 已在出参）
- Produces: `SoulSection({ soul }: { soul: SoulView })`；`buildSoulView(item): SoulView`（soul-utils 导出，批 2 图详情复用）

**Steps:**
- [ ] soul-utils：buildSoulView 纯函数（valence 百分比/极性、arousal/significance 归一、coreRefs 解析、recall 展示值、时间格式化）+ vitest
- [ ] SoulSection 组件：⏱ 时间行/情感双色条/强度+重要性进度条/可信徽章+来源/🎯价值 chips/🔥recall 行
- [ ] BlockDetail 接线：L1 条目详情处渲染 SoulSection（既有 soul 段替换为组件调用，行为=展示增强）
- [ ] vitest 断言 + Commit: `feat(panel): U-A1 灵魂区 — soul 8 字段可视化组件（S2 拆分第一步）`

### Task U-A2: 记忆卡片增强（S1）
**Files:**
- Modify: `ChatMemoryPanel.tsx`（renderItem 增强）、`MemoryPanel/web/src/pages/ChatMemoryPage/components/block-detail/soul-utils.ts`（复用 buildSoulView 的卡片摘要变体）
**Steps:**
- [ ] renderItem：valence 双色条/coreRef chips/recall 火苗/归档徽标/⏰significance
- [ ] 数据：卡片 items 需带 metadata——BFF 列表接口透传核对（search 出参已有；列表若走 query 同样已透传）
- [ ] vitest + Commit: `feat(panel): U-A2 记忆卡片增强 — 情感条/价值chips/回忆火苗/归档徽标`

### Task U-A3: 关联区组件（RelatedSection）+ getPath 接入
**Files:**
- Create: `components/block-detail/RelatedSection.tsx`
- Modify: `BlockDetail.tsx`（相关记忆段迁移 + getPath 链路查询入口）
- Modify: BFF 透传 `/v3/atomic/path`（S5 路由现成）
**Steps:**
- [ ] BFF 透传 path 路由
- [ ] RelatedSection：邻接列表（现状迁移）+ "关联链"查询（选两节点 → getPath 可视化）
- [ ] vitest + Commit: `feat(panel): U-A3 关联区组件化 + getPath 关联链`

## 批 2 · 记忆图语义通道 + 价值锚面板

### Task U-B1: 记忆图语义通道
**Files:** Modify `MemoryGraphView.tsx`、`BlockDetail.tsx`（传参）
**Steps:**
- [ ] 节点金色描边：coreRef ∩ 当前查询价值（appraisal 复用或简化：价值 label 子串命中 query）→ sigma nodeReducer 描边
- [ ] valence 色相偏移：nodeReducer 按 valence 调色相（正偏绿/负偏红）
- [ ] 边箭头：evolve/conflict type 边加箭头（Sigma edgeType——**注意 f53b173 教训**：type 只能是注册过的程序名；箭头用 Sigma 内置 'arrow' 需确认可用性，不可用则用端点三角形自绘或退化为颜色标记——实现者先验证再落）
- [ ] 详情卡：补 coreRefs/valence/方向/recall_count
- [ ] 图例扩展
- [ ] Commit: `feat(panel): U-B1 记忆图语义通道 — 价值描边/valence 色相/方向箭头/详情扩展`

### Task U-B2: 价值锚面板（ValueAnchorsPanel）
**Files:** Create `components/ValueAnchorsPanel.tsx`、BFF 透传（values list/upsert/delete/derive——网关现成）、挂载 ChatMemoryPage
**Steps:**
- [ ] BFF 透传四路由
- [ ] 面板：列表（label/weight 进度条/valence 徽标/关联记忆数——coreRef 反查走 search）/行内编辑/valence 三态/derive 按钮/删除确认
- [ ] vitest + Commit: `feat(panel): U-B2 价值锚面板 — 列表/微调/重新总结方向/删除`

## 批 3 · 健康条增强 + wiki 样式

### Task U-C1: 健康条增强
**Files:** Modify `ChatMemoryPanel.tsx`（MemoryHealthBar → 进度环 + 悬浮详情）、chat-memory-panel.css
**Steps:**
- [ ] 覆盖率迷你进度环（SVG）+ degraded 黄条悬浮详情（degradedSince/原因）
- [ ] Commit: `feat(panel): U-C1 健康条增强 — 进度环/悬浮详情`

### Task U-C2: wiki 源管理样式统一
**Files:** Modify `WikiSourcesPanel.tsx`、`wiki-sources-panel.css`
**Steps:**
- [ ] 操作区对齐 tea-component Modal/Button 风格；编辑弹窗组件化；stale 徽标对齐 `_memory-badge` 体系
- [ ] Commit: `feat(panel): U-C2 wiki 源管理样式统一`

## 收口（队长）
- [ ] Panel web 构建 + 全量 vitest + 重启验证 + 人工链路（登记清单）
- [ ] CHANGELOG 登记

## Self-Review
- Spec 覆盖：S1=U-A2、S2=U-A1/A3、S3=U-B1、S4=U-B2、S5=U-C1、S6=U-C2 ✅
- 依赖：U-A1 先于 U-A2（soul-utils 共享）；U-B1 依赖 C1 数据（已在生产）；U-B2 依赖 S1/C2 路由（生产已有）
- Sigma type 红线：U-B1 箭头实现前必须验证可用性（f53b173 教训），不可用则退化方案已给
