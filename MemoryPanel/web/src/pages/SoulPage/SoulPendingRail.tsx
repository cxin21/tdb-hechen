/**
 * SoulPendingRail —— 待裁决红线右栏队列（UI 2.1 P0，设计师方案 §4.5；V-07 整改）。
 *
 * SoulPage 局部组件：PendingSection 共享组件零改动，数据同源（pendingList/pendingDecide）。
 * 重构点：按 slot 分组折叠（20+ 项不再垂直轰炸）+ 按钮权重分级
 * （采纳=小号主按钮 / 拒绝=text 级 hover 红）+ 红色左竖条 + 计数徽标。
 *
 * #100 审计视图：include_decided 拉取后客户端只留 待决+auto_adopted 两类可操作行；
 * auto_adopted 行 = 绿色「自动采纳」徽标 + 可折叠审计快照（采纳时间/门限/前后槽） +
 * 「回滚」按钮（复用 rejected 裁决；409 版本漂移 → 提示手工处理，#92 R5 语义）。
 * #101 重构：auto_adopt 审计三件套抽至 @/lib/chatMemoryAutoAdopt，与 PendingSection 统一消费。
 * #104 重构：slot 标签映射抽至 @/lib/chatMemorySlotLabel；审计快照缺值占位统一「-」
 * （原 '?' / 整行省略 → 显示「-」；#104 分诊拍板的有意可见变更，详见票内注记）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi, conflictOf, promiseConflictOf, rollbackRefusedOf, type PendingItem } from '@/lib/teamApi';
import { autoAdoptOf, isActionablePendingRow, type AutoAdoptAudit } from '@/lib/chatMemoryAutoAdopt';
import { slotLabelOf } from '@/lib/chatMemorySlotLabel';
import { tea } from '@/lib/tea-bridge';

function PendingRow({ id, slot, content, state, audit, busy, batchBusy, checked, onToggle, onDecide }: {
  id: string; slot: string; content: string; state?: string; audit?: AutoAdoptAudit | null;
  busy: string; batchBusy: boolean;
  checked: boolean; onToggle: (id: string) => void;
  onDecide: (id: string, d: 'adopted' | 'rejected') => void;
}) {
  const autoAdopted = state === 'auto_adopted';
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
            {slotLabelOf(slot)}
          </span>
          {autoAdopted && (
            <span className="_soul-chip _soul-chip--green" title="证据达到要求，系统自动采纳了这条；点「回滚」可恢复原样">
              自动采纳
            </span>
          )}
          <code className="_soul-meta _spending-id">{id}</code>
        </div>
        <pre className="_spending-content">{content}</pre>
        {audit && (
          <details className="_spending-audit">
            <summary>系统自动采纳记录</summary>
            <div className="_spending-audit-body">
              {/* #104 拍板：缺值显示「-」而非整行省略（原条件渲染的可见变更，票内已注明） */}
              <div>采纳时间：{audit.adopted_at ?? '-'}</div>
              {/* #104 拍板：gate 缺失时逐字段显示「-」，不再整行省略（可见变更，票内已注明） */}
              <div>
                证据要求：{audit.gate?.votes ?? '-'} 票 / 跨 {audit.gate?.spanHours ?? '-'} 小时；把关线：与被拒提案相似低于 {audit.gate?.contradictionThreshold ?? '-'} · 与现有内容相似低于 {audit.gate?.dupThreshold ?? '-'}
              </div>
              <div>
                采纳前的「我是谁」：
                {audit.prev_slot_existed === false
                  ? '（此前不存在，回滚即删除）'
                  : `v${audit.prev_slot_version ?? '-'}`}
              </div>
              {audit.prev_slot_content !== undefined && <pre className="_spending-audit-content">{audit.prev_slot_content}</pre>}
              <div>采纳后的「我是谁」：v{audit.post_slot_version ?? '-'}</div>
            </div>
          </details>
        )}
        <div className="_spending-actions">
          {autoAdopted ? (
            <button
              type="button"
              className="_soul-btn-ghost _soul-btn-sm"
              disabled={batchBusy || busy === id}
              title="撤销这次自动采纳，恢复原来的内容"
              onClick={() => onDecide(id, 'rejected')}
            >
              回滚
            </button>
          ) : (
            <>
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
            </>
          )}
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
    // #100 审计视图：拉取含已裁决行，客户端过滤只留 待决 + auto_adopted 两类可操作行
    // （rejected/adopted/expired 为终局，审计语义已闭合，不再打扰裁决队列）。
    chatMemoryApi
      .pendingList(blockId, { includeDecided: true })
      .then((d) =>
        setItems(Array.isArray(d.pending) ? d.pending.filter(isActionablePendingRow) : []),
      )
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
    } catch (err) {
      // #12 T6：同名冲突 409——横幅引导去完整面板确认（rail 保持零重构，不做弹窗流）
      const conflict = conflictOf(err);
      if (conflict) {
        tea.notify.warning(`「${conflict.label}」存在同名锚（${conflict.state ?? 'active'}），已在待办行标记冲突；请到「记忆 → 价值锚」面板确认后采纳`);
        setError('存在同名冲突，请到价值锚面板确认后采纳');
      } else if (promiseConflictOf(err)) {
        // #50⑤：promise 迁移 409——状态已迁移，重试只会撞 404，不误导重试。
        tea.notify.warning('该承诺状态已发生迁移，本次未重复执行；请刷新后查看承诺当前状态');
        setError('该承诺状态已发生迁移，请刷新后重看当前状态');
      } else if (rollbackRefusedOf(err)) {
        // #100：auto_adopted 回滚 409——采纳后身份槽已被人改动（版本漂移），快照回滚拒绝，
        // 重试同样拒绝；不误导重试，引导手工处理。
        tea.notify.warning('「我是谁」在自动采纳后又被改过，回滚被拒；请到「记忆 → 身份」手工核对当前内容');
        setError('回滚被拒：「我是谁」采纳后又被改过，需手工核对当前内容');
      } else {
        setError('决策失败，请重试');
      }
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
    let conflictCount = 0;
    let promiseConflictCount = 0;
    let rollbackRefusedCount = 0;
    for (const id of Array.from(selected)) {
      try {
        await chatMemoryApi.pendingDecide(blockId, id, decision);
      } catch (err) {
        // #50⑤：promise 迁移 409 单列计数（重试只会撞 404，不混入失败重试提示）。
        if (conflictOf(err)) conflictCount++;
        else if (promiseConflictOf(err)) promiseConflictCount++;
        else if (rollbackRefusedOf(err)) rollbackRefusedCount++;
        else failedIds.push(id);
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    if (failedIds.length > 0) setError(`批量决策部分失败（${failedIds.length} 条），请重试`);
    if (conflictCount > 0) setError(`同名冲突 ${conflictCount} 条需逐条确认，请到价值锚面板处理`);
    if (promiseConflictCount > 0)
      setError(`承诺状态迁移冲突 ${promiseConflictCount} 条，承诺已被他处迁移，请刷新后查看当前状态`);
    if (rollbackRefusedCount > 0)
      setError(`回滚被拒 ${rollbackRefusedCount} 条：「我是谁」采纳后又被改过，需手工核对当前内容（见「记忆 → 身份」）`);
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
              <span className="_spending-group-title">{slotLabelOf(slot)}</span>
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
                    state={p.state}
                    audit={autoAdoptOf(p)}
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
