/**
 * SoulPage —— 灵魂一级页（UI 2.1 重排 2026-09-21；设计师方案 §一/§二）。
 *
 * IA：紧凑页头（标题+锚点 pills ‖ Agent 切换器，56px flex 居中）
 *   → 全宽感受状态条 → 主列(身份双槽双栏 + 重要的人) + 右栏(sticky 待裁决队列)
 *   → 全宽三池锚面板（ValueAnchorsPanel 复用，本批零改动——Tab 化属下一批）。
 * 信息零丢失：五分区功能与文案全部保留（红线：看不到=没做）。
 * 数据零新端点：blockId = `chat_memory-{teamId}-{agentId}` 确定性组合（VAP 同款）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { chatMemoryApi } from '@/lib/teamApi';
import { SoulIdentityDual } from './SoulIdentityDual';
import { SoulFeelingBar } from './SoulFeelingBar';
import { SoulPendingRail } from './SoulPendingRail';
import { PersonSection } from './PersonSection';
import ValueAnchorsPanel from '@/pages/ChatMemoryPage/components/ValueAnchorsPanel';
import './soul-page.css';

const NAV_ITEMS = [
  { id: '_soul-sec-feeling', label: '感受' },
  { id: '_soul-sec-identity', label: '身份双槽' },
  { id: '_soul-person-section', label: '重要的人' },
  { id: '_soul-sec-pending', label: '待裁决' },
  { id: '_soul-sec-anchors', label: '价值锚' },
];

function scroll_to_section(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  const loadValues = useCallback(async (id: string) => {
    const res = await chatMemoryApi.valuesList(id);
    return res.values ?? [];
  }, []);
  void loadValues;

  return (
    <ResourcePage>
      <div className="_soul-root">
        <header className="_soul-header" id="_soul-sec-top">
          <div className="_soul-header-left">
            <div className="_soul-title">{t('soul.title')}</div>
            <nav className="_soul-nav" aria-label="分区导航">
              {NAV_ITEMS.map((n) => (
                <button key={n.id} type="button" className="_soul-nav-pill" onClick={() => scroll_to_section(n.id)}>
                  {n.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="_soul-header-right">
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
        </header>

        {!blockId ? (
          <div className="_soul-empty">{t('soul.noAgent')}</div>
        ) : (
          <>
            <SoulFeelingBar blockId={blockId} />

            <div className="_soul-grid">
              <div className="_soul-main">
                <SoulIdentityDual blockId={blockId} />
                <PersonSection blockId={blockId} />
              </div>
              <aside className="_soul-rail">
                <SoulPendingRail blockId={blockId} />
              </aside>
            </div>

            <section className="_soul-section" id="_soul-sec-anchors" aria-label={t('soul.desc')}>
              <div className="_soul-section-head">
                <span className="_soul-section-title">价值锚（三池）</span>
              </div>
              <ValueAnchorsPanel blockIdOverride={blockId} hideIdentityPending variant="soul" />
            </section>
          </>
        )}
      </div>
    </ResourcePage>
  );
}
