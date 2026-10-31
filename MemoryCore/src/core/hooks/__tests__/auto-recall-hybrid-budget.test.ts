/**
 * task-100（预算内降级，2026-11-01）· searchHybrid 向量腿预算 · RED 套件。
 *
 * 背景（task-93 真日志 n=144）：/v3/recall 端到端 P50=4260ms、P90=17348ms，l1 占 99.5%，
 * 时间全花在远端 query embedding（单次 282ms–19.3s）。旧行为只有「等到超时拿全量」或
 * 「504 拿空」两种结局。本套件锁的是新契约：
 *   1. 无预算（l1Budget=undefined）⇒ 逐位旧行为（等向量腿，timing 无 degraded 字段）；
 *   2. 预算内跑完 ⇒ 不降级，向量腿结果照常参与融合；
 *   3. 向量腿超预算 ⇒ 立即返回**已算完的 FTS 腿**结果（lines 非空！），timing 标
 *      degraded='fts' / budgetHit=true；
 *   4. 进 L1 时预算已耗尽 ⇒ 不等待向量腿，同样降级；
 *   5. fallback='none' ⇒ 只观测不改变行为（不降级）；
 *   6. 降级轮 fact 通道随向量腿一起丢弃（factHits 为 0）。
 */
import { describe, expect, it, vi } from "vitest";
import { searchHybrid, type RecallL1Budget } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const KW = "L1BUDGET";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ftsRow = (id: string, over: Partial<L1FtsResult> = {}): L1FtsResult => ({
  record_id: id,
  content: `${KW} 记忆条目 ${id}`,
  type: "episodic",
  priority: 0,
  scene_name: "",
  score: 0.5,
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
});

/** 向量腿耗时可控的假 store（只实现 searchHybrid 真会走的方法）。 */
function slowStore(opts: {
  vectorDelayMs: number;
  vectorRows?: L1FtsResult[];
  factDelayMs?: number;
  ftsRows?: L1FtsResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false, l1FactVec: true }),
    searchL1Fts: async () => opts.ftsRows ?? [ftsRow("fts-1")],
    searchL1Vector: async () => {
      await sleep(opts.vectorDelayMs);
      return opts.vectorRows ?? [ftsRow("vec-1", { content: `${KW} 向量条目`, score: 0.9 })];
    },
    searchL1FactVector: async () => {
      await sleep(opts.factDelayMs ?? 0);
      return [ftsRow("fact-1", { content: `${KW} 事实行`, score: 0.7 })];
    },
    getNeighbors: async () => [],
    getL1ByIds: async () => [],
    getL1ByIdsWithArchive: async () => [],
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

/** 只提供 embed()（真 searchHybrid 只调它）。 */
function fakeEmbedding(delayMs = 0, dims = 4): EmbeddingService {
  return {
    embed: async () => {
      if (delayMs > 0) await sleep(delayMs);
      return new Float32Array(dims).fill(0.1);
    },
  } as unknown as EmbeddingService;
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function run(opts: {
  store: IMemoryStore;
  budget?: RecallL1Budget;
  factChannel?: { enabled: boolean };
  logger?: typeof silentLogger;
}) {
  const t0 = performance.now();
  const res = await searchHybrid(
    KW,
    "",
    3,
    0,
    opts.store,
    fakeEmbedding(),
    (opts.logger ?? silentLogger) as never,
    undefined,
    undefined,
    0,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    true,
    new Date(),
    undefined,
    false,
    undefined,
    undefined,
    opts.factChannel as never,
    undefined,
    undefined,
    opts.budget,
  );
  return { res, elapsed: performance.now() - t0 };
}

describe("task-100 searchHybrid 向量腿预算", () => {
  it("① 无预算 ⇒ 逐位旧行为：等向量腿跑完，timing 不带 degraded", async () => {
    const { res, elapsed } = await run({ store: slowStore({ vectorDelayMs: 120 }) });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(res.timing.degraded).toBeUndefined();
    expect(res.timing.budgetHit).toBeUndefined();
    expect(res.timing.embeddingHits).toBe(1);
    expect(res.lines.length).toBe(2);
  });

  it("② 预算充裕 ⇒ 不降级，向量腿与 FTS 腿都进融合池", async () => {
    const { res } = await run({
      store: slowStore({ vectorDelayMs: 30 }),
      budget: { deadlineAt: performance.now() + 5000, fallback: "fts" },
    });
    expect(res.timing.degraded).toBeUndefined();
    expect(res.timing.embeddingHits).toBe(1);
    expect(res.lines.length).toBe(2);
  });

  it("③ 向量腿超预算 ⇒ 立即用 FTS 腿返回，degraded='fts' 且 lines 非空（不许拿空块换延迟）", async () => {
    const { res, elapsed } = await run({
      store: slowStore({ vectorDelayMs: 1500 }),
      budget: { deadlineAt: performance.now() + 60, fallback: "fts" },
    });
    expect(elapsed).toBeLessThan(600);
    expect(res.timing.degraded).toBe("fts");
    expect(res.timing.budgetHit).toBe(true);
    expect(res.timing.embeddingHits).toBe(0);
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.lines.join("\n")).toContain("fts-1");
  });

  it("④ 进 L1 时预算已耗尽 ⇒ 不等待向量腿，同样降级", async () => {
    const { res, elapsed } = await run({
      store: slowStore({ vectorDelayMs: 1500 }),
      budget: { deadlineAt: performance.now() - 5, fallback: "fts" },
    });
    expect(elapsed).toBeLessThan(400);
    expect(res.timing.degraded).toBe("fts");
    expect(res.lines.length).toBeGreaterThan(0);
  });

  it("⑤ fallback='none' ⇒ 只观测不改变行为（不降级，等向量腿）", async () => {
    const { res, elapsed } = await run({
      store: slowStore({ vectorDelayMs: 120 }),
      budget: { deadlineAt: performance.now() + 5, fallback: "none" },
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(res.timing.degraded).toBeUndefined();
  });

  it("⑥ 降级轮把 fact 通道一起丢弃（factHits=0，不残留半条腿）", async () => {
    const { res } = await run({
      store: slowStore({ vectorDelayMs: 1500, factDelayMs: 10 }),
      budget: { deadlineAt: performance.now() + 60, fallback: "fts" },
      factChannel: { enabled: true },
    });
    expect(res.timing.degraded).toBe("fts");
    expect(res.timing.factHits ?? 0).toBe(0);
    expect(res.lines.join("\n")).not.toContain("fact-1");
  });

  it("⑦ 降级时打一行可检索的 warn（[hybrid-budget] + fallback=fts）", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await run({
      store: slowStore({ vectorDelayMs: 1500 }),
      budget: { deadlineAt: performance.now() + 60, fallback: "fts" },
      logger,
    });
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("[hybrid-budget]");
    expect(warned).toContain("fallback=fts");
  });
});