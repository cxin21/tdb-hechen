# wiki 召回接入 DSH 插件 —— 只读调研与方案（task-64）

> 只读调研，零提交零改码。断言均带 path:line；活体读数采集于 2026-11-01T01:00+08:00（core 8420 / knowledge 8421 / panel 8123 在跑）。

## 0 结论

1. **跨库检索没有现成端点。** `/v3/wiki/search` 必须带 `wiki_id`：`MemoryKnowledge/src/routes/wiki.ts:719-723`（缺则 400 `wiki_id is required`），随后 `:722-725` 用 `(serviceId, wikiId)` 取行；serviceId 只来自 header `x-tdai-service-id`（`routes/wiki.ts:714`）。跨库只能"发现 → 每库并行检索 → 合并"。
2. **8421 的 team 隔离是 caller 自证。** `/v3/wiki/list` 按 body 里的 `team_id` 过滤（活体：传 `team-other-zzz` → `{"items":[],"total":0}`；传 `team-2k12lgb650` → 3 条）；`/v3/wiki/search` 只按 `(serviceId, wikiId)` 取行，**完全不校验 team**（`routes/wiki.ts:722-725`）。⇒ 任何能连 8421 的进程传任意 team_id 就能枚举并检索该团队 wiki。
3. **core 的知识注册表是漏的。** 活体 `POST 8420 /v3/knowledge/list {team_id}` → `total:1`，只有 `wiki-m6c41uvc`（scm-standards）；8421 侧同 team 有 3 个（scm-standards 50 页 ready、scm-recipes 686 页 ready、scm-business-analysis status=failed）。⇒ **以 core 注册表做发现会丢掉 686 页的 scm-recipes**（`MemoryCore/src/core/store/types.ts:561-575` KnowledgeEntity 无 service_id 字段，只有 service_url）。
4. **推荐形态 B：core 8420 新增 `/v3/wiki/{list,search}` 薄转发**（发现面打 8421 `/v3/wiki/list`，检索面并行打各 wiki 的 `service_url + /wiki/search`），插件只加一个 `knowledge` 配置段 + 一个注入段。形态 A（插件直连 8421）不推荐；形态 C（塞进 `/v3/recall`）留作 V2。

## 1 契约事实（已逐条核实）

- 检索体 `{wiki_id, query, limit?, minScore?, hop?, decay?}` → `{results:[{path,title,snippet,score,type,absScore,hop,related}],links,count}`；参考实现 `MemoryProxy/src/knowledge/wiki-retrieve-client.ts`（非 2xx / code!==0 / 抛错一律 return []，默认 timeout 3000）。
- **`score` 会为 0 而 `absScore` 不为 0**：活体 `{"path":"wiki/sources\\安全规范.md","score":0,"type":"source","absScore":1.2665}`。⇒ 合并排序不能用 `score`，否则结构页/来源页被永久排到末位（#85 症状②同源）。proxy 已用 `absScore` + 结构页尾段门控处理：`MemoryProxy/src/injection/injectors/wiki-recall-injector.ts:322-411`。
- 发现面二选一：8421 `/v3/wiki/list`（`MemoryKnowledge/src/routes/wiki.ts:244`，team_id 由 caller 给）或 core `/v3/knowledge/list`（`MemoryCore/src/gateway/knowledge-handlers.ts:144` + `MemoryCore/src/gateway/knowledge-schemas.ts:50-59`，team_id 必填、有 gateway 鉴权）。**前者全、后者漏**（结论 3）。
- proxy 已有全套可抄逻辑：`resolveBoundWikiResources`（`MemoryProxy/src/injection/injectors/wiki-recall-injector.ts:508-531`）+ 每 wiki 一个 `WikiRetrieveClient(serviceUrl, serviceId)`（`MemoryProxy/src/injection/index.ts:347-371`）+ 合并/门槛/结构页尾段（同文件 `:243-430`）。**但它只服务走 proxy 的客户端；DSH 插件直连 core，proxy 的 wikiRecall 对 DSH 从未生效**（`dsh-plugin/src` grep wiki/knowledge 零命中）。
- 插件侧接缝（改点明确）：`dsh-plugin/src/config.ts:233-245`（paths）、`:265-300`（volatile 预算 `maxChars:1200`/`timeoutMs:3000`/`recallMaxResults:3`）、`dsh-plugin/src/index.ts:588-655`（每轮 volatile 组装，`:649` `formatVolatileBlock(hits, maxChars)`）、`dsh-plugin/src/tools.ts:60-95`（`memory_recall` → `client.recall`）。

## 2 三形态对比

| | A 插件直连 8421 | B core 薄转发 | C 塞进 /v3/recall |
|---|---|---|---|
| 改动面 | 插件 ~250 行（发现+并行+合并+门控+渲染） | core ~150 行（转发+并行+合并+限速）+ 插件 ~120 行（配置+渲染+降级） | `MemoryCore/src/gateway/v2-router.ts:2070` handleRecall 组装（开关在 `:2076` v3Recall.enabled，默认 false） |
| 复用 | 逻辑与 proxy `wiki-recall-injector.ts:243-430` 重复，等于第二处维护 #85 门控 | 复用 core 的 gateway 鉴权 / team 校验 / 审计 / 缓存 | 复用全部 core 召回管线 |
| 隔离 | **假隔离**：8421 只认 caller 传的 team_id | 真隔离：team 来自鉴权上下文 | 真隔离 |
| 暴露面 | 8421 从"潜在可达"变成**每条 DSH 会话的必经依赖**，且 service_url 进客户端 | 8421 保持本机内部服务 | 同 B |
| 影响面 | 只影响 DSH | 影响所有 core 客户端（都是增强） | **改所有客户端的 recall 契约与体积**，评测基线要重跑 |
| 风险 | 高（重复逻辑 + 隔离假 + 客户端直连数据面） | 中 | 高（回归面最大） |

## 3 推荐

**B（MVP）**：core 加 `/v3/wiki/list`、`/v3/wiki/search`（`makeKnowledgeRouteTable` 同款挂载点 `MemoryCore/src/gateway/server.ts:1567`）；发现面核优先打 8421 `/v3/wiki/list`（全量），失败回落 core 注册表（漏但可用）；检索面并行打 `service_url + /wiki/search`，按 `absScore` 合并、结构页入尾段、`perWikiLimit` 与 `topK` 收敛。插件只加配置段与一个注入段（追加到 volatile 尾部或独立 user/message），**默认 `enabled:false`（shadow-first）**。
**C 作为 V2**：B 上线后拿到真实命中率与体积数据，再决定把 wiki 段合进 `/v3/recall`（好处是模型零感知自动召回，代价是全部客户端一起变）。

## 4 配置键草案（`dsh-plugin/src/config.ts` DEFAULT_CONFIG，KNOWN_KEYS 自动跟随）

```yaml
knowledge:
  enabled: false        # 默认关，shadow-first；开了才发请求
  mode: "core"          # core=走 8420 转发（推荐）；direct=直连 8421（不推荐）
  types: ["wiki"]       # 预留 code-graph
  perWikiLimit: 4
  topK: 3
  minScore: 0.02        # 与 proxy 同刻度 wiki-recall-injector.ts:36
  maxChars: 800
  timeoutMs: 2500       # 必须 < volatile.timeoutMs(3000)
paths:
  wikiList: "/v3/wiki/list"
  wikiSearch: "/v3/wiki/search"
```

## 5 验收判据（都可复跑）

1. **确实调通了**：query「暂估 应收 冲销」经 core 转发命中 scm-standards 与 scm-recipes **各 ≥1 条**，块内含 `title`+`path`（今天 DSH 侧调用数 = 0）。
2. **隔离是真的**：用 team A 的 Bearer 请求 team B 的 wiki → core 返回 403/空，**不是**今天的 200（`routes/wiki.ts:722-725` 现状）。
3. **降级不吞块**：8421 down 时插件只 warn 一条，volatile 里记忆段照常；wiki 段为空且总耗时 ≤ `timeoutMs`。
4. **体积**：wiki 段 ≤ `maxChars`(800)，整 volatile ≤ `volatile.maxChars`(1200)。
5. **可关**：`knowledge.enabled=false` 时零网络请求（抓包/计数断言）。
6. **不重复 #85**：结构页（type=source/overview/entity）不得占据正常段首位；排序键必须是 `absScore`。

## 6 暴露面回答（Lead 点名要的那句）

**形态 A 不会扩大"网络暴露面"，但会把一个无鉴权读面从"潜在可达"变成"必经依赖"，等于把信任边界下沉到桌面端。** 事实：8421 今天绑 `0.0.0.0:8421` 与 `[::]:8421`（`netstat -ano`；`MemoryKnowledge/src/server.ts:147` 未传 hostname，`config.ts:205` 无 host 键），**且无鉴权**——活体 `curl POST /v3/wiki/search -H 'x-tdai-service-id: default'`（无 Bearer）→ 200 有结果；只需 serviceId 头，任何本机/局域网进程都能调。即便日后配上 `KNOWLEDGE_SERVICE_KEY`，`/wiki/search` 仍在只读白名单（`MemoryKnowledge/src/middleware/auth.ts:47-54`，`:51`）⇒ 该缺口不会因配置而关闭。
⇒ 选 B 的意义：8421 仍是本机内部服务，暴露面不因接入而扩大；隔离与限速由 core 承担。**把 8421 收到 127.0.0.1、补 team 隔离属运维/知识库票，不属本票**，但 B 落地后它才不再是阻塞项。

## 7 未验证 / 风险

- core → 8421 的连通与超时行为未实测（只在本机 curl 过两个端点）。
- `/v3/wiki/search` 在配置 `KNOWLEDGE_SERVICE_KEY` 后的实际放行行为未实测，白名单结论依据 `MemoryKnowledge/src/middleware/auth.ts:47-54` 静态阅读。
- wiki 行按 `(serviceId,wikiId)` 存，现网 serviceId = `default`（其他 serviceId 查询活体返回 0）；转发层必须原样带 `default`，**不要拿调用方 spaceId 顶替**（proxy 用 `spaceId ?? config.knowledge.serviceId`，`MemoryProxy/src/injection/index.ts:347-371`，此处口径需实现时确认，否则恒 404）。
- `scm-business-analysis` (wiki-sm8cdo1j) `status=failed / sync_error="interrupted by restart"`：接进来对它恒 0 命中且静默，需在发现面按 `status` 过滤并 log 一条。
- proxy 的 `hop>0` 图展开收益本仓未复测（#85 记录不稳），B 的 MVP 建议 `hop=0`。
