/**
 * SoulIdentityDual —— 身份双槽双栏卡（UI 2.1 P0，2026-09-21；设计师方案 §4.3）。
 *
 * #69（R3 配套，票 ② 两个页面都加叙事小节）：与 IdentitySection 共用 identity-narrative
 * 小节组件——绿（叙事生效）→ IdentityNarrativeView「AI 眼中的我」；灰（门关/降级）→
 * NarrativeStatusLine + 存量双栏卡逐位现状；空 → 整段不渲染。数据同源
 * （chatMemoryApi.identityRead）。双栏并排镜像布局 + 长文折叠
 * （>12 行渐隐 +「展开全文(n 字)」，折叠≠丢失——C11/C12 判据）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { narrativePreviewOf } from '@/pages/ChatMemoryPage/components/identity-utils';
import { IdentityNarrativeView, NarrativeStatusLine, useIdentityNarrativeState } from '@/pages/ChatMemoryPage/components/identity-narrative';

type SlotKey = 'self' | 'user';

const SLOT_META: Record<SlotKey, { title: string; dotCls: string; badgeCls: string; badgeText: string }> = {
  self: { title: '我是谁', dotCls: '_soul-dot--person', badgeCls: '_soul-badge--person', badgeText: 'agent 自我' },
  user: { title: '我心中的他', dotCls: '_soul-dot--gold', badgeCls: '_soul-badge--gold', badgeText: '用户身份' },
};

function IdentitySlotCard({ slotKey, lines, expanded, onToggle }: {
  slotKey: SlotKey; lines: string[]; expanded: boolean; onToggle: () => void;
}) {
  const meta = SLOT_META[slotKey];
  const fullText = lines.join('\n');
  const collapsible = lines.length > 12 || fullText.length > 600;
  return (
    <div className="_soul-idcard">
      <div className="_soul-idcard-head">
        <span className={`_soul-dot ${meta.dotCls}`} aria-hidden />
        <span className="_soul-idcard-title">{meta.title}</span>
        <span className={`_soul-chip ${meta.badgeCls}`}>{meta.badgeText}</span>
        <span className="_soul-meta">{lines.length} 条</span>
      </div>
      <div className={`_soul-idcard-body${collapsible && !expanded ? ' _soul-idcard-body--collapsed' : ''}`}>
        <ul className="_soul-idlist">
          {lines.map((line, i) => (
            <li key={i} className="_soul-idline">{line.replace(/^-\s*/, '')}</li>
          ))}
        </ul>
      </div>
      {collapsible && (
        <button type="button" className="_soul-idcard-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '收起' : `展开全文（共 ${fullText.length} 字）`}
        </button>
      )}
    </div>
  );
}

export function SoulIdentityDual({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<{ self: boolean; user: boolean }>({ self: false, user: false });
  const { failed, slots } = useIdentityNarrativeState(blockId);

  if (failed) return null;
  const preview = narrativePreviewOf(slots);
  if (preview.state === 'empty') return null;
  if (preview.state === 'active') {
    // 绿态：叙事生效（kernel 已把身份两行替换为合成槽）——整段换叙事视图；
    // 锚点经 anchorId 落在叙事 section 上（SoulPage/index.tsx 页内导航引用，不丢锚）。
    return <IdentityNarrativeView blockId={blockId} preview={preview} variant="soul" anchorId="_soul-sec-identity" />;
  }
  // 灰态（门关/降级合一）：一行状态说明（降级不静默）+ 存量双栏卡逐位现状。
  const { user, self } = preview.entries;

  return (
    <section className="_soul-section" aria-label={t('soul.identity.title')} id="_soul-sec-identity">
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.identity.title')}</span>
        <span className="_soul-chip _soul-chip--person">双槽</span>
      </div>
      <NarrativeStatusLine variant="soul" />
      <div className="_soul-idgrid">
        {self.length > 0 && (
          <IdentitySlotCard
            slotKey="self"
            lines={self}
            expanded={expanded.self}
            onToggle={() => setExpanded((s) => ({ ...s, self: !s.self }))}
          />
        )}
        {user.length > 0 && (
          <IdentitySlotCard
            slotKey="user"
            lines={user}
            expanded={expanded.user}
            onToggle={() => setExpanded((p) => ({ ...p, user: !p.user }))}
          />
        )}
      </div>
    </section>
  );
}
