/**
 * CardView —— 人格卡只读视图（S2 读面，2026-11-07）。
 *
 * 这是「注入出去的那张卡」本身：与 dsh-plugin 每轮拿到的通道 A 文本同源
 * （内核 assembleSoulCard({persist:false})，见 MemoryCore/src/gateway/soul-card-endpoint.ts:40）。
 *
 * 三条显示纪律（判据 12 / 验收口径）：
 *   1. 卡文本**原样**进 <pre>：卡自带 [读法] 段与 ### 区块标题，前端不改写、不截断、
 *      不把轴名/区块名当高亮锚点，也不补任何"更友好"的措辞——读者看到的必须是模型看到的。
 *   2. 读侧不出现六轴英文名，也不出现取值方式一类字眼；底色只在折叠区以中文特质词
 *      （labels[].label）列示，act 保留一位小数，不解释它是怎么算出来的。
 *   3. 内核 warnings 原样列示（如"底色为空：没有达阈值的标签"），不做无声降级——
 *      「看到一张不完整的卡」必须能被解释。
 *
 * 为什么 props 收 teamId/agentId/userId 而不是 blockId：与 SoulVersionChain 同理，
 * blockId = `chat_memory-{team}-{agent}` 不可逆；tenant 三轴本来就是调用方手里的值。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchSoulCard, type SoulCardPayload } from '@/lib/api/chat-memory-soul';
import { getErrorMessage } from '@/lib/error-message';

/** 区块键 → 中文块名（内核 CARD_BLOCK_TITLES 的只读镜像；未知键丢弃，避免英文泄漏到读侧）。 */
const BLOCK_TITLES: Record<string, string> = {
  name: '名称',
  image: '形象',
  voice: '说话方式',
  purpose: '使命',
  traits: '底色',
  redlines: '红线',
  human: '关于你',
  relationship: '关系',
  selfHistory: '自我史',
  autobiography: '自传',
  openLoops: '未完的事',
};

/** 展示顺序与卡内区块顺序一致（CARD_BLOCK_ORDER）。 */
const BLOCK_ORDER = [
  'name',
  'image',
  'voice',
  'purpose',
  'traits',
  'redlines',
  'human',
  'relationship',
  'selfHistory',
  'autobiography',
  'openLoops',
];

/** 三方来源图例：这是"这条内容是哪儿来的"的读侧解释，不是取值方式的说明。 */
const SOURCE_LEGEND: Array<{ key: string; text: string }> = [
  { key: 'declared', text: '你设定的' },
  { key: 'derived', text: '推出来的' },
  { key: 'observed', text: '经历里长出来的' },
];

function sourceRows(sources: Record<string, string>): Array<{ key: string; title: string; source: string }> {
  const rows: Array<{ key: string; title: string; source: string }> = [];
  for (const key of BLOCK_ORDER) {
    const title = BLOCK_TITLES[key];
    const source = sources[key];
    if (title && source) rows.push({ key, title, source });
  }
  return rows;
}

export function CardView(props: { teamId: string; agentId: string; userId?: string }) {
  const { teamId, agentId, userId } = props;
  const [payload, setPayload] = useState<SoulCardPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!teamId || !agentId) {
      setPayload(null);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchSoulCard({ teamId, agentId, ...(userId ? { userId } : {}) })
      .then((res) => {
        if (cancelled) return;
        setPayload(res);
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPayload(null);
        // 503 soul_card_unavailable / soul_card_failed 等后端 message 原样露出，不伪装成空卡。
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, agentId, userId]);

  const sources = useMemo(() => sourceRows(payload?.sources ?? {}), [payload]);

  if (loading) {
    return (
      <section className="_soul-section" id="_soul-sec-card" aria-label="人格卡">
        <div className="_soul-section-head">
          <span className="_soul-section-title">人格卡</span>
        </div>
        <div className="_soul-meta">加载中…</div>
      </section>
    );
  }

  return (
    <section className="_soul-section" id="_soul-sec-card" aria-label="人格卡">
      <div className="_soul-section-head">
        <span className="_soul-section-title">人格卡</span>
        {payload && payload.dirty && (
          <span className="_soul-chip _soul-chip--gold" title="渲染结果与上一版快照不同，尚未落版">
            未落版
          </span>
        )}
        {payload && <span className="_soul-meta">注入原文</span>}
      </div>

      {error && <div className="_soul-meta">读取失败：{error}</div>}

      {!error && payload && (
        <>
          <div className="_soul-card-meta">
            <span className="_soul-chip _soul-chip--neutral" title="卡版本（team + agent 维度）">
              v{payload.version}
            </span>
            <span className="_soul-card-hash" title={payload.hash || '无哈希'}>
              {payload.hash ? payload.hash.slice(0, 8) : '无哈希'}
            </span>
            <span className="_soul-meta">{payload.chars} 字</span>
          </div>

          {payload.text.trim() ? (
            <pre className="_soul-card-pre">{payload.text}</pre>
          ) : (
            <div className="_soul-empty">这个 agent 还没有可用的人格卡文本。</div>
          )}

          {payload.warnings.length > 0 && (
            <div className="_soul-card-warn">
              {payload.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          <details className="_soul-card-sources">
            <summary className="_soul-card-sources-summary">
              字段来源与底色（{sources.length} 个区块{payload.labels.length > 0 ? ` / ${payload.labels.length} 个特质` : ''}）
            </summary>
            <div className="_soul-card-legend">
              {SOURCE_LEGEND.map((s) => (
                <span key={s.key} className="_soul-card-legend-item">
                  <code>{s.key}</code> = {s.text}
                </span>
              ))}
            </div>
            {sources.length > 0 && (
              <ul className="_soul-card-source-list">
                {sources.map((r) => (
                  <li key={r.key} className="_soul-card-source-row">
                    <span className="_soul-card-source-title">{r.title}</span>
                    <span className="_soul-card-source-value">{r.source}</span>
                  </li>
                ))}
              </ul>
            )}
            {payload.labels.length > 0 && (
              <div className="_soul-card-labels">
                {payload.labels.map((l) => (
                  <span key={l.label} className="_soul-chip _soul-chip--neutral" title={l.gloss ?? ''}>
                    {l.label} {l.act.toFixed(1)}
                  </span>
                ))}
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
