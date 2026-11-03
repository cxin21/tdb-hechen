/**
 * B2 写侧边界补测（l1-writer.ts W2 取代路径 :425-464）。
 *
 * 已有覆盖（不重复，见 l1-writer.write-policy.test.ts）：
 *  - :138 缺省关 → 归档、不失效（逐位现状）
 *  - :163 多值内容 → 不失效不归档且保留 target_ids
 *  - :249 store 无 invalidateL1 → 回落归档（零删除底线）
 *
 * 本套件只补真缺的边界与**日志真实性**：
 *  - 多值内容（keptAlive）与空目标不得误报 "store lacks invalidateL1"（该 else 分支
 *    同时罩着三种情形：多值、空 target_ids、方法缺失——对前两者是假警报，会把
 *    "我这条路本来就没打算失效"读成"后端缺能力"，正是可观测性排查的噪声源）；
 *  - invalidateL1 抛错 → 回落归档、零硬删、loud warn 带错误原文；
 *  - 部分失败（返回 false）→ 成功者保留、失败者归档、零硬删（不因半途失败硬删证据）。
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { writeMemory } from "./l1-writer.js";
import type { DedupDecision, ExtractedMemory } from "./l1-writer.js";
import type { WritePolicy } from "./write-policy.js";

const policy = (over: Partial<WritePolicy> = {}): WritePolicy => ({
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: true },
  ...over,
});

const MULTI = "我在考虑换一家生鲜配送服务"; // supersessionEligibleForContent=false（多值/模态）
const SINGLE = "我的 Instagram 粉丝数涨到 1300";

const memory = (content: string): ExtractedMemory => ({
  content,
  type: "work_fact",
  priority: 60,
  source_message_ids: [],
  metadata: {},
  scene_name: "bench",
});

const decision = (over: Partial<DedupDecision> = {}): DedupDecision => ({
  record_id: "new-1",
  action: "update",
  target_ids: [],
  ...over,
});

function fakeStore(opts: { invalidate?: ((id: string, validEnd: string) => Promise<boolean> | boolean) | null } = {}) {
  const calls = {
    invalidated: [] as Array<{ id: string; validEnd: string }>,
    archived: [] as string[],
    hardDeleted: [] as string[],
  };
  const store: Record<string, unknown> = {
    queryL1Records: async () => [],
    upsertL1: async () => true,
    archiveL1: async (id: string) => {
      calls.archived.push(id);
      return true;
    },
    addLink: () => true,
    deleteL1Batch: async (ids: string[]) => {
      calls.hardDeleted.push(...ids);
      return true;
    },
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
      l1FactVec: false,
    }),
  };
  if (opts.invalidate !== null) {
    const impl =
      opts.invalidate ??
      (async (id: string, validEnd: string) => {
        calls.invalidated.push({ id, validEnd });
        return true;
      });
    store.invalidateL1 = async (id: string, validEnd: string) => {
      const ok = await impl(id, validEnd);
      if (ok) calls.invalidated.push({ id, validEnd });
      return ok;
    };
  }
  const embedding = { embed: async () => new Float32Array([1, 0, 0]), getDimensions: () => 3, isReady: () => true };
  return { store: store as never, embedding: embedding as never, calls };
}

let baseDir: string;
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-w2-"));
});
afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

async function runWrite(args: {
  content?: string;
  decision?: DedupDecision;
  invalidate?: ((id: string, validEnd: string) => Promise<boolean> | boolean) | null;
  warns: string[];
  debugs: string[];
}) {
  const { store, embedding, calls } = fakeStore({ invalidate: args.invalidate });
  const record = await writeMemory({
    memory: memory(args.content ?? SINGLE),
    decision: args.decision ?? decision(),
    baseDir,
    sessionKey: "s::k",
    vectorStore: store,
    embeddingService: embedding,
    storage: undefined,
    writePolicy: policy(),
    logger: {
      warn: (m: string) => args.warns.push(m),
      debug: (m: string) => args.debugs.push(m),
      info: () => {},
    } as never,
  });
  return { record, calls };
}

const lacksWarn = (warns: string[]) => warns.filter((m) => m.includes("store lacks invalidateL1"));

describe("B2 W2 取代路径边界（l1-writer.ts:425-464）", () => {
  it("多值内容：不失效不归档，且**不得**误报 store lacks invalidateL1（假警报）", async () => {
    const warns: string[] = [];
    const debugs: string[] = [];
    const d = decision({ target_ids: ["old-1"] });
    const { calls } = await runWrite({ content: MULTI, decision: d, warns, debugs });
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual([]);
    expect(d.target_ids).toEqual(["old-1"]);
    // 必须真的走到多值分支（否则"没告警"可能是根本没进这条路径）
    expect(debugs.some((m) => m.includes("[W2-cardinality]"))).toBe(true);
    expect(lacksWarn(warns)).toEqual([]);
  });

  it("空 target_ids：零失效零归档，且不误报能力缺失", async () => {
    const warns: string[] = [];
    const debugs: string[] = [];
    const { calls } = await runWrite({ decision: decision({ target_ids: [] }), warns, debugs });
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual([]);
    expect(lacksWarn(warns)).toEqual([]);
  });

  it("store 缺 invalidateL1：回落归档 + loud warn（文本可判读）", async () => {
    const warns: string[] = [];
    const { calls } = await runWrite({
      decision: decision({ target_ids: ["old-1"] }),
      invalidate: null,
      warns,
      debugs: [],
    });
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual(["old-1"]);
    expect(lacksWarn(warns)).toHaveLength(1);
    expect(lacksWarn(warns)[0]).toContain("no hard delete");
  });

  it("invalidateL1 抛错：回落归档、零硬删、warn 带错误原文", async () => {
    const warns: string[] = [];
    const { calls } = await runWrite({
      decision: decision({ target_ids: ["old-1", "old-2"] }),
      invalidate: async () => {
        throw new Error("sqlite busy: database is locked");
      },
      warns,
      debugs: [],
    });
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual(["old-1", "old-2"]);
    expect(calls.hardDeleted).toEqual([]);
    const failed = warns.filter((m) => m.includes("invalidateL1 failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("database is locked");
  });

  it("部分失败（返回 false）：成功者不被归档、失败者归档、零硬删", async () => {
    const warns: string[] = [];
    const { calls } = await runWrite({
      decision: decision({ target_ids: ["old-1", "old-2"] }),
      invalidate: async (id: string) => id === "old-1",
      warns,
      debugs: [],
    });
    expect(calls.invalidated.map((c) => c.id)).toEqual(["old-1"]);
    expect(calls.archived).toEqual(["old-2"]);
    expect(calls.hardDeleted).toEqual([]);
    expect(warns.filter((m) => m.includes("invalidateL1 failed"))).toEqual([]);
  });
});
