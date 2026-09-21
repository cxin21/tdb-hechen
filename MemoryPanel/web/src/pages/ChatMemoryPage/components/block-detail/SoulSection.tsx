/**
 * SoulSection —— 灵魂区组件（U-A1，DS-PANEL-UI-VISUAL-001 §2 S2「灵魂解剖面板」第一步拆分）。
 *
 * 职责：把 L1 条目的灵魂数据渲染成一段自洽的可视区：
 *   ⏱ occurred_at / valid_range → 🎈 valence 双色条 + 强度/重要性进度条 →
 *   [实见/推断] 徽章 + source → 🎯 coreRef 价值 chips → 🔥 recall_count/last_recalled_at。
 *
 * 行为不变、渲染重排：本组件从 BlockDetail.AtomicHead 的灵魂 chip 段（原 :238 附近）
 * 平移而来，展示增强（补双色条/进度条/有效期/last_recalled_at）。字段解析全部收敛在
 * soul-utils.buildSoulView（纯函数，根 vitest 单测；批 2 图详情卡复用）。
 * 宁缺毋滥：无灵魂数据且非持续态 → 返回 null（不打扰）。
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type SoulView } from './soul-utils';

export function SoulSection({ soul, durative }: { soul: SoulView; durative?: boolean }) {
  const { t } = useTranslation();
  // D-2：人物 chips 点击 → /soul 人物专卡定位（state.person=label）
  const navigate = useNavigate();
  if (!soul.hasSoul && !durative) return null;

  return (
    <div className="_memory-detail-atomic-soul">
      {durative && (
        <span className="_soul-chip _soul-chip--durative" title="巩固产物（持续态）">🔗 持续态</span>
      )}
      {/* 🎯 价值锚 chips（S1：#label 形式；metadata.coreRefs 解析，宁缺毋滥） */}
      {soul.coreRefs.map((label) => (
        <span key={label} className="_soul-chip _soul-chip--anchor" title={`价值锚：${label}`}>
          🎯 #{label}
        </span>
      ))}
      {/* 👥 人物锚 chips（S2/U3 + D-2：点击 → /soul 人物专卡定位——设计有的全部可见） */}
      {soul.personRefs.map((label) => (
        <button
          key={`person:${label}`}
          type="button"
          className="_soul-chip _soul-chip--person _soul-chip--clickable"
          title={`人物锚：${label}（点击前往灵魂页人物专视图）`}
          onClick={() => void navigate('/soul', { state: { person: label } })}
        >
          👥 @{label}
        </button>
      ))}
      {/* 🧠 身份事实 chips（S2/U3：identityRefs 切片徽标） */}
      {soul.identityRefs.map((label) => (
        <span key={`identity:${label}`} className="_soul-chip _soul-chip--identity" title={`身份事实：${label}`}>
          🧠 {label}
        </span>
      ))}
      {/* ⏱ 时间行：发生时刻（title 存原始 ISO 便于核对）+ 有效期 */}
      {soul.occurredText && (
        <span className="_soul-chip" title={`发生时刻 ${soul.occurredAt ?? ''}`}>⏱ {soul.occurredText}</span>
      )}
      {soul.validityText && (
        <span className="_soul-chip" title={`有效期 ${soul.validStart ?? ''} ~ ${soul.validEnd ?? ''}`}>
          📅 {soul.validityText}
        </span>
      )}
      {/* [实见/推断] 徽章 + source（既有确定性 chip 平移） */}
      {soul.certaintyLabel && (
        <span
          className={`_soul-chip _soul-chip--${soul.certaintyKind === 'inferred' ? 'inferred' : 'observed'}`}
          title="确定性"
        >
          {soul.certaintyLabel}
        </span>
      )}
      {soul.source && (
        <span className="_soul-chip" title="来源">src {soul.source}</span>
      )}
      {/* 🎈 valence 双色条：负红左 / 正绿右，标记落点 + 数值（S1 情感色可视化） */}
      {soul.valencePct !== null && (
        <span className="_soul-chip" title="情感色调 (-1..1)">
          <span className="_soul-valbar" aria-hidden>
            <span className="_soul-valbar-mark" style={{ left: `${soul.valencePct}%` }} />
          </span>
          {(soul.valence ?? 0).toFixed(1)}
        </span>
      )}
      {/* 强度 / 重要性进度条（SoulView 已归一 0..100；无效值不渲染） */}
      {soul.arousalPct !== null && (
        <span className="_soul-meter" title="情绪强度 (0..1)">
          <span className="_soul-meter-track" aria-hidden>
            <span className="_soul-meter-fill" style={{ width: `${soul.arousalPct}%` }} />
          </span>
          {((soul.arousalPct ?? 0) / 100).toFixed(2)}
        </span>
      )}
      {soul.significancePct !== null && (
        <span className="_soul-meter" title="重要程度 (0..1)">
          <span className="_soul-meter-track" aria-hidden>
            <span className="_soul-meter-fill _soul-meter-fill--significance" style={{ width: `${soul.significancePct}%` }} />
          </span>
          {((soul.significancePct ?? 0) / 100).toFixed(2)}
        </span>
      )}
      {/* 🔥 回忆火苗（重巩固统计；title 带上次回忆时间） */}
      {soul.recallCount !== null && (
        <span
          className="_soul-chip"
          title={soul.lastRecalledText ? `上次回忆 ${soul.lastRecalledText}` : '被回忆次数（重巩固统计）'}
        >
          🔥 {t('memory.detail.recallCount', { count: soul.recallCount })}
        </span>
      )}
    </div>
  );
}
