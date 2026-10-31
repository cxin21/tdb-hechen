/**
 * #168 长会话退化基准的叶子单测（纯函数，不建库、不外呼）：
 *  - long-session-corpus.mjs：语料确定性、轮数/更新次数契约、时间线单调、问题与 gold 对齐、
 *    LongMemEval-oracle 形状（能直接喂 eval-memory-bench）；
 *  - long-session-metrics.mjs：旧值注入/当前值命中/历史命中口径、分位数、退化曲线分桶。
 *
 * 关键回归点（都是本次实现中真实踩到过的坑）：
 *  1) 每条 case 内 session 日期必须随更新序号**严格递增**——否则 supersession 会按时间
 *     失效掉「时间上最后」的那条，gold 变成旧值，当前值命中率是假读数；
 *  2) staleInjected 只对 current 问题成立（history 问题问的就是旧值，不能算注入）；
 *  3) 分桶必须覆盖生成器真实轮数区间，否则「退化曲线」少一档。
 */
import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_FAMILIES,
  LONG_SESSION_SCHEMA_VERSION,
  factsForCase,
  generateCase,
  generateLongSessionCorpus,
  summarizeCorpus,
  toLongMemEvalOracle,
} from "../scripts/lib/bench/long-session-corpus.mjs";
import {
  evaluateQuestion,
  normText,
  percentile,
  stats,
  summarizeArm,
} from "../scripts/lib/bench/long-session-metrics.mjs";
import { parseLmeDate } from "../scripts/lib/bench/datasets.mjs";

const OPTS = { cases: 6, seed: 20261031 };

describe("#168 语料生成器", () => {
  it("同 seed 两次生成完全一致（可复现）", () => {
    const a = generateLongSessionCorpus(OPTS);
    const b = generateLongSessionCorpus(OPTS);
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    expect(a.schemaVersion).toBe(LONG_SESSION_SCHEMA_VERSION);
    expect(a.cases).toHaveLength(OPTS.cases);
  });

  it("不同 seed 产出不同语料", () => {
    const a = generateLongSessionCorpus({ cases: 2, seed: 1 });
    const b = generateLongSessionCorpus({ cases: 2, seed: 2 });
    expect(JSON.stringify(a.cases)).not.toBe(JSON.stringify(b.cases));
  });

  it("每条 case 满足轮数/更新次数契约，且 turn id 全局唯一", () => {
    const corpus = generateLongSessionCorpus(OPTS);
    const ids = new Set();
    for (const c of corpus.cases) {
      expect(c.turnCount).toBeGreaterThanOrEqual(20);
      expect(c.turnCount).toBeLessThanOrEqual(60);
      expect(c.updates.length).toBeGreaterThanOrEqual(5);
      expect(c.updates.length).toBeLessThanOrEqual(10);
      for (const g of c.groups) {
        expect(g.sessionId.startsWith(c.caseId)).toBe(true);
        for (const t of g.turns) {
          expect(ids.has(t.id)).toBe(false);
          ids.add(t.id);
        }
      }
      // turnCount 与分组轮数一致
      const sum = c.groups.reduce((n, g) => n + g.turns.length, 0);
      expect(sum).toBe(c.turnCount);
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  it("更新轮时间线严格递增，且 gold 是时间上最后一个值", () => {
    const corpus = generateLongSessionCorpus({ cases: 8, seed: 7 });
    for (const c of corpus.cases) {
      const stamps = c.updates.map((u) => u.tsISO);
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i] > stamps[i - 1]).toBe(true);
      }
      const current = c.questions.find((q) => q.kind === "current");
      expect(current.gold).toBe(c.updates[c.updates.length - 1].value);
      // current 的提问时刻晚于最后一次更新（严格晚于 valid_end 边界）
      const tail = c.groups[c.groups.length - 1];
      expect(current.questionDateISO > stamps[stamps.length - 1]).toBe(true);
      expect(current.questionDateISO).toBe(tail.dateISO);
      // 旧值集合 = 除 gold 外的所有历史值
      expect(current.staleValues).toEqual(c.updates.slice(0, -1).map((u) => u.value));
    }
  });

  it("历史问题的 gold 与其提问日期对得上，旧值只算其后各值", () => {
    const corpus = generateLongSessionCorpus({ cases: 8, seed: 11 });
    for (const c of corpus.cases) {
      const history = c.questions.filter((q) => q.kind === "history");
      expect(history.length).toBeGreaterThan(0);
      for (const q of history) {
        const goldUpd = c.updates.find((u) => u.tsISO === q.questionDateISO);
        expect(goldUpd).toBeTruthy();
        expect(goldUpd.value).toBe(q.gold);
        const after = c.updates.filter((u) => u.tsISO > q.questionDateISO).map((u) => u.value);
        expect(q.staleValues).toEqual(after);
        expect(["early", "mid", "late"]).toContain(q.position);
        expect(q.askedTurnIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("写侧三元组覆盖每次更新，属性命中封闭词表时带 attribute", () => {
    const corpus = generateLongSessionCorpus(OPTS);
    for (const c of corpus.cases) {
      const facts = factsForCase(c);
      for (const u of c.updates) {
        const triples = facts[u.turnId]?.triples ?? [];
        expect(triples).toHaveLength(1);
        const t = triples[0];
        expect(t.subject).toBe(c.entity);
        expect(typeof t.predicate).toBe("string");
        expect(t.value).toBe(u.value);
        if (c.attribute.attribute) expect(t.attribute).toBe(c.attribute.attribute);
      }
      // 非更新轮不应该凭空产出事实（否则写侧会误失效）
      const updateTurns = new Set(c.updates.map((u) => u.turnId));
      for (const [turnId, entry] of Object.entries(facts)) {
        if (!updateTurns.has(turnId)) expect(entry.triples ?? []).toHaveLength(0);
      }
    }
  });

  it("属性族都是 single 值语义（避免被 #136 多值契约挡掉）", () => {
    const keys = ATTRIBUTE_FAMILIES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of ATTRIBUTE_FAMILIES) {
      expect(typeof f.value).toBe("function");
      expect(typeof f.label).toBe("string");
    }
  });

  it("oracle 是标准 LongMemEval 形状，条数 = 问题数，日期可被 parseLmeDate 解析", () => {
    const corpus = generateLongSessionCorpus({ cases: 4, seed: 3 });
    const oracle = toLongMemEvalOracle(corpus);
    const totalQuestions = corpus.cases.reduce((n, c) => n + c.questions.length, 0);
    expect(oracle).toHaveLength(totalQuestions);
    for (const item of oracle) {
      expect(typeof item.question_id).toBe("string");
      expect(typeof item.question).toBe("string");
      expect(item.answer.length).toBeGreaterThan(0);
      expect(["knowledge-update", "temporal-reasoning"]).toContain(item.question_type);
      expect(parseLmeDate(item.question_date)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
      expect(item.haystack_sessions.length).toBe(item.haystack_session_ids.length);
      expect(item.haystack_sessions.length).toBe(item.haystack_dates.length);
      expect(item.answer_session_ids.length).toBeGreaterThan(0);
      // 每个 answer session 里必须真的有 has_answer 标记，否则 oracle 自身不可信
      for (const sid of item.answer_session_ids) {
        const idx = item.haystack_session_ids.indexOf(sid);
        expect(idx).toBeGreaterThanOrEqual(0);
        const turns = item.haystack_sessions[idx];
        expect(turns.some((t) => t.has_answer === true)).toBe(true);
      }
    }
  });

  it("summarizeCorpus 汇总与逐 case 数据一致", () => {
    const corpus = generateLongSessionCorpus({ cases: 5, seed: 5 });
    const s = summarizeCorpus(corpus);
    expect(s.cases).toBe(5);
    expect(s.turns).toBe(corpus.cases.reduce((n, c) => n + c.turnCount, 0));
    expect(s.updates).toBe(corpus.cases.reduce((n, c) => n + c.updates.length, 0));
    expect(s.questions).toBe(corpus.cases.reduce((n, c) => n + c.questions.length, 0));
    expect(Object.values(s.byFamily).reduce((a, b) => a + b, 0)).toBe(5);
    expect(s.turnsPerCase.min).toBeLessThanOrEqual(s.turnsPerCase.mean);
    expect(s.turnsPerCase.max).toBeGreaterThanOrEqual(s.turnsPerCase.mean);
  });

  it("generateCase 是 generateLongSessionCorpus 的单条切面", () => {
    const one = generateCase(0, { seed: 20261031 });
    const corpus = generateLongSessionCorpus({ cases: 1, seed: 20261031 });
    expect(one.caseId).toBe(corpus.cases[0].caseId);
    expect(one.updates.length).toBe(corpus.cases[0].updates.length);
  });
});

describe("#168 度量口径", () => {
  const q = {
    qid: "q1",
    kind: "current",
    gold: "赵磊",
    staleValues: ["张伟", "李娜"],
    position: "late",
    askedTurnIndex: 30,
  };

  it("normText 去空白/标点/大小写", () => {
    expect(normText(" 北京 市、朝阳区。")).toBe(normText("北京市朝阳区"));
    expect(normText("HELLO, World!")).toBe("helloworld");
  });

  it("当前值命中 + 旧值注入可同时成立（baseline 的典型形态）", () => {
    const ev = evaluateQuestion(q, { block: "…张伟…李娜…赵磊…", hits: [{ clean: "赵磊 是负责人" }], latencyMs: 12 });
    expect(ev.hitBlock).toBe(true);
    expect(ev.hitTop1).toBe(true);
    expect(ev.staleValuesInBlock).toEqual(["张伟", "李娜"]);
    expect(ev.staleInjected).toBe(true);
    expect(ev.latencyMs).toBe(12);
    expect(ev.blockLines).toBe(1);
  });

  it("失效后只剩 gold：命中且无旧值注入（supersede 的目标形态）", () => {
    const ev = evaluateQuestion(q, { block: "项目归墟的负责人现在更新为赵磊。", hits: [{ clean: "赵磊" }] });
    expect(ev.hitBlock).toBe(true);
    expect(ev.staleValuesInBlock).toEqual([]);
    expect(ev.staleInjected).toBe(false);
  });

  it("历史问题问的就是旧值，不能被算成旧值注入", () => {
    // 历史问题的 staleValues 语义：该时刻**之后**才出现的值（对这道题才是「旧值」的对立面）
    const hq = { ...q, qid: "q2", kind: "history", gold: "李娜", staleValues: ["赵磊"] };
    const ev = evaluateQuestion(hq, { block: "李娜 当时是负责人；后来换成赵磊", hits: [] });
    expect(ev.hitBlock).toBe(true);
    expect(ev.staleValuesInBlock).toEqual(["赵磊"]);
    expect(ev.staleInjected).toBe(false);
  });

  it("空块/空值不误判命中", () => {
    const ev = evaluateQuestion(q, { block: "", hits: [] });
    expect(ev.hitBlock).toBe(false);
    expect(ev.hitTop1).toBe(false);
    expect(ev.blockChars).toBe(0);
    expect(evaluateQuestion({ ...q, gold: "" }, { block: "任意" }).hitBlock).toBe(false);
  });

  it("percentile/stats 只统计有限数值", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBe(null);
    expect(stats([10, null, undefined, 20, Number.NaN])).toEqual({ n: 2, mean: 15, p50: 15, p95: 19.5, max: 20 });
    expect(stats([]).n).toBe(0);
  });
});

describe("#168 arm 汇总", () => {
  const mkEval = (kind, caseTurns, hitBlock, staleInjected, position = "late") => ({
    qid: `${kind}-${caseTurns}-${hitBlock}-${staleInjected}`,
    kind,
    hitBlock,
    hitTop1: hitBlock,
    staleInjected,
    blockChars: 100,
    blockLines: 4,
    latencyMs: 10,
    caseTurns,
    position,
  });

  it("baseline 形态：旧值注入 100%，重复值多；supersede 形态：注入 0、值去重", () => {
    const evals = [
      mkEval("current", 35, true, true),
      mkEval("current", 44, true, true),
      mkEval("history", 44, true, false, "early"),
    ];
    const baseline = summarizeArm({
      evaluations: evals,
      rowStats: { attrs: [{ attrKey: "a", activeEvidenceRows: 7, activeDistinctValues: 7, canonicalRows: 7 }], foldRows: 0 },
      writeLats: [1, 2, 3],
      supersedeMs: 0,
      supersedeOps: [],
    });
    expect(baseline.questions.currentStaleInjection.rate).toBe(1);
    expect(baseline.duplicates.dupAttrRate).toBe(1);
    expect(baseline.duplicates.foldRows).toBe(0);
    expect(baseline.cost.writeMs.n).toBe(3);
    expect(baseline.cost.supersedeOps).toBe(0);

    const superseded = summarizeArm({
      evaluations: [
        mkEval("current", 35, true, false),
        mkEval("current", 44, true, false),
        mkEval("history", 44, true, false, "early"),
      ],
      rowStats: { attrs: [{ attrKey: "a", activeEvidenceRows: 1, activeDistinctValues: 1, canonicalRows: 2 }], foldRows: 1 },
      writeLats: [1],
      supersedeMs: 4.5,
      supersedeOps: [{ cardinality: "single" }, { cardinality: "single" }, { cardinality: "multi" }],
    });
    expect(superseded.questions.currentStaleInjection.rate).toBe(0);
    expect(superseded.duplicates.dupAttrRate).toBe(0);
    expect(superseded.duplicates.foldRows).toBe(1);
    expect(superseded.duplicates.canonicalRows.mean).toBe(2);
    expect(superseded.cost.supersedeOps).toBe(3);
    expect(superseded.cost.supersedeOpsSingle).toBe(2);
    expect(superseded.cost.supersedeOpsMulti).toBe(1);
    expect(superseded.cost.supersedeMs).toBe(4.5);
  });

  it("退化曲线按 case 轮数分三档，且历史位置分桶不丢", () => {
    const evals = [
      mkEval("current", 33, true, false),
      mkEval("current", 45, true, true),
      mkEval("current", 55, false, true),
      mkEval("history", 33, true, false, "early"),
      mkEval("history", 45, true, false, "mid"),
      mkEval("history", 55, false, false, "late"),
    ];
    const m = summarizeArm({ evaluations: evals, rowStats: { attrs: [], foldRows: 0 } });
    const bySize = m.curve.byCaseSize;
    expect(Object.keys(bySize)).toEqual(["31-38轮", "39-47轮", "48-60轮"]);
    expect(bySize["31-38轮"].current).toEqual({ n: 1, hit: 1, rate: 1 });
    expect(bySize["39-47轮"].currentStale.rate).toBe(1);
    expect(bySize["48-60轮"].current.rate).toBe(0);
    expect(bySize["48-60轮"].history.rate).toBe(0);
    expect(m.curve.historyByPosition.early.rate).toBe(1);
    expect(m.curve.historyByPosition.mid.rate).toBe(1);
    expect(m.curve.historyByPosition.late.rate).toBe(0);
  });

  it("空 evaluations 给出 null 而不是 NaN", () => {
    const m = summarizeArm({ evaluations: [], rowStats: { attrs: [], foldRows: 0 } });
    expect(m.questions.current.rate).toBe(null);
    expect(m.questions.history.rate).toBe(null);
    expect(m.questions.currentStaleInjection.rate).toBe(null);
    expect(m.duplicates.dupAttrRate).toBe(null);
    expect(m.cost.writeMs.n).toBe(0);
    expect(m.cost.blockChars.p50).toBe(null);
  });
});
