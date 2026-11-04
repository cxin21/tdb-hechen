/**
 * task-9（2026-11-04）：source_message_ids 的**提取期证据主键**契约。
 *
 * 背景：该列自落库起「只写不读」——l1-extractor 写、l1-writer 取代时并集，但零决策读取
 * （生产当日新增 106 行中 94 行有值，无一参与判定）。本用例钉住两条新契约：
 *  ① 幻觉剔除：记忆声明的 source_message_ids 必须 ⊆ **当批** messages 的 id 集合
 *    （prompt 合同 l1-extraction.ts:116/241 只许引用新消息；background 仅作上下文），
 *    越界的 id 在归一阶段剔除并 warn 一条（计数，不含正文）。
 *  ② 同源完全覆盖 → update：dedup 之后、applyDecisions 之前，对 action==='store' 的新记忆
 *    反查 findL1BySourceMessageIds；既有行来源集合 ⊇ 新记忆来源集合 → 决策改 update
 *    （target 指既有行），多条覆盖取覆盖数最多者；LLM 已给 update/merge/skip 不动；
 *    方法缺失/失败 fail-open（保持 store）。
 *
 * 用**真临时 SQLite**（VectorStore，dimensions=0 元数据/FTS 模式）+ 假 LLM runner：
 * 覆盖「提取 → batchDedup（无候选→storeAll）→ 证据反查改写 → writeMemory 归档/并集」全程，
 * 确保新 SQL 与改写点在真实路径上。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "../l1-extractor.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import type { IMemoryStore } from "../../store/types.js";
import type { MemoryRecord } from "../l1-writer.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { LLMRunner } from "../../types.js";

const LONG_INPUT = "我最近搬到了杭州，之前一直住在上海，另外新公司的入职时间是下周一上午九点，麻烦帮我记住这些信息";

const TENANT = { team: "default", user: "u1", agent: "a1" };

function loggerStub() {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    },
  };
}

/** 假 runner：提取返回指定 scenesJson；其余旁路（enrichSoulFields 等）显式抛错，调用方已 try/catch。 */
function makeRunner(scenesJson: string): LLMRunner {
  return {
    run: async (p: { taskId?: string }) => {
      if (p.taskId === "l1-extraction") return scenesJson;
      throw new Error("unexpected taskId: " + String(p.taskId));
    },
  } as unknown as LLMRunner;
}

function scenesFor(sourceIds: string[], content = LONG_INPUT): string {
  return JSON.stringify([
    {
      scene_name: "测试情境",
      message_ids: ["m1"],
      memories: [{ content, type: "persona", priority: 70, source_message_ids: sourceIds }],
    },
  ]);
}

function makeEmbedding(): EmbeddingService {
  return {
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  } as unknown as EmbeddingService;
}

const mkRecord = (id: string, sourceIds: string[], updatedAt: string, tenant = TENANT): MemoryRecord =>
  ({
    id,
    content: `既有条目 ${id}`,
    type: "persona",
    priority: 50,
    scene_name: "测试情境",
    source_message_ids: sourceIds,
    metadata: {},
    timestamps: [updatedAt],
    occurred_at: updatedAt,
    certainty: "observed",
    sensitivity: "none",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt,
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: tenant.team,
    userId: tenant.user,
    agentId: tenant.agent,
  }) as unknown as MemoryRecord;

/** 真临时库（dimensions=0 = 元数据/FTS 模式；向量写入自动跳过）。 */
function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-provenance-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    cleanup: () => {
      // Windows：必须先 close 再 rmSync，否则 EBUSY/EPERM
      try {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    },
  };
}

async function runExtraction(params: {
  store: IMemoryStore;
  scenesJson: string;
  messages?: Array<{ id: string; role: string; content: string; timestamp: number }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-provenance-out-"));
  const { warns, logger } = loggerStub();
  try {
    const res = await extractL1Memories({
      messages: (params.messages ?? [
        { id: "m1", role: "user", content: LONG_INPUT, timestamp: 1_700_000_000_000 },
      ]) as never,
      sessionKey: "sess-provenance",
      teamId: TENANT.team,
      userId: TENANT.user,
      agentId: TENANT.agent,
      baseDir: dir,
      memoryConfig: parseConfig({}),
      logger,
      options: {
        enableDedup: true,
        llmRunner: makeRunner(params.scenesJson),
        vectorStore: params.store,
        embeddingService: makeEmbedding(),
      },
    });
    return { res, warns };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
}

describe("task-9 · source_message_ids 提取期证据主键", () => {
  it("① 幻觉 id 剔除：只保留当批 messages 里的 id，并 warn 一条计数", async () => {
    const { store, cleanup } = makeStore();
    try {
      const { res, warns } = await runExtraction({
        store,
        scenesJson: scenesFor(["m1", "ghost-1", "ghost-2"]),
      });
      expect(res.records).toHaveLength(1);
      expect(res.records[0].source_message_ids).toEqual(["m1"]);
      expect(warns.some((w) => w.includes("hallucinated") && w.includes("dropped 2"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("② 全部幻觉 → 留空数组（落库语义不变，不因剔除而丢记忆）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const { res } = await runExtraction({ store, scenesJson: scenesFor(["ghost-9"]) });
      expect(res.records).toHaveLength(1);
      expect(res.records[0].source_message_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("③ 同源完全覆盖 → 决策由 store 改 update（旧行归档，新行接手来源并集）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("old-1", ["m0", "m1"], "2026-08-01T00:00:00Z"), undefined);

      const { res } = await runExtraction({ store, scenesJson: scenesFor(["m1"]) });

      expect(res.records).toHaveLength(1);
      const rec = res.records[0];
      // update 语义：旧行来源 ∪ 新行来源（旧行在前）+ 版本递增 + 旧行归档退出 l1_records
      expect(rec.source_message_ids).toEqual(["m0", "m1"]);
      expect(rec.version).toBe(1);
      expect(store.queryL1Records({ recordIds: ["old-1"] })).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("④ 跨租户既有行不触发改写（隔离口径同 dedup：不带 sessionId）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("other-1", ["m1"], "2026-08-01T00:00:00Z", { team: "default", user: "u2", agent: "a1" }), undefined);

      const { res } = await runExtraction({ store, scenesJson: scenesFor(["m1"]) });

      expect(res.records).toHaveLength(1);
      expect(res.records[0].source_message_ids).toEqual(["m1"]);
      expect(res.records[0].version).toBe(0);
      // 别人的行原样保留
      expect(store.queryL1Records({ recordIds: ["other-1"] })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("⑤ 部分覆盖保持 store（既有行只覆盖部分来源，不做取代）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("partial-1", ["m1"], "2026-08-01T00:00:00Z"), undefined);

      const { res } = await runExtraction({
        store,
        scenesJson: scenesFor(["m1", "m2"]),
        messages: [
          { id: "m1", role: "user", content: LONG_INPUT, timestamp: 1_700_000_000_000 },
          { id: "m2", role: "user", content: LONG_INPUT + "（补充）", timestamp: 1_700_000_001_000 },
        ],
      });

      expect(res.records).toHaveLength(1);
      expect(res.records[0].source_message_ids).toEqual(["m1", "m2"]);
      expect(res.records[0].version).toBe(0);
      expect(store.queryL1Records({ recordIds: ["partial-1"] })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("⑥ 方法缺失 fail-open：后端未实现 findL1BySourceMessageIds 时保持 store，不抛", async () => {
    const upserted: MemoryRecord[] = [];
    const fake = {
      isDegraded: () => false,
      countL1VectorRows: async () => 1,
      countL1: async () => 1,
      isFtsAvailable: () => false,
      upsertL1: async (rec: MemoryRecord) => {
        upserted.push(rec);
        return true;
      },
      searchL1Vector: async () => [],
      addLink: () => {},
      listValues: async () => [],
      archiveL1: async () => true,
    } as unknown as IMemoryStore;

    const { res } = await runExtraction({ store: fake, scenesJson: scenesFor(["m1"]) });
    expect(res.records).toHaveLength(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].source_message_ids).toEqual(["m1"]);
    expect(upserted[0].version).toBe(0);
  });
});
