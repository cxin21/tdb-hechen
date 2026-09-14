import { describe, expect, it, vi } from "vitest";
import { WikiRecallInjector, resolveBoundWikiResources, shouldRegisterWikiRecallInjector } from "../wiki-recall-injector.js";
import type { WikiRecallInjectorDeps, WikiRecallInjectorConfig } from "../wiki-recall-injector.js";
import type { AgentContext } from "../../types.js";
import type { WikiRetrieveClient, WikiSearchHit } from "../../../knowledge/wiki-retrieve-client.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import type { TdaiIdentity } from "../../../tdai/types.js";
import { log } from "../../../report/log.js";

const hit: WikiSearchHit = {
  path: "wiki/concepts/a.md",
  title: "A",
  snippet: "机制说明",
  score: 13.3,
  type: "concept",
  hop: 0,
};

const wikiItem: KnowledgeItem = {
  knowledge_id: "wiki-x",
  type: "wiki",
  service_url: "http://ks:8421/v3",
  name: "Coding-WiKi",
  summary: "s",
  team_id: "team",
  user_id: null,
  created_at: "",
  updated_at: "",
} as KnowledgeItem;

const baseConfig: WikiRecallInjectorConfig = {
  enabled: true,
  perWikiLimit: 8,
  globalTopK: 5,
  minScore: 0.02,
  hop: 0,
  decay: 0.5,
  maxTotalChars: 0,
  // 单测里关闭注入门槛（0 = 不启用），专注验证排序；门槛逻辑单独测试。
  minInjectNormScore: 0,
};

function mkCtx(content: string): AgentContext {
  return {
    messages: [{ role: "user", blocks: [{ type: "text", content }] }],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: "t",
      keyId: "k",
      modelId: "m",
      stream: false,
      agentSource: "dsh",
      custom: {
        session: {
          user_id: "u",
          team_id: "team",
          agent_id: "agent",
          space_id: "default",
        },
      },
    },
  } as unknown as AgentContext;
}

describe("WikiRecallInjector", () => {
  const config = { ...baseConfig };

  function build(overrides: {
    enabled?: boolean;
    identity?: unknown;
    config?: Partial<WikiRecallInjectorConfig>;
    listBoundWiki?: WikiRecallInjectorDeps["listBoundWiki"];
    searchImpl?: () => Promise<WikiSearchHit[]>;
    factory?: (serviceUrl: string, serviceId?: string) => WikiRetrieveClient;
  } = {}) {
    const factoryCalls: string[] = [];
    const factoryServiceIds: Array<string | undefined> = [];
    const search = vi.fn(overrides.searchImpl ?? (async () => [hit]));
    const defaultClient = { search } as unknown as WikiRetrieveClient;
    const retrieveClientFactory = (serviceUrl: string, serviceId?: string): WikiRetrieveClient => {
      factoryCalls.push(serviceUrl);
      factoryServiceIds.push(serviceId);
      if (overrides.factory) return overrides.factory(serviceUrl, serviceId);
      return defaultClient;
    };
    const identityResult: TdaiIdentity | null | undefined =
      overrides.identity === undefined
        ? { teamId: "team", agentId: "agent", userId: "u", sessionId: "s" }
        : (overrides.identity as TdaiIdentity | null | undefined);
    const deps: WikiRecallInjectorDeps = {
      knowledgeClient: {} as WikiRecallInjectorDeps["knowledgeClient"],
      retrieveClientFactory,
      identityResolver: () => identityResult,
      listBoundWiki: overrides.listBoundWiki ?? (async () => [wikiItem]),
    };
    const injector = new WikiRecallInjector(
      { ...config, ...overrides.config, enabled: overrides.enabled ?? config.enabled },
      deps,
    );
    return { injector, search, factoryCalls, factoryServiceIds, client: defaultClient };
  }

  it("injects <tdai_recalled_wiki> when binding + retrieve hit", async () => {
    const { injector, search } = build();
    const blocks = await injector.execute(mkCtx("应收暂估回冲怎么处理"));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ wikiId: "wiki-x", minScore: 0.02 }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("<tdai_recalled_wiki>");
    expect(blocks[0].content).toContain("[wiki:Coding-WiKi] [concept] score=1.00");
  });

  it("does NOT let an earlier-bound wiki crowd out a later-bound wiki's higher-scored hits (regression: slice-before-sort)", async () => {
    // 场景：Standards（绑在前）全是中等分、Coding（绑在后）命中一条高分精准页。
    // 修复前 normalizeScores(all).slice(0,5) 不排序，按数组原顺序（Standards 在前）
    // 截前5，导致 Coding 的高分被挤出 topK。修复后应按 normScore 排序取前 topK。
    const standardsItem: KnowledgeItem = {
      ...wikiItem, knowledge_id: "wiki-standards", name: "Standards-WiKi",
      service_url: "http://standards:8421/v3",
    };
    const codingItem: KnowledgeItem = {
      ...wikiItem, knowledge_id: "wiki-coding", name: "Coding-WiKi",
      service_url: "http://coding:8421/v3",
    };
    const mk = (title: string, score: number): WikiSearchHit => ({
      path: "wiki/x.md", title, snippet: "s", score, type: "concept", hop: 0,
    });
    const standardsHits = [mk("SCM工程", 0.62), mk("元数据命名", 0.40), mk("供应链规范", 0.34), mk("修订版本", 0.30)];
    const codingHits = [mk("采购合同变更主键变换 逻辑分析", 0.93), mk("采购合同变更主键变换_数据推演", 0.78)];
    const { injector } = build({
      listBoundWiki: async () => [standardsItem, codingItem],
      factory: (serviceUrl: string) => {
        const hits = serviceUrl === "http://coding:8421/v3" ? codingHits : standardsHits;
        return { search: vi.fn(async () => hits) } as unknown as WikiRetrieveClient;
      },
    });
    const blocks = await injector.execute(mkCtx("采购合同变更的主键变化逻辑是什么"));
    expect(blocks).toHaveLength(1);
    // Coding 的高分精准页必须进入 topK（且应排在 standards 之前）
    expect(blocks[0].content).toContain("采购合同变更主键变换 逻辑分析");
    expect(blocks[0].content).toContain("[wiki:Standards-WiKi] [concept] score=");
    // 最高的 normScore 应归属于 Coding 的精准页（排在第一）
    const codingIdx = blocks[0].content.indexOf("采购合同变更主键变换 逻辑分析");
    const firstStandIdx = blocks[0].content.indexOf("[wiki:Standards-WiKi]");
    expect(codingIdx).toBeGreaterThanOrEqual(0);
    // Coding 精准页在块中的位置应早于所有 Standards 条目（高分优先）
    expect(firstStandIdx).toBeGreaterThan(codingIdx);
  });

  it("drops candidates whose normScore is below minInjectNormScore (threshold filter)", async () => {
    const mk = (title: string, score: number): WikiSearchHit => ({
      path: "wiki/x.md", title, snippet: "s", score, type: "concept", hop: 0,
    });
    // 高分命中 0.93 + 一条明显偏低 0.2；门槛 0.6 时低分那条不应注入。
    const codingHits = [mk("采购合同变更主键变换 逻辑分析", 0.93)];
    const lowHits = [mk("边角泛条目", 0.2)];
    const codingItem: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-coding", name: "Coding-WiKi", service_url: "http://coding:8421/v3" };
    const lowItem: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-low", name: "Low-WiKi", service_url: "http://low:8421/v3" };
    const { injector } = build({
      config: { minInjectNormScore: 0.6 },
      listBoundWiki: async () => [codingItem, lowItem],
      factory: (serviceUrl: string) => {
        const hits = serviceUrl === "http://coding:8421/v3" ? codingHits : lowHits;
        return { search: vi.fn(async () => hits) } as unknown as WikiRetrieveClient;
      },
    });
    const blocks = await injector.execute(mkCtx("采购合同变更主键逻辑"));
    expect(blocks[0].content).toContain("采购合同变更主键变换 逻辑分析");
    expect(blocks[0].content).not.toContain("边角泛条目");
  });

  it("downweights entity/concept via typeWeights so a source outranks a higher raw-scored entity", async () => {
    // 同库/异库混水池：entity 原始分高(0.9)，但加 typeWeights{entity:0.1} 后应被
    // 压到 source(0.7) 之下 —— 治"实体/概念被相对归一顶成 1.0"的噪音。
    const mk = (title: string, score: number, type: string): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
    });
    const entityHit = mk("复合语义模型", 0.9, "entity");
    const sourceHit = mk("跨模块接口调用规范", 0.7, "source");
    const { injector } = build({
      config: { minInjectNormScore: 0, typeWeights: { entity: 0.1, concept: 0.8 } },
      searchImpl: async () => [entityHit, sourceHit],
    });
    const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    const eIdx = blocks[0].content.indexOf("复合语义模型");
    const sIdx = blocks[0].content.indexOf("跨模块接口调用规范");
    // 低原始分但"正确来源与类型"的 source 应排在高原始分 entity 之前
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeLessThan(eIdx);
  });

  it("boosts the domain-matched wiki so its hits outrank unrelated wiki (soft domain routing)", async () => {
    // 业务 query 命中 Coding 领域词("结算") → Coding 命中 boost，压过 Standards 高原始分的噪音。
    const mk = (title: string, score: number, type = "concept"): WikiSearchHit => ({
      path: `wiki/x.md`, title, snippet: "s", score, type, hop: 0,
    });
    const codingItem: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-coding", name: "Coding-WiKi", service_url: "http://coding:8421/v3" };
    const standardsItem: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-std", name: "Standards-WiKi", service_url: "http://std:8421/v3" };
    // Coding 命中原始分低(0.5)，Standards 噪音原始分高(0.9) —— 无 router 时 Standards 靠前。
    const codingHits = [mk("暂估应收回冲机制", 0.5)];
    const stdHits = [mk("复合语义模型", 0.9, "entity")];
    const { injector } = build({
      listBoundWiki: async () => [codingItem, standardsItem],
      factory: (serviceUrl: string) => {
        const hits = serviceUrl === "http://coding:8421/v3" ? codingHits : stdHits;
        return { search: vi.fn(async () => hits) } as unknown as WikiRetrieveClient;
      },
      config: { minInjectNormScore: 0, typeWeights: { entity: 0.6 }, domainRouter: { boost: 1.5, keywords: { "Coding-WiKi": ["结算", "冲回"] } } },
    });
    const blocks = await injector.execute(mkCtx("发票结算时暂估应收怎么冲回"));
    expect(blocks).toHaveLength(1);
    const cIdx = blocks[0].content.indexOf("暂估应收回冲机制");
    const sIdx = blocks[0].content.indexOf("复合语义模型");
    // Coding(命中"结算/冲回"→boost) 应排在 Standards 噪音之前
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeLessThan(sIdx);
  });

  it("passes the session space_id as the retrieve serviceId (tenant must match bind resolution)", async () => {
    const { injector, factoryServiceIds } = build();
    await injector.execute(mkCtx("应收暂估回冲怎么处理"));
    // mkCtx sets session.space_id = "default"; injector must forward it so the
    // retrieve search hits the wiki's real tenant (regression: previously used
    // config.knowledge.serviceId="context-proxy" → 404 wiki not found).
    expect(factoryServiceIds).toContain("default");
  });

  it("returns [] when identity is missing and never calls retrieve", async () => {
    const { injector, search } = build({ identity: null });
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("returns [] when no wiki is bound and never calls retrieve", async () => {
    const { injector, search } = build({ listBoundWiki: async () => [] });
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("returns [] when disabled (no binding resolution, no retrieve)", async () => {
    const { injector, search } = build({
      enabled: false,
      listBoundWiki: vi.fn(async () => [wikiItem]) as unknown as WikiRecallInjectorDeps["listBoundWiki"],
    });
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("degrades to [] when a wiki search throws (per-wiki isolation, no rejection)", async () => {
    const { injector, search } = build({
      searchImpl: async () => {
        throw new Error("retrieve exploded");
      },
    });
    // execute() must resolve (not reject) — an unhandled rejection fails the assertion below.
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("degrades to [] when retrieveClientFactory throws (e.g. malformed service_url)", async () => {
    const { injector } = build({
      factory: () => {
        throw new Error("bad service_url");
      },
    });
    const blocks = await injector.execute(mkCtx("q"));
    expect(blocks).toEqual([]);
  });

  it("returns [] for empty/whitespace-only user query (no binding, no retrieve)", async () => {
    const { injector, search, factoryCalls } = build();
    const blocks = await injector.execute(mkCtx("   "));
    expect(blocks).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(factoryCalls).toHaveLength(0);
  });

  it("renders [图展开] when hop > 0 is configured and a hit is reached via hop", async () => {
    const { injector } = build({
      config: { hop: 2 },
      searchImpl: async () => [{ ...hit, hop: 2 }],
    });
    const blocks = await injector.execute(mkCtx("图关联查询"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("[图展开]");
  });

  it("searches all bound wikis in parallel (per factory call) and concats before topK", async () => {
    const hitA: WikiSearchHit = { ...hit, path: "a.md", title: "A", snippet: "sA", score: 13.3 };
    const hitB: WikiSearchHit = { ...hit, path: "b.md", title: "B", snippet: "sB", score: 5.0 };
    const wikiA: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-a", service_url: "http://ks-a/v3", name: "WikiA" };
    const wikiB: KnowledgeItem = { ...wikiItem, knowledge_id: "wiki-b", service_url: "http://ks-b/v3", name: "WikiB" };
    const { injector, factoryCalls } = build({
      listBoundWiki: async () => [wikiA, wikiB],
      factory: (serviceUrl) =>
        ({
          search: vi.fn(async () => [serviceUrl.includes("ks-a") ? hitA : hitB]),
        }) as unknown as WikiRetrieveClient,
    });
    const blocks = await injector.execute(mkCtx("跨 wiki 检索"));
    expect(factoryCalls).toHaveLength(2);
    expect(factoryCalls).toEqual(expect.arrayContaining(["http://ks-a/v3", "http://ks-b/v3"]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("[wiki:WikiA]");
    expect(blocks[0].content).toContain("[wiki:WikiB]");
  });

  it("annotates [degraded: fts-only] when every merged hit lacks absScore (T15-C)", async () => {
    // 简化裁决：knowledge 侧探针成本高 → 降级判据 = 本轮命中全部无 absScore。
    // 纯 FTS 命中（向量不可用）→ 注入块必须带降级标注，用户/LLM 才知道在看残废召回。
    const { injector } = build({ searchImpl: async () => [{ ...hit }] }); // hit 无 absScore
    const blocks = await injector.execute(mkCtx("应收暂估回冲怎么处理"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("[degraded: fts-only]");
    expect(blocks[0].metadata).toMatchObject({ degradedFtsOnly: true });
  });

  it("does NOT annotate degraded when at least one hit carries absScore (vector channel alive)", async () => {
    const { injector } = build({
      searchImpl: async () => [{ ...hit, absScore: 0.82 }],
    });
    const blocks = await injector.execute(mkCtx("应收暂估回冲怎么处理"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).not.toContain("[degraded: fts-only]");
    expect(blocks[0].metadata).toMatchObject({ degradedFtsOnly: false });
  });

  // ── W5（T18-B）：结构页降权排尾 ──────────────────────────────────────────
  it("appends structural pages (NON_EMBED_TYPES) to the tail with [structural] on the first one (W5)", async () => {
    // 场景：结构页 log.md 原始分 0.9 高于正文页 0.7 —— 修复前结构页靠相对归一顶成
    // rank 1 挤进注入位（absGate 对无 absScore 的结构页结构性无效）。修复后结构页
    // 不再与正文竞争 top-K：正文在前，结构页附在列表尾部，首个带 [structural] 标注。
    const mk = (title: string, score: number, type: string): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
    });
    const logHit = mk("运行日志索引", 0.9, "log");
    const sourceHit = mk("跨模块接口调用规范", 0.7, "source");
    const { injector } = build({
      config: { minInjectNormScore: 0 },
      searchImpl: async () => [logHit, sourceHit],
    });
    const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content;
    const srcIdx = content.indexOf("跨模块接口调用规范");
    const logIdx = content.indexOf("运行日志索引");
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeGreaterThanOrEqual(0);
    // 结构页排尾：正文在前
    expect(logIdx).toBeGreaterThan(srcIdx);
    // 首个结构页带 [structural] 标注（标注落在结构页自己的行上）
    const structuralLine = content.split("\n").find((l) => l.includes("[structural]"));
    expect(structuralLine).toBeTruthy();
    expect(structuralLine).toContain("运行日志索引");
  });

  it("keeps structural pages present but never lets them crowd the top-K body entries (W5)", async () => {
    // 结构页保持存在（历史信息仍有价值），但正文高分页占满 topK 之前的位置。
    const mk = (title: string, score: number, type: string): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
    });
    const indexHit = mk("全库索引页", 0.95, "index");
    const schemaHit = mk("schema 说明", 0.85, "schema");
    const purposeHit = mk("本库目的", 0.8, "purpose");
    const sourceHit = mk("跨模块接口调用规范", 0.7, "source");
    const { injector } = build({
      config: { minInjectNormScore: 0, globalTopK: 3 },
      searchImpl: async () => [indexHit, schemaHit, purposeHit, sourceHit],
    });
    const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content;
    const srcIdx = content.indexOf("跨模块接口调用规范");
    // 正文页必须存在且排在所有结构页之前
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    expect(content.indexOf("全库索引页")).toBeGreaterThan(srcIdx);
    expect(content.indexOf("schema 说明")).toBeGreaterThan(srcIdx);
    expect(content.indexOf("本库目的")).toBeGreaterThan(srcIdx);
    // top-K 竞争池只剩正文：结构页不占用 topK 位次后的正文条目依然全在
    expect(content).toContain("跨模块接口调用规范");
  });

  it("caps the structural tail at MAX_STRUCTURAL_TAIL=3 and drops the overflow with a debug log (S3/T18 M-1)", async () => {
    // S3 小扫除：结构页附尾数量封顶（MAX_STRUCTURAL_TAIL=3）。结构页天生无 absScore、
    // 不竞争 top-K，若一轮召回捞回大量结构页（log/index/schema 全中），附尾会无界
    // 挤占注入预算 —— 超出 3 条直接丢弃并打 debug 日志。
    const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    try {
      const mk = (title: string, score: number, type: string): WikiSearchHit => ({
        path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
      });
      const structuralHits = [
        mk("全库索引页", 0.95, "index"),
        mk("schema 说明", 0.9, "schema"),
        mk("运行日志一", 0.85, "log"),
        mk("运行日志二", 0.8, "log"),
        mk("库目的说明", 0.75, "purpose"),
      ];
      const { injector } = build({
        config: { minInjectNormScore: 0 },
        searchImpl: async () => structuralHits,
      });
      const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
      expect(blocks).toHaveLength(1);
      const content = blocks[0].content;
      // 前 3 条结构页附尾存活，首个带 [structural] 标注
      expect(content).toContain("全库索引页");
      expect(content).toContain("schema 说明");
      expect(content).toContain("运行日志一");
      const structuralLine = content.split("\n").find((l) => l.includes("[structural]"));
      expect(structuralLine).toBeTruthy();
      // 超出 cap 的第 4/5 条被丢弃
      expect(content).not.toContain("运行日志二");
      expect(content).not.toContain("库目的说明");
      // [structural] 标注只出现一次（标注永远落在存活的第一个结构页上）
      expect(content.split("[structural]").length - 1).toBe(1);
      // 超出丢弃必须留 debug 日志（可诊断，不静默）
      expect(debugSpy.mock.calls.some((c) => String(c[0]).includes("structural") && String(c[0]).includes("drop"))).toBe(true);    } finally {
      debugSpy.mockRestore();
    }
  });

  it("multiplies typeWeights (other: 0.3) so body outranks high-raw other-typed noise (W5 regression confirm)", async () => {
    // typeWeights 乘法机制本身已有测试（entity 用例）；这里确认新增 other 权重项
    // 经同一乘法路径生效：other 原始分 0.9 × 0.3 = 0.27 < source 0.7 → 正文在前。
    const mk = (title: string, score: number, type: string): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
    });
    const otherHit = mk("杂项页面", 0.9, "other");
    const sourceHit = mk("跨模块接口调用规范", 0.7, "source");
    const { injector } = build({
      config: { minInjectNormScore: 0, typeWeights: { other: 0.3 } },
      searchImpl: async () => [otherHit, sourceHit],
    });
    const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content;
    expect(content.indexOf("跨模块接口调用规范")).toBeLessThan(content.indexOf("杂项页面"));
  });

  it("ships the 4 new structural typeWeights in the injection defaults (other/log/index/schema = 0.3)", async () => {
    // 默认值落在 injection/index.ts defaultWikiRecallConfig（config.wikiRecall 缺失时的兜底）。
    const { defaultWikiRecallConfig } = await import("../../index.js");
    expect(defaultWikiRecallConfig.typeWeights).toMatchObject({
      entity: 0.6, concept: 0.9, overview: 0.6, // 既有 3 项保留
      other: 0.3, log: 0.3, index: 0.3, schema: 0.3, // W5 新增 4 项
    });
  });

  it("C3: code default retires domainRouter explicitly (keywords {} = router off, capability shape kept)", async () => {
    // 2026-09-10 隔离实验（anchor runs/2026-09-10T04-07-38.json）：部署工作点
    // router 对 posRecall 单变量贡献=0（B/E 同 0.66）、negInjected 恒 +2（13 vs 11），
    // 且 W4 boost→归一→门耦合未解 —— router 默认退役。
    // 代码默认层必须**显式**携带退役标记（keywords 空表 = injector 静默 no-op），
    // 而不是靠"字段缺失"隐式关断——显式标记自带退役注释与重开协议，防静默复活。
    const { defaultWikiRecallConfig } = await import("../../index.js");
    expect(defaultWikiRecallConfig.domainRouter).toEqual({ boost: 1.5, keywords: {} });
    // 行为钉死：默认态下（config.wikiRecall 整段缺失）router 恒 no-op——
    // 即使 query 含领域词，命中分数也不被 boost。
  });

  // ── W7（T20）：absGate（minInjectAbsScore）行为钉死 ─────────────────────
  // absGate 只对带 absScore 的候选生效（injector: absGate > 0 时
  // bodyPool.filter(h => h.absScore === undefined || h.absScore >= absGate)）。
  // 本组用例把该行为逐条钉死，防止后续改动静默破坏 fail-open 语义。
  describe("absGate (minInjectAbsScore) 行为钉死 (W7/T20)", () => {
    const mk = (title: string, score: number, absScore?: number, type = "concept"): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
      ...(absScore !== undefined ? { absScore } : {}),
    });

    it("① keeps a candidate whose absScore >= threshold", async () => {
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [mk("暂估应收回冲机制", 0.9, 2.0)],
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("暂估应收回冲机制");
    });

    it("② blocks a candidate whose absScore < threshold (宁缺毋滥)", async () => {
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [mk("撞词噪音页", 0.9, 1.2)],
      });
      // absGate 拦截后正文池为空、无结构页 → 整轮不注入（宁缺毋滥）。
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toEqual([]);
    });

    it("③ fail-open: a candidate WITHOUT absScore passes the gate (相对门控兜底, 有意设计)", async () => {
      // 显式断言 fail-open 是有意设计，不是漏洞：纯 FTS 命中（向量通道不可用）
      // 不在 absGate 判——若也拦掉，向量降级时会整轮零注入（under-recall 灾难）。
      // 兜底交给相对门控（minInjectNormScore）+ [degraded: fts-only] 降级标注。
      // spec：绝对门控"仅对带 absScore 的候选生效，不带 absScore 仍由相对门控兜底"。
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [mk("纯FTS命中页", 0.9)], // 无 absScore
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("纯FTS命中页");
    });

    it("④ structural pages (no absScore) bypass absGate and stay at the tail (W5×absGate interaction)", async () => {
      // 结构页先于 absGate 从竞争池拎出（structural 提取在 absGate filter 之前），
      // 因此即使 minInjectAbsScore 启用，结构页也不进 absGate 池 → 不被误拦 → 排尾。
      const bodyOk = mk("跨模块接口调用规范", 0.7, 2.0, "source");
      const logPage = mk("运行日志索引", 0.9, undefined, "log");
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [logPage, bodyOk],
      });
      const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
      expect(blocks).toHaveLength(1);
      const content = blocks[0].content;
      const srcIdx = content.indexOf("跨模块接口调用规范");
      const logIdx = content.indexOf("运行日志索引");
      expect(srcIdx).toBeGreaterThanOrEqual(0);
      expect(logIdx).toBeGreaterThan(srcIdx); // 排尾
      expect(content).toContain("[structural]"); // 结构页标注仍在
    });

    it("④b absGate filters only body pool: gated-out body still leaves structural tail present", async () => {
      // 正文全部被 absGate 拦掉时，结构页（不进 absGate 池）依然存在并排尾——
      // 证明"先拎出、后门控"的顺序，结构页从不因 absScore 缺失被 absGate 误伤。
      const bodyGated = mk("低相关正文页", 0.7, 1.0, "source");
      const schemaPage = mk("schema 说明", 0.9, undefined, "schema");
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [schemaPage, bodyGated],
      });
      const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
      expect(blocks).toHaveLength(1);
      const content = blocks[0].content;
      expect(content).not.toContain("低相关正文页"); // 正文被拦
      expect(content).toContain("schema 说明"); // 结构页存活
      expect(content).toContain("[structural]");
    });
  });

  it("ships the 4 new structural typeWeights in config.yaml (other/log/index/schema = 0.3)", async () => {
    // 部署配置 config.yaml 与代码默认同步（两处都改，W5 验收）。
    const { loadYamlConfig } = await import("../../../config.js");
    const yaml = loadYamlConfig("config.yaml");
    expect(yaml.wikiRecall?.typeWeights).toMatchObject({
      entity: 0.6, concept: 0.9, overview: 0.6,
      other: 0.3, log: 0.3, index: 0.3, schema: 0.3,
    });
  });

  it("C3: config.yaml (deploy mirror) retires domainRouter — code default and deploy stay consistent", async () => {
    // config.yaml 是 gitignore 的本机部署镜像，但验收要求它与代码默认一致：
    // router 退役后本机部署也不得残留**生效的** domainRouter 段。
    // 注意：不能写 `enabled: false` —— injector（wiki-recall-injector.ts:169-186）
    // 只判 keywords 非空、不读 enabled 字段，写了 enabled:false 是静默 no-op（router 仍开着）。
    // 退役 = 整段注释（关键词表保留在注释里作重开参考）。
    const { loadYamlConfig } = await import("../../../config.js");
    const yaml = loadYamlConfig("config.yaml");
    expect(yaml.wikiRecall?.domainRouter).toBeUndefined();
  });
});

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

  it("per-agent path returns [] early when agent has no bound ids", async () => {
    const client = {
      listAgentKnowledgeIds: async () => [],
      listKnowledgeByIds: vi.fn(),
    };
    const out = await resolveBoundWikiResources("team", "agent", "u-key", undefined, client as never);
    expect(out).toEqual([]);
    expect(client.listKnowledgeByIds).not.toHaveBeenCalled();
  });

  it("fallback team path returns team wikis when no agent userKey", async () => {
    const client = { listKnowledge: async () => [{ knowledge_id: "wiki-t", type: "wiki", name: "TW", service_url: "u", team_id: "team", user_id: null, summary: null, created_at: "", updated_at: "" }] };
    const out = await resolveBoundWikiResources("team", undefined, undefined, undefined, client as never);
    expect(out[0].knowledge_id).toBe("wiki-t");
  });
});

describe("shouldRegisterWikiRecallInjector", () => {
  const base = { injection: { injectors: ["knowledge"] }, knowledge: { enabled: true, serviceToken: "tok" } };

  it("true only when knowledge enabled + serviceToken set + wikiRecall enabled", () => {
    expect(shouldRegisterWikiRecallInjector({ ...base, wikiRecall: { enabled: true } } as never)).toBe(true);
    expect(shouldRegisterWikiRecallInjector({ ...base, wikiRecall: { enabled: false } } as never)).toBe(false);
    expect(shouldRegisterWikiRecallInjector({ ...base, knowledge: { enabled: false, serviceToken: "tok" } } as never)).toBe(false);
    expect(shouldRegisterWikiRecallInjector({ injection: { injectors: ["skill"] }, knowledge: { enabled: true, serviceToken: "tok" }, wikiRecall: { enabled: true } } as never)).toBe(false);
  });

  it("defaults to enabled when wikiRecall block is absent (only knowledge gate applies)", () => {
    expect(shouldRegisterWikiRecallInjector(base as never)).toBe(true);
  });
});