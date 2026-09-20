/**
 * SoulPage —— 灵魂一级页（UI 2.0 拍板③；设计稿 2026-09-20 经用户确认）。
 *
 * 分区（自上而下）：
 *   1. 身份双槽（IdentitySection 复用：我是谁 / 我心中的他）
 *   2. 当下的感受（FeelingCard：theme ∧ valence=±1，与 soul-assembler 注入块同构渲染）
 *   3. 待裁决流（PendingSection 复用：core_value/strict_rule 红线提案 + evidence 展示）
 *   4. 三池锚面板（ValueAnchorsPanel 复用：blockIdOverride + hideIdentityPending——
 *      身份/裁决已由页级渲染，面板内不再重复；类型徽标/配额条/行内编辑/反查全量继承）
 * 数据零新端点：blockId = `chat_memory-{teamId}-{agentId}` 确定性组合（VAP 同款）。
 * 空态宁缺毋滥：无自有 Agent → 引导文案；感受段无定向锚 → 弱化说明行。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { chatMemoryApi, type ValueAnchor } from '@/lib/teamApi';
import { IdentitySection } from '@/pages/ChatMemoryPage/components/IdentitySection';
import { PendingSection } from '@/pages/ChatMemoryPage/components/PendingSection';
import ValueAnchorsPanel from '@/pages/ChatMemoryPage/components/ValueAnchorsPanel';
import './soul-page.css';

/** 感受段：theme ∧ valence=±1（与 soul-assembler directional 过滤同构；person/character 不入）。 */
function FeelingCard(props: { blockId: string }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ValueAnchor[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!props.blockId) {
      setValues([]);
      setLoaded(true);
      return;
    }
    try {
      const res = await chatMemoryApi.valuesList(props.blockId);
      setValues(res.values ?? []);
    } catch {
      setValues([]);
    } finally {
      setLoaded(true);
    }
  }, [props.blockId]);

  useEffect(() => {
    void load();
  }, [load]);

  const directional = values.filter(
    (v) => (v.node_type ?? 'theme') === 'theme' && (v.valence === 1 || v.valence === -1),
  );
  const pos = directional.filter((v) => v.valence === 1).map((v) => v.label);
  const neg = directional.filter((v) => v.valence === -1).map((v) => v.label);

  return (
    <section className="_soul-card" aria-label={t('soul.feeling.title')}>
      <div className="_soul-card-title">{t('soul.feeling.title')}</div>
      {pos.length > 0 && (
        <div className="_soul-feeling-line _soul-feeling-pos">{t('soul.feeling.pos')}：{pos.join('、')}</div>
      )}
      {neg.length > 0 && (
        <div className="_soul-feeling-line _soul-feeling-neg">{t('soul.feeling.neg')}：{neg.join('、')}</div>
      )}
      {loaded && pos.length === 0 && neg.length === 0 && (
        <div className="_soul-muted">{t('soul.feeling.empty')}</div>
      )}
    </section>
  );
}

export function SoulPage() {
  const { t } = useTranslation();
  const auth = readAuth();
  const currentUserId = auth?.user_id ?? '';
  const { activeTeamId } = useTeams();
  const { agents } = useAgents(activeTeamId);
  const ownedAgents = useMemo(
    () => agents.filter((a) => a.owner_user_id === currentUserId),
    [agents, currentUserId],
  );
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    if (ownedAgents.length === 0) {
      setAgentId('');
      return;
    }
    if (!agentId || !ownedAgents.some((a) => a.agent_id === agentId)) {
      setAgentId(ownedAgents[0].agent_id);
    }
  }, [ownedAgents, agentId]);

  const blockId = activeTeamId && agentId ? `chat_memory-${activeTeamId}-${agentId}` : '';

  return (
    <ResourcePage>
      <div className="_soul-page">
        <div className="_soul-header">
          <div className="_soul-header-text">
            <div className="_soul-title">{t('soul.title')}</div>
            <div className="_soul-desc">{t('soul.desc')}</div>
          </div>
          <Select
            appearance="button"
            matchButtonWidth
            value={agentId}
            onChange={setAgentId}
            disabled={ownedAgents.length === 0}
            placeholder={t('soul.noAgent')}
            options={ownedAgents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))}
          />
        </div>

        {!blockId ? (
          <div className="_soul-empty">{t('soul.noAgent')}</div>
        ) : (
          <>
            <section className="_soul-card" aria-label={t('soul.identity.title')}>
              <div className="_soul-card-title">{t('soul.identity.title')}</div>
              <IdentitySection blockId={blockId} />
            </section>

            <FeelingCard blockId={blockId} />

            <section className="_soul-card" aria-label={t('soul.pending.title')}>
              <div className="_soul-card-title">{t('soul.pending.title')}</div>
              <PendingSection blockId={blockId} />
            </section>

            <ValueAnchorsPanel blockIdOverride={blockId} hideIdentityPending />
          </>
        )}
      </div>
    </ResourcePage>
  );
}
