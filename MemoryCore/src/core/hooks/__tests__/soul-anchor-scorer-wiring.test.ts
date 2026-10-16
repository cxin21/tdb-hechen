/**
 * #42（ADR0003-P3 实施票 D / D9）审查加固（F1 生产接线）：auto-recall 侧 anchorSelect
 * 运行时组装测试。合同：config 门透传；embedder/queryEmbeddingProvider 运行时注入
 * （config 不携带向量）；provider=懒解析（cachedQueryEmbedding 与检索路共享 TTL 去重，
 * embed 失败→undefined=宁缺毋滥回退现状）；queryText=cacheKey 指纹源（query 变→键变）。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulAnchorSelectRuntime } from "../auto-recall.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import type { EmbeddingService } from "../../store/embedding.js";

function makeEmbeddingService(impl: (text: string) => Promise<Float32Array>): EmbeddingService {
  return { embed: vi.fn(impl) } as unknown as EmbeddingService;
}

function makeCfg(opts: { anchorSelect?: boolean; ttl?: number } = {}): MemoryTdaiConfig {
  return {
    coreMemory: {
      soulRender: opts.anchorSelect === false
        ? {}
        : { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.5 } } },
    },
    recall: { queryEmbeddingCacheTtlMs: opts.ttl ?? 60_000 },
  } as unknown as MemoryTdaiConfig;
}

describe("#42 审查加固：buildSoulAnchorSelectRuntime（auto-recall 生产接线）", () => {
  it("组装：embedder/provider 函数化 + queryText=userText；provider 解析走 cachedQueryEmbedding（userText）", async () => {
    const embed = makeEmbeddingService(async (t) => new Float32Array([t.length, 1]));
    const sel = buildSoulAnchorSelectRuntime(makeCfg(), {
      embeddingService: embed,
      userText: "查询一下锚定情况",
      logger: undefined,
    });
    expect(sel).toBeDefined();
    expect(sel!.scorer!.embedder).toBeTypeOf("function");
    expect(sel!.scorer!.queryEmbeddingProvider).toBeTypeOf("function");
    expect(sel!.scorer!.queryText).toBe("查询一下锚定情况");
    const vec = await sel!.scorer!.queryEmbeddingProvider!();
    expect(vec).toBeInstanceOf(Float32Array);
    expect(embed.embed).toHaveBeenCalledWith("查询一下锚定情况", undefined);
  });

  it("embed 拒绝 → provider 解析为 undefined（宁缺毋滥回退，不抛错）", async () => {
    const embed = makeEmbeddingService(async () => {
      throw new Error("embed service down");
    });
    const sel = buildSoulAnchorSelectRuntime(makeCfg(), { embeddingService: embed, userText: "q", logger: undefined });
    await expect(sel!.scorer!.queryEmbeddingProvider!()).resolves.toBeUndefined();
  });

  it("无 embeddingService → embedder/provider undefined（渲染回退现状）；queryText 仍携带", () => {
    const sel = buildSoulAnchorSelectRuntime(makeCfg(), { userText: "q", logger: undefined });
    expect(sel).toBeDefined();
    expect(sel!.scorer!.embedder).toBeUndefined();
    expect(sel!.scorer!.queryEmbeddingProvider).toBeUndefined();
    expect(sel!.scorer!.queryText).toBe("q");
  });

  it("无 anchorSelect 配置 → undefined（整段不参与）；embed 零调用", () => {
    const embed = makeEmbeddingService(async () => new Float32Array([1, 0]));
    const sel = buildSoulAnchorSelectRuntime(makeCfg({ anchorSelect: false }), {
      embeddingService: embed,
      userText: "q",
      logger: undefined,
    });
    expect(sel).toBeUndefined();
    expect(embed.embed).not.toHaveBeenCalled();
  });

  it("TTL 共享：60s 内重复解析零重复 embed（与检索路同缓存）；ttl=0 直连每次 embed", async () => {
    const embed60 = makeEmbeddingService(async () => new Float32Array([1, 0]));
    const sel60 = buildSoulAnchorSelectRuntime(makeCfg({ ttl: 60_000 }), {
      embeddingService: embed60,
      userText: "q",
      logger: undefined,
    });
    await sel60!.scorer!.queryEmbeddingProvider!();
    await sel60!.scorer!.queryEmbeddingProvider!();
    expect(embed60.embed).toHaveBeenCalledTimes(1); // cachedQueryEmbedding TTL 去重

    const embed0 = makeEmbeddingService(async () => new Float32Array([1, 0]));
    const sel0 = buildSoulAnchorSelectRuntime(makeCfg({ ttl: 0 }), {
      embeddingService: embed0,
      userText: "q",
      logger: undefined,
    });
    await sel0!.scorer!.queryEmbeddingProvider!();
    await sel0!.scorer!.queryEmbeddingProvider!();
    expect(embed0.embed).toHaveBeenCalledTimes(2); // ttl=0 绕过缓存
  });
});
