/**
 * task-100（预算内降级，2026-11-01）· /v3/recall 端点套件。
 *
 * 合同（真链路：临时 SQLite + handleV2Route 真分发 + 真 performLayeredRecall）：
 *   1. 向量腿超预算 ⇒ **HTTP 200**（不再 504）、block 非空（FTS 腿的行照样注入）、
 *      meta.degraded='fts' 且带 l1Ms/ftsMs；老字段（conclusionCount 等）一个不少；
 *   2. l1BudgetMs=0 ⇒ 关，逐位旧行为（等向量腿，degraded=null）；
 *   3. l1Fallback='none' ⇒ 只观测不改变行为（预算再紧也不降级）；
 *   4. 缺省 l1BudgetMs=2000 ⇒ 2s 左右就回落 FTS，不等到 timeoutMs。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import { parseConfig, type MemoryTdaiConfig } from "../../config.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { V2RouterDeps } from "../v2-router.js";

const KW = "L1DEGRADE";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-01T00:00:00Z"],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "l1degrade",
    teamId: "default",
    userId: "u1",
    agentId: "a1",
    ...over,
  }) as MemoryRecord;

const ROWS: MemoryRecord[] = [
  mk("d-1", { content: `${KW} 预算内降级的持续态结论甲` }),
  mk("d-2", { content: `${KW} 预算内降级的经验条目乙` }),
];

const QUERY = `${KW} 预算内降级的当前进展`;

/** 基线参数（排序信号全 0；hybrid 策略——向量腿必须真的被调用，才谈得上降级）。 */
const RECALL_BASE: Record<string, unknown> = {
  strategy: "hybrid",
  maxResults: 5,
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  graphDiscount: 0,
  sceneBoost: 0,
};

/** 向量腿耗时可控的 embedding（真 searchHybrid 只调 embed()）。 */
function slowEmbedding(delayMs: number): EmbeddingService {
  return {
    embed: async () => {
      await sleep(delayMs);
      return new Float32Array(8).fill(0.05);
    },
  } as unknown as EmbeddingService;
}

function makeEnv(): { store: VectorStore; dataDir: string; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1degrade-db-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1degrade-data-"));
  const store = new VectorStore(path.join(dbDir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of ROWS) store.upsertL1(m, undefined);
  return {
    store,
    dataDir,
    cleanup: () => {
      try {
        store.close();
        fs.rmSync(dbDir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch { /* 无害 */ }
    },
  };
}

function recallCfg(v3Recall: Record<string, unknown>): MemoryTdaiConfig {
  return parseConfig({
    recall: { ...RECALL_BASE, v3Recall: { enabled: true, timeoutMs: 5000, ...v3Recall } },
  });
}

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

async function postRecall(opts: {
  cfg: MemoryTdaiConfig;
  store: VectorStore;
  dataDir: string;
  embedDelayMs: number;
  sessionId: string;
}): Promise<{ res: Captured; elapsedMs: number }> {
  const captured: Captured = {};
  const headers: Record<string, string | string[] | undefined> = {
    authorization: "Bearer test-key",
    "x-tdai-service-id": "default",
    "x-tdai-team-id": "default",
    "x-tdai-user-id": "u1",
    "x-tdai-agent-id": "a1",
    "x-tdai-session-id": opts.sessionId,
  };
  const req = { headers } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const deps = {
    getStore: () => opts.store,
    getEmbedding: () => slowEmbedding(opts.embedDelayMs),
    getStorage: () => undefined,
    getDataDir: () => opts.dataDir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "standalone" as const,
    config: { memory: opts.cfg },
  } as unknown as V2RouterDeps;
  const t0 = performance.now();
  await handleV2Route(
    req,
    res,
    "/v3/recall",
    "POST",
    (async () => ({ query: QUERY })) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, body) => {
      captured.status = status;
      captured.body = body as Captured["body"];
    },
    deps,
  );
  return { res: captured, elapsedMs: performance.now() - t0 };
}

function dataOf(res: Captured): { block: string; meta: Record<string, unknown> } {
  const data = res.body?.data as { block?: string; meta?: Record<string, unknown> } | undefined;
  return { block: typeof data?.block === "string" ? data.block : "", meta: data?.meta ?? {} };
}

describe("task-100 · /v3/recall 预算内降级", () => {
  it("① 向量腿超预算 ⇒ 200 + 块非空 + meta.degraded=fts + l1Ms/ftsMs，老字段不缺", async () => {
    const env = makeEnv();
    try {
      const { res, elapsedMs } = await postRecall({
        cfg: recallCfg({ l1BudgetMs: 200, l1Fallback: "fts" }),
        store: env.store,
        dataDir: env.dataDir,
        embedDelayMs: 3000,
        sessionId: "sk-degrade-1",
      });
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      const { block, meta } = dataOf(res);
      expect(block.length).toBeGreaterThan(0);
      expect(block).toContain(KW);
      expect(meta.degraded).toBe("fts");
      expect(typeof meta.l1Ms).toBe("number");
      expect(typeof meta.ftsMs).toBe("number");
      // 老字段一个不少（代理侧契约不变）
      expect(meta).toHaveProperty("conclusionCount");
      expect(meta).toHaveProperty("experienceCount");
      expect(meta).toHaveProperty("sessionReused");
      expect(meta).toHaveProperty("layered");
      expect(meta).toHaveProperty("perfMs");
      // 关键：没有等到 timeoutMs=5000，也没有 504
      expect(elapsedMs).toBeLessThan(2500);
    } finally {
      env.cleanup();
    }
  });

  it("② l1BudgetMs=0 ⇒ 关：逐位旧行为（等向量腿，degraded=null）", async () => {
    const env = makeEnv();
    try {
      const { res, elapsedMs } = await postRecall({
        cfg: recallCfg({ l1BudgetMs: 0 }),
        store: env.store,
        dataDir: env.dataDir,
        embedDelayMs: 900,
        sessionId: "sk-degrade-2",
      });
      expect(res.status).toBe(200);
      const { meta } = dataOf(res);
      expect(meta.degraded).toBeNull();
      expect(elapsedMs).toBeGreaterThanOrEqual(800);
    } finally {
      env.cleanup();
    }
  });

  it("③ l1Fallback=none ⇒ 只观测不改变行为（预算再紧也不降级）", async () => {
    const env = makeEnv();
    try {
      const { res, elapsedMs } = await postRecall({
        cfg: recallCfg({ l1BudgetMs: 200, l1Fallback: "none" }),
        store: env.store,
        dataDir: env.dataDir,
        embedDelayMs: 900,
        sessionId: "sk-degrade-3",
      });
      expect(res.status).toBe(200);
      expect(dataOf(res).meta.degraded).toBeNull();
      expect(elapsedMs).toBeGreaterThanOrEqual(800);
    } finally {
      env.cleanup();
    }
  });

  it("④ 缺省 l1BudgetMs=2000：不配也会在 ~2s 回落 FTS（不等到 timeoutMs）", async () => {
    const env = makeEnv();
    try {
      const { res, elapsedMs } = await postRecall({
        cfg: recallCfg({}),
        store: env.store,
        dataDir: env.dataDir,
        embedDelayMs: 4000,
        sessionId: "sk-degrade-4",
      });
      expect(res.status).toBe(200);
      const { block, meta } = dataOf(res);
      expect(meta.degraded).toBe("fts");
      expect(block.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeGreaterThanOrEqual(1900);
      expect(elapsedMs).toBeLessThan(3200);
    } finally {
      env.cleanup();
    }
  });
});