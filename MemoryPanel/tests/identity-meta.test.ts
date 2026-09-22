import { describe, expect, it } from 'vitest';
import { identityMetaOf, type CoreSlotRow } from '../web/src/pages/ChatMemoryPage/components/identity-utils';

/**
 * U1 徽标数据纯函数（spec §6.5 U1「+version/updated_at/source 徽标」修复轮）：
 * 数据已在 /v3/core-memory/read slots 出参（sqlite.ts readCore SELECT 五列），
 * UI 此前只渲 content 丢三字段——本测试先行（RED）驱动补齐。
 */
describe('identityMetaOf（U1 徽标数据纯函数）', () => {
  it('取同槽首行的 version/source/updated_at', () => {
    const rows: CoreSlotRow[] = [
      {
        slot: 'self_identity',
        content: 'a',
        version: 30,
        source: 'identity-discovery',
        updated_at: '2026-09-22T01:02:03Z',
      },
      { slot: 'self_identity', content: 'b' },
    ];
    expect(identityMetaOf(rows, 'self_identity')).toEqual({
      version: 30,
      source: 'identity-discovery',
      updated_at: '2026-09-22T01:02:03Z',
    });
  });

  it('字段缺失返回空对象而非假值；无列表/无匹配槽返回 null', () => {
    const rows: CoreSlotRow[] = [{ slot: 'identity', content: 'x' }];
    expect(identityMetaOf(rows, 'identity')).toEqual({});
    expect(identityMetaOf([], 'identity')).toBeNull();
    expect(identityMetaOf(undefined as unknown as CoreSlotRow[], 'identity')).toBeNull();
  });

  it('不同槽不串槽', () => {
    const rows: CoreSlotRow[] = [
      { slot: 'identity', content: 'u', version: 27 },
      { slot: 'self_identity', content: 's', version: 30 },
    ];
    expect(identityMetaOf(rows, 'identity')).toEqual({ version: 27 });
    expect(identityMetaOf(rows, 'self_identity')).toEqual({ version: 30 });
  });
});
