/**
 * SoulFeelingBar —— 感受分区卡（S8 重写：价值锚整表删除后只剩近期基调）。
 *
 * S8（2026-11-07）：价值锚整表已删，「驱动/审慎价值锚」数据面不存在，
 * 本卡只保留 S-FEEL-1 的近期情绪基调（core /v3/memory/mood 只读透传）。
 * 「重要的人/关系」改由人格卡 human 层与关系史供料，不再走本卡。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi } from '@/lib/teamApi';

export function SoulFeelingBar({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [mood, setMood] = useState<{
    tier: 'positive' | 'neutral' | 'strained' | null;
    sampleCount: number;
    enabled?: boolean;
    windowHours?: number;
    maxSamples?: number;
    minSamples?: number;
    posThreshold?: number;
    negThreshold?: number;
    halfLifeHours?: number;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!blockId) {
      setMood(null);
      setLoaded(true);
      return;
    }
    try {
      const m = await chatMemoryApi.moodRead(blockId);
      setMood(m.mood ?? null);
    } catch {
      setMood(null);
    } finally {
      setLoaded(true);
    }
  }, [blockId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      className="_soul-section _soul-feel-section"
      aria-label={t('soul.feeling.title')}
      id="_soul-sec-feeling"
    >
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.feeling.title')}</span>
      </div>
      {/* S-FEEL-1（M1/S7）：近期基调——三态徽标+样本数；tooltip=判定依据（真实配置值）。 */}
      {mood?.tier ? (
        <div
          className="_soul-mood"
          title={t('soul.mood.tooltip', {
            window: mood.windowHours ?? 72,
            samples: mood.sampleCount,
            halfLife: mood.halfLifeHours ?? 48,
            pos: mood.posThreshold ?? 0.15,
            neg: Math.abs(mood.negThreshold ?? -0.15),
            min: mood.minSamples ?? 5,
          })}
        >
          <span className={`_soul-mood-badge _soul-mood-badge--${mood.tier}`}>
            {t(`soul.mood.${mood.tier}`)}
          </span>
          <span className="_soul-mood-text">
            {t('soul.mood.title')}（近 {mood.sampleCount} 条经历的情感聚合）
          </span>
        </div>
      ) : (
        loaded && <div className="_soul-meta">{t('soul.feeling.empty')}</div>
      )}
    </section>
  );
}
