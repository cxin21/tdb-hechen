/**
 * PendingSection —— 待办裁决区（U3/U4，DS-SOUL-MEMORY-002 P2-O13）。
 *
 * core_value/strict_rule 分级提案列表：人工 adopt/reject（O13 单向状态机，
 * 幂等复决由网关 404 兜底，UI 刷新后列表自然消失）。
 * 宁缺毋滥：空列表/读失败整段不渲染（不打扰锚面板主流程）。
 * Owner-only 决策（BFF decide 已做 owner 校验，非属主 403）。
 */
import { useCallback, useEffect, useState } from 'react';
import { chatMemoryApi, type PendingItem } from '@/lib/teamApi';

const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
};

export function PendingSection(props: { blockId: string }) {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    setItems(null);
    chatMemoryApi
      .pendingList(props.blockId)
      .then((d) => setItems(Array.isArray(d.pending) ? d.pending : []))
      .catch(() => setItems([]));
  }, [props.blockId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function decide(id: string, decision: 'adopted' | 'rejected') {
    setBusy(id);
    setError('');
    try {
      await chatMemoryApi.pendingDecide(props.blockId, id, decision);
      refresh();
    } catch {
      setError('决策失败，请重试');
    } finally {
      setBusy('');
    }
  }

  if (items === null || items.length === 0) return null;

  return (
    <section className="_id-section" aria-label="待办裁决区">
      <div className="_id-block">
        <div className="_id-title">待办裁决（分级提案，人工决策后生效）</div>
        <ul className="_pending-list">
          {items.map((p) => (
            <li key={p.pending_id} className="_pending-row">
              <div className="_pending-meta">
                <span className="_pending-slot">{SLOT_LABEL[p.slot] ?? p.slot}</span>
                <code className="_pending-id">{p.pending_id}</code>
              </div>
              <pre className="_pending-content">{p.content}</pre>
              <div className="_pending-actions">
                <button
                  className="_pending-btn adopt"
                  disabled={busy === p.pending_id}
                  onClick={() => decide(p.pending_id, 'adopted')}
                >
                  采纳
                </button>
                <button
                  className="_pending-btn reject"
                  disabled={busy === p.pending_id}
                  onClick={() => decide(p.pending_id, 'rejected')}
                >
                  拒绝
                </button>
              </div>
            </li>
          ))}
        </ul>
        {error && <div className="_pending-error">{error}</div>}
      </div>
    </section>
  );
}
