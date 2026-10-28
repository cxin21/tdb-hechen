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
