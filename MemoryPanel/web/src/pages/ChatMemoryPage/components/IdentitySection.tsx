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
import { identityEmpty, splitIdentitySlots, type CoreSlotRow } from './identity-utils';

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

  return (
    <section className="_id-section" aria-label="agent 身份区（只读）">
      {self.length > 0 && (
        <div className="_id-block">
          <div className="_id-title">我是谁（agent 自我）</div>
          <pre className="_id-content">{self.join('\n')}</pre>
        </div>
      )}
      {user.length > 0 && (
        <div className="_id-block">
          <div className="_id-title">我心中的他（用户身份）</div>
          <pre className="_id-content">{user.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}
