import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiRecallInjector, defaultWikiRecallConfig, resolveBoundWikiResources, shouldRegisterWikiRecallInjector } from "../wiki-recall-injector.js";
import type { WikiRecallInjectorDeps, WikiRecallInjectorConfig } from "../wiki-recall-injector.js";
import type { AgentContext } from "../../types.js";
import type { WikiRetrieveClient, WikiSearchHit } from "../../../knowledge/wiki-retrieve-client.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import type { TdaiIdentity } from "../../../tdai/types.js";
import { buildConfig } from "../../../config.js";
// defaultWikiRecallConfig 权威单一源=同目录 injector（#48 CI 加固：原经 index.ts barrel
// import，Linux CI 模块图下 typeWeights 解析为 undefined；改自被测模块直取同引用）。
import {
  buildJitSummary,
  renderWikiRecallBlockJit,
  stripFrontmatter,
  type WikiRecallRenderEntry,
} from "../../../knowledge/wiki-recall-utils.js";
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
    // #85 Q2 主门后：cap 场景需正文存活（正文池全灭整轮不注入），夹具补一条正文命中。
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
        mk("跨模块接口调用规范", 0.7, "concept"), // 正文命中：保证主门放行，cap 逻辑独立受验
      ];
      const { injector } = build({
        config: { minInjectNormScore: 0 },
        searchImpl: async () => structuralHits,
      });
      const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("跨模块接口调用规范"); // 正文在前
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

  it("ships the 4 new structural typeWeights in the injection defaults (other/log/index/schema = 0.3)", () => {
    // 默认值权威单一源=wiki-recall-injector.ts（#48 CI 加固：getter 形态，TDZ 免疫）。
    expect(defaultWikiRecallConfig().typeWeights).toMatchObject({
      entity: 0.6, concept: 0.9, overview: 0.6, // 既有 3 项保留
      other: 0.3, log: 0.3, index: 0.3, schema: 0.3, // W5 新增 4 项
    });
  });

  it("C3: code default retires domainRouter explicitly (keywords {} = router off, capability shape kept)", () => {
    // 2026-09-10 隔离实验（anchor runs/2026-09-10T04-07-38.json）：部署工作点
    // router 对 posRecall 单变量贡献=0（B/E 同 0.66）、negInjected 恒 +2（13 vs 11），
    // 且 W4 boost→归一→门耦合未解 —— router 默认退役。
    // 代码默认层必须**显式**携带退役标记（keywords 空表 = injector 静默 no-op），
    // 而不是靠"字段缺失"隐式关断——显式标记自带退役注释与重开协议，防静默复活。
    expect(defaultWikiRecallConfig().domainRouter).toEqual({ boost: 1.5, keywords: {} });
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

    it("④b absGate filters only body pool: gated-out body ⇒ whole turn silent (#85 Q2 主门，反转旧兜底)", async () => {
      // #85 Q2 拍板：正文全部被门槛拦掉 → 整轮不注入，结构页不再单独兜底。
      // 旧行为（结构页依然排尾）= #85 症状②「score=0.00 结构页独占注入」的来源，已反转。
      const bodyGated = mk("低相关正文页", 0.7, 1.0, "source");
      const schemaPage = mk("schema 说明", 0.9, undefined, "schema");
      const { injector } = build({
        config: { minInjectAbsScore: 1.5 },
        searchImpl: async () => [schemaPage, bodyGated],
      });
      const blocks = await injector.execute(mkCtx("跨模块调用接口规范"));
      expect(blocks).toHaveLength(0);
    });
  });

  // ── P0-3（issue #2）：minInjectFtsScore（FTS 穿透门）行为钉死 ─────────────────
  // 纯 FTS 命中（absScore===undefined）此前在 absGate 处 fail-open（W7 ③有意设计），
  // 但 fail-open 同时是"垃圾分布顶部恒 1.0"的注入通道——P0-3 新增独立 ftsGate：
  // hop=0 融合分刻度（[0,1]，仅 FTS 命中 ≈ 0.4×字面路 min-max）下的最低门槛。
  describe("minInjectFtsScore FTS 穿透门 (P0-3)", () => {
    const mk = (title: string, score: number, absScore?: number, type = "concept"): WikiSearchHit => ({
      path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
      ...(absScore !== undefined ? { absScore } : {}),
    });

    it("① FTS-only 命中 score >= gate → 注入", async () => {
      const { injector } = build({
        config: { minInjectFtsScore: 0.2 },
        searchImpl: async () => [mk("合格FTS命中页", 0.3)],
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("合格FTS命中页");
    });

    it("② FTS-only 命中 score < gate → 拦截（宁缺毋滥）", async () => {
      const { injector } = build({
        config: { minInjectFtsScore: 0.2 },
        searchImpl: async () => [mk("撞词噪音页", 0.1)],
      });
      expect(await injector.execute(mkCtx("暂估应收回冲"))).toEqual([]);
    });

    it("③ 双通道命中（有 absScore）不走此门——由 absGate 独立判", async () => {
      const { injector } = build({
        config: { minInjectFtsScore: 0.9 }, // 刻度不可比的高门
        searchImpl: async () => [mk("向量强命中页", 0.05, 2.0)],
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("向量强命中页");
    });

    it("④ hop>0 时门强制关闭（BM25 原始尺度不可比，代码级设防）", async () => {
      const { injector } = build({
        config: { hop: 1, minInjectFtsScore: 0.9 },
        searchImpl: async () => [mk("图扩展FTS命中页", 0.1)],
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("图扩展FTS命中页");
    });

    it("⑤ 未配置（缺省 0）= 关：FTS-only 低分照旧注入（逐位现状）", async () => {
      const { injector } = build({
        config: {},
        searchImpl: async () => [mk("未配置低分页", 0.01)],
      });
      const blocks = await injector.execute(mkCtx("暂估应收回冲"));
      expect(blocks).toHaveLength(1);
    });
  });

  // ── P0-3（issue #2）：skipQuery 短 query / 寒暄 query 整轮跳过 ─────────────────
  // bigram 前缀 OR 对超短 query 几乎全库命中；寒暄 query 检索只产出噪音。
  // CJK 词 = 去标点/空白后全等（子串会误杀真实任务 query）；ASCII 词 = 词边界。
  describe("skipQuery 短 query / 寒暄 query 跳过 (P0-3)", () => {
    it("① CJK 寒暄词全等命中 → 跳过且不发检索请求", async () => {
      const { injector, search } = build({
        config: { skipQuery: { patterns: ["好的", "谢谢"] } },
        searchImpl: async () => [hit],
      });
      expect(await injector.execute(mkCtx("好的"))).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });

    it("② 真实任务 query 含寒暄词开头 → 不跳（去标点后全等才跳）", async () => {
      const { injector, search } = build({
        config: { skipQuery: { patterns: ["好的"] } },
        searchImpl: async () => [hit],
      });
      const blocks = await injector.execute(mkCtx("好的，那我们继续评审网关重构方案"));
      expect(search).toHaveBeenCalledTimes(1);
      expect(blocks).toHaveLength(1);
    });

    it("③ ASCII 词边界：'ok 这版可以发吗' 跳过；'同步 OKR 进展' 不误杀", async () => {
      const { injector, search } = build({
        config: { skipQuery: { patterns: ["OK"] } },
        searchImpl: async () => [hit],
      });
      expect(await injector.execute(mkCtx("ok 这版可以发吗"))).toEqual([]);
      expect(search).not.toHaveBeenCalled();
      const blocks = await injector.execute(mkCtx("同步 OKR 进展"));
      expect(search).toHaveBeenCalledTimes(1);
      expect(blocks).toHaveLength(1);
    });

    it("④ minChars：码点长度不足 → 跳过且不发检索", async () => {
      const { injector, search } = build({
        config: { skipQuery: { minChars: 6 } },
        searchImpl: async () => [hit],
      });
      expect(await injector.execute(mkCtx("总结一下"))).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });
  });

  it("ships the 4 new structural typeWeights in config.yaml (other/log/index/schema = 0.3)", async () => {
    // 部署配置 config.yaml 与代码默认同步（两处都改，W5 验收）。
    // #48 CI 收口：config.yaml 是 gitignore 的本机部署镜像（含本机密钥/端口，刻意
    // 不入库）——CI checkout 无此文件，本用例属本机部署一致性验收，无镜像时诚实 skip。
    const mirror = join(process.cwd(), "config.yaml");
    if (!existsSync(mirror)) return; // CI：skip（无本机部署镜像）；本地：真断言
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
    // #48 CI 收口：同上，无本机部署镜像时 skip（本机部署一致性=本地门）。
    const mirror = join(process.cwd(), "config.yaml");
    if (!existsSync(mirror)) return; // CI：skip；本地：真断言
    const { loadYamlConfig } = await import("../../../config.js");
    const yaml = loadYamlConfig("config.yaml");
    expect(yaml.wikiRecall?.domainRouter).toBeUndefined();
  });


// ══ Task 6（P1 recall-quality）：wiki JIT 瘦身注入 ══════════════════════════
// 形态（spec §5）：单条 = 标题 + 一行摘要(≤80) + [详情: tool wiki_fetch]，单条
// ≤100、整块 ≤500；例外：原文 ≤160 chars 直接注全文（legacy 全格式）；降级：
// per-agent jit=false 回退现行；放量：meta 能力位 wiki_jit.enabled（同
// llm_wiki.enabled 模式）+ panel UI；journal 记录 chars 与「若 JIT 会注入 chars」。
describe("wiki JIT 瘦身注入 (Task 6)", () => {
  /** >160 码点的长摘要（走 JIT 存根渲染）。 */
  const longSnippet = "这是一段超过一百六十个码点的长摘要内容，用于验证 JIT 存根渲染与块预算裁剪行为。".repeat(6);
  // 路由级测试用的长摘要命中。模块级 hit 的 snippet 仅 4 码点，会落进 ≤160 例外
  // 直注全文路（legacy 全格式），永远不产生 JIT 存根——这是前人 3 个路由级红测试的根因。
  const longHit: WikiSearchHit = { ...hit, snippet: longSnippet };
  const jitCaps = { skill: true, llm_wiki: true, code_graph: true, chat_memory: true, wiki_jit: true };
  const legacyCaps = { skill: true, llm_wiki: true, code_graph: true, chat_memory: true, wiki_jit: false };

  function mkCapsCtx(content: string, caps?: Record<string, boolean>): AgentContext {
    const ctx = mkCtx(content) as unknown as { metadata: { custom: Record<string, unknown> } };
    if (caps) ctx.metadata.custom.assetCapabilities = caps;
    return ctx as unknown as AgentContext;
  }

  function mkJitEntry(over: Partial<WikiRecallRenderEntry> = {}): WikiRecallRenderEntry {
    return {
      wikiName: "Coding-WiKi",
      type: "concept",
      title: "应收暂估回冲",
      score: 3.2,
      normScore: 1,
      snippet: longSnippet,
      path: "wiki/concepts/a.md",
      hop: 0,
      ...over,
    };
  }

  describe("stripFrontmatter / buildJitSummary（摘要行来源）", () => {
    it("剥离首部 frontmatter；非首部/未闭合的不动", () => {
      expect(stripFrontmatter("---\ntitle: x\n---\n正文第一行\n第二行")).toBe("正文第一行\n第二行");
      expect(stripFrontmatter("没有 frontmatter")).toBe("没有 frontmatter");
      expect(stripFrontmatter("正文\n---\nx\n---")).toBe("正文\n---\nx\n---");
      expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
    });

    it("摘要 = 剥 frontmatter + 折叠空白 + ≤80 码点截断（CJK/emoji 安全）", () => {
      expect(buildJitSummary("---\ntitle: x\n---\n\n这是 摘要\n第二段", 80)).toBe("这是 摘要 第二段");
      const s1 = buildJitSummary("字".repeat(100), 80);
      expect(Array.from(s1).length).toBe(80);
      expect(s1.endsWith("…")).toBe(true);
      const s2 = buildJitSummary("👍".repeat(100), 80);
      expect(Array.from(s2).length).toBe(80);
      // 不产生孤立代理对（末尾必须是完整 emoji 或截断后缀；孤立即高位代理结尾）
      expect(/[\uD800-\uDBFF]$/.test(s2)).toBe(false);
      expect(buildJitSummary("   ", 80)).toBe("");
    });
  });

  describe("renderWikiRecallBlockJit（JIT 渲染形态）", () => {
    it("单条形状 = 序号+来源+标题+摘要+[详情: tool wiki_fetch]，单条 ≤100、无 path/score 行", () => {
      const block = renderWikiRecallBlockJit([mkJitEntry()]);
      expect(block).not.toBeNull();
      expect(block).toContain("<tdai_recalled_wiki>");
      expect(block).toContain("</tdai_recalled_wiki>");
      const line = (block as string).split("\n").find((l) => l.startsWith("1. [wiki:Coding-WiKi]"));
      expect(line).toBeTruthy();
      expect(line).toContain("[详情: tool wiki_fetch]");
      expect(line).toContain("应收暂估回冲：");
      expect(Array.from(line as string).length).toBeLessThanOrEqual(100);
      expect(line).not.toContain("path:");
      expect(line).not.toContain("score=");
    });

    it("例外：原文 ≤160 直接注全文（沿用 legacy 全格式，含 path/score 行）", () => {
      const block = renderWikiRecallBlockJit([mkJitEntry({ snippet: "短摘要" })]);
      expect(block).toContain("1. [wiki:Coding-WiKi] [concept] score=1.00 — 应收暂估回冲");
      expect(block).toContain("   path: wiki/concepts/a.md");
      expect(block).toContain("   短摘要");
      expect(block).not.toContain("[详情: tool wiki_fetch]");
    });

    it("整块 ≤500：5 条长摘要候选时裁掉装不下的尾部条目，header/footer 必保", () => {
      const entries = [1, 2, 3, 4, 5].map((i) =>
        mkJitEntry({ title: `标题${i}`, path: `wiki/p/${i}.md` }),
      );
      const block = renderWikiRecallBlockJit(entries) as string;
      expect(Array.from(block).length).toBeLessThanOrEqual(500);
      const lines = block.split("\n");
      expect(lines[0]).toBe("<tdai_recalled_wiki>");
      expect(lines[lines.length - 1]).toBe("</tdai_recalled_wiki>");
      // header 的来源说明与取文指引行必保
      expect(block).toContain("wiki 索引");
      expect(block).toContain("wiki_fetch");
    });

    it("软指引恰好一次：doc_path|title、section、≤4000、[truncated]、miss isError=true、单轮 ≤3 次", () => {
      const block = renderWikiRecallBlockJit([mkJitEntry(), mkJitEntry({ title: "标题2" })]) as string;
      expect(block.split("单轮取文建议 ≤3 次").length - 1).toBe(1);
      const guideLine = block.split("\n").find((l) => l.includes("wiki_fetch") && l.includes("doc_path"));
      expect(guideLine).toBeTruthy();
      expect(guideLine).toContain("title");
      expect(guideLine).toContain("section");
      expect(guideLine).toContain("4000");
      expect(guideLine).toContain("[truncated]");
      expect(guideLine).toContain("isError=true");
    });

    it("空 snippet → 仅标题（无冒号）；超长 title 截断保 ≤100", () => {
      const empty = renderWikiRecallBlockJit([mkJitEntry({ snippet: "" })]) as string;
      const line = empty.split("\n").find((l) => l.startsWith("1. ")) as string;
      expect(line).toBe("1. [wiki:Coding-WiKi] 应收暂估回冲 [详情: tool wiki_fetch]");
      const longTitle = renderWikiRecallBlockJit([mkJitEntry({ title: "长".repeat(60) })]) as string;
      const line2 = longTitle.split("\n").find((l) => l.startsWith("1. ")) as string;
      expect(Array.from(line2).length).toBeLessThanOrEqual(100);
      expect(line2).toContain("[详情: tool wiki_fetch]");
    });

    it("空条目列表返回 null（与 legacy 渲染一致）", () => {
      expect(renderWikiRecallBlockJit([])).toBeNull();
    });
  });

  describe("injector JIT 路由（meta 能力位 + jit tri-state）", () => {
    it("meta wiki_jit=true → JIT 短块（metadata.jitMode=jit，体积对比记录在案）", async () => {
      const { injector } = build({ searchImpl: async () => [longHit] });
      const blocks = await injector.execute(mkCapsCtx("应收暂估回冲怎么处理", jitCaps));
      expect(blocks).toHaveLength(1);
      const content = blocks[0].content;
      expect(content).toContain("[详情: tool wiki_fetch]");
      expect(content).not.toContain("score=");
      expect(blocks[0].metadata).toMatchObject({ jitMode: "jit" });
      const meta = blocks[0].metadata as { chars: number; jitWouldBeChars: number };
      expect(meta.chars).toBe(Array.from(content).length);
      // legacy 全量渲染（长摘要）必然显著长于 JIT 短块
      expect(meta.jitWouldBeChars).toBeGreaterThan(meta.chars);
    });

    it("meta 缺省（无 assetCapabilities）→ 现行全量（jitMode=legacy，默认关=shadow-first）", async () => {
      const { injector } = build();
      const blocks = await injector.execute(mkCapsCtx("应收暂估回冲怎么处理"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("score=");
      expect(blocks[0].content).not.toContain("[详情: tool wiki_fetch]");
      expect(blocks[0].metadata).toMatchObject({ jitMode: "legacy" });
      const meta = blocks[0].metadata as { chars: number; jitWouldBeChars: number };
      expect(meta.jitWouldBeChars).toBeLessThan(meta.chars);
    });

    it("meta wiki_jit=false → 现行全量", async () => {
      const { injector } = build();
      const blocks = await injector.execute(mkCapsCtx("应收暂估回冲怎么处理", legacyCaps));
      expect(blocks[0].metadata).toMatchObject({ jitMode: "legacy" });
      expect(blocks[0].content).toContain("score=");
    });

    it("config jit=false 逃生门压过 meta 开关 → 现行全量，且与缺省输出逐字节一致", async () => {
      const escaped = build({ config: { jit: false } });
      const baseline = build();
      const a = await escaped.injector.execute(mkCapsCtx("应收暂估回冲怎么处理", jitCaps));
      const b = await baseline.injector.execute(mkCapsCtx("应收暂估回冲怎么处理"));
      expect(a[0].metadata).toMatchObject({ jitMode: "legacy" });
      expect(a[0].content).toBe(b[0].content);
    });

    it("config jit=true 强制 JIT（meta 关闭/缺席时——运维/live 验收通道）", async () => {
      const { injector } = build({ config: { jit: true }, searchImpl: async () => [longHit] });
      const blocks = await injector.execute(mkCapsCtx("应收暂估回冲怎么处理", legacyCaps));
      expect(blocks[0].metadata).toMatchObject({ jitMode: "jit" });
      expect(blocks[0].content).toContain("[详情: tool wiki_fetch]");
    });

    it("JIT 模式下 [degraded: fts-only] 标注照常生效", async () => {
      const { injector } = build({ searchImpl: async () => [longHit] });
      const blocks = await injector.execute(mkCapsCtx("应收暂估回冲怎么处理", jitCaps));
      expect(blocks[0].content).toContain("[degraded: fts-only]");
      expect(blocks[0].content).toContain("[详情: tool wiki_fetch]");
    });

    it("journal 行：mode/chars/jitWouldBeChars/entries/team 记入 injector 日志通道", async () => {
      const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
      try {
        const { injector } = build();
        await injector.execute(mkCapsCtx("应收暂估回冲怎么处理", jitCaps));
        const journal = infoSpy.mock.calls
          .map((c) => String(c[0]))
          .find((s) => s.includes("journal mode=jit"));
        expect(journal).toBeTruthy();
        expect(journal).toContain("chars=");
        expect(journal).toContain("jitWouldBeChars=");
        expect(journal).toContain("entries=");
        expect(journal).toContain("team=team");

        infoSpy.mockClear();
        const { injector: legacyInjector } = build();
        await legacyInjector.execute(mkCapsCtx("应收暂估回冲怎么处理"));
        const legacyJournal = infoSpy.mock.calls
          .map((c) => String(c[0]))
          .find((s) => s.includes("journal mode=legacy"));
        expect(legacyJournal).toBeTruthy();
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe("wikiRecall.jit tri-state 配置解析", () => {
    function writeTempYaml(body: string): string {
      const dir = mkdtempSync(join(tmpdir(), "wiki-jit-cfg-"));
      const file = join(dir, "config.yaml");
      writeFileSync(file, body, "utf8");
      return file;
    }

    it("jit: true / jit: false 透传；缺省 → undefined（跟随 meta 能力位）", () => {
      const p1 = writeTempYaml("wikiRecall:\n  enabled: true\n  jit: true\n");
      try {
        expect(buildConfig({ configFile: p1 }).wikiRecall?.jit).toBe(true);
      } finally {
        rmSync(p1, { force: true });
      }
      const p2 = writeTempYaml("wikiRecall:\n  enabled: true\n  jit: false\n");
      try {
        expect(buildConfig({ configFile: p2 }).wikiRecall?.jit).toBe(false);
      } finally {
        rmSync(p2, { force: true });
      }
      const p3 = writeTempYaml("wikiRecall:\n  enabled: true\n");
      try {
        expect(buildConfig({ configFile: p3 }).wikiRecall?.jit).toBeUndefined();
      } finally {
        rmSync(p3, { force: true });
      }
    });
  });
});
});

// ── #85 wiki JIT 召回语义错配（三问拍板实施，2026-10-25）────────────────────────
// 拍板：Q1 绝对门 config-first 启用（标定循 #80）/ Q2 结构页主门+次门 / Q3 querySource 三态。
// 症状①无关 query 命中满分规范条目（per-query min-max 归一假满分，相对门拦不住头部）；
// 症状②score=0.00 结构页兜底进注入（W5 附尾不过门 + 正文池全灭时单独触发）。

const wikiItem85: KnowledgeItem = {
  knowledge_id: "wiki-x", type: "wiki", service_url: "http://ks:8421/v3", name: "Coding-WiKi",
  summary: "s", team_id: "team", user_id: null, created_at: "", updated_at: "",
} as KnowledgeItem;

const baseCfg85: WikiRecallInjectorConfig = {
  enabled: true, perWikiLimit: 8, globalTopK: 5, minScore: 0.02,
  hop: 0, decay: 0.5, maxTotalChars: 0, minInjectNormScore: 0,
};

function build85(
  cfg: Partial<WikiRecallInjectorConfig>,
  impl: (params: { query: string }) => WikiSearchHit[] | Promise<WikiSearchHit[]>,
) {
  const search = vi.fn(impl as never);
  const deps: WikiRecallInjectorDeps = {
    knowledgeClient: {} as WikiRecallInjectorDeps["knowledgeClient"],
    retrieveClientFactory: () => ({ search }) as unknown as WikiRetrieveClient,
    identityResolver: (() => ({ teamId: "team", agentId: "agent", userId: "u", sessionId: "s" })) as WikiRecallInjectorDeps["identityResolver"],
    listBoundWiki: async () => [wikiItem85],
  };
  const injector = new WikiRecallInjector({ ...baseCfg85, ...cfg }, deps);
  return { injector, search };
}

const capturedQuery85 = (search: { mock: { calls: unknown[][] } }): string => {
  const call = search.mock.calls[0] as unknown[] | undefined;
  const params = call?.[0] as { query?: string } | undefined;
  return params?.query ?? "";
};

const mkCtx85 = (content: string, turn?: { turnIntent: { index: number; text: string } | null } | null): AgentContext => {
  const custom: Record<string, unknown> = {
    session: { user_id: "u", team_id: "team", agent_id: "agent", space_id: "default" },
  };
  if (turn !== undefined) custom.tdaiTurnContext = turn;
  return {
    messages: [{ role: "user", blocks: [{ type: "text", content }] }],
    tools: [], requestParams: {},
    metadata: { protocol: "anthropic", traceId: "t", keyId: "k", modelId: "m", stream: false, agentSource: "dsh", custom },
  } as unknown as AgentContext;
};

describe("#85 Q3 querySource 三态（对齐 #83 入口单点定源）", () => {
  const mk = (title: string, score: number): WikiSearchHit => ({
    path: "wiki/x.md", title, snippet: "s", score, type: "concept", hop: 0,
  });

  it("intent 档：query 改读 turnContext.turnIntent.text（harness 噪声消息不再当检索词）", async () => {
    const { injector, search } = build85(
      { querySource: "intent" },
      () => [mk("无关规范页", 0.9)],
    );
    await injector.execute(mkCtx85(
      "Current runtime context. Time sampled while preparing turn 1, step 1: 2026-10-25T16:39:08+08:00",
      { turnIntent: { index: 0, text: "第一性原理分析一下 TDB 记忆系统的注入门槛" } },
    ));
    expect(capturedQuery85(search)).toBe("第一性原理分析一下 TDB 记忆系统的注入门槛");
  });

  it("intent 档：缺 turnContext（null）→ 兜底回落消息文本提取（拍板保留）", async () => {
    const { injector, search } = build85({ querySource: "intent" }, () => [mk("页", 0.9)]);
    await injector.execute(mkCtx85("应收暂估回冲怎么处理", null));
    expect(capturedQuery85(search)).toBe("应收暂估回冲怎么处理");
  });

  it("intent 档：turnContext 在但 turnIntent=null（续跑轮）→ 兜底回落消息文本", async () => {
    const { injector, search } = build85({ querySource: "intent" }, () => [mk("页", 0.9)]);
    await injector.execute(mkCtx85("应收暂估回冲怎么处理", { turnIntent: null }));
    expect(capturedQuery85(search)).toBe("应收暂估回冲怎么处理");
  });

  it("intent 档：turnIntent 为空白文本 → 兜底回落消息文本", async () => {
    const { injector, search } = build85({ querySource: "intent" }, () => [mk("页", 0.9)]);
    await injector.execute(mkCtx85("应收暂估回冲怎么处理", { turnIntent: { index: 0, text: "   " } }));
    expect(capturedQuery85(search)).toBe("应收暂估回冲怎么处理");
  });

  it("shadow 档：行为不变（仍用消息文本检索），只记对比日志", async () => {
    const { injector, search } = build85({ querySource: "shadow" }, () => [mk("页", 0.9)]);
    await injector.execute(mkCtx85("应收暂估回冲怎么处理", { turnIntent: { index: 0, text: "完全不同的意图文本" } }));
    expect(capturedQuery85(search)).toBe("应收暂估回冲怎么处理");
  });

  it("缺省（未配置 querySource）= legacy：行为逐位不变，不读 turnIntent", async () => {
    const { injector, search } = build85({}, () => [mk("页", 0.9)]);
    await injector.execute(mkCtx85("应收暂估回冲怎么处理", { turnIntent: { index: 0, text: "intent 文本在但缺省不读" } }));
    expect(capturedQuery85(search)).toBe("应收暂估回冲怎么处理");
  });
});

describe("#85 Q2 结构页主门：正文池全灭 → 整轮不注入（结构页不再单独兜底）", () => {
  const mk = (title: string, score: number, absScore?: number, type = "concept"): WikiSearchHit => ({
    path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
    ...(absScore !== undefined ? { absScore } : {}),
  });

  it("检索结果只有结构页（无正文）→ 不注入任何块（#85 症状②主形态）", async () => {
    const { injector } = build85({}, () => [mk("Wiki Schema", 3.0, undefined, "schema"), mk("运行日志索引", 2.0, undefined, "log")]);
    const blocks = await injector.execute(mkCtx85("第一性原理分析 TDB 记忆注入门槛"));
    expect(blocks).toHaveLength(0);
  });

  it("正文被 ftsGate 全拦 → 结构页不再兜底注入", async () => {
    const { injector } = build85(
      { minInjectFtsScore: 0.9 },
      () => [mk("低分正文页", 0.4, undefined, "concept"), mk("Wiki Schema", 3.0, undefined, "schema")],
    );
    const blocks = await injector.execute(mkCtx85("第一性原理分析 TDB 记忆注入门槛"));
    expect(blocks).toHaveLength(0);
  });

  it("正文存活 + 结构页在场 → W5 附尾形态不变（回归护栏）", async () => {
    const { injector } = build85(
      { minInjectAbsScore: 1.5 },
      () => [mk("运行日志索引", 0.9, undefined, "log"), mk("跨模块接口调用规范", 0.7, 2.0, "source")],
    );
    const blocks = await injector.execute(mkCtx85("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("[structural]");
    expect(blocks[0].content).toContain("跨模块接口调用规范");
  });
});

describe("#85 Q2 结构页次门 minStructuralTailNormScore（子集归一低于阈值不附尾）", () => {
  const mk = (title: string, score: number, type: string): WikiSearchHit => ({
    path: `wiki/${type}/${title}.md`, title, snippet: "s", score, type, hop: 0,
  });

  it("次门启用：子集内归一分低于阈值的结构页不附尾", async () => {
    const { injector } = build85(
      { minStructuralTailNormScore: 0.3 },
      () => [mk("运行日志索引", 5.0, "log"), mk("低分 schema", 0.5, "schema"), mk("正文页", 0.9, "concept")],
    );
    const blocks = await injector.execute(mkCtx85("跨模块调用接口规范"));
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content;
    expect(content).toContain("运行日志索引"); // 子集 max → 1.0 保留
    expect(content).not.toContain("低分 schema"); // 子集 min → 0.0 剔除
  });

  it("次门关闭（缺省 undefined）：结构页附尾行为逐位不变", async () => {
    const { injector } = build85(
      {},
      () => [mk("运行日志索引", 5.0, "log"), mk("低分 schema", 0.5, "schema"), mk("正文页", 0.9, "concept")],
    );
    const blocks = await injector.execute(mkCtx85("跨模块调用接口规范"));
    const content = blocks[0].content;
    expect(content).toContain("运行日志索引");
    expect(content).toContain("低分 schema");
  });

  it("单项结构页：子集归一恒 1.0 → 任何阈值下不误杀", async () => {
    const { injector } = build85(
      { minStructuralTailNormScore: 0.3 },
      () => [mk("唯一结构页", 0.1, "overview"), mk("正文页", 0.9, "concept")],
    );
    const blocks = await injector.execute(mkCtx85("跨模块调用接口规范"));
    expect(blocks[0].content).toContain("唯一结构页");
  });
});

describe("#85 Q1 配置面：querySource / minStructuralTailNormScore 解析", () => {
  const writeTmp85 = (body: string): string => {
    const file = join(tmpdir(), `wiki-recall-85-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(file, body, "utf-8");
    return file;
  };

  it("wikiRecall.querySource 三态解析：intent/shadow 合法、非法值与缺省 → undefined", () => {
    const p1 = writeTmp85("wikiRecall:\n  enabled: true\n  querySource: intent\n");
    try {
      expect(buildConfig({ configFile: p1 }).wikiRecall?.querySource).toBe("intent");
    } finally { rmSync(p1, { force: true }); }
    const p2 = writeTmp85("wikiRecall:\n  enabled: true\n  querySource: shadow\n");
    try {
      expect(buildConfig({ configFile: p2 }).wikiRecall?.querySource).toBe("shadow");
    } finally { rmSync(p2, { force: true }); }
    const p3 = writeTmp85("wikiRecall:\n  enabled: true\n");
    try {
      expect(buildConfig({ configFile: p3 }).wikiRecall?.querySource).toBeUndefined();
    } finally { rmSync(p3, { force: true }); }
    const p4 = writeTmp85("wikiRecall:\n  enabled: true\n  querySource: bogus\n");
    try {
      expect(buildConfig({ configFile: p4 }).wikiRecall?.querySource).toBeUndefined();
    } finally { rmSync(p4, { force: true }); }
  });

  it("wikiRecall.minStructuralTailNormScore 解析：number 直通、缺省 undefined", () => {
    const p1 = writeTmp85("wikiRecall:\n  enabled: true\n  minStructuralTailNormScore: 0.3\n");
    try {
      expect(buildConfig({ configFile: p1 }).wikiRecall?.minStructuralTailNormScore).toBe(0.3);
    } finally { rmSync(p1, { force: true }); }
    const p2 = writeTmp85("wikiRecall:\n  enabled: true\n");
    try {
      expect(buildConfig({ configFile: p2 }).wikiRecall?.minStructuralTailNormScore).toBeUndefined();
    } finally { rmSync(p2, { force: true }); }
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

