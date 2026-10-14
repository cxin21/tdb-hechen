/**
 * PendingSection —— 待办裁决区（U3/U4，DS-SOUL-MEMORY-002 P2-O13）。
 *
 * core_value/strict_rule 分级提案列表：人工 adopt/reject（O13 单向状态机，
 * 幂等复决由网关 404 兜底，UI 刷新后列表自然消失）。
 * 宁缺毋滥：空列表/读失败整段不渲染（不打扰锚面板主流程）。
 * Owner-only 决策（BFF decide 已做 owner 校验，非属主 403）。
 *
 * #19 T12：重提提案徽标（attrs.reproposed → 重提 #generation，tooltip 溯源）。
 * #12 T6：同名冲突 —— list 徽标（conflict:true）+ 采纳 409 确认弹窗
 * （缺省安全优先不落库；确认后 allow_overwrite=true 显式覆盖；vetoed 不可绕仅提示）。
 */
import { useCallback, useEffect, useState } from 'react';
import { chatMemoryApi, conflictOf, type PendingItem } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

const SLOT_LABEL: Record<string, string> = {
  core_value: '价值锚提案',
  strict_rule: '行为红线提案',
};

/** #19 T12：重提提案 attrs（宽松解析；坏 JSON/旧行 → null 不显示徽标） */
function reproposalOf(p: PendingItem): { generation?: number; supersedes?: string; evidence_threshold?: number } | null {
  try {
    const a = p.attrs_json ? (JSON.parse(p.attrs_json) as Record<string, unknown>) : null;
    if (a && a.reproposed === true) {
      return {
        generation: typeof a.generation === 'number' ? a.generation : undefined,
        supersedes: typeof a.supersedes === 'string' ? a.supersedes : undefined,
        evidence_threshold: typeof a.evidence_threshold === 'number' ? a.evidence_threshold : undefined,
      };
    }
  } catch {
    /* 坏 JSON → 无徽标 */
  }
  return null;
}

export function PendingSection(props: { blockId: string }) {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // 任务6② P1：批量裁决（O13 单向状态机——批量拒绝走 confirm 二次确认）。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

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

  async function decide(id: string, decision: 'adopted' | 'rejected', allowOverwrite = false) {
    setBusy(id);
    setError('');
    try {
      const res = await chatMemoryApi.pendingDecide(props.blockId, id, decision, { allowOverwrite });
      if (res?.overwritten) tea.notify.success('已显式覆盖同名锚');
      refresh();
    } catch (err) {
      // #12 T6：409 同名冲突——缺省安全优先未落库；确认后显式覆盖重试（vetoed 不可绕仅提示）。
      const conflict = conflictOf(err);
      if (conflict && decision === 'adopted' && !allowOverwrite) {
        if (conflict.state === 'vetoed') {
          setError(`「${conflict.label}」已被永久否决（vetoed），不可采纳覆盖；如需恢复请先在锚面板处理否决状态`);
          setBusy('');
          return;
        }
        const stateNote = conflict.state === 'retired' ? '（当前为退休状态，覆盖将复活该锚）' : '';
        const ok = await tea.confirm({
          message: `已存在同名锚「${conflict.label}」${stateNote}`,
          description:
            '确认覆盖？将复用现有锚（保留权重/方向/钉住/来源），按提案内容重写该锚并执行本次采纳。' +
            (conflict.pending_has_description ? '' : '注意：本提案缺少合格描述，覆盖后锚描述可能为空。'),
          okText: '覆盖采纳',
          cancelText: '取消',
        });
        if (ok) {
          await decide(id, decision, true);
        }
        setBusy('');
        return;
      }
      setError('决策失败，请重试');
    } finally {
      setBusy('');
    }
  }

  function toggleSel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
        await chatMemoryApi.pendingDecide(props.blockId, id, decision);
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

  return (
    <section className="_id-section" aria-label="待办裁决区">
      <div className="_id-block">
        <div className="_id-title">待办裁决（分级提案，人工决策后生效）</div>
        <div className="_pending-batch">
          <label className="_pending-selall">
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
            className="_pending-btn adopt"
            disabled={batchBusy || selected.size === 0}
            onClick={() => void batchDecide('adopted')}
          >
            批量采纳（{selected.size}）
          </button>
          <button
            className="_pending-btn reject"
            disabled={batchBusy || selected.size === 0}
            onClick={() => void batchDecide('rejected')}
          >
            批量拒绝（{selected.size}）
          </button>
        </div>
        <ul className="_pending-list">
          {items.map((p) => (
            <li key={p.pending_id} className="_pending-row">
              <div className="_pending-meta">
                <input
                  type="checkbox"
                  className="_pending-check"
                  checked={selected.has(p.pending_id)}
                  onChange={() => toggleSel(p.pending_id)}
                />
                <span className="_pending-slot">{SLOT_LABEL[p.slot] ?? p.slot}</span>
                {p.conflict === true && (
                  <span className="_pending-badge conflict" title="提案 label 与现有同名锚冲突：缺省采纳将被拦截（409），确认后可显式覆盖">
                    同名冲突
                  </span>
                )}
                {reproposalOf(p) && (
                  <span
                    className="_pending-badge reproposal"
                    title={`证据升级重提（第 ${reproposalOf(p)?.generation ?? '?'} 次，阈值 ${reproposalOf(p)?.evidence_threshold ?? '?'} 条证据）· 溯源 ${reproposalOf(p)?.supersedes ?? '-'}`}
                  >
                    重提#{reproposalOf(p)?.generation ?? '?'}
                  </span>
                )}
                <code className="_pending-id">{p.pending_id}</code>
              </div>
              <pre className="_pending-content">{p.content}</pre>
              <div className="_pending-actions">
                <button
                  className="_pending-btn adopt"
                  disabled={batchBusy || busy === p.pending_id}
                  onClick={() => decide(p.pending_id, 'adopted')}
                >
                  采纳
                </button>
                <button
                  className="_pending-btn reject"
                  disabled={batchBusy || busy === p.pending_id}
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
