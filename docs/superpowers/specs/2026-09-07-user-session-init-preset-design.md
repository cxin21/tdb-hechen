# 用户级会话初始化解愤怒默认配置（User Session-Init Preset）设计

> 状态：设计草案（待评审）
> 日期：2026-09-07
> 关联：MemoryCore / MemoryProxy / MemoryPanel 三端

---

## 一、背景与问题

### 现状

每一次新会话的**第一轮请求**，MemoryProxy 都会走 **session-init 状态机**，向用户弹出逐级交互式表单：

```
asset_confirm（是否关联团队资产）→ team（选团队）→ agent_select / task_select（选 Agent / Task）
```

选定后，proxy 把 `(team, user, agent, session)` 元组登记，供后续的记忆/技能注入使用。对"每次都要手动选"这件事，目前只有两类手段，都不是"用户在 UI 配一次"：

1. **headerAutoSelect**（`session/preset.ts`）：请求头带 `x-team-id`/`x-agent-id` 时校验通过则跳过表单。属于**请求头级**快捷方式，每次都要客户端自己带，且不走 UI 配置。
2. **debugForceIdentity**（`types.ts`）：仅供本地调试，生产不启用。

### 痛点

- 用户每开一个新会话都要手动点三轮问答（尤其高频用户），体验繁琐。
- 若团队只有 1 个 agent / 1 个 team，这种强制选择基本是干扰。
- 团队目前提供"成员各自配大模型"等个性能力，但没有"成员各自配会话关联默认值"。

### 目标

在 Memory hub UI（MemoryPanel）为**每个用户**提供一套"会话之初始化工共享默认值"配置：

| 配置项 | 含义 |
|---|---|
| 是否需要手动选择 | `manual_select` |
| 默认是否关联团队资产 | `default_associate`（= asset_confirm 的默认回答） |
| 默认关联团队 | `default_team_id` |
| 默认关联 Agent | `default_agent_id` |

**决策原则**：配了且 `manual_select=0` → 优先按默认值自动处理；没配或 `manual_select=1` → 仍走现有交互表单。**未配置的用户行为零变化**。

---

## 二、现状勘查结论（代码级）

### 2.1 会话初始化的状态机

所有 handler 最终都进入 `MemoryProxy/src/session/index.ts` 的**单一** `handleSessionInit`，它再分流到两个状态机：

- **codebuddy（CB）状态机** `session/codebuddy/init.ts` —— 被 **codex / workbuddy / dsh / opencode** 复用（在 index.ts 外层重渲染 form 载体，`cloud_binding` 不变）。
- **claude-code（CC）状态机** `session/claude-code/init.ts` —— 独立。

各自在 `uninitialized → asset_confirm` 分支弹表单。因此"全客户端统一生效"只需在**这两个**状态机分支接入读取配置，无需触碰 6 个客户端各自的 form 渲染层。

> 关键证据来源：
> - `session/index.ts`（单一入口 + 外层重渲染：workbuddy / dsh / opencode 均复用 CB）
> - `anthropicHandler.ts` / `codexHandler.ts` / `workbuddyHandler.ts` 均调用 `handleSessionInit`
> - `session/preset.ts`（headerAutoSelect 现行预选逻辑，可参考其 resolve 模式）

### 2.2 每用户参数基础设施（已存在，可复用）

MemoryCore 已有完整的 **ConfigParam 注册表 + 用户优先/global 兜底**机制：

- 注册表文件：`MemoryCore/src/metadata/config/metadata_config_params.json`（现有 `quota`/`asset_type` 两个 module；`asset_type.*.enabled` 已是 `user` 作用域）。
- 注册表校验/查询：`metadata/config/param-registry.ts`（`MODULE_RE`/`PARAM_NAME_RE`、`isUserWritable`）。
- 业务逻辑：`metadata/service/config-param-service.ts`（`getEffectiveParam` 用户优先+global 兜底、60s 进程内缓存、`setUserParam` 校验）。
- **HTTP 端点已存在**：`metadata/router/v3-meta-router.ts` 里
  - `POST /v3/meta/config/user/get`
  - `POST /v3/meta/config/user/set`
  - 均带 `assertCallerIsOwner(user_id, caller)` 权限校验（只能读/写自己）。

### 2.3 proxy → kernel 通道

- `MemoryProxy/src/meta/client.ts` **MetadataClient**：POST `/v3/meta/*`，带 `Authorization: Bearer serviceToken` + `x-tdai-service-id` + `x-tdai-user-key`。
- 目前已有 `listTeams` / `listAgents` / `getAgent` 等，**尚无** `getUserConfig` 方法 → 需新增。

### 2.4 面板缺口

MemoryPanel（`src/panel` 后端 + `web/src` 前端）**目前没有引用**任何 `config/user/*` 或 ConfigParam —— 即每个用户的可配置界面尚未暴露。需新增一个"会话初始化默认值"设置页。

---

## 三、方案设计

### 3.1 MemoryCore：注册表新增 `session_init` module

在 `metadata_config_params.json` 新增模块（4 个参数全部 `user` 作用域，允许用户覆写 global 默认）：

```json
{
  "module": "session_init",
  "description": "会话初始化关联默认值（每用户）",
  "params": [
    {
      "param_name": "manual_select",
      "param_value": "1",
      "description": "是否需要手动选择关联（1=仍弹表单；0=按默认自动关联）",
      "allowed_scopes": ["global", "user"]
    },
    {
      "param_name": "default_associate",
      "param_value": "1",
      "description": "默认是否关联团队资产（= asset_confirm 默认回答）",
      "allowed_scopes": ["global", "user"]
    },
    {
      "param_name": "default_team_id",
      "param_value": "",
      "description": "默认关联团队 id（空=未指定）",
      "allowed_scopes": ["global", "user"]
    },
    {
      "param_name": "default_agent_id",
      "param_value": "",
      "description": "默认关联 Agent id（空=未指定）",
      "allowed_scopes": ["global", "user"]
    }
  ]
}
```

> 说明：`validateParamValue` 对 `user` 作用域且默认值为 `0/1` 的布尔参数会强制校验 `0|1`，利于滑块；`default_team_id`/`default_agent_id` 是字符串，允许空串表示未指定。

### 3.2 MemoryProxy：读取用户配置 + 决策

**新增** `MetadataClient.getUserConfig(userId, module, paramNames?)`，请求 `/v3/meta/config/user/get`，返回用户配置视图（复用 `getUserConfigForCaller` 返回的 `UserConfigView` 形状）。

**决策插入点**：在 CB 与 CC 两个状态机的 `uninitialized → asset_confirm` 分支**之前**，读取该用户的 `session_init` 配置，据此决定：

| 配置机关 | 行为 |
|---|---|
| 未配置 / 读取失败 / kernel 不可达 | **回退现有表单**（零行为变化）。读取失败不得阻断。 |
| `manual_select = 1` | 仍走表单（用户明确要手动选）。 |
| `manual_select = 0` 且 `default_associate = 0` | 直接 bypass（不注入，等同 asset_confirm 选"否"）。 |
| `manual_select = 0` 且 `default_associate = 1`，`default_team_id`+`default_agent_id` 均在用户可见 teams 中校验通过 | **直接登记**，跳过所有表单。 |
| `manual_select = 0`、`default_associate = 1`，但只有 team（缺 agent）或某步缺省/校验失败 | 弹**缺失的那一级**表单；已确定的 team 自动带过（复用 headerAutoSelect 的 `resolvePresetIdentity` 校验语义）。 |

> 复用点：现有 `resolvePresetIdentity(teams, preset)` 天然支持"只给 team→只弹 agent"这类部分预选，直接借用即可，不另写校验。

### 3.3 MemoryPanel：用户设置界面

新增"会话初始化默认值"设置区（可并入现有成员设置页或独立卡片）：

- **是否需要手动选择**：滑块（on/off ⇔ 1/0）。
- **默认是否关联团队资产**：滑块（on/off ⇔ 1/0）。
- **默认关联团队**：下拉框（读 `/team/list`，展示当前用户可见团队），含一个"未指定"空选项。
- **默认关联 Agent**：下拉框（读 `/agent/list?team_id=<所选team>`，展示该团队下 agent），含一个"未指定"空选项。

后端（panel）：新增路由调 `/v3/meta/config/user/get` 与 `/v3/meta/config/user/set`，带当前登录用户身份与 `assertCallerIsOwner` 权限校验，保证只能改自己。

### 3.4 错误处理与防御

- 配置读取失败（kernel 不可达 / HTTP 错 / 无该用户）→ 一律**回退现有表单流程**，绝不让 session-init 因配置读取而卡死或盲登记。
- 校验不通过（如用户配的 team/agent 已不在其可见列表）→ 视同"未指定"，弹对应级别表单（同现有 mismatch 语义）。
- `setUserConfig` 只允许管理员超管 / 用户本人（内核 `assertCallerIsOwner` 已保证）。

### 3.5 测试覆盖

- **MemoryCore 单测**：`session_init` 模块注册表加载、参数校验、user 覆写 global、`setUserParam` 的 `0/1` 布尔校验。
- **proxy 单测**：CB 与 CC 状态机在"未配置/manual_select=1/manual_select=0×各种缺省"下的走向断言（intercepted vs bypass vs direct-register）。
- **端到端**：面板配好后开新会话，确认不再弹 asset_confirm（default_associate=1+team+agent）；未配置用户开新会话仍弹表单（回归）。
- **边界**：default_associate=0 直接 bypass；只配 team 不配 agent 只弹 agent 那一级。

---

## 四、范围与边界（In Scope / Out of Scope）

**In scope**
- MemoryCore 注册表新增 `session_init` module（4 参数）。
- MemoryProxy：`MetadataClient.getUserConfig` + CB/CC 两个状态机决策接入。
- MemoryPanel：新增"会话初始化默认值"设置页（滑块 + 下拉 + agent 空选项）。

**Out of scope**
- 修改六个客户端的 form 载体/渲染层（经 index.ts 外层重渲染复用，无需改动）。
- 新引入独立的"用户偏好"表/模块（复用现有 ConfigParam 机制）。
- 改变任何未配置用户的既有行为。
- Task 级别的默认关联（本次只做 team/agent；task 沿用现有 `defaultTaskId` 兜底）。

---

## 五、评审决策（2026-09-07 已确认）

以下三项为评审后固化的最终决策，实施计划以此为准：

1. **默认值校验**：面板层做**下拉白名单**（UI 只能从"当前用户可见且真实存在"的团队/Agent 列表里选，杜绝键盘敲非法值）＋ 内核 `config/user/set` 兜底存在性校验。真正安全网放在**"用前检查"**：session-init 实际用默认值前，proxy 会将该值对应当前用户可见 teams 重新核验，对不上（如团队/Agent 被删除或权限被收回）→ 回退弹表单，绝不盲登记。
2. **本次仅做每用户**，不做团队级 global 默认值。参数仍声明 `["global","user"]` 双作用域以留口子；`ConfigParamService.getEffectiveParam` 的用户优先/global 兜底已天然支撑，将来需要时补注册表 + 管理员入口即可，不推翻现有实现。
3. **只配 `default_team_id`、缺 `default_agent_id`**：弹 **Agent 单级表单**（复用 `resolvePresetIdentity` 的"只给 team→只问 agent"语义），不自动选第一个 agent——agent 有职能差异，猜错代价高于多问一步。团队/Agent 都未配 → 照常全问。