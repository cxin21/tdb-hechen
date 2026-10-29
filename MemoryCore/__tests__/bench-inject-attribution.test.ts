/**
 * `scripts/lib/bench/inject-attribution.mjs` 单测（#141 / #158 正文要求）：
 *  - 注入行分类：结论 / 上下文 / 其它召回行 / 未知（type 缺失时按 content 前缀兜底）；
 *  - 分桶累加：三类行 lines/goldLines/sessions 正确；
 *  - 一阶贡献：去掉某类型后 turnCov 的落差（coverageWithout / firstOrderDrop）；
 *  - 退化路径：缺类型行仍计入 turnCov、空注入 all-null/0、resolve 抛错不中断；
 *  - 证据充分性：中/英两例、数字不做部分匹配、停用词不进分母、goldTokens=0 → null。
 */
import { describe, expect, it } from "vitest";

import {
  INJECT_LINE_TYPES,
  attributeInjectedLines,
  attributeRows,
  classifyInjectedLine,
  evidenceSufficiency,
} from "../scripts/lib/bench/inject-attribution.mjs";

/** 行类型分类：type 前缀优先，其次 content 前缀，最后 unknown。 */
describe("classifyInjectedLine", () => {
  it("type 前缀：结论 / 上下文 / 其它非空 type", () => {
    expect(classifyInjectedLine({ type: "结论|日常" })).toBe("conclusion");
    expect(classifyInjectedLine({ type: "结论" })).toBe("conclusion");
    expect(classifyInjectedLine({ type: "上下文|项目重构" })).toBe("evidence-recall");
    expect(classifyInjectedLine({ type: "episodic|场景A" })).toBe("raw-turn");
    expect(classifyInjectedLine({ type: "work_fact" })).toBe("raw-turn");
  });

  it("缺 type 时按 content 前缀兜底，其余 unknown", () => {
    expect(classifyInjectedLine({ content: "- [结论|日常] 内容" })).toBe("conclusion");
    expect(classifyInjectedLine({ content: "- [上下文|场景] 内容" })).toBe("evidence-recall");
    expect(classifyInjectedLine({ content: "- [episodic] 内容" })).toBe("unknown");
    expect(classifyInjectedLine({ content: "没有行首标记" })).toBe("unknown");
    expect(classifyInjectedLine({})).toBe("unknown");
    expect(classifyInjectedLine(null)).toBe("unknown");
  });
});

describe("attributeInjectedLines", () => {
  /** 三条 gold 行 + 一条非 gold 行：分桶 lines/goldLines/sessions 逐类核对。 */
  const goldTurnIds = ["s1#t1", "s2#t2", "s3#t3"];
  const table = new Map([
    ["c1", "s1#t1"],
    ["c2", "s2#t2"],
    ["c3", "s3#t3"],
    ["c4", "s9#t9"],
    ["c5", "s9#t9"],
  ]);
  const resolve = (clean: string) => table.get(clean) ?? null;
  const hits = [
    { type: "结论|日常", clean: "c1", content: "- [结论|日常] 内容1" },
    { type: "上下文|场景A", clean: "c2", content: "- [上下文|场景A] 内容2" },
    { type: "episodic", clean: "c3", content: "- [episodic] 内容3" },
    { type: "episodic|场景B", clean: "c4", content: "- [episodic|场景B] 内容4" },
    // 无 type：靠 content 前缀兜底归入结论桶
    { clean: "c5", content: "- [结论|场景C] 内容5" },
  ];

  it("分桶累加：四类 lines / goldLines / sessions 正确", () => {
    const r = attributeInjectedLines({ hits, resolve, goldTurnIds });

    expect(r.injectedLines).toBe(5);
    expect(r.byType.conclusion).toEqual({ lines: 2, goldLines: 1, sessions: 1 });
    expect(r.byType["evidence-recall"]).toEqual({ lines: 1, goldLines: 1, sessions: 1 });
    expect(r.byType["raw-turn"]).toEqual({ lines: 2, goldLines: 1, sessions: 1 });
    expect(r.byType.unknown).toEqual({ lines: 0, goldLines: 0, sessions: 0 });
    // 三类 gold 行全覆盖；session 由 `#` 前缀推导（s1/s2/s3）
    expect(r.turnCov).toBeCloseTo(1, 10);
    expect(r.sessionCov).toBeCloseTo(1, 10);
    // 分桶行数守恒
    const sum = INJECT_LINE_TYPES.reduce((a, t) => a + r.byType[t].lines, 0);
    expect(sum).toBe(r.injectedLines);
  });

  it("classify 兜底：memoryLines 字符串形态也能归因", () => {
    const r = attributeInjectedLines({
      hits: ["- [结论|场景A] 结论行", "- [上下文|场景A] 证据行", "- [episodic] 原始行"],
      resolve: (c) => (c === "结论行" ? "s1#t1" : null),
      goldTurnIds,
    });
    expect(r.byType.conclusion.lines).toBe(1);
    expect(r.byType.conclusion.goldLines).toBe(1);
    expect(r.byType["evidence-recall"].lines).toBe(1);
    expect(r.byType["raw-turn"].lines).toBe(1);
    expect(r.byType.unknown.lines).toBe(0);
  });

  it("一阶贡献：两条 gold 行去掉结论后 turnCov 从 1 掉到 0.5", () => {
    const r = attributeInjectedLines({
      hits: [
        { type: "结论", clean: "a" },
        { type: "episodic", clean: "b" },
      ],
      resolve: (c) => (c === "a" ? "s1#t1" : c === "b" ? "s2#t2" : null),
      goldTurnIds: ["s1#t1", "s2#t2"],
    });

    expect(r.turnCov).toBeCloseTo(1, 10);
    expect(r.coverageWithout.conclusion).toEqual({ turnCov: 0.5, sessionCov: 0.5, injectedLines: 1 });
    expect(r.firstOrderDrop.conclusion.turnCov).toBeCloseTo(0.5, 10);
    expect(r.firstOrderDrop.conclusion.sessionCov).toBeCloseTo(0.5, 10);
    // raw-turn 同样承担一半
    expect(r.coverageWithout["raw-turn"].turnCov).toBeCloseTo(0.5, 10);
    // 没有该类型行时，剔除不改变覆盖率
    expect(r.coverageWithout.unknown.turnCov).toBeCloseTo(1, 10);
    expect(r.firstOrderDrop.unknown.turnCov).toBeCloseTo(0, 10);
  });

  it("缺类型退化：unknown 行仍计入 turnCov，但只在 unknown 桶里", () => {
    const r = attributeInjectedLines({
      hits: [{ content: "既无 type 也无行首标记的一行", clean: "x" }],
      resolve: () => "s1#t1",
      goldTurnIds: ["s1#t1"],
    });

    expect(r.injectedLines).toBe(1);
    expect(r.turnCov).toBeCloseTo(1, 10);
    expect(r.byType.unknown).toEqual({ lines: 1, goldLines: 1, sessions: 1 });
    expect(r.byType.conclusion.lines).toBe(0);
    // 剔除 unknown 后注入集为空 → 覆盖率归零（gold 仍存在，故是 0 而不是 null）
    expect(r.coverageWithout.unknown).toEqual({ turnCov: 0, sessionCov: 0, injectedLines: 0 });
    expect(r.firstOrderDrop.unknown.turnCov).toBeCloseTo(1, 10);
  });

  it("空注入 = 0：不抛错，覆盖率 null，各桶 lines 归零", () => {
    const r = attributeInjectedLines({ hits: [], resolve: () => null, goldTurnIds: ["s1#t1"] });

    expect(r.injectedLines).toBe(0);
    expect(r.turnCov).toBeNull();
    expect(r.sessionCov).toBeNull();
    for (const t of INJECT_LINE_TYPES) {
      expect(r.byType[t]).toEqual({ lines: 0, goldLines: 0, sessions: 0 });
      expect(r.coverageWithout[t]).toEqual({ turnCov: null, sessionCov: null, injectedLines: 0 });
      expect(r.firstOrderDrop[t]).toEqual({ turnCov: null, sessionCov: null });
    }
  });

  it("gold 为空：覆盖率 null（不产出 0 误导），未解析行只算行数", () => {
    const r = attributeInjectedLines({
      hits: [{ type: "结论", clean: "a" }, { type: "episodic", clean: "b" }],
      resolve: () => null,
      goldTurnIds: [],
    });
    expect(r.injectedLines).toBe(2);
    expect(r.turnCov).toBeNull();
    expect(r.sessionCov).toBeNull();
    expect(r.byType.conclusion.lines).toBe(1);
    expect(r.byType.conclusion.goldLines).toBe(0);
  });

  it("resolve 抛错不中断归因；未解析行不计入覆盖", () => {
    const r = attributeInjectedLines({
      hits: [{ type: "结论", clean: "boom" }, { type: "episodic", clean: "ok" }],
      resolve: (c) => {
        if (c === "boom") throw new Error("resolver 炸了");
        return "s1#t1";
      },
      goldTurnIds: ["s1#t1", "s2#t2"],
    });
    expect(r.injectedLines).toBe(2);
    expect(r.byType.conclusion.goldLines).toBe(0);
    expect(r.byType["raw-turn"].goldLines).toBe(1);
    expect(r.turnCov).toBeCloseTo(0.5, 10);
  });

  it("session 归属：缺省按 :: / # 前缀，可被 sessionOf 覆盖", () => {
    const hits = [
      { type: "结论", clean: "a" },
      { type: "episodic", clean: "b" },
    ];
    const resolve = (c: string) => (c === "a" ? "alpha::1" : "beta#2");

    // goldSessions 由 goldTurnIds 推导 = {alpha, gamma}；注入侧命中 alpha → 1/2
    const dflt = attributeInjectedLines({ hits, resolve, goldTurnIds: ["alpha::1", "gamma::3"] });
    expect(dflt.sessionCov).toBeCloseTo(0.5, 10);
    expect(dflt.turnCov).toBeCloseTo(0.5, 10);

    // 无 `::` / `#` 时缺省取整串；自定义 sessionOf 切成前缀后同一 gold 侧被命中
    const noSep = [
      { type: "结论", clean: "a" },
      { type: "episodic", clean: "b" },
    ];
    const resolveNoSep = (c: string) => (c === "a" ? "x-alpha-1" : "y-beta-2");
    const raw = attributeInjectedLines({ hits: noSep, resolve: resolveNoSep, goldTurnIds: ["x-alpha-1", "x-gamma-3"] });
    expect(raw.sessionCov).toBeCloseTo(0.5, 10);

    const custom = attributeInjectedLines({
      hits: noSep,
      resolve: resolveNoSep,
      goldTurnIds: ["x-alpha-1", "x-gamma-3"],
      sessionOf: (id: string) => String(id).slice(0, 2), // x- / y-
    });
    expect(custom.sessionCov).toBeCloseTo(1, 10);
  });
});

describe("evidenceSufficiency", () => {
  it("英文：停用词不进分母，覆盖 4/5", () => {
    const r = evidenceSufficiency({
      goldAnswer: "The deployment window is Wednesday 18 for payment",
      evidence: "[1] deployment window Wednesday 18\n[2] totally different",
    });
    expect(r.goldTokens).toBe(5); // deployment/window/wednesday/18/payment（the/is/for 已过滤）
    expect(r.coveredTokens).toBe(4);
    expect(r.score).toBeCloseTo(0.8, 10);
    expect(r.missing).toEqual(["payment"]);
    expect(r.missing).not.toContain("the");
    expect(r.missing).not.toContain("for");
  });

  it("中文：连续汉字按 2-gram，覆盖 4/5", () => {
    const r = evidenceSufficiency({
      goldAnswer: "周三部署支付",
      evidence: "[1] 用户说周三要部署支付服务",
    });
    expect(r.goldTokens).toBe(5); // 周三/三部/部署/署支/支付
    expect(r.coveredTokens).toBe(4);
    expect(r.score).toBeCloseTo(0.8, 10);
    expect(r.missing).toEqual(["三部"]);
  });

  it("数字不做子串匹配（8080 不被 8081 覆盖）", () => {
    const r = evidenceSufficiency({ goldAnswer: "port 8080", evidence: "port 8081" });
    expect(r.goldTokens).toBe(2);
    expect(r.coveredTokens).toBe(1);
    expect(r.score).toBeCloseTo(0.5, 10);
    expect(r.missing).toEqual(["8080"]);
  });

  it("goldAnswer 支持数组（多段 gold 拼接）", () => {
    const r = evidenceSufficiency({ goldAnswer: ["周三部署", "支付"], evidence: "支付" });
    expect(r.goldTokens).toBe(4); // 周三/三部/部署 + 支付
    expect(r.missing).toEqual(["周三", "三部", "部署"]);
    expect(r.score).toBeCloseTo(0.25, 10);
  });

  it("goldTokens=0 → score null（纯停用词 gold 不产生虚假 0 分）", () => {
    const r = evidenceSufficiency({ goldAnswer: "the is a of and or", evidence: "任意证据" });
    expect(r.goldTokens).toBe(0);
    expect(r.score).toBeNull();
    expect(r.missing).toEqual([]);
  });

  it("evidence 空 → score null，missing 列出全部 gold token", () => {
    const r = evidenceSufficiency({ goldAnswer: "port 8080", evidence: "" });
    expect(r.score).toBeNull();
    expect(r.coveredTokens).toBe(0);
    expect(r.missing).toEqual(["port", "8080"]);
  });

  it("missing 最多 20 个", () => {
    const gold = Array.from({ length: 30 }, (_, i) => `token${i + 10}`).join(" ");
    const r = evidenceSufficiency({ goldAnswer: gold, evidence: "nothing" });
    expect(r.goldTokens).toBe(30);
    expect(r.missing).toHaveLength(20);
  });
});

describe("attributeRows", () => {
  it("逐行复用两个度量，并跨题汇总分桶行数", () => {
    const rows = [
      {
        caseId: "c1",
        rawHits: [{ type: "结论", clean: "a" }],
        evidence: "[1] payment",
        gold: "payment",
      },
      {
        caseId: "c2",
        rawHits: [{ type: "episodic", clean: "b" }, { type: "上下文|A", clean: "c" }],
        evidence: "[1] unrelated text",
        gold: "payment service",
      },
    ];
    const goldByCaseId = {
      c1: { turnIds: ["s1#t1"] },
      c2: { turnIds: ["s2#t2"] },
    };
    const resolveByCaseId = {
      c1: (clean: string) => (clean === "a" ? "s1#t1" : null),
      c2: (clean: string) => (clean === "b" ? "s2#t2" : null),
    };

    const out = attributeRows(rows, { goldByCaseId, resolveByCaseId });

    expect(out.rows).toHaveLength(2);
    expect(out.byCaseId.get("c1").lineTypeStats.turnCov).toBeCloseTo(1, 10);
    expect(out.byCaseId.get("c2").lineTypeStats.turnCov).toBeCloseTo(1, 10);
    expect(out.byTypeTotal.conclusion).toEqual({ lines: 1, goldLines: 1, sessions: 1 });
    expect(out.byTypeTotal["raw-turn"]).toEqual({ lines: 1, goldLines: 1, sessions: 1 });
    expect(out.byTypeTotal["evidence-recall"]).toEqual({ lines: 1, goldLines: 0, sessions: 0 });
    expect(out.byTypeTotal.unknown).toEqual({ lines: 0, goldLines: 0, sessions: 0 });
    // 证据充分性随行返回：c1 全覆盖，c2 未覆盖
    expect(out.byCaseId.get("c1").evidenceSufficiency.score).toBeCloseTo(1, 10);
    expect(out.byCaseId.get("c2").evidenceSufficiency.score).toBeCloseTo(0, 10);
  });

  it("memoryLines 形态（无 rawHits）也能归因；生产 hits 计数形态不抛错", () => {
    const out = attributeRows(
      [
        { caseId: "m1", memoryLines: ["- [结论|场景A] 内容A"], gold: "内容A" },
        { caseId: "m2", hits: 3, gold: "x" }, // 生产 row 只落 hits 计数 → 无行可归因
      ],
      {
        goldByCaseId: { m1: { turnIds: ["s1#t1"] }, m2: { turnIds: ["s2#t2"] } },
        resolveByCaseId: { m1: (clean: string) => (clean === "内容A" ? "s1#t1" : null) },
      },
    );

    expect(out.byTypeTotal.conclusion.lines).toBe(1);
    expect(out.byTypeTotal.conclusion.goldLines).toBe(1);
    expect(out.rows[1].lineTypeStats.injectedLines).toBe(0);
    expect(out.rows[1].lineTypeStats.turnCov).toBeNull();
  });

  it("缺 gold / 缺 resolve 时退化安全（不抛错、覆盖率 null）", () => {
    const out = attributeRows([{ caseId: "z1", rawHits: [{ type: "episodic", content: "- [episodic] x" }] }]);
    expect(out.rows[0].lineTypeStats.injectedLines).toBe(1);
    expect(out.rows[0].lineTypeStats.turnCov).toBeNull();
    expect(out.rows[0].lineTypeStats.byType["raw-turn"].lines).toBe(1);
    expect(out.byTypeTotal["raw-turn"].lines).toBe(1);
  });
});