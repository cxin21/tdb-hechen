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

const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
};

function PendingRow({ id, slot, content, busy, onDecide }: {
  id: string; slot: string; content: string; busy: string;
  onDecide: (id: string, d: 'adopted' | 'rejected') => void;
}) {
  return (
    <li className="_spending-row">
      <div className="_spending-body">
        <div className="_spending-meta">
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
            disabled={busy === id}
            onClick={() => onDecide(id, 'adopted')}
          >
            采纳
          </button>
          <button
            type="button"
            className="_soul-btn-text"
            disabled={busy === id}
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

  const refresh = useCallback(() => {
    setItems(null);
    chatMemoryApi
      .pendingList(blockId)
      .then((d) => setItems(Array.isArray(d.pending) ? d.pending : []))
      .catch(() => setItems([]));
  }, [blockId]);

  useEffect(() => { refresh(); }, [refresh]);

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
