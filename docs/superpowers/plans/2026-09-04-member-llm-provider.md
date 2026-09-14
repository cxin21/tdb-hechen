# 成员自定义 LLM Provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个成员/Agent 在 Memory Hub UI 里自定义自己的 LLM 供应商(OpenAI 兼容 URL + APIKey + 默认模型),proxy 在转发时按身份(用户级默认 + Agent 级覆盖)命中并代管 Key,覆盖所有客户端 handler。

**Architecture:** proxy 自有 `llm_provider` 存储(SQLite,按 `(subject_type, subject_id)` 唯一)+ 新增 `/v3/admin/llm-providers` 路由(用**用户自己的 user_key** 鉴权 + 归属校验)+ 在所有 4 类 handler 的"转发上游"缝上插入统一的 `resolveMemberUpstream`,命中时覆盖转发目标 url/apiKey/model,未命中走原逻辑。MessagePanel 的 Memory Hub UI 新增 "LLM Provider" 页面做自助读写。

**Tech Stack:** Node.js 20+ / TypeScript(E SM)/ Hono / better-sqlite3 / vitest / tsx。MemoryProxy 用 `npm test`(vitest)、`npm run typecheck`。不引入新依赖。

**Spec:** `docs/superpowers/specs/2026-09-04-member-llm-provider-design.md` —— 本计划依据该 spec;执行者需同时阅读 spec 与本文档。

## Global Constraints

- **不提交 git**:本仓库为本地部署环境,任何任务终端步骤**不得 `git commit`**。用"运行测试/typecheck + 本地重启生效"代替。
- 覆盖所有客户端:OpenAI `/chat/completions`(dsh/openclaw/hermes/pi/cursor/opencode)、Anthropic `/messages`(claude-code)、OpenAI `/responses`(codex)、workbuddy —— 四类 handler 都必须接入同一覆盖。
- 不引入跨协议互译(与官方一致);claude/codex 需成员为其配协议兼容的 upstream URL。
- 成员 provider 为 OpenAI 兼容端点;URL 不带末尾 `/v1` 时由现有上游拼接逻辑处理(与 `upstream.url` 同规则)。
- embedding / 记忆提炼 / wiki 分析不按成员隔离(非目标)。
- 未配置的成员/Agent 行为与现状完全一致(回落全局 upstream)。

---

### Task 1: `llm_provider` 存储 + 仓储 + TTL 缓存

**Files:**
- Create: `MemoryProxy/src/member-llm/types.ts`
- Create: `MemoryProxy/src/member-llm/provider-repo.ts`
- Create: `MemoryProxy/src/member-llm/provider-cache.ts`
- Create: `MemoryProxy/src/member-llm/index.ts`(工厂,`getLlmProviderStore(config)`)
- Test: `MemoryProxy/src/member-llm/__tests__/provider-repo.test.ts`

**Interfaces:**
- Consumes: `ProxyConfig`(`src/types.ts`)、现有 storage 工厂(`src/rate-limit/guard.ts` 的 `getRateLimitStore` 模式)、`assertKeySegment`(`src/storage/key-utils.ts`)。
- Produces:
  ```ts
  // provider-repo.ts
  export interface LlmProvider {
    subject_type: "user" | "agent";
    subject_id: string;
    url: string;
    apiKey: string;
    model: string;
    created_by: string;
    created_at: string;
    updated_by: string;
    updated_at: string;
  }
  export interface LlmProviderStore {
    get(type: "user" | "agent", id: string): Promise<LlmProvider | null>;
    set(entry: LlmProvider): Promise<void>;
    del(type: "user" | "agent", id: string): Promise<void>;
    list(type: "user" | "agent"): Promise<LlmProvider[]>;
  }
  // provider-cache.ts —— 内存 TTL 缓存
  export class LlmProviderCache {
    constructor(ttlMs?: number);
    get(type: string, id: string): LlmProvider | null;
    set(type: string, id: string, entry: LlmProvider): void;
    invalidate(type: string, id: string): void;
    invalidateAll(): void;
  }
  // index.ts
  export function getLlmProviderStore(config: ProxyConfig): LlmProviderStore & { cache: LlmProviderCache };
  ```

- [ ] **Step 1: 参考 rate-limit/guard.ts 先确认 storage 装配方式**

Read `src/rate-limit/guard.ts`(getRateLimitStore 怎么拿到底层 ProxyStorage)与 `src/db/schema.ts`、`src/db/binding-repo.ts`(一个现成 repo 怎么写 CRUD + key 前缀)。`llm-provider` 落 `nottl/` 前缀(永久保留,丢则用户需重配),key 布局:`nottl/<spaceId>/llm-provider/<type>/<id>`(参照 `sessionBindingDirOf`,同 spaceId 语义)。

- [ ] **Step 2: 写失败测试**(`provider-repo.test.ts`,vitest)

```ts
import { describe, it, expect } from "vitest";
import { getLlmProviderStore } from "../index.js";
import type { ProxyConfig } from "../../types.js";

function config(): ProxyConfig {
  return { ...defaultProxyConfig(), storage: { enabled: true, backend: "memory" } } as ProxyConfig;
}

describe("LlmProviderStore", () => {
  it("stores and retrieves by (type, id)", async () => {
    const store = getLlmProviderStore(config());
    await store.set({ subject_type: "user", subject_id: "usr-a", url: "http://a/v1", apiKey: "k", model: "m1", updated_at: "t" });
    const got = await store.get("user", "usr-a");
    expect(got?.url).toBe("http://a/v1");
    expect(got?.model).toBe("m1");
  });
  it("returns null for missing entry", async () => {
    const store = getLlmProviderStore(config());
    expect(await store.get("agent", "agt-x")).toBeNull();
  });
  it("deletes an entry", async () => {
    const store = getLlmProviderStore(config());
    await store.set({ subject_type: "user", subject_id: "usr-a", url: "u", apiKey: "k", model: "m", updated_at: "t" });
    await store.del("user", "usr-a");
    expect(await store.get("user", "usr-a")).toBeNull();
  });
});
```

先确认 `defaultProxyConfig` 的实际导出名(`src/config.ts` 是 `DEFAULT_CONFIG`),测试里用它构造 base config;storage backend 用 `"memory"`(进程内,单测不落盘)。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- src/member-llm/__tests__/provider-repo.test.ts -t LlmProviderStore`(在 `MemoryProxy/` 下)
Expected: FAIL —— `getLlmProviderStore` 未定义。

- [ ] **Step 4: 实现 store + cache**

`provider-repo.ts`:实现 `LlmProviderStore` 接口,底层复用与 `getRateLimitStore` 相同的 ProxyStorage 读写(`getRaw`/`putRaw`/`del`/`listNames`,以 `binding-repo.ts` 实际暴露的方法为准),`nottl/` 前缀。`provider-cache.ts`:单字段 map + `Date.now()`/`performance.now()` TTL 判定。`index.ts` 聚合 store + cache 并返回 `{ ...store, cache }`;同一 `(type,id)` 缓存 miss 时回源 store、命中写缓存。

- [ ] **Step 5: 运行测试通过**

Run: `npm test -- src/member-llm/__tests__/provider-repo.test.ts`
Expected: PASS(3 条)。

- [ ] **Step 6: typecheck + 本地生效验证**

Run: `npm run typecheck`(在 `MemoryProxy/`)
Expected: 无新错误。改动后 `D:\TDB\start-all.cmd` 重启,`/health` 正常(确认 storage 表初始化不报错)。

---

### Task 2: `/v3/admin/llm-providers` 路由(用户级自我服务)

**Files:**
- Create: `MemoryProxy/src/routes/llm-providers.ts`
- Modify: `MemoryProxy/src/server.ts`(注册路由,参照现有 `/v3/admin/rate-limits` 的注册处)
- Modify: `MemoryProxy/src/config.ts` 或 `src/member-llm/index.ts`(把 agent 归属判定所需的 MetadataClient 装配进 handler)
- Test: `MemoryProxy/src/routes/__tests__/llm-providers.test.ts`

**Interfaces:**
- Consumes:`verifyUserKey`(`src/auth.ts:70`)、`MetadataClient`(`src/meta/client.ts:225`)、`LlmProviderStore`(Task 1)。
- Produces:路由处理器 `createLlmProviderHandlers(config, ctx)`,含 `list/scoped`、`put`、`delete`;归属判定 helper `isAgentOwnedByUser(client, userId, agentId): Promise<boolean>`(导出,供 Task 4 复用)。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { createLlmProviderHandlers } from "../llm-providers.js";

it("rejects user writing another user's provider", async () => {
  // 用内存 storage 起 handler;mock verifyUserKey 返回 usr-a、subject_id=usr-b
  const res = await handlers.put(authCtx("usr-a"), { subject_type: "user", subject_id: "usr-b", url: "u", apiKey: "k", model: "m" });
  expect(res.status).toBe(403);
});
```

(完整的路由用 hono 的 `app.request()` 集成测;`verifyUserKey` 与 `MetadataClient` 通过依赖注入进 handler,便于单测 mock。)

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/routes/__tests__/llm-providers.test.ts`
Expected: FAIL(collected 未实现)。

- [ ] **Step 3: 实现鉴权 + 归属 + CRUD**

```ts
// 伪代码骨架(真实实现照此)
export function createLlmProviderHandlers(config, deps: { verify, isAgentOwnedByUser }) {
  return {
    // GET /v3/admin/llm-providers?scope=me → 该用户 user 级 + 其 agents 级
    async scoped(c, authUserId) { ... return ok({ user: await store.get("user", id), agents: [...] }); },
    // PUT → 校验 subject 归属后 store.set
    async put(c, authUserId) {
      const { subject_type, subject_id, url, apiKey, model } = await parseBody(c);
      if (subject_type === "user" && subject_id !== authUserId) return forbidden(c);
      if (subject_type === "agent" && !(await deps.isAgentOwnedByUser(authUserId, subject_id))) return forbidden(c);
      validateFields(title over url非空且为合法http(s)URL、apiKey/model非空);
      await store.set({ subject_type, subject_id, url, apiKey, model, updated_at: new Date().toISOString() });
      store.cache.invalidate(subject_type, subject_id);   // 下一次请求立即生效
      return ok(c, { subject_type, subject_id });
    },
    async del(c, authUserId) { /* 同归属校验 + store.del + cache.invalidate */ },
  };
}
```

鉴权:每次请求从 `Authorization: Bearer <user_key>` 取 key → `verifyUserKey(userKey, spaceId)` → `userId`;`userId==""` 或 `rejected` → 401。spaceId 从请求路径取(与主链路一致)。
归属判定 `isAgentOwnedByUser`:遍历 `listTeams(userId)` 得 team 集,对每个 team `listAgents(teamId)`(或 `getAgent(agentId)` 比对归属字段),目标 agent_id 落在并集内即属主(以 spec §5 为准)。参考 `meta/client.ts` 现有方法确认精确字段。

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- src/routes/__tests__/llm-providers.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 重启生效**

Run: `npm run typecheck`;`D:\TDB\start-all.cmd` 重启 proxy。
Expected: 无新错误;`curl -X POST http://127.0.0.1:8420/health` 正常。

---

### Task 3: `resolveMemberUpstream`(路由解析 + 模型替换)

**Files:**
- Create: `MemoryProxy/src/member-llm/resolver.ts`
- Test: `MemoryProxy/src/member-llm/__tests__/resolver.test.ts`

**Interfaces:**
- Consumes:`LlmProviderStore`(Task 1)、`TdaiIdentity`(`src/tdai/identity.ts`,含 `userId`/`agentId`)、`ProxyConfig`。
- Produces:
  ```ts
  export interface MemberUpstream { url: string; apiKey: string; model: string; }
  export async function resolveMemberUpstream(store, identity: { userId?: string|null; agentId?: string|null }): Promise<MemberUpstream | null>
  export function applyMemberModel(body: Record<string,unknown>, upstream: MemberUpstream): void  // 命中时把 body.model 替换为 upstream.model
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("agent override beats user default", async () => {
  const store = seeded({ user: ["usr-a", uUrl, uModel], agent: ["agt-9", aUrl, aModel] });
  expect(await resolveMemberUpstream(store, { userId: "usr-a", agentId: "agt-9" }))
    .toEqual({ url: aUrl, apiKey: aKey, model: aModel });
});
it("falls back to user default when agent not configured", async () => { /* ... */ });
it("returns null when neither configured", async () => {
  expect(await resolveMemberUpstream(emptyStore, { userId: "usr-x", agentId: "agt-y" })).toBeNull();
});
it("applyMemberModel replaces body.model only when hit", () => {
  const body = { model: "client-model" };
  applyMemberModel(body, { url: "u", apiKey: "k", model: "server-model" });
  expect(body.model).toBe("server-model");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/member-llm/__tests__/resolver.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 优先级:先 `store.get("agent", agentId)`,命中直接返回;否则 `store.get("user", userId)`,命中返回;否则 null。
- 走 store 缓存(命中则直接返回缓存值,不回源)。
- `applyMemberModel` 只改 `body.model` 顶层字段,不动其它。

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- src/member-llm/__tests__/resolver.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`。Expected: 无新错误。

---

### Task 4: 接入全部 handler

**Files:**
- Modify: `MemoryProxy/src/handler.ts`(OpenAI 主路径;覆盖 dsh/openclaw/hermes/pi/cursor/opencode)
- Modify: `MemoryProxy/src/anthropicHandler.ts:1195-1203`(claude-code)
- Modify: `MemoryProxy/src/codexHandler.ts:1083-1084`(codex)
- Modify: `MemoryProxy/src/workbuddyHandler.ts:489-494`(workbuddy)
- **Interfaces:** 消耗 Task 3 的 `resolveMemberUpstream`/`applyMemberModel` 与 Task 1 的 `getLlmProviderStore`。

所谓"在缝上":每处现有解析已读 `config.upstream.agents?.[agentFromPath]`(handler.ts:1285, anthropicHandler:1199, codexHandler:1083, workbuddyHandler:494)得到 `agentUpstreamEntry`。在其**之前**插入成员级解析:

```ts
const memberUpstream = sessionInfo ? await resolveMemberUpstream(store, {
  userId: userId || undefined,
  agentId: (sessionInfo as { agent_id?: string })?.agent_id,
}) : null;

// 若有成员覆盖:它的 url/apiKey 优先于上面算出的 agentUpstreamEntry / 全局
const effectiveTarget = memberUpstream
  ? { url: memberUpstream.url, apiKey: memberUpstream.apiKey }
  : { url: agentUpstreamEntry?.url ?? config.upstream.url, apiKey: agentUpstreamEntry ? (agentUpstreamEntry.apiKey ?? "") : config.upstream.apiKey };

// model 替换(仅 openai/responses 协议有 body.model;anthropic 用 body.model 同样适用 —— 以各 handler 实际字段为准)
if (memberUpstream) applyMemberModel(body, memberUpstream);
```

- [ ] **Step 1: 先精确确认 4 处局部变量名**

分别在 4 个文件先确认:`agentFromPath`、`userId`、`sessionInfo`/`custom.session`、转发的 `defaultUpstreamUrl`/`apiKey` 变量实际名与作用域(handler.ts:641/673/1057,I 已确认;s 各 handler 照 `grep` 定位),确保插入点变量可见。

- [ ] **Step 2: 在 OpenAI 主路径(handler.ts)接入**

在 `handler.ts:1285 agentUpstreamEntry` 解析之前插入上段逻辑;让 `resolveForwardTarget` 的 `defaultUpstreamUrl` 与最终 `Authorization` 用 `effectiveTarget`;命中时对 `body` 做 `applyMemberModel`。仅当 `memberUpstream` 非 null 才覆盖,否则该 handler 行为逐字不变。

- [ ] **Step 3: 接入 anthropicHandler / codexHandler / workbuddyHandler**

三个 handler 各插入同款解析与覆盖(协议各自。anthropic 用其 body/model 字段;codex/workbuddy 用各自转发目标构建处)。成员未命中 → 与现状一致。

- [ ] **Step 4: typecheck + 单元回归**

Run: `npm run typecheck`;`npm test`(全量,确认无既有用例被破坏)。
Expected: 全部通过。

- [ ] **Step 5: 本地重启冒烟**

`D:\TDB\start-all.cmd` 重启后,未配 provider 的旧成员(用现有 `sk-mem-4LyIhMj-...` 的 dsh)发一句话 → 仍走全局 new-api/scm-flash,命令日志显示注入/转发正常。

---

### Task 5: Memory Hub UI —— "LLM Provider" 页面

**Files:**
- Explore: `MemoryPanel/web`(前端源码,先看 `listDirectoryTree` 找"设置/API Key"类页面的路由与表单组件模式)
- Create: `MemoryPanel/web/src/pages/LlmProvider.tsx`(或按面板现有页面目录约定放置)
- Modify: `MemoryPanel/web/src/.../routes` 注册入口 + 侧边栏菜单项
- **Interfaces:** 消耗 proxy 的 `GET/PUT/DELETE /v3/admin/llm-providers`(Task 2)。UI 用一个固定 service-id(= 当前登录实例的 spaceId)+ 成员自己的 user_key(面板会话已登录,取面板内部可用的 user_key 调 proxy;若面板无 user_key,则让用户在页面填自己的 user_key,见下方 Step 3)。

- [ ] **Step 1: 摸清 MemoryPanel 前端结构**

`MemoryPanel` 前后端结构:跑 `memorypanel` 目录,列出 `web/src` 的页面/路由/菜单(`glob` 或 `listDirectoryTree`),找一个现有"读改写设置"的页面作模板(例如实例/API Key 页),确认:
- 前端如何发请求到后端端口(axios/fetch + 统一 client);
- 面板后端如何转发到 proxy(是否存在现成的 proxy 控制器,便于给 `llm-providers` 加一个转发端点)。

- [ ] **Step 2: 面板后端加一个透传端点(到 proxy)**

若面板现无直调 proxy 的通道,在面板后端新增一个内网转发 endpoint(如 `POST /api/llm-providers/proxy/:verb`),把面板会话携带的 user_key + 实例 spaceId 透传去调 `http://127.0.0.1:8096/v3/admin/llm-providers`。切记:**不要**在面板前端硬编码共享 admin secret;用登录用户自己的 user_key。

- [ ] **Step 3: 前端页面**

新建 "LLM Provider" 页,含:
- 当前用户的默认 Provider 表单(url / apiKey / model,保存/清除);
- 该用户"属于自己的 Agent"列表(来自面板现有的 `listAgents(userId)` 接口),每个可单独保存/清除自己的 Provider;
- 未配置项按解析优先级(agent>user>全局)提示:agent 卡未配且用户已设默认 → "将沿用我的默认";否则/用户卡 → "走团队/全局默认"。
- 保存后调用上述端点 `PUT`,成功后刷新。
- apiKey 输入用 password 类型;页面上明文显示与否跟随面板现有密钥展示约定。

- [ ] **Step 4: 手动功能验证**

面板 → LLM Provider 页:给当前用户配一个自选 OpenAI 兼容 URL+key+model;用该用户的 dsh 发消息 → `MemoryProxy/logs/proxy.log` 确认转发目标为成员 URL、`Authorization` 为成员 key、`model` 为成员模型。

---

### Task 6: 端到端集成 + 回归

**Files:**
- Test: `MemoryProxy/src/routes/__tests__/llm-providers.integration.test.ts`(可选,若依赖真实 core 则标注仅本地跑)
- 只改测试文件;无生产代码改动。

- [ ] **Step 1: 成员 A/B 隔离验证**

面板配两个用户各自的 provider;分别用各自 user_key 的 dsh 各发一句话;确认日志显示各自转发到各自的 url+key+model,**互不串**。

- [ ] **Step 2: 越权验证**

用户 A 尝试 `PUT /v3/admin/llm-providers` 设用户 B 的 user 级或 B 的 agent 级 → 期望 403;设自己的 → 200。

- [ ] **Step 3: 未配置回落验证**

未配 provider 的成员发话 → 走全局 new-api/scm-flash,行为与改造前一致。

- [ ] **Step 4: 上游不可达验证**

配一个错误/不可达的成员 URL → 发话 → 期望连接失败报错给客户端(不静默回落全局)。

- [ ] **Step 5: typecheck + 全量测试**

Run: `npm run typecheck` 与 `npm test`(在 `MemoryProxy/`)。
Expected: 全部通过,且 `D:\TDB\logs\proxy.log` 无新增 error 级噪音。

## 交付说明

- 本计划不包含任何 `git commit` 步骤(需求方明确:当前项目不提交 git,仅本地修改)。
- 每任务终端验证 = 运行测试 + `npm run typecheck` + 需要时 `D:\TDB\start-all.cmd` 本地重启。
- 若在实现中发现某处存储/MetadataClient 方法与本计划标注的"以实际文件为准"不一致,以工作区源码为准并顺延本任务(JSDoc 已给出搜索目标)。