/**
 * InjectionHealthBar —— 「注入健康」只读状态条（P0-D，task-17）。
 *
 * 回答一个问题：**人格卡到底有没有被读进去**。数据来自 BFF
 * GET /api/v1/soul/injection-stats（上游 Core GET /v3/soul/injection/stats），
 * 纯读：统计 recall-journal 里近 24h 真正注入的轮数与体积、以及宿主上报的失败原因。
 *
 * 三态判定（口径写在 BFF 注释里，这里不改写语义）：
 *   - note === 'journal_disabled' 或 rows === 0 → 无数据
 *   - failReasons 非 null 且任一计数 > 0 → 降级
 *   - 其余 → 正常
 *
 * 两条诚实边界：
 *   1) 服务端 lastCard / lastVolatile / failReasons 为 null 是「算不出 / 没上报」，
 *      不是 0——本组件**不补 0**：lastCard 为 null 时「卡 v<hash>」整段不出现；
 *      failReasons 为 null 时说「暂无失败上报」，绝不说「0 次失败」。
 *   2) 契约里没有「去重跳过次数」的聚合字段（只有 lastVolatile.skipped 布尔），
 *      所以这里只能标「最近一次已跳过」，给不出 N 次。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchSoulInjectionStats,
  type SoulInjectionStatsPayload,
} from '@/lib/api/chat-memory-soul';

type HealthState =
  | { status: 'loading' }
  | { status: 'ok' | 'degraded' | 'noData'; data: SoulInjectionStatsPayload }
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

function failDetailText(data: SoulInjectionStatsPayload): string {
  const fr = data.failReasons;
  if (!fr) return '';
  const parts: string[] = [];
  if (fr.http_status > 0) parts.push(`http_status ${fr.http_status}`);
  if (fr.timeout > 0) parts.push(`timeout ${fr.timeout}`);
  if (fr.empty > 0) parts.push(`empty ${fr.empty}`);
  if (fr.parse > 0) parts.push(`parse ${fr.parse}`);
  // 对账口径：召回行与注入行同会话但字符数不同（不是失败计数，但同属「读进去的不一致」）。
  if (data.pairs.matched > 0 && data.pairs.charMismatch > 0) {
    parts.push(`char_mismatch ${data.pairs.charMismatch}/${data.pairs.matched}`);
  }
  return parts.join(' · ');
}

export function InjectionHealthBar({
  teamId,
  agentId,
  userId,
}: {
  teamId: string;
  agentId: string;
  userId: string;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<HealthState>({ status: 'loading' });

  const load = useCallback(async () => {
    if (!teamId) {
      // 没有团队轴时不去猜 "default"：拿错团队的统计比没有更糟。
      setState({ status: 'failed', message: '' });
      return;
    }
    try {
      const data = await fetchSoulInjectionStats({
        teamId,
        agentId: agentId || undefined,
        userId: userId || undefined,
        hours: 24,
      });
      const failed = data.failReasons
        ? Object.values(data.failReasons).some((n) => n > 0)
        : false;
      const noData = data.note === 'journal_disabled' || data.rows === 0;
      setState({
        status: noData ? 'noData' : failed ? 'degraded' : 'ok',
        data,
      });
    } catch (err) {
      setState({
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [teamId, agentId, userId]);

  useEffect(() => {
    void load();
    // 宿主每次对话都会写日志；60s 重取一次，页面开着也能看到最新一轮。
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const label =
    state.status === 'ok'
      ? t('soul.health.ok')
      : state.status === 'degraded'
        ? t('soul.health.degraded')
        : state.status === 'loading'
          ? '…'
          : t('soul.health.noData');

  const data = 'data' in state ? state.data : null;
  const failTotal = data?.failReasons
    ? Object.values(data.failReasons).reduce((a, b) => a + b, 0)
    : 0;
  const failDetail = data ? failDetailText(data) : '';

  /**
   * 窗口内 volatile 计数（injected / skipped）。旧 Core 没有这个字段、或字段不是有限数时
   * 视为「该字段无数据」：整段不渲染——不冒充 0，也不让 NaN/undefined 漏到屏幕上。
   */
  const volatileCounts =
    data &&
    data.volatileCounts &&
    Number.isFinite(data.volatileCounts.injected) &&
    Number.isFinite(data.volatileCounts.skipped)
      ? data.volatileCounts
      : null;

  return (
    <section
      className={`_soul-health _soul-health--${state.status}`}
      aria-label={label}
      aria-live="polite"
    >
      <span className="_soul-health-label">{label}</span>

      {state.status === 'failed' ? (
        // 读取失败就把上游 message 原样摆出来（技术文案好过假装「还没注入」）；
        // 没有 message（未选团队/Agent）时用破折号，不编造原因。
        <span className="_soul-health-empty" title={state.message || undefined}>
          {state.message || '—'}
        </span>
      ) : null}

      {state.status === 'noData' && data ? (
        <span className="_soul-health-empty">{t('soul.health.empty')}</span>
      ) : null}

      {(state.status === 'ok' || state.status === 'degraded') && data ? (
        <>
          {data.lastAt ? (
            <span className="_soul-health-meta">
              {t('soul.health.last', {
                time: relativeTime(data.lastAt, i18n.language || 'zh-CN'),
              })}
            </span>
          ) : null}

          {data.lastCard ? (
            <span
              className="_soul-health-meta"
              title={
                data.lastVolatile
                  ? `${data.lastVolatile.hash} · ${data.lastVolatile.chars}`
                  : undefined
              }
            >
              {t('soul.health.card', {
                version: data.lastCard.version,
                hash: data.lastCard.hash,
                chars: data.lastCard.chars,
              })}
            </span>
          ) : null}

          {volatileCounts ? (
            <span className="_soul-health-meta">
              {volatileCounts.skipped > 0
                ? t('soul.health.volatileCounts', {
                    injected: volatileCounts.injected,
                    skipped: volatileCounts.skipped,
                  })
                : t('soul.health.volatileNone', {
                    injected: volatileCounts.injected,
                  })}
            </span>
          ) : data.lastVolatile?.skipped ? (
            // 旧 Core 没有聚合计数：只保留「最近一次被去重跳过」这一个事实，不编造 N。
            <span className="_soul-health-skip">{t('memory.journal.skippedBadge')}</span>
          ) : null}

          {data.failReasons === null ? (
            <span className="_soul-health-meta">{t('soul.health.noFailReport')}</span>
          ) : failTotal > 0 ? (
            <span
              className="_soul-health-fail"
              title={failDetail || undefined}
            >
              {t('soul.health.fail', { count: failTotal })}
            </span>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
