/**
 * B（2026-10-26 降调用量）· L0 落库批量化 RED 套件。
 *
 * 修补前缺陷：/v2/conversation/add 逐条 `embedding.embed(msg.content)` = 单请求 N 次
 * provider 调用；多会话并发即撞 Ark coding 端点的突发上限（约 4~5 在飞）→ 429。
 * 断言契约：
 *   1) 一轮 N 条（含批内重复）只打 1 次 embedBatch，且只发去重后的文本；
 *   2) 批内同文本按 F-DUP-1 语义跳过（原实现靠「上一条已落库」被 store 去重挡下）；
 *   3) 窗口内重复（store.hasRecentL0Duplicate 命中）不进 embedding，也不落库。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleV2Route } from "../v2-router.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore, L0Record } from "../../core/store/types.js";

interface FakeEmbedding extends EmbeddingService {
  batchCalls: string[][];
  singleCalls: string[];
}

function makeEmbedding(): FakeEmbedding {
  const batchCalls: string[][] = [];
  const singleCalls: string[] = [];
  const vec = (): Float32Array => Float32Array.from([0.1, 0.2, 0.3]);
  return {
    batchCalls,
    singleCalls,
    embed: async (text: string) => {
      singleCalls.push(text);
      return vec();
    },
    embedBatch: async (texts: string[]) => {
      batchCalls.push([...texts]);
      return texts.map(() => vec());
    },
    getDimensions: () => 3,
    getProviderInfo: () => ({ provider: "fake", model: "fake" }),
    isReady: () => true,
    startWarmup: () => {},
  } as unknown as FakeEmbedding;
}

interface FakeStore {
  rows: L0Record[];
  upsertL0: (record: L0Record, emb?: Float32Array) => Promise<void>;
  hasRecentL0Duplicate: (sk: string, role: string, content: string, windowMs: number) => boolean;
}

function makeStore(): FakeStore {
  const rows: L0Record[] = [];
  return {
    rows,
    upsertL0: async (record: L0Record) => {
      rows.push(record);
    },
    hasRecentL0Duplicate: (sk: string, role: string, content: string, windowMs: number) => {
      const cutoff = Date.now() - windowMs;
      return rows.some(
        (r) =>
          r.sessionKey === sk &&
          r.role === role &&
          r.messageText === content &&
          Date.parse(r.recordedAt) >= cutoff,
      );
    },
  };
}

interface CaptureResult {
  code: number;
  data?: unknown;
}

async function addConversation(
  deps: Record<string, unknown>,
  body: unknown,
): Promise<CaptureResult> {
  const req = {
    headers: { authorization: "Bearer test-key", "x-tdai-service-id": "test" },
  } as unknown as IncomingMessage;
  const res = {} as unknown as ServerResponse;
  let captured: CaptureResult = { code: -1 };
  const handled = await handleV2Route(
    req,
    res,
    "/v2/conversation/add",
    "POST",
    async <T,>() => body as T,
    (_res, _status, payload) => {
      captured = payload as CaptureResult;
    },
    deps as never,
  );
  expect(handled).toBe(true);
  return captured;
}

function makeDeps(store: FakeStore, embedding: EmbeddingService | undefined) {
  return {
    getStore: () => store as unknown as IMemoryStore,
    getEmbedding: () => embedding,
    getStorage: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "service" as const,
    config: { memory: {} },
  };
}

describe("L0 落库批量化（B 降调用量）", () => {
  it("一轮多条只打 1 次 embedBatch，且批内重复只发一次", async () => {
    const store = makeStore();
    const embedding = makeEmbedding();
    const env = await addConversation(makeDeps(store, embedding), {
      session_id: "s-batch-1",
      messages: [
        { role: "user", content: "第一条真实消息" },
        { role: "user", content: "第一条真实消息" }, // 批内重复（旧实现靠已落库去重挡下）
        { role: "assistant", content: "第二条真实回复" },
      ],
    });

    expect(env.code).toBe(0);
    expect(embedding.batchCalls).toEqual([["第一条真实消息", "第二条真实回复"]]);
    expect(embedding.singleCalls).toEqual([]);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.map((r) => r.messageText)).toEqual(["第一条真实消息", "第二条真实回复"]);
  });

  it("窗口内重复（store 去重命中）不进 embedding、不落库", async () => {
    const store = makeStore();
    const embedding = makeEmbedding();
    const deps = makeDeps(store, embedding);
    const body = {
      session_id: "s-batch-2",
      messages: [
        { role: "user", content: "继续" },
        { role: "assistant", content: "收到" },
      ],
    };

    expect((await addConversation(deps, body)).code).toBe(0);
    expect(embedding.batchCalls).toHaveLength(1);

    const env = await addConversation(deps, body);
    expect(env.code).toBe(0);
    // 全部命中 store 去重 → 不再发第二次 embedBatch
    expect(embedding.batchCalls).toHaveLength(1);
    expect(store.rows).toHaveLength(2);
  });

  it("embedding 缺失时照常落库（无向量）", async () => {
    const store = makeStore();
    const env = await addConversation(makeDeps(store, undefined), {
      session_id: "s-batch-3",
      messages: [{ role: "user", content: "没有 embedding 服务" }],
    });
    expect(env.code).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it("embedBatch 抛错时整批按无向量落库（语义与逐条失败一致）", async () => {
    const store = makeStore();
    const embedding = makeEmbedding();
    embedding.embedBatch = async () => {
      throw new Error("HTTP 429 AccountRateLimitExceeded");
    };
    const env = await addConversation(makeDeps(store, embedding), {
      session_id: "s-batch-4",
      messages: [
        { role: "user", content: "降级行一" },
        { role: "assistant", content: "降级行二" },
      ],
    });
    expect(env.code).toBe(0);
    expect(store.rows).toHaveLength(2);
  });
});

describe("L0 记录 id 唯一性（#121 8.1）", () => {
  it("新落库的 L0 id 为 msg- + 32 位 hex（不再截断到 12 位）", async () => {
    const store = makeStore();
    const embedding = makeEmbedding();
    const env = await addConversation(makeDeps(store, embedding), {
      session_id: "s-id-1",
      messages: [
        { role: "user", content: "id 形态一" },
        { role: "assistant", content: "id 形态二" },
      ],
    });

    expect(env.code).toBe(0);
    expect(store.rows).toHaveLength(2);
    // 12 hex 只剩 48 bit 命名空间，批量导入/多会话并发下生日碰撞会静默覆盖同 id 记录；
    // 与上游一致：保留 randomUUID() 的完整 32 hex。
    for (const row of store.rows) {
      expect(row.id).toMatch(/^msg-[0-9a-f]{32}$/);
    }
    expect(new Set(store.rows.map((r) => r.id)).size).toBe(store.rows.length);
  });
});
