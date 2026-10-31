# core 数据面 team 归属校验（task-68 / #137 跟进）

**结论**：/v3 数据面此前只校验三 ID **非空**（不校验归属），任意 `team_id` 都能开自己的
命名空间。本票补上「这个 team 属不属于本调用方」这一层裁决，按 **off（缺省，逐位现状）/
warn（只记）/ enforce（403）** 三档灰度，判定源是 metadata 的 `meta_team_members`，
调用方身份只认 `x-tdai-user-key`（与 `/v3/meta/auth/verify` 同源）。**缺省 off ⇒ 一次 metadata
查询都不发、响应逐位不变**；`enforce` **生产禁用**，只允许灰度实例先开 warn。

## 1. 语义表

| 输入 | off | warn | enforce |
| --- | --- | --- | --- |
| 白名单命中 `teamOwnershipWhitelist` | 放行（不查询） | 放行（不查询） | 放行（不查询） |
| 无 `x-tdai-user-key` | 放行 | 放行 + `no_identity` 计数 | **放行** + `no_identity` |
| key 解不出用户（吊销/伪造） | 放行 | 放行 + `no_identity` | **放行** + `no_identity` |
| metadata 查询抛错 | 放行 | 放行 + WARN + `metadata_error` | **放行** + WARN + `metadata_error` |
| team 查无 | 放行 | 放行 + WARN（`team_unknown`） | **403** `TEAM_NOT_OWNED` |
| 非该 team 的 active 成员 | 放行 | 放行 + WARN（`not_member`） | **403** `TEAM_NOT_OWNED` |
| 成员成立 | 放行 | 放行（debug 日志） | 放行 |

两条硬口径（票面要求，不得反悔）：

1. **没有 user-key 不得判为不通过**。DSH 插件今天不带这个头，判不通过等于把自己的写回打死。
2. **metadata 抖动不得挡写**。fail-open + WARN（同一 (instance, team) 只 warn 一次，不刷屏）。

## 2. 三档行为

### off（缺省）

- `decideTeamOwnership` 立即返回 `mode_off`，**`checkTeamOwnership` 一次都不调用**（wire 测试断言
  `vi.fn` 计数为 0）；响应与今天逐位相同。
- 启动时打一行 `[TEAM-OWNERSHIP] memory.auth.requireTeamOwnership=off whitelist=0`，并把 `off` 计数 +1
  （灰度的第一行读数；事后可证「当时确实是关着的」）。

### warn（先跑一周）

- 会查询（玄 key 时）：`verifyAuth(x-tdai-user-key)` → `getTeamById(team)` → `getTeamMember(team, user)`。
- 非成员 / team 查无：**照常进入 handler**，只打审计行
  `authz.team_ownership.warn mode=warn why=not_member team=t… user=u… caller=u… req_id=…`。
- 用途：收集 `authz.team_ownership.{no_identity,warn,metadata_error}` 三个计数，判断「现在切 enforce 会打死谁」。

### enforce（403）

- 非成员或 team 查无 ⇒ **403**，body：

```json
{
  "code": 403,
  "message": "TEAM_NOT_OWNED: user u1 is not an active member of team t-victim",
  "data": {
    "code": "TEAM_NOT_OWNED",
    "team_id": "t-victim",
    "user_id": "u1",
    "hint": "x-tdai-user-key must belong to an active member of the requested team; or configure memory.auth.teamOwnershipWhitelist for legacy teams"
  }
}
```

- 用 403 而不是 401/404：调用方身份本身可能是合法的，缺的是这一对 `(team, user)` 的归属，
  语义是「禁止」而不是「未认证」/「不存在」。

## 3. 配置

```yaml
memory:
  auth:
    requireTeamOwnership: off        # off | warn | enforce（缺省 off）
    teamOwnershipWhitelist: []       # 历史脏 team / 迁移残留的逃生口，命中即不查
```

```bash
# env 优先于 yaml；白名单为逗号分隔
MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP=warn \
MEMORY_AUTH_TEAM_OWNERSHIP_WHITELIST=team-legacy-1,team-migrated-2 \
  node dist/index.js
```

取值口径与 `resolveV3StrictIsolation` / `parseSwitch` 一致：**显式写了但写错 ⇒ fail-secure**
（未知非空取值一律按 `enforce`）。白名单在 env 与 yaml 同时存在时 **env 覆盖**（不做合并，
避免「以为关掉了其实还留着一个」）。

## 4. 接线点（票面指定两处）

| 路径 | 方向 | 说明 |
| --- | --- | --- |
| `/v3/conversation/add` | 写 | L0 落库前先裁决；enforce 时 403 且 `upsertL0` 一次都不调用（wire 测试断言） |
| `/v3/core/read` | 读 | L3 读到 `persona` 前先裁决；enforce 时 403 且不读存储 |

其余 /v3 路径**不在本票范围**（`TEAM_OWNERSHIP_GATED_PATHS` 白名单式接线）。含义：
`enforce` 只挡这两个入口；`/v3/atomic/*`、`/v3/recall` 等仍按今天的行为走。要扩面时
往 `MemoryCore/src/gateway/v2-router.ts` 的 `TEAM_OWNERSHIP_GATED_PATHS` 加一行，并在
wire 测试补一例。

## 5. 实现落点

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `MemoryCore/src/gateway/team-ownership.ts`（新） | `parseTeamOwnershipMode` / `normalizeTeamOwnershipWhitelist` / `resolveTeamOwnershipConfig` / `decideTeamOwnership` / `teamOwnershipNeedsLookup` / `recordTeamOwnershipMetric` | 零 IO 纯函数 + obs 计数，语义单源 |
| `MemoryCore/src/gateway/team-ownership-resolver.ts`（新） | `createTeamOwnershipResolver` | metadata 查询 + 进程内 LRU（TTL 60s / 4096 条）+ fail-open warn-once |
| `MemoryCore/src/gateway/auth-binding.ts` | `AuthBindingConfig` 两字段 / `resolveAuthBindingConfig` | 把开关收进同一份 `memory.auth`，与 ②③④ 同源解析 |
| `MemoryCore/src/gateway/v2-router.ts` | `TEAM_OWNERSHIP_GATED_PATHS` / deps `checkTeamOwnership` / dispatch 归属闸 | 接线与 403 信封 |
| `MemoryCore/src/gateway/server.ts` | `authBinding` 解析 + `checkTeamOwnership` | 注入 resolver（与 `ensureChatMemoryAsset` 同一条热路径） |
| `MemoryCore/src/utils/env-config.ts` | `readAuthRequireTeamOwnership` / `readAuthTeamOwnershipWhitelist` | env reader（OpenClaw 扫描器约束只能集中在此） |
| `MemoryCore/src/config.ts` | `MemoryAuthConfig` 两字段 / `parseConfig` | yaml `memory.auth.*` 加法式接入，缺省 off |

**为什么不是每请求一次同步查询**：resolver 内两层 Map 缓存（`user_key → userId`、
`(team, user) → {teamKnown, isMember}`），TTL 60s、容量 4096、超出淘汰最早写入项——与
`MetadataService.ensuredChatMemoryAssets` 同款「确认过就短路」的语义。命中缓存时零 DB 往返。

## 6. 灰度步骤

1. **只读现状**：保持 `off`，确认启动日志里 `requireTeamOwnership=off`；响应无变化。
2. **开 warn**（8420 重启窗口内改 yaml 或 env）→ 跑一周，看三行读数：
   - `authz.team_ownership.no_identity` 高 ⇒ 插件/代理没带 `x-tdai-user-key`（先补头，别急着 enforce）；
   - `authz.team_ownership.warn` 高 ⇒ 有真实的「team 归属不成立」（挑几个 `team=` 值人工核对）；
   - `authz.team_ownership.metadata_error` 非零 ⇒ metadata 抖动或 instance 链没接上（先查这里，否则 enforce 时会被 fail-open 吃掉，等于没开）。
3. **补白名单**：把迁移残留/历史脏 team 写进 `teamOwnershipWhitelist`（这一步之后 `warn` 计数应显著下降）。
4. **开 enforce**：先只在隔离实例验证（403 与放行各一例），再上生产；观察 `authz.team_ownership.denied`。

判据：`denied` 出现时人工核对 3 条——(a) 该 user 确实是该 team 的 active 成员（`meta_team_members.status`）？
(b) 调用方是否把 user_key 和 user_id 搞混？(c) 这个 team 该不该进白名单？

## 7. 回滚

**一个开关**：`memory.auth.requireTeamOwnership: off`（或 env `MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP=off`）
⇒ 进程内归属闸整段跳过，判定函数立即返回，行为回到今天。需要重启生效（配置在启动时解析），
**无需回滚代码**。`enforce` 期间被 403 的请求没有产生任何写入（闸在 handler 之前），所以回滚后
调用方重试即可，不存在半写状态。

## 8. 未证实 / 局限

1. **本票没有活体验证**：生产 8420 未重启（`off` 缺省，端点行为未变），隔离实例上的 403/放行读数
   由 wire 测试（真 `handleV2Route`）覆盖，不是端到端 HTTP 实测。开 warn 前建议按 §6 在隔离实例跑一遍。
2. **身份强度上限**：`x-tdai-user-key` 是共享密钥体系里的主体标识，**不做密码学签名**。伪造一个合法
   user_key 仍可冒充该 user（与 `docs/ops/core-auth-binding.md` §5 的结论同一条）。跨机/多租户必须叠加
   TLS + 每主体独立密钥。
3. **只覆盖两个入口**：见 §4。`/v3/atomic/update`、`/v3/recall` 等仍无归属裁决。
4. **成员判定口径**：`meta_team_members.status='active'` 才算成员（`sqlite-adapter.ts` 的查询口径）；
   `removed`/`pending` 一律不算。跨 pod 时各自维护 LRU，TTL 内可能短暂不一致（最多 60s）。
5. **未做的相邻项**：`metadata` 侧 team 归属（team→user 的 owner 关系）不参与本判定；本票只判
   「是不是这个 team 的成员」。

## 9. 测试

```bash
cd MemoryCore
npx vitest run src/gateway/__tests__/team-ownership.test.ts       # 纯判定 + resolver 缓存（22）
npx vitest run src/gateway/__tests__/team-ownership.wire.test.ts  # 真 handleV2Route 接线（9）
npx vitest run src/gateway/__tests__/auth-binding.wire.test.ts    # 既有 ②③④ 回归
```
