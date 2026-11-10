/**
 * 反思回写产物契约（ADR0003 gap G2 · D8 确定性校验层）。
 *
 * 2026-11-07（T1 提案/pending 通道清除）：反思产提案通道已删除， 生产消费点只剩
 * validateConclusionCard（结论卡 ≤300 码点拒收，lifecycle/reflection.ts 无条件调用）。
 * 身份叙事契约（第一人称/禁伪造当下体验/价值锚引用）与卡片契约（cardContract）曾服务于
 * 「LLM 提议 → 人工采纳」，随通道整组删除；如需恢复，请连同约束来源一起重建而非局部复原。
 */

export type NarrativeValidation = { ok: true } | { ok: false; reason: string };

/** #77 Batch D（survey F1）：结论卡原子性上限（码点；与 l1-extraction.ts:38 抽取链原子性规则同刻度）。 */
export const REFLECTION_CONCLUSION_MAX_CHARS = 300;

/** 产物契约提示（保留为结论卡注意力文本源；当前 prompt 组装已不含该段）。 */
export const REFLECTION_CONCLUSION_CONTRACT_PROMPT = [
  "【结论卡产物契约】",
  "- 一句话一件事：每条 conclusion 只记一个稳定事实或结论，≤300 字。",
  "- 多事拆条：多个互不依赖的事拆成多条卡，各自独立成立。",
  "- 宁缺毋滥：证据不足以支撑时，宁可不产出该条结论。",
].join("\n");

/**
 * #77 Batch D：结论卡原子性机械门（D8：门只裁决不创作；语义拆分属 LLM few-shot 职责）。
 * 非串/空 → empty-content；码点 > REFLECTION_CONCLUSION_MAX_CHARS → content-too-long。
 * 互不依赖事件数不做确定性判定（语义判定非机械门能力，交 few-shot 引导）。
 */
export function validateConclusionCard(content: unknown): NarrativeValidation {
  if (typeof content !== "string") return { ok: false, reason: "empty-content" };
  const text = content.trim();
  if (text.length === 0) return { ok: false, reason: "empty-content" };
  if ([...text].length > REFLECTION_CONCLUSION_MAX_CHARS) return { ok: false, reason: "content-too-long" };
  return { ok: true };
}
