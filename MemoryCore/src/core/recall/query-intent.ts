/**
 * #138（2026-10-28）：召回查询意图——「问 assistant 自己说过什么」的识别（纯确定性，无时钟/无外呼）。
 *
 * 背景（bench LME90 逐桶证据）：single-session-assistant 桶的 gold 答案落在 assistant 轮，
 * 而 L2 结论卡只蒸馏 user 侧事实（生产 consolidation 同型）。结论层对这类问题是**系统性不相关**：
 * 卡与查询词面高度重合（同一话题）却不含答案，注入后挤掉承载答案的 assistant 轮
 * （W3×4/add×4 下该桶 cov 66.7~73.3% vs 基线 80%，判对 80% vs 93.3%）。
 *
 * 判定规则（宁缺毋滥：只在「明确回忆 assistant 先前输出」时命中）：
 *   ① 第二人称指代（you / your / 你）——
 *   ② 且带「回忆 assistant 输出」的线索：remind/recall + 你说过/写过/推荐过/给过 等过去时表述；
 *   ③ 排除「请求新建议」（Can you recommend/suggest …、Any tips …）——那类问题的答案在偏好/经验行，
 *      不在「assistant 历史输出」里，跳过结论层反而会掉分。
 *
 * 只用规则，不上模型：误判的代价是「该桶少注入结论卡」（回到基线形态），不会污染其他桶语义。
 */

/** 第二人称指代（EN/ZH）。 */
const SECOND_PERSON = /\b(?:you|your|you'd|you've|youre|you're)\b|你/u;

/** 回忆 assistant 先前输出的线索（过去时 / 明确指向上一次对话）。 */
const RECALL_CUES: readonly RegExp[] = [
  /\bremind me\b/i,
  /\bdid you\s+(?:say|tell|mention|recommend|suggest|write|mean)\b/i,
  /\b(?:say|said|told|wrote|recommended|suggested|gave)\b[^?]{0,30}\byou\b/i,
  /\b(?:what|which|how)\b[^?]{0,40}\byou\s+(?:said|told|wrote|recommended|suggested|gave|mentioned|shared|came up with)\b/i,
  /\byou\s+(?:said|told|wrote|recommended|suggested|gave|mentioned|shared|came up with)\b/i,
  /\b(?:previous|last|earlier)\s+(?:chat|conversation|time|message)\b[^?]{0,60}\byou\b/i,
  /\bthe\s+\w+(?:\s+\w+){0,3}\s+you\s+(?:recommended|suggested|wrote|shared|gave)\b/i,
  /你(?:上次|之前|前面|刚才)?(?:说|讲|写|推荐|建议|给|提)过?/u,
  /你(?:还)?记得/u,
];

/** 请求新建议的形态（present imperative）——与「回忆 assistant 输出」互斥。 */
const ADVICE_REQUEST: readonly RegExp[] = [
  /^\s*(?:can|could|would|will)\s+you\s+(?:recommend|suggest|give|help|provide|list|show me some)\b/i,
  /^\s*(?:any|some)\s+(?:tips|ideas|suggestions|recommendations)\b/i,
  /^\s*do\s+you\s+(?:have|know)\s+(?:any|some)\b/i,
  /^\s*(?:帮我|请|能否|可以)(?:推荐|建议|找|列)/u,
];

/** 去掉「请求建议」前缀后再判，避免 "Can you help me remember what you said" 被误杀。 */
function stripAdvicePrefix(text: string): string {
  let out = text;
  for (const re of ADVICE_REQUEST) {
    const m = re.exec(out);
    if (m) {
      out = out.slice(m[0].length);
      break;
    }
  }
  return out;
}

// ── #141（2026-10-28）：结论层分阶段路由——查询要「哪种表示」────────────────────
/**
 * 结论卡与 turn 行是同一知识的两种表示（票面第一性原理②）：谁先进预算，谁就挤掉另一方。
 * 分阶段的前提是「先判断这道题要什么表示」，再按题型分配表示预算（票面 W3 目标）：
 *
 *   - assistant-recall → 结论层整层跳过（#138 已落地并验证：84.4% vs 77.8%）；
 *   - temporal        → turn 优先：答案（时间跨度/先后）与时间戳都在原文行上；
 *   - exact-fact      → turn 优先：单一实体的单一属性，摘要只会丢细节；
 *   - update          → 结论优先：结论卡本身就是「最新值」，但必须带源证据；
 *   - aggregate       → 结论优先：跨轮聚合正是结论卡的强项；
 *   - preference      → 结论优先、上限 1：偏好是稳定态，1 条足够，别挤掉原文；
 *   - default         → 不路由（沿用现状上限与结论前置），保持逐位退化的安全默认。
 *
 * 规则宁缺毋滥：只有明确线索才命中；误判的代价被策略表限制在「结论上限 1~2 条」，
 * 不会出现「该注入却零注入」的硬失败。
 */
export type RecallIntent =
  | "assistant-recall"
  | "exact-fact"
  | "temporal"
  | "update"
  | "aggregate"
  | "preference"
  | "default";

export interface RecallIntentPolicy {
  /** 结论行条数上限；undefined = 沿用 conclusionLayer.maxConclusions / floor(maxResults/2)。 */
  conclusionBudget?: number;
  /** 入选结论必须带 ≥1 条源证据（smallToBig part_of 回捞）；无证据的结论让位给原文行。 */
  pairing: boolean;
  /** 注入顺序：结论前置（缺省现状）或 turn 前置。 */
  order: "conclusion-first" | "turn-first";
  /** 结论行与已选 turn 行语义重复时让位（表示仲裁）。 */
  arbitrate: boolean;
}

const INTENT_POLICY: Readonly<Record<RecallIntent, RecallIntentPolicy>> = Object.freeze({
  "assistant-recall": Object.freeze({ conclusionBudget: 0, pairing: false, order: "turn-first", arbitrate: false }),
  temporal: Object.freeze({ conclusionBudget: 1, pairing: true, order: "turn-first", arbitrate: true }),
  // 票面 W3：exact-fact 结论预算 = 0（答案在原文，摘要只会丢细节）。
  "exact-fact": Object.freeze({ conclusionBudget: 0, pairing: false, order: "turn-first", arbitrate: false }),
  update: Object.freeze({ conclusionBudget: 2, pairing: true, order: "conclusion-first", arbitrate: true }),
  aggregate: Object.freeze({ conclusionBudget: 2, pairing: true, order: "conclusion-first", arbitrate: true }),
  preference: Object.freeze({ conclusionBudget: 1, pairing: true, order: "conclusion-first", arbitrate: true }),
  // default 必须保持「旧行为」：不限制、不成对、不仲裁（intent 模式下它吃掉所有没命中线索的问题，
  // 若在这里默认开成对/仲裁，等于给多数题偷偷换了语义，与「逐位退化」的安全默认相悖）。
  default: Object.freeze({ pairing: false, order: "conclusion-first", arbitrate: false }),
});

/** 策略表（返回值冻结语义：调用方只读，不缓存也不得改动）。 */
export function recallIntentPolicy(intent: RecallIntent): RecallIntentPolicy {
  return INTENT_POLICY[intent] ?? INTENT_POLICY.default;
}

/** 时间推理线索：问时长/时刻/先后（注意不含 how many <名词>，那是聚合）。 */
const TEMPORAL_CUES: readonly RegExp[] = [
  /\bwhen\s+(?:did|do|does|was|were|is|are|had|have)\b/i,
  /\bwhat\s+(?:day|date|time)\b/i,
  /\bhow\s+(?:long|soon|recently|early|late)\b/i,
  /\bhow\s+many\s+(?:days|weeks|months|years|hours|minutes|seconds)\b/i,
  /\b(?:days?|weeks?|months?|years?|hours?)\s+(?:ago|before|after|since|earlier|later)\b/i,
  /\bwhat\s+(?:came|happened)\s+first\b/i,
  /什么时候|多久|多少天|多少年|几天|几周|几个月|哪一天|几号|之前|之后|先后|最早|最晚|时间点/u,
];

/** 知识更新线索：问「现在/最新」的状态。 */
const UPDATE_CUES: readonly RegExp[] = [
  /\b(?:currently|current|now|nowadays|these days|latest|still|no longer|anymore)\b/i,
  /\bwhat(?:'s| is)\s+my\s+\w+\s+now\b/i,
  /现在|目前|当前|如今|最新|还在|不再|改成|换了|现在的/u,
];

/** 聚合线索：跨多轮的计数/枚举/汇总。 */
const AGGREGATE_CUES: readonly RegExp[] = [
  /\bhow\s+many\b/i,
  /\bhow\s+much\b/i,
  /\bhow\s+often\b/i,
  /\btotal\b/i,
  /\blist\s+(?:all|the|every)\b/i,
  /\b(?:all|every)\s+(?:of\s+)?the\s+\w+/i,
  /\bsummar/i,
  /\bwhich\s+(?:ones|of\s+(?:these|them))\b/i,
  /一共|总共|总共有|多少|几[个次条种位]|哪些|都有|列一下|列出来|总结|汇总/u,
];

/** 偏好线索：问喜好/推荐/适用（答案常在结论卡与偏好行，turn 未必有）。 */
const PREFERENCE_CUES: readonly RegExp[] = [
  /\b(?:recommend|recommended|recommendation|suggest|suggestion|advice|advise)\b/i,
  /\b(?:favorite|favourite|prefer|preferred|preference)\b/i,
  /\b(?:best|good|great)\s+\w+\s+for\s+me\b/i,
  /\bshould\s+i\b/i,
  /推荐|建议|喜欢|偏好|最适合|适合我|值得/u,
];

/** 精确事实线索：单一实体单属性问句（答案就在某一轮原文里）。 */
const EXACT_FACT_CUES: readonly RegExp[] = [
  /\bwhat\s+(?:\w+\s+)?(?:is|was|are|were)\b/i,
  /\bwho\s+(?:is|was|are|were)\b/i,
  /\bwhere\s+(?:is|was|did|do|are|were)\b/i,
  /\bwhich\s+\w+\s+(?:is|was)\b/i,
  /是什么|是谁|什么颜色|什么型号|哪个牌子|叫什么|有几个/u,
];

/**
 * 查询意图分类（纯规则、零外呼、确定性）。
 * 优先级：assistant-recall > temporal > update > aggregate > preference > exact-fact > default。
 * 高优先级放在前面是因为「问时长」常同时带聚合/更新词（how long have I been using X now），
 * 而助理回忆是最强的整层跳过信号（误判代价最大，故最先判）。
 */
export function classifyRecallIntent(text: string): RecallIntent {
  if (typeof text !== "string") return "default";
  const raw = text.trim();
  if (raw.length === 0) return "default";
  if (isAssistantRecallQuery(raw)) return "assistant-recall";
  const any = (cues: readonly RegExp[]) => cues.some((re) => re.test(raw));
  if (any(TEMPORAL_CUES)) return "temporal";
  if (any(UPDATE_CUES)) return "update";
  if (any(AGGREGATE_CUES)) return "aggregate";
  if (any(PREFERENCE_CUES)) return "preference";
  if (any(EXACT_FACT_CUES)) return "exact-fact";
  return "default";
}

/**
 * 查询是否在「回忆 assistant 自己先前的输出」。
 * true → 结论层（user 侧事实卡）对本题系统性不相关，调用方可整层跳过、把预算还给原文行。
 */
export function isAssistantRecallQuery(text: string): boolean {
  if (typeof text !== "string") return false;
  const raw = text.trim();
  if (raw.length === 0) return false;
  // 先看原文是否已是纯建议请求（整句就是 "Any tips for …"），是则直接判非
  const stripped = stripAdvicePrefix(raw);
  if (stripped.length === 0) return false;
  if (!SECOND_PERSON.test(stripped)) return false;
  return RECALL_CUES.some((re) => re.test(stripped));
}
