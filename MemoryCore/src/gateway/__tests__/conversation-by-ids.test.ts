/**
 * POST /v3/conversation/by-ids —— L1 行级溯源 source_message_ids 的「点开看原话」数据端。
 *
 * 合同（照 ADR-0025 行级溯源口径）：
 *   1. 真链路：真临时 SQLite + 真 handleV2Route 分发 + 真 handler + 真 store SQL，
 *      按 L0 record_id 批量回读原话，字段逐位映射（content=message_text / timestamp=recorded_at）；
 *   2. 租户纵深：team/user/agent/task 四轴收窄，跨租户 id **静默不返回**（不报错、不泄露存在性）；
 *   3. ids 上限 100：超限 400，不触库；
 *   4. 空数组：200 + items:[]（store 层同样不拼 SQL）；
 *   5. 含不存在 id：只返回存在的，缺失 id 静默跳过；
 *   6. ids 归一（trim/去空/去重保序）是纯函数，单独钉住；
 *   7. 面板 BFF 实际把租户字段放 body（asset owner 四轴），故另钉 body 优先解析。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import { normalizeConversationIds } from "../conversation-by-ids.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { L0Record } from "../../core/store/types.js";

const TENANT = { teamId: "default", userId: "u1", agentId: "a1", taskId: "task-1" };
const PATH = "/v3/conversation/by-ids";

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-by-ids-db-"));
  const store = new VectorStore(path.join(dbDir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    cleanup: () => {
      try {
        store.close();
        fs.rmSync(dbDir, { recursive: true, force: true });
      } catch {
        /* 无害 */
      }
    },
  };
}

function seed(store: VectorStore, over: Partial<L0Record> & { id: string }): void {
  const rec: L0Record = {
    id: over.id,
    sessionKey: over.sessionKey ?? "sess-1",
    sessionId: over.sessionId ?? "sess-1",
    teamId: over.teamId ?? TENANT.teamId,
    userId: over.userId ?? TENANT.userId,
    agentId: over.agentId ?? TENANT.agentId,
    taskId: over.taskId ?? TENANT.taskId,
    role: over.role ?? "user",
    messageText: over.messageText ?? `内容-${over.id}`,
    recordedAt: over.recordedAt ?? "2026-11-04T01:00:00.000Z",
    timestamp: over.timestamp ?? 1762218000000,
  };
  const ok = store.upsertL0(rec, undefined);
  expect(ok).toBe(true);
}

async function postByIds(store: VectorStore, ids: unknown, opts: { tenant?: typeof TENANT } = {}): Promise<Captured> {
  const tenant = opts.tenant ?? TENANT;
  const captured: Captured = {};
  const headers: Record<string, string> = {
    authorization: "Bearer test-key",
    "x-tdai-team-id": tenant.teamId,
    "x-tdai-user-id": tenant.userId,
    "x-tdai-agent-id": tenant.agentId,
    "x-tdai-session-id": "conv-by-ids",
    "x-tdai-service-id": "default",
  };
  // task 是可选收窄轴（与 handleConversationQuery 同口径）：显式声明才过滤。
  if (tenant.taskId) headers["x-tdai-task-id"] = tenant.taskId;
  const req = { headers } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const deps = {
    getStore: () => store,
    getEmbedding: () => ({ embed: async () => new Float32Array(8).fill(0.01) }) as unknown as EmbeddingService,
    getStorage: () => undefined,
    requestIsolation: { ...tenant, sessionId: "conv-by-ids" },
    logger: noopLogger,
    deployMode: "standalone" as const,
    config: { memory: {} },
  } as unknown as V2RouterDeps;
  await handleV2Route(
    req,
    res,
    PATH,
    "POST",
    (async () => ({ ids })) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, body) => {
      captured.status = status;
      captured.body = body as Captured["body"];
    },
    deps,
  );
  return captured;
}

describe("POST /v3/conversation/by-ids · 真库往返", () => {
  it("① 正常往返：按 id 回读原话，字段逐位映射且保留换行", async () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "m1", role: "user", messageText: "第一行\n第二行", timestamp: 1762218000000 });
      seed(store, {
        id: "m2",
        role: "assistant",
        messageText: "回答内容",
        sessionKey: "sess-2",
        sessionId: "sess-2",
        recordedAt: "2026-11-04T01:01:00.000Z",
        timestamp: 1762218060000,
      });
      seed(store, { id: "m3", role: "user", messageText: "第三条", timestamp: 1762218120000 });

      const res = await postByIds(store, ["m1", "m3"]);
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      const items = (res.body?.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        id: "m1",
        role: "user",
        content: "第一行\n第二行",
        timestamp: "2026-11-04T01:00:00.000Z",
        session_key: "sess-1",
        session_id: "sess-1",
        team_id: TENANT.teamId,
        user_id: TENANT.userId,
        agent_id: TENANT.agentId,
        task_id: TENANT.taskId,
      });
      expect(items[1]?.id).toBe("m3");
    } finally {
      cleanup();
    }
  });

  it("② ids 归一：重复 id 只回一条（不重复出参）", async () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "m1", messageText: "唯一一条" });
      const res = await postByIds(store, ["m1", " m1 ", "m1"]);
      expect(res.status).toBe(200);
      const items = (res.body?.data as { items?: unknown[] })?.items ?? [];
      expect(items).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe("POST /v3/conversation/by-ids · 租户纵深", () => {
  it("③ 跨租户不可见：别 team / 别 user / 别 agent 的 id 静默不返回", async () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "own", messageText: "本租户" });
      seed(store, { id: "other-team", teamId: "team-x" });
      seed(store, { id: "other-user", userId: "u2" });
      seed(store, { id: "other-agent", agentId: "a2" });
      seed(store, { id: "other-task", taskId: "task-2" });

      const res = await postByIds(store, ["own", "other-team", "other-user", "other-agent", "other-task"]);
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      const items = (res.body?.data as { items?: Array<{ id: string }> })?.items ?? [];
      expect(items.map((x) => x.id)).toEqual(["own"]);
    } finally {
      cleanup();
    }
  });
});

describe("POST /v3/conversation/by-ids · 入参边界", () => {
  it("④ ids 超 100：400 拒绝（不触库）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      const res = await postByIds(store, ids);
      expect(res.status).toBe(400);
      expect(res.body?.code).toBe(400);
      expect(String(res.body?.message)).toContain("ids");
    } finally {
      cleanup();
    }
  });

  it("⑤ 空数组：200 + items:[]（批量零条是合法读，不报错）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const res = await postByIds(store, []);
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      expect((res.body?.data as { items?: unknown[] })?.items).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("⑥ 含不存在 id：只返回存在的，缺失静默跳过（不泄露存在性）", async () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "m1", messageText: "存在" });
      const res = await postByIds(store, ["m1", "ghost-1", "ghost-2"]);
      expect(res.status).toBe(200);
      const items = (res.body?.data as { items?: Array<{ id: string }> })?.items ?? [];
      expect(items.map((x) => x.id)).toEqual(["m1"]);
    } finally {
      cleanup();
    }
  });

  it("⑦ store 不支持 queryL0ByIds：503 明示不支持（不静默伪装成空结果）", async () => {
    const captured: Captured = {};
    const deps = {
      getStore: () => ({}),
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      requestIsolation: { ...TENANT, sessionId: "conv-by-ids" },
      logger: noopLogger,
      deployMode: "standalone" as const,
      config: { memory: {} },
    } as unknown as V2RouterDeps;
    await handleV2Route(
      {
        headers: {
          authorization: "Bearer test-key",
          "x-tdai-team-id": TENANT.teamId,
          "x-tdai-user-id": TENANT.userId,
          "x-tdai-agent-id": TENANT.agentId,
          "x-tdai-session-id": "conv-by-ids",
          "x-tdai-service-id": "default",
        },
      } as unknown as http.IncomingMessage,
      {} as http.ServerResponse,
      PATH,
      "POST",
      (async () => ({ ids: ["m1"] })) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
      (_res, status, body) => {
        captured.status = status;
        captured.body = body as Captured["body"];
      },
      deps,
    );
    expect(captured.status).toBe(503);
    expect(String(captured.body?.message)).toContain("queryL0ByIds");
  });

  it("⑧ 面板 BFF 口径：租户字段走 body（无 x-tdai-* 租户头）同样四轴收窄", async () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "own" });
      seed(store, { id: "other-team", teamId: "team-x" });
      const captured: Captured = {};
      await handleV2Route(
        {
          headers: {
            authorization: "Bearer test-key",
            "x-tdai-service-id": "default",
          },
        } as unknown as http.IncomingMessage,
        {} as http.ServerResponse,
        PATH,
        "POST",
        (async () => ({
          team_id: TENANT.teamId,
          user_id: TENANT.userId,
          agent_id: TENANT.agentId,
          session_id: "default",
          ids: ["own", "other-team"],
        })) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
        (_res, status, body) => {
          captured.status = status;
          captured.body = body as Captured["body"];
        },
        {
          getStore: () => store,
          getEmbedding: () => undefined,
          getStorage: () => undefined,
          logger: noopLogger,
          deployMode: "standalone" as const,
          config: { memory: {} },
        } as unknown as V2RouterDeps,
      );
      expect(captured.status).toBe(200);
      const items = (captured.body?.data?.items ?? []) as Array<{ id: string }>;
      expect(items.map((x) => x.id)).toEqual(["own"]);
    } finally {
      cleanup();
    }
  });
});

describe("normalizeConversationIds（纯函数）", () => {
  it("trim + 丢弃空串/非字符串 + 去重保序", () => {
    expect(normalizeConversationIds([" a ", "", "b", "a", 42, null, "  ", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeConversationIds([])).toEqual([]);
  });
});

describe("VectorStore.queryL0ByIds（store 层合同）", () => {
  it("空数组直接返回 []（不拼 SQL、不抛）", () => {
    const { store, cleanup } = makeStore();
    try {
      expect(store.queryL0ByIds([], { ...TENANT })).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("四轴过滤：只回本租户行，顺序按 timestamp 升序", () => {
    const { store, cleanup } = makeStore();
    try {
      seed(store, { id: "b", timestamp: 2000 });
      seed(store, { id: "a", timestamp: 1000 });
      seed(store, { id: "x", userId: "u2", timestamp: 1500 });
      const rows = store.queryL0ByIds(["b", "a", "x"], { ...TENANT });
      expect(rows.map((r) => r.record_id)).toEqual(["a", "b"]);
    } finally {
      cleanup();
    }
  });
});
