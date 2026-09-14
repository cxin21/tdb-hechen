# wiki 自动召回测试版实现计划（WikiRecallInjector + WikiRetrieveClient）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MemoryProxy 注入管线新增 `WikiRecallInjector`（user.before 点），每轮按用户消息自动检索绑定 wiki 的 `/v3/wiki/search`，把 top-k 命中片段归一化后注入 `<tdai_recalled_wiki>` 块，作为可回退的测试版能力。

**Architecture:** 复用已下线记忆召回注入器的 `user.before` 范式，但要避开它下线的根因（每轮动态内容破坏 KV cache）——因此本测试版把"动态检索片段"控制为**小预算、低 minScore、按服务端序**注入；同时新增 `WikiRetrieveClient` 封装对知识服务的 HTTP 调用，复用 `CoreKnowledgeClient` 解析当前 agent 绑定的 wiki 资源。召回的内容 = 每条 `[wiki名] [type] score(norm) title + path + snippet`，排除 `related`，`hop>0` 标注 `[图展开]`。

**Tech Stack:** TypeScript / vitest / Node（tsx/esm），MemoryProxy 注入管线（InjectionHook / HookRegistry / AgentContext）。

**Spec:**
- `docs/superpowers/specs/2026-09-07-wiki-auto-recall-design.md`（主 spec：方向 B 测试版 + 收敛路径）
- `docs/superpowers/specs/2026-09-07-wiki-retrieval-investigation-design.md`（完整调研 + V1-V4 实测：宽度/降 minScore 有效、归一化必要、hop 暂缓）

## Global Constraints

- 仅改 `td-agemem/MemoryProxy`；**不动** MemoryCore / MemoryKnowledge / memory/knowledge 服务。
- **不替代** `<knowledge_tools>`：知识工具块（`knowledge-tools-injector`）保留，模型仍可 tools/call 读全文。
- 注入内容**排除** `related` 字段；`hop>0` 标注 `[图展开]`。
- score 在注入前端做 **per-query min-max 归一化到 [0,1]**；**以服务端返回顺序为排序基准，不 rescores**。
- `hop` 图展开**不默认开启**（V3 实测收益不稳 + 放宽与精读冲突），recall 请求默认 `hop=0`，minScore 请求端降到 0.01~0.02。
- 每轮注入**带预算**：默认 globalTopK=5、maxTotalChars 可配；空/失败 → 返回 `[]`。
- `cacheStrategy` 用 `"none"`（每轮动态，不缓存），`enabled` 配置 gate，`false` 时完全退化到现状。

---

### Task 1: WikiRetrieveClient — 知识服务 /wiki/search 的 HTTP 轻客户端

**Files:**
- Create: `MemoryProxy/src/knowledge/wiki-retrieve-client.ts`
- Test: `MemoryProxy/src/knowledge/__tests__/wiki-retrieve-client.test.ts`

**Interfaces:**
- Consumes: `KnowledgeItem`（来自 `./core-client.js`），用于取 `service_url` 与 `knowledge_id`。
- Produces:
  - `export interface WikiSearchHit { path: string; title: string; snippet: string; score: number; type: string; hop: number; via?: string; }`
  - `export interface WikiRetrieveClientOptions { timeoutMs?: number; }`
  - `export class WikiRetrieveClient { constructor(baseUrl: string, serviceId: string, opts?: WikiRetrieveClientOptions); search(params: { wikiId: string; query: string; limit?: number; minScore?: number; hop?: number; decay?: number; }): Promise<WikiSearchHit[]>; }`
  - `export interface WikiSearchEnvelope { code: number; message?: string; data?: { results?: WikiSearchHit[]; count?: number; }; }`

**说明：** `service_url` 已含 `/v3` 前缀（如 `http://host:8421/v3`），`/search` 接口路由是 `{service_url}/wiki/search`（挂载于 server.ts 的 v3 前缀下）。body 含 `wiki_id`（注意是 `wiki_id` 不是 `knowledge_id`）、`query`、`limit`、`minScore`、`hop`、`decay`；header 必须带 `x-tdai-service-id`。成功返回 `{code:0, data:{results:[...]}}`。

- [ ] **Step 1: 写失败测试**（请求构建 + 响应解析 + 错误处理）

```ts
// MemoryProxy/src/knowledge/__tests__/wiki-retrieve-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { WikiRetrieveClient } from "../wiki-retrieve-client.js";

const HIT = {
  path: "wiki/concepts/a.md", title: "A", snippet: "snip",
  score: 19.3, type: "concept", hop: 0,
};

describe("WikiRetrieveClient", () => {
  it("posts to {service_url}/wiki/search with wiki_id/query and x-tdai-service-id header", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 0, data: { results: [HIT], count: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const c = new WikiRetrieveClient(
      "http://ks:8421/v3", "default",
      { timeoutMs: 3000 },
    ) as unknown as { fetchImpl: typeof fetch };
    c.fetchImpl = fetchMock as unknown as typeof fetch;

    const hits = await c.search({ wikiId: "wiki-x", query: "暂估回冲", limit: 5, minScore: 0.01 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ks:8421/v3/wiki/search");
    const headers = init!.headers as Headers;
    expect(headers.get("x-tdai-service-id")).toBe("default");
    const body = JSON.parse(String(init!.body));
    expect(body.wiki_id).toBe("wiki-x");
    expect(body.query).toBe("暂估回冲");
    expect(body.limit).toBe(5);
    expect(body.minScore).toBe(0.01);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("A");
    expect(hits[0].hop).toBe(0);
  });

  it("strips related and normalizes absence of fields gracefully", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        code: 0,
        data: { results: [{ ...HIT, related: [{ title: "R", path: "p", type: "concept", direction: "both" }] }], count: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default") as unknown as { fetchImpl: typeof fetch };
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    const hits = await c.search({ wikiId: "w", query: "q" });
    expect(hits[0]).not.toHaveProperty("related");
  });

  it("returns [] on non-0 code", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 1, message: "err" }), { status: 200 },
    ));
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default") as unknown as { fetchImpl: typeof fetch };
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(c.search({ wikiId: "w", query: "q" })).resolves.toEqual([]);
  });

  it("returns [] on network failure (graceful degradation)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom"); });
    const c = new WikiRetrieveClient("http://ks:8421/v3", "default") as unknown as { fetchImpl: typeof fetch };
    c.fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(c.search({ wikiId: "w", query: "q" })).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-retrieve-client.test.ts`
Expected: FAIL（`Cannot find module '../wiki-retrieve-client.js'`）

- [ ] **Step 3: 写最小实现**

```ts
// MemoryProxy/src/knowledge/wiki-retrieve-client.ts
export interface WikiSearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  hop: number;
  via?: string;
}

export interface WikiRetrieveClientOptions {
  timeoutMs?: number;
}

export interface WikiSearchEnvelope {
  code: number;
  message?: string;
  data?: { results?: WikiSearchHit[]; count?: number };
}

export class WikiRetrieveClient {
  private readonly baseUrl: string;
  private readonly serviceId: string;
  private readonly timeoutMs: number;
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

  constructor(baseUrl: string, serviceId: string, opts: WikiRetrieveClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.serviceId = serviceId;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async search(params: {
    wikiId: string;
    query: string;
    limit?: number;
    minScore?: number;
    hop?: number;
    decay?: number;
  }): Promise<WikiSearchHit[]> {
    if (!params.wikiId || !params.query.trim()) return [];
    const body: Record<string, unknown> = {
      wiki_id: params.wikiId,
      query: params.query,
    };
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.minScore !== undefined) body.minScore = params.minScore;
    if (params.hop !== undefined) body.hop = params.hop;
    if (params.decay !== undefined) body.decay = params.decay;

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/wiki/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": this.serviceId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) return [];
      const env = (await resp.json()) as WikiSearchEnvelope;
      if (!env || env.code !== 0 || !Array.isArray(env.data?.results)) return [];
      // Strip `related` (deliberate): keeps only the fields the recall needs
      return env.data.results.map((r) => ({
        path: String(r.path ?? ""),
        title: String(r.title ?? ""),
        snippet: String(r.snippet ?? ""),
        score: Number(r.score ?? 0),
        type: String(r.type ?? "unknown"),
        hop: Number(r.hop ?? 0),
        ...(r.hop !== undefined && Number(r.hop) > 0 && r.via !== undefined
          ? { via: String(r.via) }
          : {}),
      }));
    } catch {
      return []; // graceful degradation — recall is non-critical
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-retrieve-client.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
cd MemoryProxy && git add src/knowledge/wiki-retrieve-client.ts src/knowledge/__tests__/wiki-retrieve-client.test.ts
git commit -m "feat(knowledge): wiki-retrieve-client for /v3/wiki/search with graceful degradation"
```

---

### Task 2: 召回片段归一化纯函数（per-query min-max → [0,1]）

**Files:**
- Modify: `MemoryProxy/src/knowledge/wiki-retrieve-client.ts`（追加纯函数，或独立 `wiki-recall-utils.ts`——本计划采用后者，职责单一）
- Create: `MemoryProxy/src/knowledge/wiki-recall-utils.ts`
- Test: `MemoryProxy/src/knowledge/__tests__/wiki-recall-utils.test.ts`

**Interfaces:**
- Consumes: `WikiSearchHit`（来自 `./wiki-retrieve-client.js`）
- Produces:
  - `export function normalizeScores(hits: WikiSearchHit[]): Array<WikiSearchHit & { normScore: number }>` —— per-query min-max 归一化到 [0,1]；空/单元素全 = null→1？不，best：max===min 时全部返回 1；空数组返回 []。归一化**不改变顺序**（仅附加 normScore 作展示）。
  - `export function applyRecallBudget(lines: string[], maxTotalChars: number, maxHits: number): string[]` —— 按条截断（code point 安全）且总字符预算，返回可能被截断/丢弃后的行数组。

**说明：** 归一化的意义（V2 实测）：AgentSkill `UPM 服务接口调用规范` raw=7.71 但 norm=1.00；raw 跨 wiki/跨源不可比，归一化后 LLM 才可读。预算函数对齐记忆 `truncateRecallLine` 的 surrogate-pair 安全逻辑（按 code point 截断）。

- [ ] **Step 1: 写失败测试**

```ts
// MemoryProxy/src/knowledge/__tests__/wiki-recall-utils.test.ts
import { describe, expect, it } from "vitest";
import { normalizeScores, applyRecallBudget } from "../wiki-recall-utils.js";
import type { WikiSearchHit } from "../wiki-retrieve-client.js";

function hit(score: number, title = "t"): WikiSearchHit {
  return { path: "p", title, snippet: "s", score, type: "concept", hop: 0 };
}

describe("normalizeScores", () => {
  it("maps [small..max] to [0..1] proportionally", () => {
    const out = normalizeScores([hit(2.27), hit(20.09)]);
    expect(out[0].normScore).toBeCloseTo(0, 3);
    expect(out[1].normScore).toBeCloseTo(1, 3);
    expect(out[0].title).toBe("t"); // order preserved
  });

  it("returns 1 for all when max===min", () => {
    const out = normalizeScores([hit(5), hit(5)]);
    expect(out[0].normScore).toBe(1);
    expect(out[1].normScore).toBe(1);
  });

  it("returns [] for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe("applyRecallBudget", () => {
  it("truncates by maxTotalChars keeping header intact", () => {
    const ants = "蚁".repeat(100); // 100 code points
    const lines = applyRecallBudget([`1. ${ants}`, `2. b`], 20, 10);
    const total = lines.join("\n").length;
    expect(total).toBeLessThanOrEqual(20 + 10); // header/sep slack
    expect(lines[0]).not.toContain(ants); // was truncated
  });

  it("caps by maxHits", () => {
    const lines = applyRecallBudget(["1", "2", "3", "4"], 0, 2);
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-recall-utils.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 写最小实现**

```ts
// MemoryProxy/src/knowledge/wiki-recall-utils.ts
import type { WikiSearchHit } from "./wiki-retrieve-client.js";

export type NormalizedHit = WikiSearchHit & { normScore: number };

export function normalizeScores(hits: WikiSearchHit[]): NormalizedHit[] {
  if (hits.length === 0) return [];
  const scores = hits.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return hits.map((h) => ({ ...h, normScore: 1 }));
  return hits.map((h) => ({
    ...h,
    normScore: parseFloat(((h.score - min) / (max - min)).toFixed(3)),
  }));
}

/** Truncate a string by code points (surrogate-pair safe), see memory truncateRecallLine. */
function truncateByCodePoint(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max).join("").trimEnd() + "…";
}

export function applyRecallBudget(
  lines: string[],
  maxTotalChars: number,
  maxHits: number,
): string[] {
  const capped = maxHits <= 0 ? lines : lines.slice(0, maxHits);
  if (maxTotalChars <= 0) return capped;
  const out: string[] = [];
  let used = 0;
  for (const line of capped) {
    const sep = out.length > 0 ? 1 : 0;
    const budget = maxTotalChars - used - sep;
    if (budget <= 0) break;
    const truncated = truncateByCodePoint(line, Math.max(0, budget));
    if (Array.from(truncated).length === 0) break;
    out.push(truncated);
    used += sep + Array.from(truncated).length;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-recall-utils.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/knowledge/wiki-recall-utils.ts src/knowledge/__tests__/wiki-recall-utils.test.ts
git commit -m "feat(knowledge): per-query score normalization + recall budget utils"
```

---

### Task 3: renderWikiRecallBlock 纯函数（渲染 <tdai_recalled_wiki>）

**Files:**
- Modify: `MemoryProxy/src/knowledge/wiki-recall-utils.ts`（追加，或独立 `wiki-recall-format.ts`——本计划复用同一文件，职责仍聚焦：归一化 + 预算 + 渲染）
- Test: `MemoryProxy/src/knowledge/__tests__/wiki-recall-format.test.ts`

**Interfaces:**
- Consumes: `WikiSearchHit`、`NormalizedHit`（来自 `./wiki-retrieve-client.js`、`./wiki-recall-utils.js`）
- Produces:
  - `export interface WikiRecallRenderEntry { wikiName: string; type: string; title: string; score: number; normScore: number; snippet: string; path: string; hop: number; }`
  - `export function renderWikiRecallBlock(entries: WikiRecallRenderEntry[]): string | null` —— 空数组 → `null`；否则渲染 `<tdai_recalled_wiki>` 块：每条含 `[wiki名] [type] score=norm title`、`path:`、snippet 缩进；`hop>0` 标注 `[图展开]`。带引导文案"片段仅供参考，需全文用 knowledge_tools read_page"。

**说明：** 渲染格式锁定（对齐主 spec §3.3）。

```
<tdai_recalled_wiki>
以下是当前轮用户问题自动召回的团队 wiki 片段（按相关度排序）；每条前的 [wiki:xxx] 标注其来源知识库（如 Coding-WiKi / Standards-WiKi / AgentSkill-WiKi），多 wiki 命中时据此区分来源。
仅辅助回答当前这一轮；若需完整正文，请用 <knowledge_tools> 里的 tools/call wiki read_page（path 见下）。

1. [wiki:Coding-WiKi] [concept] score=0.62 — 暂估应收回冲机制
   path: wiki/concepts/暂估应收回冲机制.md
   发票审批结算时按累计暂估数量生成回冲暂估应收单的机制...
</tdai_recalled_wiki>
```

- [ ] **Step 1: 写失败测试**

```ts
// MemoryProxy/src/knowledge/__tests__/wiki-recall-format.test.ts
import { describe, expect, it } from "vitest";
import { renderWikiRecallBlock } from "../wiki-recall-utils.js";
import type { WikiRecallRenderEntry } from "../wiki-recall-utils.js";

const e = (over: Partial<WikiRecallRenderEntry>): WikiRecallRenderEntry => ({
  wikiName: "Coding-WiKi", type: "concept", title: "暂估应收回冲机制", score: 13.3,
  normScore: 0.62, snippet: "机制说明", path: "wiki/concepts/a.md", hop: 0, ...over,
});

describe("renderWikiRecallBlock", () => {
  it("returns null for empty entries", () => {
    expect(renderWikiRecallBlock([])).toBeNull();
  });

  it("renders wiki name, type, norm score, title, path, snippet", () => {
    const text = renderWikiRecallBlock([e({})])!;
    expect(text).toContain("<tdai_recalled_wiki>");
    expect(text).toContain("[Coding-WiKi] [concept] score=0.62");
    expect(text).toContain("path: wiki/concepts/a.md");
    expect(text).toContain("机制说明");
  });

  it("marks hop>0 as [图展开]", () => {
    const text = renderWikiRecallBlock([e({ hop: 1, via: "发票" })])!;
    expect(text).toContain("[图展开]");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-recall-format.test.ts`
Expected: FAIL（`renderWikiRecallBlock is not a function`）

- [ ] **Step 3: 写最小实现**

```ts
// MemoryProxy/src/knowledge/wiki-recall-utils.ts （追加）
export interface WikiRecallRenderEntry {
  wikiName: string;
  type: string;
  title: string;
  score: number;
  normScore: number;
  snippet: string;
  path: string;
  hop: number;
}

export function renderWikiRecallBlock(entries: WikiRecallRenderEntry[]): string | null {
  if (!entries || entries.length === 0) return null;
  const lines: string[] = [
    "<tdai_recalled_wiki>",
    "以下是当前轮用户问题自动召回的团队 wiki 片段（按相关度排序，来自各知识库），",
    "仅辅助回答当前这一轮；若需完整正文，请用 <knowledge_tools> 里的 tools/call wiki read_page（path 见下）。",
    "",
  ];
  entries.forEach((e, i) => {
    const hopTag = e.hop > 0 ? " [图展开]" : "";
    lines.push(`${i + 1}. [${e.wikiName}] [${e.type}] score=${e.normScore.toFixed(2)}${hopTag} — ${e.title}`);
    if (e.path) lines.push(`   path: ${e.path}`);
    if (e.snippet) lines.push(`   ${e.snippet}`);
  });
  lines.push("</tdai_recalled_wiki>");
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd MemoryProxy && npx vitest run src/knowledge/__tests__/wiki-recall-format.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/knowledge/wiki-recall-utils.ts src/knowledge/__tests__/wiki-recall-format.test.ts
git commit -m "feat(knowledge): render <tdai_recalled_wiki> block pure function"
```

---

### Task 4: WikiRecallInjector — user.before 动态召回注入器

**Files:**
- Create: `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts`
- Test: `MemoryProxy/src/injection/injectors/__tests__/wiki-recall-injector.test.ts`

**Interfaces:**
- Consumes:
  - `InjectionHook`, `AgentContext`, `ContextBlock`, `HookPriority`（`../../injection/types.js`）
  - `getTdaiIdentity`（`../../tdai/identity.js`）
  - `getLastUserMessage`, `getMessageText`（`../../context.js`）
  - `extractUserQueryText`（`../../tdai/recorder.js`）
  - `CoreKnowledgeClient`（`../../knowledge/core-client.js`）
  - `WikiRetrieveClient`（`../../knowledge/wiki-retrieve-client.js`）
  - `normalizeScores`, `applyRecallBudget`, `renderWikiRecallBlock`（`../../knowledge/wiki-recall-utils.js`）
- Produces: `export class WikiRecallInjector implements InjectionHook`、`export interface WikiRecallInjectorConfig`、`export interface WikiRecallInjectorDeps`

**配置结构（依赖注入，便于测试）：**
```ts
export interface WikiRecallInjectorConfig {
  enabled: boolean;
  perWikiLimit: number;   // default 8
  globalTopK: number;     // default 5
  minScore: number;       // default 0.02
  hop: number;            // default 0 (hop 不默认开启, V3)
  decay: number;          // default 0.5 (reserved, not passed unless hop>0)
  maxTotalChars: number;  // default 0 = 不限制
}
export interface WikiRecallInjectorDeps {
  knowledgeClient: CoreKnowledgeClient;
  retrieveClientFactory: (serviceUrl: string) => WikiRetrieveClient;  // 按各绑定 wiki 的 service_url 构造（多端点安全）
  identityResolver: (ctx: AgentContext) => ReturnType<typeof getTdaiIdentity>;
  listBoundWiki: (ctx: AgentContext, ids: string[], teamId: string) => Promise<KnowledgeItem[]>;
}
```

> **关键设计决策（列表绑定解析的两条路径）**：`KnowledgeToolsInjector` 走 `listAgentKnowledgeIds(agentId,userKey)` → `listKnowledgeByIds` 解析 per-agent 绑定 wiki。`WikiRecallInjector` **复用同一 `CoreKnowledgeClient`**（deps 注入），在 execute 里调用同样的 `listAgentKnowledgeIds + listKnowledgeByIds` 解析 `type==="wiki"` 资源。`listBoundWiki` 默认实现即走此路径；测试注入 fake。
> **跨端点安全**：`retrieveClientFactory(serviceUrl)` 按**每个绑定 wiki 各自的 service_url** 构造客户端——避免多端点 wiki 漏查（装配端实现，见 Task 5）。

- [ ] **Step 1: 写失败测试**（身份解析 → 取 query → 解析绑定 wiki → 并行检索 → 归一化/预算/渲染 → 注入）

```ts
// MemoryProxy/src/injection/injectors/__tests__/wiki-recall-injector.test.ts
import { describe, expect, it, vi } from "vitest";
import { WikiRecallInjector } from "../wiki-recall-injector.js";
import type { AgentContext } from "../../types.js";
import type { WikiSearchHit } from "../../../knowledge/wiki-retrieve-client.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";

function mkCtx(content: string): AgentContext {
  return {
    messages: [{ role: "user", content }],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: "t", keyId: "k", modelId: "m", stream: false, agentSource: "dsh",
      custom: { session: { user_id: "u", team_id: "team", agent_id: "agent", space_id: "default" } },
    },
  } as unknown as AgentContext;
}

const wikiItem: KnowledgeItem = {
  knowledge_id: "wiki-x", type: "wiki", service_url: "http://ks:8421/v3",
  name: "Coding-WiKi", summary: "s", team_id: "team", user_id: null,
  created_at: "", updated_at: "",
} as KnowledgeItem;

describe("WikiRecallInjector", () => {
  const hit: WikiSearchHit = {
    path: "wiki/concepts/a.md", title: "A", snippet: "机制说明",
    score: 13.3, type: "concept", hop: 0,
  };

  function build() {
    const retrieve = { search: vi.fn(async () => [hit]) };
    const knowledge = { listAgentKnowledgeIds: vi.fn(async () => ["wiki-x"]) };
    const injector = new WikiRecallInjector({
      enabled: true, perWikiLimit: 8, globalTopK: 5, minScore: 0.02,
      hop: 0, decay: 0.5, maxTotalChars: 0,
    }, {
      knowledgeClient: knowledge as unknown as ConstructorParameters<typeof WikiRecallInjector>[1]["knowledgeClient"],
      retrieveClientFactory: () => retrieve as never,
      identityResolver: () => ({ teamId: "team", agentId: "agent", userId: "u", sessionId: "s" }),
      listBoundWiki: async () => [wikiItem],
    });
    return { injector, retrieve, knowledge };
  }

  it("injects <tdai_recalled_wiki> when binds+retrieve hit", async () => {
    const { injector, retrieve, knowledge } = build();
    const blocks = await injector.execute(mkCtx("应收暂估回冲怎么处理"));
    expect(knowledge.listAgentKnowledgeIds).toHaveBeenCalledWith("agent", "u", { serviceId: "default" });
    expect(retrieve.search).toHaveBeenCalledWith(expect.objectContaining({ wikiId: "wiki-x", minScore: 0.02 }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("<tdai_recalled_wiki>");
    expect(blocks[0].content).toContain("[Coding-WiKi] [concept] score=1.00");
  });

  it("returns [] when identity missing", async () => {
    const { injector } = build();
    const blocks = await injector.execute({
      ...mkCtx("q"),
      metadata: { ...mkCtx("q").metadata, custom: {} },
    });
    expect(blocks).toEqual([]);
  });

  it("returns [] when no wiki bound", async () => {
    const { injector, retrieve } = build();
    (injector as unknown as { deps: { listBoundWiki: () => Promise<KnowledgeItem[]> } }).deps.listBoundWiki = async () => [];
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
    expect(retrieve.search).not.toHaveBeenCalled();
  });

  it("returns [] when disabled", async () => {
    const injector = new WikiRecallInjector(
      { enabled: false, perWikiLimit: 8, globalTopK: 5, minScore: 0.02, hop: 0, decay: 0.5, maxTotalChars: 0 },
      { knowledgeClient: {} as never, retrieveClientFactory: () => ({ search: vi.fn(async () => []) }) as never, identityResolver: () => ({ teamId: "team" }), listBoundWiki: async () => [wikiItem] },
    );
    expect(await injector.execute(mkCtx("q"))).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryProxy && npx vitest run src/injection/injectors/__tests__/wiki-recall-injector.test.ts`
Expected: FAIL（module not found / constructor mismatch）

- [ ] **Step 3: 写最小实现**

```ts
// MemoryProxy/src/injection/injectors/wiki-recall-injector.ts
import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../../injection/types.js";
import { HOOK_PRIORITY } from "../../injection/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { getLastUserMessage, getMessageText } from "../../context.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { CoreKnowledgeClient, KnowledgeItem } from "../../knowledge/core-client.js";
import type { WikiRetrieveClient, WikiSearchHit } from "../../knowledge/wiki-retrieve-client.js";
import { applyRecallBudget, normalizeScores, renderWikiRecallBlock, type WikiRecallRenderEntry } from "../../knowledge/wiki-recall-utils.js";

export interface WikiRecallInjectorConfig {
  enabled: boolean;
  perWikiLimit: number;
  globalTopK: number;
  minScore: number;
  hop: number;
  decay: number;
  maxTotalChars: number;
}

export interface WikiRecallInjectorDeps {
  knowledgeClient: CoreKnowledgeClient;
  /** Per-service_url client factory — safe against cross-endpoint wikis. */
  retrieveClientFactory: (serviceUrl: string) => WikiRetrieveClient;
  identityResolver: (ctx: AgentContext) => ReturnType<typeof getTdaiIdentity> | undefined;
  /** Resolve bound wiki resources for the current agent. Default impl uses CoreKnowledgeClient. */
  listBoundWiki: (
    ctx: AgentContext,
    teamId: string,
    agentId: string | undefined,
    userKey: string | undefined,
    spaceId: string | undefined,
  ) => Promise<KnowledgeItem[]>;
}

export class WikiRecallInjector implements InjectionHook {
  id = "wiki-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 1; // right after memory recall
  description = "Auto-recall team wiki snippets per turn (test-bed, direction B)";
  cacheStrategy = "none" as const;

  constructor(
    private config: WikiRecallInjectorConfig,
    private deps: WikiRecallInjectorDeps,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    if (!this.config.enabled) return [];
    const identity = this.deps.identityResolver(ctx);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
    if (!query) return [];

    const session = (ctx.metadata.custom as any)?.session ?? {};
    const userKey = session.user_key as string | undefined;
    const spaceId = session.space_id as string | undefined;

    const bound = await this.deps.listBoundWiki(ctx, identity.teamId, identity.agentId, userKey, spaceId);
    const wikis = bound.filter((r) => r.type === "wiki");
    if (wikis.length === 0) return [];

    // Parallel search all bound wikis — each by its own service_url endpoint
    const groups = await Promise.all(
      wikis.map(async (w) => {
        const hits = await this.deps.retrieveClientFactory(w.service_url).search({
          wikiId: w.knowledge_id,
          query,
          limit: this.config.perWikiLimit,
          minScore: this.config.minScore,
          ...(this.config.hop > 0 ? { hop: this.config.hop, decay: this.config.decay } : {}),
        });
        return hits.map((h) => ({ ...h, wikiName: w.name }));
      }),
    );

    const all: Array<WikiSearchHit & { wikiName: string }> = ([] as typeof groups[number]).concat(...groups);
    if (all.length === 0) return [];

    // NOTE: order = server order (RRF), no rescoring; normalize only for display
    const normalized = normalizeScores(all).slice(0, this.config.globalTopK);
    const entries: WikiRecallRenderEntry[] = normalized.map((n) => ({
      wikiName: n.wikiName,
      type: n.type,
      title: n.title,
      score: n.score,
      normScore: n.normScore,
      snippet: n.snippet,
      path: n.path,
      hop: n.hop,
    }));
    const rawRendered = renderWikiRecallBlock(entries);
    if (!rawRendered) return [];
    const budgeted = applyRecallBudget(rawRendered.split("\n"), this.config.maxTotalChars, 0);
    const rendered = budgeted.join("\n");

    return [{
      type: "text",
      content: rendered,
      metadata: { source: this.id, count: normalized.length, wikis: wikis.map((w) => w.name) },
    }];
  }
}
```

> **注**：`listBoundWiki` 默认实现不在 Task 4 内置——它在 Task 5 的构建/装配层接入真实 `CoreKnowledgeClient.listAgentKnowledgeIds + listKnowledgeByIds`。测试全部走注入的 fake。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd MemoryProxy && npx vitest run src/injection/injectors/__tests__/wiki-recall-injector.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/injection/injectors/wiki-recall-injector.ts src/injection/injectors/__tests__/wiki-recall-injector.test.ts
git commit -m "feat(injection): WikiRecallInjector (user.before dynamic wiki recall, test-bed)"
```

---

### Task 5: 装配接入 —— register WikiRecallInjector + 默认绑定解析

**Files:**
- Modify: `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts`（补默认 `listBoundWiki` 用 `CoreKnowledgeClient` 绑定解析 + 顶部注释）
- Modify: `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts`（导出默认绑定解析纯函数供装配用）
- Modify: `MemoryProxy/src/injection/index.ts`（新增 register 分支 + config 读取）
- Modify: `MemoryProxy/src/types.ts`（ProxyConfig 增加 `wikiRecall` 配置段，或读现有 `config.injection.injectors`）
- Test: `MemoryProxy/src/injection/injectors/__tests__/wiki-recall-injector.test.ts`（追加装配级测试：真实 knowledgeClient mock 下 listBoundWiki 走 listAgentKnowledgeIds+listKnowledgeByIds）

**Interfaces:**
- Consumes: `CoreKnowledgeClient.listAgentKnowledgeIds` / `listKnowledgeByIds`；`KnowledgeToolsInjector` 注册模式（`injection/index.ts` 的 `shouldRegisterKnowledgeInjector` 分支）
- Produces:
  - `export function resolveBoundWikiResources(teamId, agentId, userKey, spaceId, client): Promise<KnowledgeItem[]>` —— 默认绑定解析：agent 有 userKey → `listAgentKnowledgeIds` → `listKnowledgeByIds` 过滤 type==="wiki"；否则 team 全量 `listKnowledge` 过滤 type==="wiki"。
  - `export function shouldRegisterWikiRecallInjector(config): boolean` —— 与现有 `shouldRegisterKnowledgeInjector` 判定对齐：`injectors.includes("knowledge")` **且** `config.knowledge.enabled` **且** `config.knowledge.serviceToken` 非空 **且** `config.wikiRecall.enabled !== false`。对照 `injection/index.ts:499-503` 的既有判定。

- [ ] **Step 1: 写失败测试**（装配级：默认 listBoundWiki / shouldRegister 判定）

```ts
// 追加到 wiki-recall-injector.test.ts
import { resolveBoundWikiResources, shouldRegisterWikiRecallInjector } from "../wiki-recall-injector.js";

describe("resolveBoundWikiResources", () => {
  it("per-agent path: listAgentKnowledgeIds → listKnowledgeByIds → filter wiki", async () => {
    const client = {
      listAgentKnowledgeIds: async () => ["wiki-1", "cg-1"],
      listKnowledgeByIds: async () => [
        { knowledge_id: "wiki-1", type: "wiki", name: "W", service_url: "u", team_id: "team", user_id: null, summary: null, created_at: "", updated_at: "" },
        { knowledge_id: "cg-1", type: "code-graph", name: "C", service_url: "u", team_id: "team", user_id: null, summary: null, created_at: "", updated_at: "" },
      ],
    };
    const out = await resolveBoundWikiResources("team", "agent", "u-key", "default", client as never);
    expect(out.map((r) => r.knowledge_id)).toEqual(["wiki-1"]);
  });

  it("fallback team path returns team wikis when no agent userKey", async () => {
    const client = { listKnowledge: async () => [{ knowledge_id: "wiki-t", type: "wiki", name: "TW", service_url: "u", team_id: "team", user_id: null, summary: null, created_at: "", updated_at: "" }] };
    const out = await resolveBoundWikiResources("team", undefined, undefined, undefined, client as never);
    expect(out[0].knowledge_id).toBe("wiki-t");
  });
});

describe("shouldRegisterWikiRecallInjector", () => {
  it("true only when knowledge enabled + serviceToken set + wikiRecall enabled", () => {
    const base = { injection: { injectors: ["knowledge"] }, knowledge: { enabled: true, serviceToken: "tok" } };
    expect(shouldRegisterWikiRecallInjector({ ...base, wikiRecall: { enabled: true } } as never)).toBe(true);
    expect(shouldRegisterWikiRecallInjector({ ...base, wikiRecall: { enabled: false } } as never)).toBe(false);
    expect(shouldRegisterWikiRecallInjector({ ...base, knowledge: { enabled: false, serviceToken: "tok" } } as never)).toBe(false);
    expect(shouldRegisterWikiRecallInjector({ injection: { injectors: ["skill"] }, knowledge: { enabled: true, serviceToken: "tok" }, wikiRecall: { enabled: true } } as never)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryProxy && npx vitest run src/injection/injectors/__tests__/wiki-recall-injector.test.ts`
Expected: FAIL（module not exported）

- [ ] **Step 3: 写实现**（在 wiki-recall-injector.ts 追加）

```ts
export async function resolveBoundWikiResources(
  teamId: string,
  agentId: string | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
  client: CoreKnowledgeClient,
): Promise<KnowledgeItem[]> {
  const serviceId = spaceId || undefined;
  if (agentId && userKey) {
    const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId });
    if (ids.length === 0) return [];
    const all = await client.listKnowledgeByIds(teamId, ids, { serviceId });
    return all.filter((r) => r.type === "wiki");
  }
  const all = await client.listKnowledge(teamId, { serviceId });
  return all.filter((r) => r.type === "wiki");
}

export function shouldRegisterWikiRecallInjector(config: {
  injection?: { injectors?: string[] };
  knowledge?: { enabled?: boolean; serviceToken?: string };
  wikiRecall?: { enabled?: boolean };
}): boolean {
  return (config.injection?.injectors?.includes("knowledge") ?? false)
    && config.knowledge?.enabled === true
    && !!config.knowledge?.serviceToken
    && config.wikiRecall?.enabled !== false;
}
```

并在 `injection/index.ts` 注入列表内补充注册分支（紧邻 `KnowledgeToolsInjector`，参考其 `shouldRegister` 门控）：

```ts
if (shouldRegisterWikiRecallInjector(config)) {
  const knowledgeClient = getCoreKnowledgeClient(config.knowledge);
  // retrieveClient 按每个绑定 wiki 的 service_url 分别构造（多端点安全），
  // 故 deps 用一个 factory；`identityResolver` 复用现有 getTdaiIdentity。
  const makeRetrieve = (serviceUrl: string) =>
    new WikiRetrieveClient(
      serviceUrl,
      config.knowledge.serviceId ?? "default",
      { timeoutMs: 3000 },
    );
  registry.register(new WikiRecallInjector(
    config.wikiRecall ?? defaultWikiRecallConfig,
    {
      knowledgeClient,
      retrieveClientFactory: (serviceUrl: string) => makeRetrieve(serviceUrl),
      identityResolver: getTdaiIdentity,
      listBoundWiki: resolveBoundWikiResources,
    },
  ));
}
```

> **配置字段**：新增 `config.wikiRecall`（enabled/perWikiLimit/globalTopK/minScore/hop/decay/maxTotalChars），在 `types.ts` 的 `ProxyConfig` 声明 + config 解析补默认值。装配沿用 `shouldRegisterKnowledgeInjector` 的门控约定。
> **待确认项1 的采纳**：`WikiRetrieveClient` 从"单实例基址"改为 **`retrieveClientFactory`（按 service_url 构造）**——避免多端点 wiki 漏查。Task 4 的 `WikiRecallInjectorDeps` 相应把 `retrieveClient: WikiRetrieveClient` 改为 `retrieveClientFactory: (serviceUrl: string) => WikiRetrieveClient`，execute 内 `this.deps.retrieveClientFactory(w.service_url).search(...)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd MemoryProxy && npx vitest run src/injection/injectors/__tests__/wiki-recall-injector.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 全部测试 + 提交**

Run:
```bash
cd MemoryProxy && npx tsc --noEmit && npx vitest run
```
Expected: typecheck PASS；全部 tests PASS
```bash
git add src/injection/index.ts src/types.ts src/injection/injectors/wiki-recall-injector.ts src/injection/injectors/__tests__/wiki-recall-injector.test.ts src/knowledge/wiki-retrieve-client.ts src/knowledge/wiki-recall-utils.ts
git commit -m "feat(injection): wire up WikiRecallInjector registration + default bound-wiki resolution"
```

---

### Task 6: 回归验证 + 运行时可观测性备注

**Files:**
- 无新文件（可选：injector 顶部加 observer-friendly 注释）

**Interfaces:**
- 复用 `InjectionPipeline` 既有 `InjectionObserver`（会自动记录 injector 的 durationMs/blockCount）。

- [ ] **Step 1: 跑全量测试 + typecheck 确认无回归**

Run: `cd MemoryProxy && npx tsc --noEmit && npx vitest run`
Expected: PASS 全部（既有测试 + 新增 4 个测试文件）

- [ ] **Step 2: 手动连通冒烟（本地起的 proxy + 真实 8421）**

Run: 配 `injectors:["knowledge"]` + `wikiRecall.enabled:true`，构造一条带 wiki 绑定的 user turn，观察日志：
```
[injection] ✓ Hook "wiki-recall-injector" successfully injected 1 block(s) at point "user.before"
[injection]   → text preview: "<tdai_recalled_wiki>..."
```
Expected: 出现上述注入日志；无 wiki 绑定时零注入。

- [ ] **Step 3: 观测备注（写进 injector 注释）**

记录：observer 已自动采集 durationMs / blockCount；测试期关注 VM 缓存命中/命中收益指标（见 spec §6.1），据此走收敛判定（B/C/A/关闭）。

- [ ] **Step 4: 提交（若有改动）**

---

## 待确认项（Implementation-blocking unknowns）

1. **`service_url` 多端点问题（已由 factory 采纳 + 待装配核实）**：设计已改为 `retrieveClientFactory(serviceUrl)` 按每个绑定 wiki 的 service_url 构造，**逻辑上解除了"单端点"假设**；但仍需在装配后核实 3 个 wiki 的 service_url 是否一致（本调研实测全 `http://10.4.100.30:8421/v3`，倾向一致），不一致时只需确保每个 wiki 的 `service_url` 被正确用于各自的 factory。**需在装配集成测试中核验**。
2. **`config.wikiRecall` 配置字段命名与放置**：与既有 `config.injection.injectors` 的关系（是否应作为独立 config 段 vs 复用 injectors 列表）。需对齐 `KnowledgeToolsInjector` 的配置惯例。
3. **`getTdaiIdentity` 返回类型的空态**：identity 可能缺 sessionId/spaceId，`resolveBoundWikiResources` 的 serviceId 在下游怎么兜底（Aligned 于 memory 侧：spaceId 空用 config.serviceId）。
4. **Coding-WiKi ingesting 完成前测试基线**：当前 `last_sync` 滞后、`status=processing`。装配后集成测试应等其转 ready 再定基准，否则分数/向量不稳定。

## 待测试项（Explicit test checklist）

- WikiRetrieveClient：请求 URL/header/body 正确性、related 剥离、非 0 code → []、网络异常 → []。
- normalizeScores：跨源混排（2.27 vs 20.09）→ [0..1]、max===min → 全 1、空 → []。
- applyRecallBudget：超大单条按码点截断、maxHits 封顶、总字符预算。
- renderWikiRecallBlock：空 → null；含 wiki名/type/norm score/title/path/snippet；hop>0 标注 [图展开]。
- WikiRecallInjector：注入命中块、identity 缺失 → []、无绑定 → []、disabled → []、并行多 wiki、查询清洗、全局 topK 封顶。
- resolveBoundWikiResources：per-agent 路径过滤 type==="wiki"、team 全量 fallback。
- shouldRegisterWikiRecallInjector：enabled+knowledge 开关组合判定。
- 装配/回归：typecheck、全量 vitest、手动冒烟日志。
- （Coding 转 ready 后）按真实 wiki 复测召回质量即时基准。

## 待完善项（Backlog / 收敛期增强，本计划不含）

- 后端 `searchInternal` score 字段归一化（本计划是前端归一化展示；后端归一化属后端改动，另立）。
- `searchInternal` 默认 `minScore=0.1→0.02`、`hop` 策略（V3 实测 hop 收益不稳，默认不开，留收敛期评估）。
- FTS `title_tok` 权重 5.0 下调（准确性增强，需 A/B 验证，另立）。
- `makeSnippet` query-aware 关键段抽取（snippet 信息密度，高优先，另立，属 MemoryKnowledge）。
- `.agent-teams` wiki 图展开 hop 相关测试、图行走参数校准。
- 测试期 KV cache 命中率观测与收敛判定报告（B vs A vs C）。