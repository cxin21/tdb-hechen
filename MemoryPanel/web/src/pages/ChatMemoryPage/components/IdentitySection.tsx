/**
 * IdentitySection —— agent 身份区（U1，DS-SOUL-MEMORY-002 §2.5/§6.5）。
 *
 * #69（R3 配套）：读取改走 narrative 视图（identityRead format='narrative'），
 * 由 narrativePreviewOf 判态：绿（叙事生效）→ IdentityNarrativeView「AI 眼中的我」；
 * 灰（门关/降级，单次读响应不可分）→ NarrativeStatusLine 一行人话 + 存量条目视图
 * 逐位现状；空 → 整段不渲染（宁缺毋滥）。
 * 只读展示 /v3/core-memory/read 的身份槽（BFF 透传，零新端点）：
 *   - self_identity → 「我是谁（agent 自我）」（spec §2.7 渲染顺序：self 段在前）
 *   - identity → 「我心中的他（用户身份）」
 */
import { identityMetaOf, narrativePreviewOf, type IdentityMeta } from './identity-utils';
import { IdentityNarrativeView, NarrativeStatusLine, useIdentityNarrativeState } from './identity-narrative';

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
  const { failed, slots } = useIdentityNarrativeState(props.blockId);

  if (failed) return null;
  const preview = narrativePreviewOf(slots);
  if (preview.state === 'empty') return null;
  if (preview.state === 'active') {
    // 绿态：叙事生效（kernel 已把身份两行替换为合成槽）——整段换叙事视图。
    return <IdentityNarrativeView blockId={props.blockId} preview={preview} variant="anchors" />;
  }
  // 灰态（门关/降级合一）：一行状态说明（降级不静默）+ 存量条目视图逐位现状。
  const { user, self } = preview.entries;
  const metaSelf = identityMetaOf(slots, 'self_identity');
  const metaUser = identityMetaOf(slots, 'identity');

  return (
    <section className="_id-section" aria-label="agent 身份区（只读）">
      <NarrativeStatusLine variant="anchors" />
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
