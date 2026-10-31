/**
 * #152 ① · 写路径事实通道：能力位守卫（fail-closed + WARN-once）。
 *
 * 旧实现是 `typeof store.upsertL1FactVector === "function"` 的隐式探测：
 * 方法缺失就无声 skip ⇒ tcvdb 上「事实短语写了但搜不到」无人知晓。
 * 现在能力位是唯一判据：未声明 l1FactVec=true → 零 upsert + WARN 一次；
 * 声明 true → 行为与改动前逐位一致（照常写）。
 */
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { writeMemory } from "./l1-writer.js";
import type { DedupDecision, ExtractedMemory } from "./l1-writer.js";
import type { WritePolicy } from "./write-policy.js";
import { __resetCapabilityWarnings } from "../store/capability-guard.js";
import type { StoreCapabilities } from "../store/types.js";

const policy = (over: Partial<WritePolicy> = {}): WritePolicy => ({
  factKey: {
    enabled: true,
    mode: "channel",
    separator: " | ",
    maxFactChars: 240,
    maxFacts: 5,
    includeTriples: false,
    onlyForTypes: [],
  } as never,
  supersession: { enabled: false },
  ...over,
});

function fakeStore(caps: StoreCapabilities) {
  const calls = { embedTexts: [] as string[], factWrites: [] as Array<{ id: string }> };
  const store: Record<string, unknown> = {
    queryL1Records: async () => [],
    upsertL1: async () => true,
    archiveL1: async () => true,
    addLink: () => true,
    invalidateL1: async () => true,
    // 事实方法「存在」但能力位可能为 false —— 正是本测试要区分的情形
    upsertL1FactVector: async (id: string) => {
      calls.factWrites.push({ id });
      return true;
    },
    getCapabilities: () => caps,
  };
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

const CAPS_TCVDB: StoreCapabilities = {
  vectorSearch: true,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
  l1FactVec: false,
};
const CAPS_SQLITE: StoreCapabilities = { ...CAPS_TCVDB, l1FactVec: true };

const memory = (): ExtractedMemory => ({
  content: "用户的 Instagram 粉丝数涨到 1300",
  type: "work_fact",
  priority: 60,
  source_message_ids: [],
  metadata: { facts: ["用户住在杭州"] } as never,
  scene_name: "bench",
});

const decision = (): DedupDecision => ({ record_id: "new-1", action: "store", target_ids: [] });

let baseDir: string;
beforeEach(() => {
  __resetCapabilityWarnings();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r152-writer-"));
});
afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

async function run(caps: StoreCapabilities, warns: string[]) {
  const { store, embedding, calls } = fakeStore(caps);
  await writeMemory({
    memory: memory(),
    decision: decision(),
    baseDir,
    sessionKey: "s::k",
    vectorStore: store,
    embeddingService: embedding,
    storage: undefined,
    writePolicy: policy(),
    logger: { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {} } as never,
  });
  return calls;
}

const capabilityWarns = (warns: string[]) => warns.filter((m) => m.includes("[capability]") && m.includes("l1FactVec"));

describe("#152 ① 写路径事实通道 · 能力位守卫", () => {
  it("tcvdb（l1FactVec=false）：零 upsertL1FactVector + WARN 一次，主写入照常", async () => {
    const warns: string[] = [];
    const calls = await run(CAPS_TCVDB, warns);
    expect(calls.factWrites).toEqual([]);
    // 主 embedding 只打了原文（事实短语未被 embed）
    expect(calls.embedTexts).toEqual(["用户的 Instagram 粉丝数涨到 1300"]);
    expect(capabilityWarns(warns)).toHaveLength(1);
    expect(capabilityWarns(warns)[0]).toContain("l1_fact_vec");
  });

  it("WARN-once：连续多次写入只留一条", async () => {
    const warns: string[] = [];
    await run(CAPS_TCVDB, warns);
    await run(CAPS_TCVDB, warns);
    expect(capabilityWarns(warns)).toHaveLength(1);
  });

  it("sqlite（l1FactVec=true）：照常写事实向量、不 WARN（行为不回退）", async () => {
    const warns: string[] = [];
    const calls = await run(CAPS_SQLITE, warns);
    expect(calls.factWrites).toHaveLength(1);
    expect(calls.factWrites[0].id).toBe("new-1");
    expect(calls.embedTexts).toHaveLength(2); // 原文 + 事实短语
    expect(capabilityWarns(warns)).toEqual([]);
  });
});
