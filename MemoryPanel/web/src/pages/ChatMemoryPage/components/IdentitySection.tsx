/**
 * IdentitySection —— agent 身份区（U1，DS-SOUL-MEMORY-002 §2.5/§6.5）。
 *
 * 只读展示 /v3/core-memory/read 的身份槽（BFF 透传，零新端点）：
 *   - self_identity → 「我是谁（agent 自我）」（spec §2.7 渲染顺序：self 段在前）
 *   - identity → 「我心中的他（用户身份）」
 * 宁缺毋滥：双槽皆空或读面失败时整段不渲染（不打扰锚面板主流程）。
 */
import { useEffect, useState } from 'react';
import { chatMemoryApi } from '@/lib/teamApi';
import { identityEmpty, identityMetaOf, splitIdentitySlots, type CoreSlotRow, type IdentityMeta } from './identity-utils';

/** U1 徽标（spec §6.5）：version/source/updated_at——数据内核已返回，纯 UI 消费补齐；
  * 空对象/全缺 → 不渲染徽标行（宁缺毋滥）。 */
function identityMetaBadges(meta: IdentityMeta | null) {
  if (!meta) return null;
  const items: string[] = [];
  if (typeof meta.version === 'number') items.push(`v${meta.version}`);
  if (meta.source) items.push(`source: ${meta.source}`);
  if (meta.updated_at) {
    const d = new Date(meta.updated_at);
    items.push(Number.isNaN(d.getTime()) ? meta.updated_at : d.toLocaleString());
  }
  if (items.length === 0) return null;
  return (
    <div className="_id-meta">
      {items.map((t) => (
        <span className="_id-badge" key={t}>
          {t}
        </span>
      ))}
    </div>
  );
}

export function IdentitySection(props: { blockId: string }) {
  const [slots, setSlots] = useState<CoreSlotRow[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSlots([]);
    setFailed(false);
    chatMemoryApi
      .identityRead(props.blockId)
      .then((d) => {
        if (alive) setSlots(Array.isArray(d.slots) ? d.slots : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [props.blockId]);

  if (failed) return null;
  const { user, self } = splitIdentitySlots(slots);
  if (identityEmpty(user, self)) return null;
  const metaSelf = identityMetaOf(slots, 'self_identity');
  const metaUser = identityMetaOf(slots, 'identity');

  return (
    <section className="_id-section" aria-label="agent 身份区（只读）">
      {self.length > 0 && (
        <div className="_id-block">
          <div className="_id-title">我是谁（agent 自我）</div>
          <pre className="_id-content">{self.join('\n')}</pre>
          {identityMetaBadges(metaSelf)}
        </div>
      )}
      {user.length > 0 && (
        <div className="_id-block">
          <div className="_id-title">我心中的他（用户身份）</div>
          <pre className="_id-content">{user.join('\n')}</pre>
          {identityMetaBadges(metaUser)}
        </div>
      )}
    </section>
  );
}
