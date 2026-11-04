/**
 * P0-1b（task-1）非 hybrid 策略绕过 D-3 敏感注入门的 RED→GREEN 套件。
 *
 * 背景（实测）：sensitivity 门此前只挂在 searchHybrid 内（覆盖 hybrid 合并池），
 * 而 searchMemories 的 keyword / embedding / native-hybrid 三支在进 searchHybrid 之前
 * 就早退返回——这三条策略下 health/finance/relationship 行会被"原样" formatMemoryLine
 * 注入到第三方可见的上下文里。判定唯一源仍是 recall/sensitivity-policy.ts：
 * 可见性未声明（钩子路无 isolationFilter）→ undeclared → fail-closed 拦截；
 * 归属可证为单个非 default 用户（/v3/recall 端点路 isolationFilter.userId）→ private 放行。
 *
 * 铁律：不碰检索选择语义（门只对已 slice 的候选行做纯减法）；断言走真链路
 * performAutoRecall / performLayeredRecall，store 用 mock（不验 store 投影，见另一套件）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall, performLayeredRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import type { IMemoryStore, L1SearchResult, StoreCapabilities } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const CLEAN_TEXT = "公开偏好 无敏感 条目";
const SECRET_TEXT = "健康体检 结果 血压偏高 隐私";

function hit(id: string, content: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.9,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    task_id: "tk",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

const CLEAN = hit("clean-1", CLEAN_TEXT);
const SECRET = hit("secret-1", SECRET_TEXT, { sensitivity: "health" });

function caps(over: Partial<StoreCapabilities> = {}): StoreCapabilities {
  return { vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false, ...over };
}

function mockStore(hits: L1SearchResult[], over: Partial<StoreCapabilities> = {}): IMemoryStore {
  const c = caps(over);
  return {
    getCapabilities: () => c,
    isFtsAvailable: () => true,
    searchL1Fts: async () => hits,
    searchL1Vector: async () => hits,
    searchL1Hybrid: async () => hits,
  } as unknown as IMemoryStore;
}

const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;

function readLastJournalEntry(dataDir: string): Record<string, unknown> | undefined {
  const dir = path.join(dataDir, "logs", "recall");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (files.length === 0) return undefined;
  const lines = fs
    .readFileSync(path.join(dir, files[0]!), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function injectedLines(prependContext: string | undefined): string[] {
  return (prependContext ?? "").split("\n").filter((l) => /^- /.test(l));
}

async function runAutoRecall(
  strategy: "keyword" | "embedding" | "hybrid",
  store: IMemoryStore,
  recallOver: Record<string, unknown> = {},
): Promise<{ lines: string[]; entry: Record<string, unknown> | undefined }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "p0-1b-gate-"));
  try {
    const res = await performAutoRecall({
      userText: "体检 偏好",
      actorId: "p0-1b",
      sessionKey: `p0-1b-${strategy}`,
      cfg: parseConfig({
        recall: { strategy, maxResults: 5, scoreThreshold: 0, ...recallOver },
        recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
      }),
      pluginDataDir: dataDir,
      vectorStore: store,
      embeddingService,
    });
    return { lines: injectedLines(res?.prependContext), entry: readLastJournalEntry(dataDir) };
  } finally {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
}

describe("P0-1b 非 hybrid 策略 · 敏感行不注入（fail-closed）", () => {
  it("strategy=keyword：干净行注入，health 行被门挡住且 journal 记 blocked=1", async () => {
    const { lines, entry } = await runAutoRecall("keyword", mockStore([CLEAN, SECRET]));
    expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    expect(lines.some((l) => l.includes("血压偏高"))).toBe(false);

    const gates = entry?.gates as Record<string, Record<string, unknown>> | undefined;
    expect(gates?.sensitivity).toBeDefined();
    expect(gates!.sensitivity!.audience).toBe("undeclared");
    expect(gates!.sensitivity!.scanned).toBe(1);
    expect(gates!.sensitivity!.blocked).toBe(1);
    expect((gates!.sensitivity!.byReason as Record<string, number> | undefined)?.undeclared).toBe(1);
  });

  it("strategy=embedding：干净行注入，health 行被门挡住", async () => {
    const { lines, entry } = await runAutoRecall("embedding", mockStore([CLEAN, SECRET]));
    expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    expect(lines.some((l) => l.includes("血压偏高"))).toBe(false);
    const gates = entry?.gates as Record<string, Record<string, unknown>> | undefined;
    expect(gates?.sensitivity?.blocked).toBe(1);
  });

  it("native-hybrid：干净行注入，health 行被门挡住（与 nativeMinRRF 计数口径互不吞并）", async () => {
    const { lines, entry } = await runAutoRecall("hybrid", mockStore([CLEAN, SECRET], { nativeHybridSearch: true }));
    expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    expect(lines.some((l) => l.includes("血压偏高"))).toBe(false);
    const gates = entry?.gates as Record<string, Record<string, unknown>> | undefined;
    expect(gates?.sensitivity?.blocked).toBe(1);
  });

  it("native-hybrid：nativeMinRRF 与敏感门可同时生效，journal gates 两键并存互不吞并", async () => {
    // score 0.01 的行被 nativeMinRRF=0.02 挡住 → nativeGateStat 产出；health 行由敏感门挡住。
    // 两门计数口径必须各占一个键（门序：RRF 记账 → 敏感门减法）。
    const weak = hit("weak-1", "无关 弱相关 条目", { score: 0.01 });
    const { lines, entry } = await runAutoRecall(
      "hybrid",
      mockStore([CLEAN, SECRET, weak], { nativeHybridSearch: true }),
      { nativeMinRRF: 0.02 },
    );
    expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    expect(lines.some((l) => l.includes("血压偏高"))).toBe(false);
    const gates = entry?.gates as Record<string, Record<string, unknown>> | undefined;
    expect(gates?.nativeMinRRF).toBeDefined();
    expect(gates?.sensitivity?.blocked).toBe(1);
    // RRF 门的计数不含敏感行（kept=2 = CLEAN+SECRET，dropped=1 = weak）
    expect(gates!.nativeMinRRF!.kept).toBe(2);
    expect(gates!.nativeMinRRF!.dropped).toBe(1);
  });

  it("对照：全干净候选时门不产生 observation（scanned=0 → 无 gates.sensitivity）", async () => {
    const { lines, entry } = await runAutoRecall("keyword", mockStore([CLEAN]));
    expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    const gates = entry?.gates as Record<string, Record<string, unknown>> | undefined;
    expect(gates?.sensitivity).toBeUndefined();
  });
});

describe("P0-1b 私有归属路 · 敏感行放行", () => {
  it("performLayeredRecall + isolationFilter.userId=alice（非 default 桶）→ health 行注入", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "p0-1b-private-"));
    try {
      const res = await performLayeredRecall({
        userText: "体检 偏好",
        sessionKey: "p0-1b-private",
        cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0 } }),
        pluginDataDir: dataDir,
        vectorStore: mockStore([CLEAN, SECRET]),
        isolationFilter: { teamId: "default", userId: "alice", agentId: "default" },
      });
      const lines = res.memoryLines ?? [];
      expect(lines.some((l) => l.includes("血压偏高"))).toBe(true);
      expect(lines.some((l) => l.includes("无敏感"))).toBe(true);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    }
  });
});
