import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_PACK,
  EVIDENCE_PACK_BADGE,
  evidencePackConfigOf,
  selectEvidencePackNeighbors,
  type EvidencePackConfig,
  type EvidencePackRow,
} from "../evidence-pack.js";

/**
 * #169 证据包（recall.evidencePack）纯函数层：
 * 只验证「从会话行表里挑邻接行」的挑选规则与计数口径，
 * 渲染（formatMemoryLine / ·[邻]）与插块在 hooks/auto-recall.ts 的接线测试里。
 */

type Row = EvidencePackRow & { content: string };

function cfg(over: Partial<EvidencePackConfig> = {}): EvidencePackConfig {
  return { ...DEFAULT_EVIDENCE_PACK, enabled: true, ...over };
}

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T10:00:00Z");

/** 会话 s1：r0..r4，间隔 1 分钟（都落在默认 30min 窗内）。 */
function s1Rows(): Row[] {
  return [0, 1, 2, 3, 4].map((i) => ({
    recordId: "r" + i,
    sessionId: "s1",
    at: T0 + i * MIN,
    content: "c" + i,
  }));
}

describe("#169 证据包配置解析", () => {
  it("缺省：关、每侧 1 行、30min 窗、总帽 6、会话 400 行", () => {
    expect(DEFAULT_EVIDENCE_PACK).toEqual({
      enabled: false,
      adjacent: 1,
      windowMinutes: 30,
      maxExtraLines: 6,
      maxSessionRows: 400,
    });
    expect(evidencePackConfigOf(undefined)).toEqual(DEFAULT_EVIDENCE_PACK);
    expect(evidencePackConfigOf("bogus")).toEqual(DEFAULT_EVIDENCE_PACK);
  });

  it("enabled 只认布尔 true（字符串 \"true\" 不算）", () => {
    expect(evidencePackConfigOf({ enabled: true }).enabled).toBe(true);
    expect(evidencePackConfigOf({ enabled: "true" }).enabled).toBe(false);
    expect(evidencePackConfigOf({ enabled: 1 }).enabled).toBe(false);
  });

  it("数值 clamp：adjacent 0..3、window 0..1440、cap 0..24、会话行 1..5000", () => {
    expect(evidencePackConfigOf({ adjacent: 9 }).adjacent).toBe(3);
    expect(evidencePackConfigOf({ adjacent: -1 }).adjacent).toBe(0);
    expect(evidencePackConfigOf({ adjacent: 2.6 }).adjacent).toBe(3);
    expect(evidencePackConfigOf({ windowMinutes: -5 }).windowMinutes).toBe(0);
    expect(evidencePackConfigOf({ windowMinutes: 99999 }).windowMinutes).toBe(1440);
    expect(evidencePackConfigOf({ maxExtraLines: 99 }).maxExtraLines).toBe(24);
    expect(evidencePackConfigOf({ maxSessionRows: 0 }).maxSessionRows).toBe(1);
    expect(evidencePackConfigOf({ maxSessionRows: 999999 }).maxSessionRows).toBe(5000);
  });

  it("非法值回落缺省（NaN / 空串 / null）", () => {
    const c = evidencePackConfigOf({ adjacent: NaN, windowMinutes: "", maxExtraLines: null });
    expect(c.adjacent).toBe(1);
    expect(c.windowMinutes).toBe(30);
    expect(c.maxExtraLines).toBe(6);
  });
});

describe("#169 邻接挑选", () => {
  it("enabled=false：一行都不扩，但 seed 计数仍回显", () => {
    const rows = s1Rows();
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ enabled: false }),
    });
    expect(extrasBySeed.size).toBe(0);
    expect(stats.enabled).toBe(false);
    expect(stats.seedLines).toBe(1);
    expect(stats.adjacencyLines).toBe(0);
  });

  it("adjacent=0 或 maxExtraLines=0：不扩（四档的 +0 基准）", () => {
    const rows = s1Rows();
    const seeds = [{ recordId: "r2", sessionId: "s1" }];
    const a = selectEvidencePackNeighbors({ seeds, rowsBySession: new Map([["s1", rows]]), cfg: cfg({ adjacent: 0 }) });
    expect(a.extrasBySeed.size).toBe(0);
    expect(a.stats.adjacencyLines).toBe(0);
    const b = selectEvidencePackNeighbors({ seeds, rowsBySession: new Map([["s1", rows]]), cfg: cfg({ maxExtraLines: 0 }) });
    expect(b.extrasBySeed.size).toBe(0);
  });

  it("±1：同距离先左后右（位置序），插在 seed 之后", () => {
    const rows = s1Rows();
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1 }),
    });
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1", "r3"]);
    expect(stats.adjacencyLines).toBe(2);
    expect(stats.skippedWindow).toBe(0);
    expect(stats.skippedCap).toBe(0);
  });

  it("±2：由近到远 r1,r3,r0,r4", () => {
    const rows = s1Rows();
    const { extrasBySeed } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 2 }),
    });
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1", "r3", "r0", "r4"]);
  });

  it("越窗拒：|Δt|>windowMinutes 的候选不进包，记 skippedWindow", () => {
    const rows: Row[] = [
      { recordId: "r1", sessionId: "s1", at: T0, content: "far" },
      { recordId: "r2", sessionId: "s1", at: T0 + 31 * MIN, content: "seed" },
    ];
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1, windowMinutes: 30 }),
    });
    expect(extrasBySeed.size).toBe(0);
    expect(stats.skippedWindow).toBe(1);
    expect(stats.adjacencyLines).toBe(0);
  });

  it("越窗只取决于 seed 两侧时间差：窗口放宽就进包", () => {
    const rows: Row[] = [
      { recordId: "r1", sessionId: "s1", at: T0, content: "near" },
      { recordId: "r2", sessionId: "s1", at: T0 + 31 * MIN, content: "seed" },
    ];
    const { extrasBySeed } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1, windowMinutes: 60 }),
    });
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1"]);
  });

  it("windowMinutes=0：不限时间，只看位置", () => {
    const rows: Row[] = [
      { recordId: "r1", sessionId: "s1", at: T0, content: "ancient" },
      { recordId: "r2", sessionId: "s1", at: T0 + 100000 * MIN, content: "seed" },
    ];
    const { extrasBySeed } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1, windowMinutes: 0 }),
    });
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1"]);
  });

  it("时间未知（at=null）不参与窗口判定：宁可多扩也不整段失效", () => {
    const rows: Row[] = [
      { recordId: "r1", sessionId: "s1", at: null, content: "no-time" },
      { recordId: "r2", sessionId: "s1", at: T0, content: "seed" },
    ];
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1 }),
    });
    // at=null 排序垫尾 ⇒ 位置在 seed 之后，但仍然是唯一邻居
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1"]);
    expect(stats.skippedWindow).toBe(0);
  });

  it("总帽先到先得：maxExtraLines=1 时第二个候选被拒并记 skippedCap", () => {
    const rows = s1Rows();
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1, maxExtraLines: 1 }),
    });
    expect(extrasBySeed.get(0)?.map((r: Row) => r.recordId)).toEqual(["r1"]);
    expect(stats.adjacencyLines).toBe(1);
    expect(stats.skippedCap).toBe(1);
  });

  it("命中集去重：邻居本身是 seed 时不重复注入", () => {
    const rows = s1Rows();
    const { extrasBySeed } = selectEvidencePackNeighbors({
      seeds: [
        { recordId: "r2", sessionId: "s1" },
        { recordId: "r3", sessionId: "s1" },
      ],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1 }),
    });
    const injected = [...extrasBySeed.values()].flat().map((r: Row) => r.recordId);
    expect(injected).not.toContain("r2");
    expect(injected).not.toContain("r3");
  });

  it("跨 seed 全局去重：同一行只注入一次，且会话只查询一次", () => {
    const rows = s1Rows();
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [
        { recordId: "r1", sessionId: "s1" },
        { recordId: "r3", sessionId: "s1" },
      ],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1 }),
    });
    const injected = [...extrasBySeed.values()].flat().map((r: Row) => r.recordId);
    expect(injected).toHaveLength(new Set(injected).size);
    expect(stats.sessionsQueried).toBe(1);
  });

  it("seed 缺 recordId 或 sessionId：跳过并记 skippedNoSession（结论行/无来源行常如此）", () => {
    const { stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: null, sessionId: "s1" }, { recordId: "r2", sessionId: null }, {}],
      rowsBySession: new Map([["s1", s1Rows()]]),
      cfg: cfg({ adjacent: 1 }),
    });
    expect(stats.skippedNoSession).toBe(3);
    expect(stats.seedWithSession).toBe(0);
    expect(stats.adjacencyLines).toBe(0);
  });

  it("会话行表缺失 或 seed 不在行表：记 skippedNoSeedRow（不误报会话过大）", () => {
    const missingTable = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s9" }],
      rowsBySession: new Map([["s1", s1Rows()]]),
      cfg: cfg({ adjacent: 1 }),
    });
    expect(missingTable.stats.skippedNoSeedRow).toBe(1);
    expect(missingTable.stats.skippedSessionTooLarge).toBe(0);

    const missingSeed = selectEvidencePackNeighbors({
      seeds: [{ recordId: "gone", sessionId: "s1" }],
      rowsBySession: new Map([["s1", s1Rows()]]),
      cfg: cfg({ adjacent: 1 }),
    });
    expect(missingSeed.stats.skippedNoSeedRow).toBe(1);
    expect(missingSeed.stats.skippedSessionTooLarge).toBe(0);
  });

  it("会话行数超 maxSessionRows：整段跳过并记 skippedSessionTooLarge", () => {
    const rows = s1Rows();
    const { extrasBySeed, stats } = selectEvidencePackNeighbors({
      seeds: [{ recordId: "r2", sessionId: "s1" }],
      rowsBySession: new Map([["s1", rows]]),
      cfg: cfg({ adjacent: 1, maxSessionRows: 4 }),
    });
    expect(extrasBySeed.size).toBe(0);
    expect(stats.skippedSessionTooLarge).toBe(1);
  });

  it("badge 常量与 bench 归因常量一致（·[邻]）", () => {
    expect(EVIDENCE_PACK_BADGE).toBe("·[邻]");
  });
});
