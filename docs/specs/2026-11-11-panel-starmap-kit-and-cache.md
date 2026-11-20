# 星图组件层与数据缓存层设计

> 2026-11-11 · 状态：**设计待拍板**（未改代码）· 上游：`MemoryPanel/web/DESIGN.md`（视觉基线）、`docs/specs/2026-11-10-panel-starmap-redesign.md`（星图语义）
> 本文只解决两件事：**组件层怎么切、怎么用**；**数据怎么缓存、怎么失效**。落地顺序与验收在第 5、8 节。

---

## 0. 两条不变量

1. **星点只来自真实接口**。缓存只能加速、不能创造；缓存失效时宁可空态，也不许用旧数据冒充新数据（旧数据必须显式标「上次同步 hh:mm」）。
2. **卡片里只有一层表面**。组件层禁止在组件内部再造视觉层级（无嵌套卡、无内描边、无角标、无光晕、无全大写小标签）——这些是 DESIGN.md 列为不可赎回的禁令。

---

## 1. 组件层（kit）

### 1.1 目录与命名

新命名空间 `src/starmap/kit/`，与旧 `src/starmap/theme/ui.tsx` 并存到迁移完成，迁移完删旧文件。

```
src/starmap/kit/
  index.ts          // 统一出口
  kit.css           // 唯一样式文件，只用 token，不写字面色值
  Surface.tsx       // 表面（卡片）
  Section.tsx       // 表面内的分组（只有顶部发丝线，无背景无边框）
  Row.tsx           // 列表行 / 关系行（可点）
  KvList.tsx        // 键值对（等宽 key）
  MetricRow.tsx     // 指标格（数字大、标签小）
  Pager.tsx         // 标准分页（替代 scene/StPager.tsx）
  Seg.tsx           // 分段控件（层筛选 / 范围切换）
  Tag.tsx           // 状态标签（tonal，小）
  Dialog.tsx        // 对话框壳（焦点陷阱 + Esc + 还原焦点）
  States.tsx        // Empty / Skeleton / Note 三件套
  ScopeBar.tsx      // 观测对象：团队 / agent / 记忆块 + 同步时间
  Gate.tsx          // 星门（进入某朵云）
  Legend.tsx        // 图例（层色 + 明暗含义）
  StarDetail.tsx    // 星点详情（侧栏主卡）
```

命名规则：**不用 `Card2`/`Btn` 这类缩写或带数字的名字**。组件名说清楚自己是什么；一个组件只承担一种语义。

### 1.2 组件契约

共同约束（全部组件适用，不再逐条重复）：

- 颜色、字号、圆角、间距**只能取 token**（`--ink/--dim/--dim2/--star-dim/--l0..l3/--hair/--hair-soft/--surface/--surface-2`）；`kit.css` 里禁止出现 16 进制字面量。
- 禁用：`backdrop-filter`、`box-shadow` 光晕、`linear-gradient` 文字、`text-transform: uppercase`、`letter-spacing` 做装饰、`transition: all`。
- 焦点：一律 `outline: 2px solid var(--focus); outline-offset: 2px`，不许 `outline: none`。
- 可点元素最小命中 24×24；星场 canvas 的命中半径单独 12px（DESIGN.md 已定）。
- 动效只允许 `--ease-out`；时长 ≤150ms（进云点亮 420ms 是唯一例外，且在场景层不在 kit 层）。

#### Surface

```ts
type SurfaceProps = {
  title?: ReactNode;      // 12.5/600/ink；不传则不渲染标题行
  aside?: ReactNode;      // 标题右侧：计数、刷新、筛选
  dense?: boolean;        // padding 8 vs 12
  as?: 'section' | 'aside' | 'div';
  className?: string;
  children?: ReactNode;
};
```

- 视觉：`background: var(--surface); border: 1px solid var(--hair); border-radius: 11px`。**没有** ::before/::after，没有角标，没有内阴影。
- 状态：无 hover（表面本身不可点）。内部可滚动的区域自己加 `overscroll-behavior: contain`，不要让整个表面滚。
- 反例（现存）：`theme/ui.tsx:9` 的 `Card2` 带 `ch-en` 英文副标（全大写小标签）与 `live-dot` 光点，新 Surface 全部去掉。

#### Section

```ts
type SectionProps = { title?: ReactNode; hint?: ReactNode; children?: ReactNode };
```

- 只画 `border-top: 1px solid var(--hair-soft)`；**不画背景**。用来分隔同一表面内的「键值 / 关系 / 全文 / 操作」四段。

#### Row

```ts
type RowProps = {
  leading?: ReactNode;        // 圆点 ≤10px 或 TinyIcon
  label: ReactNode;
  meta?: ReactNode;           // 右对齐，tabular-nums
  active?: boolean;           // 选中：aria-current="true"
  disabled?: boolean;
  onClick?: () => void;       // 有则整行可点（Enter/Space）
  trailing?: ReactNode;       // 行尾操作（复制/打开），独立焦点
};
```

- 高度 28，`padding: 0 6px`，`border-radius: 6px`；hover `background: var(--surface-2)` + 文字转 `--ink`；**不改边框、不位移、不缩放**。
- `active` 用左侧 2px 层色短线（`box-shadow: inset 2px 0 0 var(--lN)`）而不是整行填充——一屏里可能同时有 10 个 active。
- 键盘：有 `onClick` 时 `tabIndex=0`，Enter/Space 触发；列表容器用 roving tabindex，`↑↓` 移动、`Enter` 打开。

#### KvList

```ts
type KvListProps = { items: { k: string; v: ReactNode; mono?: boolean }[] };
```

- key 列宽 44（`--dim2`），value 常规色；`mono` 只给 id / hash / 时间戳。
- 空值统一渲染 `—`（不要留白）。

#### MetricRow

```ts
type MetricRowProps = { items: { label: string; value: ReactNode; tone?: Tone }[] };
```

- 数字 14/500 `tabular-nums`，标签 11 `--dim`。不画格子背景、不画竖线（旧 `StatRow` 的格线去掉）。

#### Pager

```ts
type PagerProps = {
  page: number;
  pages: number;
  total: number;
  pageSize?: number;   // 只用于读数文案
  unit?: string;       // 默认「条」
  loading?: boolean;
  onChange: (page: number) => void;
};
```

- 一行读数「共 N 条 · 每页 100 · 第 1 / 116 页」，一行控制「上一页 · 1 2 3 … 116 · 下一页」。
- **当前页不用方框**：文字转 `--ink` + 底部 2px 层色短线；其余页 `--dim`，hover 转 `--ink`。
- 页码窗口沿用现成的 `pageWindow(page, pages)`（`scene/StPager.tsx:33`，逻辑正确，直接搬进 kit，补单测）。
- disabled 用 `aria-disabled` + 降低不透明度到 0.4，不用 `opacity: .5` 一刀切。

#### Seg

```ts
type SegProps<T extends string> = {
  value: T;
  options: { value: T; label: ReactNode; count?: number }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
};
```

- 选中项：文字转 `--ink` + 2px 底部短线（与 Pager 同一套「选中」语言），**不用填充块**。旧 `ui.tsx:132` 的 `Seg` 用的是蓝色 rgba 填充 + 边框，属于要清的旧语言。

#### Tag

```ts
type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'l0' | 'l1' | 'l2' | 'l3';
type TagProps = { tone?: Tone; children: ReactNode; title?: string };
```

- 高度 18，圆角 4，背景 = 对应色 12% 透明度，文字 = 对应色（暗底上够对比）；不加边框。**不许全大写、不加大写转化**。

#### Dialog

```ts
type DialogProps = {
  title: ReactNode;
  description?: ReactNode;
  width?: number;              // 默认 520，上限 min(960, 90vw)
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
};
```

- 行为契约（现状缺的）：Esc 关闭；遮罩点击关闭；**焦点陷阱**（Tab 循环）；打开时焦点落到第一个可交互元素，关闭时还原到触发元素；`role="dialog" aria-modal="true" aria-labelledby`；`body` 滚动锁定。
- 视觉：遮罩 `rgba(3,6,14,.72)`，面板 = Surface（同款表面），**不带玻璃模糊**（现存 `tokens.css:121-123` 的 `backdrop-filter: blur(13px)` 在新 Dialog 里禁用）。
- 所有旧弹窗（分配记忆、导入块、导入/派生技能、设置、创建/编辑团队与 agent、资产分配）都换到这一个壳；业务内容留在各自组件里，壳统一。

#### States

```ts
type EmptyProps   = { text: string; hint?: string; action?: ReactNode };
type SkeletonProps= { rows?: number; height?: number };
type NoteProps    = { children: ReactNode; tone?: 'bad' | 'warn' | 'ok'; action?: ReactNode };
```

- Empty 的装饰只用一行 `--dim2` 的「· · ·」，不放大图标、不用全大写。
- Note 用在：数据降级（某源失败）、stale 提示、权限不足。**降级必须可见**——这是星图「不伪造点数」的可视化出口。

#### ScopeBar

```ts
type ScopeBarProps = {
  teams: { id: string; name: string }[];
  teamId: string | null;
  agents: { id: string; name: string }[];
  agentId: string | null;
  blocks?: { id: string; title: string }[];
  blockId?: string | null;      // 仅忆云用
  syncedAt?: number | null;     // 「上次同步 12:03」
  loading?: boolean;
  onTeam: (id: string) => void;
  onAgent: (id: string) => void;
  onBlock?: (id: string) => void;
  onRefresh?: () => void;
};
```

- 面包屑「团队 / 团队名 / agent 名」，切换用原生 `<select>` 或轻量下拉（**不引入新的弹层组件**）；`syncedAt` 与刷新按钮同行。
- **agent 是全局作用域**：切换 = 换整张星图（人格恒星 + 四云全部重算），切换时清空选中星点与侧卡，但**不清缓存**（见 2.5 namespace）。

#### Gate

```ts
type GateProps = { tone: Tone; label: string; count?: number; unit?: string; active?: boolean; onClick: () => void };
```

- 一行：圆点 + 名称 + 右对齐计数；active 用左侧 2px 短线。五道门：灵魂恒星 / 忆云 / 典籍云 / 构筑云 / 技艺云。

#### Legend

```ts
type LegendProps = { items: { tone: Tone; label: string; count?: number }[]; note?: string };
```

- 明暗含义必须写出来（「暗 = 团队可见、未挂到本 agent」），否则用户会把暗星当故障。

#### StarDetail

```ts
type StarDetailProps = {
  title: string;
  subtitle: ReactNode;                       // 「原子记忆 L1 · 已生效 · 忆云」
  kv?: { k: string; v: ReactNode; mono?: boolean }[];
  relations?: { tone: Tone; label: string; count?: number; onClick?: () => void }[];
  body?: string | null;                      // 折叠全文
  bodyLabel?: string;                        // 「展开全文（612 字）」
  actions?: ReactNode;                       // 复制 id / 分配 / 打开来源
  emptyText?: string;                        // 未选中星点时的占位
};
```

- 顺序固定：标题 → 副标 → KvList → 关系（Section）→ 全文（Section，默认折叠，`<details>`）→ 操作。**顺序不许换**，侧卡是扫读界面。
- 关系行点击 = 把该关联星点设为选中（星场高亮 + 侧卡换内容），不跳页。
- 全文折叠内容用 `pre` + `white-space: pre-wrap` + `max-height: 112px` + 自身滚动。

### 1.3 旧组件映射（迁移表）

| 旧（path:line） | 新 | 处理 |
| --- | --- | --- |
| `theme/ui.tsx:9` `Card2` | `Surface` | 去 `ch-en` 英文副标、去 `live-dot` |
| `theme/ui.tsx:44` `StatRow` | `MetricRow` | 去格线 |
| `theme/ui.tsx:132` `Seg` | `Seg` | 选中从「填充块」改「底部短线」 |
| `theme/ui.tsx:168` `Dialog` | `Dialog` | 补焦点陷阱 / 初始焦点 / 还原焦点 |
| `theme/ui.tsx:59` `Pill` | `Tag` | 去边框 |
| `theme/ui.tsx:91` `Fields` | `KvList` | 空值统一 `—` |
| `theme/ui.tsx:213` `Empty`/`Skeleton`/`Note` | `States` | 语义不变，样式收敛 |
| `scene/StPager.tsx` | `Pager` | `pageWindow` 搬过去 + 补单测 |
| `components/SettingsDialog.tsx` 等 8 处弹窗 | `Dialog` | 只换壳，业务不动 |

### 1.4 各星门用哪些 kit 组件（接线表）

| 区域 | 组件 |
| --- | --- |
| 总览（五体） | `ScopeBar` + `Legend` + 5×`Gate` + 索引用 `Surface` |
| 进云后的左栏 | `Surface`(筛选) + `Seg` + `Row` 列表 + `Legend` |
| 进云后的右栏 | `StarDetail` + `Pager`（同一 `Surface` 内 `Section` 分隔） |
| 任一弹窗 | `Dialog` + `KvList`/`Row`/`Tag` 组合 |
| 空态/降级 | `States` |

---

## 2. 缓存层

### 2.1 现状（证据，不是印象）

| 问题 | 证据 |
| --- | --- |
| 总览缓存是**模块级 Map + 60s TTL**，无持久化、无单飞、无失效钩子；切回同名 key 只用旧模型，数据变了也不会自己变 | `starmap/data/overview.ts:82-83`、`:267`、`:326` |
| 总览取数是**串行 15+ 次**（persona→persons→fixed→memory→4×layer→wiki→code→2×skills），任一慢就整体慢 | `overview.ts:281`、`:285-292`、`:293-312` |
| 进云时重新拉 `wiki.teamAssets` + `code.teamAssets` + `agentFixed`，与总览的同类请求**完全重复** | `CloudSideCard.tsx:94`、`:101` |
| 换记忆块就 `Promise.all` 重打 L1/L2/L3 + persons 四枪，翻回上一块也是重打 | `StarmapProvider.tsx:198-203` |
| HTTP 层只有**进行中去重、没有结果缓存** | `lib/api/base.ts:233-234` `dedupeInFlight` |
| 唯一的「按需缓存」是组件内 `useRef(Map)`，组件卸载即丢 | `services/use-skill-detail-cache.ts:32-38` |
| 分页无缓存：1→2→1 必然重打三次 | `scene/cloudPage.ts:128`、`:201`、`:263`、`:303`、`:345` |

结论：现有是**三处各自为政的临时缓存**，没有统一 key、没有失效、没有观测。26k 点规模的星图继续这么打，切 agent 会明显卡。

### 2.2 四层结构

```
组件 ──useResource(key, fn)──▶ ① resources（Map + TTL + SWR + 单飞）
                                   │ miss
                                   ▼
                              ② readCache（HTTP 级：key 规范化 + 结果表 + 单飞）
                                   │ miss
                                   ▼
                              ③ derived（图/总览装配的记忆，按 revision 命中）
                                   │ 需要跨刷新生效
                                   ▼
                              ④ persisted（sessionStorage：只存计数与 id 集合）
```

关键点：**组件永远只跟 `useResource` 说话**，不知道 TTL、不知道重试。失效由 ⑤ `invalidate(tags)` 触发（mutation 点调用）。

### 2.3 key 规范

```
sc:<userId>:<teamId>:<agentId>:<resource>[:<qualifier…>]
```

- `userId` 来自 `getPanelSession().user.user_id`——**登录用户变了一定换 key**，防止 A 用户读到 B 用户的可见集合。
- `teamId`/`agentId` 参与 key：**越权数据不跨团队复用**；`agentId` 为 `-` 表示团队级（wiki/code 列表）。
- qualifier 只放**规范化后的筛选**（层、页码、pageSize、日期窗口截断到天），不放对象序列化结果。

资源清单（resource 名固定，不许临时起名）：

`persona.card` `persona.persons` `persona.archive` `memory.agentFixed` `memory.blockList` `memory.layerTotal` `memory.layerPage` `memory.itemBody` `wiki.teamAssets` `wiki.pages` `wiki.page` `code.graphs` `code.nodes` `code.node` `skills.list` `skills.detail` `teams.list` `agents.list` `auth.me`

### 2.4 TTL 与失效矩阵

| resource | TTL | 持久化 | 失效标签 |
| --- | --- | --- | --- |
| `persona.card` | 30s | — | `persona:<agent>` |
| `persona.persons` | 60s | 计数 | `persona:<agent>` |
| `persona.archive` | 60s | — | `persona:<agent>` |
| `memory.agentFixed` | 60s | id 集合 | `memory:agent:<agent>` |
| `memory.blockList` | 60s | id+标题 | `memory:agent:<agent>` |
| `memory.layerTotal` | 120s | 计数 | `memory:block:<id>` |
| `memory.layerPage` | 300s | — | `memory:block:<id>` |
| `memory.itemBody` | 600s | — | `memory:block:<id>` |
| `wiki.teamAssets` | 120s | 计数 | `wiki:team:<team>` |
| `wiki.pages` / `code.nodes` | 300s | — | `wiki:<id>` / `code:<id>` |
| `wiki.page` / `code.node` | 600s | — | 同上 |
| `skills.list` | 60s | 计数 | `skills:agent:<agent>`、`skills:team:<team>` |
| `skills.detail` | 300s | — | `skills:<id>` |
| `teams.list` / `agents.list` | 120s / 60s | id+名 | `team:*` |
| `auth.me` | 300s | — | `auth`（登出清一切） |

写清的规矩：**TTL 只负责「多久后重新问一次」，正确性靠失效标签**。所以每个 mutation 点必须接线（2.7）。

### 2.5 并发、串行与取消

- 两条泳道：`soul` 并发 **1**、`read` 并发 **4**。soul 必须串行是实测口径（并发 6 时 `/v3/soul/*` 顶到 15s 超时回 504；串行 7–79ms）。
- 每层请求带 **generation 计数**：换 agent/团队/记忆块时 generation+1，旧响应回来直接丢弃（现在 `StarmapProvider.tsx:190-206` 用 `req`/`alive` 手写，收敛到库里一处）。
- 可中断的请求用 `AbortController`（layer 分页、wiki/code 分页），切云时 abort 在途分页。
- 单飞：同 key 在途复用同一 Promise（复用 `dedupeInFlight` 语义，但**带结果缓存**，两件事分开）。

### 2.6 分页窗口

- 每 (resource+筛选) 保留最近 **3 页**（LRU），页 key 含 `pageSize`（100，见 `cloudPage.ts:37`）。
- 翻到第 N 页：命中即秒开；未命中直接按 `offset=(N-1)*pageSize` 请求，**不做逐页预取链**。
- 空闲预取：当前页稳定 400ms 后预取下一页（`requestIdleCallback` 有则用，无则 `setTimeout`）；用户连续翻页时取消预取。
- `total` 走 `memory.layerTotal` 的缓存，不在翻页时重算总页数。

### 2.7 失效接线（mutation → invalidate）

| mutation | 位置 | 失效标签 |
| --- | --- | --- |
| 分配/取消记忆资产 | `AllocateMemoryDialog` / `AllocateAssetDialog` | `memory:agent:<agent>`、`memory:block:<id>` |
| 导入记忆块 | `ImportBlockDialog` | `memory:agent:<agent>` |
| 编辑人格 / 重新蒸馏 | `AgentPersonaSection` / SoulPage | `persona:<agent>` |
| 导入 / 派生 / 删除技能 | `ImportSkillDialog` / `ForkSkillDialog` / SkillsPanel | `skills:agent:<id>`、`skills:team:<team>` |
| 导入 / 重建 wiki、代码图 | WikiSourcesPanel / CodeSourcesPanel | `wiki:team:<team>` / `code:team:<team>` |
| 建/改团队、建/改 agent | TeamManagementPanel / CreateAgentDialog | `team:*`、`agents:*` |
| 登出 / 401 | `onUnauthorized`（`base.ts:74`） | `*`（全清 + 清 sessionStorage 缓存） |

### 2.8 持久化与隐私（硬边界）

- **只持久化「计数 + id 集合 + 时间戳」**，用来冷启动先画出星云规模与明暗，再异步刷新。
- **禁止持久化**：记忆正文、Wikipedia 页正文、代码片段、人物档案、人格卡正文。这些只在内存里活到会话结束。
- 存储键 `tdai-panel.cache.v1`，总量上限 64KB；超了按 namespace 从旧到新淘汰。
- 登出、401、切用户（key 前缀变化）三条路径都清空持久层。

### 2.9 内存预算与淘汰

- 总预算：**400 条 / 12MB**（按条目粗估字节，正文按长度算）。
- 分 namespace 上限：单 agent 150 条、团队级 60 条、其他 50 条；超限 LRU 淘汰，淘汰在写入时做，不在读时做。
- 星图派生结果（`buildStarmapGraph` 输出的 720 节点）不进资源表，单独 `graphMemo`（key = `blockId|layersRev|personsRev`），换块才重算。

### 2.10 失败与降级

- `readCache` 失败：**不清空旧值**，`useResource` 返回 `{ data: stale, stale: true, error }`；UI 用 `Note` 标「数据未刷新：<原因>」，并保留「上次同步 hh:mm」。
- 多源总览（`overview.ts` 的 `errors` 表）保持现有语义：任一源失败进 `errors`，云标 `degraded`，不伪造点数。
- 401：立刻全清缓存 + 跳登录（不重试）。

### 2.11 观测与测试

- `cacheDebug.snapshot()`：每 namespace 条数、命中率、在途请求、淘汰次数、字节估算。开发态 `?cache=1` 在左下角开一个小面板（仅 dev build）。
- 单测（纯模块，注入 fake clock + fake storage，不用真 timer）：
  1. TTL 过期只重打一次（同 tick 内两次读 → 1 次请求）；
  2. 单飞：并发 3 次同 key → 1 次请求；
  3. 失效标签命中后下一次读必须重打；
  4. LRU 淘汰顺序与预算；
  5. stale-on-error：请求失败仍返回旧值且 `stale=true`；
  6. 登出清空；
  7. `pageWindow` 窗口正确性（1 .. 116 全边界）。
- 现无 vitest 依赖（`package.json` 只有 tsc/vite/eslint/prettier）——**这一项要单独拍板**：加 `vitest` devDependency，还是先用 `node --test` 跑纯模块。

---

## 3. 组件 × 缓存 的接线（一个 hook 说完）

```ts
// 每朵云一个 view-model，组件不直接调 api
const cloud = useCloud('memory', { teamId, agentId, blockId, layer, page });

// cloud = {
//   points,      // 星点（含 lit/dim 与 total）
//   page,        // 当前页条目
//   totals,      // 分层计数（可能来自持久层，stale=true）
//   state: 'idle' | 'loading' | 'ready' | 'stale' | 'error',
//   syncedAt, error, refresh, invalidate
// }
```

星场（canvas）只吃 `points + selection`，不碰网络；侧卡只吃 `useCloud` 的 `page/pick`。

---

## 4. 不做什么

- 不引入 react-query / SWR / TanStack：现有栈是 zustand + 手写 store，多一个数据层框架会让 196 个文件里已经存在的调用方式再分叉一次。
- 不改后端、不加接口、不改表；所有 key 都由现有接口参数拼。
- 不做离线优先：持久层只为了冷启动有数，不代表可离线操作。
- 不缓存写操作结果；写只做「失效 + 重新读」。
- 不在 kit 里做主题切换（单主题，颜色全走 token，将来换主题只换 token 文件）。

---

## 5. 实施顺序（每步都可单独验收）

| 步 | 内容 | 验收（可测） |
| --- | --- | --- |
| S1 | kit 落地 + 旧件映射（组件层，不动数据） | 用 kit 重画的侧卡/分页在真页面里视觉复核通过；DOM 里 `card2`/`backdrop-filter` 计数为 0 |
| S2 | `readCache` + `resources` + `useResource`，包住现有 api 调用（不改 UI 结构） | 进同云两次：第二次网络请求数 = 0；切 agent 再切回 = 0（DevTools 计数） |
| S3 | 分页窗口 + 预取 + stale-on-error | 翻 1→2→1，第二次回第 1 页 0 请求；断网后仍显示旧页并出现降级 Note |
| S4 | 失效接线 + 登出清空 + 观测面板 | fork 一个技能后技艺云计数自动变；登出后 sessionStorage `tdai-panel.cache.v1` 为 null |

## 6. 验收清单（对 S1–S4 总验收）

1. 任一页面 DOM 里不存在 `backdrop-filter`、嵌套 `Surface`、`text-transform: uppercase`、无偏移彩色 `box-shadow`。
2. 所有组件颜色/字号来自 token；`kit.css` 内无 16 进制字面量（脚本可查）。
3. 四朵云 + 灵魂恒星全部走 `useCloud`/`useResource`，只有 `lib/api` 层出现 `fetch`。
4. 同 agent 内切换云、翻页、点星：网络请求数为 0（除首次）。
5. 切 agent：只重打该 agent 的 `persona.*`/`memory.*`/`skills.list`，团队级 `wiki/code` 不重打。
6. 任一源失败：星云标降级 + 保留旧数据 + `Note` 可见，绝不显示 0 冒充「没有数据」。
7. 登出 / 401 后内存表与 sessionStorage 全清。
8. 对话框：Esc 关闭、焦点陷阱、关闭后焦点还原到触发按钮（键盘可走通）。
9. 分页：当前页无方框（底部短线）、`…` 折叠正确、末页按钮禁用态正确。
10. `cacheDebug.snapshot()` 能给出命中率与淘汰次数；7 条单测全绿。
