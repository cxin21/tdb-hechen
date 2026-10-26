/**
 * #104 slot 标签映射公共模块测试。
 *
 * 抽取自 PendingSection.tsx / SoulPendingRail.tsx 逐位重复的 SLOT_LABEL
 * （#101 抽取审计三件套时的残留重复，票 #104 收口）。语义锁定：
 *   - 四键四文案逐位不动（CONTEXT.md「Panel UI 小白优先」2026-10-19 拍板的白话标签）；
 *   - 未知名白话兜底「未知提案」（#105 拍板的可见变更，内部键名禁直达 UI；原始键名走两页 chip/group-title 的 title 悬停提示）；
 *   - 占位统一 '-'（#104 拍板）：审计快照缺值字段显示「-」，
 *     Soul 页原 '?' / 整行省略的可见变更在票内注明。
 */
import { describe, it, expect } from 'vitest';
import { SLOT_LABEL, SLOT_TITLE, slotLabelOf, slotTitleOf, slotVersionText } from '../web/src/lib/chatMemorySlotLabel';

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

  it('未知名 → 白话兜底「未知提案」（#105 拍板：内部键名禁直达 UI）', () => {
    expect(slotLabelOf('other')).toBe('未知提案');
    expect(slotLabelOf('brand_new_slot')).toBe('未知提案');
  });

  it('slotTitleOf：已知键显原始键名，任意未知名显原文（title 悬停诊断）', () => {
    expect(slotTitleOf('core_value')).toBe('core_value');
    expect(slotTitleOf('strict_rule')).toBe('strict_rule');
    expect(slotTitleOf('promise_transition')).toBe('promise_transition');
    expect(slotTitleOf('self_identity')).toBe('self_identity');
    expect(slotTitleOf('brand_new_slot')).toBe('brand_new_slot');
    expect(SLOT_TITLE.other).toBe('未知提案'); // 缺槽哨兵无原始键名
  });
});

describe('slotVersionText（#105：审计行 v{N} 记法人话化）', () => {
  it('有版本号 → 「版本 N」', () => {
    expect(slotVersionText(3)).toBe('版本 3');
    expect(slotVersionText(0)).toBe('版本 0'); // 0 是合法版本号，不能当缺值
  });
  it('缺值（undefined/null）→ 占位符 -，禁出「v-」残缺记法', () => {
    expect(slotVersionText(undefined)).toBe('-');
    expect(slotVersionText(null)).toBe('-');
  });
  it('运行时守卫放宽（后端坏 JSON 值也归占位符）', () => {
    expect(slotVersionText('' as unknown as number)).toBe('-');
  });
});
