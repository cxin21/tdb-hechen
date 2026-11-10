/**
 * V6-批次二：deriveAttributeBadges 纯函数单测（阈值边界/宁缺毋滥）。
 * F1（2026-11-07）：价值锚面板删除后，锚注入预览/首要锚选取/创建人徽标用例随导出一并删除。
 */
import { describe, it, expect } from 'vitest';
import { deriveAttributeBadges } from '../web/src/pages/ChatMemoryPage/utils/attribute-badges';
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
    // P0（task-10）：tooltip 不得再声称「两路召回均排除」——内核 soft 档是降权保留
    // （recall/validity-policy.ts:57 派生三态 off|hard|soft），面板无从得知部署档位。
    expect(b!.tooltip).toContain('soft 模式降权保留');
    expect(b!.tooltip).toContain('硬失效模式才排除');
    expect(b!.tooltip).not.toContain('两路召回均排除');
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
