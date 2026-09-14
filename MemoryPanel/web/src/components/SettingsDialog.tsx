/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * 当前只有一个 Tab：「权限管理」— 控制资源管理模块的开关
 * （Wiki / Code / Skill / Chat_Memory），防止未稳定使用的模块
 * 被注入内核运行。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Modal,
  Segment,
  Select,
  Switch,
  Tag,
  Text,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import {
  sessionInitApi,
  userConfigApi,
  type Agent,
  type AssetCapabilityKey,
  type SessionInitConfig,
  type Team,
} from '@/lib/teamApi';
import { teamsApi } from '@/lib/api/teams';
import { agentsApi } from '@/lib/api/agents';
import { getCurrentUser } from '@/lib/api/base';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  descKey: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'settings.module.wiki',
    descKey: 'settings.module.wiki.desc',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'settings.module.code',
    descKey: 'settings.module.code.desc',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'settings.module.skill',
    descKey: 'settings.module.skill.desc',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'settings.module.chatMemory',
    descKey: 'settings.module.chatMemory.desc',
    icon: <ChatIcon size={16} />,
  },
];

type SettingsTab = 'permissions' | 'sessionInit';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('permissions');

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <Modal
      visible
      size="m"
      onClose={onClose}
      caption={
        <Segment
          value={activeTab}
          onChange={(v) => setActiveTab(v as SettingsTab)}
          options={[
            { value: 'permissions', text: t('settings.tab.permissions') },
            { value: 'sessionInit', text: t('settings.tab.sessionInit') },
          ]}
        />
      }
    >
      <Modal.Body>
      {activeTab === 'permissions' && (
        <div>
          <div style={{ paddingTop: 4 }}>
            <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.title')}
            </Text>
            <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
              {t('settings.desc')}
            </Text>
            {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
            {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {RESOURCE_MODULES.map((mod) => (
                <div
                  key={mod.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    border: '1px solid var(--tea-color-border-primary-default)',
                    borderRadius: 6,
                    background: enabled[mod.id]
                      ? 'var(--tea-color-bg-brand-lighten-default)'
                      : 'var(--tea-color-bg-primary-default)',
                    transition: 'background-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                      {mod.icon}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: 500 }}>
                          {t(mod.labelKey)}
                        </Text>
                        {savingKey === mod.paramKey ? (
                          <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                        ) : enabled[mod.id] ? (
                          <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                        ) : (
                          <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                        )}
                      </div>
                      <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                        {t(mod.descKey)}
                      </Text>
                    </div>
                  </div>
                  <Switch
                    value={enabled[mod.id]}
                    disabled={loading || savingKey === mod.paramKey}
                    onChange={(v) => void handleToggle(mod, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sessionInit' && <SessionInitPanel />}
      </Modal.Body>
    </Modal>
  );
}

// ===== 会话初始化默认值 =====

function SessionInitPanel() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<SessionInitConfig | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, ts] = await Promise.all([sessionInitApi.get(), teamsApi.list()]);
      setCfg(c);
      setTeams(ts);
      // 首次按当前默认 team 拉 agents —— 只列当前用户所属的 agent（owner_user_id 过滤）
      if (c.default_team_id) {
        const me = await getCurrentUser();
        setAgents(await agentsApi.list(c.default_team_id, { owner_user_id: me.user_id }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(patch: Partial<SessionInitConfig>, clearAgentOnTeamChange = false) {
    const next = { ...cfg!, ...patch };
    if (clearAgentOnTeamChange) next.default_agent_id = '';
    setCfg(next);
    setSaving(true);
    setError('');
    try {
      const params: Record<string, string> = {
        manual_select: next.manual_select ? '1' : '0',
        default_associate: next.default_associate ? '1' : '0',
        default_team_id: next.default_team_id,
        default_agent_id: next.default_agent_id,
      };
      await sessionInitApi.set(params);
      tea.notify.success(t('settings.sessionInit.saved'));
      if (clearAgentOnTeamChange && next.default_team_id) {
        const me = await getCurrentUser();
        setAgents(await agentsApi.list(next.default_team_id, { owner_user_id: me.user_id }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSaving(false);
    }
  }

  const teamOptions = [{ value: '', text: t('settings.sessionInit.noTeam'), disabled: false }].concat(
    teams.map((th) => ({ value: th.team_id, text: th.name, disabled: false })),
  );
  const agentOptions = [{ value: '', text: t('settings.sessionInit.noAgent'), disabled: false }].concat(
    agents.map((a) => ({ value: a.agent_id, text: a.name, disabled: false })),
  );

  return (
    <div style={{ paddingTop: 4 }}>
      <Text theme="label" style={{ display: 'block', marginBottom: 4 }}>{t('settings.sessionInit.title')}</Text>
      <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>{t('settings.sessionInit.desc')}</Text>
      {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
      {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 滑块：是否需要手动选择 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--tea-color-border-primary-default)', borderRadius: 6 }}>
          <div>
            <Text style={{ fontSize: 13, fontWeight: 500 }}>{t('settings.sessionInit.manualSelectLabel')}</Text>
            <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>{t('settings.sessionInit.manualSelectDesc')}</Text>
          </div>
          <Switch value={!!cfg?.manual_select} disabled={loading || saving || !cfg} onChange={(v) => void save({ manual_select: v })} />
        </div>

        {/* 滑块：默认是否关联团队资产 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--tea-color-border-primary-default)', borderRadius: 6 }}>
          <div>
            <Text style={{ fontSize: 13, fontWeight: 500 }}>{t('settings.sessionInit.associateLabel')}</Text>
            <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>{t('settings.sessionInit.associateDesc')}</Text>
          </div>
          <Switch value={!!cfg?.default_associate} disabled={loading || saving || !cfg} onChange={(v) => void save({ default_associate: v })} />
        </div>

        {/* 下拉：默认团队 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px' }}>
          <Text style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{t('settings.sessionInit.teamLabel')}</Text>
          <Select
            size="m"
            value={cfg?.default_team_id ?? ''}
            options={teamOptions}
            disabled={loading || saving || !cfg}
            onChange={(v: string) => void save({ default_team_id: v }, true)}
          />
        </div>

        {/* 下拉：默认 Agent（含未指定空选项） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px' }}>
          <Text style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{t('settings.sessionInit.agentLabel')}</Text>
          <Select
            size="m"
            value={cfg?.default_agent_id ?? ''}
            options={agentOptions}
            disabled={loading || saving || !cfg || !cfg.default_team_id}
            onChange={(v: string) => void save({ default_agent_id: v })}
          />
        </div>
      </div>
    </div>
  );
}
