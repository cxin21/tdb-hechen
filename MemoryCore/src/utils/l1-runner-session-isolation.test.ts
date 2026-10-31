/**
 * task-62 · L1 抽取会话隔离守卫（用户口径 m02362：检索可以跨会话，抽取不能混）
 *
 * 背景：store 的 L0 分组键是 (team,user,agent,session_id,task)（sqlite.ts:5617），
 * 而 L1 取数是 `WHERE session_key = ?`（sqlite.ts:1251-1265）——一个 sessionKey 下
 * 允许出现多个 session_id（key 复用 / 跨端合并 / 历史脏数据）。旧行为把整批所有
 * session_id 的组一起喂 LLM（pipeline-factory.ts 扁平化 → groupMap → 全组循环），
 * 抽取语料被跨会话混在一起。
 *
 * 不变量（本文件即契约）：
 *  1. 一批出现 >1 个 session_id → 只处理最靠前的一组，其余整组延后；
 *  2. 游标只推进到「被延后行的最早 recordedAtMs − 1」→ 下一轮仍能捞到，零丢行；
 *  3. hasMore=true（立即再拉一轮，不等 l1Idle）；
 *  4. 单会话批次行为逐位不变（回归哨兵）；
 *  5. cfg.extraction.sessionScope="profile" 回退旧的多会话同批行为（灰度/排查用）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL1Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";

type Row = { id: string; role: "user" | "assistant"; content: string; timestamp: number; recordedAtMs: number };

type FixtureGroup = { sessionId: string; teamId?: string; userId?: string; agentId?: string; messages: Row[] };

const mkRow = (id: string, sessionId: string, recordedAtMs: number): Row => ({
  id,
  role: "user",
  content: `${id} MARK${sessionId} 夹具消息（含足够语义内容供提取：排查 TDB 记忆管线时发现 L1 抽取会把不同会话的语料混成一批，需要按会话隔离）`,
  timestamp: recordedAtMs,
  recordedAtMs,
});

function makeOpts(dir: string, groups: FixtureGroup[], llmRunner: unknown, logger: Record<string, unknown>) {
  // store stub 自己实现 `recorded_at_ms > cursor` 语义，用于验证跨轮零丢行
  const vectorStore = {
    isDegraded: () => false,
    upsertL1: async () => true,
    queryL0GroupedBySessionId: async (_sessionKey: string, cursor?: number) => {
      const floor = cursor ?? 0;
      return groups
        .map((g) => ({ ...g, messages: g.messages.filter((m) => m.recordedAtMs > floor) }))
        .filter((g) => g.messages.length > 0);
    },
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
    logger,
    llmRunner,
    getInstanceId: () => "inst-test",
  } as unknown as Parameters<typeof createL1Runner>[0];
}

function makeLogger() {
  const infos: string[] = [];
  return {
    infos,
    logger: {
      debug: () => {},
      info: (msg: string) => { infos.push(String(msg)); },
      warn: () => {},
      error: () => {},
    },
  };
}

/** LLM runner：回一条固定记忆，同时把 prompt 里的 MARKxxx 标记收集起来供断言。 */
function makeRunner(seen: string[]) {
  return {
    run: async (p: { prompt: string }) => {
      for (const m of p.prompt.match(/MARK[A-Za-z0-9-]+/g) ?? []) seen.push(m);
      return JSON.stringify([{
        scene_name: "会话隔离情境",
        message_ids: [],
        memories: [{ content: "会话隔离夹具提取事实：L1 抽取必须按 session_id 隔离语料", type: "episodic" }],
      }]);
    },
  };
}

async function readCursor(dir: string, sessionKey: string): Promise<number> {
  const checkpoint = new CheckpointManager(dir, { debug() {}, info() {}, warn() {}, error() {} } as never);
  const cp = await checkpoint.read();
  return (checkpoint.getRunnerState(cp, sessionKey) as { last_l1_cursor?: number }).last_l1_cursor ?? 0;
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
});

describe("task-62 · L1 抽取会话隔离守卫", () => {
  it("同 sessionKey 两个 session_id：只处理最早一组 + 游标封顶 + hasMore + 指标", async () => {
    const dir = mkTmp("l1-iso-split-");
    const groups: FixtureGroup[] = [
      { sessionId: "sessA", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("a1", "sessA", 1_000), mkRow("a2", "sessA", 2_000)] },
      { sessionId: "sessB", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("b1", "sessB", 3_000), mkRow("b2", "sessB", 4_000)] },
    ];
    const { infos, logger } = makeLogger();
    const sendSpy = vi.spyOn(metricProducer, "send").mockImplementation(() => undefined);
    const seen: string[] = [];
    const runner = createL1Runner(makeOpts(dir, groups, makeRunner(seen), logger));

    const res = await runner({ sessionKey: "sk-mixed" });

    // 1) 只有最早一组（sessA）进入 LLM：语料单会话
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m.includes("MARKsessA"))).toBe(true);
    expect(seen.some((m) => m.includes("MARKsessB"))).toBe(false);

    // 2) 游标只到「被延后行最早 recordedAtMs − 1」= 2999 → 下一轮还能捞到 sessB
    expect(await readCursor(dir, "sk-mixed")).toBe(2_999);

    // 3) hasMore 必须为 true（立即续批），processedCount 只算真正处理的行
    expect(res.hasMore).toBe(true);
    expect(res.failed).toBe(false);
    expect(res.processedCount).toBe(2);

    // 4) info 日志含关键读数（session_key / 选中会话 / 组数 / 延后数）
    const isoLog = infos.find((l) => l.includes("session isolation"));
    expect(isoLog).toBeTruthy();
    expect(isoLog).toContain("sk-mixed");
    expect(isoLog).toContain("sessA");
    expect(isoLog).toContain("2 session_id");
    expect(isoLog).toContain("deferred 1 session(s) / 2 L0 row(s)");

    // 5) obs 指标：l1.batch.session_groups = 2
    const metricCall = sendSpy.mock.calls.find((c) => (c[0] as { metric?: string }).metric === "l1.batch.session_groups");
    expect(metricCall).toBeTruthy();
    expect((metricCall![0] as { value?: number }).value).toBe(2);
  });

  it("跨轮零丢行：第二轮把被延后的会话处理完（不重复、不漏）", async () => {
    const dir = mkTmp("l1-iso-rounds-");
    const groups: FixtureGroup[] = [
      { sessionId: "sessA", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("a1", "sessA", 1_000), mkRow("a2", "sessA", 2_000)] },
      { sessionId: "sessB", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("b1", "sessB", 3_000), mkRow("b2", "sessB", 4_000)] },
    ];
    const { logger } = makeLogger();
    vi.spyOn(metricProducer, "send").mockImplementation(() => undefined);
    const seen: string[] = [];
    const runner = createL1Runner(makeOpts(dir, groups, makeRunner(seen), logger));

    await runner({ sessionKey: "sk-rounds" });
    const firstRound = [...seen];
    expect(firstRound.some((m) => m.includes("MARKsessB"))).toBe(false);

    seen.length = 0;
    await runner({ sessionKey: "sk-rounds" });

    // 第二轮只处理 sessB（sessA 已过游标，不重复提取）
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m.includes("MARKsessB"))).toBe(true);
    expect(await readCursor(dir, "sk-rounds")).toBe(4_000);
  });

  it("回归哨兵：单会话批次行为逐位不变（无 isolation 日志、游标推进到本批末、hasMore=false）", async () => {
    const dir = mkTmp("l1-iso-single-");
    const groups: FixtureGroup[] = [
      { sessionId: "sess-only", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("s1", "sess-only", 1_000), mkRow("s2", "sess-only", 2_000)] },
    ];
    const { infos, logger } = makeLogger();
    vi.spyOn(metricProducer, "send").mockImplementation(() => undefined);
    const seen: string[] = [];
    const runner = createL1Runner(makeOpts(dir, groups, makeRunner(seen), logger));

    const res = await runner({ sessionKey: "sk-single" });

    expect(seen.every((m) => m.includes("MARKsess-only"))).toBe(true);
    expect(await readCursor(dir, "sk-single")).toBe(2_000);
    expect(res.hasMore).toBe(false);
    expect(res.processedCount).toBe(2);
    expect(infos.some((l) => l.includes("session isolation"))).toBe(false);
  });

  it("sessionScope='profile' 回退旧行为：多会话同批处理、游标推进到本批末", async () => {
    const dir = mkTmp("l1-iso-profile-");
    const groups: FixtureGroup[] = [
      { sessionId: "sessA", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("a1", "sessA", 1_000), mkRow("a2", "sessA", 2_000)] },
      { sessionId: "sessB", teamId: "t", userId: "u", agentId: "a", messages: [mkRow("b1", "sessB", 3_000), mkRow("b2", "sessB", 4_000)] },
    ];
    const { infos, logger } = makeLogger();
    vi.spyOn(metricProducer, "send").mockImplementation(() => undefined);
    const seen: string[] = [];
    const opts = makeOpts(dir, groups, makeRunner(seen), logger);
    (opts.cfg as unknown as { extraction: Record<string, unknown> }).extraction.sessionScope = "profile";
    const runner = createL1Runner(opts);

    const res = await runner({ sessionKey: "sk-profile" });

    // 两段语料都进 LLM（旧行为）
    expect(seen.some((m) => m.includes("MARKsessA"))).toBe(true);
    expect(seen.some((m) => m.includes("MARKsessB"))).toBe(true);
    expect(await readCursor(dir, "sk-profile")).toBe(4_000);
    expect(res.hasMore).toBe(false);
    expect(res.processedCount).toBe(4);
    expect(infos.some((l) => l.includes("session isolation"))).toBe(false);
  });
});
