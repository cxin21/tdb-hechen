/**
 * V6-批次二：注入徽章组渲染（BlockDetail 头部 tag 行旁，静态 badge 非交互）。
 * tooltip=只读判定依据（Carbon 规范：tooltip 禁交互元素）；零命中不渲染占位。
 */
import { useTranslation } from 'react-i18next';
import { deriveAttributeBadges } from '../../utils/attribute-badges';
import type { ChatMemoryLayerItem } from '../../../../lib/api/chat-memory';

/** 语义色（独立信息调色板：颜色+图标+文字三通道；对照 mockup A 区） */
const CLS: Record<string, { bg: string; fg: string; border: string }> = {
  core: { bg: '#f3f0ff', fg: '#6d28d9', border: '#ddd0ff' },
  verify: { bg: '#eff6ff', fg: '#1d4ed8', border: '#c7dbfe' },
  strong: { bg: '#fff1ed', fg: '#c2410c', border: '#fed7aa' },
  evo: { bg: '#ecfdf5', fg: '#047857', border: '#bbf7d0' },
  since: { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb' },
};

export function AttributeBadges({ item }: { item: ChatMemoryLayerItem }) {
  const { t } = useTranslation();
  const badges = deriveAttributeBadges(item);
  if (badges.length === 0) return null;
  return (
    <span className="_attr-badges" style={{ display: 'inline-flex', gap: 6, verticalAlign: 'middle' }}>
      {badges.map((b) => {
        const c = CLS[b.cls] ?? CLS.since;
        return (
          <span
            key={b.key}
            className={`_attr-badge _attr-badge--${b.cls}`}
            title={b.tooltip}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, lineHeight: 1.4, padding: '2px 8px', borderRadius: 999, border: `1px solid ${c.border}`, background: c.bg, color: c.fg }}
          >
            <span aria-hidden>{b.icon}</span>
            {t(b.labelKey, b.values ?? {}) as string}
          </span>
        );
      })}
    </span>
  );
}
