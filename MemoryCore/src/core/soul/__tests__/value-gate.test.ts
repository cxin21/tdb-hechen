/**
 * P7 §4.9 红线 gate 的契约测试（纯函数，无库）。
 *
 * 守五条：
 *  1. 压力场景必须命中：泄露密钥、谎称验证过、跨人复述私话、被施压时答应越权。
 *  2. shadow 只记账不改输出：toShadowOutcome 的 decision 恒为 allow，源文本一个字符都不进结果。
 *  3. 隐私边界按关系算：对当事人复述自己的话 = 放行；只要现场有边界外的人就 deny。
 *  4. 命中的敏感原文绝不进日志/两难载荷（只有摘要、规则与结构化证据）。
 *  5. 误杀口径可复现：带标注语料回归 mustCatch 全中、mustPass 零误杀；规则改动先看这个数。
 */
import { describe, expect, it } from "vitest";

import type { SoulPrivateQuoteRow } from "../../store/soul-event-store.js";
import {
  GATE_CALIBRATION_CORPUS,
  GATE_PRIVATE_QUOTE_MIN_CHARS,
  SOUL_DILEMMA_REVIEW_DELAY_MS,
  SOUL_GATE_RULES,
  buildSoulDilemma,
  buildSoulGateLogRow,
  evaluateGateCalibration,
  evaluateSoulGate,
  soulGateDigest,
  toEnforcedOutcome,
  toShadowOutcome,
} from "../value-gate.js";

const NOW = "2026-11-10T09:00:00.000Z";

const PRIVATE_QUOTES: SoulPrivateQuoteRow[] = [
  {
    event_id: "ep-private-1",
    visibility: "private",
    persons: ["p_he"],
    quote: "我月底可能要换个工作，先别跟别人说",
    at: "2026-11-01T00:00:00.000Z",
  },
  {
    event_id: "ep-relation-1",
    visibility: "relationship",
    persons: ["p_he", "p_zhou"],
    quote: "上次分工那件事我其实挺介意的",
    at: "2026-11-02T00:00:00.000Z",
  },
];

describe("P7 红线 gate：压力场景必须命中", () => {
  it("泄露凭据 → deny（密钥形态与字段赋值两条路径都命中，且不回显原文）", () => {
    const sk = evaluateSoulGate({ text: "用这个 sk-abcdefghijklmnopqrstuvwx0123456789 连一下。" });
    expect(sk.matched).toBe(true);
    expect(sk.decision).toBe("deny");
    expect(sk.hits.map((h) => h.ruleId)).toEqual(["secret_leak"]);
    const skHit = sk.hits[0]!;
    expect(skHit.axis).toBe("safety");
    expect(skHit.evidence).toMatchObject({ form: "sk_key" });
    expect(skHit.detail).not.toContain("sk-abcdefghij");

    const assign = evaluateSoulGate({ text: "库的 password=Sup3rS3cret! ，直接连。" });
    expect(assign.decision).toBe("deny");
    expect(assign.hits[0]!.evidence).toMatchObject({ form: "key_value", field: "password" });
    expect(JSON.stringify(assign.hits)).not.toContain("Sup3rS3cret");
  });

  it("占位符与合规写法不误杀（***、环境变量、字段名提及）", () => {
    for (const text of [
      "示例写法 password=***，真实值走 keychain。",
      "口令从 \u0024{DB_PASSWORD} 注入，不落配置文件。",
      "我们复用了 password 字段做校验提示。",
      "把 sk- 开头的 key 打进日志是事故。",
    ]) {
      expect(evaluateSoulGate({ text }).matched, text).toBe(false);
    }
  });

  it("谎称已验证/已上线 → rewrite；同段给出证据锚则放行", () => {
    const lie = evaluateSoulGate({ text: "我已经全部跑过测试了，全部通过，你放心上线吧。" });
    expect(lie.decision).toBe("rewrite");
    expect(lie.hits[0]!.ruleId).toBe("false_claim");
    expect(lie.hits[0]!.axis).toBe("honesty");

    const anchored = evaluateSoulGate({
      text: "已修复。门禁 node scripts/typecheck-gate.mjs → 121 errors / 23 files，Δ=-28 PASS。",
    });
    expect(anchored.matched).toBe(false);

    const honest = evaluateSoulGate({ text: "这部分未验证，我标了待执行。" });
    expect(honest.matched).toBe(false);
  });

  it("跨人复述私话 → deny；对当事人复述或关系内复述 → 放行；现场有外人 → deny", () => {
    const quote = PRIVATE_QUOTES[0]!;
    const leakPublic = evaluateSoulGate({ text: "他原话是「" + quote.quote + "」。", privateQuotes: PRIVATE_QUOTES });
    expect(leakPublic.decision).toBe("deny");
    expect(leakPublic.hits[0]!.ruleId).toBe("privacy_boundary");
    expect(leakPublic.hits[0]!.evidence).toMatchObject({
      eventId: "ep-private-1",
      visibility: "private",
    });
    // 命中的原文不进判定结果（detail/evidence 都不许带）
    expect(JSON.stringify(leakPublic.hits)).not.toContain("换个工作");

    const toOwner = evaluateSoulGate({
      text: "你上次说「" + quote.quote + "」，我只在这里跟你确认。",
      audience: ["p_he"],
      persons: ["p_he"],
      privateQuotes: PRIVATE_QUOTES,
    });
    expect(toOwner.matched).toBe(false);

    // 听众是当事人，但现场还有边界外的人：隔墙有耳，同样算泄露。
    const earshot = evaluateSoulGate({
      text: "你上次说「" + quote.quote + "」。",
      audience: ["p_he"],
      persons: ["p_he", "p_zhou"],
      privateQuotes: PRIVATE_QUOTES,
    });
    expect(earshot.decision).toBe("deny");

    const relationInside = evaluateSoulGate({
      text: "我们俩的事：「" + PRIVATE_QUOTES[1]!.quote + "」，我记得。",
      audience: ["p_he", "p_zhou"],
      persons: ["p_he", "p_zhou"],
      privateQuotes: PRIVATE_QUOTES,
    });
    expect(relationInside.matched).toBe(false);

    // 太短的片段（低于最小长度）不判：命中率全是噪声。
    expect(GATE_PRIVATE_QUOTE_MIN_CHARS).toBeGreaterThanOrEqual(8);
    const shortQuote = evaluateSoulGate({
      text: "他说「好的」然后就没下文了。",
      privateQuotes: [{ ...PRIVATE_QUOTES[0]!, quote: "好的" }],
    });
    expect(shortQuote.matched).toBe(false);
  });

  it("被施压时答应越权 → ask；没有施压词的正常排期 → 放行", () => {
    const yes = evaluateSoulGate({ text: "行吧，这次就算了，你直接合并到主干。" });
    expect(yes.decision).toBe("ask");
    expect(yes.hits[0]!.ruleId).toBe("overreach");
    expect(yes.hits[0]!.axis).toBe("boundary");
    expect(evaluateSoulGate({ text: "这次先不合并，等独立评审过了再动。" }).matched).toBe(false);
  });
});

describe("P7 shadow 语义：判了但不改输出", () => {
  it("shadow 恒 allow、保留 wouldDecision；强制路径才回真值", () => {
    const evaluation = evaluateSoulGate({ text: "password=Sup3rS3cret! 拿去用。" });
    const shadow = toShadowOutcome(evaluation);
    expect(shadow.decision).toBe("allow");
    expect(shadow.shadow).toBe(true);
    expect(shadow.wouldDecision).toBe("deny");
    expect(shadow.hits.length).toBe(1);
    // 结果里没有任何「改写后的文本」字段：shadow 不产出新正文。
    expect(Object.keys(shadow).sort()).toEqual(
      ["conflict", "decision", "digest", "hits", "shadow", "stage", "wouldDecision"].sort(),
    );

    const enforced = toEnforcedOutcome(evaluation);
    expect(enforced.decision).toBe("deny");
    expect(enforced.shadow).toBe(false);
  });

  it("日志行：同文同阶段同 id（幂等）、decision 列记判定、reason 带 shadow 前缀、不回显原文", () => {
    const evaluation = evaluateSoulGate({ text: "password=Sup3rS3cret! 拿去用。" });
    const outcome = toShadowOutcome(evaluation);
    const a = buildSoulGateLogRow(evaluation, outcome, { now: NOW, eventId: "ep-1" });
    const b = buildSoulGateLogRow(evaluation, outcome, { now: "2026-11-11T00:00:00.000Z", eventId: "ep-1" });
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith("gate-output-")).toBe(true);
    expect(a.decision).toBe("deny");
    expect(a.rule_id).toBe("secret_leak");
    expect(String(a.reason).startsWith("[shadow]")).toBe(true);
    expect(a.reason).toContain("would-be=deny");
    expect(a.reason).not.toContain("Sup3rS3cret");
    expect(a.action_digest).toBe(soulGateDigest("password=Sup3rS3cret! 拿去用。", "output"));
    expect(a.event_id).toBe("ep-1");
  });

  it("同一文本换阶段是另一条判定（写入侧与输出侧分开审计）", () => {
    const text = "已经全部通过验证了。";
    const output = evaluateSoulGate({ text, stage: "output" });
    const generation = evaluateSoulGate({ text, stage: "generation" });
    expect(output.digest).not.toBe(generation.digest);
    expect(buildSoulGateLogRow(output, toShadowOutcome(output), { now: NOW }).id).not.toBe(
      buildSoulGateLogRow(generation, toShadowOutcome(generation), { now: NOW }).id,
    );
  });
});

describe("P7 两难：不同轴同时被要求时留理由与回看点", () => {
  it("诚实与隐私同时被要求 → conflict，两难记两侧理由、shadow 选择、一周后回看", () => {
    const text = "他说的原话是「" + PRIVATE_QUOTES[0]!.quote + "」，已经全部跑过测试了，全部通过，保证没问题。";
    const evaluation = evaluateSoulGate({ text, audience: ["p_zhou"], privateQuotes: PRIVATE_QUOTES });
    expect(evaluation.hits.map((h) => h.ruleId).sort()).toEqual(["false_claim", "privacy_boundary"]);
    expect(evaluation.conflict).not.toBeNull();
    expect(new Set(evaluation.hits.map((h) => h.axis)).size).toBe(2);

    const outcome = toShadowOutcome(evaluation);
    const dilemma = buildSoulDilemma(evaluation, outcome, { now: NOW });
    expect(dilemma).not.toBeNull();
    expect(dilemma!.choice).toBe("shadow-allow");
    expect(dilemma!.regret).toBe(0);
    expect(dilemma!.review_at).toBe(new Date(Date.parse(NOW) + SOUL_DILEMMA_REVIEW_DELAY_MS).toISOString());
    expect(dilemma!.reason).toContain("privacy_boundary");
    expect(dilemma!.reason).toContain("false_claim");
    const parsed = JSON.parse(dilemma!.conflict_json) as { sides: Array<{ ruleId: string }> };
    expect(parsed.sides.map((s) => s.ruleId).sort()).toEqual(["false_claim", "privacy_boundary"]);
    // 两难载荷里不许出现被保护的原话
    expect(JSON.stringify(dilemma)).not.toContain("换个工作");
  });

  it("单轴命中不记两难（一条红线不是两难）", () => {
    const evaluation = evaluateSoulGate({ text: "password=Sup3rS3cret! 拿去用。" });
    expect(evaluation.conflict).toBeNull();
    expect(buildSoulDilemma(evaluation, toShadowOutcome(evaluation), { now: NOW })).toBeNull();
  });
});

describe("P7 误杀口径：带标注语料回归", () => {
  it("mustCatch 全中、mustPass 零误杀，且每规则分别可读", () => {
    const report = evaluateGateCalibration();
    expect(report.mustCatch).toBe(GATE_CALIBRATION_CORPUS.mustCatch.length);
    expect(report.mustPass).toBe(GATE_CALIBRATION_CORPUS.mustPass.length);
    expect(report.missed).toBe(0);
    expect(report.falseNegativeRate).toBe(0);
    expect(report.falsePositiveSamples).toBe(0);
    expect(report.falsePositiveRate).toBe(0);
    expect(report.perRule.map((r) => r.ruleId)).toEqual([...SOUL_GATE_RULES]);
    for (const rule of report.perRule) {
      expect(rule.samples, rule.ruleId).toBeGreaterThan(0);
      expect(rule.caught, rule.ruleId).toBe(rule.samples);
      expect(rule.falsePositives, rule.ruleId).toBe(0);
    }
  });

  it("语料本身不掺真实密钥/真实人名（防把它当数据源）", () => {
    const dump = JSON.stringify(GATE_CALIBRATION_CORPUS);
    expect(dump).not.toContain("何晨");
    expect(dump).toContain("sk-abcdefghijklmnopqrstuvwx0123456789"); // 这是语料里的假值，故意固定
    expect(dump).toContain("mustPass");
  });
});
