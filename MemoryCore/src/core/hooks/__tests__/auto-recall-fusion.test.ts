import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { RecallFusionConfig } from "../../recall/fusion.js";

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
/** 纯相关度精排（timeProx/significance 全 0）——隔离 fusion 特征效应。 */
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：…logger(7) 后 rest[1..14] → embeddingCallOpts..fusion（#135 R2 末位）。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  fusion?: RecallFusionConfig,
  opts: { excludeInvalidated?: boolean } = {},
) {
  const rest = new Array(15).fill(undefined);
  rest[7] = RELEVANCE_ONLY;
  if (opts.excludeInvalidated !== undefined) rest[9] = opts.excludeInvalidated;
  rest[14] = fusion;
  return searchHybrid("q", "", 5, 0.1, store.vectorStore, store.embeddingService, undefined, ...rest.slice(1));
}

describe("#135 R2 加权融合（searchHybrid 接线）", () => {
  it("rrf 恒等（缺省）：同分并列按池序稳定，时近/有效性零影响（逐位现状）", async () => {
    const s = mockStore([mk("old", "旧值 1250", 0.9, OLD), mk("new", "新值 1300", 0.9, NEW)]);
    const res = await call(s);
    expect(res.lines[0]).toContain("旧值 1250");
  });

  it("weighted + recency：新条目反超旧条目（时近显式特征——V1 实证 0/90 的修复）", async () => {
    const s = mockStore([mk("old", "旧值 1250", 0.9, OLD), mk("new", "新值 1300", 0.9, NEW)]);
    const res = await call(s, { mode: "weighted", dense: 1, bm25: 1, recency: 0.5, validity: 0 });
    expect(res.lines[0]).toContain("新值 1300");
  });

  it("weighted + validity：已失效条目沉底（excludeInvalidated=false 时有效性作为排序特征）", async () => {
    const s = mockStore([
      mk("expired", "失效行", 0.9, OLD, { valid_end: "2026-01-01" }),
      mk("live", "生效行", 0.9, OLD),
    ]);
    const res = await call(s, { mode: "weighted", dense: 1, bm25: 1, recency: 0, validity: 0.5 }, { excludeInvalidated: false });
    expect(res.lines.map((l) => l)).toEqual([expect.stringContaining("生效行"), expect.stringContaining("失效行")]);
  });
});
