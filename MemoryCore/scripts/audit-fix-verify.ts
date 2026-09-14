/* 审计修复对抗性自审用 · 独立逻辑校验（绕开 vitest runner，直接跑 tsx）
 * 覆盖：A2（scorer 顶层 soul 字段）、B1（salienceBoost + classifyWithValues）、
 *      A1（parseConfig 三个新块）。
 * 仅验证纯逻辑；不启动服务。 */
import { scoreFor, classify, classifyWithValues, DEFAULT_FORGETTING_CONFIG } from "../src/core/lifecycle/forgetting/scorer.js";
import { salienceBoost } from "../src/core/lifecycle/feeling/appraisal.js";

let failed = 0;
function check(cond: boolean, msg: string) {
  if (!cond) { failed++; console.error("  ✗ " + msg); }
  else console.log("  ✓ " + msg);
}

function mkWithSoul(p: number, days: number, soul: { significance?: number; valence?: number }, content = "c") {
  const t = new Date(Date.now() - days * 86_400_000).toISOString();
  return {
    id: "m", content, type: "episodic", priority: p, scene_name: "s", source_message_ids: [],
    metadata: { activity_start_time: t, occurred_at: t }, timestamps: [t], occurred_at: t,
    createdAt: "", updatedAt: "", version: 1, sessionKey: "k", sessionId: "sid",
    ...(soul.significance != null ? { significance: soul.significance } : {}),
    ...(soul.valence != null ? { valence: soul.valence } : {}),
  };
}

// 用 age 50 天（decay=e^-0.5=0.6065）：能让 显著性 vs lowThreshold 的差异真实显现
const AGE = 50;
const CFG = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.3 };

// score = significance * (priority/100) * decay
// sig0.9*0.8*0.606=0.437 → keep；sig0.1*0.8*0.606=0.0485 → archive；sig0.2*0.4*0.606=0.0485 → archive(基线)
console.log("== A2: 遗忘打分读顶层 soul 字段 ==");
{
  const now = Date.now();
  const hi = mkWithSoul(80, AGE, { significance: 0.9 });
  const lo = mkWithSoul(80, AGE, { significance: 0.1 });
  check(classify(hi, CFG, now) === "keep", "significance=0.9 顶层 → keep（A2 修复后不再恒 0.5）");
  check(classify(lo, CFG, now) === "archive", "significance=0.1 顶层 → archive");
  check(scoreFor(hi, CFG, now) > scoreFor(lo, CFG, now), "高显著分数>低显著");
  // 证明"若仍按旧 bug（恒0.5）→ 两样本同分"，从而确认修复真正影响判定
  const scoreSig09 = scoreFor(hi, CFG, now);
  check(scoreSig09 !== 0.5 * 0.8 * Math.exp(-CFG.lambda * AGE), "分数确实用了顶层显著性(非0.5兜底)");
}

console.log("== B1: salienceBoost + classifyWithValues ==");
{
  const values = [{ id: "perf", label: "性能", weight: 0.9 }];
  const now = Date.now();
  // 基线：sig0.2*0.4*0.606=0.0485 → archive；boost+0.1 → 0.1485 < 0.3 仍 archive，
  // 需选一个"boost 能跨阈值"的样本：sig0.25*0.4*0.606=0.0606，boost0.3? 不行。
  // 改用低阈值 0.12（与 yaml 一致）：sig0.2*0.4*0.606=0.0485<0.12 archive；
  // boost +0.1 → 0.1485>0.12 keep。
  const cfg12 = { ...DEFAULT_FORGETTING_CONFIG, minAgeDays: 1, lowThreshold: 0.12 };
  const base = mkWithSoul(40, AGE, { significance: 0.2 }, "某普通记录");
  check(classify(base, cfg12, now) === "archive", "无价值命中时 archive（low=0.12）");
  const hit = mkWithSoul(40, AGE, { significance: 0.2 }, "性能优化关键决策记录");
  check(salienceBoost("性能优化", values, { enabled: true, firedThreshold: 0.4 }) > 0, "salienceBoost>0");
  check(classifyWithValues(hit, values, cfg12, now) === "keep", "命中价值 → keep（更难被遗忘，low=0.12）");
  check(classifyWithValues(base, [], cfg12, now) === classify(base, cfg12, now), "values为空→与classify一致");
}

console.log("== A1: parseConfig 三块 ==");
{
  const { parseConfig } = await import("../src/config.js");
  const c = parseConfig({
    links: { enabled: false },
    lifecycle: { enabled: false, intervalMs: 1111, consolidation: { minCount: 9, persist: false }, forgetting: { minAgeDays: 99 } },
    search: { neighborExpand: { enabled: true, maxHop: 3, maxAdd: 7 } },
  });
  check(c.links.enabled === false, "links.enabled=false 解析生效");
  check(c.lifecycle.enabled === false, "lifecycle.enabled=false 解析生效");
  check(c.lifecycle.intervalMs === 1111, "lifecycle.intervalMs 解析生效");
  check(c.lifecycle.consolidation.minCount === 9, "consolidation.minCount 解析生效");
  check(c.lifecycle.consolidation.persist === false, "consolidation.persist 解析生效");
  check(c.lifecycle.forgetting.minAgeDays === 99, "forgetting.minAgeDays 解析生效");
  check(c.search.neighborExpand.enabled === true, "search.neighborExpand.enabled 解析生效");
  check(c.search.neighborExpand.maxHop === 3, "neighborExpand.maxHop 解析生效");
  // 缺省
  const d = parseConfig({});
  check(d.links.enabled === true, "缺省 links.enabled=true");
  check(d.lifecycle.enabled === true, "缺省 lifecycle.enabled=true");
  check(d.lifecycle.intervalMs === 600000, "缺省 intervalMs=600000");
  check(d.lifecycle.consolidation.minCount === 3, "缺省 minCount=3");
  check(d.lifecycle.forgetting.lowThreshold === 0.12, "缺省 lowThreshold=0.12");
  check(d.search.neighborExpand.enabled === false, "缺省 neighborExpand.enabled=false（宁缺毋滥）");
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);