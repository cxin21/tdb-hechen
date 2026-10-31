# 能力段接线（wiki / knowledge 进 volatile 块）

任务：把 `src/wiki-segment.ts`（task-74）、`src/knowledge-segment.ts`（task-97）两个已测模块接到
`agent/pre-step` 的 volatile 块里。**两个模块归 bench-metrics，本轮一行未改**；本报告只记接线层。

## 1. 落点（谁注册、注册到哪）

| 文件 | 角色 |
| --- | --- |
| `dsh-plugin/src/segments/registry.ts` | 段缝本体：`registerVolatileSegment` / `runVolatileSegments`；本轮给 `SegmentDeps` 加 `query?: string`、给 `VolatileSegmentSpec` 加 `cap?: number` |
| `dsh-plugin/src/segments/wiki.ts` | `name:'wiki'`, `order:50`, `cap:800`，把本轮用户原文交给 `registerVolatileWikiSegment` 的 handle |
| `dsh-plugin/src/segments/knowledge.ts` | `name:'knowledge'`, `order:60`, `cap:3000`，调 handle 的 `retrieve({maxChars})` |
| `dsh-plugin/src/segments/index.ts` | barrel 两行 `import './wiki.js'; import './knowledge.js';`（在 `markBuiltins()` 之前） |
| `dsh-plugin/src/index.ts` | `appendCapabilitySegments()`：记忆块渲染完后，用剩余预算 + 剩余时限跑这两个段，再拼到块尾 |
| `dsh-plugin/src/tools/index.ts` | barrel 一行 `import './knowledge.js'`：`knowledge_search` / `knowledge_read` 自注册 |

加新段的代价因此是「一个文件 + barrel 一行」，`src/index.ts` 里没有段名清单。

## 2. 预算口径（与 docs/ops/wiki-segment-wiring.md 一致）

`volatile.maxChars`（缺省 1500）先被记忆块消费；能力段拿的是**剩余量**，不是两个 cap 相加：

```
remaining = volatile.maxChars - 记忆块字数 - (记忆块非空 ? 2 : 0)
每段实际上限 = min(本段 cap, 当前 remaining)
```

- 余量 `< 60` 字符 ⇒ 两个段都不跑（省两次网络往返），debug 记 `budget`。
- 时限用 `volatile.timeoutMs` 的**剩余**部分（再留 500ms 收尾），不足 300ms 直接跳过；跨段共用一个
  `Promise.race` 死线（`withDeadlineMs`，timer 已 `unref`），超时只丢能力段、不动记忆块。
- wiki 先（order 50）、knowledge 后（order 60）：wiki 有 `minScore` 门槛、命中率低，放前面不会挤掉知识段。

## 3. 缺省开关与理由

| 段 | 缺省 | 理由 |
| --- | --- | --- |
| `volatile.wiki.enabled` | **false** | 8420 的 `/v3/wiki/search` 从未答过（探针每次 404）。开着 = 每轮一个必然失败的请求；fail-open 只保证不出错，不保证不浪费 |
| `volatile.knowledge.enabled` | **true** | 2026-11-01 02:05 实测 `POST /v3/knowledge/list` 200 / 651 字节 / 7ms / 1 条资源（`wiki-m6c41uvc`, `service_url=http://127.0.0.1:8421/v3`）。空团队也只是一次廉价 list |

四个开关/上限（`enabled` + `maxChars` 各两个）都进了设置页：`VOLATILE_PATHS` 21 → 25。

## 4. 失败语义（fail-open，逐段隔离）

- 段返回 `null` ⇒ 视为「本轮不该有这一段」（例如 wiki 的 query 为空），记 `empty`，不记失败。
- 段的 `fetch` 抛错 ⇒ registry 捕获，记 `failed` + 零字符，其它段照常渲染（`segments.test.ts` 已覆盖）。
- 段的 `diagnostic.reason` 属于「正常答案」（wiki：`no_hits`/`empty_query`；knowledge：`empty_list`）⇒ 零字符但**不标 failed**，
  因为操作员的动作不同：空结果要去建 wiki/知识，失败要去修配置或等 core。
- 每轮各打一行模块自己的诊断：`wiki=on entries=3 chars=412 ms=37 fail=-`、`knowledge=on resources=1 chars=270 ms=12 fail=-`；
  组装层再打一行 `agemem: capability segments composed {segments:'wiki=empty:0 knowledge=ok:270', chars, budget}`。
- 超时另打 `agemem: capability segments missed the volatile deadline`（带 `budget` 与 `deadlineMs`）。

### 4.1 段级熔断（task-98 接线）

三段各一个 `createSegmentHealth()`（`src/segment-health.ts`，阈値 3 次 / 冷却 600s / 半开只探一次）：

| 段 | 熔断器在哪 | 失败分类 | 空答案 |
| --- | --- | --- | --- |
| `wiki` | `src/segments/wiki.ts`，随 memoized handle 一起建（每轮重建会把失败计数清零） | 模块内：`transport` / `http_<status>` / `bad_payload` | `no_hits` / `empty_query` 记**成功** |
| `knowledge` | `src/segments/knowledge.ts`，同上 | 同上 | `empty_list` 记**成功** |
| `skills` | `src/segments/skills.ts` 模块级单例（`healthOf(log)`），测试钩子 `resetSkillsSegmentHealthForTests()` | 我有状态码 ⇒ `http_<status>`，其余 ⇒ `transport`（**不写 `http_0`**） | 空 listing 记**成功**（`recordSuccess()` 在判空之前） |

熔断打开后：不再发请求、返回零字符；debug 行带 `circuit=open(http_404, 3, retryIn=540s)`；
wiki/knowledge 的诊断串由模块自己拼 `circuit=`（`describeWikiDiagnostic` / `describeKnowledgeDiagnostic`）。
单测 `test/segment-adapters.test.ts` 两条：连败三次后第四次不再打 `v3` / 不再调 `listing`。

## 5. ready 行

```
agemem: ready (..., skill=on(read), wiki=off, knowledge=on(3000), guidance=..., debug=off)
```

`wiki=` / `knowledge=` 只在 `volatile.enabled` 也打开时才是 `on(<cap>)`；否则 `off`。这样「段被开关关掉」
和「段跑了但没数据」在日志里第一眼就能分开。

## 6. 读数（本轮实测）

| 项 | 值 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 0 |
| `npx vitest run`（全仓 dsh-plugin） | **33 files / 584 tests passed**，Duration 60.33s |
| `npm run build` | rc 0 |
| parse-check（12 个改动文件） | 全部 `diags=0 PARSE OK` |
| 新增单测 | `test/segment-adapters.test.ts` 8 条（含 2 条熔断）；`test/config.test.ts` 新增 1 条（wiki/knowledge 缺省 + 夹取） |

单测覆盖的接线契约（模块内部逻辑由 bench-metrics 的文件自己测）：

1. 段顺序 `wiki=50 < knowledge=60`、`cap` 分别 800/3000、缺省开关 off/on；
2. knowledge 成功路径：`v3('/v3/knowledge/list', {team_id})` → 块里出现 `<knowledge_tools>` 与资源 id；
3. knowledge 断线（`v3` 抛 `ECONNREFUSED`）：零字符 + `failed`，但块整体不炸，诊断行仍进 log；
4. knowledge 空列表：零字符但**不**标 `failed`；
5. wiki query 为空（纯空格）：一次 `/v3/wiki/search` 都不发；
6. wiki 撞 404：零字符 + `failed`，`v3` 确实带着 query 打出去了。

## 7. 偏差与未验项

- **没有真机端到端读数**：8420 正在宕机（Lead 已知），knowledge 段与 `knowledge_search` 的真体读数沿用
  `docs/ops/knowledge-tools-wiring.md` 里 02:05 / 02:41 的两次实测（200/651 字节、`knowledge_search` 命中 2 条），
  本报告的「跑通了」只到单测层，**没有** 宿主里 `knowledge=on(...)` 的日志行。
- wiki 段在真机上从未跑过（路由不存在），其失败路径（`http_404`）只有单测模拟。
- `test/segments.test.ts` 的「零成本」用例需要 `resetSegmentsForTests({ keepBuiltins: false })`：barrel 现在自带
  wiki/knowledge 两个段，不清掉它们就会各付一次失败请求。
