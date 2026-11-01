/**
 * Wave 3 补锚：`/v3/core-memory/values/{derive,discover}` 的端到端覆盖。
 *
 * 背景：`MemoryCore/scripts/verify-c2.ts` 是 `/core-memory/values/derive` 唯一的端到端
 * 自动化覆盖，Wave 2B（ADR-0020，MemoryProxy 退场）把它随跨包脚本一并删除，留下
 * 「价值方向重判链路无人守」的缺口。本套件按同一 seam 重建：真临时 SQLite + 真
 * handleV2Route 分发 + 真 handler + 真 store SQL，只有 LLM runner 与 embedding 是 stub。
 *
 * 合同：
 *   1. derive 真链路：今天快照 → 置 NULL → 判定 → 写回 → 读回 valence（端到端断言，
 *      不是只看返回值）；
 *   2. derive 的三值枚举与幻觉 id 防御：非法枚举 / 清单外 id 一律不写，且走 restore
 *      后原值不丢（R3：降级可见且无害）；
 *   3. discover **全程只读**：返回提案但不落库（K1 信任边界），已有锚不被改写；
 *   4. 无 runner 时两个端点都 503 且消息明示（R3：不静默伪装成"无提议/无方向"）；
 *   5. 缺 x-tdai-service-id → 401（DSH 唯一接入方式的命门，不许被"收窄对外面"误删）。
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

const TENANT = { teamId: "default", userId: "u1", agentId: "a1" };

interface Captured {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

interface RunnerStub {
  run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number }): Promise<string>;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeStore(): { store: VectorStore; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "values-wire-db-"));
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

async function postValues(opts: {
  path: string;
  store: VectorStore;
  runner?: RunnerStub;
  omitServiceId?: boolean;
}): Promise<Captured> {
  const captured: Captured = {};
  const headers: Record<string, string | string[] | undefined> = {
    authorization: "Bearer test-key",
    "x-tdai-team-id": TENANT.teamId,
    "x-tdai-user-id": TENANT.userId,
    "x-tdai-agent-id": TENANT.agentId,
    "x-tdai-session-id": "values-wire",
  };
  if (!opts.omitServiceId) headers["x-tdai-service-id"] = "default";
  const req = { headers } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const deps = {
    getStore: () => opts.store,
    // resolveStoreForRequest 要求 getEmbedding 存在（真链路依赖注入点，不是可选）
    getEmbedding: () => ({ embed: async () => new Float32Array(8).fill(0.01) } as unknown as EmbeddingService),
    getStorage: () => undefined,
    getValueValenceLlmRunner: async () => opts.runner,
    requestIsolation: { ...TENANT, sessionId: "values-wire" },
    logger: noopLogger,
    deployMode: "standalone" as const,
    config: { memory: {} },
  } as unknown as V2RouterDeps;
  await handleV2Route(
    req,
    res,
    opts.path,
    "POST",
    (async () => ({})) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, body) => {
      captured.status = status;
      captured.body = body as Captured["body"];
    },
    deps,
  );
  return captured;
}

/** 按 label 读回 valence（真读库，不走 handler 返回值）。 */
function valenceOf(store: VectorStore, label: string): number | null | undefined {
  const row = store.listValues(TENANT).find((v) => v.label === label);
  return row ? row.valence : undefined;
}

describe("Wave 3 · /v3/core-memory/values/derive 端到端（替代已删的 verify-c2.ts）", () => {
  it("① 真链路：重置 → LLM 判定 → 写回，读回的 valence 是新值", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertValue("val-correct", "正确", 0.5, "manual", TENANT);
      store.upsertValue("val-safety", "安全", 0.4, "manual", TENANT);
      expect(valenceOf(store, "正确")).toBeNull();
      expect(valenceOf(store, "安全")).toBeNull();

      const runner: RunnerStub = {
        run: async () =>
          JSON.stringify({
            valences: [
              { value_id: "val-correct", valence: 1 },
              { value_id: "val-safety", valence: -1 },
            ],
          }),
      };
      const res = await postValues({ path: "/v3/core-memory/values/derive", store, runner });

      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      expect(res.body?.data).toEqual({ derived: 2, skipped: 0 });
      // 端到端：写的是真库，不是返回值里报了个数
      expect(valenceOf(store, "正确")).toBe(1);
      expect(valenceOf(store, "安全")).toBe(-1);
    } finally {
      cleanup();
    }
  });

  // ②-a：三值枚举外 / 清单外（幻觉）id 一律拒写 —— 行保持 NULL（R3 宁缺毋滥）。
  // 注意本路由是**重判入口**：handleCoreMemoryValuesDerive 先 resetValueValences 把该租户
  // active 行全部置 NULL 快照，再判定，失败行由 restoreValueValences 恢复；因此「原本已判定」
  // 的行也会进入判定清单（语义：重判），其不被覆盖的保护在 store 层的
  // `AND (valence IS NULL)` 写回守卫，而不是本路由。
  it("②-a 三值枚举外 / 清单外 id 一律不写（行保持 NULL）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertValue("val-a", "可靠", 0.5, "manual", TENANT);
      const runner: RunnerStub = {
        run: async () =>
          JSON.stringify({
            valences: [
              { value_id: "val-a", valence: 7 }, // 枚举外
              { value_id: "val-ghost", valence: 1 }, // 幻觉 id
            ],
          }),
      };
      const res = await postValues({ path: "/v3/core-memory/values/derive", store, runner });

      expect(res.status).toBe(200);
      expect(res.body?.data).toEqual({ derived: 0, skipped: 1 });
      expect(valenceOf(store, "可靠")).toBeNull();
    } finally {
      cleanup();
    }
  });

  // ②-b：apply-after-success 的回滚面 —— LLM 返回不可解析时，reset 掉的旧方向必须由快照恢复，
  // 不能变成 NULL 永久丢弃用户/历史判定（Important-1 的回归锚）。
  it("②-b LLM 输出不可解析 ⇒ 快照恢复原方向，已判定行不被清成 NULL", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertValue("val-a", "可靠", 0.5, "manual", TENANT);
      store.upsertValue("val-b", "已判定锚", 0.5, "manual", TENANT, 0);
      const runner: RunnerStub = {
        run: async () => "抱歉，我无法判断。", // 非 JSON ⇒ 解析失败，derived=0
      };
      const res = await postValues({ path: "/v3/core-memory/values/derive", store, runner });

      expect(res.status).toBe(200);
      expect(res.body?.data).toEqual({ derived: 0, skipped: 2 });
      // 旧方向回来了（不是变 NULL），原本就 NULL 的行仍是 NULL
      expect(valenceOf(store, "已判定锚")).toBe(0);
      expect(valenceOf(store, "可靠")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("③ 无 runner ⇒ 503 且消息明示（R3：不静默）", async () => {
    const { store, cleanup } = makeStore();
    try {
      store.upsertValue("val-x", "透明", 0.5, "manual", TENANT);
      const res = await postValues({ path: "/v3/core-memory/values/derive", store });
      expect(res.status).toBe(503);
      expect(res.body?.code).toBe(503);
      expect(String(res.body?.message)).toContain("LLM runner not available");
      // 降级可见且无害：行仍是 NULL，没有被重置
      expect(valenceOf(store, "透明")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("④ 缺 x-tdai-service-id ⇒ 401（DSH 接入命门，非兼容层）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const res = await postValues({ path: "/v3/core-memory/values/derive", store, omitServiceId: true });
      expect(res.status).toBe(401);
      expect(String(res.body?.message)).toContain("x-tdai-service-id");
    } finally {
      cleanup();
    }
  });
});

describe("Wave 3 · /v3/core-memory/values/discover 全程只读（K1 信任边界）", () => {
  it("⑤ 返回提案但不落库：既有锚一字不改，提案数不写库", async () => {
    const { store, cleanup } = makeStore();
    try {
      const rowCountBefore = store.listValues(TENANT).length;
      const runner: RunnerStub = {
        run: async () =>
          JSON.stringify([
            { label: "务实", node_type: "theme", evidence_ids: ["ev-1", "ev-2", "ev-3"], rationale: "多次出现" },
          ]),
      };
      const res = await postValues({ path: "/v3/core-memory/values/discover", store, runner });

      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      const data = res.body?.data as { proposals?: unknown[]; sampleSize?: number } | undefined;
      expect(Array.isArray(data?.proposals)).toBe(true);
      expect(store.listValues(TENANT).length).toBe(rowCountBefore); // 零落库
    } finally {
      cleanup();
    }
  });

  it("⑥ 无 runner ⇒ 503（不伪装成无提议）", async () => {
    const { store, cleanup } = makeStore();
    try {
      const res = await postValues({ path: "/v3/core-memory/values/discover", store });
      expect(res.status).toBe(503);
      expect(String(res.body?.message)).toContain("LLM runner not available");
    } finally {
      cleanup();
    }
  });
});
