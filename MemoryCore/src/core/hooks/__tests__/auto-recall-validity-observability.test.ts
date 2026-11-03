import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

/**
 * F7（2026-11-02 复验批次）：效期观测点必须与真删点同层。
 *
 * 旧实现只在**截断前全池**算一次计数，却命名成"这一轮丢了多少"——池里 106 条过期
 * 不等于注入少了 106 行（过期的行本来就可能排在 top 之外）。本套件用边界用例把
 * 三层口径（pool / top / injected）钉死：要有过期的行落在 top 之外，注入没变少时
 * pool.dropped>0 而 injected.dropped=0；要有过期行进 top，injected.dropped 必须
 * 等于"注入行数少了几行"。
 */

function mk(
  id: string,
  content: string,
  score: number,
  occurredAt?: string,
  extra: Partial<L1SearchResult> = {},
): L1SearchResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "",
    score,
    timestamp_str: occurredAt ?? "",
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
    occurred_at: occurredAt,
    ...extra,
  } as L1SearchResult;
}

function mockStore(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = { isFtsAvailable: () => false, searchL1Vector: async () => hits } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

const NOW = new Date("2026-11-02T00:00:00Z");
const LIVE = new Date(NOW.getTime() - 10 * 86400000).toISOString();
const EXPIRED_END = new Date(NOW.getTime() - 2 * 86400000).toISOString();
const FUTURE_START = new Date(NOW.getTime() + 30 * 86400000).toISOString();
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：rest[k] → 形参 6+k（rest[0] 占位不用）。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  opts: { maxResults?: number; excludeInvalidated?: boolean | "soft"; validityNow?: Date } = {},
) {
  const rest = new Array(15).fill(undefined) as unknown[];
  rest[7] = RELEVANCE_ONLY; // → rerankWeights（形参 13）
  if (opts.excludeInvalidated !== undefined) rest[9] = opts.excludeInvalidated; // → 形参 15
  rest[10] = opts.validityNow ?? NOW; // → 形参 16
  // 位置形参按序展开：形参类型无法与 unknown[] 对齐，这里把函数签名放宽到 unknown 参数表，
  // 只为钉「第 N 个位置实参」的调用形状；返回值类型仍沿用 searchHybrid 的真实签名。
  const call = searchHybrid as unknown as (...args: unknown[]) => ReturnType<typeof searchHybrid>;
  return call(
    "q",
    "",
    opts.maxResults ?? 5,
    0.1,
    store.vectorStore,
    store.embeddingService,
    undefined,
    ...rest.slice(1),
  );
}

describe("F7 效期三层观测（pool / top / injected）", () => {
  it("过期行落在 top 之外：pool.dropped=2 但 top/injected 都是 0，注入行数不变", async () => {
    const s = mockStore([
      mk("live1", "活行一", 0.9, LIVE, { valid_start: LIVE }),
      mk("live2", "活行二", 0.8, LIVE, { valid_start: LIVE }),
      mk("live3", "活行三", 0.7, LIVE, { valid_start: LIVE }),
      mk("gone1", "过期行一", 0.4, LIVE, { valid_end: EXPIRED_END }),
      mk("gone2", "过期行二", 0.3, LIVE, { valid_end: EXPIRED_END }),
    ]);
    const res = await call(s, { maxResults: 3 });
    const gate = res.gates?.validity;
    expect(gate).toBeDefined();
    expect(gate!.mode).toBe("hard");
    expect(gate!.pool.dropped).toBe(2); // 池里看见 2 条失效
    expect(gate!.top.dropped).toBe(0); // 进榜的 3 条全活
    expect(gate!.injected.dropped).toBe(0); // 注入没少
    expect(gate!.validEndFiltered).toBe(2); // 兼容字段 = pool 口径
    expect(res.lines).toHaveLength(3);
  });

  it("过期行进 top：injected.dropped 等于注入行数少了几行（与 journal 数字逐位一致）", async () => {
    const s = mockStore([
      mk("live1", "活行一", 0.9, LIVE, { valid_start: LIVE }),
      mk("gone1", "过期行一", 0.8, LIVE, { valid_end: EXPIRED_END }),
      mk("gone2", "过期行二", 0.7, LIVE, { valid_end: EXPIRED_END }),
      mk("live2", "活行二", 0.6, LIVE, { valid_start: LIVE }),
    ]);
    const res = await call(s, { maxResults: 4 });
    const gate = res.gates!.validity!;
    expect(gate.pool.dropped).toBe(2);
    expect(gate.top.dropped).toBe(2);
    expect(gate.injected.dropped).toBe(2);
    // 真删点一致性：top(4) - 注入(2) = injected.dropped(2)
    expect(res.lines).toHaveLength(2);
    expect(res.lines.map((l) => l).join("|")).not.toContain("过期行");
  });

  it("空池也带 validity 门（全零）——区分「没开」与「开了但零召回」", async () => {
    const res = await call(mockStore([]));
    expect(res.lines).toHaveLength(0);
    const gate = res.gates?.validity;
    expect(gate).toBeDefined();
    expect(gate!.pool.dropped).toBe(0);
    expect(gate!.top.dropped).toBe(0);
    expect(gate!.injected.dropped).toBe(0);
  });

  it("soft 档：注入点不二次过滤，过期行不丢；只有 future 行进 pool.dropped", async () => {
    const s = mockStore([
      mk("live1", "活行一", 0.9, LIVE, { valid_start: LIVE }),
      mk("gone1", "过期行一", 0.8, LIVE, { valid_end: EXPIRED_END }),
      mk("fut1", "未来行", 0.7, FUTURE_START, { valid_start: FUTURE_START }),
    ]);
    const res = await call(s, { maxResults: 5, excludeInvalidated: "soft" });
    const gate = res.gates!.validity!;
    expect(gate.mode).toBe("soft");
    expect(gate.injected.dropped).toBe(0); // 过期行在 soft 档不进注入点过滤
    expect(gate.pool.dropped).toBe(1); // 只有 future 行
    expect(res.lines.join("|")).toContain("过期行一");
  });
});
