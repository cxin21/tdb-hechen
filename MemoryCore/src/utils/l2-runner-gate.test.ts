/**
 * A1 · L2 触发门（task-4，2026-11-02 / docs/research/2026-11-02-memory-layering-extraction-optimization.md §6-A）
 *
 * 背景：L2 每天重写 14 篇场景文档（实测 99 runs/天，p50 74s，p95 18min），
 * 其中绝大多数轮次增量很小。触发门把「每条新 L1 记忆都跑一次 L2」改成
 * 「攒够 minPendingL1 条，或距上次成功抽取超过 minIntervalHours 才跑」。
 *
 * 不变量（本文件即契约）：
 *  1. l2Gate.enabled=false（缺省）→ 与今天逐位一致（有记录就跑）；
 *  2. enabled 且 pending<minPendingL1 且 距上次 < minIntervalHours → 本轮跳过，
 *     返回 {skipped:true, reason:"l2-gate"}，不消费 records、不推进 cursor；
 *  3. pending>=minPendingL1 → 跑；
 *  4. 距上次 >= minIntervalHours（或从未跑过）→ 跑（保底新鲜度）；
 *  5. force 通道（opts.force / ALS 强制上下文）→ 绕门；
 *  6. 抽取成功后写 checkpoint l2_last_extraction_time=now（既有键、ISO 格式）；
 *  6b. 跳过时绝不重写 l2_last_extraction_time（否则时间门永远不放开）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL2Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import { withL2Force } from "../core/scene/l2-force-context.js";

const SCOPE = "team:default|user:default|agent:default";
const HOUR = 3_600_000;

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
});

/** 组数据目录：buildProfileIsolationScope(record) 恒为 team|user|agent 三段 scope。 */
function groupDataDir(pluginDataDir: string): string {
  return path.join(pluginDataDir, "profiles", encodeURIComponent(SCOPE));
}

/** 预置一个已有场景块 + 索引 → extract() 的 emptyExtraction 为 false（走成功臂）。 */
async function seedSceneBlock(dir: string): Promise<void> {
  const blocksDir = path.join(dir, "scene_blocks");
  fs.mkdirSync(blocksDir, { recursive: true });
  fs.writeFileSync(
    path.join(blocksDir, "Existing.md"),
    [
      "-----META-START-----",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "summary: existing scene block for L2 gate fixtures",
      "heat: 1",
      "-----META-END-----",
      "",
      "## 核心叙事",
      "",
      "既有场景正文。",
      "",
    ].join("\n"),
    "utf-8",
  );
  await syncSceneIndex(dir);
}

function makeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    record_id: `r${i + 1}`,
    content: `夹具记忆 ${i + 1}：L2 触发门需要按增量条数决策，不得消费未达阈值的批次`,
    type: "episodic",
    priority: 1,
    scene_name: "",
    created_time: "2026-11-01T00:00:00.000Z",
    updated_time: `2026-11-01T00:00:0${i}.000Z`,
    version: 0,
    session_key: "sk-1",
    session_id: "sess-1",
    task_id: "",
    team_id: "",
    user_id: "",
    agent_id: "",
    valid_end: "",
    metadata_json: "{}",
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
  }));
}

type GateCfg = { enabled: boolean; minPendingL1: number; minIntervalHours: number };

function makeOpts(params: {
  pluginDataDir: string;
  rows: ReturnType<typeof makeRows>;
  gate: GateCfg;
  calls: string[];
  force?: boolean;
  l2Form?: { structured?: boolean; maxBlockBytes?: number };
}) {
  const { pluginDataDir, rows, gate, calls, force, l2Form } = params;
  const vectorStore = {
    isDegraded: () => false,
    queryL1Records: async (_filter: unknown) => rows,
  };
  const llmRunner = {
    run: async (p: { prompt?: string }) => {
      calls.push(String(p.prompt ?? "").slice(0, 0) || "run");
      return "";
    },
  };
  const cfg = {
    persona: {
      model: "test-model",
      promptMode: "chat",
      maxScenes: 15,
      sceneBackupCount: 10,
      l2Gate: gate,
      l2Form: l2Form ?? { structured: false, maxBlockBytes: 4096 },
    },
    extraction: { extractionTimeoutMs: 1000, sceneBatchMaxChars: 100_000, scenePoisonSplit: false },
    sceneGovernance: { enabled: false },
  };
  return {
    pluginDataDir,
    cfg,
    vectorStore,
    logger: noopLogger,
    llmRunner,
    ...(force === undefined ? {} : { force }),
  } as unknown as Parameters<typeof createL2Runner>[0];
}

async function readL2LastTime(pluginDataDir: string): Promise<string> {
  const cp = await new CheckpointManager(pluginDataDir, noopLogger as never).read();
  return cp.pipeline_states["sk-1"]?.l2_last_extraction_time ?? "";
}

async function seedLastTime(pluginDataDir: string, iso: string): Promise<void> {
  const cp = new CheckpointManager(pluginDataDir, noopLogger as never);
  await cp.mergePipelineStates({ "sk-1": { l2_last_extraction_time: iso } as never });
}

describe("A1 · L2 触发门", () => {
  it("未达条数阈值且距上次很近 → 跳过，且不消费 records、不重写 last_extraction_time", async () => {
    const dir = mkTmp("l2-gate-skip-");
    await seedSceneBlock(groupDataDir(dir));
    const recent = new Date().toISOString();
    await seedLastTime(dir, recent);
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(3),
        gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
        calls,
      }),
    );

    const res = (await runner("sk-1")) as { skipped?: boolean; reason?: string; latestCursor?: string } | undefined;

    expect(res?.skipped).toBe(true);
    expect(res?.reason).toBe("l2-gate");
    expect(res?.latestCursor).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(await readL2LastTime(dir)).toBe(recent);
  });

  it("达到条数阈值 → 跑（同一条数下门关闭与开启行为一致）", async () => {
    const dir = mkTmp("l2-gate-count-");
    await seedSceneBlock(groupDataDir(dir));
    await seedLastTime(dir, new Date().toISOString());
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(30),
        gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
        calls,
      }),
    );

    const res = await runner("sk-1");

    expect(calls.length).toBe(1);
    expect(res?.skipped).toBeUndefined();
    expect(res?.latestCursor).toBeTruthy();
  });

  it("距上次抽取超过 minIntervalHours → 即使条数不足也跑", async () => {
    const dir = mkTmp("l2-gate-time-");
    await seedSceneBlock(groupDataDir(dir));
    await seedLastTime(dir, new Date(Date.now() - 7 * HOUR).toISOString());
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(1),
        gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
        calls,
      }),
    );

    const res = await runner("sk-1");

    expect(calls.length).toBe(1);
    expect(res?.latestCursor).toBeTruthy();
  });

  it("enabled=false（缺省）→ 与今天一致：再小的批次也跑", async () => {
    const dir = mkTmp("l2-gate-off-");
    await seedSceneBlock(groupDataDir(dir));
    const recent = new Date().toISOString();
    await seedLastTime(dir, recent);
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(1),
        gate: { enabled: false, minPendingL1: 30, minIntervalHours: 6 },
        calls,
      }),
    );

    const res = await runner("sk-1");

    expect(calls.length).toBe(1);
    expect(res?.latestCursor).toBeTruthy();
  });

  it("force 通道绕过门（opts.force）", async () => {
    const dir = mkTmp("l2-gate-force-");
    await seedSceneBlock(groupDataDir(dir));
    await seedLastTime(dir, new Date().toISOString());
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(1),
        gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
        calls,
        force: true,
      }),
    );

    const res = await runner("sk-1");

    expect(calls.length).toBe(1);
    expect(res?.skipped).toBeUndefined();
  });

  it("force 通道绕过门（ALS 强制上下文，服务端手动触发用）", async () => {
    const dir = mkTmp("l2-gate-als-");
    await seedSceneBlock(groupDataDir(dir));
    await seedLastTime(dir, new Date().toISOString());
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(1),
        gate: { enabled: true, minPendingL1: 30, minIntervalHours: 6 },
        calls,
      }),
    );

    const res = await withL2Force(() => runner("sk-1"));

    expect(calls.length).toBe(1);
    expect(res?.skipped).toBeUndefined();
  });

  it("抽取成功后写 l2_last_extraction_time = now（ISO）", async () => {
    const dir = mkTmp("l2-gate-stamp-");
    await seedSceneBlock(groupDataDir(dir));
    const old = new Date(Date.now() - 7 * HOUR).toISOString();
    await seedLastTime(dir, old);
    const calls: string[] = [];
    const before = Date.now();
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(2),
        gate: { enabled: true, minPendingL1: 1, minIntervalHours: 6 },
        calls,
      }),
    );

    await runner("sk-1");

    const stamped = await readL2LastTime(dir);
    expect(stamped).not.toBe(old);
    expect(stamped).not.toBe("");
    const ts = Date.parse(stamped);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
  });

  it("B3 接线：l2Form.structured=true 时 createL2Runner 写出的场景块为结构化形态", async () => {
    const dir = mkTmp("l2-form-wire-");
    await seedSceneBlock(groupDataDir(dir));
    const calls: string[] = [];
    const runner = createL2Runner(
      makeOpts({
        pluginDataDir: dir,
        rows: makeRows(1),
        gate: { enabled: false, minPendingL1: 30, minIntervalHours: 6 },
        calls,
        l2Form: { structured: true, maxBlockBytes: 4096 },
      }),
    );

    await runner("sk-1");

    const raw = fs.readFileSync(path.join(groupDataDir(dir), "scene_blocks", "Existing.md"), "utf-8");
    expect(raw).toContain("## 摘要");
    expect(raw).toContain("## 主张");
    expect(raw).toContain("## 事件流");
    // META 四字段仍在 ⇒ 14 行索引/summary 召回读得回
    expect(raw).toContain("-----META-START-----");
    expect(raw).toContain("summary: existing scene block for L2 gate fixtures");
    expect(Buffer.byteLength(raw, "utf-8")).toBeLessThanOrEqual(4096);
  });
});
