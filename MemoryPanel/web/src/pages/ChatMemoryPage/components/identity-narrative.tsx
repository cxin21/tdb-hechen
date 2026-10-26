/**
 * IdentityNarrativeView / NarrativeStatusLine / useIdentityNarrativeState ——
 * #69（R3 配套，小白优先原则首用票）：Panel 身份区
 * 「AI 眼中的我」叙事预览小节（IdentitySection / SoulIdentityDual 共用）。
 *
 * 纯只读；叙事单一源在 MemoryCore（ADR-0005 / renderIdentityNarrative 模板常量），
 * 本组件只消费 /v3/core-memory/read 的响应形态，不复制模板/组装逻辑。
 * 三态由 narrativePreviewOf 判定（kernel 语义 v2-router.ts:2458-2484）：
 *   - active（绿）：叙事文本 + 「叙事已启用」章 + 技术细节折叠（槽名/source/version）
 *     + 两视图切换「AI 实际看到的」/「存储原文（管理员视角）」（原文懒加载，无 format
 *     必返回存储条目——替换仅在 format=narrative 分支发生）。
 *   - fallback（灰）：门关与生成闸降级在单次读响应中同为条目形态、无信号可分——
 *     合一灰态（票 §2 允许）：NarrativeStatusLine 一行人话 + 存量条目视图由宿主渲染
 *     （降级不静默）。
 *   - empty：身份内容全空 → 宿主整段不渲染（宁缺毋滥）。
 * variant 决定类前缀：anchors=_id-*（chat-memory-anchors.css）/ soul=_soul-*（soul-page.css）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi } from '@/lib/teamApi';
import {
  IDENTITY_NARRATIVE_SLOT,
  rawIdentityRowsOf,
  type CoreSlotRow,
  type NarrativePreview,
} from './identity-utils';

export type IdentityNarrativeVariant = 'anchors' | 'soul';

interface VariantClasses {
  section: string;
  head: string;
  title: string;
  chipOn: string;
  chipOff: string;
  content: string;
  switchWrap: string;
  switchBtn: string;
  switchBtnOn: string;
  details: string;
  detailsBody: string;
  status: string;
  hint: string;
  rawRow: string;
  rawSlot: string;
}

const CLS: Record<IdentityNarrativeVariant, VariantClasses> = {
  anchors: {
    section: '_id-section',
    head: '_id-narr-head',
    title: '_id-title',
    chipOn: '_id-badge _id-narr-chip--on',
    chipOff: '_id-badge _id-narr-chip--off',
    content: '_id-content',
    switchWrap: '_id-narr-switch',
    switchBtn: '_id-narr-switch-btn',
    switchBtnOn: '_id-narr-switch-btn--on',
    details: '_id-narr-details',
    detailsBody: '_id-narr-details-body',
    status: '_id-narr-status',
    hint: '_id-narr-hint',
    rawRow: '_id-narr-raw-row',
    rawSlot: '_id-narr-raw-slot',
  },
  soul: {
    section: '_soul-section',
    head: '_soul-section-head',
    title: '_soul-section-title',
    chipOn: '_soul-chip _soul-chip--green',
    chipOff: '_soul-chip _soul-chip--neutral',
    content: '_soul-narr-content',
    switchWrap: '_soul-narr-switch',
    switchBtn: '_soul-narr-switch-btn',
    switchBtnOn: '_soul-narr-switch-btn--on',
    details: '_soul-narr-details',
    detailsBody: '_soul-narr-details-body',
    status: '_soul-narr-status',
    hint: '_soul-narr-hint',
    rawRow: '_soul-narr-raw-row',
    rawSlot: '_soul-narr-raw-slot',
  },
};

/** #69 三态数据源（宿主共用）：读 narrative 视图（format='narrative'）+ 失败位。
 * 编排（failed→null / narrativePreviewOf 判态 / 灰态存量渲染）留在各宿主——两页布局不同。 */
export function useIdentityNarrativeState(blockId: string): {
  failed: boolean;
  slots: CoreSlotRow[];
} {
  const [slots, setSlots] = useState<CoreSlotRow[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSlots([]);
    setFailed(false);
    chatMemoryApi
      .identityRead(blockId, { format: 'narrative' })
      .then((d) => {
        if (alive) setSlots(Array.isArray(d.slots) ? d.slots : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [blockId]);
  return { failed, slots };
}

/** 绿态视图：「AI 眼中的我」——默认结论级叙事文本（AI 实际看到的），技术细节折叠，
 * 「存储原文（管理员视角）」按需懒加载（渐进披露：原文视图不默认拉取）。 */
export function IdentityNarrativeView(props: {
  blockId: string;
  preview: NarrativePreview;
  variant: IdentityNarrativeVariant;
  /** 宿主页内导航锚（如 soul 页 _soul-sec-identity）：绿态整段换形态时锚不丢。 */
  anchorId?: string;
}) {
  const { t } = useTranslation();
  const c = CLS[props.variant];
  const [view, setView] = useState<'live' | 'raw'>('live');
  const [raw, setRaw] = useState<CoreSlotRow[] | null>(null);
  const [rawFailed, setRawFailed] = useState(false);

  // 「存储原文」懒加载：切到原文视图才发第二次读（无 format = 存储条目形态）。
  // 口径与灰态条目视图一致：rawIdentityRowsOf 只留身份两槽（防核心区其它槽混入身份区）。
  const showRaw = () => {
    setView('raw');
    if (raw === null && !rawFailed) {
      chatMemoryApi
        .identityRead(props.blockId)
        .then((d) => setRaw(rawIdentityRowsOf(d.slots)))
        .catch(() => setRawFailed(true));
    }
  };

  const narr = props.preview.narrative;
  if (!narr) return null; // 类型守卫：active 必有 narrative（narrativePreviewOf 合同）

  const metaBits: string[] = [IDENTITY_NARRATIVE_SLOT];
  if (typeof narr.version === 'number') metaBits.push(`v${narr.version}`);
  if (narr.source) metaBits.push(`source: ${narr.source}`);
  if (narr.updated_at) {
    const d = new Date(narr.updated_at);
    metaBits.push(Number.isNaN(d.getTime()) ? narr.updated_at : d.toLocaleString());
  }

  const rawRows = raw;
  return (
    <section className={c.section} aria-label={t('soul.narrative.title')} id={props.anchorId}>
      <div className={c.head}>
        <span className={c.title}>{t('soul.narrative.title')}</span>
        <span className={c.chipOn}>{t('soul.narrative.state.on')}</span>
      </div>
      {view === 'live' ? (
        <>
          <pre className={c.content}>{narr.content}</pre>
          <details className={c.details}>
            <summary>{t('soul.narrative.details')}</summary>
            <div className={c.detailsBody}>{metaBits.join(' · ')}</div>
          </details>
        </>
      ) : (
        <div>
          {rawFailed ? (
            <div className={c.hint}>{t('soul.narrative.rawFailed')}</div>
          ) : rawRows === null ? (
            <div className={c.hint}>…</div>
          ) : rawRows.length === 0 ? (
            <div className={c.hint}>{t('soul.narrative.rawEmpty')}</div>
          ) : (
            rawRows.map((row) => (
              <div key={`${row.slot}:${row.version ?? ''}`} className={c.rawRow}>
                <div className={c.rawSlot}>{row.slot}</div>
                <pre className={c.content}>{row.content}</pre>
              </div>
            ))
          )}
        </div>
      )}
      <div className={c.switchWrap}>
        <button
          type="button"
          className={view === 'live' ? `${c.switchBtn} ${c.switchBtnOn}` : c.switchBtn}
          onClick={() => setView('live')}
        >
          {t('soul.narrative.view.live')}
        </button>
        <button
          type="button"
          className={view === 'raw' ? `${c.switchBtn} ${c.switchBtnOn}` : c.switchBtn}
          onClick={showRaw}
        >
          {t('soul.narrative.view.raw')}
        </button>
      </div>
    </section>
  );
}

/** 灰态状态行（降级不静默）：门关/生成闸降级合一（单次读响应无信号可分），一句人话。
 * 存量条目视图由宿主在其下继续渲染——本行只补状态，不改存量布局。 */
export function NarrativeStatusLine(props: { variant: IdentityNarrativeVariant }) {
  const { t } = useTranslation();
  const c = CLS[props.variant];
  return (
    <div className={c.status}>
      <span className={c.chipOff}>{t('soul.narrative.state.off')}</span>
      <span className={c.hint}>{t('soul.narrative.off.hint')}</span>
    </div>
  );
}
