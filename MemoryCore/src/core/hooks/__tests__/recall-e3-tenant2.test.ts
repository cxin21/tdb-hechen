/**
 * F-EV12-2-b（REG-REMAINING-006 A-2 硬化）RED：结论层幂等缓存跨租户共享。
 *
 * 实证链：/v3/recall 不传 session_id 时 resolveIsolation 把 sessionId 缺省填充为
 * "default"（v2-schemas.ts:393，v2-router:1635 注释宣称 "" 与实现不符）→
 * 结论层缓存键=sessionKey 单键 → 跨租户共享。活体：P桶-b/Q桶（不同租户、同空指纹）
 * meta.sessionReused=true（2026-09-19 11:0x 复测）。命中需 fingerprint 相等
 * （内容良性），但 LRU 互相驱逐 + reused 标志语义失真。
 * 不变量：同 sessionKey 不同租户（同指纹）→ 不得 reused。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

const KW = "FEV12PIN";

function vecOnlyStore(hits: L1SearchResult[]): {
  store: IMemoryStore;
  embeddingService: EmbeddingService;
} {
  const vectorStore = {
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Vector: async () => hits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { store: vectorStore, embeddingService };
}

function makeCfg(): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      coreRefBoost: 0,
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
    },
  } as unknown as MemoryTdaiConfig;
}

function paramsFor(
  dir: string,
  store: IMemoryStore,
  embeddingService: EmbeddingService,
  sessionKey: string,
  filter: { teamId: string; userId: string; agentId: string },
): Parameters<typeof performLayeredRecall>[0] {
  return {
    userText: `${KW} 结论层租户隔离探针`,
    sessionKey,
    cfg: makeCfg(),
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService,
    isolationFilter: filter,
  };
}

describe("F-EV12-2-b · 结论层幂等缓存租户隔离", () => {
  it("同 sessionKey 不同租户（同空指纹）→ 不得跨租户 reused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-ev12-2b-"));
    try {
      const s = vecOnlyStore([]); // 无召回 → r7Conclusions 空 → fingerprint 恒定
      const fA = { teamId: "teamA", userId: "uA", agentId: "ag" };
      const fB = { teamId: "teamB", userId: "uB", agentId: "ag" };
      const r1 = await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-c", fA));
      const r2 = await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-c", fB));
      expect(r1?.sessionReused ?? false).toBe(false);
      expect(r2?.sessionReused ?? false).toBe(false); // 修复前：true（"sess-c" 单键共享）
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
