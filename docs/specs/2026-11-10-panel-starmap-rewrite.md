# Panel 星图化重构（单页 · 深空 HUD）

状态：已开工。目标：废弃 MemoryPanel 旧的多页后台外壳，重写为单页星图界面；数据层（lib/api、services、stores）与后端接口一个字不改。

## 0. 硬约束

1. 数据不能丢不能乱：新 UI 只允许调用既有 `src/lib/api/*`、`src/lib/teamApi.ts`、`src/services/*`、`src/stores/*`。禁止新增后端接口、禁止改表、禁止在 UI 里手改库行。
2. 功能必须齐：旧面板 9 个页面（wiki / code / skills / memory / soul / team-members / team-agents / team-api-keys / settings）的读写能力全部要在新界面里有入口。
3. 登录鉴权链不变：`panelSession` 的 instance_id + user_key 双 Header，401 清会话回登录。
4. 不引入新的 UI 依赖：不引入 antd/mui/shadcn；沿用 React 18 + Tailwind + 原生 CSS。旧的 tea-component 组件只允许在未重写的角落临时存在，新代码不新增 tea 依赖。
5. 视觉：深空 HUD，禁用浅色卡片堆叠式后台观感；正文 9.5–12.5px，靠字距与灰阶分层，不靠大字号粗体。

## 1. 界面形态（单页）

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：品牌 / 团队切换 / 计数四指标 / 时钟 / 用户                 │
├───────────┬──────────────────────────────────┬───────────────┤
│ 左 HUD    │        canvas 星图（全屏背景）      │  右 HUD       │
│ ·星门导航  │  ·星云 + 旋臂 + 轨道 + 星尘        │ ·人格内核     │
│ ·图层过滤  │  ·记忆点/关系线/日期星             │ ·认知流       │
│ ·缩略图    │                                  │ ·检索内核     │
├───────────┴──────────────────────────────────┴───────────────┤
│ 底部：记忆活跃柱状 / 选中项详情卡 / 归位                        │
└──────────────────────────────────────────────────────────────┘
```

星门（station）= 旧面板的一个页面。星门以发光锚点散布在星图不同象限，点击后从右侧/中部升起一层「星云层」overlay 承载该功能，overlay 内部是新写的该功能界面（不是旧页面的 iframe，也不是旧组件复用）。

路由：hash 路由保留深层链接 `#/wiki` `#/code` `#/skills` `#/memory` `#/soul` `#/team/members` `#/team/agents` `#/team/api-keys` `#/settings`；每条路由渲染同一个 `StarmapApp`，由路由决定当前展开的星门。Esc 关闭星门回到纯星图。

## 2. 星图数据（必须真实）

- 节点 = 当前选中记忆块的 L1/L2/L3 条目（`chatMemoryApi.layer`），节点文本取 title/body 首句，节点类型取 layer。
- 边只来自真实关系，绝不随机：同 session（session_key 相同）、同 person（refs/persons 交集）、父子引用（refs 指向本块内 id）。权重 = 关系强度（同 session 1.0、同人 0.8、引用 0.6）。
- 日期星 = 条目 created_at 按天聚合。
- 数据不足时不编造：节点数 < 3 时星图显示「等待记忆数据」占位并给出入口（去 memory 星门导数据）。
- 星门锚点是导航元数据，不算记忆节点。

## 3. 视觉令牌（tokens.css）

```
--bg:#04060d  --ink:#e8f1ff  --dim:#7b8db0  --dim2:#5a6b8c
--line:rgba(120,170,255,.16)  --hair:rgba(120,170,255,.07)
--panel:rgba(8,12,22,.72)  --panel-solid:#080c16
层色：L0 #7f93bd  L1 #7fc8ff  L2 #ffb86b  L3 #9fe6c8  人物 #ff8fc7  日期 #ffd479
```

卡片外壳 `.card2`：半透明 panel、1px line、11px 圆角、blur(13px)、内缩 4px 发丝线、左上 34px 高光。标题中文 11.5px + 英文 8.5px 大写 `.18em` 字距。所有交互数字用 tabular-nums。

## 4. 星门契约（每个 station 必须实现）

```ts
export interface StationProps {
  /** 当前团队 / 用户 / 权限 */
  ctx: StationContext;
  /** 关闭本星门 */
  onClose: () => void;
  /** 让星图聚焦到某个实体（可选） */
  focus?: (id: string) => void;
}
```

要求：
- 首帧骨架（Skeleton）而非空白；
- 空态给下一步动作（不是「暂无数据」四个字）；
- 破坏性操作（删除/解绑/失效）二次确认；
- 失败必须显示后端 message，不允许静默；
- 不做任何跨星门的隐式状态修改。

## 5. 验收

- `npx tsc --noEmit` 与 `npm run build` 通过；
- 9 条 hash 路由都能打开对应星门，数据真实来自后端（生产 8123/8420）；
- 星图节点数/边数与 `chatMemoryApi.layer` 返回一致（对数脚本）；
- headless Chrome 截图：纯星图态、某星门展开态、窄屏态；
- 旧入口 `#/wiki` 等旧链接仍能落到对应星门。
