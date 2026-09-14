# Memory hub UI 视觉重构 · 设计（"有灵魂的记忆"可视化）

> 文档标识：DS-PANEL-UI-VISUAL-001
> 版本：v1.0（用户已确认"开工"）
> 日期：2026-09-10
> 输入：本会话全部新增能力（coreRef/valence/归档/健康三件套/values 写 API/derive/getPath）与现有 UI 缺口映射（讨论记录）
> 铁律：**零后端新增**——全部数据源已在生产（metadata 透传 896ee5d/coreRefs/valence/archive 路由/values 写 API/derive//health memory 块）；纯 UI 工程

---

## 0. 设计理念

每条记忆不再是一行文字，而是一颗**有灵魂的节点**：何时发生（时间轴）、什么滋味（情感色）、为何重要（价值标签）、被用了多少（回忆火苗）、和谁相连（记忆图）、现在在哪（活跃/归档）。

## 1. Surface 与数据源映射（全部现成，零后端新增）

| UI 数据 | 来源 | 状态 |
|---|---|---|
| metadata.coreRefs / recall_count / valence / significance | /v3/atomic/query\|search 出参（896ee5d 已透传） | ✅ 生产 |
| 价值锚 CRUD + valence 微调 + derive | /v3/core-memory/values/*（S1/C2） | ✅ 生产 |
| 归档列表/恢复 | /v3/atomic/archive/list\|restore | ✅ 生产 |
| 健康块 vectorCoverage/embedding | GET /health memory 子对象（T15） | ✅ 生产 |
| getPath | /v3/atomic/path（S5/C6） | ✅ 生产（消费方=0，本批接入） |
| soul 8 字段 | atomic/query 出参（P2a/R4） | ✅ 生产 |

## 2. Surface 设计

### S1 · 记忆卡片（左列表）
标题 + 归档徽标；recall_count（🔥被回忆 N 次）；significance（⚡0.9）；coreRef 价值 chips（#正确 #私有部署）；**valence 双色条**（负红左/正绿右 + 数值）；certainty 徽章；id/用户/时间（现状保留）。

### S2 · BlockDetail 拆分 → "灵魂解剖面板"
1319 行巨型组件拆分（行为不变，渲染重排）：
- **头部**：标题 + 类型/归档/scope 徽标（现状）
- **🧠 灵魂区（新增组件 SoulSection）**：⏱ occurred_at/valid_range → 🎈 valence 双色条 + arousal/significance 进度条 → [实见/推断] 徽章 + source → 🎯 coreRef 价值 chips → 🔥 recall_count/last_recalled_at
- **🕸 关联区（RelatedSection，新增）**：邻接列表（现状）+ 🔗 getPath 两节点关联链（新数据源接入）
- **📄 内容区**：原文/编辑/时间轴（现状保留，L1 graph 切换入口保留）

### S3 · 记忆图语义通道
- 节点：size=significance（已有）、色=类型（已有）、**金色描边=coreRef 命中当前查询价值**（新增）、**色相偏移=valence**（正偏绿/负偏红，新增）
- 边：色/粗细（已有，type 恒 line——f53b173）、**evolve/conflict 加方向箭头**（新增）
- 详情卡：补 coreRefs/valence/方向/recall_count
- 图例：扩展新通道说明

### S4 · 价值锚管理面板（新组件 ValueAnchorsPanel）
列表（label/weight 进度条/valence 方向徽标/关联记忆数 via coreRef 反查）+ 行内编辑（label/weight/valence 三态）+ "重新总结方向"（derive）+ 删除（确认）。挂载 ChatMemoryPage。

### S5 · 健康条增强
覆盖率**迷你进度环**；degraded 黄条加悬浮详情（降级原因/时间）；embedding 徽章化。

### S6 · wiki 源管理样式统一
操作区对齐面板 tea-component Modal/Button 风格；编辑弹窗组件化；stale 徽标样式对齐记忆卡片徽标体系。

## 3. 批次
- 批 1：S2 拆分 + S1 卡片增强（最大）
- 批 2：S3 图通道 + S4 价值锚面板
- 批 3：S5 健康条增强 + S6 wiki 样式

## 3.1 裁决回写（2026-09-10 批 2 审查后，spec 为裁决权威）

1. **金色判据简化**：spec 字面"coreRef 命中当前查询价值"→ 实现"metadata.coreRefs 非空即金"（brief 择简授权；sigma v3 默认节点程序无描边属性，需 @sigma/node-border 才能描边——登记后续可选依赖）
2. **S4 关联记忆数豁免**：网关 atomic/search 无 coreRef 过滤参数，需新查询能力——本批不显示关联数，登记后续（需拍板网关侧加过滤参数）
3. **通道让位披露**：金节点整体覆盖基色（非描边），该节点上"类型色/valence 色相"两通道静默失效——图例/hover 需说明（批 2 审查 I-3，登记）
4. **引用关系**：wiki 源管理面板同时承载 WIKI-SOURCE-001（能力层）与本 spec S6（样式层）——两文档共同裁决
5. **Sigma arrow**：sigma v3.0.3 DEFAULT_EDGE_PROGRAM_CLASSES 出厂内置 arrow/line（运行时守卫测试锁定实际安装包）——f53b173 教训适用于业务类型串，不适用于注册程序名
## 4. 验收
- 每批 Panel vitest/BFF 测试全绿 + MemoryCore verify 抽验不回归
- 浏览器渲染层：收口人工链路验证（web 无组件测试基建，如实登记）
- 数据零后端新增
