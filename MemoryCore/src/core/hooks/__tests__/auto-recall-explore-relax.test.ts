/**
 * V2-3 引擎三 · auto-recall 路 RED 套件 —— 排序点② searchHybrid + 结论层放宽（E3.2）。
 *
 * 覆盖：isAnalyticalQuery 三态边界（有标记+长>8 / 无标记 / 长度边界）；
 * searchHybrid 组合分精排 + 探索位（与咽喉排序点①同层对齐——同一单一源纯函数）；
 * 分析型 query → L2 结论层追加 significance top-5 durative 结论（无需 scene/text 命中，
 * searchL1ByType 真库）；非分析型 → 现状；conclusionRelaxedForAnalytical=false → 关断。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAnalyticalQuery, performAutoRecall, searchHybrid } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import { ZERO_RANK_SIGNALS } from "../../tools/recall-signals.js";

// ═══════════════ E3.2 分析型检测（启发式，宁缺毋滥） ═══════════════

describe("V2-3 E3.2 isAnalyticalQuery 边界", () => {
  it("有分析标记且长度 > 8 → true", () => {
    expect(isAnalyticalQuery("怎么提高召回的全面性和准确性")).toBe(true);
    expect(isAnalyticalQuery("请评估当前系统的整体状况")).toBe(true);
    expect(isAnalyticalQuery("为什么会出现红牌现象呢")).toBe(true);
    expect(isAnalyticalQuery("对比两个方案的差异")).toBe(true);
  });
  it("无标记 / 过短（≤8 字）→ false", () => {
    expect(isAnalyticalQuery("今天天气怎么样")).toBe(false); // 无标记（"怎么样"不含"怎么"？含——长度 8 边界）
    expect(isAnalyticalQuery("怎么召回")).toBe(false); // 有标记但 ≤8 字
    expect(isAnalyticalQuery("123456789")).toBe(false); // >8 字无标记
    expect(isAnalyticalQuery("")).toBe(false);
  });
  it("长度边界：恰 8 字 false，9 字 true", () => {
    expect(isAnalyticalQuery("怎么提高全面性")).toBe(false); // 7 字
    expect(isAnalyticalQuery("怎么提高全面性和准确性呢")).toBe(true); // 12 字
  });
});

// ═══════════════ 排序点② searchHybrid：精排 + 探索位（同层对齐） ═══════════════

function vecHit(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `V2BAL 记忆条目 ${id}`,
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
  };
}

function hybridMock(opts: {
  vecRows?: L1SearchResult[];
  neighbors?: Array<{ id: string; type: string; strength: number; hop: number }>;
  neighborRows?: L1SearchResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Vector: async () => opts.vecRows ?? [],
    getNeighbors: () => opts.neighbors ?? [],
    getL1ByIdsWithArchive: (ids: string[]) => (opts.neighborRows ?? []).filter((r) => ids.includes(r.record_id)),
    bumpRecallCount: () => true,
  } as unknown as IMemoryStore;
}

const emb = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;

describe("V2-3 排序点② searchHybrid：组合分精排 + 探索位", () => {
  it("探索位：结构命中且低 recall_count 候选占末席 + [explore] 标注（与咽喉同层）", async () => {
    const vecRows = ["a", "b", "c", "d", "e"].map((id) =>
      vecHit(id, { metadata_json: JSON.stringify({ recall_count: 10 }) }),
    );
    const res = await searchHybrid(
      "V2BAL 探索位探针", "", 3, 0.3,
      hybridMock({
        vecRows,
        neighbors: [{ id: "n1", type: "causal", strength: 0.9, hop: 1 }],
        neighborRows: [vecHit("n1")],
      }),
      emb, undefined, undefined,
      { boost: 0, firedLabels: [], moodSign: 0, timeWindow: null, signals: ZERO_RANK_SIGNALS, now: new Date(), graph: { minStrength: 0.5, discount: 0.6 } },
    );
    expect(res.lines.length).toBe(3);
    expect(res.lines[2]).toContain("条目 n1");
    expect(res.lines[2]).toContain("graph:ppr:causal:explore");
  });

  it("组合分精排：significance 高者截断前前移；权重全 0 → 稳定基线序（关断恒等）", async () => {
    const vecRows = [
      vecHit("a"),
      vecHit("b", { significance: 0.9 }),
    ];
    const store = hybridMock({ vecRows });
    // RV2-2：四因子新形状（relevance 置 0——隔离显著因子断言；两行 relevance 相近不参与裁决）
    const on = await searchHybrid("V2BAL 精排探针", "", 10, 0.3, store, emb, undefined, undefined, undefined, 0, undefined, undefined, undefined, { relevance: 0, timeProx: 0, significance: 1, coreRef: 0 });
    expect(on.lines[0]).toContain("条目 b");
    const off = await searchHybrid("V2BAL 精排探针", "", 10, 0.3, store, emb, undefined, undefined, undefined, 0, undefined, undefined, undefined, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 });
    expect(off.lines[0]).toContain("条目 a");
  });
});

// ═══════════════ E3.2 结论层放宽（真库 + performAutoRecall 真链路） ═══════════════

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `V2BAL 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "verify-v2-bal",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-11T00:00:00Z"],
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "verify-v2-bal",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-bal-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

async function recall(
  store: VectorStore,
  userText: string,
  sessionKey: string,
  cfgOverrides: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof performAutoRecall>>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-v2-bal-profile-"));
  try {
    return await performAutoRecall({
      userText,
      actorId: "verify",
      sessionKey,
      cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 5, ...cfgOverrides } }),
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
    });
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

describe("V2-3 E3.2 结论层放宽（performAutoRecall 真链路，临时库）", () => {
  // 结论行（durative work_fact，按 significance 分层；内容避开 query token——无需命中即可浮出）
  const WF_ROWS = [
    mk("wf-a", { type: "work_fact", content: "红牌诊断结论条目甲", significance: 0.9 }),
    mk("wf-b", { type: "work_fact", content: "利用率矩阵结论条目乙", significance: 0.7 }),
    mk("wf-c", { type: "work_fact", content: "全面性基线结论条目丙", significance: 0.1 }),
    // 注入锚（episodic，query token 命中——保证注入块非空；不参与结论候选）
    mk("anchor", { content: "V2BAL 锚点：召回质量问题记录" }),
  ];
  const ANALYTICAL_Q = "请帮我分析一下当前的召回质量改进方向";

  it("分析型 query：significance top durative 结论无需命中即浮出（降序，受 R7 预算封顶）", async () => {
    const { store, dir } = makeStore(WF_ROWS);
    try {
      const res = await recall(store, ANALYTICAL_Q, "sk-v2bal-relax-on");
      const ctx = res?.prependContext ?? "";
      // 审查修补 Critical（R7 §1 预算模型）：结论侧硬上限 = floor(maxResults/2) = 2——
      // 放宽产出的 3 条按 significance 降序保留头部 2 条（甲 0.9 > 乙 0.7），丙被预算裁剪。
      expect(ctx).toContain("结论条目甲");
      expect(ctx).toContain("结论条目乙");
      expect(ctx).not.toContain("结论条目丙"); // 超出预算模型额度的尾部被裁剪
      expect(ctx.indexOf("结论条目甲")).toBeLessThan(ctx.indexOf("结论条目乙"));
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("非分析型 query：无命中不出结论（现状逐位）", async () => {
    const { store, dir } = makeStore(WF_ROWS);
    try {
      const res = await recall(store, "随便聊聊今天的天气", "sk-v2bal-relax-off-q");
      const ctx = res?.prependContext ?? "";
      expect(ctx).not.toContain("[结论");
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("conclusionRelaxedForAnalytical=false → 关断（分析型也不放宽）", async () => {
    const { store, dir } = makeStore(WF_ROWS);
    try {
      const res = await recall(store, ANALYTICAL_Q, "sk-v2bal-relax-switch", { conclusionRelaxedForAnalytical: false });
      const ctx = res?.prependContext ?? "";
      expect(ctx).not.toContain("结论条目甲");
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
