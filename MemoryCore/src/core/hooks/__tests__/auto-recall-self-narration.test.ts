/**
 * A3（P1，2026-11-02）：agent 自述行的**注入面过滤**端到端 RED→GREEN 套件。
 *
 * 契约（沿 auto-recall-fallback-gates.test.ts 同款脚手架）：
 *  T1 `recall.selfNarration.enabled=true` → metadata.actor="agent" 的行不进注入行/召回 item，
 *     journal 记 gates.selfNarration{dropped,scanned}；非 agent 行顺序与内容不变。
 *  T2 缺省（不配本键）→ 逐位现状：agent 行照常注入、journal 无 selfNarration 门。
 *  T3 查询自指（"你之前说过什么"）→ 不过滤（skipped="self-query"），因为那正是用户要的行。
 *  T4 读 actor 只按 recordId 批量查（≤20/片）+ 带隔离三元组；fetch 抛错 → 全保留（降级）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall, searchHybrid } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { ZERO_RANK_SIGNALS } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1SearchResult, StoreCapabilities } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const CAPS_FALLBACK: StoreCapabilities = {
  vectorSearch: true,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
};

function mkSoul(id: string, score: number, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `SNF 记忆条目 ${id}`,
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
    task_id: "tk",
    team_id: "t",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

interface MockOpts {
  /** recordId → metadata_json；缺键 = 库里没有该行（未知）。 */
  meta?: Record<string, string>;
  /** queryL1Records 抛错（降级路径）。 */
  throwOnLookup?: boolean;
  /** 记录每次查询的 filter（断言隔离/分片）。 */
  lookups?: Array<{ recordIds: string[] } & Record<string, unknown>>;
}

function mockStore(
  rows: L1SearchResult[],
  opts: MockOpts = {},
): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    getCapabilities: () => CAPS_FALLBACK,
    isFtsAvailable: () => false,
    searchL1Fts: async () => [],
    searchL1Vector: async () => rows,
    queryL1Records: async (filter: { recordIds?: string[] } & Record<string, unknown>) => {
      opts.lookups?.push(filter as { recordIds: string[] } & Record<string, unknown>);
      if (opts.throwOnLookup) throw new Error("db down");
      return (filter.recordIds ?? []).flatMap((rid) =>
        opts.meta && rid in opts.meta ? [{ record_id: rid, metadata_json: opts.meta[rid]! }] : [],
      );
    },
  } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

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

const AGENT_META = JSON.stringify({ actor: "agent" });
const USER_META = JSON.stringify({ actor: "user" });

async function runRecall(args: {
  rows: L1SearchResult[];
  cfgRecall?: Record<string, unknown>;
  opts?: MockOpts;
  userText?: string;
}): Promise<{
  res: Awaited<ReturnType<typeof performAutoRecall>>;
  dataDir: string;
  mock: ReturnType<typeof mockStore>;
  entry?: Record<string, unknown>;
}> {
  const mock = mockStore(args.rows, args.opts ?? {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snf-"));
  const res = await performAutoRecall({
    userText: args.userText ?? "SNF 查询",
    actorId: "snf",
    sessionKey: "snf-1",
    cfg: parseConfig({
      recall: { strategy: "hybrid", maxResults: 5, ...(args.cfgRecall ?? {}) },
      recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
    }),
    pluginDataDir: dataDir,
    vectorStore: mock.vectorStore,
    embeddingService: mock.embeddingService,
  });
  return { res, dataDir, mock, entry: readLastJournalEntry(dataDir) };
}

function asLines(res: Awaited<ReturnType<typeof performAutoRecall>>): string[] {
  return (res?.recalledL1Memories ?? []).map((m) => m.content);
}

describe("T1 enabled：agent 行不进注入面，journal 记 dropped/scanned", () => {
  it("3 候选（agent/user/未知）→ 只丢 agent 那行，顺序其余不变", async () => {
    const rows = [mkSoul("u1", 0.9), mkSoul("a1", 0.8), mkSoul("u2", 0.7)];
    const { res, dataDir, entry } = await runRecall({
      rows,
      cfgRecall: { selfNarration: { enabled: true } },
      opts: { meta: { u1: USER_META, a1: AGENT_META } },
    });
    try {
      const lines = asLines(res);
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).not.toContain("SNF 记忆条目 a1");
      expect(lines[0]).toContain("u1");
      expect(lines[1]).toContain("u2");
      const gate = (entry!.gates as Record<string, Record<string, unknown>>).selfNarration!;
      expect(gate.enabled).toBe(true);
      expect(gate.dropped).toBe(1);
      // u1/u2 有 recordId 且查到了 actor；a1 也是 scanned 的一部分 → 3
      expect(gate.scanned).toBe(3);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    }
  });
});

describe("T2 缺省关断：逐位现状", () => {
  it("不配 selfNarration → agent 行照常注入，journal 无 selfNarration 门", async () => {
    const rows = [mkSoul("a1", 0.9), mkSoul("u1", 0.8)];
    const { res, dataDir, entry } = await runRecall({
      rows,
      opts: { meta: { a1: AGENT_META, u1: USER_META } },
    });
    try {
      expect(asLines(res)).toHaveLength(2);
      expect(asLines(res).join("\n")).toContain("SNF 记忆条目 a1");
      expect((entry!.gates as Record<string, unknown> | undefined)?.selfNarration).toBeUndefined();
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    }
  });
});

describe("T3 查询自指：不过滤", () => {
  it("「你之前说过什么」→ agent 行保留，gate 标 skipped=self-query", async () => {
    const rows = [mkSoul("a1", 0.9), mkSoul("u1", 0.8)];
    const { res, dataDir, entry } = await runRecall({
      rows,
      userText: "你之前说过什么？",
      cfgRecall: { selfNarration: { enabled: true } },
      opts: { meta: { a1: AGENT_META, u1: USER_META } },
    });
    try {
      const lines = asLines(res);
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).toContain("SNF 记忆条目 a1");
      const gate = (entry!.gates as Record<string, Record<string, unknown>>).selfNarration!;
      expect(gate.skipped).toBe("self-query");
      expect(gate.dropped).toBe(0);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    }
  });
});

describe("T4 读面纪律：分片 + 隔离 + 降级", () => {
  it("按 recordId 批量查、带隔离三元组；fetch 抛错 → 全保留不阻断召回", async () => {
    const lookups: Array<{ recordIds: string[] } & Record<string, unknown>> = [];
    const rows = [mkSoul("a1", 0.9), mkSoul("u1", 0.8)];
    const { res, dataDir } = await runRecall({
      rows,
      cfgRecall: { selfNarration: { enabled: true } },
      opts: { meta: { a1: AGENT_META, u1: USER_META }, throwOnLookup: true, lookups },
    });
    try {
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.recordIds.sort()).toEqual(["a1", "u1"]);
      // 降级：查不到 actor = 未知 = 全部保留
      expect(asLines(res)).toHaveLength(2);
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    }
  });
});

describe("回归钉：searchHybrid 层不掺自述过滤（纯函数只在 performAutoRecall 装配层生效）", () => {
  it("searchHybrid 直接返回三条（含 agent 行），不做 actor 判断", async () => {
    const mock = mockStore([mkSoul("a1", 0.9), mkSoul("u1", 0.8)], { meta: { a1: AGENT_META } });
    const res = await searchHybrid(
      "SNF 查询",
      "",
      5,
      0.3,
      mock.vectorStore,
      mock.embeddingService,
      undefined,
      undefined,
      {
        boost: 0,
        firedLabels: [],
        moodSign: 0,
        timeWindow: null,
        signals: ZERO_RANK_SIGNALS,
        now: new Date(),
      },
    );
    expect(res.lines).toHaveLength(2);
  });
});
