/**
 * chatMemorySlotLabel —— slot 标签映射公共模块（#104 抽取）。
 *
 * 抽取自 PendingSection.tsx 与 SoulPendingRail.tsx 的逐位重复 SLOT_LABEL
 * （#101 抽取审计三件套时的残留重复，票 #104 收口）。
 *
 * 文案即 CONTEXT.md「Panel UI 小白优先」（2026-10-19 拍板）的白话标签，
 * 勿改——改即两页可见文案变化；未知名回退原文（两页原有 ?? slot 行为）。
 */
/** slot 英文键名 → 待裁决区白话标签（键名为后端契约，勿改） */
export const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
  promise_transition: '承诺状态迁移提案',
  self_identity: '「我是谁」提案',
};

/** 已知 slot → 白话标签；未知名回退原文 */
export function slotLabelOf(slot: string): string {
  return SLOT_LABEL[slot] ?? slot;
}
