import { describe, it, expect } from "vitest";
import { batchDedup } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

/**
 * R2 调用方式契约测试（2026-10-06 审计轮 P0-3）：
 *  - 主调 llmRunner.run 必须带 reasoningEffort="none"（关深度思考——R2 生产
 *    10/138 全超时的根因是思考烧 180s 预算；R1 v21 十组实测关思考质量持平
 *    时延 -32%）
 *  - taskId / timeoutMs / langfuse trace 参数行为不变（回归）
 */

interface Captured {
  prompt?: string;
  systemPrompt?: string;
  taskId?: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  traceName?: string;
}

const mem = (record_id: string) => ({
  record_id,
  content: `新记忆-${record_id}`,
  type: "episodic" as const,
  priority: 70,
  source_message_ids: [] as string[],
  metadata: {},
  scene_name: "测试情境",
});

function makeStore(): IMemoryStore {
  return {
    countL1VectorRows: async () => 10,
    countL1: async () => 10,
    isFtsAvailable: () => false,
    searchL1Vector: async () => [
      {
        record_id: "c1",
        content: "旧记忆内容",
        type: "episodic",
        priority: 60,
        scene_name: "测试情境",
        timestamp_str: "2026-01-01T00:00:00.000Z",
        session_key: "",
        session_id: "",
        score: 0.9,
      },
    ],
  } as unknown as IMemoryStore;
}

function makeEmbedding(): EmbeddingService {
  return {
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  } as unknown as EmbeddingService;
}

describe("R2 关思考接线", () => {
  it("主调 llmRunner.run 收到 reasoningEffort=none（P0-3）", async () => {
    let captured: Captured | null = null;
    const llmRunner = {
      run: async (p: Captured) => {
        captured = p;
        return "[]";
      },
    } as unknown as LLMRunner;

    await batchDedup({
      memories: [mem("n1")],
      config: {},
      vectorStore: makeStore(),
      embeddingService: makeEmbedding(),
      llmRunner,
    });

    expect(captured).not.toBeNull();
    expect(captured!.reasoningEffort).toBe("none");
  });

  it("taskId / timeoutMs 保持既有语义（回归）", async () => {
    let captured: Captured | null = null;
    const llmRunner = {
      run: async (p: Captured) => {
        captured = p;
        return "[]";
      },
    } as unknown as LLMRunner;

    await batchDedup({
      memories: [mem("n1")],
      config: {},
      vectorStore: makeStore(),
      embeddingService: makeEmbedding(),
      llmRunner,
    });

    expect(captured!.taskId).toBe("l1-conflict-detection");
    expect(captured!.timeoutMs).toBe(180_000);
    expect(captured!.systemPrompt).toContain("记忆冲突检测器");
    expect(captured!.prompt).toContain("统一候选记忆池");
  });
});
