/**
 * SoulPage —— 灵魂一级页（T3 重排 2026-11-07：自维护、0 人工采纳后，待裁决队列与价值锚
 * 编辑面板整体退场；本页收敛为只读人格面，只保留身份 / 感受 / 人格卡 / 版本链）。
 *
 * IA：紧凑页头（标题 + 锚点 pills ‖ Agent 切换器，56px 居中）
 *   → 全宽感受条（SoulFeelingBar）
 *   → 全宽情绪明细（SoulEmotionPanel，阶段 3：逐条表 + 六档漏斗）
 *   → 全宽人物档案（PersonArchivePanel：左列表 / 右九字段与依据 / 下 SVG 关系图，只读）
 *   → 全宽人格卡只读视图（CardView：注入原文 + 来源图例）
 *   → 全宽身份双栏（SoulIdentityDual，内部 1fr 1fr；窄屏 1fr）
 *   → 全宽版本链 / 漂移审计（SoulVersionChain）
 *
 * S8（2026-11-07）：价值锚整表删除，「重要的人」（原走价值锚读面）下线；
 * 关系/人物事实改由人格卡 human 层与关系史供料（Core 侧，不在本页读值锚）。
 * 数据零新端点：blockId = `chat_memory-{teamId}-{agentId}` 确定性组合（VAP 同款）。
 * 例外：人格卡（CardView）走 GET /api/v1/chat-memory/soul-card（S2 读面，2026-11-07），
 * tenant 三轴由本页直接给（team/user/agent），不再靠 blockId 反解。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { SoulIdentityDual } from './SoulIdentityDual';
import { SoulFeelingBar } from './SoulFeelingBar';
import { SoulEmotionPanel } from './SoulEmotionPanel';
import { PersonArchivePanel } from './PersonArchivePanel';
import { InjectionHealthBar } from './InjectionHealthBar';
import { SoulVersionChain } from './SoulVersionChain';
import { CardView } from './CardView';
import './soul-page.css';

const NAV_ITEMS = [
  { id: '_soul-sec-feeling', label: '感受' },
  { id: '_soul-sec-emotions', label: '情绪明细' },
  { id: '_soul-sec-persons', label: '人物' },
  { id: '_soul-sec-card', label: '人格卡' },
  { id: '_soul-sec-identity', label: '身份双槽' },
  { id: '_soul-sec-versions', label: '版本链' },
];

function scroll_to_section(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function SoulPage() {
  const { t } = useTranslation();
  const [activeNav, setActiveNav] = useState('');
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
      <div className="_soul-root">
        <header className="_soul-header" id="_soul-sec-top">
          <div className="_soul-header-left">
            <div className="_soul-title">{t('soul.title')}</div>
            <nav className="_soul-nav" aria-label="分区导航">
              {NAV_ITEMS.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={
                    '_soul-nav-pill' + (activeNav === n.id ? ' _soul-nav-pill--active' : '')
                  }
                  aria-current={activeNav === n.id ? 'true' : undefined}
                  onClick={() => {
                    setActiveNav(n.id);
                    scroll_to_section(n.id);
                  }}
                >
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
              options={ownedAgents.map((a) => ({
                value: a.agent_id,
                text: `${a.name}（${a.agent_id}）`,
              }))}
            />
          </div>
        </header>

        {/* ⓪ 注入健康：只读状态条（P0-D；三态 正常/降级/无数据） */}
        <InjectionHealthBar
          teamId={activeTeamId ?? ''}
          agentId={agentId}
          userId={currentUserId}
        />

        {!blockId ? (
          <div className="_soul-empty">{t('soul.noAgent')}</div>
        ) : (
          <>
            {/* ① 感受条：44px 全宽状态带（含近期基调副行） */}
            <SoulFeelingBar blockId={blockId} />

            {/* ①b 情绪明细：逐条表 + 六档漏斗（阶段 3；缺字段即跳过该段） */}
            <SoulEmotionPanel
              teamId={activeTeamId ?? ''}
              agentId={agentId}
              userId={currentUserId}
            />

            {/* ①c 人物档案：按人看已提炼的档案字段与关系（只读，P2-H） */}
            <PersonArchivePanel
              teamId={activeTeamId ?? ''}
              agentId={agentId}
              userId={currentUserId}
            />

            {/* ② 人格卡：注入原文（只读，与 dsh-plugin 每轮拿到的同源） */}
            <CardView
              teamId={activeTeamId ?? ''}
              agentId={agentId}
              userId={currentUserId}
            />

            {/* ③ 身份双栏：self / user 两槽并排；窄屏单列 */}
            <SoulIdentityDual blockId={blockId} />

            {/* ④ 版本链 / 漂移审计（S8：重要的人读面随价值锚整表下线） */}
            <SoulVersionChain teamId={activeTeamId ?? ''} agentId={agentId} />
          </>
        )}
      </div>
    </ResourcePage>
  );
}
