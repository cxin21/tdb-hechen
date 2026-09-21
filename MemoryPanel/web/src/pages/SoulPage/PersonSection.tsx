/**
 * PersonSection —— 人物锚专视图（D-2，2026-09-21；spec §2.6/S6 + P2 硬令"设计有的全部可见"）。
 *
 * 每人物一卡：徽标（人物）+ label + role·方向徽标 + aliases + 证据链展开
 * （label+aliases 反查 → personRefs 命中过滤 → record_id 去重 → L1 行列表——
 * 溯源到具体 L1 行）。纯前端透传零新端点（valuesList + searchLayer 既有出参）。
 * highlight：SoulSection 人物 chips 点击跳转 /soul 的定位目标（hash person-<label>）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi } from '@/lib/teamApi';
import {
  buildPersonRows,
  directionLabel,
  collectPersonEvidence,
  type PersonRow,
  type PersonEvidenceItem,
} from './person-view';

export function PersonSection(props: { blockId: string; highlight?: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState<Record<string, PersonEvidenceItem[]>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!props.blockId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    try {
      const res = await chatMemoryApi.valuesList(props.blockId);
      const parsed = buildPersonRows((res.values ?? []) as unknown as Array<Record<string, unknown>>);
      // weight DESC（与 soul-assembler「重要的人」行同序）
      parsed.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      setRows(parsed);
    } catch {
      setRows([]);
    } finally {
      setLoaded(true);
    }
  }, [props.blockId]);

  useEffect(() => {
    void load();
  }, [load]);

  // chips 点击定位：highlight 命中的人物自动展开证据链并滚动到卡
  useEffect(() => {
    if (!props.highlight || rows.length === 0) return;
    const hit = rows.find((r) => r.label === props.highlight);
    if (hit) {
      setExpanded((prev) => new Set(prev).add(hit.value_id));
      void toggleEvidence(hit);
      window.setTimeout(() => {
        document.getElementById(`person-${CSS.escape(hit.label)}`)?.scrollIntoView({ block: 'center' });
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.highlight, rows]);

  async function toggleEvidence(row: PersonRow) {
    if (evidence[row.value_id] || evidenceLoading.has(row.value_id)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(row.value_id)) next.delete(row.value_id);
        else next.add(row.value_id);
        return next;
      });
      return;
    }
    setEvidenceLoading((prev) => new Set(prev).add(row.value_id));
    try {
      const queries = [row.label, ...row.aliases];
      const all = await Promise.all(queries.map((q) => chatMemoryApi.searchLayer(props.blockId, 'L1', q, 30)));
      const merged: Array<Record<string, unknown>> = [];
      for (const r of all) merged.push(...((r.items ?? []) as unknown as Array<Record<string, unknown>>));
      const ev = collectPersonEvidence(merged, queries);
      setEvidence((prev) => ({ ...prev, [row.value_id]: ev }));
      setExpanded((prev) => new Set(prev).add(row.value_id));
    } catch {
      setEvidence((prev) => ({ ...prev, [row.value_id]: [] }));
      setFailed((prev) => new Set(prev).add(row.value_id));
    } finally {
      setEvidenceLoading((prev) => {
        const next = new Set(prev);
        next.delete(row.value_id);
        return next;
      });
    }
  }

  if (!loaded) return null;
  if (rows.length === 0) return null;

  return (
    <section className="_soul-card" aria-label={t('soul.person.title')} id="_soul-person-section">
      <div className="_soul-card-title">{t('soul.person.title')}</div>
      {rows.map((r) => {
        const d = directionLabel(r.valence);
        const isOpen = expanded.has(r.value_id);
        const ev = evidence[r.value_id];
        const loading = evidenceLoading.has(r.value_id);
        const err = failed.has(r.value_id);
        return (
          <div
            key={r.value_id}
            className={`_soul-person${props.highlight === r.label ? ' _soul-person--highlight' : ''}`}
            id={`person-${CSS.escape(r.label)}`}
          >
            <div className="_soul-person-head">
              <span className="_soul-chip _soul-chip--person">👥 人物</span>
              <span className="_soul-person-name">{r.label}</span>
              {r.role && <span className="_soul-chip" title="关系角色">{r.role}</span>}
              {d && <span className={`_soul-chip _soul-person-dir--${d}`}>{d}</span>}
              {r.aliases.length > 0 && (
                <span className="_soul-chip" title="别名（证据重算并入）">{r.aliases.join('、')}</span>
              )}
              {typeof r.weight === 'number' && (
                <span className="_soul-chip" title="信念强度（F5 绝对证据+饱和）">w {r.weight.toFixed(2)}</span>
              )}
              <button
                type="button"
                className="_nb-pathlink"
                onClick={() => void toggleEvidence(r)}
              >
                {loading ? t('soul.person.loading') : isOpen && ev ? t('soul.person.collapse') : t('soul.person.expand')}
              </button>
            </div>
            {isOpen && (
              <div className="_soul-person-evidence">
                {err && <div className="_soul-muted">{t('soul.person.failed')}</div>}
                {ev && ev.length === 0 && <div className="_soul-muted">{t('soul.person.empty')}</div>}
                {ev && ev.length > 0 && ev.map((e) => (
                  <div key={e.id} className="_soul-person-evidence-row" title={e.id}>
                    <span className="_soul-person-evidence-time">{e.occurredAt ? e.occurredAt.slice(0, 10) : '—'}</span>
                    {e.certainty && <span className="_soul-chip">{e.certainty === 'inferred' ? '推断' : '实见'}</span>}
                    <span className="_soul-person-evidence-body">{e.body}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
