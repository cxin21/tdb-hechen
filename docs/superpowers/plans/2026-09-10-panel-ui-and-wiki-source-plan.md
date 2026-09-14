# Memory hub UI 优化 + wiki git 源管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** wiki git 源在 UI 可编辑（URL/分支/暂停/删除/测试连接/重新拉取）+ Memory hub UI 展示新记忆结构（coreRef/valence/归档/健康条/价值锚编辑）。

**Architecture:** 全部走既有链路——MemoryKnowledge `routes/wiki.ts` 加源管理路由（复用 WikiSourceManager + SourceFetcherRegistry 校验）；Panel 走既有 BFF→网关链路（metadata-instances.json api_key 已与网关 server.apiKey 同源，鉴权零新增）。无新表。

**Tech Stack:** MemoryKnowledge (routes/manager)、MemoryPanel (React + BFF)、MemoryCore /health（T15 已有 memory 块）。

**Spec:** `td-agemem/docs/superpowers/specs/2026-09-10-panel-ui-and-wiki-source-design.md`（执行者与 spec 同读；stale+手动重拉、归档开关默认隐藏、价值锚 LLM 初值+微调三项拍板以 spec 为准）。

## Global Constraints
- git 源校验复用 SourceFetcherRegistry（https-only + SSRF 零放宽）
- 改 URL/分支后：该源页面标 stale（"待重新拉取"徽标），**手动**点重新拉取才重建——不静默覆盖
- 归档记忆默认隐藏（开关显示）；价值锚方向 = valence 列（LLM 初值 + 用户微调优先，LLM 永不覆盖非 NULL）
- 纯增量（wiki source 只加 enabled/stale 两字段；无破坏性变更）
- 每任务 TDD + 推理验证先行（报告前节：数据流追踪+调用方穷举）；Panel 改动用 vitest；MemoryKnowledge 用既有路由测试模式
- 不碰 D:/tdai-data、不重启生产进程（收口由队长统一执行）

---

## Task 1: Knowledge 后端——wiki 源管理四路由

**Files:**
- Modify: `MemoryKnowledge/src/routes/wiki.ts`（grep 既有路由注册模式照抄）
- Modify: `MemoryKnowledge/src/engines/wiki/manager.ts` 或 `WikiSourceManager`（updateSource/pause/enable 方法——先读现有 create/list 实现确定落点）
- Modify: 源记录数据结构（enabled/stale 两字段，默认 true/false）
- Test: 沿用既有 wiki 路由测试文件（grep routes/wiki 的测试；无则新建）

**Interfaces:**
- Produces: `PATCH /wiki/:id/source`（body: {url?, branch?, enabled?}）、`POST /wiki/:id/test`（返回 {reachable, branches[]}）、`POST /wiki/:id/refetch`（走既有 ingest，返回进度）、`DELETE /wiki/:id`（连带页面）
- Consumes: SourceFetcherRegistry（校验）、WikiSourceManager（createThrottledProgressFn 的既有 ingest 链）

**Steps:**
- [ ] 先读：wiki source 记录的精确字段名（grep manager.ts 的 source 创建/存储段）与 routes/wiki.ts 的路由注册/响应信封模式
- [ ] 数据结构加 enabled/stale（默认 true/false），存量源读缺省=enabled
- [ ] PATCH：url/branch 变更 → 复用 fetcherRegistry 校验 → 更新 → **置 stale=true**；enabled 直接更新
- [ ] test：git ls-remote 探测（复用 git-fetcher 的校验逻辑，秒级）
- [ ] refetch：走既有 ingest 管道（复用 createThrottledProgressFn），成功后清 stale
- [ ] DELETE：连带删除已摄入页面（复用既有删除能力——先 grep manager 的页面删除方法）
- [ ] 测试：四路由 + 校验失败（私有地址/http 拒绝）+ stale 置位/清除 + enabled 过滤
- [ ] Commit: `feat(wiki): 源管理路由 — 编辑/测试连接/暂停启用/删除/重新拉取（stale 语义）`

## Task 2: Panel——WikiSourcesPanel 源管理扩展

**Files:**
- Modify: `MemoryPanel/web/src/pages/WikiPage/components/WikiSourcesPanel.tsx`、`hooks/useWikiSources.ts`
- Modify: BFF 透传（MemoryPanel/panel/http/routes 中 wiki 相关路由——grep 既有透传模式照抄）
- Test: Panel vitest（组件测试模式照抄同目录既有）

**Interfaces:**
- Consumes: Task 1 的四路由（经 BFF 透传）
- Produces: 源卡片操作区（编辑/测试/暂停/删除/重拉）

**Steps:**
- [ ] BFF 透传四路由（api_key Bearer 已同源，零鉴权改动）
- [ ] useWikiSources 增 mutations（update/test/refetch/delete）
- [ ] 源卡片操作区 UI：编辑（行内表单 url/branch）/测试（结果展示可达+分支列表）/暂停开关/删除（确认框"连带删除已摄入页面"）/重拉按钮（stale 高亮）
- [ ] stale 徽标（"待重新拉取"）
- [ ] 测试：mutations 调用与 UI 状态
- [ ] Commit: `feat(panel): wiki 源管理 — 编辑/测试/暂停/删除/重新拉取（stale 徽标）`

## Task 3: 健康条（最小先行）

**Files:**
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/ChatMemoryPanel.tsx`（顶部细条）
- Modify: BFF 透传 GET /health（或直连网关 /health——按既有 BFF 模式择一）
- Test: Panel vitest

**Steps:**
- [ ] BFF 透传 /health 的 memory 子对象（T15 现成：vectorCoverage/embedding/degradedSince）
- [ ] 细条 UI：`向量覆盖 81% | 嵌入 ok`；degraded → 黄条"向量召回降级（FTS 兜底中）"
- [ ] 测试：ok/degraded 两态渲染
- [ ] Commit: `feat(panel): 记忆健康条 — vectorCoverage/embedding 状态/降级黄条`

## Task 4: BlockDetail 扩展 + 归档开关 + 恢复

**Files:**
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/BlockDetail.tsx`、`ChatMemoryPanel.tsx`（归档开关+徽标+恢复按钮）
- Modify: BFF（归档列表/恢复透传——/v3/atomic/archive/list|restore 网关现成）
- Test: Panel vitest

**Steps:**
- [ ] BlockDetail：coreRefs 价值标签（metadata.coreRefs → 锚 label）、valence/recall_count 行、归档徽标
- [ ] 时间轴"显示已归档"开关（默认隐藏）；归档项徽标+"恢复"按钮（调 restore）
- [ ] 测试：coreRefs/归档徽标/开关过滤/恢复调用
- [ ] Commit: `feat(panel): BlockDetail 扩展 + 归档可见与一键恢复`

## Task 5: 价值锚编辑面板

**Files:**
- Create: `MemoryPanel/web/src/pages/ChatMemoryPage/components/ValueAnchorsPanel.tsx`
- Modify: `ChatMemoryPage/index.tsx`（挂载入口——按现有导航惯例）、BFF 透传（values upsert/delete/derive——S1/C2 网关路由现成）
- Test: Panel vitest

**Steps:**
- [ ] 列表：label/weight/valence 方向徽标（+1 推进/-1 审慎/未判定）
- [ ] 编辑：label/weight 行内改 + valence 三态下拉（微调）；"重新总结方向"按钮（derive）
- [ ] 删除（确认框）
- [ ] 测试：列表渲染/编辑调用/derive 按钮/微调优先语义（改后 derive 不覆盖）
- [ ] Commit: `feat(panel): 价值锚编辑面板 — 列表/微调/重新总结方向（S1+C2 路由 UI 化）`

## 收口（队长）
- [ ] Panel web 构建 + 重启验证；全量回归（Panel vitest + MemoryKnowledge 路由测试 + MemoryCore verify 抽验）
- [ ] CHANGELOG 登记

## Self-Review
- Spec 覆盖：§1.2 五能力=Task 1/2；§2.1-2.4=Task 3/4/5；§1.3 校验复用=Task 1；stale 语义=Task 1/2
- 执行顺序依赖：Task 1 先于 Task 2（后端先于 UI）；Task 3/4/5 相互独立
