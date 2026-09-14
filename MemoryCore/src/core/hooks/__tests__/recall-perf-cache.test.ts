/**
 * R-A3 E1/E3 RED 套件（性能速赢：query embedding 60s TTL 缓存 / 同 session 同 query 复用注入块）。
 * E1：key=query 原文，TTL 内命中免外呼（embed 调用计数验证）；ttl=0 → 通道关。
 * E3：同 sessionKey 上轮 query 与本轮**全等**才复用（不做模糊）；query 变化/TTL 过期/ttl=0 → 失效。
 * E1/E3 隔离验证：E3 测试将 queryEmbeddingCacheTtlMs 置 0，embed 计数不变只能来自 E3 复用。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedQueryEmbedding, executeMemorySearch, type MemorySearchResult } from "../../tools/memory-search.js";
import { performAutoRecall } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

const KW = "RA3PIN";

function vecRow(id: string, score = 0.5): L1SearchResult {
  return {
    record_id: id,
    content: `${KW} 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
  };
}

function vecOnlyStore(hits: L1SearchResult[]): {
  store: IMemoryStore;
  embeddingService: EmbeddingService;
  embedCalls: () => number;
} {
  let calls = 0;
  const vectorStore = {
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Vector: async () => hits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => {
      calls++;
      return new Float32Array(4);
    },
  } as unknown as EmbeddingService;
  return { store: vectorStore, embeddingService, embedCalls: () => calls };
}

// ═══════════════ E1 · query embedding TTL 缓存 ═══════════════

describe("E1 query embedding TTL 缓存（咽喉 executeMemorySearch）", () => {
  it("TTL 内同 query 二次搜索 → 免外呼（embed 只调一次）", async () => {
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    const p = { query: `${KW} 偏好一`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 60_000, scoreThreshold: 0 } as unknown as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(p);
    await executeMemorySearch(p);
    expect(embedCalls()).toBe(1);
  });

  it("不同 query → 各自外呼", async () => {
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    await executeMemorySearch({ query: `${KW} 偏好二`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 60_000, scoreThreshold: 0 } as Parameters<typeof executeMemorySearch>[0]);
    await executeMemorySearch({ query: `${KW} 偏好三`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 60_000, scoreThreshold: 0 } as Parameters<typeof executeMemorySearch>[0]);
    expect(embedCalls()).toBe(2);
  });

  it("ttl=0 → 通道关（每次外呼）", async () => {
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    const p = { query: `${KW} 偏好四`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 0, scoreThreshold: 0 } as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(p);
    await executeMemorySearch(p);
    expect(embedCalls()).toBe(2);
  });

  it("TTL 过期 → 重新外呼", async () => {
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    const p = { query: `${KW} 偏好五`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 30, scoreThreshold: 0 } as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(p);
    await new Promise((r) => setTimeout(r, 50));
    await executeMemorySearch(p);
    expect(embedCalls()).toBe(2);
  });

  it("同 query 不同 embeddingService 实例 → 各自外呼（key 掺实例身份，审查 #2 修补）", async () => {
    // 修复前 key=query 原文：第二个实例会吃到第一个实例的缓存向量（跨实例脏读）。
    const a = vecOnlyStore([vecRow("a")]);
    const b = vecOnlyStore([vecRow("a")]);
    const mk = (s: ReturnType<typeof vecOnlyStore>) =>
      ({ query: `${KW} 实例隔离`, limit: 5, vectorStore: s.store, embeddingService: s.embeddingService, queryEmbeddingCacheTtlMs: 60_000, scoreThreshold: 0 }) as unknown as Parameters<typeof executeMemorySearch>[0];
    await executeMemorySearch(mk(a));
    await executeMemorySearch(mk(b));
    expect(a.embedCalls()).toBe(1);
    expect(b.embedCalls()).toBe(1);
  });

  it("缓存命中不改变结果内容（语义零变化）", async () => {
    const { store, embeddingService } = vecOnlyStore([vecRow("a")]);
    const p = { query: `${KW} 偏好六`, limit: 5, vectorStore: store, embeddingService, queryEmbeddingCacheTtlMs: 60_000, scoreThreshold: 0 } as Parameters<typeof executeMemorySearch>[0];
    const r1: MemorySearchResult = await executeMemorySearch(p);
    const r2 = await executeMemorySearch(p);
    expect(r2.results.map((r) => r.id)).toEqual(r1.results.map((r) => r.id));
  });

  // ── S7 第 8 项（批 2 fix1 concern ①）：缓存 key 掺请求 opts（防未来）──
  it("同 query 同实例不同 embed opts → 各自外呼；同 opts 命中", async () => {
    const { embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    // 修复前 key=实例+query：不同 opts 吃同一缓存向量（未来 embed opts 携带维度/指令时脏读）
    await cachedQueryEmbedding(embeddingService, `${KW} opts 隔离`, 60_000, undefined, { dims: 4 } as never);
    await cachedQueryEmbedding(embeddingService, `${KW} opts 隔离`, 60_000, undefined, { dims: 8 } as never);
    expect(embedCalls()).toBe(2);
    await cachedQueryEmbedding(embeddingService, `${KW} opts 隔离`, 60_000, undefined, { dims: 4 } as never);
    expect(embedCalls()).toBe(2); // 同 opts → TTL 内命中
  });
});

// ═══════════════ E3 · 同 session 同 query 复用注入块 ═══════════════

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ra3-e3-"));
}

function makeCfg(over: Record<string, unknown> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      coreRefBoost: 0,
      queryEmbeddingCacheTtlMs: 0, // 隔离 E1：embed 计数变化只能来自 E3 复用
      sessionReuseTtlMs: 300_000,
      ...over,
    },
  } as unknown as MemoryTdaiConfig;
}

describe("E3 同 session 同 query 复用（performAutoRecall）", () => {
  it("同 session 上轮 query 与本轮全等 → 复用（免搜索免外呼），注入块一致", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    try {
      const base = {
        actorId: "a1",
        sessionKey: "sess-e3-1",
        cfg: makeCfg(),
        pluginDataDir: dir,
        vectorStore: store,
        embeddingService,
      };
      const r1 = await performAutoRecall({ ...base, userText: `${KW} 复用场景一` });
      const r2 = await performAutoRecall({ ...base, userText: `${KW} 复用场景一` });
      expect(embedCalls()).toBe(1); // 第二轮整体复用（E1 已关）
      expect(r1?.prependContext).toBe(r2?.prependContext);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("query 变化 → 不复用（重新搜索）", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    try {
      const base = {
        actorId: "a1",
        sessionKey: "sess-e3-2",
        cfg: makeCfg(),
        pluginDataDir: dir,
        vectorStore: store,
        embeddingService,
      };
      await performAutoRecall({ ...base, userText: `${KW} 复用场景二甲` });
      await performAutoRecall({ ...base, userText: `${KW} 复用场景二乙` });
      expect(embedCalls()).toBe(2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("sessionReuseTtlMs=0 → 通道关（每轮重新搜索）", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    try {
      const base = {
        actorId: "a1",
        sessionKey: "sess-e3-3",
        cfg: makeCfg({ sessionReuseTtlMs: 0 }),
        pluginDataDir: dir,
        vectorStore: store,
        embeddingService,
      };
      await performAutoRecall({ ...base, userText: `${KW} 复用场景三` });
      await performAutoRecall({ ...base, userText: `${KW} 复用场景三` });
      expect(embedCalls()).toBe(2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("TTL 过期 → 重新搜索", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    try {
      const base = {
        actorId: "a1",
        sessionKey: "sess-e3-4",
        cfg: makeCfg({ sessionReuseTtlMs: 30 }),
        pluginDataDir: dir,
        vectorStore: store,
        embeddingService,
      };
      await performAutoRecall({ ...base, userText: `${KW} 复用场景四` });
      await new Promise((r) => setTimeout(r, 60));
      await performAutoRecall({ ...base, userText: `${KW} 复用场景四` });
      expect(embedCalls()).toBe(2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("不同 session 同 query → 不复用（会话隔离）", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([vecRow("a")]);
    try {
      const cfg = makeCfg();
      const pluginDataDir = dir;
      await performAutoRecall({ actorId: "a1", sessionKey: "sess-e3-5a", cfg, pluginDataDir, vectorStore: store, embeddingService, userText: `${KW} 复用场景五` });
      await performAutoRecall({ actorId: "a1", sessionKey: "sess-e3-5b", cfg, pluginDataDir, vectorStore: store, embeddingService, userText: `${KW} 复用场景五` });
      expect(embedCalls()).toBe(2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("空结果不入缓存（审查 #3 修补）：瞬时空召回下一轮重新搜索，不放大成 TTL 窗口持续空召回", async () => {
    const dir = makeTmpDir();
    const { store, embeddingService, embedCalls } = vecOnlyStore([]); // 空结果路径
    try {
      const base = {
        actorId: "a1",
        sessionKey: "sess-e3-7",
        cfg: makeCfg(),
        pluginDataDir: dir,
        vectorStore: store,
        embeddingService,
      };
      await performAutoRecall({ ...base, userText: `${KW} 空结果场景` });
      await performAutoRecall({ ...base, userText: `${KW} 空结果场景` });
      // 修复前：首轮空结果入缓存 → 第二轮整体复用只调 1 次 embed；
      // 修复后：空结果不入缓存 → 第二轮真实搜索。
      expect(embedCalls()).toBe(2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("同 session 同 query 但 store 实例不同 → 不复用（verify-s5 C5-2a/2b 跨库脏读缺口）", async () => {
    const dir = makeTmpDir();
    const a = vecOnlyStore([vecRow("a")]);
    const b = vecOnlyStore([vecRow("b", 0.9)]);
    try {
      const cfg = makeCfg();
      const pluginDataDir = dir;
      await performAutoRecall({ actorId: "a1", sessionKey: "sess-e3-6", cfg, pluginDataDir, vectorStore: a.store, embeddingService: a.embeddingService, userText: `${KW} 复用场景六` });
      await performAutoRecall({ actorId: "a1", sessionKey: "sess-e3-6", cfg, pluginDataDir, vectorStore: b.store, embeddingService: b.embeddingService, userText: `${KW} 复用场景六` });
      expect(b.embedCalls()).toBe(1); // 新 store 必须真实搜索，不得吃到旧 store 的缓存
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
