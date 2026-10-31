# core wiki 薄转发（/v3/wiki/list、/v3/wiki/search）— task-73

**状态**：代码已实现并通过验证（20 单测 + 13 项隔离实例活体验证全绿）；生产 yaml 已加 `memory.wiki` 段。

> **生产尚未生效，待 Lead 排期重启 gateway（8420）**：8420 是常驻进程，本次按要求未重启，所以 `/v3/wiki/*` 在其进程里仍是 404（`isV3Extra` 未登记）。重启后请先看启动日志里 `memory.wiki` 的生效值再放流量。
**代码**：`MemoryCore/src/gateway/wiki-config.ts`、`wiki-client.ts`、`wiki-handlers.ts`；接线 `src/gateway/server.ts`（extraRoutes + wikiHeaders）、`src/gateway/v2-router.ts`（`isV3Extra` 登记 `/v3/wiki/`）。

## 1. 为什么是「薄转发」

wiki 的知识库本身由 MemoryKnowledge（8421）持有，core 侧**不复制、不落 core 知识资产注册表**，只在两个端点上做鉴权/归属校验 + 结果归一（absScore 合并）。这样 wiki 的写入/导入/同步仍只有 8421 一个真源，core 不会出现第二份会漂移的副本。

## 2. 端点契约

### POST /v3/wiki/list

请求体：

| 字段 | 必需 | 说明 |
|---|---|---|
| `team_id` | 是 | 目标团队；同时必须与请求头 `x-tdai-team-id` 一致 |
| `user_id` | 否 | 有则用它判成员关系（listTeamsByUser），无则判 team 存在性 |
| `limit` / `offset` | 否 | 透传 8421 |

响应 `data`：`{ serviceId, teamId, total, wikis: WikiListItem[], meta: { source, tookMs, failed, skipped } }`

- `source`：`knowledge` = 8421 直连成功；`core_registry` = 8421 不可用、回落 `store.listKnowledge({team_id, type:'wiki'})`（此时 `failed[0].stage = 'discovery'`）。
- `wikis[].ready`：镜像 8421 的 `wikiCanServeReads(status, last_sync_at)` —— `ready` 需 status 可读且有 `last_sync_at`；`draft/failed/无同步时间` 一律 `ready=false`（core 不自己发明可读性口径）。

### POST /v3/wiki/search

请求体：`{ query, team_id, wiki_ids?, top_k?, per_wiki_limit?, min_score?, user_id? }`

响应 `data`：`{ query, results: WikiHit[], meta: { source, tookMs, failed, skipped } }`

- 每个候选 wiki 并发检索（`concurrency`，缺省 4），`perWikiLimit` 缺省 4；全局 `timeoutMs` 2500、单 wiki `perWikiTimeoutMs` 2000。
- **不可读 wiki 不发检索**，进 `meta.skipped[{wikiId, reason:"not_readable(<status>)"}]`。
- 单 wiki 失败（500/超时/解析失败）进 `meta.failed[]`，**不影响其它 wiki**，整体仍 200。
- 合并口径：按 **absScore** 降序（不是 score；二者同值不同 absScore 时必须按 absScore 分先后），`absScore < minScore`（缺省 0.02）丢弃，截断 `topK`。
- 去重键 = `wikiId + "\u0000" + path`：**同一 path 出现在不同 wiki 时各自保留**（不同知识库的同名文档，来源归属不能丢）。

### 错误码

| HTTP | data.code | 场景 |
|---|---|---|
| 400 | `WIKI_TEAM_MISMATCH` | body.team_id ≠ 请求头 x-tdai-team-id |
| 403 | `WIKI_TEAM_FORBIDDEN` | teamVerify=enforce 且 metadata 确认调用者不是该 team 成员 |
| 403 | `WIKI_FORWARDING_DISABLED` | `memory.wiki.enabled=false` |

## 3. team 归属校验（`teamVerify`）

| 档位 | 行为 |
|---|---|
| `off` | 不查 metadata |
| `warn` | 确认非成员时**只 WARN 一次**（每 serviceId+team+user 一次，Set 上限 256）并放行 |
| `enforce`（缺省） | 确认非成员 -> 403 |

判定为「判不了」时一律 **fail-open 放行**（不拦）：metadata 抛错（unavailable）、按 user 查无团队（unknown）、未传 user_id 且 team 记录不存在（unknown）、无 user_id。理由：wiki 是只读召回通道，误拦会把正常回忆打挂；而真正的越权已有 service token 一层。

## 4. 配置

`MemoryCore/tdai-gateway.yaml` `memory.wiki`（解析点 `src/config.ts` `obj(c,"wiki")`，与 `sceneGovernance` 平级）：

```yaml
memory:
  wiki:
    enabled: true
    baseUrl: "http://127.0.0.1:8421"
    serviceId: "default"
    teamVerify: "enforce"
    timeoutMs: 2500
    perWikiTimeoutMs: 2000
    perWikiLimit: 4
    topK: 6
    minScore: 0.02
    maxWikis: 8
    concurrency: 4
```

env 覆盖（优先级高于 yaml，非法值回落缺省，永不抛）：`TDB_WIKI_ENABLED`、`TDB_WIKI_BASE_URL`、`TDB_WIKI_SERVICE_ID`、`TDB_WIKI_TEAM_VERIFY`、`TDB_WIKI_TIMEOUT_MS`、`TDB_WIKI_PER_WIKI_TIMEOUT_MS`、`TDB_WIKI_TOP_K`、`TDB_WIKI_MIN_SCORE`。

> 已知坑（历史）：`sceneGovernance` 曾被误挂在 `memory.recall` 下、解析器从不读取，导致守卫一直处于缺省关断。`memory.wiki` 按同一教训写在 `memory` 直属并用活体验证断言「yaml 值真的进了运行时」——不靠肉眼读 yaml。

## 5. 验证

单测（`cd MemoryCore && npx vitest run src/gateway/__tests__/wiki-handlers.test.ts`）：**16/16 通过**。覆盖发现面直连/回落、absScore 排序、跨 wiki 同 path 各保留、单 wiki 故障隔离、draft 不发检索、perWikiTimeout 超时进 failed、minScore 过滤、enforce 403（零上游调用）、warn 只 WARN 一次、metadata 抛错 fail-open、无 user_id fail-open、team 头不一致 400、enabled=false 403、`handleV2Route` 真派发（`isV3Extra` 登记生效）。

隔离实例活体验证（`cd MemoryCore && node --import tsx scripts/verify-core-wiki.ts 8498`）：**13/13 PASS**，证明「yaml -> config -> client -> 上游 -> 响应」整条装配链：

| check | 结论 |
|---|---|
| `C-wiki-from-yaml` | 生效 `memory.wiki`：baseUrl/topK=5/perWikiLimit=3 来自临时 yaml |
| `W-list-200` / `W-list-source-upstream` | `/v3/wiki/list` 200，`meta.source=knowledge`（直连 8421 形状桩上游） |
| `W-list-readiness` | 三 wiki readiness `[true,true,false]`（failed 降级） |
| `W-search-absScore-order` | absScore `0.6,0.52,0.44,0.31` 严格降序 |
| `W-search-same-path-kept` | 同名 `shared.md` 两条各自保留（wiki-a/wiki-b） |
| `W-search-skip-unreadable` / `no-request` | wiki-c 进 `meta.skipped`，上游收到的 wiki_id 只有 a/b |
| `W-team-mismatch-400` | `WIKI_TEAM_MISMATCH` |
| `P-8420-alive-before/after` | 8420 `/health` 前后 200（未被重启，本次只起 8498 第二实例） |

复跑产物：`scratch/core-iso-wiki/{config.yaml,verify-result.json}`；`scratch/core-iso-wiki/data` 可整目录删（脚本重建 schema）。

## 6. 局限（这张票没证明什么）

1. **8421 读面无需凭据（已核实，不是缺口）**：`MemoryKnowledge/src/middleware/auth.ts:48-55` 的只读白名单 `READONLY_POST_PATHS` 含 `/wiki/search`、`/wiki/list`、`/wiki/get`、`/wiki/raw/ls`、`/wiki/raw/read`、`/tools/list`、`/tools/call` 等 ⇒ 即使将来配了 `KNOWLEDGE_SERVICE_KEY`，core→8421 的这两个只读转发仍放行，因此 wiki-client **不发鉴权头是正确设计**。剩余待联调的只有字段级漂移（`wiki_id`/`absScore` 命名，已按 `MemoryKnowledge/src/routes/wiki.ts:712-757` 对齐）。
2. **生产未生效（待重启）**：`tdai-gateway.yaml` 已加 `memory.wiki` 段，但 8420 是常驻进程、本次未重启（票面要求不重启）⇒ 端点在生产上尚未可用，属「待 Lead 排期重启」的已知状态，不是线上故障。
3. **teamVerify=enforce 的 403 只靠单测证明**：隔离实例 metadata 是空库 → 一律 unknown → fail-open，所以活体走的是「判不了就放行」分支，403 分支靠单测（enforce 且确认非成员、零上游调用）。
4. **8421 侧限流/配额未覆盖**：core 只把 429 归入 `meta.failed[]`，不做重试/退避（薄转发不引入第二套重试语义）。
