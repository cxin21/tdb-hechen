/**
 * V6-批次二：attribute-badges 纯函数单测（阈值边界/宁缺毋滥/首要锚选取/注入预览同构）。
 * RED 先行：deriveAttributeBadges / pickPrimeAnchor / anchorInjectPreview 均为本批新增。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAttributeBadges, pickPrimeAnchor, anchorInjectPreview, weightLabel,
} from '../web/src/pages/ChatMemoryPage/utils/attribute-badges';
import type { ChatMemoryLayerItem } from '../web/src/lib/api/chat-memory';

const item = (o: Partial<ChatMemoryLayerItem> & { metadata?: Record<string, unknown> }): ChatMemoryLayerItem =>
  ({ id: 'm1', title: 't', body: 'b', ...o } as ChatMemoryLayerItem);

describe('deriveAttributeBadges（阈值与内核 formatMemoryLine 一致）', () => {
  it('全字段缺省 → 空数组（宁缺毋滥守卫）', () => {
    expect(deriveAttributeBadges(item({}))).toEqual([]);
  });
  it('recall_count 2 → 无验证徽章；3 → 验证×3', () => {
    expect(deriveAttributeBadges(item({ metadata: { recall_count: 2 } })).some(b => b.key === 'verify')).toBe(false);
    const out = deriveAttributeBadges(item({ metadata: { recall_count: 3 } }));
    const v = out.find(b => b.key === 'verify');
    expect(v).toBeDefined();
    expect(v!.values).toEqual({ n: 3 });
  });
  it('identityRefs 空数组 → 无；非空 → 核心事实', () => {
    expect(deriveAttributeBadges(item({ metadata: { identityRefs: [] } })).some(b => b.key === 'core')).toBe(false);
    expect(deriveAttributeBadges(item({ metadata: { identityRefs: ['我要求结论必须建立在代码事实上'] } })).some(b => b.key === 'core')).toBe(true);
  });
  it('arousal 0.69 → 无；0.7 → 强烈（阈值含等号）', () => {
    expect(deriveAttributeBadges(item({ arousal: 0.69 })).some(b => b.key === 'strong')).toBe(false);
    expect(deriveAttributeBadges(item({ arousal: 0.7 })).some(b => b.key === 'strong')).toBe(true);
  });
  it('evolution 存在 → 已演化；valid_start → 自 date 起（日期精度）', () => {
    expect(deriveAttributeBadges(item({ metadata: { evolution: { from: ['a', 'b'] } } })).some(b => b.key === 'evo')).toBe(true);
    const s = deriveAttributeBadges(item({ valid_start: '2026-09-16T02:12:36.483Z' })).find(b => b.key === 'since');
    expect(s!.values).toEqual({ date: '2026-09-16' });
  });
  it('五徽章齐全时顺序与内核 soul[] 固定序一致', () => {
    const out = deriveAttributeBadges(item({
      arousal: 0.8, valid_start: '2026-09-15T00:00:00Z',
      metadata: { recall_count: 5, identityRefs: ['a'], evolution: {} },
    }));
    expect(out.map(b => b.key)).toEqual(['core', 'verify', 'strong', 'evo', 'since']);
  });
});

describe('pickPrimeAnchor（感受段方案B：weight 选取与渲染序解耦）', () => {
  it('weight 最高者入选；无描述 → null（不回退次锚）', () => {
    expect(pickPrimeAnchor([
      { label: '甲', weight: 0.9, attrs_json: '{"description":"首要描述"}' },
      { label: '乙', weight: 0.3, attrs_json: '{"description":"次锚描述"}' },
    ], 1)).toEqual({ label: '甲', desc: '首要描述' });
    expect(pickPrimeAnchor([{ label: '甲', weight: 0.9 }, { label: '乙', weight: 0.3 }])).toBeNull();
  });
  it('描述 >30 字截断；weight≤0 视为未测量不入选', () => {
    const d40 = '一二三四五六七八九十'.repeat(4);
    expect(pickPrimeAnchor([{ label: '甲', weight: 0.9, attrs_json: `{"description":"${d40}"}` }])!.desc)
      .toBe('一二三四五六七八九十'.repeat(3));
    expect(pickPrimeAnchor([{ label: '甲', weight: 0, attrs_json: '{"description":"x"}' }])).toBeNull();
  });
});

describe('anchorInjectPreview（与 soul-assembler 锚行逐字同构）', () => {
  it('全形态 label(趋近·w0.8)：描述；无尾零', () => {
    expect(anchorInjectPreview({ label: '文档', weight: 0.8, valence: 1, attrs_json: '{"description":"d"}' }))
      .toBe('文档(趋近·w0.8)：d');
    expect(anchorInjectPreview({ label: 'A', weight: 0.33, valence: 1 })).toBe('A(趋近·w0.33)');
  });
  it('weight≤0 → 无 w 段；valence null → label(w)；损坏 attrs_json → 宁缺毋滥', () => {
    expect(anchorInjectPreview({ label: '根因', weight: 0, valence: 1 })).toBe('根因(趋近)');
    expect(anchorInjectPreview({ label: 'A', weight: 0.8, valence: null })).toBe('A(w0.8)');
    expect(anchorInjectPreview({ label: 'A', weight: 0.8, valence: 1, attrs_json: 'not-json' })).toBe('A(趋近·w0.8)');
  });
  it('weightLabel 去尾零', () => {
    expect(weightLabel(0.8)).toBe('0.8');
    expect(weightLabel(1)).toBe('1');
  });
});
