/**
 * task-83（A 段）：L1 抽取会话卫生闸（l1.batch.sessions_ignored 同族）。
 *
 * 生产事实：l0_conversations 里混进探针会话（session_id 形如 probe-* / session-probe-*，
 * 128 行 / 23 会话 / 905,703 字符）。删生产行需用户授权（红线），故先在**抽取侧**挡住：
 * 命中会话的行不进 L1 候选、不计入 batch，但**必须仍推进游标**（否则同批被无限重取）。
 *
 * 本文件用真 createL1Runner + 假 vectorStore/LLMRunner 锁行为：
 *  1) 混合批（真实会话 + 探针会话）→ LLM 只看到真实会话正文；
 *  2) 唯一候选整体被忽略 → 不报错、不调 LLM、正常返回且游标前进；
 *  3) ignoreSessionPatterns=[] → 关闸，行为与 task-83 之前逐位一致；
 *  4) 行级 session_id 不命中、外层 sessionKey 命中 → 同样被忽略（matchedOn=session_key）；
 *  5) 指标 l1.batch.sessions_ignored 与 info 日志都带 session_id + pattern。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { CheckpointManager } from "./checkpoint.js";
import { createL1Runner } from "./pipeline-factory.js";

type L0Msg = { id: string; role: "user" | "assistant"; content: string; timestamp: number; recordedAtMs: number };
type L0GroupFixture = {
  sessionId: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  messages: L0Msg[];
};

const SCENES_JSON =
  '[{"scene_name":"卫生闸","message_ids":["m1"],"memories":[{"content":"探针会话不得被蒸馏成记忆","type":"episodic","priority":60}]}]';

function makeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  const logger = {
    debug: () => {},
    info: (m: string) => { infos.push(m); },
    warn: (m: string) => { warns.push(m); },
    error: () => {},
  };
  return { logger, infos, warns };
}

/** 未知方法一律返回 async () => undefined，避免成功路径被 store 细节干扰。 */
function tolerantStore(base: Record<string, unknown>) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return async () => undefined;
    },
  });
}

function makeHandles(groups: L0GroupFixture[], raw: string | Error = SCENES_JSON) {
  const calls: Array<{ systemPrompt?: string; prompt?: string; taskId?: string }> = [];
  const llmRunner = {
    run: async (args: { systemPrompt?: string; prompt?: string; taskId?: string }) => {
      calls.push(args);
      if (raw instanceof Error) throw raw;
      return raw;
    },
  };
  return { calls, llmRunner };
}

function makeRunnerOpts(
  dir: string,
  groups: L0GroupFixture[],
  llmRunner: unknown,
  logger: unknown,
  extractionExtra: Record<string, unknown> = {},
) {
  const vectorStore = tolerantStore({
    isDegraded: () => false,
    upsertL1: async () => true,
    queryL0GroupedBySessionId: async () => groups,
    // memory-prompt resolver：这两个方法存在即走「查库」分支，必须返回数组而不是 undefined
    getMemoryPromptSettings: async () => [],
    getMemoryPrompts: async () => [],
  });
  const cfg = {
    extraction: {
      enableDedup: false,
      maxMemoriesPerSession: 20,
      durativeEnabled: false,
      ...extractionExtra,
    },
    links: { enabled: false, minSimilarity: 0.3 },
    embedding: { conflictRecallTopK: 0 },
  };
  return {
    pluginDataDir: dir,
    cfg,
    openclawConfig: undefined,
    vectorStore,
    embeddingService: undefined,
    logger,
    llmRunner,
  } as unknown as Parameters<typeof createL1Runner>[0];
}

const REAL_GROUP: L0GroupFixture = {
  sessionId: "sess-real-1",
  teamId: "team-x",
  userId: "user-x",
  agentId: "agent-x",
  messages: [
    { id: "m1", role: "user", content: "REAL-ONLY-TEXT 用户要求 L1 抽取跳过探针会话", timestamp: 1_000, recordedAtMs: 1_000 },
    { id: "m2", role: "assistant", content: "REAL-ONLY-TEXT 助手确认用前缀匹配实现卫生闸", timestamp: 1_500, recordedAtMs: 1_500 },
  ],
};

const PROBE_GROUP: L0GroupFixture = {
  sessionId: "probe-abc",
  teamId: "team-x",
  userId: "user-x",
  agentId: "agent-x",
  messages: [
    { id: "p1", role: "user", content: "PROBE-ONLY-TEXT 探针数据不该进 L1", timestamp: 2_000, recordedAtMs: 2_000 },
  ],
};

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "task83-hygiene-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
});

async function readCursor(dir: string, sessionKey: string): Promise<number> {
  const checkpoint = new CheckpointManager(dir, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never);
  const cp = await checkpoint.read();
  const st = checkpoint.getRunnerState(cp, sessionKey) as { last_l1_cursor?: number };
  return st.last_l1_cursor ?? 0;
}

describe("task-83 · L1 抽取会话卫生闸", () => {
  it("混合批：探针会话的正文不进 LLM，真实会话照常抽", async () => {
    const dir = tmpDir();
    const { logger, infos } = makeLogger();
    const { calls, llmRunner } = makeHandles([REAL_GROUP, PROBE_GROUP]);
    const runner = createL1Runner(makeRunnerOpts(dir, [REAL_GROUP, PROBE_GROUP], llmRunner, logger));
    const res = await runner({ sessionKey: "sess-real-1" });

    // 提取调用只有 1 次（只处理真实会话这一组）；soul 补全（l1-enrich）是成功路径的第二次调用
    const extractCalls = calls.filter((c) => c.taskId === "l1-extraction");
    expect(extractCalls.length).toBe(1);
    const seen = JSON.stringify(extractCalls[0] ?? {});
    expect(seen).toContain("REAL-ONLY-TEXT");
    expect(seen).not.toContain("PROBE-ONLY-TEXT");
    // 全批（含 enrich）都不该出现探针正文
    expect(JSON.stringify(calls)).not.toContain("PROBE-ONLY-TEXT");

    // 探针行不计入 batch
    expect(res.processedCount).toBe(2);
    expect(res.failed).toBe(false);

    // 游标必须越过探针行（2000ms），否则同批被无限重取
    expect(await readCursor(dir, "sess-real-1")).toBe(2_000);

    // 可观测：info 日志带 session_id + pattern
    const hygiene = infos.filter((m) => m.includes("session hygiene gate"));
    expect(hygiene.length).toBe(1);
    expect(hygiene[0]).toContain("session_id=probe-abc");
    expect(hygiene[0]).toContain("pattern=probe-");
  });

  it("唯一候选整体被忽略：不调 LLM、不报错、正常返回且游标前进", async () => {
    const dir = tmpDir();
    const { logger, infos } = makeLogger();
    const { calls, llmRunner } = makeHandles([PROBE_GROUP]);
    const runner = createL1Runner(makeRunnerOpts(dir, [PROBE_GROUP], llmRunner, logger));
    const res = await runner({ sessionKey: "probe-abc" });

    expect(calls.length).toBe(0);
    expect(res.failed).toBe(false);
    expect(res.processedCount).toBe(0);
    expect(res.storedCount).toBe(0);
    expect(res.hasMore).toBe(false);
    expect(await readCursor(dir, "probe-abc")).toBe(2_000);
    expect(infos.some((m) => m.includes("session hygiene gate"))).toBe(true);
  });

  it("ignoreSessionPatterns=[]（关闸）：探针会话照常进 L1，与 task-83 之前逐位一致", async () => {
    const dir = tmpDir();
    const { logger, infos } = makeLogger();
    const { calls, llmRunner } = makeHandles([PROBE_GROUP]);
    const runner = createL1Runner(
      makeRunnerOpts(dir, [PROBE_GROUP], llmRunner, logger, { ignoreSessionPatterns: [] }),
    );
    const res = await runner({ sessionKey: "probe-abc" });

    // 关闸 = 不做任何会话过滤：探针会话的正文原样喂给 LLM（这就是「逐位回到本票之前」）
    const extractCalls = calls.filter((c) => c.taskId === "l1-extraction");
    expect(extractCalls.length).toBe(1);
    expect(JSON.stringify(extractCalls[0] ?? {})).toContain("PROBE-ONLY-TEXT");
    expect(infos.some((m) => m.includes("session hygiene gate"))).toBe(false);
    expect(res.processedCount).toBe(1);
  });

  it("外层 sessionKey 命中（行级 session_id 不命中）→ 同样被忽略", async () => {
    const dir = tmpDir();
    const { logger, infos } = makeLogger();
    const inner: L0GroupFixture = {
      ...REAL_GROUP,
      sessionId: "sess-inner-1",
      messages: [
        { id: "m1", role: "user", content: "PROBE-ONLY-TEXT 走 session_key 命中", timestamp: 1_000, recordedAtMs: 1_000 },
      ],
    };
    const { calls, llmRunner } = makeHandles([inner]);
    const runner = createL1Runner(makeRunnerOpts(dir, [inner], llmRunner, logger));
    const res = await runner({ sessionKey: "session-probe-chatmem" });

    expect(calls.length).toBe(0);
    expect(res.failed).toBe(false);
    expect(res.processedCount).toBe(0);
    const hygiene = infos.filter((m) => m.includes("session hygiene gate"));
    expect(hygiene.length).toBe(1);
    expect(hygiene[0]).toContain("session_key=session-probe-chatmem");
    expect(hygiene[0]).toContain("pattern=session-probe-");
  });

  it("指标 l1.batch.sessions_ignored 随命中上报（值=被忽略会话数）", async () => {
    const dir = tmpDir();
    const { logger } = makeLogger();
    const { llmRunner } = makeHandles([REAL_GROUP, PROBE_GROUP]);
    const spy = vi.spyOn(metricProducer, "send").mockImplementation(() => undefined as never);
    const runner = createL1Runner(makeRunnerOpts(dir, [REAL_GROUP, PROBE_GROUP], llmRunner, logger));
    await runner({ sessionKey: "sess-real-1" });

    const hit = spy.mock.calls
      .map((c) => c[0] as { metric?: string; value?: number; source?: string })
      .filter((e) => e.metric === "l1.batch.sessions_ignored");
    expect(hit.length).toBe(1);
    expect(hit[0].value).toBe(1);
    expect(hit[0].source).toBe("core");
  });

  it("未配置该字段（旧调用方/手工 cfg）→ 回落缺省，探针会话仍被忽略", async () => {
    const dir = tmpDir();
    const { logger } = makeLogger();
    const { calls, llmRunner } = makeHandles([PROBE_GROUP]);
    const runner = createL1Runner(makeRunnerOpts(dir, [PROBE_GROUP], llmRunner, logger));
    const res = await runner({ sessionKey: "probe-abc" });
    expect(calls.length).toBe(0);
    expect(res.processedCount).toBe(0);
  });
});
