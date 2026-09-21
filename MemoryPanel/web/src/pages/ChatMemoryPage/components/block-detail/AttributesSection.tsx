/**
 * AttributesSection —— L1 记忆属性表（UI 2.0 Phase 2，拍板③；spec §4.1 十九列对齐）。
 *
 * 数据源：/chat-memory/layer|search 出参（896ee5d soul 字段 + Phase 2 BFF 补透传
 * task_id/team_id/user_id/agent_id/version/updated_at + D-0（2026-09-21）补透传
 * scene_name/priority/session_key/session_id/timestamp_str/start/end——内核
 * atomic-query-fields.ts 单一源已补齐七字段，全列呈现）。折叠段默认收起；
 * 「复制 JSON」导出全部在场属性。
 */
import { useMemo, useState } from 'react';
import type { ChatMemoryLayerItem } from '@/lib/api/chat-memory';

type Row = { k: string; v: string };

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function AttributesSection({ item }: { item: ChatMemoryLayerItem }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const out: Row[] = [];
    const push = (k: string, v: unknown) => {
      const s = str(v);
      if (s !== null) out.push({ k, v: s });
    };
    push('id', item.id);
    push('type', item.title);
    push('occurred_at', item.occurred_at);
    push('valid_start', item.valid_start);
    push('valid_end', item.valid_end);
    push('certainty', item.certainty);
    push('source', item.source);
    push('valence', item.valence);
    push('arousal', item.arousal);
    push('significance', item.significance);
    push('version', item.version);
    push('team_id', item.team_id);
    push('user_id', item.user_id);
    push('agent_id', item.agent_id);
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
    // D-3：敏感性枚举（none/health/finance/relationship）
    push('sensitivity', item.sensitivity);
    push('recall_count', meta.recall_count);
    push('last_recalled_at', meta.last_recalled_at);
    push('subject', meta.subject);
    const eids = meta.evidence_ids;
    push('evidence_ids', Array.isArray(eids) ? (eids as unknown[]).join('、') : eids);
    const evo = meta.evolution as { from?: unknown; reason?: unknown } | null | undefined;
    if (evo && typeof evo === 'object') {
      push('evolution.from', Array.isArray(evo.from) ? (evo.from as unknown[]).join('、') : evo.from);
      push('evolution.reason', evo.reason);
    }
    return out;
  }, [item]);

  if (rows.length === 0) return null;

  function handleCopy() {
    const payload: Record<string, unknown> = {
      id: item.id, type: item.title, occurred_at: item.occurred_at,
      valid_start: item.valid_start, valid_end: item.valid_end,
      certainty: item.certainty, source: item.source,
      valence: item.valence, arousal: item.arousal, significance: item.significance,
      version: item.version, team_id: item.team_id, user_id: item.user_id,
      agent_id: item.agent_id, task_id: item.task_id,
      scene_name: item.scene_name, priority: item.priority,
      session_key: item.session_key, session_id: item.session_id,
      timestamp_str: item.timestamp_str, timestamp_start: item.timestamp_start,
      timestamp_end: item.timestamp_end,
      created_at: item.created_at, updated_at: item.updated_at, metadata: item.metadata,
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
      <button type="button" className="_soul-chip _soul-chip--attrs" onClick={() => setOpen((v) => !v)}>
        🧬 属性{open ? '' : ` (${rows.length})`}
      </button>
      {open && (
        <div className="_attr-table">
          {rows.map((r) => (
            <div key={r.k} className="_attr-row">
              <span className="_attr-key" title={r.k}>{r.k}</span>
              <span className="_attr-val" title={r.v}>{r.v}</span>
            </div>
          ))}
          <div className="_attr-actions">
            <button type="button" className="_nb-pathlink" onClick={handleCopy}>
              {copied ? '已复制 ✓' : '复制 JSON'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
