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
    score, // cosine 0–1
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

function mockStore(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => hits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

describe("searchHybrid absolute cosine gate", () => {
  it("drops embedding candidates below threshold even if they would rank via RRF", async () => {
    const { vectorStore, embeddingService } = mockStore([
      mk("a", "低相关 0.1", 0.1),
      mk("b", "相关 0.5", 0.5),
      mk("c", "高相关 0.9", 0.9),
    ]);
    const res = await searchHybrid("q", "", 5, 0.3, vectorStore, embeddingService);
    expect(res.lines).toHaveLength(2); // 0.1 filtered out, 宁缺毋滥
    expect(res.lines.join("\n")).not.toContain("低相关 0.1");
  });

  it("keeps only hits above a higher threshold", async () => {
    const { vectorStore, embeddingService } = mockStore([
      mk("b", "相关 0.5", 0.5),
      mk("c", "高相关 0.9", 0.9),
    ]);
    const res = await searchHybrid("q", "", 5, 0.6, vectorStore, embeddingService);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toContain("高相关 0.9");
  });

  it("returns empty when nothing clears threshold (宁缺毋滥)", async () => {
    const { vectorStore, embeddingService } = mockStore([mk("x", "全部过低 0.2", 0.2)]);
    const res = await searchHybrid("q", "", 5, 0.5, vectorStore, embeddingService);
    expect(res.lines).toHaveLength(0);
  });
});