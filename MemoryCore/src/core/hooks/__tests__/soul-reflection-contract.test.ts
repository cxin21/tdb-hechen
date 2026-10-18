/**
 * #60（S22，2026-10-18）：反思回写产物契约（D8 确定性校验层 + D6 真实性边界）。
 *
 * 合同：
 *   - 契约门 config-first（reflection.soulProposals.cardContract.enabled，缺省 false=现状）；
 *   - validateIdentityNarrative：非空 / ≤200 字 / 第一人称「我」/ 禁伪造当下体验
 *     （FORBID_CURRENT_EXPERIENCE_RE——D6「不伪造第一人称体验」在产物侧的机械执行）；
 *   - 价值锚引用：锚集从 core_value 行「label：desc」提取（labelsFromCoreValueRows，
 *     只认 core_value 槽、行首段为 label、无分隔行跳过、输入序去重）；
 *     叙事须引用至少一个锚（extractValueAnchorRefs 子串命中，validLabels 输入序去重）；
 *   - 降级：锚集空/undefined = 跳过锚校验（anchorRefs=[]）——锚数据缺失不阻塞合法叙事。
 */
import { describe, expect, it } from "vitest";
import {
  FORBID_CURRENT_EXPERIENCE_RE,
  REFLECTION_CARD_CONTRACT_PROMPT,
  extractValueAnchorRefs,
  labelsFromCoreValueRows,
  validateIdentityNarrative,
  validateReflectionCardContract,
} from "../soul-reflection-contract.js";

describe("#60 validateIdentityNarrative（D6+第一人称机械门）", () => {
  it("第一人称过往叙事 → ok", () => {
    expect(validateIdentityNarrative("我习惯在动手之前先把根因定位清楚，再决定怎么修。")).toMatchObject({ ok: true });
  });

  it("无「我」→ not-first-person", () => {
    expect(validateIdentityNarrative("他坚持交付前完成全量回归验证，宁慢勿漏。")).toMatchObject({ ok: false, reason: "not-first-person" });
  });

  it("伪造当下体验 → fabricated-current-experience（含「我」也拒）", () => {
    const r = validateIdentityNarrative("经过这轮排查，我现在感到整体稳定，情绪也放松了。");
    expect(r.ok).toBe(false);
    expect(String((r as { reason?: string }).reason)).toContain("fabricated-current-experience");
  });

  it("超长（>200 字）→ content-too-long；空白 → empty-content", () => {
    expect(validateIdentityNarrative("我" + "长".repeat(200))).toMatchObject({ ok: false, reason: "content-too-long" });
    expect(validateIdentityNarrative("   ")).toMatchObject({ ok: false, reason: "empty-content" });
  });

  it("FORBID_CURRENT_EXPERIENCE_RE 语义（时间词+感受词邻接才命中）", () => {
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我现在感到很稳")).toBe(true);
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我此刻觉得不错")).toBe(true);
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我当下的情绪是平稳的")).toBe(true);
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我当时感到很稳")).toBe(false);
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我现在不感到焦虑")).toBe(false);
    expect(FORBID_CURRENT_EXPERIENCE_RE.test("我常常感到焦虑")).toBe(false);
  });
});

describe("#60 labelsFromCoreValueRows（锚集提取）", () => {
  it("core_value 槽逐行提取 label；无分隔行跳过", () => {
    expect(labelsFromCoreValueRows([
      { slot: "core_value", content: "根因优先：先定位根因再动手。\n这是一行没有分隔符的。\n自律：复核实锤后才动手。" },
    ])).toEqual(["根因优先", "自律"]);
  });

  it("只认 core_value 槽；重复 label 去重保首现（输入序）", () => {
    expect(labelsFromCoreValueRows([
      { slot: "identity", content: "根因优先：出现在别槽不算。" },
      { slot: "core_value", content: "自律：y\n根因优先：z\n自律：w" },
    ])).toEqual(["自律", "根因优先"]);
  });

  it("空输入/空内容 → []", () => {
    expect(labelsFromCoreValueRows([])).toEqual([]);
    expect(labelsFromCoreValueRows([{ slot: "core_value", content: "" }])).toEqual([]);
  });
});

describe("#60 extractValueAnchorRefs（引用提取）", () => {
  it("子串命中、输出按 validLabels 输入序、去重", () => {
    expect(extractValueAnchorRefs("我信奉根因优先，也讲究自律。", ["自律", "根因优先"])).toEqual(["自律", "根因优先"]);
    expect(extractValueAnchorRefs("我讲自律。", ["自律", "自律"])).toEqual(["自律"]);
  });

  it("零命中 → []", () => {
    expect(extractValueAnchorRefs("我按既定流程推进。", ["自律"])).toEqual([]);
  });
});

describe("#60 validateReflectionCardContract（契约门）", () => {
  it("合格叙事 + 锚引用 → ok 且 anchorRefs 命中", () => {
    expect(validateReflectionCardContract({
      content: "我信奉根因优先：动手前先定位根因，再决定怎么修。",
      validAnchorLabels: ["根因优先", "自律"],
    })).toEqual({ ok: true, anchorRefs: ["根因优先"] });
  });

  it("合格叙事 + 锚集非空零引用 → no-anchor-ref", () => {
    expect(validateReflectionCardContract({
      content: "我宁可慢一点也不省掉全量回归。",
      validAnchorLabels: ["根因优先"],
    })).toMatchObject({ ok: false, reason: "no-anchor-ref" });
  });

  it("锚集 undefined/空 → 降级过（anchorRefs=[]）", () => {
    expect(validateReflectionCardContract({ content: "我宁可慢一点也不省掉全量回归。" })).toEqual({ ok: true, anchorRefs: [] });
    expect(validateReflectionCardContract({ content: "我宁可慢一点也不省掉全量回归。", validAnchorLabels: [] })).toEqual({ ok: true, anchorRefs: [] });
  });

  it("伪造当下体验即使有锚引用也拒（D6 优先）", () => {
    const r = validateReflectionCardContract({
      content: "我现在感到轻松，这符合根因优先的节奏。",
      validAnchorLabels: ["根因优先"],
    });
    expect(r.ok).toBe(false);
    expect(String((r as { reason?: string }).reason)).toContain("fabricated-current-experience");
  });
});

describe("#60 REFLECTION_CARD_CONTRACT_PROMPT", () => {
  it("模板非空且点名三大要求（第一人称/当下体验禁令/价值锚引用）", () => {
    expect(typeof REFLECTION_CARD_CONTRACT_PROMPT).toBe("string");
    expect(REFLECTION_CARD_CONTRACT_PROMPT.length).toBeGreaterThan(40);
    expect(REFLECTION_CARD_CONTRACT_PROMPT).toContain("第一人称");
    expect(REFLECTION_CARD_CONTRACT_PROMPT).toContain("当下");
    expect(REFLECTION_CARD_CONTRACT_PROMPT).toContain("价值锚");
  });
});
