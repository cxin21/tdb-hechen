/**
 * #40（ADR0003-P3 接线票 B）· /v3/recall capabilities 数据源接线 · 端点套件。
 *
 * 合同（#40 票面验收 1/2/3 + #32 渲染一致性）：
 *   - config 门（coreMemory.soulRender.capabilities.enabled）关（缺省）→ body.capabilities
 *     被整链丢弃：block 与不带 capabilities 字段的请求逐位一致（逐位现状 golden）；
 *   - 门开 → 「## 我能做什么」段渲染行 = 清洗后策展清单 1:1（顺序保持，`- ` 前缀，
 *     soul-assembler 零派生直出）；
 *   - body 清洗（路由层防御）：非 string/空白项过滤、trim、上限 10（宁缺毋滥）。
 *
 * 铁律：真链路（临时 SQLite + handleV2Route 真分发 + upsertCore 播种 strict_rule——
 * 身份段外门 slots.length>0 才渲染，soul-assembler.ts:290）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { handleV2Route } from "../v2-router.js";
import { parseConfig, type MemoryTdaiConfig } from "../../config.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { V2RouterDeps } from "../v2-router.js";

const QUERY = "CAPABILITYWIRING 策展能力接线验证";
/** 播种内容（身份段外门需要 ≥1 slot；红线原文与生产同源形态，仅作渲染载体）。 */
const STRICT_RULE = "零删除、零注入（P1 红线）——测试种子仅入临时 SQLite，不触任何持久记忆库。";
const CAPS = ["代码检索：跨仓符号定位", "记忆召回：L1/L2 分层"];

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

function makeEnv(): { store: VectorStore; dataDir: string; cleanup: () => void } {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "capwire-db-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capwire-data-"));
  const store = new VectorStore(path.join(dbDir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  // 身份段外门（soul-assembler.ts:290 slots.length>0）——播种 strict_rule（临时库，非生产记忆库）。
  store.upsertCore("strict_rule", STRICT_RULE, "manual", { teamId: "default", userId: "u1", agentId: "a1" });
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

function recallCfg(capabilitiesEnabled: boolean): MemoryTdaiConfig {
  return parseConfig({
    recall: { ...RECALL_OFF, v3Recall: { enabled: true, timeoutMs: 5000 } },
    ...(capabilitiesEnabled ? { coreMemory: { soulRender: { capabilities: { enabled: true } } } } : {}),
  });
}

interface CapturedResponse {
  status?: number;
  body?: { code: number; message: string; data?: Record<string, unknown> };
}

async function postRecall(opts: {
  cfg: MemoryTdaiConfig;
  store: VectorStore;
  dataDir: string;
  sessionId: string;
  capabilities?: unknown;
}): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
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
    "/v3/recall",
    "POST",
    (async () => ({
      query: QUERY,
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    })) as unknown as <T>(req: http.IncomingMessage) => Promise<T>,
    (_res, status, body) => {
      captured.status = status;
      captured.body = body as CapturedResponse["body"];
    },
    deps,
  );
  if (!handled) return { status: undefined, body: undefined };
  return captured;
}

function blockOf(res: CapturedResponse): string {
  expect(res.status).toBe(200);
  const data = res.body?.data as { block: string } | undefined;
  return typeof data?.block === "string" ? data.block : "";
}

describe("#40 · /v3/recall capabilities 数据源接线", () => {
  it("验收2 · 门开 + body.capabilities → 「## 我能做什么」渲染行 = 策展清单 1:1（顺序保持）", async () => {
    const env = makeEnv();
    try {
      const res = await postRecall({
        cfg: recallCfg(true),
        store: env.store,
        dataDir: env.dataDir,
        sessionId: "sk-cap-on",
        capabilities: CAPS,
      });
      const block = blockOf(res);
      expect(block).toContain("## 我能做什么");
      const capIdx = block.indexOf("## 我能做什么");
      expect(block.slice(capIdx)).toContain("- 代码检索：跨仓符号定位");
      expect(block.slice(capIdx)).toContain("- 记忆召回：L1/L2 分层");
      expect(block.indexOf("代码检索：跨仓符号定位")).toBeLessThan(block.indexOf("记忆召回：L1/L2 分层"));
    } finally {
      env.cleanup();
    }
  });

  it("验收1 · 门关（缺省）→ body.capabilities 整链丢弃：与不带字段请求 block 逐位一致", async () => {
    const env = makeEnv();
    try {
      // 两个请求同 cfg（门关）、同 query、不同 session（避开会话复用缓存交叉）。
      const withField = await postRecall({
        cfg: recallCfg(false),
        store: env.store,
        dataDir: env.dataDir,
        sessionId: "sk-cap-off-a",
        capabilities: CAPS,
      });
      const withoutField = await postRecall({
        cfg: recallCfg(false),
        store: env.store,
        dataDir: env.dataDir,
        sessionId: "sk-cap-off-b",
      });
      const b1 = blockOf(withField);
      const b2 = blockOf(withoutField);
      expect(b1).toBe(b2);
      expect(b1).not.toContain("## 我能做什么");
    } finally {
      env.cleanup();
    }
  });

  it("验收3 · body 清洗：非 string/空白项过滤 + trim + 上限 10（清洗后 11 项 → 第 10 项被丢弃）", async () => {
    const env = makeEnv();
    try {
      // 6 个垃圾项（过滤）+ 1 个 trim 项 + 10 个有效项 = 清洗后 11 项 → clamp 10
      // 保留前 10（独行裁断 + 第1..9 项），第 10 项被丢弃。（审查 M-5 订正注释计数）
      const ten = Array.from({ length: 10 }, (_, i) => `第${i + 1}项能力`);
      const res = await postRecall({
        cfg: recallCfg(true),
        store: env.store,
        dataDir: env.dataDir,
        sessionId: "sk-cap-clean",
        capabilities: ["  独行裁断：权柄在握  ", "", 42, null, true, {}, [], ...ten],
      });
      const block = blockOf(res);
      expect(block).toContain("- 独行裁断：权柄在握"); // trim 生效
      expect(block).not.toContain("第10项能力"); // clamp 10：清洗后第 11 项（即第10项能力）丢弃
      for (let i = 1; i <= 9; i++) {
        expect(block).toContain(`- 第${i}项能力`);
      }
    } finally {
      env.cleanup();
    }
  });

  it("M-1 · 内部换行折叠：直连传 \"a\\nb\" → 清洗为 \"a b\"（渲染不破行、指纹不与 [\"a\",\"b\"] 碰撞）", async () => {
    const env = makeEnv();
    try {
      const res = await postRecall({
        cfg: recallCfg(true),
        store: env.store,
        dataDir: env.dataDir,
        sessionId: "sk-cap-nl",
        capabilities: ["跨行能力：第一段\n第二段", "普通能力"],
      });
      const block = blockOf(res);
      const capIdx = block.indexOf("## 我能做什么");
      expect(capIdx).toBeGreaterThanOrEqual(0);
      expect(block.slice(capIdx)).toContain("- 跨行能力：第一段 第二段"); // 换行→空格
      expect(block.slice(capIdx)).not.toContain("第一段\n第二段"); // 无内嵌换行
      expect(block.slice(capIdx)).toContain("- 普通能力");
    } finally {
      env.cleanup();
    }
  });
});
