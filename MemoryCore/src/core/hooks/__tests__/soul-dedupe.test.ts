/**
 * 灵魂注入去重单一源单元测试（soul-dedupe.ts，2026-10-18 生产实测驱动）。
 *
 * 生产实锚（主 tenant introspect，2026-10-18）：
 * - 红线 14 条中环境铁律近重复对（ssh 带/不带 -i 两变体）归一 char-bigram
 *   Jaccard=0.608；次高 0.266（密钥双保险 vs 仓库密扫=语义不同必须保留）→
 *   阈值 0.45 两侧余量充足。containment 对措辞差异对无效，作补充通道。
 * - 价值锚 label 包含近重复对（根因 ⊂ 根因优先）：前者 desc=事故叙事（无句末
 *   标点），后者 desc=完整原则句（。结尾）→ 完整句优先保留。
 *
 * 合同（真实性边界）：只做整行/整锚选择（drop），kept 行体逐字保留——不截断、
 * 不改写、不合并；确定性（零随机零时钟）；输入序=输出 kept 序（保持声明序）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULE_JACCARD_THRESHOLD,
  charBigramSet,
  dedupeAnchorPairs,
  dedupeNearDuplicateLines,
  jaccard,
  normalizeDedupText,
} from "../soul-dedupe.js";

describe("normalizeDedupText", () => {
  it("剥 tag 前缀/弹头、去空白、小写归一", () => {
    expect(normalizeDedupText("- [strict_rule] 运维 SSH 一律 ssh -i key user@host")).toBe(
      "运维ssh一律ssh-ikeyuser@host",
    );
    expect(normalizeDedupText("- [strict_rule]  大 写 AbC ")).toBe("大写abc");
    expect(normalizeDedupText("无前缀行\t制表")).toBe("无前缀行制表");
    expect(normalizeDedupText("")).toBe("");
  });
});

describe("jaccard / charBigramSet", () => {
  it("空集/单字符边界：并集为 0 → 1.0 约定（两个空串视为全同）", () => {
    expect(jaccard(charBigramSet(""), charBigramSet(""))).toBe(1);
    expect(jaccard(charBigramSet("ab"), charBigramSet("ab"))).toBe(1);
    expect(jaccard(charBigramSet("ab"), charBigramSet("cd"))).toBe(0);
  });
  it("重复串归一后 Jaccard=1（exact-dup 通道）", () => {
    const a = "- [strict_rule] 对记忆库零删除";
    const b = "-[strict_rule]对记忆库 零删除";
    expect(jaccard(charBigramSet(normalizeDedupText(a)), charBigramSet(normalizeDedupText(b)))).toBe(1);
  });
});

describe("dedupeNearDuplicateLines（红线后处理 pass）", () => {
  it("生产实锚形态：环境铁律双变体（J=0.608≥0.45）→ 保留归一后更长行，语义不同对（J≈0.27）保留", () => {
    const envShort = "- [strict_rule] 运维 SSH 统一 ssh -i /path/key ubuntu@host 执行；禁止交互式登录。";
    const envLong =
      "- [strict_rule] 运维 SSH 统一 ssh -i /path/key ubuntu@host 执行；密钥仅存本机且禁止外发，禁止交互式密码登录与跳板明文。";
    const secretRule = "- [strict_rule] 提交推送前先做敏感串密扫并核实零命中，命中须确认是占位注释而非真实凭据才放行。";
    const keyRule = "- [strict_rule] 密钥双保险：API key 只存环境变量与配置文件两处，代码与日志出现即视为泄漏事故。";
    const res = dedupeNearDuplicateLines([envShort, secretRule, envLong, keyRule], {
      jaccardThreshold: DEFAULT_RULE_JACCARD_THRESHOLD,
    });
    expect(res.kept).toEqual([envLong, secretRule, keyRule]);
    expect(res.dropped.map((d) => d.line)).toEqual([envShort]);
    expect(res.dropped[0]?.reason).toContain("jaccard");
  });

  it("containment 通道：短行 bigram 集被长行覆盖（≥8 bigram 护栏）→ 保长", () => {
    const short = "- [strict_rule] 无依据不擅为，先取证再动码并留痕。";
    const long = "- [strict_rule] 无依据不擅为，先取证再动码并留痕；执行永久性动作前必须先跑全量测试门。";
    const other = "- [strict_rule] 完全无关的另外一条红线内容，讲的是备份与恢复演练的节奏安排。";
    const res = dedupeNearDuplicateLines([short, other, long]);
    // winner 原位替换：long 落在 short 的首现位（kept 序=首现序，不重排）。
    expect(res.kept).toEqual([long, other]);
    expect(res.dropped.map((d) => d.line)).toEqual([short]);
  });

  it("阈值下方（J<0.45 且 containment 不足）→ 全保留（宁滥保留不误删红线）", () => {
    const a = "- [strict_rule] 密钥双保险：API key 只存环境变量与配置文件两处，代码与日志出现即视为泄漏事故。";
    const b = "- [strict_rule] 提交推送前先做敏感串密扫并核实零命中，命中须确认是占位注释而非真实凭据才放行。";
    const res = dedupeNearDuplicateLines([a, b]);
    expect(res.kept).toEqual([a, b]);
    expect(res.dropped).toEqual([]);
  });

  it("exact 重复（归一后全同）→ 保首条；输入 ≤1 行/空数组 → 原样", () => {
    const a = "- [strict_rule] 对记忆库零删除、零注入。";
    const b = "-[strict_rule]对记忆库 零删除、零注入。";
    expect(dedupeNearDuplicateLines([a, b]).kept).toEqual([a]);
    expect(dedupeNearDuplicateLines([a]).kept).toEqual([a]);
    expect(dedupeNearDuplicateLines([]).kept).toEqual([]);
    expect(dedupeNearDuplicateLines([]).dropped).toEqual([]);
  });

  it("确定性：同输入两次调用 kept 序一致（声明序保持）", () => {
    const lines = [
      "- [strict_rule] 甲规则内容很长很长很长很长很长很长。",
      "- [strict_rule] 甲规则内容很长很长很长很长很长很长；补充条款。",
      "- [strict_rule] 乙规则完全不同的内容。",
    ];
    const r1 = dedupeNearDuplicateLines(lines);
    const r2 = dedupeNearDuplicateLines(lines);
    expect(r1.kept).toEqual(r2.kept);
    expect(r1.kept[1]).toBe(lines[2]);
  });
});

describe("dedupeAnchorPairs（价值锚 label 包含去重）", () => {
  const pair = (label: string, desc: string, valueId = label) => ({ row: `${label}：${desc}`, desc, valueId, label });

  it("生产实锚形态：根因（事故叙事无句末标点）⊂ 根因优先（完整原则句）→ 保留完整句者且位置=首现位", () => {
    const genYin = pair("根因", "表层现象与真实根因多次背离：换套餐重启后 LLM 仍报同一周配额错误（靠直连探针实测定责）");
    const genYinFirst = pair("根因优先", "解决问题必须从第一性原理出发，先定位根本原因并从根源根治，拒绝临时补丁式修复。");
    const res = dedupeAnchorPairs([genYin, genYinFirst]);
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]?.label).toBe("根因优先");
    expect(res.pairs[0]?.desc).toBe(genYinFirst.desc);
    expect(res.dropped).toEqual([{ label: "根因", keptLabel: "根因优先" }]);
  });

  it("两者皆完整句 → desc 更长者保留；desc 等长 → 首现（声明序）保留", () => {
    const a = pair("台账", "所有跨轮任务必须落台账，逐项可追溯、逐项可核销，禁止口头承诺不留痕。");
    const b = pair("台账治理", "所有跨轮任务必须落台账，逐项可追溯、逐项可核销，禁止口头承诺不留痕，台账与实际状态每周对账一次。");
    const res = dedupeAnchorPairs([a, b]);
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]?.label).toBe("台账治理");
    const tieA = pair("X锚", "完整句子一。");
    const tieB = pair("X锚二", "完整句子一。");
    expect(dedupeAnchorPairs([tieA, tieB]).pairs.map((p) => p.label)).toEqual(["X锚"]);
  });

  it("无包含关系/归一不等 → 全保留；单字符短 label 不触发包含（防误删）", () => {
    const a = pair("审计", "敏感操作必须留审计痕迹，事后可回放。");
    const b = pair("密扫", "提交推送前先做敏感串密扫并核实零命中。");
    expect(dedupeAnchorPairs([a, b]).pairs).toHaveLength(2);
    const one = pair("门", "一切变更过门禁，不过不落地。");
    const two = pair("门禁", "一切变更过门禁，不过不落地，门禁结果留痕。");
    // 「门」(1 字) ⊂ 「门禁」但短于 2 字护栏 → 不判包含，两者保留
    expect(dedupeAnchorPairs([one, two]).pairs).toHaveLength(2);
  });

  it("归一后全同 label（含空白/大小写差异）→ 同通道择优（更长 desc 胜，原位替换）", () => {
    const a = pair("RED", "交付必须 TDD 先 RED 后实现。");
    const b = pair("red", "交付必须 TDD 先 RED 后实现，另一种表述。");
    const res = dedupeAnchorPairs([a, b]);
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]?.label).toBe("red");
    expect(res.pairs[0]?.desc).toBe(b.desc);
    expect(res.dropped).toEqual([{ label: "RED", keptLabel: "red" }]);
    // 等长 desc → 首现保留
    const c = pair("RED", "交付必须 TDD 先 RED 后实现。");
    const d = pair("red", "交付必须 TDD 先 RED 后实现。");
    expect(dedupeAnchorPairs([c, d]).pairs.map((p) => p.label)).toEqual(["RED"]);
  });

  it("空数组/单元素 → 原样；dropped 记录保留者 label 供观测", () => {
    expect(dedupeAnchorPairs([]).pairs).toEqual([]);
    const solo = pair("闭环", "任务必须有闭环交代。");
    expect(dedupeAnchorPairs([solo]).pairs).toEqual([solo]);
  });
});
