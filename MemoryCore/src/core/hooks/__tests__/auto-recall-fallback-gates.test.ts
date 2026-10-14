/**
 * 召回日志分析修复（2026-10-14，用户拍板「全部修复并推git」）：searchMemories fallback
 * 观测性透传 RED→GREEN 套件。
 *
 * 根因（b68）：searchMemories SQLite fallback 返回行（auto-recall.ts:1545）只透传
 * lines+timing，把 searchHybrid 已产出并已应用的 gates / scores / metas 全部丢弃：
 *   - gates.importancePenalty（P1-T7 已在 searchHybrid 内正确产出）永远到不了 journal；
 *   - scores 缺失 → performAutoRecall metric 上报全 0。
 * 生产实测（journal 3,356 条）：323 条 rerank gate、0 条 importancePenalty gate —— 即本 bug。
 *
 * 契约：
 *   T1 searchHybrid 直接返回 scores（平行 lines，rrfScore 刻度）——精排/折叠已支持平行重映射；
 *   T2 performAutoRecall（fake store 关 nativeHybridSearch 强制 fallback）→ journal 条目
 *      携带 gates.importancePenalty，recalledL1Memories 分数非全 0；
 *   T3 纯噪音查询（剥噪后空串）→ 长度守卫零搜索、零注入、零异常（回归钉）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall, searchHybrid } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1SearchResult, StoreCapabilities } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

// ═══════════════ 共享脚手架（沿 auto-recall-importance.test.ts 同款） ═══════════════

function mkSoul(id: string, score: number, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `FBG 记忆条目 ${id}`,
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
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

const CAPS_FALLBACK: StoreCapabilities = {
  vectorSearch: true,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
};

function mockStoreDual(
  vecHits: L1SearchResult[],
  ftsHits: L1SearchResult[],
): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    getCapabilities: () => CAPS_FALLBACK,
    isFtsAvailable: () => ftsHits.length > 0,
    searchL1Fts: async () => ftsHits,
    searchL1Vector: async () => vecHits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

function rank(over: Partial<{ signals: RankSignals; importanceGate: { penalty: number } }> = {}) {
  return {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals: ZERO_RANK_SIGNALS,
    now: new Date(),
    ...over,
  };
}

/** 双路真平局 fixture：a(fts r0)=1/61；b(vec r0)=1/61；c(vec r1)=1/62。 */
const fixture = (overA: Partial<L1SearchResult> = {}, overB: Partial<L1SearchResult> = {}, overC: Partial<L1SearchResult> = {}) => ({
  vec: [mkSoul("b", 0.5, overB), mkSoul("c", 0.5, overC)],
  fts: [mkSoul("a", 0.5, overA)],
});

// ═══════════════ T1：searchHybrid 返回 scores（平行 lines） ═══════════════

describe("searchHybrid · fallback 路 scores 透传", () => {
  it("scores 与 lines 平行、rrfScore 刻度（双通道 top ≈ 1/61）", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const { vectorStore, embeddingService } = mockStoreDual(f.vec, f.fts);
    const res = await searchHybrid(
      "FBG 查询", "", 10, 0.3, vectorStore, embeddingService, undefined, undefined,
      rank({
        signals: { ...ZERO_RANK_SIGNALS, importancePenalty: 0.5 },
        importanceGate: { penalty: 0.5 },
      }),
      0, undefined, undefined, false, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 },
    );
    expect(res.scores).toBeDefined();
    expect(res.scores!.length).toBe(res.lines.length);
    expect(res.scores!.length).toBeGreaterThan(0);
    for (const s of res.scores!) expect(s).toBeGreaterThan(0);
    expect(res.scores![0]).toBeCloseTo(1 / 61, 10);
    // 伴随断言：gates 仍在场（既有契约不回退）
    expect(res.gates?.importancePenalty).toBeDefined();
  });
});

// ═══════════════ T2：performAutoRecall 集成——journal gates + metric scores ═══════════════

function readLastJournalEntry(dataDir: string): Record<string, unknown> | undefined {
  const dir = path.join(dataDir, "logs", "recall");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (files.length === 0) return undefined;
  const lines = fs.readFileSync(path.join(dir, files[0]!), "utf-8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("performAutoRecall · fallback gates/scores 端到端透传（journal 实证）", () => {
  it("journal 条目携带 gates.importancePenalty；metric scores 非全 0", async () => {
    const f = fixture({ importance: 2 }, { importance: 8 }, { importance: 8 });
    const { vectorStore, embeddingService } = mockStoreDual(f.vec, f.fts);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbg-gates-"));
    try {
      const res = await performAutoRecall({
        userText: "FBG 查询",
        actorId: "fbg",
        sessionKey: "fbg-gates-1",
        cfg: parseConfig({
          recall: {
            strategy: "hybrid",
            maxResults: 5,
            importancePenalty: { enabled: true, penalty: 0.5 },
          },
          recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
        }),
        pluginDataDir: dataDir,
        vectorStore,
        embeddingService,
      });
      // metric 分数：修复前 fallback 无 scores → 全 0；修复后 top=1/61
      const scores = res?.recalledL1Memories.map((m) => m.score) ?? [];
      expect(scores.length).toBeGreaterThan(0);
      expect(scores.some((s) => s > 0)).toBe(true);
      expect(scores[0]).toBeCloseTo(1 / 61, 10);
      // journal 观测：修复前 gates 被丢弃 → 条目无 gates.importancePenalty
      const entry = readLastJournalEntry(dataDir);
      expect(entry).toBeDefined();
      const gates = entry!.gates as Record<string, Record<string, unknown>> | undefined;
      expect(gates?.importancePenalty).toBeDefined();
      expect(gates!.importancePenalty!.penalty).toBe(0.5);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("纯噪音查询（剥噪后空串）→ 零搜索零注入零异常（回归钉）", async () => {
    const f = fixture();
    const { vectorStore, embeddingService } = mockStoreDual(f.vec, f.fts);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbg-noise-"));
    try {
      const res = await performAutoRecall({
        userText:
          '<acp tokens="1" type="text">m9</acp>\nTime sampled while preparing turn 46, step 1: 2026-10-14T17:02:37+08:00[Asia/Shanghai]',
        actorId: "fbg",
        sessionKey: "fbg-noise-1",
        cfg: parseConfig({
          recall: { strategy: "hybrid", maxResults: 5 },
          recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
        }),
        pluginDataDir: dataDir,
        vectorStore,
        embeddingService,
      });
      expect(res === undefined || res.memoryLines.length === 0).toBe(true);
      // journal 照写（query 原文留痕，memoryLines 空 = 零命中诚实口径）
      const entry = readLastJournalEntry(dataDir);
      expect(entry).toBeDefined();
      expect(entry!.memoryLines).toEqual([]);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
