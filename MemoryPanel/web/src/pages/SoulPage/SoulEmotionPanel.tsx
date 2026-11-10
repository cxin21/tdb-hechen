/**
 * SoulEmotionPanel —— 「情绪明细」只读表（阶段 3 / P3-E，task-37）。
 *
 * 回答一个问题：**系统这段时间到底给谁、因为什么、存下了哪些情绪**。
 * 数据来自 BFF GET /api/v1/soul/emotions（上游 Core GET /v3/soul/emotions），纯读。
 *
 * 两条诚实边界（与 InjectionHealthBar 同款）：
 *   1) 除时间外每个字段都可能缺（agency/confidence/objectPerson 是阶段 3 新列，
 *      旧行没有）。缺就是「这段不渲染」，**不补 0、不写 undefined**：
 *      强度为 null 时不当成 0，归因不明时不猜。
 *   2) 漏斗只有六档齐了才渲染（BFF 侧缺一档即整段 null），半份漏斗比没有更容易被误读。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchSoulEmotions,
  type SoulEmotionRow,
  type SoulEmotionsPayload,
} from '@/lib/api/chat-memory-soul';

type PanelState =
  | { status: 'loading' }
  | { status: 'ok'; data: SoulEmotionsPayload }
  | { status: 'failed'; message: string };

const REL_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** 相对时间：本地化（numeric:'auto' → 「3 分钟前」/「3 minutes ago」）。 */
function relativeTime(iso: string, locale: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffSec = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, sec] of REL_UNITS) {
    if (abs >= sec) return rtf.format(Math.round(diffSec / sec), unit);
  }
  return rtf.format(Math.round(diffSec / 60), 'minute');
}

/** agency 是 Core 的固定枚举；未知值当「不明」，不把原始 code 甩给用户。 */
const AGENCY_WORD_INDEX: Record<string, number> = { self: 0, other: 1, environment: 2 };

function numText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  return v.toFixed(2);
}

function agencyWord(words: string[], agency: string | null): string {
  if (!agency) return '';
  const idx = AGENCY_WORD_INDEX[agency];
  return idx === undefined ? '' : (words[idx] ?? '');
}

/** 强度段：「0.40 → 0.31」；只有一边时只显示那边，都没有则整段空白。 */
function strengthText(row: SoulEmotionRow): string {
  const raw = numText(row.intensity);
  const decayed = numText(row.decayedIntensity);
  if (raw && decayed) return `${raw} → ${decayed}`;
  return raw || decayed;
}

export function SoulEmotionPanel(props: {
  teamId: string;
  agentId?: string;
  userId?: string;
}) {
  const { teamId, agentId, userId } = props;
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  const load = useCallback(async () => {
    if (!teamId) {
      setState({ status: 'ok', data: { rows: [], funnel: null } });
      return;
    }
    try {
      const data = await fetchSoulEmotions({
        teamId,
        agentId: agentId || undefined,
        userId: userId || undefined,
        limit: 50,
      });
      setState({ status: 'ok', data });
    } catch (err) {
      setState({
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [teamId, agentId, userId]);

  useEffect(() => {
    void load();
    // 情绪只在维护 tick 里落库，60s 重取足够；页面开着也不会看不到新行。
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const data = state.status === 'ok' ? state.data : null;
  const rows = data?.rows ?? [];
  const funnel = data?.funnel ?? null;
  const agencyWords = t('soul.emotions.agencyWords').split('|');

  const funnelLine = funnel
    ? t('soul.emotions.funnelLine', {
        candidate: funnel['emotion:candidate'],
        objectOk: funnel['emotion:object_ok'],
        appraised: funnel['emotion:appraised'],
        anchorHit: funnel['emotion:anchor_hit'],
        intensityOk: funnel['emotion:intensity_ok'],
        committed: funnel['emotion:committed'],
      })
    : '';

  return (
    <section className="_soul-section _soul-emo" id="_soul-sec-emotions">
      <div className="_soul-section-head">
        <div className="_soul-section-title">{t('soul.emotions.title')}</div>
        {funnelLine ? <div className="_soul-meta _soul-emo-funnel">{funnelLine}</div> : null}
      </div>

      {state.status === 'loading' ? (
        <div className="_soul-empty">…</div>
      ) : state.status === 'failed' ? (
        <div className="_soul-empty">
          {t('soul.emotions.failed')} · {state.message}
        </div>
      ) : rows.length === 0 ? (
        <div className="_soul-empty">{t('soul.emotions.empty')}</div>
      ) : (
        <div className="_soul-emo-tablewrap">
          <table className="_soul-emo-table">
            <thead>
              <tr>
                <th className="_soul-emo-th-time">{t('soul.emotions.col.time')}</th>
                <th>{t('soul.emotions.col.what')}</th>
                <th className="_soul-emo-th-num">{t('soul.emotions.col.strength')}</th>
                <th className="_soul-emo-th-num">{t('soul.emotions.col.meta')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const when = row.at ? relativeTime(row.at, i18n.language) : '';
                const objectText = row.object || row.objectPerson || '';
                const meta = [agencyWord(agencyWords, row.agency), numText(row.confidence)]
                  .filter((x) => x.length > 0)
                  .join(' · ');
                return (
                  <tr key={`${row.at ?? ''}-${i}`}>
                    <td className="_soul-emo-td-time" title={row.at ?? undefined}>
                      {when}
                    </td>
                    <td>
                      {row.label ? (
                        <span className="_soul-emo-label">{row.label}</span>
                      ) : null}
                      {objectText ? (
                        <span className="_soul-emo-object">{objectText}</span>
                      ) : row.label ? null : (
                        <span className="_soul-emo-object">
                          {t('soul.emotions.noObject')}
                        </span>
                      )}
                    </td>
                    <td className="_soul-emo-td-num">{strengthText(row)}</td>
                    <td className="_soul-emo-td-num">{meta}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
