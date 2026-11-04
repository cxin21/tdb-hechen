/**
 * AttributesSection —— L1 记忆属性表（UI 2.0 Phase 2，拍板③；spec §4.1 十九列对齐）。
 *
 * 数据源：/chat-memory/layer|search 出参（896ee5d soul 字段 + Phase 2 BFF 补透传
 * task_id/team_id/user_id/agent_id/version/updated_at + D-0（2026-09-21）补透传
 * scene_name/priority/session_key/session_id/timestamp_str/start/end——内核
 * atomic-query-fields.ts 单一源已补齐七字段，全列呈现）。V7-UI-3.3 起「属性」改弹出卡呈现（全宽防挤压，拍板「不行就改成弹出卡片」）；
 * 「复制 JSON」导出全部在场属性。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Modal } from 'tea-component';
import {
  chatMemoryApi,
  type ChatMemoryLayerItem,
  type ChatMemorySourceMessage,
} from '@/lib/api/chat-memory';
import { attrLabel } from '@/lib/attr-labels';
import { tea } from '@/lib/tea-bridge';

type Row = { k: string; v: string };

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** ADR-0025：原话时间显示；可解析则本地化，脏值原样露出（不吞证据）。 */
function timeText(v: string): string {
  if (!v) return '';
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return v;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * certainty 本地化（D-3 同族）：observed=实见、inferred=推断、脏值原样露出。
 * 语义落点见 docs/adr/0025（certainty 保持二值，不作数值置信度）。
 */
function certaintyTextOf(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  if (s === 'observed') return '实见（observed）';
  if (s === 'inferred') return '推断（inferred）';
  return s;
}

/**
 * sensitivity 本地化 + 作用说明（D-3 / ADR-0025 决定 4）。
 * 它不是排序权重，是注入门的判据：非「本人私有上下文」一律不注入；
 * 词表外取值（unclassified）fail-closed 恒拦——运维必须一眼看出原因。
 */
function sensitivityTextOf(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  if (s === 'none') return '无（任何上下文可注入）';
  if (s === 'health') return '健康 → 仅本人私有上下文注入';
  if (s === 'finance') return '财务 → 仅本人私有上下文注入';
  if (s === 'relationship') return '关系 → 仅本人私有上下文注入';
  return `${s}（不在白名单，注入门恒拦）`;
}

/** D-4：周期徽章文本（note 首选；缺省 cadence+anchor 中文映射——与内核 recurrenceLabel 同语义）。 */
function recurrenceText(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { cadence?: string; anchor?: string | null; note?: string };
  const ZH: Record<string, string> = {
    MON: '一',
    TUE: '二',
    WED: '三',
    THU: '四',
    FRI: '五',
    SAT: '六',
    SUN: '日',
  };
  if (typeof r.note === 'string' && r.note.trim() !== '') return r.note;
  const c = r.cadence;
  const a = r.anchor || null;
  if (c === 'daily') return '每天';
  if (c === 'monthly') return a ? `每月${a}日` : '每月';
  if (c === 'quarterly') return '每季度';
  if (c === 'yearly') return '每年';
  if ((c === 'weekly' || c === 'biweekly') && a && ZH[a]) {
    return `${c === 'weekly' ? '每周' : '每两周'}${ZH[a]}`;
  }
  return null;
}

export function AttributesSection({
  item,
  blockId,
  canEdit,
}: {
  item: ChatMemoryLayerItem;
  blockId?: string;
  /** 是否本人资产（Owner-only 写操作的前置可见性门）。`undefined` = 不猜归属，
   *  交由 BFF 的 asset/get owner 校验兜底（非 owner 403 并落到本区域错误文案）。 */
  canEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // F-CLUSTER §5 簇视图：证据源展开抽屉（按 id 回读内核 /v3/atomic/by-ids——
  // B3 归档回退 + archived 标记；源内容在此可见（用户看不到=没做）。
  const evIds = useMemo(() => {
    const raw = (item.metadata ?? {}) as Record<string, unknown>;
    const v = raw.evidence_ids;
    if (Array.isArray(v))
      return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  }, [item]);
  const [evOpen, setEvOpen] = useState(false);
  const [evItems, setEvItems] = useState<Array<Record<string, unknown>> | null>(null);
  const [evError, setEvError] = useState<string | null>(null);
  useEffect(() => {
    if (!evOpen || evItems !== null) return;
    chatMemoryApi
      .evidenceByIds(item.id, evIds)
      .then((r) => setEvItems(r.items))
      .catch((e) => setEvError(e instanceof Error ? e.message : String(e)));
  }, [evOpen, evItems, item.id, evIds]);

  // ADR-0025 行级溯源：source_message_ids 存的是 L0 record_id（不是文本），
  // 用户只看到 id 串等于看不到证据；这里按 id 批量回读原话（BFF
  // /chat-memory/source-messages → 内核 /v3/conversation/by-ids）。
  // 与上方证据抽屉同一套 _ev-* 视觉，独立状态避免两个抽屉互相污染。
  const srcIds = useMemo(() => {
    const raw = item.source_message_ids;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }, [item]);
  const [srcOpen, setSrcOpen] = useState(false);
  const [srcItems, setSrcItems] = useState<ChatMemorySourceMessage[] | null>(null);
  const [srcError, setSrcError] = useState<string | null>(null);
  useEffect(() => {
    if (!srcOpen || srcItems !== null) return;
    if (!blockId) {
      setSrcError('缺少 block 上下文，无法回读原话');
      return;
    }
    chatMemoryApi
      .sourceMessages(blockId, srcIds)
      .then((r) => setSrcItems(r.items))
      .catch((e) => setSrcError(e instanceof Error ? e.message : String(e)));
  }, [srcOpen, srcItems, blockId, srcIds]);

  // P1-T7：人工重要度调整（Owner-only）。追加语义由网关保证——
  // metadata.importance_source='manual' + importance_manual_reason，llm 评语不覆写。
  const [impValue, setImpValue] = useState(
    item.importance !== undefined ? String(item.importance) : '',
  );
  const [impReason, setImpReason] = useState('');
  const [impBusy, setImpBusy] = useState(false);
  const [impMsg, setImpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submitImportance = () => {
    if (!blockId) {
      setImpMsg({ ok: false, text: '缺少 block 上下文，无法调整' });
      return;
    }
    const v = Number(impValue);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      setImpMsg({ ok: false, text: '重要度需为 1-10 的整数' });
      return;
    }
    setImpBusy(true);
    setImpMsg(null);
    chatMemoryApi
      .adjustImportance(blockId, item.id, v, impReason.trim() === '' ? undefined : impReason.trim())
      .then(() =>
        setImpMsg({ ok: true, text: `已调整为 ${v}（source=manual，重新打开属性后生效）` }),
      )
      .catch((e) => setImpMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setImpBusy(false));
  };

  // P1-T8：标记失效 / 撤销失效（软失效不删记忆；失效后钩子路/工具路召回均排除，撤销即恢复）。
  // hasVe=valid_end 非空（含未来失效时点——清空走 restore）；invalidatedNow=已到期失效。
  const veRaw = typeof item.valid_end === 'string' ? item.valid_end.trim() : '';
  const hasVe = veRaw !== '';
  const invalidatedNow =
    hasVe && Number.isFinite(Date.parse(veRaw)) && Date.parse(veRaw) <= Date.now();
  const [invBusy, setInvBusy] = useState(false);
  const [invMsg, setInvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submitInvalidate = (mode: 'invalidate' | 'restore') => {
    if (!blockId) {
      setInvMsg({ ok: false, text: '缺少 block 上下文，无法操作' });
      return;
    }
    setInvBusy(true);
    setInvMsg(null);
    chatMemoryApi
      .setInvalidated(blockId, item.id, mode)
      .then(() =>
        setInvMsg({
          ok: true,
          text:
            mode === 'invalidate'
              ? '已标记失效（两路召回排除；可撤销恢复，重新打开属性后生效）'
              : '已撤销失效（恢复召回，重新打开属性后生效）',
        }),
      )
      .catch((e) => setInvMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setInvBusy(false));
  };

  // A 项（2026-11-04，ADR-0025 决策 10）：解除敏感标记（显式降敏 → none）。
  // 为什么需要人工入口：sensitivity 是**粘性列**（none/''/NULL = 本次未判定 → 保留旧值），
  // 自动路径只会升级、永不降级；把一条已分类记忆降回 none 只能由人显式发起，
  // 且必须带 expect（= 面板看到的当前值）做 CAS——库中值已被并发改写则 409 拒绝。
  // 可见性：确有敏感标记（非 none/unclassified）且本人资产；真正的 owner 校验在 BFF
  // （asset/get → 非 owner 403 NOT_ASSET_OWNER），这里只做「非本人不出入口」。
  const sensRaw = typeof item.sensitivity === 'string' ? item.sensitivity.trim() : '';
  const showUnmark =
    canEdit !== false && sensRaw !== '' && sensRaw !== 'none' && sensRaw !== 'unclassified';
  const [sensBusy, setSensBusy] = useState(false);
  const [sensMsg, setSensMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submitUnmarkSensitivity = () => {
    if (!blockId) {
      setSensMsg({ ok: false, text: '缺少 block 上下文，无法解除敏感标记' });
      return;
    }
    if (sensRaw === '') {
      setSensMsg({ ok: false, text: '该行未带敏感度字段，无法做 CAS 降敏（请刷新后重试）' });
      return;
    }
    // 二次确认：降敏是**放宽**注入门，不做静默一键操作（与 importance 的免确认不同）。
    void tea
      .confirm({
        message: '解除敏感标记？',
        description:
          '当前 sensitivity=' +
          sensRaw +
          '。解除后（→ none）该记忆在群聊/共享/外部上下文也可能被注入。本次带 expect=' +
          sensRaw +
          ' 做 CAS，库中值已被改动会拒绝（409）。',
        okText: '解除标记',
        cancelText: '取消',
      })
      .then((ok) => {
        if (!ok) return;
        setSensBusy(true);
        setSensMsg(null);
        return chatMemoryApi
          .setSensitivity(blockId, item.id, 'none', sensRaw)
          .then(() =>
            setSensMsg({
              ok: true,
              text: '已解除敏感标记（sensitivity=none，重新打开属性后生效）',
            }),
          )
          .catch((e) => setSensMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }))
          .finally(() => setSensBusy(false));
      });
  };

  // C 项（2026-11-04）：属性行的**展示标签**统一走 @/lib/attr-labels 的单一事实源
  // （importance/significance/… 10 个别名在本仓曾出现「强度/重要性/重要程度」三种叫法）。
  // 只换标签、不动数据结构：行内的 k 是给人看的；机读 JSON（handleCopy）仍用原始
  // 字段名，见 handleCopy() 上方注释。未登记的键由 attrLabel 原样回退。
  const rows = useMemo<Row[]>(() => {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const out: Row[] = [];
    const push = (k: string, v: unknown) => {
      const s = str(v);
      if (s !== null) out.push({ k, v: s });
    };
    push('id', item.id);
    push('type', item.title);
    push(attrLabel('occurred_at'), item.occurred_at);
    push(attrLabel('valid_start'), item.valid_start);
    push(attrLabel('valid_end'), item.valid_end);
    push(attrLabel('certainty'), certaintyTextOf(item.certainty));
    push(attrLabel('valence'), item.valence);
    push(attrLabel('arousal'), item.arousal);
    push(attrLabel('significance'), item.significance);
    push('version', item.version);
    push('team_id', item.team_id);
    push('user_id', item.user_id);
    push('agent_id', item.agent_id);
    // P0（task-10）：task_id 是运维排障用的裸键（无译名），仅非空渲染（push 已跳过
    // null/空串），且刻意不放进 attrLabel 译名区——它不属于十个受控属性别名。
    push('task_id', item.task_id);
    push('created_at', item.created_at);
    push('updated_at', item.updated_at);
    // D-0（spec §4.1 补齐七列）：场景/会话归属/事件时间三组
    push('scene_name', item.scene_name);
    push('priority', item.priority);
    push('session_key', item.session_key);
    push('session_id', item.session_id);
    push('timestamp_str', item.timestamp_str);
    push('timestamp_start', item.timestamp_start);
    push('timestamp_end', item.timestamp_end);
    // D-3：敏感性（none/health/finance/relationship；词表外值也露出，注入门恒拦）
    push(attrLabel('sensitivity'), sensitivityTextOf(item.sensitivity));
    // P1-T7：重要度（LLM 标注 1-10 或人工调整；NULL=未评分 不渲染）
    push(attrLabel('importance'), item.importance);
    // ADR-0025 行级溯源：属性表只显示条数（裸 JSON 不可读），0 条不渲染该行。
    if (srcIds.length > 0)
      out.push({ k: attrLabel('source_message_ids'), v: `${srcIds.length} 条` });
    push('importance_reason（llm）', meta.importance_reason);
    push('importance_manual_reason', meta.importance_manual_reason);
    push('importance_source', meta.importance_source);
    push('recall_count', meta.recall_count);
    push('last_recalled_at', meta.last_recalled_at);
    push('subject', meta.subject);
    // D-4：周期性事实（metadata_json.recurrence；normalize 形状）
    push('周期', recurrenceText(meta.recurrence));
    const eids = meta.evidence_ids;
    push('evidence_ids', Array.isArray(eids) ? (eids as unknown[]).join('、') : eids);
    const evo = meta.evolution as { from?: unknown; reason?: unknown } | null | undefined;
    if (evo && typeof evo === 'object') {
      push(
        'evolution.from',
        Array.isArray(evo.from) ? (evo.from as unknown[]).join('、') : evo.from,
      );
      push('evolution.reason', evo.reason);
    }
    return out;
  }, [item, srcIds]);

  if (rows.length === 0) return null;

  // 机读出口：复制 JSON **必须保持原始字段名**（下游脚本按 API 键名解析）。
  // 这里刻意不读 rows（rows 的 k 已是中文展示标签），也不得改成 attrLabel(...)：
  // tests/attr-labels.test.ts 钉住了本函数体内不含 'attrLabel(' 与中文键。
  function handleCopy() {
    const payload: Record<string, unknown> = {
      id: item.id,
      type: item.title,
      occurred_at: item.occurred_at,
      valid_start: item.valid_start,
      valid_end: item.valid_end,
      certainty: item.certainty,
      valence: item.valence,
      arousal: item.arousal,
      significance: item.significance,
      // P0（task-10）：复制 JSON 是机读出口，必须带 sensitivity 原始键名——
      // 否则下游脚本拿不到「这条记忆会不会被注入」的唯一判据（展示行早已有）。
      sensitivity: item.sensitivity,
      version: item.version,
      team_id: item.team_id,
      user_id: item.user_id,
      agent_id: item.agent_id,
      task_id: item.task_id,
      scene_name: item.scene_name,
      priority: item.priority,
      session_key: item.session_key,
      session_id: item.session_id,
      timestamp_str: item.timestamp_str,
      timestamp_start: item.timestamp_start,
      timestamp_end: item.timestamp_end,
      created_at: item.created_at,
      updated_at: item.updated_at,
      importance: item.importance,
      source_message_ids: item.source_message_ids,
      metadata: item.metadata,
    };
    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="_memory-detail-atomic-attrs">
      <button
        type="button"
        className="_soul-chip _soul-chip--attrs"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        🧬 属性{open ? '' : ` (${rows.length})`}
      </button>
      {open && (
        <Modal
          visible
          caption={`记忆属性（${rows.length} 列）`}
          size="l"
          onClose={() => setOpen(false)}
        >
          <Modal.Body>
            <div className="_attr-table _attr-table--modal" id={`_attr-tbl-${item.id}`}>
              {rows.map((r) => (
                <div key={r.k} className="_attr-row">
                  <span className="_attr-key">{r.k}</span>
                  <span className="_attr-val">{r.v}</span>
                </div>
              ))}
            </div>
            {/* ADR-0025 行级溯源：source_message_ids → 原话（复用证据抽屉同一套 _ev-* 视觉） */}
            {srcIds.length > 0 && (
              <div className="_ev-drawer">
                <button
                  type="button"
                  className="_ev-toggle"
                  aria-expanded={srcOpen}
                  onClick={() => setSrcOpen(!srcOpen)}
                >
                  {srcOpen ? '▾' : '▸'} 查看原话（{srcIds.length} 条）
                </button>
                {srcOpen && (
                  <div className="_ev-list">
                    <div className="_ev-state">该记忆抽取自这些原始消息（按发生顺序）</div>
                    {srcError && (
                      <div className="_ev-state _ev-state--error">读取失败：{srcError}</div>
                    )}
                    {!srcError && srcItems === null && <div className="_ev-state">读取中…</div>}
                    {!srcError && srcItems !== null && srcItems.length === 0 && (
                      <div className="_ev-state">
                        无匹配原始消息（可能已删除，或超出本租户可见范围）
                      </div>
                    )}
                    {srcItems?.map((s) => (
                      <div key={s.id} className="_ev-item">
                        <div className="_ev-item-head">
                          <span className="_ev-item-type">[{s.role}]</span>
                          <span>{timeText(s.timestamp)}</span>
                          <span className="_ev-item-id">{s.id}</span>
                        </div>
                        <div className="_ev-item-content">{s.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* P1-T7：人工重要度调整（追加语义；≤4 召回降权）。
                P0（task-10）：Owner-only 写入口——非本人资产不渲染该表单（真正的归属判定
                在 BFF：asset/get → 非 owner 403 NOT_ASSET_OWNER；此处与下方敏感度门同款，
                canEdit 由 BlockDetail 传入，undefined = 不猜归属、交给 BFF 兜底）。 */}
            {canEdit !== false && (
              <div
                className="_imp-form"
                style={{
                  marginTop: 12,
                  borderTop: '1px solid rgba(127,127,127,.25)',
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.75 }}>
                  人工重要度调整（1-10 整数；≤4 召回降权 · source=manual，不改 llm 评语）
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={impValue}
                    onChange={(e) => setImpValue(e.target.value)}
                    style={{ width: 72 }}
                    aria-label="重要度"
                  >
                    <option value="">未评</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <input
                    value={impReason}
                    onChange={(e) => setImpReason(e.target.value)}
                    placeholder="调整理由（可选，追加记录）"
                    style={{ flex: 1, minWidth: 160 }}
                    aria-label="调整理由"
                  />
                  <Button type="primary" disabled={impBusy} onClick={submitImportance}>
                    {impBusy ? '提交中…' : '调整'}
                  </Button>
                </div>
                {impMsg && (
                  <div
                    style={{ marginTop: 6, fontSize: 12, color: impMsg.ok ? '#2e7d32' : '#c62828' }}
                  >
                    {impMsg.text}
                  </div>
                )}
              </div>
            )}
            {/* A 项（2026-11-04）：解除敏感标记（显式降敏 → none）。Owner 由 BFF 把关；
                只在「确有敏感标记（非 none/unclassified）」时出现，降敏必二次确认。 */}
            {showUnmark && (
              <div
                className="_sens-form"
                style={{
                  marginTop: 12,
                  borderTop: '1px solid rgba(127,127,127,.25)',
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.75 }}>
                  敏感度控制（当前 {sensRaw}：解除后群聊/共享/外部上下文均可注入，需二次确认）
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    type="error"
                    disabled={sensBusy || !blockId}
                    onClick={submitUnmarkSensitivity}
                  >
                    {sensBusy ? '处理中…' : '解除敏感标记 → none'}
                  </Button>
                  {!blockId && (
                    <span style={{ fontSize: 12, color: '#c62828' }}>
                      缺少 block 上下文，无法操作
                    </span>
                  )}
                </div>
                {sensMsg && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: sensMsg.ok ? '#2e7d32' : '#c62828',
                    }}
                  >
                    {sensMsg.text}
                  </div>
                )}
              </div>
            )}
            {/* P1-T8：标记失效 / 撤销失效（软失效不删记忆；失效后两路召回均排除）。
                P0（task-10）：Owner-only 写入口——失效会从两路召回里摘掉这条记忆，
                不能让只读访问者一键生效；非本人资产不渲染（BFF 仍做 403 兜底）。 */}
            {canEdit !== false && (
              <div
                className="_inv-form"
                style={{
                  marginTop: 12,
                  borderTop: '1px solid rgba(127,127,127,.25)',
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.75 }}>
                  失效控制（软失效不删记忆：失效后两路召回均排除；撤销失效即恢复）
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {invalidatedNow ? (
                    <span style={{ fontSize: 12, color: '#c62828' }}>
                      当前状态：已失效{hasVe ? `（valid_end=${veRaw}）` : ''}
                    </span>
                  ) : hasVe ? (
                    <span style={{ fontSize: 12, opacity: 0.6 }}>
                      当前状态：有效（valid_end={veRaw}，未到期）
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, opacity: 0.6 }}>当前状态：有效</span>
                  )}
                  {hasVe ? (
                    <Button disabled={invBusy} onClick={() => submitInvalidate('restore')}>
                      {invBusy ? '处理中…' : '撤销失效'}
                    </Button>
                  ) : (
                    <Button
                      type="error"
                      disabled={invBusy}
                      onClick={() => submitInvalidate('invalidate')}
                    >
                      {invBusy ? '处理中…' : '标记失效'}
                    </Button>
                  )}
                </div>
                {invMsg && (
                  <div
                    style={{ marginTop: 6, fontSize: 12, color: invMsg.ok ? '#2e7d32' : '#c62828' }}
                  >
                    {invMsg.text}
                  </div>
                )}
              </div>
            )}
            {evIds.length > 0 && (
              <div className="_ev-drawer">
                <button
                  type="button"
                  className="_ev-toggle"
                  aria-expanded={evOpen}
                  onClick={() => setEvOpen(!evOpen)}
                >
                  {evOpen ? '▾' : '▸'} 证据源（{evIds.length} 条）
                </button>
                {evOpen && (
                  <div className="_ev-list">
                    {evError && (
                      <div className="_ev-state _ev-state--error">读取失败：{evError}</div>
                    )}
                    {!evError && evItems === null && <div className="_ev-state">读取中…</div>}
                    {!evError && evItems !== null && evItems.length === 0 && (
                      <div className="_ev-state">无匹配源记录（可能已物理清理）</div>
                    )}
                    {evItems?.map((s) => (
                      <div key={String(s.record_id ?? s.id ?? '')} className="_ev-item">
                        <div className="_ev-item-head">
                          <span className="_ev-item-type">{String(s.type ?? '')}</span>
                          {s.archived ? <span className="_ev-archived">已归档</span> : null}
                          <span className="_ev-item-id">{String(s.record_id ?? '')}</span>
                        </div>
                        <div className="_ev-item-content">{String(s.content ?? '')}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            <button type="button" className="_nb-pathlink" onClick={handleCopy}>
              {copied ? '已复制 ✓' : '复制 JSON'}
            </button>
            <Button type="primary" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
