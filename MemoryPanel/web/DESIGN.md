---
version: 1
name: starmap-design-system
description: "MemoryPanel 星图（agent 级人格恒星 + 忆云/典籍云/构筑云/技艺云）的设计系统：一张深空观测台上的星图，chrome 必须退到星场之后。Operating surface，不是 marketing —— 表现力只允许花在星点渲染上，其余一律克制。"
status: draft-2026-11-11

colors:
  bg: "#070B16"
  bg-deep: "#04060D"
  surface: "#0C1220"
  surface-2: "#121A2C"
  hairline: "rgba(120,170,255,0.16)"
  hairline-soft: "rgba(120,170,255,0.07)"
  ink: "#E8F1FF"
  dim: "#7B8DB0"
  dim2: "#5A6B8C"
  star-dim: "#66799B"
  layer-l0: "#7F93BD"
  layer-l1: "#7FC8FF"
  layer-l2: "#FFB86B"
  layer-l3: "#9FE6C8"
  ok: "#6EE7A8"
  warn: "#FFBE5C"
  bad: "#FF7B8A"
  focus: "rgba(127,200,255,0.55)"
  selection: "rgba(127,200,255,0.22)"

typography:
  title:   { size: 15px, weight: 600, lineHeight: 1.35, tracking: -0.01em }
  section: { size: 12.5px, weight: 600, lineHeight: 1.4, tracking: 0 }
  body:    { size: 12px, weight: 400, lineHeight: 1.6, tracking: 0 }
  body-sm: { size: 11.5px, weight: 400, lineHeight: 1.6, tracking: 0 }
  caption: { size: 11px, weight: 400, lineHeight: 1.5, tracking: 0 }
  key:     { size: 10.5px, weight: 400, lineHeight: 1.5, tracking: 0, family: "Consolas, SFMono-Regular, ui-monospace" }
  metric:  { size: 14px, weight: 500, lineHeight: 1.2, tracking: 0, numeric: tabular-nums }

spacing: { xxs: 2px, xs: 4px, sm: 6px, md: 8px, lg: 12px, xl: 16px, 2xl: 20px, 3xl: 24px, 4xl: 32px }
rounded: { xs: 4px, sm: 6px, md: 8px, lg: 11px, pill: 999px }

starfield:
  persona: { radius: 13, ring: 1 }
  star: { l3: 6.5, l2: 5, l1: 4, l0: 3.2, dimScale: 0.78, hitRadius: 12 }
  shells: { count: 4, rIn: 0.52, rOut: 2.52, golden: 2.399963229728653, focal: 1.26, zOffset: 8 }
  edge:
    hairline: "rgba(180,200,230,0.22)"
    active: "{colors.layer-l1}"
    width: 1

motion:
  ease-out: "cubic-bezier(0.23, 1, 0.32, 1)"
  ease-in-out: "cubic-bezier(0.77, 0, 0.175, 1)"
  press: 120ms
  hover: 150ms
  select: 120ms
  card-in: 200ms
  cloud-ignite: 420ms
---

# 星图设计系统

## 它是什么（先说清楚，否则后面每条都站不住）

这是一台**观测台**，不是一张海报。用户在星图上做的三件事：看清结构、点开某一颗、确认它是不是真的。所以它是 impeccable 所说的 **Operate** 表面 —— 判断标准是「扫得快、认得准、点得中、可信」，不是「第一眼惊艳」。

在这个前提下的唯一破例：**星场本身就是内容，也是唯一允许发光的东西。** chrome（卡片、按钮、侧栏、分页、表单）必须退到星场后面，安静到几乎看不见。我们现在的方向反了 —— 侧卡发光、按钮发光、角落渐变发光，星点反而被压平。

一句话判据：**任何一次截图，最亮的一块必须是星场，不能是卡片。**

## 现在的病（有据可查，不是感觉）

| 症状 | 位置 | 判为 |
| --- | --- | --- |
| 卡片 `backdrop-filter: blur(13px)` + 半透明底 | `MemoryPanel/web/src/starmap/theme/tokens.css:121-123` | craft-floor 禁令：玻璃与模糊当装饰；也是「侧卡一块黑」的根因 |
| 卡片里再套描边框（`.card2::before` inset 4px 描边）+ 左上角渐变三角（`.card2::after`） | `tokens.css:126-146` | 嵌套卡片 / 装饰性三角，两个 AI 味来源 |
| 满屏全大写小字 eyebrow（`.ch-en`、`.sm-label`） | `tokens.css:158-163`、`:186-191` | craft-floor **硬禁令**：标题上方禁止 kicker / 全大写标签 |
| 零偏移彩色光晕当状态（`.live-dot`、`.sm-btn.primary` 的 `box-shadow: 0 0 14px`） | `tokens.css:164-176`、`:236-241` | 零偏移彩色 halo = 装饰，不是深度 |
| 暗星 `#41506E` 对比度 2.39:1 | `CloudCanvas.tsx:403` | 图形对比度低于 3:1，暗星在暗底上等于看不见 |
| 次要文字 `--dim2` 3.60:1 被用于正文 | 散落各处 | 正文需 ≥4.5:1；`--dim2` 只能用于非文字或 ≥18px 大字 |

## 颜色

**底色三层 + 一层抬升**，靠色阶而不是阴影做深度：`bg #070B16` 页面 → `surface #0A0E18` 卡片（**实色，不再半透明**）→ `surface-2 #0E1524` 行/hover。深度用 1px `hairline` 表达，不用投影，不用模糊。

**层色是语义，不是装饰**：L0 `#7F93BD` 对话原文 / L1 `#7FC8FF` 原子记忆 / L2 `#FFB86B` 场景记忆 / L3 `#9FE6C8` 核心记忆。层色只出现在星点、层按钮圆点、以及选中态描边；**不得拿来给卡片上色**。

**亮/暗编码**：亮 = 该层色原样（对比度 6.25–13.43:1 全部过 3:1）；暗 = `star-dim #66799B`（4.38:1），不用 `#41506E`。亮暗差异靠**色相 + 饱和度**做，不靠降透明度 —— 降透明度在暗底上直接消失（这就是 `#41506E` 的教训）。

文字对比度实测（对 `surface`）：ink 16.95 · dim 5.77 · dim2 3.60。规则：正文与次要正文用 `dim`（5.77 ✓），`dim2` 只允许出现在分隔线、禁用态、≥18px 大字上。

## 字体

**不引 webfont**。面板是内网离线件，任何外链字体都会在断网时崩成 fallback，反而更丑。个性从**尺度、字重、字距、数字对齐**里出，不从字体文件里出。

- 正文字族：`-apple-system, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif`（保持现状，够用）。
- 只有 **key / id / 层号 / 分页数字** 用等宽 `.key`，等宽是「这是数据」的信号，不是「这很技术」的化妆品。
- 所有计数、分页、时间一律 `font-variant-numeric: tabular-nums`，换页时数字不许跳动。
- 中文标题不加字距；英文缩写不再全大写加宽字距（`.ch-en` 那套整个删掉）。
- 正文单行长度 65–75ch；侧卡 300–380px 宽时约 34–40 个汉字，已在范围内，禁止再压窄。

## 布局

**星场是背景层，不是卡片里的一张图**（这是与「仪表盘」最本质的区别）。canvas 铺满整个视口并固定在最底层，`Stage.field`；所有 UI（顶栏、左筛选、右详情、底部四星门）作为浮层挂在它上面（`Stage.top/left/right/bottom`，`.stk-stage-ui` 整体 `pointer-events:none`，只有面板自身接收指针），中间那块不画任何背景——留白只属于星场。

浮层面板必须**实底** `--surface` + 1px hairline：星点从面板底下穿过时被完全挡住，不做半透明、不做毛玻璃（否则星点会在字上爬）。反过来说，**人格恒星与当前选中星必须落在中间可视区**：相机 target 以「扣除左右栏后的中栏中心」为原点，而不是视口几何中心。

尺寸固定：左 `--hud-w 296px`、右 `--hud-w-r 316px`、外边距 `--edge 20px`、三栏 gap 20。面板自身滚动，页面不滚动。

卡片内部节奏固定：标题行 → 8px → 内容 → 12px → 操作行。**更多空间给分组之间，更少给组内**；标题上方留白必须大于下方。

## 星场系统

**半径阶梯**（1x，按重要度）：人格恒星 13 → L3 6.5 → L2 5 → L1 4 → L0 3.2，暗星 × 0.78。渲染时再乘景深系数，但**阶差不能塌**：任何两颗不同层的星，半径差 ≥ 1.2px。

**命中区 ≥ 12px**：视觉半径可以 3.2，点击半径不能是 3.2。所有星点画一个不可见 12px 命中圆，悬停时命中区上浮一层 6% 白光，让用户知道「点得中」。

**摆位**：忆云四层同心壳（L3 内 → L0 外），壳内球面黄金角均匀铺点；壳半径 `r = sqrt(r0² + t(r1² − r0²))` 保证面积均匀（不是半径均匀）。单壳云（典籍/构筑/技艺）用同一套单壳。禁止平面均分角度 —— 那是「星点挤成一条线」的根因。

**边**：只有三种。① 记忆提取链（L1→L0 `出自原文`）② 会话相邻（同 session 左右相邻）③ 引用（refs）。边是 1px、静止 22% 白；只有**选中星的边**升到层色、宽 1.4。边不许发光、不许动画流动（流动线是「看起来很忙」的典型）。

**相机**：默认 yaw 0.4 / pitch 0.18 / zoom 1.05，焦距 `f = min(w,h) × 1.26 × zoom / (z + 8)`。**点星不改相机**（`viewRef` 持久化）；只有用户拖拽/滚轮能改。自动旋转是可选开关，默认关。

## 动效

只有**一个**被授权的动效时刻：**进云时星场点亮** —— 星点从中心向外 420ms 依次亮起（每颗错开 18ms），曲线 `cubic-bezier(0.23,1,0.32,1)`。这是「解释」型动效：它说明云的形状是由内向外长的。

其余全部按下表，且**点击星点不播放任何动画**（一天点几百次的东西不该有延迟感）：

| 场景 | 时长 | 曲线 | 做法 |
| --- | --- | --- | --- |
| 按钮按下 | 120ms | ease-out | `transform: scale(0.98)` |
| 悬停 | 150ms | ease | 背景/描边，不做位移 |
| 选中环 | 120ms | ease-out | 直接切，只过渡描边透明度 |
| 侧卡出现 | 200ms | ease-out | `translateY(6px) + opacity`，不是 `scale(0)` |
| 进云点亮 | 420ms | ease-out | 唯一的长动效，只发生一次 |

禁止：`transition: all`、`ease-in`、任何 `infinite` 呼吸动画（`.live-dot` 的 blink 删除）、任何滚动/翻页的位移动画。

## 组件

**Card（面板卡）**：实色 `surface` + 1px `hairline` + `rounded.lg 11px` + `padding 12px`。**只有一层**，不许 inside 再套描边框，不许左上角渐变，不许 `backdrop-filter`。

**RowItem（列表行）**：高 26px，左主文右数字；hover 用 `surface-2`，选中用 22% 层色底 + 左侧 2px 层色条（唯一允许的彩色边条，因为它是选中态语义，不是装饰）。

**Pager（分页）**：一行两段 —— 读数额「共 N 条 · 每页 100 · 第 1 / 27 页」+ 控制「上一页 · 1 2 3 … 27 · 下一页」。当前页 **不用方框**（方框是后台管理组件的默认长相）：当前页文字转 `ink` + 底部 2px 层色短线，其余页 `dim`，hover 转 `ink`；数字全部 tabular-nums；窗口超过 7 格用 `…`。

**Legend（图例）**：圆点 + 名称 + 数量，一行一个，最多 6 行；圆点直径 7px，颜色取层色/云色。

**Gate（星门）**：整行可点的一行文字 + 右侧计数，不做卡片网格（网格是「卡片是懒容器」的复发）。

**ScopeBar（观测对象）**：一行面包屑「团队 / 智能体 / 记忆块」+ 右侧切换按钮。记忆块**只在忆云里出现**（已定）。

**DetailCard（星点详情）**：单卡，顺序固定 —— 名称（title）→ 状态与所属库（body-sm）→ 键（key，可复制）→ 关联星点（可点的 RowItem 列表）→ 全文（折叠，展开后 `pre` 内滚动，max-height 320px）。展开是同一张卡变高，**不弹窗、不叠卡**。

## 浏览器原生表面（最便宜、也最常被跳过的信号）

选区底色 `selection`（22% 层蓝）+ 继承文字色；插入符颜色 `ink`；焦点环 2px `focus` + `outline-offset: 2px`（不许 `outline: none` 了事）；滚动条 8px、thumb `rgba(160,180,220,0.35)`、hover `0.5`；`color-scheme: dark` 让原生日历/下拉跟深色走。

## Do

- 先做「最亮一块是星场」的截图判据，再谈其他。
- 层色只承载语义（层、云、选中），不承载情绪。
- 数字用 tabular-nums，单位与数值之间不断行。
- 空态必须写清「是窗口为空、还是库里本来就空」，并给出下一步动作。
- 权限不足时禁用并说明原因，不隐藏入口（隐藏会让用户以为功能不存在）。

## Don't

- 不许 `backdrop-filter` / `filter: blur` 做装饰；不许半透明卡片叠半透明卡片。
- 不许卡里套卡；不许彩色 `border-left` >1px（选中态 2px 条是唯一例外）。
- 不许全大写 + 宽字距的 eyebrow；不许 01/02/03 编号装饰。
- 不许 Unicode 符号/emoji 当图标（▶、◆、·），图标只用真实 SVG 或不用。
- 不许渐变文字；不许零偏移彩色光晕；不许 `transition: all`、`ease-in`、无限动画。
- 不许在星云里缩略/裁切品牌渐变或层色（层色必须整片一致）。

## 验收清单（每次改 UI 必跑，一条不过就不算完）

1. 截图里最亮的一块是星场，不是卡片。
2. 卡片只有一层，无 blur、无内套描边、无角标渐变。
3. 正文对比度 ≥4.5:1（`dim` 5.77 起），图形（星点/边/图标）≥3:1（`star-dim` 4.38 起）。
4. 全屏没有一处全大写宽字距小标签。
5. 所有计数/页码/时间 tabular-nums，翻页不抖动。
6. 焦点环、选区、滚动条、插入符都跟调色板一致。
7. 点星不重置相机、不播放动画、侧卡不重建。
8. 半径阶梯不塌（不同层半径差 ≥1.2px）；**摆位层面**同壳内两星世界坐标距离 ≥ 两半径之和 + 0.02（3D 投影后的视觉重叠允许，但人格恒星与选中星必须永远在最上层，不许被压住）。
9. 分页是「共 N · 每页 M · 第 x/y 页 + 上一页/页码窗口/下一页」，没有「更早」。
10. 空态区分「窗口内无数据」与「库里无数据」，并给下一步。
11. 键盘可走：Tab 到每个星门/星点/按钮都有可见焦点环。
12. 中英文混排不出现行内断字、数字与单位分离。
13. 星场是背景：截图里星星在中栏一直铺到窗口边缘（不是被裁在一个卡片框里），面板遮住星星处不透光；人格恒星不被任何面板压住。

## 迁移清单（按此改代码，逐条可验证）

1. `tokens.css:110-124` —— `.card2` 去掉 `backdrop-filter` 两行，`background: var(--panel)` 改 `var(--surface)`，新增 `--surface: #0A0E18`、`--surface-2: #0E1524`。
2. `tokens.css:126-146` —— 删 `.card2::before`、`.card2::after`。
3. `tokens.css:158-163` / `:186-191` —— 删 `.ch-en`、`.sm-label` 的全大写与 0.16em 字距；eyebrow 文案直接删。
4. `tokens.css:164-176` —— 删 `.live-dot` 的 `box-shadow` 与 `sm-blink` 动画。
5. `tokens.css:236-241` —— `.sm-btn.primary` 去 `box-shadow`，改实色 `#1B4B86` + 1px 亮描边。
6. `CloudCanvas.tsx:403` —— 暗星 `'#41506E'` → `'#66799B'`。
7. `CloudCanvas.tsx:390` —— 半径阶梯改为按层查表（persona 13 / L3 6.5 / L2 5 / L1 4 / L0 3.2，暗星 ×0.78），保持阶差 ≥1.2px。
8. 全局 —— 加 `::selection`、`:focus-visible` 环、`font-variant-numeric: tabular-nums` 到 `.num/.metric/.st-pager`。

## 非目标

不做浅色主题（观测台场景是夜间长用）；不做自绘图标库（只用现有 SVG，没有就留白）；不改任何数据口径与接口（本文件只管画出来的那层）。
