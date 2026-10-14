/**
 * V6-批次二：attribute-badges 纯函数单测（阈值边界/宁缺毋滥/首要锚选取/注入预览同构）。
 * RED 先行：deriveAttributeBadges / pickPrimeAnchor / anchorInjectPreview 均为本批新增。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAttributeBadges, pickPrimeAnchor, anchorInjectPreview, weightLabel, createdByBadge,
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

describe('deriveAttributeBadges P1-T8（bi-temporal 补口：已失效徽章）', () => {
  it('valid_end 已过 → 已失效徽章（icon ⛔ / cls invalidated）', () => {
    const b = deriveAttributeBadges(item({ valid_end: '2020-01-01T00:00:00.000Z' })).find(x => x.key === 'invalidated');
    expect(b).toBeDefined();
    expect(b!.cls).toBe('invalidated');
    expect(b!.icon).toBe('⛔');
    expect(b!.labelKey).toBe('memory.badges.invalidated');
  });
  it('valid_end 未来 / 空 / 缺失 / 解析失败 → 无已失效徽章', () => {
    expect(deriveAttributeBadges(item({ valid_end: '2999-01-01T00:00:00.000Z' })).some(x => x.key === 'invalidated')).toBe(false);
    expect(deriveAttributeBadges(item({ valid_end: '' })).some(x => x.key === 'invalidated')).toBe(false);
    expect(deriveAttributeBadges(item({})).some(x => x.key === 'invalidated')).toBe(false);
    expect(deriveAttributeBadges(item({ valid_end: 'not-a-date' })).some(x => x.key === 'invalidated')).toBe(false);
  });
  it('已失效徽章排在 since 之后（追加于固定序尾部）', () => {
    const out = deriveAttributeBadges(item({
      valid_start: '2026-09-15T00:00:00Z',
      valid_end: '2026-09-14T00:00:00Z',
    }));
    expect(out.map(b => b.key)).toEqual(['since', 'invalidated']);
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
  it('V7 方案A：描述无句界且≤80 预算→全量（替换 V6 的 30 字硬截）；weight≤0 视为未测量不入选', () => {
    const d40 = '一二三四五六七八九十'.repeat(4);
    expect(pickPrimeAnchor([{ label: '甲', weight: 0.9, attrs_json: `{"description":"${d40}"}` }])!.desc)
      .toBe(d40);
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

describe('pickPrimeAnchor V7 F-U2（并列 weight 两端序统一）', () => {
  it('并列 weight：value_id 次级键定序，输入 weight-DESC 序不承载语义（RED）', () => {
    const rows = [
      { label: '乙', value_id: 'v-b', weight: 0.8, attrs_json: '{"description":"乙描述"}' },
      { label: '甲', value_id: 'v-a', weight: 0.8, attrs_json: '{"description":"甲描述"}' },
    ];
    expect(pickPrimeAnchor(rows as never)).toEqual({ label: '甲', desc: '甲描述' });
  });
  it('守卫：weight 不同时仍按 weight 最高（回归不变）', () => {
    const rows = [
      { label: '低', value_id: 'v-a', weight: 0.5, attrs_json: '{"description":"低描述"}' },
      { label: '高', value_id: 'v-b', weight: 0.9, attrs_json: '{"description":"高描述"}' },
    ];
    expect(pickPrimeAnchor(rows as never)).toEqual({ label: '高', desc: '高描述' });
  });
});

describe('pickPrimeAnchor V7 方案A（句边界描述）', () => {
  it('首句在预算内：完整首句（非 30 字硬截）', () => {
    const d = '用户长期偏好：文本类成果一律在对话框直接输出可复制全文，不得落成文档文件。后续句。';
    const rows = [{ label: '文档', value_id: 'v-d', weight: 0.8, attrs_json: JSON.stringify({ description: d }) }];
    expect(pickPrimeAnchor(rows as never)).toEqual({ label: '文档', desc: d.split('。')[0] + '。' });
  });
  it('无句边界且超预算：返回 null（宁缺毋滥）', () => {
    const d = '表层现象与真实根因多次背离：' + '长长长长长'.repeat(30);
    const rows = [{ label: '根因', value_id: 'v-r', weight: 0.8, attrs_json: JSON.stringify({ description: d }) }];
    expect(pickPrimeAnchor(rows as never)).toBeNull();
  });
});

describe('createdByBadge（§4.2 core_values.created_by 展示徽标 · 第二令 GAP-1）', () => {
  it('auto-growth / verify 原样返回', () => {
    expect(createdByBadge('auto-growth')).toBe('auto-growth');
    expect(createdByBadge('verify')).toBe('verify');
  });
  it('空串 / 纯空白 / undefined → null（宁缺毋滥）', () => {
    expect(createdByBadge('')).toBeNull();
    expect(createdByBadge('   ')).toBeNull();
    expect(createdByBadge(undefined)).toBeNull();
  });
});
