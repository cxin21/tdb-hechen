/**
 * #69（R3 配套，Panel 身份区「叙事预览」）：叙事状态判定纯函数测试。
 *
 * seam：identity-utils 的 narrativePreviewOf——组件渲染逻辑的判定核心，DOM 无关。
 * kernel 语义参照（MemoryCore/src/gateway/v2-router.ts:2458-2484，只读参照禁改）：
 *   - format=narrative 且门开且组装成功 → 身份两行全量替换为 identity_narrative 合成槽；
 *   - 门关 / 生成闸违例 / 无身份内容 → 原条目形态（单次响应无法区分门关与降级）。
 */
import { describe, it, expect } from 'vitest';
import { narrativePreviewOf, rawIdentityRowsOf } from '../web/src/pages/ChatMemoryPage/components/identity-utils';

describe('narrativePreviewOf 状态判定', () => {
  it('叙事槽在 → active：narrative 返回合成槽行；身份条目为空（kernel 全量替换语义）', () => {
    const narr = {
      slot: 'identity_narrative',
      content: '以下事实由你和团队共同写就：- 我是谁：技术评审担当；- 我心中的他：家里的首席厨师。',
      source: 'narrative',
      version: 5,
      updated_at: '2026-10-19T08:00:00.000Z',
    };
    const r = narrativePreviewOf([narr, { slot: 'strict_rule', content: '其他槽不进预览' }]);
    expect(r.state).toBe('active');
    expect(r.narrative).toEqual(narr);
    expect(r.entries).toEqual({ self: [], user: [] });
  });

  it('无叙事槽但有条目 → fallback（门关/降级合一灰态），条目分组正确', () => {
    const r = narrativePreviewOf([
      { slot: 'self_identity', content: '- 我负责技术评审' },
      { slot: 'identity', content: '用户是家里的首席厨师' },
    ]);
    expect(r.state).toBe('fallback');
    expect(r.narrative).toBeNull();
    expect(r.entries).toEqual({ self: ['- 我负责技术评审'], user: ['用户是家里的首席厨师'] });
  });

  it('身份内容全空（其他槽在）→ empty（预览整段不渲染）', () => {
    expect(narrativePreviewOf([{ slot: 'strict_rule', content: 'r1' }]).state).toBe('empty');
    expect(narrativePreviewOf([]).state).toBe('empty');
    expect(narrativePreviewOf(null as unknown as never[]).state).toBe('empty');
  });

  it('叙事槽内容为空白 → 视为缺失（宁缺毋滥，防御 kernel 不发空叙事）', () => {
    const r = narrativePreviewOf([
      { slot: 'identity_narrative', content: '   ' },
      { slot: 'identity', content: '用户是家里的首席厨师' },
    ]);
    expect(r.state).toBe('fallback');
    expect(r.narrative).toBeNull();
  });

  it('叙事槽与条目并存（防御：kernel 不该出现）→ 叙事优先 active', () => {
    const r = narrativePreviewOf([
      { slot: 'identity_narrative', content: '叙事文本', source: 'narrative' },
      { slot: 'self_identity', content: '- 我负责技术评审' },
    ]);
    expect(r.state).toBe('active');
    expect(r.narrative?.content).toBe('叙事文本');
  });
});

describe('rawIdentityRowsOf 存储原文口径', () => {
  it('只留身份两槽的字符串行（strict_rule/core_value/叙事槽/非字符串内容不混入身份区）', () => {
    const rows = rawIdentityRowsOf([
      { slot: 'identity_narrative', content: '叙事' },
      { slot: 'self_identity', content: '- 我负责技术评审', version: 3 },
      { slot: 'identity', content: '- 用户是产品经理' },
      { slot: 'strict_rule', content: '- 不该出现在身份区' },
      { slot: 'core_value', content: 42 },
      { slot: 'self_identity', content: null },
    ]);
    expect(rows.map((r) => r.slot)).toEqual(['self_identity', 'identity']);
    expect(rows[0]?.version).toBe(3);
    expect(rows[0]?.content).toBe('- 我负责技术评审');
  });
  it('非数组入参 → 空数组（防御）', () => {
    expect(rawIdentityRowsOf(null)).toEqual([]);
    expect(rawIdentityRowsOf(undefined)).toEqual([]);
    expect(rawIdentityRowsOf('nope')).toEqual([]);
  });
});
