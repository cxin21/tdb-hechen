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
  // V7 方案A：UI pill 按 weight 降序（程度梯度；注入侧保持 value_id 稳定序=KV cache 契约，首要选取两端同键已由 F-U2 统一）
  const pos = directional.filter((v) => v.valence === 1).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((v) => v.label);
  const neg = directional.filter((v) => v.valence === -1).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((v) => v.label);
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
        <div className="_soul-feelbody">
          {(primePos || primeNeg) && (
            <div className="_soul-feelprime">
              {primePos && (() => {
                const w = values.find((v) => v.label === primePos.label)?.weight;
                return (
                  <div className="_soul-prime-card _soul-prime-card--pos">
                    <span className="_soul-prime-tag _soul-prime-tag--pos">{t('soul.feeling.primeTag')}·{t('soul.feeling.pos')}</span>
                    <span className="_soul-prime-name">{primePos.label}</span>
                    {typeof w === 'number' && <span className="_soul-prime-w">w{w.toFixed(2).replace(/0$/, '')}</span>}
                    <span className="_soul-prime-desc">{primePos.desc}</span>
                  </div>
                );
              })()}
              {primeNeg && (() => {
                const w = values.find((v) => v.label === primeNeg.label)?.weight;
                return (
                  <div className="_soul-prime-card _soul-prime-card--neg">
                    <span className="_soul-prime-tag _soul-prime-tag--neg">{t('soul.feeling.primeTag')}·{t('soul.feeling.neg')}</span>
                    <span className="_soul-prime-name">{primeNeg.label}</span>
                    {typeof w === 'number' && <span className="_soul-prime-w">w{w.toFixed(2).replace(/0$/, '')}</span>}
                    <span className="_soul-prime-desc">{primeNeg.desc}</span>
                  </div>
                );
              })()}
            </div>
          )}
          <div className="_soul-feelrows">
            {posShow.length > 0 && (
              <span className="_soul-feelgroup">
                <span className="_soul-feelgroup-label">{t('soul.feeling.pos')}</span>
                {posShow.map((l) => <Pill key={`p:${l}`} label={l} kind="pos" />)}
                {!showAll && pos.length > cap && (
                  <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(true)}>+{pos.length - cap}</button>
                )}
                {showAll && (pos.length > cap || neg.length > cap) && (
                  <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(false)}>{t('soul.feeling.collapse')}</button>
                )}
              </span>
            )}
            {negShow.length > 0 && (
              <span className="_soul-feelgroup">
                <span className="_soul-feelgroup-label">{t('soul.feeling.neg')}</span>
                {negShow.map((l) => <Pill key={`neg:${l}`} label={l} kind="neg" />)}
                {!showAll && neg.length > cap && (
                  <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(true)}>+{neg.length - cap}</button>
                )}
              </span>
            )}
          </div>
        </div>
      ) : (
        loaded && <span className="_soul-meta">{t('soul.feeling.empty')}</span>
      )}
    </div>
  );
}
