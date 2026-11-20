/**
 * A3 Round8 CP1：抽取阶段就必须用内容派生 id。
 *
 * 复核发现：writer 里 decision.record_id || contentMemoryId(...) 的顺序让抽取侧塞进来的随机 id
 * 一路短路掉内容幂等键；只要 l1-extractor 还在 record_id: generateMemoryId()，重复内容照样追加新行。
 * 这里钉住端到端行为：同一批两条完全相同的记忆，落库只有一行。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "../l1-extractor.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { LLMRunner } from "../../types.js";

const TEAM = "team-eid";
const USER = "usr-eid";
const AGENT = "agt-eid";
const CONTENT = "他要的是「先跑一遍再说话」，不接受转述的通过结论";

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
        const one = { content: CONTENT, type: "persona", priority: 70, source_message_ids: ["m1"] };
        return JSON.stringify([{ scene_name: "测试情境", message_ids: ["m1"], memories: [one, { ...one }] }]);
      }
      throw new Error("unexpected taskId: " + String(p.taskId));
    },
  } as unknown as LLMRunner;
}

describe("A3 Round8：抽取侧内容派生 id 端到端生效", () => {
  it("同一批两条相同记忆只落一行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-eid-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级：" + initRes.reason);
    try {
      const config = parseConfig({});
      const res = await extractL1Memories({
        messages: [{ id: "m1", role: "user", content: "发布前你必须自己跑过，别拿别人的结论糊我", timestamp: 1_700_000_000_000 }] as never,
        sessionKey: "sess-eid",
        sessionId: "sess-eid",
        teamId: TEAM,
        userId: USER,
        agentId: AGENT,
        baseDir: dir,
        memoryConfig: config,
        options: {
          enableDedup: false,
          llmRunner: makeRunner(),
          vectorStore: store,
          embeddingService: makeEmbedding(),
        },
      } as never);
      expect((res as { records?: unknown[] }).records?.length ?? 0).toBeGreaterThan(0);
      const db = new DatabaseSync(path.join(dir, "vectors.db"), { readOnly: true });
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM l1_records WHERE team_id = ? AND user_id = ? AND agent_id = ? AND content = ?")
        .get(TEAM, USER, AGENT, CONTENT) as { n: number };
      db.close();
      expect(Number(row.n)).toBe(1);
    } finally {
      try {
        store.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 文件句柄回收有延迟，清理失败不影响断言 */
      }
    }
  });
});