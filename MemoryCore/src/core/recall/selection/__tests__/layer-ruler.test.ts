/**
 * #179 S1：层内相对尺子（layer-ruler）——纯函数合同。
 *
 * RED 先行（2026-11-02）：本文件先于实现落盘，首跑必红（模块不存在），
 * 用于钉死「层内按名次取前 keepRatio / 每层至少 minPerLayer / 层间不竞争 /
 * 逐条 droppedBy 归因 / 零 IO 零时钟零随机 / 无绝对阈值常数」这六条合同。
 *
 * 口径来源：docs/specs/2026-11-02-recall-selection-layered-ruler-spec.md §4.1/§5，
 * ADR-0013（绝对 floor 不可跨题校准 → 名次切对刻度免疫）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layerRulerSelect, type LayerRulerCandidate } from "../layer-ruler.js";

const mk = (layer: string, scores: number[], base = 0): LayerRulerCandidate[] =>
  scores.map((score, i) => ({ text: `${layer}-${i}`, layer, score, order: base + i }));

const reasonsOf = (decisions: ReadonlyArray<{ kept: boolean; reason: string | null }>) =>
  decisions.filter((d) => !d.kept).map((d) => d.reason);

describe("layerRulerSelect · 层内名次切", () => {
  it("单层 5 条 keepRatio 0.67 → 留 ceil(3.35)=4，只丢最低分 1 条（reason=rank）", () => {
    const out = layerRulerSelect({
      candidates: mk("conclusion", [0.9, 0.8, 0.7, 0.6, 0.5]),
      keepRatio: 0.67,
      minPerLayer: 1,
    });
    expect(out.kept).toEqual([0, 1, 2, 3]);
    expect(out.decisions).toHaveLength(5);
    expect(out.decisions[4]).toMatchObject({ kept: false, reason: "rank" });
    expect(reasonsOf(out.decisions)).toEqual(["rank"]);
  });

  it("keepRatio 1 → 一条不裁（不裁是合法配置，不许被静默改写）", () => {
    const out = layerRulerSelect({ candidates: mk("a", [0.1, 0.2, 0.3]), keepRatio: 1, minPerLayer: 1 });
    expect(out.kept).toEqual([0, 1, 2]);
    expect(reasonsOf(out.decisions)).toEqual([]);
  });

  it("keepRatio 0 → 每层仍留 minPerLayer 条（下限优先于比例，绝不留空层）", () => {
    const out = layerRulerSelect({ candidates: mk("a", [0.9, 0.8, 0.7]), keepRatio: 0, minPerLayer: 1 });
    expect(out.kept).toEqual([0]);
    expect(reasonsOf(out.decisions)).toEqual(["rank", "rank"]);
  });

  it("minPerLayer 覆盖 ceil：2 条 keepRatio 0.34（ceil=1）+ minPerLayer 2 → 留 2", () => {
    const out = layerRulerSelect({ candidates: mk("a", [0.9, 0.1]), keepRatio: 0.34, minPerLayer: 2 });
    expect(out.kept).toEqual([0, 1]);
    expect(reasonsOf(out.decisions)).toEqual([]);
  });

  it("输出保输入序（绝不按分数重排，排序是调用方的事）", () => {
    const out = layerRulerSelect({
      candidates: [
        { text: "low", layer: "a", score: 0.1, order: 0 },
        { text: "high", layer: "a", score: 0.9, order: 1 },
        { text: "mid", layer: "a", score: 0.5, order: 2 },
      ],
      keepRatio: 0.67,
      minPerLayer: 1,
    });
    expect(out.kept).toEqual([0, 1, 2]);
  });
});

describe("layerRulerSelect · 层间不竞争", () => {
  it("两层各 4 条 keepRatio 0.67 → 各留 3（不是全局 top6：那会是 4+2）", () => {
    const candidates = [...mk("A", [0.9, 0.88, 0.86, 0.84]), ...mk("B", [0.2, 0.18, 0.16, 0.14])];
    const out = layerRulerSelect({ candidates, keepRatio: 0.67, minPerLayer: 1 });
    expect(out.kept).toEqual([0, 1, 2, 4, 5, 6]);
    expect(reasonsOf(out.decisions)).toEqual(["rank", "rank"]);
  });
});

describe("layerRulerSelect · 地板（绝对门，仅由标定产物供给）", () => {
  it("floor 有值：低于地板的逐条记 reason=floor", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.5, 0.4, 0.29, 0.2]),
      keepRatio: 1,
      minPerLayer: 1,
      floor: 0.3,
    });
    expect(out.kept).toEqual([0, 1]);
    expect(reasonsOf(out.decisions)).toEqual(["floor", "floor"]);
  });

  it("floor 全灭某层 → 该层 0 行（不补位，宁缺毋滥）", () => {
    const out = layerRulerSelect({
      candidates: [...mk("A", [0.5, 0.45]), ...mk("B", [0.1, 0.05])],
      keepRatio: 0.67,
      minPerLayer: 1,
      floor: 0.3,
    });
    expect(out.kept).toEqual([0, 1]);
    expect(out.decisions.slice(2).every((d) => d.reason === "floor")).toBe(true);
  });

  it("floor=null → 逐条不因地板丢（未标定是诚实 no-op）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.5, 0.4, 0.29, 0.2]),
      keepRatio: 1,
      minPerLayer: 1,
      floor: null,
    });
    expect(out.kept).toEqual([0, 1, 2, 3]);
  });
});

describe("layerRulerSelect · 并列与退化输入", () => {
  it("全零分：按 order 升序 tiebreak，稳定且确定", () => {
    const candidates: LayerRulerCandidate[] = [
      { text: "t0", layer: "a", score: 0, order: 5 },
      { text: "t1", layer: "a", score: 0, order: 1 },
      { text: "t2", layer: "a", score: 0, order: 3 },
      { text: "t3", layer: "a", score: 0, order: 2 },
      { text: "t4", layer: "a", score: 0, order: 4 },
    ];
    const out = layerRulerSelect({ candidates, keepRatio: 0.67, minPerLayer: 1 });
    expect(out.kept).toEqual([1, 2, 3, 4]);
    expect(out.decisions[0]).toMatchObject({ kept: false, reason: "rank" });
  });

  it("空输入 → 空输出", () => {
    expect(layerRulerSelect({ candidates: [], keepRatio: 0.67, minPerLayer: 1 })).toEqual({ kept: [], decisions: [] });
  });
});

describe("layerRulerSelect · 折叠与预算（跨层只在这里相遇）", () => {
  it("折叠谓词命中 → reason=fold，且不占名次额度", () => {
    const candidates = mk("a", [0.9, 0.8, 0.7, 0.6, 0.5]);
    const out = layerRulerSelect({
      candidates,
      keepRatio: 0.67,
      minPerLayer: 1,
      isFolded: (c) => c.text === "a-0",
    });
    // 存活 4 条 → ceil(2.68)=3
    expect(out.kept).toEqual([1, 2, 3]);
    expect(out.decisions[0]).toMatchObject({ kept: false, reason: "fold" });
    expect(reasonsOf(out.decisions)).toEqual(["fold", "rank"]);
  });

  it("fold 优先于 floor 归因（同一候选两因命中只记先命中者）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.1, 0.9]),
      keepRatio: 1,
      minPerLayer: 1,
      floor: 0.3,
      isFolded: (c) => c.text === "a-0",
    });
    expect(out.decisions[0]).toMatchObject({ kept: false, reason: "fold" });
  });

  it("budget 低于存活数 → 从最低分裁（reason=budget），层间不因此改选", () => {
    const candidates = [...mk("A", [0.9, 0.8, 0.7]), ...mk("B", [0.2, 0.1, 0.05])];
    const out = layerRulerSelect({ candidates, keepRatio: 1, minPerLayer: 1, budget: 4 });
    expect(out.kept).toEqual([0, 1, 2, 3]);
    expect(reasonsOf(out.decisions)).toEqual(["budget", "budget"]);
    expect(out.decisions[5]).toMatchObject({ kept: false, reason: "budget" });
  });

  it("budget ≥ 存活数 → 不裁", () => {
    const out = layerRulerSelect({ candidates: mk("A", [0.9, 0.8]), keepRatio: 1, minPerLayer: 1, budget: 10 });
    expect(out.kept).toEqual([0, 1]);
  });
});

describe("layerRulerSelect · 字符预算的会话份额（2026-11-04）", () => {
  // 60% 的取证来源：LME90 的 9 道 multi-session 错题里 6 道「两会话都进了候选池，
  // 注入块只有一个会话」——单轮 800–1300 字时一个会话 2–3 行就顶满 2400 字。
  const long = (tag: string, n: number, score: number, order: number) => ({
    text: tag + "x".repeat(Math.max(0, n - tag.length)),
    layer: "experience",
    score,
    order,
  });

  it("单会话候选池：份额不生效，逐位等于旧行为（装满为止）", () => {
    const candidates = [long("a", 100, 0.9, 0), long("b", 100, 0.8, 1), long("c", 100, 0.7, 2)];
    const out = layerRulerSelect({
      candidates,
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 250,
      sessionOf: () => "s1",
    });
    expect(out.kept).toEqual([0, 1]);
    expect(reasonsOf(out.decisions)).toEqual(["chars"]);
  });

  it("跨两会话：第一会话吃满 60% 后，第二会话的行仍能进（旧行为会被挤掉）", () => {
    const candidates = [long("a", 200, 0.9, 0), long("b", 200, 0.8, 1), long("c", 200, 0.7, 2), long("g", 300, 0.1, 3)];
    const sessions: Record<number, string> = { 0: "s1", 1: "s1", 2: "s1", 3: "s2" };
    const out = layerRulerSelect({
      candidates,
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 1000,
      sessionOf: (i) => sessions[i] ?? null,
    });
    // s1 份额 = 600 → 只能装 3 条里的 3×200=600（正好）
    expect(out.kept).toEqual([0, 1, 2, 3]);
    expect(out.decisions[0]).toMatchObject({ kept: true });
    expect(out.decisions[3]).toMatchObject({ kept: true });
  });

  it("跨两会话且第一会话行更长：超份额的行记 chars，第二会话保住位置", () => {
    const candidates = [long("a", 700, 0.9, 0), long("b", 700, 0.8, 1), long("g", 200, 0.2, 2)];
    const sessions: Record<number, string> = { 0: "s1", 1: "s1", 2: "s2" };
    const out = layerRulerSelect({
      candidates,
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 1000,
      sessionOf: (i) => sessions[i] ?? null,
    });
    // 份额 600：首条 700 享「首条豁免」进块；第二条 700 撞份额 → chars；g 进（200）
    expect(out.kept).toEqual([0, 2]);
    expect(reasonsOf(out.decisions)).toEqual(["chars"]);
  });

  it("无 sessionOf（缺省）→ 份额不生效（逐位旧行为）", () => {
    const candidates = [long("a", 700, 0.9, 0), long("b", 700, 0.8, 1), long("g", 200, 0.2, 2)];
    const out = layerRulerSelect({ candidates, keepRatio: 1, minPerLayer: 1, charBudget: 1000 });
    expect(out.kept).toEqual([0, 2]);
  });
});

describe("layerRulerSelect · 性质：单调变换不变", () => {
  const base = [0.62, 0.41, 0.37, 0.05, 0.9, 0.33, 0.7];
  const candidates = base.map((score, i) => ({ text: "t" + i, layer: i % 2 === 0 ? "A" : "B", score, order: i }));
  const sigmoid = (s: number) => 1 / (1 + Math.exp(-12 * (s - 0.35)));
  const transforms: Array<[string, (s: number) => number]> = [
    ["identity", (s) => s],
    ["cube", (s) => s * s * s],
    ["sigmoid", sigmoid],
  ];

  it("s / s³ / sigmoid(12(s−0.35)) 三种单调变换下选线逐位一致（含地板同变换）", () => {
    const results = transforms.map(([, f]) =>
      layerRulerSelect({
        candidates: candidates.map((c) => ({ ...c, score: f(c.score) })),
        keepRatio: 0.67,
        minPerLayer: 1,
        floor: f(0.3),
      }),
    );
    expect(results[1].kept).toEqual(results[0].kept);
    expect(results[2].kept).toEqual(results[0].kept);
  });
});

describe("layer-ruler 模块源码约束（零 IO / 零时钟 / 零随机 / 无绝对阈值常数）", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "layer-ruler.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("不出现 Date / Math.random / process / fs / fetch", () => {
    for (const bad of ["Date", "Math.random", "process.", 'from "node:fs"', "fetch("]) {
      expect(code).not.toContain(bad);
    }
  });

  it("不写绝对阈值常数（代码区不出现小数常量）", () => {
    expect(code).not.toMatch(/\b\d+\.\d+\b/);
  });
});

describe("layerRulerSelect · 相对 margin（层内相对尺，替代绝对地板）", () => {
  it("层内最佳 0.90、margin 0.10 → 0.85 留、0.50 丢（reason=margin）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.9, 0.85, 0.5]),
      keepRatio: 1,
      minPerLayer: 1,
      margin: 0.1,
    });
    expect(out.kept).toEqual([0, 1]);
    expect(out.decisions[2]).toMatchObject({ kept: false, reason: "margin" });
  });

  it("margin 按层各算各的（层 A 最佳 0.5 不因层 B 的 0.9 被清空）", () => {
    const candidates = [...mk("A", [0.5, 0.45]), ...mk("B", [0.9, 0.4])];
    const out = layerRulerSelect({ candidates, keepRatio: 1, minPerLayer: 1, margin: 0.1 });
    expect(out.kept).toEqual([0, 1, 2]);
    expect(out.decisions[3]).toMatchObject({ kept: false, reason: "margin" });
  });

  it("margin null → 不裁（缺省即今天行为）", () => {
    const out = layerRulerSelect({ candidates: mk("a", [0.9, 0.1]), keepRatio: 1, minPerLayer: 1, margin: null });
    expect(out.kept).toEqual([0, 1]);
  });

  it("floor 与 margin 同时给：floor 记因优先（先 floor 后 margin）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.9, 0.5, 0.2]),
      keepRatio: 1,
      minPerLayer: 1,
      floor: 0.3,
      margin: 0.1,
    });
    expect(out.decisions[1]).toMatchObject({ kept: false, reason: "margin" });
    expect(out.decisions[2]).toMatchObject({ kept: false, reason: "floor" });
    expect(out.kept).toEqual([0]);
  });
});

describe("layerRulerSelect · 近重复抑制（dedupe）", () => {
  const simOf = (pairs: Record<string, number>) => (i: number, j: number): number => {
    const k = i < j ? `${i}:${j}` : `${j}:${i}`;
    return pairs[k] ?? 0;
  };

  it("相似度 ≥ 阈值 → 只留名次靠前的那条（reason=dup）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.9, 0.8, 0.7]),
      keepRatio: 1,
      minPerLayer: 1,
      dedupe: { similarity: simOf({ "0:1": 0.95 }), threshold: 0.92 },
    });
    expect(out.kept).toEqual([0, 2]);
    expect(out.decisions[1]).toMatchObject({ kept: false, reason: "dup" });
  });

  it("低于阈值不折叠（0.90 < 0.92）", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.9, 0.8]),
      keepRatio: 1,
      minPerLayer: 1,
      dedupe: { similarity: simOf({ "0:1": 0.9 }), threshold: 0.92 },
    });
    expect(out.kept).toEqual([0, 1]);
  });

  it("传递性按「已留下者」判：0-1 相似、1-2 相似但 0-2 不相似 → 留 0、2", () => {
    const out = layerRulerSelect({
      candidates: mk("a", [0.9, 0.85, 0.8]),
      keepRatio: 1,
      minPerLayer: 1,
      dedupe: { similarity: simOf({ "0:1": 0.95, "1:2": 0.95, "0:2": 0.1 }), threshold: 0.92 },
    });
    expect(out.kept).toEqual([0, 2]);
  });

  it("dedupe 缺省 → 不折叠（缺省即今天行为）", () => {
    const out = layerRulerSelect({ candidates: mk("a", [0.9, 0.8]), keepRatio: 1, minPerLayer: 1 });
    expect(out.kept).toEqual([0, 1]);
  });
});

describe("layerRulerSelect · rankScore 与 score 分离", () => {
  it("名次按 rankScore 排，floor/margin 仍按原始 score 判", () => {
    const candidates: LayerRulerCandidate[] = [
      { text: "long-dump", layer: "a", score: 0.55, rankScore: 0.2, order: 0 },
      { text: "short-fact", layer: "a", score: 0.5, rankScore: 0.6, order: 1 },
    ];
    const out = layerRulerSelect({ candidates, keepRatio: 0.5, minPerLayer: 1, floor: 0.3 });
    expect(out.kept).toEqual([1]);
    expect(out.decisions[0]).toMatchObject({ kept: false, reason: "rank" });
  });
});

describe("layerRulerSelect · 字符预算（charBudget，成本上限）", () => {
  const cand = (text: string, score: number, order: number): LayerRulerCandidate => ({ text, layer: "a", score, order });

  it("全部装得下 → 一行不裁（charBudget 不是行数配额）", () => {
    const out = layerRulerSelect({
      candidates: [cand("x".repeat(100), 0.5, 0), cand("y".repeat(100), 0.4, 1)],
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 300,
    });
    expect(out.kept).toEqual([0, 1]);
  });

  it("装不下 → 按名次装填，装不下的记 reason=chars（跳过而不是整体放弃）", () => {
    const out = layerRulerSelect({
      candidates: [cand("a".repeat(500), 0.9, 0), cand("b".repeat(500), 0.5, 1), cand("c".repeat(100), 0.1, 2)],
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 600,
    });
    expect(out.kept).toEqual([0, 2]);
    expect(out.decisions[1]).toMatchObject({ kept: false, reason: "chars" });
  });

  it("缺省 / null → 不裁（缺省即今天行为）", () => {
    const out = layerRulerSelect({ candidates: [cand("x".repeat(5000), 0.5, 0)], keepRatio: 1, minPerLayer: 1 });
    expect(out.kept).toEqual([0]);
    expect(out.decisions[0].reason).toBeNull();
  });

  it("charBudget 与行数 budget 叠加：先按字符装填，再按行数裁（reason 各记各的）", () => {
    const out = layerRulerSelect({
      candidates: [cand("a".repeat(100), 0.9, 0), cand("b".repeat(100), 0.8, 1), cand("c".repeat(100), 0.7, 2)],
      keepRatio: 1,
      minPerLayer: 1,
      charBudget: 250,
      budget: 2,
    });
    expect(out.kept).toEqual([0, 1]);
    expect(out.decisions[2].reason).toBe("chars");
  });

  it("charBudget=0 → 一行不留（0 是显式上限，不是「不限」）", () => {
    const out = layerRulerSelect({ candidates: [cand("x", 0.5, 0)], keepRatio: 1, minPerLayer: 1, charBudget: 0 });
    expect(out.kept).toEqual([]);
    expect(out.decisions[0].reason).toBe("chars");
  });
});
