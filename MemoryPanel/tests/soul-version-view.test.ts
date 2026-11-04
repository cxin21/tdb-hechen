/**
 * task-3（P0-b）：灵魂版本链视图模型纯函数 golden。
 *
 * 覆盖：
 *   - 旧快照（无 version/parentHash/reasonCode）→ 降级徽标，禁编造版本号；
 *   - 未知 trigger 原样保留（'render' 不在受控枚举内，不得翻译成编造的原因）；
 *   - 受控 reasonCode → 中文标签（映射镜像 MemoryCore/src/core/hooks/soul-versioning.ts:13）；
 *   - slotDiff / lineDiff 摘要格式；
 *   - 新→旧倒序、空态、notes 原文透传（snapshot-* 降级提示不吞）。
 */
import { describe, it, expect } from 'vitest';
import {
  SOUL_REASON_LABELS,
  buildSoulVersionView,
  formatSoulVersionTime,
  formatSoulHash,
} from '../web/src/pages/SoulPage/soul-version-view';

describe('task-3: 灵魂版本链视图模型', () => {
  it('旧快照无 version/parentHash/reasonCode → 降级徽标，不编造序号', () => {
    const view = buildSoulVersionView({
      versions: [{ at: '2026-11-01T08:00:00.000Z', hash: 'deadbeefcafe', trigger: 'render' }],
      notes: [],
    });
    expect(view.rows).toHaveLength(1);
    const row = view.rows[0]!;
    expect(row.legacy).toBe(true);
    expect(row.versionText).toBe('');
    expect(row.versionBadge).toBe('旧快照');
    expect(row.hashText).toBe('deadbeef');
    expect(view.legacyOnly).toBe(true);
    expect(view.legacyHint).toContain('版本号');
    expect(view.emptyText).toBeNull();
  });

  it('未知 trigger 原样保留（不翻译、不猜测）', () => {
    const view = buildSoulVersionView({
      versions: [{ at: '2026-11-01T08:00:00.000Z', hash: 'aaaa1111', trigger: 'render' }],
    });
    expect(view.rows[0]!.reasonText).toBe('render');
    expect(view.rows[0]!.reasonIsKnown).toBe(false);

    const noTrigger = buildSoulVersionView({ versions: [{ at: '2026-11-01T08:00:00.000Z', hash: 'aaaa1111' }] });
    expect(noTrigger.rows[0]!.reasonText).toBe('未记录原因');
  });

  it('受控 reasonCode → 中文标签；reasonDetail 原样陪显', () => {
    expect(SOUL_REASON_LABELS['core-values']).toBe('核心价值观变更');
    const view = buildSoulVersionView({
      versions: [
        {
          at: '2026-11-02T08:00:00.000Z',
          hash: 'cafe1234',
          version: 2,
          parentHash: 'deadbeef',
          trigger: 'core-values',
          reasonCode: 'core-values',
          reasonDetail: '采纳 core_value 提案',
        },
      ],
    });
    const row = view.rows[0]!;
    expect(row.legacy).toBe(false);
    expect(row.versionText).toBe('v2');
    expect(row.versionBadge).toBe('');
    expect(row.reasonText).toBe('核心价值观变更');
    expect(row.reasonIsKnown).toBe(true);
    expect(row.reasonDetailText).toBe('采纳 core_value 提案');
    expect(row.parentHashText).toBe('deadbeef');
  });

  it('slotDiff / lineDiff 摘要成可读文案', () => {
    const view = buildSoulVersionView({
      versions: [
        {
          at: '2026-11-02T08:00:00.000Z',
          hash: 'cafe1234',
          version: 2,
          lineDiff: { added: 3, removed: 1 },
          slotDiff: { added: 1, removed: 0, changed: 2, summary: '+1 slot:user / ~2' },
        },
      ],
    });
    const row = view.rows[0]!;
    expect(row.slotDiffText).toBe('+1 / -0 / ~2');
    expect(row.slotSummary).toBe('+1 slot:user / ~2');
    expect(row.lineDiffText).toBe('+3 / -1');
  });

  it('新→旧倒序：审计首屏先看最近一次变更', () => {
    const view = buildSoulVersionView({
      versions: [
        { at: '2026-11-01T00:00:00.000Z', hash: 'old-old', version: 1 },
        { at: '2026-11-02T00:00:00.000Z', hash: 'new-new', version: 2 },
      ],
    });
    expect(view.rows.map((r) => r.hashText)).toEqual(['new-new', 'old-old']);
  });

  it('空态与 notes 原文透传（snapshot-* 降级提示不吞）', () => {
    const empty = buildSoulVersionView({ versions: [], notes: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.emptyText).toContain('暂无灵魂快照');

    const degraded = buildSoulVersionView({
      versions: [],
      notes: ['snapshot-surface-unavailable: store 未实现 listSoulSnapshots，快照段降级为空'],
    });
    expect(degraded.notes).toEqual([
      'snapshot-surface-unavailable: store 未实现 listSoulSnapshots，快照段降级为空',
    ]);
    expect(degraded.degraded).toBe(true);
  });

  it('形状异常的入参不抛错（前向兼容）', () => {
    expect(buildSoulVersionView(null).rows).toEqual([]);
    expect(buildSoulVersionView({ versions: 'nope' }).rows).toEqual([]);
    expect(buildSoulVersionView({ versions: [{}] }).rows).toHaveLength(1);
  });

  it('时间与短哈希格式', () => {
    expect(formatSoulVersionTime('2026-11-04T09:50:22.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatSoulVersionTime('not-a-date')).toBe('');
    expect(formatSoulHash('deadbeefcafebabe')).toBe('deadbeef');
    expect(formatSoulHash('abc')).toBe('abc');
  });
});
