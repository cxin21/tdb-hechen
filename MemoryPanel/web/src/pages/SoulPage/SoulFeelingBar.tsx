/**
 * SoulFeelingBar —— 感受状态条（UI 2.1 P0，设计师方案 §4.2；V-01 对比度整改）。
 *
 * 数据同源原 FeelingCard（valuesList → theme ∧ valence=±1，与 soul-assembler 同构）。
 * 形态从卡片降级为页头下全宽 44px 状态条；语义 pill = 深色文字 + 浅语义底
 * （文字对 chip 底 ≥4.5:1——验收 C01 判据）。超 3 个 pill 收进 +n（点击展开）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi, type ValueAnchor } from '@/lib/teamApi';
import { pickPrimeAnchor } from '../ChatMemoryPage/utils/attribute-badges';

function Pill({ label, kind }: { label: string; kind: 'pos' | 'neg' }) {
  return <span className={`_soul-pill _soul-pill--${kind}`}>{label}</span>;
}

export function SoulFeelingBar({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ValueAnchor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!blockId) { setValues([]); setLoaded(true); return; }
    try {
      const res = await chatMemoryApi.valuesList(blockId);
      setValues(res.values ?? []);
    } catch { setValues([]); }
    finally { setLoaded(true); }
  }, [blockId]);

  useEffect(() => { void load(); }, [load]);

  const directional = values.filter(
    (v) => (v.node_type ?? 'theme') === 'theme' && (v.valence === 1 || v.valence === -1),
  );
  const pos = directional.filter((v) => v.valence === 1).map((v) => v.label);
  const neg = directional.filter((v) => v.valence === -1).map((v) => v.label);
  // V6-批次二：首要锚（weight 最高选取与渲染序解耦，描述≤30字——与 soul-assembler 同构）
  const primePos = pickPrimeAnchor(values.filter((v) => v.valence === 1));
  const primeNeg = pickPrimeAnchor(values.filter((v) => v.valence === -1));
  const cap = 3;
  const posShow = showAll ? pos : pos.slice(0, cap);
  const negShow = showAll ? neg : neg.slice(0, cap);
  const hasAny = pos.length > 0 || neg.length > 0;

  return (
    <div className="_soul-feelbar" aria-label={t('soul.feeling.title')} id="_soul-sec-feeling">
      <span className="_soul-feelbar-title">{t('soul.feeling.title')}</span>
      {hasAny ? (
        <>
          {posShow.length > 0 && (
            <span className="_soul-feelgroup">
              <span className="_soul-feelgroup-label">{t('soul.feeling.pos')}</span>
              {posShow.map((l) => <Pill key={`p:${l}`} label={l} kind="pos" />)}
              {!showAll && pos.length > cap && (
                <button type="button" className="_soul-feel-more" onClick={() => setShowAll(true)}>+{pos.length - cap}</button>
              )}
              {primePos && (
                <span style={{ fontSize: 11, color: '#4338ca' }}>
                  {t('soul.feeling.prime', { label: primePos.label, desc: primePos.desc })}
                </span>
              )}
            </span>
          )}
          {negShow.length > 0 && (
            <span className="_soul-feelgroup">
              <span className="_soul-feelgroup-label">{t('soul.feeling.neg')}</span>
              {negShow.map((l) => <Pill key={`neg:${l}`} label={l} kind="neg" />)}
              {!showAll && neg.length > cap && (
                <button type="button" className="_soul-feel-more" onClick={() => setShowAll(true)}>+{neg.length - cap}</button>
              )}
              {primeNeg && (
                <span style={{ fontSize: 11, color: '#4338ca' }}>
                  {t('soul.feeling.prime', { label: primeNeg.label, desc: primeNeg.desc })}
                </span>
              )}
            </span>
          )}
        </>
      ) : (
        loaded && <span className="_soul-meta">{t('soul.feeling.empty')}</span>
      )}
    </div>
  );
}
