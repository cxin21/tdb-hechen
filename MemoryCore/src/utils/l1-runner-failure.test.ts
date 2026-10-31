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

      // D-6（2026-10-31）：失败位必须**显式**交给 executor。
      // 旧口径只有 processedCount=0/hasMore=false，与「本批没活干」不可区分，
      // 于是 executeL1 照常返回 → pipeline-worker 记 completed → L2 定时器继续推进
      // （生产实测 HTTP 402 配额耗尽：tasksCompleted=4/tasksFailed=0，l1_records 零新增）。
      // runner 自身仍**不抛错**（本文件的不变量保持不变），抛错由 executeL1 依据 failed 做。
      expect(res.failed).toBe(true);
      expect(res.failureDetail).toContain("Weekly usage limit reached");

      // 游标不动：该批消息保留待重试（下次触发 / boot L1_drain 自愈）
      const checkpoint = new CheckpointManager(dir, loggerStub as never);
      const cp = await checkpoint.read();
      const st = checkpoint.getRunnerState(cp, "sess-fail-1") as { last_l1_cursor?: number };
      expect(st.last_l1_cursor ?? 0).toBe(0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("D-7：结构化状态码从 llm-runner 一路透传到 runner 返回值", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d7-structured-"));
    try {
      // 生产形状：message 只有供应商中文文案（没有 "status=402"），状态码由 llm-runner 标注
      const VENDOR_MSG = "当前已达到 Token Plan 用量上限，请升级套餐或等待额度重置 (2067)";
      const annotatedRunner = {
        run: async () => {
          throw Object.assign(new Error(VENDOR_MSG), { statusCode: 402, providerCode: "2067" });
        },
      };
      const runner = createL1Runner(makeRunnerOpts(dir, annotatedRunner));
      const res = await runner({ sessionKey: "sess-fail-1" });

      expect(res.failed).toBe(true);
      // 结构化字段必须随返回值出栈（executeL1 → L1ExtractionFailedError 才能分类为 quota）
      expect(res.failureStatus).toBe(402);
      expect(res.failureProviderCode).toBe("2067");
      // 游标仍然不动（与上面不变量一致）
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
      // D-6：成功批次必须显式 failed=false —— 反向哨兵，防「失败位恒 true」把
      // 成功批次也送进死信（与上面失败用例的 toBe(true) 成对，缺一不可）。
      expect(res.failed).toBe(false);
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

  it("cfg.extraction.dedupTimeoutMs 透传 dedup 阶段（#79，缺省 300_000）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-timeout-"));
    try {
      const timeouts: number[] = [];
      let calls = 0;
      const stageRunner = {
        run: async (p: { prompt: string; timeoutMs?: number }) => {
          timeouts.push(p.timeoutMs ?? -1);
          calls++;
          if (calls === 1) {
            // extraction 主调成功 → 流程推进到 dedup 判重
            return JSON.stringify([{
              scene_name: "去重情境", message_ids: ["m1"],
              memories: [{ content: "dedup 透传验证事实：验证 dedupTimeoutMs 从配置透传到判重 LLM 调用超时参数", type: "episodic" }],
            }]);
          }
          return "[]";
        },
      };
      const mkMsg = (id: string) => ({
        id, role: "user" as const,
        content: id + " dedup 透传夹具消息（排查 TDB 记忆管线时发现 core 静默崩溃，需要验证 dedupTimeoutMs 配置从 yaml 透传到判重 LLM 调用超时参数）",
        timestamp: 1_700_000_000_000, recordedAtMs: 1_700_000_000_000,
      });
      const opts = makeRunnerOpts(dir, stageRunner, [
        {
          sessionId: "sess-dedup-1", teamId: "team-x", userId: "user-x", agentId: "agent-x",
          messages: [mkMsg("m1")],
        },
      ]) as Parameters<typeof createL1Runner>[0];
      // 触发 dedup 判重（#79 整链透传验证的前提）：enableDedup 开 + Tier1 向量候选召回
      // 可用（makeStore/makeEmbedding 形态照抄 l1-dedup.call.test.ts；原 makeRunnerOpts
      // 的 enableDedup:false + 无召回能力 mock → dedup 阶段整体跳过，判重调用不发生）。
      (opts.cfg as unknown as { extraction: Record<string, unknown> }).extraction.enableDedup = true;
      (opts.cfg as unknown as { extraction: Record<string, unknown> }).extraction.dedupTimeoutMs = 123_456;
      (opts.cfg as unknown as { embedding: Record<string, unknown> }).embedding.conflictRecallTopK = 3;
      (opts as unknown as { vectorStore: unknown }).vectorStore = {
        isDegraded: () => false,
        countL1VectorRows: async () => 10,
        countL1: async () => 10,
        isFtsAvailable: () => false,
        searchL1Vector: async () => [
          {
            record_id: "c1", content: "旧记忆内容", type: "episodic", priority: 60,
            scene_name: "去重情境", timestamp_str: "2026-01-01T00:00:00.000Z",
            session_key: "", session_id: "", score: 0.9,
          },
        ],
        upsertL1: async () => true,
        queryL0GroupedBySessionId: async () => [
          {
            sessionId: "sess-dedup-1", teamId: "team-x", userId: "user-x", agentId: "agent-x",
            messages: [mkMsg("m1")],
          },
        ],
      };
      (opts as unknown as { embeddingService: unknown }).embeddingService = {
        embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
      };
      const runner = createL1Runner(opts);
      await runner({ sessionKey: "sess-dedup-1" }).catch(() => undefined);
      // dedup 判重调用的 timeoutMs 必须取自 cfg.extraction.dedupTimeoutMs（现状=300_000 硬编码 → RED）
      expect(timeouts).toContain(123_456);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
