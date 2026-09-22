/**
 * PersonSection —— 人物锚专视图（D-2 + UI 2.1 P0 重排，设计师方案 §4.4）。
 *
 * 单卡行列表（soft 分隔线，行 hover）+ 32px 头像圆 + role/方向/aliases/w 迷你条 +
 * 证据链折叠态计数（「证据链 · 37」——C11 判据：折叠态可见条数）+ 展开时间轴
 * （默认 10 条 +「展开其余 n 条」）。正文过 maskSecrets（V-02 P0 凭据掩码）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi } from '@/lib/teamApi';
import {
  buildPersonRows,
  directionLabel,
  collectPersonEvidence,
  maskSecrets,
  type PersonRow,
  type PersonEvidenceItem,
} from './person-view';

const EVIDENCE_PAGE = 10;

export function PersonSection(props: { blockId: string; highlight?: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState<Record<string, PersonEvidenceItem[]>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [evidenceLimit, setEvidenceLimit] = useState<Record<string, number>>({});
  // 任务6② P1：证据链折叠计数预取——rows 到位后逐行预取（与展开共用缓存）。
  const prefetchedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!props.blockId) { setRows([]); setLoaded(true); return; }
    try {
      const res = await chatMemoryApi.valuesList(props.blockId);
      const parsed = buildPersonRows((res.values ?? []) as unknown as Array<Record<string, unknown>>);
      parsed.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      setRows(parsed);
    } catch { setRows([]); }
    finally { setLoaded(true); }
  }, [props.blockId]);

  useEffect(() => { void load(); }, [load]);

  // chips 点击定位：highlight 命中人物 → 自动展开证据链 + 滚动定位（C12：≤1 次交互可达）
  useEffect(() => {
    if (!props.highlight || rows.length === 0) return;
    const hit = rows.find((r) => r.label === props.highlight);
    if (hit && !expanded.has(hit.value_id)) {
      void toggleEvidence(hit);
      window.setTimeout(() => {
        document.getElementById(`person-${CSS.escape(hit.label)}`)?.scrollIntoView({ block: 'center' });
      }, 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.highlight, rows]);

  /** 证据链取证（预取与展开共用同一缓存；失败置空数组=诚实空态）。 */
  // P1（任务6②）：折叠态计数预取——prefetchedRef 防重；失败由 fetchEvidence 落空态。
  useEffect(() => {
    if (!loaded || !props.blockId || rows.length === 0) return;
    for (const r of rows) {
      if (prefetchedRef.current.has(r.value_id)) continue;
      prefetchedRef.current.add(r.value_id);
      void fetchEvidence(r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, rows, props.blockId]);

  async function fetchEvidence(row: PersonRow) {
    setEvidenceLoading((prev) => new Set(prev).add(row.value_id));
    try {
      const queries = [row.label, ...row.aliases];
      const all = await Promise.all(queries.map((q) => chatMemoryApi.searchLayer(props.blockId, 'L1', q, 30)));
      const merged: Array<Record<string, unknown>> = [];
      for (const r of all) merged.push(...((r.items ?? []) as unknown as Array<Record<string, unknown>>));
      const ev = collectPersonEvidence(merged, queries);
      setEvidence((prev) => ({ ...prev, [row.value_id]: ev }));
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

  async function toggleEvidence(row: PersonRow) {
    if (evidence[row.value_id] || evidenceLoading.has(row.value_id)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(row.value_id)) next.delete(row.value_id); else next.add(row.value_id);
        return next;
      });
      return;
    }
    await fetchEvidence(row);
    setExpanded((prev) => new Set(prev).add(row.value_id));
  }

  if (!loaded) return null;
  if (rows.length === 0) return null;

  return (
    <section className="_soul-section" aria-label={t('soul.person.title')} id="_soul-person-section">
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.person.title')}</span>
        <span className="_soul-chip _soul-chip--person">{rows.length}</span>
      </div>
      <div className="_soul-personcard">
        {rows.map((r) => {
          const d = directionLabel(r.valence);
          const isOpen = expanded.has(r.value_id);
          const ev = evidence[r.value_id];
          const loading = evidenceLoading.has(r.value_id);
          const err = failed.has(r.value_id);
          const limit = evidenceLimit[r.value_id] ?? EVIDENCE_PAGE;
          const shown = ev ? ev.slice(0, limit) : [];
          const firstChar = r.label ? r.label.slice(0, 1) : '?';
          return (
            <div
              key={r.value_id}
              className={`_soul-personrow${props.highlight === r.label ? ' _soul-personrow--highlight' : ''}`}
              id={`person-${CSS.escape(r.label)}`}
            >
              <div className="_soul-personrow-head">
                <span className="_soul-avatar" aria-hidden>{firstChar}</span>
                <span className="_soul-personrow-name">{r.label}</span>
                {r.role && <span className="_soul-chip _soul-chip--neutral">{r.role}</span>}
                {d && <span className={`_soul-chip _soul-chip--${d === '回避' ? 'red' : d === '趋近' ? 'green' : 'neutral'}`}>{d}</span>}
                {r.aliases.length > 0 && (
                  <span className="_soul-meta _soul-personrow-aliases">别名：{r.aliases.join('、')}</span>
                )}
                <span className="_soul-wmeter" title="信念强度（F5 绝对证据+饱和）">
                  <span className="_soul-wbar"><span className="_soul-wbar-fill" style={{ width: `${Math.round((r.weight ?? 0) * 100)}%` }} /></span>
                  <span className="_soul-meta">w {(r.weight ?? 0).toFixed(2)}</span>
                </span>
                <button type="button" className="_soul-btn-ghost _soul-personrow-toggle" onClick={() => void toggleEvidence(r)}>
                  {loading ? t('soul.person.loading') : isOpen ? t('soul.person.collapse') : `${t('soul.person.expand')} · ${ev ? ev.length : '…'}`}
                </button>
              </div>
              {isOpen && (
                <div className="_soul-evidence">
                  {err && <div className="_soul-meta">{t('soul.person.failed')}</div>}
                  {ev && ev.length === 0 && <div className="_soul-meta">{t('soul.person.empty')}</div>}
                  {ev && ev.length > 0 && (
                    <>
                      <ul className="_soul-timeline">
                        {shown.map((e) => (
                          <li key={e.id} className="_soul-timeline-row" title={e.id}>
                            <span className="_soul-timeline-dot" aria-hidden />
                            <div className="_soul-timeline-main">
                              <div className="_soul-timeline-meta">
                                {e.occurredAt && <span>{e.occurredAt.slice(0, 10)}</span>}
                                {e.certainty && <span>{e.certainty === 'inferred' ? '推断' : '实见'}</span>}
                                <span>L1</span>
                              </div>
                              <div className="_soul-timeline-body">{maskSecrets(e.body)}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {ev.length > shown.length && (
                        <button type="button" className="_soul-idcard-toggle" onClick={() => setEvidenceLimit((prev) => ({ ...prev, [r.value_id]: limit + 20 }))}>
                          展开其余 {ev.length - shown.length} 条
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
