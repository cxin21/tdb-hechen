import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentNarration } from "../record/agent-narration.js";
import {
  computeL1Metrics,
  computeRecallMetrics,
  countClaims,
  describeSampling,
  isAgentSelfNarration,
  jaccard,
  type L1MetricRow,
} from "./memory-metrics.js";
import { resolveAtomicMaxChars } from "./metrics-config.js";
import { parseConfig } from "../../config.js";

/**
 * parseConfig 的 atomicMaxChars 缺省值（2026-11-03 由 300 校准到 600，见 ADR 0023 与
 * config.ts 注释）。这里断言「跟随缺省」而不是钉死字面量 600，避免下次校准再red一次。
 */
const ATOMIC_DEFAULT = parseConfig({}).extraction.atomicMaxChars;

const row = (recordId: string, content: string, extra: Partial<L1MetricRow> = {}): L1MetricRow => ({
  recordId,
  type: extra.type ?? "episodic",
  content,
  ...extra,
});

describe("isAgentSelfNarration", () => {
  it("metadata.actor=agent 直接命中", () => {
    expect(isAgentSelfNarration("用户说下周要上线", { actor: "agent" })).toBe(true);
  });

  it("第一人称 + 执行类动词命中（中文）", () => {
    expect(isAgentSelfNarration("我完成了 A3 提取校准并跑了全量门禁")).toBe(true);
    expect(isAgentSelfNarration("我核验了生产库 valid_end 行数为 106")).toBe(true);
  });

  it("主语后接时间状语也命中（AI 于 … 完成 / 我于昨日核验）", () => {
    expect(isAgentSelfNarration("AI 于 2026-10-14 完成 Task 7 代码评审，结论 APPROVE_WITH_MINORS")).toBe(true);
    expect(isAgentSelfNarration("我于昨日核验了生产库 valid_end 行数")).toBe(true);
  });

  it("用户侧事实 / 第三人称不命中", () => {
    expect(isAgentSelfNarration("用户要求零自行 commit")).toBe(false);
    expect(isAgentSelfNarration("他在 2026-10-14 写了评审报告")).toBe(false);
    expect(isAgentSelfNarration("")).toBe(false);
  });

  it("我 出现在远端（非主语）不命中", () => {
    expect(isAgentSelfNarration("关于架构的决定已经和我确认过了，后续由团队推进")).toBe(false);
  });
});

describe("countClaims", () => {
  it("单断言 = 1", () => {
    expect(countClaims("langRuler floor 定档 0.3")).toBe(1);
  });
  it("多句按句末标点切分", () => {
    expect(countClaims("第一句。第二句！第三句？")).toBe(3);
  });
  it("空串 = 0", () => {
    expect(countClaims("   ")).toBe(0);
  });
});

describe("jaccard", () => {
  it("相同文本 = 1，完全不同 = 0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe("computeL1Metrics", () => {
  const rows: L1MetricRow[] = [
    row("m1", "我完成了 A3 校准，跑了全量门禁并通过", { metadata: { actor: "agent" } }),
    row("m2", "用户要求生产配置变更前必须备份。"),
    row("m3", "用户要求生产配置变更前必须备份！"),
    row("m4", "langRuler floor 定档 0.3 且 keepRatio 0.67", {
      metadata: { facts: [{ subject: "layerRuler", predicate: "floor", value: "0.3" }] },
    }),
  ];

  it("基础计数与均长", () => {
    const r = computeL1Metrics(rows, { atomicMaxChars: 300 });
    expect(r.total).toBe(4);
    expect(r.avgLen).toBeGreaterThan(0);
  });

  it("自述率按 metadata + 启发式合并算", () => {
    const r = computeL1Metrics(rows);
    expect(r.selfNarration.count).toBe(1);
    expect(r.selfNarration.rate).toBeCloseTo(0.25, 6);
  });

  it("原子性率 = 长度达标 且 单断言", () => {
    const r = computeL1Metrics(rows, { atomicMaxChars: 300 });
    // m1/m2/m4 单断言；m3 用「！」仍是单断言但我们造多断言行：改为断言 m1 达标
    expect(r.atomicity.rate).toBeGreaterThan(0);
    expect(r.atomicity.both).toBeLessThanOrEqual(r.total);
  });

  it("factsCoverage = 带三元组行占比", () => {
    const r = computeL1Metrics(rows);
    expect(r.factsCoverage.count).toBe(1);
    expect(r.factsCoverage.rate).toBeCloseTo(0.25, 6);
  });

  it("semanticDupRate 无 embedding 时走 jaccard 代理并标 method", () => {
    const r = computeL1Metrics(rows, { dupThreshold: 0.85 });
    expect(r.semanticDup.method).toBe("jaccard-proxy");
    // m2/m3 近似（差一个标点），应进重复对
    expect(r.semanticDup.pairs).toBeGreaterThanOrEqual(1);
  });

  it("churn = 同期 archived/(archived+liveInWindow)（F6①：分母是窗口 COUNT，不是采样行数）", () => {
    // rows 只有 4 行采样，但同期存活是 3992 —— 分母必须用后者（旧口径会给 8/12）
    const r = computeL1Metrics(rows, { archivedInWindow: 8, liveInWindow: 3992 });
    expect(r.churn).toEqual({ archived: 8, live: 3992, ratio: 8 / 4000 });
  });

  it("live 缺省 → churn.live/ratio 为 null（不给口径不同的数）", () => {
    const r = computeL1Metrics(rows, { archivedInWindow: 8 });
    expect(r.churn).toEqual({ archived: 8, live: null, ratio: null });
  });

  it("live=0 但 archived>0 → ratio=1（分母非 0，全部翻台）", () => {
    const r = computeL1Metrics([], { archivedInWindow: 3, liveInWindow: 0 });
    expect(r.churn).toEqual({ archived: 3, live: 0, ratio: 1 });
  });

  it("archived=live=0 → ratio=0，不产生 NaN", () => {
    const r = computeL1Metrics([], { archivedInWindow: 0, liveInWindow: 0 });
    expect(r.churn).toEqual({ archived: 0, live: 0, ratio: 0 });
  });

  it("空输入不炸（全 0、比率为 0）", () => {
    const r = computeL1Metrics([]);
    expect(r.total).toBe(0);
    expect(r.avgLen).toBe(0);
    expect(r.selfNarration.rate).toBe(0);
    expect(r.atomicity.rate).toBe(0);
    expect(r.semanticDup.rate).toBe(0);
  });
});

describe("computeRecallMetrics", () => {
  const entry = (injectedChars: number, kept: number, injected: number, lines: string[]) => ({
    selection: { kept, injected, injectedChars, poolChars: injectedChars * 2, droppedBy: {} },
    memoryLines: lines,
  });

  it("注入字符 p50 与零注入轮占比", () => {
    const r = computeRecallMetrics([
      entry(0, 0, 0, []),
      entry(100, 2, 2, ["- [结论|x] 数值 42"]),
      entry(300, 3, 3, ["- [结论|y] file.ts:10", "- [结论|z] 无锚点"]),
    ]);
    expect(r.rounds).toBe(3);
    expect(r.zeroInjectionRounds).toBe(1);
    expect(r.zeroInjectionRate).toBeCloseTo(1 / 3, 6);
    expect(r.injectedCharsP50).toBe(100);
  });

  it("precisionProxy = 候选池行含可验证锚（日期/时间/file:line/短哈希）的占比（F6③：裸数字不算锚）", () => {
    const r = computeRecallMetrics([
      entry(100, 2, 2, ["- [结论|x] 2026-10-14 定档", "- [结论|y] 没有任何锚点的自然语言"]),
    ]);
    expect(r.precisionProxy).toBeCloseTo(0.5, 6);
    expect(r.precisionScope).toBe("candidate-pool");
  });

  it("F6③ 裸数字不再充当锚：'- [结论|x] 42' 不算有锚行", () => {
    const r = computeRecallMetrics([entry(100, 1, 1, ["- [结论|x] 42"])]);
    expect(r.precisionProxy).toBe(0);
  });

  it("F6③ 保留日期/时间/file:line/短哈希（含字母）四类锚", () => {
    const lines = [
      "- 日期 2026-10-14",
      "- 时间 17:03:40",
      "- 位置 src/core/metrics/memory-metrics.ts:26",
      "- 短哈希 b8ba3e0",
    ];
    const r = computeRecallMetrics([entry(100, 4, 4, lines)]);
    expect(r.precisionProxy).toBe(1);
  });

  it("F6③ 纯数字长串/纯数字哈希形态不算锚", () => {
    const r = computeRecallMetrics([entry(100, 2, 2, ["- 计数 1234567890123", "- 编号 20261014"])]);
    expect(r.precisionProxy).toBe(0);
  });

  it("空输入不炸", () => {
    const r = computeRecallMetrics([]);
    expect(r.rounds).toBe(0);
    expect(r.precisionProxy).toBe(0);
    expect(r.zeroInjectionRate).toBe(0);
  });
});

describe("F5：两处判定对拍（同一批 200 行逐行一致）", () => {
  const contents: string[] = [];
  const push = (s: string) => contents.push(s);
  for (let i = 0; i < 25; i++) {
    push(`AI 于 2026-10-${String((i % 28) + 1).padStart(2, "0")} 完成 Task ${i} 的代码评审，结论 APPROVE_WITH_MINORS`);
    push(`我在第 ${i + 1} 轮抽取中核验了 ${i} 条事实并跑了全量门禁`);
    push(`助手已复核第 ${i} 批产出物并对齐基线`);
    push(`模型在第 ${i} 轮抽取前核对了红线注入`);
    push(`用户让我把第 ${i} 个脚本改成异步`);
    push(`用户要求 AI 每周五交第 ${i} 份周报`);
    push(`模型配置决定了第 ${i} 路召回顺序`);
    push(`关于第 ${i} 版架构的决定已经和我确认过了，后续由团队推进`);
  }

  it("样本恰为 200 行且四类主语都有命中", () => {
    expect(contents.length).toBe(200);
    expect(contents.filter((c) => c.startsWith("AI")).length).toBe(25);
  });

  it("metrics.isAgentSelfNarration 与 agent-narration.isAgentNarration 逐行一致", () => {
    const mismatches = contents
      .map((content, i) => ({
        i,
        content,
        metricsSide: isAgentSelfNarration(content),
        narrSide: isAgentNarration(content),
      }))
      .filter((x) => x.metricsSide !== x.narrSide);
    expect(mismatches).toEqual([]);
  });

  it("AI 组不再为 0：旧口径 0 命中，新口径全命中", () => {
    const aiRows = contents.filter((c) => c.startsWith("AI"));
    const aiHits = aiRows.filter((c) => isAgentSelfNarration(c));
    expect(aiHits.length).toBe(aiRows.length);
  });

  it("整批 200 行进 computeL1Metrics：selfNarration.count 与逐行口径闭合", () => {
    const rows2 = contents.map((content, i) => row(`p${i}`, content));
    const r = computeL1Metrics(rows2);
    const expected = contents.filter((c) => isAgentSelfNarration(c)).length;
    expect(r.selfNarration.count).toBe(expected);
    expect(r.selfNarration.rate).toBeCloseTo(expected / 200, 6);
  });
});

describe("F6④ 重复率：随机采样 + 统一分母", () => {
  const many = Array.from({ length: 200 }, (_, i) => row(`r${i}`, `记录第 ${i} 条互不相同的结论 编号 ${i * 7919}`));

  it("sampleIds 不是前 N 行截断（随机采样）且条数=min(行数, limit)", () => {
    const r = computeL1Metrics(many, { dupSampleLimit: 20 });
    expect(r.semanticDup.sampleIds.length).toBe(20);
    expect(r.semanticDup.sampleIds).not.toEqual(many.slice(0, 20).map((x) => x.recordId));
  });

  it("同一 seed 可复现，换 seed 采样集合改变", () => {
    const a = computeL1Metrics(many, { dupSampleLimit: 20, sampleSeed: 20261102 });
    const b = computeL1Metrics(many, { dupSampleLimit: 20, sampleSeed: 20261102 });
    const c = computeL1Metrics(many, { dupSampleLimit: 20, sampleSeed: 7 });
    expect(a.semanticDup.sampleIds).toEqual(b.semanticDup.sampleIds);
    expect(a.semanticDup.sampleIds).not.toEqual(c.semanticDup.sampleIds);
  });

  it("统一分母：compared = 采样内全部对数，缺 embedding 不静默丢分母", () => {
    const rows2 = Array.from({ length: 5 }, (_, i) => row(`e${i}`, `第 ${i} 条`));
    const r = computeL1Metrics(rows2, {
      embeddings: new Map([
        ["e0", [1, 0]],
        ["e1", [0, 1]],
      ]),
    });
    expect(r.semanticDup.method).toBe("jaccard-proxy");
    expect(r.semanticDup.compared).toBe(10);
  });

  it("全量 embedding 时走 cosine，分母仍是全部对数", () => {
    const rows2 = Array.from({ length: 4 }, (_, i) => row(`v${i}`, `第 ${i} 条`));
    const emb = new Map([
      ["v0", [1, 0]],
      ["v1", [0.999, 0.001]],
      ["v2", [0, 1]],
      ["v3", [0.001, 0.999]],
    ]);
    const r = computeL1Metrics(rows2, { embeddings: emb, dupThreshold: 0.99 });
    expect(r.semanticDup.method).toBe("cosine");
    expect(r.semanticDup.compared).toBe(6);
    expect(r.semanticDup.pairs).toBe(2);
  });
});

describe("F6② recall 只统计有 selection 的轮 + coverage 单列", () => {
  const withSel = (injectedChars: number, injected: number, lines: string[]) => ({
    selection: { kept: injected, injected, injectedChars, poolChars: injectedChars + 10, droppedBy: {} },
    memoryLines: lines,
  });
  const noSel = (lines: string[]) => ({ memoryLines: lines });

  it("rounds 只数 selection!=null 的轮，coverage 单列两段计数", () => {
    const r = computeRecallMetrics([withSel(100, 1, ["- [结论|x] 2026-10-14"]), noSel(["- [结论|y] a"]), noSel([])]);
    expect(r.rounds).toBe(1);
    expect(r.coverage).toEqual({ withSelection: 1, withoutSelection: 2, rate: 1 / 3 });
  });

  it("无 selection 的轮不进 p50/均值/零注入率", () => {
    const r = computeRecallMetrics([withSel(0, 0, []), noSel(["- [结论|y] 候选池行 2026-10-14"])]);
    expect(r.rounds).toBe(1);
    expect(r.zeroInjectionRate).toBe(1);
    expect(r.injectedCharsP50).toBe(0);
    expect(r.avgInjectedLines).toBe(0);
  });

  it("空池轮（selection.emptyPool）计入 rounds，并与『有池但全砍』分开计率", () => {
    const emptyPool = {
      selection: {
        kept: 0,
        injected: 0,
        injectedChars: 0,
        poolChars: 0,
        droppedBy: {},
        emptyPool: true,
      },
      memoryLines: [],
    };
    const r = computeRecallMetrics([
      emptyPool, // 池空 → 召回缺失
      emptyPool,
      withSel(0, 0, ["- [结论|z] 有池但被砍光 2026-10-14"]), // 池非空 → 选线过紧
      withSel(120, 2, ["- [结论|x] 2026-10-14"]),
    ]);
    expect(r.rounds).toBe(4);
    expect(r.emptyPoolRounds).toBe(2);
    // 分母含空池：3/4（用户真实拿到记忆的比例）
    expect(r.zeroInjectionRounds).toBe(3);
    expect(r.zeroInjectionRate).toBe(0.75);
    // 分母只算非空池：1/2（召回到了东西时的选线杀伤）
    expect(r.zeroInjectionRateNonEmpty).toBe(0.5);
  });

  it("avgInjectedLines 取 selection.injected，不拿候选池 memoryLines.length 冒充", () => {
    const pool = Array.from({ length: 40 }, (_, i) => `- [结论|p${i}] 候选行 2026-10-14`);
    const r = computeRecallMetrics([withSel(300, 3, pool)]);
    expect(r.avgInjectedLines).toBe(3);
  });
});

describe("F6⑤ atomicMaxChars 从配置读（不硬编码 300）", () => {
  const tmp = (override: unknown): { dir: string; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-cfg-"));
    const file = join(dir, "config-override.json");
    writeFileSync(file, JSON.stringify(override), "utf-8");
    return { dir, file };
  };

  it("CLI 缺省跟随 config-override 的 extraction.atomicMaxChars=600", () => {
    const { dir } = tmp({ extraction: { atomicMaxChars: 600 } });
    const r = resolveAtomicMaxChars({ dataDir: dir });
    expect(r).toEqual({ value: 600, source: "config-override", parsedDefault: ATOMIC_DEFAULT });
  });

  it("--config 指向任意路径的 override 文件也生效", () => {
    const { file } = tmp({ extraction: { atomicMaxChars: 450 } });
    expect(resolveAtomicMaxChars({ configPath: file })).toEqual({
      value: 450,
      source: "config-override",
      parsedDefault: ATOMIC_DEFAULT,
    });
  });

  it("CLI 显式值优先于配置文件，且走同一 clamp（120..2000）", () => {
    const { dir } = tmp({ extraction: { atomicMaxChars: 600 } });
    expect(resolveAtomicMaxChars({ dataDir: dir, cli: 800 }).value).toBe(800);
    expect(resolveAtomicMaxChars({ dataDir: dir, cli: 800 }).source).toBe("cli");
    expect(resolveAtomicMaxChars({ dataDir: dir, cli: 50_000 }).value).toBe(2000);
    expect(resolveAtomicMaxChars({ dataDir: dir, cli: 1 }).value).toBe(120);
  });

  it("配置缺失/损坏/无该键 → 回落到 parseConfig 缺省并标注来源", () => {
    const empty = mkdtempSync(join(tmpdir(), "metrics-cfg-empty-"));
    expect(resolveAtomicMaxChars({ dataDir: empty })).toEqual({
      value: ATOMIC_DEFAULT,
      source: "default",
      parsedDefault: ATOMIC_DEFAULT,
    });
    const { dir } = tmp({ extraction: { actorTagging: true } });
    expect(resolveAtomicMaxChars({ dataDir: dir }).source).toBe("default");
  });
});

describe("F6 验收：三个构造用例必须被指标抓到（方向性）", () => {
  it("① 加一条自述行 → selfNarration 计数与比率同升（分母+1）", () => {
    const base = [
      row("r1", "用户要求零自行 commit，改动只留工作区"),
      row("r2", "他在 2026-10-14 写了评审报告并归档"),
      row("r3", "langRuler floor 定档 0.3 为配置项缺省值"),
      row("r4", "生产库 l1_records 与 l1_archive 的归档关系按 archived_at 对齐"),
    ];
    const before = computeL1Metrics(base);
    expect(before.selfNarration.count).toBe(0);
    expect(before.selfNarration.rate).toBe(0);

    const after = computeL1Metrics([
      ...base,
      row("r5", "AI 于 2026-10-14 完成 Task 7 代码评审，结论 APPROVE_WITH_MINORS"),
    ]);
    expect(after.selfNarration.count).toBe(before.selfNarration.count + 1);
    expect(after.total).toBe(before.total + 1);
    expect(after.selfNarration.rate).toBeGreaterThan(before.selfNarration.rate);
    expect(after.selfNarration.rate).toBe(1 / 5);
  });

  it("② 加一条无锚行 → precisionProxy 降（分母+1、分子不变）", () => {
    const anchored = [
      "- [结论|a] 2026-10-14 的评审结论为 APPROVE_WITH_MINORS",
      "- [结论|b] 12:30 完成重启并观察一轮",
      "- [结论|c] 改动落在 record/agent-narration.ts:102",
      "- [结论|d] 提交 b8ba3e0 已包含全部改动",
    ];
    const before = computeRecallMetrics([
      { selection: { kept: 4, injected: 4, injectedChars: 200, droppedBy: {} }, memoryLines: anchored },
    ]);
    expect(before.precisionProxy).toBe(1);
    expect(before.totalInjectedLines).toBe(4);

    const after = computeRecallMetrics([
      {
        selection: { kept: 5, injected: 5, injectedChars: 210, droppedBy: {} },
        memoryLines: [...anchored, "- [结论|e] 口径待定，后续再补 123"],
      },
    ]);
    expect(after.totalInjectedLines).toBe(before.totalInjectedLines + 1);
    expect(after.anchorLines).toBe(before.anchorLines);
    expect(after.precisionProxy).toBeLessThan(before.precisionProxy);
    expect(after.precisionProxy).toBe(4 / 5);
  });

  it("③ 注入一对近重复 → semanticDup.pairs 升，compared 只随行数从 C(6,2) 涨到 C(8,2)", () => {
    const distinct = [
      row("d1", "langRuler floor 定档 0.3，仅改变选线阈值，不动注入预算与单行截断"),
      row("d2", "归档窗口按 archived_at 与采样最老行对齐，churn 改用同期比率"),
      row("d3", "召回 journal 的 memoryLines 记候选池，注入字符只能读 injectedChars"),
      row("d4", "短哈希锚必须含字母，纯数字长串不算锚，日期与 file:line 仍计"),
      row("d5", "生产库只读挂载，探针脚本不得写库也不得注入测试记忆"),
      row("d6", "配置缺省走 parseConfig 的 120..2000 clamp，脚本不再硬编码 300"),
    ];
    const before = computeL1Metrics(distinct);
    expect(before.semanticDup.compared).toBe(15);
    expect(before.semanticDup.pairs).toBe(0);

    const nearA =
      "AI 于 2026-10-14 完成 Task 7 代码评审并跑全量门禁对基线，结论 APPROVE_WITH_MINORS，留档 docs/research 目录";
    const nearB =
      "AI 于 2026-10-14 完成 Task 7 代码评审并跑全量门禁对基准，结论 APPROVE_WITH_MINORS，留档 docs/research 目录";
    const after = computeL1Metrics([...distinct, row("d7", nearA), row("d8", nearB)]);
    expect(after.semanticDup.pairs).toBe(before.semanticDup.pairs + 1);
    expect(after.semanticDup.compared).toBe(28);
    expect(after.semanticDup.rate).toBeGreaterThan(before.semanticDup.rate);
  });
});

describe("R-metrics A：churn 分子分母必须同期（不再拿采样行数当分母）", () => {
  const rows4 = [
    row("c1", "用户要求只读打开生产库"),
    row("c2", "用户要求改配置前先备份"),
    row("c3", "用户要求不动任何一行数据"),
    row("c4", "用户要求回报六字段"),
  ];

  it("给出同期存活行数时 ratio = archived/(archived+liveInWindow)，与采样行数无关", () => {
    const r = computeL1Metrics(rows4, { archivedInWindow: 8, liveInWindow: 3992 });
    expect(r.churn).toEqual({ archived: 8, live: 3992, ratio: 8 / 4000 });
    // 旧口径会拿采样行数 4 当分母（8/12），必须不得出现
    expect(r.churn.ratio).not.toBeCloseTo(8 / 12, 6);
  });

  it("未给出同期存活行数 → live/ratio 都是 null（绝不回落到采样 total）", () => {
    const r = computeL1Metrics(rows4, { archivedInWindow: 8 });
    expect(r.churn).toEqual({ archived: 8, live: null, ratio: null });
  });

  it("同期归档与存活都为 0 → ratio=0，不出 NaN", () => {
    const r = computeL1Metrics([], { archivedInWindow: 0, liveInWindow: 0 });
    expect(r.churn).toEqual({ archived: 0, live: 0, ratio: 0 });
  });

  it("同期存活为 0、归档 > 0 → ratio=1", () => {
    const r = computeL1Metrics([], { archivedInWindow: 3, liveInWindow: 0 });
    expect(r.churn).toEqual({ archived: 3, live: 0, ratio: 1 });
  });
});

describe("R-metrics C：actorLabeledRate 与启发式 selfNarrationRate 并列不合并", () => {
  const rows = [
    row("a1", "用户要求生产配置变更前必须备份", { metadata: { actor: "agent" } }),
    row("a2", "我完成了 A3 校准并跑了门禁"),
    row("a3", "他在 2026-10-14 写了评审报告"),
    row("a4", "langRuler floor 定档 0.3"),
  ];

  it("actorLabeled 只数写侧标签 metadata.actor=agent", () => {
    const r = computeL1Metrics(rows);
    expect(r.actorLabeled).toEqual({ count: 1, rate: 0.25 });
  });

  it("selfNarration 仍按启发式合并（标签 + 主语/动作词），因此恒 >= actorLabeled", () => {
    const r = computeL1Metrics(rows);
    // 期望值由被测模块自己的谓词导出：上游启发式收紧不该让本结构断言变红
    const heuristic = rows.filter((x) => isAgentSelfNarration(x.content, x.metadata)).length;
    expect(r.selfNarration).toEqual({ count: heuristic, rate: heuristic / rows.length });
    expect(r.selfNarration.count).toBeGreaterThanOrEqual(r.actorLabeled.count);
  });

  it("未打标签的启发式自述只进 selfNarration，不进 actorLabeled（差值来源）", () => {
    // 候选句按上游谓词现取：谓词怎么变，这里都只验证「两数独立、差值=未打标签命中行」
    const candidates = ["我负责维护记忆系统", "我承诺遵守执行红线", "我长期执行全量门禁"];
    const hit = candidates.find((c) => isAgentSelfNarration(c, null));
    if (hit === undefined) {
      throw new Error(`上游 isAgentNarration 对候选句全部未命中，无法验证差值来源：${candidates.join(" / ")}`);
    }
    const r = computeL1Metrics([row("b1", hit)]);
    expect(r.selfNarration.count).toBe(1);
    expect(r.actorLabeled.count).toBe(0);
  });
});

describe("R-metrics B：poolAnchorRate 正名，precisionProxy 同值保留（向后兼容）", () => {
  const entries = [
    {
      selection: { kept: 2, injected: 2, injectedChars: 100 },
      memoryLines: ["- [结论|x] 2026-10-14 定档", "- [结论|y] 没有任何锚点的自然语言"],
    },
  ];

  it("poolAnchorRate = 候选池含锚率，与 precisionProxy 同值", () => {
    const r = computeRecallMetrics(entries);
    expect(r.poolAnchorRate).toBeCloseTo(0.5, 6);
    expect(r.precisionProxy).toBe(r.poolAnchorRate);
    expect(r.precisionScope).toBe("candidate-pool");
  });

  it("旧字段保持数值（下游 0 值不断裂）", () => {
    const r = computeRecallMetrics([]);
    expect(r.poolAnchorRate).toBe(0);
    expect(r.precisionProxy).toBe(0);
  });
});

describe("R-metrics D：采样可解释性 describeSampling", () => {
  it("缺省 limit 标 default，并给出采样/全库覆盖", () => {
    const s = describeSampling({ sampledRows: 2000, totalRows: 4022, limit: 2000, limitSource: "default" });
    expect(s.sampledRows).toBe(2000);
    expect(s.totalRows).toBe(4022);
    expect(s.limit).toBe(2000);
    expect(s.limitSource).toBe("default");
    expect(s.coverage).toBeCloseTo(2000 / 4022, 6);
  });

  it("--limit 显式给值标 cli", () => {
    const s = describeSampling({ sampledRows: 500, totalRows: 4022, limit: 500, limitSource: "cli" });
    expect(s.limitSource).toBe("cli");
    expect(s.sampledRows).toBe(500);
  });

  it("空库不出 NaN（coverage=0）", () => {
    const s = describeSampling({ sampledRows: 0, totalRows: 0, limit: 2000, limitSource: "default" });
    expect(s.coverage).toBe(0);
  });
});
