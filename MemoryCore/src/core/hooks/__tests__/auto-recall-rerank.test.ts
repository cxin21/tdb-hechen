/**
 * P1 召回质量 Task 2（spec §4.5，r3 = 232a124）：performLayeredRecall 精排接入 RED 套件。
 *
 * 接入点合同（spec §4.5 + task-2-brief）：
 *  - rerank 插在 searchMemories 之后、foldNearDuplicates/applyRecallBudget（预算切分/组装）之前；
 *  - 结构行（R7 结论行/灵魂行/锚行）不精排、始终保留（结论行由组装层前置，天然不入精排候选）；
 *  - 精排恒真实生效（shadowMode 已按用户 2026-10-14 拍板移除）：按 rerank score 降序取前 cap
 *    （预算对半后的经验层额度），minScore 以下丢弃，provider 截断的未排序候选按原序垫尾——绝不静默丢弃；
 *  - 熔断：连续 3 次失败 → 60s 窗口内零 provider 调用（原序注入），窗口过后恢复探测；
 *  - null/warn 合同：adapter null/throw → 原序 + 每次调用恰一条 warn；关闭/none（工厂 null）→ 完全静默零开销；
 *  - journal：gates.rerank = { provider, ms, kept, dropped, topScore? }（shadow 键已移除）；缺省关闭 → journal 无 rerank 键。
 *
 * 铁律：不碰检索层（九通道/绝对门槛/RRF/字典序）；本套件只通过 performLayeredRecall 的
 * rerankDeps 注入 fake provider/breaker（DI seam），全链走 sqlite fallback 路径（本机形态；
 * native TCVDB 路由单独一测覆盖 scores 对位）。不 mock 被测函数内部。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRerankBreaker,
  performLayeredRecall,
  resetRerankBreakerForTests,
} from "../auto-recall.js";
import { getRerankModelStatus } from "../../recall/rerank/downloader.js";
import type { MemoryReranker, RerankResult } from "../../recall/rerank/types.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import type { Logger } from "../../types.js";

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

/** 五条语义互异的长内容行（唯一 Marker 前缀 + 互不共享措辞——防 foldNearDuplicates 误折叠：
 *  共享脚手架（KW 前缀/「记忆N号」）会使 bigram Jaccard ≥0.25 被合法折叠，这是既有折叠
 *  行为的正确结果，不是本套件要测的东西）。 */
const MARKERS = ["Marker1", "Marker2", "Marker3", "Marker4", "Marker5", "Marker6", "Marker7", "Marker8"] as const;
const PHRASES = [
  "交付节奏承诺：每周三同步部署窗口并回写验收结论",
  "用户偏好明细：回复保持中文简洁且先给结论再列证据",
  "项目风险台账：网关超时阈值放宽前必须回归三层门禁",
  "团队协作事实：评审意见合并前需两名维护者各自确认",
  "数据备份约定：快照保留三十天并在月末核对恢复演练",
  "监控告警基线：错误率千分之五以上触发值班群通知",
  "文档归档规范：定稿后三日内同步索引页并冻结副本",
  "环境配置铁律：密钥只走注入器禁止落库明文提交",
] as const;

function episodicRows(n: number, scoreBase = 0.95, step = 0.05): L1FtsResult[] {
  const rows: L1FtsResult[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(ftsRow(`rec-${i + 1}`, `${MARKERS[i]}·${PHRASES[i % PHRASES.length]}`, scoreBase - step * i));
  }
  return rows;
}

/** sqlite fallback 形态 mock store（getCapabilities→false → searchMemories 走 searchHybrid
 *  fallback；getCapabilities 为无守卫直调（auto-recall searchMemories native 分派处），缺失会
 *  抛错被 catch 成空召回——必须提供）。 */
function fallbackStore(rows: L1FtsResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => rows.slice(0, k),
    searchL1Vector: async () => [],
  } as unknown as IMemoryStore;
}

/** native TCVDB 形态 mock store（searchL1Hybrid 单调用路，携带 scores）。 */
function nativeStore(rows: L1SearchResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: true }),
    searchL1Hybrid: async (req: { topK: number }) => rows.slice(0, req.topK),
  } as unknown as IMemoryStore;
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

/** 信号全 0 + 相关度单因子组合分 + 探索位关 → fallback 序 = 纯 FTS RRF 名次序（确定性）。 */
function makeCfg(recallOver: Record<string, unknown> = {}, rerank?: Record<string, unknown>): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      coreRefBoost: 0,
      graphDiscount: 0,
      sceneBoost: 0,
      timeBoost: 0,
      recencyBoost: 0,
      sigWeight: 0,
      inferredPenalty: 0,
      reinforcementWeight: 0,
      moodBoost: 0,
      emotionSalienceWeight: 0,
      sensitivityPenalty: 0,
      exploreSlot: false,
      rerankWeights: { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 },
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
      // R71-C fts-only 注入帽与本文件被测特性（rerank 接入/熔断/降级）正交，
      // 显式关断（0）以维持既有全额注入断言；帽行为在 auto-recall-conclusion-gate.test.ts 覆盖。
      ftsOnlyInjectCap: 0,
      ...recallOver,
      ...(rerank !== undefined ? { rerank } : {}),
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

/** 可编程 fake provider：脚本按调用序返回结果/异常；记录 query 与 docs 供断言。 */
interface FakeReranker {
  reranker: MemoryReranker;
  callCount(): number;
  queries(): string[];
  docSets(): string[][];
}
function scriptReranker(script: (call: number, query: string, docs: string[]) => RerankResult[] | null): FakeReranker {
  let calls = 0;
  const queries: string[] = [];
  const docSets: string[][] = [];
  return {
    reranker: {
      rerank: async (query: string, docs: string[]) => {
        calls++;
        queries.push(query);
        docSets.push([...docs]);
        return script(calls, query, docs);
      },
    },
    callCount: () => calls,
    queries: () => queries,
    docSets: () => docSets,
  };
}

/** 内容 Marker → rerank score 的降序映射 helper（fake 内部构造 RerankResult[]）。 */
function rankedByMarker(table: Array<[string, number]>, include: (marker: string) => boolean = () => true): RerankResult[] {
  return table
    .filter(([m]) => include(m))
    .map(([m, score], i) => ({ index: i, score }))
    .sort((a, b) => b.score - a.score);
}

/** fake 输出与 docs 无关的截断形态：按 marker 表全量造分再按 include 截断。
 *  注意 RerankResult.index 指 docs 入参下标——这里统一按 docs 中 Marker 位置计算。 */
function markerTableReranker(table: Array<[string, number]>, opts?: { include?: (marker: string) => boolean; failFrom?: number }): FakeReranker {
  return scriptReranker((call, _query, docs) => {
    if (opts?.failFrom !== undefined && call >= opts.failFrom) return null;
    const include = opts?.include ?? (() => true);
    const out: RerankResult[] = [];
    docs.forEach((d, index) => {
      const hit = table.find(([m]) => d.includes(m));
      if (hit && include(hit[0])) out.push({ index, score: hit[1] });
    });
    return out.sort((a, b) => b.score - a.score);
  });
}

function captureLogger(): { logger: Logger; warns: string[]; infos: string[]; debugs: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  const logger = {
    debug: (m: string) => debugs.push(m),
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => warns.push(`[error] ${m}`),
  } as unknown as Logger;
  return { logger, warns, infos, debugs };
}

function paramsFor(dir: string, store: IMemoryStore, userText: string, cfg: MemoryTdaiConfig, deps?: RerankDeps, logger?: Logger): PLRParams {
  return {
    userText,
    sessionKey: "", // 空 sessionKey → 复用缓存整体关断（每调用全新检索，E3 语义）
    cfg,
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: mockEmbedding(),
    ...(deps ? { rerankDeps: deps } : {}),
    ...(logger ? { logger } : {}),
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

/** 注入行序 → Marker 序（marker 表驱动断言，行文本含唯一 Marker）。 */
function orderOf(lines: string[]): string[] {
  return lines
    .map((l) => MARKERS.find((m) => l.includes(m)))
    .filter((m): m is (typeof MARKERS)[number] => m !== undefined);
}

const SILICONFLOW_RERANK = { enabled: true, provider: "siliconflow", apiKey: "test-key" };

beforeEach(() => {
  // 防跨用例污染：模块级默认熔断器归零（deps.breaker 注入的用例不受影响）。
  resetRerankBreakerForTests();
});

// ═══════════════ 测试 ═══════════════

describe("P1 Task 2 · performLayeredRecall 精排接入（spec §4.5）", () => {
  it("①接入顺序：active 模式下 rerank 看到扩池后的预算前候选（docs=8），最终注入=精排 top-cap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-order-"));
    try {
      const rows = episodicRows(8); // 基线 top5（maxResults=5），扩池后 8 条全进候选
      const fake = markerTableReranker(MARKERS.slice(0, 8).map((m, i) => [m, 100 - i * 10] as [string, number]));
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 项目进展如何`,
          makeCfg({}, { ...SILICONFLOW_RERANK, candidates: 12 }),
          { reranker: fake.reranker },
        ),
      );
      // rerank 先于预算切分：docs = 扩池后的 8 条（预算 slice 后只剩 5 → 若挂在切分后必为 5）
      expect(fake.docSets()[0]).toHaveLength(8);
      expect(fake.callCount()).toBe(1);
      // 最终注入 = 精排分降序 top-cap（cap=无结论时的全额 5）：Marker1..Marker5（分数 100..60）
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
      // 注入块同序（fold 不改变互异行）
      expect(orderOf((res.block ?? "").split("\n"))).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②结构行豁免：R7 结论行不入精排候选且始终保留；精排只重排经验行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-struct-"));
    try {
      const wf = ftsRow("rec-wf", `${KW} 专项稳定结论锚（RerankStructAnchor）：交付节奏承诺持续兑现，当前状态健康。`, 0.99, { type: "work_fact" });
      const rows = [wf, ...episodicRows(5)];
      const fake = markerTableReranker([
        ["Marker1", 50],
        ["Marker2", 40],
        ["Marker3", 30],
        ["Marker4", 20],
        ["Marker5", 10],
      ]);
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 记录一下进度`,
          makeCfg({ conclusionLayer: { rerankGate: { mode: "off" } } }, { ...SILICONFLOW_RERANK, candidates: 12 }),
          { reranker: fake.reranker },
        ),
      );
      // 结论行存在且在最前（tag=结论，scene_name 空）
      expect(res.memoryLines[0].startsWith("- [结论")).toBe(true);
      expect(res.memoryLines[0]).toContain("RerankStructAnchor");
      // 豁免：经验层精排候选不含结论内容（R71-A2 结论语义门是独立通道，
      // 此处显式 off 以单独验证经验层豁免不变量；A2 通道在 conclusion-gate 套件覆盖）
      const allDocs = fake.docSets().flat();
      expect(allDocs.length).toBeGreaterThan(0);
      expect(allDocs.some((d) => d.includes("RerankStructAnchor"))).toBe(false);
      // 经验行被精排重排（结论行之外），且结论行始终保留（未被精排挤掉）
      expect(orderOf(res.memoryLines.slice(1))).toEqual(["Marker1", "Marker2", "Marker3", "Marker4"]);
      expect(res.block).toContain("RerankStructAnchor");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③shadowMode 已移除（用户 2026-10-14 拍板）：缺省配置即真实生效，gate 无 shadow 键", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-shadow-"));
    try {
      const rows = episodicRows(5);
      const store = fallbackStore(rows);
      // run1：缺省 rerank 配置（无 shadowMode 键）——fake 给一条 minScore 以下的低分行（Marker1=-5），真实丢弃 1 条
      const fake = markerTableReranker([
        ["Marker5", 90],
        ["Marker4", 80],
        ["Marker3", 70],
        ["Marker2", 60],
        ["Marker1", -5],
      ]);
      const res1 = await performLayeredRecall(
        paramsFor(dir, store, `${KW} 复用探针`, makeCfg({}, { ...SILICONFLOW_RERANK }), { reranker: fake.reranker }),
      );
      expect(fake.callCount()).toBe(1);
      // 真实生效：Marker1 被丢弃，注入顺序 = 精排降序
      expect(orderOf((res1.block ?? "").split("\n"))).toEqual(["Marker5", "Marker4", "Marker3", "Marker2"]);
      // run2：完全关闭
      const res2 = await performLayeredRecall(paramsFor(dir, store, `${KW} 复用探针`, makeCfg({})));
      expect(orderOf((res2.block ?? "").split("\n"))).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
      // journal：run1 有 gates.rerank（无 shadow 键）；run2 无 rerank 键
      const entries = readJournal(dir);
      expect(entries).toHaveLength(2);
      const g1 = (entries[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown> | undefined;
      expect(g1).toBeDefined();
      expect(g1?.provider).toBe("siliconflow");
      expect(g1?.shadow).toBeUndefined(); // shadow 键已整体移除
      expect(g1?.kept).toBe(4); // 真实保留 4 条（Marker1=-5 < minScore -2）
      expect(g1?.dropped).toBe(1);
      expect(g1?.topScore).toBe(90);
      expect(typeof g1?.ms).toBe("number");
      const g2 = (entries[1].gates as Record<string, unknown> | undefined)?.rerank;
      expect(g2).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④a active：provider 截断（部分 docs 未排序）→ 未排序候选按原序垫尾，绝不静默丢弃", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-tail-"));
    try {
      const rows = episodicRows(6); // 池 6 条（maxResults=5，扩池至 candidates=12）
      // fake 只排序前 3 条（模拟 provider top_n 截断），R4-R6 未排序
      const fake = markerTableReranker(
        [
          ["Marker1", 80],
          ["Marker2", 70],
          ["Marker3", 90],
        ],
        { include: (m) => ["Marker1", "Marker2", "Marker3"].includes(m) },
      );
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 截断垫尾探针`,
          makeCfg({}, { ...SILICONFLOW_RERANK, candidates: 12 }),
          { reranker: fake.reranker },
        ),
      );
      // 精排序 [Marker3,Marker1,Marker2] + 未排序尾 [Marker4,Marker5]（原序）= 5 条；Marker6 被预算裁掉
      expect(orderOf(res.memoryLines)).toEqual(["Marker3", "Marker1", "Marker2", "Marker4", "Marker5"]);
      const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
      expect(gate.shadow).toBeUndefined(); // shadow 键已整体移除
      expect(gate.kept).toBe(5);
      expect(gate.dropped).toBe(1);
      expect(gate.topScore).toBe(90);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④b active：minScore 以下丢弃（drop 不垫尾）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-minscore-"));
    try {
      const rows = episodicRows(5);
      const fake = markerTableReranker([
        ["Marker1", 5],
        ["Marker2", 9],
        ["Marker3", -5],
        ["Marker4", 2],
        ["Marker5", -1],
      ]);
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 门槛丢弃探针`,
          makeCfg({}, { ...SILICONFLOW_RERANK, minScore: 0 }),
          { reranker: fake.reranker },
        ),
      );
      expect(orderOf(res.memoryLines)).toEqual(["Marker2", "Marker1", "Marker4"]);
      const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
      expect(gate.kept).toBe(3);
      expect(gate.dropped).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ═══════════════ #99 F3（2026-10-25）：local logit 刻度校准化 + 全员低于阈值优雅降级 ═══════════════

  describe("#99 F3 · local rerank sigmoid 归一 + all-below 降级（不清零）", () => {
    const LOCAL_RERANK = { enabled: true, provider: "local", minScore: -1.0 };

    it("①全员低于阈值 → 回退未重排顺序注入（P3 病灶：旧行为全杀=0 经验行），journal degraded 归因 + 归一化刻度字段", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-i99-"));
      try {
        const rows = episodicRows(5);
        const fake = markerTableReranker([
          ["Marker1", -2.82],
          ["Marker2", -3.5],
          ["Marker3", -4],
          ["Marker4", -5],
          ["Marker5", -6],
        ]);
        const res = await performLayeredRecall(
          paramsFor(dir, fallbackStore(rows), `${KW} i99降级探针`, makeCfg({}, { ...LOCAL_RERANK }), { reranker: fake.reranker }),
        );
        // 降级 = 原序注入（与 null/throw/熔断同族「原序注入」语义），预算帽内不清零
        expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
        const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
        expect(gate.degraded).toBe("all-below-minScore");
        expect(gate.scoreScale).toBe("logit-sigmoid");
        expect(gate.topScore).toBe(-2.82); // raw 保留（#96 取证口径连续）
        expect(gate.top01).toBeCloseTo(1 / (1 + Math.exp(2.82)), 5);
        expect(gate.threshold01).toBeCloseTo(1 / (1 + Math.exp(1)), 5);
        expect(gate.kept).toBe(5);
        expect(gate.dropped).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("②部分过线 → 过滤语义与原始 logit 刻度逐位一致（sigmoid 单调等价锁定），无 degraded", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-i99b-"));
      try {
        const rows = episodicRows(5);
        const fake = markerTableReranker([
          ["Marker1", -0.5],
          ["Marker2", -3],
          ["Marker3", 2],
          ["Marker4", -1.2],
          ["Marker5", -0.9],
        ]);
        const res = await performLayeredRecall(
          paramsFor(dir, fallbackStore(rows), `${KW} i99等价探针`, makeCfg({}, { ...LOCAL_RERANK }), { reranker: fake.reranker }),
        );
        // sigmoid 单调：-0.5/2/-0.9 过线（0.3775/0.8808/0.2891 ≥ 0.2689），-3/-1.2 不过（0.0474/0.2315）
        expect(orderOf(res.memoryLines)).toEqual(["Marker3", "Marker1", "Marker5"]);
        const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
        expect(gate.degraded).toBeUndefined();
        expect(gate.kept).toBe(3);
        expect(gate.dropped).toBe(2);
        expect(gate.scoreScale).toBe("logit-sigmoid");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("③siliconflow 原生 0..1 刻度不归一（scoreScale 缺席 = native，行为逐位不变）", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-i99c-"));
      try {
        const rows = episodicRows(5);
        const fake = markerTableReranker([
          ["Marker1", 5],
          ["Marker2", 9],
          ["Marker3", -5],
          ["Marker4", 2],
          ["Marker5", -1],
        ]);
        const res = await performLayeredRecall(
          paramsFor(dir, fallbackStore(rows), `${KW} i99native探针`, makeCfg({}, { ...SILICONFLOW_RERANK, minScore: 0 }), { reranker: fake.reranker }),
        );
        expect(orderOf(res.memoryLines)).toEqual(["Marker2", "Marker1", "Marker4"]);
        const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
        expect(gate.scoreScale).toBeUndefined();
        expect(gate.top01).toBeUndefined();
        expect(gate.threshold01).toBeUndefined();
        expect(gate.kept).toBe(3);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("⑤熔断：3 连败 → 60s 窗口内零 provider 调用（原序注入），窗口过后恢复探测", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-breaker-"));
    try {
      const rows = episodicRows(5);
      const store = fallbackStore(rows);
      let nowMs = 1_700_000_000_000;
      const breaker = createRerankBreaker({ threshold: 3, windowMs: 60_000, now: () => nowMs });
      const fake = markerTableReranker([], { failFrom: 1 }); // 恒 null
      const deps = (): RerankDeps => ({ reranker: fake.reranker, breaker });
      const cfg = makeCfg({}, { ...SILICONFLOW_RERANK });
      // 同步工厂函数（async 会让 performLayeredRecall 收到 Promise 而非 params）
      const run = (): PLRParams => paramsFor(dir, store, `${KW} 熔断探针`, cfg, deps());

      await performLayeredRecall(run());
      await performLayeredRecall(run());
      await performLayeredRecall(run());
      expect(fake.callCount()).toBe(3); // 三连败每次都尝试
      expect(orderOf((await performLayeredRecall(run())).memoryLines)).toEqual([
        "Marker1", "Marker2", "Marker3", "Marker4", "Marker5",
      ]);
      expect(fake.callCount()).toBe(3); // 窗口内第 4 次调用：零 provider 调用（原序）

      nowMs += 61_000; // 越过窗口
      await performLayeredRecall(run());
      expect(fake.callCount()).toBe(4); // 恢复探测

      // journal：5 次调用（3 败 + 1 熔断跳过 + 1 恢复探测）都有降级 gate
      // （kept=N dropped=0 无 topScore）；第 4 次 ms=0（熔断未外呼）。
      const entries = readJournal(dir);
      expect(entries).toHaveLength(5);
      const gates = entries.map((e) => (e.gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>);
      for (const g of gates) {
        expect(g.kept).toBe(5);
        expect(g.dropped).toBe(0);
        expect(g.topScore).toBeUndefined();
        expect(g.shadow).toBeUndefined();
      }
      expect(gates[3].ms).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑤b熔断恢复：成功重置连续失败计数（null,null,成功,null → 第 4 次仍尝试）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-recover-"));
    try {
      const rows = episodicRows(5);
      const script = scriptReranker((call, _q, docs) => {
        if (call === 1 || call === 2 || call === 4) return null;
        return docs.map((d, i) => ({ index: i, score: docs.length - i })).sort((a, b) => b.score - a.score);
      });
      const deps = (): RerankDeps => ({
        reranker: script.reranker,
        breaker: createRerankBreaker({ threshold: 3, windowMs: 60_000 }),
      });
      const cfg = makeCfg({}, { ...SILICONFLOW_RERANK });
      const run = (): PLRParams => paramsFor(dir, fallbackStore(rows), `${KW} 恢复计数探针`, cfg, deps());
      await performLayeredRecall(run()); // 败1
      await performLayeredRecall(run()); // 败2
      await performLayeredRecall(run()); // 成功 → 计数清零
      await performLayeredRecall(run()); // 败（计数=1）→ 必须仍尝试
      expect(script.callCount()).toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑥a null 合同：adapter 返回 null → 原序注入 + 每次调用恰一条 warn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-null-"));
    try {
      const rows = episodicRows(5);
      const fake = markerTableReranker([], { failFrom: 1 });
      const { logger, warns } = captureLogger();
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} null合同探针`,
          makeCfg({}, { ...SILICONFLOW_RERANK }),
          { reranker: fake.reranker, breaker: createRerankBreaker({ threshold: 3, windowMs: 60_000 }) },
          logger,
        ),
      );
      expect(fake.callCount()).toBe(1);
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
      expect(warns.filter((m) => m.includes("[rerank]"))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑥b 工厂 local 接入（task-3）：模型缺失 → 触发下载单例（fetch 404 快速失败）→ null 降级：warn 恰一条、journal 降级 gate、下载状态可查", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-localnull-"));
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-localmodel-"));
    // 拦截全局 fetch：下载器对全部直链拿到 404（每源致命 → 不退避、快速失败），测试零真实网络
    let downloadFetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        downloadFetchCalls += 1;
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
    );
    try {
      const rows = episodicRows(5);
      const { logger, warns } = captureLogger();
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} local占位探针`,
          makeCfg({}, { enabled: true, provider: "local", local: { modelDir } }),
          undefined,
          logger,
        ),
      );
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
      expect(warns.filter((m) => m.includes("[rerank]"))).toHaveLength(1);
      const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
      expect(gate.provider).toBe("local");
      expect(typeof gate.ms).toBe("number"); // 活动接线：真实测时（不再是工厂 null 的固定 0）
      expect(gate.kept).toBe(5);
      expect(gate.dropped).toBe(0);
      expect(gate.shadow).toBeUndefined();
      expect(gate.topScore).toBeUndefined();
      // 下载被 fire-and-forget 触发（404 → failed），状态查询 API 可见（供 Task 4 panel 轮询）
      expect(downloadFetchCalls).toBeGreaterThanOrEqual(1);
      await vi.waitFor(() => {
        expect(getRerankModelStatus().state).toBe("failed");
      });
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(modelDir, { recursive: true, force: true });
    }
  });

  it("⑥c 缺省关闭（无 rerank 键）→ 完全静默零开销：零 [rerank] 日志、零 fetch、journal 无 rerank 键", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-off-"));
    try {
      const rows = episodicRows(5);
      let fetchCalls = 0;
      const fetchImpl: typeof fetch = (() => {
        fetchCalls++;
        return Promise.reject(new Error("network must not be touched when rerank is off"));
      }) as typeof fetch;
      const { logger, warns, infos, debugs } = captureLogger();
      const res = await performLayeredRecall(
        paramsFor(dir, fallbackStore(rows), `${KW} 关闭静默探针`, makeCfg({}), { fetchImpl }, logger),
      );
      expect(res.memoryLines).toHaveLength(5);
      expect(fetchCalls).toBe(0);
      expect([...warns, ...infos, ...debugs].some((m) => m.includes("[rerank]"))).toBe(false);
      const entry = readJournal(dir)[0];
      expect((entry.gates as Record<string, unknown> | undefined)?.rerank).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑥d timeoutMs=0（clamp 后每调用必中止）→ 永久退化：原序 + warn 恰一条 + journal 降级 gate（T1 移交①）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-timeout0-"));
    try {
      const rows = episodicRows(5);
      let fetchCalls = 0;
      const fetchImpl: typeof fetch = ((_url: unknown, _init: unknown) => {
        fetchCalls++;
        return Promise.reject(new Error("aborted-by-test"));
      }) as unknown as typeof fetch;
      const { logger, warns } = captureLogger();
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 零超时探针`,
          makeCfg({}, { enabled: true, provider: "siliconflow", apiKey: "k", timeoutMs: 0 }),
          { fetchImpl },
          logger,
        ),
      );
      expect(fetchCalls).toBe(1); // 真工厂路由到 siliconflow adapter 并发起了请求
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"]);
      expect(warns.filter((m) => m.includes("[rerank]"))).toHaveLength(1);
      const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
      expect(gate.provider).toBe("siliconflow");
      expect(gate.kept).toBe(5);
      expect(gate.dropped).toBe(0);
      expect(gate.shadow).toBeUndefined();
      expect(gate.topScore).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑦a sqlite fallback 路（本机形态）全链：精排生效 + journal active gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-fallback-"));
    try {
      const rows = episodicRows(4);
      const fake = markerTableReranker([
        ["Marker1", 40],
        ["Marker2", 30],
        ["Marker3", 95],
        ["Marker4", 20],
      ]);
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} fallback全链探针`,
          makeCfg({}, { ...SILICONFLOW_RERANK }),
          { reranker: fake.reranker },
        ),
      );
      expect(res.effectiveStrategy).toBe("hybrid");
      expect(orderOf(res.memoryLines)).toEqual(["Marker3", "Marker1", "Marker2", "Marker4"]);
      const gate = (readJournal(dir)[0].gates as Record<string, unknown> | undefined)?.rerank as Record<string, unknown>;
      expect(gate.shadow).toBeUndefined();
      expect(gate.kept).toBe(4);
      expect(gate.dropped).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑦b native 路（TCVDB searchL1Hybrid）scores 平行数组随精排重排对位", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-native-"));
    try {
      const nativeRows: L1SearchResult[] = episodicRows(5).map((r, i) => ({
        ...r,
        score: 0.91 - i * 0.04,
      }));
      const fake = markerTableReranker([
        ["Marker1", 10],
        ["Marker2", 20],
        ["Marker3", 30],
        ["Marker4", 40],
        ["Marker5", 50],
      ]); // 完全逆序
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          nativeStore(nativeRows),
          `${KW} native对位探针`,
          makeCfg({}, { ...SILICONFLOW_RERANK }),
          { reranker: fake.reranker },
        ),
      );
      expect(orderOf(res.memoryLines)).toEqual(["Marker5", "Marker4", "Marker3", "Marker2", "Marker1"]);
      // scores 与行同源平行：重排后 scores[i] = 重排前行 scores[finalIdx]（浮点经管道透传，
      // 允许机器精度误差）
      const expectedScores = [0.75, 0.79, 0.83, 0.87, 0.91];
      res.recalledL1Memories.forEach((m, i) => expect(m.score).toBeCloseTo(expectedScores[i], 10));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑧缺省关闭：journal gates 无 rerank 键（fallback 路无 nativeMinRRF → gates 整体缺席）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-defaultoff-"));
    try {
      const rows = episodicRows(5);
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), `${KW} 缺省关闭探针`, makeCfg({})));
      expect(res.memoryLines).toHaveLength(5);
      const entries = readJournal(dir);
      expect(entries).toHaveLength(1);
      const gates = entries[0].gates as Record<string, unknown> | undefined;
      expect(gates?.rerank).toBeUndefined();
      expect(gates?.nativeMinRRF).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════ #135 R4：精排过滤器化（rerank.mode="filter"）═══════════════
describe("#135 R4 · rerank.mode=\"filter\"（floor 只滤不清排保原序）", () => {
  it("①filter：达线保留、未达线剔除、注入序 = 原序（RRF 名次序，非精排分序）；未评分候选保留", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-filter-"));
    try {
      const rows = episodicRows(5); // 原序 = RRF 名次 Marker1..Marker5
      // provider 分序故意逆原序：Marker5 分最高。floor=0.5（cloud 原生 0..1 刻度）
      // → Marker4(0.4)/Marker5(0.3) 未达线；Marker1..3 达线且保留原序
      const fake = markerTableReranker([
        ["Marker1", 0.9], ["Marker2", 0.8], ["Marker3", 0.6], ["Marker4", 0.4], ["Marker5", 0.3],
      ]);
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 项目进展如何`,
          makeCfg({}, { ...SILICONFLOW_RERANK, mode: "filter", minScore: 0.5 }),
          { reranker: fake.reranker },
        ),
      );
      // 保序：非精排分序（若误走 rerank 分序则成 Marker3,2,1）
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3"]);
      // journal 标记 mode=filter
      const entries = readJournal(dir);
      const gates = entries[0]?.gates as Record<string, unknown> | undefined;
      const rerankGate = gates?.rerank as Record<string, unknown> | undefined;
      expect(rerankGate?.mode).toBe("filter");
      expect(rerankGate?.kept).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②filter 全员低于阈值：F3 优雅降级——保序注入全部行（不清零）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk2-filter2-"));
    try {
      const rows = episodicRows(4);
      const fake = markerTableReranker([
        ["Marker1", 0.2], ["Marker2", 0.1], ["Marker3", 0.1], ["Marker4", 0.1],
      ]);
      const res = await performLayeredRecall(
        paramsFor(
          dir,
          fallbackStore(rows),
          `${KW} 项目进展如何`,
          makeCfg({}, { ...SILICONFLOW_RERANK, mode: "filter", minScore: 0.5 }),
          { reranker: fake.reranker },
        ),
      );
      expect(orderOf(res.memoryLines)).toEqual(["Marker1", "Marker2", "Marker3", "Marker4"]);
      const entries = readJournal(dir);
      const gates = entries[0]?.gates as Record<string, unknown> | undefined;
      const rerankGate = gates?.rerank as Record<string, unknown> | undefined;
      expect(rerankGate?.degraded).toBe("all-below-minScore");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
