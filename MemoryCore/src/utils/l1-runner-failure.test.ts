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

type L0GroupFixture = {
  sessionId: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: number; recordedAtMs: number }>;
};

function makeRunnerOpts(dir: string, llmRunner: unknown, l0Groups?: L0GroupFixture[]) {
  const groups = l0Groups ?? [
    {
      sessionId: "sess-fail-1",
      teamId: "team-x",
      userId: "user-x",
      agentId: "agent-x",
      taskId: undefined,
      messages: [
        { id: "m1", role: "user" as const, content: "F-EV12-1 夹具消息一（含足够语义内容供提取）", timestamp: 1_700_000_000_000, recordedAtMs: 1_700_000_000_000 },
        { id: "m2", role: "assistant" as const, content: "F-EV12-1 夹具消息二（assistant 侧确认）", timestamp: 1_700_000_000_500, recordedAtMs: 1_700_000_000_500 },
      ],
    },
  ];
  const vectorStore = {
    isDegraded: () => false,
    upsertL1: async () => true,
    queryL0GroupedBySessionId: async () => groups,
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

  // ─────────────────────────────────────────────────────────────────────────
  // 毒批自适应拆分（L1-OUTAGE-20261015 定罪修复）
  //
  // 实锤：思考型端点延迟∝prompt 体积（生产实测 13K≈298s 贴线、20K>300s 恒超时）
  // → 大批恒超时 → F-EV12-1 游标不推进（数据安全设计正确）→ 同批 5min 死循环
  // 重试，积压永不排空（2026-10-15 生产 l1_cursor=1792029336718 连续 4+ 小时冻结）。
  //
  // 修复不变量：
  //  - 组提取失败且组内 >1 条 → 对半递归拆分重试；单条仍失败才向上报败；
  //  - 全组成功 → 游标推进（F-EV12-1 语义不变——失败仍不推进，由拆分保证进展）；
  //  - 每次调用的 timeoutMs 缺省 300_000（逐位现状；cfg.extraction.extractionTimeoutMs 可覆盖）。
  // ─────────────────────────────────────────────────────────────────────────
  it("毒批自适应拆分：超时大批对半递归至单条可提取，游标推进", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poison-split-"));
    try {
      const calls: Array<{ timeoutMs?: number; marks: number }> = [];
      const mkMsg = (id: string) => ({
        id, role: "user" as const,
        content: `${id} SPLITMARK 毒批拆分夹具消息（含足够语义内容供提取：排查 TDB 记忆管线时发现 L1 提取断流，需要定位毒批死循环根因并落修复）`,
        timestamp: 1_700_000_000_000, recordedAtMs: 1_700_000_000_000,
      });
      const poisonRunner = {
        run: async (p: { prompt: string; timeoutMs?: number }) => {
          const marks = (p.prompt.match(/SPLITMARK/g) ?? []).length;
          calls.push({ timeoutMs: p.timeoutMs, marks });
          if (marks >= 2) throw new Error("The operation was aborted due to timeout");
          return JSON.stringify([{
            scene_name: "拆分情境", message_ids: ["m1"],
            memories: [{ content: "毒批拆分单条提取事实：定位 L1 毒批死循环并修复游标推进语义", type: "episodic" }],
          }]);
        },
      };
      const runner = createL1Runner(makeRunnerOpts(dir, poisonRunner, [
        {
          sessionId: "sess-split-1", teamId: "team-x", userId: "user-x", agentId: "agent-x",
          messages: [mkMsg("m1"), mkMsg("m2"), mkMsg("m3"), mkMsg("m4")],
        },
      ]));
      const res = await runner({ sessionKey: "sess-split-1" });

      // 拆分树（仅计提取调用，timeoutMs=300_000）：1×4条(败) + 2×2条(败) + 4×1条(成) = 7
      // （另有 4 次 enrich 调用 timeoutMs=30_000，不计入）
      const extractCalls = calls.filter((c) => c.timeoutMs === 300_000);
      expect(extractCalls.length).toBe(7);
      expect(extractCalls.filter((c) => c.marks >= 2).length).toBe(3);
      expect(calls.filter((c) => c.timeoutMs !== 300_000).every((c) => c.marks === 0)).toBe(true);
      // 全组成功 → 游标推进（F-EV12-1 语义保持：失败不推进，拆分保证进展）
      expect(res.processedCount).toBe(4);
      const checkpoint = new CheckpointManager(dir, loggerStub as never);
      const cp = await checkpoint.read();
      const st = checkpoint.getRunnerState(cp, "sess-split-1") as { last_l1_cursor?: number };
      expect(st.last_l1_cursor ?? 0).toBeGreaterThan(0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("cfg.extraction.extractionTimeoutMs 透传（config-first，缺省 300_000）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poison-timeout-"));
    try {
      let capturedTimeout: number | undefined;
      const capturingRunner = {
        run: async (p: { timeoutMs?: number }) => {
          capturedTimeout = p.timeoutMs;
          throw new Error("boom (capture only)");
        },
      };
      const opts = makeRunnerOpts(dir, capturingRunner) as Parameters<typeof createL1Runner>[0];
      (opts.cfg as unknown as { extraction: Record<string, unknown> }).extraction.extractionTimeoutMs = 123_456;
      const runner = createL1Runner(opts);
      await runner({ sessionKey: "sess-fail-1" }).catch(() => undefined);
      expect(capturedTimeout).toBe(123_456);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
