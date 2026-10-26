/**
 * #104 slot 标签映射公共模块测试。
 *
 * 抽取自 PendingSection.tsx / SoulPendingRail.tsx 逐位重复的 SLOT_LABEL
 * （#101 抽取审计三件套时的残留重复，票 #104 收口）。语义锁定：
 *   - 四键四文案逐位不动（CONTEXT.md「Panel UI 小白优先」2026-10-19 拍板的白话标签）；
 *   - 未知名回退原文（两页原有 ?? slot 行为）；
 *   - 占位统一 '-'（#104 拍板）：审计快照缺值字段显示「-」，
 *     Soul 页原 '?' / 整行省略的可见变更在票内注明。
 */
import { describe, it, expect } from 'vitest';
import { SLOT_LABEL, slotLabelOf } from '../web/src/lib/chatMemorySlotLabel';

describe('SLOT_LABEL', () => {
  it('恰四键，中文文案逐位不动', () => {
    expect(Object.keys(SLOT_LABEL).sort()).toEqual([
      'core_value',
      'promise_transition',
      'self_identity',
      'strict_rule',
    ]);
    expect(SLOT_LABEL.core_value).toBe('价值锚提案');
    expect(SLOT_LABEL.strict_rule).toBe('行为红线提案');
    expect(SLOT_LABEL.promise_transition).toBe('承诺状态迁移提案');
    expect(SLOT_LABEL.self_identity).toBe('「我是谁」提案');
  });
});

describe('slotLabelOf', () => {
  it('已知 slot → 白话标签', () => {
    expect(slotLabelOf('core_value')).toBe('价值锚提案');
    expect(slotLabelOf('strict_rule')).toBe('行为红线提案');
    expect(slotLabelOf('promise_transition')).toBe('承诺状态迁移提案');
    expect(slotLabelOf('self_identity')).toBe('「我是谁」提案');
  });

  it('未知名 → 回退原文（两页原有 ?? slot 行为）', () => {
    expect(slotLabelOf('other')).toBe('other');
    expect(slotLabelOf('')).toBe('');
  });
});
