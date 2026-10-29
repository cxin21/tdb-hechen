/**
 * #146（失效粒度降到「一条事实一行」）：extractor 侧 conflict 守卫。
 *
 * 契约（yaml memory.write.factRows.enabled）：
 *  - 关闭（缺省）：conflict + 单值内容 → 既有整行失效（invalidateL1）逐位不变；
 *  - 开启：不再整行失效，也不回落归档——同行兄弟事实会被一起带走，正是本票要消除的
 *    爆炸半径；旧事实行改由写侧 invalidateL1ByFactKey 精确定位；
 *  - 守卫只作用于失效/归档：conflict 边照建（冲突是关系事实），新记忆照常落库。
 *
 * 用真实 extractL1Memories 链路（假 runner/store/embedding，不做模块 mock），
 * 覆盖「提取 → batchDedup → applyDecisions」全程，确保守卫生效点在真实路径上。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "./l1-extractor.js";
import { parseConfig } from "../../config.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";
import type { WritePolicy } from "./write-policy.js";

const loggerStub = () => {
  const debugs: string[] = [];
  const warns: string[] = [];
  return {
    debugs,
    warns,
    logger: {
      debug: (m: string) => debugs.push(m),
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    },
  };
};

/** 新记忆 content：单值属性（住址）变更——#136 口径下属于「真矛盾」，可失效旧行。 */
const scenesJson = JSON.stringify([
  {
    scene_name: "测试情境",
    message_ids: ["m1"],
    memories: [
      {
        content: "用户住在杭州，之前一直住在上海",
        type: "persona",
        priority: 70,
        source_message_ids: ["m1"],
      },
    ],
  },
]);

/** 旧记忆候选：与新记忆同属性不同值（冲突）。 */
const candidate = {
  record_id: "c1",
  content: "用户住在上海",
  type: "persona",
  priority: 70,
  scene_name: "测试情境",
  timestamp_str: "2026-01-01T00:00:00.000Z",
  session_key: "",
  session_id: "",
  score: 0.9,
};

/** 假 runner：提取返回固定场景；dedup 对 prompt 里的每条新记忆回 conflict 指向 c1。 */
function makeRunner(): LLMRunner {
  return {
    run: async (p: { taskId?: string; prompt?: string }) => {
      if (p.taskId === "l1-extraction") return scenesJson;
      if (p.taskId === "l1-conflict-detection") {
        const ids = [...(p.prompt ?? "").matchAll(/record_id: ([^\s)]+)\)/gu)].map((m) => m[1]);
        return JSON.stringify(
          ids.map((id) => ({ record_id: id, action: "conflict", target_ids: [candidate.record_id] })),
        );
      }
      // enrichSoulFields 等旁路：调用方已 try/catch（非致命），这里显式失败以免误测
      throw new Error("unexpected taskId: " + String(p.taskId));
    },
  } as unknown as LLMRunner;
}

function makeStore(calls: { invalidated: string[]; archived: string[] }) {
  return {
    isDegraded: () => false,
    countL1VectorRows: async () => 1,
    countL1: async () => 1,
    isFtsAvailable: () => false,
    upsertL1: async () => true,
    searchL1Vector: async () => [candidate],
    invalidateL1: async (id: string) => {
      calls.invalidated.push(id);
      return true;
    },
    archiveL1: async (id: string) => {
      calls.archived.push(id);
      return true;
    },
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

async function runExtraction(writePolicy?: WritePolicy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-factrows-guard-"));
  const calls = { invalidated: [] as string[], archived: [] as string[] };
  const { debugs, warns, logger } = loggerStub();
  const cfg = parseConfig({});
  try {
    const res = await extractL1Memories({
      messages: [
        {
          id: "m1",
          role: "user",
          content: "我最近搬到了杭州，之前一直住在上海，另外新公司的入职时间是下周一上午九点，麻烦帮我记住这些信息",
          timestamp: 1_700_000_000_000,
        },
      ] as never,
      sessionKey: "sess-factrows-guard",
      teamId: "team-x",
      userId: "user-x",
      agentId: "agent-x",
      baseDir: dir,
      config: cfg,
      memoryConfig: cfg,
      logger,
      options: {
        enableDedup: true,
        enableMemoryLinks: true,
        llmRunner: makeRunner(),
        vectorStore: makeStore(calls),
        embeddingService: makeEmbedding(),
        writePolicy,
      },
    });
    return { res, calls, debugs, warns };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
}

const factRowsOn: WritePolicy = {
  factKey: {
    enabled: false,
    mode: "replace",
    separator: " | ",
    maxFactChars: 240,
    maxFacts: 5,
    includeTriples: false,
    onlyForTypes: [],
  },
  supersession: { enabled: true, cardinalityGate: true, cardinalityDefault: "single" },
  factRows: { enabled: true },
};

describe("#146 extractor conflict 守卫（factRows 粒度）", () => {
  it("关闭（缺省）：conflict + 单值内容 → 整行失效（invalidateL1）逐位不变", async () => {
    const { calls, res } = await runExtraction(undefined);
    expect(calls.invalidated).toEqual(["c1"]);
    expect(res.storedCount).toBe(1);
  });

  it("开启：不再整行失效，也不回落归档（旧行交给 fact_key 精确定位）", async () => {
    const { calls, debugs, res } = await runExtraction(factRowsOn);
    expect(calls.invalidated).toEqual([]);
    expect(calls.archived).toEqual([]);
    // 安静但可观测：debug 说明这是事实级粒度的刻意跳过
    expect(
      debugs.some(
        (m) => m.includes("fact-level granularity") && m.includes("whole-row invalidation skipped"),
      ),
    ).toBe(true);
    // 守卫生效不等于丢写：新记忆照常落库
    expect(res.storedCount).toBe(1);
  });
});
