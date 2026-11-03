/**
 * A4（2026-11-03）：写侧自述标注**覆盖率**接线端到端。
 *
 * 生产实测（只读 D:/TDB/data/vectors.db，2026-11-02）：l1_records 4022 行里
 * `metadata.actor="agent"` 仅 16 行，而未标注的 4006 行中启发式命中 960 行（23.96%）。
 * 两个成因必须分开锁：
 *  1) 开关缺省 false（`extraction.actorTagging`）——开启后必须真的覆盖到自述行；
 *  2) dedup 合并会改写落库文本（l1-writer `merged_content ?? memory.content`），标签在
 *     合并前打的 → 必须按**最终 content** 复判，否则双向错标。
 *
 * 纪律：LLM 用 stub（不触网）；baseDir 走 mkdtemp 临时目录；缺省档逐位不变。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "./l1-extractor.js";
import { parseConfig } from "../../config.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

/** agent 自述（必须被标注）。 */
const NARRATION = "我在和用户做记忆系统改造";
/** 普通事实（必须不被标注）。 */
const FACT = "模型参数写错了";
/** dedup 候选（必须存在，才会走 LLM 判定）。 */
const CANDIDATE = {
  record_id: "c1",
  content: "用户在做记忆系统改造",
  type: "episodic",
  priority: 60,
  scene_name: "A4 标注覆盖",
  timestamp_str: "2026-01-01T00:00:00.000Z",
  session_key: "",
  session_id: "",
  score: 0.9,
};

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeRunner(contents: string[], mergedContent?: string): LLMRunner {
  const scenes = JSON.stringify([
    {
      scene_name: "A4 标注覆盖",
      message_ids: ["m1"],
      memories: contents.map((content) => ({ content, type: "episodic", priority: 60 })),
    },
  ]);
  return {
    run: async (p: { taskId?: string; prompt?: string }) => {
      if (p.taskId === "l1-extraction") return scenes;
      if (p.taskId === "l1-conflict-detection") {
        const ids = [...(p.prompt ?? "").matchAll(/record_id: ([^\s)]+)/gu)].map((m) => m[1]);
        return JSON.stringify(
          ids.map((id) => ({
            record_id: id,
            action: "update",
            target_ids: [CANDIDATE.record_id],
            merged_content: mergedContent,
          })),
        );
      }
      // enrich 等旁路：空对象即可（调用方 non-fatal）
      return "{}";
    },
  } as unknown as LLMRunner;
}

function makeStore(): IMemoryStore {
  return {
    isDegraded: () => false,
    countL1VectorRows: async () => 1,
    countL1: async () => 1,
    isFtsAvailable: () => false,
    upsertL1: async () => true,
    searchL1Vector: async () => [CANDIDATE],
    invalidateL1: async () => true,
    archiveL1: async () => true,
    addLink: () => {},
    listValues: async () => [],
  } as unknown as IMemoryStore;
}

function makeEmbedding(): EmbeddingService {
  return {
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  } as unknown as EmbeddingService;
}

function readPersisted(baseDir: string): Array<Record<string, unknown>> {
  const recordsDir = path.join(baseDir, "records");
  if (!fs.existsSync(recordsDir)) return [];
  return fs.readdirSync(recordsDir).flatMap((f) =>
    fs
      .readFileSync(path.join(recordsDir, f), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

async function run(params: {
  contents: string[];
  actorTagging?: boolean;
  /** 提供 = 走 dedup 链路且 LLM 判 update + merged_content 改写。 */
  mergedContent?: string;
}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1a4-"));
  const dedup = params.mergedContent !== undefined;
  try {
    const res = await extractL1Memories({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: params.contents.join("；"),
          timestamp: 1_700_000_000_000,
        },
      ] as never,
      sessionKey: "sess-a4",
      baseDir,
      memoryConfig: parseConfig({ extraction: { actorTagging: params.actorTagging === true } }),
      logger: makeLogger() as never,
      options: {
        enableDedup: dedup,
        llmRunner: makeRunner(params.contents, params.mergedContent),
        maxMemoriesPerSession: 10,
        ...(dedup ? { vectorStore: makeStore(), embeddingService: makeEmbedding() } : {}),
      },
    });
    return { res, rows: readPersisted(baseDir) };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

const metadataOf = (row: Record<string, unknown> | undefined) => (row?.metadata ?? {}) as Record<string, unknown>;

describe("A4 写侧标注覆盖：开关开 = 自述行必带 actor，非自述行必不带", () => {
  it("同一批两条：自述行带 actor=agent，非自述行不带", async () => {
    const { res, rows } = await run({
      contents: [NARRATION, FACT],
      actorTagging: true,
    });
    expect(res.storedCount).toBe(2);
    const byContent = new Map(rows.map((r) => [String(r.content), metadataOf(r)]));
    expect(byContent.get(NARRATION)?.actor).toBe("agent");
    expect(Object.prototype.hasOwnProperty.call(byContent.get(FACT) ?? {}, "actor")).toBe(false);
  });

  it("开关关（缺省）：自述行也不带 actor（字节形态不变）", async () => {
    const { rows } = await run({ contents: [NARRATION] });
    expect(rows).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(metadataOf(rows[0]), "actor")).toBe(false);
  });
});

describe("A4 dedup 合并改写后按最终 content 复判（双向不错标）", () => {
  it("原文自述 → 合并文本变非自述：落库不带 actor", async () => {
    const { rows } = await run({
      contents: [NARRATION],
      actorTagging: true,
      mergedContent: FACT,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(FACT);
    expect(Object.prototype.hasOwnProperty.call(metadataOf(rows[0]), "actor")).toBe(false);
  });

  it("原文非自述 → 合并文本变自述：落库补上 actor=agent", async () => {
    const { rows } = await run({
      contents: [FACT],
      actorTagging: true,
      mergedContent: NARRATION,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(NARRATION);
    expect(metadataOf(rows[0]).actor).toBe("agent");
  });
});
