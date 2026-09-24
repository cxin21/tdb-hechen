/**
 * SoulFeelingBar —— 感受分区卡（UI 2.1 P0 状态条 → V7 方案A → v2 布局返工）。
 *
 * 数据同源（valuesList → theme ∧ valence=±1，与 soul-assembler 同构）。
 * v2（用户令「布局太难看，都挤到一起」返工）：从 44px 状态条升维为分区卡——
 * 两列网格（驱动 3fr/审慎 2fr，单列时占满），首要卡两行主副（结构行 tag+锚名+w / 描述独立行），
 * 长尾 pills 每列流式 cap5 + +n/收起抽屉（aria-expanded）；与三池锚面板同卡片语言，高度自适应不挤压。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi, type ValueAnchor } from '@/lib/teamApi';
import { pickPrimeAnchor } from '../ChatMemoryPage/utils/attribute-badges';

function Pill({ label, kind }: { label: string; kind: 'pos' | 'neg' }) {
  return <span className={`_soul-pill _soul-pill--${kind}`}>{label}</span>;
}

function PrimeCard({ prime, weight, kind }: { prime: { label: string; desc: string }; weight?: number; kind: 'pos' | 'neg' }) {
  const { t } = useTranslation();
  return (
    <div className={`_soul-prime-card _soul-prime-card--${kind}`}>
      <div className="_soul-prime-head">
        <span className={`_soul-prime-tag _soul-prime-tag--${kind}`}>{t('soul.feeling.primeTag')}</span>
        <span className="_soul-prime-name">{prime.label}</span>
        {typeof weight === 'number' && <span className="_soul-prime-w">w{weight.toFixed(2).replace(/0$/, '')}</span>}
      </div>
      <div className="_soul-prime-desc">{prime.desc}</div>
    </div>
  );
}

export function SoulFeelingBar({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ValueAnchor[]>([]);
  const [loaded, setLoaded] = useState(false);
  // S-FEEL-1（M1/S7）：近期基调（tier=null/未启用/失败=不渲染，宁缺毋滥）。
  const [mood, setMood] = useState<{ tier: 'positive' | 'neutral' | 'strained' | null; sampleCount: number; enabled?: boolean; windowHours?: number; maxSamples?: number; minSamples?: number; posThreshold?: number; negThreshold?: number; halfLifeHours?: number } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!blockId) { setValues([]); setLoaded(true); return; }
    try {
      const res = await chatMemoryApi.valuesList(blockId);
      setValues(res.values ?? []);
    } catch { setValues([]); }
    finally { setLoaded(true); }
    // S-FEEL-1（M1/S7）：近期基调副行——与 valuesList 同一 load 时钟；失败/未启用=不渲染。
    try {
      const m = await chatMemoryApi.moodRead(blockId);
      setMood(m.mood ?? null);
    } catch { setMood(null); }
    finally { setLoaded(true); }
  }, [blockId]);

  useEffect(() => { void load(); }, [load]);

  const directional = values.filter(
    (v) => (v.node_type ?? 'theme') === 'theme' && (v.valence === 1 || v.valence === -1),
  );
  // V7 方案A：UI pill 按 weight 降序（程度梯度；注入侧保持 value_id 稳定序=KV cache 契约，首要选取两端同键已由 F-U2 统一）
  const pos = directional.filter((v) => v.valence === 1).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const neg = directional.filter((v) => v.valence === -1).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const primePos = pickPrimeAnchor(values.filter((v) => v.valence === 1));
  const primeNeg = pickPrimeAnchor(values.filter((v) => v.valence === -1));
  const cap = 5;
  const posShow = showAll ? pos : pos.slice(0, cap);
  const negShow = showAll ? neg : neg.slice(0, cap);
  const hasAny = pos.length > 0 || neg.length > 0;
  const hasOverflow = pos.length > cap || neg.length > cap;
  const single = pos.length === 0 || neg.length === 0;
  const weightOf = (label: string) => values.find((v) => v.label === label)?.weight;

  return (
    <section className="_soul-section _soul-feel-section" aria-label={t('soul.feeling.title')} id="_soul-sec-feeling">
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.feeling.title')}</span>
      </div>
      {hasAny ? (
        <div className={"_soul-feel-cols" + (single ? " _soul-feel-cols--single" : "")}>
          {pos.length > 0 && (
            <div className="_soul-feel-col _soul-feel-col--pos">
              <div className="_soul-feel-col-head">{t('soul.feeling.pos')}（{pos.length}）</div>
              {primePos && <PrimeCard prime={primePos} weight={weightOf(primePos.label)} kind="pos" />}
              <div className="_soul-feel-pills">
                {posShow.map((v) => <Pill key={`p:${v.label}`} label={v.label} kind="pos" />)}
              </div>
              {!showAll && pos.length > cap && (
                <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(true)}>+{pos.length - cap}</button>
              )}
            </div>
          )}
          {neg.length > 0 && (
            <div className="_soul-feel-col _soul-feel-col--neg">
              <div className="_soul-feel-col-head">{t('soul.feeling.neg')}（{neg.length}）</div>
              {primeNeg && <PrimeCard prime={primeNeg} weight={weightOf(primeNeg.label)} kind="neg" />}
              <div className="_soul-feel-pills">
                {negShow.map((v) => <Pill key={`neg:${v.label}`} label={v.label} kind="neg" />)}
              </div>
              {!showAll && neg.length > cap && (
                <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(true)}>+{neg.length - cap}</button>
              )}
            </div>
          )}
          {showAll && hasOverflow && (
            <button type="button" className="_soul-feel-more" aria-expanded={showAll} onClick={() => setShowAll(false)}>{t('soul.feeling.collapse')}</button>
          )}
        </div>
      ) : (
        loaded && <div className="_soul-meta">{t('soul.feeling.empty')}</div>
      )}
      {/* S-FEEL-1（M1/S7）：近期基调全宽副行——三态徽标+样本数；tooltip=判定依据（真实配置值，信息完整性）。 */}
      {mood?.tier && (
        <div
          className="_soul-mood"
          title={t('soul.mood.tooltip', { window: mood.windowHours ?? 72, samples: mood.sampleCount, halfLife: mood.halfLifeHours ?? 48, pos: mood.posThreshold ?? 0.15, neg: Math.abs(mood.negThreshold ?? -0.15), min: mood.minSamples ?? 5 })}
        >
          <span className={`_soul-mood-badge _soul-mood-badge--${mood.tier}`}>{t(`soul.mood.${mood.tier}`)}</span>
          <span className="_soul-mood-text">{t('soul.mood.title')}（近 {mood.sampleCount} 条经历的情感聚合）</span>
        </div>
      )}
    </section>
  );
}
