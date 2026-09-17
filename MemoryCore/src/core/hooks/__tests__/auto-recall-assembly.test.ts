/**
 * R7 审查修补 · performAutoRecall 组装层单测套件（Important④）+ Critical RED→GREEN。
 *
 * 覆盖（审查 findings 对应）：
 *   - Critical（R7 §1 预算模型）：分析型 query + 结论充足 + V2-3 放宽 → 最终 memoryLines
 *     总行数 ≤ maxResults（当前实现结论行未按 splitBudget 的 conclusionLimit 裁剪，
 *     生产 maxResults=5 时分析型注入可达 10 行——本组测试在修复前应 FAIL，即 RED）。
 *     V2-3 溢出组与 Critical 合并（brief 允许）。
 *   - I①（关断矩阵纪律）：conclusionLayer.enabled=false → 结论层整体退出，复用
 *     "无 L2 命中退化"同一既有路径，输出与 R7 前基线逐位一致。
 *   - Important④ 四组：slice 对齐 / assemble 顺序 / metric scores 前插对齐 / V2-3 溢出。
 *
 * 铁律：不碰检索层（九通道/绝对门槛/排序）；全部走真链路 performAutoRecall + 临时 SQLite 库。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

// ═══════════════ 真链路脚手架（沿 auto-recall-explore-relax.test.ts 同款） ═══════════════

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `R7FIX 条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "r7fix-assembly",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-12T00:00:00Z"],
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "r7fix-assembly",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r7fix-assembly-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

function cleanup(store: VectorStore, dir: string): void {
  try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
}

async function recall(
  store: VectorStore,
  userText: string,
  sessionKey: string,
  cfgOverrides: Record<string, unknown> = {},
  sceneIndex?: Array<{ filename: string; summary: string }>,
): Promise<Awaited<ReturnType<typeof performAutoRecall>>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r7fix-assembly-profile-"));
  try {
    if (sceneIndex && sceneIndex.length > 0) {
      // 结论候选走 scene_block 通道（scene index 单一源，无 FTS 候选窗排序不确定性）。
      // 未传 profileIsolation → 默认 {default,default} → scoped profile 目录（与生产同构）。
      // R4-5：scope 三元组化后默认桶为 team:default|user:default|agent:default。
      const profileDir = path.join(
        dataDir, "profiles", encodeURIComponent("team:default|user:default|agent:default"),
      );
      fs.mkdirSync(path.join(profileDir, ".metadata"), { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, ".metadata", "scene_index.json"),
        JSON.stringify(sceneIndex.map((e) => ({ heat: 0, created: "", updated: "", ...e }))),
        "utf-8",
      );
    }
    return await performAutoRecall({
      userText,
      actorId: "r7fix",
      sessionKey,
      cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 5, ...cfgOverrides } }),
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
    });
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
}

/** 从 prependContext 提取注入行（保持顺序）。 */
function injectedLines(prependContext: string | undefined): string[] {
  return (prependContext ?? "").split("\n").filter((l) => /^- /.test(l));
}

// ═══════════════ Critical（RED→GREEN）：V2-3 溢出 → R7 §1 预算模型 ═══════════════

describe("审查修补 Critical · V2-3 溢出 → 最终注入总行数 ≤ maxResults（R7 §1 预算模型）", () => {
  // 场景构造：2 条 scene/文本命中的 work_fact（低 significance，让位放宽通道）+
  // 5 条高 significance work_fact（V2-3 searchL1ByType top-5 全量浮出）+
  // 1 条 FTS 命中的经验锚（episodic）。maxResults=5 → halfLimit=2：
  //   修复前：结论 2+5=7 行 + 经验 1 行 = 8 行（静默突破预算，RED）；
  //   修复后：结论裁剪到 2 行 + 经验 3 行额度 → 总 ≤ 5 行。
  const OVERFLOW_ROWS = [
    mk("wf-hit-a", { type: "work_fact", scene_name: "预算评估", content: "预算评估专项持续结论条目甲", significance: 0.05 }),
    mk("wf-hit-b", { type: "work_fact", scene_name: "预算评估", content: "预算评估专项持续结论条目乙", significance: 0.04 }),
    ...[0.9, 0.8, 0.7, 0.6, 0.5].map((sig, i) =>
      mk(`wf-fill-${i}`, { type: "work_fact", content: `r7fix overflow filler conclusion item ${i}`, significance: sig })),
    mk("anchor", { content: "此前关于请帮我分析一下预算评估的改进方向的讨论记录" }),
  ];
  const ANALYTICAL_Q = "请帮我分析一下预算评估的改进方向";

  it("分析型 query + 结论充足 + V2-3 放宽 → 总行数 ≤ maxResults（=5）", async () => {
    const { store, dir } = makeStore(OVERFLOW_ROWS);
    try {
      const res = await recall(store, ANALYTICAL_Q, "sk-r7fix-budget-critical");
      const lines = injectedLines(res?.prependContext);
      // 预算模型硬断言：结论 + 经验总行数不得突破 maxResults
      expect(lines.length).toBeLessThanOrEqual(5);
      // A2 metric 语义（2026-09-16 口径还债）：recalledL1Memories = 未折叠全集（metric 完整性），
      // 注入块 = foldNearDuplicates 折叠行集——"一一对应"已被 A2"块内折叠、metric 保全集"取代；
      // 对齐性改证：每条注入行都源自某个未折叠记忆。
      expect(res?.recalledL1Memories?.length).toBeGreaterThanOrEqual(lines.length);
      for (const l of lines) {
        expect(res?.recalledL1Memories?.some((m) => l.includes(m.content))).toBe(true);
      }
      // 裁剪不是清空：结论层仍在场（保留命中优先的头部），经验锚也在场
      expect(lines.filter((l) => l.startsWith("- [结论")).length).toBeGreaterThan(0);
      expect(lines.some((l) => l.includes("讨论记录"))).toBe(true);
    } finally {
      cleanup(store, dir);
    }
  });

  // 注：非分析型对照不单列——scene 命中词"预算评估"本身含分析标记"评估"（isAnalyticalQuery），
  // 构造不出"同构且非分析型"的对照；非分析型路径（selectL2Conclusions 自身封顶 halfLimit、
  // 无 V2-3 溢出）由下方 Important④-1/④-2 的"召回专项"场景覆盖。
});

// ═══════════════ I①：conclusionLayer.enabled 关断（复用退化路径） ═══════════════

describe("审查修补 I① · conclusionLayer.enabled=false → 结论层整体退出（基线逐位）", () => {
  const ROWS = [
    mk("wf-c1", { type: "work_fact", scene_name: "召回专项", content: "召回专项的持续结论条目", significance: 0.05 }),
    mk("anchor", { content: "召回专项最近有什么新进展的记录" }),
  ];

  it("enabled=false → 零结论行，经验层照常（无 L2 命中退化同路径）", async () => {
    const { store, dir } = makeStore(ROWS);
    try {
      const off = await recall(store, "召回专项最近有什么新进展", "sk-r7fix-off", {
        conclusionLayer: { enabled: false },
      });
      const offLines = injectedLines(off?.prependContext);
      expect(offLines.some((l) => l.startsWith("- [结论"))).toBe(false);
      // 经验层不受连坐：结论层退出后 work_fact 回归普通经验候选（基线形态）
      expect(offLines.some((l) => l.includes("持续结论条目"))).toBe(true);
      expect(offLines.some((l) => l.includes("记录"))).toBe(true);
      // 缺省（未配置 enabled）= 现行为：结论层在场（与关断态形成对照）
      const on = await recall(store, "召回专项最近有什么新进展", "sk-r7fix-on-diff-session");
      const onLines = injectedLines(on?.prependContext);
      expect(onLines.filter((l) => l.startsWith("- [结论")).length).toBeGreaterThan(0);
    } finally {
      cleanup(store, dir);
    }
  });
});

// ═══════════════ Important④ · 组装层四组 ═══════════════

describe("审查修补 Important④-1 · slice 对齐（experienceLimit = maxResults − 结论数）", () => {
  it("结论 1 条 + 经验 4 条 → 总 5 行（生产 maxResults=5 口径）", async () => {
    // 结论走 scene_block 通道（scene index，确定性命中，不受 FTS 候选窗排序影响）
    const ROWS = [
      // A2-R1 口径：行内容须真实可区分且足够长（行首 tag 公共 bigram 恒定共享，
      // 内容过短时 tag 主导相似度被误折）——共享词面仅保留 query 可命中的"召回专项"。
      ...[
        "召回专项背景下的索引评审：本次分片键选择结合热点访问路径完成冲突概率评估，容量推演与归档动作全部收尾",
        "召回专项相关的缓存压测：命中率曲线在峰值并发出现衰减拐点，失效风暴应对的灰度开关与排期表已经定稿",
        "召回专项延伸的回滚演练：双写切换与数据对账步骤全部通过验证，残留风险项登记进跟进清单并指派负责人",
        "召回专项配套的告警治理：分级通知策略与静默窗口写入运行手册，值班表完成同步并开始按新阈值运行",
      ].map((content, i) => mk(`anchor-${i}`, { content })),
    ];
    const { store, dir } = makeStore(ROWS);
    try {
      const res = await recall(store, "召回专项最近有什么新进展", "sk-r7fix-slice", {}, [
        { filename: "召回专项.md", summary: "召回专项的持续结论条目" },
      ]);
      const lines = injectedLines(res?.prependContext);
      expect(lines).toHaveLength(5);
      expect(lines.filter((l) => l.startsWith("- [结论"))).toHaveLength(1);
      expect(res?.recalledL1Memories?.length).toBe(5);
    } finally {
      cleanup(store, dir);
    }
  });
});

describe("审查修补 Important④-2 · assemble 顺序（结论块在前、经验折叠在后）", () => {
  it("结论行位于全部经验行之前", async () => {
    const ROWS = [
      mk("wf-c1", { type: "work_fact", scene_name: "召回专项", content: "召回专项的持续结论条目", significance: 0.05 }),
      ...["甲", "乙", "丙"].map((c, i) =>
        mk(`anchor-${i}`, { content: `召回专项最近有什么新进展的讨论记录${c}` })),
    ];
    const { store, dir } = makeStore(ROWS);
    try {
      const res = await recall(store, "召回专项最近有什么新进展", "sk-r7fix-order");
      const lines = injectedLines(res?.prependContext);
      const firstConclusion = lines.findIndex((l) => l.startsWith("- [结论"));
      const firstExperience = lines.findIndex((l) => !l.startsWith("- [结论"));
      expect(firstConclusion).toBe(0);
      expect(firstExperience).toBeGreaterThan(firstConclusion);
    } finally {
      cleanup(store, dir);
    }
  });
});

describe("审查修补 Important④-3 · metric scores 前插对齐（结论 0 分前插 + 经验分不串位）", () => {
  function ftsRow(id: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
    return {
      record_id: id,
      content: `R7FIX 条目 ${id}`,
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
    } as L1FtsResult;
  }

  function hitRow(id: string, score: number, over: Partial<L1SearchResult> = {}): L1SearchResult {
    return {
      record_id: id,
      content: `R7FIX 记忆条目 ${id}`,
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
    } as L1SearchResult;
  }

  it("结论前插 K 个 0 分，经验分按原序对齐（nativeHybrid scores 通道）", async () => {
    // mock：FTS 通道只供结论候选（work_fact）；nativeHybrid 供经验行（含被防重排除的 wf）
    const wfConclusion = ftsRow("wf-c1", {
      type: "work_fact",
      scene_name: "召回专项",
      content: "召回专项的持续结论条目",
      significance: 0.05,
    });
    const hybridRows = [
      hitRow("wf-c1", 0.99, { type: "work_fact", scene_name: "召回专项", content: "召回专项的持续结论条目" }),
      // A2-R1 口径：mock 行内容须真实可区分且足够长（同 tag 公共 bigram 主导会被误折）。
      hitRow("exp-1", 0.9, { content: "索引设计评审完成：本次分片键选择结合热点访问路径的冲突概率评估与容量推演记录已全部归档备查（exp-1）" }),
      hitRow("exp-2", 0.8, { content: "缓存策略压测报告定稿：命中率曲线在峰值并发下的衰减拐点与失效风暴应对开关已完成评审签发（exp-2）" }),
      hitRow("exp-3", 0.7, { content: "回滚方案演练日志归档：双写切换与数据对账步骤全部通过验证，残留风险项已登记进跟进清单（exp-3）" }),
      hitRow("exp-4", 0.6, { content: "监控告警阈值调整生效：分级通知策略与静默窗口的配置说明已写入运行手册并同步到值班表（exp-4）" }),
    ];
    const vectorStore = {
      isFtsAvailable: () => true,
      getCapabilities: () => ({ nativeHybridSearch: true }),
      searchL1Fts: async () => [wfConclusion],
      searchL1Hybrid: async () => hybridRows,
    } as unknown as IMemoryStore;
    const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r7fix-assembly-profile-"));
    try {
      const res = await performAutoRecall({
        userText: "召回专项最近有什么新进展",
        actorId: "r7fix",
        sessionKey: "sk-r7fix-metric",
        cfg: parseConfig({ recall: { strategy: "hybrid", maxResults: 5 } }),
        pluginDataDir: dataDir,
        vectorStore,
        embeddingService,
      });
      const lines = injectedLines(res?.prependContext);
      expect(lines.filter((l) => l.startsWith("- [结论"))).toHaveLength(1);
      const memories = res?.recalledL1Memories ?? [];
      expect(memories).toHaveLength(lines.length);
      // 前插对齐：第 0 位 = 结论（score 0 如实——非相似度命中）；经验分不串位
      expect(memories[0]?.type).toBe("结论");
      expect(memories[0]?.score).toBe(0);
      expect(memories[1]?.score).toBe(0.9); // exp-1 的分对齐到第 1 条注入行
      expect(memories[1]?.content).toContain("exp-1");
      expect(memories[4]?.score).toBe(0.6);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
