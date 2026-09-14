# 用户级会话初始化解愤怒默认配置（User Session-Init Preset）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个用户在 Memory hub UI 配置"会话初始化的关联默认值"（是否手动选、默认是否关联、默认团队、默认 Agent），proxy 在 session-init 时按配置自动处理，未配置用户行为零变化。

**Architecture:** 复用 MemoryCore 已有的每用户 ConfigParam 注册表机制（新增 `session_init` module、4 个 user 作用域参数），MemoryProxy 在两个状态机的 `uninitialized` 分支新增"读用户配置→决策"块（新增强类型参数 + 纯决策函数 + 复用 `resolvePresetIdentity`），MemoryPanel 复用现有 `userConfigApi`/`SettingsDialog` 前端仅新增一个 Tab。

**Tech Stack:** TypeScript (ESM), Hono, vitest, tea-component, React, pnpm workspace（td-agemem 内三子包）。

**Spec:** `docs/superpowers/specs/2026-09-07-user-session-init-preset-design.md`（本计划论证依据，执行者必须先读。）

## Global Constraints

以下约束来自 spec，逐条抄录，所有任务隐含遵守：

- 参数全部 `user` 作用域（`allowed_scopes: ["global","user"]`），用户值优先、global 兜底（现有 `getEffectiveParam` 机制，零改动）。
- 四个参数名 `manual_select` / `default_associate` / `default_team_id` / `default_agent_id`；布尔参数默认 `"1"`，接受 `"0"|"1"`。
- **未配置用户（读取失败/参数未设置/uninitialized 无 userId）→ 一律回退现有交互表单，零行为变化**；读取失败绝不让 session-init 卡死或盲登记。
- 决策表（spec §5 已定案）：
  - `manual_select` 生效值 != "0" → `ask`（弹表单）。
  - `manual_select = "0"` 且 `default_associate = "0"` → `bypass`（不注入）。
  - `manual_select = "0"`、`default_associate` != "0"、default_team_id 非空 → `preset {teamId, agentId?}`，交由既有 `resolvePresetIdentity` 校验登记。
  - 只有 team 缺 agent → 走 `advanceFromTeamPicked`（只弹 agent 级表单）；team 也缺 → `ask`（全问）。
- 面板端 UI：开关用滑块（`Switch`），`manual_select`/`default_associate` 不用手填 0/1；默认团队/Agent 用**下拉框**（展示当前用户可见列表，含一个"未指定"空选项），杜绝键盘敲非法值。
- **本次仅做每用户**，不做团队级 global 默认（spec §5 决策 2）。

---

### Task 1: MemoryCore 注册 `session_init` 参数模块

**Files:**
- Modify: `MemoryCore/src/metadata/config/metadata_config_params.json`

**Interfaces:**
- Consumes: 现有注册表机制（`config-param-service.ts::getEffectiveParam` / `setUserParam` / `initDefaults`）。
- Produces: 新增 module `session_init`，四个 `user` 作用域参数——下游 Task 2/3 的 proxy 通过 `config/user/get` 读它们的 `effective_value`。

- [ ] **Step 1: 在 `modules` 数组末尾追加 `session_init` module**

在 `metadata_config_params.json` 的 `asset_type` 模块之后追加：

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

注意：保留 `asset_type` 模块结尾的逗号，整个文件必须是合法 JSON。

- [ ] **Step 2: 写注册表加载单测（含新模块断言）**

Create `MemoryCore/src/metadata/config/session-init-registry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { loadDefaultRegistry } from "./param-registry.js";

describe("session_init config params registry", () => {
  const reg = loadDefaultRegistry();
  const mod = reg.get("session_init");

  it("registers the session_init module with 4 user-scope params", () => {
    expect(mod).toBeDefined();
    expect(mod!.params.map((p) => p.param_name)).toEqual([
      "manual_select",
      "default_associate",
      "default_team_id",
      "default_agent_id",
    ]);
    for (const p of mod!.params) {
      expect(p.allowed_scopes).toContain("user");
    }
  });

  it("keeps boolean params defaulting to 0/1 and id params defaulting to empty", () => {
    const manual = mod!.params.find((p) => p.param_name === "manual_select")!;
    const team = mod!.params.find((p) => p.param_name === "default_team_id")!;
    expect(["0", "1"]).toContain(manual.param_value);
    expect(team.param_value).toBe("");
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --dir MemoryCore test -- --run src/metadata/config/session-init-registry.test.ts`
Expected: 2 pass（`loadDefaultRegistry` 成功加载、`session_init` 模块存在、4 参数 user 作用域）。

- [ ] **Step 4: 提交**

```bash
git add td-agemem/MemoryCore/src/metadata/config/metadata_config_params.json td-agemem/MemoryCore/src/metadata/config/session-init-registry.test.ts
git commit -m "feat(memory-core): register session_init per-user config params"
```

> 说明：`initDefaults` 在服务启动时幂等种子化 global 默认值（spec §2.2），无需本任务改代码；已有实例升级后首次启动会自动补齐该 module 的 global 行。

---

### Task 2: MemoryProxy —— MetadataClient 增加读用户 session 配置方法

**Files:**
- Modify: `MemoryProxy/src/meta/client.ts`（在 `listTeams` 附近新增方法）

**Interfaces:**
- Consumes: 现有 `MetadataClient.fetch<T>(path, body)` 私有方法、`CoreSkillConfig`、内核 `/v3/meta/config/user/get` 端点（schema 已在 `v3-meta-schemas.ts`，任务 1 注册后该 module 可被读取）。
- Produces: `MetadataClient.getUserSessionConfig(userId): Promise<Record<string,string>>`（返回 param_name→effective_value），供 Task 3 决策块使用。

- [ ] **Step 1: 写使用示例 + 类型导入**

在 `MemoryProxy/src/meta/client.ts` 顶部 import 区（现有类型区）新增返回类型：

```ts
/** /v3/meta/config/user/get 返回的单一配置项（含生效值，用户优先→global 兜底）。 */
export interface UserConfigViewItem {
  module: string;
  param_name: string;
  param_key: string;
  description: string;
  effective_value: string;
}

/** /v3/meta/config/user/get 的 data 信封。 */
export interface UserConfigViewEntity {
  user_id: string;
  module: string;
  module_description: string;
  items: UserConfigViewItem[];
}
```

- [ ] **Step 2: 新增公开方法 `getUserSessionConfig`**

在 `MetadataClient` 类内（`listTeams` 方法之后）新增：

```ts
  /**
   * 读取指定用户在某个 module 下的配置生效值（用户优先→global 兜底），
   * 返回 param_name → effective_value 的映射。用于 session-init 读取
   * 每用户的 session_init（manual_select / default_associate / team / agent）默认值。
   *
   * 权限：内核 config/user/get 强制 assertCallerIsOwner——本 client 已用调用方
   * 自己的 user_key 鉴权，故 userId 必须 == 该 user_key 对应的用户（proxy 侧
   * 保证传 session 认证出的 userId）。
   */
  async getUserSessionConfig(userId: string, module: string): Promise<Record<string, string>> {
    const view = await this.fetch<UserConfigViewEntity>(
      "/v3/meta/config/user/get",
      { user_id: userId, module },
    );
    const out: Record<string, string> = {};
    for (const item of view.items) {
      out[item.param_name] = item.effective_value;
    }
    return out;
  }
```

- [ ] **Step 3: 新增单测（mock fetch）**

Create `MemoryProxy/src/meta/__tests__/getUserSessionConfig.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { MetadataClient } from "../client.js";

function makeClient(respond: (body: Record<string, unknown>) => unknown) {
  const fetcher = (async (_url: unknown, init?: { body?: string }) => {
    const parsed = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: respond(parsed) }),
    } as Response;
  }) as typeof fetch;
  return new MetadataClient(
    { endpoint: "http://x", serviceToken: "s", timeoutMs: 1000 },
    "svc",
    "user-key",
    fetcher,
  );
}

describe("MetadataClient.getUserSessionConfig", () => {
  it("POSTs /v3/meta/config/user/get with user_id+module and maps items to effective_values", async () => {
    let sent: Record<string, unknown> | null = null;
    const client = makeClient((body) => {
      sent = body;
      return {
        user_id: body.user_id,
        module: body.module,
        module_description: "会话初始化关联默认值",
        items: [
          { module: "session_init", param_name: "manual_select", param_key: "session_init.manual_select", description: "", effective_value: "0" },
          { module: "session_init", param_name: "default_team_id", param_key: "session_init.default_team_id", description: "", effective_value: "t-1" },
        ],
      };
    });
    const result = await client.getUserSessionConfig("usr-1", "session_init");
    expect(sent).toEqual({ user_id: "usr-1", module: "session_init" });
    expect(result).toEqual({ manual_select: "0", default_team_id: "t-1" });
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir MemoryProxy test -- --run src/meta/__tests__/getUserSessionConfig.test.ts`
Expected: 1 pass。

- [ ] **Step 5: 提交**

```bash
git add td-agemem/MemoryProxy/src/meta/client.ts td-agemem/MemoryProxy/src/meta/__tests__/getUserSessionConfig.test.ts
git commit -m "feat(memory-proxy): MetadataClient.getUserSessionConfig for per-user session_init defaults"
```

---

### Task 3: MemoryProxy —— 新增纯决策函数 `resolveUserSessionInitPreset`

**Files:**
- Create: `MemoryProxy/src/session/user-session-init-preset.ts`
- Test: `MemoryProxy/src/session/__tests__/user-session-init-preset.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MetadataClient.getUserSessionConfig`；spec §5 决策表。
- Produces: 纯函数 `resolveUserSessionInitPreset(config: Record<string,string> | null): UserInitDecision`，其中：
  - `type UserInitDecision = { kind: "ask" } | { kind: "bypass" } | { kind: "preset"; teamId: string; agentId?: string }`。
  - 纯函数可独立单测，不依赖网络。

- [ ] **Step 1: 写纯决策函数**

Create `MemoryProxy/src/session/user-session-init-preset.ts`：

```ts
/**
 * 用户级 session_init 配置的纯决策逻辑（spec §5 决策表）。
 *
 * 输入是 Task 2 getUserSessionConfig 返回的 { param_name: effective_value }，
 * 输出一个三态决策，供 CB / CC 状态机在 asset_confirm 前消费：
 *   - ask    → 回退现有交互表单（未配置 / manual_select=1 / 缺 team）
 *   - bypass → default_associate=0，直接不关联
 *   - preset → 带 team（可带 agent）的预设身份，复用 resolvePresetIdentity 校验登记
 *
 * 纯函数，无副作用；读取失败场景（config 传 null）由调用方兜底转 ask。
 */

export type UserInitDecision =
  | { kind: "ask" }
  | { kind: "bypass" }
  | { kind: "preset"; teamId: string; agentId?: string };

export const SESSION_INIT_MODULE = "session_init";

export function resolveUserSessionInitPreset(
  config: Record<string, string> | null,
): UserInitDecision {
  // 读取失败 / 未配置 → 零行为变化：ask
  if (!config) return { kind: "ask" };

  // manual_select 生效值（默认 "1"）。非 "0" 一律仍手动选。
  const manualSelect = config["manual_select"];
  if (manualSelect !== "0") return { kind: "ask" };

  // manual_select=0：看默认是否关联。
  const associate = config["default_associate"];
  if (associate === "0") return { kind: "bypass" };

  // 默认关联团队资产，但没配团队 → 无法定位，弹表单全问。
  const teamId = (config["default_team_id"] ?? "").trim();
  if (!teamId) return { kind: "ask" };

  const agentId = (config["default_agent_id"] ?? "").trim();
  return { kind: "preset", teamId, agentId: agentId || undefined };
}
```

- [ ] **Step 2: 写单测覆盖决策表各分支**

Create `MemoryProxy/src/session/__tests__/user-session-init-preset.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveUserSessionInitPreset } from "../user-session-init-preset.js";

describe("resolveUserSessionInitPreset", () => {
  it("null config → ask (zero-change)", () => {
    expect(resolveUserSessionInitPreset(null)).toEqual({ kind: "ask" });
  });

  it("manual_select default/absent-but-no-key effectively '1' → ask", () => {
    expect(resolveUserSessionInitPreset({})).toEqual({ kind: "ask" });
    expect(resolveUserSessionInitPreset({ manual_select: "1", default_associate: "1", default_team_id: "t" })).toEqual({ kind: "ask" });
  });

  it("manual_select=0 & default_associate=0 → bypass", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "0" })).toEqual({ kind: "bypass" });
  });

  it("manual_select=0 & associate!=0 but no team → ask", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1" })).toEqual({ kind: "ask" });
  });

  it("manual_select=0 & team set & no agent → preset team only", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1", default_team_id: "t-1" })).toEqual({ kind: "preset", teamId: "t-1" });
  });

  it("manual_select=0 & team+agent set → preset with both", () => {
    expect(resolveUserSessionInitPreset({ manual_select: "0", default_associate: "1", default_team_id: "t-1", default_agent_id: "a-1" })).toEqual({ kind: "preset", teamId: "t-1", agentId: "a-1" });
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --dir MemoryProxy test -- --run src/session/__tests__/user-session-init-preset.test.ts`
Expected: 6 pass。

- [ ] **Step 4: 提交**

```bash
git add td-agemem/MemoryProxy/src/session/user-session-init-preset.ts td-agemem/MemoryProxy/src/session/__tests__/user-session-init-preset.test.ts
git commit -m "feat(memory-proxy): pure session_init preset decision helper"
```

---

### Task 4: MemoryProxy —— CC（claude-code）状态机接入每用户配置

**Files:**
- Modify: `MemoryProxy/src/session/claude-code/init.ts`

**Interfaces:**
- Consumes: Task 2 `MetadataClient.getUserSessionConfig`、Task 3 `resolveUserSessionInitPreset` + `SESSION_INIT_MODULE`；现有 `resolvePresetIdentity`、`advanceFromTeamPicked`、`completeRegistration`（同文件内已存在）。
- Produces: CC 客户端在 `uninitialized` 且未走 header preset 时，按用户配置直接 bypass / 直接登记 / 只弹缺级，否则回退表单。

- [ ] **Step 1: 引入新依赖**

在 `MemoryProxy/src/session/claude-code/init.ts` 顶部 import 区新增：

```ts
import { resolveUserSessionInitPreset, SESSION_INIT_MODULE } from "../user-session-init-preset.js";
```

- [ ] **Step 2: 在 `uninitialized` 分支的 header-preset 块之后、写 `pending_asset_confirm` 之前插入用户配置分支**

定位 `if (presetIdentity && config.headerAutoSelect?.enabled) { ... }` 块结束到 `await store.set(compositeKey, { status: "pending_asset_confirm", ...` 之间。插入如下代码（紧接 header 块、在 `// 先弹 asset_confirm 对话框` 注释之前）：

```ts
    // ── 用户级 session_init 默认（spec §5：未配置/读取失败 → 表单，零变化）──
    if (!presetIdentity) {
      let decision: import("../user-session-init-preset.js").UserInitDecision = { kind: "ask" };
      try {
        const userCfg = await metadataClient.getUserSessionConfig(userId, SESSION_INIT_MODULE);
        decision = resolveUserSessionInitPreset(userCfg);
      } catch (err) {
        console.warn(
          `[session-init:cc] session=${compositeKey} user=${userId} session_init read failed → form fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (decision.kind === "bypass") {
        console.log(`[session-init:cc] session=${compositeKey} user=${userId} session_init → bypass (default_associate=0)`);
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, resetFlow: state?.resetFlow ?? false };
      }
      if (decision.kind === "preset") {
        const pr = resolvePresetIdentity(teams, { teamId: decision.teamId, agentId: decision.agentId });
        if (pr.hadMismatch) {
          console.warn(`[session-init:cc] session=${compositeKey} user=${userId} session_init preset mismatch → form`);
        } else if (pr.canRegister) {
          console.log(`[session-init:cc] session=${compositeKey} user=${userId} session_init preset team=${pr.teamId} agent=${pr.agentId ?? "-"} → register directly`);
          const seedState: SessionInitState = {
            status: "uninitialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            selectedTeamId: pr.teamId,
          };
          return completeRegistration(
            { agent_id: pr.agentId!, task_id: undefined },
            seedState, teams, pr.teamId, compositeKey, sessionKey, userId,
            config, store, reqCtx, stripped, metadataClient, userKey, spaceId,
          );
        } else if (pr.teamId) {
          const presetTeam = teams.find((t) => t.team_id === pr.teamId);
          if (presetTeam) {
            console.log(`[session-init:cc] session=${compositeKey} user=${userId} session_init preset team=${pr.teamId} → advance`);
            const seedState: SessionInitState = {
              status: "uninitialized",
              keyId: sessionKey,
              startedAt: Date.now(),
              attemptCount: 0,
              userId,
              cachedTeams: teams,
              selectedTeamId: pr.teamId,
            };
            return advanceFromTeamPicked(
              presetTeam, teams, compositeKey, sessionKey, userId,
              seedState, config, store, reqCtx, stripped,
              metadataClient, userKey, spaceId,
            );
          }
        }
        // 其余情况 fall through → 弹 asset_confirm（可跨分支检测到最终走表单）。
      }
      // kind === "ask" → 直接落到下方 pending_asset_confirm。
    }
```

> 关键点：整个读取包在 try/catch，任何失败都保持 `decision = { kind: "ask" }` 落入下方表单，满足"读取失败零行为变化"。`if (!presetIdentity)` 保证 header 预选优先、用户配置次之。

- [ ] **Step 3: 类型检查 + 全量单测回归**

Run: `pnpm --dir MemoryProxy typecheck`
Expected: tsc 无错。
Run: `pnpm --dir MemoryProxy test`
Expected: 既有用例全部通过、无回归。

- [ ] **Step 4: 提交**

```bash
git add td-agemem/MemoryProxy/src/session/claude-code/init.ts
git commit -m "feat(memory-proxy): apply per-user session_init preset in claude-code state machine"
```

---

### Task 5: MemoryProxy —— CB（codebuddy）状态机接入每用户配置

**Files:**
- Modify: `MemoryProxy/src/session/codebuddy/init.ts`

**Interfaces:**
- Consumes: Task 2 `MetadataClient.getUserSessionConfig`、Task 3 `resolveUserSessionInitPreset` + `SESSION_INIT_MODULE`；现有 `resolvePresetIdentity`、`advanceFromTeamPicked`、`completeRegistration`（同文件内存在；注意 CB 版本签名不完全同 CC——按本文件内的实际函数签名调用）。
- Produces: CB（及其复用的 codex / workbuddy / dsh / opencode）在 `uninitialized` 时按用户配置 bypass / 登记 / 只弹缺级，否则回退表单。

> 注意位置对齐：`codebuddy/init.ts` 的 header 块末尾在 ~833 行（`preset mismatch → fallback to form`），asset_confirm 写入在 ~895 行。插入点同 CC——header 块结束后、`status: "pending_asset_confirm"` 写入前。

- [ ] **Step 1: 引入新依赖**

```ts
import { resolveUserSessionInitPreset, SESSION_INIT_MODULE } from "../user-session-init-preset.js";
```

- [ ] **Step 2: 插入用户配置分支**

插入逻辑与 Task 4 相同，唯二区别：
1. `completeRegistration` / `advanceFromTeamPicked` 的调用按本文件 CA 原有签名（CB 的 `completeRegistration` 最后一个参数传 `messages` 而非 `stripped`，且签名带 `agentSource`——按本文件 header preset 块的实际调用方式复制）。
2. 返回对象可带 `justRegistered: true`（对齐本文件既有 CB 语义）。

在 CB 该分支插入：

```ts
    // ── 用户级 session_init 默认（spec §5）──
    if (!presetIdentity) {
      let decision: import("../user-session-init-preset.js").UserInitDecision = { kind: "ask" };
      try {
        const userCfg = await metadataClient.getUserSessionConfig(userId, SESSION_INIT_MODULE);
        decision = resolveUserSessionInitPreset(userCfg);
      } catch (err) {
        console.warn(
          `[session-init:cb] session=${compositeKey} user=${userId} session_init read failed → form fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (decision.kind === "bypass") {
        console.log(`[session-init:cb] session=${compositeKey} user=${userId} session_init → bypass (default_associate=0)`);
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
      }
      if (decision.kind === "preset") {
        const pr = resolvePresetIdentity(teams, { teamId: decision.teamId, agentId: decision.agentId });
        if (pr.hadMismatch) {
          console.warn(`[session-init:cb] session=${compositeKey} user=${userId} session_init preset mismatch → form`);
        } else if (pr.canRegister) {
          console.log(`[session-init:cb] session=${compositeKey} user=${userId} session_init preset team=${pr.teamId} agent=${pr.agentId ?? "-"} → register directly`);
          const seedState: SessionInitState = {
            status: "uninitialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            selectedTeamId: pr.teamId,
          };
          return completeRegistration(
            { agent_id: pr.agentId!, task_id: undefined },
            seedState, teams, compositeKey, sessionKey, userId,
            config, store, messages, metadataClient, userKey, spaceId,
          );
        } else if (pr.teamId) {
          const presetTeam = teams.find((t) => t.team_id === pr.teamId);
          if (presetTeam) {
            console.log(`[session-init:cb] session=${compositeKey} user=${userId} session_init preset team=${pr.teamId} → advance`);
            const seedState: SessionInitState = {
              status: "uninitialized",
              keyId: sessionKey,
              startedAt: Date.now(),
              attemptCount: 0,
              userId,
              cachedTeams: teams,
              selectedTeamId: pr.teamId,
            };
            // 按本文件 header preset 块实际签名推进；split stage 决策沿用 isCodexClient 逻辑。
            return advanceFromTeamPicked(
              presetTeam, teams, compositeKey, sessionKey, userId,
              seedState, config, store, messages, metadataClient, userKey, spaceId,
            );
          }
        }
      }
    }
```

> 若本文件 `advanceFromTeamPicked` 实际参数与上方不一致，以本文件 header preset team-only 分支（~861-891）的真实调用为准；关键是把"preset team → advance"和"preset team+agent → completeRegistration"两条路接对。

- [ ] **Step 3: 类型检查 + 全量单测回归**

Run: `pnpm --dir MemoryProxy typecheck`
Expected: tsc 无错。
Run: `pnpm --dir MemoryProxy test`
Expected: 既有用例全部通过。

- [ ] **Step 4: 提交**

```bash
git add td-agemem/MemoryProxy/src/session/codebuddy/init.ts
git commit -m "feat(memory-proxy): apply per-user session_init preset in codebuddy state machine"
```

---

### Task 6: MemoryPanel —— 前端新增"会话初始化默认值"设置 Tab

**Files:**
- Modify: `MemoryPanel/web/src/components/SettingsDialog.tsx`
- Modify: `MemoryPanel/web/src/lib/api/users.ts`（新增 `sessionInitApi`）
- Modify: `MemoryPanel/web/src/i18n/zh-CN.ts`、`MemoryPanel/web/src/i18n/en-US.ts`
- Modify: `MemoryPanel/web/src/lib/api/types.ts`（如 `Team`/`Agent` 类型已存在则无需改；仅补 `useSessionInitConfig` 用到的 shape）

**Interfaces:**
- Consumes: 现有后端 pass-through（`/api/v1/meta/config/user/*` 已在 `ALLOWED_PANEL_ACTIONS`，零后端改动）；现有 `userConfigApi.get/set(user_id, module, params)`；现有 `teamsApi.list`、`agentsApi.list`、`Switch`、`Select`、`getCurrentUser`、tea-component。
- Produces: SettingsDialog 新增"会话初始化默认值"Tab，含 2 个滑块（`manual_select`/`default_associate`）+ 2 个下拉（`default_team_id`/`default_agent_id`，带"未指定"空选项），保存走 `config/user/set`。

> 后端前置已满足：`config/user/get`、`config/user/set` 均在 `ALLOWED_PANEL_ACTIONS`（`meta-actions.ts:81-82`），前端 `userConfigApi` 已能读写。本任务纯前端。

- [ ] **Step 1: 在 `users.ts` 新增 session_init 专属 API**

在 `MemoryPanel/web/src/lib/api/users.ts` 的 `userConfigApi` 之后追加：

```ts
/** session_init module 下当前用户的默认配置（键盘不进，全靠滑块+下拉）。 */
export interface SessionInitConfig {
  manual_select: boolean;      // true=仍手动选；false=按默认自动关联
  default_associate: boolean;  // true=默认关联团队资产
  default_team_id: string;     // 空串=未指定
  default_agent_id: string;    // 空串=未指定
}

const SESSION_INIT_MODULE = "session_init";

function boolOrTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value === "1" || value.toLowerCase() === "true";
}

export const sessionInitApi = {
  /** 读当前用户 session_init 生效配置。 */
  get: async (): Promise<SessionInitConfig> => {
    const me = await getCurrentUser();
    const view = await userConfigApi.get(me.user_id, SESSION_INIT_MODULE);
    const byName = new Map(view.items.map((it) => [it.param_name, it.effective_value]));
    return {
      manual_select: boolOrTrue(byName.get("manual_select")),
      default_associate: boolOrTrue(byName.get("default_associate")),
      default_team_id: (byName.get("default_team_id") ?? "").trim(),
      default_agent_id: (byName.get("default_agent_id") ?? "").trim(),
    };
  },
  /** 写当前用户 session_init（params 只含改动项；id 传空串 = 未指定）。 */
  set: async (params: Partial<Record<"manual_select" | "default_associate" | "default_team_id" | "default_agent_id", string>>): Promise<void> => {
    const me = await getCurrentUser();
    await userConfigApi.set(me.user_id, SESSION_INIT_MODULE, params);
  },
};
```

> 导出：确认 `MEMORY_PANEL` 的导出链（`lib/api/users.ts` 的导出被 `lib/teamApi.ts` 汇总后再被组件引用）。若组件用的是 `@/lib/api/users` 直连，则直接从该文件 `export { sessionInitApi }`；若走 `@/lib/teamApi` 汇总，需同时在该汇总文件补 re-export。按项目现有引用方式接入。

- [ ] **Step 2: 扩展 SettingsDialog 增加 Tab 与控件**

修改 `MemoryPanel/web/src/components/SettingsDialog.tsx`：

1. 引入新依赖：
```ts
import { Select } from "tea-component";
import { sessionInitApi } from "@/lib/api/users";
import { teamsApi } from "@/lib/api/teams";
import { agentsApi } from "@/lib/api/agents";
```

2. 扩展 tab 枚举：
```ts
type SettingsTab = "permissions" | "sessionInit";
```
并把 `const activeTab: SettingsTab = 'permissions';` 改为可从 UI 切换（用一个 `useState<SettingsTab>('permissions')` 保存当前 tab），在 Modal 头部加两个 Tab 按钮（Segment 或 Button 切换）。

3. 新增一个 React 组件（可放在同一文件底部）`SessionInitPanel`，由 SettingsDialog 在 `activeTab === 'sessionInit'` 时渲染：

```tsx
function SessionInitPanel() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<SessionInitConfig | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, ts] = await Promise.all([sessionInitApi.get(), teamsApi.list()]);
      setCfg(c);
      setTeams(ts);
      // 首次按当前默认 team 拉 agents
      if (c.default_team_id) {
        setAgents(await agentsApi.list(c.default_team_id));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(patch: Partial<SessionInitConfig>, clearAgentOnTeamChange = false) {
    const next = { ...cfg!, ...patch };
    if (clearAgentOnTeamChange) next.default_agent_id = '';
    setCfg(next);
    setSaving(true);
    setError('');
    try {
      const params: Record<string, string> = {
        manual_select: next.manual_select ? '1' : '0',
        default_associate: next.default_associate ? '1' : '0',
        default_team_id: next.default_team_id,
        default_agent_id: next.default_agent_id,
      };
      await sessionInitApi.set(params);
      tea.notify.success(t('settings.sessionInit.saved'));
      if (clearAgentOnTeamChange && next.default_team_id) {
        setAgents(await agentsApi.list(next.default_team_id));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSaving(false);
    }
  }

  const teamOptions = [{ value: '', text: t('settings.sessionInit.noTeam'), disabled: false }].concat(
    teams.map((th) => ({ value: th.team_id, text: th.name })),
  );
  const agentOptions = [{ value: '', text: t('settings.sessionInit.noAgent'), disabled: false }].concat(
    agents.map((a) => ({ value: a.agent_id, text: a.name })),
  );

  return (
    <div style={{ paddingTop: 4 }}>
      <Text theme="label" style={{ display: 'block', marginBottom: 4 }}>{t('settings.sessionInit.title')}</Text>
      <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>{t('settings.sessionInit.desc')}</Text>
      {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
      {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 滑块：是否需要手动选择 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--tea-color-border-primary-default)', borderRadius: 6 }}>
          <div>
            <Text style={{ fontSize: 13, fontWeight: 500 }}>{t('settings.sessionInit.manualSelectLabel')}</Text>
            <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>{t('settings.sessionInit.manualSelectDesc')}</Text>
          </div>
          <Switch value={!!cfg?.manual_select} disabled={loading || saving || !cfg} onChange={(v) => void save({ manual_select: v })} />
        </div>

        {/* 滑块：默认是否关联团队资产 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--tea-color-border-primary-default)', borderRadius: 6 }}>
          <div>
            <Text style={{ fontSize: 13, fontWeight: 500 }}>{t('settings.sessionInit.associateLabel')}</Text>
            <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>{t('settings.sessionInit.associateDesc')}</Text>
          </div>
          <Switch value={!!cfg?.default_associate} disabled={loading || saving || !cfg} onChange={(v) => void save({ default_associate: v })} />
        </div>

        {/* 下拉：默认团队 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px' }}>
          <Text style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{t('settings.sessionInit.teamLabel')}</Text>
          <Select
            size="m"
            value={cfg?.default_team_id ?? ''}
            options={teamOptions}
            disabled={loading || saving || !cfg}
            onChange={(v: string) => void save({ default_team_id: v }, true)}
          />
        </div>

        {/* 下拉：默认 Agent（含未指定空选项） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px' }}>
          <Text style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{t('settings.sessionInit.agentLabel')}</Text>
          <Select
            size="m"
            value={cfg?.default_agent_id ?? ''}
            options={agentOptions}
            disabled={loading || saving || !cfg || !cfg.default_team_id}
            onChange={(v: string) => void save({ default_agent_id: v })}
          />
        </div>
      </div>
    </div>
  );
}
```

4. 在 SettingsDialog 的 `Modal.Body` 里按当前 tab 切换渲染：改现有 `{activeTab === 'permissions' && (...)}` 为条件渲染，并新增 `{activeTab === 'sessionInit' && <SessionInitPanel />}`。

> `Select` 的 value 是字符串；空串作为"未指定"选项。团队下拉切换时清空已选 agent（调用 `save(patch, true)`）并重拉 agents。所有文案走 i18n。

- [ ] **Step 3: 补 i18n 文案**

在 `MemoryPanel/web/src/i18n/zh-CN.ts` 与 `en-US.ts` 的 settings 段新增如下 key（中英各自翻译）：

```
settings.sessionInit.title
settings.sessionInit.desc
settings.sessionInit.manualSelectLabel
settings.sessionInit.manualSelectDesc
settings.sessionInit.associateLabel
settings.sessionInit.associateDesc
settings.sessionInit.teamLabel
settings.sessionInit.agentLabel
settings.sessionInit.noTeam
settings.sessionInit.noAgent
settings.sessionInit.saved
```

中文参考文案（示例，可润色）：
- title: `会话初始化默认`
- desc: `控制每次新会话首轮，是否自动按默认关联团队资产；未配置项仍会弹表单询问。`
- manualSelectLabel: `是否需要手动选择`
- manualSelectDesc: `开启后仍会弹表单让你选；关闭后按下方默认值自动关联。`
- associateLabel: `默认是否关联团队资产`
- associateDesc: `关闭后新会话将直接不注入团队资产。`
- teamLabel: `默认关联团队`
- agentLabel: `默认 Agent`
- noTeam: `未指定`
- noAgent: `未指定`
- saved: `已保存`

英文对应翻译（如 `Session Init Defaults` 等）。

- [ ] **Step 4: 前端类型检查 + 构建通过**

Run: `pnpm --dir MemoryPanel/web tsc --noEmit`（或项目声明的 typecheck script，若存在则用它的命令）。
Expected: 无 TS 错误。

- [ ] **Step 5: 手动验收（可选本步骤真实起服务，见测试总览）**

手动：登录面板 → 设置 ⚙ → 切到"会话初始化默认"Tab → 关"是否需要手动选择"、开"默认关联"、选默认团队/Agent → 保存 → 新开会话确认代理不再弹 asset_confirm。

- [ ] **Step 6: 提交**

```bash
git add td-agemem/MemoryPanel/web/src/components/SettingsDialog.tsx td-agemem/MemoryPanel/web/src/lib/api/users.ts td-agemem/MemoryPanel/web/src/i18n/zh-CN.ts td-agemem/MemoryPanel/web/src/i18n/en-US.ts
git commit -m "feat(memory-panel): per-user session_init default settings tab"
```

---

### Task 7: 端到端验证 + 回归

**Files:** 无新文件（验证）。

**Interfaces:**
- Consumes: Task 1-6 产物。

- [ ] **Step 1: 各子包全量单测**

Run:
```bash
pnpm --dir MemoryCore test
pnpm --dir MemoryProxy test
```
Expected: 各子包既有 + 新增用例全部通过。

- [ ] **Step 2: 类型检查全量**

Run:
```bash
pnpm --dir MemoryProxy typecheck
pnpm --dir MemoryPanel/web tsc --noEmit
```
Expected: 无 TS 错误。

- [ ] **Step 3: 启动整套服务做手工 E2E（可选，需真实环境）**

按仓库 `README-Windows部署.md` 或 `start-all.cmd` 启动 MemoryCore/MemoryPanel/MemoryProxy，做如下回归断言：

| 场景 | 预期 |
|---|---|
| 未配置用户开新会话 | 照常弹 asset_confirm →（回归，行为不变） |
| 面板配 manual_select=0 + associate=0 | 新会话直接不注入（bypass），不再弹窗 |
| 面板配 manual_select=0 + associate=1 + team+agent 有效 | 新会话直接登记 team+agent，无表单 |
| 面板配 manual_select=0 + team 有效 + 缺 agent | 直接进入 agent 选择那一级（不再问 team） |
| 配的 team/agent 已被删除或无权 | 回退弹表单（mismatch → form），不盲登记 |
| 内核不稳定 / 读配置失败 | 回退表单，session-init 不卡死 |

- [ ] **Step 4: 提交验证补充（如有修复）**

如 E2E 暴露问题，按通常提交节奏修正并提交（不在本 plan 预置具体修复代码——以真实观测为准；确定性修复若是代码逻辑，回到对应 Task 所在文件补丁并加单测）。

---

## Self-Review（执行前自查）

**1. Spec coverage：**
- spec §3.1 注册表 + 4 参数 → Task 1 ✅
- spec §3.2 MetadataClient 读用户配置 + CB/CC 决策表各分支 → Task 2/3/4/5 ✅（未配置/失败→ask 零变化；manual_select=1→ask；=0+associate0→bypass；=0+associate1+team+agent→register；只有 team→advance）
- spec §3.3 UI 滑块+下拉 → Task 6 ✅（手动选择/关联用 Switch，团队/Agent 用 Select 含空选项）
- spec §3.4 错误处理/防御：读失败回退表单、mismatch→form、只改自己（内核 assertCallerIsOwner 已保证）✅ Task 4/5
- spec §3.5 测试覆盖 → Task 1/2/3 单测 + Task 4/5 typecheck/回归 + Task 7 E2E ✅
- spec §4 Out of scope（不改 form 载体层、无新表、不改未配置用户、不做 task 默认）→ 计划均未触碰 ✅

**2. Placeholder scan：** 无 TBD/TODO；唯一"以真实观测为准"在 Task 7 Step4（验证类，非代码占位），Task 4/5 的 CB advance 签名标注"按本文件真实签名为准"——这是对既有函数签名的不确定提示而非留空实现，执行者需以本文件 header preset 块为唯一权威参照。

**3. Type consistency：** `UserInitDecision`（Task 3 定义）在 Task 4/5 复用；`getUserSessionConfig(userId, module)`（Task 2）在 4/5 按 `getUserSessionConfig(userId, SESSION_INIT_MODULE)` 调用；`sessionInitApi.get()/set(params)`（Task 6）与 `SettingsDialog` 中 save 的调用一致；`resolvePresetIdentity(teams, {teamId, agentId})` 在各处签名一致（均接受 `PresetIdentity`）。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-09-07-user-session-init-preset.md`。