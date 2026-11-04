import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

/**
 * D-3（ADR-0025 决定 4）：sensitivity = 注入门，不是排序乘子。
 *
 * 本套件钉四件事：
 *  1. 门在**注入点**真删行（不只是打徽章）——被拦行不出现在 lines 里；
 *  2. 可见性由**候选池归属**推导：无 userId / userId=default 兜底桶 ⇒ 敏感行不注入；
 *     可验证 userId ⇒ private ⇒ 敏感行照常注入（生产今天的形态，逐位不变）；
 *  3. 拦截计数进 gates.sensitivity（audience / scanned / blocked / byReason），
 *     候选池里没有敏感行时整块缺省（不给 journal 塞噪声）；
 *  4. 被拦行不积累 recall_count（看不见的内容不该被"用到"）。
 */

function mk(id: string, content: string, score: number, extra: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "",
    score,
    timestamp_str: "2026-11-01T00:00:00Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: "t",
    task_id: "",
    user_id: "u-1",
    agent_id: "a",
    metadata_json: "",
    occurred_at: "2026-11-01T00:00:00Z",
    // recall_count 只对 observed 行累加（certainty 缺失 = 不计）——本套件要验"被拦行不计"，
    // 故 fixture 必须是 observed，否则用例会因为别的原因得到空数组。
    certainty: "observed",
    ...extra,
  } as L1SearchResult;
}

function mockStore(hits: L1SearchResult[]): {
  vectorStore: IMemoryStore;
  embeddingService: EmbeddingService;
  bumped: string[];
} {
  const bumped: string[] = [];
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => hits,
    bumpRecallCount: (id: string) => {
      bumped.push(id);
      return true;
    },
  } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService, bumped };
}

const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：7 个固定位 + 10 个可选位（isolationFilter 是第 15 个形参）。 */
function call(
  store: ReturnType<typeof mockStore>,
  opts: { maxResults?: number; isolationFilter?: { userId?: string } } = {},
) {
  const tail = [
    undefined, // 8 embeddingCallOpts
    undefined, // 9 rank
    undefined, // 10 embedCacheTtlMs
    undefined, // 11 layered
    undefined, // 12 expansionTerms
    undefined, // 13 exploreSlot
    RELEVANCE_ONLY, // 14 rerankWeights
    opts.isolationFilter, // 15 isolationFilter
    undefined, // 16 excludeInvalidated
    undefined, // 17 validityNow
  ] as unknown[];
  const fn = searchHybrid as unknown as (...args: unknown[]) => ReturnType<typeof searchHybrid>;
  return fn("q", "", opts.maxResults ?? 5, 0.1, store.vectorStore, store.embeddingService, undefined, ...tail);
}

describe("D-3 敏感度注入门（auto-recall 钩子路）", () => {
  it("无 owner 身份（undeclared）：敏感行被真删，普通行照常注入", async () => {
    const s = mockStore([
      mk("plain", "普通记忆一", 0.9),
      mk("sens", "嫂子称呼与家事", 0.8, { sensitivity: "relationship" }),
      mk("plain2", "普通记忆二", 0.7),
    ]);
    const res = await call(s, { maxResults: 3 });
    expect(res.lines).toHaveLength(2);
    expect(res.lines.join("|")).not.toContain("嫂子");
    const gate = res.gates?.sensitivity;
    expect(gate).toBeDefined();
    expect(gate!.audience).toBe("undeclared");
    expect(gate!.scanned).toBe(1);
    expect(gate!.blocked).toBe(1);
    expect(gate!.byReason).toEqual({ undeclared: 1 });
  });

  it("default 共享兜底桶：即便带了 userId 也不当私有，敏感行照拦", async () => {
    const s = mockStore([mk("sens", "医疗记录", 0.9, { sensitivity: "health" })]);
    const res = await call(s, { isolationFilter: { userId: "default" } });
    expect(res.lines).toHaveLength(0);
    expect(res.gates!.sensitivity!.audience).toBe("undeclared");
    expect(res.gates!.sensitivity!.blocked).toBe(1);
  });

  it("可验证 owner（private）：敏感行照常注入，behavior 与 D-3 之前逐位一致", async () => {
    const s = mockStore([
      mk("plain", "普通记忆", 0.9),
      mk("sens", "医疗记录", 0.8, { sensitivity: "health" }),
    ]);
    const res = await call(s, { maxResults: 2, isolationFilter: { userId: "usr-1" } });
    expect(res.lines).toHaveLength(2);
    expect(res.lines.join("|")).toContain("医疗记录");
    const gate = res.gates!.sensitivity!;
    expect(gate.audience).toBe("private");
    expect(gate.scanned).toBe(1);
    expect(gate.blocked).toBe(0);
    expect(gate.byReason).toBeUndefined();
  });

  it("枚举外脏值（unclassified）：private 也拦（标注不可信，fail-closed）", async () => {
    const s = mockStore([mk("dirty", "标注被旁路的行", 0.9, { sensitivity: "secret" })]);
    const res = await call(s, { isolationFilter: { userId: "usr-1" } });
    expect(res.lines).toHaveLength(0);
    expect(res.gates!.sensitivity!.byReason).toEqual({ unclassified: 1 });
  });

  it("池里没有敏感行：不产出 gates.sensitivity（不塞噪声）", async () => {
    const s = mockStore([mk("plain", "普通记忆", 0.9)]);
    const res = await call(s);
    expect(res.lines).toHaveLength(1);
    expect(res.gates?.sensitivity).toBeUndefined();
  });

  it("效期与敏感两门对账：top = 注入 + 效期丢 + 敏感拦", async () => {
    const past = "2026-10-01T00:00:00Z";
    const s = mockStore([
      mk("live", "活行", 0.9),
      mk("gone", "过期行", 0.8, { valid_end: past }),
      mk("sens", "敏感行", 0.7, { sensitivity: "finance" }),
    ]);
    const res = await call(s, { maxResults: 3 });
    const v = res.gates!.validity!;
    const sens = res.gates!.sensitivity!;
    expect(v.injected.active).toBe(1);
    expect(v.injected.dropped).toBe(1);
    expect(sens.blocked).toBe(1);
    expect(res.lines).toHaveLength(1);
  });

  it("被拦行不积累 recall_count（看不见的内容不当被用到）", async () => {
    const s = mockStore([
      mk("plain", "普通记忆", 0.9),
      mk("sens", "敏感记忆", 0.8, { sensitivity: "finance" }),
    ]);
    await call(s);
    expect(s.bumped).toEqual(["plain"]);
  });
});
