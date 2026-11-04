/**
 * A 项（ADR-0025 决定 10）**dispatch 级**覆盖：`POST /v3/atomic/sensitivity` 真的能从
 * HTTP seam 走到 handler 与真库。
 *
 * 为什么必须有这一层：`/v3` 数据面被 `V3_ALLOWED_SUBPATHS` 封闭清单守卫，未登记的路径
 * 在分发层就被拦成 404 —— handler 单测绿 ≠ 线上可用。实证：`/atomic/importance` 的
 * handler 早在 DATAPLANE_HANDLERS 注册，但清单漏登，线上长期 404（本轮 A 项核对时发现并
 * 一并补登）。所以本套件同时钉三件事：
 *   ① 新端点登记生效：过清单 → handler → 主表 + l1_fts 同步降敏 + memory_audit 留痕；
 *   ② 补登生效：`/v3/atomic/importance` 不再 404（面板调级恢复可用）；
 *   ③ 清单没有被放开：同前缀的未登记路径仍 404（修断言 ② 不能靠「删掉清单」蒙混）。
 *
 * seam 与 core-values-wire.test.ts 同构：真临时 SQLite + 真 handleV2Route + 真 store SQL，
 * 只有 embedding 是 stub。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";

const TENANT = { teamId: "default", userId: "u1", agentId: "a1" };
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
  /** handleV2Route 的返回值：false = 分发层直接放手（未登记的 /v3 子路径走这条）。 */
  dispatched?: boolean;
}

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sens-wire-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    cleanup: () => {
      try {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    },
  };
}

const mkRecord = (id: string, sensitivity: string): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    sensitivity,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: TENANT.teamId,
    userId: TENANT.userId,
    agentId: TENANT.agentId,
  }) as MemoryRecord;

async function post(routePath: string, store: VectorStore, body: unknown, opts?: { omitServiceId?: boolean }): Promise<Captured> {
  const captured: Captured = {};
  const headers: Record<string, string | undefined> = {
    authorization: "Bearer test-key",
    "x-tdai-team-id": TENANT.teamId,
    "x-tdai-user-id": TENANT.userId,
    "x-tdai-agent-id": TENANT.agentId,
    "x-tdai-session-id": "sens-wire",
  };
  if (!opts?.omitServiceId) headers["x-tdai-service-id"] = "default";
  const req = { headers } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const deps = {
    getStore: () => store,
    getEmbedding: () => ({ embed: async () => new Float32Array(8).fill(0.01) } as unknown as EmbeddingService),
    getStorage: () => undefined,
    requestIsolation: { ...TENANT, sessionId: "sens-wire" },
    logger: noopLogger,
    deployMode: "standalone" as const,
    config: { memory: {} },
  } as unknown as V2RouterDeps;
  captured.dispatched = await handleV2Route(
    req,
    res,
    routePath,
    "POST",
    (async () => body) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, envelope) => {
      captured.status = status;
      captured.body = envelope as Captured["body"];
    },
    deps,
  );
  return captured;
}

type DbLike = { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } } };
const dbOf = (store: VectorStore) => (store as unknown as DbLike).db;

const sensOfMain = (store: VectorStore, id: string): string | null => {
  const row = (store as unknown as { queryL1Records: () => { record_id: string; sensitivity: string | null }[] })
    .queryL1Records()
    .find((r) => r.record_id === id);
  return row ? row.sensitivity : null;
};
const sensOfFts = (store: VectorStore, id: string): string | null => {
  const row = dbOf(store).prepare("SELECT sensitivity FROM l1_fts WHERE record_id = ?").get(id) as
    | { sensitivity: string | null }
    | undefined;
  return row ? row.sensitivity : null;
};

describe("A 项 · /v3/atomic/sensitivity 分发级（封闭清单 → handler → 真库）", () => {
  it("① 过清单并真降敏：200 + 主表/l1_fts 同步 none + memory_audit 记 sensitivity", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("ws1", "finance"), undefined);
      expect(sensOfMain(store, "ws1")).toBe("finance");

      const res = await post("/v3/atomic/sensitivity", store, { id: "ws1", sensitivity: "none", expect: "finance", reason: "用户复核为普通信息" });

      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      expect(res.body?.data).toMatchObject({ id: "ws1", sensitivity: "none", previous: "finance", sensitivity_source: "manual" });
      // 端到端：读的是真库，不是回执里报了个数（FTS 副本漏写 = 召回层仍按 finance 拦截）
      expect(sensOfMain(store, "ws1")).toBe("none");
      expect(sensOfFts(store, "ws1")).toBe("none");

      const audit = dbOf(store)
        .prepare("SELECT action, layer FROM memory_audit WHERE record_id = ? ORDER BY updated_at_ms DESC")
        .all("ws1") as { action: string; layer: string }[];
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0]).toMatchObject({ action: "sensitivity", layer: "L1" });
    } finally {
      cleanup();
    }
  });

  it("② 补登生效：/v3/atomic/importance 不再是 404（面板调级恢复可用）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("ws2", "none"), undefined);
      const res = await post("/v3/atomic/importance", store, { id: "ws2", importance: 8 });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  it("③ 清单没有被放开：未登记的 /v3/atomic/not-a-real-route 仍 404", async () => {
    const { store, cleanup } = makeStore();
    try {
      const res = await post("/v3/atomic/not-a-real-route", store, {});
      // 封闭清单在分发层拦下：handleV2Route 返回 false 且不写响应（HTTP 404 由 server.ts 补）
      expect(res.dispatched).toBe(false);
      expect(res.status).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("④ CAS 在分发级同样生效：expect 不符 → 409，库里保持原值", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("ws3", "health"), undefined);
      const res = await post("/v3/atomic/sensitivity", store, { id: "ws3", sensitivity: "none", expect: "finance" });
      expect(res.status).toBe(409);
      expect(sensOfMain(store, "ws3")).toBe("health");
    } finally {
      cleanup();
    }
  });

  it("⑤ 枚举外取值（unclassified/NONE）→ 400，不写库", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("ws4", "finance"), undefined);
      for (const bad of ["unclassified", "NONE", ""]) {
        const res = await post("/v3/atomic/sensitivity", store, { id: "ws4", sensitivity: bad, expect: "finance" });
        expect(res.status).toBe(400);
      }
      expect(sensOfMain(store, "ws4")).toBe("finance");
    } finally {
      cleanup();
    }
  });

  it("⑥ 缺 x-tdai-service-id → 401（DSH 唯一接入方式的命门不被绕过）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertL1(mkRecord("ws5", "finance"), undefined);
      const res = await post("/v3/atomic/sensitivity", store, { id: "ws5", sensitivity: "none", expect: "finance" }, { omitServiceId: true });
      expect(res.status).toBe(401);
      expect(sensOfMain(store, "ws5")).toBe("finance");
    } finally {
      cleanup();
    }
  });
});
