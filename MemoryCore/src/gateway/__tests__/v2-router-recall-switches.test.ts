/**
 * V2 批 2（I2 修补）· 工具路开关透传 RED 套件 —— v2-router handleAtomicSearch → executeMemorySearch。
 *
 * 修补前缺陷：handleAtomicSearch 不透传 exploreSlot / rerankWeights / queryExpansion config
 * → executeMemorySearch 缺省（exploreSlot=true / 权重均等 1/1/1 / 引擎一退出）恒生效，
 * config 关断在工具路被静默忽略（关断矩阵在工具路不成立——批 2 审查 I2 实锤）。
 *
 * 断言契约（brief 逐字）：config 关断 → 工具路行为与基线一致；config 开启 → 引擎行为可见。
 * 引擎一用本地 OpenAI 兼容 mock server（零外网；runner 链真实走到 StandaloneLLMRunner）。
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleAtomicSearch } from "../v2-router.js";
import type { IMemoryStore, L1FtsResult } from "../../core/store/types.js";

const KW = "V2SW";

const ftsRow = (id: string, over: Partial<L1FtsResult> = {}): L1FtsResult => ({
  record_id: id,
  content: `${KW} 记忆条目 ${id}`,
  type: "episodic",
  priority: 0,
  scene_name: "",
  score: 0.5,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  version: 1,
  session_key: "sk",
  session_id: "s",
  team_id: "t",
  task_id: "",
  user_id: "u",
  agent_id: "a",
  metadata_json: "",
  ...over,
});

function routerStore(opts: {
  rows: L1FtsResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  neighborRows?: L1FtsResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    // 词面过滤（模拟真实 FTS MATCH 语义）：MATCH 表达式 "a" OR "b" → content 含任一 token 的行
    searchL1Fts: (async (ftsQuery: string) => {
      const tokens = String(ftsQuery).split(" OR ").map((t) => t.replaceAll('"', "").trim()).filter(Boolean);
      return opts.rows.filter((r) => tokens.some((tok) => r.content.includes(tok)));
    }) as unknown as IMemoryStore["searchL1Fts"],
    getNeighbors: () => opts.neighbors ?? [],
    getL1ByIdsWithArchive: (ids: string[]) => (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

/** 基线参数 = 候选池通道关 + R-A1 六信号全 0（与 verify-v2-* 的 ALL_OFF 同口径）。 */
const ALL_OFF = {
  coreRefBoost: 0,
  timeBoost: 0,
  recencyBoost: 0,
  sigWeight: 0,
  inferredPenalty: 0,
  reinforcementWeight: 0,
  moodBoost: 0,
  graphDiscount: 0,
  sceneBoost: 0,
} as const;

type RecallCfg = Record<string, unknown>;

function makeDeps(store: IMemoryStore, recall: RecallCfg, llm?: unknown) {
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    deployMode: "standalone" as const,
    config: { memory: { recall, ...(llm !== undefined ? { llm } : {}) } },
  } as unknown as Parameters<typeof handleAtomicSearch>[3];
}

async function search(deps: Parameters<typeof handleAtomicSearch>[3], limit = 3, query = KW): Promise<string[]> {
  const env = await handleAtomicSearch(
    { query, limit },
    { apiKey: "test-key", serviceId: "test" } as never,
    "req-test-v2sw",
    deps,
  );
  expect(env.code).toBe(0);
  return ((env.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
}

// ── 引擎一 mock LLM（本地 OpenAI 兼容 /chat/completions，零外网）──
let server: Server | undefined;
let mockBaseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404).end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-v2sw",
          object: "chat.completion",
          created: 0,
          model: "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: '["覆盖率","红牌"]' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  mockBaseUrl = `http://127.0.0.1:${port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const MOCK_LLM = () => ({ enabled: true, baseUrl: mockBaseUrl, apiKey: "test-key", model: "mock-model", timeoutMs: 10_000 });

describe("V2 批 2 I2：工具路（/v3/atomic/search）引擎开关 config 透传", () => {
  it("引擎三 exploreSlot：config false → 探索位退出（基线逐位）；config true → [graph:ppr] 候选占末席", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) =>
      ftsRow(id, { metadata_json: JSON.stringify({ recall_count: 10 }) }),
    );
    const storeOpts = {
      rows,
      neighbors: [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
      neighborRows: [ftsRow("n1", { content: "图邻居条目（不含关键词）", score: 0 })],
    };

    const off = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, graphDiscount: 0.6, graphMinStrength: 0.5, exploreSlot: false },
    ));
    expect(off).toEqual(["a", "b", "c"]);

    const on = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, graphDiscount: 0.6, graphMinStrength: 0.5, exploreSlot: true },
    ));
    expect(on).toEqual(["a", "b", "n1"]);
  });

  it("RV2-2 rerankWeights：config 全 0 → 关断恒等（基线序）；config significance → 高显著前移", async () => {
    const storeOpts = { rows: [ftsRow("a"), ftsRow("b", { significance: 0.9 })] };

    const off = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, rerankWeights: { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 } },
    ), 10);
    expect(off).toEqual(["a", "b"]);

    const on = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, rerankWeights: { relevance: 0, timeProx: 0, significance: 1, coreRef: 0 } },
    ), 10);
    expect(on).toEqual(["b", "a"]);
  });

  it("引擎一 queryExpansion：config enabled=false → 通道退出；enabled=true（mock LLM）→ 扩展词命中浮现", async () => {
    // 多 token query（单 token 在 2 行小库会触发 FTS 小文档集兜底返回全部行，污染 off 基线）
    const q = `${KW} 怎么提高全面性`;
    const storeOpts = {
      rows: [ftsRow("main", { content: `${KW} 主条目 全面性` }), ftsRow("exp", { content: "覆盖率 红牌 矩阵条目" })],
    };

    const off = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, queryExpansion: { enabled: false, maxTerms: 8, ttlMs: 0, timeoutMs: 8000 } },
      MOCK_LLM(),
    ), 10, q);
    expect(off.some((id) => id === "exp")).toBe(false);

    const on = await search(makeDeps(
      routerStore(storeOpts),
      { ...ALL_OFF, queryExpansion: { enabled: true, maxTerms: 8, ttlMs: 0, timeoutMs: 10_000 } },
      MOCK_LLM(),
    ), 10, q);
    expect(on.some((id) => id === "exp")).toBe(true);
  });
});
