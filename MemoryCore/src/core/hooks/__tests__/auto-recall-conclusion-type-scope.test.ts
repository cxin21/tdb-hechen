/**
 * 结论层候选的类型收窄（2026-11-03）：只消费 work_fact 的通道必须在 SQL 层先按 type 过滤
 * 再 LIMIT，否则长文 consolidated 卡与短 episodic 行在同一 bm25 池子里竞争 top-N 而永远出不来。
 *
 * 本用例用"按调用形态分派"的 mock store 复现该退化：
 *   - 不带 opts.type 的全局检索 → 只返回 10 条 episodic（短、词频占优，模拟把卡挤出榜外）
 *   - 带 opts.type="work_fact" → 返回那条 work_fact 结论卡
 * 断言：①结论层确实把 type 收窄传下去了；②修复后卡片进入注入行；③经验层等其它调用点的
 * 全局检索形态逐位不变（不传 type，不被收窄）。
 *
 * 铁律：不 mock 被测函数内部；只经 IMemoryStore 的 DI seam。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

const KW = "Rk2Scopekw";
const CARD_ID = "dur_scope_card_1";

function ftsRow(id: string, content: string, type: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
    type,
    priority: 0,
    scene_name: "",
    score: 0.9,
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
    ...over,
  } as L1FtsResult;
}

const episodic = (): L1FtsResult[] =>
  Array.from({ length: 10 }, (_, i) => ftsRow(`ep-${i + 1}`, `${KW} 日常进展第 ${i + 1} 条`, "episodic"));
const card = (): L1FtsResult =>
  ftsRow(CARD_ID, `${KW} 【定案·持续态摘要】里程碑 M1 与 reranker 阈值已定案并固化`, "work_fact", {
    scene_name: "consolidated",
    rank: -12.5,
  });

interface Calls {
  withType: Array<{ q: string; type?: string }>;
  global: string[];
}

/** 按 opts.type 分派：全局 → 只有 episodic（复现挤占）；work_fact 收窄 → 返回结论卡。 */
function scopedStore(calls: Calls): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (q: string, k: number, _filter?: unknown, opts?: { type?: string }) => {
      if (opts?.type !== undefined) {
        calls.withType.push({ q, type: opts.type });
        return [card()].slice(0, k);
      }
      calls.global.push(q);
      return episodic().slice(0, k);
    },
    searchL1Vector: async () => [],
  } as unknown as IMemoryStore;
}

function makeCfg(over: Record<string, unknown> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      exploreSlot: false,
      rerankWeights: { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 },
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
      ...over,
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

function paramsFor(dir: string, store: IMemoryStore) {
  return {
    userText: `${KW} 里程碑 M1 reranker 现在到哪一步`,
    sessionKey: "",
    cfg: makeCfg(),
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: { embed: async () => new Float32Array(4) } as unknown as EmbeddingService,
  };
}

describe("结论层候选类型收窄（先过滤再 LIMIT）", () => {
  it("结论层检索带 type='work_fact'，长卡因此可达并进入注入行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-scope-"));
    const calls: Calls = { withType: [], global: [] };
    try {
      const res = await performLayeredRecall(paramsFor(dir, scopedStore(calls)));

      // ① 收窄参数确实传下去了（且用 work_fact）
      expect(calls.withType.length).toBeGreaterThan(0);
      expect(calls.withType.every((c) => c.type === "work_fact")).toBe(true);

      // ② 卡片进入结论层并注入（不修复时全局池全是 episodic → 卡片永不可达）
      expect(res.conclusionCount).toBeGreaterThan(0);
      expect(res.memoryLines.some((l) => l.includes("consolidated") || l.includes("里程碑 M1"))).toBe(true);

      // ③ 其它调用点仍是全局检索（不带 type），说明收窄只作用于结论层
      expect(calls.global.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
