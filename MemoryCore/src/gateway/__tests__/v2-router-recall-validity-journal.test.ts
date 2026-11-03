/**
 * F7（2026-11-02 复验批次）：/v3/recall 端点路的效期观测段。
 *
 * 旧 journal 的 gates 只有 selfNarration/conclusionRerank/smallToBig/conclusionRouting，
 * 端点路（performLayeredRecall）看不到效期过滤，复验时无法判断"某条结论为什么没被召回"。
 * 本套件走真链路（临时 SQLite + handleV2Route 真分发 + 真 performLayeredRecall + 真 journal 落盘），
 * 断言一次 /v3/recall 后 journal 行里带 gates.validity 三层口径。
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

const KW = "F7VALIDITY";
const NOW = new Date("2026-11-02T00:00:00Z");
const PAST = "2026-10-01T00:00:00.000Z";

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
    sessionId: "f7validity",
    teamId: "default",
    userId: "u1",
    agentId: "a1",
    ...over,
  }) as MemoryRecord;

const ROWS: MemoryRecord[] = [
  mk("live-1", { content: `${KW} 仍然有效的活行` }),
  mk("gone-1", { content: `${KW} 已被取代的过期行`, valid_end: PAST }),
];

const QUERY = `${KW} 当前有效的那条`;

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

function fastEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(8).fill(0.05) } as unknown as EmbeddingService;
}

function makeEnv(): { store: VectorStore; dataDir: string; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "f7validity-db-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "f7validity-data-"));
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
      } catch {
        /* 无害 */
      }
    },
  };
}

function recallCfg(): MemoryTdaiConfig {
  return parseConfig({
    recall: {
      ...RECALL_BASE,
      excludeInvalidated: true,
      // 显式 hard：缺省 recall.validity.mode=soft，端点路会走软失效（注入点不二次过滤），
      // 本用例要钉的是 hard 档"注入少几行 = injected.dropped"。
      validity: { mode: "hard" },
      validityNow: NOW.toISOString(),
      v3Recall: { enabled: true, timeoutMs: 5000, l1BudgetMs: 0 },
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as Record<string, unknown>);
}

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

async function postRecall(opts: {
  cfg: MemoryTdaiConfig;
  store: VectorStore;
  dataDir: string;
  sessionId: string;
}): Promise<Captured> {
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
    getEmbedding: () => fastEmbedding(),
    getStorage: () => undefined,
    getDataDir: () => opts.dataDir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "standalone" as const,
    config: { memory: opts.cfg },
  } as unknown as V2RouterDeps;
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
  return captured;
}

function journalEntries(dataDir: string): Record<string, unknown>[] {
  const dir = path.join(dataDir, "logs", "recall");
  if (!fs.existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* 半行/损坏行跳过 */
      }
    }
  }
  return out;
}

describe("F7 · /v3/recall 端点 journal 带 validity 段", () => {
  it("一次召回后 journal 行含 gates.validity（mode/pool/top/injected 三层）", async () => {
    const env = makeEnv();
    try {
      const res = await postRecall({ cfg: recallCfg(), store: env.store, dataDir: env.dataDir, sessionId: "sk-f7-1" });
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);

      const entries = journalEntries(env.dataDir);
      expect(entries.length).toBeGreaterThan(0);
      const gates = (entries[entries.length - 1]?.gates ?? {}) as Record<string, unknown>;
      const validity = gates.validity as
        | {
            mode?: string;
            pool?: { dropped?: number };
            top?: { dropped?: number };
            injected?: { dropped?: number; active?: number };
          }
        | undefined;
      expect(validity).toBeDefined();
      expect(validity!.mode).toBe("hard");
      expect(validity!.pool!.dropped).toBe(1); // 池里看见 1 条过期
      expect(validity!.top!.dropped).toBe(1); // 它进了 top（两条都命中）
      expect(validity!.injected!.dropped).toBe(1); // 注入点真丢了 1 行
      const block = String((res.body?.data as { block?: string } | undefined)?.block ?? "");
      expect(block).not.toContain("已被取代的过期行");
    } finally {
      env.cleanup();
    }
  });
});
