/**
 * starmap/stations/TeamStation.tsx — 团队站（新壳原生实现）。
 *
 * 覆盖三块可做的事，全部走 kit 组件与真实接口：
 *   成员   team-member/list · add · remove（后端没有改角色端点，UI 不造假切换）
 *   智能体 agent/list · create · update · archive（删除前先删该 agent 名下 active skill，
 *          由 agentsApi.delete 内部完成，失败会原样抛出 SKILL_DELETE_FAILED）
 *   密钥   user-key/list · create · revoke（明文 key_value 只在创建响应出现一次）
 *
 * 权限：成员增删仅 team admin；智能体写操作＝admin 或该 agent 的 owner；密钥恒为「当前登录
 * 用户自己的」，不看团队角色。
 *
 * 未搬进来的深操作（如实说明，不在这里做半成品）：
 *   - 智能体资产分配（记忆块 / wiki / codegraph / skill 挂载）
 *   - 人格草稿编辑、导入历史对话
 *   - 团队级新建 / 重命名 / 删除（入口在顶栏 TeamSwitcher 下拉框）
 * 这些仍走「旧控制台」，站内给明确入口。
 */
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Empty, KvList, Note, Row, Seg, Surface, Tag } from '../kit';
import { useStarmap } from '../state/StarmapProvider';
import { useResource } from '../cache';
import { cacheKey } from '../cache';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole } from '@/services/useCurrentRole';
import { membersApi, agentsApi, userKeysApi, type TeamMember, type Agent, type UserKey } from '@/lib/teamApi';
import { getErrorMessage } from '@/lib/error-message';

type Section = 'members' | 'agents' | 'keys';

const ROLE_LABEL: Record<TeamMember['role'], string> = {
  admin: '管理员',
  member: '成员',
  reviewer: '评审员',
};

const VISIBILITY_OPTIONS = [
  { value: 'team', label: '团队可见' },
  { value: 'private', label: '仅自己' },
  { value: 'agent', label: '智能体级' },
];

function errText(e: unknown): string {
  return getErrorMessage(e);
}

/** 本次刚创建的明文密钥：只在这里活到用户点「我已复制」。 */
function NewKeyNote({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  return (
    <Surface dense title="新密钥（只显示这一次）">
      <Note tone="warn">
        关闭或离开本页后无法再次查看。复制后自行保存，服务端只留前缀。
      </Note>
      <pre className="stk-pre" data-testid="new-key-value">{value}</pre>
      <div className="stk-row-actions">
        <button type="button" className="stk-btn is-ghost is-sm" onClick={onDismiss}>
          我已复制，收起
        </button>
      </div>
    </Surface>
  );
}

// ============================== 成员 ==============================

function MembersSection({ teamId, isAdmin, meId }: { teamId: string; isAdmin: boolean; meId: string }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const res = useResource<TeamMember[]>({
    key: cacheKey('teams.members', teamId),
    fetcher: () => membersApi.list(teamId),
    ttl: 60_000,
    tags: ['teams:members:' + teamId],
  });
  const rows = res.data ?? [];

  const add = async () => {
    const id = userId.trim();
    if (!id) {
      setErr('请填 user_id。成员按已知 user_id 加入，没有按用户名建户的等价接口。');
      return;
    }
    setBusy('add');
    setErr(null);
    try {
      await membersApi.add(teamId, { user_id: id, role });
      setUserId('');
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (uid: string) => {
    setBusy(uid);
    setErr(null);
    try {
      await membersApi.remove(teamId, uid);
      setConfirmRemove(null);
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Surface
        dense
        title="成员"
        aside={<span className="stk-meta">共 {rows.length} 人</span>}
      >
        {res.loading && !rows.length ? <Note>正在读取成员…</Note> : null}
        {res.error ? <Note tone="bad">成员未读取成功：{errText(res.error)}</Note> : null}
        {res.stale && !res.error ? <Note tone="warn">显示的是上次同步的数据，本次刷新未成功。</Note> : null}
        {!res.loading && !rows.length && !res.error ? <Empty title="这个团队还没有成员" /> : null}
        <div className="stk-list">
          {rows.map((m) => (
            <Row
              key={m.user_id}
              label={m.username || m.user_id}
              meta={m.status === 'removed' ? '已移除' : '加入于 ' + m.joined_at.slice(0, 10)}
              trailing={
                <span className="stk-row-tools">
                  <Tag tone={m.role === 'admin' ? 'ink' : undefined}>{ROLE_LABEL[m.role] ?? m.role}</Tag>
                  {isAdmin && m.user_id !== meId ? (
                    confirmRemove === m.user_id ? (
                      <button
                        type="button"
                        className="stk-btn is-danger is-sm"
                        disabled={busy === m.user_id}
                        onClick={() => void remove(m.user_id)}
                      >
                        确认移除
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="stk-btn is-ghost is-sm"
                        onClick={() => setConfirmRemove(m.user_id)}
                      >
                        移除
                      </button>
                    )
                  ) : null}
                </span>
              }
            />
          ))}
        </div>
        {res.updatedAt ? (
          <p className="stk-hint-inline">上次同步 {new Date(res.updatedAt).toLocaleTimeString('zh-CN')}</p>
        ) : null}
      </Surface>

      {isAdmin ? (
        <Surface dense title="添加成员">
          <Note>
            需要对方的 user_id（对方用自己的 user_key 登录后可从账号信息里看到）。后端没有「按用户名开号」的接口，
            这里也不做假的用户搜索。
          </Note>
          <div className="stk-row-actions">
            <input
              className="st-input"
              placeholder="user_id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <Seg<TeamMember['role']>
              value={role}
              onChange={setRole}
              size="sm"
              options={[
                { value: 'member', label: '成员' },
                { value: 'reviewer', label: '评审员' },
                { value: 'admin', label: '管理员' },
              ]}
            />
            <button type="button" className="stk-btn" disabled={busy === 'add'} onClick={() => void add()}>
              {busy === 'add' ? '添加中…' : '添加'}
            </button>
          </div>
          {err ? <Note tone="bad">{err}</Note> : null}
          <p className="stk-hint-inline">后端当前没有改角色的端点：角色只能在加入时定，改角色需要移除后重新加入。</p>
        </Surface>
      ) : (
        <Note>只有团队管理员能添加或移除成员。你可以查看成员名单。</Note>
      )}
    </>
  );
}

// ============================== 智能体 ==============================

function AgentsSection({
  teamId,
  isAdmin,
  meId,
  onOpenLegacy,
}: {
  teamId: string;
  isAdmin: boolean;
  meId: string;
  onOpenLegacy: (path: string) => void;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [visibility, setVisibility] = useState<string>('team');
  const [editing, setEditing] = useState<Agent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const res = useResource<Agent[]>({
    key: cacheKey('agents.list', teamId),
    fetcher: () => agentsApi.list(teamId),
    ttl: 60_000,
    tags: ['agents:list:' + teamId],
  });
  const rows = res.data ?? [];

  const create = async () => {
    const n = name.trim();
    if (!n) {
      setErr('智能体名不能为空。');
      return;
    }
    setBusy('create');
    setErr(null);
    try {
      await agentsApi.create(teamId, { name: n, description: desc.trim() || undefined, visibility });
      setName('');
      setDesc('');
      setVisibility('team');
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setErr('智能体名不能为空。');
      return;
    }
    setBusy(editing.agent_id);
    setErr(null);
    try {
      await agentsApi.update(editing.agent_id, {
        name: editing.name.trim(),
        description: editing.description?.trim() ?? '',
        visibility: editing.visibility,
      });
      setEditing(null);
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (agentId: string) => {
    setBusy(agentId);
    setErr(null);
    try {
      await agentsApi.delete(agentId, teamId);
      setConfirmDelete(null);
      if (editing?.agent_id === agentId) setEditing(null);
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const canWrite = (a: Agent) => isAdmin || a.owner_user_id === meId;

  return (
    <>
      <Surface dense title="智能体" aside={<span className="stk-meta">共 {rows.length} 个</span>}>
        {res.loading && !rows.length ? <Note>正在读取智能体…</Note> : null}
        {res.error ? <Note tone="bad">智能体未读取成功：{errText(res.error)}</Note> : null}
        {res.stale && !res.error ? <Note tone="warn">显示的是上次同步的数据，本次刷新未成功。</Note> : null}
        {!res.loading && !rows.length && !res.error ? <Empty title="这个团队还没有智能体" /> : null}
        <div className="stk-list">
          {rows.map((a) => (
            <Row
              key={a.agent_id}
              label={a.name}
              meta={a.agent_id}
              active={editing?.agent_id === a.agent_id}
              trailing={
                <span className="stk-row-tools">
                  <Tag>{a.visibility === 'private' ? '仅自己' : a.visibility === 'team' ? '团队可见' : a.visibility}</Tag>
                  <Tag tone={a.status === 'active' ? 'ink' : undefined}>{a.status === 'active' ? '启用' : '停用'}</Tag>
                  {canWrite(a) ? (
                    <button
                      type="button"
                      className="stk-btn is-ghost is-sm"
                      onClick={() => setEditing(a)}
                    >
                      编辑
                    </button>
                  ) : null}
                  {confirmDelete === a.agent_id ? (
                    <button
                      type="button"
                      className="stk-btn is-danger is-sm"
                      disabled={busy === a.agent_id}
                      onClick={() => void remove(a.agent_id)}
                    >
                      确认删除
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="stk-btn is-ghost is-sm"
                      onClick={() => setConfirmDelete(a.agent_id)}
                    >
                      删除
                    </button>
                  )}
                </span>
              }
            />
          ))}
        </div>
      </Surface>

      {editing ? (
        <Surface dense title={'编辑智能体 · ' + editing.name}>
          <div className="stk-stack">
            <label className="stk-field-label">
              名称
              <input
                className="st-input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="stk-field-label">
              描述
              <textarea
                className="stk-textarea"
                value={editing.description ?? ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <div className="stk-field-label">
              可见性
              <Seg<string>
                value={editing.visibility}
                onChange={(v) => setEditing({ ...editing, visibility: v as Agent['visibility'] })}
                size="sm"
                options={VISIBILITY_OPTIONS}
              />
            </div>
            <KvList
              items={[
                { k: 'agent', v: editing.agent_id, mono: true },
                { k: '归属', v: editing.owner_user_id === meId ? '我' : editing.owner_user_id, mono: true },
                { k: '创建', v: editing.created_at.slice(0, 19).replace('T', ' ') },
              ]}
            />
          </div>
          <div className="stk-row-actions">
            <button type="button" className="stk-btn" disabled={busy === editing.agent_id} onClick={() => void save()}>
              {busy === editing.agent_id ? '保存中…' : '保存'}
            </button>
            <button type="button" className="stk-btn is-ghost" onClick={() => setEditing(null)}>
              取消
            </button>
            <button
              type="button"
              className="stk-btn is-ghost is-sm"
              onClick={() => onOpenLegacy('/team/agents')}
            >
              资产分配 / 人格草稿 → 旧控制台
            </button>
          </div>
          {err ? <Note tone="bad">{err}</Note> : null}
          <p className="stk-hint-inline">
            删除会先逐个删除该智能体名下的启用中技能，任一技能删除失败则整体中止、智能体不会被归档。
          </p>
        </Surface>
      ) : (
        <Surface dense title="新建智能体">
          <Note>归属人固定为当前登录用户（后端在创建时写入，暂不支持转交）。</Note>
          <div className="stk-stack">
            <label className="stk-field-label">
              名称
              <input className="st-input" placeholder="例如 供应链助手" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="stk-field-label">
              描述
              <textarea
                className="stk-textarea"
                placeholder="这个智能体负责什么"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
              />
            </label>
            <div className="stk-field-label">
              可见性
              <Seg<string> value={visibility} onChange={setVisibility} size="sm" options={VISIBILITY_OPTIONS} />
            </div>
          </div>
          <div className="stk-row-actions">
            <button type="button" className="stk-btn" disabled={busy === 'create'} onClick={() => void create()}>
              {busy === 'create' ? '创建中…' : '新建'}
            </button>
          </div>
          {err ? <Note tone="bad">{err}</Note> : null}
        </Surface>
      )}
    </>
  );
}

// ============================== 密钥 ==============================

function KeysSection() {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const res = useResource<UserKey[]>({
    key: cacheKey('keys.list', 'me'),
    fetcher: () => userKeysApi.list(),
    ttl: 60_000,
    tags: ['keys:self'],
  });
  const rows = res.data ?? [];

  const create = async () => {
    setBusy('create');
    setErr(null);
    try {
      const key = await userKeysApi.create({ name: name.trim() || undefined });
      setName('');
      setCreated(key.key_value ?? null);
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (keyId: string) => {
    setBusy(keyId);
    setErr(null);
    try {
      await userKeysApi.revoke(keyId);
      setConfirmRevoke(null);
      res.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {created ? <NewKeyNote value={created} onDismiss={() => setCreated(null)} /> : null}
      <Surface dense title="我的密钥" aside={<span className="stk-meta">共 {rows.length} 把</span>}>
        <Note>密钥属于当前登录用户，不分团队；列表里只回前缀，明文只在创建时出现一次。</Note>
        {res.loading && !rows.length ? <Note>正在读取密钥…</Note> : null}
        {res.error ? <Note tone="bad">密钥未读取成功：{errText(res.error)}</Note> : null}
        {res.stale && !res.error ? <Note tone="warn">显示的是上次同步的数据，本次刷新未成功。</Note> : null}
        {!res.loading && !rows.length && !res.error ? <Empty title="还没有密钥" /> : null}
        <div className="stk-list">
          {rows.map((k) => {
            const revoked = Boolean(k.revoked_at);
            return (
              <Row
                key={k.key_id}
                label={k.name || k.key_prefix || k.key_id}
                meta={[
                  k.key_prefix,
                  k.created_at ? '建于 ' + k.created_at.slice(0, 10) : '',
                  k.last_used_at ? '最后使用 ' + k.last_used_at.slice(0, 10) : '未使用',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <span className="stk-row-tools">
                    <Tag tone={revoked ? undefined : 'ink'}>{revoked ? '已吊销' : '有效'}</Tag>
                    {revoked ? null : confirmRevoke === k.key_id ? (
                      <button
                        type="button"
                        className="stk-btn is-danger is-sm"
                        disabled={busy === k.key_id}
                        onClick={() => void revoke(k.key_id)}
                      >
                        确认吊销
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="stk-btn is-ghost is-sm"
                        onClick={() => setConfirmRevoke(k.key_id)}
                      >
                        吊销
                      </button>
                    )}
                  </span>
                }
              />
            );
          })}
        </div>
      </Surface>

      <Surface dense title="新建密钥">
        <div className="stk-row-actions">
          <input
            className="st-input"
            placeholder="用途备注（可选），例如 dsh-plugin"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="stk-btn" disabled={busy === 'create'} onClick={() => void create()}>
            {busy === 'create' ? '创建中…' : '创建'}
          </button>
        </div>
        {err ? <Note tone="bad">{err}</Note> : null}
        <p className="stk-hint-inline">吊销立即生效且不可撤销；创建时没过期时间的密钥长期有效，请自行保管。</p>
      </Surface>
    </>
  );
}

// ============================== 站 ==============================

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
    return (
      <div className="starmap-root">
        <div className="st-body st-body-single">
          <div className="st-main">
            <Empty title="未登录" hint="团队、成员与密钥都需要登录后才能读写。" />
          </div>
        </div>
      </div>
    );
  }

  const teamId = sm.teamId;
  const isAdmin = role === 'admin';

  return (
    <div className="starmap-root">
      <div className="st-body st-body-single">
        <div className="st-main">
          <div className="st-toolbar">
            <div className="st-toolbar-left sm-dim2">
              {sm.teamName || '当前团队'}
              {teamId ? <span className="stk-meta"> · {teamId}</span> : null}
            </div>
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
          <div className="sm-scroll">
            {!teamId ? (
              <Note tone="warn">还没有选中团队。用顶栏的团队切换器选一个团队，再回到这里管理成员与智能体。</Note>
            ) : section === 'members' ? (
              <MembersSection teamId={teamId} isAdmin={isAdmin} meId={auth.user_id} />
            ) : section === 'agents' ? (
              <AgentsSection
                teamId={teamId}
                isAdmin={isAdmin}
                meId={auth.user_id}
                onOpenLegacy={(path) => nav('/legacy' + path)}
              />
            ) : (
              <KeysSection />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}