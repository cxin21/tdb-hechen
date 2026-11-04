/**
 * P2（2026-11-04）：邻接属性摘要 + L1 搜索类型过滤的锁。
 *
 * 背景：内核 /v3/atomic/neighbors 一直在返回 occurred_at、valid_start/end、certainty、
 * significance（v2-router.ts handleAtomicNeighbors），但面板 RelatedSection 只声明
 * 4 个字段、只画 type/content/strength ⇒ 邻接属性被静默丢弃；同时 BFF 早已接收
 * search 的 type 参数，UI 却从不传。两处都属于「后端能用、前端不用」，靠源码级
 * 锁防止再退回：本测试同时钉行为（chips 生成规则）与接线（源码里确实传了 type）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  neighborAttrChips,
  type Neighbor,
} from '@/pages/ChatMemoryPage/components/block-detail/neighbor-attrs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('邻居属性摘要（RelatedSection）', () => {
  it('只有显著性时不编造其它属性', () => {
    const n: Neighbor = { id: 'x', type: 'similar', significance: 0.723 };
    expect(neighborAttrChips(n)).toEqual(['显著性(0-1) 0.72']);
  });

  it('确定性两值分别译成实见/推断（不原样吐英文枚举）', () => {
    expect(neighborAttrChips({ id: 'a', type: 'similar', certainty: 'observed' })).toEqual([
      '确定性 实见',
    ]);
    expect(neighborAttrChips({ id: 'a', type: 'similar', certainty: 'inferred' })).toEqual([
      '确定性 推断',
    ]);
  });

  it('已过期的 valid_end 标「已过期」（soft 语义：过期不等于被排除）', () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    expect(neighborAttrChips({ id: 'a', type: 'similar', valid_end: past })).toEqual([
      '生效止 已过期',
    ]);
    const future = new Date(Date.now() + 30 * 86400_000).toISOString();
    expect(neighborAttrChips({ id: 'a', type: 'similar', valid_end: future })[0]).toBe(
      '生效止 ' + future.slice(0, 10),
    );
  });

  it('occurred_at 只取日期段（时间线精度交给日期分组）', () => {
    expect(
      neighborAttrChips({ id: 'a', type: 'similar', occurred_at: '2026-10-31T08:12:33.000Z' }),
    ).toEqual(['事件时刻 2026-10-31']);
  });

  it('四项都有时按 显著性→确定性→有效期→事件时刻 排列，且无值不占位', () => {
    expect(
      neighborAttrChips({
        id: 'a',
        type: 'similar',
        significance: 0.5,
        certainty: 'inferred',
        valid_end: '2099-01-01T00:00:00.000Z',
        occurred_at: '2026-11-01T00:00:00.000Z',
      }),
    ).toEqual([
      '显著性(0-1) 0.50',
      '确定性 推断',
      '生效止 2099-01-01',
      '事件时刻 2026-11-01',
    ]);
    expect(neighborAttrChips({ id: 'a', type: 'similar' })).toEqual([]);
  });

  it('接线：邻居行真的渲染 chips（不是只算不用）', () => {
    const src = read(
      '../web/src/pages/ChatMemoryPage/components/block-detail/RelatedSection.tsx',
    );
    expect(src).toContain('const chips = neighborAttrChips(n);');
    expect(src).toContain('className="_nb-attrs"');
  });
});

describe('L1 搜索类型过滤接线', () => {
  it('BlockDetail 把 type 传给 onSearchLayer（L0 不传）', () => {
    const src = read('../web/src/pages/ChatMemoryPage/components/BlockDetail.tsx');
    expect(src).toContain("onSearchLayer(layer as 'L0' | 'L1', q, layer === 'L1' ? searchType || undefined : undefined)");
    expect(src).toContain("onSearchLayer?: (l: 'L0' | 'L1', query: string, type?: string)");
    // 选择器只在 L1 出现，且含全部类型选项 + 空串「全部类型」
    expect(src).toContain("{layer === 'L1' && (");
    expect(src).toContain('_memory-detail-search-type');
    for (const t of ['episodic', 'work_fact', 'instruction', 'persona', 'work_method', 'work_task']) {
      expect(src, `类型选项缺 ${t}`).toContain(`value="${t}"`);
    }
  });

  it('hook 把 type 第五参传给 BFF api（undefined 时不携带）', () => {
    const src = read('../web/src/pages/ChatMemoryPage/hooks/useChatMemory.ts');
    expect(src).toContain('chatMemoryApi.searchLayer(selected.id, targetLayer, query, 30, type)');
  });
});
