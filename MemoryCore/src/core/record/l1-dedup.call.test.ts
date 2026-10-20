import { describe, it, expect } from "vitest";
import { batchDedup } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

/**
 * R2 调用方式契约测试（2026-10-06 审计轮 P0-3；2026-10-14 端点兼容修订）：
 *  - 主调 llmRunner.run 的 reasoningEffort 改为 config-first 透传（原硬编码
 *    "none" 被当前生产端点 glm-5.3-flash MaaS 拒绝——reasoning_effort 参数
 *    直接 400，L1 全败 → 只有 L0）。不支持的端点由 llm-runner 400 剥参降级
 *    兜底，两种端点都兼容。
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

describe("思考开关 config-first 透传（2026-10-14 端点兼容修订）", () => {
  it("未传 params.reasoningEffort 时主调不带该字段（端点默认，缺省 200）", async () => {
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
    expect(captured!.reasoningEffort).toBeUndefined();
  });

  it("params.reasoningEffort 原样透传（支持的端点仍享关思考优化）", async () => {
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
      reasoningEffort: "none",
    });

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
    expect(captured!.timeoutMs).toBe(300_000);
    expect(captured!.systemPrompt).toContain("记忆冲突检测器");
    expect(captured!.prompt).toContain("统一候选记忆池");
  });
});

describe("#79 dedupTimeoutMs 透传（config-first）", () => {
  it("params.dedupTimeoutMs 原样透传（未传时保持 300_000 回归见上）", async () => {
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
      dedupTimeoutMs: 90_000,
    });

    expect(captured!.timeoutMs).toBe(90_000);
  });
});
