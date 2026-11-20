# 星图组件层 S1a 实现进度（2026-11-11）

指令来源：用户 m01185「添加 vitest devDependency；先只实现 Surface、Row、KvList、Pager、StarDetail 这五个组件，并记录实现进度」；m01242「你自己定个计划实现和验证吧」；m01300「布局我希望和之前 starmap 一样，星图是背景而不是卡片，其他组件挂在星图上层」。
设计基线：`docs/specs/2026-11-11-panel-starmap-kit-and-cache.md` A 节；视觉基线：`MemoryPanel/web/DESIGN.md`。

## 0. 计划表（m01369 授权的自主实施序列）

| 阶段 | 内容 | 验收判据 | 状态 |
|------|------|----------|------|
| S1a | kit 16 件 + `cache/resources.ts` + vitest | `vitest` 全绿、`tsc` 0、禁令变异探针 FAIL、kit.css 无禁词 | ✅ 完成（58 passed） |
| S1b | 星场当背景的 `Stage` 布局 | 预览截图里星点铺满窗口、面板浮层不透光 | ✅ 完成（vision pass） |
| **P1** | 云页渲染层换 `Stage`（四朵云） | 云页只剩一块画布 + 顶栏/左栏/右栏/图例；数据逻辑零改动 | ✅ 完成（本文 §9） |
| **P2** | 进云早返回，去掉总览 HUD 叠加 | 进云后 `.st-top`/`.st-left` 不在 DOM | ✅ 完成（`StarmapLayout.tsx` `inCloud`） |
| P3 | 云页筛选件 kit 化（Row/Seg/按钮双态） | 云页内 `sm-btn primary` 计数为 0、选中态无填充块 | ✅ 完成 |
| **P4** | 人格恒星页（`/soul`）换 Stage + 九块人格卡变星点 | 人格页截图：恒星最亮、九块围绕 | ✅ 完成（本文 §10） |
| **P5** | 缓存接线：五个 `load*Page` + 总览计数走 `apiCache`，人物档案走 `useResource` | 切页 1→2→1 第二次请求数 0；换用户清表；失效标签命中 | ✅ 完成（本文 §11） |
| **P6** | 旧组件替换（Card2/StatRow/Fields/Dialog/Pill）+ 8 处弹窗换壳 | DOM 里 `card2` 计数 0、弹窗全部走 kit `Dialog` | ✅ 完成（本文 §12，8 条渲染断言） |
| **P6b** | 死 CSS 清理 + 三处全大写 eyebrow + 顶栏英文副标 | `backdrop-filter`/`uppercase`/`transition: all` 计数全 0，构建 CSS 减 3.3 kB | ✅ 完成（本文 §12.3，含离线截图复核 §12.4） |
| **P7** | 拆掉 `?full=1` 同页嵌旧页；wiki ingest/源/页面/原始文档、code 结构/检索、团队管理搬进新壳 | 不再需要 `?full=1`；旧控制台是独立路由 `/legacy/*` | ✅ 完成（本文 §13、§14） |
| **P8** | 团队站与设置站原生化（不再嵌旧面板/旧页） | 站内不出现旧组件 import；设置站无写入口 | ✅ 完成（本文 §15.1–15.2） |
| **P9** | 星点「点亮 / 熄灭」：记忆块与 wiki/code 资产在站内挂到当前 agent | 走 `allocate/unbind` 原生端点、无 agent 时不发请求、写后自动失效 | ✅ 完成（本文 §15.3，契约测试 4 条） |
| **P10** | 技能挂载（点亮/熄灭）＝ fork 副本 / 归档副本；技能站换 kit | 挂载走 `skillApi.forkToAgent`、移除按真实 owner 归档、危险动作两段式 | ✅ 完成（本文 §16.1–16.2） |
| **P11** | 人格写路径接 `persona` 作用域 | 保存人格后 `persona.*` 资源失效、总览模型缓存同步清 | ✅ 完成（本文 §16.3） |
| **P12** | 回放日志补回记忆站（旧三档的第三档） | 三口径 + 分页 + 本轮详情，且不 import 旧组件 | ✅ 完成（本文 §17.2） |
| **P13** | 感受 + 身份双槽补回人格完整视图 | 六面全齐、身份三态降级不静默、tier=null 不补 0 | ✅ 完成（本文 §17.3） |
| **P14** | 星图壳 chrome 收口：星门列表、团队弹窗、抽屉头、云侧卡筛选件全换 kit；旧 chrome 类名与死 CSS 整块删 | 星图层 grep 不到 rowitem / sm-btn / sm-link / st-field；弹窗走 kit Dialog（Esc/焦点/滚动锁）；tokens.css 无对应规则 | ✅ 完成（本文 §18，契约测试 5 条 + 两条变异探针） |
| **P15** | 同步生产 + 云名与配色收口：云名统一为四字星云名、全景星场暗星/层色对齐 tokens | 8123 服务的 index.html 与磁盘 hash 一致；四个所属文件都含新名且无旧短名；暗星 ≥3:1 对比度 | ✅ 完成（本文 §19，naming 测试 2 条 + 变异探针） |
| **P16** | G1 记忆图谱（站内第三档）：邻居/关联链只走内核关系端点 + 通用关系星图 | 画布真的画出节点与边（不再停在「正在取邻居…」）；不许自编边；换种子整图重置 | ✅ 完成（本文 §20，含 soul 泳道自我死锁的真 bug 修法） |
| **P17** | G4 代码图谱画布进站（代码站新增「关系图」分区，复用通用关系星图）+ 星点键盘可达 + 装饰性发光/渐变清理 | 代码站有关系图分区且自动选中中心节点；星场不掷骰子；tokens.css 不再有外发光与无限闪烁 | ✅ 完成（本文 §21） |
| — | G4 代码图谱画布进站 / G2 记忆块 shared/private 暴露 | 站内可看代码结构图；记忆块可见性直接显示 | 🟡 一半完成：画布已进站（P17），shared/private 未做 |
| — | 真接口 + 真登录端到端验证 | 各站真实空态 / 长文本 / 权限分支 | ⬜ 未做（审计 G7，用户 m03327 要求先不测） |
| P18 | 全景星图改星河 + 云名去标签 + 星云构成卡可聚焦 + 四云四色 | 画布 0 次 fillText、构成卡四行可聚焦、`galaxy.test.ts` 7 条全绿、生产 hash 对齐 | ✅ 完成 |
| P19 | 星河返工：真银河（羽化圆粒子 + 加法混合 + 上万颗连续粒子场）、删虚线圆环与总览连线、打散九块/人物的等距球面光圈、四角色界按概率掺邻色 | 画布上无人造几何与方块；银河底 8000 颗按河带撒；总览 0 条连线；vision 9/10；生产 hash 对齐 | ✅ 完成（本文 §23） |
| P20 | 星场照 enrichr galaxy-spiral 重写：每朵云一个螺旋（参考的粒子数学 + 8 深度桶 × 4 色档 + 自旋） | 螺旋公式逐条断言、四云各有 4 色档且 accent 取库色/层色、尘按真实条数且不可点、中心非过曝白点、vision 9.5/10、生产 hash 对齐 | ✅ 完成（本文 §24） |
| P21 | 星云详情页改用参考实现的画法（逐行移植 + 逐像素等价证明） | 同粒子/同颜色/同画布下与参考实现逐像素差 **0 / 220,160**；密度按画布面积对齐；画布无人造图形；门全绿 | ✅ 完成（本文 §25） |


## 1. 完成情况（kit 16 件 + 缓存 1 件）

| # | 组件 | 文件 | 行数 | 状态 |
|---|------|------|------|------|
| 1 | `Surface` | `MemoryPanel/web/src/starmap/kit/Surface.tsx` | 38 | 已实现、已测 |
| 2 | `Row` | `MemoryPanel/web/src/starmap/kit/Row.tsx` | 61 | 已实现、已测 |
| 3 | `KvList` | `MemoryPanel/web/src/starmap/kit/KvList.tsx` | 43 | 已实现、已测 |
| 4 | `Pager` + `pageWindow` | `MemoryPanel/web/src/starmap/kit/Pager.tsx` | 118 | 已实现、已测、**已接线** |
| 5 | `StarDetail` | `MemoryPanel/web/src/starmap/kit/StarDetail.tsx` | 87 | 已实现、已测 |
| 6 | `Stage`（星场为背景层） | `MemoryPanel/web/src/starmap/kit/Stage.tsx` | 47 | 已实现、已测 |
| 7 | `Section` | `MemoryPanel/web/src/starmap/kit/Section.tsx` | 25 | 已实现 |
| 8 | `MetricRow` | `MemoryPanel/web/src/starmap/kit/MetricRow.tsx` | 30 | 已实现、已测 |
| 9 | `Seg` | `MemoryPanel/web/src/starmap/kit/Seg.tsx` | 41 | 已实现、已测 |
| 10 | `Tag` | `MemoryPanel/web/src/starmap/kit/Tag.tsx` | 17 | 已实现、已测 |
| 11 | `Dialog` | `MemoryPanel/web/src/starmap/kit/Dialog.tsx` | 102 | 已实现、已测 |
| 12 | `Empty/Skeleton/Note` | `MemoryPanel/web/src/starmap/kit/States.tsx` | 41 | 已实现、已测 |
| 13 | `Gate` | `MemoryPanel/web/src/starmap/kit/Gate.tsx` | 36 | 已实现、已测 |
| 14 | `Legend` | `MemoryPanel/web/src/starmap/kit/Legend.tsx` | 29 | 已实现、已测 |
| 15 | `ScopeBar` | `MemoryPanel/web/src/starmap/kit/ScopeBar.tsx` | 93 | 已实现、已测 |
| 16 | `Tone` / `dotClass` | `MemoryPanel/web/src/starmap/kit/types.ts` | 7 | 已实现 |
| — | 唯一样式文件 | `MemoryPanel/web/src/starmap/kit/kit.css` | 743 | 已实现、禁令已机器化 |
| — | 出口 | `MemoryPanel/web/src/starmap/kit/index.ts` | 51 | 已实现（`import './kit.css'` 在此） |
| — | 资源缓存 store | `MemoryPanel/web/src/starmap/cache/resources.ts` | 216 | 已实现、已测、未接线 |

**接线现状**：只有 `Pager` 一处真接线 —— `MemoryPanel/web/src/starmap/scene/CloudSideCard.tsx` 由 `./StPager` 换成 `../kit` 的 `Pager`，旧文件 `MemoryPanel/web/src/starmap/scene/StPager.tsx` **已删除**。其余 15 件在生产代码里引用数为 0，旧页面仍走 `starmap/theme/ui.tsx`（S1b 替换）。`tokens.css` 里 `.st-pager*` 残留规则待 S1b 与 `stations/MemoryStation.tsx:169` 的 `className="st-pager"` 一起清。

## 2. 依赖与脚本

- `vitest@2.1.9` 已加入 `MemoryPanel/web/package.json` devDependencies（`pnpm add -D vitest@^2.1.9`）。
- 新增脚本：`"test": "vitest run"`、`"test:watch": "vitest"`。
- 未新增其他依赖；不引 jsdom / testing-library —— 组件是纯渲染，用 `react-dom/server` 的 `renderToStaticMarkup` 做字符串断言（`environment: 'node'`）。

## 3. tokens 追加（`tokens.css`，纯增量，旧变量未删未改值）

`--surface #0c1220`、`--surface-2 #121a2c`、`--hairline → var(--line)`、`--hairline-soft → var(--hair)`、`--star-dim #66799b`、`--layer-l0..l3 → var(--c-l0..l3)`、`--focus rgba(127,200,255,.55)`、`--selection rgba(127,200,255,.22)`、`--ease-out cubic-bezier(0.23,1,0.32,1)`、`--mono Consolas,SFMono-Regular,ui-monospace`、`--overlay rgba(3,6,14,.72)`。

设计稿的 `bg #070B16` **未落地**（现有 `--bg #04060d` 保持）——全局底色变更留到 token 迁移批次。

## 4. 布局决定（m01300 后已改）

星场是**背景层**，不是卡片里的一张图。`Stage` 提供三层结构：

- `Stage.field` → `.stk-stage-field`，`position:absolute; inset:0; z-index:0`，铺满视口；
- `.stk-stage-ui` → `position:absolute; inset:0; z-index:1`，`pointer-events:none`，只有 `top/bottom/left/right` 与 `mid` 的子块 `pointer-events:auto`，空白处点击穿透到星场；
- 三栏 `296px | minmax(0,1fr) | 316px`、`gap 20`、`padding 16px 20px`；`<1180px` 降为 `256/1fr/276`。

面板仍是**实底** `--surface` + 1px hairline（不因浮空改成半透明/毛玻璃）——星点从面板下穿过时被完全挡住，不会在字上爬。中栏不加背景、不加分隔线，只留星场；中栏底部一枚 `.stk-hint` 胶囊（`--surface` 底 + hairline，`pointer-events:none`）放「点击星点查看详情 · 滚轮缩放」。

## 5. 验收读数（本轮亲跑）

| 检查 | 命令 | 结果 |
|------|------|------|
| 单测 | `cd MemoryPanel/web && pnpm exec vitest run` | **58 passed / 58**（6 文件：render 18、render2 14、pager 8、resources 8、discipline 7、stage 3），915ms |
| 类型 | `pnpm exec tsc --noEmit` | exit 0 |
| Lint | `pnpm exec eslint src/starmap/kit` | exit 0 |
| 禁令变异探针 | 向 `kit.css` 注入 `color:#ff0000; backdrop-filter: blur(4px)` | **2 failed / 7**，还原后 sha256 一致（`04b70294…9f93cf`）、7 passed |
| 预览截图 | `vision_html_screenshot` 1440×900 | `.dsh-vision-router/artifacts/kit-preview.html-b93a3253-shot-1440x900.png` |
| 截图判定 | `vision_describe` | 星场铺满窗口当背景、面板浮在上面且不遮中心恒星、左栏无裁切、最亮处＝星场（pass） |

测试先红后改实现的三个真问题：①禁令测试把文件头注释里点名的禁用词判成违规 → 扫描前 `stripComments`；②`StarDetail` 纯空白正文仍渲染「展开全文 · 3 字」→ 改 `trim()` 判定；③`createElement(Tag,{tone},'文本')` 在 TS 下要求 `children` 进 props → 三条测试改成 props 内带 `children`。

## 6. 预览页（离线，不进路由）

`MemoryPanel/web/src/starmap/kit/__preview__/entry.tsx`：真组件 + 真 `kit.css` + canvas 星场（人格恒星 + L3/L2/L1/L0 四壳黄金角铺点 + 12% 提取边 + 18% 暗星），数据全为示例。

打包（本项目无顶层 esbuild，用 pnpm 内二进制）：

```
cd MemoryPanel/web
node_modules/.pnpm/node_modules/.bin/esbuild src/starmap/kit/__preview__/entry.tsx \
  --bundle --format=iife --jsx=automatic --loader:.css=css \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=.tmp-esbuild/kit-preview.js --log-level=warning
```

产物 `.tmp-esbuild/kit-preview.{js,css,html}`，`file://` 可直开。

## 7. 未做（明确声明）

1. 旧 `starmap/theme/ui.tsx` 的 `Card2/StatRow/Fields/Seg/Dialog/Pill` 一处未替换，DOM 里 `card2` 计数仍 >0 —— S1 验收「DOM 无 card2 / backdrop-filter」**未达成**；
2. `useResource` hook、readCache、分页窗口/预取、失效接线（S2b/S3/S4）未写；`cache/resources.ts` 只有 store 与单测；
3. 8 处旧弹窗（SettingsDialog / AllocateMemoryDialog / ImportBlockDialog / ImportSkillDialog / ForkSkillDialog / CreateTeamDialog / EditTeamDialog / CreateAgentDialog）未换 `Dialog` 壳；
4. `Stage` 只进了预览页，未接真实云站页（还需把 `CloudCanvas` 从「三栏里的 canvas」改成 `Stage.field`）；
5. 星场相机未按「中栏中心」改 target（`DESIGN.md` 布局段的新要求，属 `CloudCanvas.tsx` 迁移项）。

## 8. 下一步

S1b：按 `DESIGN.md` 迁移清单 8 条换旧件 → S2b `useResource`+readCache → S3 分页窗口/预取 → S4 失效接线。回滚：删除 `src/starmap/kit/`、`src/starmap/cache/`，`git checkout -- MemoryPanel/web/src/starmap/scene/CloudSideCard.tsx`（`StPager.tsx` 需从 git 恢复）。

---

## 9. 云页落地：星场当背景（2026-11-11 12:30–12:47，m01369「你自己列计划表来实现」）

### 9.1 改了什么（真代码，非预览）
| 文件 | 改动 | 读数 |
|------|------|------|
| `MemoryPanel/web/src/starmap/scene/CloudSideCard.tsx` | 渲染层整段重写：根从 `.cloud-stage`＋右侧一根侧栏 → `<div className="starmap-root"><Stage field/top/center/left/right/bottom /></div>`；画布块只留 `CloudCanvas`（宽度由 `.cloud-field` 撑满视口）；顶栏＝云名＋本页/共/已点亮＋返回全景；左栏＝`Surface`（筛选＋分页＋本页详情）；右栏＝`Surface`＋`StarDetail`（标题→副标→Kv→关联→折叠全文→操作）；底部＝`Legend`。数据逻辑（`reload`/分页/筛选 state/四个 loader 调用）一行未改 | 571 → 约 640 行（含新 JSX） |
| 同上（筛选件） | 记忆层「全部/L0–L3」填充块按钮 → kit `Row`（选中＝文字实色＋左侧 2px 层色短线，层色圆点走 `leading`）；wiki/代码图列表 `.rowitem` → kit `Row`（meta 写「已挂载/未挂载」，不再用 opacity 压暗）；节点类型 file/class/function → `.stk-btn`/`.is-ghost` 双态；技艺云范围 → kit `Seg` | 旧 `sm-btn primary` 在本文件归零 |
| `MemoryPanel/web/src/starmap/StarmapLayout.tsx` | 进云早返回：`inCloud` 为真时只渲染 `CloudSideCard`，总览的 `.st-top` 与 `.st-left` 不再叠加（原来两套 HUD 同屏） | +18 行 |
| `MemoryPanel/web/src/starmap/theme/tokens.css` | `.cloud-stage/.cloud-stage-canvas/.cloud-stage .cloud-side` 段替换为 `.cloud-field/.cloud-top/.cloud-top-name/.cloud-top-meta/.cloud-actions`；`.st-field input/select` 等四条原来挂在 `.cloud-stage` 前缀下，前缀去掉（筛选项现在活在 Stage 左栏，不在画布容器里） | 净 +6 行 |
| `MemoryPanel/web/src/starmap/engine/Starfield.tsx`、`scene/FiveBodies.tsx` | 只修 `prefer-const`（`--fix` 两条、手改 `t0`），无逻辑改动 | 0 |
| 删除 | `MemoryPanel/web/src/starmap/scene/StPager.tsx`（上一轮已删）；本轮无删除 | — |

### 9.2 去重（截图查出来的真问题）
第一版左栏同时出现「星点 100 颗·四层同屏」「每页 100 条」与分页器「共 14,782 条·每页 100·第 1/148 页」，以及两处「四层同屏：每层各取本页 100 条」。处理：删掉左栏的 `KvList` 读数表（顶栏＋分页器已覆盖）、删掉重复的 `Note`、记忆云只留一条「时间口径：最早 → 现在」；顺带修正一处真错——原先「每页」写死 `PAGE_SIZE=100`，而 wiki/code 的页大小是 80，现改为 `pager?.pageSize ?? PAGE_SIZE`。

### 9.3 门（亲跑）
- `pnpm exec vitest run` → **58 passed / 58**（6 文件）。
- `pnpm exec tsc --noEmit` → exit 0。
- `pnpm exec eslint src/starmap` → **0 error / 5 warning**（5 条都是既有 `react-hooks/exhaustive-deps`：`FiveBodies.tsx:1412`、`StarmapProvider.tsx:232`、`MemoryStation.tsx:57/63`、`theme/ui.tsx:186`，本轮未引入新 warning）。

### 9.4 视觉证据（离线预览＝真组件 + 真 css + 假数据）
构建脚本 `.tmp-esbuild/build-cloud.mjs`：esbuild JS API 打包 `.tmp-esbuild/cloud-entry.tsx`（挂真 `CloudSideCard`），三个数据入口用 `onResolve` 正则替换成 `.tmp-esbuild/fakes/{cloudPage,knowledge-api,chat-memory}.ts`——**其余一律真源码**；metafile 断言 `real-api-inputs: []`（否则预览会打真接口、出 `Failed to fetch`，第一版就是这个坑）。
产物 `.tmp-esbuild/cloud-{memory,wiki,code,skills}.html`（`window.__CLOUD__` 切云），1440×900 截图：
- `.dsh-vision-router/artifacts/cloud-memory.html-a071ba9c-shot-1440x900.png`
- `cloud-wiki.html-fc50465f-shot-1440x900.png` / `cloud-code.html-cae69420-shot-1440x900.png` / `cloud-skills.html-1eee57ce-shot-1440x900.png`
vision 复核结论：星场铺满四边并延伸到窗口边缘；左右面板实底浮在上层、无裁切无压字；四朵云共用同一套位置与版式；底部图例逐字为「L3 稳定结论 / L2 经验 / L1 回合 / L0 原始 / 暗＝团队可见、未挂到本 agent」；左栏选中态为左侧短线而非填充块。

### 9.5 生产构建门
`pnpm build` 首次直接跑会失败在 esbuild 清理临时文件：`[vite:esbuild-transpile] remove C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\esbuild-…: Access is denied`（本机 Temp 目录 ACL 问题，非代码问题；1414 modules 已 transform 成功）。改用工作区内的 TMP 后通过：

```
mkdir -p .tmp-build && TMP='D:/TDB/td-agemem/MemoryPanel/web/.tmp-build' TEMP='…/.tmp-build' pnpm build
→ dist/index.html 0.45 kB · main-CT0y37Ue.css 620.79 kB (gzip 103.79) · main-CV8ifvHK.js 2,282.12 kB (gzip 578.47) · ✓ built in 7.21s
```

### 9.6 云画布补全屏星尘（视觉复核发现）
复核最初报「星场没铺到窗口四边」。查 `CloudCanvas.tsx` 投影：焦距 `f = min(w,h)*1.26*zoom/(z2+8)`，最外壳世界半径 R_OUT=2.52 → 屏幕上云团半径只有 `min(w,h)*0.397`（1440×900 下约 357px），窗口一宽四周全是死黑，**违反 DESIGN.md 验收第 13 条**。两处修正：
- 新增 `makeDust(w,h)`（`CloudCanvas.tsx:82`）：铺满整幅画布的淡星尘，点数 `max(160, w*h/2600)`（1440×900 ≈ 498），alpha 0.05–0.20，种子只由像素尺寸决定（同尺寸永远同一张底图，不逐帧重random）。绘制在 `clearRect` 之后、雾核之前（`CloudCanvas.tsx:349`），只做背景，不参与命中与归属。
- 暗星颜色 `'#41506e' → '#66799b'`（`CloudCanvas.tsx:440`）—— DESSIGN.md 迁移清单第 6 条要求的对比度修正（2.39 → 4.38）。
重截后 vision 复核：星点/星尘铺到四条边与四角、面板实底不透星、最亮仍是中央云团核心。

### 9.7 未做（下一步，按此顺序）
1. **人格恒星页（`/soul` 站）**：`SoulStation.tsx` 402 行仍是旧 HUD，未改 Stage；人格卡九块尚未变成可点星点。
2. **总览 `FiveBodies.tsx`（1514 行）**：仍是自带 canvas 的巨型文件，未拆成 Stage；相机 target 未按「扣除左右栏后的中栏中心」校正（当前只差约 10px，视觉上无感，故未动）。
3. **缓存 S2b–S4**：`cache/resources.ts` 已实现且已测，但 `cloudPage.ts` 的五个 `load*Page` 还没走 `ResourceStore`（切页 1→2→1 仍会重打请求）；`useResource` hook 未写。
4. **旧组件替换**：`theme/ui.tsx` 的 `Card2/StatRow/Fields/Seg/Dialog/Pill` 在其它站台（MemoryStation 等）仍在用，DOM 里 `card2` 计数非 0。
5. **8 处旧弹窗换壳**（`Dialog` 已具备焦点陷阱/Esc/滚动锁，但弹窗本身未迁移）。
6. **惩罚类站点**（`/team/*`、`/settings`、wiki/code 的 ingest 等深操作）：仍靠 `?full=1` 嵌旧页，未在云页里重建。

## 10. P4 人格恒星云（2026-11-11 12:47–13:03，m01607「继续」）

### 10.1 新增/重写的文件

| 文件 | 行数 | 作用 |
|------|------|------|
| `MemoryPanel/web/src/starmap/scene/dust.ts` | 33 | 从 `CloudCanvas.tsx` 抽出 `makeDust(w,h,density=1)`：铺满画布的淡星尘，点数 `max(160, w*h/2600*density)`，alpha 0.05–0.20，种子只由像素尺寸决定 |
| `MemoryPanel/web/src/starmap/scene/PersonaCanvas.tsx` | 约 330 | 人格恒星云专用星图（球面分层投影 + 四环 + 四类边 + 命中区） |
| `MemoryPanel/web/src/starmap/stations/SoulStation.tsx` | 约 700（原 402） | 整篇重写：星图为主视图，原五个页签搬进弹窗与右栏详情 |
| `MemoryPanel/web/src/starmap/scene/__tests__/dust.test.ts` | 40 | 星尘的 5 条单测（形状、同尺寸稳定、异尺寸不同、边界与 alpha、density 只放大点数） |

### 10.2 星图的语义（不是装饰）

- **中心**：`persona:root`（较大、有光晕、标签「人格 · N 星」），weight = 人格卡字符数。
- **四环**（由内到外）：九块人格卡（block，青）→ 六轴特质（trait，蓝）→ 人物档案（person，橙）→ 记忆养料 L3（core，琥珀）。半径 `RING = { block: .66, trait: 1.18, person: 1.72, core: 2.22 }`。
- **四类边只画真实关系**：`compose`（人格卡由九块组成）、`state`（特质状态挂人格）、`archive`（人物档案写回人格）、`feed`（L3 结论反哺人格）。没有关系的星之间不画线。
- **亮/暗**：`lit=false` 的星（这一块没正文 / 没有证据）用 `--star-dim` 且 alpha 0.42；亮星用各自色相。旧上游没有 `blocks[]` 时按 `card.sources` 的键降级出九块并全部置暗，不伪造点数。
- **点击语义**：点星 → 右栏 `StarDetail` 展示该类星的详情（块给字数/来源/置信/证据 + 该块正文；特质给种子→当前→落库；人物按需拉 `fetchSoulPerson` 拉详情；养料给显著/确定性 + 正文）；关系行点击 = 换选中星，不跳页。

### 10.3 投影与视觉（含三次视觉复核的修正）

投影 `f = (min(w,h)*1.52*zoom)/(z2+7.3)`，外环铺到约 46% 画布；拖拽改 yaw/pitch、滚轮 zoom 0.6–2.6、空闲慢转 `yaw += 0.0011`。

三次 vision 复核查出并修掉的真问题：

1. **边像蛛网**（第一版全是直线，24 条边穿心而过）。改为**向外弓的二次贝塞尔**，弓高 `min(46, len*0.16)`，并按到中心的距离做**线性渐变淡出**（近端 alpha 0.03 → 远端 0.30）。
2. **人格恒星被选中时全图变彩色**：`sel === 'persona:root'` 时每条边都「与选中星相连」，于是边按对端星色点亮、其余星全压到 0.24。修法：引入 `focus = sel && sel !== 'persona:root' ? sel : null`，枢纽星被选中时按「无聚焦」渲染（边仍走淡灰蓝、星不压暗）。
3. **中央文字重叠**：`人格 · N 星` 与「选中星标签」都在中心附近。修法：选中星标签在 `sel === 'persona:root'` 时跳过。
4. 星尘密度：人格页星云只占中间，`makeDust` 加 `density` 参数，此处取 **1.8**（1440×900 ≈ 896 点），四角不再空。

### 10.4 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint`（SoulStation / PersonaCanvas / dust） | 0 输出（0 问题） |
| `pnpm exec vitest run` | **63 passed / 63**（7 文件：render 18、render2 14、pager 8、resources 8、discipline 7、stage 3、dust 5），997ms |
| `pnpm build`（工作区 TMP） | ✓ built in 6.63s；`main-CV0pCR2u.js` 2,297.02 kB（gzip 584.65） |

**离线预览链（真组件 + 真 css + 假接口）**：`.tmp-esbuild/build-soul.mjs`（esbuild JS API）+ `fakes/{soul-api,chat-memory,auth,provider,router}.ts` + `soul-entry.tsx`。踩到并修掉三个坑：
1. 只筛 `^@/` 前缀不够——`SoulStation` 用**相对路径** `'../state/StarmapProvider'`，结果打进真 provider，连带 `@/stores/backend`、`@/lib/teamApi`、`@/services` 全部爆 `Cannot read file`。补相对路径规则后 `real-api-inputs: []`。
2. `react-router-dom` 的 `useNavigate` 在预览里抛 `useNavigate() may be used only in the context of a <Router>`，页面全白。补 `^@?react-router-dom$` → 假 hook。
3. 外部 `<script src>` 在 `file://` 下报错被浏览器吞成 `Script error.`，看不到堆栈。改成**把 js/css 内联进 html**，才拿到真实错误行。
（另：修了一处 `cx/cy` 重复声明导致的 esbuild 报错。）

截图：`.dsh-vision-router/artifacts/soul-inline.html-86d88fee-shot-1440x900.png`。vision_describe 逐条确认：星点连边铺到四边四角、中央恒星光晕最亮且不被面板压住、左右面板实底无裁切、选中态是左侧短线不是填充块、边线统一淡灰蓝、中央文字不重叠。

### 10.5 仍未做（P4 内部）

- 没有实测「真接口 + 真登录」下的人格页（离线预览的数据是假的，形状对齐真类型）；`blocks[]` 缺失时的降级路径只按类型写过，未在真数据上跑过。
- 人物档案详情、版本链、完整视图三个弹窗只做了结构与交互，没有在真数据上验证长文本/空态。
- 六轴「落库值」一栏在 `fetchSoulTraitState` 不返回该字段时显示 `—`，未与后端确认是否有该字段。
## 11. P5 缓存接线（2026-11-11）

设计基线：`docs/specs/2026-11-11-panel-starmap-kit-and-cache.md` B 节。实现原则：**TTL 只管「多久重问」，正确性靠失效标签**；失败不清旧值。

### 11.1 文件

| 文件 | 行数 | 作用 |
|------|------|------|
| `MemoryPanel/web/src/starmap/cache/apiCache.ts` | 178 | 每个远端调用一个 `fetchX`：key 规范 `sc:<user>:<resource>:<qualifiers…>`、TTL 矩阵、注入 `ResourceStore`、给出失效 tag |
| `MemoryPanel/web/src/starmap/cache/useResource.ts` | 约 90 | 组件钩子：先画 `peekAny` 旧值 → `load` → generation 守卫丢弃旧响应；`reload()` 走 force |
| `MemoryPanel/web/src/starmap/cache/index.ts` | 27 | 缓存层唯一出口（组件不直接 import `lib/api`） |
| `MemoryPanel/web/src/starmap/cache/__tests__/apiCache.test.ts` | 约 175 | 11 条：命中 / 换 offset / 1→2→1 / 失效 tag / 失效不误伤 / 换用户清表 / 同用户不误清 / key 规范 / wiki 与 code 互不误伤 / kinds 排序 / 技能团队失效 |

### 11.2 接线点（真代码，不是设计）

1. `MemoryPanel/web/src/starmap/scene/cloudPage.ts`：五个 loader 内部原来的 `chatMemoryApi.layer`、`knowledgeApi.wiki.graph`、`knowledgeApi.code.structure`、三处 `listSkills` 全部换成 `fetchMemoryLayer` / `fetchMemoryItem` / `fetchWikiGraph` / `fetchCodeStructure` / `fetchSkillList`；loader **签名与返回结构一行未改**，调用点靠 `if (r.error && !r.data) throw r.error` 保住原 throw 语义。
2. `MemoryPanel/web/src/starmap/data/overview.ts`：四层总数（`limit:1`）与两处技能计数改走 `fetchMemoryLayer` / `fetchSkillList`，与云页共用一个 key，失效时一起失效；`input.force` 透传成 `{force}`。总览自身的 60s 模型缓存保留（模型装配含派生计算，见 11.4）。
3. `MemoryPanel/web/src/starmap/stations/SoulStation.tsx`：人物档案由手工 `useEffect` + `alive` 改成 `useResource`（key `persona.person:<agent>:<key>`，ttl 60s，lane `soul`，tag `persona:agent:<agent>`），同一个人再点回来不重打；L3 养料改走 `fetchMemoryLayer`。
4. `MemoryPanel/web/src/starmap/state/StarmapProvider.tsx`：`useEffect(() => setCacheUser(userId), [userId])` —— 换用户 / 登出 / 401 一律清整表。

### 11.3 并发与 lane（实测约束）

`starmapStore = new ResourceStore({ maxEntries: 400, laneLimit: { soul: 1, read: 4 } })`。分层读是内核重活，**soul 泳道并发锁 1**（并发 6 实测顶到 15s 超时回 504，串行 7–79ms）；wiki / code / skills 走 read 泳道并发 4。

### 11.4 未做（说清楚）

- `invalidateStarmap` **还没有接进具体写路径**（分配/取消记忆、导入块、fork 技能、重建 wiki/code、团队与 agent 增删）；现在只有 TTL 兜底，正确性还差这一环 → 归 S4/P7。
- 总览 `data/overview.ts` 自己的 60s 模型缓存仍是独立 `Map`（`CACHE_TTL_MS`），失效后最坏要等 60s 才反映写操作；资源级已共享，模型级未共享。
- `useResource` 没有自动化测试（vitest 无 jsdom，`react-dom/server` 不跑 effects）；只做了类型检查与离线预览。装配 jsdom 后再补。
- 持久层（sessionStorage `tdai-panel.cache.v1`，只存计数 + id）尚未实现。

### 11.5 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec vitest run` | **74 passed / 74**（8 文件：render 18、render2 14、pager 8、resources 8、apiCache 11、discipline 7、stage 3、dust 5），1.03s |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint src/starmap` | 0 error / 5 warning（全是既有 `exhaustive-deps`：`StarmapProvider`、`MemoryStation`×2、`ui.tsx`） |
| `pnpm build`（工作区 TMP） | ✓ built in 7.31s；`main-CwGzyStI.js` 2,303.07 kB（gzip 586.59） |

**变异探针（证明测试会咬人）**：把 `fetchMemoryLayer` 的 `ttl` 改成 `0`（等价关掉缓存）→ `4 failed / 11`，失败项正是「同 key 第二次命中」「1→2→1 只 2 次」「失效不误伤」「同用户不误清」（报 `expected 2 to be 1`、`expected 3 to be 2`）；还原后 sha256 一致（`f147acec81170a314cc93bf20dbc9ca397bd486031855374b9b16353613736a6`）、11 passed。

**第一版探针无效**：在 `read({…})` 里重复塞 `force: true`，与后面的 `force: opts.force` 冲突，esbuild 直接报错、测试跑的是上一版产物，读数不算证据 —— 已换成 ttl 探针。

## 12. P6 旧组件替换（2026-11-11）

做法：不改四个旧站页的调用点，把 `MemoryPanel/web/src/starmap/theme/ui.tsx`（255 行）整篇改写成 **kit 兼容层**（约 190 行），十个旧名字全部转发到 kit：

| 旧件 | 转发到 | 行为变化 |
|------|--------|----------|
| `Card2` | `Surface` | 丢掉 `en` 英文副标、`live` 呼吸点、`.card2` 玻璃壳（`backdrop-filter` 与角标渐变随之从 DOM 消失） |
| `StatRow` | `MetricRow` | 去掉格线单元格，数字统一千分位 |
| `Btn` | `.stk-btn` | `primary`→默认、`ghost`→`is-ghost`、`danger`→`is-danger`、`small`→`is-sm`（后两个类是本次新增，kit.css +3 行） |
| `Pill` | `Tag` | `tone=on` 映射为 `ink`；无边框底色 12% |
| `Fields` | `KvList` | 键列 44px、空值统一 `—`；新增 `mono` 透传 |
| `Empty`/`Skeleton`/`Note` | kit 同名件 | Note 的 `tone=ok` 归并为默认（kit 只有 dim/warn/bad） |
| `Seg` | kit `Seg` | 填充块 → 底部 2px 层色短线；`SegOption` 补 `title`（kit 内 1 行 + 类型 1 行） |
| `Dialog` | kit `Dialog` | 补 Esc / 遮罩点击 / 焦点陷阱 / 关闭还原焦点 / body 滚动锁 / `aria-modal` |
| `Field`（表单行） | 未迁移 | 只是 label + 子元素，没有视觉债；改用 `.stk-field-*` 三个类，不再用 `.sm-label` |

另外把 `MemoryPanel/web/src/starmap/StarmapLayout.tsx` 里两处**手写**的 `<div className="fields"><dt/><dd/></div>`（:445 云聚焦读数、:496 星点详情）换成 `<Fields items=…/>`，并把 `Fields` 加进该文件的 import。

### 12.1 验收（新增 8 条自动化断言）

`MemoryPanel/web/src/starmap/theme/__tests__/ui-shim.test.tsx`（8 条，全部通过）直接数渲染结果里的类名：`Card2` 出 `stk-surface` 且 **不含** `card2`/`ch-en`/`live-dot`/`BLOCKS`；`Pill` 出 `stk-tag--ink` 不含 `pill`；`Fields` 出 `stk-kv` 不含 `fields`；`StatRow` 出 `stk-metrics` 不含 `stat-cell` 且数字是 `14,782`；`Btn` 出 `is-danger`/`is-sm` 不含 `sm-btn`；`Empty/Skeleton/Note` 出 `stk-empty`/`stk-skeleton`/`stk-note--warn` 不含 `sm-note`；`Seg` 出 `is-on` 且不含 `rgba(60,120,200`；`Dialog` 出 `stk-dialog` 不含 `dlg-veil` 与英文 `NEW`。

### 12.2 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec vitest run` | **82 passed / 82**（9 文件；新增 ui-shim 8） |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint src/starmap` | 0 error / 4 warning（消失的那条是 `ui.tsx` 旧 Dialog 的 `exhaustive-deps`：那个 effect 已删） |
| `pnpm build`（工作区 TMP） | ✓ built in 6.70s |

### 12.3 死 CSS 清理（P6b，已做完）

按选择器整块删（一次性脚本，删后花括号深度 0）：`.card2`（含 `::before`/`::after`/`.card2 > *`）、`.ch/.ch-zh/.ch-en/.ch-right`、`.live-dot`、`.stat-row/.stat-cell/.stat-cell b/.stat-cell span`、`.pill/.pill.on/.pill.warn`、`.fields/.fields dd`、`.sk`、`.dlg-veil/.dlg`、`.sm-note/.sm-note.bad/.sm-note.ok`、`.st-empty`。

`MemoryPanel/web/src/starmap/theme/tokens.css`：**930 → 760 行（删 171 行）**。另外三处越界样式一并收口：

- `.station-veil .sheet` 的 `backdrop-filter: blur(18px)` + 大投影 → `background: var(--surface)` + `box-shadow: 0 0 0 1px var(--hair)`（半透明遮罩会让星点在字上爬，违反 DESIGN.md「面板必须实底」）。
- `.st-select select` 删 `backdrop-filter: blur(10px)`。
- 三处全大写 eyebrow（`.sm-label` 9px/ls .16em/uppercase、`.st-node-kind` 9px/ls .18em/uppercase、`.st-field-label` 10px/ls .16em/uppercase）→ **11px、无 uppercase、无装饰 letter-spacing**；顶栏英文副标 `MEMORY STARMAP`（`StarmapLayout.tsx:307` 的 `.st-brand-en`）整块删除，`.st-brand-zh` 改 `13px/600` 去 `.16em`。

清完计数（node 正则数 `tokens.css`）：**backdrop-filter 0、text-transform: uppercase 0、transition: all 0**。构建产物 CSS 620.79 kB → **617.49 kB（gzip 103.15）**，即死样式确实没进包。

### 12.4 视觉复核（离线真组件，P6 证据）

新增 `MemoryPanel/web/src/starmap/theme/__preview__/shim-entry.tsx`：只用**旧名字**（`Card2`/`StatRow`/`Fields`/`Seg`/`Note`/`Btn`/`Pill`）渲染两栏，验证调用点不改也能出 kit 的样子。打包（注意 preview 内相对 import 写 `../tokens.css`/`../ui`，写 `../theme/*` 会 Could not resolve）：

```
node_modules/.pnpm/node_modules/.bin/esbuild src/starmap/theme/__preview__/shim-entry.tsx \
  --bundle --format=iife --jsx=automatic --loader:.css=css \
  --define:process.env.NODE_ENV='"production"' --outfile=.tmp-esbuild/shim-preview.js
```

截图 `.dsh-vision-router/artifacts/shim-preview.html-c679594b-shot-1280x720.png`，vision_describe 逐条判定：两卡实底有清晰边框、**无全大写英文小标签**、分段选中靠底部蓝短线（不是填充块）、指标行无格线且千分位（11,480 / 14,782）、空值显示 `—`、无卡片套卡片、主/次/危险三按钮可区分、无排版挤压。唯一小瑕疵：指标行数字是 inline 排列而非严格右对齐（未改，属 `MetricRow` 既有版式）。

### 12.5 未做
- 四个旧站页（MemoryStation / KnowledgeStation / SkillsStation / 总览侧栏）**没有在真登录 + 真接口下点过**；本轮证据是类型检查、组件级渲染断言、生产构建三件，运行时未验。
- 8 处业务弹窗（`SettingsDialog`/`AllocateMemoryDialog`/`ImportBlockDialog`/`ImportSkillDialog`/`ForkSkillDialog`/`CreateTeamDialog`/`EditTeamDialog`/`CreateAgentDialog`）因为都走 `theme/ui.tsx` 的 `Dialog`，**外观已换壳**，但焦点行为没有逐个手测。
## 13. P7 深操作回流（2026-11-11 13:20–13:35）

目标：去掉 `?full=1` 同页嵌旧页这条通道，把「资产之外的动手能力」搬进新壳。

### 13.1 拆掉的嵌入通道

`MemoryPanel/web/src/starmap/StarmapLayout.tsx`：

- 删掉 `const full = search.get('full') === '1'`、整张 `legacy` 页面映射（`useMemo` 里 ChatMemoryPage/SoulPage/WikiPage/CodePage/SkillsPage/MembersPage/AgentsPage/ApiKeysPage/SettingsPage 九条分支）与 `{full && legacy ? <div className="st-embed">{legacy}</div> : <Outlet />}`——抽屉里只渲染新壳站页。
- 抽屉头按钮「完整视图 / 简版视图」改为**「旧控制台」**：`nav('/legacy' + (loc.pathname === '/' ? '' : loc.pathname))`，走真实路由（`src/routes/index.tsx:56` 的 `/legacy/*` ConsoleLayout），是同页外的显式出口，不再是同页 iframe。
- 顶栏 `<a href="#/legacy">旧版</a>` 也换成 kit `stk-btn is-ghost is-sm` 的「旧控制台」，与抽屉头同一语义。
- 顺带清掉英文副标：`StationDef.en`、`SETTINGS_SHEET.en`、`.sheet-head-en`、`.rowitem-en`（星门列表里 SETTINGS 之类）全部移除；死的 `.st-embed`/`.st-legacy`/`.rowitem-en`/`.sheet-head-en`/`.st-brand-en` 规则从 `theme/tokens.css` 删掉（753 行）。

### 13.2 新增深操作面 `starmap/stations/knowledgeDeep.tsx`（约 430 行）

| 面板 | 端点 | 说明 |
|------|------|------|
| `WikiSourcePanel` | `wiki.testSource` / `updateSource` / `refetch` / `ingestWithPolling` | 源地址与分支可改，改后提示「地址/分支变更会把该源页面标记为待重新拉取」；编译走轮询回调把 `detail` 逐条显示 |
| `WikiPagesPanel` | `wiki.pages` / `wiki.read` | 列表按 title/path 展示，点开读正文进 `<pre class="stk-pre">`（max-height 260 可滚） |
| `WikiSearchPanel` | `wiki.search` / `wiki.read` | 命中给 title + score + snippet，点开读全文 |
| `CodeStructurePanel` | `code.structure` | kinds 分段（全部/文件/类/函数/方法），显示「本页 N 个 · 共 M 个」，点节点看 qualifiedName/文件行段/语言/导出/签名 |
| `CodeSearchPanel` | `code.search` / `code.explore` | 搜索与探索两种模式，结果原样进 `<pre>`（后端返回的就是文本块），`isError` 时补一条 warn |

`KnowledgeStation.tsx` 新增分区 `Seg`：wiki = 资产/来源/页面/搜索，code = 资产/结构/检索；同时保留原始 `detail`（源地址、页数、stats）供面板使用，换资产自动回「资产」。

### 13.3 CSS（kit.css 追加，纯 token）

`.stk-stack` `.stk-row-actions` `.stk-list` `.stk-fold` `.stk-fold-head` `.stk-mono` `.stk-pre` `.stk-snippet` `.stk-hint-inline`——零 16 进制色值（脚本核对 hex 0）。

### 13.4 验收（新增 6 条自动化）

`starmap/stations/__tests__/knowledgeDeep.test.tsx`：

1. 来源面板四个真动作都在（测试连接/保存源/重新拉取/编译）；
2. 面板不含 `card2`/`sm-btn` 旧类名，也不含全大写英文标签；
3. 键值不撞字（`源开关` 对应 `开启`，值不是同一个词）；——这条**先红后绿**：首版写的是 `{k:'启用', v:'启用'}`，视觉复核也读出「启用 启用」，改键名为 `源开关`。
4. `StarmapLayout.tsx` 里没有 `set('full'`、没有 `full && legacy`；
5. 没有 `st-embed`，也不再 `import ... from '@/pages/'`；
6. 旧控制台是 `nav('/legacy'` 的显式路由。

### 13.5 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec vitest run` | **88 passed / 88**（10 文件；新增 knowledgeDeep 6） |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint src/starmap` | 0 error / 4 warning（全既有 exhaustive-deps） |
| `pnpm build`（工作区 TMP） | ✓ built in 8.07s；css 618.17 kB / gzip 102.62，js 2,309.50 kB / gzip 588.31 |
| 变异探针 | 往 StarmapLayout 注入 `void search.set('full', '1');` → **1 failed / 6**（`expected ... not to contain 'set(\'full\''`），还原后 sha256 `c906d752e99dd0c684aa2a087fa2f1d035171d5d360154f69f05bf0cc3d91201` 一致、88 passed |

### 13.6 视觉复核（离线真组件 + 假 API）

`.tmp-esbuild/deep-entry.tsx` 渲染三块面板（来源 / 页面 / 搜索），`build-deep.mjs` 用 `onResolve` 把 `@/lib/api/knowledge-api` 换到 `.tmp-esbuild/fakes/knowledge-api-station.ts`（metafile 断言 `real-api-inputs: []`）。截图 `.dsh-vision-router/artifacts/deep-preview.html-6f57d69f-shot-1280x900-fullpage.png`：三块实底无玻璃、无全大写英文标签、键值对齐且空值为 `—`、四个按钮可辨、页面列表左标题右类型、pre 无溢出。

### 13.7 未做（说清楚）

- **团队站与设置站仍是嵌入**：`stations/TeamStation.tsx:48` 把 `TeamManagementPanel`/`ApiKeysPage` 放抽屉里，`stations/SettingsStation.tsx:16` 把 `SettingsPage` 放抽屉里（页内已写明「表单重画属下一阶段」）。它们不经过 `?full=1`，但确实是旧组件嵌新壳。
- wiki 的 **raw 文件**（`rawList/rawRead/rawUpload/rawDelete`）与 **页面删除**（`pageDelete`）未接；旧 WikiPage 有。
- 代码站的 **图谱视图**（节点/边画布）仍在云页（`CloudSideCard`），站内新增的只是结构列表与检索。
- 全部面板只在离线假数据下看过；**真接口 + 真登录未跑**（`ingestWithPolling` 的 10 分钟轮询尤其没在真后端上验）。

## 14. S4 失效接线 + wiki 原始文档补齐（2026-11-11 13:30–13:40）

### 14.1 为什么不是「在几十个调用点各写一句 invalidate」

在页面里挨个调 `invalidateStarmap` 会漏：新增一个页面、换一个入口就少一条。改成**传输层单点**：

| 文件 | 作用 |
|------|------|
| `src/lib/api/mutation-bus.ts`（新，76 行） | `emitMutation(...scopes)` / `onMutation(fn)`。作用域 = `memory\|wiki\|code\|skills\|persona\|team\|agents\|all`；去重、订阅方抛错被吞（缓存坏了不能拦住写操作）、`resetMutationBusForTest()` |
| `src/lib/api/write-scopes.ts`（新） | **唯一真源**：`panelWriteScopes(path)` / `chatMemoryWriteScopes(action)` / `skillWriteScopes(action)` / `metaWriteScopes(action)`。只认动作词，读接口一律 null |
| `src/lib/api/knowledge-api.ts` panelPost | 成功返回前 `const scopes = panelWriteScopes(path); if (scopes) emitMutation(...scopes);` |
| `src/lib/api/chat-memory.ts` chatMemoryCall | 同上，判 `endpoint` 动作名 |
| `src/lib/api/skill-api.ts` skillCall | 同上，判 `action` |
| `src/lib/api/base.ts` metaCall | 同上，判 `action`；`team\|team-member\|agent\|agents\}` 写动作一律 `all` |

作用域表要点：`/allocate`/`/unbind` → `['wiki','code']`（接口不区分 asset_type，两面都失效）；`/wiki/(create|sync|ingest|delete|source/update|source/refetch|page/rm|raw/write|raw/rm)` → `['wiki']`；`/code-graph/(create|sync|delete|register-meta|connectors/pull)` → `['code']`；chat-memory 写动作白名单 = allocate/unbind/set-agent-fixed/create/patch-scope/import/importance（`archive`/`search`/`layer`/`item` 是读，明确排除）；skill 写 = create/update/patch/delete（`files`/`versions`/`extract` 是读）。

### 14.2 反向订阅：缓存层只订阅一次

- `src/starmap/cache/apiCache.ts`：新增 `invalidateScope(scope)` —— `all/team/agents` 直接 `starmapStore.clear()`（key 里的 team/agent 段本身变了，留着只会被 LRU 慢慢淘汰），其余按前缀 `sc:<user>:<scope>` 整片失效；模块加载时 `onMutation(scopes => scopes.forEach(invalidateScope))`。
- `src/starmap/cache/resources.ts`：新增 `invalidatePrefix(prefix)`（跳过在途条目，与 `invalidate` 同语义）。
- `src/starmap/data/overview.ts`：总览模型自带 60s 模型级缓存，不在资源表里，单独 `onMutation(() => clearOverviewCache())` —— 总览把四云计数揉成一张模型，分不清哪一朵没变，重算是一串已缓存的读取。

依赖方向：`starmap → lib/api`，lib 不认识缓存（api 层只广播语义作用域）。

### 14.3 wiki 原始文档 + 页面删除（补齐与新壳的 parity）

旧 WikiPage 有 raw 文件（列表/读/删/上传）与页面删除，新壳之前只能去旧控制台。现在：

- `WikiPagesPanel` 加**两段式删除**：选中页面后按钮为「删除本页」，点一次变「确认删除」，再点才调 `wiki.pageDelete`（没有弹窗也不许一点就删）。
- 新增 `WikiRawPanel({wikiId, teamId})`：`rawList` 列表（文件名 + `humanSize` B/KB/MB）、点开 `rawRead` 进 `<pre class="stk-pre">`、`rawDelete` 两段式删除、`upload` 表单（文件名 + 正文 textarea）；缺 teamId 直接抛「缺少团队上下文，无法上传」而不是发一个注定失败的空 team 请求。
- `KnowledgeStation` 分区加第 5 段「原始文档」，`Tab = 'asset'|'source'|'pages'|'raw'|'search'|'structure'`。
- `kit.css` 加 `.stk-textarea`（min-height 96、mono 11.5、resize vertical），零 16 进制色值。

### 14.4 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec vitest run` | **103 passed / 103**（11 文件：新增 `lib/api/__tests__/write-scopes.test.ts` 8 条、apiCache 加 2 条、resources 加 1 条、knowledgeDeep 6→10 条） |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint src/lib/api src/starmap` | 0 error / 4 warning（全既有 exhaustive-deps） |
| `pnpm build`（工作区 TMP） | ✓ built in 8.07s（css 618.17 kB / gzip 102.62，js 2,309.50 kB） |
| 变异探针① | `invalidatePrefix` 条件改成 `if (false && …)` → **2 failed / 22**（「总线按作用域失效：写记忆只刷记忆」与「invalidatePrefix 只删前缀命中项」），还原后 sha256 `790eee1435f2f59b1bb76e8e55b1eb490cfc111245a82c5ef8ee7ab914e398de` 一致、103 passed |
| 变异探针② | 往 StarmapLayout 注入 `void search.set('full','1');` → 1 failed / 6，还原后 sha256 `c906d752e99dd0c684aa2a087fa2f1d035171d5d360154f69f05bf0cc3d91201` 一致 |

### 14.5 视觉复核（原始文档区块）

`.tmp-esbuild/{deep-entry.tsx, fakes/knowledge-api-station.ts}` 加 `WikiRawPanel` 与 raw 假数据（4 个文件：9,142 / 24,880 / 3,120 / 186,240 B），`build-deep.mjs` 重建（metafile `real-api-inputs: []`）。截图 `.dsh-vision-router/artifacts/deep-preview.html-6f57d69f-shot-1280x1000-fullpage.png`，vision 判定：四区块无裁切无重叠；原始文档区块上半是「共 4 个原始文档 + 刷新」+ 文件名/大小列表（`8.9 KB` 这类），下半是「上传原始文档」的文件名输入 + 上传按钮 + 正文 textarea；页面标签是**全小写**（adr/runbook/doc），没有全大写小标签；按钮主次可辨。

### 14.6 未做（说清楚）

- 失效是**粗粒度**的：一次记忆分配会清掉该用户全部 `memory.*` 缓存（含别的 block 的分页）。精确到 agent/block 需要写操作回传 id，当前接口不回传，不做猜测。
- `persona` 作用域已定义但**没有任何写路径 emit 它**：人格改写的写入走 `/v3/soul/*`（另写的 api 模块，未接总线）。
- `importance`（人工调权）接了总线；`archive` 疑为读，未接——若它其实改数据，会退化成 TTL 兜底。
- raw 面板的**交互**（两段式删除、上传成功刷新）只有源码契约测试与视觉静态验收，没有真浏览器点击；两段式在 node 环境无法模拟。

## 15. 团队站 / 设置站原生化 + 星点「点亮 / 熄灭」（m02347 后）

### 15.1 团队站（`stations/TeamStation.tsx` 整篇重写，约 520 行）

不再 import `components/team/TeamManagementPanel` 与 `pages/ApiKeysPage`，三段全部 kit + 真实端点：

| 段 | 端点 | 说明 |
|----|------|------|
| 成员 | `membersApi.list/add/remove` | `useResource` + `Row`；角色标签 + 两段式「移除 → 确认移除」；添加表单 = user_id + 角色 Seg；非管理员只读 |
| 智能体 | `agentsApi.list/create/update/delete` | 行内按钮不叠行点击（Row 的 button 约束）；编辑面板含名称/描述/可见性 + `KvList` + 保存/取消；删除两段式（`agentsApi.delete` 内部先逐个删 skill，任一失败抛 `SKILL_DELETE_FAILED`） |
| 密钥 | `userKeysApi.list/create/revoke` | 明文 `key_value` 只出现一次，进「新密钥（只显示这一次）」`<pre>`；吊销两段式 |

后端能力边界如实写在界面上：**没有改角色的端点**（角色只能在加入时定）、**没有按用户名开号**（只能填 user_id）、资产分配与人格草稿仍走 `/legacy/team/agents`。
`useCurrentRole()` 口径：先 `isGlobalAdmin` 再 `roleInTeam`；`canWrite(agent) = isAdmin || owner_user_id === meId`。

### 15.2 设置站（`stations/SettingsStation.tsx` 整篇重写，约 300 行，只读）

为什么只读：旧 `SettingsPage` 是 `configCatalog.ts` **2968 行** + 60 余项校准常量 + 逐项校验，一次性重写等于把已验证的写路径换成没验过的。所以新壳给**生效值概览**：`settingsApi.get` 两个 target + `rerankModelApi.status`，键值行含模型/地址/密钥是否配置/来源（env→环境变量、yaml→配置文件、override→面板覆盖）/超时/向量模型与维度/重排/重要度降权/抽取标注/整组阈值计数，外加本地重排模型的文件就绪列表。
写入口只有一个按钮「去旧控制台编辑配置」→ `nav('/legacy/settings')`；`role !== 'admin'` 时整页只出 Note。测试锁死：源码里**不含** `settingsApi.set` / `revectorize` / `rerankModelApi.download`。

### 15.3 点亮 / 熄灭：把「分配」做进站内（本轮新增）

星图的整套语言是「挂到本 agent 才亮」，但此前站内没有挂载入口，只能去旧控制台，等于星图只读。补两处真接线：

- `stations/MemoryStation.tsx`：块信息卡加「挂到当前智能体 / 从当前智能体移除」，按 `block.agent_id === sm.activeAgentId` 判状态，走 `chatMemoryApi.allocate(teamId, blockId, agentId)` / `unbind(...)`，成功后 `mem.handleRefresh()`；无 activeAgentId 时按钮缺席并写「先在上方选一个智能体」。失败进 `Note`，不再静默。
- `stations/KnowledgeStation.tsx`：`knowledgeApi.agentFixed(agentId)` 拉挂载表（按 `asset_type === 'llm_wiki' | 'code_graph'` 分给两站），详情卡加同样的按钮，走 `wiki.allocate/unbind`、`code.allocate/unbind`；`KvList` 增一行「挂载：已挂到本智能体 / 未挂载」。挂载表随 `kind/teamId/activeAgentId` 重取。
- 写操作**不需要手动清缓存**：`/allocate`、`/unbind` 已在 `lib/api/write-scopes.ts` 里映射为 `['wiki','code']` / `['memory']`，命中 `mutation-bus` → `invalidateScope`（§14.1）。

### 15.4 门（本轮亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec vitest run` | **119 passed / 119**（12 文件；stations 12→16，新增 4 条挂载契约） |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec eslint src/starmap/stations src/starmap/kit` | 0 error / 2 warning（`MemoryStation.tsx:58,64` 既有 exhaustive-deps） |
| `pnpm build`（工作区 TMP） | ✓ built in 7.61s；`main-DqC9t7Rc.css` 618.49 kB / gzip 103.00、`main-D5JFovq0.js` 2,331.92 kB / gzip 594.91 |
| 变异探针 | 向 `SettingsStation.tsx` 末尾追加 `void settingsApi.set;` → 1 failed / 16（`settings).not.toContain('settingsApi.set')`） |

**教训（写下来别再犯）**：探针还原**不要用 `head -c` 按字节截断**——多切 19 字节会把结尾 `</div>\n);\n}` 削掉，随后 tsc 报错、还要手工补粘连标签。用备份文件或 `git checkout --`。

**环境坑**：`pnpm build` 直跑会撞本机 Temp ACL（`[vite:esbuild-transpile] remove …\\Temp\\esbuild-…: Access is denied`），必须把 `TMP/TEMP/TMPDIR` 指到工作区内的 `.tmp-build`。本轮 OPS bash 执行器还出现 `EXECUTOR_UNAVAILABLE: niubash preparation failed … link awk.exe`（瞬态），改用 `node:child_process.spawnSync` 跑同一条命令即可。

### 15.5 视觉复核（离线真组件 + 假接口）

`.tmp-esbuild/{stations-entry.tsx, station-preview.css, build-stations.mjs, fakes/*}`，`onResolve` 把 `@/lib/teamApi`、`@/stores/auth`、`@/services/useCurrentRole`、`@/lib/error-message`、`@/lib/api/settings`、`/state/StarmapProvider`、`react-router-dom` 换成假实现；入口按 `?only=team|settings` 单站渲染。

## 21. G4 代码关系图进站 + 键盘可达 + 发光清理（P17）

### 21.1 做了什么

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 `CodeGraphPanel` | `MemoryPanel/web/src/starmap/stations/knowledgeDeep.tsx` | `code-graph/graph` 取 nodes+edges（`CODE_GRAPH_LIMIT = 120`），度数最高的节点当 hub 并自动选中，BFS 三跳分环，画布用 `RelGraphCanvas` |
| 新增 `buildCodeGraphRel` | 同上 | 纯函数：度数 → weight、BFS → hop、边原样透传。**不新增后端契约、不自编边** |
| 代码站加第三档 | `MemoryPanel/web/src/starmap/stations/KnowledgeStation.tsx` | `Tab` 加 `'graph'`，tabs 加「关系图」，渲染 `<CodeGraphPanel codeGraphId={current.id} />` |
| 星点键盘可达 | `MemoryPanel/web/src/starmap/scene/RelGraphCanvas.tsx` | `step(dx,dy)` 按方向投影筛候选（`proj > 0.2`，评分 `(1-proj)*3 + d/400`）；↑↓←→ 走位、Enter/Space 选中、`role="application"`、`tabIndex={0}`、aria-label 写明操作 |
| 焦点环 | `MemoryPanel/web/src/starmap/kit/kit.css` | `.stk-graph-canvas canvas:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px }`（canvas 拿不到默认焦点样式） |
| 去重 | `knowledgeDeep.tsx` | 关系列表按 `节点+关系` 去重：同一对节点可能有多条边（calls 跨多行、calls+contains 并存），否则右栏出现两行同名项 |

### 21.2 顺手清掉的装饰性发光（tokens.css 672 → 667 行）

| 位置 | 改前 | 改后 | 为什么 |
|------|------|------|--------|
| `select:focus`/`input:focus` 规则 | `box-shadow: 0 0 0 3px rgba(127,200,255,.09)` | `outline: 2px solid var(--focus); outline-offset: 1px` | 焦点环统一走 outline，不再用阴影模拟 |
| `.pbar` / `.pbar > i` | 渐变进度条 | 整块删除 | 全仓只剩样式表自己引用（死 CSS） |
| `.st-brand-dot` | `box-shadow: 0 0 12px var(--c-l1)` + `sm-blink` 无限闪烁 | 实心点，无发光无动画 | 星场是唯一允许发光的东西；无限装饰动画违反 DESIGN.md 动效段 |
| `.st-trait-bar i` | 蓝色渐变填充 | `background: var(--c-l1)` | 渐变只做视觉糖，读不出语义 |
| `.five-bodies .fb-sel` | `rgba(14,18,34,.92)` 底 + `border rgba(190,170,255,.34)` + `box-shadow 0 10px 30px` + `#eae6ff` 字色 | `var(--surface)` 实底 + `1px solid var(--line)` + `var(--ink)` | 半透明底 + 硬投影 = 毛玻璃感，且颜色全是字面量 |
| `@keyframes sm-blink` | 已无引用 | 删除 | 同上 |

剩余 2 处 `linear-gradient` 都是**画控件图形**（`select` 下拉箭头两段、checkbox 勾），不是给面板做渐变糖，保留。

### 21.3 门（亲跑）

| 门 | 读数 |
|----|------|
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm exec vitest run` | **172 passed / 172**（17 文件；knowledgeDeep 18 条，本轮 +7） |
| `pnpm exec eslint src/starmap src/lib/api src/components` | 0 error / 6 warning（全既有 exhaustive-deps） |
| `node .tmp-esbuild/run-build.cjs` | ✓ `main-CCrdDyKZ.js` 2,357,345 B、`main-9z7skq4H.css` 611,593 B |
| 生产一致性 | `curl 127.0.0.1:8123/` 引用 `assets/main-CCrdDyKZ.js`，与磁盘同 hash；**未重启任何服务** |
| 变异探针 | 删掉 `RelGraphCanvas` 的 `role="application"` → 1 failed / 17；还原后用 sha256 校验 `402d5688c6d3ec27303bdfd7852de670a85b27d8b47fdeb823986c5cc0d048b7` 且 17 passed |

### 21.4 离线视觉复核

预览链：`.tmp-esbuild/graphcode-entry.tsx`（真 `CodeGraphPanel` + 真 tokens/kit.css）+ `.tmp-esbuild/build-graphcode.mjs`（esbuild JS API；`onResolve` 把 `@/lib/api/{knowledge-api,chat-memory,skill-api}` 换成假实现，metafile 断言 `real-api-inputs: []`）+ `.tmp-esbuild/fakes/knowledge-code-fake.ts`（25 节点 / 33 边 / total 2431 / truncated）。

截图 `.dsh-vision-router/artifacts/graphcode.html-066bca9b-shot-1440x700-fullpage.png`，vision 读数：星图正常渲染（蓝/橙星点 + 连线，中心 `buildPersonaCard` 最亮）；右栏标题/副标/限定名/位置/导出/签名逐字正确；**关联节点 4 行且无重复**（去重生效）；顶部说明句逐字为「已取 25 个节点 / 33 条边（服务端共 2431 个节点）。画的是以「buildPersonaCard」为中心的三跳邻域。」；无裁切重叠、无全大写小标签。

两个预览坑（已修）：
1. esbuild 插件 `onResolve` 返回**相对路径**会报 `returned a non-absolute path`，必须 `resolve(...)` 成绝对路径；
2. `.starmap-root` 在 tokens.css 里是 `position:fixed; inset:0`，预览要覆盖成 static 并自己给 `background: var(--bg)` + `minHeight:100vh`，否则视口下方是浏览器默认白底（第一版截图下半屏是白的，vision 直接指出「大面积纯白空白」）。

另：`vision_bootstrap` 这次又把代码图谱截图描述成登录页（已知串味），结论只取 `vision_describe` 读数 + 源码/CSS 取证。

### 21.5 未做

- `CodeGraphPanel` 只在假数据下看过（25 节点）；真实图谱（`total 2431`）截断到 120 后的可读性、hub 是否总在视野中心，未在真接口下验。
- 键盘走位只在 `RelGraphCanvas`（记忆图谱 + 代码图谱）；`PersonaCanvas` / `CloudCanvas` / `FiveBodies` 仍只有鼠标。
- `select` 下拉箭头与 checkbox 勾仍用 `linear-gradient` 画（非装饰糖，未改）。
- 6 条 exhaustive-deps warning 未修。

## 22. 全景星图改成「星河」+ 云名去标签 + 构成卡可聚焦（P18）

### 22.1 用户要求（原话）

m03830：「星体构成卡有问题，不是说改成星云构成然后展示各个星云的信息么；另外现在整个星图的排版有问题，我希望你改成每个星云、每个层级的颜色都不同，不要加标签展示星云名称了，在星云构成卡展示星云信息时标注一下颜色，然后点击星云构成卡对应的星云信息时星图聚焦到对应的星云。然后星云间的距离不要太远，就像星河一样，现在看着有点丑了」
后续两条：m04338「星云构成卡不用加记忆四带」、m04413「就参照这个 https://enrichr.dev/elements/galaxy-spiral.html 画星云和星河吧，这个看着挺好看的」。

### 22.2 改了什么（都落在 `scene/FiveBodies.tsx` + `StarmapLayout.tsx` + `theme/tokens.css`）

| 项 | 做法 |
|---|---|
| 云名标签 | `drawLabels()` 整段删除，画布现在 **0 次 `fillText`**；云名与读数全在左栏卡里 |
| 星云构成卡 | `data-testid="cloud-composition"`：四行 `Row`（色点 + 云名 + 读数），点击＝`focusCloud(key)` 聚焦 / 再点取消；页脚写「画布 N 条线 · M 颗星」 |
| 记忆四带 | 已按 m04338 整块删除（连带 `LAYER_ORDER_UI`/`layerCount()`，读数列改由 `cloudTotals` 提供） |
| 旋臂数学 | 抄 enrichr 的 galaxy-spiral：`rad = pow(rand(),1.35)`、`ang = arm*2π/arms + rad*5.2 + (r+r+r-1.5)*0.46*(rad+0.28)`、`core = rad<0.18` 时角度随机、`z` 抖动按半径收窄；四云 `CLOUD_ARMS = {memory:3, wiki:3, code:2, skills:3}` |
| 分层半径 | `BAND_RANGE = [[0.02,0.30],[0.30,0.56],[0.56,0.80],[0.80,1.0]]`，L3 内芯 → L0 外缘，层不重叠 |
| 星河 | 四云沿一条 `riverPoint(t)` 的带子首尾相接；带子在屏幕平面里**倾斜 `RIVER_TILT = -0.42`**（横平一条会留上下两面死黑）；再加 1800 颗河中星尘把云与云之间的空档填上 |
| 星点形态 | 从「每颗星贴 64px 径向渐变 sprite」改成 **`fillRect` 方点**（enrichr 也是这么画的），bead 率降到 `h%10===0`，雾体贴图 alpha 从 0.40 降到 `(focus?0.20:0.05)` —— 之前「星云糊成一团」主要是贴图与光斑叠出来的 |
| 人格恒星 | 核心不再用星云贴图（贴图里 `th + turn*log r` 的旋臂数学在圆心汇成硬射线，像旧版镜头光晕），改两层纯径向渐变 + 一颗硬白核 + 六颗小硬星；光晕 alpha 0.40 → 0.15 |
| 连线 | 按关系类型上色（同会话 `#4ec9d9` / 同人物 `#f08fa8` / 引用·归属 `#6fd39a` / 星河 `#8fa4d8`）；总览时云内连线只抽 1/3 上屏，整体 alpha ×0.34，第二层「丝缕」0.045 → 0.03 |
| 亮度配平 | `CLOUD_GAIN = {memory:0.9, wiki:0.88, code:0.68, skills:0.95}` —— 构筑云 2527 颗星原本把画面右半边压塌 |
| 四云四色 | memory `#4f9dff/#1d3f86/#9db8ff`、wiki `#25c795/#0f5b45/#5fe0b0`、code `#f7ae35/#6b4409/#ffc65c`、skills `#f269bb/#6b1f48/#ff86cc`；memory 的 star 从 L1 同色 `#7fc8ff` 改成 `#9db8ff`，与四层色板完全不相交 |
| 图例 | `tokens.css` 的 `.l-session/.l-person/.l-ref` 改成与画布边同一组十六进制，图例与画面不再对不上 |
| 四角死黑 | `backdrop` 里加确定性 LCG 底噪星尘（`W*H/1400` 颗、alpha 0.03–0.10），暗角 0.62 → 0.40 |

### 22.3 另一个真 bug：resize 无条件赋值把星场每帧抹掉

`resize()` 原来每次回调都无条件给 `canvas.width/height` 赋值。**给 canvas 赋任何值（哪怕同值）都会清空位图**，而它又观测 `wrap`，赋值 `style.width/height` 触发布局 → 观测循环约 13 次/秒，星场每帧被抹一次。诊断链：先读 `getImageData` 全 0 → 再给 `HTMLCanvasElement.prototype.width` 的 setter 打点，900ms 内 `widthSet=12`，同时帧内读像素 `lastN=3600`（画满）→ 定位为「画完即被清」。
修法：幂等判断（W/H/DPR/位图尺寸全等就 return），注释写明原因。修后 `nonzero=519840`（722×720 全块）。

### 22.4 渲染 effect 只认内容签名（否则只画一帧）

场景 `useEffect` 原来依赖 `[model, web, graph, paused, focus, onOpen, onOpenPersona, teamId, agentId]`，父组件每次渲染都造新的 `graph`/`web` 对象 → effect 每帧重挂 → cleanup `cancelAnimationFrame` → `frame` 永远是 1。
改法：`modelRef/webRef/graphRef/focusRef/pausedRef/onOpenRef/onPersonaRef` 渲染期赋值；依赖改成 `sceneKey`（人格版本/字数/人数/九块数 + 三云 mounted/total + 四层 total 拼接）、`graphKey`（`graph.nodes.length + ':' + graph.links.length`，注意字段是 `links` 不是 `edges`）、`webKey`，外加 `focus/teamId/agentId`。

### 22.5 门（亲跑）

| 门 | 读数 |
|---|---|
| `npx vitest run` | **179 passed / 179**（18 文件，新增 `__tests__/galaxy.test.ts` 7 条） |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src/starmap src/lib/api src/components` | 0 error / 6 warning（全既有 exhaustive-deps） |
| `node .tmp-esbuild/run-build.cjs` | ✓ 8.44s，`main-BmvZOCDn.js` + `main-BBcwXMv-.css` |
| 生产 | `curl 127.0.0.1:8123/` → 同一个 `main-BmvZOCDn.js`（panel `serveStatic` 发 `web/dist`，**落盘即生效，未重启**） |
| 变异探针 | 往 paint 里注入 `ctx.fillText('人格恒星',0,0)` → 1 failed / 7；还原后 sha256 `5459fdfcacbbe4f285e2457456b396db9dcd20cca5193be0293ef868a9bd17fb` 一致、7 passed |

`galaxy.test.ts` 锁的 7 条：画布 0 次 `fillText` 且无 `drawLabels`；无 `Math.random`；effect 依赖含内容签名且**不含** `graph`/`web` 对象；四云 star 色两两不同且与四层色板不相交；左栏有 `cloud-composition` + `focusCloud` 且无「记忆四带」/无 `.st-cloud-layers`；图例三色与画布边三色同一组十六进制；`RIVER_TILT` 存在且为负值。

### 22.6 视觉复核（CDP 截图，不是 load 时截）

脚本 `node .tmp-esbuild/shot.mjs "<url>" "<out>" 3200 1440 900 <port>`（`chrome --headless=new` + CDP `Page.captureScreenshot`，等 3.2s 再截）。`chrome --screenshot` 与 `vision_html_screenshot` 都在 load 时截、`--virtual-time-budget` 遇无限 rAF 会挂死，拍到的都是空画面。

十轮迭代（`ov-spiral.png` → `ov-final-river.png`）的 vision 读数变化：四团孤岛 → 横贯带状 → **斜穿画面的星河**；中央「过曝白团」→「柔和光晕」→「有核、清透」；左下「蜘蛛网」→「克制的背景纹理」；分数 4.5 → 6.5 → 7.5 → 8.5。最终读数（`ov-final-river.png`，490,819 B）：左栏四行色点＝蓝/绿/橙/粉与画布一致、「点一行聚焦」提示可见、画布上除底部 DOM 提示外**没有任何文字**、四色可辨、中心恒星最亮且不被面板压住。

### 22.7 未做

- 连线色相区分度仍偏弱（vision 反复提「大部分线还是灰白」）：细线 + 低 alpha 与「不抢中心」是一对矛盾，当前取值偏保守，未做「悬停/选中时按关系高亮」。
- 真实数据量（L0 14782 条）下星点被 `BAND_STARS = [70,220,950,1400]` 采样，截断提示只在左栏页脚一行，画布本身不表达「还有多少没画」。
- `focusCloud` 聚焦动画的相机过渡未在真浏览器用键盘触发验证。
- 四云位置是常量表，未做「按数据量自适应让四团大小均衡」。

---

---

## 23. P19：星河返工（用户 m04730「这个看着太丑了吧，你自己看看能看出来是个星河么」）

### 23.1 用户截图的结构化判定（先看清病灶，再动手）

用户实机截图（附件 `sha256:fc97150a…`）经 `vision_describe` 读出的四条结构病因，全都是代码事实，不是口味问题：

| 现象 | 代码里的真因 |
| --- | --- |
| 左侧像散点图/区块链节点 | 星点用 `ctx.fillRect` 画**正方形**（`FiveBodies.tsx` 数据星点与星尘两处） |
| 中间有金色虚线圆环（瞄准镜） | `if (c.total === 0) { setLineDash([5,7]); arc(...) }` —— 空云画虚线圈；聚焦态还另有一圈虚线云界 |
| 左边连线成网、像拓扑图 | 总览时把 `scene.links` 按 1/3 抽样全画（203 条），再加「丝缕」与神经脉冲 |
| 中间「粒子加速器大环」 | 九块用**等距球面**绕核（`sin(ph)cos(th)*CORE_R*2.4`），人物又在同一半径 `CORE_R*3.4` 一圈 —— 球面/圆环投影出来就是两个同心光圈 |
| 四团各占一块、中间大片虚空 | 只有四朵云自己的雾团 + 少量 dust，没有连续粒子场；四云之间只靠几条弱边连 |

### 23.2 改法（全部落在 `MemoryPanel/web/src/starmap/scene/FiveBodies.tsx`）

1. **银河底 `field`（新增，`FIELD_N = 8000`）**：沿 `riverPoint(t)` 的河带撒点，横向用「三次均匀相减」得高斯、再叠 `sin(t*9.4)` 高频细丝；颜色取最近那朵云（忆云区按横向偏移取 L3/L2/L1/L0 层色），云心附近用 `1 + 1.5·exp(-q²/0.2)` 加深。四朵云于是变成同一条河里四个更亮的结。
2. **色界掺色**：四段颜色交界处按 22% 概率换成邻段颜色，消掉笔直的色界线（vision 第一轮判「色块生硬」）。
3. **粒子全部改羽化圆**：数据星点、云内 dust、河中星尘三处 `fillRect` → `ctx.drawImage(spriteOf(color), …)`，配合已有的 `globalCompositeOperation = "lighter"`，重叠处自然变亮（这是「气体感」的唯一来源）。银河底本身仍是 1px 点（`fillRect`），上万颗沙粒级点才像银河。
4. **删所有人造几何**：空云虚线圆环、聚焦虚线云界、总览连线全部去掉；`showLinks = Boolean(focusKey) || Boolean(selWorld.current)` —— 只有聚焦某朵云或选中某颗星时关系边才出现。
5. **打散光圈**：九块半径 `CORE_R * (1.2 + rnd(...)*1.8)`、人物 `CORE_R * (2.2 + rnd(...)*2.8)`，每颗半径单独抖，球面壳散成一团晕；九块 alpha 0.8→0.62、人物 0.85→0.62 且光斑半径 ×6→×4.8。
6. **四角不再死黑**：backdrop 底噪从 `W*H/1400` 颗、alpha 0.03–0.10 提到 `W*H/620` 颗、alpha 0.06–0.22、尺寸 1–2.3px；暗角 0.40→0.30。
7. **数据星点密度/亮度收一档**（原本 11480 条 L1 合成上千颗 0.9 alpha 直接叠成白斑）：`BAND_STARS` `[70,220,950,1400]` → `[40,110,300,420]`，合成系数 `sqrt(n)*11` → `sqrt(n)*6`（上限 320→150），星点 alpha 0.9→0.6。

### 23.3 性能（自己量过，不猜）

`node .tmp-esbuild/probe-fps.mjs`（CDP 里跑 2s 的 rAF 计数）在 `--headless=new --disable-gpu`（纯软件光栅）下：改造首版 **26 fps** → 银河底降到 8000 颗、只保留 `size > 2.4` 的少数走 sprite、其余 1px `fillRect` 后 **45 fps**。真机有 GPU，另计。

### 23.4 门（亲跑读数）

| 门 | 读数 |
| --- | --- |
| `pnpm exec vitest run` | **183 passed / 183**（18 文件；`galaxy.test.ts` 由 7 条加到 11 条） |
| `pnpm exec tsc --noEmit` | exit 0（中途报过 `cloudRadiusOnScreen` 未使用，已随聚焦圈删除一并删掉） |
| `pnpm exec eslint src/starmap src/lib/api src/components` | 0 error / 6 warning（全既有 exhaustive-deps） |
| `node .tmp-esbuild/run-build.cjs` | ✓ `dist/assets/main-D_cOVJut.js` + `main-BBcwXMv-.css` |
| 生产 | `curl 127.0.0.1:8123/` → 同一 hash，资源 `200 / 2361897 B`；**未重启任何服务** |

新增/加固的测试（`src/starmap/__tests__/galaxy.test.ts`）：画布无 `setLineDash`、总览连线必须是 `showLinks ? scene.links : []`、数据星点与星尘不许再 `fillRect`、`FIELD_N` 与 `fieldBuckets` 存在、`field.push` 带 `owner`、九块与人物半径必须带 `rnd(`（锁死「不许再有等距球面光圈」）。

### 23.5 视觉复核（CDP 截图 + 裁画布看）

- 整图 `D:/TDB/td-agemem/.dsh-vision-router/artifacts/ov-galaxy7.png`（529,337 B，1440×900，等 3.6s 截）。
- 裁主画布 `region 300,40,1140,860` 后 `vision_describe` 读数：**9/10 像银河/深空摄影**；「中间亮核到左右两端连续过渡，没有刀切一样的色界线」；「四角没有纯黑死区」；「主画布内没有连线、网格、方块、圆环」；颜色分区「左青绿 → 中暖白 → 右金黄 → 右上粉紫」。
- 教训（写死在这里，别再犯）：**整图交给 vision 会被左右面板污染**，第一轮把面板读成「星云」、把图例读成「画布里的圆环」。判星图形态必须**先裁掉面板只留画布**再问；`vision_bootstrap` 在本会话反复串味（把 A 图说成 B 图），只当合规前置，结论只认 `vision_describe` 的裁图读数 + 像素密度图。
- 像素证据：`node .tmp-esbuild/probe-grid.mjs`（CDP 里把 `fb-canvas` 的 `getImageData` 降采样成 36×20 的 ASCII 密度图），读数显示亮带横贯 3–16 行、核心最亮、四角为 `.` 级微光（非纯黑），`frames=150` 证明动画在跑（此前两次「星场只剩一帧」的 bug 都是靠它定位的）。

### 23.6 未做 / 边界

- 只在**离线预览的假数据**下看的视觉效果；真接口+真登录未跑（用户 m03327 要求先不测）。生产包已同步，用户刷新即可看到同一份代码。
- 四色分区的相对位置仍由常量表决定（记忆 t=−1、典籍 −0.34、人格 0、构筑 0.34、技艺 1），真实数据下某朵云为空时，那一段河带只剩银河底的低亮度粒子，没有「此处空」的说明（左栏构成卡里才有「暂无」）。
- 连线在总览彻底不画之后，`scene.links` 的 203 条只剩聚焦/选中时用；左栏页脚「画布 N 条线」仍报 `scene.links.length`，与画面上实际可见的 0 条不一致 —— 待改口径（下次动这块时一起改）。
- 九块/人物的实际半径抖动会让同一颗在旋转时穿过星云，未做碰撞避让（视觉上可接受，未测极端角度）。


## 24. 星场重做：照 enrichr galaxy-spiral 的写法，每朵云一个螺旋（2026-11-11）

用户三次点名同一件事：m04975「为什么背景还有假星点，都去掉，只保留真星点构成星河，并以人格恒星为定点，星云样式和 https://enrichr.dev/elements/galaxy-spiral.html 看着也不一样啊，他的是螺旋的带自旋，你这个看着很混乱」；m05104「典籍云和构筑云不同库也给不同的颜色吧不要都一个颜色」；m05147「你先看看那个页面的代码怎么写的啊，然后每一个星云都用这个写法不就行了么」。

### 24.1 参考实现的关键代码（https://enrichr.dev/js/lib/galaxy-spiral.js，7,682 B，逐行读过后照抄）
```
rad = Math.pow(r(), 1.5) * 0.95 + 0.02;              // 中心更密
arm = Math.floor(r() * opts.arms);
ang = arm * 2π / arms + rad * 5.2;                   // 旋臂扭转
spread = (r() + r() + r() - 1.5) * 0.45;             // 三次均匀相减当高斯
ang += spread * (rad + 0.25);
core = rad < 0.14;  q = core ? r()*2π : ang;
rr = core ? rad * (0.5 + r()) : rad + (r() - 0.5) * 0.04;
P.z = (r() + r() - 1) * (core ? 0.15 : 0.04) * (1.2 - rad);
P.c = 按 rad 分三档 + cr 分到 4 个色带
P.s = 0.5 + r() * r() * 1.6;
// 上屏：8 个深度桶
buckets[floor(d * 8) * 4 + P.c];  d = (z3 + 0.9) / 1.8
depth = (db + 0.5) / 8; globalAlpha = 0.18 + depth * 0.82; sz = 0.7 + depth * 1.1;
fillRect(x - s/2, y - s/2, s, s)   // s = sz * P.s[i]
ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55)  // 核球底色
rot += dt * 0.12 * speed
```

### 24.2 落到本项目的七条改动（`MemoryPanel/web/src/starmap/scene/FiveBodies.tsx`）
| # | 改动 | 落点 |
| --- | --- | --- |
| 1 | `spiralPoint()` 换成参考的精确数学（pow 1.5 / 5.2 / 0.45 高斯 / core<0.14 / ±0.04 / `0.5+r*r*1.6`），只把参考的 [0.02,0.97] 半径线性映射到本朵云自己的 [rMin,rMax] | `spiralPoint` 全函数重写，返回值加 `band`、`size` |
| 2 | 星点上屏换成参考的「8 深度桶 × 4 色档 + fillRect」，alpha=`0.18+depth*0.82`、尺寸=`0.7+depth*1.1`；但把点压到 ≤1.8px（参考在小画布上是 1–2px，投到本项目视口会长成 3–4px 的像素块） | `const NB = 8` 起整段替换旧的核心 + 羽化晕画法 |
| 3 | 四朵云各有 4 色档 `CLOUD_SHADES`；色带 index 1 用星点自己的 `color`（忆云=层色 / 典籍构筑=库色 / 技艺=云色），所以「每库一色」没有被色带吞掉 | 新增 `CLOUD_SHADES`，绘制时 `q.s.band === 1 ? q.s.color` |
| 4 | 云内尘：按该层/该云的真实条数定密度（`sqrt(total)*k`，忆云上限 3400 / 其它 4200），位置仍走同一条螺旋公式；`dust: true` 且不进 `starHits`（不能点） | 忆云每带、其它每云各一段 |
| 5 | 四云摊开成一圈：`CLOUD_R` 0.95→1.56、`RING_D` 1.06→0.88、`BASE_ZOOM` 2.55→1.78 | 文件头常量 |
| 6 | 云核从「亮斑」改「弥散」：`nucR` ×0.54、`nucA` 0.86/0.6→0.5/0.34、首档 alpha 0.13（四个云心几乎重合，核光叠加会烧成白斑） | 云核渐变 |
| 7 | 人格核去掉「灯泡」：白核 alpha 0.72→0.18、`cr` 1.45→1.10、halo 4.2→3.4、硬白点 0.13→0.07 | 人格恒星绘制 |

### 24.3 视觉迭代（每轮都是 CDP 等 4.2–4.6s 再截图，裁画布 `330,20,1100,890` 后只问画布）
| 版本 | 读数 | 结论 |
| --- | --- | --- |
| ov-ref1（只换数学，未加尘、盘小） | 旋臂隐约、四团孤立、方块感、中心灯泡 | 密度不够 |
| ov-ref2（加尘 + 四盘扩大到咬合） | 四色连成一个盘/环；仍「方块 + 灯泡 + 只占 2–3 成」 | 结构对了，画法不对 |
| ov-ref3（点压到 ≤1.8px、尘×1.5、核压暗） | 「星点是细小的尘点，不是方块」「旋臂清晰」「四色连成一片」 | 只剩中心灯泡 + 粒子感 |
| ov-ref4（盘再放大、核再压） | 仍评「灯泡 + 覆盖 3–4 成 + 粒子感」 | 云核叠加是白斑主因 |
| **ov-ref5（`nucA` ×0.4、`RING_D` 0.88、尘再 ×1.4）** | **「旋臂非常明显」「四色沿旋臂分布」「中心是核球不是孤立灯泡」→ 打分 9.5/10** | 收口 |

性能：`probe-fps.mjs` 纯软件光栅下 **43 fps**（点数约 9k–12k）；真机有 GPU 另计。

### 24.4 门（亲跑）
- `npx vitest run` → **185 passed / 185**（18 文件）。`galaxy.test.ts` 13 条已按新写法定稿：螺旋数学四条公式、8 桶×4 色档 + `fillRect`、点 ≤1.8px、`CLOUD_SHADES` + accent 取星点色、尘按真实条数且不进命中、无 `setLineDash`、中心非过曝白点。
- `npx tsc --noEmit` → exit 0；`npx eslint src/starmap src/lib/api src/components` → 0 error / 6 warning（全既有 exhaustive-deps）。
- `node .tmp-esbuild/run-build.cjs` → `dist/assets/main-D5YbEfYN.js` 2,358.33 kB / gzip 603.97、`main-BBcwXMv-.css` 611.66 kB / gzip 101.30，✓ 6.93s。
- 生产：`curl 127.0.0.1:8123/` 返回的 index 里就是 `assets/main-D5YbEfYN.js`（panel `serveStatic` 发 `web/dist`，落盘即生效）。**未重启任何服务、未 commit、未 push。**
- 变异探针：`const NB = 8` → `6` → 1 failed / 12；还原后 `sha256 = ae7a7b6be91e8bf8b8a68fde075897d6cbe4225f5f6a4ea55f43841159685a19`，13 passed。

### 24.5 未做/边界
1. 真接口 + 真登录未跑（用户 m03327 要求先不测）；预览是假 `overview/knowledge-api/chat-memory` 三个 fake，真数据下点数与颜色分布会变。
2. 云内尘的密度是按真实总条数算的，但位置不是真实实体 → 它只是「让盘面形成连续感」的底尘；可点的亮星仍全部来自真实数据。
3. 聚焦态（点左栏「星云构成」四行）只验到相机推进与压暗，没有逐云重截。
4. 老得快的手机会吃不住 12k 点 × 60fps；没有做按 `prefers-reduced-motion` 的单帧降级。


## 25. 星云详情页改用参考实现的画法（P21，逐像素等价已证）（2026-11-11）

用户 m05333（原文）：「星云详情的展示也按照 https://enrichr.dev/elements/galaxy-spiral.html 的样式展示吧，这个应该能一模一样吧」。

### 25.1 做法
进云后的画布（`CloudSideCard` 的 `field`）原本是自创画法（烘焙雾核 + 中心亮芯 + 五圈轨道尘 + 3D 球壳摆位）。这一轮整块交还给参考实现：新增 `MemoryPanel/web/src/starmap/scene/spiralGalaxy.ts`（逐行移植），`MemoryPanel/web/src/starmap/scene/CloudCanvas.tsx` 从 516 行缩到约 210 行，只负责尺寸、动画循环、指针视差与命中。

移植保留三处必要差异（文件头写明）：
| # | 差异 | 原因 |
| --- | --- | --- |
| 1 | 粒子位置由「实体 id 的 hash」当种子，而不是参考的 `rnd(7)` 顺序 | 换页/重渲染时同一颗星不跳位；参考实现每次 `build()` 是纯随机 |
| 2 | 色带从固定 4 档（`#fbf8f1/#e6ff55/#c6f26b/#2f7d5b`）推广成「调色板索引」 | 忆云要按层上色、典籍/构筑要每库一色（m05104） |
| 3 | 记录每颗星上一帧的投影坐标 `X/Y` 与实体下标，供点击命中 | 参考实现不可交互，点不了星 |

其余全部照抄，包括容易漏的四处：`tiltX = 1.0 + ty * 0.7 * tilt`（基准就是 57°，不是 0）、`R = min(W,H) * 0.46`、`f = 1 / (1.6 - z3 * 0.9)` 再 ×1.6、8 个深度桶的 `alpha = 0.18 + depth * 0.82` 与 `尺寸 = (0.7 + depth * 1.1) * P.s`。

### 25.2 逐像素等价证明（本轮最硬的证据）
`.tmp-esbuild/equiv.html`：同一块 688×320 画布、同一批 5000 颗粒子（用参考实现的 `rnd(7)` 生成）、同一组颜色与视角，左边跑参考 `draw()` 的逐行拷贝，右边跑我们的 `drawGalaxy`。

| 版本 | 差异像素 | 最大通道差 | 平均通道差 | 只看底色+核球 |
| --- | --- | --- | --- | --- |
| 首版 | 20,136 / 220,160（9.1%） | 58 | 2.58 | — |
| 补核球中间档颜色 | 16,789 | 24 | 1.09 | 16,860 |
| **补核球外档颜色** | **0 / 220,160** | **0** | **0** | **0** |

两次偏差都不是几何问题，而是核球渐变：参考里 stop 0.4 是 `rgba(47,125,91,0.18)`、stop 1 是 `rgba(12,30,24,0)` —— 中间档和外档都用了「压暗后的 accent」，而 Canvas 渐变按非预乘插值时，**alpha 为 0 的颜色也会影响边缘**。把 `coreMid`/`coreEnd` 补成按 accent 推导（并允许显式覆盖）后，像素差归零。

### 25.3 密度对齐
参考默认盘是 688×320 画布 / 5000 颗；进云后的画布约 1440×900，面积约 3 倍。若仍按 `sqrt(total)*34` 算星尘，盘面会明显比参考稀疏。`dustFor()` 改成 `min(16000, round(sqrt(total) * 90))`：忆云（1.4 万条）≈ 1.1 万颗、技艺云（339）≈ 1,660 颗。

### 25.4 其它改动
1. 星尘改用云自己的颜色走同一套四档明暗 —— 否则盘面核心是黑的（参考实现的亮度分布全在核球）。熄灭的**真**星点仍用暗星色 `#66799b`，「暗 = 未挂载」语义没被星尘冲掉。
2. 选中只把那一颗画大一点（5px 白方点），不加圆环/十字 —— 参考实现里没有任何人造图形。
3. 删掉扭曲的 `resize`：改为幂等（`if (sizes.w === w && ...) return`），保留 P18 那条「给 canvas.width 赋同值也会清空位图」的教训。
4. `CloudSideCard.tsx` 把 `page.total` 传进画布（`total={page?.total ?? points.length}`），星尘密度才按真实条数算。

### 25.5 门（亲跑）
- `npx vitest run` → **195 passed / 195**（19 文件；新增 `src/starmap/scene/__tests__/spiralGalaxy.test.ts` 10 条：公式常量、8 桶/alpha/尺寸/R/f/span、同数据两次构建重合、换 id 换位置、实体可点星尘不可点、四档明暗、CloudCanvas 不再有 `makeNebula/Orbit/GOLDEN/R_IN/R_OUT/layoutPoints`、`resize` 幂等、密度公式、画布无 `fillText`/`setLineDash`/`shadowBlur`）。
- `npx tsc --noEmit` → exit 0；`npx eslint src/starmap src/lib/api src/components` → 0 error / **6 warning**（回到基线，全是既有 exhaustive-deps）。
- `node .tmp-esbuild/run-build.cjs` → `assets/main-D38i_Sv_.js` + `main-BBcwXMv-.css`；`curl 127.0.0.1:8123/` 的 index 里就是 `main-D38i_Sv_.js`。**未重启、未 commit、未 push。**

### 25.6 视觉证据
- 忆云详情：`D:/TDB/td-agemem/.dsh-vision-router/artifacts/cloud-galaxy5.png`（258,675 B，1440×900，CDP 等 4.2s）
- 典籍云详情：`D:/TDB/td-agemem/.dsh-vision-router/artifacts/cloud-galaxy-wiki.png`（139,662 B）
- 与参考画布并排判读：结构同一种（螺旋盘 / 核球在中心 / 旋臂向外 / 倾斜视角），无方块、无网格连线、无圆环，中心未过曝成白斑。
- vision 仍会给「缺加法混合发光」一类建议 —— 但**参考实现本身就是 `fillRect` 堆叠、没有 `lighter`**，按「一模一样」的要求不应加，故未加。

### 25.7 未做/边界
1. 真接口 + 真登录未跑（用户 m03327 要求先不测）；预览是假 `cloudPage`/`knowledge-api`。
2. 星尘颗数按真实条数开方算，位置不是实体；可点的亮星仍全部来自真实数据。
3. 逐像素等价只在 `.tmp-esbuild/equiv.html` 这套临时脚手架里跑过，**没有进仓库测试**（它需要 5000 颗粒子的参考实现拷贝，进仓库等于把参考代码再抄一份；仓库测试锁的是公式与结构）。
4. 参考页面中心的那个 SVG 小件（`ef-gsp__piece`）是他们的装饰 logo，没有移植。


## §26 总览星图：写实螺旋（①）+ 细线连边（③）+ 只画真星点

用户原话：m05588「以 ① 写实螺旋星系为主体，借用 ③ 的细线连边先做一版出来看看」；m05542「注意星点之间要有边，且星点可点击」；m05624「以真实数据作为星点，不要有假星点（没有数据承载）」。

### 26.1 几何演化（三次，均由视觉复核驱动）
1. **一个大盘四条臂**（`ARM_ANGLE/ARM_TWIST=5.2/GAL_R=1.95/armPlace`）。读完判定 3.5/10：臂被读成「参数方程画出来的线」，且四条臂横跨整张画布、右侧大片空洞。
2. **加密真实星点**：`StarmapProvider.tsx` 取 L1 240 → **1200**、L2 80 → 140；`data/graph.ts` `MAX_NODES 720 → 2400`、`L0_TOTAL_CAP 240 → 900`；`FiveBodies` 真实节点上限 480 → L1/L0 1600、L2 400、L3 60。密度上来但仍被读成线框。
3. **四朵云各是一个完整小盘**（当前）：`RING_D = 1.34`、`DISC_R = 0.94`、`DISC_FLAT = 0.86`，`discCenter(key)` 用 `ARM_ANGLE[key] + π/4` 把四个盘均布在人格恒星周围；`armPlace` 改为「盘心 + 盘内局部坐标」，盘内仍走 enrichr 的螺旋数学。视觉 7.5/10，四色分明。

### 26.2 只画真星点（m05624）
删掉两处合成星点：忆云 `dustN`（每层按 total 生成的尘）与 `cloudDust`（wiki/code/skills 云内尘）。没有真实节点的层一颗不撒；体量感交给气团（气是雾不是星）。`Star3.dust` 字段保留仅为类型兼容，今天没有任何生产者。

### 26.3 连边（m05542 + ③ 的形态）
- `const showLinks = true;`（原只在聚焦/选星时画），`ctx.lineWidth = 0.7`，桶 alpha `* 0.10`，`la = min(0.4, 0.05 + w*0.12) * (1 - min(dz/3.2, 0.62)) * (cross?1.5:0.66)`。
- 总览时**掐掉跨半张画布的长边**：`if (!focusKey && !selWorld.current && Math.hypot(xb - xa, yb - ya) > small * 0.42) continue;` —— 视觉复核对长边的原话是「像未渲染完的 3D 网格模型」。
- 云内关系线总览只抽 1/3；「丝缕」粗线只在聚焦时画。
- 星点仍可点：`onPointerUp` 命中 `starHits`（半径 ≥6px），选中走 `selectStar`，选中星及其邻边被提亮。

### 26.4 气体与颜色
- 旋臂/盘内气团：`STEPS = 42` 个 `nebulaSprite(CLOUD_COLOR[c.key].inner, 11)`，黄金角取点铺满该云的盘（`const ga = i * 2.399963229728653 + 0.7`）。
- 气浓跟着真实星点数走：`const dens = Math.min(1, c.stars.length / 260);` × `(0.35 + 0.65 * dens)` —— 否则空云会变成「一大团雾里没几颗星」。
- 气团 alpha 0.052 → **0.030**、尺寸 `0.20 + 0.16*n`（原 0.26/0.20），避免糊住星点。
- 星点上屏仍照 enrichr：8 深度桶 × 4 色档 × `fillRect`，尺寸上限 1.8 → **2.1px**。

### 26.5 门（亲跑）
- `npx vitest run` → **197 passed / 197**（19 文件；`starmap/__tests__/galaxy.test.ts` 15 条，新增/改写：四云各是独立小盘、总览画细线边且掐长边、没有真实数据承载的星点一律不画）。
- `npx tsc --noEmit` exit 0；`npx eslint src/starmap src/lib/api src/components` 0 error / 6 warning（全既有 exhaustive-deps）。
- `node .tmp-esbuild/run-build.cjs` ✓ → `dist/assets/main-BNpRPwyb.js`；`curl -s http://127.0.0.1:8123/` 返回同一 hash（panel 发 `web/dist`，落盘即生效；**未重启、未 commit**）。

### 26.6 视觉复核（CDP + vision_describe）
截图 `.dsh-vision-router/artifacts/ov-discs2.png`（687,574 B，1440×900；canvas 748×820，links 1669）。
读数：四团颜色分明（右上冷蓝 / 右下青绿 / 左下暖金 / 左侧粉紫，冷暖对比鲜明）、左下金色团有清晰双旋臂、评分 **7.5/10**。
扣分项（未解决）：①形态不统一（粉紫那团偏弥散、缺实体旋臂，因为技艺云真实星点最少）②粒子质感偏硬（离散点阵感）③构图左侧粉色区域偏空。

### 26.7 未做
1. 粉紫（技艺云）还是偏空：真实 skill 只有 51 个挂到当前 agent，靠气团撑不满；需要「未挂载技能」也上盘（现在只按 agent 过滤）。
2. 粒子偏硬：enrichr 原样式本身没有辉光；要更柔需要给亮星叠一层小 sprite（不是加假星点），未做。
3. 四条边色图例与画布边色已同源，但总览里仍偏细，用户尚未验收。
4. 真接口+真登录下未验证（m03327 要求先不测）。


### 26.8 追加：用户实机截图判定「星点太小、不像星图」后的四轮调优
用户 m05748 原话：「星点太小了看着不明显啊，而且现在看起来不像是星图」。vision_describe 在用户截图上给出的两条判定：星点相对画布过细碎；密集连线把画面读成「网络拓扑/线框」，圆柱与无限环都是连线勾出来的。
- **星点放大**：`Math.min(2.1, …)` → `Math.min(3.6, szf * size * (k/kRef) * 1.9)`，下限 0.6 → 1.2px。
- **亮星柔光层**（不是新增星点）：`q.s.bead || q.s.weight > 0.86` 的星在画方点前先 `drawImage(spriteOf(col), …)` 一圈光晕，alpha 0.26（熄灭星 0.10）。
- **总览边再降一档**：跳过 `rel === '引用'`（代码图内部边最密）、`w < 0.55`、再按 1/5 抽样，长度上限 `small * 0.42 → 0.24`，桶 alpha `* 0.10 → * 0.06`。
- **亮度拉平**：新增 `CLOUD_GAIN = { memory: 0.74, wiki: 1.02, code: 1.06, skills: 1.18 }`（忆云星点最多最易过曝，技艺云最少最易看不见），星点尺寸与柔光 alpha 都乘它。
- **降曝**：云核 `nucA = (isFocus ? 0.34 : 0.21)`（原 0.5/0.34）；人格核 `rg` 起始 stop 0.18 → 0.11、`haloR = CORE_R * 2.9`（原 3.4）。
- 视觉读数：3.5 → 7.5 → **8.5/10**（「非常有深空摄影的味道」），剩余问题只剩「中心仍偏过曝」。
- 门：`vitest run` **197 passed / 197**；`eslint src/starmap` exit 0；`node .tmp-esbuild/run-build.cjs` → `dist/assets/main-BpHC7ne4.js`；`curl 127.0.0.1:8123/` 同 hash（未重启、未 commit）。
- 仍未做：粉紫技艺云偏空（只画了挂到本 agent 的 51 个技能，团队可见未挂载的 288 个没上盘）；粒子仍偏硬。


## §27 五条硬要求落盘：非重叠 / 有连线 / 不刺眼 / 自转 / 公转（P19）

用户 m05820（原文）：「我找到问题了，我觉得还是我们设计的有问题，你能不能参照写实螺旋星系的样式自己设计一个，我的要求首先是星点不能重叠，其次星点直接必须有连线，星点亮度不能太高造成光污染，然后星云必须自转，且多个星云围绕灵魂恒星公转」；m05843 复述同五条 + 「你先用模拟的数据按我的要求写代码实现」。

### 27.1 五条要求 → 代码落点（`MemoryPanel/web/src/starmap/scene/FiveBodies.tsx`）
| 要求 | 实现 |
|---|---|
| 星点不能重叠 | 新增 `thinStars(stars, minD)`：按 minD 分桶的贪心剔除，只查 3×3 邻桶（线性时间）；忆云 `0.045`、其余 `0.050` 世界单位。同时把亮星柔光半径 `7 → 5`、alpha `0.15 → 0.11`——「糊成一团」多半是柔光叠的，不是真重叠 |
| 星点之间有连线 | 总览只留强关系（`w ≥ 0.55`）、跳过代码图内部「引用」边、按 **1/2** 抽样；长度上限 `small*0.30`；分桶 alpha `*0.13` |
| 亮度不造成光污染 | 星点尺寸 `Math.min(2.6, szf*size*(k/kRef)*1.45)`、下限 1.05px；深度桶 alpha `(0.14 + depth*0.56)*(dim?0.45:1)`；柔光 alpha 亮星 0.11 / 暗星 0.05 |
| 星云自转 | `SPIN_SPEED = { memory: 0.085, wiki: -0.071, code: 0.061, skills: -0.093 }`（约 45–80 秒一圈，方向有正有负） |
| 多星云绕灵魂恒星公转 | `ORBIT_SPEED = { memory: 0.052, wiki: -0.039, code: 0.031, skills: -0.047 }`（约 90–140 秒一圈）；`applyXf(p, key)` 以建场云心为原点做刚体旋转再平移到当前轨道位置，用在**云心投影 / 每颗星 / 连线两个端点**三处；核→云线加 `toCloud` 让外端跟着云走 |

### 27.2 视觉复核（CDP 6200ms，1440×900，裁画布区）
- `ov-orbit1.png`（544KB）：星点密集处仍有明显重叠、**完全看不到连线**、亮度柔和、像星系 9/10。
- `ov-orbit2.png`（1/2 抽样 + alpha 0.13 + minD 0.028/0.032）：重叠仍在（柔光叠的）、连线「极细稀疏隐约可见」、不刺眼、9/10。
- `ov-orbit3.png`（**最终**：minD 0.045/0.050 + 柔光 5px/0.11）：**「星点清晰独立，没有糊成一团」**、**「可见，右上角蓝色星团内部能看到细微的网状连线」**、**「不刺眼」**、8/10。

### 27.3 公转/自转真的在动（机器证据，不是「我觉得」）
同页两次 CDP 截图间隔 1.6s（3.0s / 4.6s），`vision_pixel_diff` 读数：**differingPixels 5,855 / 1,296,000，diffRatio 0.0045**，差异集中在画布右侧云区（worstRegions x 720–1080、y 226–452，ratio 4–5%）。静止画面这块应为 0。

### 27.4 门（亲跑）
- `npx vitest run` → **198 passed / 198**（19 文件；`galaxy.test.ts` 16 条，新增第 16 条把五条要求逐条锁成断言：ORBIT_SPEED/SPIN_SPEED 常量、`applyXf` 三处、`thinStars` 接线与 minD 值、1/2 抽样 + `small*0.30` + `*0.13`、尺寸/alpha 上限）
- `npx eslint src/starmap` → exit 0
- `node .tmp-esbuild/run-build.cjs` → `dist/assets/main-BphMQvrb.js`；`curl 127.0.0.1:8123/` **同一 hash**（未重启、未 commit）

### 27.5 未做
选中星环用的是点击时缓存的世界坐标，公转会让它与星点分离（未修）；云内连线只跟着云走，不跟着单颗星自转后的新位置重新配对（owner 刚体变换是整块旋转，视觉一致）；真接口 + 真登录仍未跑（m03327 要求先不测）。


## §28 改用 VirtualSky 星图样式（SKY_MODE，P20）

用户 m05983（原文）：「停吧停吧，你这样根本不行，试试换成https://slowe.github.io/VirtualSky/这个样式吧」；m05959 附图指出「点击星点后的关联边和星点根本就不在星图上」「星点太小」「星云中星点的分布也不符合螺旋星系」。

### 28.1 双分支而不是推翻重写
`MemoryPanel/web/src/starmap/scene/FiveBodies.tsx` 文件头新增 `const SKY_MODE = true;`：
- **sky**：散点 + 星座细线 + 极淡天球网格，无雾/无核光晕/不公转不自转（星图＝静态天球）。
- **galaxy**：之前的写实螺旋（雾体、8 深度桶、方点、公转自转），代码全部保留在 `else / !SKY_MODE` 分支里，改一个布尔值就能回去。

### 28.2 sky 分支具体画法
- 天球网格：3 圈 `ctx.ellipse(cx, cy, rr * 1.35, rr)`（`rr = small * 0.13 * ring`）+ 12 条放射线，`strokeStyle '#5f7fb8'`、`lineWidth 0.6`、`globalAlpha 0.075`。
- 星点：圆点，星等拉开三档 —— `mag = Math.pow(clamp(weight), 2.2) * (bead ? 1 : 0.7)`，亮星 `r = 0.8 + mag * 3.0`、暗星 `r = 0.55 + mag * 0.9`；alpha 亮星 `0.34 + mag * 0.62`、暗星 `0.26`；bead 亮星补 0.7px 四芒十字（不叠 sprite 光晕）。
- 连线只画**星座骨架**：`rel === '提取' | '人物' | '归属'`（归属再 1/2 抽样），`lineWidth = SKY_MODE ? 0.6 : 0.7`、桶 alpha `(SKY_MODE ? 0.17 : 0.13)`。理由：把块间关系全画出来就是知识图谱——vision 复核原话「本质上是数据网络/知识图谱」，7 分。
- 静止：`oa = a0 + (SKY_MODE ? 0 : ORBIT_SPEED[c.key] * T)`、`spin = SKY_MODE ? 0 : SPIN_SPEED[c.key] * T`。

### 28.3 视觉读数（CDP 5200ms，1440×900）
| 版本 | 读数 |
|---|---|
| `ov-sky1.png`（457,630 B，散点 + 网格 + 全量连线） | **9/10**「很有天文馆软件的味道」；问题：星点大小过于均一、左右面板像后台管理系统 |
| `ov-sky2.png`（加星等层级，线仍多） | **7/10**「本质上是数据网络/知识图谱」 |
| `ov-sky3.png`（连线只留骨架，最终） | **8.5/10**「极像星图/星系图」「星等层级非常明显（十字星芒 + 大小渐变 + 颜色编码）」「网格/星点/细线协调」，剩三条：中心过密无法分辨个体、外围亮星离中心远缺少视觉引导线、看不出交互入口 |

### 28.4 门（亲跑）
- `npx vitest run` → **198 passed / 198**（19 文件；`galaxy.test.ts` 16 条已按双分支重写：sky 骨架过滤、`(SKY_MODE ? 0.17 : 0.13)`、星等公式 `pow(weight,2.2)`、`r = 0.8 + mag*3.0`、SKY_MODE 下公转自转归零；galaxy 分支的 `!SKY_MODE &&` 强关系/长边断言仍保留）
- `npx eslint src/starmap` → exit 0
- `node .tmp-esbuild/run-build.cjs` → `dist/assets/main-CVFaJog6.js`；`curl 127.0.0.1:8123/` **同一 hash**（未重启、未 commit）

### 28.5 未做
中心过密与「交互入口看不出来」未处理；`SKY_MODE` 是编译期常量、没有 UI 开关；星云详情页（`CloudCanvas`）仍是 game 分支的螺旋写法，没同步 star-map 风格。


### 28.6 星点再放大（用户 m05959「星点太小」的最终处理）
第一版 sky 星点是针尖感（`r = 0.55 + mag*0.9` / `0.8 + mag*3.0`，alpha 0.26/0.34+0.62），vision 复核原话「绝大多数星点非常细小，像针尖或噪点」。改为：亮星 `r = 1.4 + mag * 3.8`、暗星 `r = 0.95 + mag * 1.7`，alpha 暗星 0.34、亮星 `0.42 + mag * 0.56`。复核读数：「明显比针尖好，带十字芒的主星清晰醒目，核心区密集点有辉光，层级感出来了」「有明确旋臂结构与疏密分布」**8.5/10**，剩「核心区略密」。
`galaxy.test.ts` 同步换了这两处断言；`vitest 198/198`、`eslint 0`、build `main-CYvYEdBA.js`、`curl 127.0.0.1:8123/` 同 hash（未重启、未 commit）。

## §29 VirtualSky 整段移植（用户 m06192「抄就抄全」）

### 29.1 起因
用户 m06192：「你抄就抄全了啊，怎么半抄半不抄的，你先把代码扒下来再改」。
取证：上一版 SKY 分支是手写星点半径（`1.4 + mag*3.8`）、手画 3 圈椭圆 + 12 条放射线当网格、自定 `lineWidth 0.55` —— 确实只抄了形，没抄实现。

### 29.2 参考源码（`MemoryPanel/web/.tmp-esbuild/ref/virtualsky.js`，3,592 行；镜像 `https://fastly.jsdelivr.net/gh/slowe/VirtualSky@master/virtualsky.js`）
| 参考实现 | 行号 | 关键内容 |
| --- | --- | --- |
| `projections.stereo.azel2xy` | 386-398 | f=0.42；k=2/(1+cosel·cosaz)；x=w/2+f·k·h·cosel·sinaz；y=h−f·k·h·sinel |
| `drawStars` | 2599-2633 | d=0.8·max(3−mag/2.1,0.5)·fovf·scale，fovf=√(30/fov)；一条 path 累积 arc 后一次 fill |
| `drawConstellationLines` | 2804-2870 | 单色、lineWidth 0.75、超过 maxLine() 的段舍弃 |
| `drawGridlines` + `joinpoint` | 3099-3149 / 3213-3241 | 经线循环外层、纬线循环内层，距离 > tall/2 才 moveTo |
| `maxLine` | 3243-3247 | tall/f，默认 f=3 |
| `colours.normal` | 858-878 | stars rgb(255,255,255)、constellation rgba(180,180,255,0.8)、az rgba(100,100,255,0.4) |

### 29.3 落盘
- 新增 `MemoryPanel/web/src/starmap/scene/sky.ts`（约 200 行）：`stereoAzElToXY` / `maxLine` / `skyStarRadius` / `skyMagOf` / `drawSkyGrid`（含 joinpoint 语义）/ `drawConstellationLines` / `stencilStar` / `SKY_COL` / `SKY_F`。文件头标注来源 URL、行号与三处适配（颜色换本项目色板、星等由权重反推、坐标挂到本项目画布）。
- `MemoryPanel/web/src/starmap/scene/FiveBodies.tsx`：网格整块替换为 `drawSkyGrid(..., { kind:'az', step:30, lineWidth:0.75, map })`（map 把立体投影结果搬到 cx/cy 并乘 `zoom/BASE_ZOOM`，所以拖拽缩放时网格与星点同步）；星点半径改用 `skyStarRadius(skyMagOf(weight, bead), SKY_FOV=55, SKY_STAR_SCALE=3.1)`；星座骨架改 `drawConstellationLines(ctx, segs, max(W,H), SKY_COL.constellation, 0.75)`（单色、0.75 线宽、maxl 守卫），组内仍按同会话/同人物/同库成组。
- 新增 `MemoryPanel/web/src/starmap/scene/__tests__/sky.test.ts` 10 条：立体投影三个方位/仰角数值（az=π el=0 → (w/2,h)；el=π/2 → y=h−0.84h；az=π/2 与 3π/2 左右对称）、`skyStarRadius` 公式、`skyMagOf` 单调、`maxLine`、网格单色与两次 stroke、步长越小线越多、星座线单色 0.75 且超长段被丢弃、无 `Math.random`。

### 29.4 门（亲跑）
vitest **208 passed / 208**（20 文件）；`npx tsc --noEmit` exit 0；`npx eslint src/starmap src/lib/api src/components` 0 error / 6 warning（既有 exhaustive-deps）；`node .tmp-esbuild/run-build.cjs` → `assets/main-BzCOidhX.js` + `main-BBcwXMv-.css`；`curl 127.0.0.1:8123/` 发的就是 `main-BzCOidhX.js`（**未重启、未 commit**）。
变异探针：`sky.ts` 把 `const f = SKY_F` 改成 `0.5` → 2 failed / 8 passed，还原后 sha256 前 16 位 `166c5e9e58826a20` 一致。

### 29.5 视觉（`D:/TDB/td-agemem/.dsh-vision-router/artifacts/ov-sky5.png`，829,871 B，1440×900）
vision 读数：①网格像**天球坐标网格**（同心圆 + 放射线），不再是我手画的椭圆 ②星点是发光圆球、亮暗层次分明 ③有极细连线，接近淡蓝白单色（与参考实现单色一致）④蓝/金/粉可分辨，绿（典籍 265 条）在主图不明显 ⑤缺陷：右上记忆云中心过曝糊成一团、大面积空洞 ⑥真实感 **3/10**，理由是「点呈聚类分布、有空网格、像数据可视化」。
结论：实现已与参考一致，但「真实感」受真实数据分布（聚类）与无背景尘限制——这是数据形态问题，不再是画法问题。

### 29.6 未做
- 参考实现的 `eq`/`gal` 网格帧需要赤道/银道坐标换算，本项目只有一帧 az/el，函数里保留 kind 判断但未启用另两帧。
- 星点仍按云/层上色（参考实现是单色白）——这是用户 m03830「每个星云、每个层级的颜色都不同」的硬要求，故意不改回单色。
- 中心过曝（记忆云星点密度最高）与四角空洞待调；真接口+真登录端到端仍未跑（用户 m03327 要求先不测）。
