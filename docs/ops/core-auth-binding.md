# core 数据面归属校验（#红队② / task-60）

**结论**：/v3 数据面的「服务级信任」**缺省逐位不变**（Bearer 通过即认请求声明的 user_id，红队结论今天仍可复现）；新增**可配开关**三层：开启后把 user_id 绑到凭据主体、写侧校验 team/agent/user 归属、admin 走显式留痕旁路。开关缺省全关 ⇒ 对现有 DSH 插件与 MemoryProxy 零影响，可灰度。**但 `requireUserBinding`（enforce）与 `unknownPrincipalPolicy=reject` 两档 = 生产禁用**，只允许在灰度/隔离实例上开，理由与实测见 §6。

## 1. 威胁模型（红队实测，2026-11-01）

- 单凭 `Authorization: Bearer <共享密钥>` 即可用**任意 user_id** 读真实 L0（`/v3/conversation/query` 200）。
- 同样可用任意 user_id 删（`/v3/conversation/delete` → `deleted:10`）。
- 根因：core 只有 `parseV2Auth`（共享密钥）而没有**主体绑定**；三 header 是调用方自报，服务端不核。
- **不能简单要求 user_id = 凭据主体**：DSH 插件与 MemoryProxy 本来就是「共享密钥 + 三 header」的身份模型，硬改会把现有集成全打挂。故做分层开关 + 缺省关。

## 2. 改动点

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `MemoryCore/src/gateway/auth-binding.ts`（新） | `DEFAULT_AUTH_BINDING`:39、`resolveAuthBindingConfig`:86、`decideUserBinding`:127、`decideUnknownPrincipal`:181 | 零 IO 纯函数：开关解析 + 两条判定，语义单源 |
| `MemoryCore/src/utils/env-config.ts` | `readAuthRequireUserBinding`:201、`readAuthUnknownPrincipalPolicy`:209、`readAuthAdminBypassEnabled`:217 | 新 env reader（受 OpenClaw 扫描器约束只能集中在此文件；只回原始串，解释权在 auth-binding.ts） |
| `MemoryCore/src/config.ts` | `MemoryAuthConfig`:1275、字段:1346、parseConfig:2656 | yaml `memory.auth.{requireUserBinding,unknownPrincipalPolicy,adminBypassEnabled}`；加法式，缺省全关 |
| `MemoryCore/src/gateway/v2-router.ts` | deps 新字段:406/:412、门块 :780 起、`const authBinding = deps.authBinding`:784（v3 严格隔离 422 块之后） | ② 403 绑定校验、③ 写侧未知主体、④ admin 旁路；**deps 未注入 ⇒ 整段跳过** |
| `MemoryCore/src/gateway/server.ts` | `authBinding`:1441、`lookupPrincipal`:1448 | 接线 env+yaml；主体存在性查 entity_teams/users/agents（只读；getter 缺失/抛错 ⇒ null 不拦） |

### 三层语义

1. **② 数据面绑定**（`MEMORY_AUTH_REQUIRE_USER_BINDING=1` 或 yaml `memory.auth.requireUserBinding`）：/v3 数据面要求 `x-tdai-user-key` 存在且等于请求声明的 user_id（body 优先，其次 `x-tdai-user-id` header）。否则 **403**，`data.code` 为 `USER_BINDING_REQUIRED`（没带 key）或 `USER_BINDING_MISMATCH`（key ≠ user_id，message 回显两者）。管理面 `/v3/skill|knowledge|chat-memory|memory-prompt|memory-generation-log|admin/*` 豁免。
2. **③ 未知主体**（`MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY=off|warn|reject`，缺省 off）：实现上的判据是 `method === "POST"`（`MemoryCore/src/gateway/v2-router.ts:823-824`），而 core 的**读端点同样是 POST**（`/v3/conversation/query`、`/v3/conversation/search` …）⇒ **读面同样生效**。2026-11-01 隔离实例实测：entity 表为空时 `POST /v3/conversation/query` 也返回 400 `UNKNOWN_PRINCIPAL`（`docs/ops/adversarial-retest-2026-11-01.md` 矛盾 3）。原文「仅对写 POST 生效、读面不拦」与行为不符，已按行为改写。按隔离三元组查 entity_teams/entity_users/entity_agents 是否存在。`reject` ⇒ **400** `UNKNOWN_PRINCIPAL`（`data.unknown` 列出未知维度）；`warn` ⇒ 记日志放行；`off` ⇒ 不查不记（逐位现状）。查询抛错按软失败放行并 warn。
3. **④ admin 旁路**（`MEMORY_AUTH_ADMIN_BYPASS_ENABLED=1`）：`x-tdai-user-type: system_admin` **且** `x-tdai-admin-bypass: 1` 双条件，缺一不放行；放行时打 `USER_BINDING_ADMIN_BYPASS` warn 日志。

取值口径与 `resolveV3StrictIsolation` 一致：**显式写了但写错 ⇒ fail-secure**（开关视为开、策略视为 reject）。优先级 env 显式 > yaml > 缺省。

## 3. 缺省不变（bite-identical）证明

- `gateway/auth-binding.test.ts`：缺省配置下 `decideUserBinding` 对「任意 user_id + 任意/缺失 key」全部 `{allow:true,bypassed:false}`；`decideUnknownPrincipal("off", …)` 恒放行。
- `gateway/auth-binding.wire.test.ts`（走真 `handleV2Route`）：deps 无 `authBinding`、或全关 ⇒ v3 请求照常进 handler；`off` 时 `lookupPrincipal` **一次都没被调用**（vi.fn 计数为 0）。
- 活体开关全关实例：跨 user 读 **200**、跨 user 删 **200**（红队结论可复现，证明没顺手打补丁）。
- `npm run typecheck:gate` → 240 errors / 44 files（基线 243/44，Δ=-3，无新增）。

## 4. 开启后活体实测（`cd MemoryCore && node --import tsx scripts/verify-auth-binding.ts`，14/14 PASS）

隔离第二实例：端口 **8498**、config/data 在 `os.tmpdir()` 下（运行后自删）、embedding none、recall/lifecycle 全关、llm 指向 discard 端口；8420 只做前后 `GET /health` 探针（两次 200 ⇒ **未被重启**）。

| 检查 | 结果 |
| --- | --- |
| B0 业主写 L0（key 相符） | 200 / code 0 |
| B1 无 key 跨 user 读 | **403** `USER_BINDING_REQUIRED` |
| B2 key ≠ user_id | **403** `USER_BINDING_MISMATCH` |
| B3 跨 user 删 | **403**，业主随后读回 total=1（数据真没删） |
| B5 key 相符 | 200 |
| B6 admin 双条件旁路 | 200 + `USER_BINDING_ADMIN_BYPASS` 日志 |
| B7 warn 档写 `team-bogus-000` | 200（放行并留痕） |
| B8 reject 档写 `team-bogus-0002` | **400** `UNKNOWN_PRINCIPAL` `unknown:["team","agent","user"]` |

## 5. 运维口径：谁在什么时候该开

| 部署形态 | requireUserBinding | unknownPrincipalPolicy | 说明 |
| --- | --- | --- | --- |
| 同机单用户（今天 8420 的形态） | **不必开** | off | 本机只有你一个调用方，共享密钥即身份；开了只会让插件多传一个 header |
| 同机多 agent / 多插件共用一把 key | 建议开 | 先 warn | 跑一周日志观察，再切 reject |
| **跨机部署（task-50/51 那条线）** | **必须开** | reject | 否则任意持有密钥的机器都能冒用他人 user_id 读/删 |
| 对外暴露 / 多租户 | 必须开 + 每主体独立 key | reject | 本票只做 header 绑定，**不提供密码学签名**：跨机必须叠加 TLS + 每主体独立密钥或签发 token，否则 user-key 本身可伪造 |

开启方式（env 优先于 yaml）：

```bash
MEMORY_AUTH_REQUIRE_USER_BINDING=1 MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY=warn node ...
```

```yaml
memory:
  auth:
    requireUserBinding: true
    unknownPrincipalPolicy: warn   # off | warn | reject
    adminBypassEnabled: true
```

灰度顺序：`unknownPrincipalPolicy: warn` 只看日志零拦截 → 确认 entity 表已登记真实 team/agent/user → 切 `reject` → 最后开 `requireUserBinding`（此时所有调用方都要补 `x-tdai-user-key`，插件侧改动需同步发布）。

### 5.1 生产库实测：entity 表是空的（2026-11-01）

只读盘点 `node scratch/probe-mc-tables.mjs /d/TDB/data/vectors.db`（task-46 的探针，只读不写，可复跑）实测：

| 表 | 行数 |
| --- | --- |
| `entity_users` / `entity_teams` / `entity_agents` / `entity_tasks` | **0 / 0 / 0 / 0** |
| 同库真实数据 | `l0_conversations` 13409、`l1_fts`（L1 记忆）3514、`l1_archive` 6504、`skills` 2052 |

即：**身份登记表一行都没有，业务数据一万多条**。

⇒ 在 8420 上把 `unknownPrincipalPolicy` 设成 `reject`，**不是「拦掉坏数据」，而是「把服务停掉」**：每一条写都会被判 `UNKNOWN_PRINCIPAL`（团队/agent/user 三维全未知）。

### 5.2 因此定死四条口径

1. **缺省三开关全关，不变**（现状逐位保持；不允许为了「看起来安全」而改）。其中 `requireUserBinding` 与 `reject` 两档另加**生产禁用**标记，见 §6。
2. **生产要开只允许先开 `warn`**：观察日志里 `UNKNOWN_PRINCIPAL` 打出的 team/user/agent 维度，拿到「真实调用方会带哪些主体」的第一手读数。
3. **`reject` 只有在 entity 三表完成登记之后才允许开**，且开之前必须先跑一次 dry 统计（按 warn 日志的分类计数，或对现有 L0/L1 dump 一次主体清单），确认不会收窄到自伤。
4. **「entity 表自动登记」不做**。登记属于身份管理语义：自动登记会把脏 header（如 `team-bogus-000`）洗成合法主体，把本票要挡的东西洗白。身份由人/外部 IdP 登记，core 只做校验。

## 6. 生产禁用档（2026-11-01 拍板）

**结论**：`MEMORY_AUTH_REQUIRE_USER_BINDING=1`（enforce）与 `MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY=reject` 两档**不允许在生产开**，仅限灰度 / 隔离实例。缺省档（两开关全关）保持不变——那是今天唯一被实测过「不伤人也不误拒」的形态。

**理由 1 · enforce 一开，现有合法客户端全 403 停服**：`dsh-plugin/src/memory-client.ts:486-500` 的 `headers()` 只发 `x-tdai-service-id` / `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id` + Bearer，**从不发 `x-tdai-user-key`**（MemoryProxy 也只在 meta/ACL 面用它，L0 写入不带）。隔离实例实测 B1（`scratch/probe-red2/probe-05.ts`）→ 403 `USER_BINDING_REQUIRED`。判定点在 `MemoryCore/src/gateway/auth-binding.ts:127-146`。

**理由 2 · reject 一开等于全拒**：生产 `D:/TDB/data/vectors.db` 的 `entity_users` / `entity_teams` / `entity_agents` 全 0 行（§5.1），reject 档对未登记主体一律 400 `UNKNOWN_PRINCIPAL`（B8 三维全中）；且 core 读端点同为 POST，读面一样被拒（§2 ③）。登记属身份管理，本系统不自动完成（§5.2 口径 4）。

证据出处：`docs/ops/adversarial-retest-2026-11-01.md`（第二轮复测 第二节 3 / 矛盾 2、4）。最小复现：§7.1。

## 7. 已知边界（诚实清单）

1. **不是密码学绑定**：`x-tdai-user-key` 是调用方自报的 header，能挡「误用/越权调用」，挡不住「持有共享密钥的恶意方」。跨机对外必须叠加独立密钥或签发 token。
2. **reject 档要求 entity 表有登记，而生产库现在 0 行**：活体实例三表为空时 `reject` 把全部写判未知（B8 三维全中）；生产库 `D:/TDB/data/vectors.db` 实测同样 `entity_users/teams/agents/tasks` 全 0 行（见 §5.1）⇒ 在 8420 开 `reject` 等于停服务。故只允许 warn 打头，`reject` 须待身份登记完成后开。
3. **主体查询只覆盖 sqlite store**：`lookupPrincipal` 走 `getTeam/getUser/getAgent`；自定义 store 未实现时返回 null ⇒ 写侧校验自动 no-op（不误拦，但也不设防）。
4. **管理面豁免**：`/v3/skill|knowledge|chat-memory|memory-prompt|memory-generation-log|admin/*` 不受 ② 约束（team 级资源 + admin 自身鉴权）；这些面的越权风险不在本票范围。
5. **未覆盖 /v2**：/v2 是兼容面（无严格隔离），本票只在 /v3 数据面设防。

### 7.1 详注：admin 旁路 —— 身份类型靠调用方 header 自证（HIGH，2026-11-01 复测）

`MEMORY_AUTH_ADMIN_BYPASS_ENABLED=1` 时，判定只读三个请求头：`x-tdai-user-key`（任意值）+ `x-tdai-user-type: system_admin` + `x-tdai-admin-bypass: 1|true` ⇒ 直接放行，**不校验该 key 是否真属于被声明的 user_id**。判据在 `MemoryCore/src/gateway/auth-binding.ts:127-146`，旁路分支在 key 比对**之前** return `{allow:true,bypassed:true}`；上游 `MemoryCore/src/gateway/v2-router.ts:797-820` 只补一条 `USER_BINDING_ADMIN_BYPASS` warn 日志。

实测（`MemoryCore/scratch/probe-red2/results-05.json`，隔离实例 8485）：

| 场景 | 请求 | 结果 |
| --- | --- | --- |
| B1 合法客户端形状 | 无 `x-tdai-user-key` | 403 `USER_BINDING_REQUIRED` |
| B2a 冒充受害者 | body `user_id` = 受害者 + 垃圾 key + `system_admin` + `admin-bypass:1` | **200，`total=1`**（读到受害者记忆行） |
| B2b 自带身份 | 攻击者自己的 `user_id` + 同一 session_id | 200 / `total=0`（数据面仍按 user_id 过滤） |
| B3 半套伪造 | 只给 `x-tdai-user-type`，缺 `x-tdai-admin-bypass` | 403 `USER_BINDING_MISMATCH` |

B2b 证明越权完全来自**身份冒用**，而不是过滤缺失——只要把 `user_id` 改写成受害者，同一条旁路就能读到别人的行。

最小复现：

```bash
cd MemoryCore && node --import tsx ../scratch/probe-red2/probe-05.ts   # 隔离 8485，自建自删，不碰 8420/8123
cd MemoryCore && node --import tsx ../scratch/probe-red2/probe-02b.ts  # 隔离 8486，X1 同形状
```

**生产开启推演**：enforce + bypass 同开 ⇒ 合法插件（不发 user-key）全部 403 停服，而持共享网关密钥者只要伪造两个 header 就能冒充任意 `user_id` 读写。攻防倒挂：enforce 档的安全增益为 0，只增加停服面。故本旁路必须由部署侧显式开启、生产缺省关；将来若要真开 enforce，前提是先有凭据↔身份的强绑定（签名 token / IdP 签发），**不能只凭 header 自证**。
