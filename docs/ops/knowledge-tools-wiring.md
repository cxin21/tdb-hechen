# knowledge-tools 接线（task-94 / 票面 #task-95）

## 模块与接线（三处，全部在 dsh-plugin 侧）
1. **工具**：`src/tools/index.ts` 加一行 `import './knowledge.js';`（模块自注册，和 recall/skills 同一个 seam）。也可显式 `registerKnowledgeTools(api, runtimeOverride)`。
2. **注入段**：`registerVolatileKnowledgeSegment({ call: (p, b, o) => client.v3(p, b, o), identity: () => ({ teamId, userId, serviceId }), config: config.volatile.knowledge })`，每轮 `retrieve()` 拿 `{text, diagnostic, available}`；`text` 为空即不注入。
3. **配置键（需 dsh-plugin 在 src/config.ts 增）**：`volatile.knowledge { enabled true, maxChars 3000, maxResources 8, timeoutMs 2500 }`、`tools.knowledge` 开关；当前模块的 enabled 沿用 `config.tools.enabled`（未加专键）。

## 预算顺序 / 诊断 / reason
- 预算：固定段 → 记忆块 `volatile.maxChars` → wiki 段（task-74）→ **knowledge 段拿剩余量**（knowledge-segment.ts:renderKnowledgeBlock，整行贪心，放不下整行丢）。
- 诊断行：`knowledge=on resources=1 chars=270 ms=12 fail=-`。
- reason 全集：`disabled / no_identity / transport / http_<status> / bad_envelope / bad_payload / bad_scheme / too_large / empty_list / budget_zero / circuit_open`；工具侧多一个 `bad_tool`（tool_name 不在 tools/list 里，发出请求前就拒）。
- `reject=<n>`：本轮的 list 里有 n 个资源因 service_url 不是 http(s) 被丢弃（task-101），块本身仍照常注入可用资源。

## 真机读数（原文，采集时刻写死）
- **2026-11-01 02:05** `POST 8420/v3/knowledge/list` body `{"team_id":"team-2k12lgb650","pagination":{"limit":200}}` → **HTTP 200，651 字节**，`code:0`，`data.items` **1 条**：`knowledge_id=wiki-m6c41uvc`、`type=wiki`、`name=scm-standards`、`service_url=http://127.0.0.1:8421/v3`、`status=ready`、`summary` 112 码点（供应链开发规范知识库…用于指导代码编写与Review。）。
- **02:13** `POST 8421/v3/tools/list {"knowledge_id":"wiki-m6c41uvc"}` → **HTTP 200，2548 字节**，`status=ready`，**8 个工具**：`get_info() / search(query,limit) / list_pages() / read_page(refs) / wiki_fetch(doc_path,title,section) / get_graph() / list_raw() / read_raw(filenames)`。
- **02:13** 同一请求**去掉 Authorization**（仅 `x-tdai-service-id: default`）→ 仍 **HTTP 200 code:0** ⇒ 工具面不依赖 core 的 Bearer key，模块按此实现（`defaultKnowledgeRequest` 只带 service-id）。
- **02:13** `POST 8421/v3/tools/call {"knowledge_id":…,"tool_name":"search","params":{"query":"分布式锁","limit":2}}` → **HTTP 200，2897 字节**，`code:0`，`data.results[0].path=wiki/concepts\\数据格式档案.md`、`absScore=1.3056509123368298`（与 wiki 段同一条口径：合并/排序只认 absScore）。
- **02:41 端到端（真 8421，8420 腿用 02:05 捕获的 items）**：`knowledge_search("分布式锁", limit 2)` 返回两条真实命中（`wiki/concepts\\pklock-分布式锁机制.md`、`wiki/sources\\分布式锁与-redis-规范.md`）；`knowledge_read(get_info)` 返回 wiki 元信息 JSON；`knowledge_read(wiki_fetch, wiki/overview.md, 300)` 返回正文并以 `[truncated]` 收尾。

## 传输层（task-101：scheme 白名单 + 响应上限）
- **scheme 闸在数据边界**：`selectKnowledgeResources`（src/knowledge-segment.ts，第三参 `onReject`）丢掉 service_url 非 http(s) 的行，且**先判 scheme 再去重**，坏 URL 不会遮蔽后面同 id 的可用行。因为块渲染、`knowledge_search`、`knowledge_read`、tools/list 全都只吃这里产出的 `KnowledgeResource`，一处收口即覆盖四条腿。
- **第二道闸**：`executeKnowledgeTool` 入口再判一次（调用方可能直传 serviceUrl）→ `bad_scheme`，`ms:0`，零请求，且**不计入熔断失败**（坏 URL 是数据缺陷不是宕机）。
- **上限**：`defaultKnowledgeRequest` 不再 `await response.text()`，改走 `fetchJsonCapped`（src/http-capped.ts:131）→ 先按 content-length 判；无 content-length 则流式累加，超限即 `reader.cancel()`，返回 `too_large`。默认 2 MiB，可由 `KnowledgeHttpRequest` 的 `maxBytes` 下调（`executeKnowledgeTool` 透传）。
- **三者可分**：`bad_scheme`（未拨号）/ `http_404`（拨了被拒）/ `too_large`（答了但体过大）/ `circuit_open`（熔断拒绝）各自独立出词；熔断器始终包在 fetchJsonCapped **外面**（shouldAttempt → fetch → recordSuccess/recordFailure）。
- **RED 证据**（scratch/task-101/red-proof.cjs，逐条注释掉守卫再跑）：去掉 execute 守卫 → 2 例红；去掉边界闸 → 3 例红；去掉调用方 maxBytes → 1 例红；还原后 sha256 一致。单测 `test/knowledge-transport-cap.test.ts` 11 例。

## 未验边界（诚实登记）
- **8420 于 02:37 起无监听**（core 静默死亡，lead 已通告）⇒ 列表腿的**真机复核**只在宕机前做过一次；重构后未在 8420 复核，需重启后补一条 `knowledge=on resources=1` 日志。
- 注入段**未接进真实会话**（`src/index.ts` 归 dsh-plugin）：块渲染与 fail-open 只有单测 + 上面的手动 retrieve 证据，无「真轮次 prompt 里出现过 <knowledge_tools>」的取证。
- 未验证 8421 的 `deadlineHit`/`failed` 语义：`/tools/call` 单资源，没有 wiki 段那种多库合并，故不需要（也不假装有）。
- code-graph 类资源本 team 无实例 ⇒ 段里 `match` 锚点判定只有文案，没有真机对象。
- **熔断在生产接线里还没生效**（P1，属 dsh-plugin 的 src/segments/*）：`src/segments/knowledge.ts:23-32` 与 `src/segments/wiki.ts:29-34` 调 `registerVolatile*` 时**没有传 health**，全仓只有 `src/tools/knowledge.ts:115` 建了 breaker ⇒ core 腿每轮照打、`circuit=` 诊断不会出现。模块侧能力已备（含 20 例单测），等接线方补一行 `health: createSegmentHealth({ name: 'knowledge-core' })`。
- 真机 8421 的 `too_large` 未构造：上限只在单测里用 256 字节的流式假响应验证过。
