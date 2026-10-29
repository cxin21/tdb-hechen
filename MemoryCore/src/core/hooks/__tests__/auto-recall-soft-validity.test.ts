import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

/**
 * #136（W2 双时态属性契约 · 软失效）钩子路接线：
 * recall.validity.mode=soft 时 searchHybrid 的 excludeInvalidated 传 "soft"——
 * 失效行不再硬丢，而是排到 active 之后（"问历史"时旧值仍在池里）；
 * 仅"显式问当下"且存在更新的 active 行时才硬丢。
 */

function mk(id: string, content: string, score: number, occurredAt?: string, extra: Partial<L1SearchResult> = {}): L1SearchResult {
  return { record_id: id, content, type: "episodic", priority: 60, scene_name: "", score,
    timestamp_str: occurredAt ?? "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "", occurred_at: occurredAt, ...extra } as L1SearchResult;
}

function mockStore(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = { isFtsAvailable: () => false, searchL1Vector: async () => hits } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

const NOW = new Date("2026-10-27T00:00:00Z");
const OLD = new Date(NOW.getTime() - 300 * 86400000).toISOString();
const NEW = new Date(NOW.getTime() - 1 * 86400000).toISOString();
const OLD_EXPIRED = new Date(NOW.getTime() - 200 * 86400000).toISOString();
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：…logger(7) 后 rest[1..14] → embeddingCallOpts..fusion（#135 R2 末位）。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  opts: { excludeInvalidated?: boolean | "soft"; userText?: string; validityNow?: Date } = {},
) {
  const rest = new Array(15).fill(undefined);
  rest[7] = RELEVANCE_ONLY;
  if (opts.excludeInvalidated !== undefined) rest[9] = opts.excludeInvalidated;
  rest[10] = opts.validityNow ?? NOW;
  return searchHybrid(opts.userText ?? "q", "", 5, 0.1, store.vectorStore, store.embeddingService, undefined, ...rest.slice(1));
}

describe("#136 W2 软失效（searchHybrid 接线）", () => {
  it("soft：失效行保留并排到 active 之后（temporal-reasoning 需要旧事件仍在池里）", async () => {
    const s = mockStore([
      mk("expired", "旧值：粉丝数 1250", 0.9, OLD_EXPIRED, { valid_end: "2026-04-01" }),
      mk("live", "新值：粉丝数 1300", 0.9, NEW, { valid_start: NEW }),
    ]);
    const res = await call(s, { excludeInvalidated: "soft" });
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toContain("1300");
    expect(res.lines[1]).toContain("1250");
  });

  it("hard（缺省 true）：失效行硬丢（逐位现状不变）", async () => {
    const s = mockStore([
      mk("expired", "旧值：粉丝数 1250", 0.9, OLD_EXPIRED, { valid_end: "2026-04-01" }),
      mk("live", "新值：粉丝数 1300", 0.9, NEW, { valid_start: NEW }),
    ]);
    const res = await call(s);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toContain("1300");
  });

  it("soft + 显式问当下 + 存在更新的 active 行 → 失效行才硬丢", async () => {
    const s = mockStore([
      mk("expired", "旧值：粉丝数 1250", 0.9, OLD_EXPIRED, { valid_end: "2026-04-01" }),
      mk("live", "新值：粉丝数 1300", 0.9, NEW, { valid_start: NEW }),
    ]);
    const res = await call(s, { excludeInvalidated: "soft", userText: "how many followers do I have now?" });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toContain("1300");
  });

  it("soft + 问当下但无更新的 active 行 → 失效行仍保留（不许把唯一答案删掉）", async () => {
    const s = mockStore([
      mk("expired", "旧值：粉丝数 1250", 0.9, OLD_EXPIRED, { valid_end: "2026-04-01" }),
    ]);
    const res = await call(s, { excludeInvalidated: "soft", userText: "what is my follower count now?" });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toContain("1250");
  });

  it("soft：未生效（future valid_start）行恒丢", async () => {
    const future = new Date(NOW.getTime() + 30 * 86400000).toISOString();
    const s = mockStore([
      mk("future", "未来才生效", 0.9, future, { valid_start: future }),
      mk("live", "现在生效", 0.9, NEW, { valid_start: NEW }),
    ]);
    const res = await call(s, { excludeInvalidated: "soft" });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toContain("现在生效");
  });
});
