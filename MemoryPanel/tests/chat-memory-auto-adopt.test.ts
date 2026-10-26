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
  isBatchSelectablePendingRow,
  batchSelectablePendingRows,
  pruneSelectionToSelectable,
  type AutoAdoptAudit,
} from '../web/src/lib/chatMemoryAutoAdopt';
import type { PendingItem } from '../web/src/lib/api/chat-memory';

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

describe('isBatchSelectablePendingRow（#103 批量操作排除终局行）', () => {
  it('待决行（state 缺省/pending）→ true（唯一可批量勾选的行）', () => {
    expect(isBatchSelectablePendingRow({ pending_id: 'a', slot: 'self_identity', content: 'x' })).toBe(true);
    expect(isBatchSelectablePendingRow({ pending_id: 'b', slot: 'core_value', content: 'x', state: 'pending' })).toBe(true);
  });

  it('auto_adopted 终局行 → false（#103：可回滚但不可批量勾选，勾选即撞内核 404）', () => {
    expect(isBatchSelectablePendingRow({ pending_id: 'c', slot: 'strict_rule', content: 'x', state: 'auto_adopted' })).toBe(false);
  });

  it('rejected/adopted/expired 终局行 → false（双保险：列表过滤后不会出现，防御 state 演进）', () => {
    expect(isBatchSelectablePendingRow({ pending_id: 'd', slot: 'self_identity', content: 'x', state: 'rejected' })).toBe(false);
    expect(isBatchSelectablePendingRow({ pending_id: 'e', slot: 'core_value', content: 'x', state: 'adopted' })).toBe(false);
    expect(isBatchSelectablePendingRow({ pending_id: 'f', slot: 'strict_rule', content: 'x', state: 'expired' })).toBe(false);
  });
});

describe('batchSelectablePendingRows（#103 全选跳过终局行）', () => {
  const rows: PendingItem[] = [
    { pending_id: 'p1', slot: 'strict_rule', content: 'a', state: 'pending' },
    { pending_id: 'p2', slot: 'core_value', content: 'b', state: 'auto_adopted' },
    { pending_id: 'p3', slot: 'self_identity', content: 'c', state: 'pending' },
  ];

  it('只返回待决行——auto_adopted 不进全选', () => {
    expect(batchSelectablePendingRows(rows).map((r) => r.pending_id)).toEqual(['p1', 'p3']);
  });

  it('全部为终局行时返回空数组（无可选项 → 批量按钮禁用）', () => {
    const finalOnly: PendingItem[] = [
      { pending_id: 'p2', slot: 'core_value', content: 'b', state: 'auto_adopted' },
      { pending_id: 'p9', slot: 'strict_rule', content: 'z', state: 'rejected' },
    ];
    expect(batchSelectablePendingRows(finalOnly)).toEqual([]);
  });

  it('空列表返回空数组', () => {
    expect(batchSelectablePendingRows([])).toEqual([]);
  });
});

describe('pruneSelectionToSelectable（#103 陈旧勾选清理）', () => {
  const rows: PendingItem[] = [
    { pending_id: 'p1', slot: 'strict_rule', content: 'a', state: 'pending' },
    { pending_id: 'p2', slot: 'core_value', content: 'b', state: 'auto_adopted' },
  ];

  it('选中集里已变终局的行被剔除（含并发自动采纳路径），保持原顺序', () => {
    expect(pruneSelectionToSelectable(['p1', 'p2', 'p1'], rows)).toEqual(['p1', 'p1']);
  });

  it('全部终局 → 空数组（批量按钮随之禁用）', () => {
    expect(pruneSelectionToSelectable(['p2'], rows)).toEqual([]);
  });

  it('空选中集 → 空数组', () => {
    expect(pruneSelectionToSelectable([], rows)).toEqual([]);
  });
});
