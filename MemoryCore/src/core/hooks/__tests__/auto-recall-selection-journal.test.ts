/**
 * #179 选线生产装配的端到端用例（真链路：parseConfig → performLayeredRecall 装配 → 真 journal 文件）。
 *
 * 覆盖：
 *   - mode:off 缺省 = 今天行为（行不减少、droppedBy 全 0、不调 embedding、观测面照记）
 *   - mode:enforce = 名次尺真裁行（同层 4 行 keepRatio 0.5 → 保留 2、droppedBy.rank=2）
 *   - 降级 = 嵌入抛错时注入行与 off 逐位一致 + journal ruler.bypass="ruler-unavailable"
 *   - 同回合折叠 = 相邻回合逐字节相同 → 第二回合 0 行（折叠台账只在钩子装配路）
 *
 * 铁律：临时 SQLite / 临时 pluginDataDir；零注入生产库、零删除生产数据。
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall, performLayeredRecall } from "../auto-recall.js";
import { clearEmbeddingCache } from "../../recall/selection/injection-wiring.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { IMemoryStore } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

// ═══════════════ 脚手架 ═══════════════

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `采购单据 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "sel-journal",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-12T00:00:00Z"],
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "sel-journal",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sel-journal-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

function cleanup(store: VectorStore, dir: string): void {
  try {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 无害 */
  }
}

/** 假 embedding：向量全同（cosine 全 1 ⇒ 名次按 order 兜底，与单测口径一致）。 */
function fakeEmbedding(opts: { fail?: boolean } = {}): { svc: EmbeddingService; calls: () => number } {
  let calls = 0;
  const svc = {
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]): Promise<Float32Array[]> => {
      calls++;
      if (opts.fail) throw new Error("fake embedding down");
      return texts.map(() => new Float32Array([1, 0, 0]));
    },
    getDimensions: () => 3,
    getProviderInfo: () => ({ provider: "fake", model: "fake-embed" }),
    isReady: () => true,
    startWarmup: () => {
      /* noop */
    },
    close: async () => {
      /* noop */
    },
  } as unknown as EmbeddingService;
  return { svc, calls: () => calls };
}

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sel-journal-data-"));
}

/** 读真 journal 文件（appendRecallJournal 落盘的 jsonl），返回逐条 entry。 */
function readJournal(dataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(dataDir, "logs", "recall");
  expect(fs.existsSync(dir)).toBe(true);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf-8").trim();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const query = "采购单据";

function cfgOf(overrides: Record<string, unknown> = {}): ReturnType<typeof parseConfig> {
  return parseConfig({
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
    recall: { strategy: "keyword", maxResults: 8, ...overrides },
  });
}

const ROWS = [
  mk("sel-1", { content: "采购单据 条目一 行甲" }),
  mk("sel-2", { content: "采购单据 条目二 行乙" }),
  mk("sel-3", { content: "采购单据 条目三 行丙" }),
  mk("sel-4", { content: "采购单据 条目四 行丁" }),
];

function injectedLines(text: string | undefined): string[] {
  return (text ?? "").split("\n").filter((l) => /^- /.test(l));
}

// ═══════════════ 用例 ═══════════════

describe("#179 选线装配 · 观测面与行为", () => {
  // 嵌入缓存是进程级内容寻址缓存（injection-wiring.ts）：同一批行在别的用例里嵌过就会命中，
  // 于是「模拟嵌入抛错」会因零请求而不再抛错。用例要的是冷缓存语义，故每例先清空。
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it("mode:off（缺省）：行不减少、droppedBy 全 0、不调 embedding，但观测面照记", async () => {
    const { store, dir } = makeStore(ROWS);
    const dataDir = makeDataDir();
    const fake = fakeEmbedding();
    try {
      const res = await performAutoRecall({
        userText: query,
        actorId: "r7sel",
        sessionKey: "sel-off-1",
        cfg: cfgOf(),
        pluginDataDir: dataDir,
        vectorStore: store as unknown as IMemoryStore,
        embeddingService: fake.svc,
      });
      const lines = injectedLines(res?.prependContext);
      expect(lines.length).toBeGreaterThan(0);
      const entry = readJournal(dataDir)[0]!;
      expect(entry.ruler).toMatchObject({ mode: "off", floorSource: "uncalibrated", floor: null });
      expect(entry.selection).toMatchObject({
        kept: lines.length,
        injected: lines.length,
        droppedBy: { rank: 0, floor: 0, budget: 0, fold: 0 },
      });
      expect((entry.fold as { identicalLines: number }).identicalLines).toBe(0);
      const cand = entry.candidates as { total: number; lines: unknown[] };
      expect(cand.total).toBe(lines.length);
      expect(cand.lines.length).toBe(lines.length);
      // 观测面不是行为开关：off 不调 embedding
      expect(fake.calls()).toBe(0);
    } finally {
      cleanup(store, dir);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("mode:enforce：名次尺真裁行（同层 4→2），恒等式 kept+dropped=total 成立", async () => {
    const { store, dir } = makeStore(ROWS);
    const dataDir = makeDataDir();
    const fake = fakeEmbedding();
    try {
      const res = await performAutoRecall({
        userText: query,
        actorId: "r7sel",
        sessionKey: "sel-enforce-1",
        cfg: cfgOf({ layerRuler: { mode: "enforce", keepRatio: 0.5, minPerLayer: 1, floor: null } }),
        pluginDataDir: dataDir,
        vectorStore: store as unknown as IMemoryStore,
        embeddingService: fake.svc,
      });
      const lines = injectedLines(res?.prependContext);
      const entry = readJournal(dataDir)[0]!;
      const ruler = entry.ruler as { mode: string; floorSource: string; floor: number | null };
      expect(ruler.mode).toBe("enforce");
      expect(ruler.floorSource).toBe("uncalibrated");
      const cand = entry.candidates as { total: number; lines: Array<{ kept: boolean }> };
      const sel = entry.selection as {
        kept: number;
        injected: number;
        droppedBy: { rank: number; floor: number; margin: number; dup: number; budget: number; fold: number };
      };
      const dropped =
        sel.droppedBy.rank +
        sel.droppedBy.floor +
        sel.droppedBy.margin +
        sel.droppedBy.dup +
        sel.droppedBy.budget +
        sel.droppedBy.fold;
      // 4 条同层 → ceil(4×0.5)=2 保留、2 条按名次丢
      expect(cand.total).toBe(4);
      expect(sel.kept).toBe(2);
      expect(sel.droppedBy.rank).toBe(2);
      expect(sel.kept + dropped).toBe(cand.total);
      expect(lines.length).toBe(2);
      expect(fake.calls()).toBe(1);
    } finally {
      cleanup(store, dir);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("降级：嵌入抛错 → 注入行与 off 逐位一致 + journal 记 ruler.bypass", async () => {
    const { store, dir } = makeStore(ROWS);
    const offDir = makeDataDir();
    const badDir = makeDataDir();
    const okFake = fakeEmbedding();
    const badFake = fakeEmbedding({ fail: true });
    try {
      const off = await performAutoRecall({
        userText: query,
        actorId: "r7sel",
        sessionKey: "sel-bypass-off",
        cfg: cfgOf(),
        pluginDataDir: offDir,
        vectorStore: store as unknown as IMemoryStore,
        embeddingService: okFake.svc,
      });
      const bad = await performAutoRecall({
        userText: query,
        actorId: "r7sel",
        sessionKey: "sel-bypass-enforce",
        cfg: cfgOf({ layerRuler: { mode: "enforce", keepRatio: 0.5, minPerLayer: 1, floor: null } }),
        pluginDataDir: badDir,
        vectorStore: store as unknown as IMemoryStore,
        embeddingService: badFake.svc,
      });
      // 逐位一致：行内容与顺序完全相同（不因异常放宽成全收，也不清空）
      expect(injectedLines(bad?.prependContext)).toEqual(injectedLines(off?.prependContext));
      const entry = readJournal(badDir)[0]!;
      const ruler = entry.ruler as { bypass?: string; floor: number | null };
      expect(ruler.bypass).toBe("ruler-unavailable");
      expect(ruler.floor).toBeNull();
      const sel = entry.selection as { droppedBy: Record<string, number> };
      expect(sel.droppedBy).toEqual({ rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 });
    } finally {
      cleanup(store, dir);
      fs.rmSync(offDir, { recursive: true, force: true });
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("同回合折叠：相邻回合逐字节相同 → 第二回合 0 行，journal 记 fold", async () => {
    const { store, dir } = makeStore(ROWS);
    const dataDir = makeDataDir();
    const fake = fakeEmbedding();
    const ledger = new Map<string, string>();
    const sessionKey = "sel-fold-1";
    const base = {
      userText: query,
      sessionKey,
      cfg: cfgOf({ injection: { foldIdentical: true } }),
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
      embeddingService: fake.svc,
      foldLedger: ledger,
    };
    try {
      // 第 1 回合：正常注入并记指纹
      const t1 = await performLayeredRecall({ ...base, validityNow: new Date("2026-11-02T03:00:00Z") });
      const t1Lines = injectedLines(t1.block);
      expect(t1Lines.length).toBeGreaterThan(0);
      // 第 2 回合：换时点绕开会话复用缓存（不同时点的结果不可复用），行集逐字节相同
      const t2 = await performLayeredRecall({ ...base, validityNow: new Date("2026-11-02T03:00:01Z") });
      expect(injectedLines(t2.block)).toEqual([]);
      const entries = readJournal(dataDir);
      const second = entries[1]!;
      expect((second.fold as { identicalLines: number }).identicalLines).toBe(t1Lines.length);
      const sel = second.selection as { injected: number; kept: number; droppedBy: Record<string, number> };
      expect(sel.injected).toBe(0);
      expect(sel.droppedBy.fold).toBe(t1Lines.length);
      // kept 是「折叠后仍会注入的判定保留数」：fold 也算淘汰档，故 kept+四档=total 恒成立
      expect(sel.kept).toBe(0);
      const dropped =
        sel.droppedBy.rank +
        sel.droppedBy.floor +
        sel.droppedBy.margin +
        sel.droppedBy.dup +
        sel.droppedBy.budget +
        sel.droppedBy.fold;
      expect(sel.kept + dropped).toBe((second.candidates as { total: number }).total);
    } finally {
      cleanup(store, dir);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  /**
   * 空池轮（L1/scene/persona 三路全空，选线段根本没跑）也必须留观测。
   *
   * 生产实测 00:0x：journal 里「无 selection」的轮占大头（coverage 186/1033=18%），
   * zeroInjectionRate 的分母只统计「有池子的轮」，于是空池轮被静默排除在分母外——
   * 指标看起来比真实情况好。修法：空池写零观测 + emptyPool:true，让分母回到真实轮数，
   * 同时用 emptyPool 把「池空」与「池非空但一行没注入」分开，避免把两者混成一个坏数。
   */
  it("空池轮：写 selection 零观测 + emptyPool=true（不静默排除在 zeroInjectionRate 分母外）", async () => {
    const { store, dir } = makeStore([]);
    const dataDir = makeDataDir();
    const fake = fakeEmbedding();
    try {
      const res = await performAutoRecall({
        userText: query,
        actorId: "r7sel",
        sessionKey: "sel-empty-1",
        cfg: cfgOf(),
        pluginDataDir: dataDir,
        vectorStore: store as unknown as IMemoryStore,
        embeddingService: fake.svc,
      });
      expect(injectedLines(res?.prependContext)).toEqual([]);
      const entry = readJournal(dataDir)[0]!;
      // 空池仍要有一条可对账的观测（selection 存在即计入 zeroInjectionRate 分母）
      expect(entry.selection).toMatchObject({
        kept: 0,
        injected: 0,
        poolChars: 0,
        injectedChars: 0,
        emptyPool: true,
        droppedBy: { rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 },
      });
      // ruler 元信息也要在，且如实标 uncalibrated（空池没跑尺子，不能假装是 config 地板）
      expect(entry.ruler).toMatchObject({ mode: "off", floorSource: "uncalibrated", floor: null });
      // 空池不得造出假候选
      expect((entry.candidates as { total: number } | undefined)?.total ?? 0).toBe(0);
    } finally {
      cleanup(store, dir);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
