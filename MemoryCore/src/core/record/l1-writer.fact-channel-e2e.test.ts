/**
 * A2（2026-11-02）：facts 通道**离线全链**取证（写侧 → 真实 sqlite → 读侧召回）。
 *
 * 背景：生产 yaml = extraction.facts.enabled=true（抽取侧已为 420 行多吐事实短语），
 * 而 write.factKey.enabled=false（无消费者）——付了 token 却没有召回收益。
 * 本文件证明「channel 档一旦开启」这条链是通的，并给出可执行的开档配方依据：
 *   writeMemory(channel 策略) → 事实向量落 l1_fact_vec → searchL1FactVector 可召回，
 *   而原文主索引（l1_vec）逐位不受影响。
 *
 * 铁律：纯本地临时 sqlite（dims=8），零网络、零生产库。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, DedupDecision } from "./l1-writer.js";
import type { WritePolicy } from "./write-policy.js";

const DIM = 8;
const CONTENT = "用户养了一只叫团子的猫，同时住在杭州";
const FACT_KEY_TEXT = "用户养了一只叫团子的猫 | 用户住在杭州";

const dirs: string[] = [];
const stores: VectorStore[] = [];

// Windows EBUSY：sqlite 句柄未关即 rmSync 会锁临时文件——afterEach 先 close 再删目录
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "a2-fact-channel-"));
  dirs.push(dir);
  const s = new VectorStore(join(dir, "v.db"), DIM);
  stores.push(s);
  const res = s.init();
  if (s.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return s;
}

/** 8 维正交基：正文 → e2，事实键 → e0，其余 → e4（cosine 有解析解）。 */
const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

function makeEmbedding(calls: string[]): EmbeddingService {
  const vecFor = (text: string) => (text === FACT_KEY_TEXT ? basis(0) : text === CONTENT ? basis(2) : basis(4));
  return {
    embed: async (text: string) => {
      calls.push(text);
      return vecFor(text);
    },
    embedBatch: async (texts: string[]) => texts.map((t) => vecFor(t)),
  } as unknown as EmbeddingService;
}

function channelPolicy(factKey: Partial<WritePolicy["factKey"]> = {}): WritePolicy {
  return {
    factKey: {
      enabled: true,
      mode: "channel",
      separator: " | ",
      maxFactChars: 240,
      maxFacts: 5,
      includeTriples: false,
      onlyForTypes: [],
      ...factKey,
    },
    supersession: { enabled: false },
    factRows: { enabled: false },
  };
}

const memory = (over: Partial<ExtractedMemory> = {}): ExtractedMemory =>
  ({
    content: CONTENT,
    type: "episodic",
    priority: 70,
    source_message_ids: ["m1"],
    metadata: { facts: ["用户养了一只叫团子的猫", "用户住在杭州"] },
    scene_name: "A2 取证",
    ...over,
  }) as unknown as ExtractedMemory;

const storeDecision = (record_id: string): DedupDecision => ({ record_id, action: "store", target_ids: [] });

async function writeOne(params: {
  store: VectorStore;
  policy?: WritePolicy;
  memory?: ExtractedMemory;
  recordId?: string;
}) {
  const baseDir = mkdtempSync(join(tmpdir(), "a2-jsonl-"));
  dirs.push(baseDir);
  const calls: string[] = [];
  const record = await writeMemory({
    memory: params.memory ?? memory(),
    decision: storeDecision(params.recordId ?? "r-a2-1"),
    baseDir,
    sessionKey: "sess-a2",
    vectorStore: params.store,
    embeddingService: makeEmbedding(calls),
    writePolicy: params.policy ?? channelPolicy(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  return { record, embedCalls: calls };
}

describe("A2 facts 通道离线全链（channel 档）", () => {
  it("写一条 fact → 事实向量落位 → 读侧 searchL1FactVector 命中（score≈1），主索引仍按原文命中", async () => {
    const store = makeStore();
    const { record, embedCalls } = await writeOne({ store });

    expect(record?.id).toBe("r-a2-1");
    // 写侧确实按 channel 键 embed 了一次事实短语（不是拿原文冒充）
    expect(embedCalls).toContain(FACT_KEY_TEXT);

    // 读侧召回：事实键向量 → 命中该行
    const factHits = store.searchL1FactVector!(basis(0), 5);
    expect(factHits.map((h) => h.record_id)).toContain("r-a2-1");
    expect(factHits[0].score).toBeCloseTo(1, 5);

    // 原文主索引未被 channel 改写（embeddingKeyFor 在 channel 档逐位返回原文）
    const mainHits = store.searchL1Vector(basis(2), 5);
    expect(mainHits.map((h) => h.record_id)).toContain("r-a2-1");
  });

  it("onlyForTypes 门：类型不在白名单 → 零事实向量、零额外 embed 调用", async () => {
    const store = makeStore();
    const { embedCalls } = await writeOne({
      store,
      policy: channelPolicy({ onlyForTypes: ["work_fact"] }),
      memory: memory({ type: "episodic" }),
    });
    expect(embedCalls).toHaveLength(1); // 只有主索引那一次
    expect(store.searchL1FactVector!(basis(0), 5)).toEqual([]);
    // 主索引照常写入（channel 失败不回滚记录）
    expect(store.searchL1Vector(basis(2), 5).map((h) => h.record_id)).toContain("r-a2-1");
  });

  it("缺省关（factKey.enabled=false）：零事实向量——今天的行为逐位不变", async () => {
    const store = makeStore();
    const { embedCalls } = await writeOne({
      store,
      policy: { ...channelPolicy(), factKey: { ...channelPolicy().factKey, enabled: false } },
    });
    expect(embedCalls).toHaveLength(1);
    expect(store.searchL1FactVector!(basis(0), 5)).toEqual([]);
  });

  it("有空事实（metadata 无 facts/subject）：不写事实向量、不多调 embedding", async () => {
    const store = makeStore();
    const { embedCalls } = await writeOne({ store, memory: memory({ metadata: {} }) });
    expect(embedCalls).toHaveLength(1);
    expect(store.searchL1FactVector!(basis(0), 5)).toEqual([]);
  });
});
