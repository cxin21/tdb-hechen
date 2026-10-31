/**
 * #169 证据包（recall.evidencePack）钩子路接线测试。
 *
 * 三条硬要求（Lead m00790）：
 *  ① enabled=false 是硬零行为：block 与 memoryLines 与「cfg 里没这个键」逐位相同，且零 store 读；
 *  ② pack 行只进注入块，memoryLines（= recall 口径/覆盖率口径）逐位不变；
 *  ③ enabled=true 时计数恒出现在 gates.evidencePack（含 adjacencyLines=0 的全零场景）。
 *
 * 铁律：不 mock 被测函数内部；全链走 performLayeredRecall 的 sqlite fallback 路径。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall, resetRerankBreakerForTests } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult, L1RecordRow } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

type PLRParams = Parameters<typeof performLayeredRecall>[0];

const KW = "E1749Probe";
const SID = "sess-169";
const T0 = Date.parse("2026-10-01T10:00:00Z");
const MIN = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ftsRow(id: string, content: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "项目重构",
    score: 0.9,
    timestamp_str: iso(T0),
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk-169",
    session_id: SID,
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

/** 会话全量行（queryL1Records 返回）：r0..r4，各差 1 分钟。 */
function sessionRows(): L1RecordRow[] {
  return [0, 1, 2, 3, 4].map(
    (i) =>
      ({
        record_id: "r" + i,
        content: KW + " 邻接行内容" + i,
        type: "episodic",
        scene_name: "项目重构",
        timestamp_str: iso(T0 + i * MIN),
        session_id: SID,
        session_key: "sk-169",
      }) as unknown as L1RecordRow,
  );
}

interface StoreOpts {
  rows?: L1FtsResult[];
  sessionRows?: L1RecordRow[];
  /** 不实现 queryL1Records（feature-detect 关断路径）。 */
  omitQueryL1Records?: boolean;
  /** queryL1Records 抛错（软失败路径）。 */
  queryThrows?: boolean;
}

function packStore(opts: StoreOpts): { store: IMemoryStore; queryCalls: Array<Record<string, unknown>> } {
  const queryCalls: Array<Record<string, unknown>> = [];
  const base: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => (opts.rows ?? []).slice(0, k),
    searchL1Vector: async () => [],
  };
  if (!opts.omitQueryL1Records) {
    base.queryL1Records = (filter: Record<string, unknown>) => {
      queryCalls.push(filter);
      if (opts.queryThrows) throw new Error("pack store explode");
      return opts.sessionRows ?? [];
    };
  }
  return { store: base as unknown as IMemoryStore, queryCalls };
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
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
      sessionReuseTtlMs: 0,
      ...over,
    },
    recallJournal: { enabled: false, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

function paramsFor(dir: string, store: IMemoryStore, cfg: MemoryTdaiConfig): PLRParams {
  return {
    userText: KW + " 项目进展如何",
    sessionKey: "",
    cfg,
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: mockEmbedding(),
  };
}

async function runWith(cfgOver: Record<string, unknown>, opts: StoreOpts = {}): Promise<{
  res: Awaited<ReturnType<typeof performLayeredRecall>>;
  queryCalls: Array<Record<string, unknown>>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-169-"));
  try {
    const m = packStore({
      ...opts,
      rows: opts.rows ?? [ftsRow("r2", KW + " 命中行内容2", { score: 0.9 })],
      sessionRows: opts.sessionRows ?? sessionRows(),
    });
    const res = await performLayeredRecall(paramsFor(dir, m.store, makeCfg(cfgOver)));
    return { res, queryCalls: m.queryCalls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetRerankBreakerForTests();
});

describe("#169 证据包 关断矩阵", () => {
  it("① cfg 无 evidencePack 键 vs enabled=false → block 与 memoryLines 逐位相同、零 queryL1Records", async () => {
    const a = await runWith({});
    const b = await runWith({ evidencePack: { enabled: false, adjacent: 2, windowMinutes: 60 } });
    expect(b.res.block).toBe(a.res.block);
    expect(b.res.memoryLines).toEqual(a.res.memoryLines);
    expect(a.queryCalls).toHaveLength(0);
    expect(b.queryCalls).toHaveLength(0);
    expect(a.res.gates?.evidencePack).toBeUndefined();
    expect(b.res.gates?.evidencePack).toBeUndefined();
    expect(a.res.block).not.toContain("·[邻]");
  });

  it("② enabled 但 store 未实现 queryL1Records（feature-detect）→ 不炸、block 不变、无 gates 段", async () => {
    const a = await runWith({});
    const b = await runWith({ evidencePack: { enabled: true } }, { omitQueryL1Records: true });
    expect(b.res.block).toBe(a.res.block);
    expect(b.res.gates?.evidencePack).toBeUndefined();
  });

  it("③ enabled 但 queryL1Records 抛错（软失败）→ 主链不断、block 不变、无 pack 行", async () => {
    const a = await runWith({});
    const b = await runWith({ evidencePack: { enabled: true } }, { queryThrows: true });
    expect(b.res.block).toBe(a.res.block);
    expect(b.res.memoryLines).toEqual(a.res.memoryLines);
  });
});

describe("#169 证据包 扩展主路径", () => {
  it("④ ±1：命中行 r2 之后插入 r1、r3，带 ·[邻]；memoryLines 逐位不变", async () => {
    const off = await runWith({});
    const on = await runWith({ evidencePack: { enabled: true, adjacent: 1, windowMinutes: 30 } });
    const blockLines = (on.res.block ?? "").split("\n").filter((l) => l.includes("邻接行内容"));
    expect(blockLines).toHaveLength(2);
    expect(blockLines[0]).toContain("邻接行内容1");
    expect(blockLines[1]).toContain("邻接行内容3");
    for (const l of blockLines) expect(l.trimEnd().endsWith("·[邻]")).toBe(true);
    // ②：口径本体不含 pack 行
    expect(on.res.memoryLines).toEqual(off.res.memoryLines);
    expect(on.res.memoryLines.some((l) => l.includes("邻接行内容"))).toBe(false);
    // pack 行紧跟在 seed 行之后
    const all = (on.res.block ?? "").split("\n");
    const seedIdx = all.findIndex((l) => l.includes("命中行内容2"));
    expect(seedIdx).toBeGreaterThan(-1);
    expect(all[seedIdx + 1]).toContain("邻接行内容1");
    expect(on.queryCalls).toHaveLength(1);
    expect(on.queryCalls[0]).toMatchObject({ sessionId: SID });
  });

  it("⑤ gates.evidencePack 计数：seed/expanded/sessions 全可读，且不进 memoryLines 口径", async () => {
    const on = await runWith({ evidencePack: { enabled: true, adjacent: 1, windowMinutes: 30 } });
    const ep = on.res.gates?.evidencePack;
    expect(ep).toBeDefined();
    expect(ep!.enabled).toBe(true);
    expect(ep!.adjacent).toBe(1);
    expect(ep!.windowMinutes).toBe(30);
    expect(ep!.seedLines).toBe(1);
    expect(ep!.seedWithSession).toBe(1);
    expect(ep!.adjacencyLines).toBe(2);
    expect(ep!.skippedWindow).toBe(0);
    expect(ep!.skippedCap).toBe(0);
    expect(ep!.sessionsQueried).toBe(1);
  });

  it("⑥ 越窗拒：d=2 的邻居超窗 → 只拒该行，skippedWindow 出现在 gates（要求③）", async () => {
    const rows = sessionRows();
    // r0 挪到 33 分钟前（超默认 30min 窗）：seed=r2 时 d=2 才会碰到它
    (rows[0] as unknown as { timestamp_str: string }).timestamp_str = iso(T0 - 31 * MIN);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-169-win-"));
    try {
      const m = packStore({ rows: [ftsRow("r2", KW + " 命中行内容2")], sessionRows: rows });
      const res = await performLayeredRecall(paramsFor(dir, m.store, makeCfg({ evidencePack: { enabled: true, adjacent: 2, windowMinutes: 30 } })));
      const ep = res.gates?.evidencePack;
      expect(ep!.adjacent).toBe(2);
      expect(ep!.skippedWindow).toBe(1);
      // d=1 取 r1/r3（都在窗内），d=2 取 r4（窗内）并跳过超窗的 r0 ⇒ 共 3 行
      expect(ep!.adjacencyLines).toBe(3);
      expect(res.block).toContain("邻接行内容3");
      expect(res.block).toContain("邻接行内容1");
      expect(res.block).toContain("邻接行内容4");
      expect(res.block).not.toContain("邻接行内容0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑧ 预算：pack 行与 seed 行吃同一字符预算（帽满先丢 pack，seed 保留，计数照实）", async () => {
    const open = await runWith({ evidencePack: { enabled: true, adjacent: 1, windowMinutes: 30 } });
    const openBlock = open.res.block ?? "";
    const seedLine = openBlock.split("\n").find((l) => l.startsWith("- ") && !l.includes("·[邻]"));
    expect(seedLine).toBeDefined();
    const capped = await runWith({
      evidencePack: { enabled: true, adjacent: 1, windowMinutes: 30 },
      maxTotalRecallChars: (seedLine as string).length,
    });
    // seed 恰好占满预算 ⇒ pack 行被同一预算函数丢掉；但「扩了又被裁」要在 journal 里如实可见
    expect(capped.res.block ?? "").toContain("命中行内容2");
    expect(capped.res.block ?? "").not.toContain("·[邻]");
    expect(capped.res.gates?.evidencePack?.adjacencyLines).toBe(2);
  });

  it("⑦ 全零也算：命中行无 session（无法定位）→ gates 仍带全零证据包计数", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-169-zero-"));
    try {
      const m = packStore({
        rows: [ftsRow("r2", KW + " 命中行内容2", { session_id: "" })],
        sessionRows: [],
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, makeCfg({ evidencePack: { enabled: true } })));
      const ep = res.gates?.evidencePack;
      expect(ep).toEqual({
        enabled: true,
        adjacent: 1,
        windowMinutes: 30,
        maxExtraLines: 6,
        seedLines: 1,
        seedWithSession: 0,
        adjacencyLines: 0,
        skippedNoSession: 1,
        skippedNoSeedRow: 0,
        skippedWindow: 0,
        skippedCap: 0,
        skippedSessionTooLarge: 0,
        sessionsQueried: 0,
      });
      expect(res.block).not.toContain("·[邻]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
