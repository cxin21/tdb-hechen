import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

function mk(id: string, content: string, score: number): L1SearchResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 60,
    scene_name: "",
    score,
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
  };
}

/**
 * #135 R1（candidateK 配置化）：捕获上游检索 limit 实参——
 * 缺省 = maxResults*3（逐位现状）；candidateKOverride 显式传入 = 配置解锁。
 */
function capturingStore(hits: L1SearchResult[]): {
  vectorStore: IMemoryStore;
  embeddingService: EmbeddingService;
  seen: number[];
} {
  const seen: number[] = [];
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async (_q: unknown, limit: number) => {
      seen.push(limit);
      return hits;
    },
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService, seen };
}

const HITS = (n: number) => Array.from({ length: n }, (_, i) => mk("id" + i, "候选 " + i, 0.9 - i * 0.001));

/** 位置形参填充：最后一位 = candidateKOverride（#135 R1 追加在形参表尾部）。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  maxResults: number,
  candidateKOverride?: number,
) {
  const rest = new Array(14).fill(undefined);
  if (candidateKOverride !== undefined) rest[13] = candidateKOverride;
  return searchHybrid("q", "", maxResults, 0.3, store.vectorStore, store.embeddingService, ...rest);
}

describe("#135 R1 candidateK 配置化（hybrid 候选池上游上限）", () => {
  it("缺省：limit = maxResults*3 = 15（逐位现状）", async () => {
    const s = capturingStore(HITS(20));
    await call(s, 5);
    expect(s.seen).toEqual([15]);
  });

  it("candidateKOverride=32：limit = 32（pool32 解锁——T1 实测 kept 仅 +0.16 的锁点）", async () => {
    const s = capturingStore(HITS(40));
    await call(s, 5, 32);
    expect(s.seen).toEqual([32]);
  });

  it("candidateKOverride=undefined：回落 maxResults*3 = 30", async () => {
    const s = capturingStore(HITS(20));
    await call(s, 10, undefined);
    expect(s.seen).toEqual([30]);
  });
});
