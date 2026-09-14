# Memory hub UI 优化 + wiki git 源管理 设计

> 文档标识：DS-PANEL-UI-WIKI-SOURCE-001
> 版本：v1.0-draft（用户已拍板：wiki 走 B 档；stale+手动重拉；归档开关过滤；记忆 UI 批 1 四件全做）
> 日期：2026-09-10
> 输入：本会话全部修复与新增能力（coreRef/valence/健康三件套/归档桶/values 写 API/derive/path）与现有 UI 的缺口映射

---

## 1. Part A · wiki git 源管理（B 档，扩展现有 WikiSourcesPanel）

### 1.1 现状
- Panel 已有 `WikiPage/components/WikiSourcesPanel.tsx` + `useWikiSources.ts`（源列表/上传）
- git 源的 url/branch **创建时定死**（git-fetcher.ts:74 `fetch(sourceUrl, branch, localPath)`；第一版仅公网 HTTPS，SSRF 校验在 SourceFetcherRegistry）
- MemoryKnowledge 侧 `routes/wiki.ts` 有源管理路由基础（WikiSourceManager + fetcherRegistry 可选注入）

### 1.2 能力（五项）
| 能力 | 行为 |
|---|---|
| 编辑 URL/分支 | git 源卡片"编辑"→ url/branch 可改；校验**复用 fetcherRegistry**（https-only + SSRF 不放宽）；保存后该源**全部页面标 stale**（"待重新拉取"徽标），**手动点"重新拉取"才重建**（不静默覆盖） |
| 测试连接 | `git ls-remote` 探测（秒级），返回可达性 + 远端分支列表（供编辑时下拉选择分支） |
| 暂停/启用 | `enabled` 开关；暂停后自动同步跳过该源（不影响已摄入页面） |
| 删除 | 确认框明示**连带删除已摄入页面** |
| 重新拉取 | stale 源的手动触发：完整走既有 ingest 管道（createThrottledProgressFn 进度上报复用） |

### 1.3 后端
- MemoryKnowledge `routes/wiki.ts` 新路由：
  - `PATCH /wiki/:id/source`（url/branch/enabled 更新 + 校验 + **该源页面标 stale**）
  - `POST /wiki/:id/test`（ls-remote 探测）
  - `POST /wiki/:id/refetch`（全量重建，走既有 ingest）
  - `DELETE /wiki/:id`（连带页面删除）
- 数据模型：wiki source 记录增 `enabled: boolean`（默认 true）与 `stale: boolean`（源信息变更置位、refetch 成功清除）
- 校验：全部复用 SourceFetcherRegistry（SSRF/https-only 零放宽）

### 1.4 Panel
- `WikiSourcesPanel` 每源卡片操作区：编辑（行内表单）/测试/暂停/删除/重新拉取（stale 时高亮）
- `useWikiSources.ts` 增对应 mutation

---

## 2. Part B · Memory hub UI 优化（批 1 四件）

### 2.1 BlockDetail 扩展
- soul 徽章旁新增：coreRefs 价值标签（`metadata.coreRefs` → 锚 label 展示）、valence/recall_count（metadata 读回）、**归档态徽标**
- 数据源：既有 BFF 详情接口补透传（archive 态从 /atomic/archive/list 或详情接口增 archived 字段——实现时按最小改动择一）

### 2.2 归档可见 + 一键恢复
- 时间轴加"显示已归档"开关（**默认隐藏**）；归档项带"已归档"徽标 + "恢复"按钮（调 /v3/atomic/archive/restore）
- 恢复后从归档视图消失、回主时间轴

### 2.3 系统健康条
- ChatMemoryPanel 顶部细条：vectorCoverage%（/health 的 memory 块，T15 现成）+ embedding ok/degraded
- **degraded 时黄条**："向量召回降级（FTS 兜底中）"——把 T15 的降级可见性从注入块延伸到 UI

### 2.4 价值锚编辑面板
- 列出当前租户价值锚（label/weight/valence 方向徽标）+ 编辑（label/weight/valence 微调，S1 upsert API）+ "重新总结方向"按钮（C2 derive 路由）+ 删除（S1 delete）
- 落点：ChatMemoryPage 内新小面板（或 Settings 页签——实现时按现有导航惯例择一）

### 2.5 数据与权限
- 全部走既有 BFF→网关链路（metadata-instances.json api_key 与网关 server.apiKey 已同源）
- 写操作（恢复/价值锚编辑）受网关鉴权保护，Panel 无需新增鉴权逻辑

---

## 3. 实现顺序与规模
1. Part A wiki 源管理（后端路由 + Panel 扩展）—— 约 1 天
2. Part B-2.3 健康条 —— 最小，先行
3. Part B-2.1/2.2 BlockDetail+归档 —— 1 天
4. Part B-2.4 价值锚面板 —— 半天
- 全部走既有 BFF/网关路由模式；无新表、无后端数据结构破坏性变更（仅 wiki source 增 enabled/stale 两字段）

## 4. 验收
- wiki：编辑 URL/分支 → stale 徽标 → refetch 重建 → 测试连接/暂停/删除全链路
- 记忆 UI：归档开关/恢复/健康条降级态（可临时停嵌入配置验证）/价值锚编辑+derive
- 回归：Panel vitest、MemoryKnowledge 路由测试、既有 ChatMemoryPage 测试
