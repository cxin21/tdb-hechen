/**
 * #123（P0 静默空转）：hasClientEmbedding 判据测试。
 *
 * 根因：NoopEmbeddingService.embed() 返回空 Float32Array 且 isReady() 恒 true，
 * 任何「service 存在 / isReady / embed 不抛错」的探针都会判 ok（/health 恒绿、向量恒不写）。
 * 唯一可靠判据是 provider（对齐上游 hasClientEmbedding：provider==='noop' ⇒ false）。
 */
import { describe, it, expect } from "vitest";
import {
  hasClientEmbedding,
  NOOP_EMBEDDING_PROVIDER,
  NoopEmbeddingService,
  type EmbeddingService,
} from "./embedding.js";

/** 最小假 embedder（只关心 provider 判据，其余方法不参与判定）。 */
function fakeEmbedder(provider: string, override?: Partial<EmbeddingService>): EmbeddingService {
  return {
    embed: async () => new Float32Array(4),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(4)),
    getDimensions: () => 4,
    getProviderInfo: () => ({ provider, model: "fake-model" }),
    isReady: () => true,
    startWarmup: () => {},
    ...override,
  };
}

describe("hasClientEmbedding（#123 客户端 embedding 判活）", () => {
  it("T1 Noop 恒判 false —— 即使 isReady()=true、embed() 不抛错、返回空数组", () => {
    const noop = new NoopEmbeddingService();
    // 旧判据（存在/isReady/embed 不抛）全部「通过」——正是假绿来源
    expect(noop.isReady()).toBe(true);
    expect(hasClientEmbedding(noop)).toBe(false);
    expect(noop.getProviderInfo().provider).toBe(NOOP_EMBEDDING_PROVIDER);
  });

  it("T2 真 provider（local/openai/deepseek）判 true", () => {
    expect(hasClientEmbedding(fakeEmbedder("local"))).toBe(true);
    expect(hasClientEmbedding(fakeEmbedder("openai"))).toBe(true);
    expect(hasClientEmbedding(fakeEmbedder("deepseek"))).toBe(true);
  });

  it("T3 无 service（undefined/null）判 false —— 未配置不再等同 ok", () => {
    expect(hasClientEmbedding(undefined)).toBe(false);
    expect(hasClientEmbedding(null)).toBe(false);
  });

  it("T4 getProviderInfo 抛错 → fail-closed false（不可信即不可用）", () => {
    const broken = fakeEmbedder("local", {
      getProviderInfo: () => {
        throw new Error("provider info unavailable");
      },
    });
    expect(hasClientEmbedding(broken)).toBe(false);
  });

  it("T5 空 provider 字符串不是 noop，不误降档（provider 缺失场景由 payload 侧 null 归因）", () => {
    expect(hasClientEmbedding(fakeEmbedder(""))).toBe(true);
  });
});
