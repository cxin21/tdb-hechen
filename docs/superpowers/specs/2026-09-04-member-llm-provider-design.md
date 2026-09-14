# 成员自定义 LLM Provider —— 设计文档

- 日期:2026-09-04
- 状态:草案(待评审)
- 影响范围:`MemoryProxy`(路由+存储+admin API)、`MemoryPanel`(Memory Hub UI)、`core`(只读:归属校验)

---

## 0. 背景与目标

当前 TDB 的 LLM 网关(`MemoryProxy :8096`)把所有 Agent/成员的主对话请求都转发到**同一个固定上游**:

```
upstream.url   = http://10.11.64.103:8888/v1   (new-api)
upstream.apiKey = sk-...
model          = scm-flash
```

上游解析目前只在"URL 路径前缀 `/{agent}/{spaceId}/...`"这一层(`upstream.agents[agentName]`)做协议级区分,**不区分到底是谁(哪个成员/哪个 Agent)在调用**。所有成员、所有 Agent 共用同一个 LLM 供应商与 Key。

**目标**:让每个成员/Agent 可以自定义自己的 LLM 供应商(OpenAI 兼容端点的 URL + APIKey + 默认模型名),由 proxy 在转发时按身份命中并代管 Key,Key 不落客户端、成员不改本机 dsh/claude 配置。

## 1. 需求要点(已与需求方确认)

| 维度 | 结论 |
| --- | --- |
| 路由粒度 | **用户级默认 + Agent 级覆盖**(双层) |
| Key 模型 | **服务端保存**:成员在 Memory Hub UI 填 URL+APIKey+模型,proxy 代管并注入 |
| 生效范围 | **仅主对话大模型**;向量 embedding、记忆提炼、wiki 分析等后台仍用服务器自带端点 |
| 模型名处理 | 成员的"默认模型名"由 proxy 替换客户端请求里的 `model` 字段 |
| 管理权/权限 | **自助**:每个用户只能改**自己的** user 级 Provider 和**属于自己的** Agent 的 Provider |
| 客户端覆盖 | **所有客户端**:dsh / openclaw / hermes / pi / cursor / opencode(OpenAI `/chat/completions`)、claude-code(Anthropic `/messages`)、codex(OpenAI `/responses`)、workbuddy —— 统一在各自 handler 的转发缝上按成员覆盖 |
| 协议处理 | **与官方一致**:不新增跨协议互译。成员覆盖是一个扁平 `{url, apiKey, model}`(同官方 `upstream.agents` 一张表);OpenAI 协议客户端直接用成员 URL;claude/codex 按官方规则需各自兼容上游(成员为对应客户端配兼容 URL 即可) |
| 向后兼容 | 未配置 Provider 的成员/Agent 自动回落当前全局上游(不改行为) |
| 交付约束 | **本仓库不提交 git,仅在本地修改**(与现有 40 处本地改动一致的本地部署环境) |

## 2. 方案(采用:方案 A)

**proxy 自有 Provider 存储 + proxy admin API + Memory Hub UI 页面**。路由逻辑与数据同处 proxy,零 core 写耦合;有现成先例(`rate-limits` 即"外部写入 → proxy 自存 SQLite → 下一次请求生效")。

> 备选方案 B(core 元数据加字段)留档:架构更贴合"资产"哲学,但要改 core schema + 元数据 API + panel,改动面大,且 LLM 上游非 core 领域。本轮不采用。

## 3. 架构与数据流

```
成员(浏览器)
  │
  ▼
Memory Hub UI(MemoryPanel :8123)
  │  登录(用自己的 user_key)
  │  GET  /v3/admin/llm-providers?subject=user&id=<uid>        ┐ 读/写
  │  PUT  /v3/admin/llm-providers {subject_type, subject_id,   │ (鉴权=user_key)
  │        url, apiKey, model}                                  ┘
  ▼
MemoryProxy :8096
  │  auth: verifyUserKey(请求的 user_key) → user_id
  │  归属校验:subject_type=agent → 校验该 agent 属于该 user(查 core metadata)
  │  写入 proxy SQLite:llm_provider 表
  │
  │  线上转发:
  │  dsh/claude-code/codex/workbuddy → handler
  │   resolveMemberUpstream(user_id, agent_id, sessionInfo)
  │   ├─ (1) agent_id 命中 → 用 agent 的 {url, apiKey, model}
  │   ├─ (2) user_id 命中  → 用 user 的 {url, apiKey, model}
  │   └─ (3) 都未命中      → 现有 upstream.agents[agentFromPath] / upstream.url+apiKey
  │   命中时:替换转发目标 url / Authorization Bearer / body.model
  └──► 成员自选 OpenAI 兼容上游
```

### 3.1 路由解析优先级(高→低)

1. `agent_id` 命中 Provider 表 → 用该 Agent 的 `{url, apiKey, model}`
2. `user_id` 命中 Provider 表 → 用该用户的 `{url, apiKey, model}`
3. 未配置 → 维持现有:`upstream.agents[agentFromPath]` → `upstream.url/apiKey`(全局兜底)

用户在面板没配 Provider → 自动回落当前 new-api/scm-flash,**老成员零改动**。

### 3.2 接线点(所有客户端)

在**所有 handler** 的"转发上游"解析处插入同一覆盖逻辑(共同核心是 `src/handler.ts` 的 OpenAI 主路径):

- `src/handler.ts` — OpenAI `/chat/completions`(dsh / openclaw / hermes / pi / cursor / opencode)
- `src/anthropicHandler.ts` — Anthropic `/messages`(claude-code)
- `src/codexHandler.ts` — OpenAI `/responses`(codex)
- `src/workbuddyHandler.ts` — workbuddy

每处现有解析都形如 `config.upstream.agents?.[agentFromPath]`(handler.ts、anthropicHandler:1195-1203、codexHandler:1083-1084、workbuddyHandler:489-494)。新增统一的 `resolveMemberUpstream(userId, agentId, sessionInfo, config)`:

- 命中成员覆盖 → 返回 `{url, apiKey, model}` 并覆盖该 handler 的转发目标 + `Authorization` + `body.model`。
- 未命中 → 返回 null,走现有逻辑(零侵入)。
- 关键输入此时都已可用:`userId`(auth 已解析)、`sessionInfo.agentId`(session-init 已选)。
- 协议兼容同官方:openai 协议直接用成员 URL;claude/codex 由各自的 handler 用功耗同成员 URL 转发,协议不符则与官方一致需兼容上游。

### 3.3 性能/一致性

- 按 `user_id`、`agent_id` 各做 TTL 缓存(与 binding 缓存同刻逻辑,约 30s),每次转发从缓存取;TTL 过期或显式 `clear` 后重拉。
- 成员改配置后"下一次请求生效",无需重启 proxy(对齐 rate-limits 语义)。

## 4. 数据模型

**存储介质(经 captain 裁决 2026-09-04,修 F1/F2 矛盾):** 用 **ProxyStorage KV `nottl/` 命名空间**承载(与 rate-limits / binding / session 现有仓储同层,遵循现成抽象),**不新建 SQLite 表**。每个 `(subject_type, subject_id)` 组合唯一对应一条 JSON 记录;`nottl` 前缀保证永久保留(丢则成员会静默回落全局上游、行为漂移,不可接受)。Key 布局:

```
nottl/_default/llm-provider/<type>/<id>.json
```

记录字段(**含审计列,均 NOT NULL;`created_* / updated_* / updated_by` 由写接口用认证用户填充**):

```json
{
  "subject_type": "user" | "agent",
  "subject_id": "...",
  "url": "...",
  "apiKey": "...",
  "model": "...",
  "created_by": "...",
  "created_at": "...",
  "updated_by": "...",
  "updated_at": "..."
}
```

- 复合主键 `(subject_type, subject_id)` 唯一:同键写入即覆盖(set 即 upsert)。
- `apiKey` 与系统现有 key 处理一致(`systemUsers`/`upstream.apiKey` 均为明文落库);后续如需加固再加 AES(本轮非目标)。

## 5. 管理面(Memory Hub UI 集成)

- 在 **MemoryPanel(8123)的 Memory Hub UI** 新增 **"LLM Provider"** 页面:
  - 顶部:当前登录用户的自有 Provider(编辑 URL/APIKey/模型)。
  - 下方:该用户**拥有的** Agent 列表(来自 `listAgents(userId)`),每个可单独覆盖。
  - 未配置项按解析优先级(agent>user>全局)提示并可编辑/保存/清除:
    - **Agent 卡**未配时:先提示"将沿用我的默认"(若当前用户已设 user 级默认),否则提示"走团队/全局默认"。
    - **用户卡**(无更上层)未配时:提示"走团队/全局默认"。
- **权限(self-service)**:
  - 写 API 鉴权用**用户自己的 `user_key`**(不是共享 admin secret)。
  - proxy 在写接口上做归属校验,"属于自己的 Agent"**与 UI 用同一判定**:即 `listAgents(认证 user_id)` 返回的 agent 集合(该 user 所属团队内按 user 维度过滤所得)视为该 user 归属。判定与 UI 展示一致,避免"UI 能选、API 却 403":
    - `subject_type=user`:仅允许 `subject_id == 认证 user_id`。
    - `subject_type=agent`:该 agent_id 必须在 `listAgents(认证 user_id)` 中,否则 403。
    - 归属为静态快照即可(写时校验一次);`listAgents` 走现有 MetadataClient,复用 session-init 同款调用。
  - admin shared secret 保留,仅用于运维级跨用户覆盖(本轮非目标,不实现)。

## 6. API 草案(proxy)

```
GET  /v3/admin/llm-providers?subject_type=user&subject_id=<uid>        # 读某个
GET  /v3/admin/llm-providers?scope=me                                  # 读我(user + 我的 agents)
PUT  /v3/admin/llm-providers
     { subject_type, subject_id, url, apiKey, model }
DELETE /v3/admin/llm-providers?subject_type=...&subject_id=...
```

- 鉴权:`Authorization: Bearer <user_key>` → `auth/verify` → 取 `user_id` → 归属校验。
- 这些是**成员自服务**接口;运维级写作单独 admin secret(非目标)。

## 7. 错误处理

- 成员配了 Provider 但上游不可达 → 按现有上游转发逻辑,连接失败即返回错误给客户端,**不静默回落**到全局(避免"以为用了自己的 LLM,实际用了全局")。
- 无效的 subject / 越权访问 → 403;字段缺失/非法 URL → 400。
- TTL 缓存 miss → 拉库,拉不到则回落现有逻辑。

## 8. 测试

### 单元
- 路由优先级:agent 覆盖 > user 覆盖 > 全局兜底;三种都不配时的默认行为。
- `model` 替换:命中后 body.model 被替换,未命中保持原样。
- 缓存 TTL:命中/过期/显式 clear。
- 归属校验:user 只能写自己的 user 或自己的 agent;越权 403。

### 集成
- `curl` 写 provider(`PUT /v3/admin/llm-providers`)→ dsh 发一条 → 抓包确认 `Authorization`、目标 URL、`model` 都变成成员配置。
- 成员 A、B 各配不同 provider → 同一 proxy 分别转发到各自上游,互不串。

### 回归
- 未配 provider 的成员 → 行为与今日完全一致(全局 new-api/scm-flash)。

## 9. 非目标(Non-Goals)

- **不引入跨协议互译**(与官方一致;claude/codex 需各自协议兼容的上游,由成员为其配兼容 URL)。
- 成员 Provider 的用量计费(`creditPricing` 只对已知 model 计;新 provider 的 model 默认计费 0)。
- 向量 embedding / 记忆提炼 / wiki 分析按成员隔离(保持共用)。
- Provider 密钥加密存储(AES)。
- 运维级跨用户统一管理界面。

## 10. 迁移

- 新增表,空跑即兼容旧实例;`start-all.cmd` 重建后 `/health` 正常即可。
- 无存量三表结构变更。

## 11. 待实现清单(供 writing-plans 使用)

- MemoryProxy:`llm_provider` 表 + repo + TTL 缓存。
- MemoryProxy:`/v3/admin/llm-providers` 路由(鉴权 = user_key + 归属校验)。
- MemoryProxy:`resolveMemberUpstream` 并接入**全部 handler**(`handler.ts`/`anthropicHandler`/`codexHandler`/`workbuddyHandler`)。
- MemoryPanel:在 Memory Hub UI 新增 "LLM Provider" 页面 + 调 proxy 的 admin API。
- 单元 + 集成 + 回归测试(覆盖所有 handler 协议)。

> 交付约束:本仓库不提交 git,仅在本地修改(本地部署环境)。