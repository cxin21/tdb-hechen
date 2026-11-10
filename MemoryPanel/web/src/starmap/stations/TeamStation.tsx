/**
 * starmap/stations/TeamStation.tsx — 团队站（新壳）。
 *
 * 成员 / 智能体 / 密钥三块仍由既有的 TeamManagementPanel 与 ApiKeyPanel 承担写入，
 * 它们本来就不带旧 ConsoleLayout 的壳，直接嵌进星图抽屉里读起来是连贯的。
 */
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Seg } from '../theme/ui';
import { useStarmap } from '../state/StarmapProvider';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole } from '@/services/useCurrentRole';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';
import { ApiKeysPage } from '@/pages/ApiKeysPage';

type Section = 'members' | 'agents' | 'keys';

export default function TeamStation() {
  const sm = useStarmap();
  const auth = useAuthStore((s) => s.auth);
  const role = useCurrentRole();
  const loc = useLocation();
  const nav = useNavigate();
  const section: Section = useMemo(() => {
    if (loc.pathname.endsWith('/api-keys')) return 'keys';
    if (loc.pathname.endsWith('/agents')) return 'agents';
    return 'members';
  }, [loc.pathname]);
  const setSection = (next: Section) => {
    nav(next === 'keys' ? '/team/api-keys' : next === 'agents' ? '/team/agents' : '/team/members');
  };

  if (!auth) {
    return <div className="st-empty">未登录</div>;
  }

  return (
    <div className="st-body st-body-single">
      <div className="st-main">
        <div className="st-toolbar">
          <div className="st-toolbar-left sm-dim2">{sm.teamName || '当前团队'}</div>
          <Seg<Section>
            value={section}
            onChange={setSection}
            options={[
              { value: 'members', label: '成员' },
              { value: 'agents', label: '智能体' },
              { value: 'keys', label: '密钥' },
            ]}
          />
        </div>
        <div className="st-embed sm-scroll">
          {section === 'keys' ? (
            <ApiKeysPage />
          ) : (
            <TeamManagementPanel
              currentUser={auth.user_id}
              instanceId={auth.instance_id}
              isAdmin={role === 'admin'}
              section={section}
            />
          )}
        </div>
      </div>
    </div>
  );
}
