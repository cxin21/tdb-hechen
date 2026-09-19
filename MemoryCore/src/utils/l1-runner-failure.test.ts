/**
 * F-EV12-1（REG-REMAINING-006 A-1）golden：L1 提取失败不得推进游标。
 *
 * 实锤背景（2026-09-19 审计）：LLM 供应商配额耗尽时 extractL1Memories 吞错返回
 * success:false（l1-extractor.ts:231），工厂曾无条件 markL1ExtractionComplete
 * → 游标越过该批 L0 → 供应商故障期对话记忆静默丢失（journal 10:17/10:20 实证）。
 *
 * 不变量：
 *  - success=false 批次：checkpoint 游标不动、hasMore/hasFullBacklog=false
 *    （防 pipeline-manager hasFullBacklog 立即重入队的续批风暴）、processedCount=0；
 *  - 重试由下次对话触发 / l1Idle 600s / boot L1_drain 自愈（c35a3e6 机制）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL1Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";

const loggerStub = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeRunnerOpts(dir: string, llmRunner: unknown) {
  const vectorStore = {
    isDegraded: () => false,
    queryL0GroupedBySessionId: async () => [
      {
        sessionId: "sess-fail-1",
        teamId: "team-x",
        userId: "user-x",
        agentId: "agent-x",
        taskId: undefined,
        messages: [
          { id: "m1", role: "user", content: "F-EV12-1 夹具消息一（含足够语义内容供提取）", timestamp: 1_700_000_000_000, recordedAtMs: 1_700_000_000_000 },
          { id: "m2", role: "assistant", content: "F-EV12-1 夹具消息二（assistant 侧确认）", timestamp: 1_700_000_000_500, recordedAtMs: 1_700_000_000_500 },
        ],
      },
    ],
  };
  const cfg = {
    extraction: { enableDedup: false, maxMemoriesPerSession: 20, durativeEnabled: false },
    links: { enabled: false, minSimilarity: 0.3 },
    embedding: { conflictRecallTopK: 0 },
  };
  return {
    pluginDataDir: dir,
    cfg,
    openclawConfig: undefined,
    vectorStore,
    embeddingService: undefined,
    logger: loggerStub,
    llmRunner,
  } as unknown as Parameters<typeof createL1Runner>[0];
}

describe("F-EV12-1 · L1 提取失败不得推进游标", () => {
  it("LLM 失败批次：游标不动 + 续批旗标压平 + processedCount=0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-ev12-1-"));
    try {
      const throwingRunner = {
        run: async () => {
          throw new Error("Weekly usage limit reached (F-EV12-1 test)");
        },
      };
      const runner = createL1Runner(makeRunnerOpts(dir, throwingRunner));
      const res = await runner({ sessionKey: "sess-fail-1" });

      // 诚实口径：本批未被成功消费
      expect(res.processedCount).toBe(0);
      // 压平续批旗标：防 hasFullBacklog 立即重入队风暴
      expect(res.hasMore).toBe(false);
      expect(res.hasFullBacklog).toBe(false);

      // 游标不动：该批消息保留待重试（下次触发 / boot L1_drain 自愈）
      const checkpoint = new CheckpointManager(dir, loggerStub as never);
      const cp = await checkpoint.read();
      const st = checkpoint.getRunnerState(cp, "sess-fail-1") as { last_l1_cursor?: number };
      expect(st.last_l1_cursor ?? 0).toBe(0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
