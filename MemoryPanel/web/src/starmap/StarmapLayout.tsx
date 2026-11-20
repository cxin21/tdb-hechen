/**
 * starmap/StarmapLayout.tsx — 单页星图外壳。
 *
 * 记忆星图是唯一的常驻背景；九块功能变成绕图的「星门」与右侧停靠面板，
 * 需要深读时才升起 .station-veil 抽屉（仍然是同一条 hash 路由，刷新/分享都不丢）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import FiveBodies, { CLOUD_COLOR as CLOUD_TINT, type AssetLegendItem, type CloudTotals } from './scene/FiveBodies';
import CloudSideCard from './scene/CloudSideCard';
import { Btn, Card2, Fields, Pill, Skeleton, agoText } from './theme/ui';
import { Dialog, Row } from './kit';
import { useStarmap } from './state/StarmapProvider';
import { useAuthStore } from '@/stores/auth';
import { useBackendStore } from '@/stores/backend';
import { writeActiveTeamId, isTeamAdmin } from '@/services';
import { teamsApi } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import { KIND_COLOR, type MapNode } from './engine/geometry';
import { LAYER_NAME as LAYER_ZH } from './scene/cloudPage';
import './theme/tokens.css';

interface StationDef {
  id: string;
  path: string;
  label: string;

  hint: string;
  angle: number;
}

const STATIONS: StationDef[] = [
  { id: 'memory', path: '/memory', label: '记忆', hint: '分层记忆 · 证据回指', angle: -90 },
  { id: 'soul', path: '/soul', label: '人格', hint: '人格卡 · 情绪 · 人物关系', angle: -30 },
  { id: 'wiki', path: '/wiki', label: '知识', hint: '文档库 · 编译状态', angle: 30 },
  { id: 'code', path: '/code', label: '代码', hint: '代码图谱 · 仓库索引', angle: 90 },
  { id: 'skills', path: '/skills', label: '技能', hint: '技能包 · 版本 · 文件', angle: 150 },
  { id: 'team', path: '/team/members', label: '团队', hint: '成员 · 智能体 · 密钥', angle: 210 },
];

/** 设置不是星门（不出现在左侧列表），但同样以抽屉形式打开，抬头与高亮要跟路径一致 */
const SETTINGS_SHEET = { id: 'settings', label: '设置' } as const;

/* 云名唯一口径：与 STATIONS、FiveBodies.CLOUD_LABEL 三处逐字一致。
   旧短名（忆云/典籍云/构筑云/技艺云）只在代码注释里作历史说法，不渲染。 */
const CLOUD_ZH: Record<'memory' | 'wiki' | 'code' | 'skills', string> = {
  memory: '记忆星云',
  wiki: '典籍星云',
  code: '构筑星云',
  skills: '技艺星云',
};

/* 左栏「星云构成」的顺序与画布扇区一致：记忆在上、三朵知识云顺环排开 */
const CLOUD_ORDER = ['memory', 'wiki', 'code', 'skills'] as const;

const KIND_LABEL: Record<MapNode['kind'], string> = {
  L0: LAYER_ZH.L0,
  L1: LAYER_ZH.L1,
  L2: LAYER_ZH.L2,
  L3: LAYER_ZH.L3,
  person: '人物',
  day: '日期',
};

export default function StarmapLayout() {
  return <LayoutInner />;
}

function LayoutInner() {
  const nav = useNavigate();
  const loc = useLocation();
  const sm = useStarmap();

  /* 嵌入的旧页（完整视图）读的是 useBackendStore.activeTeamId + localStorage，
     星图自成一套选中态；不同步会让 Wiki/Code/Members 打开就落在别的团队（实测显示 default-team、0 个库）。 */
  useEffect(() => {
    if (!sm.teamId) return;
    if (useBackendStore.getState().activeTeamId === sm.teamId) return;
    writeActiveTeamId(sm.teamId);
    useBackendStore.setState({ activeTeamId: sm.teamId });
  }, [sm.teamId]);
  const { auth, logout } = useAuthStore();


  const activeStation = useMemo(() => {
    const hit = STATIONS.find((s) => loc.pathname.startsWith(s.path) || loc.pathname === s.path);
    if (hit) return hit.id;
    if (loc.pathname.startsWith('/team')) return 'team';
    if (loc.pathname.startsWith('/settings')) return 'settings';
    return null;
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeStation) nav('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeStation, nav]);

  const onPickNode = (node: MapNode | null) => {
    sm.setSelected(node);
    sm.setFocusId(node?.id ?? null);
  };

  const selected = sm.selected;
  const stats = sm.graph.stats;
  const [search, setSearch] = useSearchParams();
  const rawCloud = search.get('cloud');
  const rawFocus = search.get('focus');
  const cloudKey = (rawCloud === 'memory' || rawCloud === 'wiki' || rawCloud === 'code' || rawCloud === 'skills' ? rawCloud : null) as
    | 'memory'
    | 'wiki'
    | 'code'
    | 'skills'
    | null;
  const focusKey = (rawFocus === 'memory' || rawFocus === 'wiki' || rawFocus === 'code' || rawFocus === 'skills' ? rawFocus : null) as
    | 'memory'
    | 'wiki'
    | 'code'
    | 'skills'
    | null;
  const [cloudNums, setCloudNums] = useState<{ total: number; lit: number } | null>(null);
  /* 画布真正画出来的四层数量：侧栏一律读这份，避免与画布/接口差三个数量级 */
  const [layerNums, setLayerNums] = useState<{ L3: number; L2: number; L1: number; L0: number; persons: number } | null>(null);
  const handleLayers = useCallback((n: { L3: number; L2: number; L1: number; L0: number; persons: number }) => setLayerNums(n), []);
  const [sceneNums, setSceneNums] = useState<{ links: number; stars: number; linksShown?: number } | null>(null);
  const handleScene = useCallback((n: { links: number; stars: number; linksShown?: number }) => setSceneNums(n), []);
  /* 画布建完场景后回报四朵云的计数：左栏「星云构成」用它，不另打一遍接口 */
  const [cloudTotals, setCloudTotals] = useState<CloudTotals | null>(null);
  const handleClouds = useCallback((n: CloudTotals) => setCloudTotals(n), []);
  /** 典籍云/构筑云里每个库的星点色（画布用 assetColor 算，这里只显示，不自己拍色） */
  const [assetLegend, setAssetLegend] = useState<AssetLegendItem[]>([]);
  const handleAssets = useCallback((n: AssetLegendItem[]) => setAssetLegend(n), []);
  const [teamDlg, setTeamDlg] = useState<null | 'create' | 'edit'>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamForm, setTeamForm] = useState({ name: '', description: '' });
  /* 星点卡由 FiveBodies 画，但挂进右侧栏的这个槽位，保证不与图例/详情卡叠在一起 */
  const [starSlot, setStarSlot] = useState<HTMLElement | null>(null);
  const [starCard, setStarCard] = useState(false);
  const onStarCard = useCallback((has: boolean) => setStarCard(has), []);
  const fullTeam = useBackendStore((st) => st.teams.find((t) => t.team_id === sm.teamId) ?? null);
  const meId = auth?.user_id ?? '';
  const canManageTeam = !!fullTeam && isTeamAdmin(fullTeam, meId);
  const openTeamDlg = (mode: 'create' | 'edit') => {
    setTeamForm({
      name: mode === 'edit' ? (fullTeam?.name ?? '') : '',
      description: mode === 'edit' ? (fullTeam?.description ?? '') : '',
    });
    setTeamDlg(mode);
  };
  const submitTeam = async () => {
    const name = teamForm.name.trim();
    if (!name || teamBusy) return;
    setTeamBusy(true);
    try {
      if (teamDlg === 'create') {
        const created = await teamsApi.create({ name, description: teamForm.description.trim() });
        writeActiveTeamId(created.team_id);
        useBackendStore.getState().invalidate();
      } else if (teamDlg === 'edit' && sm.teamId) {
        await teamsApi.update(sm.teamId, { name, description: teamForm.description.trim() });
        useBackendStore.getState().invalidate();
      }
      setTeamDlg(null);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setTeamBusy(false);
    }
  };
  const deleteTeam = async () => {
    if (!sm.teamId || !fullTeam || teamBusy) return;
    const ok = window.confirm('删除团队「' + fullTeam.name + '」？成员、智能体和该团队资产会一并删除，不能撤销。');
    if (!ok) return;
    setTeamBusy(true);
    try {
      await teamsApi.delete(sm.teamId);
      writeActiveTeamId(null);
      useBackendStore.getState().invalidate();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setTeamBusy(false);
    }
  };
  /* 回调必须是稳定引用：FiveBodies 的渲染 effect 依赖它们，内联箭头会让 effect 每帧重建 */
  /* 进入云 = 只看这一朵 + 侧卡，不打开旧页抽屉，也不嵌 ?full=1。 */
  const handleOpenCloud = useCallback((key: 'memory' | 'wiki' | 'code' | 'skills') => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev);
      next.set('cloud', key);
      next.set('entered', '1');
      next.delete('focus');
      next.delete('full');
      return next;
    }, { replace: true });
  }, [setSearch]);
  const handleOpenPersona = useCallback(() => nav('/soul'), [nav]);
  /* 聚焦写成 URL 参数，刷新/分享/浏览器后退都能回到同一朵云 */
  const handleFocusChange = useCallback(
    (f: { key: 'memory' | 'wiki' | 'code' | 'skills'; total: number; lit: number } | null) => {
      setCloudNums(f ? { total: f.total, lit: f.lit } : null);
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (f) next.set('focus', f.key);
          else {
            next.delete('focus');
            next.delete('cloud');
            next.delete('entered');
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );
  /* 从左栏「星云构成」点一行 → 只改 focus 参数；画布的聚焦相机由 focus prop 自己接管
     （onFocusChange 那条路是画布点击时回传计数用的，这里不必等它）。 */
  const focusCloud = useCallback(
    (key: 'memory' | 'wiki' | 'code' | 'skills') => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('focus', key);
          next.delete('cloud');
          next.delete('entered');
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );
  const memTotal =
    (layerNums?.L3 ?? stats.l3) + (layerNums?.L2 ?? (stats.l2 || stats.days)) + (layerNums?.L1 ?? stats.l1) + (layerNums?.L0 ?? 0);
  /* 画布点了云会回传计数；从左栏点进来时没有回传，用画布上报的总数兜底 */
  const focusNums = focusKey ? (cloudNums ?? cloudTotals?.[focusKey] ?? null) : null;
  const hasGraph = sm.graph.nodes.length > 0;

  /* 进云＝只看这一朵：星场铺满 + 浮层，总览的顶栏与左 HUD 全部让位。
     顶栏里的团队/智能体切换在云页由左栏筛选承担口径，不再叠两套 HUD。 */
  const inCloud = Boolean(sm.teamId && sm.activeAgentId && cloudKey && search.get('entered') === '1');

  /* 站台抽屉只放新壳自己的站页：能力齐了就不再往同页嵌旧页（?full=1 已删除）。
     旧控制台仍以真实路由 /legacy/* 存在，作为「对照与兜底」的显式出口，不是同页 iframe。 */

  if (inCloud && sm.teamId && sm.activeAgentId && cloudKey) {
    return (
      <div className="starmap-root">
        <CloudSideCard
          cloud={cloudKey}
          teamId={sm.teamId}
          agentId={sm.activeAgentId}
          blockId={sm.activeBlockId}
          memoryBlocks={sm.blocks}
          onExit={() => handleFocusChange(null)}
        />
      </div>
    );
  }

  return (
    <div className="starmap-root">
      <div className="st-bg">
        {sm.teamId && sm.activeAgentId && cloudKey && search.get('entered') === '1' ? (
          <CloudSideCard
            cloud={cloudKey}
            teamId={sm.teamId}
            agentId={sm.activeAgentId}
            blockId={sm.activeBlockId}
            memoryBlocks={sm.blocks}
            onExit={() => handleFocusChange(null)}
          />
        ) : sm.teamId && sm.activeAgentId ? (
          <FiveBodies
            teamId={sm.teamId}
            agentId={sm.activeAgentId}
            graph={sm.graph}
            onOpen={handleOpenCloud}
            onOpenPersona={handleOpenPersona}
            focus={focusKey}
            onFocusChange={handleFocusChange}
            onLayers={handleLayers}
            onScene={handleScene}
            onClouds={handleClouds}
            onAssets={handleAssets}
            slot={starSlot}
            onCard={onStarCard}
          />
        ) : (
          <div className="fb-status fb-status-empty">
            {sm.teamsLoading ? (
              '正在取团队…'
            ) : sm.teams.length === 0 ? (
              <>
                团队列表没有取到：接口失败或当前账号无可见团队。
                <button type="button" className="fb-refresh" onClick={() => window.location.reload()}>重试</button>
              </>
            ) : sm.agents.length === 0 ? (
              <>团队「{sm.teamName || sm.teamId}」下没有可见智能体。</>
            ) : (
              '先选团队与智能体，再展开星图。'
            )}
          </div>
        )}
      </div>

      {/* 顶栏 */}
      <header className="st-top">
        <div className="st-brand">
          <span className="st-brand-dot" aria-hidden="true" />
          <div className="st-brand-zh">记忆星图</div>
        </div>

        <div className="st-top-right">
          <SelectBox
            label="团队"
            value={sm.teamId ?? ''}
            options={sm.teams.map((t) => ({ value: t.team_id, text: t.name }))}
            onChange={(v) => sm.setTeamId(v)}
          />
          <Btn small ghost onClick={() => openTeamDlg('create')} title="新建团队">新建</Btn>
          {canManageTeam ? (
            <>
              <Btn small ghost onClick={() => openTeamDlg('edit')} disabled={teamBusy} title="编辑当前团队">编辑</Btn>
              <Btn small danger ghost onClick={() => void deleteTeam()} disabled={teamBusy} title="删除当前团队">删除</Btn>
            </>
          ) : null}
          <SelectBox
            label="智能体"
            value={sm.activeAgentId ?? ''}
            options={sm.agents.map((a) => ({ value: a.agent_id, text: a.name }))}
            onChange={(v) => sm.setActiveAgentId(v || null)}
          />
          {sm.teamId && !sm.agentsLoading && sm.agents.length === 0 ? (
            <Pill tone="warn">智能体列表未取到</Pill>
          ) : null}
          <SelectBox
            label="记忆块"
            value={sm.activeBlockId ?? ''}
            options={sm.blocks.map((b) => ({ value: b.id, text: b.title }))}
            onChange={(v) => sm.setActiveBlockId(v || null)}
          />
          <Btn small onClick={sm.refreshGraph} disabled={sm.graphLoading}>
            重算星图
          </Btn>
          <span className="st-user" title={auth ? auth.instance_name : ''}>
            {auth?.user || auth?.user_id || '未登录'}
          </span>
          <button
            type="button"
            className="stk-btn is-ghost is-sm"
            title="旧版控制台：真实路由，用于对照与兜底"
            onClick={() => nav('/legacy' + (loc.pathname === '/' ? '' : loc.pathname))}
          >
            旧控制台
          </button>
          <Btn small ghost onClick={() => void logout()}>
            登出
          </Btn>
        </div>
      </header>

      {/* 左 HUD */}
      <aside className="st-left">
        <Card2
          title="观测对象"
         
          live={!!sm.activeAgentId}
          right={<span className="sm-dim">{sm.activeBlock ? '已绑定' : '未绑定'}</span>}
        >
          <div className="st-obj">
            <div className="st-obj-name">
              {sm.agents.find((a) => a.agent_id === sm.activeAgentId)?.name ?? (sm.activeAgentId ? sm.activeAgentId : '未选择智能体')}
            </div>
            <div className="sm-dim2 sm-mono">{sm.activeAgentId ?? '—'}</div>
            <div className="sm-dim2">{sm.teamName || '未选择团队'}</div>
          </div>
          <div className="st-obj-block">
            <div className="sm-label">记忆块</div>
            <div className="st-obj-title">{sm.activeBlock?.title ?? '（无）'}</div>
            <div className="sm-dim2">
              {sm.activeBlock
                ? `对话原文 ${layerNums?.L0 ?? 0} · 原子记忆 ${layerNums?.L1 ?? sm.graph.stats.l1} · 场景记忆 ${layerNums?.L2 ?? sm.graph.stats.l2} · 核心记忆 ${layerNums?.L3 ?? sm.graph.stats.l3}`
                : '先选择团队与智能体'}
            </div>
          </div>
        </Card2>

        <Card2
          title="星云构成"
          right={
            focusKey ? (
              <button type="button" className="stk-btn is-ghost is-sm" onClick={() => handleFocusChange(null)}>
                全景
              </button>
            ) : (
              <span className="sm-dim2">点一行聚焦</span>
            )
          }
        >
          {sm.graphLoading ? (
            <Skeleton rows={4} height={12} />
          ) : (
            <>
              <div className="stk-list" data-testid="cloud-composition">
                {CLOUD_ORDER.map((key) => {
                  const t = cloudTotals?.[key];
                  const isMem = key === 'memory';
                  const total = isMem ? memTotal : (t?.total ?? 0);
                  const meta = isMem
                    ? memTotal > 0
                      ? memTotal.toLocaleString('zh-CN') + ' 条 · 4 层'
                      : '暂无'
                    : total > 0
                      ? (t?.lit ?? 0).toLocaleString('zh-CN') + ' / ' + total.toLocaleString('zh-CN')
                      : '暂无';
                  return (
                    <Row
                      key={key}
                      leading={<span className="st-cloud-dot" style={{ background: CLOUD_TINT[key].star }} />}
                      label={CLOUD_ZH[key]}
                      meta={meta}
                      title={isMem ? '记忆四层：L3 结论 → L0 原文' : '已点亮 / 团队可见总数'}
                      active={focusKey === key}
                      onClick={() => (focusKey === key ? handleFocusChange(null) : focusCloud(key))}
                    />
                  );
                })}
              </div>

              {/* 聚焦典籍云/构筑云时，把每个库的星点色摆出来：不列色例，多色就等于没意义 */}
              {focusKey && (focusKey === 'wiki' || focusKey === 'code') && assetLegend.length > 0 ? (
                <div className="stk-list st-asset-legend" data-testid="asset-legend">
                  {assetLegend
                    .filter((it) => it.cloud === focusKey)
                    .map((it) => (
                      <Row
                        key={it.key}
                        leading={<span className="st-cloud-dot" style={{ background: it.color }} />}
                        label={it.label}
                        meta={it.count > 0 ? it.count.toLocaleString('zh-CN') + (focusKey === 'code' ? ' 节点' : ' 页') : '空'}
                      />
                    ))}
                </div>
              ) : null}

              <div className="st-stat-foot">
                <span className="sm-dim2">
                  {sceneNums ? sceneNums.stars : '—'} 颗星 ·{' '}
                  {sceneNums
                    ? sceneNums.linksShown
                      ? '可见连线 ' + sceneNums.linksShown + ' / 共 ' + sceneNums.links + ' 条'
                      : '连线聚焦后出现 · 共 ' + sceneNums.links + ' 条'
                    : stats.links + ' 条线'}
                </span>
                <span className="sm-dim2">人物 {layerNums?.persons ?? stats.persons}</span>
                {stats.truncated ? <Pill tone="warn">已截断</Pill> : null}
              </div>
            </>
          )}
        </Card2>

        <Card2 title="星门">
          <div className="stk-list">
            {STATIONS.map((s) => (
              <Row
                key={s.id}
                label={s.label}
                meta={s.hint}
                active={activeStation === s.id}
                onClick={() => nav(s.path)}
              />
            ))}
            <Row label="设置" meta="实例 · 检索 · 模型" onClick={() => nav('/settings')} />
          </div>
        </Card2>
      </aside>

      {/* 右 HUD：只在全景用。进云后右栏归 CloudSideCard 自己画，
          否则两条 .st-right 都 fixed 在 right: var(--edge) 上会重叠。 */}
      {cloudKey ? null : (
      <aside className="st-right">
        {focusKey && !cloudKey ? (
          <Card2
            title={CLOUD_ZH[focusKey]}
           
            right={
              <button type="button" className="stk-btn is-ghost is-sm" onClick={() => handleFocusChange(null)}>
                退出
              </button>
            }
          >
            <Fields
              items={[
                {
                  k: '星点总数',
                  v:
                    focusKey === 'memory'
                      ? memTotal.toLocaleString('zh-CN')
                      : (focusNums?.total ?? 0) > 0
                        ? (focusNums?.total ?? 0).toLocaleString('zh-CN')
                        : '暂无',
                },
                {
                  k: focusKey === 'memory' ? '已展开层' : '已点亮',
                  v:
                    focusKey === 'memory'
                      ? 'L3 / L2 / L1 / L0'
                      : (focusNums?.total ?? 0) > 0
                        ? (focusNums?.lit ?? 0).toLocaleString('zh-CN') + ' / ' + (focusNums?.total ?? 0).toLocaleString('zh-CN')
                        : '—',
                },
              ]}
            />
            <div className="st-node-actions">
              <Btn small primary onClick={() => handleOpenCloud(focusKey)}>
                进入{CLOUD_ZH[focusKey]}
              </Btn>
            </div>
          </Card2>
        ) : null}
        <div ref={setStarSlot} className="st-slot" />
        {starCard ? null : <Card2
          title="星点详情"
         
          right={
            selected ? (
              <button type="button" className="stk-btn is-ghost is-sm" onClick={() => onPickNode(null)}>
                清除
              </button>
            ) : null
          }
        >
          {!selected ? (
            <div className="st-hint">
              <div className="st-hint-zh">点一颗星</div>
              <div className="sm-dim2">左侧星门切换功能，星点只显示真实存在的记忆/人物/日期。</div>
            </div>
          ) : (
            <div className="st-node">
              <div className="st-node-head">
                <span className="st-node-dot" style={{ background: KIND_COLOR[selected.kind] }} />
                <span className="st-node-kind">{KIND_LABEL[selected.kind]}</span>
                {selected.at ? <span className="sm-dim2">{agoText(selected.at)}</span> : null}
              </div>
              <div className="st-node-title">{selected.full || selected.label}</div>
              {selected.at ? <div className="sm-dim2 sm-mono">{selected.at}</div> : null}
              <Fields
                items={[
                  { k: '节点键', v: selected.id, mono: true },
                  { k: '显著性', v: selected.weight.toFixed(2) },
                ]}
              />
              <div className="st-node-actions">
                <Btn small primary onClick={() => nav('/memory')}>
                  在记忆里展开
                </Btn>
                <Btn small onClick={() => sm.setFocusId(selected.id)}>
                  聚焦邻居
                </Btn>
              </div>
            </div>
          )}
        </Card2>}

        <Card2 title="图例">
          <div className="st-legend">
            {(Object.keys(KIND_LABEL) as MapNode['kind'][]).map((k) => (
              <span key={k} className="st-legend-item">
                <i style={{ background: KIND_COLOR[k] }} />
                {KIND_LABEL[k]}
              </span>
            ))}
          </div>
          <div className="st-legend-lines">
            <span><i className="l-session" />同会话</span>
            <span><i className="l-person" />同人物</span>
            <span><i className="l-ref" />引用/归属</span>
          </div>
          <div className="sm-dim2 st-legend-tip">
            {hasGraph
              ? '拖拽旋转 · 滚轮缩放 · 空格暂停 · R 归位'
              : '该记忆块还没有可画的星，先积累 L1 记忆。'}
          </div>
        </Card2>
      </aside>
      )}

      {teamDlg ? (
        <div data-testid="team-dialog">
          <Dialog
            title={teamDlg === 'create' ? '新建团队' : '编辑团队'}
            description="团队是星图的边界：星点、资产与成员都挂在团队下。"
            width={420}
            onClose={() => { if (!teamBusy) setTeamDlg(null); }}
            footer={
              <>
                <button type="button" className="stk-btn is-ghost is-sm" disabled={teamBusy} onClick={() => setTeamDlg(null)}>取消</button>
                <button type="button" className="stk-btn is-sm" disabled={teamBusy || !teamForm.name.trim()} onClick={() => void submitTeam()}>
                  {teamBusy ? '保存中…' : '保存'}
                </button>
              </>
            }
          >
            <div className="stk-stack">
              <label className="stk-field-label">
                <span className="stk-kv-k">名称</span>
                <input className="st-input" value={teamForm.name} disabled={teamBusy} data-testid="team-name" onChange={(e) => setTeamForm((f) => ({ ...f, name: e.target.value }))} />
              </label>
              <label className="stk-field-label">
                <span className="stk-kv-k">说明</span>
                <input className="st-input" value={teamForm.description} disabled={teamBusy} data-testid="team-desc" onChange={(e) => setTeamForm((f) => ({ ...f, description: e.target.value }))} />
              </label>
            </div>
          </Dialog>
        </div>
      ) : null}

      {/* 站台抽屉 */}
      {activeStation ? (
        <div className="station-veil" onClick={() => nav('/')}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div className="sheet-head-title">
                <span className="sheet-head-zh">
                  {STATIONS.find((s) => s.id === activeStation)?.label ?? SETTINGS_SHEET.label}
                </span>
              </div>
              <div className="sheet-head-right">
                <button
                  type="button"
                  className="stk-btn is-ghost is-sm"
                  title="旧版控制台以真实路由存在，用于对照与兜底"
                  onClick={() => nav('/legacy' + (loc.pathname === '/' ? '' : loc.pathname))}
                >
                  旧控制台
                </button>
                <button type="button" className="stk-btn is-ghost is-sm" onClick={() => nav('/')}>
                  收起
                </button>
              </div>
            </div>
            <div className="sheet-body sm-scroll">
              <Outlet />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SelectBox({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; text: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="st-select">
      <span className="st-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.length === 0 ? <option value="">—</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}