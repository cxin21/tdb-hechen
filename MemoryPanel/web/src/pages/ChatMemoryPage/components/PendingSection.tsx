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
 * #100 审计视图：include_decided 拉取后客户端过滤只留 待决 + auto_adopted 两类可操作行；
 * auto_adopted 行 = 绿色「自动采纳」徽标 + 可折叠审计快照 + 「回滚」按钮
 * （复用 rejected 裁决；409 版本漂移 → 提示手工处理，#92 R5 语义）。
 * #101 重构：auto_adopt 审计三件套抽至 @/lib/chatMemoryAutoAdopt，与 SoulPendingRail 统一消费。
 * #104 重构：slot 标签映射抽至 @/lib/chatMemorySlotLabel，与 SoulPendingRail 统一消费。
 * #103 修复：批量操作排除终局行——auto_adopted 等终局行复选框禁用、全选跳过、无可选项禁用批量按钮。
 */
import { useCallback, useEffect, useState } from 'react';
import { chatMemoryApi, classify409Of, type PendingItem } from '@/lib/teamApi';
import {
  autoAdoptOf,
  batchSelectablePendingRows,
  isActionablePendingRow,
  isBatchSelectablePendingRow,
  pruneSelectionToSelectable,
  type AutoAdoptAudit,
} from '@/lib/chatMemoryAutoAdopt';
import { slotLabelOf } from '@/lib/chatMemorySlotLabel';
import { tea } from '@/lib/tea-bridge';

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
    // #100 审计视图：拉取含已裁决行，客户端过滤只留 待决 + auto_adopted 两类可操作行。
    chatMemoryApi
      .pendingList(props.blockId, { includeDecided: true })
      .then((d) => {
        const rows = Array.isArray(d.pending) ? d.pending.filter(isActionablePendingRow) : [];
        setItems(rows);
        // #103：拉新列表后清洗勾选集——并发 auto-adopt 门可能已把已勾行置终局
        setSelected((prev) => new Set(pruneSelectionToSelectable(Array.from(prev), rows)));
      })
      .catch(() => setItems([]));
  }, [props.blockId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // #103：可批量勾选的行（待决行）——全选与批量计数都只看它；终局行仍可见可单条回滚
  const selectable = batchSelectablePendingRows(items ?? []);

  async function decide(id: string, decision: 'adopted' | 'rejected', allowOverwrite = false) {
    setBusy(id);
    setError('');
    try {
      const res = await chatMemoryApi.pendingDecide(props.blockId, id, decision, { allowOverwrite });
      if (res?.overwritten) tea.notify.success('已显式覆盖同名锚');
      refresh();
    } catch (err) {
      // #12 T6：409 同名冲突——缺省安全优先未落库；确认后显式覆盖重试（vetoed 不可绕仅提示）。
      // #102：三处提取器收敛到 classify409Of 单一分类入口（结构化优先，文案回退）。
      const c409 = classify409Of(err);
      const conflict = c409?.kind === 'conflict' ? c409.conflict : null;
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
      // #50⑤：promise 迁移 409——承诺状态已被他处迁移或迁移被拒，重试只会撞 404，不误导重试。
      const promiseConflict = c409?.kind === 'promise-conflict' ? c409.conflict : null;
      if (promiseConflict) {
        setError(
          `该承诺状态已发生迁移（目标 ${promiseConflict.to}${promiseConflict.reason ? `：${promiseConflict.reason}` : ''}），本次未重复执行；请刷新后查看承诺当前状态`,
        );
        setBusy('');
        return;
      }
      // #100：auto_adopted 回滚 409——采纳后身份槽已被人改动（版本漂移），快照回滚拒绝，
      // 重试同样拒绝；不误导重试，引导手工处理。
      if (c409?.kind === 'rollback-refused') {
        setError('回滚被拒：「我是谁」在自动采纳后又被改过，需手工核对当前内容');
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
    // #103：发车前再清洗一遍勾选集——items 里已变终局的行不允许混进批量请求（内核会 404）
    const ids = pruneSelectionToSelectable(Array.from(selected), items ?? []);
    setSelected(new Set(ids));
    if (ids.length === 0 || batchBusy) return;
    const ok = await tea.confirm({
      message: decision === 'adopted' ? '批量采纳所选提案？' : '批量拒绝所选提案？',
      description: `共 ${ids.length} 条；O13 单向状态机，操作后不可复决`,
      okText: '确认',
    });
    if (!ok) return;
    setBatchBusy(true);
    setError('');
    const failedIds: string[] = [];
    let rollbackRefusedCount = 0;
    for (const id of ids) {
      try {
        await chatMemoryApi.pendingDecide(props.blockId, id, decision);
      } catch (err) {
        // #100：回滚被拒单列计数（槽已漂移，重试同样拒绝，不混入可重试失败）。
        if (classify409Of(err)?.kind === 'rollback-refused') rollbackRefusedCount++;
        else failedIds.push(id);
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    if (failedIds.length > 0) setError(`批量决策部分失败（${failedIds.length} 条），请重试`);
    if (rollbackRefusedCount > 0)
      setError(`回滚被拒 ${rollbackRefusedCount} 条：「我是谁」采纳后又被改过，需手工核对当前内容（见「记忆 → 身份」）`);
    refresh();
  }

  if (items === null || items.length === 0) return null;

  return (
    <section className="_id-section" aria-label="待办裁决区">
      <div className="_id-block">
        <div className="_id-title">待办裁决（分级提案，人工决策后生效）</div>
        <div className="_pending-batch">
          {/* #103：全选只选待决行——终局行（auto_adopted 等）不可批量勾选，勾了就撞内核 404 */}
          <label className="_pending-selall">
            <input
              type="checkbox"
              checked={selectable.length > 0 && selected.size === selectable.length}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < selectable.length;
              }}
              disabled={selectable.length === 0}
              onChange={() =>
                setSelected(
                  selected.size === selectable.length ? new Set() : new Set(selectable.map((q) => q.pending_id)),
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
                {/* #103：终局行复选框禁用——auto_adopted 可见可回滚但不可批量勾选，勾了就撞内核 404 */}
                <input
                  type="checkbox"
                  className="_pending-check"
                  disabled={!isBatchSelectablePendingRow(p)}
                  checked={selected.has(p.pending_id)}
                  onChange={() => toggleSel(p.pending_id)}
                />
                <span className="_pending-slot">{slotLabelOf(p.slot)}</span>
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
              {p.state === 'auto_adopted' ? (
                // #100：自动采纳行 —— 徽标 + 可折叠审计快照 + 回滚（复用 rejected 裁决）。
                <AutoAdoptRow
                  audit={autoAdoptOf(p)}
                  id={p.pending_id}
                  busy={batchBusy || busy === p.pending_id}
                  onDecide={decide}
                />
              ) : (
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
              )}
            </li>
          ))}
        </ul>
        {error && <div className="_pending-error">{error}</div>}
      </div>
    </section>
  );
}

/** #100：审计快照行（采纳时间/门限/采纳前后槽版本与内容）+ 回滚按钮（复用 rejected 裁决） */
function AutoAdoptRow(props: {
  id: string;
  audit: AutoAdoptAudit | null;
  busy: boolean;
  onDecide: (id: string, decision: 'adopted' | 'rejected') => void;
}) {
  const a = props.audit;
  return (
    <div className="_pending-actions _pending-audit">
      <span className="_pending-badge auto-adopt" title="证据达到要求，系统自动采纳了这条；点「回滚」可恢复原样">
        自动采纳
      </span>
      <details className="_pending-audit-details">
        <summary>系统自动采纳记录</summary>
        <div className="_pending-audit-body">
          <span>{a?.adopted_at ? `采纳时间：${a.adopted_at}` : '采纳时间：-'}</span>
          <span>
            {`证据要求：${a?.gate?.votes ?? '-'} 票 / 跨 ${a?.gate?.spanHours ?? '-'} 小时；把关线：与被拒提案相似低于 ${a?.gate?.contradictionThreshold ?? '-'} · 与现有内容相似低于 ${a?.gate?.dupThreshold ?? '-'}`}
          </span>
          <span>
            采纳前的「我是谁」：
            {a?.prev_slot_existed === false ? '当时还没有（回滚即清空）' : `v${a?.prev_slot_version ?? '-'}`}
          </span>
          {a?.prev_slot_content !== undefined && (
            <pre className="_pending-audit-content">{a.prev_slot_content}</pre>
          )}
          <span>采纳后的「我是谁」：v{a?.post_slot_version ?? '-'}</span>
        </div>
      </details>
      <button
        className="_pending-btn reject"
        disabled={props.busy}
        title="撤销这次自动采纳，恢复原来的内容"
        onClick={() => props.onDecide(props.id, 'rejected')}
      >
        回滚
      </button>
    </div>
  );
}
