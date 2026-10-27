import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, DedupDecision } from "./l1-writer.js";
import type { WritePolicy } from "./write-policy.js";

/**
 * #134 生产写面（W1/W2）行为测试——在 writeMemory 的公开 seam 上验证：
 *  - 缺省全关：embedding 输入=内容原文；update/merge 旧行归档（逐位现状）
 *  - W1 开：embedding 输入=内容 + " | " + metadata.subject（事实键双写）
 *  - W2 开：update/merge 旧行 invalidateL1（valid_end 只标记），不归档；新行补 valid_start
 *  - W2 开但后端无 invalidateL1：回退归档（零删除底线）
 */

const policy = (over: Partial<WritePolicy> = {}): WritePolicy => ({
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: false },
  ...over,
});

function fakeStore(opts: { withInvalidate?: boolean } = {}) {
  const calls = {
    embedTexts: [] as string[],
    upserted: [] as Array<{ id: string; content: string }>,
    archived: [] as string[],
    invalidated: [] as Array<{ id: string; validEnd: string }>,
  };
  const store: Record<string, unknown> = {
    queryL1Records: async () => [],
    upsertL1: async (record: { id: string; content: string }) => {
      calls.upserted.push({ id: record.id, content: record.content });
      return true;
    },
    archiveL1: async (id: string) => {
      calls.archived.push(id);
      return true;
    },
    addLink: () => true,
  };
  if (opts.withInvalidate !== false) {
    store.invalidateL1 = async (id: string, validEnd: string) => {
      calls.invalidated.push({ id, validEnd });
      return true;
    };
  }
  const embedding = {
    embed: async (text: string) => {
      calls.embedTexts.push(text);
      return new Float32Array([1, 0, 0]);
    },
    getDimensions: () => 3,
    isReady: () => true,
  };
  return { store: store as never, embedding: embedding as never, calls };
}

const memory = (subject?: string): ExtractedMemory => ({
  content: "用户的 Instagram 粉丝数涨到 1300",
  type: "work_fact",
  priority: 60,
  source_message_ids: [],
  metadata: subject ? ({ subject } as never) : {},
  scene_name: "bench",
});

const decision = (over: Partial<DedupDecision> = {}): DedupDecision => ({
  record_id: "new-1",
  action: "store",
  target_ids: [],
  ...over,
});

let baseDir: string;
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "w134-writer-"));
});
afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

async function runWrite(args: {
  policy?: WritePolicy;
  subject?: string;
  decision?: DedupDecision;
  withInvalidate?: boolean;
}) {
  const { store, embedding, calls } = fakeStore({ withInvalidate: args.withInvalidate });
  const record = await writeMemory({
    memory: memory(args.subject),
    decision: args.decision ?? decision(),
    baseDir,
    sessionKey: "s::k",
    vectorStore: store,
    embeddingService: embedding,
    storage: undefined,
    writePolicy: args.policy,
  });
  return { record, calls };
}

describe("writeMemory 生产写面（#134）", () => {
  it("缺省关：embedding 输入=内容原文，update 旧行走归档（逐位现状）", async () => {
    const { calls } = await runWrite({ subject: "IG 粉丝", decision: decision({ action: "update", target_ids: ["old-1"] }) });
    expect(calls.embedTexts).toEqual(["用户的 Instagram 粉丝数涨到 1300"]);
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual(["old-1"]);
  });

  it("W1 开：embedding 输入=内容 + 分隔符 + subject（无 subject 时逐位原文）", async () => {
    const on = await runWrite({ policy: policy({ factKey: { enabled: true, separator: " | ", maxFactChars: 240 } }), subject: "IG 粉丝" });
    expect(on.calls.embedTexts).toEqual(["用户的 Instagram 粉丝数涨到 1300 | IG 粉丝"]);
    const noSubject = await runWrite({ policy: policy({ factKey: { enabled: true, separator: " | ", maxFactChars: 240 } }) });
    expect(noSubject.calls.embedTexts).toEqual(["用户的 Instagram 粉丝数涨到 1300"]);
  });

  it("W2 开：update 旧行只标记 valid_end（不归档），新行补 valid_start", async () => {
    const { record, calls } = await runWrite({
      policy: policy({ supersession: { enabled: true } }),
      decision: decision({ action: "update", target_ids: ["old-1", "old-2"], merged_content: "合并后的新事实" }),
    });
    expect(calls.invalidated.map((c) => c.id)).toEqual(["old-1", "old-2"]);
    for (const c of calls.invalidated) expect(Number.isNaN(Date.parse(c.validEnd))).toBe(false);
    expect(calls.archived).toEqual([]);
    expect(record?.valid_start).toBeTruthy();
  });

  it("W2 开但后端无 invalidateL1：回退归档（零删除底线）", async () => {
    const { calls } = await runWrite({
      policy: policy({ supersession: { enabled: true } }),
      decision: decision({ action: "merge", target_ids: ["old-1"], merged_content: "合并" }),
      withInvalidate: false,
    });
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual(["old-1"]);
  });
});
