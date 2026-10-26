/**
 * chatMemorySlotLabel —— slot 标签映射公共模块（#104 抽取）。
 *
 * 抽取自 PendingSection.tsx 与 SoulPendingRail.tsx 的逐位重复 SLOT_LABEL
 * （#101 抽取审计三件套时的残留重复，票 #104 收口）。
 *
 * 文案即 CONTEXT.md「Panel UI 小白优先」（2026-10-19 拍板）的白话标签，
 * 勿改——改即两页可见文案变化。未知名白话兜底「未知提案」、原始键名经
 * SLOT_TITLE 走两页 chip/分组标题的 title 悬停提示（#105 拍板：内部键名禁直达 UI）。
 */
/** slot 英文键名 → 待裁决区白话标签（键名为后端契约，勿改） */
export const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
  promise_transition: '承诺状态迁移提案',
  self_identity: '「我是谁」提案',
};

/** slot 键名 → chip/分组标题 title 悬停提示（已知键显原始键名；'other' 为缺槽哨兵，无原始键名可显，#105）。已知键恒等行仅为枚举完整性，实际由 slotTitleOf 的 ?? slot 回退兜住任意未知名 */
export const SLOT_TITLE: Record<string, string> = {
  core_value: 'core_value',
  strict_rule: 'strict_rule',
  promise_transition: 'promise_transition',
  self_identity: 'self_identity',
  other: '未知提案',
};

/** chip/分组标题的 title 悬停文案：已知键显原始键名，任意未知名显原文（诊断用） */
export function slotTitleOf(slot: string): string {
  return SLOT_TITLE[slot] ?? slot;
}

/** 已知 slot → 白话标签；未知名白话兜底「未知提案」（#105 拍板） */
export function slotLabelOf(slot: string): string {
  return SLOT_LABEL[slot] ?? '未知提案';
}

/** 审计行版本记法 → 人话：有值「版本 N」（0 合法），缺值占位符「-」（#105，禁 v- 残缺记法） */
export function slotVersionText(version: number | null | undefined): string {
  if (typeof version !== 'number' || !Number.isFinite(version)) return '-';
  return `版本 ${version}`;
}
