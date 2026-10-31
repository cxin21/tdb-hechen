/**
 * #127 · /v2/task/* 真链路（handleV2Route 真分发 + 临时 SQLite）source_type 三值契约。
 *
 * 为什么还测 v2：路由虽标 @deprecated，但仍是可调用面；契约必须与 v3 一致，
 * 否则「旧调用方传 github」在 v2 仍 400、v3 已 200 的割裂会留在生产里。
 *
 * 铁律（与 #40 套件同源）：临时库、真 handler，不触任何持久记忆库。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import type { V2RouterDeps } from "../v2-router.js";
import { VectorStore } from "../../core/store/sqlite.js";
import { parseConfig } from "../../config.js";

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

interface RawDb {
  prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): unknown };
}

function makeEnv(): { store: VectorStore; dataDir: string; raw: RawDb; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-src-db-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-src-data-"));
  const store = new VectorStore(path.join(dbDir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return {
    store,
    dataDir,
    raw: (store as unknown as { db: RawDb }).db,
    cleanup: () => {
      try {
        store.close();
        fs.rmSync(dbDir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch { /* 无害 */ }
    },
  };
}

async function post(
  env: { store: VectorStore; dataDir: string },
  urlPath: string,
  body: Record<string, unknown>,
): Promise<Captured> {
  const captured: Captured = {};
  const req = {
    headers: {
      authorization: "Bearer test-key",
      "x-tdai-service-id": "default",
      "x-tdai-team-id": "default",
      "x-tdai-user-id": "u1",
      "x-tdai-agent-id": "a1",
      "x-tdai-session-id": "sk-task-src",
    } as Record<string, string>,
  } as unknown as http.IncomingMessage;
  const deps = {
    getStore: () => env.store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    getDataDir: () => env.dataDir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "standalone" as const,
    config: { memory: parseConfig({}) },
  } as unknown as V2RouterDeps;
  const handled = await handleV2Route(
    req,
    {} as http.ServerResponse,
    urlPath,
    "POST",
    (async () => body) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, resBody) => {
      captured.status = status;
      captured.body = resBody as Captured["body"];
    },
    deps,
  );
  expect(handled).toBe(true);
  return captured;
}

describe("#127 /v2/task/* · source_type 三值契约（真链路）", () => {
  it("写旧值 github → 200 且落库就是 external（写边界归一，不回写四值）", async () => {
    const env = makeEnv();
    try {
      const res = await post(env, "/v2/task/create", {
        team_id: "default",
        creator_user_id: "u1",
        title: "来自 github 的任务",
        source_type: "github",
      });
      expect(res.status).toBe(200);
      const data = res.body?.data as { task_id: string; source_type: string };
      expect(data.source_type).toBe("external");
      const row = env.raw.prepare("SELECT source_type FROM entity_tasks WHERE task_id = ?").get(data.task_id);
      expect(row?.source_type).toBe("external");
    } finally {
      env.cleanup();
    }
  });

  it("写新值 external 原样通过；update 传旧值 tapd 同样归一", async () => {
    const env = makeEnv();
    try {
      const created = await post(env, "/v2/task/create", {
        team_id: "default",
        creator_user_id: "u1",
        title: "手工任务",
        source_type: "external",
      });
      expect(created.status).toBe(200);
      const taskId = (created.body?.data as { task_id: string }).task_id;
      expect((created.body?.data as { source_type: string }).source_type).toBe("external");

      const updated = await post(env, "/v2/task/update", { task_id: taskId, source_type: "tapd" });
      expect(updated.status).toBe(200);
      expect((updated.body?.data as { source_type: string }).source_type).toBe("external");
      expect(env.raw.prepare("SELECT source_type FROM entity_tasks WHERE task_id = ?").get(taskId)?.source_type).toBe("external");
    } finally {
      env.cleanup();
    }
  });

  it("非法值 → 400，且不落行", async () => {
    const env = makeEnv();
    try {
      const before = env.raw.prepare("SELECT COUNT(*) AS n FROM entity_tasks").get()?.n;
      const res = await post(env, "/v2/task/create", {
        team_id: "default",
        creator_user_id: "u1",
        title: "非法来源",
        source_type: "bogus",
      });
      expect(res.status).toBe(400);
      expect(env.raw.prepare("SELECT COUNT(*) AS n FROM entity_tasks").get()?.n).toBe(before);
    } finally {
      env.cleanup();
    }
  });

  it("历史行读回归一：库里残留 'github'/'tapd' → getTask 读出 external（读侧 fail-safe）", async () => {
    const env = makeEnv();
    try {
      const created = await post(env, "/v2/task/create", {
        team_id: "default",
        creator_user_id: "u1",
        title: "历史数据",
      });
      const taskId = (created.body?.data as { task_id: string }).task_id;
      for (const legacy of ["github", "tapd"]) {
        // 模拟历史数据（绕过写边界直接改库）
        env.raw.prepare("UPDATE entity_tasks SET source_type = ? WHERE task_id = ?").run(legacy, taskId);
        const got = await post(env, "/v2/task/get", { task_id: taskId });
        expect(got.status).toBe(200);
        expect((got.body?.data as { source_type: string }).source_type).toBe("external");
      }
      // 脏数据不炸：未知值读成 other（不把非法值漏给 Panel）
      env.raw.prepare("UPDATE entity_tasks SET source_type = ? WHERE task_id = ?").run("legacy_weird", taskId);
      const dirty = await post(env, "/v2/task/get", { task_id: taskId });
      expect(dirty.status).toBe(200);
      expect((dirty.body?.data as { source_type: string }).source_type).toBe("other");
    } finally {
      env.cleanup();
    }
  });
});
