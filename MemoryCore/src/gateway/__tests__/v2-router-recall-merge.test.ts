/**
 * DS-RECALL-MERGE-001（合并召回 · 核心单点 /v3/recall + 代理瘦传输）· 端点 RED 套件。
 *
 * spec：docs/superpowers/specs/2026-09-12-recall-merge-design.md（裁决权威）。
 *
 * 覆盖（spec §5 / 任务验收逐条）：
 *   1. v3Recall.enabled 缺省 false → /v3/recall 404（逐位现状：端点不暴露）。
 *   2. /v3 仅暴露 /recall 子路径（/v2/recall 不注册——新接入方一律 v3）。
 *   3. v3 严格隔离门：三元组缺失 → 422（隔离头族既有闸门，本端点自动继承）。
 *   4. 同形验证（核心验收）：同 query 同数据下，端点 block 与钩子 prependContext 逐位一致。
 *   5. 会话键传递：同 session 二次调用 → meta.sessionReused=true 且 block 不变
 *      （幂等结论层跨 HTTP 生效）。
 *   6. 无命中 → block="" + meta 全零（代理据此零注入，不算失败不降级）。
 *
 * 铁律：全部走真链路（临时 SQLite 库 + handleV2Route 真分发），零检索层语义假设。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import { parseConfig, type MemoryTdaiConfig } from "../../config.js";
import { performAutoRecall } from "../../core/hooks/auto-recall.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { V2RouterDeps } from "../v2-router.js";

const KW = "MERGECALL";

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `${KW} 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "合并召回",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-12T00:00:00Z"],
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "mergecall",
    // 租户三元组：与端点隔离头一致（端点检索带 filter；钩子路无 filter——
    // 全部行同租户 → 两路候选集相同，同形验证成立）。
    teamId: "default",
    userId: "u1",
    agentId: "a1",
    ...over,
  }) as MemoryRecord;

const ROWS: MemoryRecord[] = [
  mk("wf-a", { type: "work_fact", content: `${KW} 合并召回专项持续态结论甲` }),
  mk("wf-b", { type: "work_fact", content: `${KW} 合并召回专项持续态结论乙` }),
  mk("exp-1", { content: `${KW} 经验条目一（代理瘦传输）` }),
  mk("exp-2", { content: `${KW} 经验条目二（核心单点）` }),
  mk("exp-3", { content: `${KW} 经验条目三（降级路）` }),
];

const QUERY = `${KW} 合并召回的当前进展`;

/** 基线参数：排序信号全 0（关断恒等，消除 now 快照非确定性），keyword 策略（零 embedding）。 */
const RECALL_OFF: Record<string, unknown> = {
  strategy: "keyword",
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

function makeEnv(cfgOverrides: Record<string, unknown>): {
  store: VectorStore;
  dataDir: string;
  cleanup: () => void;
} {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergecall-db-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergecall-data-"));
  const store = new VectorStore(path.join(dbDir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of ROWS) store.upsertL1(m, undefined);
  // 结论候选走 scene_block 通道：profile scope 目录（与生产同构，缺省 default 桶）。
  const profileDir = path.join(dataDir, "profiles", encodeURIComponent("team:default|agent:default"));
  fs.mkdirSync(path.join(profileDir, ".metadata"), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, ".metadata", "scene_index.json"),
    JSON.stringify([{ filename: "合并召回.md", summary: `${KW} 合并召回场景块摘要结论`, heat: 0, created: "", updated: "" }]),
    "utf-8",
  );
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

function recallCfg(cfgOverrides: Record<string, unknown>, enabled: boolean): MemoryTdaiConfig {
  return parseConfig({
    recall: { ...RECALL_OFF, ...cfgOverrides, v3Recall: { enabled, timeoutMs: 5000 } },
  });
}

interface CapturedResponse {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

/** handleV2Route 真分发脚手架：POST /v3/recall，隔离三元组经 x-tdai-* 头（v3 隔离头族先例形态）。 */
async function postRecall(opts: {
  cfg: MemoryTdaiConfig;
  store: VectorStore;
  dataDir: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  pathname?: string;
}): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
  const headers: Record<string, string | string[] | undefined> = {
    authorization: "Bearer test-key",
    "x-tdai-service-id": "default",
    "x-tdai-team-id": "default",
    "x-tdai-user-id": "u1",
    "x-tdai-agent-id": "a1",
    "x-tdai-session-id": "sk-merge-endpoint",
    ...(opts.headers ?? {}),
  };
  const req = { headers } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const deps = {
    getStore: () => opts.store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    getDataDir: () => opts.dataDir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "standalone" as const,
    config: { memory: opts.cfg },
  } as unknown as V2RouterDeps;
  const handled = await handleV2Route(
    req,
    res,
    opts.pathname ?? "/v3/recall",
    "POST",
    (async () => opts.body ?? { query: QUERY }) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, body) => {
      captured.status = status;
      captured.body = body as CapturedResponse["body"];
    },
    deps,
  );
  if (!handled) return { status: undefined, body: undefined };
  return captured;
}

describe("DS-RECALL-MERGE-001 · /v3/recall 核心单点端点", () => {
  it("验收1 · v3Recall.enabled 缺省 false → 404（逐位现状：端点不暴露）", async () => {
    const env = makeEnv({});
    try {
      const res = await postRecall({ cfg: recallCfg({}, false), store: env.store, dataDir: env.dataDir });
      expect(res.status).toBe(404);
      expect(res.body?.code).toBe(404);
      expect(res.body?.message).toContain("v3Recall");
    } finally {
      env.cleanup();
    }
  });

  it("验收2 · /v2/recall 不注册（v3-only），/v3/recall 注册后可分发", async () => {
    const env = makeEnv({});
    try {
      const cfg = recallCfg({}, true);
      const res = await postRecall({ cfg, store: env.store, dataDir: env.dataDir, pathname: "/v2/recall" });
      // 未注册 → handleV2Route 返回 false（未处理），不存在 v2 孪生入口。
      expect(res.status).toBeUndefined();
      expect(res.body).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("验收3 · 隔离头三元组缺失 → 422（v3 严格隔离闸门继承）", async () => {
    const env = makeEnv({});
    try {
      const res = await postRecall({
        cfg: recallCfg({}, true),
        store: env.store,
        dataDir: env.dataDir,
        headers: { "x-tdai-user-id": "" },
      });
      expect(res.status).toBe(422);
      expect(res.body?.code).toBe(422);
      expect(res.body?.message).toContain("strict isolation");
    } finally {
      env.cleanup();
    }
  });

  it("验收4 · 同形验证：端点 block 与钩子 prependContext 同 query 逐位一致", async () => {
    const env = makeEnv({});
    try {
      const cfg = recallCfg({}, true);
      // 钩子路：sessionKey 与端点不同（避免共享会话缓存使同形验证变空转）——
      // 同 query 同数据、两条独立会话，产出必须逐位一致。
      const hookRes = await performAutoRecall({
        userText: QUERY,
        actorId: "mergecall",
        sessionKey: "sk-merge-hook",
        cfg,
        pluginDataDir: env.dataDir,
        vectorStore: env.store as unknown as import("../../core/store/types.js").IMemoryStore,      });
      const res = await postRecall({ cfg, store: env.store, dataDir: env.dataDir });
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      const data = res.body?.data as { block: string; meta: Record<string, unknown> };
      expect(typeof data.block).toBe("string");
      expect(data.block.length).toBeGreaterThan(0);
      expect(data.block).toBe(hookRes?.prependContext ?? "");
    } finally {
      env.cleanup();
    }
  });

  it("验收5 · 会话键传递：同 session 二次调用 → sessionReused=true 且 block 不变（幂等结论层跨 HTTP）", async () => {
    const env = makeEnv({});
    try {
      const cfg = recallCfg({}, true);
      // 独立会话键（模块级结论缓存跨用例共享——同键会命中前序用例写入的缓存项）
      const IDEM_HEADERS = { "x-tdai-session-id": "sk-merge-idem" };
      const r1 = await postRecall({ cfg, store: env.store, dataDir: env.dataDir, headers: IDEM_HEADERS });
      const d1 = r1.body?.data as { block: string; meta: { conclusionCount: number; sessionReused: boolean } };
      expect(d1.meta.sessionReused).toBe(false);
      const r2 = await postRecall({ cfg, store: env.store, dataDir: env.dataDir, headers: IDEM_HEADERS });
      const d2 = r2.body?.data as { block: string; meta: { conclusionCount: number; sessionReused: boolean } };
      expect(d2.block).toBe(d1.block);
      expect(d2.meta.sessionReused).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("验收6 · 无命中 → block='' + meta 全零（代理零注入语义，非失败）", async () => {
    const env = makeEnv({});
    try {
      const cfg = recallCfg({}, true);
      const res = await postRecall({
        cfg,
        store: env.store,
        dataDir: env.dataDir,
        body: { query: "zzqq 无关词面完全不命中" },
      });
      expect(res.status).toBe(200);
      const data = res.body?.data as { block: string; meta: { conclusionCount: number; experienceCount: number; layered: boolean } };
      expect(data.block).toBe("");
      expect(data.meta.conclusionCount).toBe(0);
      expect(data.meta.experienceCount).toBe(0);
      expect(data.meta.layered).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
