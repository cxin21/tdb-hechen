# 新壳覆盖审计：旧 Panel 的页签 / 页面 / 弹窗 / 权限 → 星图壳

> 目的：把 m00001 那条需求（「原 panel 的所有页签、页面信息和弹窗都需要在新的 ui 中体现，注意权限、登录页面，团队、用户和 agent」）逐条落到 path:line 证据上，并列出仍未覆盖的项。
> 取证时间：2026-11-11。全部条目由读源码得出；标「未验证」者表示没有在真接口 + 真登录下点过。

## 0 结论速览

| 维度 | 旧壳 | 新壳 | 状态 |
| --- | --- | --- | --- |
| 登录门 | App 层 `LoginGate` | 同一层，未复制第二套 | 共用通过 |
| 顶层页签 | 9 个（wiki / code / skills / chat_memory / soul / team_members / team_agents / api_keys / settings） | 星图 5 站 + 团队 3 段 + 设置 1 站 = 9 个落点 | 全覆盖 |
| 页面级页签 | 记忆 3 档、人格 6 面、wiki/code/skills 各自 scope 双档 | 记忆 2 档（含新回放日志）、人格 7 面 + 版本链、知识 6 段、代码 3 段 | 除 G1 全覆盖 |
| 写操作弹窗 | 8 个业务弹窗 | 旧弹窗全部换壳；5 处动作内联进站页 | 见 §3.7 |
| 权限 | `useCurrentRole()` = isGlobalAdmin ? admin : roleInTeam | 团队站/设置站显式判角色，写接口仍由后端裁决 | 部分，见 G6 |
| agent 切换 | 每页各自 scope 段 + agent 下拉 | `ScopeBar` 一处切换，星图整体重绘 | 见 §4 |

## 1 路由与登录

- 新壳：`MemoryPanel/web/src/routes/index.tsx:32-46` —— `StarmapProvider > StarmapLayout`，子路由 `memory / soul / wiki / code / skills / team/members / team/agents / team/api-keys / settings`，`*` 留空回星图。
- 旧壳：`MemoryPanel/web/src/routes/index.tsx:48-63` —— `/legacy` + `ConsoleLayout` + 九页；顶层 `*` → `Navigate to="/"`。
- 登录门在 App 层而不是路由层：`MemoryPanel/web/src/App.tsx:19` 引入 `LoginGate`，`:61` `return <LoginGate onLoggedIn={(a) => setAuth(a)} />`（`auth === undefined` 表示确认未登录）；`MemoryPanel/web/src/stores/auth.ts:14` 记录同一约定，`:72` 401 或其他 tab 登出 → 删 `tdai-panel.session` → 回 `LoginGate`。
- 判据：新壳没有另造登录页，登录这条要求由既有实现覆盖；改面板不重写登录。

## 2 四朵云 + 人格恒星的语义（对应 m00001 的星图设计）

| 星云 | 星点 | 亮/暗 | 关系边 | 证据 |
| --- | --- | --- | --- | --- |
| 人格恒星云 | 人格卡 + 九块 + 六轴 + 人物档案 + L3 养料 | 有内容即亮，缺块降级为暗 | `compose` 卡→九块 / `state` 轴 / `archive` 人物 / `feed` L3 | `starmap/scene/PersonaCanvas.tsx` |
| 记忆星云 | L0 / L1 / L2 / L3 条目 | 归档或遗忘为暗（`--star-dim`），否则层色 | L1 相邻同会话 → `同会话`；引用命中 → `引用`；出自原文 → `出自原文` | `starmap/scene/cloudPage.ts:104-124` |
| 知识星云 | wiki 页面块 | 挂到本 agent 亮，团队可见暗 | 页间引用 `引用` | `starmap/scene/cloudPage.ts:284-291` |
| 代码星云 | 文件 / 类 / 函数 / 方法 | 同上 | `calls / imports / contains` | `starmap/scene/cloudPage.ts:326-333` |
| 能力星云 | 每个 skill 一个星点 | `owner_agent_id === activeAgentId` 亮，否则暗 | 无（技能之间没有内核关系） | `starmap/stations/SkillsStation.tsx` |
| 边绘制 | — | 选中时只留 hot 边 | `starmap/scene/CloudCanvas.tsx:384-396`；hover 用边算 related `:478-483` | 同左 |

暗星色已从 `#41506e`（对比度 2.39，低于 3:1）改为 `#66799b`（4.38）：`starmap/scene/CloudCanvas.tsx` 暗星分支。

## 3 旧页签 / 页面 → 新壳落点

### 3.1 记忆（旧 `pages/ChatMemoryPage/index.tsx:18-44`）

| 旧 | 新壳 | 证据 |
| --- | --- | --- |
| 页级 3 档 `memory / graph / journal`（`:28-31`） | 记忆站 2 档 `blocks / journal` | `starmap/stations/MemoryStation.tsx` + `starmap/stations/recallJournal.tsx` |
| 记忆块：L0–L3 分层列表 | 云页 + 站内分层 `Row`，层色短线标识选中 | `starmap/scene/CloudSideCard.tsx` |
| 图谱（Sigma 只读图） | 星图本身承载关系边与关联高亮（G1） | `starmap/scene/CloudCanvas.tsx:384-396` |
| 回放日志 `RecallJournalView` | 新写 `RecallJournalPanel`（不 import 旧组件） | `starmap/stations/recallJournal.tsx` |
| 块 scope `team/fixed` + agent 下拉（`ChatMemoryPanel.tsx:246-266`） | 全局 `ScopeBar` | `starmap/kit/ScopeBar.tsx` |
| 个人范围 `shared/private`（`ChatMemoryPanel.tsx:381-386`） | 未单独暴露（G2） | — |
| `AllocateMemoryDialog⟧ / `ImportBlockDialog` 等 | 深操作经「旧控制台」入口 `/legacy/memory` | `starmap/StarmapLayout.tsx` 抽屉头按钮 |

### 3.2 人格（旧 `pages/SoulPage/index.tsx:35-40`）

| 旧 6 面 | 新壳 |
| --- | --- |
| 感受 | 完整视图 · 感受（`moodRead` + 基调标签 + 判定依据 KvList；`tier=null` 不补 0） |
| 情绪明细 | 完整视图 · 情绪 |
| 人物 | 完整视图 · 人物 |
| 人格卡 | 完整视图 · 人格卡 + 右侧星点详情 |
| 身份双槽 | 完整视图 · 身份（三态 active / fallback / empty，复用 `identity-utils.narrativePreviewOf`） |
| 版本链 | 独立 `Dialog`（版本列表 + 切换） |

另新增「特质」「注入」两面（六轴状态与注入统计）。证据：`starmap/stations/SoulStation.tsx` 的 `Section` 七值。

### 3.3 知识 wiki（旧 `pages/WikiPage/components/WikiSourcesPanel.tsx`）

| 旧 | 新壳 |
| --- | --- |
| scope `team/fixed` + agent 下拉（`:277-297`） | `ScopeBar` |
| 状态筛选 all/ready/processing（`:330-338`） | 云页左栏筛选 + 站内资产列表 |
| 卡片 / 列表视图切换（`:339-346`） | 未做（统一列表，G3） |
| 上传 / Git 建源两档（`:654-660`） | 站内「来源」段（地址 + 分支可改、测试连接、重新拉取） |
| 分支探测（`:595`） | 站内「来源」段的重新探测（`testSource` + `refetch`） |
| 页面管理 / 原始文档 / 检索 | 站内 `pages / raw / search` 三段（`starmap/stations/knowledgeDeep.tsx`） |

### 3.4 代码（旧 `pages/CodePage/components/CodeSourcesPanel.tsx:110-191`）

| 旧 | 新壳 |
| --- | --- |
| scope 双档 + agent 下拉 | `ScopeBar` |
| 状态筛选 all/ready/processing/error | 云页左栏 |
| 卡片 / 列表切换 | 未做（G3） |
| 图谱同步 / 代码检索 | 站内 `structure`（结构分页 + 节点详情）与 `search`（检索 / 探索两模式） |
| 图谱画布 | 只在云页，站内无独立画布（G4） |

### 3.5 能力 skills（旧 `SkillsPanel.tsx:103-126`、`useSkillsPanel.ts:282-322`）

| 旧 | 新壳 |
| --- | --- |
| scope `team/fixed` + agent 下拉 | `ScopeBar` |
| `shared/private` 视图（`:258-263`） | 站内范围 `Seg`（已挂载 / 全部） |
| `ForkSkillDialog` / `ImportSkillDialog` | 挂载 / 移除内联（无弹窗）：fork = 复制副本到目标 agent；移除 = 归档该副本。依据 `lib/api/skills.ts:12-15`「让 skill 真正归属某 agent 的唯一机制是 fork」 |
| 详情（清单 / 文件 / 版本） | 右侧星点详情 + 资源文件与清单折叠区 |

### 3.6 团队三页 + 设置

新壳 `starmap/stations/TeamStation.tsx` 用一段 `Seg`（成员 / 智能体 / 密钥）承载前三页，全部走 `membersApi / agentsApi / userKeysApi`，12 个端点齐全，写动作全部两段式（确认移除 / 确认删除 / 确认吊销）；明文密钥只在创建响应出现一次（`NewKeyNote`）。

设置：`starmap/stations/SettingsStation.tsx` 为只读概览（知识服务 / 记忆服务 / 本地重排模型），编辑入口指向 `/legacy/settings`。理由：旧配置目录 `pages/SettingsPage/configCatalog.ts` 2968 行，未逐项对齐前不重写第二遍（G5）。

### 3.7 弹窗清单

旧 8 处：`components/SettingsDialog.tsx`、`components/asset/AllocateAssetDialog.tsx`、`components/team/{AgentEditDialog,CreateAgentDialog,CreateTeamDialog,DefaultAgentTemplateDialog,EditTeamDialog}.tsx`、`pages/ChatMemoryPage/components/{AllocateMemoryDialog,ImportBlockDialog}.tsx`、`pages/SkillsPage/components/{ForkSkillDialog,ImportSkillDialog}.tsx`。

- 已换壳：旧 `theme/ui.tsx` 的 `Dialog` 已改为 kit `Dialog`（Esc、遮罩点击、焦点陷阱、还原焦点、`aria-modal`、滚动锁），旧页里所有弹窗自动获得新行为。
- 新壳原生：人格版本链、人格完整视图、智能体编辑、密钥新建结果。
- 新壳不重做：资产分配、记忆导入、skill fork 的弹窗形态（改为内联动作或旧控制台入口）。

## 4 agent 级与切换

- 星点集合按 `agentId` 取：`starmap/state/StarmapProvider.tsx` 提供 `teamId / activeAgentId / activeBlockId`，云页与各站全读它；切换 agent 让资源层 generation +1 并丢弃旧响应。
- 缓存 key 第一段 userId、第二段 team、第三段 agent：`starmap/cache/apiCache.ts` 的 `cacheKey(...)`，因此切回原 agent 命中旧结果（`starmap/cache/__tests__/apiCache.test.ts` 覆盖）。
- 团队级资源（wiki / code / skills 团队视图）agent 段写 `-`。

## 5 未覆盖项（GAP）

| 编号 | 缺口 | 影响 | 依据 |
| --- | --- | --- | --- |
| G1 | 旧「记忆图谱」档没有独立入口，靠星图本身表达 | 想要大图 + 分区聚类的读者只能看云页 | `ChatMemoryPage/index.tsx:18-44` |
| G2 | 记忆块 `shared/private` 个人范围未在新壳暴露 | 该筛选需回旧控制台 | `ChatMemoryPanel.tsx:381-386` |
| G3 | wiki / code 卡片视图未做 | 只影响版式偏好 | `WikiSourcesPanel.tsx:339-346` |
| G4 | 代码图谱画布只在云页 | 站内无法做图内跳转 | `CodeSourcesPanel.tsx` |
| G5 | 设置只读 | 改配置必须去 `/legacy/settings` | `SettingsStation.tsx` 无 `settingsApi.set` |
| G6 | 权限只有显式门；团队成员无改角色端点 | 非 admin 见只读态 | `lib/api/teams.ts` 只有 list / add / remove |
| G7 | 新站与新面板只在假数据 + 离线预览下验过，未在真接口 + 真登录下端到端点过 | 真实空态 / 长文本 / 权限分支未验 | 见台账 §17.5 |
| G8 | wiki `ingestWithPolling` 的 10 分钟轮询只在源码层接上，未真跑 | 首次编译链路未验 | `knowledgeDeep.tsx` WikiSourcePanel |

## 6 复用与不重写原则（避免下一轮再写一遍）

1. 内核语义不复制：身份三态用 `identity-utils.narrativePreviewOf`、分页窗口用 `kit/Pager.pageWindow`、错误文案用 `lib/error-message`。
2. 写路径不复制：新壳一律调既有 `lib/api/*`，写操作由传输层 `emitMutation` 广播作用域，缓存自行失效（`lib/api/write-scopes.ts`）。
3. 旧壳保留：`/legacy/*` 不删，作为深操作后备与回滚路径；新壳入口是星图，旧壳入口是抽屉头「旧控制台」。
