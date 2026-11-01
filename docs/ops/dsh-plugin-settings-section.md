# task-116：设置页签缺失的根因修复（settings.section 注册）

As of 2026-11-01 08:2x。未安装、未重启宿主、未改 ~/.dsh、未 commit。

## 1. 根因（Lead 探针实测，无头浏览器 page console）

```
[slot-probe] sections=["general","models","plugins","agent-presets"]
[slot-probe] items=["subagent","web-search","agent-loop","tdb-agemem","shell"]
```

我们的 client.js 加载成功、`plugins.item` 也注册上了（items 里有 `tdb-agemem`），但 `settings.section` 的占用者里没有我们：
`client.js:603-610`（改前）只注册了「插件」页槽。桌面 App 的「插件」页由 Electron 自己管理 profile 条目，
`managementAvailable !== true` 时那张卡片就不渲染；「设置」对话框的左侧导航完全不经过 plugin-manager 的 inventory 门，
所以用户按直觉去「设置」里找，找不到是**必然**，不是环境差异。

## 2. 修法（客户端，纯浏览器侧，不需要重新部署宿主代码）

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 抽出 `formBody(props, state)` | `dsh-plugin/client/client.js:564` | 两个槽共用同一份三段表单，卡片与设置页不可能各说一套 |
| 保留 `AgememCard` | `:582` | 仍注册 `plugins.item`（order 40）；`view==='summary'` 仍只返回 `description`（不回归） |
| 新增 `AgememSection` | `:599` | `<h2>`+`title`、`<p>`+`description`、`SettingsForm`；不出现 summary 文案 |
| 双槽注册 | `:626-666`（`apply`） | 同一个 `whileServed([ENTRY_ID])` 内先 `plugins.item` 后 `settings.section`；一个 effect 同时管两个 disposer（带 `typeof === 'function'` 守卫） |

`settings.section` 注册口径（宿主契约 `dsh-cordis-client-runner/lib/client.js:5340-5391`，参照 `dsh-client-ui-settings-plugins/lib/client.js:201-212`）：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "tdb-agemem",
  order: 30,          // plugins=15，我们排在它后面
  label: () => t("title"),
  locale: NS,
  inject: face        // 与卡片同一个 AgememFormController.inject()
}, AgememSection))
```

- 两个槽**并存**，`plugins.item` 没删（CLI / 宿主托管 profile 仍可用那张卡）。
- 两个槽的 `inject()` 返回同一个 face（测试断言 `hooks.tdbAgememCard` 是同一个 store）⇒ 一处改动、一次保存，另一处立刻一致。
- inert 行为不变：只在 `ctx.configForms.whileServed([ENTRY_ID])` 回调里注册；宿主没加载本插件的 profile 条目 ⇒ 一个槽都不注册（测试用例 `registers nothing while the Host serves no profile entry`）。
- 新增 CSS 两条：`._tdbAgemem_page{display:grid;gap:12px}`、`._tdbAgemem_heading{...font-size:15px;font-weight:600}`，无宽度写死，颜色走 `--dsw-alias-*`。

## 3. 测试（`dsh-plugin/test/client-bundle.test.ts`，21 → 25 条）

夹具调整：`fakeContext(overrides, { serve })` 支持 inert（`whileServed` 不回调）；`mount()` 按 `options.name` 分别取 `plugins.item` / `settings.section`（原来是 `registrations[0]`）；
渲染 helper 统一成 `render(mounted, registration, extra)`，`renderPage` / `renderSection` 各取一个槽。

新增/改写：

1. `registers the card into the plugins item slot and the page into the settings navigation`：两个槽都在、`registrations` 长度 2、plugins.item `{id:'tdb-agemem', order:40}`、settings.section `{id:'tdb-agemem', order:30, label:()=>t('title')}`、`served` 仍是 `[["tdb-agemem-dsh"]]`（都在服务态内注册）；
2. `hands both slots the same staged form face`：两槽 `inject()` 的 `hooks.tdbAgememCard` 是同一个对象，`save/discard` 都是函数；
3. `registers nothing while the Host serves no profile entry`：inert 时 `registrations` 为 0、`served` 仍记录请求；
4. `renders the settings section with the panel copy above the same form`：根节点 `div._tdbAgemem_page`、文本含 `title`+`description`、有 `SettingsForm`、`EXPECTED_FIELD_PATHS` 里的字段 id + 两个 secret id 全在（当时 15 个；身份三轴移出后 12 个，见 §5）；
5. 原有 `renders the one-liner in the summary view` 保持不变（summary 仍只返回 `description`）。

## 4. 门禁读数

| 项 | 读数 |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | EXIT=0（08:22:2x） |
| 全量 vitest | **34 files / 601 tests passed**，Duration 44.75s（改前基线 34/598 ⇒ +3） |
| `npm run build` | rc=0，`dist/index.js` 08:22:23 |
| 改动文件 | `dsh-plugin/client/client.js`（sha1 前 12 位 `316960e3e14e`）、`dsh-plugin/test/client-bundle.test.ts`、`dsh-plugin/README.md`；`git status` 仅这三条，未 commit |

## 5. README

新增「设置入口（设置 → TDB 记忆）」小节（`dsh-plugin/README.md:220-238`）：两个槽的出现条件对照表、共享 staged form 的说明、
「桌面版唯一保证可见的入口是设置导航」的原因（插件页由 Electron 管理 profile 条目），以及样式/本地化口径。

## 6. 留给 Lead 真机验证

- 装同一份 build 后跑同一个探针，期望 `sections=["general","models","plugins","tdb-agemem",...]`（order 30 排在 plugins 15 之后）；侧栏出现「TDB 记忆」。
- 本次**没有**真机渲染截图（未安装、未重启宿主是红线），只做了 vm 沙箱内的槽注册与组件树断言。
- 若真机上出现双重标题（设置页外壳自己画了标题），删 `AgememSection` 里那行 `<h2>` 即可；当前契约（`SettingsSectionOwnerProps` 只有 `close`）不投影标题，故保留。

## 7. 后续（2026-11-01 14:0x）：身份三轴已从表单移除

设置页面对「填团队 id / 智能体 id / 用户 id」这条要求已经过时：身份在 mount 时由 user key 解析、
每会话再由该用户自己的 `session_init` 配置决定（`docs/ops/dsh-plugin-session-identity-popup.md`），
表单里再放三个输入框只会让宿主和 core 各说一套。改动：

| 面 | 改动 |
| --- | --- |
| 宿主设置表单 | `src/config-schema.ts` 的 `VOLATILE_PATHS` 去掉 `server.teamId` / `agentId` / `userId`（30 → 27），对应 `DESCRIPTIONS` 三条删除 |
| 插件自己的卡片/设置页 | `client/client.js` 的 `FIELDS` 与 `SECTIONS[0]`、中英文字典里的六个标签/提示一并删除（15 → 12 字段） |
| 配置本体 | 三个键**保留**在 `config.ts` / `DEFAULT_CONFIG.server` 里，作为 patch-only 兜底（`deploy.sh --identity`、`scripts/agemem-identity.mjs`），`normalizeConfig` 照旧解析 |
| 测试 | `config-schema.test.ts` 数量 30→27、并断言三元组不再是 volatile；`client-bundle.test.ts` 的 `EXPECTED_FIELD_PATHS` 去掉三条，原来拿 `server.teamId` 当「随便一个文本框」的用例改用 `server.baseUrl` |