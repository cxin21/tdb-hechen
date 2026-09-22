/**
 * SoulPendingRail —— 待裁决红线右栏队列（UI 2.1 P0，设计师方案 §4.5；V-07 整改）。
 *
 * SoulPage 局部组件：PendingSection 共享组件零改动，数据同源（pendingList/pendingDecide）。
 * 重构点：按 slot 分组折叠（20+ 项不再垂直轰炸）+ 按钮权重分级
 * （采纳=小号主按钮 / 拒绝=text 级 hover 红）+ 红色左竖条 + 计数徽标。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi, type PendingItem } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
};

function PendingRow({ id, slot, content, busy, batchBusy, checked, onToggle, onDecide }: {
  id: string; slot: string; content: string; busy: string; batchBusy: boolean;
  checked: boolean; onToggle: (id: string) => void;
  onDecide: (id: string, d: 'adopted' | 'rejected') => void;
}) {
  return (
    <li className="_spending-row">
      <div className="_spending-body">
        <div className="_spending-meta">
          <input
            type="checkbox"
            className="_spending-check"
            checked={checked}
            onChange={() => onToggle(id)}
          />
          <span className={`_soul-chip ${slot === 'strict_rule' ? '_soul-chip--red' : '_soul-chip--gold'}`}>
            {SLOT_LABEL[slot] ?? slot}
          </span>
          <code className="_soul-meta _spending-id">{id}</code>
        </div>
        <pre className="_spending-content">{content}</pre>
        <div className="_spending-actions">
          <button
            type="button"
            className="_soul-btn-primary _soul-btn-sm"
            disabled={batchBusy || busy === id}
            onClick={() => onDecide(id, 'adopted')}
          >
            采纳
          </button>
          <button
            type="button"
            className="_soul-btn-text"
            disabled={batchBusy || busy === id}
            onClick={() => onDecide(id, 'rejected')}
          >
            拒绝
          </button>
        </div>
      </div>
    </li>
  );
}

export function SoulPendingRail({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // 任务6② P1：批量裁决操作条（O13 单向状态机——批量操作 tea.confirm 二次确认）。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const refresh = useCallback(() => {
    setItems(null);
    chatMemoryApi
      .pendingList(blockId)
      .then((d) => setItems(Array.isArray(d.pending) ? d.pending : []))
      .catch(() => setItems([]));
  }, [blockId]);

  useEffect(() => { refresh(); }, [refresh]);

  function toggleSel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function decide(id: string, decision: 'adopted' | 'rejected') {
    setBusy(id);
    setError('');
    try {
      await chatMemoryApi.pendingDecide(blockId, id, decision);
      refresh();
    } catch {
      setError('决策失败，请重试');
    } finally { setBusy(''); }
  }

  async function batchDecide(decision: 'adopted' | 'rejected') {
    if (selected.size === 0 || batchBusy) return;
    const ok = await tea.confirm({
      message: decision === 'adopted' ? '批量采纳所选提案？' : '批量拒绝所选提案？',
      description: `共 ${selected.size} 条；O13 单向状态机，操作后不可复决`,
      okText: '确认',
    });
    if (!ok) return;
    setBatchBusy(true);
    setError('');
    const failedIds: string[] = [];
    for (const id of Array.from(selected)) {
      try {
        await chatMemoryApi.pendingDecide(blockId, id, decision);
      } catch {
        failedIds.push(id);
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    if (failedIds.length > 0) setError(`批量决策部分失败（${failedIds.length} 条），请重试`);
    refresh();
  }

  if (items === null || items.length === 0) return null;

  const groups = new Map<string, PendingItem[]>();
  for (const p of items) {
    const key = p.slot ?? 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  return (
    <section className="_soul-section _soul-railcard" aria-label={t('soul.pending.title')} id="_soul-sec-pending">
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.pending.title')}</span>
        <span className="_soul-chip _soul-chip--red">{items.length} 待裁决</span>
      </div>
      <div className="_spending-batch">
        <label className="_spending-selall">
          <input
            type="checkbox"
            checked={selected.size === items.length && items.length > 0}
            onChange={() =>
              setSelected(
                selected.size === items.length ? new Set() : new Set(items.map((q) => q.pending_id)),
              )
            }
          />
          全选
        </label>
        <button
          type="button"
          className="_soul-btn-primary _soul-btn-sm"
          disabled={batchBusy || selected.size === 0}
          onClick={() => void batchDecide('adopted')}
        >
          批量采纳（{selected.size}）
        </button>
        <button
          type="button"
          className="_soul-btn-text"
          disabled={batchBusy || selected.size === 0}
          onClick={() => void batchDecide('rejected')}
        >
          批量拒绝（{selected.size}）
        </button>
      </div>
      {[...groups.entries()].map(([slot, list]) => {
        const collapsed = collapsedGroups.has(slot);
        return (
          <div key={slot} className="_spending-group">
            <button
              type="button"
              className="_spending-group-head"
              onClick={() => setCollapsedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(slot)) next.delete(slot); else next.add(slot);
                return next;
              })}
            >
              <span className="_spending-group-title">{SLOT_LABEL[slot] ?? slot}</span>
              <span className="_soul-meta">{collapsed ? `展开（${list.length}）` : list.length}</span>
            </button>
            {!collapsed && (
              <ul className="_spending-list">
                {list.map((p) => (
                  <PendingRow
                    key={p.pending_id}
                    id={p.pending_id}
                    slot={p.slot}
                    content={p.content}
                    busy={busy}
                    batchBusy={batchBusy}
                    checked={selected.has(p.pending_id)}
                    onToggle={toggleSel}
                    onDecide={decide}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {error && <div className="_spending-error">{error}</div>}
    </section>
  );
}
