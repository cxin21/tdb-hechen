/**
 * SoulVersionChain —— 灵魂版本链 / 漂移审计（task-3，缺口 A 二期：把内核已落地的
 * soul_snapshots 版本链做成运维可见视图）。
 *
 * 数据：BFF /api/v1/chat-memory/soul-versions → 内核 /v3/soul/introspect（只读、零写入）。
 *
 * 两条硬约束（照生产事实设计，不是防御性猜测）：
 *   1. 生产库（2026-11-04）soul_snapshots 仍无 version/parent_hash/reason_detail 列，
 *      trigger 恒 'render'、content_hash 8 字符。此时每行显示「旧快照」徽标 + trigger 原文，
 *      **不编造版本序号**；整段全部为旧快照时给一条解释性降级提示。
 *   2. 内核返回 notes（如 snapshot-surface-unavailable / rendered-truncated）时原文列示，
 *      不做无声降级——"看不到"必须能被解释。
 *
 * 为什么 props 收 teamId/agentId 而不是只收 blockId：blockId = `chat_memory-{team}-{agent}`
 * 不可逆解析（team_id 是含连字符的 uuid 时无法确定切分点）。调用方本来就有这两个轴，
 * 直接传比猜更安全。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchSoulVersions, type SoulVersionsPayload } from '@/lib/api/chat-memory-soul';
import { getErrorMessage } from '@/lib/error-message';
import { buildSoulVersionView } from './soul-version-view';

const SNAPSHOT_LIMIT = 50;

export function SoulVersionChain(props: { teamId: string; agentId: string }) {
  const { teamId, agentId } = props;
  const [payload, setPayload] = useState<SoulVersionsPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showRendered, setShowRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!teamId || !agentId) {
      setPayload(null);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchSoulVersions({ teamId, agentId, snapshotLimit: SNAPSHOT_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setPayload(res);
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPayload(null);
        // 503 soul_introspect_failed 等后端 message 原样露出（getErrorMessage 对未知码回落到原文）。
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, agentId]);

  const view = useMemo(() => buildSoulVersionView(payload), [payload]);

  if (loading) {
    return (
      <section className="_soul-section" id="_soul-sec-versions" aria-label="灵魂版本链">
        <div className="_soul-section-head">
          <span className="_soul-section-title">版本链 / 漂移审计</span>
        </div>
        <div className="_soul-meta">加载中…</div>
      </section>
    );
  }

  return (
    <section className="_soul-section" id="_soul-sec-versions" aria-label="灵魂版本链">
      <div className="_soul-section-head">
        <span className="_soul-section-title">版本链 / 漂移审计</span>
        {view.rows.length > 0 && (
          <span className={`_soul-chip ${view.legacyOnly ? '_soul-chip--neutral' : '_soul-chip--gold'}`}>
            {view.legacyOnly ? `${view.rows.length} 条旧快照` : `${view.rows.length} 版`}
          </span>
        )}
        {payload?.soulVersion && (
          <span className="_soul-meta" title="当前渲染版本标识">
            当前 {payload.soulVersion}
          </span>
        )}
      </div>

      {error && <div className="_soul-meta">读取失败：{error}</div>}
      {!error && view.legacyHint && <div className="_soul-ver-hint">{view.legacyHint}</div>}
      {!error && view.emptyText && <div className="_soul-empty">{view.emptyText}</div>}

      {!error && view.rows.length > 0 && (
        <ol className="_soul-ver-list">
          {view.rows.map((r) => (
            <li key={r.key} className="_soul-ver-row">
              <span className="_soul-ver-dot" aria-hidden />
              <div className="_soul-ver-main">
                <div className="_soul-ver-head">
                  <span className="_soul-ver-time">{r.timeText || r.at || '时间未知'}</span>
                  {r.versionText ? (
                    <span className="_soul-chip _soul-chip--green">{r.versionText}</span>
                  ) : (
                    <span className="_soul-chip _soul-chip--neutral">{r.versionBadge}</span>
                  )}
                  <span className="_soul-ver-hash" title={r.hash}>
                    {r.hashText || '无哈希'}
                  </span>
                  <span
                    className={`_soul-chip ${r.reasonIsKnown ? '_soul-chip--gold' : '_soul-chip--neutral'}`}
                    title={r.reasonIsKnown ? '受控变更原因' : '非受控枚举值（历史自由文本，原样展示）'}
                  >
                    {r.reasonText}
                  </span>
                  {r.parentHashText && <span className="_soul-meta">← {r.parentHashText}</span>}
                </div>
                {(r.slotDiffText || r.lineDiffText) && (
                  <div className="_soul-ver-diff">
                    {r.slotDiffText && (
                      <span className="_soul-meta" title="slot 增 / 删 / 改">
                        slot {r.slotDiffText}
                      </span>
                    )}
                    {r.lineDiffText && (
                      <span className="_soul-meta" title="META 块增删行数">
                        行 {r.lineDiffText}
                      </span>
                    )}
                    {r.slotSummary && <span className="_soul-ver-summary">{r.slotSummary}</span>}
                  </div>
                )}
                {r.reasonDetailText && (
                  <div className="_soul-meta">原因细节：{r.reasonDetailText}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {!error && view.notes.length > 0 && (
        <div className="_soul-ver-notes">
          {view.notes.map((n, i) => (
            <div key={i} className="_soul-ver-note">
              {n}
            </div>
          ))}
        </div>
      )}

      {!error && payload?.rendered && (
        <div className="_soul-ver-rendered">
          <button
            type="button"
            className="_soul-btn-ghost"
            aria-expanded={showRendered}
            onClick={() => setShowRendered((v) => !v)}
          >
            {showRendered ? '收起当前人设' : '展开当前人设'}
          </button>
          {showRendered && (
            <>
              <pre className="_soul-ver-pre">{payload.rendered}</pre>
              {payload.renderedTruncated && (
                <div className="_soul-meta">已截断：仅显示前 4000 字（后端 notes 有完整说明）。</div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
