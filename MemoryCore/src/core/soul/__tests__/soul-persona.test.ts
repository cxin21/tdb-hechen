/**
 * 自维护人格层（m00527）单测 A：判定器 / 情绪 / 漂移 / 条目生命周期 / 工作者端到端。
 *
 * 铁律：不碰生产库、不联网、不调真实 LLM（fake store + 纯函数）。
 * 每条断言都钉一个「可判定」行为——不是"看起来对"，而是某个输入下必须发生/必须不发生。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SOUL_MAINTENANCE_CONFIG,
  resolveSoulConfig,
  type PersonaItem,
  type SoulLedgerEntry,
} from "../types.js";
import { churnGate, classifyLine, evaluateCandidate, allPass, failedCodes, hasVerbatimSupport, textHash } from "../gates.js";
import {
  planAdmit,
  planContradiction,
  planLifecycle,
  planMerge,
  planRevive,
  planUpdate,
  renderLayerWithBudget,
  renderPersonaBlock,
  orderForRender,
} from "../persona.js";
import {
  activeEmotions,
  appraiseEmotion,
  decayedIntensity,
  emptyMood,
  integrateMood,
  readMood,
  renderMoodLine,
} from "../emotion.js";
import { measureDrift, pushDrift, trackOf } from "../drift.js";
import { mineCandidates, parseSoulRewriteOutput, runSoulMaintenance, createSoulRewriter } from "../worker.js";
import { planConsolidation } from "../consolidator.js";

const CFG = resolveSoulConfig({ enabled: true });
const NOW = "2026-11-05T12:00:00.000Z";

// ───────────────────────────── 判定器

describe("gates：人格 vs 方法论 vs 事件", () => {
  it("事件/进度句一定不进人格层（method 或 null），且给出 event_sentence 码", () => {
    const lines = [
      "我完成了 commit b8ba3e0 并推送",
      "我在 #179 复审中确认 floor 阈值 p50=0.3126",
      "今天把测试跑了一遍，还剩 3 个待办",
      "tests 全绿，已关票",
    ];
    for (const line of lines) {
      const cls = classifyLine(line);
      expect(cls.layer === null || cls.layer === "method").toBe(true);
      expect(cls.reports.some((r) => r.code === "event_sentence" || r.code === "stage_word")).toBe(true);
    }
  });

  it("纯方法论进 method（不注入），含取舍的进 values", () => {
    expect(classifyLine("我的做法是先写测试再写实现，一律逐条验收").layer).toBe("method");
    const values = classifyLine("宁可少交付一个功能，也不交付一个自己没验证过的结论");
    expect(values.layer).toBe("values");
    expect(allPass(values.reports)).toBe(true);
  });

  it("红线形态进 boundary；换项目即不成立的内容被 project_bound 拦下", () => {
    expect(classifyLine("绝不把情绪数据喂进召回，任何情况下都不允许").layer).toBe("boundary");
    const g = evaluateCandidate("我在 MemoryCore 的 v2-router 里必须先校验返回值", {
      layer: "identity",
      now: NOW,
      existing: [],
      config: CFG,
    });
    expect(failedCodes(g)).toContain("project_bound");
    expect(allPass(g)).toBe(false);
  });

  it("红线字数帽与两难门都是硬门（不是提示）", () => {
    const longRedline =
      "绝不在没有备份的情况下修改生产配置，必须先验证真值并留可回滚备份，同时把回滚步骤写清楚，保证任何人接手都能复原；" +
      "任何配置改动都要先在生产环境之外的副本上验证一遍，再逐项核对差异，确认没有影响其他字段之后才允许写入，并在写入后立刻回读确认生效范围";
    const g = evaluateCandidate(longRedline, { layer: "boundary", now: NOW, existing: [], config: CFG });
    expect(longRedline.length).toBeGreaterThan(CFG.redlineMaxChars);
    expect(failedCodes(g)).toContain("redline_shape");

    const noDilemma = evaluateCandidate("我在意工程质量", { layer: "values", now: NOW, existing: [], config: CFG });
    expect(failedCodes(noDilemma)).toContain("dilemma_missing");
  });

  it("证据独立性：证据全来自 soul/model 自述时拒绝（防自我强化回声室）", () => {
    const g = evaluateCandidate("我宁可慢一点也要一手证据", {
      layer: "values",
      now: NOW,
      existing: [],
      config: CFG,
      evidenceOrigins: ["soul", "model"],
    });
    expect(failedCodes(g)).toContain("self_evidence");
  });

  it("relationship 层要求用户原话逐字支撑", () => {
    const corpus = ["用户说：不要为了跑绿而改测试，难看就难看，别糊弄我"];
    expect(hasVerbatimSupport("不要为了跑绿而改测试", corpus, CFG.verbatimMinChars)).toBe(true);
    const g = evaluateCandidate("他信任我的判断", {
      layer: "relationship",
      now: NOW,
      existing: [],
      config: CFG,
      userCorpus: corpus,
    });
    expect(failedCodes(g)).toContain("verbatim_missing");
  });

  it("正向判据：没有立场/代价/出处/原话的「人格」进不来（问题不是像不像，是凭什么知道）", () => {
    const base = { now: NOW, existing: [], config: CFG, evidenceOrigins: ["tool" as const] };
    // 只有形容词/描述，没有站哪边。
    const noStance = evaluateCandidate("我是个严谨的人", { ...base, layer: "identity" });
    expect(failedCodes(noStance)).toContain("stance_missing");
    // 有立场没代价：只是口号，不是价值。
    const noCost = evaluateCandidate("我认为证据比速度重要", { ...base, layer: "values" });
    expect(failedCodes(noCost)).toContain("cost_missing");
    // 有立场与代价，但没有真实事件出处。
    const noEpisode = evaluateCandidate("我宁可慢一点也要一手证据，放弃速度", { ...base, layer: "values" });
    expect(failedCodes(noEpisode)).toContain("episode_missing");
    // voice 必须逐字引用助手原话（不许自己总结说话风格）。
    const noQuote = evaluateCandidate("我说话短，先结论", { ...base, layer: "voice", userCorpus: [], voiceFewShots: [] });
    expect(failedCodes(noQuote)).toContain("voice_quote_missing");
    // 第三人称用户画像不能占据「我的说话方式」。
    const thirdPerson = evaluateCandidate("他开口像下工单，先给结论", { ...base, layer: "voice", userCorpus: [], voiceFewShots: [] });
    expect(failedCodes(thirdPerson)).toContain("voice_self_missing");
    // narrative 没有来路=不是来历。
    const noOrigin = evaluateCandidate("每次都要先写测试再写实现", { ...base, layer: "narrative", evidenceEpisodeIds: ["ep-a1b2c3"] });
    expect(failedCodes(noOrigin)).toContain("narrative_method");
  });

  it("自我模型与非效率价值：只有效率修辞/没有自我承诺/没有具体的人 → 各自被对应码拒", () => {
    const base = { now: NOW, existing: [], config: CFG, evidenceOrigins: ["tool" as const] };
    const efficiency = evaluateCandidate("我宁可慢一点也要效率优先，放弃质量", {
      ...base,
      layer: "values",
      evidenceEpisodeIds: ["ep-a1b2c3", "ep-d4e5f6"],
    });
    expect(failedCodes(efficiency)).toContain("intrinsic_missing");
    const noSelf = evaluateCandidate("我会继续努力做得更好", { ...base, layer: "self", evidenceEpisodeIds: ["ep-a1b2c3", "ep-d4e5f6"] });
    expect(failedCodes(noSelf)).toContain("self_missing");
    const genericRelation = evaluateCandidate("我们之间是长期协作关系", {
      ...base,
      layer: "relationship",
      userCorpus: ["我们之间是长期协作关系"],
      personName: CFG.personName,
    });
    expect(failedCodes(genericRelation)).toContain("relationship_person_missing");
  });

  it("自我模型可满足：对自己的承诺 + 我表过态的事件 → self 全绿", () => {
    const g = evaluateCandidate("我不愿变成只会跑绿的人，哪怕慢一点也要把真话说清", {
      layer: "self",
      now: NOW,
      existing: [],
      config: CFG,
      evidenceOrigins: ["tool"],
      evidenceEpisodeIds: ["ep-a1b2c3", "ep-d4e5f6"],
    });
    expect(allPass(g)).toBe(true);
  });

  it("正向判据可满足：立场+代价+两个真实 episode → values 全绿（不是只拦不放）", () => {
    const g = evaluateCandidate("宁可慢一点，也要一手证据，放弃一部分速度", {
      layer: "values",
      now: NOW,
      existing: [],
      config: CFG,
      evidenceOrigins: ["tool"],
      evidenceEpisodeIds: ["ep-a1b2c3", "ep-d4e5f6"],
    });
    expect(allPass(g)).toBe(true);
  });
});

// ───────────────────────────── 条目生命周期

describe("persona：准入 / 更新 / 合并 / 降级 / 冻结 / 复活 / 预算", () => {
  // 2026-11-05 正向判据：identity/values 必须点名真实事件（ep-*），narrative 同理。
  // 测试里的「真实事件」用两个稳定假 id 代表已挖掘的 episode——判据只校验形态与数量，
  // 与 LLM 是否编造由 worker 侧的 pool 过滤负责（见 soul-worker 契约测试）。
  const EP = ["ep-a1b2c3", "ep-d4e5f6"];
  const admit = (text: string, layer: "values" | "boundary" = "values") =>
    planAdmit({
      layer,
      text,
      now: NOW,
      existing: [],
      config: CFG,
      evidenceOrigins: ["tool"],
      evidenceEpisodeIds: layer === "values" ? EP : [],
    }).item!;

  it("准入产出稳定 itemId（同文本同层幂等）", () => {
    const a = admit("宁可少交付一个功能，也不交付一个自己没验证过的结论");
    const b = admit("宁可少交付一个功能，也不交付一个自己没验证过的结论");
    expect(a.itemId).toBe(b.itemId);
  });

  it("α 以内的改写通过，整块翻修被拒并给出 diff", () => {
    const longText =
      "宁可慢一点，也要一手证据：先去现场亲自跑一遍，看清楚真实错误和真实数字，再回来下结论，而不是听别人转述";
    const item = admit(longText);
    const small = planUpdate(item, longText.replace("别人", "他人"), NOW, CFG);
    expect(small.ok).toBe(true);
    expect(small.diff).toBeLessThanOrEqual(CFG.alpha);
    const big = planUpdate(item, "我完全换了一套价值判断标准：效率优先，结果导向，能做成就行", NOW, CFG);
    expect(big.ok).toBe(false);
    expect(big.diff).toBeGreaterThan(CFG.alpha);
  });

  it("变更率门：同层窗口内已改写过的条目，新候选被 churn_exceeded 拒", () => {
    const base = admit("宁可慢一点，也要一手证据，而不是听别人转述");
    const rewritten: PersonaItem = { ...base, updatedAt: "2026-11-04T12:00:00.000Z", meta: { lastRewriteAt: "2026-11-04T12:00:00.000Z" } };
    const g = evaluateCandidate("宁可慢一点，也要一手证据，而不是听别人转述", {
      layer: "values",
      now: NOW,
      existing: [rewritten],
      config: CFG,
      evidenceOrigins: ["tool"],
      evidenceEpisodeIds: EP,
    });
    expect(failedCodes(g)).toContain("churn_exceeded");
  });

  it("冻结/已并条目不再占用变更率额度（槽迁移后新层能生长）", () => {
    const base = admit("宁可慢一点，也要一手证据，而不是听别人转述");
    const frozen: PersonaItem = {
      ...base,
      itemId: "values:legacy",
      state: "frozen",
      updatedAt: "2026-11-04T12:00:00.000Z",
    };
    const g = evaluateCandidate("宁可交回没核实的那格，也不说没问题", {
      layer: "values",
      now: NOW,
      existing: [frozen],
      config: CFG,
      evidenceOrigins: ["tool"],
      evidenceEpisodeIds: EP,
    });
    expect(failedCodes(g)).not.toContain("churn_exceeded");
  });

  it("合并保留权重最高者，被并者转 merged + mergedInto + aliases（可拆回）", () => {
    const a = admit("宁可慢一点，也要一手证据，而不是听别人转述");
    const b: PersonaItem = { ...admit("宁可慢一点，也要一手证据，而不是听他人转述"), weight: 0.4 };
    const plan = planMerge([a, b], 0.6, NOW);
    expect(plan.survivors.length + plan.merged.length).toBe(2);
    if (plan.merged.length > 0) {
      const merged = plan.survivors.find((s) => s.mergedInto) ?? plan.survivors[0];
      expect(plan.merged[0].into).toBeTruthy();
      expect(plan.survivors.some((s) => (s.aliases ?? []).length > 0)).toBe(true);
      expect(merged).toBeTruthy();
    }
  });

  it("合并不吃自己：已 merged 的条目不再当候选（否则每轮重新合并、账本 noise 无界）", () => {
    const a = admit("宁可慢一点，也要一手证据，而不是听别人转述");
    const b: PersonaItem = { ...admit("宁可慢一点，也要一手证据，而不是听他人转述"), weight: 0.4 };
    const first = planMerge([a, b], 0.6, NOW);
    expect(first.merged).toHaveLength(1);
    const second = planMerge([...first.survivors, ...first.merged.map((m) => m.item)], 0.6, NOW);
    expect(second.merged).toHaveLength(0);
  });

  it("30 天无证据降级（weight×0.7）、90 天或矛盾 2 次冻结，均不删除", () => {
    const fresh = admit("宁可少交付一个功能，也不交付一个自己没验证过的结论");
    const stale: PersonaItem = { ...fresh, lastEvidenceAt: "2026-09-20T12:00:00.000Z" };
    const old: PersonaItem = { ...fresh, lastEvidenceAt: "2026-07-01T12:00:00.000Z" };
    const plan = planLifecycle([stale, old], NOW, CFG);
    expect(plan.degraded).toHaveLength(1);
    expect(plan.frozen).toHaveLength(1);
    expect(plan.items).toHaveLength(2); // 只改状态，不删
    const degraded = plan.items.find((i) => i.state === "degraded")!;
    expect(degraded.weight).toBeCloseTo(fresh.weight * CFG.degradeWeightFactor, 3);

    let conflicted: PersonaItem = { ...fresh };
    conflicted = planContradiction(conflicted, NOW, CFG);
    conflicted = planContradiction(conflicted, NOW, CFG);
    expect(conflicted.state).toBe("frozen");
  });

  it("生命周期状态迁移不占 7 天改写额度，只有正文改写才占", () => {
    const item: PersonaItem = { ...admit("宁可慢一点，也要一手证据"), createdAt: "2026-10-01T12:00:00.000Z", updatedAt: NOW, state: "degraded" };
    expect(churnGate("values", [item], NOW, CFG).pass).toBe(true);
    const rewritten: PersonaItem = { ...item, meta: { lastRewriteAt: NOW } };
    expect(churnGate("values", [rewritten], NOW, CFG).pass).toBe(false);
  });

  it("复活回到 active，权重不低于 0.5，矛盾清零", () => {
    const frozen: PersonaItem = { ...admit("宁可少交付一个功能，也不交付一个自己没验证过的结论"), state: "frozen", weight: 0.2, contradictions: 2 };
    const revived = planRevive(frozen, NOW, ["rec-9"]);
    expect(revived.state).toBe("active");
    expect(revived.weight).toBeGreaterThanOrEqual(0.5);
    expect(revived.contradictions).toBe(0);
  });

  it("预算超额逐条进 omitted（不许静默砍），frozen/merged 也记账", () => {
    const items: PersonaItem[] = [
      admit("宁可慢一点，也要一手证据，而不是听别人转述"),
      { ...admit("宁可少交付一个功能，也不交付一个自己没验证过的结论"), state: "frozen" },
    ];
    const { report } = renderLayerWithBudget(
      "values",
      items,
      resolveSoulConfig({ enabled: true, budget: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.budget, values: 20 } }),
    );
    expect(report.rendered).toBeLessThanOrEqual(1);
    expect(report.omitted.length).toBeGreaterThanOrEqual(1);
    expect(report.omitted.map((o) => o.reason)).toContain("frozen");
  });

  it("maxItems 是渲染侧硬上限：免预算的边界层也不许无界膨胀，超出逐条记 max_items", () => {
    const items: PersonaItem[] = Array.from({ length: 3 }, (_, i) =>
      admit(`绝不执行第${i + 1}类未经授权的生产写操作，必须先取证`, "boundary"),
    );
    const { text, report } = renderLayerWithBudget(
      "boundary",
      items,
      resolveSoulConfig({ enabled: true, maxItems: { ...DEFAULT_SOUL_MAINTENANCE_CONFIG.maxItems, boundary: 2 } }),
    );
    expect(report.rendered).toBe(2);
    expect(report.omitted.filter((o) => o.reason === "max_items")).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("染层只渲染本层条目：调用方传全量也不会把别的层塞进本段", () => {
    const mixed = [admit("宁可慢一点，也要一手证据"), admit("绝不把情绪数据喂进召回，任何情况下都不允许", "boundary")];
    const { text, report } = renderLayerWithBudget("values", mixed, CFG);
    expect(report.rendered).toBe(1);
    expect(text).toContain("一手证据");
    expect(text).not.toContain("情绪数据");
  });

  it("当前情绪改变渲染序：愧疚先看见自己的失败，恼火先看见关系冲突", () => {
    const mk = (itemId: string, layer: "self" | "relationship", text: string, weight: number, kind: string): PersonaItem => ({
      itemId,
      layer,
      text,
      state: "active",
      weight,
      evidenceIds: [],
      evidenceDays: [],
      evidenceOrigins: [],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: kind },
    });
    const failure = mk("self:failure", "self", "我一开始没做对：「按钮状态不对」；后来改成先量再改", 0.7, "failure");
    const review = mk("self:review", "self", "我复盘过：先取证再动手", 0.75, "review");
    // 缺省（无情绪）仍按权重：复盘在前
    expect(orderForRender("self", [failure, review])[0]!.itemId).toBe("self:review");
    // 愧疚是自我向：失败排到复盘前（同一组条目，只因情绪不同而换序）
    expect(orderForRender("self", [failure, review], { attention: { object: "", focus: "self" } })[0]!.itemId).toBe("self:failure");
    // 恼火是向外向：自我段不被情绪带偏
    expect(orderForRender("self", [failure, review], { attention: { object: "", focus: "conflict" } })[0]!.itemId).toBe("self:review");

    const conflict = mk("relationship:conflict", "relationship", "「按钮组看着还是不对」我当时没修好", 0.6, "conflict");
    const repair = mk("relationship:repair", "relationship", "我补上了：设置页六页逐项量过", 0.8, "repair");
    expect(orderForRender("relationship", [conflict, repair])[0]!.itemId).toBe("relationship:repair");
    expect(orderForRender("relationship", [conflict, repair], { attention: { object: "", focus: "conflict" } })[0]!.itemId).toBe("relationship:conflict");
  });

  it("情绪放大相关层的注意力预算：愧疚时看见更多自己的失败，不放大无关层", () => {
    const mk = (i: number): PersonaItem => ({
      itemId: "self:f" + i,
      layer: "self",
      text: "我没守住：「第" + i + "次没做对的地方」；后来改成先量再改，六页逐项量过",
      state: "active",
      weight: 0.7,
      evidenceIds: [],
      evidenceDays: [],
      evidenceOrigins: [],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: "failure" },
    });
    const items = Array.from({ length: 12 }, (_, i) => mk(i));
    const base = renderPersonaBlock(items, CFG);
    const guilty = renderPersonaBlock(items, CFG, { attention: { object: "", focus: "self" } });
    const conflict = renderPersonaBlock(items, CFG, { attention: { object: "", focus: "conflict" } });
    const n = (b: { text: string }) => b.text.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(n(base)).toBeLessThan(n(guilty));
    expect(n(conflict)).toBe(n(base));
  });

  it("承诺保底一条：预算被失败/复盘占满时，「我答应自己」不许被静默裁掉", () => {
    const mk = (i: number): PersonaItem => ({
      itemId: "self:f" + i,
      layer: "self",
      text: "我没守住：「第" + i + "次没做对的地方」；后来改成先量再改，六页逐项量过并回读确认",
      state: "active",
      weight: 0.7,
      evidenceIds: [],
      evidenceDays: [],
      evidenceOrigins: [],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: "failure" },
    });
    const promise: PersonaItem = { ...mk(99), itemId: "self:p", text: "我答应自己：交出去的每一格要么亲手跑过，要么明写未采集", weight: 0.6, meta: {} };
    const block = renderPersonaBlock([...Array.from({ length: 9 }, (_, i) => mk(i)), promise], CFG);
    expect(block.text).toContain("我答应自己");
  });

  it("事件史承诺被预算挤出时仍保底，并带兑现后缀", () => {
    const mk = (i: number): PersonaItem => ({
      itemId: "self:f" + i,
      layer: "self",
      text: "我没守住：「第" + i + "次没做对的地方」；后来改成先量再改，六页逐项量过并回读确认",
      state: "active",
      weight: 0.7,
      evidenceIds: [],
      evidenceDays: [],
      evidenceOrigins: [],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: "failure" },
    });
    const promise: PersonaItem = {
      ...mk(99),
      itemId: "self:hx-p",
      text: "我答应过自己：「以后每次改导出都先用真实数据跑一遍再回你」",
      weight: 0.6,
      meta: { historyKind: "promise", fulfillment: "kept" },
    };
    const block = renderPersonaBlock([...Array.from({ length: 9 }, (_, i) => mk(i)), promise], CFG);
    expect(block.text).toContain("我答应过自己");
    expect(block.text).toContain("（后来做到了）");
  });

  it("渲染层顺序与段头固定：boundary 按作用域再按权重", () => {
    const universal = { ...admit("绝不把情绪数据喂进召回，任何情况下都不允许", "boundary"), weight: 0.5, meta: { scope: "universal" } };
    const mini = { ...admit("绝不在没有备份的情况下修改生产配置，必须先验证真值", "boundary"), weight: 0.9, meta: { scope: "project" } };
    const block = renderPersonaBlock([universal, mini], CFG);
    expect(block.text.startsWith("## 我不做的事")).toBe(true);
    expect(block.text.indexOf("情绪数据")).toBeLessThan(block.text.indexOf("备份"));
  });

  it("关系史信任方向渲染成可见后缀：up/down 不靠读者猜", () => {
    const mk = (direction: "up" | "down"): PersonaItem => ({
      itemId: "relationship:t-" + direction,
      layer: "relationship",
      text: direction === "up" ? "何晨把方案权交出来。" : "他开始不太放心。",
      state: "active",
      weight: 0.9,
      evidenceIds: ["ep-1"],
      evidenceDays: ["2026-11-05"],
      evidenceOrigins: ["episode"],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: "trust", direction },
    });
    const up = renderPersonaBlock([mk("up")], CFG);
    const down = renderPersonaBlock([mk("down")], CFG);
    expect(up.text).toContain("（信任↑）");
    expect(down.text).toContain("（信任↓）");
  });

  it("承诺兑现渲染成可见后缀：做到了/没做到不靠读者翻 meta", () => {
    const mk = (fulfillment: "kept" | "broken"): PersonaItem => ({
      itemId: "self:p-" + fulfillment,
      layer: "self",
      text: "我答应过自己：交出去的每一格都要有实测数字。",
      state: "active",
      weight: 0.72,
      evidenceIds: ["ep-p"],
      evidenceDays: ["2026-11-05"],
      evidenceOrigins: ["episode"],
      createdAt: NOW,
      updatedAt: NOW,
      lastEvidenceAt: NOW,
      meta: { historyKind: "promise", fulfillment },
    });
    expect(renderPersonaBlock([mk("kept")], CFG).text).toContain("（后来做到了）");
    expect(renderPersonaBlock([mk("broken")], CFG).text).toContain("（后来没做到）");
  });
});

// ───────────────────────────── 情绪 / 心境

describe("emotion：情绪有对象并衰减，心境无对象有基线", () => {
  it("情绪按半衰期衰减；低于阈值的情绪退出活跃集", () => {
    const ev = appraiseEmotion({
      id: "e1",
      at: NOW,
      object: "召回精度",
      appraisal: { goalRelevance: 0.8, expectationViolation: -0.6, control: 0.4, normCompatibility: 0.8, agency: "self" },
      halfLifeHours: CFG.emotionHalfLifeHours,
    });
    expect(ev.intensity).toBeGreaterThan(0.2);
    expect(decayedIntensity(ev, NOW)).toBeCloseTo(ev.intensity, 5);
    const later = new Date(Date.parse(NOW) + CFG.emotionHalfLifeHours * 3600_000).toISOString();
    expect(decayedIntensity(ev, later)).toBeCloseTo(ev.intensity / 2, 2);
    const muchLater = new Date(Date.parse(NOW) + 12 * CFG.emotionHalfLifeHours * 3600_000).toISOString();
    expect(activeEmotions([ev], muchLater, 0.15)).toHaveLength(0);
  });

  it("心境是慢变量：单次强情绪只把读数推离基线一部分，随后向基线回落", () => {
    const base = emptyMood(NOW);
    const ev = appraiseEmotion({
      id: "e2",
      at: NOW,
      object: "召回精度",
      appraisal: { goalRelevance: 0.9, expectationViolation: 0.9, control: 0.2, normCompatibility: 0.9, agency: "environment" },
      halfLifeHours: CFG.emotionHalfLifeHours,
    });
    const spike = integrateMood(base, [ev], NOW, CFG);
    expect(spike.valence).toBeLessThan(base.valence);
    expect(Math.abs(spike.valence - base.baselineValence)).toBeLessThan(0.5); // 不被单次事件拉满
    const later = new Date(Date.parse(NOW) + 3 * CFG.moodHalfLifeHours * 3600_000).toISOString();
    const settled = integrateMood(spike, [], later, CFG);
    expect(Math.abs(settled.valence - settled.baselineValence)).toBeLessThan(Math.abs(spike.valence - spike.baselineValence));
  });

  it("渲染给的是「与基线比」的读数，并只在有对象、够强时才给理由", () => {
    const mood = { valence: -0.4, arousal: 0.3, baselineValence: 0.1, baselineArousal: 0.3, updatedAt: NOW, sampleCount: 5 };
    const line = renderMoodLine(mood, { threshold: CFG.moodDeviationThreshold });
    expect(line).toContain("比基线");
    const reading = readMood(mood, { threshold: CFG.moodDeviationThreshold });
    expect(reading.deltaValence).toBeLessThan(0);
    expect(reading.phrase).toBeTruthy();
    const noObject = readMood(mood, { emotion: { ...appraiseEmotion({ id: "x", at: NOW, object: "", appraisal: { goalRelevance: 0.9, expectationViolation: -0.9, control: 0.5, normCompatibility: 0.9, agency: "self" } }) }, threshold: CFG.moodDeviationThreshold });
    expect(noObject.reason).toBeFalsy(); // 对象未知 → 不给理由（不编）
  });
});

// ───────────────────────────── 漂移与停用

describe("drift：连续低分才降级/冻结，判断轨禁止自我复位", () => {
  const anchors = ["宁可慢一点，也要一手证据，而不是听别人转述"];

  it("无锚不伪造分数（ok + 明确 method=none）", async () => {
    const r = await measureDrift({ layer: "identity", anchors: [], text: "我在意工程质量", config: CFG });
    expect(r.score).toBe(0);
    expect(r.verdict).toBe("ok");
    expect(r.detail).toContain("不伪造分数");
  });

  it("连续 3 次低于冻结线 → freeze；只低于降级线 → degrade", async () => {
    let history: number[] = [];
    const far = "完全无关的一段话：今天吃了面条，天气不错，适合出门散步和晒太阳直到傍晚";
    for (let i = 0; i < CFG.driftConsecutive; i++) {
      const r = await measureDrift({ layer: "identity", anchors, text: far, history, config: CFG });
      history = pushDrift(history, r.score, CFG.driftHistorySize);
      if (i < CFG.driftConsecutive - 1) expect(r.verdict).not.toBe("freeze");
      else expect(r.verdict).toBe("freeze");
    }
  });

  it("判断轨（values/boundary）永不自我复位；语体轨可以", () => {
    expect(trackOf("values")).toBe("judgment");
    expect(trackOf("voice")).toBe("voice");
    const { canSelfReset } = { canSelfReset: (layer: string) => trackOf(layer as never) === "voice" };
    expect(canSelfReset("boundary")).toBe(false);
    expect(canSelfReset("voice")).toBe(true);
  });
});

// ───────────────────────────── 工作者（fake store）

function fakeStore(coreRows: Array<{ slot: string; content: string }>) {
  const committed: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] }[] = [];
  const state: Record<string, unknown> | null = null;
  let moodRow: Record<string, unknown> | null = state as never;
  const store = {
    readCore: () => coreRows,
    listSoulPersona: () => [] as PersonaItem[],
    commitSoulPersona: (_t: unknown, p: { upsert: PersonaItem[]; ledger: SoulLedgerEntry[] }) => {
      committed.push(p);
      return { upserted: p.upsert.length, ledgered: p.ledger.length };
    },
    readSoulState: () => moodRow,
    writeSoulState: (_t: unknown, s: Record<string, unknown>) => {
      moodRow = { ...s };
    },
    recentAffectSignals: () => [
      { valence: -0.6, arousal: 0.7, occurred_at: NOW },
      { valence: -0.5, arousal: 0.6, occurred_at: NOW },
    ],
    readCoreValue: () => [],
  };
  return { store, committed, mood: () => moodRow };
}

describe("worker：七阶段一轮跑完并如实记账", () => {
  const coreRows = [
    { slot: "identity", content: "- 用户何晨是 TDB 的设计者\n- 用户只接受完整版交付" },
    { slot: "self_identity", content: "- 我在云文库窄栏重设计中完成 commit b8ba3e0 并推送\n- 我宁可慢一点，也要一手证据，而不是听别人转述" },
    { slot: "strict_rule", content: "- 绝不把情绪（mood）数据喂进召回，任何情况下都不允许\n- 测试一律走临时目录，绝不触碰生产数据" },
    { slot: "core_value", content: "- 一手证据：先自己跑一遍再说" },
  ];

  it("事件句与方法论进 method 池不注入；红线/两难句各自落层；账本逐条可读", async () => {
    const { store, committed } = fakeStore(coreRows);
    const report = await runSoulMaintenance({
      store: store as never,
      tenant: { teamId: "t", userId: "u", agentId: "a" },
      now: NOW,
      config: { enabled: true },
      // 2026-11-05 起 lifecycle/manual 不再把存量槽导入人格层（见下方 retire 用例）；
      // 本用例锁的是「显式导入」这条路径的分层与记账仍然正确。
      trigger: "import",
    });
    expect(report.stored).toBe(true);
    const items = committed.at(-1)!.upsert;
    const layers = new Set(items.map((i) => i.layer));
    expect(layers.has("boundary")).toBe(true);
    expect(layers.has("values")).toBe(true);
    // commit 事件句留在 method 审计池，绝不进任何注入层
    const injected = items.filter((i) => i.layer !== "method");
    expect(injected.some((i) => i.text.includes("b8ba3e0"))).toBe(false);
    expect(items.some((i) => i.layer === "method" && i.text.includes("b8ba3e0"))).toBe(true);
    expect(report.ledgerEntries).toBeGreaterThan(0);
    // 只要写成功，报告里 imported 数必须等于真实贡献条目的槽行数来源（不虚报）
    expect(report.imported).toBeGreaterThan(0);
  });

  it("存量槽导入条目在 lifecycle 轮次退出注入层（冻结+账本），不再伪装成「我不做的事」", async () => {
    const { store, committed } = fakeStore([]);
    const slotItem: PersonaItem = {
      itemId: "boundary:legacy",
      layer: "boundary",
      text: "补货建议查询必须先校验仓库权限",
      state: "active",
      weight: 0.8,
      evidenceIds: ["slot:strict_rule:1"],
      evidenceDays: ["2026-10-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastEvidenceAt: "2026-10-01T00:00:00.000Z",
      meta: { source: "slot-import" },
    };
    (store as unknown as { listSoulPersona: () => PersonaItem[] }).listSoulPersona = () => [slotItem];
    const report = await runSoulMaintenance({
      store: store as never,
      tenant: { teamId: "t", userId: "u", agentId: "a" },
      now: NOW,
      config: { enabled: true },
      trigger: "lifecycle",
    });
    expect(report.retired).toBe(1);
    const payload = committed.at(-1)!;
    expect(payload.upsert.find((i) => i.itemId === "boundary:legacy")?.state).toBe("frozen");
    expect(payload.ledger.some((l) => l.action === "retire" && l.gates.includes("legacy_slot_retired"))).toBe(true);
  });

  it("slot-import 的用户档案退出「我和他的关系」，生成的关系史留下", async () => {
    const profile: PersonaItem = {
      itemId: "relationship:profile",
      layer: "relationship",
      text: "用户名叫何晨，时区 Asia/Shanghai",
      state: "active",
      weight: 0.7,
      evidenceIds: ["slot:identity:1"],
      evidenceDays: ["2026-10-01"],
      evidenceOrigins: ["l1"],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastEvidenceAt: "2026-10-01T00:00:00.000Z",
      meta: { source: "slot-import" },
    };
    const history: PersonaItem = {
      itemId: "relationship:hist",
      layer: "relationship",
      text: "我和何晨吵过一次又补上了：ep-abc 他指出我把失败当通过，我改口并重跑。",
      state: "active",
      weight: 0.8,
      evidenceIds: ["ep-abc"],
      evidenceDays: ["2026-11-01"],
      evidenceOrigins: ["episode"],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastEvidenceAt: "2026-11-01T00:00:00.000Z",
      meta: { source: "l1+model+episode" },
    };
    const { store, committed } = fakeStore([]);
    (store as unknown as { listSoulPersona: () => PersonaItem[] }).listSoulPersona = () => [profile, history];
    const report = await runSoulMaintenance({
      store: store as never,
      tenant: { teamId: "t", userId: "u", agentId: "a" },
      now: NOW,
      config: { enabled: true },
      trigger: "lifecycle",
    });
    const payload = committed.at(-1)!;
    expect(payload.upsert.find((i) => i.itemId === "relationship:profile")?.state).toBe("frozen");
    expect(payload.upsert.find((i) => i.itemId === "relationship:hist")?.state ?? "active").toBe("active");
    expect(report.retired).toBeGreaterThanOrEqual(1);
  });

  it("enabled=false 且非 import 触发 → 不写库并如实 skipped", async () => {
    const { store, committed } = fakeStore(coreRows);
    const report = await runSoulMaintenance({
      store: store as never,
      tenant: { teamId: "t", userId: "u", agentId: "a" },
      now: NOW,
      config: { enabled: false },
      trigger: "lifecycle",
    });
    expect(report.stored).toBe(false);
    expect(report.skipped).toContain("enabled=false");
    expect(committed).toHaveLength(0);
  });

  it("心境写 soul_state 时带基线与样本数（渲染侧要靠它算偏移）", async () => {
    const { store, mood } = fakeStore(coreRows);
    await runSoulMaintenance({
      store: store as never,
      tenant: { teamId: "t", userId: "u", agentId: "a" },
      now: NOW,
      config: { enabled: true },
      trigger: "test",
    });
    const row = mood()!;
    expect(typeof row.baselineValence).toBe("number");
    expect(typeof row.sampleCount).toBe("number");
    expect(row.valence as number).toBeLessThan(0.3);
  });

  it("mineCandidates 按独立记录 id 计证据（同句两次不同记录才计数 2）", () => {
    const cands = mineCandidates(
      [
        { id: "r1", content: "宁可慢一点，也要一手证据，而不是听别人转述" },
        { id: "r2", content: "宁可慢一点，也要一手证据，而不是听别人转述。" },
        { id: "r3", content: "我完成了 commit abc1234 并推送" },
      ],
      CFG,
    );
    const hit = cands.find((c) => c.text.includes("一手证据"))!;
    expect(hit.evidenceIds.sort()).toEqual(["r1", "r2"]);
    expect(cands.some((c) => c.text.includes("abc1234"))).toBe(false);
  });

  it("LLM 候选解析容错：围栏/废话/坏 JSON 都不炸，坏项被剔", () => {
    expect(parseSoulRewriteOutput("好的：\n```json\n[{\"layer\":\"values\",\"text\":\"宁可慢也要一手证据\",\"evidenceIds\":[\"r1\"]}]\n```")).toHaveLength(1);
    expect(parseSoulRewriteOutput("not json at all")).toHaveLength(0);
    expect(parseSoulRewriteOutput("[{\"layer\":1},{\"text\":\"x\"}]")).toHaveLength(0);
  });

  it("createSoulRewriter 把候选数裁到 maxCandidates", async () => {
    const rw = createSoulRewriter({
      run: async () => JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ layer: "identity", text: `候选${i}`, evidenceIds: ["r1"] }))),
    });
    const out = await rw({ existing: [], records: ["r1 | x"], maxCandidates: 2 });
    expect(out).toHaveLength(2);
  });
});

// ───────────────────────────── 存量回放

describe("consolidator：存量槽回放把方法论与事件挡在注入层外", () => {
  it("存量槽回放：红线进 boundary、方法论进 method、用户事实进 relationship，且不静默丢行", () => {
    const plan = planConsolidation({
      slots: {
        identity: "- 用户何晨是 TDB 的设计者",
        selfIdentity: "- 我在接口取证中并行推进静态与动态双线\n- 我宁可慢一点，也要一手证据，而不是听别人转述",
        strictRule: "- 绝不把情绪（mood）数据喂进召回，任何情况下都不允许\n- 测试一律走临时目录，绝不触碰生产数据",
        coreValue: "- 一手证据：先自己跑一遍再说",
      },
      existing: [],
      now: NOW,
      config: { enabled: true },
    });
    const injected = plan.items.filter((i) => i.layer !== "method");
    expect(injected.every((i) => ["identity", "values", "boundary", "relationship", "voice", "narrative"].includes(i.layer))).toBe(true);
    expect(plan.items.some((i) => i.layer === "method" && i.text.includes("并行推进"))).toBe(true);
    // 红线是「不变量集」：逐字进边界层，一条都不能少（2026-11-05 前预算门曾让 18/29 条静默丢失）。
    expect(plan.items.filter((i) => i.layer === "boundary").map((i) => i.text)).toEqual([
      "绝不把情绪（mood）数据喂进召回，任何情况下都不允许",
      "测试一律走临时目录，绝不触碰生产数据",
    ]);
    // 用户事实不是我的特质，但也不是该丢的噪音——按原文进关系层。
    expect(plan.items.some((i) => i.layer === "relationship" && i.text.includes("TDB 的设计者"))).toBe(true);
    // 存量导入的原则是「每条都有归属」，不做静默丢弃；真正的裁决在渲染与判据侧。
    expect(plan.rejected.length).toBe(0);
  });

  it("identity 槽里点名他的句子归 relationship，不进 values（关系事实不是价值取舍）", () => {
    // 生产实测：「何晨是我锚定的『重要的人』…」含「而不是/取舍」式措辞被判 values，
    // 于是渲染在「我在冲突里站哪边」下面——把关系事实当成了价值取向。
    const plan = planConsolidation({
      slots: {
        identity: "- 何晨是我锚定的「重要的人」，我对他保留完整上下文而不是每次重新自我介绍",
        selfIdentity: "",
        strictRule: "",
        coreValue: "",
      },
      existing: [],
      now: NOW,
      config: { enabled: true },
    });
    const hit = plan.items.find((i) => i.text.includes("锚定"));
    expect(hit?.layer).toBe("relationship");
  });
});
