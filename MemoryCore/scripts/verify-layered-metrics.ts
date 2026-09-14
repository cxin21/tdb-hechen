/**
 * verify-layered-metrics：分层评估框架三指标纯函数单测（Task E1，DS-EVAL-LAYERED-001 实施）。
 *
 * [A] estimateTokens：token 估算口径（CJK 1 字 1 token、ASCII 4 字 1 token——固定口径，比较意义）
 * [B] classifyInjectionLine：注入行标注分类（[结论]/L1 九通道/[scene:]/[value:]/[graph:]——spec §2.3 一一对应）
 * [C] computeCTR：结论块字符数 / 注入块总字符数（边界：空集/全结论/全经验/混合）
 * [D] computeALD：注入块总字符数 / 注入行数（边界：空集/单行/多行）
 * [E] computeSD：来源分布向量 + Shannon 熵 H = -Σ p_i log2(p_i)（边界：空集/全同源/混合）
 * [F] computeCC + isTopicRelevantConclusion：spec §2.1 逐字语义断言
 *     （结论文本含标注词集中任一词——子串、大小写不敏感；或 sceneName 命中标注场景；
 *       CC = 覆盖 query 数 / golden query 总数；CC' = 覆盖数 / 结论层非空 query 数）
 * [G] computeLayeredMetrics：逐 query 行 + 聚合（micro CTR/ALD + SD 均值）
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-layered-metrics.ts
 *
 * 纯函数单测：零 IO、零外呼、不碰 D:/tdai-data/ 生产进程。
 */
import {
  estimateTokens,
  classifyInjectionLine,
  computeCTR,
  computeALD,
  computeSD,
  computeCC,
  isTopicRelevantConclusion,
  computeLayeredMetrics,
} from "../src/core/recall/layered-metrics.js";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `：${detail}` : ""}`);
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[A] estimateTokens：CJK 1 字 1 token、ASCII 4 字 1 token（固定口径）");
console.log("=".repeat(72));
{
  check("A1 空串 → 0 token", estimateTokens("") === 0);
  check("A2 纯 ASCII：4 字 = 1 token（ceil 口径）", estimateTokens("abcd") === 1, `got ${estimateTokens("abcd")}`);
  check("A2b 纯 ASCII：3 字 = 1 token（不足 4 字进位）", estimateTokens("abc") === 1);
  check("A2c 纯 ASCII：5 字 = 2 token", estimateTokens("abcde") === 2);
  check("A3 纯 CJK：2 字 = 2 token（1 字 1 token）", estimateTokens("中文") === 2);
  check("A3b 全角标点按非 ASCII 口径（1 字 1 token）", estimateTokens("，。") === 2);
  check("A4 混合：中a文b = 2 CJK + ceil(2/4)=1 ASCII → 3", estimateTokens("中a文b") === 3, `got ${estimateTokens("中a文b")}`);
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[B] classifyInjectionLine：注入行标注分类（spec §2.3 来源分类一一对应）");
console.log("=".repeat(72));
{
  check("B1 [结论] 行 → L2结论", classifyInjectionLine("- [结论] 缓存重建期间放行查询") === "L2结论");
  check("B2 [结论|场景名] 行 → L2结论", classifyInjectionLine("- [结论|TDB团队-技术架构文档] 分层结论") === "L2结论");
  check("B3 无补池标注经验行 → L1九通道", classifyInjectionLine("- [episodic] 用户今天加班到很晚。 (活动时间: 2025-03-01)") === "L1九通道");
  check("B4 [scene:名] 行 → scene补池", classifyInjectionLine("- [episodic|项目重构] 内容 ·[scene:项目重构]") === "scene补池");
  check("B5 [value:锚] 行 → value补池", classifyInjectionLine("- [persona] 内容 ·[value:正确]") === "value补池");
  check("B6 [graph:ppr:kind] 行 → graph补池", classifyInjectionLine("- [episodic] 内容 ·[graph:ppr:causal]") === "graph补池");
  check("B7 [scene: 名] 空格变体（memory-search 同款）→ scene补池", classifyInjectionLine("- [episodic] 内容 ·[scene: 场景A]") === "scene补池");
  check("B8 [graph:related] 变体 → graph补池", classifyInjectionLine("- [episodic] 内容 ·[graph:related]") === "graph补池");
  check("B9 [explore] 探索位非补池标注体系 → L1九通道", classifyInjectionLine("- [episodic] 内容 ·[explore]") === "L1九通道");
  check("B10 结论行内文含 [scene: 字样 → 结论优先（结论行判定在前）", classifyInjectionLine("- [结论] 提到 [scene:xx] 字样") === "L2结论");
  check("B11 空串/非行文本 → L1九通道（保守缺省）", classifyInjectionLine("") === "L1九通道");
  // 行尾标注口径（防正文引用标注字样误判）：补池通道标注 = 行最后一个 [] 段
  check("B12 正文引用 [graph:...] 字样（后随文字）→ L1九通道（非行尾标注）",
    classifyInjectionLine("- [episodic] 邻居入池并带 [graph:ppr:causal] 标注自证身份") === "L1九通道");
  check("B13 正文引用标注 + 行尾 soul 注 → L1九通道",
    classifyInjectionLine("- [episodic] 内容提到 [value:正确] 的设计 ·soul[发生 2026-09-11 · 实见]") === "L1九通道");
  check("B14 行尾仅 soul 注（无通道标注）→ L1九通道",
    classifyInjectionLine("- [persona] 用户叫王小明。 ·soul[发生 2025-03-01 · 实见]") === "L1九通道");
  // A1 · Minor ④ 回归钉（2026-09-12 实测裁定）：结论文本自带 "(活动时间:…)" 的边缘误剥。
  // 实测：本分类与字符口径对自带 (活动时间:…) 的行无误剥（误剥点实锤在 auto-recall.ts
  // :515/:800 的 metric 解析正则 `(.+?)(?:\s*\(活动时间:.*\))?$`——职权外另行登记，见
  // scripts/task-r7fix-report.md 登记项 4 追记）；本组钉死 eval 侧不引入同类误剥。
  check("B15 结论行文本自带 (活动时间:…) → L2结论（分类不误判）",
    classifyInjectionLine("- [结论|会议节奏] 周会固定在每月首个周一 (活动时间: 每月第一个周一 10:00)") === "L2结论");
  check("B16 经验行文本自带 (活动时间:…) 且行尾非通道标注 → L1九通道",
    classifyInjectionLine("- [episodic] 记录一条内容本身以时间标注结尾的备忘 (活动时间: 每年3月)") === "L1九通道");
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[C] computeCTR：结论块字符数 / 注入块总字符数");
console.log("=".repeat(72));
{
  check("C1 空注入 → 0（无注入块）", computeCTR([]) === 0);
  check("C2 全结论 → 1", computeCTR(["- [结论] 甲", "- [结论|场景] 乙"]) === 1);
  check("C3 全经验（无结论）→ 0", computeCTR(["- [episodic] 甲", "- [persona] 乙"]) === 0);
  {
    // "- [结论] ab" = 9 字符；"- [episodic] cd" = 15 字符 → 9/24 = 0.375
    const lines = ["- [结论] ab", "- [episodic] cd"];
    check("C4 混合：9/24 = 0.375（全行口径：标注与内容一并计入）", near(computeCTR(lines), 9 / 24), `got ${computeCTR(lines)}`);
  }
  {
    // A1 · Minor ④ 回归钉：自带 (活动时间:…) 的行按全行字符计入，内容不被剥除
    const conc = "- [结论|会议节奏] 周会固定在每月首个周一 (活动时间: 每月第一个周一 10:00)";
    const exp = "- [episodic] 记录一条内容本身以时间标注结尾的备忘 (活动时间: 每年3月)";
    check("C5 自带 (活动时间:…) 行全行计入（字符口径不剥内容）",
      computeCTR([conc, exp]) === conc.length / (conc.length + exp.length),
      `got ${computeCTR([conc, exp])} expected ${conc.length / (conc.length + exp.length)}`);
  }
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[D] computeALD：注入块总字符数 / 注入行数");
console.log("=".repeat(72));
{
  check("D1 空注入 → 0（除零防御）", computeALD([]) === 0);
  check("D2 单行 → 该行长度", computeALD(["- [结论] ab"]) === 9, `got ${computeALD(["- [结论] ab"])}`);
  {
    const lines = ["- [结论] ab", "- [episodic] cd", "0123456789"]; // 9 + 15 + 10 = 34
    check("D3 多行 → 34/3", near(computeALD(lines), 34 / 3), `got ${computeALD(lines)}`);
  }
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[E] computeSD：来源分布向量 + Shannon 熵 H = -Σ p_i log2(p_i)");
console.log("=".repeat(72));
{
  {
    const sd = computeSD([]);
    const allZero = Object.values(sd.distribution).every((v) => v === 0);
    check("E1 空注入 → 全零分布 + H=0", allZero && sd.entropy === 0, JSON.stringify(sd));
  }
  {
    const lines = ["- [结论] 甲", "- [结论|场景] 乙", "- [结论] 丙"];
    const sd = computeSD(lines);
    check("E2 全同源 → H=0（p=1）", sd.entropy === 0 && sd.distribution["L2结论"] === 3, JSON.stringify(sd.distribution));
  }
  {
    // 2 L1 + 2 结论 → p=0.5/0.5 → H = 1
    const lines = ["- [结论] 甲", "- [结论] 乙", "- [episodic] 丙", "- [persona] 丁"];
    const sd = computeSD(lines);
    check("E3 2+2 混合 → H=1.0", near(sd.entropy, 1), `got ${sd.entropy}`);
  }
  {
    // L1/scene/value/graph 各 1 → p=0.25 × 4 → H = 2
    const lines = [
      "- [episodic] 甲",
      "- [episodic] 乙 ·[scene:场景]",
      "- [persona] 丙 ·[value:正确]",
      "- [episodic] 丁 ·[graph:ppr:causal]",
    ];
    const sd = computeSD(lines);
    check("E4 四来源各 1 → H=2.0", near(sd.entropy, 2), `got ${sd.entropy}`);
    check("E4b 分布计数逐类正确",
      sd.distribution["L1九通道"] === 1 && sd.distribution["scene补池"] === 1 &&
      sd.distribution["value补池"] === 1 && sd.distribution["graph补池"] === 1 && sd.distribution["L2结论"] === 0,
      JSON.stringify(sd.distribution));
  }
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[F] computeCC + isTopicRelevantConclusion：spec §2.1 逐字语义");
console.log("=".repeat(72));
{
  // F 组前置：isTopicRelevantConclusion 逐字口径
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "", content: "缓存重建期间放行查询返回旧索引快照" },
      ["放行查询"], []);
    check("F1 文本命中：结论文本含标注词（子串）→ 覆盖", r.hit && r.hitWords.includes("放行查询"), JSON.stringify(r));
  }
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "", content: "Use Redis Cache for sessions" },
      ["redis cache"], []);
    check("F2 大小写不敏感（ASCII）→ 覆盖", r.hit, JSON.stringify(r));
  }
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "", content: "先做 A 方案" },
      ["不存在词", "A 方案"], []);
    check("F3 标注词集任一词命中即覆盖（'任一词'口径）", r.hit, JSON.stringify(r));
  }
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "TDB团队-技术架构文档", content: "与标注词无关的结论" },
      [], ["技术架构"]);
    check("F4 sceneName 命中标注场景（子串双向）→ 覆盖", r.hit && r.hitScenes.length > 0, JSON.stringify(r));
  }
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "", content: "完全无关的结论文本" },
      ["缓存"], ["不相关场景"]);
    check("F5 词与场景皆无命中 → 不覆盖（宁缺毋滥）", !r.hit, JSON.stringify(r));
  }
  {
    const r = isTopicRelevantConclusion(
      { sceneName: "工作/项目A", content: "无关" },
      [], ["工作"]);
    check("F5b 层级场景祖先段命中（detectSceneHit 同款语义）→ 覆盖", r.hit, JSON.stringify(r));
  }

  // F6-F10：computeCC 聚合
  {
    const inputs = [
      { queryId: "q1", conclusions: [{ sceneName: "", content: "缓存重建期间放行查询" }], annotationWords: ["放行查询"], annotationScenes: [] },
      { queryId: "q2", conclusions: [{ sceneName: "技术架构", content: "无关内容" }], annotationWords: ["架构"], annotationScenes: ["技术架构"] },
      { queryId: "q3", conclusions: [], annotationWords: ["某词"], annotationScenes: [] },
      { queryId: "q4", conclusions: [{ sceneName: "", content: "毫无相关的文本" }], annotationWords: ["缓存"], annotationScenes: [] },
    ];
    const cc = computeCC(inputs);
    check("F6 cc = 覆盖数/总数 = 2/4（全量口径，含结论层空 query）", near(cc.cc!, 0.5), `cc=${cc.cc}`);
    check("F7 cc' = 覆盖数/结论层非空数 = 2/3（层内命中率）", near(cc.ccConditional!, 2 / 3), `cc'=${cc.ccConditional}`);
    check("F8 统计字段一致", cc.coveredCount === 2 && cc.totalQueries === 4 && cc.queriesWithConclusions === 3, JSON.stringify({ covered: cc.coveredCount, total: cc.totalQueries, withConc: cc.queriesWithConclusions }));
    check("F9 逐 query 结果含覆盖判定与命中词（口径样本可追溯）",
      cc.perQuery.length === 4 && cc.perQuery[0]!.covered === true && cc.perQuery[0]!.hitWords.includes("放行查询") && cc.perQuery[2]!.hasConclusions === false,
      JSON.stringify(cc.perQuery));
  }
  {
    const cc = computeCC([]);
    check("F10 空 golden → cc/cc' 为 null（不伪造分母）", cc.cc === null && cc.ccConditional === null);
  }
  {
    const cc = computeCC([
      { queryId: "q1", conclusions: [], annotationWords: ["词"], annotationScenes: [] },
      { queryId: "q2", conclusions: [], annotationWords: ["词"], annotationScenes: [] },
    ]);
    check("F11 全部结论层空 → cc=0、cc'=null（分母 0）", cc.cc === 0 && cc.ccConditional === null, JSON.stringify({ cc: cc.cc, ccc: cc.ccConditional }));
  }
}

// ══════════════════════════════════════════════════════════
console.log("=".repeat(72));
console.log("[G] computeLayeredMetrics：逐 query 行 + 聚合");
console.log("=".repeat(72));
{
  const Q1_CONC = "- [结论] 缓存重建期间放行查询";
  const Q1_EXP = "- [episodic] 用户今天加班到很晚。 (活动时间: 2025-03-01)";
  const Q2_EXP_A = "- [persona] 甲乙丙丁";
  const Q2_EXP_B = "- [instruction] 戊己庚辛";
  const inputs = [
    {
      query: "q1",
      conclusionLines: [Q1_CONC],
      experienceLines: [Q1_EXP],
    },
    {
      query: "q2",
      conclusionLines: [],
      experienceLines: [Q2_EXP_A, Q2_EXP_B],
    },
    {
      query: "q3",
      conclusionLines: [],
      experienceLines: [], // 空注入 query
    },
  ];
  const m = computeLayeredMetrics(inputs);
  const q1 = m.perQuery.find((r) => r.query === "q1")!;
  const q3 = m.perQuery.find((r) => r.query === "q3")!;
  const q1Conc = Q1_CONC.length;
  const q1Exp = Q1_EXP.length;
  const q2ExpTotal = Q2_EXP_A.length + Q2_EXP_B.length;
  check("G1 逐 query 行：字符数正确", q1.conclusionChars === q1Conc && q1.totalChars === q1Conc + q1Exp, `conc=${q1.conclusionChars} total=${q1.totalChars}`);
  check("G1b 逐 query ctr/ald 有值且行数正确", q1.totalLineCount === 2 && q1.conclusionLineCount === 1 && near(q1.ctr, q1Conc / (q1Conc + q1Exp)), `ctr=${q1.ctr}`);
  check("G2 聚合 ctr = Σ结论字符/Σ总字符（micro）",
    near(m.ctr, q1Conc / (q1Conc + q1Exp + q2ExpTotal)), `ctr=${m.ctr}`);
  check("G2b 聚合 ald = Σ总字符/Σ行数",
    near(m.ald, (q1Conc + q1Exp + q2ExpTotal) / 4), `ald=${m.ald}`);
  check("G3 sd 均值 = 有注入 query 的逐 query H 均值（空注入 query 不进均值）",
    near(m.sd.meanEntropy, (q1.sd.entropy + m.perQuery.find((r) => r.query === "q2")!.sd.entropy) / 2), `meanH=${m.sd.meanEntropy}`);
  check("G4 空注入 query：行存在、指标为 0、不计入均值分母",
    q3.totalLineCount === 0 && q3.ctr === 0 && q3.ald === 0 && m.totals.queriesWithLines === 2, JSON.stringify(q3));
  check("G5 token 估算字段在位（IR 后续启用口径）",
    q1.tokens.conclusionTokens === estimateTokens(Q1_CONC) &&
    q1.tokens.totalTokens === estimateTokens(Q1_CONC) + estimateTokens(Q1_EXP),
    JSON.stringify(q1.tokens));
  check("G6 sd 分布均值五类键齐全",
    ["L2结论", "L1九通道", "scene补池", "value补池", "graph补池"].every((k) => k in (m.sd.meanDistribution as Record<string, number>)),
    JSON.stringify(m.sd.meanDistribution));
}

// ══════════════════════════════════════════════════════════
const pass = results.every((r) => r.pass);
console.log("");
console.log("=".repeat(72));
console.log(`总体：${pass ? "PASS" : "FAIL"}（${results.filter((r) => r.pass).length}/${results.length} 项通过）`);
console.log("=".repeat(72));
process.exit(pass ? 0 : 1);
