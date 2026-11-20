# Panel 星图 · 组件与公共缓存设计

- 日期：2026-11-11
- 状态：设计定稿，待实施（S1 之前不改代码）
- 前置文档：`docs/specs/2026-11-10-panel-starmap-rewrite.md`（单页 HUD 与数据层冻结）、`docs/specs/2026-11-11-starmap-ui-test-cases.md`（验收用例）
- 本文只解决两件事：**组件怎么切**、**公共缓存怎么管**。数据面（`lib/api/*`、`services/*`、`stores/*`）与后端接口一个字不改。

## Problem Statement

星图界面已经能跑，但它是「三份重复实现 + 三处状态源」堆出来的：

1. 同一张「观测对象卡」写了三遍——`starmap/StarmapLayout.tsx` 左栏（335-358）、右栏星点卡（415-493），以及 `starmap/scene/CloudSideCard.tsx`（255-381）里进云后的作用域与星点卡，`starmap/scene/FiveBodies.tsx` 里还有第四份 `cards`。
2. 同一份作用域有三个来源：团队/智能体/记忆块在 `starmap/state/StarmapProvider.tsx`（49-72）；`cloud / entered / focus` 在 URL 参数（`StarmapLayout.tsx` 186-210）；`layer / from / to / pageNo` 是组件局部 `useState`（`CloudSideCard.tsx` 55-70）。
3. 结果是：改一处卡要改四遍；换智能体只有部分区域刷新；同一屏的两个数字可能来自不同时刻（用户已多次遇到「L0/L1 显示 0、数字对不上」）；点一颗星会让画布视角重置（已用 ref 止血，但根因是引擎状态没有单一归属）。

对用户的影响：界面看起来在同一个页面，实际是四套各自取数、各自缓存的小页面拼在一起的，任何一次口径调整都会出现「这块对、那块不对」。

## Solution

把星图界面重构成三层，层间只走一条契约：

- **作用域层（scope）**：团队 / 智能体 / 记忆块 / 云 / 层 / 时间窗 / 页码 七元组，**唯一真源**放在 Provider 里，URL 只做镜像。组件一律不持有作用域状态。
- **数据层（cache + hooks）**：所有取数走一个带 TTL/LRU/去重/取消的公共缓存；卡片只消费 hooks 的返回值。
- **展示层（cards + atoms）**：七张业务卡 + 一套共享原语（卡壳、分页、键值、关系列表、口径注脚、权限门），全部纯展示、只接 props。

用户可见的收益：换智能体整页一致刷新；任何一个数字都带「口径 + 时刻」注脚；星点详情是一张可折叠的卡，不再跳来跳去；团队与设置在星图上方盖卡，不离开画布；分页四云统一。

## User Stories

### 作用域与身份
1. 作为使用者，我想在顶栏看到当前观测的团队名与团队 ID、智能体名与智能体 ID、当前记忆块名，这样我能确认屏幕上的数字属于谁。
2. 作为多团队使用者，我想切换团队后所有云、所有计数、所有分页一起刷新，这样我不会把 A 团队的数据当成 B 团队的。
3. 作为多智能体使用者，我想切换智能体后星图整体重算且记住我上次选的智能体，这样刷新页面不用重选。
4. 作为使用者，我想记忆块只在忆云里出现（典籍云/构筑云/技艺云不显示块这一行），这样我不会误以为代码图谱挂在我的记忆块上。
5. 作为使用者，我想在面包屑上看到「团队 ▸ 智能体 ▸ 云 ▸ 层 ▸ 第 N 页」，并能一键回上一层，这样进了深页也知道怎么退。
6. 作为使用者，我想用 URL 复现当前视图（云、层、页码、时间窗），这样我能把某一屏发给同事。
7. 作为使用者，我想在 Ctrl/点星后视角保持不变，这样我放大看细节时不会被打回全景。

### 星云构成与星门
8. 作为使用者，我想一张卡看到四朵云的星点数，且**亮/暗分开统计**，这样我知道「有多少东西属于这个智能体、有多少只是可见」。
9. 作为使用者，我想看到每朵云的关系边数，这样我能判断这朵云是「孤星多」还是「连成网」。
10. 作为使用者，我想构成卡底部有口径注脚（按总量算还是按已载入算、统计时刻），这样我不会拿两个不同时刻的数字对比。
11. 作为使用者，我想点击构成卡某一行就聚焦到那朵云，这样我不用去星门里找。
12. 作为使用者，我想星门分成「四云 + 灵魂恒星」和「团队 / 设置」两组，因为前者是画布内动作、后者是开卡。
13. 作为使用者，我想有一个显式的「总览」入口，这样我进了云之后能回到五体全景而不用浏览器后退。

### 星点详情
14. 作为使用者，我想点星后右侧只出现**一张**星点卡，这样我不会在两块面板之间找信息。
15. 作为使用者，我想星点卡显示名称、状态（亮/暗及暗的原因）、所属库或所属图、键（ID）、时间、来源路径。
16. 作为使用者，我想星点卡的「关联星点」列表显示方向与边类型（出自原文 / 聚合自 / link / calls / 引用），并且点一下就能跳到那颗星。
17. 作为使用者，我想展开星点卡就地在卡内看到完整正文（记忆正文、wiki 全文、代码片段、技能说明），不用再开一个窗。
18. 作为使用者，我想读到聚合层（场景记忆/核心记忆）的整篇正文时有一个明确按钮，而不是猜要不要展开。
19. 作为使用者，我想暗星被点开时能写明「为什么暗」（记忆归档/遗忘、wiki 未分配给当前智能体、技能未挂载），而不是只有颜色不同。

### 星云详情
20. 作为使用者，我想在忆云里同时看到 L0/L1/L2/L3 四层、颜色各不相同，并能只看某一层或看全部。
21. 作为使用者，我想用可选日期范围筛选记忆（空=不限），而不是被固定成 24 小时。
22. 作为使用者，我想任何一层取数失败或为空时能看到原因（本页为空 / 区间内为空 / 请求失败），而不是显示 0。
23. 作为使用者，我想分页是标准样式（总条数、每页条数、当前页/总页数、上一页/下一页），四朵云一致，每页 100 条、一次只查一页。
24. 作为使用者，我想切换云内关键词过滤后重新从第一页开始，这样我不会停在越界的页码上。
25. 作为使用者，我想星云卡显示本云名称、层级、总星数、总边数、本页范围，这样我知道自己在看哪一段。

### 团队与设置
26. 作为使用者，我想团队卡在星图上方盖出来，关掉就回到原来的星图，这样我不会丢失正在看的星点。
27. 作为管理员，我想在团队卡里管理成员、智能体、密钥，能力与旧面板一致，这样我不用回旧版操作。
28. 作为使用者，我想设置卡按「个人设置 / 管理员设置 / 会话初始化默认值」分组，这样我知道哪些是我能改的。
29. 作为非管理员，我想看不到的项被置灰并写明原因（仅管理员），而不是直接消失或报错。
30. 作为使用者，我想写操作（删密钥、改成员、动设置、删 wiki）都在卡内二次确认，而不是弹窗。

### 缓存与一致性
31. 作为使用者，我想同一屏上所有数字来自同一次取数与同一时刻，这样数字之间可比较。
32. 作为使用者，我想回到刚看过的页时立即显示（命中缓存）并可手动刷新，而不是每次都重等。
33. 作为使用者，我想缓存过期后自动重取而不是让我看到旧数据却不知道。
34. 作为使用者，我想在慢网络下不要因为 6 个请求并发而被上游 504，看到的是逐条回来的结果。

## Implementation Decisions

### A. 组件分层（模块职责）

- **scope 层**：`starmap/state/StarmapProvider.tsx` 扩展为七元组唯一真源；新增 `scope/useScope.ts` 作为唯一读取入口与动作集合；URL 镜像由 `StarmapLayout` 单向同步（写 URL 不读回，避免循环）。
- **atoms 层**（共享原语，无业务）：`CardShell`（标题/英文副标/状态灯/右上操作/可折叠/脚注槽/关闭）、`Pager`（由现有 `scene/StPager.tsx` 下沉，四云共用且禁止再写第二份）、`KeyValue`、`RelationList`、`SourceNote`、`PermissionGate`、`DangerConfirm`，沿用 `theme/ui.tsx` 的 `Note / Empty / Skeleton / Btn / Pill / Seg / Fields`。
- **cards 层**（七张业务卡，纯展示）：`ScopeCard`、`ScopeSwitcher`、`CompositionCard`、`CloudGates`、`AdminGates`、`StarCard`、`CloudCard`、`TeamCard`、`SettingsCard`。
- **scene 层**（画布与视觉原语）：`CloudCanvas`（引擎，视角状态已在 `viewRef`）、`StarNode`、`EdgeLine`、`Legend`、`CanvasControls`。
- **hooks 层**：`useCloudStats`、`useCloudPage`、`useStarDetail`、`usePermission`，只吃 `useScope()`。

契约一句话：**卡片不取数，hooks 不吃 props 以外的作用域，作用域只有 Provider 一份**。

### B. 已定的产品决策

1. **记忆块维度只属于忆云**。`ScopeCard` 的块行与 `ScopeSwitcher` 的块段仅在 `cloud === 'memory'`（含忆云聚焦态）渲染；其他云不显示、也不传该参数。
2. **星点详情是单卡 + 折叠展开全文**，不设第二张详情卡。折叠状态是卡内状态，随选中星切换重置。
3. **团队卡与设置卡是盖卡（overlay）**，不换站：打开时画布与左右栏保持挂载，关闭即回原视图；不销毁星点选中态。
4. **层名固定**：L0 对话原文、L1 原子记忆、L2 场景记忆、L3 核心记忆（单一源头 `scene/cloudPage.ts` 的 `LAYER_NAME`）。
5. **分页统一**：每页 100 条、一次只查一页，四朵云同一套 `Pager` 与 `PAGE_SIZE`。
6. **亮/暗口径**：记忆按 archived/forgotten；wiki/code/skill 按是否分配给当前智能体（wiki/code）或是否挂载（skill）。口径必须写在构成卡与星云卡的注脚里。
7. **不新增 UI 依赖**：不引入 antd/mui/shadcn/tea 新用法；`lucide-react` 与现有 `tea-icons-react` 仍是唯一图标来源。

### C. 组件接口契约（原型级，随实施微调字段名不改职责）

```ts
export type CloudKey = 'memory' | 'soul' | 'wiki' | 'code' | 'skills';
export type MemoryScope = 'all' | 'L0' | 'L1' | 'L2' | 'L3';

export interface Scope {
  teamId: string | null; teamName: string; teams: TeamItem[];
  activeAgentId: string | null; agents: AgentItem[];
  blocks: BlockItem[]; activeBlockId: string | null; activeBlock: BlockItem | null;
  cloud: CloudKey | null;      // null = 五体总览
  layer: MemoryScope;          // 仅 memory 有意义
  from?: string; to?: string;  // 仅 memory 的 L0/L1 下发给后端
  pageNo: number;              // 1 起
  keyword?: string;
}

export interface CardShellProps {
  title: ReactNode; en?: string; status?: 'idle' | 'live' | 'warn' | 'error';
  right?: ReactNode; onClose?: () => void;
  foldable?: { open: boolean; onToggle(): void };
  foot?: ReactNode;            // 口径注脚 / 分页 / 操作条
  children?: ReactNode;
}

export interface RelationItem { id: string; label: string; edgeKind: string; dir: 'in' | 'out'; lit: boolean }
export interface RelationListProps { items: RelationItem[]; onFocus(id: string): void; emptyText?: string }

export interface PagerProps { page: number; pages: number; total: number; pageSize: number; loading?: boolean; onChange(n: number): void }

export interface ScopeCardProps { scope: Scope; compact?: boolean }
export interface ScopeSwitcherProps {
  scope: Scope; blockEnabled: boolean;
  onTeam(id: string): void; onAgent(id: string | null): void; onBlock(id: string | null): void;
}

export interface CloudStat {
  key: CloudKey; name: string; total: number; lit: number; dark: number; edges: number;
  loading?: boolean; error?: string; source: string;   // 口径 + 是否含未载入页 + 时刻
}
export interface CompositionCardProps {
  stats: CloudStat[]; active?: CloudKey | null;
  onFocus(c: CloudKey | null): void; onEnter(c: CloudKey): void;
}

export interface CloudGatesProps {
  gates: { key: CloudKey; name: string; en: string; hint: string }[];
  active?: CloudKey | null; onFocus(c: CloudKey | null): void; onEnter(c: CloudKey): void;
}
export interface AdminGatesProps { role: Role; onOpen(kind: 'team' | 'settings'): void }

export interface StarCardProps {
  star: {
    id: string; cloud: CloudKey; kind: string; layerLabel?: string; label: string; lit: boolean;
    darkReason?: string; owner?: string; time?: string; sourcePath?: string;
  };
  detail: { fields: { k: string; v: ReactNode }[];
            body?: { kind: 'markdown' | 'text' | 'code'; text: string; truncated?: boolean } } | null;
  relations: RelationItem[]; loading: boolean; error?: string;
  expanded: boolean; onToggle(): void; onFocus(id: string): void; onClose(): void;
  actions?: ReactNode;
}

export interface CloudCardProps {
  cloud: CloudKey; title: string;
  layer?: MemoryScope; onLayer?(l: MemoryScope): void;
  from?: string; to?: string; onRange?(f?: string, t?: string): void;
  keyword?: string; onKeyword?(k: string): void;
  total: number; pageSize: number; pageNo: number; onPage(n: number): void;
  loading: boolean; error?: string; hint?: string;
  layerCounts?: { layer: MemoryScope; loaded: number; total: number }[];
  onExit(): void;
}

export interface TeamCardProps { open: boolean; onClose(): void; role: Role }
export interface SettingsCardProps { open: boolean; onClose(): void; role: Role; tab?: 'personal' | 'admin' | 'session-defaults' }
```

能力来源（写死，禁止重写逻辑）：
- TeamCard → `components/team/TeamManagementPanel.tsx`、`MemberSection`、`AgentGrid`、`pages/ApiKeysPage/components/ApiKeyPanel.tsx`
- SettingsCard → `pages/SettingsPage/ConfigPanels.tsx`、`configCatalog.ts`、`services/permissions.ts`、`services/useCurrentRole.ts`
- 技能详情 → `services/use-skill-detail-cache.ts`（已有按需缓存，直接复用）

### D. 公共缓存设计

**D1 四类缓存与各自的生命周期**

| 类 | 内容 | 键 | TTL | 容量 | 失效 |
|---|---|---|---|---|---|
| 作用域列表 | teams / agents / blocks | `teams`、`agents:{teamId}`、`blocks:{teamId}:{agentId}` | 60s | 各 1 / 5 / 10 | 换团队/智能体（按 key 天然隔离）、分配或挂载变更后手动刷新 |
| 云统计 | 四云 total/lit/dark/edges | `stats:{teamId}:{agentId}` | 30s | 10 | 换作用域、写操作、手动刷新 |
| 云分页 | 一页星点 + 边 | 见 D2 | 300s | 24 页 | 换作用域/层/时间窗/关键词、写操作 |
| 星点详情 | 单星全量 + 关系 | `star:{cloud}:{id}` | 600s | 200 | 手动刷新、写操作 |
| 人物档案 | 人物关系与摘要 | `person:{personKey}` | 600s | 100 | 手动刷新 |

**D2 分页键必须带全部筛选维度**，否则会出现「切了层还看到上一层数据」这类假一致：
```
page:memory:{teamId}:{agentId}:{blockId}:{layer}:{from|*}:{to|*}:{pageNo}
page:wiki:{teamId}:{agentId}:{wikiId}:{keyword|*}:{pageNo}
page:code:{teamId}:{agentId}:{codeId}:{keyword|*}:{pageNo}
page:skills:{teamId}:{agentId}:{scope}:{keyword|*}:{pageNo}
```

**D3 机制（自己写，不引入 swr/react-query）**

- `CacheStore`：模块级 `Map`，条目 `{ value, at, ttl }`；读取即判 TTL，过期视为未命中但仍返回旧值给 UI 做「先显示后刷新」。
- **LRU**：命中时移到队尾；超容量淘汰队头。分页 24 页、详情 200 条，够覆盖一次会话的回看。
- **in-flight 去重**：`inflight: Map<key, Promise>`，同键并发只发一次；`CloudSideCard` 现在靠 effect 自洽，改成共享键后必须去重。
- **取消/世代**：`epoch` 计数器，换作用域时 `epoch++`，回来的响应若 `epoch` 不匹配直接丢弃（沿用 `StarmapProvider` 现有 `alive + req` 的模式，统一成一处）。
- **串行队列，并发上限 2**：实测对 `/v3/soul/*` 6 个并发会在 15s 超时 504，串行单请求 7–79ms。队列只对多请求聚合（构成卡的 soul 分支、忆云四层）生效，单请求直发。
- **不持久化**：只持久化选中项（现有 `tdai-memory.starmap.agent` / `.block`）。列表、统计、分页一律不落 localStorage，避免版本升级后拿到脏数据。

**D4 失效矩阵（谁触发谁清）**

| 事件 | 清除范围 |
|---|---|
| 换团队 | 全部（含 agents/blocks/stats/page/star） |
| 换智能体 | blocks、stats、page、star（teams/agents 保留） |
| 换记忆块 | stats、page:memory*、star |
| 换页 / 换层 / 换时间窗 / 换关键词 | 仅对应 page 键 |
| 写操作成功（挂载技能、同步 wiki、改成员、删密钥、改设置） | `stats` + 受影响的 page 前缀 + 该对象的 star |
| 手动刷新 | `stats` + 当前 page + 当前 star |

**D5 一致性口径**：同屏所有数字必须能追溯到同一次 `stats` 快照或同一页响应。`SourceNote` 是唯一出口，写「按总量 / 已载入 N 条 · 统计于 HH:mm」；跨快照比较要在注脚里显式标时刻，不允许静默拼接。

### E. 状态收敛细节

- URL 只镜像 `cloud / entered / layer / page / from / to` 六项；`team / agent / block` 仍走 localStorage 与 backendStore（现有行为），不进 URL，避免分享链接把别人的选择覆盖。
- 进入云（`entered=1`）与聚焦（`cloud=xxx`）语义保持分离：聚焦=总览内高亮，进入=只显示该云。现有 `StarmapLayout` 已按此拆分，重构时保留，避免复现「点了进入没反应」。
- 画布视角（yaw/pitch/zoom）、选中星、折叠状态不进 URL：属会话内瞬态。

### F. 实施顺序（每步独立可构建、可回滚）

| 步 | 内容 | 完成判据 |
|---|---|---|
| S1 | atoms：CardShell / Pager（下沉）/ KeyValue / RelationList / SourceNote；替换三处重复卡 | 删掉 ≥250 行重复；四云行为不变；tsc + build 过 |
| S2 | scope 收敛进 Provider + URL 镜像；ScopeCard / ScopeSwitcher | 换智能体整页一致的证据（所有云与计数同时变） |
| S3 | StarCard 单卡折叠 + RelationList 四云适配 + CloudCard（层/筛选/分页/三态） | 点星不重置视角；空/错/窗口过大三态可见 |
| S4 | TeamCard / SettingsCard 盖卡 + PermissionGate / DangerConfirm + CompositionCard / CloudGates / AdminGates | 旧 9 页能力全部有新入口，权限门可见 |

## Testing Decisions

**测试观点的立场**：只测外部行为（用户能看到的输入输出与状态），不测实现细节（不测内部 state 结构、不测 CSS 类名、不测 hook 内部调用次数）。这个仓库的既有验证风格是「构建读数 + 真实浏览器 + 截图判读」，web 包目前**没有单测运行器**（`package.json` 只有 tsc / vite / eslint / prettier）。

**seam 1（既有，主 seam）：构建 + 真实页面**。`tsc --noEmit` 严格通过 + `vite build` 退出 0 是准入门槛；行为验证走既有自动化脚本 `.scratch/ui-test-runner.mjs`（见 `docs/specs/2026-11-11-starmap-ui-test-cases.md`），会话用 localStorage 注入 `tdai-panel.session = {"instanceId":"default","userKey":"...","user":{...}}` 拿到登录态。四朵云、星门、盖卡、分页、三态都在这一层断言。

**seam 2（新增，仅一个）：纯函数单测**。缓存与作用域归约是本轮唯一「不打开浏览器就很难证明」的部分（TTL、LRU 淘汰、in-flight 去重、epoch 丢弃、失效矩阵）。建议只对这一层引入最小单测能力（`vitest` 作为 devDependency，不进入产物），测试对象仅限无 React 依赖的纯模块：`CacheStore`、`scopeReducer`、`pageKey`。**这是本 spec 唯一需要新增的依赖，需拍板**。

**不新增的测试层**：不引入 e2e 框架（Playwright 等），不改 `.scratch/ui-test-runner.mjs` 的既有断言结构，不为卡片写 DOM 快照测试。

**prior art**：`docs/specs/2026-11-11-starmap-ui-test-cases.md` 的 A–H 分节用例（入口与登录、四云与数据、聚焦、星点与卡片、站台与旧功能覆盖、权限与边界、完整视图、团队本体）；`MemoryCore` 的 vitest 用法可作为纯函数测试的写法参考。

## Out of Scope

- 任何后端接口、表结构、`MemoryCore` / `MemoryKnowledge` 代码改动。
- 代码星点详情需要后端补的 node 级读接口（`MemoryKnowledge/src/routes/code-graph.ts` 目前只有列表与 search/explore，返回 `{text,isError}`）——本轮只保证 UI 契约留好口子。
- 忆云 L0 总数需要额外一次查询（Provider 现在只拉 L1/L2/L3 + persons）——本轮按「构成卡的 L0 用 limit=1 探 total」实现，不改后端。
- 视觉重设计（配色、布局比例、动效）——本轮只做组件切分与缓存治理，视觉沿用现有深空 HUD 令牌。
- 旧面板页面的删除（`/legacy` 保留作对照）。

## Further Notes

1. **已踩过的坑要写进验收**：点星重置视角（`CloudCanvas` effect 依赖 `selectedId` 导致重建）——S3 的验收项必须含「缩放后点星视角不变」；「所有层显示 0」——验收项必须含「任一云任一数字旁有口径注脚」。
2. **后端静默空页**：`MemoryPanel/src/panel/http/routes/chat-memory.ts` 的 `isRangeTooLarge` 只在 `total > 0` 时报 400，`total = 0` 时静默空页；前端必须把「区间内为空」与「请求失败」区分显示，不能都显示 0。
3. **soul 并发上限**：6 个并发 15s 超时，串行 7–79ms。缓存层的队列上限 2 是硬约束，不是优化项。
4. **面板登录态**：`:8420/panel/` 未注入会话时 401 是预期行为；做验证前先注入 `tdai-panel.session`，否则会误判为「接口挂了」。
