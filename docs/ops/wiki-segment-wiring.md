# 插件 wiki 注入段 · 接线说明（task-74）

模块 `dsh-plugin/src/wiki-segment.ts`（自洽，不改 config.ts/index.ts/config-schema.ts）。
**未接真机：/v3/wiki/list 与 /v3/wiki/search 由 task-73 交付但 8420 未重启，本轮读数是单测 28 例，不是线上读数。**

## 1. 接线（一次）
```ts
// 传输用 MemoryClient 的公开 v3() 缝（同 src/skill-client.ts 的注入形态），
// 身份来自已解析的 server 配置；identity 用函数可跟随配置热更新。
const wiki = registerVolatileWikiSegment({
  call: (path, body, opts) => client.v3(path, body, opts),
  identity: () => ({ teamId: config.server.teamId, userId: config.server.userId }),
  config: config.volatile.wiki,   // 缺省/脏值由 resolveWikiSegmentConfig 兜底+夹取
  logger: log,
});
```
每次组装 volatile 块时：`const r = await wiki.retrieve(query, { maxChars: remaining })`，
`r.text` 为 `''` 就什么都不加（fail-open，永不抛）；`log.debug(wiki.describe(r))` 打一行诊断。

## 2. 预算分账顺序
1. 固定段（head pack / soul / guidance）不参与本预算；
2. `volatile.maxChars` 先由记忆块（recall hits，`formatVolatileBlock`）消费；
3. wiki 段**排最后**，`maxChars` 传「总预算 − 已用」，余量不足 23 码点（开闭标签）时模块直接返回 `''`；
4. 段内预算：开闭标签先预留 → 提示行（能放才放）→ 整行贪心，下一行放不下就整行丢弃（不切半行）；
   单行 `WIKI_ENTRY_MAX_CHARS=240` 码点，从 snippet 侧裁，来源标记与标题必留。

## 3. 诊断行
`wiki=on entries=3 chars=412 ms=37 fail=- [partial=1]`
失败态 `wiki=off ... fail=<reason>`，reason 取值：`disabled` / `empty_query` / `no_identity` /
`transport` / `http_<status>` / `bad_envelope`（HTTP 200 且 code≠0）/ `bad_payload` / `no_hits` /
`deadline_empty` / `budget_zero`。`partial=1` 表示 `meta.deadlineHit` 或有 wiki 失败——**有 results 就照常注入**。

## 4. 传输层（task-101：本模块没有自己的 fetch）
- `wiki-segment.ts` **零 fetch**：唯一出网路径是注入的 `call`，实际绑定 = `client.v3()` → `src/memory-client.ts:590` 的 `fetchJsonCapped`（maxBytes 走 `server.maxResponseBytes`，缺省 2 MiB；timeoutMs:0 由该方法自己的 controller 管取消）。所以 wiki 的每次 `/v3/wiki/*` 请求已经受 scheme 闸 + 字节上限保护，本票无需改本文件。
- 谁替换 `call` 就必须自己过 `fetchJsonCapped`：`src/segments/wiki.ts:30` 已在用 `deps.client.v3`，这是唯一生产接法（grep 全仓 `call:` 无第二处指向 wiki）。
- **未接熔断**（P1，属接线方）：`src/segments/wiki.ts:29-34` 没传 `health`，`circuit=` 不会出现；模块侧 `registerVolatileWikiSegment({health})` 已就绪并测过（test/segment-health.test.ts）。

## 5. 口径（勿按 score 改）
排序/去重用 `absScore`（score × 语料权重）与 `wikiId+path`；`score=0` 但 `absScore=1.2665` 的命中是正常强命中，
按 score 排序或加 score 门槛会把它误杀。`min_score` 只作为请求参数下发给 core，插件侧不二次过滤。
