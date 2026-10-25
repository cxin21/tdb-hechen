/**
 * #78 R-b（F4 small-to-big 下半段）结论卡身世回捞测试套件（TDD RED 先行）。
 *
 * 契约（#78 Agent Brief + 拍板记录，2026-10-25）：
 *  - 读面独立开关 recall.smallToBig { enabled, maxExtraLines }——不挂 conclusionLayer 语义；
 *  - 代码缺省关（enabled 缺省 false）= 召回输出与现状逐位一致；部署 yaml 显式开（#77 三键同款）；
 *  - 开启时：work_fact 结论候选命中后按 recordId 回捞 part_of 关联证据行（单跳），作预算内
 *    附加「上下文行」注入（行形态 `- [上下文|场景] 内容`，同 formatConclusionLine 家族）；
 *  - 方向（地面真相）：part_of 边 source=结论卡→target=证据行 ⇒ 回捞用 getLinksBySource(cardId)；
 *  - maxExtraLines 全局帽（缺省 2，0=关）；附加行挤经验层配额（splitBudget 以结论行总数计）
 *    ⇒ 注入总行数 = maxResults 恒定（总预算帽不破）；
 *  - 关断矩阵：开关关 / 无 work_fact recordId / 缺 getLinksBySource 或 getL1ByIds[WithArchive]
 *    → 零 store 调用；软失败（throw）→ warn + 结论行原样（不阻塞召回）。
 *
 * 铁律：不 mock 被测函数内部；全链走 performLayeredRecall sqlite fallback 路径（R71 门测试同款）。
 * derived_from 读面语义按 brief 规则留待另行拍板（一期只做 part_of）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall, resetRerankBreakerForTests } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";

type PLRParams = Parameters<typeof performLayeredRecall>[0];

const KW = "S2bProbekw";

// ═══════════════ harness：行厂 / mock store / cfg / params（R71 门测试同款） ═══════════════

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
function wfRow(id: string, marker: string, rank: number, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return ftsRow(id, KW + " " + marker + "：交付节奏承诺持续兑现，当前状态健康。", 0.99, {
    type: "work_fact",
    rank,
    ...over,
  });
}

const MARKERS = ["Marker1", "Marker2", "Marker3", "Marker4", "Marker5"] as const;

function episodicRows(n: number): L1FtsResult[] {
  const rows: L1FtsResult[] = [];
  for (let i = 0; i < n; i++) rows.push(ftsRow("rec-" + (i + 1), MARKERS[i] + "·经验条目内容" + (i + 1), 0.9));
  return rows;
}

interface LinkRow {
  sourceId: string;
  targetId: string;
  type: string;
}

interface S2bStoreOpts {
  rows: L1FtsResult[];
  links?: LinkRow[];
  evidenceRows?: L1SearchResult[];
  /** getLinksBySource 抛异常（软失败路径）。 */
  linksThrow?: boolean;
  /** 不实现 getLinksBySource（feature-detect 关断路径）。 */
  omitGetLinksBySource?: boolean;
}

function s2bStore(opts: S2bStoreOpts): {
  store: IMemoryStore;
  linkCalls: Array<{ id: string; type: string | undefined }>;
  resolveCalls: string[][];
} {
  const linkCalls: Array<{ id: string; type: string | undefined }> = [];
  const resolveCalls: string[][] = [];
  const base: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => opts.rows.slice(0, k),
    searchL1Vector: async () => [],
    getL1ByIdsWithArchive: (ids: string[]) => {
      resolveCalls.push([...ids]);
      return (opts.evidenceRows ?? []).filter((r) => ids.includes(r.record_id));
    },
  };
  if (!opts.omitGetLinksBySource) {
    base.getLinksBySource = (id: string, type?: string) => {
      linkCalls.push({ id, type });
      if (opts.linksThrow) throw new Error("s2b store explode");
      return (opts.links ?? [])
        .filter((l) => l.sourceId === id && (type === undefined || l.type === type))
        .map((l) => ({ targetId: l.targetId, type: l.type, strength: 1, createdAt: "2026-10-25T00:00:00Z" }));
    };
  }
  return { store: base as unknown as IMemoryStore, linkCalls, resolveCalls };
}

/** 证据行厂：内容不含 KW（不进 FTS 结论选择——上下文行只能来自边回捞）。 */
function evidenceRow(id: string, content: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return ftsRow(id, content, 0, over);
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

function makeCfg(over: Record<string, unknown> = {}): MemoryTdaiConfig {
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
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

function paramsFor(dir: string, store: IMemoryStore, userText: string, cfg: MemoryTdaiConfig): PLRParams {
  return {
    userText,
    sessionKey: "", // 空 sessionKey → 复用缓存整体关断（每调用全新检索）
    cfg,
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: mockEmbedding(),
  };
}

beforeEach(() => {
  resetRerankBreakerForTests();
});

// ═══════════════ 关断矩阵（缺省逐位现状） ═══════════════

describe("R-b 关断矩阵", () => {
  it("①缺省（无 smallToBig 键）→ getLinksBySource 零调用、输出无 [上下文| 行（逐位现状）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-off-"));
    try {
      const m = s2bStore({
        rows: [wfRow("wf-1", "ConclA", -10, { scene_name: "项目重构" }), ...episodicRows(2)],
        links: [{ sourceId: "wf-1", targetId: "ev-1", type: "part_of" }],
        evidenceRows: [evidenceRow("ev-1", "证据：部署窗口为每周三")],
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({})));
      expect(m.linkCalls).toHaveLength(0);
      expect(res.memoryLines.some((l) => l.includes("[上下文"))).toBe(false);
      expect(res.memoryLines.some((l) => l.includes("ConclA"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②enabled 但结论为 scene_block（无 recordId）→ getLinksBySource 零调用", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-scene-"));
    try {
      // scene_block 候选来自 scene index 文件——此处无 scene index → 结论层空 → 通道整体退出
      const m = s2bStore({ rows: episodicRows(2) });
      await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true },
      })));
      expect(m.linkCalls).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③enabled 但 store 未实现 getLinksBySource（feature-detect）→ 零调用不炸、结论行正常", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-nocap-"));
    try {
      const m = s2bStore({ rows: [wfRow("wf-1", "ConclA", -10)], omitGetLinksBySource: true });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true },
      })));
      expect(m.linkCalls).toHaveLength(0);
      expect(res.memoryLines.some((l) => l.includes("ConclA"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════ 附加注入（enabled 主路径） ═══════════════

describe("R-b 附加注入", () => {
  it("④enabled + work_fact 结论 → 证据行以 `- [上下文|场景]` 附于结论行后（单跳 part_of）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-main-"));
    try {
      const m = s2bStore({
        rows: [wfRow("wf-1", "ConclA", -10, { scene_name: "项目重构" }), ...episodicRows(2)],
        links: [{ sourceId: "wf-1", targetId: "ev-1", type: "part_of" }],
        evidenceRows: [evidenceRow("ev-1", "证据：部署窗口为每周三")],
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true },
        ftsOnlyInjectCap: 0, // 关既有 R71-C fts-only 帽——隔离 R-b 自身预算数学（帽为另一既有总闸）
      })));
      expect(m.linkCalls).toEqual([{ id: "wf-1", type: "part_of" }]);
      expect(m.resolveCalls).toEqual([["ev-1"]]);
      const conclIdx = res.memoryLines.findIndex((l) => l.includes("[结论|项目重构]") && l.includes("ConclA"));
      const ctxIdx = res.memoryLines.findIndex((l) => l.includes("[上下文|项目重构]") && l.includes("部署窗口为每周三"));
      expect(conclIdx).toBeGreaterThan(-1);
      expect(ctxIdx).toBeGreaterThan(conclIdx);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑤maxExtraLines 全局帽：2 张卡各 2 条边、cap=2 → 恰 2 条上下文行（跨卡累计）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-cap-"));
    try {
      const m = s2bStore({
        rows: [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(2)],
        links: [
          { sourceId: "wf-1", targetId: "ev-1", type: "part_of" },
          { sourceId: "wf-1", targetId: "ev-2", type: "part_of" },
          { sourceId: "wf-2", targetId: "ev-3", type: "part_of" },
          { sourceId: "wf-2", targetId: "ev-4", type: "part_of" },
        ],
        evidenceRows: [
          evidenceRow("ev-1", "证据一甲"),
          evidenceRow("ev-2", "证据一乙"),
          evidenceRow("ev-3", "证据二甲"),
          evidenceRow("ev-4", "证据二乙"),
        ],
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true, maxExtraLines: 2 },
        ftsOnlyInjectCap: 0, // 关既有 R71-C 帽——隔离 R-b maxExtraLines 全局帽
      })));
      const ctxLines = res.memoryLines.filter((l) => l.includes("[上下文"));
      expect(ctxLines).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑥软失败：getLinksBySource throw → warn 不阻塞、结论行原样、无上下文行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-soft-"));
    try {
      const m = s2bStore({
        rows: [wfRow("wf-1", "ConclA", -10)],
        links: [{ sourceId: "wf-1", targetId: "ev-1", type: "part_of" }],
        evidenceRows: [evidenceRow("ev-1", "证据：部署窗口为每周三")],
        linksThrow: true,
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true },
      })));
      expect(res.memoryLines.some((l) => l.includes("ConclA"))).toBe(true);
      expect(res.memoryLines.some((l) => l.includes("[上下文"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑦预算守恒：maxResults=5、2 结论 + 2 上下文 → 总注入行数 5、经验行被挤至 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2b-budget-"));
    try {
      const m = s2bStore({
        rows: [wfRow("wf-1", "ConclA", -10), wfRow("wf-2", "ConclB", -9), ...episodicRows(3)],
        links: [
          { sourceId: "wf-1", targetId: "ev-1", type: "part_of" },
          { sourceId: "wf-2", targetId: "ev-2", type: "part_of" },
        ],
        evidenceRows: [evidenceRow("ev-1", "证据一甲"), evidenceRow("ev-2", "证据二甲")],
      });
      const res = await performLayeredRecall(paramsFor(dir, m.store, KW + " 项目进展如何", makeCfg({
        smallToBig: { enabled: true },
        ftsOnlyInjectCap: 0, // 关既有 R71-C 帽——隔离 splitBudget 挤占经验层的预算数学
      })));
      const concl = res.memoryLines.filter((l) => l.includes("[结论"));
      const ctx = res.memoryLines.filter((l) => l.includes("[上下文"));
      const exp = res.memoryLines.filter((l) => l.includes("经验条目内容"));
      expect(concl).toHaveLength(2);
      expect(ctx).toHaveLength(2);
      expect(exp).toHaveLength(1);
      expect(res.memoryLines.length).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
