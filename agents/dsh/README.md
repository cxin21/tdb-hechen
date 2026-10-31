# DeepSeek Harness (dsh)

> agentSource: `dsh` | 协议: **Anthropic Messages**（v0.2+，主口径） / OpenAI Chat Completions（v0.1.x 兼容） | Handler: `anthropicHandler.ts`（v0.2+，与 CC 共享） / `handler.ts`（v0.1，与 CB 共享）
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

> ⚠️ **2026-09-29 上游大改**：dsh 自 `v0.2.0-rc.1` 起把 LLM adapter 从 OpenAI Chat 换成
> Anthropic Messages，配置入口也从 `~/.dsh/settings.yaml` 迁到 profile 下的 cordis patch。
> 老姿势（dsh v0.1.x + `settings.yaml`）在 v0.2 上**boot 不起来**，见 §0 迁移表。
>
> ⚠️ **本仓实现状态**：客户端 v0.2 的接入姿势（§1）以下按上游口径写；但本仓 Proxy 侧的
> anthropic 配套尚未落地，标准 preset 的 v0.2 会话会在 session-init 阶段失败，
> 详见 §0.2。v0.1.x 链路仍然完整可用。

---

## 0. dsh v0.1 → v0.2 迁移（2026-09-29 起）

### 0.1 配置纵向对比

同一件事在两个大版本下写法完全不同，老脚本生成的那套在 v0.2 里 **boot 不起来**
（loader 不认 `settings.yaml` 的 shape，plugin id 也换了名）。

| 项 | dsh v0.1.x（老） | **dsh v0.2+（现在）** |
|---|---|---|
| 配置入口文件 | `~/.dsh/settings.yaml`（top-level plugin 段） | `~/.dsh/profiles/web/cordis.patch.yml`（loader patch 数组） |
| Plugin id | `@deepseek-ai/dsh-llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek-api-key` |
| 协议 | OpenAI Chat Completions | **Anthropic Messages** |
| 请求端点 | `${baseURL}/chat/completions`（**不带 /v1**） | `${baseURL}/v1/messages`（**必带 /v1**） |
| Anthropic 头 | 无 | `anthropic-version: 2023-06-01` 固定发 |
| 用户输入载体 | `content: string`（裸文本） | `content: [{type:"text",text}, ...]`（block array） |
| Tool result 载体 | `role:"tool" + tool_call_id`（消息级） | `role:"user" + content[].type:"tool_result"`（block 级） |
| Credential 存法 | `settings.yaml` 平铺 | `~/.dsh/.credentials.yaml` 的 `refs:` 段（chmod 600 硬要求） |
| build 要求 | `npm install` 即可 | 建议 `git pull && pnpm install && pnpm run build`（rc 迭代快） |

> 「尾巴带不带 `/v1`」的结论**反了**：v0.1 时 baseURL 不能带 `/v1`（客户端拼
> `${baseURL}/chat/completions`）；v0.2 时 baseURL 仍然**不能带** `/v1`——因为 anthropic
> adapter 内部自己拼 `${baseURL}/v1/messages`。带成 `.../v1` 会 double 成 `/v1/v1/messages`。

### 0.2 本仓 Proxy 侧支持状态（据实）

路由层已接受 v0.2 的 anthropic 路径（`MemoryProxy/src/server.ts`）：

| 路径 | 注册处 | 走的 handler |
|---|---|---|
| `POST /dsh/:spaceId/v1/messages` | `:360` 通用 `/:agent/:spaceId/v1/messages` | `handleAnthropicMessages` |
| `POST /dsh/:spaceId/messages` | `:325`（V12-DSH-SSE-FIX，2026-09-26） | `handleAnthropicMessages` |
| `POST /dsh/:spaceId/v1/messages/count_tokens` | `:361` 通用 aux 路由 | `handleAuxiliaryEndpoint` |
| `POST /dsh/:spaceId[/v1]/chat/completions` | `:319-320`（v0.1 兼容） | `handleChatCompletions` |
| `POST /dsh/:spaceId/v1/{embeddings,completions,moderations}` | `:327-329` | `handleAuxiliaryEndpoint` |

但 **dsh 语义层的 anthropic 分支还没移植**，标准 preset 的 v0.2 会话会在 session-init
阶段失败（现状见下表；上游在 `TencentCloud/TencentDB-Agent-Memory#1733` 跟踪同类缺陷，本仓尚未建对应票）：

| 位置 | 现状 | 后果 |
|---|---|---|
| `src/session/dsh/form.ts` | 只有 OpenAI SSE builder（`REASONING_PLACEHOLDER`，:79），无 anthropic 分支 | anthropic 客户端解不出 form；`anthropicHandler.ts:860-862` 会把该 OpenAI 帧原样返回 |
| `src/session/dsh/form.ts:81-82` | `ASSET_CONFIRM_YES = "是,关联团队资产"`（**半角逗号**） | 与 CB extractor 的全角 `是，关联团队资产` 对不上 → 答完循环弹表单 |
| `src/agent-adapters/dsh.ts` | `classifyRequest` / `extractUserText` 只认 v0.1 wire shape（:72-111） | v0.2 的 `body.system` + block array 下 title-gen 判不出、用户文本提不出 |
| `src/anthropicHandler.ts` | 缺 dsh 专属的 SSE 收尾修复 | 严格 parser 可能报 `STREAM_CLOSED` |

结论口径：
- **v0.1.x 客户端**：按 §1.7 配，全链路（form / 注入 / 归档 / mem 命令）可用。
- **v0.2+ 客户端**：按 §1 配，**连通与透传可用**，但交互式 session-init 表单不可用
  （表现为弹不出、选了不生效、或整轮断流）；等 §0.2 表里 4 处移植完成后再按「自动弹表单」口径验收。
  在此之前可让 dsh 走 headless / PTC preset 路径（tools 中无 `ask_user_question`，见 §3.5）。

### 0.3 从 v0.1 迁到 v0.2 的 3 步

1. **拉最新 dsh**：`cd deepseek-harness && git pull && pnpm install && pnpm run build`（至少 `v0.2.0-rc.1`）
2. **备份 + 换配置**：
   ```bash
   TS=$(date +%Y%m%d_%H%M%S)
   cp ~/.dsh/settings.yaml     ~/.dsh/settings.yaml.bak.$TS 2>/dev/null
   cp ~/.dsh/.credentials.yaml ~/.dsh/.credentials.yaml.bak.$TS
   # 再按 §1.1 / §1.2 重写 cordis.patch.yml + .credentials.yaml refs 段
   ```
3. **对齐 Proxy 侧**：本仓需先补上 §0.2 的 4 处 anthropic 配套（form builder / extractor / 分类 / SSE 收尾），
   否则 v0.2 会依次踩：表单解不出 → 循环弹表单 → 答复读不到 → 注入不生效 → 断流。

---

## 1. 客户端接入配置（dsh v0.2+）

### 1.1 profile patch 文件

`~/.dsh/profiles/web/cordis.patch.yml`（profile 名默认 `web`，`dsh web` 启动时用）：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    apiKeyEnv: PROXY_USER_KEY
    # ⚠️ 不带 /v1 —— dsh anthropic adapter 内部拼 ${baseURL}/v1/messages
    baseURL: http://<proxy-host>:8096/dsh/<spaceId>
    reasoningEffort: high
    models:
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro
        contextWindow: 128000
        maxTokens: 8192

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: high
```

### 1.2 credential 文件

`~/.dsh/.credentials.yaml`（**必须 chmod 600**）：

```yaml
version: 1
refs:
  PROXY_USER_KEY: <业务用户的 sk-mem-... user_key>
```

### 1.3 权限硬要求（dsh 启动时校验）

```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

### 1.4 请求路径

v0.2+ 的 adapter 硬编码 `${baseURL}/v1/messages` + `anthropic-version: 2023-06-01`。
Proxy 侧命中（见 §0.2 表）：

- `POST /dsh/:spaceId/v1/messages` —— **主路径**
- `POST /dsh/:spaceId/v1/messages/count_tokens` —— 辅助端点

### 1.5 启动 & 验证

```bash
cd /path/to/deepseek-harness
git pull                      # 至少到 v0.2.0-rc.1
pnpm install && pnpm run build
pnpm dsh web --no-open --port 3081 --host 127.0.0.1
# → dsh web: http://127.0.0.1:3081/?token=xxx
```

浏览器打开该 URL，发一句 "hi"，Proxy 应返回 session-init 表单（见 §3；本仓 v0.2 表单
支持待 §0.2 的配套移植）。

### 1.6 桌面版客户端（DeepSeek Harness Desktop）

桌面版（Electron 壳 + Node Host 子进程）在 LLM 协议层与 CLI/Web 版等价——`packages/llm/*`
代码共用，外壳不参与 LLM 出站 fetch。差异只在「设置 → 模型」的入口。

三张卡里**只能走第二张**：

| 卡片 | 内部 plugin | 协议 | proxy 适配 |
|---|---|---|---|
| ① DeepSeek 账号 | `@deepseek-ai/dsh-llm-deepseek-account` | Anthropic Messages | ❌ 不带 `x-deepseek-harness-*` 头，不是接入形态 |
| ② **DeepSeek (deepseek-official)** | `@deepseek-ai/dsh-llm-deepseek-api-key` | Anthropic Messages | ✅ **只配这一张**（全套 `x-deepseek-harness-*` 头） |
| ③ 自定义设置 / 添加模型提供商 | `@deepseek-ai/dsh-llm-pi-ai` | 三选一 | ❌ pi-ai adapter 过滤掉 `x-deepseek-harness-*` 头 → session_id 丢失 |

配置步骤：点第二张卡的「编辑」→ API 密钥填 `user_key`（与 `.credentials.yaml` 里
`PROXY_USER_KEY` 同一个）→ 展开「自定义设置」，baseURL 填
`http://<proxy-host>:8096/dsh/<spaceId>`（**不要带 `/v1`**）→ 保存。

### 1.7 v0.1.x 旧口径（保留兼容）

`~/.dsh/settings.yaml`：

```yaml
llm-deepseek:
  apiKeyEnv: PROXY_USER_KEY
  # v0.1：客户端拼 ${baseURL}/chat/completions，所以也不能带 /v1
  baseURL: http://127.0.0.1:8096/dsh/default
  reasoningEffort: high
```

`~/.dsh/.credentials.yaml` 为平铺写法：

```yaml
PROXY_USER_KEY: <业务用户的 sk-mem-... user_key>
```

请求路径：`POST /dsh/:spaceId/chat/completions`（主）、`POST /dsh/:spaceId/v1/chat/completions`。

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

**发 header 的条件**：dsh 源码只在调用方传了 `options.sessionId` 时才发，`undefined` 不发。
dsh Web UI 主对话每轮都传；title-gen / compaction 等辅助请求也带（compaction 额外带
`x-deepseek-harness-compact: 1`）。

⚠️ **陷阱**：baseURL 不要配到 `/claude-code/<spaceId>`（蹭 CC 路由）。那样 proxy 会按
`agentSource=claude-code` 走 CC 的 form/extractor，`ask_user_question` schema 对不上，
客户端报 "unknown tool"。永远走独立的 `/dsh/*`。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

dsh 在标准 preset（web-app / cordis / standard 等）里自动挂 `@deepseek-ai/dsh-tool-ask-user`
（`packages/interaction/tool-ask-user/src/index.ts`），给主对话 tools 加一个
`ask_user_question`。Proxy 复用这个原生 tool 名造假 tool_use：

- Tool name：**`ask_user_question`**（snake_case，与 CC 的 PascalCase `AskUserQuestion` 完全不同）
- Tool call id prefix：`call_dsh_session_init_`
- 传输：v0.2+ = **Anthropic SSE**（`message_start → thinking → tool_use → message_stop`）；
  v0.1.x = OpenAI `chat.completion.chunk`（由 `FormData.protocol` 分派）

### 3.2 ask_user_question schema（dsh 硬约束，与 CC 不兼容）

```jsonc
{
  "questions": [
    {
      "id": "asset_confirm",       // dsh 必填，answer 里原样回传
      "question": "本次对话是否要关联团队资产?",
      "header": "关联资产",
      "options": [
        { "label": "是，关联团队资产", "description": "..." },
        { "label": "否，本次不关联",   "description": "..." }
      ],
      "multi_select": false          // snake_case，不是 multiSelect
    }
  ]
}
```

tool_result 回传（anthropic 下塞在 `role:"user"` 的 `content[]` 里 `type:"tool_result"` block）：

```jsonc
{
  "answers": [
    { "id": "asset_confirm", "selected": ["是，关联团队资产"], "custom": "..." }
  ]
}
```

`selected[]` 是**选中的 option label 字符串数组**（不是索引）；`custom` 是 "Other" 里输入的
自由文本（含 skip 关键字兜底判据）。

### 3.3 状态机

复用 CB 状态机（`src/session/codebuddy/init.ts`）：

```
uninitialized → pending_asset_confirm → pending_team_select →
pending_agent_task → (可选)pending_task_select → initialized
```

- CB / WB / dsh / opencode / codex 共用这条状态机
- 差异（form shape / 传输协议 / tool 名）在 `src/session/index.ts` 里按
  `agentSource === "dsh"` 分支重渲染 `result.response`（`:194-211`）
- dsh 独立文件在 `src/session/dsh/`（form.ts / `__tests__`）

### 3.4 分页

dsh 的 `ask_user_question` UI 无 options 数量上限，因此 dsh form **不分页**，
team/agent/task 全量塞。对比：CC 硬限 ≤4 options 必须分页。

### 3.5 Headless Bypass

dsh 有独特的 headless bypass：

- 检查 `body.tools` 数组
- 如果非空但**不包含** `ask_user_question` → 判定 headless，完全跳过 session-init 直接透传

用于 API 直调 / batch 模式（有自定义 tools 但无交互 tool）。同族还有两个旁路：

- **one-shot 子 agent**：spawn 的子 agent 会挂 `ask_user_question` 声明但无运行时处理器，
  tools 启发式失效；改用 system prompt 里的 `[[one-shot-subagent]]` 显式标记跳过。
- **PTC / code-mode**：tools 只有 `run_code`、无 `ask_user_question`。本仓用用户级
  `session_init` 配置代供身份（`src/session/dsh-ptc-preset.ts`）：配齐 team + agent 且通过
  kernel 校验才放行登记，否则维持 bypass。**红线：绝不对 PTC 弹表单**（fake form tool_call
  会被 dsh agent-loop 判 unknown tool 直接抛错）。

### 3.6 thinking block 必填（anthropic 分支）

DeepSeek 官方 anthropic 兼容端点在 thinking mode 下**硬校验**历史 assistant 必须带
`thinking` block，否则 400 `The content[].thinking in the thinking mode must be passed
back to the API`。v0.2 的假 session-init 响应需要无条件 emit 空 thinking + placeholder
signature block。

OpenAI 分支同款问题走 `reasoning_content` 占位（`src/session/dsh/form.ts:79`
`REASONING_PLACEHOLDER`）。

⚠️ 本仓目前只有 OpenAI 分支的占位实现，anthropic 的 thinking placeholder 未落地（见 §0.2）。

### 3.7 跳过 Session Init

三种方式：
1. Headless bypass（tools 中无 `ask_user_question`）→ 自动跳过
2. 用户输入 "跳过" / "skip" 走 `custom` 字段
3. 在 asset_confirm 选"否，本次不关联"

### 3.8 首次会话 —— 选 Team → Agent → Task

启动 Web UI（见 §1.5），发一句话（比如 "hi"），Proxy 返回 4 步按钮式表单：

1. "是否关联团队资产？" —— 选 **是** 关联注入，选 **否** 直接透传
2. Team 选择器（只有一个 team 时自动跳过）
3. Agent 选择器
4. Task 选择器（首项是虚拟 **"本次不关联任务"**）

选完后 Agent 会做一次自我介绍，之后每轮都自动注入 `<session_context>` +
`<available_skills>` + `<tdai_profile_memory>` 等块。`mem:help` / `mem:sync` /
`mem:create-skill` 等命令在 init 完成后可用。

---

## 4. 请求分类

dsh 用独立分类逻辑（`src/agent-adapters/dsh.ts`）：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| **compact** | `x-deepseek-harness-compact: 1` header | 辅助请求，跳过注入 |
| **title-gen** | Body 特征三合一：无 tools + `thinking.type === "disabled"` + `max_tokens ≤ 128` + system 以 "Create a concise AI coding-assistant session" 开头 | 辅助请求，跳过注入 |
| **main** | 其他所有 | 完整链路 |

> 判据按 v0.1 wire shape 实现（`messages[0].role === "system"` + 字符串 content）。
> v0.2 的 anthropic body 把 system 放在 `body.system`、content 是 block array，
> 本仓尚未适配 → title-gen 会漏判成 main（见 §0.2）。

---

## 5. 用户文本提取

- **v0.1.x**：content 是纯字符串，无 `<user_query>` 包裹；取最后一条 user 的 content string。
- **v0.2+**：content 是 anthropic block array；form 答复要从 `content[]` 里
  `type:"tool_result"` 且 `tool_use_id` 前缀为 `call_dsh_session_init_` 的 block 里读，
  fallback 到最后一条 user 的 text block（`src/session/codebuddy/cleaner.ts`
  `getLastUserMessageText`）。

⚠️ 本仓 `dshAdapter.extractUserText`（`src/agent-adapters/dsh.ts:108-111`）只接受字符串，
block array 直接返回 null → mem 命令识别不出（见 §0.2）。

---

## 6. 注入 Profile

session-init 完成后，Proxy 在**请求的 system 段末尾**追加：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
<available_skills>...</available_skills>
<tdai_profile_memory>...</tdai_profile_memory>
```

注入点：
- **v0.2+**（anthropic）：`body.system`（`anthropicHandler` 的 `systemAppend` 合并进 body.system）
- **v0.1.x**（openai）：`messages[0].content`（system message 字符串内追加）

---

## 7. 特殊行为

- **协议**：v0.2+ = Anthropic Messages（硬发 `anthropic-version: 2023-06-01`）；
  v0.1.x = OpenAI Chat。Proxy 按路径 `/v1/messages` vs `/v1/chat/completions` 分派到
  `handleAnthropicMessages` 或 `handleChatCompletions`
- **Client 指纹 Header**：
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`（无条件发，匿名 id 或登录账户 id）
  - `x-deepseek-harness-session-id`（有 `options.sessionId` 才发）
  - `x-deepseek-harness-compact: 1`（compaction 场景）
- **Thinking mode**：assistant 带 `thinking` block（anthropic）或 `reasoning_content`
  字段（openai），proxy 的 fake session-init 响应必须匹配上游硬校验（见 §3.6）
- **ask_user_question schema 与 CC 完全不兼容**：tool 名蛇形、`id` 必填、返回 array（见 §3.2）

---

## 8. 归档触发

- 与 CB / CC 共享归档机制（`anthropicHandler` / `handler` 都调 `triggerArchiveHooks`）
- 对话超阈值自动 `skill/conversation/add`
- 支持 `skill/conversation/force-archive`

---

## 9. 环境变量

无 dsh 专属变量。上游路由动态决定（一般指向 DeepSeek API；v0.2 是
`https://api.deepseek.com/anthropic`）。

---

## 10. 常见问题

**Q: 为什么 baseURL 明明「不带 /v1」，请求却是 `/v1/messages`？**  
A: v0.2 的 anthropic adapter 内部自己拼 `${baseURL}/v1/messages`。baseURL 再带 `/v1`
会 double 成 `/v1/v1/messages`。v0.1 时代「不带 /v1」的理由是另一个：客户端拼
`${baseURL}/chat/completions`。两代都别带 `/v1`，但原因不同。

**Q: v0.2 发 "hi" 弹不出表单 / 选了没反应？**  
A: 本仓 Proxy 侧的 anthropic form 分支尚未移植，见 §0.2。

**Q: headless bypass 什么时候触发？**  
A: `body.tools` 非空但不含 `ask_user_question` 时。典型场景：API 直调、batch、PTC
code-mode 会话（只有 `run_code`）。

**Q: `x-deepseek-harness-compact` header 是什么？**  
A: 客户端做 compaction 时带；proxy 识别后跳过注入/归档，直接透传上游做压缩。

**Q: 为什么需要 `reasoning_content` / `thinking` 占位？**  
A: DeepSeek thinking mode 对 assistant 消息格式有硬校验，proxy 生成的 session-init
form 也是 assistant 消息，所以必须带占位（OpenAI 用 `reasoning_content`，Anthropic 用
`thinking` + signature）。

---

## 11. 与 Claude Code / CodeBuddy / Codex 的差异

| 维度 | Claude Code | CodeBuddy | Codex | **dsh** |
|---|---|---|---|---|
| 协议 | Anthropic Messages | OpenAI Chat | OpenAI Responses | **Anthropic Messages（v0.2+）** / OpenAI Chat（v0.1.x） |
| 配置文件 | 环境变量 | `~/.codebuddy/models.json` | `~/.codex/config.toml` | **`~/.dsh/profiles/web/cordis.patch.yml`** + `.credentials.yaml`（v0.1 为 `settings.yaml`） |
| URL 前缀 | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` | **`/dsh/<spaceId>`** |
| Key 传递 | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` | `.credentials.yaml` 的 `refs:`（v0.1 平铺） |
| Session init | 自动弹表单 | 自动弹表单 | 首次需切 Plan 模式 | 自动弹表单（本仓 v0.2 待 §0.2 配套） |
| UI 表单 tool | `AskUserQuestion` | `ask_followup_question` | fake `function_call` | **`ask_user_question`**（dsh 原生） |
| Wire 特殊 | cache_control markers | 无 | encrypted rs_id | **thinking block / `reasoning_content` 必带**（Proxy 自动处理） |

---

## 12. 当前状态

- ✅ v0.1.x（OpenAI Chat）链路完整：配置 → session-init form → 注入 → 归档 → mem 命令
- ✅ v0.2+ 路由已接受 anthropic 路径（`/v1/messages`、`/v1/messages/count_tokens`），透传可用
- ⚠️ v0.2+ 的 session-init form / 分类 / 文本提取 / SSE 收尾尚未移植（见 §0.2）
- ⚠️ 生产环境暂未大规模使用 v0.2 接入
