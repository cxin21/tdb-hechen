/**
 * R71（2026-10-19，issue #71）：结论层相关性双门 + fts-only 注入帽测试套件。
 *
 * 接入点合同（docs/research/2026-10-19-r71-recall-relevance-design.md §4）：
 *  - A1 bm25 rel 预地板：work_fact 候选携带 raw rel（=-rank），低于
 *    recall.conclusionLayer.minBm25Rel 的候选在进选择器前剔除（0/undefined=off；
 *    后端未提供 rank 的行豁免——宁缺毋滥不误杀）；journal gates.conclusionBm25。
 *  - A2 rerank 语义门（主门）：选中结论（work_fact+scene）按注入行形态（去 "- " 前缀）
 *    统一 rerank，score < conclusionLayer.rerankGate.minScore（缺省 -1）者剔除；
 *    mode 缺省 "shadow"（只记录不过滤）；门在幂等指纹缓存写入之前；
 *    wiring 非 active / 熔断开 / provider null → 旁路不误杀（journal bypass 留痕）；
 *    provider 未覆盖的候选不杀（与经验层"绝不静默丢弃"垫尾语义一致）。
 *  - C fts-only 注入帽：recall.ftsOnlyInjectCap（缺省 2，0=off）——向量路死
 *    （ftsHits>0 ∧ embeddingHits=0 ∧ strategy≠keyword）时注入块（结论+经验合计）
 *    从尾部裁到帽内（结论优先保留）；counts 与实际注入行数对齐。
 *
 * 铁律：不碰检索层（九通道/绝对门槛/RRF/字典序）；只通过 performLayeredRecall 的
 * rerankDeps 注入 fake provider/breaker（DI seam），全链走 sqlite fallback 路径。
 * 不 mock 被测函数内部。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRerankBreaker,
  performLayeredRecall,
  resetRerankBreakerForTests,
} from "../auto-recall.js";
import type { MemoryReranker, RerankResult } from "../../recall/rerank/types.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

type PLRParams = Parameters<typeof performLayeredRecall>[0];
type RerankDeps = NonNullable<PLRParams["rerankDeps"]>;

const KW = "Rk2Probekw";

// ═══════════════ harness：行厂 / mock store / cfg / journal 读取 ═══════════════

function ftsRow(id: string, content: string, score: number, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score,
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
  };
}

/** work_fact 行厂：content 含 KW（textHit 命中源）+ 唯一 Concl 标记；rank=FTS5 raw（负=更相关）。 */
function wfRow(id: string, marker: string, rank: number | undefined): L1FtsResult {
  return ftsRow(id, KW + " " + marker + "：交付节奏承诺持续兑现，当前状态健康。", 0.99, {
    type: "work_fact",
    ...(rank !== undefined ? { rank } : {}),
  });
}

const MARKERS = ["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"] as const;
const PHRASES = [
  "交付节奏承诺：每周三同步部署窗口并回写验收结论",
  "用户偏好明细：回复保持中文简洁且先给结论再列证据",
  "项目风险台账：网关超时阈值放宽前必须回归三层门禁",
  "团队协作事实：评审意见合并前需两名维护者各自确认",
  "数据备份约定：快照保留三十天并在月末核对恢复演练",
] as const;

function episodicRows(n: number): L1FtsResult[] {
  const rows: L1FtsResult[] = [];
  for (let i = 0; i < n; i++) rows.push(ftsRow("rec-" + (i + 1), MARKERS[i] + "·" + PHRASES[i % PHRASES.length], 0.9));
  return rows;
}

/** sqlite fallback 形态 mock store：FTS 全量返回 rows（结论候选与经验层共用），向量恒空
 *  → searchTiming.ftsHits>0 ∧ embeddingHits=0（fts-only 降级态，C 帽触发前提）。 */
function fallbackStore(rows: L1FtsResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => rows.slice(0, k),
    searchL1Vector: async () => [],
  } as unknown as IMemoryStore;
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

function makeCfg(over: Record<string, unknown> = {}, rerank?: Record<string, unknown>): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      exploreSlot: false,
      rerankWeights: { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 },
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
      ...over,
      ...(rerank !== undefined ? { rerank } : {}),
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

/** 可编程 fake provider：脚本按调用序返回结果；记录 query 与 docs 供断言。 */
function scriptReranker(script: (call: number, query: string, docs: string[]) => RerankResult[] | null): {
  reranker: MemoryReranker;
  callCount(): number;
  docSets(): string[][];
} {
  let calls = 0;
  const docSets: string[][] = [];
  return {
    reranker: {
      rerank: async (query: string, docs: string[]) => {
        calls++;
        docSets.push([...docs]);
        return script(calls, query, docs);
      },
    },
    callCount: () => calls,
    docSets: () => docSets,
  };
}

/** marker → rerank score 表驱动 fake（按 docs 中 marker 位置造 index）。 */
function markerReranker(table: Array<[string, number]>) {
  return scriptReranker((_call, _q, docs) => {
    const out: RerankResult[] = [];
    docs.forEach((d, index) => {
      const hit = table.find(([m]) => d.includes(m));
      if (hit) out.push({ index, score: hit[1] });
    });
    return out.sort((a, b) => b.score - a.score);
  });
}

function paramsFor(dir: string, store: IMemoryStore, userText: string, cfg: MemoryTdaiConfig, opts?: { deps?: RerankDeps; sessionKey?: string }): PLRParams {
  return {
    userText,
    sessionKey: opts?.sessionKey ?? "", // 空 sessionKey → 复用缓存整体关断（每调用全新检索）
    cfg,
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: mockEmbedding(),
    ...(opts?.deps ? { rerankDeps: opts.deps } : {}),
  };
}

function readJournal(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, "logs", "recall", "recall-journal-default-default.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SILICONFLOW_RERANK = { enabled: true, provider: "siliconflow", apiKey: "test-key" };

beforeEach(() => {
  resetRerankBreakerForTests();
});

// ═══════════════ A1：bm25 rel 预地板 ═══════════════

describe("R71-A1 · work_fact 候选 bm25 rel 预地板", () => {
  it("①低于 minBm25Rel 的候选在选择器前剔除，journal gates.conclusionBm25 记 kept/dropped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a1-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -3), ...episodicRows(2)];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { minBm25Rel: 6.5 },
      })));
      // rel=3 的 ConclB 被地板剔除（结论通道）；rel=10 的 ConclA 保留。
      // 注意：wf-2 行仍可经经验层（普通 FTS 命中）注入——A1 地板只管结论通道，
      // 经验层有自己的 minScore/rerank 语义，故断言收窄到 [结论| 行。
      expect(res.conclusionCount).toBe(1);
      expect(res.memoryLines.some((l) => l.includes("[结论]") && l.includes("ConclA"))).toBe(true);
      expect(res.memoryLines.some((l) => l.includes("[结论]") && l.includes("ConclB"))).toBe(false);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionBm25 as Record<string, unknown> | undefined;
      expect(gate).toBeDefined();
      expect(gate?.minRel).toBe(6.5);
      expect(gate?.kept).toBe(1);
      expect(gate?.dropped).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②缺省（无 minBm25Rel）= off：两条全保留，journal 无 conclusionBm25 键", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a1off-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -3), ...episodicRows(2)];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({})));
      expect(res.conclusionCount).toBe(2);
      const entry = readJournal(dir).at(-1)!;
      expect((entry.gates as Record<string, unknown> | undefined)?.conclusionBm25).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③后端未提供 rank（行豁免）：地板不误杀，journal 不产 conclusionBm25 键", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a1nk-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", undefined), wfRow("wf-2", "ConclB", undefined), ...episodicRows(2)];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { minBm25Rel: 6.5 },
      })));
      expect(res.conclusionCount).toBe(2);
      const entry = readJournal(dir).at(-1)!;
      expect((entry.gates as Record<string, unknown> | undefined)?.conclusionBm25).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════ A2：结论层 rerank 语义门 ═══════════════

describe("R71-A2 · 结论层 rerank 语义门", () => {
  it("①缺省 shadow：只记录不过滤——低分结论保留，journal 记 would-be kept/dropped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2sh-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const fake = markerReranker([
        ["ConclA", -5],
        ["ConclB", 2],
        ["Marker1", 90],
        ["Marker2", 80],
      ]);
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({}, { ...SILICONFLOW_RERANK }), { deps: { reranker: fake.reranker } }));
      // shadow：ConclA（-5 < -1）未被过滤
      expect(res.conclusionCount).toBe(2);
      expect(res.memoryLines.some((l) => l.includes("ConclA"))).toBe(true);
      // 调用序：call1=结论门（2 docs），call2=经验精排
      expect(fake.callCount()).toBe(2);
      expect(fake.docSets()[0]).toHaveLength(2);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionRerank as Record<string, unknown> | undefined;
      expect(gate).toBeDefined();
      expect(gate?.mode).toBe("shadow");
      expect(gate?.provider).toBe("siliconflow");
      expect(gate?.kept).toBe(1);
      expect(gate?.dropped).toBe(1);
      expect(gate?.topScore).toBe(2);
      expect(typeof gate?.ms).toBe("number");
      expect(gate?.bypass).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②enforce：score<minScore 的选中结论在幂等缓存前剔除；同 session 二次调用命中缓存", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2en-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const store = fallbackStore(rows);
      const run = () => performLayeredRecall(paramsFor(dir, store, KW + " 项目进展如何", makeCfg({
        conclusionLayer: { rerankGate: { mode: "enforce" } },
      }, { ...SILICONFLOW_RERANK }), { deps: { reranker: markerReranker([["ConclA", -5], ["ConclB", 2], ["Marker1", 90], ["Marker2", 80]]).reranker }, sessionKey: "sk-gate" }));
      const res1 = await run();
      expect(res1.conclusionCount).toBe(1);
      expect(res1.memoryLines.some((l) => l.includes("ConclA"))).toBe(false);
      expect(res1.memoryLines.some((l) => l.includes("ConclB"))).toBe(true);
      const entries1 = readJournal(dir);
      expect(entries1).toHaveLength(1);
      const gate1 = ((entries1[0].gates as Record<string, unknown> | undefined)?.conclusionRerank) as Record<string, unknown> | undefined;
      expect(gate1?.mode).toBe("enforce");
      expect(gate1?.kept).toBe(1);
      expect(gate1?.dropped).toBe(1);
      // 幂等缓存存的是已门控集合：同 session 同 query 二次调用（同脚本同分）→ 指纹相等 → 缓存命中
      const res2 = await run();
      expect(res2.sessionReused).toBe(true);
      expect(res2.conclusionCount).toBe(1);
      expect(res2.memoryLines.some((l) => l.includes("ConclA"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③off：门零开销（不调 provider），journal 无 conclusionRerank 键", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2off-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const fake = markerReranker([["ConclA", -5], ["ConclB", 2], ["Marker1", 90], ["Marker2", 80]]);
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { rerankGate: { mode: "off" } },
      }, { ...SILICONFLOW_RERANK }), { deps: { reranker: fake.reranker } }));
      expect(res.conclusionCount).toBe(2);
      expect(fake.callCount()).toBe(1); // 只有经验精排一次
      const entry = readJournal(dir).at(-1)!;
      expect((entry.gates as Record<string, unknown> | undefined)?.conclusionRerank).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④wiring 非 active（rerank 未启用）：shadow 门旁路留痕 bypass=rerank-off，不误杀", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2wo-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({})));
      expect(res.conclusionCount).toBe(2);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionRerank as Record<string, unknown> | undefined;
      expect(gate).toBeDefined();
      expect(gate?.mode).toBe("shadow");
      expect(gate?.bypass).toBe("rerank-off");
      expect(gate?.kept).toBe(2);
      expect(gate?.dropped).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑤provider null（运行失败）：enforce 门 fail-open 不误杀 + bypass=rerank-failed + 熔断计败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2fo-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const breaker = createRerankBreaker();
      const fake = scriptReranker(() => null);
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { rerankGate: { mode: "enforce" } },
      }, { ...SILICONFLOW_RERANK }), { deps: { reranker: fake.reranker, breaker } }));
      expect(res.conclusionCount).toBe(2);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionRerank as Record<string, unknown> | undefined;
      expect(gate?.bypass).toBe("rerank-failed");
      expect(gate?.kept).toBe(2);
      expect(gate?.dropped).toBe(0);
      // 单次失败不熔断（threshold 3），但已计败
      expect(breaker.isOpen()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑥熔断开：门跳过 provider（零调用）bypass=breaker-open；enforce 不误杀", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2bo-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const breaker = createRerankBreaker();
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      const fake = markerReranker([["ConclA", -5], ["ConclB", 2]]);
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { rerankGate: { mode: "enforce" } },
      }, { ...SILICONFLOW_RERANK }), { deps: { reranker: fake.reranker, breaker } }));
      expect(fake.callCount()).toBe(0); // 门与经验精排都零外呼
      expect(res.conclusionCount).toBe(2);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionRerank as Record<string, unknown> | undefined;
      expect(gate?.bypass).toBe("breaker-open");
      expect(gate?.ms).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑦provider 未覆盖的候选不杀（垫尾语义）；enforce minScore 显式透传", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-a2pc-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)];
      const fake = markerReranker([["ConclA", -0.5]]); // 只给 ConclA 打分（低于显式 minScore 0）
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({
        conclusionLayer: { rerankGate: { mode: "enforce", minScore: 0 } },
      }, { ...SILICONFLOW_RERANK }), { deps: { reranker: fake.reranker } }));
      // ConclA=-0.5 < 0 被剔（结论通道）；ConclB 无分=未覆盖 → 不杀。
      // wf-1 行仍可经经验层注入（同 A1 ①：地板/门只管结论通道），断言收窄到 [结论| 行。
      expect(res.conclusionCount).toBe(1);
      expect(res.memoryLines.some((l) => l.includes("ConclB"))).toBe(true);
      expect(res.memoryLines.some((l) => l.includes("[结论]") && l.includes("ConclA"))).toBe(false);
      const entry = readJournal(dir).at(-1)!;
      const gate = (entry.gates as Record<string, unknown> | undefined)?.conclusionRerank as Record<string, unknown> | undefined;
      expect(gate?.kept).toBe(1);
      expect(gate?.dropped).toBe(1);
      expect(gate?.topScore).toBe(-0.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════ C：fts-only 注入帽 ═══════════════

describe("R71-C · fts-only 降级注入帽", () => {
  /** 3 结论 + 2 经验（maxResults=7 → halfLimit=3）——fallback store 恒 fts-only 降级态。 */
  function degradedSetup(dir: string, cfgOver: Record<string, unknown>) {
    const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), wfRow("wf-3", "ConclC", -8), ...episodicRows(2)];
    return performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({ maxResults: 7, ...cfgOver })));
  }

  it("①缺省帽 2：注入块从尾部裁到 2 行（结论优先保留），counts 与实际注入对齐", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-c1-"));
    try {
      const res = await degradedSetup(dir, {});
      expect(res.memoryLines).toHaveLength(2);
      expect(res.memoryLines.some((l) => l.includes("ConclA"))).toBe(true);
      expect(res.memoryLines.some((l) => l.includes("ConclB"))).toBe(true);
      expect(res.memoryLines.some((l) => l.includes("ConclC"))).toBe(false);
      expect(res.conclusionCount).toBe(2);
      expect(res.experienceCount).toBe(0);
      expect(res.block).toContain("[degraded: fts-only]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②显式 0 = off：不裁剪（5 行全额）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-c2-"));
    try {
      const res = await degradedSetup(dir, { ftsOnlyInjectCap: 0 });
      expect(res.memoryLines).toHaveLength(5);
      expect(res.conclusionCount).toBe(3);
      expect(res.experienceCount).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③帽只作用于 fts-only 降级：keyword 策略（用户显式选择）不裁剪", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r71-c3-"));
    try {
      const rows = [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), wfRow("wf-3", "ConclC", -8), ...episodicRows(2)];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({ maxResults: 7, strategy: "keyword" })));
      expect(res.memoryLines).toHaveLength(5);
      expect(res.block).not.toContain("[degraded: fts-only]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
