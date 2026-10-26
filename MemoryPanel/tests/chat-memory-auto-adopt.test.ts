/**
 * #101 auto_adopt 审计三件套公共模块测试。
 *
 * 抽取自 PendingSection.tsx / SoulPendingRail.tsx 逐位重复的实现（#100 审计视图，
 * 引入于 4ae1b79）：AutoAdoptAudit 形状 + autoAdoptOf() 宽松解析 + 终局行过滤谓词。
 * 语义锁定（与抽取前逐位一致，防两页漂移——#100 即双份代码改一漏一实证）：
 *   - autoAdoptOf：state 非 auto_adopted → null 不显示徽标；
 *     state=auto_adopted 时永远非 null——auto_adopt 为对象 → 返回快照；
 *     无字段/坏 JSON/数组/标量 → {} 仍显示徽标与回滚，快照字段走缺省占位
 *     （原两份拷贝的注释误写「无字段 → null」，以实现为准，#101 测试锁定）
 *   - isActionablePendingRow：state 缺省 / pending / auto_adopted 三类可操作行，
 *     rejected/adopted/expired 终局行排除
 */
import { describe, it, expect } from 'vitest';
import {
  autoAdoptOf,
  isActionablePendingRow,
  type AutoAdoptAudit,
} from '../web/src/lib/chatMemoryAutoAdopt';

describe('autoAdoptOf', () => {
  it('state 非 auto_adopted → null（不显示徽标）', () => {
    expect(autoAdoptOf({ pending_id: 'p1', slot: 'self_identity', content: 'x', state: 'pending' })).toBeNull();
    expect(autoAdoptOf({ pending_id: 'p2', slot: 'core_value', content: 'x', state: 'adopted' })).toBeNull();
    expect(autoAdoptOf({ pending_id: 'p3', slot: 'strict_rule', content: 'x', state: 'rejected' })).toBeNull();
    expect(autoAdoptOf({ pending_id: 'p4', slot: 'self_identity', content: 'x' })).toBeNull();
  });

  it('auto_adopted 且 audit 形状完好 → 原样返回快照', () => {
    const audit: AutoAdoptAudit = {
      adopted_at: '2026-10-26 11:00:00',
      prev_slot_content: '旧内容',
      prev_slot_version: 3,
      prev_slot_existed: true,
      post_slot_version: 4,
      gate: { votes: 3, spanHours: 24, contradictionThreshold: 0.35, dupThreshold: 0.6 },
    };
    const p = { pending_id: 'p5', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: JSON.stringify({ auto_adopt: audit }) };
    expect(autoAdoptOf(p)).toEqual(audit);
  });

  it('无 attrs_json / 无 auto_adopt 字段 → {}（仍显示徽标与回滚，快照字段走缺省占位）', () => {
    expect(autoAdoptOf({ pending_id: 'p6', slot: 'self_identity', content: 'x', state: 'auto_adopted' })).toEqual({});
    expect(autoAdoptOf({ pending_id: 'p7', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: null })).toEqual({});
    expect(
      autoAdoptOf({ pending_id: 'p8', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: JSON.stringify({}) }),
    ).toEqual({});
  });

  it('坏 JSON → {}（仍显示徽标与回滚，快照字段走缺省占位）', () => {
    expect(autoAdoptOf({ pending_id: 'p9', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: '{oops' })).toEqual({});
  });

  it('auto_adopt 为数组或标量 → 视为无快照体 {}（typeof+Array.isArray 双关）', () => {
    expect(
      autoAdoptOf({ pending_id: 'p10', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: JSON.stringify({ auto_adopt: [1, 2] }) }),
    ).toEqual({});
    expect(
      autoAdoptOf({ pending_id: 'p11', slot: 'self_identity', content: 'x', state: 'auto_adopted', attrs_json: JSON.stringify({ auto_adopt: 'x' }) }),
    ).toEqual({});
  });
});

describe('isActionablePendingRow', () => {
  it('state 缺省 / pending / auto_adopted → true（待决 + 自动采纳两类可操作行）', () => {
    expect(isActionablePendingRow({ pending_id: 'a', slot: 'self_identity', content: 'x' })).toBe(true);
    expect(isActionablePendingRow({ pending_id: 'b', slot: 'core_value', content: 'x', state: 'pending' })).toBe(true);
    expect(isActionablePendingRow({ pending_id: 'c', slot: 'strict_rule', content: 'x', state: 'auto_adopted' })).toBe(true);
  });

  it('rejected / adopted / expired 终局行 → false（审计语义已闭合，不打扰裁决队列）', () => {
    expect(isActionablePendingRow({ pending_id: 'd', slot: 'self_identity', content: 'x', state: 'rejected' })).toBe(false);
    expect(isActionablePendingRow({ pending_id: 'e', slot: 'core_value', content: 'x', state: 'adopted' })).toBe(false);
    expect(isActionablePendingRow({ pending_id: 'f', slot: 'strict_rule', content: 'x', state: 'expired' })).toBe(false);
  });
});
