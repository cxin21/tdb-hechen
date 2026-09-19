/**
 * F-EV12-2（REG-REMAINING-006 A-2）RED 套件：E3 session-reuse 缓存租户隔离。
 *
 * 实锤（2026-09-19 审计活体复现）：/v3/recall body 缺 session_id → sessionKey=""
 * 全员共享一桶（auto-recall.ts:161/528/596 键=sessionKey 单值、命中条件无租户），
 * 同 query 300s 内跨租户复用注入记忆列表——A桶（ev12-user-a）召回后 P桶
 * （ev12-user-p）同 query 收到 A桶 5 条 persona 记忆（跨用户泄漏）。
 *
 * 不变量：
 *  ①空 sessionKey → 复用通道整体关断（与 v2-router "空 sessionKey→通道退出" 语义对齐）；
 *  ②缓存键并入租户三元组（teamId/userId/agentId）；
 *  ③同租户同 session 同 query 的复用语义保留（E3 原意，正向控制）。
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

function makeCfg(): MemoryTdaiConfig {
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
    userText: `${KW} 租户隔离探针`,
    sessionKey,
    cfg: makeCfg(),
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService,
    isolationFilter: filter,
  };
}

describe("F-EV12-2 · E3 缓存租户隔离", () => {
  it("跨租户：同 sessionKey 同 query（同一 store 实例——生产形态）→ 不得复用", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-ev12-2-"));
    try {
      // 生产形态 = 同一 store/embedding 实例服务多租户（泄漏实例检查不设防），
      // 泄漏唯一屏障就是缓存键——这正是 F-EV12-2 的修复面。
      const s = vecOnlyStore([vecRow("a")]);
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-t", { teamId: "teamA", userId: "uA", agentId: "ag" }));
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-t", { teamId: "teamB", userId: "uB", agentId: "ag" }));
      expect(s.embedCalls()).toBe(2); // 修复前：1（同实例命中缓存 → 跨租户泄漏 A桶块给 B桶）
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("空 sessionKey（/v3/recall 无 session_id）→ 通道关断（两次都检索）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-ev12-2-"));
    try {
      const s = vecOnlyStore([vecRow("a")]);
      const f = { teamId: "teamA", userId: "uA", agentId: "ag" };
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "", f));
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "", f));
      expect(s.embedCalls()).toBe(2); // 修复前：1（缓存命中）
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("正向控制：同租户同 session 同 query → 复用语义保留（embed 1 次）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-ev12-2-"));
    try {
      const s = vecOnlyStore([vecRow("a")]);
      const f = { teamId: "teamA", userId: "uA", agentId: "ag" };
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-t2", f));
      await performLayeredRecall(paramsFor(dir, s.store, s.embeddingService, "sess-t2", f));
      expect(s.embedCalls()).toBe(1);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
