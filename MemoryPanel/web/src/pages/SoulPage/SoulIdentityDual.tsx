/**
 * SoulIdentityDual —— 身份双槽双栏卡（UI 2.1 P0，2026-09-21；设计师方案 §4.3）。
 *
 * SoulPage 局部组件：IdentitySection 共享组件零改动（ChatMemoryPage 逐位现状），
 * 数据同源（chatMemoryApi.identityRead）。双栏并排镜像布局 + 长文折叠
 * （>12 行渐隐 +「展开全文(n 字)」，折叠≠丢失——C11/C12 判据）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatMemoryApi } from '@/lib/teamApi';
import { identityEmpty, splitIdentitySlots, type CoreSlotRow } from '@/pages/ChatMemoryPage/components/identity-utils';

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
        <button type="button" className="_soul-idcard-toggle" onClick={onToggle}>
          {expanded ? '收起' : `展开全文（共 ${fullText.length} 字）`}
        </button>
      )}
    </div>
  );
}

export function SoulIdentityDual({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  const [slots, setSlots] = useState<CoreSlotRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<{ self: boolean; user: boolean }>({ self: false, user: false });

  useEffect(() => {
    let alive = true;
    setSlots([]);
    setFailed(false);
    chatMemoryApi
      .identityRead(blockId)
      .then((d) => { if (alive) setSlots(Array.isArray(d.slots) ? d.slots : []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [blockId]);

  if (failed) return null;
  const { user, self } = splitIdentitySlots(slots);
  if (identityEmpty(user, self)) return null;

  return (
    <section className="_soul-section" aria-label={t('soul.identity.title')} id="_soul-sec-identity">
      <div className="_soul-section-head">
        <span className="_soul-section-title">{t('soul.identity.title')}</span>
        <span className="_soul-chip _soul-chip--person">双槽</span>
      </div>
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
