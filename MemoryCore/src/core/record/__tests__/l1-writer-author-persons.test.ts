/**
 * P2-G 契约：L1 落库必须给记忆挂上「说话人」这个人。
 *
 * 背景（生产实测）：5771 条 l1_records 里只有迁移写入的 563 条带 persons，新记忆一条都没挂上。
 * 原因是挂人线索全部从 metadata 里找（participants / speaker / mentioned），而抽取提示词
 * 不保证吐这三个键（实测新行三键全空 → 挂人恒 0）。但每条记忆本身就带真实身份列
 * （user_id / agent_id）：这条记忆是谁说的，写侧知道，不需要模型再猜一遍。
 *
 * 本用例钉住：线索全空时用记录自带 user_id 作为平台身份兜底，且 key 与 personKeyOf 手算一致；
 * 显式线索优先（不被兜底覆盖）；user_id 是租户占位值时不挂人。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "../l1-extractor.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import { personKeyOf } from "../../person/resolve.js";
import type { MemoryRecord } from "../l1-writer.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { LLMRunner } from "../../types.js";

const TEAM = "team-p2g";
const USER = "usr-p2g-author";
const AGENT = "agt-p2g";
const CONTENT = "用户喜欢先看结论再看证据，最烦一上来就铺背景，这一点请记住";

function makeEmbedding(): EmbeddingService {
  return {
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  } as unknown as EmbeddingService;
}

function makeRunner(): LLMRunner {
  return {
    run: async (p: { taskId?: string }) => {
      if (p.taskId === "l1-extraction") {
        return JSON.stringify([
          {
            scene_name: "测试情境",
            message_ids: ["m1"],
            memories: [{ content: CONTENT, type: "persona", priority: 70, source_message_ids: ["m1"] }],
          },
        ]);
      }
      throw new Error("unexpected taskId: " + String(p.taskId));
    },
  } as unknown as LLMRunner;
}

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-p2g-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    cleanup: () => {
      try {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    },
  };
}

async function runOnce(params: {
  store: IMemoryStore;
  userId: string;
  extraMetadata?: Record<string, unknown>;
}): Promise<MemoryRecord[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-p2g-out-"));
  try {
    const res = await extractL1Memories({
      messages: [{ id: "m1", role: "user", content: CONTENT, timestamp: 1_700_000_000_000 }] as never,
      sessionKey: "sess-p2g",
      teamId: TEAM,
      userId: params.userId,
      agentId: AGENT,
      baseDir: dir,
      memoryConfig: parseConfig({}),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      options: {
        enableDedup: false,
        llmRunner: makeRunner(),
        vectorStore: params.store,
        embeddingService: makeEmbedding(),
      },
      metadata: params.extraMetadata,
    } as never);
    return res.records as unknown as MemoryRecord[];
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
}

describe("P2-G · L1 落库按记录身份挂人", () => {
  it("① 线索全空、记录带真实 user_id → 按平台身份挂上人，key 与 personKeyOf 一致", async () => {
    const { store, cleanup } = makeStore();
    try {
      const records = await runOnce({ store, userId: USER });
      expect(records).toHaveLength(1);
      const persons = (records[0].metadata as { persons?: Array<{ key: string }> } | undefined)?.persons ?? [];
      const expected = personKeyOf({
        teamId: TEAM,
        userId: USER,
        agentId: AGENT,
        platform: "tdai",
        platformId: USER,
      });
      expect(persons.map((p) => p.key)).toEqual([expected]);
      // 顺带钉住：人确实落进了 soul_person（读侧查得到）
      const rows = await Promise.resolve(store.listSoulPersons({ teamId: TEAM, userId: USER, agentId: AGENT }));
      expect((rows ?? []).some((r) => r.personKey === expected)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("② 记录身份是租户占位值时不挂人（不造 DEFAULT_ISOLATION_ID 这个人）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const records = await runOnce({ store, userId: "default" });
      expect(records).toHaveLength(1);
      const persons = (records[0].metadata as { persons?: unknown[] } | undefined)?.persons;
      expect(persons ?? []).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
